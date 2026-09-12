# 04 — Routing engine and leg-splitting

Back to [`PLAN.md`](../PLAN.md)

This is where the product's real intellectual property lives. Anyone can list trains
between two stations; almost nothing decomposes a waitlisted journey into bookable legs,
bridges the gaps by road or air, and turns a forced transfer into a destination.

---

## 1. Algorithm selection

### Candidates

| Algorithm | Query cost | Preprocessing | Multi-criteria | Delay handling | Verdict |
|---|---|---|---|---|---|
| Time-expanded Dijkstra | O(E log V), large E | none | awkward | easy | Too slow for repeated interactive queries |
| **CSA** (Connection Scan) | **O(&#124;C&#124;)**, single linear scan | sort connections once | **native Pareto variant** | **trivial array mutation** | ✅ **Chosen** |
| RAPTOR | O(rounds × &#124;C&#124;) | route/stop indexing | native | moderate | Comparable; round-based, less cache-friendly |
| Transfer Patterns | O(1)-ish lookup | **very heavy** | limited | hard to update | Preprocessing too costly for CI-only builds |
| Trip-Based Routing | fastest queries | heavy server-side preprocessing | limited | moderate | Needs a preprocessing server; we have none |

### Why CSA wins here

CSA (Dibbelt, Nierhoff, Strasser & Wagner) organises the timetable as **one array of
connections sorted by departure time** and scans it once per query.

- **O(&#124;C&#124;)** with a tiny constant, and the access pattern is strictly sequential →
  excellent cache behaviour. `trRouting` (C++) reports **~8 ms** for a two-way CSA over all
  Montreal transit; a JS worker over the larger Indian network should land at ~50–200 ms
  for a full-network sweep, which is acceptable behind a progress indicator.
- **Profile queries are native** — "all Pareto-optimal journeys for departures between
  18:00 and 23:00" is the same scan run backwards. That is exactly the "show me options"
  UX.
- **Delays are trivially absorbed** by mutating departure/arrival values in the array. No
  re-preprocessing. Documented as one of CSA's key advantages, and essential given our
  Tier-2 live data.
- **The Pareto extension is well-described** in the original papers (optimising arrival
  time and transfer count jointly), and extends to our availability criterion.
- **Discovery mode falls out for free**: the scan computes earliest arrival at *every*
  station simultaneously, so a reverse reachability sweep costs the same as one query.
- **~300 lines of TypeScript.** No dependency, fully auditable.

Prior art worth reading before implementing: **MOTIS** (open-source intermodal routing
engine — the closest existing system to what we're building, and a good source of
modelling ideas even though it needs a server), **trRouting** (C++ CSA reference),
**OpenTripPlanner** (RAPTOR-based), **Transitous** (open GTFS corpus).

---

## 2. Core data structures

```ts
// ── Connections: the hot array. Structure-of-arrays, sorted ascending by depTs. ──
interface ConnectionArrays {
  depTs:      Int32Array;   // minutes since timetable epoch (linear time axis)
  arrTs:      Int32Array;
  trainIx:    Uint16Array;  // index into train table
  fromStn:    Uint16Array;  // station index
  toStn:      Uint16Array;
  distKm:     Uint16Array;
  dayOff:     Uint8Array;   // day offset within the train's run
  classMask:  Uint16Array;  // bitmask of classes available on this segment
}
// ~290,000 connections × 19 bytes ≈ 5.5 MB raw, ~1.8 MB brotli

// ── Per-station indices ──
interface StationIndex {
  firstDeparture: Int32Array;  // for each station: index of its first outgoing connection
  outDegree:      Uint32Array; // ...and how many (connections grouped by fromStn)
  inbound:        Int32Array[];// for footpath/transfer resolution
  terminalGroup:  Uint16Array; // city terminal group id (0 = not part of a group)
  minTransferMin: Uint8Array;  // station-specific minimum transfer time
  rank:           Uint8Array;  // metro / junction / intermediate / halt
}

// ── Footpaths: walkable/roadable station↔station transfers ──
interface Footpath {
  from: number; to: number;
  minutes: number;      // realistic transfer time, NOT straight-line/optimal
  mode: 'walk' | 'metro' | 'taxi' | 'bus';
  costRupees: number;
  crossesTerminal: boolean;
}
```

**Why SoA:** CSA scans `depTs`/`arrTs` linearly. Separate arrays give sequential memory
access; an array-of-structs would thrash the cache every step. This is the single biggest
performance lever after the algorithm itself.

**Why minutes-since-epoch:** an Int32 minute counter covers ~4,000 years and puts the whole
timetable on one linear axis — exactly what CSA requires. `dayOff` folds multi-day runs in.

---

## 3. Base CSA (single criterion: earliest arrival)

```ts
function csaEarliestArrival(
  C: ConnectionArrays, departs: Set<StationIdx>, departureTime: Minute,
  target: StationIdx, transfers: FootpathIndex, maxTransfers: number
): Journey | null {
  const journeyArrival = new Int32Array(numStations).fill(INF);
  const transferArrival = new Int32Array(numStations).fill(INF);
  const prevConn       = new Int32Array(numConnections).fill(-1);
  const mark           = new Uint8Array(numStations);           // "marked" stations
  const transferCount  = new Uint8Array(numStations);

  for (const s of departs) {
    transferArrival[s] = departureTime;
    mark[s] = 1;                                                 // origin is marked
  }

  // Single forward scan over connections sorted by departure time
  for (let c = firstConnectionAtOrAfter(C, departureTime); c < C.depTs.length; c++) {
    const from = C.fromStn[c], to = C.toStn[c];

    // Can we board? Either the origin is marked, or we arrived in time to transfer.
    const canBoard =
      mark[from] === 1 ||
      (transferArrival[from] + transfers.minTransferTime(from, C.trainIx[c])) <= C.depTs[c];

    if (!canBoard) continue;
    if (transferCount[from] > maxTransfers) continue;
    if (!trainRunsOnDate(C.trainIx[c], dateOf(C.depTs[c]))) continue;   // runs_days check
    if (isCancelledOrDivertedAway(C.trainIx[c], dateOf(C.depTs[c]))) continue;

    if (C.arrTs[c] < transferArrival[to]) {
      transferArrival[to] = C.arrTs[c];
      journeyArrival[to]  = C.arrTs[c];
      prevConn[c]         = findPrevConnection(c, from, transferArrival, prevConn);
      mark[to] = 1;
      transferCount[to] = transferCount[from] + (prevConn[c] === -1 ? 0 : 1);

      // Propagate through footpaths (cross-terminal transfers, nearby stations)
      for (const fp of transfers.outgoing(to)) {
        const arr = C.arrTs[c] + fp.minutes;
        if (arr < transferArrival[fp.to]) {
          transferArrival[fp.to] = arr;
          mark[fp.to] = 1;
          transferCount[fp.to] = transferCount[to];
        }
      }
      if (to === target) { /* can early-exit for single-target queries */ }
    }
  }
  return reconstruct(prevConn, journeyArrival, target);
}
```

Key points:

- **`mark`** implements CSA's "marked station" trick: a station is marked when it is an
  origin or when it was reached by a footpath/transfer, meaning *any* train departing it
  can be boarded without a time check. This is what makes footpath transfers correct and
  cheap.
- **`runs_days` gating is inside the scan**, not a post-filter. A weekly train on a
  non-operating day must not exist. This is the bug the 2016 datasets guarantee.
- **Cancellation/diversion gating is inside the scan** too, driven by `live.json`.
- **Early exit** when the target's arrival can no longer improve — important for
  single-destination queries.

---

## 4. Multi-criteria Pareto CSA

"Best" is not one number. Each station holds a **frontier** of labels; a label is discarded
only if another dominates it on **every** criterion.

```ts
interface Label {
  arrival:      Minute;   // minimise
  transfers:    number;   // minimise
  fare:         number;   // minimise
  worstConf:    number;   // MAXIMISE  ← availability is a routing criterion
  nightLegs:    number;   // minimise
  fatigue:      number;   // minimise  (hours seated, berth changes, early departures)
  // provenance for reconstruction
  prevConn:     number;
  prevLabel:    number;
}

function dominates(a: Label, b: Label): boolean {
  return a.arrival   <= b.arrival   && a.transfers <= b.transfers &&
         a.fare      <= b.fare      && a.worstConf >= b.worstConf &&
         a.nightLegs <= b.nightLegs && a.fatigue   <= b.fatigue   &&
         (a.arrival < b.arrival || a.transfers < b.transfers || a.fare < b.fare ||
          a.worstConf > b.worstConf || a.nightLegs < b.nightLegs || a.fatigue < b.fatigue);
}
```

Frontier per station is **capped (~12 entries)** with an eviction policy that drops the
label closest to being dominated. Without a cap, six criteria over 8,000 stations blow up
memory. The cap is a tuning knob validated against the golden journey corpus.

**`worstConf` (worst-leg availability confidence) is the crucial addition.** It means the
engine routes *around* waitlisted segments rather than finding the fastest journey and then
apologising for it. A journey with 2 transfers and 94% confidence can dominate a direct
journey at 38%.

The **top-K non-dominated labels at the destination are the results list** — no separate
K-shortest-paths pass needed. **Yen's algorithm** is kept available for a different job:
enumerating alternatives through a *forced waypoint*, which powers the stopover feature
("show me journeys that pass through Ratnagiri and let me stay there").

---

## 5. Origin and destination expansion

A naive `origin → destination` query is wrong for Indian cities before the algorithm even
runs. Expand both endpoints into weighted sets.

### Terminal groups

```jsonc
// terminals.json
{
  "DELHI":    { "stations": ["NDLS","NZM","DLI","ANVT","DEE","NNO","SZM"],
                "hub": "NDLS", "interTerminalMinutes": 45 },
  "MUMBAI":   { "stations": ["CSTM","BCT","LTT","DR","BDTS","KYN","PNVL","TNA"],
                "hub": "CSTM", "interTerminalMinutes": 60 },
  "KOLKATA":  { "stations": ["HWH","SDAH","KOAA","SHM"], "interTerminalMinutes": 40 },
  "CHENNAI":  { "stations": ["MAS","MSB","TBM","MS"], "interTerminalMinutes": 35 },
  "BENGALURU":{ "stations": ["SBC","YPR","BAND","SMVB","KSR","WFD"], "interTerminalMinutes": 45 },
  "HYDERABAD":{ "stations": ["SC","KCG","HYB","BMO"], "interTerminalMinutes": 40 },
  "SECUNDERABAD": { "alias": "HYDERABAD" },
  "GOA":      { "stations": ["MAO","VSG","THVM","KUDL","MDVL"], "interTerminalMinutes": 90 }
}
```

Note Mumbai's spread: Kalyan, Panvel and Thane are ~60–90 min from the island-city
terminals. Cross-terminal transfers get a **road footpath edge with a realistic (not
optimistic) duration and a rupee cost**, so a "transfer" that is really a 90-minute taxi
ride is priced as one and won't be chosen lightly.

### Radius-based nearby-station expansion

Using bundled station coordinates, include stations within N km of the requested point
(default N = 25 urban, 60 rural), each with an access edge whose cost is a road-time
estimate. This is what makes "I'm in Goa" resolve to MAO/VSG/THVM rather than failing.

### Fuzzy origin resolution

Accept station code, station name, city name, or `lat,lon`. Match against
`stations.bin` with normalised trigram + prefix scoring, multilingual (IRCTC data carries
`fromStnNameHi`/`fromStnNameGu`, so "मुंबई" and "મુંબઈ" both resolve). Always show the
top 5 candidates with disambiguation rather than silently picking one — a wrong origin
station is the worst possible failure mode.

---

## 6. The seven remedy strategies

Triggered when a segment returns `WAITLISTED` or `REGRET`. Each produces a scored,
explained candidate; the `LegSplitter` ranks them by **confidence gain × inverse cost** and
presents the top few with plain-language reasoning.

### ① Same-train split ⭐ the core trick

If `A→C` is WL and the train stops at `B` between them, query `A→B` and `B→C`
independently. Because IRCTC allots quota preferentially to longer segments, `A→B` and
`B→C` are frequently *both* available when `A→C` is not — and the reverse also happens,
which is why this must be evaluated rather than assumed.

```ts
function sameTrainSplitCandidates(train: TrainIdx, from: StationIdx, to: StationIdx) {
  const stops = intermediateStops(train, from, to);
  return stops
    .filter(s => haltMinutes(train, s) >= MIN_HALT_FOR_SPLIT)   // default 10 min
    .map(split => ({
      splitAt: split,
      haltMinutes: haltMinutes(train, split),
      segments: [ {train, from, to: split}, {train, from: split, to} ],
      // Practicality annotation — this is what makes the suggestion honest:
      warnings: [
        haltMinutes(train, split) < 20
          ? `Only ${haltMinutes(train,split)} min halt — berth change will be rushed`
          : null,
        `Requires TWO separate tickets for the same physical train`,
        `You may need to change berths/coaches at ${name(split)}`,
        `Grey area under IRCTC rules — verify before travelling`,
      ].filter(Boolean),
    }));
}
```

**Choosing split points intelligently**, not exhaustively:

- Prefer **major junctions** (high `rank`, long halts, quota-change stations).
- Prefer stations where the **model predicts high segment confidence** — Tier 1 can rank
  split candidates *before* issuing any live query, because segment length is a feature.
- Skip stations with halt < 10 min (physically impractical).
- Cap at ~5 candidate split points per train to bound query volume.

**Honesty requirement:** every split carries the halt duration, the berth-change warning,
and the two-ticket caveat. See [`09-risks-legal.md`](09-risks-legal.md).

### ② Date shift

Query `departDate ± dateFlexDays` (default ±2) and render a **date-flex heatmap** — rows
are classes, columns are dates, cells are availability. This is often the single
highest-value remedy: shifting two days can turn WL 40 into AVAILABLE-0120.

Cheap because Tier-1 predictions evaluate all dates in one vectorised pass, and because
`runs_days` gating means some dates are simply invalid (a weekly train does not run on
Wednesday — show that as a distinct "does not run" cell, not as "unavailable").

```
        Mon14   Tue15   Wed16   Thu17   Fri18   Sat19   Sun20
  SL    AVL 41  AVL 88  —n/a—   WL 12   WL 23   AVL112  WL 31
  3A    WL 06   AVL 14  —n/a—   RAC 03  WL 18   AVL 27  RAC 09
  2A    AVL 04  AVL 11  —n/a—   AVL 06  AVL 02  AVL 15  AVL 08
  1A    AVL 02  AVL 06  —n/a—   AVL 04  AVL 01  AVL 09  AVL 05
```

### ③ Quota shift

`GN` → `TQ` → `PT` → `LD` → `SS` → `HP`/`DF`/`FT`. Each has a separate pool and very
different dynamics: `LD` and `SS` frequently clear when `GN` doesn't.

Gate by eligibility (don't suggest Ladies quota to a solo male traveller; don't suggest
Senior quota under 60) and by window arithmetic — Tatkal may not be open yet, in which
case the remedy is **deferred with a countdown**, not rejected:

```
⏱ Tatkal (3A) opens in 6h 12m at 10:00 IST tomorrow.
  On this corridor Tatkal typically exhausts in under 4 minutes.
  → [Remind me]  ·  Meanwhile 3 alternatives are already AVAILABLE
```

`1A` is **excluded** from Tatkal — a common mistake.

### ④ Class shift

WL in 3A but available in 2A (+₹580) or SL (−₹290). Always surface the **cheapest class
that clears**, and the **most comfortable class that clears**, and let the user choose.
Show the fare delta explicitly.

### ⑤ Route substitution

A different corridor entirely. Pune→Madgaon direct is WL, but Pune→Ratnagiri→Madgaon on
two trains, or Pune→Panaji by bus then rail to Madgaon, both work. **CSA discovers these
naturally** because it explores transfers — no special-casing required. This is a direct
benefit of the algorithm choice.

### ⑥ Terminal / nearby-station substitution

Re-run with the expanded terminal sets from §5. Delhi→Mumbai: NDLS→BCT is WL, but
NZM→BDTS or ANVT→LTT may be available, and the user might not have considered either.
Cross-terminal access is priced as a road edge, so the suggestion is realistic.

### ⑦ Inter-modal bridge

When rail genuinely fails on a segment, insert a non-rail edge. See §8.

---

## 7. Remedy ranking

```ts
interface Remedy {
  kind: 'SPLIT'|'DATE_SHIFT'|'QUOTA_SHIFT'|'CLASS_SHIFT'|'ROUTE_SUB'
       |'TERMINAL_SUB'|'BUS'|'FLIGHT'|'ROAD'|'STOPOVER';
  delta: {
    confidenceGain: number;   // new worstLegConf − old worstLegConf   (primary)
    extraFareRupees: number;
    extraMinutes:    number;
    extraTransfers:  number;
    dateChanged:     boolean;
    comfortDelta:    number;
    risk:            'low'|'medium'|'high';   // e.g. short halt, two-ticket grey area
  };
  score: number;              // weighted; confidence gain dominates
  explanation: string;        // plain-language "why this helps"
  irctcLinks: string[];       // one per new segment
}
```

Score weights are user-adjustable ("prioritise certainty" vs "prioritise cost" vs
"prioritise comfort"). **`explanation` is mandatory** — a remedy without a reason is not
actionable, and the user's brief explicitly asked for reasoning ("*you can go here via this
train, these many seats are available, explore this place and then in these many hours the
next train has these many seats available*").

Present the top 3 by default, with "show all N" available. Never present more than ~7 —
choice overload defeats the purpose.

---

## 8. Inter-modal bridging

No free bus or flight API exists (redBus has none public). So bridges are **modelled from
bundled data plus geometry**, estimated, labelled as estimates, and deep-linked for
booking.

### Bus

```jsonc
// bus-corridors.json — curated, ~500 interstate city pairs
{ "PUNE–PANAJI": { "roadKm": 450, "typicalHours": [8, 11], "frequencyPerDay": 24,
                   "operators": ["state","private-sleeper","private-volvo"],
                   "fareRangeRupees": [700, 1400], "overnightServices": true,
                   "bookingUrls": { "redbus": "...", "abhibus": "..." } } }
```

**Candidate bridges are derived automatically**, not hand-listed: for any station pair
where rail needs > X hours *and* > Y transfers, but road distance < Z km, synthesise a bus
edge. This surfaces bridges nobody curated.

### Flight

```jsonc
// airports.json — harvested keylessly from OSM aeroway=aerodrome + Wikidata
{ "GOI": { "name": "Dabolim", "iata": "GOI", "icao": "VAGO",
           "lat": 15.3808, "lon": 73.8314, "nearestStations": ["VSG","MAO"],
           "roadKmToStation": {"VSG": 30, "MAO": 60}, "domestic": true,
           "trunkRoutes": ["BOM","DEL","BLR","HYD","MAA","CCU"] } }
```

Estimate duration as great-circle distance ÷ ~750 km/h + 45 min taxi/block padding; fare as
a bundled trunk-route table. Deep-link to Google Flights / Skyscanner. **Flights are
suggested only when rail genuinely fails or the time saving is large** — a flight from
Pune to Goa for a 450 km trip is bad advice and the scorer must know that.

### Road / taxi

Haversine × **road factor 1.25** (India) ÷ **~50 km/h** average, with a night penalty.
Used for cross-terminal transfers, station↔airport hops, and short bridges. Deep-link to
Google Maps directions.

### Every inter-modal edge carries

```ts
{ mode: 'bus'|'flight'|'road',
  estDurationMin: number, estCostRupees: [number, number],
  confidence: 'estimate',            // NEVER presented as a timetable
  frequencyHint?: string,            // "hourly" / "24 services daily"
  bookingUrl: string,                // redBus / Google Flights / Maps
  caveats: string[] }                // "no live seat data for buses"
```

Estimates are labelled as estimates. We cannot know a bus is full; we say so.

---

## 9. Stopovers: dwell as a first-class feature

The user's brief: *"explore this place and then in these many hours the next train has
these many seats available so you can continue from there."* So a long transfer is not a
cost — it is an opportunity.

```ts
interface StopoverOpportunity {
  station: StationIdx;
  dwellMinutes: number;
  dwellKind: 'short' | 'halfDay' | 'overnight' | 'multiDay';
  pois: POI[];                 // from bundled station→POI index (Wikidata/Overpass)
  weather?: Forecast;          // Open-Meteo, batched
  wikipedia?: Summary;         // lazy runtime fetch, IndexedDB-cached
  lodgingDensity: number;      // OSM tourism=hotel/hostel/guest_house within 3 km
  suggestedDwellHours: number; // from POI count & significance
  whyHere: string;             // "splitting the leg puts you here anyway"
}
```

**Trigger thresholds:** dwell > 3 h → show POIs. Dwell > 8 h or crossing midnight →
suggest overnight and show lodging density. Dwell > 24 h → treat as a real intermediate
destination and offer to re-plan around it.

The `whyHere` narrative matters: the app should say *"splitting the leg puts you in
Ratnagiri anyway, and it's worth 6 hours"* rather than presenting the stopover as an
apology. That reframing is the difference between a workaround and a feature.

Yen's algorithm provides the "show me journeys that pass through X" variant when the user
wants to *choose* a stopover rather than accept one.

---

## 10. Constraints enforced inside the scan

| Constraint | Implementation |
|---|---|
| `runs_days` | Bitmask test on the connection's operating date. **Inside the scan.** |
| Minimum transfer time | Per-junction table; large junctions 20–30 min, cross-terminal far more with a road edge |
| Max transfers | Label field; prune on exceed |
| Max travel hours | Label field; prune on exceed |
| 60-day ARP | Reject dates outside window; show "booking opens on DATE at 08:00 IST" |
| Tatkal window | Relative to **origin** departure, class-specific hour; 1A excluded |
| No backtracking | Penalise journeys moving away from target beyond a bearing/distance threshold |
| Arrival-time prefs | Optional penalty for 02:00–05:00 arrivals; daylight-arrival preference for remote areas |
| Cancellations/diversions | From `live.json`; **inside the scan** |
| Delays | Mutate `depTs`/`arrTs`; a delay that breaks a transfer must invalidate it |
| Split practicality | Halt ≥ 10 min for same-train splits; warn below 20 min |
| Coach/rake capacity | Feeds availability model; a 2-coach weekly ≠ a 24-coach daily |

---

## 11. Round-trip joint optimisation

A round trip is **not** two independent one-ways:

- Availability is **asymmetric and directional**. Fri Delhi→Patna before Chhath is WL 80;
  Patna→Delhi the same day is empty. After the festival it reverses.
- The **outbound remedy** may differ from the **return remedy** (split outbound, direct
  return).
- **Open-jaw** returns often win: go to Madgaon, come back from Vasco or Karwar.
- Transfers and budget are a **shared** resource across both directions.

```ts
function planRoundTrip(q: RoundTripQuery): RoundTripPlan[] {
  const outbound = paretoCSA(q.origin, q.destination, q.departDate, q.criteria);
  const returns  = paretoCSA(q.destination, q.origin, q.returnDate, q.criteria);
  const openJaw  = q.allowOpenJaw
    ? nearbyTerminals(q.destination).flatMap(alt =>
        paretoCSA(alt, q.origin, q.returnDate, q.criteria).map(r => ({alt, r})))
    : [];

  // Combine under shared constraints, then re-rank jointly
  return cartesian(outbound, [...returns, ...openJaw.map(o => o.r)])
    .filter(([o, r]) => o.totalTransfers + r.totalTransfers <= q.maxTransfersRoundTrip
                     && o.fare + r.fare <= (q.budgetTotal ?? Infinity))
    .map(([o, r]) => ({ outbound: o, return: r, score: jointScore(o, r) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, K);
}
```

`jointScore` rewards symmetry of comfort (don't pair a 1A outbound with a 2S return unless
the user asked for cheapest), penalises total fatigue, and gives a bonus to open-jaw plans
that meaningfully improve availability.

Also honour **`daysAtDestination`**: if the user says "4 days in Goa", the return search is
constrained to `departDate + 4 ± 1` and the app can say *"staying 4 days puts your return
on a Sunday, which is the worst day for Goa→Delhi — returning Monday is AVAILABLE-0140."*

---

## 12. Complexity and performance budget

| Operation | Cost | Target |
|---|---|---|
| Dataset load + view creation | memory-map, no parse | < 100 ms |
| Single-criterion CSA, one destination | O(&#124;C&#124;), early exit | < 50 ms |
| Pareto CSA, one destination, 6 criteria | O(&#124;C&#124; × frontier) | < 200 ms |
| **Full-network discovery sweep** | O(&#124;C&#124;), all stations | **< 400 ms** |
| Profile query (5 departure times) | 5 × scan | < 800 ms |
| Remedy exploration (7 strategies, 3 legs) | ~50–120 memoised availability calls | < 300 ms (Tier 1) |
| Date-flex heatmap (±2 days × 5 classes) | vectorised model inference | < 100 ms |
| Memory: full graph resident | typed arrays | ~12 MB |

All of this is **inside a Web Worker** — the UI stays at 60 fps throughout. Every query is
cancellable so refining a search aborts the in-flight scan instead of queueing behind it.

---

## 13. Correctness testing

| Test | Method |
|---|---|
| CSA optimality | Cross-check against brute-force Dijkstra on a small synthetic network — must agree exactly |
| `runs_days` gating | A weekly train must be absent on non-operating days; assert, don't assume |
| Pareto dominance | Property test: no returned label is dominated by another returned label |
| Transfer legality | No journey with transfer time < station minimum |
| Delay invalidation | Inject a 90-min delay; assert broken transfers disappear |
| Cancellation | Inject a cancellation; assert the train vanishes for that date |
| Tatkal arithmetic | The 12927 Dadar→Borivali worked example must pass |
| **Golden journey corpus** | ~50 hand-verified real itineraries, each asserting specific trains/splits appear |
| Split practicality | No same-train split suggested with halt < 10 min |
| Determinism | Same input → byte-identical output (enables snapshot tests) |

The golden corpus is the highest-value asset: it encodes domain knowledge ("NDLS→MAO really
does need a split at RATNAGIRI in September") that no unit test would surface. Build it
early, grow it forever, and treat any regression as a release blocker.

---

Next: [`05-data-pipeline.md`](05-data-pipeline.md)

# 02 — Routing engine, leg-splitting and discovery

Back to [`PLAN.md`](../PLAN.md) · Prev: [`01-data-and-availability.md`](01-data-and-availability.md) · Next: [`03-architecture-and-build.md`](03-architecture-and-build.md)

Where the product's real intellectual property lives. Anyone can list trains between two
stations; almost nothing decomposes a waitlisted journey into bookable legs, bridges the
gaps by road or air, and turns a forced transfer into a destination.

---

## 1. Algorithm choice

| Algorithm | Query | Preprocessing | Multi-criteria | Delays | Verdict |
|---|---|---|---|---|---|
| Time-expanded Dijkstra | O(E log V), large E | none | awkward | easy | Too slow for repeated interactive queries |
| **CSA** | **O(&#124;C&#124;)**, one linear scan | sort once | **native Pareto** | **array mutation** | ✅ **chosen** |
| RAPTOR | O(rounds × &#124;C&#124;) | route/stop index | native | moderate | Comparable; round-based, less cache-friendly |
| Transfer Patterns | ~O(1) lookup | **very heavy** | limited | hard | Preprocessing too costly for CI-only builds |
| Trip-Based Routing | fastest | heavy server-side | limited | moderate | Needs a preprocessing server; we have none |

**CSA** (Dibbelt, Nierhoff, Strasser & Wagner) organises the timetable as **one array of
connections sorted by departure time** and scans it once per query.

- O(&#124;C&#124;) with a tiny constant and **strictly sequential** access. `trRouting` (C++)
  reports **~8 ms** for a two-way CSA across all Montreal transit; a JS worker over the
  larger Indian network should land at ~50–200 ms for a full-network sweep.
- **Profile queries are native** — "all Pareto journeys for departures 18:00–23:00" is the
  same scan run backwards. That *is* the "show me options" UX.
- **Delays absorbed by mutating the array**, no re-preprocessing. Essential given the
  runtime live path.
- **Discovery mode falls out for free** — the scan computes earliest arrival at *every*
  station simultaneously, so whole-India reachability costs one query.
- **~300 lines of TypeScript.** No dependency, fully auditable.

Prior art to read (all need servers, so we copy their modelling, not their code): **MOTIS**,
**trRouting**, **OpenTripPlanner**, **Transitous**.

---

## 2. Data structures

```ts
// Connections: the hot array. Structure-of-arrays, sorted ascending by depTs.
interface ConnectionArrays {
  depTs:     Int32Array;   // minutes since timetable epoch — one linear time axis
  arrTs:     Int32Array;
  trainIx:   Uint16Array;
  fromStn:   Uint16Array;
  toStn:     Uint16Array;
  distKm:    Uint16Array;
  dayOff:    Uint8Array;   // day offset within the train's run
  classMask: Uint16Array;
}
// 290,000 × 19 bytes ≈ 5.5 MB raw → ~1.8 MB brotli

interface StationIndex {
  firstDeparture: Int32Array;  // each station's first outgoing connection
  outDegree:      Uint32Array;
  terminalGroup:  Uint16Array; // city terminal group id (0 = none)
  minTransferMin: Uint8Array;  // station-specific minimum transfer time
  rank:           Uint8Array;  // metro | junction | intermediate | halt
}

interface Footpath {           // walkable / roadable station↔station transfers
  from: number; to: number; minutes: number;
  mode: 'walk'|'metro'|'taxi'|'bus';
  costRupees: number; crossesTerminal: boolean;
}
```

**Why SoA:** CSA scans `depTs`/`arrTs` linearly. Separate arrays give sequential memory
access; an array-of-structs thrashes the cache every step. Biggest performance lever after
the algorithm choice.

**Why minutes-since-epoch:** an Int32 minute counter covers ~4,000 years and puts the whole
timetable on one linear axis — exactly what CSA requires. `dayOff` folds multi-day runs in.

**Date scoping decision:** keep **one representative week** and resolve operating dates at
query time via the `runsDays` bitmask, rather than expanding over the 60-day ARP window.
This keeps the array at ~290k connections instead of ~17M; the bitmask test inside the scan
is a single AND.

---

## 3. Base CSA (single criterion)

```ts
function csaEarliestArrival(C, departs: Set<StationIdx>, departureTime: Minute,
                            target: StationIdx, transfers, maxTransfers, date) {
  const transferArrival = new Int32Array(numStations).fill(INF);
  const prevConn        = new Int32Array(numConnections).fill(-1);
  const mark            = new Uint8Array(numStations);   // CSA "marked station" trick
  const transferCount   = new Uint8Array(numStations);

  for (const s of departs) { transferArrival[s] = departureTime; mark[s] = 1; }

  for (let c = firstConnectionAtOrAfter(C, departureTime); c < C.depTs.length; c++) {
    const from = C.fromStn[c], to = C.toStn[c], t = C.trainIx[c];

    const canBoard = mark[from] === 1 ||
      transferArrival[from] + transfers.minTransferTime(from, t) <= C.depTs[c];
    if (!canBoard) continue;
    if (transferCount[from] > maxTransfers) continue;
    if (!trainRunsOnDate(t, dateOf(C.depTs[c]))) continue;         // runs_days — IN the scan
    if (isCancelledOrDivertedAway(t, dateOf(C.depTs[c]))) continue; // live data — IN the scan

    if (C.arrTs[c] < transferArrival[to]) {
      transferArrival[to] = C.arrTs[c];
      prevConn[c]  = findPrevConnection(c, from, transferArrival, prevConn);
      mark[to] = 1;
      transferCount[to] = transferCount[from] + (prevConn[c] === -1 ? 0 : 1);

      for (const fp of transfers.outgoing(to)) {                    // footpaths / terminals
        const arr = C.arrTs[c] + fp.minutes;
        if (arr < transferArrival[fp.to]) {
          transferArrival[fp.to] = arr; mark[fp.to] = 1;
          transferCount[fp.to] = transferCount[to];
        }
      }
      if (to === target) { /* early-exit when arrival can no longer improve */ }
    }
  }
  return reconstruct(prevConn, transferArrival, target);
}
```

Three things are gated **inside the scan**, never as post-filters:

- **`runs_days`** — a weekly train on a non-operating day must not exist. This is precisely
  the bug the 2016 datasets guarantee.
- **Cancellations / diversions** — from the runtime live path.
- **Minimum transfer time** — per station, per train.

`mark` implements CSA's marked-station trick: a station is marked when it is an origin or was
reached by footpath, meaning *any* train departing it can be boarded without a time check.
That is what makes footpath transfers both correct and cheap.

---

## 4. Multi-criteria Pareto

```ts
interface Label {
  arrival: Minute;    // ↓   transfers: number;  // ↓   fare: number;   // ↓
  worstConf: number;  // ↑ ← availability enters HERE
  nightLegs: number;  // ↓   fatigue: number;    // ↓   (hours seated, berth changes, early deps)
  prevConn: number; prevLabel: number;
}

const dominates = (a: Label, b: Label) =>
  a.arrival <= b.arrival && a.transfers <= b.transfers && a.fare <= b.fare &&
  a.worstConf >= b.worstConf && a.nightLegs <= b.nightLegs && a.fatigue <= b.fatigue &&
  (a.arrival < b.arrival || a.transfers < b.transfers || a.fare < b.fare ||
   a.worstConf > b.worstConf || a.nightLegs < b.nightLegs || a.fatigue < b.fatigue);
```

Frontier capped at **~12 labels/station** with eviction of the least-dominated — without a
cap, six criteria across 8,000 stations blow up memory. The cap is tuned against the golden
journey corpus.

**`worstConf` is the crucial addition.** It makes the engine route *around* waitlisted
segments rather than find the fastest journey then apologise. A 2-transfer journey at 94%
confidence can legitimately dominate a direct journey at 38%.

The **top-K non-dominated labels at the destination are the results list** — no separate
K-shortest-paths pass. Yen's algorithm is retained only for forced-waypoint enumeration
("show me journeys through X"), and is **deferred** — stopovers work without it initially.

---

## 5. Origin and destination expansion

A naive `origin → destination` query is wrong for Indian cities before the algorithm runs.

```jsonc
// terminals.json
{ "DELHI":     {"stations":["NDLS","NZM","DLI","ANVT","DEE","NNO","SZM"],
                "hub":"NDLS","interTerminalMinutes":45},
  "MUMBAI":    {"stations":["CSTM","BCT","LTT","DR","BDTS","KYN","PNVL","TNA"],
                "interTerminalMinutes":60},
  "KOLKATA":   {"stations":["HWH","SDAH","KOAA","SHM"], "interTerminalMinutes":40},
  "CHENNAI":   {"stations":["MAS","MSB","TBM","MS"],    "interTerminalMinutes":35},
  "BENGALURU": {"stations":["SBC","YPR","BAND","SMVB","KSR","WFD"], "interTerminalMinutes":45},
  "HYDERABAD": {"stations":["SC","KCG","HYB","BMO"],    "interTerminalMinutes":40},
  "GOA":       {"stations":["MAO","VSG","THVM","KUDL","MDVL"], "interTerminalMinutes":90} }
```

Mumbai's spread matters: Kalyan, Panvel and Thane are 60–90 min from the island-city
terminals. Cross-terminal transfers become **road footpath edges with realistic (not
optimistic) durations and a rupee cost**, so a "transfer" that is really a 90-minute taxi
ride is priced as one and won't be chosen lightly.

**Radius expansion:** stations within N km of the requested point (default 25 urban / 60
rural), each with a road-time access edge. This is what makes "I'm in Goa" resolve to
MAO/VSG/THVM instead of failing.

**Fuzzy resolution:** accept code, name, city or `lat,lon`; normalised trigram + prefix
scoring over `stations.bin`; multilingual (`मुंबई`, `મુંબઈ`, `Mumbai` all resolve). **Always
show the top 5 with disambiguation** — a silently-wrong origin is the worst failure mode in
the app.

---

## 6. The seven remedies

Triggered on `WAITLISTED` or `REGRET`. Each yields a scored, explained candidate; ranked by
**confidence gain × inverse cost**.

### ① Same-train split — the core trick

If `A→C` is WL and the train stops at `B` between them, query `A→B` and `B→C`
independently. Because quota is allotted preferentially to longer segments, both halves are
frequently available when the whole is not — **and the reverse also happens**, which is why
this must be evaluated, never assumed.

```ts
function sameTrainSplitCandidates(train, from, to) {
  return intermediateStops(train, from, to)
    .filter(s => haltMinutes(train, s) >= MIN_HALT_FOR_SPLIT)     // 10 min, hard floor
    .map(split => ({
      splitAt: split, haltMinutes: haltMinutes(train, split),
      segments: [{train, from, to: split}, {train, from: split, to}],
      warnings: [
        haltMinutes(train, split) < 20
          ? `Only ${haltMinutes(train,split)} min halt — berth change will be rushed` : null,
        `Requires TWO separate tickets for the same physical train`,
        `You may need to change berths/coaches at ${name(split)}`,
        `Grey area under IRCTC rules — verify before travelling`,
      ].filter(Boolean),
    }));
}
```

**Choosing split points intelligently** rather than exhaustively:
- prefer **major junctions** (high `rank`, long halts, quota-change stations)
- prefer stations where the **model predicts high segment confidence** — Tier 1 can rank
  split candidates *before any live query*, because segment length is a feature
- hard-reject halt < 10 min; warn below 20 min
- cap at **~5 candidates per train** to bound query volume

**Guard rail:** if the full run is clear and the halves are WL, **never suggest a split** —
take the direct ticket. Don't make things worse.

### ② Date shift
Query `departDate ± dateFlexDays` (default ±2) → date-flex heatmap. Often the single
highest-value remedy: two days can turn WL 40 into AVAILABLE-0120. Cheap because Tier-1
inference is vectorised across dates, and because `runs_days` makes some dates simply
invalid — render those as a distinct **`no run`** cell, *not* as "sold out".

```
          Mon14    Tue15    Wed16    Thu17    Fri18    Sat19    Sun20
  SL    AVL 41   AVL 88   no run   WL 12    WL 23   AVL 112   WL 31
  3A    WL 06    AVL 14   no run   RAC 03   WL 18   AVL 27    RAC 09
  2A    AVL 04   AVL 11   no run   AVL 06   AVL 02  AVL 15    AVL 08
  1A    AVL 02   AVL 06   no run   AVL 04   AVL 01  AVL 09    AVL 05
```
Cells carry **text and colour** — colour alone fails ~8% of male users.

### ③ Quota shift
`GN → TQ → PT → LD → SS → HP/DF/FT`, each a separate pool with different dynamics (`LD` and
`SS` often clear when `GN` doesn't). **Eligibility-gated** — never suggest Ladies quota to a
solo male traveller, never Senior below 60. If Tatkal isn't open yet the remedy is
**deferred with a countdown**, not rejected. `1A` is excluded from Tatkal.

```
⏱ Tatkal (3A) opens in 6h 12m at 10:00 IST tomorrow.
  On this corridor Tatkal typically exhausts in under 4 minutes.
  [Remind me] · meanwhile 3 alternatives are already AVAILABLE
```

### ④ Class shift
WL in 3A but available in 2A (+₹580) or SL (−₹290). Always surface both the **cheapest**
and the **most comfortable** class that clears, with the fare delta explicit.

### ⑤ Route substitution
A different corridor entirely. **CSA discovers these naturally** because it explores
transfers — zero special-casing. A direct benefit of the algorithm choice.

### ⑥ Terminal / nearby-station substitution
Re-run with the expanded sets from §5. Delhi→Mumbai: NDLS→BCT is WL, but NZM→BDTS or
ANVT→LTT may be available and the user might not have considered either.

### ⑦ Inter-modal bridge — see §7

---

## 7. Inter-modal bridging

No free bus or flight API exists (redBus has none public). So bridges are **modelled from
bundled data plus geometry**, estimated, labelled as estimates, deep-linked for booking.

**Bus** — curated `bus-corridors.json`, ~500 interstate city pairs:
```jsonc
{ "PUNE–PANAJI": { "roadKm":450, "typicalHours":[8,11], "frequencyPerDay":24,
    "operators":["state","private-sleeper","private-volvo"],
    "fareRangeRupees":[700,1400], "overnightServices":true,
    "bookingUrls":{"redbus":"…","abhibus":"…"} } }
```
**Candidate bridges are derived automatically, not just hand-listed:** for any station pair
where rail needs > X hours *and* > Y transfers but road distance < Z km, synthesise a bus
edge. This surfaces bridges nobody curated.

**Flight** — `airports.json` from OSM `aeroway=aerodrome` + Wikidata IATA (keyless):
```jsonc
{ "GOI": {"name":"Dabolim","lat":15.3808,"lon":73.8314,
          "nearestStations":["VSG","MAO"],"roadKmToStation":{"VSG":30,"MAO":60},
          "trunkRoutes":["BOM","DEL","BLR","HYD","MAA","CCU"]} }
```
Great-circle ÷ ~750 km/h + 45 min block padding; fares from a bundled trunk-route table.
**Suggest flights only when rail genuinely fails or the time saving is large** — a flight for
a 450 km trip is bad advice and the scorer must know that.

**Road/taxi** — haversine × **1.25** road factor ÷ **~50 km/h**, with a night penalty. Used
for cross-terminal transfers, station↔airport hops, short bridges.

Every inter-modal edge carries:
```ts
{ mode, estDurationMin, estCostRupees:[lo,hi], confidence:'estimate',
  frequencyHint?, bookingUrl, caveats:string[] }
```
Estimates are labelled estimates. We cannot know a bus is full — say so.

---

## 8. Stopovers: dwell as a first-class feature

The brief: *"explore this place and then in these many hours the next train has these many
seats available so you can continue from there."* A long transfer is an opportunity, not a
cost.

```ts
interface StopoverOpportunity {
  station: StationIdx; dwellMinutes: number;
  dwellKind: 'short'|'halfDay'|'overnight'|'multiDay';
  pois: POI[];                  // bundled station→POI index
  weather?: Forecast;           // Open-Meteo, batched
  wikipedia?: Summary;          // lazy runtime fetch
  lodgingDensity: number;       // OSM tourism=hotel/hostel/guest_house within 3 km
  suggestedDwellHours: number;  // POI count × significance
  whyHere: string;              // "splitting the leg puts you here anyway"
}
```

| Trigger | Action |
|---|---|
| dwell > 3 h | show POIs |
| dwell > 8 h or crosses midnight | suggest overnight + lodging density |
| dwell > 24 h | treat as a real intermediate destination; offer to re-plan around it |

The `whyHere` narrative is the point: *"splitting puts you in Ratnagiri anyway, and it's
worth 6 hours"* — not an apology. That reframing is the difference between a workaround and
a feature.

---

## 9. Constraints enforced inside the scan

| Constraint | Implementation |
|---|---|
| `runs_days` | bitmask test on the operating date — **in the scan** |
| Min transfer time | per-junction table; start with rank-based defaults (metro 30 / junction 20 / intermediate 10 / halt 5 min), refine later |
| Max transfers / max hours | label fields; prune on exceed |
| 60-day ARP | reject outside window; say "booking opens DATE at 08:00 IST" |
| Tatkal window | relative to **origin** departure, class-specific hour, `1A` excluded |
| No backtracking | penalise movement away from target beyond a bearing/distance threshold |
| Arrival preferences | optional penalty for 02:00–05:00 arrivals; daylight-arrival preference for remote areas |
| Cancellations / diversions | from runtime live data — **in the scan** |
| Delays | mutate `depTs`/`arrTs`; a delay that breaks a transfer must invalidate it |
| Split practicality | halt ≥ 10 min hard floor; warn below 20 min |
| Rake capacity | feeds the availability model — a 2-coach weekly ≠ a 24-coach daily |
| Unreserved services | `SUB`/`PAX`/`UR` carry **no availability concept** — exclude from WL modelling and label differently |

---

## 10. Round-trip joint optimisation

Not two independent one-ways. Availability is **directional and asymmetric**:

```
Fri 18 Sep  Delhi → Patna   WL 80     (Chhath rush outward)
Fri 18 Sep  Patna → Delhi   AVL 210   (empty the other way)
Sun 27 Sep  Patna → Delhi   WL 95     (post-festival return rush)
```

```ts
function planRoundTrip(q) {
  const outbound = paretoCSA(q.origin, q.destination, q.departDate, q.criteria);
  const returns  = paretoCSA(q.destination, q.origin, q.returnDate, q.criteria);
  return cartesian(outbound, returns)
    .filter(([o,r]) => o.transfers + r.transfers <= q.maxTransfersRoundTrip
                    && o.fare + r.fare <= (q.budgetTotal ?? Infinity))
    .map(([o,r]) => ({outbound:o, return:r, score: jointScore(o,r)}))
    .sort((a,b) => b.score - a.score).slice(0, K);
}
```

`jointScore` rewards symmetry of comfort (don't pair a 1A outbound with a 2S return unless
the user asked for cheapest), penalises total fatigue, and shares the transfer/time budget
across both directions — so an outbound that needs a split doesn't force a split return.

**`daysAtDestination`** constrains the return date and enables advice like *"staying 4 days
puts your return on a Sunday, the worst day for Goa→Delhi — Monday is AVAILABLE-0140."*

**Open-jaw** (return from a different nearby city) is **deferred** — joint optimisation
covers the main case; revisit if users ask.

---

## 11. Discovery mode

### The insight

A normal query runs CSA origin → one destination. But the scan computes **earliest arrival
at every station simultaneously**. So one pass from the origin yields complete whole-India
reachability — **the same cost as one query.** Discovery mode is not an expensive batch job;
it is a different presentation of a query the engine already answers.

### Pipeline

```
1 SWEEP    CSA from origin @ departDate, horizon = maxTravelHours (24)
           → { station: [earliestArrival, cheapestFare, bestConfidence, legs] }   <400 ms
2 FILTER   drop: no POIs within 25 km · > maxTransfers · worstLegConfidence < 0.35
           collapse terminal groups to one destination · drop origin's own city
           ~8,000 → ~600–1,200 candidates
3 ENRICH   POI index (bundled) · Open-Meteo (ONE batched call) · fare engine (local)
           Wikipedia lazy — only on card expand
4 SCORE    weighted composite; weights are user sliders
5 DIVERSIFY max 2/state · MMR against near-duplicates · guaranteed budget + offbeat +
           high-certainty slots
6 PRESENT  8 cards; sliders re-rank in <100 ms WITHOUT re-sweeping
```

The `< 0.35` confidence filter is what makes discovery **honest**: suggesting a beautiful
place the user cannot get a ticket to is worse than not suggesting it.

### Scoring

| Component | Weight | What |
|---|---|---|
| `availabilityScore` | .25 | `0.7×worstLegConf + 0.2×meanLegConf + 0.1×remedyHeadroom` |
| `seasonFit` | .20 | Open-Meteo 16-day forecast for the actual window (see below) |
| `interestMatch` | .20 | tag → POI-type mapping |
| `journeyQuality` | .15 | scenic bonus, train type, arrival-time sanity, dwell pleasantness |
| `budgetFit` | .10 | within stated budget |
| `durationFit` | .05 | `suggestedDwellHours` vs. stated days |
| `novelty` | .05 | inverted popularity when `offbeat` is selected |

Weights are sliders; components **renormalise when one is unavailable** (Open-Meteo down →
drop `seasonFit`, rescale).

**`seasonFit` uses real forecast data**, which makes a genuinely novel filter computable:

> **"Away from the monsoon"** — in September, exclude destinations whose forecast shows heavy
> precipitation and surface rain-shadow options instead. From Mumbai in July: skip the Konkan
> and the Western Ghats; suggest Ladakh, Spiti, or the Deccan east of the Ghats.

No hardcoded seasonality table can do that. The same mechanism supports "away from the cold"
and "away from the crowds" (festival calendar + popularity).

Penalties/bonuses: heavy monsoon (>100 mm/wk) → strong penalty for beaches, treks, hill
roads, and **Ladakh/Spiti effectively closed**; extreme heat (>42 °C) → penalty for Rajasthan
plains, Delhi, UP in May; Himalayan snow Dec–Feb → bonus for snow destinations; pleasant
18–30 °C → bonus.

*(The previous draft's 80-year climate-normals precompute was **cut** — the runtime 16-day
forecast already delivers all of the above at zero build cost.)*

**`interestMatch`:**

| Tag | Matches |
|---|---|
| beaches | `natural=beach`, coastal stations |
| mountains | elevation >1,000 m, hill stations, Himalayan lines |
| wildlife | national parks, tiger reserves, bird sanctuaries |
| temples / spiritual | places of worship, pilgrimage sites, jyotirlingas, gurudwaras |
| forts / heritage | forts, UNESCO World Heritage Sites, monuments |
| food | curated city list (Lucknow, Hyderabad, Amritsar, Kolkata, Chennai, Delhi, Pune, Indore) |
| trekking | trailheads, elevation gain |
| **offbeat** | **inverted popularity** — low `trainCount`, few major POIs, low lodging density |

With no tags selected (the default), use a broad mix weighted toward generally
high-satisfaction categories so first-run is good without onboarding.

**`journeyQuality`:** scenic bonus for Konkan Railway, Nilgiri Mountain Railway, Kangra
Valley, Darjeeling Himalayan, Kalka–Shimla, Matheran Hill, Nilambur–Shoranur, Bhor/Thull
Ghats, Vindhyachal–Katni — enumerable from OSM route relations plus a short curated list,
with the practical tip (*"Konkan — sit LEFT going south"*). Bonus for Vande Bharat /
Rajdhani / Duronto. Penalty for 02:00–05:00 arrivals, >24 h total, >2 berth changes.

### Diversification

Without it, the top 8 from Pune are all in Maharashtra and Goa. **Max 2 per state**, max 3
per region; **MMR** picking `λ·score − (1−λ)·max_similarity_to_picked` where similarity
combines bearing, distance band and tag overlap; **guaranteed slots** for one budget option
(₹<1,500 round trip), one offbeat option, and one high-certainty option (>0.85) so the user
always sees something genuinely bookable.

### The honest hard cases

| Region | Reality | Required behaviour |
|---|---|---|
| **Northeast** | Rail reach genuinely thin. **Guwahati** and **Siliguri/New Jalpaiguri** are the practical gateways; several states have limited or no broad-gauge reach | Surface gateway + inter-modal bridge. Label rail-only reachability accurately. Never imply Agartala is an easy rail trip from Delhi |
| **Ladakh** | **No rail** | Air/road only via Jammu or Pathankot railhead. Say plainly that rail cannot reach it |
| **Andaman / Lakshadweep** | **No rail at all** | Air (and ship for Lakshadweep), explicitly labelled "not reachable by train". Still worth surfacing — the user wants to explore India, not only by rail |
| **Kashmir** | USBRL changes this | **Let the harvested data decide.** Never hardcode network topology — it changes |
| **Branch lines** | Sparse, often passenger-only, unreserved | Mark clearly; no availability concept applies; don't apply the WL model to `SUB`/`PAX` |

Rule: **when rail can't do it, say so and offer the alternative mode.** Pretending otherwise
destroys trust in every other suggestion.

### Cold start and caching

| Concern | Approach |
|---|---|
| No preferences on first run | Broad default mix; guaranteed budget + offbeat + high-certainty slots |
| Low-end devices | Region-shard the sweep zone by zone, or cap horizon to 16 h with "expand to all India" |
| Repeat runs | Cache reachability per `(origin, date, criteria)` in IndexedDB; sliders re-rank without re-sweeping |
| Open-Meteo budget | **One batched multi-location call**, cached 6 h. Not eight calls. Zero Actions minutes |
| Wikipedia budget | Lazy, per card expand. Most users open 1–3 of 8 |

---

## 12. Performance budget

| Operation | Cost | Target |
|---|---|---|
| Dataset load + view creation | memory-map, no parse | < 100 ms |
| Single-criterion CSA, one destination | O(&#124;C&#124;), early exit | < 50 ms |
| Pareto CSA, 6 criteria | O(&#124;C&#124; × frontier) | < 200 ms |
| **Full-network discovery sweep** | O(&#124;C&#124;), all stations | **< 400 ms** |
| Profile query (5 departure times) | 5 scans | < 800 ms |
| Remedy exploration (7 strategies, 3 legs) | ~50–120 memoised availability calls | < 300 ms on Tier 1 |
| Date-flex heatmap (±2 days × 5 classes) | vectorised inference | < 100 ms |
| Slider re-rank | scoring only, no re-sweep | < 100 ms |
| Memory: full graph resident | typed arrays | ~12 MB |

All inside a **Web Worker** — UI stays at 60 fps. Every query is **cancellable** so refining
a search aborts the in-flight scan instead of queueing behind it.

**Availability memoisation is essential:** 7 remedies × ±2 dates × 6 classes × 4 quotas on a
3-leg journey is naively ~1,000 queries. Memoising on the `(train, from, to, date, class,
quota)` tuple, plus the fact that remedies share most segments, collapses it to ~50–120.

---

## 13. Testing

| Test | Method |
|---|---|
| CSA optimality | Cross-check against brute-force Dijkstra on a small synthetic network — must agree exactly |
| `runs_days` gating | A weekly train must be **absent** on non-operating days. Assert, don't assume |
| Pareto dominance | Property test: no returned label is dominated by another returned label |
| Transfer legality | No journey with transfer time below the station minimum |
| Delay invalidation | Inject a 90-min delay; assert broken transfers disappear |
| Cancellation | Inject a cancellation; assert the train vanishes for that date |
| Tatkal arithmetic | The **12927 Dadar→Borivali** case → opens 23 Jan |
| Split floor | No same-train split suggested with halt < 10 min |
| Split guard rail | A clear full-run with WL halves must **not** suggest a split |
| Determinism | Same input → byte-identical output (enables snapshot tests) |
| **Golden journey corpus** | ~35–50 hand-verified real itineraries asserting specific trains/splits appear |

The golden corpus is the highest-value asset: it encodes domain knowledge ("NDLS→MAO really
does need a split at RATNAGIRI in September") that no unit test surfaces. Build it in
Phase 1, grow it forever, treat any regression as a **release blocker**.

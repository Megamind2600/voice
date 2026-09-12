# 03 — Seat availability: the hard problem

Back to [`PLAN.md`](../PLAN.md)

This is the document that determines whether the project is honest or fantasy. It states
the constraint, then designs around it.

---

## 1. The constraint, stated plainly

> **A static GitHub Pages site cannot show guaranteed-live IRCTC seat availability with
> zero user setup. No amount of cleverness changes this.**

Three independent blockers, each sufficient on its own:

1. **No free keyless availability API exists.** IRCTC's reservation data lives in the
   **PRS**. CRIS has said publicly it does not intend to open reservation APIs to
   developers. IRCTC's own API access is enterprise-gated (historically ~₹5 crore
   turnover). Every reseller — IndianRailAPI, RapidAPI, parse.bot, Apify, AOPAY —
   requires a key and/or payment. eRail's free API is **suspended**. RailRadar is free but
   capped at **1,000 requests/month**, roughly 50 searches.
2. **GitHub Pages runs no code.** No server means no server-side scraping, no proxying, no
   session management, no way to hide a credential. Anything the browser fetches must come
   from an endpoint that permits cross-origin reads.
3. **IRCTC blocks browser-origin requests** and gates availability behind
   session/auth/captcha. Even a public CORS relay cannot make that reliable, and attempting
   it at scale would be abusive.

NTES — the one genuinely free, keyless official source — is the **enquiry** system. It has
timetables and live running status. It has **no availability**.

**So the design goal becomes:** be maximally useful *without* live availability, upgrade
automatically when a better source is reachable, and always give the user a one-click path
to ground truth. That is the five-tier cascade.

---

## 2. The five-tier cascade

```
                       query(train, from, to, date, class, quota)
                                      │
        ┌─────────────────────────────┴──────────────────────────────┐
        │ T4  BYOK: user key in localStorage?                        │
        │     → RailRadar / RapidAPI / IndianRailAPI                 │──▶ REAL
        └─────────────────────────────┬──────────────────────────────┘
                                      │ absent
        ┌─────────────────────────────┴──────────────────────────────┐
        │ T3  Live probe enabled AND relay reachable?                │
        │     → best-effort, 8s timeout, one retry                   │──▶ LIVE*
        └─────────────────────────────┬──────────────────────────────┘   (unofficial)
                                      │ no / failed
        ┌─────────────────────────────┴──────────────────────────────┐
        │ T2  Actions snapshot covers this corridor AND < 12h old?   │
        │     → availability-snapshot.json (~200 top corridors)      │──▶ SNAPSHOT
        └─────────────────────────────┬──────────────────────────────┘
                                      │ miss
        ┌─────────────────────────────┴──────────────────────────────┐
        │ T1  Prediction model (ALWAYS available)                    │──▶ PREDICTED
        │     → P(confirm), E[WL], interval                          │
        └─────────────────────────────┬──────────────────────────────┘
                                      │ uses
        ┌─────────────────────────────┴──────────────────────────────┐
        │ T0  Static quota + rake reference (capacity denominator)   │
        └────────────────────────────────────────────────────────────┘

        T5  IRCTC deep link — emitted for EVERY result, all tiers, always
```

### The result type

Every tier returns the same shape. Provenance is not optional metadata — it is part of the
answer, and the UI must render it.

```ts
interface AvailabilityResult {
  segment: SegmentRef;              // train, from, to, date, class, quota
  verdict: Verdict;                 // see below
  seats?: number;                   // only when verdict === 'AVAILABLE' and known
  wlPosition?: number;              // only when waitlisted
  racPosition?: number;             // only when RAC
  pConfirm?: number;                // 0..1  — Tier 1 always sets this
  pConfirmCI?: [number, number];    // 90% interval
  expectedWl?: number;              // Tier 1
  source: 'REAL' | 'LIVE' | 'SNAPSHOT' | 'PREDICTED' | 'UNKNOWN';
  fetchedAt?: number;               // unix ms — drives "42m ago" badges
  confidence: 'high' | 'medium' | 'low';
  raw?: string;                     // original status string, if any
  remedies: RemedyRef[];            // computed downstream, attached here
}

type Verdict =
  | 'AVAILABLE'        // confirmed berths/seats exist
  | 'RAC'              // shared berth — you CAN travel
  | 'WAITLISTED'       // WL n — may or may not clear
  | 'REGRET'           // bookings closed for this segment
  | 'UNKNOWN';
```

**Design rule:** no code path may produce `source: 'PREDICTED'` rendered without its
badge. A prediction that looks like a reservation is the one failure mode that would make
this app actively harmful.

---

## 3. Tier 0 — quota and rake reference

Static, bundled, always available. Provides the **denominator** for every availability
claim: you cannot reason about "WL 23 will clear" without knowing how many berths exist.

```jsonc
// trains.meta (excerpt)
{
  "12138": {
    "type": "MEX", "name": "PUNJAB MAIL",
    "origin": "FZR", "destination": "CSMT",
    "runsDays": 127,                        // bitmask, 127 = daily
    "classes": ["1A","2A","3A","SL"],
    "rake": { "1A": 1, "2A": 3, "3A": 8, "SL": 12, "UR": 4 },   // coach counts
    "berthsPerCoach": { "1A": 18, "2A": 46, "3A": 64, "SL": 72 },
    "flexiFare": false,
    "quotaPools": ["GN","TQ","LD","SS","HP","DF"],
    "arpDays": 60
  }
}
```

Capacity for a class = `coaches × berthsPerCoach`. For 12138 in SL that is
`12 × 72 = 864` berths. A WL of 23 against 864 berths on a daily trunk-route train is
materially different from WL 23 against a 2-coach weekly — **and only this tier lets you
tell them apart.**

Sourced from NTES plus publicly documented coach-position/composition data. ~300 KB.

---

## 4. Tier 1 — the prediction model (the default)

### 4.1 What it predicts

Not a seat count — a **probability distribution**:

- `pConfirm` — P(the ticket ends up confirmed by chart preparation)
- `expectedWl` — E[waitlist position at booking time]
- `pRac` — P(RAC, i.e. you travel on a shared berth)
- a 90% interval on `pConfirm`

This mirrors what ConfirmTkt and ixigo expose as "confirmation probability". The
difference is ours runs **entirely in the browser from a bundled coefficient table** — no
server, no key, no network call, microsecond inference.

### 4.2 Feature set

Every feature is computable from L1 (graph) + L3 (rules/calendar) with **no live data**.

| Group | Features | Why it predicts |
|---|---|---|
| **Window position** | days-to-journey (0–60); booking not yet open; hours to Tatkal open; is this inside ARP at all | Demand accumulates monotonically as the date approaches; the curve shape is highly regular |
| **Calendar** | day-of-week (Fri/Sun/Mon peaks); festival proximity & intensity from `festivals.json`; school-vacation window (Apr–Jun, mid-Oct–Nov); gazetted holiday adjacency | Festival corridors see 5–20× normal demand. Chhath (Bihar/UP), Diwali, Durga Puja, Eid, Holi, Onam, Pongal are the big spikes |
| **Train** | type (VNDB > DRNT/RAJ > SHB > SUF > MEX > SUB > PAX); flexi-fare flag; total class capacity; daily/weekly/biweekly | Premium trains rarely WL in top classes; weekly trains on migrant corridors WL instantly |
| **Segment** ⭐ | `isFullRun` (origin→destination?); distance as % of train's total; boarding index into the run; crosses a quota-change station; segment is <200 km | **The strongest feature group.** IRCTC allots quota preferentially to long/full-run segments. Short hops very often return `REGRET` while the same train end-to-end is available — and this asymmetry is exactly what `LegSplitter` exploits |
| **Corridor** | corridor congestion (# trains serving the city pair); trunk-route flag; corridor demand rank | Trunk routes have both more demand and more supply; branch lines have neither |
| **Station rank** | metro / major junction / intermediate / halt, for both ends | Demand correlates strongly with station rank |
| **Class** | one-hot | SL and 3A carry most waitlisting; 1A/EC almost never WL; 2S behaves almost unreserved |
| **Quota** | one-hot GN/TQ/PT/LD/SS/HP/DF | Separate pools with very different dynamics; LD and SS often clear when GN doesn't |
| **Directional** | is this the "peak" direction for the day/festival? | Chhath: Delhi→Patna is WL, Patna→Delhi is empty, and reverses after the festival |

⭐ The segment group is where this model beats a naive "train popularity" heuristic, and it
is what makes leg-splitting *predictable* rather than trial-and-error: the model can say
"splitting at Kota will probably work" **before** issuing any query.

### 4.3 Model form and shipping

Train gradient-boosted trees offline (fast, handles mixed categorical/numeric, gives
feature importances). Then **distil into a calibrated coefficient table** shipped as JSON:

```jsonc
// availability-model.json  (~50–150 KB, brotli ~40 KB)
{
  "version": "2026.09",
  "trainedOn": "kaggle-irctc-2023-10 + heuristics",
  "calibration": { "method": "isotonic", "bins": [[0.02,0.05],[0.05,0.12], "..."] },
  "intercept": -1.83,
  "numeric": {
    "daysToJourney":   { "kind": "piecewiseLinear", "knots": [0,1,3,7,15,30,60],
                         "coef":  [-0.42,-0.31,-0.18,-0.09,-0.03,0.01,0.02] },
    "segmentDistPct":  { "kind": "piecewiseLinear", "knots": [0,0.15,0.4,0.7,1.0],
                         "coef":  [-1.15,-0.62,-0.18,0.09,0.34] },
    "logCapacity":     { "kind": "linear", "coef": -0.21 },
    "corridorCongestion": { "kind": "linear", "coef": 0.07 }
  },
  "categorical": {
    "class":  { "SL": 0.00, "3A": -0.18, "2A": -0.74, "1A": -1.62, "CC": -0.31,
                "EC": -0.88, "2S": 0.95, "3E": -0.05 },
    "quota":  { "GN": 0.00, "TQ": -0.55, "PT": -0.30, "LD": -0.95, "SS": -1.10 },
    "trainType": { "VNDB": -0.62, "DRNT": -0.88, "RAJ": -0.95, "SHB": -0.71,
                   "SUF": 0.00, "MEX": 0.24, "SUB": 1.05, "PAX": 1.40 },
    "dow":    { "Mon": 0.22, "Tue": -0.05, "Wed": -0.09, "Thu": 0.03,
                "Fri": 0.41, "Sat": 0.11, "Sun": 0.35 }
  },
  "festivalMultiplier": { "chhath": 2.8, "diwali": 2.4, "durgaPuja": 2.1,
                          "eid": 1.7, "holi": 1.6, "summerVacation": 1.35 },
  "wlModel": { "baseRate": "...", "clearanceCurveByCapacity": "..." }
}
```

Inference is a handful of lookups and a sigmoid. No ML runtime, no WASM, no dependencies.
Runs inside the same worker as the router, so remedy exploration costs nothing extra.

### 4.4 Training data

| Source | Licence | Role |
|---|---|---|
| Kaggle *Indian Railways Schedule-Prices-Availability Data* (Oct 2023, real availability strings + fares) | **Apache-2.0** | Primary training set |
| Published WL-clearance heuristics & IRCTC rule documents | Public | Priors and constraints |
| NTES-derived rake/quota/`runs_days` | see redistribution note | Feature construction |
| Our own Tier-2 snapshots (once running) | n/a | Continuous improvement loop |

Apache-2.0 permits derivative works including a trained model, with attribution.

**Known limitation, stated honestly:** the corpus is from 2023. It teaches *structural*
patterns well (which corridors waitlist, how segment length affects allotment, how WL
grows with proximity) but not *current absolute levels* — especially not post-ARP-reduction
(60 days vs 120) dynamics. That is precisely why the output is a **probability band** and
never a seat count, and why the interval is wide.

### 4.5 Calibration and evaluation

An uncalibrated probability is worse than none. Requirements:

- **Isotonic calibration** on a held-out split; plot the reliability curve and ship the bins.
- **Brier score** and **log loss** vs. baselines (constant-rate, class-only, corridor-only).
- **Per-corridor error** — a model that is right on average but catastrophically wrong on
  Delhi–Patna during Chhath is not acceptable; report worst corridors explicitly.
- **Temporal hold-out** (train on earlier dates, test on later) — not random splitting,
  which leaks seasonality.
- **Decision-quality metric:** of journeys where the model said `pConfirm > 0.8`, what
  fraction actually confirmed? That is the number users experience.
- Retrained monthly by `train-availability-model.yml`; the calibration report is committed
  as an artifact so regressions are visible.

### 4.6 Presentation

Never a bare number. Always:

```
WL 23  ·  62% likely to confirm  (±9%)        [PREDICTED]
└─ based on: daily trunk-route train, 864 SL berths, 12 days out,
   post-festival window. Similar segments confirmed at this WL 6 times in 10.
```

Showing the reasoning is what makes a prediction trustworthy enough to plan around
without being mistaken for a reservation.

---

## 5. Tier 2 — Actions snapshots (zero setup, no key)

GitHub Actions is already free on this repo and authenticates with the default
`GITHUB_TOKEN`. **No secret, no account, no configuration** — the workflow file *is* the
setup.

### `refresh-live.yml` (every 6 hours)

```
1. Refresh NTES timetable delta          → trains.bin, connections.bin   [keyless]
2. Sweep live delays/cancellations        → live.json                     [keyless]
   across ~300 major junction station boards (2/4/8h windows only),
   capped at 12h believable delay
3. Bounded availability probe for the TOP ~200 corridors
                                          → availability-snapshot.json    [best effort]
4. Stamp every record with fetchedAt
5. Commit to the Pages branch (or upload-pages-artifact)
```

**Step 3 is deliberately bounded.** Probing the whole network is neither possible
(~millions of segments) nor polite. The top ~200 corridors by search volume cover a large
fraction of real queries. Everything else falls through to Tier 1.

The corridor list is *derived from our own usage*, not guessed: a privacy-preserving
counter (local `localStorage` tally, exported only if the user opts in) or simply a
hand-curated trunk-route list to start.

**Freshness is always visible.** `SNAPSHOT · 42m ago` — never presented as live.

### Live delay/cancellation data is a routing input, not a badge

A cancelled train must be **removed from the graph** for that date. A diverted train's
edges are **wrong** and must be invalidated. A 90-minute delay can **break a transfer**
that was legal at plan time. CSA absorbs all three by simple array mutation — this is one
of its documented advantages — and it is why Tier 2 matters beyond cosmetics.

```jsonc
// live.json
{ "updatedAt": 1783683912, "source": "ntes-station-boards", "ttlMinutes": 300,
  "trains": { "12951": {"d": 18},        // 18 min late
              "12009": {"c": 1},         // cancelled
              "12345": {"dv": 1, "via": ["ET","NGP"]} } }  // diverted
```

---

## 6. Tier 3 — client-side live probe (opt-in)

At search time, attempt a real fetch through a chain of keyless-friendly paths (public CORS
relays wrapping sources that render availability server-side).

**This tier is fragile by nature** and is designed to fail invisibly:

- **Off by default.** Behind an explicit toggle in Settings with a plain-language warning.
- **8-second timeout, one retry, then give up.** Never block the UI.
- **Labelled** `LIVE* · unofficial · may be wrong`.
- **Cached hard** in IndexedDB with in-flight request de-duplication (remedy exploration
  would otherwise issue hundreds of near-identical probes).
- **Relay chain with fallback**: try relay A, then B, then C, then Tier 2, then Tier 1.
- **Any error → `fallbackApplied: true`** and a Tier-1 answer. The user never sees a
  failure from this tier.
- **Rate-limited client-side** to a small number of probes per minute, out of respect for
  both the relay and the upstream.

Relays in this class (`corsproxy.io`, `api.allorigins.win`, self-hostable `cors-anywhere`)
come and go and are unsuitable as a *primary* dependency — which is exactly why they sit
at Tier 3 and not Tier 1.

⚠️ **ToS-grey.** Scraping a site that renders IRCTC data through a relay is legally and
ethically murky, may violate the upstream's terms, and may break at any time. It must be
opt-in, clearly labelled, and never presented as authoritative. If it feels wrong, ship
without it — Tiers 0/1/2/5 are a complete product.

---

## 7. Tier 4 — bring your own key (optional, never required)

A Settings panel where a power user pastes a key into `localStorage`:

```
┌─ Live availability (optional) ────────────────────────────────┐
│ RailRoam works fully without this. Adding a key upgrades      │
│ predictions to real 14-day availability.                      │
│                                                               │
│ Provider  ( ) none  ( ) RailRadar  ( ) RapidAPI  ( ) other    │
│ API key   [ ______________________ ]                          │
│                                                               │
│ Stored only in this browser. Never sent to us. Never committed│
│ to git. Delete any time.                                      │
│                                          [ Save ]  [ Remove ] │
└───────────────────────────────────────────────────────────────┘
```

- **Default: none.** The app is fully functional without it.
- Key lives in `localStorage` only, never leaves the browser except to the provider, never
  committed (`.gitignore` covers `secrets.json`, `.env`).
- RailRadar's free tier is **1,000 req/month** — the UI must show remaining budget and
  **hard-stop** probing when exhausted, falling back to Tier 1. A user who burns their
  quota in one discovery sweep has had a bad experience; ration it (e.g. spend key credits
  only on the *final* legs of the journeys the user actually opens, never during search).
- This satisfies *"use whatever you want"* without violating *"no inputs from me."*

---

## 8. Tier 5 — IRCTC deep link (always)

Every leg card, every remedy, every alternative carries a pre-filled IRCTC URL for that
exact `(train, from, to, date, class, quota)`.

```
[ Verify on IRCTC ↗ ]     → real availability, real fare, real booking
[ Live status on NTES ↗ ] → where is this train right now
```

This is the honest resolution of the whole problem:

- We do the **hard reasoning** the user cannot do by hand — network search, segment
  decomposition, seven remedy strategies, multi-criteria ranking, discovery.
- IRCTC provides the **authoritative facts** and the **transaction**.
- We stay inside GitHub Pages' no-e-commerce policy, handle no payments, store no PNRs,
  and never misrepresent a prediction as a reservation.

The handoff is the feature, not an admission of defeat.

---

## 9. Segment-awareness: why availability is not a property of a train

The most important domain fact in the entire project:

> IRCTC computes availability per **(train, boarding station, alighting station, date,
> class, quota)**. There is no "availability of train 12951".

One train, one day, simultaneously:

| Segment | Status | Mechanism |
|---|---|---|
| NDLS → BCT (full run, 1355 km) | `AVAILABLE-0042` | Origin→destination gets quota priority |
| NDLS → KOTA (short hop) | `REGRET` | No quota allotted to short segments |
| KOTA → BCT | `GNWL8/RAC4` | Different pool, different demand curve |

Three consequences that shape the architecture:

1. **The router must query per ride-segment**, never per train. `SegmentQuery` is the
   atomic unit throughout.
2. **Availability is a routing criterion**, not a post-filter. `worstLegConfidence` sits in
   the Pareto label vector, so the engine routes *around* waitlisted segments instead of
   merely reporting them.
3. **`LegSplitter` is the product.** The asymmetry above is a *feature to exploit*: if the
   full run is WL but the halves are clear, splitting converts an impossible journey into a
   bookable one. Conversely if the full run is clear and the halves are not, **never split**
   — take the direct ticket.

Batch queries accordingly: `availabilityBatch(segments[])` with memoisation on the
`(train, from, to, date, class, quota)` tuple. Exploring 7 remedies × ±2 dates × 6 classes
× 4 quotas on a 3-leg journey is naively ~1,000 queries; with memoisation and the fact that
remedies share most segments, it collapses to ~50–120.

---

## 10. Status-string parsing

```ts
const PATTERNS: [RegExp, (m: RegExpMatchArray) => AvailabilityResult][] = [
  [/^AVAILABLE[- ]?0*(\d+)$/i,   m => ({ verdict:'AVAILABLE',   seats:+m[1] })],
  [/^RAC\s*0*(\d+)/i,            m => ({ verdict:'RAC',   racPosition:+m[1] })],
  [/^(GNWL|WL|RLWL|PQWL|RSWL|CKWL|TQWL)\s*0*(\d+)\s*\/\s*RAC\s*0*(\d+)/i,
                                 m => ({ verdict:'WAITLISTED', wlPosition:+m[2],
                                         racPosition:+m[3], wlType:m[1] })],
  [/^(GNWL|WL|RLWL|PQWL|RSWL|CKWL|TQWL)\s*0*(\d+)/i,
                                 m => ({ verdict:'WAITLISTED', wlPosition:+m[2], wlType:m[1] })],
  [/^(REGRET|NOT\s*AVAILABLE|NO\s*SEATS)/i, () => ({ verdict:'REGRET' })],
  [/^(AVL|AVAILABLE)$/i,       () => ({ verdict:'AVAILABLE' })],
];
```

**Waitlist types matter** and must not be collapsed:

| Type | Meaning | Clearance behaviour |
|---|---|---|
| `GNWL` | General — most common | Best clearance odds |
| `RLWL` | Remote Location — intermediate stations | Poor clearance; quota is small |
| `PQWL` | Pooled — small intermediate segment | **Worst** clearance; frequently never clears |
| `RSWL` | Roadside | Small quota |
| `CKWL`/`TQWL` | Tatkal | Never clears (no cancellation cascade) |

A `PQWL 8` is materially worse than a `GNWL 8`, and the model must encode that. Naively
parsing every waitlist to a single integer is a common and serious bug.

---

## 11. Quota window arithmetic

The most commonly gotten-wrong detail in Indian rail software:

> **Tatkal opens one day before departure from the ORIGINATING station, not your boarding
> station.**

```ts
function tatkalOpensAt(train: Train, boardingStn: StationIdx, classCode: Class): Date {
  // Departure from ORIGIN, on the relevant operating day
  const originDep = originDepartureDateTime(train, boardingStn /* to resolve the run day */);
  const day       = subtractDays(originDep, 1);
  const hour      = isAC(classCode) ? 10 : 11;      // 1A is EXCLUDED from Tatkal
  return atHourIST(day, hour);
}

function generalBookingOpensAt(train: Train): Date {
  return atHourIST(subtractDays(originDepartureDate(train), train.arpDays), 8); // 08:00 IST
}
```

Worked example from the field: train **12927** departs **Dadar (origin) 23:50 on 24 Jan**;
a passenger boarding **Borivali at 00:26 on 25 Jan** gets Tatkal opening on **23 Jan** —
not 24 Jan. Getting this wrong tells users to wait a day for a window that already opened.

Also encode: ARP = **60 days** (some intercity day trains less); general quota opens
**08:00 IST**; IRCTC maintenance **23:45–00:20 IST**; Tatkal requires **Aadhaar OTP**;
max **4** passengers per Tatkal PNR vs **6** per general requisition; **1A excluded** from
Tatkal; no senior-citizen concession under Tatkal; Tatkal charge **10%** of basic fare
(2S) / **30%** (others) with min & max caps; **no refund** on confirmed Tatkal.

The UI turns this into something actionable:

```
⏱ Tatkal for 12951 (3A) opens in 6h 12m — 10:00 IST tomorrow.
  This train's Tatkal usually exhausts in under 4 minutes on this corridor.
  → [ Remind me ]   [ Meanwhile: 3 alternatives are already AVAILABLE ]
```

---

## 12. Worked example: the cascade in action

**Query:** Pune → Madgaon, Fri 18 Sep, SL, GN, 1 adult.

```
T4  no user key                                    → skip
T3  live probe disabled                            → skip
T2  PUNE–MAO not in the top-200 snapshot           → miss
T1  model inference:
      features: MEX train, 12 days out, Fri, SL, GN, segment = 84% of run,
                boarding index 4, corridor congestion 3 (low), capacity 864 SL berths,
                no festival within 10 days
      → pConfirm 0.38, expectedWl 23, interval [0.29, 0.47]
      → verdict WAITLISTED, confidence medium, source PREDICTED

    LegSplitter runs on this verdict:
      ① same-train split at RN (Ratnagiri, 15 min halt):
           PUNE→RN   model → pConfirm 0.94  (segment = 51% of run, high allotment)
           RN→MAO    model → pConfirm 0.97
           ⇒ combined 0.91   ▲ +0.53 confidence gain   ← BEST REMEDY
      ② date shift +1 day:  SL AVAILABLE-0112  ▲ +0.62 but changes travel date
      ③ quota shift → TQ:   window not open yet (opens 10:00 tomorrow)  ▲ deferred
      ④ class shift → 3A:   pConfirm 0.71  ▲ +0.33 but +₹580
      ⑥ terminal subst.:    PUNE has no alternatives; MAO ↔ VSG (Vasco) 30 km road bridge
      ⑦ intermodal:         Pune→Panaji bus ~9h ₹700–1,400, then Panaji→MAO rail AVAILABLE

    Ranked output: [①split at RN] [②shift date] [⑦bus bridge] [④3A] [③Tatkal later]

T5  IRCTC deep links emitted for the original segment AND every remedy segment
```

Note the sequence: the model *predicted* that splitting at Ratnagiri would work **before
any live query**, using the segment-length feature. That is Tier 1 doing real work — and
it is the behaviour the user described when they said *"if not available in single leg then
divide it into multiple legs."*

Because the split lands the traveller in Ratnagiri with a 6h20m dwell, the stopover logic
promotes Ratnagiri to a destination: POIs from the bundled index, weather from Open-Meteo,
a Wikipedia extract fetched lazily. A waitlist problem became a better trip.

---

## 13. Acceptance criteria for this subsystem

- [ ] Every availability figure in the UI carries a visible provenance badge
- [ ] No code path can render `PREDICTED` as if it were `REAL`
- [ ] App is fully functional with Tiers 0, 1, 5 only (network disabled except dataset)
- [ ] Tier-1 calibration report shows Brier score beating the class-only baseline by a
      stated margin, and the reliability curve is committed as a CI artifact
- [ ] Waitlist **types** (GNWL/RLWL/PQWL/RSWL/CKWL) are parsed and affect the prediction
- [ ] Tatkal window arithmetic passes the 12927 Dadar/Borivali worked example
- [ ] A cancelled train in `live.json` disappears from that date's results
- [ ] A diverted train's stale edges are invalidated, not silently used
- [ ] A 90-minute delay invalidates transfers that no longer connect
- [ ] Tier-3 failure produces a degraded valid answer, never a user-visible error
- [ ] Tier-4 key exhaustion hard-stops probing and falls back cleanly
- [ ] Every leg and every remedy has a working IRCTC deep link
- [ ] Same-train splits always display the halt duration and a berth-change warning

---

Next: [`04-routing-engine.md`](04-routing-engine.md)

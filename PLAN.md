# PLAN.md — RailRoam: an exploratory journey planner for Indian Railways

**Deliverable:** a free static web app on GitHub Pages that takes a start location and a
departure date (the only two mandatory inputs) and answers *"where could I go, would I
actually get a seat, and how would the journey break into legs?"*

**Hard constraints honoured:** ₹0 cost · no API keys · no accounts · no setup by you ·
no server-side runtime (GitHub Pages is static-only).

---

## Table of contents

1. [The honest starting point: what is and isn't possible](#1-the-honest-starting-point)
2. [Product definition](#2-product-definition)
3. [Architecture at a glance](#3-architecture-at-a-glance)
4. [Data strategy: four independent layers](#4-data-strategy-four-independent-layers)
5. [Seat availability: the five-tier cascade](#5-seat-availability-the-five-tier-cascade)
6. [The routing engine and leg-splitting](#6-the-routing-engine-and-leg-splitting)
7. [Discovery mode: "I have no destination"](#7-discovery-mode-i-have-no-destination)
8. [Zero-setup data pipeline on GitHub Actions](#8-zero-setup-data-pipeline-on-github-actions)
9. [Performance and size budget](#9-performance-and-size-budget)
10. [Delivery roadmap](#10-delivery-roadmap)
11. [What this plan deliberately does NOT do](#11-what-this-plan-deliberately-does-not-do)

---

## 1. The honest starting point

Before any design, four facts were verified today (2026-09-12). They shape everything.

### Fact 1 — GitHub Pages runs no code

It serves files. No Python, no Node, no database, no server-side scraping, no proxying.
Limits: published site ≤ 1 GB (recommended), source repo ≤ 1 GB (recommended),
**100 GB/month bandwidth (soft)**, individual files >100 MB rejected by Git,
>50 MB warned. Usage policy **prohibits commercial and e-commerce use**.

Consequence: everything the app knows at page-load must either (a) be bundled as static
files, or (b) be fetched from a third-party endpoint that sends
`Access-Control-Allow-Origin` permissively enough for a browser to read it.

### Fact 2 — There is no free, keyless seat-availability API. None.

This was checked exhaustively rather than assumed:

| Source | Availability? | Key needed? | Cost | Verdict |
|---|---|---|---|---|
| **IRCTC official API** | Yes | Enterprise agreement | Historically gated on ~₹5 crore turnover | Not available to individuals |
| **eRail.in API** | Yes | Email request | Free-ish | **Service suspended** |
| **IndianRailAPI.com** | Yes (`/v2/SeatAvailability/`) | Yes | Enterprise & Advanced plans only | Paid |
| **RapidAPI `irctc1`** | Yes (`checkSeatAvailability`) | Yes | Paid per call | Paid |
| **RailRadar.in** | Yes, 14-day rolling | Yes (self-service) | Free tier = **1,000 req/month** | Real, but the quota is ~50 searches worth. Unviable as a primary. |
| **parse.bot IRCTC** | Yes | Yes | 2 credits/call | Paid |
| **Apify IRCTC scraper** | Yes | Yes | **$25/month + usage** | Paid |
| **AOPAY** | Yes | IRCTC-authorised partner | Enterprise | Not available |
| **NTES** (official, `enquiry.indianrail.gov.in`) | **No** | **No key** | Free | Timetable + live status only. No availability. |

The structural reason: availability lives in IRCTC's **PRS** (Passenger Reservation
System). NTES is the separate **enquiry** system. CRIS has stated publicly that it does
not intend to open reservation APIs to developers. Every third party reselling
availability is scraping IRCTC behind a paywall.

**This is the single most important finding in the whole plan**, and it means:

> A purely static GitHub Pages site **cannot** display guaranteed-live IRCTC seat
> availability with zero user setup. Any plan that claims otherwise is wrong.

The correct response is not to give up — it is to build the five-tier cascade in
[§5](#5-seat-availability-the-five-tier-cascade), where the app is genuinely useful by
default, upgrades automatically when a better source is reachable, and always hands the
user a one-click deep link to IRCTC for ground truth.

### Fact 3 — The timetable, however, IS free and keyless

NTES (`enquiry.indianrail.gov.in`) is the official government enquiry service, requires
no key, and exposes train schedules, running days, live status, station boards, and
cancelled/rescheduled/diverted train lists. The Python package
[`ntes-client`](https://pypi.org/project/ntes-client/) (MIT) wraps it, and
[`railpull`](https://github.com/shwetankg07/railpull) (MIT) is a working polite crawler +
exporter built on it that produces exactly the tables we need:

| File | Grain | Key columns |
|---|---|---|
| `trains.csv` | one row per train | number, name, type, **`runs_days`**, source, destination, distance, stops |
| `stops.csv` | one row per stop | train, seq, station code + name, day offset, arrival, departure, halt |
| `stations.csv` | one row per station | code, name, lat, lon |
| `delays.json` | live snapshot | `{"12951": {"d": 18}, "12009": {"c": 1}}` — 18 min late / cancelled |

`runs_days` matters enormously: the widely-mirrored 2016 community datasets assume every
train runs daily, which is false. NTES returns the actual scheduled dates.

**Caveat:** `railpull` deliberately ships *tools, not data*, because bulk collection and
**redistribution** of NTES output may conflict with the operator's terms. The pipeline in
[§8](#8-zero-setup-data-pipeline-on-github-actions) is designed around this — see
[`docs/09-risks-legal.md`](docs/09-risks-legal.md).

### Fact 4 — Enrichment data is free, keyless, and CORS-friendly (verified live)

Two endpoints were called successfully during planning and returned real data today:

**Open-Meteo** — no key, no account, CORS enabled out of the box, ~10,000 calls/day,
16-day forecast, 80-year historical climate. Live response for Delhi:

```json
{"latitude":28.576448,"longitude":77.18678,"timezone":"Asia/Kolkata",
 "daily":{"time":["2026-09-12","2026-09-13","2026-09-14"],
          "temperature_2m_max":[31.8,32.3,30.3],
          "precipitation_probability_max":[75,84,95]}}
```

**Wikipedia REST** — no key, CORS enabled, returns summary, description, coordinates and
a licensed thumbnail. Live response for Jaipur:

```json
{"title":"Jaipur","wikibase_item":"Q66485","coordinates":{"lat":26.915,"lon":75.82},
 "description":"Capital of Rajasthan, India",
 "thumbnail":{"source":"https://thumb.wikimedia.org/.../East_facade_Hawa_Mahal_Jaipur...jpg"},
 "extract":"Jaipur is the capital and the largest city of the north-western Indian state
 of Rajasthan... also known as the Pink City..."}
```

Plus **Wikidata SPARQL** (keyless, CORS) for every tourist attraction / national park /
UNESCO site in India with coordinates, and **OSM Overpass** (keyless, CORS) for
`railway=station`, `tourism=*`, `historic=*`, `aeroway=aerodrome`.

That is a complete, free, keyless enrichment stack for the *"explore this place"* half of
the product.

### Fact 5 (bonus) — the booking rules changed recently

**Advance Reservation Period is now 60 days, not 120** (reduced 1 Nov 2024). General
quota opens **08:00 IST**; Tatkal opens **10:00 IST for AC** and **11:00 IST for non-AC**,
one day before departure *from the originating station* (not your boarding station —
a detail that breaks naive implementations). Tatkal now requires **Aadhaar OTP**.
IRCTC is down for maintenance **23:45–00:20 IST**. These go into the bundled rules file.

---

## 2. Product definition

### The one-sentence pitch

*"Tell me where you are and when you're free. I'll tell you everywhere you could go,
whether you'd get a seat, and exactly how to break the journey up if you wouldn't."*

### Two modes, one engine

**Mode A — Targeted.** User knows roughly what they want (a destination, a direction, a
trip length). Classic origin → destination planning, but with multi-leg intelligence and
availability-aware alternatives that IRCTC does not offer.

**Mode B — Exploratory (the headline feature).** User knows nothing but their start point
and free dates. The engine runs a **reverse reachability sweep**: one pass of the routing
algorithm produces earliest-arrival, cheapest and best-availability routes to *every
station in India* simultaneously. Filter that set to tourism-relevant stations, score by
season/weather/interest/budget/crowds, and present *"here are 8 journeys you could take
this week."*

Mode B is not a marketing wrapper on Mode A — it is a different query shape that the
chosen algorithm answers for free. See [§7](#7-discovery-mode-i-have-no-destination).

### Input contract

```
MANDATORY
  origin          : station code | station name | city | lat,lon  (fuzzy-matched)
  departDate      : ISO date, within the 60-day ARP window

OPTIONAL (each has a default; each is independently overridable)
  returnDate      : ISO date | null            default null → one-way
  roundTrip       : bool                       default inferred from returnDate
  destination     : station | city | region | null   default null → exploratory
  daysAtDestination : int | null               default null
  direction       : N|NE|E|SE|S|SW|W|NW | state | region | null
  maxTravelHours  : number                     default 24 one-way
  maxTransfers    : int                        default 2 (exploratory), 3 (targeted)
  budgetTotal     : ₹ | null                   default null
  classes         : [1A,2A,3A,3E,SL,CC,EC,2S]  default [3A,SL]
  quotas          : [GN,TQ,PT,LD,SS,...]       default [GN] + TQ if inside Tatkal window
  passengers      : {adults, children, seniors, femaleOnly}  default 1 adult
  avoidOvernight  : bool                       default false
  preferScenic    : bool                       default true in exploratory mode
  allowIntermodal : {bus:bool, flight:bool, road:bool}   default all true
  allowStopover   : bool                       default true  ← enables "explore en route"
  interestTags    : [beach, mountains, wildlife, temples, forts, food,
                     trekking, offbeat, spiritual, heritage, nightlife]  default broad mix
  dateFlexDays    : int                        default ±2
```

### The output contract — what a result actually looks like

This is the shape the user described, made concrete. Every journey is an **itinerary** of
**legs**, every leg carries its own availability verdict, and every gap carries a reason
and a suggestion:

```
JOURNEY #3 of 8 — "Konkan coast, the slow way"      score 87/100
Pune → Goa (Madgaon) · 2 legs · ₹1,240 est · 14h 05m · 1 overnight stopover suggested

  LEG 1 · TRAIN · 11099 LOKMANYA TILAK T - MADGAON EXPRESS
    Pune Jn (PUNE)  dep 20:10 Fri 18 Sep   ── 5h 55m ──▶  Madgaon (MAO)  arr 02:05 Sat
    Class SL  ·  GN quota  ·  ₹460
    ┌─ AVAILABILITY: WL 23  ·  confirmation probability 62%  ·  source: PREDICTED
    └─ ⚠ Not comfortable. Two fixes offered:
         ▸ FIX A — split this leg: PUNE→RATNAGIRI (AVAILABLE-0041) then
                   RATNAGIRI→MAO on the SAME train (AVAILABLE-0017).
                   Halt at Ratnagiri is 15 min — you will need to change berths.
                   Confidence rises to ~94%.  → [Apply fix]
         ▸ FIX B — shift date: on Sat 19 Sep the same train is AVAILABLE-0112 in SL.

  ◆ STOPOVER SUGGESTED · Ratnagiri · 6h 20m dwell (or overnight)
    Why here: splitting the leg puts you in Ratnagiri anyway, and it is a
    destination in its own right.
    Weather on arrival: 28°C, 80% chance of rain (monsoon — indoor plan advised)
    Nearby: Ratnadurg Fort (3.1 km) · Ganpatipule Temple (12 km) ·
            Thibaw Palace (2.4 km) · Bhatye Beach (6 km)
    Stay: 41 lodging options within 3 km of the station
    → "Explore Ratnagiri" (full POI list, photos, Wikipedia extract)

  LEG 2 · TRAIN · 10111 KONKAN KANYA EXPRESS
    Ratnagiri (RN)  dep 04:30 Sat 19 Sep   ── 3h 10m ──▶  Madgaon (MAO)  arr 07:40 Sat
    Class SL · GN quota · ₹290
    └─ AVAILABILITY: AVAILABLE-0112 · source: PREDICTED · high confidence
       ✦ Scenic: this is the Konkan Railway — 6h of coastal/ghat sections,
         ~2,000 bridges, 92 tunnels. Sit on the LEFT going south.

  ALTERNATIVE MODE OFFERED for LEG 1
    ▸ BUS · Pune → Panaji · ~9h · ₹700–1,400 · departs hourly, overnight services
      Rail is WL here but road is plentiful. Board bus, alight Panaji, then
      12635 POKARAN EXP Panaji→Madgaon has AVAILABLE-0205.
      → [See this variant]  ·  [Search on redBus ↗]

  ────────────────────────────────────────────────────────────
  Totals: ₹1,240 (rail) · 14h 05m moving · 2 tickets · 1 berth change
  Worst-leg confidence: 62% → 94% if you apply FIX A
  → [Verify all legs on IRCTC ↗]   [Export .ics]   [Share link]   [Save]
```

Note what is happening in that card, because it is the whole product:
availability is **per leg, not per train**; a bad leg triggers *ranked, explained
remedies* rather than a dead end; a forced transfer is **reframed as a stopover with
things to do**; and a rail failure spawns an **inter-modal variant**. All four behaviours
are things the user explicitly asked for.

---

## 3. Architecture at a glance

```
┌──────────────────────── BUILD TIME (GitHub Actions, free, keyless) ────────────────────────┐
│                                                                                            │
│  NTES (no key)          Overpass/OSM (no key)      Wikidata SPARQL (no key)                 │
│  timetable, runs_days,  railway=station coords,    tourist attractions,                     │
│  live delays, cancels   aeroway=aerodrome          national parks, UNESCO sites             │
│        │                        │                          │                               │
│        ▼                        ▼                          ▼                               │
│  ┌───────────────┐      ┌───────────────┐         ┌────────────────┐                       │
│  │ harvest-ttbl  │      │ harvest-geo   │         │ harvest-pois   │                       │
│  └───────┬───────┘      └───────┬───────┘         └───────┬────────┘                       │
│          └──────────────────────┼─────────────────────────┘                                │
│                                 ▼                                                          │
│                     ┌───────────────────────┐     ┌──────────────────────────┐             │
│                     │  build-dataset (ETL)  │────▶│ train-availability-model │             │
│                     │  normalise · shard ·  │     │ (trained offline on the   │             │
│                     │  compress · validate  │     │  Apache-2.0 IRCTC corpus) │             │
│                     └───────────┬───────────┘     └────────────┬─────────────┘             │
│                                ▼                              ▼                            │
│              stations.bin  connections.bin  trains.bin   availability-model.json           │
│              fares.json  festivals.json  holidays.json  airports.json  bus-corridors.json  │
└────────────────────────────────────────┬───────────────────────────────────────────────────┘
                                         │  actions/deploy-pages
                                         ▼
┌────────────────────────── GitHub Pages (static, ₹0) ───────────────────────────────────────┐
│                                                                                            │
│   index.html · app.js · styles.css · service-worker.js · /data/*.bin                       │
│                                                                                            │
│   ┌──────────────────────────────────────────────────────────────────────────────────┐    │
│   │  MAIN THREAD (UI)                    │  WEB WORKER (all heavy lifting)            │    │
│   │                                      │                                            │    │
│   │  React/Preact + TypeScript           │  ┌──────────────────────────────────────┐  │    │
│   │  · search form (2 mandatory fields)  │  │ DatasetLoader — typed-array views    │  │    │
│   │  · itinerary cards, map, POI panels  │◀─│ AvailabilityOracle — 5-tier cascade  │  │    │
│   │  · date-flex heatmap                 │  │ Router — multi-criteria CSA + Yen    │  │    │
│   │  · IndexedDB cache, service worker   │  │ LegSplitter — 7 remedy strategies    │  │    │
│   │  · i18n (en / hi / regional)         │  │ IntermodalBridge — bus/air/road      │  │    │
│   └──────────────────────────────────────┘  │ DiscoverySweep — reverse reachability│  │    │
│                                             │ FareEngine — IRCTC slab rules        │  │    │
│                                             └──────────────────────────────────────┘  │    │
│                                             └──────────────────────────────────────────┘    │
│                                                                                            │
└───────────────────────────────────────────┬────────────────────────────────────────────────┘
                                            │  RUNTIME, browser-direct, no key, CORS-enabled
             ┌──────────────────────────────┼──────────────────────────────┐
             ▼                              ▼                              ▼
   Open-Meteo (weather)          Wikipedia REST (place text       IRCTC deep links
   16-day forecast + climate      + photos, lazily fetched)       (verify & book ↗)
```

### Stack

| Concern | Choice | Why |
|---|---|---|
| Hosting | **GitHub Pages** + `actions/deploy-pages` | Free, no server, already where the repo lives |
| Build | **Vite** | Fast, zero-config, emits plain static assets |
| UI | **Preact + TypeScript** (React-compatible) | ~4 KB vs ~45 KB. Bundle size is the real constraint on Pages. |
| Heavy compute | **Web Worker** | A full-network CSA sweep touches ~290k connections. Must never block the UI. |
| Routing algorithm | **Connection Scan Algorithm (CSA)**, multi-criteria Pareto variant | Single linear scan over a sorted connection array; O(&#124;C&#124;) per query; cache-efficient; trivially supports transfers, profile queries and delay injection. Proven at scale — `trRouting` reports **~8 ms** for a two-way CSA on all Montreal transit. |
| Dataset format | **Hand-rolled `ArrayBuffer` + typed-array views** | `JSON.parse` of a 6 MB graph stalls a browser for seconds. Typed arrays parse in ~0 ms (no parse at all — just views). |
| Maps | **MapLibre GL** + free raster/vector basemap; **Leaflet** fallback | Both keyless. Route polylines from bundled simplified OSM track geometry. |
| Cache | **IndexedDB** + HTTP caching + **service worker** | Repeat visits load instantly; timetable works offline (PWA). |
| State | **Zustand** (or Preact signals) | Small, no boilerplate |
| Tests | **Vitest** (unit) + **Playwright** (E2E) + golden journey corpus | Regression-test real itineraries |
| CI | **GitHub Actions** | Free for public repos (2,000 min/month). Runs ETL, tests, deploy. No keys, no setup. |

Prior art worth reading before implementing: **MOTIS** (open-source intermodal routing
engine, does exactly this door-to-door multi-mode problem), **trRouting** (C++ CSA
reference), **OpenTripPlanner**, and the **Transitous** project. We are not using them
(they need servers), but their algorithm choices are the ones we copy.

Full detail: [`docs/01-architecture.md`](docs/01-architecture.md).

---

## 4. Data strategy: four independent layers

Each layer fails independently and the app degrades gracefully rather than breaking.

| Layer | Content | Source | Key? | Freshness | Fallback if missing |
|---|---|---|---|---|---|
| **L1 Network graph** | ~10k trains, ~8k stations, ~290k connections, `runs_days`, halts, distances, classes, coach composition | NTES via polite crawler (`ntes-client`/`railpull` pattern) | **No** | Weeks (Actions cron) | CC0 `datameet/railways` bootstrap (2016, less accurate but licence-clean) |
| **L2 Geo & places** | Station coordinates, POIs, destination descriptions + photos, airports | OSM Overpass, Wikidata SPARQL, Wikipedia REST | **No** | Months | Lazy runtime fetch; graceful "no photo" |
| **L3 Rules & context** | IRCTC fare slabs, quota rules, ARP/Tatkal timings, festival & holiday calendar, scenic-route list, terminal groups, min-transfer times per junction | Curated static JSON, hand-maintained + sourced from public rule documents | **No** | Quarterly | Hardcoded constants |
| **L4 Live signals** | Delays, cancellations, reschedules, diversions; weather; (optional) real availability | NTES snapshot via Actions; Open-Meteo at runtime | **No** | Hours / minutes | Hide live badges; show schedule-only |

**Nothing in any layer requires an API key.** That is the design invariant, and it is
what makes "no setup from you" true rather than aspirational.

Fare is **computed, not stored**. IRCTC fares are a deterministic function of
(distance slab × class × train type) + superfast surcharge + reservation charge +
GST + dynamic/flexi-fare multiplier for premium trains. Bundling a ~50 KB rules table
beats bundling millions of pair-wise fares, and stays correct when fares are revised.

Full source-by-source detail with verified endpoints and licences:
[`docs/02-data-sources.md`](docs/02-data-sources.md).

---

## 5. Seat availability: the five-tier cascade

Given Fact 2, this is the heart of the plan. The `AvailabilityOracle` tries tiers in
order and always returns an answer, always tagged with its provenance.

```
                  ┌──────────────────────────────────────────┐
   query ────────▶│ T4  user-supplied key present?           │──yes──▶ REAL 14-day
 (train,from,to,  └──────────────────┬───────────────────────┘         availability
  date,class,quota)                 │ no
                                    ▼
                  ┌──────────────────────────────────────────┐
                  │ T3  live probe enabled & source reachable?│──yes──▶ LIVE (unofficial)
                  └──────────────────┬───────────────────────┘         label + cache
                                    │ no
                                    ▼
                  ┌──────────────────────────────────────────┐
                  │ T2  fresh snapshot covers this corridor? │──yes──▶ SNAPSHOT
                  └──────────────────┬───────────────────────┘         + age badge
                                    │ no
                                    ▼
                  ┌──────────────────────────────────────────┐
                  │ T1  prediction model (always works)      │──▶ PREDICTED
                  └──────────────────┬───────────────────────┘    + confidence band
                                    │ needs capacity/quota context
                                    ▼
                  ┌──────────────────────────────────────────┐
                  │ T0  static quota & rake reference        │──▶ feeds T1
                  └──────────────────────────────────────────┘

   EVERY result also emits ──▶ T5  a pre-filled IRCTC deep link for ground truth
```

### Tier 0 — Quota & rake reference (static, always available)

Per train: classes offered, coach composition (how many SL / 3A / 2A / 1A berths exist —
the **denominator** for any availability claim), quota pools, whether it is a
premium/flexi-fare service, originating station. Sourced from NTES + publicly documented
coach-position data. Small (~300 KB).

### Tier 1 — Prediction model (static, always available) · **the default**

Predict **P(confirmation)** and **expected waitlist position** for
`(train, from, to, date, class, quota)`. This is the same class of model ConfirmTkt and
ixigo expose as "confirmation probability" — the difference is ours runs entirely in the
browser from a bundled coefficient table, with no server and no key.

**Feature set** (all computable from L1+L3, no live data needed):

| Feature group | Signals |
|---|---|
| Booking-window position | days until journey (0–60, ARP-limited); is booking even open yet; hours until Tatkal window opens |
| Calendar | day of week (Fri/Sun/Mon peaks); festival proximity from bundled `festivals.json` (Diwali, Chhath, Durga Puja, Eid, Holi, Christmas, New Year, Onam, Pongal, Baisakhi); school-vacation window (Apr–Jun, mid-Oct–Nov); gazetted holidays |
| Train | type (Vande Bharat / Rajdhani / Duronto / Shatabdi / Superfast / Mail-Express / Passenger); premium-flexi flag; total rake capacity in class; daily vs weekly vs biweekly |
| Segment | is this the full origin→destination run, or a short intermediate hop? distance as % of train's total; how many stations into the run is boarding; does the segment cross a quota-change station |
| Corridor | corridor congestion (count of trains serving this city pair); is it a trunk route (Delhi–Mumbai/Howrah/Chennai, Mumbai–Delhi) or a branch |
| Station rank | metro / major junction / intermediate / halt — demand strongly correlates with station rank |
| Class | SL and 3A carry the highest waitlisting; 1A/EC almost never WL; 2S unreserved-ish |
| Quota | GN vs TQ vs PT vs LD vs SS vs HP/DF — separate pools with very different dynamics |

**Model form:** gradient-boosted trees trained offline, then **distilled into a calibrated
logistic / piecewise-linear coefficient table shipped as JSON** (~50–150 KB). No ML runtime
in the browser, no WASM, inference is microseconds. Outputs a probability *and* an
interval, always rendered as "Predicted — verify on IRCTC".

**Training data:** the Kaggle *Indian Railways Schedule-Prices-Availability Data* corpus
(**Apache-2.0**, scraped from IRCTC Oct 2023, includes real availability strings and
prices — ideal and licence-clean for training). Augmented with published WL-clearance
heuristics. Retrained monthly by an Actions workflow.

### Tier 2 — Scheduled snapshot via GitHub Actions (zero setup, no key)

GitHub Actions is already free on this repo and needs no credentials beyond the default
`GITHUB_TOKEN`. A cron workflow every **6 hours** (budgeted — see the minutes arithmetic
in [`docs/05-data-pipeline.md`](docs/05-data-pipeline.md)):

- refreshes the NTES timetable and the live delay/cancellation snapshot (fully keyless);
- **optionally** polls availability for a **bounded list of the top ~200 corridors** —
  not the whole network, which is neither possible nor polite — and commits a small
  `availability-snapshot.json`;
- stamps every record with `fetchedAt` so the UI can show "live-ish · 42 min old".

This is the mechanism that delivers *fresh* data with **zero setup from you**: it lives in
the repo, runs on GitHub's machines, and needs no secrets.

### Tier 3 — Client-side live probe (opt-in, best-effort, degrades silently)

At search time, attempt a real fetch through a chain of keyless-friendly paths (public
CORS relays wrapping sources that render availability server-side). This is fragile,
rate-limited and ToS-grey, so it is:

- **off by default**, behind an explicit toggle;
- labelled "unofficial · may fail";
- cached hard in IndexedDB with request de-duplication;
- **auto-falling back to Tier 1 on any error** — a failed probe must never produce an
  error state the user sees.

### Tier 4 — Bring-your-own-key (optional upgrade, never required)

A settings panel where a power user pastes a RailRadar or RapidAPI key into
`localStorage`. Real 14-day availability then unlocks. **Default: empty.** The app is
fully functional without it. This satisfies *"use whatever you want"* without breaking
*"no inputs from me."* The key never leaves the browser and is never committed.

### Tier 5 — IRCTC deep link (always present)

Every leg card carries a pre-filled IRCTC search URL for that exact
train/from/to/date/class/quota. One click → ground truth → booking. This is the
compliant handoff: we plan, IRCTC books. It also keeps us inside GitHub Pages'
no-e-commerce policy.

**Provenance is never hidden.** Every availability figure in the UI carries a badge:
`LIVE` · `SNAPSHOT 42m` · `PREDICTED 62%±9%` · `YOUR KEY`. The app must never let a
prediction masquerade as a reservation.

Full detail: [`docs/03-availability.md`](docs/03-availability.md).

---

## 6. The routing engine and leg-splitting

### 6.1 Why CSA, not Dijkstra

A time-expanded Dijkstra over the Indian network is the textbook approach and the wrong
one here: the graph has ~290k connections and must be queried interactively, in a browser
worker, repeatedly (once per candidate date × class × quota × remedy).

**CSA (Connection Scan Algorithm)** — Dibbelt, Nierhoff, Strasser & Wagner — sorts every
connection (a ride between two consecutive stops on one train) by departure time into a
single array and scans it once per query. O(&#124;C&#124;), extremely cache-friendly,
natively supports transfers with minimum transfer time, natively supports **profile
queries** (all Pareto-optimal journeys across a departure-time interval — which is what
"show me options" means), and absorbs delay data by simple array mutation.

Reference performance: `trRouting` (C++) reports **~8 ms** for a two-way CSA across all
Montreal transit. Our network is larger but a browser worker doing ~50–200 ms for a
full-India sweep is entirely acceptable — and we precompute terminal-transfer footpaths.

### 6.2 Multi-criteria Pareto search

"Best" is not one-dimensional. Each station keeps a **Pareto frontier** of journey labels:

```
label = ( arrivalTime,        // earlier is better
          transfers,          // fewer is better
          totalFare,          // cheaper is better
          worstLegConfidence, // higher is better  ← availability enters HERE
          nightLegs,          // fewer is better
          fatigueScore )      // lower is better
```

A label is discarded if another dominates it on **all** criteria. Frontier size is capped
(per station, ~12) to bound memory. The top-K non-dominated labels at the destination
*are* the "here are 5 different ways to get there" list — no separate K-shortest-paths
pass needed, though **Yen's algorithm** is available for enumerating alternatives through
a forced waypoint (used by the stopover feature).

**Availability is a first-class routing criterion**, not a post-filter. This is what makes
the engine route *around* waitlisted legs rather than just reporting them.

### 6.3 The segment-awareness insight

The single most important domain fact:

> IRCTC availability is computed per **(train, boarding station, alighting station, date,
> class, quota)**. It is **not** a property of a train.

One train on one day can simultaneously be:

| Segment | Status | Why |
|---|---|---|
| NDLS → BCT (full run) | `AVAILABLE-0042` | Origin→destination pairs get quota priority |
| NDLS → KOTA (short hop) | `REGRET` | No quota allotted to short segments |
| KOTA → BCT | `GNWL8/RAC4` | Different pool, different demand |

So the router must issue an availability query **per candidate ride segment**, and the
`LegSplitter` exploits the resulting asymmetry. Every remedy below is ranked by
confidence-gain × cost and presented with a plain-language explanation.

### 6.4 The seven remedy strategies

When a segment comes back WL/REGRET, try in this order:

**① Same-train split.** If `A→C` is WL but the train stops at `B`, query `A→B` and `B→C`
independently. If both clear, split. Annotate with the **halt duration at B** — under
~10 minutes the berth change is rushed, and that risk must be surfaced, not hidden.
This directly implements the user's *"divide the journey into these many legs."*

**② Date shift.** Query `departDate ± dateFlexDays`. Render a **date-flex heatmap**: rows =
class, columns = dates, cell colour = availability. Frequently the single highest-value
remedy — shifting two days can turn WL 40 into AVAILABLE-0120. Cheap to compute because
Tier-1 predictions run for all dates in one pass.

**③ Quota shift.** `GN` → `TQ` (Tatkal; opens 10:00 AC / 11:00 non-AC, one day before
*origin* departure, Aadhaar OTP required) → `PT` (Premium Tatkal, dynamic fare) →
`LD` (Ladies) → `SS` (Senior) → `HP`/`DF`/`FT`. Show the Tatkal window countdown
("Tatkal for this train opens in 6h 12m").

**④ Class shift.** WL in 3A but AVAILABLE in 2A or SL. Always present the cheapest class
that clears, not just the requested one.

**⑤ Route substitution.** A different corridor entirely: Delhi→Goa direct is WL, but
Delhi→Pune (AVAILABLE) + Pune→Madgaon (AVAILABLE) works. CSA discovers these naturally
because it explores transfers — no special-casing.

**⑥ Terminal / station substitution.** Indian metros have multiple terminals, and users
rarely know this. Expand origin and destination into **terminal groups** joined by road
transfer edges:

| City | Terminals |
|---|---|
| Delhi | NDLS, NZM, DLI, ANVT, DEE, NNO |
| Mumbai | CSTM, BCT, LTT, DR, KYN, PNVL, BDTS |
| Kolkata | HWH, SDAH, KOAA |
| Chennai | MAS, MSB, TBM, MS |
| Bengaluru | SBC, YPR, BAND, SMVB, KSR |
| Hyderabad | SC, KCG, HYB, Secunderabad |

Plus a radius-based "nearby station" expansion (e.g. searching Goa should consider MAO,
VSG, THVM, KUDL).

**⑦ Inter-modal bridge.** When rail genuinely fails on a segment, insert a non-rail edge:

- **Bus** — a curated static `bus-corridors.json` for the top ~500 interstate city pairs
  (no free bus API exists; redBus has no public API). Candidate bridges are *derived
  automatically*: any pair where rail needs >X hours and >Y transfers but road distance is
  <Z km. Deep-link out to redBus/AbhiBus search URLs.
- **Flight** — bundled `airports.json` (~130 airports with IATA codes and coordinates,
  harvested keylessly from OSM/Wikidata) + great-circle distance and typical block time.
  Deep-link to Google Flights/Skyscanner.
- **Road/taxi** — haversine × road factor (~1.25 for India) ÷ ~50 km/h. Deep-link to
  Google Maps directions.

Every inter-modal edge carries `mode`, `estDuration`, `estCost`, `confidence: "estimate"`
and a `bookingUrl`. Estimates are labelled as estimates. This implements the user's
*"suggest to travel till here by a different mode of transport and from there you can
continue with this train."*

### 6.5 Stopovers as a feature, not a failure

The user explicitly asked for *"explore this place and then in these many hours the next
train has these many seats available so you can continue from there."* So the graph
supports **overnight / long-dwell transfer edges**, and a dwell of more than ~3 hours
promotes the intermediate station into a **destination in its own right**:

- POIs within N km (Wikidata/Overpass, bundled index)
- Wikipedia extract + photo (fetched lazily at runtime, keyless, cached)
- Weather for the dwell window (Open-Meteo, keyless)
- Lodging density estimate
- A "suggested dwell" duration matched to what there is to see

A forced transfer thereby becomes the most delightful part of the itinerary.

### 6.6 Constraints enforced

Minimum transfer time **per junction** (large stations need 20–30 min; cross-terminal
transfers need far more and get a road edge with its own cost), max transfers, max total
duration, `runs_days` bitmask check (a weekly train simply does not exist on other days),
60-day ARP window, Tatkal window arithmetic relative to *origin* departure,
no-backtracking penalty, arrival-time preferences (avoid 02:00–05:00 arrivals; prefer
daylight arrival in remote areas), and per-leg minimum-halt checks for same-train splits.

Full algorithmic spec with pseudocode and data structures:
[`docs/04-routing-engine.md`](docs/04-routing-engine.md).

---

## 7. Discovery mode: "I have no destination"

This is the differentiator, and the reason CSA was chosen.

### The trick: one sweep reaches everywhere

A normal search runs CSA origin → one destination. But CSA's scan naturally computes
**earliest arrival at every station simultaneously**. So a *single pass* over the
connection array, from the origin at the departure time, yields a complete reachability
table for all of India. No per-destination loop. Cost ≈ one normal query.

That table is then filtered and ranked.

### Pipeline

```
1. SWEEP        CSA from origin @ departDate, horizon = maxTravelHours
                → { station: [earliestArrival, cheapestFare, bestConfidence, legs] }
                ~8,000 stations, one pass

2. FILTER       keep only tourism-relevant stations, via a bundled
                station→POI index (nearest-station join against Wikidata/Overpass
                POIs, precomputed at build time)
                ~8,000 → ~600–1,200 candidate destinations

3. ENRICH       for each candidate (parallel, bounded, cached):
                  · Open-Meteo   → weather at arrival + seasonal fit
                  · Wikipedia    → description + photo (lazy, IndexedDB-cached)
                  · POI index    → what is there, how many days it justifies
                  · fare engine  → round-trip cost estimate

4. SCORE        weighted composite, weights user-adjustable via sliders:
                  availabilityScore   0.25   ← can you actually get a seat?
                  seasonFit           0.20   ← monsoon in the Konkan, heat in
                                                Rajasthan in May, snow in the
                                                Himalayas in Dec
                  interestMatch       0.20   ← user tags, or a broad default mix
                  journeyQuality      0.15   ← scenic bonus (Konkan, Nilgiri MG,
                                                Kangra Valley, Darjeeling Himalayan,
                                                Kalka–Shimla, Matheran)
                  budgetFit           0.10
                  durationFit         0.05   ← matches "days I want to be there"
                  novelty             0.05   ← de-boost over-touristed if "offbeat"

5. DIVERSIFY    max-per-region cap so the 8 cards aren't all in Rajasthan;
                MMR (maximal marginal relevance) to avoid near-duplicate suggestions

6. PRESENT      "8 journeys you could take this week", each a full multi-leg
                itinerary in the §2 output format, each with its own availability
                verdict per leg and its own remedies
```

### Handling the optional inputs

- **Round trip** — not two independent one-ways. Availability is asymmetric (Fri
  Delhi→Goa may be WL while Sun Goa→Delhi is fine, and the *outbound* remedy may differ
  from the *return* remedy). Outbound and return are **jointly optimised** under a shared
  transfer/time budget. Open-jaw returns (come back from a different nearby city) are
  offered when they help.
- **Direction preference** — compass sector, state, or region filter, applied as a
  destination filter plus a scoring bias. Also supports negative framing: *"away from the
  monsoon"* uses Open-Meteo precipitation to exclude wet regions, which is a genuinely
  useful September feature.
- **Days at destination** — feeds `durationFit` and the POI count heuristic ("Jaipur
  justifies 3 days, Ratnagiri justifies 1").
- **Holiday awareness** — bundled Indian public-holiday calendar (national + state
  gazetted) plus school-vacation windows. Used three ways: warn about crowd/WL spikes,
  compute how many days the user actually has, and suggest *"shift by 2 days and
  availability is far better."*

### The honest hard case: the Northeast

Rail connectivity to the Northeast is genuinely thin (Guwahati and Siliguri/New Jalpaiguri
are the practical gateways; many states have limited or no broad-gauge reach). Discovery
mode must not pretend otherwise. It surfaces the gateway + an inter-modal bridge, and
labels rail-only reachability accurately. Same for Ladakh (no rail), Andaman/Lakshadweep
(no rail at all — air/sea only, shown as such).

Full detail: [`docs/06-discovery.md`](docs/06-discovery.md).

---

## 8. Zero-setup data pipeline on GitHub Actions

Everything runs on GitHub's infrastructure using the default `GITHUB_TOKEN`. You never
create an account anywhere, never generate a key, never run a script.

| Workflow | Trigger | Does | Keyless? |
|---|---|---|---|
| `harvest-timetable.yml` | **monthly** cron + manual | Polite NTES crawl → `trains`, `stops`, `stations` | ✅ |
| `harvest-geo.yml` | monthly cron | Overpass → station coords, airports | ✅ |
| `harvest-pois.yml` | monthly cron | Wikidata SPARQL + Overpass → station→POI index | ✅ |
| `train-availability-model.yml` | monthly cron | Retrain Tier-1, emit coefficient JSON | ✅ |
| `build-dataset.yml` | on any data change | Normalise → shard → compress → validate → emit | ✅ |
| `refresh-live.yml` | every 6 h | NTES delays/cancellations snapshot for major junctions | ✅ |
| `ci.yml` | every push / PR | Lint, typecheck, unit, E2E, bundle-size gate | ✅ |
| `deploy.yml` | push to `main` | `actions/deploy-pages` | ✅ |

**Minutes budget:** the free tier is 2,000 min/month and this plan uses **~1,735** (13%
headroom). Matrix shards each bill separately, and the 6-hourly live sweep alone is 69% of
the total — going to a 4-hourly sweep would *exceed* the free tier. The full arithmetic and
the levers for trimming it are in
[`docs/05-data-pipeline.md` §1](docs/05-data-pipeline.md#actions-minutes-budget--this-is-tight-so-it-is-computed-explicitly).

**Crawl discipline** (non-negotiable — this is a government service accessed through an
unofficial client, and `railpull`'s field notes are hard-won):

- ~1 request / 1.2 s with jitter and exponential backoff; never lower the pause
- mandatory **read timeouts** — the enquiry server sometimes accepts a connection then
  goes silent forever; one dead read otherwise hangs the entire crawl
- resumable checkpointing to `crawl-status.json`; re-runs skip files already on disk
- NTES has no "list all trains" endpoint → discover by **number prefix** (`000`…`999`),
  drilling one digit deeper whenever a prefix returns the 60-result cap
- search rejects queries shorter than 3 characters
- station boards only accept look-ahead windows of **2, 4 or 8 hours** — other values error
- treat a semantic "no" (bad query, discontinued train) as fail-fast, **not** as a network
  error; only back off on real network trouble
- cap believable delays at 12 h — boards occasionally report a long-gone service as
  "57:18 late"
- shard the full crawl across a **matrix of prefix ranges** so no single Actions job hits
  the 6-hour limit; persist `data/raw` in `actions/cache` so it resumes across runs

**Type codes are NTES's, not the old community ones**: `SUF` (superfast, *not* `SF`),
`VNDB`/`VNDM`/`VNDS` (Vande Bharat), `DRNT` (Duronto), `GBR` (Garib Rath), `MEX`
(Mail/Express), `SUB` (suburban). Miscategorise these and the "superfast" bucket comes out
empty.

**Station codes changed** — Mughal Sarai is now **DDU**, Allahabad is **Prayagraj**. Fresh
crawls use current codes; a rename map is needed when merging with older data.

**Redistribution caution:** `railpull` ships tools rather than data precisely because bulk
redistribution of NTES output may conflict with the operator's terms. Mitigation: the raw
corpus is generated into an **Actions artifact / orphan `gh-pages` branch**, not committed
to `main`; the CC0 `datameet/railways` dataset serves as the licence-clean bootstrap; and
attribution plus an unofficial-project disclaimer are prominent. Detailed in
[`docs/09-risks-legal.md`](docs/09-risks-legal.md).

Full pipeline spec: [`docs/05-data-pipeline.md`](docs/05-data-pipeline.md).

---

## 9. Performance and size budget

The binding constraint on GitHub Pages is **bytes shipped to the browser**, not compute.

| Asset | Records | Raw | Served (brotli/gzip) | When loaded |
|---|---|---|---|---|
| `stations.bin` | ~8,000 | ~500 KB | **~120 KB** | immediately (autocomplete) |
| `connections.bin` | ~290,000 | ~5.5 MB | **~1.8 MB** | on first search (progress UI) |
| `trains.bin` | ~10,000 | ~900 KB | **~300 KB** | with connections |
| `fares.json` | slab rules | ~50 KB | ~15 KB | immediately |
| `festivals.json` + `holidays.json` | ~5 yrs | ~80 KB | ~20 KB | immediately |
| `airports.json` + `bus-corridors.json` | ~130 + ~500 | ~250 KB | ~60 KB | lazily, if inter-modal allowed |
| `pois.bin` | ~10,000 | ~1.5 MB | **~350 KB** | discovery mode only |
| availability-model.json | coefficients | ~150 KB | ~40 KB | with connections |
| **First meaningful paint** | | | **< 200 KB** | |
| **Full targeted search** | | | **~2.3 MB** | |
| **Full discovery mode** | | | **~2.7 MB** | |

Comfortably inside the 1 GB site limit; 100 GB/month bandwidth supports ~37,000 full
discovery-mode sessions/month, far more for typical use. Service worker + IndexedDB make
repeat visits near-zero-cost, and the timetable graph works **fully offline**.

Techniques that make this work: typed-array binary containers (zero parse time, versus
seconds for `JSON.parse` of 6 MB); region sharding of the POI and track-geometry data;
aggressive Douglas-Peucker simplification of OSM rail geometry (draw straight lines
between stops by default, real track geometry only when zoomed in or on scenic routes);
lazy runtime fetching of Wikipedia text/photos instead of bundling them; and a hard
bundle-size gate in CI that fails the build if the JS bundle regresses.

Detail: [`docs/01-architecture.md`](docs/01-architecture.md).

---

## 10. Delivery roadmap

Nine phases. Each ships something demonstrable; none depends on a paid service or a key.

| # | Phase | Delivers | Depends on | Est. |
|---|---|---|---|---|
| 0 | **Foundations** | Vite+Preact+TS scaffold, CI, Pages deploy, design system, a11y baseline | — | 3–5 d |
| 1 | **Data pipeline v1** | CC0 bootstrap + NTES harvester in Actions; station autocomplete; train lookup | 0 | 7–10 d |
| 2 | **Routing engine v1** | Single-criterion CSA with transfers; trains-between-stations; multi-leg journeys; map | 1 | 10–14 d |
| 3 | **Availability v1** | Tier 0 + Tier 1 model; date-flex heatmap; quota/class cascade; provenance badges | 2 | 10–14 d |
| 4 | **Leg-splitting intelligence** | All 7 remedies; explained splits; halt-time risk warnings; terminal substitution | 3 | 10–14 d |
| 5 | **Inter-modal bridging** | Bus/air/road edges; auto-derived bridge candidates; deep links | 4 | 7–10 d |
| 6 | **Discovery mode** | Reverse reachability sweep; POI/weather/festival scoring; destination cards | 4 | 12–16 d |
| 7 | **Round trip + stopovers** | Joint round-trip optimisation; open-jaw; dwell-as-destination; .ics/PDF/share-link export | 6 | 8–12 d |
| 8 | **Live + polish** | NTES delay/cancellation snapshot; PWA/offline; i18n (en/hi + regional); perf pass | 2 | 8–12 d |
| 9 | **Optional upgrades** | Tier 3 live probe; Tier 4 BYO-key; analytics-free usage insights | 3 | 5–8 d |

**Critical path to a genuinely useful app: Phases 0 → 4** (~40–57 days). Discovery mode
(Phase 6) is the differentiator and should start as soon as Phase 4 lands.

Suggested **MVP cut** if time is short: Phases 0–4 give targeted multi-leg planning with
predicted availability and all seven remedies — already more capable than IRCTC for
planning. Discovery mode is the follow-up that makes it unique.

Full phase detail with acceptance criteria and test plans:
[`docs/08-roadmap.md`](docs/08-roadmap.md).

---

## 11. What this plan deliberately does NOT do

Being explicit about the boundaries is part of the plan's honesty.

- **No booking, no payments, no PNR storage.** GitHub Pages' usage policy prohibits
  e-commerce, and it would be irresponsible anyway. We deep-link to IRCTC.
- **No guaranteed-live availability by default.** Fact 2 makes that impossible without a
  key. Predictions are always labelled as predictions.
- **No login, no accounts, no analytics, no tracking.** All state is `localStorage` /
  IndexedDB in the user's own browser. This is a privacy feature, not a limitation.
- **No commercial use.** Open-Meteo's free tier is non-commercial; GitHub Pages prohibits
  commercial hosting. If this ever monetises, both need revisiting (Open-Meteo is $29/mo).
- **No hammering of government servers.** Rate limits, caching and resumability are
  design requirements, not afterthoughts.
- **No pretending the Northeast/Ladakh/islands are rail-reachable when they aren't.**
  Inter-modal honesty over optimistic fiction.

### The one caveat worth repeating

**Same-train, two-ticket segment splitting is a real and widely practised strategy, but it
sits in a regulatory grey area.** IRCTC's rules contemplate one ticket per journey; holding
two tickets for consecutive segments of the same physical train is commonly done and
generally tolerated, but it may require changing berths mid-journey and could in principle
be challenged by ticket-checking staff. The app must **disclose this clearly** on every
split it suggests ("you will need to change berths at Ratnagiri; halt is 15 min; this uses
two separate tickets — verify with IRCTC") and never present it as risk-free. See
[`docs/09-risks-legal.md`](docs/09-risks-legal.md).

---

## Where to go next

Read [`docs/01-architecture.md`](docs/01-architecture.md) for the system design, then
[`docs/03-availability.md`](docs/03-availability.md) and
[`docs/04-routing-engine.md`](docs/04-routing-engine.md) — those two carry the technical
risk. [`docs/08-roadmap.md`](docs/08-roadmap.md) turns all of it into a sequenced build.

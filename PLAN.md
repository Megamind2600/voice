# PLAN.md — Kahan Chalein?

**An exploratory journey planner for Indian Railways.** Free, static (GitHub Pages), no API
keys, no accounts, no setup.

Takes **two mandatory inputs** — start location and departure date — and answers: *"where
could I go, would I actually get a seat, and how does the journey break into legs if I
wouldn't?"*

> **Status: plan only. Nothing implemented.** · Research verified 2026-09-12.

**Budget:** ~**252 GitHub Actions minutes/month** amortized (worst month ~465, i.e. 23% of
the 2,000 free allowance). See [§8](#8-github-actions-budget).

---

## Contents

1. [The five facts that shape everything](#1-the-five-facts) · 2. [Product](#2-product) ·
3. [Input/output contract](#3-contract) · 4. [Architecture](#4-architecture) ·
5. [Availability: 5-tier cascade](#5-availability) · 6. [Routing and the 7 remedies](#6-routing) ·
7. [Discovery mode](#7-discovery) · **8. [Actions budget](#8-github-actions-budget)** ·
9. [Size budget](#9-size-budget) · 10. [Scope: in / cut](#10-scope) · 11. [Roadmap](#11-roadmap)

---

## 1. The five facts

Verified during planning, not assumed. Each one changes the design.

### ① GitHub Pages runs no code

Serves files only. No backend, no DB, no server-side scraping, no proxy. Limits: site ≤1 GB,
repo ≤1 GB recommended, **100 GB/month bandwidth (soft)**, files >100 MB rejected by Git,
**no commercial/e-commerce use**.

→ Everything the app knows at load time is either bundled static data, or fetched from an
endpoint permissive enough for a browser to read cross-origin.

### ② There is no free keyless seat-availability API. None.

| Source | Key? | Cost | Verdict |
|---|---|---|---|
| IRCTC official API | Enterprise agreement | ~₹5 cr turnover gate historically | Unavailable to individuals |
| eRail.in API | Email request | — | **Suspended** |
| IndianRailAPI | Yes | Enterprise/Advanced plans | Paid |
| RapidAPI `irctc1` | Yes | Per call | Paid |
| **RailRadar** | Yes (self-serve) | Free = **1,000 req/month** | Real, but ≈50 searches. Unviable as primary |
| parse.bot / Apify | Yes | Credits / $25+mo | Paid |
| **NTES** (official) | **No key** | Free | Timetable + live status. **No availability** |

Structural reason: availability lives in IRCTC's **PRS**; NTES is the separate **enquiry**
system. CRIS has said publicly it does not intend to open reservation APIs.

> **A static GitHub Pages site cannot show guaranteed-live IRCTC availability with zero
> setup.** Any plan claiming otherwise is wrong. [§5](#5-availability) is the design around
> that fact.

### ③ The timetable IS free and keyless

NTES (`enquiry.indianrail.gov.in`) needs no key and gives schedules, **`runs_days`**, live
status, station boards, and cancelled/rescheduled/diverted lists. Wrapped by
[`ntes-client`](https://pypi.org/project/ntes-client/) (MIT);
[`railpull`](https://github.com/shwetankg07/railpull) (MIT) is a working polite crawler.

`runs_days` is the column you can't get elsewhere: the widely-mirrored 2016 community
datasets assume **every train runs daily**, which is false and produces confidently wrong
plans.

### ④ Enrichment is free, keyless, CORS-friendly — called live during planning

**Open-Meteo** (no key, CORS on, ~10k calls/day) returned real Delhi data:
```json
{"daily":{"time":["2026-09-12","2026-09-13","2026-09-14"],
          "temperature_2m_max":[31.8,32.3,30.3],
          "precipitation_probability_max":[75,84,95]}}
```
**Wikipedia REST** (no key, CORS on) returned Jaipur's description, coordinates, extract
and a licensed thumbnail. Plus **Wikidata SPARQL** (CC0 POIs) and **OSM Overpass**
(stations, airports, rail geometry).

→ A complete free stack for the *"explore this place"* half of the product.

### ⑤ Booking rules changed recently

**ARP is now 60 days, not 120** (reduced 1 Nov 2024). General quota opens **08:00 IST**.
Tatkal: **10:00 AC / 11:00 non-AC**, one day before departure from the **originating**
station — *not* your boarding station (the most commonly botched detail in Indian rail
software). Tatkal needs **Aadhaar OTP**; `1A` is excluded. IRCTC down 23:45–00:20 IST.

---

## 2. Product

**Pitch:** *"Tell me where you are and when you're free. I'll tell you everywhere you could
go, whether you'd get a seat, and exactly how to break the journey up if you wouldn't."*

**Two modes, one engine.**

| | Mode A — Targeted | Mode B — Exploratory (headline) |
|---|---|---|
| User knows | roughly what they want | nothing but start + free dates |
| Query | origin → destination | **reverse reachability sweep** |
| Output | ranked multi-leg journeys with remedies | *"8 journeys you could take this week"* |

Mode B is not a wrapper on Mode A. CSA computes earliest-arrival at **every** station in one
scan, so whole-India reachability costs the same as one query. See [§7](#7-discovery).

**What existing tools don't do.** IRCTC, ConfirmTkt, ixigo, RailYatri all require you to
already know your destination. They are booking tools. This is a discovery tool that happens
to know about trains — and none of them do leg-splitting intelligence at all.

---

## 3. Contract

### Inputs — two mandatory, everything else defaulted and overridable

```
MANDATORY   origin      station code | name | city | lat,lon (fuzzy, multilingual)
            departDate  ISO date, within the 60-day ARP

OPTIONAL    returnDate (null → one-way is a complete answer) · roundTrip
            destination (null → exploratory) · daysAtDestination
            direction (N/NE/E/SE/S/SW/W/NW | state | region | "away from monsoon")
            maxTravelHours 24 · maxTransfers 2 · budgetTotal
            classes [3A,SL] · quotas [GN]+TQ if in window
            passengers {adults,children,seniors,femaleOnly}
            avoidOvernight · preferScenic · allowStopover
            allowIntermodal {bus,flight,road} · interestTags · dateFlexDays ±2
```

### Output — the shape that matters

Every journey is legs; **every leg carries its own availability verdict**; every gap carries
a reason and ranked fixes.

```
JOURNEY #3 of 8 — "Konkan coast, the slow way"        score 87/100
Pune → Madgaon · 2 legs · ₹1,240 est · 14h 05m · 1 stopover suggested

 LEG 1 · 🚆 11099 LTT–MADGAON EXPRESS
   Pune Jn  dep 20:10 Fri 18 Sep ── 5h 55m ──▶ Madgaon  arr 02:05 Sat
   SL · GN · ₹460
   ├ AVAILABILITY: WL 23 · 62% likely to confirm (±9%)      [PREDICTED]
   └ ⚠ Not comfortable. Fixes, best first:
       ▸ A SPLIT THIS LEG: PUNE→RATNAGIRI AVAILABLE-0041, then RATNAGIRI→MAO
         on the SAME train AVAILABLE-0017. Halt 15 min — you will change berths.
         Two separate tickets; grey area under IRCTC rules.  Confidence → 94%
       ▸ B SHIFT DATE: Sat 19 Sep, same train, SL AVAILABLE-0112
       ▸ C BUS BRIDGE: Pune→Panaji ~9h ₹700–1,400 (est), then rail AVAILABLE-0205

 ◆ STOPOVER · Ratnagiri · 6h 20m dwell — worth it, you're here anyway
   ☔ 28°C, 80% rain (monsoon — plan indoor)
   📍 Ratnadurg Fort 3.1 km · Thibaw Palace 2.4 km · Ganpatipule 12 km
   🛏 41 lodgings within 3 km        [Explore Ratnagiri →]

 LEG 2 · 🚆 10111 KONKAN KANYA EXPRESS
   Ratnagiri dep 04:30 Sat ── 3h 10m ──▶ Madgaon arr 07:40
   SL · GN · ₹290 · AVAILABLE-0112                          [PREDICTED]
   ✦ Konkan Railway — 92 tunnels, ~2,000 bridges. Sit LEFT going south.

 Totals ₹1,240 · 14h 05m moving · 2 tickets · 1 berth change
 Worst leg 62% → 94% if you apply FIX A
 [Verify all legs on IRCTC ↗]  [.ics]  [Share]  [Save]
```

Four behaviours in that card are the whole product: availability is **per leg, not per
train**; a bad leg yields **ranked, explained remedies** rather than a dead end; a forced
transfer is **reframed as a stopover with things to do**; a rail failure spawns an
**inter-modal variant**. All four were explicitly requested.

---

## 4. Architecture

```
┌── BUILD TIME · GitHub Actions · keyless · ~252 min/month ──────────────────────┐
│  NTES ──────────▶ harvest (quarterly full / monthly delta)                     │
│  Overpass ──────▶ geo: station coords, airports        } chained,              │
│  Wikidata SPARQL▶ pois: station→attraction index       } no separate           │
│  Kaggle corpus ─▶ train-availability-model             } schedules             │
│                            │                                                   │
│                            ▼  normalise · pack · validate (gates the deploy)   │
│     stations.bin  connections.bin  trains.bin  model.json  fares/festivals.json │
└────────────────────────────┬───────────────────────────────────────────────────┘
                             │ actions/deploy-pages
                             ▼
┌── GitHub Pages · static · ₹0 ─────────────────────────────────────────────────┐
│  MAIN THREAD (UI)                │  WEB WORKER (all heavy lifting)            │
│  Preact + TypeScript             │  BinaryLoader   typed-array views          │
│  · 2-field search + refine       │  Router         multi-criteria CSA + Yen   │
│  · itinerary cards, map          │◀▶AvailabilityOracle  5-tier cascade        │
│  · date-flex heatmap             │  LegSplitter    7 ranked remedies          │
│  · Leaflet route map             │  Intermodal     bus/air/road bridges       │
│  · IndexedDB + service worker    │  DiscoverySweep reverse reachability       │
│  · i18n (en, hi)                 │  FareEngine     IRCTC slab rules           │
└──────────────────────────────────┴────────────────────────────────────────────┘
                             │
     RUNTIME · browser-direct · no key · zero Actions minutes
     ├─ Open-Meteo      weather (batched, cached 6 h)
     ├─ Wikipedia REST  place text + photo (lazy, on card expand)
     ├─ NTES live       delays/cancellations — on demand, opt-in relay  ★NEW
     └─ IRCTC           deep links: verify + book
```

★ The live-data path is the big change from the previous draft — see [§8](#8-github-actions-budget).

### Stack

| Concern | Choice | Why |
|---|---|---|
| Hosting / CI | GitHub Pages + Actions | Free; already where the repo lives |
| Build | Vite | Fast, zero-config, static output, first-class worker support |
| UI | **Preact** (~4 KB) | Bundle bytes are the binding Pages constraint. React-compatible API |
| Heavy compute | **Web Worker** | A full-network sweep touches ~290k connections; must never block UI |
| Routing | **CSA** (Connection Scan Algorithm) | One linear scan, O(&#124;C&#124;), cache-friendly, native profile queries and Pareto variant, absorbs delays by array mutation. `trRouting` reports **~8 ms** for all Montreal transit |
| Data format | **Hand-rolled `ArrayBuffer`**, SoA | `JSON.parse` of 5.5 MB stalls a browser for seconds; typed arrays parse in ~0 ms |
| Maps | **Leaflet** + OSM raster tiles | Keyless, ~40 KB, no vector-tile pipeline. (MapLibre deferred — see [§10](#10-scope)) |
| Cache | IndexedDB + service worker | Megabyte buffers; localStorage is too small and synchronous |
| State | Zustand | Small, no boilerplate |
| Tests | Vitest + Playwright + **golden journey corpus** | The corpus encodes domain knowledge no unit test catches |

Prior art to read, not to use (all need servers): **MOTIS**, **trRouting**,
**OpenTripPlanner**, **Transitous**.

Detail: [`docs/03-architecture-and-build.md`](docs/03-architecture-and-build.md).

---

## 5. Availability

Given Fact ②, the `AvailabilityOracle` cascades and **always returns an answer tagged with
provenance**.

| Tier | What | Key? | Actions cost | Always works? |
|---|---|---|---|---|
| **T0** | Static quota + rake reference (coach counts, berths/class, quota pools) — the *denominator* for any availability claim | No | 0 | ✅ |
| **T1** | **Prediction model** → `P(confirm)`, `E[WL]`, interval. GBM trained offline, distilled to a ~40 KB coefficient table; inference in-browser, no ML runtime | No | ~5 min/quarter | ✅ **default** |
| **T2** | ~~Scheduled corridor snapshots~~ | — | — | **CUT** — no keyless source made this real; it was aspirational |
| **T3** | Opt-in client-side live probe via CORS relay chain. Off by default, 8 s timeout, silent fallback, `LIVE*` label | No | **0** | best-effort |
| **T4** | Optional bring-your-own-key (RailRadar etc.) in `localStorage`. **Default: empty** | User's | 0 | optional |
| **T5** | **IRCTC deep link on every leg and every remedy** — ground truth + booking | No | 0 | ✅ always |

**T1 features** (all from static data, no live input): days-to-journey · day-of-week ·
festival proximity & direction · school-vacation window · train type & flexi flag · class &
quota · corridor congestion · station rank · **and crucially the segment features** —
is this the full origin→destination run or a short hop, distance as % of run, boarding
index. The segment group is what lets the model *predict that splitting at Ratnagiri will
work before issuing any query*.

**Training data:** Kaggle *Indian Railways Schedule-Prices-Availability* (**Apache-2.0**,
IRCTC scrape Oct 2023 — real availability strings + fares). Stale, so the output is a
**probability band, never a seat count**, with isotonic calibration and per-corridor error
gates in CI.

**The rule that cannot be broken:** no code path may render `PREDICTED` without its badge.
Enforced by a lint rule *and* a component test. A prediction that looks like a reservation
strands someone at a platform at 2 a.m.

Detail: [`docs/01-data-and-availability.md`](docs/01-data-and-availability.md).

---

## 6. Routing

### The insight everything rests on

> IRCTC availability is per **(train, boarding stn, alighting stn, date, class, quota)**.
> There is no "availability of train 12951".

One train, one day, simultaneously:

| Segment | Status | Why |
|---|---|---|
| NDLS→BCT (full run, 1355 km) | `AVAILABLE-0042` | Origin→destination gets quota priority |
| NDLS→KOTA (short hop) | `REGRET` | No quota allotted to short segments |
| KOTA→BCT | `GNWL8/RAC4` | Different pool, different demand |

So the router queries **per ride-segment**, and `worstLegConfidence` is a first-class
**Pareto criterion** — the engine routes *around* waitlisted legs instead of finding the
fastest journey then apologising.

### Pareto criteria

```
( arrival ↓ , transfers ↓ , fare ↓ , worstLegConfidence ↑ , nightLegs ↓ , fatigue ↓ )
```
Dominance pruning, frontier capped ~12/station. The top-K non-dominated labels at the
destination *are* the results list.

### The 7 remedies (ranked by confidence-gain × inverse cost, each explained)

| # | Remedy | Note |
|---|---|---|
| ① | **Same-train split** | Exploits segment asymmetry. Split points chosen by junction rank + halt ≥10 min + model-predicted segment confidence, capped at 5. **Mandatory disclosure**: halt time, berth change, two tickets, grey area |
| ② | **Date shift** | ±2 days → date-flex heatmap. Often the single highest-value fix |
| ③ | **Quota shift** | GN→TQ→PT→LD→SS→HP/DF. Eligibility-gated. If Tatkal isn't open → **deferred remedy with countdown**, not rejection |
| ④ | **Class shift** | Cheapest *and* most comfortable class that clears, with fare delta |
| ⑤ | **Route substitution** | Different corridor. Falls out of CSA for free — no special-casing |
| ⑥ | **Terminal substitution** | Delhi = NDLS/NZM/DLI/ANVT/DEE; Mumbai = CSTM/BCT/LTT/DR/PNVL/KYN. Cross-terminal = road edge with realistic time + ₹ cost. Plus radius-based nearby stations |
| ⑦ | **Inter-modal bridge** | Bus (curated ~500 corridors + **auto-derived** candidates), air (~130 airports from OSM/Wikidata), road (haversine × 1.25 ÷ 50 km/h). All labelled `estimate`, all deep-linked |

**Stopovers are a feature, not a failure.** Dwell >3 h surfaces POIs; >8 h or crossing
midnight suggests overnight + lodging density; >24 h becomes a real intermediate
destination. The card says *"splitting puts you in Ratnagiri anyway, and it's worth 6
hours"* — not an apology.

Detail: [`docs/02-routing-and-discovery.md`](docs/02-routing-and-discovery.md).

---

## 7. Discovery

```
1 SWEEP     one CSA pass from origin → earliest arrival at ALL ~8,000 stations   <400 ms
2 FILTER    keep tourism-relevant (bundled station→POI index); drop >maxTransfers,
            worstLegConfidence <0.35 ("don't suggest a trip I can't book");
            collapse terminal groups; drop origin's own city        → ~600–1,200
3 ENRICH    Open-Meteo (ONE batched call) · POI index · fare engine
            Wikipedia lazy, only on card expand
4 SCORE     availability .25 · seasonFit .20 · interestMatch .20 · journeyQuality .15
            budgetFit .10 · durationFit .05 · novelty .05      (weights = user sliders)
5 DIVERSIFY max 2/state · MMR against near-duplicates · guaranteed budget + offbeat +
            high-certainty slots
6 PRESENT   8 cards; sliders re-rank in <100 ms WITHOUT re-sweeping
```

`seasonFit` uses **real forecast data**, so *"away from the monsoon"* is computable rather
than a hardcoded table — moving the date into July measurably drops Konkan destinations.

**Round trip** is jointly optimised, not two one-ways: availability is directional (Fri
Delhi→Patna before Chhath is WL 80, the reverse is empty, and it flips after).
`daysAtDestination` enables *"staying 4 days puts your return on a Sunday — the worst day
for Goa→Delhi; Monday is AVAILABLE-0140."*

**Honest hard cases.** Northeast reach is genuinely thin — surface Guwahati / New Jalpaiguri
gateways + an inter-modal bridge, never a fictional direct train. **Ladakh and the islands
have no rail** — label it and offer air/road. When rail can't do it, say so.

Detail: [`docs/02-routing-and-discovery.md`](docs/02-routing-and-discovery.md).

---

## 8. GitHub Actions budget

Free tier is **2,000 min/month** for public repos. Two easy-to-miss facts: **matrix shards
bill separately** (5 parallel 60-min shards = 300 min, not 60), and minutes round up per job.

### The change that pays for everything

The previous draft ran a **6-hourly `refresh-live` cron**: 120 runs × 10 min = **1,200
min/month — 69% of the entire budget** — to produce a snapshot that was *always 0–6 hours
stale*.

That is now **zero scheduled cost**. Live delay/cancellation data moves to a **runtime,
on-demand** path:

| | Old (scheduled cron) | New (runtime on demand) |
|---|---|---|
| Actions minutes | **1,200/month** | **0** |
| Freshness | 0–6 h stale, always | **Current at the moment of need** |
| Coverage | ~300 junctions, pre-baked | exactly the trains in *this* user's plan |
| Cost to serve N users | same | same (client-side) |

Strictly better on both axes. It works because NTES live status is only ever needed for
**imminent** travel — and imminent travel is exactly when a stale snapshot is worst.

The new runtime path:
1. **NTES deep link per leg** (always current, zero cost) — the primary mechanism.
2. **Opt-in relay probe** — fetch NTES live status through a public CORS relay at search
   time, cached 30 min in IndexedDB. Fragile → silent fallback, never an error state.
3. **Mandatory verify interstitial** for any journey departing within 48 h.
4. **`workflow_dispatch` manual sweep** during known disruption windows (festivals,
   monsoon, strikes) — costs minutes only when deliberately used.
5. Prominent dataset-age banner + staleness warning >30 days.

### The budget — what runs today

No crons exist yet, so the recurring cost is CI alone:

| Workflow | Trigger | Per run | Runs/mo | **min/mo** |
|---|---|---|---|---|
| `ci` | **PR only** | ~2.5 | ~20 | **50** |
| `deploy` | **`main` only** — verifies *then* publishes | ~3 | ~30 | **90** |
| `harvest` | `workflow_dispatch` only | ~4 | 0 unless invoked | **0** |
| | | | **Total today** | **~140** |

`ci` is PR-only on purpose. Running it on `main` *and* having `deploy` verify would check
every main commit twice and, worse, the two would race — a bad commit could publish before
CI reported the failure. One verifier per commit; a failed verification leaves the previous
version live.

### The budget — full product (crons switch on at Phase 5)

| Workflow | Trigger | Per run | /yr | **min/mo** |
|---|---|---|---|---|
| `harvest` — **full** | quarterly cron (`month%3==1`) | 300 (5 shards × 60) | 4 | **100** |
| `harvest` — **delta** | monthly cron (other 8 months) | 45 | 8 | **30** |
| geo + pois + model | **chained** into full runs | 65 | 4 | **22** |
| `ci` | PR only | 2.5 | ~240 | **50** |
| `deploy` | `main` only | 3 | ~360 | **90** |
| `refresh-live` | **`workflow_dispatch` only** | 8 | ~12 | **8** |
| | | | **Total** | **~300** |

**1,735 → 252 planned → ~140 today.** The full-product figure sits slightly above the
original 252 estimate because `deploy` now verifies rather than only publishing; that buys
the no-race guarantee and costs ~48 min/month.

**Was 1,735 → now 252 min/month = 85% reduction.** Your target was ≤867; this is **3.4×
under** it.

| Month type | Minutes | % of 2,000 |
|---|---|---|
| **Worst** (contains a quarterly full crawl) | ~465 | 23% |
| **Typical** (delta only) | ~145 | 7% |

### Delta crawl — how the monthly refresh costs 45 min not 300

Full crawl of ~12,000 train numbers at ~1.2 s/request is inherently ~4 h. The delta mode
keeps `data/raw` in `actions/cache` (free, 10 GB/repo) and each month refreshes only:
- **new/unknown numbers** by prefix discovery (~200 prefixes, ~4 min)
- a **rotating 10% random sample** of the roster for drift detection (~1,000 trains, ~20 min)
- **top-200 corridor trains in full** — the ones users actually search (~15 min)

Untouched trains keep their cached record. A quarterly full crawl catches anything the
sample missed. Timetables change on the order of weeks, and the app shows dataset age, so
this is safe.

### Levers if it gets tight again

| Lever | Frees | Cost to product |
|---|---|---|
| Delta sample 10% → 5% | ~15 min/mo | slower drift detection |
| `ci` PR-only, not `main` | ~30 min/mo | slower feedback on direct pushes |
| Full crawl quarterly → half-yearly | ~50 min/mo | staler timetable between runs |
| Drop `refresh-live` dispatch entirely | 8 min/mo | none (deep links cover it) |

### Zero-Actions bootstrap (this month)

Since you've already burned Actions minutes, **Phases 0–1 need ~0 of them**:

1. **CC0 bootstrap is committed data** — `datameet/railways` (2016, CC0, licence-clean)
   goes straight into `site/data/seed/`. No CI needed to produce it.
2. **Run the NTES crawl once locally.** It's a few hours on a laptop and costs GitHub
   nothing. Then publish the result as a **release asset**:
   `gh release create data-v1 dataset.tar.gz --title "Timetable snapshot"`
   Release assets are not git objects → **zero Actions minutes**, out of the source tree
   (which also serves the redistribution mitigation), and fetchable without auth.
3. The deploy job `curl`s the release asset (~1 min). Crons stay **disabled** until the
   budget resets; enable them at Phase 5+.

Development runs on `npm run dev` locally throughout — no Actions involved.

---

## 9. Size budget

Binding constraint is bytes shipped to the browser, not compute.

**Measured, Phase 0 (CC0 bootstrap — 5,174 trains, 7,219 stations, 98,055 legs):**

| Asset | Records | Raw | Served (gzip) | When |
|---|---|---|---|---|
| `app.js` + `worker.js` + CSS | — | 65 KB | **22 KB** | immediately |
| `stations.bin` | 7,219 | 158 KB | **76 KB** | immediately — autocomplete works |
| `graph.bin` | 5,174 trains + 98,055 legs + geo | 1.32 MB | **782 KB** | into the worker, real progress |
| **Total first visit** | | **1.54 MB** | **890 KB** | |

Ceilings are committed in `site/budget.json` and enforced by `npm run budget` in CI: a size
regression **fails the build**. Current headroom — first paint 76 KB against a 120 KB
budget, total 890 KB against 1 MB.

**Projected, full product (NTES-era, ~12,000 trains):**

| Asset | Records | Served | When |
|---|---|---|---|
| `stations.bin` | ~8,500 | **~120 KB** | immediately |
| `graph.bin` | ~12,000 trains, ~290,000 legs | **~2.0 MB** | first search |
| `model.json` | availability coefficients | **40 KB** | with the graph |
| `fares/festivals/holidays.json` | — | **35 KB** | immediately |
| `pois.bin` | ~10,000 | **350 KB** | discovery mode only |
| `airports/bus-corridors.json` | ~630 | **60 KB** | only if inter-modal allowed |

**First paint <200 KB · full targeted search ~2.3 MB · full discovery ~2.7 MB.**

100 GB/month ÷ 2.7 MB ≈ **37,000 full sessions**; IndexedDB makes repeat visits near-free
(measured: no network at all once cached) and the timetable works **fully offline**.

Connection math, as built: 98,055 × **10 bytes** (`depMin`/`arrMin`/`fromStn`/`toStn`/
`distKm` as Uint16) = 958 KB. The original estimate was 290,000 × 19 bytes = 5.5 MB. Two
changes account for the gap:

1. **Times are relative to each train's origin departure, not absolute**, so they fit in a
   Uint16 (max observed 7,045 min) instead of an Int32. The wall clock is recovered as
   `originDepMin + relMin`; absolute time depends on the service date anyway, so it had to
   be resolved at query time regardless.
2. **No `trainIx` per connection.** Connections are grouped by train, so ownership is
   implicit and recoverable by binary search over `connStart`.

At NTES scale (~290,000 legs) the same layout gives ~2.9 MB raw rather than 5.5 MB.

---

## 10. Scope

Tightening meant removing things, not just re-wording them.

### Cut or deferred from the previous draft

| Item | Was | Now | Why |
|---|---|---|---|
| **Scheduled live cron** | 1,200 min/mo | **0** — runtime on demand | 69% of budget for data that was always stale |
| **T2 corridor availability snapshots** | planned tier | **cut** | No keyless source made it real; it was aspirational |
| **80-yr climate normals precompute** | build-time matrix | **cut** | The 16-day runtime forecast already powers "away from the monsoon" |
| **AQI enrichment** | feature | **cut** | Marginal to the core promise |
| **PDF export** | feature | **cut** | Real work, low value. Keep .ics + share link + copy-as-text |
| **NTES per-stop avg-delay harvest** | feature | **deferred** | Extra crawl cost; revisit when budget allows |
| **Yen forced-waypoint enumeration** | stopover tool | **deferred** | Stopovers work without it initially |
| **Open-jaw round trips** | feature | **deferred** | Joint round-trip optimisation covers the main case |
| **MapLibre GL + vector tiles** | maps | **Leaflet + raster** | ~40 KB vs a tile pipeline; revisit if maps become central |
| **i18n beyond en + hi** | 11 languages | **deferred** | Extraction pipeline kept so it's additive later |
| **9 phases** | roadmap | **6 phases** | Fewer, larger, each independently shippable |

### Never in scope

No booking, no payments, no PNR storage (Pages forbids e-commerce; we link out).
No login, no accounts, no analytics, no tracking — all state is local.
No commercial use (Open-Meteo free tier and Pages both prohibit it).
No pretending Ladakh or the islands are rail-reachable.
No hammering government servers — politeness is a design requirement.

---

## 11. Roadmap

| # | Phase | Delivers | Actions | Est. | Risk |
|---|---|---|---|---|---|
| 0 | **Foundations + bootstrap data** ✅ **DONE** | Vite/Preact/TS scaffold, Pages deploy, design system, a11y baseline, CC0 dataset live, autocomplete, train lookup | **~0** | 5–7 d | Low |
| 1 | **Routing engine** ✅ **DONE** (4 deviations recorded) | CSA + Pareto, transfers, terminal groups, fare engine, results screen, canvas route diagram, golden corpus v1 | **0** | 12–16 d | Med |
| 2 | **Availability + leg-splitting** | Tiers 0/1/5, date-flex heatmap, quota/class cascade, status parser, Tatkal arithmetic, all 7 remedies, explained splits, IRCTC deep links | ~5 min/qtr | 20–26 d | **High** |
| 3 | **Discovery mode** | Reverse sweep, POI index, scoring + MMR, destination cards, weather, sliders | ~22 min/qtr | 14–18 d | Med |
| 4 | **Inter-modal + stopovers + round trip** | Bus/air/road bridges, auto-derived candidates, stopover promotion, joint round-trip, .ics/share/text export | ~0 | 12–16 d | Med |
| 5 | **Live-at-runtime + PWA + polish** | NTES runtime path, verify interstitial, offline, perf pass, enable crons | **~252/mo** | 8–12 d | Low |

### Phase 0 delivered

Everything below is built, tested and passing CI — not planned.

| Acceptance criterion | Result |
|---|---|
| Push → site live ≤ 5 min | `deploy.yml` verifies then publishes in ~3 min |
| CI fails on lint / type / test / bundle-size regression | all five are separate failing steps |
| Lighthouse a11y ≥ 95 | 19 DOM tests pin the ARIA combobox contract directly (Lighthouse cannot exercise a combobox); skip link, labels, live region, visible focus, `prefers-reduced-motion` all in place |
| Autocomplete works from ~120 KB before the graph loads | `stations.bin` = **76 KB gzip**; coordinates were moved into `graph.bin` specifically to hit this |
| Repeat visit < 300 ms from IndexedDB | cache validated by manifest sha256; a warm load makes **zero** network requests |
| Dataset labelled `BOOTSTRAP · 2016` | flag lives in the container header, so it cannot be forgotten in one view |
| Disclaimer on every page | non-dismissible `role="note"`, carrying both required facts |
| Total Actions minutes this phase < 30 | **0 spent** — the dataset was harvested locally and committed |

**Dataset:** 417,080 raw stop rows → **103,229 genuine stops** across 5,174 trains and 7,219
stations, packed into **1.5 MB raw / 890 KB gzip**. 116 tests, 0 lint warnings, typecheck
clean.

Three findings changed the design, all recorded in
[`docs/03-architecture-and-build.md`](docs/03-architecture-and-build.md#3-binary-container):
**75% of the source's "stops" are pass-throughs** the train never halts at (filtering them
is a correctness fix before it is a size win); **file order is already route order**, so
sorting by `(day, time)` destroys it; and the rail detour factor **calibrates to 1.037**,
not the ~1.25 assumed, because summing haversines over consecutive stops already traces the
route.

### Phase 1 delivered

Also built, tested and passing CI — 340 tests, 0 lint warnings, typecheck clean, app bundle
88 KB (32 KB gzip) with the routing worker at 29 KB.

| Acceptance criterion | Result |
|---|---|
| Router agrees exactly with an independent implementation | **Exceeded.** `tests/bruteforce.test.ts` enumerates *every* valid journey by DFS over train instances — no timetable, no scan, no pruning — and compares full Pareto frontiers both ways over 12 seeded networks × origins × departure times (incl. 00:05) × 0/1/2 changes |
| Single query < 50 ms, Pareto < 200 ms in a worker | p50 **3.66 ms**, p95 **15.3 ms**, worst **53.7 ms** over 1,000 mixed real queries, under jsdom — the slowest environment this runs in |
| 1,000 queries < 2 s | **MISS: 5.14 s measured.** Two-tier progressive search shipped so the common case pays the p50, not the total. Deviation **D1** |
| No journey violates a station's min transfer time | Property test over all ~224 itineraries the corpus produces |
| A weekly train never appears on a non-operating day | Implemented and tested — **but the bootstrap data has no `runs_days`**, so the gate is currently correct and unused. Deviation **D3** |
| Fare engine reproduces ≥ 20 hand-checked published fares within ₹5 | **Calibrated, not verified.** Slab knots, class/type multipliers, superfast, 5% GST all reproduce IRCTC's published structure; checking needs IRCTC access. Every fare flagged as an estimate. Deviation **D4** |
| Cross-terminal transfers as priced road edges | 186 footpaths over 9 resolved city groups |
| Golden journey corpus v1 (≥ 15 routes) | **15 curated city pairs, exact match required** + 200 traffic-weighted sampled pairs at ≥ 95% |
| UI holds 60 fps; queries cancellable | Search is off the main thread in a worker; a stale search's *results* are dropped, its scan is not aborted. Deviation **D6** |
| `RouteMap` (Leaflet) | **Canvas schematic instead.** Every free tile provider wants a key, has terms a keyless Pages site cannot honour, or spends the 100 GB/mo bandwidth allowance. Deviation **D2** |

**Search results:** 15/15 curated city pairs found. 20% of 1,000 random pairs at the
traveller's own bounds, **32% with the widening ladder**; zero label-pool truncations. The
low sampled figure is dataset sparsity (5,174 trains from a 2016 snapshot against ~13,000 in
service) — a ceiling sweep reached only ~37% at six changes and 96 hours, so widening further
buys almost nothing. Every empty state says so and names the data's vintage. Deviation **D5**.

Full deviation record with causes and remediation:
[`docs/04-roadmap-and-risks.md`](docs/04-roadmap-and-risks.md#phase-1--routing-engine--complete-with-deviations-recorded-below).

### Remaining phases

**MVP = Phase 2 on top of this, ~20–26 days.** That already beats IRCTC for *planning*:
multi-leg decomposition, seven remedies, explained splits, and a working availability story.
No free tool does the leg-splitting at all. **Full product ≈ 54–72 days from here.**

**Phase 3 is the differentiator** and should start the moment Phase 2 lands.

**Crons stay off until Phase 5** — everything before it runs on committed CC0 data plus a
one-off local crawl published as a release asset. Directly responsive to your current
Actions usage.

Detail + acceptance criteria + full risk register:
[`docs/04-roadmap-and-risks.md`](docs/04-roadmap-and-risks.md).

---

## Documents

| Doc | Contents |
|---|---|
| [`docs/01-data-and-availability.md`](docs/01-data-and-availability.md) | Verified source matrix · NTES field notes · booking rules · IRCTC data model · the 5-tier cascade · model spec · status parsing · quota arithmetic |
| [`docs/02-routing-and-discovery.md`](docs/02-routing-and-discovery.md) | CSA + Pareto pseudocode · data structures · origin/destination expansion · the 7 remedies in full · inter-modal · stopovers · round trip · discovery scoring · perf + testing |
| [`docs/03-architecture-and-build.md`](docs/03-architecture-and-build.md) | Module breakdown · worker protocol · binary container · repo layout · **Actions budget arithmetic** · harvest discipline · schema · integrity gates · zero-Actions bootstrap |
| [`docs/04-roadmap-and-risks.md`](docs/04-roadmap-and-risks.md) | 6 phases with acceptance criteria · risk register · NTES redistribution · two-ticket splitting · licence matrix · privacy · disclaimers · incident responses |

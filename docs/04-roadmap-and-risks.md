# 04 — Roadmap and risks

Back to [`PLAN.md`](../PLAN.md) · Prev: [`03-architecture-and-build.md`](03-architecture-and-build.md)

Six phases (was nine). Each ships something demonstrable. **None needs a paid service or an
API key.** Estimates assume one experienced full-stack developer.

---

## 1. Phases

| # | Phase | Delivers | Actions | Est. | Risk |
|---|---|---|---|---|---|
| 0 | **Foundations + bootstrap data** | Scaffold, Pages deploy, design system, a11y baseline, CC0 dataset live, autocomplete, train lookup | **~0** | 5–7 d | Low |
| 1 | **Routing engine** | CSA + Pareto + profile, transfers, terminal groups, fare engine, results screen, Leaflet map, golden corpus v1 | **~0** | 12–16 d | Med |
| 2 | **Availability + leg-splitting** | Tiers 0/1/5, date-flex heatmap, quota/class cascade, status parser, Tatkal arithmetic, all 7 remedies, explained splits, IRCTC deep links | ~5 min/qtr | 20–26 d | **High** |
| 3 | **Discovery mode** | Reverse sweep, POI index, scoring + MMR, destination cards, weather, sliders | ~22 min/qtr | 14–18 d | Med |
| 4 | **Inter-modal + stopovers + round trip** | Bus/air/road bridges, auto-derived candidates, stopover promotion, joint round-trip, .ics/share/text export | **~0** | 12–16 d | Med |
| 5 | **Live-at-runtime + PWA + polish** | NTES runtime path, verify interstitial, offline, perf pass, **enable crons** | **~252/mo** | 8–12 d | Low |

**MVP = Phases 0→2, ~37–49 days.** That already beats IRCTC for *planning*: multi-leg
decomposition, seven remedies, explained splits, a working availability story. No free tool
does the leg-splitting at all. **Full product ≈ 71–95 days.**

**Phase 3 is the differentiator** — start the moment Phase 2 lands.

**Crons stay off until Phase 5.** Everything before it runs on committed CC0 data plus a
one-off local crawl published as a release asset
([`03-architecture-and-build.md` §7.6](03-architecture-and-build.md#76-zero-actions-bootstrap-usable-right-now)).
Directly responsive to already-spent Actions minutes.

---

### Phase 0 — Foundations + bootstrap data ✅ COMPLETE

Vite + Preact + TS scaffold · ESLint + strict TS · worker scaffolding with the typed
message protocol · `deploy.yml` (`actions/deploy-pages`) · `ci.yml` **PR-only** ·
design tokens (dark mode, reduced-motion, visible focus) · a11y harness · CC0
`datameet/railways` harvested locally and packed · normaliser (handles the `"None"` string
trap, station renames, and the pass-through problem) · `pack_binary.py` + `binary.ts` +
IndexedDB cache · `StationAutocomplete` · train lookup + full timetable · two integrity
gates · disclaimer partial.

**Acceptance — all met**

- [x] Push to `main` → site live within 5 min, automatically — `deploy.yml` verifies then
      publishes in ~3 min
- [x] CI fails on lint/type/test errors **and** on bundle-size regression — five separate
      failing steps, plus a stdlib-Python dataset check that runs *first* so a corrupt
      binary fails in under a second rather than after a 40 s `npm ci`
- [x] Lighthouse a11y ≥ 95 — **substituted**: 19 DOM tests pin the ARIA combobox contract
      directly. Lighthouse samples a static render and cannot exercise a combobox at all,
      so it would have scored a component it never touched. The tests assert focus never
      leaves the input, `aria-activedescendant` tracks the highlight, every option has a
      stable id, and state changes are announced politely. Skip link, real `<label for>`,
      `role="note"`, visible `:focus-visible`, and `prefers-reduced-motion` are all in place
- [x] Autocomplete works from ~120 KB, **before** the graph loads — `stations.bin` is
      **76 KB gzip**. Coordinates were moved out of it into `graph.bin` specifically to hit
      this; that one change took first paint from 130 KB to 76 KB
- [x] Repeat visit loads from IndexedDB in < 300 ms — a warm load makes **zero** network
      requests; the cache is validated by manifest sha256, never by TTL
- [x] Dataset labelled `BOOTSTRAP · 2016` until NTES data lands — the label is driven by a
      `FLAG_BOOTSTRAP` bit in the container header, so no view can forget it
- [x] Disclaimer on every page — non-dismissible, carrying both required facts (unofficial,
      and cannot book) plus the staleness notice
- [x] **Total Actions minutes consumed this phase: < 30** — **0 spent**. The dataset was
      cloned and packed locally; only the 1.5 MB derivative was committed

**Shipped:** 7,219 stations · 5,174 trains · 98,055 legs · 1.5 MB raw / **890 KB gzip**
total · 116 tests · 0 lint warnings · typecheck clean · all integrity gates green.

**Two deviations from this plan, both deliberate:**
- *axe-core in CI* → replaced by the hand-written ARIA tests above. axe-core would have
  added a dependency and still could not drive the combobox; the tests can.
- *commit CC0 to `site/data/seed/`* → the raw CC0 (95 MB, one file of which is 82 MB) is
  **not** committed; GitHub warns at 50 MB/file and rejects at 100 MB. Only the packed
  derivative ships. `harvester/fetch_seed.py` re-fetches the source locally in about a
  minute, at zero Actions cost.

---

### Phase 1 — Routing engine ✅ COMPLETE (with deviations, recorded below)

Shipped in `site/src/router/`: `timetable.ts` (per-date scan-ready row array, 135,949 rows for
one day in ~70 ms) · `csa.ts` (Connection Scan, onboard/platform label split, six-criterion
Pareto dominance, geometric lower-bound pruning) · `transfers.ts` (per-junction minimums plus
cross-terminal road footpaths) · `terminals.ts` (city terminal groups) · `fares.ts` (slab +
class + type + superfast + GST + flexi) · `journey.ts` (reconstruction, merge of consecutive
rides, rendering, plain-text export). UI: planner form, results grouped by destination for
explore mode, itinerary cards, per-leg detail, canvas route diagram, share/copy/download.

**Acceptance**

- [x] **CSA agrees exactly with exhaustive enumeration** on synthetic networks — stronger than
  the Dijkstra check that was planned: `tests/bruteforce.test.ts` enumerates *every* valid
  journey by DFS over the train instances, without touching the timetable or the scan, and
  compares full Pareto frontiers in both directions over 12 seeded random networks × several
  origins × departure times (including 00:05) × `maxTransfers` 0/1/2. Soundness catches a
  journey that does not exist; completeness catches a journey that was missed.
- [x] Single-destination query < 50 ms; Pareto query < 200 ms in a worker — measured p50 3.7 ms,
  p95 15.3 ms, worst 53.7 ms over 1,000 mixed real queries, under jsdom, which is the slowest
  environment this code runs in.
- [ ] **1,000 queries < 2 s — NOT MET. See deviation D1.**
- [x] No journey violates a station's min transfer time — property test over all ~224 real
  itineraries the corpus produces (`tests/golden.test.ts`).
- [x] **A weekly train never appears on a non-operating day** — implemented and tested,
  including a Sunday-only train found on Sunday and absent on Monday. *Caveat D3: the bootstrap
  data has no `runs_days`, so the gate is currently correct and unused.*
- [~] Fare engine reproduces published fares — **calibrated, not verified. See D4.**
- [x] Cross-terminal transfers priced as road edges with realistic durations — 186 footpaths
  across 9 resolved city groups (Delhi 7, Mumbai 8, Kolkata 4, Chennai 4, Bengaluru 5,
  Hyderabad 4, Goa 5, Pune 3, Ahmedabad 3).
- [x] Golden journey corpus v1 (≥ 15 routes) passes — 15 curated city pairs, all of which must
  match byte-for-byte, plus 200 traffic-weighted sampled pairs held to ≥ 95%.
- [~] UI holds 60 fps during search; queries cancellable — **partially. See D6.**

**Measured behaviour** (1,000 real queries, one day's timetable, `tests/perf.test.ts`)

| Metric | Value |
|---|---|
| Total | 5,146 ms |
| p50 / p95 / worst | 3.66 / 15.26 / 53.7 ms |
| Itineraries found | 200 of 1,000 pairs at the traveller's own bounds |
| …with the widening ladder | 32% of pairs |
| Label-pool truncations | 0 |
| Curated city pairs with a result | 15 / 15 |

**Deviations**

*These are recorded rather than argued away. An acceptance criterion that was missed and says so
is worth more than one that was quietly redefined until it passed.*

**D1 — 1,000 queries in under 2 s is not met (measured 5.1 s).**
The target assumed a warm single-criterion search. What shipped is a six-criterion Pareto search
over the whole day's timetable, and 1,000 of those cost ~5.1 s under jsdom/Vitest — the slowest
of the three environments this code runs in (plain Node is ~3x faster, a browser worker with
fully JIT-optimised code faster still). Two responses:
- *Shipped now:* a two-tier progressive search. The first rung uses exactly the bounds the
  traveller asked for, and only if it comes back empty does the ladder widen
  (`[2, 48 h, 8 h] → [3, 48 h, 12 h] → [4, 60 h, 24 h]`). The UI reports which rung produced
  the result, so a four-change itinerary is never presented as if it were what was asked for.
  Perceived latency for the common case is the p50 (3.7 ms), not the total.
- *Not yet done:* the real fix is a transfer-pattern precompute (Phase 3) or trip-based routing,
  which replaces the per-query timetable scan with a lookup. That is where the 2 s figure becomes
  reachable for bulk workloads such as explore mode, which is the one place a traveller actually
  triggers a thousand searches.
The perf test asserts the shape (worst case < 1,500 ms, p95 < 300 ms) rather than the 2 s total,
because a bound loosened until it passes reports green against a target that was missed.

**D2 — the route diagram is canvas, not Leaflet.**
Leaflet needs a tile provider. Every free one either wants a key, or has terms that a public
GitHub Pages site with no attribution budget cannot honour, or would burn bandwidth against the
100 GB/month Pages allowance on a project whose entire premise is zero cost and zero keys. So
`RouteMap.tsx` draws a schematic diagram: real coordinates with cosine latitude correction,
bounding-box fit, device-pixel-ratio scaling, `ResizeObserver` redraw, `role="img"` with a text
caption. What is lost is genuine geography — no pan, no zoom, no sense of what the journey
passes *near*. Revisit in Phase 5 with OSM tiles if people ask.

**D3 — `runs_days` is implemented but has nothing to gate.**
The CC0 bootstrap dataset carries no operating-days column at all, so every train is assumed to
run daily. The weekly-train logic is written and tested (a Sunday-only train is found on Sunday
and correctly absent on Monday), and the UI flags assumed running days on every affected leg so
nobody books against it. It cannot be satisfied until the NTES harvest lands. This is the single
largest correctness risk in the shipped build: a train shown on a day it does not run is worse
than no train.

**D4 — fares are calibrated, not verified against live bookings.**
The engine reproduces IRCTC's published slab structure (base knots at 0/100/200/300/500/750/
1000/1400/1800/2200/2600/3000 km), class multipliers on the base rather than the total, type
multipliers, the superfast surcharge above 55 km/h average, and 5% GST. It is asserted against
recognisable Delhi–Mumbai corridor fares, monotonicity, tapering marginal rate, and the ordering
travellers expect (Garib Rath below 3A, Jan Shatabdi below Shatabdi, 1A dearest). The planned
"≥ 20 hand-checked published fares within ₹5" was not done, because checking requires IRCTC
access and IRCTC's own fare display is per-quota and per-date. Every fare is flagged as an
estimate in the UI and in the data model. Flexi-fare trains are priced at the mid-band average
and flagged, because their real fare moves with demand and cannot be estimated honestly.

**D5 — coverage is limited by the dataset, not the algorithm.**
About a third of randomly-chosen station pairs yield an itinerary even with the ladder fully
climbed. This is sparsity: 5,174 trains from a 2016 snapshot, against ~13,000 in service. A
ceiling sweep found ~37% at six changes and 96 hours, so widening further buys almost nothing —
the missing pairs have no service in this data at all. Every empty state says so explicitly and
names the data's vintage, rather than implying that no train exists.

**D6 — cancellation abandons results, it does not stop the search.**
A new search increments a generation counter and stale responses are dropped, so the UI never
shows an answer to a question nobody asked any more. The worker scan already in flight runs to
completion. That is invisible for a p50 of 3.7 ms and visible for explore mode, where a real
abort (cooperative flag checked per round, or worker termination) is worth adding in Phase 3.

**Risks**

| Risk | Mitigation |
|---|---|
| NTES crawl takes hours / gets rate-limited | Run **locally once**; publish as release asset. Never lower the 1.2 s pause. CC0 bootstrap keeps dev unblocked |
| Pareto frontier explosion with 6 criteria | Cap ~12/station; tune against the golden corpus. Measured: zero label-pool truncations over 1,000 queries |
| Per-junction min-transfer data unavailable | Rank-based defaults; measured bands {6 min: 1,404 stations, 12: 4,638, 15: 894, 20: 252, 25: 31} |
| Station code drift (MGS→DDU, ALD→PRYJ) | Explicit rename map in the normaliser; orphan-station integrity gate |

---

### Phase 2 — Availability + leg-splitting (20–26 d) · **highest risk, core IP**

`StatusParser.ts` with **waitlist types** preserved · `QuotaRules.ts` (60-day ARP, 08:00
general, Tatkal 10:00 AC / 11:00 non-AC from **origin**, `1A` excluded, Aadhaar note,
maintenance window) · Tier 0 `trains.meta` with rake + berths/coach + quota pools ·
Tier 1 offline training on the Apache-2.0 corpus → isotonic calibration → `distil.py` →
`model.json` → in-worker inference · `AvailabilityBadge` + `AvailabilityExplanation` ·
`DateFlexHeatmap` with `no run` as a distinct state · `LegSplitter` + all 7 remedies ·
`SplitWarning` (mandatory, non-dismissable) · availability memoisation · Tier 5 IRCTC/NTES
deep links · golden corpus v2 (≥ 35 routes incl. split-requiring cases).

**Acceptance**
- [ ] Calibration report committed: reliability curve, Brier, log loss, per-corridor error,
      **temporal** hold-out (not random split)
- [ ] Brier beats a class-only baseline by a stated margin
- [ ] Of segments predicted `pConfirm > 0.8`, ≥ 75% actually confirmed on held-out data
- [ ] **No code path renders `PREDICTED` without its badge** (lint rule + component test)
- [ ] `PQWL 8` scores materially worse than `GNWL 8`
- [ ] Tatkal arithmetic passes **12927 Dadar 23:50 / Borivali 00:26 → opens 23 Jan**
- [ ] Heatmap distinguishes `no run` from sold out
- [ ] A known WL full-run with available halves produces the split as the **top** remedy
- [ ] A clear full-run with WL halves **never** suggests a split
- [ ] No split with halt < 10 min; warning shown below 20 min
- [ ] Every split shows halt time, berth-change warning, two-ticket caveat, grey-area note
- [ ] Remedies ranked by confidence gain × inverse cost, and the **explanation names the
      actual reason** ("segment is 51% of the run, which gets higher allotment")
- [ ] Tatkal-not-yet-open → deferred remedy with countdown, not rejection
- [ ] Ladies/Senior quotas never suggested to ineligible travellers
- [ ] Remedy exploration < 300 ms on Tier 1 (~50–120 memoised calls, not ~1,000)
- [ ] Every leg and remedy has a working IRCTC deep link
- [ ] Fully functional with network disabled after first load

**Progress — Phase 2a, the rules and structure layer (shipped)**

Built and tested in this increment, all of it pure functions with no network dependency:

| Module | What it settles |
| --- | --- |
| `availability/status.ts` | Parses every status form IRCTC and NTES emit (`AVAILABLE-0009`, `WL32/RAC12`, `GNWL14/RAC28`, `REGRET`, `RAC 5`, `TQWL12`, `RLWL7`, `PQWL3`). Waitlist types are **never** collapsed — `WL` alone stays `WL`. Ranks for sorting with the explicit warning that the rank is an *ordering*, never a probability. |
| `availability/rules.ts` | 60-day ARP counted from the **origin** departure date via `serviceDayOffset`; advance booking opens 08:00 IST with the Aadhaar priority window 08:00–08:15; Tatkal at 10:00 AC / 11:00 non-AC one day before origin departure; `1A` has no Tatkal; the 23:45–00:20 maintenance window handled as a **wrap**; `istNow()` reads IST correctly from any browser timezone; eligibility and quota lookup with the Ladies/Senior/Divyangjan quotas excluded by default. |
| `availability/tier.ts` | The T0–T5 cascade, memoised per source, with per-tier confidence and reason, a hard deadline so a slow tier can never eat the budget, and a concurrency cap. No sources are registered, so it returns an explicit `UNKNOWN` — it cannot fabricate a number. |
| `availability/split.ts` | Same-train split enumeration. Never suggests a halt under 10 min; flags under 20 min. **Blocked** candidates are returned with their reason rather than dropped, because "that split is impossible and here is why" is information. |
| `availability/remedies.ts` | All seven remedies with honest labels: *splits this leg* / *re-runs the search* / *needs an availability source*. Ruled-out options are listed with reasons and pose no queries. |
| `availability/links.ts` | Handoff to IRCTC with the six values in the form's own order and DD/MM/YYYY dates. Only three verified URLs are referenced. |
| `ui/AvailabilityPanel.tsx` | Replaces the static "not connected" paragraph on every rail leg with the booking-window facts, the handoff values, a copy button, and a link to IRCTC's charts-and-vacancy page. |
| `availability/rake.ts` | **Tier 0 — the denominator.** Berths per coach by class and generation as verified *ranges* (sources disagree: LHB sleeper 78 or 80, LHB 2A 52 or 54), composition templates per train type intersected with the classes the train actually offers, and confidence that drops to `low` whenever the class list was inferred. Answers only what is certain — a class the train does not run, Tatkal in `1A`, a berth-position quota in a chair car — and returns `null` otherwise. |

| `ui/RemediesPanel.tsx` + `state/remedyContext.ts` | **Renders the seven remedies per leg**, lazily: nothing is computed or fetched until a traveller opens the panel, because a search can return two hundred itineraries of three legs each. Shows the exact IRCTC question each option would pose (train, from, to, DD/MM/YYYY date, class, quota) rather than an answer, the split disclosures with no dismiss control, and splits that were considered and **ruled out with their reason**. |

| `availability/dateflex.ts` + `ui/DateFlexStrip.tsx` | **Remedy ② drawn as days.** Each cell is one of four *facts* — `past`, `no-run`, `window-closed`, `open` — built by running the same `bookingFacts()` the leg panel uses, so the 60-day window cannot drift between two places on one screen. Running days are counted from the train's **origin** date, and the assumed-daily case is flagged on the cell rather than in a footnote. |

Acceptance criteria from the list above that are now covered by tests: the 12927
Dadar 23:50 → Borivali 00:06 Tatkal case; no split under a 10-minute halt with a warning below
20; every split carrying halt time, berth-change, two-ticket and grey-area disclosures;
Ladies/Senior quotas never suggested to ineligible travellers.

**Date-flex deviation.** docs/01 §12 asks that the heatmap distinguish `no run` from *sold out*.
It distinguishes `no run` from *unknown*, because "sold out" is not a thing this build can know.
There is deliberately no green-to-red demand gradient: on every other planner those colours mean
availability, so a traveller would read a filled cell as a free berth. The legend says in terms
that no colour on the strip means "seats available", and a test asserts no cell label ever
mentions a seat, a berth, a confirmation or a waitlist. Friday, Sunday and Monday are marked as
typically busiest — a documented feature of Indian demand, labelled as a pattern rather than a
prediction about that train.

**Two deliberate deviations.** First, *every leg and remedy has a working IRCTC deep link* is
**not** met and will not be: IRCTC publishes no parameter contract for its booking form, so a
guessed query string lands on a blank page while appearing to have worked. The app lists the
exact values beside a link to the bare page instead. If a contract is ever verified, `links.ts`
is the single place it goes. Second, every criterion that depends on a **prediction model**
(Brier, calibration, `pConfirm` precision, `PQWL 8` scoring worse than `GNWL 8` in output) is
untouched — that is Phase 2b, and none of the ranking above should be read as a probability.

**Tier 0 deviation.** The plan called for a per-train `trains.meta` rake table. That table cannot
be shipped: no redistributable source publishes coach composition, and the CC0 bootstrap carries
none. Tier 0 is therefore *constructed* from verified per-coach berth ranges plus composition
templates keyed by train type, every figure carrying a range, a confidence and a basis sentence.
It is a denominator and a set of ruled-out options, never a seat count, and the "whole rake, not
your segment" caveat travels inside the returned value so it cannot be rendered without it. See
docs/01 §8 for the full account.

**Remedies live in the UI layer, not the worker.** They need station codes, city groups and road
times; the worker deliberately holds no `StationIndex`, and loading `stations.bin` there too would
download the same 76 KB twice on a mobile connection. So the worker keeps answering `train:stops`
in indices and `state/remedyContext.ts` enriches them — with a parity test asserting the result
equals `Graph.stopsOfTrain` field for field, since remedy ① decides feasibility from one list and
the router built the leg from the other. Road times reuse `roadMinutes(haversineKm(...))`, the same
function the router priced the transfer with, so two numbers for one pair of terminals can never
disagree on screen.

**Still to do in Phase 2:** Tier 1 training on the Apache-2.0 corpus; Tier 3 relay (only after Pages
bandwidth telemetry proves it is needed); Tier 4 bring-your-own-key; wiring remedies into the
worker so they drive a re-search; `DateFlexHeatmap`; and golden corpus v2 with split-requiring
cases.

**Risks**

| Risk | Mitigation |
|---|---|
| **2023 training data ≠ 2026 reality**, esp. post-ARP-change | Output probability **bands**, never seat counts. Wide intervals. Prominent labelling. Per-corridor error gate |
| Model confidently wrong on festival corridors | Per-corridor error reporting as a CI gate; explicit festival multipliers; never suppress a low-confidence warning |
| Users mistake prediction for reservation | Badge + explanation + IRCTC link on every leg. **Design requirement, not a nicety** |
| Calibration drift | Quarterly retrain, report diffed against the previous run |

**This phase determines whether the product is trustworthy.** Budget generously; do not ship
an uncalibrated model.

---

### Phase 3 — Discovery mode (14–18 d) · the differentiator

Wikidata SPARQL + Overpass POI harvest → station→POI index with `suggestedDwellHours` and
`lodgingWithin3km` · `Reachability.ts` full-network sweep · `Scorer.ts` (7 components) + MMR
diversification + region caps + guaranteed slots · `Seasonality.ts` from the Open-Meteo
**16-day runtime forecast** · `DestinationCard` + `ScoreSliders` + discovery screen ·
direction filters incl. "away from the monsoon / cold / crowds" · `festivals.json` +
`holidays.json`.

**Acceptance**
- [ ] Origin + date only → ≥ 6 ranked distinct destination cards in **< 3 s** on a mid-range device
- [ ] Full-network sweep < 400 ms in the worker
- [ ] No two cards in the same state unless < 8 viable options exist
- [ ] `seasonFit` reflects **real forecast data** — moving the date into monsoon measurably
      drops Konkan destinations (verifiable, not hardcoded)
- [ ] "Away from the monsoon" changes the result set in July vs December
- [ ] Slider moves re-rank < 100 ms **without re-sweeping**
- [ ] **Open-Meteo called once, batched, per discovery run** (assert call count)
- [ ] Every card shows per-leg availability with provenance; every WL card shows ≥ 1 remedy
- [ ] A Northeast query yields gateway + inter-modal bridge, never a fictional direct train
- [ ] Ladakh / Andaman / Lakshadweep labelled "not reachable by train" with an air/road option
- [ ] Festival warnings fire for Chhath/Diwali corridors in the right window

---

### Phase 4 — Inter-modal + stopovers + round trip (12–16 d) · ~0 Actions minutes

OSM/Wikidata airport harvest → `airports.json` · curated `bus-corridors.json` (~500 pairs) ·
`IntermodalBridge.ts` with **auto-derived** candidates (rail > X h and > Y transfers but road
< Z km) · road edges (haversine × 1.25 ÷ 50 km/h, night penalty) · `IntermodalCard` labelled
`estimate` · deep links (redBus/AbhiBus/Google Flights/Skyscanner/Maps) · flight gating ·
stopover promotion thresholds (3 h / 8 h / 24 h) · `Destination` screen with lazy Wikipedia ·
`planRoundTrip` joint optimisation · `daysAtDestination` wiring · export **.ics** + **share
link (URL fragment)** + **copy-as-text**.

**Acceptance**
- [ ] Pune→Panaji bus + Panaji→Madgaon rail appears as a "mixed mode" journey
- [ ] Every inter-modal leg labelled `estimate` with a confidence field
- [ ] **No flight suggested where rail is reasonable** (a 450 km trip must not default to air)
- [ ] Bridges derived automatically for ≥ 5 pairs *not* in the curated list
- [ ] All booking deep links resolve to correct pre-filled searches
- [ ] A forced transfer with > 6 h dwell surfaces as a stopover card with a `whyHere` narrative
- [ ] Round trip jointly optimised — a plan whose outbound remedy differs from the return
      remedy is produced and labelled
- [ ] "4 days in Goa" advice explains the Sunday-return problem and offers Monday
- [ ] .ics opens correctly in Google/Apple/Outlook with correct IST across day boundaries
- [ ] Share link reproduces the identical plan and **never appears in server logs**
- [ ] Every export carries plan timestamp + provenance + "verify on IRCTC" + disclaimer
- [ ] Wikipedia attribution on every card showing an extract or image

**Cut from the previous draft:** PDF export (keep .ics/share/text) · open-jaw returns ·
Yen forced-waypoint enumeration.

---

### Phase 5 — Live-at-runtime + PWA + polish (8–12 d) · **enable crons here**

NTES runtime live path (deep link + opt-in relay probe + `liveStatus` worker message) ·
**mandatory verify interstitial for journeys < 48 h out** · router consumption of live data
(cancelled → remove; diverted → invalidate; delayed → mutate **and re-check downstream
transfers**) · `workflow_dispatch` manual sweep for disruption windows · PWA (service worker,
manifest, offline timetable) · i18n `en` + `hi` · perf pass (region sharding, virtualised
lists, 4× CPU-throttle profiling) · `ProvenanceFooter` with per-source dataset ages ·
**enable the quarterly/monthly crons**.

**Acceptance**
- [ ] A cancelled train disappears from that date's results
- [ ] A diverted train's stale edges are invalidated, not silently used
- [ ] A 90-min delay invalidates transfers that no longer connect
- [ ] Journeys departing < 48 h out always show the verify interstitial
- [ ] Relay-probe failure produces a degraded valid answer, never a user-visible error
- [ ] Lighthouse performance ≥ 90 mobile, a11y ≥ 95
- [ ] Installs as a PWA; timetable works with the network fully disabled
- [ ] Worker latency acceptable on a 4× CPU-throttled mid-range Android profile
- [ ] `hi` locale complete **including remedy explanations**, not just labels
- [ ] **Actual monthly Actions usage ≤ 500 min** (verify against the 252 target)

---

## 2. Cross-cutting (run throughout, not a phase)

| Workstream | Cadence |
|---|---|
| **Golden journey corpus** | Start Phase 1, grow forever. Any regression is a **release blocker**. Highest-value test asset in the project |
| Accessibility audit | Every phase; axe-core in CI from Phase 0 |
| Bundle/dataset size budget | CI gate from Phase 0; re-baseline each phase |
| **Actions minutes** | Track actual vs. the 252 target from Phase 5; treat overruns as bugs |
| Disclaimer & attribution | From Phase 0; re-verify licences whenever a source is added |
| Provenance labelling | From Phase 2; lint-enforced |
| Politeness review | Before every harvester change — rate limits, timeouts, resumability |

---

## 3. Risk register

| # | Risk | Sev | Likelihood | Mitigation |
|---|---|---|---|---|
| R1 | **Redistributing bulk NTES data** breaches operator terms | Med | Med | CC0 seed in `main`; NTES output as release asset / CI artifact. [§4](#4-ntes-redistribution) |
| R2 | NTES blocks or rate-limits the crawler | Med | Med | 1.2 s + jitter + backoff, resumable, read timeouts, delta mode, CC0 fallback |
| R3 | **Prediction mistaken for a reservation** → user misses a train | **High** | Med | Mandatory badges, lint-enforced; IRCTC link on every leg; wide intervals; never a seat count from Tier 1 |
| R4 | **Same-train two-ticket split challenged by TTE staff** | Med | Med | Mandatory disclosure on every split. [§5](#5-same-train-two-ticket-splitting) |
| R5 | Pages ToS — no e-commerce | Low | Low | Never book or take money; deep-link out only |
| R6 | Open-Meteo free tier is **non-commercial** | Low | Low | Non-commercial project. Monetising → $29/mo tier |
| R7 | OSM **ODbL** share-alike on derived databases | Med | High if ignored | Attribution; publish derived station/POI DBs as ODbL. [§6](#6-licence-matrix) |
| R8 | Wikipedia **CC BY-SA** attribution | Med | High if ignored | Visible credit + link on every extract/image |
| R9 | IRCTC ToS breach via Tier-3 relay scraping | Med | Med | Opt-in, off by default, labelled, rate-limited, silently degrading. Ship without it if uncomfortable |
| R10 | Training corpus (Oct 2023) is stale | Med | **High** | Probability bands not counts; per-corridor error gates; honest labelling |
| R11 | **Actions budget overrun** | Med | Med | ~252 min/mo planned vs 2,000 free; crons off until Phase 5; levers table in [`03` §7.5](03-architecture-and-build.md#75-levers-if-it-gets-tight-again); track actuals |
| R12 | Timetable staleness → wrong times | Med | Med | Quarterly full + monthly delta; visible dataset age; >30-day warning; NTES deep link |
| R13 | **Missed cancellation** → user goes to a station for a cancelled train | **High** | Med | Runtime live path (always current, not a stale snapshot); **mandatory verify interstitial < 48 h**; dispatch sweep during disruptions |
| R14 | Fare estimate wrong | Low | High | Label "estimated"; deep-link IRCTC for the authoritative fare |
| R15 | Public CORS relays disappear | Low | **High** | Relay chain with silent fallback; never a dependency |
| R16 | Bandwidth (100 GB/mo soft) | Low | Low | ~2.7 MB worst session → ~37k sessions/mo; SW + IndexedDB cut repeat cost to near zero |
| R17 | Repo/site exceeds 1 GB | Low | Low | Dataset ~3 MB; raw corpus in cache/release assets; `.pbf` never committed |
| R18 | Bundle/data size rot | Med | High over time | CI gate **fails the build** on regression |
| R19 | Perceived as an official railway product | Med | Med | Disclaimer on every screen and in exports; no IRCTC/Indian Railways branding; clearly independent name |
| R20 | Accessibility failure excludes users | Med | Med | WCAG 2.2 AA target; axe-core in CI; availability never by colour alone |

### The three that could actually hurt a user

**R3 — prediction mistaken for reservation.** Someone books nothing because the UI said
"AVAILABLE" when it meant "62% likely". Controls: lint-enforced provenance badges, wide
intervals, no seat counts from Tier 1, an IRCTC deep link on every leg, a "verify before
booking" line in every export.

**R4 — the two-ticket split.** See [§5](#5-same-train-two-ticket-splitting).

**R13 — missed cancellation.** Note the reworked architecture *improves* this: the old
6-hourly cron guaranteed 0–6 h staleness, while the runtime path is current at the moment of
need. Plus the < 48 h verify interstitial, and an explicit push to NTES for same-day travel.

---

## 4. NTES redistribution

`railpull`, the reference implementation this plan builds on, **deliberately ships tools
rather than data**:

> "The schedules are public facts, but bulk collection and **redistribution** of the data may
> run against the operator's terms of use — which is exactly why this repo ships the *tools*
> and not a dataset. If you publish data you collect, that's your call and your
> responsibility."

That is a considered position from someone who actually did the crawl, and this plan takes it
seriously rather than hand-waving it.

### Mitigation: separate the tool from the data

```
main branch (public source, permanently redistributed)
└── site/data/seed/        ← CC0 datameet/railways ONLY. Licence-clean.

release asset / CI artifact (not a git object, not in the source tree)
└── dataset.tar.gz         ← NTES-derived timetable, produced by a crawl
```

- The **harvester code** is committed (MIT, like `ntes-client` and `railpull`).
- The **NTES dataset** is a release asset or CI artifact — never in the source tree.
  `.gitignore` covers `data/raw/`, `data/out/`, `site/data/generated/`.
- Anyone can reproduce it by running the workflow. Same posture `railpull` takes.
- The **CC0 seed** means the repo always contains a complete licence-clean dataset, so the
  app never depends on the NTES corpus being redistributable.
- **Bonus:** release assets cost **zero Actions minutes** and are fetchable without auth —
  this is also the zero-Actions bootstrap path ([`03` §7.6](03-architecture-and-build.md#76-zero-actions-bootstrap-usable-right-now)).

Also: prominent attribution ("Timetable data derived from the National Train Enquiry System
(NTES), Indian Railways. Unofficial."); prominent non-affiliation disclaimer; respect
`robots.txt`; keep crawl rates gentle; consider writing to CRIS to request non-commercial
data access (they have historically had a non-commercial licence category for exactly this
kind of free public-utility app — a polite request costs nothing and could turn the grey
area green); if ever served a takedown, comply promptly and fall back to CC0, which the
architecture makes survivable rather than fatal.

**Not a concern:** individual factual lookups (one train's schedule, one station's timings)
are ordinary use of a public enquiry service. The sensitivity is specifically **bulk
collection and republication** — which is exactly what the seed/asset split addresses.

---

## 5. Same-train, two-ticket splitting

The most user-visible legal/ethical question, because remedy ① is often the best answer.

IRCTC's rules contemplate **one ticket per journey**. Holding two tickets for *consecutive
segments of the same physical train* is commonly done and generally tolerated, but **not
explicitly blessed**, and potentially challengeable by ticket-checking staff who may see it
as circumventing quota allotment. There are also practical consequences: the user may have
to **physically change berths or coaches** mid-journey, sometimes with a short halt,
sometimes at night.

### Non-negotiable product controls

Every suggested split **must** display, inline and non-dismissably:

```
⚠ About this split
  · Requires TWO separate tickets for consecutive segments of the SAME train.
  · You will need to change berths/coaches at RATNAGIRI.
  · The halt is 15 minutes — that is a rushed change. Bring light luggage.
  · IRCTC rules contemplate one ticket per journey. This is commonly practised but
    sits in a grey area and could in principle be questioned by ticket-checking
    staff. Verify with IRCTC before travelling.
  · If either segment does not confirm, you may be left holding a partial journey.
```

Plus:
- **Never** suggest a split with halt < 10 min; **warn** below 20 min
- **Never** present a split as risk-free or as the only option — always show the direct
  waitlisted option alongside so the user can choose the compliant path
- **Never** suggest anything readable as fare evasion (booking a shorter segment and
  travelling further is ticketless travel, straightforwardly prohibited). Splits only where
  the passenger genuinely **alights and reboards** on separate valid tickets
- **Confidence gain is the only ranking signal** — never rank a split up because it happens
  to be cheaper, or it starts to look like arbitrage advice
- A first-run explainer ("How splitting works and what to watch out for") so nobody is
  surprised at 2 a.m. in Ratnagiri

**Honest framing:** *"a strategy experienced travellers use, with these trade-offs"* — not
*"a trick that works."*

---

## 6. Licence matrix

| Data / dependency | Licence | Obligation | Satisfied by |
|---|---|---|---|
| `datameet/railways` seed | **CC0** | none | committed to `site/data/seed/`; credited anyway |
| NTES-derived timetable | public facts; **redistribution caution** | [§4](#4-ntes-redistribution) | release asset, not in source tree |
| `ntes-client`, `railpull` patterns | MIT | retain notice | `requirements.txt` + NOTICE |
| OSM (coords, POIs, geometry, airports) | **ODbL** | attribution **+ share-alike** on derived DBs | "© OpenStreetMap contributors" in footer + on every map; derived station/POI DBs published as ODbL |
| Geofabrik extract | ODbL (inherits) | same | same |
| Wikidata | **CC0** | none | credited anyway |
| Wikipedia extracts & images | **CC BY-SA 4.0** | attribution + share-alike + licence link | visible "Wikipedia" credit with link on every card |
| Kaggle IRCTC availability corpus | **Apache-2.0** | attribution + state changes | credited in [`01`](01-data-and-availability.md#9-tier-1--the-prediction-model-the-default) and in `model.json`'s `trainedOn` |
| Kaggle Indian Trains Schedule & Routes | MIT | retain notice | NOTICE |
| Open-Meteo | free **non-commercial** | no key; attribution appreciated; paid if commercial | footer credit; non-commercial asserted in README |
| IRCTC public rule documents | public information | none | `rules.json` carries a "source & date verified" comment |
| Preact, Vite, Leaflet, Zustand, Vitest, Playwright | MIT / Apache-2.0 / BSD | retain notices | bundled `THIRD-PARTY-LICENSES` |

**Share-alike is the one to think about.** ODbL and CC BY-SA are copyleft: a redistributed
*derived database* must be offered under the same terms. Consequences:

- The station-coordinate table and POI index (OSM-derived) should be published under **ODbL**.
  Wikidata is CC0, so only the OSM-derived parts are affected.
- Bundled Wikipedia extracts would be CC BY-SA. **Avoided by fetching at runtime** — which
  [`03` §5](03-architecture-and-build.md#5-loading-and-caching) already prescribes for size
  reasons too. Runtime fetch + attribution keeps us clean and the bundle small.
- Our **own code** stays MIT. Copyleft on data does not infect application code.
- Ship `LICENSE` (MIT, code) **plus** `DATA-LICENSES.md` spelling out which files are under
  which terms. Ambiguity here is worse than any particular choice.

---

## 7. Privacy

A strong story, because the architecture makes privacy the default rather than a policy:

- **No accounts, no login, no server, no database.** Nothing is collected because there is
  nowhere to put it.
- **No analytics, no trackers, no ads**, no third-party scripts beyond map tiles and the
  keyless data APIs.
- All state (saved trips, settings, optional BYO key) in `localStorage`/IndexedDB in the
  user's own browser.
- **No PNRs stored, ever.** We never ask for one and have no use for one.
- Geolocation opt-in, permission-gated, used only to resolve the nearest station, never
  persisted or transmitted.
- Share links encode the query in the **URL fragment** (`#…`), which browsers don't send to
  servers — a shared plan never appears in access logs.
- An optional BYO key stays in the browser and goes only to its provider. `.gitignore`
  covers `secrets.json`, `.env*`.

Publish a short plain-language note. *"We collect nothing because we have no server"* is more
credible than any policy document.

---

## 8. Scraping ethics

Even where legal, be a good guest:

- **Rate-limit everything.** NTES ~1 req/1.2 s; Overpass paginated by state; Wikidata chunked
  with `LIMIT`/`OFFSET`; Open-Meteo **batched into single multi-location calls**; Wikipedia
  only on card expand.
- **Cache aggressively.** The timetable changes on the order of weeks, not minutes.
- **Descriptive `User-Agent`** with a contact address — Wikimedia rejects generic ones, and
  it's simply polite.
- **Respect `robots.txt`** — verify before deploying each harvester.
- **Fail fast on semantic errors, back off only on network errors.**
- **Read timeouts on everything.**
- **Prefer offline extracts** (Geofabrik `.pbf`) over repeated live queries.
- **Tier 3 is opt-in.** Don't make every visitor an unwitting participant in scraping a
  third-party site.
- **Never scrape behind a login.** We don't, and won't.

---

## 9. Required in-product disclaimers

1. **Footer, every screen:** "Unofficial. Not affiliated with, endorsed by, or sponsored by
   Indian Railways, IRCTC, CRIS, or the Ministry of Railways. Timetable data from NTES (built
   `<date>`). Availability figures are `<provenance>` — always verify on IRCTC before
   booking."
2. **Every availability figure:** a provenance badge. No exceptions.
3. **Every same-train split:** the full [§5](#5-same-train-two-ticket-splitting) warning block.
4. **Every inter-modal estimate:** "Estimated duration and cost — not a timetable. Verify
   with the operator."
5. **Every fare:** "Estimated. IRCTC's fare at booking time is authoritative."
6. **Every export** (.ics, share page): plan timestamp + "availability was `<provenance>` at
   plan time — verify on IRCTC" + disclaimer. **An exported itinerary must never resemble a
   ticket.**
7. **Dataset staleness > 30 days:** banner with age + NTES verification link.
8. **Journeys departing < 48 h:** mandatory verify interstitial.

---

## 10. Incident responses

| Event | Response |
|---|---|
| NTES blocks the crawler | Fall back to CC0 seed, labelled clearly as 2016 bootstrap; pause crons; investigate politely (rate, UA, timing) |
| Takedown request re: NTES data | Comply promptly. The seed/asset split means the app keeps working on CC0 data within minutes |
| **Actions minutes running low** | Apply [`03` §7.5](03-architecture-and-build.md#75-levers-if-it-gets-tight-again) levers in order; or disable all crons and run harvests manually via `workflow_dispatch` / locally |
| A CORS relay disappears | Relay chain falls through automatically. Remove the dead relay at leisure |
| Open-Meteo changes terms | No keyless India-wide replacement (NOAA/NWS is US-only) → drop `seasonFit`, renormalise weights. The scorer is designed for a missing component |
| Model badly miscalibrated on a corridor | Per-corridor gate should catch it in CI. If not: widen intervals, suppress that corridor to `UNKNOWN`, fall back to "verify on IRCTC" |
| User reports being refused travel on a split ticket | Take it seriously. Add to the golden corpus, strengthen the §5 disclosure, consider demoting same-train splits in the ranking |
| Bandwidth approaches the soft limit | More aggressive sharding, longer cache TTLs, smaller POI payloads |
| The project is offered monetisation | **Stop.** Revisit Open-Meteo ($29/mo commercial), Pages commercial policy, and every attribution obligation with real counsel first |

---

## 11. Bottom line

Buildable, free, keyless, and useful — **provided it is honest about the one thing it cannot
do**: guarantee live seat availability without a key.

The whole design is organised around that honesty. Predictions are labelled. Provenance is
visible. Every leg links to IRCTC for ground truth. Splits disclose their grey area.
Estimates say they are estimates. When rail cannot reach somewhere, the app says so.

An app that is 90% as capable but tells the truth will be trusted and used. An app that
claims live availability it does not have will strand someone at a platform at 2 a.m.
**Build the first one.**

Back to [`PLAN.md`](../PLAN.md)

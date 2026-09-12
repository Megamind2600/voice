# 08 — Roadmap

Back to [`PLAN.md`](../PLAN.md)

Nine phases. Each ships something demonstrable. **None depends on a paid service or an API
key.** Estimates assume one experienced full-stack developer; divide accordingly for a team.

---

## Summary

| # | Phase | Delivers | Depends on | Est. | Risk |
|---|---|---|---|---|---|
| 0 | Foundations | Scaffold, CI, Pages deploy, design system, a11y baseline | — | 3–5 d | Low |
| 1 | Data pipeline v1 | CC0 bootstrap + NTES harvester; autocomplete; train lookup | 0 | 7–10 d | **Med** (crawl) |
| 2 | Routing engine v1 | CSA + transfers; trains-between-stations; multi-leg; map | 1 | 10–14 d | **Med** |
| 3 | Availability v1 | Tiers 0+1; date-flex heatmap; quota/class cascade; badges | 2 | 10–14 d | **High** (model) |
| 4 | Leg-splitting | All 7 remedies; explained splits; halt warnings; terminal sub | 3 | 10–14 d | **High** (core IP) |
| 5 | Inter-modal | Bus/air/road edges; auto-derived bridges; deep links | 4 | 7–10 d | Med |
| 6 | Discovery mode | Reverse sweep; POI/weather/festival scoring; dest cards | 4 | 12–16 d | Med |
| 7 | Round trip + stopovers | Joint optimisation; open-jaw; dwell-as-destination; export | 6 | 8–12 d | Low-Med |
| 8 | Live + polish | NTES delay/cancel snapshot; PWA/offline; i18n; perf pass | 2 | 8–12 d | Low |
| 9 | Optional upgrades | Tier 3 probe; Tier 4 BYO-key; usage-insight loop | 3 | 5–8 d | Low |

**Critical path to a genuinely useful app: Phases 0 → 4** ≈ **40–57 days**.
**Full product:** ≈ **80–115 days**.

---

## Phase 0 — Foundations (3–5 d)

**Deliverables**

- Vite + Preact + TypeScript scaffold; ESLint, Prettier, strict TS config
- Worker scaffolding with the typed message protocol
  ([`01-architecture.md` §3](01-architecture.md#3-worker-and-ui-message-protocol))
- GitHub Actions: `ci.yml` (lint, typecheck, test, **bundle-size gate**) and `deploy.yml`
  (`actions/deploy-pages`)
- Site live at `https://<user>.github.io/<repo>/` with a placeholder
- Design system: colour tokens (colour-blind-safe availability scale), type scale
  (Devanagari-capable), spacing, dark mode
- A11y harness: focus management, ARIA live regions, axe-core in CI
- `README.md`, `LICENSE`, disclaimer partial

**Acceptance criteria**

- [ ] Push to `main` → site live within 5 min, automatically
- [ ] CI fails on lint/type/test errors **and** on bundle-size regression
- [ ] Lighthouse a11y ≥ 95 on the placeholder
- [ ] Dark mode follows `prefers-color-scheme`
- [ ] Disclaimer renders on every page

**Risks:** none material. This phase exists to de-risk everything after it.

---

## Phase 1 — Data pipeline v1 (7–10 d)

**Deliverables**

- Commit the CC0 `datameet/railways` files to `site/data/seed/`
- Normaliser: CC0 → canonical schema (handles the `"None"` string trap and station renames)
- `pack_binary.py` → the ArrayBuffer container from
  [`01-architecture.md` §4](01-architecture.md#4-dataset-container-format)
- `BinaryLoader.ts` + `IndexedDBCache.ts`; progressive loading with real byte progress
- `StationAutocomplete` (fuzzy, multilingual, top-5 disambiguation, terminal-group hints)
- Train lookup screen (number → full route with stops, times, halts, distances)
- `harvest-timetable.yml`: the NTES crawler (prefix discovery, resumable, rate-limited,
  matrix-sharded, cached) + exporter
- `validate/integrity.py` gates

**Acceptance criteria**

- [ ] Autocomplete works from ~120 KB, before the graph loads
- [ ] Full graph loads in < 2.5 s on a throttled connection with visible progress
- [ ] Repeat visit loads from IndexedDB in < 300 ms
- [ ] NTES harvest completes end-to-end in CI and produces `trains`/`stops`/`stations`
- [ ] **`runs_days` populated for every active train** — assert a known weekly train is
      absent on non-operating days
- [ ] Integrity gates fail the build on injected corruption (missing station ref, NaN coord,
      unsorted `depTs`)
- [ ] Connection count within ±15% of previous build
- [ ] Dataset clearly labelled `BOOTSTRAP · 2016` until the NTES build lands, then `NTES · <date>`

**Risks & mitigations**

| Risk | Mitigation |
|---|---|
| NTES crawl takes hours, exceeds Actions limits | Matrix-shard by prefix range; `actions/cache` for resumability |
| NTES rate-limits or blocks | Never lower the 1.2 s pause; jitter + backoff; read timeouts; the CC0 bootstrap keeps development unblocked |
| Redistribution concern | CC0 in `main`; NTES output generated into the deployment artifact. See [`09-risks-legal.md`](09-risks-legal.md) |
| Station code drift (MGS→DDU, ALD→PRYJ) | Explicit rename map in the normaliser; integrity gate on orphans |
| `"None"` vs `null` in CC0 data | Normaliser maps explicitly; unit test |

---

## Phase 2 — Routing engine v1 (10–14 d)

**Deliverables**

- `CSA.ts` — single-criterion earliest arrival, with `runs_days`, cancellation and
  min-transfer-time gating inside the scan
- `Transfers.ts` — per-junction min transfer times; cross-terminal road footpaths
- `terminals.json` — city terminal groups; radius-based nearby-station expansion
- `ParetoCSA.ts` — multi-criteria labels (arrival, transfers, fare, `worstConf`,
  nightLegs, fatigue) with dominance pruning and frontier cap
- `Profile.ts` — all Pareto journeys across a departure-time interval
- `FareEngine.ts` — IRCTC slab rules + surcharges + GST; `FlexiFare.ts` for premium trains
- Results screen: trains-between-stations, grouped multi-leg journeys
- `RouteMap` (MapLibre) with polylines; `ItineraryTimeline`

**Acceptance criteria**

- [ ] CSA agrees **exactly** with brute-force Dijkstra on a synthetic test network
- [ ] Single-destination query < 50 ms; Pareto query < 200 ms in a worker
- [ ] No journey violates a station's min transfer time (property test)
- [ ] A weekly train never appears on a non-operating day
- [ ] Fare engine reproduces ≥ 20 hand-checked published fares within ₹5
- [ ] Cross-terminal transfers are priced as road edges with realistic durations
- [ ] Golden journey corpus v1 (≥ 15 routes) passes
- [ ] UI stays at 60 fps during search; queries are cancellable

**Risks**

| Risk | Mitigation |
|---|---|
| Pareto frontier explosion with 6 criteria | Cap at ~12 per station; tune against the golden corpus |
| Min-transfer-time data unavailable per junction | Start with rank-based defaults (metro 30 / junction 20 / intermediate 10 / halt 5 min); refine later |
| Fare rules drift | Table-driven, version-stamped, with the reproduction test as the gate |

---

## Phase 3 — Availability v1 (10–14 d) · **highest technical risk**

**Deliverables**

- `StatusParser.ts` — `AVAILABLE-nnnn` / `RAC n` / `GNWL14/RAC28` / `REGRET`, with
  **waitlist types** (GNWL/RLWL/PQWL/RSWL/CKWL/TQWL) preserved
- `QuotaRules.ts` — 60-day ARP, 08:00 general opening, Tatkal 10:00 AC / 11:00 non-AC
  relative to **origin** departure, 1A excluded, Aadhaar OTP note, maintenance window
- Tier 0: `trains.meta` with rake composition, berths per coach, quota pools
- Tier 1: offline training on the Apache-2.0 Kaggle corpus → isotonic calibration →
  `distil.py` → `availability-model.json`; `Model.ts` inference in the worker
- `AvailabilityBadge` + `AvailabilityExplanation`
- `DateFlexHeatmap` with `no run` as a distinct state
- Quota and class shift cascades (remedies ③ and ④)
- Tier 5: IRCTC / NTES deep-link builders on every leg
- `train-availability-model.yml` monthly cron + committed calibration report

**Acceptance criteria**

- [ ] Model **calibration report** committed: reliability curve, Brier score, log loss,
      per-corridor error, temporal hold-out (not random split)
- [ ] Brier beats a class-only baseline by a stated margin
- [ ] Of segments predicted `pConfirm > 0.8`, ≥ 75% actually confirmed on held-out data
- [ ] **No code path renders `PREDICTED` without its badge** (enforced by a lint rule and
      a component-level test)
- [ ] `PQWL 8` scores materially worse than `GNWL 8`
- [ ] Tatkal arithmetic passes the **12927 Dadar 23:50 / Borivali 00:26** case → opens 23 Jan
- [ ] Heatmap distinguishes "no run" from "sold out"
- [ ] Every leg has a working IRCTC deep link with correct from/to/date/class/quota
- [ ] App is fully functional with network disabled after first load

**Risks**

| Risk | Mitigation |
|---|---|
| **2023 training data ≠ 2026 reality**, especially post-ARP-change (60 vs 120 days) | Output probability **bands**, never seat counts. Wide intervals. Label prominently. Collect Tier-2 snapshots to build a current corpus over time. |
| Model confidently wrong on festival corridors | Per-corridor error reporting as a CI gate; explicit festival multipliers; never suppress a low-confidence warning |
| Calibration drift | Monthly retrain with the report diffed against the previous month |
| Users mistake prediction for reservation | Badge + explanation + "verify on IRCTC" on every leg. This is a design requirement, not a nicety. |

**This phase determines whether the product is trustworthy.** Budget generously and do not
ship an uncalibrated model.

---

## Phase 4 — Leg-splitting intelligence (10–14 d) · **core IP**

**Deliverables**

- `LegSplitter.ts` orchestrator with the ranking function from
  [`04-routing-engine.md` §7](04-routing-engine.md#7-remedy-ranking)
- ① `SameTrainSplit` — segment asymmetry, smart split-point selection (junction rank,
  halt ≥ 10 min, model-predicted segment confidence), capped at ~5 candidates
- `SplitWarning` — halt duration, berth-change notice, two-ticket caveat, grey-area
  disclosure (**mandatory**, never suppressible)
- ② `DateShift` — ±N-day vectorised inference feeding the heatmap
- ③ `QuotaShift` — with eligibility gating and deferred-window countdowns
- ⑤ `RouteSubstitution` — falls out of ParetoCSA
- ⑥ `TerminalSubstitution` — re-run with expanded terminal sets
- `RemedyPanel` with plain-language explanations and confidence-gain deltas
- Availability memoisation (remedy exploration must collapse ~1,000 naive queries to ~50–120)
- Golden journey corpus v2 (≥ 35 routes, including split-requiring cases)

**Acceptance criteria**

- [ ] A known WL full-run with available halves produces the split as the **top** remedy
- [ ] A clear full-run with WL halves **never** suggests a split (don't make things worse)
- [ ] No split suggested with halt < 10 min; warning shown below 20 min
- [ ] Every split shows halt time, berth-change warning and the two-ticket caveat
- [ ] Remedies are ranked by confidence gain × inverse cost, and the explanation names the
      actual reason ("segment is 51% of the run, which gets higher allotment")
- [ ] Tatkal-not-yet-open yields a **deferred remedy with countdown**, not a rejection
- [ ] Ladies/Senior quotas are never suggested to ineligible travellers
- [ ] Remedy exploration completes in < 300 ms on Tier 1
- [ ] Corpus regressions block release

---

## Phase 5 — Inter-modal bridging (7–10 d)

**Deliverables**

- `harvest-geo.yml` → `airports.json` from OSM `aeroway=aerodrome` + Wikidata IATA codes
- `bus-corridors.json` — curated top ~500 interstate city pairs
- `IntermodalBridge.ts` — **auto-derived** bridge candidates (rail > X h and > Y transfers
  but road < Z km), not just hand-listed pairs
- Road/taxi edges: haversine × 1.25 road factor ÷ ~50 km/h, with a night penalty
- `IntermodalCard` — always labelled "estimate", with frequency hints and caveats
- Deep links: redBus / AbhiBus / Google Flights / Skyscanner / Google Maps
- Flight suggestion gating: **only** when rail genuinely fails or the time saving is large

**Acceptance criteria**

- [ ] Pune→Panaji by bus + Panaji→Madgaon by rail appears as a "mixed mode" journey
- [ ] Every inter-modal leg is labelled `estimate` with a confidence field
- [ ] No flight suggested where rail is reasonable (a 450 km trip must not default to air)
- [ ] All booking deep links resolve to correct pre-filled searches
- [ ] Ladakh / Andaman / Lakshadweep return air-or-road options with an explicit
      "not reachable by train" label — never a fictional train
- [ ] Bridges are derived automatically for at least 5 pairs not in the curated list

---

## Phase 6 — Discovery mode (12–16 d) · **the differentiator**

**Deliverables**

- `harvest-pois.yml` — Wikidata SPARQL + Overpass → station→POI index with
  `suggestedDwellHours` and `lodgingWithin3km`
- `Reachability.ts` — full-network sweep (one CSA pass → all stations)
- `Scorer.ts` — the 7-component weighted score; `MMR` diversification; region caps;
  guaranteed budget/offbeat/high-certainty slots
- `Seasonality.ts` — Open-Meteo `/v1/archive` monthly suitability matrix (build-time) +
  `/v1/forecast` batched runtime call
- `DestinationCard`, `ScoreSliders`, discovery screen
- Filters: direction, "away from the monsoon / cold / crowds", interest tags
- `festivals.json` + `holidays.json` (national + state gazetted + school vacations)

**Acceptance criteria**

- [ ] Origin + date only → ≥ 6 ranked distinct destination cards in **< 3 s** total on a
      mid-range device
- [ ] Full-network sweep < 400 ms in the worker
- [ ] No two cards in the same state unless fewer than 8 viable options exist
- [ ] `seasonFit` reflects **real forecast data** — moving the date into monsoon measurably
      drops Konkan destinations (verifiable, not hardcoded)
- [ ] "Away from the monsoon" changes the result set in July vs December
- [ ] Slider moves re-rank in < 100 ms **without re-sweeping**
- [ ] Open-Meteo is called **once, batched**, per discovery run (assert call count)
- [ ] Every card shows per-leg availability with provenance; every WL card shows ≥ 1 remedy
- [ ] A Northeast query yields gateway + inter-modal bridge, never a fictional direct train
- [ ] Festival warnings fire for Chhath/Diwali corridors in the right window

---

## Phase 7 — Round trip + stopovers + export (8–12 d)

**Deliverables**

- `planRoundTrip` — joint optimisation under shared transfer/time/budget constraints;
  **open-jaw** returns
- `daysAtDestination` constraint wiring + return-date advice
- Stopover promotion: dwell > 3 h → POIs; > 8 h or crossing midnight → overnight +
  lodging density; > 24 h → treat as a real intermediate destination
- `Yen.ts` — "show me journeys through X" forced-waypoint enumeration
- `Destination` screen: POIs, weather, lazy Wikipedia extract + photo (with attribution),
  suggested dwell
- Export: **.ics** (per-leg `VEVENT` + stopover events, reminders scaled to halt times),
  **PDF** (with plan timestamp + provenance), **share link** (query in URL **fragment** so
  it never hits logs), **copy as text** for WhatsApp

**Acceptance criteria**

- [ ] Round trip is jointly optimised — a plan whose outbound remedy differs from the
      return remedy is produced and labelled
- [ ] Open-jaw offered when it improves availability or cost
- [ ] "4 days in Goa" advice explains the Sunday-return problem and offers Monday
- [ ] A forced transfer with > 6 h dwell surfaces as a stopover card with a `whyHere`
      narrative
- [ ] .ics opens correctly in Google Calendar / Apple Calendar / Outlook with correct IST
      times across day boundaries
- [ ] Share link reproduces the identical plan and never appears in server logs
- [ ] PDF and every export carry plan timestamp + "verify on IRCTC" + disclaimer
- [ ] Wikipedia attribution present on every card showing an extract or image

---

## Phase 8 — Live data + polish (8–12 d)

**Deliverables**

- `refresh-live.yml` (every 6 h — see the Actions minutes budget in
  [`05-data-pipeline.md` §1](05-data-pipeline.md#actions-minutes-budget--this-is-tight-so-it-is-computed-explicitly))
  — NTES delay/cancellation/diversion snapshot via
  ~300 junction station boards (2/4/8 h windows only, 12 h delay cap)
- Router consumption: cancelled → remove; diverted → invalidate/substitute;
  delayed → mutate and **re-check downstream transfers**
- NTES **average delay per stop** harvest → per-train punctuality profile, used to prefer
  reliable trains and to warn on tight transfers
- Optional Tier-2 availability snapshot for the top ~200 corridors
- PWA: service worker, manifest, install prompt, full offline timetable
- i18n: `en` + `hi` launch, extraction pipeline for regional languages
- Performance pass: region sharding for low-memory devices, virtualised lists,
  worker query latency profiling on 4× CPU throttle
- `ProvenanceFooter` with per-source dataset ages

**Acceptance criteria**

- [ ] A cancelled train disappears from that date's results within one refresh cycle
- [ ] A diverted train's stale edges are invalidated, not silently used
- [ ] A 90-min delay invalidates transfers that no longer connect
- [ ] Punctuality profile measurably changes ranking on a chronically-late vs on-time pair
- [ ] Lighthouse performance ≥ 90 on mobile, a11y ≥ 95
- [ ] App installs as a PWA and the timetable works with the network fully disabled
- [ ] Worker query latency acceptable on a 4× CPU-throttled mid-range Android profile
- [ ] `hi` locale complete including remedy explanations, not just labels
- [ ] Snapshot age badges accurate and never presented as live

---

## Phase 9 — Optional upgrades (5–8 d)

**Deliverables**

- Tier 3 live probe: opt-in toggle, relay chain with fallback, 8 s timeout, one retry,
  hard IndexedDB caching, client-side rate limiting, `LIVE*` labelling, **silent** fallback
- Tier 4 BYO-key: Settings panel, `localStorage` only, provider adapters (RailRadar /
  RapidAPI / other), remaining-budget display, **hard stop** at exhaustion with clean
  fallback; key credits spent only on final legs of journeys the user actually opens
- Privacy-preserving corridor-frequency tally (local only, opt-in export) to derive the
  Tier-2 top-200 corridor list from real usage rather than guesswork
- Continuous model improvement: Tier-2 snapshots feed back into training

**Acceptance criteria**

- [ ] App is **fully functional with Tier 3 and Tier 4 both disabled** (the default)
- [ ] Tier-3 failure produces `fallbackApplied: true` and a valid answer — never an error
- [ ] Tier-4 key never leaves the browser except to its provider; never committed
- [ ] RailRadar budget exhaustion hard-stops probing and falls back cleanly
- [ ] No key is required for any default behaviour anywhere in the app

**This phase is genuinely optional.** Tiers 0/1/2/5 are a complete product without it.

---

## MVP guidance

If time is short:

**Ship after Phase 4** (≈ 40–57 days). That gives targeted multi-leg planning with
predicted availability, all seven remedies, explained splits and IRCTC handoff — already
more capable than IRCTC itself for *planning*, and no existing free tool does the
leg-splitting intelligence at all.

**Phase 6 is what makes it unique** and should start as soon as Phase 4 lands. It is the
feature that answers the actual user need described in the brief — someone with holidays
and no destination in mind.

Phases 5, 7, 8, 9 can follow incrementally; each is independently valuable and none blocks
the others.

---

## Cross-cutting workstreams (run throughout, not a phase)

| Workstream | Cadence |
|---|---|
| **Golden journey corpus** | Start in Phase 2, grow forever. Any regression is a release blocker. The highest-value test asset in the project. |
| **Accessibility audit** | Every phase; axe-core in CI from Phase 0 |
| **Bundle/dataset size budget** | CI gate from Phase 0; re-baseline each phase |
| **Disclaimer & attribution** | From Phase 0; re-verify licences each time a data source is added |
| **Provenance labelling** | From Phase 3; enforced by lint rule and component test |
| **Politeness review** | Before each harvester change — re-check rate limits, timeouts, resumability |

---

Next: [`09-risks-legal.md`](09-risks-legal.md)

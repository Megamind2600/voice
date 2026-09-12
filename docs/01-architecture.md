# 01 — Architecture

Back to [`PLAN.md`](../PLAN.md)

---

## 1. Design constraints that drive every decision

| Constraint | Consequence |
|---|---|
| GitHub Pages serves only static files | No backend, no DB, no server-side scraping, no proxy. All logic is client-side. |
| No API keys permitted | Every runtime dependency must be keyless **and** CORS-permissive. |
| Browser is the runtime | Memory and parse-time budgets are tight; a 6 MB graph cannot be `JSON.parse`d on the main thread. |
| 100 GB/month soft bandwidth | Aggressive compression, sharding, lazy loading, caching. |
| No e-commerce permitted | Plan and link out; never transact. |
| Indian network scale (~10k trains, ~8k stations, ~290k connections) | O(&#124;C&#124;) algorithms, Web Workers, typed arrays. |

---

## 2. Module breakdown

### 2.1 Worker-side (all CPU-heavy work)

Everything below runs in a dedicated Web Worker. The main thread never touches the graph.

```
worker/
├── dataset/
│   ├── BinaryLoader.ts        ArrayBuffer → typed-array views; versioned header check
│   ├── Schema.ts              field offsets, record layouts, endianness
│   └── IndexedDBCache.ts      persist parsed buffers; version-keyed invalidation
├── routing/
│   ├── CSA.ts                 core single-criterion connection scan
│   ├── ParetoCSA.ts           multi-criteria label extension + dominance pruning
│   ├── Profile.ts             all Pareto journeys across a departure-time interval
│   ├── Yen.ts                 K-shortest via a forced waypoint (stopover feature)
│   ├── Transfers.ts           min-transfer-time per junction; cross-terminal road edges
│   └── Reachability.ts        full-network sweep for discovery mode
├── availability/
│   ├── Oracle.ts              the 5-tier cascade + provenance tagging
│   ├── Model.ts               coefficient-table inference (Tier 1)
│   ├── Snapshot.ts            Actions-produced corridor snapshots (Tier 2)
│   ├── LiveProbe.ts           opt-in client probe w/ relay chain (Tier 3)
│   ├── BYOK.ts                optional user key, localStorage only (Tier 4)
│   ├── QuotaRules.ts          ARP/Tatkal/Premium-Tatkal window arithmetic
│   └── StatusParser.ts        "AVAILABLE-0042" / "GNWL14/RAC28" / "REGRET" → typed
├── splitting/
│   ├── LegSplitter.ts         orchestrates the 7 remedies, ranked
│   ├── SameTrainSplit.ts      ① segment asymmetry exploitation
│   ├── DateShift.ts           ② ±N-day heatmap
│   ├── QuotaShift.ts          ③ GN→TQ→PT→LD→SS→HP/DF
│   ├── ClassShift.ts          ④ cheapest clearing class
│   ├── RouteSubstitution.ts   ⑤ alternative corridors (falls out of CSA)
│   ├── TerminalSubstitution.ts⑥ city terminal groups + nearby-station radius
│   └── IntermodalBridge.ts    ⑦ bus / air / road edges
├── fares/
│   ├── FareEngine.ts          distance-slab × class × train-type + surcharges + GST
│   └── FlexiFare.ts           dynamic pricing for premium trains
├── discovery/
│   ├── Sweep.ts               reverse reachability (one CSA pass → all stations)
│   ├── POIIndex.ts            station → nearby attractions
│   ├── Scorer.ts              weighted composite + MMR diversification
│   └── Seasonality.ts         monsoon/heat/snow fit from climate normals
└── enrich/
    ├── OpenMeteo.ts           weather; batched; cached
    ├── Wikipedia.ts           summaries + thumbnails; lazy; IndexedDB-cached
    └── DeepLinks.ts           IRCTC / redBus / Google Flights / Maps URL builders
```

### 2.2 Main-thread (UI only)

```
ui/
├── App.tsx
├── screens/
│   ├── Search.ts              2 mandatory fields + collapsible "refine" panel
│   ├── Results.ts             ranked journey list
│   ├── JourneyDetail.ts       leg-by-leg itinerary, map, remedies
│   ├── Discovery.ts           "8 journeys you could take this week"
│   ├── Destination.ts         POIs, weather, photos, dwell suggestion
│   ├── DateFlex.ts            availability heatmap
│   └── Settings.ts            defaults, optional BYO-key, Tier-3 toggle
├── components/
│   ├── StationAutocomplete.ts  fuzzy match on code/name/city; ~8k entries
│   ├── LegCard.ts              the core unit — train, times, class, availability, remedies
│   ├── AvailabilityBadge.ts    LIVE · SNAPSHOT 42m · PREDICTED 62%±9% · YOUR KEY
│   ├── RemedyPanel.ts          ranked fixes with plain-language explanations
│   ├── IntermodalCard.ts       bus/flight/road variant with estimate labels
│   ├── StopoverCard.ts         dwell + POIs + weather + lodging
│   ├── RouteMap.tsx            MapLibre; polylines; scenic highlighting
│   ├── ItineraryTimeline.ts    vertical time-scaled view
│   └── ProvenanceFooter.ts     data ages, sources, disclaimer
├── state/                      Zustand store; worker message protocol
├── i18n/                       en, hi, + regional
└── sw.ts                       service worker; precache graph; offline strategy
```

---

## 3. Worker and UI message protocol

A single typed message channel. All worker calls are cancellable (a user refining their
search must abort the in-flight sweep, not queue behind it).

```ts
type WorkerRequest =
  | { id: string; kind: 'loadDataset'; shards: ShardId[] }
  | { id: string; kind: 'planJourney'; query: JourneyQuery }
  | { id: string; kind: 'discoverySweep'; query: DiscoveryQuery }
  | { id: string; kind: 'applyRemedy'; journeyId: string; remedy: RemedyRef }
  | { id: string; kind: 'availabilityBatch'; segments: SegmentQuery[] }
  | { id: string; kind: 'cancel'; targetId: string };

type WorkerResponse =
  | { id: string; kind: 'progress'; loaded: number; total: number }
  | { id: string; kind: 'journeys'; journeys: Journey[]; meta: SearchMeta }
  | { id: string; kind: 'destinations'; cards: DestinationCard[] }
  | { id: string; kind: 'error'; code: ErrorCode; fallbackApplied: boolean };
```

`fallbackApplied: true` is important — an availability-probe failure must arrive as a
degraded-but-valid answer, never as an error the user has to act on.

---

## 4. Dataset container format

`JSON.parse` on a 6 MB graph costs seconds and allocates heavily. Instead: a hand-rolled
binary container mapped directly to typed arrays. **Zero parse time** — the buffers *are*
the data structures.

```
┌────────────────────────────── 32-byte header ──────────────────────────────┐
│ magic   "RRLM"      4 bytes                                               │
│ version uint16      2 bytes   ← bump on any schema change                  │
│ flags   uint16      2 bytes   (endianness, compression of optional blocks) │
│ sections uint32     4 bytes   section count                                │
│ generatedAt uint64  8 bytes   unix ms — drives freshness badges            │
│ sourceHash uint64   8 bytes   content hash — drives cache invalidation     │
├──────────────────────────── section directory ─────────────────────────────┤
│ per section: id(uint16) offset(uint32) length(uint32) count(uint32)        │
├──────────────────────────── section bodies ────────────────────────────────┤
│ STATIONS  : SoA — codes as fixed 5-byte ASCII, names as offset+len into a  │
│             shared string blob, lat/lon as Int32 (×1e6), state/zone uint8   │
│ TRAINS    : number(uint32), nameOff, typeCode(uint8), runsDays(bitmask u8), │
│             origin/dest station idx(uint16), distance(uint32), classes(mask)│
│ CONNECTIONS: THE hot array. SoA, sorted ascending by departure timestamp.  │
│             depTs   Int32Array   minutes since epoch-day 0 of the timetable │
│             arrTs   Int32Array                                             │
│             trainIx Uint16Array                                            │
│             fromStn Uint16Array                                            │
│             toStn   Uint16Array                                            │
│             distKm  Uint16Array                                            │
│             dayOff  Uint8Array                                             │
│             classMask Uint16Array                                          │
└────────────────────────────────────────────────────────────────────────────┘
```

**Why SoA (structure-of-arrays) and not AoS:** CSA scans `depTs` and `arrTs` linearly.
Separate arrays mean sequential memory access and SIMD-friendly cache lines. An AoS
layout would thrash the cache on every step. This is the single biggest performance lever
after the algorithm choice.

**Why minutes-since-epoch rather than timestamps:** an Int32 minute counter covers ~4,000
years and lets the whole timetable live in one linear time axis, which is exactly what CSA
requires. Day offsets fold in naturally.

**String interning:** station and train names go into one shared blob with
offset+length references. Station names repeat across thousands of stop records; interning
cuts the name storage by ~90%.

---

## 5. Connection count sanity check

~10,000 active trains × ~30 stops ≈ 300,000 stop records ≈ **290,000 connections**
(consecutive stop pairs). At the SoA layout above:

```
depTs(4) + arrTs(4) + trainIx(2) + fromStn(2) + toStn(2)
+ distKm(2) + dayOff(1) + classMask(2)  =  19 bytes/connection
290,000 × 19  =  5.5 MB raw  →  ~1.8 MB brotli
```

Matches the budget in [`PLAN.md` §9](../PLAN.md#9-performance-and-size-budget).

---

## 6. Technology choices and rejected alternatives

| Decision | Chosen | Rejected | Why |
|---|---|---|---|
| UI library | **Preact** (~4 KB) | React (~45 KB), Svelte, Vue | Bundle bytes are the binding Pages constraint. Preact is API-compatible with React so the ecosystem still works. Svelte would be smaller still but has a thinner ecosystem for maps/virtualisation. |
| Build | **Vite** | Webpack, Rollup hand-config, Jekyll | Fast, zero-config, first-class TS + worker support, emits plain static output. Jekyll (Pages' default) is Ruby and useless here. |
| Routing | **CSA** | Time-expanded Dijkstra, RAPTOR, Transfer Patterns, Trip-Based Routing | Dijkstra is too slow for repeated interactive queries. RAPTOR is comparable but round-based and less cache-friendly. Transfer Patterns need heavy precomputation. TBR is fastest but needs a server-side preprocessing step and is harder to extend to Pareto criteria. CSA is the best effort/performance ratio and extends cleanly to multi-criteria. |
| Data format | **Hand-rolled ArrayBuffer** | FlatBuffers, Cap'n Proto, MessagePack, Protobuf, plain JSON | FlatBuffers/Cap'n Proto would also work (zero-copy) but add a build dependency and a schema compiler. JSON is disqualified by parse time. A hand-rolled SoA layout is ~200 lines, fully under our control, and optimal for the one access pattern we have. |
| Maps | **MapLibre GL** | Leaflet, Google Maps, Mapbox | MapLibre is the keyless fork of Mapbox GL. Google/Mapbox need keys — disqualified. Leaflet is the lightweight fallback and is kept as a progressive-enhancement path for low-end devices. |
| State | **Zustand** | Redux Toolkit, MobX, Context | Small, no boilerplate, no provider tree. |
| Cache | **IndexedDB + service worker** | localStorage, HTTP cache alone | Graph buffers are megabytes; localStorage caps at ~5 MB and is synchronous (blocks the main thread). IndexedDB is async and handles ArrayBuffers natively. |

---

## 7. Loading strategy

Sequenced so the app is useful before the full graph arrives.

```
t=0      HTML + CSS + JS bundle + stations.bin (~120 KB)
         → station autocomplete works IMMEDIATELY
t≈0.3s   user can type and pick origin + date
         → form is fully usable; "Plan" button shows remaining download
t≈0.3s   connections.bin + trains.bin + model (~2.2 MB) streams in background
         → progress bar with real byte counts, cancellable
t≈1.5s   full targeted search available
         → first search triggers nothing further
on-demand  pois.bin (~350 KB)      only when discovery mode is opened
on-demand  airports/bus-corridors  only if allowIntermodal is on
on-demand  Wikipedia text/photos   only when a destination card is expanded
on-demand  Open-Meteo              only for the destinations actually shown
```

Repeat visits: service worker serves everything from IndexedDB; **the timetable works
fully offline**. Only live signals (delays, weather, availability snapshots) hit the
network, and each fails silently to its cached or predicted equivalent.

---

## 8. Caching layers

| Layer | Holds | TTL | Notes |
|---|---|---|---|
| Service worker precache | app shell, JS, CSS | build-versioned | offline first paint |
| IndexedDB | graph buffers, POIs, Wikipedia extracts, availability probes | keyed by `sourceHash` from the container header | survives reloads; explicit invalidation on dataset version bump |
| HTTP cache | `/data/*.bin` | long max-age + content hash in filename | filename hashing gives free invalidation |
| In-memory (worker) | parsed typed-array views | session | the actual working set |
| Availability memo | `(train,from,to,date,class,quota) → result` | 15 min for live, 6 h for snapshot, 24 h for predicted | deduplicates the combinatorial explosion of remedy exploration |

The availability memo is essential: exploring 7 remedies × ±2 dates × 6 classes × 4
quotas on a 3-leg journey naively means ~1,000 queries. With memoisation and the
observation that remedies share most segments, it collapses to ~50–120.

---

## 9. Failure modes and graceful degradation

| Failure | Behaviour |
|---|---|
| Dataset shard 404s | Retry with backoff → fall back to last IndexedDB version → if none, show a clear "data unavailable" state with a link to the build status. Never a blank screen. |
| Open-Meteo down/rate-limited | Omit weather; score destinations without `seasonFit` and renormalise weights. |
| Wikipedia down | Destination card shows POIs from the bundled index without prose/photos. |
| NTES snapshot stale (>24 h) | Hide "live delay" badges; keep schedule data; show snapshot age honestly. |
| Tier-3 probe fails | `fallbackApplied: true` → Tier-1 prediction, silently. |
| Worker crashes | Restart worker, reload buffers from IndexedDB, re-issue the query once. |
| Low-memory device | Region-shard the graph and search corridor-by-corridor instead of whole-network. |
| No JS | A server-rendered static "about + how it works" page. The planner itself needs JS; that is stated plainly rather than faked. |

---

## 10. Testing strategy

| Level | Tool | What it guards |
|---|---|---|
| Unit | Vitest | Fare slabs, quota window arithmetic, status-string parsing, Pareto dominance, remedy ranking |
| Algorithm | Vitest + fixtures | CSA correctness against brute-force Dijkstra on a small synthetic network |
| **Golden journey corpus** | Vitest | ~50 hand-verified real itineraries (e.g. NDLS→MAO must surface the Goa options; HWH→NDLS must find Duronto/Rajdhani; a Northeast query must produce an inter-modal bridge rather than nothing) |
| Availability model | offline eval | calibration curve, Brier score, per-corridor error, held-out date split |
| Data integrity | CI script | referential integrity (every connection's station index exists), `runs_days` populated, no NaN coordinates, no duplicate train numbers, ARP window respected |
| E2E | Playwright | full search → results → remedy applied → itinerary exported |
| Performance | CI budget gate | bundle size, dataset size, worker query latency on a throttled CPU profile |
| Bundle size gate | CI | **fails the build** if JS or data grows past budget — prevents slow rot |

The golden journey corpus is the most valuable test asset: it encodes domain knowledge
("this route really does require a split at Kota") that no unit test would catch.

---

## 11. Accessibility and i18n

- Full keyboard navigation; focus management across the worker-driven async results.
- Availability conveyed by **text and icon, never colour alone** — the date-flex heatmap
  is the highest colour-blindness risk in the app, so every cell carries a label.
- ARIA live regions for "searching…" and result counts.
- Target WCAG 2.2 AA.
- i18n from day one: `en` and `hi` minimum, with a string-extraction pipeline so regional
  languages (ta, te, bn, mr, gu, kn, ml, pa) can be added without code changes. Station
  names are already multilingual in IRCTC's data model (`fromStnNameHi`, `fromStnNameGu`),
  so the harvested dataset should carry them.
- Number and date formatting via `Intl` with `en-IN` locale (lakh/crore grouping,
  12-hour clock with AM/PM as Indian users expect).
- Currency always ₹ with explicit "estimated" labelling.

---

Next: [`02-data-sources.md`](02-data-sources.md)

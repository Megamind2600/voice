# 03 — Architecture and build pipeline

Back to [`PLAN.md`](../PLAN.md) · Prev: [`02-routing-and-discovery.md`](02-routing-and-discovery.md) · Next: [`04-roadmap-and-risks.md`](04-roadmap-and-risks.md)

---

## 1. Constraints driving every decision

| Constraint | Consequence |
|---|---|
| Pages serves only static files | No backend, DB, scraping or proxying. All logic client-side |
| No API keys | Every runtime dependency must be keyless **and** CORS-permissive |
| Browser is the runtime | Memory and parse-time budgets are tight; a 5.5 MB graph can't be `JSON.parse`d on the main thread |
| 100 GB/month bandwidth | Compress, shard, lazy-load, cache |
| **~252 Actions min/month target** | **Nothing on a cron unless it earns its minutes** — see [§7](#7-github-actions-budget) |
| No e-commerce permitted | Plan and link out; never transact |
| ~10k trains, ~8k stations, ~290k connections | O(&#124;C&#124;) algorithms, Web Worker, typed arrays |

---

## 2. Module breakdown

### Worker side (all CPU-heavy work)

```
worker/
├── dataset/    BinaryLoader · Schema · IndexedDBCache
├── routing/    CSA · ParetoCSA · Profile · Transfers · Reachability · (Yen, deferred)
├── availability/ Oracle · Model · LiveProbe · BYOK · QuotaRules · StatusParser
├── splitting/  LegSplitter · SameTrainSplit · DateShift · QuotaShift · ClassShift
│               RouteSubstitution · TerminalSubstitution · IntermodalBridge
├── fares/      FareEngine · FlexiFare
├── discovery/  Sweep · POIIndex · Scorer · Seasonality
└── enrich/     OpenMeteo · Wikipedia · NTESLive · DeepLinks
```

### Main thread (UI only)

```
ui/
├── screens/    Search · Results · JourneyDetail · Discovery · Destination · DateFlex · Settings
├── components/ StationAutocomplete · LegCard · AvailabilityBadge · RemedyPanel · SplitWarning
│               IntermodalCard · StopoverCard · DateFlexHeatmap · RouteMap · ItineraryTimeline
│               DestinationCard · ScoreSliders · ProvenanceFooter · ExportDialog
├── state/      Zustand store + worker message protocol
├── i18n/       en, hi
└── sw.ts       service worker; precache graph; offline strategy
```

### Worker ↔ UI protocol

One typed channel. **All calls cancellable** — refining a search must abort the in-flight
sweep, not queue behind it.

```ts
type WorkerRequest =
  | {id:string; kind:'loadDataset'; shards:ShardId[]}
  | {id:string; kind:'planJourney'; query:JourneyQuery}
  | {id:string; kind:'discoverySweep'; query:DiscoveryQuery}
  | {id:string; kind:'applyRemedy'; journeyId:string; remedy:RemedyRef}
  | {id:string; kind:'availabilityBatch'; segments:SegmentQuery[]}
  | {id:string; kind:'liveStatus'; trains:number[]}          // ★ runtime, replaces the cron
  | {id:string; kind:'cancel'; targetId:string};

type WorkerResponse =
  | {id:string; kind:'progress'; loaded:number; total:number}
  | {id:string; kind:'journeys'; journeys:Journey[]; meta:SearchMeta}
  | {id:string; kind:'destinations'; cards:DestinationCard[]}
  | {id:string; kind:'error'; code:ErrorCode; fallbackApplied:boolean};
```

`fallbackApplied: true` is important — a probe failure must arrive as a degraded-but-valid
answer, never an error the user has to act on.

---

## 3. Binary container

`JSON.parse` of a 5.5 MB graph costs seconds and allocates heavily. Instead: a hand-rolled
container mapped directly to typed arrays. **Zero parse time** — the buffers *are* the
structures.

```
┌──────────── 32-byte header ────────────┐
│ magic "RRLM" 4 · version u16 2 · flags u16 2 · sections u32 4
│ generatedAt u64 8  ← drives freshness badges
│ sourceHash  u64 8  ← drives cache invalidation
├──────────── section directory ─────────┤
│ per section: id u16 · offset u32 · length u32 · count u32
├──────────── section bodies ────────────┤
│ STATIONS   SoA: codes as fixed 5-byte ASCII; names as offset+len into a shared
│            string blob; lat/lon Int32 (×1e6); state/zone u8
│ TRAINS     number u32 · nameOff · typeCode u8 · runsDays bitmask u8 ·
│            origin/dest station u16 · distance u32 · classes mask
│ CONNECTIONS the hot array, SoA, sorted ascending by depTs — see 02-routing §2
└────────────────────────────────────────┘
```

**String interning:** names go into one shared blob with offset+length refs. Station names
repeat across thousands of stop records; interning cuts name storage ~90%.

**Connection math:** 290,000 × 19 bytes = 5.5 MB raw → ~1.8 MB brotli.

---

## 4. Stack: chosen and rejected

| Decision | Chosen | Rejected | Why |
|---|---|---|---|
| UI | **Preact** ~4 KB | React ~45 KB, Svelte, Vue | Bundle bytes are the binding Pages constraint; React-compatible API keeps the ecosystem |
| Build | **Vite** | Webpack, Jekyll | Fast, zero-config, first-class TS + worker support. Jekyll (Pages' default) is Ruby and useless here |
| Routing | **CSA** | Dijkstra, RAPTOR, Transfer Patterns, TBR | See [`02-routing` §1](02-routing-and-discovery.md#1-algorithm-choice) |
| Data format | **Hand-rolled ArrayBuffer SoA** | FlatBuffers, Cap'n Proto, MessagePack, Protobuf, JSON | FlatBuffers would also work but adds a schema compiler + build dep. JSON disqualified by parse time. ~200 lines of our own is fully controlled and optimal for our one access pattern |
| Maps | **Leaflet + OSM raster** | MapLibre GL, Google, Mapbox | Google/Mapbox need keys → disqualified. **MapLibre deferred**: it needs a vector-tile pipeline for marginal gain at this stage. Revisit if maps become central |
| State | **Zustand** | Redux Toolkit, MobX, Context | Small, no boilerplate, no provider tree |
| Cache | **IndexedDB + SW** | localStorage, HTTP cache alone | Graph buffers are megabytes; localStorage caps ~5 MB and is synchronous (blocks main thread) |

---

## 5. Loading and caching

```
t=0     HTML + CSS + JS + stations.bin (~120 KB)  → autocomplete works IMMEDIATELY
t≈0.3s  form fully usable; "Plan" shows remaining download
        connections.bin + trains.bin + model (~2.2 MB) streams in background
        → real byte-count progress, cancellable
t≈1.5s  full targeted search available
on-demand  pois.bin (~350 KB)          only when discovery mode opens
on-demand  airports/bus-corridors      only if allowIntermodal is on
on-demand  Wikipedia text/photos       only on destination-card expand
on-demand  Open-Meteo                  one batched call for shown destinations
on-demand  NTES live status            only when user asks / journey is <48 h away
```

| Layer | Holds | TTL |
|---|---|---|
| SW precache | app shell, JS, CSS | build-versioned |
| IndexedDB | graph buffers, POIs, Wikipedia extracts, live status, probes | keyed by container `sourceHash` |
| HTTP cache | `/data/*.bin` | long max-age + **content hash in filename** = free invalidation |
| In-memory (worker) | typed-array views | session |
| Availability memo | `(train,from,to,date,class,quota) → result` | 15 min live · 6 h snapshot · 24 h predicted |

Repeat visits serve everything from IndexedDB; **the timetable works fully offline**. Only
live signals hit the network, and each fails silently to its cached or predicted equivalent.

---

## 6. Repository layout

```
railroam/
├── .github/workflows/        # the entire "setup"
│   ├── harvest.yml           # quarterly full / monthly delta + chained geo/pois/model
│   ├── build-dataset.yml     # normalise · pack · validate
│   ├── refresh-live.yml      # workflow_dispatch ONLY — no cron
│   ├── ci.yml                # PR + main only
│   └── deploy.yml
├── harvester/                # Python, CI-only
│   ├── ntes/     crawl.py · poll_delays.py · major_stations.json · client.py
│   ├── osm/      overpass_stations.py · overpass_airports.py · geocode_stations.mjs
│   ├── wikidata/ pois_sparql.py
│   ├── transform/ normalise.py · build_connections.py · fares.py · terminals.py · pack_binary.py
│   ├── model/    train.py · calibrate.py · distil.py
│   └── validate/ integrity.py
├── site/
│   ├── src/                  # see §2
│   ├── data/
│   │   ├── seed/             # CC0 datameet — COMMITTED to main, licence-clean
│   │   └── generated/        # gitignored — CI output or release asset
│   └── public/
├── docs/  PLAN.md  README.md
```

**The seed/generated split is deliberate** and is the core redistribution mitigation — see
[`04-roadmap-and-risks.md`](04-roadmap-and-risks.md). CC0 data lives in `main`; NTES-derived
data is produced by CI or published as a release asset, never committed to the source tree.

---

## 7. GitHub Actions budget

Free tier: **2,000 min/month** on public repos. Two easy-to-miss facts: **matrix shards bill
separately** (5 parallel 60-min shards = 300 min, not 60), and minutes round up per job.

### 7.1 The change that pays for everything

The previous draft ran a **6-hourly `refresh-live` cron**: 120 runs × 10 min =
**1,200 min/month = 69% of the entire budget**, producing a snapshot that was *always 0–6
hours stale*.

Live data now costs **zero scheduled minutes**. It moved to a runtime, on-demand path:

| | Old: scheduled cron | New: runtime on demand |
|---|---|---|
| Actions minutes | **1,200/month** | **0** |
| Freshness | 0–6 h stale, always | **current at the moment of need** |
| Coverage | ~300 junctions, pre-baked | exactly the trains in *this* plan |
| Cost as users grow | same | same (client-side) |

Strictly better on both axes. It works because NTES live status is only ever needed for
**imminent** travel — and imminent travel is exactly when a stale snapshot is worst.

**The runtime live path, in priority order:**

1. **NTES deep link per leg** — always current, zero cost, zero fragility. Primary mechanism.
2. **Opt-in relay probe** — fetch NTES live status through a public CORS relay at search
   time (`liveStatus` worker message), cached 30 min in IndexedDB. Fragile → silent
   fallback, never an error state. Reuses the Tier-3 relay machinery already built for
   availability.
3. **Mandatory verify interstitial** for any journey departing within 48 h — this is when
   cancellations actually hurt.
4. **`workflow_dispatch` manual sweep** during known disruption windows (festival peak,
   monsoon, strikes). Costs minutes only when deliberately used.
5. **Dataset-age banner** always visible; staleness warning at >30 days.

Also **cut:** the Tier-2 corridor availability snapshot. With no keyless availability source
it was aspirational, and it consumed minutes for data we could not actually obtain.

### 7.2 The budget

| Workflow | Trigger | Per run | /yr | **min/mo** |
|---|---|---|---|---|
| `harvest` — **full** | quarterly cron (`month%3==1`) | 300 (5 shards × 60) | 4 | **100** |
| `harvest` — **delta** | monthly cron (other 8 months) | 45 | 8 | **30** |
| geo + pois + model | **chained** into full runs | 65 | 4 | **22** |
| `build-dataset` | chained into every harvest | 10 | 12 | **10** |
| `ci` | **PR + `main` only** | 5 | ~132 | **55** |
| `deploy` | `main` only | 3 | ~108 | **27** |
| `refresh-live` | **`workflow_dispatch` only** | 8 | ~12 | **8** |
| | | | **Total** | **~252** |

**Was 1,735 → now 252 min/month = 85% reduction** (15% of the original).

| Month type | Minutes | % of 2,000 |
|---|---|---|
| **Worst** (contains a quarterly full crawl) | ~465 | 23% |
| **Typical** (delta only) | ~145 | 7% |

### 7.3 One workflow, two modes

Don't maintain separate full and delta workflows — one `harvest.yml`, mode decided by the
schedule that fired:

```yaml
on:
  schedule:
    - cron: '0 18 1 * *'      # 1st of each month
  workflow_dispatch:
    inputs:
      mode: { type: choice, options: [delta, full], default: delta }

jobs:
  harvest:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        prefix-range: ["000-199","200-399","400-599","600-799","800-999"]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: '3.12' }
      - run: pip install -r harvester/requirements.txt
      - id: mode
        run: |
          M="${{ inputs.mode }}"
          if [ -z "$M" ]; then
            MON=$(date -d "${{ github.event.schedule }}" +%m 2>/dev/null || date +%m)
            [ $((10#$MON % 3)) -eq 1 ] && M=full || M=delta     # Jan/Apr/Jul/Oct = full
          fi
          echo "mode=$M" >> "$GITHUB_OUTPUT"
      - uses: actions/cache@v4
        with:
          path: data/raw
          key: ntes-raw-${{ matrix.prefix-range }}-${{ steps.mode.outputs.mode }}
          restore-keys: ntes-raw-${{ matrix.prefix-range }}-     # ← resume across runs
      - run: python harvester/ntes/crawl.py --mode ${{ steps.mode.outputs.mode }}
                    --prefixes ${{ matrix.prefix-range }}
      - uses: actions/upload-artifact@v4
        with: { name: raw-${{ matrix.prefix-range }}, path: data/raw }
```

**In delta mode only 1 of the 5 shards needs to run** (the sample is drawn across prefixes),
so guard the matrix with `if: steps.mode.outputs.mode == 'full'` on the extra shards — that
is what brings delta from ~300 min down to ~45.

### 7.4 Delta crawl — 45 min instead of 300

A full crawl of ~12,000 numbers at ~1.2 s/request is inherently ~4 h. Delta mode keeps
`data/raw` in `actions/cache` (free, 10 GB/repo) and refreshes only:

| Slice | Requests | Time |
|---|---|---|
| New/unknown numbers via prefix discovery | ~200 | ~4 min |
| **Rotating 10% random sample** for drift detection | ~1,000 | ~20 min |
| **Top-200 corridor trains in full** — the ones users actually search | ~200 | ~15 min |
| Normalise + pack + validate | — | ~6 min |

Untouched trains keep their cached record. The quarterly full crawl catches anything the
sample missed. Timetables change on the order of weeks and the app shows dataset age, so
this is safe.

### 7.5 Levers if it gets tight again

| Lever | Frees | Cost to product |
|---|---|---|
| Delta sample 10% → 5% | ~15 min/mo | slower drift detection |
| `ci` PR-only, drop `main` | ~30 min/mo | slower feedback on direct pushes |
| Full crawl quarterly → half-yearly | ~50 min/mo | staler timetable between runs |
| Drop `refresh-live` dispatch entirely | 8 min/mo | none — deep links cover it |
| Top-200 corridors → top-100 | ~7 min/mo | slightly staler popular trains |

### 7.6 Zero-Actions bootstrap (usable right now)

If this month's minutes are already spent, **Phases 0–1 need ~0 of them**:

1. **CC0 bootstrap is committed data.** `datameet/railways` goes straight into
   `site/data/seed/`. No CI needed to produce it.
2. **Run the NTES crawl once locally.** A few hours on a laptop, costing GitHub nothing.
   Then publish it as a **release asset**:
   ```bash
   gh release create data-v1 dataset.tar.gz --title "Timetable snapshot 2026-09"
   ```
   Release assets are **not git objects** → zero Actions minutes, out of the source tree
   (which also serves the redistribution mitigation), and publicly fetchable without auth.
3. `deploy.yml` `curl`s the asset (~1 min per deploy).
4. **Keep all crons disabled** until Phase 5. Enable them when the budget resets.

Local development uses `npm run dev` throughout — no Actions involved at all.

---

## 8. Harvest discipline

Non-negotiable: this is a government service reached through an unofficial client. The full
field notes are in [`01-data-and-availability.md` §3](01-data-and-availability.md#3-ntes--the-official-enquiry-service);
the load-bearing ones:

- **~1 request / 1.2 s** with jitter and exponential backoff. **Never lower it to make CI faster.**
- **Read timeouts mandatory** — the server sometimes accepts a connection then goes silent
  forever; one dead read otherwise hangs the whole crawl
- **Resumable checkpointing** to `crawl-status.json`; re-runs skip completed work
- **Fail fast on semantic errors, back off only on network errors**
- Prefix discovery `000`…`999`, drilling deeper when a prefix returns the 60-result cap
- Station-board windows ∈ {2, 4, 8} hours only
- Cap believable delays at 12 h
- Descriptive `User-Agent`; respect `robots.txt`
- Prefer the offline Geofabrik `.pbf` for heavy OSM geometry work over repeated live queries

**Type codes** (get these wrong and categories are empty): `VNDB`/`VNDM`/`VNDS` Vande
Bharat · `DRNT` Duronto · `GBR` Garib Rath · `SUF` superfast (**not** `SF`) · `MEX`
Mail/Express · `RAJ` Rajdhani · `SHT` Shatabdi · `SUB` suburban · `PAX` passenger.

**Station renames:** `MGS→DDU` (Mughal Sarai → Pt. Deen Dayal Upadhyaya Jn),
`ALD→PRYJ` (Allahabad → Prayagraj). The normaliser must reconcile vintages or the graph
silently fragments.

---

## 9. Canonical schema

Explicit intermediate between harvest and binary packing — keeps NTES and CC0 sources
interchangeable.

```jsonc
// train.jsonl
{ "number":"12138", "name":"PUNJAB MAIL", "nameHi":"पंजाब मेल",
  "type":"MEX", "origin":"FZR", "destination":"CSMT",
  "runsDays":127, "arpDays":60, "flexiFare":false,
  "distanceKm":1544, "classes":["1A","2A","3A","SL"],
  "rake":{"1A":1,"2A":3,"3A":8,"SL":12},
  "quotaPools":["GN","TQ","LD","SS","HP"], "returnTrain":"12137",
  "stops":[
    {"seq":1,"code":"FZR","arr":null,"dep":"02:10","day":1,"distKm":0,"haltMin":0,"platform":1},
    {"seq":2,"code":"NDLS","arr":"05:10","dep":"05:35","day":1,"distKm":484,"haltMin":25,"platform":4}
  ] }

// station.jsonl
{ "code":"NDLS", "name":"NEW DELHI", "nameHi":"नई दिल्ली", "nameGu":"નવી દિલ્હી",
  "lat":28.642314, "lon":77.220004, "state":"Delhi", "zone":"NR", "rank":"metro",
  "terminalGroup":"DELHI", "minTransferMin":25, "trainCount":244 }
```

`arr: null` at origin and `dep: null` at terminal is canonical. The CC0 source uses the
**string** `"None"` — the normaliser must map it, a real and easy-to-miss bug.

Trilingual station names come free with the data — **harvest and store them**; display
language then switches with no extra work.

---

## 10. Connection construction

```python
def build_connections(trains, stations):
    stn_ix = {s['code']: i for i, s in enumerate(stations)}
    conns = []
    for t in trains:
        stops = [s for s in t['stops'] if s['code'] in stn_ix]
        for a, b in zip(stops, stops[1:]):
            conns.append({
                'depTs': to_minutes(a['dep'], a['day']),      # one representative week;
                'arrTs': to_minutes(b['arr'], b['day']),      # dates resolved at query
                'trainIx': t['ix'],                           # time via runsDays bitmask
                'fromStn': stn_ix[a['code']], 'toStn': stn_ix[b['code']],
                'distKm': b['distKm'] - a['distKm'],
                'dayOff': b['day'] - 1, 'classMask': mask(t['classes']),
            })
    conns.sort(key=lambda c: c['depTs'])   # ← CSA requires this ordering
    return pack_soa(conns)
```

Keeping one representative week instead of expanding across the 60-day ARP window holds the
array at ~290k connections rather than ~17M. The bitmask test inside the scan is one AND.

---

## 11. Integrity gates (fail the build)

`validate/integrity.py` runs before any deploy:

- [ ] Every connection's `fromStn`/`toStn`/`trainIx` index exists
- [ ] `arrTs >= depTs` modulo day wrap; flag impossible durations
- [ ] No duplicate train numbers; no train with < 2 stops
- [ ] Coordinates non-NaN and inside India's bbox (lat 6.5–37.5, lon 68.0–97.5) — catches geocoding failures
- [ ] `runsDays` non-zero for every active train
- [ ] Station codes unique, ≤ 5 chars
- [ ] Orphan stations (no train stops there) below an expected threshold
- [ ] **Connection count within ±15% of the previous build**
- [ ] `depTs` strictly sorted ascending
- [ ] Fare engine reproduces ≥ 20 hand-checked published fares within ₹5
- [ ] ARP window respected; no journey offered beyond 60 days
- [ ] Tatkal arithmetic passes the 12927 Dadar/Borivali case
- [ ] Container `version` matches the code's expected version
- [ ] Total dataset within the size budget

The **±15% connection-count check is the most valuable gate in practice** — it is how you
notice that NTES started rate-limiting and half the roster came back empty.

Plus in `ci.yml`: lint, typecheck, unit, E2E, Lighthouse a11y ≥ 95, and a **bundle/dataset
size gate that fails the build on regression** — this is what prevents slow rot.

---

## 12. Failure modes

| Failure | Behaviour |
|---|---|
| Dataset shard 404s | retry w/ backoff → last IndexedDB version → clear "data unavailable" + build-status link. Never a blank screen |
| Open-Meteo down / rate-limited | omit weather; drop `seasonFit`, **renormalise** remaining weights |
| Wikipedia down | destination card shows bundled POIs without prose/photos |
| NTES relay probe fails | `fallbackApplied: true` → schedule-only view + deep link. Never an error |
| Dataset stale > 30 days | banner with age + NTES verification link |
| Journey departs within 48 h | **mandatory verify interstitial** before showing the plan as final |
| Worker crashes | restart, reload buffers from IndexedDB, re-issue query once |
| Low-memory device | region-shard the search corridor by corridor |
| No JS | static "about + how it works" page. The planner needs JS — say so plainly, don't fake it |

Governing rule: **every degraded state still answers the user's question**, with less
confidence and more honesty.

---

## 13. Cost summary

| Item | Cost |
|---|---|
| GitHub Pages | ₹0 |
| GitHub Actions | ₹0 — ~252 of 2,000 min/month |
| NTES · Open-Meteo · Wikipedia · Wikidata · OSM | ₹0, no key |
| CC0 datameet dataset | ₹0, no key |
| Kaggle training corpus | ₹0 (free account, one-time download at training time) |
| Domain (optional) | ₹0 on `*.github.io`; ~₹800/yr only for a custom domain |
| **Total** | **₹0** |

The only item needing an account is the one-time Kaggle download at model-training time — a
developer action, never user-facing, never at runtime. If even that is unwanted, train from
published WL-clearance heuristics and rule documents alone: less accurate, still
zero-account.

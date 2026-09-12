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

Built and verified by `harvester/pack_binary.py`, read by `site/src/lib/binary.ts`, and
round-tripped record-by-record in CI by `harvester/validate/integrity.py`.

```
┌──────────── 32-byte header ────────────┐
│ magic "RRLM" 4 · version u16 2 · kind u8 1 · flags u8 1
│ sectionCount u16 2 · payloadLength u32 4 · contentHash 16
├──────────── section directory (20 B each) ────────────┤
│ id u16 · pad u16 · offset u32 · byteLength u32 · count u32 · itemSize u16 · pad u16
├──────────── section bodies, each 4-byte aligned ──────┤
│ STRINGS      shared NUL-terminated UTF-8 blob; records hold a byte offset
│ STATIONS     12 B AoS: code[5] ascii · nameOff u32 · rank u8 · calls u16
│ STATION_GEO   8 B: lat f32 · lon f32   (same index order as STATIONS)
│ TRAINS       32 B: see word layout below
│ CONNECTIONS  10 B: depMin u16 · arrMin u16 · fromStn u16 · toStn u16 · distKm u16
└────────────────────────────────────────┘

TRAIN word layout as a Uint32Array view (8 words):
  w0 nameOff    w1 numberOff   w2 connStart
  w3 connCount | durationMin<<16        w4 distanceKm | originStn<<16
  w5 destStn   | classes<<16            w6 originDepMin | reserved<<16
  w7 type | runsDays<<8 | flags<<16 | pad<<24
```

**Two files, not one.** `stations.bin` (158 KB → **76 KB gzip**) and `graph.bin`
(1.3 MB → **782 KB gzip**). Splitting them is what makes the first-paint budget reachable:
autocomplete needs names, codes and rank, and nothing else. Coordinates are only needed by
maps, direction preference and discovery — all of which come *after* the graph — so
`STATION_GEO` ships in `graph.bin`. Moving 8 bytes per station across that boundary took
first paint from 130 KB to 76 KB gzip.

**No timestamp in the header.** The original design carried `generatedAt u64`. It was
dropped: a build timestamp makes every rebuild differ by 8 bytes, which destroys
byte-identical output and turns every CI size diff into noise. Freshness lives in
`manifest.json` (content hash + source label) and in the `flags` byte, so the binaries
themselves are a pure function of their inputs.

**Connection times are relative, not absolute.** `depMin`/`arrMin` are minutes after that
train's own origin departure, which is what lets them fit in a u16 (max observed 7,045).
The absolute wall-clock time is recovered as `originDepMin + relMin`. Storing absolute
timestamps as i32 — the original 19-byte plan — would have cost ~400 KB for no benefit,
because the absolute time depends on the service date anyway and must be resolved at query
time from `runsDays`.

**Connections are NOT globally sorted by `depTs`.** The plan called for a globally sorted
array because CSA scans in departure order. The implementation instead stores them grouped
by train (which needs no per-connection train id, saving 4 bytes each) and transposes them
into per-station adjacency lists at load. Global sorting is then a Phase 1 concern that
happens *after* service-date expansion, because sorting relative times across different
trains is meaningless.

**String interning:** names go into one shared blob with offset refs. Station names repeat
across thousands of stop records; interning cuts name storage ~90%.

**Connection math, as built:** 98,055 × 10 bytes = 958 KB raw → 782 KB gzip for the whole
graph container. The original 290,000 × 19 bytes estimate assumed every station on a route
is a stop. It is not: **75% of the source's stop rows are pass-throughs** the train never
halts at (the Howrah Rajdhani lists 218 "stops" and actually makes 8). Filtering those out
is a correctness fix first — boarding at a pass-through is physically impossible — and a
3× size win second.


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
t=0     HTML + CSS + JS (~22 KB gz) + manifest.json (~1 KB)
t≈0.1s  stations.bin (76 KB gz) → autocomplete works IMMEDIATELY
        measured: StationIndex build over 7,219 stations < 20 ms
t≈0.3s  form fully usable; status bar shows the graph still downloading
        graph.bin (782 KB gz) streams into the WORKER, off the main thread
t≈1.5s  train lookups available; real byte-count progress, cancellable
repeat  both containers served from IndexedDB, validated by manifest sha256
        → no network at all, which is how a repeat visit stays under 300 ms
on-demand  pois.bin (~350 KB)          only when discovery mode opens      [Phase 3]
on-demand  airports/bus-corridors      only if allowIntermodal is on       [Phase 4]
on-demand  Wikipedia text/photos       only on destination-card expand     [Phase 3]
on-demand  Open-Meteo                  one batched call for shown dests    [Phase 3]
on-demand  NTES live status            only when asked / journey <48 h     [Phase 5]
```

Total first visit: **890 KB gzip** for everything, enforced by `site/budget.json` and
`npm run budget` in CI. A size regression fails the build.


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

Current tree after Phase 0 (`✓` = built and passing CI), with later phases marked:

```
voice/
├── .github/workflows/
│   ├── ci.yml                ✓ PR-only: dataset · lint · types · tests · build · budget
│   ├── deploy.yml            ✓ push-to-main: same checks, then publish to Pages
│   └── harvest.yml           ✓ workflow_dispatch ONLY — no cron, zero recurring minutes
├── harvester/                ✓ Python, stdlib only (no requirements.txt needed)
│   ├── fetch_seed.py         ✓ zero-Actions bootstrap: sparse `git clone` of the CC0 repo
│   ├── normalise.py          ✓ raw CC0 → canonical JSONL, with a data-quality report
│   ├── pack_binary.py        ✓ canonical → stations.bin + graph.bin + manifest.json
│   └── validate/
│       ├── integrity.py      ✓ full gate: canonical ⇄ binary round-trip, needs no node
│       └── check_packed.py   ✓ binary-only gate, <1 s, runs FIRST in CI
│   ├── ntes/                 [Phase 5] crawl.py · poll_delays.py · client.py
│   ├── osm/                  [Phase 3] overpass_stations.py · geocode_stations.mjs
│   ├── wikidata/             [Phase 3] pois_sparql.py
│   └── model/                [Phase 2] train.py · calibrate.py · distil.py
├── data/
│   ├── raw/                  ✗ gitignored — 95 MB cloned source, re-fetch locally
│   └── canonical/            ✗ gitignored except integrity.json + meta.json (committed)
├── site/
│   ├── public/data/          ✓ stations.bin · graph.bin · manifest.json — COMMITTED (1.5 MB)
│   ├── src/
│   │   ├── lib/              ✓ binary.ts · stations.ts · graph.ts · protocol.ts
│   │   ├── state/            ✓ cache.ts (IndexedDB) · client.ts · useDataset.ts
│   │   ├── worker/           ✓ router.ts · handlers.ts · inline.ts (fallback)
│   │   └── ui/               ✓ StationAutocomplete · StopTable · TrainCard · StatusBar
│   │                           · Disclaimer
│   ├── tests/                ✓ 116 tests: binary · stations · graph · cache · dataset · ui
│   ├── scripts/check-budget.mjs ✓
│   └── budget.json           ✓ committed ceilings, so a raise is a reviewable diff
└── docs/  PLAN.md  README.md
```

**Three data tiers, treated differently on purpose:**

| Tier | Size | Committed? | Why |
|---|---|---|---|
| `data/raw/` | ~95 MB | **No** | GitHub warns at 50 MB/file and rejects at 100 MB; `schedules.json` alone is 82 MB. Re-fetch with `harvester/fetch_seed.py`, which costs zero Actions minutes |
| `data/canonical/` | ~18 MB | **No** (2 small JSON reports yes) | A pure function of raw, so committing it creates a second thing to keep in sync |
| `site/public/data/` | 1.5 MB | **Yes** | This is what ships. Committing it means Pages can deploy without running the harvester at all |

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

**What actually runs today (Phase 0)** — no crons exist, so the recurring cost is only CI:

| Workflow | Trigger | Per run | Runs/mo | **min/mo** |
|---|---|---|---|---|
| `ci` | **PR only** | ~2.5 | ~20 | **50** |
| `deploy` | **`main` only** — verifies *then* publishes | ~3 | ~30 | **90** |
| `harvest` | `workflow_dispatch` only | ~4 | 0 unless invoked | **0** |
| | | | **Total today** | **~140** |

`ci` is deliberately PR-only. Running it on `main` *as well as* having `deploy` verify would
check every main commit twice (~120 min/mo instead of 90) and, worse, the two workflows
would race — a bad commit could publish before CI reported the failure. One verifier per
commit, and a failed verification simply leaves the previous version live.

**Budgeted for the full product** (crons switch on at Phase 5, not before):

| Workflow | Trigger | Per run | /yr | **min/mo** |
|---|---|---|---|---|
| `harvest` — **full** | quarterly cron (`month%3==1`) | 300 (5 shards × 60) | 4 | **100** |
| `harvest` — **delta** | monthly cron (other 8 months) | 45 | 8 | **30** |
| geo + pois + model | **chained** into full runs | 65 | 4 | **22** |
| `ci` | PR only | 2.5 | ~240 | **50** |
| `deploy` | `main` only | 3 | ~360 | **90** |
| `refresh-live` | **`workflow_dispatch` only** | 8 | ~12 | **8** |
| | | | **Total** | **~300** |

**Was 1,735 → 252 planned → ~140 today.** The full-product figure drifts slightly above the
original 252 estimate because `deploy` now verifies rather than only publishing; that trade
buys the no-race guarantee above and is worth ~48 min/month.

| Month type | Minutes | % of 2,000 free |
|---|---|---|
| **Today** (Phase 0–4, no crons) | ~140 | 7% |
| **Worst** (contains a quarterly full crawl) | ~513 | 26% |
| **Typical** (delta only) | ~193 | 10% |

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

# 05 — Data pipeline (zero setup, GitHub Actions)

Back to [`PLAN.md`](../PLAN.md)

Everything runs on GitHub's infrastructure with the default `GITHUB_TOKEN`. **You create no
accounts, generate no keys, install nothing, run nothing.** Pushing to the repo *is* the
setup.

---

## 1. Workflow inventory

| Workflow | Trigger | Runtime | Output | Keyless |
|---|---|---|---|---|
| `harvest-timetable.yml` | **monthly** cron + `workflow_dispatch` | ~5 h (5 parallel shards) | `trains.csv` `stops.csv` `stations.csv` `schedules.jsonl` | ✅ |
| `harvest-geo.yml` | monthly cron | ~20 min | station coords, `airports.json` | ✅ |
| `harvest-pois.yml` | monthly cron | ~30 min | `pois.bin`, station→POI index | ✅ |
| `train-availability-model.yml` | monthly cron | ~15 min | `availability-model.json` + calibration report | ✅ |
| `build-dataset.yml` | on any data change | ~10 min | sharded `.bin` files | ✅ |
| `refresh-live.yml` | **every 6 h** | ~10 min | `live.json`, optional `availability-snapshot.json` | ✅ |
| `ci.yml` | every push / PR | ~5 min | lint, typecheck, tests, bundle-size gate | ✅ |
| `deploy.yml` | push to `main` | ~3 min | `actions/deploy-pages` | ✅ |

### Actions minutes budget — this is tight, so it is computed explicitly

GitHub Actions is free for public repos at **2,000 minutes/month**. Two details that are
easy to get wrong: **matrix shards each bill separately** (5 parallel 60-minute shards cost
300 minutes, not 60), and minutes round up per job.

| Workflow | Frequency | Per run | Runs/month | **Min/month** |
|---|---|---|---|---|
| `harvest-timetable` | monthly | 5 shards × 60 min | 1 | **300** |
| `harvest-geo` | monthly | 20 min | 1 | **20** |
| `harvest-pois` | monthly | 30 min | 1 | **30** |
| `train-availability-model` | monthly | 15 min | 1 | **15** |
| `build-dataset` | on data change | 10 min | ~4 | **40** |
| `refresh-live` | every 6 h | 10 min | 120 | **1,200** |
| `ci` | push / PR | 5 min | ~20 | **100** |
| `deploy` | push to `main` | 3 min | ~10 | **30** |
| **Total** | | | | **~1,735** |

**Headroom: ~265 minutes (13%).** It fits — but only just, and only at these frequencies.

**The live refresh dominates the budget** (69% of all minutes). Consequences to respect:

| Change | New total | Verdict |
|---|---|---|
| `refresh-live` every **4 h** | ~2,335 min | ❌ **Exceeds the free tier.** Do not do this without trimming the job. |
| `refresh-live` every **6 h** (planned) | ~1,735 min | ✅ Fits with 13% headroom |
| `refresh-live` every **12 h** | ~1,135 min | ✅ Comfortable; use this if CI activity grows |
| `harvest-timetable` weekly instead of monthly | +900 min → ~2,635 | ❌ Exceeds. **Monthly is correct anyway** — a timetable changes on the order of weeks, not days. |

Levers if the budget gets tight, in order of least cost to the product:

1. Drop `refresh-live` to every 12 h (frees 600 min). Live delay data is a refinement, not
   the core promise.
2. Shrink the station-board sweep from ~300 to ~150 junctions (halves the live job).
3. Run `ci.yml` only on PRs and `main`, not every push (frees ~50 min).
4. Cache Python/Node dependencies between runs (`actions/cache`) — trims ~1–2 min per job,
   which adds up across 120 live runs.

Note that **2,000 min/month is a soft wall**: public-repo Actions minutes are free and
unmetered beyond that on public repositories in current GitHub pricing, but do not design
around that — verify the current policy before relying on it, and keep the budget above
honest.

---

## 2. Repository layout

```
railroam/
├── .github/workflows/          # the entire "setup"
│   ├── harvest-timetable.yml
│   ├── harvest-geo.yml
│   ├── harvest-pois.yml
│   ├── train-availability-model.yml
│   ├── build-dataset.yml
│   ├── refresh-live.yml
│   ├── ci.yml
│   └── deploy.yml
├── harvester/                  # Python, runs in CI only
│   ├── ntes/
│   │   ├── crawl.py            # polite, resumable, prefix-discovery
│   │   ├── poll_delays.py      # station-board sweep
│   │   ├── major_stations.json # ~300 junction seed list
│   │   └── client.py           # thin NTES client (or use ntes-client from PyPI)
│   ├── osm/
│   │   ├── overpass_stations.py
│   │   ├── overpass_airports.py
│   │   └── geocode_stations.mjs
│   ├── wikidata/
│   │   └── pois_sparql.py
│   ├── transform/
│   │   ├── normalise.py        # NTES + CC0 → canonical schema
│   │   ├── build_connections.py# stops → sorted connection array
│   │   ├── fares.py            # IRCTC slab rules → fares.json
│   │   ├── terminals.py        # city terminal groups
│   │   └── pack_binary.py      # canonical → .bin container
│   ├── model/
│   │   ├── train.py            # GBM on the Apache-2.0 corpus
│   │   ├── calibrate.py        # isotonic + reliability curve
│   │   └── distil.py           # → coefficient JSON
│   └── validate/
│       └── integrity.py        # referential integrity gates
├── site/                       # the actual GitHub Pages app
│   ├── src/                    # see docs/01-architecture.md
│   ├── data/
│   │   ├── seed/               # CC0-licensed, committed to main
│   │   │   ├── datameet-stations.json
│   │   │   ├── datameet-trains.json
│   │   │   └── datameet-schedules.json
│   │   └── generated/          # gitignored; produced by CI into the Pages artifact
│   ├── index.html
│   └── public/
├── docs/                       # these documents
├── PLAN.md
└── README.md
```

**The seed/generated split is deliberate** and is the core of the redistribution
mitigation — see [`09-risks-legal.md`](09-risks-legal.md). CC0 data lives in `main`;
NTES-derived data is produced by CI into the deployment artifact.

---

## 3. The timetable harvest

NTES has no "list all trains" endpoint, so discovery is by **number prefix**.

```
000 001 002 ... 999                       # 1,000 three-digit prefixes
  └─ any prefix returning the 60-result cap is drilled deeper
       125 → 1250 1251 ... 1259           # and so on recursively
  └─ union of all results ≈ 12,000 train numbers
  └─ ~20% turn out to be discontinued → ~9,600–10,000 active
```

For each discovered number, fetch the full stop list. Write one JSON per train. Re-runs
skip files already on disk → **the crawl resumes safely** after any interruption.

### Matrix sharding

A full crawl at ~1 req/1.2 s takes hours and would exceed the 6-hour Actions limit. Shard
by prefix range across a matrix, and persist `data/raw` in `actions/cache` so runs resume:

```yaml
jobs:
  crawl:
    strategy:
      fail-fast: false
      matrix:
        prefix-range: ["000-199", "200-399", "400-599", "600-799", "800-999"]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: '3.12' }
      - run: pip install -r harvester/requirements.txt
      - uses: actions/cache@v4
        with:
          path: data/raw
          key: ntes-raw-${{ matrix.prefix-range }}-${{ github.run_id }}
          restore-keys: ntes-raw-${{ matrix.prefix-range }}-
      - run: python harvester/ntes/crawl.py --prefixes ${{ matrix.prefix-range }}
      - uses: actions/upload-artifact@v4
        with: { name: raw-${{ matrix.prefix-range }}, path: data/raw }
```

### Crawl discipline (requirements, not suggestions)

| Rule | Reason |
|---|---|
| ~1 request / 1.2 s, jitter, exponential backoff | This is a government service via an unofficial client. Never lower the pause. |
| **Mandatory read timeouts** | The server sometimes accepts a connection then goes silent forever. Without a socket timeout, one dead read hangs the whole crawl. |
| Resumable checkpointing to `crawl-status.json` | Multi-hour crawls must survive interruption |
| Prefix ≥ 3 characters | Search rejects shorter queries |
| Station-board windows ∈ {2, 4, 8} hours only | Other values error |
| Semantic "no" ≠ network error | Bad query / discontinued train returns a clean error — fail fast; back off only on real network trouble, or the crawl crawls |
| Cap believable delays at 12 h | Boards occasionally report a long-gone service as "57:18 late" |
| Descriptive `User-Agent` | Basic politeness; some endpoints reject generic UAs |
| `robots.txt` respected | Verify before deploying |

### Type-code mapping (get this wrong and categories are empty)

| NTES code | Meaning |
|---|---|
| `VNDB` `VNDM` `VNDS` | Vande Bharat |
| `DRNT` | Duronto |
| `GBR` | Garib Rath |
| `SUF` | Superfast (**not** `SF`) |
| `MEX` | Mail/Express |
| `RAJ` | Rajdhani |
| `SHT` | Shatabdi |
| `SUB` | Suburban |
| `PAX`/`PASS` | Passenger |

### Station renames

Maintain an explicit map when merging data of different vintages:

```jsonc
{ "MGS": "DDU",        // Mughal Sarai → Pt. Deen Dayal Upadhyaya Jn
  "ALD": "PRYJ",       // Allahabad → Prayagraj Jn
  "BCT": "MMCT"        // Mumbai Central → Chhatrapati Shivaji Maharaj Terminus naming variants
}
```

Fresh NTES crawls use current codes; the CC0 datameet bootstrap (2016) uses old ones. The
normaliser must reconcile them or the graph silently fragments.

---

## 4. Live refresh

`refresh-live.yml` sweeps ~300 major junction station boards rather than querying
thousands of trains individually — one board lists every train passing through in a 2/4/8 h
window, each with live delay and cancellation flag. Far fewer requests for the same
coverage.

```jsonc
// live.json — small, committed to the Pages branch
{ "updatedAt": 1783683912, "source": "ntes-station-boards", "ttlMinutes": 300,
  "trains": { "12951": {"d": 18},                     // 18 min late
              "12009": {"c": 1},                       // cancelled
              "12345": {"dv": 1, "via": ["ET","NGP"]}  // diverted
  } }
```

### How the router consumes it

| Signal | Router action |
|---|---|
| `{"c": 1}` cancelled | **Remove** all of that train's connections for that date |
| `{"dv": 1, "via": [...]}` diverted | **Invalidate** the scheduled edges; if the diversion route is known, substitute; otherwise mark the train unreliable and penalise |
| `{"d": 18}` delayed | Mutate `depTs`/`arrTs`; **re-check every downstream transfer** — a 90-min delay can break a connection that was legal at plan time |

This is why CSA was chosen: all three are cheap array mutations with no re-preprocessing.

Also worth surfacing to users: NTES publishes **average delay per stop over the last 7
days**. Harvesting that gives a realistic punctuality profile per train, so the app can
prefer a slightly slower but reliable train over a chronically late one — and warn when a
tight transfer is at risk. That is a genuinely differentiating feature available for free.

---

## 5. Geo and POI harvest

### Station coordinates (Overpass, or offline Geofabrik)

```overpass
[out:json][timeout:90];
area["ISO3166-1"="IN"][admin_level=2]->.india;
(node(area.india)["railway"="station"]; way(area.india)["railway"="station"];);
out center tags;
```

OSM has ~17,000 Indian railway stations, ~11,000 tagged with the official code — most match
NTES directly by code, the rest by normalised name. **Paginate by state or bounding box**
rather than issuing one giant national query; Overpass enforces timeout/maxsize quotas with
cooldown.

For heavy geometry work, prefer the **offline Geofabrik India extract**
(`india-latest.osm.pbf`, ~1.7 GB) processed in CI — no repeated network load, no quota risk.
Note this is large; keep it as a CI cache, never commit it.

### POI index (Wikidata SPARQL + Overpass)

```sparql
SELECT ?item ?itemLabel ?coord ?type WHERE {
  VALUES ?type { wd:Q5764562 wd:Q16970 wd:Q46169 wd:Q62849 wd:Q47505 wd:Q941024 }
  ?item wdt:P31/wdt:P279* ?type .
  ?item wdt:P17 wd:Q668 .
  ?item wdt:P625 ?coord .
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,hi". }
} LIMIT 50000
```

Variants for forts, temples, hill stations, wildlife reserves, beaches, waterfalls, caves,
pilgrimage sites, UNESCO World Heritage Sites. Chunk with `LIMIT`/`OFFSET`, send a
descriptive `User-Agent`, cache between runs. Output is **CC0**.

Then a **nearest-station join** (KD-tree over station coordinates) produces the
station→POI index used by discovery mode and stopover cards:

```jsonc
{ "RN": { "name": "RATNAGIRI", "lat": 16.99, "lon": 73.30,
          "pois": [ {"name":"Ratnadurg Fort","km":3.1,"type":"fort","wikidata":"Q...",
                     "significance":3},
                    {"name":"Ganpatipule Temple","km":12.0,"type":"temple","significance":4},
                    {"name":"Thibaw Palace","km":2.4,"type":"museum","significance":2},
                    {"name":"Bhatye Beach","km":6.0,"type":"beach","significance":2} ],
          "lodgingWithin3km": 41,
          "suggestedDwellHours": 6 } }
```

`suggestedDwellHours` derives from POI count × significance — this is what lets the app say
"Jaipur justifies 3 days, Ratnagiri justifies 6 hours."

### Wikipedia content: runtime, not build time

Bundling summaries for ~2,000 destinations costs ~800 KB compressed for content most users
never open. **Fetch lazily at runtime** from Wikipedia REST (keyless, CORS), cache in
IndexedDB indefinitely, send a descriptive UA, and attribute on every card. This keeps the
bundle small and the content always current.

---

## 6. Canonical schema

The harvester emits a normalised intermediate before binary packing. Keeping this explicit
makes the NTES and CC0 sources interchangeable.

```jsonc
// train.jsonl
{ "number": "12138", "name": "PUNJAB MAIL", "nameHi": "पंजाब मेल",
  "type": "MEX", "origin": "FZR", "destination": "CSMT",
  "runsDays": 127, "arpDays": 60, "flexiFare": false,
  "distanceKm": 1544, "classes": ["1A","2A","3A","SL"],
  "rake": {"1A":1,"2A":3,"3A":8,"SL":12},
  "quotaPools": ["GN","TQ","LD","SS","HP"],
  "returnTrain": "12137",
  "avgDelayMin": {"FZR":0,"NDLS":22,"BPL":35,"CSMT":58},   // NTES 7-day averages
  "stops": [
    { "seq": 1, "code": "FZR", "arr": null, "dep": "02:10", "day": 1, "distKm": 0,
      "haltMin": 0, "platform": 1 },
    { "seq": 2, "code": "NDLS", "arr": "05:10", "dep": "05:35", "day": 1,
      "distKm": 484, "haltMin": 25, "platform": 4 }
    /* ... */
  ] }

// station.jsonl
{ "code": "NDLS", "name": "NEW DELHI", "nameHi": "नई दिल्ली", "nameGu": "નવી દિલ્હી",
  "lat": 28.642314, "lon": 77.220004, "state": "Delhi", "district": "Central",
  "zone": "NR", "division": "Delhi", "rank": "metro",
  "terminalGroup": "DELHI", "minTransferMin": 25, "trainCount": 244 }
```

`origin: null` for `arr` and `dep: null` for terminals is the canonical form. The CC0
datameet source uses the **string** `"None"` for these — the normaliser must map
`"None"` → `null`, a real and easy-to-miss bug.

---

## 7. Connection array construction

```python
def build_connections(trains, stations):
    stn_ix = {s['code']: i for i, s in enumerate(stations)}
    conns = []
    for t in trains:
        stops = [s for s in t['stops'] if s['code'] in stn_ix]
        for a, b in zip(stops, stops[1:]):
            for day_offset in operating_days(t):        # respect runs_days
                conns.append({
                    'depTs': to_minutes(a['dep'], a['day'], day_offset),
                    'arrTs': to_minutes(b['arr'], b['day'], day_offset),
                    'trainIx': t['ix'],
                    'fromStn': stn_ix[a['code']],
                    'toStn':   stn_ix[b['code']],
                    'distKm':  b['distKm'] - a['distKm'],
                    'dayOff':  b['day'] - 1,
                    'classMask': mask(t['classes']),
                })
    conns.sort(key=lambda c: c['depTs'])     # ← CSA requires this ordering
    return pack_soa(conns)                   # → typed arrays
```

**Note the `runs_days` expansion**: a weekly train contributes connections only on its
operating day. This is where the 2016 "everything runs daily" assumption gets corrected.
It also means the connection array is date-scoped — decide up front whether to (a) expand
over a rolling 60-day ARP window (larger array, simpler queries) or (b) keep one
representative week and resolve dates at query time via the bitmask (smaller array, more
query logic). **(b) is recommended** — it keeps the array at ~290k connections instead of
~17M, and the bitmask test inside the scan is a single bitwise AND.

---

## 8. Integrity gates (fail the build)

`validate/integrity.py` runs before any deploy:

- [ ] Every connection's `fromStn`/`toStn` index exists in the station table
- [ ] Every connection's `trainIx` exists in the train table
- [ ] `arrTs >= depTs` (modulo day wrap); flag impossible durations
- [ ] No duplicate train numbers; no train with < 2 stops
- [ ] Every station has non-NaN coordinates within India's bounding box
      (lat 6.5–37.5, lon 68.0–97.5) — catches geocoding failures
- [ ] `runsDays` is non-zero for every active train
- [ ] Station codes are unique and ≤ 5 characters
- [ ] No orphan stations (a station no train stops at) beyond an expected threshold
- [ ] Connection count within ±15% of the previous build — a sudden drop means the crawl
      partially failed
- [ ] `depTs` array is strictly sorted ascending
- [ ] Fare engine reproduces ≥ 20 hand-checked published fares within ₹5
- [ ] ARP window respected: no journey offered beyond 60 days
- [ ] Tatkal arithmetic passes the 12927 Dadar→Borivali test case
- [ ] Container header `version` matches the code's expected version
- [ ] Total dataset size within budget (see [`PLAN.md` §9](../PLAN.md#9-performance-and-size-budget))

The ±15% connection-count check is the most valuable one in practice: it is how you notice
that NTES started rate-limiting the crawl and half the roster came back empty.

---

## 9. Build and deploy

```yaml
# build-dataset.yml (excerpt)
- run: python harvester/transform/normalise.py      --in data/raw --out data/canonical
- run: python harvester/transform/build_connections.py --out data/canonical/connections
- run: python harvester/transform/fares.py          --out site/data/generated/fares.json
- run: python harvester/transform/pack_binary.py    --out site/data/generated/
- run: python harvester/validate/integrity.py       --strict      # gates the deploy

# deploy.yml
- uses: actions/configure-pages@v5
- run: npm ci && npm run build                      # site/ → dist/
- uses: actions/upload-pages-artifact@v4
  with: { path: dist }
- uses: actions/deploy-pages@v4
```

Content-hash filenames (`connections.a3f9c2.bin`) so HTTP caching invalidates automatically
and users never serve a stale graph against new code.

---

## 10. Bootstrap path: working on day one without waiting for a crawl

A full NTES crawl takes hours. Do not block development on it.

1. **Day 1:** commit the CC0 `datameet/railways` files to `site/data/seed/`. Normalise them
   into the canonical schema. The app works end-to-end immediately — with 2016 accuracy,
   clearly labelled `BOOTSTRAP DATA · 2016 · schedules may be outdated`.
2. **Week 1:** land the harvester and run it once via `workflow_dispatch`. Swap the
   generated dataset in. Keep the CC0 path as a tested fallback.
3. **Ongoing:** monthly timetable cron, 6-hourly live cron, monthly geo/POI/model crons
   (see the [minutes budget](#actions-minutes-budget--this-is-tight-so-it-is-computed-explicitly)
   before increasing any frequency).

Cross-validate the two: where NTES and datameet disagree on a train's existence or timings,
NTES wins and the diff is logged. The diff is also a useful staleness report for the
bootstrap data.

---

## 11. Cost summary

| Item | Cost |
|---|---|
| GitHub Pages | ₹0 |
| GitHub Actions (public repo) | ₹0 — 2,000 min/month, we use ~660 |
| NTES | ₹0, no key |
| Open-Meteo | ₹0, no key (non-commercial) |
| Wikipedia / Wikidata | ₹0, no key |
| OSM Overpass / Geofabrik | ₹0, no key |
| CC0 datameet dataset | ₹0, no key |
| Kaggle training corpus | ₹0 (free account to download once, then it is committed/cached) |
| Domain (optional) | ₹0 on `*.github.io`; ~₹800/yr only if you want a custom domain |
| **Total** | **₹0** |

The one item needing an account is the Kaggle download of the training corpus, and that is
a **one-time developer action at model-training time**, not a user-facing dependency and
not required at runtime. If even that is unwanted, the model can be trained purely from
published WL-clearance heuristics and rule documents — less accurate, still zero-account.

---

Next: [`06-discovery.md`](06-discovery.md)

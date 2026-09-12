# 02 — Data sources (all verified 2026-09-12)

Back to [`PLAN.md`](../PLAN.md)

Every source below was checked during planning. "Keyless" means **no account, no email
request, no credit card, no configuration** — the invariant that makes "no setup from you"
true.

---

## 1. Summary matrix

| # | Source | What we get | Auth | CORS | Rate limit | Licence | Role |
|---|---|---|---|---|---|---|---|
| 1 | **NTES** `enquiry.indianrail.gov.in` | Timetable, `runs_days`, live status, station boards, cancellations/diversions/reschedules | **None** | ❌ (server-side only) | Unpublished — self-impose ~1 req/1.2 s | Public factual data; redistribution caution | **L1 core** (build-time only) |
| 2 | **`ntes-client`** (PyPI) | MIT Python wrapper for NTES | None | n/a | n/a | MIT | Harvest library |
| 3 | **`railpull`** (GitHub) | Working polite crawler + exporter + delay poller + OSM geocoder | None | n/a | n/a | MIT | **Reference implementation** |
| 4 | **`datameet/railways`** | `stations.json` `trains.json` `schedules.json` (GeoJSON, 2016) | None | n/a | n/a | **CC0** | Licence-clean bootstrap + fallback |
| 5 | **Open-Meteo** | 16-day forecast, 80-yr climate normals, air quality | **None** | ✅ | ~10k calls/day, 600/min, 5k/hr | Free **non-commercial** | Season fit, dwell weather |
| 6 | **Wikipedia REST** `/api/rest_v1/page/summary/` | Description, extract, coords, thumbnail | **None** | ✅ | Fair use | CC BY-SA 4.0 | Destination prose + photos |
| 7 | **Wikidata SPARQL** | All Indian tourist attractions, national parks, UNESCO sites, airports w/ coords | **None** | ✅ | Fair use; UA required | CC0 | POI index |
| 8 | **OSM Overpass** | `railway=station`, `aeroway=aerodrome`, `tourism=*`, `historic=*` | **None** | ✅ | Fair use; timeout/maxsize quotas | ODbL | Station coords, POIs, rail geometry |
| 9 | **Geofabrik India extract** | `india-latest.osm.pbf` (~1.7 GB) | None | n/a | n/a | ODbL | Offline OSM processing in CI |
| 10 | **Kaggle IRCTC Schedule-Prices-Availability** | Real availability strings + fares, Oct 2023 | Kaggle account (free) to download once | n/a | n/a | **Apache-2.0** | **Training data for Tier-1 model** |
| 11 | **IRCTC public rule documents** | Fare slabs, quota rules, ARP/Tatkal timings, refund rules | None | n/a | n/a | Public | `fares.json`, `rules.json` |
| 12 | **RailRadar** `railradar.in` | Real 14-day availability, PNR, GeoJSON routes | **Key required** | ? | Free tier **1,000 req/month** | Proprietary | *Optional* Tier-4 upgrade |
| 13 | **RapidAPI `irctc1`** | `checkSeatAvailability`, PNR | Key | ? | Paid per call | Proprietary | *Optional* Tier-4 |
| 14 | **IndianRailAPI.com** | `/v2/SeatAvailability/` | Key | ? | Enterprise/Advanced plans | Proprietary | *Optional* Tier-4 |

Sources 1–11 need **no key at all**. Sources 12–14 are documented purely as optional
upgrades and are never on the critical path.

---

## 2. Verified live: Open-Meteo

Called during planning, returned real data for Delhi today:

```http
GET https://api.open-meteo.com/v1/forecast
    ?latitude=28.61&longitude=77.21
    &daily=temperature_2m_max,precipitation_probability_max
    &timezone=Asia/Kolkata&forecast_days=3
```

```json
{"latitude":28.576448,"longitude":77.18678,"utc_offset_seconds":19800,
 "timezone":"Asia/Kolkata","timezone_abbreviation":"GMT+5:30","elevation":217.0,
 "daily_units":{"time":"iso8601","temperature_2m_max":"°C","precipitation_probability_max":"%"},
 "daily":{"time":["2026-09-12","2026-09-13","2026-09-14"],
          "temperature_2m_max":[31.8,32.3,30.3],
          "precipitation_probability_max":[75,84,95]}}
```

**CORS is enabled out of the box** — callable directly from browser JS with no proxy.
No key, no account, no registration. ~10,000 calls/day non-commercial, 600/min, 5,000/hr.

### Endpoints we use

| Endpoint | Use |
|---|---|
| `/v1/forecast` | 16-day daily forecast for the travel window |
| `/v1/archive` | 80-year historical normals → **seasonality scoring** |
| `/v1/air-quality` | AQI for Delhi/Kanpur/Lucknow in winter — a genuine trip-quality signal |
| `/v1/forecast` w/ `precipitation_sum` | **Monsoon avoidance**: "away from the rain" direction filter |

### Usage discipline

Batch aggressively: one call can request **multiple locations** (comma-separated
`latitude`/`longitude`) and multiple variables. Discovery mode shows ~8 destinations →
**one batched call**, not eight. Cache in IndexedDB for 6 h. This keeps us orders of
magnitude under the daily limit.

⚠️ **Non-commercial only.** If this app ever monetises, a paid tier ($29/mo) is required.

---

## 3. Verified live: Wikipedia REST

Called during planning for Jaipur:

```http
GET https://en.wikipedia.org/api/rest_v1/page/summary/Jaipur
```

```json
{"type":"standard","title":"Jaipur","wikibase_item":"Q66485",
 "description":"Capital of Rajasthan, India",
 "coordinates":{"lat":26.915,"lon":75.82},
 "thumbnail":{"source":"https://thumb.wikimedia.org/wikipedia/commons/thumb/4/41/East_facade_Hawa_Mahal_Jaipur_...jpg","width":330,"height":248},
 "originalimage":{"source":"https://upload.wikimedia.org/.../East_facade_Hawa_Mahal_Jaipur_....jpg","width":3345,"height":2509},
 "extract":"Jaipur is the capital and the largest city of the north-western Indian state of Rajasthan. As of 2011, the city had a population of 3.1 million... also known as the Pink City due to the dominant colour scheme of its buildings in the old city.",
 "content_urls":{"desktop":{"page":"https://en.wikipedia.org/wiki/Jaipur"}}}
```

CORS-enabled, keyless. Gives us a **description, coordinates, a licensed thumbnail and a
full extract** per destination — exactly the "explore this place" content — for free.

**Strategy: fetch at runtime, not build time.** Bundling summaries for 2,000 destinations
would cost ~800 KB compressed for content most users never open. Instead fetch lazily on
card expansion, cache in IndexedDB indefinitely, and always send a descriptive
`User-Agent` (Wikimedia's policy requires it and blocks generic/empty UAs).

Use `hi.wikipedia.org` and regional wikis for i18n extracts — same API shape.

⚠️ Attribution is **mandatory** (CC BY-SA 4.0): credit "Wikipedia" with a link on every
card showing an extract or image.

---

## 4. NTES — the official enquiry service (build-time only)

`enquiry.indianrail.gov.in` is Indian Railways' **National Train Enquiry System**, run by
CRIS. It is free and requires no key. It is also the *only* free source of current
timetable data.

### What NTES gives

| Capability | Value to us |
|---|---|
| Train schedule (full stop list) | The connection graph |
| **`runs_days`** | Actual scheduled dates → weekday bitmask. **The 2016 community datasets wrongly assume every train runs daily.** |
| Trains between stations | Cross-validation |
| Live running status | Delay injection into CSA |
| Station boards | Efficient delay sweep (few hundred junctions cover most trains) |
| Cancelled / rescheduled / diverted trains | Critical — a diverted train's graph edges are wrong |
| Train type codes | `SUF`, `VNDB`, `DRNT`, `GBR`, `MEX`, `SUB` … |

### What NTES does **not** give

**Seat availability.** NTES is the *enquiry* system; availability lives in IRCTC's separate
**PRS** (Passenger Reservation System). This is the root of the whole availability problem
in [`03-availability.md`](03-availability.md).

### Client library

[`ntes-client`](https://pypi.org/project/ntes-client/) (MIT):

```
Endpoint      : https://enquiry.indianrail.gov.in/crisns/AppServAnd
Method        : POST
Content-Type  : application/json
User-Agent    : Android client signature
Used for      : train search, schedules, live status, station boards, exceptions
```

(Its PNR endpoint at `indianrail.gov.in/enquiry/CommonCaptcha` is captcha-gated and has a
high failure rate — we don't need PNR, so ignore it.)

### Hard-won field notes (from `railpull` — encode these as requirements)

1. **Read timeouts are mandatory.** The server sometimes accepts a connection then goes
   silent forever. Without a socket timeout, one dead read hangs the entire crawl.
2. **No "list all trains" endpoint.** Discover by number prefix: `000`, `001`, … `999`.
   NTES caps results at 60, so any prefix returning a full page is drilled one digit deeper
   (`125` → `1250`…`1259`). Union ≈ 12,000 numbers; roughly a fifth are discontinued.
3. **Search rejects queries shorter than 3 characters.** Hence 3-digit prefixes.
4. **Station boards only accept look-ahead windows of 2, 4 or 8 hours.** Other values error.
5. **A semantic "no" is not a network error.** Bad query or discontinued train returns a
   clean error — fail fast on those; back off only on real network trouble, or the crawl
   crawls.
6. **Type codes are NTES's, not the old community ones.** `SUF` (superfast, *not* `SF`),
   `VNDB`/`VNDM`/`VNDS` (Vande Bharat), `DRNT` (Duronto), `GBR` (Garib Rath), `MEX`
   (Mail/Express), `SUB` (suburban). Miscategorise these and the "superfast" bucket is empty.
7. **Board delays can be stale garbage.** A board occasionally reports a long-gone service
   as "57:18 late". Cap believable delays at 12 hours.
8. **Station codes changed.** Mughal Sarai → **DDU**; Allahabad → **Prayagraj**. Fresh
   crawls use current codes; maintain a rename map when merging older data.
9. **Default rate ~1 request / 1.2 s with jitter and backoff.** Do not lower it.
10. **Checkpoint progress** to `crawl-status.json`; re-runs must skip work already done.

---

## 5. `datameet/railways` — the CC0 bootstrap

[`github.com/datameet/railways`](https://github.com/datameet/railways) · 156 stars ·
**CC0** · three GeoJSON files: `stations.json`, `trains.json`, `schedules.json`.

```json
// stations.json — Point FeatureCollection
{"geometry":{"type":"Point","coordinates":[75.4516454,27.2520587]},
 "properties":{"state":"Rajasthan","code":"BDHL","name":"Badhal",
               "zone":"NWR","address":"Kishangarh Renwal, Rajasthan"}}

// trains.json — LineString FeatureCollection
{"properties":{"number":"01101","name":"Mumbai LTT - Gwalior (Weekly) Special",
   "from_station_code":"LTT","to_station_code":"GWL","zone":"CR","type":"Exp",
   "distance":1216,"duration_h":23,"duration_m":45,"return_train":"01102",
   "first_ac":true,"second_ac":true,"third_ac":true,"sleeper":true,
   "chair_car":true,"first_class":true}}

// schedules.json — one object per train-stop
{"train_number":"47154","train_name":"Falaknuma Lingampalli MMTS",
 "station_code":"FM","station_name":"KACHEGUDA FALAKNUMA",
 "arrival":"None","departure":"07:55:00","day":1,"id":302214}
```

### Why it matters

**CC0 means we can commit it to `main` and redistribute it freely** — which NTES-derived
data may not allow. That resolves the redistribution risk in
[`09-risks-legal.md`](09-risks-legal.md): CC0 data seeds the repo, NTES data is generated
into build artifacts.

### Why it isn't enough

It is a **2016 snapshot**. No Vande Bharat. Old station names (Mughal Sarai, Allahabad).
Changed schedules. And crucially, **no `runs_days`** — every train is implicitly daily,
which produces confidently wrong results. Use it to have something working on day one and
to keep the legal story clean; replace it with NTES data as Phase 1 lands.

Also note `schedules.json` uses `arrival: "None"` for origin stations and
`departure: "None"` for terminals — the parser must handle string `"None"`, not JSON null.

---

## 6. Wikidata SPARQL — the POI backbone

Keyless, CORS-enabled, CC0 output. Query all tourism-relevant entities in India with
coordinates in a handful of requests:

```sparql
SELECT ?item ?itemLabel ?coord ?type ?state WHERE {
  VALUES ?type { wd:Q5764562 wd:Q16970 wd:Q46169 wd:Q473972 wd:Q62849 wd:Q47505 }
  #              church    monastery  national_park  UNESCO-WHS   beach     museum
  ?item wdt:P31/wdt:P279* ?type .
  ?item wdt:P17 wd:Q668 .            # country: India
  ?item wdt:P625 ?coord .
  OPTIONAL { ?item wdt:P131 ?adm . ?adm wdt:P31/wdt:P279* wd:Q10864048 . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,hi". }
}
LIMIT 50000
```

Run variants for forts (`Q941024`), temples, hill stations, wildlife reserves, beaches,
waterfalls, caves, pilgrimage sites, and UNESCO World Heritage Sites. Deduplicate and
nearest-station-join at build time against station coordinates.

**Requirement:** send a descriptive `User-Agent` (Wikimedia blocks generic ones) and
respect the documented query-service limits — chunk with `LIMIT`/`OFFSET` and cache results
between runs. Output is **CC0**, so the derived POI index can be committed freely.

---

## 7. OSM Overpass — station geometry and live POIs

Keyless, CORS-enabled, ODbL.

```overpass
[out:json][timeout:90];
area["ISO3166-1"="IN"][admin_level=2]->.india;
(
  node(area.india)["railway"="station"];
  way(area.india)["railway"="station"];
);
out center tags;
```

OSM has ~17,000 Indian railway stations, ~11,000 tagged with the official station code —
so most match NTES directly by code, the rest by normalised name. Overpass enforces
timeout/maxsize quotas with cooldown; **paginate by state or bounding box** rather than
issuing one giant national query, and prefer the offline Geofabrik `.pbf` extract for the
heavy geometry work.

Also used for `aeroway=aerodrome` (→ `airports.json`) and `tourism=*`/`historic=*` within
N km of each station.

**Rail track geometry** for map polylines: `railpull`'s `route_tracks.mjs` builds a ~600k
node rail graph, snaps stations onto it, runs Dijkstra between consecutive-stop pairs, and
simplifies. That output is large — simplify aggressively (Douglas-Peucker), shard by
region, and **default to straight lines between stops**, drawing real geometry only when
zoomed in or on designated scenic routes.

⚠️ **ODbL obligations:** attribution ("© OpenStreetMap contributors") and share-alike for
any derived database we redistribute.

---

## 8. The training corpus for the availability model

**Kaggle — "Indian Railways Schedule-Prices-Availability Data"** · **Apache-2.0** ·
scraped from IRCTC in **October 2023** · contains public train schedules, pricing detail
and **real availability information**.

This is the key enabler for Tier 1. Apache-2.0 permits derivative works including a
trained model, with attribution. It is historical (2023) — which is fine for learning
*structural* patterns (which corridors waitlist, how WL grows as the date approaches, how
segment length affects allotment) and less good for current levels, which is why the model
output is a **probability band**, never a seat count.

Supplementary: the Kaggle **"Indian Trains Schedule & Routes"** dataset (MIT, updated
Sept 2025) has `trainNumber`, `trainName`, `runningDays`, and a full `trainRoute` array
with `arrives`/`departs`/`distance`/`day` per stop — a useful cross-check on NTES and
much more recent than datameet.

---

## 9. IRCTC's data model (what we must represent)

Captured from public IRCTC response shapes, so our schema matches reality:

### Availability status strings

| String | Meaning |
|---|---|
| `AVAILABLE-0042` | 42 seats available |
| `RAC 12` | Reservation Against Cancellation, position 12 (a shared berth; you *can* travel) |
| `GNWL14/RAC28` | General waitlist 14, RAC at 28 |
| `WL 23` | Waitlisted, position 23 |
| `REGRET` / `NOT AVAILABLE` | No further bookings accepted |

### Classes

`1A` First AC · `2A` AC 2-tier · `3A` AC 3-tier · `3E` AC 3-tier economy · `EA`/`EC`
Executive chair car/AC · `CC` Chair car · `FC` First class · `SL` Sleeper · `2S` Second
sitting · `UR`/`GEN` Unreserved

### Quotas

| Code | Quota | Notes |
|---|---|---|
| `GN` | General | Opens 08:00 IST, 60 days ahead |
| `TQ` | Tatkal | AC 10:00, non-AC 11:00, 1 day before **origin** departure; Aadhaar OTP; max 4 pax/PNR; no refund on confirmed; charge = 10% of basic fare (2S) / 30% (others), with min/max caps |
| `PT` | Premium Tatkal | Dynamic pricing |
| `LD` | Ladies | Female travelling alone or with child <12 |
| `SS` | Senior citizen | No concession under Tatkal |
| `HP` | Handicapped / Divyang (`DF`) | |
| `FT` | Freedom fighter | |
| `DF`/`DP` | Defence / Duty pass | |

### Train record shape

```json
{"trainNumber":"12138","trainName":"PUNJAB MAIL",
 "fromStnCode":"NDLS","toStnCode":"CSMT",
 "fromStnName":"NEW DELHI","fromStnNameHi":"नई दिल्ली","fromStnNameGu":"નઈ દિલ્હી",
 "fromStnDistrict":"Central","fromStnState":"Delhi",
 "fromStnLatitude":28.642314,"fromStnLongitude":77.22000399999999,
 "departureTime":"05:10","arrivalTime":"07:35",
 "distance":"1544","duration":"26:25",
 "runningMon":"Y","runningTue":"Y","runningWed":"Y","runningThu":"Y",
 "runningFri":"Y","runningSat":"Y","runningSun":"Y",
 "avlClasses":["1A","2A","3A","SL"],"trainType":["O"],
 "flexiFlag":"false","quota":"GN"}
```

Note `runningMon…runningSun` as separate flags (map to our `runsDays` bitmask), the
trilingual station names (carry them — free i18n), and `flexiFlag` for dynamic-fare trains.

---

## 10. Booking rules to encode in `rules.json`

Verified as of 2026:

| Rule | Value |
|---|---|
| **Advance Reservation Period** | **60 days** (reduced from 120 on 1 Nov 2024), excluding the date of journey → effectively opens 61 days before |
| General quota opening | **08:00 IST** on the day the window opens |
| Tatkal — AC (2A, 3A, 3E, CC, EC; **1A excluded**) | **10:00 IST**, 1 day prior |
| Tatkal — non-AC (SL, 2S) | **11:00 IST**, 1 day prior |
| Tatkal reference point | Departure from the **originating station**, *not* your boarding station |
| Tatkal auth | **Aadhaar OTP mandatory** on verified accounts |
| Tatkal pax limit | 4 per PNR |
| Tatkal charge | 10% of basic fare (2S) / 30% (all other classes), min & max capped |
| Tatkal refund | None on confirmed tickets |
| General pax limit | 6 per requisition for the same train |
| Current-availability booking | Opens ~8 h before departure (or 21:00 the previous evening for pre-14:00 departures), after first chart preparation; closes ~30 min before departure |
| IRCTC maintenance window | **23:45–00:20 IST** — booking unavailable |
| Intercity day trains | Some have an ARP **shorter than 60 days** — verify per train |

**Implementation trap:** Tatkal timing relative to *origin* departure, not boarding
station, is the most commonly gotten-wrong detail. Example: train 12927 departs Dadar
(origin) 23:50 on 24 Jan; a passenger boarding Borivali at 00:26 on 25 Jan gets Tatkal
opening on **23 Jan**, not 24 Jan. Encode `tatkalOpensAt = originDepartureDate − 1 day`
+ class-specific hour.

---

## 11. Deep-link URL builders

No API needed — plain URL construction, and the compliant way to reach ground truth.

| Target | Purpose |
|---|---|
| **IRCTC** train search / availability | Pre-filled per leg: train, from, to, date, class, quota → user sees real availability and books |
| **NTES** live status | `enquiry.indianrail.gov.in/mntes/` spot-your-train for the specific train |
| **redBus / AbhiBus** | Bus-leg verification and booking |
| **Google Flights / Skyscanner** | Air-leg verification |
| **Google Maps directions** | Road legs and cross-terminal transfers |
| **Wikipedia article** | "Read more about this place" |

Deep links are the honest answer to "how do I know this is real": we show our reasoning,
then hand off to the authoritative source in one click.

---

## 12. Sources evaluated and rejected

| Source | Why rejected |
|---|---|
| **eRail.in API** | Service **suspended**; historically required an email request for a key anyway |
| **railwayapi.com** | Free key, but 3-month validity and 100 hits/day — unusable at our query volume |
| **Apify IRCTC scraper** | $25/month + usage |
| **parse.bot IRCTC** | Credit-based, key required |
| **AOPAY** | IRCTC-authorised partner programme; enterprise only |
| **RailRadar free tier** | Real availability and genuinely free — but **1,000 requests/month** is ~50 searches. Kept as an *optional* Tier-4 upgrade, never a dependency. |
| **Google Maps / Mapbox APIs** | Keys required → violates the core constraint. MapLibre + OSM/Carto instead. |
| **GeoNames** | Requires a (free) username → still a setup step. Wikidata/OSM cover it keylessly. |
| **data.gov.in** | API key required |
| **Public CORS proxies as a primary path** | Unreliable, rate-limited, ToS-grey, and they break silently. Tier 3 only, opt-in, with automatic fallback. |

---

Next: [`03-availability.md`](03-availability.md)

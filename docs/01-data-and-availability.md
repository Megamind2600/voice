# 01 — Data sources and seat availability

Back to [`PLAN.md`](../PLAN.md) · Next: [`02-routing-and-discovery.md`](02-routing-and-discovery.md)

All sources verified **2026-09-12**. "Keyless" = no account, no email request, no card, no
configuration.

---

## 1. Source matrix

| # | Source | What we get | Auth | CORS | Limit | Licence | Role |
|---|---|---|---|---|---|---|---|
| 1 | **NTES** `enquiry.indianrail.gov.in` | timetable, `runs_days`, live status, station boards, cancels/diverts/reschedules | **none** | ❌ | unpublished — self-impose 1 req/1.2 s | public facts; redistribution caution | **L1 core**, build-time |
| 2 | `ntes-client` (PyPI) | MIT NTES wrapper | none | — | — | MIT | harvest library |
| 3 | `railpull` (GitHub) | polite crawler + exporter + delay poller + OSM geocoder | none | — | — | MIT | reference impl |
| 4 | **`datameet/railways`** | `stations/trains/schedules.json` (GeoJSON, 2016) | none | — | — | **CC0** | bootstrap + fallback |
| 5 | **Open-Meteo** | 16-day forecast, climate archive | **none** | ✅ | ~10k/day, 600/min | free **non-commercial** | season fit, dwell weather |
| 6 | **Wikipedia REST** | description, extract, coords, thumbnail | **none** | ✅ | fair use | CC BY-SA 4.0 | destination prose + photo |
| 7 | **Wikidata SPARQL** | Indian attractions, parks, UNESCO sites, airports w/ coords | **none** | ✅ | fair use, UA required | **CC0** | POI index |
| 8 | **OSM Overpass** | `railway=station`, `aeroway=aerodrome`, `tourism=*`, `historic=*` | **none** | ✅ | timeout/maxsize quotas | ODbL | station coords, POIs |
| 9 | Geofabrik India `.pbf` | offline OSM (~1.7 GB) | none | — | — | ODbL | heavy CI geometry work |
| 10 | **Kaggle IRCTC availability** | real availability strings + fares, Oct 2023 | free Kaggle account, once | — | — | **Apache-2.0** | Tier-1 training data |
| 11 | IRCTC public rule docs | fare slabs, quotas, ARP/Tatkal, refunds | none | — | — | public | `fares.json`, `rules.json` |
| 12 | RailRadar | real 14-day availability | **key** | ? | free **1,000 req/mo** | proprietary | *optional* T4 |
| 13 | RapidAPI `irctc1` / IndianRailAPI | `checkSeatAvailability` | **key** | ? | paid | proprietary | *optional* T4 |

**1–11 need no key.** 12–13 are optional upgrades, never on the critical path.

### Rejected

| Source | Why |
|---|---|
| eRail.in API | **Suspended**; needed an emailed key request anyway |
| railwayapi.com | Free key but 3-month validity, 100 hits/day |
| Apify IRCTC scraper | $25/month + usage |
| parse.bot IRCTC | credit-based, key required |
| AOPAY | IRCTC-authorised partner programme, enterprise only |
| **RailRadar free tier** | Real and free, but **1,000 req/month ≈ 50 searches**. Optional T4 only |
| Google Maps / Mapbox | Keys required → violates the core constraint |
| GeoNames, data.gov.in | Free account / key required → still a setup step |
| Public CORS relays as *primary* | Unreliable, rate-limited, ToS-grey, break silently. T3 only |

---

## 2. Verified live

### Open-Meteo — keyless, CORS enabled

```http
GET https://api.open-meteo.com/v1/forecast?latitude=28.61&longitude=77.21
    &daily=temperature_2m_max,precipitation_probability_max
    &timezone=Asia/Kolkata&forecast_days=3
```
```json
{"latitude":28.576448,"longitude":77.18678,"utc_offset_seconds":19800,
 "timezone":"Asia/Kolkata","elevation":217.0,
 "daily":{"time":["2026-09-12","2026-09-13","2026-09-14"],
          "temperature_2m_max":[31.8,32.3,30.3],
          "precipitation_probability_max":[75,84,95]}}
```

No key, no account, no registration. CORS works from browser JS with no proxy.

**Discipline:** one call accepts **multiple locations** (comma-separated lat/lon) and
multiple variables. Discovery mode shows ~8 destinations → **one batched call**, not eight.
Cache in IndexedDB 6 h. This keeps us orders of magnitude under the limit and costs
**zero Actions minutes**.

⚠️ Non-commercial only. Monetising requires the $29/mo tier.

### Wikipedia REST — keyless, CORS enabled

```http
GET https://en.wikipedia.org/api/rest_v1/page/summary/Jaipur
```
```json
{"title":"Jaipur","wikibase_item":"Q66485","description":"Capital of Rajasthan, India",
 "coordinates":{"lat":26.915,"lon":75.82},
 "thumbnail":{"source":"https://thumb.wikimedia.org/.../East_facade_Hawa_Mahal_Jaipur_...jpg"},
 "extract":"Jaipur is the capital and the largest city of the north-western Indian state of
 Rajasthan... also known as the Pink City..."}
```

**Fetch at runtime, not build time.** Bundling ~2,000 summaries costs ~800 KB for content
most users never open. Lazy fetch on card expand, cache indefinitely, send a descriptive
`User-Agent` (Wikimedia blocks generic ones), attribute on every card.

`hi.wikipedia.org` and regional wikis share the API shape — free i18n extracts later.

---

## 3. NTES — the official enquiry service

Free, keyless, and the only free source of **current** timetable data.

| Gives | Value |
|---|---|
| Train schedule (full stop list) | the connection graph |
| **`runs_days`** | actual scheduled dates → weekday bitmask. The 2016 datasets wrongly assume daily |
| Live running status | runtime delay display |
| Station boards | efficient delay sweep |
| Cancelled / rescheduled / diverted | critical — a diverted train's edges are wrong |
| Type codes | `SUF` `VNDB` `DRNT` `GBR` `MEX` `SUB` … |

| Does **not** give | |
|---|---|
| **Seat availability** | NTES is *enquiry*; availability lives in IRCTC's separate **PRS**. This is the root of [§5](#7-the-five-tier-cascade) |

Endpoint (via `ntes-client`, MIT):
```
POST https://enquiry.indianrail.gov.in/crisns/AppServAnd
Content-Type: application/json     User-Agent: Android client signature
→ train search, schedules, live status, station boards, exceptions
```
(Its PNR endpoint is captcha-gated with a high failure rate. We don't need PNR.)

### Field notes — encode these as requirements

Hard-won from `railpull`; each one is a bug you will otherwise hit.

1. **Read timeouts are mandatory.** The server sometimes accepts a connection then goes
   silent forever; one dead read otherwise hangs the whole crawl.
2. **No "list all trains" endpoint.** Discover by number prefix `000`…`999`. Results cap at
   60, so a full page means drill one digit deeper (`125` → `1250`…`1259`). Union ≈ 12,000
   numbers, ~a fifth discontinued.
3. **Search rejects queries shorter than 3 characters.** Hence 3-digit prefixes.
4. **Station boards accept only 2, 4 or 8-hour look-ahead windows.** Other values error.
5. **A semantic "no" is not a network error.** Bad query / discontinued train returns a
   clean error — fail fast; back off only on real network trouble, or the crawl crawls.
6. **Type codes are NTES's, not the community's.** `SUF` (superfast, *not* `SF`),
   `VNDB`/`VNDM`/`VNDS` Vande Bharat, `DRNT` Duronto, `GBR` Garib Rath, `MEX` Mail/Express,
   `SUB` suburban. Miscategorise and the "superfast" bucket is empty.
7. **Board delays can be stale garbage** — a long-gone service reported "57:18 late". Cap
   believable delays at 12 h.
8. **Station codes changed**: Mughal Sarai → **DDU**, Allahabad → **PRYJ**. Maintain a rename
   map when merging vintages, or the graph silently fragments.
9. **~1 request / 1.2 s with jitter and backoff.** Never lower it.
10. **Checkpoint** to `crawl-status.json`; re-runs skip completed work.

---

## 4. `datameet/railways` — the CC0 bootstrap

CC0, three GeoJSON files. **CC0 means we can commit and redistribute it freely** — which
NTES-derived data may not permit. That resolves the redistribution risk in
[`04-roadmap-and-risks.md`](04-roadmap-and-risks.md).

```jsonc
// stations.json
{"geometry":{"type":"Point","coordinates":[75.4516454,27.2520587]},
 "properties":{"state":"Rajasthan","code":"BDHL","name":"Badhal","zone":"NWR"}}
// trains.json
{"properties":{"number":"01101","name":"Mumbai LTT - Gwalior (Weekly) Special",
  "from_station_code":"LTT","to_station_code":"GWL","type":"Exp","distance":1216,
  "duration_h":23,"return_train":"01102","sleeper":true,"third_ac":true}}
// schedules.json
{"train_number":"47154","station_code":"FM","arrival":"None","departure":"07:55:00","day":1}
```

**Not sufficient alone:** 2016 snapshot — no Vande Bharat, old station names, changed
schedules, and **no `runs_days`** (everything implicitly daily). Use it to work on day one
and keep the legal story clean; supersede with NTES data in Phase 1.

**Parser trap:** `arrival`/`departure` use the **string** `"None"`, not JSON null.

---

## 5. Booking rules → `rules.json`

| Rule | Value |
|---|---|
| **Advance Reservation Period** | **60 days** (reduced from 120 on 1 Nov 2024), excluding journey date → effectively opens 61 days before |
| General quota opening | **08:00 IST** on the day the window opens |
| Tatkal — AC (2A, 3A, 3E, CC, EC; **1A excluded**) | **10:00 IST**, 1 day prior |
| Tatkal — non-AC (SL, 2S) | **11:00 IST**, 1 day prior |
| **Tatkal reference point** | departure from the **originating** station, *not* your boarding station |
| Tatkal auth | **Aadhaar OTP** mandatory on verified accounts |
| Tatkal limits | 4 pax/PNR · no senior concession · **no refund** on confirmed |
| Tatkal charge | 10% of basic fare (2S) / 30% (others), min & max capped |
| General limit | 6 pax per requisition, same train |
| Current-availability booking | opens ~8 h before departure (or 21:00 prior evening for pre-14:00 departures) after first chart; closes ~30 min before |
| IRCTC maintenance | **23:45–00:20 IST** — booking unavailable |
| Intercity day trains | some have ARP **< 60 days** — verify per train |

### The trap worth its own test case

> Tatkal opens one day before departure **from the origin**, not your boarding station.

Train **12927** departs **Dadar (origin) 23:50 on 24 Jan**. A passenger boarding **Borivali
at 00:26 on 25 Jan** gets Tatkal opening on **23 Jan** — not 24 Jan. Get this wrong and you
tell users to wait a day for a window that already opened.

```ts
const tatkalOpensAt = (train, boardingStn, cls) => {
  const originDep = originDepartureDateTime(train, boardingStn); // resolve the run day
  return atHourIST(subtractDays(originDep, 1), isAC(cls) ? 10 : 11);   // 1A excluded
};
const generalOpensAt = train =>
  atHourIST(subtractDays(originDepartureDate(train), train.arpDays), 8);
```

---

## 6. IRCTC data model (what we must represent)

### Availability strings

| String | Meaning |
|---|---|
| `AVAILABLE-0042` | 42 seats available |
| `RAC 12` | Reservation Against Cancellation, position 12 — shared berth, **you can travel** |
| `GNWL14/RAC28` | general waitlist 14, RAC at 28 |
| `WL 23` | waitlisted, position 23 |
| `REGRET` / `NOT AVAILABLE` | bookings closed for this segment |

### Classes
`1A` `2A` `3A` `3E` `EA`/`EC` `CC` `FC` `SL` `2S` · `UR`/`GEN` unreserved

### Quotas

| Code | Quota | Notes |
|---|---|---|
| `GN` | General | 08:00 IST, 60 days ahead |
| `TQ` | Tatkal | see §5 |
| `PT` | Premium Tatkal | dynamic pricing |
| `LD` | Ladies | female alone or with child <12 |
| `SS` | Senior citizen | no concession under Tatkal |
| `HP`/`DF` | Handicapped / Divyang | |
| `FT` | Freedom fighter | |
| `DP` | Duty pass | |

### Train record shape

```json
{"trainNumber":"12138","trainName":"PUNJAB MAIL",
 "fromStnCode":"NDLS","toStnCode":"CSMT",
 "fromStnName":"NEW DELHI","fromStnNameHi":"नई दिल्ली","fromStnNameGu":"નઈ દિલ્હી",
 "fromStnLatitude":28.642314,"fromStnLongitude":77.220004,
 "departureTime":"05:10","arrivalTime":"07:35","distance":"1544","duration":"26:25",
 "runningMon":"Y","runningTue":"Y","runningWed":"Y","runningThu":"Y",
 "runningFri":"Y","runningSat":"Y","runningSun":"Y",
 "avlClasses":["1A","2A","3A","SL"],"trainType":["O"],"flexiFlag":"false","quota":"GN"}
```

`runningMon…Sun` → our `runsDays` bitmask. The trilingual station names are **free i18n** —
harvest and store them.

---

## 7. The five-tier cascade

```
                 query(train, from, to, date, class, quota)
                                │
  T4 BYOK key in localStorage? ─┴─yes─▶ REAL 14-day availability
                                │ no
  T3 probe enabled + relay up?  ┴─yes─▶ LIVE*  (unofficial, 8s timeout, silent fallback)
                                │ no
  T1 prediction model           ┴─────▶ PREDICTED pConfirm ± CI      ← DEFAULT, always works
                                │ uses
  T0 static quota + rake        ┴─────▶ capacity denominator, quota pools

  T5 IRCTC deep link ─────────────────▶ emitted for EVERY result, every tier, always
```

**T2 (scheduled corridor snapshots) was cut.** With no keyless availability source it was
aspirational, and it cost Actions minutes we no longer spend.

### The result type

```ts
interface AvailabilityResult {
  segment: SegmentRef;
  verdict: 'AVAILABLE'|'RAC'|'WAITLISTED'|'REGRET'|'UNKNOWN';
  seats?: number;            // only when AVAILABLE and actually known
  wlPosition?: number; racPosition?: number; wlType?: string;
  pConfirm?: number; pConfirmCI?: [number,number]; expectedWl?: number;
  source: 'REAL'|'LIVE'|'SNAPSHOT'|'PREDICTED'|'UNKNOWN';
  fetchedAt?: number;
  confidence: 'high'|'medium'|'low';
  remedies: RemedyRef[];
}
```

**Non-negotiable:** no code path renders `PREDICTED` without its badge — enforced by a lint
rule *and* a component test.

---

## 8. Tier 0 — quota and rake reference

The **denominator**. You cannot reason about "will WL 23 clear" without knowing how many
berths exist.

```jsonc
{ "12138": { "type":"MEX", "origin":"FZR", "destination":"CSMT", "runsDays":127,
    "classes":["1A","2A","3A","SL"],
    "rake": {"1A":1,"2A":3,"3A":8,"SL":12,"UR":4},
    "berthsPerCoach": {"1A":18,"2A":46,"3A":64,"SL":72},
    "flexiFare": false, "quotaPools":["GN","TQ","LD","SS","HP","DF"], "arpDays":60 } }
```

12138 SL capacity = `12 × 72 = 864` berths. **WL 23 against 864 berths on a daily
trunk-route train is a completely different proposition from WL 23 against a 2-coach
weekly** — and only this tier lets you tell them apart.

---

## 9. Tier 1 — the prediction model (the default)

Predicts a **distribution**, not a seat count: `pConfirm`, `pRac`, `expectedWl`, and a 90%
interval. Same class of output ConfirmTkt/ixigo expose as "confirmation probability" — but
ours runs **entirely in the browser from a bundled coefficient table**. No server, no key,
no network call, microsecond inference.

### Features (all static — no live data needed)

| Group | Signals | Why it predicts |
|---|---|---|
| Window position | days-to-journey (0–60); booking open yet; hours to Tatkal | Demand accumulates monotonically; curve shape is regular |
| Calendar | day-of-week (Fri/Sun/Mon peaks); festival proximity **and direction**; school-vacation window; gazetted-holiday adjacency | Festival corridors see 5–20× demand |
| Train | type (VNDB > DRNT/RAJ > SHB > SUF > MEX > SUB > PAX); flexi flag; class capacity; daily/weekly | Premium rarely WLs in top classes; weeklies on migrant corridors WL instantly |
| **Segment** ⭐ | `isFullRun`; distance as % of run; boarding index; crosses a quota-change station; <200 km hop | **Strongest group.** Quota is allotted preferentially to long/full-run segments; short hops often return `REGRET` while the same train end-to-end is available |
| Corridor | congestion (# trains on the pair); trunk-route flag; demand rank | Trunk routes have both more demand and more supply |
| Station rank | metro / junction / intermediate / halt, both ends | Demand correlates strongly with rank |
| Class | one-hot | SL and 3A carry most waitlisting; 1A/EC almost never; 2S near-unreserved |
| Quota | one-hot | Separate pools; LD and SS often clear when GN doesn't |
| Directional | peak direction for this day/festival? | Chhath: Delhi→Patna WL, Patna→Delhi empty, then it reverses |

⭐ The segment group is what lets the model **predict that splitting at Ratnagiri will work
before issuing any query** — making leg-splitting proactive rather than trial-and-error.

### Shipped form

GBM trained offline → **distilled to a calibrated coefficient table** (~150 KB, ~40 KB
brotli). Inference is a few lookups and a sigmoid, inside the same worker as the router, so
remedy exploration costs nothing extra.

```jsonc
{ "version":"2026.09", "trainedOn":"kaggle-irctc-2023-10 + heuristics",
  "calibration":{"method":"isotonic","bins":[[0.02,0.05],[0.05,0.12]]},
  "intercept":-1.83,
  "numeric":{
    "daysToJourney":{"kind":"piecewiseLinear","knots":[0,1,3,7,15,30,60],
                     "coef":[-0.42,-0.31,-0.18,-0.09,-0.03,0.01,0.02]},
    "segmentDistPct":{"kind":"piecewiseLinear","knots":[0,0.15,0.4,0.7,1.0],
                      "coef":[-1.15,-0.62,-0.18,0.09,0.34]},
    "logCapacity":{"kind":"linear","coef":-0.21}},
  "categorical":{
    "class":{"SL":0.00,"3A":-0.18,"2A":-0.74,"1A":-1.62,"CC":-0.31,"EC":-0.88,"2S":0.95},
    "quota":{"GN":0.00,"TQ":-0.55,"PT":-0.30,"LD":-0.95,"SS":-1.10},
    "trainType":{"VNDB":-0.62,"DRNT":-0.88,"RAJ":-0.95,"SHB":-0.71,"SUF":0.00,"MEX":0.24,"SUB":1.05},
    "dow":{"Mon":0.22,"Tue":-0.05,"Wed":-0.09,"Thu":0.03,"Fri":0.41,"Sat":0.11,"Sun":0.35}},
  "festivalMultiplier":{"chhath":2.8,"diwali":2.4,"durgaPuja":2.1,"eid":1.7,"holi":1.6},
  "wlClearanceCurveByCapacity":"…" }
```

### Training data and its honest limitation

Primary: Kaggle *Indian Railways Schedule-Prices-Availability* (**Apache-2.0**, IRCTC scrape
Oct 2023, real availability strings + fares). Supplementary: Kaggle *Indian Trains Schedule
& Routes* (MIT, Sept 2025) as a cross-check on NTES.

⚠️ **The corpus is from 2023** and predates the ARP reduction (120→60 days). It teaches
*structural* patterns well — which corridors waitlist, how segment length affects allotment,
how WL grows with proximity — but not *current absolute levels*. That is exactly why output
is a **probability band, never a seat count**, and why intervals are wide.

### Calibration gates (CI, committed as artifacts)

- Isotonic calibration on a **temporal** hold-out (train earlier dates, test later — random
  splitting leaks seasonality)
- Brier score and log loss vs. baselines (constant-rate, class-only, corridor-only)
- **Per-corridor error** — right on average but catastrophic on Delhi–Patna during Chhath is
  not acceptable; report worst corridors explicitly
- **Decision-quality metric:** of segments predicted `pConfirm > 0.8`, what fraction actually
  confirmed? That is the number users experience
- Retrained quarterly; report diffed against the previous run

### Presentation

Never a bare number:

```
WL 23 · 62% likely to confirm (±9%)                    [PREDICTED]
└ based on: daily trunk-route train, 864 SL berths, 12 days out,
  no festival within 10 days, segment = 84% of run.
  Similar segments confirmed at this WL 6 times in 10.
```

---

## 10. Tier 3 — opt-in live probe

Best-effort, designed to fail invisibly:

- **Off by default**, behind an explicit toggle with a plain-language warning
- 8 s timeout, one retry, then give up — never block the UI
- Labelled `LIVE* · unofficial · may be wrong`
- Relay chain A→B→C, then fall through to Tier 1
- Cached in IndexedDB 30 min; in-flight de-duplication (remedy exploration would otherwise
  fire hundreds of near-identical probes)
- Client-side rate limited
- **Any error → `fallbackApplied: true`** and a valid Tier-1 answer. The user never sees a
  failure from this tier.

⚠️ ToS-grey. Relays come and go — which is why this is T3 and never a dependency. **If it
feels wrong, ship without it**: T0/T1/T5 are a complete product.

Also used for the **runtime NTES live-status path** that replaced the deleted cron
([`PLAN.md` §8](../PLAN.md#8-github-actions-budget)) — same relay mechanism,
same silent degradation, but for delays/cancellations rather than availability, which is
both more defensible and more useful.

---

## 11. Tier 4 — optional bring-your-own-key

```
┌─ Live availability (optional) ─────────────────────────────────┐
│ RailRoam works fully without this. A key upgrades predictions  │
│ to real 14-day availability.                                   │
│ Provider ( ) none ( ) RailRadar ( ) RapidAPI ( ) other         │
│ API key    [ ____________________ ]                            │
│ Stored only in this browser. Never sent to us. Never committed.│
│                                        [ Save ]  [ Remove ]    │
└────────────────────────────────────────────────────────────────┘
```

- **Default: none.** Fully functional without it.
- `localStorage` only; never leaves the browser except to its provider; `.gitignore` covers
  `secrets.json`, `.env*`
- RailRadar's 1,000 req/month means the UI must show remaining budget and **hard-stop** at
  exhaustion. **Ration it:** spend key credits only on the *final* legs of journeys the user
  actually opens, never during search — one discovery sweep would otherwise burn the month's
  quota instantly

---

## 12. Tier 5 — IRCTC deep links (always)

Every leg and every remedy carries a pre-filled IRCTC URL for its exact
`(train, from, to, date, class, quota)`, plus an NTES live-status link.

This is the honest resolution: **we do the reasoning the user can't do by hand** (network
search, segment decomposition, 7 remedies, multi-criteria ranking, discovery); **IRCTC
provides the authoritative facts and the transaction.** We stay inside Pages' no-e-commerce
policy, handle no payments, store no PNRs, and never misrepresent a prediction.

---

## 13. Status parsing

```ts
const PATTERNS: [RegExp, (m: RegExpMatchArray) => Partial<AvailabilityResult>][] = [
  [/^AVAILABLE[- ]?0*(\d+)$/i, m => ({verdict:'AVAILABLE', seats:+m[1]})],
  [/^RAC\s*0*(\d+)/i,          m => ({verdict:'RAC', racPosition:+m[1]})],
  [/^(GNWL|WL|RLWL|PQWL|RSWL|CKWL|TQWL)\s*0*(\d+)\s*\/\s*RAC\s*0*(\d+)/i,
                               m => ({verdict:'WAITLISTED', wlPosition:+m[2],
                                      racPosition:+m[3], wlType:m[1]})],
  [/^(GNWL|WL|RLWL|PQWL|RSWL|CKWL|TQWL)\s*0*(\d+)/i,
                               m => ({verdict:'WAITLISTED', wlPosition:+m[2], wlType:m[1]})],
  [/^(REGRET|NOT\s*AVAILABLE|NO\s*SEATS)/i, () => ({verdict:'REGRET'})],
];
```

**Waitlist types must not be collapsed** — a common and serious bug:

| Type | Meaning | Clearance |
|---|---|---|
| `GNWL` | General | Best odds |
| `RLWL` | Remote Location (intermediate stn) | Poor; small quota |
| `PQWL` | Pooled (short intermediate segment) | **Worst**; frequently never clears |
| `RSWL` | Roadside | Small quota |
| `CKWL`/`TQWL` | Tatkal | **Never** clears — no cancellation cascade |

`PQWL 8` is materially worse than `GNWL 8`.

---

## 14. Worked example: the cascade in action

**Query:** Pune → Madgaon, Fri 18 Sep, SL, GN, 1 adult.

```
T4  no user key                                    → skip
T3  probe disabled                                 → skip
T1  features: MEX train · 12 days out · Fri · SL · GN · segment = 84% of run
            · boarding index 4 · corridor congestion 3 (low) · 864 SL berths
            · no festival within 10 days
    → pConfirm 0.38, expectedWl 23, CI [0.29,0.47]
    → WAITLISTED, confidence medium, source PREDICTED

    LegSplitter on that verdict:
      ① split at RN (Ratnagiri, 15 min halt)
           PUNE→RN  pConfirm 0.94   (segment 51% of run → high allotment)
           RN→MAO   pConfirm 0.97
           combined 0.91            ▲ +0.53          ← BEST REMEDY
      ② date +1: SL AVAILABLE-0112  ▲ +0.62, but changes the travel date
      ③ quota →TQ: window not open  ▲ deferred, opens 10:00 tomorrow
      ④ class →3A: pConfirm 0.71    ▲ +0.33, but +₹580
      ⑥ terminal:  PUNE none; MAO ↔ VSG (Vasco) 30 km road bridge
      ⑦ bus:       Pune→Panaji ~9h ₹700–1,400 est, then rail AVAILABLE-0205

    ranked → [①split at RN] [②shift date] [⑦bus bridge] [④3A] [③Tatkal later]

T5  IRCTC deep links for the original segment AND every remedy segment
```

The model **predicted** that splitting at Ratnagiri would work *before any live query*,
using the segment-length feature. That is Tier 1 doing real work — and it is exactly the
requested behaviour: *"if not available in single leg then divide it into multiple legs."*

And because the split lands the traveller in Ratnagiri with a 6h20m dwell, the stopover
logic promotes it to a destination: POIs from the bundled index, weather from Open-Meteo, a
Wikipedia extract fetched lazily. **A waitlist problem became a better trip.**

---

## 15. Acceptance criteria

- [ ] Every availability figure carries a visible provenance badge
- [ ] No code path can render `PREDICTED` as `REAL` (lint rule + component test)
- [ ] Fully functional with T0/T1/T5 only, network disabled after first load
- [ ] Calibration report committed; Brier beats the class-only baseline by a stated margin
- [ ] `PQWL 8` scores materially worse than `GNWL 8`
- [ ] Tatkal arithmetic passes the **12927 Dadar/Borivali** case → opens 23 Jan
- [ ] App works with ARP = 60 days; rejects dates beyond the window and says when booking opens
- [ ] T3 failure yields a degraded valid answer, never a user-visible error
- [ ] T4 key exhaustion hard-stops probing and falls back cleanly
- [ ] Every leg and remedy has a working IRCTC deep link
- [ ] Same-train splits always show halt duration + berth-change + two-ticket warnings
- [ ] Open-Meteo called **once, batched**, per discovery run (assert call count)

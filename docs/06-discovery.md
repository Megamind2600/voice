# 06 — Discovery mode: "I have no destination in mind"

Back to [`PLAN.md`](../PLAN.md)

This is the differentiator. Every existing Indian rail app requires you to already know
where you're going. This mode exists for the person who knows only **where they are** and
**when they're free**.

---

## 1. The insight that makes it cheap

A normal query runs CSA from an origin to *one* destination. But CSA's forward scan
computes **earliest arrival at every station simultaneously** — that is inherent to the
algorithm, not an extra feature.

So a **single pass** over the ~290k-connection array, from the origin at the departure
time, yields a complete reachability table for all of India:

```
one CSA sweep  →  { station: [earliestArrival, cheapestFare, bestConfidence, legs] }
                  for ~8,000 stations
```

Cost ≈ one ordinary query, under ~400 ms in a worker. Discovery mode is therefore not an
expensive batch job — it is a different *presentation* of a query the engine already
answers. This is the strongest argument for CSA over Dijkstra or Transfer Patterns in this
project.

---

## 2. Pipeline

```
┌─ 1. SWEEP ─────────────────────────────────────────────────────────────┐
│ CSA from origin @ departDate, horizon = maxTravelHours (default 24)    │
│ Criteria: arrival, transfers, fare, worstLegConfidence                 │
│ → reachability table for ~8,000 stations                              │
└───────────────────────────────┬───────────────────────────────────────┘
                                ▼
┌─ 2. FILTER ────────────────────────────────────────────────────────────┐
│ · drop stations with no POIs within 25 km                              │
│ · drop stations reachable only with > maxTransfers                     │
│ · drop stations whose best journey has worstLegConfidence < threshold  │
│   (configurable; default 0.35 — "don't suggest a trip I can't book")   │
│ · collapse multi-station cities to one destination (terminal groups)   │
│ · drop the origin's own city and its suburbs                           │
│ → ~8,000 → ~600–1,200 candidate destinations                           │
└───────────────────────────────┬───────────────────────────────────────┘
                                ▼
┌─ 3. ENRICH (parallel, bounded, cached) ────────────────────────────────┐
│ · POI index (bundled)      → what's there, suggested dwell hours       │
│ · Open-Meteo (batched)     → weather at arrival + seasonal fit         │
│ · Fare engine (local)      → round-trip cost estimate                  │
│ · Wikipedia (lazy)         → prose + photo, only when card expanded    │
└───────────────────────────────┬───────────────────────────────────────┘
                                ▼
┌─ 4. SCORE ─────────────────────────────────────────────────────────────┐
│ weighted composite, weights exposed as user sliders                    │
└───────────────────────────────┬───────────────────────────────────────┘
                                ▼
┌─ 5. DIVERSIFY ─────────────────────────────────────────────────────────┐
│ · max 2 per state / region                                             │
│ · MMR (maximal marginal relevance) to avoid near-duplicates            │
│ · guarantee at least one budget option and one offbeat option          │
└───────────────────────────────┬───────────────────────────────────────┘
                                ▼
┌─ 6. PRESENT ───────────────────────────────────────────────────────────┐
│ "8 journeys you could take this week"                                  │
│ each a full multi-leg itinerary with per-leg availability + remedies   │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Scoring

```ts
interface DestinationScore {
  availabilityScore: number;  // 0.25  can you actually get a seat?
  seasonFit:         number;  // 0.20  is it a good time to be there?
  interestMatch:     number;  // 0.20  does it match what the user likes?
  journeyQuality:    number;  // 0.15  scenic, comfortable, sane timings
  budgetFit:         number;  // 0.10  within stated budget
  durationFit:       number;  // 0.05  matches "days I want to be there"
  novelty:           number;  // 0.05  offbeat bonus / over-tourism penalty
}
```

Weights are defaults, **exposed as sliders**, and renormalised when a component is
unavailable (e.g. Open-Meteo fails → drop `seasonFit`, rescale the rest).

### 3.1 `availabilityScore` (0.25)

Not just "is the outbound bookable" — the *worst leg* across the round trip, blended with
how many remedies exist:

```
availabilityScore = 0.7 × worstLegConfidence
                   + 0.2 × meanLegConfidence
                   + 0.1 × remedyHeadroom        // do good fixes exist?
```

A destination reachable only via WL 60 on every option scores near zero and is filtered
out. **This is the criterion that makes discovery mode honest**: suggesting a beautiful
place the user cannot get a ticket to is worse than not suggesting it.

### 3.2 `seasonFit` (0.20) — Open-Meteo, keyless

Two components:

**Forecast fit** — 16-day daily forecast for the actual travel window:

| Condition | Effect |
|---|---|
| Heavy monsoon rain (>100 mm/wk) | Strong penalty for beaches, treks, hill roads; **Ladakh/Spiti effectively closed** |
| Extreme heat (>42 °C) | Penalty for Rajasthan plains, Delhi, UP in May |
| Pleasant (18–30 °C, low rain) | Bonus |
| Cold/snow in Himalayas (Dec–Feb) | **Bonus** for snow destinations, penalty for the unprepared |
| High AQI (>200, Nov–Jan) | Penalty for Delhi NCR, Kanpur, Lucknow, Patna |

**Climate-normal fit** — `/v1/archive` gives 80 years of history, so "is September a good
month for Goa" is answered from data rather than a hardcoded table. Precompute a monthly
suitability matrix per destination at build time (one archived call per destination per
month, cached forever) so runtime needs only the short forecast.

This also powers a genuinely novel filter the user hinted at with *"preferred direction"*:

> **"Away from the monsoon"** — in September, exclude any destination whose forecast shows
> heavy precipitation and surface the rain-shadow options instead (e.g. from Mumbai in
> July: skip the Konkan and the Western Ghats, suggest Ladakh, Spiti, or the Deccan
> plateau east of the Ghats).

No hardcoded seasonality table can do that; a keyless weather API can.

### 3.3 `interestMatch` (0.20)

User tags, each mapping to POI types in the index:

| Tag | POI types matched |
|---|---|
| `beaches` | `natural=beach`, coastal stations, Q62849 |
| `mountains` | elevation > 1,000 m, hill stations, Himalayan rail lines |
| `wildlife` | national park (Q46169), tiger reserves, bird sanctuaries |
| `temples` / `spiritual` | Q5764562, pilgrimage sites, jyotirlingas, gurudwaras |
| `forts` / `heritage` | Q941024, UNESCO World Heritage Sites (Q9259), Q16970 |
| `food` | curated city list (Lucknow, Hyderabad, Amritsar, Kolkata, Chennai, Delhi, Pune, Indore) |
| `trekking` | trailheads, elevation gain, proximity to ranges |
| `offbeat` | **inverted popularity** — low `trainCount`, few POIs flagged as major, low lodging density |
| `nightlife` | metro-tier cities only |

With no tags selected (the default), use a broad mix weighted toward generally
high-satisfaction categories, so the first-run experience is good without onboarding.

### 3.4 `journeyQuality` (0.15)

- **Scenic bonus** for designated scenic routes: Konkan Railway, Nilgiri Mountain Railway,
  Kangra Valley, Darjeeling Himalayan, Kalka–Shimla, Matheran Hill, Nilambur–Shoranur,
  the Bhor Ghat and Thull Ghat sections, Vindhyachal–Katni. These are enumerable from OSM
  route relations plus a short curated list. Include the practical tip: *"Konkan Railway —
  sit on the LEFT going south."*
- **Vande Bharat / Rajdhani / Duronto bonus** for comfort and reliability.
- Penalty for 02:00–05:00 arrivals, for > 24 h total travel, for journeys needing more
  than 2 berth changes.
- Bonus when the outbound has a **pleasant dwell** (a stopover worth enjoying).
- Bonus for low average delay (from the NTES 7-day averages) — reliability is quality.

### 3.5 `budgetFit` (0.10), `durationFit` (0.05), `novelty` (0.05)

`durationFit` uses `suggestedDwellHours` from the POI index against the user's stated days:
suggesting a 6-hour town for a 5-day holiday is a bad match, and so is suggesting Jaipur
for a single day.

`novelty` inverts popularity when `offbeat` is selected, using station `trainCount` and
POI significance as proxies. This makes "somewhere I've never heard of" a real, computable
request.

---

## 4. Diversification

Without it, the top 8 from Pune are all in Maharashtra and Goa. Apply:

- **Max 2 destinations per state**, max 3 per region.
- **MMR** (maximal marginal relevance): iteratively pick the candidate maximising
  `λ·score − (1−λ)·max_similarity_to_already_picked`, where similarity combines bearing
  from origin, distance band, and interest-tag overlap.
- **Guaranteed slots**: at least one budget option (₹<1,500 round trip), at least one
  offbeat option, at least one with high availability confidence (>0.85) so the user always
  sees something genuinely bookable.

---

## 5. Presentation

```
┌──────────────────────────────────────────────────────────────────────────┐
│  You're free 18–22 Sep from Pune. 8 journeys you could take.            │
│                                                                          │
│  [ sliders: certainty ◀━━●━━▶ adventure    budget ◀━━●━━▶ comfort ]     │
│  [ filters: ☑beaches ☑mountains ☐temples ☐wildlife  ☑away from monsoon ]│
└──────────────────────────────────────────────────────────────────────────┘

 ┌─────────────────────┐ ┌─────────────────────┐ ┌─────────────────────┐
 │ 🏖 GOA              │ │ 🏔 MAHABALESHWAR     │ │ 🛕 KOLHAPUR         │
 │ score 91            │ │ score 87             │ │ score 82            │
 │                     │ │                      │ │                     │
 │ 2 legs · 14h 05m    │ │ direct · 4h 20m      │ │ direct · 5h 10m     │
 │ ₹1,240 round trip   │ │ ₹620 round trip      │ │ ₹480 round trip     │
 │                     │ │                      │ │                     │
 │ ● Availability      │ │ ● Availability       │ │ ● Availability      │
 │   worst leg 62%     │ │   AVAILABLE-0140     │ │   AVAILABLE-0205    │
 │   → 94% if split    │ │                      │ │                     │
 │                     │ │                      │ │                     │
 │ ☔ Weather           │ │ ☔ Weather            │ │ ☔ Weather           │
 │   28°C · 80% rain   │ │   22°C · 65% rain    │ │   27°C · 40% rain   │
 │   monsoon — indoor  │ │   good for the Ghats │ │   fine              │
 │                     │ │                      │ │                     │
 │ ✦ Scenic: Konkan    │ │ 📍 12 POIs · 2 days  │ │ 📍 9 POIs · 1 day   │
 │   Railway           │ │                      │ │                     │
 │                     │ │                      │ │                     │
 │ [See itinerary →]   │ │ [See itinerary →]    │ │ [See itinerary →]   │
 └─────────────────────┘ └─────────────────────┘ └─────────────────────┘
        … 5 more
```

Each card expands into the full multi-leg itinerary from [`PLAN.md` §2](../PLAN.md) —
per-leg availability with provenance badges, ranked remedies, stopover suggestions,
inter-modal alternatives, and IRCTC deep links.

**Sort and re-rank live** as sliders move — scoring is client-side and instant, no
re-query needed. This makes exploration feel playful rather than transactional, which is
the right tone for someone who doesn't know where they want to go.

---

## 6. Handling the optional inputs

### Round trip

Not two independent one-ways. Availability is **directional and asymmetric**:

```
Fri 18 Sep  Delhi → Patna   WL 80    (Chhath rush outward)
Fri 18 Sep  Patna → Delhi   AVL 210  (empty the other way)
Sun 27 Sep  Patna → Delhi   WL 95    (post-festival return rush)
```

So outbound and return are **jointly optimised** under a shared transfer/time/budget
constraint (see [`04-routing-engine.md` §11](04-routing-engine.md#11-round-trip-joint-optimisation)),
and **open-jaw** returns are offered when they help: go to Madgaon, come back from Vasco
or Karwar.

The festival calendar makes this predictive rather than reactive: the app can say
*"Chhath is 25 Sep — Delhi→Patna will be severely waitlisted 22–25 Sep and again
28 Sep–1 Nov returning. Travel 18 Sep and return 24 Sep instead."*

### Direction preference

Compass sector (N/NE/E/SE/S/SW/W/NW), state, or region — applied as a destination filter
plus a scoring bias. Also supports **negative** framing, which is often more useful:

- "away from the monsoon" → Open-Meteo precipitation exclusion
- "away from the cold" → temperature floor
- "away from the crowds" → festival-calendar + popularity exclusion
- "not too far" → travel-hour ceiling

### Days at destination

Feeds `durationFit` and constrains the return search date when round-trip is on. Also
enables advice like *"staying 4 days puts your return on a Sunday, the worst day for
Goa→Delhi — returning Monday is AVAILABLE-0140."*

### Holiday awareness

Bundle an Indian public-holiday calendar (national + state gazetted) plus school-vacation
windows. Three uses:

1. **Crowd/WL warnings** — long weekends and festival adjacencies spike demand.
2. **Computing how many days the user actually has** — "you said 18–22 Sep; 20 Sep is a
   gazetted holiday in Maharashtra, so that's effectively a 5-day window."
3. **Date-shift advice** — "leave 2 days earlier and availability is far better."

---

## 7. The honest hard cases

Discovery mode must not fabricate connectivity that doesn't exist.

| Region | Reality | What the app must do |
|---|---|---|
| **Northeast** | Rail reach is genuinely thin. **Guwahati** and **Siliguri/New Jalpaiguri** are the practical gateways. Several states have limited or no broad-gauge reach. | Surface the gateway station + an inter-modal bridge (bus/air). Label rail-only reachability accurately. Never imply Dimapur or Agartala is an easy rail trip from Delhi when it isn't. |
| **Ladakh** | **No rail.** | Present as air/road only, with the Jammu or Pathankot railhead + road bridge. Say plainly that rail cannot reach it. |
| **Andaman / Lakshadweep** | **No rail at all.** Air (and ship for Lakshadweep) only. | Show as air/sea destinations with an explicit "not reachable by train" label. Still worth surfacing — the user wants to explore India, not only explore it by rail. |
| **Kashmir** | The Udhampur–Srinagar–Baramulla line changes this; verify current status in the crawl rather than hardcoding. | Let the harvested data decide. Do not hardcode network topology — it changes. |
| **Rural/branch lines** | Sparse, often passenger-only, unreserved. | Mark unreserved services clearly: no availability concept applies, and the travel experience differs fundamentally. Don't apply the WL model to a `SUB`/`PAX` train. |

The rule: **when rail cannot do it, say so and offer the alternative mode** — exactly what
the user asked for with *"suggest to travel till here by a different mode of transport."*
Pretending otherwise would destroy trust in every other suggestion.

---

## 8. Cold start and caching

| Concern | Approach |
|---|---|
| First run has no user preferences | Use the broad default interest mix; guarantee budget + offbeat + high-certainty slots so the first result set is good |
| Sweep cost on low-end devices | Region-shard: sweep one zone at a time, merge results. Or cap the horizon to 16 h initially and offer "expand to all India" |
| Repeat runs | Cache the reachability table per `(origin, date, criteria)` in IndexedDB for the session; slider changes re-rank without re-sweeping |
| Open-Meteo budget | One **batched** multi-location call for all shown destinations (~8), cached 6 h. Not 8 calls. |
| Wikipedia budget | Lazy per card expansion only. Most users open 1–3 of 8. |

---

## 9. Acceptance criteria

- [ ] Origin + date only (nothing else filled in) produces ≥ 6 ranked, distinct
      destination cards in < 3 s total on a mid-range device
- [ ] Every card shows a per-leg availability verdict with a provenance badge
- [ ] Every card whose worst leg is waitlisted shows at least one remedy
- [ ] No two cards are in the same state unless the user has < 8 viable options
- [ ] `seasonFit` reflects real forecast data, not a hardcoded table — verifiable by
      changing the travel date into monsoon and seeing Konkan destinations drop
- [ ] A Northeast query produces a gateway + inter-modal bridge, never a fictional direct
      train
- [ ] Ladakh and the islands are labelled "not reachable by train" with an air/road option
- [ ] Slider changes re-rank instantly (< 100 ms) without re-sweeping
- [ ] Round-trip mode jointly optimises and offers open-jaw when it helps
- [ ] Festival-calendar warnings appear for Chhath/Diwali corridors in the relevant window
- [ ] "Away from the monsoon" measurably changes the result set in July vs December
- [ ] Unreserved/suburban services are excluded from WL modelling and labelled differently

---

Next: [`07-ui-ux.md`](07-ui-ux.md)

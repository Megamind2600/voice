# 07 — UI / UX

Back to [`PLAN.md`](../PLAN.md)

---

## 1. Design principles

| # | Principle | Consequence |
|---|---|---|
| 1 | **Two fields, then value.** | The first screen asks only origin and date. Everything else is a collapsible "refine" panel with sane defaults. A user who fills nothing else still gets a great answer. |
| 2 | **Never show a dead end.** | Every waitlisted leg ships with ranked, explained remedies. A result that says "WL 40" and stops is a failure of the product. |
| 3 | **Provenance is always visible.** | `LIVE` · `SNAPSHOT 42m` · `PREDICTED 62%±9%` · `YOUR KEY`. A prediction must never be able to masquerade as a reservation. |
| 4 | **Explain, don't just recommend.** | Every split, shift and bridge carries a plain-language reason. The user's brief was explicit about wanting the reasoning shown. |
| 5 | **Estimates are labelled estimates.** | Bus/flight/road durations and costs are modelled, not timetabled. Say so inline. |
| 6 | **A forced transfer is an opportunity.** | Long dwells become stopover cards with POIs, weather and photos — not apologetic gaps. |
| 7 | **One click to ground truth.** | Every leg has an IRCTC deep link. We plan; IRCTC books. |
| 8 | **Fast before pretty.** | Autocomplete works at ~120 KB. Full search works at ~2.3 MB. Progress is real and cancellable. |
| 9 | **Works offline.** | The timetable graph is a PWA asset. Only live signals need network, and each degrades silently. |
| 10 | **Accessible and multilingual.** | WCAG 2.2 AA; availability never conveyed by colour alone; `en` + `hi` at minimum. |

---

## 2. Screen map

```
                    ┌──────────────┐
                    │   Landing    │  origin + date, 2 fields, nothing else
                    └──────┬───────┘
                           │
              ┌────────────┴────────────┐
              │  destination given?     │
              └───┬─────────────────┬───┘
              yes │                 │ no
                  ▼                 ▼
        ┌──────────────┐   ┌────────────────┐
        │   Results    │   │   Discovery    │  "8 journeys you could take"
        │ ranked list  │   │  dest. cards   │
        └──────┬───────┘   └───────┬────────┘
               │                   │
               └─────────┬─────────┘
                         ▼
               ┌──────────────────┐
               │ Journey Detail   │  legs, map, remedies, stopovers
               └────┬────────┬────┘
        apply remedy│        │explore stopover
                    ▼        ▼
            ┌──────────┐  ┌──────────────┐
            │ re-plan  │  │ Destination  │  POIs, weather, photos, dwell
            └──────────┘  └──────────────┘

  cross-cutting:  DateFlex heatmap · Settings · Saved trips · About/Data & disclaimer
```

---

## 3. Landing / Search

```
┌────────────────────────────────────────────────────────────────┐
│  RailRoam                                      [≡] [Settings]  │
│                                                                │
│  You have some free days. Where could you go?                  │
│                                                                │
│  ┌──────────────────────────────┐  ┌────────────┐              │
│  │ Starting from        ▾       │  │ Leaving on │              │
│  │ Pune, Maharashtra  (PUNE)    │  │ 18 Sep 2026│              │
│  └──────────────────────────────┘  └────────────┘              │
│                                                                │
│  ┌──────────────────────────────┐                              │
│  │ Going to?   (optional)       │  ← empty = discovery mode    │
│  │ Leave blank and we'll suggest│                              │
│  └──────────────────────────────┘                              │
│                                                                │
│              [ ✦  Show me where I could go ]                   │
│                                                                │
│  ▸ Refine  (return date · budget · class · transfers ·         │
│             direction · interests · round trip)                │
│                                                                │
│  ────────────────────────────────────────────────────────────  │
│  ⚙ Loading network… 2.4 MB · 68% · [cancel]                   │
│  ────────────────────────────────────────────────────────────  │
│  Data: NTES timetable (built 3 days ago) · live delays 42m ago │
│  Unofficial. Not affiliated with Indian Railways or IRCTC.     │
└────────────────────────────────────────────────────────────────┘
```

### Station autocomplete

- Fuzzy match on code, name, city, and multilingual variants (`मुंबई`, `મુંબઈ`, `Mumbai`).
- Always show the **top 5 with disambiguation** — a silently-wrong origin is the worst
  failure mode in the app.
- Show terminal-group hints: picking "Mumbai" offers CSTM/BCT/LTT/DR/PNVL and explains
  they are different stations ~60–90 min apart.
- `lat,lon` fallback via the geolocation API (opt-in, permission-gated, never stored).

### The "Refine" panel — every field optional with a visible default

```
Return date        [ none — one way ]        ☐ Make it a round trip
Days at destination[ not set ]
Direction          [ anywhere ▾ ]  N NE E SE S SW W NW · or a state/region
                                    ☐ Away from the monsoon
                                    ☐ Away from the crowds
Budget (total)     [ no limit ]
Classes            ☑3A ☑SL ☐2A ☐1A ☐CC ☐EC ☐2S
Quotas             ☑GN ☐Tatkal ☐Ladies ☐Senior
Travellers         1 adult · 0 children · 0 seniors   ☐ Female only (LD quota)
Max transfers      ●━●━● 2
Max travel hours   ●━●━● 24
☐ Avoid overnight travel      ☑ Prefer scenic routes
☑ Allow bus bridges  ☑ Allow flight bridges  ☑ Allow road
☑ Suggest stopovers worth exploring
Interests          ☐beaches ☐mountains ☐wildlife ☐temples ☐forts
                   ☐food ☐trekking ☐offbeat ☐spiritual ☐heritage
Date flexibility   ± ●━●━● 2 days
```

Defaults are chosen so that a user who never opens this panel gets sensible behaviour —
and so that discovery mode (empty destination) is the *encouraged* path.

---

## 4. Results list

```
┌────────────────────────────────────────────────────────────────┐
│  Pune → Madgaon · Fri 18 Sep · 1 adult · SL/3A                 │
│  23 journeys found · sorted by [certainty ▾]                   │
│                                                                │
│  ⓘ Direct options are waitlisted. 6 involve a split or bridge. │
│  ⓘ Tatkal for these trains opens in 6h 12m.                    │
└────────────────────────────────────────────────────────────────┘

 ┌─ BEST CERTAINTY ────────────────────────────────────────────┐
 │ 94%  ·  2 legs  ·  ₹750  ·  9h 05m  ·  split at Ratnagiri   │
 │                                                             │
 │  PUNE 20:10 ──11099 SL──▶ RATNAGIRI 01:05                   │
 │           ⚠ 15 min halt · berth change · 2 tickets          │
 │  RATNAGIRI 04:30 ──10111 SL──▶ MADGAON 07:40                │
 │           ✦ Konkan Railway — sit LEFT going south           │
 │                                                             │
 │  [See details]   [Verify on IRCTC ↗]   [Save]               │
 └─────────────────────────────────────────────────────────────┘

 ┌─ FASTEST ───────────────────────────────────────────────────┐
 │ 38%  ·  direct  ·  ₹460  ·  5h 55m  ·  WL 23 → 2 remedies   │
 │  PUNE 20:10 ──11099 SL──▶ MADGAON 02:05                     │
 │  [See details]                                              │
 └─────────────────────────────────────────────────────────────┘

 ┌─ MIXED MODE ────────────────────────────────────────────────┐
 │ 97%  ·  bus + 1 train  ·  ₹990 est  ·  12h 30m              │
 │  PUNE 21:00 ══bus (est. ₹700–1,400, ~9h)══▶ PANAJI 06:00    │
 │  PANAJI 07:15 ──12635 SL AVAILABLE-0205──▶ MADGAON 08:20    │
 │  [See details]   [Search bus on redBus ↗]                   │
 └─────────────────────────────────────────────────────────────┘

 ┌─ SHIFT THE DATE ────────────────────────────────────────────┐
 │ Sat 19 Sep · direct · AVAILABLE-0112 · ₹460                 │
 │  [See details]                                              │
 └─────────────────────────────────────────────────────────────┘
```

**Grouping by strategy** (best certainty / fastest / cheapest / mixed mode / shift date)
rather than one flat list is important: it teaches the user that these are *different kinds
of answer*, which is the whole point of the app.

**Sort options:** certainty · total time · cost · fewest transfers · comfort · scenic.

---

## 5. Journey detail — the core screen

This is the card from [`PLAN.md` §2](../PLAN.md) rendered. Structure per leg:

```
┌─ LEG 1 ───────────────────────────────────────────────────────┐
│ 🚆 11099 · LOKMANYA TILAK T - MADGAON EXPRESS   [Mail/Express]│
│                                                               │
│  PUNE JN (PUNE)          5h 55m          MADGAON (MAO)        │
│  dep 20:10 Fri 18 Sep  ───────────────▶  arr 02:05 Sat 19 Sep │
│  platform 3            330 km            platform 1           │
│                                                               │
│  Class SL · GN quota · ₹460 · runs daily                      │
│                                                               │
│  ┌─ AVAILABILITY ───────────────────────────────────────────┐ │
│  │  WL 23                            [PREDICTED 62% ±9%]    │ │
│  │  Confirmation odds 62% · similar segments cleared 6/10   │ │
│  │  Based on: daily trunk train, 864 SL berths, 12 days out,│ │
│  │  no festival within 10 days, segment = 84% of run        │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                               │
│  ⚠ Not comfortable. Fixes, best first:                        │
│                                                               │
│  ┌─ FIX A · split this leg ──────────── ▲ +53% certainty ───┐ │
│  │ PUNE→RATNAGIRI  AVAILABLE-0041  [PREDICTED 94%]          │ │
│  │ RATNAGIRI→MAO   AVAILABLE-0017  [PREDICTED 97%]          │ │
│  │ Halt at Ratnagiri 15 min — berth change will be rushed.  │ │
│  │ Needs 2 separate tickets on the same train. This is a    │ │
│  │ grey area under IRCTC rules — verify before travelling.  │ │
│  │                              [Apply this fix]            │ │
│  └──────────────────────────────────────────────────────────┘ │
│  ┌─ FIX B · shift date ──────────────── ▲ +62% certainty ───┐ │
│  │ Sat 19 Sep, same train, SL AVAILABLE-0112                │ │
│  │                              [Apply this fix]            │ │
│  └──────────────────────────────────────────────────────────┘ │
│  ▸ 3 more fixes (class → 3A, quota → Tatkal, bus bridge)      │
│                                                               │
│  [ Verify on IRCTC ↗ ]  [ Live status on NTES ↗ ]             │
│  [ Full route & all stops ]                                   │
└───────────────────────────────────────────────────────────────┘
```

Between legs, when dwell > 3 h:

```
┌─ ◆ STOPOVER · RATNAGIRI · 6h 20m ─────────────────────────────┐
│ Why here: splitting the leg puts you in Ratnagiri anyway —     │
│ and it's worth the time.                                       │
│                                                               │
│ ☔ Weather on arrival  28°C · 80% chance of rain                │
│    Monsoon — plan indoor. Fort is exposed; palace is covered.  │
│                                                               │
│ 📍 Nearby                                                    │
│   Ratnadurg Fort        3.1 km   fort      worth ~2h          │
│   Thibaw Palace         2.4 km   museum    worth ~1h          │
│   Ganpatipule Temple   12.0 km   temple    worth ~2h          │
│   Bhatye Beach          6.0 km   beach     monsoon: avoid     │
│                                                               │
│ 🛏 41 lodging options within 3 km of the station               │
│ 📖 Ratnagiri is a coastal town in Maharashtra, known for       │
│    Alphonso mangoes and the sea fort of Ratnadurg…   [photo]   │
│    — Wikipedia                                                │
│                                                               │
│ Suggested dwell: 6h · or make it an overnight and leave       │
│ tomorrow on 10111 (AVAILABLE-0140)                            │
│                                                               │
│ [ Explore Ratnagiri → ]   [ Re-plan with an overnight here ]   │
└───────────────────────────────────────────────────────────────┘
```

Plus an **itinerary timeline** (vertical, time-scaled, so a 6-hour dwell *looks* like
6 hours next to a 45-minute halt), a **route map** with polylines and scenic segments
highlighted, and a **totals footer**:

```
Totals  ₹1,240 rail · 14h 05m moving · 2 tickets · 1 berth change
Worst-leg confidence  62% → 94% if you apply FIX A
[Verify all legs on IRCTC ↗] [Export .ics] [Export PDF] [Copy share link] [Save]
```

---

## 6. Date-flex heatmap

Often the highest-value screen in the whole app. Rows = class, columns = date, cells carry
**both colour and a text label** (colour alone fails colour-blind users).

```
              Mon14    Tue15    Wed16    Thu17    Fri18    Sat19    Sun20
  SL        AVL 41   AVL 88   no run   WL 12    WL 23   AVL 112   WL 31
  3A        WL 06    AVL 14   no run   RAC 03   WL 18   AVL 27    RAC 09
  2A        AVL 04   AVL 11   no run   AVL 06   AVL 02  AVL 15    AVL 08
  1A        AVL 02   AVL 06   no run   AVL 04   AVL 01  AVL 09    AVL 05

  Legend:  AVAILABLE ▓▓▓  RAC ▓▓  WL ▓  REGRET ░  no run · (train doesn't
  operate Wednesdays — this is not the same as "sold out")
  All values PREDICTED unless marked. Tap a cell to re-plan for that date.
```

Note the `no run` distinction: a weekly train not operating on Wednesday is a **different
fact** from being sold out, and conflating them produces nonsense advice.

---

## 7. Component inventory

| Component | Responsibility | Notes |
|---|---|---|
| `StationAutocomplete` | fuzzy multilingual station/city/coords resolution | top-5 disambiguation, terminal-group hints |
| `RefinePanel` | all optional inputs | collapsible; every default visible |
| `JourneyCard` | one ranked result | grouped by strategy |
| `LegCard` | one train/bus/flight/road leg | the most-used component in the app |
| `AvailabilityBadge` | provenance + value | `LIVE` · `SNAPSHOT 42m` · `PREDICTED 62%±9%` · `YOUR KEY` |
| `AvailabilityExplanation` | why the model said this | expands on request |
| `RemedyPanel` | ranked fixes | shows confidence gain, cost delta, risk, explanation |
| `SplitWarning` | berth-change / two-ticket / halt-time caveats | **mandatory** on same-train splits |
| `IntermodalCard` | bus/flight/road variant | always labelled "estimate" |
| `StopoverCard` | dwell as destination | POIs, weather, lodging, Wikipedia |
| `DateFlexHeatmap` | date × class availability grid | text + colour; `no run` distinct |
| `RouteMap` | MapLibre polylines, scenic highlight, terminal markers | Leaflet fallback |
| `ItineraryTimeline` | vertical time-scaled view | dwells visually proportional |
| `DestinationCard` | discovery grid item | score, legs, cost, weather, POI count |
| `ScoreSliders` | live re-weighting | re-ranks without re-sweeping |
| `ProvenanceFooter` | dataset ages, sources, disclaimer | on every screen |
| `ExportDialog` | .ics / PDF / share link | share link encodes the query in the URL fragment |
| `SettingsPanel` | defaults, Tier-3 toggle, Tier-4 BYO-key | key stays in localStorage |

---

## 8. Export and sharing

| Format | Contents |
|---|---|
| **.ics** | One `VEVENT` per leg with station, platform, times, train number, class; plus a `VEVENT` per suggested stopover. Includes reminders scaled to halt times. |
| **PDF** | Printable itinerary: legs, times, fares, availability at plan time **with provenance and timestamp**, remedies, stopover notes, IRCTC links, disclaimer. |
| **Share link** | The full query encoded in the URL **fragment** (`#origin=PUNE&date=2026-09-18&…`) so it never reaches server logs. Recipient gets the same plan. |
| **Copy as text** | Plain-text itinerary for WhatsApp/SMS — the dominant sharing channel in India. |

Every export carries the plan timestamp and a "availability was predicted at plan time —
verify on IRCTC" line. An exported itinerary must never look like a ticket.

---

## 9. Visual design

- **Palette:** railway-signal inspired — deep navy/charcoal base, saffron and green accents
  (a nod to the Indian flag without being kitsch), plus a **semantic availability scale**
  that is colour-blind-safe (viridis-like, not red/green): green → yellow → orange → red is
  the intuitive mapping but fails ~8% of male users, so use **blue → teal → amber → deep
  orange** with mandatory text labels.
- **Typography:** a Devanagari-capable system stack (`Noto Sans`, `Noto Sans Devanagari`)
  so station names render correctly in Hindi and regional scripts without shipping webfonts.
  If webfonts are needed, subset them hard.
- **Dark mode** by default with `prefers-color-scheme` respect — night trains are planned at
  night.
- **Mobile-first.** Most Indian users are on phones, often mid-range Android with throttled
  CPUs. Test the worker query latency on a 4× CPU-throttle profile.
- **Density control:** compact / comfortable toggle — power users planning a 5-leg journey
  need compact.

---

## 10. Accessibility

- Full keyboard navigation; visible focus rings; logical tab order through async results.
- **Availability never by colour alone** — every heatmap cell and badge carries text.
- ARIA live regions for "searching…", result counts, and remedy application.
- `aria-describedby` linking each prediction to its explanation.
- Respect `prefers-reduced-motion` (no animated route-drawing).
- Minimum 4.5:1 contrast on all text, 3:1 on UI components.
- Screen-reader itinerary summary: a linearised text version of the journey, since the
  timeline and map are inherently visual.
- Target **WCAG 2.2 AA**.

---

## 11. i18n

- `en` and `hi` at launch; string extraction pipeline so `ta te bn mr gu kn ml pa or as ur`
  can be added without code changes.
- Station names are already multilingual in IRCTC's data (`fromStnNameHi`, `fromStnNameGu`)
  — **harvest and store them**; the display language then switches for free.
- `Intl` with `en-IN`: lakh/crore digit grouping, 12-hour clock with AM/PM (as Indian users
  expect), IST throughout, ₹ currency.
- Dates always shown with weekday and explicit day-of-month, because overnight journeys
  cross date boundaries and "arr 02:05" without "Sat 19 Sep" is ambiguous.
- Remedy explanations and stopover narratives need translation too — not just labels.
  Budget for this; it is the most commonly skipped i18n work.

---

## 12. Empty, error and degraded states

| State | Copy approach |
|---|---|
| No journeys found | Never "nothing found". Say why and offer the next step: *"No rail route works within 24 h / 2 transfers. Try: allow a bus bridge · extend to 30 h · allow 3 transfers · shift date ±2."* Each is a tappable action. |
| Network genuinely unreachable | *"Pune and Agartala aren't connected by a practical rail journey. Here's how people actually make this trip: fly Pune→Agartala (via Kolkata), or rail to Guwahati + bus/air."* Honest inter-modal advice over a fake train. |
| Everything waitlisted | Show the best-odds waitlist with clearance probability **and** every remedy, plus "Tatkal opens in 6h 12m" if applicable. |
| Dataset stale (> 7 days) | Banner: *"Timetable data is 9 days old. Verify timings on NTES."* with a link. |
| Live snapshot failed | Hide live badges silently. No error. |
| Weather unavailable | Omit the weather row; renormalise scores. No error. |
| Wikipedia unavailable | Show POIs without prose/photos. No error. |
| Worker out of memory | Region-shard the search and retry automatically. |
| JS disabled | A static "about + how it works + why this needs JS" page. Don't fake it. |

The governing rule: **every degraded state must still answer the user's question**, just
with less confidence and more honesty.

---

Next: [`08-roadmap.md`](08-roadmap.md)

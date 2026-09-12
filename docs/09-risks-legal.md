# 09 — Risks, legal and ethics

Back to [`PLAN.md`](../PLAN.md)

Not legal advice. This is a practical risk register for a hobby-scale, non-commercial,
free public-interest project. If the project ever becomes commercial or high-traffic, get
real counsel.

---

## 1. Risk register

| # | Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|---|
| R1 | **Redistributing bulk NTES data** breaches operator terms | Med | Med | Seed from CC0; generate NTES data in CI into the deploy artifact; attribution; disclaimer; see §3 |
| R2 | NTES blocks or rate-limits the crawler | Med | Med | Polite defaults (1.2 s + jitter + backoff), resumable, read timeouts, bounded live sweep, CC0 fallback |
| R3 | **Prediction mistaken for a reservation** → user misses a train | **High** | Med | Mandatory provenance badges, lint-enforced; IRCTC deep link on every leg; wide intervals; never show a seat count from a prediction |
| R4 | **Same-train two-ticket splitting challenged by TTE staff** | Med | Med | Mandatory disclosure on every split: halt time, berth change, two tickets, grey area, "verify with IRCTC"; see §4 |
| R5 | GitHub Pages ToS — no e-commerce | Low | Low | We never book or take money; deep-link out only |
| R6 | Open-Meteo free tier is **non-commercial** | Low | Low | Non-commercial project. If ever monetised → $29/mo tier required |
| R7 | OSM **ODbL** share-alike on derived databases | Med | High (if ignored) | Attribution; treat derived station/POI databases as ODbL; see §5 |
| R8 | Wikipedia **CC BY-SA** attribution | Med | High (if ignored) | Visible "Wikipedia" credit + link on every extract/image; see §5 |
| R9 | IRCTC ToS breach via Tier-3 relay scraping | Med | Med | **Opt-in, off by default**, clearly labelled unofficial, rate-limited, silently degrading. Ship without it if uncomfortable |
| R10 | Training corpus (Kaggle, Oct 2023) is stale | Med | **High** | Output probability bands, not counts; per-corridor error gates; continuous improvement from Tier-2 snapshots; honest labelling |
| R11 | Kaggle download needs an account | Low | Low | One-time developer action at training time; never user-facing; heuristic-only fallback path documented |
| R12 | Timetable staleness → wrong times | Med | Med | Weekly cron; visible dataset age; `ProvenanceFooter`; NTES deep link for verification |
| R13 | Live cancellation/diversion missed → user goes to a station for a cancelled train | **High** | Med | 6 h live cron; conservative TTL; prominent "verify live status" link; never claim currency we don't have |
| R14 | Fare estimate wrong | Low | High | Label "estimated"; deep-link to IRCTC for the authoritative fare |
| R15 | Public CORS relays disappear | Low | **High** | Tier 3 is opt-in with a relay chain and silent fallback; never a dependency |
| R16 | Bandwidth (100 GB/month soft limit) | Low | Low | ~2.7 MB worst-case session → ~37k sessions/month; service worker + IndexedDB cut repeat cost to near zero |
| R17 | Repo/site exceeds 1 GB | Low | Low | Dataset ~3 MB; raw crawl corpus cached in Actions, never committed; Geofabrik `.pbf` never committed |
| R18 | Bundle/data size rot | Med | High (over time) | CI budget gate **fails the build** on regression |
| R19 | Perceived as an official railway product | Med | Med | Prominent disclaimer on every screen and in exports; no IRCTC/Indian Railways branding or logos; name clearly independent |
| R20 | Accessibility failure excludes users | Med | Med | WCAG 2.2 AA target; axe-core in CI; availability never by colour alone |

---

## 2. The honest headline risks

Three deserve emphasis because they are the ones that could actually hurt a user:

**R3 — prediction mistaken for reservation.** This is the highest-severity product risk.
Someone books nothing because our UI said "AVAILABLE" when it meant "62% likely". Controls:
provenance badges enforced by lint rule *and* component test, wide confidence intervals,
no seat counts ever emitted from Tier 1, an IRCTC deep link on every single leg, and a
"verify before booking" line in every export.

**R4 — the two-ticket split.** Real and widely practised, but a regulatory grey area.
See §4.

**R13 — missed cancellation.** A user arriving at a station for a cancelled train because
our snapshot was 6 hours stale. Controls: conservative TTL, visible snapshot age, a
prominent NTES live-status link on every leg, and never claiming currency we don't have.
For same-day travel the app should push the user to NTES explicitly.

---

## 3. NTES data redistribution — the subtlest issue

`railpull`, the reference implementation this plan builds on, **deliberately ships tools
rather than data**. Its own reasoning:

> "The schedules are public facts, but bulk collection and **redistribution** of the data
> may run against the operator's terms of use — which is exactly why this repo ships the
> *tools* and not a dataset. If you publish data you collect, that's your call and your
> responsibility."

That is a considered position from someone who has actually done the crawl, and this plan
takes it seriously rather than hand-waving it.

### Mitigation: separate the *tool* from the *data*

```
main branch (public source, permanently redistributed)
└── site/data/seed/           ← CC0 datameet/railways ONLY. Licence-clean.
                                 Bootstraps the app and keeps the legal story simple.

CI-generated (deployment artifact / orphan gh-pages branch)
└── site/data/generated/      ← NTES-derived timetable, produced fresh by Actions.
                                 gitignored in main. Not part of the source tree.
```

- The **harvester code** is committed (MIT-licensed, like `ntes-client` and `railpull`).
- The **NTES-derived dataset** is generated at build time into the deployment artifact,
  never committed to the source tree. `.gitignore` covers `data/raw/`, `data/out/` and
  `site/data/generated/`.
- Anyone can reproduce the dataset by running the workflow. That is the same posture
  `railpull` takes, and it is the defensible one.
- The **CC0 seed** means the repo contains a complete, licence-clean dataset at all times,
  so the app is never dependent on the NTES corpus being redistributable.

### Also do

- Prominent attribution: "Timetable data derived from the National Train Enquiry System
  (NTES), Indian Railways. Unofficial."
- Prominent disclaimer: "Not affiliated with, endorsed by, or sponsored by Indian Railways,
  IRCTC, CRIS, or the Ministry of Railways."
- Respect `robots.txt`; verify before deploying.
- Keep crawl rates gentle and **never lower the pause** to make CI faster.
- Consider writing to CRIS to request non-commercial data access. They have historically
  had a non-commercial licence category for exactly this kind of free public-utility app.
  A polite request costs nothing and could turn the grey area into a green one.
- If ever served a takedown, comply promptly and fall back to the CC0 dataset. The
  architecture is designed so this is survivable rather than fatal.

### What is NOT a concern

Individual **factual lookups** (one train's schedule, one station's timings) are ordinary
use of a public enquiry service — what any traveller does on the NTES website. The
sensitivity is specifically about **bulk collection and republication**. The seed/generated
split addresses exactly that.

---

## 4. Same-train, two-ticket segment splitting

The single most user-visible legal/ethical question in the product, because remedy ① is
often the best answer.

### The situation

IRCTC's fare and reservation rules contemplate **one ticket per journey**. Holding two
tickets for *consecutive segments of the same physical train* is:

- **commonly done** and widely discussed in traveller communities,
- **generally tolerated** in practice,
- but **not explicitly blessed** by rule, and
- potentially challengeable by ticket-checking staff, who may view it as an attempt to
  circumvent quota allotment.

There are also practical consequences the user must know: they may have to **physically
change berths or coaches** mid-journey, sometimes with a short halt, sometimes at night.

### Non-negotiable product controls

Every same-train split the app suggests **must** display, inline and non-dismissibly:

```
⚠ About this split
  · Requires TWO separate tickets for consecutive segments of the SAME train.
  · You will need to change berths/coaches at RATNAGIRI.
  · The halt is 15 minutes — that is a rushed change. Bring light luggage.
  · IRCTC rules contemplate one ticket per journey. This arrangement is commonly
    practised but sits in a grey area and could in principle be questioned by
    ticket-checking staff. Verify with IRCTC before travelling.
  · If either segment does not confirm, you may be left holding a partial journey.
```

Additional rules:

- **Never** suggest a split with halt < 10 min.
- **Warn** below 20 min.
- **Never** present a split as risk-free or as the only option — always show the direct
  waitlisted option alongside it so the user can choose the compliant path.
- **Never** suggest anything that could be read as fare evasion (e.g. booking a shorter
  segment and travelling further — that is ticketless travel and is straightforwardly
  prohibited). The app splits only where the passenger genuinely **alights and reboards**
  on separate valid tickets.
- Do not suggest splitting to exploit a cheaper fare combination where the intent is
  clearly circumvention. Confidence-gain is the only ranking signal; cost arbitrage is not.
- Consider a first-run explainer ("How splitting works and what to watch out for") so users
  are not surprised at 2 a.m. in Ratnagiri.

**The honest framing:** the app should present splitting as *"a strategy experienced
travellers use, with these trade-offs"* — not as *"a trick that works."*

---

## 5. Licence and attribution matrix

| Data / dependency | Licence | Obligation | Where satisfied |
|---|---|---|---|
| `datameet/railways` seed dataset | **CC0** | None | Committed to `site/data/seed/`; credited as good practice |
| NTES-derived timetable | Public factual data; **redistribution caution** | See §3 | Generated in CI, not committed to `main` |
| `ntes-client` | MIT | Retain copyright notice | `harvester/requirements.txt` + NOTICE |
| `railpull` (patterns, not code) | MIT | Retain notice if code is copied | NOTICE + inline comments crediting it |
| OpenStreetMap (station coords, POIs, rail geometry, airports) | **ODbL** | Attribution **+ share-alike** on derived databases | "© OpenStreetMap contributors" in footer and on every map; derived station/POI databases treated as ODbL |
| Geofabrik India extract | ODbL (inherits OSM) | Same | Same |
| Wikidata | **CC0** | None | Credited anyway |
| Wikipedia extracts & images | **CC BY-SA 4.0** | Attribution + share-alike + link to licence | Visible "Wikipedia" credit with a link on every card showing an extract or image |
| Wikimedia thumbnails | Various free licences | Per-file attribution | Pass through the source licence from the API response |
| Kaggle IRCTC availability corpus | **Apache-2.0** | Attribution + state changes | Credit in `docs/03-availability.md` and in the model's `trainedOn` field |
| Kaggle Indian Trains Schedule & Routes | MIT | Retain notice | NOTICE |
| Open-Meteo | Free **non-commercial** | No key; attribution appreciated; **paid tier if commercial** | Footer credit; non-commercial use asserted in README |
| IRCTC public rule documents | Public information | None | `rules.json` carries a "source & date verified" comment |
| Preact, Vite, MapLibre, Leaflet, Zustand, Vitest, Playwright | MIT / Apache-2.0 / BSD | Retain notices | Bundled `NOTICE` / `THIRD-PARTY-LICENSES` file |

### Share-alike is the one to think about

ODbL and CC BY-SA are **copyleft**. If we redistribute a *derived database* built from OSM
or Wikipedia content, that derived database must be offered under the same terms. Practical
consequences:

- The station coordinate table and POI index (derived from OSM/Wikidata) should be
  published under **ODbL** (Wikidata is CC0, so only the OSM-derived parts are affected).
- Bundled Wikipedia extracts would be CC BY-SA. **Avoid this by fetching at runtime** —
  which [`05-data-pipeline.md` §5](05-data-pipeline.md#5-geo-and-poi-harvest) already
  prescribes for both size and licence reasons. Runtime fetching with attribution keeps us
  clean and the bundle small.
- Our **own code** stays MIT. Copyleft on data does not infect application code.
- Add a `LICENSE` (MIT for code) plus `DATA-LICENSES.md` spelling out which files are
  under which terms. Ambiguity here is worse than any particular choice.

---

## 6. GitHub Pages terms

- **No commercial use, no e-commerce.** We neither book nor transact — we plan and link out.
  Compliant by construction.
- **1 GB site / 1 GB repo (recommended), 100 GB/month bandwidth (soft), 10 builds/hour
  (soft), 10-minute deploy timeout.** All comfortably within budget
  ([`PLAN.md` §9](../PLAN.md#9-performance-and-size-budget)).
- Public repo required on the free tier — **the entire source is public**. That is fine and
  arguably a feature, but it means: no secrets ever (there are none by design), and the
  harvester code is visible (which is why §3's posture matters).
- Sites exceeding bandwidth are throttled or prompt an email from GitHub, not billed.
  Monitor via the repo's traffic insights.

---

## 7. Privacy

A genuinely strong story, because the architecture makes privacy the default rather than a
policy:

- **No accounts, no login, no server, no database.** Nothing is collected because there is
  nowhere to put it.
- **No analytics, no trackers, no ads, no third-party scripts** beyond the map tiles and the
  keyless data APIs.
- All state (saved trips, settings, optional BYO key) lives in `localStorage` / IndexedDB in
  the user's own browser.
- **No PNRs stored, ever.** We never ask for one and have no use for one.
- Geolocation is opt-in, permission-gated, used only to resolve the nearest station, and
  never persisted or transmitted.
- Share links encode the query in the **URL fragment** (`#…`), which browsers do not send to
  servers — so a shared plan never appears in access logs.
- If the optional Tier-4 BYO key is used, it stays in the browser and goes only to its own
  provider. `.gitignore` covers `secrets.json` and `.env*`.
- The optional corridor-frequency tally (Phase 9) is local-only with an explicit opt-in
  export. Default: off.

Publish a short plain-language privacy note stating all of this. "We collect nothing because
we have no server" is more credible than any policy document.

---

## 8. Scraping ethics

Even where scraping is legal, be a good guest:

- **Rate-limit everything.** NTES at ~1 req/1.2 s; Overpass paginated by state; Wikidata
  chunked with `LIMIT`/`OFFSET`; Open-Meteo batched into single multi-location calls;
  Wikipedia only on card expansion.
- **Cache aggressively.** The timetable changes on the order of weeks, not minutes.
- **Send a descriptive `User-Agent`** with a contact address. Wikimedia and several others
  reject generic UAs, and it is simply polite.
- **Respect `robots.txt`** — verify before deploying each harvester.
- **Fail fast on semantic errors, back off only on network errors.** Hammering a service
  that is telling you "no such train" is both wasteful and rude.
- **Read timeouts on everything.** A hung connection should never become a hung crawl.
- **Bound the live sweep** to ~300 junction station boards, not the whole network.
- **Tier 3 is opt-in.** Do not make every visitor an unwitting participant in scraping a
  third-party site.
- **Never scrape behind a login.** We don't, and won't.
- **Prefer offline extracts** where available (Geofabrik `.pbf`) over repeated live queries.

---

## 9. Accuracy disclaimers required in-product

Must appear, unconditionally:

1. **Footer on every screen:** "Unofficial. Not affiliated with, endorsed by, or sponsored
   by Indian Railways, IRCTC, CRIS, or the Ministry of Railways. Timetable data from NTES
   (built `<date>`). Live data `<age>`. Availability figures are `<provenance>` — always
   verify on IRCTC before booking."
2. **On every availability figure:** a provenance badge. No exceptions.
3. **On every same-train split:** the full §4 warning block.
4. **On every inter-modal estimate:** "Estimated duration and cost — not a timetable.
   Verify with the operator."
5. **On every fare:** "Estimated. IRCTC's fare at booking time is authoritative."
6. **In every export (PDF, .ics, share page):** plan timestamp + "availability was
   `<provenance>` at plan time — verify on IRCTC" + the disclaimer. An exported itinerary
   must never resemble a ticket.
7. **On dataset staleness (> 7 days):** a banner with the age and an NTES verification link.
8. **For same-day travel:** an explicit prompt to check NTES live status, since our
   snapshot may be hours old.

---

## 10. What to do if something goes wrong

| Event | Response |
|---|---|
| NTES blocks the crawler | Fall back to the CC0 seed dataset; label it clearly as 2016 bootstrap; pause the cron; investigate politely (rate, UA, timing) |
| Takedown request re: NTES data | Comply promptly. The seed/generated split means the app keeps working on CC0 data within minutes |
| A public CORS relay disappears | Tier 3 chain falls through automatically. No action needed; remove the dead relay at leisure |
| Open-Meteo changes terms | Swap to NOAA/NWS (keyless, but US-only — not viable for India) or drop `seasonFit` and renormalise weights. The scorer is designed for a missing component |
| Model proves badly miscalibrated on a corridor | Per-corridor error gate should catch it in CI. If not: widen intervals, suppress that corridor's predictions to `UNKNOWN`, and fall back to "verify on IRCTC" |
| A user reports being refused travel on a split ticket | Take it seriously. Add the case to the golden corpus, strengthen the §4 disclosure, and consider demoting same-train splits in the ranking |
| Bandwidth approaches the soft limit | Enable more aggressive sharding, raise cache TTLs, reduce POI/photo payloads |
| The project is offered monetisation | **Stop.** Revisit Open-Meteo ($29/mo commercial), GitHub Pages commercial policy, and every attribution obligation with real counsel before proceeding |

---

## 11. The bottom line

This project is buildable, free, keyless and useful — **provided it is honest about the one
thing it cannot do**: guarantee live seat availability without a key.

The entire design is organised around that honesty. Predictions are labelled. Provenance is
visible. Every leg links to IRCTC for ground truth. Splits disclose their grey area.
Estimates say they are estimates. When rail cannot reach somewhere, the app says so.

An app that is 90% as capable but tells the truth will be trusted and used. An app that
claims live availability it does not have will strand someone at a platform at 2 a.m. Build
the first one.

---

Back to [`PLAN.md`](../PLAN.md)

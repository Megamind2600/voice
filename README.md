# Kahan Chalein? — "I have holidays. Where could I go?"

A free, static, zero-setup journey planner for Indian Railways, built for the person who
knows **where they are** and **when they're free** but has **no destination in mind**.

> **Status: Phases 0 and 1 shipped.** Data pipeline, packed dataset, worker, autocomplete and
> timetable lookup (Phase 0), plus multi-leg journey search, fares, transfers between city
> terminals, the results UI and share/copy/download (Phase 1). 340 tests, passing CI.
> **Seat availability is Phase 2 and is not connected yet** — every rail leg says so rather
> than guessing. Plan of record: [`PLAN.md`](PLAN.md). Research verified 2026-09-12.
>
> Phase 1 missed one of its own acceptance targets (1,000 queries in 2 s; measured 5.1 s) and
> deviated on three others. All are recorded with their causes and remediation in
> [`docs/04-roadmap-and-risks.md`](docs/04-roadmap-and-risks.md#phase-1--routing-engine--complete-with-deviations-recorded-below)
> rather than quietly redefined.

## What is built

The whole thing runs in the browser from a **890 KB gzip** download, with no server, no
account and no API key.

```
harvester/   Python, stdlib only
  fetch_seed.py    sparse git clone of the CC0 dataset — zero Actions minutes
  normalise.py     417,080 raw stop rows -> 103,229 genuine stops, with a quality report
  pack_binary.py   -> stations.bin (76 KB gz) + graph.bin (782 KB gz) + manifest
  validate/        two gates; every record round-tripped binary <-> canonical

site/        Vite + Preact + TypeScript
  lib/binary.ts    zero-copy RRLM container reader
  lib/stations.ts  prefix-search index over 7,219 stations
  lib/graph.ts     5,174 trains, 98,055 legs, per-station adjacency
  router/          the search: timetable -> CSA -> transfers -> fares -> journeys
  worker/          routing worker + a main-thread fallback if it fails to start
  state/cache.ts   IndexedDB, validated by sha256 — a warm visit makes zero requests
  state/           search hook with progressive widening; planner helpers
  ui/              combobox, planner form, itinerary cards, leg detail, route diagram, export
  tests/           340 tests: a golden corpus of real itineraries, an exhaustive-enumeration
                   cross-check of the router, and DOM tests for the promises the UI makes
```

### How the search works

One day's timetable is flattened into 135,949 scan-ready rows (~70 ms), then a
six-criterion **Connection Scan** finds every Pareto-optimal itinerary: arrival time, number
of changes, fare, night arrivals, early departures and fatigue. Consecutive rides on one
train merge into a single leg, so a through journey is never reported as two changes. Each
leg is priced from its *own* total distance through IRCTC's slab table — ten 100 km hops cost
far more than one 1,000 km ticket, and the engine knows it.

City terminals are linked by priced road edges (186 footpaths across Delhi, Mumbai, Kolkata,
Chennai, Bengaluru, Hyderabad, Goa, Pune and Ahmedabad), so arriving Howrah and leaving
Sealdah is a real option rather than a dead end. Minimum transfer minutes are enforced per
junction and checked by property test on every itinerary the corpus produces.

When a search comes back empty it **widens** — first the bounds the traveller asked for, then
two, then three, then four changes — and says which rung produced the answer, so an absurd
itinerary is never passed off as a normal one.

Three findings from the real data shaped the design, each written up where it belongs:
**75% of the source's "stops" are pass-throughs** the train never halts at; **file order is
already route order**, so the obvious `(day, time)` sort destroys it; and the rail detour
factor **calibrates to 1.037** rather than the ~1.25 assumed.

Existing tools (IRCTC, ConfirmTkt, ixigo, RailYatri) all require you to already know your
destination — they are booking tools. This is a **discovery** tool that happens to know
about trains, and none of them do leg-splitting intelligence at all.

## Cost

**₹0 · no API keys · no accounts · no setup.**

GitHub Pages and GitHub Actions (free for public repos), plus data sources each verified to
need no key: NTES (official government enquiry service), Open-Meteo, Wikipedia/Wikimedia,
Wikidata SPARQL, OSM Overpass, and a CC0 railways dataset.

**GitHub Actions usage: ~140 minutes/month today** against the 2,000 free allowance, rising
to ~300 once the harvest crons switch on at Phase 5 (worst month ~513, 26%). A previous
draft used 1,735; the rework cut it by moving live data off a cron and onto a runtime
on-demand path, which is *also* fresher. Phase 0 itself consumed **zero** minutes — the
dataset was harvested locally and only the 1.5 MB packed derivative was committed.
Details in [`PLAN.md` §8](PLAN.md#8-github-actions-budget).

## Inputs

Only two are mandatory, by design:

| Input | Required |
|---|---|
| Starting location | **Mandatory** |
| Departure date | **Mandatory** |
| Return date / round trip | Optional — one-way is a complete answer |
| Destination | Optional — **omitting it is the headline feature** |
| Days at destination, direction, budget, class, max transfers, interests | Optional |

Every optional field has a visible default and is independently overridable.

## The hard problem, stated honestly

**There is no free keyless IRCTC seat-availability API.** Availability lives in IRCTC's PRS;
NTES is the separate enquiry system with timetables but no availability. eRail's API is
suspended, everything else needs a key and/or payment, and GitHub Pages cannot run
server-side code to scrape one.

So the plan uses a **5-tier cascade** — static rake/quota reference → an in-browser
prediction model → opt-in live probe → optional bring-your-own-key — with an **IRCTC deep
link on every leg** for ground truth, and a provenance badge on every figure so a prediction
can never masquerade as a reservation. Full treatment in
[`docs/01-data-and-availability.md`](docs/01-data-and-availability.md).

The other half of the value is **segment-awareness**: IRCTC availability is per
*(train, boarding station, alighting station, date, class, quota)*, not per train. One train
can be `AVAILABLE-0042` end-to-end and `REGRET` on a short hop. Exploiting that asymmetry —
plus date shifts, quota shifts, terminal substitution and road/air bridges — is what turns
"waitlisted, sorry" into a bookable multi-leg itinerary.

## Documents

| Doc | Contents |
|---|---|
| [`PLAN.md`](PLAN.md) | **Master plan.** Self-contained: the five verified facts, product, contract, architecture, availability, routing, discovery, **Actions budget**, size budget, scope cuts, roadmap |
| [`docs/01-data-and-availability.md`](docs/01-data-and-availability.md) | Verified source matrix · NTES field notes · booking rules (ARP is now **60 days**) · IRCTC data model · the 5-tier cascade · model spec · status parsing · quota arithmetic |
| [`docs/02-routing-and-discovery.md`](docs/02-routing-and-discovery.md) | CSA + Pareto pseudocode · data structures · terminal expansion · the 7 remedies · inter-modal · stopovers · round trip · discovery scoring · performance · testing |
| [`docs/03-architecture-and-build.md`](docs/03-architecture-and-build.md) | Modules · worker protocol · binary container · repo layout · **Actions budget arithmetic + zero-Actions bootstrap** · harvest discipline · schema · integrity gates |
| [`docs/04-roadmap-and-risks.md`](docs/04-roadmap-and-risks.md) | 6 phases with acceptance criteria · 20-item risk register · NTES redistribution · two-ticket splitting · licence matrix · privacy · disclaimers · incident responses |

## Roadmap in one line

**Phases 0→2 (~37–49 days) is the MVP** — multi-leg planning, predicted availability, all
seven remedies, IRCTC handoff. Phase 3 (discovery mode) is the differentiator. Crons stay
disabled until Phase 5, so early work consumes almost no Actions minutes.

## Repository history

This repo previously held an unrelated Flask + gTTS text-to-speech API with contradictory
Replit/Render/Heroku scaffolding. Removed for a clean slate; fully recoverable:

```bash
git checkout 0f0f32b0985c5ddbcb76feba9d5e66845fcab9c7 -- .   # restore legacy TTS app
git show 0f0f32b0985c5ddbcb76feba9d5e66845fcab9c7 --stat      # inspect what was there
```

## Disclaimer

Unofficial. Not affiliated with, endorsed by, or sponsored by Indian Railways, IRCTC, CRIS,
or the Ministry of Railways. This app **plans** journeys; it never books them or handles
payments — booking always happens on IRCTC. See
[`docs/04-roadmap-and-risks.md`](docs/04-roadmap-and-risks.md).

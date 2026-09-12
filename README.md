# RailRoam — "I have holidays. Where could I go?"

A free, static, zero-setup journey planner for Indian Railways, built for the person who
knows **where they are** and **when they're free** but has **no destination in mind**.

> **Status: plan only, nothing implemented.** Read [`PLAN.md`](PLAN.md).
> Research verified 2026-09-12.

Existing tools (IRCTC, ConfirmTkt, ixigo, RailYatri) all require you to already know your
destination — they are booking tools. This is a **discovery** tool that happens to know
about trains, and none of them do leg-splitting intelligence at all.

## Cost

**₹0 · no API keys · no accounts · no setup.**

GitHub Pages and GitHub Actions (free for public repos), plus data sources each verified to
need no key: NTES (official government enquiry service), Open-Meteo, Wikipedia/Wikimedia,
Wikidata SPARQL, OSM Overpass, and a CC0 railways dataset.

**GitHub Actions usage: ~252 minutes/month** against the 2,000 free allowance — worst month
~465 (23%). A previous draft used 1,735; the rework cut it 85% by moving live data off a
cron and onto a runtime on-demand path, which is *also* fresher. Details in
[`PLAN.md` §8](PLAN.md#8-github-actions-budget-252-minmonth).

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

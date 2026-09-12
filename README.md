# RailRoam — an "I have holidays, where should I go?" planner for Indian Railways

> **Status: planning complete, implementation not started.**
> This repository currently contains the **plan only**. Read [`PLAN.md`](PLAN.md) first.

## What this project is

A free, static, zero-setup web app (GitHub Pages) that answers a question no Indian
railway app answers today:

> *"I have N days of holiday, I'm starting from **here**, and I have **no idea where
> I want to go**. Show me everywhere I could realistically reach, whether I'd actually
> get a seat, and what the journey would look like if it has to be broken into legs."*

Existing tools (IRCTC, ConfirmTkt, ixigo, RailYatri, Where Is My Train) all require you
to **already know your destination**. They are booking tools. This is a **discovery**
tool that happens to know about trains.

### The two hard problems

1. **Seat availability, free, with no API key.** There is no such thing as a free public
   IRCTC availability API — every provider requires a key and/or payment, and GitHub Pages
   cannot run server-side code to scrape one. [`docs/03-availability.md`](docs/03-availability.md)
   is an honest treatment of this and the five-tier strategy that works around it.
2. **Multi-leg decomposition.** IRCTC availability is *segment-specific*: the same train
   can be `AVAILABLE-0042` end-to-end and `REGRET` on a short intermediate hop — or the
   reverse. Exploiting that asymmetry (plus date shifts, quota shifts, terminal
   substitution and road/air bridges) is where the real value lives.
   [`docs/04-routing-engine.md`](docs/04-routing-engine.md).

## Mandatory vs optional inputs

Only **two** inputs are mandatory, by design:

| Input | Required? |
|---|---|
| Starting location | **Mandatory** |
| Date of departure | **Mandatory** |
| Return date | Optional — one-way is a complete, valid answer |
| Destination | Optional — omitting it *is* the headline feature |
| Number of days at destination | Optional |
| Round trip / one-way | Optional |
| Preferred direction or region | Optional |
| Budget, class, max transfers, max travel hours | Optional |
| Traveller type (solo/family, senior, female-only quota) | Optional |

Everything optional has a sensible default and every default is overridable.

## Documents

| Doc | What's in it |
|---|---|
| [`PLAN.md`](PLAN.md) | **Master plan.** Read this. Self-contained overview + links out. |
| [`docs/01-architecture.md`](docs/01-architecture.md) | System architecture, stack choices, module breakdown, performance budget |
| [`docs/02-data-sources.md`](docs/02-data-sources.md) | Every data source, **verified live today**: endpoint, auth, CORS, rate limit, licence |
| [`docs/03-availability.md`](docs/03-availability.md) | The seat-availability problem and the 5-tier cascade |
| [`docs/04-routing-engine.md`](docs/04-routing-engine.md) | CSA graph, Pareto search, leg-splitting, inter-modal bridging |
| [`docs/05-data-pipeline.md`](docs/05-data-pipeline.md) | Keyless ETL on GitHub Actions, dataset schema, size budget |
| [`docs/06-discovery.md`](docs/06-discovery.md) | "Explore India" mode: reverse reachability + destination scoring |
| [`docs/07-ui-ux.md`](docs/07-ui-ux.md) | Screens, flows, component inventory, the itinerary card |
| [`docs/08-roadmap.md`](docs/08-roadmap.md) | 9 phases with acceptance criteria and effort estimates |
| [`docs/09-risks-legal.md`](docs/09-risks-legal.md) | ToS, data redistribution, scraping ethics, disclaimers |

## Cost

**₹0.** GitHub Pages (free), GitHub Actions (free for public repos), and a set of data
sources that were individually verified to need **no account and no API key**:
NTES (official government enquiry service), Open-Meteo, Wikipedia/Wikimedia REST,
Wikidata SPARQL, OpenStreetMap Overpass. See [`docs/02-data-sources.md`](docs/02-data-sources.md).

The user of this app supplies **no keys, no account, no configuration**. Optional
live-availability upgrades exist and are documented as strictly optional.

## Repository history

This repo previously contained an unrelated Flask + gTTS text-to-speech API (with Replit,
Render and Heroku deployment scaffolding that contradicted each other). It was removed to
give this project a clean slate. It is fully recoverable:

```bash
git checkout 0f0f32b0985c5ddbcb76feba9d5e66845fcab9c7 -- .   # restore legacy TTS app
git show 0f0f32b0985c5ddbcb76feba9d5e66845fcab9c7 --stat      # inspect what was there
```

## Disclaimer

Unofficial project. Not affiliated with, endorsed by, or sponsored by Indian Railways,
IRCTC, CRIS, or the Ministry of Railways. This app **plans** journeys; it never books
them or handles payments. Booking always happens on IRCTC. See
[`docs/09-risks-legal.md`](docs/09-risks-legal.md).

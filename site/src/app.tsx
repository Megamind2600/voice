/**
 * app.tsx — the planner.
 *
 * Two screens' worth of concerns live here and are kept deliberately separate:
 *
 *   1. The PLAN — where you start, when you can leave, optionally where you want to end up.
 *      This is the product.
 *   2. The BROWSE — what leaves a given station, and a train's full stop list. This shipped in
 *      Phase 0 and stays, because "what can I catch from here" is a question people ask before
 *      they know where they want to go.
 *
 * Nothing here routes. The search runs in the worker (see state/client.ts and worker/handlers.ts)
 * so a 100 ms scan over 135,949 timetable rows never blocks the autocomplete.
 */
import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { router } from './state/client';
import { dataLocation } from './state/cache';
import { useDataset } from './state/useDataset';
import { useProfiles } from './state/useProfiles';
import { useJourneys, useWorkerConfigure, type PlanInput } from './state/useJourneys';
import { resolveTerminalGroups } from './router/terminals';
import { PlannerDepsContext, type PlannerDeps } from './ui/deps';
import type { Station } from './lib/stations';
import type { GraphStats, RawStop, TrainSummary } from './lib/protocol';
import { StationAutocomplete } from './ui/StationAutocomplete';
import { StatusBar } from './ui/StatusBar';
import { TrainCard } from './ui/TrainCard';
import { StopTable } from './ui/StopTable';
import { Disclaimer } from './ui/Disclaimer';
import { JourneyForm } from './ui/JourneyForm';
import { ItineraryCard } from './ui/ItineraryCard';
import { DestinationCard } from './ui/DestinationCard';
import { addDaysIso, todayIso } from './state/plan';
import type { Journey } from './router/journey';

const DEFAULT_PLAN = (): PlanInput => ({
  origin: null,
  date: addDaysIso(todayIso(), 1),
  timeMin: 8 * 60,
  destination: null,
  maxTransfers: 2,
  preferredClass: null,
  returnDate: null,
  daysAtDestination: null,
});

export function App() {
  const dataset = useDataset();
  const stations = dataset.stations;
  // The destination notes are editorial prose, so they ship as data and arrive on their own
  // schedule; nothing on the search path waits for them.
  const notes = useProfiles();

  const [plan, setPlan] = useState<PlanInput>(DEFAULT_PLAN);
  const { state, search } = useJourneys(stations);
  const [graphStats, setGraphStats] = useState<GraphStats | null>(null);

  // Phase 0 browse state, kept because it is still useful on its own.
  const [browse, setBrowse] = useState<Station | null>(null);
  const [trains, setTrains] = useState<TrainSummary[] | null>(null);
  const [trainsLoading, setTrainsLoading] = useState(false);
  const [openTrain, setOpenTrain] = useState<number | null>(null);
  const [stops, setStops] = useState<RawStop[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The worker must be told where the dataset lives in absolute, page-resolved terms
  // before it fetches anything: left to itself it resolves `./data/` against its own
  // script URL and every search fails with a graph error. See `dataBaseUrl()`.
  useEffect(() => { router.setDataLocation(dataLocation()); void router.start(); }, []);

  // Warm the graph as soon as the page settles, so the first search does not pay the download.
  useEffect(() => {
    let cancelled = false;
    void router.request({ type: 'graph:load' })
      .then((r) => { if (!cancelled) setGraphStats(r.stats); })
      .catch(() => { /* StatusBar reports the dataset error instead */ });
    return () => { cancelled = true; };
  }, []);

  // The worker needs the city terminal groups resolved to indices, and only this thread can do it.
  useWorkerConfigure(stations, dataset.phase === 'ready');

  const nameOf = useCallback((i: number) => {
    if (!stations || i < 0 || i >= stations.count) return { code: '????', name: 'unknown station' };
    const s = stations.at(i);
    return { code: s.code, name: s.name };
  }, [stations]);

  const coordsFor = useCallback((i: number) => {
    if (!stations || i < 0 || i >= stations.count) return null;
    const s = stations.at(i);
    return s.lat === null || s.lon === null ? null : { lat: s.lat, lon: s.lon };
  }, [stations]);

  const selectBrowse = useCallback((s: Station | null) => {
    setBrowse(s);
    setOpenTrain(null);
    setStops(null);
    setError(null);
    if (!s) { setTrains(null); return; }
    setTrainsLoading(true);
    void router.request({ type: 'station:trains', station: s.i, limit: 40 })
      .then((r) => { setTrains(r.trains); setTrainsLoading(false); })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setTrainsLoading(false);
      });
  }, []);

  const openTrainStops = useCallback((trainIdx: number) => {
    setOpenTrain((cur) => (cur === trainIdx ? null : trainIdx));
    setStops(null);
    if (openTrain === trainIdx) return;
    void router.request({ type: 'train:stops', train: trainIdx })
      .then((r) => setStops(r.stops))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [openTrain]);

  const submit = useCallback(() => { void search(plan); }, [plan, search]);

  const datasetLabel = dataset.manifest?.bootstrapLabel ?? 'BOOTSTRAP · 2016';
  const openTrainSummary = trains?.find((t) => t.train === openTrain) ?? null;
  const notReady = dataset.phase === 'error'
    ? 'The dataset failed to load, so searching is unavailable.'
    : dataset.phase === 'ready' ? '' : 'Loading the timetable…';
  const canSearch = dataset.phase === 'ready';

  // Explore results arrive as one itinerary per candidate destination; group them so the screen
  // reads as "here are places" rather than as a flat list of trains.
  const grouped = useMemo(() => groupByDestination(
    state.phase === 'done' || state.phase === 'empty' ? state.outcome.outbound : [],
  ), [state]);

  const exploring = plan.destination === null;

  // Worked out outside the JSX: TypeScript's narrowing of `inbound !== null` does not survive into
  // the map callback, and a non-null assertion would be a claim the compiler cannot check.
  const returnAlternatives = (state.phase === 'done' || state.phase === 'empty')
    ? Math.max(0, (state.outcome.inbound?.length ?? 1) - 1)
    : 0;

  // Resolved here rather than returned from useWorkerConfigure: that hook's job is to push the
  // groups to the worker, while the leg panels need the same list to work out road times between
  // terminals in one city. Resolving twice costs microseconds over an authored table of a dozen
  // cities, and it keeps the hook's contract — and every test that relies on it — unchanged.
  const deps = useMemo<PlannerDeps>(() => ({
    stations,
    groups: stations
      ? resolveTerminalGroups(stations.count, (code) => {
        const i = stations.indexOfCode(code);
        return i < 0 ? null : i;
      }).groups
      : [],
  }), [stations]);

  return (
    <PlannerDepsContext.Provider value={deps}>
    <div class="shell">
      <header class="masthead">
        <div class="masthead__inner">
          <p class="masthead__eyebrow">Indian Railways · unofficial</p>
          <h1>Kahan chalein?</h1>
          <p class="masthead__tagline">
            You have holidays. You do not have a destination. Tell us where you are starting
            from and when you are free — we will show you where you can actually get to, and
            how, splitting the journey across trains when no single one will do.
          </p>
        </div>
      </header>

      <main id="main" class="main">
        <Disclaimer datasetLabel={datasetLabel} />

        <section class="panel" aria-labelledby="h-plan">
          <h2 id="h-plan">Plan a journey</h2>
          <p class="panel__note">
            Only your starting point and outbound date are required. Destination, return date and
            how long you want to stay are all optional — leaving the destination blank is how you
            ask us to suggest somewhere.
          </p>

          <JourneyForm
            stations={stations}
            plan={plan}
            onChange={setPlan}
            onSubmit={submit}
            busy={state.phase === 'searching'}
            canSearch={canSearch}
            notReadyMessage={notReady || 'Loading station list…'}
          />

          <StatusBar dataset={dataset} graphStats={graphStats} />
        </section>

        {error && (
          <div class="alert" role="alert"><strong>Something went wrong.</strong> {error}</div>
        )}

        {state.phase === 'searching' && (
          <section class="panel" aria-busy="true" aria-live="polite">
            <h2>{state.label}</h2>
            <p class="panel__note">Scanning the whole timetable. This usually takes well under a second.</p>
          </section>
        )}

        {state.phase === 'error' && (
          <section class="panel"><div class="alert" role="alert"><strong>Search failed.</strong> {state.message}</div></section>
        )}

        {state.phase === 'empty' && (
          <section class="panel" aria-labelledby="h-none">
            <h2 id="h-none">Nothing found</h2>
            <p>{state.reason}</p>
            <p class="panel__note">
              We searched up to {state.outcome.used.maxTransfers} changes and{' '}
              {Math.round(state.outcome.used.maxJourneyMin / 60)} hours in transit across{' '}
              {state.outcome.rows.toLocaleString('en-IN')} scheduled departures.
            </p>
            <ul class="ticks">
              <li>Try a different date — a weekly train simply does not exist on the days it does not run.</li>
              <li>Try a nearby bigger station at either end.</li>
              <li>Allow more changes, or leave the destination blank and see what is reachable.</li>
            </ul>
          </section>
        )}

        {state.phase === 'done' && (
          <section class="panel" aria-labelledby="h-results">
            <h2 id="h-results">
              {exploring
                ? `${grouped.length} place${grouped.length === 1 ? '' : 's'} you could go`
                : `${state.outcome.outbound.length} itinerar${state.outcome.outbound.length === 1 ? 'y' : 'ies'}`}
            </h2>

            <p class="panel__note">
              {state.outcome.ms.toFixed(0)} ms of search over{' '}
              {state.outcome.rows.toLocaleString('en-IN')} scheduled
              departures{state.outcome.widened && (
                <> · <strong>we widened the search</strong> to {state.outcome.used.maxTransfers} changes
                  and {Math.round(state.outcome.used.maxJourneyMin / 60)} h to find these</>
              )}.
              These are the options that are not beaten by another on <em>every</em> measure at once —
              arrival time, changes, and fare.
              {exploring && (
                <> Each one says why it is worth the journey: what is in the city, and what is a
                  road hop from the station rather than a walk.</>
              )}
            </p>

            {exploring ? (
              <div class="destinations">
                {grouped.map((g) => (
                  <div class="dest" key={g.station}>
                    <h3>
                      {nameOf(g.station).name}
                      <span class="code">{nameOf(g.station).code}</span>
                    </h3>
                    <DestinationCard
                      station={g.station}
                      stations={stations}
                      nameOf={nameOf}
                      profiles={notes.index}
                      loadingNotes={notes.loading}
                    />
                    {g.journeys.map((j, i) => (
                      <ItineraryCard
                        key={`d${g.station}-${i}`}
                        journey={j}
                        nameOf={nameOf}
                        date={plan.date}
                        coordsFor={coordsFor}
                        expandedByDefault={false}
                        alternativeItineraries={g.journeys.length - 1}
                      />
                    ))}
                  </div>
                ))}
                {grouped.length === 0 && (
                  <p class="panel__note">No candidate destination was reachable.</p>
                )}
              </div>
            ) : (
              <div class="itineraries">
                {state.outcome.outbound.map((j, i) => (
                  <ItineraryCard
                    key={i}
                    journey={j}
                    nameOf={nameOf}
                    date={plan.date}
                    coordsFor={coordsFor}
                    expandedByDefault={i === 0}
                    alternativeItineraries={state.outcome.outbound.length - 1}
                  />
                ))}
              </div>
            )}

            {state.outcome.inbound !== null && (
              <div class="return">
                <h3>Returning {plan.returnDate}</h3>
                {state.outcome.inbound.length === 0 ? (
                  <p class="panel__note">
                    No return itinerary found on that date. The outbound options above still stand —
                    try another return date.
                  </p>
                ) : state.outcome.inbound.map((j, i) => (
                  <ItineraryCard
                    key={`r${i}`}
                    journey={j}
                    nameOf={nameOf}
                    date={plan.returnDate ?? plan.date}
                    coordsFor={coordsFor}
                    alternativeItineraries={returnAlternatives}
                  />
                ))}
              </div>
            )}

            <p class="panel__note">
              Fares are published-tariff estimates. Seat availability is <strong>estimated, not
              read from IRCTC</strong> — open a leg to see the estimate, the range behind it and
              the arithmetic it came from. Nothing on this page is a booking or a guarantee of a
              berth.
            </p>
          </section>
        )}

        <section class="panel" aria-labelledby="h-browse" aria-busy={trainsLoading}>
          <h2 id="h-browse">
            {browse ? `What leaves ${browse.name}?` : 'Browse a station'}
          </h2>
          <p class="panel__note">
            Not planning a journey yet? Pick any station to see its services and full timetables.
          </p>
          <StationAutocomplete
            index={stations}
            label="Station"
            value={browse}
            onSelect={selectBrowse}
            notReadyMessage={notReady || 'Loading station list…'}
          />

          {browse && trainsLoading && <p class="panel__note">Looking up services…</p>}
          {browse && !trainsLoading && trains && trains.length === 0 && (
            <p class="panel__note">
              No train in this dataset stops at {browse.name}. That usually means it is a small
              halt — try the nearest junction.
            </p>
          )}
          {browse && trains && trains.length > 0 && (
            <>
              <p class="panel__note">
                {trains.length} service{trains.length === 1 ? '' : 's'} shown
                {trains.length >= 40 ? ' (capped at 40)' : ''}.
              </p>
              <ul class="trainlist">
                {trains.map((t) => (
                  <li key={t.train}>
                    <TrainCard
                      train={t}
                      originName={nameOf(t.origin).name}
                      destinationName={nameOf(t.destination).name}
                      onOpen={openTrainStops}
                      expanded={openTrain === t.train}
                    />
                    {openTrain === t.train && stops && openTrainSummary && (
                      <StopTable
                        train={openTrainSummary}
                        stops={stops}
                        stationName={(i) => nameOf(i).name}
                        stationCode={(i) => nameOf(i).code}
                      />
                    )}
                    {openTrain === t.train && !stops && <p class="panel__note">Loading timetable…</p>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        <section class="panel panel--muted" aria-labelledby="h-next">
          <h2 id="h-next">What this build does and does not do yet</h2>
          <p>
            This is <strong>Phase 1</strong>: the routing engine. It searches{' '}
            {graphStats ? graphStats.trains.toLocaleString('en-IN') : '—'} trains over{' '}
            {graphStats ? graphStats.connections.toLocaleString('en-IN') : '—'} station-to-station
            legs, packed into{' '}
            {dataset.manifest
              ? `${((dataset.manifest.files['graph.bin']?.gzipBytes ?? 0) / 1024).toFixed(0)} KB`
              : '—'} of gzipped binary and queried in a Web Worker.
          </p>
          <ul class="ticks">
            <li>Multi-criteria results: arrival time, number of changes and fare are all weighed, so you see the fast option, the cheap option and the direct one instead of just the first.</li>
            <li>Journeys split across trains, with a real minimum transfer time per station rather than an optimistic zero.</li>
            <li>Road transfers between terminals in the same city — a train into Nizamuddin can connect to one out of New Delhi.</li>
            <li>Every leg priced, with the estimate labelled as an estimate.</li>
            <li>Seat availability estimated per leg from the train's capacity, the booking
                window, the day of the week, the festival calendar and how busy each end of the
                corridor is — labelled ESTIMATED wherever it appears, never presented as live.</li>
            <li>Destination notes: what is actually in the city you are being sent to, and which
                sights need a road hop from the station rather than a walk.</li>
            <li>Seven remedies for a waitlisted leg — split the ticket, shift the date, change
                quota or class, find another route, use a different terminal in the same city, or
                go by road — each with what it costs and the exact question it would put to IRCTC.</li>
            <li>Nothing leaves your browser. No account, no API key, no tracking.</li>
          </ul>
          <p class="panel__note">
            <strong>Not here yet:</strong> live seat availability. No availability source is
            connected, so nothing on this page knows whether a berth is free — what it has instead
            is a structural estimate, labelled ESTIMATED, built from the rake capacity, the
            booking window, the season and the corridor. Read it as guidance about which date and
            train to prefer, and treat IRCTC as the only answer to whether a seat exists. Every
            fare is still a published-tariff estimate.
          </p>
        </section>
      </main>

      <footer class="footer">
        <div class="footer__inner">
          <p>
            <strong>Data.</strong> Timetable bootstrap from the{' '}
            <a href="https://github.com/datameet/railways" rel="noopener noreferrer" target="_blank">
              DataMeet Indian Railways dataset
            </a>{' '}
            (CC0, 2016). Station coordinates from the same source. Later phases add
            OpenStreetMap (ODbL), Wikipedia (CC BY-SA) and Open-Meteo.
          </p>
          <p>
            <strong>Not a booking service.</strong> Unofficial, non-commercial, and not affiliated
            with Indian Railways or IRCTC. Verify everything on{' '}
            <a href="https://www.irctc.co.in" rel="noopener noreferrer" target="_blank">
              irctc.co.in
            </a>{' '}
            before you travel.
          </p>
        </div>
      </footer>
    </div>
    </PlannerDepsContext.Provider>
  );
}

/** Group itineraries by the destination they reach, preserving arrival order within each. */
function groupByDestination(journeys: readonly Journey[]): Array<{ station: number; journeys: Journey[] }> {
  const byStation = new Map<number, Journey[]>();
  for (const j of journeys) {
    const list = byStation.get(j.destination);
    if (list) list.push(j);
    else byStation.set(j.destination, [j]);
  }
  const out = [...byStation.entries()].map(([station, list]) => ({ station, journeys: list }));
  // Nearest first: when someone asks "where could I go?", the useful ordering is by how easy it
  // is to get there, which arrival time measures and straight-line distance does not.
  out.sort((a, b) => a.journeys[0].arrMin - b.journeys[0].arrMin);
  return out;
}

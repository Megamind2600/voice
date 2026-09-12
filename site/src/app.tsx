/**
 * app.tsx — Phase 0 shell.
 *
 * Phase 0 is foundations, so the honest scope here is: prove the packed dataset loads,
 * prove autocomplete works before the graph does, prove the worker answers lookups, and
 * carry the legal/staleness notices on every screen. Journey search (CSA) is Phase 1 and
 * is deliberately NOT stubbed with a fake result — the UI says what it can and cannot do.
 */
import { useCallback, useEffect, useState } from 'preact/hooks';
import { router } from './state/client';
import { useDataset } from './state/useDataset';
import type { Station } from './lib/stations';
import type { GraphStats, RawStop, TrainSummary } from './lib/protocol';
import { StationAutocomplete } from './ui/StationAutocomplete';
import { StatusBar } from './ui/StatusBar';
import { TrainCard } from './ui/TrainCard';
import { StopTable } from './ui/StopTable';
import { Disclaimer } from './ui/Disclaimer';

export function App() {
  const dataset = useDataset();
  const [origin, setOrigin] = useState<Station | null>(null);
  const [graphStats, setGraphStats] = useState<GraphStats | null>(null);
  const [trains, setTrains] = useState<TrainSummary[] | null>(null);
  const [trainsLoading, setTrainsLoading] = useState(false);
  const [openTrain, setOpenTrain] = useState<number | null>(null);
  const [stops, setStops] = useState<RawStop[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const stations = dataset.stations;

  useEffect(() => {
    void router.start();
  }, []);

  // Ask the worker to warm the graph as soon as the page settles, so the first station
  // lookup does not pay the download cost. Failures are non-fatal: lookups retry lazily.
  useEffect(() => {
    let cancelled = false;
    void router.request({ type: 'graph:load' })
      .then((r) => { if (!cancelled) setGraphStats(r.stats); })
      .catch(() => { /* StatusBar reports the dataset error instead */ });
    return () => { cancelled = true; };
  }, []);

  const selectOrigin = useCallback((s: Station | null) => {
    setOrigin(s);
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

  const nameAt = useCallback(
    (i: number) => (stations ? stations.at(i).name : `#${i}`),
    [stations],
  );
  const codeAt = useCallback(
    (i: number) => (stations ? stations.at(i).code : `#${i}`),
    [stations],
  );

  const datasetLabel = dataset.manifest?.bootstrapLabel ?? 'BOOTSTRAP · 2016';
  const openTrainSummary = trains?.find((t) => t.train === openTrain) ?? null;

  return (
    <div class="shell">
      <header class="masthead">
        <div class="masthead__inner">
          <p class="masthead__eyebrow">Indian Railways · unofficial</p>
          <h1>Kahan chalein?</h1>
          <p class="masthead__tagline">
            You have holidays. You do not have a destination. Tell us where you are
            starting from and when you are free — we will show you where you can actually
            get a seat.
          </p>
        </div>
      </header>

      <main id="main" class="main">
        <Disclaimer datasetLabel={datasetLabel} />

        <section class="panel" aria-labelledby="h-origin">
          <h2 id="h-origin">Where are you starting from?</h2>
          <p class="panel__note">
            This is the only thing we insist on. Everything else — destination, return
            date, how long you want to stay — is optional, and you can leave it blank.
          </p>

          <StationAutocomplete
            index={stations}
            label="Starting station"
            value={origin}
            onSelect={selectOrigin}
            notReadyMessage={
              dataset.phase === 'error'
                ? 'The station list failed to load.'
                : 'Loading station list…'
            }
          />

          <StatusBar dataset={dataset} graphStats={graphStats} />
        </section>

        {error && (
          <div class="alert" role="alert">
            <strong>Something went wrong.</strong> {error}
          </div>
        )}

        <section class="panel" aria-labelledby="h-trains" aria-busy={trainsLoading}>
          <h2 id="h-trains">
            {origin ? `Trains from ${origin.name}` : 'Trains from your station'}
          </h2>

          {!origin && (
            <p class="panel__note">
              Pick a starting station above to see what leaves from there.
            </p>
          )}

          {origin && trainsLoading && (
            <p class="panel__note">Looking up services…</p>
          )}

          {origin && !trainsLoading && trains && trains.length === 0 && (
            <p class="panel__note">
              No train in this dataset stops at {origin.name}. That usually means it is a
              small halt — try the nearest junction.
            </p>
          )}

          {origin && trains && trains.length > 0 && (
            <>
              <p class="panel__note">
                {trains.length} service{trains.length === 1 ? '' : 's'} shown
                {trains.length >= 40 ? ' (capped at 40)' : ''}. Select one to see its full
                timetable.
              </p>
              <ul class="trainlist">
                {trains.map((t) => (
                  <li key={t.train}>
                    <TrainCard
                      train={t}
                      originName={nameAt(t.origin)}
                      destinationName={nameAt(t.destination)}
                      onOpen={openTrainStops}
                      expanded={openTrain === t.train}
                    />
                    {openTrain === t.train && stops && openTrainSummary && (
                      <StopTable
                        train={openTrainSummary}
                        stops={stops}
                        stationName={nameAt}
                        stationCode={codeAt}
                      />
                    )}
                    {openTrain === t.train && !stops && (
                      <p class="panel__note">Loading timetable…</p>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        <section class="panel panel--muted" aria-labelledby="h-next">
          <h2 id="h-next">What this build does and does not do yet</h2>
          <p>
            This is <strong>Phase 0</strong>: the data foundations. The full timetable
            graph for {graphStats ? graphStats.trains.toLocaleString('en-IN') : '—'} trains
            is packed into {dataset.manifest
              ? `${((dataset.manifest.files['graph.bin']?.gzipBytes ?? 0) / 1024).toFixed(0)} KB`
              : '—'} of gzipped binary, cached in your browser, and queried in a Web
            Worker so the interface never freezes.
          </p>
          <ul class="ticks">
            <li>Station search across {stations ? stations.count.toLocaleString('en-IN') : '—'} stations, live before the timetable finishes downloading.</li>
            <li>Every train's full stop list, with distances and running days.</li>
            <li>Nothing leaves your browser. No account, no API key, no tracking.</li>
          </ul>
          <p class="panel__note">
            Journey search with seat availability, multi-leg splitting when a direct train
            is full, and destination discovery arrive in later phases. Seat availability
            shown anywhere on this site is an <em>estimate</em>, never a booking guarantee
            — only IRCTC can confirm a seat.
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
            <strong>Not a booking service.</strong> Unofficial, non-commercial, and not
            affiliated with Indian Railways or IRCTC. Verify everything on{' '}
            <a href="https://www.irctc.co.in" rel="noopener noreferrer" target="_blank">
              irctc.co.in
            </a>{' '}
            before you travel.
          </p>
        </div>
      </footer>
    </div>
  );
}

/**
 * useDataset.ts — boot sequence for the two-file dataset.
 *
 * The ordering here IS the Phase 0 performance story:
 *   1. manifest.json  (~1 KB)      — content hashes, so the cache can be validated
 *   2. stations.bin   (~76 KB gz)  — autocomplete is live from here
 *   3. graph.bin      (~772 KB gz) — handed to the worker, off the main thread
 *
 * Step 2 completing is what makes the app usable; step 3 only enables train lookups. So
 * the UI reports them separately and never blocks input on the graph.
 */
import { useEffect, useState } from 'preact/hooks';
import { ContainerKind } from '../lib/binary';
import { StationIndex } from '../lib/stations';
import { loadDataset, loadManifest, type DatasetManifest, type LoadSource } from './cache';

export type Phase = 'idle' | 'loading' | 'stations-ready' | 'ready' | 'error';

export interface DatasetState {
  phase: Phase;
  stations: StationIndex | null;
  manifest: DatasetManifest | null;
  stationsSource: LoadSource | null;
  stationsMs: number;
  graphSource: LoadSource | null;
  graphMs: number;
  error: string | null;
}

const INITIAL: DatasetState = {
  phase: 'idle', stations: null, manifest: null, stationsSource: null,
  stationsMs: 0, graphSource: null, graphMs: 0, error: null,
};

export function useDataset(base = './data/'): DatasetState {
  const [state, setState] = useState<DatasetState>(INITIAL);

  useEffect(() => {
    const ac = new AbortController();

    (async () => {
      setState((s) => ({ ...s, phase: 'loading' }));
      try {
        const manifest = await loadManifest(`${base}manifest.json`);

        const st = await loadDataset('stations.bin', ContainerKind.Stations, {
          base, manifest, signal: ac.signal,
        });
        if (ac.signal.aborted) return;
        const stations = StationIndex.fromContainer(st.container);
        setState((s) => ({
          ...s, phase: 'stations-ready', manifest, stations,
          stationsSource: st.source, stationsMs: st.ms,
        }));

        // The graph is fetched on the main thread only so it can land in IndexedDB and
        // have its coordinates attached; the worker keeps its own copy for routing.
        const gr = await loadDataset('graph.bin', ContainerKind.Graph, {
          base, manifest, signal: ac.signal,
        });
        if (ac.signal.aborted) return;
        stations.attachGeo(gr.container);
        setState((s) => ({ ...s, phase: 'ready', graphSource: gr.source, graphMs: gr.ms }));
      } catch (err) {
        if (ac.signal.aborted) return;
        setState((s) => ({
          ...s, phase: 'error',
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    })();

    return () => ac.abort();
  }, [base]);

  return state;
}

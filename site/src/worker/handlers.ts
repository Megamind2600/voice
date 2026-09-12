/**
 * handlers.ts — the actual request logic, shared by the Web Worker and the inline
 * main-thread fallback.
 *
 * Keeping this in its own module means `router.ts` (worker entry) and `inline.ts`
 * (fallback) cannot drift apart: both dispatch into the same switch, so a browser without
 * module-worker support gets identical behaviour rather than a reduced feature set.
 */

import { ContainerKind, type Container } from '../lib/binary';
import { Graph, stationCountOf } from '../lib/graph';
import { loadDataset, loadManifest } from '../state/cache';
import type { GraphStats, TrainSummary, WorkerRequest, WorkerResponse } from '../lib/protocol';

export interface LoadResult {
  stats: GraphStats;
  source: string;
  bytes: number;
  ms: number;
}

let graph: Graph | null = null;
let loadInFlight: Promise<LoadResult> | null = null;

export function reset(): void {
  graph = null;
  loadInFlight = null;
}

export function isLoaded(): boolean {
  return graph !== null;
}

function buildGraph(container: Container): Graph {
  const stationCount = stationCountOf(container);
  if (stationCount === 0) {
    throw new Error('graph.bin has no STATION_GEO section, so the station count is unknown');
  }
  return Graph.fromContainer(container, stationCount);
}

async function loadGraph(): Promise<LoadResult> {
  const t0 = performance.now();
  const manifest = await loadManifest();
  const loaded = await loadDataset('graph.bin', ContainerKind.Graph, { manifest });
  const g = buildGraph(loaded.container);
  graph = g;
  return {
    // adjacencyMs covers fetch + parse + transpose; the transpose itself is a small
    // fraction, but reporting them separately would need two timers around work that
    // is dominated by I/O anyway.
    stats: { ...g.stats(), adjacencyMs: performance.now() - t0 },
    source: loaded.source,
    bytes: loaded.bytes,
    ms: loaded.ms,
  };
}

/** Concurrent callers share one download instead of racing three fetches for one file. */
export async function ensureGraph(): Promise<LoadResult> {
  if (graph) {
    return { stats: { ...graph.stats(), adjacencyMs: 0 }, source: 'memory', bytes: 0, ms: 0 };
  }
  if (!loadInFlight) {
    loadInFlight = loadGraph().finally(() => { loadInFlight = null; });
  }
  return loadInFlight;
}

async function graphOrLoad(): Promise<Graph> {
  await ensureGraph();
  if (!graph) throw new Error('graph.bin could not be loaded');
  return graph;
}

export async function handle(req: WorkerRequest): Promise<WorkerResponse> {
  try {
    switch (req.type) {
      case 'graph:load': {
        const r = await ensureGraph();
        return {
          id: req.id, ok: true, type: 'graph:loaded', ms: r.ms, source: r.source,
          bytes: r.bytes, stats: r.stats, bootstrap: graph?.isBootstrap ?? false,
        };
      }
      case 'graph:stats': {
        const r = await ensureGraph();
        return { id: req.id, ok: true, type: 'graph:stats', stats: r.stats };
      }
      case 'train:stops': {
        const g = await graphOrLoad();
        if (req.train < 0 || req.train >= g.trainCount) {
          return {
            id: req.id, ok: false,
            error: `train index ${req.train} is out of range (0..${g.trainCount - 1})`,
          };
        }
        return {
          id: req.id, ok: true, type: 'train:stops',
          train: g.summary(req.train), stops: g.rawStopsOfTrain(req.train),
        };
      }
      case 'station:trains': {
        const g = await graphOrLoad();
        const limit = req.limit ?? 25;
        const trains: TrainSummary[] = g.trainsAt(req.station).slice(0, limit).map((t) => g.summary(t));
        return { id: req.id, ok: true, type: 'station:trains', station: req.station, trains };
      }
      default: {
        const exhaustive: never = req;
        return { id: (exhaustive as WorkerRequest).id, ok: false, error: 'unknown request type' };
      }
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { id: req.id, ok: false, error };
  }
}

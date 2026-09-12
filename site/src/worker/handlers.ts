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
import { CsaEngine, DEFAULT_MAX_JOURNEY_MIN, DEFAULT_MAX_WAIT_MIN } from '../router/csa';
import { buildTimetable, type Timetable } from '../router/timetable';
import { TransferModel } from '../router/transfers';
import { reconstructAll, type Journey } from '../router/journey';
import type { ResolvedGroup } from '../router/terminals';

export interface LoadResult {
  stats: GraphStats;
  source: string;
  bytes: number;
  ms: number;
}

let graph: Graph | null = null;
let loadInFlight: Promise<LoadResult> | null = null;

/**
 * Routing state, rebuilt only when its inputs change.
 *
 * Building the engine allocates ~8 MB of typed arrays for the label pool and the per-train
 * onboard frontiers, and the timetable expansion costs ~70 ms. Both are far too expensive to
 * repeat per query, and a traveller adjusting max-transfers or sliding the departure time is
 * issuing dozens of queries against the same graph and date.
 */
/**
 * Station count, captured at load time.
 *
 * `Graph` deliberately does not expose it: the count comes from the container's STATION_GEO
 * section header rather than from anything the graph itself needs, and threading it through
 * here keeps the worker's public surface honest about where the number came from.
 */
let stationCount = 0;
let engine: CsaEngine | null = null;
let groups: ResolvedGroup[] = [];
/** Bumped on configure so the engine is rebuilt against the new terminal groups. */
let groupsVersion = 0;
let engineGroupsVersion = -1;
let engineGraph: Graph | null = null;

/**
 * Timetables by date. A round trip searches two dates and a date slider searches one date many
 * times, so a small cache turns those from ~70 ms each into ~0.
 *
 * Bounded, because each entry is ~2 MB of typed arrays and an unbounded cache would grow for
 * as long as the tab stayed open.
 */
const ttCache = new Map<string, Timetable>();
const TT_CACHE_MAX = 4;

export function reset(): void {
  graph = null;
  loadInFlight = null;
  engine = null;
  engineGraph = null;
  engineGroupsVersion = -1;
  stationCount = 0;
  groups = [];
  groupsVersion++;
  ttCache.clear();
}

function timetableFor(g: Graph, date: string): Timetable {
  const hit = ttCache.get(date);
  if (hit) return hit;
  const tt = buildTimetable(g, date);
  if (ttCache.size >= TT_CACHE_MAX) {
    // Evict the least recently inserted date. Map preserves insertion order, which is good
    // enough here: a traveller works through one or two dates at a time, not a long tail.
    const oldest = ttCache.keys().next().value as string | undefined;
    if (oldest !== undefined) ttCache.delete(oldest);
  }
  ttCache.set(date, tt);
  return tt;
}

function engineFor(g: Graph): CsaEngine {
  if (engine !== null && engineGraph === g && engineGroupsVersion === groupsVersion) return engine;
  const transfers = new TransferModel(g, groups, stationCount);
  engine = new CsaEngine(g, transfers, stationCount);
  engineGraph = g;
  engineGroupsVersion = groupsVersion;
  return engine;
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
  stationCount = stationCountOf(loaded.container);
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
      case 'router:configure': {
        const g = await graphOrLoad();
        // Replacing the groups wholesale rather than merging: the list is authored, not
        // learned, so a second configure is a correction rather than an addition.
        groups = req.groups;
        groupsVersion++;
        const e = engineFor(g);
        return { id: req.id, ok: true, type: 'router:configured', groups: groups.length, stations: e.stationCount };
      }
      case 'journeys': {
        const g = await graphOrLoad();
        const tt = timetableFor(g, req.date);
        const e = engineFor(g);
        const maxJourneyMin = req.maxJourneyMin ?? DEFAULT_MAX_JOURNEY_MIN;
        const maxWaitMin = req.maxWaitMin ?? DEFAULT_MAX_WAIT_MIN;
        const used = { maxTransfers: req.maxTransfers, maxJourneyMin, maxWaitMin };
        const base = {
          departureMin: req.departureMin,
          origins: req.origins,
          maxTransfers: req.maxTransfers,
          preferredClass: req.preferredClass,
          maxJourneyMin,
          maxWaitMin,
        };

        // 'each' runs one search per destination; 'together' merges them into one frontier.
        // See JourneysRequest.group for why the distinction exists.
        const separate = req.group === 'each';
        const perDestination = req.perDestination ?? 1;
        const journeys: Journey[] = [];
        let ms = 0;
        let scanned = 0;
        let truncated = false;

        const buckets = separate ? req.destinations.map((d) => [d]) : [req.destinations];
        for (const bucket of buckets) {
          const result = e.search(tt, { ...base, destinations: bucket });
          ms += result.ms;
          scanned += result.scanned;
          if (result.truncated) truncated = true;
          const found = reconstructAll(result, tt, g, { departureMin: req.departureMin });
          const take = separate ? Math.min(perDestination, found.length) : found.length;
          for (let i = 0; i < take; i++) journeys.push(found[i]);
        }

        return {
          id: req.id, ok: true, type: 'journeys', journeys, date: req.date,
          ms, scanned, rows: tt.count, truncated, used,
        };
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

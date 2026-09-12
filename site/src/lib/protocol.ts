/**
 * protocol.ts — the worker ↔ UI message contract.
 *
 * The router runs in a Web Worker so that building adjacency lists and (from Phase 1)
 * running CSA never blocks the main thread; the autocomplete must stay responsive while
 * the graph loads, which is impossible if both share a thread.
 *
 * One rule keeps the payloads small: the worker speaks in STATION INDICES, never names.
 * The main thread already holds the StationIndex from stations.bin, so it resolves
 * index -> {code, name} itself. That means a 200-stop result costs ~2 KB instead of ~12 KB,
 * and no string table is duplicated into the worker.
 */

export type WorkerRequest =
  | { id: number; type: 'graph:load' }
  | { id: number; type: 'graph:stats' }
  | { id: number; type: 'train:stops'; train: number }
  | { id: number; type: 'station:trains'; station: number; limit?: number };

export interface RawStop {
  seq: number;
  station: number;
  arrMin: number | null;
  depMin: number | null;
  distKm: number;
}

export interface TrainSummary {
  train: number;
  number: string;
  name: string;
  type: string;
  classes: string[];
  classesInferred: boolean;
  runsDays: number;
  runsDaysAssumed: boolean;
  durationMin: number;
  distanceKm: number;
  origin: number;
  destination: number;
  legCount: number;
  /** Wall-clock origin departure, minutes since midnight IST. */
  originDepMin: number;
}

export type WorkerResponse =
  | { id: number; ok: true; type: 'graph:loaded'; ms: number; source: string; bytes: number;
      stats: GraphStats; bootstrap: boolean }
  | { id: number; ok: true; type: 'graph:stats'; stats: GraphStats }
  | { id: number; ok: true; type: 'train:stops'; train: TrainSummary; stops: RawStop[] }
  | { id: number; ok: true; type: 'station:trains'; station: number; trains: TrainSummary[] }
  | { id: number; ok: false; error: string; stage?: string };

export interface GraphStats {
  trains: number;
  connections: number;
  stationsWithService: number;
  adjacencyMs: number;
}

/**
 * Request type -> the exact response shape it produces. Note `graph:load` answers with
 * type `graph:loaded`, so the two unions cannot be matched by name alone; this map is what
 * lets `RouterClient.request()` return a precisely typed promise instead of a union the
 * caller has to narrow by hand.
 */
export interface ResponseMap {
  'graph:load': Extract<WorkerResponse, { ok: true; type: 'graph:loaded' }>;
  'graph:stats': Extract<WorkerResponse, { ok: true; type: 'graph:stats' }>;
  'train:stops': Extract<WorkerResponse, { ok: true; type: 'train:stops' }>;
  'station:trains': Extract<WorkerResponse, { ok: true; type: 'station:trains' }>;
}

export type RequestFor<K extends keyof ResponseMap> = Omit<
  Extract<WorkerRequest, { type: K extends 'graph:load' ? 'graph:load' : K }>,
  'id'
>;

export const WORKER_READY = 'ready';

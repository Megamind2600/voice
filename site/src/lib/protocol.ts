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

import type { Journey } from '../router/journey';
import type { ResolvedGroup } from '../router/terminals';

export type WorkerRequest =
  | { id: number; type: 'graph:load' }
  | { id: number; type: 'graph:stats' }
  | { id: number; type: 'train:stops'; train: number }
  | { id: number; type: 'station:trains'; station: number; limit?: number }
  | ConfigureRequest
  | JourneysRequest;

/**
 * Hand the worker the resolved city terminal groups.
 *
 * Sent once, after `graph:load`, because resolving them needs station CODES looked up by
 * name — and the worker deliberately holds no StationIndex. The group list is authored as
 * codes ('NDLS', 'NZM', 'DLI', ...) and only the main thread can turn those into indices.
 *
 * Without this the worker still routes, it just cannot offer a taxi between Delhi's terminals,
 * so a journey arriving at Nizamuddin would never connect to one leaving New Delhi.
 */
export interface ConfigureRequest {
  id: number;
  type: 'router:configure';
  groups: ResolvedGroup[];
}

export interface JourneysRequest {
  id: number;
  type: 'journeys';
  /** IST calendar date the traveller wants to leave, YYYY-MM-DD. */
  date: string;
  /** Minutes since midnight IST on `date`. */
  departureMin: number;
  /** Station indices. More than one means "any of these counts as arriving". */
  origins: number[];
  destinations: number[];
  /**
   * How to treat a list of destinations.
   *
   * `'together'` (the default) merges them into one Pareto set — right for "get me to Delhi",
   * where arriving at Nizamuddin instead of New Delhi is just another acceptable answer.
   *
   * `'each'` searches every destination separately and returns the best itineraries for each.
   * This is what the no-destination case needs: merging Goa and Kolkata into one frontier
   * would let the nearer city dominate the farther one on arrival time and silently delete it,
   * when the whole point is to show the traveller that both are possible.
   */
  group?: 'together' | 'each';
  /** With `group: 'each'`, how many itineraries to keep per destination. */
  perDestination?: number;
  /** Maximum number of train CHANGES. Road hops between city terminals do not count. */
  maxTransfers: number;
  /** Class to price and prefer, or null for the cheapest each train offers. */
  preferredClass: string | null;
  /** Ceiling on time in transit, minutes from first boarding to arrival. */
  maxJourneyMin?: number;
  /** How long the traveller will wait at the origin for the first departure. */
  maxWaitMin?: number;
  maxFareRupees?: number | null;
  noFootpaths?: boolean;
}

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
  | { id: number; ok: true; type: 'router:configured'; groups: number; stations: number }
  | JourneysResponse
  | { id: number; ok: false; error: string; stage?: string };

export interface JourneysResponse {
  id: number;
  ok: true;
  type: 'journeys';
  /**
   * Pareto-optimal itineraries, earliest arrival first. Station fields are indices; the main
   * thread resolves them to names, so a twelve-leg answer costs ~2 KB rather than ~12 KB.
   */
  journeys: Journey[];
  date: string;
  /** Search time in ms, reported separately from transport so slow queries are attributable. */
  ms: number;
  /** Timetable rows the scan walked. Useful for diagnosing an unexpectedly slow query. */
  scanned: number;
  rows: number;
  /** True when the label pool filled and the search stopped early: results are incomplete. */
  truncated: boolean;
  /**
   * The bounds actually used, echoed back because the UI offers a "widen the search" action
   * and must be able to say what it widened FROM.
   */
  used: { maxTransfers: number; maxJourneyMin: number; maxWaitMin: number };
}

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
  'router:configure': Extract<WorkerResponse, { ok: true; type: 'router:configured' }>;
  'journeys': Extract<WorkerResponse, { ok: true; type: 'journeys' }>;
}

export type RequestFor<K extends keyof ResponseMap> = Omit<
  Extract<WorkerRequest, { type: K extends 'graph:load' ? 'graph:load' : K }>,
  'id'
>;

export const WORKER_READY = 'ready';

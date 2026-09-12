/**
 * transfers.ts — what it costs to change trains, in minutes and rupees.
 *
 * Two distinct things are modelled here and they must not be confused:
 *
 * 1. A PLATFORM TRANSFER — same station, different train. Costs minutes only. Getting this
 *    wrong is the classic way a planner produces impossible itineraries: a 2-minute
 *    connection at Kanpur Central is a missed train, not a tight one.
 *
 * 2. A ROAD TRANSFER — different station, same city. Costs minutes AND money, and the
 *    minutes are large. NDLS to Anand Vihar is not "a transfer", it is a 45-minute taxi
 *    across Delhi. Pricing it as zero would make the router prefer absurd city-crossing
 *    "connections" over a slightly longer wait on the same platform.
 *
 * Both derive from data already in the container. Platform time comes from graph degree —
 * the number of legs touching a station, which is a direct measure of how big and busy it
 * is, and needs no shipped metadata. Road time comes from the coordinates in graph.bin's
 * STATION_GEO section, which is exactly why that section lives in graph.bin rather than
 * stations.bin: the worker can price transfers itself.
 */

import type { Graph } from '../lib/graph';
import { haversineKm, URBAN_ROAD_CIRCUITY } from '../lib/geo';
import type { ResolvedGroup } from './terminals';

/** Absolute floor. Below this, a "connection" is a walk along a platform and back. */
export const MIN_TRANSFER_FLOOR = 6;

/**
 * Average urban road speed in km/h, and the fixed overhead per road transfer.
 *
 * 22 km/h is a city average including signals and congestion, not a free-flow speed. The
 * plan is explicit that these must be realistic rather than optimistic: an optimistic
 * transfer time makes an unmakeable connection look achievable, which is the failure mode
 * that costs someone their holiday. The 12-minute fixed overhead covers leaving a station,
 * finding transport, the queue, the ride to the entrance, and re-entering through security
 * at the other end — none of which shrink with distance.
 */
export const URBAN_KMH = 22;
export const ROAD_OVERHEAD_MIN = 12;

/** Auto-rickshaw / cab pricing: a flag fall plus a per-km rate. */
export const ROAD_FLAG_RUPEES = 35;
export const ROAD_PER_KM_RUPEES = 20;
export const ROAD_MIN_RUPEES = 50;

export interface Footpath {
  from: number;
  to: number;
  minutes: number;
  km: number;
  costRupees: number;
  /** City name, for the UI ("change at Delhi — 45 min by road"). */
  city: string;
  /** Index into TransferModel.groups. */
  group: number;
  /** True when the time came from the group's fallback rather than measured geometry. */
  estimated: boolean;
}

/**
 * Minimum platform transfer in minutes for a station of a given size.
 *
 * Degree thresholds, not station names, because the dataset has no platform or layout
 * information and degree is the honest proxy available. The top band (~25 min) covers the
 * mega-terminals — Kanpur Central at 286 legs, Howrah at 283, New Delhi at 229 — where a
 * platform change genuinely means a long walk, a footbridge, and often a queue.
 */
export function minTransferForDegree(degree: number): number {
  if (degree >= 300) return 25;
  if (degree >= 120) return 20;
  if (degree >= 40) return 15;
  if (degree >= 8) return 12;
  return MIN_TRANSFER_FLOOR;
}

export function roadMinutes(km: number): number {
  return Math.round(ROAD_OVERHEAD_MIN + (km * URBAN_ROAD_CIRCUITY) / URBAN_KMH * 60);
}

export function roadCostRupees(km: number): number {
  const circuityKm = km * URBAN_ROAD_CIRCUITY;
  return Math.max(ROAD_MIN_RUPEES, Math.round(ROAD_FLAG_RUPEES + circuityKm * ROAD_PER_KM_RUPEES));
}

export interface TransferStats {
  stationCount: number;
  groups: number;
  footpaths: number;
  /** Stations whose coordinates were missing, so their road times fell back to the spec. */
  unmeasuredFootpaths: number;
  minTransferByBand: Record<string, number>;
}

export class TransferModel {
  private readonly minTransfer: Uint8Array;
  private readonly paths: Footpath[][];
  private readonly groupOf: Int32Array;
  private unmeasured = 0;

  // `graph` is a plain parameter, not a stored property: everything needed from it (degree
  // and coordinates) is read once during construction. Keeping a reference would retain the
  // whole container for the lifetime of the model for no reason.
  constructor(
    graph: Graph,
    readonly groups: readonly ResolvedGroup[],
    stationCount: number,
  ) {
    this.minTransfer = new Uint8Array(stationCount);
    for (let s = 0; s < stationCount; s++) {
      this.minTransfer[s] = minTransferForDegree(graph.degree(s));
    }

    this.groupOf = new Int32Array(stationCount).fill(-1);
    this.paths = new Array(stationCount);
    for (let s = 0; s < stationCount; s++) this.paths[s] = [];

    for (let g = 0; g < groups.length; g++) {
      const group = groups[g];
      for (const a of group.members) this.groupOf[a] = g;

      for (const a of group.members) {
        for (const b of group.members) {
          if (a === b) continue;
          const ca = graph.coordsOf(a);
          const cb = graph.coordsOf(b);
          let km: number;
          let minutes: number;
          let estimated = false;
          if (ca && cb) {
            km = haversineKm(ca.lat, ca.lon, cb.lat, cb.lon);
            minutes = roadMinutes(km);
          } else {
            // No coordinates for one end: fall back to the authored city estimate rather
            // than dropping the edge. A conservative guess beats pretending the two
            // terminals are unrelated, which would force a needless extra transfer.
            estimated = true;
            minutes = group.fallbackMinutes;
            km = ((minutes - ROAD_OVERHEAD_MIN) / 60) * URBAN_KMH / URBAN_ROAD_CIRCUITY;
            this.unmeasured++;
          }
          this.paths[a].push({
            from: a, to: b, minutes, km: Math.round(km * 10) / 10,
            costRupees: roadCostRupees(km), city: group.city, group: g, estimated,
          });
        }
      }
    }
  }

  /**
   * Minimum minutes required to change trains at a station.
   *
   * Staying on the same train is NOT a transfer and must not pay this — a caller that asks
   * about the same train should use 0. Enforcing a platform-transfer time on a passenger
   * who never leaves the train would reject valid through-journeys.
   */
  /**
   * The per-station minimum transfer table itself, for callers inside a hot loop.
   *
   * `minTransferMin` is the readable API and carries a same-train exemption the search never
   * needs, because staying aboard is handled by the onboard frontier rather than by a zero
   * transfer time. Reading the array directly removes a call and a branch per row.
   */
  get minTransferTable(): Uint8Array {
    return this.minTransfer;
  }

  minTransferMin(station: number, arrivingTrain = -1, departingTrain = -1): number {
    if (arrivingTrain >= 0 && arrivingTrain === departingTrain) return 0;
    return this.minTransfer[station] ?? MIN_TRANSFER_FLOOR;
  }

  /** Road transfers leaving a station. Empty for the ~99% of stations not in a city group. */
  footpathsFrom(station: number): readonly Footpath[] {
    return this.paths[station] ?? EMPTY_PATHS;
  }

  /** Group index for a station, or -1. */
  groupOfStation(station: number): number {
    return this.groupOf[station] ?? -1;
  }

  /** True when two stations are terminals of the same city. */
  isSameCity(a: number, b: number): boolean {
    const g = this.groupOf[a];
    return g !== undefined && g >= 0 && g === this.groupOf[b];
  }

  get stationCount(): number {
    return this.minTransfer.length;
  }

  stats(): TransferStats {
    let footpaths = 0;
    for (const p of this.paths) footpaths += p.length;
    const bands: Record<string, number> = {};
    for (let s = 0; s < this.minTransfer.length; s++) {
      const v = String(this.minTransfer[s]);
      bands[v] = (bands[v] ?? 0) + 1;
    }
    return {
      stationCount: this.minTransfer.length,
      groups: this.groups.length,
      footpaths,
      unmeasuredFootpaths: this.unmeasured,
      minTransferByBand: bands,
    };
  }
}

const EMPTY_PATHS: readonly Footpath[] = [];

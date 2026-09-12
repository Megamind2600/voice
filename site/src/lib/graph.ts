/**
 * graph.ts — decode graph.bin into the adjacency structures the router needs.
 *
 * Connections are stored grouped by train (so a train's legs are one contiguous run,
 * which is cache-friendly and needs no per-leg train id). For routing we need the
 * transposed view — everything leaving a station — so this module builds per-station
 * adjacency lists once at load.
 *
 * Times in this container are MINUTES RELATIVE TO EACH TRAIN'S OWN ORIGIN DEPARTURE, not
 * wall-clock. That is what makes the file small (u16 instead of i32) and it is correct:
 * the absolute time depends on which service date the train runs, which the router
 * resolves from `runsDays` at query time. Comparing depMin across different trains is
 * therefore meaningless, and nothing here does it.
 */

import {
  Container, ContainerFlag, ContainerKind, SectionId, TRAIN_WORDS, CONN_HALFWORDS,
} from './binary';
import type { StationIndex } from './stations';
import type { RawStop, TrainSummary } from './protocol';

export const CLASS_BIT: Record<string, number> = {
  '1A': 1, '2A': 2, '3A': 4, '3E': 8, SL: 16, CC: 32, EC: 64, FC: 128, '2S': 256, UR: 512,
};
export const CLASS_ORDER = ['1A', '2A', '3A', '3E', 'CC', 'EC', 'FC', 'SL', '2S', 'UR'] as const;

/** Train type ids, matching TYPE_CODES in harvester/pack_binary.py. 0 = unknown. */
export const TRAIN_TYPES = [
  'UNK', 'RAJ', 'SHT', 'DRNT', 'GBR', 'SVD', 'HMS', 'VNDB', 'SUF', 'MEX',
  'PAX', 'SPL', 'ANT', 'JSB', 'DDE', 'INT',
] as const;

export const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

export interface Train {
  readonly i: number;
  readonly number: string;
  readonly name: string;
  readonly type: string;
  readonly classes: readonly string[];
  readonly classesInferred: boolean;
  readonly runsDays: number;
  readonly runsDaysAssumed: boolean;
  readonly durationMin: number;
  readonly distanceKm: number;
  readonly origin: number;
  readonly destination: number;
  readonly legCount: number;
  readonly connStart: number;
  /**
   * Wall-clock departure from the origin, in minutes since midnight IST. Connection times
   * are relative to this, so true clock times are `originDepMin + relMin`.
   */
  readonly originDepMin: number;
}

export interface Leg {
  readonly conn: number;
  readonly from: number;
  readonly to: number;
  /** Minutes after this train's origin departure. */
  readonly depMin: number;
  readonly arrMin: number;
  readonly distKm: number;
}

export interface Stop {
  readonly seq: number;
  readonly station: number;
  readonly code: string;
  readonly name: string;
  readonly arrMin: number | null;
  readonly depMin: number | null;
  readonly haltMin: number;
  readonly distKm: number;
  readonly dayOff: number;
}

/** Format minutes as HH:MM, with a "+D" prefix once the clock rolls past midnight. */
export function fmtClock(min: number | null): string {
  if (min === null) return '—';
  const day = Math.floor(min / 1440);
  const m = ((min % 1440) + 1440) % 1440;
  const hh = String(Math.floor(m / 60)).padStart(2, '0');
  const mm = String(m % 60).padStart(2, '0');
  return day > 0 ? `+${day} ${hh}:${mm}` : `${hh}:${mm}`;
}

/**
 * Convert a train-relative offset to a true wall-clock time.
 *
 * Packed connection times are minutes AFTER the train's own origin departure, which is
 * what lets them fit in a u16. Displaying those directly is actively misleading: a
 * relative "17:00" reads as 5 pm but really means "17 hours after departure". Adding the
 * origin's wall-clock departure recovers the real time, and `day` counts forward from the
 * departure date so an overnight arrival still reads correctly.
 */
export function toWallClock(originDepMin: number, relMin: number | null):
  { day: number; minOfDay: number } | null {
  if (relMin === null) return null;
  const total = originDepMin + relMin;
  return { day: Math.floor(total / 1440), minOfDay: ((total % 1440) + 1440) % 1440 };
}

/** Wall-clock HH:MM plus a "+D" marker for days after departure. */
export function fmtWallClock(originDepMin: number, relMin: number | null): string {
  const w = toWallClock(originDepMin, relMin);
  if (!w) return '—';
  const hh = String(Math.floor(w.minOfDay / 60)).padStart(2, '0');
  const mm = String(w.minOfDay % 60).padStart(2, '0');
  return w.day > 0 ? `${hh}:${mm} +${w.day}d` : `${hh}:${mm}`;
}

export function fmtDuration(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

/** Bitmask -> ordered class codes. */
export function decodeClasses(mask: number): string[] {
  const out: string[] = [];
  for (const c of CLASS_ORDER) {
    const bit = CLASS_BIT[c];
    if (bit !== undefined && (mask & bit) !== 0) out.push(c);
  }
  return out;
}

/** runsDays bitmask (bit 0 = Monday) -> "Daily" / "Mon, Wed, Fri" / etc. */
export function decodeRunsDays(mask: number): string {
  if ((mask & 0x7f) === 0x7f) return 'Daily';
  const days: string[] = [];
  for (let d = 0; d < 7; d++) if ((mask & (1 << d)) !== 0) days.push(DAY_NAMES[d]);
  return days.length === 0 ? 'Unknown' : days.join(', ');
}

export class Graph {
  readonly trainCount: number;
  readonly connCount: number;
  readonly isBootstrap: boolean;
  readonly runsDaysAllAssumed: boolean;

  private readonly words: Uint32Array;
  private readonly conns: Uint16Array;
  private readonly numbers: string[];
  private readonly names: string[];

  /** station index -> connection ids departing it */
  private readonly depAdj: Int32Array[];
  /** station index -> connection ids arriving at it */
  private readonly arrAdj: Int32Array[];

  private constructor(container: Container, stationCount: number) {
    if (container.info.kind !== ContainerKind.Graph) {
      throw new Error(`expected a graph container, got kind ${container.info.kind}`);
    }
    this.isBootstrap = container.isBootstrap;

    const tMeta = container.section(SectionId.Trains);
    if (tMeta.itemSize !== TRAIN_WORDS * 4) {
      throw new Error(`train records are ${tMeta.itemSize} B, expected ${TRAIN_WORDS * 4} B`);
    }
    const cMeta = container.section(SectionId.Connections);
    if (cMeta.itemSize !== CONN_HALFWORDS * 2) {
      throw new Error(`connection records are ${cMeta.itemSize} B, expected ${CONN_HALFWORDS * 2} B`);
    }

    this.words = container.u32(SectionId.Trains);
    this.conns = container.u16(SectionId.Connections);
    this.trainCount = tMeta.count;
    this.connCount = cMeta.count;

    // Materialise the two strings per train once. Doing this lazily would mean a
    // TextDecoder pass on every render of a result list.
    this.numbers = new Array(this.trainCount);
    this.names = new Array(this.trainCount);
    for (let t = 0; t < this.trainCount; t++) {
      const base = t * TRAIN_WORDS;
      this.names[t] = container.str(this.words[base]);
      this.numbers[t] = container.str(this.words[base + 1]);
    }

    // ---- transpose: connections grouped by train -> adjacency by station ----
    const depCount = new Int32Array(stationCount);
    const arrCount = new Int32Array(stationCount);
    for (let c = 0; c < this.connCount; c++) {
      const b = c * CONN_HALFWORDS;
      depCount[this.conns[b + 2]]++;
      arrCount[this.conns[b + 3]]++;
    }
    const depFill = new Int32Array(stationCount);
    const arrFill = new Int32Array(stationCount);
    this.depAdj = new Array(stationCount);
    this.arrAdj = new Array(stationCount);
    for (let s = 0; s < stationCount; s++) {
      this.depAdj[s] = new Int32Array(depCount[s]);
      this.arrAdj[s] = new Int32Array(arrCount[s]);
    }
    for (let c = 0; c < this.connCount; c++) {
      const b = c * CONN_HALFWORDS;
      const from = this.conns[b + 2];
      const to = this.conns[b + 3];
      this.depAdj[from][depFill[from]++] = c;
      this.arrAdj[to][arrFill[to]++] = c;
    }

    // Derived from the per-train flags rather than a container-level bit: the container
    // flag describes the FILE, but "are running days assumed?" is a property of the DATA.
    // Reading it off the trains themselves means a future mixed dataset (part NTES, part
    // bootstrap) reports the truth instead of a blanket claim.
    let assumed = 0;
    for (let t = 0; t < this.trainCount; t++) {
      if (((this.words[t * TRAIN_WORDS + 7] >>> 16) & ContainerFlag.RunsDaysAssumed) !== 0) assumed++;
    }
    this.runsDaysAllAssumed = this.trainCount > 0 && assumed === this.trainCount;
  }

  /**
   * @param stationCount size of the station index the packed data refers to. The worker
   *   does not hold a StationIndex, so this is passed as a number; `stationCountOf` reads
   *   it straight off the container.
   */
  static fromContainer(container: Container, stationCount: number): Graph {
    return new Graph(container, stationCount);
  }

  train(t: number): Train {
    if (t < 0 || t >= this.trainCount) throw new RangeError(`train ${t} out of range`);
    const b = t * TRAIN_WORDS;
    const w = this.words;
    const flags = (w[b + 7] >>> 16) & 0xff;
    return {
      i: t,
      name: this.names[t],
      number: this.numbers[t],
      type: TRAIN_TYPES[w[b + 7] & 0xff] ?? 'UNK',
      classes: decodeClasses(w[b + 5] >>> 16),
      classesInferred: (flags & ContainerFlag.ClassesInferred) !== 0,
      runsDays: (w[b + 7] >>> 8) & 0xff,
      runsDaysAssumed: (flags & ContainerFlag.RunsDaysAssumed) !== 0,
      durationMin: w[b + 3] >>> 16,
      distanceKm: w[b + 4] & 0xffff,
      origin: (w[b + 4] >>> 16) & 0xffff,
      destination: w[b + 5] & 0xffff,
      legCount: w[b + 3] & 0xffff,
      connStart: w[b + 2],
      originDepMin: w[b + 6] & 0xffff,
    };
  }

  leg(c: number): Leg {
    if (c < 0 || c >= this.connCount) throw new RangeError(`connection ${c} out of range`);
    const b = c * CONN_HALFWORDS;
    return {
      conn: c,
      depMin: this.conns[b],
      arrMin: this.conns[b + 1],
      from: this.conns[b + 2],
      to: this.conns[b + 3],
      distKm: this.conns[b + 4],
    };
  }

  legsOfTrain(t: number): Leg[] {
    const tr = this.train(t);
    const out: Leg[] = new Array(tr.legCount);
    for (let k = 0; k < tr.legCount; k++) out[k] = this.leg(tr.connStart + k);
    return out;
  }

  /**
   * Rebuild the stop list from legs. Stops are not stored explicitly — a train with n
   * legs has n+1 stops, and each leg already carries its own from/to, so the list is
   * recovered for free. That saves ~1 MB of duplicated station indices.
   */
  stopsOfTrain(t: number, stations: StationIndex): Stop[] {
    const tr = this.train(t);
    const legs = this.legsOfTrain(t);
    const out: Stop[] = [];

    const push = (station: number, seq: number, arrMin: number | null,
                  depMin: number | null, distKm: number): void => {
      const s = stations.at(station);
      const halt = arrMin === null || depMin === null ? 0 : Math.max(0, depMin - arrMin);
      out.push({
        seq, station, code: s.code, name: s.name, arrMin, depMin, haltMin: halt,
        distKm, dayOff: Math.floor((depMin ?? arrMin ?? 0) / 1440),
      });
    };

    // Distance is cumulative from the origin, so stop k sits at leg[k-1].to's km.
    push(tr.origin, 1, null, legs.length ? legs[0].depMin : null, 0);
    for (let k = 0; k < legs.length; k++) {
      const leg = legs[k];
      const isLast = k === legs.length - 1;
      push(leg.to, k + 2, leg.arrMin, isLast ? null : legs[k + 1].depMin, leg.distKm);
    }
    return out;
  }

  /** Plain train header, ready to cross the worker boundary (station INDICES only). */
  summary(t: number): TrainSummary {
    const tr = this.train(t);
    return {
      train: tr.i, number: tr.number, name: tr.name, type: tr.type,
      classes: [...tr.classes], classesInferred: tr.classesInferred,
      runsDays: tr.runsDays, runsDaysAssumed: tr.runsDaysAssumed,
      durationMin: tr.durationMin, distanceKm: tr.distanceKm,
      origin: tr.origin, destination: tr.destination, legCount: tr.legCount,
      originDepMin: tr.originDepMin,
    };
  }

  /**
   * Stop list as raw station indices — the worker's return format. The UI resolves names
   * from its own StationIndex, so no strings cross the boundary.
   */
  rawStopsOfTrain(t: number): RawStop[] {
    const tr = this.train(t);
    const legs = this.legsOfTrain(t);
    const out: RawStop[] = [];
    out.push({
      seq: 1, station: tr.origin, arrMin: null,
      depMin: legs.length ? legs[0].depMin : null, distKm: 0,
    });
    for (let k = 0; k < legs.length; k++) {
      const isLast = k === legs.length - 1;
      out.push({
        seq: k + 2, station: legs[k].to, arrMin: legs[k].arrMin,
        depMin: isLast ? null : legs[k + 1].depMin, distKm: legs[k].distKm,
      });
    }
    return out;
  }

  /** Connections leaving a station — the primitive CSA scans. */
  departuresFrom(station: number): Int32Array {
    return this.depAdj[station] ?? EMPTY;
  }

  /** Connections arriving at a station. */
  arrivalsAt(station: number): Int32Array {
    return this.arrAdj[station] ?? EMPTY;
  }

  /** Trains that call at a station, deduplicated, ordered by train index. */
  trainsAt(station: number): number[] {
    const seen = new Set<number>();
    const out: number[] = [];
    for (const c of this.departuresFrom(station)) {
      const t = this.trainOfConnection(c);
      if (t >= 0 && !seen.has(t)) { seen.add(t); out.push(t); }
    }
    for (const c of this.arrivalsAt(station)) {
      const t = this.trainOfConnection(c);
      if (t >= 0 && !seen.has(t)) { seen.add(t); out.push(t); }
    }
    return out.sort((a, b) => a - b);
  }

  /** Binary search the train table for the owner of a connection id. */
  trainOfConnection(conn: number): number {
    let lo = 0;
    let hi = this.trainCount - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const start = this.words[mid * TRAIN_WORDS + 2];
      const count = this.words[mid * TRAIN_WORDS + 3] & 0xffff;
      if (conn < start) hi = mid - 1;
      else if (conn >= start + count) lo = mid + 1;
      else return mid;
    }
    return -1;
  }

  stats(): { trains: number; connections: number; stationsWithService: number } {
    let served = 0;
    for (let s = 0; s < this.depAdj.length; s++) {
      if (this.depAdj[s].length > 0 || this.arrAdj[s].length > 0) served++;
    }
    return { trains: this.trainCount, connections: this.connCount, stationsWithService: served };
  }
}

const EMPTY = new Int32Array(0);

/**
 * Station count implied by a graph container, read from its STATION_GEO section (exactly
 * one coordinate pair per station). Lets the worker size its adjacency arrays without
 * ever loading stations.bin.
 */
export function stationCountOf(container: Container): number {
  return container.has(SectionId.StationGeo)
    ? container.section(SectionId.StationGeo).count
    : 0;
}

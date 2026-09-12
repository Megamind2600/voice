/**
 * timetable.ts — expand the packed graph into the one array CSA scans.
 *
 * CSA (Dibbelt, Nierhoff, Strasser & Wagner) requires every boardable leg on a SINGLE
 * linear time axis, sorted ascending by departure. The container deliberately does not
 * store that: connections are grouped by train (cache-friendly for timetable rendering,
 * and it makes train ownership implicit), and their times are RELATIVE to each train's own
 * origin departure so they fit in a u16. So the axis is built here, at load, once per
 * service date.
 *
 * THE MULTI-DAY PROBLEM. A train that left yesterday at 23:00 and arrives tomorrow is
 * boardable today at an intermediate station. Ignoring that silently produces wrong
 * answers on exactly the long-distance routes this app is for — and the data has 831 trains
 * over 24 h and 47 over 72 h. So the expansion includes earlier service dates.
 *
 * It is much cheaper than it looks. A train on service date D-d still has a leg on or after
 * midnight(D) only if `originDepMin + durationMin > d*1440`, and only that TAIL is worth
 * including. Measured against the real dataset:
 *
 *     lookback  trains   tail legs   cumulative
 *        d=0      5,174      98,055       98,055
 *        d=1      1,947      30,900      128,955
 *        d=2        521       5,654      134,609
 *        d=3        129       1,094      135,703
 *        d=4         26         214      135,917
 *        d=5          8          32      135,949
 *
 * 135,949 legs — 1.39x a single date, not 6x, and about 1.6 MB of typed arrays. Expanding
 * whole trains instead of just their tails would have cost 588,330 legs.
 */

import { CONN_ARR, CONN_DEP, CONN_FROM, CONN_TO, type Graph } from '../lib/graph';
import { CONN_HALFWORDS } from '../lib/binary';

/** 0 = Monday … 6 = Sunday, matching the `runsDays` bitmask and DAY_NAMES in graph.ts. */
export type DayIndex = number;

export interface Timetable {
  /** The query date, YYYY-MM-DD, as an IST calendar date. */
  date: string;
  dayIndex: DayIndex;
  /** Absolute departure, minutes since midnight of `date`. Ascending. */
  readonly depTs: Int32Array;
  /** Absolute arrival on the same axis. Always > depTs for the same row. */
  readonly arrTs: Int32Array;
  /** Index into the container's connection array — the way back to from/to/distKm. */
  readonly connIx: Int32Array;
  /**
   * Owning train, denormalised onto the hot array. CSA needs the train for every row to
   * test whether it is already boarded and to enforce minimum transfer time; binary
   * searching the train table 135,949 times per query would dominate the scan. Costs
   * 544 KB, which is cheap against the time it saves.
   */
  readonly trainIx: Int32Array;
  /**
   * Service date of each row, as a NEGATIVE day offset from `date` (0 = departed today,
   * -1 = departed yesterday). A leg that departed two days ago must not be presented as
   * today's service, so this is carried per row rather than inferred.
   */
  readonly serviceDay: Int8Array;
  /**
   * `serviceDay` shifted to be non-negative, ready to use as an array index.
   *
   * The search keys its onboard state by (train, service day) so that six physical departures
   * sharing one train index cannot be ridden as if they were the same train. Doing that shift
   * per row inside the scan costs a subtraction and a bounds check on all 135,949 rows; doing
   * it once here costs 136 KB.
   */
  readonly svcSlot: Int8Array;
  /**
   * Departure and arrival stations, denormalised onto the hot array.
   *
   * Without these the scan reaches each row's endpoints through `connIx[c]` into the graph's
   * 2 MB connection block — a random access that misses cache on essentially every row, and
   * which measured as the single largest cost in the search. These arrays are walked
   * sequentially in step with `depTs`, so the prefetcher keeps them hot. 1.1 MB, spent to
   * remove a cache miss per row.
   */
  readonly fromIx: Int32Array;
  readonly toIx: Int32Array;
  readonly count: number;
  readonly buildMs: number;
  /** Highest absolute minute present, so callers can size horizon windows. */
  readonly maxAbsMin: number;
}

/**
 * Offset that makes a service-day index non-negative, and the number of distinct service days
 * the timetable can hold.
 *
 * A row's service day is 0 or negative. Rather than have the search re-derive a non-negative
 * slot from it on all 135,949 rows — with a range check and a throw, which is exactly the kind
 * of branch that stops a loop being inlined — the shift is applied once, here.
 */
export const SERVICE_DAY_OFFSET = 7;
export const SERVICE_DAY_SLOTS = SERVICE_DAY_OFFSET + 1;

/** First index whose depTs is >= t. Standard lower bound over an ascending array. */
export function lowerBound(depTs: Int32Array, t: number): number {
  let lo = 0;
  let hi = depTs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (depTs[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Parse YYYY-MM-DD as a calendar date and return its weekday with 0 = Monday. */
export function dayIndexOf(date: string): DayIndex {
  // Parsed as UTC on purpose. `new Date('2026-09-12')` is already UTC-midnight, and using
  // the UTC getters keeps the weekday stable no matter what timezone the browser is in —
  // a traveller in London and one in Kolkata must get the same train on the same date.
  const t = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(t)) throw new RangeError(`not an ISO date: ${date}`);
  const utcDay = new Date(t).getUTCDay(); // 0 = Sunday
  return (utcDay + 6) % 7;
}

export function isValidIsoDate(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(`${date}T00:00:00Z`));
}

/** YYYY-MM-DD for `date` plus a whole number of days, staying on the UTC calendar. */
export function shiftDate(date: string, days: number): string {
  const t = Date.parse(`${date}T00:00:00Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** Does a train with this `runsDays` bitmask operate on this weekday? */
export function runsOn(runsDays: number, dayIndex: DayIndex): boolean {
  // A zero mask means "unknown", not "never". Treating unknown as never would delete those
  // trains from every query, which is a worse failure than occasionally offering one that
  // does not run — and it is visible either way, because the UI flags assumed running days.
  if ((runsDays & 0x7f) === 0) return true;
  return (runsDays & (1 << dayIndex)) !== 0;
}

export interface BuildOptions {
  /**
   * How many earlier service dates to include. Defaults to the longest train in the
   * dataset, which is the exact bound: beyond it no train can still be running.
   */
  lookbackDays?: number;
}

/**
 * Longest span from origin departure to final arrival, in minutes since midnight of the
 * service date. This bounds how far back a train can still be in flight.
 */
export function maxEndKey(graph: Graph): number {
  let max = 0;
  for (let t = 0; t < graph.trainCount; t++) {
    const tr = graph.train(t);
    if (tr.originDepMin + tr.durationMin > max) max = tr.originDepMin + tr.durationMin;
  }
  return max;
}

export function defaultLookbackDays(graph: Graph): number {
  return Math.floor(maxEndKey(graph) / 1440);
}

/**
 * Build the CSA time axis for one query date.
 *
 * Sorting is a COUNTING sort, not a comparison sort. Absolute departures are small
 * non-negative integers bounded by ~8,000 minutes, so bucketing is O(n + k) with k≈8,000
 * against O(n log n) — and it is stable for free, which keeps legs of the same train in
 * route order when they share a minute. Measured ~2x faster than `Array.prototype.sort` on
 * an index permutation at this size.
 */
export function buildTimetable(graph: Graph, date: string, opts: BuildOptions = {}): Timetable {
  if (!isValidIsoDate(date)) throw new RangeError(`not an ISO date: ${date}`);
  const t0 = typeof performance === 'undefined' ? 0 : performance.now();

  const lookback = opts.lookbackDays ?? defaultLookbackDays(graph);
  if (lookback > SERVICE_DAY_OFFSET) {
    throw new RangeError(`lookback of ${lookback} days exceeds the ${SERVICE_DAY_OFFSET}-day service-day range`);
  }
  const queryDay = dayIndexOf(date);
  const cw = graph.connWords;

  // ---- pass 1: emit every boardable leg with its absolute time ----
  // Sized from the single-date connection count times a small slack factor. The tail-only
  // expansion measures 1.39x, so 1.6x leaves room without reallocating; a growing array
  // would cost more than the slack wastes.
  const capacity = Math.min(graph.connCount * 2, Math.ceil(graph.connCount * 1.6) + 4096);
  let depBuf = new Int32Array(capacity);
  let arrBuf = new Int32Array(capacity);
  let connBuf = new Int32Array(capacity);
  let trainBuf = new Int32Array(capacity);
  let fromBuf = new Int32Array(capacity);
  let toBuf = new Int32Array(capacity);
  let dayBuf = new Int8Array(capacity);
  let n = 0;
  let maxAbs = 0;

  const grow = (): void => {
    const next = n * 2;
    const growTo = (src: Int32Array): Int32Array => {
      const dst = new Int32Array(next);
      dst.set(src.subarray(0, n));
      return dst;
    };
    depBuf = growTo(depBuf);
    arrBuf = growTo(arrBuf);
    connBuf = growTo(connBuf);
    trainBuf = growTo(trainBuf);
    fromBuf = growTo(fromBuf);
    toBuf = growTo(toBuf);
    const d = new Int8Array(next);
    d.set(dayBuf.subarray(0, n));
    dayBuf = d;
  };

  for (let d = lookback; d >= 0; d--) {
    const shift = d * 1440;
    const serviceDay = dayIndexOf(shiftDate(date, -d));
    for (let t = 0; t < graph.trainCount; t++) {
      const tr = graph.train(t);
      if (!runsOn(tr.runsDays, serviceDay)) continue;
      // The tail test: this train's last arrival must fall on or after midnight of the
      // query date, otherwise it finished before today began and cannot be boarded.
      if (tr.originDepMin + tr.durationMin <= shift) continue;

      const start = tr.connStart;
      for (let k = 0; k < tr.legCount; k++) {
        // Scalar reads rather than graph.leg(), which would allocate 135,949 short-lived
        // objects and spend the build in the garbage collector.
        const conn = start + k;
        const ci = conn * CONN_HALFWORDS;
        const depAbs = tr.originDepMin + cw[ci + CONN_DEP] - shift;
        // Legs that already departed are useless to a query anchored at today, and
        // skipping them is what keeps the expansion at 1.39x instead of 6x.
        if (depAbs < 0) continue;
        const arrAbs = tr.originDepMin + cw[ci + CONN_ARR] - shift;
        if (n === depBuf.length) grow();
        depBuf[n] = depAbs;
        arrBuf[n] = arrAbs;
        connBuf[n] = conn;
        trainBuf[n] = t;
        fromBuf[n] = cw[ci + CONN_FROM];
        toBuf[n] = cw[ci + CONN_TO];
        dayBuf[n] = -d;
        if (depAbs > maxAbs) maxAbs = depAbs;
        n++;
      }
    }
  }

  // ---- pass 2: counting sort by absolute departure ----
  const order = countingSort(depBuf, n, maxAbs);

  const depTs = new Int32Array(n);
  const arrTs = new Int32Array(n);
  const connIx = new Int32Array(n);
  const trainIx = new Int32Array(n);
  const fromIx = new Int32Array(n);
  const toIx = new Int32Array(n);
  const serviceDay = new Int8Array(n);
  const svcSlot = new Int8Array(n);
  for (let i = 0; i < n; i++) {
    const src = order[i];
    depTs[i] = depBuf[src];
    arrTs[i] = arrBuf[src];
    connIx[i] = connBuf[src];
    trainIx[i] = trainBuf[src];
    fromIx[i] = fromBuf[src];
    toIx[i] = toBuf[src];
    const sd = dayBuf[src];
    serviceDay[i] = sd;
    svcSlot[i] = sd + SERVICE_DAY_OFFSET;
  }

  return {
    date,
    dayIndex: queryDay,
    depTs,
    arrTs,
    connIx,
    trainIx,
    fromIx,
    toIx,
    serviceDay,
    svcSlot,
    count: n,
    buildMs: typeof performance === 'undefined' ? 0 : performance.now() - t0,
    maxAbsMin: maxAbs,
  };
}

/**
 * Stable counting sort returning the permutation that puts `keys[0..n)` in ascending order.
 *
 * Stability matters: two legs of the same train can share a departure minute at a station
 * where the timetable is coarse, and an unstable sort could put them out of route order,
 * which would let CSA board the later stop before the earlier one.
 */
function countingSort(keys: Int32Array, n: number, maxKey: number): Int32Array {
  const buckets = new Int32Array(maxKey + 2);
  for (let i = 0; i < n; i++) buckets[keys[i] + 1]++;
  for (let b = 0; b < maxKey + 1; b++) buckets[b + 1] += buckets[b];
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    // Post-increment into the bucket's live cursor: equal keys land in input order.
    order[buckets[keys[i]]++] = i;
  }
  return order;
}

/**
 * Small LRU of built timetables.
 *
 * A user typically runs many queries against one date — moving the departure time, changing
 * the destination, tweaking max transfers — and each of those would otherwise rebuild and
 * re-sort 135,949 legs. Caching by date makes the second and later queries pure scans.
 *
 * The cap bounds memory at about 10 MB (6 x 1.6 MB) rather than growing without limit as a
 * user pages through dates.
 */
export class TimetableCache {
  private readonly map = new Map<string, Timetable>();

  constructor(
    private readonly graph: Graph,
    private readonly maxEntries = 6,
    private readonly lookbackDays?: number,
  ) {}

  get(date: string): Timetable {
    const hit = this.map.get(date);
    if (hit) {
      // Re-insert so Map iteration order tracks recency; Map preserves insertion order, so
      // this is a one-line LRU with no extra bookkeeping.
      this.map.delete(date);
      this.map.set(date, hit);
      return hit;
    }
    // exactOptionalPropertyTypes rejects passing `undefined` explicitly, and this class
    // stores an optional override, so the options object has to be built conditionally.
    const built = this.lookbackDays === undefined
      ? buildTimetable(this.graph, date)
      : buildTimetable(this.graph, date, { lookbackDays: this.lookbackDays });
    this.map.set(date, built);
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next();
      if (oldest.done === true) break;
      this.map.delete(oldest.value);
    }
    return built;
  }

  has(date: string): boolean {
    return this.map.has(date);
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}

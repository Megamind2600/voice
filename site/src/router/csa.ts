/**
 * csa.ts — multi-criteria connection scan.
 *
 * Scans ONE array of connections sorted by departure time, exactly once, relaxing each
 * connection as it goes: O(|C|) with a tiny constant and strictly sequential access, against
 * a time-expanded Dijkstra's O(E log V) over a much larger graph.
 *
 * THREE THINGS ARE GATED INSIDE THE SCAN, never applied as post-filters, because filtering
 * afterwards silently returns journeys that were never legal: minimum transfer time, the
 * maximum-transfers constraint, and running days (the last applied when timetable.ts
 * expands, so a weekly train simply does not exist on a day it does not run).
 *
 * ---------------------------------------------------------------------------
 * TWO KINDS OF STATE, AND WHY
 * ---------------------------------------------------------------------------
 * The obvious design keeps one Pareto frontier per station and compares labels directly. It
 * is wrong, and the failure is silent: staying on your own train is free while switching
 * costs a transfer, so two labels at the same station with identical numbers are NOT
 * interchangeable. A faster train to an intermediate station dominates the slower one you
 * are actually sitting on, the slower one is discarded, and the faster one then cannot
 * continue without a change — so with maxTransfers=0 a through ride returns NO RESULTS. A
 * 109-leg Howrah-Amritsar service produced exactly zero journeys until this was fixed.
 *
 * Making domination train-aware fixes that but breaks something else: every train passing
 * through a junction now keeps its own incomparable label, the frontier cap fills, and
 * eviction starts discarding late-departing services wholesale.
 *
 * So the state is split instead:
 *
 *   - `onboard[train][serviceDay]` — labels currently RIDING a specific train. Compared
 *     plainly, because they are all on the same train. Riding forward mutates them in place.
 *   - `platform[station]` — labels that are OFF a train, waiting. Compared plainly too,
 *     because once you are standing on a platform your train identity is irrelevant: any
 *     label that gets you there earlier and cheaper can board everything the other could.
 *
 * Boarding moves a platform label into an onboard frontier; alighting moves it back. This is
 * the same split RAPTOR gets from its round-based route scanning, obtained here without
 * giving up the single sequential pass.
 *
 * Service day is part of the onboard key because one train index covers up to six physical
 * departures in an expanded timetable (see timetable.ts). Letting a passenger ride from
 * yesterday's 23:00 departure straight into today's would join two different trains.
 *
 * ---------------------------------------------------------------------------
 * REPRESENTATION
 * ---------------------------------------------------------------------------
 * Labels live in one interleaved Int32Array. At several hundred thousand writes per sweep,
 * an array of objects would spend most of its time in the allocator and collector instead of
 * in the search. Rejected labels are reclaimed immediately, so the pool tracks live state.
 */

import type { Graph } from '../lib/graph';
import { lowerBound, SERVICE_DAY_SLOTS, type Timetable } from './timetable';
import { cheapestClass, classMultiplier, slBase, typeMultiplier } from './fares';
import { haversineKm } from '../lib/geo';
import type { Footpath, TransferModel } from './transfers';

/**
 * Label fields, as Int32 offsets within the pool.
 *
 * The first six are the Pareto criteria and the fields every domination test reads, so they
 * sit first: one cache line covers the whole comparison. `dominates` is unit-tested against
 * these offsets directly, which is what pins them here.
 */
const L_ARRIVAL = 0;      // absolute minutes since midnight of the query date
const L_READY = 1;        // platform labels: earliest minute a train may be boarded
const L_FARE = 2;         // rupees, including any open segment
const L_TRANSFERS = 3;    // train changes so far
const L_NIGHT = 4;        // closed segments alighting 00:00-05:00
const L_EARLY = 5;        // closed segments boarding before 06:00
const L_CLOSED_FARE = 6;  // rupees for segments already closed; the open one is on top
const L_PREV = 7;         // predecessor PLATFORM label, -1 at an origin
const L_FP = 8;           // index into this query's footpath list, -1 if none
const L_STATION = 9;      // station this platform label sits at
const L_BOARDED = 10;     // 1 once any train has been boarded
const L_FIRSTDEP = 11;    // absolute departure of the first train boarded, -1 before that
const L_TRAIN = 12;       // onboard labels: the train being ridden
const L_SVC_SLOT = 13;    // onboard labels: service-day slot, so days never mix
const L_SEG_FROM = 14;
const L_SEG_DEP = 15;
const L_SEG_END = 16;
const L_SEG_KM = 17;
const L_SEG_HOPS = 18;
const L_SEG_FIRST_ROW = 19;
const L_SEG_LAST_ROW = 20;
const L_SEG_CLASS = 21;
const L_SEG_FARE = 22;
const L_STRIDE = 23;

/**
 * Fastest plausible scheduled average speed, km/h.
 *
 * Used only to turn straight-line distance into a LOWER bound on remaining travel time, so it
 * must be an over-estimate: the fastest average in the dataset is well under this, and the
 * bound therefore never rejects a journey that could actually happen. Getting this number too
 * low would silently delete real itineraries — the one failure mode a pruning heuristic must
 * not have. Getting it too high only costs scan time.
 */
const MAX_PLAUSIBLE_KMH = 110;

/** How many per-row bound arrays to keep per timetable, each ~540 KB on the real dataset. */
const ROW_BOUNDS_CACHE_MAX = 4;

export const FRONTIER_CAP = 12;
const DEFAULT_POOL = 65_536;
const MAX_POOL = DEFAULT_POOL * 4;

/** Alighting between 00:00 and 05:00. Actionable: nobody wants to be dropped at 3 am. */
export function isNightArrival(absMin: number): boolean {
  const wall = ((absMin % 1440) + 1440) % 1440;
  return wall < 300;
}

/**
 * Boarding before 06:00.
 *
 * Kept separate from night arrival on purpose: an overnight train boarded at 23:00 and woken
 * up on is *desirable*, because it saves a hotel night. A 04:30 departure is not. Conflating
 * them penalises exactly the journeys long-distance travellers prefer.
 */
export function isEarlyDeparture(absMin: number): boolean {
  const wall = ((absMin % 1440) + 1440) % 1440;
  return wall < 360;
}

export interface QueryOptions {
  /** Minutes since midnight of the timetable's date. */
  departureMin: number;
  origins: readonly number[];
  destinations: readonly number[];
  /** Maximum number of train CHANGES. 0 = direct only. */
  maxTransfers: number;
  /** Class to prefer and price in, or null for the cheapest each train offers. */
  preferredClass?: string | null;
  /**
   * Reject journeys whose time IN TRANSIT exceeds this many minutes, measured from boarding
   * the first train to arriving at the destination. Default 48 h.
   *
   * Deliberately not a horizon measured from the query time: that would also bound the wait
   * at home, so a short ride leaving three hours from now would be discarded for "taking too
   * long". Waiting is bounded separately by `maxWaitMin`.
   */
  maxJourneyMin?: number;
  /**
   * How long the traveller will wait at the origin before the first departure, in minutes.
   * Default 8 h; anything longer is better answered by searching the next day.
   *
   * This gives the scan a sound stopping point. `maxJourneyMin` alone cannot bound absolute
   * arrival, because a journey's first departure is not known until it is found.
   */
  maxWaitMin?: number;
  /** Reject journeys costing more than this. null = no cap. */
  maxFareRupees?: number | null;
  /** Ignore road transfers between city terminals entirely. */
  noFootpaths?: boolean;
}

export interface SearchResult {
  /** Destination labels, Pareto-filtered across all destination stations, earliest first. */
  labels: number[];
  /** The label pool. Read through the accessors below, never by raw offset. */
  pool: Int32Array;
  /** Footpaths referenced by label L_FP fields. */
  footpaths: Footpath[];
  /** Class each train was priced in, so the itinerary can say what it assumed. */
  pricing: PerTrain;
  scanned: number;
  labelsCreated: number;
  ms: number;
  /** True if the pool filled and the search stopped early — results are then incomplete. */
  truncated: boolean;
}

const at = (p: Int32Array, l: number, f: number): number => p[l * L_STRIDE + f];

export const labelArrival = (p: Int32Array, l: number): number => at(p, l, L_ARRIVAL);
export const labelReady = (p: Int32Array, l: number): number => at(p, l, L_READY);
export const labelFare = (p: Int32Array, l: number): number => at(p, l, L_FARE);
export const labelTransfers = (p: Int32Array, l: number): number => at(p, l, L_TRANSFERS);
export const labelNight = (p: Int32Array, l: number): number => at(p, l, L_NIGHT);
export const labelEarly = (p: Int32Array, l: number): number => at(p, l, L_EARLY);
export const labelPrev = (p: Int32Array, l: number): number => at(p, l, L_PREV);
export const labelFp = (p: Int32Array, l: number): number => at(p, l, L_FP);
export const labelStation = (p: Int32Array, l: number): number => at(p, l, L_STATION);
export const labelBoarded = (p: Int32Array, l: number): number => at(p, l, L_BOARDED);
export const labelFirstDep = (p: Int32Array, l: number): number => at(p, l, L_FIRSTDEP);
export const labelSegFrom = (p: Int32Array, l: number): number => at(p, l, L_SEG_FROM);
export const labelSegDep = (p: Int32Array, l: number): number => at(p, l, L_SEG_DEP);
export const labelSegEnd = (p: Int32Array, l: number): number => at(p, l, L_SEG_END);
export const labelSegKm = (p: Int32Array, l: number): number => at(p, l, L_SEG_KM);
export const labelSegHops = (p: Int32Array, l: number): number => at(p, l, L_SEG_HOPS);
export const labelSegFirstRow = (p: Int32Array, l: number): number => at(p, l, L_SEG_FIRST_ROW);
export const labelSegLastRow = (p: Int32Array, l: number): number => at(p, l, L_SEG_LAST_ROW);
export const labelSegClass = (p: Int32Array, l: number): number => at(p, l, L_SEG_CLASS);
/**
 * The timetable row this label last rode, or -1 for an origin or road label.
 *
 * Needed because the row — not the packed connection — carries the service day and platform:
 * one connection appears at up to six rows, one per departure date in the expansion window.
 */
export const labelRow = (p: Int32Array, l: number): number => at(p, l, L_SEG_LAST_ROW);
export const labelSegFare = (p: Int32Array, l: number): number => at(p, l, L_SEG_FARE);

/** Int32s per label. Exported only so a caller reading the raw pool can stride it. */
export const LABEL_STRIDE = L_STRIDE;

/**
 * Composite fatigue in hours-equivalent.
 *
 * Derived rather than stored: travel time and transfer count are already criteria, so a
 * third copy could drift. What this adds beyond them is the early-morning penalty, which is
 * the part travellers actually feel.
 */
export function labelFatigue(p: Int32Array, l: number, departureMin: number): number {
  const firstDep = labelFirstDep(p, l);
  const from = firstDep >= 0 ? firstDep : departureMin;
  const hours = (labelArrival(p, l) - from) / 60;
  return Math.round((hours + 1.5 * labelTransfers(p, l) + 0.5 * labelEarly(p, l)) * 10) / 10;
}

export const CLASS_ORDER = ['1A', '2A', '3A', '3E', 'CC', 'EC', 'FC', 'SL', '2S', 'UR'] as const;

export interface PerTrain {
  /** class multiplier x type multiplier. */
  readonly scale: Float64Array;
  /** reservation charge + superfast surcharge, rupees. */
  readonly fixed: Int32Array;
  /** index into CLASS_ORDER that this train is priced in. */
  readonly classId: Uint8Array;
  /** 1 when the preferred class was unavailable and we fell back to a cheaper one. */
  readonly fellBack: Uint8Array;
  readonly superfast: Uint8Array;
}

const SUPERFAST_TYPES = new Set(['RAJ', 'SHT', 'VNDB', 'DRNT', 'HMS']);
const RESERVATION_BY_CLASS: Readonly<Record<string, number>> = {
  UR: 0, '2S': 40, SL: 40, FC: 40, '3E': 45, CC: 45, '3A': 45, '2A': 45, EC: 60, '1A': 60,
};
const SUPERFAST_BY_CLASS: Readonly<Record<string, number>> = {
  UR: 0, '2S': 45, SL: 45, FC: 45, '3E': 45, CC: 45, '3A': 45, '2A': 45, EC: 75, '1A': 75,
};

/**
 * Precompute everything about fares that does not depend on distance.
 *
 * Done once per query shape rather than per label, removing two string-keyed lookups and a
 * branch from the innermost loop. Cached on the engine, because a user tweaking max-transfers
 * or the destination should not pay to re-derive 5,174 trains' class choices each time.
 */
export function buildPerTrainPricing(graph: Graph, preferredClass: string | null): PerTrain {
  const n = graph.trainCount;
  const scale = new Float64Array(n);
  const fixed = new Int32Array(n);
  const classId = new Uint8Array(n);
  const fellBack = new Uint8Array(n);
  const superfast = new Uint8Array(n);
  const slId = CLASS_ORDER.indexOf('SL');

  for (let t = 0; t < n; t++) {
    const tr = graph.train(t);
    const offered = tr.classes.length > 0 ? tr.classes : ['SL'];

    let chosen: string | null = null;
    if (preferredClass !== null && offered.includes(preferredClass)) chosen = preferredClass;
    if (chosen === null) chosen = cheapestClass(offered) ?? 'SL';
    if (preferredClass !== null && chosen !== preferredClass) fellBack[t] = 1;

    const cid = CLASS_ORDER.indexOf(chosen as (typeof CLASS_ORDER)[number]);
    classId[t] = cid >= 0 ? cid : slId;

    // The superfast surcharge is a rule about measured average speed (>= 55 km/h), not about
    // the train's name. Premium types are included unconditionally: they are fast by
    // construction and their published fares carry the surcharge.
    const kmh = tr.distanceKm / Math.max(1, tr.durationMin / 60);
    const sf = kmh >= 55 || SUPERFAST_TYPES.has(tr.type);
    superfast[t] = sf ? 1 : 0;

    scale[t] = classMultiplier(chosen) * typeMultiplier(tr.type);
    fixed[t] = (RESERVATION_BY_CLASS[chosen] ?? 40) + (sf ? (SUPERFAST_BY_CLASS[chosen] ?? 45) : 0);
  }
  return { scale, fixed, classId, fellBack, superfast };
}

/**
 * All-in fare for one uninterrupted segment on one train, from precomputed factors.
 *
 * Must be called per SEGMENT, never per hop: IRCTC prices by total distance on a tapered
 * slab, so summing ten 100 km hops gives ₹1,050 where one 1,000 km ticket costs ₹485.
 */
function segFare(km: number, scale: number, fixed: number): number {
  const base = Math.round(slBase(km) * scale);
  const sub = base + fixed;
  return sub + Math.round(sub * 0.05);
}

/**
 * Pareto domination over the Phase 1 criteria: arrival, transfers, fare, night arrivals and
 * early departures.
 *
 * A label must be no worse on every criterion AND strictly better on at least one. The
 * second half is not pedantry: without it two identical journeys would each dominate the
 * other, and `paretoFilter` would discard both.
 *
 * An exact tie is broken on READY, the earliest minute a train could actually be boarded.
 * Two labels that arrive in the same minute are not equivalent if one needs a longer platform
 * walk, so keeping the boardable one is keeping the strictly better one.
 *
 * Night and early counts are safe to compare here, including mid-scan, because this relation
 * is only ever applied to PLATFORM labels, where every segment is already closed and the
 * counts are final. Onboard labels — which do carry an open, uncharged segment — use
 * `dominatesOnboard`, which deliberately omits these two.
 */
export function dominates(p: Int32Array, a: number, b: number): boolean {
  const ab = a * L_STRIDE;
  const bb = b * L_STRIDE;
  const aArr = p[ab + L_ARRIVAL];
  const bArr = p[bb + L_ARRIVAL];
  const aTr = p[ab + L_TRANSFERS];
  const bTr = p[bb + L_TRANSFERS];
  const aFare = p[ab + L_FARE];
  const bFare = p[bb + L_FARE];
  const aNight = p[ab + L_NIGHT];
  const bNight = p[bb + L_NIGHT];
  const aEarly = p[ab + L_EARLY];
  const bEarly = p[bb + L_EARLY];

  if (aArr > bArr || aTr > bTr || aFare > bFare || aNight > bNight || aEarly > bEarly) return false;
  if (aArr < bArr || aTr < bTr || aFare < bFare || aNight < bNight || aEarly < bEarly) return true;
  return p[ab + L_READY] < p[bb + L_READY];
}

/** Alias, for call sites that want to be explicit that the journeys are complete. */
export const dominatesJourney = dominates;

/**
 * Domination between ONBOARD labels.
 *
 * These are all riding the same train, so they arrive at every remaining stop at the same
 * minute and arrival cannot distinguish them. What varies is transfers and fare — and a
 * label that boarded later is strictly better on both, being closer to the destination for
 * less money, which is exactly the domination that keeps onboard frontiers small.
 *
 * Night and early are omitted on purpose, not by oversight: an onboard label's own segment is
 * still open, so its early-departure flag has not been charged yet. Comparing incomplete
 * counts could prune a label whose segment turns out to be the cheaper one once closed. They
 * are banked exactly when the segment closes, in the alighting step.
 */
function dominatesOnboard(p: Int32Array, a: number, b: number): boolean {
  const ab = a * L_STRIDE;
  const bb = b * L_STRIDE;
  const aTr = p[ab + L_TRANSFERS];
  const bTr = p[bb + L_TRANSFERS];
  const aFare = p[ab + L_FARE];
  const bFare = p[bb + L_FARE];
  if (aTr > bTr || aFare > bFare) return false;
  if (aTr < bTr || aFare < bFare) return true;
  // Exact tie: keep whichever boarded earlier, so the label with the longer ride already
  // banked survives and the duplicate is dropped deterministically.
  return p[ab + L_SEG_DEP] < p[bb + L_SEG_DEP];
}

/** Keep only the non-dominated complete journeys from a candidate set. */
export function paretoFilter(p: Int32Array, candidates: readonly number[]): number[] {
  const out: number[] = [];
  for (const c of candidates) {
    let dominated = false;
    for (const o of out) {
      if (dominates(p, o, c)) { dominated = true; break; }
    }
    if (dominated) continue;
    for (let i = out.length - 1; i >= 0; i--) {
      if (dominates(p, c, out[i])) out.splice(i, 1);
    }
    out.push(c);
  }
  return out;
}

export class CsaEngine {
  private pool: Int32Array;
  private poolUsed = 0;
  private readonly platform: Int32Array;
  private readonly platformLen: Uint8Array;
  private readonly onboard: Int32Array;
  private readonly onboardLen: Uint8Array;
  private footpaths: Footpath[] = [];
  private truncated = false;
  /** Whether road transfers are being offered this query; read by alight(). */
  private useFootpaths = true;
  private readonly pricingCache = new Map<string, PerTrain>();
  private readonly destCache = new Map<string, Float32Array>();
  /** Row bounds keyed by timetable, then by destination set. Weak so timetables can be freed. */
  private readonly boundsCache = new WeakMap<Timetable, Map<string, Float32Array>>();

  constructor(
    private readonly graph: Graph,
    private readonly transfers: TransferModel,
    stationCount: number,
    poolSize = DEFAULT_POOL,
  ) {
    this.pool = new Int32Array(poolSize * L_STRIDE);
    this.platform = new Int32Array(stationCount * FRONTIER_CAP);
    this.platformLen = new Uint8Array(stationCount);
    this.onboard = new Int32Array(graph.trainCount * SERVICE_DAY_SLOTS * FRONTIER_CAP);
    this.onboardLen = new Uint8Array(graph.trainCount * SERVICE_DAY_SLOTS);
  }

  get stationCount(): number {
    return this.platformLen.length;
  }

  pricing(preferredClass: string | null): PerTrain {
    const key = preferredClass ?? '';
    const hit = this.pricingCache.get(key);
    if (hit) return hit;
    const built = buildPerTrainPricing(this.graph, preferredClass);
    this.pricingCache.set(key, built);
    return built;
  }

  search(tt: Timetable, opts: QueryOptions): SearchResult {
    const t0 = typeof performance === 'undefined' ? 0 : performance.now();
    const kmOf = this.graph.connKm;
    const pricing = this.pricing(opts.preferredClass ?? null);

    const maxJourney = opts.maxJourneyMin ?? 2880;
    const maxWait = opts.maxWaitMin ?? 480;
    const horizon = opts.departureMin + maxWait + maxJourney;
    const maxFare = opts.maxFareRupees ?? null;
    const maxT = opts.maxTransfers;
    const useFootpaths = opts.noFootpaths !== true;
    this.useFootpaths = useFootpaths;
    const mt = this.transfers;
    const minTransfer = mt.minTransferTable;
    const p = this.pool;

    this.poolUsed = 0;
    this.truncated = false;
    this.footpaths = [];
    this.platformLen.fill(0);
    this.onboardLen.fill(0);

    // ---- origins ----
    for (const o of opts.origins) {
      if (o < 0 || o >= this.stationCount) continue;
      const l = this.newLabel();
      if (l < 0) { this.truncated = true; break; }
      const b = l * L_STRIDE;
      p[b + L_ARRIVAL] = opts.departureMin;
      p[b + L_READY] = opts.departureMin;
      p[b + L_PREV] = -1;
      p[b + L_FP] = -1;
      p[b + L_STATION] = o;
      p[b + L_BOARDED] = 0;
      p[b + L_FIRSTDEP] = -1;
      p[b + L_TRAIN] = -1;
      p[b + L_SEG_HOPS] = 0;
      p[b + L_SEG_LAST_ROW] = -1;
      p[b + L_SEG_FIRST_ROW] = -1;
      this.insertPlatform(o, l);
      // A traveller at New Delhi can taxi to Nizamuddin and board there. Without this the
      // terminal groups would only ever help on the arrival side.
      if (useFootpaths) this.relaxFootpaths(o, l, opts.departureMin);
    }

    // Hoisted once rather than property-loaded per row: the scan is one long loop over these.
    const depTs = tt.depTs;
    const arrTs = tt.arrTs;
    const connIx = tt.connIx;
    const trainIx = tt.trainIx;
    const fromIx = tt.fromIx;
    const toIx = tt.toIx;
    const svcSlotIx = tt.svcSlot;
    const count = tt.count;
    const rowLb = this.rowBounds(tt, this.lowerBounds(opts.destinations), opts.destinations);

    let scanned = 0;
    for (let c = lowerBound(depTs, opts.departureMin); c < count; c++) {
      const dep = depTs[c];
      if (dep > horizon) break; // sorted, so nothing later can be boarded in time
      scanned++;

      // Geometric gate, before anything else is read: a row arriving somewhere too far from the
      // destination to cover the remaining distance in the remaining time cannot be part of any
      // answer, whatever else is true of it. One sequential read, and it keeps the loop off the
      // graph's 2 MB connection block for most rows.
      const lb = rowLb[c];
      if (dep + lb > horizon) continue;

      const from = fromIx[c];
      const to = toIx[c];
      // Cheap test before any expensive work: if nobody is standing on that platform and
      // nobody is aboard that train, this connection cannot extend a single journey.
      const t = trainIx[c];
      const pfLen = this.platformLen[from];
      // One train index covers up to six physical departures in an expanded timetable, so the
      // onboard frontier is keyed by train AND service day. Without the day in the key, a
      // passenger could ride from yesterday's 23:00 departure straight into today's — two
      // different trains that happen to share an index.
      const obKey = t * SERVICE_DAY_SLOTS + svcSlotIx[c];
      const obLen = this.onboardLen[obKey];
      if (pfLen === 0 && obLen === 0) continue;

      const conn = connIx[c];
      const km = kmOf[conn];
      const arr = arrTs[c];
      if (arr + lb > horizon) continue;
      const ob = obKey * FRONTIER_CAP;
      const minT = minTransfer[to];
      const scale = pricing.scale[t];
      const fixed = pricing.fixed[t];

      // ---- RIDE: extend every label already on this train, and let them alight at `to` ----
      //
      // This runs BEFORE boarding, and the order is load-bearing. A label that boards at
      // `from` on this very connection accounts for the connection itself while boarding, so
      // if the ride step then swept it too, its first hop would be counted twice — a 300 km
      // three-hop ride would report 400 km and be priced accordingly. Riding first means the
      // ride step only ever sees labels that were genuinely aboard when the train reached
      // `from`.
      for (let i = 0; i < obLen; i++) {
        const M = this.onboard[ob + i];
        const mb = M * L_STRIDE;

        // Extend the open segment in place. Onboard labels are only ever compared with each
        // other, and every one of them gains the same km on the same hop, so their relative
        // order cannot change while riding — mutating is safe, and avoids one allocation per
        // label per stop on a 109-leg train.
        const segKm = p[mb + L_SEG_KM] + km;
        const segF = segFare(segKm, scale, fixed);
        p[mb + L_SEG_KM] = segKm;
        p[mb + L_SEG_FARE] = segF;
        p[mb + L_FARE] = p[mb + L_CLOSED_FARE] + segF;
        p[mb + L_SEG_END] = arr;
        p[mb + L_SEG_HOPS] = p[mb + L_SEG_HOPS] + 1;
        p[mb + L_SEG_LAST_ROW] = c;
        p[mb + L_ARRIVAL] = arr;

        // Over budget: the label can never produce a legal journey, so do not spend a platform
        // label on it. It stays in the onboard frontier, which wastes a slot but keeps the
        // scan simple; the cap bounds the cost.
        if (maxFare !== null && p[mb + L_FARE] > maxFare) continue;
        if (arr + lb - p[mb + L_FIRSTDEP] > maxJourney) continue;

        if (!this.alight(mb, to, arr, minT)) { this.truncated = true; break; }
      }

      // ---- BOARD: get on this train at `from`, opening a new segment ----
      const pfBase = from * FRONTIER_CAP;
      for (let i = 0; i < pfLen; i++) {
        const P = this.platform[pfBase + i];
        const pb = P * L_STRIDE;
        // Minimum transfer time, enforced here rather than as a post-filter: a connection
        // that cannot physically be made must never appear in the results at all.
        if (p[pb + L_READY] > dep) continue;
        const boarded = p[pb + L_BOARDED];
        const transfers = boarded === 0 ? 0 : p[pb + L_TRANSFERS] + 1;
        if (transfers > maxT) continue;
        // Bound the wait at home separately from journey length; see QueryOptions.
        if (boarded === 0 && dep - opts.departureMin > maxWait) continue;

        const firstDep = boarded === 0 ? dep : p[pb + L_FIRSTDEP];
        // Time in transit so far, plus the least time the rest can possibly take.
        if (arr + lb - firstDep > maxJourney) continue;

        const segF = segFare(km, scale, fixed);
        const fare = p[pb + L_CLOSED_FARE] + segF;
        if (maxFare !== null && fare > maxFare) continue;

        // Rejected candidates are the majority, and allocating a 23-word label for each one
        // only to throw it away was the search's largest cost. Test domination on scalars
        // first; only a survivor pays for the allocation.
        if (this.onboardRejects(p, ob, this.onboardLen[obKey], transfers, fare, dep)) continue;

        const nl = this.newLabel();
        if (nl < 0) { this.truncated = true; break; }
        const nb = nl * L_STRIDE;
        p[nb + L_ARRIVAL] = arr;
        p[nb + L_FARE] = fare;
        p[nb + L_CLOSED_FARE] = p[pb + L_CLOSED_FARE];
        p[nb + L_TRANSFERS] = transfers;
        p[nb + L_NIGHT] = p[pb + L_NIGHT];
        p[nb + L_EARLY] = p[pb + L_EARLY];
        p[nb + L_PREV] = P;
        p[nb + L_FP] = -1;
        p[nb + L_STATION] = to;
        p[nb + L_BOARDED] = 1;
        p[nb + L_FIRSTDEP] = firstDep;
        p[nb + L_TRAIN] = t;
        p[nb + L_SVC_SLOT] = obKey;
        p[nb + L_SEG_FROM] = from;
        p[nb + L_SEG_DEP] = dep;
        p[nb + L_SEG_END] = arr;
        p[nb + L_SEG_KM] = km;
        p[nb + L_SEG_HOPS] = 1;
        p[nb + L_SEG_FIRST_ROW] = c;
        p[nb + L_SEG_LAST_ROW] = c;
        p[nb + L_SEG_CLASS] = pricing.classId[t];
        p[nb + L_SEG_FARE] = segF;

        if (!this.insertOnboard(ob, nl)) { this.poolUsed--; continue; }
        // The boarder has already travelled this hop, so it alights immediately.
        if (!this.alight(nb, to, arr, minT)) { this.truncated = true; break; }
      }
      if (this.truncated) break;
    }

    // ---- collect and filter ----
    // Arrival at Anand Vihar and arrival at New Delhi are comparable answers to "get me to
    // Delhi", so all destination frontiers are merged before filtering. Without this the same
    // journey would be reported once per terminal it happens to reach.
    const candidates: number[] = [];
    for (const d of opts.destinations) {
      if (d < 0 || d >= this.stationCount) continue;
      const base = d * FRONTIER_CAP;
      const len = this.platformLen[d];
      for (let i = 0; i < len; i++) candidates.push(this.platform[base + i]);
    }
    const labels = paretoFilter(p, candidates);
    labels.sort((a, b) => (p[a * L_STRIDE + L_ARRIVAL] - p[b * L_STRIDE + L_ARRIVAL])
      || (p[a * L_STRIDE + L_TRANSFERS] - p[b * L_STRIDE + L_TRANSFERS]));

    return {
      labels,
      pool: p,
      footpaths: this.footpaths,
      pricing,
      scanned,
      labelsCreated: this.poolUsed,
      ms: typeof performance === 'undefined' ? 0 : performance.now() - t0,
      truncated: this.truncated,
    };
  }

  /**
   * The least time the rest of the trip can possibly take, per station, for one destination set.
   *
   * Computed from straight-line distance and an over-estimate of the fastest plausible average
   * speed, so it is a true lower bound: no train can beat it, therefore no journey that
   * violates it can exist.
   *
   * This is the prune that actually works on this network. A topological "can this station
   * reach the destination" walk was tried first and removed: 7,204 of 7,219 stations sit in one
   * connected component, so for any major city pair the answer is "yes" almost everywhere and
   * it discarded nothing — while costing an 11 ms pass over all 98,055 connections before a
   * single journey was found. Geometry is the opposite: a label standing in Kolkata twenty
   * hours into a trip to Mumbai still has 1,600 km of straight line ahead of it, and no train
   * covers that in the time left, so it is dropped on the spot. Measured effect on a
   * Delhi-to-Mumbai search: 30.9 ms to 9.1 ms, with the same twelve results.
   *
   * A station with no coordinates gets 0, meaning "no bound". Under-permissive would silently
   * delete real itineraries; over-permissive only costs scan time.
   */
  private lowerBounds(destinations: readonly number[]): Float32Array {
    const key = destinations.slice().sort((a, b) => a - b).join(',');
    const hit = this.destCache.get(key);
    if (hit) return hit;

    const n = this.stationCount;
    const lbMin = new Float32Array(n);
    const g = this.graph;

    const destCoords: Array<[number, number]> = [];
    for (const d of destinations) {
      if (d < 0 || d >= n) continue;
      const lat = g.latOf(d);
      const lon = g.lonOf(d);
      if (Number.isFinite(lat) && Number.isFinite(lon)) destCoords.push([lat, lon]);
    }
    // All-or-nothing: if one destination has no coordinates then "closest destination" is
    // unknown, and bounding against only the measured ones would over-prune.
    if (destCoords.length === destinations.length && destinations.length > 0) {
      for (let s2 = 0; s2 < n; s2++) {
        const lat = g.latOf(s2);
        const lon = g.lonOf(s2);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        let best = Infinity;
        for (let i = 0; i < destCoords.length; i++) {
          const km = haversineKm(lat, lon, destCoords[i][0], destCoords[i][1]);
          if (km < best) best = km;
        }
        lbMin[s2] = (best / MAX_PLAUSIBLE_KMH) * 60;
      }
    }

    this.destCache.set(key, lbMin);
    return lbMin;
  }

  /**
   * The destination bound, indexed by timetable ROW instead of by station.
   *
   * Hoisted out of the scan so the hot loop reads one sequential Float32Array in step with
   * `depTs`, instead of reading `toIx[c]` and then reaching sideways into a per-station table.
   * At ~95,000 rows per query that difference is the whole per-row budget.
   *
   * There is a matching ORIGIN-side bound — a row cannot be boarded before the traveller could
   * physically reach its departure station — and it was implemented and then removed, because
   * it measured slower. The platform-frontier test already encodes exactly that fact, and
   * encodes it precisely rather than as a straight-line approximation: a station has labels or
   * it does not. Adding a second, weaker, redundant gate only bought another megabyte of
   * memory traffic per row. What is kept here is the half the scan genuinely cannot derive for
   * itself, because the scan has no idea where the journey is going.
   *
   * Cached per (timetable, destination set) with a hard cap on entries: a profile sweep reuses
   * one build across a hundred departure times, but an unbounded cache would retain half a
   * megabyte per distinct destination ever queried.
   */
  private rowBounds(tt: Timetable, lbDest: Float32Array, destinations: readonly number[]): Float32Array {
    const key = destinations.slice().sort((a, b) => a - b).join(',');
    let byKey = this.boundsCache.get(tt);
    if (byKey === undefined) { byKey = new Map(); this.boundsCache.set(tt, byKey); }
    const hit = byKey.get(key);
    if (hit) return hit;

    const rowLb = new Float32Array(tt.count);
    const toIx = tt.toIx;
    for (let i = 0; i < tt.count; i++) rowLb[i] = lbDest[toIx[i]];

    if (byKey.size >= ROW_BOUNDS_CACHE_MAX) {
      // Evict the oldest. Map preserves insertion order, so the first key is the least
      // recently added — good enough, and cheaper than a real LRU for a four-entry cache.
      const oldest = byKey.keys().next().value as string | undefined;
      if (oldest !== undefined) byKey.delete(oldest);
    }
    byKey.set(key, rowLb);
    return rowLb;
  }

  /**
   * Would this candidate be rejected by the platform frontier at `base`?
   *
   * Mirrors `dominates` exactly — same criteria, same order, same strict tie-break on ready —
   * so the pre-check and the authoritative insertion can never disagree about an outcome.
   * Keeping them in step is what makes this a fast path rather than a second policy.
   *
   * It exists because rejected candidates are the large majority: allocating a 23-word label
   * for each one, writing every field, and only then discovering it loses was one of the two
   * largest costs in the search.
   */
  private platformRejects(
    p: Int32Array, base: number, len: number,
    arr: number, ready: number, fare: number, transfers: number, night: number, early: number,
  ): boolean {
    for (let i = 0; i < len; i++) {
      const o = this.platform[base + i] * L_STRIDE;
      if (p[o + L_ARRIVAL] > arr || p[o + L_TRANSFERS] > transfers || p[o + L_FARE] > fare
        || p[o + L_NIGHT] > night || p[o + L_EARLY] > early) continue;
      if (p[o + L_ARRIVAL] < arr || p[o + L_TRANSFERS] < transfers || p[o + L_FARE] < fare
        || p[o + L_NIGHT] < night || p[o + L_EARLY] < early) return true;
      if (p[o + L_READY] < ready) return true;
    }
    return false;
  }

  /** Would this candidate be rejected by the onboard frontier? Mirrors `dominatesOnboard`. */
  private onboardRejects(
    p: Int32Array, base: number, len: number, transfers: number, fare: number, dep: number,
  ): boolean {
    for (let i = 0; i < len; i++) {
      const o = this.onboard[base + i] * L_STRIDE;
      if (p[o + L_TRANSFERS] > transfers || p[o + L_FARE] > fare) continue;
      if (p[o + L_TRANSFERS] < transfers || p[o + L_FARE] < fare) return true;
      if (p[o + L_SEG_DEP] < dep) return true;
    }
    return false;
  }

  /** Allocate a label slot, growing once and then reporting truncation. */
  private newLabel(): number {
    if (this.poolUsed * L_STRIDE >= this.pool.length) {
      // Grow rather than silently truncating — but only up to 4x. An unbounded pool would let
      // a pathological query exhaust the worker's memory and take the browser tab with it.
      if (this.pool.length >= MAX_POOL * L_STRIDE) return -1;
      const next = new Int32Array(this.pool.length * 2);
      next.set(this.pool);
      this.pool = next;
    }
    const id = this.poolUsed++;
    this.pool.fill(0, id * L_STRIDE, (id + 1) * L_STRIDE);
    this.pool[id * L_STRIDE + L_PREV] = -1;
    this.pool[id * L_STRIDE + L_FP] = -1;
    return id;
  }

  private insertPlatform(station: number, label: number): boolean {
    return this.insert(this.platform, this.platformLen, station * FRONTIER_CAP,
      station, label, dominates);
  }

  private insertOnboard(base: number, label: number): boolean {
    const slot = base / FRONTIER_CAP;
    return this.insert(this.onboard, this.onboardLen, base, slot, label, dominatesOnboard);
  }

  /**
   * Close the open segment of an onboard label and offer it as a platform label at `to`.
   *
   * This is where the night and early-departure penalties are banked, because they describe a
   * whole ride from boarding to alighting rather than each individual hop — counting them per
   * hop would charge a traveller once per stop for a single overnight arrival.
   *
   * `mb` is the onboard label's base offset, not its id, because both call sites already have
   * it in hand. Returns false if the pool filled.
   */
  private alight(mb: number, to: number, arr: number, minTransfer: number): boolean {
    const p = this.pool;

    const night = p[mb + L_NIGHT] + (isNightArrival(arr) ? 1 : 0);
    const early = p[mb + L_EARLY] + (isEarlyDeparture(p[mb + L_SEG_DEP]) ? 1 : 0);
    const fare = p[mb + L_FARE];
    const transfers = p[mb + L_TRANSFERS];
    // A platform transfer is needed to reach the next train from here. This is the single
    // most important line for not inventing impossible connections: without it, arriving at
    // 10:00 and departing 10:02 from a 286-leg junction looks achievable.
    const ready = arr + minTransfer;

    const base = to * FRONTIER_CAP;
    const len = this.platformLen[to];
    // See the same note in the boarding step: most alightings are already beaten by something
    // standing on that platform, and allocating a label to discover it is the expensive way
    // to find out.
    if (this.platformRejects(p, base, len, arr, ready, fare, transfers, night, early)) return true;

    const nl = this.newLabel();
    if (nl < 0) return false;
    const nb = nl * L_STRIDE;

    p[nb + L_ARRIVAL] = arr;
    p[nb + L_READY] = ready;
    p[nb + L_FARE] = fare;
    p[nb + L_CLOSED_FARE] = fare;
    p[nb + L_TRANSFERS] = transfers;
    p[nb + L_NIGHT] = night;
    p[nb + L_EARLY] = early;
    // The predecessor is the platform label this ride was boarded from, not the onboard label:
    // the chain is platform labels only, each carrying its whole closed segment. That is what
    // makes reconstruction a straight walk with no hop-merging step.
    p[nb + L_PREV] = p[mb + L_PREV];
    p[nb + L_FP] = -1;
    p[nb + L_STATION] = to;
    p[nb + L_BOARDED] = 1;
    p[nb + L_FIRSTDEP] = p[mb + L_FIRSTDEP];
    p[nb + L_TRAIN] = -1;
    p[nb + L_SEG_FROM] = p[mb + L_SEG_FROM];
    p[nb + L_SEG_DEP] = p[mb + L_SEG_DEP];
    p[nb + L_SEG_END] = arr;
    p[nb + L_SEG_KM] = p[mb + L_SEG_KM];
    p[nb + L_SEG_HOPS] = p[mb + L_SEG_HOPS];
    p[nb + L_SEG_FIRST_ROW] = p[mb + L_SEG_FIRST_ROW];
    p[nb + L_SEG_LAST_ROW] = p[mb + L_SEG_LAST_ROW];
    p[nb + L_SEG_CLASS] = p[mb + L_SEG_CLASS];
    p[nb + L_SEG_FARE] = p[mb + L_SEG_FARE];

    if (!this.insertPlatform(to, nl)) { this.poolUsed--; return true; }
    if (this.useFootpaths) this.relaxFootpaths(to, nl, arr);
    return true;
  }

  /**
   * Add a label to a capped frontier unless something there dominates it, evicting anything
   * it dominates. Returns false when the label was rejected.
   */
  private insert(
    buf: Int32Array,
    lens: Uint8Array,
    base: number,
    slot: number,
    label: number,
    dom: (p: Int32Array, a: number, b: number) => boolean,
  ): boolean {
    const p = this.pool;
    const len = lens[slot];

    for (let i = 0; i < len; i++) {
      if (dom(p, buf[base + i], label)) return false;
    }
    let w = 0;
    for (let i = 0; i < len; i++) {
      const other = buf[base + i];
      if (!dom(p, label, other)) buf[base + w++] = other;
    }
    let newLen = w;

    if (newLen >= FRONTIER_CAP) {
      // Evict the least-dominated label. Evicting the slowest would be simpler and wrong: it
      // systematically discards the cheap-and-scenic option, which for someone on holiday
      // rather than in a hurry is a legitimate answer.
      let worst = 0;
      let worstScore = -1;
      for (let i = 0; i < newLen; i++) {
        let dominatedBy = 0;
        for (let j = 0; j < newLen; j++) {
          if (i !== j && dom(p, buf[base + j], buf[base + i])) dominatedBy++;
        }
        const score = dominatedBy * 1_000_000 + p[buf[base + i] * L_STRIDE + L_ARRIVAL];
        if (score > worstScore) { worstScore = score; worst = i; }
      }
      buf[base + worst] = buf[base + newLen - 1];
      newLen--;
    }

    buf[base + newLen] = label;
    lens[slot] = newLen + 1;
    return true;
  }

  /**
   * Offer road transfers out of a station.
   *
   * A footpath label carries hops = 0 and fp = the ride, so reconstruction emits the road leg
   * and falls through to the predecessor. The road overhead already covers entering the
   * destination station, so READY equals arrival here — adding a platform transfer on top
   * would charge for the same walk twice.
   */
  private relaxFootpaths(station: number, sourceLabel: number, arrival: number): void {
    const paths = this.transfers.footpathsFrom(station);
    if (paths.length === 0) return;
    const sb = sourceLabel * L_STRIDE;
    const p = this.pool;

    for (const fp of paths) {
      const nl = this.newLabel();
      if (nl < 0) { this.truncated = true; return; }
      const b = nl * L_STRIDE;
      const fpIdx = this.footpaths.length;
      this.footpaths.push(fp);

      const arr = arrival + fp.minutes;
      p[b + L_ARRIVAL] = arr;
      p[b + L_READY] = arr;
      p[b + L_FARE] = p[sb + L_FARE] + fp.costRupees;
      p[b + L_CLOSED_FARE] = p[b + L_FARE];
      p[b + L_TRANSFERS] = p[sb + L_TRANSFERS];
      p[b + L_NIGHT] = p[sb + L_NIGHT];
      p[b + L_EARLY] = p[sb + L_EARLY];
      p[b + L_PREV] = sourceLabel;
      p[b + L_FP] = fpIdx;
      p[b + L_STATION] = fp.to;
      p[b + L_BOARDED] = p[sb + L_BOARDED];
      p[b + L_FIRSTDEP] = p[sb + L_FIRSTDEP];
      p[b + L_TRAIN] = -1;
      p[b + L_SEG_HOPS] = 0;
      p[b + L_SEG_LAST_ROW] = -1;
      p[b + L_SEG_FIRST_ROW] = -1;

      if (!this.insertPlatform(fp.to, nl)) {
        this.poolUsed--;
        this.footpaths.pop();
      }
    }
  }
}

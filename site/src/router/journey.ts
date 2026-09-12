/**
 * journey.ts — turn a winning label chain into an itinerary a person can read.
 *
 * ---------------------------------------------------------------------------
 * WHY SEGMENTS, NOT HOPS
 * ---------------------------------------------------------------------------
 * A hop is one non-stop run between two stations. A segment is one uninterrupted ride on one
 * train, which may span many hops. Reporting hops would show "Mumbai Central → Andheri →
 * Borivali → Surat → Vadodara" for a single through ride, and would price it five times over.
 * The label chain from csa.ts already carries one closed segment per platform label, so this
 * module reads fields rather than merging anything — the merging happened during the scan.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS MODULE HAS NO STATION NAMES
 * ---------------------------------------------------------------------------
 * It runs in the Web Worker, which holds the graph but deliberately does not hold the
 * StationIndex: that is a main-thread structure built from stations.bin, and passing it in
 * would mean either duplicating ~1 MB of strings into the worker or serialising it per query.
 * So segments carry station INDICES, and `renderItinerary` takes a resolver. The worker stays
 * able to answer "what can I do from here" without ever knowing what anywhere is called.
 *
 * ---------------------------------------------------------------------------
 * WHY FARE IS RECOMPUTED HERE RATHER THAN READ OFF THE LABEL
 * ---------------------------------------------------------------------------
 * The scan accumulates a single total because that is all a Pareto comparison needs. The UI
 * needs the total AND its breakdown into base, reservation, surcharge and GST per segment,
 * and a breakdown cannot be recovered from a sum. Both paths call the same `fareParts`, so
 * they cannot drift — and a test asserts the parts still sum to the label's total, because an
 * itinerary whose legs add up to ₹1,200 under a header saying ₹1,450 destroys trust in every
 * part of the screen that happens to be right.
 */

import type { Graph } from '../lib/graph';
import type { Timetable } from './timetable';
import type { SearchResult } from './csa';
import {
  CLASS_ORDER, isEarlyDeparture, isNightArrival, labelArrival, labelFare, labelFp, labelPrev,
  labelRow, labelStation, labelSegClass, labelSegDep, labelSegFrom, labelSegHops, labelSegKm,
  labelTransfers,
} from './csa';
import { fareParts } from './fares';

export interface RailSegment {
  kind: 'rail';
  /** Station index, not a name — see the module note on the worker. */
  from: number;
  to: number;
  /** Absolute minutes since midnight of the query date. */
  depMin: number;
  arrMin: number;
  durationMin: number;
  /** Non-stop hops spanned. Always >= 1, and > 1 whenever the train stopped en route. */
  hops: number;
  distKm: number;
  fareRupees: number;
  /** Fare breakdown, so the UI can show what an estimate is made of. */
  baseFare: number;
  reservation: number;
  surcharge: number;
  gst: number;
  trainIx: number;
  trainNumber: string;
  trainName: string;
  trainType: string;
  /** Class the fare was actually priced in. */
  klass: string;
  /** True when the traveller asked for a class this train does not offer. */
  classFellBack: boolean;
  /**
   * Always true in Phase 1. No availability feed is wired yet, so every fare is a
   * published-tariff estimate and must be labelled as one rather than shown as a price.
   */
  fareEstimate: boolean;
  /** True when this train's fare genuinely moves with occupancy (Rajdhani and friends). */
  flexiFare: boolean;
  /**
   * Running-days bitmask, bit 0 = Monday. Carried so remedy ② can say which nearby dates this
   * train actually runs on without a round trip to the worker's graph.
   */
  runsDays: number;
  /** Provenance, so the UI can flag a schedule that was assumed rather than sourced. */
  runsDaysAssumed: boolean;
  classesInferred: boolean;
  /**
   * Every class this train runs, not just the one this leg was priced in.
   *
   * Carried so Tier 0 can reason about the leg without a round trip to the worker's graph: the
   * class list is what constrains a rake estimate, and it is what makes "you cannot book Tatkal
   * in 1A on this train" answerable on the spot. Empty means the bootstrap data had no class
   * list, which Tier 0 treats as unknown rather than as "runs nothing".
   */
  trainClasses: readonly string[];
  /** Negative day offset from the query date: -1 means the train left yesterday evening. */
  serviceDayOffset: number;
  nightArrival: boolean;
}

export interface RoadSegment {
  kind: 'road';
  from: number;
  to: number;
  depMin: number;
  arrMin: number;
  minutes: number;
  km: number;
  costRupees: number;
  /** City whose terminals this bridges, for "change at Delhi — 45 min by road". */
  city: string;
  /** True when the time came from an authored city estimate rather than measured geometry. */
  estimated: boolean;
  nightArrival: boolean;
}

export type Segment = RailSegment | RoadSegment;

export interface Journey {
  segments: Segment[];
  /** Station indices. */
  origin: number;
  destination: number;
  depMin: number;
  arrMin: number;
  durationMin: number;
  /** Train CHANGES only. A road hop between city terminals is not a change of train. */
  transfers: number;
  /** Road hops, counted separately because they are not train changes. */
  roadTransfers: number;
  totalKm: number;
  fareRupees: number;
  nightArrivals: number;
  earlyDepartures: number;
  /** True when any segment was priced in a class other than the one asked for. */
  classFallback: boolean;
  /** Composite hours-equivalent cost of the journey; see csa.ts. */
  fatigue: number;
  /** Worst availability confidence across segments, 0..1. Always 0 until Phase 2. */
  worstConfidence: number;
  /** True when the search filled its label pool and stopped early: results may be incomplete. */
  truncated: boolean;
}

export interface ReconstructOptions {
  /**
   * The query's departure minute. Carried so the caller's options object can be passed
   * straight through and so fatigue-style measures anchored on "when did the traveller leave
   * home" have the reference point, even though the segment chain itself supplies depMin.
   */
  departureMin: number;
}

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));

/** Render an absolute minute count as a wall-clock time, wrapping past midnight. */
export function wallClock(absMin: number): string {
  const m = ((absMin % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
}

/** Calendar day offset from the query date, for "arrives 06:10 next day". */
export const dayOf = (absMin: number): number => Math.floor(absMin / 1440);

/**
 * Rebuild one journey from its winning label, walking backwards and reversing once.
 *
 * Returns null for a label that yields no segments, which happens if the destination is also
 * an origin (a zero-length journey) or if the chain is somehow malformed. Callers filter
 * those out rather than rendering an empty card.
 */
export function reconstructJourney(
  result: SearchResult,
  tt: Timetable,
  graph: Graph,
  label: number,
  opts: ReconstructOptions,
): Journey | null {
  if (label === undefined || label < 0) return null;
  void opts;
  const p = result.pool;
  const pricing = result.pricing;
  const fpList = result.footpaths;

  // The chain runs destination -> origin, so segments come out backwards. Built in reverse
  // and flipped once, rather than unshifted per segment, which is O(n^2).
  const segments: Segment[] = [];
  let cur = label;
  let guard = 0;
  const limit = tt.count + fpList.length + 2;

  while (cur >= 0 && guard++ < limit) {
    const fpIx = labelFp(p, cur);
    const hops = labelSegHops(p, cur);
    const arrival = labelArrival(p, cur);

    if (fpIx >= 0 && fpIx < fpList.length) {
      const ride = fpList[fpIx];
      const prev = labelPrev(p, cur);
      const depMin = arrival - ride.minutes;
      segments.push({
        kind: 'road',
        // The road leg's start is wherever the predecessor label was standing.
        from: prev >= 0 ? labelStation(p, prev) : ride.from,
        to: labelStation(p, cur),
        depMin,
        arrMin: arrival,
        minutes: ride.minutes,
        km: ride.km,
        costRupees: ride.costRupees,
        city: ride.city,
        estimated: ride.estimated,
        nightArrival: isNightArrival(arrival),
      });
    } else if (hops > 0) {
      const lastRow = labelRow(p, cur);
      const trainIx = tt.trainIx[lastRow];
      const tr = graph.train(trainIx);
      const depMin = labelSegDep(p, cur);
      const distKm = labelSegKm(p, cur);
      const classCode = CLASS_ORDER[labelSegClass(p, cur)] ?? 'SL';
      const fellBack = pricing.fellBack[trainIx] === 1;
      // Same single fare path the scan used, so the breakdown sums to the total the Pareto
      // comparison used. `superfast` is read from the precomputed per-train table rather than
      // re-derived here, so the two cannot disagree about whether a train is superfast.
      const fare = fareParts(distKm, classCode, tr.type, pricing.superfast[trainIx] === 1);

      segments.push({
        kind: 'rail',
        from: labelSegFrom(p, cur),
        to: labelStation(p, cur),
        depMin,
        arrMin: arrival,
        durationMin: arrival - depMin,
        hops,
        distKm,
        fareRupees: fare.total,
        baseFare: fare.base,
        reservation: fare.reservation,
        surcharge: fare.superfast,
        gst: fare.gst,
        trainIx,
        trainNumber: tr.number,
        trainName: tr.name,
        trainType: tr.type,
        trainClasses: tr.classes,
        runsDays: tr.runsDays,
        klass: fare.klass,
        classFellBack: fellBack,
        fareEstimate: true,
        flexiFare: isFlexiType(tr.type),
        runsDaysAssumed: tr.runsDaysAssumed,
        classesInferred: tr.classesInferred,
        serviceDayOffset: lastRow >= 0 && lastRow < tt.count ? tt.serviceDay[lastRow] : 0,
        nightArrival: isNightArrival(arrival),
      });
    }

    cur = labelPrev(p, cur);
  }

  if (segments.length === 0) return null;
  segments.reverse();

  const first = segments[0];
  const last = segments[segments.length - 1];
  const depMin = first.depMin;
  const arrMin = labelArrival(p, label);
  const rail = segments.filter((s): s is RailSegment => s.kind === 'rail');

  // Road distance is fractional (it comes from a great-circle bearing times a circuity
  // factor) while rail distance is whole km from the dataset. Rounding the road part is what
  // makes the displayed total equal the sum of the displayed parts.
  const totalKm = segments.reduce(
    (a, s) => a + (s.kind === 'rail' ? s.distKm : Math.round(s.km)), 0);

  return {
    segments,
    origin: first.from,
    destination: last.to,
    depMin,
    arrMin,
    durationMin: arrMin - depMin,
    transfers: labelTransfers(p, label),
    roadTransfers: segments.length - rail.length,
    totalKm,
    // Taken from the label, not summed from the segments: the label is what the search
    // optimised, so the headline number is guaranteed to be the number that was compared.
    // The test asserting the parts sum to this is the check that the two agree.
    fareRupees: labelFare(p, label),
    nightArrivals: rail.filter((s) => s.nightArrival).length,
    earlyDepartures: rail.filter((s) => isEarlyDeparture(s.depMin)).length,
    classFallback: rail.some((s) => s.classFellBack),
    fatigue: Math.round(((arrMin - depMin) / 60
      + 1.5 * labelTransfers(p, label)
      + 0.5 * rail.filter((s) => isEarlyDeparture(s.depMin)).length) * 10) / 10,
    // Zero until Phase 2 wires an availability feed. Surfaced rather than omitted so the UI
    // cannot imply a confidence that was never measured.
    worstConfidence: 0,
    truncated: result.truncated,
  };
}

/** Types whose fare genuinely moves with occupancy, so the estimate is a starting point. */
const FLEXI_TYPES = new Set(['RAJ', 'SHT', 'VNDB', 'DRNT', 'HMS']);
const isFlexiType = (t: string): boolean => FLEXI_TYPES.has(t);

/**
 * Every station the traveller passes through, in order, with repeats collapsed.
 *
 * This is what the map draws and what the share text names. Collapsing matters because a road
 * transfer arrives at one terminal and departs another, and both are real stops.
 */
export function stationPath(j: Journey): number[] {
  const out: number[] = [];
  for (const s of j.segments) {
    if (out.length === 0 || out[out.length - 1] !== s.from) out.push(s.from);
    out.push(s.to);
  }
  return out;
}

/**
 * Rebuild every winning label into a journey, in the order the search returned them.
 *
 * Labels are already Pareto-filtered and sorted by arrival, so this only adds detail.
 */
export function reconstructAll(
  result: SearchResult,
  tt: Timetable,
  graph: Graph,
  opts: ReconstructOptions,
): Journey[] {
  const out: Journey[] = [];
  for (const l of result.labels) {
    const j = reconstructJourney(result, tt, graph, l, opts);
    if (j !== null) out.push(j);
  }
  return out;
}

/**
 * Resolve station indices to codes and names.
 *
 * Supplied by the caller because the worker has no StationIndex — see the module note.
 */
export type StationResolver = (ix: number) => { code: string; name: string };

const CLASS_NAMES: Readonly<Record<string, string>> = {
  UR: 'Unreserved / General', '2S': 'Second Sitting', SL: 'Sleeper', CC: 'AC Chair Car',
  EC: 'Executive Chair Car', FC: 'First Class', '3E': 'AC 3-Tier Economy', '3A': 'AC 3-Tier',
  '2A': 'AC 2-Tier', '1A': 'AC First Class',
};

/**
 * Class name, marked when it is not the class that was asked for.
 *
 * This is the honest half of the fallback behaviour. The search must not refuse to find a
 * journey because the traveller's preferred class is unavailable on it — for someone with
 * holidays and no destination, a sleeper berth on a train that runs is a better answer than
 * no answer. But it must never present that berth as though it were an AC 3-tier one.
 */
export function classLabel(code: string, fellBack: boolean): string {
  const base = CLASS_NAMES[code] ?? code;
  return fellBack ? `${base} (preferred class not offered)` : base;
}

/**
 * Name a road transfer by its length.
 *
 * The dataset carries no mode column — there is no metro or bus feed, and inventing one would
 * be a fabrication. Distance is the honest signal available: adjacent terminals are walkable
 * or an auto ride, cross-city ones need a cab.
 */
export function roadModeLabel(km: number): string {
  if (km < 1.5) return 'Walk or auto';
  if (km < 8) return 'Auto / taxi';
  return 'Taxi';
}

/**
 * Plain-text itinerary, used for both the clipboard and the WhatsApp share — which is how
 * Indian travellers actually pass plans to each other.
 *
 * One renderer for both so they cannot drift into saying different things about the same
 * journey.
 */
export function renderItinerary(j: Journey, nameOf: StationResolver): string {
  const origin = nameOf(j.origin);
  const dest = nameOf(j.destination);
  const lines: string[] = [];
  const hrs = Math.floor(j.durationMin / 60);
  const mins = j.durationMin % 60;

  lines.push(`${origin.name} (${origin.code}) → ${dest.name} (${dest.code})`);
  lines.push(`Depart ${wallClock(j.depMin)}, arrive ${wallClock(j.arrMin)}`
    + `${dayOf(j.arrMin) > dayOf(j.depMin) ? ` (+${dayOf(j.arrMin) - dayOf(j.depMin)}d)` : ''}`
    + ` — ${hrs}h ${mins}m, ${j.transfers} change${j.transfers === 1 ? '' : 's'}, ~₹${j.fareRupees}`);

  j.segments.forEach((s, i) => {
    const from = nameOf(s.from);
    const to = nameOf(s.to);
    lines.push('');
    if (s.kind === 'rail') {
      lines.push(`${i + 1}. ${s.trainNumber} ${s.trainName} [${s.trainType}]`);
      lines.push(`   ${from.name} (${from.code}) ${wallClock(s.depMin)}`
        + `${s.serviceDayOffset < 0 ? ` day ${s.serviceDayOffset}` : ''}`
        + ` → ${to.name} (${to.code}) ${wallClock(s.arrMin)}`);
      lines.push(`   ${classLabel(s.klass, s.classFellBack)} · ${s.distKm} km`
        + ` · ${s.hops} hop${s.hops === 1 ? '' : 's'} · ~₹${s.fareRupees}`
        + ` (base ${s.baseFare} + res ${s.reservation} + sf ${s.surcharge} + gst ${s.gst})`
        + (s.flexiFare ? ' · flexi-fare train' : ''));
      if (s.nightArrival) lines.push('   ⚠ arrives between midnight and 05:00');
    } else {
      lines.push(`${i + 1}. ${roadModeLabel(s.km)} across ${s.city}: `
        + `${from.code} → ${to.code}, ~${s.minutes} min, ~₹${s.costRupees}`
        + (s.estimated ? ' (estimated)' : ''));
    }
  });

  lines.push('');
  lines.push('Fares are published-tariff estimates, not bookable prices.');
  if (j.classFallback) lines.push('Some trains do not offer your preferred class; a cheaper one was priced instead.');
  if (j.truncated) lines.push('Note: this search hit its limit, so there may be options not shown.');
  return lines.join('\n');
}

/**
 * One-line summary for the golden corpus and for logging.
 *
 * Index-based rather than code-based so corpus files stay stable if station naming changes,
 * and so the corpus can be diffed without resolving names.
 */
export function summarise(j: Journey): string {
  const parts = j.segments.map((s) => (s.kind === 'rail'
    ? `${s.depMin}-${s.arrMin} ${s.trainNumber} ${s.from}>${s.to} ${s.klass} ${s.distKm}km Rs${s.fareRupees}`
    : `${s.depMin}-${s.arrMin} road ${s.from}>${s.to} Rs${s.costRupees}`));
  return `${j.origin}>${j.destination} dep ${j.depMin} arr ${j.arrMin} ${j.transfers}x `
    + `${j.totalKm}km Rs${j.fareRupees} | ${parts.join(' | ')}`;
}

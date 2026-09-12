/**
 * features.ts — turning an availability query into the numbers Tier 1 needs.
 *
 * The model consumes `ModelFeatures`; a traveller's query is a *(train, board, alight, date, class,
 * quota)* tuple keyed by station codes. This module is the bridge, and it is deliberately pure:
 * every input is passed in, nothing is fetched, and every refusal returns `null` rather than a
 * half-built feature vector.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS RUNS ON THE MAIN THREAD, NOT IN THE WORKER
 * ---------------------------------------------------------------------------
 * docs/01 §9 puts inference "inside the same worker as the router". It does not run there, and the
 * reason is structural rather than a preference: **the worker deliberately holds no StationIndex**
 * (see the notes in `lib/protocol.ts` and `state/remedyContext.ts`) so that strings never cross
 * that boundary, while `AvailabilityQuery` is keyed by station *codes* because it also has to cross
 * a network one. Features need both — codes to find the boarding stop, distances to measure the
 * segment — and only the main thread has both.
 *
 * The alternative would be shipping a code→index map into the worker, which is exactly the thing
 * that architecture avoided, to save a few hundred microseconds of arithmetic that the router
 * already dwarfs by orders of magnitude. Remedy exploration — the thing that needs bulk
 * predictions — already runs on the main thread for the same reason. Recorded as a deviation from
 * docs/01 §9 in docs/04.
 *
 * ---------------------------------------------------------------------------
 * REFUSALS
 * ---------------------------------------------------------------------------
 * `segmentFeatures()` returns `null` when it cannot build an honest vector: an unknown station
 * code, a boarding stop that is not on this train, an alighting stop before the boarding one, a
 * zero-length or negative segment, a journey date that has already passed, or a class Tier 0 has no
 * capacity figure for. Each of those is a missing *denominator*, and a feature vector with a
 * guessed denominator produces a probability that looks exactly like a measured one. Declining
 * lets the cascade fall through to "unknown", which is the only honest answer in those cases.
 */
import type { AvailabilityQuery } from './tier';
import type { FeatureExtractor, ModelFeatures } from './model';
import { ARP_DAYS, DAY_NAMES, addDays, daysBetween, istNow, weekdayBit } from './rules';
import { capacityFor, type TrainFacts } from './rake';
import { festivalOf, type FestivalEntry } from './festivals';

/**
 * One stop's geometry: enough to place a segment on the run and to work out which day it is
 * boarded on. This is a structural subset of the graph's `RawStop`, so a caller holding raw stops
 * can pass them straight through without a conversion step.
 */
export interface StopGeom {
  readonly station: number;
  readonly distKm: number;
  readonly arrMin: number | null;
  readonly depMin: number | null;
}

/**
 * The train facts Tier 1 needs. It extends Tier 0's `TrainFacts`, so one resolver object can feed
 * both tiers — which matters, because the two must never disagree about what a train is.
 */
export interface TrainGeometry extends TrainFacts {
  /** Origin first, destination last, in running order. */
  readonly stops: readonly StopGeom[];
  /**
   * True when the running-days bitmask was assumed (daily) rather than read from the data.
   *
   * Declared here rather than added to Tier 0's `TrainFacts`: Tier 0 never needs to know, and
   * widening a contract one consumer depends on, for a different consumer's benefit, is how two
   * tiers end up disagreeing about what a train is.
   */
  readonly runsDaysAssumed?: boolean | undefined;
}

export type GeometryResolver = (trainNumber: string) => TrainGeometry | null;

export interface FeatureOptions {
  /** Station code → graph index. Returns -1 for a code the index does not hold. */
  resolveStation(code: string): number;
  /** Today's IST date. Defaults to `istNow()`, overridable so tests are not date-dependent. */
  todayIso?: string;
  /** Festival table, overridable so tests do not depend on the published calendar. */
  festivals?: readonly FestivalEntry[];
}

/** Minutes in a day. Day offsets are whole days past the origin departure. */
const MIN_PER_DAY = 1440;

/**
 * Which calendar day of the run a stop falls on, zero-based.
 *
 * Mirrors `state/remedyContext.stopsFromRaw()` exactly. Two copies of this formula in one codebase
 * is a real risk — if one of them ever changes, a train boarded after midnight would be attributed
 * to the wrong weekday, and a wrong weekday is a plausible-looking wrong prediction. A test pins
 * both against the same cases.
 */
export function dayOffsetOf(stop: StopGeom): number {
  return Math.floor((stop.depMin ?? stop.arrMin ?? 0) / MIN_PER_DAY);
}

/** Daily, weekly or something in between, from the running-days bitmask. Null when unknown. */
export function serviceFrequencyOf(runsDays: number | undefined, assumed: boolean | undefined): 'daily' | 'weekly' | 'irregular' | null {
  if (runsDays === undefined || assumed === true) return null;
  // 0 means "no days", which is a hole in the data rather than a train that never runs.
  if (runsDays <= 0) return null;
  let bits = 0;
  for (let i = 0; i < 7; i++) if ((runsDays & (1 << i)) !== 0) bits++;
  if (bits === 7) return 'daily';
  if (bits <= 2) return 'weekly';
  return 'irregular';
}

/**
 * Build the feature vector for one query, or `null` if an honest one cannot be built.
 *
 * `q.dateIso` is the train's ORIGIN departure date, as `AvailabilityQuery` requires. The weekday
 * and festival features are computed from the **boarding** date, which for an overnight train is
 * the next day or the day after — using the origin date would put a Tuesday boarding on a Monday
 * and lose the Friday-evening peak that is one of the strongest calendar signals there is.
 */
export function segmentFeatures(
  q: AvailabilityQuery,
  train: TrainGeometry | null,
  opts: FeatureOptions,
): ModelFeatures | null {
  if (train === null) return null;
  if (train.stops.length < 2) return null;

  const today = opts.todayIso ?? istNow().dateIso;
  const daysToJourney = daysBetween(today, q.dateIso);
  // A date already gone cannot be booked, and the model's knot range starts at zero. Predicting
  // for the past would produce a number nobody can act on.
  if (!Number.isFinite(daysToJourney) || daysToJourney < 0) return null;
  // Beyond the advance window there is nothing to predict and nothing to buy: IRCTC does not sell
  // the ticket, and the fitted hinge basis would be extrapolated past its last knot into a slope
  // nobody measured. Refusing here is what makes the extrapolation unreachable rather than merely
  // unlikely.
  if (daysToJourney > ARP_DAYS) return null;

  const boardIdx = opts.resolveStation(q.board);
  const alightIdx = opts.resolveStation(q.alight);
  if (boardIdx < 0 || alightIdx < 0) return null;

  let boardAt = -1;
  let alightAt = -1;
  for (let i = 0; i < train.stops.length; i++) {
    if (train.stops[i].station === boardIdx) boardAt = i;
    if (train.stops[i].station === alightIdx) alightAt = i;
  }
  // A train that does not stop at the boarding station cannot carry this passenger. That is a
  // routing question, not a prediction one, so Tier 1 declines and says nothing.
  if (boardAt < 0 || alightAt < 0) return null;
  if (alightAt <= boardAt) return null;

  const segmentKm = train.stops[alightAt].distKm - train.stops[boardAt].distKm;
  const lastStop = train.stops[train.stops.length - 1];
  const totalKm = train.distanceKm && train.distanceKm > 0 ? train.distanceKm : lastStop.distKm;
  if (!Number.isFinite(segmentKm) || !Number.isFinite(totalKm) || totalKm <= 0 || segmentKm <= 0) return null;

  const capacity = capacityFor(train, q.klass);
  // No denominator, no prediction. Tier 0 declines to guess a rake for a class it has no figure
  // for, and Tier 1 must not quietly guess one either.
  if (capacity === null || capacity.nominal <= 0) return null;

  const boardingDate = addDays(q.dateIso, dayOffsetOf(train.stops[boardAt]));
  const segmentDistPct = Math.min(1, segmentKm / totalKm);

  return {
    daysToJourney,
    segmentDistPct,
    logCapacity: Math.log(capacity.nominal),
    // Full run means boarding at the origin and riding to the destination, which is where IRCTC's
    // preferential quota allotment bites and why the segment group is the strongest feature.
    isFullRun: boardAt === 0 && alightAt === train.stops.length - 1,
    klass: q.klass.toUpperCase(),
    quota: q.quota.toUpperCase(),
    trainType: train.type.toUpperCase(),
    dow: DAY_NAMES[weekdayBit(boardingDate)],
    festival: festivalOf(boardingDate, opts.festivals),
    serviceFrequency: serviceFrequencyOf(train.runsDays, train.runsDaysAssumed),
  };
}

/**
 * A `FeatureExtractor` bound to a resolver and a station index.
 *
 * Returns `null` for a train the resolver does not know, which makes Tier 1 decline that query and
 * lets the cascade fall through — the same behaviour as every other tier that cannot answer.
 */
export function featureExtractor(resolve: GeometryResolver, opts: FeatureOptions): FeatureExtractor {
  return (q: AvailabilityQuery) => segmentFeatures(q, resolve(q.trainNumber), opts);
}

/**
 * Adapt a `StationIndex` to the narrow shape this module needs.
 *
 * Kept as a one-liner factory rather than importing `StationIndex` as a type, so this module stays
 * testable with a plain map and never grows a dependency on the binary reader.
 */
export function stationResolver(indexOfCode: (code: string) => number): FeatureOptions['resolveStation'] {
  return (code: string) => indexOfCode(code);
}

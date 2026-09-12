/**
 * remedies.ts — the seven ways to turn "waitlisted, sorry" into a bookable journey.
 *
 * This is the differentiating half of the product. Every existing tool stops at reporting a
 * waitlist; none of them work out what to do about it. The seven remedies are specified in
 * docs/02 §"The 7 remedies" and each one changes a different axis of IRCTC's availability key —
 * *(train, board, alight, date, class, quota)* — plus two that change the journey itself.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS BUILD CAN AND CANNOT DO WITH THEM
 * ---------------------------------------------------------------------------
 * The honest split, which the UI is required to preserve:
 *
 *   Computable from the timetable alone, right now:
 *     ⑤ route substitution     — other trains and paths for the same pair, which the router
 *                                 already returns as a Pareto set
 *     ⑥ terminal substitution  — other stations in the same city group, which the transfer
 *                                 model already resolves into road edges
 *     ⑦ inter-modal bridge     — road hops between terminals, already priced and routed;
 *                                 bus and air need Phase 4 data
 *
 *   Needs a seat-availability source, so this build can only enumerate the questions:
 *     ① same-train split       — see split.ts; the candidates are structural, the ranking is not
 *     ② date shift             — exact dates, with running days checked
 *     ③ quota shift            — exact quotas, with eligibility stated
 *     ④ class shift            — exact classes the train actually offers
 *
 * For those four, the value delivered today is the *question list*: the precise tuples to check
 * on IRCTC, in a form that can be copied, with the ineligible and impossible ones already
 * filtered out. That is not nothing — working out that 1A has no Tatkal quota, or that a Tuesday
 * service does not run on the date you shifted to, is real work the traveller would otherwise do
 * by hand. It is also not an answer, and it is never presented as one.
 */

import type { RailSegment } from '../router/journey';
import type { AvailabilityQuery } from './tier';
import { addDays, hasTatkal, originDateOf, QUOTAS, quotaOf, runsOnDate, TATKAL_CLASSES } from './rules';
import { quotaOptions, staticallyImpossible } from './rake';
import type { TrainFacts } from './rake';
import { offerable, RANKING_UNAVAILABLE, SPLIT_FRAMING, splitCandidates, type SplitCandidate } from './split';

export type RemedyId = 'split' | 'date' | 'quota' | 'class' | 'route' | 'terminal' | 'intermodal';

export interface RemedyOption {
  /** Short label for the option itself, e.g. "+1 day" or "3A". */
  label: string;
  /** What changes relative to the original leg. */
  change: string;
  /** What it costs the traveller beyond money: a different date, an eligibility requirement. */
  cost: string | null;
  /**
   * Context that is neither the action nor its cost — for a quota, how large the pool being
   * joined actually is. Optional so existing options need not supply it.
   */
  note?: string | null;
  /** The exact availability question this option poses, when it poses one. */
  query: AvailabilityQuery | null;
  /** True when this option is impossible or pointless and is listed only to say so. */
  ruledOut: string | null;
}

export interface Remedy {
  id: RemedyId;
  title: string;
  /** Why this remedy is on the list at all, in plain language. */
  rationale: string;
  options: RemedyOption[];
  /** False when the router can act on this without any availability source. */
  needsAvailability: boolean;
  /** Blocking information that applies to the whole remedy, not one option. */
  note: string | null;
  /** Split candidates, for remedy ① only. */
  splits?: readonly SplitCandidate[];
  /**
   * Split candidates that were considered and rejected, with the reason on each.
   *
   * Kept rather than dropped because "you cannot change coaches there, the halt is four minutes"
   * is information a traveller can act on — it tells them the idea was examined and why it
   * failed, which is different from the idea never occurring to anyone.
   */
  splitsBlocked?: readonly SplitCandidate[];
}

/**
 * A leg plus the two things the segment deliberately does not carry.
 *
 * `RailSegment` stores station INDICES, because it is built inside the worker from typed arrays
 * where an index is four bytes and a code is a string allocation per label. Availability queries
 * cross a network boundary and need codes. And the segment knows its service-day offset but not
 * the calendar date the traveller searched for. Both belong to the caller, so they are passed in
 * rather than duplicated onto every segment in every itinerary.
 */
export interface LegRef {
  segment: RailSegment;
  boardCode: string;
  alightCode: string;
  /** ISO date of the traveller's query, not of the train's origin departure. */
  dateIso: string;
}

export interface RemedyContext {
  /** Today, for working out whether windows are open. ISO, no time. */
  todayIso: string;
  /** Classes this train actually offers, from the timetable. */
  offeredClasses: readonly string[];
  /** True when the dataset has no running-days column, so every train is assumed daily. */
  runsDaysAssumed: boolean;
  /** The train's running-days bitmask, bit 0 = Monday. */
  runsDays: number;
  /** Other stations in the same city group as the boarding station, with road times. */
  boardAlternatives: ReadonlyArray<{ code: string; name: string; minutesByRoad: number }>;
  /** Same for the alighting station. */
  alightAlternatives: ReadonlyArray<{ code: string; name: string; minutesByRoad: number }>;
  /** The train's stops, for split candidates. */
  stops: readonly import('../lib/graph').Stop[];
  /** How many other itineraries the router found for this pair, for remedy ⑤. */
  alternativeItineraries: number;
  /** Whether a road hop between terminals is already in this itinerary. */
  roadHopPresent: boolean;
}

/**
 * Whether a train runs on a date. Re-exported rather than reimplemented: the weekday convention
 * lives in rules.ts so that this module and the timetable cannot disagree about which bit is
 * Monday.
 */
export const runsOn = runsOnDate;

/** The date-shift offsets worth offering. Two days either side covers most festival pressure. */
const DATE_SHIFTS = [-2, -1, 1, 2, 3] as const;

/**
 * Classes to try when the requested one is waitlisted, in the order worth checking.
 *
 * Ordered by capacity and price rather than by likelihood, because likelihood is exactly what
 * cannot be known without availability data. Sleeper has the most berths; the AC tiers have
 * fewer berths but far less demand against them, and which way it falls on a given train on a
 * given day is not something anyone can infer from a timetable.
 */
const CLASS_CASCADE = ['SL', '3A', '3E', '2A', 'CC', '2S', '1A', 'FC', 'EC'] as const;

function baseQuery(
  seg: RailSegment, originDate: string, boardCode: string, alightCode: string,
): AvailabilityQuery {
  return {
    trainNumber: seg.trainNumber,
    board: boardCode,
    alight: alightCode,
    dateIso: originDate,
    klass: seg.klass,
    quota: 'GN',
  };
}

/**
 * Build every remedy that applies to one waitlisted or unavailable leg.
 *
 * Called with a leg whose availability is not definitely good. Returns all seven in the order
 * docs/02 lists them, including ones with no viable options — an empty remedy with an
 * explanation ("1A has no Tatkal quota") is more useful than a remedy that silently vanished,
 * because the traveller can see it was considered.
 */
export function remediesForLeg(leg: LegRef, ctx: RemedyContext): Remedy[] {
  const seg = leg.segment;
  const { boardCode, alightCode, dateIso } = leg;
  const originDate = originDateOf(dateIso, seg.serviceDayOffset);
  const base = baseQuery(seg, originDate, boardCode, alightCode);

  // Tier 0's view of this train, assembled from what the leg already carries — no extra round
  // trip to the worker's graph. The caller's `offeredClasses` wins because the rest of the
  // remedies already reason from it; the segment's own list is the fallback. An empty list means
  // the bootstrap data had none, which Tier 0 treats as unknown rather than as "runs nothing".
  const trainFacts: TrainFacts = {
    type: seg.trainType,
    classes: ctx.offeredClasses.length > 0 ? ctx.offeredClasses : seg.trainClasses,
    classesInferred: seg.classesInferred,
    distanceKm: seg.distKm,
  };
  /** Tier 0's published pool sizes for this class, keyed by quota code. */
  const pools = quotaOptions(seg.klass);

  // ① Same-train split -------------------------------------------------------
  const allSplits = splitCandidates({
    stops: ctx.stops, boardStation: seg.from, alightStation: seg.to,
  });
  const splits = offerable(allSplits);
  const splitsBlocked = allSplits.filter((c) => c.blocked !== null);
  const split: Remedy = {
    id: 'split',
    title: '① Two tickets on the same train',
    rationale: 'Quota is allotted per segment, and a short or intermediate segment often has its '
      + 'own allotment even when the full run is waitlisted. Splitting asks two questions about '
      + 'two pools instead of one question about a scarce one.',
    needsAvailability: true,
    note: SPLIT_FRAMING + (splits.length > 0 ? ` ${RANKING_UNAVAILABLE}` : ''),
    splits,
    splitsBlocked,
    options: splits.flatMap((c) => [
      {
        label: `${boardCode} → ${c.code}`,
        change: `First ticket to ${c.name} (${c.firstKm} km, ${Math.round(c.firstShare * 100)}% of the ride).`,
        cost: null,
        query: { ...base, alight: c.code },
        ruledOut: null,
      },
      {
        label: `${c.code} → ${alightCode}`,
        change: `Second ticket from ${c.name} (${c.secondKm} km). You change coaches here, with a ${c.haltMin}-minute halt.`,
        cost: `A second reservation charge of about ₹${c.extraReservationRupees}, plus the change of berth.`,
        query: { ...base, board: c.code },
        ruledOut: null,
      },
    ]),
  };

  // ② Date shift -------------------------------------------------------------
  const date: Remedy = {
    id: 'date',
    title: '② Travel a different day',
    rationale: 'The highest-value remedy: two days can turn a waitlist of 40 into seats, because '
      + 'demand is spiky around weekends and festivals rather than flat.',
    needsAvailability: true,
    note: ctx.runsDaysAssumed
      ? 'This timetable has no running-days data, so every train is assumed to run daily. A date '
        + 'shift onto a day this service does not actually run is possible and would only show up '
        + 'on IRCTC.'
      : null,
    options: DATE_SHIFTS.map((d) => {
      const shiftedBoarding = addDays(dateIso, d);
      const shiftedOrigin = originDateOf(shiftedBoarding, seg.serviceDayOffset);
      const runs = runsOnDate(ctx.runsDays, shiftedOrigin);
      const label = `${d > 0 ? '+' : ''}${d} day${Math.abs(d) === 1 ? '' : 's'}`;
      return {
        label,
        change: `Board on ${shiftedBoarding} instead of ${dateIso}.`,
        cost: d < 0 ? 'Travelling earlier than planned.' : 'Travelling later than planned.',
        // A ruled-out date poses no query, matching how the quota and class remedies behave.
        // Asking IRCTC about a day the train does not run wastes a call against a rate-limited
        // source and comes back as REGRET, which reads as "no seats" rather than "no train" —
        // two very different pieces of bad news. The option is still LISTED, with its reason, so
        // the traveller can see the date was considered.
        query: runs || ctx.runsDaysAssumed ? { ...base, dateIso: shiftedOrigin } : null,
        ruledOut: runs || ctx.runsDaysAssumed
          ? null
          : `This train does not run on ${shiftedOrigin} according to its running days.`,
      };
    }),
  };

  // ③ Quota shift ------------------------------------------------------------
  const quota: Remedy = {
    id: 'quota',
    title: '③ Book under a different quota',
    rationale: 'Each quota has its own pool of berths. The general pool can be exhausted while a '
      + 'quota you are eligible for still has room — and Tatkal opens a fresh one a day before '
      + 'departure.',
    needsAvailability: true,
    note: hasTatkal(seg.klass)
      ? null
      : `${seg.klass} has no Tatkal quota at all, so the two Tatkal options below are listed only `
        + 'to say so.',
    options: QUOTAS.filter((q) => q.code !== 'GN').map((q) => {
      // Tier 0 answers this one outright: a quota that cannot exist in this class poses no query.
      // That covers Tatkal in 1A, and also the berth-position quotas in a chair car, which the
      // Tatkal check alone let through on every Shatabdi and Vande Bharat.
      const ruledOut = staticallyImpossible({ ...base, quota: q.code }, trainFacts);
      // How big the pool is decides whether switching quota is worth trying at all: the Ladies
      // quota is six berths per Sleeper coach, so it is often free precisely because so few
      // people are eligible, while the general pool is where the competition is.
      const pool = pools.find((o) => o.code === q.code)?.pool ?? null;
      return {
        label: `${q.code} — ${q.name}`,
        change: `Ask for the ${q.name} quota instead of General.`,
        cost: q.eligibility,
        note: pool && !ruledOut ? `Pool: ${pool}.` : null,
        query: ruledOut ? null : { ...base, quota: q.code },
        ruledOut,
      };
    }),
  };

  // ④ Class shift ------------------------------------------------------------
  const offered = new Set(ctx.offeredClasses);
  const klass: Remedy = {
    id: 'class',
    title: '④ Travel in a different class',
    rationale: 'Demand and capacity move in opposite directions across classes. Sleeper has the '
      + 'most berths and the most competition; the AC tiers have fewer berths and much less '
      + 'pressure against them. Which way it falls on a given day cannot be inferred from a '
      + 'timetable.',
    needsAvailability: true,
    note: TATKAL_CLASSES.includes(seg.klass)
      ? null
      : `If you fall back to 1A, note it has no Tatkal quota, which removes remedy ③ from the list.`,
    options: CLASS_CASCADE
      .filter((c) => c !== seg.klass)
      .map((c) => {
        const isOffered = offered.has(c);
        return {
          label: c,
          change: isOffered
            ? `Book ${c} on the same train.`
            : `Book ${c} — but this train does not list ${c}, so it would have to be a different service.`,
          cost: isOffered ? 'A different fare; AC classes cost several times sleeper.' : null,
          query: isOffered ? { ...base, klass: c } : null,
          ruledOut: isOffered ? null : `${seg.trainNumber} does not offer ${c}.`,
        };
      }),
  };

  // ⑤ Route substitution -----------------------------------------------------
  const route: Remedy = {
    id: 'route',
    title: '⑤ Take a different route',
    rationale: 'Another train, or the same destination through a different junction, has its own '
      + 'quota entirely. This is the remedy that needs no availability data to be useful, because '
      + 'the alternatives are a fact about the timetable.',
    needsAvailability: false,
    note: ctx.alternativeItineraries > 0
      ? `The search already found ${ctx.alternativeItineraries} other `
        + `itinerar${ctx.alternativeItineraries === 1 ? 'y' : 'ies'} for this pair. They are listed `
        + 'alongside this one.'
      : 'The search found no other itinerary for this pair at the current settings. Widening the '
        + 'number of changes or the date is the next step.',
    options: [],
  };

  // ⑥ Terminal substitution --------------------------------------------------
  const terminal: Remedy = {
    id: 'terminal',
    title: '⑥ Use a different station in the same city',
    rationale: 'A city has several terminals with separate rakes and separate quota. Arriving '
      + 'Howrah and leaving Sealdah is a different pool of berths from arriving and leaving the '
      + 'same station, at the cost of a road transfer.',
    needsAvailability: false,
    note: null,
    options: [
      ...ctx.boardAlternatives.map((a) => ({
        label: `Board from ${a.code}`,
        change: `Start at ${a.name} instead, ${a.minutesByRoad} minutes away by road.`,
        cost: 'A road transfer, with its own time and fare.',
        query: null,
        ruledOut: null,
      })),
      ...ctx.alightAlternatives.map((a) => ({
        label: `Alight at ${a.code}`,
        change: `Finish at ${a.name} instead, ${a.minutesByRoad} minutes from your actual destination by road.`,
        cost: 'A road transfer at the far end.',
        query: null,
        ruledOut: null,
      })),
    ],
  };

  // ⑦ Inter-modal bridge -----------------------------------------------------
  const intermodal: Remedy = {
    id: 'intermodal',
    title: '⑦ Bridge the gap another way',
    rationale: 'Where rail is waitlisted end to end, a road or air segment can replace the leg '
      + 'that has no seats rather than the whole journey.',
    needsAvailability: false,
    note: ctx.roadHopPresent
      ? 'This itinerary already includes a road transfer between terminals.'
      : 'Road bridges between city terminals are routed and priced today. Bus and air bridges need '
        + 'the Phase 4 corridor data and are not offered yet.',
    options: [],
  };

  return [split, date, quota, klass, route, terminal, intermodal];
}

/** Every availability question these remedies raise, deduplicated, for the cascade. */
export function remedyQueries(remedies: readonly Remedy[]): AvailabilityQuery[] {
  const seen = new Set<string>();
  const out: AvailabilityQuery[] = [];
  for (const r of remedies) {
    for (const o of r.options) {
      if (!o.query || o.ruledOut) continue;
      const k = `${o.query.trainNumber}|${o.query.board}|${o.query.alight}|${o.query.dateIso}|${o.query.klass}|${o.query.quota}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(o.query);
    }
  }
  return out;
}

/** How many of the seven remedies this build can act on without an availability source. */
export function computableNow(remedies: readonly Remedy[]): Remedy[] {
  return remedies.filter((r) => !r.needsAvailability);
}

/**
 * The summary line the UI shows above the remedies.
 *
 * States the limitation up front rather than letting a reader discover it after acting on a
 * suggestion that could not have been evaluated.
 */
export function remediesSummary(remedies: readonly Remedy[]): string {
  const now = computableNow(remedies).length;
  const need = remedies.length - now;
  return `${now} of the ${remedies.length} remedies can be worked out from the timetable right now. `
    + `The other ${need} change what IRCTC would be asked, so this build lists the exact questions `
    + 'to ask instead of guessing at the answers.';
}

/** Re-exported so callers do not need to import two modules for one remedy. */
export { quotaOf };

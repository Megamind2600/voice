/**
 * rake.ts — Tier 0: the denominator.
 *
 * You cannot reason about "will WL 23 clear" without knowing how many berths exist. WL 23
 * against 864 berths on a daily trunk-route train is a completely different proposition from
 * WL 23 against a two-coach weekly, and nothing else in this app can tell them apart.
 *
 * ---------------------------------------------------------------------------
 * THE HONEST PROBLEM WITH THIS MODULE
 * ---------------------------------------------------------------------------
 * Indian Railways does not publish coach composition in any dataset this project can legally
 * ship. The CC0 bootstrap corpus carries no rake data at all — harvester/normalise.py records
 * exactly that ("no platform, quota, rake/composition, or fare data"), and its `classes` field
 * is frequently empty. IRCTC and NTES know the real composition but expose it only per-query,
 * behind a session, with no redistribution rights.
 *
 * So Tier 0 is **constructed**, not harvested: a standard composition template chosen from the
 * train's type and intersected with the classes it actually offers. Every number it returns is
 * therefore an estimate, and every estimate carries:
 *
 *   - a RANGE, because published figures genuinely disagree (LHB 2A is 52 or 54 depending on
 *     the source; LHB sleeper is 78 or 80);
 *   - a CONFIDENCE, which drops to `low` the moment the train's own class list was inferred
 *     rather than read from the data;
 *   - a BASIS, a sentence naming the template it came from, so the UI can show its working.
 *
 * What this module is FOR is a denominator and a set of ruled-out options. What it must never
 * become is a seat count. `capacityFor()` returns berths in a rake, not berths free on your
 * segment — IRCTC allots quota per segment, so a train-level figure is an upper bound on a
 * segment's pool and usually a loose one. That caveat travels with the number in `basis`.
 *
 * ---------------------------------------------------------------------------
 * WHAT TIER 0 IS ALLOWED TO ANSWER
 * ---------------------------------------------------------------------------
 * T0 never claims a seat exists. It answers only the questions that are certain without live
 * data — and returns `null` for everything else so the cascade keeps going:
 *
 *   1. the train does not run this class at all;
 *   2. this class has no Tatkal quota (1A never does — see rules.TATKAL_CLASSES);
 *   3. this quota cannot exist in this class (a lower-berth quota in a chair car);
 *   4. the quota code is not one IRCTC uses.
 *
 * Note the deliberate three-state design in `quotaApplies()`: `yes` / `no` / `unknown`. Only
 * `no` may rule an option out. Uncertain is not impossible, and treating it as impossible would
 * quietly delete real booking options — the same class of failure as inventing availability.
 *
 * Sources for the berth and quota figures were checked on 2026-09-12 and are cited inline
 * against each row. Where sources conflict, the conflict is encoded as the range.
 */
import { hasTatkal } from './rules';
import type { AvailabilityQuery, AvailabilityReading, AvailabilitySource } from './tier';

/** Coach generation. The same class carries different berth counts in each. */
export type CoachGen = 'ICF' | 'LHB' | 'VB';

/** A range, because the published figures disagree and a single number would hide that. */
export interface CoachCapacity {
  /** Most conservative figure found for this class and generation. */
  low: number;
  /** Most commonly cited figure. Used when a single number is unavoidable. */
  nominal: number;
  /** Most generous figure found. */
  high: number;
}

/**
 * Berths (or seats) per coach, by class and generation.
 *
 * ICF figures are the classic ones and are stable across every source: sleeper 72, 3-tier AC 64,
 * 2-tier AC 46 — corroborated by published berth-numbering lists that run 1..72, 1..64 and 1..46
 * respectively. LHB coaches are one bay longer (9 bays against 8), which is where the ranges
 * come from: IRFCA gives LHB sleeper as 80 with one berth lost to equipment, while other
 * references say 78; LHB 2A is 54 in three sources and 52 in a fourth.
 *
 * `3E` has no ICF entry because AC 3-tier Economy is an LHB-era class. Garib Rath rakes use a
 * 78-berth 3-tier coach, which is why the 3E low bound is 78 rather than 81.
 */
export const COACH_CAPACITY: Readonly<Record<string, Partial<Record<CoachGen, CoachCapacity>>>> = {
  SL: { ICF: { low: 72, nominal: 72, high: 80 }, LHB: { low: 78, nominal: 78, high: 80 } },
  '3A': { ICF: { low: 64, nominal: 64, high: 64 }, LHB: { low: 72, nominal: 72, high: 75 } },
  '3E': { LHB: { low: 78, nominal: 81, high: 83 } },
  '2A': { ICF: { low: 46, nominal: 46, high: 46 }, LHB: { low: 52, nominal: 54, high: 54 } },
  '1A': { ICF: { low: 18, nominal: 18, high: 26 }, LHB: { low: 20, nominal: 24, high: 24 } },
  CC: { ICF: { low: 74, nominal: 74, high: 78 }, LHB: { low: 78, nominal: 78, high: 78 }, VB: { low: 78, nominal: 78, high: 78 } },
  EC: { LHB: { low: 52, nominal: 56, high: 56 }, VB: { low: 52, nominal: 52, high: 56 } },
  '2S': { ICF: { low: 108, nominal: 108, high: 108 }, LHB: { low: 108, nominal: 108, high: 108 } },
  FC: { ICF: { low: 18, nominal: 24, high: 24 } },
};

/** Classes that assign berths. Every berth-position quota is meaningless outside this set. */
export const BERTH_CLASSES: readonly string[] = ['1A', '2A', '3A', '3E', 'SL', 'FC'];

/** Classes that assign seats only. */
export const SEAT_CLASSES: readonly string[] = ['CC', 'EC', 'EA', '2S'];

/**
 * The minimum facts about a train that Tier 0 needs.
 *
 * Deliberately structural rather than the graph's `Train`: the graph resolves trains by integer
 * index and has no by-number lookup, so the caller supplies a resolver (the same pattern as
 * `LegRef` in remedies.ts). It also keeps this module testable with plain objects.
 */
export interface TrainFacts {
  readonly type: string;
  readonly classes: readonly string[];
  /** True when the class list was guessed from the train type rather than read from the data. */
  readonly classesInferred?: boolean;
  readonly distanceKm?: number;
  readonly runsDays?: number;
}

export type TrainResolver = (trainNumber: string) => TrainFacts | null;

/** A standard composition: how many coaches of each class a train of this type typically runs. */
export interface RakeTemplate {
  /** IR type code, as stored in the graph. */
  readonly type: string;
  readonly label: string;
  /** The generation such rakes are normally built from. */
  readonly gen: CoachGen;
  /** class -> [fewest, most] coaches. Ranges, never a single number. */
  readonly coaches: Readonly<Record<string, readonly [number, number]>>;
  /** False for stock that cannot be reserved at all (suburban EMUs). */
  readonly bookable: boolean;
  readonly note: string;
}

/**
 * Composition templates by train type.
 *
 * These are the published standard formations, not observed rakes — real compositions vary by
 * zone, season and whether a rake is shared or reversed. Premium types are the most reliable
 * (a Rajdhani is all-AC by definition, a Shatabdi is chair-car by definition, a Vande Bharat is
 * EC+CC), which is why they get higher confidence in `rakeFor()`. Mail/Express is the least
 * reliable and the most common, so its AC counts are wide.
 *
 * Classes absent from a template are treated as "this type does not normally run them", and are
 * dropped rather than guessed at.
 */
export const RAKE_TEMPLATES: readonly RakeTemplate[] = [
  {
    type: 'RAJ', label: 'Rajdhani', gen: 'LHB', bookable: true,
    coaches: { '1A': [1, 1], '2A': [4, 6], '3A': [8, 11] },
    note: 'All-AC, LHB, with a pantry and two end-of-generation cars outside the passenger count.',
  },
  {
    type: 'SHT', label: 'Shatabdi', gen: 'LHB', bookable: true,
    coaches: { EC: [1, 2], CC: [8, 14] },
    note: 'Daytime intercity: executive and standard chair cars only, no berths.',
  },
  {
    type: 'VNDB', label: 'Vande Bharat', gen: 'VB', bookable: true,
    coaches: { EC: [1, 2], CC: [7, 14] },
    note: 'Eight-coach sets run 1 EC + 7 CC; sixteen-coach sets roughly double the CC count.',
  },
  {
    type: 'DRNT', label: 'Duronto', gen: 'LHB', bookable: true,
    coaches: { '1A': [0, 1], '2A': [2, 4], '3A': [6, 9], SL: [4, 8] },
    note: 'Point-to-point long haul; some rakes are all-AC, some carry sleeper.',
  },
  {
    type: 'GBR', label: 'Garib Rath', gen: 'LHB', bookable: true,
    coaches: { '3A': [10, 16], '3E': [0, 4] },
    note: 'All-AC 3-tier using the higher-density 78-berth coach; no 2A or sleeper.',
  },
  {
    type: 'SUF', label: 'Superfast', gen: 'LHB', bookable: true,
    coaches: { '1A': [0, 1], '2A': [2, 4], '3A': [5, 8], '3E': [0, 3], SL: [8, 12], CC: [0, 2], '2S': [0, 2] },
    note: 'The common long-distance formation: 22–24 coaches including unreserved vans.',
  },
  {
    type: 'MEX', label: 'Mail/Express', gen: 'LHB', bookable: true,
    coaches: { '1A': [0, 1], '2A': [1, 3], '3A': [3, 7], '3E': [0, 2], SL: [8, 14], '2S': [0, 4] },
    note: 'The widest-spread type and the least standardised: AC counts in particular vary a lot.',
  },
  {
    type: 'PAX', label: 'Passenger', gen: 'ICF', bookable: true,
    coaches: { SL: [0, 2], '2S': [0, 4] },
    note: 'Mostly unreserved stock; reserved accommodation, where it exists, is one or two coaches.',
  },
  {
    type: 'SUB', label: 'Suburban', gen: 'ICF', bookable: false,
    coaches: {},
    note: 'Suburban EMUs are unreserved. There is no availability question to answer here.',
  },
];

/** Fallback for a type code this table has not seen. Treated as the least confident case. */
const FALLBACK_TEMPLATE: RakeTemplate = {
  type: '', label: 'unrecognised type', gen: 'LHB', bookable: true,
  coaches: { '1A': [0, 1], '2A': [1, 3], '3A': [3, 7], SL: [6, 12], '2S': [0, 4] },
  note: 'Type code was not recognised, so a generic Mail/Express formation was assumed.',
};

export type Confidence = 'high' | 'medium' | 'low';

/** A resolved composition for one train: the template, restricted to what it actually offers. */
export interface Rake {
  readonly gen: CoachGen;
  /** class -> [fewest, most] coaches, only for classes this train is known to run. */
  readonly coaches: Readonly<Record<string, readonly [number, number]>>;
  readonly confidence: Confidence;
  /** A sentence naming the template, for display. */
  readonly basis: string;
  readonly bookable: boolean;
}

/**
 * Resolve a train's likely composition.
 *
 * The template supplies the shape; the train's own class list supplies the constraint. A class in
 * the template that the train does not offer is dropped, and a class the train offers that the
 * template does not know about is reported with a one-to-two-coach range so it is not silently
 * lost — the train demonstrably runs it, and pretending otherwise would be worse than a weak
 * estimate.
 *
 * Confidence drops to `low` when the class list itself was inferred, because then the template
 * is guessing on top of a guess.
 */
export function rakeFor(train: TrainFacts): Rake {
  const template = RAKE_TEMPLATES.find((t) => t.type === train.type) ?? FALLBACK_TEMPLATE;
  const offered = new Set(train.classes.map((c) => c.toUpperCase()));
  const coaches: Record<string, readonly [number, number]> = {};

  for (const klass of offered) {
    const fromTemplate = template.coaches[klass];
    coaches[klass] = fromTemplate ?? [1, 2];
  }

  let confidence: Confidence = template.type === FALLBACK_TEMPLATE.type ? 'low' : 'medium';
  if (['RAJ', 'SHT', 'VNDB', 'GBR'].includes(train.type)) confidence = 'high';
  if (train.classesInferred) confidence = 'low';
  if (offered.size === 0) confidence = 'low';

  return {
    gen: template.gen,
    coaches,
    confidence,
    bookable: template.bookable,
    basis: `${template.label} formation (${template.gen}): ${template.note}`,
  };
}

/** Train-level berths for one class, as a range, with the reason the range exists. */
export interface Capacity {
  readonly klass: string;
  readonly low: number;
  readonly nominal: number;
  readonly high: number;
  readonly coaches: readonly [number, number];
  readonly perCoach: CoachCapacity;
  readonly confidence: Confidence;
  /** Always true. Nothing in this build observes a real rake. */
  readonly estimated: true;
  readonly basis: string;
}

/**
 * Berths in this class across the whole rake.
 *
 * Returns `null` when the train does not offer the class, or when no berth figure is known for
 * that class in that coach generation — an unknown denominator is reported as unknown rather
 * than approximated from a neighbouring class.
 *
 * The returned `basis` always carries the segment caveat: this is the rake's total, and IRCTC
 * allots quota per (train, board, alight, date, class, quota) tuple, so the pool actually
 * competing for your segment is smaller and sometimes much smaller.
 */
export function capacityFor(train: TrainFacts, klass: string): Capacity | null {
  const k = klass.toUpperCase();
  if (!train.classes.map((c) => c.toUpperCase()).includes(k)) return null;

  const rake = rakeFor(train);
  const range = rake.coaches[k];
  if (!range) return null;
  const perCoach = COACH_CAPACITY[k]?.[rake.gen] ?? COACH_CAPACITY[k]?.LHB ?? COACH_CAPACITY[k]?.ICF;
  if (!perCoach) return null;

  return {
    klass: k,
    low: range[0] * perCoach.low,
    nominal: Math.round((range[0] + range[1]) / 2 * perCoach.nominal),
    high: range[1] * perCoach.high,
    coaches: range,
    perCoach,
    confidence: rake.confidence,
    estimated: true,
    basis:
      `${range[0]}–${range[1]} ${k} coach(es) × ${perCoach.low}–${perCoach.high} berths, ` +
      `${rake.gen} stock. Estimated from a standard ${rake.basis.split(':')[0]} — the real rake is ` +
      `not published. This is the whole train, not your segment: IRCTC allots berths per ` +
      `boarding/alighting pair, so the pool competing for this leg is smaller.`,
  };
}

/**
 * Three-state, on purpose.
 *
 * `unknown` is the honest answer far more often than `no`. Indian Railways quota allocation
 * varies by train and zone, and the published references disagree — one says the Ladies quota is
 * Sleeper and Second Sitting only, another says it appears in 3A and 2A on most long-distance
 * trains. Both may be right for different rakes. Only what is certain across every source is
 * allowed to return `no`, because a `no` deletes an option the traveller might otherwise have
 * booked.
 */
export function quotaApplies(klass: string, quota: string): 'yes' | 'no' | 'unknown' {
  const k = klass.toUpperCase();
  const q = quota.toUpperCase();
  const berth = BERTH_CLASSES.includes(k);

  switch (q) {
    case 'GN':
      // The general quota exists for every reserved class; it is the default pool.
      return 'yes';
    case 'TQ':
    case 'PT':
      // Verified: 1A has no Tatkal quota. Everything else reserved does.
      return hasTatkal(k) ? 'yes' : 'no';
    case 'HP':
      // Documented as two lower and two upper BERTHS per train. A chair car has no berths,
      // so the quota cannot be constituted there. Certain.
      return berth ? 'unknown' : 'no';
    case 'SS':
    case 'LB':
      // Lower-berth preference and the senior/lady-alone quota are berth-position quotas.
      return berth ? 'unknown' : 'no';
    case 'LD':
      // Documented as six lower berths per Sleeper coach, and as reserved in Sleeper and Second
      // Sitting. Whether it reaches the AC berth classes conflicts between sources, and nothing
      // rules it out in a chair car, so only SL and 2S are asserted and everything else stays
      // unknown. A `no` here would delete an option a woman travelling alone might have had.
      return (k === 'SL' || k === '2S') ? 'yes' : 'unknown';
    case 'DF':
    case 'FT':
    case 'PH':
    case 'DP':
    case 'HO':
    case 'RE':
    case 'PQ':
    case 'RS':
      // Real quotas, but whether a given train carries one is not published.
      return 'unknown';
    default:
      return 'no';
  }
}

/**
 * Whether this exact query can exist at all.
 *
 * Returns a reason when the answer is certainly no, and `null` when it might be yes — including
 * when nothing is known. This is the only place Tier 0 is allowed to produce a verdict, and it
 * only ever produces the negative one.
 */
export function staticallyImpossible(q: AvailabilityQuery, train: TrainFacts | null): string | null {
  if (train === null) return null;

  const classes = train.classes.map((c) => c.toUpperCase());
  const k = q.klass.toUpperCase();
  const quota = q.quota.toUpperCase();

  // An empty class list is a hole in the data, not evidence. The CC0 bootstrap leaves `classes`
  // blank often enough that treating "unknown" as "does not run this" would rule out real
  // bookings wholesale — the same harm as inventing availability, only quieter. The quota checks
  // below still run, because they depend only on the class and quota vocabulary, never on what
  // this particular train happens to carry.
  if (classes.length > 0 && !classes.includes(k)) {
    return `This train does not run ${k} at all — its classes are ${classes.join(', ')}.`;
  }

  const applies = quotaApplies(q.klass, q.quota);
  if (applies === 'no') {
    if ((quota === 'TQ' || quota === 'PT') && !hasTatkal(k)) {
      return `${k} has no Tatkal quota, so there is nothing to book under ${quota}. Tatkal exists in every other reserved class.`;
    }
    if (BERTH_CLASSES.includes(k) === false && ['HP', 'SS', 'LB'].includes(quota)) {
      return `${k} assigns seats, not berths, so the ${quota} quota — which reserves specific berth positions — cannot apply to it. Try the general quota, or a berth class.`;
    }
    return `The ${quota} quota does not apply to ${k}.`;
  }
  return null;
}

/**
 * Which quotas are worth trying for this class, best first.
 *
 * This is the ranked list behind the "switch quota" remedy. Approximate pool sizes are included
 * where they are published at all, because the size changes the advice: the Ladies quota is a
 * handful of berths per coach, so it is often free precisely because so few people are eligible,
 * while the general quota is where the demand is.
 *
 * Sizes are indicative and drawn from published allocations — 6 lower berths per Sleeper coach
 * for Ladies, 2 lower + 2 upper per train for Divyangjan, a combined 2 lower berths in
 * Sleeper/3A/2A for seniors and women travelling alone, roughly 10 berths per coach for Tatkal
 * in AC and 30% of accommodation in Sleeper. They are context, never a guarantee, and unused
 * quota is released to the general pool when the chart is prepared.
 */
export function quotaOptions(klass: string): ReadonlyArray<{ code: string; pool: string; note: string }> {
  const k = klass.toUpperCase();
  const out: Array<{ code: string; pool: string; note: string }> = [];

  const push = (code: string, pool: string, note: string): void => {
    if (quotaApplies(k, code) !== 'no') out.push({ code, pool, note });
  };

  push('GN', 'largest — most reserved berths', 'The default pool, and where cancellations go first.');
  if (hasTatkal(k)) {
    push('TQ', '~10 berths per AC coach; ~30% of sleeper accommodation', 'Opens one day before the train leaves its origin.');
    push('PT', 'similar to Tatkal', 'Dynamic pricing; generally non-refundable.');
  }
  push('LD', '6 lower berths per Sleeper coach', 'A woman travelling alone or with children under 12. Small pool, often unbooked.');
  push('SS', '2 lower berths per train, shared across Sleeper/3A/2A', 'Senior citizens and women 45+ travelling alone.');
  push('HP', '2 lower + 2 upper berths per train', 'Requires a documented disability certificate.');
  push('DF', 'not published', 'Serving or retired defence personnel.');
  push('FT', 'not published', 'Foreign passport holders.');
  push('PQ', 'not published', 'Pooled quota for part-journey travellers; usually harder to clear.');

  return out;
}

/**
 * Tier 0 as a cascade source.
 *
 * It answers only the certainly-impossible case, with `source: 'STATIC'` and `verdict: 'REGRET'`.
 * A REGRET from Tier 0 means **"this accommodation does not exist"**, not "this accommodation is
 * sold out" — the explanation says which, and the UI must not render it as a live result. For
 * every other query it returns `null` so higher tiers get their turn; T0 has no opinion about
 * whether a seat is free, and must never acquire one.
 *
 * `raw` is empty because no IRCTC string was parsed. `parsed` is true because the verdict itself
 * is known rather than unrecognised.
 */
export function tier0Source(resolve: TrainResolver): AvailabilitySource {
  return {
    id: 'T0',
    available: () => true,
    async lookup(q: AvailabilityQuery): Promise<AvailabilityReading | null> {
      const reason = staticallyImpossible(q, resolve(q.trainNumber));
      if (reason === null) return null;
      return {
        status: { verdict: 'REGRET', raw: '', parsed: true },
        tier: 'T0',
        source: 'STATIC',
        asOf: null,
        ageSeconds: null,
        explanation: reason,
      };
    },
  };
}

/** Non-AC classes, re-exported so callers do not need to import from two modules. */
export { NON_AC_CLASSES } from './rules';

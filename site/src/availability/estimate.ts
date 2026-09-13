/**
 * estimate.ts — the answer to "so will I actually get a seat?" when nobody outside IRCTC can
 * see one.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS, AND WHAT IT IS NOT
 * ---------------------------------------------------------------------------
 * This is a **structural estimate**, not a statistical model and not live data. It says: given
 * the berths this class probably has, how much of the run this leg covers, how far away the
 * travel date is, which day of the week it is, whether a festival is in the run-up, which
 * quota is being asked for and how busy the two ends of the corridor are, roughly how full is
 * this train likely to be — and therefore whether to expect seats, a short waitlist, or a
 * number people do not clear.
 *
 * It is deliberately NOT wired into Tier 1 (`model.ts`). Tier 1 is a *fitted* logistic model
 * with a calibration curve, gates and an interval, and docs/01 is explicit that it must not be
 * fed invented coefficients. Shipping a made-up coefficient table through that runtime would
 * launder this file's assumptions into something that looks measured. So the two live side by
 * side with different words on them: Tier 1 says PREDICTED, this says ESTIMATED, and the UI is
 * required to show which one it is holding.
 *
 * ---------------------------------------------------------------------------
 * WHY AN ESTIMATE IS STILL WORTH SHIPPING
 * ---------------------------------------------------------------------------
 * The question "should I book this train on this date, or shift a day?" has an answer that is
 * ordered even when it is not calibrated. Everyone who has booked an Indian train ticket knows
 * the ordering: sleeper on a Sunday during Diwali is hopeless; 2A on a Tuesday six weeks out on
 * the same train is not; Tatkal the day before is a coin toss at a higher price. An estimate
 * that reproduces those orderings — and says out loud that it is an estimate — is useful for
 * *choosing*, which is what this whole app is for. It is useless, and dangerous, for
 * *deciding to travel without a ticket*.
 *
 * The tests in `tests/estimate.test.ts` pin the orderings rather than the numbers, because the
 * numbers cannot be verified from here and the orderings can be reasoned about.
 *
 * ---------------------------------------------------------------------------
 * THE MODEL
 * ---------------------------------------------------------------------------
 *   pool   = berths(class) × allotmentShare(legKm)      ← how many berths this leg competes for
 *   load   = classFactor × typeFactor × dowFactor × seasonFactor
 *          × festivalFactor × quotaFactor × corridorFactor
 *          × urgency(daysToDeparture) × PEAK
 *   load < 1  →  seats   = pool × (1 − load), +/− band
 *   load ≥ 1  →  overflow = pool × (load − 1), saturating into a waitlist position
 *   pConfirm  = 1 / (1 + (wl / W50)^1.3), where W50 grows as departure nears
 *
 * `urgency(t) = 1 / (1 + t/12)`: demand is not spread evenly across the booking window, it
 * piles up in the last week — which is why a ticket twelve days out and a ticket two days out
 * are different products. `PEAK = 1.55` is where the curve tops out on the day of travel.
 *
 * ---------------------------------------------------------------------------
 * EVERY CONSTANT IS AN ASSUMPTION, AND SAYS SO
 * ---------------------------------------------------------------------------
 * No public dataset of observed Indian Railways occupancy per (train, class, date, segment)
 * exists to fit against — that is exactly the gap docs/01 §9 records for Tier 1, and the reason
 * the training corpus there is a 2023 Kaggle scrape rather than something better. So the
 * multipliers below are **authored judgement tuned to reproduce the well-known ordering**, and
 * they are marked as such, one by one, rather than dressed up as measurements. Two things
 * follow and both are enforced in the UI:
 *
 *   1. The output is a RANGE and a VERDICT, never a seat count presented as a fact.
 *   2. Every reading carries the factor list that produced it, so a traveller can disagree with
 *      the reasoning instead of with a number.
 *
 * Where a number does come from somewhere checkable — berths per coach, the class list, the
 * running days, the festival calendar, the quota rules — it is imported from the module that
 * owns it (rake.ts, rules.ts, festivals.ts) rather than restated here, so this file cannot
 * drift away from the facts those modules hold.
 */
import { capacityFor, type Capacity, type TrainFacts } from './rake';
import { hasTatkal, istNow, originDateOf, weekdayBit, DAY_NAMES } from './rules';
import { FESTIVALS_2026, festivalOf } from './festivals';

/** The badge every estimated number must carry. Exported so UI and tests share one string. */
export const ESTIMATE_BADGE = 'ESTIMATED';

/** Identifies the model that produced a reading. Bump it when a constant changes. */
export const ESTIMATE_METHOD = 'structural-v1 · uncalibrated';

/** What the estimate thinks you are looking at, in one word. */
export type EstimateVerdict =
  /** Room to spare is the best guess. */
  | 'SEATS'
  /** Likely to be tight but probably bookable on the day you look. */
  | 'TIGHT'
  /** Probably a waitlist, and probably one that clears. */
  | 'WAITLIST'
  /** Probably a long waitlist. Book something else, or a different date. */
  | 'HEAVY_WAITLIST'
  /** Cannot say: the class does not exist on this train, or the pool is not open yet. */
  | 'UNKNOWN';

export interface EstimateFactor {
  /** What was considered, e.g. "Days to departure". */
  label: string;
  /** What it was, in words, e.g. "12 days out — early in the booking curve". */
  detail: string;
  /** The multiplier applied. 1 means neutral. Shown so the arithmetic is inspectable. */
  effect: number;
}

export interface EstimateRange {
  low: number;
  likely: number;
  high: number;
}

export interface SeatEstimateInput {
  /** The train's own facts: type and the classes it actually runs. */
  train: TrainFacts;
  klass: string;
  /** Quota code. GN unless the traveller asked for something else. */
  quota?: string;
  /** Distance of THIS leg, not of the train's whole run. */
  legKm: number;
  /** ISO date the traveller boards. */
  boardingDateIso: string;
  /** Negative when the train started its run before the boarding date. */
  serviceDayOffset?: number;
  /** Trains that call at each end, used as a corridor-size proxy. Null when unknown. */
  boardCalls?: number | null;
  alightCalls?: number | null;
  /** Today, in IST. Defaults to `istNow()`. Injectable so tests are not calendar-dependent. */
  todayIso?: string;
}

export interface SeatEstimate {
  klass: string;
  quota: string;
  verdict: EstimateVerdict;
  /** Berths (or seats) this class has on the train, whole rake, from Tier 0. */
  capacity: Capacity | null;
  /** Berths this leg is modelled as competing for. Always ≤ capacity.nominal. */
  pool: EstimateRange | null;
  /** Estimated free berths for this leg, when load < 1. */
  seats: EstimateRange | null;
  /** Estimated waitlist position, when load ≥ 1. */
  waitlist: EstimateRange | null;
  /** Rough chance a waitlist at `waitlist.likely` eventually confirms. Never an interval. */
  pConfirm: number | null;
  /** Estimated demand ÷ supply. 1 means "exactly filled at departure". */
  loadIndex: number;
  /** Days from today to the train's origin departure. */
  daysToDeparture: number;
  /** Date the train leaves its origin — what the booking window counts from. */
  originDateIso: string;
  confidence: 'low' | 'medium';
  /** Why confidence is what it is. Empty when medium. */
  confidenceReasons: readonly string[];
  /** Every multiplier that produced `loadIndex`, in reading order. */
  factors: readonly EstimateFactor[];
  /** One-line verdict a traveller can act on. No number in it is presented as a fact. */
  headline: string;
  /** What this estimate cannot know. Rendered next to it, never optional. */
  caveats: readonly string[];
}

// ---------------------------------------------------------------------------
// The assumption table
// ---------------------------------------------------------------------------

/**
 * How full a class usually runs, relative to Sleeper.
 *
 * Sleeper is the reference because it is where the competition is: most berths, most demand,
 * and the class almost everyone books. AC tiers run emptier per berth — fewer berths, quieter
 * passengers-per-berth — and First AC emptiest of all. Second sitting runs full because it is
 * cheap and short-haul. **Authored.**
 */
const CLASS_FACTOR: Readonly<Record<string, number>> = {
  SL: 1.02, '2S': 0.98, UR: 1.0, '3E': 0.97, '3A': 0.94, CC: 0.88,
  '2A': 0.82, EC: 0.72, FC: 0.7, '1A': 0.62, EA: 0.7,
};

/** Premium services run fuller than the average Mail/Express, suburban and passenger trains far emptier. **Authored.** */
const TYPE_FACTOR: Readonly<Record<string, number>> = {
  VNDB: 1.1, RAJ: 1.06, SHT: 1.05, DRNT: 1.05, SVD: 1.02, SUF: 1.0, MEX: 1.0,
  SPL: 0.95, GBR: 0.95, HMS: 0.9, DDE: 0.9, JSB: 0.85, ANT: 0.8, INT: 0.7,
  PAX: 0.62, UNK: 1.0,
};

/**
 * Day of week, indexed exactly as `weekdayBit()` returns (bit 0 = Monday) so the two cannot
 * disagree. Friday and Sunday are the peaks — the two nights people travel to and from a
 * weekend — and Tuesday and Wednesday the troughs. **Authored.**
 */
const DOW_FACTOR: readonly number[] = [1.05, 0.93, 0.92, 0.98, 1.09, 1.03, 1.12];

/**
 * Month of the ORIGIN departure, 1..12.
 *
 * April–June is the school-holiday season, October–December the festival and year-end block.
 * July–September is the monsoon trough: demand genuinely drops, on hill routes as well as
 * plains ones. **Authored.**
 */
const MONTH_FACTOR: readonly number[] = [0, 0.95, 0.98, 1.0, 1.06, 1.1, 1.08, 0.98, 1.0, 0.97, 1.1, 1.06, 1.08];

/** Demand multiplier inside a festival run-up, at its peak. docs/01 puts festival corridors at 5–20× normal. **Authored, conservative.** */
const FESTIVAL_PEAK = 1.3;

/** How small a small-pool quota is, relative to general. Tatkal is priced to be available. **Authored.** */
const QUOTA_FACTOR: Readonly<Record<string, number>> = {
  GN: 1.0,
  TQ: 0.5,
  PT: 0.45,
  LD: 0.62,
  SS: 0.62,
  HP: 0.6,
  DF: 0.6,
  FT: 0.55,
};

/**
 * Where in the booking curve demand piles up.
 *
 * `urgency(t) = t50 / (t50 + t)` with t50 = 12 days: half of all eventual demand for a train has
 * arrived by twelve days out, and the rest arrives in the last week and a half. Multiplied by
 * PEAK this tops out just over 1.5 on the day of travel. **Authored.**
 */
const T50_DAYS = 12;
const PEAK = 1.55;

/**
 * What share of the rake a given intermediate segment competes for.
 *
 * IRCTC allots quota per (train, boarding, alighting, date, class, quota) tuple, so the pool
 * behind a 150 km hop is not the train's whole rake — a fact `rake.ts` states on every capacity
 * it returns. Nobody publishes the allotment rule, so it is modelled as a monotone ramp: a
 * short hop gets about a third of the rake's berths in its pool, a 1,000 km ride the whole
 * rake, because an end-to-end passenger is who the berths are really reserved for.
 * **Authored, and the single largest assumption in this file** — which is why it is also the
 * first thing the UI says when it explains itself.
 */
const ALLOTMENT_MIN = 0.35;
const ALLOTMENT_PER_KM = 0.00065;

/**
 * How many people queue behind each berth of oversubscription.
 *
 * Two effects: several people hold a waitlisted ticket for each berth that might free, and a
 * queue grows until the departure board stops listing it. **Authored.**
 */
const WL_QUEUE_FACTOR = 1.4;

/** How much more forgiving a waitlist gets as departure approaches and cancellations arrive. **Authored.** */
const WL_W50_RAMP = 1.6;

/**
 * Waitlists do not grow without bound: past a point the queue keeps people away and the
 * departure board stops showing more. Modelled as an exponential saturation against the pool
 * size, so the model cannot print a waitlist longer than the train. **Authored.**
 */
const WL_SATURATION_OF_POOL = 0.55;
const WL_SATURATION_FLOOR = 60;

/** Waitlist that has an even chance of clearing, as a share of the pool, before the ramp. **Authored.** */
const W50_OF_POOL = 0.05;

/** Verdict thresholds on `loadIndex`. **Authored.** */
const TIGHT_AT = 0.75;
const WAITLIST_AT = 1.0;
const HEAVY_AT = 1.35;

/** The band around a point estimate, as a share of the pool, plus a floor for small pools. **Authored.** */
const BAND_SHARE = 0.35;
const BAND_FLOOR = 3;

/** Below this many berths in the pool, small-number noise dominates and confidence drops. */
const SMALL_POOL = 60;

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

function band(pool: number, likely: number): EstimateRange {
  const width = Math.max(BAND_FLOOR, Math.round(pool * BAND_SHARE));
  return { low: Math.max(0, Math.round(likely) - width), likely: Math.round(likely), high: Math.round(likely) + width };
}

/** `urgency(t)` — see T50_DAYS. */
function urgency(days: number): number {
  // Negative means the train has already left its origin. Demand does not fall below the
  // last-day value: a train boarding tomorrow is as booked as it is going to get.
  const t = Math.max(0, days);
  return T50_DAYS / (T50_DAYS + t);
}

/**
 * Corridor size, from how many trains call at each end.
 *
 * Station `calls` counts are the dataset's own traffic ranking and the best size proxy it
 * carries. Two big-city ends mean more competing travellers; two small ones mean fewer. The
 * effect is deliberately gentle — city size moves demand, but not as much as the date does —
 * and it is bounded so a mega-city pair cannot on its own tip a verdict.
 */
function corridorFactor(boardCalls: number | null, alightCalls: number | null): number | null {
  if (boardCalls === null || alightCalls === null || boardCalls <= 0 || alightCalls <= 0) return null;
  const geo = Math.sqrt(boardCalls * alightCalls);
  return clamp(geo / 150, 0.88, 1.18);
}

/** How far into a festival run-up a date is: 1 on the festival day, → 0 at the window edge. */
function festivalStrength(festivalKey: string | null, originDateIso: string): number | null {
  if (festivalKey === null) return null;
  const entry = FESTIVALS_2026.find((f) => f.key === festivalKey);
  if (!entry) return null;
  const days = Math.round(
    (Date.parse(`${entry.dateIso}T12:00:00Z`) - Date.parse(`${originDateIso}T12:00:00Z`)) / 86_400_000,
  );
  const pre = Math.max(1, entry.pre);
  if (days < 0 || days > pre) return null;
  return 1 - days / (pre + 1);
}

/**
 * Estimate availability for one leg.
 *
 * Returns a verdict with its reasoning and never a bare number. `capabilities` — a class the
 * train does not run, a Tatkal pool that has not opened yet — produce `verdict: 'UNKNOWN'`
 * with an explanation rather than a guess, because those are the two cases where the model has
 * nothing to say and a number would be pure invention.
 */
export function estimateSeats(input: SeatEstimateInput): SeatEstimate {
  const klass = input.klass.toUpperCase();
  const quota = (input.quota ?? 'GN').toUpperCase();
  const serviceDayOffset = input.serviceDayOffset ?? 0;
  const originDateIso = originDateOf(input.boardingDateIso, serviceDayOffset);
  const todayIso = input.todayIso ?? istNow().dateIso;
  const daysToDeparture = Math.round(
    (Date.parse(`${originDateIso}T12:00:00Z`) - Date.parse(`${todayIso}T12:00:00Z`)) / 86_400_000,
  );

  const capacity = capacityFor(input.train, klass);
  const factors: EstimateFactor[] = [];
  const caveats = [
    'No live data: this is an estimate, not a reading from IRCTC. Only IRCTC can say whether a berth exists.',
    'Berths per coach and the composition are standard-template figures, because real rakes are not published.',
  ];

  const base: Omit<SeatEstimate, 'verdict' | 'headline'> = {
    klass,
    quota,
    capacity,
    pool: null,
    seats: null,
    waitlist: null,
    pConfirm: null,
    loadIndex: 0,
    daysToDeparture,
    originDateIso,
    confidence: 'low',
    confidenceReasons: [],
    factors,
    caveats,
  };

  if (!capacity) {
    return {
      ...base,
      verdict: 'UNKNOWN',
      headline: input.train.classes.length === 0
        ? `This train's class list is missing from the data, so there is nothing to estimate ${klass} from.`
        : `${klass} is not one of the classes this train runs, so there is nothing to estimate.`,
      caveats: [...caveats, 'Check the class list against IRCTC before planning around it.'],
    };
  }

  // Tatkal and Premium Tatkal do not exist until the day before departure. Estimating demand in
  // a pool that is not open yet would be inventing the one number nobody can see.
  if (['TQ', 'PT'].includes(quota) && daysToDeparture > 1) {
    return {
      ...base,
      verdict: 'UNKNOWN',
      headline: `${quota} does not open until the day before departure, so there is no pool to estimate yet. `
        + 'The estimate below the line is for the general quota instead.',
      caveats: [...caveats, 'Quota pools are separate: general-quota demand says nothing about Tatkal.'],
    };
  }

  const dow = DAY_NAMES[weekdayBit(originDateIso)];
  const month = Number(originDateIso.slice(5, 7));
  const festivalKey = festivalOf(originDateIso);

  const classFactor = CLASS_FACTOR[klass] ?? 1;
  const typeFactor = TYPE_FACTOR[input.train.type] ?? 1;
  const dowFactor = DOW_FACTOR[weekdayBit(originDateIso)] ?? 1;
  const monthFactor = MONTH_FACTOR[month] ?? 1;
  const strength = festivalStrength(festivalKey, originDateIso);
  const festivalFactor = strength === null ? 1 : 1 + (FESTIVAL_PEAK - 1) * strength;
  const quotaFactor = QUOTA_FACTOR[quota] ?? 1;
  const corridor = corridorFactor(input.boardCalls ?? null, input.alightCalls ?? null);
  const corridorValue = corridor ?? 1;
  const urgencyValue = urgency(daysToDeparture);

  factors.push({
    label: 'Days to departure',
    detail: daysToDeparture >= 0
      ? `${daysToDeparture} day${daysToDeparture === 1 ? '' : 's'} before the train leaves ${originDateIso}`
      : `the train left its origin ${Math.abs(daysToDeparture)} day(s) ago`,
    effect: urgencyValue * PEAK,
  });
  factors.push({ label: 'Class', detail: `${klass} typically runs at ${(classFactor * 100).toFixed(0)}% of Sleeper demand`, effect: classFactor });
  factors.push({ label: 'Train type', detail: input.train.type, effect: typeFactor });
  factors.push({ label: 'Day of week', detail: `${dow} departure`, effect: dowFactor });
  factors.push({ label: 'Month', detail: `${originDateIso.slice(0, 7)}`, effect: monthFactor });
  factors.push({
    label: 'Festival window',
    detail: strength === null ? 'no festival run-up on this date' : `${festivalKey} run-up, ${(strength * 100).toFixed(0)}% of peak`,
    effect: festivalFactor,
  });
  factors.push({
    label: 'Quota',
    detail: quota === 'GN' ? 'general quota — the pool most people compete for' : `${quota} pool`,
    effect: quotaFactor,
  });
  if (corridor !== null) {
    factors.push({
      label: 'Corridor size',
      detail: `${Math.round(input.boardCalls ?? 0)} and ${Math.round(input.alightCalls ?? 0)} trains call at the two ends`,
      effect: corridorValue,
    });
  }

  const loadIndex = classFactor * typeFactor * dowFactor * monthFactor * festivalFactor
    * quotaFactor * corridorValue * urgencyValue * PEAK;

  // Pool: the share of the rake this leg competes for. Uses the *nominal* capacity, and keeps
  // the low/high rake range as the band, so a template that disagrees with itself on coach
  // count shows up as width rather than as false precision.
  const allotment = clamp(ALLOTMENT_MIN + ALLOTMENT_PER_KM * Math.max(0, input.legKm), ALLOTMENT_MIN, 1);
  const poolLikely = capacity.nominal * allotment;
  const pool = {
    low: Math.max(1, Math.round(capacity.low * allotment)),
    likely: Math.max(1, Math.round(poolLikely)),
    high: Math.max(1, Math.round(capacity.high * allotment)),
  };

  const confidenceReasons: string[] = [];
  if (capacity.confidence === 'low') confidenceReasons.push('the train\'s class list was inferred, not sourced');
  if (input.train.classesInferred) confidenceReasons.push('the rake template had to be guessed from the train type');
  if (pool.likely < SMALL_POOL) confidenceReasons.push('the pool is small, so noise dominates');
  if (strength !== null) confidenceReasons.push('festival demand varies far more than the model can see');
  if (input.train.runsDays === undefined) confidenceReasons.push('running days are unknown, so the service frequency is assumed');
  const confidence: 'low' | 'medium' = confidenceReasons.length > 0 ? 'low' : 'medium';

  let verdict: EstimateVerdict;
  let seats: EstimateRange | null = null;
  let waitlist: EstimateRange | null = null;
  let pConfirm: number | null = null;

  if (loadIndex < WAITLIST_AT) {
    verdict = loadIndex < TIGHT_AT ? 'SEATS' : 'TIGHT';
    const free = poolLikely * (1 - loadIndex);
    seats = band(poolLikely, free);
    // A low bound of zero is allowed to stand rather than being nudged up: 0–14 free is a real
    // answer for a nearly-full train, and a more useful one than a tidy 7 that implies a floor
    // this model cannot see.
  } else {
    verdict = loadIndex < HEAVY_AT ? 'WAITLIST' : 'HEAVY_WAITLIST';
    const overflow = poolLikely * (loadIndex - 1);
    const saturation = Math.max(WL_SATURATION_FLOOR, poolLikely * WL_SATURATION_OF_POOL);
    const wl = saturation * (1 - Math.exp(-overflow / saturation)) * WL_QUEUE_FACTOR;
    waitlist = band(poolLikely, wl);
    // A waitlist position is at least 1: the model only gets here when the pool is oversubscribed,
    // and "WL 0–8" would read as a seat on a train that has none to spare.
    waitlist.low = Math.max(1, waitlist.low);
    const w50 = Math.max(12, poolLikely * W50_OF_POOL * (1 + WL_W50_RAMP * (1 - clamp(daysToDeparture, 0, 60) / 60)));
    pConfirm = clamp(1 / (1 + Math.pow(waitlist.likely / w50, 1.3)), 0.02, 0.95);
  }

  const headline = describe({ verdict, klass, quota, seats, waitlist, pConfirm, daysToDeparture, confidence });

  return {
    ...base,
    verdict,
    pool,
    seats,
    waitlist,
    pConfirm,
    loadIndex,
    confidence,
    confidenceReasons,
    headline,
    caveats: [
      ...caveats,
      'The model has not been calibrated against observed bookings, so the ordering it gives is more trustworthy than any single number.',
    ],
  };
}

/**
 * The verdict in words.
 *
 * Written here rather than in the component so that every surface — the itinerary chip, the leg
 * panel, the exported text — says the same thing about the same estimate. Rounded numbers are
 * prefixed `about` on purpose: the moment one of these reads like a count, it has become a
 * claim this app cannot support.
 */
export function describe(args: {
  verdict: EstimateVerdict;
  klass: string;
  quota: string;
  seats: EstimateRange | null;
  waitlist: EstimateRange | null;
  pConfirm: number | null;
  daysToDeparture: number;
  confidence: 'low' | 'medium';
}): string {
  const { verdict, klass, quota, seats, waitlist, pConfirm, daysToDeparture, confidence } = args;
  const which = quota === 'GN' ? '' : ` in the ${quota} quota`;
  // "Possibly" rather than a denied hedge: the model is not calibrated, so every sentence it
  // writes about the future starts by admitting the future is not settled.
  const hedge = confidence === 'medium' ? 'Likely' : 'Possibly';
  const when = daysToDeparture > 0
    ? `${daysToDeparture} day${daysToDeparture === 1 ? '' : 's'} out`
    : 'at boarding';

  switch (verdict) {
    case 'SEATS':
      return `${hedge} seats${which}: roughly ${seats?.likely ?? 0} free (${seats?.low}–${seats?.high}) in ${klass}, ${when}.`;
    case 'TIGHT':
      return `${hedge} tight${which}: roughly ${seats?.likely ?? 0} ${klass} berths left (${seats?.low}–${seats?.high}), and they move fast.`;
    case 'WAITLIST':
      return `${hedge} a waitlist${which}: around WL ${waitlist?.low}–${waitlist?.high} in ${klass}`
        + (pConfirm === null ? '.' : `, clearing maybe ${Math.round(pConfirm * 100)}% of the time at that position.`);
    case 'HEAVY_WAITLIST':
      return `${hedge} a long waitlist${which}: WL ${waitlist?.low}–${waitlist?.high} in ${klass}`
        + (pConfirm === null ? '.' : `, which clears maybe ${Math.round(pConfirm * 100)}% of the time.`)
        + ' A different date, train or class is worth more than patience here.';
    default:
      return 'Nothing can be estimated for this combination.';
  }
}

/**
 * The short form, for an itinerary summary where there is room for eight words and not eighty.
 *
 * Never returns a number on its own: the caller renders it next to `ESTIMATE_BADGE`.
 */
export function estimateChip(e: SeatEstimate): string {
  switch (e.verdict) {
    case 'SEATS': return `${e.klass} ≈ ${e.seats?.likely ?? 0} free`;
    case 'TIGHT': return `${e.klass} tight ≈ ${e.seats?.likely ?? 0} left`;
    case 'WAITLIST': return `${e.klass} WL ≈ ${e.waitlist?.likely ?? 0} · ${Math.round((e.pConfirm ?? 0) * 100)}% clear`;
    case 'HEAVY_WAITLIST': return `${e.klass} WL ≈ ${e.waitlist?.likely ?? 0} — unlikely`;
    default: return 'cannot estimate';
  }
}

/**
 * Severity order for picking the leg that decides an itinerary.
 *
 * UNKNOWN ranks below SEATS rather than above HEAVY_WAITLIST: it is the absence of an answer, so
 * a leg nobody could estimate must not be allowed to headline a card whose other legs were
 * estimated perfectly well. It is only ever returned when *every* leg was unknown.
 */
const VERDICT_RANK: Readonly<Record<EstimateVerdict, number>> = {
  UNKNOWN: -1, SEATS: 0, TIGHT: 1, WAITLIST: 2, HEAVY_WAITLIST: 3,
};

/**
 * The worst estimate in a journey, because a journey is as bookable as its hardest leg.
 *
 * Same principle as `worstStatus` in status.ts: an itinerary whose first train has seats and
 * whose second is WL 90 is a WL 90 itinerary, and presenting it as anything else is the
 * optimistic framing this whole module exists to avoid. Returns null for an empty list.
 */
export function worstEstimate(estimates: readonly (SeatEstimate | null)[]): SeatEstimate | null {
  let worst: SeatEstimate | null = null;
  for (const e of estimates) {
    if (e === null) continue;
    if (worst === null || VERDICT_RANK[e.verdict] > VERDICT_RANK[worst.verdict]) worst = e;
  }
  return worst;
}

/**
 * The estimate for one leg of a journey, from a segment plus the two station traffic counts.
 *
 * Lives here rather than in the component so the same call is available to the exporter, the
 * tests and the panel — three places that must not disagree about whether a leg is bookable.
 */
export function estimateForLeg(args: {
  segment: {
    klass: string; trainType: string; trainClasses: readonly string[];
    classesInferred: boolean; distKm: number; runsDays: number;
  };
  segmentRunsDaysAssumed: boolean;
  boardingDateIso: string;
  serviceDayOffset: number;
  boardCalls: number | null;
  alightCalls: number | null;
  todayIso?: string;
}): SeatEstimate {
  return estimateSeats({
    train: {
      type: args.segment.trainType,
      classes: args.segment.trainClasses,
      classesInferred: args.segment.classesInferred,
      distanceKm: args.segment.distKm,
      // Only passed when the data actually carried running days: an assumed-daily bitmask must
      // not be handed to the model as if it were a service-frequency fact. Spread rather than
      // set to undefined because `exactOptionalPropertyTypes` is on, and "absent" and "present
      // but undefined" are different states everywhere else in this codebase too.
      ...(args.segmentRunsDaysAssumed ? {} : { runsDays: args.segment.runsDays }),
    },
    klass: args.segment.klass,
    legKm: args.segment.distKm,
    boardingDateIso: args.boardingDateIso,
    serviceDayOffset: args.serviceDayOffset,
    boardCalls: args.boardCalls,
    alightCalls: args.alightCalls,
    ...(args.todayIso === undefined ? {} : { todayIso: args.todayIso }),
  });
}

/** True when this class has no Tatkal quota, so the quota remedy has nothing to offer. */
export function tatkalAvailable(klass: string): boolean {
  return hasTatkal(klass);
}

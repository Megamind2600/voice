/**
 * fares.ts — an estimated fare model.
 *
 * THE SOURCE HAS NO FARE DATA. `datameet/railways` ships schedules, trains and stations;
 * there is no `fare.csv`, no per-class price, and `trains.json`'s `classes` string is empty
 * for all 5,208 trains (only boolean per-class flags, covering 34% sleeper / 8% first-AC).
 * PLAN.md assumed a CC0 fare table would exist. It does not, so this module is a model
 * calibrated against published IRCTC fares instead — a deviation, recorded here and in
 * docs/02.
 *
 * Everything it returns is an ESTIMATE and is labelled as one in the UI. IRCTC uses flexi
 * (dynamic) pricing on premium trains, so the true fare for a given seat varies with how
 * many berths are already sold and cannot be known without a live query. A ±25% band is the
 * honest claim; the model is here so journeys can be *compared* on cost, not so anyone can
 * budget to the rupee.
 *
 * Structure follows the real one: a tapered distance-slab base fare per class, plus a fixed
 * reservation charge, plus a superfast surcharge when the train's own average speed earns
 * it, plus 5% GST.
 */

/**
 * Sleeper-class BASE fare against distance, in rupees, as piecewise-linear knots.
 *
 * Fitted to published mail/express sleeper TOTALS (₹310 at 500 km, ₹485 at 1,000 km,
 * ₹555 at 1,384 km, ₹730 at 2,200 km) with the fixed charges and GST removed, which is what
 * turns a total into a base: `base = total / 1.05 - reservation - superfast`. Those four
 * points are the calibration anchors; the rest are interpolated so the marginal rate tapers
 * the way the real slab table does — about ₹0.54/km over the first few hundred km, falling
 * to about ₹0.19/km beyond 2,000 km.
 *
 * The taper is the important shape. A flat per-km rate would price Delhi–Mumbai sleeper at
 * ₹750 instead of ₹557, and would systematically over-value long journeys relative to
 * short ones — exactly the comparison this app asks users to make.
 */
const SL_BASE_KNOTS: readonly number[] = [0, 100, 200, 300, 500, 750, 1000, 1400, 1800, 2200, 2600, 3000];
const SL_BASE_FARES: readonly number[] = [30, 55, 80, 140, 210, 300, 377, 447, 530, 610, 685, 760];

/**
 * Class multiplier on the sleeper BASE fare. These ratios are far more stable across
 * distances than absolute fares are, which is why the model is one tapered curve times a
 * per-class constant rather than twelve separate tables.
 *
 * DERIVED, not guessed: each is the published total for NDLS→BCT (~1,384 km) with GST and
 * the fixed charges stripped off, divided by the sleeper base at the same distance. Applying
 * the ratio to the total instead of the base — the obvious mistake, since published fares
 * are quoted as totals — understates AC classes by about 10%, because the ₹85-135 of fixed
 * charges does not scale with class while the base fare does.
 *
 * Resulting totals land within ₹2 of published: SL ₹555, 3A ₹1,452, 2A ₹2,054, 1A ₹3,435.
 *
 * Ordering is deliberate and testable: UR < 2S < SL < 3E < CC < 3A < FC < 2A < EC < 1A.
 * First Class (non-AC) sits between 3A and 2A, which is where IRCTC prices it.
 */
const CLASS_MULTIPLIER: Readonly<Record<string, number>> = {
  UR: 0.15, '2S': 0.32, SL: 1.0, '3E': 2.55, CC: 2.75, '3A': 2.91, FC: 3.6, '2A': 4.20, EC: 5.6, '1A': 7.06,
};

/**
 * Train-type multiplier on the base fare, for flexi pricing and included catering.
 *
 * Two of these go DOWN rather than up, which is easy to get wrong: Garib Rath is a
 * deliberately discounted AC-3-tier product and Jan Shatabdi a discounted chair-car one.
 * Pricing them as premium would be wrong in the direction that matters — it would hide the
 * cheapest comfortable option on a route.
 */
/**
 * Uplift is an AVERAGE across the flexi band, not a price. Rajdhani fares move with
 * occupancy, so the same berth can cost ₹1,900 or ₹2,300 on the same day; 1.40 is the
 * middle of that range calibrated against NDLS→HWH 3A. Every flexi result is flagged so the
 * UI can say the real fare depends on when you book.
 */
const TYPE_MULTIPLIER: Readonly<Record<string, number>> = {
  SHT: 1.55, VNDB: 1.45, RAJ: 1.40, DRNT: 1.35, HMS: 1.25,
  SUF: 1.0, MEX: 1.0, ANT: 1.0, INT: 1.0, DDE: 1.0, SVD: 1.0, SPL: 1.0,
  GBR: 0.85, JSB: 0.85,
  PAX: 0.72, UNK: 0.72,
};

/** Fixed reservation charge per class. */
const RESERVATION: Readonly<Record<string, number>> = {
  UR: 0, '2S': 40, SL: 40, FC: 40, '3E': 45, CC: 45, '3A': 45, '2A': 45, EC: 60, '1A': 60,
};

/** Superfast surcharge per class, charged only when the train qualifies. */
const SUPERFAST: Readonly<Record<string, number>> = {
  UR: 0, '2S': 45, SL: 45, FC: 45, '3E': 45, CC: 45, '3A': 45, '2A': 45, EC: 75, '1A': 75,
};

const GST_RATE = 0.05;

/**
 * IRCTC charges the superfast surcharge when a train's average scheduled speed is at least
 * 55 km/h. That is a rule about the train, not about its name, and we have the distance and
 * duration to apply it directly — so it is computed rather than inferred from the type
 * string, which is unreliable anyway (the source's `type` column mistypes 99.6% of branded
 * trains, which is why type is read from the name during normalisation).
 */
export const SUPERFAST_KMH = 55;

export function isSuperfast(distanceKm: number, durationMin: number): boolean {
  if (distanceKm <= 0 || durationMin <= 0) return false;
  return distanceKm / (durationMin / 60) >= SUPERFAST_KMH;
}

export interface FareEstimate {
  /** All-in price a passenger would expect to pay, in rupees, GST included. */
  total: number;
  base: number;
  reservation: number;
  superfast: number;
  gst: number;
  klass: string;
  /** True when the train's class list was inferred from its type rather than sourced. */
  classesInferred: boolean;
  /** True when flexi pricing applies, i.e. the real fare moves with demand. */
  flexi: boolean;
  /** Per-km rate for the class actually priced. */
  perKm: number;
}

/**
 * Sleeper base fare tabulated at 1 km resolution.
 *
 * Precomputed because the router calls this inside its hottest loop, once per candidate
 * label. Walking twelve knots per call is not expensive in isolation, but at ~400,000 calls
 * per Pareto sweep it is the difference between a search that fits the frame budget and one
 * that does not. Tabulating turns it into a single array read.
 */
const SL_TABLE_MAX_KM = SL_BASE_KNOTS[SL_BASE_KNOTS.length - 1];
const SL_TABLE: Float64Array = (() => {
  const t = new Float64Array(SL_TABLE_MAX_KM + 1);
  for (let km = 0; km <= SL_TABLE_MAX_KM; km++) {
    let i = 1;
    while (i < SL_BASE_KNOTS.length && km > SL_BASE_KNOTS[i]) i++;
    const x0 = SL_BASE_KNOTS[i - 1];
    const x1 = SL_BASE_KNOTS[i];
    const y0 = SL_BASE_FARES[i - 1];
    const y1 = SL_BASE_FARES[i];
    t[km] = y0 + ((km - x0) / (x1 - x0)) * (y1 - y0);
  }
  return t;
})();

/** Sleeper base fare for a distance. Beyond the table, continues at the final marginal rate. */
export function slBase(distanceKm: number): number {
  if (distanceKm <= 0) return 0;
  if (distanceKm <= SL_TABLE_MAX_KM) return SL_TABLE[Math.round(distanceKm)];
  // Never flat beyond the table: the real slab fare keeps tapering but keeps charging, and
  // a flat tail would price a 3,500 km journey identically to a 3,000 km one.
  const last = SL_BASE_KNOTS.length - 1;
  const slope = (SL_BASE_FARES[last] - SL_BASE_FARES[last - 1])
    / (SL_BASE_KNOTS[last] - SL_BASE_KNOTS[last - 1]);
  return SL_BASE_FARES[last] + (distanceKm - SL_TABLE_MAX_KM) * slope;
}

export function classMultiplier(klass: string): number {
  return CLASS_MULTIPLIER[klass] ?? 1.0;
}

export function typeMultiplier(trainType: string): number {
  return TYPE_MULTIPLIER[trainType] ?? 1.0;
}

/**
 * All-in fare for ONE uninterrupted segment on ONE train.
 *
 * This must be called per segment, never per hop. IRCTC prices a journey by total distance
 * on a tapered slab, so summing ten 100 km hops gives ₹1,050 where one 1,000 km ticket
 * costs ₹485 — a 2.2x overstatement that would make every multi-stop ride look absurd and
 * push the router toward itineraries nobody would choose. The router therefore accumulates
 * segment distance and prices it only when the train changes.
 */
export function segmentFare(
  distanceKm: number,
  klass: string,
  trainType: string,
  superfast: boolean,
): number {
  return fareParts(distanceKm, klass, trainType, superfast).total;
}

/**
 * The single fare computation. Both public entry points go through here.
 *
 * There were originally two — a detailed one returning a breakdown for display, and a fast
 * one returning a total for the search — and they disagreed for any train type outside the
 * multiplier table, because only one of them had a fallback. One path makes that class of
 * bug impossible rather than merely tested against.
 */
export function fareParts(
  distanceKm: number,
  klass: string,
  trainType: string,
  superfast: boolean,
): FareParts {
  const k = CLASS_MULTIPLIER[klass] !== undefined ? klass : 'SL';
  const base = Math.round(slBase(distanceKm) * classMultiplier(k) * typeMultiplier(trainType));
  const reservation = RESERVATION[k] ?? 0;
  const surcharge = superfast ? (SUPERFAST[k] ?? 0) : 0;
  const sub = base + reservation + surcharge;
  const gst = Math.round(sub * GST_RATE);
  return {
    klass: k, base, reservation, superfast: surcharge, gst, total: sub + gst,
    perKm: distanceKm > 0 ? Math.round((sub + gst) / distanceKm) : 0,
  };
}

export interface FareParts {
  klass: string;
  base: number;
  reservation: number;
  superfast: number;
  gst: number;
  total: number;
  perKm: number;
}

/** Types whose fare genuinely moves with occupancy, so the estimate is a starting point. */
const FLEXI_TYPES = new Set(['RAJ', 'SHT', 'VNDB', 'DRNT', 'HMS']);

export interface FareInput {
  distanceKm: number;
  /** ISO class code, e.g. 'SL', '3A'. Unknown codes fall back to sleeper. */
  klass: string;
  /** Train type code from TRAIN_TYPES, e.g. 'RAJ', 'MEX'. */
  trainType: string;
  /** Whole-train duration, used for the superfast test. */
  durationMin: number;
  classesInferred?: boolean;
}

export function estimateFare(input: FareInput): FareEstimate {
  const superfast = isSuperfast(input.distanceKm, input.durationMin)
    || FLEXI_TYPES.has(input.trainType);
  const parts = fareParts(input.distanceKm, input.klass, input.trainType, superfast);
  return {
    ...parts,
    classesInferred: input.classesInferred === true,
    flexi: FLEXI_TYPES.has(input.trainType),
  };
}

/**
 * Cheapest bookable class on a train, used when the user has not expressed a preference.
 *
 * Unreserved (UR) is excluded on purpose: it is not a reservable seat, so presenting it as
 * the price of a journey would be misleading, and it is the one class where "available"
 * never means "you will get to sit down".
 */
export function cheapestClass(classes: readonly string[]): string | null {
  let best: string | null = null;
  let bestMult = Infinity;
  for (const c of classes) {
    if (c === 'UR') continue;
    const m = CLASS_MULTIPLIER[c];
    if (m !== undefined && m < bestMult) { bestMult = m; best = c; }
  }
  return best;
}

/** All class codes the model knows how to price, cheapest first. */
export function pricedClasses(): string[] {
  return Object.entries(CLASS_MULTIPLIER)
    .filter(([c]) => c !== 'UR')
    .sort((a, b) => a[1] - b[1])
    .map(([c]) => c);
}

/**
 * The calibration anchors, exported so a test can pin them. If someone edits the knots
 * without re-checking against published fares, the test fails — that is the whole point of
 * shipping the anchors alongside the model.
 */
export const CALIBRATION_ANCHORS: readonly {
  km: number; klass: string; trainType: string; total: number;
}[] = [
  { km: 500, klass: 'SL', trainType: 'SUF', total: 310 },
  { km: 1000, klass: 'SL', trainType: 'SUF', total: 485 },
  { km: 1384, klass: 'SL', trainType: 'SUF', total: 555 },
  { km: 1384, klass: '3A', trainType: 'SUF', total: 1450 },
  { km: 1384, klass: '2A', trainType: 'SUF', total: 2055 },
  { km: 1384, klass: '1A', trainType: 'SUF', total: 3435 },
  { km: 2200, klass: 'SL', trainType: 'SUF', total: 730 },
];

/**
 * Tolerance the model must hold its anchors within, in rupees.
 *
 * Tight enough to catch a wrong multiplier (which is worth hundreds of rupees) and loose
 * enough to absorb the fact that the published figures are quoted for a specific train on a
 * specific date while the model is distance-only. Anything needing exact prices must query
 * IRCTC; this exists so journeys can be COMPARED.
 */
export const CALIBRATION_TOLERANCE_RUPEES = 10;

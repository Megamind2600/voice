/**
 * model.ts — Tier 1: the prediction runtime, without a prediction to run.
 *
 * This is the inference half of Tier 1: the coefficient-table format, a loader that validates it,
 * feature extraction, the piecewise-linear arithmetic, calibration, and the source that plugs into
 * the cascade. What it does not contain is a trained model, because training needs the corpus and
 * an offline step that has not run. `tier1Source(null, ...)` therefore reports itself unavailable
 * and the cascade skips it — the same shape as every other tier in this build.
 *
 * ---------------------------------------------------------------------------
 * THE FAILURE MODE THIS FILE IS BUILT AGAINST
 * ---------------------------------------------------------------------------
 * A coefficient table is numbers someone else produced. If one is missing, malformed, or has a
 * calibration curve that goes backwards, naive inference does not throw — it produces `NaN`, or a
 * probability that is confidently wrong. `NaN` then renders as "NaN% likely to confirm", and a
 * wrong number renders as a number. Both are worse than no answer, and neither is visible in a
 * test that only checks the happy path.
 *
 * So `parseModel()` rejects rather than repairs: non-finite coefficients, knots that are not
 * strictly increasing, a calibration bin sequence that is not monotone, an empty bins array. And
 * inference re-checks its own output, returning `null` rather than a probability if anything
 * downstream produced a non-finite value. An unknown categorical level contributes exactly zero —
 * a class code this model has never seen must degrade to the intercept, not to NaN.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT HERE
 * ---------------------------------------------------------------------------
 * docs/01 §9 specifies a *distribution*: `pConfirm`, `pRac`, `expectedWl` and a 90% interval.
 * This runtime produces `pConfirm` and nothing else, because the other three cannot be derived
 * from a single logistic head. Inventing them — a plausible-looking `expectedWl: 4`, or a ±0.1
 * interval because an interval looks reassuring — would be fabrication wearing a lab coat. They
 * are typed as nullable and stay null until the training step ships a model that actually produces
 * them, and `pConfirmCI` is present only when the table carries an explicit `ciHalfWidth`.
 *
 * The verdict is always UNKNOWN. A prediction is a probability about a berth, not a berth, and
 * `source: 'PREDICTED'` plus the badge is how that distinction reaches the screen. The badge text
 * is exported as `PREDICTED_BADGE` so the UI and the test that polices it cannot drift apart.
 */
import type { AvailabilityQuery, AvailabilityReading, AvailabilitySource } from './tier';
import { parseStatus } from './status';

/** One numeric feature, either a straight coefficient or a curve through knots. */
export type NumericTerm =
  | { kind: 'linear'; coef: number }
  | { kind: 'piecewiseLinear'; knots: readonly number[]; coef: readonly number[] };

export interface Calibration {
  /** Only isotonic is supported; 'none' passes the raw probability through. */
  method: 'isotonic' | 'none';
  /** [raw probability, calibrated probability], ascending by raw. */
  bins: ReadonlyArray<readonly [number, number]>;
}

export interface ModelCoefficients {
  version: string;
  trainedOn: string;
  calibration: Calibration;
  intercept: number;
  numeric: Readonly<Record<string, NumericTerm>>;
  categorical: Readonly<Record<string, Readonly<Record<string, number>>>>;
  festivalMultiplier?: Readonly<Record<string, number>> | undefined;
  /** Half-width of the interval the trainer measured. Absent means no interval is claimed. */
  ciHalfWidth?: number | undefined;
}

/** Everything inference needs, all of it static — no live data, which is why this runs offline. */
export interface ModelFeatures {
  daysToJourney: number;
  /** This segment's distance as a share of the whole run, 0..1. The strongest feature group. */
  segmentDistPct: number;
  /** Natural log of the class capacity from Tier 0, so a 2-coach weekly is not a 24-coach daily. */
  logCapacity: number;
  isFullRun: boolean;
  klass: string;
  quota: string;
  trainType: string;
  /** 'Mon'..'Sun', matching DAY_NAMES. */
  dow: string;
  festival?: string | null | undefined;
}

export interface Prediction {
  /** Calibrated probability that a waitlisted ticket in this tuple confirms. */
  pConfirm: number;
  /** Present only when the shipped table measured one. Never synthesised. */
  pConfirmCI: readonly [number, number] | null;
  /** Not derivable from a single logistic head; null until the trainer supplies it. */
  pRac: number | null;
  expectedWl: number | null;
  /** The pre-calibration sigmoid output, kept so calibration errors are diagnosable. */
  rawP: number;
  modelVersion: string;
}

export class ModelFormatError extends Error {}

function finite(n: unknown, what: string): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new ModelFormatError(`${what} must be a finite number, got ${JSON.stringify(n)}`);
  }
  return n;
}

function inUnit(n: number, what: string): number {
  if (n < 0 || n > 1) throw new ModelFormatError(`${what} must lie in [0,1], got ${n}`);
  return n;
}

/**
 * Validate a coefficient table.
 *
 * Strict on purpose, and the messages name the exact path (`numeric.daysToJourney.knots[3]`) so a
 * bad table can be fixed rather than guessed at. A model that loads is a model whose arithmetic
 * cannot silently produce NaN later.
 */
export function parseModel(json: unknown): ModelCoefficients {
  if (typeof json !== 'object' || json === null) throw new ModelFormatError('model must be an object');
  const m = json as Record<string, unknown>;

  const version = m.version;
  if (typeof version !== 'string' || version.length === 0) throw new ModelFormatError('model.version must be a non-empty string');
  const trainedOn = m.trainedOn;
  if (typeof trainedOn !== 'string' || trainedOn.length === 0) throw new ModelFormatError('model.trainedOn must be a non-empty string');

  const intercept = finite(m.intercept, 'model.intercept');

  const numericRaw = m.numeric;
  if (typeof numericRaw !== 'object' || numericRaw === null) throw new ModelFormatError('model.numeric must be an object');
  const numeric: Record<string, NumericTerm> = {};
  for (const [name, term] of Object.entries(numericRaw as Record<string, unknown>)) {
    const path = `model.numeric.${name}`;
    if (typeof term !== 'object' || term === null) throw new ModelFormatError(`${path} must be an object`);
    const t = term as Record<string, unknown>;
    if (t.kind === 'linear') {
      numeric[name] = { kind: 'linear', coef: finite(t.coef, `${path}.coef`) };
    } else if (t.kind === 'piecewiseLinear') {
      const knots = t.knots;
      const coef = t.coef;
      if (!Array.isArray(knots) || !Array.isArray(coef)) throw new ModelFormatError(`${path}.knots and .coef must be arrays`);
      if (knots.length < 2) throw new ModelFormatError(`${path}.knots needs at least two entries`);
      if (knots.length !== coef.length) {
        throw new ModelFormatError(`${path} has ${knots.length} knots but ${coef.length} coefficients; they must match`);
      }
      const k = knots.map((v, i) => finite(v, `${path}.knots[${i}]`));
      const c = coef.map((v, i) => finite(v, `${path}.coef[${i}]`));
      for (let i = 1; i < k.length; i++) {
        if (k[i] <= k[i - 1]) throw new ModelFormatError(`${path}.knots must be strictly increasing; [${i - 1}]=${k[i - 1]} >= [${i}]=${k[i]}`);
      }
      numeric[name] = { kind: 'piecewiseLinear', knots: k, coef: c };
    } else {
      throw new ModelFormatError(`${path}.kind must be 'linear' or 'piecewiseLinear', got ${JSON.stringify(t.kind)}`);
    }
  }

  const categoricalRaw = m.categorical;
  if (typeof categoricalRaw !== 'object' || categoricalRaw === null) throw new ModelFormatError('model.categorical must be an object');
  const categorical: Record<string, Record<string, number>> = {};
  for (const [group, levels] of Object.entries(categoricalRaw as Record<string, unknown>)) {
    if (typeof levels !== 'object' || levels === null) throw new ModelFormatError(`model.categorical.${group} must be an object`);
    const out: Record<string, number> = {};
    for (const [level, coef] of Object.entries(levels as Record<string, unknown>)) {
      out[level] = finite(coef, `model.categorical.${group}.${level}`);
    }
    categorical[group] = out;
  }

  const calRaw = m.calibration;
  if (typeof calRaw !== 'object' || calRaw === null) throw new ModelFormatError('model.calibration must be an object');
  const cal = calRaw as Record<string, unknown>;
  const method = cal.method;
  if (method !== 'isotonic' && method !== 'none') throw new ModelFormatError(`model.calibration.method must be 'isotonic' or 'none', got ${JSON.stringify(method)}`);
  const binsRaw = cal.bins;
  if (!Array.isArray(binsRaw)) throw new ModelFormatError('model.calibration.bins must be an array');
  if (method === 'isotonic' && binsRaw.length === 0) {
    throw new ModelFormatError('model.calibration.bins cannot be empty when the method is isotonic');
  }
  const bins: Array<readonly [number, number]> = binsRaw.map((b, i) => {
    if (!Array.isArray(b) || b.length !== 2) throw new ModelFormatError(`model.calibration.bins[${i}] must be a [raw, calibrated] pair`);
    return [inUnit(finite(b[0], `model.calibration.bins[${i}][0]`), `model.calibration.bins[${i}][0]`),
            inUnit(finite(b[1], `model.calibration.bins[${i}][1]`), `model.calibration.bins[${i}][1]`)] as const;
  });
  for (let i = 1; i < bins.length; i++) {
    if (bins[i][0] <= bins[i - 1][0]) throw new ModelFormatError(`model.calibration.bins must ascend by raw probability; [${i - 1}]=${bins[i - 1][0]} >= [${i}]=${bins[i][0]}`);
    // Isotonic regression is monotone by construction. A table that is not has been edited by
    // hand, and using it would let a worse raw score calibrate to a better probability.
    if (bins[i][1] < bins[i - 1][1]) throw new ModelFormatError(`model.calibration.bins[${i}] goes backwards (${bins[i - 1][1]} -> ${bins[i][1]}); an isotonic curve cannot decrease`);
  }

  let festivalMultiplier: Record<string, number> | undefined;
  if (m.festivalMultiplier !== undefined) {
    if (typeof m.festivalMultiplier !== 'object' || m.festivalMultiplier === null) throw new ModelFormatError('model.festivalMultiplier must be an object');
    festivalMultiplier = {};
    for (const [k, v] of Object.entries(m.festivalMultiplier as Record<string, unknown>)) {
      festivalMultiplier[k] = finite(v, `model.festivalMultiplier.${k}`);
    }
  }

  let ciHalfWidth: number | undefined;
  if (m.ciHalfWidth !== undefined) ciHalfWidth = inUnit(finite(m.ciHalfWidth, 'model.ciHalfWidth'), 'model.ciHalfWidth');

  return { version, trainedOn, calibration: { method, bins }, intercept, numeric, categorical, festivalMultiplier, ciHalfWidth };
}

/**
 * Evaluate a piecewise-linear term at `x`, interpolating between knots and clamping outside them.
 *
 * Clamping rather than extrapolating is the safe direction: the curve was fitted on the knot
 * range, and extending its slope to, say, 400 days would produce a coefficient nobody measured.
 */
export function termAt(term: NumericTerm, x: number): number {
  if (term.kind === 'linear') return term.coef * x;
  const { knots, coef } = term;
  if (x <= knots[0]) return coef[0] * x;
  const last = knots.length - 1;
  if (x >= knots[last]) return coef[last] * x;
  for (let i = 1; i <= last; i++) {
    if (x <= knots[i]) {
      const span = knots[i] - knots[i - 1];
      const t = span === 0 ? 0 : (x - knots[i - 1]) / span;
      // Interpolate the COEFFICIENT, then apply it to x, so the function stays continuous in x
      // rather than jumping at every knot.
      return (coef[i - 1] + (coef[i] - coef[i - 1]) * t) * x;
    }
  }
  return coef[last] * x;
}

export function sigmoid(z: number): number {
  if (!Number.isFinite(z)) return Number.NaN;
  // Computed in the branch that keeps exp() <= 1, so large |z| cannot overflow to Infinity.
  return z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));
}

/**
 * The linear predictor: intercept plus every numeric and categorical contribution.
 *
 * An unrecognised categorical level contributes zero rather than throwing. A train type this
 * model has never seen is a normal occurrence in a dataset that changes, and the honest response
 * is to fall back to the intercept — not to fail the whole query, and certainly not to guess a
 * neighbouring level's coefficient.
 */
export function linearPredictor(model: ModelCoefficients, f: ModelFeatures): number {
  const numericInputs: Record<string, number> = {
    daysToJourney: f.daysToJourney,
    segmentDistPct: f.segmentDistPct,
    logCapacity: f.logCapacity,
  };
  let z = model.intercept;
  for (const [name, term] of Object.entries(model.numeric)) {
    const x = numericInputs[name];
    if (x === undefined) continue; // a feature the table asks for that we do not compute
    z += termAt(term, x);
  }

  const groups: Record<string, string> = {
    class: f.klass, quota: f.quota, trainType: f.trainType, dow: f.dow,
  };
  for (const [group, levels] of Object.entries(model.categorical)) {
    const level = groups[group];
    if (level === undefined) continue;
    const coef = levels[level];
    if (coef !== undefined) z += coef;
  }

  if (f.isFullRun) {
    // Full-run segments get preferential quota allotment, which is the single most useful thing
    // the segment feature group encodes.
    const full = model.categorical.segment?.full;
    if (full !== undefined) z += full;
  }
  if (f.festival && model.festivalMultiplier) {
    const mult = model.festivalMultiplier[f.festival];
    if (mult !== undefined) z += Math.log(Math.max(1e-6, mult));
  }
  return z;
}

/**
 * Map a raw probability through the calibration curve, interpolating between bins and clamping.
 *
 * Isotonic calibration is a step function in principle; interpolating between bin centres is the
 * smoother and more conservative reading, and it cannot invert an ordering the bins did not have,
 * because `parseModel` already rejected any table whose calibrated column decreases.
 */
export function calibrate(model: ModelCoefficients, rawP: number): number {
  const { method, bins } = model.calibration;
  if (method === 'none' || bins.length === 0) return rawP;
  if (rawP <= bins[0][0]) return bins[0][1];
  const last = bins.length - 1;
  if (rawP >= bins[last][0]) return bins[last][1];
  for (let i = 1; i <= last; i++) {
    if (rawP <= bins[i][0]) {
      const span = bins[i][0] - bins[i - 1][0];
      const t = span === 0 ? 0 : (rawP - bins[i - 1][0]) / span;
      return bins[i - 1][1] + (bins[i][1] - bins[i - 1][1]) * t;
    }
  }
  return bins[last][1];
}

/**
 * Run inference.
 *
 * Returns `null` rather than a probability if any input or intermediate value is non-finite, or if
 * the calibrated result leaves [0,1]. The caller then treats Tier 1 as having declined, which is
 * the same thing it does when no model is loaded — so a corrupt table degrades to "unknown"
 * instead of to a number nobody can check.
 */
export function predict(model: ModelCoefficients, f: ModelFeatures): Prediction | null {
  if (!Number.isFinite(f.daysToJourney) || !Number.isFinite(f.segmentDistPct) || !Number.isFinite(f.logCapacity)) {
    return null;
  }
  const z = linearPredictor(model, f);
  const rawP = sigmoid(z);
  if (!Number.isFinite(rawP)) return null;
  const pConfirm = calibrate(model, rawP);
  if (!Number.isFinite(pConfirm) || pConfirm < 0 || pConfirm > 1) return null;

  const ci = model.ciHalfWidth !== undefined
    ? [Math.max(0, pConfirm - model.ciHalfWidth), Math.min(1, pConfirm + model.ciHalfWidth)] as const
    : null;

  return {
    pConfirm,
    pConfirmCI: ci,
    pRac: null,
    expectedWl: null,
    rawP,
    modelVersion: model.version,
  };
}

/**
 * The badge every predicted number must carry.
 *
 * Exported so the UI and the test that polices the UI import the same string. A badge that is
 * retyped at each call site is a badge that gets dropped at one of them, and docs/01 makes "no
 * code path renders PREDICTED without its badge" a non-negotiable.
 */
export const PREDICTED_BADGE = 'PREDICTED';

/** Plain-language rendering of a prediction, badge first. */
export function predictionLabel(p: Prediction): string {
  const pct = Math.round(p.pConfirm * 100);
  const interval = p.pConfirmCI
    ? `, ${Math.round(p.pConfirmCI[0] * 100)}–${Math.round(p.pConfirmCI[1] * 100)}%`
    : ' (no interval shipped with this model)';
  return `${PREDICTED_BADGE}: about ${pct}% likely to confirm${interval} — a model estimate from `
    + `${p.modelVersion}, not a live seat count.`;
}

/** Supplies the features for a query, from whatever the caller has: the graph, Tier 0, the date. */
export type FeatureExtractor = (q: AvailabilityQuery) => ModelFeatures | null;

/**
 * Tier 1 as a cascade source.
 *
 * `available()` is false when no model is loaded, so the cascade skips the tier entirely rather
 * than asking it and getting nothing. When it does answer, the verdict is UNKNOWN with a
 * `prediction` attached and `source: 'PREDICTED'`: a probability about a berth is not a berth, and
 * the reading must not be renderable as one.
 */
export function tier1Source(model: ModelCoefficients | null, featuresOf: FeatureExtractor): AvailabilitySource {
  return {
    id: 'T1',
    available: () => model !== null,
    async lookup(q: AvailabilityQuery): Promise<AvailabilityReading | null> {
      if (model === null) return null;
      const features = featuresOf(q);
      if (features === null) return null;
      const prediction = predict(model, features);
      if (prediction === null) return null;
      return {
        // parseStatus(null) is the canonical UNKNOWN. `parsed` stays false because there was no
        // string to parse: claiming otherwise would let a panel format this as if IRCTC had said
        // something.
        status: parseStatus(null),
        tier: 'T1',
        source: 'PREDICTED',
        asOf: null,
        ageSeconds: null,
        explanation: predictionLabel(prediction),
        prediction,
      };
    },
  };
}

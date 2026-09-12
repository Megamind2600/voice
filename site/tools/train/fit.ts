/**
 * fit.ts — the numerics: basis expansion, logistic fitting, isotonic calibration, distillation.
 *
 * Plain arrays and no dependencies, because the alternative is a gradient-boosting library in a
 * repository whose entire budget is 60 KB of gzipped JavaScript. docs/01 describes a GBM distilled
 * to a coefficient table; this fits the *distilled* form directly — a logistic model over a
 * piecewise-linear basis — which is one step simpler and, unlike a GBM, is exactly representable in
 * the shipped table format. The approximation that remains is the distillation of each numeric
 * feature's contribution into the `knots`/`coef` shape `model.ts` reads, and that error is measured
 * and gated rather than assumed away.
 *
 * Two properties are worth more than any accuracy figure here:
 *
 * - **Determinism.** There is no random number generator anywhere in this file. The train/holdout
 *   split is a hash of the tuple key, so re-running on the same corpus produces the same table byte
 *   for byte. A model that changes when you re-run it cannot be reviewed, and a review is the only
 *   thing standing between a coefficient table and a number on a traveller's screen.
 * - **The fit is honest about scale.** Columns are scaled internally and the returned weights are in
 *   the original units, so the emitted coefficients mean what the runtime computes. A trainer that
 *   returned scaled weights would produce a table that loads, validates, and predicts nonsense.
 */
import type { ModelFeatures } from '../../src/availability/model';
import { termAt } from '../../src/availability/model';

/**
 * Knots for the piecewise-linear numeric features.
 *
 * Taken from docs/01 §9's example table. They are not evenly spaced, and should not be: demand
 * moves fastest in the first week after a booking window opens and in the last few days before
 * departure, so the knots are bunched where the curve bends and sparse where it is flat.
 */
export const KNOTS: Readonly<Record<string, readonly number[]>> = {
  daysToJourney: [0, 1, 3, 7, 15, 30, 60],
  segmentDistPct: [0, 0.15, 0.4, 0.7, 1.0],
};

/** Numeric features carried as a single straight coefficient, with no knots. */
export const LINEAR_ONLY: readonly string[] = ['logCapacity'];

/** Categorical feature groups, matching the keys `model.ts` looks up. */
export const CATEGORICAL_GROUPS: readonly { group: string; of: (f: ModelFeatures) => string | null }[] = [
  { group: 'class', of: (f) => f.klass },
  { group: 'quota', of: (f) => f.quota },
  { group: 'trainType', of: (f) => f.trainType },
  { group: 'dow', of: (f) => f.dow },
  { group: 'service', of: (f) => f.serviceFrequency ?? null },
  { group: 'festival', of: (f) => f.festival ?? null },
];

/** The column layout a fit uses. Derived from the corpus, never hardcoded. */
export interface Layout {
  readonly names: readonly string[];
  readonly index: ReadonlyMap<string, number>;
  /** Which numeric feature each hinge column belongs to, for distillation. */
  readonly numericOf: ReadonlyMap<string, string>;
  /** Which categorical group and level each one-hot column belongs to. */
  readonly categoricalOf: ReadonlyMap<string, readonly [string, string]>;
}

const FULL_RUN = 'fullRun';

/**
 * Build the column layout from the rows that will actually be fitted.
 *
 * Levels that do not appear in the corpus get no column. Emitting a coefficient for a level nobody
 * observed would put a made-up number into a table that then looks measured, and the runtime would
 * happily use it on a future query.
 */
export function layoutOf(rows: readonly ModelFeatures[]): Layout {
  const names: string[] = [];
  const numericOf = new Map<string, string>();
  const categoricalOf = new Map<string, readonly [string, string]>();

  for (const feature of [...Object.keys(KNOTS), ...LINEAR_ONLY]) {
    const knots = KNOTS[feature] ?? [];
    const lin = `${feature}@lin`;
    names.push(lin);
    numericOf.set(lin, feature);
    for (const k of knots.slice(1)) {
      const hinge = `${feature}@${k}`;
      names.push(hinge);
      numericOf.set(hinge, feature);
    }
  }

  names.push(FULL_RUN);
  categoricalOf.set(FULL_RUN, ['segment', 'full']);

  for (const { group, of } of CATEGORICAL_GROUPS) {
    const levels = new Set<string>();
    for (const f of rows) {
      const v = of(f);
      if (v !== null && v.length > 0) levels.add(v);
    }
    for (const level of [...levels].sort()) {
      const col = `${group}=${level}`;
      names.push(col);
      categoricalOf.set(col, [group, level]);
    }
  }

  return { names, index: new Map(names.map((n, i) => [n, i])), numericOf, categoricalOf };
}

function numericValue(f: ModelFeatures, feature: string): number {
  if (feature === 'daysToJourney') return f.daysToJourney;
  if (feature === 'segmentDistPct') return f.segmentDistPct;
  if (feature === 'logCapacity') return f.logCapacity;
  return 0;
}

/** Expand one feature vector into the basis. Sparse in principle, dense here for simplicity. */
export function expand(f: ModelFeatures, layout: Layout): number[] {
  const x = new Array<number>(layout.names.length).fill(0);
  const put = (name: string, value: number): void => {
    const i = layout.index.get(name);
    if (i !== undefined) x[i] = value;
  };

  for (const feature of [...Object.keys(KNOTS), ...LINEAR_ONLY]) {
    const v = numericValue(f, feature);
    put(`${feature}@lin`, v);
    for (const k of (KNOTS[feature] ?? []).slice(1)) {
      put(`${feature}@${k}`, Math.max(0, v - k));
    }
  }

  put(FULL_RUN, f.isFullRun ? 1 : 0);
  for (const { group, of } of CATEGORICAL_GROUPS) {
    const level = of(f);
    if (level !== null && level.length > 0) put(`${group}=${level}`, 1);
  }
  return x;
}

export interface FitOptions {
  // Each is `| undefined` so a caller can forward a spread of overrides without tripping
  // exactOptionalPropertyTypes: "not supplied" and "explicitly undefined" mean the same thing here.
  /** L2 penalty. Small: the corpus is expected to be far larger than the parameter count. */
  lambda?: number | undefined;
  learningRate?: number | undefined;
  maxIterations?: number | undefined;
  /** Stop when the validation log-loss has not improved for this many iterations. */
  patience?: number | undefined;
}

export interface Fit {
  /** Weights in ORIGINAL units, indexed by `layout.names`. */
  readonly weights: readonly number[];
  readonly intercept: number;
  readonly layout: Layout;
  readonly iterations: number;
  readonly stoppedEarly: boolean;
}

function sigmoid(z: number): number {
  return z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));
}

/**
 * Fit logistic regression by full-batch gradient descent.
 *
 * Columns are scaled by their largest absolute value before fitting and the returned weights are
 * unscaled again, which keeps the optimiser well-conditioned when one column runs 0..60
 * (days-to-journey) and another runs 0..1 (segment share). Weights are returned in original units
 * so the emitted table means what `model.ts` computes.
 */
export function fitLogistic(
  trainX: readonly (readonly number[])[],
  trainY: readonly (0 | 1)[],
  layout: Layout,
  opts: FitOptions = {},
  validX?: readonly (readonly number[])[],
  validY?: readonly (0 | 1)[],
): Fit {
  const lambda = opts.lambda ?? 1e-3;
  const lr = opts.learningRate ?? 0.5;
  const maxIterations = opts.maxIterations ?? 2000;
  const patience = opts.patience ?? 60;
  const p = layout.names.length;

  const scale = new Array<number>(p).fill(1);
  for (const x of trainX) {
    for (let j = 0; j < p; j++) {
      const a = Math.abs(x[j]);
      if (a > scale[j]) scale[j] = a;
    }
  }

  let w = new Array<number>(p).fill(0);
  let b = 0;
  // Start the intercept at the log-odds of the base rate: it is the single best constant model and
  // starting there costs nothing and saves iterations when the corpus is lopsided.
  const baseRate = trainY.reduce<number>((a, y) => a + y, 0) / Math.max(1, trainY.length);
  b = Math.log(Math.max(1e-6, baseRate) / Math.max(1e-6, 1 - baseRate));

  const n = trainX.length;
  let bestValid = Number.POSITIVE_INFINITY;
  let sinceImprovement = 0;
  let iterations = 0;
  let bestW = w.slice();
  let bestB = b;
  let stoppedEarly = false;

  for (let it = 0; it < maxIterations; it++) {
    iterations = it + 1;
    const gradW = new Array<number>(p).fill(0);
    let gradB = 0;

    for (let i = 0; i < n; i++) {
      const x = trainX[i];
      let z = b;
      for (let j = 0; j < p; j++) if (x[j] !== 0) z += w[j] * (x[j] / scale[j]);
      const err = sigmoid(z) - trainY[i];
      gradB += err;
      for (let j = 0; j < p; j++) if (x[j] !== 0) gradW[j] += err * (x[j] / scale[j]);
    }

    for (let j = 0; j < p; j++) {
      w[j] -= lr * (gradW[j] / n + lambda * w[j]);
    }
    b -= lr * (gradB / n);

    if (validX && validY && validX.length > 0) {
      const vl = logLossOf(score(validX, w, b, scale), validY);
      if (vl < bestValid - 1e-7) {
        bestValid = vl;
        bestW = w.slice();
        bestB = b;
        sinceImprovement = 0;
      } else {
        sinceImprovement++;
        if (sinceImprovement >= patience) {
          w = bestW;
          b = bestB;
          stoppedEarly = true;
          break;
        }
      }
    }
  }

  // Un-scale: z = Σ w_j·(x_j/s_j) = Σ (w_j/s_j)·x_j, so the coefficient in original units is w_j/s_j.
  const weights = w.map((wj, j) => wj / scale[j]);
  for (const v of weights) {
    if (!Number.isFinite(v)) throw new Error('the fit diverged to a non-finite weight');
  }
  if (!Number.isFinite(b)) throw new Error('the fit diverged to a non-finite intercept');
  return { weights, intercept: b, layout, iterations, stoppedEarly };
}

function score(X: readonly (readonly number[])[], w: readonly number[], b: number, scale: readonly number[]): number[] {
  return X.map((x) => {
    let z = b;
    for (let j = 0; j < x.length; j++) if (x[j] !== 0) z += w[j] * (x[j] / scale[j]);
    return sigmoid(z);
  });
}

/** The linear predictor for a raw feature vector, using weights already in original units. */
export function linearPredictorOf(fit: Fit, x: readonly number[]): number {
  let z = fit.intercept;
  for (let j = 0; j < x.length; j++) z += fit.weights[j] * x[j];
  return z;
}

/** Mean log-loss. Returned as +Infinity for an empty set, so a gate can never pass it by accident. */
export function logLossOf(probs: readonly number[], labels: readonly (0 | 1)[]): number {
  if (probs.length === 0) return Number.POSITIVE_INFINITY;
  let total = 0;
  for (let i = 0; i < probs.length; i++) {
    const p = Math.min(1 - 1e-12, Math.max(1e-12, probs[i]));
    total += labels[i] === 1 ? -Math.log(p) : -Math.log(1 - p);
  }
  return total / probs.length;
}

/**
 * ROC AUC by the Mann–Whitney U statistic, with ties scored as half a win.
 *
 * Ties matter: a model that gives the same probability to a confirmed and an unconfirmed ticket has
 * genuinely failed to separate them, and counting ties as wins would flatter it.
 */
export function auc(probs: readonly number[], labels: readonly (0 | 1)[]): number {
  let positives = 0;
  for (const l of labels) positives += l;
  const negatives = labels.length - positives;
  if (positives === 0 || negatives === 0) return Number.NaN; // undefined, and the gate treats it so

  const order = probs.map((p, i) => ({ p, l: labels[i] })).sort((a, b) => a.p - b.p);
  let rankSum = 0;
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1].p === order[i].p) j++;
    // Average rank (1-based) for the tie group.
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) if (order[k].l === 1) rankSum += avgRank;
    i = j + 1;
  }
  return (rankSum - (positives * (positives + 1)) / 2) / (positives * negatives);
}

/**
 * Isotonic calibration by the pool-adjacent-violators algorithm.
 *
 * Returns [raw probability, calibrated probability] pairs in exactly the shape `model.ts` reads.
 * PAV guarantees the calibrated column is non-decreasing, which the loader independently requires —
 * so a table this function produces cannot be rejected by the runtime that consumes it.
 */
export function isotonic(probs: readonly number[], labels: readonly (0 | 1)[]): [number, number][] {
  if (probs.length === 0) return [];

  interface Block { p: number; n: number; sumY: number }

  const order = probs.map((p, i) => ({ p, y: labels[i] })).sort((a, b) => a.p - b.p);

  // Group identical probabilities first. This is not a tidy-up: the runtime loader requires bins to
  // ascend STRICTLY, because a calibration curve has to be a function of the raw probability. Two
  // blocks with the same mean raw score are two answers to one question, and PAV will not merge
  // them on its own — it only pools when a rate goes backwards, and equal rates do not. A corpus
  // with repeated feature vectors (very common: the same train, class and horizon booked by many
  // people) produces exactly that, so the ties are pooled here with their counts as weights.
  const blocks: Block[] = [];
  for (const o of order) {
    const last = blocks[blocks.length - 1];
    if (last !== undefined && last.p === o.p) {
      last.n++;
      last.sumY += o.y;
    } else {
      blocks.push({ p: o.p, n: 1, sumY: o.y });
    }
  }

  const rate = (b: Block): number => b.sumY / b.n;
  let i = 0;
  while (i < blocks.length - 1) {
    if (rate(blocks[i]) > rate(blocks[i + 1])) {
      const a = blocks[i];
      const b = blocks[i + 1];
      const merged: Block = {
        p: (a.p * a.n + b.p * b.n) / (a.n + b.n),
        n: a.n + b.n,
        sumY: a.sumY + b.sumY,
      };
      blocks.splice(i, 2, merged);
      // Step back: merging can create a new violation with the block before it.
      if (i > 0) i--;
    } else {
      i++;
    }
  }

  // A PAV merge takes a count-weighted mean, which can land on or below its neighbour's. Fold any
  // such block into the bin being emitted, weighted by count, so the result is strictly ascending
  // and every bin's calibrated value is still an empirical rate rather than an average of averages.
  const out: [number, number][] = [];
  let sumP = 0;
  let n = 0;
  let sumY = 0;
  const flush = (): void => {
    if (n > 0) out.push([sumP / n, sumY / n]);
    sumP = 0; n = 0; sumY = 0;
  };
  for (const b of blocks) {
    if (n > 0 && b.p <= sumP / n) {
      sumP += b.p * b.n;
      n += b.n;
      sumY += b.sumY;
      continue;
    }
    flush();
    sumP = b.p * b.n;
    n = b.n;
    sumY = b.sumY;
  }
  flush();
  return out;
}

/**
 * Half-width of a 90% Wilson interval for a binomial rate.
 *
 * Wilson rather than the naive normal approximation because the tails are where this is used — a
 * bin with a 2% confirmation rate is exactly where the normal approximation is worst, and an
 * interval that is too narrow there is the difference between "unlikely to confirm" and a false
 * reassurance.
 */
export function wilsonHalfWidth(positives: number, n: number, z = 1.6449): number {
  if (n <= 0) return Number.NaN;
  const p = positives / n;
  const denom = 1 + (z * z) / n;
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  // The interval is (centre ± spread) / denom; only the half-width is wanted here.
  return spread / denom;
}

/**
 * Check that a shipped term reproduces the contribution it was transcribed from.
 *
 * With the hinge basis the transcription is exact — the fitted weights *are* the coefficients — so
 * this is not bounding an approximation, it is catching a mapping bug. A coefficient attached to the
 * wrong knot produces a table that loads, validates and predicts confidently, and the only thing
 * standing between that and a traveller's screen is a check that the shipped shape and the fitted
 * function agree point by point. `maxAbsZ` should be at floating-point noise; the gate treats
 * anything larger as a defect.
 */
export function verifyTerm(
  knots: readonly number[],
  coef: readonly number[],
  contribution: (x: number) => number,
  gridPoints = 240,
): number {
  const lo = knots[0];
  const hi = knots[knots.length - 1];
  let maxAbsZ = 0;
  for (let i = 0; i <= gridPoints; i++) {
    const x = lo + ((hi - lo) * i) / gridPoints;
    const shipped = termAt({ kind: 'piecewiseLinear', knots, coef: [...coef] }, x);
    const fitted = contribution(x);
    if (!Number.isFinite(shipped) || !Number.isFinite(fitted)) {
      throw new Error('a transcribed term evaluated to a non-finite value');
    }
    const d = Math.abs(shipped - fitted);
    if (d > maxAbsZ) maxAbsZ = d;
  }
  return maxAbsZ;
}

/**
 * The single coefficient of a straight (knotless) term.
 *
 * Exact, not approximated: the contribution of a linear term is `w·x`, so evaluating it at 1
 * returns `w`.
 */
export function linearCoefficient(contribution: (x: number) => number): number {
  const c = contribution(1);
  if (!Number.isFinite(c)) throw new Error('a linear term fitted to a non-finite coefficient');
  return c;
}

/**
 * A deterministic hash of a string into [0, 1), for reproducible train/holdout splits.
 *
 * FNV-1a. Chosen over a seeded PRNG because the split then depends only on the tuple identity:
 * the same observation lands on the same side of the split across runs, across machines and across
 * corpus orderings. Shuffling by row position would leak information whenever a corpus is sorted by
 * train or by date, and a leak inflates held-out AUC in exactly the way that gets a bad model
 * shipped.
 */
export function hash01(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Unsigned, then scaled. The multiplier is a large odd prime so consecutive hashes do not cluster.
  return ((h >>> 0) % 100003) / 100003;
}

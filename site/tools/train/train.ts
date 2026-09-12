/**
 * train.ts — fit a coefficient table, or refuse to.
 *
 * The refusal half is the point. A trainer that always produces a model produces a model from
 * whatever it was given, including 400 rows, a corpus where every ticket confirmed, and labels that
 * are pure noise. All three yield a table that loads, validates and emits confident probabilities.
 * So every threshold below is a gate, and a gate that fails means `table: null` plus a report
 * explaining which measurement fell short.
 *
 * ---------------------------------------------------------------------------
 * THREE SPLITS, NOT TWO
 * ---------------------------------------------------------------------------
 * Fitting uses early stopping, which needs a validation split; reporting needs a holdout the fit
 * never saw. Using one split for both quietly optimises the reported metric — the model stops at the
 * iteration that happened to look best on the very rows used to judge it. The split is 64/16/20 by
 * a hash of the tuple key, so it is deterministic and, because it hashes identity rather than row
 * position, it cannot leak when a corpus arrives sorted by train or by date.
 *
 * ---------------------------------------------------------------------------
 * ROUND-TRIP CHECK
 * ---------------------------------------------------------------------------
 * The last gate is the one that matters most: the emitted table is fed back through `parseModel()`
 * and `linearPredictor()` — the actual runtime code — and its linear predictor is compared against
 * the fit's on every holdout row. A table can be internally consistent and still disagree with the
 * model that was fitted, because the distillation into `knots`/`coef` is an approximation and
 * because festival coefficients round-trip through `exp`/`log`. Measuring that disagreement end to
 * end is the only way to know the shipped table predicts what the trainer measured.
 */
import {
  KNOTS, LINEAR_ONLY, auc, expand, fitLogistic, hash01, isotonic, layoutOf, linearCoefficient,
  linearPredictorOf, logLossOf, verifyTerm, wilsonHalfWidth,
} from './fit';
import type { Fit, Layout } from './fit';
import { buildRows, positiveRate, type DropReason, type Observation, type TrainRow } from './corpus';
import { resolve, sep } from 'node:path';
import { parseModel, linearPredictor, type ModelCoefficients, type NumericTerm } from '../../src/availability/model';
import type { FeatureOptions, GeometryResolver } from '../../src/availability/features';

/**
 * The thresholds. Every one is a floor for "may this be shown to a traveller", not a target.
 *
 * `minAuc` at 0.60 is deliberately modest: confirmation probability is genuinely predictable but
 * far from determined, and a model that separates 60/40 is worth showing *badged as an estimate*
 * while one that separates 52/48 is not worth the risk of being believed. The docs describe
 * commercial confirmation-probability features in the same range.
 */
export const GATES = {
  minRows: 2000,
  minPositiveRate: 0.02,
  maxPositiveRate: 0.98,
  minAuc: 0.6,
  /** Maximum probability error the distillation may introduce, summed across numeric features. */
  maxDistillP: 0.03,
  /** Maximum probability error between the fitted model and the emitted table, measured end to end. */
  maxRoundTripP: 0.05,
  minBins: 5,
  /** Below this many holdout rows in a calibration bin, no interval is claimed. */
  minRowsPerBinForCi: 200,
  /** Interval width, as a two-sided 90% Wilson half-width. */
  ciZ: 1.6449,
  trainFraction: 0.64,
  validFraction: 0.16,
} as const;

export interface TrainDeps {
  resolveTrain: GeometryResolver;
  resolveStation: FeatureOptions['resolveStation'];
  /**
   * The date this training run happened, used for the table's version and provenance.
   *
   * It is deliberately NOT used to compute features: each row's `daysToJourney` counts from the
   * date that ticket was booked, which `buildRows` supplies per row. Using the run date would make
   * every historical journey look already departed.
   */
  trainedOnDate: string;
  festivals?: FeatureOptions['festivals'];
}

/**
 * Gate and tuning overrides, spelled out rather than derived from `typeof GATES`.
 *
 * `GATES` is `as const`, so `Partial<typeof GATES>` would type `minRows` as the literal `2000` and
 * refuse every caller that passes a number. Each is `| undefined` so spreading overrides cannot trip
 * `exactOptionalPropertyTypes`.
 */
export interface TrainOverrides {
  minRows?: number | undefined;
  minPositiveRate?: number | undefined;
  maxPositiveRate?: number | undefined;
  minAuc?: number | undefined;
  maxDistillP?: number | undefined;
  maxRoundTripP?: number | undefined;
  minBins?: number | undefined;
  minRowsPerBinForCi?: number | undefined;
  ciZ?: number | undefined;
  trainFraction?: number | undefined;
  validFraction?: number | undefined;
  /** Fit tuning, exposed so a large corpus can trade time for convergence. */
  maxIterations?: number | undefined;
  learningRate?: number | undefined;
  lambda?: number | undefined;
}

/**
 * Keep only the overrides that name a gate, and only those actually supplied.
 *
 * Two separate hazards. A spread of `{minRows: undefined}` over a real threshold would silently
 * disable the gate, and the fit-tuning keys (`maxIterations`, `lambda`, `learningRate`) are not
 * gates at all — they must not end up in the merged thresholds where a typo could be read as one.
 */
function definedGates(overrides: TrainOverrides): Partial<typeof GATES> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined && k in GATES) out[k] = v;
  }
  return out as Partial<typeof GATES>;
}

export interface TrainReport {
  corpusRows: number;
  usableRows: number;
  dropped: Record<DropReason, number>;
  /** Fraction of the corpus that could not be used. A model speaks only about the rest. */
  dropRate: number;
  parameters: number;
  positiveRate: number;
  trainRows: number;
  validRows: number;
  holdoutRows: number;
  auc: number;
  logLoss: number;
  /** Log-loss of a model that only knows the base rate. Beating this is the minimum claim. */
  baselineLogLoss: number;
  bins: number;
  distillMaxZ: number;
  distillMaxP: number;
  roundTripMaxZ: number;
  roundTripMaxP: number;
  ciHalfWidth: number | null;
  ciBasis: string | null;
  iterations: number;
  stoppedEarly: boolean;
  sources: string[];
  /** Empty when every gate passed. Non-empty means no table was emitted. */
  failures: string[];
}

export interface TrainResult {
  table: ModelCoefficients | null;
  report: TrainReport;
}

type Split = 'train' | 'valid' | 'holdout';

function splitOf(key: string, gates: { trainFraction: number; validFraction: number }): Split {
  const h = hash01(key);
  if (h < gates.trainFraction) return 'train';
  if (h < gates.trainFraction + gates.validFraction) return 'valid';
  return 'holdout';
}

/**
 * Train a coefficient table from a validated corpus.
 *
 * Never throws for a data problem: a corpus that is too small, too lopsided, or that produces a
 * model which cannot separate confirmed from unconfirmed tickets comes back as `table: null` with
 * the reason in `report.failures`. It does throw for a *programming* problem — a fit that diverges,
 * a singular distillation — because those are bugs and should not be reported as metrics.
 */
export function trainModel(
  corpus: readonly Observation[],
  deps: TrainDeps,
  overrides: TrainOverrides = {},
): TrainResult {
  const gates = { ...GATES, ...definedGates(overrides) };
  const failures: string[] = [];

  // No todayIso here: buildRows overrides it per row with that ticket's booking date.
  const opts: FeatureOptions = {
    resolveStation: deps.resolveStation,
    ...(deps.festivals !== undefined ? { festivals: deps.festivals } : {}),
  };
  const built = buildRows(corpus, deps.resolveTrain, opts);
  const usableRows = built.rows.length;
  const dropRate = corpus.length === 0 ? 0 : 1 - usableRows / corpus.length;

  const report: TrainReport = {
    corpusRows: corpus.length,
    usableRows,
    dropped: built.dropped,
    dropRate,
    parameters: 0,
    positiveRate: positiveRate(built.rows),
    trainRows: 0,
    validRows: 0,
    holdoutRows: 0,
    auc: Number.NaN,
    logLoss: Number.NaN,
    baselineLogLoss: Number.NaN,
    bins: 0,
    distillMaxZ: 0,
    distillMaxP: 0,
    roundTripMaxZ: 0,
    roundTripMaxP: 0,
    ciHalfWidth: null,
    ciBasis: null,
    iterations: 0,
    stoppedEarly: false,
    sources: [...new Set(corpus.map((o) => o.source ?? 'unattributed'))].sort(),
    failures,
  };

  if (usableRows < gates.minRows) {
    failures.push(
      `only ${usableRows} usable rows against a floor of ${gates.minRows}. `
      + `Dropped ${droppedSummary(built.dropped)}. A table fitted on this little data would be a `
      + 'description of the corpus rather than a model of Indian Railways.',
    );
    return { table: null, report };
  }
  if (report.positiveRate < gates.minPositiveRate || report.positiveRate > gates.maxPositiveRate) {
    failures.push(
      `${(report.positiveRate * 100).toFixed(1)}% of tickets confirmed, outside the `
      + `${(gates.minPositiveRate * 100).toFixed(0)}–${(gates.maxPositiveRate * 100).toFixed(0)}% `
      + 'the model can learn from. A corpus where everything confirms teaches nothing about '
      + 'waiting lists, and one where nothing confirms teaches nothing about availability.',
    );
    return { table: null, report };
  }

  const splits: Record<Split, TrainRow[]> = { train: [], valid: [], holdout: [] };
  for (const row of built.rows) splits[splitOf(row.key, gates)].push(row);
  report.trainRows = splits.train.length;
  report.validRows = splits.valid.length;
  report.holdoutRows = splits.holdout.length;

  if (splits.holdout.length < 100) {
    failures.push(`the holdout has only ${splits.holdout.length} rows; metrics on it would be noise.`);
    return { table: null, report };
  }

  // Fit on the training split only. The layout is derived from those rows, so a categorical level
  // that appears only in the holdout gets no coefficient and contributes nothing — the same thing
  // the runtime does with an unrecognised level, which is why the two agree.
  const layout = layoutOf(splits.train.map((r) => r.features));
  report.parameters = layout.names.length + 1;
  const trainX = splits.train.map((r) => expand(r.features, layout));
  const trainY = splits.train.map((r) => r.label);
  const validX = splits.valid.map((r) => expand(r.features, layout));
  const validY = splits.valid.map((r) => r.label);

  // Fit tuning comes straight from the overrides: it is not a gate, and keeping it out of `gates`
  // means a threshold can never be confused with a hyperparameter.
  const fit = fitLogistic(trainX, trainY, layout, {
    lambda: overrides.lambda,
    learningRate: overrides.learningRate,
    maxIterations: overrides.maxIterations,
  }, validX.length > 0 ? validX : undefined, validY.length > 0 ? validY : undefined);
  report.iterations = fit.iterations;
  report.stoppedEarly = fit.stoppedEarly;

  const holdoutX = splits.holdout.map((r) => expand(r.features, layout));
  const holdoutY = splits.holdout.map((r) => r.label);
  const holdoutZ = holdoutX.map((x) => linearPredictorOf(fit, x));
  const holdoutP = holdoutZ.map(sigmoidSafe);

  report.auc = auc(holdoutP, holdoutY);
  report.logLoss = logLossOf(holdoutP, holdoutY);
  report.baselineLogLoss = logLossOf(
    holdoutP.map(() => report.positiveRate),
    holdoutY,
  );

  if (!Number.isFinite(report.auc)) {
    failures.push('AUC is undefined on the holdout: it contains only one class.');
    return { table: null, report };
  }
  if (report.auc < gates.minAuc) {
    failures.push(
      `held-out AUC ${report.auc.toFixed(3)} is below the ${gates.minAuc.toFixed(2)} floor. This `
      + 'model cannot separate a ticket that confirmed from one that did not well enough to show '
      + 'a traveller, and a probability from it would be decoration.',
    );
    return { table: null, report };
  }
  if (report.logLoss >= report.baselineLogLoss) {
    failures.push(
      `held-out log-loss ${report.logLoss.toFixed(4)} does not beat the base-rate model `
      + `(${report.baselineLogLoss.toFixed(4)}). Ranking is better than chance but the `
      + 'probabilities are worse than saying "it confirms this often".',
    );
    return { table: null, report };
  }

  // Calibration is fitted on the validation split. Using the holdout would let the calibration
  // curve be tuned on the rows that judge it.
  const validP = validX.map((x) => sigmoidSafe(linearPredictorOf(fit, x)));
  const bins = isotonic(validP, validY);
  report.bins = bins.length;
  if (bins.length < gates.minBins) {
    failures.push(
      `isotonic calibration collapsed to ${bins.length} bins against a floor of `
      + `${gates.minBins}, which means the raw probabilities barely vary. Calibrating them would be `
      + 'fitting a curve to a point.',
    );
    return { table: null, report };
  }

  // Transcribe each numeric feature into the shipped knots/coef shape, then verify it.
  //
  // The runtime and the fit use the same hinge basis, so the fitted weights ARE the coefficients:
  // coef[0] is the linear column and coef[j] the hinge switching on at knots[j]. Nothing is
  // approximated, which is why the shipped table can be checked against the fit rather than merely
  // bounded. The verification is a bug detector: a coefficient attached to the wrong knot would
  // still load, still validate, and still predict — confidently, and wrongly.
  const numeric: Record<string, NumericTerm> = {};
  let distillMaxZ = 0;
  for (const feature of [...Object.keys(KNOTS), ...LINEAR_ONLY]) {
    const cols = columnsOf(layout, fit, feature);
    const weightOf = (name: string): number => cols.find((c) => c.name === name)?.weight ?? 0;
    const contribution = (x: number): number => {
      let total = 0;
      for (const { name, weight } of cols) {
        const knot = Number(name.slice(name.indexOf('@') + 1));
        total += weight * (name.endsWith('@lin') ? x : Math.max(0, x - knot));
      }
      return total;
    };
    const knots = KNOTS[feature];
    if (knots && knots.length >= 2) {
      const coef = knots.map((_knot, j) => (j === 0
        ? weightOf(`${feature}@lin`)
        : weightOf(`${feature}@${knots[j]}`)));
      numeric[feature] = { kind: 'piecewiseLinear', knots: [...knots], coef };
      distillMaxZ = Math.max(distillMaxZ, verifyTerm(knots, coef, contribution));
    } else {
      numeric[feature] = { kind: 'linear', coef: linearCoefficient(contribution) };
    }
  }
  report.distillMaxZ = distillMaxZ;
  // |dp/dz| <= 1/4 everywhere, so a bound on the linear predictor bounds the probability.
  report.distillMaxP = distillMaxZ / 4;
  if (report.distillMaxP > gates.maxDistillP) {
    failures.push(
      `the transcribed numeric terms disagree with the fitted ones by up to `
      + `${(report.distillMaxP * 100).toFixed(3)} probability points, above the `
      + `${(gates.maxDistillP * 100).toFixed(0)}-point ceiling. The basis is exact, so this is a `
      + 'defect in the transcription rather than an approximation, and no table is emitted.',
    );
    return { table: null, report };
  }

  // Categorical coefficients map straight across, except festivals, which the runtime reads as a
  // multiplier and therefore stores as exp(coefficient).
  const categorical: Record<string, Record<string, number>> = {};
  const festivalMultiplier: Record<string, number> = {};
  for (const [col, weight] of layout.names.map((n, i) => [n, fit.weights[i]] as const)) {
    const cat = layout.categoricalOf.get(col);
    if (cat === undefined) continue;
    const [group, level] = cat;
    if (group === 'festival') {
      festivalMultiplier[level] = Math.exp(weight);
    } else {
      (categorical[group] ??= {})[level] = weight;
    }
  }

  const table: ModelCoefficients = {
    version: `t1-${deps.trainedOnDate}`,
    trainedOn: describeCorpus(corpus, report),
    calibration: { method: 'isotonic', bins },
    intercept: fit.intercept,
    numeric,
    categorical,
    ...(Object.keys(festivalMultiplier).length > 0 ? { festivalMultiplier } : {}),
  };

  // Round-trip: the emitted table, through the runtime that will actually use it, against the fit.
  let roundTripMaxZ = 0;
  for (const row of splits.holdout) {
    const fitted = linearPredictorOf(fit, expand(row.features, layout));
    const shipped = linearPredictor(table, row.features);
    const d = Math.abs(fitted - shipped);
    if (d > roundTripMaxZ) roundTripMaxZ = d;
  }
  report.roundTripMaxZ = roundTripMaxZ;
  report.roundTripMaxP = roundTripMaxZ / 4;
  if (report.roundTripMaxP > gates.maxRoundTripP) {
    failures.push(
      `the emitted table disagrees with the fitted model by up to `
      + `${(report.roundTripMaxP * 100).toFixed(1)} probability points on the holdout, above the `
      + `${(gates.maxRoundTripP * 100).toFixed(0)}-point ceiling.`,
    );
    return { table: null, report };
  }

  // The runtime must accept what the trainer emitted. Validating here turns a build-time bug into a
  // build-time failure instead of a table that 404s the app's prediction tier for everyone.
  let validated: ModelCoefficients;
  try {
    validated = parseModel(JSON.parse(JSON.stringify(table)) as unknown);
  } catch (err) {
    failures.push(`the emitted table was rejected by the runtime loader: ${err instanceof Error ? err.message : String(err)}`);
    return { table: null, report };
  }

  // An interval is claimed only when every populated calibration bin has enough holdout rows for a
  // Wilson interval to mean something. Otherwise the honest answer is "no interval shipped", which
  // the runtime's label already says in words.
  const ci = intervalFrom(holdoutZ, holdoutY, bins, gates.minRowsPerBinForCi, gates.ciZ);
  report.ciHalfWidth = ci.halfWidth;
  report.ciBasis = ci.basis;
  if (ci.halfWidth !== null) validated = { ...validated, ciHalfWidth: ci.halfWidth };

  return { table: failures.length === 0 ? validated : null, report };
}

function sigmoidSafe(z: number): number {
  return z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));
}

function columnsOf(layout: Layout, fit: Fit, feature: string): { name: string; weight: number }[] {
  const out: { name: string; weight: number }[] = [];
  for (let i = 0; i < layout.names.length; i++) {
    if (layout.numericOf.get(layout.names[i]) === feature) {
      out.push({ name: layout.names[i], weight: fit.weights[i] });
    }
  }
  return out;
}

/**
 * Derive a 90% interval half-width from the holdout rows, per calibration bin.
 *
 * The widest bin wins, because one number has to cover all of them and quoting the narrowest would
 * understate the uncertainty exactly where the model is least sure. If any populated bin has too few
 * rows, no interval is claimed at all: a narrow interval computed from eleven tickets is not a
 * measurement.
 */
function intervalFrom(
  z: readonly number[],
  y: readonly (0 | 1)[],
  bins: readonly [number, number][],
  minRows: number,
  zScore: number,
): { halfWidth: number | null; basis: string | null } {
  const counts = bins.map(() => ({ n: 0, pos: 0 }));
  for (let i = 0; i < z.length; i++) {
    const p = sigmoidSafe(z[i]);
    let bi = 0;
    for (let b = 0; b < bins.length; b++) if (p >= bins[b][0]) bi = b;
    counts[bi].n++;
    counts[bi].pos += y[i];
  }

  let widest = 0;
  for (const c of counts) {
    if (c.n === 0) continue;
    if (c.n < minRows) {
      return {
        halfWidth: null,
        basis: `a calibration bin holds only ${c.n} holdout rows against a floor of ${minRows}`,
      };
    }
    const hw = wilsonHalfWidth(c.pos, c.n, zScore);
    if (hw > widest) widest = hw;
  }
  if (widest <= 0) return { halfWidth: null, basis: 'no populated calibration bin' };
  return {
    halfWidth: Number(widest.toFixed(4)),
    basis: `widest 90% Wilson interval across ${counts.filter((c) => c.n > 0).length} populated calibration bins on the holdout`,
  };
}

function droppedSummary(dropped: Record<DropReason, number>): string {
  const parts = Object.entries(dropped).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`);
  return parts.length === 0 ? 'nothing' : parts.join(', ');
}

function describeCorpus(corpus: readonly Observation[], report: TrainReport): string {
  const sources = report.sources.length > 0 ? report.sources.join(' + ') : 'unattributed';
  const span = corpus.length > 0
    ? `${corpus.map((o) => o.dateIso).sort()[0]}..${corpus.map((o) => o.dateIso).sort()[corpus.length - 1]}`
    : 'no dates';
  return `${sources} · ${report.corpusRows} rows · ${report.usableRows} usable · journeys ${span}`;
}

/**
 * Serialise an emitted table.
 *
 * Refuses when a gate failed, so there is no code path that writes a model the report says should
 * not ship. The JSON is sorted-key stable so two runs on one corpus produce identical bytes and a
 * diff shows only real changes.
 */
export function emitModelJson(result: TrainResult): string {
  if (result.table === null) {
    throw new Error(`refusing to emit a model: ${result.report.failures.join(' | ')}`);
  }
  return `${JSON.stringify(result.table, sortedReplacer, 2)}\n`;
}

function sortedReplacer(this: unknown, _key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = (value as Record<string, unknown>)[k];
    }
    return out;
  }
  return value;
}

/**
 * Is this output path inside the directory the deployed site serves?
 *
 * The check is a path-prefix test on resolved paths with a separator boundary, so
 * `public/database/x.json` is not mistaken for being inside `public/data`. Getting that wrong in
 * either direction is bad: a false negative lets a model be written into the served directory
 * without `--ship`, and a false positive blocks a legitimate output path.
 */
export function isServedDataPath(outPath: string, dataDir: string): boolean {
  const a = resolve(outPath);
  const b = resolve(dataDir);
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
}

/**
 * Render a training report as text.
 *
 * Returned rather than printed, so a test can assert on what a maintainer would read — in
 * particular that a refused run says *which* gate failed, in numbers, rather than just "failed".
 */
export function formatReport(report: TrainReport): string {
  const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
  const num = (n: number): string => (Number.isFinite(n) ? n.toFixed(4) : 'undefined');
  const lines = [
    `corpus           ${report.corpusRows} rows, ${report.usableRows} usable (${pct(report.dropRate)} dropped)`,
    `dropped          ${JSON.stringify(report.dropped)}`,
    `splits           ${report.trainRows} train / ${report.validRows} valid / ${report.holdoutRows} holdout`,
    `parameters       ${report.parameters}`,
    `confirmed rate   ${pct(report.positiveRate)}`,
    `holdout AUC      ${num(report.auc)}`,
    `holdout log-loss ${num(report.logLoss)} (base rate ${num(report.baselineLogLoss)})`,
    `calibration bins ${report.bins}`,
    `distil error     <= ${pct(report.distillMaxP)} probability points`,
    `round-trip error <= ${pct(report.roundTripMaxP)} probability points`,
    `90% interval     ${report.ciHalfWidth === null
      ? `not claimed (${report.ciBasis ?? 'no basis'})`
      : `±${pct(report.ciHalfWidth)} — ${report.ciBasis}`}`,
    `sources          ${report.sources.join(', ')}`,
  ];
  if (report.failures.length > 0) {
    lines.push('', 'REFUSED:');
    for (const f of report.failures) lines.push(`  - ${f}`);
  }
  return lines.join('\n');
}

/**
 * model.test.ts — Tier 1 inference: the arithmetic, and the refusals.
 *
 * The arithmetic tests matter less than the refusal tests. A model runtime that is slightly wrong
 * about interpolation produces a slightly wrong probability; a model runtime that happily turns a
 * malformed coefficient table into `NaN` produces a screen that says "NaN% likely to confirm", and
 * one that invents a confidence interval produces a number that looks measured and is not.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import {
  PREDICTED_BADGE,
  ModelFormatError,
  calibrate,
  linearPredictor,
  parseModel,
  predict,
  predictionLabel,
  predictionText,
  sigmoid,
  termAt,
  tier1Source,
} from '../src/availability/model';
import type { ModelCoefficients, ModelFeatures } from '../src/availability/model';
import type { AvailabilityQuery } from '../src/availability/tier';

/** A synthetic table with numbers chosen so each term is easy to follow by hand. */
const TABLE = {
  version: 'test-v1',
  trainedOn: '2026-01-01',
  intercept: -1,
  numeric: {
    daysToJourney: { kind: 'piecewiseLinear', knots: [0, 30, 60], coef: [0.02, 0.01, 0] },
    segmentDistPct: { kind: 'linear', coef: 1.5 },
    logCapacity: { kind: 'linear', coef: 0.25 },
  },
  categorical: {
    class: { SL: 0.4, '3A': -0.2 },
    quota: { GN: 0.3 },
    trainType: { SUPERFAST: 0.1 },
    dow: { Mon: 0.05, Fri: -0.15 },
    segment: { full: 0.5 },
  },
  festivalMultiplier: { DIWALI: 1.8 },
  calibration: {
    method: 'isotonic',
    bins: [[0, 0.02], [0.25, 0.2], [0.5, 0.5], [0.75, 0.8], [1, 0.97]],
  },
  ciHalfWidth: 0.08,
};

const FEATURES: ModelFeatures = {
  daysToJourney: 20,
  segmentDistPct: 0.5,
  logCapacity: Math.log(72), // SL on an LHB rake, per Tier 0
  isFullRun: true,
  klass: 'SL',
  quota: 'GN',
  trainType: 'SUPERFAST',
  dow: 'Mon',
  festival: null,
};

const QUERY: AvailabilityQuery = {
  trainNumber: '12951', board: 'MMCT', alight: 'NDLS',
  dateIso: '2026-10-02', klass: 'SL', quota: 'GN',
};

const model = (): ModelCoefficients => parseModel(TABLE);

describe('the loader refuses a table it cannot run', () => {
  it('accepts a well-formed table and keeps every field', () => {
    const m = model();
    expect(m.version).toBe('test-v1');
    expect(m.intercept).toBe(-1);
    expect(m.calibration.bins).toHaveLength(5);
    expect(m.ciHalfWidth).toBe(0.08);
  });

  /**
   * A deliberately loose shape for a table on the way to being rejected. The whole point of these
   * cases is that the value is wrong — wrong type, wrong length, missing — so a precise type would
   * make them unrepresentable and the test would be checking the compiler instead of the loader.
   */
  type TableDraft = {
    intercept: number;
    // `coef` is unknown because one of the cases below sets it to a string, and that is the point.
    numeric: Record<string, { kind: string; coef?: unknown; knots?: number[] }>;
    categorical: Record<string, Record<string, number | string | null>>;
    festivalMultiplier: Record<string, number | string>;
    calibration: { method: string; bins: unknown[] };
  };

  it.each([
    ['a non-finite intercept', (t: TableDraft) => { t.intercept = Number.NaN; }],
    ['a coefficient that is a string', (t: TableDraft) => { t.numeric.segmentDistPct.coef = '1.5'; }],
    ['a coefficient that is null', (t: TableDraft) => { t.categorical.class.SL = null; }],
    ['a missing knots array', (t: TableDraft) => { delete t.numeric.daysToJourney.knots; }],
    ['knots and coefficients of different length', (t: TableDraft) => { t.numeric.daysToJourney.coef = [0.02, 0.01]; }],
    ['knots that are not increasing', (t: TableDraft) => { t.numeric.daysToJourney.knots = [0, 30, 30]; }],
    ['an unknown term kind', (t: TableDraft) => { t.numeric.logCapacity.kind = 'polynomial'; }],
    ['a calibration probability above 1', (t: TableDraft) => { t.calibration.bins = [[0, 0.2], [0.5, 1.4]]; }],
    ['bins that do not ascend', (t: TableDraft) => { t.calibration.bins = [[0.5, 0.5], [0.25, 0.2]]; }],
    ['a calibration curve that goes backwards', (t: TableDraft) => { t.calibration.bins = [[0.25, 0.6], [0.5, 0.4]]; }],
    ['an empty isotonic curve', (t: TableDraft) => { t.calibration.bins = []; }],
    ['an unsupported calibration method', (t: TableDraft) => { t.calibration.method = 'platt'; }],
    ['a festival multiplier that is not a number', (t: TableDraft) => { t.festivalMultiplier.DIWALI = 'high'; }],
  ])('rejects %s', (_label, mutate) => {
    const broken = JSON.parse(JSON.stringify(TABLE));
    mutate(broken);
    expect(() => parseModel(broken)).toThrow(ModelFormatError);
  });

  it('names the exact path in the error, so the table can be fixed rather than guessed at', () => {
    const broken = JSON.parse(JSON.stringify(TABLE)) as TableDraft;
    broken.numeric.daysToJourney.coef = [0.02, 0.01];
    expect(() => parseModel(broken)).toThrow(/model\.numeric\.daysToJourney has 3 knots but 2 coefficients/);
  });

  it('loads the exact table specified in docs/01 §9, unknown keys included', () => {
    // Pinning the runtime to the documented format rather than to a table this file invented. If
    // the two ever diverge, this is what fails — not a traveller's screen, months later.
    const documented = {
      version: '2026.09',
      trainedOn: 'kaggle-irctc-2023-10 + heuristics',
      calibration: { method: 'isotonic', bins: [[0.02, 0.05], [0.05, 0.12]] },
      intercept: -1.83,
      numeric: {
        daysToJourney: {
          kind: 'piecewiseLinear',
          knots: [0, 1, 3, 7, 15, 30, 60],
          coef: [-0.42, -0.31, -0.18, -0.09, -0.03, 0.01, 0.02],
        },
        segmentDistPct: {
          kind: 'piecewiseLinear',
          knots: [0, 0.15, 0.4, 0.7, 1.0],
          coef: [-1.15, -0.62, -0.18, 0.09, 0.34],
        },
        logCapacity: { kind: 'linear', coef: -0.21 },
      },
      categorical: {
        class: { SL: 0.0, '3A': -0.18, '2A': -0.74, '1A': -1.62, CC: -0.31, EC: -0.88, '2S': 0.95 },
        quota: { GN: 0.0, TQ: -0.55, PT: -0.3, LD: -0.95, SS: -1.1 },
        trainType: { VNDB: -0.62, DRNT: -0.88, RAJ: -0.95, SHB: -0.71, SUF: 0.0, MEX: 0.24, SUB: 1.05 },
        dow: { Mon: 0.22, Tue: -0.05, Wed: -0.09, Thu: 0.03, Fri: 0.41, Sat: 0.11, Sun: 0.35 },
      },
      festivalMultiplier: { chhath: 2.8, diwali: 2.4, durgaPuja: 2.1, eid: 1.7, holi: 1.6 },
      // Not implemented by this runtime. It must be ignored, not rejected: a table shipped for a
      // later version should still load, with the parts we cannot use simply unused.
      wlClearanceCurveByCapacity: '…',
    };
    const m = parseModel(documented);
    expect(m.version).toBe('2026.09');
    expect(m.numeric.daysToJourney.kind).toBe('piecewiseLinear');
    expect(m.ciHalfWidth, 'the documented table ships no interval').toBeUndefined();
    // And it runs, on a Chhath-eve Delhi to Patna sleeper ticket.
    const p = predict(m, {
      daysToJourney: 6, segmentDistPct: 0.85, logCapacity: Math.log(72), isFullRun: false,
      klass: 'SL', quota: 'GN', trainType: 'SUF', dow: 'Fri', festival: 'chhath',
    });
    expect(p).not.toBeNull();
    expect(p!.pConfirmCI, 'no interval was shipped, so none may be claimed').toBeNull();
  });

  it('refuses something that is not an object at all', () => {
    expect(() => parseModel(null)).toThrow(ModelFormatError);
    expect(() => parseModel('{"version":"x"}')).toThrow(ModelFormatError);
  });
});

describe('the arithmetic', () => {
  it('adds each hinge at its own knot, which is what makes the shipped table exact', () => {
    // knots [0,30,60], coef [0.02, 0.01, 0]: slope 0.02 to day 30, then 0.03, then 0.03.
    const term = model().numeric.daysToJourney;
    expect(termAt(term, 0)).toBe(0);
    expect(termAt(term, 15)).toBeCloseTo(0.02 * 15, 12);
    expect(termAt(term, 30)).toBeCloseTo(0.02 * 30, 12);
    // Past day 30 the second coefficient switches on and applies only to the excess.
    expect(termAt(term, 45)).toBeCloseTo(0.02 * 45 + 0.01 * 15, 12);
    // The third coefficient is zero, so the slope stops changing at day 60.
    expect(termAt(term, 60)).toBeCloseTo(0.02 * 60 + 0.01 * 30, 12);
  });

  it('is continuous at every knot, so no term can jump', () => {
    const term = model().numeric.daysToJourney;
    for (const k of [0, 30, 60]) {
      const below = termAt(term, k - 1e-9);
      const above = termAt(term, k + 1e-9);
      expect(Math.abs(above - below)).toBeLessThan(1e-7);
    }
  });

  it('handles a linear term', () => {
    expect(termAt({ kind: 'linear', coef: 1.5 }, 0.5)).toBe(0.75);
  });

  it('does not overflow at extreme inputs', () => {
    expect(sigmoid(1000)).toBe(1);
    expect(sigmoid(-1000)).toBe(0);
    expect(sigmoid(0)).toBe(0.5);
    expect(Number.isNaN(sigmoid(Number.NaN))).toBe(true);
  });

  it('sums the intercept, the numeric terms and the categorical levels', () => {
    const m = model();
    const z = linearPredictor(m, FEATURES);
    const expected = -1
      + termAt(m.numeric.daysToJourney, 20)
      + 1.5 * 0.5
      + 0.25 * Math.log(72)
      + 0.4 + 0.3 + 0.1 + 0.05   // class, quota, trainType, dow
      + 0.5;                     // full run
    expect(z).toBeCloseTo(expected, 12);
    expect(Number.isFinite(z)).toBe(true);
  });

  it('adds nothing for a categorical level the model has never seen', () => {
    // A new train type or a class code outside the training set is normal in a dataset that
    // changes. Degrading to the intercept is the honest response; NaN would be a crash the
    // traveller sees as a broken screen.
    const z = linearPredictor(model(), { ...FEATURES, trainType: 'VANDE_BHARAT', klass: 'EC' });
    const withoutThem = model().intercept
      + termAt(model().numeric.daysToJourney, 20) + 0.75 + 0.25 * Math.log(72)
      + 0.3 + 0.05 + 0.5; // quota, dow and full run still apply
    expect(z).toBeCloseTo(withoutThem, 12);
    expect(Number.isFinite(z)).toBe(true);
  });

  it('applies the full-run bonus only when the segment is the full run', () => {
    const full = linearPredictor(model(), { ...FEATURES, isFullRun: true });
    const part = linearPredictor(model(), { ...FEATURES, isFullRun: false });
    expect(full - part).toBeCloseTo(0.5, 12);
  });

  it('turns a festival multiplier into a log-odds shift', () => {
    const plain = linearPredictor(model(), FEATURES);
    const festive = linearPredictor(model(), { ...FEATURES, festival: 'DIWALI' });
    expect(festive - plain).toBeCloseTo(Math.log(1.8), 12);
  });

  it('ignores a numeric feature the table asks for but we do not compute', () => {
    const m = parseModel({ ...TABLE, numeric: { ...TABLE.numeric, unmodelledFeature: { kind: 'linear', coef: 2 } } });
    expect(Number.isFinite(linearPredictor(m, FEATURES))).toBe(true);
  });

  it('calibrates monotonically, and clamps at the ends', () => {
    const m = model();
    let previous = -1;
    for (let i = 0; i <= 100; i++) {
      const raw = i / 100;
      const c = calibrate(m, raw);
      expect(c).toBeGreaterThanOrEqual(previous);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1);
      previous = c;
    }
    expect(calibrate(m, 0)).toBe(0.02);
    expect(calibrate(m, 1)).toBe(0.97);
  });

  it('passes the raw probability through when the table says there is no calibration', () => {
    const m = parseModel({ ...TABLE, calibration: { method: 'none', bins: [] } });
    expect(calibrate(m, 0.4242)).toBe(0.4242);
  });
});

describe('inference', () => {
  it('returns a probability inside [0,1]', () => {
    const p = predict(model(), FEATURES);
    expect(p).not.toBeNull();
    expect(p!.pConfirm).toBeGreaterThanOrEqual(0);
    expect(p!.pConfirm).toBeLessThanOrEqual(1);
    expect(p!.modelVersion).toBe('test-v1');
  });

  it('moves in the direction the coefficients say it should', () => {
    // Not a claim about Indian railways — a check that the runtime reads its own table.
    const m = model();
    const near = predict(m, { ...FEATURES, daysToJourney: 5 })!;
    const far = predict(m, { ...FEATURES, daysToJourney: 28 })!;
    expect(far.pConfirm).toBeGreaterThan(near.pConfirm);

    const whole = predict(m, { ...FEATURES, segmentDistPct: 1 })!;
    const hop = predict(m, { ...FEATURES, segmentDistPct: 0.1 })!;
    expect(whole.pConfirm).toBeGreaterThan(hop.pConfirm);
  });

  it('declines rather than emitting a probability when a feature is not a number', () => {
    expect(predict(model(), { ...FEATURES, daysToJourney: Number.NaN })).toBeNull();
    expect(predict(model(), { ...FEATURES, logCapacity: Number.POSITIVE_INFINITY })).toBeNull();
  });

  it('reports an interval only when the table shipped one', () => {
    const withCi = predict(model(), FEATURES)!;
    expect(withCi.pConfirmCI).not.toBeNull();
    expect(withCi.pConfirmCI![0]).toBeLessThan(withCi.pConfirmCI![1]);

    const noCi = parseModel(JSON.parse(JSON.stringify({ ...TABLE, ciHalfWidth: undefined })));
    expect(predict(noCi, FEATURES)!.pConfirmCI).toBeNull();
  });

  it('never clips an interval outside [0,1]', () => {
    const m = parseModel({ ...TABLE, ciHalfWidth: 0.9 });
    const p = predict(m, { ...FEATURES, segmentDistPct: 1, klass: 'SL' })!;
    expect(p.pConfirmCI![0]).toBeGreaterThanOrEqual(0);
    expect(p.pConfirmCI![1]).toBeLessThanOrEqual(1);
  });

  it('does not invent the parts of the distribution it cannot derive', () => {
    // docs/01 asks for pRac and expectedWl. A single logistic head cannot produce them, and a
    // plausible-looking guess would be indistinguishable from a measurement on screen.
    const p = predict(model(), FEATURES)!;
    expect(p.pRac).toBeNull();
    expect(p.expectedWl).toBeNull();
  });
});

describe('Tier 1 in the cascade', () => {
  it('reports itself unavailable when no model has been shipped', async () => {
    const source = tier1Source(null, () => FEATURES);
    expect(source.available()).toBe(false);
    expect(await source.lookup(QUERY)).toBeNull();
  });

  it('is available and answers once a model exists', async () => {
    const source = tier1Source(model(), () => FEATURES);
    expect(source.id).toBe('T1');
    expect(source.available()).toBe(true);
    const reading = await source.lookup(QUERY);
    expect(reading).not.toBeNull();
    expect(reading!.source).toBe('PREDICTED');
    expect(reading!.tier).toBe('T1');
    expect(reading!.prediction).not.toBeNull();
  });

  it('keeps the verdict UNKNOWN, because a probability about a berth is not a berth', async () => {
    const reading = (await tier1Source(model(), () => FEATURES).lookup(QUERY))!;
    expect(reading.status.verdict).toBe('UNKNOWN');
    expect(reading.status.parsed, 'nothing was parsed, so nothing may claim to be').toBe(false);
    expect(reading.status.seats).toBeUndefined();
    expect(reading.asOf).toBeNull();
    expect(reading.ageSeconds).toBeNull();
  });

  it('declines when features cannot be built for a query', async () => {
    const source = tier1Source(model(), () => null);
    expect(await source.lookup(QUERY)).toBeNull();
  });

  it('puts the badge in the explanation, and the label leads with it', async () => {
    const reading = (await tier1Source(model(), () => FEATURES).lookup(QUERY))!;
    expect(reading.explanation.startsWith(PREDICTED_BADGE)).toBe(true);
    expect(predictionLabel(reading.prediction!).startsWith(PREDICTED_BADGE)).toBe(true);
    expect(predictionLabel(reading.prediction!)).toMatch(/likely to confirm/);
    expect(predictionLabel(reading.prediction!)).toMatch(/not a live seat count/);
  });

  it('offers the same words without the badge, for UIs that render the badge separately', () => {
    const p = predict(model(), FEATURES)!;
    expect(predictionText(p).startsWith(PREDICTED_BADGE)).toBe(false);
    expect(predictionLabel(p)).toBe(`${PREDICTED_BADGE}: ${predictionText(p)}`);
    // Whichever form is used, the estimate must still say what it is not.
    expect(predictionText(p)).toMatch(/not a live seat count/);
  });

  it('says so plainly when no interval shipped, rather than leaving a bare number', () => {
    const m = parseModel(TABLE);
    delete (m as { ciHalfWidth?: number }).ciHalfWidth;
    const p = predict(m, FEATURES)!;
    expect(predictionLabel(p)).toMatch(/no interval shipped/i);
  });
});

describe('the badge invariant, policed against the source rather than against a fixture', () => {
  it('no UI file may mention a prediction without mentioning the badge', () => {
    // docs/01 makes "no code path renders PREDICTED without its badge" non-negotiable. A test that
    // checks a rendered fixture only covers the fixture that exists today; this one fails the build
    // the moment someone adds a panel that shows pConfirm and forgets where it came from. Nothing
    // renders a prediction yet, so it passes now — which is exactly when a guard like this is worth
    // having.
    // Resolved from the vitest root rather than from import.meta.url: under this transform
    // import.meta.url is not a file: URL, and a guard that crashes is a guard nobody keeps.
    const uiDir = join(process.cwd(), 'src', 'ui');
    expect(existsSync(uiDir), `expected the UI source at ${uiDir}`).toBe(true);
    const offenders: string[] = [];
    for (const entry of readdirSync(uiDir)) {
      if (!entry.endsWith('.tsx') && !entry.endsWith('.ts')) continue;
      const src = readFileSync(join(uiDir, entry), 'utf8');
      const talksAboutPrediction = /pConfirm|predictionLabel|predictionText|\bprediction\b/.test(src);
      const carriesTheBadge = src.includes('PREDICTED_BADGE');
      if (talksAboutPrediction && !carriesTheBadge) offenders.push(entry);
    }
    expect(offenders, 'these UI files show a prediction without importing the badge').toEqual([]);
  });
});

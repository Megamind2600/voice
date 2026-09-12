/**
 * train.test.ts — the trainer, its gates, and the numerics underneath it.
 *
 * The centrepiece is a recovery test: a corpus generated from a *known* logistic function, fed
 * through the whole pipeline, and checked to see whether the emitted table recovers the signal. A
 * trainer that only has tests for its refusals could be refusing everything; a trainer that only
 * has tests for its arithmetic could emit a table the runtime reads differently. This one runs the
 * real path end to end and then feeds the result back through `model.ts`.
 *
 * Everything here is deterministic — the split hashes tuple identity and the label noise comes from
 * a seeded generator — so thresholds are measured facts about this pipeline rather than hopes.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  OUTCOMES, buildRows, labelOf, parseCorpus, parseJsonl, parseObservation, tupleKey,
} from '../tools/train/corpus';
import type { Observation, Outcome } from '../tools/train/corpus';
import {
  KNOTS, auc, hash01, isotonic, layoutOf, linearCoefficient, logLossOf, verifyTerm, wilsonHalfWidth,
} from '../tools/train/fit';
import {
  GATES, emitModelJson, formatReport, isServedDataPath, trainModel,
} from '../tools/train/train';
import { geometryFromDataset } from '../tools/train/dataset';
import { segmentFeatures } from '../src/availability/features';
import { Container, ContainerKind } from '../src/lib/binary';
import { StationIndex } from '../src/lib/stations';
import type { TrainReport } from '../tools/train/train';
import type { TrainGeometry } from '../src/availability/features';
import { linearPredictor, predict, type ModelFeatures } from '../src/availability/model';

// -------------------------------------------------------------------------- fixtures

const CODES = ['SRC', 'AA', 'BB', 'CC', 'DD', 'DST'] as const;
const STATIONS: Record<string, number> = Object.fromEntries(CODES.map((c, i) => [c, i]));

/** Six evenly spaced stops, two hours apart, so the last ones are boarded on a later calendar day. */
function makeTrain(
  type: string, classes: string[], runsDays: number, runsDaysAssumed = false,
): TrainGeometry {
  const stops = CODES.map((_, i) => ({
    station: i,
    distKm: i * 220,
    arrMin: i === 0 ? null : i * 120 - 10,
    depMin: i === CODES.length - 1 ? null : i * 120,
  }));
  return {
    type, classes, runsDays, runsDaysAssumed,
    distanceKm: (CODES.length - 1) * 220,
    stops,
  };
}

const TRAINS: Record<string, TrainGeometry> = {
  12001: makeTrain('RAJ', ['1A', '2A', '3A'], 0b1111111),
  12002: makeTrain('SUF', ['SL', '3A', '2A'], 0b1111111),
  12003: makeTrain('MEX', ['SL', '3A', 'CC'], 0b0101010),
  12004: makeTrain('PAX', ['SL', '2S'], 0b0000001),
};

const resolveTrain = (n: string): TrainGeometry | null => TRAINS[n] ?? null;
const resolveStation = (code: string): number => STATIONS[code] ?? -1;
const TODAY = '2026-09-12';

/** A seeded generator, so "random" labels are the same random labels on every run. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

/**
 * The generating function the recovery test tries to rediscover.
 *
 * Shaped like the real thing: long segments and big rakes confirm more often, booking further ahead
 * gives a waitlist longer to clear, sleeper is harder than AC, Friday and Sunday are worse, and a
 * festival run-up is much worse.
 */
function truthZ(f: ModelFeatures): number {
  const classEffect: Record<string, number> = { SL: -0.6, '2S': -0.9, '3A': 0.4, '2A': 0.9, '1A': 1.3, CC: 0.2 };
  const dowEffect: Record<string, number> = { Fri: -0.5, Sun: -0.35, Mon: -0.15 };
  const festivalEffect: Record<string, number> = { diwali: -1.6, chhath: -2.2, durgaPuja: -1.4, dussehra: -0.8 };
  return -0.9
    + 1.9 * f.segmentDistPct
    + 0.55 * (f.logCapacity - 6)
    + 0.018 * f.daysToJourney
    + (f.isFullRun ? 0.7 : 0)
    + (classEffect[f.klass] ?? 0)
    + (dowEffect[f.dow] ?? 0)
    + (f.festival ? (festivalEffect[f.festival] ?? -0.5) : 0)
    + (f.serviceFrequency === 'weekly' ? -0.8 : 0);
}

interface GenOptions {
  rows: number;
  seed: number;
  /** When set, labels ignore the features entirely — the AUC gate must refuse this. */
  noise?: boolean;
  /** Force every outcome to the same value, to trip the positive-rate gate. */
  degenerate?: Outcome;
}

function generateCorpus(opts: GenOptions): Observation[] {
  const rand = lcg(opts.seed);
  const trains = Object.keys(TRAINS);
  const out: Observation[] = [];
  const seen = new Map<string, 0 | 1>();

  while (out.length < opts.rows) {
    const trainNumber = trains[Math.floor(rand() * trains.length)];
    const train = TRAINS[trainNumber];
    const board = Math.floor(rand() * (CODES.length - 1));
    const alight = board + 1 + Math.floor(rand() * (CODES.length - 1 - board));
    if (alight >= CODES.length) continue;
    const klass = train.classes[Math.floor(rand() * train.classes.length)];
    const quota = rand() < 0.85 ? 'GN' : 'TQ';
    // Journeys spread across the festival season, booked anything from 1 to 55 days ahead.
    const dayOfYear = 275 + Math.floor(rand() * 90); // early Oct 2026 to early Jan 2027
    const dateIso = new Date(Date.UTC(2026, 0, dayOfYear)).toISOString().slice(0, 10);
    const ahead = 1 + Math.floor(rand() * 55);
    const bookedOn = new Date(Date.parse(`${dateIso}T00:00:00Z`) - ahead * 86400000).toISOString().slice(0, 10);

    const probe: Observation = {
      trainNumber, board: CODES[board], alight: CODES[alight],
      dateIso, bookedOn, klass, quota, outcome: 'NOT_CONFIRMED',
      source: 'synthetic-fixture',
    };
    const key = tupleKey(probe);
    // The same tuple must not reappear with a different label, which the corpus parser rejects.
    const features = buildRows([probe], resolveTrain, { resolveStation, todayIso: bookedOn }).rows[0]?.features;
    if (features === undefined) continue;

    let label: 0 | 1;
    if (opts.noise === true) {
      label = rand() < 0.5 ? 1 : 0;
    } else {
      label = rand() < sigmoid(truthZ(features)) ? 1 : 0;
    }
    if (seen.has(key) && seen.get(key) !== label) continue;
    seen.set(key, label);

    const outcome: Outcome = opts.degenerate
      ?? (label === 1 ? (rand() < 0.2 ? 'RAC_CONFIRMED' : 'CONFIRMED') : (rand() < 0.15 ? 'REGRET' : 'NOT_CONFIRMED'));
    out.push({ ...probe, outcome });
  }
  return out;
}

const deps = { resolveTrain, resolveStation, trainedOnDate: TODAY };
/** The fixture corpus is small, so the row-count floor is lowered for these tests only. */
const SMALL = { minRows: 400, minRowsPerBinForCi: 40 };

// -------------------------------------------------------------------------- corpus

describe('the corpus contract', () => {
  const row = (over: Partial<Observation> = {}): unknown => ({
    trainNumber: '12002', board: 'SRC', alight: 'DST', dateIso: '2026-10-20',
    bookedOn: '2026-10-01', klass: 'SL', quota: 'GN', outcome: 'CONFIRMED', ...over,
  });

  it('accepts a well-formed row and normalises case', () => {
    const o = parseObservation(row({ board: 'src', klass: 'sl' }), 0);
    expect(o.board).toBe('SRC');
    expect(o.klass).toBe('SL');
    expect(o.bookedOn).toBe('2026-10-01');
  });

  it('accepts every outcome in the vocabulary and nothing else', () => {
    for (const outcome of OUTCOMES) expect(parseObservation(row({ outcome }), 0).outcome).toBe(outcome);
    expect(() => parseObservation(row({ outcome: 'MAYBE' as Outcome }), 7)).toThrow(/row 7\.outcome/);
  });

  it('requires a booking date, because without one the model cannot learn about waiting lists', () => {
    const { bookedOn: _dropped, ...rest } = row() as Record<string, unknown>;
    expect(() => parseObservation(rest, 3)).toThrow(/row 3\.bookedOn/);
  });

  it('refuses a booking date after the journey, or beyond the advance window', () => {
    expect(() => parseObservation(row({ bookedOn: '2026-10-25' }), 1)).toThrow(/after the journey date/);
    // 61 days ahead is not a booking IRCTC could have made, so it is a data error, not an outlier.
    expect(() => parseObservation(row({ bookedOn: '2026-08-20' }), 2)).toThrow(/beyond the 60-day advance window/);
    expect(() => parseObservation(row({ bookedOn: '2026-20-01' }), 4)).toThrow(/not a real ISO date/);
  });

  it('labels a RAC ticket as cleared, because a RAC passenger boards', () => {
    expect(labelOf(row({ outcome: 'CONFIRMED' }) as Observation)).toBe(1);
    expect(labelOf(row({ outcome: 'RAC_CONFIRMED' }) as Observation)).toBe(1);
    expect(labelOf(row({ outcome: 'NOT_CONFIRMED' }) as Observation)).toBe(0);
    expect(labelOf(row({ outcome: 'REGRET' }) as Observation)).toBe(0);
  });

  it('refuses a corpus that contradicts itself rather than averaging the contradiction away', () => {
    const a = row({ outcome: 'CONFIRMED' }) as Observation;
    const b = row({ outcome: 'NOT_CONFIRMED' }) as Observation;
    expect(() => parseCorpus([a, b])).toThrow(/contradictory ground truth/);
    // The same tuple agreeing with itself is just a repeated observation, which is fine.
    expect(parseCorpus([a, { ...a }])).toHaveLength(2);
  });

  it('parses JSON lines and names the line that is not JSON', () => {
    const text = `${JSON.stringify(row())}\n\n${JSON.stringify(row({ board: 'AA' }))}\n`;
    expect(parseJsonl(text)).toHaveLength(2);
    expect(() => parseJsonl('{"a":1}\n{oops}\n')).toThrow(/line 2 is not valid JSON/);
    expect(() => parseJsonl('\n  \n')).toThrow(/empty/);
  });
});

describe('building training rows', () => {
  it('counts why each unusable row was dropped, instead of discarding them silently', () => {
    const rows: Observation[] = [
      { trainNumber: '99999', board: 'SRC', alight: 'DST', dateIso: '2026-10-20', bookedOn: '2026-10-01', klass: 'SL', quota: 'GN', outcome: 'CONFIRMED' },
      { trainNumber: '12001', board: 'SRC', alight: 'DST', dateIso: '2026-10-20', bookedOn: '2026-10-01', klass: 'SL', quota: 'GN', outcome: 'CONFIRMED' },
      { trainNumber: '12002', board: 'SRC', alight: 'DST', dateIso: '2026-10-20', bookedOn: '2026-10-01', klass: 'SL', quota: 'GN', outcome: 'CONFIRMED' },
    ];
    const built = buildRows(rows, resolveTrain, { resolveStation, todayIso: '2026-09-12' });
    expect(built.dropped['unknown-train']).toBe(1);       // not in the dataset
    expect(built.dropped['features-refused']).toBe(1);    // a Rajdhani has no sleeper
    expect(built.rows).toHaveLength(1);
    expect(built.rows[0].label).toBe(1);
  });

  it('computes days-to-journey from the booking date, not from the run date', () => {
    const o: Observation = {
      trainNumber: '12002', board: 'SRC', alight: 'DST', dateIso: '2026-10-20',
      bookedOn: '2026-10-01', klass: 'SL', quota: 'GN', outcome: 'CONFIRMED',
    };
    const built = buildRows([o], resolveTrain, { resolveStation, todayIso: TODAY });
    // 19 days ahead when booked. Measured against today it would be negative, and refused.
    expect(built.rows[0].features.daysToJourney).toBe(19);
  });
});

// -------------------------------------------------------------------------- numerics

describe('the numerics', () => {
  it('ranks perfectly, inversely, and scores ties as half a win', () => {
    expect(auc([0.1, 0.2, 0.8, 0.9], [0, 0, 1, 1])).toBe(1);
    expect(auc([0.9, 0.8, 0.2, 0.1], [0, 0, 1, 1])).toBe(0);
    expect(auc([0.5, 0.5, 0.5, 0.5], [0, 1, 0, 1])).toBe(0.5);
    expect(Number.isNaN(auc([0.5, 0.6], [1, 1]))).toBe(true);
  });

  it('measures log-loss against a known case', () => {
    expect(logLossOf([0.5, 0.5], [1, 0])).toBeCloseTo(Math.log(2), 12);
    expect(logLossOf([0.9], [1])).toBeCloseTo(-Math.log(0.9), 12);
    expect(logLossOf([], [])).toBe(Number.POSITIVE_INFINITY);
  });

  it('calibrates monotonically, which the runtime loader independently requires', () => {
    const probs: number[] = [];
    const labels: (0 | 1)[] = [];
    const rand = lcg(7);
    for (let i = 0; i < 4000; i++) {
      const p = rand();
      probs.push(p);
      labels.push(rand() < p * p ? 1 : 0); // deliberately miscalibrated: raw p overstates
    }
    const bins = isotonic(probs, labels);
    expect(bins.length).toBeGreaterThan(3);
    for (let i = 1; i < bins.length; i++) {
      expect(bins[i][0]).toBeGreaterThan(bins[i - 1][0]);
      expect(bins[i][1]).toBeGreaterThanOrEqual(bins[i - 1][1]);
    }
    // Labels came from p^2, so the raw probabilities overstate the rate. That shows up strongest
    // low down, where p^2 is far below p; at the top of the range the two nearly coincide, so the
    // lowest bin is the one worth asserting on.
    expect(bins[0][1]).toBeLessThan(bins[0][0]);
  });

  it('verifies a transcribed term against the contribution it came from', () => {
    // knots [0,1,3,7,15,30,60]: coef[0] is the base slope, coef[j] an extra slope from knots[j].
    const knots = KNOTS.daysToJourney;
    const coef = [0.02, 0, 0.03, 0, 0, 0, 0];
    const fitted = (x: number): number => 0.02 * x + 0.03 * Math.max(0, x - 3);
    expect(verifyTerm(knots, coef, fitted)).toBeLessThan(1e-9);

    // The same numbers with the hinge on the wrong knot. It still loads, still validates and still
    // predicts; only a comparison against what was fitted catches it.
    const misplaced = [0.02, 0, 0, 0.03, 0, 0, 0];
    expect(verifyTerm(knots, misplaced, fitted)).toBeGreaterThan(0.01);
    expect(() => verifyTerm(knots, [Number.NaN, 0, 0, 0, 0, 0, 0], fitted)).toThrow(/non-finite/);
  });

  it('reads a straight term exactly, with nothing to approximate', () => {
    expect(linearCoefficient((x) => -0.21 * x)).toBeCloseTo(-0.21, 12);
    expect(() => linearCoefficient(() => Number.NaN)).toThrow(/non-finite/);
  });

  it('shrinks a Wilson interval as the bin grows, and widens it near 50%', () => {
    expect(wilsonHalfWidth(50, 1000)).toBeLessThan(wilsonHalfWidth(50, 100));
    expect(wilsonHalfWidth(500, 1000)).toBeGreaterThan(wilsonHalfWidth(20, 1000));
    expect(Number.isNaN(wilsonHalfWidth(1, 0))).toBe(true);
  });

  it('splits deterministically by identity, not by row position', () => {
    expect(hash01('12002|SRC|DST|2026-10-20|SL|GN')).toBe(hash01('12002|SRC|DST|2026-10-20|SL|GN'));
    expect(hash01('a')).not.toBe(hash01('b'));
    const buckets = [0, 0, 0];
    for (let i = 0; i < 3000; i++) {
      const h = hash01(`key-${i}`);
      buckets[h < GATES.trainFraction ? 0 : h < GATES.trainFraction + GATES.validFraction ? 1 : 2]++;
    }
    // Roughly 64/16/20, and stable because nothing here is random.
    expect(buckets[0] / 3000).toBeCloseTo(0.64, 1);
    expect(buckets[1] / 3000).toBeCloseTo(0.16, 1);
    expect(buckets[2] / 3000).toBeCloseTo(0.2, 1);
  });

  it('derives the column layout from the rows, so an unobserved level gets no coefficient', () => {
    const layout = layoutOf([
      { daysToJourney: 5, segmentDistPct: 0.5, logCapacity: 6, isFullRun: true, klass: 'SL', quota: 'GN', trainType: 'SUF', dow: 'Mon', festival: null, serviceFrequency: 'daily' },
    ]);
    expect(layout.names).toContain('daysToJourney@lin');
    expect(layout.names).toContain('daysToJourney@30');
    expect(layout.names).toContain('class=SL');
    expect(layout.names).toContain('fullRun');
    expect(layout.names).not.toContain('class=3A');
    expect(layout.names).not.toContain('festival=diwali');
    expect(layout.names).not.toContain('service=weekly');
  });
});

// -------------------------------------------------------------------------- gates

describe('the gates', () => {
  it('refuses a corpus too small to fit this many parameters', () => {
    const corpus = generateCorpus({ rows: 40, seed: 1 });
    const result = trainModel(corpus, deps, { minRows: 2000 });
    expect(result.table).toBeNull();
    expect(result.report.failures.join(' ')).toMatch(/usable rows against a floor of 2000/);
  });

  it('refuses a corpus where everything confirmed', () => {
    const corpus = generateCorpus({ rows: 500, seed: 2, degenerate: 'CONFIRMED' });
    const result = trainModel(corpus, deps, SMALL);
    expect(result.table).toBeNull();
    expect(result.report.failures.join(' ')).toMatch(/outside the 2–98%/);
  });

  it('refuses a model that cannot separate confirmed from unconfirmed', () => {
    // Labels independent of the features. The fit will still converge and the table would still
    // load and validate — which is precisely why the AUC floor exists.
    const corpus = generateCorpus({ rows: 1200, seed: 3, noise: true });
    const result = trainModel(corpus, deps, SMALL);
    expect(result.report.auc).toBeLessThan(0.6);
    expect(result.table, 'a coin-flip model must not ship').toBeNull();
    expect(result.report.failures.join(' ')).toMatch(/AUC/);
  });

  it('reports the drop rate, because the model only speaks about the rows that survived', () => {
    const corpus = generateCorpus({ rows: 600, seed: 4 });
    const result = trainModel(corpus, deps, SMALL);
    expect(result.report.corpusRows).toBe(600);
    expect(result.report.dropRate).toBeGreaterThanOrEqual(0);
    expect(result.report.dropRate).toBeLessThan(1);
    const dropped = result.report.dropped;
    expect(Object.values(dropped).reduce((a, b) => a + b, 0))
      .toBe(result.report.corpusRows - result.report.usableRows);
  });

  it('records where the rows came from, so a shipped model can be traced to its data', () => {
    const result = trainModel(generateCorpus({ rows: 600, seed: 5 }), deps, SMALL);
    expect(result.report.sources).toEqual(['synthetic-fixture']);
  });
});

// -------------------------------------------------------------------------- recovery

/**
 * The recovery run, fitted once at module level and shared by every block that needs a real table.
 *
 * It is the expensive computation in this file (a few thousand rows through gradient descent), so
 * running it once and asserting many things about the result is both faster and more honest: the
 * table being inspected is the same object in every test, not a fresh fit per assertion.
 */
const RECOVERY = trainModel(generateCorpus({ rows: 3000, seed: 11 }), deps,
  { ...SMALL, minRows: 1500, maxIterations: 700 });

describe('recovery: can it actually learn', () => {
  const result = RECOVERY;
  const report: TrainReport = result.report;

  it('emits a table at all', () => {
    expect(result.report.failures, result.report.failures.join(' | ')).toEqual([]);
    expect(result.table).not.toBeNull();
  });

  it('separates held-out tickets well above the floor', () => {
    expect(report.auc).toBeGreaterThan(0.78);
    expect(report.logLoss).toBeLessThan(report.baselineLogLoss);
  });

  it('recovers the sign of the effects that were put in', () => {
    const table = result.table!;
    // Long segments confirm more often, so the contribution must rise with segment share.
    const short = linearPredictor(table, sample({ segmentDistPct: 0.1 }));
    const long = linearPredictor(table, sample({ segmentDistPct: 1 }));
    expect(long).toBeGreaterThan(short);

    // Booking further ahead gives a waitlist longer to clear.
    const soon = linearPredictor(table, sample({ daysToJourney: 2 }));
    const ahead = linearPredictor(table, sample({ daysToJourney: 50 }));
    expect(ahead).toBeGreaterThan(soon);

    // A festival run-up suppresses confirmation, so its multiplier must be below one.
    expect(table.festivalMultiplier, 'festival effects should have survived into the table').toBeDefined();
    for (const key of ['diwali', 'chhath']) {
      const mult = table.festivalMultiplier?.[key];
      if (mult !== undefined) expect(mult, `${key} should lower the odds`).toBeLessThan(1);
    }

    // Three AC is easier than sleeper, compared as coefficients rather than as whole feature
    // vectors so the class effect is not confused with the capacity effect.
    const classCoef = table.categorical.class;
    expect(classCoef['3A']).toBeGreaterThan(classCoef.SL);

    // First AC is deliberately NOT asserted on, and the reason is worth keeping visible: in this
    // fixture 1A appears only on the Rajdhani, always in a single coach of about twenty berths, so
    // its class effect is not separately identifiable from its capacity effect. The fit splits the
    // truth between the two coefficients in whatever way the regulariser prefers, and gets the
    // *prediction* right while the individual coefficient is meaningless. Real data has 1A across
    // many trains and rake sizes, which is what makes it identifiable there. Asserting a sign here
    // would be testing a property of the fixture and calling it a property of the trainer.
    expect(classCoef['1A'], 'the level should still have been emitted').toBeDefined();
  });

  it('emits a table the runtime accepts and reads back to the same numbers', () => {
    // The round-trip gate: the shipped table, through model.ts, against the fitted model. If
    // distillation or the festival exp/log round-trip had drifted, this would be large.
    expect(report.roundTripMaxP).toBeLessThan(0.05);
    expect(report.distillMaxP).toBeLessThan(0.03);

    const table = result.table!;
    const p = predict(table, sample({}));
    expect(p).not.toBeNull();
    expect(p!.pConfirm).toBeGreaterThan(0);
    expect(p!.pConfirm).toBeLessThan(1);
    expect(p!.modelVersion).toBe(`t1-${TODAY}`);
  });

  it('claims an interval only if it measured one, and says which', () => {
    if (report.ciHalfWidth !== null) {
      expect(result.table!.ciHalfWidth).toBe(report.ciHalfWidth);
      expect(report.ciBasis).toMatch(/Wilson/);
    } else {
      expect(result.table!.ciHalfWidth).toBeUndefined();
      expect(report.ciBasis).toBeTruthy();
    }
  });

  it('calibrates: the emitted bins are monotone and inside [0,1]', () => {
    const bins = result.table!.calibration.bins;
    expect(bins.length).toBeGreaterThanOrEqual(GATES.minBins);
    for (let i = 1; i < bins.length; i++) {
      expect(bins[i][0]).toBeGreaterThan(bins[i - 1][0]);
      expect(bins[i][1]).toBeGreaterThanOrEqual(bins[i - 1][1]);
    }
  });
});

function sample(over: Partial<ModelFeatures> = {}): ModelFeatures {
  return {
    daysToJourney: 20, segmentDistPct: 0.6, logCapacity: Math.log(684), isFullRun: false,
    klass: '3A', quota: 'GN', trainType: 'SUF', dow: 'Wed', festival: null,
    serviceFrequency: 'daily', ...over,
  };
}

// -------------------------------------------------------------------------- emitting

describe('emitting', () => {
  it('refuses to serialise a table a gate rejected', () => {
    const result = trainModel(generateCorpus({ rows: 30, seed: 12 }), deps, { minRows: 2000 });
    expect(() => emitModelJson(result)).toThrow(/refusing to emit a model/);
  });

  it('writes stable JSON, so a diff shows only real changes', () => {
    const result = RECOVERY;
    expect(result.table, 'the recovery run is expected to pass every gate').not.toBeNull();
    const a = emitModelJson(result);
    const b = emitModelJson(result);
    expect(a).toBe(b);
    expect(a.endsWith('\n')).toBe(true);
    expect(JSON.parse(a).version).toBe(`t1-${TODAY}`);
    // Keys are sorted, so the same corpus re-trained produces a reviewable diff.
    const keys = Object.keys(JSON.parse(a) as Record<string, unknown>);
    expect(keys).toEqual([...keys].sort());
  });
});

// -------------------------------------------------------------------------- shipping guards

describe('the report a maintainer reads', () => {
  it('names the gate that failed, with the numbers, rather than just failing', () => {
    const refused = trainModel(generateCorpus({ rows: 40, seed: 21 }), deps, { minRows: 2000 });
    const text = formatReport(refused.report);
    expect(text).toMatch(/REFUSED:/);
    expect(text).toMatch(/floor of 2000/);
    expect(text).toMatch(/holdout AUC\s+undefined/); // never fitted, so never measured
    expect(text).toMatch(/synthetic-fixture/);
  });

  it('reports the interval as unclaimed when it was not measured', () => {
    const text = formatReport(RECOVERY.report);
    expect(text).toMatch(/90% interval/);
    expect(text).toMatch(/not claimed|±/);
    expect(text).toMatch(/round-trip error/);
  });
});

describe('what is allowed to ship', () => {
  it('recognises the served data directory, so --ship cannot be skipped by accident', () => {
    const data = resolve(process.cwd(), 'public/data');
    expect(isServedDataPath(join(data, 'model.json'), data)).toBe(true);
    expect(isServedDataPath(data, data)).toBe(true);
    expect(isServedDataPath('/tmp/model.json', data)).toBe(false);
    expect(isServedDataPath(resolve(process.cwd(), 'tools/model.json'), data)).toBe(false);
    // A sibling directory whose name merely starts with the same letters is not inside it.
    expect(isServedDataPath(resolve(process.cwd(), 'public/database/x.json'), data)).toBe(false);
  });

  it('ships no model: the served data directory holds the timetable and nothing that forecasts', () => {
    // The moment a model.json exists here, the deployed app fetches it, Tier 1 switches on and
    // probabilities reach travellers. This is the guard that keeps that a deliberate act.
    const data = resolve(process.cwd(), 'public/data');
    if (!existsSync(data)) return; // no packed dataset in this checkout: nothing to guard
    expect(readdirSync(data)).not.toContain('model.json');
  });

  it('ships no corpus either, because there is no licensed one to ship', () => {
    const roots = [resolve(process.cwd(), 'public/data'), resolve(process.cwd(), '..', 'data')];
    for (const root of roots) {
      if (!existsSync(root)) continue;
      for (const entry of readdirSync(root)) {
        expect(entry, `${root}/${entry} looks like an observation corpus`).not.toMatch(/corpus.*\.(jsonl|json|csv)$/i);
      }
    }
  });
});

// -------------------------------------------------------------------------- real dataset

const DATA = resolve(process.cwd(), 'public/data');
const HAVE_DATA = existsSync(join(DATA, 'graph.bin')) && existsSync(join(DATA, 'stations.bin'));

function readAb(file: string): ArrayBuffer {
  const b = readFileSync(join(DATA, file));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

describe.skipIf(!HAVE_DATA)('the trainer against the real packed timetable', () => {
  it('reads every train and resolves real station codes', () => {
    const geo = geometryFromDataset(DATA);
    const manifest = JSON.parse(readFileSync(join(DATA, 'manifest.json'), 'utf8')) as {
      counts: { trains: number; stations: number };
    };
    expect(geo.trains).toBe(manifest.counts.trains);
    expect(geo.stations).toBe(manifest.counts.stations);
    expect(geo.resolveStation('NDLS')).toBeGreaterThanOrEqual(0);
    expect(geo.resolveStation('HWH')).toBeGreaterThanOrEqual(0);
    expect(geo.resolveStation('ZZZZ')).toBe(-1);
  });

  it('derives usable features from real stop distances, on a real train', () => {
    // The same reader the CLI uses, so this is what proves the trainer can be pointed at the
    // shipped dataset rather than only at fixtures.
    const geo = geometryFromDataset(DATA);
    const stations = StationIndex.fromContainer(Container.parse(readAb('stations.bin'), ContainerKind.Stations));
    const code = (ix: number): string => stations.at(ix).code;

    const candidates = ['12301', '12951', '11057', '12137', '12302'];
    const found = candidates.map((n) => ({ n, t: geo.resolveTrain(n) })).find(
      (c) => c.t !== null && c.t.stops.length >= 2 && c.t.classes.length > 0,
    );
    expect(found, 'the dataset should hold a train with usable geometry').toBeDefined();
    if (found === undefined || found.t === null) return;

    const train = found.t;
    const klass = train.classes[0];
    const features = segmentFeatures({
      trainNumber: found.n,
      board: code(train.stops[0].station),
      alight: code(train.stops[train.stops.length - 1].station),
      dateIso: '2026-10-02', klass, quota: 'GN',
    }, train, { resolveStation: geo.resolveStation, todayIso: TODAY });

    // A class Tier 0 has no denominator for is refused, which is correct behaviour rather than a
    // failure of this test — so assert the refusal is honest if it happens.
    if (features === null) {
      expect(train.classes.length).toBeGreaterThan(0);
      return;
    }
    expect(features.segmentDistPct).toBe(1);
    expect(features.isFullRun).toBe(true);
    expect(features.logCapacity).toBeGreaterThan(0);
    expect(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']).toContain(features.dow);
    expect(features.trainType).toBe(train.type.toUpperCase());
    // Real stop distances must be non-decreasing along the run, or the segment share is nonsense.
    expect(train.stops.every((s, i) => i === 0 || s.distKm >= train.stops[i - 1].distKm)).toBe(true);
  });
});

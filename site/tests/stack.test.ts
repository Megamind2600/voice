/**
 * stack.test.ts — cascade assembly, table loading, and the geometry cache.
 *
 * The ordering test is the one that matters: a query that is both structurally impossible and
 * perfectly predictable must come back from Tier 0, not from the model.
 */
import { describe, expect, it } from 'vitest';
import {
  MODEL_URL, TrainGeometryCache, availabilitySources, buildAvailabilityStack, loadModel, queryForLeg,
} from '../src/availability/stack';
import type { FetchLike, ModelLoadResult } from '../src/availability/stack';
import { parseModel } from '../src/availability/model';
import type { TrainGeometry } from '../src/availability/features';
import { AvailabilityCascade, type AvailabilityQuery } from '../src/availability/tier';

const TABLE = {
  version: 'stack-test-v1',
  trainedOn: 'fixture',
  intercept: 0,
  numeric: { segmentDistPct: { kind: 'linear', coef: 1 }, logCapacity: { kind: 'linear', coef: 0.1 } },
  categorical: { class: { '3A': 0.5, SL: 0.5 }, quota: { GN: 0 }, trainType: { RAJ: 0 } },
  calibration: { method: 'isotonic', bins: [[0, 0.1], [1, 0.9]] },
};

const STATIONS: Record<string, number> = { MMCT: 0, KOTA: 4, NDLS: 6 };

const TRAIN: TrainGeometry = {
  type: 'RAJ',
  classes: ['1A', '2A', '3A'],
  distanceKm: 1384,
  runsDays: 0b1111111,
  stops: [
    { station: 0, distKm: 0, arrMin: null, depMin: 0 },
    { station: 4, distKm: 800, arrMin: 1490, depMin: 1500 },
    { station: 6, distKm: 1384, arrMin: 1935, depMin: null },
  ],
};

const TODAY = '2026-09-12';

function stackWith(opts: { model?: boolean; geometry?: boolean } = {}) {
  const cache = new TrainGeometryCache();
  if (opts.geometry !== false) cache.set('12951', TRAIN);
  const absent: string[] = [];
  const cascade = buildAvailabilityStack({
    resolveTrain: cache.resolver(),
    resolveStation: (code) => STATIONS[code] ?? -1,
    model: opts.model === false ? null : parseModel(TABLE),
    todayIso: TODAY,
    onModelAbsent: (reason) => absent.push(reason),
  });
  return { cascade, cache, absent };
}

const query = (over: Partial<AvailabilityQuery> = {}): AvailabilityQuery => ({
  trainNumber: '12951', board: 'MMCT', alight: 'NDLS',
  dateIso: '2026-10-02', klass: '3A', quota: 'GN', ...over,
});

describe('the cascade this build actually has', () => {
  it('holds Tier 0 first and Tier 1 second', () => {
    const sources = availabilitySources({
      resolveTrain: () => TRAIN, resolveStation: (c) => STATIONS[c] ?? -1, model: parseModel(TABLE),
    });
    expect(sources.map((s) => s.id)).toEqual(['T0', 'T1']);
  });

  it('reports only the tiers that can answer, which is Tier 0 alone until a model ships', () => {
    expect(stackWith({ model: false }).cascade.activeTiers()).toEqual(['T0']);
    expect(stackWith().cascade.activeTiers()).toEqual(['T0', 'T1']);
  });

  it('says why the prediction tier is off, and only says it once per build', () => {
    const { absent } = stackWith({ model: false });
    expect(absent).toHaveLength(1);
    expect(absent[0]).toMatch(/prediction tier is off/i);
    expect(absent[0]).toMatch(/nothing here is a forecast/i);
    expect(stackWith().absent).toHaveLength(0);
  });

  it('answers a predictable query from Tier 1, badged as a prediction', async () => {
    const reading = await stackWith().cascade.lookup(query());
    expect(reading.tier).toBe('T1');
    expect(reading.source).toBe('PREDICTED');
    expect(reading.status.verdict).toBe('UNKNOWN');
    expect(reading.prediction).not.toBeNull();
    expect(reading.explanation).toMatch(/^PREDICTED/);
  });

  it('lets Tier 0 outrank the model on a combination that cannot be booked', async () => {
    // Sleeper on a Rajdhani. The model would happily produce a probability for it — it has an SL
    // coefficient and a capacity denominator is the only thing missing — and that probability
    // would describe a ticket nobody can buy. Tier 0's answer is a structural fact and comes
    // first, so the reading is a REGRET with no prediction attached.
    const reading = await stackWith().cascade.lookup(query({ klass: 'SL' }));
    expect(reading.tier).toBe('T0');
    expect(reading.source).toBe('STATIC');
    expect(reading.status.verdict).toBe('REGRET');
    expect(reading.prediction ?? null, 'a structural impossibility is not a forecast').toBeNull();
  });

  it('falls through to an honest unknown when geometry has not arrived', async () => {
    // Stops come from the worker asynchronously; the extractor is synchronous. Until the geometry
    // is cached, Tier 1 declines rather than inventing a segment share.
    const reading = await stackWith({ geometry: false }).cascade.lookup(query());
    expect(reading.tier).toBeNull();
    expect(reading.source).toBe('NONE');
    expect(reading.status.verdict).toBe('UNKNOWN');
    expect(reading.explanation).toMatch(/declined/i);
  });

  it('answers the same tuple from the memo the second time', async () => {
    const { cascade } = stackWith();
    const memo = new Map<string, Awaited<ReturnType<typeof cascade.lookup>>>();
    const first = await cascade.lookup(query(), { memo });
    const second = await cascade.lookup(query(), { memo });
    expect(second).toBe(first);
    expect(memo.size).toBe(1);
  });

  it('says "declined" rather than "not connected", because Tier 0 was asked', async () => {
    const cascade = buildAvailabilityStack({
      resolveTrain: () => null, resolveStation: () => -1, model: null,
    });
    // Tier 0 is always available and declines whatever it cannot rule out, so even a stack with no
    // model reports "declined". That wording is load-bearing: it tells the traveller someone looked
    // and found nothing, rather than that nobody looked.
    const reading = await cascade.lookup(query());
    expect(reading.explanation).toMatch(/declined/i);
    expect(reading.status.verdict).toBe('UNKNOWN');
  });

  it('reserves "not connected" for a cascade with no sources at all', async () => {
    const reading = await new AvailabilityCascade([]).lookup(query());
    expect(reading.explanation).toMatch(/No availability source is connected/i);
  });
});

describe('loading a coefficient table', () => {
  const ok = (body: unknown): FetchLike => async () => ({ ok: true, status: 200, json: async () => body });

  it('loads and validates a good table', async () => {
    const result = await loadModel(MODEL_URL, ok(TABLE));
    expect(result.reason).toBeNull();
    expect(result.model?.version).toBe('stack-test-v1');
    expect(result.url).toBe(MODEL_URL);
  });

  it('treats a missing table as the normal case, and says so plainly', async () => {
    const result = await loadModel(MODEL_URL, async () => ({ ok: false, status: 404, json: async () => null }));
    expect(result.model).toBeNull();
    expect(result.reason).toMatch(/No model table ships with this build/i);
  });

  it('distinguishes a server error from a missing table', async () => {
    const result = await loadModel(MODEL_URL, async () => ({ ok: false, status: 503, json: async () => null }));
    expect(result.reason).toMatch(/HTTP 503/);
  });

  it('never throws when the network fails', async () => {
    const result: ModelLoadResult = await loadModel(MODEL_URL, async () => { throw new Error('offline'); });
    expect(result.model).toBeNull();
    expect(result.reason).toMatch(/could not be fetched: offline/);
  });

  it('never throws on a body that is not JSON', async () => {
    const result = await loadModel(MODEL_URL, async () => ({
      ok: true, status: 200, json: async () => { throw new SyntaxError('unexpected token'); },
    }));
    expect(result.model).toBeNull();
    expect(result.reason).toMatch(/not valid JSON/);
  });

  it('carries the loader\'s own diagnosis when a table is malformed', async () => {
    const broken = { ...TABLE, numeric: { ...TABLE.numeric, logCapacity: { kind: 'linear', coef: 'x' } } };
    const result = await loadModel(MODEL_URL, ok(broken));
    expect(result.model).toBeNull();
    // parseModel names the path, which is what someone fixing the build needs.
    expect(result.reason).toMatch(/model\.numeric\.logCapacity\.coef/);
  });
});

describe('the geometry cache', () => {
  it('round-trips and reports membership', () => {
    const cache = new TrainGeometryCache();
    expect(cache.get('12951')).toBeNull();
    expect(cache.has('12951')).toBe(false);
    cache.set('12951', TRAIN);
    expect(cache.get('12951')).toBe(TRAIN);
    expect(cache.has('12951')).toBe(true);
    expect(cache.size).toBe(1);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('evicts the oldest entry once it is full, because a session can touch every train in India', () => {
    const cache = new TrainGeometryCache(3);
    for (const n of ['1', '2', '3', '4']) cache.set(n, TRAIN);
    expect(cache.size).toBe(3);
    expect(cache.has('1'), 'the oldest is gone').toBe(false);
    expect(cache.has('4')).toBe(true);
  });

  it('counts a re-set as a refresh rather than a second entry', () => {
    const cache = new TrainGeometryCache(2);
    cache.set('1', TRAIN);
    cache.set('2', TRAIN);
    cache.set('1', TRAIN);
    expect(cache.size).toBe(2);
    cache.set('3', TRAIN);
    expect(cache.has('2'), 'the untouched entry is the one evicted').toBe(false);
    expect(cache.has('1')).toBe(true);
  });

  it('exposes a resolver the stack can use directly', () => {
    const cache = new TrainGeometryCache();
    cache.set('12951', TRAIN);
    expect(cache.resolver()('12951')).toBe(TRAIN);
    expect(cache.resolver()('99999')).toBeNull();
  });
});

describe('building a query from a leg', () => {
  it('defaults the quota to general, which is what nearly everyone books under', () => {
    const q = queryForLeg({
      trainNumber: '12951', board: 'MMCT', alight: 'NDLS', originDateIso: '2026-10-02', klass: '3A',
    });
    expect(q).toEqual({
      trainNumber: '12951', board: 'MMCT', alight: 'NDLS',
      dateIso: '2026-10-02', klass: '3A', quota: 'GN',
    });
  });

  it('passes an explicit quota through untouched', () => {
    const q = queryForLeg({
      trainNumber: '1', board: 'A', alight: 'B', originDateIso: '2026-10-02', klass: 'SL', quota: 'TQ',
    });
    expect(q.quota).toBe('TQ');
  });
});

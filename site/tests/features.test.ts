/**
 * features.test.ts — the query→feature bridge, and the festival calendar behind it.
 *
 * The refusals matter more than the happy path. A feature vector with a guessed denominator
 * produces a probability indistinguishable from a measured one, so every "I cannot build this
 * honestly" case is pinned here.
 */
import { describe, expect, it } from 'vitest';
import {
  COVERED, FESTIVALS_2026, festivalOf, isCovered,
} from '../src/availability/festivals';
import {
  dayOffsetOf, featureExtractor, segmentFeatures, serviceFrequencyOf,
} from '../src/availability/features';
import type { TrainGeometry } from '../src/availability/features';
import { capacityFor } from '../src/availability/rake';
import { istNow } from '../src/availability/rules';
import type { AvailabilityQuery } from '../src/availability/tier';

const STATIONS: Record<string, number> = {
  MMCT: 0, BVI: 1, ST: 2, RTM: 3, KOTA: 4, NZM: 5, NDLS: 6,
};
const resolveStation = (code: string): number => STATIONS[code] ?? -1;

/**
 * A Rajdhani-shaped fixture: Mumbai to Delhi, 1384 km, with one stop that is reached after
 * midnight so the boarding-day arithmetic has something to get wrong.
 *
 * Kota is arrived at 00:50 on the second day (depMin 1500 = 25h00 from origin departure). Anyone
 * who computes the weekday from the origin date puts a Saturday boarding on a Friday, and the
 * Friday-evening peak is one of the strongest calendar signals in the model.
 */
const TRAIN: TrainGeometry = {
  type: 'RAJ',
  classes: ['1A', '2A', '3A'],
  distanceKm: 1384,
  runsDays: 0b1111111,
  stops: [
    { station: 0, distKm: 0, arrMin: null, depMin: 0 },
    { station: 1, distKm: 27, arrMin: 15, depMin: 17 },
    { station: 2, distKm: 260, arrMin: 160, depMin: 165 },
    { station: 3, distKm: 500, arrMin: 330, depMin: 340 },
    { station: 4, distKm: 800, arrMin: 1490, depMin: 1500 },
    { station: 5, distKm: 1370, arrMin: 1900, depMin: 1902 },
    { station: 6, distKm: 1384, arrMin: 1935, depMin: null },
  ],
};

const TODAY = '2026-09-12'; // a Saturday
const ORIGIN_DATE = '2026-10-02'; // a Friday, 20 days out and inside the 60-day window
const opts = { resolveStation, todayIso: TODAY };

const query = (over: Partial<AvailabilityQuery> = {}): AvailabilityQuery => ({
  trainNumber: '12951', board: 'MMCT', alight: 'NDLS',
  dateIso: ORIGIN_DATE, klass: '3A', quota: 'GN', ...over,
});

describe('building a feature vector', () => {
  it('measures the whole run as a full run', () => {
    const f = segmentFeatures(query(), TRAIN, opts);
    expect(f).not.toBeNull();
    expect(f!.daysToJourney).toBe(20);
    expect(f!.segmentDistPct).toBe(1);
    expect(f!.isFullRun).toBe(true);
    expect(f!.klass).toBe('3A');
    expect(f!.quota).toBe('GN');
    expect(f!.trainType).toBe('RAJ');
    expect(f!.serviceFrequency).toBe('daily');
  });

  it('takes the capacity denominator from Tier 0 rather than inventing one', () => {
    const f = segmentFeatures(query(), TRAIN, opts)!;
    const capacity = capacityFor(TRAIN, '3A');
    expect(capacity).not.toBeNull();
    expect(f.logCapacity).toBeCloseTo(Math.log(capacity!.nominal), 12);
  });

  it('measures a short hop as a fraction of the run, and not as a full run', () => {
    const f = segmentFeatures(query({ board: 'ST', alight: 'KOTA' }), TRAIN, opts)!;
    expect(f.segmentDistPct).toBeCloseTo((800 - 260) / 1384, 12);
    expect(f.isFullRun).toBe(false);
  });

  it('uses the boarding day for the weekday, not the origin day', () => {
    // Origin departs Friday 2026-10-02; Kota is reached after midnight, so boarding there is a
    // Saturday. This is the case that silently poisons the calendar features if it is wrong.
    const fromOrigin = segmentFeatures(query(), TRAIN, opts)!;
    expect(fromOrigin.dow).toBe('Fri');

    const fromKota = segmentFeatures(query({ board: 'KOTA', alight: 'NDLS' }), TRAIN, opts)!;
    expect(fromKota.dow).toBe('Sat');
  });

  it('sees the festival run-up on the boarding date', () => {
    // Diwali 2026 is 8 November with a six-day run-up, so 5 November is inside it.
    const f = segmentFeatures(query({ dateIso: '2026-11-05' }), TRAIN, opts)!;
    expect(f.festival).toBe('diwali');
    const plain = segmentFeatures(query(), TRAIN, opts)!;
    expect(plain.festival).toBeNull();
  });

  it('normalises case, because the model table is keyed in upper case', () => {
    const f = segmentFeatures(query({ klass: '3a', quota: 'gn' }), TRAIN, opts)!;
    expect(f.klass).toBe('3A');
    expect(f.quota).toBe('GN');
  });

  it('falls back to the last stop when the train has no published distance', () => {
    // Built by dropping the key rather than setting it to undefined: exactOptionalPropertyTypes
    // treats those as different things, and "this train has no published distance" is the absence
    // of the field, not a field holding undefined.
    const { distanceKm: _noPublishedDistance, ...rest } = TRAIN;
    const noDistance: TrainGeometry = rest;
    const f = segmentFeatures(query({ board: 'ST', alight: 'KOTA' }), noDistance, opts)!;
    expect(f.segmentDistPct).toBeCloseTo((800 - 260) / 1384, 12);
  });
});

describe('refusing to build a dishonest one', () => {
  it('declines a train the resolver does not know', () => {
    expect(segmentFeatures(query(), null, opts)).toBeNull();
  });

  it('declines an unknown station code', () => {
    expect(segmentFeatures(query({ board: 'ZZZZ' }), TRAIN, opts)).toBeNull();
    expect(segmentFeatures(query({ alight: 'ZZZZ' }), TRAIN, opts)).toBeNull();
  });

  it('declines a station this train does not stop at', () => {
    const resolve = (code: string): number => (code === 'CSMT' ? 99 : resolveStation(code));
    expect(segmentFeatures(query({ board: 'CSMT' }), TRAIN, { ...opts, resolveStation: resolve })).toBeNull();
  });

  it('declines when the alighting stop comes before the boarding one', () => {
    expect(segmentFeatures(query({ board: 'NDLS', alight: 'MMCT' }), TRAIN, opts)).toBeNull();
    expect(segmentFeatures(query({ board: 'KOTA', alight: 'KOTA' }), TRAIN, opts)).toBeNull();
  });

  it('declines a journey date that has already passed', () => {
    expect(segmentFeatures(query({ dateIso: '2026-09-01' }), TRAIN, opts)).toBeNull();
    // Today itself is still bookable, so it must not be swept up with the past.
    expect(segmentFeatures(query({ dateIso: TODAY }), TRAIN, opts)).not.toBeNull();
  });

  it('declines a class this train does not run, instead of borrowing a capacity', () => {
    // A Rajdhani has no sleeper. Tier 0 has no denominator for it, so Tier 1 must have no opinion.
    expect(segmentFeatures(query({ klass: 'SL' }), TRAIN, opts)).toBeNull();
  });

  it('declines when the class list is empty, which is a hole in the data and not evidence', () => {
    const bootstrap: TrainGeometry = { ...TRAIN, classes: [], classesInferred: false };
    expect(segmentFeatures(query(), bootstrap, opts)).toBeNull();
  });

  it('declines a train with a single stop', () => {
    expect(segmentFeatures(query(), { ...TRAIN, stops: [TRAIN.stops[0]] }, opts)).toBeNull();
  });
});

describe('the day-offset formula, at the boundaries where two copies would diverge', () => {
  it.each([
    [null, 0, 0],        // origin departure
    [1439, null, 0],     // one minute before midnight is still day 0
    [null, 1440, 1],     // exactly midnight is day 1
    [1490, 1500, 1],     // Kota, arrived 00:50 on the second day
    [2879, null, 1],
    [null, 2880, 2],     // two days out
  ])('arrMin=%s depMin=%s -> day %s', (arrMin, depMin, expected) => {
    expect(dayOffsetOf({ station: 0, distKm: 0, arrMin, depMin })).toBe(expected);
  });

  it('prefers the departure minute, because that is when the passenger is on board', () => {
    // Arrives 23:50 on day 0, departs 00:10 on day 1: the boarding belongs to day 1.
    expect(dayOffsetOf({ station: 0, distKm: 0, arrMin: 1430, depMin: 1450 })).toBe(1);
  });

  it('treats a stop with no times at all as day 0 rather than as an error', () => {
    expect(dayOffsetOf({ station: 0, distKm: 0, arrMin: null, depMin: null })).toBe(0);
  });
});

describe('service frequency', () => {
  it('reads the bitmask rather than assuming', () => {
    expect(serviceFrequencyOf(0b1111111, false)).toBe('daily');
    expect(serviceFrequencyOf(0b0000001, false)).toBe('weekly');
    expect(serviceFrequencyOf(0b0101010, false)).toBe('irregular');
  });

  it('says nothing when the bitmask was assumed, or when it is empty', () => {
    // A weekly train on a migrant corridor waitlists instantly. Rounding an assumed bitmask to
    // "daily" would predict the opposite of the truth, so the feature is simply absent.
    expect(serviceFrequencyOf(0b1111111, true)).toBeNull();
    expect(serviceFrequencyOf(0, false)).toBeNull();
    expect(serviceFrequencyOf(undefined, false)).toBeNull();
  });
});

describe('the extractor a cascade actually uses', () => {
  it('resolves by train number and declines what it cannot find', () => {
    const resolve = (n: string): TrainGeometry | null => (n === '12951' ? TRAIN : null);
    const extract = featureExtractor(resolve, opts);
    expect(extract(query())).not.toBeNull();
    expect(extract(query({ trainNumber: '99999' }))).toBeNull();
  });
});

describe('the festival calendar', () => {
  it('covers the run-up, not the day after', () => {
    expect(festivalOf('2026-11-15')).toBe('chhath');
    expect(festivalOf('2026-11-10')).toBe('chhath'); // five days out, the window edge
    expect(festivalOf('2026-11-09')).toBeNull();      // six days out, outside it
    expect(festivalOf('2026-11-16')).toBeNull();      // the day after is the return movement
  });

  it('picks the nearest festival when windows overlap', () => {
    // Durga Puja (19 Oct, six-day run-up) and Dussehra (20 Oct, three-day run-up) are a day apart.
    expect(festivalOf('2026-10-18')).toBe('durgaPuja'); // one day before Ashtami, two before Dussehra
    expect(festivalOf('2026-10-20')).toBe('dussehra');
    expect(festivalOf('2026-10-13')).toBe('durgaPuja');
  });

  it('returns nothing outside the years it publishes, rather than extrapolating', () => {
    // A stale calendar must degrade to "no festival". One that kept guessing would put Diwali on a
    // date that is not Diwali and hand the model a confident, wrong spike.
    expect(festivalOf('2025-11-08')).toBeNull();
    expect(festivalOf('2027-11-08')).toBeNull();
    expect(isCovered('2026-06-01')).toBe(true);
    expect(isCovered('2029-06-01')).toBe(false);
    // Three days before Makar Sankranti, because the span starts at the first run-up day rather
    // than at the first festival day.
    expect(COVERED.from).toBe('2026-01-11');
    expect(festivalOf('2026-01-12')).toBe('makarSankranti');
    expect(festivalOf('2026-01-10')).toBeNull();
    expect(COVERED.to).toBe('2027-01-01');
  });

  it('has no duplicate keys, no impossible dates and a non-negative window on every entry', () => {
    const keys = FESTIVALS_2026.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const f of FESTIVALS_2026) {
      expect(f.dateIso).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(`${f.dateIso}T00:00:00Z`)), `${f.key} is not a real date`).toBe(false);
      expect(f.pre).toBeGreaterThanOrEqual(0);
      expect(f.note.length).toBeGreaterThan(0);
    }
  });

  it('marks the moon-sighting dates as tentative, because they move', () => {
    for (const key of ['eid', 'eidAdha', 'muharram']) {
      const entry = FESTIVALS_2026.find((f) => f.key === key);
      expect(entry, `${key} should be in the table`).toBeDefined();
      expect(entry!.tentative, `${key} depends on moon sighting`).toBe(true);
    }
  });

  it('forces a refresh: the published calendar must not already be in the past', () => {
    // This test is a maintenance alarm, not a correctness check. It starts failing once the last
    // published festival has gone by, which is when the next year's dates need adding.
    expect(COVERED.to >= istNow().dateIso,
      `the festival table ends ${COVERED.to}; add the next year's dates`).toBe(true);
  });

  it('judges an injected table by its own coverage, not by the published one', () => {
    const fake = [{ key: 'testFest', name: 'Test', dateIso: '2030-05-05', pre: 2, note: 'fixture' }];
    expect(festivalOf('2030-05-04', fake)).toBe('testFest');
    expect(festivalOf('2030-05-05', fake)).toBe('testFest');
    expect(festivalOf('2030-05-06', fake)).toBeNull(); // the day after: the return movement
    expect(festivalOf('2030-05-01', fake)).toBeNull(); // three days out, window is two
    expect(festivalOf('2026-11-05', fake)).toBeNull(); // outside this table's own span
  });
});

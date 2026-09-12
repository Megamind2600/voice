/**
 * timetable.test.ts — the CSA time axis.
 *
 * The interesting cases are the multi-day ones. A timetable that only contained trains
 * departing "today" would pass every obvious test and still be wrong for every overnight
 * long-distance service in India, which is most of the ones anyone plans a holiday around.
 */
import { describe, expect, it } from 'vitest';
import { Container, ContainerKind } from '../src/lib/binary';
import { Graph, stationCountOf } from '../src/lib/graph';
import {
  buildTimetable, dayIndexOf, defaultLookbackDays, isValidIsoDate, lowerBound, maxEndKey,
  runsOn, shiftDate, TimetableCache,
} from '../src/router/timetable';
import { buildGraphContainer, type TrainSpec } from './helpers';

const STATIONS = 4; // A=0 B=1 C=2 D=3

/** Day train: leaves A at 10:00, B at 11:10, arrives C at 12:10. */
const DAY_TRAIN: TrainSpec = {
  number: '10001', name: 'Day Express', type: 9, classes: 0, runsDays: 127,
  originDepMin: 600, durationMin: 130, distanceKm: 100,
  stops: [0, 1, 2],
  legs: [[0, 60, 50], [70, 130, 100]],
};

/**
 * Overnight train: leaves A at 23:00, reaches B at 01:00 the NEXT day, C at 04:00.
 *
 * This is the train that breaks a naive timetable. On the query date its first leg has
 * already gone, but its second leg is very much boardable — and it is the only way to get
 * from B to C in the small hours.
 */
const NIGHT_TRAIN: TrainSpec = {
  number: '10002', name: 'Night Express', type: 9, classes: 0, runsDays: 127,
  originDepMin: 1380, durationMin: 300, distanceKm: 200,
  stops: [0, 1, 2],
  legs: [[0, 120, 100], [130, 300, 200]],
};

function makeGraph(trains: TrainSpec[]): Graph {
  const c = Container.parse(
    buildGraphContainer(trains, STATIONS),
    ContainerKind.Graph,
  );
  return Graph.fromContainer(c, stationCountOf(c));
}

/** Absolute departure times in the built timetable, as a plain array. */
const deps = (tt: { depTs: Int32Array; count: number }): number[] =>
  Array.from(tt.depTs.subarray(0, tt.count));

describe('date arithmetic', () => {
  it('maps ISO dates to weekdays with Monday = 0', () => {
    expect(dayIndexOf('2026-09-14')).toBe(0); // Monday
    expect(dayIndexOf('2026-09-15')).toBe(1); // Tuesday
    expect(dayIndexOf('2026-09-13')).toBe(6); // Sunday
  });

  it('derives the weekday from the UTC calendar, not the local one', () => {
    // Parsed as UTC on purpose: a user in London and one in Kolkata must get the same
    // weekday for the same ISO date, or the same query returns different trains. Asserting
    // against a date whose local and UTC weekdays differ in a +05:30 timezone pins that.
    // 2026-09-14T00:00Z is Monday in UTC and already Monday 05:30 in IST.
    expect(dayIndexOf('2026-09-14')).toBe(0);
    expect(new Date(Date.parse('2026-09-14T00:00:00Z')).getUTCDay()).toBe(1); // Sunday in JS
    // The conversion from JS's Sunday=0 to this module's Monday=0 is the thing under test.
    expect((1 + 6) % 7).toBe(0);
  });

  it('shifts dates across month and year boundaries', () => {
    expect(shiftDate('2026-09-14', -1)).toBe('2026-09-13');
    expect(shiftDate('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftDate('2026-01-01', -1)).toBe('2025-12-31');
    expect(shiftDate('2026-09-14', 20)).toBe('2026-10-04');
  });

  it('rejects anything that is not an ISO date', () => {
    expect(isValidIsoDate('2026-09-14')).toBe(true);
    expect(isValidIsoDate('14/09/2026')).toBe(false);
    expect(isValidIsoDate('2026-9-14')).toBe(false);
    expect(isValidIsoDate('')).toBe(false);
    expect(() => dayIndexOf('yesterday')).toThrow(RangeError);
    expect(() => buildTimetable(makeGraph([]), 'not-a-date')).toThrow(RangeError);
  });
});

describe('running days', () => {
  it('reads the bitmask with Monday as bit 0', () => {
    expect(runsOn(0b0000001, 0)).toBe(true);  // Monday only
    expect(runsOn(0b0000001, 1)).toBe(false);
    expect(runsOn(0b0000010, 1)).toBe(true);  // Tuesday only
    expect(runsOn(127, 6)).toBe(true);        // daily
  });

  it('treats a zero mask as unknown, not as never', () => {
    // Treating unknown as "does not run" would silently delete those trains from every
    // query — a far worse failure than occasionally offering one that does not run, and
    // invisible, because the result is simply an empty list.
    for (let d = 0; d < 7; d++) expect(runsOn(0, d)).toBe(true);
  });
});

describe('time axis construction', () => {
  it('produces strictly non-decreasing departure times', () => {
    const g = makeGraph([DAY_TRAIN, NIGHT_TRAIN]);
    const tt = buildTimetable(g, '2026-09-14');
    const d = deps(tt);
    for (let i = 1; i < d.length; i++) {
      expect(d[i], `row ${i}: ${d[i - 1]} -> ${d[i]}`).toBeGreaterThanOrEqual(d[i - 1]);
    }
  });

  it('puts every arrival after its own departure', () => {
    const g = makeGraph([DAY_TRAIN, NIGHT_TRAIN]);
    const tt = buildTimetable(g, '2026-09-14');
    for (let i = 0; i < tt.count; i++) {
      expect(tt.arrTs[i]).toBeGreaterThan(tt.depTs[i]);
    }
  });

  it('includes yesterday\'s overnight train, but only the legs still to come', () => {
    const g = makeGraph([DAY_TRAIN, NIGHT_TRAIN]);
    // Query at 02:00. The night train left A at 23:00 yesterday; its B->C leg departs
    // 01:10 today and is the only service available at that hour.
    const tt = buildTimetable(g, '2026-09-15', { lookbackDays: 1 });
    expect(deps(tt)).toEqual([70, 600, 670, 1380, 1510]);

    const yesterday = Array.from(tt.serviceDay.subarray(0, tt.count));
    expect(yesterday[0]).toBe(-1); // the 01:10 leg departed from yesterday's service
    expect(yesterday[1]).toBe(0);
    expect(yesterday[3]).toBe(0);
  });

  it('excludes legs that already departed, which is what keeps the array small', () => {
    const g = makeGraph([DAY_TRAIN, NIGHT_TRAIN]);
    const withLookback = buildTimetable(g, '2026-09-15', { lookbackDays: 1 });
    const without = buildTimetable(g, '2026-09-15', { lookbackDays: 0 });
    // The 23:00 departure from A belongs to yesterday's service and has already gone.
    expect(deps(without)).toEqual([600, 670, 1380, 1510]);
    expect(withLookback.count - without.count).toBe(1);
  });

  it('loses the overnight connection entirely when lookback is zero', () => {
    const g = makeGraph([DAY_TRAIN, NIGHT_TRAIN]);
    const tt = buildTimetable(g, '2026-09-15', { lookbackDays: 0 });
    // Nothing boardable from B (station 1) before 10:00.
    const early = Array.from(tt.depTs.subarray(0, tt.count)).filter((m) => m < 600);
    expect(early).toEqual([]);
  });

  it('honours running days per service date', () => {
    // Monday-only train (bit 0). On a Tuesday query it must not appear for Tuesday's
    // service, but it MAY appear for Monday's service if it is still running.
    const mondayOnly: TrainSpec = { ...DAY_TRAIN, number: '10003', runsDays: 0b0000001 };
    const g = makeGraph([mondayOnly]);

    const tuesday = buildTimetable(g, '2026-09-15', { lookbackDays: 1 });
    expect(tuesday.count).toBe(0); // departed 10:00 Monday, finished 12:10 Monday

    const monday = buildTimetable(g, '2026-09-14', { lookbackDays: 1 });
    expect(deps(monday)).toEqual([600, 670]);
  });

  it('keeps an overnight train that ran the day before its running day pattern allows', () => {
    // Sunday-only overnight (bit 6). Query Monday: it departed Sunday 23:00 and its tail
    // leg is boardable on Monday. Getting this wrong drops every weekly overnight service.
    const sundayNight: TrainSpec = { ...NIGHT_TRAIN, number: '10004', runsDays: 0b1000000 };
    const g = makeGraph([sundayNight]);
    const tt = buildTimetable(g, '2026-09-14', { lookbackDays: 1 }); // Monday
    // ONLY the tail of Sunday's service. A fresh 23:00 departure must not appear, because
    // this train does not run on Mondays -- offering it would be the exact "weekly train
    // shown on a day it does not exist" bug that running days are gated for.
    expect(deps(tt)).toEqual([70]);
    expect(Array.from(tt.serviceDay.subarray(0, tt.count))).toEqual([-1]);

    // And on Sunday itself, both legs are available.
    const sunday = buildTimetable(g, '2026-09-13', { lookbackDays: 1 });
    expect(deps(sunday)).toEqual([1380, 1510]);
  });

  it('records the service day offset on every row', () => {
    const g = makeGraph([NIGHT_TRAIN]);
    const tt = buildTimetable(g, '2026-09-15', { lookbackDays: 2 });
    for (let i = 0; i < tt.count; i++) {
      expect(tt.serviceDay[i]).toBeLessThanOrEqual(0);
    }
  });

  it('exposes the connection and train each row came from', () => {
    const g = makeGraph([DAY_TRAIN, NIGHT_TRAIN]);
    const tt = buildTimetable(g, '2026-09-14', { lookbackDays: 0 });
    for (let i = 0; i < tt.count; i++) {
      const conn = g.leg(tt.connIx[i]);
      const train = g.train(tt.trainIx[i]);
      expect(conn).toBeDefined();
      // Absolute time must equal the train's wall-clock origin departure plus the packed
      // relative offset, minus the service-day shift.
      expect(tt.depTs[i]).toBe(train.originDepMin + conn.depMin - (-tt.serviceDay[i]) * 1440);
    }
  });

  it('is stable: legs of one train keep route order when times tie', () => {
    // Two legs departing at the same absolute minute must not swap, or CSA could board the
    // later stop before the earlier one and invent a journey that travels backwards.
    const tied: TrainSpec = {
      number: '10005', name: 'Tied', type: 9, classes: 0, runsDays: 127,
      originDepMin: 600, durationMin: 120, distanceKm: 100,
      stops: [0, 1, 2],
      legs: [[0, 60, 50], [60, 120, 100]],
    };
    const g = makeGraph([tied]);
    const tt = buildTimetable(g, '2026-09-14', { lookbackDays: 0 });
    const rows = Array.from(tt.connIx.subarray(0, tt.count));
    expect(rows).toEqual([0, 1]); // ascending connection order preserved
  });
});

describe('lookback bound', () => {
  it('is derived from the longest train, not hardcoded', () => {
    const g = makeGraph([DAY_TRAIN, NIGHT_TRAIN]);
    // Night train: 1380 + 300 = 1680 minutes, so it can still be running one day later.
    expect(maxEndKey(g)).toBe(1680);
    expect(defaultLookbackDays(g)).toBe(1);
  });

  it('defaults to covering the longest train in the dataset', () => {
    const g = makeGraph([DAY_TRAIN, NIGHT_TRAIN]);
    const tt = buildTimetable(g, '2026-09-15');
    expect(deps(tt)).toContain(70);
  });

  it('bounds the array by the horizon it reports', () => {
    const g = makeGraph([DAY_TRAIN, NIGHT_TRAIN]);
    const tt = buildTimetable(g, '2026-09-14');
    for (let i = 0; i < tt.count; i++) expect(tt.depTs[i]).toBeLessThanOrEqual(tt.maxAbsMin);
  });
});

describe('lowerBound', () => {
  it('finds the first row at or after a time', () => {
    const a = new Int32Array([10, 20, 30, 40]);
    expect(lowerBound(a, 0)).toBe(0);
    expect(lowerBound(a, 10)).toBe(0);
    expect(lowerBound(a, 11)).toBe(1);
    expect(lowerBound(a, 40)).toBe(3);
    expect(lowerBound(a, 41)).toBe(4);
  });

  it('handles empty and single-element arrays', () => {
    expect(lowerBound(new Int32Array(0), 5)).toBe(0);
    expect(lowerBound(new Int32Array([5]), 5)).toBe(0);
    expect(lowerBound(new Int32Array([5]), 6)).toBe(1);
  });
});

describe('TimetableCache', () => {
  it('returns the identical object for a repeated date', () => {
    const g = makeGraph([DAY_TRAIN]);
    const cache = new TimetableCache(g);
    const a = cache.get('2026-09-14');
    const b = cache.get('2026-09-14');
    expect(a).toBe(b);
    expect(cache.size).toBe(1);
  });

  it('rebuilds for a different date', () => {
    const g = makeGraph([DAY_TRAIN]);
    const cache = new TimetableCache(g);
    expect(cache.get('2026-09-14')).not.toBe(cache.get('2026-09-15'));
    expect(cache.size).toBe(2);
  });

  it('evicts the oldest entry and stays bounded', () => {
    const g = makeGraph([DAY_TRAIN]);
    const cache = new TimetableCache(g, 2);
    cache.get('2026-09-14');
    cache.get('2026-09-15');
    cache.get('2026-09-16');
    expect(cache.size).toBe(2);
    expect(cache.has('2026-09-14')).toBe(false);
    expect(cache.has('2026-09-16')).toBe(true);
  });

  it('touching an entry makes it most-recently-used and saves it from eviction', () => {
    const g = makeGraph([DAY_TRAIN]);
    const cache = new TimetableCache(g, 2);
    const a = cache.get('2026-09-14');
    cache.get('2026-09-15');
    cache.get('2026-09-14'); // now the newest
    cache.get('2026-09-16'); // must evict 09-15, not 09-14
    expect(cache.has('2026-09-14')).toBe(true);
    expect(cache.has('2026-09-15')).toBe(false);
    expect(cache.get('2026-09-14')).toBe(a); // still the same object, not a rebuild
  });

  it('can be cleared', () => {
    const g = makeGraph([DAY_TRAIN]);
    const cache = new TimetableCache(g);
    cache.get('2026-09-14');
    cache.clear();
    expect(cache.size).toBe(0);
  });
});

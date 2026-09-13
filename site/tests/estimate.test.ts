/**
 * estimate.test.ts — the structural seat estimate.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS PINNED HERE, AND WHY IT IS NOT THE NUMBERS
 * ---------------------------------------------------------------------------
 * Nobody outside IRCTC can verify an occupancy figure for a particular train on a particular
 * date, and this project has no corpus to fit against — so a test that asserted "3A on 12951
 * twelve days out is 47 berths" would be pinning an invention and calling it a regression test.
 *
 * What CAN be pinned is ordering. Every constant in `estimate.ts` is an assumption, but the
 * relationships between them are the thing the file exists to reproduce, and they are exactly
 * what a careless edit breaks:
 *
 *   - nearer departure is worse than farther away;
 *   - a festival run-up is worse than an ordinary week;
 *   - Friday/Sunday are worse than Tuesday/Wednesday;
 *   - Sleeper runs fuller than 2A on the same train;
 *   - a longer leg competes for a bigger pool than a short hop;
 *   - Tatkal before it opens has NO answer, rather than an optimistic one.
 *
 * Plus the invariants that must hold for every input: a range that is ordered, a pool that never
 * exceeds the train's own capacity, a badge-bearing headline that never claims a berth exists, and
 * a deterministic answer for a fixed today.
 */
import { describe, expect, it } from 'vitest';
import {
  ESTIMATE_BADGE, ESTIMATE_METHOD, estimateChip, estimateForLeg, estimateSeats, worstEstimate,
  type SeatEstimate,
} from '../src/availability/estimate';
import type { TrainFacts } from '../src/availability/rake';

const mail: TrainFacts = {
  type: 'MEX', classes: ['1A', '2A', '3A', 'SL'], classesInferred: false,
  distanceKm: 1400, runsDays: 127,
};

const base = {
  train: mail,
  klass: '3A',
  legKm: 600,
  boardingDateIso: '2026-10-15',
  todayIso: '2026-10-01',
  boardCalls: 200,
  alightCalls: 150,
} as const;

const at = (over: Partial<Parameters<typeof estimateSeats>[0]> = {}): SeatEstimate =>
  estimateSeats({ ...base, ...over });

describe('ordering — the relationships the model exists to reproduce', () => {
  it('gets worse as departure approaches, never better', () => {
    const far = at({ todayIso: '2026-09-01' });
    const mid = at({ todayIso: '2026-09-25' });
    const near = at({ todayIso: '2026-10-12' });
    expect(far.loadIndex).toBeLessThan(mid.loadIndex);
    expect(mid.loadIndex).toBeLessThan(near.loadIndex);
  });

  it('rates a festival run-up worse than an ordinary week', () => {
    // Both are Mondays, both 5 days out, same train and leg — the only difference is that the
    // second falls in Diwali's six-day run-up.
    const ordinary = at({ boardingDateIso: '2026-10-05', todayIso: '2026-09-30' });
    const festival = at({ boardingDateIso: '2026-11-02', todayIso: '2026-10-28' });
    expect(festival.loadIndex).toBeGreaterThan(ordinary.loadIndex);
    expect(festival.factors.find((f) => f.label === 'Festival window')?.effect).toBeGreaterThan(1);
    expect(ordinary.factors.find((f) => f.label === 'Festival window')?.effect).toBe(1);
  });

  it('rates Friday and Sunday worse than Tuesday', () => {
    // Dates chosen so the day of the week is the only difference: same month, same weekday-
    // independent month factor, same distance to departure.
    const tuesday = at({ boardingDateIso: '2026-10-06', todayIso: '2026-10-01' });
    const sunday = at({ boardingDateIso: '2026-10-11', todayIso: '2026-10-06' });
    expect(sunday.loadIndex).toBeGreaterThan(tuesday.loadIndex);
  });

  it('runs Sleeper fuller than 2A on the same train', () => {
    expect(at({ klass: 'SL' }).loadIndex).toBeGreaterThan(at({ klass: '2A' }).loadIndex);
  });

  it('gives a long leg a bigger pool than a short hop', () => {
    const short = at({ legKm: 80 });
    const long = at({ legKm: 1_200 });
    expect(long.pool!.likely).toBeGreaterThan(short.pool!.likely);
    // …but never more than the train actually has.
    expect(long.pool!.likely).toBeLessThanOrEqual(long.capacity!.nominal);
  });

  it('treats a premium train as fuller than a passenger service', () => {
    const premium = at({ train: { ...mail, type: 'VNDB' } });
    const slow = at({ train: { ...mail, type: 'PAX' } });
    expect(premium.loadIndex).toBeGreaterThan(slow.loadIndex);
  });
});

describe('refusals — the two cases where a number would be an invention', () => {
  it('declines when the class is not on the train', () => {
    const e = at({ train: { ...mail, classes: ['SL', '2S'] }, klass: '1A' });
    expect(e.verdict).toBe('UNKNOWN');
    expect(e.seats).toBeNull();
    expect(e.waitlist).toBeNull();
    expect(e.pConfirm).toBeNull();
    expect(e.headline).toMatch(/not one of the classes/i);
  });

  it('declines when the class list itself is missing, rather than assuming one', () => {
    const e = at({ train: { type: 'SUB', classes: [], classesInferred: false, runsDays: 127 }, klass: 'SL' });
    expect(e.verdict).toBe('UNKNOWN');
    expect(e.headline).toMatch(/class list is missing/i);
  });

  it('declines for Tatkal before the day it opens', () => {
    const e = at({ quota: 'TQ', todayIso: '2026-10-01' });
    expect(e.verdict).toBe('UNKNOWN');
    expect(e.headline).toMatch(/day before departure/i);
    // And the refusal has to explain itself, not just decline.
    expect(e.caveats.join(' ')).toMatch(/separate/i);
  });

  it('answers for Tatkal on the day it opens', () => {
    const e = at({ quota: 'TQ', boardingDateIso: '2026-10-15', todayIso: '2026-10-14' });
    expect(e.verdict).not.toBe('UNKNOWN');
  });
});

describe('invariants — true for every estimate the model can produce', () => {
  const cases: SeatEstimate[] = [
    at(), at({ klass: 'SL' }), at({ klass: '1A' }), at({ klass: 'CC' }),
    at({ legKm: 12 }), at({ legKm: 2_500 }), at({ boardCalls: null, alightCalls: null }),
    at({ train: { ...mail, classesInferred: true } }), at({ quota: 'LD' }),
    at({ todayIso: '2026-10-15' }), at({ boardingDateIso: '2026-12-25', todayIso: '2026-10-01' }),
  ];

  it('keeps every range ordered and non-negative', () => {
    for (const e of cases) {
      if (e.seats) {
        expect(e.seats.low).toBeGreaterThanOrEqual(0);
        expect(e.seats.low).toBeLessThanOrEqual(e.seats.likely);
        expect(e.seats.likely).toBeLessThanOrEqual(e.seats.high);
      }
      if (e.waitlist) {
        expect(e.waitlist.low).toBeGreaterThanOrEqual(1);
        expect(e.waitlist.low).toBeLessThanOrEqual(e.waitlist.likely);
        expect(e.waitlist.likely).toBeLessThanOrEqual(e.waitlist.high);
      }
      if (e.pConfirm !== null) {
        expect(e.pConfirm).toBeGreaterThan(0);
        expect(e.pConfirm).toBeLessThanOrEqual(0.95);
      }
    }
  });

  it('never models a leg competing for more berths than the train has', () => {
    for (const e of cases) {
      if (e.pool && e.capacity) expect(e.pool.high).toBeLessThanOrEqual(e.capacity.high);
    }
  });

  it('always says what it is not', () => {
    for (const e of cases) {
      expect(e.caveats.length).toBeGreaterThanOrEqual(2);
      expect(e.caveats.join(' ')).toMatch(/not a reading from IRCTC/i);
    }
  });

  it('never writes a sentence that claims a berth exists', () => {
    for (const e of cases) {
      expect(e.headline).not.toMatch(/confirmed|guaranteed|seat available|seats available|berth available/i);
    }
  });

  it('is deterministic for a fixed today', () => {
    expect(JSON.stringify(at())).toBe(JSON.stringify(at()));
  });

  it('carries the badge word and the method string wherever it is rendered', () => {
    expect(ESTIMATE_BADGE).toBe('ESTIMATED');
    expect(ESTIMATE_METHOD).toMatch(/structural/);
    expect(ESTIMATE_METHOD).toMatch(/uncalibrated/);
  });
});

describe('the chip and the worst-leg rule', () => {
  it('names the class in the chip, because a berth count without one is ambiguous', () => {
    expect(estimateChip(at({ klass: 'SL' }))).toMatch(/SL/);
    expect(estimateChip(at({ klass: '2A' }))).toMatch(/2A/);
  });

  it('picks the hardest leg, and lets a declinature outrank nothing', () => {
    const fine = at({ klass: '2A', todayIso: '2026-08-01' });
    const bad = at({ klass: 'SL', todayIso: '2026-10-14', boardingDateIso: '2026-11-08' });
    const unknown = at({ klass: '1A', train: { ...mail, classes: ['SL', '2A'] } });

    expect(worstEstimate([fine, bad])!.verdict).toBe(bad.verdict);
    expect(worstEstimate([fine, null, fine])!.verdict).toBe(fine.verdict);
    // An unknown leg must not headline a card whose other legs were estimated.
    expect(worstEstimate([fine, unknown])!.verdict).toBe(fine.verdict);
    // …but if nothing is known, "cannot estimate" is the honest summary.
    expect(worstEstimate([unknown, null])!.verdict).toBe('UNKNOWN');
    expect(worstEstimate([])).toBeNull();
  });
});

describe('estimateForLeg — the adapter the UI calls', () => {
  const segment = {
    klass: 'SL', trainType: 'MEX', trainClasses: ['SL', '3A'],
    classesInferred: false, distKm: 420, runsDays: 127,
  };

  it('passes the corridor through when both ends are known, and omits it when they are not', () => {
    const known = estimateForLeg({
      segment, segmentRunsDaysAssumed: false, boardingDateIso: '2026-10-15',
      serviceDayOffset: 0, boardCalls: 240, alightCalls: 180, todayIso: '2026-10-01',
    });
    const unknown = estimateForLeg({
      segment, segmentRunsDaysAssumed: false, boardingDateIso: '2026-10-15',
      serviceDayOffset: 0, boardCalls: null, alightCalls: null, todayIso: '2026-10-01',
    });
    expect(known.factors.some((f) => f.label === 'Corridor size')).toBe(true);
    expect(unknown.factors.some((f) => f.label === 'Corridor size')).toBe(false);
  });

  it('does not pass an assumed-daily bitmask as if it were a service frequency', () => {
    const assumed = estimateForLeg({
      segment, segmentRunsDaysAssumed: true, boardingDateIso: '2026-10-15',
      serviceDayOffset: 0, boardCalls: null, alightCalls: null, todayIso: '2026-10-01',
    });
    expect(assumed.confidenceReasons.join(' ')).toMatch(/running days are unknown/i);
  });
});

/**
 * fares.test.ts — pin the fare model to the published fares it was calibrated against.
 *
 * There is no fare data in the source dataset, so this model is an estimate. The tests
 * exist to stop it drifting: if someone edits a knot or a multiplier without re-checking
 * against real IRCTC prices, these fail. They also pin the two properties that matter more
 * than absolute accuracy — the taper, and the rule that fare is per SEGMENT not per hop.
 */
import { describe, expect, it } from 'vitest';
import {
  CALIBRATION_ANCHORS, CALIBRATION_TOLERANCE_RUPEES, cheapestClass, estimateFare, isSuperfast,
  pricedClasses, segmentFare, slBase, SUPERFAST_KMH, typeMultiplier,
} from '../src/router/fares';

describe('calibration against published fares', () => {
  it.each(CALIBRATION_ANCHORS.map((a) => [
    `${a.klass} ${a.km} km on ${a.trainType}`, a,
  ] as const))('%s lands within the published fare', (_label, a) => {
    const got = segmentFare(a.km, a.klass, a.trainType, true);
    expect(Math.abs(got - a.total)).toBeLessThanOrEqual(CALIBRATION_TOLERANCE_RUPEES);
  });

  it('estimateFare agrees with segmentFare on the same inputs', () => {
    for (const a of CALIBRATION_ANCHORS) {
      const e = estimateFare({
        distanceKm: a.km, klass: a.klass, trainType: a.trainType, durationMin: a.km / 70 * 60,
      });
      expect(e.total).toBe(segmentFare(a.km, a.klass, a.trainType, true));
    }
  });

  it('prices the Delhi-Mumbai corridor at the fares a traveller would recognise', () => {
    // NDLS -> CSTM is ~1,384 km. Published: SL 555, 3A 1450, 2A 2055, 1A 3435.
    const km = 1384;
    expect(segmentFare(km, 'SL', 'SUF', true)).toBe(555);
    expect(segmentFare(km, '3A', 'SUF', true)).toBe(1452);
    expect(segmentFare(km, '2A', 'SUF', true)).toBe(2054);
    expect(segmentFare(km, '1A', 'SUF', true)).toBe(3435);
  });

  it('applies the class ratio to the BASE, not to the total', () => {
    // The mistake this pins. Published fares are quoted as TOTALS, so the tempting move is
    // to divide one total by another (1450/555 = 2.61) and use that as the class multiplier.
    // It is wrong, because the fixed reservation and superfast charges do not scale with
    // class: applying a total-ratio to a base understates 3A by about 10%, which is enough
    // to reorder two competing itineraries.
    const km = 1384;
    const totalRatio = 1450 / 555;
    const naiveBase = Math.round(slBase(km) * totalRatio);
    const naiveTotal = (naiveBase + 90) * 1.05;

    expect(naiveTotal).toBeLessThan(1450 * 0.92);
    expect(segmentFare(km, '3A', 'SUF', true)).toBeGreaterThan(naiveTotal);
    expect(Math.abs(segmentFare(km, '3A', 'SUF', true) - 1450))
      .toBeLessThanOrEqual(CALIBRATION_TOLERANCE_RUPEES);
  });
});

describe('the taper', () => {
  it('marginal rate per km falls as distance grows', () => {
    const marginal = (from: number, to: number): number => (slBase(to) - slBase(from)) / (to - from);
    const short = marginal(0, 200);
    const mid = marginal(500, 1000);
    const long = marginal(2000, 2500);
    expect(short).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(long);
  });

  it('is not a flat per-km rate, which would overstate long journeys by ~35%', () => {
    const flat = slBase(500) / 500 * 1384;
    const tapered = slBase(1384);
    expect(flat).toBeGreaterThan(tapered * 1.3);
  });

  it('keeps charging beyond the last knot rather than going flat', () => {
    expect(slBase(3500)).toBeGreaterThan(slBase(3000));
    expect(slBase(4000)).toBeGreaterThan(slBase(3500));
  });

  it('is monotonic and never negative', () => {
    let prev = -1;
    for (let km = 0; km <= 4000; km += 7) {
      const v = slBase(km);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});

describe('fare is per segment, never per hop', () => {
  it('ten 100 km hops cost far more than one 1,000 km ticket', () => {
    const perHop = Array.from({ length: 10 }, () => segmentFare(100, 'SL', 'SUF', true))
      .reduce((a, b) => a + b, 0);
    const whole = segmentFare(1000, 'SL', 'SUF', true);
    // This is the exact failure mode the router's segment merging exists to avoid.
    expect(perHop).toBeGreaterThan(whole * 2);
  });

  it('a merged ride is priced from its total distance', () => {
    expect(segmentFare(1000, 'SL', 'SUF', true))
      .toBe(segmentFare(400 + 600, 'SL', 'SUF', true));
  });
});

describe('class ordering', () => {
  it('is cheapest to dearest in the order travellers expect', () => {
    const km = 1000;
    const expected = ['2S', 'SL', '3E', 'CC', '3A', 'FC', '2A', 'EC', '1A'];
    const prices = expected.map((c) => segmentFare(km, c, 'MEX', true));
    for (let i = 1; i < prices.length; i++) {
      expect(prices[i], `${expected[i]} should cost more than ${expected[i - 1]}`)
        .toBeGreaterThan(prices[i - 1]);
    }
  });

  it('puts First Class (non-AC) between 3A and 2A, where IRCTC prices it', () => {
    const km = 1000;
    expect(segmentFare(km, '3A', 'MEX', true)).toBeLessThan(segmentFare(km, 'FC', 'MEX', true));
    expect(segmentFare(km, 'FC', 'MEX', true)).toBeLessThan(segmentFare(km, '2A', 'MEX', true));
  });

  it('lists priced classes cheapest first', () => {
    const cs = pricedClasses();
    const km = 800;
    for (let i = 1; i < cs.length; i++) {
      expect(segmentFare(km, cs[i], 'MEX', true))
        .toBeGreaterThanOrEqual(segmentFare(km, cs[i - 1], 'MEX', true));
    }
  });

  it('excludes unreserved from the priced list', () => {
    expect(pricedClasses()).not.toContain('UR');
  });

  it('cheapestClass skips UR, because an unreserved seat is not a bookable seat', () => {
    expect(cheapestClass(['UR', 'SL', '3A'])).toBe('SL');
    expect(cheapestClass(['UR', '2S', 'SL'])).toBe('2S');
    expect(cheapestClass(['UR'])).toBeNull();
    expect(cheapestClass([])).toBeNull();
  });

  it('falls back to sleeper for a class it does not recognise', () => {
    expect(estimateFare({ distanceKm: 800, klass: 'ZZ', trainType: 'MEX', durationMin: 900 }).klass)
      .toBe('SL');
  });
});

describe('train type multipliers', () => {
  const km = 1000;
  it('prices Rajdhani above a mail/express, for flexi fare and catering', () => {
    expect(segmentFare(km, '3A', 'RAJ', true)).toBeGreaterThan(segmentFare(km, '3A', 'MEX', true));
  });

  it('prices Garib Rath BELOW third AC, because that is what the product is', () => {
    // Getting this backwards would hide the cheapest comfortable option on a route.
    expect(segmentFare(km, '3A', 'GBR', true)).toBeLessThan(segmentFare(km, '3A', 'MEX', true));
  });

  it('prices Jan Shatabdi below a full Shatabdi', () => {
    expect(segmentFare(km, 'CC', 'JSB', true)).toBeLessThan(segmentFare(km, 'CC', 'SHT', true));
  });

  it('prices an ordinary passenger train below a mail/express', () => {
    expect(segmentFare(km, 'SL', 'PAX', false)).toBeLessThan(segmentFare(km, 'SL', 'MEX', true));
  });

  it('treats an unknown type as standard rather than returning NaN', () => {
    // Regression: `TYPE_MULTIPLIER[t] ?? 1.0` was written in one path and a bare
    // `TYPE_MULTIPLIER[t]` in the other, so an unrecognised type produced NaN fares that
    // silently poisoned every Pareto comparison downstream.
    expect(typeMultiplier('ZZZZ')).toBe(1.0);
    expect(segmentFare(km, 'SL', 'ZZZZ', true)).toBe(segmentFare(km, 'SL', 'MEX', true));
    expect(Number.isNaN(segmentFare(km, 'SL', 'ZZZZ', true))).toBe(false);
  });

  it('treats an unknown class as sleeper rather than NaN', () => {
    expect(segmentFare(km, 'ZZ', 'MEX', true)).toBe(segmentFare(km, 'SL', 'MEX', true));
  });
});

describe('superfast surcharge', () => {
  it(`triggers at ${SUPERFAST_KMH} km/h average, inclusive`, () => {
    expect(isSuperfast(550, 600)).toBe(true);   // exactly 55 km/h
    expect(isSuperfast(549, 600)).toBe(false);
  });

  it('is computed from the train, not from its name', () => {
    // A slow "Express" does not earn the surcharge; a fast passenger train would.
    const slowExpress = estimateFare({ distanceKm: 300, klass: 'SL', trainType: 'MEX', durationMin: 540 });
    const fastExpress = estimateFare({ distanceKm: 300, klass: 'SL', trainType: 'MEX', durationMin: 300 });
    expect(slowExpress.superfast).toBe(0);
    expect(fastExpress.superfast).toBe(45);
  });

  it('always applies to premium types, whose published fares carry it', () => {
    // A Rajdhani is fast by construction; the guard avoids losing the surcharge when a
    // dataset reports a duration that makes the measured speed look low.
    const e = estimateFare({ distanceKm: 200, klass: '3A', trainType: 'RAJ', durationMin: 400 });
    expect(e.superfast).toBe(45);
  });

  it('is zero on degenerate input rather than Infinity km/h', () => {
    expect(isSuperfast(0, 600)).toBe(false);
    expect(isSuperfast(500, 0)).toBe(false);
  });
});

describe('breakdown', () => {
  it('adds up: base + reservation + superfast + GST = total', () => {
    const e = estimateFare({ distanceKm: 1200, klass: '3A', trainType: 'SUF', durationMin: 1000 });
    expect(e.base + e.reservation + e.superfast + e.gst).toBe(e.total);
  });

  it('charges 5% GST', () => {
    const e = estimateFare({ distanceKm: 1200, klass: '3A', trainType: 'SUF', durationMin: 1000 });
    expect(e.gst).toBe(Math.round((e.base + e.reservation + e.superfast) * 0.05));
  });

  it('flags flexi trains, whose real fare moves with demand', () => {
    expect(estimateFare({ distanceKm: 900, klass: '3A', trainType: 'RAJ', durationMin: 700 }).flexi)
      .toBe(true);
    expect(estimateFare({ distanceKm: 900, klass: '3A', trainType: 'MEX', durationMin: 900 }).flexi)
      .toBe(false);
  });

  it('propagates classesInferred so the UI can warn', () => {
    expect(estimateFare({
      distanceKm: 900, klass: 'SL', trainType: 'MEX', durationMin: 900, classesInferred: true,
    }).classesInferred).toBe(true);
  });

  it('reports a per-km rate of zero for a zero-distance segment', () => {
    expect(estimateFare({ distanceKm: 0, klass: 'SL', trainType: 'MEX', durationMin: 0 }).perKm)
      .toBe(0);
  });
});

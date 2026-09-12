/**
 * availability.test.ts — the Phase 2 availability layer.
 *
 * The tests here are written against published facts rather than against the implementation,
 * because almost every constant in this layer is one a traveller will act on by setting an alarm
 * or buying a ticket. A test that asserts `advanceBookingOpens(x)` equals whatever the code
 * produces would pass with the code wrong. So the ARP tests assert three date pairs taken from
 * IRCTC's published 60-day rule, the Tatkal tests assert the origin-day convention against the
 * worked example it is usually got wrong on, and the status tests assert that two waitlist types
 * with the same position do NOT compare equal.
 *
 * The other half of this file asserts what the layer refuses to do: coerce an unrecognised string
 * into a verdict, rank a split by fare, or present a remedy as an answer when no availability
 * source is connected. Those are the failures that would make a planning tool actively harmful,
 * and they are all easy to introduce by accident during a refactor.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Stop } from '../src/lib/graph';
import {
  parseStatus, formatStatus, compareStatus, worstStatus, canTravel, isDefinite,
  WAITLIST_SEVERITY, WAITLIST_OUTLOOK,
} from '../src/availability/status';
import {
  ARP_DAYS, BOOKING_OPENS_MIN, AADHAAR_PRIORITY_ENDS_MIN, TATKAL_AC_OPENS_MIN,
  TATKAL_NONAC_OPENS_MIN, MAX_PAX_GENERAL, MAX_PAX_TATKAL, QUOTAS,
  advanceBookingOpens, isWithinArp, arpDaysRemaining, tatkalOpens, hasTatkal, isAcClass,
  isInMaintenanceWindow, originDateOf, addDays, daysBetween, bookingFacts, runsOnDate, istNow,
} from '../src/availability/rules';
import {
  splitCandidates, offerable, MIN_SPLIT_HALT_MIN, WARN_SPLIT_HALT_MIN, SHORT_SEGMENT_KM,
  disclosuresFor, SPLIT_FRAMING,
} from '../src/availability/split';
import {
  remediesForLeg, remedyQueries, computableNow, remediesSummary, runsOn, type LegRef,
  type RemedyContext,
} from '../src/availability/remedies';
import {
  AvailabilityCascade, noReading, queryKey, type AvailabilityQuery, type AvailabilityReading,
  type AvailabilitySource,
} from '../src/availability/tier';
import {
  handoff, handoffFields, IRCTC_TRAIN_SEARCH, IRCTC_CHARTS_VACANCY, INDIANRAIL_PNR_ENQUIRY,
  VERIFIED_URLS, prefill,
} from '../src/availability/links';
import type { RailSegment } from '../src/router/journey';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A stop list for a 600 km train with deliberately varied halts. */
function stops(specs: Array<[number, string, string, number, number]>): Stop[] {
  return specs.map(([station, code, name, haltMin, distKm], i) => ({
    seq: i + 1, station, code, name,
    arrMin: i === 0 ? null : 600 + distKm,
    depMin: i === specs.length - 1 ? null : 600 + distKm + haltMin,
    haltMin, distKm, dayOff: 0,
  }));
}

const SIX_STOPS = stops([
  [0, 'ALP', 'Alpha Jn', 0, 0],
  [1, 'BET', 'Beta', 25, 120],      // comfortable halt, long first half
  [2, 'GAM', 'Gamma', 6, 200],      // too short to split at
  [3, 'DEL', 'Delta Jn', 15, 320],  // rushed-change territory
  [4, 'EKO', 'Echo', 0, 400],       // does not halt
  [5, 'ZED', 'Zed', 0, 600],
]);

function railSeg(over: Partial<RailSegment> = {}): RailSegment {
  return {
    kind: 'rail', from: 0, to: 5, depMin: 600, arrMin: 1200, durationMin: 600, hops: 5,
    distKm: 600, fareRupees: 500, baseFare: 400, reservation: 45, surcharge: 30, gst: 25,
    trainIx: 0, trainNumber: '12927', trainName: 'Test Express', trainType: 'SUF', klass: 'SL',
    classFellBack: false, fareEstimate: true, flexiFare: false, runsDaysAssumed: false,
    classesInferred: false, serviceDayOffset: 0, nightArrival: false,
    trainClasses: ['SL', '3A', '2A'], runsDays: 127, ...over,
  };
}

function legRef(over: Partial<LegRef> = {}): LegRef {
  return { segment: railSeg(), boardCode: 'ALP', alightCode: 'ZED', dateIso: '2026-09-20', ...over };
}

function ctx(over: Partial<RemedyContext> = {}): RemedyContext {
  return {
    todayIso: '2026-09-12',
    offeredClasses: ['SL', '3A', '2A'],
    runsDaysAssumed: false,
    runsDays: 127,
    boardAlternatives: [{ code: 'ALR', name: 'Alpha Road', minutesByRoad: 45 }],
    alightAlternatives: [],
    stops: SIX_STOPS,
    alternativeItineraries: 3,
    roadHopPresent: false,
    ...over,
  };
}

const Q: AvailabilityQuery = {
  trainNumber: '12927', board: 'ALP', alight: 'ZED', dateIso: '2026-09-20', klass: 'SL', quota: 'GN',
};

// ---------------------------------------------------------------------------

describe('availability status parsing', () => {
  it('reads the forms IRCTC actually emits', () => {
    expect(parseStatus('AVAILABLE-0042')).toMatchObject({ verdict: 'AVAILABLE', seats: 42, parsed: true });
    expect(parseStatus('AVAILABLE 7')).toMatchObject({ verdict: 'AVAILABLE', seats: 7 });
    expect(parseStatus('RAC 12')).toMatchObject({ verdict: 'RAC', racPosition: 12 });
    expect(parseStatus('GNWL14/RAC28'))
      .toMatchObject({ verdict: 'WAITLISTED', wlType: 'GNWL', wlPosition: 14, racPosition: 28 });
    expect(parseStatus('WL 23')).toMatchObject({ verdict: 'WAITLISTED', wlType: 'WL', wlPosition: 23 });
    expect(parseStatus('PQWL8/WL')).toMatchObject({ verdict: 'WAITLISTED', wlType: 'PQWL', wlPosition: 8 });
    expect(parseStatus('REGRET')).toMatchObject({ verdict: 'REGRET' });
    expect(parseStatus('NOT AVAILABLE')).toMatchObject({ verdict: 'REGRET' });
  });

  it('keeps the RAC position from a combined string, which the bare-waitlist pattern would drop', () => {
    // Order of patterns is load-bearing: GNWL14/RAC28 also matches the bare-waitlist pattern, so
    // trying that one first would silently discard the RAC half.
    const s = parseStatus('GNWL14/RAC28');
    expect(s.racPosition).toBe(28);
    expect(s.wlPosition).toBe(14);
  });

  it('never coerces unrecognised text into a verdict', () => {
    for (const junk of [null, undefined, '', '   ', 'maybe?', 'AVAILABLE SOON', 'WL/??']) {
      const s = parseStatus(junk);
      expect(s.verdict, `input ${JSON.stringify(junk)}`).toBe('UNKNOWN');
      expect(s.parsed, `input ${JSON.stringify(junk)}`).toBe(false);
      expect(isDefinite(s)).toBe(false);
    }
    // "no seats" must not become REGRET by accident, and REGRET must not become "no seats":
    // the original string survives so the traveller can see what the source actually said.
    expect(parseStatus('AVAILABLE SOON').raw).toBe('AVAILABLE SOON');
  });

  it('round-trips every status it can parse', () => {
    for (const text of ['AVAILABLE-0042', 'RAC 12', 'GNWL14/RAC28', 'PQWL8', 'REGRET']) {
      const once = parseStatus(text);
      expect(parseStatus(formatStatus(once))).toEqual(once);
    }
  });

  it('formats with the quota attached, never as a bare number', () => {
    // The formatting bug this guards is the one that turns PQWL 8 into "WL 8" on screen.
    expect(formatStatus(parseStatus('PQWL8'))).toBe('PQWL8');
    expect(formatStatus(parseStatus('GNWL14/RAC28'))).toBe('GNWL14/RAC28');
    expect(formatStatus(parseStatus('AVAILABLE-0042'))).toBe('AVAILABLE-0042');
    expect(formatStatus(parseStatus('???'))).toContain('???');
  });

  it('treats RAC as a seat on the train, not as a waitlist', () => {
    expect(canTravel(parseStatus('RAC 12'))).toBe(true);
    expect(canTravel(parseStatus('AVAILABLE-0001'))).toBe(true);
    expect(canTravel(parseStatus('GNWL3'))).toBe(false);
    expect(canTravel(parseStatus('REGRET'))).toBe(false);
    expect(canTravel(parseStatus(null))).toBe(false);
  });

  it('ranks PQWL 8 materially worse than GNWL 8', () => {
    const gn = parseStatus('GNWL8');
    const pq = parseStatus('PQWL8');
    expect(compareStatus(gn, pq)).toBeLessThan(0);
    expect(WAITLIST_SEVERITY.PQWL).toBeGreaterThan(WAITLIST_SEVERITY.GNWL);
    // And both are explained, because a number without its quota is not actionable.
    expect(WAITLIST_OUTLOOK.PQWL).toMatch(/never clears|materially worse/i);
    expect(WAITLIST_OUTLOOK.GNWL).toMatch(/best odds/i);
  });

  it('treats a Tatkal waitlist as the worst outcome, because no cascade reaches it', () => {
    const tq = parseStatus('TQWL2');
    const gn = parseStatus('GNWL40');
    // TQWL 2 is a better NUMBER than GNWL 40 and a far worse situation.
    expect(compareStatus(gn, tq)).toBeLessThan(0);
    expect(WAITLIST_OUTLOOK.TQWL).toMatch(/never clears/i);
  });

  it('orders verdicts go, travel-with-a-shared-berth, waitlist, closed, unknown', () => {
    const order = ['AVAILABLE-0005', 'RAC 3', 'GNWL1', 'REGRET', 'zzz'].map(parseStatus);
    for (let i = 1; i < order.length; i++) {
      expect(compareStatus(order[i - 1], order[i]), `${order[i - 1].verdict} vs ${order[i].verdict}`)
        .toBeLessThan(0);
    }
  });

  it('prefers more seats, and a lower waitlist position, within a verdict', () => {
    expect(compareStatus(parseStatus('AVAILABLE-0042'), parseStatus('AVAILABLE-0003'))).toBeLessThan(0);
    expect(compareStatus(parseStatus('GNWL3'), parseStatus('GNWL40'))).toBeLessThan(0);
    expect(compareStatus(parseStatus('RAC 2'), parseStatus('RAC 30'))).toBeLessThan(0);
  });

  it('summarises an itinerary by its worst leg, not its best', () => {
    // Two AVAILABLE legs and one PQWL 40 is a PQWL 40 journey. Presenting it as "2 of 3
    // available" is the optimistic framing this module exists to prevent.
    const worst = worstStatus([parseStatus('AVAILABLE-0042'), parseStatus('PQWL40'), parseStatus('RAC 3')]);
    expect(worst.wlType).toBe('PQWL');
    expect(worst.wlPosition).toBe(40);
    expect(worstStatus([]).verdict).toBe('UNKNOWN');
  });

  it('never mentions a probability, because there is no model behind these numbers', () => {
    // The whole file must stay ordinal. A pConfirm here would be an invented coefficient
    // dressed as a prediction, which is the one failure worse than publishing nothing.
    const src = Object.values(WAITLIST_SEVERITY);
    expect(src.every((v) => Number.isInteger(v) && v >= 0 && v <= 10)).toBe(true);
  });
});

describe('IRCTC booking rules', () => {
  it('opens advance booking exactly 60 days out, on three published worked examples', () => {
    // Taken from IRCTC's published rule as stated by three independent sources, all of which
    // agree the gap is 60 days. Asserting the pairs rather than a formula pins the convention to
    // fact: getting it inclusive would open the alarm a day late and cost the ticket.
    expect(advanceBookingOpens('2026-11-10').date).toBe('2026-09-11');
    expect(advanceBookingOpens('2026-08-30').date).toBe('2026-07-01');
    expect(advanceBookingOpens('2026-03-15').date).toBe('2026-01-14');
    expect(advanceBookingOpens('2026-11-10').minute).toBe(BOOKING_OPENS_MIN);
    expect(advanceBookingOpens('2026-11-10').label).toMatch(/08:00 IST/);
    expect(ARP_DAYS).toBe(60);
  });

  it('says a journey is bookable on the opening morning itself, and not the day before', () => {
    expect(isWithinArp('2026-11-10', '2026-09-11')).toBe(true);  // opening day
    expect(isWithinArp('2026-11-10', '2026-09-10')).toBe(false); // one day too early
    expect(isWithinArp('2026-11-10', '2026-11-10')).toBe(true);  // day of travel
    expect(arpDaysRemaining('2026-11-10', '2026-09-11')).toBe(0);
    expect(arpDaysRemaining('2026-11-10', '2026-09-10')).toBe(-1);
    expect(arpDaysRemaining('2026-11-10', '2026-09-20')).toBe(9);
  });

  it('gives Aadhaar-verified users their priority window at the opening', () => {
    expect(AADHAAR_PRIORITY_ENDS_MIN).toBe(BOOKING_OPENS_MIN + 15);
  });

  it('opens Tatkal at 10:00 for AC and 11:00 for non-AC, one day before', () => {
    expect(tatkalOpens('2026-09-20', '3A')).toMatchObject({ date: '2026-09-19', minute: TATKAL_AC_OPENS_MIN });
    expect(tatkalOpens('2026-09-20', 'SL')).toMatchObject({ date: '2026-09-19', minute: TATKAL_NONAC_OPENS_MIN });
    expect(TATKAL_AC_OPENS_MIN).toBe(600);
    expect(TATKAL_NONAC_OPENS_MIN).toBe(660);
  });

  it('refuses to invent a Tatkal window for First AC, which has no Tatkal quota', () => {
    expect(hasTatkal('1A')).toBe(false);
    const w = tatkalOpens('2026-09-20', '1A');
    expect(w?.reason).toMatch(/no Tatkal quota/i);
    // The reason must be surfaced, not swallowed: "Tatkal opens at 10:00" is actively wrong here.
    expect(w?.label).toMatch(/no tatkal/i);
  });

  it('files First Class as non-AC despite the name, so Tatkal opens at 11:00', () => {
    expect(isAcClass('FC')).toBe(false);
    expect(hasTatkal('FC')).toBe(true);
    expect(tatkalOpens('2026-09-20', 'FC')?.minute).toBe(TATKAL_NONAC_OPENS_MIN);
  });

  it('counts every booking window from the ORIGIN departure date, not the boarding date', () => {
    // The verified worked example: 12927 leaves Dadar at 23:50 on 24 January and you board at
    // Borivali at 00:06 on 25 January. Tatkal opens against the 24th, so it opens on the 23rd.
    // Getting this wrong sets the alarm an entire day late.
    expect(originDateOf('2026-01-25', -1)).toBe('2026-01-24');
    expect(tatkalOpens('2026-01-24', 'SL')?.date).toBe('2026-01-23');
    // A same-day train is unaffected, which is the case that must not regress.
    expect(originDateOf('2026-01-25', 0)).toBe('2026-01-25');
  });

  it('reports the maintenance window, which straddles midnight', () => {
    expect(isInMaintenanceWindow(23 * 60 + 50)).toBe(true);   // 23:50
    expect(isInMaintenanceWindow(23 * 60 + 45)).toBe(true);   // 23:45 exactly
    expect(isInMaintenanceWindow(10)).toBe(true);             // 00:10
    expect(isInMaintenanceWindow(23 * 60 + 44)).toBe(false);  // 23:44
    expect(isInMaintenanceWindow(30)).toBe(false);            // 00:30
    expect(isInMaintenanceWindow(12 * 60)).toBe(false);       // noon
    // A naive `start <= m && m < end` reports the window as never open, because 1425 is never
    // less than 20. This is the assertion that catches that.
    expect(isInMaintenanceWindow(23 * 60 + 45)).not.toBe(isInMaintenanceWindow(23 * 60 + 44));
  });

  it('caps passengers per ticket, lower for Tatkal', () => {
    expect(MAX_PAX_GENERAL).toBe(6);
    expect(MAX_PAX_TATKAL).toBe(4);
    expect(MAX_PAX_TATKAL).toBeLessThan(MAX_PAX_GENERAL);
  });

  it('states who may use each non-general quota', () => {
    for (const q of QUOTAS) {
      if (q.code === 'GN') { expect(q.eligibility).toBeNull(); continue; }
      // An eligibility-free suggestion of a restricted quota sends someone to a form that
      // rejects them, which is worse than not suggesting it.
      expect(q.eligibility, `${q.code} must say who it is for`).toBeTruthy();
    }
    expect(QUOTAS.map((q) => q.code)).toEqual(['GN', 'TQ', 'PT', 'LD', 'SS', 'HP', 'DF', 'FT']);
  });

  it('knows which day of the week a date is, with Monday as bit 0', () => {
    // 2026-09-14 is a Monday; 2026-09-20 is a Sunday. The packing convention is bit 0 = Monday,
    // so a Sunday-only mask is 0b1000000.
    expect(runsOn(0b0000001, '2026-09-14')).toBe(true);   // Monday-only, on a Monday
    expect(runsOn(0b0000001, '2026-09-20')).toBe(false);  // Monday-only, on a Sunday
    expect(runsOn(0b1000000, '2026-09-20')).toBe(true);   // Sunday-only, on a Sunday
    expect(runsOn(127, '2026-09-20')).toBe(true);         // daily
    expect(runsOnDate(127, '2026-09-20')).toBe(true);
  });

  it('assembles the facts a traveller needs together, and says when they cannot book yet', () => {
    const f = bookingFacts('2026-11-10', 0, 'SL', '2026-09-01', 12 * 60);
    expect(f.withinArp).toBe(false);
    expect(f.notes.join(' ')).toMatch(/not bookable yet/i);
    expect(f.notes.join(' ')).toMatch(/2026-09-11/);
  });

  it('warns when a train started the previous day, because it is counter-intuitive', () => {
    const f = bookingFacts('2026-01-25', -1, 'SL', '2026-01-20', 12 * 60);
    expect(f.crossesMidnightFromOrigin).toBe(true);
    expect(f.originDate).toBe('2026-01-24');
    expect(f.notes.join(' ')).toMatch(/origin/i);
  });

  it('warns about the maintenance window when it is currently closed', () => {
    expect(bookingFacts('2026-09-20', 0, 'SL', '2026-09-12', 23 * 60 + 50).maintenanceWarning).toBe(true);
    expect(bookingFacts('2026-09-20', 0, 'SL', '2026-09-12', 12 * 60).maintenanceWarning).toBe(false);
  });

  it('adds and compares ISO dates without a timezone shifting the day', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2024-03-01', -1)).toBe('2024-02-29'); // leap year
    expect(daysBetween('2026-09-11', '2026-11-10')).toBe(60);
    expect(daysBetween('2026-11-10', '2026-09-11')).toBe(-60);
  });
});

describe('same-train splitting', () => {
  it('blocks a split where the halt is too short to change coaches', () => {
    const cands = splitCandidates({ stops: SIX_STOPS, boardStation: 0, alightStation: 5 });
    const gamma = cands.find((c) => c.code === 'GAM');
    expect(gamma?.haltMin).toBe(6);
    expect(gamma?.blocked).toMatch(/only 6 minutes|not enough/i);
    expect(offerable(cands).some((c) => c.code === 'GAM')).toBe(false);
  });

  it('blocks a split at a station the train does not halt at', () => {
    const cands = splitCandidates({ stops: SIX_STOPS, boardStation: 0, alightStation: 5 });
    const echo = cands.find((c) => c.code === 'EKO');
    expect(echo?.haltMin).toBe(0);
    expect(echo?.blocked).toMatch(/does not halt/i);
  });

  it('warns on a halt that is legal but rushed', () => {
    const cands = splitCandidates({ stops: SIX_STOPS, boardStation: 0, alightStation: 5 });
    const delta = cands.find((c) => c.code === 'DEL');
    expect(delta?.haltMin).toBe(15);
    expect(delta?.blocked).toBeNull();
    expect(delta?.warning).toMatch(/rushed/i);
    expect(WARN_SPLIT_HALT_MIN).toBe(20);
    expect(MIN_SPLIT_HALT_MIN).toBe(10);
  });

  it('warns when one half is short enough to get a poor quota allotment', () => {
    // Beta is 120 km in, so the first half is long and the second is 480 km: neither is short.
    // Build a case where one half is under the threshold and check the warning appears.
    const short = stops([
      [0, 'ALP', 'Alpha Jn', 0, 0], [1, 'NEA', 'Near', 30, 40], [2, 'ZED', 'Zed', 0, 600],
    ]);
    const cands = splitCandidates({ stops: short, boardStation: 0, alightStation: 2 });
    expect(cands[0].blocked).toBeNull();
    expect(cands[0].warning).toMatch(/small quota|REGRET/i);
    expect(SHORT_SEGMENT_KM).toBe(100);
  });

  it('returns blocked candidates too, so the UI can explain why a station was not offered', () => {
    const cands = splitCandidates({ stops: SIX_STOPS, boardStation: 0, alightStation: 5 });
    expect(cands.length).toBe(4);          // every intermediate stop
    expect(offerable(cands).length).toBe(2); // Beta and Delta only
    expect(cands.filter((c) => c.blocked).every((c) => (c.blocked ?? '').length > 10)).toBe(true);
  });

  it('attaches every required disclosure to every candidate', () => {
    const cands = splitCandidates({ stops: SIX_STOPS, boardStation: 0, alightStation: 5 });
    for (const c of cands) {
      const text = c.disclosures.join(' ');
      expect(text, c.code).toMatch(/TWO separate tickets/i);
      expect(text, c.code).toMatch(/change berths or coaches/i);
      expect(text, c.code).toContain(c.name);
      expect(text, c.code).toMatch(/grey area/i);
      expect(text, c.code).toMatch(/ticket-checking staff/i);
      expect(text, c.code).toMatch(/partial journey/i);
      expect(text, c.code).toMatch(/halt/i);
    }
  });

  it('states the distance is unchanged, so a split cannot read as a shorter cheaper journey', () => {
    const text = disclosuresFor('Beta', 25, 120, 480).join(' ');
    expect(text).toMatch(/600 km/);
    expect(text).toMatch(/same distance as the direct ticket/i);
  });

  it('reports the share of the run each half covers, which is what drives quota allotment', () => {
    const cands = splitCandidates({ stops: SIX_STOPS, boardStation: 0, alightStation: 5 });
    const beta = cands.find((c) => c.code === 'BET')!;
    expect(beta.firstKm).toBe(120);
    expect(beta.secondKm).toBe(480);
    expect(beta.firstShare).toBeCloseTo(0.2, 5);
    expect(beta.secondShare).toBeCloseTo(0.8, 5);
    expect(beta.firstShare + beta.secondShare).toBeCloseTo(1, 5);
  });

  it('costs the split the second reservation charge and says so', () => {
    const cands = splitCandidates({ stops: SIX_STOPS, boardStation: 0, alightStation: 5 });
    expect(cands.every((c) => c.extraReservationRupees > 0)).toBe(true);
    const custom = splitCandidates({ stops: SIX_STOPS, boardStation: 0, alightStation: 5, reservationRupees: 60 });
    expect(custom[0].extraReservationRupees).toBe(60);
  });

  it('finds nothing to split when the two stations are adjacent', () => {
    expect(splitCandidates({ stops: SIX_STOPS, boardStation: 0, alightStation: 1 })).toEqual([]);
    // And nothing when the stations are not on this train at all.
    expect(splitCandidates({ stops: SIX_STOPS, boardStation: 99, alightStation: 5 })).toEqual([]);
  });

  it('never presents splitting as risk-free or as a trick', () => {
    expect(SPLIT_FRAMING).toMatch(/trade-offs/i);
    expect(SPLIT_FRAMING).toMatch(/not a trick that works/i);
    expect(SPLIT_FRAMING).toMatch(/direct ticket is always shown alongside/i);
  });

  it('carries no fare ranking, because fare must never be the reason to split', () => {
    const cands = splitCandidates({ stops: SIX_STOPS, boardStation: 0, alightStation: 5 });
    for (const c of cands) {
      // The only money on a candidate is the extra cost of doing it, never a saving. A cheaper
      // split ranked first is arbitrage advice, which docs/04 §5 forbids.
      expect(Object.keys(c)).not.toContain('fareRupees');
      expect(Object.keys(c)).not.toContain('saving');
      expect(c.extraReservationRupees).toBeGreaterThan(0);
    }
    // And the order is station order, not any kind of score.
    expect(cands.map((c) => c.station)).toEqual([1, 2, 3, 4]);
  });
});

describe('the seven remedies', () => {
  it('returns all seven, in the documented order, even when some have no options', () => {
    const r = remediesForLeg(legRef(), ctx());
    expect(r.map((x) => x.id))
      .toEqual(['split', 'date', 'quota', 'class', 'route', 'terminal', 'intermodal']);
    // An empty remedy with an explanation beats a remedy that silently disappeared: the
    // traveller can see it was considered.
    expect(r.every((x) => x.title.length > 0 && x.rationale.length > 20)).toBe(true);
  });

  it('separates what the timetable can answer from what needs availability', () => {
    const r = remediesForLeg(legRef(), ctx());
    const now = computableNow(r).map((x) => x.id);
    expect(now).toEqual(['route', 'terminal', 'intermodal']);
    expect(remediesSummary(r)).toMatch(/3 of the 7/);
    expect(remediesSummary(r)).toMatch(/exact questions/i);
  });

  it('offers split candidates with both halves as separate questions', () => {
    const r = remediesForLeg(legRef(), ctx());
    const split = r[0];
    expect(split.needsAvailability).toBe(true);
    expect(split.splits?.length).toBe(2);
    expect(split.options.length).toBe(4); // two halves for each of two split points
    expect(split.note).toMatch(/not a trick that works/i);
    expect(split.options[0].query?.alight).toBe('BET');
    expect(split.options[1].query?.board).toBe('BET');
  });

  it('offers date shifts and rules out days the train does not run', () => {
    // A Monday-only train: 2026-09-20 is a Sunday, so shifting to it must be ruled out rather
    // than offered as though it were a normal option.
    const r = remediesForLeg(legRef({ dateIso: '2026-09-19' }), ctx({ runsDays: 0b0000001 }));
    const date = r.find((x) => x.id === 'date')!;
    expect(date.options.length).toBe(5);
    const ruled = date.options.filter((o) => o.ruledOut);
    expect(ruled.length).toBeGreaterThan(0);
    expect(ruled.every((o) => (o.ruledOut ?? '').match(/does not run/i))).toBe(true);
    // A ruled-out option still appears, with its reason, and poses no query.
    expect(ruled.every((o) => o.query === null)).toBe(true);
  });

  it('does not rule out any date when the dataset has no running days', () => {
    const r = remediesForLeg(legRef(), ctx({ runsDaysAssumed: true, runsDays: 127 }));
    const date = r.find((x) => x.id === 'date')!;
    expect(date.options.every((o) => o.ruledOut === null)).toBe(true);
    // But it must say so, because "assumed daily" is a guess the traveller is relying on.
    expect(date.note).toMatch(/no running-days data/i);
  });

  it('shifts dates against the origin departure, not the boarding date', () => {
    const r = remediesForLeg(
      legRef({ dateIso: '2026-01-25', segment: railSeg({ serviceDayOffset: -1 }) }),
      ctx(),
    );
    const date = r.find((x) => x.id === 'date')!;
    // Boarding 2026-01-26 on a train that originated 2026-01-25 asks about 2026-01-25.
    const plus1 = date.options.find((o) => o.label === '+1 day')!;
    expect(plus1.query?.dateIso).toBe('2026-01-25');
  });

  it('rules out Tatkal for First AC and says why, rather than omitting it', () => {
    // The train has to actually run 1A for this to be a statement about Tatkal. Asking for a
    // class the train does not carry is a larger problem, and Tier 0 now reports that first.
    const r = remediesForLeg(
      legRef({ segment: railSeg({ klass: '1A' }) }),
      ctx({ offeredClasses: ['1A', '2A', '3A', 'SL'] }),
    );
    const quota = r.find((x) => x.id === 'quota')!;
    expect(quota.note).toMatch(/no Tatkal quota/i);
    for (const code of ['TQ', 'PT']) {
      const o = quota.options.find((x) => x.label.startsWith(code))!;
      expect(o.ruledOut).toMatch(/no Tatkal quota/i);
      expect(o.query).toBeNull();
    }
    // The eligible-restriction quotas still carry their eligibility, so nobody is sent to a
    // booking form that will reject them.
    const ld = quota.options.find((x) => x.label.startsWith('LD'))!;
    expect(ld.cost).toMatch(/woman travelling alone/i);
  });

  it('says how large each quota pool is, because that decides whether switching is worth it', () => {
    const r = remediesForLeg(legRef(), ctx({ offeredClasses: ['SL', '3A', '2A'] }));
    const quota = r.find((x) => x.id === 'quota')!;
    const ld = quota.options.find((x) => x.label.startsWith('LD'))!;
    // Six lower berths per Sleeper coach is the published figure, and it is the whole reason
    // the Ladies quota is often free while the general pool is not.
    expect(ld.note).toMatch(/6 lower berths/i);
    const tq = quota.options.find((x) => x.label.startsWith('TQ'))!;
    expect(tq.note).toMatch(/Pool:/);
    expect(tq.note).toMatch(/sleeper/i);
    // A ruled-out option gets no pool note: there is no pool to describe.
    const r1a = remediesForLeg(
      legRef({ segment: railSeg({ klass: '1A' }) }),
      ctx({ offeredClasses: ['1A', '2A', '3A', 'SL'] }),
    );
    const tq1a = r1a.find((x) => x.id === 'quota')!.options.find((x) => x.label.startsWith('TQ'))!;
    expect(tq1a.ruledOut).toMatch(/no Tatkal quota/i);
    expect(tq1a.note).toBeNull();
  });

  it('reports a class this train does not carry before anything else about quota', () => {
    // Same leg, but the train's own class list has no 1A. Every quota option is then ruled out
    // for the same reason, which is more useful than seven separate quota explanations.
    const r = remediesForLeg(legRef({ segment: railSeg({ klass: '1A' }) }), ctx());
    const quota = r.find((x) => x.id === 'quota')!;
    expect(quota.options.length).toBeGreaterThan(0);
    for (const o of quota.options) {
      expect(o.ruledOut, o.label).toMatch(/does not run 1A/);
      expect(o.query, o.label).toBeNull();
    }
  });

  it('never poses a berth-position quota in a chair car — the gap Tier 0 closed', () => {
    // Before Tier 0, remedy 3 only checked Tatkal eligibility, so a Shatabdi leg happily posed
    // Divyangjan and senior-citizen queries against a train with no berths to reserve.
    const r = remediesForLeg(
      legRef({ segment: railSeg({ klass: 'CC', trainClasses: ['CC', 'EC'] }) }),
      ctx({ offeredClasses: ['CC', 'EC'] }),
    );
    const quota = r.find((x) => x.id === 'quota')!;
    for (const code of ['HP', 'SS']) {
      const o = quota.options.find((x) => x.label.startsWith(code))!;
      expect(o.ruledOut, code).toMatch(/seats, not berths/);
      expect(o.query, code).toBeNull();
    }
    // Tatkal genuinely does exist in a chair car, so it must still be posed.
    const tq = quota.options.find((x) => x.label.startsWith('TQ'))!;
    expect(tq.ruledOut).toBeNull();
    expect(tq.query).not.toBeNull();
    // And the Ladies quota is not published either way for chair cars, so it stays available
    // rather than being deleted on a guess.
    const ld = quota.options.find((x) => x.label.startsWith('LD'))!;
    expect(ld.ruledOut).toBeNull();
  });

  it('offers only classes the train actually has, and marks the rest as ruled out', () => {
    const r = remediesForLeg(legRef(), ctx({ offeredClasses: ['SL', '3A', '2A'] }));
    const klass = r.find((x) => x.id === 'class')!;
    const offered = klass.options.filter((o) => o.ruledOut === null).map((o) => o.label);
    expect(offered).toEqual(['3A', '2A']); // SL is the current class, so it is not a shift
    const missing = klass.options.filter((o) => o.ruledOut);
    expect(missing.length).toBeGreaterThan(0);
    expect(missing.every((o) => (o.ruledOut ?? '').match(/does not offer/i))).toBe(true);
    expect(missing.every((o) => o.query === null)).toBe(true);
  });

  it('points at the itineraries the router already found, for route substitution', () => {
    const r = remediesForLeg(legRef(), ctx({ alternativeItineraries: 3 }));
    const route = r.find((x) => x.id === 'route')!;
    expect(route.needsAvailability).toBe(false);
    expect(route.note).toMatch(/3 other itineraries/);
    const none = remediesForLeg(legRef(), ctx({ alternativeItineraries: 0 }))
      .find((x) => x.id === 'route')!;
    expect(none.note).toMatch(/no other itinerary/i);
  });

  it('offers the other terminals in the city, with the road time attached', () => {
    const r = remediesForLeg(legRef(), ctx());
    const terminal = r.find((x) => x.id === 'terminal')!;
    expect(terminal.options.length).toBe(1);
    expect(terminal.options[0].label).toBe('Board from ALR');
    expect(terminal.options[0].change).toMatch(/45 minutes/);
    expect(terminal.needsAvailability).toBe(false);
  });

  it('is honest that bus and air bridges are not available yet', () => {
    const r = remediesForLeg(legRef(), ctx());
    const im = r.find((x) => x.id === 'intermodal')!;
    expect(im.note).toMatch(/Phase 4/i);
    expect(im.note).toMatch(/not offered yet/i);
  });

  it('collects the availability questions without duplicates', () => {
    const r = remediesForLeg(legRef(), ctx());
    const qs = remedyQueries(r);
    const keys = qs.map(queryKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(qs.length).toBeGreaterThan(5);
    // Every question keeps the full IRCTC key: availability is per tuple, not per train.
    for (const q of qs) {
      expect(q.trainNumber).toBe('12927');
      expect(q.board.length).toBeGreaterThan(0);
      expect(q.alight.length).toBeGreaterThan(0);
      expect(q.klass.length).toBeGreaterThan(0);
      expect(q.quota.length).toBeGreaterThan(0);
    }
    // Ruled-out options never become questions.
    const ruled = remediesForLeg(legRef({ segment: railSeg({ klass: '1A' }) }), ctx());
    expect(remedyQueries(ruled).every((q) => q.quota !== 'TQ' && q.quota !== 'PT')).toBe(true);
  });
});

describe('the availability cascade', () => {
  const reading = (verdict: 'AVAILABLE', tier: AvailabilityReading['tier']): AvailabilityReading => ({
    status: parseStatus(`${verdict}-0005`), tier, source: 'LIVE', asOf: '2026-09-12T10:00:00Z',
    ageSeconds: 0, explanation: 'test',
  });

  it('answers UNKNOWN from no source, rather than guessing', async () => {
    const r = await new AvailabilityCascade().lookup(Q);
    expect(r.status.verdict).toBe('UNKNOWN');
    expect(r.source).toBe('NONE');
    expect(r.tier).toBeNull();
    expect(r.explanation).toMatch(/no availability source is connected/i);
    expect(r).toEqual(noReading());
    expect(noReading().status.verdict).not.toBe('REGRET');
  });

  it('reports which tiers could answer, so the UI can say what it is showing', () => {
    const src: AvailabilitySource = { id: 'T4', available: () => true, lookup: async () => null };
    const off: AvailabilitySource = { id: 'T1', available: () => false, lookup: async () => null };
    expect(new AvailabilityCascade([src, off]).activeTiers()).toEqual(['T4']);
    expect(new AvailabilityCascade().activeTiers()).toEqual([]);
  });

  it('tries sources in order and takes the first real answer', async () => {
    const order: string[] = [];
    const mk = (id: AvailabilityReading['tier'], result: AvailabilityReading | null): AvailabilitySource => ({
      id: id as AvailabilitySource['id'],
      available: () => true,
      lookup: async () => { order.push(id as string); return result; },
    });
    const cascade = new AvailabilityCascade([
      mk('T4', null),
      mk('T1', reading('AVAILABLE', 'T1')),
      mk('T0', reading('AVAILABLE', 'T0')),
    ]);
    const r = await cascade.lookup(Q);
    expect(order).toEqual(['T4', 'T1']); // T0 was never asked
    expect(r.tier).toBe('T1');
  });

  it('survives a source that throws, because third-party APIs fail', async () => {
    const bad: AvailabilitySource = {
      id: 'T4', available: () => true,
      lookup: async () => { throw new Error('network down'); },
    };
    const good: AvailabilitySource = { id: 'T1', available: () => true, lookup: async () => reading('AVAILABLE', 'T1') };
    const r = await new AvailabilityCascade([bad, good]).lookup(Q);
    expect(r.tier).toBe('T1');
    // And a throwing `available()` must not take the cascade down either.
    const worse: AvailabilitySource = {
      id: 'T3', available: () => { throw new Error('boom'); }, lookup: async () => null,
    };
    expect((await new AvailabilityCascade([worse, good]).lookup(Q)).tier).toBe('T1');
  });

  it('memoises, so re-rendering a results screen does not re-ask', async () => {
    const lookup = vi.fn(async () => reading('AVAILABLE', 'T4'));
    const memo = new Map<string, AvailabilityReading>();
    const cascade = new AvailabilityCascade([{ id: 'T4', available: () => true, lookup }]);
    await cascade.lookup(Q, { memo });
    await cascade.lookup(Q, { memo });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(memo.size).toBe(1);
  });

  it('gives up within its budget and says so, instead of hanging a results screen', async () => {
    const slow: AvailabilitySource = {
      id: 'T4', available: () => true,
      lookup: () => new Promise((res) => { setTimeout(() => res(reading('AVAILABLE', 'T4')), 5000); }),
    };
    const r = await new AvailabilityCascade([slow]).lookup(Q, { budgetMs: 30 });
    expect(r.status.verdict).toBe('UNKNOWN');
    expect(r.explanation).toMatch(/did not answer in time|declined/i);
  });

  it('limits concurrency, because a free tool that hammers a relay loses its key', async () => {
    let inFlight = 0;
    let peak = 0;
    const src: AvailabilitySource = {
      id: 'T4',
      available: () => true,
      lookup: async () => {
        inFlight++; peak = Math.max(peak, inFlight);
        await new Promise((r) => { setTimeout(r, 5); });
        inFlight--;
        return reading('AVAILABLE', 'T4');
      },
    };
    const queries = Array.from({ length: 20 }, (_, i) => ({ ...Q, board: `B${i}` }));
    const out = await new AvailabilityCascade([src]).lookupMany(queries, { concurrency: 3 });
    expect(out.size).toBe(20);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1); // it is actually concurrent, not accidentally serial
  });
});

describe('the IRCTC handoff', () => {
  it('links to the verified page and never fabricates query parameters', () => {
    const h = handoff(Q);
    expect(h.url).toBe(IRCTC_TRAIN_SEARCH);
    expect(h.url).not.toContain('?');
    expect(h.prefilled).toBe(false);
    // The note explains the extra typing, so a non-prefilled link does not read as a failure.
    expect(h.note).toMatch(/does not publish a way to pre-fill/i);
    expect(prefill(Q)).toBeNull();
  });

  it('lists the values in the order IRCTC asks for them, with its date format', () => {
    const fields = handoffFields(Q);
    expect(fields.map((f) => f.label)).toEqual(['From', 'To', 'Date', 'Class', 'Quota', 'Train']);
    expect(fields[2].value).toBe('20/09/2026'); // DD/MM/YYYY, not ISO
    expect(fields[0].value).toBe('ALP');
  });

  it('ships only URLs that were verified against the live site', () => {
    expect(VERIFIED_URLS).toEqual([IRCTC_TRAIN_SEARCH, IRCTC_CHARTS_VACANCY, INDIANRAIL_PNR_ENQUIRY]);
    expect(IRCTC_TRAIN_SEARCH).toBe('https://www.irctc.co.in/nget/train-search');
    // The charts page is the one place IRCTC publishes live vacancy without an API or a key.
    expect(IRCTC_CHARTS_VACANCY).toBe('https://www.irctc.co.in/online-charts/');
    expect(handoff(Q).chartsUrl).toBe(IRCTC_CHARTS_VACANCY);
  });

  it('produces copyable text covering the whole key', () => {
    const text = handoff(Q).copyText;
    for (const value of ['12927', 'ALP', 'ZED', '20/09/2026', 'SL', 'GN']) {
      expect(text, `the handoff must include ${value}`).toContain(value);
    }
  });
});

describe('IST time handling', () => {
  it('reports IST wall-clock time regardless of the browser timezone', () => {
    // 2026-09-12T18:45:00Z is 2026-09-13 00:15 in IST: the next calendar day, and inside the
    // maintenance window. A browser in UTC would see 18:45 and report both wrongly.
    const ist = istNow(new Date('2026-09-12T18:45:00Z'));
    expect(ist.dateIso).toBe('2026-09-13');
    expect(ist.minuteOfDay).toBe(15);
    expect(isInMaintenanceWindow(ist.minuteOfDay)).toBe(true);
  });

  it('does not shift the day for a time that is already the same day in IST', () => {
    const ist = istNow(new Date('2026-09-12T02:00:00Z')); // 07:30 IST
    expect(ist.dateIso).toBe('2026-09-12');
    expect(ist.minuteOfDay).toBe(7 * 60 + 30);
    expect(isInMaintenanceWindow(ist.minuteOfDay)).toBe(false);
  });

  it('lands exactly on the boundary of the IST offset', () => {
    // 18:29Z is 23:59 IST (still the same day, just before maintenance); 18:30Z is 00:00 IST
    // (next day, inside maintenance). The half-hour offset is what makes this easy to get wrong.
    expect(istNow(new Date('2026-09-12T18:29:00Z'))).toMatchObject({ dateIso: '2026-09-12', minuteOfDay: 23 * 60 + 59 });
    expect(istNow(new Date('2026-09-12T18:30:00Z'))).toMatchObject({ dateIso: '2026-09-13', minuteOfDay: 0 });
  });
});

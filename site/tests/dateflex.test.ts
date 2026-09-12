/**
 * dateflex.test.ts — the date strip behind remedy ②.
 *
 * These tests are mostly about two failure modes that would be invisible in a screenshot.
 *
 * The first is the calendar. Everything here counts from the date the train leaves its ORIGIN,
 * not the date the traveller boards, so a train that runs Mondays and is boarded on a Tuesday
 * after an overnight start must still show as running. Getting that backwards marks a real option
 * as "does not run" and a non-existent one as available, and both look plausible on screen.
 *
 * The second is the vocabulary. A strip of coloured cells invites a reader to assume the colours
 * mean availability, because on every other planner they do. So the tests assert what the labels
 * are allowed to say: a day the train does not operate is "does not run", never "sold out",
 * "full" or "unavailable", and no cell anywhere mentions a seat or a berth. The only honest
 * statement this strip can make about demand is which days of the week are typically busy.
 */
import { describe, expect, it } from 'vitest';
import { dateFlexStrip, dateFlexSummary } from '../src/availability/dateflex';
import type { DateFlexOptions } from '../src/availability/dateflex';

const TODAY = '2026-09-12';   // a Saturday
const MONDAY = '2026-09-14';
const TUESDAY = '2026-09-15';
const FAR = '2026-12-01';     // 80 days out, so outside the 60-day window
const NINE_AM = 9 * 60;       // outside IRCTC's 23:45-00:20 maintenance window

const MONDAYS_ONLY = 0b0000001;

function strip(over: Partial<DateFlexOptions> = {}) {
  return dateFlexStrip({
    runsDays: 127,
    runsDaysAssumed: false,
    serviceDayOffset: 0,
    queryDateIso: MONDAY,
    klass: 'SL',
    todayIso: TODAY,
    nowMinute: NINE_AM,
    ...over,
  });
}

describe('the strip itself', () => {
  it('is centred on the date searched, with the days either side', () => {
    const cells = strip();
    expect(cells).toHaveLength(12); // 2 before + the query date + 9 after
    const query = cells.find((c) => c.isQueryDate);
    expect(query?.dateIso).toBe(MONDAY);
    expect(query?.offsetDays).toBe(0);
    expect(cells.map((c) => c.offsetDays)).toEqual([-2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(cells[0].dateIso).toBe('2026-09-12');
    expect(cells[11].dateIso).toBe('2026-09-23');
  });

  it('marks Friday, Sunday and Monday as peak, and the rest as not', () => {
    const cells = strip();
    const byDate = new Map(cells.map((c) => [c.dateIso, c]));
    expect(byDate.get('2026-09-13')?.peak, 'Sunday').toBe(true);
    expect(byDate.get(MONDAY)?.peak, 'Monday').toBe(true);
    expect(byDate.get('2026-09-18')?.peak, 'Friday').toBe(true);
    expect(byDate.get(TUESDAY)?.peak, 'Tuesday').toBe(false);
    expect(byDate.get('2026-09-16')?.peak, 'Wednesday').toBe(false);
    expect(byDate.get('2026-09-12')?.peak, 'Saturday').toBe(false);
  });

  it('names the weekday correctly, which is what makes the peak marks checkable', () => {
    const cells = strip();
    expect(cells[0].weekday).toBe('Sat');
    expect(cells[2].weekday).toBe('Mon');
    expect(cells[3].weekday).toBe('Tue');
    expect(cells[6].weekday).toBe('Fri');
  });
});

describe('running days', () => {
  it('marks a day the train does not run, and says so in those words', () => {
    const cells = strip({ runsDays: MONDAYS_ONLY });
    const mondays = cells.filter((c) => c.dateIso === MONDAY || c.dateIso === '2026-09-21');
    expect(mondays).toHaveLength(2);
    for (const c of mondays) expect(c.state, c.dateIso).not.toBe('no-run');

    const tuesday = cells.find((c) => c.dateIso === TUESDAY)!;
    expect(tuesday.state).toBe('no-run');
    expect(tuesday.runs).toBe(false);
    expect(tuesday.label).toMatch(/does not run/);
    // The whole point: this is a timetable fact, not an availability claim.
    expect(tuesday.label).not.toMatch(/sold out|full|unavailable|no seats/i);
  });

  it('counts running days from the ORIGIN date, not the boarding date', () => {
    // A Monday-only train, boarded on a Tuesday, that left its origin on the Monday. It runs.
    const overnight = strip({ runsDays: MONDAYS_ONLY, queryDateIso: TUESDAY, serviceDayOffset: -1 });
    const cell = overnight.find((c) => c.dateIso === TUESDAY)!;
    expect(cell.originDateIso).toBe(MONDAY);
    expect(cell.runs, 'the origin day is a Monday, so this train runs').toBe(true);
    expect(cell.state).not.toBe('no-run');

    // Same train and date, but boarding on its own service day: a Tuesday, so it does not run.
    const sameDay = strip({ runsDays: MONDAYS_ONLY, queryDateIso: TUESDAY, serviceDayOffset: 0 });
    const other = sameDay.find((c) => c.dateIso === TUESDAY)!;
    expect(other.originDateIso).toBe(TUESDAY);
    expect(other.state).toBe('no-run');
  });

  it('carries the assumed-daily flag on the cell, not just in a footnote', () => {
    const assumed = strip({ runsDaysAssumed: true });
    expect(assumed.every((c) => c.runsAssumed)).toBe(true);
    expect(dateFlexSummary(assumed)).toMatch(/assumed daily/i);
    expect(dateFlexSummary(assumed)).toMatch(/check before you plan/i);

    const sourced = strip({ runsDaysAssumed: false });
    expect(sourced.every((c) => !c.runsAssumed)).toBe(true);
    expect(dateFlexSummary(sourced)).not.toMatch(/assumed daily/i);
  });
});

describe('the booking window', () => {
  it('shows a date beyond 60 days as closed, with a countdown to the morning it opens', () => {
    const cells = strip({ queryDateIso: FAR });
    const cell = cells.find((c) => c.dateIso === FAR)!;
    expect(cell.state).toBe('window-closed');
    expect(cell.bookableNow).toBe(false);
    // 2026-12-01 is 80 days out; the window opens 60 days before it, on 2026-10-02, which is 20
    // days from the fixed "today" of 2026-09-12.
    expect(cell.daysUntilWindowOpens).toBe(20);
    expect(cell.label).toMatch(/booking opens in 20 days/);
    expect(cells.every((c) => c.state === 'window-closed')).toBe(true);
  });

  it('shows a date inside the window as open and bookable now', () => {
    const cell = strip().find((c) => c.dateIso === MONDAY)!;
    expect(cell.state).toBe('open');
    expect(cell.bookableNow).toBe(true);
    expect(cell.daysUntilWindowOpens).toBeLessThan(0); // negative once the window has opened
    expect(cell.label).toMatch(/bookable now/);
  });

  it('marks days that have already gone, so nobody is offered yesterday', () => {
    const cells = strip({ daysBefore: 4 });
    expect(cells).toHaveLength(14);
    // The strip is centred on the queried Monday, so four days back reaches 2026-09-10; only the
    // two days before the fixed "today" of 2026-09-12 are actually in the past.
    expect(cells[0].dateIso).toBe('2026-09-10');
    expect(cells.filter((c) => c.state === 'past').map((c) => c.dateIso))
      .toEqual(['2026-09-10', '2026-09-11']);
    // Today itself is not in the past, which is a boundary worth pinning.
    expect(cells.find((c) => c.dateIso === TODAY)?.state).not.toBe('past');
  });
});

describe('Tatkal, per class', () => {
  it('gives the non-AC time for sleeper and the AC time for 3A', () => {
    expect(strip({ klass: 'SL' }).find((c) => c.dateIso === MONDAY)?.tatkalLabel).toMatch(/at 11:00 IST/);
    expect(strip({ klass: '3A' }).find((c) => c.dateIso === MONDAY)?.tatkalLabel).toMatch(/at 10:00 IST/);
  });

  it('says First AC has no Tatkal at all, rather than showing a time for it', () => {
    const label = strip({ klass: '1A' }).find((c) => c.dateIso === MONDAY)?.tatkalLabel ?? '';
    expect(label).toMatch(/no Tatkal quota/i);
    expect(label).not.toMatch(/\d\d:\d\d/);
  });

  it('shows no Tatkal for a day the train does not run', () => {
    const cell = strip({ runsDays: MONDAYS_ONLY }).find((c) => c.dateIso === TUESDAY)!;
    expect(cell.state).toBe('no-run');
    expect(cell.tatkalLabel).toBeNull();
    expect(cell.daysUntilWindowOpens).toBeNull();
  });
});

describe('what the strip refuses to say', () => {
  it('has exactly four states, and every one of them is a fact', () => {
    const seen = new Set<string>();
    for (const over of [
      {}, { runsDays: MONDAYS_ONLY }, { queryDateIso: FAR }, { daysBefore: 4 }, { runsDaysAssumed: true },
    ]) {
      for (const c of strip(over)) seen.add(c.state);
    }
    expect([...seen].sort()).toEqual(['no-run', 'open', 'past', 'window-closed']);
  });

  it('never mentions a seat, a berth or a confirmation anywhere', () => {
    for (const over of [{}, { runsDays: MONDAYS_ONLY }, { queryDateIso: FAR }, { klass: '1A' }]) {
      const cells = strip(over);
      for (const c of cells) {
        expect(c.label, c.dateIso).not.toMatch(/seat|berth|confirm|sold out|available|waitlist/i);
      }
      const summary = dateFlexSummary(cells);
      // The summary is allowed to say the word "seat" — it has to, in order to disclaim knowing
      // anything about them. What it must never do is make a claim: that seats are available, that
      // berths are free, that anything confirmed, sold out or waitlisted.
      expect(summary, 'must not claim availability').not.toMatch(
        /(seats?|berths?)\s+(are\s+)?(available|free|open)|confirmed|sold out|waitlisted|will clear/i,
      );
      expect(summary, 'must disclaim it instead').toMatch(/whether a seat exists/i);
      expect(summary).toMatch(/no availability source is connected/i);
    }
  });

  it('counts the days it is describing, so the summary cannot be read as a shortlist', () => {
    // 2026-09-12..23 contains exactly two Mondays, the 14th and the 21st.
    const summary = dateFlexSummary(strip({ runsDays: MONDAYS_ONLY }));
    expect(summary).toMatch(/Of the 12 days shown, this train runs on 2/);
    expect(summary).toMatch(/does not run on 10/);
  });

  it('names the earliest closed window rather than a vague "later"', () => {
    const summary = dateFlexSummary(strip({ queryDateIso: FAR }));
    expect(summary).toMatch(/not bookable yet/);
    expect(summary).toMatch(/earliest of those opens in \d+ day/);
  });
});

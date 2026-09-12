/**
 * dateflex.ts — remedy ② as a strip of days.
 *
 * "Try another date" is useless advice on its own. The traveller needs to know which nearby dates
 * this train even runs on, and which of those are inside the booking window — and both of those
 * are knowable from the timetable and IRCTC's published rules, with no availability source at all.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE COLOURS MEAN, AND WHAT THEY DELIBERATELY DO NOT
 * ---------------------------------------------------------------------------
 * A date-flex heatmap on a commercial planner is green-to-red by predicted availability. This one
 * cannot be, because nothing here knows whether a berth is free. So every cell is one of four
 * states that are *facts*:
 *
 *   past            the day has already gone
 *   no-run          the running-days bitmask says this train does not operate then
 *   window-closed   it runs, but the 60-day advance window has not opened yet
 *   open            it runs and it can be booked right now
 *
 * There is no "sold out" state and no green/red demand gradient. Inventing one would be the single
 * easiest way for this app to tell a lie with a colour. docs/01 §12 asks that the heatmap
 * distinguish `no run` from sold out; this distinguishes `no run` from `unknown`, and says so in
 * the legend, because "sold out" is not a thing this build can know. Recorded as a deviation.
 *
 * One caveat travels with every cell: when the dataset had no operating-days column, the bitmask
 * is an assumption of "daily" rather than a fact, and the cell is flagged `runsAssumed`. A weekly
 * train shown as running every day is a real harm — someone plans a holiday around it — so the
 * flag is part of the cell, not a footnote.
 *
 * Peak days (Friday, Sunday, Monday) are marked because they are a documented feature of Indian
 * Railways demand, not a prediction about this train. The wording keeps that distinction.
 */
import {
  addDays, bookingFacts, daysBetween, istNow, originDateOf, runsOnDate, weekdayBit,
} from './rules';

/** The four states a day can be in. All four are facts; none of them is a guess about seats. */
export type DateFlexState = 'past' | 'no-run' | 'window-closed' | 'open';

export interface DateFlexCell {
  /** The date the traveller would board. */
  dateIso: string;
  /** The date the train leaves its origin, which every booking window counts from. */
  originDateIso: string;
  /** 'Mon'..'Sun'. */
  weekday: string;
  /** Day of month, for the cell face. */
  dayNum: number;
  /** Signed distance from the date the traveller searched: 0 is that date. */
  offsetDays: number;
  isQueryDate: boolean;
  /** Friday, Sunday or Monday — documented peak booking days, not a prediction about this train. */
  peak: boolean;
  runs: boolean;
  /** True when `runs` came from an assumed-daily bitmask rather than from the data. */
  runsAssumed: boolean;
  state: DateFlexState;
  /** True when the general quota for this date is open right now. */
  bookableNow: boolean;
  /** Days until the advance window opens; negative once it has. Null when the train does not run. */
  daysUntilWindowOpens: number | null;
  /** When Tatkal opens for this date and class, or why it cannot. */
  tatkalLabel: string | null;
  /** One short phrase for the cell, used as its accessible name and tooltip. */
  label: string;
}

export interface DateFlexOptions {
  /** Running-days bitmask, bit 0 = Monday. */
  runsDays: number;
  /** True when the dataset had no operating-days column and daily was assumed. */
  runsDaysAssumed: boolean;
  /** Negative when the train left its origin the day before the traveller boards. */
  serviceDayOffset: number;
  /** The date the traveller searched for. The strip is centred on it. */
  queryDateIso: string;
  klass: string;
  daysBefore?: number;
  daysAfter?: number;
  /** Defaults to the current Indian date and minute, never the browser's local ones. */
  todayIso?: string;
  nowMinute?: number;
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

/** Friday, Sunday and Monday: the documented peak of the Indian booking week. */
const PEAK_BITS = new Set([0, 4, 6]);

/**
 * Build the strip.
 *
 * Every cell runs the same `bookingFacts()` the leg panel uses, so the windows cannot drift
 * between two places on the same screen. That is the reason this module has almost no arithmetic
 * of its own: a second implementation of the 60-day rule is a second chance to get it wrong.
 */
export function dateFlexStrip(opts: DateFlexOptions): DateFlexCell[] {
  const before = opts.daysBefore ?? 2;
  const after = opts.daysAfter ?? 9;
  const now = istNow();
  const todayIso = opts.todayIso ?? now.dateIso;
  const nowMinute = opts.nowMinute ?? now.minuteOfDay;

  const cells: DateFlexCell[] = [];
  for (let offset = -before; offset <= after; offset++) {
    const dateIso = addDays(opts.queryDateIso, offset);
    const originDateIso = originDateOf(dateIso, opts.serviceDayOffset);
    const bit = weekdayBit(dateIso);
    const facts = bookingFacts(dateIso, opts.serviceDayOffset, opts.klass, todayIso, nowMinute);

    const inPast = daysBetween(todayIso, dateIso) < 0;
    const runs = runsOnDate(opts.runsDays, originDateIso);
    const runsAssumed = opts.runsDaysAssumed;

    let state: DateFlexState;
    let label: string;
    if (inPast) {
      state = 'past';
      label = `${WEEKDAYS[bit]} ${dateIso.slice(8)} — already gone`;
    } else if (!runs) {
      state = 'no-run';
      label = `${WEEKDAYS[bit]} ${dateIso.slice(8)} — this train does not run`;
    } else if (!facts.withinArp) {
      state = 'window-closed';
      label = `${WEEKDAYS[bit]} ${dateIso.slice(8)} — booking opens in `
        + `${facts.daysUntilAdvanceOpens} day${facts.daysUntilAdvanceOpens === 1 ? '' : 's'}`;
    } else {
      state = 'open';
      label = `${WEEKDAYS[bit]} ${dateIso.slice(8)} — runs and is bookable now`
        + (runsAssumed ? ' (running days were assumed daily)' : '');
    }

    cells.push({
      dateIso,
      originDateIso,
      weekday: WEEKDAYS[bit],
      dayNum: Number(dateIso.slice(8)),
      offsetDays: offset,
      isQueryDate: offset === 0,
      peak: PEAK_BITS.has(bit),
      runs,
      runsAssumed,
      state,
      bookableNow: state === 'open',
      daysUntilWindowOpens: runs && !inPast ? facts.daysUntilAdvanceOpens : null,
      tatkalLabel: runs && !inPast ? (facts.tatkal?.reason ?? facts.tatkal?.label ?? null) : null,
      label,
    });
  }
  return cells;
}

/**
 * One sentence about the strip, for reading aloud or for a summary line.
 *
 * It always ends by saying what the strip does not know. A summary that listed only the runnable
 * dates would read as "these are your options", and the traveller would reasonably assume the
 * unlisted ones were full.
 */
export function dateFlexSummary(cells: readonly DateFlexCell[]): string {
  const future = cells.filter((c) => c.state !== 'past');
  const runs = future.filter((c) => c.runs);
  const noRun = future.filter((c) => c.state === 'no-run');
  const closed = future.filter((c) => c.state === 'window-closed');
  const assumed = runs.some((c) => c.runsAssumed);

  const parts: string[] = [];
  parts.push(`Of the ${future.length} days shown, this train runs on ${runs.length}`);
  if (noRun.length > 0) parts.push(`does not run on ${noRun.length}`);
  if (closed.length > 0) {
    const first = closed[0];
    parts.push(
      `${closed.length} are not bookable yet — the earliest of those opens in `
      + `${first.daysUntilWindowOpens} day${first.daysUntilWindowOpens === 1 ? '' : 's'}`,
    );
  }
  let out = parts.join(', ') + '.';
  if (assumed) {
    out += ' Running days were not in the source data and are assumed daily, so a weekly service '
      + 'could show as running when it does not — check before you plan around one.';
  }
  out += ' None of this says whether a seat exists on any of those days: no availability source '
    + 'is connected in this build.';
  return out;
}

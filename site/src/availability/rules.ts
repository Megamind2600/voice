/**
 * rules.ts — IRCTC's booking calendar, as constants and pure functions.
 *
 * Every number here was verified against multiple independent sources on 2026-09-12 and is the
 * kind of fact a traveller will act on by setting an alarm, so the cost of getting one wrong is
 * a missed ticket rather than a cosmetic bug. Where a rule has a subtlety that is easy to get
 * wrong, the subtlety is encoded in the function rather than left to the caller.
 *
 * ---------------------------------------------------------------------------
 * THE SUBTLETY THAT MATTERS MOST
 * ---------------------------------------------------------------------------
 * Both the 60-day advance window and the Tatkal window are counted from the date the train
 * departs its **originating station**, not the date it departs yours. On a train that runs over
 * midnight those are different calendar days, and getting it wrong opens the alarm an entire day
 * late.
 *
 * Worked example: 12927 leaves Dadar at 23:50 on 24 January and you board at Borivali at 00:06
 * on 25 January. Tatkal opens against 24 January, not 25th.
 *
 * This project already models exactly that gap as `serviceDayOffset` on every rail segment — the
 * number of days between the query date and the train's own service day, which is zero or
 * negative. `originDateOf` applies it here, so the two halves of the codebase cannot disagree
 * about which day a train runs on.
 */

/** Advance Reservation Period: how far ahead a general-quota ticket can be booked, in days. */
export const ARP_DAYS = 60;

/** General-quota booking opens at 08:00 IST, daily, including Sundays and holidays. */
export const BOOKING_OPENS_MIN = 8 * 60;

/**
 * Aadhaar-authenticated users get a priority window at the start of the day's opening.
 * Ends 08:15 IST. Worth surfacing because it is the difference between getting a berth and
 * getting a waitlist position on a popular date.
 */
export const AADHAAR_PRIORITY_ENDS_MIN = 8 * 60 + 15;

/** Tatkal opens at 10:00 IST for AC classes, one day before the train's origin departure. */
export const TATKAL_AC_OPENS_MIN = 10 * 60;

/** Tatkal opens at 11:00 IST for non-AC classes (SL, 2S, FC), one day before origin departure. */
export const TATKAL_NONAC_OPENS_MIN = 11 * 60;

/**
 * IRCTC is unavailable for booking during the nightly maintenance window, 23:45–00:20 IST.
 *
 * A traveller who plans to book at midnight needs to know this exists, and a tool that links
 * them to IRCTC at 23:50 without saying so is sending them into a dead end.
 */
export const MAINTENANCE_START_MIN = 23 * 60 + 45;
export const MAINTENANCE_END_MIN = 20; // 00:20, i.e. the next calendar day

/** Maximum passengers on one general-quota ticket. */
export const MAX_PAX_GENERAL = 6;
/** Maximum passengers on one Tatkal ticket. Lower, and easy to hit when booking for a family. */
export const MAX_PAX_TATKAL = 4;

/** Booking closes this many minutes before departure for the current-availability window. */
export const BOOKING_CLOSES_MIN_BEFORE_DEP = 30;

/**
 * Current (same-day) availability opens this many hours before departure, after the first chart
 * is prepared. Distinct from advance availability, which is what the ARP governs.
 */
export const CURRENT_AVAILABILITY_OPENS_HOURS_BEFORE_DEP = 8;

/** AC classes, for the Tatkal opening-time split. */
export const AC_CLASSES: readonly string[] = ['1A', '2A', '3A', '3E', 'CC', 'EC', 'EA'];

/**
 * Classes with a Tatkal quota.
 *
 * First AC is conspicuously absent: **1A has no Tatkal quota at all.** Suggesting Tatkal as a
 * remedy for a waitlisted 1A ticket would be suggesting something that cannot be done.
 */
export const TATKAL_CLASSES: readonly string[] = ['2A', '3A', '3E', 'CC', 'EC', 'EA', 'SL', '2S', 'FC'];

/** First Class (non-AC) — named like an AC class and priced between 3A and 2A, so easy to
 * misfile. It is non-AC, therefore Tatkal opens at 11:00, not 10:00. */
export const NON_AC_CLASSES: readonly string[] = ['SL', '2S', 'FC'];

/**
 * Quotas, with who may actually use them.
 *
 * Eligibility is part of the data rather than a UI string because a remedy that suggests an
 * ineligible quota is worse than no remedy: it sends someone to a booking form that will reject
 * them. `LD` is for a woman travelling alone or with children under 12; `SS` requires the age
 * threshold and carries no concession under Tatkal.
 */
export interface Quota {
  code: string;
  name: string;
  /** Who may book it. Null means anyone. */
  eligibility: string | null;
  /** True when this quota has its own opening time distinct from the general window. */
  separateWindow: boolean;
}

export const QUOTAS: readonly Quota[] = [
  { code: 'GN', name: 'General', eligibility: null, separateWindow: false },
  { code: 'TQ', name: 'Tatkal', eligibility: 'ID proof of at least one passenger is mandatory', separateWindow: true },
  { code: 'PT', name: 'Premium Tatkal', eligibility: 'Dynamic pricing; generally non-refundable and non-cancellable', separateWindow: true },
  { code: 'LD', name: 'Ladies', eligibility: 'A woman travelling alone, or with children under 12', separateWindow: false },
  { code: 'SS', name: 'Senior citizen', eligibility: 'Age threshold applies; no concession under Tatkal', separateWindow: false },
  { code: 'HP', name: 'Physically handicapped / Divyang', eligibility: 'Documented disability', separateWindow: false },
  { code: 'DF', name: 'Defence personnel', eligibility: 'Serving or retired defence personnel', separateWindow: false },
  { code: 'FT', name: 'Freedom fighter', eligibility: 'Recognised freedom fighter', separateWindow: false },
];

/**
 * Day-of-week bit for an ISO date, in the packing convention: **bit 0 is Monday**, bit 6 Sunday.
 *
 * `Date.getUTCDay()` is Sunday-first, so the two have to be reconciled somewhere. Doing it here
 * rather than at each call site is what stops one module treating bit 0 as Sunday while another
 * treats it as Monday — a bug that would only ever show up as a train appearing on the wrong day.
 */
/**
 * Monday-first weekday abbreviations, indexed exactly as `weekdayBit()` returns.
 *
 * Duplicated from `lib/graph.ts` on purpose rather than imported: `DAY_NAMES` there sits in a
 * module that drags the whole binary graph reader into whatever bundle imports it, and everything
 * in this directory runs on the main thread where the graph lives in the worker. A seven-string
 * array is a cheaper thing to duplicate than a 40 KB dependency.
 */
export const DAY_NAMES: readonly ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] =
  ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function weekdayBit(iso: string): number {
  const sunday0 = new Date(`${iso}T12:00:00Z`).getUTCDay();
  return (sunday0 + 6) % 7;
}

/** Whether a train runs on a date, from its running-days bitmask (bit 0 = Monday). */
export function runsOnDate(runsDays: number, iso: string): boolean {
  return (runsDays & (1 << weekdayBit(iso))) !== 0;
}

/**
 * The current date and minute-of-day **in IST**, whatever timezone the browser is in.
 *
 * Every window in this file is an IRCTC window and therefore an IST wall-clock time. A traveller
 * planning from Dubai or Toronto whose browser reports local time would otherwise be told Tatkal
 * opens in three hours when it opens in six, which is the kind of error that costs a ticket and
 * looks like a bug in the app rather than in the arithmetic. IST is UTC+05:30 with no daylight
 * saving, so the offset is a constant rather than a lookup table.
 */
export function istNow(now: Date = new Date()): { dateIso: string; minuteOfDay: number } {
  const IST_OFFSET_MIN = 330;
  const shifted = new Date(now.getTime() + IST_OFFSET_MIN * 60_000);
  return {
    dateIso: shifted.toISOString().slice(0, 10),
    minuteOfDay: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

export function quotaOf(code: string): Quota | undefined {
  return QUOTAS.find((q) => q.code === code.toUpperCase());
}

export function isAcClass(klass: string): boolean {
  return AC_CLASSES.includes(klass.toUpperCase());
}

/** Whether Tatkal exists for this class at all. False for 1A. */
export function hasTatkal(klass: string): boolean {
  return TATKAL_CLASSES.includes(klass.toUpperCase());
}

// ---------------------------------------------------------------------------
// Date arithmetic
// ---------------------------------------------------------------------------

/** Parse `YYYY-MM-DD` as a UTC noon timestamp, so no timezone can shift the calendar day. */
export function parseIso(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1, 12, 0, 0));
}

export function toIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Add (or subtract) whole days to an ISO date. */
export function addDays(iso: string, days: number): string {
  const d = parseIso(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return toIso(d);
}

/** Whole days from `from` to `to`, ignoring time of day. Positive when `to` is later. */
export function daysBetween(from: string, to: string): number {
  return Math.round((parseIso(to).getTime() - parseIso(from).getTime()) / 86_400_000);
}

/**
 * The date a train's journey *begins at its origin*, given the date the traveller boards and the
 * segment's service-day offset.
 *
 * `serviceDayOffset` is zero or negative: it is how many days BEFORE the query date the train
 * started. A train boarded just after midnight at an intermediate station typically has offset
 * -1, meaning its origin departure was the previous calendar day — and that is the day every
 * booking window is counted from.
 */
export function originDateOf(boardingDateIso: string, serviceDayOffset: number): string {
  return addDays(boardingDateIso, serviceDayOffset);
}

/**
 * When general-quota booking opens for a journey.
 *
 * The opening date is exactly `ARP_DAYS` before the origin departure date — the day of travel is
 * not counted, which is the same thing said from the other end. Verified against three published
 * worked examples that all agree on a 60-day gap:
 *
 *   journey 2026-11-10  opens 2026-09-11
 *   journey 2026-08-30  opens 2026-07-01
 *   journey 2026-03-15  opens 2026-01-14
 *
 * The off-by-one here is expensive in a specific direction: counting inclusively puts the opening
 * a day LATE, and someone who sets an alarm for the wrong morning does not get a berth, they get
 * a waitlist position. The tests assert those three pairs rather than a formula, so the
 * convention is pinned to published fact instead of to an interpretation of it.
 */
export function advanceBookingOpens(
  originDepartureIso: string,
): { date: string; minute: number; label: string } {
  const date = addDays(originDepartureIso, -ARP_DAYS);
  return {
    date,
    minute: BOOKING_OPENS_MIN,
    label: `${date} at 08:00 IST`,
  };
}

/**
 * Whether a journey date is inside the advance-reservation window as of `todayIso`.
 *
 * Beyond the ARP the ticket cannot be booked yet at all, which is a different situation from
 * "booked out" and must not be reported as one.
 */
export function isWithinArp(originDepartureIso: string, todayIso: string): boolean {
  // `<= ARP_DAYS` and not `<`: on the opening morning itself the gap is exactly 60 and the
  // ticket is bookable from 08:00. Off by one here, the app would report "not bookable yet" on
  // the single most important day of the window.
  return daysBetween(todayIso, originDepartureIso) <= ARP_DAYS;
}

/**
 * Days until the journey, counting the way IRCTC does — the day of travel is not counted.
 *
 * Zero on the morning the window opens, negative once it has been open for that many days.
 */
export function arpDaysRemaining(originDepartureIso: string, todayIso: string): number {
  return ARP_DAYS - daysBetween(todayIso, originDepartureIso);
}

export interface TatkalWindow {
  date: string;
  minute: number;
  label: string;
  /** Why there is no window, when there is none. */
  reason?: string;
}

/**
 * When Tatkal opens for a class on a train.
 *
 * Returns `null` with a reason when the class has no Tatkal quota — which is the case for 1A.
 * Callers must show the reason rather than falling back to a default time, because "Tatkal opens
 * at 10:00" is actively wrong for a First AC ticket.
 */
export function tatkalOpens(
  originDepartureIso: string,
  klass: string,
): TatkalWindow | null {
  if (!hasTatkal(klass)) {
    return {
      date: originDepartureIso,
      minute: 0,
      label: 'No Tatkal quota',
      reason: `${klass} has no Tatkal quota at all, so this remedy is not available in that class.`,
    };
  }
  const date = addDays(originDepartureIso, -1);
  const minute = isAcClass(klass) ? TATKAL_AC_OPENS_MIN : TATKAL_NONAC_OPENS_MIN;
  const hh = String(Math.floor(minute / 60)).padStart(2, '0');
  return { date, minute, label: `${date} at ${hh}:00 IST` };
}

/**
 * Whether a given minute-of-day falls inside IRCTC's nightly maintenance window.
 *
 * The window straddles midnight, so the comparison wraps rather than using a plain range test —
 * the bug a naive `start <= m && m < end` would produce is that it reports the window as never
 * open, since 1425 is never less than 20.
 */
export function isInMaintenanceWindow(minuteOfDay: number): boolean {
  const m = ((minuteOfDay % 1440) + 1440) % 1440;
  return m >= MAINTENANCE_START_MIN || m < MAINTENANCE_END_MIN;
}

/**
 * Everything a traveller needs to know about booking *this* leg, right now.
 *
 * Assembled in one place because these facts are only useful together: knowing Tatkal opens at
 * 10:00 is worthless without knowing it opens against the origin's date, and knowing the ARP is
 * 60 days is worthless without knowing whether this journey is inside it.
 */
export interface BookingFacts {
  /** The date the train leaves its origin, which every window counts from. */
  originDate: string;
  /** The date the traveller boards, which can be a day later. */
  boardingDate: string;
  /** True when those two differ — worth saying out loud, since it is counter-intuitive. */
  crossesMidnightFromOrigin: boolean;
  advance: { date: string; minute: number; label: string };
  withinArp: boolean;
  /** Negative once the window has opened; counts down to it before then. */
  daysUntilAdvanceOpens: number;
  tatkal: TatkalWindow | null;
  maintenanceWarning: boolean;
  /** Plain-language notes, in the order they should be read. */
  notes: string[];
}

export function bookingFacts(
  boardingDateIso: string,
  serviceDayOffset: number,
  klass: string,
  todayIso: string,
  nowMinuteOfDay: number,
): BookingFacts {
  const originDate = originDateOf(boardingDateIso, serviceDayOffset);
  const advance = advanceBookingOpens(originDate);
  const withinArp = isWithinArp(originDate, todayIso);
  const daysUntilAdvanceOpens = daysBetween(todayIso, advance.date);
  const tatkal = tatkalOpens(originDate, klass);
  const maintenanceWarning = isInMaintenanceWindow(nowMinuteOfDay);

  const notes: string[] = [];
  if (serviceDayOffset < 0) {
    notes.push(
      `This train started at its origin on ${originDate}, a day before you board on `
      + `${boardingDateIso}. Booking windows count from the origin's date, not yours.`,
    );
  }
  if (!withinArp) {
    notes.push(
      `Not bookable yet: general quota for ${originDate} opens on ${advance.label}. `
      + `The advance window is ${ARP_DAYS} days and does not count the day of travel.`,
    );
  } else if (daysUntilAdvanceOpens < 0) {
    notes.push(`General quota opened on ${advance.label}.`);
  }
  if (tatkal?.reason) {
    notes.push(tatkal.reason);
  } else if (tatkal) {
    notes.push(`Tatkal for ${klass} opens ${tatkal.label}.`);
  }
  if (maintenanceWarning) {
    notes.push(
      'IRCTC is down for nightly maintenance between 23:45 and 00:20 IST, so booking will not '
      + 'go through right now.',
    );
  }
  return {
    originDate,
    boardingDate: boardingDateIso,
    crossesMidnightFromOrigin: serviceDayOffset < 0,
    advance,
    withinArp,
    daysUntilAdvanceOpens,
    tatkal,
    maintenanceWarning,
    notes,
  };
}

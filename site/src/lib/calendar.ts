/**
 * calendar.ts — turn an itinerary into an .ics file a calendar app can import.
 *
 * This is Phase 4's "add to calendar" export, built on nothing but strings: the RFC 5545
 * text format is older than most of the people booking these trains, and every calendar
 * (Google, Apple, Outlook, the one in every phone) reads it. That matters for a static
 * site — there is no server to hold a `.ics` endpoint, so the file is generated in the
 * browser and downloaded like the plain-text export already is.
 *
 * ---------------------------------------------------------------------------
 * THE THREE RULES THAT KEEP AN ICS FILE FROM BEING QUIETLY BROKEN
 * ---------------------------------------------------------------------------
 * 1. Times are in Asia/Kolkata, and the file SAYS so. A train that leaves at 08:30 IST
 *    written as a UTC timestamp is 03:00 Z, which a calendar then re-renders in the
 *    traveller's own zone — usually wrong. A `DTSTART;TZID=Asia/Kolkata` line plus a
 *    matching `VTIMEZONE` block keeps the event at 08:30 in India no matter where the
 *    phone is. IST is fixed at +05:30 with no daylight saving, so the zone block is
 *    trivial and exact.
 * 2. Every content line is folded at 75 octets. RFC 5545 requires it, and some parsers
 *    silently truncate a longer line. Folding is measured in OCTETS (UTF-8 bytes), not
 *    code units — a description full of ₹ symbols is three bytes each, and folding by
 *    `.length` would produce over-long lines that look right and parse wrong.
 * 3. Text is escaped. A semicolon, comma, backslash or newline in a station name or a
 *    description would otherwise change the field's meaning. `escapeIcsText` handles all
 *    four; a test pins it because a broken escape is invisible until someone's calendar
 *    shows a mangled title.
 */

/** One calendar event — the smallest unit the exporter knows about. */
export interface CalendarEvent {
  /** Summary line, e.g. "New Delhi → Mumbai Central". */
  title: string;
  /** Start, in IST: an ISO date plus minutes since midnight. */
  startDateIso: string;
  startMin: number;
  /** End, in IST. May be a later calendar day than `startDateIso`. */
  endDateIso: string;
  endMin: number;
  /** Where it happens, for the calendar's location field. */
  location: string;
  /** Free text shown in the event body. */
  description: string;
  /**
   * Stable identifier. Must not change when the same itinerary is exported again, or a
   * re-import creates a duplicate event instead of replacing the old one.
   */
  uid: string;
}

export interface IcsOptions {
  /** Calendar display name. */
  name: string;
  /** Optional fixed DTSTAMP, for tests that must not depend on the clock. */
  now?: Date;
}

const CRLF = '\r\n';

/** Escape the four characters RFC 5545 treats as structure: \ ; , and newline. */
export function escapeIcsText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * Fold a content line so no line exceeds 75 octets (excluding the CRLF).
 *
 * Continuation lines begin with a single space, which counts toward the 75. Length is
 * measured in UTF-8 bytes, not JS string length.
 */
export function foldIcsLine(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const chunks: string[] = [];
  let cur = '';
  let curLen = 0;
  for (const ch of line) {
    const chLen = enc.encode(ch).length;
    if (curLen + chLen > 75) {
      chunks.push(cur);
      cur = ` ${ch}`; // continuation line's leading space is part of the 75
      curLen = 1 + chLen;
    } else {
      cur += ch;
      curLen += chLen;
    }
  }
  if (cur !== '') chunks.push(cur);
  return chunks.join(CRLF);
}

/** "2026-09-14 08:30" -> "20260914T083000". */
export function icsDateTime(dateIso: string, minuteOfDay: number): string {
  const [y, m, d] = dateIso.split('-');
  const mm = ((minuteOfDay % 1440) + 1440) % 1440;
  const hh = String(Math.floor(mm / 60)).padStart(2, '0');
  const min = String(mm % 60).padStart(2, '0');
  return `${y}${m}${d}T${hh}${min}00`;
}

/** UTC timestamp for DTSTAMP, e.g. "20260914T030000Z". */
export function utcStamp(now = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}`
    + `T${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}Z`;
}

/**
 * India Standard Time, fixed +05:30 with no daylight saving. The block exists so that a
 * calendar reading `TZID=Asia/Kolkata` has a definition to look up instead of guessing.
 */
const VTIMEZONE = [
  'BEGIN:VTIMEZONE',
  'TZID:Asia/Kolkata',
  'BEGIN:STANDARD',
  'DTSTART:19700101T000000',
  'TZOFFSETFROM:+0530',
  'TZOFFSETTO:+0530',
  'TZNAME:IST',
  'END:STANDARD',
  'END:VTIMEZONE',
].join(CRLF);

/** One VEVENT block. */
export function eventToIcs(ev: CalendarEvent, now = new Date()): string {
  return [
    'BEGIN:VEVENT',
    `UID:${escapeIcsText(ev.uid)}`,
    `DTSTAMP:${utcStamp(now)}`,
    `DTSTART;TZID=Asia/Kolkata:${icsDateTime(ev.startDateIso, ev.startMin)}`,
    `DTEND;TZID=Asia/Kolkata:${icsDateTime(ev.endDateIso, ev.endMin)}`,
    `SUMMARY:${escapeIcsText(ev.title)}`,
    `LOCATION:${escapeIcsText(ev.location)}`,
    `DESCRIPTION:${escapeIcsText(ev.description)}`,
    'END:VEVENT',
  ].map(foldIcsLine).join(CRLF);
}

/** Assemble a complete VCALENDAR document. */
export function buildIcs(events: readonly CalendarEvent[], opts: IcsOptions): string {
  const header = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Kahan Chalein//Train planner//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcsText(opts.name)}`,
    'X-WR-TIMEZONE:Asia/Kolkata',
  ].map(foldIcsLine).join(CRLF);

  const body = events.map((e) => eventToIcs(e, opts.now)).join(CRLF);

  return [header, VTIMEZONE, body, 'END:VCALENDAR'].join(CRLF) + CRLF;
}

/**
 * Move an ISO date forward by a minute count, returning the resulting calendar day and
 * the minute-of-day remainder. An overnight arrival ("+1d") becomes the next date.
 */
export function shiftIsoByMinutes(
  dateIso: string,
  minutes: number,
): { dateIso: string; minuteOfDay: number } {
  const days = Math.floor(minutes / 1440);
  const minuteOfDay = minutes % 1440;
  if (days === 0) return { dateIso, minuteOfDay };
  const [y, m, d] = dateIso.split('-').map(Number);
  const dt = new Date(y, m - 1, d + days);
  const iso = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  return { dateIso: iso, minuteOfDay };
}

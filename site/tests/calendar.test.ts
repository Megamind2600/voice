/**
 * calendar.test.ts — the .ics exporter, tested against the things that break an import.
 *
 * An ICS file that parses is a file that imported. These tests pin the three rules in
 * calendar.ts — IST timestamps, 75-octet folding, and escaping — plus the date-shift
 * arithmetic that turns an overnight arrival into the next calendar day.
 */
import { describe, expect, it } from 'vitest';
import {
  buildIcs, escapeIcsText, eventToIcs, foldIcsLine, icsDateTime, shiftIsoByMinutes,
  utcStamp,
  type CalendarEvent,
} from '../src/lib/calendar';

const EVENT: CalendarEvent = {
  title: 'New Delhi → Mumbai Central',
  startDateIso: '2026-09-14',
  startMin: 8 * 60 + 30,
  endDateIso: '2026-09-15',
  endMin: 6 * 60 + 10,
  location: 'New Delhi (NDLS) → Mumbai Central (BCT)',
  description: '12951 Mumbai Rajdhani\nFare ₹2,500 estimated',
  uid: 'kahan-chalein-2026-09-14-NDLS-BCT-510',
};

describe('escapeIcsText', () => {
  it('escapes the four structural characters', () => {
    expect(escapeIcsText('a\\b;c,d\ne')).toBe('a\\\\b\\;c\\,d\\ne');
  });

  it('is idempotent in the sense that a second pass doubles only backslashes', () => {
    const once = escapeIcsText('a,b');
    expect(once).toBe('a\\,b');
    expect(escapeIcsText(once)).toBe('a\\\\\\,b');
  });
});

describe('foldIcsLine', () => {
  it('leaves short lines untouched', () => {
    expect(foldIcsLine('SUMMARY:hello')).toBe('SUMMARY:hello');
  });

  it('folds a long line so every physical line is <= 75 octets', () => {
    const long = `DESCRIPTION:${'x'.repeat(300)}`;
    const folded = foldIcsLine(long);
    const enc = new TextEncoder();
    for (const line of folded.split('\r\n')) {
      expect(enc.encode(line).length).toBeLessThanOrEqual(75);
    }
  });

  it('starts every continuation line with a space', () => {
    const folded = foldIcsLine(`DESCRIPTION:${'x'.repeat(160)}`);
    const lines = folded.split('\r\n');
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines.slice(1)) expect(line.startsWith(' ')).toBe(true);
  });

  it('measures in octets, so a multibyte ₹ does not overflow the line', () => {
    const folded = foldIcsLine(`DESCRIPTION:${'₹'.repeat(60)}`);
    const enc = new TextEncoder();
    for (const line of folded.split('\r\n')) {
      expect(enc.encode(line).length).toBeLessThanOrEqual(75);
    }
  });
});

describe('icsDateTime', () => {
  it('formats an IST date-time with zero padding', () => {
    expect(icsDateTime('2026-09-14', 8 * 60 + 30)).toBe('20260914T083000');
    expect(icsDateTime('2026-09-14', 5)).toBe('20260914T000500');
  });

  it('wraps a minute count past midnight', () => {
    expect(icsDateTime('2026-09-14', 1440 + 10)).toBe('20260914T001000');
  });
});

describe('utcStamp', () => {
  it('formats a UTC timestamp', () => {
    expect(utcStamp(new Date(Date.UTC(2026, 8, 14, 3, 0, 0)))).toBe('20260914T030000Z');
  });
});

describe('shiftIsoByMinutes', () => {
  it('keeps a same-day arrival on the same date', () => {
    expect(shiftIsoByMinutes('2026-09-14', 600)).toEqual({ dateIso: '2026-09-14', minuteOfDay: 600 });
  });

  it('moves an overnight arrival to the next day', () => {
    expect(shiftIsoByMinutes('2026-09-14', 1440 + 370)).toEqual({ dateIso: '2026-09-15', minuteOfDay: 370 });
  });

  it('crosses month and year boundaries', () => {
    expect(shiftIsoByMinutes('2026-12-31', 1440).dateIso).toBe('2027-01-01');
  });
});

describe('eventToIcs', () => {
  it('emits TZID-tagged start and end in IST', () => {
    const ics = eventToIcs(EVENT, new Date(Date.UTC(2026, 8, 14, 3, 0, 0)));
    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics).toContain('DTSTART;TZID=Asia/Kolkata:20260914T083000');
    expect(ics).toContain('DTEND;TZID=Asia/Kolkata:20260915T061000');
    expect(ics).toContain('DTSTAMP:20260914T030000Z');
    expect(ics).toContain('END:VEVENT');
  });

  it('escapes a newline in the description', () => {
    const ics = eventToIcs(EVENT);
    expect(ics).toContain('Fare ₹2\\,500 estimated');
    expect(ics).toContain('Rajdhani\\nFare');
  });
});

describe('buildIcs', () => {
  it('wraps events in a complete calendar with the IST zone block', () => {
    const ics = buildIcs([EVENT], { name: 'Test trip', now: new Date(Date.UTC(2026, 8, 14)) });
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('VERSION:2.0');
    expect(ics).toContain('X-WR-CALNAME:Test trip');
    expect(ics).toContain('BEGIN:VTIMEZONE');
    expect(ics).toContain('TZID:Asia/Kolkata');
    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics.trimEnd().endsWith('END:VCALENDAR')).toBe(true);
  });

  it('includes one VEVENT per input event', () => {
    const second: CalendarEvent = { ...EVENT, uid: 'u2', title: 'Return' };
    const ics = buildIcs([EVENT, second], { name: 'x' });
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(ics).toContain('UID:u2');
  });
});

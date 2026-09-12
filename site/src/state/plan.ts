/**
 * plan.ts — pure helpers for the planner, on the main-thread side.
 *
 * Everything here is synchronous and side-effect free, which is the point: these are the parts
 * worth unit-testing, and they cannot block the UI because none of them touch the network or
 * the worker.
 */

import type { Station, StationIndex } from '../lib/stations';
import { haversineKm } from '../lib/geo';

/**
 * How many candidate destinations to try when the traveller has not named one.
 *
 * Each costs one full search, so this number is a direct latency budget. Measured on the real
 * dataset a single search averages ~3 ms at one transfer, so 36 candidates is ~110 ms — fast
 * enough to feel instant, wide enough to offer a real choice. Going much higher stops being
 * worth it: past ~40 the extra candidates are increasingly obscure halts nobody would pick.
 */
export const EXPLORE_CANDIDATES = 36;

/** Distance bands for candidates, as [minKm, maxKm, share]. */
const BANDS: ReadonlyArray<[number, number, number]> = [
  [120, 400, 0.35],    // weekend: close enough to leave Friday and be back Sunday
  [400, 1000, 0.40],   // the classic Indian long-weekend distance
  [1000, 2200, 0.25],  // a real holiday, worth a night on the train
];

/**
 * Pick candidate destinations for a traveller who has holidays but no destination.
 *
 * Deliberately NOT "every station ranked by size". That would return forty near-identical
 * suburbs of the origin city. The useful answer is spread across distance bands and biased
 * toward places a person would actually want to be, which in the absence of any tourism data
 * means: well-served stations, because a station many trains call at is a station people go to.
 *
 * Deterministic for a given origin, so re-running the search does not reshuffle the list under
 * the traveller's feet while they are reading it.
 */
export function candidateDestinations(
  stations: StationIndex,
  origin: Station,
  limit = EXPLORE_CANDIDATES,
): Station[] {
  if (origin.lat === null || origin.lon === null) return [];

  // Bucket by band so the result spans distances rather than clustering at the nearest one.
  const buckets: Station[][] = BANDS.map(() => []);
  const n = stations.count;

  for (let i = 0; i < n; i++) {
    const s = stations.at(i);
    if (s.i === origin.i) continue;
    // Only junctions and metros: a candidate that is a two-train halt cannot be reached
    // interestingly and would mostly produce empty results.
    if (s.rank < 2 || s.lat === null || s.lon === null) continue;
    const km = haversineKm(origin.lat, origin.lon, s.lat, s.lon);
    for (let b = 0; b < BANDS.length; b++) {
      if (km >= BANDS[b][0] && km <= BANDS[b][1]) { buckets[b].push(s); break; }
    }
  }

  // Within a band, prefer stations more trains call at — the honest proxy for "somewhere worth
  // going" available without shipping a tourism dataset.
  for (const b of buckets) b.sort((x, y) => y.calls - x.calls || x.code.localeCompare(y.code));

  // Take each band's quota in turn. A band that cannot fill its quota simply contributes less;
  // the shortfall is not redistributed, because padding the list with far-fetched candidates
  // would be worse than showing a shorter, believable one.
  const out: Station[] = [];
  for (let b = 0; b < buckets.length; b++) {
    const want = Math.max(1, Math.round(limit * BANDS[b][2]));
    for (let i = 0; i < buckets[b].length && i < want; i++) out.push(buckets[b][i]);
  }
  return out.slice(0, limit);
}

/** Minutes since midnight -> HH:MM, for a time input's value. */
export function minutesToTime(min: number): string {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** HH:MM -> minutes since midnight, or null if the input is not a time. */
export function timeToMinutes(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Today's date in the traveller's own timezone, as YYYY-MM-DD. */
export function todayIso(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Add days to an ISO date without going through UTC, which would shift the date at midnight. */
export function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  // Local-time construction: `new Date(iso)` alone parses as UTC midnight and then formats back
  // a day early for anyone west of Greenwich.
  const dt = new Date(y, m - 1, d + days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

/** "3h 20m" rather than "200m", because that is how people describe a journey. */
export function durationLabel(min: number): string {
  if (!Number.isFinite(min) || min < 0) return '—';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/** Rupees with Indian digit grouping (12,34,567 rather than 1,234,567). */
export function rupees(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return `₹${Math.round(value).toLocaleString('en-IN')}`;
}

/**
 * Arrival phrased relative to the departure day.
 *
 * "06:10 (+2)" is what a timetable shows and what a traveller needs: an overnight train that
 * arrives two days later must not look like it arrives before it left.
 */
export function arrivalLabel(depMin: number, arrMin: number): string {
  const wall = ((arrMin % 1440) + 1440) % 1440;
  const hhmm = `${String(Math.floor(wall / 60)).padStart(2, '0')}:${String(wall % 60).padStart(2, '0')}`;
  const days = Math.floor(arrMin / 1440) - Math.floor(depMin / 1440);
  if (days <= 0) return hhmm;
  return days === 1 ? `${hhmm} next day` : `${hhmm} +${days} days`;
}

/**
 * The widening ladder: [maxTransfers, maxJourneyMin, maxWaitMin] per rung.
 *
 * Lives here rather than in the search hook so the golden corpus can apply exactly the same
 * ladder the app does. A corpus that recorded raw single-search results would characterise a
 * code path no traveller ever takes, and would keep passing after the app's real behaviour
 * changed.
 *
 * Ordered cheapest first: rung 0 is what most journeys need, and each rung after it costs
 * roughly double the previous, so climbing only on failure keeps the common case fast.
 *
 * The top rung goes to 4 changes and 60 hours. That is deliberately beyond what anyone would
 * pick for pleasure, and it exists because "we could not find anything" is a much worse answer
 * than "here is a four-change itinerary, if you really want to go". The UI says which rung
 * produced the result, so an absurd itinerary is never presented as a normal one.
 */
export const SEARCH_LADDER: ReadonlyArray<readonly [number, number, number]> = [
  [2, 2880, 480],
  [3, 2880, 720],
  [4, 3600, 1440],
];

/** Classes worth offering, in the order a traveller thinks about them. */
export const CLASS_CHOICES: ReadonlyArray<{ code: string; label: string }> = [
  { code: '', label: 'Cheapest available' },
  { code: 'SL', label: 'Sleeper (SL)' },
  { code: '3A', label: 'AC 3-tier (3A)' },
  { code: '2A', label: 'AC 2-tier (2A)' },
  { code: '1A', label: 'AC First (1A)' },
  { code: 'CC', label: 'AC Chair car (CC)' },
  { code: '2S', label: 'Second sitting (2S)' },
];

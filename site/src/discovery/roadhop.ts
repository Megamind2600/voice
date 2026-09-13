/**
 * roadhop.ts — how long the last leg takes, when the thing you came to see is not at the station.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT `transfers.roadMinutes`
 * ---------------------------------------------------------------------------
 * A terminal-to-terminal transfer is an urban problem: you are crossing a city you have just
 * arrived in, at 22 km/h including signals, and the fixed overhead is finding a taxi at a station
 * exit. A destination road hop is a different problem — 30 km to a temple, 80 km up a ghat road,
 * 12 km to a beach — and pricing it with the urban model would say a 60 km hop takes four hours.
 * It does not, and a planner that says so is worse than one that says nothing.
 *
 * So: a second, explicitly separate model for out-of-town distances, documented here rather than
 * borrowed. It is coarser than the urban one on purpose — the inputs are approximate kilometres
 * authored against maps, not measured routes — and it is never used to make a connection
 * decision. Nothing routes through these numbers; they are advice printed next to a place.
 *
 * The authored `km` values are already road distances, so this module applies NO circuity
 * multiplier. Applying `URBAN_ROAD_CIRCUITY` on top of a road distance would inflate every hop by
 * a third for no reason — a mistake worth naming, because the urban constant is imported in three
 * other files and would look natural here.
 */

/**
 * Average speed for a whole outstation hop, in km/h.
 *
 * Deliberately a mid-figure rather than an optimist's highway speed: the hops this is used for
 * include ghat roads where 20 km/h is a good day, and the failure mode of an over-fast estimate
 * is somebody leaving an hour too late. 38 km/h keeps the 15 km temple run realistic and the
 * 90 km hill drive slightly pessimistic, which is the right way round.
 */
export const HOP_KMH = 38;

/** Getting the vehicle, agreeing the fare, loading up. Independent of distance. */
export const HOP_OVERHEAD_MIN = 15;

/** Taxi fare used for the money figure. Negotiated outstation rates land near this; buses cost a fraction. **Authored.** */
export const HOP_PER_KM_RUPEES = 16;
export const HOP_MIN_RUPEES = 150;

/** Minutes for a road hop of `km`, rounded to the nearest five. */
export function roadHopMinutes(km: number): number {
  const raw = HOP_OVERHEAD_MIN + (Math.max(0, km) / HOP_KMH) * 60;
  return Math.max(10, Math.round(raw / 5) * 5);
}

/** Rupees for a taxi over `km`, rounded to the nearest fifty. Not what a bus costs. */
export function roadHopRupees(km: number): number {
  const raw = Math.max(HOP_MIN_RUPEES, Math.max(0, km) * HOP_PER_KM_RUPEES);
  return Math.round(raw / 50) * 50;
}

/**
 * The hop in words: `≈ 45 min by road`, `≈ 2 h 20 by road`.
 *
 * Says "≈" rather than giving a time, because the underlying distance is an authored planning
 * figure. A traveller can act on "about two hours"; they would be misled by "2:10".
 */
export function roadHopLabel(km: number): string {
  const mins = roadHopMinutes(km);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `≈ ${h > 0 ? `${h} h ` : ''}${h > 0 && m > 0 ? `${m} ` : ''}${h === 0 ? `${m} min ` : ''}by road`.replace('  ', ' ');
}

/**
 * types.ts — the shape of a destination profile.
 *
 * A profile answers the question the timetable cannot: *why would anyone go here, and what is
 * there once they arrive*. It is editorial content authored for this project, which is a
 * different kind of claim from everything else in the app — the timetable is harvested CC0 data
 * and the fares come from a published tariff, but a sentence like "the ghats at dawn are the
 * point" is somebody's judgement. Two rules follow from that, and both are enforced by the UI
 * and by tests:
 *
 *   1. **Nothing time-sensitive.** No opening hours, no ticket prices, no "closed on Mondays".
 *      Those change, and a stale one sends somebody on a wasted trip.
 *   2. **Distances are approximate and say so.** `km` is a planning figure between the station
 *      and the site, rendered with a `≈` and turned into a time by the same road model the
 *      router uses for terminal transfers, so the two cannot contradict each other on screen.
 *
 * The alternative — shipping nothing — is what the app did before, and it is why a results page
 * full of station names read as a list of places to change trains rather than places to go.
 */

/** One thing worth seeing, with a rough distance from the profile's primary station. */
export interface Sight {
  /** How a traveller would search for it. */
  name: string;
  /** A single word for the chip: temple, fort, beach, ghat, museum, sanctuary… */
  kind: string;
  /** Approximate km from the primary station. Not a surveyed figure. */
  km: number;
}

/**
 * A site that is NOT at the railhead — the "I get off and take a road hop" case.
 *
 * These are the entries that answer the second half of the question people actually ask: not
 * "which town is this train stopping at" but "can I reach the thing I came for from there".
 */
export interface Gateway {
  name: string;
  /** Approximate road km from the station. */
  km: number;
  /** How the last leg is usually done. Plain language, no timetables. */
  note: string;
}

export interface DestinationProfile {
  /**
   * Station codes this profile answers for, most representative first.
   *
   * Codes rather than names because the dataset's names are its own ("Trivandrum Central",
   * "Bangalore City Jn") and a name join would break silently on the next harvest.
   */
  codes: readonly string[];
  /** The city as travellers say it. */
  name: string;
  /** One line: why go. The whole point of this dataset. */
  why: string;
  /** Two or three words for scanning: `hill station`, `UNESCO`, `pilgrimage`. */
  tags: readonly string[];
  /** At least one, ordered by what to see first. */
  sights: readonly Sight[];
  /** Only present where the thing worth seeing is a road hop from the railway. */
  gateways?: readonly Gateway[];
  /** Coarse and stable: a season, never a month-by-month claim. */
  best?: string;
  /** How long people usually give it. */
  days?: string;
}

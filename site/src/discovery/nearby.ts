/**
 * nearby.ts — what to do about a destination nobody has written anything about yet.
 *
 * Most stations in the timetable are junctions, halts and suburbs, and most of them are never
 * going to get an authored profile. Saying nothing is a missed chance: "Itarsi Junction" is a
 * perfectly useful answer to "where can I get to", but a traveller standing in a list of station
 * names needs to be told that this particular one is a place to change trains, not a place to
 * spend a holiday.
 *
 * So for an unprofiled destination this module answers the next question instead — *what is near
 * here?* — straight from the coordinates the packed dataset already carries. It is not an
 * opinion and it is not a recommendation: it is a distance between two points, which is exactly
 * the kind of statement this app is allowed to make on its own authority.
 *
 * The candidates are the profiled stations only. That keeps the answer inside the material the
 * app actually has, and it means the list grows automatically as profiles are added — the notes
 * arrive from `data/profiles.json` at runtime, so the index is passed in rather than imported.
 */
import type { StationIndex } from '../lib/stations';
import { haversineKm } from '../lib/geo';
import { profileFor, type ProfileIndex } from './profiles';

/** A profiled station within reach of an unprofiled one. */
export interface NearbyPlace {
  /** The profile's station code. */
  code: string;
  /** The place as travellers say it — the profile's own name, not the station's. */
  name: string;
  /** Straight-line km between the two stations. Road distance is longer; the UI says so. */
  km: number;
}

/**
 * The closest profiled places to a station, nearest first.
 *
 * Straight-line distance, deliberately: it is the one distance the data supports without a road
 * network, and it is honest about being a floor ("at least this far"). The UI labels it as
 * straight-line so nobody reads it as a drive time.
 *
 * Returns [] when the station has no coordinates, when the index is not loaded, or when the
 * station is itself profiled — in which case the caller has better content to show.
 */
export function nearbyProfiled(
  stations: StationIndex | null,
  ix: number,
  profiles: ProfileIndex | null,
  limit = 3,
): NearbyPlace[] {
  if (!stations || !profiles) return [];
  const here = stations.at(ix);
  if (here.lat === null || here.lon === null) return [];
  if (profileFor(profiles, here.code)) return [];

  const out: NearbyPlace[] = [];
  for (const p of profiles.profiles) {
    const code = p.codes[0];
    const jx = stations.indexOfCode(code);
    if (jx < 0) continue;
    const there = stations.at(jx);
    if (there.lat === null || there.lon === null) continue;
    const km = haversineKm(here.lat, here.lon, there.lat, there.lon);
    out.push({ code, name: p.name, km });
  }
  out.sort((a, b) => a.km - b.km || a.name.localeCompare(b.name));
  return out.slice(0, limit);
}

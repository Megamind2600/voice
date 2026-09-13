/**
 * index.ts — the destination-notes index and the lookups over it.
 *
 * The notes themselves are DATA (`public/data/profiles.json`), not code. A hundred-odd cities of
 * prose is a perfectly good thing to fetch once and a terrible thing to make every visitor parse
 * before the planner can draw: as a module it was 16.5 KB gzipped on the critical path, and it
 * would grow by a kilobyte per city forever. As data it is ~18 KB fetched once, off the main
 * bundle, and the JS budget stays a budget for code.
 *
 * So this module holds only the two things that must behave identically wherever they are used:
 * how a list of profiles becomes an index, and how a station code resolves to an entry.
 *
 * A profile can claim several codes — a city with more than one terminal, or a station whose name
 * a traveller would never type but whose city they would recognise — and every claimed code
 * resolves to the same profile, with `primary` telling the UI which station the distances were
 * measured from. First writer wins, and a collision is recorded rather than hidden: the validator
 * test fails on one, because a silently shadowed profile is a bug nobody would ever notice.
 */
import type { DestinationProfile } from './types';

export type { DestinationProfile, Gateway, Sight } from './types';

export interface ResolvedProfile {
  profile: DestinationProfile;
  /** The code this lookup was made with. */
  code: string;
  /** The code the profile's distances are measured from (the first one it lists). */
  primary: string;
  /** True when the station asked about is not the one the distances were measured from. */
  viaOtherTerminal: boolean;
}

export interface ProfileIndex {
  /** Every profile, in file order. */
  profiles: readonly DestinationProfile[];
  /** Every code any profile claims, for the validator and for counts in the UI. */
  claimed: readonly string[];
  /** Codes claimed by more than one profile. Always empty in a healthy file. */
  collisions: readonly string[];
  byCode: ReadonlyMap<string, DestinationProfile>;
}

const EMPTY: ProfileIndex = { profiles: [], claimed: [], collisions: [], byCode: new Map() };

/** Build the lookup once, for the profiles that were actually loaded. */
export function buildProfileIndex(profiles: readonly DestinationProfile[]): ProfileIndex {
  const byCode = new Map<string, DestinationProfile>();
  const collisions: string[] = [];
  for (const p of profiles) {
    for (const code of p.codes ?? []) {
      const key = code.trim().toUpperCase();
      if (byCode.has(key)) collisions.push(key);
      else byCode.set(key, p);
    }
  }
  return { profiles, claimed: [...byCode.keys()], collisions, byCode };
}

/**
 * The profile for a station code, or null.
 *
 * Never throws and never guesses: an unknown station is the normal case — most stations in the
 * timetable are junctions and halts that no editor is ever going to write about.
 */
export function profileFor(
  index: ProfileIndex | null | undefined,
  code: string | null | undefined,
): ResolvedProfile | null {
  if (!index || !code) return null;
  const key = code.trim().toUpperCase();
  const profile = index.byCode.get(key);
  if (!profile) return null;
  const primary = profile.codes[0];
  return { profile, code: key, primary, viaOtherTerminal: primary !== key };
}

/** An index with nothing in it, for callers that have not loaded the notes yet. */
export function emptyProfileIndex(): ProfileIndex {
  return EMPTY;
}

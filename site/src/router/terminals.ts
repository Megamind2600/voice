/**
 * terminals.ts — city terminal groups, as station CODES, resolved to indices by the caller.
 *
 * A naive `origin -> destination` query is wrong for Indian cities before the algorithm
 * even runs. "From Delhi" is not NDLS: it is seven stations, and a train to Goa leaves from
 * Hazrat Nizamuddin while one to Kolkata leaves from Anand Vihar. Asking a user to pick the
 * right terminal is asking them to do the planner's job.
 *
 * The table is authored as codes rather than indices because indices are an artefact of one
 * particular packed dataset — they change when the data is rebuilt. Codes are stable. The
 * main thread holds the StationIndex and resolves; the worker keeps speaking indices, which
 * preserves the existing rule that no station strings cross the worker boundary.
 *
 * Two codes in the source table do NOT resolve against the bootstrap data: SMVB (Bengaluru
 * Sir M. Visvesvaraya Terminal, opened 2022) and SBIB (Sabarmati BG, a later rename). The
 * dataset is from 2016. Resolution therefore SKIPS unknown codes rather than failing —
 * a terminal group that is missing one member is still useful, whereas refusing to plan
 * from Bengaluru at all is not. The skip is reported so it is visible rather than silent.
 */

export interface TerminalGroupSpec {
  /** Display name of the city. */
  city: string;
  /** Member station codes. */
  stations: readonly string[];
  /**
   * The station to prefer when several in the group serve the same train. Usually the
   * busiest terminal, because it has the best onward connections.
   */
  hub: string;
  /**
   * Fallback road time between terminals, in minutes, used when coordinates are missing so
   * the distance cannot be measured. Deliberately pessimistic: these are not adjacent
   * platforms, they are separate buildings across a city.
   */
  interTerminalMinutes: number;
}

export const TERMINAL_GROUPS: readonly TerminalGroupSpec[] = [
  {
    city: 'Delhi', hub: 'NDLS', interTerminalMinutes: 45,
    stations: ['NDLS', 'NZM', 'DLI', 'ANVT', 'DEE', 'NNO', 'SZM'],
  },
  {
    // Mumbai's spread matters more than any other city's: Kalyan, Panvel and Thane are
    // 60-90 min from the island-city terminals, so treating them as interchangeable without
    // a priced road edge would invent free transfers that do not exist.
    city: 'Mumbai', hub: 'CSTM', interTerminalMinutes: 60,
    stations: ['CSTM', 'BCT', 'LTT', 'DR', 'BDTS', 'KYN', 'PNVL', 'TNA'],
  },
  { city: 'Kolkata', hub: 'HWH', interTerminalMinutes: 40, stations: ['HWH', 'SDAH', 'KOAA', 'SHM'] },
  { city: 'Chennai', hub: 'MAS', interTerminalMinutes: 35, stations: ['MAS', 'MSB', 'TBM', 'MS'] },
  {
    city: 'Bengaluru', hub: 'SBC', interTerminalMinutes: 45,
    stations: ['SBC', 'YPR', 'BAND', 'SMVB', 'KSR', 'WFD'],
  },
  { city: 'Hyderabad', hub: 'SC', interTerminalMinutes: 40, stations: ['SC', 'KCG', 'HYB', 'BMO'] },
  {
    // Goa is the extreme case: Madgaon and Vasco are 40 km apart on slow roads, and
    // Kudal/Madure are in Maharashtra entirely. Someone saying "I'm in Goa" needs all of
    // them considered, with the transfer honestly priced.
    city: 'Goa', hub: 'MAO', interTerminalMinutes: 90,
    stations: ['MAO', 'VSG', 'THVM', 'KUDL', 'MDVL'],
  },
  { city: 'Pune', hub: 'PUNE', interTerminalMinutes: 30, stations: ['PUNE', 'SVJR', 'KK'] },
  { city: 'Ahmedabad', hub: 'ADI', interTerminalMinutes: 35, stations: ['ADI', 'SBIB', 'GNC', 'CYI'] },
];

export interface ResolvedGroup {
  city: string;
  hub: number;
  /** Station indices. Length may be shorter than the spec when codes did not resolve. */
  members: number[];
  /** Codes from the spec that were absent from the station index. */
  unresolved: string[];
  fallbackMinutes: number;
}

export interface ResolveResult {
  groups: ResolvedGroup[];
  /** station index -> group index, or -1. Sized to the station count. */
  groupOfStation: Int32Array;
  /** Every code that did not resolve, across all groups, for reporting. */
  unresolvedCodes: string[];
}

/**
 * Resolve the code table against a station index.
 *
 * A station is assigned to at most one group; if two specs claimed the same station the
 * first wins, because silently belonging to two cities would let a transfer be counted
 * twice.
 */
export function resolveTerminalGroups(
  stationCount: number,
  codeToIndex: (code: string) => number | null,
): ResolveResult {
  const groupOfStation = new Int32Array(stationCount).fill(-1);
  const groups: ResolvedGroup[] = [];
  const unresolvedCodes: string[] = [];
  // Stations claimed by a group that is later discarded. Assignment has to be deferred
  // until the group is known to survive: writing `groups.length` eagerly would attribute
  // those stations to whichever group is pushed NEXT, silently inventing a city membership.
  let claimed: number[] = [];

  for (const spec of TERMINAL_GROUPS) {
    const members: number[] = [];
    const unresolved: string[] = [];
    let hub = -1;
    claimed = [];
    for (const code of spec.stations) {
      const idx = codeToIndex(code);
      if (idx === null || idx < 0 || idx >= stationCount) {
        unresolved.push(code);
        unresolvedCodes.push(code);
        continue;
      }
      // Already a member of an earlier city: leave it there. Belonging to two groups would
      // let the same transfer be offered twice under different city names.
      if (groupOfStation[idx] !== -1 || members.includes(idx)) continue;
      members.push(idx);
      claimed.push(idx);
      if (code === spec.hub) hub = idx;
    }
    // A group with one member is not a group — there is nothing to transfer between, and
    // keeping it would add road edges from a station to itself.
    if (members.length < 2) continue;

    const id = groups.length;
    for (const idx of claimed) groupOfStation[idx] = id;
    groups.push({
      city: spec.city,
      // If the named hub did not resolve, fall back to the first member rather than
      // dropping the whole city.
      hub: hub >= 0 ? hub : members[0],
      members,
      unresolved,
      fallbackMinutes: spec.interTerminalMinutes,
    });
  }

  return { groups, groupOfStation, unresolvedCodes: dedupe(unresolvedCodes) };
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

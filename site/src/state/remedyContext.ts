/**
 * remedyContext.ts — assembling a RemedyContext on the main thread.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT IN THE WORKER
 * ---------------------------------------------------------------------------
 * Remedies need station CODES and NAMES (a split candidate is useless as "station 4021"), city
 * groups, and road times between terminals. The worker deliberately holds no StationIndex: it
 * routes over typed arrays of indices, and loading stations.bin there as well would mean
 * downloading the same 76 KB twice on a mobile connection for no benefit.
 *
 * So the split is: the worker owns the graph and answers `train:stops` with raw indices, and the
 * main thread — which already has the StationIndex, the authored city groups, and the list of
 * itineraries it just rendered — turns that into a context. Everything here is pure, which is why
 * it lives in state/ rather than inside a component: it can be tested without a DOM, and the
 * panel stays a rendering concern.
 *
 * The road-time convention is copied from `TransferModel` on purpose. If the remedy panel said a
 * terminal change took 25 minutes while the router had already priced the same pair at 40, the
 * two numbers would be sitting on the same screen disagreeing, and the traveller would have no
 * way to tell which one the itinerary was built from.
 */
import type { StationIndex } from '../lib/stations';
import type { RawStop } from '../lib/protocol';
import type { Stop } from '../lib/graph';
import type { ResolvedGroup } from '../router/terminals';
import type { RailSegment } from '../router/journey';
import type { RemedyContext } from '../availability/remedies';
import { roadMinutes } from '../router/transfers';
import { haversineKm } from '../lib/geo';
import { istNow } from '../availability/rules';

/**
 * Enrich the worker's raw stop list into the `Stop` shape the split logic reads.
 *
 * Field-for-field the same construction as `Graph.stopsOfTrain`, because the two must agree: the
 * router built the leg from one and remedy ① decides feasibility from the other. Arrival and
 * departure are minutes after the train's origin departure, so `dayOff` is the same floor-divide
 * by 1440, and a halt only exists where both times are known — the origin and the terminal have
 * one null each and therefore a zero halt, not a negative one.
 */
export function stopsFromRaw(raw: readonly RawStop[], stations: StationIndex): Stop[] {
  return raw.map((r) => {
    const s = stations.at(r.station);
    const haltMin = r.arrMin === null || r.depMin === null ? 0 : Math.max(0, r.depMin - r.arrMin);
    return {
      seq: r.seq,
      station: r.station,
      code: s.code,
      name: s.name,
      arrMin: r.arrMin,
      depMin: r.depMin,
      haltMin,
      distKm: r.distKm,
      dayOff: Math.floor((r.depMin ?? r.arrMin ?? 0) / 1440),
    };
  });
}

/** One other station in the same city, and how long it takes to reach by road. */
export interface CityAlternative {
  code: string;
  name: string;
  minutesByRoad: number;
  /** True when no coordinates were available and the authored city estimate was used instead. */
  estimated: boolean;
}

/**
 * Other terminals in the same city as `station`, nearest first.
 *
 * Returns an empty list when the station is not in any authored group, which is the honest answer
 * for the vast majority of stations in India — remedy ⑥ then has nothing to offer and says so,
 * rather than inventing a nearby station from straight-line distance alone.
 *
 * Where coordinates are missing for either end, the group's authored `fallbackMinutes` is used and
 * the result is flagged `estimated`. Dropping the edge instead would hide a real option; asserting
 * a precise time would be a guess dressed as a measurement.
 */
export function cityAlternatives(
  station: number,
  stations: StationIndex,
  groups: readonly ResolvedGroup[],
): CityAlternative[] {
  const group = groups.find((g) => g.members.includes(station));
  if (!group) return [];

  const here = stations.at(station);
  const out: CityAlternative[] = [];
  for (const other of group.members) {
    if (other === station) continue;
    const s = stations.at(other);
    const both = here.lat !== null && here.lon !== null && s.lat !== null && s.lon !== null;
    out.push({
      code: s.code,
      name: s.name,
      minutesByRoad: both ? roadMinutes(haversineKm(here.lat as number, here.lon as number, s.lat as number, s.lon as number)) : group.fallbackMinutes,
      estimated: !both,
    });
  }
  return out.sort((a, b) => a.minutesByRoad - b.minutesByRoad);
}

/**
 * Build the full context for one leg.
 *
 * `todayIso` comes from `istNow()`, not from the browser's local date: a traveller in London
 * planning at 23:30 GMT is already in the next day in India, and every booking window in this app
 * is an Indian one. Getting that wrong would tell someone Tatkal had closed when it opens in
 * thirty minutes.
 */
export function buildRemedyContext(args: {
  segment: RailSegment;
  stops: readonly Stop[];
  stations: StationIndex;
  groups: readonly ResolvedGroup[];
  alternativeItineraries: number;
  /** Whether this itinerary already contains a road hop. A property of the journey, not the leg. */
  roadHopPresent: boolean;
}): RemedyContext {
  const { segment, stops, stations, groups, alternativeItineraries, roadHopPresent } = args;
  return {
    todayIso: istNow().dateIso,
    offeredClasses: segment.trainClasses,
    runsDaysAssumed: segment.runsDaysAssumed,
    runsDays: segment.runsDays,
    boardAlternatives: cityAlternatives(segment.from, stations, groups),
    alightAlternatives: cityAlternatives(segment.to, stations, groups),
    stops,
    alternativeItineraries,
    roadHopPresent,
  };
}

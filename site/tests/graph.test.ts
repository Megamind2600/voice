import { describe, expect, it } from 'vitest';
import { Container, ContainerKind } from '../src/lib/binary';
import {
  Graph, decodeClasses, decodeRunsDays, fmtClock, fmtDuration, fmtWallClock,
  stationCountOf, toWallClock,
} from '../src/lib/graph';
import { buildGraphContainer } from './helpers';

// Two trains over four stations, exercising shared stations (index 1) so the adjacency
// transpose and the connection->train binary search both have something to resolve.
const TRAINS = [
  {
    number: '12301', name: 'Howrah Rajdhani', type: 1, classes: 0b111, runsDays: 127,
    flags: 6, durationMin: 1020, distanceKm: 1447, originDepMin: 1015,   // Bootstrap | RunsDaysAssumed
    stops: [0, 1, 2],
    legs: [[0, 185, 265], [190, 1020, 1447]] as Array<[number, number, number]>,
  },
  {
    number: '12702', name: 'Dakshin Express', type: 9, classes: 0b110000, runsDays: 0b0101010,
    flags: 7, durationMin: 900, distanceKm: 1200, originDepMin: 430,    // + ClassesInferred
    stops: [1, 3],
    legs: [[0, 900, 1200]] as Array<[number, number, number]>,
  },
];
const STATION_COUNT = 4;

function graph() {
  const c = Container.parse(
    buildGraphContainer(TRAINS, STATION_COUNT),
    ContainerKind.Graph,
  );
  return Graph.fromContainer(c, stationCountOf(c));
}

describe('formatters', () => {
  it('converts a train-relative offset to a true wall-clock time', () => {
    // 12301 leaves Howrah at 16:55 and the terminal is 1020 relative minutes later.
    expect(fmtWallClock(1015, 0)).toBe('16:55');
    expect(fmtWallClock(1015, 1020)).toBe('09:55 +1d');
    expect(fmtWallClock(1015, null)).toBe('—');
  });

  it('never renders a relative offset as if it were a clock time', () => {
    // The bug this guards: a relative "17:00" reads as 5 pm.
    expect(fmtClock(1020)).toBe('17:00');
    expect(fmtWallClock(1015, 1020)).not.toBe(fmtClock(1020));
  });

  it('renders same-day times without a day prefix', () => {
    expect(fmtClock(0)).toBe('00:00');
    expect(fmtClock(1015)).toBe('16:55');
  });
  it('renders next-day times the way a timetable does', () => {
    expect(fmtClock(1440)).toBe('+1 00:00');
    expect(fmtClock(1020 + 1440)).toBe('+1 17:00');
  });
  it('renders a missing time as an em dash, not "NaN"', () => {
    expect(fmtClock(null)).toBe('—');
  });
  it('formats durations in hours and zero-padded minutes', () => {
    expect(fmtDuration(0)).toBe('0m');
    expect(fmtDuration(59)).toBe('59m');
    expect(fmtDuration(60)).toBe('1h 00m');
    expect(fmtDuration(1020)).toBe('17h 00m');
  });
});

describe('decodeClasses / decodeRunsDays', () => {
  it('expands a class bitmask in booking order, not bit order', () => {
    expect(decodeClasses(0b111)).toEqual(['1A', '2A', '3A']);
    expect(decodeClasses(0b110000)).toEqual(['CC', 'SL']);
    expect(decodeClasses(0)).toEqual([]);
  });
  it('reads a full week as Daily', () => {
    expect(decodeRunsDays(127)).toBe('Daily');
  });
  it('lists individual running days', () => {
    expect(decodeRunsDays(0b0101010)).toBe('Tue, Thu, Sat');
  });
  it('reports an empty mask as Unknown rather than silently claiming Daily', () => {
    expect(decodeRunsDays(0)).toBe('Unknown');
  });
});

describe('Graph', () => {
  const g = graph();

  it('decodes train headers', () => {
    expect(g.trainCount).toBe(2);
    expect(g.connCount).toBe(3);
    // Sorted by number, so 12301 is index 0.
    const t = g.train(0);
    expect(t.number).toBe('12301');
    expect(t.name).toBe('Howrah Rajdhani');
    expect(t.type).toBe('RAJ');
    expect(t.classes).toEqual(['1A', '2A', '3A']);
    expect(t.durationMin).toBe(1020);
    expect(t.distanceKm).toBe(1447);
    expect(t.origin).toBe(0);
    expect(t.destination).toBe(2);
    expect(t.legCount).toBe(2);
    expect(t.originDepMin).toBe(1015);
  });

  it('exposes the origin wall-clock departure so times can be made absolute', () => {
    expect(toWallClock(1015, 1020)).toEqual({ day: 1, minOfDay: 595 });
    expect(toWallClock(1015, 0)).toEqual({ day: 0, minOfDay: 1015 });
    expect(toWallClock(1015, null)).toBeNull();
  });

  it('propagates the per-train provenance flags', () => {
    expect(g.train(0).runsDaysAssumed).toBe(true);
    expect(g.train(0).classesInferred).toBe(false);
    // 12702 was packed with flags 7 = Bootstrap | RunsDaysAssumed | ClassesInferred
    expect(g.train(1).classesInferred).toBe(true);
    expect(g.train(1).runsDaysAssumed).toBe(true);
    expect(g.train(1).runsDays).toBe(0b0101010);
  });

  it('rejects an out-of-range train index', () => {
    expect(() => g.train(-1)).toThrow(RangeError);
    expect(() => g.train(g.trainCount)).toThrow(RangeError);
  });

  it('decodes legs with both endpoints', () => {
    const legs = g.legsOfTrain(0);
    expect(legs).toHaveLength(2);
    expect(legs[0]).toMatchObject({ from: 0, to: 1, depMin: 0, arrMin: 185, distKm: 265 });
    expect(legs[1]).toMatchObject({ from: 1, to: 2, depMin: 190, arrMin: 1020, distKm: 1447 });
  });

  it('recovers n+1 stops from n legs without storing stops explicitly', () => {
    const stops = g.rawStopsOfTrain(0);
    expect(stops).toHaveLength(3);
    expect(stops[0]).toMatchObject({ seq: 1, station: 0, arrMin: null, depMin: 0, distKm: 0 });
    expect(stops[1]).toMatchObject({ seq: 2, station: 1, arrMin: 185, depMin: 190, distKm: 265 });
    expect(stops[2]).toMatchObject({ seq: 3, station: 2, arrMin: 1020, depMin: null, distKm: 1447 });
  });

  it('builds departure adjacency per station', () => {
    expect([...g.departuresFrom(0)]).toEqual([0]);      // leg 0 of train 0
    expect([...g.departuresFrom(1)]).toHaveLength(2);   // leg 1 of train 0, leg 0 of train 1
    expect([...g.departuresFrom(3)]).toHaveLength(0);   // terminal
  });

  it('builds arrival adjacency per station', () => {
    expect([...g.arrivalsAt(1)]).toEqual([0]);
    expect([...g.arrivalsAt(2)]).toEqual([1]);
    expect([...g.arrivalsAt(0)]).toHaveLength(0);       // origin
  });

  it('returns a frozen empty array, not undefined, for a station with no service', () => {
    const d = g.departuresFrom(3);
    expect(d).toHaveLength(0);
    // Must not allocate per call, or a router scanning 7k stations would thrash GC.
    expect(g.departuresFrom(3)).toBe(d);
  });

  it('resolves which train owns a connection, by binary search', () => {
    expect(g.trainOfConnection(0)).toBe(0);
    expect(g.trainOfConnection(1)).toBe(0);
    expect(g.trainOfConnection(2)).toBe(1);
    expect(g.trainOfConnection(999)).toBe(-1);
  });

  it('lists every train calling at a station, deduplicated and ordered', () => {
    expect(g.trainsAt(1)).toEqual([0, 1]);   // shared station
    expect(g.trainsAt(0)).toEqual([0]);
    expect(g.trainsAt(3)).toEqual([1]);
  });

  it('reports the bootstrap flag from the container', () => {
    expect(g.isBootstrap).toBe(true);
  });

  it('summarises coverage', () => {
    expect(g.stats()).toMatchObject({ trains: 2, connections: 3, stationsWithService: 4 });
  });
});

describe('stationCountOf', () => {
  it('derives the station count from the geo section', () => {
    const c = Container.parse(buildGraphContainer(TRAINS, STATION_COUNT), ContainerKind.Graph);
    expect(stationCountOf(c)).toBe(STATION_COUNT);
  });

  it('returns 0 rather than throwing when there is no geo section', () => {
    const c = Container.parse(buildGraphContainer([], 0, []), ContainerKind.Graph);
    expect(stationCountOf(c)).toBe(0);
  });
});

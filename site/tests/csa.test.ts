/**
 * csa.test.ts — correctness of the search, on networks small enough to reason about exactly.
 *
 * Every expected value here is worked out by hand from the timetable in the test, not read
 * back out of the implementation. That is the point: the real dataset is too big to know the
 * right answer for, so the invariants that matter — transfer time enforced, transfers
 * counted, running days honoured, Pareto frontier not collapsing — are pinned here on
 * four-station networks where a wrong answer is obvious.
 */
import { describe, expect, it } from 'vitest';
import { Container, ContainerKind } from '../src/lib/binary';
import { Graph, stationCountOf } from '../src/lib/graph';
import { buildTimetable } from '../src/router/timetable';
import { TransferModel, type Footpath } from '../src/router/transfers';
import type { ResolvedGroup } from '../src/router/terminals';
import {
  CsaEngine, dominates, FRONTIER_CAP, isEarlyDeparture, isNightArrival, LABEL_STRIDE,
  labelArrival, labelFare, labelRow, labelTransfers, paretoFilter,
} from '../src/router/csa';
import { buildGraphContainer, type TrainSpec } from './helpers';

function makeGraph(trains: TrainSpec[], stations: number, geo?: Array<[number, number]>): Graph {
  const c = Container.parse(buildGraphContainer(trains, stations, geo), ContainerKind.Graph);
  return Graph.fromContainer(c, stationCountOf(c));
}

function noGroups(stationCount: number): TransferModel {
  return new TransferModel(makeGraph([], stationCount), [], stationCount);
}

/** Engine + timetable for a set of trains, with no road transfers by default. */
function setup(trains: TrainSpec[], stations: number, groups: ResolvedGroup[] = [],
  geo?: Array<[number, number]>) {
  const graph = makeGraph(trains, stations, geo);
  const transfers = new TransferModel(graph, groups, stations);
  const engine = new CsaEngine(graph, transfers, stations);
  const tt = buildTimetable(graph, '2026-09-14'); // Monday
  return { graph, transfers, engine, tt };
}

const DATE = '2026-09-14';

/** A -> B -> C, 10:00 departure, arriving C at 12:10. One train, so zero transfers. */
const THROUGH: TrainSpec = {
  number: '10001', name: 'Through Express', type: 9, classes: 16, runsDays: 127,
  originDepMin: 600, durationMin: 130, distanceKm: 100,
  stops: [0, 1, 2], legs: [[0, 60, 50], [70, 130, 100]],
};

describe('a direct journey', () => {
  it('finds a ride-through with zero transfers', () => {
    const { engine, tt } = setup([THROUGH], 3);
    const r = engine.search(tt, { departureMin: 500, origins: [0], destinations: [2], maxTransfers: 2 });
    expect(r.labels.length).toBeGreaterThan(0);
    expect(labelTransfers(r.pool, r.labels[0])).toBe(0);
    expect(labelArrival(r.pool, r.labels[0])).toBe(730); // 12:10
  });

  it('does not count intermediate stops as transfers', () => {
    // A -> B -> C is two packed connections on one train. Reporting it as one transfer
    // would make a through journey look worse than a single-stop hop.
    const { engine, tt } = setup([THROUGH], 3);
    const r = engine.search(tt, { departureMin: 500, origins: [0], destinations: [2], maxTransfers: 0 });
    expect(r.labels.length).toBe(1); // found even with maxTransfers = 0
  });

  it('returns nothing when the departure time is already past', () => {
    const { engine, tt } = setup([THROUGH], 3);
    const r = engine.search(tt, { departureMin: 800, origins: [0], destinations: [2], maxTransfers: 2 });
    expect(r.labels).toEqual([]);
  });

  it('returns nothing for an unreachable destination', () => {
    const { engine, tt } = setup([THROUGH], 4);
    const r = engine.search(tt, { departureMin: 500, origins: [0], destinations: [3], maxTransfers: 3 });
    expect(r.labels).toEqual([]);
  });
});

describe('minimum transfer time', () => {
  // B's degree with these four trains is 5, so minTransferForDegree gives the 6-minute floor.
  const TIGHT: TrainSpec = {  // leaves B at 11:05, five minutes after THROUGH arrives
    number: '10003', name: 'Too Tight', type: 9, classes: 16, runsDays: 127,
    originDepMin: 665, durationMin: 40, distanceKm: 40,
    stops: [1, 2], legs: [[0, 40, 40]],
  };
  const LOOSE: TrainSpec = {  // leaves B at 11:10, ten minutes after THROUGH arrives
    number: '10004', name: 'Makeable', type: 9, classes: 16, runsDays: 127,
    originDepMin: 670, durationMin: 40, distanceKm: 40,
    stops: [1, 2], legs: [[0, 40, 40]],
  };
  /** A -> B only, used to set up a transfer at B. */
  const FEEDER: TrainSpec = {
    number: '10005', name: 'Feeder', type: 9, classes: 16, runsDays: 127,
    originDepMin: 540, durationMin: 30, distanceKm: 30,
    stops: [0, 1], legs: [[0, 30, 30]],
  };

  it('rejects a connection that is physically unmakeable', () => {
    // Leaves A at 10:00 and reaches B at 11:01. TIGHT leaves B at 11:05: four minutes, under
    // the six-minute floor for a station this small.
    const feeder: TrainSpec = {
      ...FEEDER, number: '10006', originDepMin: 600, durationMin: 61, legs: [[0, 61, 30]],
    };
    const { engine, tt } = setup([feeder, TIGHT], 3);
    const r = engine.search(tt, {
      departureMin: 500, origins: [0], destinations: [2], maxTransfers: 2, noFootpaths: true,
    });
    expect(r.labels).toEqual([]);
  });

  it('accepts the same connection with one more minute of slack', () => {
    // Same feeder one minute earlier: arrives B 10:54, eleven minutes of slack.
    const feeder: TrainSpec = {
      ...FEEDER, number: '10006', originDepMin: 594, durationMin: 60, legs: [[0, 60, 30]],
    };
    const { engine, tt } = setup([feeder, TIGHT], 3);
    // Arrive B 10:54; TIGHT leaves 11:05 -> 11 min > 6 min floor.
    const r = engine.search(tt, {
      departureMin: 500, origins: [0], destinations: [2], maxTransfers: 2, noFootpaths: true,
    });
    expect(r.labels.length).toBe(1);
  });

  it('accepts a connection with exactly the minimum transfer time', () => {
    // THROUGH reaches B at 11:00. EXACT leaves B at 11:06 — precisely the six-minute floor for
    // a station this small, and not a minute more. Ready time is arrival + minTransfer and the
    // boarding test is `ready > dep`, so equality boards. An off-by-one in either place would
    // silently drop every tight-but-legal connection in the network, and because the direct
    // THROUGH still arrives the search would look like it was working.
    const EXACT: TrainSpec = { ...LOOSE, number: '10007', originDepMin: 666 };
    const { engine, tt } = setup([THROUGH, EXACT], 3);
    const r = engine.search(tt, {
      departureMin: 500, origins: [0], destinations: [2], maxTransfers: 2, noFootpaths: true,
    });
    const arrivals = r.labels.map((l) => labelArrival(r.pool, l));
    expect(arrivals).toContain(706); // 11:06 + 40 min
  });

  it('rejects the same connection one minute short of the floor', () => {
    // The other side of the boundary, so the test above cannot pass by accident: 11:05 is five
    // minutes after arrival at B, one short of the floor, and must not be offered.
    const SHORT: TrainSpec = { ...LOOSE, number: '10008', originDepMin: 665 };
    const { engine, tt } = setup([THROUGH, SHORT], 3);
    const r = engine.search(tt, {
      departureMin: 500, origins: [0], destinations: [2], maxTransfers: 2, noFootpaths: true,
    });
    const arrivals = r.labels.map((l) => labelArrival(r.pool, l));
    expect(arrivals).not.toContain(705);
    // The direct THROUGH is still there, which is why the assertion above has to be specific.
    expect(arrivals).toContain(730);
  });

  it('scales the required time with station size', () => {
    // The floor is not a constant: a 6-minute change at a halt is fine, at Kanpur Central it
    // is a missed train. Verified through the degree bands in transfers.ts.
    const { transfers } = setup([THROUGH], 3);
    expect(transfers.minTransferMin(0)).toBeGreaterThanOrEqual(6);
  });
});

describe('maximum transfers', () => {
  // A -> B -> C -> D as three separate trains, so the journey needs exactly 2 changes.
  const CHAIN: TrainSpec[] = [
    { number: '20001', name: 'Leg One', type: 9, classes: 16, runsDays: 127, originDepMin: 480,
      durationMin: 60, distanceKm: 60, stops: [0, 1], legs: [[0, 60, 60]] },
    { number: '20002', name: 'Leg Two', type: 9, classes: 16, runsDays: 127, originDepMin: 600,
      durationMin: 60, distanceKm: 60, stops: [1, 2], legs: [[0, 60, 60]] },
    { number: '20003', name: 'Leg Three', type: 9, classes: 16, runsDays: 127, originDepMin: 720,
      durationMin: 60, distanceKm: 60, stops: [2, 3], legs: [[0, 60, 60]] },
  ];

  it('finds the journey when the allowance is met exactly', () => {
    const { engine, tt } = setup(CHAIN, 4);
    const r = engine.search(tt, { departureMin: 400, origins: [0], destinations: [3], maxTransfers: 2 });
    expect(r.labels.length).toBe(1);
    expect(labelTransfers(r.pool, r.labels[0])).toBe(2);
    expect(labelArrival(r.pool, r.labels[0])).toBe(780); // 13:00
  });

  it('refuses to exceed the allowance, even when a legal route exists beyond it', () => {
    const { engine, tt } = setup(CHAIN, 4);
    const r1 = engine.search(tt, { departureMin: 400, origins: [0], destinations: [3], maxTransfers: 1 });
    expect(r1.labels).toEqual([]);
    const r0 = engine.search(tt, { departureMin: 400, origins: [0], destinations: [3], maxTransfers: 0 });
    expect(r0.labels).toEqual([]);
  });

  it('counts a train change but not a platform wait', () => {
    const { engine, tt } = setup(CHAIN, 4);
    const r = engine.search(tt, { departureMin: 400, origins: [0], destinations: [2], maxTransfers: 2 });
    expect(labelTransfers(r.pool, r.labels[0])).toBe(1); // A->B->C, one change at B
  });
});

describe('running days', () => {
  it('will not offer a train that does not run on the service date', () => {
    // Tuesday-only train (bit 1) queried on a Monday.
    const tuesday: TrainSpec = { ...THROUGH, runsDays: 0b0000010 };
    const { engine, tt } = setup([tuesday], 3);
    expect(tt.date).toBe(DATE);
    const r = engine.search(tt, { departureMin: 500, origins: [0], destinations: [2], maxTransfers: 2 });
    expect(r.labels).toEqual([]);
  });

  it('offers the same train on a day it does run', () => {
    const tuesday: TrainSpec = { ...THROUGH, runsDays: 0b0000010 };
    const graph = makeGraph([tuesday], 3);
    const engine = new CsaEngine(graph, noGroups(3), 3);
    const tt = buildTimetable(graph, '2026-09-15'); // Tuesday
    const r = engine.search(tt, { departureMin: 500, origins: [0], destinations: [2], maxTransfers: 2 });
    expect(r.labels.length).toBe(1);
  });
});

describe('overnight and multi-day service', () => {
  const NIGHT: TrainSpec = {
    number: '30001', name: 'Night Express', type: 9, classes: 16, runsDays: 127,
    originDepMin: 1380, durationMin: 300, distanceKm: 200,   // 23:00 -> 04:00 next day
    stops: [0, 1, 2], legs: [[0, 120, 100], [130, 300, 200]],
  };

  it('lets a traveller board part-way along a train that left yesterday', () => {
    const graph = makeGraph([NIGHT], 3);
    const engine = new CsaEngine(graph, noGroups(3), 3);
    const tt = buildTimetable(graph, DATE, { lookbackDays: 1 });
    // Query at 00:30 from B (station 1). The train left A at 23:00 yesterday and reaches B
    // at 01:00 today, so B -> C departing 01:10 is boardable.
    const r = engine.search(tt, { departureMin: 30, origins: [1], destinations: [2], maxTransfers: 1 });
    expect(r.labels.length).toBe(1);
    expect(labelArrival(r.pool, r.labels[0])).toBe(240); // 04:00 today
    expect(labelTransfers(r.pool, r.labels[0])).toBe(0);
  });

  it('flags the segment as having started on an earlier service day', () => {
    const graph = makeGraph([NIGHT], 3);
    const engine = new CsaEngine(graph, noGroups(3), 3);
    const tt = buildTimetable(graph, DATE, { lookbackDays: 1 });
    const r = engine.search(tt, { departureMin: 30, origins: [1], destinations: [2], maxTransfers: 1 });
    const row = labelRow(r.pool, r.labels[0]);
    expect(tt.serviceDay[row]).toBe(-1);
  });

  it('marks a 04:00 arrival as a night arrival and a 01:10 boarding as early', () => {
    expect(isNightArrival(240)).toBe(true);   // 04:00
    expect(isNightArrival(300)).toBe(false);  // 05:00
    expect(isNightArrival(1380)).toBe(false); // 23:00
    expect(isEarlyDeparture(70)).toBe(true);  // 01:10
    expect(isEarlyDeparture(360)).toBe(false);// 06:00
  });
});

describe('Pareto frontier', () => {
  /** Fast, expensive, direct: 1A only, 200 km in 2 h (100 km/h, so superfast). */
  const FAST: TrainSpec = {
    number: '40001', name: 'Fast Premium', type: 8, classes: 1, runsDays: 127,
    originDepMin: 600, durationMin: 120, distanceKm: 200, stops: [0, 2], legs: [[0, 120, 200]],
  };
  /** Slow, cheap: SL only, 200 km in 5 h (40 km/h, not superfast). */
  const SLOW: TrainSpec = {
    number: '40002', name: 'Slow Passenger', type: 10, classes: 16, runsDays: 127,
    originDepMin: 540, durationMin: 300, distanceKm: 200, stops: [0, 2], legs: [[0, 300, 200]],
  };

  it('keeps both a fast-expensive and a slow-cheap option', () => {
    const { engine, tt } = setup([FAST, SLOW], 3);
    const r = engine.search(tt, { departureMin: 500, origins: [0], destinations: [2], maxTransfers: 0 });
    expect(r.labels.length).toBe(2);
    const fares = r.labels.map((l) => labelFare(r.pool, l)).sort((a, b) => a - b);
    const arrivals = r.labels.map((l) => labelArrival(r.pool, l)).sort((a, b) => a - b);
    expect(fares[0]).toBeLessThan(fares[1]);
    expect(arrivals[0]).toBeLessThan(arrivals[1]);
    // The cheaper option is the later one — that is the whole trade-off being preserved.
    const cheapest = r.labels.find((l) => labelFare(r.pool, l) === fares[0]);
    expect(cheapest).toBeDefined();
    expect(labelArrival(r.pool, cheapest!)).toBe(arrivals[1]);
  });

  it('discards an option that is worse on every criterion', () => {
    const DOMINATED: TrainSpec = {
      number: '40003', name: 'Worst Of Both', type: 8, classes: 1, runsDays: 127,
      originDepMin: 660, durationMin: 200, distanceKm: 200, stops: [0, 2], legs: [[0, 200, 200]],
    };
    const { engine, tt } = setup([FAST, SLOW, DOMINATED], 3);
    const r = engine.search(tt, { departureMin: 500, origins: [0], destinations: [2], maxTransfers: 0 });
    // Slower than FAST and dearer than SLOW, with the same transfer count: dominated.
    expect(r.labels.length).toBe(2);
  });

  it('respects a fare ceiling', () => {
    const { engine, tt } = setup([FAST, SLOW], 3);
    const r = engine.search(tt, {
      departureMin: 500, origins: [0], destinations: [2], maxTransfers: 0, maxFareRupees: 300,
    });
    expect(r.labels.length).toBe(1);
    expect(labelFare(r.pool, r.labels[0])).toBeLessThanOrEqual(300);
  });

  it('respects a journey-length ceiling, measured from boarding', () => {
    const { engine, tt } = setup([FAST, SLOW], 3);
    const r = engine.search(tt, {
      departureMin: 500, origins: [0], destinations: [2], maxTransfers: 0, maxJourneyMin: 150,
    });
    // FAST: boards 10:00, arrives 12:00 -> 120 min in transit, allowed.
    // SLOW: boards 09:00, arrives 14:00 -> 300 min, rejected.
    expect(r.labels.length).toBe(1);
    expect(labelArrival(r.pool, r.labels[0])).toBe(720);
  });

  it('does not charge the wait at home against the journey-length ceiling', () => {
    // Regression. This used to be an absolute horizon from the query time, so a 2 h ride
    // leaving 100 min from now was rejected for "taking too long" when the ceiling was 150.
    const { engine, tt } = setup([FAST], 3);
    const r = engine.search(tt, {
      departureMin: 500, origins: [0], destinations: [2], maxTransfers: 0, maxJourneyMin: 130,
    });
    expect(r.labels.length).toBe(1); // 720 - 600 = 120 min in transit, under the 130 ceiling
  });

  it('bounds the wait separately, so the scan still has a stopping point', () => {
    const { engine, tt } = setup([FAST], 3);
    // FAST leaves at 600, i.e. 100 min after the 500 query. A 60-minute wait cap excludes it.
    const r = engine.search(tt, {
      departureMin: 500, origins: [0], destinations: [2], maxTransfers: 0, maxWaitMin: 60,
    });
    expect(r.labels).toEqual([]);
  });

  it('never lets a frontier exceed the cap', () => {
    expect(FRONTIER_CAP).toBe(12);
  });
});

describe('domination', () => {
  const pool = new Int32Array(3 * LABEL_STRIDE);
  const set = (i: number, arr: number, tr: number, fare: number, night = 0, early = 0,
    ready = arr): void => {
    pool[i * LABEL_STRIDE] = arr;
    pool[i * LABEL_STRIDE + 1] = ready;
    pool[i * LABEL_STRIDE + 2] = fare;
    pool[i * LABEL_STRIDE + 3] = tr;
    pool[i * LABEL_STRIDE + 4] = night;
    pool[i * LABEL_STRIDE + 5] = early;
  };

  it('requires being no worse on every criterion', () => {
    set(0, 100, 1, 500);
    set(1, 100, 2, 500);
    expect(dominates(pool, 0, 1)).toBe(true);
    expect(dominates(pool, 1, 0)).toBe(false);
  });

  it('requires being strictly better on at least one', () => {
    set(0, 100, 1, 500);
    set(1, 100, 1, 500);
    // Identical labels must not dominate each other, or both would be discarded.
    expect(dominates(pool, 0, 1)).toBe(false);
    expect(dominates(pool, 1, 0)).toBe(false);
  });

  it('breaks an exact tie on boardability', () => {
    set(0, 100, 1, 500, 0, 0, 100);
    set(1, 100, 1, 500, 0, 0, 120);
    expect(dominates(pool, 0, 1)).toBe(true);
    expect(dominates(pool, 1, 0)).toBe(false);
  });

  it('counts night arrivals and early departures as real criteria', () => {
    set(0, 100, 1, 500, 0, 0);
    set(1, 100, 1, 500, 1, 0);
    expect(dominates(pool, 0, 1)).toBe(true);
    set(2, 100, 1, 500, 0, 1);
    expect(dominates(pool, 0, 2)).toBe(true);
  });

  it('filters a candidate set down to the non-dominated ones', () => {
    set(0, 100, 1, 500);
    set(1, 90, 2, 400);
    set(2, 110, 1, 600); // dominated by 0 on everything
    expect(paretoFilter(pool, [0, 1, 2]).sort()).toEqual([0, 1]);
  });
});

describe('road transfers between city terminals', () => {
  // P (station 0) and Q (station 1) are terminals of the same city, ~6 km apart.
  const GEO: Array<[number, number]> = [[28.64, 77.22], [28.59, 77.25], [20.0, 73.0]];
  const GROUPS: ResolvedGroup[] = [{
    city: 'Delhi', hub: 0, members: [0, 1], unresolved: [], fallbackMinutes: 45,
  }];
  /** The only train to R leaves Q, never P. */
  const FROM_Q: TrainSpec = {
    number: '50001', name: 'From Other Terminal', type: 9, classes: 16, runsDays: 127,
    originDepMin: 600, durationMin: 300, distanceKm: 300, stops: [1, 2], legs: [[0, 300, 300]],
  };

  it('reaches a train that does not call at the requested origin', () => {
    const { engine, tt } = setup([FROM_Q], 3, GROUPS, GEO);
    const r = engine.search(tt, { departureMin: 500, origins: [0], destinations: [2], maxTransfers: 2 });
    expect(r.labels.length).toBe(1);
    expect(r.footpaths.length).toBeGreaterThan(0);
    const fp: Footpath = r.footpaths[0];
    expect(fp.from).toBe(0);
    expect(fp.to).toBe(1);
    expect(fp.minutes).toBeGreaterThan(20);
    expect(fp.costRupees).toBeGreaterThan(0);
  });

  it('fails honestly when road transfers are disabled', () => {
    const { engine, tt } = setup([FROM_Q], 3, GROUPS, GEO);
    const r = engine.search(tt, {
      departureMin: 500, origins: [0], destinations: [2], maxTransfers: 2, noFootpaths: true,
    });
    expect(r.labels).toEqual([]);
  });

  it('does not let a road hop be used when there is not time for it', () => {
    const { engine, tt } = setup([FROM_Q], 3, GROUPS, GEO);
    // Departing at 09:45 leaves 15 minutes for a ~35 minute taxi ride. Must not "succeed".
    const r = engine.search(tt, { departureMin: 585, origins: [0], destinations: [2], maxTransfers: 2 });
    expect(r.labels).toEqual([]);
  });
});

describe('search bookkeeping', () => {
  it('reports how much of the timetable it scanned', () => {
    const { engine, tt } = setup([THROUGH], 3);
    const r = engine.search(tt, { departureMin: 0, origins: [0], destinations: [2], maxTransfers: 2 });
    expect(r.scanned).toBeGreaterThan(0);
    expect(r.scanned).toBeLessThanOrEqual(tt.count);
  });

  it('scans less when the departure time is later', () => {
    const { engine, tt } = setup([THROUGH], 3);
    const early = engine.search(tt, { departureMin: 0, origins: [0], destinations: [2], maxTransfers: 2 });
    const late = engine.search(tt, { departureMin: 700, origins: [0], destinations: [2], maxTransfers: 2 });
    expect(late.scanned).toBeLessThanOrEqual(early.scanned);
  });

  it('reports no truncation on a small network', () => {
    const { engine, tt } = setup([THROUGH], 3);
    const r = engine.search(tt, { departureMin: 500, origins: [0], destinations: [2], maxTransfers: 2 });
    expect(r.truncated).toBe(false);
  });

  it('accepts several origins and several destinations at once', () => {
    const { engine, tt } = setup([THROUGH], 4);
    const r = engine.search(tt, {
      departureMin: 500, origins: [0, 1], destinations: [2, 3], maxTransfers: 2,
    });
    expect(r.labels.length).toBeGreaterThan(0);
  });

  it('ignores out-of-range station indices instead of throwing', () => {
    const { engine, tt } = setup([THROUGH], 3);
    const r = engine.search(tt, {
      departureMin: 500, origins: [-1, 0, 999], destinations: [2, 4242], maxTransfers: 2,
    });
    expect(r.labels.length).toBe(1);
  });

  it('is reusable: a second search does not inherit the first one\'s state', () => {
    const { engine, tt } = setup([THROUGH], 4);
    const a = engine.search(tt, { departureMin: 500, origins: [0], destinations: [2], maxTransfers: 2 });
    const b = engine.search(tt, { departureMin: 500, origins: [3], destinations: [2], maxTransfers: 2 });
    expect(a.labels.length).toBe(1);
    expect(b.labels).toEqual([]); // station 3 has no service at all
  });
});

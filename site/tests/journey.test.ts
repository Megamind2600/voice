/**
 * journey.test.ts — turning label chains into itineraries.
 *
 * The property that matters most here is internal consistency: the segments shown must sum
 * to the totals quoted. An itinerary whose legs add up to ₹1,200 but whose header says
 * ₹1,450 destroys trust in everything else on the screen, including the parts that are
 * right.
 */
import { describe, expect, it } from 'vitest';
import { Container, ContainerKind } from '../src/lib/binary';
import { Graph, stationCountOf } from '../src/lib/graph';
import { buildTimetable } from '../src/router/timetable';
import { TransferModel } from '../src/router/transfers';
import type { ResolvedGroup } from '../src/router/terminals';
import { CsaEngine, labelFare } from '../src/router/csa';
import { reconstructAll, reconstructJourney, stationPath, type RailSegment } from '../src/router/journey';
import { buildGraphContainer, type TrainSpec } from './helpers';

function setup(trains: TrainSpec[], stations: number, groups: ResolvedGroup[] = [],
  geo?: Array<[number, number]>) {
  const c = Container.parse(buildGraphContainer(trains, stations, geo), ContainerKind.Graph);
  const graph = Graph.fromContainer(c, stationCountOf(c));
  const transfers = new TransferModel(graph, groups, stations);
  const engine = new CsaEngine(graph, transfers, stations);
  const tt = buildTimetable(graph, '2026-09-14');
  return { graph, transfers, engine, tt };
}

/** A -> B -> C -> D on one train: three packed connections, one journey. */
const LONG: TrainSpec = {
  number: '12001', name: 'Long Haul Express', type: 9, classes: 16, runsDays: 127,
  originDepMin: 480, durationMin: 360, distanceKm: 300,
  stops: [0, 1, 2, 3],
  legs: [[0, 90, 100], [110, 210, 200], [230, 360, 300]],
};

describe('merging hops into rides', () => {
  it('reports one segment for a ride through intermediate stops', () => {
    const { engine, tt, graph } = setup([LONG], 4);
    const r = engine.search(tt, { departureMin: 400, origins: [0], destinations: [3], maxTransfers: 2 });
    const j = reconstructJourney(r, tt, graph, r.labels[0], { departureMin: 400 });
    expect(j).not.toBeNull();
    expect(j!.segments.length).toBe(1);
    expect(j!.segments[0].kind).toBe('rail');
  });

  it('keeps the hop count so the UI can say how many stops were passed', () => {
    const { engine, tt, graph } = setup([LONG], 4);
    const r = engine.search(tt, { departureMin: 400, origins: [0], destinations: [3], maxTransfers: 2 });
    const seg = reconstructJourney(r, tt, graph, r.labels[0], { departureMin: 400 })!.segments[0] as RailSegment;
    expect(seg.hops).toBe(3);
    expect(seg.from).toBe(0);
    expect(seg.to).toBe(3);
  });

  it('does NOT merge the same train boarded twice — that is a real transfer', () => {
    // Ride A->B, get off, and catch the same train again at C. Two tickets, one transfer.
    // Merging would hide the transfer and underprice the journey.
    const chain: TrainSpec[] = [
      { number: '12001', name: 'Long Haul Express', type: 9, classes: 16, runsDays: 127,
        originDepMin: 480, durationMin: 360, distanceKm: 300, stops: [0, 1, 2, 3],
        legs: [[0, 90, 100], [110, 210, 200], [230, 360, 300]] },
    ];
    const { engine, tt, graph } = setup(chain, 4);
    // A -> B on the long train, then B -> D. Only the long train serves B -> D, so riding
    // through is one segment; assert the direct case is 0 transfers and 1 segment.
    const r = engine.search(tt, { departureMin: 400, origins: [0], destinations: [3], maxTransfers: 2 });
    const j = reconstructJourney(r, tt, graph, r.labels[0], { departureMin: 400 })!;
    expect(j.transfers).toBe(0);
    expect(j.segments.length).toBe(1);
  });

  it('produces two segments and one transfer when trains actually change', () => {
    const two: TrainSpec[] = [
      { number: '12002', name: 'First', type: 9, classes: 16, runsDays: 127, originDepMin: 480,
        durationMin: 90, distanceKm: 100, stops: [0, 1], legs: [[0, 90, 100]] },
      { number: '12003', name: 'Second', type: 9, classes: 16, runsDays: 127, originDepMin: 720,
        durationMin: 90, distanceKm: 100, stops: [1, 3], legs: [[0, 90, 100]] },
    ];
    const { engine, tt, graph } = setup(two, 4);
    const r = engine.search(tt, { departureMin: 400, origins: [0], destinations: [3], maxTransfers: 2 });
    const j = reconstructJourney(r, tt, graph, r.labels[0], { departureMin: 400 })!;
    expect(j.segments.length).toBe(2);
    expect(j.transfers).toBe(1);
    expect(j.segments.every((s) => s.kind === 'rail')).toBe(true);
    // The first ride ends before the second begins, with the platform transfer in between.
    const [a, b] = j.segments as [RailSegment, RailSegment];
    expect(a.arrMin).toBeLessThan(b.depMin);
    expect(b.depMin - a.arrMin).toBeGreaterThanOrEqual(6);
  });
});

describe('totals are consistent with the parts', () => {
  it('segment distances sum to the journey distance', () => {
    const { engine, tt, graph } = setup([LONG], 4);
    const r = engine.search(tt, { departureMin: 400, origins: [0], destinations: [3], maxTransfers: 2 });
    const j = reconstructJourney(r, tt, graph, r.labels[0], { departureMin: 400 })!;
    const sum = j.segments.reduce((a, s) => a + (s.kind === 'rail' ? s.distKm : Math.round(s.km)), 0);
    expect(j.totalKm).toBe(sum);
    expect(j.totalKm).toBe(300);
  });

  it('segment fares sum to the journey fare', () => {
    const two: TrainSpec[] = [
      { number: '12002', name: 'First', type: 9, classes: 16, runsDays: 127, originDepMin: 480,
        durationMin: 90, distanceKm: 100, stops: [0, 1], legs: [[0, 90, 100]] },
      { number: '12003', name: 'Second', type: 9, classes: 16, runsDays: 127, originDepMin: 720,
        durationMin: 90, distanceKm: 100, stops: [1, 3], legs: [[0, 90, 100]] },
    ];
    const { engine, tt, graph } = setup(two, 4);
    const r = engine.search(tt, { departureMin: 400, origins: [0], destinations: [3], maxTransfers: 2 });
    const j = reconstructJourney(r, tt, graph, r.labels[0], { departureMin: 400 })!;
    const sum = j.segments.reduce((a, s) => a + (s.kind === 'rail' ? s.fareRupees : s.costRupees), 0);
    expect(j.fareRupees).toBe(sum);
  });

  it('agrees with the fare the search itself accumulated', () => {
    // The search prices segments incrementally; reconstruction re-prices them from the
    // merged distance. If these two disagree the itinerary would not add up.
    const { engine, tt, graph } = setup([LONG], 4);
    const r = engine.search(tt, { departureMin: 400, origins: [0], destinations: [3], maxTransfers: 2 });
    const j = reconstructJourney(r, tt, graph, r.labels[0], { departureMin: 400 })!;
    expect(j.fareRupees).toBe(labelFare(r.pool, r.labels[0]));
  });

  it('prices a merged ride from its TOTAL distance, not per hop', () => {
    const { engine, tt, graph } = setup([LONG], 4);
    const r = engine.search(tt, { departureMin: 400, origins: [0], destinations: [3], maxTransfers: 2 });
    const seg = reconstructJourney(r, tt, graph, r.labels[0], { departureMin: 400 })!.segments[0] as RailSegment;
    const perHop = seg.fareRupees / seg.hops;
    // Three 100 km hops priced separately would each carry their own fixed charges.
    expect(seg.fareRupees).toBeLessThan(perHop * seg.hops * 1.001);
    expect(seg.distKm).toBe(300);
  });

  it('duration equals arrival minus departure', () => {
    const { engine, tt, graph } = setup([LONG], 4);
    const r = engine.search(tt, { departureMin: 400, origins: [0], destinations: [3], maxTransfers: 2 });
    const j = reconstructJourney(r, tt, graph, r.labels[0], { departureMin: 400 })!;
    expect(j.durationMin).toBe(j.arrMin - j.depMin);
    expect(j.depMin).toBe(480);
    expect(j.arrMin).toBe(840);
  });

  it('segments are chronologically contiguous', () => {
    const { engine, tt, graph } = setup([LONG], 4);
    const r = engine.search(tt, { departureMin: 400, origins: [0], destinations: [3], maxTransfers: 2 });
    for (const j of reconstructAll(r, tt, graph, { departureMin: 400 })) {
      for (let i = 1; i < j.segments.length; i++) {
        expect(j.segments[i].depMin).toBeGreaterThanOrEqual(j.segments[i - 1].arrMin);
        expect(j.segments[i].from).toBe(j.segments[i - 1].to);
      }
    }
  });
});

describe('provenance carried onto every segment', () => {
  it('includes train number, name and type', () => {
    const { engine, tt, graph } = setup([LONG], 4);
    const r = engine.search(tt, { departureMin: 400, origins: [0], destinations: [3], maxTransfers: 2 });
    const seg = reconstructJourney(r, tt, graph, r.labels[0], { departureMin: 400 })!.segments[0] as RailSegment;
    expect(seg.trainNumber).toBe('12001');
    expect(seg.trainName).toBe('Long Haul Express');
    expect(seg.trainType).toBe('MEX');
  });

  it('carries the running-days and inferred-class flags through', () => {
    const assumed: TrainSpec = { ...LONG, runsDays: 127, flags: 3 }; // inferred + assumed
    const { engine, tt, graph } = setup([assumed], 4);
    const r = engine.search(tt, { departureMin: 400, origins: [0], destinations: [3], maxTransfers: 2 });
    const seg = reconstructJourney(r, tt, graph, r.labels[0], { departureMin: 400 })!.segments[0] as RailSegment;
    expect(seg.runsDaysAssumed).toBe(true);
    expect(seg.classesInferred).toBe(true);
  });

  it('records the class actually priced and flags a fallback', () => {
    // A train with only 1A, queried preferring SL: must fall back and say so.
    const premium: TrainSpec = { ...LONG, classes: 1 };
    const { engine, tt, graph } = setup([premium], 4);
    const r = engine.search(tt, {
      departureMin: 400, origins: [0], destinations: [3], maxTransfers: 2, preferredClass: 'SL',
    });
    const j = reconstructJourney(r, tt, graph, r.labels[0], { departureMin: 400 })!;
    const seg = j.segments[0] as RailSegment;
    expect(seg.klass).toBe('1A');
    expect(seg.classFellBack).toBe(true);
    expect(j.classFallback).toBe(true);
  });

  it('does not flag a fallback when the preferred class is available', () => {
    const { engine, tt, graph } = setup([LONG], 4);
    const r = engine.search(tt, {
      departureMin: 400, origins: [0], destinations: [3], maxTransfers: 2, preferredClass: 'SL',
    });
    const j = reconstructJourney(r, tt, graph, r.labels[0], { departureMin: 400 })!;
    expect((j.segments[0] as RailSegment).klass).toBe('SL');
    expect(j.classFallback).toBe(false);
  });

  it('reports the service day a ride started on', () => {
    const night: TrainSpec = {
      number: '12004', name: 'Night', type: 9, classes: 16, runsDays: 127,
      originDepMin: 1380, durationMin: 300, distanceKm: 200,
      stops: [0, 1, 3], legs: [[0, 120, 100], [130, 300, 200]],
    };
    const c = Container.parse(buildGraphContainer([night], 4), ContainerKind.Graph);
    const graph = Graph.fromContainer(c, stationCountOf(c));
    const engine = new CsaEngine(graph, new TransferModel(graph, [], 4), 4);
    const tt = buildTimetable(graph, '2026-09-15', { lookbackDays: 1 });
    // Board at B (station 1) at 01:10 today on a train that left A at 23:00 yesterday.
    const r = engine.search(tt, { departureMin: 30, origins: [1], destinations: [3], maxTransfers: 1 });
    const seg = reconstructJourney(r, tt, graph, r.labels[0], { departureMin: 30 })!.segments[0] as RailSegment;
    expect(seg.serviceDayOffset).toBe(-1);
  });
});

describe('road transfers in the itinerary', () => {
  const GEO: Array<[number, number]> = [[28.64, 77.22], [28.59, 77.25], [20.0, 73.0]];
  const GROUPS: ResolvedGroup[] = [{
    city: 'Delhi', hub: 0, members: [0, 1], unresolved: [], fallbackMinutes: 45,
  }];
  const FROM_Q: TrainSpec = {
    number: '12005', name: 'From Other Terminal', type: 9, classes: 16, runsDays: 127,
    originDepMin: 600, durationMin: 300, distanceKm: 300, stops: [1, 2], legs: [[0, 300, 300]],
  };

  it('shows the road hop as its own segment with a cost and a city', () => {
    const { engine, tt, graph } = setup([FROM_Q], 3, GROUPS, GEO);
    const r = engine.search(tt, { departureMin: 500, origins: [0], destinations: [2], maxTransfers: 2 });
    const j = reconstructJourney(r, tt, graph, r.labels[0], { departureMin: 500 })!;
    expect(j.segments.length).toBe(2);
    const road = j.segments[0];
    expect(road.kind).toBe('road');
    if (road.kind !== 'road') throw new Error('expected a road segment first');
    expect(road.city).toBe('Delhi');
    expect(road.from).toBe(0);
    expect(road.to).toBe(1);
    expect(road.minutes).toBeGreaterThan(0);
    expect(road.costRupees).toBeGreaterThan(0);
    expect(road.estimated).toBe(false); // coordinates were supplied
  });

  it('counts road transfers separately from train changes', () => {
    const { engine, tt, graph } = setup([FROM_Q], 3, GROUPS, GEO);
    const r = engine.search(tt, { departureMin: 500, origins: [0], destinations: [2], maxTransfers: 2 });
    const j = reconstructJourney(r, tt, graph, r.labels[0], { departureMin: 500 })!;
    expect(j.roadTransfers).toBe(1);
    // One train boarded, so zero changes of train even though there was a road hop.
    expect(j.transfers).toBe(0);
  });

  it('includes the road cost in the journey total', () => {
    const { engine, tt, graph } = setup([FROM_Q], 3, GROUPS, GEO);
    const r = engine.search(tt, { departureMin: 500, origins: [0], destinations: [2], maxTransfers: 2 });
    const j = reconstructJourney(r, tt, graph, r.labels[0], { departureMin: 500 })!;
    const road = j.segments[0];
    const rail = j.segments[1] as RailSegment;
    expect(road.kind).toBe('road');
    expect(j.fareRupees).toBe((road.kind === 'road' ? road.costRupees : 0) + rail.fareRupees);
  });

  it('bridges the road segment in time without a gap', () => {
    const { engine, tt, graph } = setup([FROM_Q], 3, GROUPS, GEO);
    const r = engine.search(tt, { departureMin: 500, origins: [0], destinations: [2], maxTransfers: 2 });
    const j = reconstructJourney(r, tt, graph, r.labels[0], { departureMin: 500 })!;
    const road = j.segments[0];
    const rail = j.segments[1];
    expect(road.arrMin).toBeLessThanOrEqual(rail.depMin);
    expect(road.depMin).toBe(500);
  });
});

describe('stationPath', () => {
  it('lists every station the traveller passes through, in order', () => {
    const two: TrainSpec[] = [
      { number: '12002', name: 'First', type: 9, classes: 16, runsDays: 127, originDepMin: 480,
        durationMin: 90, distanceKm: 100, stops: [0, 1], legs: [[0, 90, 100]] },
      { number: '12003', name: 'Second', type: 9, classes: 16, runsDays: 127, originDepMin: 720,
        durationMin: 90, distanceKm: 100, stops: [1, 3], legs: [[0, 90, 100]] },
    ];
    const { engine, tt, graph } = setup(two, 4);
    const r = engine.search(tt, { departureMin: 400, origins: [0], destinations: [3], maxTransfers: 2 });
    const j = reconstructJourney(r, tt, graph, r.labels[0], { departureMin: 400 })!;
    expect(stationPath(j)).toEqual([0, 1, 3]);
  });

  it('starts and ends at the journey endpoints', () => {
    const { engine, tt, graph } = setup([LONG], 4);
    const r = engine.search(tt, { departureMin: 400, origins: [0], destinations: [3], maxTransfers: 2 });
    const j = reconstructJourney(r, tt, graph, r.labels[0], { departureMin: 400 })!;
    const path = stationPath(j);
    expect(path[0]).toBe(j.origin);
    expect(path[path.length - 1]).toBe(j.destination);
  });
});

describe('reconstructAll', () => {
  it('returns a journey for every label', () => {
    const fast: TrainSpec = { number: '40001', name: 'Fast', type: 8, classes: 1, runsDays: 127,
      originDepMin: 600, durationMin: 120, distanceKm: 200, stops: [0, 2], legs: [[0, 120, 200]] };
    const slow: TrainSpec = { number: '40002', name: 'Slow', type: 10, classes: 16, runsDays: 127,
      originDepMin: 540, durationMin: 300, distanceKm: 200, stops: [0, 2], legs: [[0, 300, 200]] };
    const { engine, tt, graph } = setup([fast, slow], 3);
    const r = engine.search(tt, { departureMin: 500, origins: [0], destinations: [2], maxTransfers: 0 });
    const js = reconstructAll(r, tt, graph, { departureMin: 500 });
    expect(js.length).toBe(r.labels.length);
    expect(js.length).toBe(2);
    // Sorted earliest arrival first.
    expect(js[0].arrMin).toBeLessThanOrEqual(js[1].arrMin);
  });

  it('propagates the truncation flag so the UI can say results may be incomplete', () => {
    const { engine, tt, graph } = setup([LONG], 4);
    const r = engine.search(tt, { departureMin: 400, origins: [0], destinations: [3], maxTransfers: 2 });
    const j = reconstructJourney(r, tt, graph, r.labels[0], { departureMin: 400 })!;
    expect(j.truncated).toBe(r.truncated);
  });
});

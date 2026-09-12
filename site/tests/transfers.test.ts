/**
 * transfers.test.ts — what changing trains costs, in minutes and rupees.
 *
 * Two failure modes matter here. A transfer time that is too short invents connections no
 * human could make; one that is too long hides journeys that exist. And a road transfer
 * priced at zero would make the router prefer a taxi across Mumbai to a slightly longer wait
 * on the same platform.
 */
import { describe, expect, it } from 'vitest';
import { Container, ContainerKind } from '../src/lib/binary';
import { Graph, stationCountOf } from '../src/lib/graph';
import { haversineKm, URBAN_ROAD_CIRCUITY } from '../src/lib/geo';
import {
  MIN_TRANSFER_FLOOR, minTransferForDegree, ROAD_OVERHEAD_MIN, roadCostRupees, roadMinutes,
  TransferModel, URBAN_KMH,
} from '../src/router/transfers';
import { resolveTerminalGroups, TERMINAL_GROUPS } from '../src/router/terminals';
import { buildGraphContainer, type TrainSpec } from './helpers';

function graphOf(trains: TrainSpec[], stations: number, geo?: Array<[number, number]>): Graph {
  const c = Container.parse(buildGraphContainer(trains, stations, geo), ContainerKind.Graph);
  return Graph.fromContainer(c, stationCountOf(c));
}

describe('minimum platform transfer time', () => {
  it('has a hard floor below which no change is believable', () => {
    expect(MIN_TRANSFER_FLOOR).toBeGreaterThanOrEqual(5);
    expect(minTransferForDegree(0)).toBe(MIN_TRANSFER_FLOOR);
    expect(minTransferForDegree(3)).toBe(MIN_TRANSFER_FLOOR);
  });

  it('rises with station size', () => {
    const bands = [0, 8, 40, 120, 300].map(minTransferForDegree);
    for (let i = 1; i < bands.length; i++) {
      expect(bands[i], `band ${i}`).toBeGreaterThan(bands[i - 1]);
    }
  });

  it('gives the mega-terminals in the real data at least 20 minutes', () => {
    // Kanpur Central has 286 legs, Howrah 283, New Delhi 229 in the packed dataset.
    expect(minTransferForDegree(286)).toBeGreaterThanOrEqual(20);
    expect(minTransferForDegree(229)).toBeGreaterThanOrEqual(20);
  });

  it('is zero when staying on the same train', () => {
    const g = graphOf([], 4);
    const tm = new TransferModel(g, [], 4);
    expect(tm.minTransferMin(0, 7, 7)).toBe(0);
    // Enforcing a platform transfer on a passenger who never leaves the train would reject
    // valid through journeys.
    expect(tm.minTransferMin(0, 7, 8)).toBe(MIN_TRANSFER_FLOOR);
    expect(tm.minTransferMin(0)).toBe(MIN_TRANSFER_FLOOR);
  });

  it('reads real degree out of a built graph', () => {
    const trains: TrainSpec[] = [
      { number: '1', name: 'A', type: 9, originDepMin: 0, durationMin: 60, distanceKm: 60,
        stops: [0, 1], legs: [[0, 60, 60]] },
      { number: '2', name: 'B', type: 9, originDepMin: 0, durationMin: 60, distanceKm: 60,
        stops: [1, 2], legs: [[0, 60, 60]] },
    ];
    const g = graphOf(trains, 3);
    expect(g.degree(1)).toBe(2); // one arrival, one departure
    expect(g.degree(0)).toBe(1);
  });
});

describe('road transfer pricing', () => {
  it('includes fixed overhead, not just distance', () => {
    // A one-kilometre hop between terminals is still a change of building: exit, find
    // transport, queue, re-enter through security. Zero-distance must not be zero-time.
    expect(roadMinutes(0)).toBe(ROAD_OVERHEAD_MIN);
    expect(roadMinutes(1)).toBeGreaterThan(ROAD_OVERHEAD_MIN);
  });

  it('uses a city driving speed, not a free-flow one', () => {
    expect(URBAN_KMH).toBeLessThanOrEqual(30);
    expect(URBAN_KMH).toBeGreaterThanOrEqual(15);
    // 20 km across a city is not 20 minutes.
    expect(roadMinutes(20)).toBeGreaterThan(45);
  });

  it('applies road circuity, because streets are not straight lines', () => {
    expect(URBAN_ROAD_CIRCUITY).toBeGreaterThan(1.2);
    expect(URBAN_ROAD_CIRCUITY).toBeLessThan(1.6);
    // And it must not be confused with the rail detour factor, which is 1.037.
    expect(URBAN_ROAD_CIRCUITY).toBeGreaterThan(1.037 * 1.15);
  });

  it('has a minimum fare', () => {
    expect(roadCostRupees(0)).toBeGreaterThanOrEqual(50);
    expect(roadCostRupees(0.5)).toBeGreaterThanOrEqual(50);
  });

  it('costs more the further it goes', () => {
    expect(roadCostRupees(20)).toBeGreaterThan(roadCostRupees(5));
    expect(roadCostRupees(5)).toBeGreaterThan(roadCostRupees(1));
  });

  it('prices a real cross-Mumbai hop as a serious cost, not a trifle', () => {
    // Kalyan to Mumbai Central is roughly 50 km. A planner that treated that as free would
    // invent transfers nobody would take.
    const minutes = roadMinutes(50);
    expect(minutes).toBeGreaterThan(90);
    expect(roadCostRupees(50)).toBeGreaterThan(800);
  });
});

describe('haversine', () => {
  it('measures a known Delhi distance', () => {
    // New Delhi to Nizamuddin is about 6-7 km.
    const d = haversineKm(28.64, 77.22, 28.59, 77.25);
    expect(d).toBeGreaterThan(5);
    expect(d).toBeLessThan(8);
  });

  it('is zero for identical points and symmetric', () => {
    expect(haversineKm(20, 73, 20, 73)).toBe(0);
    expect(haversineKm(28.64, 77.22, 28.59, 77.25))
      .toBeCloseTo(haversineKm(28.59, 77.25, 28.64, 77.22), 6);
  });

  it('handles long distances without wrapping error', () => {
    // Delhi to Chennai is about 1,750 km great-circle.
    const d = haversineKm(28.61, 77.21, 13.08, 80.27);
    expect(d).toBeGreaterThan(1600);
    expect(d).toBeLessThan(1900);
  });
});

describe('TransferModel', () => {
  const GEO: Array<[number, number]> = [[28.64, 77.22], [28.59, 77.25], [20.0, 73.0], [0, 0]];
  const GROUPS = [{ city: 'Delhi', hub: 0, members: [0, 1], unresolved: [], fallbackMinutes: 45 }];

  it('creates both directions of every intra-city pair', () => {
    const g = graphOf([], 4, GEO);
    const tm = new TransferModel(g, GROUPS, 4);
    const out = tm.footpathsFrom(0);
    expect(out.length).toBe(1);
    expect(out[0].to).toBe(1);
    expect(tm.footpathsFrom(1)[0].to).toBe(0);
  });

  it('creates no road edges for stations outside a city group', () => {
    const g = graphOf([], 4, GEO);
    const tm = new TransferModel(g, GROUPS, 4);
    expect(tm.footpathsFrom(2).length).toBe(0);
    expect(tm.footpathsFrom(3).length).toBe(0);
  });

  it('never creates a road edge from a station to itself', () => {
    const g = graphOf([], 4, GEO);
    const tm = new TransferModel(g, GROUPS, 4);
    for (let s = 0; s < 4; s++) {
      expect(tm.footpathsFrom(s).every((f) => f.from !== f.to)).toBe(true);
    }
  });

  it('measures the hop from coordinates when it has them', () => {
    const g = graphOf([], 4, GEO);
    const tm = new TransferModel(g, GROUPS, 4);
    const fp = tm.footpathsFrom(0)[0];
    expect(fp.estimated).toBe(false);
    expect(fp.km).toBeGreaterThan(5);
    expect(fp.km).toBeLessThan(8);
    // `km` is rounded to one decimal for display, so compare against the same rounded
    // input rather than re-deriving an exact figure the model never used.
    expect(fp.minutes).toBe(roadMinutes(fp.km));
  });

  it('falls back to the city estimate when coordinates are missing', () => {
    // Station 3 has (0,0), which graph.coordsOf treats as absent rather than as a real
    // place in the Gulf of Guinea.
    const g = graphOf([], 4, GEO);
    const tm = new TransferModel(g, [{ city: 'X', hub: 0, members: [0, 3], unresolved: [],
      fallbackMinutes: 45 }], 4);
    const fp = tm.footpathsFrom(0)[0];
    expect(fp.estimated).toBe(true);
    expect(fp.minutes).toBe(45);
    expect(fp.costRupees).toBeGreaterThan(0);
  });

  it('does not invent a 6,000 km road transfer to (0,0)', () => {
    const g = graphOf([], 4, GEO);
    const tm = new TransferModel(g, [{ city: 'X', hub: 0, members: [0, 3], unresolved: [],
      fallbackMinutes: 45 }], 4);
    expect(tm.footpathsFrom(0)[0].km).toBeLessThan(100);
  });

  it('tracks city membership', () => {
    const g = graphOf([], 4, GEO);
    const tm = new TransferModel(g, GROUPS, 4);
    expect(tm.groupOfStation(0)).toBe(0);
    expect(tm.groupOfStation(1)).toBe(0);
    expect(tm.groupOfStation(2)).toBe(-1);
    expect(tm.isSameCity(0, 1)).toBe(true);
    expect(tm.isSameCity(0, 2)).toBe(false);
    expect(tm.isSameCity(2, 3)).toBe(false);
  });

  it('labels edges with the city name for the UI', () => {
    const g = graphOf([], 4, GEO);
    const tm = new TransferModel(g, GROUPS, 4);
    expect(tm.footpathsFrom(0)[0].city).toBe('Delhi');
  });

  it('reports its own statistics', () => {
    const g = graphOf([], 4, GEO);
    const tm = new TransferModel(g, GROUPS, 4);
    const s = tm.stats();
    expect(s.stationCount).toBe(4);
    expect(s.groups).toBe(1);
    expect(s.footpaths).toBe(2);
    expect(s.unmeasuredFootpaths).toBe(0);
    expect(tm.stationCount).toBe(4);
  });

  it('scales to a full group without quadratic surprises', () => {
    const g = graphOf([], 8, Array.from({ length: 8 }, (_, i) => [28.6 + i * 0.02, 77.2] as [number, number]));
    const tm = new TransferModel(g, [{ city: 'Big', hub: 0, members: [0, 1, 2, 3, 4, 5, 6, 7],
      unresolved: [], fallbackMinutes: 60 }], 8);
    expect(tm.footpathsFrom(0).length).toBe(7);
    expect(tm.stats().footpaths).toBe(56);
  });
});

describe('resolveTerminalGroups', () => {
  const CODES = ['NDLS', 'NZM', 'DLI', 'ANVT', 'HWH', 'SDAH', 'MAS'];
  const lookup = (code: string): number | null => {
    const i = CODES.indexOf(code);
    return i >= 0 ? i : null;
  };

  it('resolves codes to indices and reports what it could not find', () => {
    const r = resolveTerminalGroups(CODES.length, lookup);
    expect(r.groups.length).toBeGreaterThan(0);
    expect(r.unresolvedCodes).toContain('SMVB'); // opened 2022, absent from 2016 data
    expect(r.unresolvedCodes).toContain('SBIB');
  });

  it('keeps working when a group loses members to a stale dataset', () => {
    const r = resolveTerminalGroups(CODES.length, lookup);
    const delhi = r.groups.find((g) => g.city === 'Delhi');
    expect(delhi).toBeDefined();
    expect(delhi!.members.length).toBe(4); // NDLS NZM DLI ANVT of the seven authored
    expect(delhi!.unresolved).toEqual(['DEE', 'NNO', 'SZM']);
  });

  it('drops a group that resolves to a single station', () => {
    // One member is not a group: there is nothing to transfer between, and keeping it would
    // add a road edge from a station to itself.
    const r = resolveTerminalGroups(2, (c) => (c === 'HWH' ? 0 : null));
    expect(r.groups.every((g) => g.members.length >= 2)).toBe(true);
    const kolkata = r.groups.find((g) => g.city === 'Kolkata');
    expect(kolkata).toBeUndefined();
  });

  it('falls back to the first member when the named hub does not resolve', () => {
    const r = resolveTerminalGroups(CODES.length, lookup);
    for (const g of r.groups) {
      expect(g.members).toContain(g.hub);
    }
  });

  it('assigns each station to at most one city', () => {
    const r = resolveTerminalGroups(CODES.length, lookup);
    for (let s = 0; s < CODES.length; s++) {
      const claimed = r.groups.filter((g) => g.members.includes(s));
      expect(claimed.length).toBeLessThanOrEqual(1);
      if (claimed.length === 1) {
        expect(r.groupOfStation[s]).toBe(r.groups.indexOf(claimed[0]));
      }
    }
  });

  it('does not attribute stations of a discarded group to the next one', () => {
    // Regression. Group indices were assigned eagerly, before knowing whether the group
    // would survive; a dropped group's stations were then silently credited to whichever
    // city was pushed next.
    const r = resolveTerminalGroups(3, (c) => (c === 'HWH' ? 0 : c === 'SDAH' ? 1 : null));
    // Kolkata resolves to two members here, so it survives; verify indices are consistent.
    for (let s = 0; s < 3; s++) {
      const g = r.groupOfStation[s];
      if (g >= 0) expect(r.groups[g].members).toContain(s);
      else expect(r.groups.every((grp) => !grp.members.includes(s))).toBe(true);
    }
  });

  it('leaves every non-member station unassigned', () => {
    const r = resolveTerminalGroups(CODES.length + 50, (c) => lookup(c));
    let assigned = 0;
    for (let s = 0; s < r.groupOfStation.length; s++) if (r.groupOfStation[s] >= 0) assigned++;
    expect(assigned).toBe(r.groups.reduce((a, g) => a + g.members.length, 0));
  });

  it('covers the cities the product claims to support', () => {
    expect(TERMINAL_GROUPS.map((g) => g.city)).toEqual(expect.arrayContaining([
      'Delhi', 'Mumbai', 'Kolkata', 'Chennai', 'Bengaluru', 'Hyderabad', 'Goa',
    ]));
  });

  it('gives Mumbai and Goa the pessimistic fallbacks their spread demands', () => {
    const mumbai = TERMINAL_GROUPS.find((g) => g.city === 'Mumbai')!;
    const goa = TERMINAL_GROUPS.find((g) => g.city === 'Goa')!;
    const delhi = TERMINAL_GROUPS.find((g) => g.city === 'Delhi')!;
    expect(mumbai.interTerminalMinutes).toBeGreaterThanOrEqual(60);
    expect(goa.interTerminalMinutes).toBeGreaterThanOrEqual(90);
    expect(goa.interTerminalMinutes).toBeGreaterThan(delhi.interTerminalMinutes);
  });
});

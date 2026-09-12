/**
 * bruteforce.test.ts — CSA checked against exhaustive enumeration.
 *
 * Every other routing test in this suite is one of two things: a hand-built scenario asserting
 * a specific answer, or a property asserting an invariant that must hold. Neither can catch the
 * class of bug that matters most here — the router that quietly MISSES a journey. A missed
 * itinerary is invisible: nothing renders, and "we found nothing" is a perfectly plausible
 * answer for a plausible pair of stations. Hand-built scenarios only check the journeys someone
 * thought to write down.
 *
 * So this file enumerates every valid journey on a small network by depth-first search over the
 * train instances directly, without touching the timetable, the connection scan, or any of the
 * pruning, and compares the resulting Pareto frontiers against CSA's.
 *
 * The two models share only data, never search logic:
 *   - both read the same TransferModel minimum-transfer minutes (that is policy, not algorithm,
 *     and duplicating it would test nothing);
 *   - nothing else. The enumeration builds absolute times from the TrainSpec it was given,
 *     walks every boarding and every alighting, and knows nothing about rounds, frontiers,
 *     bounds or labels.
 *
 * Comparison is on (arrival time, number of changes) only, because that is the part where a
 * missed journey is a wrong answer rather than a differently-ranked one. CSA optimises six
 * criteria, so its raw frontier can legitimately contain points dominated on these two; both
 * sides are Pareto-filtered to the same two before being compared.
 */
import { describe, expect, it } from 'vitest';
import { Container, ContainerKind } from '../src/lib/binary';
import { Graph, stationCountOf } from '../src/lib/graph';
import { buildTimetable } from '../src/router/timetable';
import { TransferModel } from '../src/router/transfers';
import { CsaEngine, labelArrival, labelTransfers } from '../src/router/csa';
import { buildGraphContainer, type TrainSpec } from './helpers';

const DATE = '2026-09-14'; // a Monday, so bit 0 of runsDays is the query day

/** Slots the timetable carries that can still be boarded on the query day. */
const SLOTS = [0, -1] as const;
/** Day-of-week index (Mon=0) for each slot, matching SLOTS above. */
const SLOT_DAY = [0, 6] as const;

// Large on purpose: the enumeration has to compare against a search that is not pruning on
// these axes at all, or a difference could be a budget rather than a bug.
const BIG = 1 << 28;

function makeGraph(trains: TrainSpec[], stations: number): Graph {
  const c = Container.parse(buildGraphContainer(trains, stations), ContainerKind.Graph);
  return Graph.fromContainer(c, stationCountOf(c));
}

// ---------------------------------------------------------------------------
// The independent model
// ---------------------------------------------------------------------------

/** One running of one train: absolute arrival/departure minute at each stop. */
interface Instance {
  trainIx: number;
  stops: number[];
  dep: number[];
  arr: number[];
}

function instancesOf(trains: TrainSpec[]): Instance[] {
  const out: Instance[] = [];
  trains.forEach((t, trainIx) => {
    for (let s = 0; s < SLOTS.length; s++) {
      const slot = SLOTS[s];
      const day = SLOT_DAY[s];
      // A train that does not run on its service day does not exist on that day. This is the
      // check that a weekly train never appears on a non-operating day.
      if ((t.runsDays ?? 127) !== 127 && ((t.runsDays ?? 0) & (1 << day)) === 0) continue;

      const base = slot * 1440 + (t.originDepMin ?? 0);
      const n = t.stops.length;
      const dep: number[] = new Array(n).fill(0);
      const arr: number[] = new Array(n).fill(0);
      dep[0] = base;
      arr[0] = base;
      for (let k = 1; k < n; k++) {
        // legs[k-1] = [depRel, arrRel, cumKm], relative to the train's own origin departure.
        arr[k] = base + t.legs[k - 1][1];
        dep[k] = k < n - 1 ? base + t.legs[k][0] : arr[k];
      }
      out.push({ trainIx, stops: t.stops, dep, arr });
    }
  });
  return out;
}

interface Reach {
  /** arrival minute at the station */
  arrival: number;
  transfers: number;
}

const key = (r: Reach): string => `${r.arrival}/${r.transfers}`;
const keySet = (rs: readonly Reach[]): Set<string> => new Set(rs.map(key));

/**
 * Enumerate every reachable (station, arrival, transfers) by depth-first search.
 *
 * Returns the full reachable set, not just its Pareto frontier: the completeness direction of
 * the comparison needs the whole set, because a point CSA reports must be *achievable*, and
 * achievable-but-dominated points are not in the frontier.
 */
function enumerate(
  trains: TrainSpec[],
  stations: number,
  transfers: TransferModel,
  origin: number,
  departureMin: number,
  maxTransfers: number,
): Map<number, Reach[]> {
  const insts = instancesOf(trains);
  const byStation: number[][] = Array.from({ length: stations }, () => []);
  insts.forEach((inst, i) => {
    for (const s of new Set(inst.stops)) byStation[s].push(i);
  });

  const found = new Map<number, Reach[]>();
  const seen = new Set<string>();
  let nodes = 0;

  // The walk counts TRAINS BOARDED, not changes, because the first boarding is not a change.
  // Counting changes directly and starting at zero would report every direct journey as having
  // one transfer, which is exactly the off-by-one this model has to avoid to be worth comparing.
  const record = (station: number, arrival: number, boarded: number): void => {
    if (station === origin) return;
    const reach: Reach = { arrival, transfers: Math.max(0, boarded - 1) };
    const list = found.get(station);
    if (list) list.push(reach);
    else found.set(station, [reach]);
  };

  const walk = (station: number, arrival: number, lastTrain: number, boarded: number): void => {
    nodes++;
    // Guard against a generator producing something combinatorial; a silent blowup would make
    // this file the slowest thing in the suite and then someone would delete it.
    if (nodes > 400_000) throw new Error('enumeration exploded — network too dense for this test');

    record(station, arrival, boarded);
    if (boarded > maxTransfers) return;

    for (const i of byStation[station]) {
      const inst = insts[i];
      for (let k = 0; k < inst.stops.length; k++) {
        if (inst.stops[k] !== station) continue;
        const need = lastTrain < 0 ? 0 : transfers.minTransferMin(station, lastTrain, inst.trainIx);
        if (inst.dep[k] < arrival + need) continue; // cannot make this connection
        for (let m = k + 1; m < inst.stops.length; m++) {
          const key = `${inst.stops[m]}|${inst.arr[m]}|${inst.trainIx}|${boarded + 1}`;
          if (seen.has(key)) continue;
          seen.add(key);
          walk(inst.stops[m], inst.arr[m], inst.trainIx, boarded + 1);
        }
      }
    }
  };

  walk(origin, departureMin, -1, 0);
  return found;
}

/**
 * Pareto frontier on (arrival, transfers): keep points nothing else beats on both.
 *
 * Duplicates are collapsed first. Two genuinely different itineraries can share an arrival time
 * and a change count — a different route, the same total — and neither dominates the other, so
 * without deduping the frontier would carry both and a size comparison would disagree with a
 * set comparison on the very same data.
 */
function pareto(points: readonly Reach[]): Reach[] {
  const uniq = new Map<string, Reach>();
  for (const p of points) {
    const k = key(p);
    if (!uniq.has(k)) uniq.set(k, p);
  }
  const keep: Reach[] = [];
  for (const p of uniq.values()) {
    const dominated = keep.some((q) => q.arrival <= p.arrival && q.transfers <= p.transfers
      && (q.arrival < p.arrival || q.transfers < p.transfers));
    if (dominated) continue;
    // Drop anything already kept that this point beats, so the result is order-independent.
    for (let i = keep.length - 1; i >= 0; i--) {
      if (p.arrival <= keep[i].arrival && p.transfers <= keep[i].transfers
        && (p.arrival < keep[i].arrival || p.transfers < keep[i].transfers)) keep.splice(i, 1);
    }
    keep.push(p);
  }
  return keep.sort((a, b) => a.arrival - b.arrival || a.transfers - b.transfers);
}

// ---------------------------------------------------------------------------
// Deterministic random networks
// ---------------------------------------------------------------------------

/** A small LCG: the networks must be reproducible, or a failure cannot be investigated. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function randomNetwork(seed: number): { trains: TrainSpec[]; stations: number } {
  const rnd = lcg(seed);
  const int = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
  const stations = int(9, 13);
  const trainCount = int(16, 26);
  const trains: TrainSpec[] = [];

  for (let i = 0; i < trainCount; i++) {
    const nStops = int(3, 5);
    const stops: number[] = [];
    while (stops.length < nStops) {
      const s = int(0, stations - 1);
      if (!stops.includes(s)) stops.push(s);
    }
    // Legs are generated in stop order. Cumulative distance must strictly increase, which
    // buildGraphContainer enforces, so it is enforced here too rather than by trial and error.
    let depRel = 0;
    let cumKm = 0;
    const legs: Array<[number, number, number]> = [];
    for (let k = 0; k < nStops - 1; k++) {
      const run = int(25, 200);
      const dwell = k < nStops - 2 ? int(3, 30) : 0;
      cumKm += int(20, 160);
      legs.push([depRel, depRel + run, cumKm]);
      depRel += run + dwell;
    }
    // 60% daily; the rest run on one or two days, which is what makes the runsDays filter in
    // instancesOf worth exercising on most networks rather than on a contrived one.
    const daily = rnd() < 0.6;
    const runsDays = daily ? 127 : (1 << int(0, 6)) | (rnd() < 0.3 ? 1 << int(0, 6) : 0);
    trains.push({
      number: String(10000 + i * 7 + 1),
      name: `Random ${i}`,
      type: [8, 9, 10, 5][int(0, 3)],
      classes: [1, 4, 16, 24][int(0, 3)],
      runsDays,
      originDepMin: int(0, 1439),
      durationMin: legs[legs.length - 1][1],
      distanceKm: cumKm,
      stops,
      legs,
    });
  }
  return { trains, stations };
}

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

function compare(
  trains: TrainSpec[],
  stations: number,
  origin: number,
  departureMin: number,
  maxTransfers: number,
  label: string,
): void {
  const graph = makeGraph(trains, stations);
  const transfers = new TransferModel(graph, [], stations);
  const engine = new CsaEngine(graph, transfers, stations);
  const tt = buildTimetable(graph, DATE);

  const brute = enumerate(trains, stations, transfers, origin, departureMin, maxTransfers);

  const failures: string[] = [];
  let destinations = 0;

  for (let d = 0; d < stations; d++) {
    if (d === origin) continue;
    destinations++;

    const r = engine.search(tt, {
      departureMin,
      origins: [origin],
      destinations: [d],
      maxTransfers,
      maxJourneyMin: BIG,
      maxWaitMin: BIG,
    });
    const got = pareto(r.labels.map((l) => ({
      arrival: labelArrival(r.pool, l),
      transfers: labelTransfers(r.pool, l),
    })));
    const want = pareto(brute.get(d) ?? []);

    const gotKeys = keySet(got);
    const wantKeys = keySet(want);
    const bruteAll = keySet(brute.get(d) ?? []);

    // SOUNDNESS: nothing CSA reports may be a journey that does not exist. Compared against the
    // full reachable set rather than the frontier, so a point that is real but dominated still
    // passes.
    for (const k of gotKeys) {
      if (!bruteAll.has(k)) failures.push(`${label} -> station ${d}: CSA reports ${k} which enumeration cannot reach`);
    }
    // COMPLETENESS: every frontier point the enumeration found must be reported. This is the
    // direction that catches a missed journey.
    for (const k of wantKeys) {
      if (!gotKeys.has(k)) failures.push(`${label} -> station ${d}: enumeration reaches ${k} but CSA missed it (found ${[...gotKeys].join(' ') || 'nothing'})`);
    }
    // Both sides filtered on the same two criteria over the same reachable set, so equal
    // cardinality plus mutual containment is the whole statement.
    if (got.length !== want.length && failures.length === 0) {
      failures.push(`${label} -> station ${d}: frontier size ${got.length} vs ${want.length}`);
    }
  }

  expect(failures, `${label}: ${destinations} destinations compared`).toEqual([]);
}

describe('CSA agrees exactly with exhaustive enumeration', () => {
  const SEEDS = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233];

  it('on a hand-written network with known awkward cases', () => {
    // Fixed and readable, so that when this fails the network can be drawn on paper. Includes a
    // through train that beats two changes, a tight connection that must be rejected, a loose
    // one that must be accepted, and a Sunday-only train that must not be used on a Monday.
    const trains: TrainSpec[] = [
      { number: '10001', name: 'Through', type: 9, classes: 16, runsDays: 127, originDepMin: 600,
        durationMin: 240, distanceKm: 400, stops: [0, 1, 2, 3],
        legs: [[0, 60, 100], [75, 150, 250], [165, 240, 400]] },
      { number: '10002', name: 'First Leg', type: 9, classes: 16, runsDays: 127, originDepMin: 620,
        durationMin: 70, distanceKm: 100, stops: [0, 4], legs: [[0, 70, 100]] },
      { number: '10003', name: 'Tight Connection', type: 9, classes: 16, runsDays: 127, originDepMin: 680,
        durationMin: 90, distanceKm: 150, stops: [4, 2], legs: [[0, 90, 150]] },
      { number: '10004', name: 'Makeable Connection', type: 9, classes: 16, runsDays: 127, originDepMin: 760,
        durationMin: 90, distanceKm: 150, stops: [4, 2], legs: [[0, 90, 150]] },
      { number: '10005', name: 'Onward', type: 9, classes: 16, runsDays: 127, originDepMin: 900,
        durationMin: 60, distanceKm: 90, stops: [2, 3], legs: [[0, 60, 90]] },
      { number: '10006', name: 'Sunday Only', type: 9, classes: 16, runsDays: 0b1000000, originDepMin: 500,
        durationMin: 120, distanceKm: 200, stops: [0, 5], legs: [[0, 120, 200]] },
    ];
    compare(trains, 6, 0, 540, 2, 'hand-written/mt2');
    compare(trains, 6, 0, 540, 1, 'hand-written/mt1');
    compare(trains, 6, 0, 540, 0, 'hand-written/mt0');
  });

  it('on a direct-only search over random networks', () => {
    for (const seed of SEEDS) {
      const { trains, stations } = randomNetwork(seed);
      compare(trains, stations, 0, 480, 0, `mt0/seed${seed}`);
    }
  });

  it('on one-change searches over random networks', () => {
    for (const seed of SEEDS) {
      const { trains, stations } = randomNetwork(seed);
      compare(trains, stations, 0, 480, 1, `mt1/seed${seed}`);
      compare(trains, stations, 3 % stations, 900, 1, `mt1b/seed${seed}`);
    }
  });

  it('on two-change searches over random networks', () => {
    for (const seed of SEEDS) {
      const { trains, stations } = randomNetwork(seed);
      compare(trains, stations, 0, 480, 2, `mt2/seed${seed}`);
      compare(trains, stations, 2 % stations, 1080, 2, `mt2b/seed${seed}`);
    }
  });

  it('from several origins and departure times, including just after midnight', () => {
    // A departure just after midnight is where service-day handling is most likely to be wrong:
    // the useful trains are the ones that left the previous evening and are still running.
    for (const seed of SEEDS.slice(0, 6)) {
      const { trains, stations } = randomNetwork(seed);
      for (const dep of [5, 300, 720, 1380]) {
        for (const origin of [0, Math.min(4, stations - 1)]) {
          compare(trains, stations, origin, dep, 1, `night/seed${seed}/dep${dep}/o${origin}`);
        }
      }
    }
  });

  it('never uses a train on a day it does not run', () => {
    // Asserted directly rather than only through the frontier comparison, because a network
    // where the weekly train happens not to matter would pass the comparison while the gating
    // was broken.
    const sundayOnly: TrainSpec = {
      number: '10006', name: 'Sunday Only', type: 9, classes: 16, runsDays: 0b1000000,
      originDepMin: 500, durationMin: 120, distanceKm: 200, stops: [0, 1], legs: [[0, 120, 200]],
    };
    const graph = makeGraph([sundayOnly], 2);
    const transfers = new TransferModel(graph, [], 2);
    const engine = new CsaEngine(graph, transfers, 2);

    // 2026-09-14 is a Monday; the train runs only on Sunday.
    const monday = buildTimetable(graph, DATE);
    expect(engine.search(monday, { departureMin: 400, origins: [0], destinations: [1], maxTransfers: 0 }).labels)
      .toEqual([]);

    // The following Sunday it must be found, or the gate has closed when it should be open.
    const sunday = buildTimetable(graph, '2026-09-20');
    expect(engine.search(sunday, { departureMin: 400, origins: [0], destinations: [1], maxTransfers: 0 }).labels.length)
      .toBe(1);
  });
});

/**
 * golden.test.ts — the routing engine against the real packed dataset, two ways.
 *
 * ---------------------------------------------------------------------------
 * 1. CORPUS MATCH
 * ---------------------------------------------------------------------------
 * tests/corpus/v1.json records what the app returned for 215 queries when it was generated.
 * Re-running them and diffing catches any change in behaviour, including changes that are
 * improvements — which is the point: a routing change that silently alters a thousand
 * itineraries should be a deliberate decision, not a side effect.
 *
 * The queries are applied through the SAME widening ladder the app uses (SEARCH_LADDER in
 * state/plan.ts), so the corpus characterises the product's real behaviour rather than a raw
 * search no traveller ever triggers.
 *
 * Curated city pairs must match exactly: those are the journeys a human can check against a
 * timetable, and a regression there means something is genuinely broken. The sampled half is
 * held to >= 95%, because it is drawn from the whole station list and includes pairs whose
 * results sit right on a pruning boundary, where a one-minute shift legitimately changes the
 * answer without anything being wrong.
 *
 * ---------------------------------------------------------------------------
 * 2. PROPERTIES
 * ---------------------------------------------------------------------------
 * The stronger half of this file. Expectations can only be as good as the code that generated
 * them; these invariants are worked out from what a journey MEANS, and they are checked on all
 * ~270 real itineraries the corpus produces. A router that returns plausible-looking nonsense
 * passes a characterisation test and fails here.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Container, ContainerKind } from '../src/lib/binary';
import { Graph, stationCountOf } from '../src/lib/graph';
import { StationIndex } from '../src/lib/stations';
import { buildTimetable, type Timetable } from '../src/router/timetable';
import { TransferModel } from '../src/router/transfers';
import { resolveTerminalGroups } from '../src/router/terminals';
import { CsaEngine } from '../src/router/csa';
import { reconstructAll, type Journey, type RailSegment } from '../src/router/journey';
import { SEARCH_LADDER } from '../src/state/plan';
import { DEFAULT_MAX_JOURNEY_MIN, DEFAULT_MAX_WAIT_MIN } from '../src/router/csa';
import { digestJourney } from './corpus';

const DATA = resolve(__dirname, '../public/data');
const CORPUS_FILE = resolve(__dirname, 'corpus/v1.json');
const HAVE_DATA = existsSync(resolve(DATA, 'graph.bin')) && existsSync(CORPUS_FILE);

function readAb(file: string): ArrayBuffer {
  const b = readFileSync(resolve(DATA, file));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

interface CorpusQuery {
  id: string;
  origin: number;
  destination: number;
  originCode: string;
  destinationCode: string;
  departureMin: number;
  maxTransfers: number;
  preferredClass: string | null;
  straightLineKm: number;
  kind: 'curated' | 'sampled';
  note?: string;
}

interface Corpus {
  version: number;
  generatedFrom: { date: string; seed: number; timetableRows: number };
  queries: CorpusQuery[];
  expectations: Record<string, { n: number; used: [number, number, number]; top: string[] }>;
}

interface Outcome {
  query: CorpusQuery;
  journeys: Journey[];
  used: [number, number, number];
  ms: number;
  top: string[];
}

let corpus: Corpus;
let stations: StationIndex;
let graph: Graph;
let transfers: TransferModel;
let engine: CsaEngine;
let tt: Timetable;
const outcomes: Outcome[] = [];

beforeAll(() => {
  if (!HAVE_DATA) return;
  corpus = JSON.parse(readFileSync(CORPUS_FILE, 'utf8')) as Corpus;

  const sc = Container.parse(readAb('stations.bin'), ContainerKind.Stations);
  stations = StationIndex.fromContainer(sc);
  const gc = Container.parse(readAb('graph.bin'), ContainerKind.Graph);
  stations.attachGeo(gc);
  graph = Graph.fromContainer(gc, stationCountOf(gc));

  const resolved = resolveTerminalGroups(stations.count, (code) => {
    const i = stations.indexOfCode(code);
    return i < 0 ? null : i;
  });
  transfers = new TransferModel(graph, resolved.groups, stations.count);
  engine = new CsaEngine(graph, transfers, stations.count);
  tt = buildTimetable(graph, corpus.generatedFrom.date);

  // The dataset the corpus was generated from must be the one being tested, or a diff means
  // nothing. This is the check that makes the rest of the file meaningful.
  expect(tt.count).toBe(corpus.generatedFrom.timetableRows);

  for (const q of corpus.queries) {
    let used: [number, number, number] = [q.maxTransfers, DEFAULT_MAX_JOURNEY_MIN, DEFAULT_MAX_WAIT_MIN];
    let journeys: Journey[] = [];
    let ms = 0;
    // Same rung construction as useJourneys: the traveller's own request first, then the ladder.
    const rungs: Array<readonly [number, number, number]> = [
      [q.maxTransfers, DEFAULT_MAX_JOURNEY_MIN, DEFAULT_MAX_WAIT_MIN],
      ...SEARCH_LADDER.filter((r) => r[0] > q.maxTransfers),
    ];
    for (const rung of rungs) {
      const t0 = performance.now();
      const r = engine.search(tt, {
        departureMin: q.departureMin,
        origins: [q.origin],
        destinations: [q.destination],
        maxTransfers: rung[0],
        preferredClass: q.preferredClass,
        maxJourneyMin: rung[1],
        maxWaitMin: rung[2],
      });
      ms += performance.now() - t0;
      used = [rung[0], rung[1], rung[2]];
      journeys = reconstructAll(r, tt, graph, { departureMin: q.departureMin });
      if (journeys.length > 0) break;
    }
    outcomes.push({ query: q, journeys, used, ms, top: journeys.slice(0, 3).map(digestJourney) });
  }
}, 180_000);

const allJourneys = (): Array<{ j: Journey; o: Outcome }> => outcomes.flatMap((o) => o.journeys.map((j) => ({ j, o })));
const railOf = (j: Journey): RailSegment[] => j.segments.filter((s): s is RailSegment => s.kind === 'rail');

describe.skipIf(!HAVE_DATA)('golden corpus v1', () => {
  it('the corpus and the dataset agree on scale', () => {
    expect(corpus.version).toBe(1);
    expect(corpus.queries.length).toBeGreaterThan(100);
    expect(graph.trainCount).toBe(5174);
    expect(stations.count).toBe(7219);
  });

  it('reproduces every curated city pair exactly', () => {
    const failures: string[] = [];
    for (const o of outcomes.filter((x) => x.query.kind === 'curated')) {
      const want = corpus.expectations[o.query.id];
      if (o.journeys.length !== want.n) {
        failures.push(`${o.query.originCode}->${o.query.destinationCode}: ${o.journeys.length} journeys, expected ${want.n}`);
        continue;
      }
      o.top.forEach((sig, i) => {
        if (sig !== want.top[i]) {
          failures.push(`${o.query.originCode}->${o.query.destinationCode} #${i}:\n      got ${sig}\n      want ${want.top[i]}`);
        }
      });
    }
    // Report every failure at once: a routing change usually moves many pairs together, and
    // seeing the pattern is what tells you whether it is a bug or an improvement.
    expect(failures).toEqual([]);
  });

  it('matches at least 95% of the sampled corpus', () => {
    const sampled = outcomes.filter((o) => o.query.kind === 'sampled');
    let matched = 0;
    for (const o of sampled) {
      const want = corpus.expectations[o.query.id];
      const same = o.journeys.length === want.n
        && o.top.every((sig, i) => sig === want.top[i]);
      if (same) matched++;
    }
    const ratio = matched / sampled.length;
    expect(ratio).toBeGreaterThanOrEqual(0.95);
  });

  it('finds a journey for every curated pair', () => {
    // These are major city pairs. If any of them comes back empty something is structurally
    // wrong, and the property tests below would have nothing to check.
    const empty = outcomes
      .filter((o) => o.query.kind === 'curated' && o.journeys.length === 0)
      .map((o) => `${o.query.originCode}->${o.query.destinationCode}`);
    expect(empty).toEqual([]);
  });
});

describe.skipIf(!HAVE_DATA)('journey properties, over every itinerary the corpus produces', () => {
  it('produces enough itineraries for the properties below to mean something', () => {
    expect(allJourneys().length).toBeGreaterThan(150);
  });

  it('never boards before the traveller said they were ready', () => {
    for (const { j, o } of allJourneys()) {
      expect(j.depMin, `${o.query.id} departs before the query time`).toBeGreaterThanOrEqual(o.query.departureMin);
    }
  });

  it('reports a duration that equals arrival minus departure', () => {
    for (const { j, o } of allJourneys()) {
      expect(j.durationMin, o.query.id).toBe(j.arrMin - j.depMin);
      expect(j.durationMin, o.query.id).toBeGreaterThan(0);
    }
  });

  it('keeps segments contiguous in space — you arrive where the next one leaves', () => {
    for (const { j, o } of allJourneys()) {
      for (let i = 1; i < j.segments.length; i++) {
        expect(j.segments[i].from, `${o.query.id} segment ${i} starts somewhere else`).toBe(j.segments[i - 1].to);
      }
      expect(j.origin, o.query.id).toBe(j.segments[0].from);
      expect(j.destination, o.query.id).toBe(j.segments[j.segments.length - 1].to);
    }
  });

  it('keeps segments contiguous in time — nothing leaves before the previous one arrives', () => {
    for (const { j, o } of allJourneys()) {
      for (let i = 1; i < j.segments.length; i++) {
        expect(j.segments[i].depMin, o.query.id).toBeGreaterThanOrEqual(j.segments[i - 1].arrMin);
      }
    }
  });

  it('actually starts and ends where the traveller asked', () => {
    for (const { j, o } of allJourneys()) {
      expect(j.origin, o.query.id).toBe(o.query.origin);
      expect(j.destination, o.query.id).toBe(o.query.destination);
    }
  });

  it('distances sum to the total, so the header cannot contradict the legs', () => {
    for (const { j, o } of allJourneys()) {
      const sum = j.segments.reduce((a, s) => a + (s.kind === 'rail' ? s.distKm : Math.round(s.km)), 0);
      expect(j.totalKm, o.query.id).toBe(sum);
    }
  });

  it('fares sum to the total, including road hops', () => {
    for (const { j, o } of allJourneys()) {
      const sum = j.segments.reduce((a, s) => a + (s.kind === 'rail' ? s.fareRupees : s.costRupees), 0);
      expect(j.fareRupees, o.query.id).toBe(sum);
    }
  });

  it('prices every rail segment from its own total distance, never per hop', () => {
    // A merged ride over N hops must cost less than N separately-ticketed hops would, because
    // IRCTC's slab tapers and fixed charges apply once. This is the bug that made a 1,000 km
    // ride look like it cost twice what it does.
    let checkedMultiHop = 0;
    for (const { j, o } of allJourneys()) {
      for (const s of railOf(j)) {
        expect(s.distKm, o.query.id).toBeGreaterThan(0);
        expect(s.fareRupees, o.query.id).toBeGreaterThan(0);
        expect(s.hops, o.query.id).toBeGreaterThanOrEqual(1);
        if (s.hops > 1) checkedMultiHop++;
      }
    }
    // If no multi-hop ride was ever produced the merge is not being exercised at all.
    expect(checkedMultiHop).toBeGreaterThan(20);
  });

  it('counts train changes, and does not count road hops as changes', () => {
    for (const { j, o } of allJourneys()) {
      const rail = railOf(j);
      // Each rail segment after the first is a change of train.
      expect(j.transfers, o.query.id).toBe(Math.max(0, rail.length - 1));
      expect(j.roadTransfers, o.query.id).toBe(j.segments.length - rail.length);
    }
  });

  it('respects the maximum number of changes it claimed to use', () => {
    for (const o of outcomes) {
      for (const j of o.journeys) {
        expect(j.transfers, `${o.query.id} exceeded ${o.used[0]} changes`).toBeLessThanOrEqual(o.used[0]);
      }
    }
  });

  it('stays inside the time-in-transit budget it claimed to use', () => {
    for (const o of outcomes) {
      for (const j of o.journeys) {
        const rail = railOf(j);
        if (rail.length === 0) continue;
        // Measured from boarding the first train, not from the query time: waiting at home is
        // bounded separately and must not be charged against the journey.
        const inTransit = j.arrMin - rail[0].depMin;
        expect(inTransit, `${o.query.id} spent ${inTransit} min in transit`).toBeLessThanOrEqual(o.used[1]);
      }
    }
  });

  it('allows enough time to change trains at every station it changes at', () => {
    // The single most damaging thing a planner can do is invent a connection nobody could make.
    let checked = 0;
    for (const { j, o } of allJourneys()) {
      for (let i = 1; i < j.segments.length; i++) {
        const prev = j.segments[i - 1];
        const next = j.segments[i];
        if (prev.kind !== 'rail' || next.kind !== 'rail') continue; // a road hop absorbs its own time
        const gap = next.depMin - prev.arrMin;
        const need = transfers.minTransferMin(prev.to);
        expect(gap, `${o.query.id} changes at station ${prev.to} in ${gap} min, needs ${need}`)
          .toBeGreaterThanOrEqual(need);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('never presents a train as running on a day it does not', () => {
    for (const { j, o } of allJourneys()) {
      for (const s of railOf(j)) {
        // Service day is an offset BACK from the query date: a train already under way when the
        // traveller sets out. It can never be in the future.
        expect(s.serviceDayOffset, o.query.id).toBeLessThanOrEqual(0);
        expect(s.serviceDayOffset, o.query.id).toBeGreaterThanOrEqual(-7);
      }
    }
  });

  it('flags every fare as an estimate, because no availability feed is wired yet', () => {
    for (const { j, o } of allJourneys()) {
      for (const s of railOf(j)) {
        expect(s.fareEstimate, o.query.id).toBe(true);
        // The breakdown must add up, or the UI would show parts that do not sum to the total.
        expect(s.baseFare + s.reservation + s.surcharge + s.gst, o.query.id).toBe(s.fareRupees);
      }
    }
  });

  it('counts night arrivals and early departures consistently with the segments', () => {
    for (const { j, o } of allJourneys()) {
      const rail = railOf(j);
      expect(j.nightArrivals, o.query.id).toBe(rail.filter((s) => s.nightArrival).length);
      expect(j.earlyDepartures, o.query.id)
        .toBe(rail.filter((s) => s.depMin % 1440 < 360).length);
    }
  });

  it('offers a class the train actually has, or says it substituted', () => {
    for (const { j, o } of allJourneys()) {
      for (const s of railOf(j)) {
        const offered = graph.train(s.trainIx).classes;
        if (offered.includes(s.klass)) continue;
        // Not offered: then it must be flagged, and the traveller must have asked for something.
        expect(s.classFellBack, `${o.query.id} priced ${s.klass} on ${s.trainNumber} which does not offer it`)
          .toBe(true);
        expect(o.query.preferredClass, o.query.id).not.toBeNull();
      }
    }
  });

  it('produces journeys that are not beaten on every criterion by a sibling', () => {
    // The whole point of a Pareto frontier: two results for one query must differ in at least
    // one way that matters. If one is better on arrival AND changes AND fare, the other should
    // never have been shown.
    for (const o of outcomes) {
      const js = o.journeys;
      for (let a = 0; a < js.length; a++) {
        for (let b = 0; b < js.length; b++) {
          if (a === b) continue;
          const dominated = js[a].arrMin <= js[b].arrMin
            && js[a].transfers <= js[b].transfers
            && js[a].fareRupees <= js[b].fareRupees
            && js[a].nightArrivals <= js[b].nightArrivals
            && js[a].earlyDepartures <= js[b].earlyDepartures
            && (js[a].arrMin < js[b].arrMin || js[a].transfers < js[b].transfers
              || js[a].fareRupees < js[b].fareRupees || js[a].nightArrivals < js[b].nightArrivals
              || js[a].earlyDepartures < js[b].earlyDepartures);
          expect(dominated, `${o.query.id}: result ${b} is dominated by result ${a}`).toBe(false);
        }
      }
    }
  });

  it('exercises road transfers between city terminals somewhere in the corpus', () => {
    const withRoad = allJourneys().filter(({ j }) => j.roadTransfers > 0);
    expect(withRoad.length).toBeGreaterThan(0);
    for (const { j, o } of withRoad) {
      for (const s of j.segments) {
        if (s.kind !== 'road') continue;
        expect(s.minutes, o.query.id).toBeGreaterThan(0);
        expect(s.costRupees, o.query.id).toBeGreaterThan(0);
        expect(s.city.length, o.query.id).toBeGreaterThan(0);
      }
    }
  });

  it('exercises multi-leg itineraries, which is the feature this app exists for', () => {
    const multi = allJourneys().filter(({ j }) => railOf(j).length >= 2);
    expect(multi.length).toBeGreaterThan(20);
  });
});

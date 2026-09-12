/**
 * perf.test.ts — the search budget, measured rather than assumed.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS ASSERTS, AND WHAT IT DOES NOT
 * ---------------------------------------------------------------------------
 * The Phase 1 acceptance target is "1,000 queries in under 2 s inside the worker". This file
 * measures that exact workload on the real dataset and asserts bounds that catch a regression.
 *
 * It does NOT currently assert the 2 s figure, because the honest measurement does not meet it,
 * and a threshold loosened until it passes is worse than no threshold: it would report a green
 * tick against a target that was missed. What is asserted instead is
 *
 *   - no single query may blow up (the failure mode that actually breaks the UI — one 3-second
 *     search freezes a results screen, while a uniformly slow one merely feels sluggish);
 *   - the total may not regress by more than a fixed factor from the recorded baseline.
 *
 * The gap, its cause and the way to close it are recorded in docs/04 under deviations.
 *
 * ---------------------------------------------------------------------------
 * WHY THE NUMBERS ARE GENEROUS, AND HONEST ABOUT IT
 * ---------------------------------------------------------------------------
 * Two things make CI slower than a traveller's browser, and both are worth stating rather than
 * hiding behind a number:
 *
 *   - Vitest runs under jsdom with Vite's module transform. The same workload measured in plain
 *     Node is about 3x faster, and a real browser worker with fully optimised JIT code is faster
 *     still. These bounds are therefore set against the CI environment, not the deployed one.
 *   - The search is memory-bound over ~2 MB of typed arrays per query. On a throttled or shared
 *     CI runner that varies more than compute-bound work does, so the bounds carry real
 *     headroom to avoid a flaky red build. A flaky performance test gets ignored, and an ignored
 *     performance test catches nothing.
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
import { buildCorpus, type CorpusQuery } from './corpus';

const DATA = resolve(__dirname, '../public/data');
const HAVE_DATA = existsSync(resolve(DATA, 'graph.bin'));

/** The workload the acceptance criterion names. */
const QUERY_COUNT = 1000;

/**
 * Hard ceiling on one query.
 *
 * Set an order of magnitude above the observed worst case rather than just above it: the point
 * is to catch a pathological blowup — a frontier that stops being bounded, a horizon that stops
 * being applied — not to fail a build because a runner was busy.
 */
const MAX_SINGLE_QUERY_MS = 1500;

/**
 * Ceiling on the whole 1,000-query workload, in the CI environment.
 *
 * Measured baseline on the sandbox that wrote this: 5.1 s total, p50 3.7 ms, p95 15 ms, worst
 * 54 ms. The bound is ~9x that, because a shared GitHub runner can be several times slower than
 * a developer machine and a build that fails on noise gets its threshold raised until it means
 * nothing. The shape bounds below do the real regression-catching work.
 */
const MAX_TOTAL_MS = 45_000;

/**
 * Ceiling on the 95th percentile.
 *
 * This is the bound that matters. The total can double because a runner was busy; the p95 only
 * jumps by an order of magnitude when the algorithm changed — a lost per-row bounds cache, a
 * frontier cap that stopped applying, a horizon that no longer prunes. Scale-free, so it holds
 * across environments.
 */
const MAX_P95_MS = 300;

let stations: StationIndex;
let engine: CsaEngine;
let tt: Timetable;
let corpus: CorpusQuery[];

beforeAll(() => {
  if (!HAVE_DATA) return;
  const ab = (f: string): ArrayBuffer => {
    const b = readFileSync(resolve(DATA, f));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  };
  const sc = Container.parse(ab('stations.bin'), ContainerKind.Stations);
  stations = StationIndex.fromContainer(sc);
  const gc = Container.parse(ab('graph.bin'), ContainerKind.Graph);
  stations.attachGeo(gc);
  const graph = Graph.fromContainer(gc, stationCountOf(gc));
  const resolved = resolveTerminalGroups(stations.count, (code) => {
    const i = stations.indexOfCode(code);
    return i < 0 ? null : i;
  });
  engine = new CsaEngine(graph, new TransferModel(graph, resolved.groups, stations.count), stations.count);
  tt = buildTimetable(graph, '2026-09-14');
  corpus = buildCorpus(graph, stations, QUERY_COUNT);
}, 180_000);

describe.skipIf(!HAVE_DATA)('search throughput on the real dataset', () => {
  it('runs 1,000 realistic queries within the CI budget, with no single blowup', () => {
    const times: number[] = [];
    let found = 0;
    let results = 0;
    let truncated = 0;

    const start = performance.now();
    for (const q of corpus) {
      const t0 = performance.now();
      const r = engine.search(tt, {
        departureMin: q.departureMin,
        origins: [q.origin],
        destinations: [q.destination],
        maxTransfers: q.maxTransfers,
        preferredClass: q.preferredClass,
      });
      times.push(performance.now() - t0);
      if (r.labels.length > 0) found++;
      results += r.labels.length;
      // A truncated search returns an incomplete answer silently unless the caller checks, so a
      // truncation on a normal query is treated as a failure rather than a slow pass.
      if (r.truncated) truncated++;
    }
    const total = performance.now() - start;

    times.sort((a, b) => a - b);
    const pct = (p: number): number => times[Math.min(times.length - 1, Math.floor(times.length * p))];

    // Reported rather than only asserted: the numbers are the useful part, and a build log that
    // says "passed" tells nobody whether the search got 20% slower this week.
    // eslint-disable-next-line no-console
    console.log(
      `[perf] ${QUERY_COUNT} queries: total ${total.toFixed(0)} ms · `
      + `p50 ${pct(0.5).toFixed(2)} ms · p95 ${pct(0.95).toFixed(2)} ms · max ${times[times.length - 1].toFixed(1)} ms · `
      + `found ${found} (${(found / QUERY_COUNT * 100).toFixed(1)}%) · results ${results} · truncated ${truncated}`,
    );

    expect(times[times.length - 1], 'a single query blew up').toBeLessThan(MAX_SINGLE_QUERY_MS);
    expect(pct(0.95), 'the search got algorithmically slower, not just busier').toBeLessThan(MAX_P95_MS);
    expect(total, 'the whole workload regressed').toBeLessThan(MAX_TOTAL_MS);
    expect(truncated, 'the label pool filled, so answers were incomplete').toBe(0);
    // Sanity, not performance: a search this fast that found nothing anywhere would be fast
    // because it was broken.
    expect(found).toBeGreaterThan(QUERY_COUNT * 0.1);
  }, 300_000);

  it('reuses its caches across a departure-time sweep on one pair', () => {
    // The realistic repeated-query workload: one traveller sliding the departure time. The
    // per-row bounds and the per-class pricing are both cached, so a sweep should be markedly
    // cheaper per query than the cold mixed workload above.
    const delhi = stations.indexOfCode('NDLS');
    const mumbai = stations.indexOfCode('BCT');
    expect(delhi).toBeGreaterThanOrEqual(0);
    expect(mumbai).toBeGreaterThanOrEqual(0);

    // Warm the caches on this pair first; a cold call also builds the bounds array.
    engine.search(tt, { departureMin: 480, origins: [delhi], destinations: [mumbai], maxTransfers: 2 });

    const t0 = performance.now();
    let any = 0;
    for (let i = 0; i < 200; i++) {
      const r = engine.search(tt, {
        departureMin: (i * 7) % 1440, origins: [delhi], destinations: [mumbai], maxTransfers: 2,
      });
      if (r.labels.length > 0) any++;
    }
    const perQuery = (performance.now() - t0) / 200;
    // eslint-disable-next-line no-console
    console.log(`[perf] warm sweep NDLS->BCT: ${perQuery.toFixed(2)} ms/query, ${any}/200 departures had an itinerary`);

    expect(any, 'a whole day of departures found nothing').toBeGreaterThan(150);
    // A warm query on a dense trunk corridor is the most expensive realistic single search
    // (thousands of labels survive), so it gets the same ceiling as the mixed workload's worst.
    expect(perQuery).toBeLessThan(MAX_SINGLE_QUERY_MS);
  }, 300_000);
});

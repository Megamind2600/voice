/**
 * corpus.ts — the query set that defines "correct" and "fast enough" for the router.
 *
 * ---------------------------------------------------------------------------
 * WHY A GENERATED CORPUS RATHER THAN A HAND-PICKED ONE
 * ---------------------------------------------------------------------------
 * Hand-picked queries measure the cases the author thought of, which is exactly the cases the
 * author already made work. A seeded sample over the real station list measures the traffic the
 * app will actually see, and it catches the failure that matters most here: a router that is
 * correct for Delhi-to-Mumbai and quietly broken for Jhansi-to-Gwalior.
 *
 * The seed is fixed and the generator is pure, so the corpus is reproducible and a change that
 * alters results shows up as a diff rather than as flakiness.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SAMPLE IS WEIGHTED AND DISTANCE-BOUNDED
 * ---------------------------------------------------------------------------
 * Uniform sampling over 7,219 stations would be mostly tiny halts nobody travels between, and
 * would report a performance figure that has nothing to do with real use. So origins and
 * destinations are weighted by station rank — a proxy for how much traffic a station sees —
 * and pairs that are implausibly far apart are usually rejected. Real travellers mostly go
 * a few hundred kilometres, occasionally cross the country, and almost never go 3,000 km for a
 * day trip. The corpus should look like that, or the timings it produces are fiction.
 */

import type { Graph } from '../src/lib/graph';
import type { StationIndex } from '../src/lib/stations';
import type { Journey } from '../src/router/journey';

/**
 * A stable text digest of a journey, for the golden corpus.
 *
 * Deliberately NOT `summarise` from journey.ts: that one is also the share text, and letting a
 * cosmetic wording change there rewrite the whole corpus would destroy its value as a
 * regression signal. This depends only on routing facts — which trains, which stations, which
 * minutes, which class, which rupees — so it changes only when the answer changes.
 *
 * Shared between the generator and the test on purpose. Two implementations of a digest is how a
 * corpus ends up recording something the test does not compare.
 */
export function digestJourney(j: Journey): string {
  const parts = j.segments.map((s) => (s.kind === 'rail'
    ? `R:${s.trainNumber}:${s.from}>${s.to}:${s.depMin}:${s.arrMin}:${s.hops}:${s.distKm}:${s.klass}:${s.fareRupees}`
    : `D:${s.from}>${s.to}:${s.depMin}:${s.arrMin}:${s.costRupees}`));
  return `${j.origin}>${j.destination}|${j.depMin}|${j.arrMin}|${j.transfers}|${j.totalKm}`
    + `|${j.fareRupees}|${parts.join(',')}`;
}

export interface CorpusQuery {
  /** Stable id, so a failing query can be named in a report. */
  id: string;
  origin: number;
  destination: number;
  originCode: string;
  destinationCode: string;
  departureMin: number;
  maxTransfers: number;
  preferredClass: string | null;
  /** Straight-line km, recorded so results can be grouped by distance band. */
  straightLineKm: number;
}

/**
 * A small deterministic PRNG (mulberry32).
 *
 * Not `Math.random`: the corpus must be byte-identical across runs, machines and CI, or a
 * "95% match" assertion measures nothing.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Classes a traveller plausibly asks for, with the weights Indian booking actually shows. */
const CLASS_MIX: ReadonlyArray<[string | null, number]> = [
  ['SL', 0.34],   // sleeper is the default for most long-distance travel
  ['3A', 0.26],
  ['2A', 0.12],
  ['CC', 0.08],   // short daytime intercity
  ['1A', 0.03],
  ['2S', 0.05],
  [null, 0.12],   // "cheapest available" — the mode the app defaults to
];

/**
 * Build a corpus of `size` queries.
 *
 * Distance bands are targeted rather than left to chance: without steering, a rank-weighted
 * sample produces mostly short hops and the long-distance code path — the one with transfers,
 * overnight legs and the expensive scan — is barely exercised. Each band gets a share so all
 * three regimes are represented.
 */
export function buildCorpus(
  graph: Graph,
  stations: StationIndex,
  size: number,
  seed = 20260914,
): CorpusQuery[] {
  const rnd = mulberry32(seed);
  const n = stations.count;

  // Traffic-weighted pick, using how many trains actually call at a station.
  //
  // `Station.rank` was tried first and is the wrong proxy: it is a four-value category
  // (halt / intermediate / junction / metro) derived from the data, not a percentile, so
  // weighting by it barely biases anything. `calls` is a real traffic count. Normalising by the
  // busiest station and taking a square root flattens the distribution enough that village
  // halts still appear — a journey from one is rare but real, and a router never exercised on
  // them quietly rots.
  let maxCalls = 1;
  for (let i = 0; i < n; i++) {
    const c = stations.at(i).calls;
    if (c > maxCalls) maxCalls = c;
  }
  const pickWeighted = (): number => {
    for (let attempt = 0; attempt < 64; attempt++) {
      const s = Math.floor(rnd() * n);
      const w = Math.sqrt(stations.at(s).calls / maxCalls);
      if (rnd() < Math.max(0.02, w)) return s;
    }
    return Math.floor(rnd() * n);
  };

  const classOf = (): string | null => {
    const x = rnd();
    let acc = 0;
    for (const [code, w] of CLASS_MIX) {
      acc += w;
      if (x < acc) return code;
    }
    return 'SL';
  };

  // Bands as [minKm, maxKm, share]. Shares sum to 1.
  const BANDS: ReadonlyArray<[number, number, number]> = [
    [0, 250, 0.40],       // day trips and intercity — the commonest real search
    [250, 900, 0.35],     // overnight one-train journeys
    [900, 3200, 0.25],    // cross-country, where transfers and road hops earn their place
  ];

  const pickBand = (): [number, number] => {
    const x = rnd();
    let acc = 0;
    for (const [lo, hi, share] of BANDS) {
      acc += share;
      if (x < acc) return [lo, hi];
    }
    return [250, 900];
  };

  const out: CorpusQuery[] = [];
  let guard = 0;
  const maxGuard = size * 400;

  while (out.length < size && guard++ < maxGuard) {
    const o = pickWeighted();
    const d = pickWeighted();
    if (o === d) continue;

    const co = graph.coordsOf(o);
    const cd = graph.coordsOf(d);
    // No coordinates: cannot place the pair in a distance band, so skip rather than guess.
    if (co === null || cd === null) continue;
    const km = haversine(co.lat, co.lon, cd.lat, cd.lon);
    const [lo, hi] = pickBand();
    if (km < lo || km > hi) continue;

    // Departure spread across the day. Indian long-distance departures cluster in the evening
    // and overnight, so the sample is skewed that way rather than uniform: a corpus that only
    // searched 03:00 departures would not stress the timetable the way real use does.
    const x = rnd();
    const departureMin = x < 0.35
      ? 1020 + Math.floor(rnd() * 300)     // 17:00-22:00 evening peak
      : x < 0.60
        ? 1200 + Math.floor(rnd() * 300)   // 20:00-01:00 overnight
        : Math.floor(rnd() * 1440);        // anywhere

    // Most travellers accept at most two changes; a minority will take more to get somewhere.
    const mtRnd = rnd();
    const maxTransfers = mtRnd < 0.55 ? 1 : mtRnd < 0.85 ? 2 : mtRnd < 0.97 ? 3 : 0;

    out.push({
      id: `q${String(out.length).padStart(4, '0')}`,
      origin: o,
      destination: d,
      originCode: stations.at(o).code,
      destinationCode: stations.at(d).code,
      departureMin: departureMin % 1440,
      maxTransfers,
      preferredClass: classOf(),
      straightLineKm: Math.round(km),
    });
  }

  if (out.length < size) {
    throw new Error(`corpus generation stalled at ${out.length}/${size} queries after ${guard} attempts`);
  }
  return out;
}

function haversine(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const la = (aLat * Math.PI) / 180;
  const lb = (bLat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

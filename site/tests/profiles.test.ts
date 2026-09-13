/**
 * profiles.test.ts — the authored destination notes, checked against the packed timetable.
 *
 * The notes are the one part of this project that is editorial rather than harvested, and
 * editorial data rots differently from binary data: nothing crashes when a station code is
 * misspelled, the profile simply never appears, and nobody notices for months. So the checks here
 * are the ones that catch silent rot:
 *
 *   - every claimed station code must exist in the REAL packed dataset, because a code that does
 *     not resolve is a profile that is silently unreachable;
 *   - no code may be claimed by two profiles, because the index resolves that by first-writer-wins
 *     and the loser would vanish without a trace;
 *   - every profile must carry at least a why, some sights and a positive distance for each;
 *   - coverage of the busiest stations must not fall below the level that makes the feature worth
 *     having, so that deleting profiles fails here rather than quietly making explore mode emptier.
 *
 * The file is loaded the way the app loads it — through `parseProfiles` — so a change to the
 * on-disk shape fails here before it fails in a browser.
 *
 * Distances are deliberately NOT cross-checked against station coordinates. They are road
 * distances to a place (a fort, a beach), and the coordinates are of a station; a test asserting
 * they agree within some tolerance would fail on every hill station and teach the author to fudge
 * the numbers. `nearby.ts` is what uses coordinates, and it is tested as arithmetic.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Container, ContainerKind } from '../src/lib/binary';
import { stationCountOf } from '../src/lib/graph';
import { StationIndex } from '../src/lib/stations';
import { buildProfileIndex, profileFor, type ProfileIndex } from '../src/discovery/profiles';
import { fetchProfiles, parseProfiles } from '../src/state/useProfiles';
import { nearbyProfiled } from '../src/discovery/nearby';
import { roadHopLabel, roadHopMinutes, roadHopRupees } from '../src/discovery/roadhop';

const DATA = resolve(__dirname, '../public/data');
const HAVE_DATA = existsSync(resolve(DATA, 'stations.bin')) && existsSync(resolve(DATA, 'graph.bin'));

let stations: StationIndex;
let notes: ProfileIndex;

function readAb(file: string): ArrayBuffer {
  const b = readFileSync(resolve(DATA, file));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

beforeAll(() => {
  const doc: unknown = JSON.parse(readFileSync(resolve(DATA, 'profiles.json'), 'utf8'));
  notes = parseProfiles(doc);
  if (!HAVE_DATA) return;
  stations = StationIndex.fromContainer(Container.parse(readAb('stations.bin'), ContainerKind.Stations));
  // Coordinates live in graph.bin's STATION_GEO section and are only present after attachGeo, so
  // without this the nearby-distance test would pass vacuously on a dataset with no geometry.
  const graph = Container.parse(readAb('graph.bin'), ContainerKind.Graph);
  stations.attachGeo(graph);
  expect(stationCountOf(graph)).toBe(stations.count);
});

describe('the shipped destination notes', () => {
  it('come in as a list of profiles, each with the fields a card needs', () => {
    expect(notes.profiles.length).toBeGreaterThan(50);
    for (const p of notes.profiles) {
      expect(p.codes.length, `${p.name}: no codes`).toBeGreaterThan(0);
      expect(p.name.trim().length, 'a profile with no name').toBeGreaterThan(0);
      expect(p.why.trim().length, `${p.name}: why is too short to be a reason`).toBeGreaterThan(20);
      expect(p.tags.length, `${p.name}: no tags`).toBeGreaterThan(0);
      expect(p.sights.length, `${p.name}: fewer than two sights`).toBeGreaterThanOrEqual(2);
    }
  });

  it('claims a station code that exists in the packed dataset, for every code it claims', () => {
    if (!HAVE_DATA) return;
    const missing = notes.claimed.filter((code) => stations.indexOfCode(code) < 0);
    expect(missing, 'these profile codes do not resolve to a station').toEqual([]);
  });

  it('never lets two profiles claim the same code', () => {
    expect(notes.collisions).toEqual([]);
    expect(new Set(notes.claimed).size).toBe(notes.claimed.length);
  });

  it('keeps every distance a plausible planning figure with the right sign', () => {
    const problems: string[] = [];
    for (const p of notes.profiles) {
      for (const s of p.sights) {
        if (!(s.km >= 0) || s.km > 500) problems.push(`${p.name} / ${s.name}: ${s.km} km`);
        if (s.kind.trim().length === 0 || s.kind.length > 20) {
          problems.push(`${p.name} / ${s.name}: kind "${s.kind}" is not a chip-sized word`);
        }
      }
      for (const g of p.gateways ?? []) {
        if (!(g.km > 0) || g.km > 500) problems.push(`${p.name} / gateway ${g.name}: ${g.km} km`);
        if (g.note.trim().length < 5) problems.push(`${p.name} / gateway ${g.name}: no note`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('does not repeat a sight within one profile', () => {
    const problems: string[] = [];
    for (const p of notes.profiles) {
      const names = p.sights.map((s) => s.name.toLowerCase());
      if (new Set(names).size !== names.length) problems.push(`${p.name}: duplicate sight`);
    }
    expect(problems).toEqual([]);
  });

  it('covers the busiest stations well enough for the explore screen to be worth reading', () => {
    if (!HAVE_DATA) return;
    const busiest = stations.popular(50).map((s) => s.code);
    const covered = busiest.filter((c) => profileFor(notes, c) !== null).length;
    // The floor is deliberately below the current figure so that adding profiles never fails the
    // build, while deleting them does.
    expect(covered, `only ${covered} of the 50 busiest stations have a profile`).toBeGreaterThanOrEqual(20);
  });
});

describe('profileFor', () => {
  it('resolves codes case-insensitively, and knows when a city has several terminals', () => {
    const mumbai = profileFor(notes, 'cstm');
    expect(mumbai?.profile.name).toBe('Mumbai');
    expect(mumbai?.primary).toBe('CSTM');
    expect(mumbai?.viaOtherTerminal).toBe(false);
    // A different terminal of the same city resolves to the same profile, flagged as such so the
    // UI can say which station the distances were measured from.
    const fromBct = profileFor(notes, 'BCT');
    expect(fromBct?.profile.name).toBe('Mumbai');
    expect(fromBct?.viaOtherTerminal).toBe(true);
  });

  it('returns null rather than guessing', () => {
    expect(profileFor(notes, 'ZZZZ')).toBeNull();
    expect(profileFor(notes, null)).toBeNull();
    expect(profileFor(notes, '')).toBeNull();
    expect(profileFor(null, 'CSTM')).toBeNull();
  });

  it('keeps the first claim when two profiles collide, and says so in the index', () => {
    const index = buildProfileIndex([
      { codes: ['AAA'], name: 'First', why: 'x'.repeat(21), tags: ['a'], sights: [] },
      { codes: ['AAA'], name: 'Second', why: 'y'.repeat(21), tags: ['b'], sights: [] },
    ]);
    expect(index.collisions).toEqual(['AAA']);
    expect(profileFor(index, 'AAA')?.profile.name).toBe('First');
  });
});

describe('parseProfiles', () => {
  it('accepts both the shipped wrapper and a bare list', () => {
    const doc = JSON.parse(readFileSync(resolve(DATA, 'profiles.json'), 'utf8'));
    expect(parseProfiles(doc).profiles.length).toBe(notes.profiles.length);
    expect(parseProfiles(doc.profiles).profiles.length).toBe(notes.profiles.length);
  });

  it('rejects anything that is not a list of profiles, rather than rendering half a card', () => {
    expect(() => parseProfiles({})).toThrow(/profiles/);
    expect(() => parseProfiles({ profiles: [{ name: 'No codes' }] })).toThrow(/codes/);
    expect(() => parseProfiles({ profiles: [{ codes: ['X'], name: 'Half' }] })).toThrow(/why/);
  });
});

describe('fetchProfiles', () => {
  it('reports a failed download instead of throwing it into the renderer', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(new Response('missing', { status: 404 }))) as typeof fetch;
    try {
      await expect(fetchProfiles('data/profiles.json')).rejects.toThrow(/404/);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('reads the shipped file through the same path the app uses', async () => {
    const body = readFileSync(resolve(DATA, 'profiles.json'), 'utf8');
    const original = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(new Response(body, { status: 200 }))) as typeof fetch;
    try {
      const loaded = await fetchProfiles('data/profiles.json');
      expect(loaded.profiles.length).toBe(notes.profiles.length);
      expect(loaded.claimed.length).toBe(notes.claimed.length);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('nearby — the fallback for stations nobody has written about', () => {
  it('says nothing for a station that has its own profile', () => {
    if (!HAVE_DATA) return;
    const ix = stations.indexOfCode('CSTM');
    expect(nearbyProfiled(stations, ix, notes)).toEqual([]);
  });

  it('returns the nearest profiled places, closest first', () => {
    if (!HAVE_DATA) return;
    // Itarsi Junction is a pure interchange with no profile of its own; several profiled places
    // are within a few hundred kilometres of it.
    const ix = stations.indexOfCode('ET');
    const near = nearbyProfiled(stations, ix, notes, 3);
    expect(near.length).toBeGreaterThan(0);
    for (let i = 1; i < near.length; i++) expect(near[i - 1].km).toBeLessThanOrEqual(near[i].km);
    // Straight-line distances from a central-India junction cannot reach the far south.
    for (const n of near) expect(n.km).toBeLessThan(900);
  });

  it('degrades to nothing rather than throwing when there is no index or no geometry', () => {
    expect(nearbyProfiled(null, 0, notes)).toEqual([]);
    expect(nearbyProfiled(stations ?? null, 0, null)).toEqual([]);
  });
});

describe('road hops', () => {
  it('grows with distance and never promises a speed it cannot keep', () => {
    expect(roadHopMinutes(0)).toBeGreaterThanOrEqual(10);
    expect(roadHopMinutes(20)).toBeGreaterThan(roadHopMinutes(10));
    expect(roadHopMinutes(90)).toBeGreaterThan(roadHopMinutes(30));
    // A 400 km hop is a day out, not an afternoon: the model must not report it as three hours.
    expect(roadHopMinutes(400)).toBeGreaterThan(7 * 60);
  });

  it('costs money in a way a taxi would recognise, and never nothing', () => {
    expect(roadHopRupees(0)).toBeGreaterThanOrEqual(150);
    expect(roadHopRupees(100)).toBeGreaterThan(roadHopRupees(30));
    expect(roadHopRupees(30) % 50).toBe(0);
  });

  it('labels the hop with an approximation, in hours and minutes', () => {
    expect(roadHopLabel(60)).toMatch(/by road/);
    expect(roadHopLabel(60)).toMatch(/≈/);
    expect(roadHopLabel(5)).toMatch(/min/);
    expect(roadHopLabel(100)).toMatch(/h/);
  });
});

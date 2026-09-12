import { describe, expect, it } from 'vitest';
import { Container, ContainerKind } from '../src/lib/binary';
import { StationIndex, normalise } from '../src/lib/stations';
import { buildGraphContainer, buildStationsContainer } from './helpers';

const SPECS = [
  { code: 'SC', name: 'Secunderabad Jn', rank: 3, calls: 412 },
  { code: 'KCG', name: 'Kacheguda', rank: 2, calls: 180 },
  { code: 'HYB', name: 'Hyderabad Deccan', rank: 2, calls: 96 },
  { code: 'HWH', name: 'Howrah Jn', rank: 3, calls: 388 },
  { code: 'NDLS', name: 'New Delhi', rank: 3, calls: 350 },
  { code: 'NZM', name: 'Hazrat Nizamuddin', rank: 3, calls: 300 },
  { code: 'BY', name: 'Byculla', rank: 1, calls: 3 },
  { code: 'SBC', name: 'Ksr Bengaluru', rank: 3, calls: 260 },
];

function idx() {
  return StationIndex.fromContainer(
    Container.parse(buildStationsContainer(SPECS), ContainerKind.Stations),
  );
}

describe('normalise', () => {
  it('uppercases and strips punctuation', () => {
    expect(normalise('Secunderabad Jn.')).toBe('SECUNDERABAD JN');
    expect(normalise("K.S.R. Bengaluru")).toBe('K S R BENGALURU');
  });
  it('collapses runs of whitespace and trims', () => {
    expect(normalise('  new   delhi  ')).toBe('NEW DELHI');
  });
  it('keeps digits', () => {
    expect(normalise('platform 2')).toBe('PLATFORM 2');
  });
  it('is idempotent', () => {
    const once = normalise('Hazrat Nizamuddin');
    expect(normalise(once)).toBe(once);
  });
});

describe('StationIndex', () => {
  it('parses every field of every record', () => {
    const i = idx();
    expect(i.count).toBe(SPECS.length);
    // Records come back in the packer's order (sorted by code), not the spec order.
    const sorted = [...SPECS].sort((a, b) => (a.code < b.code ? -1 : 1));
    sorted.forEach((s, n) => {
      const got = i.at(n);
      expect(got.code).toBe(s.code);
      expect(got.name).toBe(s.name);
      expect(got.rank).toBe(s.rank);
      expect(got.calls).toBe(s.calls);
      expect(got.lat).toBeNull();
    });
  });

  it('looks up by code, case-insensitively and with padding', () => {
    const i = idx();
    expect(i.byCodeLookup(' sc ')?.name).toBe('Secunderabad Jn');
    expect(i.byCodeLookup('NDLS')?.code).toBe('NDLS');
    expect(i.byCodeLookup('ZZZZ')).toBeUndefined();
  });

  it('rejects an out-of-range station index', () => {
    const i = idx();
    expect(() => i.at(-1)).toThrow(RangeError);
    expect(() => i.at(i.count)).toThrow(RangeError);
  });

  it('offers the busiest stations when the query is empty', () => {
    const top = idx().popular(3).map((s) => s.code);
    expect(top).toEqual(['SC', 'HWH', 'NDLS']);
  });
});

describe('StationIndex.search', () => {
  const i = idx();

  it('matches a name prefix', () => {
    expect(i.search('secu').map((s) => s.code)).toEqual(['SC']);
  });

  it('matches a station code', () => {
    expect(i.search('ndls').map((s) => s.code)).toEqual(['NDLS']);
  });

  it('ranks a name prefix above a code prefix', () => {
    // 's' matches Secunderabad by NAME and SBC by CODE. Name prefix (band 2) must win
    // over code prefix (band 3) even though the ordering within a band is by traffic.
    expect(i.search('s').map((s) => s.code)).toEqual(['SC', 'SBC']);
  });

  it('breaks ties by train traffic, so big stations come first', () => {
    // Both are name-prefix matches for "h"; Howrah (388) outranks Hyderabad (96).
    const codes = i.search('h').map((s) => s.code);
    expect(codes.indexOf('HWH')).toBeLessThan(codes.indexOf('HYB'));
  });

  it('is case- and punctuation-insensitive', () => {
    expect(i.search('  new delhi ').map((s) => s.code)).toEqual(['NDLS']);
    expect(i.search('NEW DELHI').map((s) => s.code)).toEqual(['NDLS']);
  });

  it('returns an empty list rather than throwing for no match', () => {
    expect(i.search('zzzzzz')).toEqual([]);
  });

  it('respects the limit', () => {
    expect(i.search('', 2)).toHaveLength(2);
  });

  it('never returns the same station twice when both name and code match', () => {
    const codes = i.search('kacheguda').map((s) => s.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe('search ranking bands', () => {
  // Purpose-built fixture: one station per band, with traffic deliberately inverted so a
  // ranking that leaks traffic across bands fails loudly.
  const band = StationIndex.fromContainer(Container.parse(buildStationsContainer([
    { code: 'AB', name: 'Zoo Junction', rank: 1, calls: 5 },      // exact code
    { code: 'XY', name: 'Abc Nagar', rank: 1, calls: 10 },        // name prefix
    { code: 'ABC', name: 'Zebra Halt', rank: 0, calls: 900 },     // code prefix
    { code: 'ZZ', name: 'Unrelated', rank: 3, calls: 9999 },      // no match
  ]), ContainerKind.Stations));

  it('orders exact code > exact name > name prefix > code prefix', () => {
    expect(band.search('ab').map((s) => s.code)).toEqual(['AB', 'XY', 'ABC']);
  });

  it('never lets train traffic override a better band', () => {
    const codes = band.search('ab').map((s) => s.code);
    expect(codes.indexOf('ABC')).toBe(2);   // 900 calls, still last
    expect(codes).not.toContain('ZZ');      // 9999 calls, but no match at all
  });

  it('matches an exact name in full', () => {
    expect(band.search('unrelated').map((s) => s.code)).toEqual(['ZZ']);
  });
});

describe('StationIndex.attachGeo', () => {
  it('adds coordinates once the graph container arrives', () => {
    const i = idx();
    expect(i.hasGeo).toBe(false);
    // Build a graph container whose STATION_GEO section matches the station count.
    const g = Container.parse(buildGraphContainer([], SPECS.length, SPECS.map((_, n) => [10 + n, 70 + n])), ContainerKind.Graph);
    i.attachGeo(g);
    expect(i.hasGeo).toBe(true);
    expect(i.at(0).lat).toBeCloseTo(10, 4);
    expect(i.at(0).lon).toBeCloseTo(70, 4);
  });

  it('refuses a geo section that does not match the station count', () => {
    const i = idx();
    const g = Container.parse(buildGraphContainer([], 3), ContainerKind.Graph);
    expect(() => i.attachGeo(g)).toThrow(/entries for/);
  });
});

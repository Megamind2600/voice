import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContainerKind } from '../src/lib/binary';
import {
  cacheClear, cacheGet, cacheKeys, cachePut, loadDataset, loadManifest,
  type DatasetManifest,
} from '../src/state/cache';
import { buildStationsContainer } from './helpers';

const SPECS = [{ code: 'SC', name: 'Secunderabad Jn', rank: 3, calls: 412 }];
const HASH = 'a'.repeat(64);

let fetches: string[] = [];

function stubFetch(bodies: Record<string, ArrayBuffer | object>) {
  fetches = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    fetches.push(url);
    const body = bodies[url] ?? bodies[url.replace(/^\.\//, '')];
    if (body === undefined) {
      return { ok: false, status: 404, statusText: 'Not Found' } as Response;
    }
    if (body instanceof ArrayBuffer) {
      return {
        ok: true, status: 200, statusText: 'OK', headers: new Headers(),
        body: null, arrayBuffer: async () => body,
      } as unknown as Response;
    }
    return {
      ok: true, status: 200, statusText: 'OK', headers: new Headers(),
      body: null, json: async () => body,
    } as unknown as Response;
  }));
}

function manifestFor(hash: string): DatasetManifest {
  return {
    containerVersion: 1,
    counts: { stations: 1, trains: 0, connections: 0 },
    limits: {
      maxLegsPerTrain: 1, maxDurationMin: 60, maxDistanceKm: 100, stationIndexWidth: 'u16',
    },
    files: {
      'stations.bin': {
        bytes: 100, gzipBytes: 50, sha256: hash, sections: { STRINGS: 20, STATIONS: 12 },
      },
    },
  };
}

beforeEach(async () => { await cacheClear(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('cachePut / cacheGet', () => {
  it('round-trips an ArrayBuffer through IndexedDB', async () => {
    const buf = buildStationsContainer(SPECS);
    await cachePut({ key: 'k', hash: HASH, savedAt: 1, buf });
    const got = await cacheGet('k');
    expect(got?.hash).toBe(HASH);
    expect(got?.buf.byteLength).toBe(buf.byteLength);
  });

  it('returns null for a key that was never written', async () => {
    expect(await cacheGet('nope')).toBeNull();
  });

  it('lists keys', async () => {
    const buf = buildStationsContainer(SPECS);
    await cachePut({ key: 'a', hash: HASH, savedAt: 1, buf });
    await cachePut({ key: 'b', hash: HASH, savedAt: 1, buf });
    expect((await cacheKeys()).sort()).toEqual(['a', 'b']);
  });
});

describe('loadDataset', () => {
  it('fetches, parses, and populates the cache on a cold start', async () => {
    const buf = buildStationsContainer(SPECS);
    stubFetch({ 'stations.bin': buf });

    const r = await loadDataset('stations.bin', ContainerKind.Stations, {
      base: '', manifest: manifestFor(HASH),
    });
    expect(r.source).toBe('network');
    expect(r.container.info.kind).toBe(ContainerKind.Stations);
    expect(fetches).toEqual(['stations.bin']);
    expect((await cacheGet('stations.bin'))?.hash).toBe(HASH);
  });

  it('serves a warm cache without touching the network', async () => {
    const buf = buildStationsContainer(SPECS);
    await cachePut({ key: 'stations.bin', hash: HASH, savedAt: 1, buf });
    stubFetch({ 'stations.bin': buf });

    const r = await loadDataset('stations.bin', ContainerKind.Stations, {
      base: '', manifest: manifestFor(HASH),
    });
    expect(r.source).toBe('cache');
    expect(fetches).toEqual([]);          // the whole point of the 300 ms budget
  });

  it('invalidates on a hash change and re-fetches', async () => {
    const buf = buildStationsContainer(SPECS);
    await cachePut({ key: 'stations.bin', hash: 'old'.padEnd(64, '0'), savedAt: 1, buf });
    stubFetch({ 'stations.bin': buf });

    const r = await loadDataset('stations.bin', ContainerKind.Stations, {
      base: '', manifest: manifestFor(HASH),
    });
    expect(r.source).toBe('network');
    expect(fetches).toEqual(['stations.bin']);
    expect((await cacheGet('stations.bin'))?.hash).toBe(HASH);
  });

  it('does NOT trust the cache when the manifest is unavailable', async () => {
    // Without a hash there is no way to know whether the cached graph is current, and a
    // stale timetable silently produces itineraries that no longer run. Slow is safe.
    const buf = buildStationsContainer(SPECS);
    await cachePut({ key: 'stations.bin', hash: HASH, savedAt: 1, buf });
    stubFetch({ 'stations.bin': buf });

    const r = await loadDataset('stations.bin', ContainerKind.Stations, { base: '', manifest: null });
    expect(r.source).toBe('network');
    expect(fetches).toEqual(['stations.bin']);
  });

  it('survives a corrupt cache entry by falling back to the network', async () => {
    const buf = buildStationsContainer(SPECS);
    await cachePut({
      key: 'stations.bin', hash: HASH, savedAt: 1,
      buf: new TextEncoder().encode('not an RRLM container').buffer,
    });
    stubFetch({ 'stations.bin': buf });

    const r = await loadDataset('stations.bin', ContainerKind.Stations, {
      base: '', manifest: manifestFor(HASH),
    });
    expect(r.source).toBe('network');
    expect(r.container.info.kind).toBe(ContainerKind.Stations);
  });

  it('reports the container error, not a generic failure, when the kind is wrong', async () => {
    const buf = buildStationsContainer(SPECS);
    stubFetch({ 'stations.bin': buf });
    await expect(loadDataset('stations.bin', ContainerKind.Graph, { base: '', manifest: null }))
      .rejects.toThrow(/expected container kind/);
  });

  it('propagates an HTTP error', async () => {
    stubFetch({});
    await expect(loadDataset('graph.bin', ContainerKind.Graph, { base: '', manifest: null }))
      .rejects.toThrow(/HTTP 404/);
  });
});

describe('loadManifest', () => {
  it('parses a valid manifest', async () => {
    stubFetch({ './data/manifest.json': manifestFor(HASH) });
    const m = await loadManifest();
    expect(m?.files['stations.bin'].sha256).toBe(HASH);
  });

  it('returns null instead of throwing when the manifest is missing', async () => {
    stubFetch({});
    expect(await loadManifest()).toBeNull();
  });
});

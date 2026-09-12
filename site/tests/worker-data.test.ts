/**
 * worker-data.test.ts — the worker must fetch the dataset from page-resolved URLs.
 *
 * Regression test for the \"search gives a graph error\" failure: the worker used to fetch
 * `./data/graph.bin` relative to its own script URL (`/src/worker/` in dev, `/assets/` in
 * a build), received the host's HTML fallback page instead of the dataset, and failed
 * every search with a container error — while main-thread autocomplete kept working.
 *
 * These tests pin the contract that fixes it: the main thread hands the worker absolute
 * URLs (`DataLocation`), the client attaches them to every request, and the worker loads
 * from them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cacheClear } from '../src/state/cache';
import { dataBaseUrl, dataLocation } from '../src/state/cache';
import { RouterClient } from '../src/state/client';
import { dataSource, handle, reset } from '../src/worker/handlers';
import { buildGraphContainer } from './helpers';

const BASE = 'https://app.example/rail/data/';
const MANIFEST_URL = `${BASE}manifest.json`;
const GRAPH_URL = `${BASE}graph.bin`;
const HASH = 'b'.repeat(64);

function manifest(): object {
  return {
    containerVersion: 1,
    counts: { stations: 2, trains: 1, connections: 1 },
    limits: {
      maxLegsPerTrain: 1, maxDurationMin: 60, maxDistanceKm: 100, stationIndexWidth: 'u16',
    },
    files: {
      'graph.bin': { bytes: 100, gzipBytes: 50, sha256: HASH, sections: {} },
    },
  };
}

function tinyGraph(): ArrayBuffer {
  return buildGraphContainer(
    [{
      number: '12951', name: 'Test Express', stops: [0, 1],
      legs: [[0, 60, 100]], durationMin: 60, distanceKm: 100, originDepMin: 360,
    }],
    2,
    [[19.0, 72.8], [28.6, 77.2]],
  );
}

let fetches: string[] = [];

function stubFetch(): void {
  fetches = [];
  const graph = tinyGraph();
  const man = manifest();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    fetches.push(String(url));
    if (String(url) === MANIFEST_URL) {
      return {
        ok: true, status: 200, statusText: 'OK', headers: new Headers(), body: null,
        json: async () => man,
      } as unknown as Response;
    }
    if (String(url) === GRAPH_URL) {
      return {
        ok: true, status: 200, statusText: 'OK', headers: new Headers(), body: null,
        arrayBuffer: async () => graph.slice(0),
      } as unknown as Response;
    }
    return { ok: false, status: 404, statusText: 'Not Found' } as Response;
  }));
}

beforeEach(async () => { reset(); await cacheClear(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('dataBaseUrl / dataLocation', () => {
  it('resolves to an absolute URL under the page, ending in /data/', () => {
    const base = dataBaseUrl();
    expect(base).toMatch(/^https?:\/\//);
    expect(base.endsWith('/data/')).toBe(true);
  });

  it('builds the manifest URL from the same base', () => {
    const loc = dataLocation();
    expect(loc.manifestUrl).toBe(`${loc.base}manifest.json`);
  });
});

describe('worker dataset location', () => {
  it('loads the graph from the absolute URLs the request carries', async () => {
    stubFetch();
    const res = await handle({
      id: 1, type: 'graph:load', data: { manifestUrl: MANIFEST_URL, base: BASE },
    });
    expect(res.ok).toBe(true);
    if (!res.ok || res.type !== 'graph:loaded') throw new Error('unreachable');
    expect(res.stats.trains).toBe(1);
    expect(res.stats.connections).toBe(1);
    // The worker must have fetched exactly the provided URLs — never a relative path
    // resolved against its own script location.
    expect(fetches).toEqual([MANIFEST_URL, GRAPH_URL]);
    expect(dataSource()).toEqual({ manifestUrl: MANIFEST_URL, base: BASE });
  });

  it('remembers the location for later requests that carry none', async () => {
    stubFetch();
    await handle({ id: 1, type: 'graph:load', data: { manifestUrl: MANIFEST_URL, base: BASE } });
    fetches = [];
    // The graph is already in memory, so this must not fetch at all — but even if it did,
    // the stored absolute base would apply, not the relative default.
    const res = await handle({ id: 2, type: 'graph:stats' });
    expect(res.ok).toBe(true);
    expect(fetches).toEqual([]);
    expect(dataSource()).toEqual({ manifestUrl: MANIFEST_URL, base: BASE });
  });

  it('names the source URL when the fetched bytes are not a dataset', async () => {
    // Simulates the old failure mode reaching the new code: HTML served with HTTP 200.
    fetches = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      fetches.push(String(url));
      return {
        ok: true, status: 200, statusText: 'OK', headers: new Headers(), body: null,
        arrayBuffer: async () => new TextEncoder().encode('<!doctype html>').buffer,
        json: async () => { throw new Error('not json'); },
      } as unknown as Response;
    }));
    const res = await handle({
      id: 1, type: 'graph:load', data: { manifestUrl: MANIFEST_URL, base: BASE },
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error).toContain(GRAPH_URL);
  });

  it('falls back to the relative defaults when no location was ever provided', () => {
    expect(dataSource()).toEqual({ manifestUrl: './data/manifest.json', base: './data/' });
  });
});

describe('RouterClient data location', () => {
  it('attaches the configured location to worker requests', async () => {
    stubFetch();
    // jsdom has no Worker implementation, so the client takes its inline (main-thread)
    // fallback — which dispatches into the same handlers, so the fetched URLs prove the
    // location was attached.
    const client = new RouterClient(5_000);
    client.setDataLocation({ manifestUrl: MANIFEST_URL, base: BASE });
    await client.start();
    const res = await client.request({ type: 'graph:load' });
    expect(res.type).toBe('graph:loaded');
    expect(fetches).toEqual([MANIFEST_URL, GRAPH_URL]);
    client.terminate();
  });
});

/**
 * cache.ts — IndexedDB cache for the packed dataset.
 *
 * Phase 0 acceptance criterion: a repeat visit renders in under 300 ms without touching
 * the network. The dataset is ~850 KB gzipped, so on a cold connection the download
 * dominates; serving it from IndexedDB removes that entirely.
 *
 * Invalidation is by content hash from manifest.json, never by TTL. The manifest is ~1 KB
 * and HTTP-cacheable, so checking it costs one small request and guarantees a stale graph
 * can never be served after a harvest — which matters more than saving a request, because
 * a stale timetable silently produces itineraries that no longer exist.
 *
 * Everything here degrades: if IndexedDB is unavailable (Safari private mode, disabled
 * storage, quota errors) the loader falls through to a plain fetch and the app still
 * works, just slower.
 */

import { Container, ContainerKind } from '../lib/binary';

export const DB_NAME = 'kahan-chalein';
export const DB_VERSION = 1;
export const STORE = 'datasets';

/**
 * Shape of site/public/data/manifest.json, written by harvester/pack_binary.py.
 *
 * `limits` records the largest value each u16 field had to hold. It is the tripwire for
 * format overflow: if a future harvest pushes the network past 65,535 stations, trains or
 * legs, the packer must widen the record layout, and a test asserting against these values
 * fails long before a browser silently truncates one.
 */
export interface DatasetManifest {
  containerVersion: number;
  source?: string;
  sourceLicence?: string;
  schemaVersion?: string;
  bootstrap?: boolean;
  bootstrapLabel?: string;
  counts: { stations: number; trains: number; connections: number };
  limits: {
    maxLegsPerTrain: number;
    maxDurationMin: number;
    maxDistanceKm: number;
    stationIndexWidth: string;
  };
  layout?: Record<string, unknown>;
  files: Record<string, {
    bytes: number;
    gzipBytes: number;
    sha256: string;
    sections: Record<string, number>;
  }>;
}

export type LoadSource = 'cache' | 'network';

/**
 * Absolute URL of the directory holding manifest.json and the .bin files.
 *
 * ---------------------------------------------------------------------------
 * WHY ABSOLUTE, AND WHY RESOLVED AGAINST THE PAGE
 * ---------------------------------------------------------------------------
 * The routing worker fetches graph.bin itself, and inside a Web Worker a relative URL
 * resolves against the WORKER SCRIPT's URL, not the page: `/src/worker/data/graph.bin`
 * under `vite dev`, `/assets/data/graph.bin` in a production build. Both 404 (or, worse,
 * return the SPA fallback HTML with HTTP 200), so every search failed with a container
 * error while autocomplete — loaded on the main thread, where the base is the page —
 * kept working. That asymmetry is exactly the \"search gives a graph error\" failure mode.
 *
 * Resolving once, here, against `document.baseURI` (the page) plus Vite's BASE_URL (the
 * `/<repo>/` mount point on GitHub Pages) produces an absolute URL that fetches the same
 * bytes from either thread. The main thread passes it to the worker with every request
 * (see `RouterClient.setDataLocation`), so the worker never resolves a relative URL at
 * all. Callers without a document (the worker itself, node tools) fall back to the
 * relative path, which preserves the old behaviour wherever no page exists to resolve
 * against.
 */
export function dataBaseUrl(): string {
  const configured = import.meta.env.BASE_URL ?? './';
  const dir = configured.endsWith('/') ? `${configured}data/` : `${configured}/data/`;
  try {
    if (typeof document !== 'undefined' && document.baseURI) {
      return new URL(dir, document.baseURI).href;
    }
  } catch {
    // A document with an unparseable baseURI: fall through to the relative path.
  }
  return dir;
}

/** Absolute manifest + dataset-directory URLs, ready to hand to the worker. */
export function dataLocation(): { manifestUrl: string; base: string } {
  const base = dataBaseUrl();
  return { manifestUrl: `${base}manifest.json`, base };
}

export interface LoadedContainer {
  container: Container;
  source: LoadSource;
  /** Milliseconds for this load, measured from entry to a parsed Container. */
  ms: number;
  bytes: number;
}

interface Entry {
  key: string;
  hash: string;
  savedAt: number;
  buf: ArrayBuffer;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') { resolve(null); return; }
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    // A blocked or failing open must never wedge the app.
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return openDb().then((db) => new Promise<T | null>((resolve) => {
    if (!db) { resolve(null); return; }
    let transaction: IDBTransaction;
    try {
      transaction = db.transaction(STORE, mode);
    } catch {
      resolve(null);
      return;
    }
    const req = fn(transaction.objectStore(STORE));
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => resolve(null);
    transaction.onabort = () => resolve(null);
  }));
}

export async function cacheGet(key: string): Promise<Entry | null> {
  // IndexedDB resolves a miss to `undefined`, but this function promises `Entry | null`.
  // Normalising here keeps callers from having to handle three states.
  const hit = await tx<Entry>('readonly', (s) => s.get(key) as IDBRequest<Entry>);
  return hit ?? null;
}

export async function cachePut(entry: Entry): Promise<boolean> {
  const ok = await tx<IDBValidKey>('readwrite', (s) => s.put(entry));
  return ok !== null;
}

export async function cacheClear(): Promise<void> {
  await tx('readwrite', (s) => s.clear());
}

export async function cacheKeys(): Promise<string[]> {
  const keys = await tx<IDBValidKey[]>('readonly', (s) => s.getAllKeys() as IDBRequest<IDBValidKey[]>);
  return (keys ?? []).map(String);
}

/** Read manifest.json (tiny, HTTP-cached) to learn the current content hash per file. */
export async function loadManifest(url = './data/manifest.json'): Promise<DatasetManifest | null> {
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) return null;
    return (await res.json()) as DatasetManifest;
  } catch {
    return null;
  }
}

export interface LoadOptions {
  /** Directory holding the .bin files; default matches the Vite public/ layout. */
  base?: string;
  manifest?: DatasetManifest | null;
  signal?: AbortSignal;
  onProgress?: (file: string, loaded: number, total: number) => void;
}

/**
 * Load one container, preferring IndexedDB when the manifest hash matches.
 *
 * When the manifest is unavailable we cannot verify freshness, so we deliberately do NOT
 * fall back to the cache: serving a graph we cannot date is worse than a slow load.
 */
export async function loadDataset(
  file: 'stations.bin' | 'graph.bin',
  kind: ContainerKind,
  opts: LoadOptions = {},
): Promise<LoadedContainer> {
  const t0 = performance.now();
  const base = opts.base ?? './data/';
  const url = base + file;
  const expected = opts.manifest?.files?.[file]?.sha256;

  if (expected) {
    const hit = await cacheGet(url);
    if (hit && hit.hash === expected) {
      try {
        const container = Container.parse(hit.buf.slice(0), kind);
        return {
          container, source: 'cache', ms: performance.now() - t0, bytes: hit.buf.byteLength,
        };
      } catch {
        // Corrupt cache entry: fall through to the network and overwrite it.
      }
    }
  }

  const buf = await fetchBytes(url, opts.signal, (loaded, total) => {
    opts.onProgress?.(file, loaded, total);
  });
  const container = Container.parse(buf.slice(0), kind);
  if (expected) {
    void cachePut({ key: url, hash: expected, savedAt: Date.now(), buf });
  }
  return { container, source: 'network', ms: performance.now() - t0, bytes: buf.byteLength };
}

/**
 * Fetch with progress. Falls back to a plain arrayBuffer() when the response has no
 * Content-Length (which is the case for chunked or compressed-without-length responses).
 */
async function fetchBytes(
  url: string,
  signal?: AbortSignal,
  onProgress?: (loaded: number, total: number) => void,
): Promise<ArrayBuffer> {
  const res = await fetch(url, signal ? { signal } : undefined);
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);

  const total = Number(res.headers.get('Content-Length') ?? 0);
  if (!res.body || !total || !onProgress) return res.arrayBuffer();

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress(loaded, total);
  }
  const out = new Uint8Array(loaded);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out.buffer;
}

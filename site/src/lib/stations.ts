/**
 * stations.ts — the station index behind autocomplete.
 *
 * This is deliberately the ONLY thing needed for first paint. It parses stations.bin
 * (~76 KB gzipped) and can answer a query before graph.bin has finished downloading,
 * which is the Phase 0 acceptance criterion.
 *
 * Search is prefix-based over a sorted key array, so cost is O(log n + k) rather than a
 * linear scan of 7,219 names on every keystroke. Results are ordered by how many trains
 * actually call at the station, so typing "s" surfaces Secunderabad rather than a halt
 * in a field somewhere.
 */

import {
  Container, ContainerKind, SectionId, STATION_SIZE, readCString,
} from './binary';

export interface Station {
  /** Position in the packed array — the index every train/connection references. */
  readonly i: number;
  readonly code: string;
  readonly name: string;
  /** 0 halt · 1 intermediate · 2 junction · 3 metro */
  readonly rank: number;
  /** Number of trains that stop here. */
  readonly calls: number;
  readonly lat: number | null;
  readonly lon: number | null;
}

export const RANK_LABEL = ['halt', 'intermediate', 'junction', 'metro'] as const;

/**
 * Fold a name for matching: uppercase, drop punctuation, collapse runs of space.
 * Kept intentionally simple — the CC0 names are ASCII, and adding Devanagari folding
 * before there is Devanagari data would be untestable guesswork.
 */
export function normalise(s: string): string {
  let out = '';
  let lastSpace = true;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 48 && c <= 57)) {
      out += s[i];
      lastSpace = false;
    } else if (c >= 97 && c <= 122) {
      out += String.fromCharCode(c - 32);
      lastSpace = false;
    } else if (!lastSpace) {
      out += ' ';
      lastSpace = true;
    }
  }
  return lastSpace ? out.slice(0, -1) : out;
}

export class StationIndex {
  readonly count: number;
  readonly isBootstrap: boolean;

  private readonly codes: string[];
  private readonly names: string[];
  private readonly keys: string[];
  private readonly rank: Uint8Array;
  private readonly calls: Uint16Array;
  private lat: Float32Array | null = null;
  private lon: Float32Array | null = null;

  /** station index -> position in `order` (the array sorted by search key). */
  private readonly order: Int32Array;
  private readonly sortedKeys: string[];
  private readonly byCode = new Map<string, number>();
  /** Default suggestions when the query is empty: busiest stations first. */
  private readonly byTraffic: Int32Array;

  private constructor(
    count: number,
    isBootstrap: boolean,
    codes: string[],
    names: string[],
    keys: string[],
    rank: Uint8Array,
    calls: Uint16Array,
  ) {
    this.count = count;
    this.isBootstrap = isBootstrap;
    this.codes = codes;
    this.names = names;
    this.keys = keys;
    this.rank = rank;
    this.calls = calls;

    const order = new Int32Array(count);
    for (let i = 0; i < count; i++) order[i] = i;
    // Sort by (key, code) so equal keys have a deterministic, binary-searchable order.
    const idx = Array.from(order).sort((a, b) =>
      keys[a] < keys[b] ? -1 : keys[a] > keys[b] ? 1 : (codes[a] < codes[b] ? -1 : 1));
    this.order = Int32Array.from(idx);
    this.sortedKeys = idx.map((i) => keys[i]);

    const traffic = Array.from({ length: count }, (_, i) => i)
      .sort((a, b) => calls[b] - calls[a] || names[a].localeCompare(names[b]));
    this.byTraffic = Int32Array.from(traffic);

    for (let i = 0; i < count; i++) this.byCode.set(codes[i], i);
  }

  /** Parse stations.bin. */
  static fromContainer(c: Container): StationIndex {
    if (c.info.kind !== ContainerKind.Stations) {
      throw new Error(`expected a stations container, got kind ${c.info.kind}`);
    }
    const strings = c.strings();
    const rec = c.bytes(SectionId.Stations);
    const meta = c.section(SectionId.Stations);
    if (meta.itemSize !== STATION_SIZE) {
      throw new Error(`station records are ${meta.itemSize} B, expected ${STATION_SIZE} B`);
    }
    const dv = new DataView(c.buffer, rec.byteOffset, rec.byteLength);

    const n = meta.count;
    const codes: string[] = new Array(n);
    const names: string[] = new Array(n);
    const keys: string[] = new Array(n);
    const rank = new Uint8Array(n);
    const calls = new Uint16Array(n);

    for (let i = 0; i < n; i++) {
      const at = i * STATION_SIZE;
      // code[5] | nameOff u32 | rank u8 | calls u16
      let code = '';
      for (let b = 0; b < 5; b++) {
        const ch = dv.getUint8(at + b);
        if (ch !== 0x20 && ch !== 0) code += String.fromCharCode(ch);
      }
      const nameOff = dv.getUint32(at + 5, true);
      codes[i] = code;
      names[i] = readCString(strings, nameOff);
      keys[i] = normalise(names[i]);
      rank[i] = dv.getUint8(at + 9);
      calls[i] = dv.getUint16(at + 10, true);
    }
    return new StationIndex(n, c.isBootstrap, codes, names, keys, rank, calls);
  }

  /**
   * Attach coordinates from graph.bin's STATION_GEO section. Autocomplete does not need
   * them; maps, direction preference and "places to explore" do — all of which arrive
   * after the graph, which is why they are not in stations.bin.
   */
  attachGeo(graph: Container): void {
    if (!graph.has(SectionId.StationGeo)) return;
    const f = graph.f32(SectionId.StationGeo);
    if (f.length !== this.count * 2) {
      throw new Error(`geo section has ${f.length / 2} entries for ${this.count} stations`);
    }
    this.lat = new Float32Array(this.count);
    this.lon = new Float32Array(this.count);
    for (let i = 0; i < this.count; i++) {
      this.lat[i] = f[i * 2];
      this.lon[i] = f[i * 2 + 1];
    }
  }

  get hasGeo(): boolean {
    return this.lat !== null;
  }

  at(i: number): Station {
    if (i < 0 || i >= this.count) throw new RangeError(`station index ${i} out of range`);
    return {
      i,
      code: this.codes[i],
      name: this.names[i],
      rank: this.rank[i],
      calls: this.calls[i],
      lat: this.lat ? this.lat[i] : null,
      lon: this.lon ? this.lon[i] : null,
    };
  }

  byCodeLookup(code: string): Station | undefined {
    const i = this.byCode.get(code.trim().toUpperCase());
    return i === undefined ? undefined : this.at(i);
  }

  indexOfCode(code: string): number {
    return this.byCode.get(code.trim().toUpperCase()) ?? -1;
  }

  /** Busiest stations — used as the default suggestion list before the user types. */
  popular(limit = 8): Station[] {
    const out: Station[] = [];
    for (let k = 0; k < limit && k < this.byTraffic.length; k++) out.push(this.at(this.byTraffic[k]));
    return out;
  }

  private lowerBound(key: string): number {
    let lo = 0;
    let hi = this.sortedKeys.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.sortedKeys[mid] < key) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * Prefix search over name and code.
   *
   * Ranking: exact code match first, then exact name match, then name prefix (longer
   * queries first), then code prefix, and within each band by train traffic so the
   * stations a user is most likely to mean come out on top.
   */
  search(rawQuery: string, limit = 8): Station[] {
    const q = normalise(rawQuery);
    if (!q) return this.popular(limit);

    const qCode = rawQuery.trim().toUpperCase();
    const hits: number[] = [];
    const seen = new Set<number>();

    // 1. name-prefix range from the sorted key array
    const start = this.lowerBound(q);
    for (let p = start; p < this.sortedKeys.length; p++) {
      const key = this.sortedKeys[p];
      if (!key.startsWith(q)) break;
      const i = this.order[p];
      if (!seen.has(i)) { seen.add(i); hits.push(i); }
    }

    // 2. code prefix — codes are short, and 7k comparisons is ~0.1 ms, so a scan is
    //    simpler and just as fast as maintaining a second sorted array.
    const isCodeish = qCode.length >= 1 && qCode.length <= 5 && /^[A-Z]+$/.test(qCode);
    if (isCodeish) {
      for (let i = 0; i < this.count; i++) {
        if (this.codes[i].startsWith(qCode) && !seen.has(i)) { seen.add(i); hits.push(i); }
      }
    }

    const score = (i: number): number => {
      const code = this.codes[i];
      const key = this.keys[i];
      if (code === qCode) return 0;
      if (key === q) return 1;
      if (key.startsWith(q)) return 2;
      if (code.startsWith(qCode)) return 3;
      return 4;
    };

    hits.sort((a, b) => {
      const d = score(a) - score(b);
      if (d !== 0) return d;
      return this.calls[b] - this.calls[a] || this.names[a].localeCompare(this.names[b]);
    });

    return hits.slice(0, limit).map((i) => this.at(i));
  }
}

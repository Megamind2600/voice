/**
 * helpers.ts — build tiny synthetic RRLM containers in memory.
 *
 * The record layouts here are a THIRD independent implementation of the format, after
 * pack_binary.py (writer) and binary.ts (reader). That is deliberate: if all three agree,
 * the format is almost certainly what the docstring says it is, and a change to any one of
 * them breaks a test instead of breaking production.
 */
import {
  HEADER_SIZE, DIRECTORY_ENTRY_SIZE, STATION_SIZE, TRAIN_WORDS, CONN_HALFWORDS,
} from '../src/lib/binary';

const HDR = new DataView(new ArrayBuffer(32));

export interface Spec {
  code: string;
  name: string;
  rank?: number;
  calls?: number;
  lat?: number;
  lon?: number;
}

export function buildStationsContainer(specsIn: Spec[], flags = 4): ArrayBuffer {
  // pack_binary.py emits stations sorted by code; replicate that exactly, because the
  // station INDEX is positional and tests that assume spec order would silently pass
  // against a reader that disagrees with the real packer.
  const specs = [...specsIn].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

  // STRINGS
  const enc = new TextEncoder();
  const strParts: Uint8Array[] = [];
  const offs: number[] = [];
  let len = 0;
  for (const s of specs) {
    offs.push(len);
    const b = enc.encode(s.name + '\0');
    strParts.push(b);
    len += b.length;
  }
  const strings = concat(strParts, len);

  // STATIONS: code[5] | nameOff u32 | rank u8 | calls u16
  const st = new Uint8Array(specs.length * STATION_SIZE);
  const sdv = new DataView(st.buffer);
  specs.forEach((s, i) => {
    const at = i * STATION_SIZE;
    for (let b = 0; b < 5; b++) {
      st[at + b] = b < s.code.length ? s.code.charCodeAt(b) : 0x20;
    }
    sdv.setUint32(at + 5, offs[i], true);
    sdv.setUint8(at + 9, s.rank ?? 0);
    sdv.setUint16(at + 10, s.calls ?? 0, true);
  });

  return assemble(1, [
    { id: 1, data: strings, count: strings.length, itemSize: 1 },
    { id: 2, data: st, count: specs.length, itemSize: STATION_SIZE },
  ], flags);
}

export interface TrainSpec {
  number: string;
  name: string;
  type?: number;
  classes?: number;
  runsDays?: number;
  flags?: number;
  durationMin?: number;
  distanceKm?: number;
  /** Wall-clock origin departure, minutes since midnight IST. */
  originDepMin?: number;
  /** station indices in route order; legs are derived from consecutive pairs */
  stops: number[];
  /** per-leg [depMin, arrMin, distKm]; must be stops.length - 1 entries */
  legs: Array<[number, number, number]>;
}

export function buildGraphContainer(
  trainsIn: TrainSpec[],
  stationCount: number,
  geo?: Array<[number, number]>,
  flags = 4,
): ArrayBuffer {
  // Same fidelity rule: the packer sorts trains by number, and connStart depends on that
  // order, so the helper must too.
  const trains = [...trainsIn].sort((a, b) =>
    (a.number < b.number ? -1 : a.number > b.number ? 1 : 0));

  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  let len = 0;
  const intern = (s: string): number => {
    const off = len;
    const b = enc.encode(s + '\0');
    parts.push(b);
    len += b.length;
    return off;
  };

  const words = new Uint32Array(trains.length * TRAIN_WORDS);
  const conns: number[] = [];
  let connStart = 0;
  trains.forEach((t, i) => {
    const nameOff = intern(t.name);
    const numberOff = intern(t.number);
    const b = i * TRAIN_WORDS;
    words[b] = nameOff;
    words[b + 1] = numberOff;
    words[b + 2] = connStart;
    words[b + 3] = (t.legs.length & 0xffff) | ((t.durationMin ?? 0) << 16);
    words[b + 4] = ((t.distanceKm ?? 0) & 0xffff) | ((t.stops[0] & 0xffff) << 16);
    words[b + 5] = (t.stops[t.stops.length - 1] & 0xffff) | ((t.classes ?? 0) << 16);
    words[b + 6] = (t.originDepMin ?? 0) & 0xffff;
    words[b + 7] = (t.type ?? 0) | ((t.runsDays ?? 127) << 8) | ((t.flags ?? flags) << 16);
    for (let k = 0; k < t.legs.length; k++) {
      const [dep, arr, km] = t.legs[k];
      conns.push(dep, arr, t.stops[k], t.stops[k + 1], km);
    }
    connStart += t.legs.length;
  });
  const strings = concat(parts, len);
  const connBytes = new Uint16Array(conns);

  const sections = [
    { id: 1, data: strings, count: strings.length, itemSize: 1 },
    {
      id: 5,
      data: new Float32Array((geo ?? Array.from({ length: stationCount }, () => [0, 0] as [number, number])).flat()).slice().buffer as ArrayBuffer,
      count: stationCount,
      itemSize: 8,
    },
    { id: 3, data: words.buffer as ArrayBuffer, count: trains.length, itemSize: TRAIN_WORDS * 4 },
    { id: 4, data: connBytes.buffer as ArrayBuffer, count: connStart, itemSize: CONN_HALFWORDS * 2 },
  ].map((s) => ({ ...s, data: new Uint8Array(s.data) }));

  return assemble(2, sections, flags);
}

/**
 * Bytes needed to reach the next 4-byte boundary.
 *
 * Written longhand rather than as `(-len) % 4`: that idiom is correct in Python, whose %
 * takes the sign of the divisor, but in JavaScript `%` keeps the sign of the dividend, so
 * `(-103) % 4` is -3 and the "padding" silently SHRINKS the buffer, making the next
 * section overlap the previous one. That exact bug is what this test suite caught.
 */
export function padTo4(len: number): number {
  const r = len % 4;
  return r === 0 ? 0 : 4 - r;
}

function concat(parts: Uint8Array[], len: number): Uint8Array {
  const out = new Uint8Array(len);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

function assemble(
  kind: number,
  sections: Array<{ id: number; data: Uint8Array; count: number; itemSize: number }>,
  flags: number,
): ArrayBuffer {
  const dirLen = sections.length * DIRECTORY_ENTRY_SIZE;
  const payloadStart = (HEADER_SIZE + dirLen + 3) & ~3;
  let total = payloadStart;
  for (const s of sections) total += s.data.length + padTo4(s.data.length);

  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  dv.setUint8(0, 0x52); dv.setUint8(1, 0x52); dv.setUint8(2, 0x4c); dv.setUint8(3, 0x4d);
  dv.setUint16(4, 1, true);
  dv.setUint8(6, kind);
  dv.setUint8(7, flags);
  dv.setUint16(8, sections.length, true);
  dv.setUint32(10, total - payloadStart, true);
  void HDR;

  let cursor = payloadStart;
  const u8 = new Uint8Array(buf);
  sections.forEach((s, i) => {
    const at = HEADER_SIZE + i * DIRECTORY_ENTRY_SIZE;
    dv.setUint16(at, s.id, true);
    dv.setUint32(at + 4, cursor, true);
    dv.setUint32(at + 8, s.data.length, true);
    dv.setUint32(at + 12, s.count, true);
    dv.setUint16(at + 16, s.itemSize, true);
    u8.set(s.data, cursor);
    cursor += s.data.length + padTo4(s.data.length);
  });
  return buf;
}

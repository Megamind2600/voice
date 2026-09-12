/**
 * binary.ts — reader for the RRLM container produced by harvester/pack_binary.py.
 *
 * The layout here MUST stay in lockstep with the Python packer; `harvester/validate/
 * integrity.py --bin` round-trips every record in both directions in CI, so a drift
 * fails the build rather than serving garbage.
 *
 * Design notes
 * ------------
 * Every section is 4-byte aligned by the packer, so views are created directly over the
 * response ArrayBuffer with no copy and no re-alignment. Record layouts were chosen so
 * each maps onto a single primitive typed array:
 *
 *   STATION_GEO   8 B  -> Float32Array, 2 per station
 *   TRAIN        32 B  -> Uint32Array,  8 words per train
 *   CONNECTION   10 B  -> Uint16Array,  5 halfwords per connection
 *
 * STATION is the exception: its 12 B record packs a 5-byte ASCII code, so it is read
 * through a DataView. That happens once per station at load (7,219 reads), not in a hot
 * loop, so the DataView cost is irrelevant.
 */

export const MAGIC = 'RRLM';
export const CONTAINER_VERSION = 1;

export const enum ContainerKind {
  Stations = 1,
  Graph = 2,
}

export const enum SectionId {
  Strings = 1,
  Stations = 2,
  Trains = 3,
  Connections = 4,
  StationGeo = 5,
}

/** Container-level flags (header byte 7). */
export const enum ContainerFlag {
  ClassesInferred = 1,
  RunsDaysAssumed = 2,
  /** Dataset predates NTES — the UI must label it "BOOTSTRAP · 2016". */
  Bootstrap = 4,
}

export const HEADER_SIZE = 32;
export const DIRECTORY_ENTRY_SIZE = 20;

export const STATION_SIZE = 12;
export const GEO_SIZE = 8;
export const TRAIN_WORDS = 8;
export const CONN_HALFWORDS = 5;

export interface SectionMeta {
  readonly id: number;
  readonly offset: number;
  readonly length: number;
  readonly count: number;
  readonly itemSize: number;
}

export interface ContainerInfo {
  readonly version: number;
  readonly kind: ContainerKind;
  readonly flags: number;
  readonly payloadLength: number;
  readonly contentHash: string;
  readonly sections: ReadonlyMap<number, SectionMeta>;
}

export class ContainerError extends Error {
  override name = 'ContainerError';
}

const decoder = new TextDecoder('utf-8');

/** Read a NUL-terminated string, with an ASCII fast path (station names are ~99% ASCII). */
export function readCString(bytes: Uint8Array, offset: number): string {
  let end = offset;
  while (end < bytes.length && bytes[end] !== 0) end++;
  const len = end - offset;
  if (len === 0) return '';

  let out = '';
  for (let i = offset; i < end; i++) {
    const b = bytes[i];
    if (b > 0x7f) {
      return decoder.decode(bytes.subarray(offset, end));
    }
    out += String.fromCharCode(b);
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

/**
 * A parsed container. Cheap to construct: it only reads the 32-byte header and the
 * section directory, then hands back zero-copy views on demand.
 */
export class Container {
  readonly buffer: ArrayBuffer;
  readonly info: ContainerInfo;
  private readonly views = new Map<number, ArrayBufferView>();

  private constructor(buffer: ArrayBuffer, info: ContainerInfo) {
    this.buffer = buffer;
    this.info = info;
  }

  static parse(buffer: ArrayBuffer, expectKind?: ContainerKind): Container {
    if (buffer.byteLength < HEADER_SIZE) {
      throw new ContainerError(`file is only ${buffer.byteLength} bytes, too small for a header`);
    }
    const dv = new DataView(buffer);
    const magic = String.fromCharCode(
      dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3),
    );
    if (magic !== MAGIC) {
      throw new ContainerError(
        `bad magic ${JSON.stringify(magic)} — expected ${JSON.stringify(MAGIC)}. ` +
        `This is not an RRLM container (was the packed dataset regenerated?)`,
      );
    }

    const version = dv.getUint16(4, true);
    if (version !== CONTAINER_VERSION) {
      throw new ContainerError(
        `container version ${version} but this build understands ${CONTAINER_VERSION}`,
      );
    }

    const kind = dv.getUint8(6) as ContainerKind;
    const flags = dv.getUint8(7);
    const sectionCount = dv.getUint16(8, true);
    const payloadLength = dv.getUint32(10, true);
    const contentHash = toHex(new Uint8Array(buffer, 16, 16));

    if (expectKind !== undefined && kind !== expectKind) {
      throw new ContainerError(`expected container kind ${expectKind}, got ${kind}`);
    }

    const sections = new Map<number, SectionMeta>();
    for (let i = 0; i < sectionCount; i++) {
      const at = HEADER_SIZE + i * DIRECTORY_ENTRY_SIZE;
      if (at + DIRECTORY_ENTRY_SIZE > buffer.byteLength) {
        throw new ContainerError(`section directory truncated at entry ${i}`);
      }
      const id = dv.getUint16(at, true);
      const offset = dv.getUint32(at + 4, true);
      const length = dv.getUint32(at + 8, true);
      const count = dv.getUint32(at + 12, true);
      const itemSize = dv.getUint16(at + 16, true);
      if (offset + length > buffer.byteLength) {
        throw new ContainerError(
          `section ${id} claims ${offset}+${length} but the file is ${buffer.byteLength} bytes`,
        );
      }
      if (itemSize > 0 && count * itemSize !== length) {
        throw new ContainerError(
          `section ${id} count*itemSize (${count}*${itemSize}) != length (${length})`,
        );
      }
      if (offset % 4 !== 0) {
        // Not fatal for DataView reads, but it would force a copy for typed-array views.
        throw new ContainerError(`section ${id} at offset ${offset} is not 4-byte aligned`);
      }
      sections.set(id, { id, offset, length, count, itemSize });
    }

    if (HEADER_SIZE + sectionCount * DIRECTORY_ENTRY_SIZE + payloadLength > buffer.byteLength + 3) {
      throw new ContainerError('declared payload length exceeds the file size');
    }

    // Sections must not overlap. This is not a theoretical concern: the per-section
    // alignment and count*itemSize checks above both pass on a file where the padding was
    // computed with a negative modulo, yet the later section overwrites the tail of the
    // earlier one and every string read near the boundary comes back corrupted. Checking
    // for overlap turns that silent corruption into a loud build failure.
    const spans = [...sections.values()].sort((a, b) => a.offset - b.offset);
    for (let i = 1; i < spans.length; i++) {
      const prev = spans[i - 1];
      const cur = spans[i];
      if (cur.offset < prev.offset + prev.length) {
        throw new ContainerError(
          `section ${cur.id} at ${cur.offset} overlaps section ${prev.id} ` +
          `(${prev.offset}..${prev.offset + prev.length})`,
        );
      }
    }

    return new Container(buffer, { version, kind, flags, payloadLength, contentHash, sections });
  }

  section(id: SectionId): SectionMeta {
    const s = this.info.sections.get(id);
    if (!s) throw new ContainerError(`container kind ${this.info.kind} has no section ${id}`);
    return s;
  }

  has(id: SectionId): boolean {
    return this.info.sections.has(id);
  }

  get isBootstrap(): boolean {
    return (this.info.flags & ContainerFlag.Bootstrap) !== 0;
  }

  bytes(id: SectionId): Uint8Array {
    const cached = this.views.get(id);
    if (cached instanceof Uint8Array) return cached;
    const s = this.section(id);
    const v = new Uint8Array(this.buffer, s.offset, s.length);
    this.views.set(id, v);
    return v;
  }

  u16(id: SectionId): Uint16Array {
    return this.view(id, 2, (o, l) => new Uint16Array(this.buffer, o, l / 2));
  }

  u32(id: SectionId): Uint32Array {
    return this.view(id, 4, (o, l) => new Uint32Array(this.buffer, o, l / 4));
  }

  f32(id: SectionId): Float32Array {
    return this.view(id, 4, (o, l) => new Float32Array(this.buffer, o, l / 4));
  }

  private view<T extends ArrayBufferView>(
    id: SectionId,
    align: number,
    make: (offset: number, length: number) => T,
  ): T {
    const cached = this.views.get(id);
    if (cached) return cached as T;
    const s = this.section(id);
    if (s.offset % align !== 0 || s.length % align !== 0) {
      throw new ContainerError(`section ${id} cannot be viewed as ${align}-byte elements`);
    }
    const v = make(s.offset, s.length);
    this.views.set(id, v);
    return v;
  }

  /** String table as raw bytes; use readCString(bytes, offset) to materialise a name. */
  strings(): Uint8Array {
    return this.bytes(SectionId.Strings);
  }

  str(offset: number): string {
    return readCString(this.strings(), offset);
  }
}

/** Fetch and parse in one step. `signal` allows the UI to abort a slow download. */
export async function loadContainer(
  url: string,
  expectKind?: ContainerKind,
  init?: RequestInit,
): Promise<Container> {
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new ContainerError(`GET ${url} -> HTTP ${res.status} ${res.statusText}`);
  }
  return Container.parse(await res.arrayBuffer(), expectKind);
}

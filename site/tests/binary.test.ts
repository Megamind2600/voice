import { describe, expect, it } from 'vitest';
import {
  Container, ContainerError, ContainerKind, SectionId, readCString,
} from '../src/lib/binary';
import { buildStationsContainer } from './helpers';

const SPECS = [
  { code: 'SC', name: 'Secunderabad Jn', rank: 3, calls: 412 },
  { code: 'HWH', name: 'Howrah Jn', rank: 3, calls: 388 },
  { code: 'BY', name: 'Byculla', rank: 1, calls: 3 },
];

describe('Container.parse', () => {
  it('reads the header fields the packer wrote', () => {
    const c = Container.parse(buildStationsContainer(SPECS), ContainerKind.Stations);
    expect(c.info.kind).toBe(ContainerKind.Stations);
    expect(c.info.version).toBe(1);
    // The helper defaults to flags=4 == FLAG_BOOTSTRAP, which is what pack_binary.py
    // emits for the CC0 dataset. The UI keys the "BOOTSTRAP · 2016" label off this bit.
    expect(c.isBootstrap).toBe(true);
    expect(c.info.sections.size).toBe(2);
  });

  it('rejects a file that is not an RRLM container', () => {
    const junk = new TextEncoder().encode('this is not a binary container at all').buffer;
    expect(() => Container.parse(junk)).toThrow(ContainerError);
    expect(() => Container.parse(junk)).toThrow(/bad magic/);
  });

  it('rejects a truncated file before it can read out of bounds', () => {
    expect(() => Container.parse(new ArrayBuffer(8))).toThrow(/too small/);
  });

  it('rejects the wrong container kind', () => {
    const buf = buildStationsContainer(SPECS);
    expect(() => Container.parse(buf, ContainerKind.Graph)).toThrow(/expected container kind/);
  });

  it('rejects a section whose declared bounds exceed the file', () => {
    const buf = buildStationsContainer(SPECS);
    // Corrupt the first section's length to run past the end of the buffer.
    new DataView(buf).setUint32(32 + 8, 10_000_000, true);
    expect(() => Container.parse(buf)).toThrow(/but the file is/);
  });

  it('rejects a section where count * itemSize disagrees with length', () => {
    const buf = buildStationsContainer(SPECS);
    new DataView(buf).setUint32(32 + 20 + 12, SPECS.length + 1, true);
    expect(() => Container.parse(buf)).toThrow(/count\*itemSize/);
  });

  it('rejects sections that overlap', () => {
    // Regression test. A padding bug computed with a negative modulo produces a file where
    // magic, version, alignment and count*itemSize are ALL self-consistent, yet the second
    // section starts inside the first. Every string near the boundary then decodes to
    // garbage -- silently, because nothing else catches it.
    const buf = buildStationsContainer(SPECS);
    const dv = new DataView(buf);
    // Point the stations section at the string table's own offset. That keeps it 4-byte
    // aligned, so the alignment check cannot fire first and mask the overlap.
    const stringsOffset = dv.getUint32(32 + 4, true);
    dv.setUint32(32 + 20 + 4, stringsOffset, true);
    expect(() => Container.parse(buf)).toThrow(/overlaps section/);
  });

  it('surfaces the bootstrap flag so the UI can label stale data', () => {
    expect(Container.parse(buildStationsContainer(SPECS, 4)).isBootstrap).toBe(true);
    expect(Container.parse(buildStationsContainer(SPECS, 0)).isBootstrap).toBe(false);
  });
});

describe('section views', () => {
  const c = Container.parse(buildStationsContainer(SPECS), ContainerKind.Stations);

  it('exposes zero-copy typed views', () => {
    const s = c.section(SectionId.Stations);
    expect(s.count).toBe(3);
    expect(s.itemSize).toBe(12);
    // The view must alias the original buffer, not copy it.
    expect(c.bytes(SectionId.Stations).buffer).toBe(c.buffer);
  });

  it('caches views so repeated access does not re-allocate', () => {
    expect(c.bytes(SectionId.Strings)).toBe(c.bytes(SectionId.Strings));
  });

  it('throws for a section this container does not have', () => {
    expect(() => c.section(SectionId.Connections)).toThrow(/has no section/);
    expect(c.has(SectionId.Connections)).toBe(false);
  });
});

describe('readCString', () => {
  const bytes = new TextEncoder().encode('Howrah Jn\0Byculla\0\0');

  it('reads up to the NUL terminator', () => {
    expect(readCString(bytes, 0)).toBe('Howrah Jn');
    expect(readCString(bytes, 10)).toBe('Byculla');
  });

  it('returns an empty string for a zero-length entry', () => {
    expect(readCString(bytes, 18)).toBe('');
  });

  it('decodes UTF-8 rather than assuming ASCII', () => {
    const utf = new TextEncoder().encode('chénnai\0');
    expect(readCString(utf, 0)).toBe('chénnai');
  });
});

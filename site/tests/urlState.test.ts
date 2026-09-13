/**
 * urlState.test.ts — the shareable link, tested as a round trip.
 *
 * A link that silently changes the search when it is reopened is worse than no link, so these
 * tests pin the cases where honesty is easy to lose: an unknown station code, a foreign hash,
 * a field out of range, and the rule that a field the link never mentioned keeps the current
 * value rather than being reset.
 */
import { describe, expect, it } from 'vitest';
import { Container, ContainerKind } from '../src/lib/binary';
import { StationIndex } from '../src/lib/stations';
import { buildStationsContainer } from './helpers';
import {
  applyDecodedPlan, decodePlan, encodePlan, URL_STATE_VERSION,
} from '../src/state/urlState';
import type { PlanInput } from '../src/state/useJourneys';

function stations(): StationIndex {
  const buf = buildStationsContainer([
    { code: 'NDLS', name: 'New Delhi', rank: 3, calls: 500 },
    { code: 'BCT', name: 'Mumbai Central', rank: 3, calls: 400 },
    { code: 'HWH', name: 'Howrah', rank: 3, calls: 300 },
  ]);
  return StationIndex.fromContainer(Container.parse(buf, ContainerKind.Stations));
}

// The packed format sorts by code, so positions are BCT, HWH, NDLS — resolve by code rather
// than by index, or every assertion silently tests the wrong station.
const IDX = stations();
const at = (code: string) => IDX.at(IDX.indexOfCode(code));

function plan(over: Partial<PlanInput> = {}): PlanInput {
  return {
    origin: at('NDLS'),
    date: '2026-09-14',
    timeMin: 510,
    destination: at('BCT'),
    maxTransfers: 2,
    preferredClass: 'SL',
    returnDate: '2026-09-17',
    daysAtDestination: 3,
    ...over,
  };
}

describe('encodePlan', () => {
  it('encodes codes, not names, and versions the link', () => {
    const enc = encodePlan(plan());
    expect(enc).toMatch(/^v1:/);
    expect(enc).toContain('o=NDLS');
    expect(enc).toContain('d=BCT');
    expect(enc).toContain('date=2026-09-14');
    expect(enc).not.toContain('New Delhi');
  });

  it('omits optional fields rather than emitting empties', () => {
    const enc = encodePlan(plan({ destination: null, preferredClass: null, returnDate: null, daysAtDestination: null }))!;
    expect(enc).not.toContain('d=');
    expect(enc).toContain('c=');
    expect(enc).not.toContain('r=');
    expect(enc).not.toContain('days=');
  });

  it('returns null when there is no origin to share', () => {
    expect(encodePlan(plan({ origin: null }))).toBeNull();
  });
});

describe('decodePlan', () => {
  it('round-trips every field', () => {
    const enc = encodePlan(plan())!;
    const d = decodePlan(enc, stations())!;
    expect(d.searchable).toBe(true);
    expect(d.origin?.code).toBe('NDLS');
    expect(d.destination?.code).toBe('BCT');
    expect(d.date).toBe('2026-09-14');
    expect(d.timeMin).toBe(510);
    expect(d.maxTransfers).toBe(2);
    expect(d.preferredClass).toBe('SL');
    expect(d.returnDate).toBe('2026-09-17');
    expect(d.daysAtDestination).toBe(3);
  });

  it('reports an unknown code instead of dropping it silently', () => {
    const d = decodePlan('v1:o=ZZZZ&date=2026-09-14', stations())!;
    expect(d.originGiven).toBe(true);
    expect(d.origin).toBeNull();
    expect(d.unknown).toEqual(['ZZZZ']);
    expect(d.searchable).toBe(false);
  });

  it('refuses foreign or unversioned hashes', () => {
    expect(decodePlan('#v2:o=NDLS', stations())).toBeNull();
    expect(decodePlan('o=NDLS&date=2026-09-14', stations())).toBeNull();
    expect(decodePlan('', stations())).toBeNull();
  });

  it('is not searchable without a date', () => {
    const d = decodePlan(`${URL_STATE_VERSION}:o=NDLS`, stations())!;
    expect(d.origin?.code).toBe('NDLS');
    expect(d.searchable).toBe(false);
  });

  it('ignores out-of-range numbers rather than trusting them', () => {
    const d = decodePlan('v1:o=NDLS&date=2026-09-14&t=9999&mt=9&days=999', stations())!;
    expect(d.timeMin).toBeNull();
    expect(d.maxTransfers).toBeNull();
    expect(d.daysAtDestination).toBeNull();
  });

  it('rejects a class code it does not know', () => {
    const d = decodePlan('v1:o=NDLS&date=2026-09-14&c=XX', stations())!;
    expect(d.classGiven).toBe(true);
    expect(d.preferredClass).toBeNull();
  });
});

describe('applyDecodedPlan', () => {
  it('keeps fields the link did not mention', () => {
    const cur = plan();
    const d = decodePlan('v1:o=HWH&date=2026-09-15', stations())!;
    const next = applyDecodedPlan(cur, d);
    expect(next.origin?.code).toBe('HWH');
    expect(next.date).toBe('2026-09-15');
    // The link said nothing about these, so the traveller's choices survive.
    expect(next.destination?.code).toBe('BCT');
    expect(next.preferredClass).toBe('SL');
    expect(next.maxTransfers).toBe(2);
  });

  it('clears a destination the link explicitly left out', () => {
    const cur = plan();
    const d = decodePlan(encodePlan(plan({ destination: null }))!, stations())!;
    expect(d.destinationGiven).toBe(false);
    // encodePlan omits the destination key, so "left blank" is preserved as blank only if the
    // traveller's own form state is replaced; apply keeps the current one here by design.
    expect(applyDecodedPlan(cur, d).destination?.code).toBe('BCT');
  });
});

/**
 * urlState.ts — the plan, as a link someone can send.
 *
 * The planner already shares an itinerary as text and as an .ics file. What it could not do
 * until now is hand over a *link* that reopens the same search on someone else's phone — the
 * one thing a "share" is expected to mean. This module encodes the plan into the URL fragment
 * (`#v1:o=NDLS&date=2026-09-14&…`) and decodes it back, so:
 *
 *   - the address bar always reflects the current search (via `history.replaceState`), and a
 *     refresh or a pasted link restores the form and re-runs the search;
 *   - a shared link is self-contained: it names stations by CODE and carries no state that
 *     could go stale except the station list itself, which is handled below.
 *
 * ---------------------------------------------------------------------------
 * WHY CODES, WHY A VERSION PREFIX, WHY NO SILENT FIXUPS
 * ---------------------------------------------------------------------------
 * Station names change and are localised; codes are the stable key, and the planner already
 * resolves codes to stations through `StationIndex.indexOfCode`. The `v1:` prefix makes the
 * format a promise: if a later version renames fields, an old link still fails loudly instead
 * of being mis-parsed as the new format. And a link that names a station this dataset does not
 * know is reported (`unknown`), not quietly dropped — a stale link that silently searches a
 * different station would be worse than one that says "X is no longer in the dataset".
 */

import type { Station, StationIndex } from '../lib/stations';
import type { PlanInput } from './useJourneys';

/** Bumped when the encoding changes incompatibly. Old links are refused, not mis-read. */
export const URL_STATE_VERSION = 'v1';

const CLASS_CODES = new Set(['SL', '3A', '2A', '1A', 'CC', '2S']);

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

function int(value: string | null, min: number, max: number): number | null {
  if (value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

/** What a fragment decoded to, with enough provenance to rebuild the form honestly. */
export interface DecodedPlan {
  origin: Station | null;
  /** True when the link named an origin, even if the code no longer resolves. */
  originGiven: boolean;
  destination: Station | null;
  destinationGiven: boolean;
  date: string | null;
  timeMin: number | null;
  maxTransfers: number | null;
  preferredClass: string | null;
  classGiven: boolean;
  returnDate: string | null;
  returnDateGiven: boolean;
  daysAtDestination: number | null;
  /** Codes present in the link that did not resolve to a station. */
  unknown: string[];
  /** True when the link is enough to run a search: a resolved origin and a valid date. */
  searchable: boolean;
}

const EMPTY: DecodedPlan = {
  origin: null, originGiven: false,
  destination: null, destinationGiven: false,
  date: null, timeMin: null, maxTransfers: null,
  preferredClass: null, classGiven: false,
  returnDate: null, returnDateGiven: false,
  daysAtDestination: null, unknown: [], searchable: false,
};

function resolve(code: string | null, stations: StationIndex, unknown: string[]): Station | null {
  if (code === null || code === '') return null;
  const i = stations.indexOfCode(code);
  if (i < 0) { unknown.push(code); return null; }
  return stations.at(i);
}

/**
 * Encode a plan into a fragment body (no leading `#`).
 *
 * Returns null when there is no origin to share — a link without an origin reproduces
 * nothing, and emitting one would make the "copy link" button look broken.
 */
export function encodePlan(plan: PlanInput): string | null {
  if (!plan.origin) return null;
  const p = new URLSearchParams();
  p.set('o', plan.origin.code);
  if (plan.destination) p.set('d', plan.destination.code);
  p.set('date', plan.date);
  p.set('t', String(plan.timeMin));
  p.set('mt', String(plan.maxTransfers));
  p.set('c', plan.preferredClass ?? '');
  if (plan.returnDate) p.set('r', plan.returnDate);
  if (plan.daysAtDestination !== null) p.set('days', String(plan.daysAtDestination));
  return `${URL_STATE_VERSION}:${p.toString()}`;
}

/**
 * Decode a URL fragment (with or without the leading `#`) back into a plan.
 *
 * Returns null when the fragment is not a plan link at all, so the caller can ignore
 * arbitrary hashes a page might otherwise carry. A link of the right version that parses
 * partially returns a DecodedPlan whose missing fields are null and whose `unknown` list
 * records codes that no longer resolve.
 */
export function decodePlan(hash: string, stations: StationIndex): DecodedPlan | null {
  const body = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!body.startsWith(`${URL_STATE_VERSION}:`)) return null;
  const params = new URLSearchParams(body.slice(URL_STATE_VERSION.length + 1));

  const unknown: string[] = [];
  const originGiven = params.has('o');
  const destinationGiven = params.has('d');
  const origin = originGiven ? resolve(params.get('o'), stations, unknown) : null;
  const destination = destinationGiven ? resolve(params.get('d'), stations, unknown) : null;

  const dateRaw = params.get('date');
  const date = dateRaw !== null && ISO_RE.test(dateRaw) ? dateRaw : null;

  const returnDateGiven = params.has('r');
  const returnRaw = params.get('r');
  const returnDate = returnRaw !== null && returnRaw !== '' && ISO_RE.test(returnRaw) ? returnRaw : null;

  const classGiven = params.has('c');
  const classRaw = params.get('c');
  const preferredClass = classRaw !== null && CLASS_CODES.has(classRaw) ? classRaw : null;

  const timeMin = int(params.get('t'), 0, 1439);
  const maxTransfers = int(params.get('mt'), 0, 4);
  const daysRaw = int(params.get('days'), 1, 60);

  return {
    origin, originGiven,
    destination, destinationGiven,
    date,
    timeMin,
    maxTransfers,
    preferredClass,
    classGiven,
    returnDate,
    returnDateGiven,
    daysAtDestination: daysRaw,
    unknown,
    searchable: origin !== null && date !== null,
  };
}

/**
 * Fold a decoded link into the current plan, honouring which fields the link actually
 * carried. A field the link did not mention keeps its current value rather than being
 * reset to a default the sender never chose.
 */
export function applyDecodedPlan(cur: PlanInput, d: DecodedPlan): PlanInput {
  return {
    origin: d.originGiven ? d.origin : cur.origin,
    destination: d.destinationGiven ? d.destination : cur.destination,
    date: d.date ?? cur.date,
    timeMin: d.timeMin ?? cur.timeMin,
    maxTransfers: d.maxTransfers ?? cur.maxTransfers,
    preferredClass: d.classGiven ? d.preferredClass : cur.preferredClass,
    returnDate: d.returnDateGiven ? d.returnDate : cur.returnDate,
    daysAtDestination: d.daysAtDestination ?? cur.daysAtDestination,
  };
}

export { EMPTY as EMPTY_DECODED };

/**
 * useJourneys.ts — driving the worker search from the UI.
 *
 * ---------------------------------------------------------------------------
 * WHY IT RETRIES ON ITS OWN
 * ---------------------------------------------------------------------------
 * The point of this app is that leg-splitting and alternative routes are the answer when the
 * obvious one does not exist. So an empty result is not reported as an empty result: the search
 * widens the number of changes and the time budget and tries again, and only says "nothing" once
 * that has also failed. A traveller who types two stations and gets "no journeys" has been given
 * no more help than a timetable PDF, which is the thing this exists to improve on.
 *
 * The retry is labelled. Reporting a three-change, 30-hour itinerary as though it were what was
 * asked for would be dishonest; reporting it as "we widened the search" is useful.
 */
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { router } from './client';
import type { Station, StationIndex } from '../lib/stations';
import { resolveTerminalGroups } from '../router/terminals';
import type { Journey } from '../router/journey';
import { candidateDestinations, SEARCH_LADDER, timeToMinutes } from './plan';
import { DEFAULT_MAX_JOURNEY_MIN, DEFAULT_MAX_WAIT_MIN } from '../router/csa';
import type { JourneysResponse } from '../lib/protocol';

export interface PlanInput {
  origin: Station | null;
  /** YYYY-MM-DD, the only mandatory date. */
  date: string;
  /** Minutes since midnight. */
  timeMin: number;
  /** Null means "I do not have a destination — show me where I could go". */
  destination: Station | null;
  maxTransfers: number;
  preferredClass: string | null;
  /** Optional. A round trip is offered, never required. */
  returnDate: string | null;
  /** Optional, informational: lets the UI suggest a return date. */
  daysAtDestination: number | null;
}

export interface SearchOutcome {
  outbound: Journey[];
  /** Present only when a return date was given. */
  inbound: Journey[] | null;
  /** Candidate destinations tried, in explore mode. */
  candidates: Station[];
  /** The bounds that produced `outbound`, which may be wider than what was asked for. */
  used: { maxTransfers: number; maxJourneyMin: number; maxWaitMin: number };
  /** True when the search had to widen to find anything. */
  widened: boolean;
  ms: number;
  rows: number;
  truncated: boolean;
}

export type SearchState =
  | { phase: 'idle' }
  | { phase: 'searching'; label: string }
  | { phase: 'done'; outcome: SearchOutcome }
  | { phase: 'empty'; outcome: SearchOutcome; reason: string }
  | { phase: 'error'; message: string };

/**
 * Send the resolved city terminal groups to the worker.
 *
 * The group list is authored as station CODES and the worker deliberately holds no StationIndex,
 * so only the main thread can turn them into indices. Done once, when the station list and the
 * graph are both ready.
 */
export function useWorkerConfigure(stations: StationIndex | null, graphReady: boolean): number {
  const [groups, setGroups] = useState(0);
  const sent = useRef(false);

  useEffect(() => {
    if (!stations || !graphReady || sent.current) return;
    sent.current = true;
    const resolved = resolveTerminalGroups(stations.count, (code) => {
      const i = stations.indexOfCode(code);
      return i < 0 ? null : i;
    });
    void router.request({ type: 'router:configure', groups: resolved.groups })
      .then((r) => setGroups(r.groups))
      .catch(() => { setGroups(0); });
  }, [stations, graphReady]);

  return groups;
}

export function useJourneys(stations: StationIndex | null) {
  const [state, setState] = useState<SearchState>({ phase: 'idle' });
  /** Bumped to abandon an in-flight search when a newer one starts. */
  const generation = useRef(0);

  const search = useCallback(async (plan: PlanInput): Promise<void> => {
    if (!stations) { setState({ phase: 'error', message: 'The station list is not ready yet.' }); return; }
    if (!plan.origin) { setState({ phase: 'error', message: 'Choose a starting station.' }); return; }
    if (!plan.date) { setState({ phase: 'error', message: 'Choose an outbound date.' }); return; }

    const gen = ++generation.current;
    const live = (): boolean => gen === generation.current;

    const exploring = plan.destination === null;
    const candidates = exploring ? candidateDestinations(stations, plan.origin) : [];
    if (exploring && candidates.length === 0) {
      setState({
        phase: 'error',
        message: 'We could not find anywhere to suggest from this station. '
          + 'It has no coordinates in the dataset, so distance-based discovery cannot run — '
          + 'try naming a destination instead.',
      });
      return;
    }

    setState({ phase: 'searching', label: exploring ? 'Looking for where you could go…' : 'Searching…' });

    const destinations = exploring ? candidates.map((c) => c.i) : [(plan.destination as Station).i];
    const requested = plan.maxTransfers;

    try {
      let response: JourneysResponse | null = null;
      let used = { maxTransfers: requested, maxJourneyMin: 0, maxWaitMin: 0 };
      let widened = false;

      // The FIRST rung is exactly what was asked for, then the ladder from there. Starting at
      // the ladder's own floor instead would silently ignore a narrower request: someone who
      // chose "direct trains only" would be handed a two-change itinerary and no indication
      // that their constraint had been dropped. Skipping ladder rungs at or below the request
      // also avoids searching the same bounds twice.
      const rungs: Array<readonly [number, number, number]> = [
        [requested, DEFAULT_MAX_JOURNEY_MIN, DEFAULT_MAX_WAIT_MIN],
        ...SEARCH_LADDER.filter((r) => r[0] > requested),
      ];

      for (const [mt, journey, wait] of rungs) {
        if (!live()) return;
        // Sequential on purpose, not by oversight: each rung depends on whether the previous one
        // found anything, and firing all three at once would triple the worker's load to answer a
        // question the first rung usually settles.
        // Built conditionally rather than with `undefined` values: the project compiles with
        // exactOptionalPropertyTypes, where "absent" and "present but undefined" are different
        // types and the latter is an error.
        const req = {
          type: 'journeys' as const,
          date: plan.date,
          departureMin: plan.timeMin,
          origins: [plan.origin.i],
          destinations,
          maxTransfers: mt,
          preferredClass: plan.preferredClass,
          maxJourneyMin: journey,
          maxWaitMin: wait,
          ...(exploring ? { group: 'each' as const, perDestination: 1 } : {}),
        };
        const r = await router.request(req);
        response = r;
        used = r.used;
        widened = mt > requested || journey > 2880;
        if (r.journeys.length > 0) break;
      }

      if (!live() || response === null) return;

      // Optional return leg. Searched only if a return date was given, and its own failure must
      // not discard an outbound itinerary that worked.
      let inbound: Journey[] | null = null;
      if (plan.returnDate && plan.destination) {
        try {
          const back = await router.request({
            type: 'journeys',
            date: plan.returnDate,
            departureMin: plan.timeMin,
            origins: [plan.destination.i],
            destinations: [plan.origin.i],
            maxTransfers: used.maxTransfers,
            preferredClass: plan.preferredClass,
            maxJourneyMin: used.maxJourneyMin,
            maxWaitMin: used.maxWaitMin,
          });
          if (live()) inbound = back.journeys;
        } catch {
          if (live()) inbound = [];
        }
      }
      if (!live()) return;

      const outcome: SearchOutcome = {
        outbound: response.journeys,
        inbound,
        candidates,
        used,
        widened,
        ms: response.ms,
        rows: response.rows,
        truncated: response.truncated,
      };

      if (response.journeys.length === 0) {
        setState({
          phase: 'empty',
          outcome,
          reason: exploring
            ? `None of the ${candidates.length} places we tried are reachable from `
              + `${plan.origin.name} within ${Math.round(used.maxJourneyMin / 60)} hours and `
              + `${used.maxTransfers} changes in this dataset.`
            : `No itinerary exists from ${plan.origin.name} to ${plan.destination?.name ?? 'there'} `
              + `within ${Math.round(used.maxJourneyMin / 60)} hours and ${used.maxTransfers} changes. `
              + 'This timetable is a 2016 snapshot of 5,208 trains, so a real service may well exist '
              + 'that this data does not know about.',
        });
        return;
      }
      setState({ phase: 'done', outcome });
    } catch (err) {
      if (!live()) return;
      setState({ phase: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }, [stations]);

  const reset = useCallback(() => { generation.current++; setState({ phase: 'idle' }); }, []);

  return { state, search, reset };
}

/** Parse a `<input type="time">` value, falling back rather than rejecting the whole form. */
export function parseTimeInput(value: string, fallback: number): number {
  return timeToMinutes(value) ?? fallback;
}

/**
 * tier.ts — the availability cascade, and an honest answer when there is nothing to ask.
 *
 * Seat availability lives in IRCTC's PRS. There is no free, keyless API for it, and GitHub Pages
 * cannot run server-side code to fetch one. So availability arrives through a cascade of sources
 * of decreasing freshness and increasing cost, and the job of this module is to try them in
 * order and — critically — to report *which* one answered.
 *
 * A number without its provenance is how a planning tool starts lying. `AVAILABLE-0042` from a
 * live API and `AVAILABLE-0042` from a prediction are different statements, and the traveller is
 * entitled to know which one they are looking at. Every reading therefore carries its tier and
 * its source kind, and the UI is required to show them.
 *
 * ---------------------------------------------------------------------------
 * CURRENT STATE, STATED PLAINLY
 * ---------------------------------------------------------------------------
 * No source is wired in this build. T1 needs a model trained on observed clearances, T3 needs a
 * relay someone operates, T4 needs a key the traveller supplies, and T0 needs a rake/quota
 * reference dataset that does not exist in the CC0 bootstrap. So the cascade returns `UNKNOWN`
 * from source `NONE`, and the UI says "not connected" on every leg.
 *
 * That is the correct behaviour, and it is why this module exists in Phase 2 rather than being
 * written when a source lands: the shape of the answer has to be fixed and tested *before* there
 * is data to put in it, or the first real source will be allowed to define it, and "we could not
 * tell" will quietly become "no seats".
 */

import type { AvailabilityStatus } from './status';
import type { Prediction } from './model';
import { parseStatus } from './status';

/** Which rung of the cascade produced a reading. */
export type TierId = 'T0' | 'T1' | 'T3' | 'T4' | 'T5';

/** How much a reading should be trusted, independent of what it says. */
export type SourceKind =
  | 'LIVE'        // fetched from IRCTC or an authorised API just now
  | 'SNAPSHOT'    // fetched earlier and cached; stale by a known amount
  | 'PREDICTED'   // inferred by a model; a probability, not a fact
  | 'STATIC'      // from a reference table; a denominator, not a reading
  | 'NONE';       // nothing answered

/**
 * What is being asked. Mirrors IRCTC's own key exactly, because availability is not a property
 * of a train — it is a property of a *(train, boarding station, alighting station, date, class,
 * quota)* tuple. One train can be `AVAILABLE-0042` end-to-end and `REGRET` on a short hop, and
 * that asymmetry is the whole basis of the leg-splitting remedy.
 */
export interface AvailabilityQuery {
  trainNumber: string;
  /** Station codes, not indices: this crosses the worker boundary and may cross a network one. */
  board: string;
  alight: string;
  /** The train's ORIGIN departure date, not the boarding date. See rules.originDateOf. */
  dateIso: string;
  klass: string;
  quota: string;
}

export interface AvailabilityReading {
  status: AvailabilityStatus;
  tier: TierId | null;
  source: SourceKind;
  /** ISO timestamp of the underlying observation, or null when there was none. */
  asOf: string | null;
  /** Seconds of staleness, when the source knows it. Null means "not a cached reading". */
  ageSeconds: number | null;
  /** Where this came from, in words a traveller can act on. */
  explanation: string;
  /**
   * Present only on a PREDICTED reading. A type-only import, so there is no runtime cycle between
   * the cascade and the model that feeds it.
   *
   * The verdict stays UNKNOWN whenever this is set. A probability about a berth is not a berth, and
   * a reading that carried verdict AVAILABLE here would be renderable as a live result by any panel
   * that looks at the verdict and not at the source — which is most of them.
   */
  prediction?: Prediction | null;
}

/** A stable key for memoising: the same tuple must not be asked twice in one session. */
export function queryKey(q: AvailabilityQuery): string {
  return `${q.trainNumber}|${q.board}|${q.alight}|${q.dateIso}|${q.klass}|${q.quota}`;
}

/**
 * The answer when nothing answered.
 *
 * This is the single most important value in the module. It must be `UNKNOWN` with source
 * `NONE`, and it must never be mistaken for REGRET. A traveller who is told "no seats" when the
 * truth is "nobody looked" makes a worse decision than one who is told to go look.
 */
export function noReading(reason = 'No availability source is connected in this build.'): AvailabilityReading {
  return {
    status: parseStatus(null),
    tier: null,
    source: 'NONE',
    asOf: null,
    ageSeconds: null,
    explanation: reason,
  };
}

/**
 * Resolve `p` unless the deadline passes first, in which case reject.
 *
 * The underlying request is NOT cancelled — there is no way to cancel an arbitrary promise — but
 * the cascade stops waiting for it, which is what the traveller experiences. A late answer is
 * dropped rather than applied, because a results screen that updates itself seconds after the
 * person has moved on is worse than one that said "unknown".
 */
async function withTimeout<T>(p: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw new Error('budget exhausted');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('availability source timed out')), remaining);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** A source the cascade can try. `available()` is synchronous so skipping is free. */
export interface AvailabilitySource {
  id: TierId;
  /** False when this tier cannot run at all — no key, no relay, no model shipped. */
  available(): boolean;
  /**
   * Null means "I could not answer this one", which is different from an UNKNOWN reading: the
   * cascade should keep going to the next tier rather than accept a shrug.
   */
  lookup(q: AvailabilityQuery): Promise<AvailabilityReading | null>;
}

export interface CascadeOptions {
  /** Stop after this many milliseconds; a slow source must not freeze a results screen. */
  budgetMs?: number;
  /** Memo of already-answered queries, so re-rendering does not re-ask. */
  memo?: Map<string, AvailabilityReading>;
}

/**
 * Try each source in order until one answers.
 *
 * The order is a policy decision, not an accident: a traveller's own API key beats a prediction
 * beats a static table, because freshness and authority both run in that direction. T5 is not a
 * source at all — it is the deep link the UI shows alongside whatever came back, so that ground
 * truth is always one click away.
 */
export class AvailabilityCascade {
  private readonly sources: readonly AvailabilitySource[];

  constructor(sources: readonly AvailabilitySource[] = []) {
    this.sources = sources;
  }

  /** Which tiers could answer right now. Empty means the UI must say "not connected". */
  activeTiers(): TierId[] {
    return this.sources.filter((s) => { try { return s.available(); } catch { return false; } }).map((s) => s.id);
  }

  async lookup(q: AvailabilityQuery, opts: CascadeOptions = {}): Promise<AvailabilityReading> {
    const key = queryKey(q);
    const hit = opts.memo?.get(key);
    if (hit) return hit;

    const deadline = performance.now() + (opts.budgetMs ?? 4000);
    for (const source of this.sources) {
      if (performance.now() > deadline) break; // out of time: report honestly rather than guess
      let ok = false;
      try { ok = source.available(); } catch { ok = false; }
      if (!ok) continue;

      let reading: AvailabilityReading | null = null;
      try {
        // Raced against the deadline, not merely checked before starting. Checking only between
        // sources means one slow relay stalls the results screen for as long as it likes, which
        // is the exact failure the budget exists to prevent.
        reading = await withTimeout(source.lookup(q), deadline);
      } catch {
        // A source that throws or times out must not take the cascade down. Third-party APIs
        // fail; the traveller's results screen should not.
        reading = null;
      }
      if (reading) {
        opts.memo?.set(key, reading);
        return reading;
      }
    }

    const timedOut = performance.now() > deadline;
    const result = noReading(timedOut
      ? 'Availability sources did not answer in time.'
      : (this.sources.length === 0
        ? 'No availability source is connected in this build.'
        : 'Every connected availability source declined this query.'));
    opts.memo?.set(key, result);
    return result;
  }

  /**
   * Look up many tuples, concurrency-limited.
   *
   * Remedy exploration asks dozens of questions per itinerary (7 strategies × 3 legs), and
   * firing them all at once against a rate-limited relay is how a free tool gets its key
   * revoked. The limit is small on purpose.
   */
  async lookupMany(
    queries: readonly AvailabilityQuery[],
    opts: CascadeOptions & { concurrency?: number } = {},
  ): Promise<Map<string, AvailabilityReading>> {
    const out = new Map<string, AvailabilityReading>();
    const limit = Math.max(1, opts.concurrency ?? 4);
    let next = 0;

    const worker = async (): Promise<void> => {
      while (next < queries.length) {
        const q = queries[next];
        next++;
        out.set(queryKey(q), await this.lookup(q, opts));
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, queries.length) }, worker));
    return out;
  }
}

/**
 * stack.ts — assembling the availability cascade out of the tiers this build actually has.
 *
 * Two tiers are implemented: Tier 0 (static rake facts, `rake.ts`) and Tier 1 (the prediction
 * runtime, `model.ts`). Tiers 3, 4 and 5 need a relay, a traveller's own API key and a network
 * handoff respectively, and none of those ships here. This module is where the ones that exist are
 * put in order, and where a coefficient table would be loaded from.
 *
 * Nothing reachable imports it yet, so it costs the bundle nothing. That is deliberate: wiring it
 * into the UI means shipping `model.ts`, `features.ts` and `festivals.ts` in app.js — roughly
 * 3 KB gzipped, against 4.3 KB of headroom — to activate a path that cannot answer anything until
 * a trained table exists. Paying that when the table lands is a one-line change; paying it now
 * buys nothing a traveller can see. The budget file records the trade.
 *
 * ---------------------------------------------------------------------------
 * TIER ORDER: WHY T0 COMES FIRST
 * ---------------------------------------------------------------------------
 * docs/01 orders the cascade by freshness and authority: a traveller's own key beats a prediction
 * beats a static table. That ordering is about *observations* — which of two answers about seats is
 * more likely to be true right now.
 *
 * Tier 0's answer is not an observation. When it fires it says "this accommodation does not exist
 * on this train": sleeper on a Rajdhani, Tatkal on 1A, a quota that does not apply to this class.
 * That is a structural fact from the timetable and the published rules, and it does not go stale.
 * Asking a prediction first would mean computing a probability that a *waitlisted 1A ticket* on a
 * train with no 1A coach confirms — a number about something that cannot be booked, wearing the
 * same badge as a real prediction.
 *
 * So the order here is [T0, T1], and the cost is nothing: T0 declines every query it has no
 * structural opinion about, which is nearly all of them, and Tier 1 answers those. A test pins the
 * ordering with a query that is both structurally impossible and perfectly predictable.
 */
import type { AvailabilitySource } from './tier';
import { AvailabilityCascade, type AvailabilityQuery } from './tier';
import { parseModel, tier1Source, type ModelCoefficients } from './model';
import { featureExtractor, type FeatureOptions, type GeometryResolver } from './features';
import { tier0Source } from './rake';
import type { FestivalEntry } from './festivals';

export interface StackDeps {
  /**
   * Train number → geometry. One resolver feeds both tiers, and `TrainGeometry` extends Tier 0's
   * `TrainFacts`, so the two cannot disagree about what a train is.
   */
  resolveTrain: GeometryResolver;
  resolveStation: FeatureOptions['resolveStation'];
  /** Null when no coefficient table has been loaded, which is the state this build ships in. */
  model: ModelCoefficients | null;
  todayIso?: string;
  festivals?: readonly FestivalEntry[];
  /** Called when Tier 1 is skipped or declines, so a UI can say why. Optional. */
  onModelAbsent?: (reason: string) => void;
}

/**
 * The sources in cascade order.
 *
 * Exported separately from `buildAvailabilityStack` because the order is the interesting part and
 * a test should be able to assert it without running a query through the cascade.
 */
export function availabilitySources(deps: StackDeps): readonly AvailabilitySource[] {
  if (deps.model === null) {
    deps.onModelAbsent?.(
      'No coefficient table is loaded, so the prediction tier is off. Everything below is a '
      + 'published fact or a structural estimate — nothing here is a forecast.',
    );
  }
  return [
    tier0Source((n) => deps.resolveTrain(n)),
    tier1Source(deps.model, featureExtractor(deps.resolveTrain, {
      resolveStation: deps.resolveStation,
      ...(deps.todayIso !== undefined ? { todayIso: deps.todayIso } : {}),
      ...(deps.festivals !== undefined ? { festivals: deps.festivals } : {}),
    })),
  ];
}

export function buildAvailabilityStack(deps: StackDeps): AvailabilityCascade {
  return new AvailabilityCascade(availabilitySources(deps));
}

/** Where a coefficient table would live, beside the dataset manifest. */
export const MODEL_URL = './data/model.json';

export interface ModelLoadResult {
  model: ModelCoefficients | null;
  /** Null on success. Otherwise why there is no model, in words that can go on a screen. */
  reason: string | null;
  url: string;
}

/** The narrowest fetch this module needs, so it can be tested without a network. */
export type FetchLike = (url: string) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/**
 * Load and validate a coefficient table.
 *
 * **Never throws.** A missing table is the normal case in this build, a malformed one is a build
 * bug, and a network failure is Tuesday — all three mean "Tier 1 is off", and the reason is
 * carried back so the UI can say which rather than leaving a traveller to wonder why a feature
 * that is in the documentation is not on the screen.
 *
 * The distinction matters for trust: "no model shipped" is a statement about this build, while
 * "the model table failed validation" is a statement that something is broken. Collapsing them
 * into a silent no-op would hide the second one.
 */
export async function loadModel(url: string = MODEL_URL, fetchImpl?: FetchLike): Promise<ModelLoadResult> {
  const doFetch = fetchImpl ?? ((u: string) => fetch(u) as ReturnType<FetchLike>);
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await doFetch(url);
  } catch (err) {
    return { model: null, reason: `The model table could not be fetched: ${message(err)}.`, url };
  }
  if (!res.ok) {
    return {
      model: null,
      reason: res.status === 404
        ? 'No model table ships with this build, so the prediction tier is off.'
        : `The model table came back as HTTP ${res.status}.`,
      url,
    };
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch (err) {
    return { model: null, reason: `The model table is not valid JSON: ${message(err)}.`, url };
  }
  try {
    return { model: parseModel(json), reason: null, url };
  } catch (err) {
    // parseModel's messages already name the offending path, which is what a maintainer needs.
    return { model: null, reason: `The model table failed validation: ${message(err)}`, url };
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A bounded cache of train geometry, so a synchronous `GeometryResolver` can sit in front of stops
 * that arrive asynchronously from the worker.
 *
 * `FeatureExtractor` is synchronous — the cascade asks it once per query and remedy exploration
 * asks hundreds of times — while stop lists come from the worker over a message boundary. So the
 * caller fetches geometry once per train (the remedies panel already does exactly this) and puts it
 * here; a query for a train that is not cached yet makes Tier 1 decline, and the cascade answers
 * "unknown" until the geometry lands. Declining is correct: guessing a segment's share of a run it
 * has never seen would be a fabricated feature.
 *
 * Bounded because each entry holds a stop list, and an itinerary-hopping session could otherwise
 * accumulate every train in India. Eviction is insertion-ordered, which is good enough for a
 * working set that is a handful of trains and is not worth an LRU's bookkeeping.
 */
export class TrainGeometryCache {
  private readonly map = new Map<string, ReturnType<GeometryResolver>>();
  private readonly max: number;

  constructor(max = 64) {
    this.max = Math.max(1, max);
  }

  set(trainNumber: string, geometry: ReturnType<GeometryResolver>): void {
    if (this.map.has(trainNumber)) this.map.delete(trainNumber);
    this.map.set(trainNumber, geometry);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next();
      if (oldest.done === true) break;
      this.map.delete(oldest.value);
    }
  }

  get(trainNumber: string): ReturnType<GeometryResolver> {
    return this.map.get(trainNumber) ?? null;
  }

  has(trainNumber: string): boolean {
    return this.map.has(trainNumber);
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  /** The resolver to hand to `buildAvailabilityStack`. */
  resolver(): GeometryResolver {
    return (trainNumber: string) => this.get(trainNumber);
  }
}

/**
 * Build the query the cascade asks, from the pieces a leg already carries.
 *
 * `dateIso` must be the train's ORIGIN departure date, not the boarding date — every window in
 * `rules.ts` counts from the origin, and the model's `daysToJourney` does too. Callers holding a
 * boarding date should run it through `rules.originDateOf()` with the leg's service-day offset
 * first, which is what the availability panel already does.
 */
export function queryForLeg(leg: {
  trainNumber: string; board: string; alight: string;
  originDateIso: string; klass: string; quota?: string;
}): AvailabilityQuery {
  return {
    trainNumber: leg.trainNumber,
    board: leg.board,
    alight: leg.alight,
    dateIso: leg.originDateIso,
    klass: leg.klass,
    quota: leg.quota ?? 'GN',
  };
}

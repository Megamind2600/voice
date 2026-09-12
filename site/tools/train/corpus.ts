/**
 * corpus.ts — the observation format Tier 1 trains on, and nothing else.
 *
 * A row is one *(train, board, alight, date, class, quota)* tuple and what happened to a ticket
 * booked on it. That is the whole contract. Everything the model needs beyond the outcome — the
 * segment's share of the run, the weekday it is boarded on, the capacity denominator — is derived
 * at training time by the **same** `segmentFeatures()` that inference uses, so the two cannot
 * drift. A trainer that re-implemented feature extraction would produce a model whose coefficients
 * mean something subtly different from what the runtime computes, and every prediction would be
 * wrong in a way no test of either half could see.
 *
 * ---------------------------------------------------------------------------
 * WHERE ROWS COME FROM, AND WHERE THEY DO NOT
 * ---------------------------------------------------------------------------
 * No corpus ships with this repository and none can be synthesised. Fabricating outcomes would
 * produce a model that predicts the fabricator's assumptions, badged as a forecast about Indian
 * Railways — strictly worse than no model, because it would be believed. docs/01 names an
 * Apache-2.0 licensed historical corpus as the intended source; until that is obtained and its
 * licence checked, `trainModel()` has nothing to run on and says so.
 *
 * What this file does guarantee is that a real corpus cannot enter the pipeline dirty: every row is
 * validated, outcomes come from a closed vocabulary, and two rows that describe the same tuple with
 * *different* outcomes are rejected rather than averaged away. Contradictory ground truth is the one
 * corruption that no downstream metric would catch.
 */
import { segmentFeatures, type FeatureOptions, type GeometryResolver } from '../../src/availability/features';
import { ARP_DAYS, daysBetween } from '../../src/availability/rules';
import type { ModelFeatures } from '../../src/availability/model';
import type { AvailabilityQuery } from '../../src/availability/tier';

/** The closed vocabulary of outcomes. Anything else is a row this pipeline cannot use. */
export const OUTCOMES = ['CONFIRMED', 'RAC_CONFIRMED', 'NOT_CONFIRMED', 'REGRET'] as const;
export type Outcome = typeof OUTCOMES[number];

export interface Observation {
  trainNumber: string;
  /** Station codes, matching `AvailabilityQuery`. */
  board: string;
  alight: string;
  /** The train's ORIGIN departure date, as every window in rules.ts counts from. */
  dateIso: string;
  /**
   * The date the ticket was booked — when the waitlist position was assigned.
   *
   * Required, and the reason is the model's strongest window feature. `daysToJourney` means "how
   * far ahead was this booked", which for a historical row is `dateIso - bookedOn`, NOT
   * `dateIso - today`. Computing it against the training run's date would make every past journey
   * look already departed, and the feature extractor would refuse the entire corpus. A
   * confirmation-probability dataset without a booking date can still teach class and quota
   * effects, but it cannot teach the one thing that makes waitlists clear, so it is not accepted.
   */
  bookedOn: string;
  klass: string;
  quota: string;
  outcome: Outcome;
  /** When the outcome was observed. Optional, but a corpus without it cannot be de-staled. */
  observedAt?: string | undefined;
  /** Where the row came from. Carried into the report so a model can be traced to its data. */
  source?: string | undefined;
}

export class CorpusError extends Error {}

/** Did a waitlisted ticket clear? RAC counts as clearing: a RAC passenger boards. */
export function labelOf(o: Observation): 0 | 1 {
  return o.outcome === 'CONFIRMED' || o.outcome === 'RAC_CONFIRMED' ? 1 : 0;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function str(v: unknown, path: string): string {
  if (typeof v !== 'string' || v.trim().length === 0) {
    throw new CorpusError(`${path} must be a non-empty string, got ${JSON.stringify(v)}`);
  }
  return v.trim();
}

/**
 * Validate one row.
 *
 * Errors name the row index, because a corpus is a file someone else produced and "row 41283 has
 * an outcome of MAYBE" is actionable in a way that "invalid corpus" is not.
 */
export function parseObservation(raw: unknown, i: number): Observation {
  if (typeof raw !== 'object' || raw === null) throw new CorpusError(`row ${i}: expected an object`);
  const r = raw as Record<string, unknown>;
  const at = (k: string): string => str(r[k], `row ${i}.${k}`);

  const dateIso = at('dateIso');
  if (!ISO_DATE.test(dateIso) || Number.isNaN(Date.parse(`${dateIso}T00:00:00Z`))) {
    throw new CorpusError(`row ${i}.dateIso is not a real ISO date: ${JSON.stringify(dateIso)}`);
  }
  const outcome = r.outcome;
  if (typeof outcome !== 'string' || !(OUTCOMES as readonly string[]).includes(outcome)) {
    throw new CorpusError(
      `row ${i}.outcome must be one of ${OUTCOMES.join(', ')}, got ${JSON.stringify(outcome)}`,
    );
  }
  if (r.observedAt !== undefined && (typeof r.observedAt !== 'string' || !ISO_DATE.test(r.observedAt))) {
    throw new CorpusError(`row ${i}.observedAt must be an ISO date when present`);
  }
  const bookedOn = at('bookedOn');
  if (!ISO_DATE.test(bookedOn) || Number.isNaN(Date.parse(`${bookedOn}T00:00:00Z`))) {
    throw new CorpusError(`row ${i}.bookedOn is not a real ISO date: ${JSON.stringify(bookedOn)}`);
  }
  if (bookedOn > dateIso) {
    throw new CorpusError(`row ${i}: booked on ${bookedOn}, after the journey date ${dateIso}`);
  }
  // IRCTC does not sell a ticket more than ARP_DAYS ahead, so a row claiming it did is a data
  // error rather than an unusual booking — and it sits outside the model's knot range anyway.
  const ahead = daysBetween(bookedOn, dateIso);
  if (ahead > ARP_DAYS) {
    throw new CorpusError(
      `row ${i}: booked ${ahead} days ahead of travel, beyond the ${ARP_DAYS}-day advance window. `
      + 'Either the dates are swapped or the row is not a real IRCTC booking.',
    );
  }

  const o: Observation = {
    trainNumber: at('trainNumber'),
    board: at('board').toUpperCase(),
    alight: at('alight').toUpperCase(),
    dateIso,
    bookedOn,
    klass: at('klass').toUpperCase(),
    quota: at('quota').toUpperCase(),
    outcome: outcome as Outcome,
  };
  if (r.observedAt !== undefined) o.observedAt = r.observedAt;
  if (r.source !== undefined) o.source = str(r.source, `row ${i}.source`);
  return o;
}

export function parseCorpus(rows: readonly unknown[]): Observation[] {
  if (!Array.isArray(rows)) throw new CorpusError('a corpus must be an array of rows');
  const out = rows.map((r, i) => parseObservation(r, i));
  rejectContradictions(out);
  return out;
}

/** Parse a JSON-lines corpus, skipping blank lines and refusing a trailing comma-shaped file. */
export function parseJsonl(text: string): Observation[] {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) throw new CorpusError('the corpus file is empty');
  return parseCorpus(lines.map((l, i) => {
    try {
      return JSON.parse(l) as unknown;
    } catch (err) {
      throw new CorpusError(`line ${i + 1} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  }));
}

/** The tuple identity of a row, without the outcome. */
export function tupleKey(o: Observation): string {
  return `${o.trainNumber}|${o.board}|${o.alight}|${o.dateIso}|${o.klass}|${o.quota}`;
}

/**
 * Refuse a corpus that contradicts itself.
 *
 * Two rows for the same tuple with different outcomes is not noise to be averaged out — it means
 * one of them is wrong, or the tuple is not really the unit of observation (a missing field, a
 * quota that changed meaning, a date recorded as boarding rather than origin). Training on it
 * would fit the contradiction and the held-out metrics would still look fine, which is exactly why
 * it has to be caught here.
 */
export function rejectContradictions(rows: readonly Observation[]): void {
  const seen = new Map<string, Outcome>();
  for (const o of rows) {
    const key = tupleKey(o);
    const prev = seen.get(key);
    if (prev !== undefined && labelOf({ ...o, outcome: prev }) !== labelOf(o)) {
      throw new CorpusError(
        `contradictory ground truth for ${key}: recorded as both ${prev} and ${o.outcome}. `
        + 'One of them is wrong, or the tuple is missing a field that distinguishes them.',
      );
    }
    seen.set(key, o.outcome);
  }
}

/** One usable training example: the feature vector inference will also compute, plus its label. */
export interface TrainRow {
  features: ModelFeatures;
  label: 0 | 1;
  key: string;
}

/** Why a row could not become a training example. Counted, because the counts are the honest part. */
export type DropReason = 'unknown-train' | 'no-geometry' | 'features-refused';

export interface BuildResult {
  rows: TrainRow[];
  dropped: Record<DropReason, number>;
}

/**
 * Turn observations into training rows.
 *
 * Rows are dropped, never repaired, when the feature extractor declines them — and the drop counts
 * are returned rather than discarded, because they describe the population the model can actually
 * speak about. A model trained on the 60% of tuples where Tier 0 has a capacity denominator is
 * silently inapplicable to the other 40%, and the only defence against presenting it as universal
 * is that the number is written down.
 */
export function buildRows(
  observations: readonly Observation[],
  resolveTrain: GeometryResolver,
  opts: FeatureOptions,
): BuildResult {
  const dropped: Record<DropReason, number> = { 'unknown-train': 0, 'no-geometry': 0, 'features-refused': 0 };
  const rows: TrainRow[] = [];

  for (const o of observations) {
    // Two distinct gaps, counted separately because different work fixes them: a train the
    // timetable does not hold at all is a coverage gap, while a train it holds with fewer than two
    // stops is a geometry gap.
    const train = resolveTrain(o.trainNumber);
    if (train === null) {
      dropped['unknown-train']++;
      continue;
    }
    if (train.stops.length < 2) {
      dropped['no-geometry']++;
      continue;
    }
    const q: AvailabilityQuery = {
      trainNumber: o.trainNumber, board: o.board, alight: o.alight,
      dateIso: o.dateIso, klass: o.klass, quota: o.quota,
    };
    // `todayIso` is overridden per row with the date that ticket was booked, so daysToJourney means
    // "how far ahead this was bought" — the question the model is actually answering. Using the
    // caller's date would measure something else entirely and refuse most of the corpus.
    const features = segmentFeatures(q, train, { ...opts, todayIso: o.bookedOn });
    if (features === null) {
      dropped['features-refused']++;
      continue;
    }
    rows.push({ features, label: labelOf(o), key: tupleKey(o) });
  }

  return { rows, dropped };
}

/** Positive rate, which a gate needs and a reader of the report needs. */
export function positiveRate(rows: readonly TrainRow[]): number {
  if (rows.length === 0) return 0;
  let pos = 0;
  for (const r of rows) pos += r.label;
  return pos / rows.length;
}

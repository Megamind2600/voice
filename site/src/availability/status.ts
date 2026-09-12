/**
 * status.ts — the vocabulary of IRCTC seat availability.
 *
 * Availability is a string that comes from somewhere else (IRCTC, NTES, a relay, a user's own
 * API key) and has to be turned into something a traveller can act on. This module owns that
 * translation and nothing else: no predictions, no ranking by likelihood, no opinions about
 * whether a waitlist will clear. See the note on `waitlistSeverity` for why that line is drawn
 * exactly there.
 *
 * ---------------------------------------------------------------------------
 * THE THREE RULES THIS FILE EXISTS TO ENFORCE
 * ---------------------------------------------------------------------------
 *
 * 1. **Waitlist types are never collapsed.** `PQWL 8` and `GNWL 8` are not the same situation.
 *    Pooled quota is allotted to a short intermediate segment and frequently never clears;
 *    general quota has the whole cancellation cascade behind it. Anywhere that reduces both to
 *    "WL 8" has thrown away the single most decision-relevant fact on the screen. The type is
 *    therefore part of the parsed value, part of the formatted output, and part of the sort key.
 *
 * 2. **`UNKNOWN` is a real answer and is never coerced.** A parser that returns REGRET for text
 *    it does not recognise tells a traveller there are no seats when the truth is that nobody
 *    looked. Unparseable input stays `UNKNOWN`, with the original string preserved so the UI can
 *    show what it was given.
 *
 * 3. **RAC means you can travel.** Reservation Against Cancellation is a shared berth, not a
 *    waitlist. Treating `RAC 12` as "not confirmed, don't go" is the mistake that sends someone
 *    onto a bus they did not need to take.
 */

/** The five verdicts, ordered from "go" to "do not go". */
export type Verdict = 'AVAILABLE' | 'RAC' | 'WAITLISTED' | 'REGRET' | 'UNKNOWN';

/**
 * Waitlist type codes, in IRCTC's own vocabulary.
 *
 * `WL` alone appears when a source reports a position without saying which quota it belongs to.
 * It is kept as a distinct type rather than being silently promoted to `GNWL`, because guessing
 * the quota is exactly the kind of optimistic inference this file refuses to make.
 */
export type WaitlistType = 'GNWL' | 'WL' | 'RLWL' | 'PQWL' | 'RSWL' | 'CKWL' | 'TQWL';

export interface AvailabilityStatus {
  verdict: Verdict;
  /** Only meaningful when verdict is AVAILABLE: seats genuinely known to be free. */
  seats?: number;
  /** RAC position, when known. Present for RAC and for `GNWL14/RAC28`-style strings. */
  racPosition?: number;
  /** Waitlist position, when known. */
  wlPosition?: number;
  /** Never omitted when a waitlist position was parsed. See rule 1. */
  wlType?: WaitlistType;
  /** The string this was parsed from, verbatim. */
  raw: string;
  /** False when the text was not recognised — the UI must not present those as a verdict. */
  parsed: boolean;
}

/**
 * Severity of a waitlist type, as an ORDINAL — not a probability.
 *
 * Lower is better. These orderings are documented facts about how IRCTC allots quota and how the
 * cancellation cascade reaches it:
 *
 *   GNWL  general quota, the whole cascade behind it — best odds
 *   WL    quota not stated — unknown but treated as middling rather than assumed good
 *   RSWL  roadside, small quota
 *   RLWL  remote location (intermediate station), small quota
 *   PQWL  pooled, a short intermediate segment — worst; frequently never clears
 *   CKWL  Tatkal — no cancellation cascade exists, so it never clears
 *   TQWL  Tatkal — same
 *
 * This is deliberately an ordinal and deliberately not a `pConfirm`. Turning it into a number
 * like 0.62 would require a model trained on observed clearances, and there is no such training
 * data in this project. Publishing invented coefficients as a probability is the one failure mode
 * worse than publishing nothing, because it looks authoritative. The Tier 1 prediction model
 * that would produce a real `pConfirm` is specified in docs/01 §11 and needs data this repo does
 * not have yet.
 */
export const WAITLIST_SEVERITY: Readonly<Record<WaitlistType, number>> = {
  GNWL: 0,
  WL: 1,
  RSWL: 2,
  RLWL: 3,
  PQWL: 4,
  CKWL: 5,
  TQWL: 5,
};

/** Human-readable names, for the UI. */
export const WAITLIST_NAMES: Readonly<Record<WaitlistType, string>> = {
  GNWL: 'General waitlist',
  WL: 'Waitlist (quota not stated)',
  RSWL: 'Roadside waitlist',
  RLWL: 'Remote location waitlist',
  PQWL: 'Pooled quota waitlist',
  CKWL: 'Tatkal waitlist',
  TQWL: 'Tatkal waitlist',
};

/**
 * The plain-language consequence of a waitlist type. Shown next to the position, because a
 * number without its quota is not actionable.
 */
export const WAITLIST_OUTLOOK: Readonly<Record<WaitlistType, string>> = {
  GNWL: 'Best odds of clearing — the full cancellation cascade applies.',
  WL: 'Quota not stated, so the odds cannot be judged from this alone.',
  RSWL: 'Small quota; clears less often than a general waitlist of the same number.',
  RLWL: 'Intermediate-station quota, small; clears less often than general.',
  PQWL: 'Pooled quota for a short segment. Materially worse than the same number on general quota, and frequently never clears.',
  CKWL: 'Tatkal waitlist. There is no cancellation cascade against Tatkal, so this essentially never clears.',
  TQWL: 'Tatkal waitlist. There is no cancellation cascade against Tatkal, so this essentially never clears.',
};

const WL_TYPES = 'GNWL|WL|RLWL|PQWL|RSWL|CKWL|TQWL';

/**
 * Patterns in the order they must be tried.
 *
 * Order is load-bearing, not stylistic. `GNWL14/RAC28` also matches the bare-waitlist pattern,
 * so the combined form has to be tried first or the RAC position is lost. `RAC 12` has to be
 * tried before the waitlist patterns only in the sense that they do not overlap — but
 * `AVAILABLE-0000` must not fall through to a waitlist reading either.
 */
const PATTERNS: ReadonlyArray<readonly [RegExp, (m: RegExpMatchArray) => AvailabilityStatus]> = [
  [/^AVAILABLE[-\s]?0*(\d+)$/i, (m) => ({ verdict: 'AVAILABLE', seats: Number(m[1]), raw: '', parsed: true })],
  [/^(?:RAC)\s*0*(\d+)/i, (m) => ({ verdict: 'RAC', racPosition: Number(m[1]), raw: '', parsed: true })],
  [new RegExp(`^(${WL_TYPES})\\s*0*(\\d+)\\s*/\\s*RAC\\s*0*(\\d+)`, 'i'),
    (m) => ({
      verdict: 'WAITLISTED', wlType: m[1].toUpperCase() as WaitlistType,
      wlPosition: Number(m[2]), racPosition: Number(m[3]), raw: '', parsed: true,
    })],
  [new RegExp(`^(${WL_TYPES})\\s*0*(\\d+)`, 'i'),
    (m) => ({
      verdict: 'WAITLISTED', wlType: m[1].toUpperCase() as WaitlistType,
      wlPosition: Number(m[2]), raw: '', parsed: true,
    })],
  [/^(?:REGRET|NOT\s*AVAILABLE|NO\s*SEATS|BOOKING\s*CLOSED|NA)/i,
    () => ({ verdict: 'REGRET', raw: '', parsed: true })],
];

/**
 * Parse an availability string from any source.
 *
 * Returns `UNKNOWN` with `parsed: false` for anything unrecognised, including null and the empty
 * string. Never throws: availability text arrives from third parties and a malformed string must
 * not take down a results screen.
 */
export function parseStatus(raw: string | null | undefined): AvailabilityStatus {
  const text = (raw ?? '').trim();
  if (text.length === 0) return { verdict: 'UNKNOWN', raw: raw ?? '', parsed: false };

  for (const [re, build] of PATTERNS) {
    const m = re.exec(text);
    if (m) return { ...build(m), raw: text };
  }
  // Unrecognised. Preserving the original matters: showing the traveller the actual string lets
  // them judge it themselves, which is strictly better than a confident wrong verdict.
  return { verdict: 'UNKNOWN', raw: text, parsed: false };
}

/**
 * Render a status the way IRCTC would, preserving the waitlist type.
 *
 * Round-trips with `parseStatus` for every string that parser recognises, which the tests assert
 * — a formatter that loses the quota is the same bug as a parser that does.
 */
export function formatStatus(s: AvailabilityStatus): string {
  switch (s.verdict) {
    case 'AVAILABLE':
      return `AVAILABLE-${String(s.seats ?? 0).padStart(4, '0')}`;
    case 'RAC':
      return `RAC ${s.racPosition ?? 0}`;
    case 'WAITLISTED': {
      const head = `${s.wlType ?? 'WL'}${s.wlPosition ?? 0}`;
      return s.racPosition !== undefined ? `${head}/RAC${s.racPosition}` : head;
    }
    case 'REGRET':
      return 'REGRET';
    case 'UNKNOWN':
    default:
      // Show what was actually received. An empty "UNKNOWN" hides the fact that a source said
      // something this build could not read.
      return s.parsed ? 'UNKNOWN' : (s.raw.length > 0 ? `UNKNOWN (“${s.raw}”)` : 'UNKNOWN');
  }
}

/**
 * Whether this status means the traveller can board.
 *
 * AVAILABLE and RAC both mean yes. RAC is a shared berth — uncomfortable, but a seat on the
 * train, and treating it otherwise pushes people onto buses they did not need.
 */
export function canTravel(s: AvailabilityStatus): boolean {
  return s.verdict === 'AVAILABLE' || s.verdict === 'RAC';
}

/**
 * Whether this status is worth acting on: it says something definite either way.
 *
 * UNKNOWN is not actionable — the honest response to it is "check IRCTC", not "try a remedy".
 */
export function isDefinite(s: AvailabilityStatus): boolean {
  return s.verdict !== 'UNKNOWN';
}

/**
 * Sort key for a list of statuses, best first.
 *
 * Verdict dominates, then waitlist type severity, then position. Note what is NOT in here: fare.
 * Ranking a worse-availability option above a better one because it is cheaper is how a planning
 * tool starts looking like it is advising arbitrage, and docs/04 §5 forbids it explicitly.
 */
export function compareStatus(a: AvailabilityStatus, b: AvailabilityStatus): number {
  const VERDICT_RANK: Record<Verdict, number> = {
    AVAILABLE: 0, RAC: 1, WAITLISTED: 2, REGRET: 3, UNKNOWN: 4,
  };
  const dv = VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict];
  if (dv !== 0) return dv;

  if (a.verdict === 'AVAILABLE' && b.verdict === 'AVAILABLE') {
    return (b.seats ?? 0) - (a.seats ?? 0); // more seats first
  }
  if (a.verdict === 'WAITLISTED' && b.verdict === 'WAITLISTED') {
    const dt = (WAITLIST_SEVERITY[a.wlType ?? 'WL']) - (WAITLIST_SEVERITY[b.wlType ?? 'WL']);
    if (dt !== 0) return dt;
    return (a.wlPosition ?? 0) - (b.wlPosition ?? 0); // lower position first
  }
  if (a.verdict === 'RAC' && b.verdict === 'RAC') {
    return (a.racPosition ?? 0) - (b.racPosition ?? 0);
  }
  return 0;
}

/**
 * The worst status across a set of legs.
 *
 * An itinerary is only as bookable as its least bookable leg, so this is what a multi-leg result
 * should be summarised by. A journey that is AVAILABLE on two legs and PQWL 40 on the third is a
 * PQWL 40 journey, and presenting it as "2 of 3 legs available" would be the optimistic framing
 * this module exists to prevent.
 */
export function worstStatus(statuses: readonly AvailabilityStatus[]): AvailabilityStatus {
  if (statuses.length === 0) return { verdict: 'UNKNOWN', raw: '', parsed: false };
  return statuses.reduce((worst, s) => (compareStatus(s, worst) > 0 ? s : worst));
}

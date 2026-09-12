/**
 * split.ts — remedy ①: two tickets on consecutive segments of the SAME train.
 *
 * This is usually the best answer and it is also the one part of the product that sits in a
 * legal grey area, so it is implemented defensively: every candidate carries its disclosures,
 * the thresholds that block a bad suggestion are constants rather than judgement calls made at
 * render time, and nothing here ranks a split above a direct ticket.
 *
 * ---------------------------------------------------------------------------
 * WHY SPLITTING WORKS AT ALL
 * ---------------------------------------------------------------------------
 * IRCTC allots quota preferentially to longer segments and to the full run. A short intermediate
 * hop frequently returns `REGRET` while the same train end-to-end shows seats — and the converse
 * also happens: the full run is waitlisted while each half, being a substantial share of the
 * rake, has its own allotment. Splitting turns one question about a scarce pool into two
 * questions about two larger ones.
 *
 * It is not free. Two tickets means two reservation charges, two chances of one leg being
 * waitlisted, and a physical change of berth or coach at the split station, possibly at night,
 * possibly in a short halt.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE REFUSES TO DO
 * ---------------------------------------------------------------------------
 * - It never suggests a split where the halt is under 10 minutes. Someone cannot reliably
 *   detrain, find another coach and reboard in the time a signal check takes.
 * - It never suggests anything readable as fare evasion. A split is only offered where the
 *   passenger genuinely alights and reboards on two valid tickets that between them cover
 *   exactly the journey. Booking a short segment and riding further is ticketless travel.
 * - It never ranks by fare. docs/04 §5 is explicit that confidence gain is the only ranking
 *   signal, because a split presented as "cheaper" starts to read as arbitrage advice. Since
 *   confidence requires availability data this build does not have, candidates come back in
 *   station order with their facts attached and the UI is required to say that ranking is not
 *   yet possible.
 * - It never presents a split as the only option. The direct, waitlisted itinerary is always
 *   shown alongside, so the compliant path is always visible.
 */

import type { Stop } from '../lib/graph';

/** Below this halt, a split is not offered at all. */
export const MIN_SPLIT_HALT_MIN = 10;
/** Below this halt, a split is offered with a rushed-change warning. */
export const WARN_SPLIT_HALT_MIN = 20;
/**
 * Below this segment length, the second ticket's fixed charges usually outweigh any quota
 * benefit, and a very short segment is exactly the kind that gets a small pooled allotment.
 * Flagged rather than blocked, because on some rakes it is still the right call.
 */
export const SHORT_SEGMENT_KM = 100;

/** Standard reservation charge, per ticket, in the class being priced. */
export const DEFAULT_RESERVATION_RUPEES = 40;

export interface SplitCandidate {
  station: number;
  code: string;
  name: string;
  /** How long the train stands here. The whole feasibility question. */
  haltMin: number;
  firstKm: number;
  secondKm: number;
  /** Share of the boarded run each half covers, 0..1. Long shares get better allotment. */
  firstShare: number;
  secondShare: number;
  /** What splitting costs over one ticket, from the second reservation charge alone. */
  extraReservationRupees: number;
  /** Set when this split must NOT be offered, with the reason. Never null-and-also-offered. */
  blocked: string | null;
  /** Set when the split is offered but needs a caveat beyond the standing disclosures. */
  warning: string | null;
  /**
   * The disclosures, always present and always complete, in reading order.
   *
   * Not a UI concern: they are generated here so that no rendering path can forget them. A
   * component that has to remember to add a warning will eventually be refactored by someone
   * who does not know why it was there.
   */
  disclosures: string[];
}

export interface SplitOptions {
  /** The train's stops in route order. */
  stops: readonly Stop[];
  boardStation: number;
  alightStation: number;
  reservationRupees?: number;
}

/**
 * Enumerate every intermediate stop where this journey could be split into two tickets.
 *
 * Returns candidates in route order, including blocked ones. Blocked candidates are returned
 * rather than dropped so a caller can explain why a station the traveller might have thought of
 * is not being offered — "Ratnagiri has a 6-minute halt" is a more useful answer than silence.
 */
export function splitCandidates(opts: SplitOptions): SplitCandidate[] {
  const { stops, boardStation, alightStation } = opts;
  const reservation = opts.reservationRupees ?? DEFAULT_RESERVATION_RUPEES;

  const boardIx = stops.findIndex((s) => s.station === boardStation);
  const alightIx = stops.findIndex((s) => s.station === alightStation);
  // Order matters: a train that passes the same station twice is rare but not impossible, and
  // `findIndex` returning the wrong one would produce a split that travels backwards.
  if (boardIx < 0 || alightIx < 0 || alightIx <= boardIx + 1) return [];

  const totalKm = stops[alightIx].distKm - stops[boardIx].distKm;
  if (totalKm <= 0) return [];

  const out: SplitCandidate[] = [];
  for (let i = boardIx + 1; i < alightIx; i++) {
    const stop = stops[i];
    const firstKm = stop.distKm - stops[boardIx].distKm;
    const secondKm = stops[alightIx].distKm - stop.distKm;
    const halt = stop.haltMin;

    let blocked: string | null = null;
    let warning: string | null = null;

    if (halt <= 0) {
      blocked = `The train does not halt at ${stop.name}, so you cannot detrain and reboard here.`;
    } else if (halt < MIN_SPLIT_HALT_MIN) {
      blocked = `The halt at ${stop.name} is only ${halt} minute${halt === 1 ? '' : 's'} — not enough to change coaches reliably.`;
    }
    if (!blocked && halt < WARN_SPLIT_HALT_MIN) {
      warning = `The halt at ${stop.name} is ${halt} minutes, which is a rushed change. Travel light and know your coach position before you arrive.`;
    }
    if (!blocked && (firstKm < SHORT_SEGMENT_KM || secondKm < SHORT_SEGMENT_KM)) {
      const short = firstKm < SHORT_SEGMENT_KM ? firstKm : secondKm;
      warning = (warning ? `${warning} ` : '')
        + `One half is only ${short} km. Short segments get a small quota allotment and often show REGRET even when the same train end-to-end has seats, so this split may be worse than the direct ticket.`;
    }

    const firstShare = firstKm / totalKm;
    out.push({
      station: stop.station,
      code: stop.code,
      name: stop.name,
      haltMin: halt,
      firstKm,
      secondKm,
      firstShare,
      secondShare: secondKm / totalKm,
      extraReservationRupees: reservation,
      blocked,
      warning,
      disclosures: disclosuresFor(stop.name, halt, firstKm, secondKm),
    });
  }
  return out;
}

/** Candidates that may actually be offered. */
export function offerable(candidates: readonly SplitCandidate[]): SplitCandidate[] {
  return candidates.filter((c) => c.blocked === null);
}

/**
 * The five disclosures docs/04 §5 requires, inline and non-dismissible, with the specifics of
 * this split filled in.
 *
 * The wording is deliberately plain about the legal position. Calling this "a trick that works"
 * would be both wrong and the kind of thing that gets a traveller into an argument with a
 * ticket examiner at 2 a.m.
 */
export function disclosuresFor(stationName: string, haltMin: number, firstKm: number, secondKm: number): string[] {
  const haltText = haltMin > 0
    ? (haltMin < WARN_SPLIT_HALT_MIN
      ? `The halt is ${haltMin} minute${haltMin === 1 ? '' : 's'} — that is a rushed change. Bring light luggage.`
      : `The halt is ${haltMin} minutes.`)
    : 'The train does not halt here.';

  return [
    'Requires TWO separate tickets for consecutive segments of the SAME train.',
    `You will need to change berths or coaches at ${stationName}.`,
    haltText,
    'IRCTC rules contemplate one ticket per journey. This is commonly practised but sits in a '
      + 'grey area and could in principle be questioned by ticket-checking staff. Verify with '
      + 'IRCTC before travelling.',
    'If either segment does not confirm, you may be left holding a partial journey.',
    `Between them the two tickets cover ${firstKm + secondKm} km in ${Math.round(firstKm)} km and `
      + `${Math.round(secondKm)} km segments — the same distance as the direct ticket, so this is `
      + 'a change of paperwork, not a shorter journey.',
  ];
}

/**
 * The honest framing every split suggestion must carry.
 *
 * Kept as a constant so it cannot be quietly dropped from one call site and kept in another.
 */
export const SPLIT_FRAMING =
  'A strategy experienced travellers use, with real trade-offs — not a trick that works. '
  + 'The direct ticket is always shown alongside it, and nothing here ranks a split above a '
  + 'confirmed direct seat.';

/**
 * Why no ordering is applied to these candidates.
 *
 * Ranking requires knowing how much more likely each half is to confirm than the whole, and that
 * needs availability data. Ordering by anything available instead — fare, halt length, distance
 * — would dress a guess up as a recommendation.
 */
export const RANKING_UNAVAILABLE =
  'These are listed in station order, not best first. Ranking them needs seat availability for '
  + 'each half against the whole, which this build does not have. Checking them on IRCTC in the '
  + 'order they appear is reasonable; assuming the first is the best is not.';

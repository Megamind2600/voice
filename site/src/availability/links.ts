/**
 * links.ts — handing the traveller to IRCTC, using only URLs that were verified.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS AND IS NOT HERE, AND WHY
 * ---------------------------------------------------------------------------
 * The three URLs below were confirmed by fetching `irctc.co.in/nget/train-search` on 2026-09-12
 * and reading them out of the live page: the booking search page, the charts/vacancy page, and
 * Indian Railways' PNR enquiry. They are stable, official, and useful on their own.
 *
 * What is deliberately NOT here is a pre-filled deep link such as
 * `...?fromStation=NDLS&toStation=BCT&dateOfJourney=...`. No verified parameter contract for
 * that was found: the booking page is a JavaScript single-page app whose form state is not
 * exposed in the served HTML, and the parameter names are not published. Inventing them would
 * produce a link that lands on a blank form while looking like it had worked — which is worse
 * than a plain link, because it teaches the traveller not to trust the ones that do work.
 *
 * So the handoff is honest instead: link to the real page, and hand over the exact values to
 * type, in a form that can be copied in one tap. That costs the traveller about ten seconds and
 * never sends them somewhere broken. If the parameter contract is ever verified — by watching a
 * real pre-filled link resolve, not by guessing — `prefill` is the single place it would go.
 *
 * One genuinely valuable link came out of that fetch: **`/online-charts/`**, IRCTC's own charts
 * and vacancy page. For a journey that is already charted, that is live ground truth about empty
 * berths, from the authority itself, with no API and no key. This build cannot predict
 * availability, but it can point at the one place that states it.
 */

import type { AvailabilityQuery } from './tier';

/** Booking search page. Verified live 2026-09-12. */
export const IRCTC_TRAIN_SEARCH = 'https://www.irctc.co.in/nget/train-search';

/** Charts and vacancy. Verified live 2026-09-12. The best free ground truth IRCTC publishes. */
export const IRCTC_CHARTS_VACANCY = 'https://www.irctc.co.in/online-charts/';

/** PNR enquiry, linked from IRCTC's own header. Verified live 2026-09-12. */
export const INDIANRAIL_PNR_ENQUIRY = 'http://www.indianrail.gov.in/enquiry/PNR/PnrEnquiry.html?locale=en';

/**
 * Where a pre-filled link would be built, once the parameter contract is verified.
 *
 * Returns null today. Keeping the function rather than deleting the idea means the call sites in
 * the UI are already written and tested against the fallback, so wiring it up later is a
 * one-function change rather than a redesign.
 */
export function prefill(_q: AvailabilityQuery): string | null {
  return null;
}

/**
 * The values to enter on IRCTC, in the order the form asks for them.
 *
 * Ordered to match the page: From, To, Date, Class, Quota. A traveller copying these by hand
 * should not have to work out the sequence.
 */
export function handoffFields(q: AvailabilityQuery): ReadonlyArray<{ label: string; value: string }> {
  const [y, m, d] = q.dateIso.split('-');
  return [
    { label: 'From', value: q.board },
    { label: 'To', value: q.alight },
    { label: 'Date', value: `${d}/${m}/${y}` }, // IRCTC's form is DD/MM/YYYY, not ISO
    { label: 'Class', value: q.klass },
    { label: 'Quota', value: q.quota },
    { label: 'Train', value: q.trainNumber },
  ];
}

/** One line per field, for copying into a notes app or pasting to a travelling companion. */
export function handoffText(q: AvailabilityQuery): string {
  return handoffFields(q).map((f) => `${f.label}: ${f.value}`).join('\n');
}

export interface Handoff {
  /** Where to send the traveller. Always the verified page, never a guess. */
  url: string;
  /** True when the URL carries the query. False today; see `prefill`. */
  prefilled: boolean;
  fields: ReadonlyArray<{ label: string; value: string }>;
  copyText: string;
  /** Shown when the link could not be pre-filled, so the extra typing is explained. */
  note: string | null;
  /** Live ground truth for a charted journey. */
  chartsUrl: string;
}

/**
 * Build the handoff for one leg.
 *
 * `note` is not optional decoration: it explains why the traveller is about to type six values
 * into a form. Without it, a non-prefilled link reads as though the app failed.
 */
export function handoff(q: AvailabilityQuery): Handoff {
  const url = prefill(q) ?? IRCTC_TRAIN_SEARCH;
  return {
    url,
    prefilled: prefill(q) !== null,
    fields: handoffFields(q),
    copyText: handoffText(q),
    note: prefill(q) === null
      ? 'IRCTC does not publish a way to pre-fill this form, so the details are listed here to '
        + 'copy across. Opening a link that silently dropped your train and date would be worse '
        + 'than ten seconds of typing.'
      : null,
    chartsUrl: IRCTC_CHARTS_VACANCY,
  };
}

/**
 * The NTES live-running-status enquiry.
 *
 * Deliberately the bare enquiry page rather than a per-train deep link, for the same reason as
 * above: the base enquiry URL is long-standing and widely published, but a verified per-train
 * parameter contract was not confirmed here, and a wrong one produces a page that looks like it
 * loaded and says nothing about the train that was asked for.
 */
export const NTES_ENQUIRY = 'https://enquiry.indianrail.gov.in/mntes/';

/**
 * Whether a URL in this module is one that was actually verified.
 *
 * Exists so a test can assert the invariant directly: if someone adds a deep link later, this
 * list has to be updated consciously, and the test that reads it will fail until they explain
 * where the URL came from.
 */
export const VERIFIED_URLS: readonly string[] = [
  IRCTC_TRAIN_SEARCH,
  IRCTC_CHARTS_VACANCY,
  INDIANRAIL_PNR_ENQUIRY,
];

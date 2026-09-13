/**
 * SeatEstimate.tsx — the estimated-availability block.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS ALLOWED TO SAY
 * ---------------------------------------------------------------------------
 * This is the app estimating, not reporting. Nothing here came from IRCTC, and the words must
 * never let a reader believe otherwise: no "available", no "confirmed", no bare berth count
 * without `≈` and a range beside it. The badge is not decoration — it is the difference between
 * a planning hint and a claim the app cannot support.
 *
 * Everything shown comes from `availability/estimate.ts`, which owns the arithmetic and the
 * wording. This component lays it out, and it deliberately offers no way to render the number
 * without the sentence that qualifies it: the headline, the factors, the confidence note and the
 * caveats are one block, and the caveats are not collapsible.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FACTORS ARE SHOWN AT ALL
 * ---------------------------------------------------------------------------
 * An estimate a traveller cannot argue with is an estimate they have to either trust or ignore.
 * "12 days out", "Sunday departure", "festival run-up" are things a person can check against
 * their own experience and disagree with — and the disagreement is the useful part, because it
 * is usually about a fact this model cannot see (a wedding party, an exam season). So the
 * arithmetic goes behind a disclosure rather than into a tooltip: available to anyone who wants
 * it, out of the way of anyone who does not.
 */
import type { SeatEstimate } from '../availability/estimate';
import { ESTIMATE_BADGE, ESTIMATE_METHOD } from '../availability/estimate';

export interface SeatEstimateBoxProps {
  estimate: SeatEstimate;
}

/** One multiplier, as a line a person can check. */
function Factor({ label, detail, effect }: { label: string; detail: string; effect: number }) {
  return (
    <li class="est__factor">
      <strong>{label}</strong> {detail}
      <span class="est__x" title="Demand multiplier applied by this factor">×{effect.toFixed(2)}</span>
    </li>
  );
}

export function SeatEstimateBox({ estimate: e }: SeatEstimateBoxProps) {
  const unknown = e.verdict === 'UNKNOWN';

  return (
    <div class="est">
      <p class="est__headline">
        <span class="est__badge">{ESTIMATE_BADGE}</span>
        {e.headline}
      </p>

      {!unknown && e.pool && (
        <p class="est__pool">
          Of the {e.capacity ? `${e.capacity.low.toLocaleString('en-IN')}–${e.capacity.high.toLocaleString('en-IN')}` : 'several'}
          {' '}{e.klass} berths on this train, roughly{' '}
          <strong>{e.pool.low.toLocaleString('en-IN')}–{e.pool.high.toLocaleString('en-IN')}</strong>{' '}
          are the pool this leg is competing for — the rest belong to passengers riding further.
          {e.confidenceReasons.length > 0 && ` Confidence is low here because ${e.confidenceReasons.join(', and ')}.`}
        </p>
      )}

      <details class="est__how">
        <summary>How this was worked out</summary>
        <p class="est__method">
          Method <code>{ESTIMATE_METHOD}</code> — a structural model, not a fitted one, and not
          calibrated against observed bookings. The multipliers below are the whole of it, so the
          estimate can be argued with rather than merely believed.
        </p>
        <ul class="est__factors">
          {e.factors.map((f) => <Factor key={f.label} label={f.label} detail={f.detail} effect={f.effect} />)}
        </ul>
        <p class="est__note">
          Demand index <strong>{e.loadIndex.toFixed(2)}</strong> — below 1.00 means the leg is
          modelled as undersubscribed at departure, above it means oversubscribed.
        </p>
      </details>

      <ul class="est__caveats">
        {e.caveats.map((c) => <li key={c}>{c}</li>)}
      </ul>
    </div>
  );
}

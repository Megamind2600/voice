/**
 * AvailabilityPanel.tsx — what this build can honestly say about seats on one leg.
 *
 * It cannot say whether there is a seat. No availability source is connected, and inventing one
 * would be the single most damaging thing this app could do. What it CAN say is a surprising
 * amount, all of it verifiable and none of it guessed:
 *
 *   - whether this journey is inside the 60-day advance window yet, and the exact morning it
 *     opens, counted from the date the train leaves its ORIGIN rather than the date you board;
 *   - when Tatkal opens for this class, or that this class has no Tatkal quota at all;
 *   - that IRCTC is down for maintenance between 23:45 and 00:20 IST, if that is now;
 *   - the exact six values to enter on IRCTC for this leg, in the order the form asks for them,
 *     copyable in one tap;
 *   - IRCTC's own charts-and-vacancy page, which is live ground truth once a journey is charted.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO DEEP LINK
 * ---------------------------------------------------------------------------
 * The handoff opens IRCTC's booking page and lists the values beside it, rather than opening a
 * pre-filled URL. IRCTC does not publish a parameter contract for that form — it is a JavaScript
 * app whose state is not in the served HTML — and a guessed link lands on a blank form while
 * looking like it worked. Ten seconds of typing beats teaching someone not to trust the links.
 * See availability/links.ts, which is the single place a verified contract would go.
 */
import { useState } from 'preact/hooks';
import type { RailSegment } from '../router/journey';
import type { StationResolver } from '../router/journey';
import { bookingFacts, istNow } from '../availability/rules';
import { PREDICTED_BADGE, predictionText } from '../availability/model';
import type { AvailabilityReading } from '../availability/tier';
import { handoff } from '../availability/links';
import { capacityFor, staticallyImpossible } from '../availability/rake';
import type { TrainFacts } from '../availability/rake';

export interface AvailabilityPanelProps {
  segment: RailSegment;
  nameOf: StationResolver;
  /** ISO date of the traveller's query. */
  dateIso: string;
  /** Quota to check. General is the default and the one nearly everyone books under. */
  quota?: string;
  /**
   * A reading from the availability cascade, when anything produced one.
   *
   * Optional and, in this build, never passed: no source is wired up, so there is nothing to hand
   * over. The prop exists so that the day a coefficient table ships, rendering a prediction is a
   * matter of passing one in rather than a change to this component — and so that the badge
   * discipline is already in place and already tested instead of being added in a hurry alongside
   * the model.
   *
   * Only a PREDICTED reading with a `prediction` attached renders anything here. A LIVE or SNAPSHOT
   * reading would need its own treatment — an age, a source name, a "verified at" line — and
   * inventing that now, for a tier that does not exist, is how a panel ends up claiming freshness
   * it cannot prove.
   */
  reading?: AvailabilityReading | null | undefined;
}

export function AvailabilityPanel(props: AvailabilityPanelProps) {
  const { segment: s, nameOf, dateIso } = props;
  const quota = props.quota ?? 'GN';
  const prediction = props.reading?.prediction ?? null;
  const [copied, setCopied] = useState(false);

  const from = nameOf(s.from);
  const to = nameOf(s.to);
  const now = istNow();
  const facts = bookingFacts(dateIso, s.serviceDayOffset, s.klass, now.dateIso, now.minuteOfDay);
  // Tier 0 needs nothing but what the segment already carries: the train's type and its full
  // class list. It answers two questions the timetable alone cannot — how many berths this class
  // roughly has, and whether the requested class/quota pair can exist at all.
  const trainFacts: TrainFacts = {
    type: s.trainType,
    classes: s.trainClasses,
    classesInferred: s.classesInferred,
    distanceKm: s.distKm,
  };
  const capacity = capacityFor(trainFacts, s.klass);
  const ruledOut = staticallyImpossible(
    {
      trainNumber: s.trainNumber, board: from.code, alight: to.code,
      dateIso: facts.originDate, klass: s.klass, quota,
    },
    trainFacts,
  );

  const hand = handoff({
    trainNumber: s.trainNumber,
    board: from.code,
    alight: to.code,
    dateIso: facts.originDate,
    klass: s.klass,
    quota,
  });

  const copy = async (): Promise<void> => {
    // The same two-step as ExportMenu: the clipboard API where it exists, a hidden textarea and
    // execCommand where it does not. Losing the button entirely on an older browser or an
    // insecure origin would be worse than using a deprecated API.
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(hand.copyText);
      } else {
        throw new Error('no clipboard API');
      }
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = hand.copyText;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      } catch {
        setCopied(false);
        return;
      }
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 4000);
  };

  return (
    <div class="avail">
      <p class="avail__headline">
        <strong>Seat availability: not connected in this build.</strong>{' '}
        {prediction === null
          ? 'Nothing here says whether a berth exists, and no number on this page should be read as one that does. What follows is what can be stated without guessing.'
          // The headline has to change when a forecast appears, or it contradicts the block below
          // it: "nothing here says whether a berth exists" is no longer the whole truth, and the
          // whole truth is that something here estimates the odds.
          : 'What follows is what can be stated without guessing, plus one model estimate — which is a probability about a berth, not a berth.'}
      </p>

      {prediction !== null && (
        <div class="avail__predicted">
          <p class="avail__predicted-line">
            <span class="avail__badge avail__badge--predicted">{PREDICTED_BADGE}</span>
            {predictionText(prediction)}
          </p>
          <p class="avail__note">
            Estimates are how every confirmation-probability feature works, including the commercial
            ones: nobody can see IRCTC's remaining berths from outside. Treat this as a hint about
            which dates and routes to prefer, then confirm on IRCTC before paying for anything.
          </p>
        </div>
      )}

      {ruledOut && (
        <p class="avail__ruledout">
          <strong>This combination cannot be booked.</strong> {ruledOut}
        </p>
      )}

      {!ruledOut && capacity && (
        <p class="avail__capacity">
          <span class="avail__badge">estimate</span>
          Roughly <strong>{capacity.low.toLocaleString('en-IN')}–{capacity.high.toLocaleString('en-IN')}</strong>{' '}
          {capacity.klass} berths exist on this train. {capacity.basis}
        </p>
      )}

      {facts.notes.length > 0 && (
        <ul class="avail__notes">
          {facts.notes.map((n) => <li key={n}>{n}</li>)}
        </ul>
      )}

      <div class="avail__handoff">
        <p class="avail__lead">
          To check this leg on IRCTC, enter exactly these — the date shown is the train's{' '}
          <strong>origin</strong> departure date, which is what every booking window counts from.
        </p>
        <dl class="avail__fields">
          {hand.fields.map((f) => (
            <div class="avail__field" key={f.label}>
              <dt>{f.label}</dt>
              <dd>{f.value}</dd>
            </div>
          ))}
        </dl>

        <p class="avail__actions">
          <a class="btn" href={hand.url} target="_blank" rel="noopener noreferrer">
            Open IRCTC booking
          </a>
          <a class="btn" href={hand.chartsUrl} target="_blank" rel="noopener noreferrer">
            Charts &amp; vacancy
          </a>
          <button type="button" class="btn" onClick={() => void copy()}>
            {copied ? 'Copied' : 'Copy these details'}
          </button>
        </p>

        {hand.note && <p class="avail__note">{hand.note}</p>}
        <p class="avail__note">
          The charts page is IRCTC's own published vacancy for journeys that have already been
          charted — the closest thing to ground truth that needs no account and no key.
        </p>
      </div>
    </div>
  );
}

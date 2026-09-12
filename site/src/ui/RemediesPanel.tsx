/**
 * RemediesPanel.tsx — the seven things to try when a leg will not confirm.
 *
 * This is the feature the whole project exists for. A planner that says "waitlisted" and stops is
 * a departure board; one that says "waitlisted, and here is what an experienced traveller would
 * try, with what each option costs and which of them cannot be answered without IRCTC" is the
 * thing someone actually plans a holiday around.
 *
 * ---------------------------------------------------------------------------
 * THREE DECISIONS THAT SHAPE THIS FILE
 * ---------------------------------------------------------------------------
 * 1. It is lazy. Remedies are computed when a traveller opens the panel, not for every leg of
 *    every itinerary — a search can return two hundred itineraries of three legs each, and
 *    building seven remedies for six hundred legs nobody will read is how a free tool becomes
 *    slow. It also needs the train's stop list, which is a worker round trip.
 *
 * 2. It renders the exact question rather than an answer. Four of the seven remedies change what
 *    IRCTC would be asked, and no availability source is connected in this build. So each option
 *    that poses a query shows the query in IRCTC's own field order — train, from, to, date, class,
 *    quota — which the traveller can read out, copy, or type into the booking form. Guessing at
 *    the answer is the one thing this panel must not do.
 *
 * 3. The split disclosures are not optional and not dismissable. They arrive on the candidate
 *    itself (see split.ts, which generates them so no rendering path can forget), and there is no
 *    close button, because a warning that can be dismissed is a warning that will be.
 */
import { useCallback, useContext, useState } from 'preact/hooks';
import type { RailSegment } from '../router/journey';
import type { Stop } from '../lib/graph';
import type { Remedy } from '../availability/remedies';
import { remediesForLeg, remediesSummary } from '../availability/remedies';
import { handoff } from '../availability/links';
import { buildRemedyContext, stopsFromRaw } from '../state/remedyContext';
import { router } from '../state/client';
import { PlannerDepsContext } from './deps';

export interface RemediesPanelProps {
  segment: RailSegment;
  /** Station codes: the segment carries indices, and IRCTC speaks codes. */
  boardCode: string;
  alightCode: string;
  /** ISO date the traveller searched for, so a service-day offset becomes a calendar day. */
  dateIso: string;
  /** How many other itineraries the router found for the same destination. */
  alternativeItineraries: number;
  /** True when the itinerary this leg belongs to already includes a road hop. */
  roadHopPresent: boolean;
}

type Phase = 'idle' | 'loading' | 'ready' | 'error';

/** The query an option would pose, in IRCTC's own field order and date format. */
function questionText(o: { query: { trainNumber: string; board: string; alight: string; dateIso: string; klass: string; quota: string } | null }): string | null {
  if (!o.query) return null;
  const q = o.query;
  const fields = handoff({
    trainNumber: q.trainNumber, board: q.board, alight: q.alight,
    dateIso: q.dateIso, klass: q.klass, quota: q.quota,
  }).fields;
  return fields.map((f) => `${f.label} ${f.value}`).join(' · ');
}

export function RemediesPanel(props: RemediesPanelProps) {
  const deps = useContext(PlannerDepsContext);
  const [phase, setPhase] = useState<Phase>('idle');
  const [remedies, setRemedies] = useState<Remedy[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { segment: s, boardCode, alightCode, dateIso, alternativeItineraries, roadHopPresent } = props;

  const load = useCallback((): void => {
    if (!deps.stations) {
      setPhase('error');
      setError('The station list has not finished loading, so the stop list this needs is unavailable.');
      return;
    }
    const stations = deps.stations;
    setPhase('loading');
    router.request({ type: 'train:stops', train: s.trainIx })
      .then((r) => {
        const stops: Stop[] = stopsFromRaw(r.stops, stations);
        const ctx = buildRemedyContext({
          segment: s, stops, stations, groups: deps.groups, alternativeItineraries, roadHopPresent,
        });
        setRemedies(remediesForLeg({ segment: s, boardCode, alightCode, dateIso }, ctx));
        setPhase('ready');
      })
      .catch((err: unknown) => {
        setPhase('error');
        setError(err instanceof Error ? err.message : String(err));
      });
  }, [deps.stations, deps.groups, s, boardCode, alightCode, dateIso, alternativeItineraries, roadHopPresent]);

  return (
    <details
      class="remedies"
      onToggle={(e) => { if ((e.currentTarget as HTMLDetailsElement).open && phase === 'idle') load(); }}
    >
      <summary class="remedies__summary">
        If {s.klass} is waitlisted on this leg — what to try
      </summary>

      {phase === 'loading' && (
        <p class="remedies__busy">Reading this train's stop list…</p>
      )}

      {phase === 'error' && (
        <p class="remedies__error">
          Could not work out the options for this leg: {error}
        </p>
      )}

      {phase === 'ready' && remedies && (
        <div class="remedies__body">
          <p class="remedies__lead">
            {remediesSummary(remedies)} No availability source is connected in this build, so
            nothing below claims to know whether any of these would confirm.
          </p>

          {remedies.map((r) => (
            <section class="remedy" key={r.id}>
              <h4 class="remedy__title">
                {r.title}
                <span class={r.needsAvailability ? 'remedy__tag' : 'remedy__tag remedy__tag--now'}>
                  {r.needsAvailability ? 'needs availability' : 'from the timetable'}
                </span>
              </h4>
              <p class="remedy__why">{r.rationale}</p>
              {r.note && <p class="remedy__note">{r.note}</p>}

              {r.options.length === 0 && (
                <p class="remedy__none">No viable option on this leg.</p>
              )}

              {r.options.length > 0 && (
                <ul class="remedy__options">
                  {r.options.map((o, i) => (
                    <li class={o.ruledOut ? 'remedy__opt remedy__opt--out' : 'remedy__opt'} key={`${o.label}-${i}`}>
                      <span class="remedy__optlabel">{o.label}</span>
                      <span class="remedy__change">{o.change}</span>
                      {o.cost && <span class="remedy__cost">{o.cost}</span>}
                      {o.note && <span class="remedy__pool">{o.note}</span>}
                      {o.ruledOut
                        ? <span class="remedy__ruledout">Ruled out — {o.ruledOut}</span>
                        : questionText(o) && <span class="remedy__ask">Would ask IRCTC: {questionText(o)}</span>}
                    </li>
                  ))}
                </ul>
              )}

              {r.splitsBlocked && r.splitsBlocked.length > 0 && (
                <div class="remedy__blocked">
                  <p class="remedy__blockedlead">
                    Splits considered and ruled out, rather than quietly dropped:
                  </p>
                  <ul>
                    {r.splitsBlocked.map((c) => (
                      <li key={c.code}><strong>{c.name} ({c.code})</strong> — {c.blocked}</li>
                    ))}
                  </ul>
                </div>
              )}

              {r.splits && r.splits.length > 0 && (
                <div class="remedy__splits">
                  {r.splits.map((c) => (
                    <div class="remedy__split" key={c.code}>
                      <p class="remedy__splithead">
                        <strong>Split at {c.name} ({c.code})</strong> — {c.haltMin}-minute halt,
                        {' '}{Math.round(c.firstKm)} km then {Math.round(c.secondKm)} km,
                        {' '}about ₹{c.extraReservationRupees} more than one ticket.
                      </p>
                      {c.warning && <p class="remedy__warn">{c.warning}</p>}
                      {/* Non-dismissable by construction: there is no close button to render. */}
                      <ul class="remedy__disclosures">
                        {c.disclosures.map((d, i) => <li key={i}>{d}</li>)}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </section>
          ))}
        </div>
      )}
    </details>
  );
}

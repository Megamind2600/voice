/**
 * LegDetail.tsx — everything about one segment of an itinerary.
 *
 * ---------------------------------------------------------------------------
 * THE ONE THING THIS COMPONENT MUST NOT DO
 * ---------------------------------------------------------------------------
 * Imply that a seat is available. Phase 1 has no availability feed, so every fare here is a
 * published-tariff estimate and the component says so on every single leg rather than once in a
 * footer. A traveller who books on the strength of a number this app invented has been actively
 * harmed, and a disclaimer buried at the bottom of a long page does not reach them.
 *
 * The same discipline applies to provenance: a schedule whose running days were assumed rather
 * than sourced, or a class list inferred from the train's type, is flagged where it appears, so
 * "this train does not run on Tuesdays" is discoverable before the traveller is standing on the
 * platform on a Tuesday.
 */
import type { ComponentChildren } from 'preact';
import type { Segment } from '../router/journey';
import { classLabel, roadModeLabel, wallClock, dayOf } from '../router/journey';
import { durationLabel, rupees } from '../state/plan';
import type { StationResolver } from '../router/journey';

export interface LegDetailProps {
  segment: Segment;
  /** 1-based position in the itinerary, for "Leg 2 of 3". */
  index: number;
  total: number;
  nameOf: StationResolver;
  /** The query date, so a service-day offset can be turned into a real calendar day. */
  dateLabel: string;
}

/** A labelled fact. Small enough that inlining it eleven times would be noise. */
function Fact({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <div class="fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * Phrase a service-day offset as something a person can act on.
 *
 * "-1" means the train began its run the previous evening, which is the normal case for an
 * overnight departure and the reason a 01:10 boarding is possible at all.
 */
function serviceDayNote(offset: number, dateLabel: string): string | null {
  if (offset === 0) return null;
  if (offset === -1) return `This train started its run the evening before ${dateLabel}.`;
  return `This train started its run ${Math.abs(offset)} days before ${dateLabel}.`;
}

export function LegDetail(props: LegDetailProps) {
  const { segment: s, nameOf } = props;
  const from = nameOf(s.from);
  const to = nameOf(s.to);

  if (s.kind === 'road') {
    return (
      <div class="leg leg--road">
        <header class="leg__head">
          <span class="leg__badge">Leg {props.index} of {props.total}</span>
          <h4>{roadModeLabel(s.km)} across {s.city}</h4>
        </header>
        <p class="leg__route">
          <strong>{from.name}</strong> <span class="code">{from.code}</span>
          <span class="leg__arrow" aria-hidden="true">→</span>
          <strong>{to.name}</strong> <span class="code">{to.code}</span>
        </p>
        <dl class="facts">
          <Fact label="Departs">{wallClock(s.depMin)}{dayOf(s.depMin) > 0 ? ` (+${dayOf(s.depMin)}d)` : ''}</Fact>
          <Fact label="Arrives">{wallClock(s.arrMin)}{dayOf(s.arrMin) > 0 ? ` (+${dayOf(s.arrMin)}d)` : ''}</Fact>
          <Fact label="Allow">{durationLabel(s.minutes)}</Fact>
          <Fact label="Distance">{Math.round(s.km)} km</Fact>
          <Fact label="Cost">{rupees(s.costRupees)} <span class="est">est.</span></Fact>
        </dl>
        <p class="leg__note">
          Different terminals in the same city. This hop is a <strong>road transfer, not a change
          of train</strong>, so it does not count against your transfer limit.
          {s.estimated && ' The time is an estimate for this city rather than a measured distance.'}
        </p>
      </div>
    );
  }

  const dayNote = serviceDayNote(s.serviceDayOffset, props.dateLabel);

  return (
    <div class="leg leg--rail">
      <header class="leg__head">
        <span class="leg__badge">Leg {props.index} of {props.total}</span>
        <h4>
          <span class="trainno">{s.trainNumber}</span> {s.trainName}
          <span class="leg__type">{s.trainType}</span>
        </h4>
      </header>

      <p class="leg__route">
        <strong>{from.name}</strong> <span class="code">{from.code}</span>
        <span class="leg__arrow" aria-hidden="true">→</span>
        <strong>{to.name}</strong> <span class="code">{to.code}</span>
      </p>

      <dl class="facts">
        <Fact label="Departs">
          {wallClock(s.depMin)}
          {dayOf(s.depMin) > 0 && <span class="dayoff"> +{dayOf(s.depMin)}d</span>}
        </Fact>
        <Fact label="Arrives">
          {wallClock(s.arrMin)}
          {dayOf(s.arrMin) > 0 && <span class="dayoff"> +{dayOf(s.arrMin)}d</span>}
        </Fact>
        <Fact label="On board">{durationLabel(s.durationMin)}</Fact>
        <Fact label="Distance">{s.distKm} km</Fact>
        <Fact label="Stops passed">{s.hops === 1 ? 'non-stop' : `${s.hops - 1} intermediate`}</Fact>
        <Fact label="Class">
          {classLabel(s.klass, s.classFellBack)}
        </Fact>
      </dl>

      <div class="fare">
        <p class="fare__total">
          {rupees(s.fareRupees)} <span class="est">estimated</span>
        </p>
        <p class="fare__parts">
          base {rupees(s.baseFare)} · reservation {rupees(s.reservation)}
          {s.surcharge > 0 && <> · superfast {rupees(s.surcharge)}</>}
          {' '}· GST {rupees(s.gst)}
          {s.flexiFare && ' · flexi-fare train, so the real price moves with demand'}
        </p>
      </div>

      {(s.nightArrival || s.classFellBack || dayNote || s.runsDaysAssumed || s.classesInferred) && (
        <ul class="leg__flags">
          {s.nightArrival && (
            <li class="flag flag--warn">
              Arrives between midnight and 05:00. Plan how you will get from the station.
            </li>
          )}
          {s.classFellBack && (
            <li class="flag">
              This train does not offer the class you asked for, so it is priced in {s.klass} instead.
            </li>
          )}
          {dayNote && <li class="flag">{dayNote}</li>}
          {s.runsDaysAssumed && (
            <li class="flag flag--stale">
              Running days were not in the source data and are assumed to be daily. Check before
              you travel — this train may not run every day.
            </li>
          )}
          {s.classesInferred && (
            <li class="flag flag--stale">
              The class list was inferred from this train's type rather than sourced, so {s.klass}{' '}
              may not actually be offered.
            </li>
          )}
        </ul>
      )}

      <p class="leg__avail">
        <strong>Seat availability: not yet connected.</strong> This build shows schedules and
        estimated fares only. Confirm berths on IRCTC before booking — nothing here is a
        guarantee that a seat exists.
      </p>
    </div>
  );
}

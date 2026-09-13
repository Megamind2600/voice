/**
 * ItineraryCard.tsx — one itinerary, collapsed to the things that decide it and expandable to
 * everything that proves it.
 *
 * The collapsed row answers the four questions a traveller asks in order: when do I get there,
 * how many changes, what does it cost, and is any of it unpleasant. Only after that does anyone
 * want the leg-by-leg detail, so that lives behind a disclosure rather than on the page — with
 * twelve itineraries on screen, showing every leg of every one would be a wall nobody reads.
 */
import { useContext, useId, useMemo, useState } from 'preact/hooks';
import type { Journey, RailSegment } from '../router/journey';
import { renderItinerary, wallClock, type StationResolver } from '../router/journey';
import { arrivalLabel, durationLabel, rupees } from '../state/plan';
import { ESTIMATE_BADGE, estimateChip, estimateForLeg, worstEstimate } from '../availability/estimate';
import { LegDetail } from './LegDetail';
import { PlannerDepsContext } from './deps';
import { ExportMenu } from './ExportMenu';
import { RouteMap } from './RouteMap';

export interface ItineraryCardProps {
  journey: Journey;
  nameOf: StationResolver;
  /** ISO date of departure, for phrasing service-day offsets. */
  date: string;
  /** Coordinates for the stations this itinerary passes, for the map. Null disables the map. */
  coordsFor?: (station: number) => { lat: number; lon: number } | null;
  /** True when this itinerary came from a search that hit its limit. */
  expandedByDefault?: boolean;
  /** Other itineraries found for the same destination, so remedy ⑤ can say how many. */
  alternativeItineraries?: number;
}

/** The through trains only, for the one-line summary. Road hops are shown separately. */
function trainsOf(j: Journey): RailSegment[] {
  return j.segments.filter((s): s is RailSegment => s.kind === 'rail');
}

export function ItineraryCard(props: ItineraryCardProps) {
  const { journey: j, nameOf } = props;
  const [open, setOpen] = useState(props.expandedByDefault === true);
  const headingId = useId();
  const coordsFor = props.coordsFor;

  const trains = trainsOf(j);
  const origin = nameOf(j.origin);
  const destination = nameOf(j.destination);
  const changes = j.transfers;
  const direct = changes === 0 && trains.length === 1;

  // The seat estimate for the collapsed row. A journey is as bookable as its worst leg, so the
  // chip shows the hardest leg rather than the friendliest one — and it is a chip, not a number:
  // the qualifier travels with it, because a summary line is exactly where an estimate is most
  // likely to be read as a fact.
  const deps = useContext(PlannerDepsContext);
  const worst = useMemo(() => worstEstimate(trains.map((s) => estimateForLeg({
    segment: s,
    segmentRunsDaysAssumed: s.runsDaysAssumed,
    boardingDateIso: props.date,
    serviceDayOffset: s.serviceDayOffset,
    boardCalls: deps.stations?.at(s.from)?.calls ?? null,
    alightCalls: deps.stations?.at(s.to)?.calls ?? null,
  }))), [trains, props.date, deps.stations]);

  return (
    <article class={`itin${open ? ' itin--open' : ''}`}>
      <div class="itin__summary">
        <button
          type="button"
          class="itin__toggle"
          aria-expanded={open}
          aria-controls={headingId}
          onClick={() => setOpen((v) => !v)}
        >
          <span class="itin__times">
            <span class="itin__time">{wallClock(j.depMin)}</span>
            <span class="itin__arrow" aria-hidden="true">→</span>
            <span class="itin__time">{arrivalLabel(j.depMin, j.arrMin)}</span>
          </span>

          <span class="itin__meta">
            <span class="itin__dur">{durationLabel(j.durationMin)}</span>
            <span class={`itin__changes${direct ? ' itin__changes--direct' : ''}`}>
              {direct ? 'direct' : `${changes} change${changes === 1 ? '' : 's'}`}
            </span>
            {j.roadTransfers > 0 && (
              <span class="itin__road" title="Road transfer between terminals in the same city">
                + {j.roadTransfers} road hop{j.roadTransfers === 1 ? '' : 's'}
              </span>
            )}
            <span class="itin__fare">{rupees(j.fareRupees)}</span>
          </span>

          <span class="itin__trains">
            {trains.length === 0
              ? 'No train'
              : trains.map((t) => t.trainNumber).join(' · ')}
            <span class="itin__od">{origin.code} → {destination.code}</span>
          </span>

          <span class="itin__flags">
            {j.nightArrivals > 0 && (
              <span class="pill pill--warn">
                {j.nightArrivals} night arrival{j.nightArrivals === 1 ? '' : 's'}
              </span>
            )}
            {j.classFallback && <span class="pill">class substituted</span>}
            {j.earlyDepartures > 0 && <span class="pill">early start</span>}
            <span class="pill pill--est">fare est.</span>
            {worst !== null && (
              <span class="pill pill--est" title={worst.headline}>
                {ESTIMATE_BADGE.toLowerCase()} seats · {estimateChip(worst)}
              </span>
            )}
          </span>

          <span class="itin__chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
        </button>

        <ExportMenu journey={j} nameOf={nameOf} />
      </div>

      {open && (
        <div class="itin__body" id={headingId}>
          <p class="itin__headline">
            <strong>{origin.name}</strong> to <strong>{destination.name}</strong> ·{' '}
            {durationLabel(j.durationMin)} door to door · {j.totalKm.toLocaleString('en-IN')} km ·{' '}
            {rupees(j.fareRupees)} estimated · fatigue {j.fatigue.toFixed(1)} h-equivalent
          </p>

          {coordsFor && <RouteMap journey={j} coordsFor={coordsFor} />}

          <ol class="itin__legs">
            {j.segments.map((s, i) => (
              <li key={`${s.kind}-${s.depMin}-${i}`}>
                <LegDetail
                  segment={s}
                  index={i + 1}
                  total={j.segments.length}
                  nameOf={nameOf}
                  dateLabel={props.date}
                  alternativeItineraries={props.alternativeItineraries ?? 0}
                  roadHopPresent={j.segments.some((x) => x.kind === 'road')}
                />
              </li>
            ))}
          </ol>

          {j.truncated && (
            <p class="alert alert--inline">
              This search reached its limit and stopped early, so there may be options that are
              not shown. Widening the search will not help; narrowing the date or the number of
              changes might.
            </p>
          )}

          <details class="itin__raw">
            <summary>Plain-text version</summary>
            <pre>{renderItinerary(j, nameOf)}</pre>
          </details>
        </div>
      )}
    </article>
  );
}

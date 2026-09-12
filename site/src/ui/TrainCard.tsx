/**
 * TrainCard.tsx — one train, with a provenance badge on anything inferred.
 *
 * The plan requires a provenance badge on every figure that is not directly sourced. Two
 * things in the bootstrap qualify: the class list (inferred from train type for 54% of
 * trains) and the running days (assumed daily for 100% of them). Both are flagged here
 * rather than presented as fact.
 */
import { decodeRunsDays, fmtDuration, fmtWallClock } from '../lib/graph';
import type { TrainSummary } from '../lib/protocol';
import { Badge } from './Disclaimer';

export interface TrainCardProps {
  train: TrainSummary;
  originName: string;
  destinationName: string;
  onOpen?: (train: number) => void;
  expanded?: boolean;
}

export function TrainCard({ train, originName, destinationName, onOpen, expanded = false }: TrainCardProps) {
  const id = `train-${train.train}`;
  return (
    <article class="traincard" aria-labelledby={`${id}-h`}>
      <div class="traincard__head">
        <button
          type="button"
          id={`${id}-h`}
          class="traincard__title"
          aria-expanded={expanded}
          aria-controls={`${id}-body`}
          onClick={() => onOpen?.(train.train)}
          disabled={!onOpen}
        >
          <span class="traincard__num">{train.number}</span>
          <span class="traincard__name">{train.name}</span>
        </button>
        <span class="traincard__type">{train.type}</span>
      </div>

      <p class="traincard__route">
        {originName} → {destinationName}
        {' · '}departs <strong>{fmtWallClock(train.originDepMin, 0)}</strong>
      </p>

      <dl class="traincard__facts">
        <div>
          <dt>Duration</dt>
          <dd>{fmtDuration(train.durationMin)}</dd>
        </div>
        <div>
          <dt>Distance</dt>
          <dd>{train.distanceKm.toLocaleString('en-IN')} km</dd>
        </div>
        <div>
          <dt>Stops</dt>
          <dd>{train.legCount + 1}</dd>
        </div>
        <div>
          <dt>Runs</dt>
          <dd>
            {decodeRunsDays(train.runsDays)}
            {train.runsDaysAssumed && (
              <> <Badge kind="stale" label="assumed daily" title="The 2016 source has no running-days data, so every train is assumed to run daily. This is known to be wrong for weekly and bi-weekly services." /></>
            )}
          </dd>
        </div>
        <div>
          <dt>Classes</dt>
          <dd>
            {train.classes.join(' · ') || '—'}
            {train.classesInferred && (
              <> <Badge kind="predicted" label="inferred" title="The source lists no classes for this train; these were inferred from its train type." /></>
            )}
          </dd>
        </div>
      </dl>
    </article>
  );
}

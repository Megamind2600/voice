/**
 * StopTable.tsx — a train's timetable.
 *
 * Packed times are relative to the train's own origin departure, so they are converted to
 * true wall-clock here via `train.originDepMin`. Rendering the raw relative offset would
 * show "17:00" for "17 hours after departure", which reads as 5 pm and is simply wrong.
 * Days after departure are marked "+1d", the way an Indian railway timetable does it. The
 * origin shows no arrival and the terminal no departure, matching the source.
 *
 * This is a real <table> with a caption and scoped headers rather than a grid of divs:
 * it is tabular data, and screen readers navigate tables by row/column.
 */
import { fmtWallClock, fmtDuration } from '../lib/graph';
import type { RawStop, TrainSummary } from '../lib/protocol';
import { Badge } from './Disclaimer';

export interface StopTableProps {
  train: TrainSummary;
  stops: RawStop[];
  stationName: (i: number) => string;
  stationCode: (i: number) => string;
}

export function StopTable({ train, stops, stationName, stationCode }: StopTableProps) {
  return (
    <div class="tablewrap" tabIndex={0} role="group" aria-label={`Timetable for ${train.number} ${train.name}`}>
      <table class="stoptable">
        <caption>
          {train.number} {train.name} — {stops.length} stops,{' '}
          {train.distanceKm.toLocaleString('en-IN')} km, {fmtDuration(train.durationMin)}
          {train.runsDaysAssumed && <> <Badge kind="stale" label="BOOTSTRAP · 2016" title="Timetable from the 2016 community dataset; may not be current." /></>}
        </caption>
        <thead>
          <tr>
            <th scope="col" aria-label="Sequence">#</th>
            <th scope="col">Station</th>
            <th scope="col">Code</th>
            <th scope="col" class="num">Arrives</th>
            <th scope="col" class="num">Departs</th>
            <th scope="col" class="num">Halt</th>
            <th scope="col" class="num">Distance</th>
          </tr>
        </thead>
        <tbody>
          {stops.map((s) => {
            const halt = s.arrMin === null || s.depMin === null ? null : s.depMin - s.arrMin;
            const isFirst = s.seq === 1;
            const isLast = s.seq === stops.length;
            return (
              <tr key={s.seq} class={isFirst || isLast ? 'is-terminal' : undefined}>
                <th scope="row" class="num">{s.seq}</th>
                <td>
                  {stationName(s.station)}
                  {isFirst && <span class="tag">origin</span>}
                  {isLast && <span class="tag">destination</span>}
                </td>
                <td><code>{stationCode(s.station)}</code></td>
                <td class="num">{isFirst ? '—' : fmtWallClock(train.originDepMin, s.arrMin)}</td>
                <td class="num">{isLast ? '—' : fmtWallClock(train.originDepMin, s.depMin)}</td>
                <td class="num">{halt === null || halt === 0 ? '—' : `${halt} min`}</td>
                <td class="num">{s.distKm.toLocaleString('en-IN')} km</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

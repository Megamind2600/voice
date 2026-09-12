/**
 * DateFlexStrip.tsx — remedy ② drawn as days.
 *
 * Rendered inside the remedies panel rather than always-on, for the same reason the remedies are:
 * a search can return two hundred itineraries, and twelve date cells per leg is a lot of pixels
 * nobody asked for. It costs nothing until the panel is opened.
 *
 * The legend is not decoration. It is where the app says out loud that no colour on this strip
 * means "seats available", because a traveller who has used any other planner will assume a green
 * cell means a free berth, and that assumption is the one thing this component must not leave
 * standing.
 */
import { useMemo } from 'preact/hooks';
import { dateFlexStrip, dateFlexSummary, type DateFlexState } from '../availability/dateflex';

export interface DateFlexStripProps {
  runsDays: number;
  runsDaysAssumed: boolean;
  serviceDayOffset: number;
  /** The date the traveller searched for; the strip centres on it. */
  queryDateIso: string;
  klass: string;
}

const GLYPH: Record<DateFlexState, string> = {
  'open': '●',
  'window-closed': '◐',
  'no-run': '✕',
  'past': '·',
};

export function DateFlexStrip(props: DateFlexStripProps) {
  const cells = useMemo(
    () => dateFlexStrip({
      runsDays: props.runsDays,
      runsDaysAssumed: props.runsDaysAssumed,
      serviceDayOffset: props.serviceDayOffset,
      queryDateIso: props.queryDateIso,
      klass: props.klass,
    }),
    [props.runsDays, props.runsDaysAssumed, props.serviceDayOffset, props.queryDateIso, props.klass],
  );

  return (
    <div class="dateflex">
      <p class="dateflex__summary">{dateFlexSummary(cells)}</p>

      <ul class="dateflex__strip">
        {cells.map((c) => {
          const cls = ['dateflex__cell', `dateflex__cell--${c.state}`];
          if (c.isQueryDate) cls.push('dateflex__cell--query');
          if (c.peak && c.state !== 'past' && c.state !== 'no-run') cls.push('dateflex__cell--peak');
          return (
            <li class={cls.join(' ')} key={c.dateIso} title={c.label} aria-label={c.label}>
              <span class="dateflex__dow">{c.weekday.slice(0, 2)}</span>
              <span class="dateflex__day">{c.dayNum}</span>
              <span class="dateflex__mark" aria-hidden="true">{GLYPH[c.state]}</span>
              {/* The assumed-daily flag belongs on the cell, not in a footnote: a weekly train
                  shown as running every day is how someone plans a holiday that cannot happen. */}
              {c.runsAssumed && c.state !== 'no-run' && c.state !== 'past' && (
                <span class="dateflex__assumed" title="Running days were not in the source data and are assumed daily">?</span>
              )}
            </li>
          );
        })}
      </ul>

      <ul class="dateflex__legend">
        <li><span class="dateflex__key dateflex__key--open" aria-hidden="true" /> runs, bookable now</li>
        <li><span class="dateflex__key dateflex__key--window-closed" aria-hidden="true" /> runs, 60-day window not open yet</li>
        <li><span class="dateflex__key dateflex__key--no-run" aria-hidden="true" /> this train does not run</li>
        <li><span class="dateflex__key dateflex__key--past" aria-hidden="true" /> already gone</li>
        <li><span class="dateflex__peak" aria-hidden="true">▲</span> Friday, Sunday and Monday — typically the busiest booking days</li>
        <li><span class="dateflex__assumed" aria-hidden="true">?</span> running days assumed daily, not sourced</li>
        <li class="dateflex__legendnote">
          <strong>No colour here means "seats available".</strong> This build cannot know that, so
          it shows only what the timetable and IRCTC's published rules settle.
        </li>
      </ul>
    </div>
  );
}

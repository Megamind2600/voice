/**
 * StatusBar.tsx — honest reporting of what is loaded and where it came from.
 *
 * This exists because the app has two datasets with very different sizes and freshness.
 * Telling the user "autocomplete works, timetable still loading" beats a spinner that
 * implies nothing works, and telling them the graph came from cache explains why a repeat
 * visit was instant.
 */
import type { DatasetState } from '../state/useDataset';
import type { GraphStats } from '../lib/protocol';

export interface StatusBarProps {
  dataset: DatasetState;
  graphStats: GraphStats | null;
}

function sourceLabel(src: string | null): string {
  if (src === 'cache') return 'from cache';
  if (src === 'memory') return 'already loaded';
  if (src === 'network') return 'downloaded';
  return 'pending';
}

export function StatusBar({ dataset, graphStats }: StatusBarProps) {
  const stations = dataset.stations;
  return (
    <div class="statusbar" role="status" aria-live="polite">
      <span class={`statusbar__pill${stations ? ' is-on' : ''}`}>
        <span class="statusbar__dot" aria-hidden="true" />
        Stations{' '}
        {stations
          ? `${stations.count.toLocaleString('en-IN')} ready · ${dataset.stationsMs.toFixed(0)} ms · ${sourceLabel(dataset.stationsSource)}`
          : 'loading…'}
      </span>

      <span class={`statusbar__pill${graphStats ? ' is-on' : ''}`}>
        <span class="statusbar__dot" aria-hidden="true" />
        Timetable graph{' '}
        {graphStats
          ? `${graphStats.trains.toLocaleString('en-IN')} trains · ${graphStats.connections.toLocaleString('en-IN')} legs · ${sourceLabel(dataset.graphSource)}`
          : dataset.phase === 'error'
            ? 'unavailable'
            : 'loading…'}
      </span>

      {dataset.phase === 'error' && (
        <span class="statusbar__pill is-error">
          {dataset.error}
        </span>
      )}
    </div>
  );
}

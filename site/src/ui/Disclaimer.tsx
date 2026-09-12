/**
 * Disclaimer.tsx — shown on EVERY page, per docs/04-roadmap-and-risks.md.
 *
 * Two separate facts must never be blurred:
 *   1. This is unofficial and not affiliated with IRCTC or Indian Railways.
 *   2. The dataset is a 2016 community snapshot until NTES data lands, so timetables
 *      shown here may not be current.
 * Both are legally and practically load-bearing, so neither is dismissible and neither is
 * hidden behind a tooltip.
 */
import type { ComponentChildren } from 'preact';

export interface DisclaimerProps {
  /** e.g. "BOOTSTRAP · 2016" — rendered as a distinct badge so staleness is unmissable. */
  datasetLabel?: string;
  compact?: boolean;
  children?: ComponentChildren;
}

export function Disclaimer({ datasetLabel, compact = false, children }: DisclaimerProps) {
  return (
    <aside
      class={`disclaimer${compact ? ' disclaimer--compact' : ''}`}
      role="note"
      aria-label="Important notice about this service"
    >
      <p class="disclaimer__lead">
        <strong>Unofficial.</strong> Not affiliated with, endorsed by, or connected to
        Indian Railways, IRCTC, or the Government of India.
      </p>
      <p>
        This tool cannot book tickets and never handles payment. It shows timetables and
        estimated seat availability so you can plan, then links you to IRCTC to book.
        Always confirm on IRCTC before travelling.
      </p>
      {datasetLabel && (
        <p class="disclaimer__dataset">
          <span class="badge badge--stale" title="Dataset vintage">
            {datasetLabel}
          </span>{' '}
          Timetables come from a community dataset published in 2016 and may be out of
          date. Trains added since then — including Vande Bharat services — are missing,
          and some stations appear under older names.
        </p>
      )}
      {children}
    </aside>
  );
}

/** Provenance badge — every availability figure and timetable carries one. */
export function Badge({
  kind, label, title,
}: { kind: 'stale' | 'live' | 'predicted' | 'static' | 'info'; label: string; title?: string }) {
  return <span class={`badge badge--${kind}`} title={title}>{label}</span>;
}

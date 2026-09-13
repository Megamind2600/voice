/**
 * ExportMenu.tsx — get an itinerary out of the browser.
 *
 * Three ways, because they fail in different places and a traveller on a train platform has no
 * patience for a menu that does not work:
 *
 *   - **Share** uses the Web Share API, which on a phone opens WhatsApp directly — and WhatsApp
 *     is how itineraries actually get passed to the person meeting you at the station.
 *   - **Copy** is the fallback everywhere else, and the one that works in the most places.
 *   - **Download** keeps a copy that survives a closed tab, which matters when the app has no
 *     account and therefore no way to give the itinerary back to you later.
 *   - **Add to calendar** writes an .ics file (see lib/calendar.ts) so the journey can land in
 *     Google Calendar or any phone calendar as a single timed event in IST.
 *
 * All four render the SAME journey through `renderItinerary`, so a shared plan and a downloaded
 * plan cannot disagree about the fare or the platform.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Journey } from '../router/journey';
import { renderItinerary, wallClock, type StationResolver } from '../router/journey';
import { buildIcs, shiftIsoByMinutes } from '../lib/calendar';

export interface ExportMenuProps {
  journey: Journey;
  nameOf: StationResolver;
  /** ISO date the journey departs, so the calendar event lands on the right day. */
  date?: string;
}

type Status = { kind: 'idle' } | { kind: 'ok'; text: string } | { kind: 'err'; text: string };

export function ExportMenu(props: ExportMenuProps) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const wrapRef = useRef<HTMLDivElement>(null);

  const text = (): string => renderItinerary(props.journey, props.nameOf);
  const title = (): string => {
    const j = props.journey;
    return `${props.nameOf(j.origin).code}→${props.nameOf(j.destination).code} ${wallClock(j.depMin)}`;
  };

  // Clicking outside closes the menu. A persistent menu on every one of twelve itineraries
  // would otherwise be twelve open menus the traveller has to dismiss by hand.
  useEffect(() => {
    if (!open) return;
    const onDown = (ev: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(ev.target as Node)) setOpen(false);
    };
    const onKey = (ev: KeyboardEvent): void => { if (ev.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (status.kind === 'idle') return;
    const t = setTimeout(() => setStatus({ kind: 'idle' }), 4000);
    return () => clearTimeout(t);
  }, [status]);

  const share = (): void => {
    const nav = navigator as Navigator & {
      share?: (data: ShareData) => Promise<void>;
      canShare?: (data: ShareData) => boolean;
    };
    const data = { title: title(), text: text() };
    if (!nav.share || (nav.canShare && !nav.canShare(data))) {
      setStatus({ kind: 'err', text: 'This browser cannot share directly — use Copy instead.' });
      return;
    }
    nav.share(data)
      .then(() => setStatus({ kind: 'ok', text: 'Shared.' }))
      // Dismissal is not an error: the traveller changed their mind, and saying "failed" would
      // be wrong. Anything else is reported.
      .catch((err: unknown) => {
        const name = err instanceof Error ? err.name : '';
        if (name !== 'AbortError') {
          setStatus({ kind: 'err', text: `Share failed: ${err instanceof Error ? err.message : String(err)}` });
        }
      });
  };

  const copy = async (): Promise<void> => {
    const body = text();
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(body);
        setStatus({ kind: 'ok', text: 'Copied to clipboard.' });
        return;
      }
      throw new Error('no clipboard API');
    } catch {
      // Older browsers and any page served without a secure context have no clipboard API.
      // A hidden textarea and execCommand is deprecated but still the only thing that works
      // there, and losing the copy button entirely would be worse than using it.
      try {
        const ta = document.createElement('textarea');
        ta.value = body;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        setStatus(ok
          ? { kind: 'ok', text: 'Copied to clipboard.' }
          : { kind: 'err', text: 'Copy blocked — open the itinerary and select the text.' });
      } catch {
        setStatus({ kind: 'err', text: 'Copy blocked — open the itinerary and select the text.' });
      }
    }
  };

  const download = (): void => {
    try {
      const blob = new Blob([text()], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${title().replace(/[^\w-]+/g, '-')}.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Revoking immediately can cancel the download in some browsers; defer it.
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      setStatus({ kind: 'ok', text: 'Downloaded.' });
    } catch (err) {
      setStatus({ kind: 'err', text: `Download failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  };

  const downloadIcs = (): void => {
    // The event runs door-to-door: first departure to final arrival, so the calendar shows
    // the whole journey rather than one leg at a time. A journey with no date (older call
    // sites) falls back to today rather than exporting an event on the wrong day.
    const j = props.journey;
    const nameOf = props.nameOf;
    const date = props.date ?? new Date().toISOString().slice(0, 10);
    const origin = nameOf(j.origin);
    const destination = nameOf(j.destination);
    const start = shiftIsoByMinutes(date, j.depMin);
    const end = shiftIsoByMinutes(date, j.arrMin);

    const ics = buildIcs([{
      title: `${origin.name} → ${destination.name}`,
      startDateIso: start.dateIso,
      startMin: start.minuteOfDay,
      endDateIso: end.dateIso,
      endMin: end.minuteOfDay,
      location: `${origin.name} (${origin.code}) → ${destination.name} (${destination.code})`,
      description: renderItinerary(j, nameOf),
      uid: `kahan-chalein-${date}-${origin.code}-${destination.code}-${j.depMin}`,
    }], { name: 'Kahan Chalein? journey' });

    try {
      const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${title().replace(/[^\w-]+/g, '-')}.ics`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      setStatus({ kind: 'ok', text: 'Calendar file downloaded.' });
    } catch (err) {
      setStatus({ kind: 'err', text: `Calendar export failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  };

  const canShare = typeof navigator !== 'undefined'
    && typeof (navigator as Navigator & { share?: unknown }).share === 'function';

  return (
    <div class="export" ref={wrapRef}>
      <button
        type="button"
        class="export__btn"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={(ev) => { ev.stopPropagation(); setOpen((v) => !v); }}
      >
        Export
      </button>
      {open && (
        <div class="export__menu" role="menu">
          {canShare && (
            <button type="button" role="menuitem" onClick={share}>Share…</button>
          )}
          <button type="button" role="menuitem" onClick={() => void copy()}>Copy as text</button>
          <button type="button" role="menuitem" onClick={download}>Download .txt</button>
          <button type="button" role="menuitem" onClick={downloadIcs}>Add to calendar (.ics)</button>
        </div>
      )}
      {status.kind !== 'idle' && (
        <p class={`export__status${status.kind === 'err' ? ' export__status--err' : ''}`} role="status">
          {status.text}
        </p>
      )}
    </div>
  );
}

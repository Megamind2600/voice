/**
 * CopyPlanLink.tsx — copy a link that reopens this exact search.
 *
 * The link is the URL fragment produced by `encodePlan`; copying it also writes it to the
 * address bar via `history.replaceState`, so the thing the traveller pastes to a friend is
 * byte-for-byte the thing that would reload here. Without that synchronisation a copied link
 * can go stale while the form keeps changing under it.
 *
 * The clipboard dance mirrors AvailabilityPanel/ExportMenu: the async Clipboard API where it
 * exists, a hidden textarea and execCommand where it does not. A missing copy button is a
 * missing feature; a copy button that silently fails is a broken one.
 */
import { useState } from 'preact/hooks';
import { encodePlan } from '../state/urlState';
import type { PlanInput } from '../state/useJourneys';

export interface CopyPlanLinkProps {
  plan: PlanInput;
}

export function shareUrl(plan: PlanInput): string | null {
  const enc = encodePlan(plan);
  if (!enc) return null;
  const base = window.location.href.split('#')[0];
  return `${base}#${enc}`;
}

export function CopyPlanLink(props: CopyPlanLinkProps) {
  const [status, setStatus] = useState<'idle' | 'ok' | 'err'>('idle');

  const copy = async (): Promise<void> => {
    const url = shareUrl(props.plan);
    if (!url) {
      setStatus('err');
      return;
    }
    // Keep the address bar in step with what is about to be copied.
    try { window.history.replaceState(null, '', url); } catch { /* non-fatal: copy still works */ }

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        setStatus('ok');
        return;
      }
      throw new Error('no clipboard API');
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = url;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        setStatus(ok ? 'ok' : 'err');
      } catch {
        setStatus('err');
      }
    }
  };

  return (
    <span class="sharelink">
      <button type="button" class="linkish" onClick={() => void copy()} disabled={!props.plan.origin}>
        Copy link to this search
      </button>
      {status !== 'idle' && (
        <span class={status === 'err' ? 'sharelink__status sharelink__status--err' : 'sharelink__status'} role="status">
          {status === 'ok'
            ? 'Link copied — paste it anywhere.'
            : 'Could not copy the link — copy it from the address bar instead.'}
        </span>
      )}
    </span>
  );
}

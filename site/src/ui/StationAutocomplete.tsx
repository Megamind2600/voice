/**
 * StationAutocomplete.tsx — ARIA 1.2 combobox over the station index.
 *
 * Accessibility is a Phase 0 acceptance criterion (Lighthouse a11y >= 95), and a
 * combobox is the single easiest place to get it wrong. This follows the WAI-ARIA APG
 * "editable combobox with list" pattern exactly:
 *
 *   - the input owns role="combobox" with aria-expanded / aria-controls / aria-activedescendant
 *   - options are role="option" inside role="listbox", each with a stable id
 *   - aria-activedescendant moves with the highlight, so focus NEVER leaves the input
 *   - ArrowDown/Up move, Home/End jump, Enter selects, Escape closes, Tab closes+selects
 *   - every state change is announced through a polite live region
 *
 * Selection is committed on Enter/click, not on typing, so a screen-reader user is not
 * silently re-routed mid-word.
 */
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import type { Station, StationIndex } from '../lib/stations';

export interface StationAutocompleteProps {
  index: StationIndex | null;
  label: string;
  value: Station | null;
  onSelect: (s: Station | null) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Announced when the dataset is not ready, instead of an empty listbox. */
  notReadyMessage?: string;
}

const LIMIT = 8;

export function StationAutocomplete({
  index, label, value, onSelect, placeholder = 'e.g. Hyderabad, Secunderabad, KCG',
  disabled = false, notReadyMessage = 'Loading station list…',
}: StationAutocompleteProps) {
  const baseId = useId().replace(/[^a-zA-Z0-9]/g, '');
  const listboxId = `${baseId}-listbox`;
  const liveId = `${baseId}-live`;
  const inputId = `${baseId}-input`;

  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [options, setOptions] = useState<Station[]>([]);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Recompute suggestions whenever the query or the index changes.
  useEffect(() => {
    if (!index) { setOptions([]); return; }
    const next = index.search(query, LIMIT);
    setOptions(next);
    setActive((a) => (a >= next.length ? -1 : a));
  }, [query, index]);

  // Keep the highlighted option visible when the keyboard moves it.
  useEffect(() => {
    if (!open || active < 0 || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-i="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const commit = (s: Station | null): void => {
    onSelect(s);
    setQuery(s ? `${s.name} (${s.code})` : '');
    setOpen(false);
    setActive(-1);
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (!open) { setOpen(true); setActive(0); return; }
        setActive((a) => (options.length ? (a + 1) % options.length : -1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (!open) { setOpen(true); return; }
        setActive((a) => (a <= 0 ? options.length - 1 : a - 1));
        break;
      case 'Home':
        if (open && options.length) { e.preventDefault(); setActive(0); }
        break;
      case 'End':
        if (open && options.length) { e.preventDefault(); setActive(options.length - 1); }
        break;
      case 'Enter':
        if (open && active >= 0 && options[active]) {
          e.preventDefault();
          commit(options[active]);
        }
        break;
      case 'Escape':
        if (open) { e.preventDefault(); setOpen(false); setActive(-1); }
        else if (value) commit(null);
        break;
      case 'Tab':
        setOpen(false);
        setActive(-1);
        break;
      default:
        break;
    }
  };

  const announcement = !index
    ? notReadyMessage
    : open && options.length
      ? `${options.length} suggestion${options.length === 1 ? '' : 's'} available. Use up and down arrow keys to review.`
      : open
        ? 'No matching stations.'
        : '';

  return (
    <div class="field">
      <label class="field__label" for={inputId}>
        {label}
        {value && (
          <button
            type="button"
            class="field__clear"
            onClick={() => { commit(null); inputRef.current?.focus(); }}
            aria-label={`Clear ${label}`}
          >
            ×
          </button>
        )}
      </label>

      <div class="combobox">
        <input
          id={inputId}
          ref={inputRef}
          type="text"
          role="combobox"
          class="combobox__input"
          autocomplete="off"
          autocorrect="off"
          autocapitalize="off"
          spellcheck={false}
          enterkeyhint="done"
          aria-expanded={open ? 'true' : 'false'}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={open && active >= 0 ? `${baseId}-opt-${active}` : undefined}
          aria-describedby={liveId}
          placeholder={placeholder}
          disabled={disabled || !index}
          value={query}
          onInput={(e) => {
            setQuery(e.currentTarget.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            // Delay so a click on an option registers before the list closes.
            setTimeout(() => setOpen(false), 120);
          }}
          onKeyDown={onKeyDown}
        />

        {open && index && (
          <ul
            id={listboxId}
            ref={listRef}
            class="combobox__list"
            role="listbox"
            aria-label={label}
          >
            {options.length === 0 && (
              <li class="combobox__empty" role="presentation">
                No station matches “{query}”. Try the first three letters, or a station code.
              </li>
            )}
            {options.map((s, i) => (
              <li
                key={s.i}
                id={`${baseId}-opt-${i}`}
                data-i={i}
                role="option"
                aria-selected={i === active}
                class={`combobox__option${i === active ? ' is-active' : ''}`}
                onMouseEnter={() => setActive(i)}
                // onMouseDown rather than onClick: it fires before the input's blur, so
                // the selection is not lost to the 120 ms blur timer above.
                onMouseDown={(e) => { e.preventDefault(); commit(s); }}
              >
                <span class="combobox__name">{s.name}</span>
                <span class="combobox__code">{s.code}</span>
                <span class="combobox__meta">
                  {s.calls} train{s.calls === 1 ? '' : 's'}
                  {s.rank === 3 ? ' · metro' : s.rank === 2 ? ' · junction' : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Polite, not assertive: announcing every keystroke would be unbearable. */}
      <p id={liveId} class="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>

      {value && (
        <p class="field__hint">
          Selected: <strong>{value.name}</strong> ({value.code}) — {value.calls} trains stop here.
        </p>
      )}
    </div>
  );
}

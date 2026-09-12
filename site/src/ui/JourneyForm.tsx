/**
 * JourneyForm.tsx — the inputs.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS MANDATORY, AND WHY ONLY THAT
 * ---------------------------------------------------------------------------
 * Two things: where you start, and when you can leave. Everything else is optional and the form
 * is built so that leaving it blank is a *choice with a meaning*, not a gap to fill in:
 *
 *   - No destination means "show me where I could go". That is the reason this app exists, so
 *     the field says so rather than sitting there marked required.
 *   - No return date means a one-way plan. A return is offered, never assumed, because plenty of
 *     holidays are open-ended and a form that insists on a return date turns them into two
 *     separate searches.
 *   - Days at destination changes nothing about the outbound search, so it only nudges the
 *     suggested return date. It is not silently promoted into a constraint.
 *
 * The form never blocks on the graph loading. Station autocomplete works off stations.bin, which
 * arrives first, so a traveller on a slow connection can be typing before the timetable exists.
 */
import { useId } from 'preact/hooks';
import type { StationIndex } from '../lib/stations';
import { StationAutocomplete } from './StationAutocomplete';
import { CLASS_CHOICES, addDaysIso, minutesToTime, todayIso } from '../state/plan';
import type { PlanInput } from '../state/useJourneys';

export interface JourneyFormProps {
  stations: StationIndex | null;
  plan: PlanInput;
  onChange: (next: PlanInput) => void;
  onSubmit: () => void;
  busy: boolean;
  /** True once the graph is ready; searches are refused until then, with a reason. */
  canSearch: boolean;
  notReadyMessage: string;
}

export function JourneyForm(props: JourneyFormProps) {
  const { plan, onChange, stations } = props;
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const set = <K extends keyof PlanInput>(key: K, value: PlanInput[K]): void => {
    onChange({ ...plan, [key]: value });
  };

  // Suggesting a return date from "days at destination" is the only thing that field does, so it
  // is offered as an action rather than computed silently behind the traveller's back.
  const suggestReturn = (): void => {
    if (plan.daysAtDestination === null || plan.daysAtDestination < 0) return;
    set('returnDate', addDaysIso(plan.date, Math.max(1, plan.daysAtDestination)));
  };

  const ready = props.canSearch && plan.origin !== null;

  return (
    <form
      class="plan"
      onSubmit={(ev) => { ev.preventDefault(); if (ready && !props.busy) props.onSubmit(); }}
    >
      <div class="plan__grid">
        <div class="plan__field plan__field--wide">
          <StationAutocomplete
            index={stations}
            label="Where are you starting from? (required)"
            value={plan.origin}
            onSelect={(s) => set('origin', s)}
            disabled={props.busy}
            notReadyMessage={props.notReadyMessage}
          />
        </div>

        <div class="plan__field plan__field--wide">
          <StationAutocomplete
            index={stations}
            label="Where do you want to go? (optional)"
            value={plan.destination}
            onSelect={(s) => set('destination', s)}
            placeholder="Leave blank and we will suggest places"
            disabled={props.busy}
            notReadyMessage={props.notReadyMessage}
          />
          <p class="plan__hint">
            {plan.destination
              ? `Searching for itineraries to ${plan.destination.name}.`
              : 'Left blank, we will search a spread of places you could realistically reach and show you the best way to each.'}
          </p>
        </div>

        <div class="plan__field">
          <label for={`${id}-date`}>Outbound date (required)</label>
          <input
            id={`${id}-date`}
            type="date"
            value={plan.date}
            min={todayIso()}
            disabled={props.busy}
            onChange={(ev) => set('date', (ev.target as HTMLInputElement).value)}
          />
        </div>

        <div class="plan__field">
          <label for={`${id}-time`}>Leave after</label>
          <input
            id={`${id}-time`}
            type="time"
            value={minutesToTime(plan.timeMin)}
            disabled={props.busy}
            onChange={(ev) => {
              const v = (ev.target as HTMLInputElement).value;
              const [h, m] = v.split(':').map(Number);
              if (Number.isFinite(h) && Number.isFinite(m)) set('timeMin', h * 60 + m);
            }}
          />
          <p class="plan__hint">We will not board you on anything that has already left.</p>
        </div>

        <div class="plan__field">
          <label for={`${id}-changes`}>Most changes you will accept</label>
          <select
            id={`${id}-changes`}
            value={plan.maxTransfers}
            disabled={props.busy}
            onChange={(ev) => set('maxTransfers', Number((ev.target as HTMLSelectElement).value))}
          >
            <option value={0}>Direct trains only</option>
            <option value={1}>1 change</option>
            <option value={2}>2 changes</option>
            <option value={3}>3 changes</option>
            <option value={4}>4 changes — show me anything</option>
          </select>
          <p class="plan__hint">
            If nothing is available direct, splitting the journey is often the answer. If we find
            nothing at this setting we widen it automatically and tell you.
          </p>
        </div>

        <div class="plan__field">
          <label for={`${id}-class`}>Preferred class</label>
          <select
            id={`${id}-class`}
            value={plan.preferredClass ?? ''}
            disabled={props.busy}
            onChange={(ev) => {
              const v = (ev.target as HTMLSelectElement).value;
              set('preferredClass', v === '' ? null : v);
            }}
          >
            {CLASS_CHOICES.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
          </select>
          <p class="plan__hint">
            A train that does not offer it is still shown, priced in the cheapest class it does —
            and marked, never passed off as what you asked for.
          </p>
        </div>

        <div class="plan__field">
          <label for={`${id}-return`}>Return date (optional)</label>
          <input
            id={`${id}-return`}
            type="date"
            value={plan.returnDate ?? ''}
            min={plan.date}
            disabled={props.busy}
            onChange={(ev) => {
              const v = (ev.target as HTMLInputElement).value;
              set('returnDate', v === '' ? null : v);
            }}
          />
        </div>

        <div class="plan__field">
          <label for={`${id}-days`}>Days at destination (optional)</label>
          <input
            id={`${id}-days`}
            type="number"
            min={1}
            max={60}
            value={plan.daysAtDestination ?? ''}
            disabled={props.busy}
            onChange={(ev) => {
              const v = Number((ev.target as HTMLInputElement).value);
              set('daysAtDestination', Number.isFinite(v) && v > 0 ? Math.min(60, Math.round(v)) : null);
            }}
          />
          {plan.daysAtDestination !== null && !plan.returnDate && (
            <button type="button" class="linkish" onClick={suggestReturn}>
              Suggest a return {addDaysIso(plan.date, plan.daysAtDestination)}
            </button>
          )}
        </div>
      </div>

      <div class="plan__actions">
        <button type="submit" class="btn btn--primary" disabled={!ready || props.busy}>
          {props.busy ? 'Searching…' : plan.destination ? 'Find itineraries' : 'Show me where I could go'}
        </button>
        {!props.canSearch && (
          <p class="plan__hint plan__hint--warn">{props.notReadyMessage}</p>
        )}
        {props.canSearch && !plan.origin && (
          <p class="plan__hint">Choose a starting station to search.</p>
        )}
      </div>
    </form>
  );
}

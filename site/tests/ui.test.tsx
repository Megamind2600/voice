/**
 * ui.test.tsx — accessibility and behaviour of the pieces a user touches first.
 *
 * The Phase 0 acceptance criterion is Lighthouse a11y >= 95, but Lighthouse only samples a
 * rendered page and cannot exercise the combobox. A custom autocomplete is the single
 * easiest place in this app to ship something that looks fine and is unusable with a
 * keyboard or a screen reader, so the ARIA contract is asserted here directly:
 *
 *   - focus never leaves the input; the highlight moves via aria-activedescendant
 *   - the listbox is only in the tree while expanded
 *   - every option has a stable id that aria-activedescendant can point at
 *   - state changes are announced through a polite live region
 *
 * It also pins the two facts the disclaimer is legally required to carry.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { Container, ContainerKind } from '../src/lib/binary';
import { StationIndex } from '../src/lib/stations';
import { StationAutocomplete } from '../src/ui/StationAutocomplete';
import { Disclaimer } from '../src/ui/Disclaimer';
import { buildStationsContainer } from './helpers';

const SPECS = [
  { code: 'SC', name: 'Secunderabad Jn', rank: 3, calls: 225 },
  { code: 'KCG', name: 'Kacheguda', rank: 2, calls: 119 },
  { code: 'HYB', name: 'Hyderabad Deccan', rank: 2, calls: 106 },
  { code: 'NDLS', name: 'New Delhi', rank: 3, calls: 229 },
  { code: 'HWH', name: 'Howrah Jn', rank: 3, calls: 283 },
];

function index(): StationIndex {
  return StationIndex.fromContainer(
    Container.parse(buildStationsContainer(SPECS), ContainerKind.Stations),
  );
}

function setup(props: Partial<Parameters<typeof StationAutocomplete>[0]> = {}) {
  const onSelect = vi.fn();
  const utils = render(
    <StationAutocomplete
      index={index()}
      label="Starting station"
      value={null}
      onSelect={onSelect}
      {...props}
    />,
  );
  const input = screen.getByRole('combobox') as HTMLInputElement;
  return { ...utils, onSelect, input };
}

describe('Disclaimer', () => {
  it('states that the service is unofficial', () => {
    render(<Disclaimer datasetLabel="BOOTSTRAP · 2016" />);
    expect(screen.getByText(/Not affiliated with/i)).toBeTruthy();
    // "IRCTC" legitimately appears twice: once in the affiliation denial and once in the
    // "confirm before travelling" instruction. Both are required, so assert on the pair.
    expect(screen.getAllByText(/IRCTC/).length).toBeGreaterThanOrEqual(2);
  });

  it('labels the dataset vintage whenever one is given', () => {
    render(<Disclaimer datasetLabel="BOOTSTRAP · 2016" />);
    expect(screen.getByText('BOOTSTRAP · 2016')).toBeTruthy();
    expect(screen.getByText(/may be out of date/i)).toBeTruthy();
  });

  it('says plainly that it cannot book tickets', () => {
    render(<Disclaimer datasetLabel="BOOTSTRAP · 2016" />);
    expect(screen.getByText(/cannot book tickets/i)).toBeTruthy();
  });

  it('omits the staleness paragraph when no dataset label is supplied', () => {
    render(<Disclaimer />);
    expect(screen.queryByText(/may be out of date/i)).toBeNull();
  });

  it('is a note landmark, not a live region', () => {
    // role="note" is right for static legal text; a live region would re-announce it on
    // every unrelated DOM change.
    render(<Disclaimer datasetLabel="BOOTSTRAP · 2016" />);
    const note = screen.getByRole('note');
    expect(note.getAttribute('aria-label')).toMatch(/notice/i);
  });
});

describe('StationAutocomplete ARIA contract', () => {
  it('exposes a combobox wired to a listbox it does not yet render', () => {
    const { input } = setup();
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(input.getAttribute('aria-autocomplete')).toBe('list');
    expect(input.getAttribute('aria-controls')).toBeTruthy();
    // The listbox must not be in the tree while collapsed.
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('is labelled by a real <label for=...>, not a placeholder', () => {
    const { input } = setup();
    expect(screen.getByText('Starting station').getAttribute('for')).toBe(input.id);
    expect(input.getAttribute('placeholder')).toBeTruthy();
  });

  it('opens on focus and offers the busiest stations first', async () => {
    const { input } = setup();
    await userEvent.click(input);
    expect(input.getAttribute('aria-expanded')).toBe('true');
    const options = screen.getAllByRole('option');
    expect(options.length).toBeGreaterThan(0);
    // Ordered by train traffic: Howrah (283) before Secunderabad (225).
    const names = options.map((o) => o.textContent ?? '');
    expect(names[0]).toMatch(/Howrah/);
  });

  it('gives every option an id and aria-selected', async () => {
    const { input } = setup();
    await userEvent.click(input);
    for (const o of screen.getAllByRole('option')) {
      expect(o.id).toBeTruthy();
      expect(o.getAttribute('aria-selected')).toMatch(/^(true|false)$/);
    }
  });

  it('filters as the user types', async () => {
    setup();
    await userEvent.type(screen.getByRole('combobox'), 'hyder');
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0].textContent).toMatch(/Hyderabad Deccan/);
  });

  it('explains a no-match result instead of showing an empty box', async () => {
    setup();
    await userEvent.type(screen.getByRole('combobox'), 'zzzz');
    expect(screen.queryByRole('option')).toBeNull();
    expect(screen.getByText(/No station matches/i)).toBeTruthy();
  });
});

describe('StationAutocomplete keyboard', () => {
  it('moves the highlight with ArrowDown without moving focus', async () => {
    const { input } = setup();
    await userEvent.click(input);
    expect(input.getAttribute('aria-activedescendant')).toBeFalsy();

    await userEvent.keyboard('{ArrowDown}');
    const first = input.getAttribute('aria-activedescendant');
    expect(first).toBeTruthy();
    expect(document.activeElement).toBe(input);      // focus must not leave the input

    await userEvent.keyboard('{ArrowDown}');
    const second = input.getAttribute('aria-activedescendant');
    expect(second).not.toBe(first);
    expect(document.getElementById(second!)).toBeTruthy();
  });

  it('moves the highlight up with ArrowUp and wraps', async () => {
    const { input } = setup();
    await userEvent.click(input);
    const total = screen.getAllByRole('option').length;
    await userEvent.keyboard('{ArrowUp}');
    // Wrapping to the last option is what makes the list navigable in both directions.
    expect(input.getAttribute('aria-activedescendant')).toBeTruthy();
    expect(screen.getAllByRole('option')[total - 1].id)
      .toBe(input.getAttribute('aria-activedescendant'));
  });

  it('jumps to the ends with Home and End', async () => {
    const { input } = setup();
    await userEvent.click(input);
    const options = screen.getAllByRole('option');
    await userEvent.keyboard('{End}');
    expect(input.getAttribute('aria-activedescendant')).toBe(options.at(-1)!.id);
    await userEvent.keyboard('{Home}');
    expect(input.getAttribute('aria-activedescendant')).toBe(options[0].id);
  });

  it('commits the highlighted option on Enter', async () => {
    const { input, onSelect } = setup();
    await userEvent.click(input);
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(onSelect).toHaveBeenCalledTimes(1);
    const picked = onSelect.mock.calls[0][0];
    expect(picked.name).toMatch(/Howrah/);
    expect(input.getAttribute('aria-expanded')).toBe('false');
  });

  it('does not commit on Escape, only closes', async () => {
    const { input, onSelect } = setup();
    await userEvent.click(input);
    await userEvent.keyboard('{ArrowDown}{Escape}');
    expect(onSelect).not.toHaveBeenCalled();
    expect(input.getAttribute('aria-expanded')).toBe('false');
  });

  it('announces the number of suggestions politely', async () => {
    setup();
    await userEvent.type(screen.getByRole('combobox'), 'hyder');
    const live = screen.getByRole('status');
    expect(live.getAttribute('aria-live')).toBe('polite');   // assertive would shout per keystroke
    expect(live.textContent).toMatch(/1 suggestion/);
  });
});

describe('StationAutocomplete states', () => {
  it('is disabled with an explanatory message before the dataset loads', () => {
    render(
      <StationAutocomplete
        index={null}
        label="Starting station"
        value={null}
        onSelect={() => {}}
        notReadyMessage="Loading station list…"
      />,
    );
    const input = screen.getByRole('combobox') as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(screen.getByRole('status').textContent).toMatch(/Loading station list/);
  });

  it('shows the current selection as text a screen reader can re-read', () => {
    const i = index();
    render(
      <StationAutocomplete
        index={i}
        label="Starting station"
        value={i.byCodeLookup('SC')!}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText(/Selected:/).textContent).toMatch(/Secunderabad Jn/);
    expect(screen.getByLabelText('Clear Starting station')).toBeTruthy();
  });
});

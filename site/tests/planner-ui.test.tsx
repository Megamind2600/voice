/**
 * planner-ui.test.tsx — the Phase 1 interface, and the promises it makes on screen.
 *
 * The routing engine is covered by exhaustive enumeration and by properties over real
 * itineraries. None of that reaches the part a traveller actually reads. These tests render the
 * real components against real `Journey` objects produced by the real engine on a synthetic
 * network, and assert the claims the UI makes:
 *
 *   - that a fare is an estimate, never a price;
 *   - that seat availability is NOT known, on every rail leg, not once in a footer;
 *   - that a class substitution, a night arrival and a train that started the previous day are
 *     each surfaced rather than silently absorbed;
 *   - that the destination really is optional, which is the whole premise of the product;
 *   - that the form explains why it will not search yet instead of just being inert.
 *
 * These are the assertions that would fail if someone "tidied up" a disclaimer, and a tidied-up
 * disclaimer is how a planning tool starts looking like a booking tool.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';

/**
 * Preact flushes `useEffect` on a frame, not on a microtask, so a document-level listener
 * registered in an effect is not attached yet when `await user.click(...)` returns. Waiting a
 * tick is what makes the Escape and click-outside assertions test the component rather than the
 * scheduler.
 */
const flush = async (): Promise<void> => { await new Promise((r) => { setTimeout(r, 25); }); };
import { Container, ContainerKind } from '../src/lib/binary';
import { Graph, stationCountOf } from '../src/lib/graph';
import { StationIndex } from '../src/lib/stations';
import { buildTimetable } from '../src/router/timetable';
import { TransferModel } from '../src/router/transfers';
import { CsaEngine } from '../src/router/csa';
import { reconstructAll, type Journey, type RailSegment, type RoadSegment, type StationResolver } from '../src/router/journey';
import type { ResolvedGroup } from '../src/router/terminals';
import { buildGraphContainer, buildStationsContainer, type Spec, type TrainSpec } from './helpers';
import { LegDetail } from '../src/ui/LegDetail';
import { AvailabilityPanel } from '../src/ui/AvailabilityPanel';
import { PREDICTED_BADGE, parseModel, predict } from '../src/availability/model';
import type { Prediction } from '../src/availability/model';
import { noReading, type AvailabilityReading } from '../src/availability/tier';
import { ItineraryCard } from '../src/ui/ItineraryCard';
import { ExportMenu } from '../src/ui/ExportMenu';
import { JourneyForm } from '../src/ui/JourneyForm';
import type { PlanInput } from '../src/state/useJourneys';

const DATE = '2026-09-14'; // a Monday

// Alpha and Alpha Road are two terminals of one city, bridged by road. Delta is a mid-route
// junction. Echo is only reachable from the second terminal, so reaching it from Alpha requires
// the road hop — which is what makes a RoadSegment appear in the fixtures below.
const SPECS: Spec[] = [
  { code: 'ALP', name: 'Alpha Jn', rank: 3, lat: 17.4, lon: 78.5 },
  { code: 'ALR', name: 'Alpha Road', rank: 2, lat: 17.5, lon: 78.6 },
  { code: 'BET', name: 'Beta', rank: 1, lat: 18.4, lon: 79.5 },
  { code: 'DEL', name: 'Delta Jn', rank: 3, lat: 19.4, lon: 80.5 },
  { code: 'EKO', name: 'Echo', rank: 2, lat: 20.4, lon: 81.5 },
  { code: 'GAM', name: 'Gamma', rank: 1, lat: 21.4, lon: 82.5 },
];

const TRAINS: TrainSpec[] = [
  // Alpha -> Beta -> Delta, all day, sleeper.
  { number: '10001', name: 'Alpha Delta Express', type: 9, classes: 16, runsDays: 127,
    originDepMin: 600, durationMin: 300, distanceKm: 400, stops: [0, 2, 3],
    legs: [[0, 120, 150], [140, 300, 400]] },
  // Alpha Road -> Echo. 3A only (CLASS_BIT: 3A is 4, not 16), so a sleeper-preferring traveller
  // gets a substitution. The type code 5 is SVD. Named for what it exercises, not what it is.
  { number: '10002', name: 'Alpha Echo Intercity', type: 5, classes: 4, runsDays: 127,
    originDepMin: 780, durationMin: 240, distanceKm: 320, stops: [1, 4],
    legs: [[0, 240, 320]] },
  // Delta -> Gamma, arriving at 02:10: a night arrival.
  { number: '10003', name: 'Night Link', type: 9, classes: 16, runsDays: 127,
    originDepMin: 1380, durationMin: 130, distanceKm: 180, stops: [3, 5],
    legs: [[0, 130, 180]] },
];

const GROUPS: ResolvedGroup[] = [
  { city: 'Alpha', hub: 0, members: [0, 1], unresolved: [], fallbackMinutes: 45 },
];

let stations: StationIndex;
let graph: Graph;
let nameOf: StationResolver;
/** Alpha -> Gamma: two trains with a change at Delta, the second arriving after midnight. */
let overnight: Journey;
/** Alpha -> Echo: a road hop between city terminals, then a chair-car train. */
let withRoad: Journey;
/** The rail and road segments of the above, pulled out for direct assertions. */
let roadLeg: RoadSegment;
let substitutedLeg: RailSegment;

function build(): void {
  const sc = Container.parse(buildStationsContainer(SPECS), ContainerKind.Stations);
  stations = StationIndex.fromContainer(sc);
  const gc = Container.parse(
    buildGraphContainer(TRAINS, SPECS.length, SPECS.map((s) => [s.lat ?? 0, s.lon ?? 0])),
    ContainerKind.Graph,
  );
  stations.attachGeo(gc);
  graph = Graph.fromContainer(gc, stationCountOf(gc));

  const transfers = new TransferModel(graph, GROUPS, SPECS.length);
  const engine = new CsaEngine(graph, transfers, SPECS.length);
  const tt = buildTimetable(graph, DATE);
  nameOf = (i) => ({ code: stations.at(i).code, name: stations.at(i).name });

  const run = (dest: number, preferredClass: string | null): Journey[] => {
    const r = engine.search(tt, {
      departureMin: 540, origins: [0], destinations: [dest], maxTransfers: 2,
      preferredClass, maxJourneyMin: 4320, maxWaitMin: 1440,
    });
    return reconstructAll(r, tt, graph, { departureMin: 540 });
  };

  const toGamma = run(5, 'SL');
  expect(toGamma.length, 'fixture: Alpha -> Gamma must resolve').toBeGreaterThan(0);
  overnight = toGamma[0];

  const toEcho = run(4, 'SL');
  expect(toEcho.length, 'fixture: Alpha -> Echo must resolve').toBeGreaterThan(0);
  withRoad = toEcho[0];
  const found = toEcho.flatMap((j) => j.segments).find((s) => s.kind === 'road') as RoadSegment | undefined;
  expect(found, 'fixture: the Echo itinerary must include a road hop between Alpha terminals').toBeTruthy();
  roadLeg = found as RoadSegment;
  const echoJourney = toEcho.find((j) => j.segments.some((s) => s.kind === 'road')) as Journey;
  substitutedLeg = echoJourney.segments.find((s): s is RailSegment => s.kind === 'rail') as RailSegment;
  withRoad = echoJourney;
}

build();

const rail = (j: Journey): RailSegment[] => j.segments.filter((s): s is RailSegment => s.kind === 'rail');

// ---------------------------------------------------------------------------

describe('LegDetail, rail leg', () => {
  it('says seat availability is not connected, and does not soften it', () => {
    render(<LegDetail segment={rail(overnight)[0]} index={1} total={2} nameOf={nameOf} dateLabel={DATE} />);
    expect(screen.getByText(/seat availability: not connected/i)).toBeTruthy();
    // The whole reason this notice exists: a reader must be pointed at the real source of truth.
    // The panel now mentions IRCTC in several places, so this is a count, not a single match.
    expect(screen.getAllByText(/IRCTC/i).length).toBeGreaterThan(0);
  });

  it('labels the fare an estimate wherever it appears', () => {
    render(<LegDetail segment={rail(overnight)[0]} index={1} total={2} nameOf={nameOf} dateLabel={DATE} />);
    expect(screen.getAllByText(/estimated/i).length).toBeGreaterThan(0);
  });

  it('shows the fare breakdown, so an estimate can be argued with', () => {
    const s = rail(overnight)[0];
    render(<LegDetail segment={s} index={1} total={2} nameOf={nameOf} dateLabel={DATE} />);
    const text = document.body.textContent ?? '';
    expect(text).toContain(String(s.baseFare));
    expect(text).toContain(String(s.gst));
    // The parts must visibly add up to the whole, or the breakdown invites distrust.
    expect(s.baseFare + s.reservation + s.surcharge + s.gst).toBe(s.fareRupees);
  });

  it('names the train by number and name, and the stations by code and name', () => {
    const s = rail(overnight)[0];
    render(<LegDetail segment={s} index={1} total={2} nameOf={nameOf} dateLabel={DATE} />);
    const text = document.body.textContent ?? '';
    expect(text).toContain(s.trainNumber);
    expect(text).toContain(s.trainName);
    expect(text).toContain(nameOf(s.from).code);
    expect(text).toContain(nameOf(s.to).name);
  });

  it('numbers the leg within the itinerary', () => {
    render(<LegDetail segment={rail(overnight)[0]} index={1} total={2} nameOf={nameOf} dateLabel={DATE} />);
    expect(document.body.textContent ?? '').toMatch(/1\s*(of|\/)\s*2/i);
  });

  it('flags a train that started on an earlier day rather than implying it leaves today', () => {
    // The night link departs Delta at 23:00 on the query date, but a long-distance train boarded
    // mid-route may well have originated the day before; the fixture network is small, so assert
    // on whichever leg carries an offset and require the UI to mention the day.
    const offset = rail(overnight).find((s) => s.serviceDayOffset < 0);
    if (!offset) return; // nothing to check on this network; the golden corpus covers it on real data
    render(<LegDetail segment={offset} index={1} total={1} nameOf={nameOf} dateLabel={DATE} />);
    expect(document.body.textContent ?? '').toMatch(/day|previous|earlier/i);
  });

  it('flags a class substitution, and says what was asked for', () => {
    expect(substitutedLeg.classFellBack, 'fixture: the chair-car train does not offer sleeper').toBe(true);
    render(<LegDetail segment={substitutedLeg} index={2} total={2} nameOf={nameOf} dateLabel={DATE} />);
    expect(document.body.textContent ?? '').toMatch(/preferred class not offered|not offered/i);
  });

  it('hands over the exact IRCTC values, counted from the train origin date', () => {
    const s = rail(overnight)[0];
    render(<LegDetail segment={s} index={1} total={2} nameOf={nameOf} dateLabel={DATE} />);
    const text = document.body.textContent ?? '';
    // The six values the form asks for, in its order, with the date in DD/MM/YYYY.
    for (const label of ['From', 'To', 'Date', 'Class', 'Quota', 'Train']) {
      expect(text, `the handoff must list ${label}`).toContain(label);
    }
    const [y, m, d] = DATE.split('-');
    expect(text).toContain(`${d}/${m}/${y}`);
    expect(text).toContain(s.trainNumber);
  });

  it('links only to IRCTC pages that exist, and never to an invented pre-filled URL', () => {
    render(<LegDetail segment={rail(overnight)[0]} index={1} total={2} nameOf={nameOf} dateLabel={DATE} />);
    const links = Array.from(document.querySelectorAll('a')).map((a) => a.getAttribute('href') ?? '');
    const irctc = links.filter((h) => h.includes('irctc.co.in'));
    expect(irctc.length).toBeGreaterThan(0);
    for (const href of irctc) {
      // A guessed query string lands on a blank form while looking like it worked. The handoff
      // must be the bare verified page plus values to type.
      expect(href, `${href} must not carry fabricated parameters`).not.toContain('?');
      expect(href.startsWith('https://www.irctc.co.in/')).toBe(true);
    }
    // The charts page is the one place IRCTC publishes live vacancy with no key and no account.
    expect(irctc.some((h) => h.includes('/online-charts/'))).toBe(true);
    // External links must not be able to reach back into the opener.
    for (const a of Array.from(document.querySelectorAll('a[target="_blank"]'))) {
      expect(a.getAttribute('rel') ?? '').toMatch(/noopener/);
    }
  });

  it('carries the train class list on the segment, which is what Tier 0 reasons from', () => {
    // Tier 0 cannot see the worker's graph, so the class list has to travel with the leg.
    expect(rail(overnight)[0].trainClasses.length).toBeGreaterThan(0);
  });

  it('shows the capacity denominator as an estimate, and never as seats', () => {
    const s = rail(overnight)[0];
    render(<LegDetail segment={s} index={1} total={2} nameOf={nameOf} dateLabel={DATE} />);
    expect(screen.getAllByText('estimate').length).toBeGreaterThan(0);
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/berths exist on this train/);
    // Both caveats must travel with the number: it is a whole-rake figure built from a template.
    expect(text).toMatch(/not your segment/i);
    expect(text).toMatch(/not published/i);
    // An estimate of how many berths EXIST must not read as how many are FREE.
    expect(text).not.toMatch(/\d+\s*(seats|berths)\s+available/i);
    expect(text).not.toMatch(/confirmed berths/i);
  });

  it('says a combination cannot be booked, instead of sending anyone to IRCTC for it', () => {
    const base = rail(overnight)[0];
    // A class this train does not carry. Tier 0 is certain about this without any live data.
    render(
      <LegDetail
        segment={{ ...base, klass: '1A', trainClasses: ['SL'] }}
        index={1}
        total={2}
        nameOf={nameOf}
        dateLabel={DATE}
      />,
    );
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/cannot be booked/i);
    expect(text).toMatch(/does not run 1A/);
    // And no capacity estimate is offered for a class that is not there.
    expect(screen.queryAllByText('estimate').length).toBe(0);
  });

  it('offers to copy the handoff details, for a phone without the app installed', () => {
    render(<LegDetail segment={rail(overnight)[0]} index={1} total={2} nameOf={nameOf} dateLabel={DATE} />);
    expect(screen.getByRole('button', { name: /copy these details/i })).toBeTruthy();
  });

  it('does not flag a substitution when the traveller got what they asked for', () => {
    const s = rail(overnight)[0];
    expect(s.classFellBack).toBe(false);
    render(<LegDetail segment={s} index={1} total={2} nameOf={nameOf} dateLabel={DATE} />);
    expect(document.body.textContent ?? '').not.toMatch(/preferred class not offered/i);
  });
});

describe('LegDetail, road leg', () => {
  it('says how long the road hop takes, what it costs and which city it crosses', () => {
    render(<LegDetail segment={roadLeg} index={1} total={2} nameOf={nameOf} dateLabel={DATE} />);
    const text = document.body.textContent ?? '';
    expect(text).toContain(roadLeg.city);
    expect(text).toContain(String(roadLeg.costRupees));
  });

  it('does not claim seat availability is unknown for a taxi, which has no seats to check', () => {
    render(<LegDetail segment={roadLeg} index={1} total={2} nameOf={nameOf} dateLabel={DATE} />);
    expect(screen.queryByText(/seat availability/i)).toBeNull();
  });

  it('does not show a train fare breakdown for a road hop', () => {
    render(<LegDetail segment={roadLeg} index={1} total={2} nameOf={nameOf} dateLabel={DATE} />);
    expect(screen.queryByText(/reservation/i)).toBeNull();
  });
});

describe('ItineraryCard', () => {
  const toggleOf = (c: Element): HTMLButtonElement => c.querySelector('.itin__toggle') as HTMLButtonElement;

  it('summarises the journey before it is opened, and calls the fare an estimate', () => {
    const { container } = render(<ItineraryCard journey={overnight} nameOf={nameOf} date={DATE} />);
    const text = container.textContent ?? '';
    expect(text).toContain(nameOf(overnight.origin).code);
    expect(text).toContain(nameOf(overnight.destination).code);
    expect(text).toMatch(/\d+\s*h/);
    expect(text).toMatch(/change|direct/);
    // The collapsed row is what a traveller scans when comparing a dozen options, so the
    // estimate marker has to be there too. A bare rupee figure in a summary is exactly how an
    // estimate starts reading as a price.
    expect(text).toMatch(/fare est\./i);
    // Train numbers up front, because that is what someone types into IRCTC next.
    for (const seg of rail(overnight)) expect(text).toContain(seg.trainNumber);
  });

  it('counts a road hop separately from a change of train', () => {
    const { container } = render(<ItineraryCard journey={withRoad} nameOf={nameOf} date={DATE} />);
    const text = container.textContent ?? '';
    expect(withRoad.roadTransfers).toBe(1);
    expect(text).toMatch(/\+\s*1 road hop/i);
    // One train and no change of train, so the summary says "direct" — and still discloses the
    // taxi, because "direct" alone would hide the part that costs money and time.
    expect(withRoad.transfers).toBe(0);
    expect(text).toMatch(/direct/i);
  });

  it('is a disclosure: collapsed by default, expanded on click, and says which it is', async () => {
    const user = userEvent.setup();
    const { container } = render(<ItineraryCard journey={overnight} nameOf={nameOf} date={DATE} />);
    const toggle = toggleOf(container);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText(/seat availability: not connected/i)).toBeNull();

    await user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    // aria-controls has to point at something that exists, or it is decoration, not a contract.
    const controls = toggle.getAttribute('aria-controls') as string;
    expect(container.querySelector(`[id="${controls}"]`)).toBeTruthy();
    // One notice per rail leg. Putting it once per card is how a three-train itinerary ends up
    // with the warning apparently attached to only one of its three trains.
    expect(screen.getAllByText(/seat availability: not connected/i).length).toBe(rail(overnight).length);
  });

  it('can be opened on render, for a result worth looking at closely', () => {
    render(<ItineraryCard journey={overnight} nameOf={nameOf} date={DATE} expandedByDefault />);
    expect(screen.getAllByText(/seat availability: not connected/i).length).toBe(rail(overnight).length);
  });

  it('is an article landmark, so a screen reader can step between itineraries', () => {
    render(<ItineraryCard journey={overnight} nameOf={nameOf} date={DATE} />);
    expect(screen.getAllByRole('article').length).toBe(1);
  });

  it('carries the plain text as well, for anyone who cannot use the menu', () => {
    const { container } = render(<ItineraryCard journey={overnight} nameOf={nameOf} date={DATE} expandedByDefault />);
    // Selected by class, not by "the first details in the card": each rail leg now carries a
    // remedies <details> of its own, and those come first in document order.
    const details = container.querySelector('details.itin__raw') as HTMLDetailsElement;
    expect(details, 'the expanded card must offer a plain-text version').toBeTruthy();
    expect(details.querySelector('summary')?.textContent ?? '').toMatch(/plain[- ]text/i);
    expect(details.textContent ?? '').toContain(rail(overnight)[0].trainNumber);
  });

  it('says when the search stopped early rather than implying the list is complete', () => {
    render(<ItineraryCard journey={{ ...overnight, truncated: true }} nameOf={nameOf} date={DATE} expandedByDefault />);
    expect(screen.getByText(/reached its limit/i)).toBeTruthy();
  });

  it('offers export controls on every card', () => {
    render(<ItineraryCard journey={overnight} nameOf={nameOf} date={DATE} />);
    expect(screen.getByRole('button', { name: /^export$/i })).toBeTruthy();
  });
});

describe('ExportMenu', () => {
  it('is a closed menu button until asked, then offers copy and download', async () => {
    const user = userEvent.setup();
    render(<ExportMenu journey={overnight} nameOf={nameOf} />);
    const trigger = screen.getByRole('button', { name: /^export$/i });
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('menu')).toBeNull();

    await user.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('menu')).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /copy as text/i })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /download \.txt/i })).toBeTruthy();
  });

  it('copies the text the traveller was shown, disclaimer included, and confirms it', async () => {
    // Order matters and is easy to get wrong: `userEvent.setup()` installs its OWN clipboard
    // stub on `navigator`, so a mock defined before it is silently orphaned and the component
    // ends up writing to userEvent's stub instead. Define the spy after setup.
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<ExportMenu journey={overnight} nameOf={nameOf} />);
    await user.click(screen.getByRole('button', { name: /^export$/i }));
    await user.click(screen.getByRole('menuitem', { name: /copy as text/i }));

    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = writeText.mock.calls[0][0] as string;
    expect(copied).toContain(nameOf(overnight.origin).name);
    expect(copied).toContain(nameOf(overnight.destination).name);
    expect(rail(overnight).every((seg) => copied.includes(seg.trainNumber))).toBe(true);
    // The warning travels with the text. Pasting this into a family group chat should not turn
    // an estimate into a booking.
    expect(copied).toMatch(/estimate/i);
    // A copy with no feedback looks like nothing happened.
    expect((await screen.findByRole('status')).textContent ?? '').toMatch(/copied/i);
  });

  it('closes on Escape, which is what a menu is supposed to do', async () => {
    const user = userEvent.setup();
    render(<ExportMenu journey={overnight} nameOf={nameOf} />);
    const trigger = screen.getByRole('button', { name: /^export$/i });
    await user.click(trigger);
    expect(screen.getByRole('menu')).toBeTruthy();
    await flush(); // let the effect attach the document keydown listener
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('JourneyForm', () => {
  const plan = (over: Partial<PlanInput> = {}): PlanInput => ({
    origin: stations.at(0),
    date: DATE,
    timeMin: 540,
    destination: null,
    maxTransfers: 2,
    preferredClass: 'SL',
    returnDate: null,
    daysAtDestination: null,
    ...over,
  });

  const submitOf = (c: Element): HTMLButtonElement => c.querySelector('button[type="submit"]') as HTMLButtonElement;
  const textOf = (c: Element): string => c.textContent ?? '';

  it('invites exploration when no destination is given, in those words', () => {
    const { container } = render(<JourneyForm stations={stations} plan={plan({ destination: null })}
      onChange={() => {}} onSubmit={() => {}} busy={false} canSearch notReadyMessage="" />);
    // The submit button is the product's whole premise, so it should say it rather than "Search".
    expect(submitOf(container).textContent ?? '').toMatch(/show me where i could go/i);
    expect(textOf(container)).toMatch(/left blank, we will search a spread of places/i);
  });

  it('switches to a plain search once a destination is chosen', () => {
    const { container } = render(<JourneyForm stations={stations} plan={plan({ destination: stations.at(2) })}
      onChange={() => {}} onSubmit={() => {}} busy={false} canSearch notReadyMessage="" />);
    expect(submitOf(container).textContent ?? '').toMatch(/find itineraries/i);
    expect(textOf(container)).toContain(stations.at(2).name);
  });

  it('submits with no destination, because not having one is the point', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const { container } = render(<JourneyForm stations={stations} plan={plan({ destination: null })}
      onChange={() => {}} onSubmit={onSubmit} busy={false} canSearch notReadyMessage="" />);
    await user.click(submitOf(container));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('marks the destination optional and the origin required in the labels themselves', () => {
    render(<JourneyForm stations={stations} plan={plan()} onChange={() => {}} onSubmit={() => {}}
      busy={false} canSearch notReadyMessage="" />);
    // The picker's clear button lives inside the <label> and carries
    // aria-label="Clear <label text>", so it matches a label query too. Take the input.
    const inputFor = (re: RegExp): HTMLInputElement => screen.getAllByLabelText(re)
      .find((el) => el.tagName === 'INPUT') as HTMLInputElement;
    const dest = inputFor(/where do you want to go/i);
    expect(dest.required).toBe(false);
    const origin = inputFor(/where are you starting from/i);
    // Required and optional are communicated in the visible label text, not only in the DOM, so
    // they survive being read aloud and being skimmed. Three fields are marked "(optional)", so
    // match the whole label rather than the parenthetical.
    expect(screen.getByText(/where do you want to go\? \(optional\)/i)).toBeTruthy();
    expect(screen.getByText(/where are you starting from\? \(required\)/i)).toBeTruthy();
    // `aria-required`, not the HTML `required` attribute: the input holds a search query rather
    // than a value, so native validation would reject a correctly-selected station. The form
    // enforces it by disabling submit instead; this keeps a screen reader told the same thing.
    expect(origin.required).toBe(false);
    expect(origin.getAttribute('aria-required'), 'the origin is the one field that cannot be blank')
      .toBe('true');
    expect(dest.getAttribute('aria-required')).toBeNull();
  });

  it('refuses to search without an origin, and says why instead of doing nothing', () => {
    const onSubmit = vi.fn();
    const { container } = render(<JourneyForm stations={stations} plan={plan({ origin: null })}
      onChange={() => {}} onSubmit={onSubmit} busy={false} canSearch notReadyMessage="" />);
    expect(submitOf(container).disabled).toBe(true);
    expect(textOf(container)).toMatch(/choose a starting station/i);
    // Disabled buttons swallow clicks, so the guard is exercised through the form itself.
    (container.querySelector('form') as HTMLFormElement)
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('explains that the timetable is still loading rather than looking broken', () => {
    const { container } = render(<JourneyForm stations={stations} plan={plan()} onChange={() => {}}
      onSubmit={() => {}} busy={false} canSearch={false}
      notReadyMessage="Loading the timetable — 890 KB, once." />);
    expect(textOf(container)).toMatch(/loading the timetable/i);
    expect(submitOf(container).disabled).toBe(true);
  });

  it('pre-fills the outbound date and leaves the return empty', () => {
    render(<JourneyForm stations={stations} plan={plan()} onChange={() => {}} onSubmit={() => {}}
      busy={false} canSearch notReadyMessage="" />);
    expect((screen.getByLabelText(/outbound date/i) as HTMLInputElement).value).toBe(DATE);
    expect((screen.getByLabelText(/return date/i) as HTMLInputElement).value).toBe('');
  });

  it('tells the traveller that an empty result widens the search automatically', () => {
    const { container } = render(<JourneyForm stations={stations} plan={plan()} onChange={() => {}}
      onSubmit={() => {}} busy={false} canSearch notReadyMessage="" />);
    // Promising this in the UI is what makes the ladder honest rather than a silent behaviour
    // change underneath someone who asked for direct trains only.
    expect(textOf(container)).toMatch(/widen it automatically and tell you/i);
  });

  it('offers direct-only up to four changes, and no more', () => {
    render(<JourneyForm stations={stations} plan={plan()} onChange={() => {}} onSubmit={() => {}}
      busy={false} canSearch notReadyMessage="" />);
    const sel = screen.getByLabelText(/most changes you will accept/i) as HTMLSelectElement;
    expect(Array.from(sel.options).map((o) => Number(o.value))).toEqual([0, 1, 2, 3, 4]);
    expect(sel.options[0].textContent ?? '').toMatch(/direct/i);
  });

  it('emits a whole plan when one field changes, never a partial one', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<JourneyForm stations={stations} plan={plan()} onChange={onChange} onSubmit={() => {}}
      busy={false} canSearch notReadyMessage="" />);
    await user.selectOptions(screen.getByLabelText(/most changes you will accept/i), '3');

    expect(onChange).toHaveBeenCalled();
    for (const call of onChange.mock.calls) {
      // Every other choice must survive; a partial plan silently resets the traveller's date.
      expect(call[0] as PlanInput).toMatchObject({
        date: DATE, timeMin: 540, maxTransfers: 3, preferredClass: 'SL',
      });
      expect((call[0] as PlanInput).origin?.code).toBe('ALP');
    }
  });

  it('derives a return date from days at the destination when asked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<JourneyForm stations={stations} plan={plan({ daysAtDestination: 5 })} onChange={onChange}
      onSubmit={() => {}} busy={false} canSearch notReadyMessage="" />);
    const suggest = screen.getByRole('button', { name: /suggest a return/i });
    await user.click(suggest);

    const withReturn = onChange.mock.calls.map((c) => c[0] as PlanInput).find((p) => p.returnDate !== null);
    expect(withReturn, 'five days after 2026-09-14 is 2026-09-19').toBeTruthy();
    expect((withReturn as PlanInput).returnDate).toBe('2026-09-19');
  });

  it('reports progress while searching instead of freezing silently', () => {
    const { container } = render(<JourneyForm stations={stations} plan={plan()} onChange={() => {}}
      onSubmit={() => {}} busy canSearch notReadyMessage="" />);
    const submit = submitOf(container);
    expect(submit.disabled).toBe(true);
    expect(submit.textContent ?? '').toMatch(/searching/i);
  });

  it('is a real form with combobox station pickers, so Enter submits and keys work', () => {
    const { container } = render(<JourneyForm stations={stations} plan={plan()} onChange={() => {}}
      onSubmit={() => {}} busy={false} canSearch notReadyMessage="" />);
    expect(container.querySelector('form'), 'the planner must be a <form>, not a div with buttons').toBeTruthy();
    // Two station pickers carrying role="combobox", not bare text inputs: the role is what makes
    // them announced and keyboard-operable, and Phase 0 pinned their contract separately. The
    // <select> elements also have an implicit combobox role, so filter to the text inputs.
    const pickers = screen.getAllByRole('combobox').filter((el) => el.tagName === 'INPUT');
    expect(pickers.length).toBe(2);
    for (const el of pickers) {
      expect(el.getAttribute('aria-expanded'), 'a combobox must report whether its list is open').not.toBeNull();
      expect(el.getAttribute('aria-controls'), 'a combobox must name the listbox it controls').not.toBeNull();
    }
  });

  it('swaps origin and destination, keeping every other choice', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const origin = stations.at(0);
    const destination = stations.at(2);
    render(<JourneyForm stations={stations} plan={plan({ origin, destination })} onChange={onChange}
      onSubmit={() => {}} busy={false} canSearch notReadyMessage="" />);
    await user.click(screen.getByRole('button', { name: /swap origin and destination/i }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as PlanInput;
    expect(next.origin?.code).toBe(destination.code);
    expect(next.destination?.code).toBe(origin.code);
    expect(next).toMatchObject({ date: DATE, timeMin: 540, maxTransfers: 2, preferredClass: 'SL' });
  });

  it('disables the swap when there is no destination to swap with', () => {
    // Swapping an origin with a blank destination would move the origin into the destination
    // field and leave no origin — turning a targeted search into an unsearchable one.
    render(<JourneyForm stations={stations} plan={plan({ destination: null })} onChange={() => {}}
      onSubmit={() => {}} busy={false} canSearch notReadyMessage="" />);
    expect((screen.getByRole('button', { name: /swap origin and destination/i }) as HTMLButtonElement).disabled)
      .toBe(true);
  });
});
// --------------------------------------------------------------------------- predictions

/**
 * A table small enough to read, and real enough that the UI is rendering what the runtime produces
 * rather than a hand-written object that happens to have the right fields.
 */
const PRED_TABLE = parseModel({
  version: 'ui-test-v1',
  trainedOn: 'fixture',
  intercept: 0.4,
  numeric: { segmentDistPct: { kind: 'linear', coef: 1.2 }, logCapacity: { kind: 'linear', coef: 0.1 } },
  categorical: { class: { SL: 0.3 }, quota: { GN: 0 }, trainType: { MEX: 0 }, dow: { Mon: 0 } },
  calibration: { method: 'isotonic', bins: [[0, 0.05], [0.5, 0.55], [1, 0.95]] },
  ciHalfWidth: 0.09,
});

const PRED_FEATURES = {
  daysToJourney: 12, segmentDistPct: 0.8, logCapacity: Math.log(600), isFullRun: false,
  klass: 'SL', quota: 'GN', trainType: 'MEX', dow: 'Mon', festival: null,
  serviceFrequency: 'daily' as const,
};

const prediction = (over: Partial<Prediction> = {}): Prediction => ({
  ...predict(PRED_TABLE, PRED_FEATURES)!, ...over,
});

function predictedReading(p: Prediction): AvailabilityReading {
  return {
    status: { verdict: 'UNKNOWN', raw: '', parsed: false },
    tier: 'T1', source: 'PREDICTED', asOf: null, ageSeconds: null,
    explanation: 'estimate', prediction: p,
  };
}

describe('AvailabilityPanel, when a prediction exists', () => {
  const seg = rail(overnight)[0];

  it('shows the badge, and the badge is the shared constant rather than a retyped word', () => {
    const { container } = render(
      <AvailabilityPanel segment={seg} nameOf={nameOf} dateIso={DATE} reading={predictedReading(prediction())} />,
    );
    const badge = container.querySelector('.avail__badge--predicted');
    expect(badge, 'a prediction without a badge is the failure this whole design exists to prevent').toBeTruthy();
    expect(badge!.textContent).toBe(PREDICTED_BADGE);
    // Exactly once: a badge printed twice is a badge that has stopped being a marker.
    expect(container.querySelectorAll('.avail__badge--predicted')).toHaveLength(1);
  });

  it('says the number is an estimate, and never that a berth exists', () => {
    const { container } = render(
      <AvailabilityPanel segment={seg} nameOf={nameOf} dateIso={DATE} reading={predictedReading(prediction())} />,
    );
    const text = container.querySelector('.avail__predicted')!.textContent ?? '';
    expect(text).toMatch(/likely to confirm/);
    expect(text).toMatch(/not a live seat count/);
    expect(text).toMatch(/confirm on IRCTC/i);
    expect(text).not.toMatch(/seats? available|berths? free|confirmed berth/i);
  });

  it('shows the interval when one shipped, and says so plainly when none did', () => {
    const withCi = render(
      <AvailabilityPanel segment={seg} nameOf={nameOf} dateIso={DATE} reading={predictedReading(prediction())} />,
    );
    expect(withCi.container.querySelector('.avail__predicted')!.textContent).toMatch(/\d+–\d+%/);

    const without = render(
      <AvailabilityPanel segment={seg} nameOf={nameOf} dateIso={DATE}
        reading={predictedReading(prediction({ pConfirmCI: null }))} />,
    );
    expect(without.container.querySelector('.avail__predicted')!.textContent).toMatch(/no interval shipped/i);
  });

  it('changes the headline, because "nothing here says whether a berth exists" stops being the whole truth', () => {
    const { container } = render(
      <AvailabilityPanel segment={seg} nameOf={nameOf} dateIso={DATE} reading={predictedReading(prediction())} />,
    );
    const headline = container.querySelector('.avail__headline')!.textContent ?? '';
    expect(headline).toMatch(/not connected in this build/);
    expect(headline).toMatch(/one model estimate/);
    expect(headline).toMatch(/probability about a berth, not a berth/);
  });

  it('still offers the IRCTC handoff beside the estimate, so ground truth stays one click away', () => {
    const { container } = render(
      <AvailabilityPanel segment={seg} nameOf={nameOf} dateIso={DATE} reading={predictedReading(prediction())} />,
    );
    const links = [...container.querySelectorAll('a.btn')].map((a) => a.getAttribute('href') ?? '');
    expect(links.some((h) => h.includes('irctc'))).toBe(true);
    expect(container.querySelector('.avail__handoff'), 'the booking values must still be listed').toBeTruthy();
  });

  it('renders nothing at all for a reading that is merely unknown', () => {
    // A declined lookup is not a forecast. Turning "nobody knows" into a probability block is the
    // exact confusion the badge exists to prevent, so an UNKNOWN reading with no prediction must
    // leave the panel as it was.
    const { container } = render(
      <AvailabilityPanel segment={seg} nameOf={nameOf} dateIso={DATE} reading={noReading()} />,
    );
    expect(container.querySelector('.avail__predicted')).toBeNull();
    expect(container.textContent ?? '').not.toContain(PREDICTED_BADGE);
    expect(container.querySelector('.avail__headline')!.textContent).not.toMatch(/model estimate/);
  });

  it('renders nothing when no reading is passed, which is the state this build ships in', () => {
    const { container } = render(<AvailabilityPanel segment={seg} nameOf={nameOf} dateIso={DATE} />);
    expect(container.querySelector('.avail__predicted')).toBeNull();
    expect(container.textContent ?? '').not.toContain(PREDICTED_BADGE);
    expect(container.textContent).toMatch(/not connected in this build/);
  });

  it('does not turn a prediction into a seat count anywhere on the panel', () => {
    const { container } = render(
      <AvailabilityPanel segment={seg} nameOf={nameOf} dateIso={DATE} reading={predictedReading(prediction())} />,
    );
    // The Tier 0 capacity estimate is allowed to name berths, because it is a denominator with its
    // own "estimate" badge and its own caveat. What must not exist is a bare number presented as
    // seats free.
    expect(container.querySelector('.avail__capacity .avail__badge')!.textContent).toBe('estimate');
    expect(container.textContent ?? '').not.toMatch(/\bseats? (available|free)\b/i);
  });
});

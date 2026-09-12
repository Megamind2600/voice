/**
 * remedies-ui.test.ts — the panel that makes the central feature visible.
 *
 * Leg-splitting and the other six remedies existed as pure functions before this; nothing
 * rendered them. These tests cover the two halves that could silently go wrong.
 *
 * The first is fidelity: `stopsFromRaw()` reconstructs the same `Stop` records the graph builds
 * internally, because remedy ① decides feasibility from one and the router built the leg from the
 * other. A parity test against `Graph.stopsOfTrain` is the only way to know they agree, since a
 * plausible-looking off-by-one in `dayOff` or `haltMin` would produce splits that look fine and
 * are not.
 *
 * The second is honesty under failure. The panel needs a worker round trip, so it can be opened
 * before the data arrives, after the worker dies, or with no station list at all. Each of those
 * must say what happened rather than render an empty remedy list that reads as "there is nothing
 * you can do" — which is the single most discouraging wrong answer this app could give.
 *
 * Note on triggering: a real browser fires `toggle` when a summary is clicked. jsdom does not do
 * that reliably, so these tests set `open` and dispatch the event, which is what the browser would
 * have done. Testing through a click would pass or fail on a jsdom implementation detail rather
 * than on the component.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/preact';
import { h } from 'preact';
import { Container, ContainerKind } from '../src/lib/binary';
import { Graph, stationCountOf } from '../src/lib/graph';
import { StationIndex } from '../src/lib/stations';
import { buildTimetable } from '../src/router/timetable';
import { TransferModel } from '../src/router/transfers';
import { roadMinutes } from '../src/router/transfers';
import { haversineKm } from '../src/lib/geo';
import { CsaEngine } from '../src/router/csa';
import { reconstructAll, type Journey, type RailSegment } from '../src/router/journey';
import type { ResolvedGroup } from '../src/router/terminals';
import type { RawStop } from '../src/lib/protocol';
import { buildGraphContainer, buildStationsContainer, type Spec, type TrainSpec } from './helpers';
import { PlannerDepsContext } from '../src/ui/deps';
import { RemediesPanel } from '../src/ui/RemediesPanel';
import { buildRemedyContext, cityAlternatives, stopsFromRaw } from '../src/state/remedyContext';

// The worker client is mocked: the panel asks it for a train's stops, and the mock answers from
// the same graph the real worker would, so the contract under test is the real one.
const mock = vi.hoisted(() => ({
  stops: [] as RawStop[],
  fail: false,
  calls: 0,
  lastTrain: -1,
}));

vi.mock('../src/state/client', () => ({
  router: {
    request(req: { type: string; train?: number }): Promise<unknown> {
      mock.calls++;
      mock.lastTrain = req.train ?? -1;
      if (mock.fail) return Promise.reject(new Error('the worker stopped responding'));
      return Promise.resolve({
        id: 1, ok: true, type: 'train:stops', train: null, stops: mock.stops,
      });
    },
  },
}));

const DATE = '2026-09-14'; // a Monday

const SPECS: Spec[] = [
  { code: 'ALP', name: 'Alpha Jn', rank: 3, lat: 17.4, lon: 78.5 },
  { code: 'ALR', name: 'Alpha Road', rank: 2, lat: 17.5, lon: 78.6 },
  { code: 'BET', name: 'Beta', rank: 1, lat: 18.4, lon: 79.5 },
  { code: 'DEL', name: 'Delta Jn', rank: 3, lat: 19.4, lon: 80.5 },
  { code: 'EKO', name: 'Echo', rank: 2, lat: 20.4, lon: 81.5 },
  { code: 'GAM', name: 'Gamma', rank: 1, lat: 21.4, lon: 82.5 },
];

const TRAINS: TrainSpec[] = [
  // Alpha -> Beta -> Delta -> Gamma, all day, sleeper. Two intermediate stops, so the Alpha to
  // Delta leg has somewhere to split.
  { number: '10001', name: 'Alpha Gamma Express', type: 9, classes: 16, runsDays: 127,
    originDepMin: 600, durationMin: 540, distanceKm: 700, stops: [0, 2, 3, 5],
    legs: [[0, 120, 150], [140, 300, 400], [320, 540, 700]] },
  // Alpha Road -> Echo. A genuine chair-car service: type 2 is SHT and CLASS_BIT CC is 32. This
  // is what makes the berth-position quotas impossible, so the bit values matter here — an earlier
  // version of this fixture used classes: 4, which is 3A, and the test passed for the wrong reason.
  { number: '10002', name: 'Alpha Echo Intercity', type: 2, classes: 32, runsDays: 127,
    originDepMin: 780, durationMin: 240, distanceKm: 320, stops: [1, 4],
    legs: [[0, 240, 320]] },
];

const GROUPS: ResolvedGroup[] = [
  { city: 'Alpha', hub: 0, members: [0, 1], unresolved: [], fallbackMinutes: 45 },
];

let stations: StationIndex;
let graph: Graph;
let sleeperLeg: RailSegment;
let chairLeg: RailSegment;

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

  const run = (dest: number): Journey[] => {
    const r = engine.search(tt, {
      departureMin: 540, origins: [0], destinations: [dest], maxTransfers: 2,
      preferredClass: null, maxJourneyMin: 4320, maxWaitMin: 1440,
    });
    return reconstructAll(r, tt, graph, { departureMin: 540 });
  };

  const toDelta = run(3);
  expect(toDelta.length, 'fixture: Alpha -> Delta must resolve').toBeGreaterThan(0);
  sleeperLeg = toDelta[0].segments.find((s): s is RailSegment => s.kind === 'rail') as RailSegment;
  expect(sleeperLeg, 'fixture: the Delta itinerary must have a rail leg').toBeTruthy();

  // The chair-car leg boards at the second Alpha terminal, so search from there.
  const toEcho = engine.search(tt, {
    departureMin: 540, origins: [1], destinations: [4], maxTransfers: 2,
    preferredClass: null, maxJourneyMin: 4320, maxWaitMin: 1440,
  });
  const echoJourneys = reconstructAll(toEcho, tt, graph, { departureMin: 540 });
  chairLeg = echoJourneys.flatMap((j) => j.segments)
    .find((s): s is RailSegment => s.kind === 'rail') as RailSegment;
  expect(chairLeg, 'fixture: the Echo itinerary must have a rail leg').toBeTruthy();
}

build();

/** Open the panel the way a browser would, and wait for the worker round trip to land. */
async function open(container: Element): Promise<void> {
  const details = container.querySelector('details') as HTMLDetailsElement;
  expect(details, 'the panel must be a details element').toBeTruthy();
  details.open = true;
  details.dispatchEvent(new Event('toggle'));
  await waitFor(() => {
    expect(details.textContent ?? '').not.toMatch(/Reading this train's stop list/);
  });
}

function panel(seg: RailSegment, opts: { roadHop?: boolean; alternatives?: number; deps?: boolean } = {}) {
  const board = stations.at(seg.from).code;
  const alight = stations.at(seg.to).code;
  return render(
    h(PlannerDepsContext.Provider, {
      value: opts.deps === false
        ? { stations: null, groups: [] }
        : { stations, groups: GROUPS },
    }, h(RemediesPanel, {
      segment: seg,
      boardCode: board,
      alightCode: alight,
      dateIso: DATE,
      alternativeItineraries: opts.alternatives ?? 2,
      roadHopPresent: opts.roadHop ?? false,
    })),
  );
}

beforeEach(() => {
  mock.calls = 0;
  mock.fail = false;
  mock.lastTrain = -1;
  mock.stops = graph.rawStopsOfTrain(sleeperLeg.trainIx);
});

// --------------------------------------------------------------------------- fidelity

describe('stopsFromRaw — parity with the graph', () => {
  it('rebuilds exactly what Graph.stopsOfTrain produces, field for field', () => {
    // Remedy 1 decides feasibility from this list while the router built the leg from the other
    // one. A plausible off-by-one in dayOff or haltMin would yield splits that look fine and are
    // not, so the two constructions are compared outright rather than sampled.
    for (let t = 0; t < graph.trainCount; t++) {
      const raw = graph.rawStopsOfTrain(t);
      expect(stopsFromRaw(raw, stations), `train ${t}`).toEqual(graph.stopsOfTrain(t, stations));
    }
  });

  it('gives the origin and the terminal a zero halt, not a negative one', () => {
    const stops = stopsFromRaw(graph.rawStopsOfTrain(sleeperLeg.trainIx), stations);
    expect(stops[0].arrMin).toBeNull();
    expect(stops[0].haltMin).toBe(0);
    expect(stops[stops.length - 1].depMin).toBeNull();
    expect(stops[stops.length - 1].haltMin).toBe(0);
    // And an intermediate stop carries the real gap between arriving and leaving.
    const mid = stops[1];
    expect(mid.haltMin).toBe((mid.depMin as number) - (mid.arrMin as number));
    expect(mid.haltMin).toBeGreaterThan(0);
  });

  it('attaches codes and names, which the worker deliberately does not carry', () => {
    const stops = stopsFromRaw(graph.rawStopsOfTrain(sleeperLeg.trainIx), stations);
    expect(stops[0].code).toBe('ALP');
    expect(stops[0].name).toBe('Alpha Jn');
    expect(stops.every((s) => s.code.length > 0 && s.name.length > 0)).toBe(true);
  });
});

describe('cityAlternatives', () => {
  it('returns the other terminals in the same city, nearest first, excluding the station itself', () => {
    const alts = cityAlternatives(0, stations, GROUPS);
    expect(alts.map((a) => a.code)).toEqual(['ALR']);
    expect(alts[0].name).toBe('Alpha Road');
    expect(alts[0].minutesByRoad).toBeGreaterThan(0);
    expect(alts[0].estimated).toBe(false);
  });

  it('uses exactly the road-time convention the router priced the transfer with', () => {
    // If these disagreed, two numbers for the same pair of terminals would be on screen at once.
    const a = stations.at(0);
    const b = stations.at(1);
    const expected = roadMinutes(haversineKm(a.lat as number, a.lon as number, b.lat as number, b.lon as number));
    expect(cityAlternatives(0, stations, GROUPS)[0].minutesByRoad).toBe(expected);
  });

  it('returns nothing for a station that is not in any authored city group', () => {
    // Most stations in India are not in a group. The honest answer is "no alternative terminal",
    // not a nearby station invented from straight-line distance.
    expect(cityAlternatives(2, stations, GROUPS)).toEqual([]);
    expect(cityAlternatives(4, stations, GROUPS)).toEqual([]);
  });

  it('falls back to the authored city estimate, flagged, when coordinates are missing', () => {
    // Coordinates arrive via attachGeo, not from the stations container, so an index that never
    // had geo attached is exactly the missing-coordinates case — no need to blank the specs.
    const bare = StationIndex.fromContainer(
      Container.parse(buildStationsContainer(SPECS), ContainerKind.Stations),
    );
    expect(bare.at(0).lat, 'fixture: this index must have no coordinates').toBeNull();
    const alts = cityAlternatives(0, bare, GROUPS);
    expect(alts.length).toBe(1);
    expect(alts[0].minutesByRoad).toBe(GROUPS[0].fallbackMinutes);
    expect(alts[0].estimated).toBe(true);
  });
});

describe('buildRemedyContext', () => {
  it('uses the Indian date, not the browser timezone one', () => {
    const ctx = buildRemedyContext({
      segment: sleeperLeg, stops: [], stations, groups: GROUPS,
      alternativeItineraries: 3, roadHopPresent: false,
    });
    // Whatever timezone this suite runs in, the booking windows it feeds are Indian ones.
    expect(ctx.todayIso).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(ctx.alternativeItineraries).toBe(3);
    expect(ctx.roadHopPresent).toBe(false);
    expect(ctx.runsDays).toBe(sleeperLeg.runsDays);
    expect(ctx.offeredClasses).toEqual(sleeperLeg.trainClasses);
    expect(ctx.boardAlternatives.map((a) => a.code)).toEqual(['ALR']);
  });
});

// --------------------------------------------------------------------------- the panel

describe('RemediesPanel', () => {
  it('is collapsed, and asks the worker for nothing until it is opened', () => {
    const { container } = panel(sleeperLeg);
    const details = container.querySelector('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(mock.calls).toBe(0);
    expect(details.querySelector('summary')?.textContent ?? '').toMatch(/waitlisted/i);
  });

  it('opens into all seven remedies, with the honest summary of what can be worked out now', async () => {
    const { container } = panel(sleeperLeg);
    await open(container);
    expect(mock.calls).toBe(1);
    expect(mock.lastTrain).toBe(sleeperLeg.trainIx);

    const text = container.textContent ?? '';
    for (const n of ['①', '②', '③', '④', '⑤', '⑥', '⑦']) {
      expect(text, `remedy ${n} must be listed`).toContain(n);
    }
    expect(text).toMatch(/3 of the 7 remedies can be worked out from the timetable right now/);
    // It must not imply that any of this has been checked against IRCTC.
    expect(text).toMatch(/no availability source is connected/i);
  });

  it('renders the split with its disclosures, and no way to dismiss them', async () => {
    const { container } = panel(sleeperLeg);
    await open(container);
    const text = container.textContent ?? '';
    expect(text).toMatch(/TWO separate tickets/);
    expect(text).toMatch(/grey area/);
    expect(text).toMatch(/partial journey/);
    expect(text).toMatch(/change berths or coaches/);
    // A warning with a close button is a warning that will be closed.
    const splitBlock = container.querySelector('.remedy__splits');
    expect(splitBlock, 'the split block must be rendered').toBeTruthy();
    expect(splitBlock?.querySelector('button')).toBeNull();
    expect(container.querySelectorAll('.remedy__disclosures li').length).toBeGreaterThanOrEqual(5);
  });

  it('surfaces splits that were considered and ruled out, with the reason', async () => {
    // A four-minute halt at Beta: too short to change coaches, so remedy 1 must reject it and say
    // so rather than silently offering nothing.
    mock.stops = [
      { seq: 1, station: 0, arrMin: null, depMin: 0, distKm: 0 },
      { seq: 2, station: 2, arrMin: 120, depMin: 124, distKm: 150 },
      { seq: 3, station: 3, arrMin: 300, depMin: null, distKm: 400 },
    ];
    const { container } = panel(sleeperLeg);
    await open(container);
    const text = container.textContent ?? '';
    expect(text).toMatch(/considered and ruled out/i);
    expect(text).toMatch(/Beta/);
    expect(text).toMatch(/halt/i);
  });

  it('shows the exact IRCTC question each option would pose', async () => {
    const { container } = panel(sleeperLeg);
    await open(container);
    const asks = Array.from(container.querySelectorAll('.remedy__ask'));
    expect(asks.length).toBeGreaterThan(0);
    const first = asks[0].textContent ?? '';
    expect(first).toMatch(/Would ask IRCTC/);
    expect(first).toMatch(sleeperLeg.trainNumber);
    // IRCTC's own date format, not an ISO string the form would reject.
    const [y, m, d] = DATE.split('-');
    expect(first).toContain(`${d}/${m}/${y}`);
  });

  it('marks ruled-out options and poses no query for them', async () => {
    mock.stops = graph.rawStopsOfTrain(chairLeg.trainIx);
    // The leg must genuinely be booked in a chair car for this to mean anything: remedy 3 is
    // evaluated against the leg's own class, so a sleeper-priced leg on an AC train would rule
    // nothing out and the test would pass vacuously.
    expect(chairLeg.klass, 'fixture: the Shatabdi leg must be priced in CC').toBe('CC');
    expect(chairLeg.trainClasses).toEqual(['CC']);
    const { container } = panel(chairLeg);
    await open(container);

    const out = Array.from(container.querySelectorAll('.remedy__opt--out'));
    expect(out.length, 'a chair car must rule out the berth-position quotas').toBeGreaterThan(0);
    const text = out.map((li) => li.textContent ?? '').join(' ');
    // Divyangjan and the senior/lower-berth quotas reserve berth positions; a chair car has none.
    expect(text).toMatch(/seats, not berths/);
    expect(text).toMatch(/HP|Divyang/i);
    // A ruled-out option must not also carry a question to ask.
    for (const li of out) expect(li.querySelector('.remedy__ask')).toBeNull();
  });

  it('says when the itinerary already includes a road hop', async () => {
    const { container } = panel(sleeperLeg, { roadHop: true });
    await open(container);
    expect(container.textContent ?? '').toMatch(/already includes a road transfer/i);
  });

  it('reports a worker failure instead of rendering an empty remedy list', async () => {
    mock.fail = true;
    const { container } = panel(sleeperLeg);
    await open(container);
    const text = container.textContent ?? '';
    expect(text).toMatch(/Could not work out the options for this leg/);
    expect(text).toMatch(/the worker stopped responding/);
    // An empty list would read as "there is nothing you can do", which is the worst wrong answer.
    expect(text).not.toMatch(/3 of the 7 remedies/);
  });

  it('says when the station list is not ready, rather than failing silently', async () => {
    const { container } = panel(sleeperLeg, { deps: false });
    await open(container);
    expect(container.textContent ?? '').toMatch(/station list has not finished loading/i);
    expect(mock.calls).toBe(0);
  });

  it('asks once, and does not re-fetch when the panel is closed and reopened', async () => {
    const { container } = panel(sleeperLeg);
    const details = container.querySelector('details') as HTMLDetailsElement;
    await open(container);
    expect(mock.calls).toBe(1);
    details.open = false;
    details.dispatchEvent(new Event('toggle'));
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
    await waitFor(() => expect(screen.queryAllByText(/Reading this train's stop list/).length).toBe(0));
    expect(mock.calls).toBe(1);
  });
});

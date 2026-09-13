/**
 * destination-ui.test.tsx — the two things a destination card must do, and the three it must not.
 *
 * Must do: give a reason to go where one has been written, and give a *useful* answer where one
 * has not (how big a junction this is, and what profiled places are near it). The second is the
 * case that will be most common on a real search, so it is not a fallback in the throwaway sense.
 *
 * Must not: present editorial content as if it came from the timetable; quote a distance without
 * saying which kind of distance it is; or claim "no notes have been written" while the notes are
 * still in flight or after they failed to load. Those are three different sentences and the tests
 * below check each of them, because a card that says the wrong one is worse than a blank card.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/preact';
import { Container, ContainerKind } from '../src/lib/binary';
import { StationIndex } from '../src/lib/stations';
import { DestinationCard } from '../src/ui/DestinationCard';
import { parseProfiles } from '../src/state/useProfiles';
import { buildGraphContainer, buildStationsContainer } from './helpers';

// Khajuraho has a profile; Itarsi is a pure junction with none; Jhansi is a nearby profiled
// station, so Itarsi's fallback has something to point at.
const SPECS = [
  { code: 'KURJ', name: 'Khajuraho', rank: 0, calls: 6, lat: 24.797, lon: 79.89 },
  { code: 'ET', name: 'Itarsi Jn', rank: 3, calls: 238, lat: 22.6083, lon: 77.7671 },
  { code: 'JHS', name: 'Jhansi Jn', rank: 3, calls: 220, lat: 25.4436, lon: 78.553 },
];

const NOTES = parseProfiles(
  JSON.parse(readFileSync(resolve(__dirname, '../public/data/profiles.json'), 'utf8')),
);

function index(): StationIndex {
  const st = StationIndex.fromContainer(
    Container.parse(buildStationsContainer(SPECS), ContainerKind.Stations),
  );
  st.attachGeo(Container.parse(
    buildGraphContainer([], SPECS.length, SPECS.map((s) => [s.lat, s.lon] as [number, number])),
    ContainerKind.Graph,
  ));
  return st;
}

function renderCard(code: string, notes: Parameters<typeof DestinationCard>[0]['profiles'] = NOTES) {
  const stations = index();
  const ix = stations.indexOfCode(code);
  expect(ix, `fixture: ${code} must exist`).toBeGreaterThanOrEqual(0);
  return render(
    <DestinationCard
      station={ix}
      stations={stations}
      nameOf={(i) => { const s = stations.at(i); return { code: s.code, name: s.name }; }}
      profiles={notes}
    />,
  );
}

describe('DestinationCard, with a profile', () => {
  it('gives the reason, the tags and the sights with distances', () => {
    const { container } = renderCard('KURJ');
    const text = container.textContent ?? '';
    expect(text).toMatch(/Chandela temples/i);
    expect(text).toMatch(/UNESCO/i);
    expect(container.querySelectorAll('.dc__sights li').length).toBeGreaterThanOrEqual(2);
    expect(container.querySelector('.dc__km')?.textContent).toMatch(/km/);
  });

  it('separates the road hops, so the last mile is not discovered on arrival', () => {
    const { container } = renderCard('KURJ');
    const hops = container.querySelector('.dc__hops');
    expect(hops).toBeTruthy();
    // Panna is 25 km away and the card must say how and how much, in words that are approximations.
    expect(hops!.textContent).toMatch(/Panna/);
    expect(hops!.textContent).toMatch(/by road/);
    expect(hops!.textContent).toMatch(/₹/);
  });

  it('labels itself as editorial, not as harvested data', () => {
    const { container } = renderCard('KURJ');
    expect(container.querySelector('.dc__source')?.textContent).toMatch(/editorial/i);
  });

  it('never states a ticket price or an opening time, the two fastest-rotting facts', () => {
    const { container } = renderCard('KURJ');
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/opening hours|entry fee|closed on/i);
  });
});

describe('DestinationCard, without a profile', () => {
  it('tells the traveller this is a junction rather than a destination', () => {
    const { container } = renderCard('ET');
    const text = container.textContent ?? '';
    expect(text).toMatch(/major junction/i);
    expect(text).toMatch(/238 trains call here/i);
  });

  it('points at the nearest places it does have notes for, as straight-line distances', () => {
    const { container } = renderCard('ET');
    const near = container.querySelector('.dc__near');
    expect(near).toBeTruthy();
    // Jhansi is the only profiled station within reach in this fixture.
    expect(near!.textContent).toMatch(/Jhansi/);
    expect(near!.textContent).toMatch(/straight line/);
  });

  it('says the notes are editorial here too, and does not pretend to have none', () => {
    const { container } = renderCard('ET');
    expect(container.querySelector('.dc__source')?.textContent).toMatch(/editorial/i);
  });

  it('degrades to a plain sentence with no station index at all', () => {
    render(<DestinationCard station={0} stations={null} nameOf={() => ({ code: 'X', name: 'X' })} profiles={NOTES} />);
    expect(screen.getByText(/No destination notes have been written/i)).toBeTruthy();
  });
});

describe('DestinationCard, while the notes are not there yet', () => {
  it('says it is looking, and does not claim there are no notes', () => {
    const { container } = render(
      <DestinationCard
        station={0}
        stations={index()}
        nameOf={() => ({ code: 'ET', name: 'Itarsi Jn' })}
        profiles={null}
        loadingNotes
      />,
    );
    expect(container.textContent).toMatch(/Looking up what is in Itarsi Jn/i);
    expect(container.textContent).not.toMatch(/no destination notes/i);
    expect(container.textContent).not.toMatch(/trains call here/i);
  });

  it('falls back to the timetable’s own answer when the notes never arrive', () => {
    const { container } = render(
      <DestinationCard
        station={1}
        stations={index()}
        nameOf={(i) => { const s = index().at(i); return { code: s.code, name: s.name }; }}
        profiles={null}
        loadingNotes={false}
      />,
    );
    expect(container.textContent).toMatch(/could not be loaded/i);
    expect(container.textContent).not.toMatch(/no destination notes have been written/i);
  });
});

/**
 * DestinationCard.tsx — why go, and what the last mile looks like.
 *
 * The explore screen used to answer "where can I get to" with a station name and a train number,
 * which is half an answer: a traveller who has never been to Kumbakonam cannot tell from the name
 * whether it is a temple town or a goods yard. This component fills that in from two sources that
 * are kept visibly apart:
 *
 *   - an AUTHORED profile (`data/profiles.json`) — what is there, what is worth the walk;
 *   - COMPUTED facts from the packed dataset — how many trains call here, what profiled places
 *     are within reach of a station that has no profile of its own.
 *
 * The first is somebody's judgement and is labelled as editorial. The second is arithmetic on
 * coordinates and is labelled as straight-line distance. Nothing here claims to know how good a
 * place is, how much a ticket costs, or when anything is open — the three things that go stale
 * fastest and mislead hardest.
 *
 * Three states, three different sentences, because they are genuinely different answers: the
 * notes are still loading (say so), the notes could not be loaded (the timetable's own answer),
 * or the notes are here and this station simply is not in them.
 */
import type { StationIndex } from '../lib/stations';
import type { StationResolver } from '../router/journey';
import { profileFor, type ProfileIndex } from '../discovery/profiles';
import { nearbyProfiled } from '../discovery/nearby';
import { roadHopLabel, roadHopRupees } from '../discovery/roadhop';
import { rupees } from '../state/plan';

export interface DestinationCardProps {
  /** Graph index of the destination station being described. */
  station: number;
  /** The station index, for the fallback that tells a junction from a destination. */
  stations: StationIndex | null;
  nameOf: StationResolver;
  /** The authored notes, or null while they are on their way (or if they never arrive). */
  profiles?: ProfileIndex | null;
  /** True only while the notes are in flight — the difference between "loading" and "none". */
  loadingNotes?: boolean;
}

export function DestinationCard({
  station, stations, nameOf, profiles = null, loadingNotes = false,
}: DestinationCardProps) {
  const here = nameOf(station);

  if (profiles === null && loadingNotes) {
    return (
      <div class="dc dc--thin dc--pending">
        <p class="dc__why">Looking up what is in {here.name}…</p>
      </div>
    );
  }

  const resolved = profileFor(profiles, here.code);

  if (!resolved) {
    // No profile: say what the timetable knows, and point at the nearest places that do have one.
    // "A junction with 218 trains a day" is a real answer to "why would I go here" — it says
    // change here, do not holiday here.
    const calls = stations?.at(station)?.calls ?? null;
    const near = nearbyProfiled(stations, station, profiles);
    const unknown = profiles === null;
    const summary = calls === null
      ? `Nothing is recorded about ${here.name} yet.`
      : calls >= 100
        ? `A major junction — ${calls} trains call here — rather than a destination in itself.`
        : `${calls} trains call here.`;
    return (
      <div class="dc dc--thin">
        <p class="dc__why">
          {unknown
            ? summary
            : calls === null
              ? 'No destination notes have been written for this station yet.'
              : `${summary} No destination notes have been written for this station yet.`}
        </p>
        {near.length > 0 && (
          <p class="dc__near">
            <strong>Within reach:</strong>{' '}
            {near.map((n, i) => (
              <span key={n.code}>
                {i > 0 && ' · '}
                {n.name} <span class="dc__km">≈ {Math.round(n.km)} km straight line</span>
              </span>
            ))}
          </p>
        )}
        <p class="dc__source">
          {unknown
            ? 'Destination notes could not be loaded, so this is the timetable\u2019s own answer. Counts and distances come from the packed dataset.'
            : near.length > 0
              ? 'Editorial notes exist for some stations; for this one the nearest covered places are listed above. Distances here are straight-line, so the road is longer.'
              : 'Editorial notes exist for some stations; none has been written for this one yet.'}
        </p>
      </div>
    );
  }

  const { profile: p, primary, viaOtherTerminal } = resolved;
  const primaryIx = stations ? stations.indexOfCode(primary) : -1;
  const primaryName = primaryIx >= 0 ? nameOf(primaryIx).name : primary;

  return (
    <div class="dc">
      <p class="dc__why">{p.why}</p>

      <p class="dc__tags">
        {p.tags.map((t) => <span class="dc__tag" key={t}>{t}</span>)}
        {p.best && <span class="dc__season">best {p.best}</span>}
        {p.days && <span class="dc__season">allow {p.days}</span>}
      </p>

      <ul class="dc__sights">
        {p.sights.map((s) => (
          <li key={s.name}>
            <span class="dc__sight">{s.name}</span>
            <span class="dc__kind">{s.kind}</span>
            <span class="dc__km">≈ {s.km} km from {viaOtherTerminal ? primaryName : 'the station'}</span>
          </li>
        ))}
      </ul>

      {p.gateways && p.gateways.length > 0 && (
        <div class="dc__hops">
          <h4 class="dc__hops-head">Worth the road hop</h4>
          <ul>
            {p.gateways.map((g) => (
              <li key={g.name}>
                <span class="dc__sight">{g.name}</span>
                <span class="dc__km">≈ {g.km} km</span>
                <span class="dc__hop">{roadHopLabel(g.km)} · {rupees(roadHopRupees(g.km))} by taxi</span>
                <span class="dc__hopnote">{g.note}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p class="dc__source">
        Editorial notes, written for this project — not harvested data. Distances are planning
        figures to the nearest kilometre or five, and the road times are a coarse model of an
        out-of-town drive, not a measured route.
        {viaOtherTerminal && ` Distances are measured from ${primaryName}.`}
      </p>
    </div>
  );
}

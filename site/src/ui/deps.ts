/**
 * deps.ts — the two app-level facts a leg panel needs but should not be handed down by prop.
 *
 * `stations` and `groups` are resolved once, at startup, and never change for the life of the
 * page. Threading them through ItineraryCard into LegDetail into RemediesPanel would add three
 * props to two components that have no other use for them, and every intermediate component would
 * have to be edited again the next time a leaf needs one. A context is the smaller change and the
 * more honest one: these are ambient facts about the session, not properties of an itinerary.
 *
 * What is deliberately NOT here: anything that varies per itinerary, such as how many alternative
 * itineraries were found for a destination. That is a prop, because it is genuinely a property of
 * the card being rendered.
 */
import { createContext } from 'preact';
import type { StationIndex } from '../lib/stations';
import type { ResolvedGroup } from '../router/terminals';

export interface PlannerDeps {
  /** Null until stations.bin has loaded. Panels must degrade rather than throw. */
  stations: StationIndex | null;
  /** The authored city terminal groups, resolved to station indices. */
  groups: readonly ResolvedGroup[];
}

export const PlannerDepsContext = createContext<PlannerDeps>({ stations: null, groups: [] });

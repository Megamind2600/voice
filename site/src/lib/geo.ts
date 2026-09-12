/**
 * geo.ts — the only geodesy this app needs.
 *
 * Kept separate from the router because two unrelated consumers want it: transfer pricing
 * (how long is the road hop between two terminals?) and the map (how far apart are these
 * two dots?). Both must agree, or the map would contradict the itinerary.
 */

const EARTH_RADIUS_KM = 6371.0088; // mean radius; WGS84 equatorial would be 0.2% off

/** Great-circle distance in km. */
export function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const toRad = Math.PI / 180;
  const dLat = (bLat - aLat) * toRad;
  const dLon = (bLon - aLon) * toRad;
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

export interface Coord {
  lat: number;
  lon: number;
}

export function haversine(a: Coord | null, b: Coord | null): number | null {
  if (!a || !b) return null;
  return haversineKm(a.lat, a.lon, b.lat, b.lon);
}

/**
 * Urban road circuity: how much longer a road trip is than the straight line between its
 * endpoints.
 *
 * This is deliberately NOT the rail detour factor (1.037, calibrated in Phase 0 against
 * 5,045 trains' own stated distances). They measure different things and conflating them
 * is an easy mistake: rail lines between two stations follow the track, which between
 * consecutive stops is close to straight, whereas a road trip across a city has to navigate
 * a street network. Urban circuity of 1.3-1.4 is the standard planning figure.
 */
export const URBAN_ROAD_CIRCUITY = 1.35;

/**
 * weather.ts — a 10-day outlook at the destination, from Open-Meteo.
 *
 * This is the first live, per-request network feature the app makes, and it earns the
 * exception to "after first load, nothing leaves the browser" in exactly one way: it is
 * opt-in (a button, never automatic), it fetches a single keyless, CORS-enabled forecast
 * endpoint, and it says where the numbers came from. Open-Meteo is the one weather source
 * the plan verified needs no key and no account, and it is CC BY 4.0 — so attribution is
 * not optional politeness, it is the licence, and the card shows it.
 *
 * ---------------------------------------------------------------------------
 * WHY PARSING IS DEFENSIVE
 * ---------------------------------------------------------------------------
 * A weather card that shows "NaN°C" is worse than none. The response is validated field by
 * field — the three daily arrays must exist, agree in length, and hold only finite numbers —
 * and anything that fails the check is an error state, not a number. `weathercode` is a WMO
 * integer; a value the map does not know renders as a neutral glyph rather than crashing.
 */

export interface DayForecast {
  /** YYYY-MM-DD, as Open-Meteo returned it. */
  dateIso: string;
  /** WMO weather interpretation code. */
  code: number;
  /** °C, or null when the source omitted it. */
  tMax: number | null;
  tMin: number | null;
  /** Precipitation probability, 0..100, or null when omitted. */
  rainProb: number | null;
}

export interface Forecast {
  days: DayForecast[];
  /** The timezone the times are in — the card states it so a date is never ambiguous. */
  timezone: string;
}

export interface ForecastRequest {
  lat: number;
  lon: number;
  startIso: string;
  endIso: string;
  signal?: AbortSignal;
  /** Injectable for tests; defaults to the global fetch. */
  fetchFn?: typeof fetch;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Fetch and validate a daily forecast.
 *
 * Throws on a network failure, a non-2xx response, or a payload that does not parse into the
 * expected shape. The caller decides what an error looks like on screen.
 */
export async function fetchForecast(req: ForecastRequest): Promise<Forecast> {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', String(req.lat));
  url.searchParams.set('longitude', String(req.lon));
  url.searchParams.set(
    'daily', 'weathercode,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
  );
  url.searchParams.set('timezone', 'Asia/Kolkata');
  url.searchParams.set('start_date', req.startIso);
  url.searchParams.set('end_date', req.endIso);

  const fetchFn = req.fetchFn ?? fetch;
  const init: RequestInit | undefined = req.signal !== undefined ? { signal: req.signal } : undefined;
  const res = await fetchFn(url.toString(), init);
  if (!res.ok) throw new Error(`weather request failed (${res.status})`);
  const json = (await res.json()) as {
    timezone?: unknown;
    daily?: {
      time?: unknown; weathercode?: unknown;
      temperature_2m_max?: unknown; temperature_2m_min?: unknown;
      precipitation_probability_max?: unknown;
    };
  };

  const d = json.daily;
  if (!d || !Array.isArray(d.time)) throw new Error('weather payload had no daily forecast');
  const n = d.time.length;
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const codes = arr(d.weathercode);
  const tMax = arr(d.temperature_2m_max);
  const tMin = arr(d.temperature_2m_min);
  const rain = arr(d.precipitation_probability_max);
  if (codes.length !== n || tMax.length !== n || tMin.length !== n || rain.length !== n) {
    throw new Error('weather payload arrays disagree in length');
  }

  const days: DayForecast[] = [];
  for (let i = 0; i < n; i++) {
    const code = typeof codes[i] === 'number' && Number.isInteger(codes[i]) ? codes[i] as number : -1;
    days.push({
      dateIso: typeof d.time[i] === 'string' ? d.time[i] as string : '',
      code,
      tMax: num(tMax[i]),
      tMin: num(tMin[i]),
      rainProb: num(rain[i]),
    });
  }
  return { days, timezone: typeof json.timezone === 'string' ? json.timezone : 'Asia/Kolkata' };
}

/** WMO code → glyph and a one-word label. Unknown codes fall back to a neutral dash. */
export function weatherGlyph(code: number): { glyph: string; label: string } {
  if (!Number.isInteger(code) || code < 0 || code > 99) return { glyph: '—', label: 'unknown' };
  if (code === 0) return { glyph: '☀️', label: 'clear' };
  if (code <= 2) return { glyph: '🌤️', label: 'partly cloudy' };
  if (code === 3) return { glyph: '☁️', label: 'overcast' };
  if (code <= 48) return { glyph: '🌫️', label: 'fog' };
  if (code <= 57) return { glyph: '🌦️', label: 'drizzle' };
  if (code <= 67) return { glyph: '🌧️', label: 'rain' };
  if (code <= 77) return { glyph: '🌨️', label: 'snow' };
  if (code <= 82) return { glyph: '🌧️', label: 'showers' };
  if (code <= 86) return { glyph: '🌨️', label: 'snow showers' };
  if (code <= 99) return { glyph: '⛈️', label: 'thunderstorm' };
  return { glyph: '—', label: 'unknown' };
}

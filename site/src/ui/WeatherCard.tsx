/**
 * WeatherCard.tsx — an opt-in outlook at the destination.
 *
 * The card does not fetch on its own. A page can render dozens of destination cards, and firing
 * a network request for each of them would (a) burn the traveller's data, (b) violate the app's
 * "nothing leaves the browser" promise without being asked, and (c) hit Open-Meteo's free tier
 * for cards nobody opened. So it starts as a single button, and the request happens once, on
 * demand, then the result stays.
 *
 * Every number on the card is a forecast — it must read as one. The source line (required by
 * Open-Meteo's CC BY 4.0 licence) and the date range make the provenance visible on the card
 * itself rather than in a footnote below it.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { fetchForecast, weatherGlyph, type Forecast } from '../state/weather';

export interface WeatherCardProps {
  lat: number;
  lon: number;
  startIso: string;
  endIso: string;
  placeName: string;
}

type Phase = 'idle' | 'loading' | 'ready' | 'error';

export function WeatherCard(props: WeatherCardProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [forecast, setForecast] = useState<Forecast | null>(null);
  const [error, setError] = useState<string | null>(null);
  const acRef = useRef<AbortController | null>(null);

  // A click is the only trigger, so no fetch-on-mount effect; this effect only cleans up a
  // request if the card unmounts mid-flight.
  useEffect(() => () => { acRef.current?.abort(); }, []);

  const load = (): void => {
    acRef.current?.abort();
    const ac = new AbortController();
    acRef.current = ac;
    setPhase('loading');
    setError(null);
    fetchForecast({ lat: props.lat, lon: props.lon, startIso: props.startIso, endIso: props.endIso, signal: ac.signal })
      .then((f) => { setForecast(f); setPhase('ready'); })
      .catch((err: unknown) => {
        if (ac.signal.aborted) return;
        setPhase('error');
        setError(err instanceof Error ? err.message : String(err));
      });
  };

  const rangeLabel = (): string => {
    const short = (iso: string): string => iso.slice(8, 10);
    return `${short(props.startIso)}–${short(props.endIso)} ${props.endIso.slice(0, 7).replace('-', '/')}`;
  };

  return (
    <div class="weather">
      {phase === 'idle' && (
        <button type="button" class="linkish" onClick={load}>
          Check weather in {props.placeName} for your dates
        </button>
      )}

      {phase === 'loading' && <p class="weather__note" role="status">Fetching the outlook…</p>}

      {phase === 'error' && (
        <p class="weather__note weather__note--err" role="alert">
          Could not load the outlook{error ? `: ${error}` : ''}. Weather is fetched live from
          Open-Meteo and needs a connection.
        </p>
      )}

      {phase === 'ready' && forecast && (
        <div class="weather__body">
          <ul class="weather__days">
            {forecast.days.map((d) => {
              const g = weatherGlyph(d.code);
              return (
                <li class="weather__day" key={d.dateIso} title={g.label}>
                  <span class="weather__date">
                    {d.dateIso === props.startIso ? 'depart' : d.dateIso === props.endIso ? 'return' : d.dateIso.slice(5)}
                  </span>
                  <span class="weather__glyph" aria-hidden="true">{g.glyph}</span>
                  <span class="weather__temps">
                    {d.tMax !== null && <strong>{Math.round(d.tMax)}°</strong>}
                    {d.tMin !== null && <span class="weather__lo">{Math.round(d.tMin)}°</span>}
                  </span>
                  {d.rainProb !== null && d.rainProb > 0 && (
                    <span class="weather__rain">💧 {d.rainProb}%</span>
                  )}
                </li>
              );
            })}
          </ul>
          <p class="weather__note">
            Forecast for {props.placeName}, {rangeLabel()} ({forecast.timezone}). From{' '}
            <a href="https://open-meteo.com/" rel="noopener noreferrer" target="_blank">Open-Meteo</a>{' '}
            (CC BY 4.0). A forecast is a hint about which dates to prefer — it is not a guarantee.
          </p>
        </div>
      )}
    </div>
  );
}

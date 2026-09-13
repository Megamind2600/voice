/**
 * weather.test.ts — the forecast parser, tested against the shapes Open-Meteo actually sends
 * and against the shapes that would break the card.
 *
 * The parser exists so a malformed payload becomes an error state instead of a "NaN°C" on
 * screen, so the failure cases are the interesting ones.
 */
import { describe, expect, it } from 'vitest';
import { fetchForecast, weatherGlyph } from '../src/state/weather';

const req = {
  lat: 28.6, lon: 77.2, startIso: '2026-09-14', endIso: '2026-09-16',
};

function okPayload(daily: unknown, timezone = 'Asia/Kolkata') {
  return {
    ok: true, status: 200,
    json: async () => ({ timezone, daily }),
  } as Response;
}

describe('fetchForecast', () => {
  it('parses a well-formed payload and asks for the right window', async () => {
    let seen = '';
    const fetchFn = (async (url: string) => {
      seen = url;
      return okPayload({
        time: ['2026-09-14', '2026-09-15', '2026-09-16'],
        weathercode: [0, 3, 61],
        temperature_2m_max: [35, 33, 31],
        temperature_2m_min: [24, 22, 21],
        precipitation_probability_max: [0, 10, 70],
      });
    }) as unknown as typeof fetch;

    const f = await fetchForecast({ ...req, fetchFn });
    expect(seen).toContain('https://api.open-meteo.com/v1/forecast');
    expect(seen).toContain('latitude=28.6');
    expect(seen).toContain('start_date=2026-09-14');
    expect(seen).toContain('end_date=2026-09-16');
    expect(f.days).toHaveLength(3);
    expect(f.days[0]).toMatchObject({ code: 0, tMax: 35, tMin: 24, rainProb: 0 });
    expect(f.timezone).toBe('Asia/Kolkata');
  });

  it('throws on a non-2xx response rather than inventing a forecast', async () => {
    const fetchFn = (async () => ({ ok: false, status: 429, json: async () => ({}) })) as unknown as typeof fetch;
    await expect(fetchForecast({ ...req, fetchFn })).rejects.toThrow(/429/);
  });

  it('throws when the daily arrays disagree in length', async () => {
    const fetchFn = (async () => okPayload({
      time: ['2026-09-14', '2026-09-15'],
      weathercode: [0],
      temperature_2m_max: [35, 33],
      temperature_2m_min: [24],
      precipitation_probability_max: [0, 10],
    })) as unknown as typeof fetch;
    await expect(fetchForecast({ ...req, fetchFn })).rejects.toThrow(/disagree/);
  });

  it('throws when there is no daily block', async () => {
    const fetchFn = (async () => okPayload(undefined)) as unknown as typeof fetch;
    await expect(fetchForecast({ ...req, fetchFn })).rejects.toThrow(/no daily/);
  });

  it('turns non-finite numbers into nulls instead of NaN', async () => {
    const fetchFn = (async () => okPayload({
      time: ['2026-09-14'],
      weathercode: [0],
      temperature_2m_max: [null],
      temperature_2m_min: ['cold'],
      precipitation_probability_max: [NaN],
    })) as unknown as typeof fetch;
    const f = await fetchForecast({ ...req, fetchFn });
    expect(f.days[0].tMax).toBeNull();
    expect(f.days[0].tMin).toBeNull();
    expect(f.days[0].rainProb).toBeNull();
  });
});

describe('weatherGlyph', () => {
  it('maps the codes travellers actually see', () => {
    expect(weatherGlyph(0).label).toBe('clear');
    expect(weatherGlyph(3).label).toBe('overcast');
    expect(weatherGlyph(95).label).toBe('thunderstorm');
  });

  it('degrades gracefully for an unknown code', () => {
    const g = weatherGlyph(-1);
    expect(g.glyph).toBe('—');
    expect(g.label).toBe('unknown');
  });
});

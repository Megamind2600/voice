/**
 * weather-card.test.tsx — the opt-in weather card.
 *
 * The promise that matters here is laziness: a page of destination cards must not fetch forty
 * forecasts because one was rendered. The card fetches only when asked, once, and renders the
 * forecast's provenance (Open-Meteo, CC BY 4.0) where the traveller reads it.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { WeatherCard } from '../src/ui/WeatherCard';

const payload = {
  timezone: 'Asia/Kolkata',
  daily: {
    time: ['2026-09-14', '2026-09-15', '2026-09-16'],
    weathercode: [0, 3, 61],
    temperature_2m_max: [35, 33, 31],
    temperature_2m_min: [24, 22, 21],
    precipitation_probability_max: [0, 10, 70],
  },
};

describe('WeatherCard', () => {
  it('does not fetch until the traveller asks', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => payload }));
    vi.stubGlobal('fetch', fetchMock);
    render(<WeatherCard lat={28.6} lon={77.2} startIso="2026-09-14" endIso="2026-09-16" placeName="New Delhi" />);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /check weather/i })).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it('fetches once on demand and shows the days with their source', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (!url.startsWith('https://api.open-meteo.com')) throw new Error(`unexpected url ${url}`);
      return { ok: true, status: 200, json: async () => payload } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<WeatherCard lat={28.6} lon={77.2} startIso="2026-09-14" endIso="2026-09-16" placeName="New Delhi" />);
    await user.click(screen.getByRole('button', { name: /check weather/i }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('api.open-meteo.com');
    expect(url).toContain('latitude=28.6');

    expect(await screen.findByText('depart')).toBeTruthy();
    expect(screen.getAllByText('35°').length).toBeGreaterThan(0);
    // The licence and source are visible on the card, not in a footnote below it.
    expect(screen.getByText(/Open-Meteo/)).toBeTruthy();
    expect(screen.getByText(/CC BY 4\.0/)).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it('reports a failure as an error, not as silence or as numbers', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<WeatherCard lat={28.6} lon={77.2} startIso="2026-09-14" endIso="2026-09-16" placeName="New Delhi" />);
    await user.click(screen.getByRole('button', { name: /check weather/i }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/could not load/i);
    vi.unstubAllGlobals();
  });
});

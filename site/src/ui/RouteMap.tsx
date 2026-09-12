/**
 * RouteMap.tsx — the itinerary's path, drawn on a canvas.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT LEAFLET
 * ---------------------------------------------------------------------------
 * Leaflet plus a tile layer is ~40 KB gzipped of library, a per-view network dependency, and an
 * attribution obligation, to draw a polyline between six points. The dataset already carries
 * coordinates for 7,219 stations, so a canvas and a bounding box do the job in no library at
 * all. It also keeps the promise the app makes elsewhere: after the first load, nothing leaves
 * the browser. A map that fetches tiles would quietly break that in offline use, which is a real
 * scenario on a train.
 *
 * The trade is honest and worth stating: there is no coastline, no terrain, no streets. This is
 * a route diagram, not a map, and it is labelled as one.
 */
import { useEffect, useRef } from 'preact/hooks';
import type { Journey } from '../router/journey';
import { stationPath } from '../router/journey';

export interface RouteMapProps {
  journey: Journey;
  coordsFor: (station: number) => { lat: number; lon: number } | null;
}

/** Padding around the drawn path, as a fraction of the smaller dimension. */
const PAD = 0.14;

export function RouteMap(props: RouteMapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const path = stationPath(props.journey);
  const points = path
    .map((s) => props.coordsFor(s))
    .filter((c): c is { lat: number; lon: number } => c !== null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || points.length < 2) return;

    const draw = (): void => {
      const el = canvasRef.current;
      if (!el) return;
      const parent = el.parentElement;
      const cssW = parent ? parent.clientWidth : 320;
      const cssH = Math.max(120, Math.min(260, Math.round(cssW * 0.42)));
      // Scale the backing store by the device pixel ratio, or the line renders blurry on the
      // high-density screens most Indian travellers are actually using.
      const dpr = typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1;
      el.width = Math.round(cssW * dpr);
      el.height = Math.round(cssH * dpr);
      el.style.height = `${cssH}px`;

      const ctx = el.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      const style = getComputedStyle(el);
      const ink = style.getPropertyValue('--ink').trim() || '#14201b';
      const line = style.getPropertyValue('--line').trim() || '#d9d5cb';
      const brand = style.getPropertyValue('--brand').trim() || '#0b3d2e';
      const accent = style.getPropertyValue('--accent').trim() || '#a4441c';

      let minLat = Infinity; let maxLat = -Infinity;
      let minLon = Infinity; let maxLon = -Infinity;
      for (const p of points) {
        if (p.lat < minLat) minLat = p.lat;
        if (p.lat > maxLat) maxLat = p.lat;
        if (p.lon < minLon) minLon = p.lon;
        if (p.lon > maxLon) maxLon = p.lon;
      }
      // Longitude degrees shrink away from the equator. Without this correction a north-south
      // route looks squashed and an east-west one looks stretched, which for a country spanning
      // 8° to 37° N is a visible distortion rather than a subtle one.
      const midLat = (minLat + maxLat) / 2;
      const lonScale = Math.cos((midLat * Math.PI) / 180) || 1;
      const spanX = Math.max(1e-6, (maxLon - minLon) * lonScale);
      const spanY = Math.max(1e-6, maxLat - minLat);

      const padX = cssW * PAD;
      const padY = cssH * PAD;
      const availW = Math.max(1, cssW - padX * 2);
      const availH = Math.max(1, cssH - padY * 2);
      const scale = Math.min(availW / spanX, availH / spanY);
      const drawW = spanX * scale;
      const drawH = spanY * scale;
      const offX = (cssW - drawW) / 2;
      const offY = (cssH - drawH) / 2;

      const project = (p: { lat: number; lon: number }): [number, number] => [
        offX + (p.lon - minLon) * lonScale * scale,
        // Canvas y grows downward; latitude grows upward.
        offY + (maxLat - p.lat) * scale,
      ];

      const projected = points.map(project);

      ctx.strokeStyle = line;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.rect(0.5, 0.5, cssW - 1, cssH - 1);
      ctx.stroke();

      ctx.strokeStyle = brand;
      ctx.lineWidth = 2.25;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      projected.forEach(([x, y], i) => { if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
      ctx.stroke();

      // Intermediate stops, then the endpoints on top so they are never overdrawn.
      for (let i = 1; i < projected.length - 1; i++) {
        const [x, y] = projected[i];
        ctx.fillStyle = ink;
        ctx.beginPath();
        ctx.arc(x, y, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
      const ends: Array<[number, number, string]> = [
        [projected[0][0], projected[0][1], accent],
        [projected[projected.length - 1][0], projected[projected.length - 1][1], brand],
      ];
      for (const [x, y, colour] of ends) {
        ctx.fillStyle = colour;
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    };

    draw();
    // Redraw on resize: the canvas backing store is sized to its container, so a window resize
    // or a phone rotating would otherwise leave a stretched bitmap.
    const parent = canvas.parentElement;
    if (typeof ResizeObserver !== 'undefined' && parent) {
      const ro = new ResizeObserver(() => draw());
      ro.observe(parent);
      return () => ro.disconnect();
    }
    addEventListener('resize', draw);
    return () => removeEventListener('resize', draw);
  }, [points]);

  if (points.length < 2) {
    return (
      <p class="map map--empty">
        No coordinates for this route, so it cannot be drawn. The dataset is a 2016 snapshot and
        some stations have none.
      </p>
    );
  }

  const label = `Route diagram: ${path.length} stops from the origin to the destination.`;
  return (
    <figure class="map">
      <canvas ref={canvasRef} role="img" aria-label={label} />
      {/* A canvas is opaque to a screen reader, so the same information is given as text. This
          is not a fallback for a broken canvas; it is the accessible version of a drawing. */}
      <figcaption class="map__caption">
        Route diagram, not a map — no terrain or streets, only the stations this itinerary
        passes through, in order.
      </figcaption>
    </figure>
  );
}

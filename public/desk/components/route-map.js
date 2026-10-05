// Route map for Desk (docs/desk-spec.md §1, components/route-map.js).
//
// Draws a one-way route geometry ([[lat, lng], …], as /api/route returns and trips store) on
// a Leaflet map with OpenStreetMap tiles, a start and an end marker, and fits the view to the
// route. Leaflet is the global `L` loaded by index.html; without it, or without a route yet,
// a neutral placeholder takes the map's place. The map follows the light/dark theme, refits
// when its box is resized and is removed cleanly on unmount.

import { html, useEffect, useRef, useState } from '../lib/preact.js';
import { Icon } from '../lib/ui.js';

const CSS = `
.route-map-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; padding: 16px; color: var(--ink-3); font-size: 13px; text-align: center; }
.route-map-empty .icon { color: var(--line-2); }
.route-map .leaflet-tooltip { padding: 3px 8px; border: 1px solid var(--line); border-radius: var(--r-ctl); background: var(--surface); box-shadow: var(--shadow-1); color: var(--ink); font: 500 12px/1.4 var(--sans); }
.route-map .leaflet-tooltip-top::before { border-top-color: var(--surface); }
`;

// Component styles live with the component and are added to <head> once, on first import.
const STYLE_ID = 'desk-route-map-styles';
if (typeof document !== 'undefined' && !document.getElementById(STYLE_ID)) {
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.append(style);
}

const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const FIT_OPTIONS = { padding: [28, 28], maxZoom: 15 };
const FALLBACK_COLORS = { signal: '#1F4B85', surface: '#FFFFFF' };

function leaflet() {
  const library = globalThis.L;
  return library && typeof library.map === 'function' ? library : null;
}

function isCoordinate(v, limit) {
  const n = typeof v === 'number' ? v : Number(v);
  return v !== null && v !== '' && Number.isFinite(n) && Math.abs(n) <= limit;
}

// Valid [lat, lng] pairs from a stored geometry; anything malformed is skipped.
function toLatLngs(geometry) {
  if (!Array.isArray(geometry)) return [];
  return geometry
    .filter((p) => Array.isArray(p) && isCoordinate(p[0], 90) && isCoordinate(p[1], 180))
    .map((p) => [Number(p[0]), Number(p[1])]);
}

function pointOf(place) {
  if (!place || !isCoordinate(place.lat, 90) || !isCoordinate(place.lng, 180)) return null;
  return [Number(place.lat), Number(place.lng)];
}

function placeName(place, fallback) {
  const text = (place?.label || place?.address || '').trim();
  return text || fallback;
}

function token(node, name, fallback) {
  const value = getComputedStyle(node).getPropertyValue(name).trim();
  return value || fallback;
}

// Leaflet sets string tooltip content as HTML; a text node keeps place names inert.
function textContent(text) {
  const span = document.createElement('span');
  span.textContent = text;
  return span;
}

function useDarkScheme() {
  const query = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  const [dark, setDark] = useState(() => Boolean(query?.matches));
  useEffect(() => {
    if (!query) return undefined;
    const onChange = (event) => setDark(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return dark;
}

/**
 * RouteMap({ geometry: [[lat, lng], …], origin: { lat, lng, label }, destination, height = 220 })
 */
export default function RouteMap({ geometry, origin, destination, height = 220 }) {
  const nodeRef = useRef(null);
  const mapRef = useRef(null);
  const boundsRef = useRef(null);
  const dark = useDarkScheme();
  const L = leaflet();

  const line = toLatLngs(geometry);
  const start = pointOf(origin) ?? line[0] ?? null;
  const end = pointOf(destination) ?? line[line.length - 1] ?? null;
  const showMap = Boolean(L) && line.length >= 2;
  const startName = placeName(origin, 'Start');
  const endName = placeName(destination, 'Destination');
  // Redraw only when what is drawn changes, not on every parent render.
  const drawKey = showMap
    ? [line.length, line[0], line[line.length - 1], line[Math.floor(line.length / 2)], start, end, startName, endName, dark].join('|')
    : '';

  // Create the map once a route can be shown; remove it when the route goes or on unmount.
  useEffect(() => {
    const node = nodeRef.current;
    if (!showMap || !node) return undefined;
    const map = L.map(node, {
      zoomControl: true,
      attributionControl: true,
      scrollWheelZoom: false, // the page scrolls past the map instead of zooming it
      dragging: !L.Browser.mobile, // one finger scrolls the page on phones; pinch still zooms
      boxZoom: false,
    });
    L.tileLayer(TILE_URL, { maxZoom: 19, attribution: ATTRIBUTION }).addTo(map);
    mapRef.current = map;

    let observer = null;
    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(() => {
        map.invalidateSize({ pan: false });
        if (boundsRef.current) map.fitBounds(boundsRef.current, FIT_OPTIONS);
      });
      observer.observe(node);
    }
    return () => {
      observer?.disconnect();
      map.remove();
      mapRef.current = null;
      boundsRef.current = null;
    };
  }, [showMap]);

  useEffect(() => {
    const map = mapRef.current;
    const node = nodeRef.current;
    if (!map || !node) return undefined;
    const signal = token(node, '--signal', FALLBACK_COLORS.signal);
    const surface = token(node, '--surface', FALLBACK_COLORS.surface);

    const layers = [
      // A surface-coloured casing keeps the route readable over busy tiles.
      L.polyline(line, { color: surface, weight: 8, opacity: 0.9, interactive: false }),
      L.polyline(line, { color: signal, weight: 4, opacity: 0.95, lineJoin: 'round', interactive: false }),
    ];
    if (start) {
      layers.push(L.circleMarker(start, { radius: 7, color: signal, weight: 3, fillColor: surface, fillOpacity: 1 })
        .bindTooltip(textContent(startName), { direction: 'top', offset: [0, -8] }));
    }
    if (end) {
      layers.push(L.circleMarker(end, { radius: 7, color: surface, weight: 3, fillColor: signal, fillOpacity: 1 })
        .bindTooltip(textContent(endName), { direction: 'top', offset: [0, -8] }));
    }
    const group = L.featureGroup(layers).addTo(map);
    boundsRef.current = group.getBounds();
    map.fitBounds(boundsRef.current, FIT_OPTIONS);
    return () => group.remove();
  }, [drawKey]);

  const style = { height: `${Math.max(120, Number(height) || 220)}px` };

  if (!showMap) {
    const message = L
      ? 'Calculate the route to see it on the map.'
      : "The map couldn't load — check your connection. Miles and costs still work.";
    return html`<div class="map route-map-empty" style=${style}>
      <${Icon} name="map-pin" size=${22} />
      <span>${message}</span>
    </div>`;
  }

  return html`<div
    ref=${nodeRef}
    class="map route-map"
    style=${style}
    role="group"
    aria-label=${`Map of the route from ${startName} to ${endName}`}
  ></div>`;
}

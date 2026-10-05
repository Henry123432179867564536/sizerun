// Geocoding, place suggestions and driving routes for the Desk trip planner.
//
// Free providers by default: postcodes.io (UK postcodes), Nominatim (OpenStreetMap search)
// and the public OSRM router. When GOOGLE_MAPS_API_KEY is set, Google Geocoding, Places Text
// Search and the Routes API (traffic-aware) are used first, with the free providers as the
// fallback whenever Google fails.

import { HttpError, UpstreamError, fetchJson } from './http.js';

const POSTCODES_IO = 'https://api.postcodes.io';
const NOMINATIM_SEARCH = 'https://nominatim.openstreetmap.org/search';
const OSRM_ROUTE = 'https://router.project-osrm.org/route/v1/driving';
const GOOGLE_GEOCODE = 'https://maps.googleapis.com/maps/api/geocode/json';
const GOOGLE_PLACES = 'https://places.googleapis.com/v1/places:searchText';
const GOOGLE_ROUTES = 'https://routes.googleapis.com/directions/v2:computeRoutes';

export const METERS_PER_MILE = 1609.344;
export const MAX_GEOMETRY_POINTS = 400;
export const QUERY_MIN_LENGTH = 3;
export const QUERY_MAX_LENGTH = 200;
const SUGGEST_LIMIT = 6;

// Great Britain and Northern Ireland, used to keep Google text search inside the UK.
const UK_RECTANGLE = {
  low: { latitude: 49.8, longitude: -8.7 },
  high: { latitude: 60.95, longitude: 1.8 },
};

// Nominatim's usage policy allows at most one request per second from an application and
// asks for results to be cached. Requests are spaced per server instance; a caller that
// would have to queue for too long gets a "busy" answer instead of a slow one. The clock
// is kept per fetch implementation: in production that is the one global fetch, while an
// injected test double (which never reaches Nominatim) gets a clock of its own.
const NOMINATIM_INTERVAL_MS = 1100;
const NOMINATIM_MAX_WAIT_MS = 4000;
const nominatimClocks = new WeakMap(); // fetch implementation -> earliest next start (ms)

const geocodeCache = createCache({ ttlMs: 24 * 60 * 60 * 1000, max: 300 });
const suggestCache = createCache({ ttlMs: 10 * 60 * 1000, max: 300 });

const POSTCODE_RE = /^(?:GIR 0AA|[A-Z]{1,2}\d[A-Z\d]? \d[A-Z]{2})$/;
const OUTCODE_RE = /^[A-Z]{1,2}\d[A-Z\d]?$/;
// An outcode optionally followed by the start of an inward code: "SO14", "SO14 3", "SO143J".
const POSTCODE_PREFIX_RE = /^[A-Z]{1,2}\d[A-Z\d]?(?: ?\d[A-Z]{0,2})?$/;
const POSTCODE_IN_TEXT_RE = /\b([A-Z]{1,2}\d[A-Z\d]?) ?(\d[A-Z]{2})\b/i;
const LATLNG_RE = /^\(?\s*([+-]?\d{1,3}(?:\.\d+)?)\s*,\s*([+-]?\d{1,3}(?:\.\d+)?)\s*\)?$/;

// ---- parsing and validation ------------------------------------------------------------

// "50.9097,-1.4044" (optionally spaced or in brackets) -> { lat, lng }, else null.
export function parseLatLng(str) {
  if (typeof str !== 'string') return null;
  const match = LATLNG_RE.exec(str.trim());
  return match ? toPoint({ lat: match[1], lng: match[2] }) : null;
}

// { lat, lng } with numbers or numeric strings in range -> { lat, lng } numbers, else null.
export function toPoint(value) {
  if (!value || typeof value !== 'object') return null;
  const lat = toCoordinate(value.lat);
  const lng = toCoordinate(value.lng);
  if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

function toCoordinate(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// "so143ja" / " SO14  3JA " -> "SO14 3JA"; null when it is not a full UK postcode.
export function normalisePostcode(str) {
  const compact = String(str ?? '').toUpperCase().replace(/\s+/g, '');
  if (compact.length < 5 || compact.length > 7) return null;
  const postcode = `${compact.slice(0, -3)} ${compact.slice(-3)}`;
  return POSTCODE_RE.test(postcode) ? postcode : null;
}

export function isUkPostcode(str) {
  return normalisePostcode(str) !== null;
}

export function isUkOutcode(str) {
  return OUTCODE_RE.test(String(str ?? '').trim().toUpperCase());
}

// Google's encoded polyline format -> [[lat, lng], ...].
export function decodePolyline(encoded, precision = 5) {
  const str = String(encoded ?? '');
  const factor = 10 ** precision;
  const points = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  const nextDelta = () => {
    let result = 0;
    let shift = 0;
    let byte;
    do {
      if (index >= str.length) throw new Error('Malformed encoded polyline');
      byte = str.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };

  while (index < str.length) {
    lat += nextDelta();
    lng += nextDelta();
    points.push([lat / factor, lng / factor]);
  }
  return points;
}

// Evenly spaced subset of at most `max` points that always keeps the first and last.
export function downsample(points, max = MAX_GEOMETRY_POINTS) {
  if (!Array.isArray(points)) return [];
  if (points.length <= max) return points.slice();
  if (max < 2) return points.slice(0, Math.max(0, max));
  const step = (points.length - 1) / (max - 1);
  const out = [];
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]);
  return out;
}

// ---- geocode ---------------------------------------------------------------------------

// Resolves free text to one place:
//   { label, address, lat, lng, postcode, source }
// Order: "lat,lng" literal -> full postcode (postcodes.io) -> outcode (postcodes.io) ->
// postcode found inside a longer address (postcodes.io) -> Google Geocoding (when a key
// is set) -> Nominatim. Resolves null when nothing matches; throws HttpError 502 when the
// last provider tried was unreachable, so an outage is not reported as "address not found".
export async function geocode(query, { fetchImpl, googleKey = process.env.GOOGLE_MAPS_API_KEY } = {}) {
  const q = cleanQuery(query);
  if (!q) return null;

  const literal = parseLatLng(q);
  if (literal) return coordinatePlace(literal);

  const cacheKey = q.toLowerCase();
  const cached = geocodeCache.get(cacheKey);
  if (cached) return { ...cached };

  const place = await firstFound(geocodeAttempts(q, { fetchImpl, googleKey }), 'address lookup');
  if (place) geocodeCache.set(cacheKey, place);
  return place ? { ...place } : null;
}

function geocodeAttempts(q, { fetchImpl, googleKey }) {
  const attempts = [];
  const postcode = normalisePostcode(q);
  if (postcode) {
    attempts.push(() => lookupPostcode(postcode, fetchImpl));
  } else if (isUkOutcode(q)) {
    attempts.push(() => lookupOutcode(q.toUpperCase(), fetchImpl));
  } else {
    const embedded = POSTCODE_IN_TEXT_RE.exec(q);
    if (embedded) {
      attempts.push(async () => {
        const found = await lookupPostcode(normalisePostcode(embedded[0]), fetchImpl);
        // Keep the user's own wording; the postcode only supplies the coordinates.
        return found && { ...found, label: firstSegment(q), address: q };
      });
    }
  }
  if (googleKey) attempts.push(() => googleGeocode(q, googleKey, fetchImpl));
  attempts.push(async () => (await nominatimSearch(q, 1, fetchImpl))[0] || null);
  return attempts;
}

// ---- suggest ---------------------------------------------------------------------------

// Up to six { label, address, lat, lng, source } for an address box.
// Postcode-like text goes to postcodes.io; anything else (or a postcode with no match) to
// Google Places Text Search when a key is set, otherwise (or when Google fails) Nominatim.
export async function suggest(query, { fetchImpl, googleKey = process.env.GOOGLE_MAPS_API_KEY } = {}) {
  const q = cleanQuery(query);
  if (q.length < QUERY_MIN_LENGTH) return [];

  const literal = parseLatLng(q);
  if (literal) return [toSuggestion(coordinatePlace(literal))];

  const cacheKey = q.toLowerCase();
  const cached = suggestCache.get(cacheKey);
  if (cached) return cached.map((place) => ({ ...place }));

  const attempts = [];
  if (POSTCODE_PREFIX_RE.test(q.toUpperCase())) {
    // No postcode match is not the end: "A303" looks like a postcode but is a road.
    attempts.push(async () => {
      const list = await postcodeSuggestions(q, fetchImpl);
      return list.length ? list : null;
    });
  }
  // Google's answer is final even when empty; Nominatim only stands in when Google fails.
  if (googleKey) attempts.push(() => googlePlaces(q, googleKey, fetchImpl));
  attempts.push(() => nominatimSearch(q, SUGGEST_LIMIT, fetchImpl));

  const places = (await firstFound(attempts, 'address search')) || [];
  const results = places.slice(0, SUGGEST_LIMIT).map(toSuggestion);
  if (results.length) suggestCache.set(cacheKey, results);
  return results.map((place) => ({ ...place }));
}

async function postcodeSuggestions(q, fetchImpl) {
  const lookups = [
    fetchJson(`${POSTCODES_IO}/postcodes?q=${encodeURIComponent(q)}&limit=${SUGGEST_LIMIT}`, { fetchImpl }).then((body) =>
      (Array.isArray(body && body.result) ? body.result : []).map(postcodePlace).filter(Boolean),
    ),
  ];
  // A bare outcode also offers the district itself first ("SO14", "Southampton SO14").
  if (isUkOutcode(q)) lookups.unshift(lookupOutcode(q.toUpperCase(), fetchImpl).then((place) => (place ? [place] : [])));
  const settled = await Promise.allSettled(lookups);
  if (settled.every((r) => r.status === 'rejected')) throw settled[0].reason;
  return settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
}

function toSuggestion({ label, address, lat, lng, source }) {
  return { label, address, lat, lng, source };
}

// Tries providers in order and returns the first non-null answer. Each attempt resolves
// to an answer, to null for "no match", or throws when its provider is unreachable.
// When nothing matched and the last provider tried was unreachable the outcome is
// unknown, so this throws a 502 rather than letting the caller report "not found".
// HttpErrors (such as "busy") propagate unchanged.
async function firstFound(attempts, what) {
  let lastFailed = false;
  for (const attempt of attempts) {
    try {
      const value = await attempt();
      lastFailed = false;
      if (value) return value;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      lastFailed = true;
      console.warn(`[geo] ${what} provider failed: ${err && err.message}`);
    }
  }
  if (lastFailed) {
    throw new HttpError(502, `The ${what} service isn't responding right now. Try again in a minute, or use a postcode.`);
  }
  return null;
}

// ---- route -----------------------------------------------------------------------------

// Driving route between two { lat, lng } points, one way:
//   { miles, minutes, geometry: [[lat, lng], ...] (<= 400 points), provider, traffic }
// Google Routes (traffic-aware) when a key is set, else or on failure OSRM.
export async function route(a, b, { fetchImpl, googleKey = process.env.GOOGLE_MAPS_API_KEY } = {}) {
  const origin = toPoint(a);
  const destination = toPoint(b);
  if (!origin || !destination) {
    throw new HttpError(400, 'A route needs a valid start and end point (latitude and longitude).');
  }
  if (googleKey) {
    try {
      return await googleRoute(origin, destination, googleKey, fetchImpl);
    } catch (err) {
      console.warn(`[geo] Google Routes failed, falling back to OSRM: ${err && err.message}`);
    }
  }
  try {
    return await osrmRoute(origin, destination, fetchImpl);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.warn(`[geo] OSRM failed: ${err && err.message}`);
    throw new HttpError(502, "Couldn't work out a driving route right now. Enter the miles and minutes yourself.");
  }
}

async function googleRoute(origin, destination, key, fetchImpl) {
  const body = await fetchJson(GOOGLE_ROUTES, {
    method: 'POST',
    fetchImpl,
    headers: {
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline',
    },
    body: {
      origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } },
      destination: { location: { latLng: { latitude: destination.lat, longitude: destination.lng } } },
      travelMode: 'DRIVE',
      routingPreference: 'TRAFFIC_AWARE',
      regionCode: 'GB',
      languageCode: 'en-GB',
      units: 'IMPERIAL',
    },
  });
  const first = body && Array.isArray(body.routes) ? body.routes[0] : null;
  if (!first) throw new UpstreamError('Google Routes found no route', { host: 'routes.googleapis.com', code: 'api' });

  // proto3 JSON omits zero values, so a missing distance or duration means 0.
  const meters = first.distanceMeters === undefined ? 0 : Number(first.distanceMeters);
  const seconds = parseProtoDuration(first.duration);
  if (!Number.isFinite(meters) || seconds === null) {
    throw new UpstreamError('Google Routes returned an unreadable route', { host: 'routes.googleapis.com', code: 'api' });
  }
  const encoded = first.polyline && first.polyline.encodedPolyline;
  const points = encoded ? decodePolyline(encoded) : [[origin.lat, origin.lng], [destination.lat, destination.lng]];
  return buildRoute({ meters, seconds, points, provider: 'google', traffic: true });
}

async function osrmRoute(origin, destination, fetchImpl) {
  const url = `${OSRM_ROUTE}/${origin.lng},${origin.lat};${destination.lng},${destination.lat}?overview=simplified&geometries=geojson`;
  let body;
  try {
    body = await fetchJson(url, { fetchImpl });
  } catch (err) {
    // OSRM reports "no route" as HTTP 400 with a JSON code.
    if (err instanceof UpstreamError && err.status === 400 && /"code"\s*:\s*"No(?:Route|Segment)"/.test(err.body)) {
      throw noRouteError();
    }
    throw err;
  }
  if (body && (body.code === 'NoRoute' || body.code === 'NoSegment')) throw noRouteError();
  const first = body && body.code === 'Ok' && Array.isArray(body.routes) ? body.routes[0] : null;
  const meters = first ? Number(first.distance) : NaN;
  const seconds = first ? Number(first.duration) : NaN;
  if (!Number.isFinite(meters) || !Number.isFinite(seconds)) {
    throw new UpstreamError(`OSRM answered ${body && body.code}`, { host: 'router.project-osrm.org', code: 'api' });
  }
  const coordinates = first.geometry && Array.isArray(first.geometry.coordinates) ? first.geometry.coordinates : [];
  const points = coordinates
    .filter((c) => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]))
    .map(([lng, lat]) => [lat, lng]);
  return buildRoute({ meters, seconds, points, provider: 'osrm', traffic: false });
}

function noRouteError() {
  return new HttpError(502, "There's no driving route between those places. Enter the miles and minutes yourself.");
}

// Rounded to the precision the trips table stores (miles 2 dp, minutes 1 dp).
function buildRoute({ meters, seconds, points, provider, traffic }) {
  return {
    miles: round(meters / METERS_PER_MILE, 2),
    minutes: round(seconds / 60, 1),
    geometry: downsample(points).map(([lat, lng]) => [round(lat, 5), round(lng, 5)]),
    provider,
    traffic,
  };
}

// "1234s" / "1234.5s" -> seconds; a missing duration is zero (proto3 JSON).
function parseProtoDuration(value) {
  if (value === undefined || value === null) return 0;
  const match = /^(\d+(?:\.\d+)?)s$/.exec(String(value));
  return match ? Number(match[1]) : null;
}

// ---- providers -------------------------------------------------------------------------

async function lookupPostcode(postcode, fetchImpl) {
  try {
    const body = await fetchJson(`${POSTCODES_IO}/postcodes/${encodeURIComponent(postcode)}`, { fetchImpl });
    return postcodePlace(body && body.result);
  } catch (err) {
    if (err instanceof UpstreamError && err.status === 404) return null;
    throw err;
  }
}

async function lookupOutcode(outcode, fetchImpl) {
  try {
    const body = await fetchJson(`${POSTCODES_IO}/outcodes/${encodeURIComponent(outcode)}`, { fetchImpl });
    const r = body && body.result;
    const point = r && toPoint({ lat: r.latitude, lng: r.longitude });
    if (!point) return null;
    const district = Array.isArray(r.admin_district) ? r.admin_district[0] : r.admin_district;
    return {
      label: r.outcode,
      address: [district, r.outcode].filter(Boolean).join(' '),
      ...point,
      postcode: null,
      source: 'postcodes.io',
    };
  } catch (err) {
    if (err instanceof UpstreamError && err.status === 404) return null;
    throw err;
  }
}

function postcodePlace(r) {
  // Some postcodes (new builds, PO boxes) exist without coordinates.
  const point = r && toPoint({ lat: r.latitude, lng: r.longitude });
  if (!point) return null;
  const area = [r.admin_ward, r.admin_district].filter(Boolean).join(', ');
  return {
    label: r.postcode,
    address: [area, r.postcode].filter(Boolean).join(' '),
    ...point,
    postcode: r.postcode,
    source: 'postcodes.io',
  };
}

async function googleGeocode(q, key, fetchImpl) {
  const url =
    `${GOOGLE_GEOCODE}?address=${encodeURIComponent(q)}&region=gb&components=country:GB` +
    `&language=en-GB&key=${encodeURIComponent(key)}`;
  const body = await fetchJson(url, { fetchImpl });
  if (body && body.status === 'ZERO_RESULTS') return null;
  if (!body || body.status !== 'OK' || !Array.isArray(body.results)) {
    throw new UpstreamError(`Google Geocoding answered ${body && body.status}`, { host: 'maps.googleapis.com', code: 'api', status: 200 });
  }
  const r = body.results[0];
  const location = r && r.geometry && r.geometry.location;
  const point = location && toPoint({ lat: location.lat, lng: location.lng });
  if (!point) return null;
  const component = (r.address_components || []).find((c) => Array.isArray(c.types) && c.types.includes('postal_code'));
  const address = stripCountry(r.formatted_address);
  return {
    label: firstSegment(address),
    address,
    ...point,
    postcode: (component && normalisePostcode(component.long_name)) || null,
    source: 'google',
  };
}

async function googlePlaces(q, key, fetchImpl) {
  const body = await fetchJson(GOOGLE_PLACES, {
    method: 'POST',
    fetchImpl,
    headers: {
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location',
    },
    body: {
      textQuery: q,
      regionCode: 'GB',
      languageCode: 'en-GB',
      pageSize: SUGGEST_LIMIT,
      locationRestriction: { rectangle: UK_RECTANGLE },
    },
  });
  const places = body && Array.isArray(body.places) ? body.places : [];
  return places
    .map((p) => {
      const point = p.location && toPoint({ lat: p.location.latitude, lng: p.location.longitude });
      if (!point) return null;
      const address = stripCountry(p.formattedAddress);
      const name = p.displayName && p.displayName.text;
      return { label: name || firstSegment(address), address, ...point, source: 'google' };
    })
    .filter(Boolean);
}

async function nominatimSearch(q, limit, fetchImpl = globalThis.fetch) {
  await nominatimTurn(fetchImpl);
  const url = `${NOMINATIM_SEARCH}?format=jsonv2&countrycodes=gb&limit=${limit}&q=${encodeURIComponent(q)}`;
  const rows = await fetchJson(url, { fetchImpl, headers: { 'Accept-Language': 'en-GB' } });
  if (!Array.isArray(rows)) {
    throw new UpstreamError('Nominatim returned an unexpected response', { host: 'nominatim.openstreetmap.org', code: 'api' });
  }
  return rows.map(nominatimPlace).filter(Boolean);
}

function nominatimPlace(r) {
  const point = r && toPoint({ lat: r.lat, lng: r.lon });
  if (!point) return null;
  const address = stripCountry(r.display_name);
  const segments = address.split(', ');
  const postcode = segments.map(normalisePostcode).find(Boolean) || null;
  // Unnamed buildings come back as "12, High Street, ..."; show "12 High Street".
  const houseLabel = /^\d+[A-Za-z]?$/.test(segments[0]) && segments[1] ? `${segments[0]} ${segments[1]}` : segments[0];
  return {
    label: (typeof r.name === 'string' && r.name.trim()) || houseLabel,
    address,
    ...point,
    postcode,
    source: 'nominatim',
  };
}

async function nominatimTurn(fetchImpl) {
  const now = Date.now();
  const start = Math.max(now, nominatimClocks.get(fetchImpl) ?? 0);
  if (start - now > NOMINATIM_MAX_WAIT_MS) {
    throw new HttpError(503, 'Address search is busy. Try again in a few seconds.');
  }
  nominatimClocks.set(fetchImpl, start + NOMINATIM_INTERVAL_MS);
  if (start > now) await new Promise((resolve) => setTimeout(resolve, start - now));
}

// ---- small helpers ---------------------------------------------------------------------

function coordinatePlace({ lat, lng }) {
  const label = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  return { label, address: label, lat, lng, postcode: null, source: 'coordinates' };
}

function cleanQuery(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, QUERY_MAX_LENGTH) : '';
}

function stripCountry(address) {
  return String(address || '')
    .trim()
    .replace(/,\s*(?:UK|United Kingdom)$/i, '');
}

function firstSegment(text) {
  return String(text || '').split(',')[0].trim();
}

function round(value, dp) {
  const f = 10 ** dp;
  return Math.round((value + Number.EPSILON) * f) / f;
}

// Small TTL cache with least-recently-used eviction.
function createCache({ ttlMs, max }) {
  const entries = new Map();
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      entries.delete(key);
      if (entry.expiresAt <= Date.now()) return undefined;
      entries.set(key, entry);
      return entry.value;
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, { value, expiresAt: Date.now() + ttlMs });
      if (entries.size > max) entries.delete(entries.keys().next().value);
    },
  };
}

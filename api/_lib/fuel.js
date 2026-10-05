// Live UK pump prices from the retailers' open data feeds (CMA fuel price scheme).
//
// Every feed is meant to look like
//   { last_updated: "05/10/2026 09:59:17", stations: [{ site_id, brand, address, postcode,
//     location: { latitude, longitude }, prices: { E10, E5, B7, SDV } }] }
// but in practice feeds drift: numbers arrive as strings, prices in pounds, placeholder
// prices (10, 999.9), 0,0 or swapped coordinates, placeholder site ids, no date, HTML error
// pages and 403s. parseFeed() normalises all of that; loadAll() tolerates any feed failing.

import { fetchJson, UpstreamError } from './http.js';
import { normalisePostcode, toPoint } from './geo.js';

export const FUEL_TYPES = Object.freeze(['E10', 'E5', 'B7', 'SDV']);

export const FEEDS = Object.freeze(
  [
    ['Asda', 'https://storelocator.asda.com/fuel_prices_data.json'],
    ['Esso', 'https://fuelprices.esso.co.uk/latestdata.json'],
    ['JET', 'https://jetlocal.co.uk/fuel_prices_data.json'],
    ['Moto', 'https://moto-way.com/fuel-price/fuel_prices.json'],
    ['MFG', 'https://fuel.motorfuelgroup.com/fuel_prices_data.json'],
    ['Rontec', 'https://www.rontec-servicestations.co.uk/fuel-prices/data/fuel_prices_data.json'],
    ['Tesco', 'https://www.tesco.com/fuel_prices/fuel_prices_data.json'],
    ['Morrisons', 'https://www.morrisons.com/fuel-prices/fuel.json'],
    ["Sainsbury's", 'https://api.sainsburys.co.uk/v1/exports/latest/fuel_prices_data.json'],
    ['Applegreen', 'https://applegreenstores.com/fuel-prices/data.json'],
    ['Shell', 'https://www.shell.co.uk/fuel-prices-data.html'],
    ['BP', 'https://www.bp.com/en_gb/united-kingdom/home/fuelprices/fuel_prices_data.json'],
  ].map(([name, url]) => Object.freeze({ name, url })),
);

export const CACHE_TTL_MS = 20 * 60 * 1000;
export const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
// A load that produced no stations at all is retried sooner than a good one.
const EMPTY_CACHE_TTL_MS = 60 * 1000;

const RADII_MILES = [3, 6, 10, 20];
const MIN_LOCAL_STATIONS = 3;
const MIN_PPL = 80;
const MAX_PPL = 300;
const EARTH_RADIUS_MILES = 3958.7613;
// Stations that share a site_id but are further apart than this are different sites
// (MFG, for one, reuses the placeholder id "7zzzzzzzzzzz").
const SAME_SITE_MILES = 1;
// Generous box around the UK mainland, Northern Ireland and the islands. Stations outside
// it are bad coordinates or not in the UK (Morrisons lists a Gibraltar forecourt).
const UK_BOX = { minLat: 49.8, maxLat: 61, minLng: -8.7, maxLng: 2 };

const HOUR_MS = 60 * 60 * 1000;
const UK_DATE_TIME_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
const ISO_WITH_ZONE_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})$/i;

const BRAND_NAMES = new Map(
  Object.entries({
    applegreen: 'Applegreen',
    asda: 'Asda',
    bp: 'BP',
    esso: 'Esso',
    gulf: 'Gulf',
    jet: 'Jet',
    mfg: 'MFG',
    morrisons: 'Morrisons',
    moto: 'Moto',
    murco: 'Murco',
    rontec: 'Rontec',
    "sainsbury's": "Sainsbury's",
    sainsburys: "Sainsbury's",
    shell: 'Shell',
    tesco: 'Tesco',
    texaco: 'Texaco',
    valero: 'Valero',
  }),
);

let cache = null; // { at, ttl, promise }

// ---- maths -----------------------------------------------------------------------------

// Great-circle distance in miles between two { lat, lng } points in degrees.
export function haversineMiles(a, b) {
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLng = (b.lng - a.lng) * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Median of the numeric values in arr (numeric strings count; null/blank/NaN are ignored).
export function median(arr) {
  const values = (Array.isArray(arr) ? arr : []).map(toNumber).filter((n) => n !== null);
  if (!values.length) return null;
  values.sort((x, y) => x - y);
  const mid = values.length >> 1;
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}

// ---- parsing ---------------------------------------------------------------------------

// "dd/mm/yyyy hh:mm:ss" in UK local time -> ISO string (UTC), or null. An ISO 8601 string
// with an explicit zone is also accepted.
export function parseLondonTime(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const match = UK_DATE_TIME_RE.exec(text);
  if (!match) {
    const ms = ISO_WITH_ZONE_RE.test(text) ? Date.parse(text) : NaN;
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  const [day, month, year, hour, minute, second] = match.slice(1).map((part) => Number(part ?? 0));
  if (hour > 23 || minute > 59 || second > 59) return null;
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(wall);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return new Date(londonWallTimeToUtc(wall)).toISOString();
}

// UK clocks run on BST (UTC+1) from 01:00 UTC on the last Sunday of March to 01:00 UTC on
// the last Sunday of October. A wall time is read as BST when that reading falls inside
// BST; so the repeated hour in October resolves to its first (BST) occurrence and the
// skipped hour in March to GMT.
function londonWallTimeToUtc(wallMs) {
  const asBst = wallMs - HOUR_MS;
  return isBritishSummerTime(asBst) ? asBst : wallMs;
}

function isBritishSummerTime(utcMs) {
  const year = new Date(utcMs).getUTCFullYear();
  return utcMs >= lastSundayAt0100Utc(year, 2) && utcMs < lastSundayAt0100Utc(year, 9);
}

function lastSundayAt0100Utc(year, monthIndex) {
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0));
  return Date.UTC(year, monthIndex, lastDay.getUTCDate() - lastDay.getUTCDay(), 1);
}

// One retailer feed -> { name, updated: ISO|null, stations: [{ id, brand, address,
// postcode, lat, lng, prices: { E10, E5, B7, SDV } }] } with prices in pence per litre
// (null when not sold or implausible). Stations without usable coordinates or any
// plausible price are dropped. Never throws.
export function parseFeed(json, name) {
  const root = Array.isArray(json) ? { stations: json } : json && typeof json === 'object' ? json : {};
  const list = Array.isArray(root.stations) ? root.stations : [];
  const stations = [];
  for (const raw of list) {
    const station = parseStation(raw);
    if (station) stations.push(station);
  }
  return {
    name: String(name ?? ''),
    updated: parseLondonTime(root.last_updated ?? root.lastUpdated ?? root.updated),
    stations,
  };
}

function parseStation(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const location = raw.location && typeof raw.location === 'object' ? raw.location : raw;
  const point = ukPoint(toNumber(location.latitude ?? location.lat), toNumber(location.longitude ?? location.lng ?? location.lon));
  if (!point) return null;

  const rawPrices = {};
  if (raw.prices && typeof raw.prices === 'object') {
    for (const [key, value] of Object.entries(raw.prices)) rawPrices[key.trim().toUpperCase()] = value;
  }
  const prices = {};
  let priced = 0;
  for (const type of FUEL_TYPES) {
    prices[type] = pencePerLitre(rawPrices[type]);
    if (prices[type] !== null) priced += 1;
  }
  if (!priced) return null;

  const postcodeText = cleanText(raw.postcode);
  return {
    id: cleanText(raw.site_id ?? raw.siteId ?? raw.id),
    brand: brandName(raw.brand),
    address: cleanText(raw.address),
    postcode: normalisePostcode(postcodeText) || postcodeText.toUpperCase(),
    lat: point.lat,
    lng: point.lng,
    prices,
  };
}

// Pence per litre, or null. Values under 10 are pounds; placeholders such as 0, 10 and
// 999.9 fall outside the plausible 80-300p range and are dropped.
function pencePerLitre(value) {
  let n = toNumber(value);
  if (n === null || n <= 0) return null;
  if (n < 10) n *= 100;
  n = Math.round(n * 10) / 10;
  return n >= MIN_PPL && n <= MAX_PPL ? n : null;
}

function ukPoint(lat, lng) {
  if (lat === null || lng === null) return null;
  if (inUk(lat, lng)) return { lat, lng };
  if (inUk(lng, lat)) return { lat: lng, lng: lat }; // latitude and longitude swapped
  return null;
}

function inUk(lat, lng) {
  return lat >= UK_BOX.minLat && lat <= UK_BOX.maxLat && lng >= UK_BOX.minLng && lng <= UK_BOX.maxLng;
}

// Numbers, or the first number inside a string such as "173.9", "£1.739" or "173.9p".
function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const match = /[+-]?\d+(?:\.\d+)?/.exec(value.replace(/,/g, ''));
  return match ? Number(match[0]) : null;
}

function cleanText(value) {
  return value === undefined || value === null ? '' : String(value).trim().replace(/\s+/g, ' ');
}

// "ESSO", "Esso " and "esso" are one brand.
function brandName(value) {
  const text = cleanText(value);
  const known = BRAND_NAMES.get(text.toLowerCase());
  if (known) return known;
  if (text.length > 3 && text === text.toUpperCase()) {
    return text.toLowerCase().replace(/(^|[\s'-])\p{L}/gu, (m) => m.toUpperCase());
  }
  return text;
}

// ---- loading ---------------------------------------------------------------------------

// Fetches every feed concurrently and returns
//   { stations, feeds: [{ name, ok, status, updated, stations, stale, error? }], fetchedAt }
// status: 'ok' | 'undated' (kept, no date given) | 'stale' (older than 7 days, excluded) |
// 'empty' (no usable stations) | 'error' (unreachable, HTTP error or not JSON).
// ok means the feed contributes prices. Stations are deduplicated by site_id, preferring
// the most recently updated feed. The result is cached in module memory for 20 minutes
// (concurrent callers share one load) and must be treated as read-only.
// Options: now (ms), fetchImpl, force (ignore the cache).
export async function loadAll({ now = Date.now(), fetchImpl, force = false } = {}) {
  // A negative age (the clock moved back) counts as expired.
  if (!force && cache && now >= cache.at && now - cache.at < cache.ttl) return cache.promise;
  const entry = { at: now, ttl: CACHE_TTL_MS, promise: fetchAllFeeds(now, fetchImpl) };
  cache = entry;
  try {
    const result = await entry.promise;
    if (!result.stations.length) entry.ttl = EMPTY_CACHE_TTL_MS;
    return result;
  } catch (err) {
    if (cache === entry) cache = null;
    throw err;
  }
}

async function fetchAllFeeds(now, fetchImpl) {
  const loaded = await Promise.all(FEEDS.map((feed) => loadFeed(feed, now, fetchImpl)));
  const contributing = loaded
    .filter((feed) => feed.ok)
    .sort((a, b) => (b.updatedMs ?? 0) - (a.updatedMs ?? 0)); // newest first, undated last
  return {
    stations: dedupe(contributing.map((feed) => feed.parsed.stations)),
    feeds: loaded.map(({ parsed, updatedMs, ...status }) => status),
    fetchedAt: new Date(now).toISOString(),
  };
}

async function loadFeed(feed, now, fetchImpl) {
  let parsed;
  try {
    parsed = parseFeed(await fetchJson(feed.url, { fetchImpl }), feed.name);
  } catch (err) {
    return { name: feed.name, ok: false, status: 'error', updated: null, stations: 0, stale: false, error: describeFailure(err) };
  }
  const updatedMs = parsed.updated ? Date.parse(parsed.updated) : null;
  const stale = updatedMs !== null && now - updatedMs > STALE_AFTER_MS;
  const count = parsed.stations.length;
  const result = {
    name: feed.name,
    ok: !stale && count > 0,
    status: stale ? 'stale' : count === 0 ? 'empty' : updatedMs === null ? 'undated' : 'ok',
    updated: parsed.updated,
    stations: count,
    stale,
    parsed,
    updatedMs,
  };
  if (result.status === 'empty') result.error = 'No usable UK stations';
  return result;
}

function describeFailure(err) {
  if (!(err instanceof UpstreamError)) return 'Unreadable response';
  if (err.code === 'timeout') return 'Timed out';
  if (err.code === 'network') return 'Unreachable';
  if (err.code === 'invalid_json') return 'Not JSON';
  return `HTTP ${err.status}`;
}

function dedupe(stationLists) {
  const keptById = new Map();
  const out = [];
  for (const stations of stationLists) {
    for (const station of stations) {
      if (station.id) {
        const kept = keptById.get(station.id);
        if (kept && kept.some((other) => haversineMiles(other, station) <= SAME_SITE_MILES)) continue;
        if (kept) kept.push(station);
        else keptById.set(station.id, [station]);
      }
      out.push(station);
    }
  }
  return out;
}

// ---- pricing ---------------------------------------------------------------------------

// Typical price of `type` around { lat, lng }: tries 3, 6, 10 and 20 mile radii until at
// least three stations sell it, else falls back to the whole country.
//   { type, ppl (median), mean, min, max, count, radiusMiles, scope: 'local'|'national',
//     cheapest: { brand, address, postcode, ppl, miles } | null, nearest: {...} | null }
// Without lat/lng the national figures are returned. National results carry no cheapest
// station (the cheapest pump in the country is no use), but keep the nearest when known.
export function priceNear({ lat, lng, type, stations = [] } = {}) {
  const fuel = String(type ?? '').trim().toUpperCase();
  if (!FUEL_TYPES.includes(fuel)) throw new RangeError(`Unknown fuel type "${type}"`);
  const priced = (Array.isArray(stations) ? stations : []).filter(
    (s) => s && s.prices && Number.isFinite(s.prices[fuel]),
  );
  const here = toPoint({ lat, lng });
  const national = { type: fuel, ...priceStats(priced.map((s) => s.prices[fuel])), radiusMiles: null, scope: 'national', cheapest: null, nearest: null };
  if (!here) return national;

  const byDistance = priced
    .map((station) => ({ station, miles: haversineMiles(here, station) }))
    .sort((a, b) => a.miles - b.miles);
  const nearest = byDistance.length ? describeStation(byDistance[0], fuel) : null;

  for (const radius of RADII_MILES) {
    const within = byDistance.filter((entry) => entry.miles <= radius);
    if (within.length < MIN_LOCAL_STATIONS) continue;
    // byDistance is nearest-first, so on equal prices the nearer station wins.
    const cheapest = within.reduce((best, entry) => (entry.station.prices[fuel] < best.station.prices[fuel] ? entry : best));
    return {
      type: fuel,
      ...priceStats(within.map((entry) => entry.station.prices[fuel])),
      radiusMiles: radius,
      scope: 'local',
      cheapest: describeStation(cheapest, fuel),
      nearest,
    };
  }
  return { ...national, nearest };
}

function priceStats(values) {
  if (!values.length) return { ppl: null, mean: null, min: null, max: null, count: 0 };
  const sum = values.reduce((total, v) => total + v, 0);
  return {
    ppl: round1(median(values)),
    mean: round1(sum / values.length),
    min: Math.min(...values),
    max: Math.max(...values),
    count: values.length,
  };
}

function describeStation({ station, miles }, fuel) {
  return {
    brand: station.brand,
    address: station.address,
    postcode: station.postcode,
    ppl: station.prices[fuel],
    miles: round1(miles),
  };
}

function round1(n) {
  return Math.round((n + Number.EPSILON) * 10) / 10;
}

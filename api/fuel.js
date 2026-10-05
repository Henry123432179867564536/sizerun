// GET /api/fuel?lat=&lng=&type=E10 — typical pump price near a point (public data, no auth).
//
// Responds { ok, type, ppl, mean, min, max, count, radiusMiles, scope, cheapest, nearest,
// national: { ppl, count }, feeds: [...], fetchedAt }. lat/lng are optional; without them
// the national figures are returned. Successful answers are CDN-cacheable for 15 minutes.

import { HttpError, allow, query, send, sendError } from './_lib/http.js';
import { FUEL_TYPES, loadAll, priceNear } from './_lib/fuel.js';
import { toPoint } from './_lib/geo.js';

const CDN_CACHE = 'public, s-maxage=900, stale-while-revalidate=3600';

export default async function handler(req, res) {
  if (!allow(req, res, ['GET'])) return;
  try {
    const params = query(req);
    const type = (params.get('type') || 'E10').trim().toUpperCase();
    if (!FUEL_TYPES.includes(type)) {
      throw new HttpError(400, `Fuel type must be one of ${FUEL_TYPES.join(', ')}.`);
    }
    const here = readPoint(params);

    const { stations, feeds, fetchedAt } = await loadAll();
    const national = priceNear({ type, stations });
    if (!national.count) {
      throw new HttpError(502, 'Live fuel prices are unavailable right now. Enter the price yourself.', { feeds });
    }
    const result = here ? priceNear({ ...here, type, stations }) : national;

    send(
      res,
      200,
      { ok: true, ...result, national: { ppl: national.ppl, count: national.count }, feeds, fetchedAt },
      { 'Cache-Control': CDN_CACHE },
    );
  } catch (err) {
    sendError(res, err);
  }
}

// Both lat and lng, or neither (national figures only).
function readPoint(params) {
  const lat = params.get('lat');
  const lng = params.get('lng');
  const hasLat = lat !== null && lat.trim() !== '';
  const hasLng = lng !== null && lng.trim() !== '';
  if (!hasLat && !hasLng) return null;
  if (hasLat !== hasLng) throw new HttpError(400, 'Send both lat and lng, or neither.');
  const point = toPoint({ lat, lng });
  if (!point) throw new HttpError(400, 'lat must be between -90 and 90 and lng between -180 and 180.');
  return point;
}

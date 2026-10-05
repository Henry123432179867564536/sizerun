// POST /api/route — driving distance and time between two places (signed-in users only).
//
// Body { origin, destination }, each either { lat, lng, label? } or { address }.
// Responds { ok, origin: { label, address, lat, lng }, destination: {...}, miles, minutes,
// geometry: [[lat, lng], ...], provider: 'google'|'osrm', traffic }. One way.
// An address that cannot be found is a 422; a routing failure is a 502.

import { HttpError, allow, readJson, send, sendError } from './_lib/http.js';
import { requireUser } from './_lib/auth.js';
import { QUERY_MAX_LENGTH, QUERY_MIN_LENGTH, geocode, route, toPoint } from './_lib/geo.js';

const MAX_LABEL_LENGTH = 120;

export default async function handler(req, res) {
  if (!allow(req, res, ['POST'])) return;
  try {
    await requireUser(req);
    const body = await readJson(req);
    const [origin, destination] = await Promise.all([
      resolvePlace(body.origin, 'start'),
      resolvePlace(body.destination, 'destination'),
    ]);
    const result = await route(origin, destination);
    send(res, 200, { ok: true, origin, destination, ...result });
  } catch (err) {
    sendError(res, err);
  }
}

async function resolvePlace(input, role) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new HttpError(400, `Give the ${role} as { lat, lng } or { address }.`);
  }

  const hasCoordinates = input.lat !== undefined && input.lat !== null && input.lng !== undefined && input.lng !== null;
  if (hasCoordinates) {
    const point = toPoint(input);
    if (!point) throw new HttpError(400, `The ${role} has an invalid latitude or longitude.`);
    const address = optionalText(input.address, QUERY_MAX_LENGTH);
    const label = optionalText(input.label, MAX_LABEL_LENGTH) || address || `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`;
    return { label, address, ...point };
  }

  const text = typeof input.address === 'string' ? input.address.trim().replace(/\s+/g, ' ') : '';
  if (text.length < QUERY_MIN_LENGTH) {
    throw new HttpError(400, `Enter the ${role} address (at least ${QUERY_MIN_LENGTH} characters).`);
  }
  if (text.length > QUERY_MAX_LENGTH) {
    throw new HttpError(400, `The ${role} address is too long. Keep it under ${QUERY_MAX_LENGTH} characters.`);
  }
  const place = await geocode(text);
  if (!place) {
    const shown = text.length > 60 ? `${text.slice(0, 57)}...` : text;
    throw new HttpError(422, `Couldn't find '${shown}'. Try a postcode.`);
  }
  return { label: place.label, address: place.address, lat: place.lat, lng: place.lng };
}

function optionalText(value, max) {
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/\s+/g, ' ');
  return text ? text.slice(0, max) : null;
}

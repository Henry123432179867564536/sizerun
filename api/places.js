// GET /api/places?q= — address suggestions for the address box (signed-in users only).
// Responds { ok, results: [{ label, address, lat, lng, source }] } with up to six places.

import { HttpError, allow, query, send, sendError } from './_lib/http.js';
import { requireUser } from './_lib/auth.js';
import { QUERY_MAX_LENGTH, QUERY_MIN_LENGTH, suggest } from './_lib/geo.js';

export default async function handler(req, res) {
  if (!allow(req, res, ['GET'])) return;
  try {
    await requireUser(req);
    const q = (query(req).get('q') || '').trim().replace(/\s+/g, ' ');
    if (q.length < QUERY_MIN_LENGTH) {
      throw new HttpError(400, `Type at least ${QUERY_MIN_LENGTH} characters to search.`);
    }
    if (q.length > QUERY_MAX_LENGTH) {
      throw new HttpError(400, `That search is too long. Keep it under ${QUERY_MAX_LENGTH} characters.`);
    }
    send(res, 200, { ok: true, results: await suggest(q) });
  } catch (err) {
    sendError(res, err);
  }
}

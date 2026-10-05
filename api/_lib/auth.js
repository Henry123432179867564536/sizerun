// Verifies the Supabase access token sent as `Authorization: Bearer <token>`.
//
// The token is checked by asking Supabase Auth who it belongs to (GET /auth/v1/user), which
// also catches signed-out and revoked sessions that a local JWT check would accept.
// Verified tokens are remembered by their SHA-256 for up to five minutes (never past the
// token's own expiry) so a burst of route/places calls costs one round trip.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { createHash } from 'node:crypto';
import { HttpError, UpstreamError, fetchJson } from './http.js';

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;
const MAX_TOKEN_LENGTH = 8192;
const REQUIRED_ENV = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];

const verified = new Map(); // sha256(token) -> { user, expiresAt }

// Resolves with { id, email, role } or throws HttpError (401 for a missing or invalid
// token, 500 for missing configuration, 502 when Supabase cannot be reached).
// Options exist for tests: fetchImpl, now (ms), env.
export async function requireUser(req, { fetchImpl, now = Date.now(), env = process.env } = {}) {
  const missing = REQUIRED_ENV.filter((name) => !env[name]);
  if (missing.length) {
    const plural = missing.length > 1;
    throw new HttpError(
      500,
      `The server is missing the environment variable${plural ? 's' : ''} ${missing.join(' and ')}. ` +
        `Add ${plural ? 'them' : 'it'} in Vercel (Project, Settings, Environment Variables) and redeploy.`,
    );
  }

  const token = bearerToken(req);
  if (!token) throw new HttpError(401, 'Sign in to use this.');

  const key = createHash('sha256').update(token).digest('hex');
  const hit = verified.get(key);
  if (hit && hit.expiresAt > now) return hit.user;
  if (hit) verified.delete(key);

  const user = await fetchSupabaseUser(token, { fetchImpl, env });
  const expiresAt = Math.min(now + CACHE_TTL_MS, tokenExpiry(token) ?? Infinity);
  if (expiresAt > now) remember(key, { user, expiresAt }, now);
  return user;
}

function bearerToken(req) {
  const header = req.headers && req.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(String(value || ''));
  if (!match || match[1].length > MAX_TOKEN_LENGTH) return null;
  return match[1];
}

async function fetchSupabaseUser(token, { fetchImpl, env }) {
  const base = String(env.SUPABASE_URL).replace(/\/+$/, '');
  let body;
  try {
    body = await fetchJson(`${base}/auth/v1/user`, {
      headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${token}` },
      fetchImpl,
    });
  } catch (err) {
    throw authFailure(err);
  }
  if (!body || typeof body.id !== 'string' || !body.id) {
    throw new HttpError(401, 'Your session is not valid. Sign in again.');
  }
  return { id: body.id, email: body.email ?? null, role: body.role ?? null };
}

function authFailure(err) {
  if (!(err instanceof UpstreamError) || err.code !== 'http') {
    return new HttpError(502, "Couldn't check your sign-in right now. Try again in a moment.");
  }
  // The API gateway rejects a bad apikey before the token is even looked at; that is a
  // server misconfiguration, not the user's fault.
  if (err.status === 401 && /invalid api key/i.test(err.body)) {
    console.error('[auth] Supabase rejected SUPABASE_SERVICE_ROLE_KEY');
    return new HttpError(500, 'The server could not authenticate with Supabase. Check SUPABASE_SERVICE_ROLE_KEY in Vercel.');
  }
  if (err.status >= 400 && err.status < 500 && err.status !== 429) {
    return new HttpError(401, 'Your session has expired. Sign in again.');
  }
  return new HttpError(502, "Couldn't check your sign-in right now. Try again in a moment.");
}

// The `exp` claim (as ms) of a JWT, or null. Read without verifying the signature: it only
// shortens how long an already verified token stays cached.
function tokenExpiry(token) {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const exp = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).exp;
    return Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

function remember(key, entry, now) {
  if (verified.size >= CACHE_MAX_ENTRIES) {
    for (const [k, v] of verified) if (v.expiresAt <= now) verified.delete(k);
    // Still full: drop the oldest entries (Map iterates in insertion order).
    for (const k of verified.keys()) {
      if (verified.size < CACHE_MAX_ENTRIES) break;
      verified.delete(k);
    }
  }
  verified.set(key, entry);
}

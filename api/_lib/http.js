// Shared HTTP helpers for the Desk API functions.
//
// Handlers only touch Node core response APIs (statusCode, setHeader, end) and read bodies
// through readJson(), so the same code runs on Vercel (which pre-parses req.body and adds
// res.status/res.json) and on a plain node:http server in development.

export const USER_AGENT = 'Sizemill/1.0 (+https://www.sizemill.com)';
export const FETCH_TIMEOUT_MS = 8000;

const MAX_BODY_BYTES = 64 * 1024;
const ERROR_SNIPPET_CHARS = 500;

// An error whose status and message are safe to show the caller.
export class HttpError extends Error {
  constructor(status, message, extra = undefined) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.extra = extra; // optional extra JSON fields for the error body
  }
}

// A failed outbound request. `status` is the upstream HTTP status (0 when no response
// arrived). `code` is 'http' | 'timeout' | 'network' | 'invalid_json' from fetchJson, or
// 'api' when a caller rejects a well-formed answer (an API-level error status, no route).
// The message names only the host: URLs can carry API keys in their query strings.
export class UpstreamError extends Error {
  constructor(message, { status = 0, code = 'http', host = '', body = '' } = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    this.code = code;
    this.host = host;
    this.body = body; // trimmed response text, for server-side diagnostics only
  }
}

export function send(res, status, body, headers = {}) {
  if (res.writableEnded) return;
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.statusCode = status;
  const merged = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  };
  for (const [name, value] of Object.entries(merged)) {
    if (value !== undefined && value !== null) res.setHeader(name, value);
  }
  res.setHeader('Content-Length', Buffer.byteLength(payload));
  res.end(payload);
}

// Turns any thrown value into a JSON error response. Only HttpError messages reach the
// client; anything else is logged and reported as a generic 500.
export function sendError(res, err) {
  if (err instanceof HttpError) {
    send(res, err.status, { ...(err.extra || {}), error: err.message });
    return;
  }
  console.error('[api] unexpected error:', err && err.stack ? err.stack : err);
  send(res, 500, { error: 'Something went wrong on our side. Try again in a moment.' });
}

// Responds 405 and returns false when the method is not in `methods`.
export function allow(req, res, methods) {
  if (methods.includes(req.method)) return true;
  send(res, 405, { error: `Use ${methods.join(' or ')} for this endpoint.` }, { Allow: methods.join(', ') });
  return false;
}

// Query-string parameters as URLSearchParams (req.url is a path plus query on both
// Vercel and node:http).
export function query(req) {
  return new URL(req.url || '/', 'http://localhost').searchParams;
}

// Reads a JSON object body. Vercel exposes a lazily parsed req.body (object, string or
// Buffer depending on Content-Type, and a getter that throws on malformed JSON); a plain
// node:http request has no req.body and the stream is consumed here instead.
// An empty body yields {}. Anything other than a JSON object is a 400.
export async function readJson(req, { limit = MAX_BODY_BYTES } = {}) {
  let value;
  try {
    value = req.body;
  } catch {
    throw new HttpError(400, 'The request body is not valid JSON.');
  }

  let text;
  if (value === undefined || value === null) {
    text = await readStream(req, limit);
  } else if (Buffer.isBuffer(value)) {
    text = value.toString('utf8');
  } else if (typeof value === 'string') {
    text = value;
  } else {
    return asObject(value);
  }

  if (Buffer.byteLength(text) > limit) throw new HttpError(413, 'The request body is too large.');
  if (!text.trim()) return {};
  try {
    return asObject(JSON.parse(text));
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, 'The request body is not valid JSON.');
  }
}

function asObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  throw new HttpError(400, 'The request body must be a JSON object.');
}

async function readStream(req, limit) {
  // Vercel may already have drained the stream while leaving req.body undefined
  // (no Content-Type); iterating a finished stream would never yield, so stop early.
  if (typeof req[Symbol.asyncIterator] !== 'function' || req.readableEnded) return '';
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    size += buf.length;
    if (size > limit) throw new HttpError(413, 'The request body is too large.');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// fetch() + JSON with a timeout, the Sizemill User-Agent and errors that never include the
// URL. Options: method, headers, body (objects are sent as JSON), timeoutMs, fetchImpl.
// Resolves with the parsed JSON; rejects with UpstreamError on non-2xx, timeouts, network
// failures and non-JSON bodies (such as an HTML error page served with 200).
export async function fetchJson(url, opts = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = FETCH_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
  } = opts;
  const host = hostOf(url);
  const init = {
    method,
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (body !== undefined) {
    const isRaw = typeof body === 'string' || Buffer.isBuffer(body);
    init.body = isRaw ? body : JSON.stringify(body);
    if (!isRaw && !hasHeader(init.headers, 'content-type')) init.headers['Content-Type'] = 'application/json';
  }

  let response;
  let text;
  try {
    response = await fetchImpl(url, init);
    text = await response.text();
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new UpstreamError(timedOut ? `${host} timed out` : `${host} could not be reached`, {
      code: timedOut ? 'timeout' : 'network',
      host,
    });
  }

  const snippet = String(text || '').slice(0, ERROR_SNIPPET_CHARS);
  if (!response.ok) {
    throw new UpstreamError(`${host} responded ${response.status}`, {
      status: response.status,
      code: 'http',
      host,
      body: snippet,
    });
  }
  try {
    // Some feeds start with a UTF-8 byte order mark, which JSON.parse rejects.
    return JSON.parse(String(text).replace(/^﻿/, ''));
  } catch {
    throw new UpstreamError(`${host} did not return JSON`, {
      status: response.status,
      code: 'invalid_json',
      host,
      body: snippet,
    });
  }
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return 'upstream';
  }
}

function hasHeader(headers, name) {
  return Object.keys(headers).some((key) => key.toLowerCase() === name);
}

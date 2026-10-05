// Local development server for Sizemill (no dependencies): `npm run dev`.
//
// Serves public/ the way Vercel does for this project and runs api/<name>.js handlers on
// a plain node:http server:
//   - static files with correct MIME types, no directory listings, no dotfiles;
//   - a directory serves its index.html, with or without the trailing slash (so /desk
//     behaves like production, where cleanUrls serves it and index.html adds the slash);
//   - /foo serves public/foo.html when it exists (cleanUrls);
//   - the global response headers and exact-path rewrites from vercel.json;
//   - /api/<name> calls the default export of api/<name>.js with req.body left undefined,
//     so handlers read the body themselves exactly as they do on a plain Node server.
//
// Env: PORT (default 3000), HOST (default 127.0.0.1; use 0.0.0.0 to test from a phone),
// plus anything in .env.local (KEY=VALUE lines; real environment variables win).
//
// Without SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY there is nothing to verify sign-ins
// against, so the server stands in for Supabase Auth: every /api caller is treated as a
// local development user. That lets local mode (/desk/?local=1) use real routes and address
// search, through the real api/_lib/auth.js code path. With both variables set, /api auth
// behaves exactly as in production.

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PUBLIC_DIR = join(ROOT, 'public');
const API_DIR = join(ROOT, 'api');

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = '127.0.0.1';
const API_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/; // _lib and other _-prefixed files are not routes
const DEV_AUTH_PREFIX = '/__dev/supabase';
const DEV_BEARER = 'local-dev'; // sent for /api callers without a token (local mode)
const DEV_USER = Object.freeze({ id: 'local', email: 'local@device', role: 'authenticated' });

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.pdf': 'application/pdf',
};

/**
 * Reads KEY=VALUE lines (optionally `export KEY=VALUE`, quoted values, # comments) into
 * process.env without overriding variables that are already set. Returns the keys loaded.
 */
function loadEnvFile(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const loaded = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(rawLine);
    if (!match) continue;
    const [, key, rawValue] = match;
    let value = rawValue;
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else {
      value = value.replace(/\s+#.*$/, ''); // trailing comment on an unquoted value
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
      loaded.push(key);
    }
  }
  return loaded;
}

// Global headers (source "/(.*)"), exact-path redirects and exact-path rewrites from
// vercel.json, so pages behave as they do in production. Pattern rules are not emulated.
function loadVercelConfig() {
  let config = {};
  try {
    config = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[dev] Ignoring vercel.json: ${err.message}`);
  }
  const headers = (config.headers ?? [])
    .filter((rule) => rule.source === '/(.*)')
    .flatMap((rule) => rule.headers ?? []);
  const rewrites = new Map(
    (config.rewrites ?? [])
      .filter((rule) => typeof rule.source === 'string' && !/[:(*]/.test(rule.source))
      .map((rule) => [rule.source, rule.destination]),
  );
  const redirects = new Map(
    (config.redirects ?? [])
      .filter((rule) => typeof rule.source === 'string' && !/[:(*]/.test(rule.source))
      .map((rule) => [rule.source, { destination: rule.destination, status: rule.permanent ? 308 : 307 }]),
  );
  return { headers, rewrites, redirects };
}

function sendText(res, status, text, headers = {}) {
  const body = `${text}\n`;
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/** Maps a URL path to a file under public/, or null when it escapes or names a dotfile. */
function publicPath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const segments = decoded.split('/').filter(Boolean);
  if (segments.some((segment) => segment.startsWith('.'))) return null;
  const file = resolve(PUBLIC_DIR, ...segments);
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + sep)) return null;
  return file;
}

async function fileStat(path) {
  try {
    return await stat(path);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
}

// Resolves a request path to a file the way Vercel serves public/ with cleanUrls.
async function findStaticFile(pathname) {
  const base = publicPath(pathname);
  if (!base) return null;
  const candidates = [base, join(base, 'index.html')];
  if (!pathname.endsWith('/')) candidates.push(`${base}.html`);
  for (const candidate of candidates) {
    const info = await fileStat(candidate);
    if (info?.isFile()) return { path: candidate, info };
  }
  return null;
}

async function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(res, 405, 'Method not allowed.', { Allow: 'GET, HEAD' });
    return;
  }
  const found = await findStaticFile(pathname);
  if (!found) {
    sendText(res, 404, 'Not found.');
    return;
  }
  const { path, info } = found;
  // Weak validator from size and mtime: cheap, and changes whenever the file is saved.
  const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  const headers = {
    'Content-Type': MIME_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache', // always revalidate, so edits show on the next reload
    ETag: etag,
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  const body = await readFile(path);
  res.writeHead(200, { ...headers, 'Content-Length': body.length });
  res.end(req.method === 'HEAD' ? undefined : body);
}

const handlerCache = new Map(); // api name → Promise<handler | null>

function loadHandler(name) {
  if (!handlerCache.has(name)) {
    const file = join(API_DIR, `${name}.js`);
    const loading = fileStat(file).then(async (info) => {
      if (!info?.isFile()) return null;
      const module = await import(pathToFileURL(file).href);
      if (typeof module.default !== 'function') throw new Error(`api/${name}.js has no default export function.`);
      return module.default;
    });
    // A module that fails to load is retried on the next request (after the fix is saved,
    // a restart is still needed because Node caches the module graph).
    loading.catch(() => handlerCache.delete(name));
    handlerCache.set(name, loading);
  }
  return handlerCache.get(name);
}

async function serveApi(req, res, name, devAuth) {
  if (!API_NAME_PATTERN.test(name)) {
    sendJson(res, 404, { error: 'No such API endpoint.' });
    return;
  }
  const handler = await loadHandler(name);
  if (!handler) {
    sendJson(res, 404, { error: 'No such API endpoint.' });
    return;
  }
  if (devAuth && !req.headers.authorization) req.headers.authorization = `Bearer ${DEV_BEARER}`;
  await handler(req, res);
  if (!res.headersSent && !res.writableEnded) {
    console.error(`[dev] api/${name}.js finished without responding.`);
    sendJson(res, 500, { error: 'The handler did not send a response.' });
  }
}

// Stand-in for GET {SUPABASE_URL}/auth/v1/user, used by api/_lib/auth.js when no real
// Supabase credentials are configured. It checks the per-run service key that only this
// process knows, and accepts any bearer token: there are no real sessions to check, and a
// browser signed in to Supabase should reach the dev API too.
function serveDevAuth(req, res, pathname, devAuth) {
  const authorised = req.headers.apikey === devAuth.serviceKey && /^Bearer\s+\S+/i.test(req.headers.authorization ?? '');
  if (req.method === 'GET' && pathname === `${DEV_AUTH_PREFIX}/auth/v1/user` && authorised) {
    sendJson(res, 200, DEV_USER);
    return;
  }
  sendJson(res, authorised ? 404 : 401, { msg: 'Dev auth stand-in: not found or not authorised.' });
}

/**
 * Builds the dev server (not yet listening). `port` is needed up front when the Supabase
 * Auth stand-in is active, because api/_lib/auth.js calls back into this server. The stand-in
 * is configured through process.env, which is where the API handlers read it.
 */
function createDevServer({ port, log }) {
  const { headers: globalHeaders, rewrites, redirects } = loadVercelConfig();

  let devAuth = null;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    devAuth = { serviceKey: `dev-${randomBytes(16).toString('hex')}` };
    process.env.SUPABASE_URL = `http://127.0.0.1:${port}${DEV_AUTH_PREFIX}`;
    process.env.SUPABASE_SERVICE_ROLE_KEY = devAuth.serviceKey;
  }

  const server = createServer(async (req, res) => {
    const started = Date.now();
    for (const { key, value } of globalHeaders) res.setHeader(key, value);

    let { pathname, search } = new URL(req.url ?? '/', 'http://localhost');
    const redirect = redirects.get(pathname);
    if (redirect) {
      res.writeHead(redirect.status, { Location: redirect.destination + search });
      res.end();
      return;
    }
    pathname = rewrites.get(pathname) ?? pathname;
    if (log) {
      res.once('finish', () => {
        if (pathname.startsWith('/api/') || res.statusCode >= 400) {
          console.log(`[dev] ${req.method} ${req.url} → ${res.statusCode} (${Date.now() - started} ms)`);
        }
      });
    }

    try {
      if (devAuth && pathname.startsWith(`${DEV_AUTH_PREFIX}/`)) {
        serveDevAuth(req, res, pathname, devAuth);
        return;
      }
      const api = /^\/api\/([^/]+?)\/?$/.exec(pathname);
      if (api) {
        await serveApi(req, res, api[1], devAuth);
      } else if (pathname === '/api' || pathname.startsWith('/api/')) {
        sendJson(res, 404, { error: 'No such API endpoint.' });
      } else {
        await serveStatic(req, res, pathname);
      }
    } catch (err) {
      console.error(`[dev] ${req.method} ${req.url} failed:`, err);
      if (!res.headersSent) sendText(res, 500, 'Internal server error (see the dev server log).');
      else res.destroy(err);
    }
  });

  return { server, devAuth: Boolean(devAuth) };
}

/**
 * Starts the server; resolves with { server, url, devAuth, close } once it is listening.
 * devAuth is true when the Supabase Auth stand-in is active. `log` prints /api calls and
 * failed requests.
 */
export async function startDevServer({ port = DEFAULT_PORT, host = DEFAULT_HOST, log = true } = {}) {
  const { server, devAuth } = createDevServer({ port, log });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, host, () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  const shownHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  const url = `http://${shownHost}:${port}`;
  const close = () => new Promise((done) => {
    server.close(() => done());
    server.closeAllConnections();
  });
  return { server, url, devAuth, close };
}

async function main() {
  const loaded = loadEnvFile(join(ROOT, '.env.local'));
  const port = Number.parseInt(process.env.PORT ?? '', 10) || DEFAULT_PORT;
  const host = process.env.HOST || DEFAULT_HOST;

  let running;
  try {
    running = await startDevServer({ port, host });
  } catch (err) {
    console.error(err.code === 'EADDRINUSE' ? `[dev] Port ${port} is already in use. Try PORT=${port + 1} npm run dev.` : err);
    process.exit(1);
  }

  if (loaded.length) console.log(`[dev] Loaded ${loaded.join(', ')} from .env.local`);
  console.log(`[dev] Sizemill Desk:  ${running.url}/desk/`);
  console.log(`[dev] Local mode:     ${running.url}/desk/?local=1`);
  if (running.devAuth) {
    console.log('[dev] No SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY: /api treats every caller as a local dev user.');
  }

  const shutdown = async () => {
    await running.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

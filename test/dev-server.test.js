// scripts/dev-server.mjs: static files the way Vercel serves public/, /api routing, and the
// Supabase Auth stand-in that lets local mode reach the authenticated endpoints. Offline:
// every /api request here is answered before any outbound fetch.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { startDevServer } from '../scripts/dev-server.mjs';

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// node:http rather than fetch, so paths like /../x reach the server unnormalised.
function call(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

describe('dev server', () => {
  let server;
  let port;
  const saved = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };

  before(async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    port = await freePort();
    server = await startDevServer({ port, log: false });
  });

  after(async () => {
    await server?.close();
    for (const [name, value] of [['SUPABASE_URL', saved.url], ['SUPABASE_SERVICE_ROLE_KEY', saved.key]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  test('serves the Desk shell at /desk/ and, like cleanUrls, at /desk', async () => {
    for (const path of ['/desk/', '/desk', '/desk/?local=1']) {
      const res = await call(port, path);
      assert.equal(res.status, 200, path);
      assert.match(res.headers['content-type'], /^text\/html/);
      assert.match(res.text, /<title>Sizemill Desk<\/title>/);
    }
  });

  test('sends module scripts and styles with the MIME types browsers insist on', async () => {
    const script = await call(port, '/desk/app.js');
    assert.equal(script.status, 200);
    assert.match(script.headers['content-type'], /^text\/javascript/);
    const style = await call(port, '/desk/desk.css');
    assert.match(style.headers['content-type'], /^text\/css/);
  });

  test('applies the global headers from vercel.json', async () => {
    const res = await call(port, '/desk/');
    assert.equal(res.headers['x-frame-options'], 'DENY');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
  });

  test('never lists directories or serves files outside public/', async () => {
    for (const path of ['/desk/lib/', '/../package.json', '/%2e%2e/package.json', '/desk/..%2f..%2fpackage.json', '/.env.local']) {
      const res = await call(port, path);
      assert.equal(res.status, 404, path);
      assert.doesNotMatch(res.text, /"name": "sizemill"/, path);
    }
  });

  test('answers HEAD without a body, revalidates with ETag and refuses other methods', async () => {
    const head = await call(port, '/desk/app.js', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.text, '');
    const again = await call(port, '/desk/app.js', { headers: { 'If-None-Match': head.headers.etag } });
    assert.equal(again.status, 304);
    const post = await call(port, '/desk/app.js', { method: 'POST' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.allow, 'GET, HEAD');
  });

  test('routes /api/<name> to api/<name>.js and nothing else', async () => {
    for (const path of ['/api/nope', '/api/_lib/http', '/api/', '/api/fuel/extra']) {
      const res = await call(port, path);
      assert.equal(res.status, 404, path);
      assert.match(res.headers['content-type'], /^application\/json/);
    }
    const fuel = await call(port, '/api/fuel?type=XX');
    assert.equal(fuel.status, 400);
    assert.match(JSON.parse(fuel.text).error, /Fuel type must be one of/);
  });

  test('stands in for Supabase Auth, so a caller without a token reaches the handler', async () => {
    const res = await call(port, '/api/route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    // 400 comes from the handler's own validation, after requireUser() accepted the caller.
    assert.equal(res.status, 400);
    assert.match(JSON.parse(res.text).error, /Give the start as/);
  });

  test('the stand-in rejects callers without the per-run service key', async () => {
    const res = await call(port, '/__dev/supabase/auth/v1/user', { headers: { apikey: 'guess', Authorization: 'Bearer x' } });
    assert.equal(res.status, 401);
  });
});

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';

import {
  MAX_GEOMETRY_POINTS,
  parseLatLng,
  toPoint,
  isUkPostcode,
  isUkOutcode,
  normalisePostcode,
  decodePolyline,
  downsample,
  geocode,
  suggest,
  route,
} from '../api/_lib/geo.js';
import { requireUser } from '../api/_lib/auth.js';
import { HttpError, UpstreamError, allow, fetchJson, readJson, send } from '../api/_lib/http.js';
import routeHandler from '../api/route.js';
import placesHandler from '../api/places.js';

// ---- helpers ---------------------------------------------------------------------------

const fixtureText = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const fixture = (name) => JSON.parse(fixtureText(name));

const POSTCODE_SO14_3JA = fixture('geo/postcodes.io-SO14-3JA.json');
const OUTCODE_SO14 = fixture('geo/postcodes.io-outcode-SO14.json');
const POSTCODE_QUERY_SO14_3 = fixture('geo/postcodes.io-query-SO14-3.json');
const NOMINATIM_ST_MARYS = fixture('geo/nominatim-st-marys-stadium.json');
const NOMINATIM_DOWNING = fixture('geo/nominatim-downing-street.json');
const NOMINATIM_429 = fixtureText('geo/nominatim-429.html');
const OSRM_LONDON_SOUTHAMPTON = fixture('geo/osrm-london-southampton.json');

const LONDON = { lat: 51.5072, lng: -0.1276 };
const SOUTHAMPTON = { lat: 50.9097, lng: -1.4044 };
const UA = 'Sizemill/1.0 (+https://www.sizemill.com)';
const GOOGLE_KEY = 'test-google-key-123';

// Documented Google response shapes (no key was available to record real ones). The
// polyline is Google's own example from the Encoded Polyline Algorithm Format page.
const GOOGLE_ROUTE = {
  routes: [{ distanceMeters: 128748, duration: '6543s', polyline: { encodedPolyline: '_p~iF~ps|U_ulLnnqC_mqNvxq`@' } }],
};
const GOOGLE_GEOCODE = {
  status: 'OK',
  results: [{
    formatted_address: 'Staplewood Ln, Marchwood, Southampton SO40 4WE, UK',
    geometry: { location: { lat: 50.8879, lng: -1.4589 } },
    address_components: [{ long_name: 'SO40 4WE', short_name: 'SO40 4WE', types: ['postal_code'] }],
  }],
};
const GOOGLE_PLACES = {
  places: [{
    displayName: { text: 'Staplewood Campus', languageCode: 'en' },
    formattedAddress: 'Staplewood Ln, Marchwood, Southampton SO40 4WE, UK',
    location: { latitude: 50.8879, longitude: -1.4589 },
  }],
};
const GOOGLE_DENIED = { error: { code: 403, message: 'Routes API has not been used in this project.', status: 'PERMISSION_DENIED' } };

const json = (body, status = 200) => ({ status, body: JSON.stringify(body), type: 'application/json' });
const html = (body, status) => ({ status, body, type: 'text/html' });

// A fetch double driven by respond(url, init) -> { status, body, type } | Error | undefined.
// Undefined (an unexpected URL) fails like a network error.
function fakeFetch(respond) {
  const calls = [];
  const impl = async (input, init = {}) => {
    const url = String(input);
    let body;
    try {
      body = init.body ? JSON.parse(init.body) : undefined;
    } catch {
      body = init.body;
    }
    calls.push({ url, init, body });
    const spec = await respond(url, init);
    if (spec instanceof Error) throw spec;
    if (!spec) throw new TypeError('fetch failed');
    return new Response(spec.body, { status: spec.status ?? 200, headers: { 'content-type': spec.type ?? 'application/json' } });
  };
  impl.calls = calls;
  return impl;
}

const isNominatim = (url) => url.startsWith('https://nominatim.openstreetmap.org/search?');
const isOsrm = (url) => url.startsWith('https://router.project-osrm.org/route/v1/driving/');

function quietly(t) {
  return t.mock.method(console, 'warn', () => {});
}

function mockRes() {
  const headers = {};
  return {
    statusCode: 200,
    headers,
    body: '',
    writableEnded: false,
    setHeader(name, value) {
      headers[name.toLowerCase()] = value;
    },
    end(chunk = '') {
      this.body = String(chunk);
      this.writableEnded = true;
    },
    json() {
      return JSON.parse(this.body);
    },
  };
}

function jwt(payload) {
  const part = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part(payload)}.signature`;
}

// ---- parsing and validation ------------------------------------------------------------

describe('parseLatLng', () => {
  test('reads "lat,lng" in the forms people paste', () => {
    assert.deepEqual(parseLatLng('50.9,-1.4'), { lat: 50.9, lng: -1.4 });
    assert.deepEqual(parseLatLng(' 50.9097, -1.4044 '), { lat: 50.9097, lng: -1.4044 });
    assert.deepEqual(parseLatLng('(51.5072, -0.1276)'), { lat: 51.5072, lng: -0.1276 });
    assert.deepEqual(parseLatLng('+51,-1'), { lat: 51, lng: -1 });
    assert.deepEqual(parseLatLng('-90,180'), { lat: -90, lng: 180 });
  });

  test('rejects out-of-range and non-coordinate text', () => {
    for (const bad of ['91,0', '0,181', '-90.1,0', '50.9', '50.9 -1.4', 'SO14 3JA', 'abc,def', '1,2,3', '', null, undefined, 50.9]) {
      assert.equal(parseLatLng(bad), null, String(bad));
    }
  });
});

describe('toPoint', () => {
  test('accepts numbers and numeric strings in range', () => {
    assert.deepEqual(toPoint({ lat: 50.9, lng: -1.4 }), { lat: 50.9, lng: -1.4 });
    assert.deepEqual(toPoint({ lat: '50.9', lng: '-1.4', label: 'x' }), { lat: 50.9, lng: -1.4 });
  });

  test('rejects anything else', () => {
    for (const bad of [null, 'x', {}, { lat: 91, lng: 0 }, { lat: 0, lng: -180.5 }, { lat: NaN, lng: 0 },
      { lat: '', lng: 0 }, { lat: true, lng: 0 }, { lat: 'abc', lng: 0 }, { lat: Infinity, lng: 0 }]) {
      assert.equal(toPoint(bad), null, JSON.stringify(bad));
    }
  });
});

describe('UK postcodes', () => {
  test('isUkPostcode accepts every postcode format, any case and spacing', () => {
    for (const ok of ['SO14 3JA', 'so143ja', '  SO14   3JA ', 'M1 1AE', 'B33 8TH', 'CR2 6XH', 'DN55 1PT', 'W1A 0AX', 'EC1A 1BB', 'SW1A 2AA', 'GIR 0AA']) {
      assert.equal(isUkPostcode(ok), true, ok);
    }
  });

  test('isUkPostcode rejects partial or malformed postcodes', () => {
    for (const bad of ['SO14', 'SO14 3J', 'SO14 3JAA', 'SO14-3JA', '12345', '1SO 4JA', 'Southampton', '', null, undefined]) {
      assert.equal(isUkPostcode(bad), false, String(bad));
    }
  });

  test('isUkOutcode accepts districts only', () => {
    for (const ok of ['SO14', 'so14', ' M1 ', 'SW1A', 'EC1A', 'B7']) assert.equal(isUkOutcode(ok), true, ok);
    for (const bad of ['SO14 3JA', 'SO', '14', 'SO145', 'Southampton', '', null]) assert.equal(isUkOutcode(bad), false, String(bad));
  });

  test('normalisePostcode formats with a single space', () => {
    assert.equal(normalisePostcode('so143ja'), 'SO14 3JA');
    assert.equal(normalisePostcode(' sw1a  2aa '), 'SW1A 2AA');
    assert.equal(normalisePostcode('m11ae'), 'M1 1AE');
    assert.equal(normalisePostcode('SO14'), null);
  });
});

describe('decodePolyline', () => {
  test("decodes Google's documented example", () => {
    assert.deepEqual(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@'), [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]);
  });

  test('handles empty input and rejects truncated input', () => {
    assert.deepEqual(decodePolyline(''), []);
    assert.deepEqual(decodePolyline(undefined), []);
    assert.throws(() => decodePolyline('_p~iF~ps'), /Malformed/);
  });
});

describe('downsample', () => {
  const line = (n) => Array.from({ length: n }, (_, i) => [i, -i]);

  test('keeps short lines as they are (as a copy)', () => {
    const points = line(MAX_GEOMETRY_POINTS);
    const out = downsample(points);
    assert.deepEqual(out, points);
    assert.notEqual(out, points);
  });

  test('thins long lines to at most 400 evenly spaced points, keeping both ends', () => {
    for (const n of [401, 1000, 12345]) {
      const out = downsample(line(n));
      assert.equal(out.length, MAX_GEOMETRY_POINTS, `n=${n}`);
      assert.deepEqual(out[0], [0, -0]);
      assert.deepEqual(out.at(-1), [n - 1, -(n - 1)]);
      for (let i = 1; i < out.length; i++) assert.ok(out[i][0] > out[i - 1][0], 'strictly increasing, no repeats');
    }
  });

  test('honours a custom maximum and bad input', () => {
    assert.deepEqual(downsample(line(10), 2), [[0, -0], [9, -9]]);
    assert.deepEqual(downsample(line(10), 1), [[0, -0]]);
    assert.deepEqual(downsample(null), []);
  });
});

// ---- geocode ---------------------------------------------------------------------------

describe('geocode', () => {
  test('resolves a full postcode through postcodes.io', async () => {
    const fetchImpl = fakeFetch((url) => (url === 'https://api.postcodes.io/postcodes/SO14%203JA' ? json(POSTCODE_SO14_3JA) : undefined));
    const place = await geocode('so14 3ja', { fetchImpl, googleKey: '' });
    assert.deepEqual(place, {
      label: 'SO14 3JA',
      address: 'Bargate, Southampton SO14 3JA',
      lat: 50.89742,
      lng: -1.390705,
      postcode: 'SO14 3JA',
      source: 'postcodes.io',
    });
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(fetchImpl.calls[0].init.headers['User-Agent'], UA);

    // Cached: a second lookup (any spacing or case) makes no request.
    const again = await geocode('  SO14 3JA ', { fetchImpl, googleKey: '' });
    assert.deepEqual(again, place);
    assert.equal(fetchImpl.calls.length, 1);
  });

  test('resolves an outcode to its district centre', async () => {
    const fetchImpl = fakeFetch((url) => (url === 'https://api.postcodes.io/outcodes/SO14' ? json(OUTCODE_SO14) : undefined));
    const place = await geocode('so14', { fetchImpl, googleKey: '' });
    assert.equal(place.label, 'SO14');
    assert.equal(place.address, 'Southampton SO14');
    assert.equal(place.postcode, null);
    assert.ok(Math.abs(place.lat - 50.90719) < 1e-4 && Math.abs(place.lng - -1.39739) < 1e-4);
  });

  test('returns coordinates as typed without any request', async () => {
    const fetchImpl = fakeFetch(() => undefined);
    const place = await geocode('50.9097, -1.4044', { fetchImpl });
    assert.deepEqual(place, { label: '50.90970, -1.40440', address: '50.90970, -1.40440', lat: 50.9097, lng: -1.4044, postcode: null, source: 'coordinates' });
    assert.equal(fetchImpl.calls.length, 0);
  });

  test('uses a postcode inside a longer address before searching the text', async () => {
    const fetchImpl = fakeFetch((url) => (url === 'https://api.postcodes.io/postcodes/SO14%203JA' ? json(POSTCODE_SO14_3JA) : undefined));
    const place = await geocode('Flat 4, 21 Above Bar Street, Southampton SO143JA', { fetchImpl, googleKey: '' });
    assert.equal(place.label, 'Flat 4');
    assert.equal(place.address, 'Flat 4, 21 Above Bar Street, Southampton SO143JA');
    assert.equal(place.lat, 50.89742);
    assert.equal(place.source, 'postcodes.io');
    assert.equal(fetchImpl.calls.length, 1);
  });

  test('falls back to one Nominatim search for places without a postcode', async () => {
    const fetchImpl = fakeFetch((url) => (isNominatim(url) ? json(NOMINATIM_ST_MARYS) : undefined));
    const place = await geocode("St Mary's Stadium, Southampton", { fetchImpl, googleKey: '' });
    assert.deepEqual(place, {
      label: "St. Mary's Stadium",
      address: "St. Mary's Stadium, Britannia Road, Belvidere, Northam, Southampton, England, SO14 5FP",
      lat: 50.9058615,
      lng: -1.3908774,
      postcode: 'SO14 5FP',
      source: 'nominatim',
    });
    assert.equal(fetchImpl.calls.length, 1);
    const url = new URL(fetchImpl.calls[0].url);
    assert.equal(url.searchParams.get('format'), 'jsonv2');
    assert.equal(url.searchParams.get('countrycodes'), 'gb');
    assert.equal(url.searchParams.get('limit'), '1');
    assert.equal(url.searchParams.get('q'), "St Mary's Stadium, Southampton");
    assert.equal(fetchImpl.calls[0].init.headers['User-Agent'], UA);
  });

  test('searches the text when a postcode is unknown to postcodes.io (new builds)', async () => {
    const fetchImpl = fakeFetch((url) => {
      if (url.startsWith('https://api.postcodes.io/postcodes/')) return json({ status: 404, error: 'Postcode not found' }, 404);
      if (isNominatim(url)) return json(NOMINATIM_DOWNING);
      return undefined;
    });
    const place = await geocode('10 Downing Street, London SW1A 2AB', { fetchImpl, googleKey: '' });
    assert.equal(place.source, 'nominatim');
    assert.equal(place.label, '10 Downing Street');
    assert.equal(place.postcode, 'SW1A 2AA');
    assert.equal(fetchImpl.calls.length, 2);
  });

  test('uses Google Geocoding when a key is set, restricted to the UK', async () => {
    const fetchImpl = fakeFetch((url) => (url.startsWith('https://maps.googleapis.com/maps/api/geocode/json?') ? json(GOOGLE_GEOCODE) : undefined));
    const place = await geocode('Staplewood, Marchwood', { fetchImpl, googleKey: GOOGLE_KEY });
    assert.deepEqual(place, {
      label: 'Staplewood Ln',
      address: 'Staplewood Ln, Marchwood, Southampton SO40 4WE',
      lat: 50.8879,
      lng: -1.4589,
      postcode: 'SO40 4WE',
      source: 'google',
    });
    const url = new URL(fetchImpl.calls[0].url);
    assert.equal(url.searchParams.get('components'), 'country:GB');
    assert.equal(url.searchParams.get('key'), GOOGLE_KEY);
  });

  test('falls back from a failing Google key to Nominatim without leaking the key', async (t) => {
    const warn = quietly(t);
    const fetchImpl = fakeFetch((url) => {
      if (url.includes('maps.googleapis.com')) return json({ status: 'REQUEST_DENIED', error_message: 'The provided API key is invalid.', results: [] });
      if (isNominatim(url)) return json(NOMINATIM_ST_MARYS);
      return undefined;
    });
    const place = await geocode('St Marys football ground', { fetchImpl, googleKey: GOOGLE_KEY });
    assert.equal(place.source, 'nominatim');
    assert.equal(warn.mock.callCount(), 1);
    assert.ok(!warn.mock.calls[0].arguments.join(' ').includes(GOOGLE_KEY));
  });

  test('resolves null when nothing matches', async () => {
    const fetchImpl = fakeFetch((url) => (isNominatim(url) ? json([]) : undefined));
    assert.equal(await geocode('Nowhere Lane, Atlantis', { fetchImpl, googleKey: '' }), null);
    assert.equal(await geocode('   ', { fetchImpl }), null);
  });

  test('reports an outage as a 502, not as "not found"', async (t) => {
    quietly(t);
    const fetchImpl = fakeFetch((url) => (isNominatim(url) ? html(NOMINATIM_429, 429) : undefined));
    await assert.rejects(geocode('Training ground, Marchwood', { fetchImpl, googleKey: '' }), (err) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.status, 502);
      assert.match(err.message, /isn't responding/);
      return true;
    });
  });

  test('survives postcodes.io being down by asking Nominatim', async (t) => {
    quietly(t);
    const fetchImpl = fakeFetch((url) => {
      if (url.startsWith('https://api.postcodes.io/')) return html('<html>Bad gateway</html>', 502);
      if (isNominatim(url)) return json(NOMINATIM_ST_MARYS);
      return undefined;
    });
    const place = await geocode('SO14 5FP', { fetchImpl, googleKey: '' });
    assert.equal(place.source, 'nominatim');
    assert.equal(place.postcode, 'SO14 5FP');
  });
});

// ---- suggest ---------------------------------------------------------------------------

describe('suggest', () => {
  test('autocompletes postcode-like text through postcodes.io', async () => {
    const fetchImpl = fakeFetch((url) => (url === 'https://api.postcodes.io/postcodes?q=SO14%203&limit=6' ? json(POSTCODE_QUERY_SO14_3) : undefined));
    const results = await suggest('SO14 3', { fetchImpl, googleKey: GOOGLE_KEY });
    assert.equal(results.length, 4);
    assert.deepEqual(Object.keys(results[0]), ['label', 'address', 'lat', 'lng', 'source']);
    assert.equal(results[0].label, 'SO14 3AB');
    assert.match(results[0].address, /Southampton SO14 3AB$/);
    assert.equal(results[0].source, 'postcodes.io');
    assert.equal(fetchImpl.calls.length, 1, 'Google is not needed');
  });

  test('offers the district first for a bare outcode', async () => {
    const fetchImpl = fakeFetch((url) => {
      if (url === 'https://api.postcodes.io/outcodes/SO14') return json(OUTCODE_SO14);
      if (url === 'https://api.postcodes.io/postcodes?q=SO14&limit=6') return json(POSTCODE_QUERY_SO14_3);
      return undefined;
    });
    const results = await suggest('SO14', { fetchImpl, googleKey: '' });
    assert.equal(results[0].label, 'SO14');
    assert.equal(results.length, 5);
  });

  test('searches places when postcode-like text matches no postcode (roads such as A303)', async () => {
    const fetchImpl = fakeFetch((url) => {
      if (url.startsWith('https://api.postcodes.io/postcodes?q=')) return json({ status: 200, result: null });
      if (isNominatim(url)) return json(NOMINATIM_DOWNING);
      return undefined;
    });
    const results = await suggest('A303', { fetchImpl, googleKey: '' });
    assert.equal(results[0].source, 'nominatim');
    assert.equal(new URL(fetchImpl.calls.at(-1).url).searchParams.get('limit'), '6');
  });

  test('uses Google Places Text Search when a key is set', async () => {
    const fetchImpl = fakeFetch((url) => (url === 'https://places.googleapis.com/v1/places:searchText' ? json(GOOGLE_PLACES) : undefined));
    const results = await suggest('Staplewood training ground', { fetchImpl, googleKey: GOOGLE_KEY });
    assert.deepEqual(results, [{
      label: 'Staplewood Campus',
      address: 'Staplewood Ln, Marchwood, Southampton SO40 4WE',
      lat: 50.8879,
      lng: -1.4589,
      source: 'google',
    }]);
    const [call] = fetchImpl.calls;
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.headers['X-Goog-Api-Key'], GOOGLE_KEY);
    assert.equal(call.init.headers['X-Goog-FieldMask'], 'places.displayName,places.formattedAddress,places.location');
    assert.equal(call.body.textQuery, 'Staplewood training ground');
    assert.equal(call.body.regionCode, 'GB');
    assert.equal(call.body.pageSize, 6);
    assert.ok(call.body.locationRestriction.rectangle);
  });

  test("trusts Google's empty answer and does not hit Nominatim", async () => {
    const fetchImpl = fakeFetch((url) => (url.startsWith('https://places.googleapis.com/') ? json({}) : undefined));
    assert.deepEqual(await suggest('qqqq zzzz', { fetchImpl, googleKey: GOOGLE_KEY }), []);
    assert.equal(fetchImpl.calls.length, 1);
  });

  test('falls back to Nominatim when Google fails', async (t) => {
    quietly(t);
    const fetchImpl = fakeFetch((url) => {
      if (url.startsWith('https://places.googleapis.com/')) return json(GOOGLE_DENIED, 403);
      if (isNominatim(url)) return json(NOMINATIM_ST_MARYS);
      return undefined;
    });
    const results = await suggest('St Marys Southampton', { fetchImpl, googleKey: GOOGLE_KEY });
    assert.equal(results.length, 1);
    assert.equal(results[0].source, 'nominatim');
  });

  test('needs three characters and returns at most six results', async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ ...NOMINATIM_ST_MARYS[0], place_id: i, name: `Place ${i}` }));
    const fetchImpl = fakeFetch((url) => (isNominatim(url) ? json(many) : undefined));
    assert.deepEqual(await suggest('ab', { fetchImpl, googleKey: '' }), []);
    assert.equal(fetchImpl.calls.length, 0);
    assert.equal((await suggest('Southampton parks', { fetchImpl, googleKey: '' })).length, 6);
  });

  test('throws 502 when the search provider is down', async (t) => {
    quietly(t);
    const fetchImpl = fakeFetch((url) => (isNominatim(url) ? html(NOMINATIM_429, 429) : undefined));
    await assert.rejects(suggest('Hedge End', { fetchImpl, googleKey: '' }), { status: 502 });
  });

  test("spaces Nominatim requests a second apart (usage policy) and refuses long queues", async () => {
    const fetchImpl = fakeFetch((url) => (isNominatim(url) ? json(NOMINATIM_ST_MARYS) : undefined));
    const started = Date.now();
    await suggest('Eastleigh', { fetchImpl, googleKey: '' });
    await suggest('Chandlers Ford', { fetchImpl, googleKey: '' });
    assert.ok(Date.now() - started >= 1000, 'second request waited');

    const queue = ['Totton', 'Romsey', 'Hythe', 'Fareham', 'Botley'].map((q) => suggest(q, { fetchImpl, googleKey: '' }));
    const settled = await Promise.allSettled(queue);
    const busy = settled.filter((r) => r.status === 'rejected');
    assert.ok(busy.length >= 1);
    assert.equal(busy[0].reason.status, 503);
  });
});

// ---- route -----------------------------------------------------------------------------

describe('route', () => {
  test('routes with OSRM when there is no Google key', async () => {
    const fetchImpl = fakeFetch((url) => (isOsrm(url) ? json(OSRM_LONDON_SOUTHAMPTON) : undefined));
    const result = await route(LONDON, SOUTHAMPTON, { fetchImpl, googleKey: '' });
    assert.equal(result.provider, 'osrm');
    assert.equal(result.traffic, false);
    assert.equal(result.miles, 80.03); // 128799.2 m
    assert.equal(result.minutes, 109.5); // 6568.9 s
    assert.equal(result.geometry.length, OSRM_LONDON_SOUTHAMPTON.routes[0].geometry.coordinates.length);
    assert.deepEqual(result.geometry[0], [51.50719, -0.1276]);
    assert.deepEqual(result.geometry.at(-1), [50.90969, -1.40479]);
    assert.equal(
      fetchImpl.calls[0].url,
      'https://router.project-osrm.org/route/v1/driving/-0.1276,51.5072;-1.4044,50.9097?overview=simplified&geometries=geojson',
    );
  });

  test('uses the traffic-aware Google Routes API when a key is set', async () => {
    const fetchImpl = fakeFetch((url) => (url === 'https://routes.googleapis.com/directions/v2:computeRoutes' ? json(GOOGLE_ROUTE) : undefined));
    const result = await route(LONDON, SOUTHAMPTON, { fetchImpl, googleKey: GOOGLE_KEY });
    assert.deepEqual(result, {
      miles: 80,
      minutes: 109.1,
      geometry: [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]],
      provider: 'google',
      traffic: true,
    });
    const [call] = fetchImpl.calls;
    assert.equal(call.init.headers['X-Goog-Api-Key'], GOOGLE_KEY);
    assert.equal(call.init.headers['X-Goog-FieldMask'], 'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline');
    assert.equal(call.body.travelMode, 'DRIVE');
    assert.equal(call.body.routingPreference, 'TRAFFIC_AWARE');
    assert.deepEqual(call.body.origin, { location: { latLng: { latitude: 51.5072, longitude: -0.1276 } } });
    assert.deepEqual(call.body.destination, { location: { latLng: { latitude: 50.9097, longitude: -1.4044 } } });
  });

  test('falls back to OSRM when Google fails', async (t) => {
    const warn = quietly(t);
    for (const googleAnswer of [json(GOOGLE_DENIED, 403), json({}), new TypeError('fetch failed'), html('<html>oops</html>', 200)]) {
      const fetchImpl = fakeFetch((url) => {
        if (url.startsWith('https://routes.googleapis.com/')) return googleAnswer;
        if (isOsrm(url)) return json(OSRM_LONDON_SOUTHAMPTON);
        return undefined;
      });
      const result = await route(LONDON, SOUTHAMPTON, { fetchImpl, googleKey: GOOGLE_KEY });
      assert.equal(result.provider, 'osrm');
      assert.equal(result.traffic, false);
      assert.equal(result.miles, 80.03);
      assert.equal(fetchImpl.calls.length, 2);
    }
    assert.equal(warn.mock.callCount(), 4);
    for (const call of warn.mock.calls) assert.ok(!call.arguments.join(' ').includes(GOOGLE_KEY));
  });

  test('downsamples long geometries to 400 points', async () => {
    const coordinates = Array.from({ length: 2500 }, (_, i) => [-0.1276 - i * 0.0005, 51.5072 - i * 0.0002]);
    const body = { code: 'Ok', routes: [{ distance: 100000, duration: 5000, geometry: { coordinates } }] };
    const fetchImpl = fakeFetch((url) => (isOsrm(url) ? json(body) : undefined));
    const result = await route(LONDON, SOUTHAMPTON, { fetchImpl, googleKey: '' });
    assert.equal(result.geometry.length, MAX_GEOMETRY_POINTS);
    assert.deepEqual(result.geometry[0], [51.5072, -0.1276]);
  });

  test('a 502 when no provider can route', async (t) => {
    quietly(t);
    const down = fakeFetch(() => html('<html>Service Unavailable</html>', 503));
    await assert.rejects(route(LONDON, SOUTHAMPTON, { fetchImpl: down, googleKey: GOOGLE_KEY }), (err) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.status, 502);
      assert.match(err.message, /Enter the miles and minutes yourself/);
      return true;
    });

    const noRoute = fakeFetch(() => json({ code: 'NoRoute', message: 'Impossible route between points', routes: [] }, 400));
    await assert.rejects(route(LONDON, SOUTHAMPTON, { fetchImpl: noRoute, googleKey: '' }), (err) => {
      assert.equal(err.status, 502);
      assert.match(err.message, /no driving route/);
      return true;
    });
  });

  test('rejects invalid points before any request', async () => {
    const fetchImpl = fakeFetch(() => undefined);
    await assert.rejects(route({ lat: 95, lng: 0 }, SOUTHAMPTON, { fetchImpl }), { status: 400 });
    await assert.rejects(route(LONDON, null, { fetchImpl }), { status: 400 });
    assert.equal(fetchImpl.calls.length, 0);
  });
});

// ---- auth ------------------------------------------------------------------------------

describe('requireUser', () => {
  const env = { SUPABASE_URL: 'https://example.supabase.co/', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key' };
  const NOW = Date.parse('2026-10-05T10:00:00Z');
  const reqWith = (authorization) => ({ headers: authorization === undefined ? {} : { authorization } });
  const supabase = (respond) => fakeFetch((url, init) => (url === 'https://example.supabase.co/auth/v1/user' ? respond(init) : undefined));
  const validUser = () => json({ id: 'user-1', email: 'owner@sizemill.com', role: 'authenticated', aud: 'authenticated' });

  test('verifies the bearer token with Supabase and returns the user', async () => {
    const fetchImpl = supabase(validUser);
    const token = jwt({ sub: 'user-1', exp: NOW / 1000 + 3600 });
    const user = await requireUser(reqWith(`Bearer ${token}`), { fetchImpl, env, now: NOW });
    assert.deepEqual(user, { id: 'user-1', email: 'owner@sizemill.com', role: 'authenticated' });
    const { init } = fetchImpl.calls[0];
    assert.equal(init.headers.apikey, 'service-role-key');
    assert.equal(init.headers.Authorization, `Bearer ${token}`);
  });

  test('caches a verified token for five minutes', async () => {
    const fetchImpl = supabase(validUser);
    const token = jwt({ sub: 'user-1', exp: NOW / 1000 + 3600, session_id: 'cache-test' });
    await requireUser(reqWith(`Bearer ${token}`), { fetchImpl, env, now: NOW });
    await requireUser(reqWith(`bearer ${token}`), { fetchImpl, env, now: NOW + 4 * 60 * 1000 });
    assert.equal(fetchImpl.calls.length, 1, 'cache hit');
    await requireUser(reqWith(`Bearer ${token}`), { fetchImpl, env, now: NOW + 5 * 60 * 1000 + 1 });
    assert.equal(fetchImpl.calls.length, 2, 'expired from cache');
  });

  test("never caches past the token's own expiry", async () => {
    const fetchImpl = supabase(validUser);
    const token = jwt({ sub: 'user-1', exp: NOW / 1000 + 60 });
    await requireUser(reqWith(`Bearer ${token}`), { fetchImpl, env, now: NOW });
    await requireUser(reqWith(`Bearer ${token}`), { fetchImpl, env, now: NOW + 59 * 1000 });
    assert.equal(fetchImpl.calls.length, 1);
    await requireUser(reqWith(`Bearer ${token}`), { fetchImpl, env, now: NOW + 61 * 1000 });
    assert.equal(fetchImpl.calls.length, 2);
  });

  test('caches by SHA-256, so an opaque token also works', async () => {
    const fetchImpl = supabase(validUser);
    const token = createHash('sha256').update('opaque').digest('hex');
    await requireUser(reqWith(`Bearer ${token}`), { fetchImpl, env, now: NOW });
    await requireUser(reqWith(`Bearer ${token}`), { fetchImpl, env, now: NOW + 1000 });
    assert.equal(fetchImpl.calls.length, 1);
  });

  test('401 for missing, malformed or rejected tokens (and rejections are not cached)', async () => {
    const fetchImpl = supabase(() => json({ code: 403, error_code: 'bad_jwt', msg: 'invalid JWT: unable to parse or verify signature' }, 403));
    for (const header of [undefined, '', 'Bearer', 'Basic dXNlcjpwYXNz', 'Bearer a b']) {
      await assert.rejects(requireUser(reqWith(header), { fetchImpl, env, now: NOW }), { status: 401 }, String(header));
    }
    assert.equal(fetchImpl.calls.length, 0);

    for (let i = 0; i < 2; i++) {
      await assert.rejects(requireUser(reqWith('Bearer forged.token.here'), { fetchImpl, env, now: NOW }), (err) => {
        assert.ok(err instanceof HttpError);
        assert.equal(err.status, 401);
        assert.match(err.message, /Sign in again/);
        return true;
      });
    }
    assert.equal(fetchImpl.calls.length, 2);

    const noUser = supabase(() => json({}));
    await assert.rejects(requireUser(reqWith('Bearer empty.user.token'), { fetchImpl: noUser, env, now: NOW }), { status: 401 });
  });

  test('502 when Supabase is unreachable or failing', async () => {
    for (const answer of [new TypeError('fetch failed'), json({ msg: 'boom' }, 500), json({ msg: 'slow down' }, 429)]) {
      const fetchImpl = supabase(() => answer);
      await assert.rejects(requireUser(reqWith('Bearer some.token.value'), { fetchImpl, env, now: NOW }), { status: 502 });
    }
  });

  test('500 naming the problem when the server is misconfigured', async (t) => {
    t.mock.method(console, 'error', () => {});
    await assert.rejects(requireUser(reqWith('Bearer x'), { env: {} }), (err) => {
      assert.equal(err.status, 500);
      assert.match(err.message, /SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY/);
      return true;
    });
    await assert.rejects(requireUser(reqWith('Bearer x'), { env: { SUPABASE_URL: 'https://x.supabase.co' } }), (err) => {
      assert.equal(err.status, 500);
      assert.match(err.message, /variable SUPABASE_SERVICE_ROLE_KEY\. Add it/);
      return true;
    });

    const badKey = supabase(() => json({ message: 'Invalid API key', hint: 'Double check your Supabase `anon` or `service_role` API key.' }, 401));
    await assert.rejects(requireUser(reqWith('Bearer valid.looking.token'), { fetchImpl: badKey, env, now: NOW }), (err) => {
      assert.equal(err.status, 500);
      assert.match(err.message, /SUPABASE_SERVICE_ROLE_KEY/);
      assert.ok(!err.message.includes('service-role-key'), 'never echoes the key');
      return true;
    });
  });
});

// ---- http helpers ----------------------------------------------------------------------

describe('http helpers', () => {
  test('send writes JSON with no-store by default', () => {
    const res = mockRes();
    send(res, 201, { ok: true, name: '£' });
    assert.equal(res.statusCode, 201);
    assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['content-length'], Buffer.byteLength(res.body));
    assert.deepEqual(res.json(), { ok: true, name: '£' });

    const cached = mockRes();
    send(cached, 200, {}, { 'Cache-Control': 'public, s-maxage=60' });
    assert.equal(cached.headers['cache-control'], 'public, s-maxage=60');
  });

  test('allow answers 405 with an Allow header', () => {
    const res = mockRes();
    assert.equal(allow({ method: 'DELETE' }, res, ['GET', 'POST']), false);
    assert.equal(res.statusCode, 405);
    assert.equal(res.headers.allow, 'GET, POST');
    assert.match(res.json().error, /GET or POST/);
    assert.equal(allow({ method: 'GET' }, mockRes(), ['GET']), true);
  });

  test('readJson takes a body Vercel already parsed (object, string or Buffer)', async () => {
    assert.deepEqual(await readJson({ body: { a: 1 } }), { a: 1 });
    assert.deepEqual(await readJson({ body: '{"a":2}' }), { a: 2 });
    assert.deepEqual(await readJson({ body: Buffer.from('{"a":3}') }), { a: 3 });
    assert.deepEqual(await readJson({ body: '' }), {});
  });

  test('readJson consumes the stream on a plain node:http request', async () => {
    const req = Readable.from([Buffer.from('{"origin":'), Buffer.from('{"lat":1,"lng":2}}')]);
    assert.deepEqual(await readJson(req), { origin: { lat: 1, lng: 2 } });
    assert.deepEqual(await readJson(Readable.from([])), {});
  });

  test('readJson rejects malformed, non-object and oversized bodies', async () => {
    const vercelInvalid = {};
    Object.defineProperty(vercelInvalid, 'body', { get() { throw new Error('Invalid JSON'); } });
    const cases = [
      [vercelInvalid, 400],
      [{ body: '{nope' }, 400],
      [{ body: [1, 2] }, 400],
      [{ body: '"text"' }, 400],
      [Readable.from([Buffer.from('null')]), 400],
      [Readable.from([Buffer.alloc(70 * 1024, 0x20)]), 413],
      [{ body: 'x'.repeat(70 * 1024) }, 413],
    ];
    for (const [req, status] of cases) await assert.rejects(readJson(req), { status });
  });

  test('fetchJson errors carry the status and host but never the URL', async () => {
    const forbidden = fakeFetch(() => html('<h1>Forbidden</h1>', 403));
    await assert.rejects(fetchJson('https://maps.googleapis.com/maps/api/geocode/json?address=x&key=SECRET', { fetchImpl: forbidden }), (err) => {
      assert.ok(err instanceof UpstreamError);
      assert.equal(err.status, 403);
      assert.equal(err.code, 'http');
      assert.equal(err.message, 'maps.googleapis.com responded 403');
      return true;
    });

    const htmlOk = fakeFetch(() => html('<!DOCTYPE html><p>Maintenance</p>', 200));
    await assert.rejects(fetchJson('https://example.com/data.json', { fetchImpl: htmlOk }), { code: 'invalid_json', status: 200 });

    const offline = fakeFetch(() => new TypeError('fetch failed'));
    await assert.rejects(fetchJson('https://example.com/x', { fetchImpl: offline }), { code: 'network', status: 0 });
  });

  test('fetchJson times out', async () => {
    const hang = (url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
    // AbortSignal.timeout() does not keep the process alive (a real socket would).
    const keepAlive = setTimeout(() => {}, 1000);
    try {
      await assert.rejects(fetchJson('https://example.com/slow', { fetchImpl: hang, timeoutMs: 20 }), { code: 'timeout', message: 'example.com timed out' });
    } finally {
      clearTimeout(keepAlive);
    }
  });

  test('fetchJson sends JSON bodies and strips a byte order mark', async () => {
    const echo = fakeFetch((url, init) => json({ got: JSON.parse(init.body), type: init.headers['Content-Type'] }));
    assert.deepEqual(await fetchJson('https://example.com/', { method: 'POST', body: { a: 1 }, fetchImpl: echo }), { got: { a: 1 }, type: 'application/json' });
    const bom = fakeFetch(() => ({ body: '﻿{"ok":true}' }));
    assert.deepEqual(await fetchJson('https://example.com/', { fetchImpl: bom }), { ok: true });
  });
});

// ---- POST /api/route and GET /api/places on a plain node:http server -------------------

describe('route and places handlers', () => {
  const realFetch = globalThis.fetch;
  const savedEnv = { ...process.env };
  const GOOD_TOKEN = jwt({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) + 3600 });
  let server;
  let base;
  let osrm = () => json(OSRM_LONDON_SOUTHAMPTON);

  const upstream = fakeFetch((url, init) => {
    if (url === 'https://example.supabase.co/auth/v1/user') {
      return init.headers.Authorization === `Bearer ${GOOD_TOKEN}`
        ? json({ id: 'user-1', email: 'owner@sizemill.com' })
        : json({ code: 403, error_code: 'bad_jwt', msg: 'invalid JWT' }, 403);
    }
    if (url === 'https://api.postcodes.io/postcodes/SO14%203JA') return json(POSTCODE_SO14_3JA);
    if (url.startsWith('https://api.postcodes.io/postcodes?q=')) return json(POSTCODE_QUERY_SO14_3);
    if (isNominatim(url)) return json(new URL(url).searchParams.get('q').includes('Nowhere') ? [] : NOMINATIM_ST_MARYS);
    if (isOsrm(url)) return osrm();
    return undefined;
  });

  before(async () => {
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
    delete process.env.GOOGLE_MAPS_API_KEY;
    server = createServer((req, res) => (req.url.startsWith('/api/route') ? routeHandler : placesHandler)(req, res));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    globalThis.fetch = (input, init) => (String(input).startsWith(base) ? realFetch(input, init) : upstream(input, init));
  });

  after(async () => {
    globalThis.fetch = realFetch;
    process.env = savedEnv;
    await new Promise((resolve) => server.close(resolve));
  });

  const call = async (path, { method = 'GET', body, token = GOOD_TOKEN } = {}) => {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await realFetch(base + path, { method, headers, body: typeof body === 'string' ? body : body && JSON.stringify(body) });
    return { status: res.status, headers: res.headers, body: await res.json() };
  };

  test('routes from coordinates to a postcode', async () => {
    const res = await call('/api/route', {
      method: 'POST',
      body: { origin: { lat: 51.5072, lng: -0.1276, label: 'Home' }, destination: { address: 'SO14 3JA' } },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(res.body.origin, { label: 'Home', address: null, lat: 51.5072, lng: -0.1276 });
    assert.deepEqual(res.body.destination, { label: 'SO14 3JA', address: 'Bargate, Southampton SO14 3JA', lat: 50.89742, lng: -1.390705 });
    assert.equal(res.body.ok, true);
    assert.equal(res.body.miles, 80.03);
    assert.equal(res.body.minutes, 109.5);
    assert.equal(res.body.provider, 'osrm');
    assert.equal(res.body.traffic, false);
    assert.ok(Array.isArray(res.body.geometry) && res.body.geometry.length > 2);
  });

  test('requires a signed-in user', async () => {
    const anonymous = await call('/api/route', { method: 'POST', body: {}, token: null });
    assert.equal(anonymous.status, 401);
    assert.match(anonymous.body.error, /Sign in/);
    const forged = await call('/api/places?q=SO14%203', { token: 'forged.token.value' });
    assert.equal(forged.status, 401);
  });

  test('422 with a helpful message when an address cannot be found', async () => {
    const res = await call('/api/route', {
      method: 'POST',
      body: { origin: { lat: 51.5072, lng: -0.1276 }, destination: { address: 'Nowhere Lane, Atlantis' } },
    });
    assert.equal(res.status, 422);
    assert.deepEqual(res.body, { error: "Couldn't find 'Nowhere Lane, Atlantis'. Try a postcode." });
  });

  test('400 for bad bodies and coordinates; 405 for the wrong method', async () => {
    const bad = [
      ['{not json', /not valid JSON/],
      [{ destination: { address: 'SO14 3JA' } }, /start/],
      [{ origin: { lat: 91, lng: 0 }, destination: { address: 'SO14 3JA' } }, /invalid latitude/],
      [{ origin: { lat: 51, lng: 0 }, destination: { address: 'ab' } }, /at least 3 characters/],
      [{ origin: { lat: 51, lng: 0 }, destination: { address: 'x'.repeat(201) } }, /too long/],
    ];
    for (const [body, message] of bad) {
      const res = await call('/api/route', { method: 'POST', body });
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 60));
      assert.match(res.body.error, message);
    }
    const wrongMethod = await call('/api/route');
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get('allow'), 'POST');
  });

  test('502 when routing fails', async (t) => {
    quietly(t);
    osrm = () => html('<html>Service Unavailable</html>', 503);
    try {
      const res = await call('/api/route', {
        method: 'POST',
        body: { origin: { lat: 51.5072, lng: -0.1276 }, destination: { lat: 50.9097, lng: -1.4044, label: "St Mary's" } },
      });
      assert.equal(res.status, 502);
      assert.match(res.body.error, /driving route/);
    } finally {
      osrm = () => json(OSRM_LONDON_SOUTHAMPTON);
    }
  });

  test('places suggests addresses and validates q', async () => {
    const ok = await call('/api/places?q=SO14%203');
    assert.equal(ok.status, 200);
    assert.equal(ok.body.ok, true);
    assert.equal(ok.body.results.length, 4);
    assert.deepEqual(Object.keys(ok.body.results[0]), ['label', 'address', 'lat', 'lng', 'source']);

    const short = await call('/api/places?q=%20ab%20');
    assert.equal(short.status, 400);
    assert.match(short.body.error, /at least 3 characters/);
    const long = await call(`/api/places?q=${'a'.repeat(201)}`);
    assert.equal(long.status, 400);
  });

  test('runs the same handler with a Vercel-style pre-parsed body', async () => {
    const req = {
      method: 'POST',
      url: '/api/route',
      headers: { authorization: `Bearer ${GOOD_TOKEN}` },
      body: { origin: { lat: '51.5072', lng: '-0.1276' }, destination: { lat: 50.9097, lng: -1.4044 } },
    };
    const res = mockRes();
    await routeHandler(req, res);
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.origin.label, '51.50720, -0.12760');
    assert.equal(body.miles, 80.03);
  });
});

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  FEEDS,
  FUEL_TYPES,
  CACHE_TTL_MS,
  STALE_AFTER_MS,
  parseFeed,
  parseLondonTime,
  loadAll,
  priceNear,
  haversineMiles,
  median,
} from '../api/_lib/fuel.js';
import fuelHandler from '../api/fuel.js';

// ---- helpers ---------------------------------------------------------------------------

const fixtureText = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const fixture = (name) => JSON.parse(fixtureText(name));

const NOW = Date.parse('2026-10-05T10:00:00Z'); // the day the fixtures were recorded
const SOUTHAMPTON = { lat: 50.9097, lng: -1.4044 };
const LONDON = { lat: 51.5072, lng: -0.1276 };
const MILES_PER_DEGREE_LAT = 69.0934;

const feedUrl = (name) => FEEDS.find((feed) => feed.name === name).url;

const json = (body, status = 200) => ({ status, body: JSON.stringify(body), type: 'application/json' });
const html = (body, status) => ({ status, body, type: 'text/html' });

// A fetch double: `routes` maps URL -> response spec ({ status, body, type }), Error to
// throw, or function(url, init) returning either. Unknown URLs fail like a network error.
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    let spec = routes[String(url)];
    if (typeof spec === 'function') spec = await spec(String(url), init);
    if (spec instanceof Error) throw spec;
    if (!spec) throw new TypeError('fetch failed');
    return new Response(spec.body, { status: spec.status ?? 200, headers: { 'content-type': spec.type ?? 'application/json' } });
  };
  impl.calls = calls;
  return impl;
}

// How the twelve real feeds looked when the fixtures were recorded on 5 Oct 2026.
function recordedFeeds(overrides = {}) {
  const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  return fakeFetch({
    [feedUrl('Asda')]: json(fixture('fuel/asda.json')),
    [feedUrl('Esso')]: json(fixture('fuel/esso.json')),
    [feedUrl('JET')]: json(fixture('fuel/jet.json')),
    [feedUrl('Moto')]: json(fixture('fuel/moto.json')),
    [feedUrl('MFG')]: json(fixture('fuel/mfg.json')),
    [feedUrl('Rontec')]: json(fixture('fuel/rontec.json')),
    [feedUrl('Tesco')]: html(fixtureText('fuel/tesco-403.html'), 403),
    [feedUrl('Morrisons')]: json(fixture('fuel/morrisons.json')),
    [feedUrl("Sainsbury's")]: new TypeError('fetch failed'),
    [feedUrl('Applegreen')]: json(fixture('fuel/applegreen.json')),
    [feedUrl('Shell')]: json(fixture('fuel/shell.json')),
    [feedUrl('BP')]: timeout,
    ...overrides,
  });
}

// A station `miles` due north of SOUTHAMPTON.
function stationNorth(miles, prices, extra = {}) {
  return {
    id: `s-${miles}`,
    brand: 'Test',
    address: `${miles} miles north`,
    postcode: 'SO14 0AA',
    lat: SOUTHAMPTON.lat + miles / MILES_PER_DEGREE_LAT,
    lng: SOUTHAMPTON.lng,
    prices: { E10: null, E5: null, B7: null, SDV: null, ...prices },
    ...extra,
  };
}

function mockReq(url, { method = 'GET', headers = {} } = {}) {
  return { method, url, headers };
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

async function callFuel(url, method = 'GET') {
  const res = mockRes();
  await fuelHandler(mockReq(url, { method }), res);
  return res;
}

// ---- parseLondonTime -------------------------------------------------------------------

describe('parseLondonTime', () => {
  test('reads summer times as BST (UTC+1)', () => {
    assert.equal(parseLondonTime('05/10/2026 09:59:17'), '2026-10-05T08:59:17.000Z');
    assert.equal(parseLondonTime('01/07/2026 00:30:00'), '2026-06-30T23:30:00.000Z');
  });

  test('reads winter times as GMT', () => {
    assert.equal(parseLondonTime('05/01/2026 09:59:17'), '2026-01-05T09:59:17.000Z');
    assert.equal(parseLondonTime('26/02/2025 11:45:37'), '2025-02-26T11:45:37.000Z');
  });

  test('switches exactly at the 2026 clock changes', () => {
    // Clocks go forward 01:00 GMT on Sun 29 Mar 2026 and back 02:00 BST on Sun 25 Oct 2026.
    assert.equal(parseLondonTime('29/03/2026 00:59:59'), '2026-03-29T00:59:59.000Z');
    assert.equal(parseLondonTime('29/03/2026 02:00:00'), '2026-03-29T01:00:00.000Z');
    assert.equal(parseLondonTime('25/10/2026 00:30:00'), '2026-10-24T23:30:00.000Z');
    assert.equal(parseLondonTime('25/10/2026 02:00:00'), '2026-10-25T02:00:00.000Z');
  });

  test('resolves the repeated October hour to its first (BST) occurrence', () => {
    assert.equal(parseLondonTime('25/10/2026 01:30:00'), '2026-10-25T00:30:00.000Z');
  });

  test('agrees with the Europe/London tz database for every hour of 2026 and 2027', () => {
    const london = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const wall = (ms) => london.format(new Date(ms)).replace(',', '');
    let checked = 0;
    for (let ms = Date.UTC(2026, 0, 1); ms < Date.UTC(2028, 0, 1); ms += 3600 * 1000 + 17 * 1000) {
      const text = wall(ms); // "dd/mm/yyyy hh:mm:ss" exactly as the feeds write it
      const parsed = parseLondonTime(text);
      assert.equal(wall(Date.parse(parsed)), text, `round trip of ${text}`);
      checked += 1;
    }
    assert.ok(checked > 17000);
  });

  test('accepts minutes-only and date-only stamps', () => {
    assert.equal(parseLondonTime('05/10/2026 09:59'), '2026-10-05T08:59:00.000Z');
    assert.equal(parseLondonTime('5/10/2026'), '2026-10-04T23:00:00.000Z');
  });

  test('accepts ISO 8601 with an explicit zone', () => {
    assert.equal(parseLondonTime('2026-10-05T09:59:17Z'), '2026-10-05T09:59:17.000Z');
    assert.equal(parseLondonTime('2026-10-05T09:59:17+01:00'), '2026-10-05T08:59:17.000Z');
  });

  test('rejects impossible or ambiguous values', () => {
    for (const bad of ['31/02/2026 10:00:00', '05/13/2026 10:00:00', '05/10/2026 24:00:00', '05/10/2026 10:60:00',
      '2026-10-05 09:59:17', 'yesterday', '', '   ', null, undefined, 1791200000]) {
      assert.equal(parseLondonTime(bad), null, String(bad));
    }
  });
});

// ---- parseFeed -------------------------------------------------------------------------

describe('parseFeed', () => {
  test('parses the recorded Asda feed and drops placeholder prices', () => {
    const feed = parseFeed(fixture('fuel/asda.json'), 'Asda');
    assert.equal(feed.name, 'Asda');
    assert.equal(feed.updated, '2026-10-05T08:59:17.000Z');
    assert.equal(feed.stations.length, 12);

    const grange = feed.stations.find((s) => s.id === 'gcp1dmxhzf0b');
    assert.deepEqual(grange, {
      id: 'gcp1dmxhzf0b',
      brand: 'Asda',
      address: 'Grange Road, Southampton',
      postcode: 'SO30 2FU',
      lat: 50.916582,
      lng: -1.290345,
      prices: { E10: 174.9, E5: 192.9, B7: 199.9, SDV: 217.9 },
    });

    // Asda publishes 10 and 999.9 as "not sold" markers.
    const cramlington = feed.stations.find((s) => s.id === 'gcyck033zj0b');
    assert.equal(cramlington.prices.E5, null);
    assert.ok(cramlington.prices.E10 > 100);
    const aylesbury = feed.stations.find((s) => s.id === 'gcpqtxx2ybd9');
    assert.equal(aylesbury.prices.SDV, null);
  });

  test('normalises brand capitalisation and missing fuel keys (Esso)', () => {
    const feed = parseFeed(fixture('fuel/esso.json'), 'Esso');
    assert.equal(feed.updated, '2026-10-04T23:05:14.000Z');
    assert.equal(feed.stations.length, 5);
    for (const s of feed.stations) {
      assert.equal(s.brand, 'Esso');
      assert.deepEqual(Object.keys(s.prices), FUEL_TYPES);
    }
    const lodge = feed.stations.find((s) => s.id === 'gcp18jxhxv06');
    assert.deepEqual(lodge.prices, { E10: 173.9, E5: 188.9, B7: 200.9, SDV: null });
  });

  test('drops 0,0 coordinates and repairs swapped latitude/longitude (MFG)', () => {
    const raw = fixture('fuel/mfg.json');
    assert.equal(raw.stations.filter((s) => s.site_id === '7zzzzzzzzzzz').length, 4);
    const feed = parseFeed(raw, 'MFG');
    assert.equal(feed.stations.length, raw.stations.length - 4);
    assert.ok(!feed.stations.some((s) => s.id === '7zzzzzzzzzzz'));

    const marlborough = feed.stations.find((s) => s.id === 'mpsw1yx1r6p5');
    assert.ok(Math.abs(marlborough.lat - 51.414963) < 1e-9, 'latitude restored');
    assert.ok(Math.abs(marlborough.lng - -1.721881) < 1e-9, 'longitude restored');
  });

  test('reads string coordinates but keeps only UK stations (Morrisons lists Gibraltar)', () => {
    const feed = parseFeed(fixture('fuel/morrisons.json'), 'Morrisons');
    assert.equal(feed.updated, '2026-10-04T09:30:21.000Z');
    assert.deepEqual(feed.stations, []);

    const moved = fixture('fuel/morrisons.json');
    moved.stations[0].location = { latitude: '50.9097', longitude: '-1.4044' };
    const [station] = parseFeed(moved, 'Morrisons').stations;
    assert.equal(station.lat, 50.9097);
    assert.equal(station.lng, -1.4044);
  });

  test('finds last_updated wherever it sits in the object (Rontec puts it last)', () => {
    const feed = parseFeed(fixture('fuel/rontec.json'), 'Rontec');
    assert.equal(feed.updated, '2026-05-01T09:55:06.000Z');
    assert.equal(feed.stations.length, 3);
  });

  test('copes with legacy shapes: strings, pounds, p suffixes, lower-case keys, root coordinates', () => {
    const feed = parseFeed(fixture('fuel/legacy-shapes.json'), 'Legacy');
    assert.equal(feed.updated, null);
    assert.equal(feed.stations.length, 2, 'stations without location or prices are dropped');

    const [lodge, bitterne] = feed.stations;
    assert.deepEqual(lodge, {
      id: 'gcp18jxhxv06',
      brand: 'Esso',
      address: 'Lodge Road, SOUTHAMPTON',
      postcode: 'SO14 6RP',
      lat: 50.919684,
      lng: -1.396304,
      prices: { E10: 173.9, E5: 188.9, B7: 200.9, SDV: null },
    });
    assert.equal(bitterne.brand, 'Esso');
    assert.deepEqual(bitterne.prices, { E10: 173.9, E5: null, B7: 200.9, SDV: 214.9 });
    assert.equal(bitterne.lat, 50.921585);
  });

  test('keeps only plausible pence-per-litre values (80p to 300p)', () => {
    const station = (prices) => ({ site_id: 'x', location: { latitude: 51, longitude: -1 }, prices });
    const [s] = parseFeed({ stations: [station({ E10: 80, E5: 300, B7: 79.9, SDV: 300.1 })] }, 'X').stations;
    assert.deepEqual(s.prices, { E10: 80, E5: 300, B7: null, SDV: null });
    assert.equal(parseFeed({ stations: [station({ E10: 0, B7: -150, E5: 'n/a' })] }, 'X').stations.length, 0);
    const [pounds] = parseFeed({ stations: [station({ E10: 1.7389999 })] }, 'X').stations;
    assert.equal(pounds.prices.E10, 173.9);
  });

  test('never throws on garbage', () => {
    for (const garbage of [null, undefined, 'Access Denied', 42, {}, { stations: 'nope' }, { stations: [null, 7, 'x', {}] }]) {
      assert.deepEqual(parseFeed(garbage, 'X'), { name: 'X', updated: null, stations: [] });
    }
    const bare = parseFeed(fixture('fuel/jet.json').stations, 'JET');
    assert.equal(bare.stations.length, 3, 'a bare array of stations is accepted');
  });
});

// ---- maths -----------------------------------------------------------------------------

describe('median', () => {
  test('odd, even and unsorted inputs', () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.equal(median([174.9]), 174.9);
  });

  test('ignores non-numbers and accepts numeric strings', () => {
    assert.equal(median([null, undefined, NaN, '', 'abc', '5', 1, 3]), 3);
    assert.equal(median([]), null);
    assert.equal(median([null, NaN]), null);
    assert.equal(median('not an array'), null);
  });

  test('does not reorder the caller\'s array', () => {
    const values = [3, 1, 2];
    median(values);
    assert.deepEqual(values, [3, 1, 2]);
  });
});

describe('haversineMiles', () => {
  test('London to Southampton is 65-70 miles in a straight line', () => {
    const miles = haversineMiles(LONDON, SOUTHAMPTON);
    assert.ok(miles > 65 && miles < 70, `got ${miles}`);
    assert.equal(haversineMiles(SOUTHAMPTON, LONDON), miles);
  });

  test('zero for the same point, ~69 miles per degree of latitude', () => {
    assert.equal(haversineMiles(SOUTHAMPTON, SOUTHAMPTON), 0);
    const oneDegree = haversineMiles({ lat: 50, lng: -1 }, { lat: 51, lng: -1 });
    assert.ok(Math.abs(oneDegree - 69.09) < 0.05, `got ${oneDegree}`);
  });
});

// ---- priceNear -------------------------------------------------------------------------

describe('priceNear', () => {
  test('uses the 3 mile radius when it already holds three stations', () => {
    const stations = [stationNorth(0.5, { E10: 170 }), stationNorth(1, { E10: 160 }), stationNorth(2.5, { E10: 180 }), stationNorth(8, { E10: 150 })];
    const result = priceNear({ ...SOUTHAMPTON, type: 'E10', stations });
    assert.equal(result.scope, 'local');
    assert.equal(result.radiusMiles, 3);
    assert.equal(result.count, 3);
    assert.equal(result.ppl, 170);
    assert.equal(result.mean, 170);
    assert.equal(result.min, 160);
    assert.equal(result.max, 180);
    assert.deepEqual(result.cheapest, { brand: 'Test', address: '1 miles north', postcode: 'SO14 0AA', ppl: 160, miles: 1 });
    assert.equal(result.nearest.miles, 0.5);
    assert.equal(result.nearest.ppl, 170);
  });

  test('widens the radius until three stations sell the fuel', () => {
    const stations = [
      stationNorth(1, { E10: 150, B7: 190 }),
      stationNorth(2, { E10: 160 }), // no diesel here
      stationNorth(5, { E10: 170, B7: 195 }),
      stationNorth(9, { B7: 200 }),
      stationNorth(15, { E10: 190, B7: 210 }),
    ];
    const petrol = priceNear({ ...SOUTHAMPTON, type: 'E10', stations });
    assert.equal(petrol.radiusMiles, 6);
    assert.equal(petrol.count, 3);
    assert.equal(petrol.ppl, 160);

    const diesel = priceNear({ ...SOUTHAMPTON, type: 'B7', stations });
    assert.equal(diesel.radiusMiles, 10);
    assert.equal(diesel.count, 3);
    assert.equal(diesel.ppl, 195);
    assert.equal(diesel.cheapest.ppl, 190);
  });

  test('falls back to national figures when fewer than three stations lie within 20 miles', () => {
    const stations = [stationNorth(4, { E10: 150 }), stationNorth(18, { E10: 160 }), stationNorth(25, { E10: 170 }), stationNorth(40, { E10: 175 })];
    const result = priceNear({ ...SOUTHAMPTON, type: 'E10', stations });
    assert.equal(result.scope, 'national');
    assert.equal(result.radiusMiles, null);
    assert.equal(result.count, 4);
    assert.equal(result.ppl, 165);
    assert.equal(result.cheapest, null);
    assert.equal(result.nearest.miles, 4, 'the nearest pump is still useful');
  });

  test('without a location returns national figures only', () => {
    const stations = [stationNorth(1, { E10: 150 }), stationNorth(2, { E10: 151 }), stationNorth(3, { E10: 152 })];
    const result = priceNear({ type: 'e10', stations });
    assert.deepEqual(result, {
      type: 'E10', ppl: 151, mean: 151, min: 150, max: 152, count: 3,
      radiusMiles: null, scope: 'national', cheapest: null, nearest: null,
    });
  });

  test('prefers the nearer station when two are equally cheap', () => {
    const stations = [stationNorth(0.2, { E10: 170 }), stationNorth(2, { E10: 160 }), stationNorth(1, { E10: 160 })];
    assert.equal(priceNear({ ...SOUTHAMPTON, type: 'E10', stations }).cheapest.miles, 1);
  });

  test('reports nothing when no station sells the fuel', () => {
    const result = priceNear({ ...SOUTHAMPTON, type: 'SDV', stations: [stationNorth(1, { E10: 150 })] });
    assert.equal(result.count, 0);
    assert.equal(result.ppl, null);
    assert.equal(result.scope, 'national');
    assert.equal(result.nearest, null);
  });

  test('rejects unknown fuel types', () => {
    assert.throws(() => priceNear({ type: 'diesel', stations: [] }), RangeError);
  });

  test('prices Southampton from the recorded feeds', () => {
    const stations = ['asda', 'esso', 'mfg'].flatMap((name) => parseFeed(fixture(`fuel/${name}.json`), name).stations);
    const e10 = priceNear({ ...SOUTHAMPTON, type: 'E10', stations });
    assert.equal(e10.scope, 'local');
    assert.equal(e10.radiusMiles, 3);
    assert.equal(e10.count, 7);
    assert.equal(e10.ppl, 175.9);
    assert.equal(e10.cheapest.ppl, 173.9);
    assert.equal(e10.nearest.address, 'MFG Northam, 110 Northam Road, Southampton');
    assert.equal(e10.nearest.miles, 0.7);
  });
});

// ---- loadAll ---------------------------------------------------------------------------

describe('loadAll', () => {
  test('reports every feed and keeps only fresh, usable ones', async () => {
    const fetchImpl = recordedFeeds();
    const result = await loadAll({ now: NOW, fetchImpl, force: true });

    assert.equal(fetchImpl.calls.length, FEEDS.length);
    assert.equal(result.fetchedAt, new Date(NOW).toISOString());
    const byName = Object.fromEntries(result.feeds.map((feed) => [feed.name, feed]));
    assert.deepEqual(result.feeds.map((feed) => feed.name), FEEDS.map((feed) => feed.name));

    assert.deepEqual(byName.Asda, { name: 'Asda', ok: true, status: 'ok', updated: '2026-10-05T08:59:17.000Z', stations: 12, stale: false });
    assert.equal(byName.MFG.ok, true);
    assert.deepEqual(byName.Rontec, { name: 'Rontec', ok: false, status: 'stale', updated: '2026-05-01T09:55:06.000Z', stations: 3, stale: true });
    assert.equal(byName.Applegreen.status, 'stale');
    assert.equal(byName.Shell.status, 'stale');
    assert.deepEqual(byName.Tesco, { name: 'Tesco', ok: false, status: 'error', updated: null, stations: 0, stale: false, error: 'HTTP 403' });
    assert.equal(byName["Sainsbury's"].error, 'Unreachable');
    assert.equal(byName.BP.error, 'Timed out');
    assert.equal(byName.Morrisons.status, 'empty');

    const fresh = ['Asda', 'Esso', 'JET', 'Moto', 'MFG'].reduce((sum, name) => sum + byName[name].stations, 0);
    // Asda lists the two Nene Valley Way forecourts under one site_id; they count once.
    assert.equal(result.stations.length, fresh - 1);
    assert.ok(!result.stations.some((s) => s.address === 'Swaythling Rd, Southampton'), 'stale stations excluded');
  });

  test('sends the Sizemill user agent', async () => {
    const fetchImpl = recordedFeeds();
    await loadAll({ now: NOW, fetchImpl, force: true });
    for (const { init } of fetchImpl.calls) {
      assert.equal(init.headers['User-Agent'], 'Sizemill/1.0 (+https://www.sizemill.com)');
      assert.ok(init.signal instanceof AbortSignal);
    }
  });

  test('keeps undated feeds, and marks HTML served as 200 as not JSON', async () => {
    const fetchImpl = recordedFeeds({
      [feedUrl('JET')]: json(fixture('fuel/legacy-shapes.json')),
      [feedUrl('Moto')]: html('<!DOCTYPE html><title>Fuel prices</title>', 200),
    });
    const { feeds, stations } = await loadAll({ now: NOW, fetchImpl, force: true });
    const jet = feeds.find((feed) => feed.name === 'JET');
    assert.deepEqual(jet, { name: 'JET', ok: true, status: 'undated', updated: null, stations: 2, stale: false });
    assert.equal(feeds.find((feed) => feed.name === 'Moto').error, 'Not JSON');
    assert.ok(stations.some((s) => s.address === '149 WEST END ROAD, BITTERNE, SOUTHAMPTON'));
  });

  test('treats a feed older than seven days as stale', async () => {
    const asda = fixture('fuel/asda.json');
    const justFresh = new Date(NOW - STALE_AFTER_MS + 60 * 1000);
    const justStale = new Date(NOW - STALE_AFTER_MS - 60 * 60 * 1000);
    const stamp = (d) => d.toISOString(); // ISO with zone is accepted too
    const fetchImpl = recordedFeeds({
      [feedUrl('Asda')]: json({ ...asda, last_updated: stamp(justFresh) }),
      [feedUrl('Esso')]: json({ ...fixture('fuel/esso.json'), last_updated: stamp(justStale) }),
    });
    const { feeds } = await loadAll({ now: NOW, fetchImpl, force: true });
    assert.equal(feeds.find((f) => f.name === 'Asda').status, 'ok');
    assert.equal(feeds.find((f) => f.name === 'Esso').status, 'stale');
  });

  test('dedupes by site_id across feeds, keeping the most recently updated price', async () => {
    const station = (price, lat = 50.92) => ({ site_id: 'gcp18jxhxv06', brand: 'ESSO', address: 'Lodge Road', postcode: 'SO14 6RP', location: { latitude: lat, longitude: -1.396 }, prices: { E10: price } });
    const fetchImpl = fakeFetch({
      [feedUrl('Esso')]: json({ last_updated: '05/10/2026 09:00:00', stations: [station(173.9)] }),
      [feedUrl('MFG')]: json({ last_updated: '05/10/2026 06:00:00', stations: [station(179.9), { ...station(165.9, 53.5), site_id: 'gcp18jxhxv06' }] }),
      [feedUrl('Rontec')]: json({ stations: [station(181.9)] }), // undated sorts last
    });
    const { stations } = await loadAll({ now: NOW, fetchImpl, force: true });
    const lodge = stations.filter((s) => s.lat < 51);
    assert.equal(lodge.length, 1);
    assert.equal(lodge[0].prices.E10, 173.9);
    // The same id 180 miles away is a different forecourt with a reused id.
    assert.equal(stations.filter((s) => s.lat > 53).length, 1);
  });

  test('loads on the very first call (empty cache)', async () => {
    const pristine = await import('../api/_lib/fuel.js?pristine-module');
    const fetchImpl = recordedFeeds();
    const result = await pristine.loadAll({ now: NOW, fetchImpl });
    assert.equal(fetchImpl.calls.length, FEEDS.length);
    assert.ok(result.stations.length > 0);
  });

  test('caches for 20 minutes and shares one load between concurrent callers', async () => {
    const fetchImpl = recordedFeeds();
    const first = await loadAll({ now: NOW, fetchImpl, force: true });
    assert.equal(fetchImpl.calls.length, FEEDS.length);

    const [a, b] = await Promise.all([
      loadAll({ now: NOW + 60 * 1000, fetchImpl }),
      loadAll({ now: NOW + CACHE_TTL_MS - 1, fetchImpl }),
    ]);
    assert.equal(a, first);
    assert.equal(b, first);
    assert.equal(fetchImpl.calls.length, FEEDS.length, 'served from cache');

    const later = await loadAll({ now: NOW + CACHE_TTL_MS, fetchImpl });
    assert.notEqual(later, first);
    assert.equal(fetchImpl.calls.length, 2 * FEEDS.length);

    const slow = fakeFetch(Object.fromEntries(FEEDS.map((feed) => [feed.url, () => new Promise((resolve) => setTimeout(() => resolve(json({ stations: [] })), 20))])));
    const [x, y] = await Promise.all([loadAll({ now: NOW, fetchImpl: slow, force: true }), loadAll({ now: NOW, fetchImpl: slow })]);
    assert.equal(x, y);
    assert.equal(slow.calls.length, FEEDS.length, 'in-flight load shared');
  });

  test('retries after a minute when every feed failed', async () => {
    const down = fakeFetch({});
    const empty = await loadAll({ now: NOW, fetchImpl: down, force: true });
    assert.equal(empty.stations.length, 0);
    assert.ok(empty.feeds.every((feed) => feed.status === 'error'));

    await loadAll({ now: NOW + 30 * 1000, fetchImpl: down });
    assert.equal(down.calls.length, FEEDS.length);
    await loadAll({ now: NOW + 61 * 1000, fetchImpl: down });
    assert.equal(down.calls.length, 2 * FEEDS.length);
  });
});

// ---- GET /api/fuel ---------------------------------------------------------------------

describe('GET /api/fuel', () => {
  // The handler loads through the module cache; prime it with the recorded feeds, the
  // live ones re-dated to an hour ago so the test does not depend on today's date.
  const primeWithRecordedFeeds = () => {
    const now = Date.now();
    const anHourAgo = new Date(now - 60 * 60 * 1000).toISOString();
    const redated = Object.fromEntries(
      ['Asda', 'Esso', 'JET', 'Moto', 'MFG'].map((name) => [
        feedUrl(name),
        json({ ...fixture(`fuel/${name.toLowerCase()}.json`), last_updated: anHourAgo }),
      ]),
    );
    return loadAll({ now, fetchImpl: recordedFeeds(redated), force: true });
  };

  test('prices near a point with national context and feed status', async () => {
    await primeWithRecordedFeeds();
    const res = await callFuel('/api/fuel?lat=50.9097&lng=-1.4044&type=b7');
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['cache-control'], 'public, s-maxage=900, stale-while-revalidate=3600');
    assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.type, 'B7');
    assert.equal(body.scope, 'local');
    assert.equal(body.radiusMiles, 3);
    assert.ok(body.ppl > 150 && body.ppl < 250);
    assert.ok(body.cheapest && body.nearest);
    assert.ok(body.national.count > body.count);
    assert.equal(body.feeds.length, FEEDS.length);
    assert.ok(!('parsed' in body.feeds[0]));
    assert.match(body.fetchedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(
      Object.keys(body),
      ['ok', 'type', 'ppl', 'mean', 'min', 'max', 'count', 'radiusMiles', 'scope', 'cheapest', 'nearest', 'national', 'feeds', 'fetchedAt'],
    );
  });

  test('returns national figures without a location and defaults to E10', async () => {
    await primeWithRecordedFeeds();
    const body = (await callFuel('/api/fuel')).json();
    assert.equal(body.type, 'E10');
    assert.equal(body.scope, 'national');
    assert.equal(body.ppl, body.national.ppl);
    assert.equal(body.cheapest, null);
  });

  test('validates its inputs', async () => {
    const cases = [
      ['/api/fuel?type=diesel', /E10, E5, B7, SDV/],
      ['/api/fuel?lat=50.9', /both lat and lng/],
      ['/api/fuel?lat=95&lng=-1.4', /between -90 and 90/],
      ['/api/fuel?lat=abc&lng=-1.4', /between -90 and 90/],
    ];
    for (const [url, message] of cases) {
      const res = await callFuel(url);
      assert.equal(res.statusCode, 400, url);
      assert.match(res.json().error, message);
      assert.equal(res.headers['cache-control'], 'no-store');
    }
  });

  test('answers 405 to other methods', async () => {
    const res = await callFuel('/api/fuel', 'POST');
    assert.equal(res.statusCode, 405);
    assert.equal(res.headers.allow, 'GET');
  });

  test('answers 502 (not cacheable) when no feed has prices', async () => {
    await loadAll({ now: Date.now(), fetchImpl: fakeFetch({}), force: true });
    const res = await callFuel('/api/fuel?type=E10');
    assert.equal(res.statusCode, 502);
    assert.equal(res.headers['cache-control'], 'no-store');
    const body = res.json();
    assert.match(body.error, /Enter the price yourself/);
    assert.equal(body.feeds.length, FEEDS.length);
  });
});

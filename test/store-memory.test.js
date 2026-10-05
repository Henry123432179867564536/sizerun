// Tests for public/desk/lib/store.js.
//
// Most of this file drives the memory store end to end (settings, CRUD, numbering, cascades,
// ordering, embedded shapes, whitelisting, notifications, persistence, local-mode API calls).
// The last block runs the Supabase implementation against a recording fake client to pin the
// queries it sends and the human errors it produces, since both modes must behave alike.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createStore, DEFAULT_SETTINGS } from '../public/desk/lib/store.js';

const STORAGE_KEY = 'sizemill.desk.local';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MISSING_ID = '6f1c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f';

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => {
      data.set(key, String(value));
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

function savedDatabase(storage) {
  return JSON.parse(storage.data.get(STORAGE_KEY));
}

function refuseFetch() {
  throw new Error('fetch should not be called in this test');
}

async function memoryStore({ storage = fakeStorage(), fetchImpl = refuseFetch } = {}) {
  const store = await createStore({ mode: 'memory', storage, fetchImpl });
  return { store, storage };
}

// Counts change notifications.
function watch(store) {
  const counter = { count: 0 };
  counter.stop = store.subscribe(() => {
    counter.count += 1;
  });
  return counter;
}

async function rejectsWith(promise, message) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof Error, 'rejects with an Error');
    assert.equal(err.message, message);
    return true;
  });
}

function londonToday() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const part = (type) => parts.find((p) => p.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

// A sale with one item still to buy, one already bought and one extra cost.
async function seedDeal(store, overrides = {}) {
  const client = await store.clients.create({ name: 'Bukayo Saka', club: 'Arsenal' });
  const deal = await store.deals.create({
    deal: { client_id: client.id, title: 'Boots drop', sale_date: '2026-10-01', ...overrides },
    items: [
      { description: 'Mercurial Superfly 10', size: 'UK 9', unit_price: 450, expected_unit_cost: 300 },
      { description: 'Tech Fleece', unit_price: 120, cost_status: 'actual', unit_cost: 80, expected_unit_cost: 85 },
    ],
    costs: [{ label: 'Packaging', kind: 'packaging', amount: 4.5 }],
  });
  return { client, deal };
}

function tripInput(overrides = {}) {
  return {
    trip_date: '2026-10-02',
    origin_label: 'Home',
    origin_lat: 51.5,
    origin_lng: -0.12,
    dest_label: 'Southampton training ground',
    dest_lat: 50.9,
    dest_lng: -1.4,
    one_way_miles: 80,
    one_way_minutes: 110,
    extra_minutes: 15,
    mpg: 45,
    fuel_type: 'E10',
    fuel_ppl: 140,
    hourly_rate: 20,
    route_provider: 'osrm',
    route_geometry: [[51.5, -0.12], [50.9, -1.4]],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------------
// Memory store
// ---------------------------------------------------------------------------------------------

describe('memory store: setup and auth', () => {
  test('reports its mode and is always signed in as the device user', async () => {
    const { store } = await memoryStore();
    assert.equal(store.mode, 'memory');
    assert.deepEqual(store.auth.user(), { id: 'local', email: 'local@device' });
    assert.deepEqual(await store.auth.signIn('a@b.c', 'pw'), { id: 'local', email: 'local@device' });
    assert.deepEqual(await store.auth.signUp('a@b.c', 'pw'), {
      user: { id: 'local', email: 'local@device' },
      needsConfirmation: false,
    });
    await store.auth.magicLink('a@b.c');
    await store.auth.signOut();
    assert.deepEqual(store.auth.user(), { id: 'local', email: 'local@device' });
    const unsubscribe = store.auth.onChange(() => assert.fail('auth never changes in local mode'));
    assert.equal(typeof unsubscribe, 'function');
    unsubscribe();
  });

  test('exposes the full spec API', async () => {
    const { store } = await memoryStore();
    const expected = {
      auth: ['user', 'onChange', 'signIn', 'signUp', 'magicLink', 'signOut'],
      settings: ['get', 'save'],
      clients: ['list', 'get', 'create', 'update', 'remove'],
      stock: ['list', 'create', 'update', 'remove'],
      deals: ['list', 'get', 'create', 'update', 'remove'],
      items: ['create', 'update', 'remove'],
      costs: ['create', 'update', 'remove'],
      payments: ['create', 'remove'],
      trips: ['list', 'create', 'update', 'remove'],
      api: ['route', 'places', 'fuel'],
    };
    for (const [namespace, methods] of Object.entries(expected)) {
      for (const method of methods) assert.equal(typeof store[namespace][method], 'function', `${namespace}.${method}`);
    }
    assert.equal(typeof store.subscribe, 'function');
  });

  test('every data method returns a promise, rejecting (not throwing) on bad input', async () => {
    const { store } = await memoryStore();
    const calls = [
      () => store.settings.save('mpg=45'),
      () => store.clients.create(null),
      () => store.clients.update(MISSING_ID, 7),
      () => store.stock.create([]),
      () => store.deals.create({ deal: 'x' }),
      () => store.deals.update(MISSING_ID, null),
      () => store.items.create('bad', {}),
      () => store.items.update(MISSING_ID, null),
      () => store.costs.create('bad', {}),
      () => store.payments.create('bad', {}),
      () => store.trips.create(null),
      () => store.trips.update(MISSING_ID, null),
    ];
    for (const call of calls) {
      const result = call();
      assert.ok(result instanceof Promise, call.toString());
      await assert.rejects(result);
    }
  });

  test('rejects an unknown mode', async () => {
    await rejectsWith(createStore({ mode: 'sqlite' }), "Unknown store mode 'sqlite'.");
  });
});

describe('memory store: settings', () => {
  test('DEFAULT_SETTINGS matches the spec exactly and is frozen', () => {
    assert.deepEqual(DEFAULT_SETTINGS, {
      business_name: 'Sizemill',
      home_label: null,
      home_address: null,
      home_lat: null,
      home_lng: null,
      mpg: 45,
      fuel_type: 'E10',
      hourly_rate: 20,
      vehicle_cost_per_mile: 0,
      round_trip_default: true,
      handover_minutes_default: 15,
      target_margin: 0.25,
      logo_url: null,
      brand_color: null,
    });
    assert.ok(Object.isFrozen(DEFAULT_SETTINGS));
  });

  test('get() before any save returns the defaults with updated_at null (first run)', async () => {
    const { store } = await memoryStore();
    const settings = await store.settings.get();
    assert.deepEqual(settings, { ...DEFAULT_SETTINGS, updated_at: null });
    settings.mpg = 99; // a copy: changing it must not leak into the store
    assert.equal((await store.settings.get()).mpg, 45);
  });

  test('save() upserts, merges patches over the stored row and coerces form strings', async () => {
    const { store } = await memoryStore();
    const first = await store.settings.save({
      home_address: '  1 High St, London  ',
      home_lat: '51.5',
      home_lng: -0.12,
      mpg: '52.46',
      fuel_type: 'B7',
    });
    assert.equal(first.home_address, '1 High St, London');
    assert.equal(first.home_lat, 51.5);
    assert.equal(first.mpg, 52.5, 'numeric(5,1) rounds half away from zero');
    assert.equal(first.fuel_type, 'B7');
    assert.equal(first.hourly_rate, 20, 'untouched columns keep their defaults');
    assert.equal(first.owner, 'local');
    assert.match(first.updated_at, ISO_TIMESTAMP);

    const second = await store.settings.save({ hourly_rate: '25', round_trip_default: false });
    assert.equal(second.hourly_rate, 25);
    assert.equal(second.round_trip_default, false);
    assert.equal(second.fuel_type, 'B7', 'earlier save kept');
    assert.ok(second.updated_at > first.updated_at);
    assert.deepEqual(await store.settings.get(), second);
  });

  test('save() strips unknown and server-owned keys; a null business name falls back to the default', async () => {
    const { store, storage } = await memoryStore();
    const saved = await store.settings.save({
      business_name: '',
      owner: 'someone-else',
      updated_at: '2000-01-01T00:00:00.000Z',
      favourite_colour: 'red',
    });
    assert.equal(saved.business_name, 'Sizemill');
    assert.equal(saved.owner, 'local');
    assert.notEqual(saved.updated_at, '2000-01-01T00:00:00.000Z');
    const row = savedDatabase(storage).desk_settings[0];
    assert.equal(row.business_name, null);
    assert.equal('favourite_colour' in row, false);
  });

  test('save() enforces the SQL checks with human messages and leaves settings unchanged', async () => {
    const { store } = await memoryStore();
    await store.settings.save({ mpg: 50 });
    await rejectsWith(store.settings.save({ mpg: 0 }), 'MPG must be more than 0.');
    await rejectsWith(store.settings.save({ mpg: '' }), 'MPG is required.');
    await rejectsWith(store.settings.save({ mpg: 'lots' }), 'MPG must be a number.');
    await rejectsWith(store.settings.save({ fuel_type: 'LPG' }), 'Fuel type must be E10, E5, B7 or SDV.');
    await rejectsWith(store.settings.save({ target_margin: 25 }), 'Target margin must be at least 0% and below 100%.');
    await rejectsWith(store.settings.save({ home_lat: 51.5 }), 'Home location needs both latitude and longitude.');
    await rejectsWith(store.settings.save({ handover_minutes_default: 2.5 }), 'Handover minutes must be a whole number.');
    await rejectsWith(store.settings.save({ mpg: 100000 }), 'MPG is too large.');
    assert.equal((await store.settings.get()).mpg, 50);
  });

  test('save() with nothing writable returns current settings without writing', async () => {
    const { store, storage } = await memoryStore();
    const changes = watch(store);
    assert.deepEqual(await store.settings.save({ nonsense: 1 }), { ...DEFAULT_SETTINGS, updated_at: null });
    assert.equal(changes.count, 0);
    assert.equal(storage.data.has(STORAGE_KEY), false);
  });
});

describe('memory store: clients', () => {
  test('create() fills ids, owner, defaults and timestamps, trimming and coercing input', async () => {
    const { store } = await memoryStore();
    const client = await store.clients.create({
      name: '  Bukayo Saka ',
      club: 'Arsenal',
      position: '',
      squad_number: 7,
      tags: 'vip, boots ,vip',
      birthday: '2001-09-05',
    });
    assert.match(client.id, UUID_V4);
    assert.equal(client.owner, 'local');
    assert.equal(client.name, 'Bukayo Saka');
    assert.equal(client.position, null, 'blank text is stored as null');
    assert.equal(client.squad_number, '7');
    assert.deepEqual(client.tags, ['vip', 'boots']);
    assert.deepEqual(client.addresses, []);
    assert.equal(client.archived, false);
    assert.equal(client.birthday, '2001-09-05');
    assert.equal(client.agent_email, null, 'every §2 column is present');
    assert.match(client.created_at, ISO_TIMESTAMP);
    assert.equal(client.updated_at, client.created_at);
  });

  test('create() validates required fields, dates and list shapes', async () => {
    const { store } = await memoryStore();
    await rejectsWith(store.clients.create({ club: 'Arsenal' }), 'Name is required.');
    await rejectsWith(store.clients.create({ name: '   ' }), 'Name is required.');
    await rejectsWith(store.clients.create({ name: 'A', birthday: '2026-02-30' }), 'Birthday must be a valid date.');
    await rejectsWith(store.clients.create({ name: 'A', addresses: { label: 'Home' } }), 'Addresses must be a list.');
    await rejectsWith(store.clients.create(null), 'Nothing to save.');
    assert.deepEqual(await store.clients.list(), []);
  });

  test('list() orders by name (case-insensitively) and hides archived clients unless asked', async () => {
    const { store } = await memoryStore();
    await store.clients.create({ name: 'Zed' });
    await store.clients.create({ name: 'alan' });
    await store.clients.create({ name: 'Bukayo' });
    await store.clients.create({ name: 'Archie', archived: true });
    assert.deepEqual((await store.clients.list()).map((c) => c.name), ['alan', 'Bukayo', 'Zed']);
    assert.deepEqual(
      (await store.clients.list({ includeArchived: true })).map((c) => c.name),
      ['alan', 'Archie', 'Bukayo', 'Zed'],
    );
  });

  test('get(), update() and remove()', async () => {
    const { store } = await memoryStore();
    const client = await store.clients.create({ name: 'Declan Rice', addresses: [{ label: 'Training', address: 'London Colney', lat: 51.7, lng: -0.3 }] });
    assert.deepEqual(await store.clients.get(client.id), client);
    assert.equal(await store.clients.get(MISSING_ID), null);
    assert.equal(await store.clients.get('not-a-uuid'), null);

    const updated = await store.clients.update(client.id, { club: 'Arsenal', tags: null, addresses: '' });
    assert.equal(updated.club, 'Arsenal');
    assert.deepEqual(updated.tags, [], 'clearing a list leaves an empty list');
    assert.deepEqual(updated.addresses, []);
    assert.equal(updated.created_at, client.created_at);
    assert.ok(updated.updated_at > client.updated_at);

    await rejectsWith(store.clients.update(client.id, { name: '' }), 'Name is required.');
    await rejectsWith(store.clients.update(MISSING_ID, { club: 'X' }), 'That record no longer exists.');

    await store.clients.remove(client.id);
    assert.equal(await store.clients.get(client.id), null);
    await store.clients.remove(client.id); // already gone: still resolves
  });
});

describe('memory store: stock', () => {
  test('CRUD with defaults, validation and newest-bought-first ordering', async () => {
    const { store } = await memoryStore();
    const older = await store.stock.create({ name: 'Samba OG', unit_cost: '65.00', bought_at: '2026-09-01' });
    const newer = await store.stock.create({ name: 'Jordan 4', unit_cost: 140, bought_at: '2026-10-01', qty: 2 });
    const undated = await store.stock.create({ name: 'Mystery box', unit_cost: 10, bought_at: null });
    assert.equal(older.condition, 'new');
    assert.equal(older.qty, 1);
    assert.equal(older.unit_cost, 65);
    assert.equal(undated.bought_at, null, 'an explicit null on a nullable column stays null');
    const defaulted = await store.stock.create({ name: 'Socks', unit_cost: 2 });
    assert.equal(defaulted.bought_at, londonToday(), 'omitted bought_at defaults to today in London');

    assert.deepEqual(
      (await store.stock.list()).map((s) => s.name),
      ['Socks', 'Jordan 4', 'Samba OG', 'Mystery box'],
      'bought_at desc, NULLs last',
    );

    const updated = await store.stock.update(newer.id, { qty: 1, condition: 'used' });
    assert.equal(updated.qty, 1);
    assert.equal(updated.condition, 'used');
    await rejectsWith(store.stock.update(newer.id, { condition: 'mint' }), "Condition must be 'new' or 'used'.");
    await rejectsWith(store.stock.update(newer.id, { qty: -1 }), "Quantity can't be negative.");
    await rejectsWith(store.stock.create({ name: 'No price' }), 'Cost is required.');

    await store.stock.update(older.id, { archived: true });
    assert.equal((await store.stock.list()).some((s) => s.id === older.id), false);
    assert.equal((await store.stock.list({ includeArchived: true })).some((s) => s.id === older.id), true);

    await store.stock.remove(newer.id);
    assert.equal((await store.stock.list()).some((s) => s.id === newer.id), false);
  });
});

describe('memory store: deals', () => {
  test('create() returns the full embedded shape with SQL defaults', async () => {
    const { store } = await memoryStore();
    const { client, deal } = await seedDeal(store);

    assert.match(deal.id, UUID_V4);
    assert.equal(deal.number, 1);
    assert.equal(deal.owner, 'local');
    assert.equal(deal.status, 'agreed');
    assert.equal(deal.delivery_method, 'drop_off');
    assert.equal(deal.sale_date, '2026-10-01');
    assert.deepEqual(deal.client, { id: client.id, name: 'Bukayo Saka', club: 'Arsenal' });
    assert.deepEqual(deal.payments, []);
    assert.deepEqual(deal.trips, []);

    assert.deepEqual(deal.items.map((i) => [i.position, i.description]), [[0, 'Mercurial Superfly 10'], [1, 'Tech Fleece']]);
    const [expected, bought] = deal.items;
    assert.equal(expected.deal_id, deal.id);
    assert.equal(expected.cost_status, 'expected');
    assert.equal(expected.expected_unit_cost, 300);
    assert.equal(expected.unit_cost, null);
    assert.equal(expected.qty, 1);
    assert.equal(expected.owner, 'local');
    assert.match(expected.created_at, ISO_TIMESTAMP);
    assert.equal('updated_at' in expected, false, 'deal_items has no updated_at column');
    assert.equal(bought.cost_status, 'actual');
    assert.equal(bought.unit_cost, 80);

    assert.equal(deal.costs.length, 1);
    assert.deepEqual(
      { label: deal.costs[0].label, kind: deal.costs[0].kind, amount: deal.costs[0].amount, is_expected: deal.costs[0].is_expected },
      { label: 'Packaging', kind: 'packaging', amount: 4.5, is_expected: false },
    );

    assert.deepEqual(await store.deals.get(deal.id), deal);
    assert.equal(await store.deals.get(MISSING_ID), null);
    assert.equal(await store.deals.get('SM-0001'), null);
  });

  test('create() with no client, items or costs uses today (London) as the sale date', async () => {
    const { store } = await memoryStore();
    const deal = await store.deals.create({ deal: {} });
    assert.equal(deal.client_id, null);
    assert.equal(deal.client, null);
    assert.equal(deal.sale_date, londonToday());
    assert.deepEqual([deal.items, deal.costs], [[], []]);
  });

  test('numbers deals per owner as max + 1', async () => {
    const { store } = await memoryStore();
    const one = await store.deals.create({ deal: { title: 'one' } });
    const two = await store.deals.create({ deal: { title: 'two' } });
    assert.deepEqual([one.number, two.number], [1, 2]);

    await store.deals.remove(two.id);
    assert.equal((await store.deals.create({ deal: {} })).number, 2, 'deleting the newest frees its number');

    await store.deals.remove(one.id);
    assert.equal((await store.deals.create({ deal: {} })).number, 3, 'older gaps are never refilled');
  });

  test('create() is atomic: a bad line saves nothing', async () => {
    const { store, storage } = await memoryStore();
    const changes = watch(store);
    await rejectsWith(
      store.deals.create({
        deal: { title: 'Half a deal' },
        items: [
          { description: 'Fine', unit_price: 10, expected_unit_cost: 5 },
          { description: 'Bought, no cost', unit_price: 10, cost_status: 'actual' },
        ],
      }),
      'Enter what you paid for an item you have bought.',
    );
    await rejectsWith(
      store.deals.create({ deal: {}, items: [{ description: 'To buy', unit_price: 10 }] }),
      'Enter the expected cost for an item you still need to buy.',
    );
    await rejectsWith(store.deals.create({ deal: {}, costs: [{ label: 'Postage', amount: -1 }] }), "Cost amount can't be negative.");
    await rejectsWith(store.deals.create({ deal: { client_id: MISSING_ID } }), 'That client no longer exists.');
    await rejectsWith(store.deals.create({ deal: { client_id: 'nope' } }), "Client isn't valid.");
    await rejectsWith(store.deals.create({ deal: {}, items: 'Boots' }), 'Items and costs must be lists.');
    assert.deepEqual(await store.deals.list(), []);
    assert.equal(changes.count, 0);
    assert.equal(storage.data.has(STORAGE_KEY), false);
    assert.equal((await store.deals.create({ deal: {} })).number, 1, 'failed attempts used no numbers');
  });

  test('list() returns every deal with children, newest sale first then number desc', async () => {
    const { store } = await memoryStore();
    const a = await store.deals.create({ deal: { title: 'a', sale_date: '2026-09-01' } });
    const b = await store.deals.create({ deal: { title: 'b', sale_date: '2026-10-01' } });
    const c = await store.deals.create({ deal: { title: 'c', sale_date: '2026-09-01' } });
    await store.items.create(b.id, { description: 'Hoodie', unit_price: 60, expected_unit_cost: 30 });

    const deals = await store.deals.list();
    assert.deepEqual(deals.map((d) => d.title), ['b', 'c', 'a']);
    assert.deepEqual(deals.map((d) => d.number), [b.number, c.number, a.number]);
    for (const deal of deals) {
      for (const key of ['client', 'items', 'costs', 'payments', 'trips']) assert.ok(key in deal, `${deal.title} has ${key}`);
    }
    assert.equal(deals[0].items.length, 1);
  });

  test('update() changes only writable columns and returns the full deal', async () => {
    const { store } = await memoryStore();
    const { deal } = await seedDeal(store);
    const updated = await store.deals.update(deal.id, {
      ...deal, // views often spread the row they loaded back in
      status: 'delivered',
      due_date: '2026-10-10',
      number: 99,
      owner: 'intruder',
      id: MISSING_ID,
      created_at: '2000-01-01T00:00:00.000Z',
      client: { id: MISSING_ID, name: 'Changed' },
      items: [],
    });
    assert.equal(updated.id, deal.id);
    assert.equal(updated.status, 'delivered');
    assert.equal(updated.due_date, '2026-10-10');
    assert.equal(updated.number, deal.number);
    assert.equal(updated.owner, 'local');
    assert.equal(updated.created_at, deal.created_at);
    assert.ok(updated.updated_at > deal.updated_at);
    assert.deepEqual(updated.client, deal.client);
    assert.equal(updated.items.length, 2, 'embedded children are never written through update()');

    await rejectsWith(store.deals.update(deal.id, { status: 'lost' }), 'Unknown sale status.');
    await rejectsWith(store.deals.update(deal.id, { delivery_method: 'drone' }), 'Unknown delivery method.');
    await rejectsWith(store.deals.update(deal.id, { sale_date: null }), 'Sale date is required.');
    await rejectsWith(store.deals.update(MISSING_ID, { status: 'ready' }), 'That record no longer exists.');
  });
});

describe('memory store: items, costs and payments', () => {
  test('items: create appends after the last position, update marks bought, remove', async () => {
    const { store } = await memoryStore();
    const { deal } = await seedDeal(store);
    const stockItem = await store.stock.create({ name: 'Samba OG', unit_cost: 65 });

    const added = await store.items.create(deal.id, {
      description: 'Samba OG',
      unit_price: '110',
      cost_status: 'actual',
      unit_cost: 65,
      stock_item_id: stockItem.id,
      deal_id: MISSING_ID, // ignored: the dealId argument wins
    });
    assert.equal(added.deal_id, deal.id);
    assert.equal(added.position, 2);
    assert.equal(added.unit_price, 110);
    assert.equal(added.stock_item_id, stockItem.id);

    const inserted = await store.items.create(deal.id, { description: 'Laces', unit_price: 5, expected_unit_cost: 1, position: 0 });
    assert.equal(inserted.position, 0);
    const afterInsert = await store.deals.get(deal.id);
    assert.deepEqual(
      afterInsert.items.map((i) => i.description),
      ['Mercurial Superfly 10', 'Laces', 'Tech Fleece', 'Samba OG'],
      'position, then created_at',
    );

    const [toBuy] = deal.items;
    const bought = await store.items.update(toBuy.id, {
      cost_status: 'actual',
      unit_cost: 280,
      sourced_at: '2026-10-03',
      deal_id: MISSING_ID, // a line never moves to another sale
    });
    assert.equal(bought.cost_status, 'actual');
    assert.equal(bought.unit_cost, 280);
    assert.equal(bought.expected_unit_cost, 300, 'expected cost kept for variance');
    assert.equal(bought.deal_id, deal.id);
    assert.equal(bought.sourced_at, '2026-10-03');

    await rejectsWith(store.items.update(inserted.id, { cost_status: 'actual' }), 'Enter what you paid for an item you have bought.');
    await rejectsWith(store.items.update(inserted.id, { qty: 0 }), 'Quantity must be at least 1.');
    await rejectsWith(store.items.update(inserted.id, { qty: '1.5' }), 'Quantity must be a whole number.');
    await rejectsWith(store.items.update(inserted.id, { description: ' ' }), 'Item description is required.');
    await rejectsWith(store.items.create(deal.id, { description: 'X', stock_item_id: MISSING_ID, cost_status: 'actual', unit_cost: 1 }), 'That stock item no longer exists.');
    await rejectsWith(store.items.create(MISSING_ID, { description: 'X', expected_unit_cost: 1 }), 'That sale no longer exists.');
    await rejectsWith(store.items.create(undefined, { description: 'X', expected_unit_cost: 1 }), 'That sale no longer exists.');

    await store.items.remove(inserted.id);
    assert.equal((await store.deals.get(deal.id)).items.length, 3);
  });

  test('costs: create, update, remove, ordered by creation', async () => {
    const { store } = await memoryStore();
    const { deal } = await seedDeal(store);
    const postage = await store.costs.create(deal.id, { label: 'Postage', kind: 'shipping', amount: '7.99', is_expected: true });
    assert.equal(postage.amount, 7.99);
    assert.equal(postage.is_expected, true);
    assert.deepEqual((await store.deals.get(deal.id)).costs.map((c) => c.label), ['Packaging', 'Postage']);

    const updated = await store.costs.update(postage.id, { amount: 6.5, is_expected: false });
    assert.equal(updated.amount, 6.5);
    assert.equal(updated.is_expected, false);
    await rejectsWith(store.costs.update(postage.id, { kind: 'bribes' }), 'Unknown cost type.');
    await rejectsWith(store.costs.create(deal.id, { amount: 1 }), 'Cost description is required.');

    await store.costs.remove(postage.id);
    assert.deepEqual((await store.deals.get(deal.id)).costs.map((c) => c.label), ['Packaging']);
  });

  test('payments: create (refunds allowed), ordered by paid_at, remove', async () => {
    const { store } = await memoryStore();
    const { deal } = await seedDeal(store);
    const later = await store.payments.create(deal.id, { amount: 300, method: 'bank', paid_at: '2026-10-05' });
    const earlier = await store.payments.create(deal.id, { amount: '£270.00', method: 'cash', paid_at: '2026-10-02', note: 'deposit' });
    const refund = await store.payments.create(deal.id, { amount: -20, paid_at: '2026-10-06' });
    assert.equal(earlier.amount, 270);
    assert.equal(refund.amount, -20);
    assert.equal(refund.method, 'bank');
    assert.deepEqual((await store.deals.get(deal.id)).payments.map((p) => p.id), [earlier.id, later.id, refund.id]);

    await rejectsWith(store.payments.create(deal.id, { amount: 0 }), "Payment amount can't be zero.");
    await rejectsWith(store.payments.create(deal.id, { amount: 10, method: 'crypto' }), 'Unknown payment method.');
    await rejectsWith(store.payments.create(deal.id, {}), 'Payment amount is required.');

    const defaulted = await store.payments.create(deal.id, { amount: 1 });
    assert.equal(defaulted.paid_at, londonToday());

    await store.payments.remove(refund.id);
    assert.equal((await store.deals.get(deal.id)).payments.some((p) => p.id === refund.id), false);
  });
});

describe('memory store: trips', () => {
  test('create() stores inputs with defaults and embeds the linked deal and client', async () => {
    const { store } = await memoryStore();
    const { client, deal } = await seedDeal(store);
    const trip = await store.trips.create(tripInput({ deal_id: deal.id, client_id: client.id, fuel_ppl: '139.95' }));

    assert.match(trip.id, UUID_V4);
    assert.equal(trip.round_trip, true);
    assert.equal(trip.vehicle_cost_per_mile, 0);
    assert.equal(trip.other_costs, 0);
    assert.equal(trip.fuel_ppl, 140, 'numeric(6,1)');
    assert.deepEqual(trip.route_geometry, [[51.5, -0.12], [50.9, -1.4]]);
    assert.deepEqual(trip.deal, { id: deal.id, number: deal.number, title: 'Boots drop' });
    assert.deepEqual(trip.client, { id: client.id, name: 'Bukayo Saka' });

    const embedded = (await store.deals.get(deal.id)).trips;
    assert.equal(embedded.length, 1);
    assert.equal(embedded[0].id, trip.id);
    assert.equal('deal' in embedded[0], false, 'trips inside a deal are plain rows');
  });

  test('create() validates required inputs and checks', async () => {
    const { store } = await memoryStore();
    await rejectsWith(store.trips.create(tripInput({ one_way_miles: '' })), 'Miles is required.');
    await rejectsWith(store.trips.create(tripInput({ mpg: 0 })), 'MPG must be more than 0.');
    await rejectsWith(store.trips.create(tripInput({ fuel_ppl: -1 })), 'Fuel price must be more than 0.');
    await rejectsWith(store.trips.create(tripInput({ fuel_type: 'Petrol' })), 'Fuel type must be E10, E5, B7 or SDV.');
    await rejectsWith(store.trips.create(tripInput({ dest_lng: null })), 'The destination needs both latitude and longitude.');
    await rejectsWith(store.trips.create(tripInput({ deal_id: MISSING_ID })), 'That sale no longer exists.');
    await rejectsWith(store.trips.create(tripInput({ extra_minutes: -5 })), "Extra minutes can't be negative.");
    assert.deepEqual(await store.trips.list(), []);
  });

  test('list() is newest first with embeds; update() and remove()', async () => {
    const { store } = await memoryStore();
    const first = await store.trips.create(tripInput({ trip_date: '2026-10-01', label: 'first' }));
    const sameDayLater = await store.trips.create(tripInput({ trip_date: '2026-10-01', label: 'second' }));
    const newest = await store.trips.create(tripInput({ trip_date: '2026-10-04', label: 'newest' }));

    const trips = await store.trips.list();
    assert.deepEqual(trips.map((t) => t.label), ['newest', 'second', 'first']);
    assert.deepEqual([trips[0].deal, trips[0].client], [null, null]);

    const client = await store.clients.create({ name: 'Cole Palmer' });
    const updated = await store.trips.update(first.id, { client_id: client.id, round_trip: 'false', other_costs: '12.50', other_costs_note: 'ULEZ' });
    assert.equal(updated.round_trip, false);
    assert.equal(updated.other_costs, 12.5);
    assert.deepEqual(updated.client, { id: client.id, name: 'Cole Palmer' });
    assert.ok(updated.updated_at > first.updated_at);

    await store.trips.remove(sameDayLater.id);
    assert.deepEqual((await store.trips.list()).map((t) => t.id), [newest.id, first.id]);
  });
});

describe('memory store: cascades mirror the SQL foreign keys', () => {
  test('deleting a deal deletes its items, costs and payments and unlinks its trips', async () => {
    const { store, storage } = await memoryStore();
    const { client, deal } = await seedDeal(store);
    await store.payments.create(deal.id, { amount: 100 });
    const trip = await store.trips.create(tripInput({ deal_id: deal.id, client_id: client.id }));
    const other = await store.deals.create({ deal: {}, items: [{ description: 'Keep me', expected_unit_cost: 1 }] });

    await store.deals.remove(deal.id);

    const db = savedDatabase(storage);
    assert.deepEqual(db.deals.map((d) => d.id), [other.id]);
    assert.deepEqual(db.deal_items.map((i) => i.deal_id), [other.id]);
    assert.deepEqual(db.deal_costs, []);
    assert.deepEqual(db.payments, []);

    const [kept] = await store.trips.list();
    assert.equal(kept.id, trip.id);
    assert.equal(kept.deal_id, null);
    assert.equal(kept.deal, null);
    assert.equal(kept.client_id, client.id);
    assert.ok(kept.updated_at > trip.updated_at, 'SET NULL is an UPDATE, so updated_at moves');
  });

  test('deleting a client unlinks their deals and trips', async () => {
    const { store } = await memoryStore();
    const { client, deal } = await seedDeal(store);
    const trip = await store.trips.create(tripInput({ deal_id: deal.id, client_id: client.id }));

    await store.clients.remove(client.id);

    const orphan = await store.deals.get(deal.id);
    assert.equal(orphan.client_id, null);
    assert.equal(orphan.client, null);
    assert.equal(orphan.items.length, 2, 'the sale itself is kept');
    const [unlinked] = await store.trips.list();
    assert.equal(unlinked.id, trip.id);
    assert.equal(unlinked.client_id, null);
    assert.equal(unlinked.deal_id, deal.id);
  });

  test('deleting a stock item unlinks the sale lines that used it', async () => {
    const { store } = await memoryStore();
    const stockItem = await store.stock.create({ name: 'Samba OG', unit_cost: 65 });
    const deal = await store.deals.create({
      deal: {},
      items: [{ description: 'Samba OG', unit_price: 110, cost_status: 'actual', unit_cost: 65, stock_item_id: stockItem.id }],
    });
    await store.stock.remove(stockItem.id);
    const [item] = (await store.deals.get(deal.id)).items;
    assert.equal(item.stock_item_id, null);
    assert.equal(item.unit_cost, 65, 'the cost already taken from stock stays');
  });
});

describe('memory store: change notifications', () => {
  test('subscribers hear every successful write once, and nothing for reads or failures', async () => {
    const { store } = await memoryStore();
    const changes = watch(store);

    await store.settings.get();
    await store.clients.list();
    await store.deals.list();
    await store.trips.list();
    assert.equal(changes.count, 0, 'reads');

    await store.settings.save({ mpg: 50 });
    const client = await store.clients.create({ name: 'Reece James' });
    await store.clients.update(client.id, { club: 'Chelsea' });
    const deal = await store.deals.create({
      deal: { client_id: client.id },
      items: [{ description: 'A', expected_unit_cost: 1 }, { description: 'B', expected_unit_cost: 1 }],
      costs: [{ label: 'Fee', amount: 1 }],
    });
    assert.equal(changes.count, 4, 'a sale with lines is one write');

    await store.deals.update(deal.id, { status: 'ready' });
    const item = await store.items.create(deal.id, { description: 'C', expected_unit_cost: 2 });
    await store.items.update(item.id, { qty: 2 });
    await store.items.remove(item.id);
    const cost = await store.costs.create(deal.id, { label: 'Post', amount: 3 });
    await store.costs.update(cost.id, { amount: 4 });
    await store.costs.remove(cost.id);
    const payment = await store.payments.create(deal.id, { amount: 10 });
    await store.payments.remove(payment.id);
    const trip = await store.trips.create(tripInput());
    await store.trips.update(trip.id, { label: 'x' });
    await store.trips.remove(trip.id);
    const stockItem = await store.stock.create({ name: 'S', unit_cost: 1 });
    await store.stock.update(stockItem.id, { qty: 3 });
    await store.stock.remove(stockItem.id);
    await store.deals.remove(deal.id);
    await store.clients.remove(client.id);
    assert.equal(changes.count, 4 + 17);

    await assert.rejects(store.clients.create({}));
    await assert.rejects(store.deals.update(MISSING_ID, { status: 'ready' }));
    assert.equal(changes.count, 21, 'failed writes');

    const sameClient = await store.clients.create({ name: 'Unchanged' });
    await store.clients.update(sameClient.id, { not_a_column: true });
    assert.equal(changes.count, 22, 'an update with nothing writable is not a write');

    changes.stop();
    await store.clients.create({ name: 'After unsubscribe' });
    assert.equal(changes.count, 22);
  });

  test('a throwing subscriber neither fails the write nor starves other subscribers', async (t) => {
    const logged = t.mock.method(console, 'error', () => {});
    const { store } = await memoryStore();
    store.subscribe(() => {
      throw new Error('view blew up');
    });
    const changes = watch(store);
    const client = await store.clients.create({ name: 'Still saved' });
    assert.equal((await store.clients.get(client.id)).name, 'Still saved');
    assert.equal(changes.count, 1);
    assert.equal(logged.mock.callCount(), 1);
  });

  test('subscribe() requires a function', async () => {
    const { store } = await memoryStore();
    assert.throws(() => store.subscribe('refresh'), TypeError);
  });
});

describe('memory store: persistence and isolation', () => {
  test('data round-trips through storage into a fresh store', async () => {
    const storage = fakeStorage();
    const { store: first } = await memoryStore({ storage });
    await first.settings.save({ home_address: 'Home', mpg: 48 });
    const { client, deal } = await seedDeal(first);
    await first.payments.create(deal.id, { amount: 200 });
    await first.trips.create(tripInput({ deal_id: deal.id }));

    const raw = savedDatabase(storage);
    assert.equal(raw.version, 1);
    assert.equal(raw.deals.length, 1);

    const { store: second } = await memoryStore({ storage });
    assert.deepEqual(await second.deals.list(), await first.deals.list());
    assert.deepEqual(await second.trips.list(), await first.trips.list());
    assert.deepEqual(await second.settings.get(), await first.settings.get());
    assert.deepEqual(await second.clients.get(client.id), await first.clients.get(client.id));
    assert.equal((await second.deals.create({ deal: {} })).number, 2, 'numbering continues after reload');
  });

  test('unreadable saved data is set aside, not overwritten, and the store starts empty', async (t) => {
    const warned = t.mock.method(console, 'warn', () => {});
    const storage = fakeStorage({ [STORAGE_KEY]: '{not json' });
    const { store } = await memoryStore({ storage });
    assert.deepEqual(await store.deals.list(), []);
    assert.equal(storage.data.get(`${STORAGE_KEY}.unreadable`), '{not json');
    assert.equal(warned.mock.callCount(), 1);
    await store.clients.create({ name: 'Fresh start' });
    assert.equal(savedDatabase(storage).clients.length, 1);
  });

  test('a storage write failure rejects the write and keeps the previous state', async () => {
    const storage = fakeStorage();
    const { store } = await memoryStore({ storage });
    const client = await store.clients.create({ name: 'Saved' });
    const changes = watch(store);
    storage.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    await rejectsWith(
      store.clients.update(client.id, { club: 'Lost' }),
      "Couldn't save on this device — the browser's storage is full or blocked.",
    );
    assert.equal((await store.clients.get(client.id)).club, null);
    assert.equal(changes.count, 0);
  });

  test('works without any storage (storage: null)', async () => {
    const { store } = await memoryStore({ storage: null });
    const client = await store.clients.create({ name: 'Ephemeral' });
    assert.equal((await store.clients.get(client.id)).name, 'Ephemeral');
  });

  test('returned rows are copies that cannot change the store', async () => {
    const { store } = await memoryStore();
    const { deal } = await seedDeal(store);
    deal.items[0].unit_price = 1;
    deal.client.name = 'Hacked';
    const listed = await store.deals.list();
    listed[0].items.push({ description: 'ghost' });
    const fresh = await store.deals.get(deal.id);
    assert.equal(fresh.items.length, 2);
    assert.equal(fresh.items[0].unit_price, 450);
    assert.equal(fresh.client.name, 'Bukayo Saka');
  });
});

describe('memory store: server API calls', () => {
  function recordingFetch(respond) {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return respond(url, init);
    };
    return { calls, fetchImpl };
  }

  function jsonResponse(status, body) {
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  }

  test('fuel() rounds coordinates to 2 dp and sends no Authorization header', async () => {
    const body = { ok: true, type: 'E10', ppl: 139.9 };
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse(200, body));
    const { store } = await memoryStore({ fetchImpl });

    assert.deepEqual(await store.api.fuel({ lat: 50.90973, lng: -1.40442, type: 'e10' }), body);
    assert.equal(calls[0].url, '/api/fuel?lat=50.91&lng=-1.40&type=E10');
    assert.equal(calls[0].init.method, 'GET');
    assert.equal('Authorization' in calls[0].init.headers, false);

    await store.api.fuel({ type: 'B7' });
    assert.equal(calls[1].url, '/api/fuel?type=B7', 'no coordinates: national price only');
    await store.api.fuel({ lat: null, lng: -1.4 });
    assert.equal(calls[2].url, '/api/fuel', 'half a coordinate is no coordinate');
  });

  test('fuel() surfaces the server error sentence', async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse(400, { error: 'Fuel type must be one of E10, E5, B7, SDV.' }));
    const { store } = await memoryStore({ fetchImpl });
    await rejectsWith(store.api.fuel({ type: 'X' }), 'Fuel type must be one of E10, E5, B7, SDV.');
  });

  test('route() and places() explain clearly that they need the server and an account', async () => {
    const offline = recordingFetch(() => {
      throw new TypeError('fetch failed');
    });
    const { store: offlineStore } = await memoryStore({ fetchImpl: offline.fetchImpl });
    await rejectsWith(
      offlineStore.api.route({ address: 'SW1A 1AA' }, { address: 'SO16 7AY' }),
      "Can't reach the Sizemill server — type the miles and driving time instead.",
    );
    await rejectsWith(offlineStore.api.places('Southampton'), "Can't reach the Sizemill server — type the address instead.");
    assert.equal('Authorization' in offline.calls[0].init.headers, false);
    assert.deepEqual(JSON.parse(offline.calls[0].init.body), {
      origin: { address: 'SW1A 1AA' },
      destination: { address: 'SO16 7AY' },
    });

    const online = recordingFetch(() => jsonResponse(401, { error: 'Sign in to use this.' }));
    const { store: onlineStore } = await memoryStore({ fetchImpl: online.fetchImpl });
    await rejectsWith(
      onlineStore.api.route({ lat: 51.5, lng: -0.12 }, { lat: 50.9, lng: -1.4 }),
      "Route lookup needs a signed-in Sizemill account, so it's off in local mode — type the miles and driving time instead.",
    );
    await rejectsWith(
      onlineStore.api.places('  SO16   7AY '),
      "Address search needs a signed-in Sizemill account, so it's off in local mode — type the address instead.",
    );
    assert.equal(online.calls[1].url, '/api/places?q=SO16%207AY');
  });

  test('places() skips the request for queries under 3 characters; route() needs both ends', async () => {
    const { store } = await memoryStore();
    assert.deepEqual(await store.api.places('so'), { ok: true, results: [] });
    assert.deepEqual(await store.api.places(null), { ok: true, results: [] });
    await rejectsWith(store.api.route(null, { address: 'x' }), 'Choose where the trip starts and ends.');
  });
});

// ---------------------------------------------------------------------------------------------
// Branding: logo and brand colour
// ---------------------------------------------------------------------------------------------

// The 1×1 transparent PNG every browser knows.
const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const pngBlob = () => new Blob([TINY_PNG], { type: 'image/png' });

describe('memory store: branding', () => {
  test('brand_color is checked as #RRGGBB', async () => {
    const { store } = await memoryStore();
    const saved = await store.settings.save({ brand_color: '#0F6E74', business_name: 'Umi Sneakers' });
    assert.equal(saved.brand_color, '#0F6E74');
    assert.equal(saved.business_name, 'Umi Sneakers');
    await rejectsWith(store.settings.save({ brand_color: 'teal' }), 'Use a colour like #1F4B85.');
    await rejectsWith(store.settings.save({ brand_color: '#0F6E7' }), 'Use a colour like #1F4B85.');
    assert.equal((await store.settings.save({ brand_color: '' })).brand_color, null, 'clearing goes back to the default');
  });

  test('uploadLogo() keeps the image as a data: URL with its size, and survives a reload', async () => {
    const { store, storage } = await memoryStore();
    const changes = watch(store);
    const saved = await store.settings.uploadLogo(pngBlob(), { width: 512, height: 171 });
    assert.equal(saved.logo_url, `data:image/png;base64,${TINY_PNG.toString('base64')}#w=512&h=171`);
    assert.equal(changes.count, 1);
    assert.equal(savedDatabase(storage).desk_settings[0].logo_url, saved.logo_url);
    const reloaded = await createStore({ mode: 'memory', storage, fetchImpl: refuseFetch });
    assert.equal((await reloaded.settings.get()).logo_url, saved.logo_url);

    const replaced = await store.settings.uploadLogo(new Blob([TINY_PNG], { type: 'image/webp' }));
    assert.match(replaced.logo_url, /^data:image\/webp;base64,[^#]+$/, 'no size fragment when the size is unknown');
  });

  test('uploadLogo() refuses anything but a PNG, JPEG or WebP of at most 1 MB', async () => {
    const { store } = await memoryStore();
    await rejectsWith(store.settings.uploadLogo(new Blob(['<svg/>'], { type: 'image/svg+xml' })), 'Use a PNG, JPG or WebP image.');
    await rejectsWith(store.settings.uploadLogo(new Blob(['hello'], { type: 'text/plain' })), 'Use a PNG, JPG or WebP image.');
    await rejectsWith(store.settings.uploadLogo(new Blob([], { type: 'image/png' })), 'Use a PNG, JPG or WebP image.');
    await rejectsWith(store.settings.uploadLogo(new Blob([new Uint8Array(1_048_577)], { type: 'image/png' })), 'That logo is over 1 MB — pick a smaller image.');
    await rejectsWith(store.settings.uploadLogo(null), 'Choose an image for your logo.');
    await rejectsWith(store.settings.uploadLogo('logo.png'), 'Choose an image for your logo.');
    assert.equal((await store.settings.get()).logo_url, null);
  });

  test('removeLogo() clears logo_url and keeps the other settings', async () => {
    const { store } = await memoryStore();
    await store.settings.save({ business_name: 'Umi Sneakers', brand_color: '#8C1D40' });
    await store.settings.uploadLogo(pngBlob());
    const saved = await store.settings.removeLogo();
    assert.equal(saved.logo_url, null);
    assert.equal(saved.business_name, 'Umi Sneakers');
    assert.equal(saved.brand_color, '#8C1D40');
  });

  test('settings.save() refuses a logo_url that is not https or an image data: URL', async () => {
    const { store } = await memoryStore();
    await rejectsWith(store.settings.save({ logo_url: 'javascript:alert(1)' }), "That logo can't be saved — upload it again.");
    await rejectsWith(store.settings.save({ logo_url: `https://x.example/${'a'.repeat(2050)}` }), "That logo can't be saved — upload it again.");
    assert.equal((await store.settings.save({ logo_url: 'https://x.example/logo.png' })).logo_url, 'https://x.example/logo.png');
  });
});

// ---------------------------------------------------------------------------------------------
// Supabase mode against a recording fake client
// ---------------------------------------------------------------------------------------------

const SESSION = { access_token: 'token-123', user: { id: '11111111-1111-4111-8111-111111111111', email: 'owner@sizemill.com' } };

// Records every query builder chain; awaiting a chain resolves to respond(call).
function fakeSupabase({ session = SESSION, respond = () => ({ data: null, error: null, status: 200 }) } = {}) {
  const calls = [];
  let authListener = null;
  const client = {
    calls,
    session,
    auth: {
      getSession: async () => ({ data: { session: client.session }, error: null }),
      onAuthStateChange(callback) {
        authListener = callback;
        return { data: { subscription: { unsubscribe() {} } } };
      },
      signInWithPassword: async () => ({ data: null, error: { name: 'AuthApiError', status: 400, code: 'invalid_credentials', message: 'Invalid login credentials' } }),
      signOut: async () => ({ error: null }),
    },
    fireAuth(event, nextSession) {
      authListener(event, nextSession);
    },
    storageCalls: [],
    storageFiles: [],
    storageRespond: {},
    storage: {
      from(bucket) {
        const record = (method, ...args) => {
          client.storageCalls.push([bucket, method, ...args]);
          return client.storageRespond[method]?.(...args) ?? { data: null, error: null };
        };
        return {
          upload: async (...args) => record('upload', ...args),
          getPublicUrl: (path) => ({ data: { publicUrl: `https://project.supabase.co/storage/v1/object/public/${bucket}/${path}` } }),
          list: async (...args) => {
            record('list', ...args);
            return { data: client.storageFiles.map((name) => ({ name })), error: null };
          },
          remove: async (...args) => record('remove', ...args),
        };
      },
    },
    from(table) {
      const call = { table, chain: [] };
      calls.push(call);
      const builder = new Proxy({}, {
        get(_, method) {
          if (method === 'then') {
            return (onFulfilled, onRejected) => Promise.resolve().then(() => respond(call)).then(onFulfilled, onRejected);
          }
          return (...args) => {
            call.chain.push([method, ...args]);
            return builder;
          };
        },
      });
      return builder;
    },
  };
  return client;
}

const step = (call, method) => call.chain.find(([name]) => name === method);

async function supabaseStore(options = {}) {
  const client = fakeSupabase(options);
  const store = await createStore({ mode: 'supabase', supabaseClient: client, fetchImpl: options.fetchImpl ?? refuseFetch });
  return { store, client };
}

describe('supabase mode (fake client)', () => {
  test('auth: user from the stored session, onChange only on identity changes', async () => {
    const { store, client } = await supabaseStore();
    assert.equal(store.mode, 'supabase');
    assert.deepEqual(store.auth.user(), { id: SESSION.user.id, email: 'owner@sizemill.com' });

    const seen = [];
    store.auth.onChange((user) => seen.push(user));
    client.fireAuth('TOKEN_REFRESHED', SESSION);
    assert.deepEqual(seen, [], 'a token refresh is not a change');
    client.fireAuth('SIGNED_OUT', null);
    assert.deepEqual(seen, [null]);
    assert.equal(store.auth.user(), null);
    await rejectsWith(store.clients.list(), "You're signed out — sign in again.");

    await rejectsWith(store.auth.signIn('owner@sizemill.com', 'wrong'), 'Wrong email or password.');
    await rejectsWith(store.auth.signIn('  ', 'pw'), 'Enter your email address.');
    await rejectsWith(store.auth.signIn('owner@sizemill.com', ''), 'Enter your password.');
  });

  test('every data method returns a promise, rejecting (not throwing) on bad input', async () => {
    const { store, client } = await supabaseStore();
    const calls = [
      () => store.settings.save('mpg=45'),
      () => store.clients.create(null),
      () => store.clients.update('not-an-id', {}),
      () => store.stock.create([]),
      () => store.deals.create({ deal: 'x' }),
      () => store.deals.update(MISSING_ID, null),
      () => store.deals.remove('SM-0001'),
      () => store.items.create('bad', {}),
      () => store.items.update(MISSING_ID, null),
      () => store.costs.update(MISSING_ID, null),
      () => store.payments.create('bad', {}),
      () => store.trips.create(null),
      () => store.trips.update(MISSING_ID, null),
    ];
    for (const call of calls) {
      const result = call();
      assert.ok(result instanceof Promise, call.toString());
      await assert.rejects(result);
    }
    assert.equal(client.calls.length, 0, 'nothing reached the database');
  });

  test('writes are whitelisted and coerced before they are sent', async () => {
    const row = { id: 'c1', name: 'Bukayo Saka' };
    const { store, client } = await supabaseStore({ respond: () => ({ data: row, error: null, status: 201 }) });
    const changes = watch(store);
    const created = await store.clients.create({
      name: ' Bukayo Saka ',
      club: '',
      tags: 'vip',
      id: 'x',
      owner: 'y',
      created_at: 'z',
      updated_at: 'z',
      number: 1,
      invented: true,
    });
    assert.equal(created, row);
    const [call] = client.calls;
    assert.equal(call.table, 'clients');
    assert.deepEqual(step(call, 'insert')[1], { name: 'Bukayo Saka', club: null, tags: ['vip'] });
    assert.deepEqual(step(call, 'select'), ['select', '*']);
    assert.ok(step(call, 'single'));
    assert.equal(changes.count, 1);
  });

  test('deals.list() is one embedded select with ordered children', async () => {
    const { store, client } = await supabaseStore({ respond: () => ({ data: [], error: null, status: 200 }) });
    await store.deals.list();
    const [call] = client.calls;
    assert.equal(call.table, 'deals');
    const select = step(call, 'select')[1];
    for (const part of ['client:clients', '(id,name,club)', 'items:deal_items(*)', 'costs:deal_costs(*)', 'payments(*)', 'trips']) {
      assert.ok(select.includes(part), `select includes ${part}`);
    }
    const orders = call.chain.filter(([name]) => name === 'order').map(([, column, options]) => [options.referencedTable ?? '', column, options.ascending]);
    assert.deepEqual(orders, [
      ['items', 'position', true],
      ['items', 'created_at', true],
      ['costs', 'created_at', true],
      ['payments', 'paid_at', true],
      ['payments', 'created_at', true],
      ['trips', 'trip_date', true],
      ['trips', 'created_at', true],
      ['', 'sale_date', false],
      ['', 'number', false],
    ]);
  });

  test('trips.list() embeds the deal and client, newest first', async () => {
    const { store, client } = await supabaseStore({ respond: () => ({ data: [], error: null, status: 200 }) });
    await store.trips.list();
    const [call] = client.calls;
    const select = step(call, 'select')[1];
    assert.ok(select.includes('deal:deals') && select.includes('(id,number,title)'));
    assert.ok(select.includes('client:clients') && select.includes('(id,name)'));
    const orders = call.chain.filter(([name]) => name === 'order').map(([, column, options]) => [column, options.ascending]);
    assert.deepEqual(orders, [['trip_date', false], ['created_at', false], ['id', true]]);
  });

  test('database errors become human sentences', async () => {
    const cases = [
      [{ code: '42501', message: 'new row violates row-level security policy for table "deals"' }, 403, 'That client no longer exists — reload the page.'],
      [{ code: '42501', message: 'new row violates row-level security policy for table "payments"' }, 403, 'That sale no longer exists — reload the page.'],
      [{ code: '42501', message: 'new row violates row-level security policy for table "deal_items"' }, 403, 'That sale or stock item no longer exists — reload the page.'],
      [{ code: '42501', message: 'new row violates row-level security policy for table "trips"' }, 403, 'That sale or client no longer exists — reload the page.'],
      [{ code: '42501', message: 'permission denied for table clients' }, 403, "You don't have access to that record."],
      [{ code: '', message: 'TypeError: Failed to fetch' }, 0, "Can't reach the server — check your connection."],
      [{ code: '23514', message: 'new row for relation "deal_items" violates check constraint "deal_items_qty_positive"' }, 400, 'Quantity must be at least 1.'],
      [{ code: '23502', message: 'null value in column "name" of relation "clients" violates not-null constraint' }, 400, 'Name is required.'],
      [{ code: '23503', message: 'insert or update on table "deals" violates foreign key constraint "deals_client_id_fkey"' }, 409, 'That client no longer exists.'],
      [{ code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' }, 406, 'That record no longer exists.'],
      [{ code: 'PGRST205', message: "Could not find the table 'public.clients' in the schema cache" }, 404, "Desk's database isn't set up yet — apply the Supabase migration."],
      [{ code: 'PGRST301', message: 'JWT expired' }, 401, 'Your session has expired — sign in again.'],
      [{ code: '42501', message: 'permission denied for table clients' }, 401, 'Your session has expired — sign in again.'],
    ];
    for (const [error, status, message] of cases) {
      const { store } = await supabaseStore({ respond: () => ({ data: null, error, status }) });
      await rejectsWith(store.clients.create({ name: 'X' }), message);
    }
  });

  test('deals.create() checks every line first, then rolls the sale back if a line insert fails', async () => {
    const dealId = '22222222-2222-4222-8222-222222222222';
    const respond = (call) => {
      if (call.table === 'deals' && step(call, 'insert')) return { data: { id: dealId }, error: null, status: 201 };
      if (call.table === 'deal_items') return { data: null, error: { code: '', message: 'TypeError: Failed to fetch' }, status: 0 };
      return { data: null, error: null, status: 204 };
    };
    const { store, client } = await supabaseStore({ respond });
    const changes = watch(store);

    await rejectsWith(
      store.deals.create({ deal: {}, items: [{ description: 'No cost yet', unit_price: 50 }] }),
      'Enter the expected cost for an item you still need to buy.',
    );
    assert.equal(client.calls.length, 0, 'nothing sent for an invalid line');

    await rejectsWith(
      store.deals.create({ deal: { title: 'Boots' }, items: [{ description: 'Boots', unit_price: 450, expected_unit_cost: 300 }] }),
      "Can't reach the server — check your connection.",
    );
    const [insertDeal, insertItems, rollback] = client.calls;
    assert.deepEqual(step(insertDeal, 'insert')[1], { title: 'Boots' });
    assert.deepEqual(step(insertItems, 'insert'), [
      'insert',
      [{ position: 0, description: 'Boots', unit_price: 450, expected_unit_cost: 300, deal_id: dealId }],
      { defaultToNull: false },
    ]);
    assert.equal(rollback.table, 'deals');
    assert.ok(step(rollback, 'delete'));
    assert.deepEqual(step(rollback, 'eq'), ['eq', 'id', dealId]);
    assert.equal(changes.count, 0);
  });

  test('settings.save() upserts on owner and merges over the defaults', async () => {
    const stored = { owner: SESSION.user.id, mpg: 52, business_name: null, updated_at: '2026-10-05T10:00:00Z' };
    const { store, client } = await supabaseStore({ respond: () => ({ data: stored, error: null, status: 200 }) });
    const saved = await store.settings.save({ mpg: '52', owner: 'someone-else' });
    const [call] = client.calls;
    assert.equal(call.table, 'desk_settings');
    assert.deepEqual(step(call, 'upsert'), ['upsert', { mpg: 52 }, { onConflict: 'owner' }]);
    assert.equal(saved.mpg, 52);
    assert.equal(saved.business_name, 'Sizemill');
    assert.equal(saved.hourly_rate, 20);
  });

  test('api.route() and api.places() send the bearer token; api.fuel() does not', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };
    const { store } = await supabaseStore({ fetchImpl });
    await store.api.route({ lat: 51.5, lng: -0.12 }, { address: 'SO16 7AY' });
    await store.api.places('Southampton');
    await store.api.fuel({ lat: 51.5049, lng: -0.1235, type: 'E10' });
    assert.equal(calls[0].url, '/api/route');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer token-123');
    assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
    assert.equal(calls[1].init.headers.Authorization, 'Bearer token-123');
    assert.equal(calls[2].url, '/api/fuel?lat=51.50&lng=-0.12&type=E10');
    assert.equal('Authorization' in calls[2].init.headers, false);
  });

  test('api errors prefer the server sentence, then a status message', async () => {
    let reply = { ok: false, status: 422, json: async () => ({ error: "Couldn't find 'xyz'. Try a postcode." }) };
    const { store } = await supabaseStore({ fetchImpl: async () => reply });
    await rejectsWith(store.api.route({ address: 'xyz' }, { address: 'SO16 7AY' }), "Couldn't find 'xyz'. Try a postcode.");
    reply = { ok: false, status: 502, json: async () => { throw new SyntaxError('Unexpected token <'); } };
    await rejectsWith(store.api.places('Southampton'), 'The server had a problem — try again in a moment.');
  });

  test('lists page through every row with .range(), not just the first 1000', async () => {
    const page = (from, count) => Array.from({ length: count }, (_, i) => ({ id: `d${from + i}` }));
    const respond = (call) => {
      const [, from] = step(call, 'range');
      return { data: page(from, from === 0 ? 1000 : 1), error: null, status: 200 };
    };
    const { store, client } = await supabaseStore({ respond });
    const deals = await store.deals.list();
    assert.equal(deals.length, 1001);
    assert.deepEqual(client.calls.map((call) => step(call, 'range')), [['range', 0, 999], ['range', 1000, 1999]]);
    for (const call of client.calls) assert.ok(step(call, 'order'), 'every page is ordered');

    client.calls.length = 0;
    await store.clients.list();
    await store.stock.list({ includeArchived: true });
    await store.trips.list();
    assert.equal(client.calls.length, 6, 'two pages each');
    const clientOrders = client.calls[0].chain.filter(([name]) => name === 'order').map(([, column]) => column);
    assert.deepEqual(clientOrders, ['name', 'created_at', 'id'], 'a unique last key keeps pages from overlapping');
  });

  test('settings.uploadLogo() uploads to brand/<uid>/, saves the public URL, then removes older logos', async () => {
    const stored = { owner: SESSION.user.id, logo_url: 'saved', updated_at: '2026-10-05T10:00:00Z' };
    const { store, client } = await supabaseStore({ respond: () => ({ data: stored, error: null, status: 200 }) });
    client.storageFiles = ['logo-1.png', 'logo-2.webp'];
    const changes = watch(store);
    const blob = pngBlob();
    const saved = await store.settings.uploadLogo(blob, { width: 512, height: 171 });
    assert.equal(saved.logo_url, 'saved');

    const [upload, list, remove] = client.storageCalls;
    assert.equal(upload[0], 'brand');
    assert.equal(upload[1], 'upload');
    assert.match(upload[2], new RegExp(`^${SESSION.user.id}/logo-\\d{13}\\.png$`));
    assert.equal(upload[3], blob);
    assert.deepEqual(upload[4], { contentType: 'image/png', cacheControl: '31536000', upsert: false });
    const [save] = client.calls;
    assert.deepEqual(step(save, 'upsert'), [
      'upsert',
      { logo_url: `https://project.supabase.co/storage/v1/object/public/brand/${upload[2]}#w=512&h=171` },
      { onConflict: 'owner' },
    ]);
    assert.deepEqual(list, ['brand', 'list', SESSION.user.id, { limit: 100 }]);
    assert.deepEqual(remove, ['brand', 'remove', [`${SESSION.user.id}/logo-1.png`, `${SESSION.user.id}/logo-2.webp`]]);
    assert.equal(changes.count, 1);
  });

  test('settings.uploadLogo() keeps the old logo when saving fails, and explains upload errors', async () => {
    const { store, client } = await supabaseStore({
      respond: () => ({ data: null, error: { code: '', message: 'TypeError: Failed to fetch' }, status: 0 }),
    });
    client.storageFiles = ['logo-1.png'];
    await rejectsWith(store.settings.uploadLogo(pngBlob()), "Can't reach the server — check your connection.");
    const removes = client.storageCalls.filter(([, method]) => method === 'remove');
    assert.equal(removes.length, 1);
    assert.equal(removes[0][2].length, 1);
    assert.match(removes[0][2][0], /\/logo-\d{13}\.png$/, 'only the new file is deleted');

    client.storageCalls.length = 0;
    client.calls.length = 0;
    client.storageRespond.upload = () => ({ data: null, error: { statusCode: '413', message: 'The object exceeded the maximum allowed size' } });
    await rejectsWith(store.settings.uploadLogo(pngBlob()), 'That logo is over 1 MB — pick a smaller image.');
    assert.equal(client.calls.length, 0, 'nothing saved');
    client.storageRespond.upload = () => ({ data: null, error: { statusCode: '403', message: 'new row violates row-level security policy' } });
    await rejectsWith(store.settings.uploadLogo(pngBlob()), "You don't have access to that record.");
    await rejectsWith(store.settings.uploadLogo(new Blob(['x'], { type: 'image/gif' })), 'Use a PNG, JPG or WebP image.');

    client.fireAuth('SIGNED_OUT', null);
    await rejectsWith(store.settings.uploadLogo(pngBlob()), "You're signed out — sign in again.");
  });

  test('settings.removeLogo() clears logo_url, then deletes the files', async () => {
    const { store, client } = await supabaseStore({ respond: () => ({ data: { logo_url: null }, error: null, status: 200 }) });
    client.storageFiles = ['logo-1.png'];
    const saved = await store.settings.removeLogo();
    assert.equal(saved.logo_url, null);
    assert.deepEqual(step(client.calls[0], 'upsert'), ['upsert', { logo_url: null }, { onConflict: 'owner' }]);
    assert.deepEqual(client.storageCalls.at(-1), ['brand', 'remove', [`${SESSION.user.id}/logo-1.png`]]);

    client.storageRespond.remove = () => { throw new Error('offline'); };
    await store.settings.removeLogo(); // a failed tidy-up never fails the removal
  });
});

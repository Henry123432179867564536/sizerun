import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  search,
  normalize,
  tokenize,
  parseDealNumber,
  itemsSummary,
  groupItems,
  groupStats,
} from '../public/desk/lib/search.js';
import { dealTotals } from '../public/desk/lib/calc.js';

const TS = 'Travis Scott Jordan 1 Low';

const clients = [
  { id: 'c1', name: 'Marcus Rashford', club: 'Manchester United', position: 'Forward', agent_name: 'Dwaine Maynard', phone: '+44 7700 900123', instagram: '@marcusrashford', tags: ['vip', 'travis'] },
  { id: 'c2', name: 'Martin Ødegaard', club: 'Arsenal', position: 'Midfielder', agent_name: 'Jorge Mendes', phone: '07700 900456', instagram: '@odegaard.98', tags: [] },
  { id: 'c3', name: "Dara O'Shea", club: 'Ipswich Town', position: 'Defender', phone: null, tags: ['new'] },
  { id: 'c4', name: 'Bukayo Saka', club: 'Arsenal', position: 'Winger', tags: [] },
  { id: 'c5', name: 'N\'Golo Kanté', club: 'Al-Ittihad', position: 'Midfielder', tags: [] },
  { id: 'c6', name: 'Mark Travers', club: 'Bournemouth', position: 'Goalkeeper', tags: [] },
];

function item(over) {
  return { id: `i-${Math.random().toString(36).slice(2)}`, position: 0, description: TS, brand: 'Nike', sku: 'DM7866-162', size: '10', qty: 1, unit_price: 900, cost_status: 'actual', unit_cost: 600, expected_unit_cost: 650, ...over };
}

function deal(over) {
  const clientRow = clients.find((c) => c.id === over.client_id);
  return {
    id: `d${over.number}`,
    status: 'delivered',
    sale_date: '2026-09-01',
    title: null,
    notes: null,
    client: clientRow ? { id: clientRow.id, name: clientRow.name, club: clientRow.club } : null,
    items: [],
    costs: [],
    payments: [],
    trips: [],
    ...over,
  };
}

const deals = [
  // Marcus: a three-item order, all actual cost.
  deal({ number: 1, client_id: 'c1', sale_date: '2026-08-01', items: [
    item({ size: '9', unit_price: 950, unit_cost: 600 }),
    item({ position: 1, description: 'Supreme Box Logo Hoodie', brand: 'Supreme', sku: 'FW23', size: 'L', unit_price: 400, unit_cost: 250 }),
    item({ position: 2, description: 'Nike Tech Fleece', brand: 'Nike', sku: null, size: 'M', qty: 2, unit_price: 120, unit_cost: 80 }),
  ], payments: [{ amount: 1590 }] }),
  // Marcus: second order, expected cost (estimated profit), with a delivery cost.
  deal({ number: 7, client_id: 'c1', sale_date: '2026-09-20', items: [
    item({ size: '9.5', unit_price: 1000, cost_status: 'expected', unit_cost: null, expected_unit_cost: 700 }),
  ], costs: [{ amount: 15, is_expected: false }] }),
  // Ødegaard: qty 2 of the Travis pair.
  deal({ number: 3, client_id: 'c2', sale_date: '2026-09-05', items: [item({ size: '10', qty: 2, unit_price: 850, unit_cost: 620 })] }),
  // O'Shea: cancelled order (shown, never totalled).
  deal({ number: 4, client_id: 'c3', status: 'cancelled', sale_date: '2026-09-10', items: [item({ size: '11', unit_price: 880, unit_cost: 610 })] }),
  // Saka: travis pair and a title/notes match.
  deal({ number: 5, client_id: 'c4', sale_date: '2026-09-12', title: 'Birthday gift run', notes: 'Wrap it, card from the squad', items: [item({ size: '8', unit_price: 920, unit_cost: 640 })] }),
  // Kanté: different casing of the same description.
  deal({ number: 6, client_id: 'c5', sale_date: '2026-09-15', items: [item({ description: 'travis scott jordan 1 low', size: '8.5', unit_price: 870, unit_cost: 615 })] }),
  // Marcus again, older, Air Force 1.
  deal({ number: 2, client_id: 'c1', sale_date: '2026-07-01', items: [item({ description: 'Air Force 1 Low White', sku: 'CW2288-111', size: '9', unit_price: 150, unit_cost: 90 })] }),
];

const data = { clients, deals };

describe('normalize / tokenize', () => {
  test('folds case, accents and letters NFD cannot split', () => {
    assert.equal(normalize('Ødegaard'), 'odegaard');
    assert.equal(normalize('Kanté'), 'kante');
    assert.equal(normalize('Æsir Straße'), 'aesir strasse');
    assert.equal(normalize('Łukasz'), 'lukasz');
  });
  test('drops apostrophes, turns other punctuation into spaces, keeps decimal sizes', () => {
    assert.equal(normalize("Dara O'Shea"), 'dara oshea');
    assert.equal(normalize('O’Shea'), 'oshea');
    assert.equal(normalize('DM7866-162'), 'dm7866 162');
    assert.equal(normalize('UK 10.5'), 'uk 10.5');
    assert.equal(normalize('  @odegaard.98  '), 'odegaard 98');
  });
  test('tolerates blanks and non-strings', () => {
    assert.equal(normalize(null), '');
    assert.equal(normalize(undefined), '');
    assert.equal(normalize(42), '42');
    assert.deepEqual(tokenize('  '), []);
    assert.deepEqual(tokenize('Travis, LOW!'), ['travis', 'low']);
  });
});

describe('parseDealNumber', () => {
  test('reads SM numbers in the forms people type', () => {
    assert.equal(parseDealNumber('SM-0007'), 7);
    assert.equal(parseDealNumber('sm7'), 7);
    assert.equal(parseDealNumber('sm 0007'), 7);
    assert.equal(parseDealNumber('#7'), 7);
    assert.equal(parseDealNumber('0007'), 7);
    assert.equal(parseDealNumber('7'), 7);
  });
  test('ignores anything else', () => {
    assert.equal(parseDealNumber('SM-0000'), null);
    assert.equal(parseDealNumber('travis 10'), null);
    assert.equal(parseDealNumber(''), null);
    assert.equal(parseDealNumber(null), null);
  });
});

describe('search: empty and no match', () => {
  test('an empty or punctuation-only query returns nothing', () => {
    for (const q of ['', '   ', '!!', null, undefined]) {
      const r = search(q, data);
      assert.deepEqual([r.clients.length, r.items.length, r.orders.length], [0, 0, 0]);
    }
  });
  test('a word nothing contains returns nothing', () => {
    const r = search('zzzz', data);
    assert.deepEqual([r.clients.length, r.items.length, r.orders.length], [0, 0, 0]);
  });
  test('tolerates missing data', () => {
    assert.deepEqual(search('travis').clients, []);
    assert.deepEqual(search('travis', { clients: null, deals: [null, {}] }).items, []);
  });
});

describe('search: clients', () => {
  test('finds a client by name with every order, newest first', () => {
    const r = search('marcus', data);
    assert.equal(r.clients[0].client.id, 'c1');
    assert.deepEqual(r.clients[0].orders.map((o) => o.deal.number), [7, 1, 2]);
    assert.equal(r.clients[0].orders[0].totals.revenue, 1000);
  });
  test('lifetime totals use calc.dealTotals and count item quantities', () => {
    const r = search('rashford', data);
    const { lifetime } = r.clients[0];
    const expectedProfit = deals.filter((d) => d.client_id === 'c1').reduce((s, d) => s + dealTotals(d).netProfit, 0);
    assert.equal(lifetime.orders, 3);
    assert.equal(lifetime.items, 1 + 1 + 2 + 1 + 1);
    assert.equal(lifetime.revenue, 950 + 400 + 240 + 1000 + 150);
    assert.equal(lifetime.profit, expectedProfit);
    // 350 + 150 + 80 (order 1) + 285 (order 7: 1000 − 700 expected − 15 delivery) + 60 (order 2)
    assert.equal(lifetime.profit, 925);
    assert.equal(lifetime.avgProfitPerOrder, 925 / 3);
    assert.equal(lifetime.estimated, true, 'order 7 still has an expected cost');
  });
  test('accents and Ø: "odegaard" and "Ødegaard" both find Martin', () => {
    for (const q of ['odegaard', 'Ødegaard', 'ODEGAARD', 'martin ode']) {
      assert.equal(search(q, data).clients[0]?.client.id, 'c2', q);
    }
    assert.equal(search('kante', data).clients[0].client.id, 'c5');
    assert.equal(search('ngolo', data).clients[0].client.id, 'c5');
  });
  test('punctuation is ignored ("oshea", "o shea")', () => {
    assert.equal(search('oshea', data).clients[0].client.id, 'c3');
    assert.equal(search("o'shea", data).clients[0].client.id, 'c3');
  });
  test('matches club, position, agent, instagram, tags and phone digits', () => {
    const ids = (q) => search(q, data).clients.map((c) => c.client.id).sort();
    assert.deepEqual(ids('arsenal'), ['c2', 'c4']);
    assert.deepEqual(ids('goalkeeper'), ['c6']);
    assert.deepEqual(ids('mendes'), ['c2']);
    assert.deepEqual(ids('@odegaard'), ['c2']);
    assert.deepEqual(ids('vip'), ['c1']);
    assert.deepEqual(ids('900123'), ['c1']);
    assert.deepEqual(ids('07700 900123'), ['c1'], 'a +44 number typed with a leading 0');
    assert.deepEqual(ids('07700900456'), ['c2']);
  });
  test('multi-word queries AND across fields', () => {
    const ids = (q) => search(q, data).clients.map((c) => c.client.id);
    assert.deepEqual(ids('arsenal winger'), ['c4']);
    assert.deepEqual(ids('arsenal goalkeeper'), []);
  });
  test('ranking: exact/prefix name beats word-start beats substring, then profit', () => {
    // 'mar' starts "Marcus", "Martin" and "Mark": equal scores, so the most profitable first.
    const r = search('mar', data);
    assert.deepEqual(r.clients.slice(0, 3).map((c) => c.client.id), ['c1', 'c2', 'c6']);
    // "travers" is a whole name word for Mark Travers; Marcus only has the tag "travis" (no match).
    assert.equal(search('travers', data).clients[0].client.id, 'c6');
    // Exact full name beats a prefix of another name.
    const exact = search('mark travers', data);
    assert.equal(exact.clients[0].client.id, 'c6');
    assert.ok(exact.clients[0].score > search('travers', data).clients[0].score);
    // A substring (inside a word) ranks below a word start.
    const sub = search('ash', data).clients.map((c) => c.client.id);
    assert.ok(sub.includes('c1'), 'Rashford contains "ash"');
  });
  test('cancelled orders are listed but left out of lifetime totals', () => {
    const r = search('shea', data).clients[0];
    assert.equal(r.orders.length, 1);
    assert.equal(r.orders[0].cancelled, true);
    assert.equal(r.lifetime.orders, 0);
    assert.equal(r.lifetime.revenue, 0);
    assert.equal(r.lifetime.profit, 0);
    assert.equal(r.lifetime.avgProfitPerOrder, null);
    assert.equal(r.lifetime.cancelled, 1);
  });
  test('a client known only from a sale is still searchable', () => {
    const r = search('ghost', { clients: [], deals: [deal({ number: 9, client_id: 'cx', client: { id: 'cx', name: 'Ghost Player', club: null } })] });
    assert.equal(r.clients[0].client.name, 'Ghost Player');
    assert.equal(r.clients[0].orders.length, 1);
  });
});

describe('search: items', () => {
  test('every sale of the Travis pair, across clients, with size, price and profit', () => {
    const r = search('travis', data);
    const travis = r.items.filter((row) => normalize(row.description) === normalize(TS));
    assert.equal(travis.length, 6);
    // Newest first within equal scores.
    assert.deepEqual(travis.map((row) => row.deal.number), [7, 6, 5, 4, 3, 1]);
    const odegaard = travis.find((row) => row.client.id === 'c2');
    assert.equal(odegaard.size, '10');
    assert.equal(odegaard.qty, 2);
    assert.equal(odegaard.unitPrice, 850);
    assert.equal(odegaard.lineRevenue, 1700);
    assert.equal(odegaard.lineCost, 1240);
    assert.equal(odegaard.lineProfit, (850 - 620) * 2);
    assert.equal(odegaard.estimated, false);
    assert.equal(odegaard.saleDate, '2026-09-05');
  });
  test('expected cost gives an estimated profit from expected_unit_cost', () => {
    const row = search('travis', data).items.find((r) => r.deal.number === 7);
    assert.equal(row.estimated, true);
    assert.equal(row.unitCost, 700);
    assert.equal(row.lineProfit, 300);
  });
  test('actual cost uses unit_cost, not the expected cost', () => {
    const row = search('travis', data).items.find((r) => r.deal.number === 1);
    assert.equal(row.estimated, false);
    assert.equal(row.unitCost, 600);
    assert.equal(row.lineProfit, 350);
  });
  test('"travis low 10" ANDs across description and size', () => {
    const r = search('travis low 10', data);
    assert.deepEqual(r.items.map((row) => row.deal.number), [3]);
    // "10" as a word start also reaches 10.x sizes, but not 8 or 9.
    assert.deepEqual(search('travis 9', data).items.map((row) => row.deal.number).sort(), [1, 7]);
  });
  test('brand and SKU, with or without punctuation', () => {
    assert.equal(search('supreme', data).items[0].description, 'Supreme Box Logo Hoodie');
    assert.ok(search('dm7866', data).items.length >= 6);
    assert.ok(search('dm7866162', data).items.length >= 6, 'compact SKU still matches');
    assert.equal(search('cw2288-111', data).items[0].deal.number, 2);
  });
  test('a client name narrows items but never lists items on its own', () => {
    assert.equal(search('marcus', data).items.length, 0);
    const r = search('travis marcus', data);
    assert.deepEqual(r.items.map((row) => row.deal.number), [7, 1]);
  });
  test('items in a multi-item order are found individually', () => {
    const fleece = search('tech fleece', data).items;
    assert.equal(fleece.length, 1);
    assert.equal(fleece[0].qty, 2);
    assert.equal(fleece[0].lineProfit, 80);
    assert.equal(fleece[0].deal.items.length, 3);
  });
  test('cancelled sales are flagged', () => {
    const row = search('travis 11', data).items[0];
    assert.equal(row.deal.number, 4);
    assert.equal(row.cancelled, true);
  });
});

describe('item groups', () => {
  test('groups the same description (any casing) with totals that skip cancelled sales', () => {
    const r = search('travis', data);
    assert.equal(r.itemGroups.length, 1);
    const group = r.itemGroups[0];
    assert.equal(group.rows.length, 6);
    const { stats } = group;
    assert.equal(stats.sales, 5);
    assert.equal(stats.cancelled, 1);
    assert.equal(stats.units, 6); // Ødegaard bought 2
    assert.equal(stats.clients, 4); // Marcus twice, Ødegaard, Saka, Kanté
    const revenue = 950 + 1000 + 1700 + 920 + 870;
    const profit = 350 + 300 + 460 + 280 + 255;
    assert.equal(stats.revenue, revenue);
    assert.equal(stats.profit, profit);
    assert.equal(stats.avgSalePrice, revenue / 6);
    assert.equal(stats.avgProfit, profit / 6);
    assert.equal(stats.estimated, true);
  });
  test('several descriptions become several groups, best match first', () => {
    const groups = groupItems(search('low', data).items);
    assert.deepEqual(groups.map((g) => g.description), [TS, 'Air Force 1 Low White']);
  });
  test('groupStats of nothing has null averages', () => {
    const s = groupStats([]);
    assert.equal(s.units, 0);
    assert.equal(s.avgSalePrice, null);
    assert.equal(s.avgProfit, null);
  });
});

describe('search: orders', () => {
  test('by SM number in any form', () => {
    for (const q of ['SM-0007', 'sm7', '#7', '7', '0007']) {
      const r = search(q, data);
      assert.equal(r.orders[0]?.deal.number, 7, q);
      assert.equal(r.orders[0].matchedBy, 'number');
      assert.equal(r.orders[0].client.id, 'c1');
      assert.equal(r.orders[0].totals.netProfit, 285);
    }
  });
  test('"sm" alone does not list every sale', () => {
    assert.equal(search('sm', data).orders.length, 0);
  });
  test('by title and notes', () => {
    assert.equal(search('birthday', data).orders[0].deal.number, 5);
    assert.equal(search('squad card', data).orders[0].deal.number, 5);
    assert.equal(search('birthday', data).orders[0].matchedBy, 'text');
  });
  test('cancelled orders are flagged', () => {
    const r = search('SM-0004', data);
    assert.equal(r.orders[0].cancelled, true);
  });
});

describe('itemsSummary', () => {
  test('first item, its quantity and how many more', () => {
    assert.equal(itemsSummary(deals[0]), `${TS} ×1 +2 more`);
    assert.equal(itemsSummary(deals[2]), `${TS} ×2`);
    assert.equal(itemsSummary({ title: 'Mystery box', items: [] }), 'Mystery box');
    assert.equal(itemsSummary(null), '');
  });
});

test('item history and suggestions while typing an item', async () => {
  const { itemHistory, suggestItems } = await import('../public/desk/lib/search.js');
  const deals = [
    { sale_date: '2026-09-01', status: 'completed', items: [{ description: 'Travis Scott Jordan 1 Low', brand: 'Nike', sku: 'DM7866-162', unit_price: 450, cost_status: 'actual', unit_cost: 300 }] },
    { sale_date: '2026-09-20', status: 'agreed', items: [{ description: 'travis scott jordan 1 low', unit_price: 480, cost_status: 'expected', expected_unit_cost: 320 }, { description: 'Nike Dunk Low Panda', unit_price: 120 }] },
    { sale_date: '2026-09-25', status: 'cancelled', items: [{ description: 'Cancelled Thing' }] },
  ];
  const history = itemHistory({ deals, stock: [{ name: 'Yeezy Slide Onyx', brand: 'adidas', unit_cost: 60, bought_at: '2026-08-01' }] });
  const travis = history.find((e) => e.sku === 'DM7866-162');
  assert.equal(travis.description, 'Travis Scott Jordan 1 Low'); // nicer spelling kept
  assert.equal(travis.count, 2);
  assert.equal(travis.lastPrice, 480);
  assert.ok(!history.some((e) => e.description === 'Cancelled Thing'));
  assert.deepEqual(suggestItems(history, 'jordan 1 trav').map((e) => e.description), ['Travis Scott Jordan 1 Low']);
  assert.deepEqual(suggestItems(history, 'dm78').map((e) => e.description), ['Travis Scott Jordan 1 Low']);
  assert.deepEqual(suggestItems(history, 'yeezy').map((e) => e.description), ['Yeezy Slide Onyx']);
  assert.deepEqual(suggestItems(history, 'Travis Scott Jordan 1 Low'), []);
  assert.deepEqual(suggestItems(history, 't'), []);
});

test('supplier history and suggestions', async () => {
  const { supplierHistory, suggestSuppliers } = await import('../public/desk/lib/search.js');
  const deals = [
    { id: 'd1', number: 3, sale_date: '2026-10-05', status: 'agreed', items: [
      { description: 'Travis Scott Jordan 1 Low', qty: 1, cost_status: 'actual', unit_cost: 300, supplier: 'Charlie Wakefield', sourced_at: '2026-10-04' },
      { description: 'Dunk Low', qty: 2, cost_status: 'actual', unit_cost: 90, supplier: 'charlie wakefield' },
      { description: 'Yeezy', qty: 1, cost_status: 'expected', expected_unit_cost: 150, supplier: 'StockX' },
      { description: 'From stock', qty: 1, cost_status: 'actual', unit_cost: 200, supplier: 'GOAT', stock_item_id: 's1' },
    ] },
    { id: 'd2', status: 'cancelled', items: [{ description: 'x', qty: 1, cost_status: 'actual', unit_cost: 5, supplier: 'Gone Ltd' }] },
  ];
  const history = supplierHistory({ deals, stock: [{ id: 's1', name: 'Jordan 4', qty: 2, unit_cost: 200, supplier: 'GOAT', bought_at: '2026-09-01' }] });
  const charlie = history[0];
  assert.equal(charlie.name, 'Charlie Wakefield');
  assert.equal(charlie.lines, 2);
  assert.equal(charlie.units, 3);
  assert.equal(charlie.spent, 480);
  assert.equal(history.find((s) => s.name === 'StockX').spent, 0); // planned, not spent
  assert.equal(history.find((s) => s.name === 'GOAT').spent, 400); // stock counted once
  assert.ok(!history.some((s) => s.name === 'Gone Ltd'));
  assert.deepEqual(suggestSuppliers(history, 'char').map((s) => s.name), ['Charlie Wakefield']);
  assert.deepEqual(suggestSuppliers(history, 'wake').map((s) => s.name), ['Charlie Wakefield']);
  assert.equal(suggestSuppliers(history, '')[0].name, 'Charlie Wakefield'); // regulars first, before typing
  assert.ok(suggestSuppliers(history, 'eb').some((s) => s.name === 'eBay')); // platforms built in
  assert.deepEqual(suggestSuppliers(history, 'Charlie Wakefield'), []);
});

// Sizemill Desk smart search: one query across clients, the items they bought and sale numbers.
//
// Pure ES module (no DOM, no I/O) so the browser and the Node tests share it. Every money figure
// comes from calc.js. Matching is case-, accent- and punctuation-insensitive, and multi-word
// queries are ANDed across a record's fields ("travis low 10" finds the Travis Scott Jordan 1
// Low sold in size 10). Ranking: whole-field exact/prefix > every word at a word start >
// substring.
//
//   search(query, { clients, deals }) → { query, clients, items, itemGroups, orders }
//
// `deals` are store.deals.list() rows (each with client, items, costs, payments, trips).
// Cancelled sales still appear (flagged `cancelled`) but never count towards a total.

import { dealTotals, itemCost, itemTotals, num } from './calc.js';

// Letters NFD leaves alone ('Ø' has no combining form), folded to what people type.
const FOLD = {
  ø: 'o', æ: 'ae', œ: 'oe', ß: 'ss', đ: 'd', ð: 'd', ł: 'l', þ: 'th', ı: 'i', ħ: 'h', ŧ: 't',
};
const FOLD_RE = new RegExp(`[${Object.keys(FOLD).join('')}]`, 'g');

/**
 * 'Ødegaard', "O'Brien!" → 'odegaard', 'obrien'. Lower-case, accent-free; apostrophes vanish,
 * other punctuation becomes a space, and a decimal point between digits stays ('10.5').
 */
export function normalize(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(FOLD_RE, (ch) => FOLD[ch])
    .replace(/['’‘`´]/g, '')
    .replace(/(\d)[.,](?=\d)/g, '$1\u0001')
    .replace(/[^a-z0-9\u0001]+/g, ' ')
    .replace(/\u0001/g, '.')
    .trim();
}

/** Query words, normalised; '' gives []. */
export function tokenize(query) {
  const text = normalize(query);
  return text ? text.split(' ') : [];
}

// ---- field matching --------------------------------------------------------------------------

const EXACT_WORD = 3;
const PREFIX_WORD = 2;
const SUBSTRING = 1;

// A searchable field: its normalised text, words and compact (space-free) form.
function field(value, { weight = 1, primary = false, kind = 'text' } = {}) {
  if (kind === 'phone') {
    const digits = String(value ?? '').replace(/\D+/g, '');
    if (digits.length < 4) return null;
    // '+44 7700 900123' is also typed as '07700 900123'.
    const local = digits.startsWith('44') ? `0${digits.slice(2)}` : digits;
    return { kind, weight, primary, digits: [digits, local] };
  }
  const text = normalize(value);
  if (!text) return null;
  return { kind, weight, primary, text, words: text.split(' '), compact: text.replace(/ /g, '') };
}

// Best score of one query word against one field (0 = no match).
function tokenScore(token, f) {
  if (f.kind === 'phone') {
    if (!/^\d{4,}$/.test(token)) return 0;
    const wanted = token.replace(/^0+/, '');
    return f.digits.some((d) => d.includes(token) || (wanted.length >= 4 && d.includes(wanted))) ? SUBSTRING : 0;
  }
  let best = 0;
  for (const word of f.words) {
    if (word === token) return EXACT_WORD;
    if (word.startsWith(token)) best = PREFIX_WORD;
  }
  if (!best && (f.text.includes(token) || f.compact.includes(token))) best = SUBSTRING;
  return best;
}

// Bonus when the whole query matches a field as a phrase.
function phraseScore(phrase, f) {
  if (f.kind === 'phone' || !phrase) return 0;
  if (f.text === phrase || f.compact === phrase.replace(/ /g, '')) return 20;
  if (f.text.startsWith(phrase)) return 12;
  if (f.text.includes(` ${phrase}`)) return 5;
  return 0;
}

/**
 * Scores a record (a list of fields, some null) against query words. Every word must match some
 * field (AND). `required` fields: at least one word must land in one of them. Returns 0 for no
 * match, else a positive score.
 */
function scoreFields(tokens, phrase, fields, { required } = {}) {
  const live = fields.filter(Boolean);
  if (!tokens.length || !live.length) return 0;
  let total = 0;
  let hitRequired = !required;
  for (const token of tokens) {
    let best = 0;
    for (const f of live) {
      const s = tokenScore(token, f) * f.weight;
      if (s > best) best = s;
      if (s > 0 && required?.has(f)) hitRequired = true;
    }
    if (best === 0) return 0;
    total += best;
  }
  if (!hitRequired) return 0;
  let bonus = 0;
  for (const f of live) bonus = Math.max(bonus, phraseScore(phrase, f) * (f.primary ? 1 : 0.6));
  return total + bonus;
}

// ---- helpers ---------------------------------------------------------------------------------

function list(v) {
  return Array.isArray(v) ? v.filter((row) => row !== null && typeof row === 'object') : [];
}

function clientIdOf(deal) {
  return deal?.client_id ?? deal?.client?.id ?? null;
}

function isCancelled(deal) {
  return deal?.status === 'cancelled';
}

// Newest first: sale date, then sale number.
function newestFirst(a, b) {
  const da = String(a?.sale_date ?? '');
  const db = String(b?.sale_date ?? '');
  if (da !== db) return da < db ? 1 : -1;
  return num(b?.number) - num(a?.number);
}

/**
 * 'SM-0007', 'sm7', '#7', '0007' or '7' → 7; anything else → null. A bare number only counts
 * when it is the whole query.
 */
export function parseDealNumber(query) {
  const text = String(query ?? '').trim();
  const match = /^(?:sm)?[\s#-]*0*(\d{1,7})$/i.exec(text);
  if (!match) return null;
  const n = Number(match[1]);
  return n > 0 ? n : null;
}

/** 'Travis Scott Jordan 1 Low ×2 +2 more' for a sale's items, or the title, or ''. */
export function itemsSummary(deal) {
  const items = list(deal?.items);
  if (!items.length) return String(deal?.title ?? '').trim();
  const first = items[0];
  const qty = num(first.qty) || 1;
  const head = `${String(first.description ?? '').trim() || 'Item'} ×${qty}`;
  return items.length > 1 ? `${head} +${items.length - 1} more` : head;
}

// ---- search ----------------------------------------------------------------------------------

function clientFields(client) {
  const tags = Array.isArray(client?.tags) ? client.tags.join(' ') : client?.tags;
  return [
    field(client?.name, { weight: 1, primary: true }),
    field(client?.club, { weight: 0.9 }),
    field(client?.position, { weight: 0.8 }),
    field(client?.agent_name, { weight: 0.8 }),
    field(client?.instagram, { weight: 0.85 }),
    field(tags, { weight: 0.8 }),
    field(client?.phone, { kind: 'phone' }),
    field(client?.agent_phone, { kind: 'phone', weight: 0.8 }),
  ];
}

function lifetimeOf(orders) {
  const life = { orders: 0, items: 0, revenue: 0, profit: 0, avgProfitPerOrder: null, estimated: false, cancelled: 0, lastSaleDate: null };
  for (const { deal, totals } of orders) {
    if (isCancelled(deal)) {
      life.cancelled += 1;
      continue;
    }
    life.orders += 1;
    life.items += list(deal.items).reduce((sum, item) => sum + num(item.qty), 0);
    life.revenue += totals.revenue;
    life.profit += totals.netProfit;
    if (totals.certainty === 'estimated') life.estimated = true;
    if (deal.sale_date && (!life.lastSaleDate || deal.sale_date > life.lastSaleDate)) life.lastSaleDate = deal.sale_date;
  }
  life.avgProfitPerOrder = life.orders ? life.profit / life.orders : null;
  return life;
}

/** Rows of one item group → { units, sales, clients, revenue, profit, avgSalePrice, avgProfit, estimated }. */
export function groupStats(rows) {
  const stats = { units: 0, sales: 0, clients: 0, revenue: 0, cost: 0, profit: 0, avgSalePrice: null, avgProfit: null, estimated: false, cancelled: 0 };
  const clientIds = new Set();
  for (const row of rows) {
    if (row.cancelled) {
      stats.cancelled += 1;
      continue;
    }
    stats.sales += 1;
    stats.units += row.qty;
    stats.revenue += row.lineRevenue;
    stats.cost += row.lineCost;
    stats.profit += row.lineProfit;
    if (row.estimated) stats.estimated = true;
    clientIds.add(row.client?.id ?? row.client?.name ?? `deal:${row.deal?.id}`);
  }
  stats.clients = clientIds.size;
  if (stats.units > 0) {
    stats.avgSalePrice = stats.revenue / stats.units;
    stats.avgProfit = stats.profit / stats.units;
  }
  return stats;
}

/**
 * Item rows grouped by description (normalised, so 'Travis Scott Jordan 1 Low' and
 * 'travis scott jordan 1 low' are one group), best match first.
 * → [{ key, description, brand, rows, stats }]
 */
export function groupItems(itemRows) {
  const groups = new Map();
  for (const row of itemRows) {
    const key = normalize(row.item?.description) || `#${row.item?.id ?? ''}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, description: String(row.item?.description ?? '').trim() || 'Item', brand: row.item?.brand ?? null, rows: [], score: 0 };
      groups.set(key, group);
    }
    group.rows.push(row);
    group.score = Math.max(group.score, row.score);
  }
  const out = [...groups.values()].map((group) => ({ ...group, stats: groupStats(group.rows) }));
  out.sort((a, b) => b.score - a.score || newestFirst(a.rows[0]?.deal, b.rows[0]?.deal) || b.rows.length - a.rows.length);
  return out;
}

/**
 * search(query, { clients, deals }) → {
 *   query, number,
 *   clients: [{ client, score, orders: [{ deal, totals, cancelled }], lifetime }],
 *   items: [{ deal, client, item, description, size, qty, unitPrice, unitCost, lineRevenue,
 *             lineCost, lineProfit, estimated, cancelled, saleDate, score }],
 *   itemGroups: groupItems(items),
 *   orders: [{ deal, client, totals, cancelled, score, matchedBy: 'number' | 'text' }],
 * }
 */
export function search(query, { clients = [], deals = [] } = {}) {
  const tokens = tokenize(query);
  const phrase = tokens.join(' ');
  const number = parseDealNumber(query);
  const empty = { query: phrase, number, clients: [], items: [], itemGroups: [], orders: [] };
  if (!tokens.length && number === null) return empty;

  const dealRows = list(deals);
  const totalsById = new Map();
  const totalsFor = (deal) => {
    let totals = totalsById.get(deal);
    if (!totals) {
      totals = dealTotals(deal);
      totalsById.set(deal, totals);
    }
    return totals;
  };

  // Every client, including ones only known from a sale's embedded client.
  const clientsById = new Map();
  for (const client of list(clients)) if (client.id !== undefined && client.id !== null) clientsById.set(client.id, client);
  for (const deal of dealRows) {
    const id = clientIdOf(deal);
    if (id !== null && !clientsById.has(id) && deal.client) clientsById.set(id, deal.client);
  }
  const dealsByClient = new Map();
  for (const deal of dealRows) {
    const id = clientIdOf(deal);
    if (id === null) continue;
    if (!dealsByClient.has(id)) dealsByClient.set(id, []);
    dealsByClient.get(id).push(deal);
  }

  // Clients.
  const clientResults = [];
  for (const client of clientsById.values()) {
    const score = scoreFields(tokens, phrase, clientFields(client));
    if (!score) continue;
    const orders = (dealsByClient.get(client.id) ?? [])
      .slice()
      .sort(newestFirst)
      .map((deal) => ({ deal, totals: totalsFor(deal), cancelled: isCancelled(deal) }));
    clientResults.push({ client, score, orders, lifetime: lifetimeOf(orders) });
  }
  clientResults.sort((a, b) =>
    b.score - a.score
    || b.lifetime.profit - a.lifetime.profit
    || String(a.client.name ?? '').localeCompare(String(b.client.name ?? '')));

  // Items: words may also narrow by client name ("travis marcus"), but at least one must hit
  // the item itself, so a bare client name doesn't list every pair they bought.
  const items = [];
  for (const deal of dealRows) {
    const client = clientsById.get(clientIdOf(deal)) ?? deal.client ?? null;
    const clientName = field(client?.name, { weight: 0.5 });
    for (const item of list(deal.items)) {
      const own = [
        field(item.description, { weight: 1, primary: true }),
        field(item.brand, { weight: 0.9 }),
        field(item.sku, { weight: 0.9 }),
        field(item.size, { weight: 0.95 }),
      ];
      const score = scoreFields(tokens, phrase, [...own, clientName], { required: new Set(own.filter(Boolean)) });
      if (!score) continue;
      const qty = num(item.qty);
      const t = itemTotals(item);
      items.push({
        deal,
        client,
        item,
        description: String(item.description ?? '').trim(),
        size: item.size ?? null,
        qty,
        unitPrice: num(item.unit_price),
        unitCost: itemCost(item),
        lineRevenue: t.revenue,
        lineCost: t.cost,
        lineProfit: t.revenue - t.cost,
        estimated: t.isExpected,
        cancelled: isCancelled(deal),
        saleDate: deal.sale_date ?? null,
        score,
      });
    }
  }
  items.sort((a, b) => b.score - a.score || newestFirst(a.deal, b.deal) || num(a.item.position) - num(b.item.position));

  // Orders: by sale number, or by title / notes.
  const orders = [];
  for (const deal of dealRows) {
    let score = 0;
    let matchedBy = null;
    if (number !== null && num(deal.number) === number) {
      score = 100;
      matchedBy = 'number';
    } else if (tokens.length) {
      score = scoreFields(tokens, phrase, [
        field(deal.title, { weight: 1, primary: true }),
        field(deal.notes, { weight: 0.7 }),
      ]);
      if (score) matchedBy = 'text';
    }
    if (!score) continue;
    const client = clientsById.get(clientIdOf(deal)) ?? deal.client ?? null;
    orders.push({ deal, client, totals: totalsFor(deal), cancelled: isCancelled(deal), score, matchedBy });
  }
  orders.sort((a, b) => b.score - a.score || newestFirst(a.deal, b.deal));

  return { query: phrase, number, clients: clientResults, items, itemGroups: groupItems(items), orders };
}

// ---- item history (suggestions while typing an item) ---------------------------------------

/**
 * Every distinct item the owner has sold or stocked, newest first:
 * [{ description, brand, sku, count, lastPrice, lastCost, lastDate }]. Items with the same
 * normalised name are merged; brand and SKU come from the most recent entry that has them.
 */
export function itemHistory({ deals = [], stock = [] } = {}) {
  const byKey = new Map();
  const add = (entry) => {
    const name = String(entry.description ?? '').trim();
    if (!name) return;
    const key = normalize(name);
    const seen = byKey.get(key);
    if (!seen) {
      byKey.set(key, { description: name, brand: entry.brand || null, sku: entry.sku || null, count: entry.count ?? 1,
        lastPrice: entry.lastPrice ?? null, lastCost: entry.lastCost ?? null, lastDate: entry.date ?? '' });
      return;
    }
    seen.count += entry.count ?? 1;
    const newer = (entry.date ?? '') > seen.lastDate;
    if (newer) {
      // Keep the nicer spelling: a later all-lowercase entry doesn't replace "Travis Scott…".
      if (/[A-Z]/.test(name) || !/[A-Z]/.test(seen.description)) seen.description = name;
      seen.lastDate = entry.date ?? '';
      if (entry.lastPrice !== null && entry.lastPrice !== undefined) seen.lastPrice = entry.lastPrice;
      if (entry.lastCost !== null && entry.lastCost !== undefined) seen.lastCost = entry.lastCost;
    }
    if (entry.brand && (newer || !seen.brand)) seen.brand = entry.brand;
    if (entry.sku && (newer || !seen.sku)) seen.sku = entry.sku;
  };
  for (const deal of deals) {
    if (deal?.status === 'cancelled') continue;
    for (const item of deal?.items ?? []) {
      const cost = item.cost_status === 'actual' ? item.unit_cost : item.expected_unit_cost;
      add({ description: item.description, brand: item.brand, sku: item.sku, date: deal.sale_date ?? '',
        lastPrice: item.unit_price ?? null, lastCost: cost ?? null });
    }
  }
  for (const s of stock) add({ description: s.name, brand: s.brand, sku: s.sku, date: s.bought_at ?? '', lastCost: s.unit_cost ?? null, count: 0 });
  return [...byKey.values()].sort((a, b) => (b.lastDate || '').localeCompare(a.lastDate || '') || b.count - a.count);
}

/**
 * The best history entries for what has been typed so far: every typed word must start a word
 * in the item name, brand or SKU (so "jordan 1 trav" finds "Travis Scott Jordan 1 Low").
 * Exact-prefix matches first, then most-sold, then newest. Nothing for fewer than 2 characters
 * or when the text already equals an entry.
 */
export function suggestItems(history, typed, limit = 6) {
  const query = normalize(typed);
  if (query.length < 2) return [];
  const words = query.split(' ').filter(Boolean);
  const scored = [];
  for (const entry of history) {
    const name = normalize(entry.description);
    if (name === query) return [];
    const hay = `${name} ${normalize(entry.brand ?? '')} ${normalize(entry.sku ?? '')}`.trim().split(' ');
    if (!words.every((w) => hay.some((h) => h.startsWith(w)))) continue;
    scored.push({ entry, score: (name.startsWith(query) ? 2 : 0) + (hay[0]?.startsWith(words[0]) ? 1 : 0) });
  }
  scored.sort((a, b) => b.score - a.score || b.entry.count - a.entry.count || (b.entry.lastDate || '').localeCompare(a.entry.lastDate || ''));
  return scored.slice(0, limit).map((s) => s.entry);
}

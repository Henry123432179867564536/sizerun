// Clients (#/clients): everyone you sell to and what each one is worth to you — lifetime
// revenue and profit, what they still owe and when they last bought. Search, sort, tab and tag
// filters live in the address (`#/clients?q=…&sort=…&tab=…&tag=…`), so Back returns to the
// same view.
//
// Also exports what the Client profile (views/client.js) shares with this list: search text,
// the "club · position · #7" line, sizes, per-client sales stats (from calc.js), the initials
// avatar and tag pills, plus the few styles both screens need that desk.css has no class for.

import { html, useEffect, useMemo, useState } from '../lib/preact.js';
import {
  Badge,
  Banner,
  Button,
  Card,
  Empty,
  ErrorState,
  Loading,
  Money,
  Page,
  SearchBox,
  Select,
  Tabs,
  cx,
  useStoreData,
} from '../lib/ui.js';
import { averagePayToDeliver, dealTotals, EPS, num, summarise } from '../lib/calc.js';
import { date as formatDate, dateShort, money, plural, relDays, todayISO } from '../lib/format.js';

// ---------------------------------------------------------------------------------------------
// Styles shared by the client screens (added to <head> once, like the components do)
// ---------------------------------------------------------------------------------------------

const CSS = `
.cl-avatar { display: inline-grid; flex: none; place-items: center; width: 36px; height: 36px; border-radius: 50%; background: var(--signal-tint); color: var(--signal); font-size: 13px; font-weight: 600; letter-spacing: 0.02em; line-height: 1; user-select: none; }
.cl-avatar-lg { width: 56px; height: 56px; font-size: 19px; }
.cl-who { flex: 1 1 auto; min-width: 0; }
.cl-who-name { display: flex; align-items: center; gap: 6px; min-width: 0; }
.cl-sub { font-weight: 400; }
.cl-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.cl-tags .pill { max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.cl-table td.cell-primary { min-width: 220px; }
.cl-cell-client { display: flex; align-items: flex-start; gap: 10px; min-width: 0; }
.cl-toolbar { flex-wrap: nowrap; }
.cl-toolbar > .search { flex: 1 1 auto; min-width: 0; }
.cl-toolbar > .select-wrap { flex: 0 1 180px; min-width: 0; }
.cl-chips { flex-wrap: nowrap; overflow-x: auto; margin: 0 -16px; padding: 2px 16px; scrollbar-width: none; -webkit-overflow-scrolling: touch; }
.cl-chips::-webkit-scrollbar { display: none; }
.cl-chips .chip { flex: none; }
@media (min-width: 640px) {
  .cl-chips { flex-wrap: wrap; overflow: visible; margin: 0; padding: 0; }
}
@media (max-width: 639.98px) {
  .cl-table td.cell-primary { min-width: 0; }
  .cl-toolbar > .search { flex: 1 1 0; }
  .cl-toolbar > .select-wrap { flex: 0 0 150px; max-width: 50%; }
}

/* Compact two-line list rows for phones (shared by Clients, Client, Stock, Trips): title and
   a muted line on the left, the key number and a short meta line on the right. */
.lr-list { margin: 0; padding: 0; list-style: none; }
.lr-list > li + li { border-top: 1px solid var(--line); }
.lr { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 64px; margin: 0; padding: 11px 16px; border: 0; border-radius: 0; background: none; color: inherit; font: inherit; text-align: left; text-decoration: none; cursor: pointer; -webkit-tap-highlight-color: transparent; }
.lr:hover, .lr:active { background: var(--hover); text-decoration: none; }
.lr:focus-visible { outline: 2px solid var(--signal); outline-offset: -2px; }
.lr-main { flex: 1 1 auto; min-width: 0; }
.lr-title { display: flex; align-items: center; gap: 6px; min-width: 0; color: var(--ink); font-size: 15px; font-weight: 500; line-height: 1.3; }
.lr-title-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lr-title > :not(.lr-title-text) { flex: none; }
.lr-sub { margin-top: 3px; overflow: hidden; color: var(--ink-2); font-size: 13px; line-height: 1.35; text-overflow: ellipsis; white-space: nowrap; }
.lr-aside { display: flex; flex: none; flex-direction: column; align-items: flex-end; gap: 3px; max-width: 46%; text-align: right; }
.lr-amount { font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1.3; white-space: nowrap; }
.lr-meta { max-width: 100%; overflow: hidden; color: var(--ink-3); font-size: 12px; font-weight: 500; line-height: 1.3; text-overflow: ellipsis; white-space: nowrap; }
.lr-meta.tone-warn { color: var(--warn); }
.lr-meta.tone-loss { color: var(--loss); }
.lr-meta.tone-gain { color: var(--gain); }
.lr.is-current { background: var(--signal-tint); }
`;

const STYLE_ID = 'desk-clients-styles';
if (typeof document !== 'undefined' && !document.getElementById(STYLE_ID)) {
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.append(style);
}

// ---------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------

/** Deal statuses before the hand-over. */
export const OPEN_STATUSES = new Set(['enquiry', 'agreed', 'sourcing', 'ready']);
const HANDED_OVER = new Set(['delivered', 'completed']);

/** A trimmed string, or '' for anything that isn't text. */
export function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** Lower-cased, accent-free text for searching ('Kanté' matches 'kante'). */
export function normaliseText(value) {
  return String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** '7' or '#7' → '7'. */
export function squadNumber(value) {
  return clean(value).replace(/^#+\s*/, '');
}

/** 'Southampton · Winger · #7' from whatever is known, or ''. */
export function clientLine(client) {
  const number = squadNumber(client?.squad_number);
  return [clean(client?.club), clean(client?.position), number && `#${number}`].filter(Boolean).join(' · ');
}

/** 'Shoe UK 9 · Clothing M', or ''. */
export function sizesLine(client) {
  const shoe = clean(client?.shoe_size);
  const clothing = clean(client?.clothing_size);
  return [shoe && `Shoe ${shoe}`, clothing && `Clothing ${clothing}`].filter(Boolean).join(' · ');
}

/** The first word of a name, for buttons like "New sale for Marcus". */
export function firstName(name) {
  return clean(name).split(/\s+/)[0] || 'client';
}

/** 'MR' for 'Marcus Rashford'; '?' when there is no name. */
export function initials(name) {
  const words = clean(name).split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = [...words[0]][0];
  const last = words.length > 1 ? [...words[words.length - 1]][0] : '';
  return `${first}${last}`.toUpperCase();
}

/** '5 Oct' this year, '5 Oct 2025' before. */
export function saleDateText(iso) {
  return typeof iso === 'string' && iso.slice(0, 4) === todayISO().slice(0, 4) ? dateShort(iso) : formatDate(iso);
}

/** Map client id → that client's deals (deals without a client are left out). */
export function dealsByClient(deals) {
  const groups = new Map();
  for (const deal of Array.isArray(deals) ? deals : []) {
    if (!deal?.client_id) continue;
    const list = groups.get(deal.client_id);
    if (list) list.push(deal);
    else groups.set(deal.client_id, [deal]);
  }
  return groups;
}

/**
 * Lifetime figures for one client's deals. Money totals come from calc.summarise (cancelled
 * sales left out of every figure) and calc.dealTotals; this adds the counts the screens show:
 * open sales, sales still resting on expected costs, the newest sale date, and `dueNow`, the
 * unpaid part of sales already handed over (`owed` also counts agreed sales not yet delivered).
 * `owed` leaves out enquiries, which owe nothing yet — the same rule as the dashboard and the
 * Sales "Unpaid" tab. `margin` is profit ÷ revenue across all live sales (null with no
 * revenue), like a deal's own. An order is one deal (it may hold several items): `count` is
 * the orders that aren't cancelled, `items` the units on them, and `avgProfit` lifetime
 * profit ÷ orders (null with none).
 */
export function clientStats(deals) {
  const list = Array.isArray(deals) ? deals : [];
  const summary = summarise(list);
  const stats = {
    ...summary,
    owed: summarise(list.filter((deal) => deal.status !== 'enquiry')).owed,
    margin: summary.revenue > 0 ? summary.netProfit / summary.revenue : null,
    payToDeliver: averagePayToDeliver(list),
    lastSale: null,
    open: 0,
    cancelled: 0,
    estimatedCount: 0,
    dueNow: 0,
    items: 0,
    avgProfit: summary.count > 0 ? summary.netProfit / summary.count : null,
  };
  for (const deal of list) {
    if (deal.status === 'cancelled') {
      stats.cancelled += 1;
      continue;
    }
    const totals = dealTotals(deal);
    if (totals.certainty === 'estimated') stats.estimatedCount += 1;
    for (const item of Array.isArray(deal.items) ? deal.items : []) if (item) stats.items += num(item.qty);
    if (OPEN_STATUSES.has(deal.status)) stats.open += 1;
    if (HANDED_OVER.has(deal.status) && totals.balance > EPS) stats.dueNow += totals.balance;
    if (typeof deal.sale_date === 'string' && (!stats.lastSale || deal.sale_date > stats.lastSale)) {
      stats.lastSale = deal.sale_date;
    }
  }
  return stats;
}

/** Everything a search box should find a client by, normalised. */
export function clientHaystack(client) {
  const phones = [client.phone, client.agent_phone].map((phone) => clean(phone).replace(/\D/g, ''));
  return normaliseText([
    client.name, client.club, client.position, squadNumber(client.squad_number) && `#${squadNumber(client.squad_number)}`,
    client.agent_name, client.phone, client.agent_phone, ...phones, client.email, client.agent_email,
    client.instagram, client.shoe_size, client.clothing_size, client.preferences, client.notes,
    ...(Array.isArray(client.tags) ? client.tags : []),
  ].filter(Boolean).join(' '));
}

/** Initials in a circle. size: 'lg' for the profile. */
export function Avatar({ name, size }) {
  return html`<span class=${cx('cl-avatar', size === 'lg' && 'cl-avatar-lg')} aria-hidden="true">${initials(name)}</span>`;
}

/** Tags as pills; `limit` shows the first few and a "+N" for the rest. */
export function TagPills({ tags, limit }) {
  const list = (Array.isArray(tags) ? tags : []).filter((tag) => clean(tag));
  if (list.length === 0) return null;
  const shown = limit ? list.slice(0, limit) : list;
  const rest = list.length - shown.length;
  return html`<div class="cl-tags">
    ${shown.map((tag) => html`<span key=${tag} class="pill pill-signal" title=${tag}>${tag}</span>`)}
    ${rest > 0 && html`<span class="pill" title=${list.slice(shown.length).join(', ')}>+${rest}</span>`}
  </div>`;
}

/** True while the viewport is phone-width (< 640px); follows rotation and resizes. */
export const PHONE_QUERY = '(max-width: 639.98px)';
export function usePhone(query = PHONE_QUERY) {
  const list = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query) : null;
  const [matches, setMatches] = useState(() => Boolean(list?.matches));
  useEffect(() => {
    if (!list) return undefined;
    const onChange = (event) => setMatches(event.matches);
    list.addEventListener?.('change', onChange);
    setMatches(list.matches);
    return () => list.removeEventListener?.('change', onChange);
  }, [query]);
  return matches;
}

/**
 * One compact list row (64px): optional leading avatar/icon, a one-line title (plus a small
 * badge), a one-line muted subtitle, and on the right the key number over a short meta line.
 * The whole row is the link (`href`) or button (`onClick`). Render inside <ul class="lr-list">.
 */
export function ListRow({ href, onClick, leading, title, badge, subtitle, amount, meta, metaTone, current, label }) {
  const body = html`
    ${leading}
    <div class="lr-main">
      <div class="lr-title"><span class="lr-title-text">${title}</span>${badge}</div>
      ${subtitle && html`<div class="lr-sub">${subtitle}</div>`}
    </div>
    ${(amount || meta) && html`<div class="lr-aside">
      ${amount && html`<div class="lr-amount">${amount}</div>`}
      ${meta && html`<div class=${cx('lr-meta', metaTone && `tone-${metaTone}`)}>${meta}</div>`}
    </div>`}`;
  return html`<li>${href
    ? html`<a class=${cx('lr', current && 'is-current')} href=${href} aria-label=${label}>${body}</a>`
    : html`<button type="button" class=${cx('lr', current && 'is-current')} onClick=${onClick} aria-label=${label}>${body}</button>`}</li>`;
}

// ---------------------------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------------------------

const byName = (a, b) => a.sortName.localeCompare(b.sortName, 'en-GB') || a.index - b.index;
const descending = (pick) => (a, b) => pick(b) - pick(a) || byName(a, b);

const SORTS = [
  { value: 'name', label: 'Name A–Z', compare: byName },
  {
    value: 'recent',
    label: 'Latest sale',
    // Clients who never bought go last, then by name.
    compare: (a, b) => (b.stats.lastSale ?? '').localeCompare(a.stats.lastSale ?? '') || byName(a, b),
  },
  { value: 'profit', label: 'Most profit', compare: descending((row) => row.stats.netProfit) },
  { value: 'revenue', label: 'Most revenue', compare: descending((row) => row.stats.revenue) },
  { value: 'owed', label: 'Owes you most', compare: descending((row) => row.stats.owed) },
];
const SORT_OPTIONS = SORTS.map(({ value, label }) => ({ value, label }));

const LIST_TABS = [
  { id: 'active', label: 'All', test: (row) => !row.client.archived },
  // An archived client who still owes money must stay visible here.
  { id: 'unpaid', label: 'Unpaid', test: (row) => row.stats.owed > EPS },
  { id: 'archived', label: 'Archived', test: (row) => Boolean(row.client.archived) },
];
const TAB_IDS = new Set(LIST_TABS.map((tab) => tab.id));
const TAG_LIMIT = 12;

async function loadClients(store) {
  const [clients, deals] = await Promise.all([store.clients.list({ includeArchived: true }), store.deals.list()]);
  return { clients, deals };
}

function listHref({ tab, q, sort, tag }) {
  const query = new URLSearchParams();
  if (tab && tab !== 'active') query.set('tab', tab);
  if (q) query.set('q', q);
  if (sort && sort !== 'name') query.set('sort', sort);
  if (tag) query.set('tag', tag);
  const text = query.toString();
  return `#/clients${text ? `?${text}` : ''}`;
}

/** The most used tags (most clients first), always including the one being filtered on. */
function popularTags(rows, active) {
  const counts = new Map();
  for (const row of rows) {
    if (row.client.archived) continue;
    for (const tag of row.client.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  const tags = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'en-GB'))
    .slice(0, TAG_LIMIT)
    .map(([tag]) => tag);
  if (active && !tags.includes(active)) tags.push(active);
  return tags;
}

function stopPropagation(event) {
  event.stopPropagation();
}

function ClientRow({ row, navigate }) {
  const { client, stats } = row;
  const href = `#/clients/${client.id}`;
  const line = clientLine(client);
  const sizes = sizesLine(client);
  const hasSales = stats.count > 0;
  return html`<tr class="is-clickable" onClick=${() => navigate(href)}>
    <td class="cell-primary">
      <div class="cl-cell-client">
        <${Avatar} name=${client.name} />
        <div class="cl-who">
          <div class="cl-who-name">
            <a href=${href} class="strong truncate" onClick=${stopPropagation}>${client.name}</a>
            ${client.archived && html`<${Badge} tone="muted" dot=${false}>Archived<//>`}
          </div>
          <div class="small muted truncate cl-sub">${line || 'No club saved'}</div>
          <${TagPills} tags=${client.tags} limit=${3} />
        </div>
      </div>
    </td>
    <td data-label="Sizes" class="cell-low">${sizes || null}</td>
    <td data-label="Last order" class="cell-low">
      ${stats.lastSale
        ? html`<span class="nowrap">${saleDateText(stats.lastSale)}</span><div class="tiny faint">${relDays(stats.lastSale)}</div>`
        : null}
    </td>
    <td data-label="Orders" class="num">${hasSales ? String(stats.count) : html`<span class="faint">—</span>`}</td>
    <td data-label="Revenue" class="num">${hasSales ? html`<${Money} value=${stats.revenue} />` : null}</td>
    <td data-label="Owed" class="num">${stats.owed > EPS ? html`<${Money} value=${stats.owed} tone="warn" />` : null}</td>
    <td data-label="Lifetime profit" class="num cell-key">
      ${hasSales
        ? html`<${Money} value=${stats.netProfit} tone="auto" class="strong" />${stats.estimatedCount > 0 && html` <span class="pill pill-warn" title="Some costs are still expected">est.</span>`}`
        : html`<span class="faint">No orders yet</span>`}
    </td>
  </tr>`;
}

// Phones: name and club on the left, lifetime profit and what they owe (or their last sale)
// on the right.
function ClientListRow({ row }) {
  const { client, stats } = row;
  const hasSales = stats.count > 0;
  const owes = stats.owed > EPS;
  let meta = 'No orders yet';
  if (owes) meta = `${money(stats.owed, { pence: false })} owed`;
  else if (hasSales) meta = plural(stats.count, 'order');
  return html`<${ListRow}
    href=${`#/clients/${client.id}`}
    leading=${html`<${Avatar} name=${client.name} />`}
    title=${client.name}
    badge=${client.archived && html`<${Badge} tone="muted" dot=${false}>Archived<//>`}
    subtitle=${clientLine(client) || sizesLine(client) || 'No club saved'}
    amount=${hasSales ? html`<${Money} value=${stats.netProfit} tone="auto" />${stats.estimatedCount > 0 ? html`<span class="tone-warn small"> est.</span>` : ''}` : html`<span class="faint">—</span>`}
    meta=${meta}
    metaTone=${owes ? 'warn' : undefined}
  />`;
}

export default function ClientsView({ store, params, navigate }) {
  const { data, error, loading, reload } = useStoreData(store, loadClients);
  const phone = usePhone();
  const tab = TAB_IDS.has(params.tab) ? params.tab : 'active';
  const q = typeof params.q === 'string' ? params.q : '';
  const sort = SORTS.some((option) => option.value === params.sort) ? params.sort : 'name';
  const tag = typeof params.tag === 'string' ? params.tag : '';
  const setView = (patch) => navigate(listHref({ tab, q, sort, tag, ...patch }), { replace: true });

  const rows = useMemo(() => {
    if (!data) return [];
    const byClient = dealsByClient(data.deals);
    return data.clients.map((client, index) => ({
      client,
      index,
      stats: clientStats(byClient.get(client.id)),
      haystack: clientHaystack(client),
      sortName: normaliseText(client.name),
    }));
  }, [data]);

  const filtered = useMemo(() => {
    const tokens = normaliseText(q).trim().split(/\s+/).filter(Boolean);
    return rows.filter((row) => (!tag || (row.client.tags ?? []).includes(tag))
      && tokens.every((token) => row.haystack.includes(token)));
  }, [rows, q, tag]);

  const archivedCount = rows.filter((row) => row.client.archived).length;
  const tabs = LIST_TABS
    .filter((entry) => entry.id !== 'archived' || archivedCount > 0 || tab === 'archived')
    .map(({ id, label, test }) => ({ id, label, count: filtered.filter(test).length }));
  const activeTab = LIST_TABS.find((entry) => entry.id === tab);
  const shown = useMemo(() => {
    const compare = SORTS.find((option) => option.value === sort).compare;
    return filtered.filter(activeTab.test).sort(compare);
  }, [filtered, activeTab, sort]);
  const tags = useMemo(() => popularTags(rows, tag), [rows, tag]);

  const actions = html`<${Button} kind="primary" icon="plus" href="#/clients/new">New client<//>`;
  const page = (body) => html`<${Page}
    title="Clients"
    subtitle="Who you sell to, and what each of them is worth to you."
    actions=${actions}
  >${body}<//>`;

  if (loading) return page(html`<${Loading} label="Loading clients…" />`);
  if (error && !data) {
    return page(html`<${Card}><${ErrorState} error=${error} title="Couldn't load your clients" onRetry=${reload} /><//>`);
  }
  if (rows.length === 0) {
    return page(html`<${Card}>
      <${Empty}
        icon="users"
        title="No clients yet"
        body="Add the players you sell to — club, sizes, agent and drop-off addresses — and Desk keeps a running total of what each one is worth to you."
        action=${html`<${Button} kind="primary" icon="plus" href="#/clients/new">Add your first client<//>`}
      />
    <//>`);
  }

  const sum = (pick) => shown.reduce((total, row) => total + pick(row.stats), 0);
  const owed = sum((stats) => stats.owed);
  const pounds = (n) => money(n, { pence: false });
  const cardSubtitle = [
    `${pounds(sum((stats) => stats.netProfit))} profit`,
    `${pounds(sum((stats) => stats.revenue))} revenue`,
    owed > EPS && `${pounds(owed)} owed`,
  ].filter(Boolean).join(' · ');

  let emptyTitle;
  let emptyBody;
  if (q) {
    emptyTitle = `No clients match “${q}”`;
    emptyBody = 'Try a name, club, position, agent, phone number or tag.';
  } else if (tag) {
    emptyTitle = `No clients tagged “${tag}” here`;
    emptyBody = 'Try another tab, or show every tag.';
  } else if (tab === 'unpaid') {
    emptyTitle = 'Nobody owes you anything';
    emptyBody = 'Every sale is paid up.';
  } else if (tab === 'archived') {
    emptyTitle = 'No archived clients';
    emptyBody = 'Archive a client from their profile to take them off your list.';
  } else {
    emptyTitle = 'Every client is archived';
    emptyBody = 'Open the Archived tab to see them.';
  }
  const clearFilters = html`
    ${q && html`<${Button} onClick=${() => setView({ q: '' })}>Clear search<//>`}
    ${tag && html`<${Button} onClick=${() => setView({ tag: '' })}>Show every tag<//>`}
    ${tab !== 'active' && html`<${Button} kind="ghost" onClick=${() => setView({ tab: 'active' })}>Show all clients<//>`}
    ${tab === 'active' && !q && !tag && html`<${Button} onClick=${() => setView({ tab: 'archived' })}>Show archived<//>`}`;

  return page(html`
    ${error && html`<${Banner} tone="warn" title="Couldn't refresh" actions=${html`<${Button} size="sm" onClick=${reload}>Try again<//>`}>
      ${error.message}
    <//>`}
    <${Tabs} tabs=${tabs} value=${tab} onChange=${(id) => setView({ tab: id })} label="Filter clients" />
    <div class="toolbar cl-toolbar">
      <${SearchBox}
        value=${q}
        onInput=${(text) => setView({ q: text })}
        placeholder="Search clients"
        label="Search clients"
      />
      <${Select}
        aria-label="Sort clients"
        options=${SORT_OPTIONS}
        value=${sort}
        onChange=${(event) => setView({ sort: event.currentTarget.value })}
      />
    </div>
    ${tags.length > 0 && html`<div class="chips cl-chips" role="group" aria-label="Filter by tag">
      ${tags.map((name) => html`<button
        key=${name}
        type="button"
        class="chip"
        aria-pressed=${name === tag ? 'true' : 'false'}
        onClick=${() => setView({ tag: name === tag ? '' : name })}
      >${name}</button>`)}
    </div>`}
    <${Card} pad=${false} title=${plural(shown.length, 'client')} subtitle=${shown.length > 0 ? cardSubtitle : null}>
      ${shown.length === 0
        ? html`<${Empty} icon="search" title=${emptyTitle} body=${emptyBody} action=${clearFilters} />`
        : phone
          ? html`<ul class="lr-list">${shown.map((row) => html`<${ClientListRow} key=${row.client.id} row=${row} />`)}</ul>`
          : html`<div class="table-wrap">
            <table class="table cl-table">
              <thead>
                <tr>
                  <th scope="col">Client</th>
                  <th scope="col">Sizes</th>
                  <th scope="col">Last order</th>
                  <th scope="col" class="num">Orders</th>
                  <th scope="col" class="num">Revenue</th>
                  <th scope="col" class="num">Owed</th>
                  <th scope="col" class="num">Lifetime profit</th>
                </tr>
              </thead>
              <tbody>
                ${shown.map((row) => html`<${ClientRow} key=${row.client.id} row=${row} navigate=${navigate} />`)}
              </tbody>
            </table>
          </div>`}
    <//>
  `);
}

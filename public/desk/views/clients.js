// Clients (#/clients): everyone you sell to and what each one is worth to you — lifetime
// revenue and profit, what they still owe and when they last bought. Search, sort, tab and tag
// filters live in the address (`#/clients?q=…&sort=…&tab=…&tag=…`), so Back returns to the
// same view.
//
// Also exports what the Client profile (views/client.js) shares with this list: search text,
// the "club · position · #7" line, sizes, per-client sales stats (from calc.js), the initials
// avatar and tag pills, plus the few styles both screens need that desk.css has no class for.

import { html, useMemo } from '../lib/preact.js';
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
import { EPS, dealTotals, summarise } from '../lib/calc.js';
import { date as formatDate, dateShort, money, plural, relDays, todayISO } from '../lib/format.js';

// ---------------------------------------------------------------------------------------------
// Styles shared by the client screens (added to <head> once, like the components do)
// ---------------------------------------------------------------------------------------------

const CSS = `
.cl-avatar { display: inline-grid; flex: none; place-items: center; width: 36px; height: 36px; border-radius: 50%; background: var(--signal-tint); color: var(--signal); font-size: 13px; font-weight: 600; letter-spacing: 0.02em; line-height: 1; user-select: none; }
.cl-avatar-lg { width: 56px; height: 56px; font-size: 19px; }
.cl-who { flex: 1 1 auto; min-width: 0; }
.cl-sub { font-weight: 400; }
.cl-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.cl-tags .pill { max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.cl-table td.cell-primary { min-width: 220px; }
@media (max-width: 639.98px) {
  .cl-table td.cell-primary { min-width: 0; }
}
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
 * revenue), like a deal's own.
 */
export function clientStats(deals) {
  const list = Array.isArray(deals) ? deals : [];
  const summary = summarise(list);
  const stats = {
    ...summary,
    owed: summarise(list.filter((deal) => deal.status !== 'enquiry')).owed,
    margin: summary.revenue > 0 ? summary.netProfit / summary.revenue : null,
    lastSale: null,
    open: 0,
    cancelled: 0,
    estimatedCount: 0,
    dueNow: 0,
  };
  for (const deal of list) {
    if (deal.status === 'cancelled') {
      stats.cancelled += 1;
      continue;
    }
    const totals = dealTotals(deal);
    if (totals.certainty === 'estimated') stats.estimatedCount += 1;
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
      <div class="row row-nowrap" style="gap:10px;align-items:flex-start">
        <${Avatar} name=${client.name} />
        <div class="cl-who">
          <div class="row row-nowrap" style="gap:6px">
            <a href=${href} class="strong truncate" onClick=${stopPropagation}>${client.name}</a>
            ${client.archived && html`<${Badge} tone="muted" dot=${false}>Archived<//>`}
          </div>
          <div class="small muted truncate cl-sub">${line || 'No club saved'}</div>
          <${TagPills} tags=${client.tags} limit=${3} />
        </div>
      </div>
    </td>
    <td data-label="Sizes">${sizes || null}</td>
    <td data-label="Revenue" class="num">
      ${hasSales
        ? html`<${Money} value=${stats.revenue} /><div class="tiny faint">${plural(stats.count, 'sale')}</div>`
        : html`<span class="faint">No sales yet</span>`}
    </td>
    <td data-label="Profit" class="num">
      ${hasSales && html`<${Money} value=${stats.netProfit} tone="auto" />`}
      ${hasSales && stats.estimatedCount > 0 && html` <span class="pill pill-warn" title="Some costs are still expected">est.</span>`}
    </td>
    <td data-label="Owed" class="num">${stats.owed > EPS ? html`<${Money} value=${stats.owed} tone="warn" />` : null}</td>
    <td data-label="Last sale">
      ${stats.lastSale
        ? html`<span class="nowrap">${saleDateText(stats.lastSale)}</span><div class="tiny faint">${relDays(stats.lastSale)}</div>`
        : null}
    </td>
  </tr>`;
}

export default function ClientsView({ store, params, navigate }) {
  const { data, error, loading, reload } = useStoreData(store, loadClients);
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
  const cardSubtitle = [
    `${money(sum((stats) => stats.revenue))} revenue`,
    `${money(sum((stats) => stats.netProfit))} profit`,
    owed > EPS && `${money(owed)} owed`,
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
    <div class="toolbar">
      <${SearchBox}
        value=${q}
        onInput=${(text) => setView({ q: text })}
        placeholder="Search name, club or tag"
        label="Search clients"
      />
      <${Select}
        aria-label="Sort clients"
        options=${SORT_OPTIONS}
        value=${sort}
        onChange=${(event) => setView({ sort: event.currentTarget.value })}
      />
    </div>
    ${tags.length > 0 && html`<div class="chips" role="group" aria-label="Filter by tag">
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
        : html`<div class="table-wrap">
            <table class="table cl-table">
              <thead>
                <tr>
                  <th scope="col">Client</th>
                  <th scope="col">Sizes</th>
                  <th scope="col" class="num">Revenue</th>
                  <th scope="col" class="num">Profit</th>
                  <th scope="col" class="num">Owed</th>
                  <th scope="col">Last sale</th>
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

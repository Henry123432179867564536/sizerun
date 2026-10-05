// Search (#/search?q=…): one box that finds clients (with a drop-down of every order they placed),
// every sale of an item across clients (size, price paid and profit), and sales by SM number.
// The maths lives in lib/search.js (pure, Node-tested); this file only lays it out. The query is
// kept in the address with history.replaceState, so Back from a sale returns to the same results.

import { html, useEffect, useMemo, useRef, useState } from '../lib/preact.js';
import {
  Card,
  Empty,
  ErrorState,
  Icon,
  Loading,
  Page,
  SearchBox,
  cx,
  isCoarsePointer,
  useStoreData,
} from '../lib/ui.js';
import { dealNumber, round2 } from '../lib/calc.js';
import { date as formatDate, dateShort, money, plural, todayISO } from '../lib/format.js';
import { itemsSummary, search } from '../lib/search.js';

// ---------------------------------------------------------------------------------------------
// Styles (added to <head> once, like the other views do)
// ---------------------------------------------------------------------------------------------

const CSS = `
.sr { display: flex; flex-direction: column; gap: 20px; min-width: 0; }
.sr-bar { margin: 0; }
.sr-bar .search .search-input { height: 52px; padding-left: 44px; font-size: 17px; border-radius: var(--r-panel); }
.sr-bar .search .search-icon { left: 15px; width: 20px; height: 20px; }
.sr-bar .search-clear { width: 44px; height: 44px; }
.sr-jump { display: flex; flex-wrap: wrap; gap: 6px; margin-top: -8px; }
.sr-sec { display: flex; flex-direction: column; gap: 10px; min-width: 0; scroll-margin-top: calc(var(--topbar-h) + var(--safe-t) + 12px); }
.sr-sec-head { display: flex; align-items: baseline; gap: 8px; margin: 0; padding: 0 2px; color: var(--ink-2); font-size: 12px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; }
.sr-sec-count { color: var(--ink-3); font-variant-numeric: tabular-nums; }
.sr-list { margin: 0; padding: 0; list-style: none; }
.sr-list > li + li { border-top: 1px solid var(--line); }
.sr-row { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 60px; margin: 0; padding: 10px 16px; border: 0; background: none; color: inherit; font: inherit; text-align: left; text-decoration: none; cursor: pointer; -webkit-tap-highlight-color: transparent; }
a.sr-row:active, button.sr-row:active, .sr-cmain:active, .sr-toggle:active { background: var(--hover); text-decoration: none; }
@media (hover: hover) {
  a.sr-row:hover, button.sr-row:hover, .sr-cmain:hover, .sr-toggle:hover, .sr-more:hover, .sr-x:hover { background: var(--hover); text-decoration: none; }
  .sr-cmain:hover .sr-title-text { text-decoration: underline; text-decoration-color: var(--line-2); text-underline-offset: 3px; }
}
.sr-row:focus-visible, .sr-toggle:focus-visible, .sr-cmain:focus-visible { outline: 2px solid var(--signal); outline-offset: -2px; }
.sr-main { display: flex; flex: 1 1 auto; flex-direction: column; min-width: 0; }
.sr-title { display: flex; align-items: center; gap: 6px; min-width: 0; color: var(--ink); font-size: 15px; font-weight: 500; line-height: 1.3; }
.sr-title-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sr-title > .pill, .sr-title > .sr-more-count { flex: none; }
.sr-more-count { color: var(--ink-3); font-weight: 500; white-space: nowrap; }
.sr-unit { color: var(--ink-3); font-size: 12px; font-weight: 500; }
.sr-sub { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; min-width: 0; margin-top: 3px; color: var(--ink-2); font-size: 13px; line-height: 1.35; }
.sr-sub-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sr-sub > .pill { flex: none; }
.sr-aside { display: flex; flex: none; flex-direction: column; align-items: flex-end; gap: 3px; max-width: 48%; text-align: right; }
.sr-amount { font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1.3; white-space: nowrap; }
.sr-meta { display: flex; align-items: center; justify-content: flex-end; gap: 5px; color: var(--ink-3); font-size: 12px; font-weight: 500; font-variant-numeric: tabular-nums; line-height: 1.3; white-space: nowrap; }
.sr-meta.tone-gain { color: var(--gain); }
.sr-meta.tone-loss { color: var(--loss); }
.sr-avatar { display: inline-grid; flex: none; place-items: center; width: 36px; height: 36px; border-radius: 50%; background: var(--signal-tint); color: var(--signal); font-size: 13px; font-weight: 600; letter-spacing: 0.02em; line-height: 1; user-select: none; }

/* client row: name (a link) on the left, figures + chevron (the drop-down toggle) on the right */
.sr-client { display: flex; align-items: stretch; min-height: 64px; }
.sr-cmain { display: flex; flex: 1 1 auto; align-items: center; gap: 12px; min-width: 0; padding: 10px 4px 10px 16px; color: inherit; text-decoration: none; -webkit-tap-highlight-color: transparent; }
.sr-toggle { display: flex; flex: none; align-items: center; gap: 8px; max-width: 50%; margin: 0; padding: 10px 12px 10px 8px; border: 0; background: none; color: inherit; font: inherit; text-align: right; cursor: pointer; -webkit-tap-highlight-color: transparent; }
.sr-toggle .sr-aside { max-width: none; }
.sr-chev { display: grid; flex: none; place-items: center; width: 28px; height: 28px; border-radius: 50%; background: var(--surface-2); color: var(--ink-2); transition: transform 0.18s ease, background 0.18s ease; }
.sr-toggle[aria-expanded="true"] .sr-chev { transform: rotate(180deg); background: var(--signal-tint); color: var(--signal); }
.sr-drop { padding: 4px 0 12px; border-top: 1px solid var(--line); background: var(--surface-2); }
.sr-drop .sr-list { margin: 0 12px; border: 1px solid var(--line); border-radius: var(--r-ctl); background: var(--surface); overflow: hidden; }
.sr-drop .sr-row { min-height: 56px; padding: 9px 12px; }
.sr-drop-head { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; padding: 8px 16px 8px; color: var(--ink-2); font-size: 12px; }
.sr-drop-head strong { color: var(--ink); font-weight: 600; font-variant-numeric: tabular-nums; }
.sr-profile { display: flex; align-items: center; justify-content: center; gap: 4px; min-height: 40px; margin: 8px 12px 0; color: var(--signal); font-size: 14px; font-weight: 500; text-decoration: none; }
.sr-profile:hover { text-decoration: underline; }
.sr-cancelled .sr-title-text, .sr-cancelled .sr-amount { color: var(--ink-3); text-decoration: line-through; text-decoration-color: var(--ink-3); }

/* item groups */
.sr-ghead { padding: 14px 16px 12px; border-bottom: 1px solid var(--line); }
.sr-gtitle { margin: 0; color: var(--ink); font-size: 16px; font-weight: 600; line-height: 1.3; overflow-wrap: anywhere; }
.sr-gsub { margin: 2px 0 0; color: var(--ink-2); font-size: 13px; }
.sr-gstats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin: 12px 0 0; }
.sr-gstat { min-width: 0; padding: 8px 10px; border-radius: var(--r-ctl); background: var(--surface-2); }
.sr-gstat dt { overflow: hidden; color: var(--ink-3); font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-overflow: ellipsis; text-transform: uppercase; white-space: nowrap; }
.sr-gstat dd { display: flex; align-items: center; gap: 4px; margin: 2px 0 0; overflow: hidden; color: var(--ink); font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
.sr-gstat dd.tone-gain { color: var(--gain); }
.sr-gstat dd.tone-loss { color: var(--loss); }
.sr-more { display: block; width: 100%; min-height: 44px; padding: 10px 16px; border: 0; border-top: 1px solid var(--line); background: none; color: var(--signal); font: inherit; font-size: 14px; font-weight: 500; text-align: center; cursor: pointer; }
.sr-groups { display: flex; flex-direction: column; gap: 12px; }

/* empty query: recent searches and tips */
.sr-recent { display: flex; align-items: stretch; }
.sr-recent .sr-row { min-height: 48px; }
.sr-recent .sr-row .icon { flex: none; color: var(--ink-3); }
.sr-x { display: grid; flex: none; place-items: center; width: 48px; border: 0; background: none; color: var(--ink-3); cursor: pointer; }
.sr-tips { display: grid; gap: 12px; margin: 0; padding: 0; list-style: none; }
.sr-tip { display: flex; align-items: center; justify-content: space-between; gap: 12px; color: var(--ink-2); font-size: 14px; }
.sr-tip > span { flex: 1 1 auto; min-width: 0; }
.sr-tip .chip { display: block; flex: none; max-width: 55%; overflow: hidden; line-height: 30px; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 479.98px) {
  .sr-cmain .sr-avatar { display: none; }
}
@media (min-width: 900px) {
  .sr { max-width: 860px; }
}
`;

const STYLE_ID = 'desk-search-styles';
if (typeof document !== 'undefined' && !document.getElementById(STYLE_ID)) {
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.append(style);
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const RECENT_KEY = 'sizemill.desk.recentSearches';
const RECENT_MAX = 8;
const DEBOUNCE_MS = 150;
const CLIENTS_SHOWN = 20;
const ROWS_SHOWN = 8;
const GROUPS_SHOWN = 6;

function readRecent() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((q) => typeof q === 'string' && q.trim()).slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

function writeRecent(list) {
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
  } catch {
    // Private mode or blocked storage: recent searches just aren't remembered.
  }
}

function withRecent(list, query) {
  const q = query.trim();
  if (!q) return list;
  const key = q.toLowerCase();
  return [q, ...list.filter((item) => item.toLowerCase() !== key)].slice(0, RECENT_MAX);
}

/** '£900' for whole pounds, '£12.50' otherwise. */
function gbp(value, options = {}) {
  const pence = !Number.isInteger(round2(Math.abs(Number(value) || 0)));
  return money(value, { pence, ...options });
}

function toneOf(value) {
  if (value >= 0.005) return 'gain';
  if (value <= -0.005) return 'loss';
  return undefined;
}

function profitText(value) {
  return `${gbp(value, { sign: true })} profit`;
}

/** '5 Oct' this year, '5 Oct 2025' before. */
function when(iso) {
  return typeof iso === 'string' && iso.slice(0, 4) === todayISO().slice(0, 4) ? dateShort(iso) : formatDate(iso);
}

function initials(name) {
  const words = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  const first = [...words[0]][0];
  const last = words.length > 1 ? [...words[words.length - 1]][0] : '';
  return `${first}${last}`.toUpperCase();
}

function clientLine(client) {
  return [client?.club, client?.position].map((v) => (typeof v === 'string' ? v.trim() : '')).filter(Boolean).join(' · ');
}

function hashFor(query) {
  const q = query.trim();
  return q ? `#/search?${new URLSearchParams({ q })}` : '#/search';
}

const PAYMENT_PILL = {
  paid: ['Paid', 'pill-gain'],
  part: ['Part paid', 'pill-warn'],
  unpaid: ['Unpaid', 'pill-loss'],
};

function OrderPills({ totals, cancelled }) {
  if (cancelled) return html`<span class="pill">Cancelled</span>`;
  const payment = PAYMENT_PILL[totals.paymentStatus];
  return html`${totals.certainty === 'estimated' && html`<span class="pill pill-warn" title="Some costs are still estimates">est.</span>`}${
    payment && html`<span class=${cx('pill', payment[1])}>${payment[0]}</span>`}`;
}

// ---------------------------------------------------------------------------------------------
// Result sections
// ---------------------------------------------------------------------------------------------

function Section({ id, title, count, children }) {
  return html`<section class="sr-sec" id=${id} aria-labelledby=${`${id}-h`}>
    <h2 class="sr-sec-head" id=${`${id}-h`}>${title}<span class="sr-sec-count">${count}</span></h2>
    ${children}
  </section>`;
}

function OrderTitle({ deal }) {
  const items = Array.isArray(deal.items) ? deal.items : [];
  if (!items.length) return html`<span class="sr-title"><span class="sr-title-text">${deal.title || 'No items yet'}</span></span>`;
  const first = items[0];
  return html`<span class="sr-title">
    <span class="sr-title-text">${String(first.description ?? '').trim() || 'Item'} ×${Number(first.qty) || 1}</span>
    ${items.length > 1 && html`<span class="sr-more-count">+${items.length - 1} more</span>`}
  </span>`;
}

function ClientOrder({ order }) {
  const { deal, totals, cancelled } = order;
  return html`<li>
    <a class=${cx('sr-row', cancelled && 'sr-cancelled')} href=${`#/sales/${deal.id}`}>
      <span class="sr-main">
        <${OrderTitle} deal=${deal} />
        <span class="sr-sub"><span class="sr-sub-text">${[dealNumber(deal.number), when(deal.sale_date)].filter(Boolean).join(' · ')}</span><${OrderPills} totals=${totals} cancelled=${cancelled} /></span>
      </span>
      <span class="sr-aside">
        <span class="sr-amount">${gbp(totals.revenue)}</span>
        <span class=${cx('sr-meta', !cancelled && toneOf(totals.netProfit) && `tone-${toneOf(totals.netProfit)}`)}>${profitText(totals.netProfit)}</span>
      </span>
    </a>
  </li>`;
}

function ClientResult({ result, open, onToggle }) {
  const { client, orders, lifetime } = result;
  const dropId = `sr-drop-${client.id}`;
  const profitTone = toneOf(lifetime.profit);
  const orderCount = lifetime.orders + lifetime.cancelled;
  return html`<li>
    <div class="sr-client">
      <a class="sr-cmain" href=${`#/clients/${client.id}`}>
        <span class="sr-avatar" aria-hidden="true">${initials(client.name)}</span>
        <span class="sr-main">
          <span class="sr-title"><span class="sr-title-text">${client.name || 'Unnamed client'}</span>${client.archived && html`<span class="pill">Archived</span>`}</span>
          ${clientLine(client) && html`<span class="sr-sub"><span class="sr-sub-text">${clientLine(client)}</span></span>`}
        </span>
      </a>
      <button
        type="button"
        class="sr-toggle"
        aria-expanded=${open ? 'true' : 'false'}
        aria-controls=${dropId}
        aria-label=${`${open ? 'Hide' : 'Show'} ${plural(orderCount, 'order')} for ${client.name || 'this client'}`}
        onClick=${onToggle}
      >
        <span class="sr-aside">
          <span class=${cx('sr-amount', profitTone && `tone-${profitTone}`)}>${lifetime.orders ? gbp(lifetime.profit, { pence: false }) : '—'}${lifetime.orders > 0 && html`<span class="sr-unit"> profit</span>`}</span>
          <span class="sr-meta">${plural(lifetime.orders, 'order')}${lifetime.estimated && html`<span class="pill pill-warn" title="Some costs are still estimates">est.</span>`}</span>
        </span>
        <span class="sr-chev"><${Icon} name="chevron-down" size=${16} /></span>
      </button>
    </div>
    ${open && html`<div class="sr-drop" id=${dropId}>
      <div class="sr-drop-head">
        ${lifetime.orders
          ? html`<span><strong>${gbp(lifetime.revenue)}</strong> revenue</span>
            <span>avg <strong>${money(lifetime.avgProfitPerOrder, { pence: false })}</strong> profit / order</span>
            <span><strong>${lifetime.items}</strong> ${lifetime.items === 1 ? 'item' : 'items'}</span>`
          : html`<span>${orders.length ? 'Only cancelled orders' : 'No orders yet'}</span>`}
      </div>
      ${orders.length > 0 && html`<ul class="sr-list">
        ${orders.map((order) => html`<${ClientOrder} key=${order.deal.id} order=${order} />`)}
      </ul>`}
      <a class="sr-profile" href=${`#/clients/${client.id}`}>Open ${client.name ? `${String(client.name).trim().split(/\s+/)[0]}’s` : 'client'} profile<${Icon} name="chevron-right" size=${16} /></a>
    </div>`}
  </li>`;
}

function ClientsSection({ clients }) {
  const [openIds, setOpenIds] = useState({});
  const [showAll, setShowAll] = useState(false);
  const defaultOpen = clients.length === 1;
  const shown = showAll ? clients : clients.slice(0, CLIENTS_SHOWN);
  return html`<${Section} id="sr-clients" title="Clients" count=${clients.length}>
    <${Card} pad=${false}>
      <ul class="sr-list">
        ${shown.map((result) => {
          const id = result.client.id;
          const open = id in openIds ? openIds[id] : defaultOpen;
          return html`<${ClientResult}
            key=${id}
            result=${result}
            open=${open}
            onToggle=${() => setOpenIds((prev) => ({ ...prev, [id]: !open }))}
          />`;
        })}
      </ul>
      ${clients.length > shown.length && html`<button type="button" class="sr-more" onClick=${() => setShowAll(true)}>Show all ${clients.length} clients</button>`}
    <//>
  <//>`;
}

function ItemRow({ row }) {
  const { deal, client, qty, unitPrice, lineProfit, estimated, cancelled } = row;
  const tone = !cancelled && toneOf(lineProfit);
  const sub = [row.size && `Size ${row.size}`, when(row.saleDate), dealNumber(deal.number)].filter(Boolean).join(' · ');
  return html`<li>
    <a class=${cx('sr-row', cancelled && 'sr-cancelled')} href=${`#/sales/${deal.id}`}>
      <span class="sr-main">
        <span class="sr-title"><span class="sr-title-text">${client?.name || 'No client'}</span>${cancelled && html`<span class="pill">Cancelled</span>`}</span>
        <span class="sr-sub"><span class="sr-sub-text">${sub}</span></span>
      </span>
      <span class="sr-aside">
        <span class="sr-amount">${gbp(unitPrice)}${qty !== 1 && html`<span class="muted"> ×${qty}</span>`}</span>
        <span class=${cx('sr-meta', tone && `tone-${tone}`)}>${profitText(lineProfit)}${estimated && html`<span class="pill pill-warn" title="Cost not confirmed yet">est.</span>`}</span>
      </span>
    </a>
  </li>`;
}

function ItemGroup({ group, single }) {
  const [showAll, setShowAll] = useState(false);
  const { stats } = group;
  const rows = showAll || single ? group.rows : group.rows.slice(0, ROWS_SHOWN);
  const estPill = stats.estimated && html` <span class="pill pill-warn" title="Includes costs not confirmed yet">est.</span>`;
  const sold = stats.units === 1 ? 'Sold once' : `Sold ${stats.units} times`;
  const subtitle = stats.units
    ? `${sold}${stats.clients > 1 ? ` to ${stats.clients} clients` : ''} · avg ${money(stats.avgProfit, { pence: false })} profit each`
    : 'Only on cancelled sales';
  const profitTone = toneOf(stats.profit);
  return html`<${Card} pad=${false} class="sr-group">
    <div class="sr-ghead">
      <h3 class="sr-gtitle">${group.description}</h3>
      <p class="sr-gsub">${subtitle}${estPill}</p>
      ${stats.units > 0 && html`<dl class="sr-gstats">
        <div class="sr-gstat"><dt>Sold</dt><dd>${stats.units}</dd></div>
        <div class="sr-gstat"><dt>Profit</dt><dd class=${profitTone && `tone-${profitTone}`}>${gbp(stats.profit, { pence: false })}</dd></div>
        <div class="sr-gstat"><dt>Avg sale</dt><dd>${money(stats.avgSalePrice, { pence: false })}</dd></div>
      </dl>`}
    </div>
    <ul class="sr-list">
      ${rows.map((row) => html`<${ItemRow} key=${`${row.deal.id}:${row.item.id}`} row=${row} />`)}
    </ul>
    ${rows.length < group.rows.length && html`<button type="button" class="sr-more" onClick=${() => setShowAll(true)}>Show all ${group.rows.length} sales</button>`}
  <//>`;
}

function ItemsSection({ groups, count }) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? groups : groups.slice(0, GROUPS_SHOWN);
  return html`<${Section} id="sr-items" title="Items sold" count=${count}>
    <div class="sr-groups">
      ${shown.map((group) => html`<${ItemGroup} key=${group.key} group=${group} single=${groups.length === 1} />`)}
      ${groups.length > shown.length && html`<${Card} pad=${false}>
        <button type="button" class="sr-more" style="border-top:0" onClick=${() => setShowAll(true)}>Show ${groups.length - shown.length} more items</button>
      <//>`}
    </div>
  <//>`;
}

function OrdersSection({ orders }) {
  return html`<${Section} id="sr-orders" title="Sales" count=${orders.length}>
    <${Card} pad=${false}>
      <ul class="sr-list">
        ${orders.slice(0, 30).map(({ deal, client, totals, cancelled }) => html`<li key=${deal.id}>
          <a class=${cx('sr-row', cancelled && 'sr-cancelled')} href=${`#/sales/${deal.id}`}>
            <span class="sr-main">
              <span class="sr-title"><span class="sr-title-text">${[dealNumber(deal.number), client?.name].filter(Boolean).join(' · ') || 'Sale'}</span></span>
              <span class="sr-sub"><span class="sr-sub-text">${[deal.title || itemsSummary(deal), when(deal.sale_date)].filter(Boolean).join(' · ')}</span><${OrderPills} totals=${totals} cancelled=${cancelled} /></span>
            </span>
            <span class="sr-aside">
              <span class="sr-amount">${gbp(totals.revenue)}</span>
              <span class=${cx('sr-meta', !cancelled && toneOf(totals.netProfit) && `tone-${toneOf(totals.netProfit)}`)}>${profitText(totals.netProfit)}</span>
            </span>
          </a>
        </li>`)}
      </ul>
    <//>
  <//>`;
}

// ---------------------------------------------------------------------------------------------
// Empty query: recent searches and tips
// ---------------------------------------------------------------------------------------------

function examplesFrom(data) {
  const deals = Array.isArray(data?.deals) ? data.deals : [];
  const counts = new Map();
  for (const deal of deals) {
    for (const item of deal.items ?? []) {
      const name = String(item.description ?? '').trim();
      if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  const topItem = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const recentClient = deals.find((d) => d.client?.name)?.client?.name;
  const club = (data?.clients ?? []).find((c) => c.club)?.club;
  const latest = deals[0]?.number;
  return {
    client: recentClient || 'Rashford',
    item: topItem ? topItem.split(/\s+/).slice(0, 2).join(' ') : 'travis low 10',
    club: club || 'Arsenal',
    number: dealNumber(latest) || 'SM-0007',
  };
}

function Start({ recent, onPick, onRemove, onClear, data }) {
  const ex = examplesFrom(data);
  const tips = [
    ['A client, club or agent', ex.client],
    ['An item, plus a size', ex.item],
    ['Everyone at a club', ex.club],
    ['A sale number', ex.number],
  ];
  return html`<div class="stack">
    ${recent.length > 0 && html`<${Card}
      pad=${false}
      title="Recent searches"
      actions=${html`<button type="button" class="link" onClick=${onClear}>Clear</button>`}
    >
      <ul class="sr-list">
        ${recent.map((q) => html`<li key=${q} class="sr-recent">
          <button type="button" class="sr-row" onClick=${() => onPick(q)}>
            <${Icon} name="search" size=${16} />
            <span class="sr-main"><span class="sr-title"><span class="sr-title-text">${q}</span></span></span>
          </button>
          <button type="button" class="sr-x" aria-label=${`Remove “${q}” from recent searches`} onClick=${() => onRemove(q)}>
            <${Icon} name="x" size=${16} />
          </button>
        </li>`)}
      </ul>
    <//>`}
    <${Card} title="Search everything" subtitle="Clients, every pair they bought, sizes, prices and profit.">
      <ul class="sr-tips">
        ${tips.map(([label, example]) => html`<li class="sr-tip" key=${label}>
          <span>${label}</span>
          <button type="button" class="chip" onClick=${() => onPick(example)}>${example}</button>
        </li>`)}
      </ul>
    <//>
  </div>`;
}

// ---------------------------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------------------------

export default function SearchView({ store, params = {} }) {
  const initial = typeof params.q === 'string' ? params.q : '';
  const [text, setText] = useState(initial);
  const [query, setQuery] = useState(initial);
  const [recent, setRecent] = useState(readRecent);
  const written = useRef(initial);
  const rootRef = useRef(null);

  const { data, error, loading, reload } = useStoreData(store, async (s) => {
    const [clients, deals] = await Promise.all([s.clients.list({ includeArchived: true }), s.deals.list()]);
    return { clients, deals };
  });

  // A new ?q= from outside (the shell's search button, Back/Forward) replaces what's typed.
  useEffect(() => {
    const q = typeof params.q === 'string' ? params.q : '';
    if (q !== written.current) {
      written.current = q;
      setText(q);
      setQuery(q);
    }
  }, [params.q]);

  // Debounce typing, then mirror the query into the address without a history entry.
  useEffect(() => {
    if (text === query) return undefined;
    const timer = setTimeout(() => setQuery(text), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text, query]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!/^#\/search(?:[?/]|$)/.test(window.location.hash)) return;
    const next = hashFor(query);
    written.current = query.trim();
    if (window.location.hash !== next) {
      try {
        window.history.replaceState(window.history.state, '', next);
      } catch {
        // Some embedded browsers refuse replaceState; the results still work.
      }
    }
  }, [query]);

  // Desktop: put the cursor in the box. Phones only get a keyboard when the search button
  // opened this page (the shell handles that through the autofocus attribute).
  useEffect(() => {
    if (isCoarsePointer()) return;
    const input = rootRef.current?.querySelector('input');
    if (input && document.activeElement !== input) input.focus({ preventScroll: true });
  }, []);

  const results = useMemo(() => (data ? search(query, data) : null), [query, data]);

  const remember = (q) => {
    const next = withRecent(readRecent(), q ?? query);
    setRecent(next);
    writeRecent(next);
  };
  const pick = (q) => {
    setText(q);
    setQuery(q);
    remember(q);
  };
  const removeRecent = (q) => {
    const next = recent.filter((item) => item !== q);
    setRecent(next);
    writeRecent(next);
  };
  const clearRecent = () => {
    setRecent([]);
    writeRecent([]);
  };

  // Opening a result counts as a search worth remembering.
  const onResultsClick = (event) => {
    if (event.target instanceof Element && event.target.closest('a[href]')) remember(query);
  };

  const trimmed = query.trim();
  const hasQuery = Boolean(results && (results.query || results.number !== null));
  const total = results ? results.clients.length + results.items.length + results.orders.length : 0;
  const numberFirst = results?.number !== null && results?.orders.some((o) => o.matchedBy === 'number');

  const jumps = results ? [
    results.clients.length > 0 && { id: 'sr-clients', label: plural(results.clients.length, 'client') },
    results.items.length > 0 && { id: 'sr-items', label: plural(results.items.length, 'item sale') },
    results.orders.length > 0 && { id: 'sr-orders', label: plural(results.orders.length, 'sale') },
  ].filter(Boolean) : [];

  const clientsBlock = results?.clients.length > 0 && html`<${ClientsSection} key=${`c:${trimmed}`} clients=${results.clients} />`;
  const itemsBlock = results?.items.length > 0 && html`<${ItemsSection} key=${`i:${trimmed}`} groups=${results.itemGroups} count=${results.items.length} />`;
  const ordersBlock = results?.orders.length > 0 && html`<${OrdersSection} orders=${results.orders} />`;

  return html`<${Page} title="Search">
    <div class="sr" ref=${rootRef}>
      <form class="sr-bar" action="#" onSubmit=${(event) => { event.preventDefault(); setQuery(text); remember(text); }}>
        <${SearchBox}
          value=${text}
          onInput=${setText}
          placeholder="Client, item, size or SM number"
          label="Search clients, items and sales"
          autofocus=${true}
        />
      </form>

      ${error && !data && html`<${ErrorState} error=${error} onRetry=${reload} />`}
      ${loading && !data && html`<${Loading} label="Loading your sales…" />`}

      ${data && !hasQuery && html`<${Start} recent=${recent} onPick=${pick} onRemove=${removeRecent} onClear=${clearRecent} data=${data} />`}

      ${data && hasQuery && total === 0 && html`<${Card}>
        <${Empty}
          icon="search"
          title=${`Nothing matches “${trimmed}”`}
          body="Try fewer words, part of a name, a club, a size or a sale number like SM-0007."
        />
      <//>`}

      ${data && hasQuery && total > 0 && html`<div class="sr" onClick=${onResultsClick}>
        ${jumps.length > 1 && html`<nav class="sr-jump chips" aria-label="Jump to results">
          ${jumps.map((jump) => html`<button type="button" class="chip" key=${jump.id} onClick=${() => document.getElementById(jump.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>${jump.label}</button>`)}
        </nav>`}
        ${numberFirst ? html`${ordersBlock}${clientsBlock}${itemsBlock}` : html`${clientsBlock}${itemsBlock}${ordersBlock}`}
      </div>`}
    </div>
  <//>`;
}

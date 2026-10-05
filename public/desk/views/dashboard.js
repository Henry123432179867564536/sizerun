// Dashboard (#/): what did I make, what am I still expecting to make, who owes me, what must
// I still buy — at a glance.
//
// Every figure comes from calc.js: summarise() for the period KPIs, the 12-month chart and
// the per-client ranking, dealTotals() per sale, itemTotals() per item to buy and
// stockLevels() for stock value. The period switch (remembered on this device) filters by
// sale date. "Owed to you" and "Stock on hand" are balances as of today, so they ignore it.

import { html, useMemo, useState } from '../lib/preact.js';
import {
  Badge,
  Banner,
  Button,
  Card,
  Empty,
  ErrorState,
  Icon,
  Loading,
  Money,
  Page,
  Segmented,
  Stat,
  paymentMeta,
  statusMeta,
  useStoreData,
} from '../lib/ui.js';
import { EPS, dealNumber, dealTotals, itemTotals, stockLevels, summarise } from '../lib/calc.js';
import { date, dateShort, duration, miles, money, moneyShort, monthLabel, plural, relDays, todayISO } from '../lib/format.js';
import { BarChart } from '../components/charts.js';
import { usePhone } from './clients.js';

const CSS = `
.dash-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
.dash-toolbar .segmented { width: 100%; }
.dash-range { color: var(--ink-3); font-size: 13px; }
.dash-grid { display: grid; gap: 16px; grid-template-columns: minmax(0, 1fr); }
.dash-col { display: contents; }
/* Phones: the two profit figures, then what needs doing, then the rest. */
.dash-key { order: 1; }
.dash-needs { order: 2; }
.dash-kpis2 { order: 3; }
.dash-chart { order: 4; }
.dash-recent { order: 5; }
.dash-top { order: 6; }
.dash-kpis .stat-sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dash-key { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.dash-key .stat-value { font-size: 26px; }
.dash-key .dash-total { grid-column: 1 / -1; }
.dash-key .dash-total .stat-value { font-size: 32px; }
.stat-muted .stat-value { color: var(--ink-2); }
.dash-key .dash-total .stat-sub { white-space: normal; }
.dash-kpis2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.dash-kpis2 .stat { padding: 10px 12px; }
.dash-kpis2 .stat-value { font-size: 18px; }
.dash-group + .dash-group { border-top: 1px solid var(--line); }
.dash-group-head { display: flex; align-items: center; gap: 8px; margin: 0; padding: 12px 16px 4px; color: var(--ink); font-size: 13px; font-weight: 600; }
.dash-group-head .icon { color: var(--ink-3); }
.dash-count { display: inline-grid; place-items: center; min-width: 20px; height: 20px; padding: 0 6px; border-radius: 999px; background: var(--surface-2); color: var(--ink-2); font-size: 11.5px; font-weight: 600; }
.dash-group-note { margin-left: auto; color: var(--ink-3); font-size: 12.5px; font-weight: 400; white-space: nowrap; }
.dash-group .list-item { min-height: 52px; }
.dash-more { display: inline-flex; align-items: center; gap: 2px; min-height: 36px; margin: 0 0 6px; padding: 0 16px; font-size: 13px; font-weight: 500; }
.dash-aside-sub { display: block; color: var(--ink-3); font-size: 12px; }
.dash-aside-badge { display: block; margin-top: 3px; }
.dash-rank { display: grid; flex: none; place-items: center; width: 26px; height: 26px; border: 1px solid var(--line); border-radius: 50%; background: var(--surface-2); color: var(--ink-2); font-size: 12px; font-weight: 600; }
.dash-clear { display: flex; align-items: center; gap: 10px; padding: 18px 16px; color: var(--ink-2); }
.dash-clear .icon { color: var(--gain); }
.dash-note { padding: 18px 16px; color: var(--ink-2); font-size: 13.5px; }
.dash-chart-totals { margin-bottom: 10px; color: var(--ink-2); font-size: 13px; }
.dash-chart-totals strong { color: var(--ink); font-weight: 600; }
.dash-chart-empty { display: flex; align-items: center; justify-content: center; min-height: 120px; border: 1px dashed var(--line-2); border-radius: var(--r-ctl); color: var(--ink-3); font-size: 13px; text-align: center; padding: 16px; }
@media (max-width: 639.98px) {
  .dash-range { display: none; }
}
@media (min-width: 640px) {
  .dash-toolbar .segmented { width: auto; }
  .dash-kpis2 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
}
@media (min-width: 1100px) {
  .dash-grid { grid-template-columns: minmax(0, 1.55fr) minmax(0, 1fr); align-items: start; gap: 20px; }
  .dash-col { display: flex; flex-direction: column; gap: 20px; min-width: 0; }
}
`;

// View styles live with the view and are added to <head> once, on first import.
const STYLE_ID = 'desk-dashboard-styles';
if (typeof document !== 'undefined' && !document.getElementById(STYLE_ID)) {
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.append(style);
}

const PERIOD_KEY = 'sizemill.desk.dashboardPeriod';
const PERIODS = [
  { value: 'month', label: 'This month', short: 'Month' },
  { value: '30d', label: 'Last 30 days', short: '30 days' },
  { value: 'year', label: 'This year', short: 'Year' },
  { value: 'all', label: 'All time', short: 'All time' },
];
const DEFAULT_PERIOD = 'month';

const NEEDS_LIMIT = 5; // rows per "Needs you" group before "See all"
const BIRTHDAY_WINDOW_DAYS = 14;
const CHART_MONTHS = 12;
const TOP_CLIENTS = 5;
const RECENT_SALES = 5;
const REALISED_STATUSES = new Set(['delivered', 'completed']);

const CHART_SERIES = [
  { key: 'realised', label: 'Realised', color: 'var(--gain)' },
  { key: 'pending', label: 'Pending', color: 'var(--ink-3)' },
];

const MS_PER_DAY = 86_400_000;
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})/;
const WEEKDAY_SHORT = new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'UTC' });
const WEEKDAY_LONG = new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: 'UTC' });

// ---- calendar helpers (ISO 'YYYY-MM-DD' strings, never shifted by time zone) --------------

function pad2(n) {
  return String(n).padStart(2, '0');
}

// Whole days since 1970-01-01 for the date part of an ISO string, or null.
function dayIndex(iso) {
  const match = typeof iso === 'string' ? ISO_DAY.exec(iso) : null;
  return match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / MS_PER_DAY : null;
}

function isoFromIndex(index) {
  return new Date(index * MS_PER_DAY).toISOString().slice(0, 10);
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate(); // day 0 of the next month
}

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function weekday(iso, format = WEEKDAY_SHORT) {
  const index = dayIndex(iso);
  return index === null ? '' : format.format(new Date(index * MS_PER_DAY));
}

// Sale-date range for a period, as calc.summarise takes it ({} = all time).
function periodRange(period, today) {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const monthKey = today.slice(0, 7);
  switch (period) {
    case 'month':
      return { from: `${monthKey}-01`, to: `${monthKey}-${pad2(daysInMonth(year, month))}` };
    case '30d':
      return { from: isoFromIndex(dayIndex(today) - 29), to: today };
    case 'year':
      return { from: `${year}-01-01`, to: `${year}-12-31` };
    default:
      return {};
  }
}

function rangeLabel(range) {
  if (!range.from) return 'Every sale you have logged';
  const sameYear = range.from.slice(0, 4) === range.to.slice(0, 4);
  return `${sameYear ? dateShort(range.from) : date(range.from)} – ${date(range.to)}`;
}

// Same rule as calc.summarise: with a range, a sale counts when its sale date is inside it.
function inRange(deal, range) {
  if (!range.from) return true;
  const day = typeof deal.sale_date === 'string' ? deal.sale_date.slice(0, 10) : '';
  return ISO_DAY.test(day) && day >= range.from && day <= range.to;
}

// The last `count` month keys ('2026-10'), oldest first, ending with this month.
function recentMonths(today, count) {
  let year = Number(today.slice(0, 4));
  let month = Number(today.slice(5, 7));
  const keys = [];
  for (let i = 0; i < count; i += 1) {
    keys.unshift(`${year}-${pad2(month)}`);
    month -= 1;
    if (month === 0) {
      month = 12;
      year -= 1;
    }
  }
  return keys;
}

// Next birthday on or after today: { iso, days, age } (age null when the year is unknown).
function upcomingBirthday(birthday, today) {
  const match = typeof birthday === 'string' ? ISO_DAY.exec(birthday) : null;
  if (!match) return null;
  const bornYear = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const thisYear = Number(today.slice(0, 4));
  const todayIndex = dayIndex(today);
  for (const year of [thisYear, thisYear + 1]) {
    // A 29 February birthday is marked on 28 February in other years.
    const shown = month === 2 && day === 29 && !isLeapYear(year) ? 28 : day;
    const iso = `${year}-${pad2(month)}-${pad2(shown)}`;
    const days = dayIndex(iso) - todayIndex;
    if (days >= 0) return { iso, days, age: bornYear >= 1900 && bornYear < year ? year - bornYear : null };
  }
  return null;
}

// Earliest first, missing dates last.
function compareDates(a, b) {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a < b ? -1 : 1;
}

// What to handle first: soonest due date, then the oldest sale.
function byUrgency(a, b) {
  return compareDates(a.due_date, b.due_date)
    || compareDates(a.sale_date, b.sale_date)
    || (Number(a.number) || 0) - (Number(b.number) || 0);
}

// ---- remembered period (a per-device convenience; storage may be blocked) ---------------

function readPeriod() {
  try {
    const saved = window.localStorage.getItem(PERIOD_KEY);
    return PERIODS.some((p) => p.value === saved) ? saved : DEFAULT_PERIOD;
  } catch {
    return DEFAULT_PERIOD;
  }
}

function writePeriod(value) {
  try {
    window.localStorage.setItem(PERIOD_KEY, value);
  } catch {
    // Not remembered; the dashboard opens on the default period next time.
  }
}

// ---- labels ------------------------------------------------------------------------------

function saleHref(deal) {
  return `#/sales/${encodeURIComponent(deal.id)}`;
}

function clientHref(client) {
  return `#/clients/${encodeURIComponent(client.id)}`;
}

function clientName(deal) {
  return deal.client?.name || deal.title || 'No client';
}

// 'Nike Dunk Low ×2, Stone Island jacket +1 more'.
function itemsSummary(items) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return 'No items yet';
  const names = list.slice(0, 2).map((item) => {
    const qty = Number(item.qty) || 0;
    return `${item.description || 'Item'}${qty > 1 ? ` ×${qty}` : ''}`;
  });
  const rest = list.length - names.length;
  return rest > 0 ? `${names.join(', ')} +${rest} more` : names.join(', ');
}

function dealSummary(deal) {
  return deal.client?.name && deal.title ? deal.title : itemsSummary(deal.items);
}

function itemLabel(item) {
  const qty = Number(item.qty) || 0;
  return `${item.description || 'Item'}${item.size ? ` · ${item.size}` : ''}${qty > 1 ? ` ×${qty}` : ''}`;
}

function joinParts(...parts) {
  return parts.filter(Boolean).join(' · ');
}

function wholePounds(n) {
  return money(n, { pence: false });
}

// ---- the dashboard model -----------------------------------------------------------------

function buildDashboard({ deals, stock, clients }, period, today) {
  const range = periodRange(period, today);
  const rows = deals.map((deal) => ({ deal, totals: dealTotals(deal) }));
  const live = rows.filter((row) => row.deal.status !== 'cancelled');
  const inPeriod = live.filter((row) => inRange(row.deal, range));
  const summary = summarise(deals, range);

  // Money still to come in, whatever the sale date. An enquiry owes nothing yet.
  const owing = live.filter((row) => row.deal.status !== 'enquiry' && row.totals.balance > EPS);
  const owed = summarise(owing.map((row) => row.deal)).owed;

  let stockValue = 0;
  let stockUnits = 0;
  for (const level of stockLevels(stock, deals).values()) {
    stockValue += level.value;
    stockUnits += Math.max(0, level.onHand);
  }

  const kpis = {
    realised: summary.realisedProfit,
    realisedCount: summary.realisedCount,
    pending: summary.pendingProfit,
    pendingCount: summary.pendingCount,
    pendingEstimated: inPeriod.some((row) => row.totals.bucket === 'pending' && row.totals.paymentStatus === 'paid' && row.totals.certainty === 'estimated'),
    unpaid: summary.unpaidProfit,
    unpaidCount: summary.unpaidCount,
    total: summary.totalProfit,
    toSource: summary.toSource,
    revenue: summary.revenue,
    count: summary.count,
    owed,
    owedCount: owing.length,
    stockValue,
    stockUnits,
    perDrivingHour: summary.perDrivingHour,
    drivingMinutes: summary.drivingMinutes,
    miles: summary.miles,
  };

  // Realised vs pending profit for the last 12 months, months without sales at zero.
  const byMonth = new Map(summarise(deals).byMonth.map((entry) => [entry.month, entry]));
  const chartRows = recentMonths(today, CHART_MONTHS).map((key) => {
    const entry = byMonth.get(key);
    return { label: monthLabel(key), values: [entry?.realised ?? 0, entry?.pending ?? 0] };
  });
  const chart = {
    data: chartRows,
    realised: chartRows.reduce((sum, row) => sum + row.values[0], 0),
    pending: chartRows.reduce((sum, row) => sum + row.values[1], 0),
    hasValues: chartRows.some((row) => Math.abs(row.values[0]) > EPS || Math.abs(row.values[1]) > EPS),
  };

  const toBuy = [];
  for (const { deal } of [...live].sort((a, b) => byUrgency(a.deal, b.deal))) {
    for (const item of deal.items ?? []) {
      if (item.cost_status !== 'actual') toBuy.push({ deal, item, cost: itemTotals(item).cost });
    }
  }
  const needs = {
    toBuy,
    toBuyCost: toBuy.reduce((sum, entry) => sum + entry.cost, 0),
    ready: live.filter((row) => row.deal.status === 'ready').sort((a, b) => byUrgency(a.deal, b.deal)),
    unpaid: live
      .filter((row) => REALISED_STATUSES.has(row.deal.status) && row.totals.balance > EPS)
      .sort((a, b) => compareDates(a.deal.sale_date, b.deal.sale_date)),
    birthdays: clients
      .filter((client) => !client.archived)
      .map((client) => ({ client, next: upcomingBirthday(client.birthday, today) }))
      .filter(({ next }) => next && next.days <= BIRTHDAY_WINDOW_DAYS)
      .sort((a, b) => a.next.days - b.next.days || String(a.client.name).localeCompare(String(b.client.name))),
  };

  // Clients ranked by profit on their sales in the period.
  const clientsById = new Map(clients.map((client) => [client.id, client]));
  const groups = new Map();
  for (const row of inPeriod) {
    const id = row.deal.client_id;
    if (!id) continue;
    let group = groups.get(id);
    if (!group) {
      group = { client: { id, ...clientsById.get(id), ...row.deal.client }, rows: [] };
      groups.set(id, group);
    }
    group.rows.push(row);
  }
  const topClients = [...groups.values()]
    .map(({ client, rows: clientRows }) => {
      const s = summarise(clientRows.map((row) => row.deal));
      return {
        client,
        profit: s.netProfit,
        revenue: s.revenue,
        count: s.count,
        estimated: clientRows.some((row) => row.totals.certainty === 'estimated'),
      };
    })
    .sort((a, b) => b.profit - a.profit || b.revenue - a.revenue)
    .slice(0, TOP_CLIENTS);

  return {
    empty: deals.length === 0,
    range,
    kpis,
    chart,
    needs,
    topClients,
    recent: rows.slice(0, RECENT_SALES), // the store lists newest first
  };
}

async function loadDashboard(store) {
  const [deals, stock, clients] = await Promise.all([store.deals.list(), store.stock.list(), store.clients.list()]);
  return { deals, stock, clients };
}

// ---- sections ----------------------------------------------------------------------------

function Kpis({ kpis }) {
  const pendingSub = kpis.pendingCount
    ? `${plural(kpis.pendingCount, 'paid sale')}${kpis.pendingEstimated ? ' · est.' : ''}`
    : 'No paid sales in progress';
  const totalSub = Math.abs(kpis.unpaid) > EPS
    ? `Realised + pending · ${wholePounds(kpis.unpaid)} more on ${plural(kpis.unpaidCount, 'unpaid order')}`
    : 'Realised + pending';

  return html`<div class="kpis dash-kpis dash-key">
    <${Stat}
      class="dash-total"
      label="Total profit"
      value=${wholePounds(kpis.total)}
      sub=${totalSub}
      tone=${kpis.total < -EPS ? 'loss' : undefined}
      href="#/sales"
    />
    <${Stat}
      label="Profit realised"
      value=${wholePounds(kpis.realised)}
      sub=${kpis.realisedCount ? `${plural(kpis.realisedCount, 'sale')} done` : 'None done yet'}
      tone=${kpis.realised < -EPS ? 'loss' : 'gain'}
      href="#/sales?tab=realised"
    />
    <${Stat}
      label="Profit pending"
      value=${wholePounds(kpis.pending)}
      sub=${pendingSub}
      tone=${kpis.pending < -EPS ? 'loss' : 'muted'}
      href="#/sales?tab=pending"
    />
  </div>`;
}

function MoreKpis({ kpis }) {
  const drivingSub = kpis.drivingMinutes > 0
    ? `${duration(kpis.drivingMinutes)} · ${miles(kpis.miles)}`
    : 'No drives yet';
  return html`<div class="kpis dash-kpis dash-kpis2">
    <${Stat} label="Revenue" value=${wholePounds(kpis.revenue)} sub=${plural(kpis.count, 'sale')} href="#/sales" />
    <${Stat}
      label="Owed to you"
      value=${wholePounds(kpis.owed)}
      sub=${kpis.owedCount ? `${plural(kpis.owedCount, 'sale')}, any date` : 'All paid up'}
      tone=${kpis.owed > EPS ? 'signal' : undefined}
      href="#/sales?tab=unpaid"
    />
    <${Stat}
      label="Stock on hand"
      value=${wholePounds(kpis.stockValue)}
      sub=${kpis.stockUnits ? `${plural(kpis.stockUnits, 'item')} in hand` : 'Nothing in stock'}
      href="#/stock"
    />
    <${Stat}
      label="£ per driving hour"
      value=${money(kpis.perDrivingHour)}
      sub=${drivingSub}
      tone=${kpis.perDrivingHour !== null && kpis.perDrivingHour < -EPS ? 'loss' : undefined}
      href="#/trips"
    />
  </div>`;
}

function ProfitChart({ chart }) {
  return html`<${Card}
    class="dash-chart"
    title="Profit by month"
    subtitle="Last 12 months, by sale date"
  >
    ${chart.hasValues
      ? html`<p class="dash-chart-totals">
            <strong class="num">${wholePounds(chart.realised)}</strong>${' realised and '}<strong class="num">${wholePounds(chart.pending)}</strong>${' still pending over the last 12 months.'}
          </p>
          <${BarChart}
            data=${chart.data}
            series=${CHART_SERIES}
            height=${200}
            format=${moneyShort}
            stacked
            title="Realised and pending profit by month, last 12 months"
          />`
      : html`<div class="dash-chart-empty">No profit recorded in the last 12 months yet.</div>`}
  <//>`;
}

function NeedsGroup({ icon, title, count, note, moreHref, limit = NEEDS_LIMIT, children }) {
  return html`<section class="dash-group">
    <h3 class="dash-group-head">
      <${Icon} name=${icon} size=${16} />
      <span>${title}</span>
      <span class="dash-count">${count}</span>
      ${note && html`<span class="dash-group-note">${note}</span>`}
    </h3>
    <div class="list">${children}</div>
    ${moreHref && count > limit && html`<a class="dash-more" href=${moreHref}>
      See all ${count}<${Icon} name="chevron-right" size=${16} />
    </a>`}
  </section>`;
}

function Aside({ value, tone, sub }) {
  return html`<div class="list-aside">
    <${Money} value=${value} tone=${tone} class="strong" />
    ${sub && html`<span class="dash-aside-sub">${sub}</span>`}
  </div>`;
}

function NeedsYou({ needs, limit = NEEDS_LIMIT }) {
  const { toBuy, ready, unpaid, birthdays } = needs;
  const total = toBuy.length + ready.length + unpaid.length + birthdays.length;

  return html`<${Card}
    class="dash-needs"
    pad=${false}
    title="Needs you"
    subtitle=${total ? `${plural(total, 'thing')} to sort` : 'Nothing waiting on you'}
  >
    ${total === 0 && html`<div class="dash-clear">
      <${Icon} name="check-circle" size=${20} />
      <span>All clear — nothing to buy, deliver or chase.</span>
    </div>`}

    ${toBuy.length > 0 && html`<${NeedsGroup}
      icon="tag"
      title="To buy"
      count=${toBuy.length}
      note=${`${wholePounds(needs.toBuyCost)} expected`}
      moreHref="#/sales?tab=tobuy"
      limit=${limit}
    >
      ${toBuy.slice(0, limit).map(({ deal, item, cost }) => html`<a key=${item.id} class="list-item" href=${saleHref(deal)}>
        <div class="list-main">
          <div class="list-title">${itemLabel(item)}</div>
          <div class="list-sub">${joinParts(clientName(deal), dealNumber(deal.number))}</div>
        </div>
        <${Aside} value=${cost} sub=${deal.due_date ? `due ${relDays(deal.due_date)}` : null} />
      </a>`)}
    <//>`}

    ${ready.length > 0 && html`<${NeedsGroup} icon="box" title="Ready to deliver" count=${ready.length}>
      ${ready.map(({ deal, totals }) => html`<a key=${deal.id} class="list-item" href=${saleHref(deal)}>
        <div class="list-main">
          <div class="list-title">${clientName(deal)}</div>
          <div class="list-sub">${joinParts(dealNumber(deal.number), dealSummary(deal))}</div>
        </div>
        <${Aside}
          value=${totals.revenue}
          sub=${deal.due_date ? `due ${relDays(deal.due_date)}` : paymentMeta[totals.paymentStatus]?.label}
        />
      </a>`)}
    <//>`}

    ${unpaid.length > 0 && html`<${NeedsGroup}
      icon="alert"
      title="Delivered, not paid"
      count=${unpaid.length}
      note=${`${wholePounds(unpaid.reduce((sum, row) => sum + row.totals.balance, 0))} to collect`}
      moreHref="#/sales?tab=unpaid"
      limit=${limit}
    >
      ${unpaid.slice(0, limit).map(({ deal, totals }) => html`<a key=${deal.id} class="list-item" href=${saleHref(deal)}>
        <div class="list-main">
          <div class="list-title">${clientName(deal)}</div>
          <div class="list-sub">${joinParts(dealNumber(deal.number), `sold ${relDays(deal.sale_date)}`)}</div>
        </div>
        <${Aside} value=${totals.balance} tone="warn" sub=${paymentMeta[totals.paymentStatus]?.label} />
      </a>`)}
    <//>`}

    ${birthdays.length > 0 && html`<${NeedsGroup} icon="calendar" title="Birthdays coming up" count=${birthdays.length}>
      ${birthdays.map(({ client, next }) => html`<a key=${client.id} class="list-item" href=${clientHref(client)}>
        <div class="list-main">
          <div class="list-title">${client.name}</div>
          <div class="list-sub">${joinParts(
            client.club,
            `${next.age ? `turns ${next.age}` : 'birthday'} on ${weekday(next.iso)} ${dateShort(next.iso)}`,
          )}</div>
        </div>
        <div class="list-aside">
          <${Badge} tone=${next.days === 0 ? 'gain' : 'neutral'} dot=${false}>${relDays(next.iso)}<//>
        </div>
      </a>`)}
    <//>`}
  <//>`;
}

function TopClients({ clients, periodLabel }) {
  return html`<${Card}
    class="dash-top"
    pad=${false}
    title="Top clients"
    subtitle=${`By profit · ${periodLabel}`}
    actions=${html`<${Button} kind="ghost" size="sm" href="#/clients">All clients<//>`}
  >
    ${clients.length === 0
      ? html`<p class="dash-note">No sales to a client in this period.</p>`
      : html`<div class="list">
          ${clients.map((entry, index) => html`<a key=${entry.client.id} class="list-item" href=${clientHref(entry.client)}>
            <span class="dash-rank" aria-hidden="true">${index + 1}</span>
            <div class="list-main">
              <div class="list-title">${entry.client.name || 'Client'}</div>
              <div class="list-sub">${joinParts(entry.client.club, plural(entry.count, 'sale'))}</div>
            </div>
            <div class="list-aside">
              <${Money} value=${entry.profit} tone="auto" class="strong" />${entry.estimated && html` <span class="pill pill-warn">est.</span>`}
              <span class="dash-aside-sub">${wholePounds(entry.revenue)} revenue</span>
            </div>
          </a>`)}
        </div>`}
  <//>`;
}

function RecentSales({ rows }) {
  return html`<${Card}
    class="dash-recent"
    pad=${false}
    title="Recent sales"
    actions=${html`<${Button} kind="ghost" size="sm" href="#/sales">All sales<//>`}
  >
    <div class="list">
      ${rows.map(({ deal, totals }) => {
        const cancelled = deal.status === 'cancelled';
        const status = statusMeta[deal.status] ?? { label: deal.status, tone: 'neutral' };
        return html`<a key=${deal.id} class="list-item" href=${saleHref(deal)}>
          <div class="list-main">
            <div class="list-title">${joinParts(dealNumber(deal.number), clientName(deal))}</div>
            <div class="list-sub">${joinParts(dealSummary(deal), dateShort(deal.sale_date))}</div>
          </div>
          <div class="list-aside">
            <${Money} value=${totals.netProfit} tone=${cancelled ? 'muted' : 'auto'} class="strong" />${!cancelled && totals.certainty === 'estimated' && html`<span class="tone-warn small"> est.</span>`}
            <span class=${`dash-aside-sub tone-${status.tone === 'neutral' ? 'muted' : status.tone}`}>${status.label}</span>
          </div>
        </a>`;
      })}
    </div>
  <//>`;
}

function Welcome({ needs }) {
  const actions = html`<${Button} kind="primary" icon="plus" href="#/sales/new">Add your first sale<//>
    <${Button} icon="calculator" href="#/check">Check a deal<//>`;
  return html`<${Card}>
      <${Empty}
        icon="trending-up"
        title="Your sales, profit and drives in one place"
        body="Log a sale — even before you've bought the item — and Desk works out your profit, what you still need to buy, who owes you and what each drive really cost."
        action=${actions}
      />
    <//>
    ${needs.birthdays.length > 0 && html`<${NeedsYou} needs=${needs} />`}`;
}

// ---- view --------------------------------------------------------------------------------

export default function DashboardView({ store }) {
  const [period, setPeriod] = useState(readPeriod);
  const phone = usePhone();
  const { data, error, loading, reload } = useStoreData(store, loadDashboard);
  const today = todayISO();
  const model = useMemo(() => (data ? buildDashboard(data, period, today) : null), [data, period, today]);
  const periodLabel = PERIODS.find((p) => p.value === period)?.label ?? '';
  const subtitle = `${weekday(today, WEEKDAY_LONG)} ${date(today)}`;

  const choosePeriod = (value) => {
    setPeriod(value);
    writePeriod(value);
  };

  if (!model) {
    return html`<${Page} title="Dashboard" subtitle=${subtitle}>
      ${loading || !error
        ? html`<${Loading} label="Loading your figures…" />`
        : html`<${Card}><${ErrorState} error=${error} title="Couldn't load your dashboard" onRetry=${reload} /><//>`}
    <//>`;
  }

  if (model.empty) {
    return html`<${Page} title="Dashboard" subtitle=${subtitle}>
      <${Welcome} needs=${model.needs} />
    <//>`;
  }

  const periodOptions = PERIODS.map((p) => ({
    value: p.value,
    label: html`<span class="hide-desktop">${p.short}</span><span class="hide-mobile">${p.label}</span>`,
  }));

  return html`<${Page}
    title="Dashboard"
    subtitle=${subtitle}
    actions=${html`<${Button} class="hide-mobile" icon="calculator" href="#/check">Check a deal<//>`}
  >
    ${error && html`<${Banner}
      tone="warn"
      title="Couldn't refresh"
      actions=${html`<${Button} size="sm" icon="refresh" onClick=${reload}>Try again<//>`}
    >${error.message} These are the figures from the last time it worked.<//>`}

    <div class="dash-toolbar">
      <${Segmented} options=${periodOptions} value=${period} onChange=${choosePeriod} label="Period" />
      <span class="dash-range">${rangeLabel(model.range)}</span>
    </div>

    <div class="dash-grid">
      <div class="dash-col">
        <${Kpis} kpis=${model.kpis} />
        <${MoreKpis} kpis=${model.kpis} />
        <${ProfitChart} chart=${model.chart} />
        <${RecentSales} rows=${model.recent} />
      </div>
      <div class="dash-col">
        <${NeedsYou} needs=${model.needs} limit=${phone ? 3 : NEEDS_LIMIT} />
        <${TopClients} clients=${model.topClients} periodLabel=${periodLabel} />
      </div>
    </div>
  <//>`;
}

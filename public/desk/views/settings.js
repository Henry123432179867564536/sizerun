// Settings (#/settings): your business (logo, name, brand colour), home address, car, time and
// margin defaults (desk_settings), a plain
// English "how profit is calculated" with a worked example that follows the form as you type,
// data exports (a JSON backup of everything and a CSV of sales with their totals) and the
// account.
//
// First run (no settings row yet: updated_at is null) opens with a prompt for the values every
// drive needs. All money maths in the example and the CSV comes from calc.js.

import { html, useEffect, useRef, useState } from '../lib/preact.js';
import {
  Badge,
  Banner,
  Button,
  Card,
  ErrorState,
  confirmDialog,
  Field,
  Input,
  Loading,
  Page,
  Select,
  Switch,
  certaintyMeta,
  statusMeta,
  toast,
  useStoreData,
} from '../lib/ui.js';
import { EPS, assessDeal, dealNumber, dealTotals, round2, tripTotals } from '../lib/calc.js';
import { date, duration, miles, money, pct, plural, ppl, todayISO } from '../lib/format.js';
import { DEFAULT_SETTINGS } from '../lib/store.js';
import { BrandLockup, DEFAULT_BRAND, PRESETS, brandFromSettings, inkFor, normalizeHex, paletteFor, prepareLogo } from '../lib/brand.js';
import AddressInput, { placeText } from '../components/address-input.js';
import { FUEL_TYPE_OPTIONS } from '../components/trip-planner.js';

const CSS = `
.settings-form { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.settings-bar { position: sticky; z-index: 5; bottom: calc(var(--tabbar-h) + var(--safe-b) + 10px); display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; padding: 8px 8px 8px 14px; border: 1px solid var(--line-2); border-radius: var(--r-panel); background: var(--glass-surface); box-shadow: var(--shadow-pop); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); }
.settings-bar-text { flex: 1 1 160px; min-width: 0; color: var(--ink-2); font-size: 13px; }
.settings-bar-text.is-dirty { color: var(--ink); font-weight: 500; }
.settings-bar-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-left: auto; }
.settings-explain { margin: 0; padding: 0; list-style: none; }
.settings-explain li { padding: 7px 0; border-bottom: 1px solid var(--line); color: var(--ink-2); }
.settings-explain li:last-child { border-bottom: 0; }
.settings-explain strong { color: var(--ink); font-weight: 600; }
.settings-example { margin-top: 16px; padding: 12px 14px; border: 1px solid var(--line); border-radius: var(--r-ctl); background: var(--surface-2); }
.settings-example-title { margin: 0 0 4px; font-size: 13px; font-weight: 600; }
.settings-example-sub { margin: 0 0 6px; color: var(--ink-2); font-size: 13px; }
.settings-example .kv dt small { display: block; color: var(--ink-3); font-size: 12px; }
.settings-data { display: grid; gap: 12px; grid-template-columns: minmax(0, 1fr); }
.settings-data-item { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; padding: 12px 14px; border: 1px solid var(--line); border-radius: var(--r-ctl); }
.settings-data-item p { color: var(--ink-2); font-size: 13px; }
.settings-account { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px 16px; }
.settings-account-who { display: flex; flex-direction: column; min-width: 0; }
.bz { display: flex; flex-direction: column; gap: 20px; min-width: 0; }
.bz-logo { display: flex; flex-wrap: wrap; align-items: center; gap: 14px 16px; min-width: 0; }
.bz-logo-frame { display: grid; flex: none; place-items: center; width: 88px; height: 88px; padding: 10px; overflow: hidden; border: 1px solid var(--line); border-radius: var(--r-panel); background-color: var(--surface-2); background-image: linear-gradient(45deg, var(--line) 25%, transparent 25%, transparent 75%, var(--line) 75%), linear-gradient(45deg, var(--line) 25%, transparent 25%, transparent 75%, var(--line) 75%); background-position: 0 0, 6px 6px; background-size: 12px 12px; }
.bz-logo-frame img { max-width: 100%; max-height: 100%; width: auto !important; height: auto !important; object-fit: contain; }
.bz-logo-body { display: flex; flex: 1 1 180px; flex-direction: column; gap: 8px; min-width: 0; }
.bz-logo-title { font-weight: 600; }
.bz-logo-body p { margin: 0; color: var(--ink-2); font-size: 13px; }
.bz-logo-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.bz-logo-error { margin: 0; color: var(--loss); font-size: 13px; }
.bz-colours { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.bz-swatch { position: relative; display: grid; flex: none; place-items: center; width: 40px; height: 40px; margin: 0; padding: 0; border: 0; border-radius: 50%; background: var(--sw); box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.14); color: #FFFFFF; cursor: pointer; -webkit-tap-highlight-color: transparent; }
.bz-swatch:focus-visible { outline: 2px solid var(--ink); outline-offset: 3px; }
.bz-swatch[aria-pressed="true"], .bz-swatch.is-on { box-shadow: 0 0 0 2px var(--surface), 0 0 0 4px var(--ink); }
.bz-swatch-custom { background: conic-gradient(from 90deg, #E5484D, #F2C200, #30A46C, #0F6E74, #2F45C5, #8E4EC6, #E5484D); }
.bz-swatch-custom.is-on { background: var(--sw); }
.bz-swatch-custom input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; padding: 0; border: 0; opacity: 0; cursor: pointer; }
.bz-swatch-custom:focus-within { outline: 2px solid var(--ink); outline-offset: 3px; }
.bz-hex { flex: 0 1 8.5rem; min-width: 7rem; }
.bz-hex .input { font-family: var(--mono); text-transform: uppercase; }
.bz-colour-field .field-hint + .field-hint { margin-top: 2px; }
.bz-preview { --brand: var(--pv-brand-l); --brand-ink: var(--pv-ink-l); --brand-tint: var(--pv-tint-l); --brand-text: var(--pv-text-l); --pv-on: var(--pv-on-l); display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 14px 16px; padding: 14px 16px; border: 1px solid var(--line); border-radius: var(--r-panel); background: var(--paper); }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .bz-preview { --brand: var(--pv-brand-d); --brand-ink: var(--pv-ink-d); --brand-tint: var(--pv-tint-d); --brand-text: var(--pv-text-d); --pv-on: var(--pv-on-d); }
}
:root[data-theme="dark"] .bz-preview { --brand: var(--pv-brand-d); --brand-ink: var(--pv-ink-d); --brand-tint: var(--pv-tint-d); --brand-text: var(--pv-text-d); --pv-on: var(--pv-on-d); }
.bz-preview-label { flex-basis: 100%; margin: 0 0 -4px; color: var(--ink-3); font-size: 12px; font-weight: 500; letter-spacing: 0.04em; text-transform: uppercase; }
.bz-preview-ui { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.bz-pv-btn { display: inline-flex; align-items: center; height: 32px; padding: 0 12px; border-radius: var(--r-ctl); background: var(--brand-text); color: var(--pv-on); font-size: 13px; font-weight: 500; }
.bz-pv-pill { display: inline-flex; align-items: center; height: 32px; padding: 0 12px; border-radius: var(--r-ctl); background: var(--brand-tint); color: var(--brand-text); font-size: 13px; font-weight: 500; }
@media (min-width: 640px) {
  .settings-data { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (min-width: 900px) {
  .settings-bar { bottom: 16px; }
}
`;

// View styles live with the view and are added to <head> once, on first import.
const STYLE_ID = 'desk-settings-styles';
if (typeof document !== 'undefined' && !document.getElementById(STYLE_ID)) {
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.append(style);
}

const WEAR_HINT = "Leave 0 unless you want wear and tear; HMRC's 45p is an all-in figure that already includes fuel";

// Limits a person could plausibly mean; the database allows more, but these catch typos.
const MAX_MPG = 1000;
const MAX_HOURLY_RATE = 10_000;
const MAX_WEAR_PER_MILE = 5;
const MAX_HANDOVER_MINUTES = 1440;
const MAX_NAME_LENGTH = 80;
const MAX_HOME_LABEL_LENGTH = 40;

// The worked example in the explainer (the spec's London → Southampton drop-off).
const EXAMPLE = Object.freeze({ salePrice: 450, buyPrice: 300, oneWayMiles: 80, oneWayMinutes: 110, fuelPpl: 140 });

const CSV_MIME = 'text/csv;charset=utf-8';
const JSON_MIME = 'application/json';
const UTF8_BOM = '﻿'; // lets Excel read £ and accented names correctly

// ---- form helpers ------------------------------------------------------------------------

// Form text → number: '' → null, '£1,200' → 1200, '25%' → 25, unreadable → NaN.
function parseNumber(text) {
  const cleaned = String(text ?? '').replace(/[£,%\s]/g, '');
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : Number.NaN;
}

function numberText(value) {
  const n = Number(value);
  return value === null || value === undefined || value === '' || !Number.isFinite(n) ? '' : String(n);
}

function isCoordinate(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
}

function hasCoords(place) {
  return Boolean(place) && isCoordinate(place.lat) && isCoordinate(place.lng);
}

function homeFromSettings(s) {
  const located = isCoordinate(s.home_lat) && isCoordinate(s.home_lng);
  const address = s.home_address || (located ? `${Number(s.home_lat).toFixed(5)}, ${Number(s.home_lng).toFixed(5)}` : null);
  if (!address) return null;
  return { label: null, address, lat: located ? Number(s.home_lat) : null, lng: located ? Number(s.home_lng) : null };
}

function formFromSettings(settings) {
  const s = { ...DEFAULT_SETTINGS, ...(settings ?? {}) };
  return {
    // The store's placeholder name ('Sizemill') reads as "not set yet".
    business_name: s.business_name && s.business_name !== DEFAULT_SETTINGS.business_name ? s.business_name : '',
    brand_color: normalizeHex(s.brand_color) ?? '',
    home: homeFromSettings(s),
    home_label: s.home_label ?? '',
    mpg: numberText(s.mpg),
    fuel_type: s.fuel_type || DEFAULT_SETTINGS.fuel_type,
    hourly_rate: numberText(s.hourly_rate),
    vehicle_cost_per_mile: numberText(s.vehicle_cost_per_mile),
    round_trip_default: s.round_trip_default !== false,
    handover_minutes_default: numberText(s.handover_minutes_default),
    // Stored as a fraction (0.25); people think in percent (25).
    target_margin: numberText(Math.round(Number(s.target_margin) * 10_000) / 100),
  };
}

// { field: message } for everything that would stop a save.
function validate(form) {
  const errors = {};

  if (form.business_name.trim().length > MAX_NAME_LENGTH) errors.business_name = `Keep it under ${MAX_NAME_LENGTH} characters.`;
  if (form.brand_color.trim() && !normalizeHex(form.brand_color)) errors.brand_color = 'Use a colour like #1F4B85.';
  if (form.home_label.trim().length > MAX_HOME_LABEL_LENGTH) errors.home_label = `Keep it under ${MAX_HOME_LABEL_LENGTH} characters.`;

  const mpg = parseNumber(form.mpg);
  if (mpg === null) errors.mpg = "Enter your car's mpg, e.g. 45.";
  else if (Number.isNaN(mpg)) errors.mpg = 'Use numbers only, e.g. 45 or 52.3.';
  else if (mpg <= 0) errors.mpg = 'Must be more than 0.';
  else if (mpg >= MAX_MPG) errors.mpg = 'That looks too high — most cars do 20–80 mpg.';

  if (!FUEL_TYPE_OPTIONS.some((option) => option.value === form.fuel_type)) errors.fuel_type = 'Pick a fuel type.';

  const rate = parseNumber(form.hourly_rate);
  if (rate === null) errors.hourly_rate = 'Enter what an hour of your time is worth (0 is fine).';
  else if (Number.isNaN(rate)) errors.hourly_rate = 'Use numbers only, e.g. 20 or 17.50.';
  else if (rate < 0) errors.hourly_rate = "Can't be negative.";
  else if (rate >= MAX_HOURLY_RATE) errors.hourly_rate = 'That rate is too high.';

  const wear = parseNumber(form.vehicle_cost_per_mile);
  if (Number.isNaN(wear)) errors.vehicle_cost_per_mile = 'Use numbers only, e.g. 0.12 for 12p a mile.';
  else if (wear !== null && wear < 0) errors.vehicle_cost_per_mile = "Can't be negative.";
  else if (wear !== null && wear > MAX_WEAR_PER_MILE) errors.vehicle_cost_per_mile = 'Enter pounds per mile — 12p is 0.12.';

  const handover = parseNumber(form.handover_minutes_default);
  if (Number.isNaN(handover)) errors.handover_minutes_default = 'Use whole minutes, e.g. 15.';
  else if (handover !== null && (handover < 0 || !Number.isInteger(handover))) errors.handover_minutes_default = 'Use whole minutes, 0 or more.';
  else if (handover !== null && handover > MAX_HANDOVER_MINUTES) errors.handover_minutes_default = 'Keep it under a day (1,440 minutes).';

  const margin = parseNumber(form.target_margin);
  if (Number.isNaN(margin)) errors.target_margin = 'Use a whole percentage, e.g. 25.';
  else if (margin !== null && (margin < 0 || margin >= 100)) errors.target_margin = 'Pick a target from 0% up to 99%.';
  else if (margin !== null && !Number.isInteger(margin)) errors.target_margin = 'Use a whole percentage, e.g. 25.';

  return errors;
}

// The desk_settings patch for a valid form. Blank optional numbers save as 0.
function patchFromForm(form) {
  const address = form.home ? placeText(form.home) : '';
  const located = Boolean(address) && hasCoords(form.home);
  return {
    business_name: form.business_name.trim() || null,
    // Desk's own navy is the default, stored as "no brand colour".
    brand_color: brandColor(form.brand_color),
    home_label: address ? form.home_label.trim() || null : null,
    home_address: address || null,
    home_lat: located ? Number(form.home.lat) : null,
    home_lng: located ? Number(form.home.lng) : null,
    mpg: parseNumber(form.mpg),
    fuel_type: form.fuel_type,
    hourly_rate: parseNumber(form.hourly_rate),
    vehicle_cost_per_mile: parseNumber(form.vehicle_cost_per_mile) ?? 0,
    round_trip_default: form.round_trip_default,
    handover_minutes_default: parseNumber(form.handover_minutes_default) ?? 0,
    target_margin: (parseNumber(form.target_margin) ?? 0) / 100,
  };
}

function brandColor(text) {
  const hex = normalizeHex(text);
  return hex && hex !== DEFAULT_BRAND ? hex : null;
}

function sameForm(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// A form value for the live example: the typed number when it is usable, else the default.
function usable(text, fallback, isValid) {
  const n = parseNumber(text);
  return n !== null && !Number.isNaN(n) && isValid(n) ? n : fallback;
}

// ---- downloads ---------------------------------------------------------------------------

function downloadFile(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  // Some browsers start the download after click() returns; give them time to read the blob.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function fileSlug(businessName) {
  const slug = String(businessName ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'sizemill';
}

// One RFC 4180 field. Text that a spreadsheet would run as a formula (=, +, -, @ first) gets a
// leading apostrophe, so a client name can never become a live formula.
function csvField(value, { text = false } = {}) {
  let s = value === null || value === undefined ? '' : String(value);
  if (text && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function amountCell(n) {
  return round2(n).toFixed(2);
}

function itemsCell(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => {
      const qty = Number(item.qty) || 0;
      return `${item.description || 'Item'}${item.size ? ` (${item.size})` : ''}${qty > 1 ? ` x${qty}` : ''}`;
    })
    .join('; ');
}

const CSV_COLUMNS = [
  { header: 'Number', value: (deal) => dealNumber(deal.number) },
  { header: 'Sale date', value: (deal) => deal.sale_date ?? '' },
  { header: 'Client', value: (deal) => deal.client?.name ?? '', text: true },
  { header: 'Club', value: (deal) => deal.client?.club ?? '', text: true },
  { header: 'Items', value: (deal) => itemsCell(deal.items), text: true },
  { header: 'Status', value: (deal) => statusMeta[deal.status]?.label ?? deal.status ?? '' },
  { header: 'Revenue', value: (_, t) => amountCell(t.revenue) },
  { header: 'Goods cost', value: (_, t) => amountCell(t.goodsCost) },
  { header: 'Extra costs', value: (_, t) => amountCell(t.extraCosts) },
  { header: 'Travel cost', value: (_, t) => amountCell(t.travelCost) },
  { header: 'Profit', value: (_, t) => amountCell(t.netProfit) },
  { header: 'After your time', value: (_, t) => amountCell(t.trueProfit) },
  { header: 'Margin %', value: (_, t) => (t.margin === null ? '' : (Math.round(t.margin * 1000) / 10).toFixed(1)) },
  { header: 'Certainty', value: (_, t) => certaintyMeta[t.certainty]?.label ?? t.certainty },
  { header: 'Paid', value: (_, t) => amountCell(t.paid) },
  { header: 'Balance', value: (_, t) => amountCell(t.balance) },
];

// Sales oldest first (the store lists newest first), one row per sale, CRLF line endings.
function salesCsv(deals) {
  const lines = [CSV_COLUMNS.map((column) => csvField(column.header)).join(',')];
  for (const deal of [...deals].reverse()) {
    const totals = dealTotals(deal);
    lines.push(CSV_COLUMNS.map((column) => csvField(column.value(deal, totals), column)).join(','));
  }
  return `${UTF8_BOM}${lines.join('\r\n')}\r\n`;
}

async function exportEverything(store, user) {
  const [settings, clients, stock, deals, trips] = await Promise.all([
    store.settings.get(),
    store.clients.list({ includeArchived: true }),
    store.stock.list({ includeArchived: true }),
    store.deals.list(),
    store.trips.list(),
  ]);
  const backup = {
    format: 'sizemill-desk-export',
    version: 1,
    exported_at: new Date().toISOString(),
    account: user?.email ?? null,
    settings,
    clients,
    stock,
    deals,
    trips,
  };
  downloadFile(`${fileSlug(settings.business_name)}-desk-backup-${todayISO()}.json`, JSON.stringify(backup, null, 2), JSON_MIME);
  return { clients: clients.length, deals: deals.length, stock: stock.length, trips: trips.length };
}

async function exportSales(store) {
  const [settings, deals] = await Promise.all([store.settings.get(), store.deals.list()]);
  if (deals.length > 0) downloadFile(`${fileSlug(settings.business_name)}-sales-${todayISO()}.csv`, salesCsv(deals), CSV_MIME);
  return deals.length;
}

function leaveLocalMode() {
  const url = new URL(window.location.href);
  url.searchParams.delete('local');
  window.location.assign(`${url.pathname}${url.search}${url.hash}`);
}

// ---- sections ----------------------------------------------------------------------------

function homeHint(home) {
  if (!home) return 'Drives start here unless you pick somewhere else.';
  if (hasCoords(home)) return 'Pinned on the map. Drives start here unless you pick somewhere else.';
  return 'Not pinned on the map yet — pick a suggestion so routes start from the right place. A typed address is looked up when you calculate a route.';
}

function toneOf(n) {
  if (n >= EPS) return 'tone-gain';
  return n <= -EPS ? 'tone-loss' : undefined;
}

function ProfitExplainer({ form }) {
  const mpg = usable(form.mpg, DEFAULT_SETTINGS.mpg, (n) => n > 0 && n < MAX_MPG);
  const rate = usable(form.hourly_rate, DEFAULT_SETTINGS.hourly_rate, (n) => n >= 0 && n < MAX_HOURLY_RATE);
  const wear = usable(form.vehicle_cost_per_mile, DEFAULT_SETTINGS.vehicle_cost_per_mile, (n) => n >= 0 && n <= MAX_WEAR_PER_MILE);
  const handover = usable(form.handover_minutes_default, DEFAULT_SETTINGS.handover_minutes_default, (n) => n >= 0 && n <= MAX_HANDOVER_MINUTES);
  const margin = usable(form.target_margin, DEFAULT_SETTINGS.target_margin * 100, (n) => n >= 0 && n < 100) / 100;

  const trip = {
    one_way_miles: EXAMPLE.oneWayMiles,
    one_way_minutes: EXAMPLE.oneWayMinutes,
    round_trip: form.round_trip_default,
    extra_minutes: handover,
    mpg,
    fuel_ppl: EXAMPLE.fuelPpl,
    hourly_rate: rate,
    vehicle_cost_per_mile: wear,
    other_costs: 0,
  };
  const drive = tripTotals(trip);
  const deal = assessDeal({ salePrice: EXAMPLE.salePrice, buyPrice: EXAMPLE.buyPrice, trip, hourlyRate: rate, targetMargin: margin });
  const legs = form.round_trip_default ? 'there and back' : 'one way';

  return html`<${Card} title="How profit is calculated" subtitle="The same sums run on every sale, drive and deal check.">
    <ul class="settings-explain">
      <li><strong>Revenue</strong> is what the client pays: the price of each item times how many.</li>
      <li><strong>Goods</strong> is what you paid for the items. If you haven't bought one yet, Desk uses the expected cost you entered and marks the profit <em>estimated</em> until you mark it bought.</li>
      <li><strong>Extras</strong> are postage, fees, packaging and any other costs on the sale.</li>
      <li><strong>Travel</strong> is the cash a drive costs: fuel (miles ÷ mpg × 4.546 litres per gallon × the price per litre), plus wear per mile, parking and tolls.</li>
      <li><strong>Profit</strong> = revenue − goods − extras − travel.</li>
      <li><strong>After your time</strong> = profit − your hourly rate × the time the drive took, handover included.</li>
      <li><strong>£ per driving hour</strong> = profit ÷ the hours you spent behind the wheel.</li>
      <li><strong>Margin</strong> = profit ÷ revenue. The deal checker calls a deal tight when it's under your target.</li>
      <li><strong>Realised or pending:</strong> a sale's profit is realised once it's delivered, paid in full and every cost is known. Until then it's pending. Cancelled sales are left out of every total.</li>
    </ul>

    <div class="settings-example">
      <p class="settings-example-title">Worked example with your settings</p>
      <p class="settings-example-sub">${
        `Sell for ${money(EXAMPLE.salePrice)}, bought for ${money(EXAMPLE.buyPrice)}, a drop-off ${miles(EXAMPLE.oneWayMiles)} `
        + `(${duration(EXAMPLE.oneWayMinutes)}) away driven ${legs}, fuel at ${ppl(EXAMPLE.fuelPpl)}.`
      }</p>
      <dl class="kv">
        <div><dt>Sale price</dt><dd>${money(deal.revenue)}</dd></div>
        <div><dt>Goods</dt><dd>${money(-deal.goodsCost)}</dd></div>
        <div><dt>Fuel<small>${miles(drive.miles)} at ${mpg} mpg</small></dt><dd>${money(-drive.fuelCost)}</dd></div>
        ${drive.wearCost > 0 && html`<div><dt>Wear<small>${miles(drive.miles)} at ${money(wear)} a mile</small></dt><dd>${money(-drive.wearCost)}</dd></div>`}
        <div class="kv-total"><dt>Profit<small>${pct(deal.margin)} margin</small></dt><dd class=${toneOf(deal.netProfit)}>${money(deal.netProfit)}</dd></div>
        <div><dt>Your time<small>${duration(drive.totalMinutes)} at ${money(rate)}/h</small></dt><dd>${money(-deal.timeCost)}</dd></div>
        <div class="kv-total"><dt>After your time</dt><dd class=${toneOf(deal.trueProfit)}>${money(deal.trueProfit)}</dd></div>
        <div><dt>Per driving hour<small>${duration(drive.drivingMinutes)} behind the wheel</small></dt><dd>${money(deal.perDrivingHour)}</dd></div>
      </dl>
    </div>
  <//>`;
}

function DataCard({ store, user }) {
  const [busy, setBusy] = useState(null); // null | 'json' | 'csv'
  const mountedRef = useRef(true);
  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  async function run(kind, task) {
    if (busy) return;
    setBusy(kind);
    try {
      await task();
    } catch (err) {
      toast(err instanceof Error && err.message ? err.message : "Couldn't export your data — please try again.", { tone: 'loss' });
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }

  const backup = () => run('json', async () => {
    const counts = await exportEverything(store, user);
    toast(`Backup downloaded — ${plural(counts.deals, 'sale')}, ${plural(counts.clients, 'client')}, ${plural(counts.trips, 'trip')}.`, { tone: 'gain' });
  });

  const sales = () => run('csv', async () => {
    const count = await exportSales(store);
    if (count === 0) toast('No sales to export yet.', { tone: 'warn' });
    else toast(`Sales spreadsheet downloaded — ${plural(count, 'sale')}.`, { tone: 'gain' });
  });

  return html`<${Card} title="Your data" subtitle="Download a copy any time — files are made in your browser.">
    <div class="settings-data">
      <div class="settings-data-item">
        <strong>Everything (JSON)</strong>
        <p>A full backup: settings, clients, stock, sales with their items, costs and payments, and trips.</p>
        <${Button} icon="download" loading=${busy === 'json'} disabled=${Boolean(busy)} onClick=${backup}>Export JSON<//>
      </div>
      <div class="settings-data-item">
        <strong>Sales (CSV)</strong>
        <p>One row per sale with revenue, costs, profit, margin and what's still owed. Opens in Excel, Numbers or Google Sheets.</p>
        <${Button} icon="download" loading=${busy === 'csv'} disabled=${Boolean(busy)} onClick=${sales}>Export CSV<//>
      </div>
    </div>
  <//>`;
}

function AccountCard({ store, user }) {
  const [signingOut, setSigningOut] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  if (store.mode === 'memory') {
    return html`<${Card} title="Account">
      <div class="settings-account">
        <div class="settings-account-who">
          <span><${Badge} tone="warn">Local mode<//></span>
          <span class="muted small">Everything is saved in this browser only. Export a backup before clearing browser data.</span>
        </div>
        <${Button} icon="user" onClick=${leaveLocalMode}>Use my account<//>
      </div>
    <//>`;
  }

  async function signOut() {
    setSigningOut(true);
    try {
      await store.auth.signOut(); // the app swaps to the sign-in screen via auth.onChange
      toast('Signed out.');
    } catch (err) {
      toast(err instanceof Error && err.message ? err.message : "Couldn't sign out — please try again.", { tone: 'loss' });
    } finally {
      if (mountedRef.current) setSigningOut(false);
    }
  }

  return html`<${Card} title="Account">
    <div class="settings-account">
      <div class="settings-account-who">
        <span class="muted small">Signed in as</span>
        <strong class="wrap-anywhere">${user?.email ?? 'your account'}</strong>
        <span class="muted small">The same account works in the main Sizemill app.</span>
      </div>
      <${Button} icon="log-out" loading=${signingOut} onClick=${signOut}>Sign out<//>
    </div>
  <//>`;
}

function previewVars(color) {
  const p = paletteFor(color);
  const vars = [];
  for (const scheme of ['light', 'dark']) {
    const k = scheme === 'light' ? 'l' : 'd';
    vars.push(`--pv-brand-${k}:${p[scheme].brand}`, `--pv-ink-${k}:${p[scheme].ink}`, `--pv-tint-${k}:${p[scheme].tint}`, `--pv-text-${k}:${p[scheme].text}`);
  }
  // Text on a button filled with the text shade, as the app's primary buttons are.
  vars.push(`--pv-on-l:${inkFor(p.light.text)}`, `--pv-on-d:${inkFor(p.dark.text, '#111418')}`);
  return vars.join(';');
}

// "Your business": logo (uploaded straight away), name and brand colour (saved with the form).
function BusinessCard({ store, settings, form, set, errorFor, touch }) {
  const [busy, setBusy] = useState(null); // null | 'upload' | 'remove'
  const [logoError, setLogoError] = useState(null);
  const fileRef = useRef(null);
  const mountedRef = useRef(true);
  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  const hex = normalizeHex(form.brand_color);
  const chosen = hex ?? (form.brand_color.trim() ? null : DEFAULT_BRAND);
  const isPreset = PRESETS.some((preset) => preset.hex === chosen);
  const brand = brandFromSettings({ business_name: form.business_name, logo_url: settings.logo_url, brand_color: hex });
  const palette = paletteFor(hex);
  const hasLogo = Boolean(brand.logo);

  async function onFile(event) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = ''; // picking the same file again still fires change
    if (!file || busy) return;
    if (store.mode !== 'memory' && navigator.onLine === false) {
      setLogoError("You're offline — connect to upload your logo.");
      return;
    }
    setBusy('upload');
    setLogoError(null);
    try {
      const logo = await prepareLogo(file);
      await store.settings.uploadLogo(logo.blob, { width: logo.width, height: logo.height });
      toast(hasLogo ? 'Logo replaced.' : 'Logo added.', { tone: 'gain' });
    } catch (err) {
      if (mountedRef.current) setLogoError(err instanceof Error && err.message ? err.message : "Couldn't upload your logo — try again.");
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }

  async function remove() {
    const ok = await confirmDialog({
      title: 'Remove your logo?',
      body: 'Desk will show your initials instead. You can upload a logo again any time.',
      confirmLabel: 'Remove logo',
      danger: true,
    });
    if (!ok) return;
    setBusy('remove');
    setLogoError(null);
    try {
      await store.settings.removeLogo();
      toast('Logo removed.');
    } catch (err) {
      if (mountedRef.current) setLogoError(err instanceof Error && err.message ? err.message : "Couldn't remove your logo — try again.");
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }

  const colourHint = palette.adjusted
    ? 'Text and links use a deeper shade of it so they stay readable.'
    : 'Used for buttons, links and your initials. Gains, losses and warnings keep their own colours.';

  return html`<${Card} title="Your business" subtitle="Your logo, name and colour appear across Desk and on the sign-in screen.">
    <div class="bz">
      <div class="bz-logo">
        <div class="bz-logo-frame">
          ${hasLogo
            ? html`<img src=${brand.logo.src} alt=${brand.name ? `${brand.name} logo` : 'Your logo'} />`
            : html`<${BrandLockup} brand=${{ ...brand, logo: null }} size=${48} sub="" class="bz-logo-mono" />`}
        </div>
        <div class="bz-logo-body">
          <span class="bz-logo-title">Logo</span>
          <p>${hasLogo ? 'Shown in the sidebar, the top bar and on the sign-in screen.' : 'PNG, JPG or WebP — a photo from your camera roll works too. Desk resizes it for you.'}</p>
          <input
            ref=${fileRef}
            class="sr-only"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            tabindex="-1"
            aria-hidden="true"
            onChange=${onFile}
          />
          <div class="bz-logo-actions">
            <${Button}
              size="sm"
              icon=${hasLogo ? 'refresh' : 'plus'}
              loading=${busy === 'upload'}
              disabled=${busy === 'remove'}
              onClick=${() => fileRef.current?.click()}
            >${busy === 'upload' ? 'Uploading…' : hasLogo ? 'Replace' : 'Upload logo'}<//>
            ${hasLogo && html`<${Button} size="sm" kind="ghost" icon="trash" loading=${busy === 'remove'} disabled=${busy === 'upload'} onClick=${remove}>Remove<//>`}
          </div>
          ${logoError && html`<p class="bz-logo-error" role="alert">${logoError}</p>`}
        </div>
      </div>

      <div class="form-grid">
        <${Field} class="span-all" label="Business name" hint="Shown next to your logo and used to name your exports." error=${errorFor('business_name')}>
          <${Input}
            type="text"
            autocomplete="organization"
            autocapitalize="words"
            placeholder="Your business name"
            maxlength=${MAX_NAME_LENGTH + 20}
            value=${form.business_name}
            onInput=${(event) => set('business_name', event.currentTarget.value)}
            onBlur=${touch('business_name')}
          />
        <//>
      </div>

      <${Field} class="bz-colour-field" label="Brand colour" hint=${colourHint} error=${errorFor('brand_color')}>
        <div class="bz-colours" role="group" aria-label="Brand colour">
          ${PRESETS.map((preset) => html`<button
            key=${preset.hex}
            type="button"
            class="bz-swatch"
            style=${`--sw:${preset.hex}`}
            aria-pressed=${chosen === preset.hex ? 'true' : 'false'}
            aria-label=${`${preset.name}${preset.hex === DEFAULT_BRAND ? ' (Desk default)' : ''}`}
            title=${preset.name}
            onClick=${() => set('brand_color', preset.hex === DEFAULT_BRAND ? '' : preset.hex)}
          ></button>`)}
          <label class=${`bz-swatch bz-swatch-custom${hex && !isPreset ? ' is-on' : ''}`} style=${hex && !isPreset ? `--sw:${hex}` : undefined} title="Custom colour">
            <span class="sr-only">Custom colour</span>
            <input
              type="color"
              value=${(hex ?? DEFAULT_BRAND).toLowerCase()}
              onInput=${(event) => set('brand_color', event.currentTarget.value.toUpperCase())}
            />
          </label>
          <div class="bz-hex">
            <${Input}
              type="text"
              placeholder=${DEFAULT_BRAND}
              autocomplete="off"
              autocapitalize="characters"
              autocorrect="off"
              spellcheck=${false}
              maxlength="7"
              value=${form.brand_color}
              onInput=${(event) => set('brand_color', event.currentTarget.value)}
              onBlur=${(event) => {
                const clean = normalizeHex(event.currentTarget.value);
                if (clean) set('brand_color', clean === DEFAULT_BRAND ? '' : clean);
                touch('brand_color')();
              }}
            />
          </div>
        </div>
      <//>

      <div class="bz-preview" style=${previewVars(hex)} aria-hidden="true">
        <p class="bz-preview-label">Preview</p>
        <${BrandLockup} brand=${brand} />
        <div class="bz-preview-ui">
          <span class="bz-pv-btn">New sale</span>
          <span class="bz-pv-pill">Dashboard</span>
        </div>
      </div>
    </div>
  <//>`;
}

// ---- view --------------------------------------------------------------------------------

export default function SettingsView({ store, user }) {
  const { data: settings, error, loading, reload } = useStoreData(store, (s) => s.settings.get());
  const [form, setForm] = useState(null);
  const [baseline, setBaseline] = useState(null);
  const [touched, setTouched] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const formRef = useRef(null);
  const mountedRef = useRef(true);
  const dirty = Boolean(form && baseline) && !sameForm(form, baseline);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const account = user ?? store.auth.user();

  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  // Fresh settings (first load, or a save elsewhere) replace the form unless you're mid-edit.
  useEffect(() => {
    if (!settings || dirtyRef.current) return;
    const next = formFromSettings(settings);
    setForm(next);
    setBaseline(next);
  }, [settings]);

  if (!form) {
    return html`<${Page} title="Settings">
      ${loading || !error
        ? html`<${Loading} label="Loading your settings…" />`
        : html`<${Card}><${ErrorState} error=${error} title="Couldn't load your settings" onRetry=${reload} /><//>`}
    <//>`;
  }

  const firstRun = !settings?.updated_at;
  const errors = validate(form);
  const errorFor = (name) => ((submitted || touched[name]) && errors[name]) || undefined;
  const set = (name, value) => setForm((current) => ({ ...current, [name]: value }));
  const touch = (name) => () => setTouched((current) => (current[name] ? current : { ...current, [name]: true }));
  const textProps = (name) => ({
    value: form[name],
    onInput: (event) => set(name, event.currentTarget.value),
    onBlur: touch(name),
  });

  function discard() {
    setForm(baseline);
    setTouched({});
    setSubmitted(false);
  }

  async function onSubmit(event) {
    event.preventDefault();
    if (saving) return;
    setSubmitted(true);
    if (Object.keys(errors).length > 0) {
      toast('Check the highlighted fields.', { tone: 'warn' });
      requestAnimationFrame(() => {
        const field = formRef.current?.querySelector('.has-error');
        field?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        field?.querySelector('input, select')?.focus({ preventScroll: true });
      });
      return;
    }
    setSaving(true);
    try {
      const saved = await store.settings.save(patchFromForm(form));
      if (!mountedRef.current) return;
      const next = formFromSettings(saved);
      setForm(next);
      setBaseline(next);
      setTouched({});
      setSubmitted(false);
      toast('Settings saved.', { tone: 'gain' });
    } catch (err) {
      toast(err instanceof Error && err.message ? err.message : "Couldn't save your settings — please try again.", { tone: 'loss' });
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }

  const status = dirty
    ? 'You have unsaved changes.'
    : firstRun
      ? 'Not saved yet — check the defaults and save.'
      : `All changes saved${settings.updated_at ? ` · ${date(settings.updated_at)}` : ''}.`;

  return html`<${Page} title="Settings" subtitle="Your business, home, car and rates — used across Desk to cost every drive and judge every deal.">
    ${firstRun && html`<${Banner} tone="signal" icon="map-pin" title="Welcome to Desk — start here">
      Add your home address, your car's mpg and fuel type, and what your time is worth. Desk uses
      them to work out the miles, fuel and time behind every drop-off. You can change them any time.
    <//>`}

    <form class="settings-form" ref=${formRef} onSubmit=${onSubmit} noValidate=${true}>
      <${BusinessCard} store=${store} settings=${settings} form=${form} set=${set} errorFor=${errorFor} touch=${touch} />

      <${Card} title="Drives" subtitle="Where drives start and the car you drive.">
        <div class="form-grid">
          <${Field} class="span-all" label="Home address" hint=${homeHint(form.home)}>
            <${AddressInput}
              store=${store}
              value=${form.home}
              onChange=${(place) => set('home', place)}
              placeholder="Postcode or address"
            />
          <//>
          <${Field} label="Name for home" hint="Shown as the start of a drive." error=${errorFor('home_label')}>
            <${Input} type="text" placeholder="Home" autocomplete="off" ...${textProps('home_label')} />
          <//>
          <${Field} label="Handover time" hint="Minutes at each drop-off, added to every drive's time." error=${errorFor('handover_minutes_default')}>
            <${Input} type="text" inputmode="numeric" suffix="min" autocomplete="off" ...${textProps('handover_minutes_default')} />
          <//>
          <${Field} label="Fuel economy" required hint="UK mpg (imperial gallons)." error=${errorFor('mpg')}>
            <${Input} type="text" inputmode="decimal" suffix="mpg" autocomplete="off" ...${textProps('mpg')} />
          <//>
          <${Field} label="Fuel type" required hint="Live prices are looked up for this fuel." error=${errorFor('fuel_type')}>
            <${Select}
              options=${FUEL_TYPE_OPTIONS}
              value=${form.fuel_type}
              onChange=${(event) => set('fuel_type', event.currentTarget.value)}
              onBlur=${touch('fuel_type')}
            />
          <//>
          <${Field} label="Vehicle cost per mile" hint=${WEAR_HINT} error=${errorFor('vehicle_cost_per_mile')}>
            <${Input} type="text" inputmode="decimal" prefix="£" suffix="/mile" autocomplete="off" placeholder="0" ...${textProps('vehicle_cost_per_mile')} />
          <//>
          <div class="span-all">
            <${Switch}
              checked=${form.round_trip_default}
              onChange=${(checked) => set('round_trip_default', checked)}
              label="Drives are round trips"
              hint="New drives count the way back too. You can change it on any drive."
            />
          </div>
        </div>
      <//>

      <${Card} title="Your time and margin" subtitle="Used for “after your time” and by the deal checker.">
        <div class="form-grid">
          <${Field} label="Your hourly rate" required hint="What an hour of your time is worth." error=${errorFor('hourly_rate')}>
            <${Input} type="text" inputmode="decimal" prefix="£" suffix="/h" autocomplete="off" ...${textProps('hourly_rate')} />
          <//>
          <${Field} label="Target margin" hint="Profit as a share of the sale price. Deals under it are flagged as tight." error=${errorFor('target_margin')}>
            <${Input} type="text" inputmode="numeric" suffix="%" autocomplete="off" placeholder="0" ...${textProps('target_margin')} />
          <//>
        </div>
      <//>

      <div class="settings-bar" role="region" aria-label="Save settings">
        <span class=${dirty ? 'settings-bar-text is-dirty' : 'settings-bar-text'} role="status">${status}</span>
        <div class="settings-bar-actions">
          ${dirty && html`<${Button} kind="ghost" disabled=${saving} onClick=${discard}>Discard<//>`}
          <${Button} kind="primary" type="submit" loading=${saving} disabled=${!dirty && !firstRun}>
            ${saving ? 'Saving…' : 'Save settings'}
          <//>
        </div>
      </div>
    </form>

    <${ProfitExplainer} form=${form} />
    <${DataCard} store=${store} user=${account} />
    <${AccountCard} store=${store} user=${account} />
  <//>`;
}

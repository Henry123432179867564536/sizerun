// Sale detail (#/sales/:id) — docs/desk-spec.md §7 "Views".
//
// One sale end to end. The top card is the summary: status, payment, the key figures (profit,
// margin, owed), why it is still pending and the one next step (a sticky bar on phones), with
// the full profit waterfall behind "How it adds up". Below: the items (with per-line profit and
// the order total), payments, the client with WhatsApp quick messages, extra costs, drives and
// the details. Adding or editing anything opens a sheet. Every figure comes from
// calc.dealTotals(); the editing pieces are shared with the New sale form in views/deals.js.

import { html, useEffect, useMemo, useRef, useState } from '../lib/preact.js';
import {
  Badge,
  Banner,
  Button,
  Card,
  Empty,
  ErrorState,
  Field,
  Icon,
  Input,
  Loading,
  Modal,
  Money,
  Page,
  Segmented,
  Select,
  Textarea,
  bucketMeta,
  confirmDialog,
  cx,
  paymentMeta,
  statusMeta,
  statusOptions,
  toast,
  useStoreData,
} from '../lib/ui.js';
import { EPS, dealNumber, dealTotals, itemCost, itemTotals, num, round2, stockLevels, tripTotals } from '../lib/calc.js';
import { date as formatDate, dateShort, duration, miles as formatMiles, money, pct, plural, relDays, todayISO } from '../lib/format.js';
import {
  COST_KINDS,
  ClientPicker,
  CostFields,
  DELIVERY_METHODS,
  DELIVERY_OPTIONS,
  DRIVEN_DELIVERY,
  Disclosure,
  ItemFields,
  PAYMENT_METHODS,
  PAYMENT_METHOD_OPTIONS,
  ProfitBreakdown,
  TripModal,
  amountProblem,
  amountText,
  blankCost,
  blankItem,
  clientDestination,
  costProblems,
  costRowFromDraft,
  draftFromCost,
  draftFromItem,
  homeLocation,
  itemProblems,
  itemRowFromDraft,
  itemsToBuy,
  parseAmount,
  revealFirstError,
  stockChoicesFor,
  tripEnd,
  tripRoute,
  unitCount,
  useFormBarHeight,
  useMedia,
} from './deals.js';

const DONE_STATUSES = new Set(['delivered', 'completed']);
const PAYMENTS_ID = 'sale-payments';

// Sale page styles, added to <head> once (the shared sales styles come with views/deals.js).
const CSS = `
.sd-chips { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.sd-chips .select-wrap { flex: 0 1 auto; }
.sd-chips .select { width: auto; max-width: 100%; font-weight: 600; }
.sd-figs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); }
.sd-fig { min-width: 0; padding: 0 12px; border-left: 1px solid var(--line); }
.sd-fig:first-child { padding-left: 0; border-left: 0; }
.sd-fig-label { color: var(--ink-2); font-size: 12.5px; }
.sd-fig-value { overflow: hidden; font-size: 22px; font-weight: 600; line-height: 1.25; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
.sd-fig-sub { overflow: hidden; color: var(--ink-2); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 400px) { .sd-fig { padding: 0 8px; } .sd-fig-value { font-size: 19px; } }
.sd-reason { margin: 0; color: var(--ink-2); font-size: 13px; }
.sd-step { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 12px; padding: 12px; border-radius: var(--r-ctl); background: var(--signal-tint); }
.sd-step-text { display: flex; flex: 1 1 200px; flex-direction: column; min-width: 0; line-height: 1.35; }
.sd-step-title { font-weight: 600; }
.sd-step-sub { color: var(--ink-2); font-size: 13px; }
@media (max-width: 899.98px) { .sd-step { display: none; } }
@media (min-width: 900px) { .sd-bar { display: none; } }
.sd-line { display: flex; flex-direction: column; }
.sd-line-main { display: flex; align-items: flex-start; gap: 12px; width: 100%; min-height: 56px; margin: 0; padding: 12px 16px; border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; -webkit-tap-highlight-color: transparent; }
.sd-line-main:hover { background: var(--hover); }
.sd-line-main:focus-visible { outline: 2px solid var(--signal); outline-offset: -2px; }
.sd-line-text { display: flex; flex: 1 1 auto; flex-direction: column; gap: 2px; min-width: 0; }
.sd-line-title { display: -webkit-box; overflow: hidden; font-weight: 500; overflow-wrap: anywhere; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.sd-line-sub { color: var(--ink-2); font-size: 13px; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.sd-line-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; margin-top: 2px; color: var(--ink-2); font-size: 12.5px; }
.sd-line-aside { display: flex; flex: none; flex-direction: column; align-items: flex-end; text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.sd-line-aside .sd-line-sub { font-size: 12px; }
.sd-line-chev { flex: none; margin-top: 2px; color: var(--ink-3); }
.sd-line-cta { display: flex; gap: 8px; padding: 0 16px 12px; }
.sd-total { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 12px 16px; border-top: 1px solid var(--line); background: var(--surface-2); font-variant-numeric: tabular-nums; }
.sd-total-label { font-weight: 600; }
.sd-total-sub { color: var(--ink-2); font-size: 12.5px; }
.sd-total-value { text-align: right; font-weight: 600; white-space: nowrap; }
.sd-empty { margin: 0; padding: 0 16px 16px; color: var(--ink-2); font-size: 13px; }
.sd-pad { padding: 4px 16px 14px; }
.sd-ruled { border-top: 1px solid var(--line); }
.sd-balance { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.sd-balance-value { font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; }
.sd-msgs { display: flex; flex-wrap: wrap; gap: 8px; }
.sd-msgs .btn { flex: 1 1 auto; }
@media (min-width: 640px) { .sd-msgs .btn { flex: 0 1 auto; } }
`;

const STYLE_ID = 'desk-sale-styles';
if (typeof document !== 'undefined' && !document.getElementById(STYLE_ID)) {
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.append(style);
}

// Autofocus only with a mouse: on a phone it scrolls the sheet and pops the keyboard over it.
const FINE_POINTER = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  && window.matchMedia('(pointer: fine)').matches;

async function loadSale(s, id) {
  const deal = await s.deals.get(id);
  if (!deal) return { deal: null };
  const [settings, client] = await Promise.all([
    s.settings.get(),
    deal.client_id ? s.clients.get(deal.client_id) : null,
  ]);
  return { deal, settings, client };
}

function isEmpty(problems) {
  return Object.keys(problems).length === 0;
}

/** Enter in a text box saves the sheet. */
function enterSaves(save) {
  return (event) => {
    if (event.key !== 'Enter' || !(event.target instanceof HTMLInputElement)) return;
    event.preventDefault();
    save();
  };
}

function varianceText(variance) {
  if (variance === null) return null;
  if (Math.abs(variance) < EPS) return 'Exactly what you expected.';
  return variance > 0 ? `${money(variance)} cheaper than expected.` : `${money(-variance)} more than expected.`;
}

function toneOf(value) {
  if (value >= EPS) return 'gain';
  if (value <= -EPS) return 'loss';
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// WhatsApp quick messages (never any cost, supplier, profit or note)
// ---------------------------------------------------------------------------------------------

/** A phone number as wa.me digits: '07700 900123' → '447700900123'; '' when unusable. */
export function waDigits(phone) {
  let text = String(phone ?? '').replace(/\(0\)/g, '').trim();
  const international = text.startsWith('+');
  let digits = text.replace(/\D/g, '');
  if (!digits) return '';
  if (!international) {
    if (digits.startsWith('00')) digits = digits.slice(2);
    else if (digits.startsWith('0')) digits = `44${digits.slice(1)}`;
  }
  if (/^440\d{10}$/.test(digits)) digits = `44${digits.slice(3)}`; // +44 07700 …
  return digits.length >= 10 && digits.length <= 15 ? digits : '';
}

function firstName(name) {
  return String(name ?? '').trim().split(/\s+/)[0] || 'there';
}

/** 'Nike Dunk Low Panda (UK 9)', 'Jordan 1 Chicago (UK 9) and 2 more'. */
export function itemsPhrase(items) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return 'order';
  const first = list[0];
  let text = `${first.description || 'order'}${first.size ? ` (${first.size})` : ''}`;
  if (text.length > 40) text = `${text.slice(0, 39).trimEnd()}…`;
  return list.length > 1 ? `${text} and ${list.length - 1} more` : text;
}

/** 'the training ground', 'yours' (Home), or null. */
function placePhrase(client) {
  const place = clientDestination(client);
  const label = String(place?.label ?? '').trim();
  if (!label || label === client?.name) return null;
  if (label.toLowerCase() === 'home') return 'yours';
  return `the ${label.toLowerCase()}`;
}

/** Now plus `minutes`, rounded up to the next 5 minutes: '2:35pm'. */
export function etaText(minutes, now = new Date()) {
  const at = new Date(now.getTime() + Math.max(0, minutes) * 60000);
  at.setMinutes(Math.ceil((at.getMinutes() + at.getSeconds() / 60) / 5) * 5, 0, 0);
  const hours = at.getHours();
  return `${hours % 12 || 12}:${String(at.getMinutes()).padStart(2, '0')}${hours >= 12 ? 'pm' : 'am'}`;
}

/** One-way minutes of the sale's latest drive, or null. */
function latestDriveMinutes(trips) {
  const list = [...(trips ?? [])].sort((a, b) => String(b.trip_date ?? '').localeCompare(String(a.trip_date ?? ''))
    || String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
  const minutes = num(list[0]?.one_way_minutes);
  return minutes > 0 ? minutes : null;
}

/**
 * The quick messages that fit this sale: [{ id, label, text() }]. Texts are built on tap so an
 * ETA is from the moment of sending. Only the client's name, items, sizes, balance and place.
 */
export function quickMessages({ deal, client, totals, now }) {
  if (!client || deal.status === 'cancelled') return [];
  const first = firstName(client.name);
  const items = itemsPhrase(deal.items);
  const place = placePhrase(client);
  const many = (deal.items ?? []).length > 1 || num(deal.items?.[0]?.qty) > 1;
  const minutes = latestDriveMinutes(deal.trips);
  const open = !DONE_STATUSES.has(deal.status);
  const list = [];
  if (totals.balance > EPS && deal.status !== 'enquiry') {
    list.push({
      id: 'reminder',
      label: `Payment reminder · ${money(totals.balance)}`,
      text: () => `Hi ${first}, hope all's good. Just a reminder that ${money(totals.balance)} is still outstanding for your ${items}. Thanks!`,
    });
  }
  if (open) {
    list.push({
      id: 'ready',
      label: 'Ready to drop off',
      text: () => `Hi ${first}, your ${items} ${many ? 'are' : 'is'} in. When suits you for a drop-off?${place ? ` I can come to ${place}.` : ''}`,
    });
    list.push({
      id: 'omw',
      label: minutes ? `On my way · ${duration(minutes)}` : 'On my way',
      text: () => {
        const eta = minutes ? etaText(minutes, now?.() ?? new Date()) : null;
        const where = place ? ` at ${place}` : '';
        return `Hi ${first}, on my way with your ${items}.${eta ? ` Should be with you${where} around ${eta}.` : ''}`;
      },
    });
  }
  return list;
}

export function waLink(phone, text) {
  const digits = waDigits(phone);
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

function ContactCard({ deal, client, totals }) {
  const id = deal.id;
  const receipt = html`<${Button} kind="ghost" size="sm" icon="external" href=${`#/sales/${id}/receipt`}>Receipt<//>`;
  if (!client) {
    return html`<${Card} title="Client" actions=${receipt}>
      <p class="sd-reason">No client on this sale. Use Edit details to add one and message them from here.</p>
    <//>`;
  }
  const messages = quickMessages({ deal, client, totals });
  const digits = waDigits(client.phone);
  let body;
  if (!digits) {
    body = html`<p class="sd-reason">
      No phone number for ${firstName(client.name)} yet. <a href=${`#/clients/${client.id}?edit=1`}>Add it</a> to send WhatsApp updates from here.
    </p>`;
  } else if (messages.length) {
    body = html`<div class="sd-msgs" role="group" aria-label="WhatsApp quick messages">
      ${messages.map((message) => html`<${Button}
        key=${message.id}
        size="sm"
        href=${waLink(client.phone, message.text())}
        target="_blank"
        rel="noopener"
        onClick=${(event) => {
          event.currentTarget.href = waLink(client.phone, message.text()); // fresh ETA
        }}
      >${message.label}<//>`)}
    </div>`;
  } else {
    body = html`<p class="sd-reason">All done — nothing to chase on this sale.</p>`;
  }
  const sub = [client.club, digits && 'WhatsApp'].filter(Boolean).join(' · ');
  return html`<${Card}
    title=${html`<a href=${`#/clients/${client.id}`}>${client.name}</a>`}
    subtitle=${sub || null}
    actions=${receipt}
  >${body}<//>`;
}

// ---------------------------------------------------------------------------------------------
// Summary: status, key figures and the next step
// ---------------------------------------------------------------------------------------------

function bucketReason(deal, totals) {
  if (totals.bucket === 'cancelled') return 'Cancelled — left out of every total.';
  if (totals.bucket === 'realised') return totals.paymentStatus === 'none'
    ? 'Realised: delivered free of charge, every cost confirmed.'
    : 'Realised: delivered, paid and every cost confirmed.';
  const waiting = [];
  if (totals.certainty === 'estimated') waiting.push(`${plural(totals.expectedCount, 'cost')} still estimated`);
  if (!DONE_STATUSES.has(deal.status)) waiting.push('not delivered yet');
  if (totals.paymentStatus === 'unpaid' || totals.paymentStatus === 'part') waiting.push(`${money(totals.balance)} still to come in`);
  return `Pending — ${waiting.join(', ')}.`;
}

function nextStep(deal, totals) {
  if ((deal.items ?? []).length === 0) {
    return { title: 'Add what you sold', text: 'This sale has no items yet.', label: 'Add item', action: { kind: 'add-item' } };
  }
  const toBuy = itemsToBuy(deal);
  const expectedCosts = (deal.costs ?? []).filter((cost) => cost.is_expected);
  switch (deal.status) {
    case 'enquiry':
      return { title: 'Still an enquiry', text: "Once they've said yes, mark it agreed.", label: 'Mark agreed', action: { kind: 'status', status: 'agreed' } };
    case 'agreed':
    case 'sourcing':
      if (toBuy.length > 0) {
        const item = toBuy[0];
        return {
          title: toBuy.length === 1 ? `Buy ${item.description}` : `${toBuy.length} items to buy`,
          text: `Expected ${money(num(item.expected_unit_cost) * num(item.qty))}${toBuy.length > 1 ? ` for ${item.description}` : ''}.`,
          label: 'Mark bought',
          action: { kind: 'bought', item },
        };
      }
      if (expectedCosts.length > 0) {
        const cost = expectedCosts[0];
        return { title: `Confirm ${cost.label}`, text: `Estimated at ${money(cost.amount)}.`, label: 'Confirm cost', action: { kind: 'cost', cost } };
      }
      return { title: "Everything's in hand", text: 'Ready to hand it over?', label: 'Set ready to deliver', action: { kind: 'status', status: 'ready' } };
    case 'ready':
      return {
        title: 'Ready to deliver',
        text: deal.due_date ? `Due ${relDays(deal.due_date)}.` : 'Handed it over?',
        label: 'Mark delivered',
        action: { kind: 'status', status: 'delivered' },
      };
    case 'delivered':
      if (totals.paymentStatus === 'paid' || totals.paymentStatus === 'none') {
        return { title: 'Delivered and paid', text: 'Close it off.', label: 'Mark completed', action: { kind: 'status', status: 'completed' } };
      }
      return {
        title: `${money(totals.balance)} to come in`,
        text: 'Record it when it lands.',
        label: 'Record payment',
        action: { kind: 'payment' },
      };
    default:
      return null; // completed or cancelled
  }
}

function Figure({ label, value, sub, tone }) {
  return html`<div class="sd-fig">
    <div class="sd-fig-label">${label}</div>
    <div class=${cx('sd-fig-value', tone && `tone-${tone}`)}>${value}</div>
    ${sub && html`<div class="sd-fig-sub">${sub}</div>`}
  </div>`;
}

function SummaryCard({ deal, totals, settings, status, statusBusy, onStatus, step, onStep }) {
  const wide = useMedia('(min-width: 900px)');
  const cancelled = totals.bucket === 'cancelled';
  const bucket = bucketMeta[totals.bucket] ?? bucketMeta.pending;
  const payment = paymentMeta[totals.paymentStatus] ?? paymentMeta.none;
  const target = num(settings?.target_margin);
  const underTarget = target > 0 && totals.margin !== null && totals.netProfit < target * totals.revenue - EPS;

  let owed = { label: 'Owed', value: '—', sub: null, tone: undefined };
  if (!cancelled) {
    if (totals.balance > EPS) {
      owed = { label: 'Owed', value: money(totals.balance), sub: `${money(totals.paid)} paid`, tone: DONE_STATUSES.has(deal.status) ? 'loss' : 'warn' };
    } else if (totals.balance < -EPS) {
      owed = { label: 'Overpaid', value: money(-totals.balance), sub: 'Refund or keep as credit', tone: 'warn' };
    } else if (totals.revenue > EPS) {
      owed = { label: 'Paid', value: money(totals.paid), sub: 'In full', tone: 'gain' };
    }
  }

  return html`<${Card}>
    <div class="stack">
      <div class="sd-chips">
        <${Select}
          aria-label="Sale status"
          options=${statusOptions}
          value=${status}
          disabled=${statusBusy}
          onChange=${(event) => onStatus(event.currentTarget.value, event.currentTarget)}
        />
        ${cancelled
          ? html`<${Badge} tone=${bucket.tone}>${bucket.label}<//>`
          : html`<${Badge} tone=${payment.tone}>${payment.label}<//>`}
      </div>
      <div class="sd-figs">
        <${Figure}
          label="Profit"
          value=${money(totals.netProfit)}
          tone=${cancelled ? undefined : toneOf(totals.netProfit)}
          sub=${cancelled ? 'Not counted' : totals.certainty === 'estimated' ? 'Estimated' : 'Confirmed'}
        />
        <${Figure}
          label="Margin"
          value=${pct(totals.margin)}
          tone=${underTarget && !cancelled ? 'warn' : undefined}
          sub=${target > 0 ? `Target ${pct(target)}` : null}
        />
        <${Figure} ...${owed} />
      </div>
      <p class="sd-reason">${bucketReason(deal, totals)}</p>
      ${step && html`<div class="sd-step">
        <div class="sd-step-text">
          <span class="sd-step-title wrap-anywhere">${step.title}</span>
          <span class="sd-step-sub">${step.text}</span>
        </div>
        <${Button} kind="primary" onClick=${onStep}>${step.label}<//>
      </div>`}
      <${Disclosure} title="How it adds up" hint=${wide ? null : `${money(totals.revenue)} sale`} open=${wide}>
        <${ProfitBreakdown} totals=${totals} targetMargin=${target} />
      <//>
    </div>
  <//>`;
}

// ---------------------------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------------------------

// Where an item comes from, plus supplier and purchase date when known.
function sourceBadge(item) {
  const actual = item.cost_status === 'actual';
  const detail = [item.supplier && `from ${item.supplier}`, actual && item.sourced_at && dateShort(item.sourced_at)]
    .filter(Boolean).join(' · ');
  let pill = html`<span class="pill pill-warn">To buy</span>`;
  if (actual) {
    pill = item.stock_item_id
      ? html`<span class="pill pill-signal">From stock</span>`
      : html`<span class="pill pill-gain">Bought</span>`;
  }
  return html`${pill}${detail && html`<span>${detail}</span>`}`;
}

function ItemLine({ item, onEdit, onMarkBought }) {
  const line = itemTotals(item);
  const qty = num(item.qty);
  const sub = [
    item.size,
    `${qty} × ${money(item.unit_price)}`,
    `cost ${money(itemCost(item))}${qty > 1 ? ' each' : ''}${line.isExpected ? ' (est.)' : ''}`,
  ].filter(Boolean).join(' · ');
  const varies = line.variance !== null && Math.abs(line.variance) >= EPS;
  return html`<div class="sd-line">
    <button type="button" class="sd-line-main" onClick=${onEdit}>
      <span class="sd-line-text">
        <span class="sd-line-title">${item.description}</span>
        <span class="sd-line-sub">${sub}</span>
        <span class="sd-line-meta">
          ${sourceBadge(item)}
          ${varies && html`<span class=${line.variance > 0 ? 'tone-gain' : 'tone-loss'}>
            ${money(Math.abs(line.variance))} ${line.variance > 0 ? 'under' : 'over'} expected
          </span>`}
        </span>
      </span>
      <span class="sd-line-aside">
        <${Money} value=${line.revenue - line.cost} tone="auto" />
        <span class="sd-line-sub">profit</span>
      </span>
      <${Icon} name="chevron-right" size=${18} class="sd-line-chev" />
    </button>
    ${line.isExpected && html`<div class="sd-line-cta">
      <${Button} kind="primary" size="sm" icon="check" onClick=${onMarkBought}>Mark bought<//>
    </div>`}
  </div>`;
}

function ItemsCard({ deal, totals, onAdd, onEdit, onMarkBought }) {
  const items = deal.items ?? [];
  const units = unitCount(items);
  const goodsProfit = totals.revenue - totals.goodsCost;
  return html`<${Card}
    pad=${false}
    title="Items"
    subtitle=${items.length ? `${plural(units, 'item')}${items.length > 1 ? ` on ${items.length} lines` : ''}` : null}
    actions=${html`<${Button} kind="ghost" size="sm" icon="plus" onClick=${onAdd}>Add item<//>`}
  >
    ${items.length === 0
      ? html`<p class="sd-empty">No items yet. Add what they're buying so Desk can work out the profit.</p>`
      : html`<div class="list">
          ${items.map((item) => html`<${ItemLine}
            key=${item.id}
            item=${item}
            onEdit=${() => onEdit(item)}
            onMarkBought=${() => onMarkBought(item)}
          />`)}
        </div>
        <div class="sd-total">
          <div>
            <div class="sd-total-label">Order total</div>
            <div class="sd-total-sub">${money(totals.goodsCost)} cost${totals.goodsCostExpected > EPS ? ' (part est.)' : ''}</div>
          </div>
          <div class="sd-total-value">
            <div>${money(totals.revenue)}</div>
            <div class="sd-total-sub"><${Money} value=${goodsProfit} tone="auto" /> on the goods</div>
          </div>
        </div>`}
  <//>`;
}

// Add or edit one item in a sheet (the same fields as a New sale item).
function ItemSheet({ store, deal, item, onClose }) {
  const boxRef = useRef(null);
  const [draft, setDraft] = useState(() => (item ? draftFromItem(item) : blankItem()));
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const { data: stockData, error: stockError } = useStoreData(store, async (s) => {
    const [stock, deals] = await Promise.all([s.stock.list({ includeArchived: true }), s.deals.list()]);
    return { stock, deals };
  });

  const choices = useMemo(() => {
    if (!stockData) return [];
    // This line's own share of its stock is free again while it is being edited.
    const others = stockData.deals.map((entry) => (entry.id === deal.id
      ? { ...entry, items: (entry.items ?? []).filter((line) => line.id !== item?.id) }
      : entry));
    return stockChoicesFor(stockData.stock, stockLevels(stockData.stock, others), [], draft.stock_item_id);
  }, [stockData, deal.id, item?.id, draft.stock_item_id]);
  const maxQty = choices.find((choice) => choice.stock.id === draft.stock_item_id)?.available;
  const problems = itemProblems(draft, { maxQty });

  async function save() {
    if (saving) return;
    setShowErrors(true);
    if (!isEmpty(problems)) {
      revealFirstError(boxRef.current);
      return;
    }
    // Without stock levels the "only N left" cap can't be checked: never let the line take more
    // from stock than it already holds until they load.
    if (draft.source === 'stock' && draft.stock_item_id && !stockData) {
      const held = item?.stock_item_id === draft.stock_item_id ? num(item.qty) : 0;
      if (num(parseAmount(draft.qty)) > held) {
        toast(stockError ? `Couldn't check your stock: ${stockError.message}` : 'Still loading your stock — try again in a moment.', { tone: 'warn' });
        return;
      }
    }
    setSaving(true);
    const row = itemRowFromDraft(draft, new Map(choices.map((choice) => [choice.stock.id, choice.stock])));
    try {
      if (item) await store.items.update(item.id, row);
      else await store.items.create(deal.id, row);
      toast(item ? 'Item updated.' : 'Item added.', { tone: 'gain' });
      onClose();
    } catch (err) {
      toast(err, { tone: 'loss' });
      setSaving(false);
    }
  }

  async function remove() {
    const ok = await confirmDialog({
      title: `Remove ${item.description}?`,
      body: `Its sale price and cost come off this sale.${item.stock_item_id ? ' It goes back into stock.' : ''}`,
      confirmLabel: 'Remove item',
      danger: true,
    });
    if (!ok) return;
    try {
      await store.items.remove(item.id);
      toast('Item removed.');
      onClose();
    } catch (err) {
      toast(err, { tone: 'loss' });
    }
  }

  const close = () => {
    if (!saving) onClose();
  };
  const footer = html`
    ${item && html`<${Button} kind="ghost" icon="trash" class="sf-foot-left" onClick=${remove} disabled=${saving}>Remove<//>`}
    <${Button} kind="ghost" onClick=${close} disabled=${saving}>Cancel<//>
    <${Button} kind="primary" icon="check" loading=${saving} onClick=${save}>${item ? 'Save item' : 'Add item'}<//>`;

  return html`<${Modal} title=${item ? 'Edit item' : 'Add item'} onClose=${close} footer=${footer}>
    <div class="stack" ref=${boxRef} onKeyDown=${enterSaves(save)}>
      <${ItemFields}
        draft=${draft}
        errors=${showErrors ? problems : {}}
        stockChoices=${choices}
        maxQty=${maxQty}
        onChange=${(patch) => setDraft((current) => ({ ...current, ...patch }))}
      />
      ${draft.source === 'stock' && stockError && html`<p class="sd-reason tone-warn">Couldn't load your stock: ${stockError.message}</p>`}
      ${draft.source === 'stock' && !stockData && !stockError && html`<p class="sd-reason">Loading your stock…</p>`}
    </div>
  <//>`;
}

function MarkBoughtModal({ store, item, onClose, onBought }) {
  const [cost, setCost] = useState(amountText(item.expected_unit_cost));
  const [supplier, setSupplier] = useState(item.supplier ?? '');
  const [boughtOn, setBoughtOn] = useState(todayISO());
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const qty = num(item.qty);
  const unitCost = parseAmount(cost);
  const costError = amountProblem(cost, { what: 'what you paid' });
  const dateError = boughtOn ? null : 'Enter the day you bought it.';
  const variance = costError ? null : itemTotals({ ...item, cost_status: 'actual', unit_cost: unitCost }).variance;

  async function save() {
    if (saving) return;
    setShowErrors(true);
    if (costError || dateError) return;
    setSaving(true);
    try {
      await store.items.update(item.id, {
        cost_status: 'actual',
        unit_cost: unitCost,
        supplier: supplier.trim() || null,
        sourced_at: boughtOn,
      });
      onBought(variance);
    } catch (err) {
      toast(err, { tone: 'loss' });
      setSaving(false);
    }
  }

  const close = () => {
    if (!saving) onClose();
  };
  const footer = html`
    <${Button} kind="ghost" onClick=${close} disabled=${saving}>Cancel<//>
    <${Button} kind="primary" icon="check" loading=${saving} onClick=${save}>Mark bought<//>`;

  let varianceNote = null;
  if (variance !== null) {
    const tone = Math.abs(variance) < EPS ? 'neutral' : variance > 0 ? 'gain' : 'warn';
    const each = qty > 1 && Math.abs(variance) >= EPS ? ` That's ${money(Math.abs(variance) / qty)} each.` : '';
    varianceNote = html`<${Banner} tone=${tone} icon=${false}>${varianceText(variance)}${each}<//>`;
  }

  return html`<${Modal} title="Mark bought" size="sm" onClose=${close} footer=${footer}>
    <div class="stack" onKeyDown=${enterSaves(save)}>
      <p class="sd-reason">
        <span class="strong wrap-anywhere">${item.description}${qty > 1 ? ` ×${qty}` : ''}</span>
        ${' '}— you expected to pay ${money(item.expected_unit_cost)}${qty > 1 ? ' each' : ''}.
      </p>
      <div class="fields">
        <${Field} label="Paid each" required error=${showErrors && costError}>
          <${Input} prefix="£" inputmode="decimal" autocomplete="off" autofocus=${FINE_POINTER} value=${cost} onInput=${(event) => setCost(event.currentTarget.value)} />
        <//>
        <${Field} label="Bought on" required error=${showErrors && dateError}>
          <${Input} type="date" max=${todayISO()} value=${boughtOn} onInput=${(event) => setBoughtOn(event.currentTarget.value)} />
        <//>
        <${Field} label="Bought from" class="span-all">
          <${Input} autocomplete="off" placeholder="e.g. Selfridges" value=${supplier} onInput=${(event) => setSupplier(event.currentTarget.value)} />
        <//>
      </div>
      ${varianceNote}
    </div>
  <//>`;
}

// ---------------------------------------------------------------------------------------------
// Extra costs
// ---------------------------------------------------------------------------------------------

function CostSheet({ store, deal, cost, startConfirmed, onClose }) {
  const boxRef = useRef(null);
  const [draft, setDraft] = useState(() => {
    const base = cost ? draftFromCost(cost) : blankCost();
    return startConfirmed ? { ...base, is_expected: false } : base;
  });
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const problems = costProblems(draft);

  async function save() {
    if (saving) return;
    setShowErrors(true);
    if (!isEmpty(problems)) {
      revealFirstError(boxRef.current);
      return;
    }
    setSaving(true);
    try {
      const row = costRowFromDraft(draft);
      if (cost) await store.costs.update(cost.id, row);
      else await store.costs.create(deal.id, row);
      toast(cost ? 'Cost updated.' : 'Cost added.', { tone: 'gain' });
      onClose();
    } catch (err) {
      toast(err, { tone: 'loss' });
      setSaving(false);
    }
  }

  async function remove() {
    const ok = await confirmDialog({
      title: `Remove ${cost.label}?`,
      body: `${money(cost.amount)} comes off this sale's costs.`,
      confirmLabel: 'Remove cost',
      danger: true,
    });
    if (!ok) return;
    try {
      await store.costs.remove(cost.id);
      toast('Cost removed.');
      onClose();
    } catch (err) {
      toast(err, { tone: 'loss' });
    }
  }

  const close = () => {
    if (!saving) onClose();
  };
  const footer = html`
    ${cost && html`<${Button} kind="ghost" icon="trash" class="sf-foot-left" onClick=${remove} disabled=${saving}>Remove<//>`}
    <${Button} kind="ghost" onClick=${close} disabled=${saving}>Cancel<//>
    <${Button} kind="primary" icon="check" loading=${saving} onClick=${save}>${cost ? 'Save cost' : 'Add cost'}<//>`;

  let title = 'Add a cost';
  if (cost) title = startConfirmed ? `Confirm ${cost.label}` : 'Edit cost';
  return html`<${Modal} title=${title} size="sm" onClose=${close} footer=${footer}>
    <div ref=${boxRef} onKeyDown=${enterSaves(save)}>
      <${CostFields}
        draft=${draft}
        errors=${showErrors ? problems : {}}
        onChange=${(patch) => setDraft((current) => ({ ...current, ...patch }))}
      />
    </div>
  <//>`;
}

// 'Shipping · estimate', leaving out the type when the cost is already named after it.
function costSub(cost) {
  const kind = COST_KINDS[cost.kind] ?? COST_KINDS.other;
  return [cost.label !== kind && kind, cost.is_expected && 'estimate'].filter(Boolean).join(' · ');
}

function CostsCard({ deal, totals, onAdd, onEdit }) {
  const costs = deal.costs ?? [];
  return html`<${Card}
    pad=${false}
    title="Extra costs"
    subtitle=${costs.length ? `${money(totals.extraCosts)} in total` : null}
    actions=${html`<${Button} kind="ghost" size="sm" icon="plus" onClick=${onAdd}>Add cost<//>`}
  >
    ${costs.length === 0
      ? html`<p class="sd-empty">Postage, fees or packaging — add them so the profit is right.</p>`
      : html`<div class="list">
          ${costs.map((cost) => html`<div key=${cost.id} class="sd-line">
            <button type="button" class="sd-line-main" onClick=${() => onEdit(cost, false)}>
              <span class="sd-line-text">
                <span class="sd-line-title">${cost.label}</span>
                ${costSub(cost) && html`<span class="sd-line-sub">${costSub(cost)}</span>`}
              </span>
              <span class="sd-line-aside">
                <${Money} value=${cost.amount} />
                ${cost.is_expected && html`<span class="pill pill-warn">est.</span>`}
              </span>
              <${Icon} name="chevron-right" size=${18} class="sd-line-chev" />
            </button>
            ${cost.is_expected && html`<div class="sd-line-cta">
              <${Button} size="sm" icon="check" onClick=${() => onEdit(cost, true)}>Confirm cost<//>
            </div>`}
          </div>`)}
        </div>`}
  <//>`;
}

// ---------------------------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------------------------

function lastMethod(deal) {
  const payments = deal.payments ?? [];
  return payments.length ? payments[payments.length - 1].method : 'bank';
}

const PAYMENT_KINDS = [
  { value: 'payment', label: 'Payment' },
  { value: 'refund', label: 'Refund' },
];

function PaymentSheet({ store, deal, balance, paid, onClose }) {
  const boxRef = useRef(null);
  const [amount, setAmount] = useState(balance > EPS ? amountText(round2(balance)) : '');
  const [method, setMethod] = useState(() => lastMethod(deal));
  const [paidAt, setPaidAt] = useState(todayISO());
  const [note, setNote] = useState('');
  const [kind, setKind] = useState('payment');
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const refund = kind === 'refund';
  const value = parseAmount(amount);
  const amountError = amountProblem(amount, { what: refund ? 'the refund' : 'the amount paid', allowZero: false });
  // A refund can't be more than has come in, or the sale would owe more than its price.
  const refundOver = refund && !amountError && value > Math.max(0, paid) + EPS
    ? `You've only been paid ${money(Math.max(0, paid))} on this sale.`
    : null;
  const dateError = paidAt ? null : 'Enter the payment date.';
  const over = !refund && !amountError && value > balance + EPS
    ? `That's ${money(value - Math.max(0, balance))} more than the balance.`
    : null;

  async function save() {
    if (saving) return;
    setShowErrors(true);
    if (amountError || refundOver || dateError) {
      revealFirstError(boxRef.current);
      return;
    }
    setSaving(true);
    try {
      await store.payments.create(deal.id, { amount: refund ? -value : value, method, paid_at: paidAt, note: note.trim() || null });
      toast(`${refund ? 'Refund' : 'Payment'} of ${money(value)} recorded.`, { tone: 'gain' });
      onClose();
    } catch (err) {
      toast(err, { tone: 'loss' });
      setSaving(false);
    }
  }

  const close = () => {
    if (!saving) onClose();
  };
  const footer = html`
    <${Button} kind="ghost" onClick=${close} disabled=${saving}>Cancel<//>
    <${Button} kind="primary" icon="check" loading=${saving} onClick=${save}>Save ${refund ? 'refund' : 'payment'}<//>`;

  return html`<${Modal} title=${refund ? 'Record a refund' : 'Record a payment'} size="sm" onClose=${close} footer=${footer}>
    <div class="stack" ref=${boxRef} onKeyDown=${enterSaves(save)}>
      <${Segmented} full label="Payment or refund" options=${PAYMENT_KINDS} value=${kind} onChange=${setKind} />
      <div class="fields">
        <${Field}
          label=${refund ? 'Refunded' : 'Amount'}
          required
          error=${showErrors && (amountError || refundOver)}
          hint=${refund ? 'Money you paid back to the client.' : over}
        >
          <${Input} prefix="£" inputmode="decimal" autocomplete="off" placeholder="0.00" value=${amount} onInput=${(event) => setAmount(event.currentTarget.value)} />
        <//>
        <${Field} label="Date" required error=${showErrors && dateError}>
          <${Input} type="date" value=${paidAt} onInput=${(event) => setPaidAt(event.currentTarget.value)} />
        <//>
      </div>
      <div class="field">
        <span class="field-label" aria-hidden="true">${refund ? 'Refunded by' : 'Paid by'}</span>
        <${Segmented} full label=${refund ? 'Refunded by' : 'Paid by'} options=${PAYMENT_METHOD_OPTIONS} value=${method} onChange=${setMethod} />
      </div>
      <${Field} label="Note">
        <${Input} autocomplete="off" placeholder=${refund ? 'e.g. Wrong size' : 'e.g. Deposit'} value=${note} onInput=${(event) => setNote(event.currentTarget.value)} />
      <//>
    </div>
  <//>`;
}

function PaymentsCard({ store, deal, totals, onRecord }) {
  const [paying, setPaying] = useState(false);
  const payment = paymentMeta[totals.paymentStatus] ?? paymentMeta.none;
  const payments = deal.payments ?? [];
  const balance = totals.balance;
  const cancelled = deal.status === 'cancelled';

  let balanceLabel = 'Balance due';
  let balanceTone = DONE_STATUSES.has(deal.status) ? 'loss' : 'warn';
  if (balance < -EPS) {
    balanceLabel = 'Overpaid by';
    balanceTone = 'warn';
  } else if (balance <= EPS) {
    balanceLabel = totals.revenue > EPS ? 'Paid in full' : 'Nothing to collect yet';
    balanceTone = totals.revenue > EPS ? 'gain' : undefined;
  }

  async function paidInFull() {
    const amount = round2(balance);
    setPaying(true);
    try {
      const created = await store.payments.create(deal.id, { amount, method: lastMethod(deal), paid_at: todayISO() });
      toast(`Paid in full — ${money(amount)} recorded.`, {
        tone: 'gain',
        action: {
          label: 'Undo',
          onClick: () => store.payments.remove(created.id).then(
            () => toast('Payment removed.'),
            (err) => toast(err, { tone: 'loss' }),
          ),
        },
      });
    } catch (err) {
      toast(err, { tone: 'loss' });
    } finally {
      setPaying(false);
    }
  }

  async function remove(entry) {
    const refund = entry.amount < 0;
    const ok = await confirmDialog({
      title: refund ? 'Remove this refund?' : 'Remove this payment?',
      body: `${money(Math.abs(entry.amount))} on ${formatDate(entry.paid_at)}. The balance goes ${refund ? 'down' : 'back up'} by the same amount.`,
      confirmLabel: refund ? 'Remove refund' : 'Remove payment',
      danger: true,
    });
    if (!ok) return;
    try {
      await store.payments.remove(entry.id);
      toast(refund ? 'Refund removed.' : 'Payment removed.');
    } catch (err) {
      toast(err, { tone: 'loss' });
    }
  }

  return html`<${Card}
    id=${PAYMENTS_ID}
    pad=${false}
    title="Payments"
    subtitle=${`Paid ${money(totals.paid)} of ${money(totals.revenue)}`}
    actions=${html`<${Badge} tone=${payment.tone}>${payment.label}<//>`}
  >
    <div class="stack sd-pad">
      <div class="sd-balance">
        <span class="muted">${balanceLabel}</span>
        ${Math.abs(balance) > EPS && html`<span class="sd-balance-value"><${Money} value=${Math.abs(balance)} tone=${balanceTone} /></span>`}
      </div>
      ${!cancelled && html`<div class="row">
        ${balance > EPS && html`<${Button} kind="primary" size="sm" icon="check" loading=${paying} onClick=${paidInFull}>
          Paid in full · ${money(balance)}
        <//>`}
        <${Button} size="sm" icon="plus" onClick=${onRecord}>Record payment<//>
      </div>`}
    </div>
    ${payments.length > 0 && html`<div class="list sd-ruled">
      ${payments.map((entry) => html`<div key=${entry.id} class="list-item">
        <div class="list-main">
          <div class="list-title">${formatDate(entry.paid_at)} · ${PAYMENT_METHODS[entry.method] ?? 'Other'}</div>
          ${entry.note && html`<div class="list-sub">${entry.note}</div>`}
        </div>
        <div class="list-aside">
          ${entry.amount < 0 && html`<span class="pill pill-loss">Refund</span> `}
          <${Money} value=${entry.amount} tone=${entry.amount < 0 ? 'loss' : undefined} />
        </div>
        <${Button}
          kind="ghost"
          icon="trash"
          aria-label=${`Remove the ${money(Math.abs(entry.amount))} ${entry.amount < 0 ? 'refund' : 'payment'}`}
          onClick=${() => remove(entry)}
        />
      </div>`)}
    </div>`}
  <//>`;
}

// ---------------------------------------------------------------------------------------------
// Drives
// ---------------------------------------------------------------------------------------------

function TripsCard({ deal, totals, onLog, onEdit }) {
  const trips = deal.trips ?? [];
  const suggested = DRIVEN_DELIVERY.has(deal.delivery_method) && trips.length === 0;
  return html`<${Card}
    pad=${false}
    title="Drives"
    subtitle=${trips.length
      ? `${formatMiles(totals.miles)} · ${duration(totals.drivingMinutes)} driving · ${money(totals.travelCost)} travel`
      : null}
    actions=${html`<${Button} kind=${suggested ? 'secondary' : 'ghost'} size="sm" icon="car" onClick=${onLog}>Log drive<//>`}
  >
    ${trips.length === 0
      ? html`<p class="sd-empty">${suggested
        ? 'Log the drop-off to count the fuel and your time against this sale, and see what it made per hour.'
        : 'Drove for this sale? Log it to count the fuel and your time.'}</p>`
      : html`<div class="list">
          ${trips.map((trip) => {
            const t = tripTotals(trip);
            const legs = t.miles > num(trip.one_way_miles) ? 'round trip' : 'one way';
            return html`<div key=${trip.id} class="sd-line">
              <button type="button" class="sd-line-main" onClick=${() => onEdit(trip)}>
                <span class="sd-line-text">
                  <span class="sd-line-title">${trip.label || tripRoute(trip)}</span>
                  <span class="sd-line-sub">${formatDate(trip.trip_date)} · ${formatMiles(t.miles)} ${legs} · ${duration(t.totalMinutes)}</span>
                </span>
                <span class="sd-line-aside">
                  <${Money} value=${t.cashCost} />
                  <span class="sd-line-sub">${t.timeCost > 0 ? `+ ${money(t.timeCost)} time` : 'travel'}</span>
                </span>
                <${Icon} name="chevron-right" size=${18} class="sd-line-chev" />
              </button>
            </div>`;
          })}
        </div>`}
  <//>`;
}

// ---------------------------------------------------------------------------------------------
// Details and editing them
// ---------------------------------------------------------------------------------------------

function DetailsCard({ deal, client, onEdit }) {
  const open = !DONE_STATUSES.has(deal.status) && deal.status !== 'cancelled';
  const overdue = open && deal.due_date && deal.due_date < todayISO();
  const destination = DRIVEN_DELIVERY.has(deal.delivery_method) ? clientDestination(client) : null;
  return html`<${Card}
    title="Details"
    actions=${html`<${Button} kind="ghost" size="sm" icon="edit" onClick=${onEdit}>Edit<//>`}
  >
    <div class="stack">
      <dl class="kv">
        ${deal.title && html`<div><dt>Title</dt><dd class="wrap">${deal.title}</dd></div>`}
        <div><dt>Sale date</dt><dd>${formatDate(deal.sale_date)}</dd></div>
        <div>
          <dt>Deliver by</dt>
          <dd class=${cx(overdue && 'tone-loss')}>
            ${deal.due_date ? html`${formatDate(deal.due_date)}${open ? ` · ${relDays(deal.due_date)}` : ''}` : '—'}
          </dd>
        </div>
        <div><dt>Delivery</dt><dd>${DELIVERY_METHODS[deal.delivery_method] ?? '—'}</dd></div>
        ${destination && html`<div>
          <dt class="nowrap">Deliver to</dt>
          <dd class="wrap">${destination.label}${destination.address ? html`<div class="small muted">${destination.address}</div>` : ''}</dd>
        </div>`}
        ${deal.notes && html`<div><dt>Notes</dt><dd class="wrap" style="white-space:pre-wrap">${deal.notes}</dd></div>`}
      </dl>
      <p class="tiny faint">
        Created ${formatDate(deal.created_at)}${deal.updated_at && deal.updated_at !== deal.created_at ? ` · updated ${formatDate(deal.updated_at)}` : ''}
      </p>
    </div>
  <//>`;
}

function DetailsModal({ store, deal, onClose }) {
  const { data: clients, error: clientsError, reload } = useStoreData(store, (s) => s.clients.list({ includeArchived: true }));
  const [form, setForm] = useState(() => ({
    client_id: deal.client_id ?? '',
    title: deal.title ?? '',
    sale_date: deal.sale_date ?? todayISO(),
    due_date: deal.due_date ?? '',
    delivery_method: deal.delivery_method ?? 'drop_off',
    notes: deal.notes ?? '',
  }));
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const errors = {
    sale_date: form.sale_date ? null : 'Enter the sale date.',
    due_date: form.due_date && form.sale_date && form.due_date < form.sale_date ? "Can't be before the sale date." : null,
  };
  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.currentTarget.value }));

  async function save() {
    if (saving) return;
    setShowErrors(true);
    if (errors.sale_date || errors.due_date) return;
    setSaving(true);
    try {
      const nextClient = form.client_id || null;
      const prevClient = deal.client_id ?? null;
      await store.deals.update(deal.id, { ...form, client_id: nextClient });
      // Drives copied from the old client follow the sale to the new one; drives tagged to
      // someone else on purpose stay as they are.
      if (nextClient !== prevClient && prevClient !== null) {
        for (const trip of deal.trips ?? []) {
          if ((trip.client_id ?? null) === prevClient) await store.trips.update(trip.id, { client_id: nextClient });
        }
      }
      toast('Sale updated.', { tone: 'gain' });
      onClose();
    } catch (err) {
      toast(err, { tone: 'loss' });
      setSaving(false);
    }
  }

  const close = () => {
    if (!saving) onClose();
  };
  const footer = html`
    <${Button} kind="ghost" onClick=${close} disabled=${saving}>Cancel<//>
    <${Button} kind="primary" icon="check" loading=${saving} onClick=${save}>Save changes<//>`;

  let picker;
  if (clients) {
    picker = html`<${ClientPicker}
      store=${store}
      clients=${clients}
      value=${form.client_id}
      onChange=${(id) => setForm((current) => ({ ...current, client_id: id }))}
    />`;
  } else if (clientsError) {
    picker = html`<${ErrorState} error=${clientsError} title="Couldn't load your clients" onRetry=${reload} />`;
  } else {
    picker = html`<${Loading} label="Loading clients…" />`;
  }

  return html`<${Modal} title=${`Edit ${dealNumber(deal.number)}`} onClose=${close} footer=${footer}>
    <div class="stack">
      ${picker}
      <div class="fields">
        <${Field} label="Sale date" required error=${showErrors && errors.sale_date}>
          <${Input} type="date" value=${form.sale_date} onInput=${set('sale_date')} />
        <//>
        <${Field} label="Deliver by" error=${showErrors && errors.due_date}>
          <${Input} type="date" value=${form.due_date} onInput=${set('due_date')} />
        <//>
        <${Field} label="How it gets to them" class="span-all">
          <${Select} options=${DELIVERY_OPTIONS} value=${form.delivery_method} onChange=${set('delivery_method')} />
        <//>
        <${Field} label="Title" class="span-all">
          <${Input} autocomplete="off" placeholder="e.g. Match-day boots for Saturday" value=${form.title} onInput=${set('title')} />
        <//>
        <${Field} label="Notes" class="span-all">
          <${Textarea} value=${form.notes} onInput=${set('notes')} />
        <//>
      </div>
    </div>
  <//>`;
}

// ---------------------------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------------------------

function SaleDetail({ store, navigate, deal, client, settings, refreshError, onRetry }) {
  const totals = useMemo(() => dealTotals(deal), [deal]);
  const number = dealNumber(deal.number);
  const [pendingStatus, setPendingStatus] = useState(null);
  const [itemSheet, setItemSheet] = useState(null); // { item } (item null = new)
  const [costSheet, setCostSheet] = useState(null); // { cost, confirm } (cost null = new)
  const [markBought, setMarkBought] = useState(null); // item
  const [tripDialog, setTripDialog] = useState(null); // { trip } (trip null = new drive)
  const [editingDetails, setEditingDetails] = useState(false);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const barRef = useRef(null);
  const readyToastRef = useRef(null); // dismisses the "Set ready to deliver" toast
  const latestRef = useRef(null); // the newest status and changeStatus, for toast buttons
  useFormBarHeight(barRef);

  // The status picker shows the new status straight away and settles once the sale reloads.
  // A status change also retires any older toast offering to change it again.
  useEffect(() => {
    setPendingStatus(null);
    readyToastRef.current?.();
    readyToastRef.current = null;
  }, [deal.status]);
  useEffect(() => () => readyToastRef.current?.(), []);

  const openTrip = (trip = null) => setTripDialog({ trip });

  async function changeStatus(next, select) {
    const current = pendingStatus ?? deal.status;
    const undoPick = () => {
      if (select) select.value = current;
    };
    if (!statusMeta[next] || next === current) return;
    if (next === 'cancelled') {
      const ok = await confirmDialog({
        title: `Cancel ${number}?`,
        body: 'It stays in your records but is left out of every total, and anything it took from stock goes back into stock.',
        confirmLabel: 'Cancel sale',
        cancelLabel: 'Keep it',
        danger: true,
      });
      if (!ok) {
        undoPick();
        return;
      }
    }
    // Reopening takes its stock back: warn when another sale has had it since.
    if (current === 'cancelled' && (deal.items ?? []).some((item) => item.stock_item_id)) {
      try {
        const [stock, deals] = await Promise.all([store.stock.list({ includeArchived: true }), store.deals.list()]);
        const levels = stockLevels(stock, deals.map((entry) => (entry.id === deal.id ? { ...entry, status: next } : entry)));
        const gone = (deal.items ?? []).filter((item) => item.stock_item_id && (levels.get(item.stock_item_id)?.onHand ?? 0) < 0);
        if (gone.length) {
          const names = gone.map((item) => item.description).join(', ');
          const ok = await confirmDialog({
            title: `Reopen ${number}?`,
            body: `${names} has since gone to another sale. Reopen anyway? Stock will show as oversold — edit the line to "Need to buy" if you'll have to buy another.`,
            confirmLabel: 'Reopen anyway',
            cancelLabel: 'Keep it cancelled',
          });
          if (!ok) {
            undoPick();
            return;
          }
        }
      } catch (err) {
        toast(`Couldn't check your stock (${err.message}). Check the Stock page after reopening.`, { tone: 'warn' });
      }
    }
    setPendingStatus(next);
    try {
      await store.deals.update(deal.id, { status: next });
      const offerDrive = next === 'delivered' && DRIVEN_DELIVERY.has(deal.delivery_method) && (deal.trips ?? []).length === 0;
      toast(`${number} is now ${statusMeta[next].label.toLowerCase()}.`, {
        tone: 'gain',
        action: offerDrive ? { label: 'Log drive', onClick: () => openTrip() } : undefined,
      });
    } catch (err) {
      setPendingStatus(null);
      undoPick();
      toast(err, { tone: 'loss' });
    }
  }
  latestRef.current = { status: pendingStatus ?? deal.status, changeStatus };

  function onBought(item, variance) {
    setMarkBought(null);
    const stillToBuy = itemsToBuy(deal).filter((entry) => entry.id !== item.id).length;
    const ready = stillToBuy === 0 && (deal.status === 'agreed' || deal.status === 'sourcing');
    readyToastRef.current?.();
    readyToastRef.current = toast(`Marked bought. ${varianceText(variance) ?? ''}`.trim(), {
      tone: 'gain',
      action: ready
        ? {
          label: 'Set ready to deliver',
          onClick: () => {
            // Acts on the sale as it is now, not as it was when the toast appeared.
            const { status, changeStatus: go } = latestRef.current;
            if (status === 'agreed' || status === 'sourcing') go('ready');
          },
        }
        : undefined,
    });
  }

  async function saveTrip(planned, existing) {
    if (existing) await store.trips.update(existing.id, planned);
    else await store.trips.create({ ...planned, deal_id: deal.id, client_id: deal.client_id ?? null });
    setTripDialog(null);
    const t = tripTotals(planned);
    toast(
      `${existing ? 'Drive updated' : 'Drive logged'} — ${formatMiles(t.miles)}, ${money(t.cashCost)} travel, ${duration(t.totalMinutes)} of your time.`,
      { tone: 'gain' },
    );
  }

  async function deleteTrip(trip) {
    const ok = await confirmDialog({
      title: 'Delete this drive?',
      body: "Its fuel and time come off this sale's profit, and it's removed from Trips.",
      confirmLabel: 'Delete drive',
      danger: true,
    });
    if (!ok) return;
    try {
      await store.trips.remove(trip.id);
      setTripDialog(null);
      toast('Drive deleted.');
    } catch (err) {
      toast(err, { tone: 'loss' });
    }
  }

  async function deleteSale() {
    const items = deal.items ?? [];
    const parts = [
      items.length && plural(items.length, 'item'),
      (deal.costs ?? []).length && plural(deal.costs.length, 'extra cost'),
      (deal.payments ?? []).length && plural(deal.payments.length, 'payment'),
    ].filter(Boolean);
    const trips = (deal.trips ?? []).length;
    const listed = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
    const body = [
      `This permanently deletes ${number}${listed ? ` with its ${listed}` : ''}.`,
      trips ? `${trips === 1 ? 'Its logged drive stays' : `Its ${trips} logged drives stay`} in Trips, no longer linked to a sale.` : '',
      items.some((item) => item.stock_item_id) ? 'Items taken from stock go back into stock.' : '',
      "This can't be undone.",
    ].filter(Boolean).join(' ');
    const ok = await confirmDialog({ title: `Delete ${number}?`, body, confirmLabel: 'Delete sale', danger: true });
    if (!ok) return;
    try {
      await store.deals.remove(deal.id);
      toast(`${number} deleted.`);
      navigate('#/sales', { replace: true });
    } catch (err) {
      toast(err, { tone: 'loss' });
    }
  }

  function runStep(action) {
    switch (action.kind) {
      case 'status':
        changeStatus(action.status);
        break;
      case 'add-item':
        setItemSheet({ item: null });
        break;
      case 'bought':
        setMarkBought(action.item);
        break;
      case 'cost':
        setCostSheet({ cost: action.cost, confirm: true });
        break;
      case 'payment':
        setPaymentOpen(true);
        break;
      default:
        break;
    }
  }

  const step = deal.status === pendingStatus || pendingStatus === null ? nextStep(deal, totals) : null;
  const meta = html`<span class="mono">${number}</span>${deal.client?.club ? ` · ${deal.client.club}` : ''} · Sold ${formatDate(deal.sale_date)}`;
  const title = deal.client?.name ?? deal.title ?? number;

  return html`<${Page} title=${title} subtitle=${meta} back="#/sales">
    ${refreshError && html`<${Banner}
      tone="warn"
      title="Couldn't refresh this sale"
      actions=${html`<${Button} size="sm" onClick=${onRetry}>Try again<//>`}
    >${refreshError.message}<//>`}

    <${SummaryCard}
      deal=${deal}
      totals=${totals}
      settings=${settings}
      status=${pendingStatus ?? deal.status}
      statusBusy=${pendingStatus !== null}
      onStatus=${changeStatus}
      step=${step}
      onStep=${() => step && runStep(step.action)}
    />

    <${ItemsCard}
      deal=${deal}
      totals=${totals}
      onAdd=${() => setItemSheet({ item: null })}
      onEdit=${(item) => setItemSheet({ item })}
      onMarkBought=${setMarkBought}
    />

    <div class="grid cols-2">
      <${PaymentsCard} store=${store} deal=${deal} totals=${totals} onRecord=${() => setPaymentOpen(true)} />
      <${ContactCard} deal=${deal} client=${client} totals=${totals} />
    </div>

    <div class="grid cols-2">
      <${CostsCard}
        deal=${deal}
        totals=${totals}
        onAdd=${() => setCostSheet({ cost: null, confirm: false })}
        onEdit=${(cost, confirm) => setCostSheet({ cost, confirm })}
      />
      <${TripsCard} deal=${deal} totals=${totals} onLog=${() => openTrip()} onEdit=${openTrip} />
    </div>

    <${DetailsCard} deal=${deal} client=${client} onEdit=${() => setEditingDetails(true)} />

    <div class="row row-end">
      <${Button} kind="ghost" icon="trash" onClick=${deleteSale}>Delete sale<//>
    </div>

    ${step && html`<div class="form-bar sf-bar sd-bar" ref=${barRef}>
      <div class="form-bar-summary">
        <span class="sf-bar-main">${step.title}</span>
        <span class="sf-bar-sub">${step.text}</span>
      </div>
      <${Button} kind="primary" onClick=${() => runStep(step.action)}>${step.label}<//>
    </div>`}

    ${itemSheet && html`<${ItemSheet} store=${store} deal=${deal} item=${itemSheet.item} onClose=${() => setItemSheet(null)} />`}
    ${costSheet && html`<${CostSheet}
      store=${store}
      deal=${deal}
      cost=${costSheet.cost}
      startConfirmed=${costSheet.confirm}
      onClose=${() => setCostSheet(null)}
    />`}
    ${paymentOpen && html`<${PaymentSheet}
      store=${store}
      deal=${deal}
      balance=${totals.balance}
      paid=${totals.paid}
      onClose=${() => setPaymentOpen(false)}
    />`}
    ${markBought && html`<${MarkBoughtModal}
      store=${store}
      item=${markBought}
      onClose=${() => setMarkBought(null)}
      onBought=${(variance) => onBought(markBought, variance)}
    />`}
    ${tripDialog && html`<${TripModal}
      store=${store}
      settings=${settings}
      title=${tripDialog.trip ? 'Edit drive' : `Log drive · ${number}`}
      trip=${tripDialog.trip}
      initialOrigin=${tripDialog.trip ? tripEnd(tripDialog.trip, 'origin') : homeLocation(settings)}
      initialDestination=${tripDialog.trip ? tripEnd(tripDialog.trip, 'dest') : clientDestination(client)}
      onSave=${(planned) => saveTrip(planned, tripDialog.trip)}
      onDelete=${tripDialog.trip ? () => deleteTrip(tripDialog.trip) : undefined}
      onClose=${() => setTripDialog(null)}
    />`}
    ${editingDetails && html`<${DetailsModal} store=${store} deal=${deal} onClose=${() => setEditingDetails(false)} />`}
  <//>`;
}

export default function DealView({ store, params, navigate }) {
  const id = params.id;
  const { data, error, loading, reload } = useStoreData(store, (s) => loadSale(s, id), [id]);

  if (loading) {
    return html`<${Page} title="Sale" back="#/sales"><${Loading} label="Loading sale…" /><//>`;
  }
  if (error && !data) {
    return html`<${Page} title="Sale" back="#/sales">
      <${Card}><${ErrorState} error=${error} title="Couldn't load this sale" onRetry=${reload} /><//>
    <//>`;
  }
  if (!data?.deal) {
    return html`<${Page} title="Sale not found" back="#/sales">
      <${Card}>
        <${Empty}
          icon="search"
          title="This sale doesn't exist"
          body="It may have been deleted, or the link is wrong."
          action=${html`<${Button} href="#/sales">Back to sales<//>`}
        />
      <//>
    <//>`;
  }
  return html`<${SaleDetail}
    store=${store}
    navigate=${navigate}
    deal=${data.deal}
    client=${data.client}
    settings=${data.settings}
    refreshError=${error}
    onRetry=${reload}
  />`;
}

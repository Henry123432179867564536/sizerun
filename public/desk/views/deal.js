// Sale detail (#/sales/:id) — docs/desk-spec.md §7 "Views".
//
// One sale end to end: the profit breakdown (the hero), its items with inline editing and
// "Mark bought", extra costs, payments and the balance, the drives behind it (logged with the
// trip planner), notes, and the controls that move it along — status, edit and delete.
// Every figure comes from calc.dealTotals(); the editing pieces are shared with the New sale
// form in views/deals.js.

import { html, useEffect, useMemo, useRef, useState } from '../lib/preact.js';
import {
  Badge,
  Banner,
  Button,
  Card,
  Empty,
  ErrorState,
  Field,
  Input,
  Loading,
  Modal,
  Money,
  Page,
  Segmented,
  Select,
  Stat,
  Switch,
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
  FIELD_GRID,
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
} from './deals.js';

// Padding for a section inside a flush (pad=false) card.
const SECTION = 'padding:12px 16px';
const SECTION_RULED = `${SECTION};border-top:1px solid var(--line)`;
const DONE_STATUSES = new Set(['delivered', 'completed']);
const PAYMENTS_ID = 'sale-payments';

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

/** Enter in a text box saves an inline editor (the page has no form to submit). */
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

function signTone(value) {
  if (value >= EPS) return 'gain';
  if (value <= -EPS) return 'loss';
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Hero: profit and where it went
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

function EstimateList({ deal, onMarkBought, onConfirmCost }) {
  const items = itemsToBuy(deal);
  const costs = (deal.costs ?? []).filter((cost) => cost.is_expected);
  return html`<${Banner} tone="warn" title="Estimated profit">
    <div class="stack-sm">
      <span>Profit firms up as you confirm ${items.length + costs.length === 1 ? 'this' : 'these'}:</span>
      ${items.map((item) => html`<div key=${item.id} class="row row-between">
        <span class="wrap-anywhere" style="flex:1 1 140px">
          ${item.description}${num(item.qty) > 1 ? ` ×${num(item.qty)}` : ''} — expected
          ${' '}<span class="num">${money(num(item.expected_unit_cost) * num(item.qty))}</span>
        </span>
        <${Button} size="sm" onClick=${() => onMarkBought(item)}>Mark bought<//>
      </div>`)}
      ${costs.map((cost) => html`<div key=${cost.id} class="row row-between">
        <span class="wrap-anywhere" style="flex:1 1 140px">
          ${cost.label} — estimate <span class="num">${money(cost.amount)}</span>
        </span>
        <${Button} size="sm" onClick=${() => onConfirmCost(cost)}>Confirm<//>
      </div>`)}
    </div>
  <//>`;
}

function ProfitHero({ deal, totals, settings, onMarkBought, onConfirmCost }) {
  const bucket = bucketMeta[totals.bucket] ?? bucketMeta.pending;
  const cancelled = totals.bucket === 'cancelled';
  const target = num(settings?.target_margin);
  const rate = totals.totalMinutes > 0 ? totals.timeCost / (totals.totalMinutes / 60) : 0;
  const underTarget = target > 0 && totals.margin !== null && totals.netProfit < target * totals.revenue - EPS;
  return html`<${Card}
    title="Profit"
    subtitle=${bucketReason(deal, totals)}
    actions=${html`<${Badge} tone=${bucket.tone}>${bucket.label}<//>`}
  >
    <div class="grid cols-2">
      <div class="stack">
        <div class="kpis" style="grid-template-columns:repeat(2,minmax(0,1fr))">
          <${Stat}
            label="Profit"
            value=${money(totals.netProfit)}
            tone=${cancelled ? undefined : signTone(totals.netProfit)}
            sub=${totals.certainty === 'estimated' ? 'Estimated' : 'Confirmed'}
          />
          <${Stat}
            label="After your time"
            value=${totals.totalMinutes > 0 ? money(totals.trueProfit) : '—'}
            tone=${cancelled || totals.totalMinutes === 0 ? undefined : signTone(totals.trueProfit)}
            sub=${totals.totalMinutes > 0 ? `${duration(totals.totalMinutes)} at ${money(rate)}/h` : 'No drive logged'}
          />
          <${Stat}
            label="Per driving hour"
            value=${totals.perDrivingHour === null ? '—' : money(totals.perDrivingHour)}
            tone=${totals.perDrivingHour === null || cancelled ? undefined : signTone(totals.perDrivingHour)}
            sub=${totals.drivingMinutes > 0 ? `${duration(totals.drivingMinutes)} driving` : 'Log a drive to see it'}
          />
          <${Stat}
            label="Margin"
            value=${pct(totals.margin)}
            tone=${underTarget && !cancelled ? 'warn' : undefined}
            sub=${target > 0 ? `Target ${pct(target)}` : null}
          />
        </div>
        ${totals.certainty === 'estimated' && !cancelled && html`<${EstimateList}
          deal=${deal}
          onMarkBought=${onMarkBought}
          onConfirmCost=${onConfirmCost}
        />`}
      </div>
      <${ProfitBreakdown} totals=${totals} targetMargin=${target} perHour=${false} />
    </div>
  <//>`;
}

// ---------------------------------------------------------------------------------------------
// Next step: the one thing that moves this sale along
// ---------------------------------------------------------------------------------------------

function nextStep(deal, totals) {
  if ((deal.items ?? []).length === 0) {
    return { title: 'Add what you sold', text: 'This sale has no items yet.', label: 'Add item', action: { kind: 'add-item' } };
  }
  const toBuy = itemsToBuy(deal);
  switch (deal.status) {
    case 'enquiry':
      return { title: 'Still an enquiry', text: "Once they've said yes, mark it agreed.", label: 'Mark agreed', action: { kind: 'status', status: 'agreed' } };
    case 'agreed':
    case 'sourcing':
      // Items still to buy are listed, with "Mark bought", in the profit card's estimate list.
      if (toBuy.length > 0) return null;
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
        title: `${money(totals.balance)} still to come in`,
        text: 'Record the payment when it lands.',
        label: 'Record payment',
        action: { kind: 'payment' },
      };
    default:
      return null; // completed or cancelled
  }
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
  return [pill, detail && html`<span class="tiny faint">${detail}</span>`];
}

function ItemRow({ item, onEdit, onRemove, onMarkBought }) {
  const line = itemTotals(item);
  const details = [item.brand, item.size, item.sku].filter(Boolean).join(' · ');
  return html`<tr>
    <td class="cell-primary">
      <div class="strong wrap-anywhere">${item.description}</div>
      ${details && html`<div class="small muted" style="font-weight:400">${details}</div>`}
      <div class="row" style="gap:4px 6px;margin-top:4px;font-weight:400">${sourceBadge(item)}</div>
    </td>
    <td data-label="Qty" class="num">${num(item.qty)}</td>
    <td data-label="Price each" class="num">${money(item.unit_price)}</td>
    <td data-label="Cost each" class="num">
      ${money(itemCost(item))}${line.isExpected && html` <span class="pill pill-warn">est.</span>`}
      ${line.variance !== null && Math.abs(line.variance) >= EPS && html`<div class=${cx('tiny', line.variance > 0 ? 'tone-gain' : 'tone-loss')}>
        ${money(Math.abs(line.variance))} ${line.variance > 0 ? 'under' : 'over'} expected
      </div>`}
    </td>
    <td data-label="Line profit" class="num"><${Money} value=${line.revenue - line.cost} tone="auto" /></td>
    <td class="cell-actions">
      <div class="row row-end row-nowrap" style="gap:4px">
        ${line.isExpected && html`<${Button} kind="primary" size="sm" onClick=${onMarkBought}>Mark bought<//>`}
        <${Button} kind="ghost" size="sm" icon="edit" aria-label=${`Edit ${item.description}`} onClick=${onEdit} />
        <${Button} kind="ghost" size="sm" icon="trash" aria-label=${`Remove ${item.description}`} onClick=${onRemove} />
      </div>
    </td>
  </tr>`;
}

// Inline editor for an existing item (or a new one when `item` is null).
function ItemEditor({ store, deal, item, onDone }) {
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
    setSaving(true);
    const row = itemRowFromDraft(draft, new Map(choices.map((choice) => [choice.stock.id, choice.stock])));
    try {
      if (item) await store.items.update(item.id, row);
      else await store.items.create(deal.id, row);
      toast(item ? 'Item updated.' : 'Item added.', { tone: 'gain' });
      onDone();
    } catch (err) {
      toast(err, { tone: 'loss' });
      setSaving(false);
    }
  }

  return html`<div class="stack" ref=${boxRef} onKeyDown=${enterSaves(save)}>
    <${ItemFields}
      draft=${draft}
      title=${item ? 'Edit item' : 'New item'}
      errors=${showErrors ? problems : {}}
      stockChoices=${choices}
      maxQty=${maxQty}
      onChange=${(patch) => setDraft((current) => ({ ...current, ...patch }))}
    />
    ${stockError && draft.source === 'stock' && html`<p class="small tone-warn">Couldn't load your stock: ${stockError.message}</p>`}
    <div class="row">
      <${Button} kind="primary" size="sm" icon="check" loading=${saving} onClick=${save}>${item ? 'Save item' : 'Add item'}<//>
      <${Button} kind="ghost" size="sm" onClick=${onDone} disabled=${saving}>Cancel<//>
    </div>
  </div>`;
}

function ItemsCard({ store, deal, totals, editing, setEditing, onMarkBought }) {
  const items = deal.items ?? [];
  const units = items.reduce((sum, item) => sum + num(item.qty), 0);

  async function remove(item) {
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
    } catch (err) {
      toast(err, { tone: 'loss' });
    }
  }

  const editorRow = (item) => html`<tr key=${`edit-${item?.id ?? 'new'}`}>
    <td colspan="6" style="padding-top:14px;padding-bottom:16px">
      <${ItemEditor} store=${store} deal=${deal} item=${item} onDone=${() => setEditing(null)} />
    </td>
  </tr>`;

  return html`<${Card}
    pad=${false}
    title="Items"
    subtitle=${items.length ? `${plural(units, 'item')} · ${money(totals.revenue)} sale · ${money(totals.goodsCost)} cost` : null}
    actions=${editing !== 'new' && html`<${Button} size="sm" icon="plus" onClick=${() => setEditing('new')}>Add item<//>`}
  >
    ${items.length === 0 && editing !== 'new'
      ? html`<${Empty}
          icon="tag"
          title="No items on this sale"
          body="Add what they're buying so Desk can work out the profit."
          action=${html`<${Button} kind="primary" icon="plus" onClick=${() => setEditing('new')}>Add item<//>`}
        />`
      : html`<div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col" class="num">Qty</th>
                <th scope="col" class="num">Price each</th>
                <th scope="col" class="num">Cost each</th>
                <th scope="col" class="num">Line profit</th>
                <th scope="col"><span class="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              ${items.map((item) => (editing === item.id
                ? editorRow(item)
                : html`<${ItemRow}
                    key=${item.id}
                    item=${item}
                    onEdit=${() => setEditing(item.id)}
                    onRemove=${() => remove(item)}
                    onMarkBought=${() => onMarkBought(item)}
                  />`))}
              ${editing === 'new' && editorRow(null)}
            </tbody>
          </table>
        </div>`}
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
      <p class="muted">
        <span class="strong" style="color:var(--ink)">${item.description}${qty > 1 ? ` ×${qty}` : ''}</span>
        ${' '}— you expected to pay ${money(item.expected_unit_cost)}${qty > 1 ? ' each' : ''}.
      </p>
      <div style=${FIELD_GRID}>
        <${Field} label="Paid each" required error=${showErrors && costError}>
          <${Input} prefix="£" inputmode="decimal" autocomplete="off" autofocus value=${cost} onInput=${(event) => setCost(event.currentTarget.value)} />
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

function CostEditor({ store, deal, cost, startConfirmed, onDone }) {
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
      onDone();
    } catch (err) {
      toast(err, { tone: 'loss' });
      setSaving(false);
    }
  }

  return html`<div class="stack-sm" style=${SECTION_RULED} ref=${boxRef} onKeyDown=${enterSaves(save)}>
    <${CostFields}
      draft=${draft}
      title=${cost ? 'Edit cost' : 'New cost'}
      errors=${showErrors ? problems : {}}
      onChange=${(patch) => setDraft((current) => ({ ...current, ...patch }))}
    />
    <div class="row">
      <${Button} kind="primary" size="sm" icon="check" loading=${saving} onClick=${save}>${cost ? 'Save cost' : 'Add cost'}<//>
      <${Button} kind="ghost" size="sm" onClick=${onDone} disabled=${saving}>Cancel<//>
    </div>
  </div>`;
}

// 'Shipping · estimate', leaving out the type when the cost is already named after it.
function costSub(cost) {
  const kind = COST_KINDS[cost.kind] ?? COST_KINDS.other;
  return [cost.label !== kind && kind, cost.is_expected && 'estimate'].filter(Boolean).join(' · ');
}

function CostsCard({ store, deal, totals, editing, setEditing }) {
  const costs = deal.costs ?? [];

  async function remove(cost) {
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
    } catch (err) {
      toast(err, { tone: 'loss' });
    }
  }

  return html`<${Card}
    pad=${false}
    title="Extra costs"
    subtitle=${costs.length ? `${money(totals.extraCosts)} in total` : 'Postage, fees, packaging…'}
    actions=${editing?.id !== 'new' && html`<${Button} size="sm" icon="plus" onClick=${() => setEditing({ id: 'new' })}>Add cost<//>`}
  >
    ${costs.length === 0 && editing?.id !== 'new' && html`<p class="small muted" style=${SECTION}>
      No extra costs. Add postage, fees or packaging so the profit is right.
    </p>`}
    ${costs.length > 0 && html`<div class="list">
      ${costs.map((cost) => (editing?.id === cost.id
        ? html`<${CostEditor}
            key=${`edit-${cost.id}`}
            store=${store}
            deal=${deal}
            cost=${cost}
            startConfirmed=${editing.confirm}
            onDone=${() => setEditing(null)}
          />`
        : html`<div key=${cost.id} class="list-item">
            <div class="list-main">
              <div class="list-title">${cost.label}</div>
              ${costSub(cost) && html`<div class="list-sub">${costSub(cost)}</div>`}
            </div>
            <div class="list-aside">
              <${Money} value=${cost.amount} />${cost.is_expected && html` <span class="pill pill-warn">est.</span>`}
            </div>
            <div class="row row-nowrap" style="gap:2px">
              <${Button} kind="ghost" size="sm" icon="edit" aria-label=${`Edit ${cost.label}`} onClick=${() => setEditing({ id: cost.id })} />
              <${Button} kind="ghost" size="sm" icon="trash" aria-label=${`Remove ${cost.label}`} onClick=${() => remove(cost)} />
            </div>
          </div>`))}
    </div>`}
    ${editing?.id === 'new' && html`<${CostEditor} store=${store} deal=${deal} cost=${null} onDone=${() => setEditing(null)} />`}
  <//>`;
}

// ---------------------------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------------------------

function lastMethod(deal) {
  const payments = deal.payments ?? [];
  return payments.length ? payments[payments.length - 1].method : 'bank';
}

function PaymentForm({ store, deal, balance, onDone }) {
  const boxRef = useRef(null);
  const [amount, setAmount] = useState(balance > EPS ? amountText(round2(balance)) : '');
  const [method, setMethod] = useState(() => lastMethod(deal));
  const [paidAt, setPaidAt] = useState(todayISO());
  const [note, setNote] = useState('');
  const [refund, setRefund] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const value = parseAmount(amount);
  const amountError = amountProblem(amount, { what: refund ? 'the refund' : 'the amount paid', allowZero: false });
  const dateError = paidAt ? null : 'Enter the payment date.';
  const over = !refund && !amountError && value > balance + EPS
    ? `That's ${money(value - Math.max(0, balance))} more than the balance.`
    : null;

  useEffect(() => {
    boxRef.current?.querySelector('input')?.focus();
  }, []);

  async function save() {
    if (saving) return;
    setShowErrors(true);
    if (amountError || dateError) {
      revealFirstError(boxRef.current);
      return;
    }
    setSaving(true);
    try {
      await store.payments.create(deal.id, { amount: refund ? -value : value, method, paid_at: paidAt, note: note.trim() || null });
      toast(`${refund ? 'Refund' : 'Payment'} of ${money(value)} recorded.`, { tone: 'gain' });
      onDone();
    } catch (err) {
      toast(err, { tone: 'loss' });
      setSaving(false);
    }
  }

  return html`<div class="stack-sm" style=${SECTION_RULED} ref=${boxRef} onKeyDown=${enterSaves(save)}>
    <span class="strong">${refund ? 'Record a refund' : 'Record a payment'}</span>
    <div style=${FIELD_GRID}>
      <${Field} label="Amount" required error=${showErrors && amountError} hint=${over}>
        <${Input} prefix="£" inputmode="decimal" autocomplete="off" placeholder="0.00" value=${amount} onInput=${(event) => setAmount(event.currentTarget.value)} />
      <//>
      <${Field} label="Date" required error=${showErrors && dateError}>
        <${Input} type="date" value=${paidAt} onInput=${(event) => setPaidAt(event.currentTarget.value)} />
      <//>
    </div>
    <div class="field">
      <span class="field-label" aria-hidden="true">Paid by</span>
      <${Segmented} full label="Paid by" options=${PAYMENT_METHOD_OPTIONS} value=${method} onChange=${setMethod} />
    </div>
    <${Field} label="Note">
      <${Input} autocomplete="off" placeholder="e.g. Deposit" value=${note} onInput=${(event) => setNote(event.currentTarget.value)} />
    <//>
    <${Switch} checked=${refund} onChange=${setRefund} label="This is a refund" hint="Money you paid back to the client." />
    <div class="row">
      <${Button} kind="primary" size="sm" icon="check" loading=${saving} onClick=${save}>Save ${refund ? 'refund' : 'payment'}<//>
      <${Button} kind="ghost" size="sm" onClick=${onDone} disabled=${saving}>Cancel<//>
    </div>
  </div>`;
}

function PaymentsCard({ store, deal, totals, formOpen, setFormOpen }) {
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
    <div class="stack-sm" style=${SECTION}>
      <div class="row row-between">
        <span class="muted">${balanceLabel}</span>
        ${Math.abs(balance) > EPS && html`<span class="strong" style="font-size:20px"><${Money} value=${Math.abs(balance)} tone=${balanceTone} /></span>`}
      </div>
      ${!formOpen && !cancelled && html`<div class="row">
        ${balance > EPS && html`<${Button} kind="primary" size="sm" icon="check" loading=${paying} onClick=${paidInFull}>
          Paid in full · ${money(balance)}
        <//>`}
        <${Button} size="sm" icon="plus" onClick=${() => setFormOpen(true)}>Record payment<//>
      </div>`}
    </div>
    ${formOpen && html`<${PaymentForm} store=${store} deal=${deal} balance=${balance} onDone=${() => setFormOpen(false)} />`}
    ${payments.length > 0 && html`<div class="list" style="border-top:1px solid var(--line)">
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
          size="sm"
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

function TripsCard({ store, deal, totals, onLog, onEdit }) {
  const trips = deal.trips ?? [];
  const suggested = DRIVEN_DELIVERY.has(deal.delivery_method) && trips.length === 0;

  async function remove(trip) {
    const ok = await confirmDialog({
      title: 'Delete this drive?',
      body: "Its fuel and time come off this sale's profit, and it's removed from Trips.",
      confirmLabel: 'Delete drive',
      danger: true,
    });
    if (!ok) return;
    try {
      await store.trips.remove(trip.id);
      toast('Drive deleted.');
    } catch (err) {
      toast(err, { tone: 'loss' });
    }
  }

  return html`<${Card}
    pad=${false}
    title="Drives"
    subtitle=${trips.length
      ? `${formatMiles(totals.miles)} · ${duration(totals.drivingMinutes)} driving · ${money(totals.travelCost)} travel`
      : null}
    actions=${trips.length > 0 && html`<${Button} size="sm" icon="car" onClick=${onLog}>Log drive<//>`}
  >
    ${trips.length === 0
      ? html`<${Empty}
          icon="car"
          title="No drives logged"
          body=${suggested
            ? 'Log the drop-off to count the fuel and your time against this sale — and see what it made per hour.'
            : 'Drove for this sale? Log it to count the fuel and your time.'}
          action=${html`<${Button} kind=${suggested ? 'primary' : 'secondary'} icon="car" onClick=${onLog}>Log drive<//>`}
        />`
      : html`<div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th scope="col">Drive</th>
                <th scope="col" class="num">Miles</th>
                <th scope="col" class="num">Time</th>
                <th scope="col" class="num">Fuel</th>
                <th scope="col" class="num">Travel cost</th>
                <th scope="col" class="num">Your time</th>
                <th scope="col"><span class="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              ${trips.map((trip) => {
                const t = tripTotals(trip);
                const legs = t.miles > num(trip.one_way_miles) ? 'round trip' : 'one way';
                return html`<tr key=${trip.id}>
                  <td class="cell-primary">
                    <div class="wrap-anywhere">${trip.label || tripRoute(trip)}</div>
                    <div class="small muted" style="font-weight:400">${formatDate(trip.trip_date)} · ${legs}</div>
                  </td>
                  <td data-label="Miles" class="num">${formatMiles(t.miles)}</td>
                  <td data-label="Time" class="num">
                    ${duration(t.totalMinutes)}
                    ${t.totalMinutes > t.drivingMinutes && html`<div class="tiny faint">${duration(t.drivingMinutes)} driving</div>`}
                  </td>
                  <td data-label="Fuel" class="num">${money(t.fuelCost)}</td>
                  <td data-label="Travel cost" class="num">${money(t.cashCost)}</td>
                  <td data-label="Your time" class="num">${money(t.timeCost)}</td>
                  <td class="cell-actions">
                    <div class="row row-end row-nowrap" style="gap:4px">
                      <${Button} kind="ghost" size="sm" icon="edit" aria-label="Edit drive" onClick=${() => onEdit(trip)} />
                      <${Button} kind="ghost" size="sm" icon="trash" aria-label="Delete drive" onClick=${() => remove(trip)} />
                    </div>
                  </td>
                </tr>`;
              })}
            </tbody>
          </table>
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
    actions=${html`<${Button} size="sm" icon="edit" onClick=${onEdit}>Edit<//>`}
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
      </dl>
      <div class="stack-sm">
        <span class="field-label">Notes</span>
        ${deal.notes
          ? html`<p style="white-space:pre-wrap" class="wrap-anywhere">${deal.notes}</p>`
          : html`<p class="muted small">No notes.</p>`}
      </div>
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
      await store.deals.update(deal.id, { ...form, client_id: form.client_id || null });
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
      <div style=${FIELD_GRID}>
        <${Field} label="Sale date" required error=${showErrors && errors.sale_date}>
          <${Input} type="date" value=${form.sale_date} onInput=${set('sale_date')} />
        <//>
        <${Field} label="Deliver by" error=${showErrors && errors.due_date}>
          <${Input} type="date" value=${form.due_date} onInput=${set('due_date')} />
        <//>
        <${Field} label="How it gets to them">
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
  const [editingItem, setEditingItem] = useState(null); // item id, 'new' or null
  const [editingCost, setEditingCost] = useState(null); // { id, confirm } or null
  const [markBought, setMarkBought] = useState(null); // item
  const [tripDialog, setTripDialog] = useState(null); // { trip } (trip null = new drive)
  const [editingDetails, setEditingDetails] = useState(false);
  const [paymentFormOpen, setPaymentFormOpen] = useState(false);

  // The status picker shows the new status straight away and settles once the sale reloads.
  useEffect(() => {
    setPendingStatus(null);
  }, [deal.status]);

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

  function onBought(item, variance) {
    setMarkBought(null);
    const stillToBuy = itemsToBuy(deal).filter((entry) => entry.id !== item.id).length;
    const ready = stillToBuy === 0 && (deal.status === 'agreed' || deal.status === 'sourcing');
    toast(`Marked bought. ${varianceText(variance) ?? ''}`.trim(), {
      tone: 'gain',
      action: ready ? { label: 'Set ready to deliver', onClick: () => changeStatus('ready') } : undefined,
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
        setEditingItem('new');
        break;
      case 'payment':
        setPaymentFormOpen(true);
        document.getElementById(PAYMENTS_ID)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        break;
      default:
        break;
    }
  }

  const payment = paymentMeta[totals.paymentStatus] ?? paymentMeta.none;
  const step = deal.status === pendingStatus || pendingStatus === null ? nextStep(deal, totals) : null;
  const subtitle = html`<span class="row" style="gap:4px 10px">
    ${deal.client
      ? html`<a class="strong" href=${`#/clients/${deal.client.id}`}>${deal.client.name}</a>`
      : html`<span>No client</span>`}
    ${deal.client?.club && html`<span>${deal.client.club}</span>`}
    <span>Sold ${formatDate(deal.sale_date)}</span>
    <${Badge} tone=${payment.tone}>${payment.label}<//>
  </span>`;
  const actions = html`
    <${Select}
      aria-label="Sale status"
      options=${statusOptions}
      value=${pendingStatus ?? deal.status}
      disabled=${pendingStatus !== null}
      onChange=${(event) => changeStatus(event.currentTarget.value, event.currentTarget)}
    />
    <${Button} icon="edit" onClick=${() => setEditingDetails(true)}>Edit<//>`;

  return html`<${Page} title=${number} subtitle=${subtitle} actions=${actions} back="#/sales">
    ${refreshError && html`<${Banner}
      tone="warn"
      title="Couldn't refresh this sale"
      actions=${html`<${Button} size="sm" onClick=${onRetry}>Try again<//>`}
    >${refreshError.message}<//>`}
    ${step && html`<${Banner}
      tone="neutral"
      icon="trending-up"
      title=${step.title}
      actions=${html`<${Button} kind="primary" size="sm" onClick=${() => runStep(step.action)}>${step.label}<//>`}
    >${step.text}<//>`}

    <${ProfitHero}
      deal=${deal}
      totals=${totals}
      settings=${settings}
      onMarkBought=${setMarkBought}
      onConfirmCost=${(cost) => setEditingCost({ id: cost.id, confirm: true })}
    />

    <${ItemsCard}
      store=${store}
      deal=${deal}
      totals=${totals}
      editing=${editingItem}
      setEditing=${setEditingItem}
      onMarkBought=${setMarkBought}
    />

    <div class="grid cols-2">
      <${PaymentsCard}
        store=${store}
        deal=${deal}
        totals=${totals}
        formOpen=${paymentFormOpen}
        setFormOpen=${setPaymentFormOpen}
      />
      <${CostsCard} store=${store} deal=${deal} totals=${totals} editing=${editingCost} setEditing=${setEditingCost} />
    </div>

    <${TripsCard} store=${store} deal=${deal} totals=${totals} onLog=${() => openTrip()} onEdit=${openTrip} />

    <${DetailsCard} deal=${deal} client=${client} onEdit=${() => setEditingDetails(true)} />

    <div class="row row-end">
      <${Button} icon="trash" onClick=${deleteSale}>Delete sale<//>
    </div>

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

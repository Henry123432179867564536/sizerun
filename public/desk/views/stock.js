// Stock (#/stock): what you have bought and still hold. calc.stockLevels turns each line's
// quantity and the sales that use it into units allocated, units on hand and value at cost.
// Filter (In stock / Allocated / All, plus Archived), search and sort live in the address
// (`#/stock?show=…&q=…&sort=…`); adding and editing happen in a dialog.

import { html, useMemo, useState } from '../lib/preact.js';
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
  SearchBox,
  Segmented,
  Select,
  Stat,
  Switch,
  Tabs,
  Textarea,
  confirmDialog,
  cx,
  statusMeta,
  toast,
  useId,
  useStoreData,
} from '../lib/ui.js';
import { EPS, dealNumber, num, stockLevels } from '../lib/calc.js';
import { CONDITIONS, conditionLabel, date as formatDate, money, plural, todayISO } from '../lib/format.js';
import { ListRow, usePhone } from './clients.js';
import { supplierHistory } from '../lib/search.js';
import SupplierField from '../components/supplier-field.js';

const MAX_NAME = 120;
const MAX_QTY = 100000;
const MAX_AMOUNT = 1e10; // numeric(12,2) holds up to 9,999,999,999.99
const AGED_DAYS = 90;
const MS_PER_DAY = 86_400_000;
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
// Sales not yet handed over: stock allocated to them is still physically with you.
const OPEN_STATUSES = new Set(['enquiry', 'agreed', 'sourcing', 'ready']);


const CSS = `
.st-table td.cell-primary { min-width: 200px; }
.st-uses { margin: 0; padding: 0; list-style: none; }
.st-uses li { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 7px 0; border-bottom: 1px solid var(--line); }
.st-uses li:last-child { border-bottom: 0; }
.st-delete { margin-right: auto; }
.st-uses-title { margin-bottom: 4px; }
.st-name { display: flex; align-items: center; gap: 6px; min-width: 0; }
.st-sub { font-weight: 400; }
.st-kpis .stat-sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 639.98px) {
  .st-table td.cell-primary { min-width: 0; }
  /* With nothing allocated, "Qty" and "Allocated" repeat "On hand": keep phone cards short. */
  .st-table td.st-same { display: none; }
  .st-delete { margin-right: 0; }
}
`;

const STYLE_ID = 'desk-stock-styles';
if (typeof document !== 'undefined' && !document.getElementById(STYLE_ID)) {
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.append(style);
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normaliseText(value) {
  return String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Form text → number: '£1,234.50' → 1234.5, '' → null, 'abc' → NaN. */
function parseNumber(value) {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).replace(/[£,\s]/g, '');
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : Number.NaN;
}

/** A stored amount as input text: 120 → '120', 119.5 → '119.50', null → ''. */
function amountText(value) {
  if (value === null || value === undefined || value === '') return '';
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function dayIndex(iso) {
  const match = ISO_DAY.exec(clean(iso));
  if (!match) return null;
  const [y, m, d] = match.slice(1).map(Number);
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return Math.round(t.getTime() / MS_PER_DAY);
}

/** Whole days since `iso` was bought (0 for today, or a date in the future); null without one. */
function ageDays(iso, today) {
  const bought = dayIndex(iso);
  const now = dayIndex(today);
  if (bought === null || now === null) return null;
  return Math.max(0, now - bought);
}

function ageText(days) {
  if (days === null) return '—';
  return days === 0 ? 'Today' : plural(days, 'day');
}

/** Map stock id → every sale line that uses it: [{ deal, qty }] (cancelled sales included). */
function stockUses(deals) {
  const uses = new Map();
  for (const deal of deals) {
    for (const item of Array.isArray(deal.items) ? deal.items : []) {
      if (!item?.stock_item_id) continue;
      const list = uses.get(item.stock_item_id) ?? [];
      list.push({ deal, qty: num(item.qty) });
      uses.set(item.stock_item_id, list);
    }
  }
  return uses;
}

function uniqueSorted(values) {
  const seen = new Map();
  for (const value of values) {
    const text = clean(value);
    if (text && !seen.has(text.toLowerCase())) seen.set(text.toLowerCase(), text);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, 'en-GB'));
}

async function loadStock(store) {
  const [stock, deals] = await Promise.all([store.stock.list({ includeArchived: true }), store.deals.list()]);
  return { stock, deals };
}

// ---------------------------------------------------------------------------------------------
// List state: filters and sorting
// ---------------------------------------------------------------------------------------------

const FILTERS = [
  { id: 'in', label: 'In stock', test: (row) => !row.item.archived && row.level.onHand > 0 },
  { id: 'allocated', label: 'Allocated', test: (row) => !row.item.archived && row.level.allocated > 0 },
  { id: 'all', label: 'All', test: (row) => !row.item.archived },
  { id: 'archived', label: 'Archived', test: (row) => Boolean(row.item.archived) },
];
const FILTER_IDS = new Set(FILTERS.map((filter) => filter.id));

const byIndex = (a, b) => a.index - b.index;
const SORTS = [
  // The store lists newest purchases first.
  { value: 'newest', label: 'Newest first', compare: byIndex },
  { value: 'oldest', label: 'Oldest first', compare: (a, b) => (b.age ?? -1) - (a.age ?? -1) || byIndex(a, b) },
  { value: 'value', label: 'Highest value', compare: (a, b) => b.level.value - a.level.value || byIndex(a, b) },
  { value: 'name', label: 'Name A–Z', compare: (a, b) => a.sortName.localeCompare(b.sortName, 'en-GB') || byIndex(a, b) },
];
const SORT_OPTIONS = SORTS.map(({ value, label }) => ({ value, label }));

function listHref({ show, q, sort }) {
  const query = new URLSearchParams();
  if (show && show !== 'in') query.set('show', show);
  if (q) query.set('q', q);
  if (sort && sort !== 'newest') query.set('sort', sort);
  const text = query.toString();
  return `#/stock${text ? `?${text}` : ''}`;
}

function buildRows({ stock, deals }) {
  const levels = stockLevels(stock, deals);
  const uses = stockUses(deals);
  const today = todayISO();
  return stock.map((item, index) => {
    const level = levels.get(item.id) ?? { allocated: 0, onHand: num(item.qty), value: 0 };
    const lineUses = uses.get(item.id) ?? [];
    const age = ageDays(item.bought_at, today);
    return {
      item,
      index,
      level,
      uses: lineUses,
      toHandOver: lineUses.filter((use) => OPEN_STATUSES.has(use.deal.status)).reduce((sum, use) => sum + use.qty, 0),
      age,
      aged: age !== null && age >= AGED_DAYS && level.onHand > 0,
      sortName: normaliseText(item.name),
      haystack: normaliseText([
        item.name, item.brand, item.sku, item.size, item.supplier, item.location, item.notes,
        conditionLabel(item.condition),
      ].filter(Boolean).join(' ')),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Add / edit dialog
// ---------------------------------------------------------------------------------------------

function formFromItem(item) {
  return {
    name: item?.name ?? '',
    brand: item?.brand ?? '',
    sku: item?.sku ?? '',
    size: item?.size ?? '',
    condition: CONDITIONS.some((c) => c.value === item?.condition) ? item.condition : 'new',
    qty: item ? String(item.qty ?? 0) : '1',
    unit_cost: amountText(item?.unit_cost),
    bought_at: item ? item.bought_at ?? '' : todayISO(),
    supplier: item?.supplier ?? '',
    location: item?.location ?? '',
    notes: item?.notes ?? '',
    archived: Boolean(item?.archived),
  };
}

function stockProblems(form, today = todayISO()) {
  const problems = {};
  const name = clean(form.name);
  if (!name) problems.name = 'Name the item, e.g. "Nike Dunk Low Panda".';
  else if (name.length > MAX_NAME) problems.name = `Keep the name under ${MAX_NAME} characters.`;

  const qty = parseNumber(form.qty);
  if (qty === null) problems.qty = 'Enter how many you bought.';
  else if (!Number.isInteger(qty) || qty < 0) problems.qty = 'Use a whole number, 0 or more.';
  else if (qty > MAX_QTY) problems.qty = 'That quantity is too large.';

  const cost = parseNumber(form.unit_cost);
  if (cost === null) problems.unit_cost = 'Enter what each one cost you.';
  else if (Number.isNaN(cost)) problems.unit_cost = 'Use numbers only, e.g. 120 or 119.99.';
  else if (cost < 0) problems.unit_cost = "Can't be negative.";
  else if (cost >= MAX_AMOUNT) problems.unit_cost = 'That amount is too large.';

  const bought = clean(form.bought_at);
  if (bought) {
    if (dayIndex(bought) === null) problems.bought_at = 'Enter a real date.';
    else if (bought > today) problems.bought_at = "Can't be in the future.";
  }
  return problems;
}

/** Form → stock_items row (blank text becomes null so clearing a field clears it). */
function stockRowFromForm(form, { includeArchived }) {
  const row = {
    name: clean(form.name),
    brand: clean(form.brand) || null,
    sku: clean(form.sku) || null,
    size: clean(form.size) || null,
    condition: form.condition,
    qty: parseNumber(form.qty),
    unit_cost: parseNumber(form.unit_cost),
    bought_at: clean(form.bought_at) || null,
    supplier: clean(form.supplier) || null,
    location: clean(form.location) || null,
    notes: clean(form.notes) || null,
  };
  if (includeArchived) row.archived = form.archived;
  return row;
}

function StockEditor({ store, row, deals, suggestions, busy, onClose, onDelete }) {
  const item = row?.item ?? null;
  const editing = Boolean(item);
  const formId = useId('stock-form');
  const [form, setForm] = useState(() => formFromItem(item));
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);

  const problems = stockProblems(form);
  const shown = tried ? problems : {};
  // Only with a mouse: on a phone the keyboard would jump up over the sheet before it's read.
  const [finePointer] = useState(() => typeof window !== 'undefined' && Boolean(window.matchMedia?.('(pointer: fine)').matches));
  const set = (key) => (event) => {
    const value = event.currentTarget.value;
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  // What the line will look like once saved, worked out by calc like the table.
  const preview = useMemo(() => {
    if (problems.qty || problems.unit_cost) return null;
    const id = item?.id ?? 'new';
    const draft = { id, qty: parseNumber(form.qty), unit_cost: parseNumber(form.unit_cost) };
    return stockLevels([draft], deals).get(id) ?? null;
  }, [form.qty, form.unit_cost, deals, item?.id, problems.qty, problems.unit_cost]);

  async function submit(event) {
    event.preventDefault();
    if (saving) return;
    setTried(true);
    if (Object.keys(problems).length > 0) return;
    setSaving(true);
    try {
      const values = stockRowFromForm(form, { includeArchived: editing });
      const saved = editing ? await store.stock.update(item.id, values) : await store.stock.create(values);
      toast(editing ? `Saved ${saved.name}.` : `Added ${saved.name} to stock.`, { tone: 'gain' });
      onClose();
    } catch (err) {
      toast(err, { tone: 'loss' });
      setSaving(false);
    }
  }

  const allocated = preview?.allocated ?? row?.level.allocated ?? 0;
  let qtyHint = 'How many you bought. Units on sales are taken off automatically.';
  if (preview && allocated > 0) {
    qtyHint = preview.onHand < 0
      ? `That's fewer than the ${allocated} already on sales — on hand would show ${preview.onHand}.`
      : `${allocated} on sales, so ${preview.onHand} on hand.`;
  }

  const footer = html`
    ${editing && html`<${Button} kind="ghost" icon="trash" class="st-delete" loading=${busy} disabled=${saving} onClick=${() => onDelete(row)}>Delete<//>`}
    <${Button} onClick=${onClose} disabled=${saving}>Cancel<//>
    <${Button} kind="primary" type="submit" form=${formId} icon="check" loading=${saving}>${editing ? 'Save' : 'Add to stock'}<//>`;

  return html`<${Modal} title=${editing ? `Edit ${item.name}` : 'Add stock'} size="lg" onClose=${onClose} footer=${footer} dismissible=${!saving}>
    <form id=${formId} class="stack" noValidate=${true} onSubmit=${submit}>
      <div class="form-grid">
        <${Field} label="Item" required error=${shown.name} class="span-all">
          <${Input}
            value=${form.name}
            maxlength=${MAX_NAME}
            autocomplete="off"
            autocapitalize="words"
            autofocus=${!editing && finePointer}
            placeholder="e.g. Nike Dunk Low Panda"
            onInput=${set('name')}
          />
        <//>
        <${Field} label="Brand">
          <${Input} value=${form.brand} list=${`${formId}-brands`} autocomplete="off" autocapitalize="words" placeholder="e.g. Nike" onInput=${set('brand')} />
        <//>
        <${Field} label="SKU" hint="The style code on the box.">
          <${Input} value=${form.sku} autocomplete="off" autocapitalize="characters" spellcheck=${false} placeholder="e.g. DD1391-100" onInput=${set('sku')} />
        <//>
        <${Field} label="Size">
          <${Input} value=${form.size} autocomplete="off" placeholder="e.g. UK 9" onInput=${set('size')} />
        <//>
        <div class="field">
          <span class="field-label" aria-hidden="true">Condition</span>
          <${Segmented}
            options=${CONDITIONS}
            value=${form.condition}
            onChange=${(value) => setForm((prev) => ({ ...prev, condition: value }))}
            label="Condition"
            full
          />
        </div>
        <${Field} label="Quantity" required error=${shown.qty} hint=${shown.qty ? undefined : qtyHint}>
          <${Input} value=${form.qty} inputmode="numeric" autocomplete="off" onInput=${set('qty')} />
        <//>
        <${Field} label="Cost each" required error=${shown.unit_cost} hint=${!shown.unit_cost && preview ? `Worth ${money(preview.value)} on hand, at cost.` : undefined}>
          <${Input} value=${form.unit_cost} prefix="£" inputmode="decimal" autocomplete="off" placeholder="0.00" onInput=${set('unit_cost')} />
        <//>
        <${Field} label="Bought on" error=${shown.bought_at}>
          <${Input} type="date" value=${form.bought_at} max=${todayISO()} onInput=${set('bought_at')} />
        <//>
        <${SupplierField}
          label="Supplier"
          value=${form.supplier}
          history=${suggestions.suppliers}
          onChange=${(supplier) => setForm((prev) => ({ ...prev, supplier }))}
        />
        <${Field} label="Kept at" class="span-all">
          <${Input} value=${form.location} list=${`${formId}-locations`} autocomplete="off" placeholder="e.g. Home, storage unit" onInput=${set('location')} />
        <//>
        <${Field} label="Notes" class="span-all">
          <${Textarea} value=${form.notes} rows=${2} onInput=${set('notes')} />
        <//>
        ${editing && html`<div class="span-all">
          <${Switch}
            checked=${form.archived}
            onChange=${(checked) => setForm((prev) => ({ ...prev, archived: checked }))}
            label="Archived"
            hint="Hidden from the stock list and totals — for things written off or sold elsewhere."
          />
        </div>`}
      </div>
      <datalist id=${`${formId}-brands`}>${suggestions.brands.map((value) => html`<option key=${value} value=${value} />`)}</datalist>
      <datalist id=${`${formId}-locations`}>${suggestions.locations.map((value) => html`<option key=${value} value=${value} />`)}</datalist>
      ${row?.uses.length > 0 && html`<div>
        <p class="field-label st-uses-title">On sales</p>
        <ul class="st-uses">
          ${row.uses.map(({ deal, qty }) => {
            const status = statusMeta[deal.status] ?? statusMeta.agreed;
            return html`<li key=${deal.id}>
              <span class="truncate">
                <a href=${`#/sales/${deal.id}`} class="mono" onClick=${onClose}>${dealNumber(deal.number)}</a>
                ${deal.client?.name ? ` · ${deal.client.name}` : ''}
              </span>
              <span class="row row-nowrap">
                <span class="small muted">×${qty}</span>
                <${Badge} tone=${status.tone}>${status.label}<//>
              </span>
            </li>`;
          })}
        </ul>
      </div>`}
    </form>
  <//>`;
}

// ---------------------------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------------------------

function withoutRowClick(handler) {
  return (event) => {
    event.stopPropagation();
    handler();
  };
}

function StockRow({ row, busy, onEdit, onDelete }) {
  const { item, level, age, aged } = row;
  const oversold = level.onHand < 0;
  // Nothing allocated: Qty and Allocated only repeat On hand.
  const same = level.allocated === 0;
  const sku = clean(item.sku);
  const details = [clean(item.brand), sku && html`<span class="mono">${sku}</span>`, conditionLabel(item.condition) ?? 'New']
    .filter(Boolean)
    .flatMap((part, index) => (index ? [' · ', part] : [part]));
  return html`<tr class="is-clickable" onClick=${() => onEdit(row)}>
    <td class="cell-primary">
      <div class="st-name">
        <span class="truncate">${item.name}</span>
        ${item.archived && html`<${Badge} tone="muted" dot=${false}>Archived<//>`}
      </div>
      <div class="small muted truncate st-sub">${details}</div>
      ${oversold && html`<span class="pill pill-loss" title="More are on sales than you bought">Oversold by ${-level.onHand}</span>`}
    </td>
    <td data-label="Size">${clean(item.size) || null}</td>
    <td data-label="Qty" class=${cx('num', same && 'st-same')}>${num(item.qty)}</td>
    <td data-label="Allocated" class=${cx('num', same && 'st-same', same && 'faint')}>${level.allocated}</td>
    <td data-label="On hand" class=${cx('num', 'strong', oversold && 'tone-loss', level.onHand === 0 && 'faint')}>${level.onHand}</td>
    <td data-label="Unit cost" class="num"><${Money} value=${item.unit_cost} /></td>
    <td data-label="Value" class="num"><${Money} value=${level.value} /></td>
    <td
      data-label="Age"
      class=${cx('num', aged && 'tone-warn')}
      title=${item.bought_at ? `Bought ${formatDate(item.bought_at)}` : 'No bought date'}
    >${ageText(age)}</td>
    <td class="cell-actions">
      <div class="row row-end row-nowrap">
        <${Button} kind="ghost" size="sm" icon="edit" disabled=${busy} onClick=${withoutRowClick(() => onEdit(row))}>Edit<//>
        <${Button}
          kind="ghost"
          size="sm"
          icon="trash"
          aria-label=${`Delete ${item.name}`}
          loading=${busy}
          onClick=${withoutRowClick(() => onDelete(row))}
        />
      </div>
    </td>
  </tr>`;
}

// Phones: name over "UK 9 · Nike · 40 days", value at cost over what's on hand. Tapping a
// row opens the editor, which also holds Delete.
function StockListRow({ row, onEdit }) {
  const { item, level, age, aged } = row;
  const oversold = level.onHand < 0;
  const sub = [clean(item.size), clean(item.brand), item.condition && item.condition !== 'new' && conditionLabel(item.condition), age !== null && ageText(age)].filter(Boolean).join(' · ');
  let meta = `${level.onHand} on hand`;
  if (level.allocated > 0) meta += ` · ${level.allocated} on sales`;
  if (oversold) meta = `Oversold by ${-level.onHand}`;
  return html`<${ListRow}
    onClick=${() => onEdit(row)}
    title=${item.name}
    badge=${item.archived && html`<${Badge} tone="muted" dot=${false}>Archived<//>`}
    subtitle=${sub || 'No size or brand'}
    amount=${html`<${Money} value=${level.value} />`}
    meta=${meta}
    metaTone=${oversold ? 'loss' : aged ? 'warn' : undefined}
    label=${`Edit ${item.name}`}
  />`;
}

function StockTable({ rows, busyId, onEdit, onDelete }) {
  const units = rows.reduce((sum, row) => sum + Math.max(0, row.level.onHand), 0);
  const value = rows.reduce((sum, row) => sum + row.level.value, 0);
  const qty = rows.reduce((sum, row) => sum + num(row.item.qty), 0);
  const allocated = rows.reduce((sum, row) => sum + row.level.allocated, 0);
  return html`<div class="table-wrap">
    <table class="table st-table">
      <thead>
        <tr>
          <th scope="col">Item</th>
          <th scope="col">Size</th>
          <th scope="col" class="num">Qty</th>
          <th scope="col" class="num">Allocated</th>
          <th scope="col" class="num">On hand</th>
          <th scope="col" class="num">Unit cost</th>
          <th scope="col" class="num">Value</th>
          <th scope="col" class="num">Age</th>
          <th scope="col"><span class="sr-only">Actions</span></th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((row) => html`<${StockRow}
          key=${row.item.id}
          row=${row}
          busy=${busyId === row.item.id}
          onEdit=${onEdit}
          onDelete=${onDelete}
        />`)}
      </tbody>
      <tfoot>
        <tr>
          <td class="cell-primary">Total · ${plural(rows.length, 'line')}</td>
          <td></td>
          <td data-label="Qty" class="num st-same">${qty}</td>
          <td data-label="Allocated" class="num st-same">${allocated}</td>
          <td data-label="Units on hand" class="num">${units}</td>
          <td></td>
          <td data-label="Value" class="num"><${Money} value=${value} /></td>
          <td></td>
          <td></td>
        </tr>
      </tfoot>
    </table>
  </div>`;
}

// ---------------------------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------------------------

function StockSummary({ rows }) {
  const live = rows.filter((row) => !row.item.archived);
  const units = live.reduce((sum, row) => sum + Math.max(0, row.level.onHand), 0);
  const lines = live.filter((row) => row.level.onHand > 0).length;
  const value = live.reduce((sum, row) => sum + row.level.value, 0);
  const toHandOver = live.reduce((sum, row) => sum + row.toHandOver, 0);
  const aged = live.filter((row) => row.aged);
  const agedValue = aged.reduce((sum, row) => sum + row.level.value, 0);
  const agedUnits = aged.reduce((sum, row) => sum + Math.max(0, row.level.onHand), 0);
  return html`<div class="kpis st-kpis">
    <${Stat} label="Units on hand" value=${String(units)} sub=${plural(lines, 'line')} />
    <${Stat} label="Stock value" value=${money(value)} sub="At cost" tone=${value > EPS ? 'signal' : undefined} />
    <${Stat} label="To hand over" value=${String(toHandOver)} sub="Not delivered yet" />
    <${Stat}
      label=${`Aged ${AGED_DAYS}+ days`}
      value=${money(agedValue)}
      tone=${agedValue > EPS ? 'warn' : undefined}
      sub=${agedUnits > 0 ? `${plural(agedUnits, 'unit')} tied up` : 'None slow-moving'}
    />
  </div>`;
}

export default function StockView({ store, params, navigate }) {
  const { data, error, loading, reload } = useStoreData(store, loadStock);
  const [editor, setEditor] = useState(null); // null | { row } (row null = new item)
  const [busyId, setBusyId] = useState(null);
  const phone = usePhone();

  const show = FILTER_IDS.has(params.show) ? params.show : 'in';
  const q = typeof params.q === 'string' ? params.q : '';
  const sort = SORTS.some((option) => option.value === params.sort) ? params.sort : 'newest';
  const setView = (patch) => navigate(listHref({ show, q, sort, ...patch }), { replace: true });

  const rows = useMemo(() => (data ? buildRows(data) : []), [data]);
  const searched = useMemo(() => {
    const tokens = normaliseText(q).trim().split(/\s+/).filter(Boolean);
    return tokens.length ? rows.filter((row) => tokens.every((token) => row.haystack.includes(token))) : rows;
  }, [rows, q]);
  const activeFilter = FILTERS.find((filter) => filter.id === show);
  const shown = useMemo(() => {
    const compare = SORTS.find((option) => option.value === sort).compare;
    return searched.filter(activeFilter.test).sort(compare);
  }, [searched, activeFilter, sort]);
  const suggestions = useMemo(() => ({
    brands: uniqueSorted(rows.map((row) => row.item.brand)),
    suppliers: supplierHistory({ deals: data?.deals ?? [], stock: rows.map((row) => row.item) }),
    locations: uniqueSorted(rows.map((row) => row.item.location)),
  }), [rows, data]);

  const hasArchived = rows.some((row) => row.item.archived);
  const tabs = FILTERS
    .filter((filter) => filter.id !== 'archived' || hasArchived || show === 'archived')
    .map(({ id, label, test }) => ({ id, label, count: searched.filter(test).length }));

  // Edit the freshest copy of a row: the list reloads after every save.
  const editorRow = editor?.row ? rows.find((row) => row.item.id === editor.row.item.id) ?? editor.row : null;

  async function remove(row) {
    const { item, uses } = row;
    const confirmed = await confirmDialog({
      title: `Delete ${item.name}?`,
      body: [
        uses.length
          ? `It's on ${plural(uses.length, 'sale line')}. Those keep what the item cost you, but lose their link to this stock.`
          : "It isn't on any sale.",
        !item.archived && 'To keep the record but hide it, archive it instead.',
        "This can't be undone.",
      ].filter(Boolean).join(' '),
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!confirmed) return;
    setBusyId(item.id);
    try {
      await store.stock.remove(item.id);
      toast(`Deleted ${item.name}.`, { tone: 'gain' });
      setEditor(null);
    } catch (err) {
      toast(err, { tone: 'loss' });
    } finally {
      setBusyId(null);
    }
  }

  const addButton = html`<${Button} kind="primary" icon="plus" onClick=${() => setEditor({ row: null })}>Add stock<//>`;
  const dialog = editor && html`<${StockEditor}
    key=${editor.row?.item.id ?? 'new'}
    store=${store}
    row=${editorRow}
    deals=${data?.deals ?? []}
    suggestions=${suggestions}
    busy=${Boolean(editorRow) && busyId === editorRow.item.id}
    onClose=${() => setEditor(null)}
    onDelete=${remove}
  />`;
  const page = (body) => html`<${Page}
    title="Stock"
    subtitle="What you've bought and still hold, at cost."
    actions=${data ? addButton : null}
  >${body}${dialog}<//>`;

  if (loading) return page(html`<${Loading} label="Loading stock…" />`);
  if (error && !data) {
    return page(html`<${Card}><${ErrorState} error=${error} title="Couldn't load your stock" onRetry=${reload} /><//>`);
  }
  if (rows.length === 0) {
    return page(html`<${Card}>
      <${Empty}
        icon="box"
        title="No stock yet"
        body="Add pairs and pieces you buy ahead of a sale. When you sell one, choose “From stock” on the sale and Desk keeps count of what's left and what it's worth."
        action=${html`<${Button} kind="primary" icon="plus" onClick=${() => setEditor({ row: null })}>Add your first item<//>`}
      />
    <//>`);
  }

  let emptyTitle = 'Nothing here';
  let emptyBody = '';
  if (q) {
    emptyTitle = `No stock matches “${q}”`;
    emptyBody = 'Try a name, brand, SKU, size or supplier.';
  } else if (show === 'in') {
    emptyTitle = 'Nothing on hand';
    emptyBody = "Everything you've bought is on a sale.";
  } else if (show === 'allocated') {
    emptyTitle = 'Nothing allocated yet';
    emptyBody = 'Stock shows here once a sale uses it.';
  } else if (show === 'archived') {
    emptyTitle = 'No archived stock';
  }

  return page(html`
    ${error && html`<${Banner} tone="warn" title="Couldn't refresh" actions=${html`<${Button} size="sm" onClick=${reload}>Try again<//>`}>
      ${error.message}
    <//>`}
    <${StockSummary} rows=${rows} />
    <${Tabs} tabs=${tabs} value=${show} onChange=${(id) => setView({ show: id })} label="Filter stock" />
    <div class="toolbar cl-toolbar">
      <${SearchBox}
        value=${q}
        onInput=${(text) => setView({ q: text })}
        placeholder="Search stock"
        label="Search stock"
      />
      <${Select}
        aria-label="Sort stock"
        options=${SORT_OPTIONS}
        value=${sort}
        onChange=${(event) => setView({ sort: event.currentTarget.value })}
      />
    </div>
    <${Card} pad=${false}>
      ${shown.length === 0
        ? html`<${Empty}
            icon="search"
            title=${emptyTitle}
            body=${emptyBody}
            action=${html`
              ${q && html`<${Button} onClick=${() => setView({ q: '' })}>Clear search<//>`}
              ${show !== 'all' && html`<${Button} kind="ghost" onClick=${() => setView({ show: 'all' })}>Show all stock<//>`}`}
          />`
        : phone
          ? html`<ul class="lr-list">${shown.map((row) => html`<${StockListRow} key=${row.item.id} row=${row} onEdit=${(r) => setEditor({ row: r })} />`)}</ul>`
          : html`<${StockTable}
            rows=${shown}
            busyId=${busyId}
            onEdit=${(row) => setEditor({ row })}
            onDelete=${remove}
          />`}
    <//>
  `);
}

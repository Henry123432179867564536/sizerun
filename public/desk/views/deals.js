// Sales list (#/sales) and New sale (#/sales/new) — docs/desk-spec.md §7 "Views".
//
// The default export picks the screen from params.mode. This module also exports the
// sale-editing pieces the Sale detail view (views/deal.js) reuses, so both screens edit items,
// costs, clients and drives the same way: ClientPicker, ItemFields, CostFields,
// ProfitBreakdown, TripModal and the draft helpers that turn form text into store rows.
// Every money figure comes from calc.js; this file only collects inputs and lays results out.

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
  SearchBox,
  Segmented,
  Select,
  Switch,
  Tabs,
  Textarea,
  certaintyMeta,
  cx,
  paymentMeta,
  statusMeta,
  statusOptions,
  toast,
  useId,
  useStoreData,
} from '../lib/ui.js';
import { EPS, dealNumber, dealTotals, itemTotals, num, stockLevels, tripTotals } from '../lib/calc.js';
import {
  date as formatDate,
  dateShort,
  duration,
  miles as formatMiles,
  money,
  pct,
  plural,
  relDays,
  todayISO,
} from '../lib/format.js';

// Written by the deal checker's "Turn into a sale": { client_id, items, costs, trip }.
const PREFILL_KEY = 'sizemill.desk.prefill';

// numeric(12,2) holds up to 9,999,999,999.99.
const MAX_AMOUNT = 1e10;
const MAX_QTY = 100000;
const PICKER_LIMIT = 6;

// Inline layout that desk.css has no class for. Field grid: auto-fitting columns, two-up even
// on a phone (desk.css .form-grid is one column below 640px, too tall for an item line).
export const FIELD_GRID = 'display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(min(100%,128px),1fr))';
// A bordered box around a picked client or drive.
export const BOXED = 'border:1px solid var(--line);border-radius:var(--r-ctl);overflow:hidden';
const BOXED_PAD = `${BOXED};padding:12px`;
// New sale: form column beside a sticky totals column once both fit (≈1180px wide windows);
// below that the totals wrap under the form, next to the Save button.
const FORM_LAYOUT = 'gap:20px';
const FORM_MAIN = 'flex:999 1 560px;min-width:0';
const FORM_SIDE = 'flex:1 1 300px;min-width:0;position:sticky;top:24px';

// ---------------------------------------------------------------------------------------------
// Labels shared with views/deal.js
// ---------------------------------------------------------------------------------------------

export const DELIVERY_METHODS = Object.freeze({
  drop_off: 'Drop-off',
  meet: 'Meet up',
  post: 'Post',
  collection: 'Collection',
});
export const DELIVERY_OPTIONS = Object.freeze(
  Object.entries(DELIVERY_METHODS).map(([value, label]) => ({ value, label })),
);
// Delivery methods that usually mean a drive worth logging.
export const DRIVEN_DELIVERY = new Set(['drop_off', 'meet']);

export const COST_KINDS = Object.freeze({ shipping: 'Shipping', fees: 'Fees', packaging: 'Packaging', other: 'Other' });
const COST_KIND_OPTIONS = Object.entries(COST_KINDS).map(([value, label]) => ({ value, label }));
const COST_PLACEHOLDERS = {
  shipping: 'e.g. Royal Mail Special Delivery',
  fees: 'e.g. StockX seller fee',
  packaging: 'e.g. Box and dust bag',
  other: 'e.g. Cleaning',
};

export const PAYMENT_METHODS = Object.freeze({ bank: 'Bank', cash: 'Cash', card: 'Card', other: 'Other' });
export const PAYMENT_METHOD_OPTIONS = Object.freeze(
  Object.entries(PAYMENT_METHODS).map(([value, label]) => ({ value, label })),
);

const ITEM_SOURCES = [
  { value: 'buy', label: 'Need to buy' },
  { value: 'bought', label: 'Bought' },
  { value: 'stock', label: 'From stock' },
];

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

/** Form text → number: '£1,234.50' → 1234.5, '' → null, 'abc' → NaN. */
export function parseAmount(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : Number.NaN;
  const cleaned = String(value).replace(/[£,\s]/g, '');
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : Number.NaN;
}

/** A stored number as input text: 450 → '450', 450.5 → '450.50', null → ''. */
export function amountText(value) {
  if (value === null || value === undefined || value === '') return '';
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/** Validation message for a money field, or null when it is fine. */
export function amountProblem(value, { required = true, what = 'an amount', allowZero = true } = {}) {
  const n = parseAmount(value);
  if (n === null) return required ? `Enter ${what}.` : null;
  if (Number.isNaN(n)) return 'Use numbers only, e.g. 450 or 450.50.';
  if (n < 0) return "Can't be negative.";
  if (!allowZero && n === 0) return 'Must be more than £0.';
  if (n >= MAX_AMOUNT) return 'That amount is too large.';
  return null;
}

function qtyProblem(value, maxQty) {
  const n = parseAmount(value);
  if (n === null) return 'Enter how many.';
  if (!Number.isInteger(n) || n < 1) return 'Use a whole number, 1 or more.';
  if (n > MAX_QTY) return 'That quantity is too large.';
  if (maxQty !== undefined && n > maxQty) return maxQty <= 0 ? 'None left in stock.' : `Only ${maxQty} left in stock.`;
  return null;
}

function hasProblems(problems) {
  return Object.values(problems).some(Boolean);
}

function trimmed(value) {
  return String(value ?? '').trim();
}

/** Lower-cased, accent-free text for searching ('Kanté' matches 'kante'). */
export function normaliseText(value) {
  return String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** 'Nike Dunk Low ×2, Stone Island jacket +1 more'. */
export function itemsSummary(items) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return 'No items yet';
  const names = list.slice(0, 2).map((item) => {
    const qty = num(item.qty);
    return `${item.description || 'Item'}${qty > 1 ? ` ×${qty}` : ''}`;
  });
  const rest = list.length - names.length;
  return rest > 0 ? `${names.join(', ')} +${rest} more` : names.join(', ');
}

/** '5 Oct' for this year, '5 Oct 2025' otherwise. */
export function saleDate(iso) {
  return typeof iso === 'string' && iso.slice(0, 4) === todayISO().slice(0, 4) ? dateShort(iso) : formatDate(iso);
}

/** Items on a deal whose cost is still an estimate. */
export function itemsToBuy(deal) {
  return (deal?.items ?? []).filter((item) => item.cost_status !== 'actual');
}

/** Scrolls the first field with an error into view and focuses its control. */
export function revealFirstError(container) {
  requestAnimationFrame(() => {
    const field = container?.querySelector('.has-error');
    if (!field) return;
    field.scrollIntoView({ block: 'center', behavior: 'smooth' });
    field.querySelector('input, select, textarea')?.focus({ preventScroll: true });
  });
}

/** Keeps Enter in a text box from submitting a long form half-filled; Save is explicit. */
export function blockImplicitSubmit(event) {
  const target = event.target;
  if (event.key === 'Enter' && target instanceof HTMLInputElement && target.type !== 'submit') {
    event.preventDefault();
  }
}

// ---------------------------------------------------------------------------------------------
// Drafts: editable form text for items and costs, and their store rows
// ---------------------------------------------------------------------------------------------

let draftSequence = 0;
function draftKey() {
  draftSequence += 1;
  return `draft-${draftSequence}`;
}

/** A new, empty item line. Sources: 'buy' (expected cost), 'bought' (actual) or 'stock'. */
export function blankItem(overrides = {}) {
  return {
    key: draftKey(),
    id: null,
    source: 'buy',
    description: '',
    brand: '',
    sku: '',
    size: '',
    qty: '1',
    unit_price: '',
    expected_unit_cost: '',
    unit_cost: '',
    supplier: '',
    sourced_at: todayISO(),
    stock_item_id: '',
    // A saved item keeps its expected cost after it is bought, so the sale can show how the
    // real price compared ("variance vs expected"). A brand-new line has nothing to compare.
    keepExpected: false,
    ...overrides,
  };
}

/** A stored (or prefilled) deal_items row → an editable draft. */
export function draftFromItem(item = {}) {
  const source = item.stock_item_id ? 'stock' : item.cost_status === 'actual' ? 'bought' : 'buy';
  const saved = Boolean(item.id);
  return blankItem({
    id: item.id ?? null,
    source,
    description: item.description ?? '',
    brand: item.brand ?? '',
    sku: item.sku ?? '',
    size: item.size ?? '',
    qty: item.qty === null || item.qty === undefined ? '1' : String(item.qty),
    unit_price: amountText(item.unit_price),
    expected_unit_cost: amountText(item.expected_unit_cost),
    unit_cost: amountText(item.unit_cost),
    supplier: item.supplier ?? '',
    sourced_at: item.sourced_at ?? todayISO(),
    stock_item_id: item.stock_item_id ?? '',
    keepExpected: saved && item.expected_unit_cost !== null && item.expected_unit_cost !== undefined,
  });
}

/**
 * Draft → deal_items row. stockById maps stock ids to stock rows: an item from stock always
 * costs what the stock line cost. Unparseable numbers come through as NaN/null; calc.js reads
 * them as 0 and validation stops them reaching the store.
 */
export function itemRowFromDraft(draft, stockById = new Map()) {
  const base = {
    description: trimmed(draft.description),
    brand: trimmed(draft.brand) || null,
    sku: trimmed(draft.sku) || null,
    size: trimmed(draft.size) || null,
    qty: parseAmount(draft.qty),
    unit_price: parseAmount(draft.unit_price),
  };
  const expected = parseAmount(draft.expected_unit_cost);
  if (draft.source === 'buy') {
    return {
      ...base,
      cost_status: 'expected',
      expected_unit_cost: expected,
      unit_cost: null,
      stock_item_id: null,
      supplier: trimmed(draft.supplier) || null,
      sourced_at: null,
    };
  }
  const keptExpected = draft.keepExpected ? expected : null;
  if (draft.source === 'stock') {
    const stock = stockById.get(draft.stock_item_id) ?? null;
    return {
      ...base,
      cost_status: 'actual',
      unit_cost: stock ? num(stock.unit_cost) : parseAmount(draft.unit_cost),
      expected_unit_cost: keptExpected,
      stock_item_id: draft.stock_item_id || null,
      supplier: stock?.supplier ?? (trimmed(draft.supplier) || null),
      sourced_at: stock?.bought_at ?? (draft.sourced_at || null),
    };
  }
  return {
    ...base,
    cost_status: 'actual',
    unit_cost: parseAmount(draft.unit_cost),
    expected_unit_cost: keptExpected,
    stock_item_id: null,
    supplier: trimmed(draft.supplier) || null,
    sourced_at: draft.sourced_at || null,
  };
}

/** Field → message for an item draft (empty object when valid). maxQty caps stock lines. */
export function itemProblems(draft, { maxQty } = {}) {
  const problems = {
    description: trimmed(draft.description) ? null : 'Describe the item, e.g. "Nike Dunk Low Panda".',
    qty: qtyProblem(draft.qty, draft.source === 'stock' && draft.stock_item_id ? maxQty : undefined),
    unit_price: amountProblem(draft.unit_price, { what: 'the sale price' }),
  };
  if (draft.source === 'buy') {
    problems.expected_unit_cost = amountProblem(draft.expected_unit_cost, { what: 'what you expect to pay' });
  } else if (draft.source === 'bought') {
    problems.unit_cost = amountProblem(draft.unit_cost, { what: 'what you paid' });
  } else if (!draft.stock_item_id) {
    problems.stock_item_id = 'Choose the stock item.';
  }
  return Object.fromEntries(Object.entries(problems).filter(([, message]) => message));
}

/** A new, empty extra cost. */
export function blankCost(overrides = {}) {
  return { key: draftKey(), id: null, label: '', kind: 'other', amount: '', is_expected: false, ...overrides };
}

export function draftFromCost(cost = {}) {
  return blankCost({
    id: cost.id ?? null,
    label: cost.label ?? '',
    kind: COST_KINDS[cost.kind] ? cost.kind : 'other',
    amount: amountText(cost.amount),
    is_expected: cost.is_expected === true || cost.is_expected === 'true',
  });
}

/** A cost line nobody has filled in yet (skipped rather than flagged on save). */
export function isBlankCost(draft) {
  return !trimmed(draft.label) && parseAmount(draft.amount) === null;
}

/** Draft → deal_costs row. A cost left unnamed is called after its type ('Shipping'). */
export function costRowFromDraft(draft) {
  return {
    label: trimmed(draft.label) || COST_KINDS[draft.kind] || 'Cost',
    kind: draft.kind,
    amount: parseAmount(draft.amount),
    is_expected: Boolean(draft.is_expected),
  };
}

export function costProblems(draft) {
  const amount = amountProblem(draft.amount, { what: 'the cost' });
  return amount ? { amount } : {};
}

/**
 * Stock lines an item can be taken from: [{ stock, available }]. `available` is what is on
 * hand once every other line (otherLines: [{ stock_item_id, qty }]) has taken its share.
 * The line's current stock item stays listed even when it has run out, so it still shows.
 */
export function stockChoicesFor(stockItems, levels, otherLines, currentId) {
  const taken = new Map();
  for (const line of otherLines) {
    if (!line.stock_item_id) continue;
    taken.set(line.stock_item_id, (taken.get(line.stock_item_id) ?? 0) + Math.max(0, num(line.qty)));
  }
  const choices = [];
  for (const stock of stockItems ?? []) {
    const onHand = levels.get(stock.id)?.onHand ?? num(stock.qty);
    const available = onHand - (taken.get(stock.id) ?? 0);
    const current = stock.id === currentId;
    if (current || (!stock.archived && available > 0)) choices.push({ stock, available });
  }
  return choices;
}

// ---------------------------------------------------------------------------------------------
// Drives
// ---------------------------------------------------------------------------------------------

/** Settings home as the trip planner's origin, or null before a home address is saved. */
export function homeLocation(settings) {
  const located = settings?.home_lat !== null && settings?.home_lat !== undefined;
  if (!settings || (!settings.home_address && !located)) return null;
  return {
    label: settings.home_label || 'Home',
    address: settings.home_address,
    lat: settings.home_lat,
    lng: settings.home_lng,
  };
}

/** A client's first saved address as the planner's destination, or null. */
export function clientDestination(client) {
  const list = Array.isArray(client?.addresses) ? client.addresses : [];
  const first = list.find((entry) => entry && (entry.address || (entry.lat !== null && entry.lat !== undefined)));
  if (!first) return null;
  return {
    label: first.label || client.name || 'Client',
    address: first.address ?? null,
    lat: first.lat ?? null,
    lng: first.lng ?? null,
  };
}

/** A trip's stored end as a planner location. */
export function tripEnd(trip, end) {
  const label = trip?.[`${end}_label`];
  const address = trip?.[`${end}_address`];
  const lat = trip?.[`${end}_lat`];
  if (!label && !address && (lat === null || lat === undefined)) return null;
  return { label: label ?? null, address: address ?? null, lat: lat ?? null, lng: trip[`${end}_lng`] ?? null };
}

/** 'Home → Training ground'. */
export function tripRoute(trip) {
  const from = trip?.origin_label || trip?.origin_address || 'Start';
  const to = trip?.dest_label || trip?.dest_address || 'destination';
  return `${from} → ${to}`;
}

let plannerLoad = null;

// Loaded on first use, so a sale page still works (and loads faster) without the planner.
// Resolves { Planner, problemsOf }: the component and its "what's still missing" check.
function loadTripPlanner() {
  if (!plannerLoad) {
    plannerLoad = import('../components/trip-planner.js').then(
      (module) => {
        const Planner = module.default;
        if (typeof Planner !== 'function') throw new Error("The trip planner didn't load properly — reload the page.");
        // Without the planner's own check, the store's validation still rejects an incomplete trip.
        const problemsOf = typeof module.tripProblems === 'function' ? module.tripProblems : () => ({});
        return { Planner, problemsOf };
      },
      (err) => {
        throw new Error("Couldn't load the trip planner — check your connection and try again.", { cause: err });
      },
    );
    plannerLoad.catch(() => {
      plannerLoad = null; // allow a retry
    });
  }
  return plannerLoad;
}

function useTripPlanner() {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState({ planner: null, error: null });
  useEffect(() => {
    let live = true;
    loadTripPlanner().then(
      (planner) => live && setState({ planner, error: null }),
      (error) => live && setState({ planner: null, error }),
    );
    return () => {
      live = false;
    };
  }, [attempt]);
  const retry = () => {
    setState({ planner: null, error: null });
    setAttempt((n) => n + 1);
  };
  return { ...state, retry };
}

/**
 * TripModal({ store, settings, title, trip, initialOrigin, initialDestination, saveLabel,
 *             onSave(trip) → Promise, onClose })
 * The trip planner in a dialog: a new drive when `trip` is null (the planner seeds it from
 * settings and the two places), otherwise that drive to edit. onSave receives the planned
 * trip; the dialog stays open and shows the message if it rejects. The caller closes it.
 */
export function TripModal({
  store,
  settings,
  title = 'Log drive',
  trip,
  initialOrigin,
  initialDestination,
  saveLabel = 'Save drive',
  onSave,
  onClose,
}) {
  const { planner, error, retry } = useTripPlanner();
  const [value, setValue] = useState(trip ?? null);
  const [problem, setProblem] = useState(null);
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (saving || !planner) return;
    const missing = value ? Object.values(planner.problemsOf(value)) : ['Plan the drive first.'];
    if (missing.length) {
      setShowErrors(true);
      setProblem(missing[0]);
      return;
    }
    setProblem(null);
    setSaving(true);
    try {
      await onSave(value);
    } catch (err) {
      setProblem(err instanceof Error && err.message ? err.message : "Couldn't save the drive — try again.");
      setSaving(false);
    }
  }

  const close = () => {
    if (!saving) onClose();
  };
  const footer = html`
    <${Button} kind="ghost" onClick=${close} disabled=${saving}>Cancel<//>
    <${Button} kind="primary" icon="check" onClick=${save} loading=${saving} disabled=${!planner}>${saveLabel}<//>`;

  let body;
  if (error) body = html`<${ErrorState} error=${error} title="Trip planner unavailable" onRetry=${retry} />`;
  else if (!planner) body = html`<${Loading} label="Loading the trip planner…" />`;
  else {
    const { Planner } = planner;
    body = html`<${Planner}
      store=${store}
      settings=${settings}
      value=${value}
      onChange=${setValue}
      initialOrigin=${initialOrigin}
      initialDestination=${initialDestination ?? null}
      compact=${true}
      showErrors=${showErrors}
    />`;
  }

  return html`<${Modal} title=${title} size="lg" onClose=${close} footer=${footer}>
    <div class="stack">
      ${problem && html`<${Banner} tone="loss">${problem}<//>`}
      ${body}
    </div>
  <//>`;
}

/** One-paragraph description of a planned or saved drive. */
export function TripSummary({ trip }) {
  const t = tripTotals(trip);
  // Read from calc's own result, so the label always matches the miles it counted.
  const legs = t.miles > num(trip.one_way_miles) ? 'round trip' : 'one way';
  const stops = t.totalMinutes - t.drivingMinutes;
  return html`<div class="stack-sm">
    <div class="strong wrap-anywhere">${trip.label || tripRoute(trip)}</div>
    <div class="small muted">${formatMiles(t.miles)} ${legs} · ${duration(t.drivingMinutes)} driving${stops > 0 ? ` + ${duration(stops)} handover` : ''}</div>
    <div class="small">
      <${Money} value=${t.cashCost} /> fuel and costs${t.timeCost > 0 && html` · <${Money} value=${t.timeCost} /> of your time`}
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------------------------
// Client picker
// ---------------------------------------------------------------------------------------------

function clientHaystack(client) {
  return normaliseText([
    client.name, client.club, client.position, client.squad_number, client.instagram, client.agent_name,
  ].filter(Boolean).join(' '));
}

/** 'Southampton · Shoe UK 9 · Clothing M' */
function clientDetails(client) {
  return [
    client.club,
    client.shoe_size && `Shoe ${client.shoe_size}`,
    client.clothing_size && `Clothing ${client.clothing_size}`,
  ].filter(Boolean).join(' · ');
}

/**
 * ClientPicker({ store, clients, value, onChange(id | ''), recentIds })
 * Search the client list, pick one, or add a new client (name + club) without leaving the form.
 * recentIds (most recent sale first) are offered before anyone has typed.
 */
export function ClientPicker({ store, clients = [], value, onChange, recentIds = [] }) {
  const labelId = useId('client-picker');
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  // Clients added here, shown before the store's list catches up.
  const [added, setAdded] = useState([]);

  const known = useMemo(() => {
    const byId = new Map(clients.map((client) => [client.id, client]));
    for (const client of added) if (!byId.has(client.id)) byId.set(client.id, client);
    return byId;
  }, [clients, added]);

  const matches = useMemo(() => {
    const active = [...known.values()].filter((client) => !client.archived);
    const tokens = normaliseText(query).trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
      const recent = [...new Set(recentIds)].map((id) => known.get(id)).filter((client) => client && !client.archived);
      const recentSet = new Set(recent);
      return [...recent, ...active.filter((client) => !recentSet.has(client))].slice(0, PICKER_LIMIT);
    }
    return active.filter((client) => {
      const haystack = clientHaystack(client);
      return tokens.every((token) => haystack.includes(token));
    }).slice(0, PICKER_LIMIT);
  }, [known, query, recentIds]);

  const choose = (client) => {
    onChange(client.id);
    setQuery('');
  };

  const onCreated = (client) => {
    setAdded((list) => [...list, client]);
    setAdding(false);
    choose(client);
  };

  const selected = value ? known.get(value) ?? null : null;
  let body;
  if (value) {
    body = html`<div class="list" style=${BOXED}>
      <div class="list-item">
        <span class="sheet-link-icon" aria-hidden="true"><${Icon} name="user" size=${18} /></span>
        <div class="list-main">
          <div class="list-title">${selected ? selected.name : 'Client not found'}</div>
          <div class="list-sub">${selected ? clientDetails(selected) || 'No club yet' : 'They may have been deleted.'}</div>
        </div>
        <${Button} kind="ghost" size="sm" onClick=${() => onChange('')}>Change<//>
      </div>
    </div>`;
  } else if (adding) {
    body = html`<${QuickClient}
      store=${store}
      initialName=${query.trim()}
      onCreated=${onCreated}
      onCancel=${() => setAdding(false)}
    />`;
  } else {
    // Enter in the search box picks the top match instead of submitting the surrounding form.
    const onKeyDown = (event) => {
      if (event.key !== 'Enter' || !(event.target instanceof HTMLInputElement)) return;
      event.preventDefault();
      if (matches.length > 0 && query.trim()) choose(matches[0]);
    };
    body = html`<div class="stack-sm">
      <div onKeyDown=${onKeyDown}>
        <${SearchBox} value=${query} onInput=${setQuery} placeholder="Search clients by name or club" label="Search clients" />
      </div>
      <div class="list" style=${BOXED} role="group" aria-labelledby=${labelId}>
        ${matches.map((client) => html`<button key=${client.id} type="button" class="list-item" onClick=${() => choose(client)}>
          <div class="list-main">
            <div class="list-title">${client.name}</div>
            <div class="list-sub">${clientDetails(client) || 'No club yet'}</div>
          </div>
          <${Icon} name="chevron-right" size=${18} class="faint" />
        </button>`)}
        ${query.trim() && matches.length === 0 && html`<div class="list-item muted small">No clients match “${query.trim()}”.</div>`}
        <button type="button" class="list-item tone-signal" onClick=${() => setAdding(true)}>
          <${Icon} name="plus" size=${18} />
          <span class="list-main strong">${query.trim() ? `Add “${query.trim()}” as a new client` : 'New client'}</span>
        </button>
      </div>
      <p class="tiny faint">Optional — a sale with a client shows on their profile and gets their drop-off address.</p>
    </div>`;
  }

  return html`<div class="field">
    <span class="field-label" id=${labelId}>Client</span>
    ${body}
  </div>`;
}

// Inline "new client" form: name and club now, the rest later on their profile.
function QuickClient({ store, initialName, onCreated, onCancel }) {
  const boxRef = useRef(null);
  const [name, setName] = useState(initialName ?? '');
  const [club, setClub] = useState('');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    boxRef.current?.querySelector('input')?.focus();
  }, []);

  async function create() {
    if (saving) return;
    if (!name.trim()) {
      setError('Enter their name.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const client = await store.clients.create({ name: name.trim(), club: club.trim() });
      toast(`Added ${client.name} to your clients.`, { tone: 'gain' });
      onCreated(client);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  }

  // Enter in either box adds the client (and must not submit the surrounding sale form).
  const onKeyDown = (event) => {
    if (event.key !== 'Enter' || !(event.target instanceof HTMLInputElement)) return;
    event.preventDefault();
    create();
  };

  return html`<div class="stack-sm" style=${BOXED_PAD} ref=${boxRef} onKeyDown=${onKeyDown}>
    <div style=${FIELD_GRID}>
      <${Field} label="Name" required error=${error}>
        <${Input} value=${name} autocomplete="off" onInput=${(event) => setName(event.currentTarget.value)} />
      <//>
      <${Field} label="Club">
        <${Input} value=${club} autocomplete="off" placeholder="e.g. Southampton" onInput=${(event) => setClub(event.currentTarget.value)} />
      <//>
    </div>
    <div class="row">
      <${Button} kind="primary" size="sm" icon="plus" loading=${saving} onClick=${create}>Add client<//>
      <${Button} kind="ghost" size="sm" onClick=${onCancel} disabled=${saving}>Cancel<//>
    </div>
    <p class="tiny faint">Add sizes, addresses and their agent later on their profile.</p>
  </div>`;
}

// ---------------------------------------------------------------------------------------------
// Item and cost fields
// ---------------------------------------------------------------------------------------------

function stockLabel({ stock, available }) {
  const parts = [stock.name, stock.size].filter(Boolean).join(' · ');
  return `${parts} — ${money(stock.unit_cost)} · ${available > 0 ? `${available} left` : 'none left'}`;
}

function varianceHint(row, qty) {
  const variance = itemTotals({ ...row, qty }).variance;
  if (variance === null) return null;
  const each = money(row.expected_unit_cost);
  if (Math.abs(variance) < EPS) return `Exactly the ${each} you expected.`;
  return variance > 0
    ? `${money(variance)} cheaper than the ${each} each you expected.`
    : `${money(-variance)} more than the ${each} each you expected.`;
}

/**
 * ItemFields({ draft, onChange(patch), errors, stockChoices, maxQty, title, onRemove })
 * One sale line: what it is, how many, the sale price, and where it comes from — "Need to buy"
 * (expected cost), "Bought" (what was paid) or "From stock" (a stock line's cost). Shows the
 * line's own sale, cost and profit as it is typed.
 */
export function ItemFields({ draft, onChange, errors = {}, stockChoices = [], maxQty, title, onRemove }) {
  const stockById = useMemo(() => new Map(stockChoices.map((choice) => [choice.stock.id, choice.stock])), [stockChoices]);
  const row = itemRowFromDraft(draft, stockById);
  const line = itemTotals(row);
  const chosen = stockChoices.find((choice) => choice.stock.id === draft.stock_item_id) ?? null;
  const today = todayISO();

  const text = (key) => (event) => onChange({ [key]: event.currentTarget.value });

  const pickStock = (id) => {
    const stock = stockById.get(id);
    if (!stock) {
      onChange({ stock_item_id: id });
      return;
    }
    onChange({
      stock_item_id: id,
      unit_cost: amountText(stock.unit_cost),
      description: trimmed(draft.description) ? draft.description : stock.name ?? '',
      brand: draft.brand || stock.brand || '',
      size: draft.size || stock.size || '',
      sku: draft.sku || stock.sku || '',
    });
  };

  let sourceFields;
  if (draft.source === 'buy') {
    sourceFields = html`<div style=${FIELD_GRID}>
      <${Field} label="Expected cost each" required error=${errors.expected_unit_cost}>
        <${Input} prefix="£" inputmode="decimal" autocomplete="off" placeholder="0.00" value=${draft.expected_unit_cost} onInput=${text('expected_unit_cost')} />
      <//>
      <${Field} label="Buying from">
        <${Input} autocomplete="off" placeholder="e.g. Nike app, StockX" value=${draft.supplier} onInput=${text('supplier')} />
      <//>
    </div>
    <p class="tiny faint">Your best guess. Profit stays pending until you mark it bought.</p>`;
  } else if (draft.source === 'bought') {
    const hint = draft.keepExpected ? varianceHint(row, row.qty) : null;
    sourceFields = html`<div style=${FIELD_GRID}>
      <${Field} label="Paid each" required error=${errors.unit_cost} hint=${hint}>
        <${Input} prefix="£" inputmode="decimal" autocomplete="off" placeholder="0.00" value=${draft.unit_cost} onInput=${text('unit_cost')} />
      <//>
      <${Field} label="Bought from">
        <${Input} autocomplete="off" placeholder="e.g. Selfridges" value=${draft.supplier} onInput=${text('supplier')} />
      <//>
      <${Field} label="Bought on">
        <${Input} type="date" max=${today} value=${draft.sourced_at} onInput=${text('sourced_at')} />
      <//>
    </div>`;
  } else if (stockChoices.length === 0) {
    sourceFields = html`<p class="small muted">
      Nothing in stock right now. Add what you hold on the <a href="#/stock">Stock</a> page, or pick
      "Need to buy" or "Bought".
    </p>`;
  } else {
    const hint = chosen
      ? [
        `${money(chosen.stock.unit_cost)} each`,
        chosen.stock.bought_at && `bought ${formatDate(chosen.stock.bought_at)}`,
        chosen.stock.supplier && `from ${chosen.stock.supplier}`,
      ].filter(Boolean).join(' · ')
      : null;
    sourceFields = html`<${Field} label="Stock item" required error=${errors.stock_item_id} hint=${hint}>
      <${Select}
        value=${draft.stock_item_id}
        placeholder="Choose what you're selling"
        options=${stockChoices.map((choice) => ({ value: choice.stock.id, label: stockLabel(choice) }))}
        onChange=${(event) => pickStock(event.currentTarget.value)}
      />
    <//>`;
  }

  const stockQtyHint = draft.source === 'stock' && chosen && maxQty !== undefined ? `${Math.max(0, maxQty)} available` : null;

  return html`<div class="stack-sm">
    <div class="row row-between">
      <span class="strong">${title}</span>
      ${onRemove && html`<${Button} kind="ghost" size="sm" icon="trash" onClick=${onRemove} aria-label=${`Remove ${title}`}>Remove<//>`}
    </div>
    <${Field} label="Description" required error=${errors.description}>
      <${Input} autocomplete="off" placeholder="e.g. Nike Air Jordan 1 Chicago" value=${draft.description} onInput=${text('description')} />
    <//>
    <div style=${FIELD_GRID}>
      <${Field} label="Brand">
        <${Input} autocomplete="off" value=${draft.brand} onInput=${text('brand')} />
      <//>
      <${Field} label="Size">
        <${Input} autocomplete="off" placeholder="e.g. UK 9" value=${draft.size} onInput=${text('size')} />
      <//>
      <${Field} label="Qty" required error=${errors.qty} hint=${stockQtyHint}>
        <${Input} inputmode="numeric" autocomplete="off" value=${draft.qty} onInput=${text('qty')} />
      <//>
      <${Field} label="Sale price each" required error=${errors.unit_price}>
        <${Input} prefix="£" inputmode="decimal" autocomplete="off" placeholder="0.00" value=${draft.unit_price} onInput=${text('unit_price')} />
      <//>
      <${Field} label="SKU">
        <${Input} autocomplete="off" value=${draft.sku} onInput=${text('sku')} />
      <//>
    </div>
    <div class="field">
      <span class="field-label" aria-hidden="true">Where's it coming from?</span>
      <${Segmented}
        full
        label="Where the item is coming from"
        options=${ITEM_SOURCES}
        value=${draft.source}
        onChange=${(source) => onChange({ source })}
      />
    </div>
    ${sourceFields}
    <p class="small muted row" style="gap:2px 12px">
      <span>${num(row.qty)} × ${money(num(row.unit_price))} = ${money(line.revenue)}</span>
      <span>Cost ${money(line.cost)}${line.isExpected && html` <span class="pill pill-warn">est.</span>`}</span>
      <span>Profit <${Money} value=${line.revenue - line.cost} tone="auto" /></span>
    </p>
  </div>`;
}

/** CostFields({ draft, onChange(patch), errors, title, onRemove }) — one extra cost. */
export function CostFields({ draft, onChange, errors = {}, title, onRemove }) {
  return html`<div class="stack-sm">
    ${title && html`<div class="row row-between">
      <span class="strong">${title}</span>
      ${onRemove && html`<${Button} kind="ghost" size="sm" icon="trash" onClick=${onRemove} aria-label=${`Remove ${title}`}>Remove<//>`}
    </div>`}
    <div style=${FIELD_GRID}>
      <${Field} label="Type">
        <${Select} options=${COST_KIND_OPTIONS} value=${draft.kind} onChange=${(event) => onChange({ kind: event.currentTarget.value })} />
      <//>
      <${Field} label="What for">
        <${Input}
          autocomplete="off"
          placeholder=${COST_PLACEHOLDERS[draft.kind] ?? ''}
          value=${draft.label}
          onInput=${(event) => onChange({ label: event.currentTarget.value })}
        />
      <//>
      <${Field} label="Amount" required error=${errors.amount}>
        <${Input}
          prefix="£"
          inputmode="decimal"
          autocomplete="off"
          placeholder="0.00"
          value=${draft.amount}
          onInput=${(event) => onChange({ amount: event.currentTarget.value })}
        />
      <//>
    </div>
    <${Switch}
      checked=${draft.is_expected}
      onChange=${(checked) => onChange({ is_expected: checked })}
      label="It's an estimate"
      hint="Not paid yet, so the sale's profit stays estimated."
    />
  </div>`;
}

// ---------------------------------------------------------------------------------------------
// Profit breakdown (the waterfall from sale price to what you keep)
// ---------------------------------------------------------------------------------------------

function KvRow({ label, note, value, kind, big }) {
  return html`<div class=${cx(kind === 'total' && 'kv-total', kind === 'sub' && 'kv-sub')}>
    <dt>${label}${note && html`<span class="tiny faint" style="display:block;font-weight:400">${note}</span>`}</dt>
    <dd style=${big ? 'font-size:17px' : undefined}>${value}</dd>
  </div>`;
}

/**
 * ProfitBreakdown({ totals, targetMargin, perHour = true }) — calc.dealTotals() as a waterfall:
 * sale price → goods → extras → gross → travel → profit → your time → after your time, then
 * profit per driving hour (perHour=false leaves that out where it is shown elsewhere).
 */
export function ProfitBreakdown({ totals: t, targetMargin, perHour = true }) {
  const drove = t.totalMinutes > 0 || t.travelCost > EPS;
  const hourlyRate = t.totalMinutes > 0 ? t.timeCost / (t.totalMinutes / 60) : 0;
  const varianceNote = t.variance === null
    ? null
    : t.variance >= 0 ? 'Bought cheaper than expected' : 'Cost more than expected';
  // Compared in money with calc's half-penny tolerance, as calc.assessDeal does.
  const marginNote = targetMargin > 0 && t.margin !== null
    ? `${t.netProfit >= targetMargin * t.revenue - EPS ? 'on' : 'under'} your ${pct(targetMargin)} target`
    : null;

  return html`<dl class="kv">
    <${KvRow} label="Sale price" value=${html`<${Money} value=${t.revenue} />`} />
    <${KvRow}
      label="Goods"
      note=${t.goodsCostExpected > EPS ? `${money(t.goodsCostExpected)} still to buy (estimate)` : null}
      value=${html`<${Money} value=${-t.goodsCost} />`}
    />
    ${t.variance !== null && html`<${KvRow}
      kind="sub"
      label="vs expected"
      note=${varianceNote}
      value=${html`<${Money} value=${t.variance} sign tone="auto" />`}
    />`}
    <${KvRow}
      label="Extra costs"
      note=${t.extraCostsExpected > EPS ? `${money(t.extraCostsExpected)} estimated` : null}
      value=${html`<${Money} value=${-t.extraCosts} />`}
    />
    <${KvRow} kind="total" label="Gross profit" value=${html`<${Money} value=${t.grossProfit} tone="auto" />`} />
    <${KvRow}
      label="Travel"
      note=${drove ? `${formatMiles(t.miles)} · fuel, wear and other costs` : 'No drive logged'}
      value=${html`<${Money} value=${-t.travelCost} />`}
    />
    <${KvRow}
      kind="total"
      big
      label="Profit"
      note=${t.margin !== null ? `${pct(t.margin)} margin${marginNote ? ` · ${marginNote}` : ''}` : null}
      value=${html`<${Money} value=${t.netProfit} tone="auto" />`}
    />
    ${t.totalMinutes > 0 && html`
      <${KvRow}
        label="Your time"
        note=${`${duration(t.totalMinutes)}${hourlyRate > 0 ? ` at ${money(hourlyRate)}/h` : ''}`}
        value=${html`<${Money} value=${-t.timeCost} />`}
      />
      <${KvRow} kind="total" label="After your time" value=${html`<${Money} value=${t.trueProfit} tone="auto" />`} />`}
    ${perHour && t.perDrivingHour !== null && html`<${KvRow}
      label="Per driving hour"
      note=${`${duration(t.drivingMinutes)} behind the wheel`}
      value=${html`<${Money} value=${t.perDrivingHour} tone="auto" />`}
    />`}
  </dl>`;
}

// ---------------------------------------------------------------------------------------------
// Sales list (#/sales)
// ---------------------------------------------------------------------------------------------

// Open sales with money still to come in (an enquiry isn't owed anything yet).
function isOwed(row) {
  return row.deal.status !== 'cancelled' && row.deal.status !== 'enquiry' && row.totals.balance > EPS;
}

const LIST_TABS = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'pending', label: 'Pending', test: (row) => row.totals.bucket === 'pending' },
  { id: 'realised', label: 'Realised', test: (row) => row.totals.bucket === 'realised' },
  { id: 'tobuy', label: 'To buy', test: (row) => row.deal.status !== 'cancelled' && row.toBuy > 0 },
  { id: 'unpaid', label: 'Unpaid', test: isOwed },
  { id: 'cancelled', label: 'Cancelled', test: (row) => row.deal.status === 'cancelled' },
];
const TAB_IDS = new Set(LIST_TABS.map((tab) => tab.id));

const byNewest = (a, b) => a.index - b.index; // the store lists newest first
const SORTS = [
  { value: 'newest', label: 'Newest first', compare: byNewest },
  { value: 'oldest', label: 'Oldest first', compare: (a, b) => b.index - a.index },
  { value: 'profit', label: 'Most profit', compare: (a, b) => b.totals.netProfit - a.totals.netProfit || byNewest(a, b) },
  { value: 'revenue', label: 'Biggest sale', compare: (a, b) => b.totals.revenue - a.totals.revenue || byNewest(a, b) },
  { value: 'owed', label: 'Most owed', compare: (a, b) => (isOwed(b) ? b.totals.balance : 0) - (isOwed(a) ? a.totals.balance : 0) || byNewest(a, b) },
  {
    value: 'due',
    label: 'Due soonest',
    compare: (a, b) => {
      const ad = a.deal.due_date ?? '';
      const bd = b.deal.due_date ?? '';
      if (ad === bd) return byNewest(a, b);
      if (!ad || !bd) return ad ? -1 : 1; // undated last
      return ad < bd ? -1 : 1;
    },
  },
];
const SORT_OPTIONS = SORTS.map(({ value, label }) => ({ value, label }));

function dealHaystack(deal) {
  const number = Number(deal.number);
  const parts = [
    dealNumber(number), `sm${String(number).padStart(4, '0')}`, `#${number}`,
    deal.title, deal.notes, deal.client?.name, deal.client?.club,
  ];
  for (const item of deal.items ?? []) parts.push(item.description, item.brand, item.sku, item.size, item.supplier);
  return normaliseText(parts.filter(Boolean).join(' '));
}

function listHref({ tab, q, sort }) {
  const query = new URLSearchParams();
  if (tab && tab !== 'all') query.set('tab', tab);
  if (q) query.set('q', q);
  if (sort && sort !== 'newest') query.set('sort', sort);
  const text = query.toString();
  return `#/sales${text ? `?${text}` : ''}`;
}

const OPEN_STATUSES = new Set(['enquiry', 'agreed', 'sourcing', 'ready']);

function SaleRow({ row, navigate }) {
  const { deal, totals, toBuy } = row;
  const href = `#/sales/${deal.id}`;
  const status = statusMeta[deal.status] ?? statusMeta.agreed;
  const payment = paymentMeta[totals.paymentStatus] ?? paymentMeta.none;
  const cancelled = deal.status === 'cancelled';
  const dueSoon = deal.due_date && OPEN_STATUSES.has(deal.status);
  const overdue = dueSoon && deal.due_date < todayISO();
  return html`<tr class="is-clickable" onClick=${() => navigate(href)}>
    <td class="cell-primary">
      <div class="row row-nowrap" style="gap:6px">
        <a href=${href} class="strong truncate" onClick=${(event) => event.stopPropagation()}>
          ${deal.client?.name ?? deal.title ?? 'No client'}
        </a>
        ${deal.client?.club && html`<span class="muted truncate" style="font-weight:400">${deal.client.club}</span>`}
      </div>
      <div class="small muted truncate" style="max-width:340px;font-weight:400">
        <span class="mono">${dealNumber(deal.number)}</span> · ${deal.client && deal.title ? `${deal.title} · ` : ''}${itemsSummary(deal.items)}
      </div>
      ${toBuy > 0 && !cancelled && html`<span class="pill pill-warn">${toBuy} to buy</span>`}
    </td>
    <td data-label="Sold">
      <span class="nowrap">${saleDate(deal.sale_date)}</span>
      ${dueSoon && html`<div class=${cx('tiny', overdue ? 'tone-loss' : 'faint')}>due ${relDays(deal.due_date)}</div>`}
    </td>
    <td data-label="Status"><${Badge} tone=${status.tone}>${status.label}<//></td>
    <td data-label="Revenue" class="num"><${Money} value=${totals.revenue} tone=${cancelled ? 'muted' : undefined} /></td>
    <td data-label="Profit" class="num">
      <${Money} value=${totals.netProfit} tone=${cancelled ? 'muted' : 'auto'} />
      ${totals.certainty === 'estimated' && !cancelled && html` <span class="pill pill-warn" title="Estimated: some costs are still expected">est.</span>`}
    </td>
    <td data-label="Payment">
      <${Badge} tone=${payment.tone}>${payment.label}<//>
      ${!cancelled && totals.balance > EPS && totals.paymentStatus !== 'unpaid' && html`<div class="tiny faint">${money(totals.balance)} due</div>`}
    </td>
  </tr>`;
}

function SalesList({ store, params, navigate }) {
  const { data: deals, error, loading, reload } = useStoreData(store, (s) => s.deals.list());
  const tab = TAB_IDS.has(params.tab) ? params.tab : 'all';
  const q = typeof params.q === 'string' ? params.q : '';
  const sort = SORTS.some((option) => option.value === params.sort) ? params.sort : 'newest';
  const setView = (patch) => navigate(listHref({ tab, q, sort, ...patch }), { replace: true });

  const rows = useMemo(() => (deals ?? []).map((deal, index) => ({
    deal,
    index,
    totals: dealTotals(deal),
    toBuy: itemsToBuy(deal).length,
    haystack: dealHaystack(deal),
  })), [deals]);

  const searched = useMemo(() => {
    const tokens = normaliseText(q).trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return rows;
    return rows.filter((row) => tokens.every((token) => row.haystack.includes(token)));
  }, [rows, q]);

  const tabs = LIST_TABS.map(({ id, label, test }) => ({ id, label, count: searched.filter(test).length }));
  const activeTab = LIST_TABS.find((entry) => entry.id === tab);
  const shown = useMemo(() => {
    const compare = SORTS.find((option) => option.value === sort).compare;
    return searched.filter(activeTab.test).sort(compare);
  }, [searched, activeTab, sort]);

  const live = shown.filter((row) => row.deal.status !== 'cancelled');
  const sum = (pick) => live.reduce((total, row) => total + pick(row), 0);
  const isEstimated = (row) => row.totals.certainty === 'estimated';
  const revenue = sum((row) => row.totals.revenue);
  const profit = sum((row) => row.totals.netProfit);
  const owed = sum((row) => (isOwed(row) ? row.totals.balance : 0));
  let profitNote = '';
  if (live.length > 0 && live.every(isEstimated)) profitNote = ' (estimated)';
  else if (live.some(isEstimated)) profitNote = ` (${money(sum((row) => (isEstimated(row) ? row.totals.netProfit : 0)))} of it estimated)`;

  const actions = html`<${Button} kind="primary" icon="plus" href="#/sales/new">New sale<//>`;
  const page = (body, subtitle) => html`<${Page} title="Sales" subtitle=${subtitle} actions=${actions}>${body}<//>`;

  if (loading) return page(html`<${Loading} label="Loading sales…" />`);
  if (error && !deals) {
    return page(html`<${Card}><${ErrorState} error=${error} title="Couldn't load your sales" onRetry=${reload} /><//>`);
  }
  if (rows.length === 0) {
    return page(html`<${Card}>
      <${Empty}
        icon="tag"
        title="No sales yet"
        body="Log a sale as soon as it's agreed — even before you've bought the item. Desk tracks the expected profit until it's real."
        action=${html`
          <${Button} kind="primary" icon="plus" href="#/sales/new">Add your first sale<//>
          <${Button} icon="calculator" href="#/check">Check a deal<//>`}
      />
    <//>`);
  }

  const cardTitle = plural(shown.length, 'sale');
  const cardSub = tab === 'cancelled'
    ? 'Cancelled sales are left out of every total.'
    : [`${money(revenue)} revenue`, `${money(profit)} profit${profitNote}`, owed > EPS && `${money(owed)} owed`]
      .filter(Boolean).join(' · ');

  return page(html`
    ${error && html`<${Banner} tone="warn" title="Couldn't refresh" actions=${html`<${Button} size="sm" onClick=${reload}>Try again<//>`}>${error.message}<//>`}
    <${Tabs} tabs=${tabs} value=${tab} onChange=${(id) => setView({ tab: id })} label="Filter sales" />
    <div class="toolbar">
      <${SearchBox}
        value=${q}
        onInput=${(text) => setView({ q: text })}
        placeholder="Search client, item, SKU or SM number"
        label="Search sales"
      />
      <${Select}
        aria-label="Sort sales"
        options=${SORT_OPTIONS}
        value=${sort}
        onChange=${(event) => setView({ sort: event.currentTarget.value })}
      />
    </div>
    <${Card} pad=${false} title=${cardTitle} subtitle=${cardSub}>
      ${shown.length === 0
        ? html`<${Empty}
            icon="search"
            title=${q ? `No sales match “${q}”` : `Nothing in ${activeTab.label}`}
            body=${q ? 'Try a client name, an item, a SKU or a number like SM-0007.' : 'Sales show up here as soon as they fit.'}
            action=${html`${q && html`<${Button} onClick=${() => setView({ q: '' })}>Clear search<//>`}
              ${tab !== 'all' && html`<${Button} kind="ghost" onClick=${() => setView({ tab: 'all' })}>Show all sales<//>`}`}
          />`
        : html`<div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th scope="col">Sale</th>
                  <th scope="col">Sold</th>
                  <th scope="col">Status</th>
                  <th scope="col" class="num">Revenue</th>
                  <th scope="col" class="num">Profit</th>
                  <th scope="col">Payment</th>
                </tr>
              </thead>
              <tbody>
                ${shown.map((row) => html`<${SaleRow} key=${row.deal.id} row=${row} navigate=${navigate} />`)}
              </tbody>
            </table>
          </div>`}
    <//>
  `, 'Every sale, what it made and what is still to come in.');
}

// ---------------------------------------------------------------------------------------------
// New sale (#/sales/new)
// ---------------------------------------------------------------------------------------------

/** Reads and clears the deal checker's hand-off; null when there is none or it's unreadable. */
function takePrefill() {
  try {
    const raw = window.sessionStorage.getItem(PREFILL_KEY);
    if (raw === null) return null;
    window.sessionStorage.removeItem(PREFILL_KEY);
    const data = JSON.parse(raw);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch {
    return null; // storage blocked or not JSON: start with an empty form
  }
}

function objects(list) {
  return Array.isArray(list) ? list.filter((entry) => entry && typeof entry === 'object') : [];
}

function initialSale(params) {
  const prefill = takePrefill() ?? {};
  const items = objects(prefill.items).map(draftFromItem);
  const trip = prefill.trip && typeof prefill.trip === 'object' ? prefill.trip : null;
  return {
    fromChecker: Boolean(prefill.items || prefill.trip),
    clientId: params.client || prefill.client_id || '',
    items: items.length ? items : [blankItem()],
    costs: objects(prefill.costs).map(draftFromCost),
    trip,
    details: {
      title: '',
      status: 'agreed',
      sale_date: todayISO(),
      due_date: '',
      delivery_method: 'drop_off',
      notes: '',
    },
    payment: { amount: '', method: 'bank' },
  };
}

async function loadNewSaleData(s) {
  const [clients, stock, deals, settings] = await Promise.all([
    s.clients.list({ includeArchived: true }),
    s.stock.list(),
    s.deals.list(),
    s.settings.get(),
  ]);
  return { clients, stock, deals, settings };
}

function NewSale({ store, params, navigate }) {
  const { data, error, loading, reload } = useStoreData(store, loadNewSaleData);
  const [initial] = useState(() => initialSale(params));
  const [clientId, setClientId] = useState(initial.clientId);
  const [items, setItems] = useState(initial.items);
  const [costs, setCosts] = useState(initial.costs);
  const [trip, setTrip] = useState(initial.trip);
  const [details, setDetails] = useState(initial.details);
  const [payment, setPayment] = useState(initial.payment);
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tripOpen, setTripOpen] = useState(false);
  const formRef = useRef(null);
  const dirtyRef = useRef(false);
  const savedRef = useRef(false);
  const stockAppliedRef = useRef(false);
  const dismissWarningRef = useRef(null); // the "check the highlighted fields" toast, if showing

  useEffect(() => () => dismissWarningRef.current?.(), []);

  // Anything typed counts as unsaved work worth a "leave this page?" warning on close.
  const firstRenderRef = useRef(true);
  useEffect(() => {
    if (firstRenderRef.current) firstRenderRef.current = false;
    else dirtyRef.current = true;
  }, [clientId, items, costs, trip, details, payment]);

  useEffect(() => {
    const warn = (event) => {
      if (!dirtyRef.current || savedRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  const stockRows = data?.stock ?? [];
  const deals = data?.deals ?? [];
  const settings = data?.settings ?? null;
  const levels = useMemo(() => stockLevels(stockRows, deals), [stockRows, deals]);
  const stockById = useMemo(() => new Map(stockRows.map((stock) => [stock.id, stock])), [stockRows]);
  const recentIds = useMemo(() => deals.map((deal) => deal.client_id).filter(Boolean), [deals]);

  // `#/sales/new?stock=<id>` (from the Stock page) starts the first line from that stock item.
  useEffect(() => {
    if (stockAppliedRef.current || !data || !params.stock) return;
    stockAppliedRef.current = true;
    const stock = stockById.get(params.stock);
    if (!stock || (levels.get(stock.id)?.onHand ?? 0) <= 0) return;
    setItems((list) => {
      const [first, ...rest] = list;
      const blank = first && !trimmed(first.description) && parseAmount(first.unit_price) === null;
      const line = blankItem({
        source: 'stock',
        stock_item_id: stock.id,
        unit_cost: amountText(stock.unit_cost),
        description: stock.name ?? '',
        brand: stock.brand ?? '',
        size: stock.size ?? '',
        sku: stock.sku ?? '',
      });
      return blank ? [line, ...rest] : [...list, line];
    });
  }, [data, params.stock, stockById, levels]);

  const otherStockLines = (key) => items
    .filter((item) => item.key !== key && item.source === 'stock')
    .map((item) => ({ stock_item_id: item.stock_item_id, qty: parseAmount(item.qty) ?? 0 }));
  const choicesFor = (item) => stockChoicesFor(stockRows, levels, otherStockLines(item.key), item.stock_item_id);
  const maxQtyFor = (item) => choicesFor(item).find((choice) => choice.stock.id === item.stock_item_id)?.available;

  const itemRows = items.map((item) => itemRowFromDraft(item, stockById));
  const costRows = costs.filter((cost) => !isBlankCost(cost)).map(costRowFromDraft);
  const paidAmount = parseAmount(payment.amount);
  const payments = paidAmount > 0 ? [{ amount: paidAmount }] : [];
  const totals = dealTotals(
    { status: details.status },
    { items: itemRows, costs: costRows, payments, trips: trip ? [trip] : [] },
  );

  const problems = {
    items: items.map((item) => itemProblems(item, { maxQty: maxQtyFor(item) })),
    costs: costs.map((cost) => (isBlankCost(cost) ? {} : costProblems(cost))),
    details: {
      sale_date: details.sale_date ? null : 'Enter the sale date.',
      due_date: details.due_date && details.sale_date && details.due_date < details.sale_date
        ? "Can't be before the sale date."
        : null,
    },
    payment: amountProblem(payment.amount, { required: false, allowZero: false }),
    noItems: items.length === 0 ? 'Add at least one item.' : null,
  };
  const invalid = problems.items.some(hasProblems) || problems.costs.some(hasProblems)
    || hasProblems(problems.details) || Boolean(problems.payment) || Boolean(problems.noItems);
  const shownProblems = showErrors ? problems : { items: [], costs: [], details: {}, payment: null, noItems: null };

  const updateItem = (key, patch) => setItems((list) => list.map((item) => (item.key === key ? { ...item, ...patch } : item)));
  const updateCost = (key, patch) => setCosts((list) => list.map((cost) => (cost.key === key ? { ...cost, ...patch } : cost)));
  const setDetail = (key) => (event) => setDetails((current) => ({ ...current, [key]: event.currentTarget.value }));
  const client = clientId ? (data?.clients ?? []).find((entry) => entry.id === clientId) ?? null : null;

  async function onSubmit(event) {
    event.preventDefault();
    if (saving) return;
    setShowErrors(true);
    if (invalid) {
      dismissWarningRef.current = toast(problems.noItems ?? 'Check the highlighted fields.', { tone: 'warn' });
      revealFirstError(formRef.current);
      return;
    }
    dismissWarningRef.current?.();
    setSaving(true);
    try {
      const created = await store.deals.create({
        deal: { client_id: clientId || null, ...details },
        items: itemRows,
        costs: costRows,
      });
      savedRef.current = true;
      const number = dealNumber(created.number);

      // The sale is saved; a drive or payment that fails is reported, not lost silently.
      const missed = [];
      if (trip) {
        try {
          await store.trips.create({ ...trip, deal_id: created.id, client_id: clientId || null });
        } catch (err) {
          missed.push(`the drive (${err.message})`);
        }
      }
      if (paidAmount > 0) {
        try {
          await store.payments.create(created.id, { amount: paidAmount, method: payment.method, paid_at: details.sale_date });
        } catch (err) {
          missed.push(`the payment (${err.message})`);
        }
      }
      toast(`Sale ${number} saved.`, { tone: 'gain' });
      if (missed.length) toast(`Couldn't save ${missed.join(' and ')}. Add it on the sale page.`, { tone: 'warn', duration: 0 });
      navigate(`#/sales/${created.id}`, { replace: true });
    } catch (err) {
      toast(err, { tone: 'loss' });
      setSaving(false);
    }
  }

  const page = (body) => html`<${Page}
    title="New sale"
    subtitle="Log it as soon as it's agreed — even if you still need to buy the item."
    back="#/sales"
  >${body}<//>`;

  if (loading) return page(html`<${Loading} label="Getting your clients and stock…" />`);
  if (error && !data) {
    return page(html`<${Card}><${ErrorState} error=${error} title="Couldn't start a new sale" onRetry=${reload} /><//>`);
  }

  const certainty = certaintyMeta[totals.certainty];
  const drives = DRIVEN_DELIVERY.has(details.delivery_method);
  const targetMargin = num(settings?.target_margin);

  return page(html`
    ${initial.fromChecker && html`<${Banner} tone="signal" icon="calculator" title="Filled in from the deal checker">
      Check the details, pick the client and save.
    <//>`}
    <form
      ref=${formRef}
      class="row row-top"
      style=${FORM_LAYOUT}
      noValidate=${true}
      onSubmit=${onSubmit}
      onKeyDown=${blockImplicitSubmit}
    >
      <div class="stack" style=${FORM_MAIN}>
        <${Card} title="Who's it for?">
          <${ClientPicker}
            store=${store}
            clients=${data.clients}
            value=${clientId}
            onChange=${setClientId}
            recentIds=${recentIds}
          />
        <//>

        <${Card}
          title="Items"
          subtitle="What they're buying, and whether you still need to get it."
        >
          <div class="stack">
            ${items.map((item, index) => html`<div key=${item.key} class="stack">
              ${index > 0 && html`<hr class="divider" />`}
              <${ItemFields}
                draft=${item}
                title=${items.length > 1 ? `Item ${index + 1}` : 'Item'}
                errors=${shownProblems.items[index]}
                stockChoices=${choicesFor(item)}
                maxQty=${maxQtyFor(item)}
                onChange=${(patch) => updateItem(item.key, patch)}
                onRemove=${items.length > 1 ? () => setItems((list) => list.filter((entry) => entry.key !== item.key)) : null}
              />
            </div>`)}
            ${shownProblems.noItems && html`<p class="field-error">${shownProblems.noItems}</p>`}
            <div>
              <${Button} icon="plus" onClick=${() => setItems((list) => [...list, blankItem()])}>Add another item<//>
            </div>
          </div>
        <//>

        <${Card} title="Extra costs" subtitle="Postage, fees, packaging — anything that isn't the item itself.">
          <div class="stack">
            ${costs.length === 0 && html`<p class="small muted">No extra costs.</p>`}
            ${costs.map((cost, index) => html`<div key=${cost.key} class="stack">
              ${index > 0 && html`<hr class="divider" />`}
              <${CostFields}
                draft=${cost}
                title=${`Cost ${index + 1}`}
                errors=${shownProblems.costs[index]}
                onChange=${(patch) => updateCost(cost.key, patch)}
                onRemove=${() => setCosts((list) => list.filter((entry) => entry.key !== cost.key))}
              />
            </div>`)}
            <div>
              <${Button} icon="plus" onClick=${() => setCosts((list) => [...list, blankCost()])}>Add a cost<//>
            </div>
          </div>
        <//>

        <${Card} title="Delivery">
          <div class="stack">
            <div style=${FIELD_GRID}>
              <${Field} label="How it gets to them">
                <${Select} options=${DELIVERY_OPTIONS} value=${details.delivery_method} onChange=${setDetail('delivery_method')} />
              <//>
              <${Field} label="Deliver by" error=${shownProblems.details.due_date}>
                <${Input} type="date" min=${details.sale_date || undefined} value=${details.due_date} onInput=${setDetail('due_date')} />
              <//>
            </div>
            ${trip
              ? html`<div class="row row-between row-top" style=${BOXED_PAD}>
                  <${TripSummary} trip=${trip} />
                  <div class="row">
                    <${Button} size="sm" icon="edit" onClick=${() => setTripOpen(true)}>Edit<//>
                    <${Button} kind="ghost" size="sm" icon="trash" aria-label="Remove the drive" onClick=${() => setTrip(null)} />
                  </div>
                </div>`
              : drives && html`<div class="row row-between" style=${BOXED_PAD}>
                  <span class="small muted" style="flex:1 1 220px">
                    Driving it over? Add the drive to see the real profit after fuel and your time.
                  </span>
                  <${Button} icon="car" onClick=${() => setTripOpen(true)}>Add the drive<//>
                </div>`}
          </div>
        <//>

        <${Card} title="Details">
          <div style=${FIELD_GRID}>
            <${Field} label="Status">
              <${Select} options=${statusOptions} value=${details.status} onChange=${setDetail('status')} />
            <//>
            <${Field} label="Sale date" required error=${shownProblems.details.sale_date}>
              <${Input} type="date" value=${details.sale_date} onInput=${setDetail('sale_date')} />
            <//>
            <${Field} label="Paid so far" error=${shownProblems.payment} hint="Deposit or full payment already received.">
              <${Input} prefix="£" inputmode="decimal" autocomplete="off" placeholder="0.00" value=${payment.amount}
                onInput=${(event) => setPayment((current) => ({ ...current, amount: event.currentTarget.value }))} />
            <//>
            ${paidAmount > 0 && html`<${Field} label="Paid by">
              <${Select} options=${PAYMENT_METHOD_OPTIONS} value=${payment.method}
                onChange=${(event) => setPayment((current) => ({ ...current, method: event.currentTarget.value }))} />
            <//>`}
            <${Field} label="Title" hint="Optional — a name to spot this sale by." class="span-all">
              <${Input} autocomplete="off" placeholder="e.g. Match-day boots for Saturday" value=${details.title} onInput=${setDetail('title')} />
            <//>
            <${Field} label="Notes" class="span-all">
              <${Textarea} value=${details.notes} onInput=${setDetail('notes')} placeholder="Anything to remember about this sale" />
            <//>
          </div>
        <//>
      </div>

      <div class="stack" style=${FORM_SIDE}>
        <${Card}
          title="Totals"
          actions=${html`<${Badge} tone=${certainty.tone}>${certainty.label}<//>`}
        >
          <div class="stack">
            <${ProfitBreakdown} totals=${totals} targetMargin=${targetMargin} />
            ${totals.certainty === 'estimated' && html`<p class="small muted">
              Estimated until ${plural(totals.expectedCount, 'cost')} ${totals.expectedCount === 1 ? 'is' : 'are'} confirmed —
              mark items bought on the sale page.
            </p>`}
            <${Button} kind="primary" type="submit" size="lg" block icon="check" loading=${saving}>
              ${saving ? 'Saving…' : 'Save sale'}
            <//>
            <${Button} kind="ghost" block href="#/sales" disabled=${saving}>Cancel<//>
          </div>
        <//>
      </div>
    </form>
    ${tripOpen && html`<${TripModal}
      store=${store}
      settings=${settings}
      title=${trip ? 'Edit the drive' : 'Add the drive'}
      trip=${trip}
      initialOrigin=${trip ? tripEnd(trip, 'origin') : homeLocation(settings)}
      initialDestination=${trip ? tripEnd(trip, 'dest') : clientDestination(client)}
      saveLabel="Use this drive"
      onSave=${async (planned) => {
        setTrip(planned);
        setTripOpen(false);
      }}
      onClose=${() => setTripOpen(false)}
    />`}
  `);
}

// ---------------------------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------------------------

export default function DealsView(props) {
  return props.params?.mode === 'new' ? html`<${NewSale} ...${props} />` : html`<${SalesList} ...${props} />`;
}

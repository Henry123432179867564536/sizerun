// Deal checker (#/check): "Will I make money?" before you say yes to a deal.
//
// Sale price, buy price, extra costs and an optional drive (the trip planner) go through
// calc.assessDeal for a live verdict — good, tight or losing money — with the reasons, the
// profit before and after your time, £ per driving hour and the prices that work: break-even,
// your hourly rate, your target margin, and the most you can pay. "Turn into a sale" hands the
// numbers to the new-sale form through sessionStorage. The form survives leaving the page
// (per tab) so a deal can be checked, compared and come back to.

import { html, useEffect, useRef, useState } from '../lib/preact.js';
import {
  Banner,
  Button,
  Card,
  Field,
  Icon,
  Input,
  Loading,
  Page,
  Stat,
  Switch,
  cx,
  toast,
  useStoreData,
} from '../lib/ui.js';
import { assessDeal, tripTotals } from '../lib/calc.js';
import { duration, money, pct } from '../lib/format.js';
import { DEFAULT_SETTINGS } from '../lib/store.js';
import TripPlanner, { tripProblems } from '../components/trip-planner.js';

const CSS = `
.check-layout { display: grid; gap: 16px; grid-template-columns: minmax(0, 1fr); align-items: start; }
.check-col { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.check-reasons { margin: 4px 0 0; padding-left: 18px; }
.check-reasons li + li { margin-top: 2px; }
.check-heading { margin: 0 0 2px; color: var(--ink); font-size: 13px; font-weight: 600; }
.check-result .kpis { margin: 2px 0; }
.check-result .kv dt small { display: block; color: var(--ink-3); font-size: 12px; }
.check-note { color: var(--ink-2); font-size: 13px; }
.check-more > summary { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 40px; color: var(--ink); font-size: 13px; font-weight: 600; list-style: none; cursor: pointer; }
.check-more > summary::-webkit-details-marker { display: none; }
.check-more > summary .icon { color: var(--ink-3); transition: transform 0.15s; }
.check-more[open] > summary .icon { transform: rotate(180deg); }
.check-actions { margin: 12px 0 -6px; }
.check-sticky { position: sticky; z-index: 5; bottom: calc(var(--tabbar-h) + var(--safe-b) + 10px); display: flex; align-items: center; gap: 10px; padding: 8px 8px 8px 14px; border: 1px solid var(--line-2); border-radius: var(--r-panel); background: var(--glass-surface); box-shadow: var(--shadow-pop); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); }
.check-sticky-text { display: flex; flex: 1 1 auto; flex-direction: column; min-width: 0; line-height: 1.3; text-align: left; }
.check-sticky-verdict { font-weight: 600; }
.check-sticky-sub { overflow: hidden; color: var(--ink-2); font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
@media (min-width: 900px) { .check-sticky { bottom: 16px; } }
@media (min-width: 1100px) {
  /* Columns stretch to the row so the result has room to stay in view while the left scrolls. */
  .check-layout { grid-template-columns: minmax(0, 1.3fr) minmax(330px, 1fr); align-items: stretch; }
  .check-result { position: sticky; top: 24px; max-height: calc(100dvh - 48px); overflow-y: auto; border-radius: var(--r-panel); }
  .check-result .stat { padding: 10px 12px; }
  .check-result .stat-value { font-size: 20px; }
  .check-sticky { display: none; }
}
`;

// View styles live with the view and are added to <head> once, on first import.
const STYLE_ID = 'desk-calculator-styles';
if (typeof document !== 'undefined' && !document.getElementById(STYLE_ID)) {
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.append(style);
}

const PREFILL_KEY = 'sizemill.desk.prefill';
const DRAFT_KEY = 'sizemill.desk.check';
const FIELDS = ['item', 'sale', 'buy', 'extra', 'rate', 'margin'];

const VERDICTS = {
  good: { title: 'Good deal', tone: 'gain', icon: 'check-circle', short: 'Good deal' },
  tight: { title: 'Tight — think twice', tone: 'warn', icon: 'alert', short: 'Tight' },
  loss: { title: 'Losing money', tone: 'loss', icon: 'alert', short: 'Losing money' },
};

// ---- form helpers -------------------------------------------------------------------------

// '' -> null; '£1,200.50' -> 1200.5; unreadable -> undefined.
function parseAmount(text) {
  const t = String(text ?? '').replace(/[£,%\s]/g, '');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

function amountError(text, { label = 'an amount', max } = {}) {
  const n = parseAmount(text);
  if (n === undefined) return `Enter ${label} as a number, like 450 or 1,200.50.`;
  if (n !== null && n < 0) return "Can't be negative.";
  if (n !== null && max !== undefined && n >= max) return `Keep it under ${max}.`;
  return null;
}

function valueOf(text) {
  const n = parseAmount(text);
  return n === undefined || n === null || n < 0 ? null : n;
}

function numberText(n) {
  return n === null || n === undefined || !Number.isFinite(Number(n)) ? '' : String(Number(n));
}

function initialForm(settings) {
  const s = { ...DEFAULT_SETTINGS, ...(settings ?? {}) };
  return {
    item: '',
    sale: '',
    buy: '',
    extra: '',
    rate: numberText(s.hourly_rate),
    margin: numberText(Math.round(Number(s.target_margin) * 1000) / 10),
    drive: true,
    trip: null,
  };
}

// Session storage can be missing, full or blocked; the checker then simply starts empty.
function readDraft() {
  try {
    const raw = window.sessionStorage.getItem(DRAFT_KEY);
    const draft = raw ? JSON.parse(raw) : null;
    if (!draft || typeof draft !== 'object') return null;
    if (!FIELDS.every((field) => typeof draft[field] === 'string')) return null;
    return {
      ...draft,
      drive: draft.drive !== false,
      trip: draft.trip && typeof draft.trip === 'object' ? draft.trip : null,
    };
  } catch {
    return null;
  }
}

function writeDraft(form) {
  try {
    window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify(form));
  } catch {
    // Not kept for this tab; the checker still works.
  }
}

function clearDraft() {
  try {
    window.sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    // Nothing stored, nothing to clear.
  }
}

function rateLabel(rate) {
  return `${money(rate, { pence: rate % 1 !== 0 })}/h`;
}

// ---- view ---------------------------------------------------------------------------------

export default function CalculatorView({ store, navigate }) {
  const { data: settings, error, loading, reload } = useStoreData(store, (s) => s.settings.get());
  if (loading) {
    return html`<${Page} title="Deal checker" subtitle="Will I make money?"><${Loading} /><//>`;
  }
  return html`<${Checker}
    store=${store}
    settings=${settings ?? DEFAULT_SETTINGS}
    settingsError=${settings ? null : error}
    onRetry=${reload}
    navigate=${navigate}
  />`;
}

function Checker({ store, settings, settingsError, onRetry, navigate }) {
  const [form, setForm] = useState(() => readDraft() ?? initialForm(settings));
  const [plannerKey, setPlannerKey] = useState(0);
  const [showErrors, setShowErrors] = useState(false);
  const resultRef = useRef(null);

  useEffect(() => writeDraft(form), [form]);

  const set = (field) => (event) => {
    const text = event.currentTarget.value;
    setForm((f) => ({ ...f, [field]: text }));
  };

  const salePrice = valueOf(form.sale);
  const buyPrice = valueOf(form.buy);
  const extraCosts = valueOf(form.extra) ?? 0;
  const rate = valueOf(form.rate) ?? 0;
  const marginPercent = valueOf(form.margin) ?? 0;
  const targetMargin = marginPercent < 100 ? marginPercent / 100 : 0;

  // One hourly rate: the field here and the planner's "Your time" edit the same number.
  const plannerValue = form.trip ? { ...form.trip, hourly_rate: rate } : null;
  const onTripChange = (trip) => setForm((f) => {
    const typed = valueOf(f.rate) ?? 0;
    const rateText = Number(trip.hourly_rate) === typed ? f.rate : numberText(trip.hourly_rate);
    return { ...f, trip, rate: rateText };
  });

  const trip = form.drive && form.trip ? { ...form.trip, hourly_rate: rate } : null;
  const result = assessDeal({ salePrice, buyPrice, extraCosts, trip, hourlyRate: rate, targetMargin });
  const ready = salePrice !== null && salePrice > 0;
  const verdict = VERDICTS[result.verdict];
  const tripIssues = trip ? tripProblems(trip) : {};
  const driveMinutes = trip ? tripTotals(trip).totalMinutes : 0;

  const errors = {
    sale: amountError(form.sale, { label: 'the sale price' }) ?? (showErrors && !ready ? 'Enter what the client will pay.' : null),
    buy: amountError(form.buy, { label: 'the buy price' }) ?? (showErrors && buyPrice === null ? "Enter what you'll pay for it (0 if nothing)." : null),
    extra: amountError(form.extra),
    rate: amountError(form.rate, { label: 'your hourly rate' }),
    margin: amountError(form.margin, { label: 'a percentage', max: 100 }),
  };

  const notes = [];
  if (ready && buyPrice === null) notes.push("No buy price yet, so the item is counted as free — add what you'll pay.");
  if (form.drive && trip && tripIssues.one_way_miles) notes.push("The drive has no miles yet, so travel isn't counted — calculate the route or type the miles.");
  else if (form.drive && trip && tripIssues.fuel_ppl) notes.push("There's no fuel price yet, so fuel isn't counted.");

  function turnIntoSale() {
    if (!ready || buyPrice === null || Object.values(errors).some(Boolean)) {
      setShowErrors(true);
      toast(!ready ? 'Enter the sale price first.' : buyPrice === null ? "Enter what you'll pay for it (0 if nothing)." : 'Fix the highlighted numbers first.', { tone: 'warn' });
      return;
    }
    const tripComplete = trip && Object.keys(tripIssues).length === 0;
    const prefill = {
      client_id: null,
      items: [{
        description: form.item.trim() || 'Item',
        unit_price: salePrice,
        qty: 1,
        cost_status: 'expected',
        expected_unit_cost: buyPrice,
      }],
      costs: extraCosts > 0 ? [{ label: 'Extra costs', kind: 'other', amount: extraCosts, is_expected: true }] : [],
      trip: tripComplete ? trip : null,
    };
    try {
      window.sessionStorage.setItem(PREFILL_KEY, JSON.stringify(prefill));
    } catch {
      toast("Couldn't pass the numbers to the new sale — this browser is blocking storage for the site.", { tone: 'loss' });
      return;
    }
    if (trip && !tripComplete) toast("The drive wasn't finished, so it wasn't added — log it from the sale.", { tone: 'warn' });
    navigate('#/sales/new');
  }

  function startAgain() {
    clearDraft();
    setForm(initialForm(settings));
    setPlannerKey((k) => k + 1);
    setShowErrors(false);
  }

  const scrollToResult = () => resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const dealCard = html`<${Card} title="The deal" subtitle="What you'll sell it for and what it costs you.">
    <div class="form-grid">
      <${Field} label="What is it?" hint="Optional — becomes the item on the sale." class="span-all">
        <${Input} type="text" value=${form.item} maxlength="200" placeholder="e.g. Nike Mercurial Superfly 10, UK 9" onInput=${set('item')} />
      <//>
      <${Field} label="Sale price" error=${errors.sale} required>
        <${Input} type="text" inputmode="decimal" autocomplete="off" prefix="£" value=${form.sale} placeholder="0.00" onInput=${set('sale')} />
      <//>
      <${Field} label="Buy price" hint="What you'll pay, or expect to pay." error=${errors.buy} required>
        <${Input} type="text" inputmode="decimal" autocomplete="off" prefix="£" value=${form.buy} placeholder="0.00" onInput=${set('buy')} />
      <//>
      <${Field} label="Extra costs" hint="Postage, fees, packaging." error=${errors.extra}>
        <${Input} type="text" inputmode="decimal" autocomplete="off" prefix="£" value=${form.extra} placeholder="0.00" onInput=${set('extra')} />
      <//>
      <${Field} label="Your hourly rate" hint="What an hour of driving is worth to you." error=${errors.rate}>
        <${Input} type="text" inputmode="decimal" autocomplete="off" prefix="£" suffix="/h" value=${form.rate} onInput=${set('rate')} />
      <//>
      <${Field} label="Target margin" hint="Profit as a share of the sale price." error=${errors.margin}>
        <${Input} type="text" inputmode="decimal" autocomplete="off" suffix="%" value=${form.margin} onInput=${set('margin')} />
      <//>
    </div>
  <//>`;

  const driveCard = html`<${Card}
    title="The drive"
    subtitle=${form.drive ? 'Fuel and your time to drop it off.' : 'No drive — posted, collected or handed over nearby.'}
    actions=${html`<${Switch} checked=${form.drive} label="I'm driving" onChange=${(drive) => setForm((f) => ({ ...f, drive }))} />`}
  >
    ${form.drive
      ? html`<${TripPlanner}
          key=${plannerKey}
          store=${store}
          settings=${settings}
          value=${plannerValue}
          onChange=${onTripChange}
          compact
        />`
      : html`<p class="check-note">Travel and time aren't counted. Turn on “I'm driving” to add a drop-off.</p>`}
  <//>`;

  const resultCard = html`<div ref=${resultRef} class="check-result">
    <${Card}
      title="Will I make money?"
      actions=${html`<${Button} kind="primary" size="sm" icon="tag" onClick=${turnIntoSale}>Turn into a sale<//>`}
    >
      ${!ready
        ? html`<p class="check-note">Enter the sale price and what you'll pay for it — the verdict, your profit and the prices that work show up here as you type.</p>`
        : html`<div class="stack">
            <${Banner} tone=${verdict.tone} icon=${verdict.icon} title=${verdict.title}>
              <ul class="check-reasons">${result.reasons.map((reason) => html`<li key=${reason}>${reason}</li>`)}</ul>
            <//>
            ${notes.map((note) => html`<p class="check-note" key=${note}>${note}</p>`)}
            <div class="kpis">
              <${Stat} label="Profit" value=${money(result.netProfit)} tone=${result.netProfit < 0 ? 'loss' : 'gain'} sub="After item, extras and the drive" />
              <${Stat}
                label="After your time"
                value=${money(result.trueProfit)}
                tone=${result.trueProfit < 0 ? 'loss' : result.timeCost > 0 ? 'gain' : undefined}
                sub=${result.timeCost > 0 ? `${duration(driveMinutes)} at ${rateLabel(rate)}` : 'No driving time counted'}
              />
              <${Stat}
                label="Per driving hour"
                value=${result.perDrivingHour === null ? '—' : money(result.perDrivingHour)}
                tone=${result.perDrivingHour === null ? undefined : result.perDrivingHour >= rate ? 'gain' : 'warn'}
                sub=${result.perDrivingHour === null ? 'No drive' : `Your rate is ${rateLabel(rate)}`}
              />
              <${Stat}
                label="Margin"
                value=${pct(result.margin)}
                tone=${result.margin === null ? undefined : targetMargin > 0 && result.margin < targetMargin ? 'warn' : result.margin < 0 ? 'loss' : 'gain'}
                sub=${targetMargin > 0 ? `Target ${pct(targetMargin)}` : 'No target set'}
              />
            </div>
            <div>
              <h3 class="check-heading">Prices that work</h3>
              <dl class="kv">
                <div><dt>Break-even<small>Covers the item, extras and the drive</small></dt><dd>${money(result.breakEvenPrice)}</dd></div>
                <div><dt>To earn ${rateLabel(rate)}<small>Also pays you for your time</small></dt><dd>${money(result.priceForRate)}</dd></div>
                <div><dt>For a ${pct(targetMargin)} margin<small>Your target margin</small></dt><dd>${result.priceForMargin === null ? '—' : money(result.priceForMargin)}</dd></div>
                <div><dt>Most you can pay<small>And still earn ${rateLabel(rate)}</small></dt><dd class=${cx(result.maxBuyPrice < 0 && 'tone-loss')}>${money(result.maxBuyPrice)}</dd></div>
              </dl>
            </div>
            <details class="check-more">
              <summary>How the profit adds up<${Icon} name="chevron-down" size=${18} /></summary>
              <dl class="kv">
                <div><dt>Sale price</dt><dd>${money(result.revenue)}</dd></div>
                <div class="kv-sub"><dt>Item</dt><dd>${money(-result.goodsCost)}</dd></div>
                ${result.extraCosts > 0 && html`<div class="kv-sub"><dt>Extra costs</dt><dd>${money(-result.extraCosts)}</dd></div>`}
                ${trip && html`<div class="kv-sub"><dt>Drive: fuel, wear, parking</dt><dd>${money(-result.travelCost)}</dd></div>`}
                <div class="kv-total"><dt>Profit</dt><dd class=${result.netProfit < 0 ? 'tone-loss' : 'tone-gain'}>${money(result.netProfit)}</dd></div>
                ${result.timeCost > 0 && html`<div class="kv-sub"><dt>Your time</dt><dd>${money(-result.timeCost)}</dd></div>`}
                ${result.timeCost > 0 && html`<div class="kv-total"><dt>After your time</dt><dd class=${result.trueProfit < 0 ? 'tone-loss' : 'tone-gain'}>${money(result.trueProfit)}</dd></div>`}
              </dl>
            </details>
          </div>`}
      <div class="row check-actions">
        <${Button} kind="ghost" size="sm" icon="refresh" onClick=${startAgain}>Start again<//>
      </div>
    <//>
  </div>`;

  return html`<${Page} title="Deal checker" subtitle="Will I make money? Check a deal before you say yes.">
    ${settingsError && html`<${Banner}
      tone="warn"
      title="Couldn't load your settings"
      actions=${html`<${Button} size="sm" icon="refresh" onClick=${onRetry}>Try again<//>`}
    >Using the standard car, fuel and hourly rate for now. ${settingsError.message}<//>`}
    <div class="check-layout">
      <div class="check-col">
        ${dealCard}
        ${driveCard}
        ${ready && html`<button type="button" class="check-sticky" onClick=${scrollToResult} aria-label=${`${verdict.short}: ${money(result.netProfit)} profit. Show the full result.`}>
          <span class="check-sticky-text">
            <span class=${cx('check-sticky-verdict', `tone-${verdict.tone}`)}>${verdict.short} · ${money(result.netProfit)}</span>
            <span class="check-sticky-sub">${result.timeCost > 0 ? `${money(result.trueProfit)} after your time` : `${pct(result.margin)} margin`}</span>
          </span>
          <span class="btn btn-secondary btn-sm" aria-hidden="true">See result</span>
        </button>`}
      </div>
      <div class="check-col">${resultCard}</div>
    </div>
  <//>`;
}

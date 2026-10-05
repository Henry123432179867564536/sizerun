// Suppliers (#/suppliers): everyone you've bought from, built from the "Bought from" on sale
// lines and stock — a reference list, no separate records to keep. Tap a supplier to see what
// you bought from them, each linking back to its sale or to stock.

import { html, useMemo, useState } from '../lib/preact.js';
import { Badge, Card, Empty, ErrorState, Icon, Loading, Page, SearchBox, useStoreData } from '../lib/ui.js';
import { dealNumber } from '../lib/calc.js';
import { date as formatDate, money, plural } from '../lib/format.js';
import { normalize, supplierHistory } from '../lib/search.js';

const STYLE_ID = 'desk-suppliers-styles';
const CSS = `
.sup-list { list-style: none; margin: 0; padding: 0; }
.sup-row + .sup-row { border-top: 1px solid var(--line); }
.sup-head { display: flex; width: 100%; align-items: center; gap: 12px; min-height: 56px; padding: 12px 16px; border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.sup-head:hover { background: var(--surface-2); }
.sup-main { flex: 1 1 auto; min-width: 0; }
.sup-name { display: block; font-weight: 600; overflow-wrap: anywhere; }
.sup-sub { display: block; margin-top: 2px; color: var(--ink-3); font-size: 13px; }
.sup-spent { flex: none; text-align: right; font-variant-numeric: tabular-nums; }
.sup-spent small { display: block; color: var(--ink-3); font-size: 12px; }
.sup-chev { flex: none; display: grid; place-items: center; color: var(--ink-3); transition: transform 120ms ease; }
.sup-row.is-open .sup-chev { transform: rotate(180deg); }
.sup-items { list-style: none; margin: 0; padding: 0 16px 12px; }
.sup-item { display: flex; align-items: baseline; gap: 12px; padding: 8px 0; border-top: 1px dashed var(--line); }
.sup-item a { color: inherit; text-decoration: none; flex: 1 1 auto; min-width: 0; }
.sup-item-title { overflow-wrap: anywhere; }
.sup-item-sub { display: block; color: var(--ink-3); font-size: 13px; }
.sup-item-cost { flex: none; font-variant-numeric: tabular-nums; }
@media (prefers-reduced-motion: reduce) { .sup-chev { transition: none; } }
`;

function injectStyles() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.append(style);
}

async function loadSuppliers(store) {
  const [deals, stock] = await Promise.all([store.deals.list(), store.stock.list({ includeArchived: true })]);
  return { deals, stock };
}

function SupplierRow({ supplier, open, onToggle }) {
  const sub = [
    plural(supplier.units, 'item'),
    supplier.lastDate && `last ${formatDate(supplier.lastDate)}`,
  ].filter(Boolean).join(' · ');
  return html`<li class=${`sup-row${open ? ' is-open' : ''}`}>
    <button type="button" class="sup-head" aria-expanded=${open ? 'true' : 'false'} onClick=${onToggle}>
      <span class="sup-main">
        <span class="sup-name">${supplier.name}</span>
        <span class="sup-sub">${sub}</span>
      </span>
      <span class="sup-spent">${money(supplier.spent, { pence: false })}<small>spent</small></span>
      <span class="sup-chev"><${Icon} name="chevron-down" size=${18} /></span>
    </button>
    ${open && html`<ul class="sup-items">
      ${supplier.items.map((item, index) => {
        const href = item.dealId ? `#/sales/${item.dealId}` : '#/stock';
        const where = item.dealId ? (item.dealNumber ? dealNumber(item.dealNumber) : 'Sale') : 'Stock';
        const sub = [item.size, item.qty > 1 && `×${item.qty}`, item.date && formatDate(item.date), where].filter(Boolean).join(' · ');
        return html`<li key=${index} class="sup-item">
          <a href=${href}>
            <span class="sup-item-title">${item.description || 'Item'}</span>
            <span class="sup-item-sub">${sub}</span>
          </a>
          ${item.planned && html`<${Badge} tone="warn">planned<//>`}
          <span class="sup-item-cost">${money(item.unitCost)}${item.qty > 1 ? ' each' : ''}</span>
        </li>`;
      })}
    </ul>`}
  </li>`;
}

export default function SuppliersView({ store }) {
  injectStyles();
  const { data, error, loading, reload } = useStoreData(store, loadSuppliers);
  const [q, setQ] = useState('');
  const [openName, setOpenName] = useState(null);
  const suppliers = useMemo(() => supplierHistory({ deals: data?.deals ?? [], stock: data?.stock ?? [] }), [data]);
  const shown = useMemo(() => {
    const words = normalize(q).split(' ').filter(Boolean);
    if (!words.length) return suppliers;
    return suppliers.filter((s) => {
      const parts = normalize(s.name).split(' ');
      return words.every((w) => parts.some((p) => p.startsWith(w)));
    });
  }, [suppliers, q]);

  const page = (body) => html`<${Page} title="Suppliers" subtitle="Everyone you've bought from, built from “Bought from” on your sales and stock.">${body}<//>`;
  if (loading) return page(html`<${Loading} label="Loading suppliers…" />`);
  if (error && !data) return page(html`<${Card}><${ErrorState} error=${error} title="Couldn't load your suppliers" onRetry=${reload} /><//>`);
  if (!suppliers.length) {
    return page(html`<${Card}>
      <${Empty}
        icon="inbox"
        title="No suppliers yet"
        body="Fill in “Bought from” when you log a sale or add stock — StockX, GOAT, or a contact like Charlie — and they'll be listed here, ready to pick next time."
      />
    <//>`);
  }

  const spent = suppliers.reduce((sum, s) => sum + s.spent, 0);
  return page(html`
    <div class="toolbar"><${SearchBox} value=${q} onInput=${setQ} placeholder="Search suppliers" label="Search suppliers" /></div>
    <${Card} title=${plural(shown.length, 'supplier')} subtitle=${`${money(spent, { pence: false })} spent in total`} pad=${false}>
      ${shown.length
        ? html`<ul class="sup-list">
            ${shown.map((supplier) => html`<${SupplierRow}
              key=${supplier.name}
              supplier=${supplier}
              open=${openName === supplier.name}
              onToggle=${() => setOpenName((current) => (current === supplier.name ? null : supplier.name))}
            />`)}
          </ul>`
        : html`<p class="muted" style="padding:16px">No supplier matches “${q}”.</p>`}
    <//>
  `);
}

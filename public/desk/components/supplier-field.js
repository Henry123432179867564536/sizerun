// "Bought from" box with your suppliers (and the common platforms) to pick from.
// history: supplierHistory(...) from lib/search.js; the most-used come first, and with nothing
// typed the regulars are offered straight away.

import { html, useMemo } from '../lib/preact.js';
import { SuggestField } from '../lib/ui.js';
import { suggestSuppliers } from '../lib/search.js';
import { date as formatDate } from '../lib/format.js';

export default function SupplierField({ label = 'Bought from', value, onChange, history = [], hint, placeholder = 'e.g. StockX or a contact', class: classAttr }) {
  const suggestions = useMemo(() => suggestSuppliers(history, value).map((entry) => ({
    key: entry.name,
    title: entry.name,
    value: entry.name,
    sub: entry.lines
      ? `${entry.lines} item${entry.lines === 1 ? '' : 's'} bought${entry.lastDate ? ` · last ${formatDate(entry.lastDate)}` : ''}`
      : null,
  })), [history, value]);
  return html`<${SuggestField}
    class=${classAttr}
    label=${label}
    hint=${hint}
    placeholder=${placeholder}
    value=${value ?? ''}
    suggestions=${suggestions}
    openOnFocus
    listLabel="Suppliers"
    onInput=${onChange}
    onPick=${(entry) => onChange(entry.value)}
  />`;
}

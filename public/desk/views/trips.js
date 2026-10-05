// Trips (#/trips): plan a drive, save it (optionally linked to a sale and a client), and look
// back over every saved drive — miles, time, fuel and cash cost — with totals for a period.
//
// The planner card on top doubles as the editor: "Edit" loads a saved trip into it. The
// address `#/trips?deal=<id>` (or `?client=<id>`) starts a new trip already linked to that
// sale or client, heading to the client's first saved address.

import { html, useEffect, useMemo, useRef, useState } from '../lib/preact.js';
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorState,
  Field,
  Input,
  Loading,
  Page,
  Segmented,
  Select,
  Stat,
  confirmDialog,
  toast,
  useStoreData,
} from '../lib/ui.js';
import { dealNumber, tripTotals } from '../lib/calc.js';
import { date as formatDate, duration, miles as formatMiles, money, moneyShort, monthLabel, plural, todayISO } from '../lib/format.js';
import TripPlanner, { tripProblems } from '../components/trip-planner.js';
import { BarChart } from '../components/charts.js';
import { ListRow } from './clients.js';

const PERIODS = [
  { value: 'month', label: 'This month', short: 'Month' },
  { value: '30d', label: 'Last 30 days', short: '30 days' },
  { value: 'year', label: 'This year', short: 'Year' },
  { value: 'all', label: 'All time', short: 'All' },
];

const CHART_MONTHS = 12;
const PHONE_QUERY = '(max-width: 639.98px)';

const CSS = `
.trips-sub { font-weight: 400; }
.trips-kpis .stat-sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.trips-form-foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; }
.trips-form-foot .trips-delete { margin-right: auto; }
.trips-period .segmented { width: 100%; }
@media (min-width: 640px) {
  .trips-period .segmented { width: auto; }
}
`;

const STYLE_ID = 'desk-trips-styles';
if (typeof document !== 'undefined' && !document.getElementById(STYLE_ID)) {
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.append(style);
}
const litresFormat = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });

async function loadTripsPage(store) {
  const [trips, deals, clients, settings] = await Promise.all([
    store.trips.list(),
    store.deals.list(),
    store.clients.list({ includeArchived: true }),
    store.settings.get(),
  ]);
  return { trips, deals, clients, settings };
}

// ---- helpers ------------------------------------------------------------------------------

function clean(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function isoDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return todayISO(d);
}

function lastDayOfMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate(); // day 0 of the next month
}

/**
 * Trip-date range for a period, both ends inclusive ({} = all time). Like the dashboard's,
 * it has an end too, so a drive planned for a later date isn't counted in this month's or the
 * last 30 days' totals.
 */
export function periodRange(period, today = todayISO()) {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  if (period === 'month') return { from: `${today.slice(0, 7)}-01`, to: `${today.slice(0, 7)}-${String(lastDayOfMonth(year, month)).padStart(2, '0')}` };
  if (period === '30d') return { from: isoDaysAgo(29), to: today };
  if (period === 'year') return { from: `${year}-01-01`, to: `${year}-12-31` };
  return {};
}

/** True when the trip's date falls inside `range` (always, for all time). */
export function inPeriod(trip, range) {
  if (!range.from) return true;
  const day = typeof trip?.trip_date === 'string' ? trip.trip_date.slice(0, 10) : '';
  return day >= range.from && day <= range.to;
}

// "St Mary's Stadium" from "St Mary's Stadium, Britannia Road, Southampton SO14 5FP".
function shortPlace(label, address) {
  const text = clean(label) ?? clean(address);
  if (!text) return null;
  return text.split(',')[0].trim();
}

function routeText(trip) {
  const from = shortPlace(trip.origin_label, trip.origin_address) ?? 'Start';
  const to = shortPlace(trip.dest_label, trip.dest_address) ?? 'Destination';
  return `${from} → ${to}`;
}

function firstAddress(client) {
  const list = Array.isArray(client?.addresses) ? client.addresses : [];
  const place = list.find((a) => a && (clean(a.address) || (Number.isFinite(Number(a.lat)) && a.lat !== null)));
  if (!place) return null;
  return { label: clean(place.label), address: clean(place.address), lat: place.lat ?? null, lng: place.lng ?? null };
}

function destinationFields(place) {
  const located = place && place.lat !== null && place.lng !== null && Number.isFinite(Number(place.lat)) && Number.isFinite(Number(place.lng));
  return {
    dest_label: clean(place?.label),
    dest_address: clean(place?.address),
    dest_lat: located ? Number(place.lat) : null,
    dest_lng: located ? Number(place.lng) : null,
    route_geometry: null,
  };
}

function hasDestination(trip) {
  return Boolean(trip && (clean(trip.dest_address) || clean(trip.dest_label) || (trip.dest_lat !== null && trip.dest_lat !== undefined)));
}

function dealLabel(deal) {
  const parts = [dealNumber(deal.number), deal.client?.name ?? 'No client'];
  if (clean(deal.title)) parts.push(deal.title.trim());
  return `${parts.join(' · ')}${deal.status === 'cancelled' ? ' (cancelled)' : ''}`;
}

// True while the viewport matches `query`; follows rotation and window resizes.
function useMedia(query) {
  const list = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query) : null;
  const [matches, setMatches] = useState(() => Boolean(list?.matches));
  useEffect(() => {
    if (!list) return undefined;
    const onChange = (event) => setMatches(event.matches);
    list.addEventListener('change', onChange);
    setMatches(list.matches);
    return () => list.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

let editorSequence = 0;

// A fresh editor: a new trip, linked to the sale/client in the address when there is one.
function newEditor({ params = {}, deals = [], clients = [] } = {}) {
  editorSequence += 1;
  const deal = params.deal ? deals.find((d) => d.id === params.deal) : null;
  const clientId = deal?.client_id ?? params.client ?? null;
  const client = clientId ? clients.find((c) => c.id === clientId) : null;
  return {
    key: `new-${editorSequence}`,
    id: null,
    trip: null, // the planner fills in a new trip from settings
    destination: firstAddress(client),
    meta: {
      trip_date: todayISO(),
      label: '',
      deal_id: deal?.id ?? '',
      client_id: client?.id ?? '',
    },
  };
}

function editorFor(trip) {
  editorSequence += 1;
  return {
    key: `edit-${trip.id}-${editorSequence}`,
    id: trip.id,
    trip,
    destination: null,
    meta: {
      trip_date: trip.trip_date ?? todayISO(),
      label: trip.label ?? '',
      deal_id: trip.deal_id ?? '',
      client_id: trip.client_id ?? '',
    },
  };
}

function totalsFor(trips) {
  const sum = { count: 0, miles: 0, drivingMinutes: 0, totalMinutes: 0, litres: 0, fuelCost: 0, cashCost: 0, timeCost: 0, linked: 0 };
  for (const trip of trips) {
    const t = tripTotals(trip);
    sum.count += 1;
    sum.miles += t.miles;
    sum.drivingMinutes += t.drivingMinutes;
    sum.totalMinutes += t.totalMinutes;
    sum.litres += t.litres;
    sum.fuelCost += t.fuelCost;
    sum.cashCost += t.cashCost;
    sum.timeCost += t.timeCost;
    if (trip.deal_id) sum.linked += 1;
  }
  return sum;
}

// Fuel and everything else (wear, parking, tolls) per month, oldest first, last 12 months.
function monthlyCosts(trips) {
  const months = new Map();
  for (const trip of trips) {
    const month = typeof trip.trip_date === 'string' ? trip.trip_date.slice(0, 7) : null;
    if (!month) continue;
    const t = tripTotals(trip);
    const entry = months.get(month) ?? { fuel: 0, other: 0 };
    entry.fuel += t.fuelCost;
    entry.other += t.wearCost + t.otherCosts;
    months.set(month, entry);
  }
  return [...months.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(-CHART_MONTHS)
    .map(([month, entry]) => ({ month, ...entry }));
}

// ---- view ---------------------------------------------------------------------------------

export default function TripsView({ store, params }) {
  const { data, error, loading, reload } = useStoreData(store, loadTripsPage);

  if (loading) {
    return html`<${Page} title="Trips" subtitle="Drives, miles and fuel costs"><${Loading} label="Loading your trips…" /><//>`;
  }
  if (!data) {
    return html`<${Page} title="Trips" subtitle="Drives, miles and fuel costs">
      <${Card}><${ErrorState} error=${error} title="Couldn't load your trips" onRetry=${reload} /><//>
    <//>`;
  }
  return html`<${TripsScreen} store=${store} data=${data} params=${params ?? {}} refreshError=${error} onRetry=${reload} />`;
}

function TripsScreen({ store, data, params, refreshError, onRetry }) {
  const { trips, deals, clients, settings } = data;
  const [editor, setEditor] = useState(() => newEditor({ params, deals, clients }));
  const [period, setPeriod] = useState('all');
  const [saving, setSaving] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const plannerCardRef = useRef(null);
  const phone = useMedia(PHONE_QUERY);

  // The view stays mounted when only the query changes (e.g. a sale's "Log drive" link while
  // already on Trips), so a new ?deal= or ?client= starts a new linked trip here too.
  const linkKey = `${params.deal ?? ''}|${params.client ?? ''}`;
  const linkKeyRef = useRef(linkKey);
  useEffect(() => {
    if (linkKeyRef.current === linkKey) return;
    linkKeyRef.current = linkKey;
    setEditor(newEditor({ params, deals, clients }));
    setShowErrors(false);
  }, [linkKey]);

  const dealsById = useMemo(() => new Map(deals.map((d) => [d.id, d])), [deals]);
  const clientsById = useMemo(() => new Map(clients.map((c) => [c.id, c])), [clients]);
  const dealOptions = useMemo(() => deals.map((d) => ({ value: d.id, label: dealLabel(d) })), [deals]);
  const clientOptions = useMemo(
    () => clients.map((c) => ({ value: c.id, label: `${c.name}${c.club ? ` · ${c.club}` : ''}${c.archived ? ' (archived)' : ''}` })),
    [clients],
  );

  const range = periodRange(period);
  const visible = range.from ? trips.filter((t) => inPeriod(t, range)) : trips;
  const totals = totalsFor(visible);
  const months = monthlyCosts(visible);
  const showOther = months.some((m) => m.other > 0);

  const setMeta = (patch) => setEditor((e) => ({ ...e, meta: { ...e.meta, ...patch } }));
  const setTrip = (trip) => setEditor((e) => ({ ...e, trip }));

  // Brings the planner into view; `focusTo` also puts the cursor in its To box.
  const revealPlanner = ({ focusTo = false } = {}) => {
    const card = plannerCardRef.current;
    if (!card) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (focusTo) card.querySelectorAll('.addr input')[1]?.focus({ preventScroll: true });
  };

  const startNew = () => {
    setEditor(newEditor());
    setShowErrors(false);
  };

  const startEdit = (trip) => {
    setEditor(editorFor(trip));
    setShowErrors(false);
    requestAnimationFrame(() => revealPlanner());
  };

  // Linking a sale also links its client and, if the trip has nowhere to go yet, heads for
  // the client's first saved address.
  const onDealChange = (event) => {
    const dealId = event.currentTarget.value;
    const deal = dealsById.get(dealId);
    setEditor((e) => {
      const previous = dealsById.get(e.meta.deal_id);
      const keepClient = e.meta.client_id && e.meta.client_id !== previous?.client_id;
      const clientId = keepClient ? e.meta.client_id : deal?.client_id ?? e.meta.client_id;
      const place = !hasDestination(e.trip) ? firstAddress(clientsById.get(clientId)) : null;
      return {
        ...e,
        trip: place && e.trip ? { ...e.trip, ...destinationFields(place) } : e.trip,
        meta: { ...e.meta, deal_id: dealId, client_id: clientId ?? '' },
      };
    });
  };

  const onClientChange = (event) => {
    const clientId = event.currentTarget.value;
    setEditor((e) => {
      const place = clientId && !hasDestination(e.trip) ? firstAddress(clientsById.get(clientId)) : null;
      return {
        ...e,
        trip: place && e.trip ? { ...e.trip, ...destinationFields(place) } : e.trip,
        meta: { ...e.meta, client_id: clientId },
      };
    });
  };

  async function save(event) {
    event.preventDefault();
    if (saving) return;
    const problems = Object.values(tripProblems(editor.trip));
    if (problems.length) {
      setShowErrors(true);
      toast(problems[0], { tone: 'warn' });
      revealPlanner();
      return;
    }
    if (!editor.meta.trip_date) {
      setShowErrors(true);
      toast('Pick the date of the trip.', { tone: 'warn' });
      return;
    }
    setSaving(true);
    try {
      const payload = {
        ...editor.trip,
        trip_date: editor.meta.trip_date,
        label: clean(editor.meta.label),
        deal_id: editor.meta.deal_id || null,
        client_id: editor.meta.client_id || null,
      };
      const saved = editor.id ? await store.trips.update(editor.id, payload) : await store.trips.create(payload);
      const cost = money(tripTotals(saved).cashCost);
      toast(editor.id ? `Trip updated — ${cost} cash cost.` : `Trip saved — ${cost} cash cost.`, { tone: 'gain' });
      startNew();
    } catch (err) {
      toast(err, { tone: 'loss' });
    } finally {
      setSaving(false);
    }
  }

  async function remove(trip) {
    const totalsText = money(tripTotals(trip).cashCost);
    const linked = trip.deal ? ` ${dealNumber(trip.deal.number)} will no longer count its ${totalsText} travel cost.` : '';
    const ok = await confirmDialog({
      title: 'Delete this trip?',
      body: `${routeText(trip)} on ${formatDate(trip.trip_date)} will be removed.${linked}`,
      confirmLabel: 'Delete trip',
      danger: true,
    });
    if (!ok) return;
    setBusyId(trip.id);
    try {
      await store.trips.remove(trip.id);
      if (editor.id === trip.id) startNew();
      toast('Trip deleted.', {
        action: {
          label: 'Undo',
          onClick: () => store.trips.create(trip).then(
            () => toast('Trip restored.', { tone: 'gain' }),
            (err) => toast(err, { tone: 'loss' }),
          ),
        },
      });
    } catch (err) {
      toast(err, { tone: 'loss' });
    } finally {
      setBusyId(null);
    }
  }

  const editing = Boolean(editor.id);
  const plannerCard = html`<div ref=${plannerCardRef} class="trips-planner">
    <${Card}
      title=${editing ? `Edit trip · ${formatDate(editor.meta.trip_date)}` : 'Plan a drive'}
      subtitle=${editing ? 'Change anything, then save.' : 'Work out the miles, fuel and your time — then save it to keep a record.'}
      actions=${editing
        ? html`<${Button} kind="ghost" size="sm" onClick=${startNew}>Cancel edit<//>`
        : hasDestination(editor.trip) && html`<${Button} kind="ghost" size="sm" icon="refresh" onClick=${startNew}>Start again<//>`}
    >
      <div class="stack stack-lg">
        <${TripPlanner}
          key=${editor.key}
          store=${store}
          settings=${settings}
          value=${editor.trip}
          onChange=${setTrip}
          initialDestination=${editor.destination ?? undefined}
          showErrors=${showErrors}
          compact=${phone}
        />
        <hr class="divider" />
        <form class="stack" onSubmit=${save} noValidate=${true}>
          <div class="form-grid">
            <${Field} label="Date" required error=${showErrors && !editor.meta.trip_date ? 'Pick the date of the trip.' : undefined}>
              <${Input} type="date" value=${editor.meta.trip_date} onInput=${(e) => setMeta({ trip_date: e.currentTarget.value })} />
            <//>
            <${Field} label="Name it" hint="Optional — shows in the list instead of the route.">
              <${Input}
                type="text"
                value=${editor.meta.label}
                maxlength="120"
                placeholder="e.g. Boots drop-off at the training ground"
                onInput=${(e) => setMeta({ label: e.currentTarget.value })}
              />
            <//>
            <${Field} label="Sale" hint="Counts the drive's cost against that sale's profit.">
              <${Select} value=${editor.meta.deal_id} options=${[{ value: '', label: 'Not linked to a sale' }, ...dealOptions]} onChange=${onDealChange} />
            <//>
            <${Field} label="Client">
              <${Select} value=${editor.meta.client_id} options=${[{ value: '', label: 'No client' }, ...clientOptions]} onChange=${onClientChange} />
            <//>
          </div>
          <div class="trips-form-foot">
            ${editing && html`<${Button}
              kind="ghost"
              icon="trash"
              class="trips-delete"
              loading=${busyId === editor.id}
              onClick=${() => { const trip = trips.find((t) => t.id === editor.id); if (trip) remove(trip); }}
            >Delete<//>`}
            ${editing && html`<${Button} kind="secondary" onClick=${startNew}>Cancel<//>`}
            <${Button} kind="primary" type="submit" icon="check" loading=${saving}>${editing ? 'Save changes' : 'Save trip'}<//>
          </div>
        </form>
      </div>
    <//>
  </div>`;

  // Phones get the four that matter, as a 2×2 grid; fuel and your time ride in the subs.
  const kpis = html`<div class="kpis trips-kpis">
    <${Stat} label="Trips" value=${String(totals.count)} sub=${totals.linked ? `${totals.linked} linked to a sale` : 'None linked to a sale'} />
    <${Stat} label="Miles" value=${formatMiles(totals.miles)} sub=${totals.count ? `${formatMiles(totals.miles / totals.count)} a trip` : undefined} />
    <${Stat}
      label="Time on the road"
      value=${duration(totals.totalMinutes)}
      sub=${phone ? `Worth ${money(totals.timeCost)}` : `${duration(totals.drivingMinutes)} driving`}
    />
    ${!phone && html`<${Stat} label="Fuel" value=${money(totals.fuelCost)} sub=${totals.litres > 0 ? `${litresFormat.format(totals.litres)} litres` : undefined} />`}
    <${Stat}
      label="Cash cost"
      value=${money(totals.cashCost)}
      sub=${phone ? `${money(totals.fuelCost)} fuel` : 'Fuel, wear and extras'}
      tone=${totals.cashCost > 0 ? 'warn' : undefined}
    />
    ${!phone && html`<${Stat} label="Your time" value=${money(totals.timeCost)} sub="What those hours were worth" />`}
  </div>`;

  const chart = months.length >= 2 && html`<${Card} title="Driving costs by month" subtitle="Cash spent on the road in this period">
    <${BarChart}
      title="Driving costs by month"
      data=${months.map((m) => ({ label: monthLabel(m.month), values: showOther ? [m.fuel, m.other] : [m.fuel] }))}
      series=${showOther
        ? [{ key: 'fuel', label: 'Fuel', color: 'var(--signal)' }, { key: 'other', label: 'Wear and extras', color: 'var(--warn)' }]
        : [{ key: 'fuel', label: 'Fuel', color: 'var(--signal)' }]}
      stacked
      height=${180}
      format=${moneyShort}
    />
  <//>`;

  let list;
  if (!trips.length) {
    list = html`<${Card}>
      <${Empty}
        icon="car"
        title="No trips yet"
        body="Plan a drive above and save it to keep track of miles, fuel and what each drop-off really cost."
        action=${html`<${Button} kind="primary" onClick=${() => revealPlanner({ focusTo: true })}>Plan a drive<//>`}
      />
    <//>`;
  } else if (!visible.length) {
    list = html`<${Card}>
      <${Empty}
        icon="calendar"
        title="No trips in this period"
        body="Saved trips from other dates are under All time."
        action=${html`<${Button} onClick=${() => setPeriod('all')}>Show all time<//>`}
      />
    <//>`;
  } else {
    list = html`<${Card} pad=${false} title="Saved trips" subtitle=${plural(visible.length, 'trip')}>
      ${phone ? html`<ul class="lr-list">${visible.map((trip) => html`<${TripListRow}
        key=${trip.id}
        trip=${trip}
        editing=${editor.id === trip.id}
        onEdit=${startEdit}
      />`)}</ul>` : html`<div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th scope="col">Trip</th>
              <th scope="col">Date</th>
              <th scope="col">Linked to</th>
              <th scope="col" class="num">Miles</th>
              <th scope="col" class="num">Time</th>
              <th scope="col" class="num">Fuel</th>
              <th scope="col" class="num">Cash cost</th>
              <th scope="col"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            ${visible.map((trip) => html`<${TripRow}
              key=${trip.id}
              trip=${trip}
              editing=${editor.id === trip.id}
              busy=${busyId === trip.id}
              onEdit=${startEdit}
              onDelete=${remove}
            />`)}
          </tbody>
        </table>
      </div>`}
    <//>`;
  }

  return html`<${Page} title="Trips" subtitle="Drives, miles and fuel costs">
    ${refreshError && html`<${Card}><${ErrorState} error=${refreshError} title="Couldn't refresh your trips" onRetry=${onRetry} /><//>`}
    ${plannerCard}
    ${trips.length > 0 && html`<div class="toolbar trips-period">
      <${Segmented}
        label="Period"
        options=${PERIODS.map((p) => ({ value: p.value, label: phone ? p.short : p.label }))}
        value=${period}
        onChange=${setPeriod}
        full=${phone}
      />
    </div>`}
    ${trips.length > 0 && kpis}
    ${chart}
    ${list}
  <//>`;
}

// Phones: name (or route) over date · sale · client, cash cost over miles and time. Tapping
// a row loads it into the planner, where it can be changed or deleted.
function TripListRow({ trip, editing, onEdit }) {
  const t = tripTotals(trip);
  const name = clean(trip.label);
  const route = routeText(trip);
  const linked = [trip.deal && dealNumber(trip.deal.number), trip.client?.name].filter(Boolean).join(' · ');
  return html`<${ListRow}
    onClick=${() => onEdit(trip)}
    title=${name ?? route}
    badge=${editing && html`<${Badge} tone="signal">Editing<//>`}
    subtitle=${[formatDate(trip.trip_date), linked || (name ? route : trip.round_trip ? 'There and back' : 'One way')].filter(Boolean).join(' · ')}
    amount=${money(t.cashCost)}
    meta=${`${formatMiles(t.miles)} · ${duration(t.totalMinutes)}`}
    current=${editing}
    label=${`Edit trip ${name ?? route}, ${formatDate(trip.trip_date)}`}
  />`;
}

function TripRow({ trip, editing, busy, onEdit, onDelete }) {
  const t = tripTotals(trip);
  const name = clean(trip.label);
  const route = routeText(trip);
  return html`<tr>
    <td class="cell-primary">
      <div class="row row-nowrap">
        <span class="truncate">${name ?? route}</span>
        ${editing && html`<${Badge} tone="signal">Editing<//>`}
      </div>
      <div class="muted small truncate trips-sub">${name ? route : trip.round_trip ? 'There and back' : 'One way'}</div>
    </td>
    <td data-label="Date" class="nowrap">${formatDate(trip.trip_date)}</td>
    <td data-label="Linked to">
      ${trip.deal || trip.client
        ? html`<div class="row">
            ${trip.deal && html`<a href=${`#/sales/${trip.deal.id}`} class="mono">${dealNumber(trip.deal.number)}</a>`}
            ${trip.client && html`<a href=${`#/clients/${trip.client.id}`}>${trip.client.name}</a>`}
          </div>`
        : html`<span class="faint">—</span>`}
    </td>
    <td data-label="Miles" class="num">${formatMiles(t.miles)}</td>
    <td data-label="Time" class="num">${duration(t.totalMinutes)}</td>
    <td data-label="Fuel" class="num">${money(t.fuelCost)}</td>
    <td data-label="Cash cost" class="num strong">${money(t.cashCost)}</td>
    <td class="cell-actions">
      <div class="row row-end row-nowrap">
        <${Button} kind="ghost" size="sm" icon="edit" disabled=${busy} onClick=${() => onEdit(trip)}>Edit<//>
        <${Button} kind="ghost" size="sm" icon="trash" aria-label=${`Delete trip ${route}`} loading=${busy} onClick=${() => onDelete(trip)} />
      </div>
    </td>
  </tr>`;
}

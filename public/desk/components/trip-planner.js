// Trip planner (docs/desk-spec.md §7, "Trip planner component").
//
// From → To → miles, driving time, fuel and the value of your time, for the deal checker, a
// sale's "Log drive" and the Trips page. `value` / `onChange` carry a trip-shaped object (the
// §2 trips columns); the planner fills in what it owns (places, distance, car, fuel, time and
// extra costs) and keeps any other keys (deal_id, client_id, trip_date, label…) untouched.
//
// - From defaults to the home address in settings; both ends use the address box.
// - Once both ends are set the route is calculated (store.api.route); "Calculate route" redoes
//   it. If routing fails, miles and minutes are typed by hand (route_provider 'manual').
// - The fuel price comes from store.api.fuel near the start (UK average without one) for the
//   chosen fuel type, with a source line and a refresh; typing a price makes it 'manual'.
// - Every number stays editable, and the calc.tripTotals breakdown updates as you type.
//
// To load a different trip into a mounted planner, remount it (change its `key`).

import { html, useCallback, useEffect, useMemo, useRef, useState } from '../lib/preact.js';
import { Badge, Banner, Button, Field, Icon, Input, Select, Spinner, Switch, cx } from '../lib/ui.js';
import { num, round2, tripTotals } from '../lib/calc.js';
import { dateShort, duration, miles as formatMiles, money, plural, ppl as formatPpl, todayISO } from '../lib/format.js';
import { DEFAULT_SETTINGS } from '../lib/store.js';
import AddressInput, { placeText } from './address-input.js';
import RouteMap from './route-map.js';

const CSS = `
.tp { container-type: inline-size; display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.tp-places, .tp-grid { display: grid; gap: 12px 14px; grid-template-columns: minmax(0, 1fr); }
.tp-bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; }
.tp-bar .switch { min-height: 40px; padding: 2px 0; }
.tp-route-line { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; color: var(--ink-2); font-size: 13.5px; }
.tp-route-line strong { color: var(--ink); font-size: 15px; font-weight: 600; }
.tp-main { display: grid; gap: 16px; grid-template-columns: minmax(0, 1fr); align-items: start; }
.tp-inputs, .tp-side { display: flex; flex-direction: column; gap: 18px; min-width: 0; }
.tp-group { min-width: 0; margin: 0; padding: 0; border: 0; }
.tp-group > legend { margin-bottom: 10px; padding: 0; color: var(--ink); font-size: 13px; font-weight: 600; }
.tp-fuel-note { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 8px; margin: 8px 0 0; color: var(--ink-3); font-size: 12.5px; line-height: 1.45; }
.tp-fuel-note .spinner { width: 13px; height: 13px; }
.tp-fuel-note.is-problem { color: var(--warn); }
.tp-fuel-note .link { font-size: inherit; }
.tp-more { min-width: 0; border: 1px solid var(--line); border-radius: var(--r-panel); }
.tp-more > summary { display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 8px 12px; font-weight: 500; list-style: none; cursor: pointer; }
.tp-more > summary::-webkit-details-marker { display: none; }
.tp-more > summary > .tp-more-title { flex: none; white-space: nowrap; }
.tp-more > summary .tp-more-sub { display: -webkit-box; flex: 1 1 auto; min-width: 0; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; color: var(--ink-2); font-size: 13px; font-weight: 400; line-height: 1.35; text-align: right; }
.tp-more > summary .icon { flex: none; color: var(--ink-3); transition: transform 0.15s; }
.tp-more[open] > summary .icon { transform: rotate(180deg); }
.tp-more-body { display: flex; flex-direction: column; gap: 18px; padding: 6px 12px 14px; }
.tp-breakdown { padding: 10px 14px 12px; border: 1px solid var(--line); border-radius: var(--r-panel); background: var(--surface-2); }
.tp-breakdown-title { margin-bottom: 2px; font-size: 13px; font-weight: 600; }
.tp-breakdown .kv > div { padding: 5px 0; }
.tp-breakdown-empty { padding: 6px 0 2px; color: var(--ink-3); font-size: 13px; }
.tp-tip { color: var(--ink-3); font-size: 12.5px; }
/* One column on phones; side by side only when each field keeps room for its value and affix. */
.tp-places { align-items: start; }
.tp-grid > * { min-width: 0; }
@container (min-width: 520px) {
  .tp-places, .tp-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@container (min-width: 640px) {
  .tp-grid-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
@container (min-width: 820px) {
  .tp-main { grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); }
}
`;

// Component styles live with the component and are added to <head> once, on first import.
const STYLE_ID = 'desk-trip-planner-styles';
if (typeof document !== 'undefined' && !document.getElementById(STYLE_ID)) {
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.append(style);
}

/** Fuel types for a <Select>, in the order drivers think of them. */
export const FUEL_TYPE_OPTIONS = Object.freeze([
  { value: 'E10', label: 'Unleaded (E10)' },
  { value: 'E5', label: 'Super unleaded (E5)' },
  { value: 'B7', label: 'Diesel (B7)' },
  { value: 'SDV', label: 'Super diesel (SDV)' },
]);

const PROVIDER_LABELS = {
  google: 'Google · traffic-aware',
  osrm: 'Road route · OpenStreetMap',
  manual: 'Entered by you',
};

// Columns the planner fills in; a value missing any of them is completed on mount.
const PLANNER_KEYS = [
  'origin_label', 'origin_address', 'origin_lat', 'origin_lng',
  'dest_label', 'dest_address', 'dest_lat', 'dest_lng',
  'one_way_miles', 'one_way_minutes', 'round_trip', 'extra_minutes',
  'mpg', 'fuel_type', 'fuel_ppl', 'fuel_source',
  'hourly_rate', 'vehicle_cost_per_mile', 'other_costs', 'other_costs_note',
  'route_provider', 'route_geometry',
];

const MY_LOCATION = 'My location';
const POSTCODE = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*\d[A-Z]{2}\b/i;
const OUTCODE = /^([A-Z]{1,2}\d[A-Z\d]?)$/i;
const NEAR_LABEL_MAX = 24;
const litresFormat = new Intl.NumberFormat('en-GB', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

// ---- trip helpers -------------------------------------------------------------------------

function clean(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function isNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v);
  return typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v));
}

function hasCoords(place) {
  return Boolean(place) && isNumber(place.lat) && isNumber(place.lng);
}

function messageOf(error) {
  return error instanceof Error && error.message ? error.message : 'Something went wrong — please try again.';
}

/** The trip's start ('origin') or end ('dest') as { label, address, lat, lng }, or null. */
function placeOf(trip, prefix) {
  const place = {
    label: clean(trip?.[`${prefix}_label`]),
    address: clean(trip?.[`${prefix}_address`]),
    lat: isNumber(trip?.[`${prefix}_lat`]) ? Number(trip[`${prefix}_lat`]) : null,
    lng: isNumber(trip?.[`${prefix}_lng`]) ? Number(trip[`${prefix}_lng`]) : null,
  };
  return place.label || place.address || hasCoords(place) ? place : null;
}

// Trip columns for a place. Coordinates are stored as a pair or not at all.
function placeFields(prefix, place) {
  const located = hasCoords(place);
  return {
    [`${prefix}_label`]: clean(place?.label),
    [`${prefix}_address`]: clean(place?.address),
    [`${prefix}_lat`]: located ? Number(place.lat) : null,
    [`${prefix}_lng`]: located ? Number(place.lng) : null,
  };
}

function homePlace(settings) {
  const located = hasCoords({ lat: settings?.home_lat, lng: settings?.home_lng });
  const address = clean(settings?.home_address);
  if (!address && !located) return null;
  return {
    label: clean(settings?.home_label) ?? 'Home',
    address,
    lat: located ? Number(settings.home_lat) : null,
    lng: located ? Number(settings.home_lng) : null,
  };
}

// Identifies the pair of places a route belongs to: coordinates when known, else the text.
function placeKey(place) {
  if (!place) return '';
  if (hasCoords(place)) return `${Number(place.lat).toFixed(5)},${Number(place.lng).toFixed(5)}`;
  return placeText(place).toLowerCase();
}

function placesKey(trip) {
  return `${placeKey(placeOf(trip, 'origin'))}>${placeKey(placeOf(trip, 'dest'))}`;
}

function isRoutable(trip) {
  return Boolean(placeOf(trip, 'origin') && placeOf(trip, 'dest'));
}

// Fuel prices are looked up per fuel type near the start (to about 1 km, as the store rounds).
function fuelKey(trip) {
  const origin = placeOf(trip, 'origin');
  const where = hasCoords(origin) ? `${origin.lat.toFixed(2)},${origin.lng.toFixed(2)}` : 'uk';
  return `${trip?.fuel_type || DEFAULT_SETTINGS.fuel_type}@${where}`;
}

/**
 * A new trip from settings: starts at home unless `origin` says otherwise (null = no start),
 * uses the car, fuel, time and handover defaults, and has no distance or fuel price yet.
 */
export function blankTrip(settings, { origin, destination } = {}) {
  const s = { ...DEFAULT_SETTINGS, ...(settings ?? {}) };
  return {
    ...placeFields('origin', origin === undefined ? homePlace(s) : origin),
    ...placeFields('dest', destination ?? null),
    one_way_miles: null,
    one_way_minutes: null,
    round_trip: s.round_trip_default !== false,
    extra_minutes: Math.max(0, Math.round(num(s.handover_minutes_default))),
    mpg: num(s.mpg) > 0 ? num(s.mpg) : DEFAULT_SETTINGS.mpg,
    fuel_type: s.fuel_type || DEFAULT_SETTINGS.fuel_type,
    fuel_ppl: null,
    fuel_source: null,
    hourly_rate: Math.max(0, num(s.hourly_rate)),
    vehicle_cost_per_mile: Math.max(0, num(s.vehicle_cost_per_mile)),
    other_costs: 0,
    other_costs_note: null,
    route_provider: null,
    route_geometry: null,
  };
}

/**
 * What still stops a trip being saved, as { column: message }; empty when it is complete.
 * Mirrors the database: miles, minutes, mpg and fuel price are required.
 */
export function tripProblems(trip) {
  const t = trip ?? {};
  const problems = {};
  if (!(Number(t.one_way_miles) > 0)) problems.one_way_miles = 'Enter the one-way miles, or calculate the route.';
  if (!(Number(t.one_way_minutes) > 0)) problems.one_way_minutes = 'Enter the one-way driving time in minutes.';
  if (!(Number(t.mpg) > 0)) problems.mpg = "Enter your car's mpg.";
  if (!(Number(t.fuel_ppl) > 0)) problems.fuel_ppl = 'Enter the fuel price in pence per litre.';
  return problems;
}

function missingKeys(trip) {
  return !trip || PLANNER_KEYS.some((key) => trip[key] === undefined);
}

// ---- fuel source line ---------------------------------------------------------------------

function pad2(n) {
  return String(n).padStart(2, '0');
}

// Newest update among the feeds that supplied prices, else when the server fetched them.
function pricesUpdatedAt(body) {
  const times = (Array.isArray(body?.feeds) ? body.feeds : [])
    .filter((feed) => feed?.ok && feed.updated)
    .map((feed) => Date.parse(feed.updated))
    .filter(Number.isFinite);
  const ms = times.length ? Math.max(...times) : Date.parse(body?.fetchedAt);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

function clockLabel(when) {
  return `${dateShort(todayISO(when))} ${pad2(when.getHours())}:${pad2(when.getMinutes())}`;
}

// 'SO14' from a postcode in the address or label, else a short label ('Home').
function nearName(place) {
  for (const text of [place?.address, place?.label]) {
    if (typeof text !== 'string') continue;
    const full = POSTCODE.exec(text);
    if (full) return full[1].toUpperCase();
    const outcode = OUTCODE.exec(text.trim());
    if (outcode) return outcode[1].toUpperCase();
  }
  const label = clean(place?.label);
  if (label === MY_LOCATION) return 'you';
  return label && label.length <= NEAR_LABEL_MAX ? label : null;
}

function fuelSourceText(body, origin) {
  const when = pricesUpdatedAt(body);
  const updated = when ? ` · updated ${clockLabel(when)}` : '';
  if (body?.scope === 'local' && body.radiusMiles) {
    const near = nearName(origin);
    return `Median of ${plural(body.count, 'station')} within ${body.radiusMiles} mi${near ? ` of ${near}` : ''}${updated}`;
  }
  return `UK average (median of ${plural(body?.count, 'station')})${updated}`;
}

// ---- number field -------------------------------------------------------------------------

function toDraft(v) {
  return v === null || v === undefined || v === '' ? '' : String(v);
}

// '' -> null; '£1,200' -> 1200; anything unreadable -> undefined.
function parseDraft(text) {
  const t = String(text ?? '').replace(/[£,\s]/g, '');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * A labelled number box that keeps what is typed ("4.", "") while handing the parent numbers.
 * An emptied box reports `emptyValue` (null for required inputs, 0 where the column has a
 * default); text that isn't a number, or a negative, is shown as an error and not reported.
 */
function NumField({ label, hint, error, value, onValue, onTouch, emptyValue = null, integer = false, normalise, prefix, suffix, required = false, placeholder }) {
  const [draft, setDraft] = useState(() => toDraft(value));
  const [blurred, setBlurred] = useState(false);

  useEffect(() => {
    const shown = parseDraft(draft);
    const same = shown === undefined ? false : Number(shown ?? emptyValue) === Number(value) || (shown === null && (value === null || value === undefined));
    if (!same) setDraft(toDraft(value));
  }, [value]);

  const parsed = parseDraft(draft);
  let localError = null;
  if (blurred && parsed === undefined) localError = 'Enter a number.';
  else if (blurred && parsed !== null && parsed < 0) localError = "Can't be negative.";

  const onInput = (event) => {
    const text = event.currentTarget.value;
    setDraft(text);
    const n = parseDraft(text);
    if (n === undefined || (n !== null && n < 0)) return;
    onValue(n === null ? emptyValue : integer ? Math.round(n) : n);
  };

  const onBlur = () => {
    setBlurred(true);
    onTouch?.();
    const n = parseDraft(draft);
    if (n === undefined || n === null || n < 0) return;
    const tidy = normalise ? normalise(n) : integer ? Math.round(n) : n;
    if (tidy !== n || (integer && !Number.isInteger(n))) {
      setDraft(toDraft(tidy));
      onValue(tidy);
    }
  };

  return html`<${Field} label=${label} hint=${hint} error=${localError || error} required=${required}>
    <${Input}
      type="text"
      inputmode=${integer ? 'numeric' : 'decimal'}
      autocomplete="off"
      autocorrect="off"
      enterkeyhint="next"
      value=${draft}
      placeholder=${placeholder}
      prefix=${prefix}
      suffix=${suffix}
      onInput=${onInput}
      onBlur=${onBlur}
    />
  <//>`;
}

// A price typed in pounds (1.42) is read as pence (142.0): no UK pump is under 10p a litre.
function penceFromPounds(n) {
  return n > 0 && n < 10 ? Math.round(n * 1000) / 10 : n;
}

// ---- breakdown ----------------------------------------------------------------------------

function TripBreakdown({ trip, totals, compact }) {
  const rate = num(trip.hourly_rate);
  const hasDistance = totals.miles > 0;
  return html`<section class="tp-breakdown" aria-label="Cost of the drive">
    <h3 class="tp-breakdown-title">What the drive costs</h3>
    ${!hasDistance
      ? html`<p class="tp-breakdown-empty">Calculate the route or type the miles to see fuel, time and cost.</p>`
      : html`<dl class="kv">
          <div><dt>Distance ${trip.round_trip ? '(there and back)' : '(one way)'}</dt><dd>${formatMiles(totals.miles)}</dd></div>
          <div><dt>Driving time</dt><dd>${duration(totals.drivingMinutes)}</dd></div>
          ${totals.totalMinutes !== totals.drivingMinutes && html`<div><dt>Total time incl. handover</dt><dd>${duration(totals.totalMinutes)}</dd></div>`}
          ${!compact && html`<div><dt>Fuel used</dt><dd>${litresFormat.format(totals.litres)} L</dd></div>`}
          <div class="kv-sub"><dt>Fuel${num(trip.fuel_ppl) > 0 ? ` at ${formatPpl(trip.fuel_ppl)}` : ' (no price yet)'}</dt><dd>${money(totals.fuelCost)}</dd></div>
          ${totals.wearCost > 0 && html`<div class="kv-sub"><dt>Wear at ${money(trip.vehicle_cost_per_mile, { pence: true })}/mi</dt><dd>${money(totals.wearCost)}</dd></div>`}
          ${totals.otherCosts > 0 && html`<div class="kv-sub"><dt>${clean(trip.other_costs_note) ?? 'Parking, tolls, charges'}</dt><dd>${money(totals.otherCosts)}</dd></div>`}
          <div class="kv-total"><dt>Cash cost</dt><dd>${money(totals.cashCost)}</dd></div>
          <div><dt>Your time${rate > 0 ? ` at ${money(rate, { pence: rate % 1 !== 0 })}/h` : ''}</dt><dd>${money(totals.timeCost)}</dd></div>
          <div class="kv-total"><dt>Full cost incl. your time</dt><dd>${money(totals.fullCost)}</dd></div>
        </dl>`}
  </section>`;
}

// ---- planner ------------------------------------------------------------------------------

/**
 * TripPlanner({ store, settings, value, onChange, initialOrigin, initialDestination,
 *               compact = false, showErrors = false })
 * initialOrigin/initialDestination ({ label, address, lat, lng }) seed a new trip; From falls
 * back to home. compact folds car, fuel and time into one expandable row and drops the map
 * until there is a route. showErrors marks every missing required input (after a failed save).
 */
export default function TripPlanner({
  store,
  settings,
  value,
  onChange,
  initialOrigin,
  initialDestination,
  compact = false,
  showErrors = false,
}) {
  const config = useMemo(() => ({ ...DEFAULT_SETTINGS, ...(settings ?? {}) }), [settings]);
  const fresh = () => blankTrip(config, { origin: initialOrigin, destination: initialDestination });

  // Controlled through value/onChange; the inner copy only matters when no value is given.
  const [inner, setInner] = useState(() => (value ? null : fresh()));
  const base = value ?? inner ?? fresh();
  const trip = missingKeys(base) ? { ...fresh(), ...stripUndefined(base) } : base;

  const tripRef = useRef(trip);
  tripRef.current = trip;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const mountedRef = useRef(true);
  const pristineRef = useRef(!value); // nothing typed yet into a trip the planner created
  const routeRequestRef = useRef(0);
  const fuelRequestRef = useRef(0);
  const [touched, setTouched] = useState(() => new Set());
  const [moreOpen, setMoreOpen] = useState(false);

  const update = useCallback((patch, { byUser = true } = {}) => {
    const next = { ...tripRef.current, ...patch };
    tripRef.current = next; // handlers later in the same event see the new trip
    if (byUser) pristineRef.current = false;
    setInner(next);
    onChangeRef.current?.(next);
    return next;
  }, []);

  useEffect(() => {
    if (!value || missingKeys(value)) onChangeRef.current?.(tripRef.current);
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Settings or starting places that arrive after mount re-seed a trip nobody has touched.
  const seedKey = JSON.stringify([
    config.mpg, config.fuel_type, config.hourly_rate, config.vehicle_cost_per_mile,
    config.round_trip_default, config.handover_minutes_default,
    config.home_label, config.home_address, config.home_lat, config.home_lng,
    initialOrigin ?? null, initialDestination ?? null,
  ]);
  const seedRef = useRef(seedKey);
  useEffect(() => {
    if (seedRef.current === seedKey) return;
    seedRef.current = seedKey;
    if (pristineRef.current) update(fresh(), { byUser: false });
  }, [seedKey]);

  const origin = placeOf(trip, 'origin');
  const destination = placeOf(trip, 'dest');
  const home = homePlace(config);
  const key = placesKey(trip);
  const routable = isRoutable(trip);
  const totals = tripTotals(trip);
  const problems = tripProblems(trip);
  const errorFor = (field) => (showErrors || touched.has(field) ? problems[field] : undefined);
  const touch = (field) => () => setTouched((prev) => (prev.has(field) ? prev : new Set(prev).add(field)));

  // ---- route ----

  const [route, setRoute] = useState(() => ({
    busy: false,
    error: null,
    doneKey: isNumber(trip.one_way_miles) ? key : null, // places the current miles belong to
    triedKey: null,
  }));

  const calculate = useCallback(async () => {
    const current = tripRef.current;
    const from = placeOf(current, 'origin');
    const to = placeOf(current, 'dest');
    if (!from || !to) {
      setRoute((r) => ({ ...r, error: "Add where you're starting from and where you're going." }));
      return;
    }
    const requestKey = placesKey(current);
    routeRequestRef.current += 1;
    const request = routeRequestRef.current;
    setRoute((r) => ({ ...r, busy: true, error: null, triedKey: requestKey }));
    try {
      const result = await store.api.route(routePlace(from), routePlace(to));
      if (!mountedRef.current || request !== routeRequestRef.current) return;
      if (placesKey(tripRef.current) !== requestKey) {
        setRoute((r) => ({ ...r, busy: false })); // the places changed while we waited
        return;
      }
      if (!(num(result?.miles) > 0)) throw new Error('The route came back without a distance — type the miles instead.');
      const next = update({
        ...placeFields('origin', resolvedPlace(from, result.origin)),
        ...placeFields('dest', resolvedPlace(to, result.destination)),
        one_way_miles: round2(num(result.miles)),
        one_way_minutes: Math.round(num(result.minutes) * 10) / 10,
        route_provider: result.provider ?? null,
        route_geometry: Array.isArray(result.geometry) && result.geometry.length > 1 ? result.geometry : null,
      }, { byUser: false });
      const doneKey = placesKey(next);
      setRoute({ busy: false, error: null, doneKey, triedKey: doneKey });
    } catch (error) {
      if (!mountedRef.current || request !== routeRequestRef.current) return;
      setRoute((r) => ({ ...r, busy: false, error: messageOf(error) }));
    }
  }, [store, update]);

  // Route automatically whenever both ends are set and the pair has not been tried yet.
  useEffect(() => {
    if (!routable || route.busy || key === route.doneKey || key === route.triedKey) return;
    calculate();
  }, [key, routable, route.busy]);

  const setPlace = (prefix) => (place) => {
    const patch = placeFields(prefix, place);
    // A new start or end makes the drawn route wrong; the miles stay until it is redone.
    if (placesKey({ ...tripRef.current, ...patch }) !== placesKey(tripRef.current)) patch.route_geometry = null;
    update(patch);
  };

  const setRouteNumber = (field) => (n) => {
    const patch = { [field]: n, route_provider: 'manual' };
    if (key !== route.doneKey) patch.route_geometry = null; // that line was for other places
    update(patch);
    // Typed numbers now stand for these places: drop any route still on its way, and don't
    // calculate one over them.
    routeRequestRef.current += 1;
    setRoute((r) => ({ ...r, busy: false, error: null, ...(routable ? { doneKey: key, triedKey: key } : {}) }));
  };

  // ---- fuel ----

  const fKey = fuelKey(trip);
  const [fuel, setFuel] = useState(() => ({
    busy: false,
    error: null,
    info: null,
    doneKey: num(trip.fuel_ppl) > 0 ? fKey : null, // a saved price is kept, not re-fetched
  }));

  const loadFuel = useCallback(async () => {
    const current = tripRef.current;
    const requestKey = fuelKey(current);
    const from = placeOf(current, 'origin');
    fuelRequestRef.current += 1;
    const request = fuelRequestRef.current;
    setFuel((f) => ({ ...f, busy: true, error: null, doneKey: requestKey }));
    try {
      const body = await store.api.fuel({
        lat: hasCoords(from) ? from.lat : null,
        lng: hasCoords(from) ? from.lng : null,
        type: current.fuel_type || DEFAULT_SETTINGS.fuel_type,
      });
      if (!mountedRef.current || request !== fuelRequestRef.current) return;
      const price = Number(body?.ppl);
      if (!(price > 0)) throw new Error('No live price for that fuel right now.');
      const latest = tripRef.current;
      if (fuelKey(latest) === requestKey && latest.fuel_source !== 'manual') {
        update({ fuel_ppl: Math.round(price * 10) / 10, fuel_source: fuelSourceText(body, from) }, { byUser: false });
      }
      setFuel((f) => ({ ...f, busy: false, error: null, info: body }));
    } catch (error) {
      if (!mountedRef.current || request !== fuelRequestRef.current) return;
      setFuel((f) => ({ ...f, busy: false, error: messageOf(error), info: null }));
    }
  }, [store, update]);

  useEffect(() => {
    if (fuel.busy || trip.fuel_source === 'manual' || fKey === fuel.doneKey) return;
    loadFuel();
  }, [fKey, trip.fuel_source, fuel.busy]);

  const refreshFuelPrice = () => {
    if (tripRef.current.fuel_source === 'manual') update({ fuel_source: null });
    loadFuel();
  };

  const setFuelType = (event) => {
    const fuelType = event.currentTarget.value;
    // A typed price was for the old fuel, so go back to live prices for the new one.
    update({ fuel_type: fuelType, fuel_source: tripRef.current.fuel_source === 'manual' ? null : tripRef.current.fuel_source });
  };

  // ---- rendering ----

  const routeKnown = isNumber(trip.one_way_miles) && num(trip.one_way_miles) > 0;
  const stale = routeKnown && routable && !route.busy && key !== route.doneKey;
  const startsAtHome = home && origin && placeKey(home) === placeKey(origin);
  const providerLabel = PROVIDER_LABELS[trip.route_provider] ?? null;

  const fuelNote = (() => {
    if (fuel.busy) {
      return html`<p class="tp-fuel-note" role="status"><${Spinner} label="Checking prices" /> Checking live prices${nearName(origin) ? ` near ${nearName(origin)}` : ''}…</p>`;
    }
    if (trip.fuel_source === 'manual') {
      return html`<p class="tp-fuel-note">Your price. <button type="button" class="link" onClick=${refreshFuelPrice}>Use the live price</button></p>`;
    }
    if (fuel.error) {
      return html`<p class="tp-fuel-note is-problem" role="status">
        Live prices unavailable: ${fuel.error.replace(/\.$/, '')}. Type the price you pay.
        <button type="button" class="link" onClick=${refreshFuelPrice}>Try again</button>
      </p>`;
    }
    if (clean(trip.fuel_source)) {
      const cheapest = !compact && fuel.info?.scope === 'local' ? fuel.info.cheapest : null;
      return html`<p class="tp-fuel-note">
        <span>${trip.fuel_source}</span>
        <button type="button" class="link" onClick=${refreshFuelPrice}>Refresh</button>
        ${cheapest && html`<span class="tp-cheapest">Cheapest: ${[cheapest.brand, cheapest.postcode].filter(Boolean).join(' ')} at ${formatPpl(cheapest.ppl)}, ${formatMiles(cheapest.miles)} away.</span>`}
      </p>`;
    }
    return null;
  })();

  const distanceGroup = html`<fieldset class="tp-group">
    <legend>Distance and time</legend>
    <div class="tp-grid tp-grid-3">
      <${NumField}
        label="Miles, one way"
        value=${trip.one_way_miles}
        onValue=${setRouteNumber('one_way_miles')}
        onTouch=${touch('one_way_miles')}
        error=${errorFor('one_way_miles')}
        suffix="mi"
        required
      />
      <${NumField}
        label="Driving time, one way"
        value=${trip.one_way_minutes}
        onValue=${setRouteNumber('one_way_minutes')}
        onTouch=${touch('one_way_minutes')}
        error=${errorFor('one_way_minutes')}
        hint=${num(trip.one_way_minutes) >= 60 ? duration(trip.one_way_minutes) : undefined}
        suffix="min"
        required
      />
      <${NumField}
        label="Handover"
        value=${trip.extra_minutes}
        onValue=${(n) => update({ extra_minutes: n })}
        emptyValue=${0}
        integer
        hint="Time at the drop-off"
        suffix="min"
      />
    </div>
  </fieldset>`;

  const fuelGroup = html`<fieldset class="tp-group">
    <legend>Car and fuel</legend>
    <div class="tp-grid tp-grid-3">
      <${NumField}
        label="Fuel economy"
        value=${trip.mpg}
        onValue=${(n) => update({ mpg: n })}
        onTouch=${touch('mpg')}
        error=${errorFor('mpg')}
        suffix="mpg"
        required
      />
      <${Field} label="Fuel">
        <${Select} value=${trip.fuel_type || DEFAULT_SETTINGS.fuel_type} options=${FUEL_TYPE_OPTIONS} onChange=${setFuelType} />
      <//>
      <${NumField}
        label="Fuel price"
        value=${trip.fuel_ppl}
        onValue=${(n) => update({ fuel_ppl: n, fuel_source: 'manual' })}
        onTouch=${touch('fuel_ppl')}
        error=${errorFor('fuel_ppl')}
        normalise=${penceFromPounds}
        suffix="p/L"
        placeholder=${fuel.busy ? 'Checking…' : undefined}
        required
      />
    </div>
    ${fuelNote}
  </fieldset>`;

  const extrasGroup = html`<fieldset class="tp-group">
    <legend>Your time and extras</legend>
    <div class="tp-grid tp-grid-3">
      <${NumField}
        label="Your time"
        value=${trip.hourly_rate}
        onValue=${(n) => update({ hourly_rate: n })}
        emptyValue=${0}
        suffix="£/h"
        hint="What an hour of yours is worth"
      />
      <${NumField}
        label="Wear and tear"
        value=${trip.vehicle_cost_per_mile}
        onValue=${(n) => update({ vehicle_cost_per_mile: n })}
        emptyValue=${0}
        suffix="£/mi"
        hint="Not fuel — leave 0 to skip"
      />
      <${NumField}
        label="Parking, tolls, ULEZ"
        value=${trip.other_costs}
        onValue=${(n) => update({ other_costs: n })}
        emptyValue=${0}
        prefix="£"
      />
      <${Field} label="What the extras were" class="span-all">
        <${Input}
          type="text"
          value=${trip.other_costs_note ?? ''}
          placeholder="e.g. Stadium car park"
          maxlength="200"
          onInput=${(event) => update({ other_costs_note: clean(event.currentTarget.value) ? event.currentTarget.value : null })}
        />
      <//>
    </div>
  </fieldset>`;

  // Folded groups open themselves when they hide something that needs fixing.
  const foldedProblem = Boolean(errorFor('mpg') || errorFor('fuel_ppl') || (fuel.error && !(num(trip.fuel_ppl) > 0)));
  const summaryParts = [
    num(trip.mpg) > 0 ? `${trip.mpg} mpg` : null,
    num(trip.fuel_ppl) > 0 ? `${trip.fuel_type || 'E10'} ${formatPpl(trip.fuel_ppl)}` : 'no fuel price',
    `${money(trip.hourly_rate, { pence: num(trip.hourly_rate) % 1 !== 0 })}/h`,
  ].filter(Boolean);

  const showMap = !compact || (Array.isArray(trip.route_geometry) && trip.route_geometry.length > 1);

  return html`<div class=${cx('tp', compact && 'is-compact')}>
    <div class="tp-places">
      <${AddressInput}
        store=${store}
        label="From"
        value=${origin}
        onChange=${setPlace('origin')}
        placeholder="Where you set off"
        locate="Start from my location"
      />
      <${AddressInput}
        store=${store}
        label="To"
        value=${destination}
        onChange=${setPlace('dest')}
        placeholder="Drop-off address or postcode"
        locate="I'm at the drop-off now"
      />
    </div>

    ${home && !startsAtHome && html`<div class="chips">
      <button type="button" class="chip" onClick=${() => setPlace('origin')(home)}>
        <${Icon} name="home" size=${16} />Start from ${home.label}
      </button>
    </div>`}
    ${!home && !origin && html`<p class="tp-tip">
      Tip: save your home address in <a href="#/settings">Settings</a> and every drive starts there.
    </p>`}

    <div class="tp-bar">
      <${Switch}
        checked=${trip.round_trip !== false}
        onChange=${(checked) => update({ round_trip: checked })}
        label="Round trip"
        hint="Count the drive back too"
      />
      <${Button}
        kind=${routeKnown && !stale ? 'secondary' : 'primary'}
        icon="car"
        onClick=${calculate}
        loading=${route.busy}
        disabled=${!routable}
      >${route.busy ? 'Calculating…' : routeKnown && !stale && trip.route_provider !== 'manual' ? 'Recalculate' : 'Calculate route'}<//>
    </div>

    ${route.error && html`<${Banner} tone="warn" title="Couldn't calculate the route">
      ${route.error} You can type the one-way miles and driving time below.
    <//>`}
    ${stale && !route.error && html`<${Banner} tone="warn" title="The route is out of date">
      You changed where the trip starts or ends — recalculate, or check the miles and time below.
    <//>`}
    ${routeKnown && html`<p class="tp-route-line">
      <strong>${formatMiles(trip.one_way_miles)}</strong>
      <span>${duration(trip.one_way_minutes)} each way</span>
      ${providerLabel && html`<${Badge} tone=${trip.route_provider === 'manual' ? 'neutral' : 'signal'} dot=${false}>${providerLabel}<//>`}
    </p>`}

    <div class="tp-main">
      <div class="tp-inputs">
        ${distanceGroup}
        ${compact
          ? html`<details class="tp-more" open=${moreOpen || foldedProblem} onToggle=${(event) => setMoreOpen(event.currentTarget.open)}>
              <summary>
                <span class="tp-more-title">Car, fuel and time</span>
                <span class="tp-more-sub">${summaryParts.join(' · ')}</span>
                <${Icon} name="chevron-down" size=${18} />
              </summary>
              <div class="tp-more-body">${fuelGroup}${extrasGroup}</div>
            </details>`
          : html`<div class="stack stack-lg">${fuelGroup}${extrasGroup}</div>`}
      </div>
      <div class="tp-side">
        ${showMap && html`<${RouteMap}
          geometry=${trip.route_geometry}
          origin=${origin}
          destination=${destination}
          height=${compact ? 180 : 240}
        />`}
        <${TripBreakdown} trip=${trip} totals=${totals} compact=${compact} />
      </div>
    </div>
  </div>`;
}

// ---- small helpers used above -----------------------------------------------------------------

function stripUndefined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, v]) => v !== undefined));
}

// What /api/route needs for a place: coordinates when known, otherwise the address to geocode.
function routePlace(place) {
  if (hasCoords(place)) {
    return { lat: place.lat, lng: place.lng, label: place.label ?? undefined, address: place.address ?? undefined };
  }
  return { address: placeText(place) };
}

// A place the user named keeps its own label and address; typed text takes what the server found.
function resolvedPlace(mine, found) {
  if (!found || !hasCoords(found)) return mine;
  if (hasCoords(mine)) return mine;
  return { label: clean(found.label) ?? mine.label, address: clean(found.address) ?? mine.address, lat: found.lat, lng: found.lng };
}

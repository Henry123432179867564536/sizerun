// Client profile (#/clients/:id) and New client (#/clients/new, params.id === 'new').
//
// The profile shows who the player is (club, sizes, birthday, agent, drop-off addresses),
// one-tap contact (call, WhatsApp, Instagram, email), what they have been worth (lifetime
// figures from calc.js over their sales), their sales and drives, and archive / delete.
// `#/clients/:id?edit=1` swaps the profile for the edit form, so a phone's Back button cancels
// an edit. New client uses the same form.

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
  Money,
  Page,
  Stat,
  Switch,
  Textarea,
  confirmDialog,
  cx,
  paymentMeta,
  statusMeta,
  toast,
  useField,
  useId,
  useStoreData,
} from '../lib/ui.js';
import { EPS, dealNumber, dealTotals, tripTotals } from '../lib/calc.js';
import { date as formatDate, duration, miles as formatMiles, money, pct, plural, relDays, todayISO } from '../lib/format.js';
import AddressInput from '../components/address-input.js';
import {
  Avatar,
  ListRow,
  TagPills,
  clean,
  clientLine,
  clientStats,
  firstName,
  normaliseText,
  saleDateText,
  squadNumber,
  usePhone,
} from './clients.js';

// Read by the New sale form: { client_id } preselects the client.
const PREFILL_KEY = 'sizemill.desk.prefill';

const MAX_NAME = 120;
const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 30;
const MAX_ADDRESSES = 10;
const BIRTHDAY_SOON_DAYS = 14;
const OLDEST_BIRTH_YEAR = 1900;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_CHARS = /^[+\d\s().-]+$/;
const INSTAGRAM_HANDLE = /^[A-Za-z0-9._]{1,30}$/;
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

const POSITIONS = [
  'Goalkeeper', 'Right-back', 'Centre-back', 'Left-back', 'Wing-back', 'Defensive midfielder',
  'Central midfielder', 'Attacking midfielder', 'Right winger', 'Left winger', 'Forward', 'Striker',
];
const ADDRESS_LABELS = ['Home', 'Training ground', 'Stadium', "Agent's office", 'Family home', 'Hotel'];
const TAG_IDEAS = ['VIP', 'Pays cash', 'Pays on delivery', 'Via agent', 'First team', 'Academy', 'On loan'];
// What AddressInput calls a place picked with "Use my location": not a name worth keeping.
const DEVICE_LOCATION_LABEL = 'my location';

const TEXT_FIELDS = [
  'name', 'club', 'position', 'squad_number', 'birthday', 'phone', 'email', 'instagram',
  'agent_name', 'agent_phone', 'agent_email', 'shoe_size', 'clothing_size', 'preferences', 'notes',
];

const CSS = `
.cl-hero { display: flex; align-items: flex-start; gap: 14px; }
.cl-hero-main { flex: 1 1 auto; min-width: 0; }
.cl-facts { display: flex; flex-wrap: wrap; gap: 8px 22px; }
.cl-fact { display: flex; flex-direction: column; min-width: 0; }
.cl-fact-label { color: var(--ink-3); font-size: 12px; font-weight: 500; }
.cl-fact-value { font-weight: 600; overflow-wrap: anywhere; }
.cl-fact-sub { color: var(--ink-2); font-size: 12.5px; }
.cl-actions { margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--line); }
.cl-layout { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 16px; }
.cl-main { flex: 999 1 520px; min-width: 0; }
.cl-side { flex: 1 1 300px; min-width: 0; }
.cl-text { white-space: pre-wrap; overflow-wrap: anywhere; }
/* Wraps (so a table column can shrink to its card) but never past two lines. */
.cl-clamp { display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; }
.cl-block + .cl-block { margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--line); }
.cl-block-title { margin-bottom: 4px; color: var(--ink-3); font-size: 12px; font-weight: 500; }
.cl-address .list-sub { white-space: normal; }
.cl-address .icon { flex: none; color: var(--ink-3); }
.cl-tag-input { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-height: var(--ctl-h); padding: 6px 8px; border: 1px solid var(--line-2); border-radius: var(--r-ctl); background: var(--surface); cursor: text; transition: border-color 0.12s, box-shadow 0.12s; }
.cl-tag-input:hover { border-color: var(--ink-3); }
.cl-tag-input:focus-within { border-color: var(--signal); box-shadow: 0 0 0 3px var(--ring); }
.cl-tag-input input { flex: 1 1 120px; min-width: 96px; height: 32px; padding: 0 4px; border: 0; outline: none; background: transparent; color: var(--ink); font: inherit; font-size: 16px; }
.cl-tag-input input::placeholder { color: var(--ink-3); }
.cl-tag-input input::-webkit-calendar-picker-indicator { display: none !important; }
.cl-tag { display: inline-flex; align-items: center; gap: 2px; max-width: 100%; height: 32px; padding: 0 2px 0 12px; border: 1px solid var(--line); border-radius: 999px; background: var(--surface-2); font-size: 13.5px; font-weight: 500; }
.cl-tag-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cl-tag button { position: relative; display: grid; flex: none; place-items: center; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 50%; background: none; color: var(--ink-3); cursor: pointer; }
.cl-tag button::after { content: ""; position: absolute; inset: -6px; }
.cl-tag button:hover { background: var(--hover); color: var(--ink); }
.cl-tag-ideas { display: flex; flex-wrap: wrap; gap: 6px; }
.cl-tag-ideas .chip { color: var(--ink-2); }

/* The client form: sections with room to breathe, one column on phones, two from 640px. */
.cl-form { width: 100%; max-width: 760px; }
.cl-form .input[list]::-webkit-calendar-picker-indicator { display: none !important; }
/* iOS Safari gives date inputs an intrinsic width that ignores width:100% and spills over the
   next field; make it an ordinary block box. */
.cl-form .input[type="date"] { display: block; width: 100%; min-width: 0; max-width: 100%; -webkit-appearance: none; appearance: none; text-align: left; }
.cl-form .input[type="date"]::-webkit-date-and-time-value { text-align: left; }
.cl-section-note { margin: 0 0 14px; color: var(--ink-2); font-size: 13px; line-height: 1.45; }
.cl-addr-list { display: flex; flex-direction: column; gap: 12px; }
.cl-addr-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 36px; margin: -6px -6px 0 0; }
.cl-addr-title { color: var(--ink); font-size: 14px; font-weight: 600; }
.cl-addr-fields { display: grid; gap: 16px; grid-template-columns: minmax(0, 1fr); }
.cl-addr-fields > * { min-width: 0; }
@media (max-width: 519.98px) {
  .cl-form .form-bar .btn { flex: 1 1 0; }
  .cl-form .form-bar-summary:empty { display: none; }
}
.cl-hint-line { margin-top: 10px; }
.cl-profile-stats .stat-sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cl-profile-stats .cl-stat-hero { grid-column: 1 / -1; }
.cl-profile-stats .cl-stat-hero .stat-value { font-size: 28px; }
.cl-est { margin-left: 6px; padding: 1px 6px; border-radius: 999px; background: var(--warn-tint); color: var(--warn); font-size: 11.5px; font-weight: 600; letter-spacing: 0; vertical-align: 0.25em; }
@media (min-width: 900px) {
  .cl-profile-stats { grid-template-columns: repeat(5, minmax(0, 1fr)); }
  .cl-profile-stats .cl-stat-hero { grid-column: auto; }
  .cl-profile-stats .cl-stat-hero .stat-value { font-size: 24px; }
}
.cl-sale-sub { font-weight: 400; }
.cl-sale-badge { margin-top: 4px; }
@media (min-width: 640px) {
  .cl-addr-fields { grid-template-columns: minmax(0, 1fr) minmax(0, 2fr); align-items: start; }
}
@media (min-width: 900px) {
  .cl-tag-input input { font-size: 14px; }
}
@media (max-width: 639.98px) {
  .cl-actions .btn { flex: 1 1 calc(50% - 8px); }
}
`;

const STYLE_ID = 'desk-client-styles';
if (typeof document !== 'undefined' && !document.getElementById(STYLE_ID)) {
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.append(style);
}

// Contact glyphs ui.js has no icon for, drawn in the same 24×24 stroke style as its Icon.
const GLYPHS = {
  phone: ['M5 3h3.5l1.8 4.5-2.3 1.5a11 11 0 0 0 7 7l1.5-2.3L21 15.5V19a2 2 0 0 1-2 2A17 17 0 0 1 3 5a2 2 0 0 1 2-2z'],
  chat: ['M20.5 11.6a8.5 8.5 0 0 1-12.4 7.5L3.5 20.5l1.4-4.4a8.5 8.5 0 1 1 15.6-4.5z'],
  camera: [
    'M7 3h10a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V7a4 4 0 0 1 4-4z',
    'M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0z',
    'M17.5 6.5h.01',
  ],
};

function Glyph({ name, size = 18 }) {
  return html`<svg class="icon" width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" focusable="false" aria-hidden="true"
  >${GLYPHS[name].map((d) => html`<path d=${d} />`)}</svg>`;
}

// ---------------------------------------------------------------------------------------------
// Contact links and birthdays (exported for tests and other views)
// ---------------------------------------------------------------------------------------------

/**
 * International digits for a phone number, as wa.me wants them: UK numbers starting 0 become
 * 44…, '0044' and '+44 (0)7…' lose their extra zeros, and a bare UK mobile '7700 900123' gets
 * 44. Null when it isn't a phone number.
 */
export function phoneDigits(phone) {
  const raw = clean(phone);
  if (!raw || !PHONE_CHARS.test(raw)) return null;
  let digits = raw.replace(/\D/g, '');
  if (!raw.startsWith('+')) {
    if (digits.startsWith('00')) digits = digits.slice(2);
    else if (digits.startsWith('0')) digits = `44${digits.slice(1)}`;
    else if (/^7\d{9}$/.test(digits)) digits = `44${digits}`;
  }
  // '+44 (0)7700 900123' keeps the UK trunk zero in brackets.
  if (/^440\d{9,10}$/.test(digits)) digits = `44${digits.slice(3)}`;
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

/** tel: link (always international, so it dials from anywhere), or null. */
export function telHref(phone) {
  const digits = phoneDigits(phone);
  return digits ? `tel:+${digits}` : null;
}

/** https://wa.me/<digits>, or null. */
export function whatsappHref(phone) {
  const digits = phoneDigits(phone);
  return digits ? `https://wa.me/${digits}` : null;
}

/** 'marcusrashford' from '@marcusrashford' or an instagram.com profile link; null if invalid. */
export function instagramHandle(value) {
  let raw = clean(value);
  const fromUrl = /instagram\.com\/([^/?#\s]+)/i.exec(raw);
  if (fromUrl) raw = fromUrl[1];
  raw = raw.replace(/^@+/, '');
  return INSTAGRAM_HANDLE.test(raw) ? raw : null;
}

export function instagramHref(value) {
  const handle = instagramHandle(value);
  return handle ? `https://instagram.com/${handle}` : null;
}

function emailHref(email) {
  const address = clean(email);
  return EMAIL_PATTERN.test(address) ? `mailto:${address}` : null;
}

/** A Google Maps link that opens the maps app on a phone. */
function mapsHref(address) {
  const lat = Number(address?.lat);
  const lng = Number(address?.lng);
  const located = address?.lat !== null && address?.lat !== undefined && Number.isFinite(lat) && Number.isFinite(lng);
  const query = located ? `${lat},${lng}` : clean(address?.address);
  return query ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}` : null;
}

// Days since 1970-01-01 for a calendar day; setUTCFullYear keeps years below 100 literal.
function dayIndex(year, month, day) {
  const t = new Date(0);
  t.setUTCFullYear(year, month - 1, day);
  return Math.round(t.getTime() / MS_PER_DAY);
}

function parseDay(iso) {
  const match = ISO_DAY.exec(clean(iso));
  if (!match) return null;
  const [y, m, d] = match.slice(1).map(Number);
  const index = dayIndex(y, m, d);
  const check = new Date(index * MS_PER_DAY);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  return { y, m, d, index };
}

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * { age, daysUntil, turning } for a 'YYYY-MM-DD' birthday as of `today`; null for a missing,
 * invalid or future date. A 29 Feb birthday is kept on 28 Feb in other years.
 */
export function birthdayInfo(iso, today = todayISO()) {
  const birth = parseDay(iso);
  const now = parseDay(today);
  if (!birth || !now || birth.index > now.index) return null;
  const observed = (year) => dayIndex(year, birth.m, birth.m === 2 && birth.d === 29 && !isLeapYear(year) ? 28 : birth.d);
  const thisYear = observed(now.y);
  const nextYear = now.index <= thisYear ? now.y : now.y + 1;
  return {
    age: now.y - birth.y - (now.index < thisYear ? 1 : 0),
    daysUntil: observed(nextYear) - now.index,
    turning: nextYear - birth.y,
  };
}

/** 'Birthday today — turns 27', 'Birthday tomorrow — turns 27', 'Birthday in 12 days'. */
export function birthdayText(info) {
  if (!info) return '';
  if (info.daysUntil === 0) return `Birthday today — turns ${info.turning}`;
  if (info.daysUntil === 1) return `Birthday tomorrow — turns ${info.turning}`;
  return `Birthday in ${plural(info.daysUntil, 'day')}`;
}

/** Saves the New sale hand-off and opens the form with this client chosen. */
function startSale(client, navigate) {
  try {
    window.sessionStorage.setItem(PREFILL_KEY, JSON.stringify({ client_id: client.id }));
    navigate('#/sales/new');
  } catch {
    // Storage blocked (private browsing): the New sale form also reads ?client= from the address.
    navigate(`#/sales/new?client=${encodeURIComponent(client.id)}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Form state: text for every input, plus tag and address lists
// ---------------------------------------------------------------------------------------------

let addressSequence = 0;
function addressKey() {
  addressSequence += 1;
  return `address-${addressSequence}`;
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** A saved address → an editable row: { key, label, place } where place feeds AddressInput. */
function addressRow(address = {}) {
  const lat = finiteOrNull(address.lat);
  const lng = finiteOrNull(address.lng);
  const located = lat !== null && lng !== null;
  const text = clean(address.address);
  return {
    key: addressKey(),
    label: clean(address.label),
    place: text || located ? { label: null, address: text || null, lat: located ? lat : null, lng: located ? lng : null } : null,
  };
}

function placeText(place) {
  return clean(place?.address) || clean(place?.label);
}

/**
 * Editable row → the stored { label, address, lat, lng }, or null for an empty row. A picked
 * place's own name ('St Mary's Stadium') leads the address when the row has another label.
 */
function addressFromRow(row) {
  const place = row.place;
  const text = placeText(place);
  if (!text) return null;
  const label = clean(row.label);
  const placeName = clean(place.label);
  const address = clean(place.address);
  const named = placeName && address && label && !normaliseText(address).includes(normaliseText(placeName))
    && normaliseText(placeName) !== DEVICE_LOCATION_LABEL;
  const lat = finiteOrNull(place.lat);
  const lng = finiteOrNull(place.lng);
  const located = lat !== null && lng !== null;
  return {
    label: label || null,
    address: named ? `${placeName}, ${address}` : text,
    lat: located ? lat : null,
    lng: located ? lng : null,
  };
}

function formFromClient(client) {
  const form = {};
  for (const key of TEXT_FIELDS) form[key] = typeof client?.[key] === 'string' ? client[key] : '';
  form.squad_number = squadNumber(form.squad_number);
  // The input shows an '@' before the handle.
  form.instagram = instagramHandle(form.instagram) ?? form.instagram;
  form.tags = Array.isArray(client?.tags) ? client.tags.filter((tag) => clean(tag)) : [];
  form.addresses = (Array.isArray(client?.addresses) ? client.addresses : [])
    .filter((address) => address && typeof address === 'object')
    .map(addressRow);
  form.archived = Boolean(client?.archived);
  return form;
}

/** Form → clients row (blank text becomes null so clearing a field clears it). */
function clientRowFromForm(form, { includeArchived }) {
  const row = {};
  for (const key of TEXT_FIELDS) row[key] = clean(form[key]) || null;
  row.squad_number = squadNumber(row.squad_number) || null;
  row.instagram = row.instagram ? instagramHandle(row.instagram) ?? row.instagram : null;
  row.tags = form.tags;
  row.addresses = form.addresses.map(addressFromRow).filter(Boolean);
  if (includeArchived) row.archived = form.archived;
  return row;
}

function phoneProblem(value) {
  const text = clean(value);
  if (!text) return null;
  if (!PHONE_CHARS.test(text)) return 'Use digits, spaces and + only, e.g. 07700 900123.';
  const digits = text.replace(/\D/g, '').length;
  if (digits < 7 || digits > 15) return "That doesn't look like a full phone number.";
  return null;
}

function emailProblem(value) {
  const text = clean(value);
  return text && !EMAIL_PATTERN.test(text) ? "That doesn't look like an email address." : null;
}

/** Field (or address row key) → message; empty when the form can be saved. */
function clientProblems(form, today = todayISO()) {
  const problems = {};
  const name = clean(form.name);
  if (!name) problems.name = 'Enter the client’s name.';
  else if (name.length > MAX_NAME) problems.name = `Keep the name under ${MAX_NAME} characters.`;
  problems.phone = phoneProblem(form.phone);
  problems.agent_phone = phoneProblem(form.agent_phone);
  problems.email = emailProblem(form.email);
  problems.agent_email = emailProblem(form.agent_email);
  if (clean(form.instagram) && !instagramHandle(form.instagram)) {
    problems.instagram = 'Use their handle, e.g. marcusrashford — letters, numbers, dots and underscores.';
  }
  const birthday = clean(form.birthday);
  if (birthday) {
    const day = parseDay(birthday);
    if (!day) problems.birthday = 'Enter a real date.';
    else if (birthday > today) problems.birthday = "A birthday can't be in the future.";
    else if (day.y < OLDEST_BIRTH_YEAR) problems.birthday = 'Check the year.';
  }
  for (const row of form.addresses) {
    if (!placeText(row.place) && clean(row.label)) problems[row.key] = 'Add the address or postcode, or remove this row.';
  }
  return Object.fromEntries(Object.entries(problems).filter(([, message]) => message));
}

function revealFirstError(container) {
  requestAnimationFrame(() => {
    const field = container?.querySelector('.has-error');
    if (!field) return;
    field.scrollIntoView({ block: 'center', behavior: 'smooth' });
    field.querySelector('input, select, textarea')?.focus({ preventScroll: true });
  });
}

// Enter in a text box must not save a long form half-filled; Save is explicit.
function blockImplicitSubmit(event) {
  const target = event.target;
  if (event.key === 'Enter' && target instanceof HTMLInputElement && target.type !== 'submit') event.preventDefault();
}

function uniqueSorted(values) {
  const seen = new Map();
  for (const value of values) {
    const text = clean(value);
    if (text && !seen.has(text.toLowerCase())) seen.set(text.toLowerCase(), text);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, 'en-GB'));
}

// ---------------------------------------------------------------------------------------------
// Form controls
// ---------------------------------------------------------------------------------------------

/** Tags as removable chips: Enter or a comma adds what's typed, Backspace on empty removes. */
function TagInput({ value, onChange, suggestions = [] }) {
  const field = useField();
  const listId = useId('tag-ideas');
  const inputRef = useRef(null);
  const [text, setText] = useState('');
  const full = value.length >= MAX_TAGS;
  const ideas = suggestions.filter((tag) => !value.some((t) => t.toLowerCase() === tag.toLowerCase()));

  function add(raw) {
    const next = [...value];
    for (const part of String(raw).split(',')) {
      const tag = part.trim().replace(/\s+/g, ' ').slice(0, MAX_TAG_LENGTH);
      if (tag && next.length < MAX_TAGS && !next.some((t) => t.toLowerCase() === tag.toLowerCase())) next.push(tag);
    }
    if (next.length !== value.length) onChange(next);
    setText('');
  }

  function remove(tag) {
    onChange(value.filter((t) => t !== tag));
    inputRef.current?.focus();
  }

  function onInput(event) {
    const typed = event.currentTarget.value;
    // Picking a suggestion replaces the text with a whole tag (autocorrect replaces text too,
    // hence the exact match); a comma from a phone keyboard or a paste ends a tag.
    const replaced = !event.inputType || event.inputType === 'insertReplacementText';
    if (replaced && ideas.includes(typed)) {
      add(typed);
    } else if (typed.includes(',')) {
      const cut = typed.lastIndexOf(',');
      add(typed.slice(0, cut));
      setText(typed.slice(cut + 1).trimStart());
    } else {
      setText(typed);
    }
  }

  function onKeyDown(event) {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      add(text);
    } else if (event.key === 'Backspace' && text === '' && value.length > 0) {
      event.preventDefault();
      onChange(value.slice(0, -1));
    }
  }

  const quick = full ? [] : ideas.slice(0, 6);
  return html`<div class="stack stack-sm">
  <div class="cl-tag-input" onClick=${(event) => event.target === event.currentTarget && inputRef.current?.focus()}>
    ${value.map((tag) => html`<span key=${tag} class="cl-tag">
      <span class="cl-tag-text">${tag}</span>
      <button type="button" aria-label=${`Remove tag ${tag}`} onClick=${() => remove(tag)}><${Icon} name="x" size=${14} /></button>
    </span>`)}
    <input
      ref=${inputRef}
      id=${field?.controlId}
      aria-describedby=${field?.describedBy}
      type="text"
      list=${listId}
      value=${text}
      disabled=${full}
      placeholder=${full ? `${MAX_TAGS} tags is the limit` : value.length ? 'Add another' : 'e.g. VIP, Pays cash'}
      autocomplete="off"
      enterkeyhint="done"
      onInput=${onInput}
      onKeyDown=${onKeyDown}
      onBlur=${() => text.trim() && add(text)}
    />
    <datalist id=${listId}>${ideas.map((tag) => html`<option key=${tag} value=${tag} />`)}</datalist>
  </div>
  ${quick.length > 0 && html`<div class="cl-tag-ideas" role="group" aria-label="Suggested tags">
    ${quick.map((tag) => html`<button key=${tag} type="button" class="chip" onClick=${() => add(tag)}>+ ${tag}</button>`)}
  </div>`}
  </div>`;
}

/**
 * Drop-off addresses, each in its own box: "Address 1" with Remove, then a label ('Training
 * ground') and the address picked or typed. A new row isn't focused: the address box opens its
 * suggestions on focus, which would cover the row before anything is typed.
 */
function AddressRows({ store, rows, onChange, problems }) {
  const labelsId = useId('address-labels');

  const update = (key, patch) => onChange(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  function pickPlace(key, place) {
    const row = rows.find((entry) => entry.key === key);
    const name = clean(place?.label);
    // A picked place's name makes a good label until the user gives one.
    const label = row?.label || (name && name !== placeText(place) && name.toLowerCase() !== DEVICE_LOCATION_LABEL ? name : '');
    update(key, { place, label });
  }

  return html`<div class="cl-addr-list">
    ${rows.map((row, index) => html`<div key=${row.key} class="repeat-block">
      <div class="cl-addr-head">
        <span class="cl-addr-title">${clean(row.label) || `Address ${index + 1}`}</span>
        <${Button}
          kind="ghost"
          size="sm"
          icon="trash"
          aria-label=${`Remove address ${index + 1}`}
          onClick=${() => onChange(rows.filter((entry) => entry.key !== row.key))}
        >Remove<//>
      </div>
      <div class="cl-addr-fields">
        <${Field} label="Label">
          <${Input}
            list=${labelsId}
            value=${row.label}
            maxlength="60"
            placeholder="e.g. Training ground"
            autocomplete="off"
            autocapitalize="words"
            onInput=${(event) => update(row.key, { label: event.currentTarget.value })}
          />
        <//>
        <${Field} label="Address or postcode" error=${problems[row.key]}>
          <${AddressInput}
            store=${store}
            value=${row.place}
            onChange=${(place) => pickPlace(row.key, place)}
            placeholder="Search an address or postcode"
          />
        <//>
      </div>
    </div>`)}
    <datalist id=${labelsId}>${ADDRESS_LABELS.map((label) => html`<option key=${label} value=${label} />`)}</datalist>
    ${rows.length < MAX_ADDRESSES && html`<div>
      <${Button} icon="plus" onClick=${() => onChange([...rows, addressRow()])}>${rows.length ? 'Add another address' : 'Add an address'}<//>
    </div>`}
  </div>`;
}

// ---------------------------------------------------------------------------------------------
// Create / edit form
// ---------------------------------------------------------------------------------------------

function ClientForm({ store, client, title, back, onSaved, onCancel }) {
  const formId = useId('client-form');
  const formRef = useRef(null);
  const mountedRef = useRef(true);
  const [initial] = useState(() => formFromClient(client));
  const [form, setForm] = useState(initial);
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const { data: others } = useStoreData(store, (s) => s.clients.list({ includeArchived: true }));

  const editing = Boolean(client);

  useEffect(() => {
    // A new client starts in the name box — with a mouse or trackpad only, so a phone's
    // keyboard doesn't cover the form before it is read. A frame later, because the shell
    // focuses the page itself after a route change, and its effect runs after this one.
    let frame = null;
    if (!editing && window.matchMedia?.('(pointer: fine)').matches) {
      frame = requestAnimationFrame(() => formRef.current?.querySelector('input')?.focus());
    }
    return () => {
      mountedRef.current = false;
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, []);

  const problems = clientProblems(form);
  const shown = tried ? problems : {};
  const dirty = useMemo(
    () => JSON.stringify(clientRowFromForm(form, { includeArchived: true }))
      !== JSON.stringify(clientRowFromForm(initial, { includeArchived: true })),
    [form, initial],
  );

  // Closing or reloading the tab with unsaved changes asks first.
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const suggestions = useMemo(() => {
    const rows = (others ?? []).filter((other) => other.id !== client?.id);
    return {
      clubs: uniqueSorted(rows.map((other) => other.club)),
      positions: uniqueSorted([...POSITIONS, ...rows.map((other) => other.position)]),
      tags: uniqueSorted([...rows.flatMap((other) => other.tags ?? []), ...TAG_IDEAS]),
    };
  }, [others, client?.id]);

  const duplicate = useMemo(() => {
    const name = normaliseText(clean(form.name));
    if (!name) return null;
    return (others ?? []).find((other) => other.id !== client?.id && normaliseText(clean(other.name)) === name) ?? null;
  }, [others, form.name, client?.id]);

  const set = (key) => (event) => {
    const value = event.currentTarget.value;
    setForm((prev) => ({ ...prev, [key]: value }));
  };
  const setValue = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));
  // The box already shows '@'; a pasted '@handle' or profile link keeps just the handle.
  const setInstagram = (event) => {
    const raw = event.currentTarget.value;
    const fromUrl = /instagram\.com\/([^/?#\s]+)/i.exec(raw);
    setValue('instagram', (fromUrl ? fromUrl[1] : raw).replace(/^@+/, ''));
  };

  async function submit(event) {
    event.preventDefault();
    if (saving) return;
    setTried(true);
    if (Object.keys(problems).length > 0) {
      revealFirstError(formRef.current);
      return;
    }
    setSaving(true);
    try {
      const row = clientRowFromForm(form, { includeArchived: editing });
      const saved = editing ? await store.clients.update(client.id, row) : await store.clients.create(row);
      toast(editing ? `Saved ${saved.name}.` : `Added ${saved.name}.`, { tone: 'gain' });
      if (mountedRef.current) onSaved(saved);
    } catch (err) {
      toast(err, { tone: 'loss' });
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }

  async function cancel() {
    if (dirty) {
      const discard = await confirmDialog({
        title: 'Discard your changes?',
        body: editing ? `Your changes to ${client.name} won't be saved.` : "This client won't be saved.",
        confirmLabel: 'Discard',
        cancelLabel: 'Keep editing',
        danger: true,
      });
      if (!discard) return;
    }
    onCancel();
  }

  const saveLabel = editing ? 'Save changes' : 'Add client';
  const buttons = () => html`
    <${Button} onClick=${cancel} disabled=${saving}>Cancel<//>
    <${Button} kind="primary" type="submit" form=${formId} icon="check" loading=${saving}>${saving ? 'Saving…' : saveLabel}<//>`;
  const nameHint = duplicate
    ? html`You already have a client called ${duplicate.name}. <a href=${`#/clients/${duplicate.id}`}>Open their profile</a>`
    : undefined;

  return html`<${Page} title=${title} back=${back}>
    <form id=${formId} ref=${formRef} class="cl-form stack" noValidate=${true} onSubmit=${submit} onKeyDown=${blockImplicitSubmit}>
      <${Card} title="Player">
        <div class="form-grid">
          <${Field} label="Name" required error=${shown.name} hint=${nameHint} class="span-all">
            <${Input}
              value=${form.name}
              maxlength=${MAX_NAME}
              autocomplete="off"
              autocapitalize="words"
              autocorrect="off"
              placeholder="e.g. Marcus Rashford"
              onInput=${set('name')}
            />
          <//>
          <${Field} label="Club">
            <${Input} value=${form.club} list=${`${formId}-clubs`} autocomplete="off" autocapitalize="words" placeholder="e.g. Southampton" onInput=${set('club')} />
          <//>
          <${Field} label="Position">
            <${Input} value=${form.position} list=${`${formId}-positions`} autocomplete="off" placeholder="e.g. Winger" onInput=${set('position')} />
          <//>
          <${Field} label="Squad number">
            <${Input} value=${form.squad_number} inputmode="numeric" maxlength="4" autocomplete="off" prefix="#" placeholder="7" onInput=${set('squad_number')} />
          <//>
        </div>
        <datalist id=${`${formId}-clubs`}>${suggestions.clubs.map((club) => html`<option key=${club} value=${club} />`)}</datalist>
        <datalist id=${`${formId}-positions`}>${suggestions.positions.map((name) => html`<option key=${name} value=${name} />`)}</datalist>
      <//>

      <${Card} title="Contact">
        <div class="form-grid">
          <${Field} label="Phone" error=${shown.phone} hint=${shown.phone ? undefined : 'Used for Call and WhatsApp.'}>
            <${Input} type="tel" value=${form.phone} inputmode="tel" autocomplete="off" placeholder="07700 900123" onInput=${set('phone')} />
          <//>
          <${Field} label="Email" error=${shown.email}>
            <${Input} type="email" value=${form.email} inputmode="email" autocomplete="off" autocapitalize="off" spellcheck=${false} placeholder="name@example.com" onInput=${set('email')} />
          <//>
          <${Field} label="Instagram" error=${shown.instagram}>
            <${Input}
              value=${form.instagram}
              prefix="@"
              autocomplete="off"
              autocapitalize="off"
              autocorrect="off"
              spellcheck=${false}
              placeholder="handle"
              onInput=${setInstagram}
            />
          <//>
        </div>
      <//>

      <${Card} title="Agent">
        <div class="form-grid">
          <${Field} label="Agent's name" class="span-all">
            <${Input} value=${form.agent_name} autocomplete="off" autocapitalize="words" autocorrect="off" onInput=${set('agent_name')} />
          <//>
          <${Field} label="Agent's phone" error=${shown.agent_phone}>
            <${Input} type="tel" value=${form.agent_phone} inputmode="tel" autocomplete="off" onInput=${set('agent_phone')} />
          <//>
          <${Field} label="Agent's email" error=${shown.agent_email}>
            <${Input} type="email" value=${form.agent_email} inputmode="email" autocomplete="off" autocapitalize="off" spellcheck=${false} onInput=${set('agent_email')} />
          <//>
        </div>
      <//>

      <${Card} title="Sizes and preferences">
        <div class="form-grid">
          <${Field} label="Shoe size">
            <${Input} value=${form.shoe_size} autocomplete="off" placeholder="e.g. UK 9" onInput=${set('shoe_size')} />
          <//>
          <${Field} label="Clothing size">
            <${Input} value=${form.clothing_size} autocomplete="off" placeholder="e.g. M / 32W" onInput=${set('clothing_size')} />
          <//>
          <${Field} label="Birthday" error=${shown.birthday} hint=${shown.birthday ? undefined : "Desk reminds you when it's coming up."}>
            <${Input} type="date" value=${form.birthday} max=${todayISO()} onInput=${set('birthday')} />
          <//>
          <${Field} label="Preferences" hint="Brands, styles and colours they like — or won't wear." class="span-all">
            <${Textarea} value=${form.preferences} placeholder="e.g. Jordan 1 Highs, Stone Island, no white trainers" onInput=${set('preferences')} />
          <//>
          <${Field} label="Tags" hint="Tap a suggestion, or type and press Enter." class="span-all">
            <${TagInput} value=${form.tags} onChange=${(tags) => setValue('tags', tags)} suggestions=${suggestions.tags} />
          <//>
        </div>
      <//>

      <${Card} title="Drop-off addresses">
        <p class="cl-section-note">
          Where you usually drop off — home, the training ground, the stadium. Pick a suggestion to pin it on the map; drives to this client start from here.
        </p>
        <${AddressRows} store=${store} rows=${form.addresses} onChange=${(rows) => setValue('addresses', rows)} problems=${shown} />
      <//>

      <${Card} title="Notes">
        <${Textarea} aria-label="Notes" value=${form.notes} rows=${4} placeholder="Anything worth remembering — who to deal with, when they're around, how they like to pay." onInput=${set('notes')} />
      <//>

      ${editing && html`<${Card} title="Status">
        <${Switch}
          checked=${form.archived}
          onChange=${(checked) => setValue('archived', checked)}
          label="Archived"
          hint="Hidden from your client list. Their sales stay in every total."
        />
      <//>`}

      <div class="form-bar">
        <span class="form-bar-summary small muted">${dirty ? 'Unsaved changes' : ''}</span>
        ${buttons()}
      </div>
    </form>
  <//>`;
}

// ---------------------------------------------------------------------------------------------
// Profile pieces
// ---------------------------------------------------------------------------------------------

/** A small label/value pair in the hero; `tone` colours the line under the value. */
function Fact({ label, value, sub, tone }) {
  return html`<div class="cl-fact">
    <span class="cl-fact-label">${label}</span>
    <span class="cl-fact-value">${value}</span>
    ${sub && html`<span class=${cx('cl-fact-sub', tone && `tone-${tone}`)}>${sub}</span>`}
  </div>`;
}

function ProfileHero({ client, onEdit }) {
  const birthday = birthdayInfo(client.birthday);
  const soon = birthday && birthday.daysUntil <= BIRTHDAY_SOON_DAYS;
  const facts = [
    clean(client.shoe_size) && html`<${Fact} key="shoe" label="Shoe" value=${client.shoe_size} />`,
    clean(client.clothing_size) && html`<${Fact} key="clothing" label="Clothing" value=${client.clothing_size} />`,
    birthday && html`<${Fact}
      key="age"
      label="Age"
      value=${String(birthday.age)}
      sub=${birthdayText(birthday)}
      tone=${soon ? 'warn' : undefined}
    />`,
    clean(client.agent_name) && html`<${Fact} key="agent" label="Agent" value=${client.agent_name} />`,
  ].filter(Boolean);

  const tel = telHref(client.phone);
  const whatsapp = whatsappHref(client.phone);
  const instagram = instagramHref(client.instagram);
  const email = emailHref(client.email);
  const agentTel = telHref(client.agent_phone);
  const external = { target: '_blank', rel: 'noopener noreferrer' };

  return html`<${Card}>
    <div class="cl-hero">
      <${Avatar} name=${client.name} size="lg" />
      <div class="cl-hero-main">
        ${facts.length > 0
          ? html`<div class="cl-facts">${facts}</div>`
          : html`<p class="muted">No sizes saved yet. <button type="button" class="link" onClick=${onEdit}>Add shoe and clothing sizes</button></p>`}
        <${TagPills} tags=${client.tags} />
      </div>
    </div>
    <div class="row cl-actions">
      ${tel && html`<${Button} href=${tel} icon=${html`<${Glyph} name="phone" />`}>Call<//>`}
      ${whatsapp && html`<${Button} href=${whatsapp} ...${external} icon=${html`<${Glyph} name="chat" />`}>WhatsApp<//>`}
      ${instagram && html`<${Button} href=${instagram} ...${external} icon=${html`<${Glyph} name="camera" />`}>Instagram<//>`}
      ${email && html`<${Button} href=${email} icon="mail">Email<//>`}
      ${agentTel && html`<${Button} href=${agentTel} icon=${html`<${Glyph} name="phone" />`}>Call agent<//>`}
      <${Button} href=${`#/trips?client=${encodeURIComponent(client.id)}`} icon="car">Log a drive<//>
    </div>
    ${!tel && !instagram && !email && html`<p class="small muted cl-hint-line">
      Add a phone number to call or WhatsApp ${firstName(client.name)} from here.
    </p>`}
  <//>`;
}

/** '£1,240.00' with a small "est." when some of the orders behind it are still estimated. */
function estValue(amount, estimated) {
  return estimated ? html`${money(amount)}<span class="cl-est" title="Some costs are still expected">est.</span>` : money(amount);
}

// What the client is worth: lifetime profit up front, then orders, profit per order, revenue
// and what they owe. An order is one sale, which may hold several items.
function ProfileStats({ stats, target }) {
  const hasSales = stats.count > 0;
  const estimated = stats.estimatedCount > 0;
  const pending = Math.abs(stats.pendingProfit) > EPS;
  const belowTarget = stats.margin !== null && target > 0 && stats.margin < target;
  let profitSub = 'No orders yet';
  if (hasSales) {
    profitSub = [
      stats.margin !== null && `${pct(stats.margin)} margin${belowTarget ? ` · under ${pct(target)} target` : ''}`,
      pending && `${money(stats.pendingProfit)} still pending`,
    ].filter(Boolean).join(' · ') || 'All realised';
  }
  let owedSub = hasSales ? 'All paid up' : '—';
  if (stats.owed > EPS) {
    owedSub = stats.dueNow > EPS && stats.dueNow < stats.owed - EPS
      ? `${money(stats.dueNow)} on delivered orders`
      : stats.dueNow > EPS ? 'On delivered orders' : 'Not handed over yet';
  }
  const ordersSub = !hasSales ? 'None yet' : [stats.open > 0 && `${stats.open} open`, stats.lastSale && `last ${relDays(stats.lastSale)}`].filter(Boolean).join(' · ');

  return html`<div class="kpis cl-profile-stats">
    <${Stat}
      class="cl-stat-hero"
      label="Lifetime profit"
      value=${hasSales ? estValue(stats.netProfit, estimated) : money(0)}
      tone=${!hasSales ? undefined : stats.netProfit < -EPS ? 'loss' : 'gain'}
      sub=${profitSub}
    />
    <${Stat} label="Orders" value=${String(stats.count)} sub=${ordersSub || 'All delivered'} />
    <${Stat}
      label="Avg profit per order"
      value=${stats.avgProfit === null ? '—' : estValue(stats.avgProfit, estimated)}
      tone=${stats.avgProfit !== null && stats.avgProfit < -EPS ? 'loss' : undefined}
      sub=${hasSales ? `${plural(stats.items, 'item')} across ${plural(stats.count, 'order')}` : 'Profit ÷ orders'}
    />
    <${Stat} label="Lifetime revenue" value=${money(stats.revenue)} sub=${hasSales ? 'Excluding cancelled' : '—'} />
    <${Stat} label="Owed" value=${money(stats.owed)} tone=${stats.owed > EPS ? 'warn' : undefined} sub=${owedSub} />
  </div>`;
}

/** 'Travis Scott Jordan 1 Low ×1, +2 more' — the first item and how many others. */
function itemsSummary(items) {
  const list = (Array.isArray(items) ? items : []).filter(Boolean);
  if (list.length === 0) return 'No items yet';
  const first = `${clean(list[0].description) || 'Item'} ×${Number(list[0].qty) || 1}`;
  return list.length > 1 ? `${first}, +${list.length - 1} more` : first;
}

function SaleListRow({ deal }) {
  const totals = dealTotals(deal);
  const status = statusMeta[deal.status] ?? statusMeta.agreed;
  const payment = paymentMeta[totals.paymentStatus] ?? paymentMeta.none;
  const cancelled = deal.status === 'cancelled';
  const toBuy = (deal.items ?? []).filter((item) => item.cost_status !== 'actual').length;
  const state = [status.label, !cancelled && totals.paymentStatus !== 'none' && payment.label].filter(Boolean).join(', ');
  return html`<${ListRow}
    href=${`#/sales/${deal.id}`}
    title=${itemsSummary(deal.items)}
    badge=${toBuy > 0 && !cancelled && html`<span class="pill pill-warn">${toBuy} to buy</span>`}
    subtitle=${`${saleDateText(deal.sale_date)} · ${dealNumber(deal.number)} · ${state}`}
    amount=${html`<${Money} value=${totals.netProfit} tone=${cancelled ? 'muted' : 'auto'} />${totals.certainty === 'estimated' && !cancelled ? html`<span class="tone-warn small"> est.</span>` : ''}`}
    meta=${`${money(totals.revenue)} revenue`}
  />`;
}

function SalesCard({ client, deals, navigate }) {
  const phone = usePhone();
  const live = deals.filter((deal) => deal.status !== 'cancelled').length;
  const cancelled = deals.length - live;
  const subtitle = deals.length === 0 ? null : [plural(live, 'order'), cancelled > 0 && `${cancelled} cancelled`].filter(Boolean).join(' · ');
  const newSale = html`<${Button} size="sm" icon="plus" onClick=${() => startSale(client, navigate)}>New sale<//>`;

  return html`<${Card} pad=${false} title="Orders" subtitle=${subtitle} actions=${deals.length > 0 ? newSale : null}>
    ${deals.length === 0
      ? html`<${Empty}
          icon="tag"
          title="No orders yet"
          body=${`Log a sale for ${firstName(client.name)} as soon as it's agreed — even before you've bought the item.`}
          action=${html`<${Button} kind="primary" icon="plus" onClick=${() => startSale(client, navigate)}>New sale for ${firstName(client.name)}<//>`}
        />`
      : phone
        ? html`<ul class="lr-list">${deals.map((deal) => html`<${SaleListRow} key=${deal.id} deal=${deal} />`)}</ul>`
        : html`<div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th scope="col">Order</th>
                <th scope="col">Status</th>
                <th scope="col" class="num">Revenue</th>
                <th scope="col" class="num">Profit</th>
              </tr>
            </thead>
            <tbody>
              ${deals.map((deal) => html`<${SaleRow} key=${deal.id} deal=${deal} navigate=${navigate} />`)}
            </tbody>
          </table>
        </div>`}
  <//>`;
}

// Four columns, so the table fits beside the details column: the date rides with the
// number and the payment badge sits under the status.
function SaleRow({ deal, navigate }) {
  const totals = dealTotals(deal);
  const href = `#/sales/${deal.id}`;
  const status = statusMeta[deal.status] ?? statusMeta.agreed;
  const payment = paymentMeta[totals.paymentStatus] ?? paymentMeta.none;
  const cancelled = deal.status === 'cancelled';
  const toBuy = (deal.items ?? []).filter((item) => item.cost_status !== 'actual').length;
  return html`<tr class="is-clickable" onClick=${() => navigate(href)}>
    <td class="cell-primary">
      <div class="cl-clamp">${itemsSummary(deal.items)}</div>
      <div class="small muted cl-sale-sub">
        ${saleDateText(deal.sale_date)} · <a href=${href} class="mono" onClick=${(event) => event.stopPropagation()}>${dealNumber(deal.number)}</a>${clean(deal.title) ? ` · ${deal.title.trim()}` : ''}
      </div>
      ${toBuy > 0 && !cancelled && html`<span class="pill pill-warn">${toBuy} to buy</span>`}
    </td>
    <td data-label="Status">
      <div><${Badge} tone=${status.tone}>${status.label}<//></div>
      ${!cancelled && totals.paymentStatus !== 'none' && html`<div class="cl-sale-badge">
        <${Badge} tone=${payment.tone}>${payment.label}<//>
      </div>`}
      ${!cancelled && totals.paymentStatus === 'part' && html`<div class="tiny faint">${money(totals.balance)} due</div>`}
    </td>
    <td data-label="Revenue" class="num"><${Money} value=${totals.revenue} tone=${cancelled ? 'muted' : undefined} /></td>
    <td data-label="Profit" class="num cell-key">
      <${Money} value=${totals.netProfit} tone=${cancelled ? 'muted' : 'auto'} class="strong" />
      ${totals.certainty === 'estimated' && !cancelled && html` <span class="pill pill-warn" title="Some costs are still expected">est.</span>`}
    </td>
  </tr>`;
}

// "St Mary's Stadium" from "St Mary's Stadium, Britannia Road, Southampton SO14 5FP".
function shortPlace(label, address) {
  const text = clean(label) || clean(address);
  return text ? text.split(',')[0].trim() : null;
}

function DrivesCard({ client, trips, stats }) {
  const phone = usePhone();
  const logDrive = `#/trips?client=${encodeURIComponent(client.id)}`;
  const totals = trips.map((trip) => ({ trip, t: tripTotals(trip) }));
  const milesDriven = totals.reduce((sum, { t }) => sum + t.miles, 0);
  const cashCost = totals.reduce((sum, { t }) => sum + t.cashCost, 0);
  const perHour = stats?.perDrivingHour ?? null;
  const subtitle = trips.length
    ? [plural(trips.length, 'drive'), formatMiles(milesDriven), `${money(cashCost)} costs`, perHour !== null && `${money(perHour)} per driving hour`].filter(Boolean).join(' · ')
    : null;

  return html`<${Card}
    pad=${false}
    title="Drives"
    subtitle=${subtitle}
    actions=${trips.length > 0 ? html`<${Button} size="sm" icon="car" href=${logDrive}>Log a drive<//>` : null}
  >
    ${trips.length === 0
      ? html`<${Empty}
          icon="car"
          title="No drives logged"
          body="Log the drive when you drop off — Desk works out the fuel, your time and what the sale really made per hour."
          action=${html`<${Button} icon="car" href=${logDrive}>Log a drive<//>`}
        />`
      : phone
        ? html`<ul class="lr-list">${totals.map(({ trip, t }) => {
            const to = shortPlace(trip.dest_label, trip.dest_address) ?? 'Drive';
            const name = clean(trip.label);
            return html`<${ListRow}
              key=${trip.id}
              href=${trip.deal ? `#/sales/${trip.deal.id}` : '#/trips'}
              title=${name || `To ${to}`}
              subtitle=${[formatDate(trip.trip_date), trip.deal && dealNumber(trip.deal.number), trip.round_trip ? 'There and back' : 'One way'].filter(Boolean).join(' · ')}
              amount=${money(t.cashCost)}
              meta=${`${formatMiles(t.miles)} · ${duration(t.totalMinutes)}`}
            />`;
          })}</ul>`
        : html`<div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th scope="col">Drive</th>
                <th scope="col">Date</th>
                <th scope="col">Sale</th>
                <th scope="col" class="num">Miles</th>
                <th scope="col" class="num">Time</th>
                <th scope="col" class="num">Cash cost</th>
              </tr>
            </thead>
            <tbody>
              ${totals.map(({ trip, t }) => {
                const to = shortPlace(trip.dest_label, trip.dest_address) ?? 'Drive';
                const name = clean(trip.label);
                return html`<tr key=${trip.id}>
                  <td class="cell-primary">
                    <span class="truncate">${name || `To ${to}`}</span>
                    <div class="small muted cl-sale-sub">${trip.round_trip ? 'There and back' : 'One way'}${name ? ` · ${to}` : ''}</div>
                  </td>
                  <td data-label="Date" class="nowrap">${formatDate(trip.trip_date)}</td>
                  <td data-label="Sale">${trip.deal
                    ? html`<a href=${`#/sales/${trip.deal.id}`} class="mono">${dealNumber(trip.deal.number)}</a>`
                    : html`<span class="faint">—</span>`}</td>
                  <td data-label="Miles" class="num">${formatMiles(t.miles)}</td>
                  <td data-label="Time" class="num">${duration(t.totalMinutes)}</td>
                  <td data-label="Cash cost" class="num strong">${money(t.cashCost)}</td>
                </tr>`;
              })}
            </tbody>
          </table>
        </div>`}
  <//>`;
}

// Club, birthday and contact details; sizes, age and the agent's name are up in the hero.
function DetailsCard({ client, onEdit }) {
  const birthday = birthdayInfo(client.birthday);
  const handle = instagramHandle(client.instagram);
  const link = (href, text, external = false) => (href
    ? html`<a href=${href} target=${external ? '_blank' : undefined} rel=${external ? 'noopener noreferrer' : undefined}>${text}</a>`
    : text);
  const rows = [
    ['Birthday', birthday && formatDate(client.birthday)],
    ['Phone', clean(client.phone) && link(telHref(client.phone), client.phone.trim())],
    ['Email', clean(client.email) && link(emailHref(client.email), client.email.trim())],
    ['Instagram', clean(client.instagram) && link(instagramHref(client.instagram), handle ? `@${handle}` : client.instagram.trim(), true)],
    ['Agent', clean(client.agent_name)],
    ['Agent phone', clean(client.agent_phone) && link(telHref(client.agent_phone), client.agent_phone.trim())],
    ['Agent email', clean(client.agent_email) && link(emailHref(client.agent_email), client.agent_email.trim())],
    ['Client since', client.created_at && formatDate(client.created_at)],
  ].filter(([, value]) => value);
  const preferences = clean(client.preferences);

  return html`<${Card} title="Details" actions=${html`<${Button} kind="ghost" size="sm" icon="edit" onClick=${onEdit}>Edit<//>`}>
    <dl class="kv kv-wrap">
      ${rows.map(([label, value]) => html`<div key=${label}><dt>${label}</dt><dd>${value}</dd></div>`)}
    </dl>
    ${rows.length <= 1 && !preferences && html`<p class="small muted">
      No club, contact or agent details yet. <button type="button" class="link" onClick=${onEdit}>Add them</button>
    </p>`}
    ${preferences && html`<div class="cl-block">
      <div class="cl-block-title">Preferences</div>
      <p class="cl-text">${preferences}</p>
    </div>`}
  <//>`;
}

function AddressesCard({ client, onEdit }) {
  const addresses = (Array.isArray(client.addresses) ? client.addresses : [])
    .filter((address) => address && (clean(address.address) || clean(address.label)));
  return html`<${Card}
    pad=${addresses.length === 0}
    title="Drop-off addresses"
    actions=${addresses.length > 0 ? html`<${Button} kind="ghost" size="sm" icon="edit" onClick=${onEdit}>Edit<//>` : null}
  >
    ${addresses.length === 0
      ? html`<p class="muted small">No addresses yet. <button type="button" class="link" onClick=${onEdit}>Add where you drop off</button></p>`
      : html`<ul class="list cl-address">
          ${addresses.map((address, index) => {
            const href = mapsHref(address);
            return html`<li key=${index} class="list-item">
              <${Icon} name="map-pin" size=${18} />
              <div class="list-main">
                <div class="list-title">${clean(address.label) || 'Address'}</div>
                <div class="list-sub">${clean(address.address)}</div>
              </div>
              ${href && html`<div class="list-aside">
                <${Button} kind="ghost" size="sm" href=${href} target="_blank" rel="noopener noreferrer" iconAfter="external" aria-label=${`Open ${clean(address.label) || 'address'} in Maps`}>Map<//>
              </div>`}
            </li>`;
          })}
        </ul>`}
  <//>`;
}

function ManageCard({ client, counts, busy, onArchive, onDelete }) {
  return html`<${Card} title="Manage">
    <div class="stack-sm stack">
      <p class="small muted">
        ${client.archived
          ? 'Archived: hidden from your client list. Their sales still count in every total.'
          : 'Archive a client you no longer sell to — they leave your list but their sales still count.'}
      </p>
      <div class="row">
        <${Button} icon=${client.archived ? 'refresh' : 'box'} loading=${busy === 'archive'} disabled=${Boolean(busy)} onClick=${onArchive}>
          ${client.archived ? 'Unarchive' : 'Archive'}
        <//>
        <${Button} kind="danger" icon="trash" loading=${busy === 'delete'} disabled=${Boolean(busy)} onClick=${onDelete}>Delete client<//>
      </div>
      ${(counts.sales > 0 || counts.trips > 0) && html`<p class="tiny faint">
        Deleting keeps their ${[counts.sales > 0 && plural(counts.sales, 'sale'), counts.trips > 0 && plural(counts.trips, 'drive')].filter(Boolean).join(' and ')}.
      </p>`}
    </div>
  <//>`;
}

// ---------------------------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------------------------

async function loadProfile(store, id) {
  const [client, deals, trips, settings] = await Promise.all([
    store.clients.get(id),
    store.deals.list(),
    store.trips.list(),
    store.settings.get(),
  ]);
  if (!client) return { client: null };
  const clientDeals = deals.filter((deal) => deal.client_id === id);
  const dealIds = new Set(clientDeals.map((deal) => deal.id));
  return {
    client,
    deals: clientDeals,
    // Drives to this client, and drives for their sales that weren't tagged with the client.
    trips: trips.filter((trip) => trip.client_id === id || (trip.deal_id && dealIds.has(trip.deal_id))),
    settings,
  };
}

function ClientProfile({ store, id, params, navigate }) {
  const { data, error, loading, reload } = useStoreData(store, (s) => loadProfile(s, id), [id]);
  const [busy, setBusy] = useState(null);
  const pushedEditRef = useRef(false);
  const firstRenderRef = useRef(true);
  const editing = params.edit === '1';
  const profileHref = `#/clients/${encodeURIComponent(id)}`;

  // Switching between profile and form starts at the top, like a new page.
  useEffect(() => {
    if (firstRenderRef.current) {
      firstRenderRef.current = false;
      return;
    }
    window.scrollTo(0, 0);
  }, [editing]);

  const stats = useMemo(() => (data?.client ? clientStats(data.deals) : null), [data]);

  function startEdit() {
    pushedEditRef.current = true;
    navigate(`${profileHref}?edit=1`);
  }

  // Leaves the form: back through history when we opened it, so Back doesn't return to it.
  function finishEdit() {
    if (pushedEditRef.current) {
      pushedEditRef.current = false;
      window.history.back();
    } else {
      navigate(profileHref, { replace: true });
    }
  }

  if (loading) {
    return html`<${Page} title="Client" back="#/clients"><${Loading} label="Loading client…" /><//>`;
  }
  if (error && !data) {
    return html`<${Page} title="Client" back="#/clients">
      <${Card}><${ErrorState} error=${error} title="Couldn't load this client" onRetry=${reload} /><//>
    <//>`;
  }
  if (!data.client) {
    return html`<${Page} title="Client not found" back="#/clients">
      <${Card}>
        <${Empty}
          icon="users"
          title="This client doesn't exist"
          body="They may have been deleted, or the link is wrong."
          action=${html`<${Button} href="#/clients">All clients<//>`}
        />
      <//>
    <//>`;
  }

  const { client, deals, trips, settings } = data;

  if (editing) {
    return html`<${ClientForm}
      key=${client.id}
      store=${store}
      client=${client}
      title=${`Edit ${client.name}`}
      back=${{ href: profileHref, label: client.name }}
      onSaved=${finishEdit}
      onCancel=${finishEdit}
    />`;
  }

  const counts = { sales: deals.length, trips: trips.filter((trip) => trip.client_id === id).length };

  async function toggleArchived() {
    const next = !client.archived;
    setBusy('archive');
    try {
      await store.clients.update(client.id, { archived: next });
      toast(next ? `${client.name} archived — hidden from your client list.` : `${client.name} is back in your client list.`, {
        tone: 'gain',
        action: {
          label: 'Undo',
          onClick: () => store.clients.update(client.id, { archived: !next }).catch((err) => toast(err, { tone: 'loss' })),
        },
      });
    } catch (err) {
      toast(err, { tone: 'loss' });
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    const kept = [counts.sales > 0 && plural(counts.sales, 'sale'), counts.trips > 0 && plural(counts.trips, 'drive')].filter(Boolean);
    const verb = counts.sales + counts.trips === 1 ? 'is' : 'are';
    const confirmed = await confirmDialog({
      title: `Delete ${client.name}?`,
      body: html`<div class="stack-sm stack">
        <p>Their profile, sizes, addresses and notes are deleted for good.</p>
        <p>${kept.length
          ? `Their ${kept.join(' and ')} ${verb} kept, but won't be linked to a client any more.`
          : 'They have no sales or drives, so nothing else changes.'}</p>
        ${!client.archived && html`<p class="muted">To just get them out of your list, archive them instead.</p>`}
      </div>`,
      confirmLabel: 'Delete client',
      danger: true,
    });
    if (!confirmed) return;
    setBusy('delete');
    try {
      await store.clients.remove(client.id);
      toast(`Deleted ${client.name}.`, { tone: 'gain' });
      navigate('#/clients', { replace: true });
    } catch (err) {
      toast(err, { tone: 'loss' });
      setBusy(null);
    }
  }

  const subtitle = html`${clientLine(client) || 'Client'}${client.archived && html` <${Badge} tone="muted" dot=${false}>Archived<//>`}`;
  const actions = html`
    <${Button} icon="edit" onClick=${startEdit}>Edit<//>
    <${Button} kind="primary" icon="plus" onClick=${() => startSale(client, navigate)}>New sale for ${firstName(client.name)}<//>`;

  return html`<${Page} title=${client.name} subtitle=${subtitle} back="#/clients" actions=${actions}>
    ${error && html`<${Banner} tone="warn" title="Couldn't refresh" actions=${html`<${Button} size="sm" onClick=${reload}>Try again<//>`}>
      ${error.message}
    <//>`}
    ${client.archived && html`<${Banner}
      tone="neutral"
      icon="box"
      title="Archived"
      actions=${html`<${Button} size="sm" loading=${busy === 'archive'} onClick=${toggleArchived}>Unarchive<//>`}
    >Hidden from your client list. Their sales still count in every total.<//>`}
    <${ProfileHero} client=${client} onEdit=${startEdit} />
    <${ProfileStats} stats=${stats} target=${Number(settings?.target_margin) || 0} />
    <div class="cl-layout">
      <div class="cl-main stack">
        <${SalesCard} client=${client} deals=${deals} navigate=${navigate} />
        <${DrivesCard} client=${client} trips=${trips} stats=${stats} />
      </div>
      <div class="cl-side stack">
        <${DetailsCard} client=${client} onEdit=${startEdit} />
        <${AddressesCard} client=${client} onEdit=${startEdit} />
        ${clean(client.notes) && html`<${Card} title="Notes"><p class="cl-text">${client.notes.trim()}</p><//>`}
        <${ManageCard} client=${client} counts=${counts} busy=${busy} onArchive=${toggleArchived} onDelete=${remove} />
      </div>
    </div>
  <//>`;
}

function NewClient({ store, navigate }) {
  return html`<${ClientForm}
    store=${store}
    client=${null}
    title="New client"
    back="#/clients"
    onSaved=${(saved) => navigate(`#/clients/${encodeURIComponent(saved.id)}`, { replace: true })}
    onCancel=${() => navigate('#/clients')}
  />`;
}

export default function ClientView({ store, params, navigate }) {
  if (params.id === 'new') return html`<${NewClient} store=${store} navigate=${navigate} />`;
  return html`<${ClientProfile} store=${store} id=${params.id} params=${params} navigate=${navigate} />`;
}

// Address / postcode box with suggestions (docs/desk-spec.md §1, components/address-input.js).
//
// A WAI-ARIA combobox. Typing 3+ characters asks store.api.places for UK places (debounced
// 300 ms, cached per query, newest answer wins); ↑/↓ move through the list, Enter picks,
// Escape closes it. "Use my location" reads the device position. Text left without picking a
// suggestion is kept as free text — onChange({ address }) with no coordinates — and the server
// geocodes it when the route is calculated. A check mark shows when the place is on the map.
//
// value / onChange: { label, address, lat, lng } | null.

import { html, useEffect, useRef, useState } from '../lib/preact.js';
import { Field, Icon, Input, Spinner, useId } from '../lib/ui.js';

const CSS = `
.addr { position: relative; min-width: 0; }
.addr .addr-input { padding-right: 40px; text-overflow: ellipsis; }
.addr-status { position: absolute; top: 0; right: 0; display: flex; align-items: center; justify-content: center; width: 40px; height: var(--ctl-h); color: var(--gain); pointer-events: none; }
.addr-status .spinner { width: 16px; height: 16px; }
.addr-pop { position: absolute; z-index: 40; top: calc(100% + 4px); left: 0; right: 0; overflow: hidden; border: 1px solid var(--line-2); border-radius: var(--r-panel); background: var(--surface); box-shadow: var(--shadow-pop); animation: fade-in 0.12s ease-out; }
.addr-list { max-height: min(320px, 50vh); margin: 0; padding: 4px; overflow-y: auto; list-style: none; overscroll-behavior: contain; }
.addr-option { display: flex; align-items: flex-start; gap: 10px; min-height: 44px; padding: 8px 10px; border-radius: var(--r-ctl); cursor: pointer; }
.addr-option[aria-selected="true"] { background: var(--signal-tint); }
@media (hover: hover) { .addr-option:hover { background: var(--hover); } .addr-option[aria-selected="true"]:hover { background: var(--signal-tint); } }
.addr-option .icon { flex: none; margin-top: 2px; color: var(--ink-3); }
.addr-option.is-locate .icon { color: var(--signal); }
.addr-option-text { display: flex; flex-direction: column; min-width: 0; }
.addr-option-title { overflow: hidden; color: var(--ink); font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
.addr-option-sub { overflow: hidden; color: var(--ink-2); font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.addr-pop-note { margin: 0; padding: 10px 14px; color: var(--ink-2); font-size: 13px; }
.addr-list + .addr-pop-note { border-top: 1px solid var(--line); }
.addr-note { margin: 6px 0 0; color: var(--ink-2); font-size: 12.5px; line-height: 1.4; }
`;

// Component styles live with the component and are added to <head> once, on first import.
const STYLE_ID = 'desk-address-input-styles';
if (typeof document !== 'undefined' && !document.getElementById(STYLE_ID)) {
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.append(style);
}

const DEBOUNCE_MS = 300;
const MIN_QUERY = 3;
const CACHE_LIMIT = 50;
const RETRY_AFTER_MS = 5000; // after a failed search, give the address service a moment
const LOCAL_RETRY_AFTER_MS = 60000; // local mode's search needs an account, so rarely recovers
const GEO_OPTIONS = { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 };
const MY_LOCATION = 'My location';

// Shared by every address box: the same query never asks the server twice.
const suggestionCache = new Map();
// store → { message, until }: a failed search pauses further requests for a while (longer in
// local mode) so typing never turns into a stream of failing calls.
const searchPauses = new WeakMap();

function normaliseQuery(text) {
  return String(text ?? '').trim().replace(/\s+/g, ' ');
}

function isCoordinate(v) {
  if (typeof v === 'number') return Number.isFinite(v);
  return typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v));
}

function hasCoords(place) {
  return Boolean(place) && isCoordinate(place.lat) && isCoordinate(place.lng);
}

/** The text an address box shows for a place: its address, else its label. */
export function placeText(place) {
  if (!place) return '';
  const address = typeof place.address === 'string' ? place.address.trim() : '';
  const label = typeof place.label === 'string' ? place.label.trim() : '';
  return address || label;
}

function toPlace(result) {
  return {
    label: result.label ?? null,
    address: result.address ?? null,
    lat: Number(result.lat),
    lng: Number(result.lng),
  };
}

function cacheResults(query, results) {
  suggestionCache.delete(query);
  suggestionCache.set(query, results);
  if (suggestionCache.size > CACHE_LIMIT) suggestionCache.delete(suggestionCache.keys().next().value);
}

function pauseFor(store) {
  const pause = searchPauses.get(store);
  if (!pause) return null;
  if (Date.now() >= pause.until) {
    searchPauses.delete(store);
    return null;
  }
  return pause;
}

function geolocationMessage(error) {
  if (error?.code === 1) return 'Location access is blocked — allow it in your browser settings, or type the address.';
  if (error?.code === 3) return 'Finding your location took too long — try again or type the address.';
  return "Couldn't work out where you are — type the address instead.";
}

/**
 * AddressInput({ store, value, onChange, placeholder, label, autoFocus })
 * With `label` it renders its own field; without one it can sit inside a ui.js Field.
 */
export default function AddressInput({ store, value, onChange, placeholder = 'Address or postcode', label, autoFocus = false }) {
  const valueText = placeText(value);
  const [text, setText] = useState(valueText);
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [busy, setBusy] = useState(null); // null | 'search' | 'locate'
  const [note, setNote] = useState(null);
  const [searched, setSearched] = useState(''); // query the current results answer

  const wrapRef = useRef(null);
  const timerRef = useRef(null);
  const requestRef = useRef(0);
  const mountedRef = useRef(true);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const listId = useId('addr-list');
  const optionId = (index) => `${listId}-${index}`;

  const canLocate = typeof navigator !== 'undefined' && Boolean(navigator.geolocation);
  const query = normaliseQuery(text);
  const edited = query !== normaliseQuery(valueText);
  const located = hasCoords(value) && !edited;

  // A value set from outside (a saved trip, "Home", a route result) replaces the text.
  useEffect(() => {
    setText(valueText);
  }, [valueText]);

  useEffect(() => {
    if (autoFocus) wrapRef.current?.querySelector('input')?.focus();
    return () => {
      mountedRef.current = false;
      clearTimeout(timerRef.current);
    };
  }, []);

  // While a newer search runs, the last answer stays up instead of flickering away.
  const showResults = query.length >= MIN_QUERY && edited && (searched === query || busy === 'search');
  const options = [];
  if (showResults) results.forEach((place) => options.push({ kind: 'place', place }));
  if (canLocate) {
    const locate = { kind: 'locate' };
    if (showResults) options.push(locate);
    else options.unshift(locate);
  }
  const activeIndex = active < options.length ? active : -1;
  const searching = busy === 'search' && query.length >= MIN_QUERY && edited;
  let popNote = null;
  if (searching && results.length === 0) popNote = 'Searching…';
  else if (showResults && results.length === 0) popNote = `No matches for “${query}”. Keep typing, or leave it as typed.`;
  const popOpen = open && (options.length > 0 || popNote !== null);

  function emit(place) {
    onChangeRef.current?.(place);
  }

  function search(rawText) {
    clearTimeout(timerRef.current);
    requestRef.current += 1; // any answer still on its way is now out of date
    const q = normaliseQuery(rawText);
    if (q.length < MIN_QUERY || !store?.api?.places) {
      setBusy(null);
      return;
    }
    if (suggestionCache.has(q)) {
      setResults(suggestionCache.get(q));
      setSearched(q);
      setBusy(null);
      return;
    }
    const pause = pauseFor(store);
    if (pause) {
      setNote(pause.message);
      setBusy(null);
      return;
    }
    setBusy('search');
    const request = requestRef.current;
    timerRef.current = setTimeout(async () => {
      try {
        const body = await store.api.places(q);
        const found = (Array.isArray(body?.results) ? body.results : []).filter(hasCoords);
        cacheResults(q, found);
        if (!mountedRef.current || request !== requestRef.current) return;
        setResults(found);
        setSearched(q);
        setBusy(null);
      } catch (error) {
        const message = error instanceof Error && error.message ? error.message : "Address search isn't working right now — type the address.";
        searchPauses.set(store, { message, until: Date.now() + (store.mode === 'memory' ? LOCAL_RETRY_AFTER_MS : RETRY_AFTER_MS) });
        if (!mountedRef.current || request !== requestRef.current) return;
        setResults([]);
        setSearched('');
        setBusy(null);
        setNote(message);
      }
    }, DEBOUNCE_MS);
  }

  function close() {
    setOpen(false);
    setActive(-1);
  }

  function pick(option) {
    clearTimeout(timerRef.current);
    requestRef.current += 1;
    close();
    if (option.kind === 'locate') {
      locate();
      return;
    }
    const place = toPlace(option.place);
    setText(placeText(place));
    setNote(null);
    setBusy(null);
    emit(place);
  }

  // Keeps typed text as an address without coordinates; an emptied box clears the place.
  function commitText() {
    if (!edited) return false;
    clearTimeout(timerRef.current);
    requestRef.current += 1;
    setBusy(null);
    emit(query ? { label: null, address: query, lat: null, lng: null } : null);
    return true;
  }

  function locate() {
    if (!canLocate) return;
    setBusy('locate');
    setNote(null);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (!mountedRef.current) return;
        const lat = Number(position.coords.latitude.toFixed(5));
        const lng = Number(position.coords.longitude.toFixed(5));
        const place = { label: MY_LOCATION, address: `${lat.toFixed(5)}, ${lng.toFixed(5)}`, lat, lng };
        setBusy(null);
        setText(placeText(place));
        emit(place);
      },
      (error) => {
        if (!mountedRef.current) return;
        setBusy(null);
        setNote(geolocationMessage(error));
      },
      GEO_OPTIONS,
    );
  }

  function onInput(event) {
    const next = event.currentTarget.value;
    setText(next);
    setActive(-1);
    setOpen(true);
    setNote(null);
    search(next);
  }

  function onKeyDown(event) {
    const count = options.length;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (!popOpen) {
          setOpen(true);
          if (edited && searched !== query) search(text);
        } else if (count) {
          setActive((activeIndex + 1) % count);
        }
        break;
      case 'ArrowUp':
        if (!popOpen || !count) break;
        event.preventDefault();
        setActive(activeIndex <= 0 ? count - 1 : activeIndex - 1);
        break;
      case 'Enter':
        if (popOpen && activeIndex >= 0) {
          event.preventDefault();
          pick(options[activeIndex]);
        } else if (commitText()) {
          // Keep a surrounding form from submitting before the new place reaches it.
          event.preventDefault();
          close();
        }
        break;
      case 'Escape':
        if (popOpen) {
          event.preventDefault(); // close the list, not an enclosing dialog
          close();
        } else if (edited) {
          event.preventDefault();
          setText(valueText);
        }
        break;
      default:
        break;
    }
  }

  function onBlur() {
    close();
    commitText();
  }

  const status = busy
    ? html`<${Spinner} label=${busy === 'locate' ? 'Finding your location' : 'Searching'} />`
    : located
      ? html`<${Icon} name="check" size=${18} label="On the map" />`
      : null;

  const control = html`<div class="addr" ref=${wrapRef}>
    <${Input}
      class="addr-input"
      type="text"
      role="combobox"
      aria-autocomplete="list"
      aria-expanded=${popOpen ? 'true' : 'false'}
      aria-controls=${listId}
      aria-activedescendant=${popOpen && activeIndex >= 0 ? optionId(activeIndex) : undefined}
      autocomplete="off"
      autocapitalize="words"
      spellcheck=${false}
      enterkeyhint="done"
      placeholder=${placeholder}
      value=${text}
      onInput=${onInput}
      onKeyDown=${onKeyDown}
      onFocus=${() => !query && setOpen(true)}
      onBlur=${onBlur}
    />
    <span class="addr-status">${status}</span>
    <div
      class="addr-pop"
      hidden=${!popOpen}
      onMouseDown=${(event) => event.preventDefault() /* keep focus in the box while picking */}
    >
      <ul class="addr-list" id=${listId} role="listbox" aria-label="Suggestions" hidden=${options.length === 0}>
        ${options.map((option, index) => {
          const selected = index === activeIndex;
          const common = {
            id: optionId(index),
            role: 'option',
            'aria-selected': selected ? 'true' : 'false',
            onClick: () => pick(option),
            onMouseMove: () => !selected && setActive(index),
          };
          if (option.kind === 'locate') {
            return html`<li key="locate" ...${common} class="addr-option is-locate">
              <${Icon} name="map-pin" size=${18} />
              <span class="addr-option-text">
                <span class="addr-option-title">Use my location</span>
                <span class="addr-option-sub">Start from where you are now</span>
              </span>
            </li>`;
          }
          const { place } = option;
          const sub = place.address && place.address !== place.label ? place.address : null;
          return html`<li key=${`${place.lat},${place.lng},${index}`} ...${common} class="addr-option">
            <${Icon} name="map-pin" size=${18} />
            <span class="addr-option-text">
              <span class="addr-option-title">${place.label || place.address}</span>
              ${sub && html`<span class="addr-option-sub">${sub}</span>`}
            </span>
          </li>`;
        })}
      </ul>
      ${popNote && html`<p class="addr-pop-note" role="status">${popNote}</p>`}
    </div>
  </div>`;

  const message = busy === 'locate' ? 'Finding your location…' : note;
  if (label) {
    return html`<${Field} label=${label} hint=${message ?? undefined}>${control}<//>`;
  }
  return html`<div class="addr-field">
    ${control}
    ${message && html`<p class="addr-note" role="status">${message}</p>`}
  </div>`;
}

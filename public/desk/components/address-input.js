// Address / postcode box with suggestions (docs/desk-spec.md §1, components/address-input.js).
//
// A WAI-ARIA combobox. Typing 3+ characters asks store.api.places for UK places — debounced
// 450 ms, skipped when the query hasn't changed, the previous request aborted, recent queries
// cached — and ↑/↓ move through up to five suggestions, Enter picks, Escape closes. Nothing
// opens on focus. The box wraps a chosen address over two lines, and a status line under it
// says whether the place is on the map. Text left without picking a suggestion is kept as free
// text — onChange({ address }) with no coordinates — and the server geocodes it when the route
// is calculated. An empty box offers a small "Use my location" link (the `locate` prop sets its
// wording, or false hides it).
//
// value / onChange: { label, address, lat, lng } | null.

import { html, useEffect, useLayoutEffect, useRef, useState } from '../lib/preact.js';
import { Field, Icon, Spinner, Textarea, useId } from '../lib/ui.js';

const CSS = `
.addr-field { min-width: 0; }
.addr { position: relative; min-width: 0; }
.addr .textarea.addr-input {
  display: block; height: auto; min-height: var(--ctl-h); max-height: calc(2 * 1.35em + 2 * var(--addr-pad-y) + 2px);
  --addr-pad-y: max(6px, calc((var(--ctl-h) - 2px - 1.35em) / 2));
  padding: var(--addr-pad-y) 12px; overflow-y: hidden; line-height: 1.35; white-space: pre-wrap; overflow-wrap: anywhere;
  resize: none; field-sizing: content; -webkit-tap-highlight-color: transparent;
}
.addr .textarea.addr-input.is-long { overflow-y: auto; }
.addr-pop {
  position: absolute; z-index: 80; top: calc(100% + 4px); left: 0; right: 0; overflow: hidden;
  border: 1px solid var(--line-2); border-radius: var(--r-panel); background: var(--surface);
  box-shadow: var(--shadow-pop); animation: fade-in 0.12s ease-out;
}
.addr-pop.is-up { top: auto; bottom: calc(100% + 4px); }
.addr-list { max-height: var(--addr-list-max, 320px); margin: 0; padding: 4px; overflow-y: auto; list-style: none; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; }
.addr-option { display: flex; align-items: flex-start; gap: 10px; min-height: 44px; padding: 8px 10px; border-radius: var(--r-ctl); cursor: pointer; -webkit-tap-highlight-color: transparent; }
.addr-option[aria-selected="true"] { background: var(--signal-tint); }
@media (hover: hover) { .addr-option:hover { background: var(--hover); } .addr-option[aria-selected="true"]:hover { background: var(--signal-tint); } }
.addr-option .icon { flex: none; margin-top: 2px; color: var(--ink-3); }
.addr-option-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.addr-option-title, .addr-option-sub { display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow-wrap: anywhere; }
.addr-option-title { color: var(--ink); font-weight: 500; line-height: 1.35; }
.addr-option-sub { color: var(--ink-2); font-size: 13px; line-height: 1.4; }
.addr-pop-note { margin: 0; padding: 10px 14px; color: var(--ink-2); font-size: 13px; line-height: 1.4; }
.addr-list + .addr-pop-note { border-top: 1px solid var(--line); }
.addr-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; min-height: 20px; margin-top: 6px; font-size: 12.5px; line-height: 1.4; }
.addr-meta:empty { display: none; }
.addr-state { display: inline-flex; align-items: flex-start; gap: 5px; min-width: 0; color: var(--ink-2); }
.addr-state .icon { flex: none; margin-top: 1px; }
.addr-state.is-pinned { color: var(--gain); font-weight: 500; }
.addr-state.is-loose, .addr-state.is-problem { color: var(--warn); }
.addr-state .spinner { flex: none; width: 13px; height: 13px; margin-top: 2px; }
.addr-locate {
  display: inline-flex; align-items: center; gap: 6px; min-height: 32px; margin: -6px 0; padding: 4px 2px;
  border: 0; background: none; color: var(--signal); font: inherit; font-weight: 500; cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.addr-locate:hover { text-decoration: underline; }
.addr-locate:focus-visible { border-radius: 4px; outline: 2px solid var(--signal); outline-offset: 2px; }
.addr-locate:disabled { color: var(--ink-3); cursor: default; text-decoration: none; }
/* Phones: the list sits in the page right under the box and pushes what follows down, so the
   tab bar, a sheet's scroll box or the keyboard never hides it. */
@media (max-width: 640px), (pointer: coarse) and (max-width: 900px) {
  .addr-pop, .addr-pop.is-up { position: relative; z-index: 1; top: auto; bottom: auto; margin-top: 6px; box-shadow: var(--shadow-pop, none); }
  .addr .textarea.addr-input { scroll-margin-top: calc(env(safe-area-inset-top, 0px) + 76px); }
}
`;

// Component styles live with the component and are added to <head> once, on first import.
const STYLE_ID = 'desk-address-input-styles';
if (typeof document !== 'undefined') {
  let style = document.getElementById(STYLE_ID);
  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ID;
    document.head.append(style);
  }
  style.textContent = CSS;
}

const DEBOUNCE_MS = 450;
const MIN_QUERY = 3;
const MAX_RESULTS = 5;
const CACHE_LIMIT = 60;
const CACHE_TTL_MS = 10 * 60 * 1000;
const RETRY_AFTER_MS = 5000; // after a failed search, give the address service a moment
const LOCAL_RETRY_AFTER_MS = 60000; // local mode's search needs an account, so rarely recovers
const GEO_OPTIONS = { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 };
const MY_LOCATION = 'My location';
const DEFAULT_LOCATE = 'Use my location';
const PHONE_QUERY = '(max-width: 640px), (pointer: coarse) and (max-width: 900px)';

// Shared by every address box: the same query never asks the server twice in a while.
const suggestionCache = new Map(); // key → { results, at }
// store → { message, until }: a failed search pauses further requests for a while (longer in
// local mode) so typing never turns into a stream of failing calls.
const searchPauses = new WeakMap();

function normaliseQuery(text) {
  return String(text ?? '').trim().replace(/\s+/g, ' ');
}

function cacheKey(query) {
  return query.toLowerCase();
}

function isCoordinate(v) {
  if (typeof v === 'number') return Number.isFinite(v);
  return typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v));
}

function hasCoords(place) {
  return Boolean(place) && isCoordinate(place.lat) && isCoordinate(place.lng);
}

function matches(query) {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
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

function cachedResults(query) {
  const key = cacheKey(query);
  const hit = suggestionCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    suggestionCache.delete(key);
    return null;
  }
  return hit.results;
}

function cacheResults(query, results) {
  const key = cacheKey(query);
  suggestionCache.delete(key);
  suggestionCache.set(key, { results, at: Date.now() });
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

function isAbort(error) {
  return error?.name === 'AbortError';
}

function geolocationMessage(error) {
  if (error?.code === 1) return 'Location access is blocked — allow it in your browser settings, or type the address.';
  if (error?.code === 3) return 'Finding your location took too long — try again or type the address.';
  return "Couldn't work out where you are — type the address instead.";
}

// The nearest ancestor that scrolls, or null for the page itself.
function scrollParent(node) {
  for (let el = node?.parentElement; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
    const { overflowY } = getComputedStyle(el);
    if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight) return el;
  }
  return null;
}

// The part of the screen a person can actually see, in client coordinates: the visual viewport
// (which shrinks for the iOS keyboard) less a fixed tab bar when one shows.
function visibleBand() {
  const vv = window.visualViewport;
  const top = vv ? vv.offsetTop : 0;
  let bottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
  const keyboardUp = vv ? window.innerHeight - vv.height > 120 : false;
  if (!keyboardUp) {
    const bar = document.querySelector('.tabbar');
    if (bar) {
      const rect = bar.getBoundingClientRect();
      if (rect.height > 0 && getComputedStyle(bar).position === 'fixed' && rect.top < bottom) bottom = rect.top;
    }
  }
  return { top, bottom };
}

/**
 * AddressInput({ store, value, onChange, placeholder, label, autoFocus, locate })
 * With `label` it renders its own field; without one it can sit inside a ui.js Field.
 * `locate`: true (default, "Use my location"), a string for field-specific wording, or false.
 */
export default function AddressInput({ store, value, onChange, placeholder = 'Address or postcode', label, autoFocus = false, locate: locateOption = true, needsPin = true }) {
  const valueText = placeText(value);
  const [text, setText] = useState(valueText);
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [busy, setBusy] = useState(null); // null | 'search' | 'locate'
  const [note, setNote] = useState(null);
  const [searched, setSearched] = useState(''); // query the current results answer
  const [focused, setFocused] = useState(false);
  const [placement, setPlacement] = useState({ up: false, max: 320 });

  const wrapRef = useRef(null);
  // ui.js Textarea doesn't forward refs, so the box is found inside the wrapper.
  const boxRef = { get current() { return wrapRef.current?.querySelector('textarea') ?? null; } };
  const popRef = useRef(null);
  const timerRef = useRef(null);
  const abortRef = useRef(null);
  const pendingRef = useRef(''); // query waiting on the timer or the server
  const requestRef = useRef(0);
  const mountedRef = useRef(true);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const listId = useId('addr-list');
  const statusId = useId('addr-status');
  const optionId = (index) => `${listId}-${index}`;

  const canLocate = locateOption !== false && typeof navigator !== 'undefined' && Boolean(navigator.geolocation);
  const locateText = typeof locateOption === 'string' && locateOption.trim() ? locateOption.trim() : DEFAULT_LOCATE;
  const query = normaliseQuery(text);
  const edited = query !== normaliseQuery(valueText);
  const located = hasCoords(value) && !edited;

  // A value set from outside (a saved trip, "Home", a route result) replaces the text.
  useEffect(() => {
    setText(valueText);
  }, [valueText]);

  useEffect(() => {
    // Focus from code raises no keyboard on a phone — it only jumps the page — so desktop only.
    if (autoFocus && matches('(pointer: fine)')) boxRef.current?.focus({ preventScroll: false });
    return () => {
      mountedRef.current = false;
      clearTimeout(timerRef.current);
      abortRef.current?.abort();
    };
  }, []);

  // The box grows to fit a long address, up to two lines (CSS caps it), then scrolls.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return undefined;
    const fit = () => {
      box.style.height = 'auto';
      const style = getComputedStyle(box);
      const borders = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
      const max = parseFloat(style.maxHeight);
      const wanted = box.scrollHeight + borders;
      box.style.height = `${Number.isFinite(max) ? Math.min(wanted, max) : wanted}px`;
      box.classList.toggle('is-long', Number.isFinite(max) && wanted > max + 1);
    };
    fit();
    if (typeof ResizeObserver !== 'function') return undefined;
    let width = box.clientWidth;
    const observer = new ResizeObserver(() => {
      if (box.clientWidth !== width) {
        width = box.clientWidth;
        fit();
      }
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, [text]);

  // While a newer search runs, the last answer stays up instead of flickering away.
  const showResults = query.length >= MIN_QUERY && edited && (searched === query || busy === 'search');
  const options = showResults ? results.slice(0, MAX_RESULTS) : [];
  const activeIndex = active < options.length ? active : -1;
  const searching = busy === 'search' && query.length >= MIN_QUERY && edited;
  let popNote = null;
  if (searching && options.length === 0) popNote = 'Searching…';
  else if (showResults && searched === query && options.length === 0) popNote = `No matches for “${query}”. Try a postcode, or leave it as typed.`;
  const popOpen = open && focused && edited && query.length >= MIN_QUERY && (options.length > 0 || popNote !== null);

  // Keep the list inside what can be seen: flip it above the box on desktop when there is no
  // room below; on phones (where it sits in the page) size it to the visual viewport and
  // scroll the box up so the list isn't under the keyboard or the tab bar.
  useLayoutEffect(() => {
    if (!popOpen || typeof window === 'undefined') return;
    const wrap = wrapRef.current;
    const box = boxRef.current;
    if (!wrap || !box) return;
    const band = visibleBand();
    const rect = box.getBoundingClientRect();
    if (matches(PHONE_QUERY)) {
      const room = band.bottom - band.top - rect.height - 110; // top bar, gaps
      const max = Math.max(150, Math.min(320, Math.round(room)));
      if (placement.up || placement.max !== max) setPlacement({ up: false, max });
      const pop = popRef.current;
      if (!pop) return;
      const popBottom = rect.bottom + 6 + Math.min(pop.scrollHeight, max);
      const overflow = popBottom - (band.bottom - 8);
      if (overflow <= 0) return;
      const parent = scrollParent(wrap);
      const parentTop = parent ? Math.max(parent.getBoundingClientRect().top, band.top) : band.top;
      const canMove = Math.max(0, rect.top - parentTop - 72);
      const by = Math.min(overflow, canMove);
      if (by > 0) (parent ?? window).scrollBy({ top: by, behavior: 'smooth' });
      return;
    }
    const below = band.bottom - rect.bottom - 12;
    const above = rect.top - band.top - 12;
    const up = below < 220 && above > below;
    const max = Math.max(140, Math.min(320, Math.round(up ? above : below)));
    if (placement.up !== up || placement.max !== max) setPlacement({ up, max });
  }, [popOpen, options.length, popNote]);

  function emit(place) {
    onChangeRef.current?.(place);
  }

  function cancelSearch() {
    clearTimeout(timerRef.current);
    abortRef.current?.abort();
    abortRef.current = null;
    pendingRef.current = '';
    requestRef.current += 1; // any answer still on its way is now out of date
  }

  function search(rawText) {
    const q = normaliseQuery(rawText);
    // Same words as the search already waiting or running (a space, a newline): let it be.
    if (q && cacheKey(q) === cacheKey(pendingRef.current)) return;
    cancelSearch();
    if (q.length < MIN_QUERY || !store?.api?.places) {
      setBusy(null);
      return;
    }
    const cached = cachedResults(q);
    if (cached) {
      setResults(cached);
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
    pendingRef.current = q;
    const request = requestRef.current;
    timerRef.current = setTimeout(async () => {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      abortRef.current = controller;
      try {
        const body = await store.api.places(q, controller ? { signal: controller.signal } : undefined);
        const found = (Array.isArray(body?.results) ? body.results : []).filter(hasCoords);
        cacheResults(q, found);
        if (!mountedRef.current || request !== requestRef.current) return;
        pendingRef.current = '';
        abortRef.current = null;
        setResults(found);
        setSearched(q);
        setBusy(null);
      } catch (error) {
        if (isAbort(error) || controller?.signal.aborted) return;
        const message = error instanceof Error && error.message ? error.message : "Address search isn't working right now — type the address.";
        searchPauses.set(store, { message, until: Date.now() + (store.mode === 'memory' ? LOCAL_RETRY_AFTER_MS : RETRY_AFTER_MS) });
        if (!mountedRef.current || request !== requestRef.current) return;
        pendingRef.current = '';
        abortRef.current = null;
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
    cancelSearch();
    close();
    const place = toPlace(option.place);
    setText(placeText(place));
    setNote(null);
    setBusy(null);
    emit(place);
  }

  // Keeps typed text as an address without coordinates; an emptied box clears the place.
  function commitText() {
    if (!edited) return false;
    cancelSearch();
    setBusy(null);
    emit(query ? { label: null, address: query, lat: null, lng: null } : null);
    return true;
  }

  function locate() {
    if (!canLocate || busy === 'locate') return;
    cancelSearch();
    close();
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
    // One line of text: a pasted line break becomes a space.
    const raw = event.currentTarget.value;
    const next = raw.replace(/[\r\n]+/g, ' ');
    if (next !== raw) event.currentTarget.value = next;
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
        // Never a line break; also keeps a surrounding form from submitting mid-pick.
        event.preventDefault();
        if (popOpen && activeIndex >= 0) {
          pick(options[activeIndex]);
        } else {
          commitText();
          close();
          if (matches('(pointer: coarse)')) event.currentTarget.blur(); // "Done" on a phone keyboard
        }
        break;
      case 'Escape':
        if (popOpen) {
          event.preventDefault(); // close the list, not an enclosing dialog
          close();
        } else if (edited) {
          event.preventDefault();
          cancelSearch();
          setBusy(null);
          setText(valueText);
        }
        break;
      default:
        break;
    }
  }

  function onFocus() {
    setFocused(true);
    // Text already typed (but not picked) shows its suggestions again; an empty box opens nothing.
    if (edited && query.length >= MIN_QUERY) setOpen(true);
  }

  function onBlur() {
    setFocused(false);
    close();
    commitText();
  }

  // The line under the box: what state the place is in, or the location link for an empty box.
  let status = null;
  if (busy === 'locate') {
    status = html`<span class="addr-state"><${Spinner} label="Finding your location" />Finding your location…</span>`;
  } else if (note) {
    status = html`<span class="addr-state is-problem" role="status"><${Icon} name="alert" size=${14} />${note}</span>`;
  } else if (!edited && located) {
    status = html`<span class="addr-state is-pinned"><${Icon} name="map-pin" size=${14} />On the map</span>`;
  } else if (!edited && valueText && needsPin) {
    // Only worth warning about when the place feeds a route lookup.
    status = html`<span class="addr-state is-loose"><${Icon} name="alert" size=${14} />Not on the map — pick a suggestion or use a postcode</span>`;
  }
  const showLocate = canLocate && !query && busy !== 'locate';
  const meta = status || showLocate
    ? html`<div class="addr-meta" id=${statusId}>
        ${status}
        ${showLocate && html`<button type="button" class="addr-locate" onMouseDown=${(event) => event.preventDefault()} onClick=${locate}>
          <svg class="icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true" focusable="false">
            <circle cx="12" cy="12" r="7" /><circle cx="12" cy="12" r="2.5" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
          </svg>
          ${locateText}
        </button>`}
      </div>`
    : null;

  const control = html`<div class="addr" ref=${wrapRef}>
    <${Textarea}
      class="addr-input"
      rows=${1}
      role="combobox"
      aria-autocomplete="list"
      aria-expanded=${popOpen ? 'true' : 'false'}
      aria-controls=${listId}
      aria-activedescendant=${popOpen && activeIndex >= 0 ? optionId(activeIndex) : undefined}
      aria-busy=${busy ? 'true' : undefined}
      aria-describedby=${meta ? statusId : undefined}
      autocomplete="off"
      autocapitalize="words"
      autocorrect="off"
      spellcheck=${false}
      enterkeyhint="done"
      placeholder=${placeholder}
      value=${text}
      onInput=${onInput}
      onKeyDown=${onKeyDown}
      onFocus=${onFocus}
      onBlur=${onBlur}
    />
    <div
      ref=${popRef}
      class=${placement.up ? 'addr-pop is-up' : 'addr-pop'}
      hidden=${!popOpen}
      style=${`--addr-list-max:${placement.max}px`}
      onMouseDown=${(event) => event.preventDefault() /* keep focus in the box while picking */}
    >
      <ul class="addr-list" id=${listId} role="listbox" aria-label="Suggestions" hidden=${options.length === 0}>
        ${options.map((place, index) => {
          const selected = index === activeIndex;
          const sub = place.address && place.address !== place.label ? place.address : null;
          return html`<li
            key=${`${place.lat},${place.lng},${index}`}
            id=${optionId(index)}
            role="option"
            aria-selected=${selected ? 'true' : 'false'}
            class="addr-option"
            onClick=${() => pick({ place })}
            onMouseMove=${() => !selected && setActive(index)}
          >
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

  if (label) {
    return html`<${Field} label=${label}><div class="addr-field">${control}${meta}</div><//>`;
  }
  return html`<div class="addr-field">${control}${meta}</div>`;
}

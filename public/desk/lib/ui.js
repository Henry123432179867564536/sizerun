// Sizemill Desk UI kit (docs/desk-spec.md §7, "lib/ui.js exports").
//
// Every view builds on these components so Desk looks and behaves the same everywhere.
// Class names match desk.css, whose header also lists the layout/utility classes views can
// use directly. Every component accepts `class` (or `className`) for extra classes.
//
// Value-style callbacks: Tabs/Segmented `onChange(id|value)`, SearchBox `onInput(text)` and
// Switch `onChange(checked)` hand back the new value. Input/Select/Textarea are thin wrappers
// over the native elements, so their handlers receive the DOM event as usual.
//
// Extras beyond the spec: Icon, Banner, Loading, ErrorState, Switch, ShellContext, useField,
// useId, cx, statusOptions, certaintyMeta, iconNames, Fields, isCoarsePointer.
// Field also takes `optional` (adds a muted "(optional)"); an error replaces the hint.
// Importing this module installs html.is-typing / html.is-keyboard tracking (see below).

import {
  html,
  render,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from './preact.js';
import { money as formatMoney, moneyShort } from './format.js';

export { html };

// Below half a penny a figure displays as £0.00, so it counts as neither gain nor loss.
const MONEY_EPS = 0.005;
const TONES = new Set(['neutral', 'signal', 'gain', 'loss', 'warn', 'muted']);

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

/** Joins truthy class names: cx('btn', active && 'is-active', ['a', 'b']). */
export function cx(...parts) {
  return parts.flat(Infinity).filter((part) => typeof part === 'string' && part !== '').join(' ');
}

let idSequence = 0;

/** A stable, document-unique id for the lifetime of the component (for label/aria wiring). */
export function useId(prefix = 'ui') {
  const ref = useRef(null);
  if (ref.current === null) {
    idSequence += 1;
    ref.current = `${prefix}-${idSequence}`;
  }
  return ref.current;
}

function hasContent(children) {
  if (Array.isArray(children)) return children.some(hasContent);
  return children !== undefined && children !== null && children !== false && children !== true && children !== '';
}

// ---------------------------------------------------------------------------------------------
// Phone keyboard and typing state (desk.css reads these)
// ---------------------------------------------------------------------------------------------
//
// html.is-typing   a text control has focus: the bottom tab bar steps aside and --tabbar-h
//                  becomes 0, so sticky bars and toasts drop to the bottom edge.
// html.is-keyboard the on-screen keyboard is covering part of the layout viewport (iOS keeps
//                  100dvh and position:fixed at full height): --vvh / --vvt describe the visible
//                  area and --kb the covered part, so sheets sit above the keyboard.

const NON_TEXT_INPUTS = new Set(['button', 'checkbox', 'radio', 'range', 'color', 'file', 'submit', 'reset', 'image', 'hidden']);

function isTextControl(node) {
  if (!(node instanceof Element)) return false;
  if (node instanceof HTMLTextAreaElement) return !node.readOnly && !node.disabled;
  if (node instanceof HTMLSelectElement) return false;
  if (node instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(node.type) && !node.readOnly && !node.disabled;
  return node.isContentEditable === true;
}

/** True on touch-first devices, where a programmatic focus should not raise a keyboard. */
export function isCoarsePointer() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(pointer: coarse)').matches;
}

function installViewportTracking() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__deskViewportTracking) return;
  window.__deskViewportTracking = true;
  const root = document.documentElement;
  let blurTimer = 0;

  const onFocusIn = (event) => {
    window.clearTimeout(blurTimer);
    root.classList.toggle('is-typing', isTextControl(event.target));
  };
  const onFocusOut = () => {
    // Moving focus between two fields fires focusout then focusin; don't flash the tab bar.
    window.clearTimeout(blurTimer);
    blurTimer = window.setTimeout(() => {
      if (!isTextControl(document.activeElement)) root.classList.remove('is-typing');
    }, 120);
  };
  document.addEventListener('focusin', onFocusIn);
  document.addEventListener('focusout', onFocusOut);

  const vv = window.visualViewport;
  if (!vv) return;
  let frame = 0;
  const update = () => {
    frame = 0;
    const covered = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    // Ignore pinch-zoom and small browser-chrome changes; only a keyboard covers this much.
    const keyboard = covered > 120 && vv.scale <= 1.01;
    root.classList.toggle('is-keyboard', keyboard);
    if (keyboard) {
      root.style.setProperty('--vvh', `${Math.round(vv.height)}px`);
      root.style.setProperty('--vvt', `${Math.round(vv.offsetTop)}px`);
      root.style.setProperty('--kb', `${covered}px`);
      // Keep the field being typed in visible inside a sheet that just got shorter.
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.closest('.modal-body')) {
        active.scrollIntoView({ block: 'nearest' });
      }
    } else {
      root.style.removeProperty('--vvh');
      root.style.removeProperty('--vvt');
      root.style.removeProperty('--kb');
    }
  };
  const schedule = () => {
    if (!frame) frame = window.requestAnimationFrame(update);
  };
  vv.addEventListener('resize', schedule);
  vv.addEventListener('scroll', schedule);
}

installViewportTracking();

function toError(reason) {
  if (reason instanceof Error) return reason;
  return new Error(typeof reason === 'string' && reason ? reason : 'Something went wrong — please try again.');
}

function errorMessage(error) {
  if (!error) return 'Something went wrong — please try again.';
  return error instanceof Error ? error.message || 'Something went wrong — please try again.' : String(error);
}

function sameValue(a, b) {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return String(a) === String(b);
}

function normaliseOption(option) {
  if (option !== null && typeof option === 'object') {
    return {
      value: option.value,
      label: option.label ?? String(option.value ?? ''),
      disabled: Boolean(option.disabled),
      icon: option.icon,
    };
  }
  return { value: option, label: String(option ?? ''), disabled: false };
}

// ---------------------------------------------------------------------------------------------
// Icons (24×24 stroke icons drawn with currentColor)
// ---------------------------------------------------------------------------------------------

const CIRCLE = (cx_, cy, r) => `M${cx_ + r} ${cy}a${r} ${r} 0 1 1-${2 * r} 0 ${r} ${r} 0 0 1 ${2 * r} 0z`;

const ICON_PATHS = {
  home: ['M3 10.5 12 3l9 7.5', 'M5 9v12h14V9', 'M10 21v-6h4v6'],
  tag: ['M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z', 'M7.5 7.5h.01'],
  users: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', CIRCLE(9, 7, 4), 'M22 21v-2a4 4 0 0 0-3-3.87', 'M16 3.13a4 4 0 0 1 0 7.75'],
  user: [CIRCLE(12, 8, 4), 'M4 21a8 8 0 0 1 16 0'],
  calculator: [
    'M6 2h12a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z',
    'M8 6h8v4H8z', 'M8 14h.01', 'M12 14h.01', 'M16 14h.01', 'M8 18h.01', 'M12 18h.01', 'M16 18h.01',
  ],
  more: [CIRCLE(5, 12, 1.25), CIRCLE(12, 12, 1.25), CIRCLE(19, 12, 1.25)],
  box: ['M21 8l-9-5-9 5v8l9 5 9-5V8z', 'M3 8l9 5 9-5', 'M12 13v8'],
  car: [
    'M5 11l1.6-4.6A2 2 0 0 1 8.5 5h7a2 2 0 0 1 1.9 1.4L19 11',
    'M3 13a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4H3v-4z',
    'M5.5 17v2.5', 'M18.5 17v2.5', 'M7 14h.01', 'M17 14h.01',
  ],
  sliders: ['M4 6h9', 'M17 6h3', 'M4 12h3', 'M11 12h9', 'M4 18h11', 'M19 18h1', CIRCLE(15, 6, 2), CIRCLE(9, 12, 2), CIRCLE(17, 18, 2)],
  plus: ['M12 5v14', 'M5 12h14'],
  'chevron-left': ['M15 18l-6-6 6-6'],
  'chevron-right': ['M9 18l6-6-6-6'],
  'chevron-down': ['M6 9l6 6 6-6'],
  x: ['M18 6 6 18', 'M6 6l12 12'],
  search: [CIRCLE(11, 11, 7), 'M20.5 20.5 16 16'],
  alert: ['M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z', 'M12 9v4', 'M12 17h.01'],
  info: [CIRCLE(12, 12, 9), 'M12 16v-4.5', 'M12 8h.01'],
  'check-circle': [CIRCLE(12, 12, 9), 'M8 12.5l2.7 2.7L16 9.8'],
  check: ['M5 12.5l4.5 4.5L19 7'],
  'log-out': ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'M16 17l5-5-5-5', 'M21 12H9'],
  'map-pin': ['M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z', CIRCLE(12, 9.5, 2.5)],
  refresh: ['M21 12a9 9 0 1 1-2.6-6.4', 'M21 4v5h-5'],
  device: ['M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z', 'M11 18h2'],
  mail: ['M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z', 'M3.5 6.5 12 13l8.5-6.5'],
  trash: ['M4 7h16', 'M10 11v6', 'M14 11v6', 'M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13', 'M9 7V4h6v3'],
  edit: ['M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4z', 'M13.5 6.5l4 4'],
  download: ['M12 4v11', 'M7 10l5 5 5-5', 'M5 20h14'],
  external: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
  inbox: ['M3 13h5l1.5 3h5L16 13h5', 'M5.5 5h13L21 13v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5z'],
  calendar: ['M5 5h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z', 'M4 10h16', 'M8 3v4', 'M16 3v4'],
  eye: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z', CIRCLE(12, 12, 3)],
  'eye-off': [
    'M3 3l18 18', 'M10.6 5.1A10.8 10.8 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-3 3.9',
    'M6.6 6.6C3.9 8.4 2 12 2 12s3.5 7 10 7a9.8 9.8 0 0 0 5.4-1.6', 'M9.9 9.9a3 3 0 0 0 4.2 4.2',
  ],
  offline: [
    'M3 3l18 18', 'M8.5 16.4a5 5 0 0 1 7 0', 'M5 12.9a10 10 0 0 1 4.2-2.6', 'M15.2 10.4A10 10 0 0 1 19 12.9',
    'M2 9.3a15 15 0 0 1 4.4-2.8', 'M11 5.1A15 15 0 0 1 22 9.3', 'M12 20h.01',
  ],
  'trending-up': ['M3 17l6-6 4 4 8-8', 'M15 7h6v6'],
};

export const iconNames = Object.freeze(Object.keys(ICON_PATHS));

/** Icon({ name, size = 18, label }) — decorative unless `label` is given. */
export function Icon({ name, size = 18, label, class: classAttr, className }) {
  const paths = ICON_PATHS[name];
  if (!paths) return null;
  return html`<svg
    class=${cx('icon', classAttr, className)}
    width=${size}
    height=${size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.75"
    stroke-linecap="round"
    stroke-linejoin="round"
    focusable="false"
    role=${label ? 'img' : undefined}
    aria-label=${label || undefined}
    aria-hidden=${label ? undefined : 'true'}
  >${paths.map((d) => html`<path d=${d} />`)}</svg>`;
}

function renderIcon(icon, size) {
  return typeof icon === 'string' ? html`<${Icon} name=${icon} size=${size} />` : icon;
}

// ---------------------------------------------------------------------------------------------
// Shell integration
// ---------------------------------------------------------------------------------------------

/**
 * Provided by app.js around every view:
 * { setHeader({ title, back, actionHrefs } | null), labelFor(href), navigate(to, { replace }) }.
 * Page uses it to put its title and back link in the phone top bar and the document title.
 */
export const ShellContext = createContext(null);

// Hrefs of link actions (a Button with href) a Page shows, so the top bar can skip its own
// copy of the same action. Looks a few levels into wrappers such as a .row div.
function linkHrefs(node, depth = 0, found = []) {
  if (depth > 3 || node === null || node === undefined || typeof node !== 'object') return found;
  if (Array.isArray(node)) {
    for (const child of node) linkHrefs(child, depth, found);
  } else if (node.props) {
    if (typeof node.props.href === 'string') found.push(node.props.href);
    else linkHrefs(node.props.children, depth + 1, found);
  }
  return found;
}

function resolveBack(back, shell) {
  if (!back) return null;
  const href = typeof back === 'string' ? back : back.href;
  if (typeof href !== 'string' || href === '') return null;
  const label = (typeof back === 'object' && back.label) || shell?.labelFor?.(href) || 'Back';
  return { href, label };
}

/**
 * Page({ title, subtitle, actions, back, children })
 * back: an href ('#/sales') or { href, label }. On phones a plain-text title and the back link
 * move into the top bar; a rich (non-string) title stays in the page.
 */
export function Page({ title, subtitle, actions, back, children, class: classAttr, className }) {
  const shell = useContext(ShellContext);
  const backLink = resolveBack(back, shell);
  const titleText = typeof title === 'string' || typeof title === 'number' ? String(title) : null;
  const synced = Boolean(shell) && titleText !== null;
  const bare = !hasContent(subtitle) && !hasContent(actions);
  const actionHrefs = linkHrefs(actions).join(' ');

  useEffect(() => {
    if (!shell) return undefined;
    shell.setHeader({ title: titleText, back: backLink, actionHrefs });
    return () => shell.setHeader(null);
  }, [shell, titleText, backLink?.href, backLink?.label, actionHrefs]);

  return html`<div class=${cx('page', classAttr, className)}>
    <header class=${cx('page-head', synced && 'is-synced', synced && bare && 'is-bare')}>
      ${backLink && html`<a class="page-back" href=${backLink.href}>
        <${Icon} name="chevron-left" size=${16} />${backLink.label}
      </a>`}
      <div class="page-head-row">
        <div class="page-titles">
          <h1 class="page-title">${title}</h1>
          ${hasContent(subtitle) && html`<p class="page-sub">${subtitle}</p>`}
        </div>
        ${hasContent(actions) && html`<div class="page-actions">${actions}</div>`}
      </div>
    </header>
    <div class="page-body">${children}</div>
  </div>`;
}

// ---------------------------------------------------------------------------------------------
// Surfaces and figures
// ---------------------------------------------------------------------------------------------

/** Card({ title, subtitle, actions, children, pad = true }) — pad=false for tables and lists. */
export function Card({ title, subtitle, actions, children, pad = true, id, class: classAttr, className }) {
  const hasHead = hasContent(title) || hasContent(subtitle) || hasContent(actions);
  return html`<section id=${id} class=${cx('card', !pad && 'card-flush', classAttr, className)}>
    ${hasHead && html`<header class="card-head">
      <div class="card-titles">
        ${hasContent(title) && html`<h2 class="card-title">${title}</h2>`}
        ${hasContent(subtitle) && html`<p class="card-sub">${subtitle}</p>`}
      </div>
      ${hasContent(actions) && html`<div class="card-actions">${actions}</div>`}
    </header>`}
    <div class="card-body">${children}</div>
  </section>`;
}

/** Stat({ label, value, sub, tone, href, onClick }) — tone: 'gain'|'loss'|'warn'|'signal'. */
export function Stat({ label, value, sub, tone, href, onClick, class: classAttr, className }) {
  const classes = cx('stat', tone && `stat-${tone}`, (href || onClick) && 'stat-link', classAttr, className);
  const body = html`
    <span class="stat-label">${label}</span>
    <span class="stat-value">${hasContent(value) ? value : '—'}</span>
    ${hasContent(sub) && html`<span class="stat-sub">${sub}</span>`}`;
  if (href) return html`<a class=${classes} href=${href} onClick=${onClick}>${body}</a>`;
  if (onClick) return html`<button type="button" class=${classes} onClick=${onClick}>${body}</button>`;
  return html`<div class=${classes}>${body}</div>`;
}

/** Badge({ tone, children }) — tone: 'neutral'|'signal'|'gain'|'loss'|'warn'|'muted'. */
export function Badge({ tone = 'neutral', children, dot = true, title, class: classAttr, className }) {
  const safeTone = TONES.has(tone) ? tone : 'neutral';
  return html`<span class=${cx('badge', `badge-${safeTone}`, dot && 'badge-dot', classAttr, className)} title=${title}>${children}</span>`;
}

/**
 * Money({ value, sign, tone, pence = true, short = false })
 * tone 'auto' colours by sign (gain above zero, loss below); any other tone is applied as is.
 */
export function Money({ value, sign = false, tone, pence = true, short = false, class: classAttr, className }) {
  let resolvedTone = tone;
  if (tone === 'auto') {
    const n = typeof value === 'number' ? value : Number(value);
    const known = value !== null && value !== undefined && value !== '' && Number.isFinite(n);
    resolvedTone = !known ? undefined : n >= MONEY_EPS ? 'gain' : n <= -MONEY_EPS ? 'loss' : undefined;
  }
  const text = short ? moneyShort(value) : formatMoney(value, { sign, pence });
  return html`<span class=${cx('money', 'num', resolvedTone && `tone-${resolvedTone}`, classAttr, className)}>${text}</span>`;
}

/** Empty({ title, body, action, icon = 'inbox' }) */
export function Empty({ title, body, action, icon = 'inbox', class: classAttr, className }) {
  return html`<div class=${cx('empty', classAttr, className)}>
    ${icon && html`<span class="empty-icon">${renderIcon(icon, 22)}</span>`}
    ${hasContent(title) && html`<p class="empty-title">${title}</p>`}
    ${hasContent(body) && html`<p class="empty-body">${body}</p>`}
    ${hasContent(action) && html`<div class="empty-action">${action}</div>`}
  </div>`;
}

/** Banner({ tone = 'signal', title, children, actions, icon, onDismiss }) — icon={false} hides it. */
export function Banner({ tone = 'signal', title, children, actions, icon, onDismiss, class: classAttr, className }) {
  const iconName = icon === undefined ? BANNER_ICONS[tone] ?? 'info' : icon;
  return html`<div class=${cx('banner', `banner-${tone}`, classAttr, className)} role=${tone === 'loss' ? 'alert' : undefined}>
    ${iconName && html`<span class="banner-icon">${renderIcon(iconName, 20)}</span>`}
    <div class="banner-body">
      ${hasContent(title) && html`<strong class="banner-title">${title}</strong>`}
      ${hasContent(children) && html`<div class="banner-text">${children}</div>`}
      ${hasContent(actions) && html`<div class="banner-actions">${actions}</div>`}
    </div>
    ${onDismiss && html`<button type="button" class="btn btn-ghost btn-sm btn-icon banner-close" aria-label="Dismiss" onClick=${() => onDismiss()}>
      <${Icon} name="x" size=${16} />
    </button>`}
  </div>`;
}

const BANNER_ICONS = { signal: 'info', gain: 'check-circle', warn: 'alert', loss: 'alert', neutral: 'info' };

/** Spinner({ size, label = 'Loading' }) — size 'lg' for page-level waits. */
export function Spinner({ size, label = 'Loading' } = {}) {
  return html`<span class=${cx('spinner', size && `spinner-${size}`)} role="status" aria-label=${label}></span>`;
}

/** Loading({ label, delay = 150 }) — a centred spinner that only appears if the wait is noticeable. */
export function Loading({ label = 'Loading…', delay = 150, class: classAttr, className }) {
  const [visible, setVisible] = useState(!(delay > 0));
  useEffect(() => {
    if (!(delay > 0)) return undefined;
    const timer = setTimeout(() => setVisible(true), delay);
    return () => clearTimeout(timer);
  }, [delay]);
  return html`<div class=${cx('loading', classAttr, className)} role="status">
    ${visible && html`<span class="spinner" aria-hidden="true"></span><span>${label}</span>`}
  </div>`;
}

/** ErrorState({ error, title, onRetry, actions }) — shows an Error's human message in place of content. */
export function ErrorState({ error, title = "Couldn't load this", onRetry, retryLabel = 'Try again', actions, class: classAttr, className }) {
  return html`<div class=${cx('error-state', classAttr, className)} role="alert">
    <span class="error-state-icon"><${Icon} name="alert" size=${22} /></span>
    <h2 class="error-state-title">${title}</h2>
    <p class="error-state-message">${errorMessage(error)}</p>
    ${(onRetry || hasContent(actions)) && html`<div class="row">
      ${onRetry && html`<${Button} icon="refresh" onClick=${() => onRetry()}>${retryLabel}<//>`}
      ${actions}
    </div>`}
  </div>`;
}

// ---------------------------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------------------------

// What a disabled or busy button does with a click: nothing, not even bubbling to a clickable row.
function swallowClick(event) {
  event.preventDefault();
  event.stopPropagation();
}

/**
 * Button({ kind = 'secondary', size, onClick, href, disabled, type = 'button', children,
 *          icon, iconAfter, loading, block })
 * kind: 'primary'|'secondary'|'danger'|'ghost'; size: 'sm'|'lg'. With `href` it renders a link.
 * An icon-only button needs an aria-label. Other props (aria-*, form, title…) pass through.
 */
export function Button(props) {
  const {
    kind = 'secondary', size, onClick, href, disabled = false, type, children, icon, iconAfter,
    loading = false, block = false, class: classAttr, className, ...rest
  } = props;
  const inactive = Boolean(disabled || loading);
  const labelled = hasContent(children);
  const iconSize = size === 'sm' ? 16 : 18;
  const classes = cx(
    'btn', `btn-${kind}`, size && `btn-${size}`, block && 'btn-block', !labelled && 'btn-icon',
    loading && 'is-loading', classAttr, className,
  );
  const content = html`${loading ? html`<span class="spinner" aria-hidden="true"></span>` : icon && renderIcon(icon, iconSize)}${
    labelled && html`<span class="btn-label">${children}</span>`}${iconAfter && renderIcon(iconAfter, iconSize)}`;

  if (href !== undefined && href !== null) {
    return html`<a
      ...${rest}
      class=${classes}
      href=${inactive ? undefined : href}
      role=${inactive ? 'link' : undefined}
      aria-disabled=${inactive ? 'true' : undefined}
      onClick=${inactive ? swallowClick : onClick}
    >${content}</a>`;
  }
  // A loading button stays focusable (aria-disabled, clicks swallowed) so keyboard focus doesn't
  // drop to <body> mid-save; swallowing the click also stops a submit button re-submitting its form.
  const busy = Boolean(loading) && !disabled;
  return html`<button
    ...${rest}
    type=${type ?? 'button'}
    class=${classes}
    disabled=${Boolean(disabled)}
    aria-disabled=${busy ? 'true' : undefined}
    aria-busy=${loading ? 'true' : undefined}
    onClick=${busy ? swallowClick : onClick}
  >${content}</button>`;
}

// ---------------------------------------------------------------------------------------------
// Form controls
// ---------------------------------------------------------------------------------------------

const FieldContext = createContext(null);

/** The surrounding Field's wiring ({ controlId, describedBy, invalid }) for custom controls. */
export function useField() {
  return useContext(FieldContext);
}

/**
 * Field({ label, hint, error, required, id, children })
 * Links its label, hint and error to the first Input/Select/Textarea inside it.
 * `error` may be a message or `true` (mark invalid without text).
 */
export function Field({ label, hint, error, required = false, optional = false, id, children, class: classAttr, className }) {
  const autoId = useId('field');
  const ownerRef = useRef(null);
  const controlId = id ?? autoId;
  const showError = hasContent(error) && error !== true;
  // The error takes the hint's place, so a field never grows two message lines at once.
  const hintId = hasContent(hint) && !showError ? `${controlId}-hint` : undefined;
  const errorId = showError ? `${controlId}-error` : undefined;
  const context = {
    controlId,
    describedBy: cx(errorId, hintId) || undefined,
    invalid: Boolean(error),
    ownerRef,
  };
  return html`<div class=${cx('field', error && 'has-error', classAttr, className)}>
    ${hasContent(label) && html`<label class="field-label" for=${controlId}>
      ${label}${required && html`<span class="field-req" aria-hidden="true"> *</span>`}${!required && optional && html`<span class="field-optional"> (optional)</span>`}
    </label>`}
    <${FieldContext.Provider} value=${context}>${children}<//>
    ${showError && html`<p class="field-error" id=${errorId}>${error}</p>`}
    ${hintId && html`<p class="field-hint" id=${hintId}>${hint}</p>`}
  </div>`;
}

// The first control rendered inside a Field takes its id and descriptions; later ones (a
// second input in the same field) keep their own.
function useFieldControl(props) {
  const field = useContext(FieldContext);
  const tokenRef = useRef(null);
  if (tokenRef.current === null) tokenRef.current = {};
  const token = tokenRef.current;
  const owner = field?.ownerRef;
  const owns = Boolean(owner) && (owner.current === null || owner.current === token);
  if (owns) owner.current = token;

  useEffect(() => () => {
    if (owner && owner.current === token) owner.current = null;
  }, [owner, token]);

  if (!owns) return {};
  return {
    id: props.id ?? field.controlId,
    'aria-describedby': cx(props['aria-describedby'], field.describedBy) || undefined,
    'aria-invalid': props['aria-invalid'] ?? (field.invalid ? 'true' : undefined),
  };
}

/**
 * Input(props) — a native <input>; `prefix`/`suffix` add adornments ('£', 'mpg', a button).
 * Number inputs default to step="any" (so pence validate) and a decimal keypad on phones.
 */
export function Input(props) {
  const { prefix, suffix, class: classAttr, className, ...rest } = props;
  const control = useFieldControl(rest);
  const numeric = rest.type === 'number';
  const dateLike = rest.type === 'date' || rest.type === 'time' || rest.type === 'datetime-local' || rest.type === 'month';
  const empty = dateLike && 'value' in rest && (rest.value === '' || rest.value === null || rest.value === undefined);
  const input = html`<input
    ...${rest}
    ...${control}
    class=${cx('input', empty && 'is-empty', classAttr, className)}
    step=${rest.step ?? (numeric ? 'any' : undefined)}
    inputmode=${rest.inputmode ?? rest.inputMode ?? (numeric ? 'decimal' : undefined)}
  />`;
  if (!hasContent(prefix) && !hasContent(suffix)) return input;
  return html`<div class=${cx('input-group', rest.disabled && 'is-disabled')}>
    ${hasContent(prefix) && html`<span class="input-affix">${prefix}</span>`}
    ${input}
    ${hasContent(suffix) && html`<span class="input-affix">${suffix}</span>`}
  </div>`;
}

/**
 * Select({ options: [{ value, label, disabled }] | ['A', 'B'], placeholder, ...props })
 * An option with `options` of its own renders as an <optgroup label>.
 */
export function Select(props) {
  const { options = [], placeholder, class: classAttr, className, ...rest } = props;
  const control = useFieldControl(rest);
  const renderOption = (option) => {
    if (option && typeof option === 'object' && Array.isArray(option.options)) {
      return html`<optgroup label=${option.label}>${option.options.map(renderOption)}</optgroup>`;
    }
    const { value, label, disabled } = normaliseOption(option);
    return html`<option value=${value ?? ''} disabled=${disabled}>${label}</option>`;
  };
  return html`<div class=${cx('select-wrap', classAttr, className)}>
    <select ...${rest} ...${control} class="select">
      ${placeholder !== undefined && html`<option value="" disabled=${Boolean(rest.required)}>${placeholder}</option>`}
      ${options.map(renderOption)}
    </select>
  </div>`;
}

/** Textarea(props) — a native <textarea>, 3 rows unless `rows` says otherwise. */
export function Textarea(props) {
  const { class: classAttr, className, rows = 3, ...rest } = props;
  const control = useFieldControl(rest);
  return html`<textarea ...${rest} ...${control} rows=${rows} class=${cx('textarea', classAttr, className)}></textarea>`;
}

/**
 * Fields({ cols, children }) — a grid of Fields: one column on phones, two from 520px
 * (cols=3: three from 900px). Wrap a child in <div class="span-all"> for a full row, or two
 * short fields in <div class="field-pair"> to keep them side by side on a phone.
 */
export function Fields({ cols, children, class: classAttr, className }) {
  return html`<div class=${cx('fields', cols === 3 && 'cols-3', classAttr, className)}>${children}</div>`;
}

/** Switch({ checked, onChange(checked), label, hint, disabled }) — an on/off toggle. */
export function Switch({ checked, onChange, label, hint, disabled = false, id, name, class: classAttr, className }) {
  const autoId = useId('switch');
  const inputId = id ?? autoId;
  const hintId = hasContent(hint) ? `${inputId}-hint` : undefined;
  return html`<label class=${cx('switch', disabled && 'is-disabled', classAttr, className)} for=${inputId}>
    <input
      id=${inputId}
      name=${name}
      type="checkbox"
      role="switch"
      class="switch-input"
      checked=${Boolean(checked)}
      disabled=${disabled}
      aria-describedby=${hintId}
      onChange=${(event) => onChange?.(event.currentTarget.checked)}
    />
    ${(hasContent(label) || hintId) && html`<span class="switch-text">
      ${hasContent(label) && html`<span class="switch-label">${label}</span>`}
      ${hintId && html`<span class="switch-hint" id=${hintId}>${hint}</span>`}
    </span>`}
  </label>`;
}

/** SearchBox({ value, onInput(text), placeholder = 'Search', label }) — Escape or × clears. */
export function SearchBox({ value, onInput, placeholder = 'Search', label, autofocus, class: classAttr, className }) {
  const inputRef = useRef(null);
  const text = value ?? '';
  const clear = () => {
    onInput?.('');
    inputRef.current?.focus();
  };
  const onKeyDown = (event) => {
    if (event.key === 'Escape' && text !== '') {
      event.preventDefault(); // also keeps an enclosing Modal open
      clear();
    }
  };
  return html`<div class=${cx('search', classAttr, className)} role="search">
    <${Icon} name="search" size=${18} class="search-icon" />
    <input
      ref=${inputRef}
      type="search"
      class="input search-input"
      value=${text}
      placeholder=${placeholder}
      aria-label=${label ?? placeholder}
      autocomplete="off"
      autocorrect="off"
      spellcheck=${false}
      enterkeyhint="search"
      autofocus=${autofocus}
      onInput=${(event) => onInput?.(event.currentTarget.value)}
      onKeyDown=${onKeyDown}
    />
    ${text !== '' && html`<button type="button" class="search-clear" aria-label="Clear search" onClick=${clear}>
      <${Icon} name="x" size=${16} />
    </button>`}
  </div>`;
}

// ---------------------------------------------------------------------------------------------
// Tabs and segmented control (arrow keys move between options, as native radios do)
// ---------------------------------------------------------------------------------------------

function nextIndex(key, current, count) {
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (key === 'ArrowRight' || key === 'ArrowDown') return (current + 1) % count;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (current - 1 + count) % count;
  return -1;
}

// Scrolls a horizontally scrolling strip just enough to show its selected child.
function revealChild(list, index) {
  const child = list?.children[index];
  if (!child) return;
  const start = child.offsetLeft;
  const end = start + child.offsetWidth;
  if (start < list.scrollLeft) list.scrollLeft = Math.max(0, start - 16);
  else if (end > list.scrollLeft + list.clientWidth) list.scrollLeft = end - list.clientWidth + 16;
}

/** Tabs({ tabs: [{ id, label, count }], value, onChange(id), label }) */
export function Tabs({ tabs = [], value, onChange, label, class: classAttr, className }) {
  const listRef = useRef(null);
  const baseId = useId('tabs');
  const selected = tabs.findIndex((tab) => sameValue(tab.id, value));
  const focusIndex = selected === -1 ? 0 : selected;

  useLayoutEffect(() => revealChild(listRef.current, focusIndex), [focusIndex, tabs.length]);

  const onKeyDown = (event) => {
    const index = nextIndex(event.key, focusIndex, tabs.length);
    if (index === -1 || event.key === 'ArrowUp' || event.key === 'ArrowDown') return;
    event.preventDefault();
    onChange?.(tabs[index].id);
    listRef.current?.children[index]?.focus();
  };

  return html`<div ref=${listRef} class=${cx('tabs', classAttr, className)} role="tablist" aria-label=${label} onKeyDown=${onKeyDown}>
    ${tabs.map((tab, index) => html`<button
      key=${tab.id}
      type="button"
      role="tab"
      id=${`${baseId}-${index}`}
      class="tab"
      aria-selected=${index === selected ? 'true' : 'false'}
      tabindex=${index === focusIndex ? 0 : -1}
      onClick=${() => onChange?.(tab.id)}
    >
      <span>${tab.label}</span>
      ${tab.count !== undefined && tab.count !== null && html`<span class="tab-count">${tab.count}</span>`}
    </button>`)}
  </div>`;
}

/** Segmented({ options: [{ value, label, icon }] | ['A', 'B'], value, onChange(value), label, size, full }) */
export function Segmented({ options = [], value, onChange, label, size, full = false, disabled = false, class: classAttr, className }) {
  const groupRef = useRef(null);
  const items = options.map(normaliseOption);
  const selected = items.findIndex((item) => sameValue(item.value, value));
  const focusIndex = selected === -1 ? 0 : selected;

  useLayoutEffect(() => revealChild(groupRef.current, focusIndex), [focusIndex, items.length]);

  const onKeyDown = (event) => {
    if (disabled) return;
    const index = nextIndex(event.key, focusIndex, items.length);
    if (index === -1) return;
    event.preventDefault();
    onChange?.(items[index].value);
    groupRef.current?.children[index]?.focus();
  };

  return html`<div
    ref=${groupRef}
    class=${cx('segmented', size && `segmented-${size}`, full && 'is-full', classAttr, className)}
    role="radiogroup"
    aria-label=${label}
    aria-disabled=${disabled ? 'true' : undefined}
    onKeyDown=${onKeyDown}
  >
    ${items.map((item, index) => html`<button
      key=${String(item.value)}
      type="button"
      role="radio"
      class="segmented-option"
      aria-checked=${index === selected ? 'true' : 'false'}
      tabindex=${index === focusIndex ? 0 : -1}
      disabled=${disabled || item.disabled}
      onClick=${() => onChange?.(item.value)}
    >${item.icon && renderIcon(item.icon, 16)}<span>${item.label}</span></button>`)}
  </div>`;
}

// ---------------------------------------------------------------------------------------------
// Overlays: focus trap, Escape and scroll lock shared by every open Modal
// ---------------------------------------------------------------------------------------------

const FOCUSABLE = [
  'a[href]', 'area[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])', 'textarea:not([disabled])', 'iframe', 'summary',
  '[contenteditable="true"]', '[tabindex]:not([tabindex="-1"])',
].join(',');

const overlayStack = [];
let overlayListenersInstalled = false;
let scrollLocks = 0;

function topOverlay() {
  return overlayStack[overlayStack.length - 1] ?? null;
}

function focusableIn(node) {
  return Array.from(node.querySelectorAll(FOCUSABLE)).filter(
    (element) => !element.closest('[inert]') && element.getClientRects().length > 0,
  );
}

function onOverlayKeyDown(event) {
  const top = topOverlay();
  if (!top) return;
  if (event.key === 'Escape') {
    // A control inside the dialog that handled Escape itself (a suggestion list, a search box)
    // calls preventDefault, and the dialog stays open.
    if (event.defaultPrevented || event.isComposing) return;
    event.preventDefault();
    top.requestClose();
    return;
  }
  if (event.key !== 'Tab') return;
  const items = focusableIn(top.node);
  if (items.length === 0) {
    event.preventDefault();
    top.node.focus();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  const inside = top.node.contains(active) && active !== top.node;
  if (event.shiftKey && (!inside || active === first)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (!inside || active === last)) {
    event.preventDefault();
    first.focus();
  }
}

// Focus that lands outside the top dialog (a screen-reader jump, a stray click) is pulled back.
function onOverlayFocusIn(event) {
  const top = topOverlay();
  if (!top || top.node.contains(event.target)) return;
  if (event.target instanceof Element && event.target.closest('.toast-layer')) return;
  top.node.focus({ preventScroll: true });
}

function installOverlayListeners() {
  if (overlayListenersInstalled) return;
  overlayListenersInstalled = true;
  document.addEventListener('keydown', onOverlayKeyDown);
  document.addEventListener('focusin', onOverlayFocusIn);
}

function lockScroll() {
  scrollLocks += 1;
  if (scrollLocks === 1) document.documentElement.classList.add('is-scroll-locked');
}

function unlockScroll() {
  scrollLocks = Math.max(0, scrollLocks - 1);
  if (scrollLocks === 0) document.documentElement.classList.remove('is-scroll-locked');
}

function useOverlay(nodeRef, requestClose) {
  const closeRef = useRef(requestClose);
  closeRef.current = requestClose;

  useLayoutEffect(() => {
    const node = nodeRef.current;
    if (!node) return undefined;
    installOverlayListeners();
    const returnFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const entry = { node, requestClose: () => closeRef.current?.() };
    overlayStack.push(entry);
    lockScroll();
    // Focus the dialog itself unless a control asks for it: no keyboard pops up on phones,
    // and screen readers announce the dialog's title first.
    // On a touch screen a programmatic focus into a text field raises no keyboard on iOS but
    // still scrolls and shows a ring, so the dialog itself takes focus there instead.
    const wanted = node.querySelector('[autofocus]');
    (wanted && !(isCoarsePointer() && isTextControl(wanted)) ? wanted : node).focus({ preventScroll: true });

    return () => {
      const index = overlayStack.indexOf(entry);
      if (index !== -1) overlayStack.splice(index, 1);
      unlockScroll();
      const active = document.activeElement;
      const focusWasInside = !active || active === document.body || node.contains(active);
      if (focusWasInside && returnFocusTo?.isConnected) returnFocusTo.focus({ preventScroll: true });
    };
  }, []);
}

/**
 * Modal({ title, onClose, children, footer, size = 'md', dismissible = true })
 * Render it while open, remove it to close. Escape, the × and a backdrop tap call onClose()
 * (unless dismissible is false). Focus is trapped inside and restored afterwards; it starts on
 * the dialog itself, or on a control given `autofocus`. Phones get a bottom sheet;
 * size: 'sm'|'md'|'lg' sets the desktop width.
 */
export function Modal({ title, onClose, children, footer, size = 'md', dismissible = true, class: classAttr, className }) {
  const dialogRef = useRef(null);
  const titleId = useId('modal-title');
  const close = dismissible && typeof onClose === 'function' ? () => onClose() : null;
  useOverlay(dialogRef, close);

  return html`<div class="modal-root">
    <div class="modal-backdrop" aria-hidden="true" onClick=${close ?? undefined}></div>
    <div
      ref=${dialogRef}
      class=${cx('modal', `modal-${size}`, classAttr, className)}
      role="dialog"
      aria-modal="true"
      aria-labelledby=${hasContent(title) ? titleId : undefined}
      aria-label=${hasContent(title) ? undefined : 'Dialog'}
      tabindex="-1"
    >
      ${(hasContent(title) || close) && html`<header class="modal-head">
        <h2 class="modal-title" id=${titleId}>${title}</h2>
        ${close && html`<button type="button" class="btn btn-ghost btn-icon modal-close" aria-label="Close" onClick=${close}>
          <${Icon} name="x" size=${20} />
        </button>`}
      </header>`}
      <div class="modal-body">${children}</div>
      ${hasContent(footer) && html`<footer class="modal-foot">${footer}</footer>`}
    </div>
  </div>`;
}

function ConfirmModal({ title, body, confirmLabel, cancelLabel, danger, onResult }) {
  const footer = html`
    <${Button} kind="secondary" autofocus=${danger} onClick=${() => onResult(false)}>${cancelLabel}<//>
    <${Button} kind=${danger ? 'danger' : 'primary'} autofocus=${!danger} onClick=${() => onResult(true)}>${confirmLabel}<//>`;
  return html`<${Modal} title=${title} size="sm" onClose=${() => onResult(false)} footer=${footer}>
    ${typeof body === 'string' ? html`<p class="confirm-body">${body}</p>` : body}
  <//>`;
}

/**
 * confirmDialog({ title, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger })
 * → Promise<boolean>: true only when the confirm button is pressed. Danger dialogs start on
 * Cancel so a stray Enter can't delete anything.
 */
export function confirmDialog({
  title = 'Are you sure?',
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
} = {}) {
  if (typeof document === 'undefined') return Promise.resolve(false);
  return new Promise((resolve) => {
    const host = document.createElement('div');
    host.className = 'dialog-host';
    document.body.appendChild(host);
    let settled = false;
    const onResult = (result) => {
      if (settled) return;
      settled = true;
      render(null, host);
      host.remove();
      resolve(result);
    };
    render(html`<${ConfirmModal}
      title=${title}
      body=${body}
      confirmLabel=${confirmLabel}
      cancelLabel=${cancelLabel}
      danger=${danger}
      onResult=${onResult}
    />`, host);
  });
}

// ---------------------------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------------------------

const TOAST_LIMIT = 4;
const TOAST_MS = 4500;
const TOAST_ERROR_MS = 8000;
const TOAST_ICONS = { gain: 'check-circle', loss: 'alert', warn: 'alert', signal: 'info' };

const toastListeners = new Set();
let toastItems = [];
let toastSequence = 0;
let toastHost = null;

function publishToasts(next) {
  toastItems = next;
  for (const listener of toastListeners) listener(toastItems);
}

function dismissToast(id) {
  const item = toastItems.find((entry) => entry.id === id);
  if (!item) return;
  clearTimeout(item.timer);
  publishToasts(toastItems.filter((entry) => entry.id !== id));
}

function ToastLayer() {
  const [items, setItems] = useState(toastItems);
  useEffect(() => {
    toastListeners.add(setItems);
    setItems(toastItems); // catch up with toasts raised before this subscribed
    return () => toastListeners.delete(setItems);
  }, []);
  return html`<div class="toast-layer" role="region" aria-label="Notifications" aria-live="polite">
    ${items.map((item) => html`<div key=${item.id} class=${cx('toast', `toast-${item.tone}`)} role=${item.tone === 'loss' ? 'alert' : undefined}>
      ${TOAST_ICONS[item.tone] && html`<${Icon} name=${TOAST_ICONS[item.tone]} size=${18} class="toast-icon" />`}
      <div class="toast-message">${item.message}</div>
      ${item.action && html`<button type="button" class="toast-action" onClick=${() => {
        dismissToast(item.id);
        item.action.onClick?.();
      }}>${item.action.label}</button>`}
      <button type="button" class="toast-close" aria-label="Dismiss" onClick=${() => dismissToast(item.id)}>
        <${Icon} name="x" size=${16} />
      </button>
    </div>`)}
  </div>`;
}

function ensureToastLayer() {
  if (toastHost?.isConnected) return;
  toastHost = document.createElement('div');
  toastHost.className = 'toast-host';
  document.body.appendChild(toastHost);
  render(html`<${ToastLayer} />`, toastHost);
}

/**
 * toast(message, { tone, duration, action: { label, onClick } }) → dismiss()
 * tone: 'neutral' (default) | 'gain' | 'loss' | 'warn' | 'signal'. An Error shows its message.
 * Errors stay up longer; duration 0 keeps the toast until dismissed. Repeating a toast that is
 * still showing restarts its timer instead of stacking a copy.
 */
export function toast(message, { tone = 'neutral', duration, action } = {}) {
  if (typeof document === 'undefined') return () => {};
  ensureToastLayer();
  const safeTone = TONES.has(tone) ? tone : 'neutral';
  const text = message instanceof Error ? errorMessage(message) : message;
  const ms = duration ?? (safeTone === 'loss' ? TOAST_ERROR_MS : TOAST_MS);
  const schedule = (id) => (ms > 0 && Number.isFinite(ms) ? setTimeout(() => dismissToast(id), ms) : null);

  const duplicate = typeof text === 'string'
    ? toastItems.find((item) => item.message === text && item.tone === safeTone)
    : null;
  if (duplicate) {
    clearTimeout(duplicate.timer);
    duplicate.timer = schedule(duplicate.id);
    return () => dismissToast(duplicate.id);
  }

  toastSequence += 1;
  const id = toastSequence;
  const item = { id, tone: safeTone, message: text, action, timer: schedule(id) };
  const kept = toastItems.slice(-(TOAST_LIMIT - 1));
  for (const dropped of toastItems.slice(0, toastItems.length - kept.length)) clearTimeout(dropped.timer);
  publishToasts([...kept, item]);
  return () => dismissToast(id);
}

// ---------------------------------------------------------------------------------------------
// Data hooks
// ---------------------------------------------------------------------------------------------

/**
 * useAsync(fn, deps) → { data, error, loading, refreshing, reload }
 * Runs fn() on mount and whenever deps change. `loading` is true until the first result for
 * the current deps; reload() re-runs quietly, keeping data on screen (refreshing is true while
 * any run is in flight) and resolves when done. Only the newest run may update state, and
 * nothing updates after unmount.
 */
export function useAsync(fn, deps = []) {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const mountedRef = useRef(true);
  const runRef = useRef(0);
  const [state, setState] = useState({ data: undefined, error: null, loading: true, refreshing: true });

  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  const execute = useCallback((freshDeps) => {
    runRef.current += 1;
    const run = runRef.current;
    const isCurrent = () => mountedRef.current && run === runRef.current;
    setState((prev) => ({ ...prev, loading: freshDeps ? true : prev.loading, refreshing: true }));
    let pending;
    try {
      pending = Promise.resolve(fnRef.current());
    } catch (err) {
      pending = Promise.reject(err);
    }
    return pending.then(
      (data) => {
        if (isCurrent()) setState({ data, error: null, loading: false, refreshing: false });
        return data;
      },
      (err) => {
        if (isCurrent()) setState((prev) => ({ data: prev.data, error: toError(err), loading: false, refreshing: false }));
        return undefined;
      },
    );
  }, []);

  useEffect(() => {
    execute(true);
  }, deps);

  const reload = useCallback(() => execute(false), [execute]);
  return { ...state, reload };
}

const STORE_RELOAD_DEBOUNCE_MS = 40;

/**
 * useStoreData(store, loader, deps = []) → as useAsync, and reloads (quietly) after every
 * successful write anywhere in the store. loader receives the store: (s) => s.deals.list().
 */
export function useStoreData(store, loader, deps = []) {
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const result = useAsync(() => loaderRef.current(store), [store, ...deps]);
  const { reload } = result;

  useEffect(() => {
    if (typeof store?.subscribe !== 'function') return undefined;
    let timer = null;
    // One save can emit several changes (a sale and its items); refetch once.
    const unsubscribe = store.subscribe(() => {
      clearTimeout(timer);
      timer = setTimeout(reload, STORE_RELOAD_DEBOUNCE_MS);
    });
    return () => {
      clearTimeout(timer);
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [store, reload]);

  return result;
}

// ---------------------------------------------------------------------------------------------
// Labels and tones for deal states (tones are Badge tones)
// ---------------------------------------------------------------------------------------------

const meta = (entries) => Object.freeze(
  Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, Object.freeze(value)])),
);

/** Deal statuses in workflow order → { label, tone, hint }. */
export const statusMeta = meta({
  enquiry: { label: 'Enquiry', tone: 'neutral', hint: 'Talking about it, nothing agreed yet' },
  agreed: { label: 'Agreed', tone: 'signal', hint: 'Sale agreed with the client' },
  sourcing: { label: 'Sourcing', tone: 'warn', hint: 'Still buying the item' },
  ready: { label: 'Ready to deliver', tone: 'signal', hint: 'In hand, waiting to hand over' },
  delivered: { label: 'Delivered', tone: 'gain', hint: 'Handed over to the client' },
  completed: { label: 'Completed', tone: 'gain', hint: 'Delivered and settled' },
  cancelled: { label: 'Cancelled', tone: 'muted', hint: 'Called off; left out of every total' },
});

/** [{ value, label }] for a status <Select>, in workflow order. */
export const statusOptions = Object.freeze(
  Object.entries(statusMeta).map(([value, { label }]) => Object.freeze({ value, label })),
);

/** calc.dealTotals().bucket → { label, tone } */
export const bucketMeta = meta({
  realised: { label: 'Realised', tone: 'gain' },
  pending: { label: 'Pending', tone: 'warn' },
  cancelled: { label: 'Cancelled', tone: 'muted' },
});

/** calc.dealTotals().paymentStatus → { label, tone } */
export const paymentMeta = meta({
  paid: { label: 'Paid', tone: 'gain' },
  part: { label: 'Part paid', tone: 'warn' },
  unpaid: { label: 'Unpaid', tone: 'loss' },
  none: { label: 'Nothing due', tone: 'muted' },
});

/** calc.dealTotals().certainty → { label, tone } */
export const certaintyMeta = meta({
  confirmed: { label: 'Confirmed', tone: 'gain' },
  estimated: { label: 'Estimated', tone: 'warn' },
});

// Sizemill Desk app shell (docs/desk-spec.md §7 "Layout").
//
// Boots the data store (`?local=1` → in-browser memory store, otherwise Supabase), shows the
// sign-in gate until there is a user, then renders the layout — sidebar from 900px, top bar
// plus bottom tabs below — around a hash router that lazy-loads one module per view from
// ./views/<name>.js. Views receive { store, params, route, navigate } (plus `user`).

import { html, render, Component, useCallback, useEffect, useMemo, useRef, useState } from './lib/preact.js';
import {
  Badge,
  Banner,
  Button,
  Card,
  ErrorState,
  Field,
  Icon,
  Input,
  Loading,
  Modal,
  ShellContext,
  cx,
  toast,
  useStoreData,
} from './lib/ui.js';
import { BrandLockup, Logo, applyBrand, brandCacheKey, brandFromSettings, cacheBrand, pageTitle, readCachedBrand } from './lib/brand.js';

const APP_NAME = 'Sizemill Desk';
// The logo in the top left is where you change it: it opens Settings at "Your business".
const BRAND_EDIT_HREF = '#/settings?section=business';
const brandEditLabel = (brand) => `${brand?.title ?? APP_NAME} — change your logo, name and colour`;
const SETUP_BANNER_KEY = 'sizemill.desk.setupBannerDismissed';
const MIN_PASSWORD_LENGTH = 8;
const GENERIC_ERROR = 'Something went wrong — please try again.';

// ---------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------

const NEW_SALE = { label: 'New sale', href: '#/sales/new', icon: 'plus' };
const NEW_CLIENT = { label: 'New client', href: '#/clients/new', icon: 'plus' };

// Order matters: '/sales/new' must be tried before '/sales/:id'. `params` are fixed params the
// route adds; `action` is the one primary button the phone top bar shows.
const ROUTES = [
  { name: 'dashboard', pattern: '/', view: 'dashboard', title: 'Dashboard', section: 'home', action: NEW_SALE },
  { name: 'sales', pattern: '/sales', view: 'deals', title: 'Sales', section: 'sales', action: NEW_SALE },
  { name: 'sale-new', pattern: '/sales/new', view: 'deals', title: 'New sale', section: 'sales', params: { mode: 'new' } },
  { name: 'sale', pattern: '/sales/:id', view: 'deal', title: 'Sale', section: 'sales' },
  { name: 'clients', pattern: '/clients', view: 'clients', title: 'Clients', section: 'clients', action: NEW_CLIENT },
  { name: 'client-new', pattern: '/clients/new', view: 'client', title: 'New client', section: 'clients', params: { id: 'new' } },
  { name: 'client', pattern: '/clients/:id', view: 'client', title: 'Client', section: 'clients' },
  { name: 'stock', pattern: '/stock', view: 'stock', title: 'Stock', section: 'stock' },
  { name: 'trips', pattern: '/trips', view: 'trips', title: 'Trips', section: 'trips' },
  { name: 'suppliers', pattern: '/suppliers', view: 'suppliers', title: 'Suppliers', section: 'suppliers' },
  { name: 'check', pattern: '/check', view: 'calculator', title: 'Deal checker', section: 'check' },
  { name: 'settings', pattern: '/settings', view: 'settings', title: 'Settings', section: 'settings' },
  { name: 'search', pattern: '/search', view: 'search', title: 'Search', section: 'search' },
].map((route) => Object.freeze({ ...route, segments: splitPath(route.pattern) }));

const HOME_ROUTE = ROUTES[0];

function splitPath(path) {
  return path.split('/').filter(Boolean);
}

function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null; // malformed %-escape: treat the route as unknown
  }
}

function matchRoute(path) {
  const segments = splitPath(path);
  for (const route of ROUTES) {
    if (route.segments.length !== segments.length) continue;
    const params = {};
    const matched = route.segments.every((expected, index) => {
      if (!expected.startsWith(':')) return expected === segments[index];
      const value = decodeSegment(segments[index]);
      if (!value) return false;
      params[expected.slice(1)] = value;
      return true;
    });
    if (matched) return { route, params };
  }
  return null;
}

/**
 * '#/sales/abc?tab=unpaid' → { name, view, title, section, action, path, query, params, redirect }.
 * Query values are merged into params beneath the path's own params. An unknown address
 * resolves to the dashboard with `redirect: true`.
 */
function resolveHash(hash) {
  const raw = String(hash ?? '').replace(/^#/, '');
  const queryAt = raw.indexOf('?');
  const pathPart = queryAt === -1 ? raw : raw.slice(0, queryAt);
  const query = Object.fromEntries(new URLSearchParams(queryAt === -1 ? '' : raw.slice(queryAt + 1)));
  const path = `/${splitPath(pathPart).join('/')}`;
  const match = raw === '' || raw.startsWith('/') ? matchRoute(path) : null;
  const route = match?.route ?? HOME_ROUTE;
  return {
    name: route.name,
    view: route.view,
    title: route.title,
    section: route.section,
    action: route.action ?? null,
    path: match ? path : '/',
    query: match ? query : {},
    params: match ? { ...query, ...route.params, ...match.params } : {},
    redirect: !match,
  };
}

/** Accepts '#/sales', '/sales' or 'sales'. */
function toHash(target) {
  const value = String(target ?? '').trim();
  if (value.startsWith('#')) return value.length > 1 ? value : '#/';
  return value.startsWith('/') ? `#${value}` : `#/${value}`;
}

/** The title of the page an href points at, for "back to …" labels. */
function labelFor(href) {
  const route = resolveHash(toHash(href));
  return route.redirect ? 'Back' : route.title;
}

function useHashRoute() {
  const [hash, setHash] = useState(() => window.location.hash);

  useEffect(() => {
    const sync = () => setHash(window.location.hash);
    window.addEventListener('hashchange', sync);
    sync(); // catch a change made between first render and this listener
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  const navigate = useCallback((target, { replace = false } = {}) => {
    const next = toHash(target);
    if (replace) {
      window.history.replaceState(window.history.state, '', next);
      setHash(window.location.hash);
    } else if (window.location.hash !== next) {
      window.location.hash = next;
    }
  }, []);

  const route = useMemo(() => resolveHash(hash), [hash]);
  return [route, navigate];
}

// ---------------------------------------------------------------------------------------------
// Small state helpers
// ---------------------------------------------------------------------------------------------

// A value outside Preact's tree, so a Page can update the top bar without re-rendering the view.
function createChannel(initial) {
  let value = initial;
  const listeners = new Set();
  return {
    get: () => value,
    set(next) {
      if (sameHeader(value, next)) return;
      value = next;
      for (const listener of listeners) listener(value);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function sameHeader(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.title === b.title
    && a.back?.href === b.back?.href
    && a.back?.label === b.back?.label
    && a.actionHrefs === b.actionHrefs;
}

function useChannel(channel) {
  const [value, setValue] = useState(channel.get);
  useEffect(() => {
    setValue(channel.get());
    return channel.subscribe(setValue);
  }, [channel]);
  return value;
}

function useOnline() {
  const [online, setOnline] = useState(() => navigator.onLine !== false);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return online;
}

// localStorage can be missing or throw (private mode, blocked site data): treat as unset.
function readFlag(key) {
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(key) {
  try {
    window.localStorage.setItem(key, '1');
  } catch {
    // Not remembered across visits; the banner simply comes back next time.
  }
}

function leaveLocalMode() {
  const url = new URL(window.location.href);
  url.searchParams.delete('local');
  window.location.assign(`${url.pathname}${url.search}${url.hash}`);
}

// ---------------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------------

const viewLoads = new Map(); // view name → Promise<component>
const loadedViews = new Map(); // view name → component, so revisits render without a flash

function loadView(name) {
  let pending = viewLoads.get(name);
  if (!pending) {
    pending = import(`./views/${name}.js`).then((module) => {
      if (typeof module.default !== 'function') {
        throw new Error(`views/${name}.js doesn't export a default view component.`);
      }
      loadedViews.set(name, module.default);
      return module.default;
    });
    viewLoads.set(name, pending);
    pending.catch(() => viewLoads.delete(name));
  }
  return pending;
}

function ViewProblem({ error, title, onRetry, retryLabel, showHome }) {
  const home = showHome ? html`<${Button} kind="ghost" href="#/">Go to dashboard<//>` : null;
  return html`<${Card}>
    <${ErrorState} error=${error} title=${title} onRetry=${onRetry} retryLabel=${retryLabel} actions=${home} />
  <//>`;
}

// Keeps a crashing view from blanking the whole app. The view and the error card sit in
// differently keyed wrappers: when a view throws while updating, Preact can leave its old DOM
// behind, and swapping the wrapper removes that whole subtree. A change of address (resetKey)
// gives the view another go.
class ViewBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  componentDidCatch(error) {
    console.error('[desk] view crashed', error);
    this.setState({ error });
  }

  componentDidUpdate(previous) {
    if (this.state.error && previous.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render({ children, showHome }, { error }) {
    if (!error) return html`<div key="view" class="view-body">${children}</div>`;
    return html`<div key="error" class="view-body">
      <${ViewProblem}
        error=${error}
        title="Something went wrong on this page"
        onRetry=${() => this.setState({ error: null })}
        retryLabel="Try again"
        showHome=${showHome}
      />
    </div>`;
  }
}

function ViewHost({ route, store, navigate, user }) {
  const [state, setState] = useState(() => ({ View: loadedViews.get(route.view) ?? null, error: null }));

  useEffect(() => {
    if (state.View) return undefined;
    let live = true;
    loadView(route.view).then(
      (View) => live && setState({ View, error: null }),
      (error) => live && setState({ View: null, error }),
    );
    return () => {
      live = false;
    };
  }, [route.view]);

  const showHome = route.name !== 'dashboard';
  if (state.error) {
    // A failed module fetch is cached by the browser until the page reloads.
    return html`<div class="view"><${ViewProblem}
      error=${state.error}
      title="Couldn't open this page"
      onRetry=${() => window.location.reload()}
      retryLabel="Reload"
      showHome=${showHome}
    /></div>`;
  }
  if (!state.View) return html`<${Loading} />`;
  const View = state.View;
  return html`<div class="view">
    <${ViewBoundary} showHome=${showHome} resetKey=${JSON.stringify(route.params)}>
      <${View} store=${store} params=${route.params} route=${route} navigate=${navigate} user=${user} />
    <//>
  </div>`;
}

// ---------------------------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------------------------

const NAV_MAIN = [
  { section: 'home', href: '#/', label: 'Dashboard', icon: 'home' },
  { section: 'sales', href: '#/sales', label: 'Sales', icon: 'tag' },
  { section: 'clients', href: '#/clients', label: 'Clients', icon: 'users' },
  { section: 'stock', href: '#/stock', label: 'Stock', icon: 'box' },
];

const NAV_TOOLS = [
  { section: 'trips', href: '#/trips', label: 'Trips', icon: 'car' },
  { section: 'suppliers', href: '#/suppliers', label: 'Suppliers', icon: 'inbox' },
  { section: 'check', href: '#/check', label: 'Deal checker', icon: 'calculator' },
  { section: 'settings', href: '#/settings', label: 'Settings', icon: 'sliders' },
];

const TABS = [
  { section: 'home', href: '#/', label: 'Home', icon: 'home' },
  { section: 'sales', href: '#/sales', label: 'Sales', icon: 'tag' },
  { section: 'clients', href: '#/clients', label: 'Clients', icon: 'users' },
  { section: 'check', href: '#/check', label: 'Check', icon: 'calculator' },
];

const MORE_LINKS = [
  { section: 'stock', href: '#/stock', label: 'Stock', hint: "What you've bought and still hold", icon: 'box' },
  { section: 'trips', href: '#/trips', label: 'Trips', hint: 'Drives, miles and fuel costs', icon: 'car' },
  { section: 'suppliers', href: '#/suppliers', label: 'Suppliers', hint: "Who you've bought from", icon: 'inbox' },
  { section: 'settings', href: '#/settings', label: 'Settings', hint: 'Home address, car and rates', icon: 'sliders' },
];

const MORE_SECTIONS = new Set(MORE_LINKS.map((link) => link.section));

// 'page' when the link is the exact page, 'true' for its section (e.g. Sales while on a sale).
function currentFor(item, route) {
  if (item.section !== route.section) return undefined;
  return toHash(route.path) === item.href ? 'page' : 'true';
}

const SEARCH_LINK = { section: 'search', href: '#/search', label: 'Search', icon: 'search' };

function Sidebar({ route, user, local, brand, onSignOut }) {
  const link = (item) => html`<a key=${item.href} class="nav-link" href=${item.href} aria-current=${currentFor(item, route)}>
    <${Icon} name=${item.icon} size=${18} /><span>${item.label}</span>
  </a>`;
  return html`<aside class="sidebar">
    <a class="brand brand-edit" href=${BRAND_EDIT_HREF} aria-label=${brandEditLabel(brand)} title="Change your logo, name and colour">
      <${BrandLockup} brand=${brand} />
      <span class="brand-edit-badge" aria-hidden="true"><${Icon} name="edit" size=${12} /></span>
    </a>
    <${Button} kind="primary" href=${NEW_SALE.href} icon="plus" block>New sale<//>
    <a class="nav-link" href=${SEARCH_LINK.href} aria-current=${currentFor(SEARCH_LINK, route)} aria-keyshortcuts="/">
      <${Icon} name="search" size=${18} /><span>Search</span><kbd class="nav-kbd" aria-hidden="true">/</kbd>
    </a>
    <nav class="nav" aria-label="Main">
      ${NAV_MAIN.map(link)}
      <div class="nav-label">Tools</div>
      ${NAV_TOOLS.map(link)}
    </nav>
    <div class="sidebar-foot">
      ${local
        ? html`<span><${Badge} tone="warn">Local mode<//></span>
            <span>Data stays in this browser only.</span>
            <${Button} kind="ghost" size="sm" icon="user" onClick=${leaveLocalMode}>Use my account<//>`
        : html`<span class="sidebar-user" title=${user.email ?? ''}>${user.email ?? 'Signed in'}</span>
            <${Button} kind="ghost" size="sm" icon="log-out" onClick=${onSignOut}>Sign out<//>`}
    </div>
  </aside>`;
}

function TopBar({ route, header, local, brand }) {
  const page = useChannel(header);
  const title = page?.title || route.title;
  const back = page?.back ?? null;
  // Skip the route's action when the page already offers the same link.
  const action = route.action && !(page?.actionHrefs ?? '').split(' ').includes(route.action.href)
    ? route.action
    : null;

  useEffect(() => {
    document.title = pageTitle(title);
  }, [title, brand?.title]);

  // Local mode is a small amber dot on the lead (the More sheet says what it means), so the
  // title keeps its room next to Search and the primary action on a 375px phone.
  const localDot = local && html`<span class="topbar-local-dot" aria-hidden="true"></span>`;
  const localNote = local ? ' (local mode)' : '';
  return html`<header class="topbar">
    ${back
      ? html`<a class="topbar-lead" href=${back.href} aria-label=${`Back to ${back.label}${localNote}`} title=${local ? 'Local mode — data stays in this browser' : undefined}>
          <${Icon} name="chevron-left" size=${24} />${localDot}
        </a>`
      : html`<a class="topbar-lead brand-lead brand-edit" href=${BRAND_EDIT_HREF} aria-label=${`${brandEditLabel(brand)}${localNote}`} title=${local ? 'Local mode — data stays in this browser' : 'Change your logo, name and colour'}>
          <${Logo} brand=${brand} size=${28} maxWidth=${88} compact />${localDot}
        </a>`}
    <div class="topbar-title" aria-hidden="true">${title}</div>
    ${route.name !== 'search' && html`<a class="topbar-icon" href="#/search" aria-label="Search"><${Icon} name="search" size=${22} /></a>`}
    ${action && html`<${Button} kind="primary" size="sm" href=${action.href} icon=${action.icon}>${action.label}<//>`}
  </header>`;
}

function TabBar({ route, moreOpen, onMore }) {
  return html`<nav class="tabbar" aria-label="Main">
    ${TABS.map((tab) => html`<a key=${tab.href} class="tabbar-link" href=${tab.href} aria-current=${currentFor(tab, route)}>
      <${Icon} name=${tab.icon} size=${22} /><span>${tab.label}</span>
    </a>`)}
    <button
      type="button"
      class=${cx('tabbar-link', MORE_SECTIONS.has(route.section) && 'is-active')}
      aria-haspopup="dialog"
      aria-expanded=${moreOpen ? 'true' : 'false'}
      onClick=${onMore}
    >
      <${Icon} name="more" size=${22} /><span>More</span>
    </button>
  </nav>`;
}

function MoreSheet({ route, user, local, onClose, onSignOut }) {
  return html`<${Modal} title="More" size="sm" onClose=${onClose}>
    <nav class="sheet-nav" aria-label="More">
      ${MORE_LINKS.map((link) => html`<a key=${link.href} class="sheet-link" href=${link.href} aria-current=${currentFor(link, route)} onClick=${onClose}>
        <span class="sheet-link-icon"><${Icon} name=${link.icon} size=${20} /></span>
        <span class="sheet-link-text">${link.label}<small>${link.hint}</small></span>
      </a>`)}
    </nav>
    <div class="sheet-account">
      ${local
        ? html`<span class="muted small">Local mode — data stays in this browser.</span>
            <${Button} icon="user" onClick=${leaveLocalMode}>Use my account<//>`
        : html`<span class="muted small truncate">${user.email ?? 'Signed in'}</span>
            <${Button} icon="log-out" onClick=${onSignOut}>Sign out<//>`}
    </div>
  <//>`;
}

// First run: until a home address is saved, the dashboard points at Settings.
function SetupBanner({ store, user }) {
  const flagKey = `${SETUP_BANNER_KEY}:${user.id}`;
  const [dismissed, setDismissed] = useState(() => readFlag(flagKey));
  const { data: settings } = useStoreData(store, (s) => s.settings.get());
  // A settings load error is left to the dashboard, which reports the same failure.
  if (dismissed || !settings || settings.home_address) return null;
  const dismiss = () => {
    setDismissed(true);
    writeFlag(flagKey);
  };
  // Compact: one line and a button, so it never pushes the day's numbers off a 375px screen.
  return html`<${Banner}
    tone="signal"
    icon="map-pin"
    class="banner-compact"
    title="Set up your drives"
    onDismiss=${dismiss}
    actions=${html`<${Button} kind="primary" size="sm" href="#/settings">Set up<//>`}
  >
    <span class="banner-compact-more">Home address, mpg and hourly rate — for real drive costs.</span>
  <//>`;
}

function Shell({ store, user }) {
  const [route, navigate] = useHashRoute();
  const header = useMemo(() => createChannel(null), []);
  const [moreOpen, setMoreOpen] = useState(false);
  const mainRef = useRef(null);
  const firstPathRef = useRef(true);
  const online = useOnline();
  const local = store.mode === 'memory';

  const shell = useMemo(() => ({ setHeader: header.set, labelFor, navigate }), [header, navigate]);

  // The business's brand: from the cache until settings load, then live (useStoreData reloads
  // after every save, so a new logo or colour shows everywhere without a reload).
  const { data: settings } = useStoreData(store, (s) => s.settings.get());
  const brandKey = brandCacheKey(local);
  const brand = useMemo(() => brandFromSettings(settings ?? readCachedBrand(undefined, brandKey)), [settings, brandKey]);
  useEffect(() => {
    if (!settings) return;
    applyBrand(settings);
    cacheBrand(settings, undefined, brandKey);
  }, [settings, brandKey]);

  // '/' opens Search from anywhere except while typing.
  useEffect(() => {
    const onKey = (event) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
      const target = event.target;
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="dialog"]')) return;
      event.preventDefault();
      navigate('#/search');
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [navigate]);

  // Unknown addresses show the dashboard; make the address bar agree.
  useEffect(() => {
    if (route.redirect) navigate('#/', { replace: true });
  }, [route.redirect, navigate]);

  // A new page starts at the top, with focus on the content for keyboard and screen-reader users.
  useEffect(() => {
    if (firstPathRef.current) {
      firstPathRef.current = false;
      return;
    }
    setMoreOpen(false);
    window.scrollTo(0, 0);
    mainRef.current?.focus({ preventScroll: true });
  }, [route.path]);

  const signOut = useCallback(async () => {
    setMoreOpen(false);
    try {
      await store.auth.signOut();
      toast('Signed out.');
    } catch (err) {
      toast(err, { tone: 'loss' });
    }
  }, [store]);

  return html`<${ShellContext.Provider} value=${shell}>
    <div class="shell">
      <button type="button" class="skip-link" onClick=${() => mainRef.current?.focus()}>Skip to content</button>
      <${Sidebar} route=${route} user=${user} local=${local} brand=${brand} onSignOut=${signOut} />
      <${TopBar} route=${route} header=${header} local=${local} brand=${brand} />
      <main id="main" class="main" tabindex="-1" ref=${mainRef}>
        ${!online && html`<${Banner} tone="warn" icon="offline" title="You're offline">
          ${local ? 'Routes and live fuel prices need a connection.' : "Changes won't save until you're back online."}
        <//>`}
        ${route.view === 'dashboard' && html`<${SetupBanner} store=${store} user=${user} />`}
        <${ViewHost} key=${route.path} route=${route} store=${store} navigate=${navigate} user=${user} />
      </main>
      <${TabBar} route=${route} moreOpen=${moreOpen} onMore=${() => setMoreOpen(true)} />
      ${moreOpen && html`<${MoreSheet}
        route=${route}
        user=${user}
        local=${local}
        onClose=${() => setMoreOpen(false)}
        onSignOut=${signOut}
      />`}
    </div>
  <//>`;
}

// ---------------------------------------------------------------------------------------------
// Sign-in gate
// ---------------------------------------------------------------------------------------------

const AUTH_COPY = {
  signin: {
    title: 'Sign in',
    sub: 'Your sales, stock and profit in one place.',
    submit: 'Sign in',
    busy: 'Signing in…',
  },
  signup: {
    title: 'Create your account',
    sub: 'One account for Desk and the main Sizemill app.',
    submit: 'Create account',
    busy: 'Creating account…',
  },
  magic: {
    title: 'Email me a sign-in link',
    sub: "We'll send a link that signs you straight in — no password needed.",
    submit: 'Email me a link',
    busy: 'Sending…',
  },
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function authProblem(mode, email, password) {
  if (!email) return 'Enter your email address.';
  if (!EMAIL_PATTERN.test(email)) return "That doesn't look like an email address — check it and try again.";
  if (mode === 'magic') return null;
  if (!password) return mode === 'signup' ? 'Choose a password.' : 'Enter your password.';
  if (mode === 'signup' && password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters for your password.`;
  }
  return null;
}

function AuthGate({ store, notice }) {
  const [mode, setMode] = useState('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(notice ?? null);
  const [success, setSuccess] = useState(null);
  const formRef = useRef(null);
  const mountedRef = useRef(true);
  const copy = AUTH_COPY[mode];
  // The last business that used Desk on this device, so its owner sees their own brand.
  const brand = useMemo(() => brandFromSettings(readCachedBrand()), []);

  useEffect(() => {
    document.title = pageTitle(copy.title);
  }, [copy.title]);

  useEffect(() => {
    // Phones would pop the keyboard over the form, so only focus with a mouse/trackpad.
    if (window.matchMedia?.('(pointer: fine)').matches) formRef.current?.querySelector('input')?.focus();
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const switchMode = (next) => {
    setMode(next);
    setError(null);
    setSuccess(null);
  };

  async function onSubmit(event) {
    event.preventDefault();
    if (busy) return;
    const cleanEmail = email.trim();
    const problem = authProblem(mode, cleanEmail, password);
    if (problem) {
      setError(problem);
      setSuccess(null);
      return;
    }
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      if (mode === 'signin') {
        await store.auth.signIn(cleanEmail, password); // the app swaps in via auth.onChange
      } else if (mode === 'signup') {
        const { needsConfirmation } = await store.auth.signUp(cleanEmail, password);
        if (needsConfirmation && mountedRef.current) {
          setMode('signin');
          setPassword('');
          setSuccess(`Nearly there — open the confirmation email we sent to ${cleanEmail}, then sign in here.`);
        }
      } else {
        await store.auth.magicLink(cleanEmail);
        if (mountedRef.current) setSuccess(`Check your inbox — we've sent a sign-in link to ${cleanEmail}. Open it on this device.`);
      }
    } catch (err) {
      if (mountedRef.current) setError(err instanceof Error && err.message ? err.message : GENERIC_ERROR);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  const passwordToggle = html`<${Button}
    kind="ghost"
    size="sm"
    aria-pressed=${showPassword ? 'true' : 'false'}
    onClick=${() => setShowPassword((shown) => !shown)}
  >${showPassword ? 'Hide' : 'Show'}<//>`;

  return html`<main class="auth">
    <div class="auth-card">
      <div class="auth-brand">
        <${BrandLockup} brand=${brand} size=${40} logoMaxWidth=${240} />
      </div>
      <h1 class="auth-title">${copy.title}</h1>
      <p class="auth-sub">${copy.sub}</p>
      <form class="auth-form" ref=${formRef} onSubmit=${onSubmit} noValidate=${true}>
        ${success && html`<${Banner} tone="gain" icon="mail">${success}<//>`}
        ${error && html`<${Banner} tone="loss">${error}<//>`}
        <${Field} label="Email">
          <${Input}
            type="email"
            name="email"
            autocomplete=${mode === 'signup' ? 'email' : 'username'}
            autocapitalize="off"
            spellcheck=${false}
            inputmode="email"
            value=${email}
            onInput=${(event) => setEmail(event.currentTarget.value)}
          />
        <//>
        ${mode !== 'magic' && html`<${Field} label="Password" hint=${mode === 'signup' ? `At least ${MIN_PASSWORD_LENGTH} characters.` : undefined}>
          <${Input}
            type=${showPassword ? 'text' : 'password'}
            name="password"
            autocomplete=${mode === 'signup' ? 'new-password' : 'current-password'}
            value=${password}
            onInput=${(event) => setPassword(event.currentTarget.value)}
            suffix=${passwordToggle}
          />
        <//>`}
        <${Button} kind="primary" type="submit" size="lg" block loading=${busy}>${busy ? copy.busy : copy.submit}<//>
      </form>
      <div class="auth-alt">
        ${mode === 'signin' && html`
          <button type="button" class="link" onClick=${() => switchMode('magic')}>Email me a sign-in link instead</button>
          <span>New to Sizemill? <button type="button" class="link" onClick=${() => switchMode('signup')}>Create an account</button></span>`}
        ${mode === 'magic' && html`
          <button type="button" class="link" onClick=${() => switchMode('signin')}>Sign in with a password</button>`}
        ${mode === 'signup' && html`
          <span>Already have an account? <button type="button" class="link" onClick=${() => switchMode('signin')}>Sign in</button></span>`}
      </div>
    </div>
    <p class="auth-foot">The same account works in the main Sizemill app.</p>
  </main>`;
}

// ---------------------------------------------------------------------------------------------
// App and boot
// ---------------------------------------------------------------------------------------------

function App({ store, authNotice }) {
  const [user, setUser] = useState(() => store.auth.user());
  const [notice, setNotice] = useState(authNotice);

  useEffect(() => {
    const unsubscribe = store.auth.onChange(setUser);
    setUser(store.auth.user()); // in case it changed before we subscribed
    return unsubscribe;
  }, [store]);

  // A sign-in link error is only worth showing once.
  useEffect(() => {
    if (user) setNotice(null);
  }, [user]);

  if (!user) return html`<${AuthGate} store=${store} notice=${notice} />`;
  return html`<${Shell} key=${user.id} store=${store} user=${user} />`;
}

function BootFailure({ error }) {
  return html`<div class="fatal">
    <${Card}>
      <${ErrorState} title="Desk couldn't start" error=${error} onRetry=${() => window.location.reload()} retryLabel="Reload" />
    <//>
  </div>`;
}

/**
 * Supabase sends failed or expired email links back as '#error=…&error_description=…'.
 * Takes that message (to show on the sign-in form) and tidies the address bar.
 */
function takeAuthRedirectError() {
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const search = new URLSearchParams(window.location.search);
  const code = fragment.get('error_code') ?? search.get('error_code');
  const description = fragment.get('error_description') ?? search.get('error_description');
  if (!code && !description) return null;

  for (const key of ['error', 'error_code', 'error_description']) search.delete(key);
  const query = search.toString();
  window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}#/`);

  // Only our own sentences: the URL's description is attacker-controlled text, never shown.
  if (code === 'otp_expired' || /expired|invalid/i.test(description ?? '')) return LINK_EXPIRED;
  return 'Signing in from that link failed — please try again.';
}

const LINK_EXPIRED = 'That sign-in link has expired or was already used — request a new one below.';

/**
 * Desk signs in with PKCE (store.js), so an '#access_token=…' link is never ours: it could
 * only swap in someone else's session. Drop it before supabase-js sees it.
 */
function dropImplicitGrant() {
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  if (!fragment.has('access_token') && !fragment.has('refresh_token')) return false;
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/`);
  return true;
}

/**
 * supabase-js exchanges '?code=' itself (and removes it) when this browser asked for the link.
 * A code still there means the link was opened somewhere else, e.g. Safari instead of the
 * installed app: tidy the address and say what to do.
 */
function takeLeftoverCode(store) {
  const search = new URLSearchParams(window.location.search);
  if (!search.has('code')) return null;
  search.delete('code');
  const query = search.toString();
  window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash || '#/'}`);
  return store.auth.user() ? null : 'That link only works in the browser you asked for it from — open it there, or sign in here.';
}

// Last line of defence: a failed save nobody caught still tells the user what happened.
function reportUnhandledRejection(event) {
  const reason = event.reason;
  if (reason?.name === 'AbortError') return;
  // Store and API errors are plain Errors written for people; anything else is a bug.
  const readable = reason instanceof Error && reason.constructor === Error && reason.message;
  toast(readable ? reason.message : GENERIC_ERROR, { tone: 'loss' });
}

async function boot() {
  const root = document.getElementById('app');
  window.addEventListener('unhandledrejection', reportUnhandledRejection);

  const redirectError = takeAuthRedirectError();
  const droppedLink = dropImplicitGrant();
  const local = new URLSearchParams(window.location.search).get('local') === '1';
  // Paint the last known brand straight away (sign-in screen, first frame of the shell). Local
  // mode has its own cache so it never overwrites the account's.
  applyBrand(readCachedBrand(undefined, brandCacheKey(local)));

  let store;
  try {
    const { createStore } = await import('./lib/store.js');
    // In Supabase mode this resolves once supabase-js has read any sign-in link in the URL.
    store = await createStore({ mode: local ? 'memory' : 'supabase' });
  } catch (error) {
    console.error('[desk] boot failed', error);
    root.textContent = '';
    render(html`<${BootFailure} error=${error} />`, root);
    return;
  }

  const leftoverCode = local ? null : takeLeftoverCode(store);
  const authNotice = redirectError ?? leftoverCode ?? (droppedLink && !store.auth.user() ? LINK_EXPIRED : null);
  root.textContent = '';
  render(html`<${App} store=${store} authNotice=${authNotice} />`, root);
}

boot();

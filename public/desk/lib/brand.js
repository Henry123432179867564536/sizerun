// Sizemill Desk branding: the owner's logo, business name and brand colour.
//
//   brandFromSettings(settings) → { name|null, logo: { src, w, h }|null, color|null, monogram|null, title }
//   brandPalette(hex)           → { light: {brand, ink, tint, text}, dark: {…}, adjusted } | null
//   applyBrand(settings)        sets --brand, --brand-ink, --brand-tint and --brand-text on :root
//                               (per colour scheme), points --signal at the brand when one is set,
//                               and updates the page title and theme-color; idempotent
//   cacheBrand(settings) / readCachedBrand() / clearCachedBrand()
//                               the last brand in localStorage, for the sign-in screen
//   monogram(name)              'Umi Sneakers' → 'US'
//   prepareLogo(file)           any photo or logo → a ≤ 512px PNG/WebP/JPEG blob of ≤ 1 MB
//   <Logo settings|brand size maxWidth compact />   the logo, or a monogram tile in the brand colour
//
// Semantic colours (gain, loss, warn) never follow the brand. With no brand colour every token
// keeps desk.css's own value, so the app looks exactly as it did before branding existed.

import { html, useState } from './preact.js';

export const BRAND_CACHE_KEY = 'sizemill.desk.brand';
export const DEFAULT_BRAND = '#1F4B85'; // desk.css --signal (light)
export const APP_NAME = 'Sizemill Desk';
// The store's default business_name: shown as "not set" rather than as the owner's brand.
const PLACEHOLDER_NAME = 'Sizemill';
const MAX_NAME = 80;

/** Six calm presets; each passes the contrast guard unchanged in light mode. */
export const PRESETS = Object.freeze([
  { name: 'Navy', hex: '#1F4B85' },
  { name: 'Ink', hex: '#1B2028' },
  { name: 'Teal', hex: '#0F6E74' },
  { name: 'Forest', hex: '#2D5A27' },
  { name: 'Claret', hex: '#8C1D40' },
  { name: 'Ember', hex: '#B5471B' },
].map(Object.freeze));

// Surfaces from desk.css the guard measures against.
const WHITE = '#FFFFFF';
const LIGHT_PAPER = '#EDEDE8';
const DARK_SURFACE = '#1A1D22';
const DARK_PAPER = '#121417';
const INK_LIGHT = '#1B2028'; // dark text on a light fill
const INK_DARK = '#111418';

// Today's signal tokens, used when there is no (usable) brand colour.
const DEFAULT_PALETTE = Object.freeze({
  light: Object.freeze({ brand: '#1F4B85', ink: '#FFFFFF', tint: '#EAF0F7', text: '#1F4B85' }),
  dark: Object.freeze({ brand: '#7FA7DB', ink: '#0D1724', tint: '#1B2A3D', text: '#7FA7DB' }),
  adjusted: false,
});

// ---------------------------------------------------------------------------------------------
// Colour maths (WCAG 2 relative luminance, HSL lightness steps)
// ---------------------------------------------------------------------------------------------

/** '#abc', 'abc', '#AABBCC' or 'aabbcc' → '#AABBCC'; anything else → null. */
export function normalizeHex(value) {
  const raw = String(value ?? '').trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(raw)) return `#${[...raw].map((c) => c + c).join('')}`.toUpperCase();
  if (/^[0-9a-f]{6}$/i.test(raw)) return `#${raw}`.toUpperCase();
  return null;
}

function toRgb(hex) {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex(rgb) {
  return `#${rgb.map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

export function luminance(hex) {
  const [r, g, b] = toRgb(hex).map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1–21. */
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** White or near-black, whichever reads better on `fill`. */
export function inkFor(fill, dark = INK_LIGHT) {
  return contrast(fill, WHITE) >= contrast(fill, dark) ? WHITE : dark;
}

function toHsl(hex) {
  const [r, g, b] = toRgb(hex).map((c) => c / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}

function fromHsl([h, s, l]) {
  if (s === 0) return toHex([l * 255, l * 255, l * 255]);
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t) => {
    const x = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return toHex([hue(h + 1 / 3) * 255, hue(h) * 255, hue(h - 1 / 3) * 255]);
}

// Steps HSL lightness by 1% (darker: step < 0) until ok(colour) holds or lightness runs out.
function shiftUntil(hex, step, ok) {
  const [h, s, l] = toHsl(hex);
  let current = hex;
  for (let i = 1; i <= 100 && !ok(current); i += 1) current = fromHsl([h, s, Math.min(1, Math.max(0, l + step * i))]);
  return current;
}

function mix(hex, over, amount) {
  const a = toRgb(hex);
  const b = toRgb(over);
  return toHex(a.map((c, i) => c * amount + b[i] * (1 - amount)));
}

function rgba(hex, alpha) {
  return `rgba(${toRgb(hex).join(', ')}, ${alpha})`;
}

/**
 * The colours Desk uses for one brand colour, with a contrast guard:
 *  - light.brand: the colour itself (darkened only if no ink reaches 4.5:1 on it, or if it would
 *    vanish against white); light.text: darkened until 4.5:1 on white and on paper.
 *  - dark.brand: lightened until 3:1 against the dark surfaces; dark.text: lightened to 4.5:1.
 *  - ink: white or near-black, whichever reads better on the fill (always ≥ 4.5:1).
 * `adjusted` is true when text needed a deeper shade than the colour picked.
 */
export function brandPalette(value) {
  const hex = normalizeHex(value);
  if (!hex) return null;

  let lightFill = shiftUntil(hex, -0.01, (c) => contrast(c, WHITE) >= 1.35);
  if (contrast(lightFill, inkFor(lightFill)) < 4.5) lightFill = shiftUntil(lightFill, -0.01, (c) => contrast(c, WHITE) >= 4.5);
  const lightText = shiftUntil(hex, -0.01, (c) => contrast(c, WHITE) >= 4.5 && contrast(c, LIGHT_PAPER) >= 4.5);

  let darkFill = shiftUntil(hex, 0.01, (c) => contrast(c, DARK_SURFACE) >= 3 && contrast(c, DARK_PAPER) >= 3);
  if (contrast(darkFill, inkFor(darkFill, INK_DARK)) < 4.5) darkFill = shiftUntil(darkFill, 0.01, (c) => contrast(c, INK_DARK) >= 4.5);
  const darkText = shiftUntil(hex, 0.01, (c) => contrast(c, DARK_SURFACE) >= 4.5 && contrast(c, DARK_PAPER) >= 4.5);

  const palette = {
    light: { brand: lightFill, ink: inkFor(lightFill), tint: mix(lightFill, WHITE, 0.1), text: lightText },
    dark: { brand: darkFill, ink: inkFor(darkFill, INK_DARK), tint: mix(darkFill, DARK_SURFACE, 0.18), text: darkText },
    adjusted: Math.abs(toHsl(lightText)[2] - toHsl(hex)[2]) > 0.08,
  };
  // Last resort (never expected): fall back to Desk's own colours rather than ship unreadable text.
  const readable = contrast(palette.light.ink, palette.light.brand) >= 4.5
    && contrast(palette.dark.ink, palette.dark.brand) >= 4.5
    && contrast(palette.light.text, WHITE) >= 4.5
    && contrast(palette.dark.text, DARK_SURFACE) >= 4.5;
  return readable ? palette : null;
}

/** brandPalette(hex), or Desk's own colours when there is no usable brand colour. */
export function paletteFor(value) {
  return brandPalette(value) ?? DEFAULT_PALETTE;
}

// ---------------------------------------------------------------------------------------------
// Brand data
// ---------------------------------------------------------------------------------------------

/** Up to two initials: 'Umi Sneakers' → 'US', 'nike' → 'N', '' → null. */
export function monogram(name) {
  const words = String(name ?? '')
    .split(/[\s\-_&+/.,]+/)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean);
  if (!words.length) return null;
  return words.slice(0, 2).map((word) => Array.from(word)[0].toLocaleUpperCase('en-GB')).join('');
}

/** A logo_url → { src, w, h } (w/h from the '#w=…&h=…' fragment, or null), or null if unusable. */
export function parseLogo(url) {
  if (typeof url !== 'string') return null;
  const value = url.trim();
  if (!/^https:\/\//i.test(value) && !/^data:image\/(png|jpeg|webp);base64,/i.test(value)) return null;
  const hashAt = value.indexOf('#');
  const src = hashAt === -1 ? value : value.slice(0, hashAt);
  const params = new URLSearchParams(hashAt === -1 ? '' : value.slice(hashAt + 1));
  const size = (key) => {
    const n = Number(params.get(key));
    return Number.isInteger(n) && n > 0 && n <= 4096 ? n : null;
  };
  const w = size('w');
  const h = size('h');
  return { src, w: w && h ? w : null, h: w && h ? h : null };
}

function cleanName(value) {
  const name = typeof value === 'string' ? value.trim().slice(0, MAX_NAME) : '';
  return name && name !== PLACEHOLDER_NAME ? name : null;
}

/** settings (or a cached brand { name, logo_url, brand_color }) → what the shell shows. */
export function brandFromSettings(settings) {
  const s = settings ?? {};
  const name = cleanName(s.business_name ?? s.name);
  return {
    name,
    logo: parseLogo(s.logo_url),
    color: normalizeHex(s.brand_color),
    monogram: monogram(name),
    title: name ?? APP_NAME,
  };
}

// ---------------------------------------------------------------------------------------------
// Applying the brand to the page
// ---------------------------------------------------------------------------------------------

const VARS_ID = 'desk-brand-vars';
const STYLE_ID = 'desk-brand-styles';
let appTitle = APP_NAME;

function block(selector, p, signal) {
  const vars = [
    `--brand: ${p.brand}`, `--brand-ink: ${p.ink}`, `--brand-tint: ${p.tint}`, `--brand-text: ${p.text}`,
  ];
  if (signal) {
    // The brand drives Desk's accent: primary buttons, links, the active tab, focus rings.
    const step = signal === 'light' ? -0.06 : 0.06;
    const hover = fromHsl(((hsl) => [hsl[0], hsl[1], Math.min(1, Math.max(0, hsl[2] + step))])(toHsl(p.text)));
    vars.push(
      `--signal: ${p.text}`, `--signal-tint: ${p.tint}`, `--on-signal: ${inkFor(p.text, signal === 'light' ? INK_LIGHT : INK_DARK)}`,
      `--signal-hover: ${hover}`, `--ring: ${rgba(p.text, signal === 'light' ? 0.28 : 0.35)}`,
    );
  }
  return `${selector} { ${vars.join('; ')}; }`;
}

/** The CSS applyBrand installs for a brand colour (exported for tests). */
export function brandCss(value) {
  const palette = brandPalette(value);
  const p = palette ?? DEFAULT_PALETTE;
  const signal = Boolean(palette);
  return [
    block(':root', p.light, signal && 'light'),
    `@media (prefers-color-scheme: dark) { ${block(':root:not([data-theme="light"])', p.dark, signal && 'dark')} }`,
    block(':root[data-theme="dark"]', p.dark, signal && 'dark'),
    block(':root[data-theme="light"]', p.light, signal && 'light'),
  ].join('\n');
}

/** Sets the brand on the page: CSS variables, title and theme-color. Safe to call repeatedly. */
export function applyBrand(settings) {
  const brand = brandFromSettings(settings);
  if (typeof document === 'undefined') return brand;
  injectStyles();
  let vars = document.getElementById(VARS_ID);
  if (!vars) {
    vars = document.createElement('style');
    vars.id = VARS_ID;
    document.head.append(vars);
  }
  const css = brandCss(brand.color);
  if (vars.textContent !== css) vars.textContent = css;

  const nextTitle = brand.title;
  if (nextTitle !== appTitle) {
    const old = appTitle;
    appTitle = nextTitle;
    const current = document.title;
    if (current === old) document.title = nextTitle;
    else if (current.endsWith(` · ${old}`)) document.title = `${current.slice(0, -old.length)}${nextTitle}`;
  }

  // Browser chrome (Android's address bar, Safari's tab bar) in the brand fill.
  const palette = brandPalette(brand.color);
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    if (!meta.dataset.deskDefault) meta.dataset.deskDefault = meta.getAttribute('content') ?? '';
    const dark = /dark/.test(meta.getAttribute('media') ?? '');
    const content = palette ? palette[dark ? 'dark' : 'light'].brand : meta.dataset.deskDefault;
    if (meta.getAttribute('content') !== content) meta.setAttribute('content', content);
  }
  return brand;
}

/** 'Dashboard' → 'Dashboard · Umi Sneakers' (or '· Sizemill Desk' with no business name). */
export function pageTitle(page) {
  return page ? `${page} · ${appTitle}` : appTitle;
}

// ---------------------------------------------------------------------------------------------
// The cached brand (sign-in screen)
// ---------------------------------------------------------------------------------------------

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Remembers { name, logo_url, brand_color } so the sign-in screen can show it. Never throws. */
export function cacheBrand(settings, storage = defaultStorage()) {
  if (!storage) return;
  const brand = brandFromSettings(settings);
  try {
    if (!brand.name && !brand.logo && !brand.color) {
      storage.removeItem(BRAND_CACHE_KEY);
      return;
    }
    const entry = { v: 1, name: brand.name, logo_url: brand.logo ? settings.logo_url : null, brand_color: brand.color };
    const json = JSON.stringify(entry);
    if (storage.getItem(BRAND_CACHE_KEY) === json) return;
    try {
      storage.setItem(BRAND_CACHE_KEY, json);
    } catch {
      // A big local-mode logo may not fit twice: keep the name and colour at least.
      storage.setItem(BRAND_CACHE_KEY, JSON.stringify({ ...entry, logo_url: null }));
    }
  } catch {
    // Storage blocked or full: the sign-in screen simply shows Sizemill Desk.
  }
}

/** The cached brand as { name, logo_url, brand_color }, or null. Never throws. */
export function readCachedBrand(storage = defaultStorage()) {
  try {
    const raw = storage?.getItem(BRAND_CACHE_KEY);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (!entry || typeof entry !== 'object') return null;
    const brand = brandFromSettings(entry);
    if (!brand.name && !brand.logo && !brand.color) return null;
    return { name: brand.name, logo_url: brand.logo ? entry.logo_url : null, brand_color: brand.color };
  } catch {
    return null;
  }
}

export function clearCachedBrand(storage = defaultStorage()) {
  try {
    storage?.removeItem(BRAND_CACHE_KEY);
  } catch {
    // nothing to clear
  }
}

// ---------------------------------------------------------------------------------------------
// Logo image preparation (browser only)
// ---------------------------------------------------------------------------------------------

const LOGO_EDGE = 512;
const LOGO_MAX_BYTES = 1_048_576;
const SOURCE_MAX_BYTES = 25 * 1024 * 1024;

function canvasBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function drawScaled(source, width, height, edge) {
  const scale = Math.min(1, edge / Math.max(width, height));
  const tw = Math.max(1, Math.round(width * scale));
  const th = Math.max(1, Math.round(height * scale));
  const draw = (from, w, h) => {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(from, 0, 0, w, h);
    return canvas;
  };
  // Halve in steps first: one big jump down (a 4032px photo to 512px) aliases badly.
  let current = source;
  let w = width;
  let h = height;
  while (w > tw * 2 && h > th * 2) {
    w = Math.round(w / 2);
    h = Math.round(h / 2);
    current = draw(current, w, h);
  }
  return draw(current, tw, th);
}

function hasTransparency(canvas) {
  const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 3; i < data.length; i += 4) if (data[i] < 250) return true;
  return false;
}

function flatten(canvas) {
  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = canvas.height;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(canvas, 0, 0);
  return out;
}

async function encode(canvas) {
  if (hasTransparency(canvas)) {
    const png = await canvasBlob(canvas, 'image/png');
    if (png && png.size <= LOGO_MAX_BYTES) return png;
    const webp = await canvasBlob(canvas, 'image/webp', 0.9); // keeps transparency where supported
    return webp?.type === 'image/webp' && webp.size <= LOGO_MAX_BYTES ? webp : null;
  }
  for (const quality of [0.9, 0.82]) {
    const webp = await canvasBlob(canvas, 'image/webp', quality);
    if (webp?.type === 'image/webp' && webp.size <= LOGO_MAX_BYTES) return webp; // Safari may hand back PNG
    const jpeg = await canvasBlob(flatten(canvas), 'image/jpeg', quality);
    if (jpeg && jpeg.size <= LOGO_MAX_BYTES) return jpeg;
  }
  return null;
}

/**
 * Any image the browser can read (a PNG/JPEG/WebP logo, an iPhone photo) → a logo ready to
 * upload: { blob, type, width, height }. Longest edge ≤ 512px, transparency kept as PNG,
 * otherwise WebP or JPEG; always ≤ 1 MB. Rejects with a sentence for people.
 */
export async function prepareLogo(file) {
  if (!file || typeof file.size !== 'number') throw new Error('Choose an image for your logo.');
  const type = String(file.type ?? '').toLowerCase();
  if (type && !type.startsWith('image/')) throw new Error("That file isn't an image — pick a PNG, JPG or WebP.");
  if (/svg|gif/.test(type)) throw new Error('Use a PNG, JPG or WebP image.');
  if (file.size > SOURCE_MAX_BYTES) throw new Error('That file is too big — pick a smaller image.');

  const url = URL.createObjectURL(file);
  let image;
  try {
    image = new Image();
    image.decoding = 'async';
    image.src = url;
    await image.decode(); // draws upright: browsers apply EXIF orientation
  } catch {
    throw new Error("Couldn't read that image — try a PNG or JPG of your logo.");
  } finally {
    URL.revokeObjectURL(url);
  }
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  if (!width || !height) throw new Error("Couldn't read that image — try a PNG or JPG of your logo.");

  for (const edge of [LOGO_EDGE, 384, 256]) {
    const canvas = drawScaled(image, width, height, edge);
    const blob = await encode(canvas);
    if (blob) return { blob, type: blob.type, width: canvas.width, height: canvas.height };
  }
  throw new Error("Couldn't make that image small enough — try a simpler logo file.");
}

// ---------------------------------------------------------------------------------------------
// <Logo>
// ---------------------------------------------------------------------------------------------

const CSS = `
.brand-lockup { display: flex; align-items: center; gap: 10px; min-width: 0; }
.brand-lockup.has-logo { flex-direction: column; align-items: flex-start; gap: 6px; }
.brand-lockup .brand-name { min-width: 0; overflow-wrap: anywhere; }
.brand-lockup.has-logo .brand-name:empty { display: none; }
.topbar-lead.brand-lead { width: auto; min-width: 40px; max-width: 112px; padding: 0 4px; }
.topbar-icon { display: grid; flex: none; place-items: center; width: 40px; height: 40px; border-radius: var(--r-ctl); color: var(--ink-2); }
.topbar-icon:hover { background: var(--hover); color: var(--ink); text-decoration: none; }
.nav-kbd { margin-left: auto; padding: 0 6px; border: 1px solid var(--line-2); border-radius: 4px; color: var(--ink-3); font: 500 11px/18px var(--mono); }
.auth-brand .brand-lockup.has-logo { align-items: center; width: 100%; text-align: center; }
.brand-logo { display: block; flex: none; object-fit: contain; object-position: left center; }
.brand-monogram { display: inline-grid; flex: none; place-items: center; width: var(--mono-size, 32px); height: var(--mono-size, 32px); border-radius: calc(var(--mono-size, 32px) * 0.28); background: var(--brand, var(--signal)); color: var(--brand-ink, var(--on-signal)); font-size: calc(var(--mono-size, 32px) * 0.4); font-weight: 600; letter-spacing: 0.02em; line-height: 1; user-select: none; }
`;

function injectStyles() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.append(style);
}

/** Display size for a logo of w×h in a size-tall, maxWidth-wide box (null when unknown). */
export function logoBox(logo, size, maxWidth) {
  if (!logo?.w || !logo?.h) return null;
  const width = Math.min(maxWidth, (size * logo.w) / logo.h);
  return { width: Math.round(width), height: Math.round((width * logo.h) / logo.w) };
}

/**
 * Logo({ settings | brand, size = 32, maxWidth = size * 4, compact })
 * The logo image (alt = business name), else a monogram tile in the brand colour, else
 * Sizemill's own mark. `compact` swaps a very wide logo (over 3:1) for the monogram.
 */
export function Logo({ settings, brand: given, size = 32, maxWidth, compact = false, class: classAttr }) {
  injectStyles();
  const brand = given ?? brandFromSettings(settings);
  const [failed, setFailed] = useState(null);
  const label = brand.name ?? APP_NAME;
  const limit = maxWidth ?? size * 4;
  const logo = brand.logo && failed !== brand.logo.src ? brand.logo : null;
  const tooWide = compact && logo?.w && logo.w / logo.h > 3 && brand.monogram;

  if (logo && !tooWide) {
    const box = logoBox(logo, size, limit);
    const style = box
      ? `width:${box.width}px;height:${box.height}px`
      : `height:${size}px;width:auto;max-width:${limit}px`;
    return html`<img
      class=${['brand-logo', classAttr].filter(Boolean).join(' ')}
      src=${logo.src}
      alt=${label}
      width=${box?.width}
      height=${box?.height}
      style=${style}
      decoding="async"
      onError=${() => setFailed(logo.src)}
    />`;
  }
  if (!brand.monogram) {
    // No business name yet: Sizemill's own mark.
    return html`<span class=${['brand-mark', classAttr].filter(Boolean).join(' ')} style=${`width:${size}px;height:${size}px;border-radius:${Math.round(size * 0.29)}px`} role="img" aria-label=${label}></span>`;
  }
  return html`<span
    class=${['brand-monogram', classAttr].filter(Boolean).join(' ')}
    style=${`--mono-size:${size}px`}
    role="img"
    aria-label=${label}
  >${brand.monogram}</span>`;
}

/**
 * BrandLockup({ brand, size = 32, sub = 'Desk' }) — the sidebar / sign-in identity: the logo
 * with the business name under it, or the monogram beside the name, or Sizemill Desk.
 */
export function BrandLockup({ brand, size = 32, sub = 'Desk', logoMaxWidth = 176, class: classAttr }) {
  injectStyles();
  const b = brand ?? brandFromSettings(null);
  const classes = (extra) => ['brand-lockup', extra, classAttr].filter(Boolean).join(' ');
  if (b.logo) {
    return html`<span class=${classes('has-logo')}>
      <${Logo} brand=${b} size=${size + 8} maxWidth=${logoMaxWidth} />
      <span class="brand-name">${b.name ?? ''}${b.name && html`<small>${sub}</small>`}</span>
    </span>`;
  }
  return html`<span class=${classes()}>
    <${Logo} brand=${b} size=${size} />
    <span class="brand-name">${b.name ?? 'Sizemill'}<small>${sub}</small></span>
  </span>`;
}

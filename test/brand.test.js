// Tests for public/desk/lib/brand.js: monogram, colour maths and the contrast guard, logo URL
// parsing, the cached brand and the <Logo> fallbacks.
//
// brand.js imports Preact from a CDN (through lib/preact.js), which Node can't load, so the
// module is imported with that one line swapped for small stand-ins.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../public/desk/lib/brand.js', import.meta.url), 'utf8');
const IMPORT_LINE = /^import \{ html, useState \} from '\.\/preact\.js';$/m;
assert.match(source, IMPORT_LINE, 'brand.js imports only html and useState from preact.js');
const stubbed = source.replace(
  IMPORT_LINE,
  'const html = (strings, ...values) => ({ markup: strings.join("\\u0000"), values }); const useState = (v) => [v, () => {}];',
);
const brand = await import(`data:text/javascript;base64,${Buffer.from(stubbed).toString('base64')}`);
const {
  BRAND_CACHE_KEY, LOCAL_BRAND_CACHE_KEY, PRESETS, APP_NAME, Logo, brandCacheKey, brandCss, brandFromSettings, brandPalette, cacheBrand,
  clearCachedBrand, contrast, inkFor, logoBox, monogram, normalizeHex, parseLogo, readCachedBrand,
} = brand;

function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

const WHITE = '#FFFFFF';
const PAPER = '#EDEDE8';
const DARK_SURFACE = '#1A1D22';
const DARK_PAPER = '#121417';

describe('monogram', () => {
  test('takes the first letter of the first two words', () => {
    assert.equal(monogram('Umi Sneakers'), 'US');
    assert.equal(monogram('umi sneakers ltd'), 'US');
    assert.equal(monogram('Nike'), 'N');
    assert.equal(monogram('  kicks-r-us  '), 'KR');
    assert.equal(monogram('A & B Trading'), 'AB');
    assert.equal(monogram('Émile Boots'), 'ÉB');
    assert.equal(monogram('1st Kit'), '1K');
  });

  test('is null when there is nothing to use', () => {
    assert.equal(monogram(''), null);
    assert.equal(monogram('   '), null);
    assert.equal(monogram(null), null);
    assert.equal(monogram('&&'), null);
  });
});

describe('colour', () => {
  test('normalizeHex accepts 3 or 6 digits, with or without #', () => {
    assert.equal(normalizeHex('#1f4b85'), '#1F4B85');
    assert.equal(normalizeHex('1F4B85'), '#1F4B85');
    assert.equal(normalizeHex('#abc'), '#AABBCC');
    assert.equal(normalizeHex(' fff '), '#FFFFFF');
    for (const bad of ['', null, '#12345', '#GGGGGG', 'navy', '#1F4B855']) assert.equal(normalizeHex(bad), null, String(bad));
  });

  test('contrast follows WCAG', () => {
    assert.equal(Math.round(contrast('#000000', WHITE) * 100) / 100, 21);
    assert.equal(contrast(WHITE, WHITE), 1);
    assert.ok(Math.abs(contrast('#1F4B85', WHITE) - 8.74) < 0.05);
    assert.equal(inkFor('#1F4B85'), WHITE);
    assert.equal(inkFor('#F2C200'), '#1B2028');
  });

  const inputs = [...PRESETS.map((p) => p.hex), '#F2C200', '#FF3B6B', '#FFFFFF', '#000000', '#777777', '#00FF00', '#7FA7DB'];
  for (const hex of inputs) {
    test(`the guard keeps ${hex} readable in light and dark`, () => {
      const p = brandPalette(hex);
      assert.ok(p, 'has a palette');
      assert.ok(contrast(p.light.ink, p.light.brand) >= 4.5, 'light ink on fill');
      assert.ok(contrast(p.dark.ink, p.dark.brand) >= 4.5, 'dark ink on fill');
      assert.ok(contrast(p.light.text, WHITE) >= 4.5 && contrast(p.light.text, PAPER) >= 4.5, 'light text');
      assert.ok(contrast(p.dark.text, DARK_SURFACE) >= 4.5 && contrast(p.dark.text, DARK_PAPER) >= 4.5, 'dark text');
      assert.ok(contrast(p.dark.brand, DARK_SURFACE) >= 3, 'dark fill stands out');
    });
  }

  test('presets pass unchanged in light mode; a pale colour gets a deeper text shade', () => {
    for (const { hex } of PRESETS) {
      const p = brandPalette(hex);
      assert.equal(p.light.brand, hex);
      assert.equal(p.light.text, hex);
      assert.equal(p.adjusted, false);
    }
    const gold = brandPalette('#F2C200');
    assert.equal(gold.light.brand, '#F2C200');
    assert.equal(gold.light.ink, '#1B2028');
    assert.notEqual(gold.light.text, '#F2C200');
    assert.equal(gold.adjusted, true);
    assert.equal(brandPalette('not a colour'), null);
    assert.equal(brandPalette(null), null);
  });

  test('brandCss only re-points --signal when a brand colour is set', () => {
    const none = brandCss(null);
    assert.match(none, /--brand: #1F4B85/);
    assert.match(none, /--brand: #7FA7DB/);
    assert.doesNotMatch(none, /--signal:/);
    const ember = brandCss('#b5471b');
    assert.match(ember, /:root \{ --brand: #B5471B; --brand-ink: #FFFFFF;/);
    assert.match(ember, /--signal: #B5471B/);
    assert.match(ember, /@media \(prefers-color-scheme: dark\) \{ :root:not\(\[data-theme="light"\]\)/);
    assert.match(ember, /:root\[data-theme="dark"\]/);
  });
});

describe('brand data', () => {
  test('parseLogo reads the size fragment and refuses unusable URLs', () => {
    const url = 'https://x.supabase.co/storage/v1/object/public/brand/u/logo-1759677000000.png#w=512&h=171';
    assert.deepEqual(parseLogo(url), { src: url.split('#')[0], w: 512, h: 171, tone: null });
    assert.deepEqual(parseLogo(`${url}&tone=dark`), { src: url.split('#')[0], w: 512, h: 171, tone: 'dark' });
    assert.deepEqual(parseLogo('https://x/logo.png'), { src: 'https://x/logo.png', w: null, h: null, tone: null });
    assert.deepEqual(parseLogo('https://x/logo.png#w=abc&h=-1&tone=pink'), { src: 'https://x/logo.png', w: null, h: null, tone: null });
    assert.equal(parseLogo('data:image/png;base64,AAAA#w=10&h=10').src, 'data:image/png;base64,AAAA');
    for (const bad of [null, '', 'http://x/logo.png', 'javascript:alert(1)', 'data:image/svg+xml;base64,AAAA', 'data:text/html,hi']) {
      assert.equal(parseLogo(bad), null, String(bad));
    }
  });

  test('brandFromSettings treats the default business name as not set', () => {
    assert.deepEqual(brandFromSettings({ business_name: 'Sizemill', logo_url: null, brand_color: null }), {
      name: null, logo: null, color: null, monogram: null, title: APP_NAME,
    });
    const umi = brandFromSettings({ business_name: ' Umi Sneakers ', brand_color: '#0f6e74' });
    assert.equal(umi.name, 'Umi Sneakers');
    assert.equal(umi.monogram, 'US');
    assert.equal(umi.color, '#0F6E74');
    assert.equal(umi.title, 'Umi Sneakers');
    assert.equal(brandFromSettings({ name: 'Umi Sneakers' }).name, 'Umi Sneakers', 'reads the cached shape too');
    assert.equal(brandFromSettings(null).name, null);
  });

  test('logoBox fits the logo inside height × maxWidth', () => {
    assert.deepEqual(logoBox({ w: 512, h: 512 }, 32, 128), { width: 32, height: 32 });
    assert.deepEqual(logoBox({ w: 512, h: 128 }, 32, 128), { width: 128, height: 32 });
    assert.deepEqual(logoBox({ w: 1000, h: 100 }, 40, 176), { width: 176, height: 18 });
    assert.equal(logoBox({ w: null, h: null }, 32, 128), null);
  });
});

describe('cached brand', () => {
  test('round-trips name, logo and colour under sizemill.desk.brand', () => {
    const storage = fakeStorage();
    const logo = 'https://x/brand/u/logo-1.png#w=10&h=10';
    cacheBrand({ business_name: 'Umi Sneakers', logo_url: logo, brand_color: '#1f4b85', mpg: 45 }, storage);
    assert.deepEqual(JSON.parse(storage.data.get(BRAND_CACHE_KEY)), { v: 1, name: 'Umi Sneakers', logo_url: logo, brand_color: '#1F4B85' });
    assert.deepEqual(readCachedBrand(storage), { name: 'Umi Sneakers', logo_url: logo, brand_color: '#1F4B85' });
  });

  test('local mode caches under its own key and never touches the account cache', () => {
    assert.equal(brandCacheKey(false), BRAND_CACHE_KEY);
    assert.equal(brandCacheKey(true), LOCAL_BRAND_CACHE_KEY);
    assert.notEqual(LOCAL_BRAND_CACHE_KEY, BRAND_CACHE_KEY);
    const account = JSON.stringify({ v: 1, name: 'Umi Sneakers', logo_url: null, brand_color: '#1F4B85' });
    const storage = fakeStorage({ [BRAND_CACHE_KEY]: account });
    cacheBrand({ business_name: 'Test shop', brand_color: '#8C1D40' }, storage, brandCacheKey(true));
    assert.equal(storage.data.get(BRAND_CACHE_KEY), account);
    assert.equal(readCachedBrand(storage, LOCAL_BRAND_CACHE_KEY).name, 'Test shop');
    assert.equal(readCachedBrand(storage).name, 'Umi Sneakers');
    cacheBrand({}, storage, LOCAL_BRAND_CACHE_KEY); // unbranded local data clears only its own entry
    assert.equal(storage.data.has(LOCAL_BRAND_CACHE_KEY), false);
    assert.equal(storage.data.get(BRAND_CACHE_KEY), account);
  });

  test('an unbranded account clears the cache', () => {
    const storage = fakeStorage();
    cacheBrand({ business_name: 'Umi Sneakers' }, storage);
    cacheBrand({ business_name: 'Sizemill', logo_url: null, brand_color: null }, storage);
    assert.equal(storage.data.has(BRAND_CACHE_KEY), false);
    assert.equal(readCachedBrand(storage), null);
  });

  test('never throws, and ignores junk', () => {
    const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
    assert.doesNotThrow(() => cacheBrand({ business_name: 'Umi' }, throwing));
    assert.equal(readCachedBrand(throwing), null);
    assert.doesNotThrow(() => clearCachedBrand(throwing));
    assert.equal(readCachedBrand(null), null);
    assert.equal(readCachedBrand(fakeStorage({ [BRAND_CACHE_KEY]: '{oops' })), null);
    assert.equal(readCachedBrand(fakeStorage({ [BRAND_CACHE_KEY]: '42' })), null);
    assert.deepEqual(
      readCachedBrand(fakeStorage({ [BRAND_CACHE_KEY]: JSON.stringify({ name: 'Umi', logo_url: 'javascript:x', brand_color: 'red' }) })),
      { name: 'Umi', logo_url: null, brand_color: null },
    );
  });

  test('keeps the name and colour when a big logo does not fit', () => {
    const storage = fakeStorage();
    const setItem = storage.setItem;
    storage.setItem = (key, value) => {
      if (value.length > 200) throw new Error('QuotaExceededError');
      setItem(key, value);
    };
    cacheBrand({ business_name: 'Umi', logo_url: `data:image/png;base64,${'A'.repeat(500)}`, brand_color: '#0F6E74' }, storage);
    assert.deepEqual(readCachedBrand(storage), { name: 'Umi', logo_url: null, brand_color: '#0F6E74' });
  });
});

describe('<Logo>', () => {
  test('an image with the business name as alt text', () => {
    const out = Logo({ settings: { business_name: 'Umi Sneakers', logo_url: 'https://x/l.png#w=200&h=100' }, size: 32 });
    assert.match(out.markup, /<img/);
    assert.ok(out.values.includes('https://x/l.png'));
    assert.ok(out.values.includes('Umi Sneakers'));
    assert.ok(out.values.includes('width:64px;height:32px'));
  });

  test('a monogram without a logo, and for a very wide logo when compact', () => {
    const plain = Logo({ settings: { business_name: 'Umi Sneakers' } });
    assert.match(plain.markup, /brand-monogram|class=/);
    assert.ok(plain.values.includes('US'));
    const wide = Logo({ settings: { business_name: 'Umi Sneakers', logo_url: 'https://x/l.png#w=600&h=100' }, compact: true });
    assert.ok(wide.values.includes('US'));
    const none = Logo({ settings: {} });
    assert.ok(none.values.some((v) => String(v).includes('brand-mark')));
  });
});

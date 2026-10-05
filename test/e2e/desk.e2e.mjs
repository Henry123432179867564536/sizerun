// End-to-end check of Sizemill Desk in a real browser: `npm run e2e`.
//
// Starts the dev server (scripts/dev-server.mjs) on a free port, checks the sign-in screen, then
// drives /desk/?local=1 with Playwright through the whole journey a reseller goes through —
// settings with their own logo (a generated PNG), name and brand colour, a footballer client
// (created, then edited), a two-item sale with one item still to buy (and the leave guard on
// New sale), the drive (real /api/route and /api/fuel), marking the item bought, a deposit
// through the payment sheet then paid in full and delivered, the deal checker and its "Turn
// into a sale", stock allocated to a sale, search (a client with their orders, and an item),
// the client's lifetime and per-order profit, a drive planned on the Trips page, and the
// delete flows. Phones get list rows and a sticky save bar; laptops get tables. It runs once on a phone (390×844) and once on a laptop
// (1280×800), and revisits every screen in dark mode on a 360px phone. Any console error,
// page error, failed request to the Desk server or sideways scroll fails the run.
//
// Screenshots of every main screen go to E2E_SHOTS_DIR (default /tmp/desk-shots), named
// e2e-<pass>-<screen>.png.
//
// Needs Playwright, found locally, through NODE_PATH or in the global npm root, and a
// Chromium: Playwright's own, or the one at E2E_CHROMIUM. Network access is needed for the
// CDNs, postcodes.io, OSRM and the fuel price feeds. Not part of `npm test`: the unit test
// runner skips this file.

import { execSync } from 'node:child_process';
import { X509Certificate, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { rootCertificates } from 'node:tls';

if (process.env.NODE_TEST_CONTEXT) {
  // Picked up by `node --test` (it runs everything under test/): this is not a unit test.
  console.log('# desk.e2e.mjs is a browser test — run it with `npm run e2e`.');
  process.exit(0);
}

const SHOTS_DIR = process.env.E2E_SHOTS_DIR || '/tmp/desk-shots';
const STEP_TIMEOUT_MS = 20_000;
const NETWORK_TIMEOUT_MS = 30_000; // routes and fuel prices come from live services
const SANDBOX_CHROMIUM = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const PASSES = [
  { name: 'phone', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
  { name: 'laptop', viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false },
];

// The journey's data: a footballer client, a London home and a Southampton drop-off.
const HOME_POSTCODE = 'SW1A 1AA';
const CLIENT = {
  name: 'Jamie Okafor',
  club: 'Southampton FC',
  position: 'Winger',
  squad: '11',
  shoe: 'UK 9',
  clothing: 'M',
  addressLabel: 'Training ground',
  postcode: 'SO14 3JA',
  phone: '07700 900123',
  whatsapp: 'https://wa.me/447700900123',
};
const ITEM = { description: 'Nike Air Jordan 1 Chicago', size: 'UK 9', price: '450', expected: '300', paid: '280' };
// The same sale's second item, already bought: £40 on top of the Jordans' £150.
const ITEM2 = { description: 'Nike Tech Fleece Joggers', size: 'M', price: '110', paid: '70' };
const SALE = { profitText: '£190.00', pending: '£190', deposit: '100', balanceText: '£460.00' };
// The business's own brand: a generated PNG logo, its name and the Teal preset.
const BRAND = { name: 'Umi Sneakers', swatch: 'Teal', hex: '#0F6E74' };
const STOCK = { name: 'Adidas Predator Elite', size: 'UK 9', qty: '3', cost: '120', soldQty: '2', price: '200' };
const CHECK = { item: 'Puma Future Ultimate', sale: '200', buy: '170' };

// ---------------------------------------------------------------------------------------------
// Set-up: Playwright, a free port, the dev server
// ---------------------------------------------------------------------------------------------

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  const roots = [...(process.env.NODE_PATH ?? '').split(':').filter(Boolean)];
  try {
    roots.push(execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch {
    // npm not on PATH: rely on a local install or NODE_PATH.
  }
  for (const candidate of ['playwright', ...roots.map((root) => join(root, 'playwright'))]) {
    try {
      return require(candidate);
    } catch {
      // try the next location
    }
  }
  throw new Error('Playwright not found. Install it (npm i -g playwright) or set NODE_PATH to where it is.');
}

// Behind a TLS-inspecting proxy, Node trusts the proxy's CA through NODE_EXTRA_CA_CERTS but
// Chromium does not. Pinning those extra CAs (and routing through the same proxy) lets the
// page load its CDN scripts; with no proxy configured nothing changes.
function chromiumArgs() {
  const args = [];
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (proxy) args.push(`--proxy-server=${proxy}`, '--proxy-bypass-list=localhost;127.0.0.1');
  const bundle = process.env.NODE_EXTRA_CA_CERTS;
  if (proxy && bundle && existsSync(bundle)) {
    const normalise = (pem) => pem.replace(/\s+/g, '');
    const known = new Set(rootCertificates.map(normalise));
    const pems = readFileSync(bundle, 'utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
    const pins = new Set(
      pems
        .filter((pem) => !known.has(normalise(pem)))
        .map((pem) => createHash('sha256').update(new X509Certificate(pem).publicKey.export({ type: 'spki', format: 'der' })).digest('base64')),
    );
    if (pins.size) args.push(`--ignore-certificate-errors-spki-list=${[...pins].join(',')}`);
  }
  return args;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Small assertion and logging helpers
// ---------------------------------------------------------------------------------------------

class CheckFailed extends Error {}

function check(condition, message) {
  if (!condition) throw new CheckFailed(message);
}

function step(message) {
  console.log(`  · ${message}`);
}

const moneyPattern = /^−?£[\d,]+(\.\d\d)?$/;

function parseMoney(text) {
  const clean = String(text).trim();
  const negative = clean.startsWith('−') || clean.startsWith('-');
  const n = Number(clean.replace(/[^\d.]/g, ''));
  return negative ? -n : n;
}

/** Waits until the locator's text matches `pattern` (a RegExp or exact string); returns it. */
async function waitForText(locator, pattern, { timeout = STEP_TIMEOUT_MS, what = 'text' } = {}) {
  const deadline = Date.now() + timeout;
  let last = '';
  while (Date.now() < deadline) {
    try {
      last = (await locator.first().innerText({ timeout: 1000 })).trim();
      if (typeof pattern === 'string' ? last === pattern : pattern.test(last)) return last;
    } catch {
      // not attached yet
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new CheckFailed(`${what}: expected ${pattern} but saw ${JSON.stringify(last)}`);
}

// ---------------------------------------------------------------------------------------------
// Page helpers that know Desk's markup (ui.js components and the views)
// ---------------------------------------------------------------------------------------------

// Phones (under 640px) get list rows instead of tables and a sticky save bar on New sale.
const isPhone = (page) => page.viewportSize().width < 640;

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function stat(page, label) {
  const tile = page.locator('.stat').filter({ has: page.locator('.stat-label', { hasText: new RegExp(`^${label}$`) }) }).first();
  return { value: tile.locator('.stat-value'), sub: tile.locator('.stat-sub') };
}

/** A key figure at the top of a sale page (Profit, Margin, Owed / Paid). */
function fig(page, label) {
  const box = page.locator('.sd-fig').filter({ has: page.locator('.sd-fig-label', { hasText: new RegExp(`^${label}$`) }) }).first();
  return { value: box.locator('.sd-fig-value'), sub: box.locator('.sd-fig-sub') };
}

/** A row of the profit waterfall (ProfitBreakdown): its value cell. */
function kv(scope, label) {
  const page = typeof scope.page === 'function' ? scope.page() : scope; // `has` takes a root locator
  return scope.locator('.kv > div', { has: page.locator('dt', { hasText: new RegExp(`^${label}`) }) }).first().locator('dd');
}

function card(page, title) {
  return page.locator('.card', { has: page.locator('.card-title', { hasText: new RegExp(`^${title}$`) }) }).first();
}

/** Opens the sale page's "How it adds up" disclosure (folded on phones). */
async function openBreakdown(page) {
  const details = page.locator('details', { has: page.locator('summary', { hasText: 'How it adds up' }) }).first();
  await details.waitFor();
  if (!(await details.evaluate((node) => node.open))) await details.locator('summary').click();
  return details;
}

/** The New sale form's Save button: the sticky bar on phones, the side card on a laptop. */
function saveSaleButton(page) {
  return page.locator(isPhone(page) ? '.sf-bar' : '.ns-side-save').getByRole('button', { name: 'Save sale' });
}

async function go(page, hash) {
  await page.evaluate((target) => {
    window.location.hash = target;
  }, hash);
  await page.waitForFunction((target) => window.location.hash.startsWith(target), hash);
  await page.locator('.view .loading').waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS }).catch(() => {});
}

async function expectToast(page, pattern) {
  await waitForText(page.locator('.toast .toast-message', { hasText: pattern }), pattern, { what: 'toast' });
}

/** Types into an address box and picks the suggestion whose text matches `pick`. */
async function chooseAddress(input, query, pick) {
  await input.click();
  await input.fill('');
  await input.pressSequentially(query, { delay: 20 });
  const option = input.page().locator('[role="option"]', { hasText: pick }).first();
  await option.waitFor({ timeout: NETWORK_TIMEOUT_MS });
  await option.click();
}

/** Answers the topmost confirm dialog (a sheet may sit underneath it). */
async function confirm(page, label) {
  const dialog = page.getByRole('dialog').last();
  await dialog.getByRole('button', { name: label, exact: true }).click();
  await page.getByRole('dialog', { name: /\?$/ }).waitFor({ state: 'detached' }).catch(() => {});
}

async function dismissToasts(page) {
  for (const close of await page.locator('.toast .toast-close').all()) await close.click().catch(() => {});
}

async function shoot(page, pass, screen, problems) {
  // From the top and without toasts, so fixed bars sit where a person sees them.
  await dismissToasts(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(250); // let transitions settle
  const path = join(SHOTS_DIR, `e2e-${pass}-${screen}.png`);
  await page.screenshot({ path, fullPage: true });
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    return root.scrollWidth - root.clientWidth;
  });
  if (overflow > 0) problems.push(`${pass}/${screen}: the page scrolls sideways by ${overflow}px`);
  return path;
}

/** A small PNG logo drawn in the page (no image files in the repo). */
async function makeLogoPng(page) {
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 360;
    canvas.height = 120;
    const g = canvas.getContext('2d');
    g.fillStyle = '#0F6E74';
    g.beginPath();
    g.arc(60, 60, 50, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#FFFFFF';
    g.font = 'bold 54px sans-serif';
    g.fillText('U', 42, 80);
    g.fillStyle = '#1B2028';
    g.font = 'bold 60px sans-serif';
    g.fillText('UMI', 130, 84);
    return canvas.toDataURL('image/png');
  });
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

// ---------------------------------------------------------------------------------------------
// The journey
// ---------------------------------------------------------------------------------------------

async function settingsStep(page, pass, problems) {
  step('settings: logo (PNG upload), business name, brand colour');
  await go(page, '#/settings');
  await page.locator('input[type="file"]').setInputFiles({ name: 'umi-logo.png', mimeType: 'image/png', buffer: await makeLogoPng(page) });
  await expectToast(page, 'Logo added.');
  // The shell shows the logo straight away: the top bar on a phone, the sidebar on a laptop.
  await page.locator(isPhone(page) ? '.topbar img.brand-logo' : '.sidebar img.brand-logo').first().waitFor();
  await page.getByLabel('Business name').fill(BRAND.name);
  await page.getByRole('button', { name: BRAND.swatch, exact: true }).click();
  check((await page.getByRole('button', { name: BRAND.swatch, exact: true }).getAttribute('aria-pressed')) === 'true', 'brand swatch picked');

  step('settings: home postcode, 45 mpg, E10, £20/h');
  await chooseAddress(page.getByLabel('Home address'), HOME_POSTCODE, HOME_POSTCODE);
  await page.getByLabel(/^Fuel economy/).fill('45');
  await page.getByLabel(/^Fuel type/).selectOption('E10');
  // Save straight from a focused field: the tap must land on Save, not on the tab bar coming back.
  await page.getByLabel(/^Your hourly rate/).fill('20');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expectToast(page, 'Settings saved.');
  await waitForText(page.locator('.addr-state.is-pinned'), /On the map/, { what: 'home pinned' });

  // The brand reaches the page, and local mode caches it under its own key.
  const brand = await page.evaluate(() => ({
    signal: getComputedStyle(document.documentElement).getPropertyValue('--brand').trim().toUpperCase(),
    local: localStorage.getItem('sizemill.desk.brand.local'),
    account: localStorage.getItem('sizemill.desk.brand'),
  }));
  check(brand.signal === BRAND.hex, `--brand should be ${BRAND.hex}, got ${brand.signal}`);
  check(brand.local && JSON.parse(brand.local).name === BRAND.name, 'local mode caches its brand under sizemill.desk.brand.local');
  check(brand.account === null, 'local mode must not overwrite the account brand cache');
  await shoot(page, pass, 'settings', problems);
}

async function clientStep(page, pass, problems) {
  step(`client: ${CLIENT.name} (${CLIENT.club}) with a ${CLIENT.postcode} drop-off address`);
  await go(page, '#/clients/new');
  await page.getByLabel(/^Name/).fill(CLIENT.name);
  await page.getByLabel('Club', { exact: true }).fill(CLIENT.club);
  await page.getByLabel('Position', { exact: true }).fill(CLIENT.position);
  await page.getByLabel('Squad number', { exact: true }).fill(CLIENT.squad);
  await page.getByLabel('Shoe size', { exact: true }).fill(CLIENT.shoe);
  await page.getByLabel('Clothing size', { exact: true }).fill(CLIENT.clothing);
  await page.getByRole('button', { name: 'Add an address' }).click();
  await page.getByLabel('Label', { exact: true }).fill(CLIENT.addressLabel);
  await chooseAddress(page.getByLabel('Address or postcode'), CLIENT.postcode, CLIENT.postcode);
  await shoot(page, pass, 'client-new', problems);
  await page.getByRole('button', { name: 'Add client' }).first().click();
  await expectToast(page, `Added ${CLIENT.name}.`);
  await page.waitForFunction(() => /^#\/clients\/[0-9a-f-]{36}$/.test(window.location.hash));
  await waitForText(page.locator('main'), new RegExp(CLIENT.club), { what: 'client profile' });

  step('client: add a phone number → Call and WhatsApp');
  await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
  await page.waitForFunction(() => window.location.hash.endsWith('?edit=1'));
  await page.getByLabel(/^Phone/).fill(CLIENT.phone);
  await page.getByRole('button', { name: 'Save changes' }).first().click();
  await expectToast(page, `Saved ${CLIENT.name}.`);
  await page.waitForFunction(() => /^#\/clients\/[0-9a-f-]{36}$/.test(window.location.hash));
  const whatsapp = page.getByRole('link', { name: 'WhatsApp' });
  await whatsapp.waitFor();
  check((await whatsapp.getAttribute('href')) === CLIENT.whatsapp, `WhatsApp link should be ${CLIENT.whatsapp}`);
  await shoot(page, pass, 'client', problems);
}

async function saleStep(page, pass, problems) {
  step(`sale: 2 items — ${ITEM.description} (to buy) and ${ITEM2.description} (bought)`);
  await page.getByRole('button', { name: `New sale for ${CLIENT.name.split(' ')[0]}` }).first().click();
  await page.waitForFunction(() => window.location.hash === '#/sales/new');
  await waitForText(page.locator('.list-title', { hasText: CLIENT.name }), CLIENT.name, { what: 'client picked' });
  const first = page.locator('.repeat-block[data-item]').nth(0);
  await first.getByLabel(/^Item/).fill(ITEM.description);
  await first.getByLabel('Size', { exact: true }).fill(ITEM.size);
  await first.getByLabel(/^Sale price each/).fill(ITEM.price);
  await first.getByLabel(/^Expected cost each/).fill(ITEM.expected);

  await page.getByRole('button', { name: 'Add another item' }).click();
  const second = page.locator('.repeat-block[data-item]').nth(1);
  await second.waitFor();
  await second.getByLabel(/^Item/).fill(ITEM2.description);
  await second.getByLabel('Size', { exact: true }).fill(ITEM2.size);
  await second.getByRole('radio', { name: 'Bought' }).click();
  await second.getByLabel(/^Sale price each/).fill(ITEM2.price);
  await second.getByLabel(/^Paid each/).fill(ITEM2.paid);

  const totals = card(page, 'Totals');
  await waitForText(kv(totals, 'Profit'), SALE.profitText, { what: 'new sale profit' });
  if (isPhone(page)) {
    // Phones: the running profit and Save ride in a sticky bar above the tab bar.
    await waitForText(page.locator('.sf-bar .sf-bar-main'), new RegExp(`^Profit ${escapeRe(SALE.profitText)}`), { what: 'sticky bar profit' });
  }
  await shoot(page, pass, 'sale-new', problems);

  step('sale: leaving with unsaved work asks first (Keep editing keeps it)');
  // Done typing (the phone's tab bar steps aside while a field has focus).
  await page.evaluate(() => document.activeElement?.blur());
  await page.locator(isPhone(page) ? '.tabbar a[href="#/clients"]' : 'nav a[href="#/clients"]').first().click();
  const guard = page.getByRole('dialog', { name: 'Discard this sale?' });
  await guard.waitFor();
  await guard.getByRole('button', { name: 'Keep editing' }).click();
  await guard.waitFor({ state: 'detached' });
  check(await page.evaluate(() => window.location.hash === '#/sales/new'), 'still on New sale after Keep editing');
  check((await first.getByLabel(/^Item/).inputValue()) === ITEM.description, 'the form kept its items');

  await saveSaleButton(page).click();
  await expectToast(page, /^Sale SM-\d{4} saved\.$/);
  await page.waitForFunction(() => /^#\/sales\/[0-9a-f-]{36}$/.test(window.location.hash));
  await page.locator('.sd-line', { hasText: ITEM.description }).first().waitFor();
  check((await page.locator('.sd-line', { hasText: ITEM.description }).count()) === 1, 'first item saved');
  check((await page.locator('.sd-line', { hasText: ITEM2.description }).count()) === 1, 'second item saved');
  return page.evaluate(() => window.location.hash);
}

async function dashboardPendingStep(page, pass, problems) {
  step(`dashboard: ${SALE.pending} pending, 1 item to buy`);
  await go(page, '#/');
  await waitForText(stat(page, 'Profit pending').value, SALE.pending, { what: 'pending profit' });
  await waitForText(stat(page, 'Profit pending').sub, /1 item to buy/, { what: 'items to buy' });
  await waitForText(stat(page, 'Profit realised').value, '£0', { what: 'realised profit' });
  await waitForText(page.locator('.dash-group', { hasText: 'to buy' }), new RegExp(ITEM.description), { what: 'Needs you: to buy' });
  await shoot(page, pass, 'dashboard', problems);
}

async function driveStep(page, pass, problems, saleHash) {
  step('sale: log the drive home → training ground (live route and fuel price)');
  await go(page, saleHash);
  await page.getByRole('button', { name: 'Log drive' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  await waitForText(dialog.locator('.tp-route-line strong'), /^\d[\d.,]* mi$/, { timeout: NETWORK_TIMEOUT_MS, what: 'route miles' });
  await waitForText(dialog.locator('.tp-route-line .badge'), /OpenStreetMap|traffic-aware/, { what: 'route provider' });
  await shoot(page, pass, 'sale-log-drive', problems);
  // The fuel line sits in the folded "Car, fuel and time" group; the summary shows the price.
  await waitForText(dialog.locator('.tp-more-sub'), /E10 \d+(\.\d)?p\/L/, { timeout: NETWORK_TIMEOUT_MS, what: 'live fuel price' });
  await dialog.getByRole('button', { name: 'Save drive' }).click();
  await expectToast(page, /^Drive logged — /);
  await dialog.waitFor({ state: 'detached' });

  const breakdown = await openBreakdown(page);
  const perHour = await waitForText(kv(breakdown, 'Per driving hour'), moneyPattern, { what: '£ per driving hour' });
  const travelText = await waitForText(kv(breakdown, 'Travel'), /^−£\d+\.\d\d$/, { what: 'travel cost' });
  check(parseMoney(travelText) < 0 && parseMoney(travelText) > -100, `travel cost looks wrong: ${travelText}`);
  check(parseMoney(perHour) > 0, `£ per driving hour should be positive, got ${perHour}`);
  await waitForText(kv(breakdown, 'After your time'), moneyPattern, { what: 'after your time' });
  await waitForText(card(page, 'Drives').locator('.sd-line'), /round trip/, { what: 'drive row' });
}

async function markBoughtStep(page) {
  step(`sale: mark bought at £${ITEM.paid} → +£20.00 vs expected, confirmed`);
  await page.getByRole('button', { name: 'Mark bought' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(/^Paid each/).fill(ITEM.paid);
  await waitForText(dialog.locator('.banner'), /£20\.00 cheaper than expected\./, { what: 'variance preview' });
  await dialog.getByRole('button', { name: 'Mark bought' }).click();
  await dialog.waitFor({ state: 'detached' });
  await expectToast(page, /^Marked bought\. £20\.00 cheaper than expected\.$/);
  const breakdown = await openBreakdown(page);
  await waitForText(breakdown.locator('.kv-sub', { has: page.locator('dt', { hasText: 'vs expected' }) }).first().locator('dd'), '+£20.00', { what: 'variance vs expected' });
  await waitForText(page.locator('.sd-line', { hasText: ITEM.description }), /£20\.00 under expected/, { what: 'item variance' });
  await waitForText(fig(page, 'Profit').sub, 'Confirmed', { what: 'certainty' });
}

async function paidAndDeliveredStep(page, pass, problems) {
  step(`sale: a £${SALE.deposit} deposit through the payment sheet, then paid in full, delivered → realised`);
  await card(page, 'Payments').getByRole('button', { name: 'Record payment' }).click();
  const sheet = page.getByRole('dialog', { name: 'Record a payment' });
  await sheet.waitFor();
  await sheet.getByLabel(/^Amount/).fill(SALE.deposit);
  await sheet.getByRole('button', { name: 'Save payment' }).click();
  await sheet.waitFor({ state: 'detached' });
  await expectToast(page, `Payment of £${SALE.deposit}.00 recorded.`);
  await waitForText(fig(page, 'Owed').value, SALE.balanceText, { what: 'owed after the deposit' });

  await page.getByRole('button', { name: new RegExp(`^Paid in full · ${escapeRe(SALE.balanceText)}$`) }).click();
  await expectToast(page, `Paid in full — ${SALE.balanceText} recorded.`);
  await page.getByLabel('Sale status').selectOption('delivered');
  await expectToast(page, /^SM-\d{4} is now delivered\.$/);
  await waitForText(page.locator('.sd-reason').first(), /^Realised: delivered, paid and every cost confirmed\.$/, { what: 'bucket' });
  await waitForText(fig(page, 'Paid').sub, 'In full', { what: 'paid in full' });
  const profit = await waitForText(fig(page, 'Profit').value, moneyPattern, { what: 'sale profit' });
  await shoot(page, pass, 'sale', problems);

  await go(page, '#/');
  const realised = await waitForText(stat(page, 'Profit realised').value, /^£\d+$/, { what: 'realised profit' });
  check(Math.abs(parseMoney(realised) - parseMoney(profit)) <= 0.5, `dashboard realised ${realised} should match the sale's ${profit}`);
  await waitForText(stat(page, 'Profit pending').value, '£0', { what: 'pending after delivery' });
  await waitForText(stat(page, '£ per driving hour').value, moneyPattern, { what: 'dashboard £ per driving hour' });
  await shoot(page, pass, 'dashboard-realised', problems);
  return parseMoney(profit);
}

async function checkerStep(page, pass, problems) {
  step(`deal checker: sell £${CHECK.sale}, buy £${CHECK.buy}, drive to ${CLIENT.postcode}`);
  await go(page, '#/check');
  await page.getByRole('button', { name: 'Start again' }).click();
  await page.getByLabel(/^What is it\?/).fill(CHECK.item);
  await page.getByLabel(/^Sale price/).fill(CHECK.sale);
  await page.getByLabel(/^Buy price/).fill(CHECK.buy);
  await chooseAddress(page.getByLabel('To', { exact: true }), CLIENT.postcode, CLIENT.postcode);
  await waitForText(page.locator('.tp-route-line strong'), /^\d[\d.,]* mi$/, { timeout: NETWORK_TIMEOUT_MS, what: 'checker route' });
  await waitForText(page.locator('.tp-more-sub'), /E10 \d+(\.\d)?p\/L/, { timeout: NETWORK_TIMEOUT_MS, what: 'checker fuel price' });
  const verdict = await waitForText(
    page.locator('.check-result .banner-title'),
    /^(Good deal|Tight — think twice|Losing money)$/,
    { what: 'verdict' },
  );
  // £30 of margin can't cover 160-odd miles of fuel plus nearly four hours at £20/h.
  check(verdict !== 'Good deal', `a £30 margin with a Southampton round trip should not be a good deal (got ${verdict})`);
  await waitForText(page.locator('.check-result'), /Break-even/, { what: 'prices that work' });
  await shoot(page, pass, 'check', problems);

  step('deal checker: turn into a sale (prefilled item and drive)');
  await page.getByRole('button', { name: 'Turn into a sale' }).click();
  await page.waitForFunction(() => window.location.hash === '#/sales/new');
  await waitForText(page.locator('.banner-title'), 'Filled in from the deal checker', { what: 'prefill banner' });
  check((await page.getByLabel(/^Item/).inputValue()) === CHECK.item, 'prefilled description');
  check((await page.getByLabel(/^Sale price each/).inputValue()) === CHECK.sale, 'prefilled sale price');
  check((await page.getByLabel(/^Expected cost each/).inputValue()) === CHECK.buy, 'prefilled expected cost');
  await waitForText(page.locator('form'), /round trip/, { what: 'prefilled drive' });
  await page.locator('.list-item', { hasText: CLIENT.name }).first().click();
  await saveSaleButton(page).click();
  await expectToast(page, /^Sale SM-\d{4} saved\.$/);
  await page.waitForFunction(() => /^#\/sales\/[0-9a-f-]{36}$/.test(window.location.hash));
  await waitForText(card(page, 'Drives').locator('.sd-line'), /round trip/, { what: 'drive saved from the checker' });
}

async function stockStep(page, pass, problems) {
  step(`stock: add ${STOCK.qty} × ${STOCK.name}, sell ${STOCK.soldQty} from stock`);
  await go(page, '#/stock');
  await page.getByRole('button', { name: 'Add stock' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(/^Item/).fill(STOCK.name);
  await dialog.getByLabel('Size', { exact: true }).fill(STOCK.size);
  await dialog.getByLabel(/^Quantity/).fill(STOCK.qty);
  await dialog.getByLabel(/^Cost each/).fill(STOCK.cost);
  await dialog.getByRole('button', { name: 'Add to stock' }).click();
  await expectToast(page, `Added ${STOCK.name} to stock.`);
  await waitForText(stat(page, 'Units on hand').value, STOCK.qty, { what: 'units on hand' });

  await go(page, '#/sales/new');
  await page.locator('.list-item', { hasText: CLIENT.name }).first().click();
  await page.getByRole('radio', { name: 'From stock' }).click();
  const choice = page.getByLabel(/^Stock item/);
  const value = await choice.locator('option', { hasText: STOCK.name }).getAttribute('value');
  await choice.selectOption(value);
  check((await page.getByLabel(/^Item/).inputValue()) === STOCK.name, 'stock line fills the description');
  await page.getByLabel(/^Qty/).fill(STOCK.soldQty);
  await page.getByLabel(/^Sale price each/).fill(STOCK.price);
  await saveSaleButton(page).click();
  await expectToast(page, /^Sale SM-\d{4} saved\.$/);
  await page.waitForFunction(() => /^#\/sales\/[0-9a-f-]{36}$/.test(window.location.hash));
  const stockSale = await page.evaluate(() => window.location.hash);

  await go(page, '#/stock');
  await waitForText(stat(page, 'Units on hand').value, '1', { what: 'on hand after the sale' });
  if (isPhone(page)) {
    // Phones: one row per line, with "1 on hand · 2 on sales" as its meta line.
    const row = page.locator('ul.lr-list .lr', { hasText: STOCK.name });
    await waitForText(row.locator('.lr-meta'), `1 on hand · ${STOCK.soldQty} on sales`, { what: 'allocated (meta line)' });
    await waitForText(row.locator('.lr-sub'), new RegExp(STOCK.size), { what: 'stock row size' });
  } else {
    const row = page.locator('tbody tr', { hasText: STOCK.name });
    await waitForText(row.locator('td[data-label="Allocated"]'), STOCK.soldQty, { what: 'allocated' });
  }
  await shoot(page, pass, 'stock', problems);
  return stockSale;
}

async function searchStep(page, pass, problems) {
  step(`search: "${CLIENT.name.split(' ')[1]}" finds the client and their orders; "Jordan" finds the item`);
  await go(page, '#/search');
  const box = page.getByLabel('Search clients, items and sales');
  await box.fill(CLIENT.name.split(' ')[1]);
  const clients = page.locator('#sr-clients');
  await waitForText(clients.locator('.sr-cmain').first(), new RegExp(CLIENT.name), { what: 'client found' });
  // A single matching client opens on its own; otherwise expand its orders.
  const toggle = clients.getByRole('button', { name: new RegExp(`^(Show|Hide) 3 orders for ${CLIENT.name}$`) });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await page.waitForFunction(() => document.querySelector('#sr-clients .sr-toggle')?.getAttribute('aria-expanded') === 'true');
  const orders = clients.locator('.sr-drop a.sr-row');
  await orders.first().waitFor();
  check((await orders.count()) === 3, `the client's 3 orders should show, saw ${await orders.count()}`);
  await shoot(page, pass, 'search-client', problems);

  await box.fill('Jordan');
  const items = page.locator('#sr-items');
  await waitForText(items, new RegExp(ITEM.description), { what: 'item found' });
  await shoot(page, pass, 'search-item', problems);
}

async function listsStep(page, pass, problems, firstProfit) {
  step('lists: sales, clients, trips');
  await go(page, '#/sales');
  await waitForText(page.locator('.card-title'), /^3 sales$/, { what: 'sales count' });
  if (isPhone(page)) {
    await page.locator('a.sale-row').first().waitFor();
    check((await page.locator('a.sale-row').count()) === 3, 'phones list sales as rows');
    check(await page.locator('.sales-table').isHidden(), 'no sales table on a phone');
  } else {
    await page.locator('.sales-table tbody tr').first().waitFor();
  }
  await shoot(page, pass, 'sales', problems);

  await go(page, '#/clients');
  if (isPhone(page)) await waitForText(page.locator('ul.lr-list'), new RegExp(CLIENT.name), { what: 'clients list' });
  else await waitForText(page.locator('tbody'), new RegExp(CLIENT.name), { what: 'clients table' });
  await shoot(page, pass, 'clients', problems);

  step('client profile: lifetime profit and average profit per order');
  await page.locator(isPhone(page) ? 'ul.lr-list a' : 'tbody tr', { hasText: CLIENT.name }).first().click();
  await page.waitForFunction(() => /^#\/clients\/[0-9a-f-]{36}$/.test(window.location.hash));
  await waitForText(stat(page, 'Orders').value, '3', { what: 'orders' });
  // Values read like "£342.90 est." while some costs are still estimates.
  const leadingMoney = (text) => parseMoney(text.match(/^−?£[\d,]+\.\d\d/)[0]);
  const lifetime = leadingMoney(await waitForText(stat(page, 'Lifetime profit').value, /^−?£[\d,]+\.\d\d/, { what: 'lifetime profit' }));
  const average = leadingMoney(await waitForText(stat(page, 'Avg profit per order').value, /^−?£[\d,]+\.\d\d/, { what: 'avg profit per order' }));
  check(Math.abs(average - lifetime / 3) <= 0.01, `avg per order ${average} should be lifetime ${lifetime} ÷ 3`);
  check(lifetime > firstProfit, `lifetime profit ${lifetime} should include the first sale's ${firstProfit} and more`);
  await waitForText(stat(page, 'Avg profit per order').sub, /^\d+ items across 3 orders$/, { what: 'items across orders' });

  step('trips: plan and save a drive to the client from the Trips page');
  await go(page, '#/trips');
  await waitForText(stat(page, 'Trips').value, '2', { what: 'trips count' });
  const planner = page.locator('.trips-planner');
  await planner.getByLabel('Client', { exact: true }).selectOption({ label: `${CLIENT.name} · ${CLIENT.club}` });
  await waitForText(planner.locator('.tp-route-line strong'), /^\d[\d.,]* mi$/, { timeout: NETWORK_TIMEOUT_MS, what: 'trips page route' });
  await waitForText(planner.locator('.tp-fuel-note, .tp-more-sub').first(), /Median of|UK average|E10 \d/, { timeout: NETWORK_TIMEOUT_MS, what: 'trips page fuel price' });
  await planner.getByLabel('Name it').fill('Kit drop at the training ground');
  await planner.getByRole('button', { name: 'Save trip' }).click();
  await expectToast(page, /^Trip saved — £\d+\.\d\d cash cost\.$/);
  await waitForText(stat(page, 'Trips').value, '3', { what: 'trips after saving' });
  await waitForText(page.locator(isPhone(page) ? 'ul.lr-list' : 'tbody').first(), /Kit drop at the training ground/, { what: 'saved trip in the list' });
  await shoot(page, pass, 'trips', problems);
}

async function deleteStep(page, pass, problems, stockSale) {
  step('delete: the stock sale (stock comes back), the stock line, a trip, the client');
  await go(page, stockSale);
  await page.getByRole('button', { name: 'Delete sale' }).click();
  await confirm(page, 'Delete sale');
  await page.waitForFunction(() => window.location.hash === '#/sales');
  await go(page, '#/stock');
  await waitForText(stat(page, 'Units on hand').value, STOCK.qty, { what: 'stock back after deleting the sale' });
  if (isPhone(page)) {
    // Phones: the row opens the editor sheet, which holds Delete.
    await page.getByRole('button', { name: `Edit ${STOCK.name}` }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  } else {
    await page.getByRole('button', { name: `Delete ${STOCK.name}` }).click();
  }
  await confirm(page, 'Delete');
  await expectToast(page, `Deleted ${STOCK.name}.`);
  await waitForText(page.locator('.empty-title'), 'No stock yet', { what: 'stock emptied' });

  await go(page, '#/trips');
  if (isPhone(page)) {
    await page.getByRole('button', { name: /^Edit trip Kit drop/ }).click();
    await page.locator('.trips-planner').getByRole('button', { name: 'Delete', exact: true }).click();
  } else {
    await page.getByRole('button', { name: /^Delete trip / }).first().click();
  }
  await confirm(page, 'Delete trip');
  await expectToast(page, 'Trip deleted.');
  await waitForText(stat(page, 'Trips').value, '2', { what: 'trips after delete' });

  await go(page, '#/clients');
  await page.locator(isPhone(page) ? 'ul.lr-list a' : 'tbody tr', { hasText: CLIENT.name }).first().click();
  await page.waitForFunction(() => /^#\/clients\/[0-9a-f-]{36}$/.test(window.location.hash));
  await page.getByRole('button', { name: 'Delete client' }).click();
  await confirm(page, 'Delete client');
  await expectToast(page, `Deleted ${CLIENT.name}.`);
  await page.waitForFunction(() => window.location.hash === '#/clients');
  await go(page, '#/sales');
  await waitForText(page.locator('.card-title'), /^2 sales$/, { what: 'sales kept after deleting their client' });
  await waitForText(page.locator(isPhone(page) ? '.sales-rows' : '.sales-table tbody'), /No client/, { what: 'sales unlinked from the deleted client' });
}

// ---------------------------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------------------------

function watch(page, baseUrl, errors) {
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`page error: ${error.message}`));
  page.on('requestfailed', (request) => {
    // ERR_ABORTED is a cancellation, not a failure: e.g. Chrome's background revalidation of a
    // stale-while-revalidate /api/fuel answer it has already served from cache.
    const reason = request.failure()?.errorText ?? '';
    if (request.url().startsWith(baseUrl) && reason !== 'net::ERR_ABORTED') errors.push(`request failed: ${request.url()} (${reason})`);
  });
  page.on('response', (response) => {
    if (response.url().startsWith(baseUrl) && response.status() >= 400) {
      errors.push(`HTTP ${response.status()} from ${response.url()}`);
    }
  });
}

async function openDesk(context, baseUrl, errors) {
  const page = await context.newPage();
  page.setDefaultTimeout(STEP_TIMEOUT_MS);
  watch(page, baseUrl, errors);
  await page.goto(`${baseUrl}/desk/?local=1#/`);
  await page.locator('#boot').waitFor({ state: 'detached' });
  return page;
}

// The account (Supabase) mode up to its sign-in screen: no account is created or used.
async function signInScreenStep(context, baseUrl, pass, errors, problems) {
  step('sign-in screen: /desk redirects to /desk/, empty form explains itself');
  const page = await context.newPage();
  watch(page, baseUrl, errors);
  await page.goto(`${baseUrl}/desk`);
  await page.waitForURL(`${baseUrl}/desk/`);
  await waitForText(page.locator('.auth-title'), 'Sign in', { what: 'sign-in heading' });
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await waitForText(page.locator('.auth .banner'), 'Enter your email address.', { what: 'sign-in validation' });
  await shoot(page, pass, 'sign-in', problems);
  await page.close();
}

async function runJourney(browser, baseUrl, pass) {
  console.log(`\n${pass.name} (${pass.viewport.width}×${pass.viewport.height})`);
  const errors = [];
  const problems = [];
  const context = await browser.newContext({
    viewport: pass.viewport,
    isMobile: pass.isMobile,
    hasTouch: pass.hasTouch,
    locale: 'en-GB',
    timezoneId: 'Europe/London',
    colorScheme: 'light',
  });
  await signInScreenStep(context, baseUrl, pass.name, errors, problems);
  check(errors.length === 0, `browser errors:\n    ${errors.join('\n    ')}`);
  const page = await openDesk(context, baseUrl, errors);
  // Runs one step; on failure saves a screenshot of where it stopped. Browser errors raised
  // during the step fail it too. Resolves with the step's own result.
  const guard = async (run) => {
    let result;
    try {
      result = await run();
    } catch (error) {
      const path = join(SHOTS_DIR, `e2e-${pass.name}-FAILED.png`);
      await page.screenshot({ path, fullPage: true }).catch(() => {});
      error.message += `\n    (screenshot: ${path}, at ${page.url()})`;
      throw error;
    }
    check(errors.length === 0, `browser errors:\n    ${errors.join('\n    ')}`);
    return result;
  };

  await guard(() => settingsStep(page, pass.name, problems));
  await guard(() => clientStep(page, pass.name, problems));
  const saleHash = await guard(() => saleStep(page, pass.name, problems));
  await guard(() => dashboardPendingStep(page, pass.name, problems));
  await guard(() => driveStep(page, pass.name, problems, saleHash));
  await guard(() => markBoughtStep(page));
  const firstProfit = await guard(() => paidAndDeliveredStep(page, pass.name, problems));
  await guard(() => checkerStep(page, pass.name, problems));
  const stockSale = await guard(() => stockStep(page, pass.name, problems));
  await guard(() => searchStep(page, pass.name, problems));
  await guard(() => listsStep(page, pass.name, problems, firstProfit));
  // Kept for the dark-mode pass: the data as it stands before the deletes.
  const storage = await context.storageState();
  await guard(() => deleteStep(page, pass.name, problems, stockSale));
  await dismissToasts(page);
  await context.close();
  return { problems, storage };
}

const DARK_SCREENS = [
  ['dashboard', '#/'],
  ['sales', '#/sales'],
  ['clients', '#/clients'],
  ['stock', '#/stock'],
  ['trips', '#/trips'],
  ['check', '#/check'],
  ['settings', '#/settings'],
];

// Dark mode on the narrowest phone Desk supports (360px), with the phone pass's data.
const DARK_PASS = { name: 'dark-360', viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true };

async function runDark(browser, baseUrl, storage) {
  const { name, viewport, isMobile, hasTouch } = DARK_PASS;
  console.log(`\n${name} (${viewport.width}×${viewport.height})`);
  const errors = [];
  const problems = [];
  const context = await browser.newContext({
    viewport,
    isMobile,
    hasTouch,
    locale: 'en-GB',
    timezoneId: 'Europe/London',
    colorScheme: 'dark',
    storageState: storage,
  });
  const page = await openDesk(context, baseUrl, errors);
  for (const [screen, hash] of DARK_SCREENS) {
    step(`dark: ${screen}`);
    await go(page, hash);
    await page.locator('.page').first().waitFor();
    await shoot(page, name, screen, problems);
  }
  await go(page, '#/sales');
  await page.locator('a.sale-row').first().click();
  await page.waitForFunction(() => /^#\/sales\/[0-9a-f-]{36}$/.test(window.location.hash));
  await waitForText(fig(page, 'Profit').value, moneyPattern, { what: 'dark sale page' });
  await shoot(page, name, 'sale', problems);
  await go(page, '#/clients');
  await page.locator('ul.lr-list a').first().click();
  await page.waitForFunction(() => /^#\/clients\/[0-9a-f-]{36}$/.test(window.location.hash));
  await page.locator('.page').first().waitFor();
  await shoot(page, name, 'client', problems);
  check(errors.length === 0, `browser errors:\n    ${errors.join('\n    ')}`);
  await context.close();
  return { problems };
}

async function main() {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const { chromium } = loadPlaywright();
  const executablePath = process.env.E2E_CHROMIUM || (existsSync(SANDBOX_CHROMIUM) ? SANDBOX_CHROMIUM : undefined);
  const { startDevServer } = await import('../../scripts/dev-server.mjs');
  const port = Number(process.env.E2E_PORT) || (await freePort());
  // Local mode has no account, so the dev server must stand in for Supabase Auth (it only does
  // when no real credentials are configured) for /api/route and /api/places to answer.
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  const server = await startDevServer({ port, log: false });
  const browser = await chromium.launch({ executablePath, args: chromiumArgs() });
  console.log(`Desk e2e against ${server.url}/desk/?local=1 — screenshots in ${SHOTS_DIR}`);

  const problems = [];
  let failed = null;
  try {
    // E2E_ONLY=phone or E2E_ONLY=laptop runs one pass (the dark pass follows the phone's).
    const only = (process.env.E2E_ONLY ?? '').split(',').filter(Boolean);
    for (const pass of PASSES.filter((entry) => !only.length || only.includes(entry.name))) {
      const result = await runJourney(browser, server.url, pass);
      problems.push(...result.problems);
      if (pass.isMobile) problems.push(...(await runDark(browser, server.url, result.storage)).problems);
    }
    check(problems.length === 0, `layout problems:\n    ${problems.join('\n    ')}`);
  } catch (error) {
    failed = error;
  } finally {
    await browser.close();
    await server.close();
  }

  if (failed) {
    console.error(`\nFAIL: ${failed instanceof CheckFailed ? failed.message : failed.stack ?? failed}`);
    process.exit(1);
  }
  const ran = (process.env.E2E_ONLY ?? '').split(',').filter(Boolean);
  console.log(ran.length
    ? `\nPASS: the Desk journey works (${ran.join(', ')}${ran.includes('phone') ? ', dark-360' : ''}).`
    : '\nPASS: the Desk journey works on a phone and a laptop, in light and dark mode.');
}

await main();

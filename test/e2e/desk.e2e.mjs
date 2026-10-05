// End-to-end check of Sizemill Desk in a real browser: `npm run e2e`.
//
// Starts the dev server (scripts/dev-server.mjs) on a free port, checks the sign-in screen, then
// drives /desk/?local=1 with Playwright through the whole journey a reseller goes through —
// settings, a footballer client (created, then edited), a sale with an item still to buy, the
// drive (real /api/route and /api/fuel), marking the item bought, getting paid and delivering,
// the deal checker and its "Turn into a sale", stock allocated to a sale, a drive planned on the
// Trips page, and the delete flows. It runs once on a phone (390×844) and once on a laptop
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
// Page helpers that know Desk's markup (ui.js components)
// ---------------------------------------------------------------------------------------------

function stat(page, label) {
  const tile = page.locator('.stat').filter({ has: page.locator('.stat-label', { hasText: new RegExp(`^${label}$`) }) }).first();
  return { value: tile.locator('.stat-value'), sub: tile.locator('.stat-sub') };
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

async function confirm(page, label) {
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: label, exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
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

// ---------------------------------------------------------------------------------------------
// The journey
// ---------------------------------------------------------------------------------------------

async function settingsStep(page, pass, problems) {
  step('settings: home postcode, 45 mpg, E10, £20/h');
  await go(page, '#/settings');
  await chooseAddress(page.getByLabel('Home address'), HOME_POSTCODE, HOME_POSTCODE);
  await page.getByLabel(/^Fuel economy/).fill('45');
  await page.getByLabel(/^Fuel type/).selectOption('E10');
  await page.getByLabel(/^Your hourly rate/).fill('20');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expectToast(page, 'Settings saved.');
  await waitForText(page.locator('.field-hint', { hasText: 'Pinned on the map' }), /Pinned on the map/, { what: 'home pinned' });
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
  step(`sale: ${ITEM.description}, sell £${ITEM.price}, still to buy at £${ITEM.expected}`);
  await page.getByRole('button', { name: `New sale for ${CLIENT.name.split(' ')[0]}` }).first().click();
  await page.waitForFunction(() => window.location.hash === '#/sales/new');
  await waitForText(page.locator('.list-title', { hasText: CLIENT.name }), CLIENT.name, { what: 'client picked' });
  await page.getByLabel(/^Description/).fill(ITEM.description);
  await page.getByLabel('Size', { exact: true }).fill(ITEM.size);
  await page.getByLabel(/^Sale price each/).fill(ITEM.price);
  await page.getByLabel(/^Expected cost each/).fill(ITEM.expected);
  const totals = page.locator('.card', { has: page.locator('.card-title', { hasText: 'Totals' }) });
  await waitForText(totals.locator('.kv-total', { hasText: 'Profit' }).locator('dd'), '£150.00', { what: 'new sale profit' });
  await shoot(page, pass, 'sale-new', problems);
  await page.getByRole('button', { name: 'Save sale' }).click();
  await expectToast(page, /^Sale SM-\d{4} saved\.$/);
  await page.waitForFunction(() => /^#\/sales\/[0-9a-f-]{36}$/.test(window.location.hash));
  return page.evaluate(() => window.location.hash);
}

async function dashboardPendingStep(page, pass, problems) {
  step('dashboard: £150 pending, 1 item to buy');
  await go(page, '#/');
  await waitForText(stat(page, 'Profit pending').value, '£150', { what: 'pending profit' });
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

  const perHour = await waitForText(stat(page, 'Per driving hour').value, moneyPattern, { what: '£ per driving hour' });
  const travel = page.locator('.kv > div', { has: page.locator('dt', { hasText: /^Travel/ }) }).first().locator('dd');
  const travelText = await waitForText(travel, /^−£\d+\.\d\d$/, { what: 'travel cost' });
  check(parseMoney(travelText) < 0 && parseMoney(travelText) > -100, `travel cost looks wrong: ${travelText}`);
  check(parseMoney(perHour) > 0, `£ per driving hour should be positive, got ${perHour}`);
  await waitForText(stat(page, 'After your time').value, moneyPattern, { what: 'after your time' });
  await waitForText(page.locator('.card', { hasText: 'Drives' }).locator('tbody tr'), /round trip/, { what: 'drive row' });
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
  const vsExpected = page.locator('.kv-sub', { has: page.locator('dt', { hasText: 'vs expected' }) }).first().locator('dd');
  await waitForText(vsExpected, '+£20.00', { what: 'variance vs expected' });
  await waitForText(page.locator('td[data-label="Cost each"]'), /£20\.00 under expected/, { what: 'item variance' });
  await waitForText(stat(page, 'Profit').sub, 'Confirmed', { what: 'certainty' });
}

async function paidAndDeliveredStep(page, pass, problems) {
  step('sale: paid in full, delivered → realised');
  await page.getByRole('button', { name: /^Paid in full · £450\.00$/ }).click();
  await expectToast(page, 'Paid in full — £450.00 recorded.');
  await page.getByLabel('Sale status').selectOption('delivered');
  await expectToast(page, /^SM-\d{4} is now delivered\.$/);
  const profitCard = page.locator('.card', { has: page.locator('.card-title', { hasText: /^Profit$/ }) });
  await waitForText(profitCard.locator('.card-head .badge'), 'Realised', { what: 'bucket' });
  const profit = await waitForText(stat(page, 'Profit').value, moneyPattern, { what: 'sale profit' });
  await shoot(page, pass, 'sale', problems);

  await go(page, '#/');
  const realised = await waitForText(stat(page, 'Profit realised').value, /^£\d+$/, { what: 'realised profit' });
  check(Math.abs(parseMoney(realised) - parseMoney(profit)) <= 0.5, `dashboard realised ${realised} should match the sale's ${profit}`);
  await waitForText(stat(page, 'Profit pending').value, '£0', { what: 'pending after delivery' });
  await waitForText(stat(page, '£ per driving hour').value, moneyPattern, { what: 'dashboard £ per driving hour' });
  await shoot(page, pass, 'dashboard-realised', problems);
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
  check((await page.getByLabel(/^Description/).inputValue()) === CHECK.item, 'prefilled description');
  check((await page.getByLabel(/^Sale price each/).inputValue()) === CHECK.sale, 'prefilled sale price');
  check((await page.getByLabel(/^Expected cost each/).inputValue()) === CHECK.buy, 'prefilled expected cost');
  await waitForText(page.locator('form'), /round trip/, { what: 'prefilled drive' });
  await page.locator('.list-item', { hasText: CLIENT.name }).first().click();
  await page.getByRole('button', { name: 'Save sale' }).click();
  await expectToast(page, /^Sale SM-\d{4} saved\.$/);
  await page.waitForFunction(() => /^#\/sales\/[0-9a-f-]{36}$/.test(window.location.hash));
  await waitForText(page.locator('.card', { hasText: 'Drives' }).locator('tbody tr'), /round trip/, { what: 'drive saved from the checker' });
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
  check((await page.getByLabel(/^Description/).inputValue()) === STOCK.name, 'stock line fills the description');
  await page.getByLabel(/^Qty/).fill(STOCK.soldQty);
  await page.getByLabel(/^Sale price each/).fill(STOCK.price);
  await page.getByRole('button', { name: 'Save sale' }).click();
  await expectToast(page, /^Sale SM-\d{4} saved\.$/);
  await page.waitForFunction(() => /^#\/sales\/[0-9a-f-]{36}$/.test(window.location.hash));
  const stockSale = await page.evaluate(() => window.location.hash);

  await go(page, '#/stock');
  const row = page.locator('tbody tr', { hasText: STOCK.name });
  await waitForText(stat(page, 'Units on hand').value, '1', { what: 'on hand after the sale' });
  await waitForText(row.locator('td[data-label="Allocated"]'), STOCK.soldQty, { what: 'allocated' });
  await shoot(page, pass, 'stock', problems);
  return stockSale;
}

async function listsStep(page, pass, problems) {
  step('lists: sales, clients, trips');
  await go(page, '#/sales');
  await waitForText(page.locator('.card-title'), /^3 sales$/, { what: 'sales count' });
  await shoot(page, pass, 'sales', problems);
  await go(page, '#/clients');
  await waitForText(page.locator('tbody'), new RegExp(CLIENT.name), { what: 'clients list' });
  await shoot(page, pass, 'clients', problems);
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
  await waitForText(page.locator('tbody'), /Kit drop at the training ground/, { what: 'saved trip in the list' });
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
  await page.getByRole('button', { name: `Delete ${STOCK.name}` }).click();
  await confirm(page, 'Delete');
  await expectToast(page, `Deleted ${STOCK.name}.`);
  await waitForText(page.locator('.empty-title'), 'No stock yet', { what: 'stock emptied' });

  await go(page, '#/trips');
  await page.getByRole('button', { name: /^Delete trip / }).first().click();
  await confirm(page, 'Delete trip');
  await expectToast(page, 'Trip deleted.');
  await waitForText(stat(page, 'Trips').value, '2', { what: 'trips after delete' });

  await go(page, '#/clients');
  await page.locator('tbody tr', { hasText: CLIENT.name }).first().click();
  await page.waitForFunction(() => /^#\/clients\/[0-9a-f-]{36}$/.test(window.location.hash));
  await page.getByRole('button', { name: 'Delete client' }).click();
  await confirm(page, 'Delete client');
  await expectToast(page, `Deleted ${CLIENT.name}.`);
  await page.waitForFunction(() => window.location.hash === '#/clients');
  await go(page, '#/sales');
  await waitForText(page.locator('.card-title'), /^2 sales$/, { what: 'sales kept after deleting their client' });
  await waitForText(page.locator('tbody'), /No client/, { what: 'sales unlinked from the deleted client' });
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
  await guard(() => paidAndDeliveredStep(page, pass.name, problems));
  await guard(() => checkerStep(page, pass.name, problems));
  const stockSale = await guard(() => stockStep(page, pass.name, problems));
  await guard(() => listsStep(page, pass.name, problems));
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
  await page.locator('tbody tr').first().click();
  await page.waitForFunction(() => /^#\/sales\/[0-9a-f-]{36}$/.test(window.location.hash));
  await waitForText(stat(page, 'Profit').value, moneyPattern, { what: 'dark sale page' });
  await shoot(page, name, 'sale', problems);
  await go(page, '#/clients');
  await page.locator('tbody tr').first().click();
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
    for (const pass of PASSES) {
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
  console.log('\nPASS: the Desk journey works on a phone and a laptop, in light and dark mode.');
}

await main();

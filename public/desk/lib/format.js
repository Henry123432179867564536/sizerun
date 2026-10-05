// Sizemill Desk display formatters: GBP, miles, durations and en-GB dates.
//
// Pure ES module (no DOM, no imports) so the browser and the Node tests share it.
// Every formatter returns '—' for a missing or non-numeric value, so a blank never shows
// as £0.00. Negatives use the true minus sign (U+2212), and anything that rounds to zero
// is shown unsigned (never '−£0.00').

const DASH = '—';
const MINUS = '\u2212'; // true minus sign, not a hyphen
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MS_PER_DAY = 86_400_000;

// ---- helpers ---------------------------------------------------------------------------

// A finite number from a number or numeric string; null for anything else (including '').
function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// Round a non-negative value half-up to `dp` places. The EPSILON nudge makes binary
// near-halves such as 1.005 round the way people expect (1.01).
function roundTo(value, dp) {
  const factor = 10 ** dp;
  const scaled = (value + Number.EPSILON) * factor;
  // Past 2^53 units a double has no fractional digits left; rounding would only add error.
  return scaled < Number.MAX_SAFE_INTEGER ? Math.round(scaled) / factor : value;
}

const groupedFormats = new Map();
// en-GB digit grouping with exactly `dp` decimal places.
function grouped(value, dp) {
  let format = groupedFormats.get(dp);
  if (!format) {
    format = new Intl.NumberFormat('en-GB', { minimumFractionDigits: dp, maximumFractionDigits: dp });
    groupedFormats.set(dp, format);
  }
  return format.format(value);
}

// Sign prefix for an already-rounded magnitude: nothing for zero, '−' for negatives,
// '+' for positives only when asked.
function signOf(value, roundedAbs, plus = false) {
  if (roundedAbs === 0) return '';
  if (value < 0) return MINUS;
  return plus ? '+' : '';
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// Milliseconds at UTC midnight of a calendar day. setUTCFullYear keeps years below 100
// literal (Date.UTC would map them to 19xx).
function utcDay(y, m, d) {
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  return t.getTime();
}

function fromDate(date) {
  if (Number.isNaN(date.getTime())) return null;
  return { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() };
}

// Calendar day { y, m, d } from:
//  - 'YYYY-MM-DD' — a calendar date, used as-is (never shifted by time zone);
//  - an ISO timestamp ('YYYY-MM-DDTHH:MM…') — the local day of that instant;
//  - a Date — its local day.
// Anything else, or an impossible date such as 2026-02-30, gives null.
function calendarDay(v) {
  if (v instanceof Date) return fromDate(v);
  if (typeof v !== 'string') return null;
  const s = v.trim();
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (dateOnly) {
    const [y, m, d] = dateOnly.slice(1).map(Number);
    const check = new Date(utcDay(y, m, d));
    const valid = check.getUTCFullYear() === y && check.getUTCMonth() === m - 1 && check.getUTCDate() === d;
    return valid ? { y, m, d } : null;
  }
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s)) return fromDate(new Date(s));
  return null;
}

// ---- money and numbers -----------------------------------------------------------------

// '£1,234.50', '−£12.00', '+£5.00' with { sign: true }, '£1,235' with { pence: false }.
export function money(n, options = {}) {
  const { sign = false, pence = true } = options ?? {};
  const value = toNumber(n);
  if (value === null) return DASH;
  const dp = pence ? 2 : 0;
  const abs = roundTo(Math.abs(value), dp);
  return `${signOf(value, abs, sign)}£${grouped(abs, dp)}`;
}

// '£12.3k' / '£1.3m' from £10,000 up (a trailing '.0' dropped), otherwise whole pounds.
export function moneyShort(n) {
  const value = toNumber(n);
  if (value === null) return DASH;
  const abs = Math.abs(value);
  if (roundTo(abs, 0) < 10_000) return money(value, { pence: false });
  let scaled = roundTo(abs / 1_000, 1);
  let unit = 'k';
  if (scaled >= 1_000) {
    scaled = roundTo(abs / 1_000_000, 1);
    unit = 'm';
  }
  return `${signOf(value, scaled)}£${grouped(scaled, 1).replace(/\.0$/, '')}${unit}`;
}

// 0.253 -> '25%'.
export function pct(r) {
  const value = toNumber(r);
  if (value === null) return DASH;
  const whole = roundTo(Math.abs(value) * 100, 0);
  return `${signOf(value, whole)}${grouped(whole, 0)}%`;
}

// '160 mi'; one decimal place under 10 miles ('9.4 mi').
export function miles(n) {
  const value = toNumber(n);
  if (value === null) return DASH;
  const abs = Math.abs(value);
  const tenths = roundTo(abs, 1);
  // Decide on the rounded value so 9.96 becomes '10 mi', not '10.0 mi'.
  const dp = tenths < 10 ? 1 : 0;
  const rounded = dp ? tenths : roundTo(abs, 0);
  return `${signOf(value, rounded)}${grouped(rounded, dp)} mi`;
}

// Minutes -> '3h 40m', '2h', '45m'.
export function duration(min) {
  const value = toNumber(min);
  if (value === null) return DASH;
  const total = roundTo(Math.abs(value), 0);
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  let text;
  if (hours === 0) text = `${minutes}m`;
  else if (minutes === 0) text = `${hours}h`;
  else text = `${hours}h ${minutes}m`;
  return `${signOf(value, total)}${text}`;
}

// Pence per litre -> '140.9p/L'.
export function ppl(n) {
  const value = toNumber(n);
  if (value === null) return DASH;
  const rounded = roundTo(Math.abs(value), 1);
  return `${signOf(value, rounded)}${grouped(rounded, 1)}p/L`;
}

// ---- dates -----------------------------------------------------------------------------

// '5 Oct 2026'.
export function date(iso) {
  const day = calendarDay(iso);
  return day ? `${day.d} ${MONTHS[day.m - 1]} ${day.y}` : DASH;
}

// '5 Oct'.
export function dateShort(iso) {
  const day = calendarDay(iso);
  return day ? `${day.d} ${MONTHS[day.m - 1]}` : DASH;
}

// '2026-10' (or a full '2026-10-05') -> 'Oct 26'.
export function monthLabel(month) {
  if (typeof month !== 'string') return DASH;
  const match = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(month.trim());
  const m = match ? Number(match[2]) : 0;
  if (m < 1 || m > 12) return DASH;
  return `${MONTHS[m - 1]} ${match[1].slice(2)}`;
}

// Today's local date as 'YYYY-MM-DD'. `now` is injectable for tests.
export function todayISO(now = new Date()) {
  const day = (now instanceof Date && fromDate(now)) || fromDate(new Date());
  return `${String(day.y).padStart(4, '0')}-${pad2(day.m)}-${pad2(day.d)}`;
}

// 'today', 'tomorrow', 'yesterday', 'in 3 days', '2 days ago' relative to `now`
// (injectable for tests), counted in calendar days so DST changes don't skew it.
export function relDays(iso, now = new Date()) {
  const day = calendarDay(iso);
  const today = (now instanceof Date && fromDate(now)) || fromDate(new Date());
  if (!day) return DASH;
  const diff = Math.round((utcDay(day.y, day.m, day.d) - utcDay(today.y, today.m, today.d)) / MS_PER_DAY);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff === -1) return 'yesterday';
  const count = grouped(Math.abs(diff), 0);
  return diff > 0 ? `in ${count} days` : `${count} days ago`;
}

// ---- words -----------------------------------------------------------------------------

const countFormat = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 });

// plural(1, 'item') -> '1 item'; plural(3, 'item') -> '3 items';
// plural(2, 'match', 'matches') -> '2 matches'. Missing counts read as 0.
export function plural(n, word, pluralWord = `${word}s`) {
  const value = toNumber(n) ?? 0;
  const text = countFormat.format(Math.abs(value));
  // Decide on the displayed digits so 1.001 reads '1 item', not '1 items'.
  const sign = value < 0 && text !== '0' ? MINUS : '';
  return `${sign}${text} ${text === '1' ? word : pluralWord}`;
}

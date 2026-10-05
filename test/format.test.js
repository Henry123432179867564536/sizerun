import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import {
  money,
  moneyShort,
  pct,
  miles,
  duration,
  ppl,
  date,
  dateShort,
  monthLabel,
  todayISO,
  relDays,
  plural,
} from '../public/desk/lib/format.js';

const DASH = '—';
const MINUS = '\u2212';

const MISSING = [null, undefined, '', '   ', 'abc', '£12', NaN, Infinity, -Infinity, {}, [], true, Symbol('s')];

describe('module', () => {
  test('is pure: no imports, no DOM or browser globals', () => {
    const source = readFileSync(new URL('../public/desk/lib/format.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /^\s*import\s/m);
    assert.doesNotMatch(source, /\bimport\s*\(/);
    assert.doesNotMatch(source, /\b(document|window|localStorage|sessionStorage|fetch)\b/);
  });

  test('missing or garbage values render as a dash, never NaN/undefined', () => {
    const numeric = [money, moneyShort, pct, miles, duration, ppl];
    const dates = [date, dateShort, monthLabel, relDays];
    for (const fn of [...numeric, ...dates]) {
      for (const v of MISSING) assert.equal(fn(v), DASH, `${fn.name}(${String(v)})`);
    }
  });
});

describe('money', () => {
  test('pounds and pence with grouping', () => {
    assert.equal(money(1234.5), '£1,234.50');
    assert.equal(money(0), '£0.00');
    assert.equal(money(0.5), '£0.50');
    assert.equal(money(450), '£450.00');
    assert.equal(money(1234567.891), '£1,234,567.89');
  });

  test('negatives use the U+2212 minus sign', () => {
    const out = money(-12);
    assert.equal(out, '−£12.00');
    assert.equal(out.codePointAt(0), 0x2212);
    assert.equal(out, `${MINUS}£12.00`);
    assert.ok(!out.includes('-'), 'no hyphen-minus');
  });

  test('sign option adds + to positives only', () => {
    assert.equal(money(5, { sign: true }), '+£5.00');
    assert.equal(money(-5, { sign: true }), '−£5.00');
    assert.equal(money(0, { sign: true }), '£0.00');
  });

  test('values that round to zero are unsigned', () => {
    assert.equal(money(-0), '£0.00');
    assert.equal(money(-0.001), '£0.00');
    assert.equal(money(-0.004, { sign: true }), '£0.00');
    assert.equal(money(0.004, { sign: true }), '£0.00');
  });

  test('rounds half up, symmetrically for negatives', () => {
    assert.equal(money(1.005), '£1.01');
    assert.equal(money(2.675), '£2.68');
    assert.equal(money(-1.005), '−£1.01');
    assert.equal(money(127.37057422222222), '£127.37');
    assert.equal(money(22.62942577777778), '£22.63');
  });

  test('pence: false rounds to whole pounds', () => {
    assert.equal(money(1234.5, { pence: false }), '£1,235');
    assert.equal(money(1234.49, { pence: false }), '£1,234');
    assert.equal(money(-0.4, { pence: false }), '£0');
    assert.equal(money(-2.5, { pence: false }), '−£3');
  });

  test('numeric strings are formatted', () => {
    assert.equal(money('12.5'), '£12.50');
    assert.equal(money(' -3 '), '−£3.00');
  });

  test('null options fall back to defaults', () => {
    assert.equal(money(5, null), '£5.00');
  });

  test('huge values stay readable', () => {
    assert.equal(money(1e15 + 0.5), '£1,000,000,000,000,000.50');
    assert.ok(!/NaN|Infinity/.test(money(1e300)));
  });
});

describe('moneyShort', () => {
  test('thousands as k from £10,000', () => {
    assert.equal(moneyShort(12345), '£12.3k');
    assert.equal(moneyShort(10000), '£10k');
    assert.equal(moneyShort(15050), '£15.1k');
    assert.equal(moneyShort(999_000), '£999k');
  });

  test('under £10,000 is money without pence', () => {
    assert.equal(moneyShort(1234.56), '£1,235');
    assert.equal(moneyShort(9999.4), '£9,999');
    assert.equal(moneyShort(0), '£0');
    assert.equal(moneyShort(450), '£450');
  });

  test('rounding up to £10,000 switches to k', () => {
    assert.equal(moneyShort(9999.6), '£10k');
  });

  test('millions as m', () => {
    assert.equal(moneyShort(1_250_000), '£1.3m');
    assert.equal(moneyShort(999_960), '£1m');
    assert.equal(moneyShort(12_000_000), '£12m');
  });

  test('negatives', () => {
    assert.equal(moneyShort(-15000), '−£15k');
    assert.equal(moneyShort(-500), '−£500');
    assert.equal(moneyShort(-0.2), '£0');
  });
});

describe('pct', () => {
  test('ratio to whole percent', () => {
    assert.equal(pct(0.253), '25%');
    assert.equal(pct(0.255), '26%');
    assert.equal(pct(0), '0%');
    assert.equal(pct(1), '100%');
    assert.equal(pct(1.5), '150%');
    assert.equal(pct('0.25'), '25%');
  });

  test('negatives use U+2212; near-zero is unsigned', () => {
    assert.equal(pct(-0.12), '−12%');
    assert.equal(pct(-0.004), '0%');
  });
});

describe('miles', () => {
  test('whole miles from 10 up', () => {
    assert.equal(miles(160), '160 mi');
    assert.equal(miles(10), '10 mi');
    assert.equal(miles(80.4), '80 mi');
    assert.equal(miles(1234.4), '1,234 mi');
  });

  test('one decimal place under 10', () => {
    assert.equal(miles(9.94), '9.9 mi');
    assert.equal(miles(0.25), '0.3 mi');
    assert.equal(miles(5), '5.0 mi');
    assert.equal(miles(0), '0.0 mi');
  });

  test('rounding up to 10 drops the decimal', () => {
    assert.equal(miles(9.96), '10 mi');
  });

  test('strings and negatives', () => {
    assert.equal(miles('160'), '160 mi');
    assert.equal(miles(-3), '−3.0 mi');
  });
});

describe('duration', () => {
  test('hours and minutes', () => {
    assert.equal(duration(220), '3h 40m');
    assert.equal(duration(235), '3h 55m');
    assert.equal(duration(61), '1h 1m');
  });

  test('minutes only under an hour', () => {
    assert.equal(duration(45), '45m');
    assert.equal(duration(0), '0m');
    assert.equal(duration(0.4), '0m');
  });

  test('whole hours drop the minutes', () => {
    assert.equal(duration(120), '2h');
    assert.equal(duration(1500), '25h');
  });

  test('rounds to the nearest minute first', () => {
    assert.equal(duration(59.6), '1h');
    assert.equal(duration(219.5), '3h 40m');
    assert.equal(duration('110'), '1h 50m');
  });

  test('negatives', () => {
    assert.equal(duration(-30), '−30m');
    assert.equal(duration(-0.2), '0m');
  });
});

describe('ppl', () => {
  test('one decimal place, pence per litre', () => {
    assert.equal(ppl(140.9), '140.9p/L');
    assert.equal(ppl(140), '140.0p/L');
    assert.equal(ppl(140.94), '140.9p/L');
    assert.equal(ppl(140.95), '141.0p/L');
    assert.equal(ppl('139.7'), '139.7p/L');
  });
});

describe('dates', () => {
  test('date: en-GB day month year', () => {
    assert.equal(date('2026-10-05'), '5 Oct 2026');
    assert.equal(date('2026-01-31'), '31 Jan 2026');
    assert.equal(date('2024-02-29'), '29 Feb 2024');
  });

  test('September is Sep on every runtime', () => {
    assert.equal(date('2026-09-05'), '5 Sep 2026');
  });

  test('dateShort: day month', () => {
    assert.equal(dateShort('2026-10-05'), '5 Oct');
    assert.equal(dateShort('2026-12-25'), '25 Dec');
  });

  test('impossible or malformed dates are a dash', () => {
    for (const v of ['2026-02-30', '2025-02-29', '2026-13-01', '2026-00-10', '2026-10-32', '05/10/2026', '2026-10', 'Oct 5', '2026-1-5']) {
      assert.equal(date(v), DASH, v);
      assert.equal(dateShort(v), DASH, v);
    }
  });

  test('timestamps show the local day of that instant', () => {
    const lateEvening = new Date(2026, 9, 5, 23, 30);
    const earlyMorning = new Date(2026, 9, 5, 0, 15);
    assert.equal(date(lateEvening.toISOString()), '5 Oct 2026');
    assert.equal(date(earlyMorning.toISOString()), '5 Oct 2026');
    assert.equal(dateShort(lateEvening.toISOString()), '5 Oct');
  });

  test('Date objects', () => {
    assert.equal(date(new Date(2026, 9, 5, 12)), '5 Oct 2026');
    assert.equal(date(new Date('invalid')), DASH);
  });

  test('calendar dates never shift with the time zone', () => {
    const moduleUrl = new URL('../public/desk/lib/format.js', import.meta.url).href;
    const script = `
      const f = await import(${JSON.stringify(moduleUrl)});
      process.stdout.write(JSON.stringify([
        f.date('2026-10-05'), f.dateShort('2026-01-01'), f.relDays('2026-10-06', new Date(2026, 9, 5, 23, 59)),
        f.todayISO(new Date(2026, 9, 5, 0, 1)),
      ]));`;
    for (const tz of ['UTC', 'Europe/London', 'Pacific/Pago_Pago', 'Pacific/Kiritimati', 'America/Los_Angeles']) {
      const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        env: { ...process.env, TZ: tz },
        encoding: 'utf8',
      });
      assert.deepEqual(JSON.parse(out), ['5 Oct 2026', '1 Jan', 'tomorrow', '2026-10-05'], tz);
    }
  });

  test('monthLabel', () => {
    assert.equal(monthLabel('2026-10'), 'Oct 26');
    assert.equal(monthLabel('2026-01'), 'Jan 26');
    assert.equal(monthLabel('2026-09'), 'Sep 26');
    assert.equal(monthLabel('1999-12'), 'Dec 99');
    assert.equal(monthLabel('2026-10-05'), 'Oct 26');
    for (const v of ['2026-13', '2026-00', '2026', 'Oct', '26-10', 202610]) assert.equal(monthLabel(v), DASH, String(v));
  });
});

describe('todayISO', () => {
  test('local date, zero padded', () => {
    assert.equal(todayISO(new Date(2026, 9, 5, 12)), '2026-10-05');
    assert.equal(todayISO(new Date(2026, 0, 9, 0, 0)), '2026-01-09');
    assert.equal(todayISO(new Date(2026, 11, 31, 23, 59, 59)), '2026-12-31');
  });

  test('defaults to now', () => {
    const now = new Date();
    const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const out = todayISO();
    assert.match(out, /^\d{4}-\d{2}-\d{2}$/);
    // Allow for the test straddling midnight.
    if (out !== expected) assert.equal(out, todayISO(new Date()));
  });

  test('round-trips through date()', () => {
    assert.equal(date(todayISO(new Date(2026, 9, 5))), '5 Oct 2026');
  });

  test('an invalid now falls back to the current date', () => {
    assert.match(todayISO(new Date('invalid')), /^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('relDays', () => {
  const now = new Date(2026, 9, 5, 15, 30); // 5 Oct 2026, mid-afternoon local time

  test('today, tomorrow, yesterday', () => {
    assert.equal(relDays('2026-10-05', now), 'today');
    assert.equal(relDays('2026-10-06', now), 'tomorrow');
    assert.equal(relDays('2026-10-04', now), 'yesterday');
  });

  test('in N days / N days ago', () => {
    assert.equal(relDays('2026-10-08', now), 'in 3 days');
    assert.equal(relDays('2026-10-03', now), '2 days ago');
    assert.equal(relDays('2026-09-05', now), '30 days ago');
  });

  test('counts calendar days, not 24-hour periods', () => {
    assert.equal(relDays('2026-10-06', new Date(2026, 9, 5, 23, 59)), 'tomorrow');
    assert.equal(relDays('2026-10-04', new Date(2026, 9, 5, 0, 1)), 'yesterday');
  });

  test('across month, year and clock-change boundaries', () => {
    assert.equal(relDays('2026-11-01', new Date(2026, 9, 31, 9)), 'tomorrow');
    assert.equal(relDays('2027-01-01', new Date(2026, 11, 31, 9)), 'tomorrow');
    assert.equal(relDays('2026-03-30', new Date(2026, 2, 28, 9)), 'in 2 days'); // UK clocks go forward 29 Mar
    assert.equal(relDays('2026-10-24', new Date(2026, 9, 26, 9)), '2 days ago'); // and back 25 Oct
  });

  test('large spans are grouped', () => {
    assert.equal(relDays('2023-06-01', now), '1,222 days ago');
  });

  test('timestamps use their local day', () => {
    assert.equal(relDays(new Date(2026, 9, 6, 0, 30).toISOString(), now), 'tomorrow');
  });

  test('defaults to now', () => {
    assert.equal(relDays(todayISO()), 'today');
  });
});

describe('plural', () => {
  test('count with singular or plural noun', () => {
    assert.equal(plural(1, 'item'), '1 item');
    assert.equal(plural(0, 'item'), '0 items');
    assert.equal(plural(3, 'item'), '3 items');
    assert.equal(plural(1200, 'item'), '1,200 items');
  });

  test('irregular plurals', () => {
    assert.equal(plural(2, 'match', 'matches'), '2 matches');
    assert.equal(plural(1, 'match', 'matches'), '1 match');
  });

  test('strings, fractions and missing counts', () => {
    assert.equal(plural('1', 'sale'), '1 sale');
    assert.equal(plural('4', 'sale'), '4 sales');
    assert.equal(plural(1.5, 'hour'), '1.5 hours');
    assert.equal(plural(null, 'item'), '0 items');
    assert.equal(plural(undefined, 'item'), '0 items');
    assert.equal(plural('abc', 'item'), '0 items');
  });

  test('negatives use U+2212', () => {
    assert.equal(plural(-2, 'item'), '−2 items');
  });
});

test('payToDeliverText', async () => {
  const { payToDeliverText } = await import('../public/desk/lib/format.js');
  assert.equal(payToDeliverText(3), 'delivered 3 days after payment');
  assert.equal(payToDeliverText(-1), 'paid 1 day after delivery');
  assert.equal(payToDeliverText(0.2), 'paid on delivery day');
  assert.equal(payToDeliverText(null), null);
});

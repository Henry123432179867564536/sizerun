import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  LITRES_PER_UK_GALLON,
  EPS,
  num,
  round2,
  fuelCost,
  tripTotals,
  itemCost,
  itemTotals,
  dealTotals,
  summarise,
  stockLevels,
  assessDeal,
  dealNumber,
} from '../public/desk/lib/calc.js';

// ---- helpers ---------------------------------------------------------------------------

function close(actual, expected, tolerance = 1e-9, label = '') {
  assert.equal(typeof actual, 'number', `${label} should be a number, got ${actual}`);
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label} expected ${expected} ± ${tolerance}, got ${actual}`,
  );
}

// Asserts a money figure is right to the penny.
function pennies(actual, expected, label = '') {
  assert.equal(typeof actual, 'number', `${label} should be a number, got ${actual}`);
  assert.equal(round2(actual), expected, `${label}: ${actual} should round to ${expected}`);
}

// Walks any result (objects, arrays, Maps) and fails on NaN, Infinity or undefined numbers.
function assertAllFinite(value, path = 'result') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    assert.ok(Number.isFinite(value), `${path} is ${value}`);
    return;
  }
  if (value instanceof Map) {
    for (const [key, v] of value) assertAllFinite(v, `${path}.get(${String(key)})`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertAllFinite(v, `${path}[${i}]`));
    return;
  }
  if (typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) assertAllFinite(v, `${path}.${key}`);
    return;
  }
  assert.fail(`${path} has unexpected type ${typeof value}`);
}

const GARBAGE = [
  undefined,
  null,
  '',
  '   ',
  'abc',
  '£450',
  NaN,
  Infinity,
  -Infinity,
  '1e309',
  {},
  [],
  [1, 2],
  -5,
  '-5',
  0,
  '0',
  true,
  false,
  Symbol('x'),
  1e308,
  -1e308,
  5e-324,
];

// The spec's worked example: London -> Southampton round trip.
const SOUTHAMPTON = Object.freeze({
  one_way_miles: 80,
  one_way_minutes: 110,
  round_trip: true,
  extra_minutes: 15,
  mpg: 45,
  fuel_ppl: 140,
  hourly_rate: 20,
  vehicle_cost_per_mile: 0,
  other_costs: 0,
});

function actualItem(price, cost, qty = 1, extra = {}) {
  return { qty, unit_price: price, cost_status: 'actual', unit_cost: cost, ...extra };
}

function expectedItem(price, expectedCost, qty = 1, extra = {}) {
  return { qty, unit_price: price, cost_status: 'expected', expected_unit_cost: expectedCost, ...extra };
}

// ---- module shape ----------------------------------------------------------------------

describe('module', () => {
  test('is pure: no imports, no DOM or browser globals', () => {
    const source = readFileSync(new URL('../public/desk/lib/calc.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /^\s*import\s/m);
    assert.doesNotMatch(source, /\bimport\s*\(/);
    assert.doesNotMatch(source, /\b(document|window|localStorage|sessionStorage|fetch)\b/);
  });

  test('constants', () => {
    assert.equal(LITRES_PER_UK_GALLON, 4.54609);
    assert.equal(EPS, 0.005);
  });
});

// ---- num / round2 ----------------------------------------------------------------------

describe('num', () => {
  test('passes finite numbers and numeric strings through', () => {
    assert.equal(num(12.5), 12.5);
    assert.equal(num(-3), -3);
    assert.equal(num('450'), 450);
    assert.equal(num(' 22.6 '), 22.6);
    assert.equal(num('-7.25'), -7.25);
  });

  test('maps null, blanks, garbage, NaN and Infinity to 0', () => {
    for (const v of [null, undefined, '', '  ', 'abc', '£12', '1,234', NaN, Infinity, -Infinity, '1e309', {}, Symbol('s')]) {
      assert.equal(num(v), 0, `num(${String(v)})`);
    }
  });

  test('never returns -0', () => {
    assert.ok(Object.is(num(-0), 0));
    assert.ok(Object.is(num('-0'), 0));
  });
});

describe('round2', () => {
  test('rounds half up to pennies, including binary near-halves', () => {
    assert.equal(round2(1.005), 1.01);
    assert.equal(round2(2.675), 2.68);
    assert.equal(round2(1.234), 1.23);
    assert.equal(round2(127.37057422222222), 127.37);
    assert.equal(round2(-12.344), -12.34);
  });

  test('coerces like num()', () => {
    assert.equal(round2('3.456'), 3.46);
    assert.equal(round2(null), 0);
    assert.equal(round2('abc'), 0);
    assert.equal(round2(Infinity), 0);
  });

  test('stays finite for huge values', () => {
    assert.equal(round2(1e21), 1e21);
    assert.ok(Number.isFinite(round2(1e308)));
    assert.ok(Number.isFinite(round2(-1e308)));
  });
});

// ---- trips -----------------------------------------------------------------------------

describe('fuelCost', () => {
  test('miles / mpg * 4.54609 * ppl / 100', () => {
    close(fuelCost(160, 45, 140), (160 / 45) * 4.54609 * 1.4, 1e-12);
    pennies(fuelCost(160, 45, 140), 22.63);
    close(fuelCost('100', '50', '150'), 100 / 50 * 4.54609 * 1.5, 1e-12);
  });

  test('is 0 when mpg is zero, negative or missing', () => {
    assert.equal(fuelCost(160, 0, 140), 0);
    assert.equal(fuelCost(160, -45, 140), 0);
    assert.equal(fuelCost(160, null, 140), 0);
    assert.equal(fuelCost(160, 'abc', 140), 0);
  });

  test('negative distances or prices cost nothing rather than paying you', () => {
    assert.equal(fuelCost(-160, 45, 140), 0);
    assert.equal(fuelCost(160, 45, -140), 0);
  });

  test('never NaN or Infinity', () => {
    for (const a of GARBAGE) {
      for (const b of GARBAGE) {
        const cost = fuelCost(a, b, 140);
        assert.ok(Number.isFinite(cost), `fuelCost(${String(a)}, ${String(b)}, 140) = ${cost}`);
        assert.ok(Number.isFinite(fuelCost(160, a, b)));
      }
    }
  });
});

describe('tripTotals', () => {
  test('worked example: London -> Southampton round trip', () => {
    const t = tripTotals(SOUTHAMPTON);
    assert.equal(t.miles, 160);
    close(t.litres, (160 / 45) * 4.54609, 1e-12, 'litres');
    close(t.litres, 16.1639, 1e-4, 'litres');
    close(t.fuelCost, 22.629, 1e-3, 'fuelCost');
    pennies(t.fuelCost, 22.63, 'fuelCost');
    assert.equal(t.drivingMinutes, 220);
    assert.equal(t.totalMinutes, 235);
    close(t.timeCost, 78.3333, 1e-4, 'timeCost');
    pennies(t.timeCost, 78.33, 'timeCost');
    assert.equal(t.wearCost, 0);
    assert.equal(t.otherCosts, 0);
    close(t.cashCost, t.fuelCost, 1e-12, 'cashCost');
    close(t.fullCost, t.cashCost + t.timeCost, 1e-12, 'fullCost');
    pennies(t.fullCost, 100.96, 'fullCost');
  });

  test('one way halves miles and driving time but keeps extra minutes', () => {
    const t = tripTotals({ ...SOUTHAMPTON, round_trip: false });
    assert.equal(t.miles, 80);
    assert.equal(t.drivingMinutes, 110);
    assert.equal(t.totalMinutes, 125);
    close(t.fuelCost, tripTotals(SOUTHAMPTON).fuelCost / 2, 1e-12);
    close(t.timeCost, (20 * 125) / 60, 1e-12);
  });

  test('round_trip read from form strings', () => {
    assert.equal(tripTotals({ ...SOUTHAMPTON, round_trip: 'false' }).miles, 80);
    assert.equal(tripTotals({ ...SOUTHAMPTON, round_trip: '0' }).miles, 80);
    assert.equal(tripTotals({ ...SOUTHAMPTON, round_trip: '' }).miles, 80);
    assert.equal(tripTotals({ ...SOUTHAMPTON, round_trip: 'true' }).miles, 160);
    assert.equal(tripTotals({ ...SOUTHAMPTON, round_trip: 1 }).miles, 160);
    assert.equal(tripTotals({ ...SOUTHAMPTON, round_trip: undefined }).miles, 80);
  });

  test('wear and other costs are cash costs; time is not', () => {
    const t = tripTotals({ ...SOUTHAMPTON, vehicle_cost_per_mile: 0.1, other_costs: 12.5 });
    close(t.wearCost, 16, 1e-12);
    assert.equal(t.otherCosts, 12.5);
    close(t.cashCost, t.fuelCost + 16 + 12.5, 1e-12);
    close(t.fullCost, t.cashCost + t.timeCost, 1e-12);
  });

  test('accepts numeric strings', () => {
    const t = tripTotals({
      one_way_miles: '80',
      one_way_minutes: '110',
      round_trip: true,
      extra_minutes: '15',
      mpg: '45',
      fuel_ppl: '140.0',
      hourly_rate: '20',
    });
    assert.deepEqual(t, tripTotals(SOUTHAMPTON));
  });

  test('missing trip gives all zeros', () => {
    const zeros = {
      miles: 0,
      drivingMinutes: 0,
      totalMinutes: 0,
      litres: 0,
      fuelCost: 0,
      wearCost: 0,
      otherCosts: 0,
      cashCost: 0,
      timeCost: 0,
      fullCost: 0,
    };
    assert.deepEqual(tripTotals(null), zeros);
    assert.deepEqual(tripTotals(undefined), zeros);
    assert.deepEqual(tripTotals({}), zeros);
  });

  test('zero mpg means no fuel figure, not Infinity', () => {
    const t = tripTotals({ ...SOUTHAMPTON, mpg: 0 });
    assert.equal(t.litres, 0);
    assert.equal(t.fuelCost, 0);
    assert.equal(t.miles, 160);
  });

  test('negative inputs are treated as zero', () => {
    const t = tripTotals({
      one_way_miles: -80,
      one_way_minutes: -110,
      round_trip: true,
      extra_minutes: -15,
      mpg: 45,
      fuel_ppl: 140,
      hourly_rate: -20,
      vehicle_cost_per_mile: -1,
      other_costs: -10,
    });
    assert.equal(t.miles, 0);
    assert.equal(t.totalMinutes, 0);
    assert.equal(t.cashCost, 0);
    assert.equal(t.timeCost, 0);
  });

  test('garbage in any field never produces NaN or Infinity', () => {
    for (const field of Object.keys(SOUTHAMPTON)) {
      for (const v of GARBAGE) assertAllFinite(tripTotals({ ...SOUTHAMPTON, [field]: v }), `${field}=${String(v)}`);
    }
    // Every field huge at once would overflow without the guards.
    const huge = Object.fromEntries(Object.keys(SOUTHAMPTON).map((k) => [k, 1e308]));
    assertAllFinite(tripTotals({ ...huge, mpg: 5e-324 }));
    for (const v of GARBAGE) assertAllFinite(tripTotals(v));
  });
});

// ---- items -----------------------------------------------------------------------------

describe('itemCost / itemTotals', () => {
  test('expected items use expected_unit_cost', () => {
    const item = expectedItem(450, 300, 2, { unit_cost: 999 });
    assert.equal(itemCost(item), 300);
    assert.deepEqual(itemTotals(item), { revenue: 900, cost: 600, isExpected: true, variance: null });
  });

  test('actual items use unit_cost', () => {
    const item = actualItem(450, 280, 1, { expected_unit_cost: 300 });
    assert.equal(itemCost(item), 280);
    const t = itemTotals(item);
    assert.equal(t.revenue, 450);
    assert.equal(t.cost, 280);
    assert.equal(t.isExpected, false);
  });

  test('missing cost_status is expected (the database default)', () => {
    const item = { qty: 1, unit_price: 100, expected_unit_cost: 60, unit_cost: 40 };
    assert.equal(itemCost(item), 60);
    assert.equal(itemTotals(item).isExpected, true);
  });

  test('variance: positive when bought cheaper than expected, times qty', () => {
    assert.equal(itemTotals(actualItem(150, 100, 2, { expected_unit_cost: 120 })).variance, 40);
  });

  test('variance: negative when bought dearer than expected', () => {
    assert.equal(itemTotals(actualItem(150, 130, 2, { expected_unit_cost: 120 })).variance, -20);
  });

  test('variance: zero when bought at the expected cost', () => {
    assert.equal(itemTotals(actualItem(150, 120, 1, { expected_unit_cost: 120 })).variance, 0);
  });

  test('variance: null unless the item is actual and both costs are known', () => {
    assert.equal(itemTotals(expectedItem(150, 120)).variance, null);
    assert.equal(itemTotals(actualItem(150, 100)).variance, null); // from stock: no expectation
    assert.equal(itemTotals(actualItem(150, 100, 1, { expected_unit_cost: null })).variance, null);
    assert.equal(itemTotals(actualItem(150, 100, 1, { expected_unit_cost: '' })).variance, null);
    assert.equal(itemTotals(actualItem(150, null, 1, { expected_unit_cost: 120 })).variance, null);
    assert.equal(itemTotals(actualItem(150, 'abc', 1, { expected_unit_cost: 120 })).variance, null);
  });

  test('numeric strings work, including an expected cost of 0', () => {
    const t = itemTotals({ qty: '2', unit_price: '50', cost_status: 'actual', unit_cost: '10', expected_unit_cost: '0' });
    assert.deepEqual(t, { revenue: 100, cost: 20, isExpected: false, variance: -20 });
  });

  test('null or garbage items never produce NaN', () => {
    assert.equal(itemCost(null), 0);
    assert.equal(itemCost(undefined), 0);
    assert.deepEqual(itemTotals(null), { revenue: 0, cost: 0, isExpected: true, variance: null });
    for (const v of GARBAGE) {
      for (const field of ['qty', 'unit_price', 'unit_cost', 'expected_unit_cost']) {
        assertAllFinite(itemTotals(actualItem(100, 50, 1, { expected_unit_cost: 60, [field]: v })));
        assertAllFinite(itemTotals(expectedItem(100, 50, 1, { [field]: v })));
        assert.ok(Number.isFinite(itemCost({ cost_status: 'actual', [field]: v })));
      }
    }
  });
});

// ---- deals -----------------------------------------------------------------------------

describe('dealTotals', () => {
  test('worked example: £450 sale, £300 bought, Southampton drop-off', () => {
    const t = dealTotals(
      { status: 'completed' },
      { items: [actualItem(450, 300)], payments: [{ amount: 450 }], trips: [SOUTHAMPTON] },
    );
    assert.equal(t.revenue, 450);
    assert.equal(t.goodsCost, 300);
    assert.equal(t.grossProfit, 150);
    pennies(t.travelCost, 22.63, 'travelCost');
    pennies(t.timeCost, 78.33, 'timeCost');
    pennies(t.netProfit, 127.37, 'netProfit');
    pennies(t.trueProfit, 49.04, 'trueProfit');
    pennies(t.perDrivingHour, 34.74, 'perDrivingHour');
    close(t.perDrivingHour, t.netProfit / (220 / 60), 1e-12);
    close(t.perHourAllIn, t.netProfit / (235 / 60), 1e-12);
    close(t.margin, t.netProfit / 450, 1e-12);
    assert.equal(t.drivingMinutes, 220);
    assert.equal(t.totalMinutes, 235);
    assert.equal(t.miles, 160);
    assert.equal(t.certainty, 'confirmed');
    assert.equal(t.expectedCount, 0);
    assert.equal(t.paid, 450);
    assert.equal(t.balance, 0);
    assert.equal(t.paymentStatus, 'paid');
    assert.equal(t.bucket, 'realised');
  });

  test('expected vs actual costs, expected extras, variance and part payment', () => {
    const t = dealTotals(
      { status: 'sourcing' },
      {
        items: [expectedItem(450, 300), actualItem(100, 60, 2, { expected_unit_cost: 70 })],
        costs: [{ label: 'Postage', amount: 10, is_expected: true }, { label: 'Box', amount: 5 }],
        payments: [{ amount: 200 }],
      },
    );
    assert.equal(t.revenue, 650);
    assert.equal(t.goodsCostExpected, 300);
    assert.equal(t.goodsCostActual, 120);
    assert.equal(t.goodsCost, 420);
    assert.equal(t.extraCosts, 15);
    assert.equal(t.extraCostsExpected, 10);
    assert.equal(t.grossProfit, 215);
    assert.equal(t.travelCost, 0);
    assert.equal(t.netProfit, 215);
    assert.equal(t.trueProfit, 215);
    assert.equal(t.expectedCount, 2);
    assert.equal(t.certainty, 'estimated');
    assert.equal(t.variance, 20);
    assert.equal(t.paid, 200);
    assert.equal(t.balance, 450);
    assert.equal(t.paymentStatus, 'part');
    assert.equal(t.bucket, 'pending');
  });

  test('marking an expected item bought moves its cost from expected to actual', () => {
    const before = dealTotals({}, { items: [expectedItem(200, 150)] });
    const after = dealTotals({}, { items: [actualItem(200, 140, 1, { expected_unit_cost: 150 })] });
    assert.equal(before.goodsCostExpected, 150);
    assert.equal(before.certainty, 'estimated');
    assert.equal(before.variance, null);
    assert.equal(after.goodsCostExpected, 0);
    assert.equal(after.goodsCostActual, 140);
    assert.equal(after.certainty, 'confirmed');
    assert.equal(after.variance, 10);
    assert.equal(after.netProfit - before.netProfit, 10);
  });

  test('an expected extra cost alone makes the deal estimated', () => {
    const t = dealTotals({}, { items: [actualItem(100, 50)], costs: [{ amount: 4, is_expected: 'true' }] });
    assert.equal(t.expectedCount, 1);
    assert.equal(t.certainty, 'estimated');
    const confirmed = dealTotals({}, { items: [actualItem(100, 50)], costs: [{ amount: 4, is_expected: 'false' }] });
    assert.equal(confirmed.certainty, 'confirmed');
  });

  test('variance sums across items', () => {
    const t = dealTotals({}, {
      items: [
        actualItem(100, 50, 1, { expected_unit_cost: 60 }),
        actualItem(100, 75, 2, { expected_unit_cost: 70 }),
        actualItem(100, 40),
      ],
    });
    assert.equal(t.variance, 0); // +10 and -10
  });

  test('several trips add up', () => {
    const t = dealTotals({}, { items: [actualItem(450, 300)], trips: [SOUTHAMPTON, { ...SOUTHAMPTON, round_trip: false }] });
    assert.equal(t.miles, 240);
    assert.equal(t.drivingMinutes, 330);
    assert.equal(t.totalMinutes, 360);
    const one = tripTotals(SOUTHAMPTON);
    const two = tripTotals({ ...SOUTHAMPTON, round_trip: false });
    close(t.travelCost, one.cashCost + two.cashCost, 1e-12);
    close(t.timeCost, one.timeCost + two.timeCost, 1e-12);
  });

  test('ratios are null when undefined', () => {
    const empty = dealTotals({ status: 'agreed' });
    assert.equal(empty.margin, null);
    assert.equal(empty.perDrivingHour, null);
    assert.equal(empty.perHourAllIn, null);
    assert.equal(empty.variance, null);
    // Only handover time: no driving hours, but some time.
    const t = dealTotals({}, { items: [actualItem(100, 40)], trips: [{ extra_minutes: 30, mpg: 45, fuel_ppl: 140 }] });
    assert.equal(t.perDrivingHour, null);
    assert.equal(t.perHourAllIn, 120);
  });

  test('negative margin on a loss', () => {
    const t = dealTotals({}, { items: [actualItem(100, 150)] });
    assert.equal(t.netProfit, -50);
    assert.equal(t.margin, -0.5);
  });

  describe('paymentStatus', () => {
    const status = (payments, price = 100) =>
      dealTotals({ status: 'delivered' }, { items: [actualItem(price, 50)], payments }).paymentStatus;

    test('unpaid, part and paid', () => {
      assert.equal(status([]), 'unpaid');
      assert.equal(status([{ amount: 50 }]), 'part');
      assert.equal(status([{ amount: 60 }, { amount: 40 }]), 'paid');
    });

    test('within half a penny counts as paid', () => {
      assert.equal(status([{ amount: 99.996 }]), 'paid');
      assert.equal(status([{ amount: 99.995 }]), 'paid');
      assert.equal(status([{ amount: 99.99 }]), 'part');
    });

    test('dust payments count as unpaid', () => {
      assert.equal(status([{ amount: 0.004 }]), 'unpaid');
      assert.equal(status([{ amount: 0.01 }]), 'part');
    });

    test('overpaid is paid with a negative balance', () => {
      const t = dealTotals({}, { items: [actualItem(100, 50)], payments: [{ amount: 120 }] });
      assert.equal(t.paymentStatus, 'paid');
      assert.equal(t.balance, -20);
    });

    test('refunds are negative payments', () => {
      assert.equal(status([{ amount: 100 }, { amount: -100 }]), 'unpaid');
      assert.equal(status([{ amount: 100 }, { amount: -30 }]), 'part');
      const t = dealTotals({}, { items: [actualItem(100, 50)], payments: [{ amount: 100 }, { amount: -30 }] });
      assert.equal(t.paid, 70);
      assert.equal(t.balance, 30);
    });

    test('zero-revenue deals are none, or paid if money came in', () => {
      assert.equal(status([], 0), 'none');
      assert.equal(status([{ amount: 10 }], 0), 'paid');
      assert.equal(status([{ amount: 0.004 }], 0), 'none');
      assert.equal(status([{ amount: -5 }], 0), 'none');
      assert.equal(status([], 0.004), 'none');
      assert.equal(dealTotals({}).paymentStatus, 'none');
    });

    test('string amounts', () => {
      assert.equal(status([{ amount: '100.00' }]), 'paid');
      assert.equal(status([{ amount: 'abc' }]), 'unpaid');
    });
  });

  describe('bucket', () => {
    const paidConfirmed = (status) =>
      dealTotals({ status }, { items: [actualItem(100, 50)], payments: [{ amount: 100 }] }).bucket;

    test('realised needs confirmed costs, paid, and delivered or completed', () => {
      assert.equal(paidConfirmed('delivered'), 'realised');
      assert.equal(paidConfirmed('completed'), 'realised');
    });

    test('pending before delivery even when paid and confirmed', () => {
      for (const status of ['enquiry', 'agreed', 'sourcing', 'ready', undefined, 'bogus']) {
        assert.equal(paidConfirmed(status), 'pending', String(status));
      }
    });

    test('pending while any cost is still expected', () => {
      const withExpectedItem = dealTotals(
        { status: 'completed' },
        { items: [expectedItem(100, 50)], payments: [{ amount: 100 }] },
      );
      assert.equal(withExpectedItem.bucket, 'pending');
      const withExpectedCost = dealTotals(
        { status: 'completed' },
        { items: [actualItem(100, 50)], costs: [{ amount: 5, is_expected: true }], payments: [{ amount: 100 }] },
      );
      assert.equal(withExpectedCost.bucket, 'pending');
    });

    test('pending while unpaid or part paid', () => {
      const deal = { status: 'completed' };
      assert.equal(dealTotals(deal, { items: [actualItem(100, 50)] }).bucket, 'pending');
      assert.equal(dealTotals(deal, { items: [actualItem(100, 50)], payments: [{ amount: 50 }] }).bucket, 'pending');
    });

    test('zero-revenue (free) deal realises once delivered with confirmed costs', () => {
      assert.equal(dealTotals({ status: 'completed' }, { items: [actualItem(0, 20)] }).bucket, 'realised');
      assert.equal(dealTotals({ status: 'agreed' }, { items: [actualItem(0, 20)] }).bucket, 'pending');
    });

    test('cancelled wins over everything', () => {
      assert.equal(paidConfirmed('cancelled'), 'cancelled');
      assert.equal(dealTotals({ status: 'cancelled' }).bucket, 'cancelled');
    });
  });

  test("uses the deal's own children when the second argument is omitted", () => {
    const deal = {
      status: 'completed',
      items: [actualItem(450, 300)],
      costs: [],
      payments: [{ amount: 450 }],
      trips: [SOUTHAMPTON],
    };
    assert.deepEqual(dealTotals(deal), dealTotals(deal, deal));
    pennies(dealTotals(deal).netProfit, 127.37);
    // An explicit children object is used as given.
    assert.equal(dealTotals(deal, {}).revenue, 0);
  });

  test('tolerates missing deals, null collections and holes', () => {
    const t = dealTotals(null, { items: null, costs: undefined, payments: 'x', trips: [null, undefined, 5] });
    assert.equal(t.revenue, 0);
    assert.equal(t.expectedCount, 0);
    assert.equal(t.bucket, 'pending');
    assert.equal(dealTotals(undefined, undefined).revenue, 0);
    assert.equal(dealTotals({}, { items: [null, actualItem(10, 5)] }).revenue, 10);
  });

  test('garbage anywhere never produces NaN or Infinity', () => {
    for (const v of GARBAGE) {
      const t = dealTotals(
        { status: 'completed' },
        {
          items: [actualItem(v, v, v, { expected_unit_cost: v }), expectedItem(100, v, 1)],
          costs: [{ amount: v, is_expected: v }],
          payments: [{ amount: v }],
          trips: [{ ...SOUTHAMPTON, one_way_miles: v, one_way_minutes: v, mpg: v, fuel_ppl: v }],
        },
      );
      assertAllFinite(t, `dealTotals with ${String(v)}`);
      assertAllFinite(dealTotals(v, v));
    }
  });
});

// ---- summarise -------------------------------------------------------------------------

describe('summarise', () => {
  // d1 realised (with the Southampton drive), d2 pending (to source, part paid),
  // d3 pending (delivered, unpaid), d4 cancelled, d5 realised (overpaid).
  const d1 = {
    id: 'd1',
    status: 'completed',
    sale_date: '2026-09-30',
    items: [actualItem(450, 300)],
    costs: [],
    payments: [{ amount: 450 }],
    trips: [SOUTHAMPTON],
  };
  const d2 = {
    id: 'd2',
    status: 'agreed',
    sale_date: '2026-10-01',
    items: [expectedItem(200, 150), expectedItem(50, 30, 2)],
    costs: [],
    payments: [{ amount: 50 }],
    trips: [],
  };
  const d3 = {
    id: 'd3',
    status: 'delivered',
    sale_date: '2026-10-31',
    items: [actualItem(120, 80)],
    costs: [{ amount: 5 }],
    payments: [],
    trips: [],
  };
  const d4 = {
    id: 'd4',
    status: 'cancelled',
    sale_date: '2026-10-15',
    items: [expectedItem(1000, 10)],
    costs: [],
    payments: [{ amount: 100 }],
    trips: [SOUTHAMPTON],
  };
  const d5 = {
    id: 'd5',
    status: 'completed',
    sale_date: '2026-08-10',
    items: [actualItem(100, 60)],
    costs: [],
    payments: [{ amount: 120 }],
    trips: [],
  };
  const all = [d3, d1, d4, d5, d2]; // deliberately out of date order
  const d1Net = dealTotals(d1).netProfit;

  test('all time totals exclude cancelled deals from every figure', () => {
    const s = summarise(all);
    assert.equal(s.count, 4);
    assert.equal(s.revenue, 970);
    close(s.realisedProfit, d1Net + 40, 1e-9, 'realisedProfit');
    assert.equal(s.pendingProfit, 125);
    close(s.netProfit, d1Net + 165, 1e-9, 'netProfit');
    close(s.netProfit, s.realisedProfit + s.pendingProfit, 1e-9);
    assert.equal(s.owed, 370); // d2 250 + d3 120; d5's overpayment does not offset it
    assert.equal(s.toSource, 2);
    assert.equal(s.drivingMinutes, 220);
    assert.equal(s.miles, 160);
    pennies(s.perDrivingHour, 34.74, 'perDrivingHour');
  });

  test('perDrivingHour only counts deals that involved driving', () => {
    const s = summarise(all);
    close(s.perDrivingHour, d1Net / (220 / 60), 1e-9);
  });

  test('byMonth groups by sale month, sorted ascending', () => {
    const { byMonth } = summarise(all);
    assert.deepEqual(byMonth.map((m) => m.month), ['2026-08', '2026-09', '2026-10']);
    assert.deepEqual(byMonth[0], { month: '2026-08', revenue: 100, realised: 40, pending: 0 });
    assert.equal(byMonth[1].revenue, 450);
    close(byMonth[1].realised, d1Net, 1e-9);
    assert.equal(byMonth[1].pending, 0);
    assert.deepEqual(byMonth[2], { month: '2026-10', revenue: 420, realised: 0, pending: 125 });
  });

  test('from/to filter on sale_date, inclusive at both ends', () => {
    const s = summarise(all, { from: '2026-10-01', to: '2026-10-31' });
    assert.equal(s.count, 2);
    assert.equal(s.revenue, 420);
    assert.equal(s.realisedProfit, 0);
    assert.equal(s.pendingProfit, 125);
    assert.equal(s.owed, 370);
    assert.equal(s.toSource, 2);
    assert.equal(s.drivingMinutes, 0);
    assert.equal(s.perDrivingHour, null);
    assert.deepEqual(s.byMonth.map((m) => m.month), ['2026-10']);
  });

  test('open-ended ranges', () => {
    assert.equal(summarise(all, { from: '2026-09-30' }).count, 3); // d1, d2, d3
    assert.equal(summarise(all, { to: '2026-09-30' }).count, 2); // d5, d1
    assert.equal(summarise(all, { from: '2026-10-02', to: '2026-10-30' }).count, 0);
  });

  test('timestamps in from/to compare by day', () => {
    assert.equal(summarise(all, { from: '2026-10-31T00:00:00.000Z', to: '2026-10-31T23:59:59Z' }).count, 1);
  });

  test('a deal without a sale date counts all time but never in a range or a month', () => {
    const undated = { status: 'agreed', sale_date: null, items: [actualItem(10, 5)] };
    const s = summarise([...all, undated]);
    assert.equal(s.count, 5);
    assert.equal(s.revenue, 980);
    assert.equal(s.byMonth.reduce((sum, m) => sum + m.revenue, 0), 970);
    assert.equal(summarise([undated], { from: '2000-01-01' }).count, 0);
  });

  test('empty and invalid input', () => {
    const empty = {
      count: 0,
      revenue: 0,
      realisedProfit: 0,
      pendingProfit: 0,
      netProfit: 0,
      owed: 0,
      toSource: 0,
      drivingMinutes: 0,
      miles: 0,
      perDrivingHour: null,
      byMonth: [],
    };
    assert.deepEqual(summarise([]), empty);
    assert.deepEqual(summarise(null), empty);
    assert.deepEqual(summarise(undefined, null), empty);
    assert.deepEqual(summarise([null, 7, 'x']), empty);
    assert.deepEqual(summarise([d4]), empty);
  });

  test('garbage ranges are ignored rather than filtering everything out', () => {
    assert.equal(summarise(all, { from: 'yesterday', to: 42 }).count, 4);
  });

  test('garbage deals never produce NaN or Infinity', () => {
    for (const v of GARBAGE) {
      const deal = {
        status: v,
        sale_date: v,
        items: [actualItem(v, v, v), expectedItem(v, v, v)],
        costs: [{ amount: v }],
        payments: [{ amount: v }],
        trips: [{ ...SOUTHAMPTON, one_way_minutes: v, hourly_rate: v }],
      };
      assertAllFinite(summarise([deal, d1], { from: v, to: v }), `summarise with ${String(v)}`);
    }
  });
});

// ---- stock -----------------------------------------------------------------------------

describe('stockLevels', () => {
  const stock = [
    { id: 's1', qty: 3, unit_cost: 100 },
    { id: 's2', qty: 1, unit_cost: 50 },
    { id: 's3', qty: 2, unit_cost: 10 },
  ];
  const deals = [
    { status: 'agreed', items: [{ stock_item_id: 's1', qty: 1 }] },
    { status: 'cancelled', items: [{ stock_item_id: 's1', qty: 2 }] },
    { status: 'completed', items: [{ stock_item_id: 's2', qty: 2 }, { stock_item_id: null, qty: 4 }] },
    { status: 'delivered', items: [{ stock_item_id: 'ghost', qty: 1 }] },
  ];

  test('allocates from every non-cancelled deal', () => {
    const levels = stockLevels(stock, deals);
    assert.ok(levels instanceof Map);
    assert.deepEqual(levels.get('s1'), { allocated: 1, onHand: 2, value: 200 });
  });

  test('cancelled deals do not allocate stock', () => {
    const levels = stockLevels(stock, [deals[1]]);
    assert.deepEqual(levels.get('s1'), { allocated: 0, onHand: 3, value: 300 });
  });

  test('unallocated stock is fully on hand', () => {
    assert.deepEqual(stockLevels(stock, deals).get('s3'), { allocated: 0, onHand: 2, value: 20 });
  });

  test('oversold stock goes negative on hand but is never negative value', () => {
    assert.deepEqual(stockLevels(stock, deals).get('s2'), { allocated: 2, onHand: -1, value: 0 });
  });

  test('only known stock ids are returned', () => {
    const levels = stockLevels(stock, deals);
    assert.deepEqual([...levels.keys()], ['s1', 's2', 's3']);
    assert.equal(levels.has('ghost'), false);
  });

  test('sums several allocations of the same line', () => {
    const levels = stockLevels(stock, [
      { status: 'agreed', items: [{ stock_item_id: 's1', qty: 1 }, { stock_item_id: 's1', qty: '1' }] },
      { status: 'ready', items: [{ stock_item_id: 's1', qty: 1 }] },
    ]);
    assert.deepEqual(levels.get('s1'), { allocated: 3, onHand: 0, value: 0 });
  });

  test('tolerates missing inputs and garbage', () => {
    assert.equal(stockLevels(null, null).size, 0);
    assert.deepEqual(stockLevels(stock, undefined).get('s1'), { allocated: 0, onHand: 3, value: 300 });
    assert.equal(stockLevels([{ qty: 1, unit_cost: 5 }], []).size, 0); // no id
    for (const v of GARBAGE) {
      assertAllFinite(
        stockLevels([{ id: 's1', qty: v, unit_cost: v }], [{ status: v, items: [{ stock_item_id: 's1', qty: v }] }]),
      );
    }
  });
});

// ---- deal checker ----------------------------------------------------------------------

describe('assessDeal', () => {
  test('worked example: good deal with the Southampton drive', () => {
    const r = assessDeal({ salePrice: 450, buyPrice: 300, trip: SOUTHAMPTON, hourlyRate: 20, targetMargin: 0.25 });
    assert.equal(r.revenue, 450);
    assert.equal(r.goodsCost, 300);
    assert.equal(r.extraCosts, 0);
    pennies(r.travelCost, 22.63, 'travelCost');
    pennies(r.timeCost, 78.33, 'timeCost');
    pennies(r.netProfit, 127.37, 'netProfit');
    pennies(r.trueProfit, 49.04, 'trueProfit');
    pennies(r.perDrivingHour, 34.74, 'perDrivingHour');
    pennies(r.perHourAllIn, 32.52, 'perHourAllIn');
    close(r.margin, r.netProfit / 450, 1e-12);
    pennies(r.breakEvenPrice, 322.63, 'breakEvenPrice');
    pennies(r.priceForRate, 400.96, 'priceForRate');
    pennies(r.priceForMargin, 430.17, 'priceForMargin');
    pennies(r.maxBuyPrice, 349.04, 'maxBuyPrice');
    assert.equal(r.verdict, 'good');
    assert.ok(r.reasons.length > 0);
    assert.ok(r.reasons.every((s) => typeof s === 'string' && s.length > 0));
    assert.ok(r.reasons.some((s) => s.includes('£34.74')), r.reasons.join(' | '));
  });

  test('matches dealTotals for the same deal', () => {
    const r = assessDeal({ salePrice: 450, buyPrice: 300, extraCosts: 12, trip: SOUTHAMPTON, hourlyRate: 20 });
    const t = dealTotals({}, { items: [actualItem(450, 300)], costs: [{ amount: 12 }], trips: [SOUTHAMPTON] });
    for (const key of ['revenue', 'goodsCost', 'extraCosts', 'travelCost', 'timeCost', 'netProfit', 'trueProfit', 'margin', 'perDrivingHour', 'perHourAllIn']) {
      close(r[key], t[key], 1e-9, key);
    }
  });

  test('loss when costs beat the sale price', () => {
    const r = assessDeal({ salePrice: 300, buyPrice: 320, targetMargin: 0.25 });
    assert.equal(r.netProfit, -20);
    assert.equal(r.verdict, 'loss');
    assert.equal(r.breakEvenPrice, 320);
    assert.ok(r.reasons.some((s) => s.includes('£320.00')), r.reasons.join(' | '));
  });

  test('loss when the drive eats the margin', () => {
    const r = assessDeal({ salePrice: 310, buyPrice: 300, trip: SOUTHAMPTON, hourlyRate: 20 });
    pennies(r.netProfit, -12.63);
    assert.equal(r.verdict, 'loss');
    assert.ok(r.reasons.some((s) => /drive/i.test(s)), r.reasons.join(' | '));
  });

  test('tight when profit does not pay for your time', () => {
    const r = assessDeal({ salePrice: 340, buyPrice: 300, trip: SOUTHAMPTON, hourlyRate: 20 });
    assert.ok(r.netProfit > 0);
    assert.ok(r.trueProfit < 0);
    assert.equal(r.verdict, 'tight');
    assert.ok(r.reasons.some((s) => /time/i.test(s)), r.reasons.join(' | '));
    assert.ok(r.reasons.some((s) => s.includes('£400.96')), 'tells you the price that covers your time');
  });

  test('tight when under the target margin', () => {
    const r = assessDeal({ salePrice: 100, buyPrice: 85, targetMargin: 0.25 });
    assert.equal(r.netProfit, 15);
    assert.equal(r.margin, 0.15);
    assert.equal(r.verdict, 'tight');
    assert.ok(r.reasons.some((s) => s.includes('15%') && s.includes('25%')), r.reasons.join(' | '));
    assert.ok(r.reasons.some((s) => s.includes('£113.33')), 'tells you the price that hits the target');
  });

  test('good without a trip; per-hour figures are null', () => {
    const r = assessDeal({ salePrice: 200, buyPrice: 100, targetMargin: 0.25 });
    assert.equal(r.verdict, 'good');
    assert.equal(r.travelCost, 0);
    assert.equal(r.timeCost, 0);
    assert.equal(r.perDrivingHour, null);
    assert.equal(r.perHourAllIn, null);
    assert.equal(r.trueProfit, r.netProfit);
  });

  test('null trip ignores the hourly rate', () => {
    const r = assessDeal({ salePrice: 200, buyPrice: 100, trip: null, hourlyRate: 50 });
    assert.equal(r.timeCost, 0);
    assert.equal(r.priceForRate, r.breakEvenPrice);
    assert.equal(r.maxBuyPrice, 200);
  });

  test('hourlyRate overrides the trip rate; omitted, the trip rate is used', () => {
    const at30 = assessDeal({ salePrice: 450, buyPrice: 300, trip: SOUTHAMPTON, hourlyRate: 30 });
    close(at30.timeCost, (30 * 235) / 60, 1e-9);
    const free = assessDeal({ salePrice: 450, buyPrice: 300, trip: SOUTHAMPTON, hourlyRate: 0 });
    assert.equal(free.timeCost, 0);
    const fromTrip = assessDeal({ salePrice: 450, buyPrice: 300, trip: SOUTHAMPTON });
    close(fromTrip.timeCost, (20 * 235) / 60, 1e-9);
    const blank = assessDeal({ salePrice: 450, buyPrice: 300, trip: SOUTHAMPTON, hourlyRate: '' });
    close(blank.timeCost, fromTrip.timeCost, 1e-12);
  });

  test('extra costs count towards break-even and max buy price', () => {
    const r = assessDeal({ salePrice: 200, buyPrice: 100, extraCosts: 15 });
    assert.equal(r.netProfit, 85);
    assert.equal(r.breakEvenPrice, 115);
    assert.equal(r.maxBuyPrice, 185);
  });

  test('priceForMargin is null at or above a 100% target', () => {
    assert.equal(assessDeal({ salePrice: 200, buyPrice: 100, targetMargin: 1 }).priceForMargin, null);
    assert.equal(assessDeal({ salePrice: 200, buyPrice: 100, targetMargin: 1.5 }).priceForMargin, null);
    assert.equal(assessDeal({ salePrice: 200, buyPrice: 100, targetMargin: 0 }).priceForMargin, 100);
  });

  test('selling exactly at break-even is not a loss', () => {
    const base = assessDeal({ salePrice: 0, buyPrice: 300, trip: SOUTHAMPTON, hourlyRate: 0 });
    const r = assessDeal({ salePrice: base.breakEvenPrice, buyPrice: 300, trip: SOUTHAMPTON, hourlyRate: 0 });
    close(r.netProfit, 0, 1e-9);
    assert.equal(r.verdict, 'good');
    const withTime = assessDeal({ salePrice: base.breakEvenPrice, buyPrice: 300, trip: SOUTHAMPTON, hourlyRate: 20 });
    assert.equal(withTime.verdict, 'tight');
  });

  test('selling at priceForRate exactly pays your rate', () => {
    const base = assessDeal({ salePrice: 0, buyPrice: 300, trip: SOUTHAMPTON, hourlyRate: 20 });
    const r = assessDeal({ salePrice: base.priceForRate, buyPrice: 300, trip: SOUTHAMPTON, hourlyRate: 20 });
    close(r.trueProfit, 0, 1e-9);
    assert.equal(r.verdict, 'good');
  });

  test('selling at priceForMargin exactly hits the target', () => {
    for (const target of [0.1, 0.25, 0.3, 0.333, 0.7]) {
      const base = assessDeal({ salePrice: 0, buyPrice: 7, extraCosts: 3.33, targetMargin: target });
      const r = assessDeal({ salePrice: base.priceForMargin, buyPrice: 7, extraCosts: 3.33, targetMargin: target });
      close(r.margin, target, 1e-9, `margin at ${target}`);
      assert.equal(r.verdict, 'good', `target ${target}`);
    }
  });

  test('buying at maxBuyPrice exactly pays your rate', () => {
    const base = assessDeal({ salePrice: 450, buyPrice: 0, trip: SOUTHAMPTON, hourlyRate: 20 });
    const r = assessDeal({ salePrice: 450, buyPrice: base.maxBuyPrice, trip: SOUTHAMPTON, hourlyRate: 20 });
    close(r.trueProfit, 0, 1e-9);
    assert.notEqual(r.verdict, 'loss');
  });

  test('no sale price: a loss if anything costs money, otherwise short of the margin', () => {
    assert.equal(assessDeal({ salePrice: 0, buyPrice: 50 }).verdict, 'loss');
    const r = assessDeal({ salePrice: 0, buyPrice: 0, targetMargin: 0.25 });
    assert.equal(r.margin, null);
    assert.equal(r.verdict, 'tight');
    assert.ok(r.reasons.length > 0);
  });

  test('numeric strings work like numbers', () => {
    const r = assessDeal({ salePrice: '450', buyPrice: '300', extraCosts: '0', trip: SOUTHAMPTON, hourlyRate: '20', targetMargin: '0.25' });
    assert.deepEqual(r, assessDeal({ salePrice: 450, buyPrice: 300, trip: SOUTHAMPTON, hourlyRate: 20, targetMargin: 0.25 }));
  });

  test('called with nothing', () => {
    const r = assessDeal();
    assertAllFinite(r);
    assert.equal(r.netProfit, 0);
    assert.ok(['loss', 'tight', 'good'].includes(r.verdict));
    assert.ok(Array.isArray(r.reasons));
  });

  test('garbage in any argument never produces NaN or Infinity', () => {
    const base = { salePrice: 450, buyPrice: 300, extraCosts: 5, trip: SOUTHAMPTON, hourlyRate: 20, targetMargin: 0.25 };
    for (const key of Object.keys(base)) {
      for (const v of GARBAGE) {
        const r = assessDeal({ ...base, [key]: v });
        assertAllFinite(r, `${key}=${String(v)}`);
        assert.ok(['loss', 'tight', 'good'].includes(r.verdict));
        assert.ok(r.reasons.every((s) => !/NaN|Infinity|undefined/.test(s)), r.reasons.join(' | '));
      }
    }
  });
});

// ---- dealNumber ------------------------------------------------------------------------

describe('dealNumber', () => {
  test('pads to four digits with the SM prefix', () => {
    assert.equal(dealNumber(7), 'SM-0007');
    assert.equal(dealNumber(42), 'SM-0042');
    assert.equal(dealNumber(1234), 'SM-1234');
    assert.equal(dealNumber(12345), 'SM-12345');
    assert.equal(dealNumber('7'), 'SM-0007');
  });

  test('no number yet gives an empty string', () => {
    for (const v of [null, undefined, '', 0, -3, 'abc', NaN]) assert.equal(dealNumber(v), '', String(v));
  });
});

test('pay → deliver timing', async () => {
  const { paidInFullDate, payToDeliverDays, averagePayToDeliver } = await import('../public/desk/lib/calc.js');
  const deal = (due, payments, extra = {}) => ({ due_date: due, items: [{ qty: 1, unit_price: 450 }], payments, ...extra });
  const a = deal('2026-09-20', [{ amount: 200, paid_at: '2026-09-10' }, { amount: 250, paid_at: '2026-09-14' }]);
  assert.equal(paidInFullDate(a), '2026-09-14');
  assert.equal(payToDeliverDays(a), 6);
  const b = deal('2026-09-20', [{ amount: 450, paid_at: '2026-09-23' }]);
  assert.equal(payToDeliverDays(b), -3);
  assert.equal(payToDeliverDays(deal('2026-09-20', [{ amount: 100, paid_at: '2026-09-10' }])), null); // part paid
  assert.equal(payToDeliverDays(deal(null, [{ amount: 450, paid_at: '2026-09-10' }])), null); // no delivery date
  assert.equal(payToDeliverDays(deal('2026-09-20', [{ amount: 450, paid_at: '2026-09-10' }], { status: 'cancelled' })), null);
  assert.deepEqual(averagePayToDeliver([a, b, deal(null, [])]), { days: 1.5, count: 2 });
  assert.equal(averagePayToDeliver([]), null);
});

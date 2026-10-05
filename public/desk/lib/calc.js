// Sizemill Desk money and trip maths: the single source of truth for every derived figure.
//
// Pure ES module (no DOM, no imports, no I/O) so the browser and the Node tests share it.
// Every function tolerates null/undefined/strings, coercing with num(), and never returns
// NaN or Infinity; `null` means "not defined" (for example a per-hour rate with no hours).
// Results are unrounded; rounding for display happens in format.js.

export const LITRES_PER_UK_GALLON = 4.54609;

// Half a penny: money closer to zero than this is treated as zero (payment status, owed,
// verdicts), so floating-point dust never flips a result the UI shows as £0.00.
export const EPS = 0.005;

const REALISED_STATUSES = new Set(['delivered', 'completed']);
const TRUE_STRINGS = new Set(['true', '1', 'yes', 'on']);

// ---- coercion helpers ------------------------------------------------------------------

export function num(v) {
  let n;
  try {
    n = Number(v);
  } catch {
    return 0; // Number() throws on Symbols
  }
  return Number.isFinite(n) ? n || 0 : 0; // `|| 0` also turns -0 into 0
}

export function round2(n) {
  const value = num(n);
  const scaled = (value + Number.EPSILON) * 100;
  // Past 2^53 pence a double cannot hold pence at all, and rounding would only add error.
  return Math.abs(scaled) < Number.MAX_SAFE_INTEGER ? Math.round(scaled) / 100 : value;
}

// Distances, times, fuel prices and trip costs cannot be negative; a stray minus sign
// in a form must not turn a cost into income.
function nonNeg(v) {
  return Math.max(0, num(v));
}

// Form state can carry booleans as strings, and 'false' is truthy.
function flag(v) {
  if (typeof v === 'string') return TRUE_STRINGS.has(v.trim().toLowerCase());
  return Boolean(v);
}

// True when v holds a real number, as opposed to null, blank or garbage that num() maps to 0.
function isPresent(v) {
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string') return v.trim() !== '' && Number.isFinite(Number(v));
  return false;
}

// Child collections may be missing or contain holes; only object rows count.
function rows(v) {
  return Array.isArray(v) ? v.filter((row) => row !== null && typeof row === 'object') : [];
}

// a / b, or null when the ratio is undefined (b <= 0) or not finite.
function ratio(a, b) {
  if (!(b > 0)) return null;
  const r = a / b;
  return Number.isFinite(r) ? r : null;
}

// Absurd magnitudes (1e300 miles at 1e300 £/h) can overflow; never let Infinity/NaN escape.
// Also folds -0 into 0 so results compare cleanly.
function finiteNumbers(record) {
  for (const key of Object.keys(record)) {
    const v = record[key];
    if (typeof v === 'number') record[key] = Number.isFinite(v) ? v + 0 : 0;
  }
  return record;
}

// 'YYYY-MM-DD' prefix of an ISO date or timestamp, or null.
function dayKey(v) {
  if (typeof v !== 'string') return null;
  const match = /^\d{4}-\d{2}-\d{2}/.exec(v.trim());
  return match ? match[0] : null;
}

// ---- trips -----------------------------------------------------------------------------

function litresFor(miles, mpg) {
  const economy = num(mpg);
  return economy > 0 ? (nonNeg(miles) / economy) * LITRES_PER_UK_GALLON : 0;
}

export function fuelCost(miles, mpg, ppl) {
  const cost = (litresFor(miles, mpg) * nonNeg(ppl)) / 100;
  return Number.isFinite(cost) ? cost : 0;
}

export function tripTotals(trip) {
  const t = trip ?? {};
  const legs = flag(t.round_trip) ? 2 : 1;
  const miles = nonNeg(t.one_way_miles) * legs;
  const drivingMinutes = nonNeg(t.one_way_minutes) * legs;
  const totalMinutes = drivingMinutes + nonNeg(t.extra_minutes);
  const fuel = fuelCost(miles, t.mpg, t.fuel_ppl);
  const wearCost = miles * nonNeg(t.vehicle_cost_per_mile);
  const otherCosts = nonNeg(t.other_costs);
  const cashCost = fuel + wearCost + otherCosts;
  const timeCost = (nonNeg(t.hourly_rate) * totalMinutes) / 60;
  return finiteNumbers({
    miles,
    drivingMinutes,
    totalMinutes,
    litres: litresFor(miles, t.mpg),
    fuelCost: fuel,
    wearCost,
    otherCosts,
    cashCost,
    timeCost,
    fullCost: cashCost + timeCost,
  });
}

// ---- deal items / deals ----------------------------------------------------------------

// cost_status defaults to 'expected' in the database, so anything not 'actual' is expected.
function isActual(item) {
  return item?.cost_status === 'actual';
}

export function itemCost(item) {
  return isActual(item) ? num(item.unit_cost) : num(item?.expected_unit_cost);
}

export function itemTotals(item) {
  const it = item ?? {};
  const qty = num(it.qty);
  const isExpected = !isActual(it);
  // Positive variance = bought cheaper than expected. Items pulled from stock have no
  // expected cost, so they have no variance.
  const variance =
    !isExpected && isPresent(it.expected_unit_cost) && isPresent(it.unit_cost)
      ? (num(it.expected_unit_cost) - num(it.unit_cost)) * qty
      : null;
  return finiteNumbers({
    revenue: qty * num(it.unit_price),
    cost: qty * itemCost(it),
    isExpected,
    variance,
  });
}

function paymentStatusFor(revenue, paid) {
  if (revenue <= EPS) return paid > EPS ? 'paid' : 'none';
  if (paid >= revenue - EPS) return 'paid';
  return paid > EPS ? 'part' : 'unpaid';
}

function bucketFor(status, certainty, paymentStatus) {
  if (status === 'cancelled') return 'cancelled';
  if (certainty === 'confirmed' && paymentStatus === 'paid' && REALISED_STATUSES.has(status)) {
    return 'realised';
  }
  return 'pending';
}

// When `children` is omitted the deal's own items/costs/payments/trips are used, so a row
// from store.deals.list() can be passed on its own.
export function dealTotals(deal, children = deal) {
  const { items, costs, payments, trips } = children ?? {};

  let revenue = 0;
  let goodsCostActual = 0;
  let goodsCostExpected = 0;
  let expectedCount = 0;
  let varianceSum = 0;
  let hasVariance = false;
  for (const item of rows(items)) {
    const t = itemTotals(item);
    revenue += t.revenue;
    if (t.isExpected) {
      goodsCostExpected += t.cost;
      expectedCount += 1;
    } else {
      goodsCostActual += t.cost;
    }
    if (t.variance !== null) {
      varianceSum += t.variance;
      hasVariance = true;
    }
  }

  let extraCosts = 0;
  let extraCostsExpected = 0;
  for (const cost of rows(costs)) {
    const amount = num(cost.amount);
    extraCosts += amount;
    if (flag(cost.is_expected)) {
      extraCostsExpected += amount;
      expectedCount += 1;
    }
  }

  let travelCost = 0;
  let timeCost = 0;
  let drivingMinutes = 0;
  let totalMinutes = 0;
  let miles = 0;
  for (const trip of rows(trips)) {
    const t = tripTotals(trip);
    travelCost += t.cashCost;
    timeCost += t.timeCost;
    drivingMinutes += t.drivingMinutes;
    totalMinutes += t.totalMinutes;
    miles += t.miles;
  }

  const paid = rows(payments).reduce((sum, p) => sum + num(p.amount), 0);

  const goodsCost = goodsCostActual + goodsCostExpected;
  const grossProfit = revenue - goodsCost - extraCosts;
  const netProfit = grossProfit - travelCost;
  const certainty = expectedCount ? 'estimated' : 'confirmed';
  const paymentStatus = paymentStatusFor(revenue, paid);

  return finiteNumbers({
    revenue,
    goodsCost,
    goodsCostActual,
    goodsCostExpected,
    extraCosts,
    extraCostsExpected,
    grossProfit,
    travelCost,
    timeCost,
    netProfit,
    trueProfit: netProfit - timeCost,
    margin: revenue > 0 ? ratio(netProfit, revenue) : null,
    drivingMinutes,
    totalMinutes,
    miles,
    perDrivingHour: ratio(netProfit, drivingMinutes / 60),
    perHourAllIn: ratio(netProfit, totalMinutes / 60),
    expectedCount,
    certainty,
    variance: hasVariance ? varianceSum : null,
    paid,
    balance: revenue - paid,
    paymentStatus,
    bucket: bucketFor(deal?.status, certainty, paymentStatus),
  });
}

// Totals across deals, optionally limited to sale_date within [from, to] (inclusive ISO
// dates). Cancelled deals are excluded from every figure. perDrivingHour is the net profit
// of deals that involved driving divided by the hours driven for them, so posted or
// collected sales don't inflate the rate.
export function summarise(dealsWithChildren, range = {}) {
  const fromDay = dayKey(range?.from);
  const toDay = dayKey(range?.to);

  const summary = {
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
  let drivenProfit = 0;
  const months = new Map();

  for (const deal of rows(dealsWithChildren)) {
    if (deal.status === 'cancelled') continue;
    const day = dayKey(deal.sale_date);
    if ((fromDay || toDay) && !day) continue;
    if (fromDay && day < fromDay) continue;
    if (toDay && day > toDay) continue;

    const t = dealTotals(deal, deal);
    const realised = t.bucket === 'realised';
    summary.count += 1;
    summary.revenue += t.revenue;
    summary.netProfit += t.netProfit;
    if (realised) summary.realisedProfit += t.netProfit;
    else summary.pendingProfit += t.netProfit;
    if (t.balance > EPS) summary.owed += t.balance;
    summary.toSource += rows(deal.items).filter((item) => !isActual(item)).length;
    summary.drivingMinutes += t.drivingMinutes;
    summary.miles += t.miles;
    if (t.drivingMinutes > 0) drivenProfit += t.netProfit;

    if (day) {
      const key = day.slice(0, 7);
      let month = months.get(key);
      if (!month) {
        month = { month: key, revenue: 0, realised: 0, pending: 0 };
        months.set(key, month);
      }
      month.revenue += t.revenue;
      if (realised) month.realised += t.netProfit;
      else month.pending += t.netProfit;
    }
  }

  summary.perDrivingHour = ratio(drivenProfit, summary.drivingMinutes / 60);
  summary.byMonth = [...months.values()]
    .sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0))
    .map(finiteNumbers);
  return finiteNumbers(summary);
}

// ---- stock -----------------------------------------------------------------------------

// Map stock id -> { allocated, onHand, value }. A stock line is allocated by deal items
// that reference it on any deal that is not cancelled. onHand goes negative when more has
// been sold than was bought (so the UI can flag it), but value never drops below zero.
export function stockLevels(stockItems, dealsWithChildren) {
  const allocatedById = new Map();
  for (const deal of rows(dealsWithChildren)) {
    if (deal.status === 'cancelled') continue;
    for (const item of rows(deal.items)) {
      const id = item.stock_item_id;
      if (id === null || id === undefined || id === '') continue;
      allocatedById.set(id, (allocatedById.get(id) ?? 0) + num(item.qty));
    }
  }

  const levels = new Map();
  for (const stock of rows(stockItems)) {
    if (stock.id === null || stock.id === undefined) continue;
    const allocated = allocatedById.get(stock.id) ?? 0;
    const onHand = num(stock.qty) - allocated;
    levels.set(
      stock.id,
      finiteNumbers({ allocated, onHand, value: Math.max(0, onHand) * num(stock.unit_cost) }),
    );
  }
  return levels;
}

// ---- deal checker ----------------------------------------------------------------------

// Plain amounts for verdict reasons; format.js stays the formatter for everything shown
// as a figure.
function gbp(n) {
  const value = round2(Math.abs(n));
  return `£${value.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const PERCENT = new Intl.NumberFormat('en-GB', { style: 'percent', maximumFractionDigits: 0 });

// Intl scales without overflow (a 1e308 target is garbage, but must not read 'Infinity%');
// near-zero is pinned to 0 so it never reads '-0%'.
function percent(r) {
  return PERCENT.format(Math.abs(r) < 0.005 ? 0 : r);
}

// Time is costed at `hourlyRate`; when the caller leaves it out, the trip's own
// hourly_rate is used. A trip contributes nothing when `trip` is null.
export function assessDeal({
  salePrice,
  buyPrice,
  extraCosts = 0,
  trip = null,
  hourlyRate,
  targetMargin = 0,
} = {}) {
  const revenue = num(salePrice);
  const goodsCost = num(buyPrice);
  const extras = num(extraCosts);
  const target = num(targetMargin);

  const hasTrip = trip !== null && typeof trip === 'object';
  const rate = isPresent(hourlyRate) ? nonNeg(hourlyRate) : hasTrip ? nonNeg(trip.hourly_rate) : 0;
  const travel = hasTrip ? tripTotals({ ...trip, hourly_rate: rate }) : tripTotals(null);

  const travelCost = travel.cashCost;
  const timeCost = travel.timeCost;
  const grossProfit = revenue - goodsCost - extras;
  const netProfit = grossProfit - travelCost;
  const trueProfit = netProfit - timeCost;
  const margin = revenue > 0 ? ratio(netProfit, revenue) : null;
  const breakEvenPrice = goodsCost + extras + travelCost;
  const priceForRate = breakEvenPrice + timeCost;
  const priceForMargin = target < 1 ? breakEvenPrice / (1 - target) : null;
  const perDrivingHour = ratio(netProfit, travel.drivingMinutes / 60);

  const reasons = [];
  let verdict;
  if (netProfit < -EPS) {
    verdict = 'loss';
    reasons.push(
      grossProfit < -EPS
        ? `Goods and extras cost ${gbp(goodsCost + extras)}, more than the ${gbp(revenue)} sale price.`
        : `The drive costs ${gbp(travelCost)}, more than the ${gbp(grossProfit)} left after goods and extras.`,
      `You need ${gbp(breakEvenPrice)} just to break even.`,
    );
  } else {
    const shortOnTime = trueProfit < -EPS;
    // Compared in money (with EPS) rather than as a ratio, so selling at exactly
    // priceForMargin is not marked tight by floating-point error.
    const belowMargin = target > 0 && (margin === null || netProfit < target * revenue - EPS);
    if (shortOnTime) {
      reasons.push(
        `${gbp(netProfit)} profit doesn't cover your time (${gbp(timeCost)} at ${gbp(rate)}/h); ` +
          `sell at ${gbp(priceForRate)} to cover it.`,
      );
    }
    if (belowMargin) {
      if (margin === null) reasons.push('No sale price yet, so no margin.');
      else {
        const fix = priceForMargin !== null ? `; sell at ${gbp(priceForMargin)} to hit it` : '';
        reasons.push(`Margin is ${percent(margin)}, under your ${percent(target)} target${fix}.`);
      }
    }
    verdict = shortOnTime || belowMargin ? 'tight' : 'good';
    if (verdict === 'good') {
      reasons.push(
        margin === null
          ? `Makes ${gbp(netProfit)} profit.`
          : `Makes ${gbp(netProfit)} profit, a ${percent(margin)} margin.`,
      );
      if (timeCost > 0) reasons.push(`${gbp(trueProfit)} left after paying yourself ${gbp(rate)}/h.`);
      if (perDrivingHour !== null) reasons.push(`Earns ${gbp(perDrivingHour)} per driving hour.`);
    }
  }

  return finiteNumbers({
    revenue,
    goodsCost,
    extraCosts: extras,
    travelCost,
    timeCost,
    netProfit,
    trueProfit,
    margin,
    perDrivingHour,
    perHourAllIn: ratio(netProfit, travel.totalMinutes / 60),
    breakEvenPrice,
    priceForRate,
    priceForMargin,
    maxBuyPrice: revenue - extras - travelCost - timeCost,
    verdict,
    reasons,
  });
}

export function dealNumber(n) {
  const value = Math.trunc(num(n));
  return value > 0 ? `SM-${String(value).padStart(4, '0')}` : '';
}

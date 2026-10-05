# Sizemill Desk — build spec (v1)

Sizemill Desk is the owner's private sales, stock and profit system. The owner sells
sneakers and clothing to professional footballers in the UK, often agreeing a sale before
the item is bought ("expected cost"), then driving to drop it off. Desk answers, at any
moment: what did I make, what am I still expecting to make, who owes me, what must I still
buy, and was the drive worth it.

It lives at **https://www.sizemill.com/desk/** beside the existing app at `/` (left untouched).
Currency is GBP, distances are miles, fuel economy is UK mpg (imperial gallon = 4.54609 L),
fuel prices are pence per litre (ppl). Locale `en-GB`, dates shown `5 Oct 2026`.

This file is the contract between everyone building Desk. Names below are exact.

---------------------------------------------------------------------------------------------

## 1. Stack and layout

- No build step. Vercel serves `public/` statically and `api/*.js` as Node 24 functions
  (ES modules, `export default async function handler(req, res)`). Files under `api/_lib/`
  are shared modules, not routes (Vercel ignores `_`-prefixed paths as functions).
- Front end: native ES modules + Preact/htm, imported ONLY through `public/desk/lib/preact.js`:
  ```js
  export * from 'https://cdn.jsdelivr.net/npm/htm@3.1.1/preact/standalone.module.js';
  // gives: html, render, h, Component, useState, useEffect, useMemo, useRef, useCallback, useReducer, useContext, createContext, useLayoutEffect
  ```
- Supabase JS v2 UMD pinned: `https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js` (global `supabase`).
- Leaflet 1.9.4 from cdnjs (`leaflet.min.css`, `leaflet.min.js`, global `L`) with OpenStreetMap tiles and attribution.
- Supabase project URL `https://qromnxxviflpahimjhgq.supabase.co`, publishable key
  `sb_publishable_u1ywcwe7Wqb9s6Z55VskIQ_pepm1rYk` (public by design; RLS protects data).
  Same origin as the old app, so a session signed in there is already signed in here.
- Tests: Node's built-in runner, `node --test test/`. No npm dependencies. Root `package.json`
  is `{ "name": "sizemill", "private": true, "type": "module", "scripts": { "test": "node --test test/" } }`.

```
public/desk/
  index.html            shell: fonts, leaflet, supabase umd, <div id="app">, module app.js
  desk.css              all styles (tokens, light + dark, mobile first)
  app.js                boot, auth gate, router, layout (sidebar desktop, bottom tabs mobile)
  lib/preact.js         re-export of preact/htm standalone (only place the CDN URL appears)
  lib/calc.js           PURE money/trip maths. No DOM, no imports except none. Node-testable.
  lib/format.js         PURE formatters (money, miles, duration, dates). Node-testable.
  lib/store.js          data layer: Supabase implementation + memory implementation (?local=1)
  lib/ui.js             shared components + toast/confirm/modal helpers
  components/address-input.js   address/postcode box with suggestions (uses store.api.places)
  components/route-map.js       Leaflet map drawing a route geometry
  components/trip-planner.js    origin → destination → miles/time/fuel/time-cost; used by
                                calculator, deal page and trips page
  components/charts.js          small inline-SVG charts (bars, sparkline)
  views/dashboard.js  views/deals.js  views/deal.js  views/clients.js  views/client.js
  views/stock.js  views/trips.js  views/calculator.js  views/settings.js
api/
  _lib/http.js   _lib/auth.js   _lib/geo.js   _lib/fuel.js
  route.js   places.js   fuel.js
supabase/migrations/20261005120000_desk_core.sql
test/calc.test.js  test/format.test.js  test/fuel.test.js  test/geo.test.js  test/store-memory.test.js
```

---------------------------------------------------------------------------------------------

## 2. Database (Supabase Postgres 17), all in `public`

Every table: `owner uuid not null default auth.uid() references auth.users(id) on delete cascade`,
RLS enabled, one policy per command for role `authenticated` with
`using (owner = (select auth.uid()))` and `with check (owner = (select auth.uid()))`.
Child rows' `with check` ALSO proves the parent belongs to the caller (e.g.
`exists (select 1 from public.deals d where d.id = deal_id and d.owner = (select auth.uid()))`),
same for `deals.client_id`, `deal_items.stock_item_id`, `trips.deal_id`, `trips.client_id`
(nullable FKs: check only when not null). `anon` gets nothing. `updated_at` maintained by a
trigger where the column exists. Index every FK and `owner`.
Money `numeric(12,2)`; Postgres numeric arrives in supabase-js as a JS number.

### desk_settings (one row per owner, PK owner)
| column | type | default |
|---|---|---|
| owner | uuid PK | auth.uid() |
| business_name | text | 'Sizemill' |
| home_label | text | null |
| home_address | text | null |
| home_lat, home_lng | double precision | null |
| mpg | numeric(5,1) not null check > 0 | 45 |
| fuel_type | text not null check in ('E10','E5','B7','SDV') | 'E10' |
| hourly_rate | numeric(8,2) not null check >= 0 | 20 |
| vehicle_cost_per_mile | numeric(6,3) not null check >= 0 | 0 |
| round_trip_default | boolean not null | true |
| handover_minutes_default | integer not null check >= 0 | 15 |
| target_margin | numeric(5,2) not null | 0.25 (25%) |
| updated_at | timestamptz not null | now() |

### clients
id uuid PK default gen_random_uuid(), owner, name text not null, club text, position text,
squad_number text, agent_name text, agent_phone text, agent_email text, phone text,
email text, instagram text, shoe_size text, clothing_size text, preferences text,
notes text, tags text[] not null default '{}', birthday date,
addresses jsonb not null default '[]'  -- [{ "label": "Training ground", "address": "...", "lat": 50.9, "lng": -1.4 }]
archived boolean not null default false, created_at, updated_at.

### stock_items (things bought and held, not yet tied to a sale)
id, owner, name text not null, brand text, sku text, size text,
condition text not null default 'new' check in ('new','used'), qty integer not null default 1 check (qty >= 0),
unit_cost numeric(12,2) not null check >= 0, bought_at date default current_date, supplier text,
location text, notes text, archived boolean not null default false, created_at, updated_at.
On-hand = qty − Σ deal_items.qty where stock_item_id = this and the deal is not cancelled (computed in calc.js).

### deals (a sale to a client; may hold several items)
id, owner, number integer not null — per-owner sequence set by a BEFORE INSERT trigger
(max(number) for that owner + 1, unique (owner, number)); shown as `SM-0007`.
client_id uuid null references clients on delete set null, title text,
status text not null default 'agreed' check in ('enquiry','agreed','sourcing','ready','delivered','completed','cancelled'),
sale_date date not null default current_date, due_date date,
delivery_method text not null default 'drop_off' check in ('drop_off','meet','post','collection'),
notes text, created_at, updated_at.

### deal_items
id, owner, deal_id uuid not null references deals on delete cascade, position integer not null default 0,
description text not null, brand text, sku text, size text, qty integer not null default 1 check (qty > 0),
unit_price numeric(12,2) not null default 0 check >= 0,
cost_status text not null default 'expected' check in ('expected','actual'),
expected_unit_cost numeric(12,2) check >= 0,
unit_cost numeric(12,2) check >= 0,
check (cost_status <> 'actual' or unit_cost is not null),
check (cost_status <> 'expected' or expected_unit_cost is not null),
stock_item_id uuid null references stock_items on delete set null, supplier text, sourced_at date, created_at.
When an item is pulled from stock: cost_status 'actual', unit_cost = stock unit_cost.
When an expected item is bought: cost_status → 'actual', unit_cost set, expected_unit_cost KEPT
(drives "variance vs expected").

### deal_costs (non-goods costs on a deal: postage, fees, packaging…)
id, owner, deal_id not null references deals on delete cascade, label text not null,
kind text not null default 'other' check in ('shipping','fees','packaging','other'),
amount numeric(12,2) not null check >= 0, is_expected boolean not null default false, created_at.

### payments
id, owner, deal_id not null references deals on delete cascade, amount numeric(12,2) not null check (amount <> 0) (negative = refund),
method text not null default 'bank' check in ('cash','bank','card','other'),
paid_at date not null default current_date, note text, created_at.

### trips (a drive; optionally tied to a deal and/or client)
id, owner, deal_id uuid null references deals on delete set null, client_id uuid null references clients on delete set null,
trip_date date not null default current_date, label text,
origin_label text, origin_address text, origin_lat double precision, origin_lng double precision,
dest_label text, dest_address text, dest_lat double precision, dest_lng double precision,
one_way_miles numeric(8,2) not null check >= 0, one_way_minutes numeric(8,1) not null check >= 0,
round_trip boolean not null default true, extra_minutes integer not null default 0 check >= 0,
mpg numeric(5,1) not null check > 0, fuel_type text, fuel_ppl numeric(6,1) not null check > 0,
fuel_source text,             -- e.g. 'Median of 14 stations within 5 mi · 05 Oct 10:59' or 'manual'
hourly_rate numeric(8,2) not null default 0, vehicle_cost_per_mile numeric(6,3) not null default 0,
other_costs numeric(10,2) not null default 0, other_costs_note text,
route_provider text,          -- 'osrm' | 'google' | 'manual'
route_geometry jsonb,         -- [[lat,lng], …] ≤ 400 points, one way
created_at, updated_at.
A trip stores inputs only; all derived numbers come from calc.js.

---------------------------------------------------------------------------------------------

## 3. Money maths — `public/desk/lib/calc.js` (single source of truth)

All functions pure, tolerate `null`/`undefined`/strings (coerce with `num(v) = Number(v) || 0`),
never return NaN or Infinity (use `null` for "not defined", e.g. per-hour with 0 hours).
Return values are unrounded numbers; rounding happens in format.js. Export exactly:

```js
export const LITRES_PER_UK_GALLON = 4.54609;
export const EPS = 0.005;
export function num(v)                       // Number(v)||0, but NaN/Infinity -> 0
export function round2(n)                    // Math.round((n + Number.EPSILON) * 100) / 100

// ---- trips ----
export function fuelCost(miles, mpg, ppl)    // miles / mpg * 4.54609 * ppl / 100 ; 0 if mpg<=0
export function tripTotals(trip)
// trip: { one_way_miles, one_way_minutes, round_trip, extra_minutes, mpg, fuel_ppl,
//         hourly_rate, vehicle_cost_per_mile, other_costs }
// returns {
//   miles,            // one_way_miles * (round_trip ? 2 : 1)
//   drivingMinutes,   // one_way_minutes * (round_trip ? 2 : 1)
//   totalMinutes,     // drivingMinutes + extra_minutes
//   litres,           // miles / mpg * 4.54609
//   fuelCost, wearCost /* miles*vehicle_cost_per_mile */, otherCosts,
//   cashCost,         // fuelCost + wearCost + otherCosts   (money that leaves your pocket)
//   timeCost,         // hourly_rate * totalMinutes / 60    (what your time is worth)
//   fullCost          // cashCost + timeCost
// }

// ---- deal items / deals ----
export function itemCost(item)               // unit cost actually used: actual -> unit_cost, expected -> expected_unit_cost
export function itemTotals(item)             // { revenue, cost, isExpected, variance } ; variance = (expected-actual)*qty when actual and expected both known, else null (positive = cheaper than expected)
export function dealTotals(deal, { items = [], costs = [], payments = [], trips = [] } = {})
// returns {
//   revenue,                // Σ qty*unit_price
//   goodsCost, goodsCostActual, goodsCostExpected,
//   extraCosts, extraCostsExpected,
//   grossProfit,            // revenue - goodsCost - extraCosts
//   travelCost,             // Σ tripTotals(t).cashCost
//   timeCost,               // Σ tripTotals(t).timeCost
//   netProfit,              // grossProfit - travelCost        ("profit")
//   trueProfit,             // netProfit - timeCost            ("after paying yourself")
//   margin,                 // revenue>0 ? netProfit/revenue : null
//   drivingMinutes, totalMinutes, miles,
//   perDrivingHour,         // drivingMinutes>0 ? netProfit/(drivingMinutes/60) : null
//   perHourAllIn,           // totalMinutes>0 ? netProfit/(totalMinutes/60) : null
//   expectedCount,          // items with cost_status 'expected' + costs with is_expected
//   certainty,              // expectedCount ? 'estimated' : 'confirmed'
//   variance,               // Σ item variances (null if none)
//   paid,                   // Σ payments.amount
//   balance,                // revenue - paid
//   paymentStatus,          // revenue<=EPS ? (paid>EPS?'paid':'none') : paid>=revenue-EPS ? 'paid' : paid>EPS ? 'part' : 'unpaid'
//   bucket                  // 'cancelled' if status cancelled;
//                           // 'realised' if certainty confirmed AND paymentStatus 'paid' AND status in (delivered, completed);
//                           // otherwise 'pending'
// }
export function summarise(dealsWithChildren, { from, to } = {})
// dealsWithChildren: [{ ...deal, items, costs, payments, trips }]; from/to ISO dates filter on sale_date (inclusive)
// returns { count, revenue, realisedProfit, pendingProfit, netProfit, owed /* Σ positive balances of non-cancelled */,
//           toSource /* count of expected items in non-cancelled deals */, drivingMinutes, miles,
//           perDrivingHour, byMonth: [{ month:'2026-10', revenue, realised, pending }] (sorted asc) }
// Cancelled deals excluded from every figure.

// ---- stock ----
export function stockLevels(stockItems, dealsWithChildren) // -> Map id -> { allocated, onHand, value /* onHand*unit_cost */ }

// ---- deal checker (standalone calculator and "is it worth it") ----
export function assessDeal({ salePrice, buyPrice, extraCosts = 0, trip = null, hourlyRate = 0, targetMargin = 0 })
// trip: same shape as tripTotals input or null
// returns {
//   revenue, goodsCost, extraCosts, travelCost, timeCost, netProfit, trueProfit, margin,
//   perDrivingHour, perHourAllIn,
//   breakEvenPrice,        // goodsCost + extraCosts + travelCost
//   priceForRate,          // breakEvenPrice + timeCost  (price where you also earn hourlyRate for the time)
//   priceForMargin,        // targetMargin<1 ? (goodsCost+extraCosts+travelCost)/(1-targetMargin) : null
//   maxBuyPrice,           // salePrice - extraCosts - travelCost - timeCost (most you can pay and still hit your rate)
//   verdict,               // 'loss' if netProfit < 0 ; 'tight' if trueProfit < 0 or (targetMargin && margin < targetMargin) ; else 'good'
//   reasons: [string]      // short plain-English reasons for the verdict
// }
export function dealNumber(n)                // 7 -> 'SM-0007'
```

Worked example (must be a unit test): London → Southampton round trip, one way 80.0 mi /
110 min, 15 min handover, 45 mpg, 140.0 ppl, £20/h, no wear, no other costs.
miles 160, litres 160/45*4.54609 = 16.1639…, fuel £22.629…, driving 220 min, total 235 min,
time £78.333…; sale £450, bought £300 → net £127.37, true £49.04, per driving hour £34.74.

## 4. Formatting — `public/desk/lib/format.js`
`money(n, {sign=false, pence=true})` → '£1,234.50' / '−£12.00' (U+2212 minus) / '+£5.00' with sign; null → '—'.
`moneyShort(n)` → '£1.2k' above 10k else money without pence. `pct(r)` (0.253 → '25%'; null '—').
`miles(n)` → '160 mi' (1 dp under 10). `duration(min)` → '3h 40m' / '45m'. `ppl(n)` → '140.9p/L'.
`date(iso)` → '5 Oct 2026'; `dateShort(iso)` → '5 Oct'; `monthLabel('2026-10')` → 'Oct 26'.
`todayISO()` local date 'YYYY-MM-DD'. `relDays(iso)` → 'today' / 'in 3 days' / '2 days ago'.
`plural(n, 'item')`. `escape` is not needed (Preact escapes).

---------------------------------------------------------------------------------------------

## 5. Server API (Vercel functions). JSON in/out, `Cache-Control: no-store` unless stated.

Errors: `{ error: "human sentence" }` with 4xx/5xx. Never leak keys. Outbound fetches use
`AbortSignal.timeout(8000)` and a UA `Sizemill/1.0 (+https://www.sizemill.com)`.

- `api/_lib/http.js`: `send(res, status, body, headers)`, `readJson(req)`, `allow(req, res, methods)`,
  `fetchJson(url, opts)` (timeout, throws Error with status on non-2xx).
- `api/_lib/auth.js`: `requireUser(req)` → reads `Authorization: Bearer <access token>`, verifies by
  `GET ${SUPABASE_URL}/auth/v1/user` with headers `apikey: SUPABASE_SERVICE_ROLE_KEY` and the bearer;
  caches valid tokens (SHA-256 of token → user, until min(5 min, token exp)); throws
  `{ status: 401 }` errors. Env: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (both already set in Vercel).
- `api/_lib/geo.js`:
  - `parseLatLng(str)` → `{lat,lng}` or null for "50.9,-1.4".
  - `isUkPostcode(str)`, `isUkOutcode(str)`.
  - `geocode(query)` → `{ label, address, lat, lng, postcode, source }`. Order: lat,lng literal →
    full UK postcode via `https://api.postcodes.io/postcodes/{pc}` → outcode via `/outcodes/{oc}` →
    Google Geocoding if `GOOGLE_MAPS_API_KEY` → Nominatim `https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=gb&limit=1&q=` (also try with a postcode found inside a longer address string first).
  - `suggest(q)` → up to 6 `{ label, address, lat, lng, source }`: postcode-ish → postcodes.io
    `/postcodes?q=` (autocomplete) ; else Google Places Text Search if key, else Nominatim limit 6.
  - `route(a, b)` where a/b are `{lat,lng}` → `{ miles, minutes, geometry:[[lat,lng]…], provider, traffic }`.
    If `GOOGLE_MAPS_API_KEY`: Routes API `POST https://routes.googleapis.com/directions/v2:computeRoutes`
    (`travelMode DRIVE`, `routingPreference TRAFFIC_AWARE`, field mask `routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline`), traffic true.
    Else / on failure: OSRM `https://router.project-osrm.org/route/v1/driving/{lng},{lat};{lng},{lat}?overview=simplified&geometries=geojson`, traffic false.
    miles = meters / 1609.344, minutes = seconds / 60. Geometry downsampled to ≤ 400 points.
  - `decodePolyline(str)` for Google.
- `api/_lib/fuel.js`:
  - `FEEDS` = Asda `https://storelocator.asda.com/fuel_prices_data.json`, Esso `https://fuelprices.esso.co.uk/latestdata.json`,
    JET `https://jetlocal.co.uk/fuel_prices_data.json`, Moto `https://moto-way.com/fuel-price/fuel_prices.json`,
    MFG `https://fuel.motorfuelgroup.com/fuel_prices_data.json`, Rontec `https://www.rontec-servicestations.co.uk/fuel-prices/data/fuel_prices_data.json`,
    Tesco `https://www.tesco.com/fuel_prices/fuel_prices_data.json`, Morrisons `https://www.morrisons.com/fuel-prices/fuel.json`,
    Sainsbury's `https://api.sainsburys.co.uk/v1/exports/latest/fuel_prices_data.json`, Applegreen `https://applegreenstores.com/fuel-prices/data.json`,
    Shell `https://www.shell.co.uk/fuel-prices-data.html`, BP `https://www.bp.com/en_gb/united-kingdom/home/fuelprices/fuel_prices_data.json`.
    (CMA open-data scheme; format `{ last_updated: "05/10/2026 09:59:17", stations: [{ site_id, brand, address, postcode, location:{latitude,longitude}, prices:{E10,E5,B7,SDV} }] }`;
    some feeds omit last_updated, use strings for coordinates, or give £ not pence.)
  - `parseFeed(json, name)` → `{ name, updated: ISO|null, stations: [{ id, brand, address, postcode, lat, lng, prices:{E10,E5,B7,SDV} }] }`
    normalising: numbers from strings, price < 10 → ×100, keep 80 ≤ ppl ≤ 300 only, drop stations without coords.
    `last_updated` is UK local time "dd/mm/yyyy hh:mm:ss" (treat as Europe/London).
  - `loadAll({ now, fetchImpl })` fetches all feeds concurrently (failures tolerated), drops feeds whose
    `updated` is older than 7 days (feeds with no date are kept but flagged), dedupes stations by site_id,
    caches the result in module memory for 20 minutes.
  - `priceNear({ lat, lng, type, stations })` → tries radius 3, 6, 10, 20 miles until ≥ 3 priced stations;
    returns `{ type, ppl /* median */, mean, min, max, count, radiusMiles, cheapest:{brand,address,postcode,ppl,miles}, nearest:{…} }`
    or national fallback `{ …, radiusMiles: null, scope: 'national' }`.
  - `haversineMiles(a, b)`, `median(arr)`.
- `GET /api/fuel?lat=&lng=&type=E10` (no auth; public data) → `{ ok, type, ppl, mean, min, max, count, radiusMiles, scope, cheapest, nearest, national:{ ppl, count }, feeds:[{ name, ok, updated, stations, stale }], fetchedAt }`.
  `Cache-Control: public, s-maxage=900, stale-while-revalidate=3600`. lat/lng optional (national only). Validate type.
- `GET /api/places?q=` (auth) → `{ ok, results:[{ label, address, lat, lng, source }] }`. q ≥ 3 chars.
- `POST /api/route` (auth) body `{ origin, destination }`, each either `{ lat, lng, label? }` or `{ address }`
  → `{ ok, origin:{label,address,lat,lng}, destination:{…}, miles, minutes, geometry, provider, traffic }`.
  Geocode failure → 422 `{ error: "Couldn't find 'xyz'. Try a postcode." }`. Routing failure → 502.

---------------------------------------------------------------------------------------------

## 6. Data layer — `public/desk/lib/store.js`

`export async function createStore({ mode })` → store; mode `'supabase'` (default) or `'memory'`
(chosen by app.js when URL has `?local=1`; memory persists to `localStorage['sizemill.desk.local']`,
user `{ id:'local', email:'local@device' }`, and its `api.route/fuel/places` call the real endpoints
without auth header for fuel and return a clear error for route/places when no server is reachable).
Both implementations expose exactly the same API; all methods async; rows are plain objects with
the column names in §2; numerics as numbers. Errors are thrown as `Error` with a human message.

```js
store.mode                                   // 'supabase' | 'memory'
store.auth.user()                            // current user or null (sync)
store.auth.onChange(cb)                      // cb(user|null); returns unsubscribe
store.auth.signIn(email, password)
store.auth.signUp(email, password)           // emailRedirectTo: location.origin + '/desk/'
store.auth.magicLink(email)                  // emailRedirectTo: location.origin + '/desk/'
store.auth.signOut()

store.settings.get()                         // row merged over DEFAULT_SETTINGS (exported const)
store.settings.save(patch)                   // upsert, returns row

store.clients.list({ includeArchived = false } = {})   // ordered by name
store.clients.get(id)
store.clients.create(data) / update(id, patch) / remove(id)   // remove = hard delete

store.stock.list({ includeArchived = false } = {})
store.stock.create(data) / update(id, patch) / remove(id)

store.deals.list()          // ALL deals with children: [{ ...deal, client:{id,name,club}|null, items, costs, payments, trips }]
                            // newest sale_date first, then number desc. (Supabase: one embedded select.)
store.deals.get(id)         // same shape for one deal (null if missing)
store.deals.create({ deal, items = [], costs = [] })   // returns the full deal (as get)
store.deals.update(id, patch)
store.deals.remove(id)

store.items.create(dealId, item) / update(id, patch) / remove(id)
store.costs.create(dealId, cost) / update(id, patch) / remove(id)
store.payments.create(dealId, payment) / remove(id)
store.trips.list()          // all trips, newest first, with deal:{id,number,title} and client:{id,name}
store.trips.create(trip) / update(id, patch) / remove(id)

store.api.route(origin, destination)   // POST /api/route with bearer token
store.api.places(q)                    // GET /api/places
store.api.fuel({ lat, lng, type })     // GET /api/fuel (rounds lat/lng to 2 dp for CDN cache hits)

store.subscribe(cb)          // cb() after any successful write (views refetch); returns unsubscribe
```
`DEFAULT_SETTINGS` = `{ business_name:'Sizemill', home_label:null, home_address:null, home_lat:null, home_lng:null, mpg:45, fuel_type:'E10', hourly_rate:20, vehicle_cost_per_mile:0, round_trip_default:true, handover_minutes_default:15, target_margin:0.25 }`.
Never send `owner`, `id`, `number`, `created_at`, `updated_at` in writes (DB defaults/triggers own them).
Strip unknown keys before writing (whitelist per table from §2).

---------------------------------------------------------------------------------------------

## 7. UI

### Look
Matches the existing Sizemill brand: IBM Plex Sans + IBM Plex Mono (Google Fonts), warm paper
background, ink text, one blue signal colour, green gain, red loss, amber warn. Tokens on `:root`
(light) and redefined for dark under `@media (prefers-color-scheme: dark)`:
`--paper #EDEDE8 / #121417, --surface #FFFFFF / #1A1D22, --surface-2 #F7F7F3 / #20242A, --ink #1B2028 / #E8EAED,
--ink-2 #535B66 / #A9B0BA, --ink-3 #8A9099 / #79818C, --line #E2E1DA / #2A2F36, --line-2 #CCCBC2 / #3A4048,
--signal #1F4B85 / #7FA7DB, --signal-tint #EAF0F7 / #1B2A3D, --gain #127A5E / #4CC29A, --gain-tint #E6F1EC / #15302A,
--loss #B23A3A / #F07B7B, --loss-tint #F7EAE8 / #3A1F1F, --warn #96691A / #E0B25A, --warn-tint #F6EEDB / #352B17`.
Numbers use `font-variant-numeric: tabular-nums`. Radius 9px panels, 6px controls. Generous
touch targets (≥ 44px) on mobile. No horizontal page scroll at 360px width.

### Layout (app.js)
Desktop ≥ 900px: left sidebar (brand, nav, "New sale" primary button, signed-in email + sign out).
Mobile: top bar with page title + one primary action, bottom tab bar: Home, Sales, Clients, Check, More
(More → Stock, Trips, Settings). Hash router: `#/`, `#/sales`, `#/sales/new`, `#/sales/:id`,
`#/clients`, `#/clients/new`, `#/clients/:id`, `#/stock`, `#/trips`, `#/check` (deal checker),
`#/settings`. Unknown route → dashboard. Each view module exports `default function View({ store, params, route, navigate })`.
Auth gate before the app: email + password sign in, "Email me a link", create account. Shows errors plainly.
First run (no settings row): Settings view prompts for home address, mpg, fuel type and hourly rate.

### lib/ui.js exports
`html` re-export, `Page({ title, subtitle, actions, back, children })`, `Card({ title, actions, children, pad = true })`,
`Stat({ label, value, sub, tone })` (tone: 'gain'|'loss'|'warn'|'signal'|undefined),
`Badge({ tone, children })`, `Button({ kind = 'secondary'|'primary'|'danger'|'ghost', size, onClick, href, disabled, type, children })`,
`Field({ label, hint, error, children })`, `Input(props)`, `Select({ options:[{value,label}], ...props })`,
`Textarea(props)`, `Money({ value, sign, tone })` (auto tone by sign when tone === 'auto'),
`Empty({ title, body, action })`, `Spinner()`, `Modal({ title, onClose, children, footer })`,
`Tabs({ tabs:[{id,label,count}], value, onChange })`, `Segmented({ options, value, onChange })`,
`SearchBox({ value, onInput, placeholder })`, `useAsync(fn, deps)` → `{ data, error, loading, reload }`,
`useStoreData(store, loader)` → like useAsync but reloads on `store.subscribe`,
`toast(message, { tone })`, `confirmDialog({ title, body, confirmLabel, danger })` → Promise<boolean>,
`statusMeta` map for deal statuses → `{ label, tone }`, `bucketMeta`, `paymentMeta`.
Status labels: enquiry 'Enquiry', agreed 'Agreed', sourcing 'Sourcing', ready 'Ready to deliver',
delivered 'Delivered', completed 'Completed', cancelled 'Cancelled'.

### Views
- **Dashboard** (`#/`): period switch (This month / Last 30 days / This year / All time).
  KPI row: Profit realised, Profit pending (estimated, with count of items still to buy), Revenue,
  Owed to you, Stock on hand (value), £ per driving hour. 12-month bar chart of realised vs pending
  profit. "Needs you" list: items still to buy (expected cost) with expected cost, deals ready to deliver,
  delivered but unpaid (with amount and days since), birthdays in the next 14 days. Top clients by profit.
  Recent sales. Empty state with "Add your first sale" and "Check a deal".
- **Sales list** (`#/sales`): tabs All / Pending / Realised / To buy / Unpaid / Cancelled with counts;
  search (client, item, SKU, number); each row: number, client + club, items summary, sale date,
  status badge, revenue, profit (with "est." marker when estimated), payment badge. Mobile: cards.
- **New sale** (`#/sales/new`): pick or quick-create client; items (description, brand, SKU, size, qty,
  sale price; source: "Need to buy" → expected cost, "Bought" → actual cost, "From stock" → pick stock item);
  extra costs; status, sale date, due date, delivery method, notes; live totals panel
  (calc.dealTotals) showing revenue, cost, profit, margin, certainty. Saves then navigates to the sale.
- **Sale detail** (`#/sales/:id`): header (number, client link, status changer, payment badge);
  profit breakdown card (revenue → goods → extras → gross → travel → profit → time → after your time;
  per driving hour; "estimated" banner listing what's still expected); items table with inline edit and a
  "Mark bought" action (enter actual cost, sets cost_status actual, sourced_at today, shows variance);
  extra costs; payments (add/remove, balance); trips (list + "Log drive" opening the trip planner
  prefilled origin = home, destination = client's first address; saved with deal_id/client_id);
  notes; delete sale (confirm).
- **Clients** (`#/clients`): search; cards/rows with name, club, position, sizes, lifetime revenue and
  profit, owed, last sale. **Client** (`#/clients/:id`): profile edit (all §2 fields, tags, addresses with
  geocode via address input), stats (sales, revenue, profit, avg margin, owed), their sales, their trips,
  quick actions: call, WhatsApp (`https://wa.me/<digits>`), Instagram link, "New sale for X". New client at `#/clients/new`.
- **Stock** (`#/stock`): table of items with on-hand, allocated, unit cost, value, age (days since bought);
  add/edit/delete; filter by in stock / allocated / all.
- **Trips** (`#/trips`): planner on top (standalone), list of saved trips with miles, time, fuel, cash cost,
  linked sale/client; totals for the period (miles, hours, fuel spend).
- **Deal checker** (`#/check`): "Will I make money?" — sale price, buy price, extra costs, trip planner
  (or manual miles/minutes), hourly rate (default from settings), target margin. Live result from
  calc.assessDeal: verdict banner (Good / Tight / Losing money) with reasons, profit, after-your-time,
  £/driving hour, break-even price, price for your hourly rate, price for target margin, max buy price.
  Button "Turn into a sale" → navigates to `#/sales/new` with values prefilled (via sessionStorage key
  `sizemill.desk.prefill`).
- **Settings** (`#/settings`): business name, home address (address input, geocoded), mpg, fuel type,
  hourly rate, vehicle cost per mile (with hint: "Leave 0 unless you want wear and tear; HMRC's 45p is an
  all-in figure that already includes fuel"), round trip default, handover minutes, target margin.
  Also: export everything as JSON and CSV (sales with totals).

### Trip planner component (`components/trip-planner.js`)
Props: `{ store, settings, value, onChange, initialOrigin, initialDestination, compact }` where
value/onChange carry a trip-shaped object (§2 columns). Inputs: From (defaults to home), To, round trip
toggle, handover minutes, mpg, fuel type, fuel price (auto-filled from `/api/fuel` near the origin with
source text and a refresh; user can override), hourly rate, other costs (parking/tolls/ULEZ) with note.
"Calculate route" → `store.api.route`; shows miles, driving time, provider ("traffic-aware" if Google),
map (route-map.js), and the `calc.tripTotals` breakdown. If routing fails, the user can type miles and
minutes manually (route_provider 'manual'). Never blocks: every number is editable.

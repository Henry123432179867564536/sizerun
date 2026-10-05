// Sizemill Desk data layer (docs/desk-spec.md §6).
//
// createStore() returns one async API backed either by Supabase (the real database) or by an
// in-memory database persisted to localStorage (`?local=1`: offline use and development).
// Both modes share a single table schema mirroring
// supabase/migrations/20261005120000_desk_core.sql — writable columns, value types, defaults,
// CHECK rules keyed by their SQL constraint names, foreign keys and list ordering. Every write
// is whitelisted and coerced through it, and database errors are turned into the same human
// sentences local mode produces, so a screen built against one mode behaves the same against
// the other. Money totals are never computed here: views use calc.js.

const SUPABASE_URL = 'https://qromnxxviflpahimjhgq.supabase.co';
// Publishable by design: row level security, not this key, protects the data.
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_u1ywcwe7Wqb9s6Z55VskIQ_pepm1rYk';

const LOCAL_STORAGE_KEY = 'sizemill.desk.local';
const LOCAL_DB_VERSION = 1;
const LOCAL_USER = Object.freeze({ id: 'local', email: 'local@device' });

// Longer than the server's own 8 s upstream timeouts: /api/route may geocode twice and route.
const API_TIMEOUT_MS = 20000;
const PLACES_MIN_QUERY = 3;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const NETWORK_FAILURE_PATTERN = /failed to fetch|networkerror|network request failed|load failed|fetch failed/i;
const INT4_MAX = 2147483647;

const MESSAGES = Object.freeze({
  network: "Can't reach the server — check your connection.",
  timeout: 'The server took too long to answer — try again.',
  forbidden: "You don't have access to that record.",
  notFound: 'That record no longer exists.',
  signedOut: "You're signed out — sign in again.",
  sessionExpired: 'Your session has expired — sign in again.',
  notSetUp: "Desk's database isn't set up yet — apply the Supabase migration.",
  outdated: "Desk's database is out of date — apply the latest Supabase migration.",
  badFormat: "One of the values isn't in the right format.",
  tooLarge: 'One of the numbers is too large.',
  serverError: 'The server had a problem — try again in a moment.',
  unreadableReply: "The server sent a reply Desk couldn't read — try again.",
  generic: 'Something went wrong — please try again.',
  storageFull: "Couldn't save on this device — the browser's storage is full or blocked.",
  accountExists: 'An account with that email already exists — sign in instead.',
  noClientLibrary: "Couldn't load the sign-in library — check your connection and reload the page.",
});

// ---------------------------------------------------------------------------------------------
// Schema (one entry per table in docs/desk-spec.md §2)
// ---------------------------------------------------------------------------------------------

const text = (options) => ({ type: 'text', ...options });
const textArray = (options) => ({ type: 'text[]', ...options });
const uuid = (options) => ({ type: 'uuid', ...options });
const integer = (options) => ({ type: 'integer', ...options });
const numeric = (precision, scale, options) => ({ type: 'numeric', precision, scale, ...options });
const double = (options) => ({ type: 'double', ...options });
const boolean = (options) => ({ type: 'boolean', ...options });
const date = (options) => ({ type: 'date', ...options });
const json = (options) => ({ type: 'json', ...options });
// A uuid column with a foreign key. `onDelete` mirrors the SQL referential action.
const ref = (table, onDelete, options) => uuid({ references: { table, onDelete }, ...options });

// Dynamic defaults are functions so every row gets a fresh value.
const today = () => londonToday();
const emptyList = () => [];

// CHECK helpers. Like SQL, a NULL value passes a CHECK; NOT NULL is enforced separately.
const isNull = (value) => value === null || value === undefined;
const rule = (name, test, message) => ({ name, test, message });
const positive = (column) => (row) => isNull(row[column]) || row[column] > 0;
const nonNegative = (column) => (row) => isNull(row[column]) || row[column] >= 0;
const oneOf = (column, values) => (row) => isNull(row[column]) || values.includes(row[column]);
const notBlank = (column) => (row) => isNull(row[column]) || String(row[column]).trim() !== '';
const within = (column, min, max) => (row) => isNull(row[column]) || (row[column] >= min && row[column] <= max);
const bothOrNeither = (a, b) => (row) => isNull(row[a]) === isNull(row[b]);

const FUEL_TYPES = ['E10', 'E5', 'B7', 'SDV'];

const HEX_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;
const BRAND_COLOR_MESSAGE = 'Use a colour like #1F4B85.';
const LOGO_URL_MAX = 2048;
const LOGO_DATA_URL_MAX = 1_500_000;
function validLogoUrl(url) {
  const value = String(url);
  if (value.startsWith('data:image/')) return value.length <= LOGO_DATA_URL_MAX;
  return value.startsWith('https://') && value.length <= LOGO_URL_MAX;
}

// Logos (spec: Storage bucket 'brand', '<uid>/logo-<ms>.<ext>', png/jpeg/webp, at most 1 MB).
const LOGO_BUCKET = 'brand';
const LOGO_MAX_BYTES = 1_048_576;
const LOGO_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const LOGO_MESSAGES = Object.freeze({
  notImage: 'Use a PNG, JPG or WebP image.',
  tooBig: 'That logo is over 1 MB — pick a smaller image.',
  uploadFailed: "Couldn't upload your logo — try again.",
});

// PostgREST's default "Max rows" (Supabase API settings). Lists page through results this many
// rows at a time; if Max rows is ever lowered below this, lists would still be cut short.
const PAGE_SIZE = 1000;
const FUEL_TYPE_MESSAGE = 'Fuel type must be E10, E5, B7 or SDV.';

// What to say when a foreign key points at a row that is gone, by parent table.
const MISSING_PARENT = {
  clients: 'That client no longer exists.',
  deals: 'That sale no longer exists.',
  stock_items: 'That stock item no longer exists.',
};

// A row-level security refusal on insert/update, by table, in the same words as MISSING_PARENT.
const RLS_PARENT_MESSAGES = {
  deals: `${MISSING_PARENT.clients.slice(0, -1)} — reload the page.`,
  payments: `${MISSING_PARENT.deals.slice(0, -1)} — reload the page.`,
  deal_costs: `${MISSING_PARENT.deals.slice(0, -1)} — reload the page.`,
  deal_items: 'That sale or stock item no longer exists — reload the page.',
  trips: 'That sale or client no longer exists — reload the page.',
};

// `key`: primary key column. `created`/`updated`: whether the table has created_at/updated_at.
// `columns`: every writable column (owner, id, number and timestamps are never writable).
// `createOnly`: settable when a row is created but stripped from updates (a line item never
// moves to another sale). `label`: the field name used in error messages.
const SCHEMA = {
  desk_settings: {
    key: 'owner',
    created: false,
    updated: true,
    columns: {
      business_name: text({ default: 'Sizemill' }),
      home_label: text(),
      home_address: text(),
      home_lat: double({ label: 'Home latitude' }),
      home_lng: double({ label: 'Home longitude' }),
      mpg: numeric(5, 1, { notNull: true, default: 45, label: 'MPG' }),
      fuel_type: text({ notNull: true, default: 'E10' }),
      hourly_rate: numeric(8, 2, { notNull: true, default: 20 }),
      vehicle_cost_per_mile: numeric(6, 3, { notNull: true, default: 0 }),
      round_trip_default: boolean({ notNull: true, default: true, label: 'Round trip' }),
      handover_minutes_default: integer({ notNull: true, default: 15, label: 'Handover minutes' }),
      target_margin: numeric(5, 2, { notNull: true, default: 0.25 }),
      // Branding: the logo's public URL in the `brand` bucket (a data: URL in local mode) and the
      // accent colour as '#RRGGBB'. Both null until the owner sets them.
      logo_url: text({ label: 'Logo' }),
      brand_color: text({ label: 'Brand colour' }),
      background_color: text({ label: 'Background colour' }),
    },
    checks: [
      rule('desk_settings_mpg_positive', positive('mpg'), 'MPG must be more than 0.'),
      rule('desk_settings_fuel_type_valid', oneOf('fuel_type', FUEL_TYPES), FUEL_TYPE_MESSAGE),
      rule('desk_settings_hourly_rate_nonneg', nonNegative('hourly_rate'), "Hourly rate can't be negative."),
      rule('desk_settings_wear_nonneg', nonNegative('vehicle_cost_per_mile'), "Vehicle cost per mile can't be negative."),
      rule('desk_settings_handover_nonneg', nonNegative('handover_minutes_default'), "Handover minutes can't be negative."),
      rule(
        'desk_settings_target_margin_range',
        (row) => isNull(row.target_margin) || (row.target_margin >= 0 && row.target_margin < 1),
        'Target margin must be at least 0% and below 100%.',
      ),
      rule('desk_settings_home_lat_range', within('home_lat', -90, 90), "Home location isn't a valid map position."),
      rule('desk_settings_home_lng_range', within('home_lng', -180, 180), "Home location isn't a valid map position."),
      rule('desk_settings_home_coords_pair', bothOrNeither('home_lat', 'home_lng'), 'Home location needs both latitude and longitude.'),
      rule('desk_settings_brand_color_hex', (row) => isNull(row.brand_color) || HEX_COLOR_PATTERN.test(row.brand_color), BRAND_COLOR_MESSAGE),
      rule('desk_settings_background_color_hex', (row) => isNull(row.background_color) || HEX_COLOR_PATTERN.test(row.background_color), 'Use a colour like #EDEDE8.'),
      // The database caps logo_url at 2,048 characters. Local mode keeps the image itself as a
      // data: URL, so it gets a size cap instead.
      rule('desk_settings_logo_url_length', (row) => isNull(row.logo_url) || validLogoUrl(row.logo_url), "That logo can't be saved — upload it again."),
    ],
  },

  clients: {
    key: 'id',
    created: true,
    updated: true,
    columns: {
      name: text({ notNull: true }),
      club: text(),
      position: text(),
      squad_number: text(),
      agent_name: text(),
      agent_phone: text(),
      agent_email: text(),
      phone: text(),
      email: text(),
      instagram: text(),
      shoe_size: text(),
      clothing_size: text(),
      preferences: text(),
      notes: text(),
      tags: textArray({ notNull: true, default: emptyList }),
      birthday: date(),
      addresses: json({ notNull: true, default: emptyList }),
      archived: boolean({ notNull: true, default: false }),
    },
    checks: [
      rule('clients_name_not_blank', notBlank('name'), 'Name is required.'),
      rule('clients_addresses_is_array', (row) => Array.isArray(row.addresses), 'Addresses must be a list.'),
    ],
  },

  stock_items: {
    key: 'id',
    created: true,
    updated: true,
    columns: {
      name: text({ notNull: true, label: 'Item name' }),
      brand: text(),
      sku: text({ label: 'SKU' }),
      size: text(),
      condition: text({ notNull: true, default: 'new' }),
      qty: integer({ notNull: true, default: 1, label: 'Quantity' }),
      unit_cost: numeric(12, 2, { notNull: true, label: 'Cost' }),
      bought_at: date({ default: today, label: 'Bought date' }),
      supplier: text(),
      location: text(),
      notes: text(),
      archived: boolean({ notNull: true, default: false }),
    },
    checks: [
      rule('stock_items_name_not_blank', notBlank('name'), 'Item name is required.'),
      rule('stock_items_condition_valid', oneOf('condition', ['new', 'vnds', 'good', 'worn']), 'Pick a condition: New, VNDS, Good or Worn out.'),
      rule('stock_items_qty_nonneg', nonNegative('qty'), "Quantity can't be negative."),
      rule('stock_items_unit_cost_nonneg', nonNegative('unit_cost'), "Cost can't be negative."),
    ],
  },

  deals: {
    key: 'id',
    created: true,
    updated: true,
    columns: {
      client_id: ref('clients', 'set null', { label: 'Client' }),
      title: text(),
      status: text({ notNull: true, default: 'agreed' }),
      sale_date: date({ notNull: true, default: today }),
      due_date: date(),
      delivery_method: text({ notNull: true, default: 'drop_off' }),
      notes: text(),
    },
    checks: [
      rule(
        'deals_status_valid',
        oneOf('status', ['enquiry', 'agreed', 'sourcing', 'ready', 'delivered', 'completed', 'cancelled']),
        'Unknown sale status.',
      ),
      rule(
        'deals_delivery_method_valid',
        oneOf('delivery_method', ['drop_off', 'meet', 'post', 'collection']),
        'Unknown delivery method.',
      ),
    ],
  },

  deal_items: {
    key: 'id',
    created: true,
    updated: false,
    columns: {
      deal_id: ref('deals', 'cascade', { notNull: true, createOnly: true, label: 'Sale' }),
      position: integer({ notNull: true, default: 0 }),
      description: text({ notNull: true, label: 'Item description' }),
      brand: text(),
      sku: text({ label: 'SKU' }),
      size: text(),
      qty: integer({ notNull: true, default: 1, label: 'Quantity' }),
      unit_price: numeric(12, 2, { notNull: true, default: 0, label: 'Sale price' }),
      cost_status: text({ notNull: true, default: 'expected' }),
      expected_unit_cost: numeric(12, 2, { label: 'Expected cost' }),
      unit_cost: numeric(12, 2, { label: 'Cost' }),
      condition: text({ label: 'Condition' }),
      stock_item_id: ref('stock_items', 'set null', { label: 'Stock item' }),
      supplier: text(),
      sourced_at: date({ label: 'Bought date' }),
    },
    checks: [
      rule('deal_items_description_not_blank', notBlank('description'), 'Item description is required.'),
      rule('deal_items_qty_positive', positive('qty'), 'Quantity must be at least 1.'),
      rule('deal_items_condition_valid', oneOf('condition', ['new', 'vnds', 'good', 'worn']), 'Pick a condition: New, VNDS, Good or Worn out.'),
      rule('deal_items_unit_price_nonneg', nonNegative('unit_price'), "Sale price can't be negative."),
      rule('deal_items_cost_status_valid', oneOf('cost_status', ['expected', 'actual']), "Cost status must be 'expected' or 'actual'."),
      rule('deal_items_expected_unit_cost_nonneg', nonNegative('expected_unit_cost'), "Expected cost can't be negative."),
      rule('deal_items_unit_cost_nonneg', nonNegative('unit_cost'), "Cost can't be negative."),
      rule(
        'deal_items_actual_needs_unit_cost',
        (row) => row.cost_status !== 'actual' || !isNull(row.unit_cost),
        'Enter what you paid for an item you have bought.',
      ),
      rule(
        'deal_items_expected_needs_expected_cost',
        (row) => row.cost_status !== 'expected' || !isNull(row.expected_unit_cost),
        'Enter the expected cost for an item you still need to buy.',
      ),
    ],
  },

  deal_costs: {
    key: 'id',
    created: true,
    updated: false,
    columns: {
      deal_id: ref('deals', 'cascade', { notNull: true, createOnly: true, label: 'Sale' }),
      label: text({ notNull: true, label: 'Cost description' }),
      kind: text({ notNull: true, default: 'other' }),
      amount: numeric(12, 2, { notNull: true, label: 'Cost amount' }),
      is_expected: boolean({ notNull: true, default: false }),
    },
    checks: [
      rule('deal_costs_label_not_blank', notBlank('label'), 'Cost description is required.'),
      rule('deal_costs_kind_valid', oneOf('kind', ['shipping', 'fees', 'packaging', 'other']), 'Unknown cost type.'),
      rule('deal_costs_amount_nonneg', nonNegative('amount'), "Cost amount can't be negative."),
    ],
  },

  payments: {
    key: 'id',
    created: true,
    updated: false,
    columns: {
      deal_id: ref('deals', 'cascade', { notNull: true, createOnly: true, label: 'Sale' }),
      amount: numeric(12, 2, { notNull: true, label: 'Payment amount' }),
      method: text({ notNull: true, default: 'bank' }),
      paid_at: date({ notNull: true, default: today, label: 'Payment date' }),
      note: text(),
    },
    checks: [
      rule('payments_amount_nonzero', (row) => isNull(row.amount) || row.amount !== 0, "Payment amount can't be zero."),
      rule('payments_method_valid', oneOf('method', ['cash', 'bank', 'card', 'other']), 'Unknown payment method.'),
    ],
  },

  trips: {
    key: 'id',
    created: true,
    updated: true,
    columns: {
      deal_id: ref('deals', 'set null', { label: 'Sale' }),
      client_id: ref('clients', 'set null', { label: 'Client' }),
      trip_date: date({ notNull: true, default: today, label: 'Trip date' }),
      label: text(),
      origin_label: text(),
      origin_address: text(),
      origin_lat: double({ label: 'Start latitude' }),
      origin_lng: double({ label: 'Start longitude' }),
      dest_label: text(),
      dest_address: text(),
      dest_lat: double({ label: 'Destination latitude' }),
      dest_lng: double({ label: 'Destination longitude' }),
      one_way_miles: numeric(8, 2, { notNull: true, label: 'Miles' }),
      one_way_minutes: numeric(8, 1, { notNull: true, label: 'Driving time' }),
      round_trip: boolean({ notNull: true, default: true }),
      extra_minutes: integer({ notNull: true, default: 0 }),
      mpg: numeric(5, 1, { notNull: true, label: 'MPG' }),
      fuel_type: text(),
      fuel_ppl: numeric(6, 1, { notNull: true, label: 'Fuel price' }),
      fuel_source: text(),
      hourly_rate: numeric(8, 2, { notNull: true, default: 0 }),
      vehicle_cost_per_mile: numeric(6, 3, { notNull: true, default: 0 }),
      other_costs: numeric(10, 2, { notNull: true, default: 0 }),
      other_costs_note: text(),
      route_provider: text(),
      route_geometry: json(),
    },
    checks: [
      rule('trips_one_way_miles_nonneg', nonNegative('one_way_miles'), "Miles can't be negative."),
      rule('trips_one_way_minutes_nonneg', nonNegative('one_way_minutes'), "Driving time can't be negative."),
      rule('trips_extra_minutes_nonneg', nonNegative('extra_minutes'), "Extra minutes can't be negative."),
      rule('trips_mpg_positive', positive('mpg'), 'MPG must be more than 0.'),
      rule('trips_fuel_ppl_positive', positive('fuel_ppl'), 'Fuel price must be more than 0.'),
      rule('trips_fuel_type_valid', oneOf('fuel_type', FUEL_TYPES), FUEL_TYPE_MESSAGE),
      rule('trips_hourly_rate_nonneg', nonNegative('hourly_rate'), "Hourly rate can't be negative."),
      rule('trips_wear_nonneg', nonNegative('vehicle_cost_per_mile'), "Vehicle cost per mile can't be negative."),
      rule('trips_other_costs_nonneg', nonNegative('other_costs'), "Other costs can't be negative."),
      rule('trips_origin_lat_range', within('origin_lat', -90, 90), "The start isn't a valid map position."),
      rule('trips_origin_lng_range', within('origin_lng', -180, 180), "The start isn't a valid map position."),
      rule('trips_dest_lat_range', within('dest_lat', -90, 90), "The destination isn't a valid map position."),
      rule('trips_dest_lng_range', within('dest_lng', -180, 180), "The destination isn't a valid map position."),
      rule('trips_origin_coords_pair', bothOrNeither('origin_lat', 'origin_lng'), 'The start needs both latitude and longitude.'),
      rule('trips_dest_coords_pair', bothOrNeither('dest_lat', 'dest_lng'), 'The destination needs both latitude and longitude.'),
      rule(
        'trips_route_geometry_shape',
        (row) => isNull(row.route_geometry) || (Array.isArray(row.route_geometry) && row.route_geometry.length <= 2000),
        'The saved route must be a list of at most 2,000 points.',
      ),
    ],
  },
};

const TABLES = Object.keys(SCHEMA);

// Every foreign key, named as Postgres names inline `references` constraints.
const FOREIGN_KEYS = Object.entries(SCHEMA).flatMap(([table, { columns }]) =>
  Object.entries(columns)
    .filter(([, column]) => column.references)
    .map(([column, { references }]) => ({
      table,
      column,
      parent: references.table,
      onDelete: references.onDelete,
      constraint: `${table}_${column}_fkey`,
      message: MISSING_PARENT[references.table],
    })),
);

const CHECK_MESSAGES = new Map(Object.values(SCHEMA).flatMap(({ checks }) => checks.map((c) => [c.name, c.message])));
const FOREIGN_KEY_MESSAGES = new Map(FOREIGN_KEYS.map((fk) => [fk.constraint, fk.message]));

// List ordering, shared by both modes: Supabase sends it as ORDER BY, memory mode sorts with
// the same spec. NULLs always sort last.
const ORDER = {
  clients: [['name'], ['created_at'], ['id']],
  stock_items: [['bought_at', 'desc'], ['created_at', 'desc'], ['id']],
  deals: [['sale_date', 'desc'], ['number', 'desc']],
  deal_items: [['position'], ['created_at']],
  deal_costs: [['created_at']],
  payments: [['paid_at'], ['created_at']],
  deal_trips: [['trip_date'], ['created_at']],
  trips: [['trip_date', 'desc'], ['created_at', 'desc'], ['id']],
};

// Children embedded in every deal: [key on the deal, table, ordering].
const DEAL_CHILDREN = [
  ['items', 'deal_items', ORDER.deal_items],
  ['costs', 'deal_costs', ORDER.deal_costs],
  ['payments', 'payments', ORDER.payments],
  ['trips', 'trips', ORDER.deal_trips],
];

// Embedded selects. The FK hints (!constraint) pin each embed to its direct foreign key, so
// PostgREST never sees trips as an alternative path between deals and clients.
const DEAL_SELECT =
  '*, client:clients!deals_client_id_fkey(id,name,club), items:deal_items(*), costs:deal_costs(*), ' +
  'payments(*), trips!trips_deal_id_fkey(*)';
const TRIP_SELECT = '*, deal:deals!trips_deal_id_fkey(id,number,title), client:clients!trips_client_id_fkey(id,name)';

function resolveDefault(value) {
  if (typeof value === 'function') return value();
  return value === undefined ? null : value;
}

function defaultsFor(table) {
  const defaults = {};
  for (const [name, column] of Object.entries(SCHEMA[table].columns)) defaults[name] = resolveDefault(column.default);
  return defaults;
}

// Spec §6: { business_name:'Sizemill', home_label:null, …, target_margin:0.25 }, taken from the
// schema defaults so the two can never drift apart.
export const DEFAULT_SETTINGS = Object.freeze(defaultsFor('desk_settings'));

function labelOf(table, columnName) {
  const custom = SCHEMA[table]?.columns[columnName]?.label;
  if (custom) return custom;
  const words = String(columnName).replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// ---------------------------------------------------------------------------------------------
// Preparing writes: whitelist + coercion (both modes)
// ---------------------------------------------------------------------------------------------

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isEmpty(object) {
  return Object.keys(object).length === 0;
}

function isBlank(value) {
  return value === null || (typeof value === 'string' && value.trim() === '');
}

function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

// Keeps only the table's writable columns, drops undefined values and coerces each value to
// its column type, so form strings like '45' or '' arrive as 45 and null.
// op 'insert': a blank NOT NULL column that has a default is left out, so the default applies
//              (an explicit null would violate NOT NULL instead).
// op 'update': createOnly columns are stripped; blanks are kept and fail NOT NULL if required.
function prepareWrite(table, data, op) {
  if (!isPlainObject(data)) throw new Error('Nothing to save.');
  const values = {};
  for (const [name, column] of Object.entries(SCHEMA[table].columns)) {
    if (!Object.hasOwn(data, name) || data[name] === undefined) continue;
    if (op === 'update' && column.createOnly) continue;
    const value = coerce(column, labelOf(table, name), data[name]);
    if (op === 'insert' && value === null && column.notNull && column.default !== undefined) continue;
    values[name] = value;
  }
  return values;
}

function coerce(column, label, raw) {
  // Clearing a list (tags, addresses) leaves an empty list, as NOT NULL requires.
  if (isBlank(raw)) return column.default === emptyList ? [] : null;
  switch (column.type) {
    case 'text':
      if (typeof raw === 'object') throw new Error(`${label} must be text.`);
      return String(raw).trim() || null;
    case 'uuid': {
      const id = String(raw).trim().toLowerCase();
      if (!UUID_PATTERN.test(id)) throw new Error(`${label} isn't valid.`);
      return id;
    }
    case 'numeric': {
      const value = parseNumber(raw);
      if (!Number.isFinite(value)) throw new Error(`${label} must be a number.`);
      // numeric(p, s) rounds to s places and allows p - s digits before the point.
      const rounded = roundToScale(value, column.scale);
      if (Math.abs(rounded) >= 10 ** (column.precision - column.scale)) throw new Error(`${label} is too large.`);
      return rounded;
    }
    case 'double': {
      const value = parseNumber(raw);
      if (!Number.isFinite(value)) throw new Error(`${label} must be a number.`);
      return value;
    }
    case 'integer': {
      const value = parseNumber(raw);
      if (!Number.isFinite(value)) throw new Error(`${label} must be a number.`);
      if (!Number.isInteger(value)) throw new Error(`${label} must be a whole number.`);
      if (Math.abs(value) > INT4_MAX) throw new Error(`${label} is too large.`);
      return value;
    }
    case 'boolean':
      if (raw === true || raw === 'true' || raw === 1) return true;
      if (raw === false || raw === 'false' || raw === 0) return false;
      throw new Error(`${label} must be yes or no.`);
    case 'date': {
      const iso = parseDate(raw);
      if (!iso) throw new Error(`${label} must be a valid date.`);
      return iso;
    }
    case 'json':
      try {
        // A JSON round trip drops undefined/functions and rejects cycles, like the database would.
        return JSON.parse(JSON.stringify(raw));
      } catch {
        throw new Error(`${label} isn't valid.`);
      }
    case 'text[]': {
      const list = Array.isArray(raw) ? raw : String(raw).split(',');
      const cleaned = list.filter((v) => !isNull(v)).map((v) => String(v).trim()).filter(Boolean);
      return [...new Set(cleaned)];
    }
    default:
      throw new Error(`Unknown column type '${column.type}'.`);
  }
}

// Accepts numbers and numeric strings, tolerating '£', thousands separators and spaces.
function parseNumber(raw) {
  if (typeof raw === 'number') return raw;
  if (typeof raw !== 'string') return Number.NaN;
  const cleaned = raw.replace(/[£,\s]/g, '');
  return cleaned === '' ? Number.NaN : Number(cleaned);
}

// Rounds half away from zero like Postgres numeric. toPrecision(15) first removes binary
// noise such as 1.005 * 100 = 100.49999999999999.
function roundToScale(value, scale) {
  const factor = 10 ** scale;
  const scaled = Number((Math.abs(value) * factor).toPrecision(15));
  const rounded = Math.round(scaled) / factor;
  return value < 0 && rounded !== 0 ? -rounded : rounded;
}

// 'YYYY-MM-DD' (validated as a real calendar day) or a Date (its local calendar day).
function parseDate(raw) {
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return null;
    return [raw.getFullYear(), raw.getMonth() + 1, raw.getDate()].map((n, i) => String(n).padStart(i ? 2 : 4, '0')).join('-');
  }
  const match = ISO_DATE_PATTERN.exec(String(raw).trim());
  if (!match) return null;
  const [, year, month, day] = match.map(Number);
  const check = new Date(Date.UTC(year, month - 1, day));
  const real = check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day;
  return real ? match[0] : null;
}

// The Europe/London calendar day, matching the SQL date defaults.
function londonToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type) => parts.find((p) => p.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

// NOT NULL and CHECK rules for a complete row (memory mode, and pre-flight checks of
// multi-request writes in Supabase mode).
function assertValidRow(table, row) {
  const { columns, checks } = SCHEMA[table];
  for (const [name, column] of Object.entries(columns)) {
    if (column.notNull && isNull(row[name])) throw new Error(`${labelOf(table, name)} is required.`);
  }
  for (const check of checks) {
    if (!check.test(row)) throw new Error(check.message);
  }
}

function settingsFromRow(row) {
  // Spec: the row merged over DEFAULT_SETTINGS. Nulls keep the default, and updated_at stays
  // null until the first save, which is how the Settings view spots a first run.
  const settings = { ...DEFAULT_SETTINGS, updated_at: null };
  if (row) {
    for (const [name, value] of Object.entries(row)) if (!isNull(value)) settings[name] = value;
  }
  return settings;
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

function failure(message, cause) {
  return cause === undefined ? new Error(message) : new Error(message, { cause });
}

function endSentence(message) {
  const trimmed = String(message).trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

// supabase-js query error ({ code, message }) + HTTP status -> one human sentence.
function describeDbError(error, status) {
  const code = String(error?.code ?? '');
  const message = String(error?.message ?? '');
  if (status === 0 || NETWORK_FAILURE_PATTERN.test(message)) return MESSAGES.network;
  // Checked before 42501: PostgREST answers a request without a valid token with 401 and the
  // anon role's "permission denied", which means "sign in again", not "not yours".
  if (status === 401 || code.startsWith('PGRST3')) return MESSAGES.sessionExpired;
  // An insert/update refused by a policy's "parent row exists" check: in a per-owner app that
  // means the parent (sale, client, stock item) was deleted, e.g. on another device.
  const rlsTable = /violates row-level security policy for table "([^"]+)"/.exec(message)?.[1];
  if (rlsTable) return RLS_PARENT_MESSAGES[rlsTable] ?? 'A linked record no longer exists — reload the page.';
  if (code === '42501' || /row-level security/i.test(message)) return MESSAGES.forbidden;
  if (code === 'PGRST116') return MESSAGES.notFound;
  if (code === '42P01' || code === 'PGRST205') return MESSAGES.notSetUp;
  if (code === '42703' || code === 'PGRST200' || code === 'PGRST204') return MESSAGES.outdated;

  const constraint = /constraint "([^"]+)"/.exec(message)?.[1];
  switch (code) {
    case '23514':
      return CHECK_MESSAGES.get(constraint) ?? "One of the values isn't allowed.";
    case '23503':
      return FOREIGN_KEY_MESSAGES.get(constraint) ?? 'A linked record no longer exists.';
    case '23505':
      return constraint === 'deals_owner_number_key'
        ? 'Another sale was saved at the same moment — try again.'
        : 'That record already exists.';
    case '23502': {
      const column = /column "([^"]+)"/.exec(message)?.[1];
      const table = /relation "([^"]+)"/.exec(message)?.[1];
      return column ? `${labelOf(table, column)} is required.` : 'A required value is missing.';
    }
    case '22P02':
    case '22007':
    case '22008':
      return MESSAGES.badFormat;
    case '22003':
      return MESSAGES.tooLarge;
    default:
      return status >= 500 ? MESSAGES.serverError : MESSAGES.generic;
  }
}

// supabase-js AuthError ({ name, status, code, message }) -> one human sentence.
function describeAuthError(error) {
  const code = String(error?.code ?? '');
  const message = String(error?.message ?? '');
  const status = error?.status;
  if (error?.name === 'AuthRetryableFetchError' || NETWORK_FAILURE_PATTERN.test(message)) {
    return status >= 500 ? MESSAGES.serverError : MESSAGES.network;
  }
  if (code === 'invalid_credentials' || /invalid login credentials/i.test(message)) return 'Wrong email or password.';
  if (code === 'email_not_confirmed' || /email not confirmed/i.test(message)) {
    return 'Confirm your email first — open the link we sent you, then sign in.';
  }
  if (code === 'user_already_exists' || /already registered/i.test(message)) return MESSAGES.accountExists;
  if (code === 'signup_disabled' || /signups not allowed/i.test(message)) return 'New accounts are switched off for Sizemill.';
  if (code === 'email_address_invalid' || /email address .*invalid|invalid format/i.test(message)) {
    return "That email address doesn't look right.";
  }
  if (status === 429 || code.startsWith('over_') || /rate limit|too many/i.test(message)) {
    return 'Too many attempts — wait a minute and try again.';
  }
  // Remaining auth messages (password rules and the like) are already plain English.
  return message ? endSentence(message) : MESSAGES.generic;
}

function requireEmail(email) {
  const clean = String(email ?? '').trim();
  if (!clean) throw new Error('Enter your email address.');
  return clean;
}

function requirePassword(password) {
  if (typeof password !== 'string' || password === '') throw new Error('Enter your password.');
  return password;
}

// A prepared logo image (brand.js prepareLogo resizes it first) → its file extension.
function checkLogo(blob) {
  if (!blob || typeof blob.size !== 'number' || typeof blob.arrayBuffer !== 'function') throw new Error('Choose an image for your logo.');
  const ext = LOGO_TYPES[String(blob.type).toLowerCase()];
  if (!ext) throw new Error(LOGO_MESSAGES.notImage);
  if (blob.size === 0) throw new Error(LOGO_MESSAGES.notImage);
  if (blob.size > LOGO_MAX_BYTES) throw new Error(LOGO_MESSAGES.tooBig);
  return ext;
}

// '#w=512&h=171&tone=dark': the stored pixel size rides along in the URL fragment (browsers ignore it
// when fetching), so the shell can reserve the logo's space before it loads.
// tone ('dark' | 'light', for logos on a transparent background) lets the shell put a dark
// logo on a light plate in dark mode, and the other way round.
function logoFragment({ width, height, tone } = {}) {
  const w = Math.round(Number(width));
  const h = Math.round(Number(height));
  const parts = w > 0 && h > 0 && w <= 4096 && h <= 4096 ? [`w=${w}`, `h=${h}`] : [];
  if (tone === 'dark' || tone === 'light') parts.push(`tone=${tone}`);
  return parts.length ? `#${parts.join('&')}` : '';
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return globalThis.btoa(binary);
}

// Supabase Storage error → one human sentence.
function describeStorageError(error) {
  const message = String(error?.message ?? '');
  const status = Number(error?.statusCode ?? error?.status ?? 0);
  if (NETWORK_FAILURE_PATTERN.test(message)) return MESSAGES.network;
  if (status === 413 || /maximum allowed size|too large/i.test(message)) return LOGO_MESSAGES.tooBig;
  if (status === 415 || /mime type|not supported/i.test(message)) return LOGO_MESSAGES.notImage;
  if (status === 401 || /jwt|unauthori[sz]ed/i.test(message)) return MESSAGES.sessionExpired;
  if (status === 403 || /row-level security|not allowed/i.test(message)) return MESSAGES.forbidden;
  return LOGO_MESSAGES.uploadFailed;
}

// ---------------------------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------------------------

function createEmitter() {
  const listeners = new Set();
  return {
    subscribe(callback) {
      if (typeof callback !== 'function') throw new TypeError('Expected a callback function.');
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
    emit(...args) {
      for (const callback of [...listeners]) {
        // One failing view must not stop the others from refreshing, nor fail the write.
        try {
          callback(...args);
        } catch (err) {
          console.error('[store] listener failed', err);
        }
      }
    },
  };
}

function toUser(user) {
  return user ? Object.freeze({ id: user.id, email: user.email ?? null }) : null;
}

function signUpRedirect() {
  return `${globalThis.location?.origin ?? ''}/desk/`;
}

function finiteOrNull(value) {
  if (isBlank(value) || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Calls the Desk server API (spec §5). Every method resolves to the endpoint's JSON body.
// getAccessToken: async () => token, or null in memory mode (no account, so the endpoints
// that need one explain that they are unavailable instead of failing obscurely).
function createApiClient({ fetchImpl, getAccessToken }) {
  const local = !getAccessToken;
  const localHints = {
    route: 'type the miles and driving time instead',
    places: 'type the address instead',
  };
  const localNames = { route: 'Route lookup', places: 'Address search' };

  // The request's own timeout, combined with the caller's AbortSignal when one is given.
  function requestSignal(signal) {
    const timeout = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(API_TIMEOUT_MS) : undefined;
    if (!signal) return timeout;
    if (!timeout) return signal;
    if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeout]);
    // Older Safari: forward both into one controller.
    const controller = new AbortController();
    const forward = (source) => {
      if (source.aborted) controller.abort(source.reason);
      else source.addEventListener('abort', () => controller.abort(source.reason), { once: true });
    };
    forward(signal);
    forward(timeout);
    return controller.signal;
  }

  async function request(path, { method = 'GET', body, service, authenticated, signal }) {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (authenticated && !local) {
      const token = await getAccessToken();
      if (!token) throw new Error(MESSAGES.signedOut);
      headers.Authorization = `Bearer ${token}`;
    }

    let response;
    try {
      response = await fetchImpl(path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: requestSignal(signal),
      });
    } catch (err) {
      // The caller cancelled (e.g. a newer search replaced this one): pass the AbortError on.
      if (signal?.aborted) throw err;
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw failure(MESSAGES.timeout, err);
      if (local && localHints[service]) {
        throw failure(`Can't reach the Sizemill server — ${localHints[service]}.`, err);
      }
      throw failure(MESSAGES.network, err);
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null; // e.g. an HTML error page from a host without the API
    }

    if (!response.ok) {
      if (local && localHints[service] && [401, 403, 404, 405].includes(response.status)) {
        throw new Error(`${localNames[service]} needs a signed-in Sizemill account, so it's off in local mode — ${localHints[service]}.`);
      }
      if (typeof payload?.error === 'string' && payload.error.trim()) throw new Error(payload.error.trim());
      throw new Error(httpStatusMessage(response.status));
    }
    if (!isPlainObject(payload)) throw new Error(MESSAGES.unreadableReply);
    return payload;
  }

  return {
    // origin/destination: { lat, lng, label? } or { address }.
    async route(origin, destination) {
      if (!isPlainObject(origin) || !isPlainObject(destination)) throw new Error('Choose where the trip starts and ends.');
      return request('/api/route', { method: 'POST', body: { origin, destination }, service: 'route', authenticated: true });
    },

    // options.signal: an AbortSignal; aborting rejects with the AbortError and cancels the fetch.
    async places(q, { signal } = {}) {
      const query = String(q ?? '').trim().replace(/\s+/g, ' ');
      if (query.length < PLACES_MIN_QUERY) return { ok: true, results: [] };
      return request(`/api/places?q=${encodeURIComponent(query)}`, { service: 'places', authenticated: true, signal });
    },

    // Public data, sent without a token and with coordinates rounded to 2 dp (about 1 km) so
    // nearby lookups share one CDN-cached response.
    async fuel({ lat, lng, type } = {}) {
      const params = new URLSearchParams();
      const latitude = finiteOrNull(lat);
      const longitude = finiteOrNull(lng);
      if (latitude !== null && longitude !== null) {
        params.set('lat', (Math.round(latitude * 100) / 100).toFixed(2));
        params.set('lng', (Math.round(longitude * 100) / 100).toFixed(2));
      }
      if (!isBlank(type ?? null)) params.set('type', String(type).trim().toUpperCase());
      const queryString = params.toString();
      return request(`/api/fuel${queryString ? `?${queryString}` : ''}`, { service: 'fuel', authenticated: false });
    },
  };
}

function httpStatusMessage(status) {
  if (status === 401) return MESSAGES.sessionExpired;
  if (status === 403) return MESSAGES.forbidden;
  if (status === 404) return "That service isn't available right now.";
  if (status === 429) return 'Too many requests — wait a moment and try again.';
  if (status >= 500) return MESSAGES.serverError;
  return MESSAGES.generic;
}

// ---------------------------------------------------------------------------------------------
// Supabase mode
// ---------------------------------------------------------------------------------------------

function createBrowserSupabaseClient() {
  const library = globalThis.window?.supabase ?? globalThis.supabase;
  if (typeof library?.createClient !== 'function') throw new Error(MESSAGES.noClientLibrary);
  // Same storage as the original app on this origin, so its stored session is shared. PKCE:
  // email links come back as ?code=, which only the browser that asked for the link can
  // exchange, so a crafted #access_token link can't swap in someone else's session.
  return library.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
}

function applyOrder(query, spec, referencedTable) {
  let ordered = query;
  for (const [column, direction = 'asc'] of spec) {
    ordered = ordered.order(column, {
      ascending: direction === 'asc',
      nullsFirst: false,
      ...(referencedTable ? { referencedTable } : {}),
    });
  }
  return ordered;
}

async function createSupabaseStore({ client, fetchImpl }) {
  const changes = createEmitter();
  const authChanges = createEmitter();
  let currentUser = null;

  // Resolves after supabase-js has finished initialising, including reading a magic-link
  // session out of the URL. An unreadable stored session simply means "signed out".
  try {
    const { data } = await client.auth.getSession();
    currentUser = toUser(data?.session?.user);
  } catch {
    currentUser = null;
  }

  // Only real identity changes reach listeners, not every token refresh.
  function setUser(user) {
    const next = toUser(user);
    if (next?.id === currentUser?.id && next?.email === currentUser?.email) return;
    currentUser = next;
    authChanges.emit(currentUser);
  }
  client.auth.onAuthStateChange((_event, session) => setUser(session?.user ?? null));

  async function run(builder) {
    let result;
    try {
      result = await builder;
    } catch (err) {
      throw failure(describeDbError(err, undefined), err);
    }
    if (result.error) throw failure(describeDbError(result.error, result.status), result.error);
    return result.data;
  }

  function requireSignedIn() {
    if (!currentUser) throw new Error(MESSAGES.signedOut);
  }

  // Every row of a list, a page at a time: PostgREST silently stops at its Max rows (1000).
  // build() returns a fresh, fully ordered query for each page.
  async function selectAll(build) {
    const rows = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      const page = await run(build().range(from, from + PAGE_SIZE - 1));
      rows.push(...(page ?? []));
      if (!page || page.length < PAGE_SIZE) return rows;
    }
  }

  function requireId(id, message = MESSAGES.notFound) {
    if (!isUuid(id)) throw new Error(message);
  }

  async function selectById(table, id, select = '*') {
    requireSignedIn();
    if (!isUuid(id)) return null;
    return run(client.from(table).select(select).eq('id', id).maybeSingle());
  }

  async function insertOne(table, values, select = '*') {
    requireSignedIn();
    const row = await run(client.from(table).insert(values).select(select).single());
    changes.emit();
    return row;
  }

  async function updateById(table, id, values, select = '*') {
    requireSignedIn();
    requireId(id);
    if (isEmpty(values)) {
      const current = await selectById(table, id, select);
      if (!current) throw new Error(MESSAGES.notFound);
      return current;
    }
    const row = await run(client.from(table).update(values).eq('id', id).select(select).single());
    changes.emit();
    return row;
  }

  async function deleteById(table, id) {
    requireSignedIn();
    requireId(id);
    await run(client.from(table).delete().eq('id', id));
    changes.emit();
  }

  async function listRows(table, { includeArchived }) {
    requireSignedIn();
    return selectAll(() => {
      let query = client.from(table).select('*');
      if (!includeArchived) query = query.eq('archived', false);
      return applyOrder(query, ORDER[table]);
    });
  }

  function dealQuery() {
    let query = client.from('deals').select(DEAL_SELECT);
    for (const [key, , spec] of DEAL_CHILDREN) query = applyOrder(query, spec, key);
    return query;
  }

  async function getDeal(id) {
    requireSignedIn();
    if (!isUuid(id)) return null;
    return run(dealQuery().eq('id', id).maybeSingle());
  }

  async function getSettings() {
    requireSignedIn();
    return settingsFromRow(await run(client.from('desk_settings').select('*').maybeSingle()));
  }

  async function saveSettings(patch) {
    requireSignedIn();
    const values = prepareWrite('desk_settings', patch, 'update');
    if (isEmpty(values)) return getSettings();
    const row = await run(client.from('desk_settings').upsert(values, { onConflict: 'owner' }).select('*').single());
    changes.emit();
    return settingsFromRow(row);
  }

  // Best effort: deletes every file in the owner's logo folder except `keep`. A failure only
  // leaves an unused file behind, so it is logged, never shown.
  async function removeLogoFiles(uid, keep) {
    try {
      const bucket = client.storage.from(LOGO_BUCKET);
      const { data, error } = await bucket.list(uid, { limit: 100 });
      if (error) throw error;
      const stale = (data ?? []).map((file) => file?.name).filter((name) => name && name !== keep).map((name) => `${uid}/${name}`);
      if (stale.length) await bestEffortRemove(stale);
    } catch (err) {
      console.warn('[store] could not tidy old logos', err);
    }
  }

  async function bestEffortRemove(paths) {
    try {
      const removed = await client.storage.from(LOGO_BUCKET).remove(paths);
      if (removed?.error) throw removed.error;
    } catch (err) {
      console.warn('[store] could not delete logo files', err);
    }
  }

  async function nextItemPosition(dealId) {
    const last = await run(
      client.from('deal_items').select('position').eq('deal_id', dealId)
        .order('position', { ascending: false }).limit(1).maybeSingle(),
    );
    return last ? last.position + 1 : 0;
  }

  // Every method is async so that bad input rejects instead of throwing synchronously.
  const rowTable = (table) => ({
    list: async ({ includeArchived = false } = {}) => listRows(table, { includeArchived }),
    get: async (id) => selectById(table, id),
    create: async (data) => insertOne(table, prepareWrite(table, data, 'insert')),
    update: async (id, patch) => updateById(table, id, prepareWrite(table, patch, 'update')),
    remove: async (id) => deleteById(table, id),
  });

  return {
    mode: 'supabase',

    auth: {
      user: () => currentUser,
      onChange: (callback) => authChanges.subscribe(callback),

      async signIn(email, password) {
        const { data, error } = await client.auth.signInWithPassword({
          email: requireEmail(email),
          password: requirePassword(password),
        });
        if (error) throw failure(describeAuthError(error), error);
        setUser(data.user);
        return currentUser;
      },

      // Resolves { user, needsConfirmation }: true when Supabase emailed a confirmation link
      // and the account can't sign in until it is opened.
      async signUp(email, password) {
        const { data, error } = await client.auth.signUp({
          email: requireEmail(email),
          password: requirePassword(password),
          options: { emailRedirectTo: signUpRedirect() },
        });
        if (error) throw failure(describeAuthError(error), error);
        // With email confirmation on, Supabase answers a sign-up for an existing address
        // with a stand-in user that has no identities instead of an error.
        if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
          throw new Error(MESSAGES.accountExists);
        }
        if (data.session) setUser(data.session.user);
        return { user: toUser(data.user), needsConfirmation: !data.session };
      },

      async magicLink(email) {
        const { error } = await client.auth.signInWithOtp({
          email: requireEmail(email),
          options: { emailRedirectTo: signUpRedirect() },
        });
        if (error) throw failure(describeAuthError(error), error);
      },

      // 'local' signs out this browser only; the default would end every device's session.
      async signOut() {
        const { error } = await client.auth.signOut({ scope: 'local' });
        if (error) throw failure(describeAuthError(error), error);
        setUser(null);
      },
    },

    settings: {
      get: getSettings,
      save: saveSettings,

      // blob: a PNG/JPEG/WebP of at most 1 MB (brand.js prepareLogo makes one from any photo).
      // Uploads it to brand/<uid>/logo-<ms>.<ext>, saves its public URL as logo_url, then tidies
      // away older logos. Resolves the saved settings.
      async uploadLogo(blob, size = {}) {
        requireSignedIn();
        const ext = checkLogo(blob);
        const uid = currentUser.id;
        const path = `${uid}/logo-${Date.now()}.${ext}`;
        const bucket = client.storage.from(LOGO_BUCKET);
        let uploaded;
        try {
          uploaded = await bucket.upload(path, blob, { contentType: blob.type, cacheControl: '31536000', upsert: false });
        } catch (err) {
          throw failure(describeStorageError(err), err);
        }
        if (uploaded?.error) throw failure(describeStorageError(uploaded.error), uploaded.error);
        const publicUrl = bucket.getPublicUrl(path)?.data?.publicUrl;
        let saved;
        try {
          if (!publicUrl) throw new Error(LOGO_MESSAGES.uploadFailed);
          saved = await saveSettings({ logo_url: `${publicUrl}${logoFragment(size)}` });
        } catch (err) {
          // Keep the old logo: drop only the new file, which nothing points at.
          await bestEffortRemove([path]);
          throw err;
        }
        await removeLogoFiles(uid, path.slice(uid.length + 1));
        return saved;
      },

      // Clears logo_url, then deletes the files. Resolves the saved settings.
      async removeLogo() {
        requireSignedIn();
        const uid = currentUser.id;
        const saved = await saveSettings({ logo_url: null });
        await removeLogoFiles(uid, null);
        return saved;
      },
    },

    clients: rowTable('clients'),

    stock: rowTable('stock_items'),

    deals: {
      async list() {
        requireSignedIn();
        return selectAll(() => applyOrder(dealQuery(), ORDER.deals));
      },

      get: getDeal,

      async create({ deal = {}, items = [], costs = [] } = {}) {
        requireSignedIn();
        if (!Array.isArray(items) || !Array.isArray(costs)) throw new Error('Items and costs must be lists.');
        const dealValues = prepareWrite('deals', deal, 'insert');
        const itemValues = items.map((item, index) => ({ position: index, ...prepareWrite('deal_items', item, 'insert') }));
        const costValues = costs.map((cost) => prepareWrite('deal_costs', cost, 'insert'));

        // The sale and its lines take several requests, so check every line first: a bad
        // line must not leave a half-saved sale behind.
        const pendingDealId = '00000000-0000-4000-8000-000000000000';
        assertValidRow('deals', { ...defaultsFor('deals'), ...dealValues });
        for (const values of itemValues) assertValidRow('deal_items', { ...defaultsFor('deal_items'), ...values, deal_id: pendingDealId });
        for (const values of costValues) assertValidRow('deal_costs', { ...defaultsFor('deal_costs'), ...values, deal_id: pendingDealId });

        const created = await run(client.from('deals').insert(dealValues).select('id').single());
        try {
          // defaultToNull: false lets columns missing from some rows take their SQL defaults.
          if (itemValues.length) {
            await run(client.from('deal_items').insert(
              itemValues.map((values) => ({ ...values, deal_id: created.id })),
              { defaultToNull: false },
            ));
          }
          if (costValues.length) {
            await run(client.from('deal_costs').insert(
              costValues.map((values) => ({ ...values, deal_id: created.id })),
              { defaultToNull: false },
            ));
          }
        } catch (err) {
          // Roll back by hand (items and costs cascade) so a retry doesn't duplicate the sale.
          // If even that fails, the original error is still the one worth reporting.
          await run(client.from('deals').delete().eq('id', created.id)).catch(() => {});
          throw err;
        }
        changes.emit();
        return getDeal(created.id);
      },

      // Resolves the full deal, shaped as get().
      async update(id, patch) {
        await updateById('deals', id, prepareWrite('deals', patch, 'update'), 'id');
        return getDeal(id);
      },

      remove: async (id) => deleteById('deals', id),
    },

    items: {
      async create(dealId, item) {
        requireSignedIn();
        requireId(dealId, MISSING_PARENT.deals);
        const values = prepareWrite('deal_items', item, 'insert');
        if (values.position === undefined) values.position = await nextItemPosition(dealId);
        return insertOne('deal_items', { ...values, deal_id: dealId });
      },
      update: async (id, patch) => updateById('deal_items', id, prepareWrite('deal_items', patch, 'update')),
      remove: async (id) => deleteById('deal_items', id),
    },

    costs: {
      async create(dealId, cost) {
        requireId(dealId, MISSING_PARENT.deals);
        return insertOne('deal_costs', { ...prepareWrite('deal_costs', cost, 'insert'), deal_id: dealId });
      },
      update: async (id, patch) => updateById('deal_costs', id, prepareWrite('deal_costs', patch, 'update')),
      remove: async (id) => deleteById('deal_costs', id),
    },

    payments: {
      async create(dealId, payment) {
        requireId(dealId, MISSING_PARENT.deals);
        return insertOne('payments', { ...prepareWrite('payments', payment, 'insert'), deal_id: dealId });
      },
      remove: async (id) => deleteById('payments', id),
    },

    trips: {
      async list() {
        requireSignedIn();
        return selectAll(() => applyOrder(client.from('trips').select(TRIP_SELECT), ORDER.trips));
      },
      create: async (trip) => insertOne('trips', prepareWrite('trips', trip, 'insert'), TRIP_SELECT),
      update: async (id, patch) => updateById('trips', id, prepareWrite('trips', patch, 'update'), TRIP_SELECT),
      remove: async (id) => deleteById('trips', id),
    },

    api: createApiClient({
      fetchImpl,
      async getAccessToken() {
        // getSession() refreshes an expired access token before handing it out.
        const { data, error } = await client.auth.getSession();
        if (error) throw failure(describeAuthError(error), error);
        return data?.session?.access_token ?? null;
      },
    }),

    subscribe: (callback) => changes.subscribe(callback),
  };
}

// ---------------------------------------------------------------------------------------------
// Memory mode
// ---------------------------------------------------------------------------------------------

function newId() {
  const crypto = globalThis.crypto;
  if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
  // randomUUID only exists in secure contexts; build a v4 uuid by hand elsewhere (e.g. a
  // phone testing the app over plain http on the local network).
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Strictly increasing ISO timestamps, so rows written in the same millisecond still sort in
// the order they were written.
function createClock() {
  let last = 0;
  return () => {
    last = Math.max(Date.now(), last + 1);
    return new Date(last).toISOString();
  };
}

function emptyDatabase() {
  const db = { version: LOCAL_DB_VERSION };
  for (const table of TABLES) db[table] = [];
  return db;
}

function readStorage(storage, key) {
  try {
    return storage ? storage.getItem(key) : null;
  } catch {
    return null; // storage blocked (e.g. some private browsing modes): run without it
  }
}

function loadDatabase(storage) {
  const raw = readStorage(storage, LOCAL_STORAGE_KEY);
  if (raw === null) return emptyDatabase();
  try {
    const saved = JSON.parse(raw);
    if (!isPlainObject(saved) || saved.version !== LOCAL_DB_VERSION) throw new Error('unrecognised local data format');
    const db = emptyDatabase();
    for (const table of TABLES) if (Array.isArray(saved[table])) db[table] = saved[table];
    return db;
  } catch (err) {
    // Park the unreadable copy under a side key instead of overwriting it on the next save.
    try {
      storage.setItem(`${LOCAL_STORAGE_KEY}.unreadable`, raw);
    } catch {
      // Nothing more can be done; the warning below still explains the empty start.
    }
    console.warn('[store] local data could not be read; starting empty', err);
    return emptyDatabase();
  }
}

const textCollator = new Intl.Collator('en-GB');

// Ascending order with NULLs last; text columns use locale-aware ordering like Postgres.
function compareValues(a, b, type) {
  if (isNull(a) || isNull(b)) return isNull(a) === isNull(b) ? 0 : isNull(a) ? 1 : -1;
  if (type === 'text') return textCollator.compare(a, b);
  return a < b ? -1 : a > b ? 1 : 0;
}

// Comparator for an ORDER spec. NULLs sort last in either direction, as the Supabase queries
// request with nullsFirst: false.
function comparator(table, spec) {
  return (x, y) => {
    for (const [column, direction = 'asc'] of spec) {
      const type = SCHEMA[table].columns[column]?.type;
      const result = compareValues(x[column], y[column], type);
      if (result === 0) continue;
      const bothPresent = !isNull(x[column]) && !isNull(y[column]);
      return bothPresent && direction === 'desc' ? -result : result;
    }
    return 0;
  };
}

function sortRows(table, rows, spec = ORDER[table]) {
  return [...rows].sort(comparator(table, spec));
}

function groupBy(rows, column) {
  const groups = new Map();
  for (const row of rows) {
    const key = row[column];
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

function createMemoryStore({ storage, fetchImpl, watchStorage }) {
  const changes = createEmitter();
  const clock = createClock();
  let db = loadDatabase(storage);

  // Another tab in local mode saved: adopt its data so this tab doesn't overwrite it later.
  if (watchStorage && typeof globalThis.addEventListener === 'function') {
    globalThis.addEventListener('storage', (event) => {
      if (event.key !== LOCAL_STORAGE_KEY) return;
      db = loadDatabase(storage);
      changes.emit();
    });
  }

  // Runs a write against a copy of the database and commits it only if every step succeeds
  // and it was persisted, which makes multi-row writes (a sale with its lines) atomic.
  function transact(mutate) {
    const draft = structuredClone(db);
    const result = mutate(draft);
    if (storage) {
      try {
        storage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(draft));
      } catch (err) {
        throw failure(MESSAGES.storageFull, err);
      }
    }
    db = draft;
    changes.emit();
    return result === undefined ? undefined : structuredClone(result);
  }

  // Reads hand out copies so callers can never mutate the database by accident.
  function read(select) {
    return structuredClone(select(db));
  }

  function findRow(source, table, id) {
    const key = SCHEMA[table].key;
    return source[table].find((row) => row[key] === id) ?? null;
  }

  function assertParentsExist(source, table, row) {
    for (const fk of FOREIGN_KEYS) {
      if (fk.table === table && !isNull(row[fk.column]) && !findRow(source, fk.parent, row[fk.column])) {
        throw new Error(fk.message);
      }
    }
  }

  function insertRow(draft, table, values, generated = {}) {
    const { key, created, updated } = SCHEMA[table];
    const now = clock();
    const row = {
      ...(key === 'id' ? { id: newId() } : {}),
      owner: LOCAL_USER.id,
      ...defaultsFor(table),
      ...values,
      ...generated,
      ...(created ? { created_at: now } : {}),
      ...(updated ? { updated_at: now } : {}),
    };
    assertValidRow(table, row);
    assertParentsExist(draft, table, row);
    draft[table].push(row);
    return row;
  }

  function updateRow(draft, table, id, values) {
    const row = findRow(draft, table, id);
    if (!row) throw new Error(MESSAGES.notFound);
    const next = { ...row, ...values, ...(SCHEMA[table].updated ? { updated_at: clock() } : {}) };
    assertValidRow(table, next);
    assertParentsExist(draft, table, next);
    return Object.assign(row, next);
  }

  // Deletes a row and applies each referencing foreign key's ON DELETE action, recursively,
  // exactly as Postgres would. A SET NULL is an UPDATE there, so it bumps updated_at too.
  function deleteRow(draft, table, id) {
    const index = draft[table].findIndex((row) => row[SCHEMA[table].key] === id);
    if (index === -1) return;
    draft[table].splice(index, 1);
    for (const fk of FOREIGN_KEYS) {
      if (fk.parent !== table) continue;
      for (const child of draft[fk.table].filter((row) => row[fk.column] === id)) {
        if (fk.onDelete === 'cascade') {
          deleteRow(draft, fk.table, child.id);
        } else {
          child[fk.column] = null;
          if (SCHEMA[fk.table].updated) child.updated_at = clock();
        }
      }
    }
  }

  function nextDealNumber(source) {
    let max = 0;
    for (const deal of source.deals) if (deal.owner === LOCAL_USER.id && deal.number > max) max = deal.number;
    return max + 1;
  }

  function nextItemPosition(source, dealId) {
    let max = -1;
    for (const item of source.deal_items) if (item.deal_id === dealId && item.position > max) max = item.position;
    return max + 1;
  }

  // Deals with embedded client and children, the same shape as the Supabase embedded select.
  function shapeDeals(source, deals) {
    const clientsById = new Map(source.clients.map((client) => [client.id, client]));
    const children = DEAL_CHILDREN.map(([key, table, spec]) => [key, table, spec, groupBy(source[table], 'deal_id')]);
    return deals.map((deal) => {
      const client = clientsById.get(deal.client_id);
      const shaped = { ...deal, client: client ? { id: client.id, name: client.name, club: client.club } : null };
      for (const [key, table, spec, groups] of children) shaped[key] = sortRows(table, groups.get(deal.id) ?? [], spec);
      return shaped;
    });
  }

  function shapeDeal(source, id) {
    const deal = isUuid(id) ? findRow(source, 'deals', id) : null;
    return deal ? shapeDeals(source, [deal])[0] : null;
  }

  function shapeTrips(source, trips) {
    const dealsById = new Map(source.deals.map((deal) => [deal.id, deal]));
    const clientsById = new Map(source.clients.map((client) => [client.id, client]));
    return trips.map((trip) => {
      const deal = dealsById.get(trip.deal_id);
      const client = clientsById.get(trip.client_id);
      return {
        ...trip,
        deal: deal ? { id: deal.id, number: deal.number, title: deal.title } : null,
        client: client ? { id: client.id, name: client.name } : null,
      };
    });
  }

  // Updates that end up with nothing to write return the current row untouched (no write,
  // no notification), matching Supabase mode.
  function updateOrRead(table, id, patch, shape) {
    const values = prepareWrite(table, patch, 'update');
    if (isEmpty(values)) {
      const current = read((source) => (isUuid(id) && findRow(source, table, id) ? shape(source, id) : null));
      if (!current) throw new Error(MESSAGES.notFound);
      return current;
    }
    return transact((draft) => {
      updateRow(draft, table, id, values);
      return shape(draft, id);
    });
  }

  function getSettings() {
    return read((source) => settingsFromRow(source.desk_settings[0]));
  }

  function saveSettings(patch) {
    const values = prepareWrite('desk_settings', patch, 'update');
    if (isEmpty(values)) return getSettings();
    return transact((draft) => {
      const existing = draft.desk_settings[0];
      const row = existing
        ? updateRow(draft, 'desk_settings', existing.owner, values)
        : insertRow(draft, 'desk_settings', values);
      return settingsFromRow(row);
    });
  }

  const rowById = (table) => (source, id) => findRow(source, table, id);
  const tripById = (source, id) => shapeTrips(source, [findRow(source, 'trips', id)])[0];

  function removeById(table, id) {
    transact((draft) => deleteRow(draft, table, id));
  }

  function createChild(table, dealId, data) {
    if (!isUuid(dealId)) throw new Error(MISSING_PARENT.deals);
    const values = prepareWrite(table, data, 'insert');
    return transact((draft) => {
      if (table === 'deal_items' && values.position === undefined) values.position = nextItemPosition(draft, dealId);
      return insertRow(draft, table, values, { deal_id: dealId });
    });
  }

  const rowTable = (table) => ({
    async list({ includeArchived = false } = {}) {
      return read((source) => sortRows(table, source[table].filter((row) => includeArchived || !row.archived)));
    },
    async get(id) {
      return read((source) => findRow(source, table, id));
    },
    async create(data) {
      const values = prepareWrite(table, data, 'insert');
      return transact((draft) => insertRow(draft, table, values));
    },
    async update(id, patch) {
      return updateOrRead(table, id, patch, rowById(table));
    },
    async remove(id) {
      removeById(table, id);
    },
  });

  return {
    mode: 'memory',

    auth: {
      user: () => LOCAL_USER,
      // Local mode is always signed in as the device user, so there is never a change to report.
      onChange: () => () => {},
      signIn: async () => LOCAL_USER,
      signUp: async () => ({ user: LOCAL_USER, needsConfirmation: false }),
      magicLink: async () => {},
      signOut: async () => {},
    },

    settings: {
      get: async () => getSettings(),
      save: async (patch) => saveSettings(patch),
      // Local mode keeps the image itself, as a data: URL, in this browser's storage.
      async uploadLogo(blob, size = {}) {
        const ext = checkLogo(blob);
        const type = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
        const bytes = new Uint8Array(await blob.arrayBuffer());
        return saveSettings({ logo_url: `data:${type};base64,${bytesToBase64(bytes)}${logoFragment(size)}` });
      },
      removeLogo: async () => saveSettings({ logo_url: null }),
    },

    clients: rowTable('clients'),

    stock: rowTable('stock_items'),

    deals: {
      async list() {
        return read((source) => shapeDeals(source, sortRows('deals', source.deals)));
      },

      async get(id) {
        return read((source) => shapeDeal(source, id));
      },

      async create({ deal = {}, items = [], costs = [] } = {}) {
        if (!Array.isArray(items) || !Array.isArray(costs)) throw new Error('Items and costs must be lists.');
        const dealValues = prepareWrite('deals', deal, 'insert');
        const itemValues = items.map((item, index) => ({ position: index, ...prepareWrite('deal_items', item, 'insert') }));
        const costValues = costs.map((cost) => prepareWrite('deal_costs', cost, 'insert'));
        return transact((draft) => {
          const created = insertRow(draft, 'deals', dealValues, { number: nextDealNumber(draft) });
          for (const values of itemValues) insertRow(draft, 'deal_items', values, { deal_id: created.id });
          for (const values of costValues) insertRow(draft, 'deal_costs', values, { deal_id: created.id });
          return shapeDeal(draft, created.id);
        });
      },

      // Resolves the full deal, shaped as get().
      async update(id, patch) {
        return updateOrRead('deals', id, patch, shapeDeal);
      },

      async remove(id) {
        removeById('deals', id);
      },
    },

    items: {
      create: async (dealId, item) => createChild('deal_items', dealId, item),
      update: async (id, patch) => updateOrRead('deal_items', id, patch, rowById('deal_items')),
      remove: async (id) => removeById('deal_items', id),
    },

    costs: {
      create: async (dealId, cost) => createChild('deal_costs', dealId, cost),
      update: async (id, patch) => updateOrRead('deal_costs', id, patch, rowById('deal_costs')),
      remove: async (id) => removeById('deal_costs', id),
    },

    payments: {
      create: async (dealId, payment) => createChild('payments', dealId, payment),
      remove: async (id) => removeById('payments', id),
    },

    trips: {
      async list() {
        return read((source) => shapeTrips(source, sortRows('trips', source.trips)));
      },
      async create(trip) {
        const values = prepareWrite('trips', trip, 'insert');
        return transact((draft) => tripById(draft, insertRow(draft, 'trips', values).id));
      },
      update: async (id, patch) => updateOrRead('trips', id, patch, tripById),
      remove: async (id) => removeById('trips', id),
    },

    api: createApiClient({ fetchImpl, getAccessToken: null }),

    subscribe: (callback) => changes.subscribe(callback),
  };
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

function browserStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // reading localStorage itself throws when site data is blocked
  }
}

// mode: 'supabase' (default) or 'memory'. The other options exist so tests can run without a
// browser: storage (default window.localStorage; null disables persistence), fetchImpl
// (default global fetch) and supabaseClient (default a client built from the UMD global).
// In Supabase mode, create the store before routing: it resolves once supabase-js has
// consumed any magic-link tokens in the URL hash.
export async function createStore({ mode = 'supabase', storage, fetchImpl, supabaseClient } = {}) {
  const fetchFn = fetchImpl ?? ((...args) => globalThis.fetch(...args));
  if (mode === 'memory') {
    const usesBrowserStorage = storage === undefined;
    return Object.freeze(createMemoryStore({
      storage: usesBrowserStorage ? browserStorage() : storage,
      fetchImpl: fetchFn,
      watchStorage: usesBrowserStorage,
    }));
  }
  if (mode !== 'supabase') throw new Error(`Unknown store mode '${mode}'.`);
  return Object.freeze(await createSupabaseStore({
    client: supabaseClient ?? createBrowserSupabaseClient(),
    fetchImpl: fetchFn,
  }));
}

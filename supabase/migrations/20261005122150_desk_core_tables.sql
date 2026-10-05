-- =============================================================================================
-- Sizemill Desk: core schema (docs/desk-spec.md, section 2)
--
-- Tables: desk_settings, clients, stock_items, deals, deal_items, deal_costs, payments, trips.
-- Every row belongs to one auth user (`owner`). Row level security restricts each signed-in
-- user to their own rows, and writes to child rows must also point at parents the caller owns.
-- The anon role gets no table privileges at all.
--
-- Conventions
--   * Money is numeric(12,2) in GBP, distances are miles, fuel economy is UK mpg, fuel prices
--     are pence per litre. Derived figures (profit, fuel cost, ...) are never stored; they are
--     computed by public/desk/lib/calc.js from the inputs kept here.
--   * Date defaults use the Europe/London calendar day rather than the server's UTC
--     current_date, so a sale logged at 00:30 BST lands on the day the owner sees in the UI.
--
-- Applying
--   No explicit BEGIN/COMMIT: the Supabase CLI and apply_migration already run each migration
--   file in a single transaction (use `psql --single-transaction` if applying by hand). Every
--   statement is re-runnable (if not exists / or replace). Tables are created with RLS on and
--   no policies, so they are closed until the three policy migrations that follow:
--   20261005122336_desk_policies_simple_tables, 20261005122345_desk_policies_deals and
--   20261005122400_desk_policies_costs_payments_trips (applied as separate batches).
-- =============================================================================================


-- ---------------------------------------------------------------------------------------------
-- Trigger functions
-- ---------------------------------------------------------------------------------------------

-- Stamps updated_at on every UPDATE. Desk keeps its own function instead of reusing the
-- existing public.set_updated_at (owned by the original app and lacking a pinned search_path).
create or replace function public.desk_set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := pg_catalog.now();
  return new;
end;
$$;

comment on function public.desk_set_updated_at() is
  'Desk: BEFORE UPDATE trigger that sets updated_at to the transaction timestamp.';

-- Gives each new deal the next per-owner number (1, 2, 3, ... shown as SM-0001). Any number
-- supplied by the client is ignored. Being max + 1 (as specified), deleting the newest deal
-- frees its number for the next one; gaps elsewhere are never refilled.
--
-- Concurrency: two inserts for the same owner could otherwise both read the same max(number).
-- A transaction-scoped advisory lock keyed on the owner serialises them; it is released at
-- commit/rollback, and because this function is VOLATILE the max() below takes a fresh
-- snapshot after the lock is granted, so it sees the other transaction's committed row.
-- unique (owner, number) remains the backstop (e.g. under REPEATABLE READ, where the snapshot
-- predates the lock, a clash raises 23505 instead of silently duplicating).
--
-- SECURITY INVOKER is sufficient: the only rows max() needs are the caller's own, which the
-- deals SELECT policy lets them read, and an insert for any other owner is rejected by the
-- INSERT policy anyway. service_role bypasses RLS and therefore also sees every row it needs.
create or replace function public.desk_assign_deal_number()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('public.deals.number'),
    pg_catalog.hashtext(new.owner::text)
  );

  select coalesce(pg_catalog.max(d.number), 0) + 1
    into new.number
    from public.deals as d
   where d.owner = new.owner;

  return new;
end;
$$;

comment on function public.desk_assign_deal_number() is
  'Desk: BEFORE INSERT trigger on deals assigning max(number)+1 per owner under an owner-keyed advisory lock.';

-- Trigger functions are only ever invoked by their triggers (Postgres does not check EXECUTE
-- when a trigger fires), so nobody needs to be able to call them directly.
revoke all on function public.desk_set_updated_at() from public, anon, authenticated;
revoke all on function public.desk_assign_deal_number() from public, anon, authenticated;


-- ---------------------------------------------------------------------------------------------
-- desk_settings: one row per owner
-- ---------------------------------------------------------------------------------------------

create table if not exists public.desk_settings (
  owner                     uuid primary key default auth.uid()
                              references auth.users (id) on delete cascade,
  business_name             text default 'Sizemill',
  home_label                text,
  home_address              text,
  home_lat                  double precision,
  home_lng                  double precision,
  mpg                       numeric(5,1) not null default 45,
  fuel_type                 text not null default 'E10',
  hourly_rate               numeric(8,2) not null default 20,
  vehicle_cost_per_mile     numeric(6,3) not null default 0,
  round_trip_default        boolean not null default true,
  handover_minutes_default  integer not null default 15,
  target_margin             numeric(5,2) not null default 0.25,
  updated_at                timestamptz not null default now(),

  constraint desk_settings_mpg_positive          check (mpg > 0),
  constraint desk_settings_fuel_type_valid       check (fuel_type in ('E10', 'E5', 'B7', 'SDV')),
  constraint desk_settings_hourly_rate_nonneg    check (hourly_rate >= 0),
  constraint desk_settings_wear_nonneg           check (vehicle_cost_per_mile >= 0),
  constraint desk_settings_handover_nonneg       check (handover_minutes_default >= 0),
  -- Stored as a fraction (0.25 = 25%); this also catches a percentage saved by mistake.
  constraint desk_settings_target_margin_range   check (target_margin >= 0 and target_margin < 1),
  constraint desk_settings_home_lat_range        check (home_lat between -90 and 90),
  constraint desk_settings_home_lng_range        check (home_lng between -180 and 180),
  constraint desk_settings_home_coords_pair      check ((home_lat is null) = (home_lng is null))
);

comment on table public.desk_settings is
  'Desk: per-owner defaults (home, vehicle, fuel, hourly rate, target margin). One row per user.';


-- ---------------------------------------------------------------------------------------------
-- clients: the footballers (and anyone else) the owner sells to
-- ---------------------------------------------------------------------------------------------

create table if not exists public.clients (
  id             uuid primary key default gen_random_uuid(),
  owner          uuid not null default auth.uid()
                   references auth.users (id) on delete cascade,
  name           text not null,
  club           text,
  position       text,
  squad_number   text,
  agent_name     text,
  agent_phone    text,
  agent_email    text,
  phone          text,
  email          text,
  instagram      text,
  shoe_size      text,
  clothing_size  text,
  preferences    text,
  notes          text,
  tags           text[] not null default '{}',
  birthday       date,
  -- [{ "label": "Training ground", "address": "...", "lat": 50.9, "lng": -1.4 }]
  addresses      jsonb not null default '[]'::jsonb,
  archived       boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint clients_name_not_blank      check (btrim(name) <> ''),
  constraint clients_addresses_is_array  check (jsonb_typeof(addresses) = 'array')
);

comment on table public.clients is 'Desk: client profiles (players, agents, contact details, sizes, addresses).';


-- ---------------------------------------------------------------------------------------------
-- stock_items: things bought and held, not yet tied to a sale
-- ---------------------------------------------------------------------------------------------

create table if not exists public.stock_items (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null default auth.uid()
                references auth.users (id) on delete cascade,
  name        text not null,
  brand       text,
  sku         text,
  size        text,
  condition   text not null default 'new',
  qty         integer not null default 1,
  unit_cost   numeric(12,2) not null,
  bought_at   date default (now() at time zone 'Europe/London')::date,
  supplier    text,
  location    text,
  notes       text,
  archived    boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint stock_items_name_not_blank      check (btrim(name) <> ''),
  constraint stock_items_condition_valid     check (condition in ('new', 'used')),
  constraint stock_items_qty_nonneg          check (qty >= 0),
  constraint stock_items_unit_cost_nonneg    check (unit_cost >= 0)
);

comment on table public.stock_items is
  'Desk: stock bought and held. On-hand = qty minus quantities allocated to non-cancelled deals (calc.js).';


-- ---------------------------------------------------------------------------------------------
-- deals: a sale to a client; may hold several items
-- ---------------------------------------------------------------------------------------------

create table if not exists public.deals (
  id               uuid primary key default gen_random_uuid(),
  owner            uuid not null default auth.uid()
                     references auth.users (id) on delete cascade,
  -- Set by the deals_assign_number trigger (BEFORE INSERT runs before the NOT NULL check).
  number           integer not null,
  client_id        uuid references public.clients (id) on delete set null,
  title            text,
  status           text not null default 'agreed',
  sale_date        date not null default (now() at time zone 'Europe/London')::date,
  due_date         date,
  delivery_method  text not null default 'drop_off',
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint deals_owner_number_key        unique (owner, number),
  constraint deals_number_positive         check (number > 0),
  constraint deals_status_valid            check (status in (
                                             'enquiry', 'agreed', 'sourcing', 'ready',
                                             'delivered', 'completed', 'cancelled')),
  constraint deals_delivery_method_valid   check (delivery_method in ('drop_off', 'meet', 'post', 'collection'))
);

comment on table public.deals is 'Desk: sales. number is a per-owner sequence shown as SM-0007.';


-- ---------------------------------------------------------------------------------------------
-- deal_items: what was sold on a deal, with expected or actual cost
-- ---------------------------------------------------------------------------------------------

create table if not exists public.deal_items (
  id                  uuid primary key default gen_random_uuid(),
  owner               uuid not null default auth.uid()
                        references auth.users (id) on delete cascade,
  deal_id             uuid not null references public.deals (id) on delete cascade,
  position            integer not null default 0,
  description         text not null,
  brand               text,
  sku                 text,
  size                text,
  qty                 integer not null default 1,
  unit_price          numeric(12,2) not null default 0,
  -- 'expected': not bought yet, profit is pending on expected_unit_cost.
  -- 'actual':   bought (or pulled from stock); expected_unit_cost is kept for variance.
  cost_status         text not null default 'expected',
  expected_unit_cost  numeric(12,2),
  unit_cost           numeric(12,2),
  stock_item_id       uuid references public.stock_items (id) on delete set null,
  supplier            text,
  sourced_at          date,
  created_at          timestamptz not null default now(),

  constraint deal_items_description_not_blank       check (btrim(description) <> ''),
  constraint deal_items_qty_positive                check (qty > 0),
  constraint deal_items_unit_price_nonneg           check (unit_price >= 0),
  constraint deal_items_cost_status_valid           check (cost_status in ('expected', 'actual')),
  constraint deal_items_expected_unit_cost_nonneg   check (expected_unit_cost >= 0),
  constraint deal_items_unit_cost_nonneg            check (unit_cost >= 0),
  constraint deal_items_actual_needs_unit_cost      check (cost_status <> 'actual' or unit_cost is not null),
  constraint deal_items_expected_needs_expected_cost
                                                    check (cost_status <> 'expected' or expected_unit_cost is not null)
);

comment on table public.deal_items is
  'Desk: items on a deal. cost_status expected -> pending profit; actual -> realisable, variance vs expected.';


-- ---------------------------------------------------------------------------------------------
-- deal_costs: non-goods costs on a deal (postage, fees, packaging, ...)
-- ---------------------------------------------------------------------------------------------

create table if not exists public.deal_costs (
  id           uuid primary key default gen_random_uuid(),
  owner        uuid not null default auth.uid()
                 references auth.users (id) on delete cascade,
  deal_id      uuid not null references public.deals (id) on delete cascade,
  label        text not null,
  kind         text not null default 'other',
  amount       numeric(12,2) not null,
  is_expected  boolean not null default false,
  created_at   timestamptz not null default now(),

  constraint deal_costs_label_not_blank  check (btrim(label) <> ''),
  constraint deal_costs_kind_valid       check (kind in ('shipping', 'fees', 'packaging', 'other')),
  constraint deal_costs_amount_nonneg    check (amount >= 0)
);

comment on table public.deal_costs is 'Desk: extra (non-goods) costs on a deal; is_expected marks estimates.';


-- ---------------------------------------------------------------------------------------------
-- payments: money received against a deal (negative = refund)
-- ---------------------------------------------------------------------------------------------

create table if not exists public.payments (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null default auth.uid()
                references auth.users (id) on delete cascade,
  deal_id     uuid not null references public.deals (id) on delete cascade,
  amount      numeric(12,2) not null,
  method      text not null default 'bank',
  paid_at     date not null default (now() at time zone 'Europe/London')::date,
  note        text,
  created_at  timestamptz not null default now(),

  constraint payments_amount_nonzero  check (amount <> 0),
  constraint payments_method_valid    check (method in ('cash', 'bank', 'card', 'other'))
);

comment on table public.payments is 'Desk: payments received per deal. Negative amounts are refunds.';


-- ---------------------------------------------------------------------------------------------
-- trips: a drive, optionally tied to a deal and/or client. Inputs only; totals come from calc.js.
-- ---------------------------------------------------------------------------------------------

create table if not exists public.trips (
  id                     uuid primary key default gen_random_uuid(),
  owner                  uuid not null default auth.uid()
                           references auth.users (id) on delete cascade,
  deal_id                uuid references public.deals (id) on delete set null,
  client_id              uuid references public.clients (id) on delete set null,
  trip_date              date not null default (now() at time zone 'Europe/London')::date,
  label                  text,
  origin_label           text,
  origin_address         text,
  origin_lat             double precision,
  origin_lng             double precision,
  dest_label             text,
  dest_address           text,
  dest_lat               double precision,
  dest_lng               double precision,
  one_way_miles          numeric(8,2) not null,
  one_way_minutes        numeric(8,1) not null,
  round_trip             boolean not null default true,
  extra_minutes          integer not null default 0,
  mpg                    numeric(5,1) not null,
  fuel_type              text,
  fuel_ppl               numeric(6,1) not null,
  -- e.g. 'Median of 14 stations within 5 mi · 05 Oct 10:59' or 'manual'
  fuel_source            text,
  hourly_rate            numeric(8,2) not null default 0,
  vehicle_cost_per_mile  numeric(6,3) not null default 0,
  other_costs            numeric(10,2) not null default 0,
  other_costs_note       text,
  -- 'osrm' | 'google' | 'manual'
  route_provider         text,
  -- [[lat, lng], ...] one way, downsampled to <= 400 points by api/_lib/geo.js
  route_geometry         jsonb,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  constraint trips_one_way_miles_nonneg    check (one_way_miles >= 0),
  constraint trips_one_way_minutes_nonneg  check (one_way_minutes >= 0),
  constraint trips_extra_minutes_nonneg    check (extra_minutes >= 0),
  constraint trips_mpg_positive            check (mpg > 0),
  constraint trips_fuel_ppl_positive       check (fuel_ppl > 0),
  constraint trips_fuel_type_valid         check (fuel_type in ('E10', 'E5', 'B7', 'SDV')),
  constraint trips_hourly_rate_nonneg      check (hourly_rate >= 0),
  constraint trips_wear_nonneg             check (vehicle_cost_per_mile >= 0),
  constraint trips_other_costs_nonneg      check (other_costs >= 0),
  constraint trips_origin_lat_range        check (origin_lat between -90 and 90),
  constraint trips_origin_lng_range        check (origin_lng between -180 and 180),
  constraint trips_dest_lat_range          check (dest_lat between -90 and 90),
  constraint trips_dest_lng_range          check (dest_lng between -180 and 180),
  constraint trips_origin_coords_pair      check ((origin_lat is null) = (origin_lng is null)),
  constraint trips_dest_coords_pair        check ((dest_lat is null) = (dest_lng is null)),
  -- Must be a JSON array. The size cap is a storage guard set well above the 400-point
  -- downsample so the API's exact point count never matters here. CASE keeps
  -- jsonb_array_length from ever seeing a non-array.
  constraint trips_route_geometry_shape    check (
    route_geometry is null
    or case when jsonb_typeof(route_geometry) = 'array'
            then jsonb_array_length(route_geometry) <= 2000
            else false
       end
  )
);

comment on table public.trips is
  'Desk: drives (route, time, fuel inputs). Fuel cost, time cost and profit per hour are derived in calc.js.';


-- ---------------------------------------------------------------------------------------------
-- Indexes: every owner column and every foreign key (desk_settings.owner is its primary key;
-- deals.owner is covered by the leading column of unique (owner, number)).
-- ---------------------------------------------------------------------------------------------

create index if not exists clients_owner_name_idx       on public.clients (owner, name);
create index if not exists stock_items_owner_idx        on public.stock_items (owner);
create index if not exists deals_owner_sale_date_idx    on public.deals (owner, sale_date desc, number desc);
create index if not exists deals_client_id_idx          on public.deals (client_id);
create index if not exists deal_items_owner_idx         on public.deal_items (owner);
create index if not exists deal_items_deal_id_idx       on public.deal_items (deal_id, position);
create index if not exists deal_items_stock_item_id_idx on public.deal_items (stock_item_id);
create index if not exists deal_costs_owner_idx         on public.deal_costs (owner);
create index if not exists deal_costs_deal_id_idx       on public.deal_costs (deal_id);
create index if not exists payments_owner_idx           on public.payments (owner);
create index if not exists payments_deal_id_idx         on public.payments (deal_id);
create index if not exists trips_owner_trip_date_idx    on public.trips (owner, trip_date desc);
create index if not exists trips_deal_id_idx            on public.trips (deal_id);
create index if not exists trips_client_id_idx          on public.trips (client_id);


-- ---------------------------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------------------------

create or replace trigger desk_settings_set_updated_at
  before update on public.desk_settings
  for each row execute function public.desk_set_updated_at();

create or replace trigger clients_set_updated_at
  before update on public.clients
  for each row execute function public.desk_set_updated_at();

create or replace trigger stock_items_set_updated_at
  before update on public.stock_items
  for each row execute function public.desk_set_updated_at();

create or replace trigger deals_set_updated_at
  before update on public.deals
  for each row execute function public.desk_set_updated_at();

create or replace trigger trips_set_updated_at
  before update on public.trips
  for each row execute function public.desk_set_updated_at();

create or replace trigger deals_assign_number
  before insert on public.deals
  for each row execute function public.desk_assign_deal_number();


-- ---------------------------------------------------------------------------------------------
-- Privileges. Supabase's default privileges grant ALL (including TRUNCATE, which ignores RLS)
-- to anon and authenticated on new public tables, so start from nothing and grant back only
-- what the app uses. anon gets no access; service_role (server side, bypasses RLS) keeps all.
-- ---------------------------------------------------------------------------------------------

revoke all on table
  public.desk_settings, public.clients, public.stock_items, public.deals,
  public.deal_items, public.deal_costs, public.payments, public.trips
from public, anon, authenticated;

grant select, insert, update, delete on table
  public.desk_settings, public.clients, public.stock_items, public.deals,
  public.deal_items, public.deal_costs, public.payments, public.trips
to authenticated;

grant all on table
  public.desk_settings, public.clients, public.stock_items, public.deals,
  public.deal_items, public.deal_costs, public.payments, public.trips
to service_role;


-- ---------------------------------------------------------------------------------------------
-- Row level security
--
-- One policy per command for role authenticated. `(select auth.uid())` is evaluated once per
-- statement rather than once per row. INSERT/UPDATE checks on child tables also prove that
-- each referenced parent belongs to the caller: foreign keys alone are checked with the table
-- owner's rights and would accept another user's deal/client/stock id.
-- ---------------------------------------------------------------------------------------------

alter table public.desk_settings enable row level security;
alter table public.clients       enable row level security;
alter table public.stock_items   enable row level security;
alter table public.deals         enable row level security;
alter table public.deal_items    enable row level security;
alter table public.deal_costs    enable row level security;
alter table public.payments      enable row level security;
alter table public.trips         enable row level security;

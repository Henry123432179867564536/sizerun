-- Sizemill Desk: row level security policies for desk_settings, clients and stock_items.
-- One policy per command for role authenticated; child writes must also point at the caller's parents.

-- desk_settings ------------------------------------------------------------------------------
create policy desk_settings_select_own on public.desk_settings
  for select to authenticated
  using (owner = (select auth.uid()));

create policy desk_settings_insert_own on public.desk_settings
  for insert to authenticated
  with check (owner = (select auth.uid()));

create policy desk_settings_update_own on public.desk_settings
  for update to authenticated
  using (owner = (select auth.uid()))
  with check (owner = (select auth.uid()));

create policy desk_settings_delete_own on public.desk_settings
  for delete to authenticated
  using (owner = (select auth.uid()));

-- clients ------------------------------------------------------------------------------------
create policy clients_select_own on public.clients
  for select to authenticated
  using (owner = (select auth.uid()));

create policy clients_insert_own on public.clients
  for insert to authenticated
  with check (owner = (select auth.uid()));

create policy clients_update_own on public.clients
  for update to authenticated
  using (owner = (select auth.uid()))
  with check (owner = (select auth.uid()));

create policy clients_delete_own on public.clients
  for delete to authenticated
  using (owner = (select auth.uid()));

-- stock_items --------------------------------------------------------------------------------
create policy stock_items_select_own on public.stock_items
  for select to authenticated
  using (owner = (select auth.uid()));

create policy stock_items_insert_own on public.stock_items
  for insert to authenticated
  with check (owner = (select auth.uid()));

create policy stock_items_update_own on public.stock_items
  for update to authenticated
  using (owner = (select auth.uid()))
  with check (owner = (select auth.uid()));

create policy stock_items_delete_own on public.stock_items
  for delete to authenticated
  using (owner = (select auth.uid()));

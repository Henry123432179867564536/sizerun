-- Sizemill Desk: row level security policies for deal_costs, payments and trips.
-- One policy per command for role authenticated; child writes must also point at the caller's parents.

-- deal_costs (deal_id must be the caller's) --------------------------------------------------
create policy deal_costs_select_own on public.deal_costs
  for select to authenticated
  using (owner = (select auth.uid()));

create policy deal_costs_insert_own on public.deal_costs
  for insert to authenticated
  with check (
    owner = (select auth.uid())
    and exists (
      select 1 from public.deals as d
      where d.id = deal_costs.deal_id and d.owner = (select auth.uid())
    )
  );

create policy deal_costs_update_own on public.deal_costs
  for update to authenticated
  using (owner = (select auth.uid()))
  with check (
    owner = (select auth.uid())
    and exists (
      select 1 from public.deals as d
      where d.id = deal_costs.deal_id and d.owner = (select auth.uid())
    )
  );

create policy deal_costs_delete_own on public.deal_costs
  for delete to authenticated
  using (owner = (select auth.uid()));

-- payments (deal_id must be the caller's) ----------------------------------------------------
create policy payments_select_own on public.payments
  for select to authenticated
  using (owner = (select auth.uid()));

create policy payments_insert_own on public.payments
  for insert to authenticated
  with check (
    owner = (select auth.uid())
    and exists (
      select 1 from public.deals as d
      where d.id = payments.deal_id and d.owner = (select auth.uid())
    )
  );

create policy payments_update_own on public.payments
  for update to authenticated
  using (owner = (select auth.uid()))
  with check (
    owner = (select auth.uid())
    and exists (
      select 1 from public.deals as d
      where d.id = payments.deal_id and d.owner = (select auth.uid())
    )
  );

create policy payments_delete_own on public.payments
  for delete to authenticated
  using (owner = (select auth.uid()));

-- trips (deal_id and client_id, when set, must be the caller's) ------------------------------
create policy trips_select_own on public.trips
  for select to authenticated
  using (owner = (select auth.uid()));

create policy trips_insert_own on public.trips
  for insert to authenticated
  with check (
    owner = (select auth.uid())
    and (
      trips.deal_id is null
      or exists (
        select 1 from public.deals as d
        where d.id = trips.deal_id and d.owner = (select auth.uid())
      )
    )
    and (
      trips.client_id is null
      or exists (
        select 1 from public.clients as c
        where c.id = trips.client_id and c.owner = (select auth.uid())
      )
    )
  );

create policy trips_update_own on public.trips
  for update to authenticated
  using (owner = (select auth.uid()))
  with check (
    owner = (select auth.uid())
    and (
      trips.deal_id is null
      or exists (
        select 1 from public.deals as d
        where d.id = trips.deal_id and d.owner = (select auth.uid())
      )
    )
    and (
      trips.client_id is null
      or exists (
        select 1 from public.clients as c
        where c.id = trips.client_id and c.owner = (select auth.uid())
      )
    )
  );

create policy trips_delete_own on public.trips
  for delete to authenticated
  using (owner = (select auth.uid()));

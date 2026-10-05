-- Sizemill Desk: row level security policies for deals and deal_items.
-- One policy per command for role authenticated; child writes must also point at the caller's parents.

-- deals (client_id must be the caller's client) ----------------------------------------------
create policy deals_select_own on public.deals
  for select to authenticated
  using (owner = (select auth.uid()));

create policy deals_insert_own on public.deals
  for insert to authenticated
  with check (
    owner = (select auth.uid())
    and (
      deals.client_id is null
      or exists (
        select 1 from public.clients as c
        where c.id = deals.client_id and c.owner = (select auth.uid())
      )
    )
  );

create policy deals_update_own on public.deals
  for update to authenticated
  using (owner = (select auth.uid()))
  with check (
    owner = (select auth.uid())
    and (
      deals.client_id is null
      or exists (
        select 1 from public.clients as c
        where c.id = deals.client_id and c.owner = (select auth.uid())
      )
    )
  );

create policy deals_delete_own on public.deals
  for delete to authenticated
  using (owner = (select auth.uid()));

-- deal_items (deal_id and stock_item_id must be the caller's) --------------------------------
create policy deal_items_select_own on public.deal_items
  for select to authenticated
  using (owner = (select auth.uid()));

create policy deal_items_insert_own on public.deal_items
  for insert to authenticated
  with check (
    owner = (select auth.uid())
    and exists (
      select 1 from public.deals as d
      where d.id = deal_items.deal_id and d.owner = (select auth.uid())
    )
    and (
      deal_items.stock_item_id is null
      or exists (
        select 1 from public.stock_items as s
        where s.id = deal_items.stock_item_id and s.owner = (select auth.uid())
      )
    )
  );

create policy deal_items_update_own on public.deal_items
  for update to authenticated
  using (owner = (select auth.uid()))
  with check (
    owner = (select auth.uid())
    and exists (
      select 1 from public.deals as d
      where d.id = deal_items.deal_id and d.owner = (select auth.uid())
    )
    and (
      deal_items.stock_item_id is null
      or exists (
        select 1 from public.stock_items as s
        where s.id = deal_items.stock_item_id and s.owner = (select auth.uid())
      )
    )
  );

create policy deal_items_delete_own on public.deal_items
  for delete to authenticated
  using (owner = (select auth.uid()));

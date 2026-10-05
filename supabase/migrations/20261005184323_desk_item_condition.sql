-- Desk: item condition on sale lines (New / VNDS / Good / Worn out); stock uses the same set.
-- deal_items.condition is nullable (lines saved before this change have none).
alter table public.deal_items add column if not exists condition text;
alter table public.deal_items add constraint deal_items_condition_valid
  check (condition is null or condition in ('new', 'vnds', 'good', 'worn'));
-- stock_items had no rows when this ran, so 'used' needed no mapping.
alter table public.stock_items drop constraint stock_items_condition_valid;
alter table public.stock_items add constraint stock_items_condition_valid
  check (condition in ('new', 'vnds', 'good', 'worn'));

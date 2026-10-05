-- The original app's trigger functions only ever need to run as triggers (Postgres does not
-- check EXECUTE when a trigger fires), so nobody may call them through the API. snapshot_book
-- is SECURITY DEFINER and was callable by anon via /rest/v1/rpc. Both get a pinned search_path;
-- every table they touch is already schema-qualified.
revoke execute on function public.snapshot_book() from public, anon, authenticated;
revoke execute on function public.set_updated_at() from public, anon, authenticated;
alter function public.set_updated_at() set search_path = '';
alter function public.snapshot_book() set search_path = '';

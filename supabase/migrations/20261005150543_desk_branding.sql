-- =============================================================================================
-- Sizemill Desk: business branding (logo + brand colour) per owner.
--
-- desk_settings gains logo_url (public URL of the owner's logo in the `brand` bucket, or a
-- data: URL in local mode) and brand_color (#RRGGBB accent used in the shell and receipts).
--
-- Storage bucket `brand` is public-read so logos render with a plain <img> on receipts and
-- in the app without signed URLs; logos are not secret. Writes are limited to the caller's own
-- folder: objects must be named `<auth.uid()>/<file>`. Only raster images up to 1 MB (SVG is
-- excluded because it can carry script when opened directly).
-- =============================================================================================

alter table public.desk_settings
  add column if not exists logo_url    text,
  add column if not exists brand_color text;

alter table public.desk_settings
  drop constraint if exists desk_settings_brand_color_hex;
alter table public.desk_settings
  add constraint desk_settings_brand_color_hex check (brand_color is null or brand_color ~ '^#[0-9A-Fa-f]{6}$');

alter table public.desk_settings
  drop constraint if exists desk_settings_logo_url_length;
alter table public.desk_settings
  add constraint desk_settings_logo_url_length check (logo_url is null or length(logo_url) <= 2048);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('brand', 'brand', true, 1048576, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists brand_insert_own on storage.objects;
create policy brand_insert_own on storage.objects
  for insert to authenticated
  with check (bucket_id = 'brand' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists brand_update_own on storage.objects;
create policy brand_update_own on storage.objects
  for update to authenticated
  using (bucket_id = 'brand' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'brand' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists brand_delete_own on storage.objects;
create policy brand_delete_own on storage.objects
  for delete to authenticated
  using (bucket_id = 'brand' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- Listing/reading through the API is limited to the owner's folder; public URLs still work
-- because the bucket is public (served without RLS by the public object endpoint).
drop policy if exists brand_select_own on storage.objects;
create policy brand_select_own on storage.objects
  for select to authenticated
  using (bucket_id = 'brand' and (storage.foldername(name))[1] = (select auth.uid())::text);

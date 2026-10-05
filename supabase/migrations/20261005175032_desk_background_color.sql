-- Desk: per-owner page background colour (#RRGGBB) beside brand_color; null = Desk default.
alter table public.desk_settings add column if not exists background_color text;
alter table public.desk_settings add constraint desk_settings_background_color_hex
  check (background_color is null or background_color ~ '^#[0-9A-Fa-f]{6}$');

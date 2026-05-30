-- Appearance / theme preferences (Settings → Appearance).
-- Stores the user's chosen theme as { palette, corners, type, cards }.
-- Defaults to '{}' so existing rows and new users fall back to the app's
-- default theme (paper / xs / geometric / solid) on the client.
alter table public.user_settings
  add column if not exists appearance jsonb not null default '{}'::jsonb;

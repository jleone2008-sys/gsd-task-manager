-- Phase 1.6 — Per-user location for the daily-brief weather line. User enters
-- a city in beta Settings; beta-set-location.js geocodes via Open-Meteo and
-- writes lat/lng/label back here. beta-daily-brief.js then includes today's
-- forecast (temp + condition) in the brief context.
--
-- Phase 9 will add a dedicated weather_daily table + nightly snapshot cron.
-- Until then the brief function fetches inline per generation — fine for 1-2
-- users.
alter table public.user_profiles
  add column if not exists city          text,
  add column if not exists weather_lat   numeric,
  add column if not exists weather_lng   numeric,
  add column if not exists weather_label text;   -- display string from geocoder, e.g. "Birmingham, Michigan, US"

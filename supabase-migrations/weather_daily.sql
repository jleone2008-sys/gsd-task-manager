-- Phase 9.1 — weather_daily.
--
-- Persistent daily weather snapshot per user. Previously the daily brief
-- fetched Open-Meteo live every time it ran, which meant (a) the
-- function paid a network call on every regeneration, and (b) historical
-- weather was discarded — making it impossible for the weekly synthesis
-- and Phase 10 intervention loop to correlate metrics with weather.
--
-- One row per (user_id, date). cron-weather-snapshot writes the row at
-- 05:00 user-local; beta-daily-brief reads from here first and falls
-- back to a live Open-Meteo fetch on cache miss (with opportunistic
-- write-through so the row exists for any later look-up).
--
-- temperature stored in °F to match the brief's existing display.
-- daylight_min is sunset−sunrise in minutes (precomputed so the brief
-- + synthesis tools don't repeat the math). Both sunrise/sunset are
-- stored in user-local time as ISO strings to keep the tz boundary
-- explicit and avoid round-trip ambiguity.

create table if not exists public.weather_daily (
  id              uuid        primary key default gen_random_uuid(),
  user_id         uuid        not null references auth.users(id) on delete cascade,
  date            date        not null,
  location_label  text,                     -- 'Pelham', 'New York', etc.
  temp_min_f      numeric(5,2),
  temp_max_f      numeric(5,2),
  condition       text,                     -- 'Cloudy', 'Light rain', etc.
  condition_emoji text,                     -- ☁ 🌧 ☀ — single grapheme
  sunrise_local   text,                     -- ISO local time, e.g. '2026-05-27T05:32'
  sunset_local    text,
  daylight_min    integer,                  -- sunset − sunrise in minutes
  weather_code    integer,                  -- Open-Meteo WMO code (raw)
  fetched_at      timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (user_id, date)
);

create index if not exists weather_daily_user_date
  on public.weather_daily(user_id, date desc);

-- Touch updated_at on UPSERT so we can tell when the cron last refreshed.
create or replace function public._touch_weather_daily_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists weather_daily_touch_updated_at on public.weather_daily;
create trigger weather_daily_touch_updated_at
  before update on public.weather_daily
  for each row execute function public._touch_weather_daily_updated_at();

alter table public.weather_daily enable row level security;

drop policy if exists "weather_daily own select" on public.weather_daily;
create policy "weather_daily own select" on public.weather_daily
  for select using (user_id = auth.uid());

-- INSERT/UPDATE happen via the service role from cron-weather-snapshot +
-- beta-daily-brief; client never writes directly. Keep policies in place
-- so the table behaves consistently if a client ever does need to write.
drop policy if exists "weather_daily own insert" on public.weather_daily;
create policy "weather_daily own insert" on public.weather_daily
  for insert with check (user_id = auth.uid());

drop policy if exists "weather_daily own update" on public.weather_daily;
create policy "weather_daily own update" on public.weather_daily
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "weather_daily own delete" on public.weather_daily;
create policy "weather_daily own delete" on public.weather_daily
  for delete using (user_id = auth.uid());

comment on table public.weather_daily is
  'Phase 9 — persistent daily weather snapshot per user. Populated by '
  'cron-weather-snapshot daily at 05:00 user-local; beta-daily-brief '
  'reads from here with live-fetch fallback. Powers weather-vs-metric '
  'correlations in weekly synthesis + Phase 10 intervention evaluation.';

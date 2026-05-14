-- Whoop + Oura OAuth integrations for /beta plus the nightly sync target tables.
-- Tokens follow the Dropbox pattern: AES-256-GCM-encrypted refresh token in
-- user_profiles, keyed by email. Daily metric tables are written by the
-- cron-health-sync function using the service key (no per-user RLS needed —
-- the table is service-only on writes, and reads from the client go through
-- our own functions, not PostgREST).

-- ── Refresh tokens on user_profiles ──────────────────────────────────────
alter table public.user_profiles
  add column if not exists whoop_refresh_token_enc text,
  add column if not exists whoop_account_email     text,
  add column if not exists whoop_user_id           text,
  add column if not exists oura_refresh_token_enc  text,
  add column if not exists oura_account_email      text;

-- ── Daily Whoop metrics (one row per user per UTC date) ──────────────────
create table if not exists public.whoop_daily (
  user_email                text not null,
  date                      date not null,
  cycle_id                  text,
  recovery_score            int,
  hrv_ms                    numeric,
  resting_hr                int,
  spo2_percent              numeric,
  skin_temp_c               numeric,
  strain                    numeric,
  sleep_duration_min        int,
  sleep_performance         int,
  sleep_efficiency          int,
  sleep_consistency         int,
  sleep_respiratory_rate    numeric,
  raw                       jsonb,
  updated_at                timestamptz default now(),
  primary key (user_email, date)
);

create index if not exists whoop_daily_user_idx on public.whoop_daily(user_email, date desc);

-- ── Daily Oura metrics ───────────────────────────────────────────────────
create table if not exists public.oura_daily (
  user_email                text not null,
  date                      date not null,
  readiness_score           int,
  sleep_score               int,
  activity_score            int,
  total_sleep_min           int,
  rem_sleep_min             int,
  deep_sleep_min            int,
  hrv_ms                    numeric,
  resting_hr                int,
  body_temp_deviation_c     numeric,
  spo2_percent              numeric,
  steps                     int,
  active_calories           int,
  total_calories            int,
  raw                       jsonb,
  updated_at                timestamptz default now(),
  primary key (user_email, date)
);

create index if not exists oura_daily_user_idx on public.oura_daily(user_email, date desc);

-- ── Sync run audit log ───────────────────────────────────────────────────
create table if not exists public.health_sync_log (
  id            bigserial primary key,
  user_email    text not null,
  provider      text not null check (provider in ('whoop','oura')),
  ran_at        timestamptz default now(),
  success       boolean not null,
  error         text,
  rows_upserted int default 0,
  window_start  date,
  window_end    date
);

create index if not exists health_sync_log_recent_idx on public.health_sync_log(ran_at desc);
create index if not exists health_sync_log_user_idx   on public.health_sync_log(user_email, ran_at desc);

-- ── RLS ──────────────────────────────────────────────────────────────────
-- whoop_daily / oura_daily / health_sync_log are written by the sync function
-- using the service key, which bypasses RLS. Reads from clients go through
-- our own Netlify functions (also service-key). Enable RLS with NO policies
-- so anon/authed clients can't query directly via PostgREST.
alter table public.whoop_daily      enable row level security;
alter table public.oura_daily       enable row level security;
alter table public.health_sync_log  enable row level security;

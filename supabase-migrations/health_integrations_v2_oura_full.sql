-- Follow-up to health_integrations.sql: expand Oura coverage to ~every V2
-- endpoint Oura exposes for personal-tier apps. Strategy:
--
--   oura_daily  → widen with new daily summary fields (SpO2, stress, resilience,
--                 cardiovascular age, VO2max, daily totals)
--   oura_workouts        → one row per workout
--   oura_sessions        → one row per meditation/breathing/relaxation session
--   oura_tags            → one row per user-applied tag (enhanced tags)
--   oura_sleep_periods   → one row per detected sleep (main + naps), the full
--                          per-sleep detail. Replaces the "longest sleep per
--                          day" denormalization in oura_daily for any feature
--                          that needs nap-level granularity.
--   oura_heartrate       → 5-minute interval HR samples. Yesterday-only on
--                          nightly sync to keep storage bounded.
--
-- All tables service-key-only (RLS enabled, no policies).

-- ── Widen oura_daily ─────────────────────────────────────────────────────
alter table public.oura_daily
  add column if not exists temperature_trend_deviation_c numeric,
  add column if not exists temperature_deviation_min_c   numeric,
  -- Stress (Oura's stress feature: high stress / recovery durations in seconds)
  add column if not exists stress_high_seconds       int,
  add column if not exists stress_recovery_seconds   int,
  add column if not exists stress_day_summary        text,  -- 'restored'|'normal'|'stressful' etc
  -- Resilience (long-term marker, updates infrequently)
  add column if not exists resilience_level          text,  -- 'limited'|'adequate'|'solid'|'strong'|'exceptional'
  -- Cardiovascular age (Oura's CV age estimate)
  add column if not exists cardiovascular_age        int,
  -- VO2 max (workout-derived)
  add column if not exists vo2_max                   numeric,
  -- Activity detail (richer than just score+steps)
  add column if not exists activity_total_seconds    int,
  add column if not exists high_activity_seconds     int,
  add column if not exists medium_activity_seconds   int,
  add column if not exists low_activity_seconds      int,
  add column if not exists non_wear_seconds          int,
  add column if not exists sedentary_seconds         int,
  add column if not exists target_calories           int,
  add column if not exists target_meters             int,
  add column if not exists equivalent_walking_distance_meters int,
  add column if not exists inactivity_alerts         int,
  add column if not exists met_average               numeric,  -- average MET across day
  -- Sleep detail (richer than just score)
  add column if not exists light_sleep_min           int,
  add column if not exists awake_min                 int,
  add column if not exists sleep_latency_min         int,
  add column if not exists sleep_midpoint_offset_min int,  -- offset from local midnight
  add column if not exists sleep_timing_score        int,
  add column if not exists sleep_efficiency_pct      numeric,
  add column if not exists sleep_restfulness_score   int,
  add column if not exists average_breathing_rate    numeric,
  add column if not exists lowest_hr                 int,
  add column if not exists average_hr                int,
  -- Readiness contributors (sub-scores 0-100)
  add column if not exists readiness_activity_balance       int,
  add column if not exists readiness_body_temperature       int,
  add column if not exists readiness_hrv_balance            int,
  add column if not exists readiness_previous_day_activity  int,
  add column if not exists readiness_previous_night         int,
  add column if not exists readiness_recovery_index         int,
  add column if not exists readiness_resting_hr             int,
  add column if not exists readiness_sleep_balance          int;

-- ── Sleep periods (every detected sleep, not just main) ──────────────────
create table if not exists public.oura_sleep_periods (
  user_email                 text not null,
  oura_id                    text not null,
  day                        date not null,
  type                       text,            -- 'long_sleep' | 'sleep' | 'late_nap' | 'rest'
  bedtime_start              timestamptz,
  bedtime_end                timestamptz,
  total_sleep_seconds        int,
  rem_sleep_seconds          int,
  deep_sleep_seconds         int,
  light_sleep_seconds        int,
  awake_seconds              int,
  latency_seconds            int,
  efficiency                 numeric,
  hrv_average                numeric,
  hr_average                 numeric,
  hr_lowest                  int,
  respiratory_rate           numeric,
  restless_periods           int,
  movement_30_sec            text,            -- compressed per-30s movement
  hypnogram_5min             text,            -- compressed per-5min stage map
  raw                        jsonb,
  updated_at                 timestamptz default now(),
  primary key (user_email, oura_id)
);
create index if not exists oura_sleep_periods_day_idx on public.oura_sleep_periods(user_email, day desc);

-- ── Workouts ─────────────────────────────────────────────────────────────
create table if not exists public.oura_workouts (
  user_email     text not null,
  oura_id        text not null,
  day            date not null,
  activity       text,
  source         text,             -- 'manual' | 'autodetected' | 'confirmed'
  start_time     timestamptz,
  end_time       timestamptz,
  duration_min   int,
  intensity      text,             -- 'easy' | 'moderate' | 'hard'
  load           numeric,
  average_hr     int,
  max_hr         int,
  calories       int,
  distance_m     numeric,
  label          text,
  raw            jsonb,
  updated_at     timestamptz default now(),
  primary key (user_email, oura_id)
);
create index if not exists oura_workouts_day_idx on public.oura_workouts(user_email, day desc);

-- ── Sessions (meditation, breathing, relax, body status) ─────────────────
create table if not exists public.oura_sessions (
  user_email    text not null,
  oura_id       text not null,
  day           date not null,
  type          text,             -- 'meditation' | 'breathing' | 'relaxation' | 'rest' | 'body_status'
  mood          text,
  start_time    timestamptz,
  end_time      timestamptz,
  duration_min  int,
  raw           jsonb,
  updated_at    timestamptz default now(),
  primary key (user_email, oura_id)
);
create index if not exists oura_sessions_day_idx on public.oura_sessions(user_email, day desc);

-- ── Tags (enhanced tags) ─────────────────────────────────────────────────
create table if not exists public.oura_tags (
  user_email     text not null,
  oura_id        text not null,
  start_day      date not null,
  end_day        date,
  tag_type_code  text,             -- internal Oura code, e.g. 'caffeine', 'alcohol'
  custom_name    text,             -- when user creates a custom tag
  start_time     timestamptz,
  end_time       timestamptz,
  comment        text,
  raw            jsonb,
  updated_at     timestamptz default now(),
  primary key (user_email, oura_id)
);
create index if not exists oura_tags_day_idx on public.oura_tags(user_email, start_day desc);

-- ── Heart rate samples (5-min interval) ──────────────────────────────────
-- Yesterday only on nightly sync; backfill window 1 day so we don't blow up
-- storage. Schema supports back-pulling more later if a feature wants it.
create table if not exists public.oura_heartrate (
  user_email  text not null,
  ts          timestamptz not null,
  bpm         int,
  source      text,                 -- 'awake' | 'asleep' | 'rest' | 'workout' | 'live'
  raw         jsonb,
  primary key (user_email, ts)
);
create index if not exists oura_heartrate_user_idx on public.oura_heartrate(user_email, ts desc);

-- ── Ring configuration (rarely changes — one row per ring per user) ──────
create table if not exists public.oura_ring_config (
  user_email      text not null,
  oura_id         text not null,
  ring_color      text,
  ring_design     text,
  ring_hardware   text,             -- 'gen1' | 'gen2' | 'gen3' | 'gen4'
  firmware        text,
  size            int,
  set_up_at       timestamptz,
  raw             jsonb,
  updated_at      timestamptz default now(),
  primary key (user_email, oura_id)
);

-- ── RLS lockdown ─────────────────────────────────────────────────────────
alter table public.oura_sleep_periods enable row level security;
alter table public.oura_workouts      enable row level security;
alter table public.oura_sessions      enable row level security;
alter table public.oura_tags          enable row level security;
alter table public.oura_heartrate     enable row level security;
alter table public.oura_ring_config   enable row level security;

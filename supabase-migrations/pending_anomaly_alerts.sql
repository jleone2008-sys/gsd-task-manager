-- Phase 7 — pending_anomaly_alerts.
--
-- When today's recovery / sleep / activity / HRV deviates >2σ from
-- the user's 30-day baseline, a SQL trigger on oura_daily writes a
-- row here. The next daily brief reads pending alerts and leads
-- with them in the subhead / pills so the user sees the anomaly
-- before scrolling.
--
-- No push notifications — the surface is the brief.
--
-- Columns:
--   detected_at       = wall-clock timestamp of the trigger fire
--   for_date          = the oura_daily.date that triggered (LAST night's
--                       sleep, YESTERDAY's activity, etc.)
--   metric            = 'sleep_score' | 'readiness_score' | 'activity_score'
--                       | 'hrv_ms' | 'resting_hr'
--   value             = the anomalous value
--   baseline_value    = the 30-day median (for delta framing)
--   z_score           = how many σ from baseline. Sign matters for
--                       framing (negative = below baseline, positive
--                       = above).
--   direction         = 'below' | 'above' (denormalized from z_score sign
--                       for fast filtering — sleep "above" baseline is
--                       a good thing; HRV "below" is the concern)
--   consumed_at       = null until the daily brief reads + acks
--                       this alert. Once set, alert is hidden from
--                       future briefs.
--   consumed_by       = brief.id that consumed it

create table if not exists public.pending_anomaly_alerts (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  detected_at     timestamptz not null default now(),
  for_date        date not null,
  metric          text not null,
  value           numeric,
  baseline_value  numeric,
  z_score         numeric,
  direction       text check (direction in ('below','above')),
  consumed_at     timestamptz,
  consumed_by     uuid
);

create index if not exists anomaly_alerts_user_pending
  on public.pending_anomaly_alerts(user_id, detected_at desc)
  where consumed_at is null;

create index if not exists anomaly_alerts_user_metric
  on public.pending_anomaly_alerts(user_id, metric, for_date desc);

alter table public.pending_anomaly_alerts enable row level security;
drop policy if exists "anomaly_alerts own" on public.pending_anomaly_alerts;
create policy "anomaly_alerts own" on public.pending_anomaly_alerts for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

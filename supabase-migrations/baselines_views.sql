-- Phase 0.3 — Per-user rolling baselines for the daily brief synthesis layer.
--
-- Three materialized views, refreshed nightly via pg_cron at 04:30 UTC
-- (after the 04:00 UTC cron-health-sync completes):
--
--   v_user_baselines_30d    rolling 30-day medians + p25/p75 for Oura metrics,
--                           mood, completed task velocity, habit adherence.
--                           The brief prompt uses these as the "norm" anchor
--                           so Claude can phrase claims as "vs your norm of X"
--                           instead of in absolute terms.
--
--   v_user_baselines_7d     same shape, 7-day window. Used for week-over-week
--                           delta phrasing on the brief.
--
--   v_user_event_rates_30d  per-user, per-tag_type_code event counts from
--                           oura_tags (caffeine, alcohol, late_meal, etc).
--                           Long-form for flexibility with new tag types.
--
-- user_id / email bridge: oura_daily and oura_tags key on user_email; tasks,
-- journal_entries, journal_habit_summary key on auth.users.id (uuid). We use
-- user_profiles.supabase_user_id ↔ user_profiles.email as the bridge in
-- every view so all rows are keyed on user_id (canonical auth identifier).
--
-- Access model: service-key only (REVOKE all from anon/authenticated). Reads
-- happen inside Netlify functions; we don't expose baselines to PostgREST
-- since these reflect aggregate user history.
--
-- Refresh is CONCURRENTLY (requires unique indexes; defined below) so the
-- nightly refresh never blocks reads.

-- ── Enable pg_cron ───────────────────────────────────────────────────────
-- Supabase: requires the extension to be enabled in the Dashboard once
-- (Database → Extensions → pg_cron → toggle on). After that this is a no-op
-- on subsequent migration re-runs.
create extension if not exists pg_cron;

-- ── 30-day rolling baselines ─────────────────────────────────────────────
drop materialized view if exists public.v_user_baselines_30d;

create materialized view public.v_user_baselines_30d as
with profile as (
  select supabase_user_id as user_id, email
  from public.user_profiles
  where supabase_user_id is not null
),
oura_agg as (
  select
    p.user_id,
    count(distinct o.date) filter (where o.sleep_score     is not null) as n_days_sleep,
    count(distinct o.date) filter (where o.readiness_score is not null) as n_days_readiness,
    count(distinct o.date) filter (where o.activity_score  is not null) as n_days_activity,
    percentile_cont(0.5)  within group (order by o.sleep_score)         as sleep_score_median,
    percentile_cont(0.25) within group (order by o.sleep_score)         as sleep_score_p25,
    percentile_cont(0.75) within group (order by o.sleep_score)         as sleep_score_p75,
    percentile_cont(0.5)  within group (order by o.readiness_score)     as readiness_score_median,
    percentile_cont(0.25) within group (order by o.readiness_score)     as readiness_score_p25,
    percentile_cont(0.75) within group (order by o.readiness_score)     as readiness_score_p75,
    percentile_cont(0.5)  within group (order by o.activity_score)      as activity_score_median,
    percentile_cont(0.25) within group (order by o.activity_score)      as activity_score_p25,
    percentile_cont(0.75) within group (order by o.activity_score)      as activity_score_p75,
    percentile_cont(0.5)  within group (order by o.total_sleep_min)     as total_sleep_min_median,
    percentile_cont(0.25) within group (order by o.total_sleep_min)     as total_sleep_min_p25,
    percentile_cont(0.75) within group (order by o.total_sleep_min)     as total_sleep_min_p75,
    percentile_cont(0.5)  within group (order by o.hrv_ms)              as hrv_ms_median,
    percentile_cont(0.25) within group (order by o.hrv_ms)              as hrv_ms_p25,
    percentile_cont(0.75) within group (order by o.hrv_ms)              as hrv_ms_p75,
    percentile_cont(0.5)  within group (order by o.resting_hr)          as resting_hr_median,
    percentile_cont(0.25) within group (order by o.resting_hr)          as resting_hr_p25,
    percentile_cont(0.75) within group (order by o.resting_hr)          as resting_hr_p75
  from profile p
  left join public.oura_daily o
    on o.user_email = p.email
   and o.date >= (current_date - interval '30 days')
   and o.date <  current_date
  group by p.user_id
),
journal_agg as (
  select
    p.user_id,
    count(distinct j.entry_date) filter (where j.mood is not null)                  as n_days_mood,
    percentile_cont(0.5)  within group (order by j.mood::numeric)                   as mood_median,
    percentile_cont(0.25) within group (order by j.mood::numeric)                   as mood_p25,
    percentile_cont(0.75) within group (order by j.mood::numeric)                   as mood_p75
  from profile p
  left join public.journal_entries j
    on j.user_id = p.user_id
   and j.entry_date >= (current_date - interval '30 days')
   and j.entry_date <  current_date
   and j.mood is not null
  group by p.user_id
),
-- Per-day completed task counts (only days with activity contribute) — avoids
-- penalizing weekends or off days. Median is "on a day you complete tasks, how
-- many do you typically complete."
task_per_day as (
  select
    t.user_id,
    (to_timestamp(t.completed_at::bigint / 1000.0) at time zone 'UTC')::date as day,
    count(*) as daily_count
  from public.tasks t
  where t.done = true
    and t.completed_at is not null
    and (to_timestamp(t.completed_at::bigint / 1000.0) at time zone 'UTC')::date >= (current_date - interval '30 days')
    and (to_timestamp(t.completed_at::bigint / 1000.0) at time zone 'UTC')::date <  current_date
  group by t.user_id, 2
),
task_agg as (
  select
    p.user_id,
    count(distinct d.day)                                                   as n_days_tasks_active,
    percentile_cont(0.5)  within group (order by d.daily_count::numeric)    as tasks_completed_median,
    percentile_cont(0.25) within group (order by d.daily_count::numeric)    as tasks_completed_p25,
    percentile_cont(0.75) within group (order by d.daily_count::numeric)    as tasks_completed_p75
  from profile p
  left join task_per_day d on d.user_id = p.user_id
  group by p.user_id
),
habit_agg as (
  select
    p.user_id,
    count(distinct h.entry_date) filter (where h.due_count > 0)                                     as n_days_habits,
    percentile_cont(0.5)  within group (order by (h.done_count::numeric / nullif(h.due_count, 0))) as habit_done_pct_median,
    percentile_cont(0.25) within group (order by (h.done_count::numeric / nullif(h.due_count, 0))) as habit_done_pct_p25,
    percentile_cont(0.75) within group (order by (h.done_count::numeric / nullif(h.due_count, 0))) as habit_done_pct_p75
  from profile p
  left join public.journal_habit_summary h
    on h.user_id = p.user_id
   and h.entry_date >= (current_date - interval '30 days')
   and h.entry_date <  current_date
   and h.due_count > 0
  group by p.user_id
)
select
  p.user_id,
  p.email,
  current_date as computed_for_date,
  o.n_days_sleep, o.n_days_readiness, o.n_days_activity,
  o.sleep_score_median,      o.sleep_score_p25,      o.sleep_score_p75,
  o.readiness_score_median,  o.readiness_score_p25,  o.readiness_score_p75,
  o.activity_score_median,   o.activity_score_p25,   o.activity_score_p75,
  o.total_sleep_min_median,  o.total_sleep_min_p25,  o.total_sleep_min_p75,
  o.hrv_ms_median,           o.hrv_ms_p25,           o.hrv_ms_p75,
  o.resting_hr_median,       o.resting_hr_p25,       o.resting_hr_p75,
  j.n_days_mood,
  j.mood_median,             j.mood_p25,             j.mood_p75,
  t.n_days_tasks_active,
  t.tasks_completed_median,  t.tasks_completed_p25,  t.tasks_completed_p75,
  h.n_days_habits,
  h.habit_done_pct_median,   h.habit_done_pct_p25,   h.habit_done_pct_p75
from profile p
left join oura_agg    o on o.user_id = p.user_id
left join journal_agg j on j.user_id = p.user_id
left join task_agg    t on t.user_id = p.user_id
left join habit_agg   h on h.user_id = p.user_id;

create unique index if not exists v_user_baselines_30d_user_idx
  on public.v_user_baselines_30d(user_id);

-- ── 7-day rolling baselines ──────────────────────────────────────────────
-- Same shape as 30d; only the window changes. Kept as a separate view (rather
-- than parameterized) so changes to either window don't entangle the other,
-- and so the nightly cron refreshes them independently.
drop materialized view if exists public.v_user_baselines_7d;

create materialized view public.v_user_baselines_7d as
with profile as (
  select supabase_user_id as user_id, email
  from public.user_profiles
  where supabase_user_id is not null
),
oura_agg as (
  select
    p.user_id,
    count(distinct o.date) filter (where o.sleep_score     is not null) as n_days_sleep,
    count(distinct o.date) filter (where o.readiness_score is not null) as n_days_readiness,
    count(distinct o.date) filter (where o.activity_score  is not null) as n_days_activity,
    percentile_cont(0.5)  within group (order by o.sleep_score)         as sleep_score_median,
    percentile_cont(0.25) within group (order by o.sleep_score)         as sleep_score_p25,
    percentile_cont(0.75) within group (order by o.sleep_score)         as sleep_score_p75,
    percentile_cont(0.5)  within group (order by o.readiness_score)     as readiness_score_median,
    percentile_cont(0.25) within group (order by o.readiness_score)     as readiness_score_p25,
    percentile_cont(0.75) within group (order by o.readiness_score)     as readiness_score_p75,
    percentile_cont(0.5)  within group (order by o.activity_score)      as activity_score_median,
    percentile_cont(0.25) within group (order by o.activity_score)      as activity_score_p25,
    percentile_cont(0.75) within group (order by o.activity_score)      as activity_score_p75,
    percentile_cont(0.5)  within group (order by o.total_sleep_min)     as total_sleep_min_median,
    percentile_cont(0.25) within group (order by o.total_sleep_min)     as total_sleep_min_p25,
    percentile_cont(0.75) within group (order by o.total_sleep_min)     as total_sleep_min_p75,
    percentile_cont(0.5)  within group (order by o.hrv_ms)              as hrv_ms_median,
    percentile_cont(0.25) within group (order by o.hrv_ms)              as hrv_ms_p25,
    percentile_cont(0.75) within group (order by o.hrv_ms)              as hrv_ms_p75,
    percentile_cont(0.5)  within group (order by o.resting_hr)          as resting_hr_median,
    percentile_cont(0.25) within group (order by o.resting_hr)          as resting_hr_p25,
    percentile_cont(0.75) within group (order by o.resting_hr)          as resting_hr_p75
  from profile p
  left join public.oura_daily o
    on o.user_email = p.email
   and o.date >= (current_date - interval '7 days')
   and o.date <  current_date
  group by p.user_id
),
journal_agg as (
  select
    p.user_id,
    count(distinct j.entry_date) filter (where j.mood is not null)                  as n_days_mood,
    percentile_cont(0.5)  within group (order by j.mood::numeric)                   as mood_median,
    percentile_cont(0.25) within group (order by j.mood::numeric)                   as mood_p25,
    percentile_cont(0.75) within group (order by j.mood::numeric)                   as mood_p75
  from profile p
  left join public.journal_entries j
    on j.user_id = p.user_id
   and j.entry_date >= (current_date - interval '7 days')
   and j.entry_date <  current_date
   and j.mood is not null
  group by p.user_id
),
task_per_day as (
  select
    t.user_id,
    (to_timestamp(t.completed_at::bigint / 1000.0) at time zone 'UTC')::date as day,
    count(*) as daily_count
  from public.tasks t
  where t.done = true
    and t.completed_at is not null
    and (to_timestamp(t.completed_at::bigint / 1000.0) at time zone 'UTC')::date >= (current_date - interval '7 days')
    and (to_timestamp(t.completed_at::bigint / 1000.0) at time zone 'UTC')::date <  current_date
  group by t.user_id, 2
),
task_agg as (
  select
    p.user_id,
    count(distinct d.day)                                                   as n_days_tasks_active,
    percentile_cont(0.5)  within group (order by d.daily_count::numeric)    as tasks_completed_median,
    percentile_cont(0.25) within group (order by d.daily_count::numeric)    as tasks_completed_p25,
    percentile_cont(0.75) within group (order by d.daily_count::numeric)    as tasks_completed_p75
  from profile p
  left join task_per_day d on d.user_id = p.user_id
  group by p.user_id
),
habit_agg as (
  select
    p.user_id,
    count(distinct h.entry_date) filter (where h.due_count > 0)                                     as n_days_habits,
    percentile_cont(0.5)  within group (order by (h.done_count::numeric / nullif(h.due_count, 0))) as habit_done_pct_median,
    percentile_cont(0.25) within group (order by (h.done_count::numeric / nullif(h.due_count, 0))) as habit_done_pct_p25,
    percentile_cont(0.75) within group (order by (h.done_count::numeric / nullif(h.due_count, 0))) as habit_done_pct_p75
  from profile p
  left join public.journal_habit_summary h
    on h.user_id = p.user_id
   and h.entry_date >= (current_date - interval '7 days')
   and h.entry_date <  current_date
   and h.due_count > 0
  group by p.user_id
)
select
  p.user_id,
  p.email,
  current_date as computed_for_date,
  o.n_days_sleep, o.n_days_readiness, o.n_days_activity,
  o.sleep_score_median,      o.sleep_score_p25,      o.sleep_score_p75,
  o.readiness_score_median,  o.readiness_score_p25,  o.readiness_score_p75,
  o.activity_score_median,   o.activity_score_p25,   o.activity_score_p75,
  o.total_sleep_min_median,  o.total_sleep_min_p25,  o.total_sleep_min_p75,
  o.hrv_ms_median,           o.hrv_ms_p25,           o.hrv_ms_p75,
  o.resting_hr_median,       o.resting_hr_p25,       o.resting_hr_p75,
  j.n_days_mood,
  j.mood_median,             j.mood_p25,             j.mood_p75,
  t.n_days_tasks_active,
  t.tasks_completed_median,  t.tasks_completed_p25,  t.tasks_completed_p75,
  h.n_days_habits,
  h.habit_done_pct_median,   h.habit_done_pct_p25,   h.habit_done_pct_p75
from profile p
left join oura_agg    o on o.user_id = p.user_id
left join journal_agg j on j.user_id = p.user_id
left join task_agg    t on t.user_id = p.user_id
left join habit_agg   h on h.user_id = p.user_id;

create unique index if not exists v_user_baselines_7d_user_idx
  on public.v_user_baselines_7d(user_id);

-- ── 30-day event rates from oura_tags ────────────────────────────────────
-- Long-form (one row per user per tag_type_code) so new tag types appear
-- automatically without schema changes. Tags can span multiple days; we count
-- distinct start_days for "days with at least one event" plus raw event_count.
drop materialized view if exists public.v_user_event_rates_30d;

create materialized view public.v_user_event_rates_30d as
select
  p.supabase_user_id                     as user_id,
  p.email,
  coalesce(t.tag_type_code, 'unknown')   as tag_type_code,
  count(*)                               as event_count,
  count(distinct t.start_day)            as days_with_event,
  current_date                           as computed_for_date
from public.user_profiles p
join public.oura_tags t
  on t.user_email = p.email
 and t.start_day >= (current_date - interval '30 days')
 and t.start_day <  current_date
where p.supabase_user_id is not null
group by p.supabase_user_id, p.email, t.tag_type_code;

create unique index if not exists v_user_event_rates_30d_pk_idx
  on public.v_user_event_rates_30d(user_id, tag_type_code);

-- ── Lock down access ─────────────────────────────────────────────────────
-- Materialized views don't honor RLS; protect via GRANT revocation. Reads
-- happen inside Netlify functions with the service key, which bypasses GRANTs.
revoke all on public.v_user_baselines_30d   from anon, authenticated;
revoke all on public.v_user_baselines_7d    from anon, authenticated;
revoke all on public.v_user_event_rates_30d from anon, authenticated;

-- ── Nightly refresh via pg_cron ──────────────────────────────────────────
-- 04:30 UTC — runs after cron-health-sync (04:00 UTC) so baselines reflect
-- the most recent night's data. CONCURRENTLY avoids blocking reads from any
-- in-flight brief generation (e.g. an early-rising user in a far east TZ).
do $$
begin
  if exists (select 1 from cron.job where jobname = 'refresh-user-baselines') then
    perform cron.unschedule('refresh-user-baselines');
  end if;
end
$$;

select cron.schedule(
  'refresh-user-baselines',
  '30 4 * * *',
  $$
    refresh materialized view concurrently public.v_user_baselines_30d;
    refresh materialized view concurrently public.v_user_baselines_7d;
    refresh materialized view concurrently public.v_user_event_rates_30d;
  $$
);

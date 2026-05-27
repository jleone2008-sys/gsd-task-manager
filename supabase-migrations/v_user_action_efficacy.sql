-- Phase 10 — efficacy rollup.
--
-- Materialized view that aggregates brief_action_outcomes into per-user,
-- per-signature, per-variant efficacy stats. Two consumers:
--
--   beta-daily-brief.js — selects rows for the current user with
--   n_observations >= 5 and injects them into the brief context as
--   efficacy_profile[], one paragraph in the system prompt nudges Claude
--   to lean into positive deltas and avoid negative ones.
--
--   beta-weekly-synthesis-background.js — Opus 4.7 can tool-call into
--   this view via get_action_efficacy(signature?) for deeper analysis;
--   it can also tool-call get_raw_outcomes for ground truth when the
--   aggregate looks anomalous.
--
-- Refresh schedule: nightly via cron-evaluate-actions.js after the
-- evaluate run completes (so the freshest T+1/T+3 fills are reflected).
-- CONCURRENTLY refresh keeps the view available to readers during refresh.
--
-- Comparison columns:
--   mean_delta_*_when_followed   — average T+1 (or T+3) delta among rows
--                                   where adherence_score >= 0.7. Treat
--                                   this as the "treatment arm".
--   mean_delta_*_when_ignored    — average delta among rows where
--                                   adherence_score <= 0.3. Treat this as
--                                   the "natural control" — same kind of
--                                   day, recommendation issued, user
--                                   didn't act. Difference between the
--                                   two is the causal estimate.
--   n_followed / n_ignored       — sample sizes for each arm. The brief
--                                   system prompt only mentions the
--                                   signature when n_followed >= 5.
--   stddev_delta_t1_when_followed — variance check; the brief sets
--                                   confidence='high' only when n>=20
--                                   AND stddev < 7.

drop materialized view if exists public.v_user_action_efficacy;

create materialized view public.v_user_action_efficacy as
with rows as (
  select
    user_id,
    recommendation_signature,
    variant_id,
    source_metric,
    adherence_score,
    case
      when value_at_t_plus_1 is not null and baseline_value is not null
        then value_at_t_plus_1 - baseline_value
      else null
    end as delta_t1,
    case
      when value_at_t_plus_3 is not null and baseline_value is not null
        then value_at_t_plus_3 - baseline_value
      else null
    end as delta_t3,
    created_at
  from public.brief_action_outcomes
  where computed_at is not null
)
select
  user_id,
  recommendation_signature,
  variant_id,
  source_metric,
  count(*) as n_observations,
  avg(adherence_score) filter (where adherence_score is not null) as mean_adherence,
  avg(delta_t1) filter (where adherence_score >= 0.7) as mean_delta_t1_when_followed,
  avg(delta_t1) filter (where adherence_score <= 0.3) as mean_delta_t1_when_ignored,
  avg(delta_t3) filter (where adherence_score >= 0.7) as mean_delta_t3_when_followed,
  avg(delta_t3) filter (where adherence_score <= 0.3) as mean_delta_t3_when_ignored,
  count(*) filter (where adherence_score >= 0.7) as n_followed,
  count(*) filter (where adherence_score <= 0.3) as n_ignored,
  stddev_pop(delta_t1) filter (where adherence_score >= 0.7) as stddev_delta_t1_when_followed,
  max(created_at) as last_seen_at
from rows
group by user_id, recommendation_signature, variant_id, source_metric;

-- Unique index on the natural key so REFRESH MATERIALIZED VIEW CONCURRENTLY
-- can be used (Postgres requires a unique index for concurrent refresh).
-- coalesce(variant_id, '') because NULLs are not equal to each other in a
-- unique index without it.
create unique index v_user_action_efficacy_pk
  on public.v_user_action_efficacy (
    user_id,
    recommendation_signature,
    (coalesce(variant_id, '')),
    source_metric
  );

-- Phase 10 — passive intervention tracking.
--
-- One row per actionable recommendation the daily brief emits. The brief
-- function inserts a stub immediately on generation (signature + baseline);
-- cron-evaluate-actions fills in adherence (next morning) + outcomes
-- (at T+1 and T+3). The materialized view v_user_action_efficacy rolls
-- these up into per-signature/per-variant efficacy stats that feed back
-- into the brief and weekly synthesis system prompts — closing the loop.
--
-- No dismiss UI; adherence is inferred entirely from downstream data
-- (oura_daily, workout_sessions, habit_completions). See
-- netlify/functions/lib/adherence-rules.js for the per-signature scoring.
--
-- Columns:
--   recommendation_signature  bucket the recommendation belongs to, e.g.
--                             'bedtime_target:21:30', 'intensity_reduce',
--                             'habit_focus:posture'. Embeds the prescribed
--                             value so identical recommendations aggregate.
--   variant_id                NULL when the recommendation is fully
--                             deterministic. Populated when pickVariant()
--                             selected between A/B arms — e.g. 'early' vs
--                             'standard' in the ambiguous-readiness band.
--                             The efficacy view groups by (signature,
--                             variant_id) so deterministic and A/B
--                             outcomes don't get mixed.
--   source_metric             which metric the recommendation targets:
--                             'sleep_score', 'readiness_score', 'hrv_ms',
--                             'mood_label', 'habits_done_pct', etc.
--                             Used by cron-evaluate-actions to read the
--                             right value at T+1 and T+3.
--   baseline_value            numeric value of source_metric on brief_date.
--                             NULL for ordinal metrics (mood uses
--                             baseline_value_text instead).
--   adherence_score           0.0–1.0, computed by adherence-rules.js the
--                             night after brief_date. NULL when no
--                             behavioral signal exists for this signature
--                             (e.g. hydrate, weather framing) — those rows
--                             are excluded from efficacy scoring; we just
--                             measure outcome.
--   adherence_evidence        jsonb — what the rule looked at to score.
--                             E.g. {actual_bedtime: '22:14', suggested:
--                             '21:30', delta_min: 44}.
--   conditions_snapshot       jsonb — baseline conditions at brief
--                             generation time (readiness, hrv, sleep, day
--                             of week). Used by the efficacy view + Opus
--                             tool calls to match like-with-like across
--                             A/B variants. Without this, "9:30 vs 10:00
--                             bedtime efficacy" is contaminated by the
--                             fact that 9:30 only fires on rough days.

create table if not exists public.brief_action_outcomes (
  id                       uuid          primary key default gen_random_uuid(),
  user_id                  uuid          not null references auth.users(id) on delete cascade,
  brief_id                 uuid          not null references public.daily_briefs(id) on delete cascade,
  brief_date               date          not null,
  brief_mode               text          not null check (brief_mode in ('morning','evening')),
  action_index             int           not null,
  recommendation_signature text          not null,
  variant_id               text,
  source_metric            text          not null,
  baseline_value           numeric,
  baseline_value_text      text,
  value_at_t_plus_1        numeric,
  value_at_t_plus_1_text   text,
  value_at_t_plus_3        numeric,
  value_at_t_plus_3_text   text,
  adherence_score          numeric       check (adherence_score is null or (adherence_score >= 0 and adherence_score <= 1)),
  adherence_evidence       jsonb,
  conditions_snapshot      jsonb,
  computed_at              timestamptz,
  created_at               timestamptz   not null default now()
);

create index if not exists brief_action_outcomes_user_signature_idx
  on public.brief_action_outcomes (user_id, recommendation_signature);

create index if not exists brief_action_outcomes_user_date_idx
  on public.brief_action_outcomes (user_id, brief_date desc);

create index if not exists brief_action_outcomes_brief_idx
  on public.brief_action_outcomes (brief_id);

-- One stub per (brief, action_index). Re-running the brief function in
-- force=true mode re-upserts the same stub rather than duplicating.
create unique index if not exists brief_action_outcomes_brief_action_uq
  on public.brief_action_outcomes (brief_id, action_index);

-- RLS: read-own, mirroring daily_briefs. Writes happen with service key in
-- beta-daily-brief.js + cron-evaluate-actions.js (bypasses RLS).
alter table public.brief_action_outcomes enable row level security;

drop policy if exists "brief_action_outcomes_select_own" on public.brief_action_outcomes;
create policy "brief_action_outcomes_select_own" on public.brief_action_outcomes
  for select
  using (auth.uid() = user_id);

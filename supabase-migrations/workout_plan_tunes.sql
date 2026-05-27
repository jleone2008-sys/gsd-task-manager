-- Phase 11 (Workout Tuner) — proposed monthly plan refinements.
--
-- One row per AI-proposed plan tweak (whether accepted, declined, reverted,
-- or rejected by server-side validation). Stores both the prior and
-- proposed day_template snapshots so:
--   - Accept can mutate workout_plans.day_template directly from this row
--   - Revert can restore prior_day_template one-shot
--   - The proposal card UI can render the before/after diff without
--     recomputing it on the client
--
-- Lifecycle:
--   pending    — Claude proposed; awaiting user Accept / Decline
--   accepted   — plan mutated; T+30 outcome tracking begins
--   declined   — user dismissed; counts toward "back off after 2 declines"
--   reverted   — user accepted then rolled back; treated as negative-
--                efficacy signal in the rollup
--   expired    — server-side validation rejected (policy violation) or the
--                tuner abstained; never surfaced to user
--
-- Storage of input_snapshot lets us debug or replay any proposal that the
-- user (or we) disagree with; storage of `changes` jsonb is the structured
-- diff the UI renders without parsing prior/proposed_day_template again.

create table if not exists public.workout_plan_tunes (
  id                  uuid          primary key default gen_random_uuid(),
  user_id             uuid          not null references auth.users(id) on delete cascade,
  plan_id             uuid          not null references public.workout_plans(id) on delete cascade,
  progress_pic_id     uuid          references public.progress_pics(id) on delete set null,
  proposed_at         timestamptz   not null default now(),

  -- The proposal itself.
  prior_day_template    jsonb       not null,
  proposed_day_template jsonb       not null,
  changes             jsonb         not null default '[]'::jsonb,
  rationale           text,
  focus_areas_addressed text[]      not null default '{}',

  -- Lifecycle.
  status              text          not null default 'pending'
                       check (status in ('pending','accepted','declined','reverted','expired')),
  status_changed_at   timestamptz,
  declined_reason     text,

  -- Phase 10-style outcome tracking. The signature feeds the existing
  -- v_user_action_efficacy view (no new view needed — different prefix
  -- partitions the rows naturally). source_metric for plan_tune outcomes
  -- is 'focus_area_progress' (1 = focus area resolved on next pic,
  -- 0 = still present, null = no pic in window).
  recommendation_signature text     not null,
  conditions_snapshot jsonb,

  -- AI provenance.
  model               text,
  prompt_tokens       int,
  completion_tokens   int,
  confidence          text          check (confidence in ('high','medium','low')),
  input_snapshot      jsonb,

  created_at          timestamptz   not null default now()
);

create index if not exists workout_plan_tunes_user_plan_idx
  on public.workout_plan_tunes (user_id, plan_id, proposed_at desc);

create index if not exists workout_plan_tunes_user_status_idx
  on public.workout_plan_tunes (user_id, status, proposed_at desc);

create index if not exists workout_plan_tunes_plan_status_idx
  on public.workout_plan_tunes (plan_id, status);

-- RLS: read-own + update-own (Accept/Decline/Revert flip status from the
-- client via beta-plan-tune-action.js, which is JWT-authed; the function
-- uses service-key for the related workout_plans mutation but updates
-- workout_plan_tunes through this policy so the audit trail is honest).
-- Inserts only via service key (beta-train-tune-background.js).
alter table public.workout_plan_tunes enable row level security;

drop policy if exists "workout_plan_tunes_select_own" on public.workout_plan_tunes;
create policy "workout_plan_tunes_select_own" on public.workout_plan_tunes
  for select
  using (auth.uid() = user_id);

drop policy if exists "workout_plan_tunes_update_own" on public.workout_plan_tunes;
create policy "workout_plan_tunes_update_own" on public.workout_plan_tunes
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Phase 11 (Workout Tuner) — track when the active plan was last AI-tuned,
-- so the 28-day eligibility gate in beta-train-tune-background.js has a
-- stable column to read.
--
-- last_plan_tune_at is set whenever the tuner runs to completion (whether
-- a proposal was generated or it abstained — either way the per-month gate
-- closes). last_plan_tune_id links to the workout_plan_tunes row that
-- represents that most-recent tune; the Manage Plans modal uses this to
-- decide whether to show the "Revert last AI tune" button.
--
-- Both columns are nullable: legacy plans created before this migration
-- have no tune history.

alter table public.workout_plans
  add column if not exists last_plan_tune_at timestamptz,
  add column if not exists last_plan_tune_id uuid;

-- FK added in workout_plan_tunes.sql once that table exists; we don't add
-- it here to avoid circular-migration ordering.

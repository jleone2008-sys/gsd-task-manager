-- Phase 4 — workout_sets.
--
-- One row per set (4 sets of Barbell Row → 4 rows). user_id is duplicated
-- onto each row so the per-exercise history lookup the AI feedback function
-- needs (get_exercise_history) is a single-index scan, not a join through
-- workout_sessions.
--
-- is_bodyweight=true means actual_weight is null and the set is logged by
-- reps alone (pull-ups, dips, push-ups). The UI shows "BW" in place of
-- the weight cell.

create table if not exists public.workout_sets (
  id             uuid primary key default gen_random_uuid(),
  session_id     uuid not null references public.workout_sessions(id) on delete cascade,
  user_id        uuid not null references auth.users(id) on delete cascade,
  exercise_name  text not null,
  set_index      int not null,
  target_reps    int,
  actual_reps    int,
  target_weight  numeric,
  actual_weight  numeric,
  is_bodyweight  boolean not null default false,
  rpe            int check (rpe between 1 and 10),
  set_notes      text,
  completed_at   timestamptz,
  created_at     timestamptz not null default now()
);

create index if not exists workout_sets_session
  on public.workout_sets(session_id, exercise_name, set_index);
-- Hot path for "show me my last N sets on Barbell Row" — used by both the
-- Today subtab (last-session reference) and the AI progression engine.
create index if not exists workout_sets_history
  on public.workout_sets(user_id, exercise_name, completed_at desc)
  where actual_reps is not null;

alter table public.workout_sets enable row level security;
drop policy if exists "workout_sets own" on public.workout_sets;
create policy "workout_sets own" on public.workout_sets for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

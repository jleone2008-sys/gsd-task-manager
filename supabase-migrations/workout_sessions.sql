-- Phase 4 — workout_sessions.
--
-- One row per workout the user starts. status='in_progress' while they're
-- logging sets; 'submitted' once they tap Submit + Get Feedback. The AI
-- progression engine (netlify/functions/workout-ai-feedback.js) writes
-- ai_feedback (prose) + ai_next_session (structured next-week targets)
-- onto the row after submission.
--
-- feel uses the same 1-5 scale as journal_entries.mood:
--   1 = 🤩 great, 2 = 😊 good, 3 = 😐 okay, 4 = 😔 low, 5 = 😢 bad.

create table if not exists public.workout_sessions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  plan_id         uuid references public.workout_plans(id) on delete set null,
  session_date    date not null,
  day_name        text,                                       -- 'Pull B', 'Bonus', etc.
  day_type        text check (day_type in ('lift','cardio','rest','bonus')),
  status          text not null default 'in_progress'
                    check (status in ('in_progress','submitted','abandoned')),
  feel            int check (feel between 1 and 5),
  session_notes   text,
  ai_feedback     text,
  ai_next_session jsonb,
  started_at      timestamptz not null default now(),
  submitted_at    timestamptz,
  created_at      timestamptz not null default now()
);

create index if not exists workout_sessions_user_date on public.workout_sessions(user_id, session_date desc);

alter table public.workout_sessions enable row level security;
drop policy if exists "workout_sessions own" on public.workout_sessions;
create policy "workout_sessions own" on public.workout_sessions for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Phase 4 commit 4 — habit_library: curated entries that user habits can
-- link to. Linking a habit to a library entry makes events from other
-- parts of the app (Train sessions, Progress entries, future Oura sync,
-- etc.) auto-mark the habit complete on the relevant day.
--
-- Globally readable (no per-user RLS — these are curated server-side and
-- not user-editable). Writes are gated to service-role only.
--
-- auto_complete_source JSONB shape:
--   { "table": "workout_sessions", "match": { "day_type": "lift" } }
--   { "table": "workout_sessions", "match": { "day_type": "cardio" } }
--   { "table": "progress_pics" }                          // any new entry
--
-- The client reads this when a relevant event lands (Train submit,
-- Progress submit, …) and looks up habits where library_kind = kind to
-- decide what to auto-complete.

create table if not exists public.habit_library (
  kind        text primary key,
  name        text not null,
  emoji       text,
  description text,
  auto_complete_source jsonb not null,
  created_at  timestamptz not null default now()
);

alter table public.habit_library enable row level security;

drop policy if exists "habit_library readable" on public.habit_library;
create policy "habit_library readable" on public.habit_library for select
  using (true);  -- everyone can read the library

-- Seed the four kinds. Idempotent — upserts the four core entries every
-- time the migration runs so a re-run picks up any copy / source tweaks.
insert into public.habit_library (kind, name, emoji, description, auto_complete_source) values
  ('lifting',  'Lifting',     '🏋️', 'Auto-completes when you submit a lift session in Train (planned lift days or Bonus Lifting).', '{"table":"workout_sessions","match":{"day_type":"lift"}}'::jsonb),
  ('cardio',   'Cardio',      '🏃', 'Auto-completes when you submit a cardio session in Train.',                                       '{"table":"workout_sessions","match":{"day_type":"cardio"}}'::jsonb),
  ('activity', 'Activity',    '🧗', 'Auto-completes when you log a Bonus Activity in Train (hikes, walks, climbing, pickup sports).',  '{"table":"workout_sessions","match":{"day_type":"bonus","day_name_contains":"Activity"}}'::jsonb),
  ('progress', 'Progress pic', '📸', 'Auto-completes when you log a body-composition entry in Progress.',                              '{"table":"progress_pics"}'::jsonb)
on conflict (kind) do update set
  name        = excluded.name,
  emoji       = excluded.emoji,
  description = excluded.description,
  auto_complete_source = excluded.auto_complete_source;

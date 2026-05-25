-- Phase 5 — intra-day mood check-ins.
--
-- Replaces the single-int-per-day mood model with a time-series capture
-- behind the same Home-tab emoji picker. Each tap on the picker creates
-- a row here at the current timestamp; journal_entries.mood is then
-- recomputed client-side as the rounded average of today's check-ins.
--
-- No context_tags / notes in v1 — per direction. Schema stays open to
-- add columns later without migrating data. The existing
-- journal_entries.mood column stays as the materialized daily summary
-- so the brief, baselines view, and journal day cards keep reading it
-- unchanged.

create table if not exists public.mood_checkins (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null references auth.users(id) on delete cascade,
  captured_at timestamptz not null default now(),
  mood        smallint    not null check (mood between 1 and 5),
  created_at  timestamptz not null default now()
);

create index if not exists mood_checkins_user_captured
  on public.mood_checkins(user_id, captured_at desc);

alter table public.mood_checkins enable row level security;

drop policy if exists "mood_checkins own select" on public.mood_checkins;
create policy "mood_checkins own select" on public.mood_checkins
  for select using (user_id = auth.uid());

drop policy if exists "mood_checkins own insert" on public.mood_checkins;
create policy "mood_checkins own insert" on public.mood_checkins
  for insert with check (user_id = auth.uid());

drop policy if exists "mood_checkins own update" on public.mood_checkins;
create policy "mood_checkins own update" on public.mood_checkins
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "mood_checkins own delete" on public.mood_checkins;
create policy "mood_checkins own delete" on public.mood_checkins
  for delete using (user_id = auth.uid());

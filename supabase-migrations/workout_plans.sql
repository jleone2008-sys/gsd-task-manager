-- Phase 4 — workout_plans.
--
-- Holds both built-in templates (PPL 6-day, Upper/Lower 4-day, Full Body
-- 3-day) and user-forked active plans. The 3 templates have user_id NULL
-- and is_template=true; everyone can SELECT them via the RLS policy.
-- Forking copies a template into a new row owned by the user.
--
-- day_template is a JSONB array of weekday entries:
--   [{ dow: 'Mon', name: 'Push A', type: 'lift',
--      exercises: [{ name, sets, reps, rest_s, notes }] },
--    { dow: 'Sun', name: 'Rest', type: 'rest' }, ...]

create table if not exists public.workout_plans (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references auth.users(id) on delete cascade,  -- NULL for built-in templates
  name          text not null,
  description   text,
  days_per_week int not null default 6,
  day_template  jsonb not null default '[]'::jsonb,
  is_template   boolean not null default false,
  is_active     boolean not null default false,
  forked_from   uuid references public.workout_plans(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists workout_plans_user_idx on public.workout_plans(user_id) where user_id is not null;
-- One active plan per user. Templates are not "active"; this constraint
-- only catches duplicates among real user-owned plans.
create unique index if not exists workout_plans_one_active
  on public.workout_plans(user_id)
  where is_active = true and user_id is not null;

alter table public.workout_plans enable row level security;

drop policy if exists "workout_plans select" on public.workout_plans;
create policy "workout_plans select" on public.workout_plans for select
  using (user_id = auth.uid() or is_template = true);

drop policy if exists "workout_plans insert" on public.workout_plans;
create policy "workout_plans insert" on public.workout_plans for insert
  with check (user_id = auth.uid() and is_template = false);

drop policy if exists "workout_plans update" on public.workout_plans;
create policy "workout_plans update" on public.workout_plans for update
  using (user_id = auth.uid() and is_template = false);

drop policy if exists "workout_plans delete" on public.workout_plans;
create policy "workout_plans delete" on public.workout_plans for delete
  using (user_id = auth.uid() and is_template = false);

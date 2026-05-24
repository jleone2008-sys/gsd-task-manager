-- Phase 4 — body_comp_goals.
--
-- One active goal per kind (weight, body_fat) per user. Creating a new
-- goal of the same kind deactivates the prior one (handled in app code,
-- not via trigger — keeps the migration simple).
--
-- start_value snapshots the value the day the goal was created so progress
-- % is honest even after the user logs new entries. target_value + end_date
-- together drive the calorie deficit formula: per-week loss rate = (start −
-- target) / (end − start) in weeks, then deficit cal/day = rate × 3500 / 7.

create table if not exists public.body_comp_goals (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  kind         text not null check (kind in ('weight','body_fat')),
  start_date   date not null,
  end_date     date not null,
  start_value  numeric not null,
  target_value numeric not null,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists body_comp_goals_active
  on public.body_comp_goals(user_id, kind)
  where is_active = true;
create index if not exists body_comp_goals_user_history
  on public.body_comp_goals(user_id, created_at desc);

alter table public.body_comp_goals enable row level security;
drop policy if exists "body_comp_goals own" on public.body_comp_goals;
create policy "body_comp_goals own" on public.body_comp_goals for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

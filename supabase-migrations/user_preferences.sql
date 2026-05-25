-- Phase 4 follow-up — split user-writable preferences off user_profiles.
--
-- THE PROBLEM with putting everything on user_profiles:
-- user_profiles holds both user-owned fields (sex, dob, height_in,
-- timezone, city, weather coords, units, activity_level) AND admin-owned
-- gating fields (access_status, role, status, tab_permissions, OAuth
-- refresh tokens). A row-level UPDATE policy would let any user
-- privilege-escalate by setting access_status='active' or role='admin'
-- on themselves. So we kept only a SELECT policy and added a
-- SECURITY DEFINER RPC per field group. That doesn't scale — every
-- new user-writable field needs a new RPC.
--
-- THE FIX: split into two tables.
-- - user_profiles  → admin-only writes (service key or admin-api).
--                    Holds access gates + OAuth tokens. Client reads via
--                    a SELECT-only policy filtered by email.
-- - user_preferences (this table) → user-owned. Full CRUD on own row
--                    via RLS. Holds everything the client legitimately
--                    needs to write.
--
-- Columns moved here from user_profiles:
--   sex, dob, height_in, activity_level, activity_level_override, units,
--   body_comp_profile_set_at, timezone, city, weather_lat, weather_lng,
--   weather_label
--
-- The columns stay on user_profiles for one release as a fallback;
-- a follow-up migration drops them once the code is fully migrated.

create table if not exists public.user_preferences (
  user_id                  uuid primary key references auth.users(id) on delete cascade,
  -- Body composition profile (feeds Mifflin-St Jeor / TDEE / Navy formula)
  sex                      text check (sex in ('male','female')),
  dob                      date,
  height_in                numeric,
  activity_level           text check (activity_level in ('sedentary','light','moderate','active','very_active')),
  activity_level_override  boolean default false,
  units                    text default 'imperial' check (units in ('imperial','metric')),
  body_comp_profile_set_at timestamptz,
  -- Locale + weather
  timezone                 text,
  city                     text,
  weather_lat              numeric,
  weather_lng              numeric,
  weather_label            text,
  -- Bookkeeping
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

-- RLS: user owns their own row, full CRUD.
alter table public.user_preferences enable row level security;

drop policy if exists "user_preferences select own" on public.user_preferences;
create policy "user_preferences select own" on public.user_preferences
  for select using (user_id = auth.uid());

drop policy if exists "user_preferences insert own" on public.user_preferences;
create policy "user_preferences insert own" on public.user_preferences
  for insert with check (user_id = auth.uid());

drop policy if exists "user_preferences update own" on public.user_preferences;
create policy "user_preferences update own" on public.user_preferences
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "user_preferences delete own" on public.user_preferences;
create policy "user_preferences delete own" on public.user_preferences
  for delete using (user_id = auth.uid());

-- Service role (Netlify functions) gets unrestricted access via the
-- service key — RLS bypass is automatic with that key, no policy needed.

-- ── Backfill ───────────────────────────────────────────────────────────
-- Copy existing data from user_profiles for every row that has a
-- supabase_user_id (the rest are orphan legacy rows that'll get a
-- preferences row when the user signs in or saves anything).
insert into public.user_preferences (
  user_id, sex, dob, height_in, activity_level, activity_level_override,
  units, body_comp_profile_set_at, timezone, city, weather_lat, weather_lng, weather_label,
  created_at, updated_at
)
select
  up.supabase_user_id,
  up.sex,
  up.dob,
  up.height_in,
  up.activity_level,
  coalesce(up.activity_level_override, false),
  coalesce(up.units, 'imperial'),
  up.body_comp_profile_set_at,
  up.timezone,
  up.city,
  up.weather_lat,
  up.weather_lng,
  up.weather_label,
  coalesce(up.created_at, now()),
  coalesce(up.updated_at, now())
from public.user_profiles up
where up.supabase_user_id is not null
on conflict (user_id) do nothing;

-- Auto-update updated_at on row modification.
create or replace function public.touch_user_preferences_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists user_preferences_updated_at on public.user_preferences;
create trigger user_preferences_updated_at
  before update on public.user_preferences
  for each row execute function public.touch_user_preferences_updated_at();

-- Report on the backfill (visible in apply-migration log).
do $$
declare
  copied int;
  orphans int;
begin
  select count(*) into copied from public.user_preferences;
  select count(*) into orphans
    from public.user_profiles up
    where up.supabase_user_id is null;
  raise notice 'user_preferences rows after backfill: % (orphan user_profiles rows without supabase_user_id: %)', copied, orphans;
end $$;

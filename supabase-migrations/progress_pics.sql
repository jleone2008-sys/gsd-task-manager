-- Phase 4 — progress_pics.
--
-- One row per body-composition entry (typically 1-2/week). Photos live in
-- the private 'progress-pics' Supabase Storage bucket; this table stores
-- the per-user object path under that bucket (e.g.
-- "userId/2026-05-24/front.jpg") so the client can fetch a signed URL.
--
-- body_fat_pct is computed two ways depending on what the user logged:
--   - 'navy_formula' when neck_in + waist_in are present (uses height from
--     user_profiles and hip_in for women): the deterministic preferred path
--   - 'ai_estimate'  when measurements are missing — Claude vision on the
--     photos returns a rough number, tagged 'low' confidence
-- The split lets the UI tell the user where the number came from.
--
-- ai_analysis JSONB shape (populated by netlify/functions/progress-pic-analysis):
--   { overview, needs_work[], balanced[], posture, body_type, stage,
--     class, v_taper, upper_lower, symmetry, skin, focus_areas[], confidence }

create table if not exists public.progress_pics (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references auth.users(id) on delete cascade,
  captured_date         date not null,
  weight_lbs            numeric,
  neck_in               numeric,
  waist_in              numeric,
  chest_in              numeric,
  arms_in               numeric,
  hips_in               numeric,
  thighs_in             numeric,
  notes                 text,
  front_storage_path    text,
  side_storage_path     text,
  back_storage_path     text,
  body_fat_pct          numeric,
  body_fat_method       text check (body_fat_method in ('navy_formula','ai_estimate')),
  body_fat_confidence   text check (body_fat_confidence in ('high','medium','low')),
  ai_analysis           jsonb,
  ai_compared_to        uuid references public.progress_pics(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists progress_pics_user_date
  on public.progress_pics(user_id, captured_date desc);
-- One entry per day per user (overwrites if re-logged). Avoids duplicate
-- rows when the user retakes photos on the same day; the second upload
-- updates the row instead of inserting alongside.
create unique index if not exists progress_pics_one_per_day
  on public.progress_pics(user_id, captured_date);

alter table public.progress_pics enable row level security;
drop policy if exists "progress_pics own" on public.progress_pics;
create policy "progress_pics own" on public.progress_pics for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

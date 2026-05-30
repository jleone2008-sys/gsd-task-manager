-- Body weight log — decoupled from progress_pics.
--
-- Why this table exists: weight used to live on progress_pics.weight_lbs, the
-- SAME row that holds body_fat_pct, measurements, photos, and the monthly AI
-- analysis. Because the app reads "the most recent progress_pics row" for
-- everything, logging weight frequently created weight-only rows that shadowed
-- body_fat_pct (which only changes on the ~monthly progress-pic analysis) and
-- polluted the photo timeline / "compare to previous" logic.
--
-- This table is the weight timeline, fully independent of body composition:
--   - Log as often as you want (one row per day — re-logging upserts).
--   - The most recent row is the canonical "current weight" for BMR/TDEE,
--     the daily calorie target, the weight goal, and the weight-trend chart.
--   - body_fat / lean mass / measurements / Coach Card keep reading from
--     progress_pics, untouched by weight logging.
--
-- progress_pics.weight_lbs stays as the photo-day weight SNAPSHOT (for accurate
-- per-photo lean-mass history); the photo-entry form also writes a body_weight
-- row so a photo-day weigh-in joins the timeline.

create table if not exists public.body_weight (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  measured_date date not null,
  weight_lbs    numeric not null,
  note          text,
  source        text not null default 'manual',   -- 'manual' | 'progress_pic'
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- One weigh-in per day per user — re-logging the same day overwrites (upsert
-- on this conflict target). Avoids noisy duplicate rows in the trend.
create unique index if not exists body_weight_one_per_day
  on public.body_weight(user_id, measured_date);
create index if not exists body_weight_user_date
  on public.body_weight(user_id, measured_date desc);

alter table public.body_weight enable row level security;
drop policy if exists "body_weight own" on public.body_weight;
create policy "body_weight own" on public.body_weight for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Backfill: seed the timeline from every existing progress_pics weight so the
-- trend/history carry over. Idempotent (do-nothing on the per-day conflict).
insert into public.body_weight (user_id, measured_date, weight_lbs, source)
select user_id, captured_date, weight_lbs, 'progress_pic'
from public.progress_pics
where weight_lbs is not null
on conflict (user_id, measured_date) do nothing;

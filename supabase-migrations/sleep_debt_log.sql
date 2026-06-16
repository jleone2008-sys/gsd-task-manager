-- ── Sleep Debt calibration log ─────────────────────────────────────────────
-- One row per (user, date): our raw Sleep Debt ESTIMATE for that day vs the
-- ACTUAL value the user reads from the Oura app. Powers a deterministic
-- calibration of computeSleepDebt (median actual/estimate ratio) so our guess
-- converges toward Oura's number over time. estimate_min is the RAW (pre-
-- calibration) estimate so the calibration factor stays stable.

create table if not exists public.sleep_debt_log (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  log_date     date not null,          -- the brief date this observation is for
  estimate_min int,                    -- our RAW estimate that day (nullable)
  need_min     int,                    -- our computed personal sleep need that day
  actual_min   int not null,           -- what Oura's app showed (user-entered), minutes
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (user_id, log_date)
);

create index if not exists sleep_debt_log_user_date
  on public.sleep_debt_log(user_id, log_date desc);

alter table public.sleep_debt_log enable row level security;
drop policy if exists "sleep_debt_log own" on public.sleep_debt_log;
create policy "sleep_debt_log own" on public.sleep_debt_log for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

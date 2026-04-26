-- Frozen per-day habit completion snapshot used by the journal view.
-- Today's value is always computed live in the client; this table stores
-- an immutable record once the day rolls over so that future cadence
-- changes (e.g. switching a habit from daily to 3x/week) don't silently
-- rewrite history.
--
-- Backfill strategy on first read of a missing date is "Option 1":
--   strict-cadence habits (daily/weekdays/custom DoW) → due if cadence matches
--   quota habits (x_per_week / x_per_month) → counted as 1/1 only on days
--     they were actually completed; missed quota days don't penalize.
create table if not exists public.journal_habit_summary (
  user_id    uuid not null references auth.users(id) on delete cascade,
  entry_date date not null,
  due_count  int  not null,
  done_count int  not null,
  habits     jsonb,                        -- per-habit detail for future use
  updated_at timestamptz default now(),
  primary key (user_id, entry_date)
);

alter table public.journal_habit_summary enable row level security;

drop policy if exists "users read own habit summaries"   on public.journal_habit_summary;
drop policy if exists "users insert own habit summaries" on public.journal_habit_summary;
drop policy if exists "users update own habit summaries" on public.journal_habit_summary;
drop policy if exists "users delete own habit summaries" on public.journal_habit_summary;

create policy "users read own habit summaries"
  on public.journal_habit_summary for select
  using (auth.uid() = user_id);

create policy "users insert own habit summaries"
  on public.journal_habit_summary for insert
  with check (auth.uid() = user_id);

create policy "users update own habit summaries"
  on public.journal_habit_summary for update
  using (auth.uid() = user_id);

create policy "users delete own habit summaries"
  on public.journal_habit_summary for delete
  using (auth.uid() = user_id);

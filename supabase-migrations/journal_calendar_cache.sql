-- Per-day cached Google Calendar events for the journal timeline.
-- The client refreshes when last_synced is older than 5 minutes
-- (CALENDAR_CACHE_FRESH_MS in beta/src/03-journal.js).
create table if not exists public.journal_calendar_cache (
  user_id     uuid not null references auth.users(id) on delete cascade,
  entry_date  date not null,
  events      jsonb not null default '[]'::jsonb,
  last_synced timestamptz not null default now(),
  primary key (user_id, entry_date)
);

alter table public.journal_calendar_cache enable row level security;

drop policy if exists "users read own calendar cache"   on public.journal_calendar_cache;
drop policy if exists "users insert own calendar cache" on public.journal_calendar_cache;
drop policy if exists "users update own calendar cache" on public.journal_calendar_cache;
drop policy if exists "users delete own calendar cache" on public.journal_calendar_cache;

create policy "users read own calendar cache"
  on public.journal_calendar_cache for select
  using (auth.uid() = user_id);

create policy "users insert own calendar cache"
  on public.journal_calendar_cache for insert
  with check (auth.uid() = user_id);

create policy "users update own calendar cache"
  on public.journal_calendar_cache for update
  using (auth.uid() = user_id);

create policy "users delete own calendar cache"
  on public.journal_calendar_cache for delete
  using (auth.uid() = user_id);

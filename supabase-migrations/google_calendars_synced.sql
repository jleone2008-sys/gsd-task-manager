-- Phase 5 — multi-Google-calendar selection.
--
-- Tracks which of the user's Google calendars feed into the Journal +
-- Brief context. Without this table, the existing flow only ever fetched
-- the 'primary' calendar. With this table populated, the client can
-- iterate enabled calendar IDs and merge events from each.
--
-- Backwards compatible: if a user has ZERO rows here, the sync code
-- falls back to the historical 'primary' behavior. Adding the first
-- row is opt-in via Settings → Connected calendars.
--
-- google_calendar_id values come from the calendarList endpoint:
--   - 'primary' for the user's primary calendar
--   - email-shaped IDs for owned/shared/subscribed calendars
--     (e.g. 'family7a4@group.calendar.google.com')

create table if not exists public.google_calendars_synced (
  user_id            uuid        not null references auth.users(id) on delete cascade,
  google_calendar_id text        not null,
  label              text,
  color_hex          text,
  enabled            boolean     not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  primary key (user_id, google_calendar_id)
);

create index if not exists google_calendars_synced_user_enabled
  on public.google_calendars_synced(user_id)
  where enabled = true;

alter table public.google_calendars_synced enable row level security;

drop policy if exists "google_calendars_synced own select" on public.google_calendars_synced;
create policy "google_calendars_synced own select" on public.google_calendars_synced
  for select using (user_id = auth.uid());

drop policy if exists "google_calendars_synced own insert" on public.google_calendars_synced;
create policy "google_calendars_synced own insert" on public.google_calendars_synced
  for insert with check (user_id = auth.uid());

drop policy if exists "google_calendars_synced own update" on public.google_calendars_synced;
create policy "google_calendars_synced own update" on public.google_calendars_synced
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "google_calendars_synced own delete" on public.google_calendars_synced;
create policy "google_calendars_synced own delete" on public.google_calendars_synced
  for delete using (user_id = auth.uid());

-- Auto-update updated_at on row modification.
create or replace function public.touch_google_calendars_synced_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists google_calendars_synced_updated_at on public.google_calendars_synced;
create trigger google_calendars_synced_updated_at
  before update on public.google_calendars_synced
  for each row execute function public.touch_google_calendars_synced_updated_at();

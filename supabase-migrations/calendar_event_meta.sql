-- Phase 5 — per-event metadata that the user attaches manually.
--
-- Tap a calendar event in Journal → open the metadata editor → save a
-- relationship_tag, post-event energy, and free-text notes. These
-- annotations feed the weekly synthesis (Phase 7) so patterns like
-- "meetings with X consistently drop energy" or "Monday standups → low
-- energy after" can be surfaced.
--
-- Keyed on (user_id, calendar_event_id). The Google event ID is stable
-- per occurrence when fetched with singleEvents=true (the journal sync
-- always passes this flag). Recurring series' individual instances
-- therefore each get a distinct id and a distinct meta row.
--
-- google_calendar_id is denormalized for downstream queries — once the
-- user has multi-calendar sync (which they now do), the brief + weekly
-- synthesis can filter meta by calendar source without joining back to
-- journal_calendar_cache.

create table if not exists public.calendar_event_meta (
  user_id            uuid        not null references auth.users(id) on delete cascade,
  calendar_event_id  text        not null,
  google_calendar_id text,
  event_summary      text,                                      -- snapshot at time of tag
  event_start        timestamptz,                               -- snapshot at time of tag
  relationship_tag   text,                                      -- free-text, suggested chips client-side
  energy_after       smallint    check (energy_after between 1 and 5),  -- 1=Great .. 5=Bad
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  primary key (user_id, calendar_event_id)
);

create index if not exists calendar_event_meta_user_start
  on public.calendar_event_meta(user_id, event_start desc);
create index if not exists calendar_event_meta_user_relationship
  on public.calendar_event_meta(user_id, relationship_tag)
  where relationship_tag is not null;

alter table public.calendar_event_meta enable row level security;

drop policy if exists "calendar_event_meta own select" on public.calendar_event_meta;
create policy "calendar_event_meta own select" on public.calendar_event_meta
  for select using (user_id = auth.uid());

drop policy if exists "calendar_event_meta own insert" on public.calendar_event_meta;
create policy "calendar_event_meta own insert" on public.calendar_event_meta
  for insert with check (user_id = auth.uid());

drop policy if exists "calendar_event_meta own update" on public.calendar_event_meta;
create policy "calendar_event_meta own update" on public.calendar_event_meta
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "calendar_event_meta own delete" on public.calendar_event_meta;
create policy "calendar_event_meta own delete" on public.calendar_event_meta
  for delete using (user_id = auth.uid());

-- Auto-touch updated_at on row modification.
create or replace function public.touch_calendar_event_meta_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists calendar_event_meta_updated_at on public.calendar_event_meta;
create trigger calendar_event_meta_updated_at
  before update on public.calendar_event_meta
  for each row execute function public.touch_calendar_event_meta_updated_at();

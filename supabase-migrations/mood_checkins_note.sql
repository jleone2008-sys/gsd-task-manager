-- Phase 5 follow-up — optional reflection text on each mood check-in.
--
-- The Home-tab mood picker now opens a small modal after each tap with
-- a Skip / Submit pair around an optional textarea. The text is stored
-- here as `note` so AI flows (daily brief, weekly synthesis, ask-chat)
-- can reference the user's own words alongside the numeric mood.
--
-- Nullable + no default — Skip and bare-emoji taps land with note=null.
-- No length cap at the DB level; the client soft-limits to keep token
-- budgets predictable.
alter table public.mood_checkins
  add column if not exists note text;

comment on column public.mood_checkins.note is
  'Optional free-text reflection captured at check-in time. May be null. '
  'Surfaced to AI brief + weekly synthesis as the qualitative pair for the '
  'numeric mood value. Trimmed at the client; never required.';

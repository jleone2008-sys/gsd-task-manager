-- IANA timezone name for each user (e.g. 'America/New_York'). Used by the
-- per-user daily brief cron, baseline materialized view date bucketing, and
-- any other surface that needs "the user's local day" rather than UTC.
--
-- Populated by the frontend on app load via
-- Intl.DateTimeFormat().resolvedOptions().timeZone. NULL until first populated;
-- consumers should coalesce to 'UTC' or a sensible default.
--
-- Adjustable in Settings (user-overridable, in case the browser is wrong or
-- the user travels and wants briefs anchored to their home timezone).
alter table public.user_profiles
  add column if not exists timezone text;

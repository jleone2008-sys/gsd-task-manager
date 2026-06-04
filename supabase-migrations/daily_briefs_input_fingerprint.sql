-- Brief cost reduction (Tier-2 redundancy fix). The hourly cron used to call
-- Claude on every tick (force=true) → ~17 API calls/user/day, mostly identical.
--
-- We now store a fingerprint of the brief's INPUT claim set (the verified facts
-- the model writes from — see lib/brief-claims.js). On each hourly tick the
-- generator rebuilds context (cheap, no API) and compares the fingerprint; if
-- it's unchanged the brief would say the same thing, so we skip the Claude call
-- and serve the cached row. Regeneration happens only when the salient inputs
-- actually move (recovery synced, tasks/mood/calendar changed) or the mode flips.
alter table public.daily_briefs
  add column if not exists input_fingerprint text;

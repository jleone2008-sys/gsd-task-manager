-- Phase 4 cleanup — drop the orphan update_body_comp_profile RPC.
--
-- The RPC was a SECURITY DEFINER workaround for not having a user-facing
-- UPDATE policy on user_profiles. The user_profiles → user_preferences
-- table split (user_preferences.sql) made it unnecessary — the Progress
-- wizard now upserts user_preferences directly with full RLS. A repo-wide
-- audit confirmed zero remaining call sites for db.rpc('update_body_comp_profile').
--
-- Idempotent via `if exists`. Reversible by re-applying
-- update_body_comp_profile_rpc.sql.

drop function if exists public.update_body_comp_profile(text, text, date, numeric, text, text);

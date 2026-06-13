-- Security hardening (2026-06-08) — lock down v_user_action_efficacy.
--
-- v_user_action_efficacy is a MATERIALIZED view. Materialized views do NOT
-- enforce Row-Level Security and carry no policy of their own, so with the
-- default grants any authenticated user could read EVERY user's efficacy rows
-- via a raw PostgREST call:
--   GET /rest/v1/v_user_action_efficacy?select=*
-- (The app never does this — every server caller filters user_id=eq.<self>,
-- and the client never queries it — but the view was reachable, so close it.)
--
-- Fix: revoke all access from the anon + authenticated roles, matching the
-- pattern already used by the baselines views (baselines_views.sql). The view
-- is only ever read server-side via the service role, which is unaffected by
-- these revokes. Idempotent — safe to re-run.

revoke all on public.v_user_action_efficacy from anon, authenticated;

-- Verify (should return NO rows for anon/authenticated after this runs):
--   select grantee, privilege_type
--     from information_schema.role_table_grants
--    where table_name = 'v_user_action_efficacy'
--      and grantee in ('anon', 'authenticated');

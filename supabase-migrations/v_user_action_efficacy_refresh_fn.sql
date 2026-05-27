-- Phase 10 — security-definer wrapper to refresh the efficacy view
-- from cron-evaluate-actions.js via PostgREST RPC.
--
-- Why a wrapper: REFRESH MATERIALIZED VIEW requires ownership of the
-- view, which the service role doesn't have by default after a CREATE.
-- A security-definer function owned by postgres lets the service role
-- trigger the refresh without granting blanket ownership.
--
-- Why CONCURRENTLY: the view has a unique index (created in
-- v_user_action_efficacy.sql) which Postgres requires for concurrent
-- refresh. Concurrent keeps the view readable to the brief function
-- during the operation — important when the brief is being generated
-- at the same moment as the cron firing.
--
-- The function is callable via:
--   POST {SUPABASE_URL}/rest/v1/rpc/refresh_efficacy_view
--   apikey: <service-key>

create or replace function public.refresh_efficacy_view()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  refresh materialized view concurrently public.v_user_action_efficacy;
end;
$$;

-- Lock down execution to authenticated + service_role only. We don't
-- want anon to be able to trigger a refresh (cheap but pointless).
revoke all on function public.refresh_efficacy_view() from public;
grant execute on function public.refresh_efficacy_view() to authenticated, service_role;

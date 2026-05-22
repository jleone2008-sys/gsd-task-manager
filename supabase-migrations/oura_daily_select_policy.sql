-- Let authenticated users read their OWN Oura daily rows directly from the
-- browser (the Home tab's Sleep/Readiness/Activity rings + 7-day trend).
--
-- oura_daily / whoop_daily originally had RLS enabled with NO policies, so all
-- reads went through service-key Netlify functions. Now that the frontend has a
-- legitimate reader, a scoped SELECT policy is the cleaner pattern (matches how
-- tasks/habits/notes are read directly with RLS).
--
-- These tables are keyed by user_email (not user_id), so the policy compares
-- against auth.email() rather than auth.uid().
--
-- SELECT only: the nightly cron-health-sync function keeps writing with the
-- service key (which bypasses RLS), so clients still cannot insert/update/delete.

create policy "oura_daily_select_own" on public.oura_daily
  for select
  using (auth.email() = user_email);

-- Symmetric policy for Whoop, so the Home rings can switch to direct reads when
-- Whoop support lands without another migration.
create policy "whoop_daily_select_own" on public.whoop_daily
  for select
  using (auth.email() = user_email);

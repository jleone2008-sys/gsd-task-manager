-- Phase 4 follow-up — backfill user_profiles.supabase_user_id from auth.users.
--
-- The legacy beta_users insert in user_profiles_access_status.sql created
-- rows by email only, leaving supabase_user_id NULL. The
-- upsert_user_profile_id RPC was supposed to populate it on first sign-in,
-- but it's a fire-and-forget call (.then(null, () => {})) so any failure
-- is silent — and there was no observability when it didn't run.
--
-- Consequence: client code that filtered user_profiles by supabase_user_id
-- silently returned 0 rows for these legacy users. UPDATE writes filtered
-- the same way silently 0-affected (Supabase update() doesn't throw on
-- empty match) which presented as "save succeeded" but persisted nothing
-- — exactly what happened with the Progress-tab setup wizard.
--
-- This migration joins user_profiles → auth.users by email and sets the
-- missing supabase_user_id in one shot. Idempotent: re-runs are no-ops
-- because the WHERE clause excludes rows that are already populated.
--
-- After this, every existing user_profiles row that maps to a real
-- auth.users row has supabase_user_id set. New rows created via
-- upsert_user_profile_id continue to set it on insert.

update public.user_profiles up
   set supabase_user_id = u.id
  from auth.users u
 where up.email = u.email
   and up.supabase_user_id is null;

-- Report how many rows were touched (visible in the apply-migration log).
do $$
declare
  null_remaining int;
begin
  select count(*) into null_remaining
    from public.user_profiles
   where supabase_user_id is null;
  raise notice 'user_profiles rows still missing supabase_user_id: %', null_remaining;
end $$;

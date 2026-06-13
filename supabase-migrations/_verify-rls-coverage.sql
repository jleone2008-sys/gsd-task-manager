-- RLS coverage verification (2026-06-08) — READ-ONLY diagnostic. Run in the
-- Supabase SQL editor. Changes nothing; just reports.
--
-- WHY: these user-data tables were created in migration history that is NOT in
-- this repo (supabase-migrations/ only ALTERs them to add columns), so their
-- RLS state can't be confirmed from code. The client reads/writes all of them
-- relying ENTIRELY on RLS for per-user isolation. user_profiles is the most
-- sensitive — it holds encrypted OAuth/Whoop tokens (google_refresh_token_enc,
-- dropbox_refresh_token_enc, whoop_client_secret_enc).
--
-- WHAT TO CONFIRM:
--   (1) Every table below shows rls_enabled = true.
--   (2) Every table has at least one policy whose USING/CHECK clause ties rows
--       to the authenticated user (auth.uid() = user_id, or auth.email() =
--       user_email). A policy with qual = "true" or no user predicate is a
--       cross-user exposure and must be fixed.

-- (1) Is RLS enabled on each table?
select c.relname            as table_name,
       c.relrowsecurity     as rls_enabled,
       c.relforcerowsecurity as rls_forced
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relname in (
     'tasks', 'task_subtasks', 'habits', 'habit_completions',
     'journal_entries', 'journal_entries_learning', 'notes', 'notebooks',
     'user_profiles', 'user_settings', 'dropbox_shared_folders',
     'health_sync_log'
   )
 order by c.relrowsecurity asc, c.relname;   -- any rls_enabled = false floats to the top

-- (2) What policies exist, and what do they actually scope by?
--     Inspect `qual` (USING) and `with_check` (WITH CHECK): each should
--     reference auth.uid()/auth.email(). Flag any that say "true" or omit the
--     user predicate. Tables with NO row here have RLS enabled but no policy
--     (deny-all to clients) OR no RLS at all — cross-check against query (1).
select tablename,
       policyname,
       cmd          as applies_to,   -- SELECT / INSERT / UPDATE / DELETE / ALL
       roles,
       qual         as using_clause,
       with_check   as check_clause
  from pg_policies
 where schemaname = 'public'
   and tablename in (
     'tasks', 'task_subtasks', 'habits', 'habit_completions',
     'journal_entries', 'journal_entries_learning', 'notes', 'notebooks',
     'user_profiles', 'user_settings', 'dropbox_shared_folders',
     'health_sync_log'
   )
 order by tablename, cmd;

-- (3) Extra scrutiny on user_profiles: confirm the SELECT policy can't expose
--     one user's *_enc token columns to anyone else. The USING clause for the
--     SELECT (or ALL) policy MUST be something like (supabase_user_id = auth.uid())
--     or (email = auth.email()). If it's broader, that's a token-disclosure risk.
select policyname, cmd as applies_to, qual as using_clause, with_check as check_clause
  from pg_policies
 where schemaname = 'public' and tablename = 'user_profiles';

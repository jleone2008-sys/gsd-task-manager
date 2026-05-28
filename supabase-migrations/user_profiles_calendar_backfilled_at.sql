-- Calendar history backfill marker.
--
-- The journal calendar sync used to re-pull a full year of history on every
-- page load. Past events are immutable once they've happened, so we now do
-- the full historical backfill ONCE per user, record the timestamp here, and
-- on later loads only refresh a small rolling forward window. This column is
-- the persisted "the one-time backfill has run" flag (NULL = not yet done).
alter table public.user_profiles
  add column if not exists calendar_backfilled_at timestamptz;

-- SECURITY DEFINER setter so the browser client can flag its own backfill
-- complete without a broad UPDATE policy on user_profiles. Identity comes
-- from the JWT (auth.uid()), never a caller-supplied param, so one user can
-- never mark another user's row.
create or replace function public.mark_calendar_backfilled()
returns void
language sql
security definer
set search_path = public
as $$
  update public.user_profiles
     set calendar_backfilled_at = now()
   where supabase_user_id = auth.uid();
$$;

revoke all on function public.mark_calendar_backfilled() from public;
grant execute on function public.mark_calendar_backfilled() to authenticated;

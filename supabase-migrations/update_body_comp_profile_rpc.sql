-- Phase 4 follow-up — RPC for user-driven body-comp profile updates.
--
-- WHY THIS RPC AND NOT A PLAIN UPDATE POLICY:
-- user_profiles holds both user-owned fields (sex, dob, height_in, units,
-- timezone, city, weather_*) AND admin-owned gating fields (access_status,
-- role, status, tab_permissions). Adding a row-level UPDATE policy
-- ("user can update their own row") would let any user privilege-
-- escalate by setting access_status='active' or role='admin' on
-- themselves. Column-level grants are an option but get tangled with
-- the existing supabase-js generic .update() pathway.
--
-- A SECURITY DEFINER function locks the column set down at the
-- definition. Users can ONLY call this function to mutate the listed
-- columns; the admin columns stay reachable only via the service key
-- (admin-api function).
--
-- The function double-checks the caller's email matches the row being
-- updated — defense-in-depth against any future GRANT widening.
--
-- Before this migration, the Progress-tab wizard called .update()
-- directly. RLS blocked it (no UPDATE policy existed) so the write
-- 0-affected silently. The .select() guard I added on the client
-- surfaces this as "profile row not found" — which is why the user
-- saw that error after the email-match fix landed.

create or replace function public.update_body_comp_profile(
  p_email          text,
  p_sex            text,
  p_dob            date,
  p_height_in      numeric,
  p_activity_level text,
  p_units          text
) returns public.user_profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  jwt_email text;
  result public.user_profiles;
begin
  jwt_email := nullif(auth.jwt() ->> 'email', '');
  if jwt_email is null or lower(jwt_email) <> lower(p_email) then
    raise exception 'caller email does not match target row';
  end if;

  -- Validate enum-ish columns up front so a bad client value 22-errors
  -- here instead of slipping through to the row check constraints.
  if p_sex is not null and p_sex not in ('male','female') then
    raise exception 'invalid sex: %', p_sex;
  end if;
  if p_activity_level is not null and p_activity_level not in ('sedentary','light','moderate','active','very_active') then
    raise exception 'invalid activity_level: %', p_activity_level;
  end if;
  if p_units is not null and p_units not in ('imperial','metric') then
    raise exception 'invalid units: %', p_units;
  end if;

  update public.user_profiles
     set sex            = coalesce(p_sex,            sex),
         dob            = coalesce(p_dob,            dob),
         height_in      = coalesce(p_height_in,      height_in),
         activity_level = coalesce(p_activity_level, activity_level),
         units          = coalesce(p_units,          units),
         body_comp_profile_set_at = now(),
         updated_at     = now()
   where lower(email) = lower(p_email)
   returning * into result;

  if result is null then
    raise exception 'no user_profiles row for email %', p_email;
  end if;
  return result;
end $$;

grant execute on function public.update_body_comp_profile(text, text, date, numeric, text, text) to authenticated;

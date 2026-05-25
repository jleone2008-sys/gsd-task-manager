-- Phase 4 cleanup — drop the 12 columns that moved to user_preferences.
--
-- The user_profiles → user_preferences split (user_preferences.sql)
-- migrated these columns and kept them on user_profiles "for one release
-- as a fallback". The fallback window is closed; every client and Netlify
-- function reads/writes user_preferences exclusively (verified via
-- repo-wide audit of beta/src/*.js, src/*.js, netlify/functions/*.js).
--
-- Reversible: the original add-column migrations (body_comp_profile.sql,
-- user_profiles_timezone.sql, user_profiles_weather.sql) are still in the
-- migrations folder and can be re-applied to restore the column shape
-- (data lives on user_preferences regardless).
--
-- Pre-flight: abort if any user_profiles row still has data that isn't
-- mirrored to user_preferences. Skipped automatically if the columns are
-- already dropped (a re-run after the first successful application).
-- Built via EXECUTE so a missing column doesn't break the parser.

do $$
declare
  legacy_only int;
  cols_exist  boolean;
begin
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'user_profiles'
      and column_name = 'sex'
  ) into cols_exist;

  if not cols_exist then
    raise notice 'Pre-flight skipped — columns already dropped (migration is idempotent).';
    return;
  end if;

  execute $sql$
    select count(*)
      from public.user_profiles up
      where up.supabase_user_id is not null
        and (up.sex is not null or up.dob is not null or up.height_in is not null
          or up.activity_level is not null or up.timezone is not null
          or up.city is not null or up.weather_lat is not null)
        and not exists (
          select 1 from public.user_preferences pf
          where pf.user_id = up.supabase_user_id
        )
  $sql$ into legacy_only;

  if legacy_only > 0 then
    raise exception 'Backfill incomplete: % user_profiles rows have data not mirrored to user_preferences', legacy_only;
  end if;
end $$;

alter table public.user_profiles
  drop column if exists sex,
  drop column if exists dob,
  drop column if exists height_in,
  drop column if exists activity_level,
  drop column if exists activity_level_override,
  drop column if exists units,
  drop column if exists body_comp_profile_set_at,
  drop column if exists timezone,
  drop column if exists city,
  drop column if exists weather_lat,
  drop column if exists weather_lng,
  drop column if exists weather_label;

-- Phase 4 — body composition profile columns on user_profiles.
--
-- These five values feed the Mifflin-St Jeor BMR formula and the daily
-- calorie target math. The setup wizard collects them on first visit to
-- the Progress subtab; later edits flow through the same form.
--
-- activity_level_override = true means the user manually picked an
-- activity bucket; the server's "suggested from your sessions" auto-update
-- skips them until they explicitly re-confirm (or change back to "auto").
-- This is the only one of the five that has an auto-suggested path.
--
-- Weight is NOT stored here — it's always read from the most recent
-- progress_pics row to avoid drift between the profile snapshot and the
-- timeline. The dashboard's calorie card joins on that.

alter table public.user_profiles
  add column if not exists sex                       text check (sex in ('male','female')),
  add column if not exists dob                       date,
  add column if not exists height_in                 numeric,
  add column if not exists activity_level            text
    check (activity_level in ('sedentary','light','moderate','active','very_active')),
  add column if not exists activity_level_override   boolean default false,
  add column if not exists units                     text default 'imperial'
    check (units in ('imperial','metric')),
  add column if not exists body_comp_profile_set_at  timestamptz;

-- Units note: storage stays in canonical fields (height_in in inches,
-- progress_pics.weight_lbs in pounds, workout_sets.actual_weight in pounds,
-- cardio_distance in miles). The 'units' column only controls how those
-- canonical values are rendered + accepted in the UI. Conversion happens
-- at the form-field and display layer, never at the storage layer — so
-- toggling between imperial and metric never re-writes any historical row.

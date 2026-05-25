-- Invert the GSD mood / feel / energy scale to match convention.
--
-- BEFORE: 1=Great (best), 5=Bad (worst) — inverted from typical 5-star
-- rating semantics. LLMs trained on the standard convention misread
-- raw values (a feel=2 reads as "low" because they assume higher is
-- better), and the inversion is counter-intuitive to users.
--
-- AFTER: 1=Bad (worst), 5=Great (best) — matches every other 1-5
-- rating UX on earth.
--
-- The transform `new = 6 - old` preserves SEMANTIC meaning across all
-- existing rows: a row stored as mood=1 (Great) becomes mood=5 (Great
-- in the new scale). Lossless. The midpoint mood=3 (Okay) stays at 3.
--
-- Four tables carry this scale:
--   journal_entries.mood            smallint (1-5)
--   mood_checkins.mood              smallint (1-5)
--   workout_sessions.feel           smallint (1-5)
--   calendar_event_meta.energy_after smallint (1-5, with check constraint)
--
-- All NULL values stay NULL (the transform skips them via the WHERE
-- clause). The check constraint on calendar_event_meta still passes
-- (the new value is still in [1,5]).

update public.journal_entries
   set mood = 6 - mood
 where mood is not null;

update public.mood_checkins
   set mood = 6 - mood
 where mood is not null;

update public.workout_sessions
   set feel = 6 - feel
 where feel is not null;

update public.calendar_event_meta
   set energy_after = 6 - energy_after
 where energy_after is not null;

-- Report so the migration runner log shows the affected row counts.
do $$
declare
  c_journal  int; c_checkin int; c_session int; c_event   int;
begin
  select count(*) into c_journal from public.journal_entries where mood is not null;
  select count(*) into c_checkin from public.mood_checkins   where mood is not null;
  select count(*) into c_session from public.workout_sessions where feel is not null;
  select count(*) into c_event   from public.calendar_event_meta where energy_after is not null;
  raise notice 'Mood scale inverted. Rows touched: journal_entries=%, mood_checkins=%, workout_sessions=%, calendar_event_meta=%',
    c_journal, c_checkin, c_session, c_event;
end $$;

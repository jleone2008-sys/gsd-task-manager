-- One-off data seed: jleone2008@gmail.com's actual workout plan + recent
-- history, transcribed from the HCC screenshots dated Sun May 24 2026.
--
-- Scope: user_id = 'f39bcfbb-26db-4fd1-be93-7de58adfd2db' only.
-- Every INSERT in this file references that user_id explicitly; nothing
-- here touches any other user's rows. UPDATE is_active=false also filters
-- on the same user_id so no other user's active plan can be flipped.
--
-- Idempotency: re-running is destructive (would duplicate the plan + the
-- history). Run once. Confirm rows landed via the verification block at
-- the bottom; subsequent edits should be UPDATEs against the returned ids.
--
-- Plan shape (5-day mixed):
--   Mon  Cardio              (modality logged each session)
--   Tue  Full Body A         6 lifts
--   Wed  Cardio / Rest       optional cardio, default rest
--   Thu  Full Body B         6 lifts
--   Fri  Full Body C         6 lifts
--   Sat  Rest
--   Sun  Rest
--
-- Recent history transcribed: FBA Tue 5/19, FBB Thu 5/21, FBC Fri 5/22.
-- Each workout_set row carries the exact weight × reps from the
-- screenshots' "Last Session" column so the Today subtab will read
-- back the same numbers as the screenshots.

do $$
declare
  v_user_id      uuid := 'f39bcfbb-26db-4fd1-be93-7de58adfd2db';
  v_plan_id      uuid;
  v_session_fba  uuid;
  v_session_fbb  uuid;
  v_session_fbc  uuid;
begin
  -- Deactivate any prior active plan owned by this user (defensive — current
  -- state has none, but covers re-runs after a manual create).
  update public.workout_plans
     set is_active = false, updated_at = now()
   where user_id = v_user_id and is_active = true;

  -- ── Insert the plan ────────────────────────────────────────────────────
  insert into public.workout_plans (
    user_id, name, description, days_per_week, day_template,
    is_template, is_active, created_at, updated_at
  ) values (
    v_user_id,
    'My Plan',
    '5-day mixed: 3 full-body lifts (Tue/Thu/Fri) + 2 cardio days (Mon/Wed) + optional bonus any day. Transcribed from HCC screenshots.',
    5,
    $json$
    [
      {
        "dow": "Mon",
        "name": "Cardio",
        "type": "cardio",
        "exercises": [],
        "duration_min_default": 30,
        "modality_suggestions": ["LISS Walk/Jog","HIIT Sprints","Incline Walk","Steady Jog","Swimming","Desk Treadmill","Other"]
      },
      {
        "dow": "Tue",
        "name": "Full Body A",
        "type": "lift",
        "exercises": [
          {"name":"Squat (Smith/Goblet)","sets":4,"reps":"6-8","rest_s":150,"muscle_group":"Lower strength","target_text":"↑ 160+ lbs","target_kind":"up"},
          {"name":"Pull-ups","sets":4,"reps":"6-8","rest_s":120,"bodyweight":true,"muscle_group":"Back + posture","target_text":"↑ +15 all sets","target_kind":"up"},
          {"name":"DB Bench Press","sets":3,"reps":"8-10","rest_s":90,"muscle_group":"Chest","target_text":"Maxed — use Smith","target_kind":"warning"},
          {"name":"Face Pulls","sets":3,"reps":"15-20","rest_s":45,"muscle_group":"Posture · light squeeze","target_text":"Hold 80 lbs","target_kind":"hold"},
          {"name":"Barbell RDL","sets":3,"reps":"10-12","rest_s":90,"muscle_group":"Hamstrings","target_text":"↑ 185 next FBA","target_kind":"up"},
          {"name":"DB Curls","sets":2,"reps":"10-12","rest_s":60,"muscle_group":"Arms","target_text":"Hold 60 lbs","target_kind":"hold"}
        ]
      },
      {
        "dow": "Wed",
        "name": "Cardio / Rest",
        "type": "cardio",
        "exercises": [],
        "is_optional": true,
        "duration_min_default": 30,
        "modality_suggestions": ["LISS Walk/Jog","HIIT Sprints","Incline Walk","Steady Jog","Swimming","Desk Treadmill","Other"]
      },
      {
        "dow": "Thu",
        "name": "Full Body B",
        "type": "lift",
        "exercises": [
          {"name":"Bench Press (Smith)","sets":4,"reps":"6-8","rest_s":150,"muscle_group":"Chest strength","target_text":"170 across","target_kind":"hold"},
          {"name":"Overhead Press (DB)","sets":3,"reps":"8-10","rest_s":120,"muscle_group":"Shoulder strength","target_text":"↑ Start at 70","target_kind":"up"},
          {"name":"Deadlift","sets":3,"reps":"5-8","rest_s":180,"muscle_group":"Posterior chain · go heavy","target_text":"↑ 195-205 lbs","target_kind":"up"},
          {"name":"DB Rows","sets":3,"reps":"10-12","rest_s":90,"muscle_group":"Back · each arm","target_text":"60 all sets","target_kind":"hold"},
          {"name":"Seated Dips","sets":3,"reps":"8-12","rest_s":90,"bodyweight":true,"muscle_group":"Chest / triceps","target_text":"↑ Add weight","target_kind":"up"},
          {"name":"Tricep Pushdowns","sets":2,"reps":"12-15","rest_s":60,"muscle_group":"Arms","target_text":"Hold 80 lbs","target_kind":"hold"}
        ]
      },
      {
        "dow": "Fri",
        "name": "Full Body C",
        "type": "lift",
        "exercises": [
          {"name":"Bulgarian Split Squat (DB)","sets":3,"reps":"10-12","rest_s":90,"muscle_group":"Legs + balance","target_text":"Monitor knee","target_kind":"warning"},
          {"name":"Pull-ups","sets":3,"reps":"8-10","rest_s":120,"bodyweight":true,"muscle_group":"Back","target_text":"Mix +10 / BW","target_kind":"hold"},
          {"name":"Incline DB Press","sets":3,"reps":"10-12","rest_s":90,"muscle_group":"Upper chest","target_text":"↑ 110 combined","target_kind":"up"},
          {"name":"Barbell RDL","sets":3,"reps":"10-12","rest_s":90,"muscle_group":"Hamstrings","target_text":"↑ 155 next FBC","target_kind":"up"},
          {"name":"Face Pulls","sets":4,"reps":"15-20","rest_s":45,"muscle_group":"Posture priority","target_text":"Hold 80 lbs","target_kind":"hold"},
          {"name":"Overhead Press (DB)","sets":3,"reps":"10-12","rest_s":90,"muscle_group":"Shoulders","target_text":"↑ 70 combined","target_kind":"up"}
        ]
      },
      {"dow":"Sat","name":"Rest","type":"rest","exercises":[]},
      {"dow":"Sun","name":"Rest","type":"rest","exercises":[]}
    ]
    $json$::jsonb,
    false,   -- is_template
    true,    -- is_active
    now(),
    now()
  )
  returning id into v_plan_id;

  -- ── Insert the three most-recent lift sessions ────────────────────────
  -- Submitted ~6pm Central. Dates per the HCC screenshots (week of 5/18).
  insert into public.workout_sessions (
    user_id, plan_id, session_date, day_name, day_type, status,
    feel, started_at, submitted_at
  ) values (
    v_user_id, v_plan_id, '2026-05-19', 'Full Body A', 'lift', 'submitted',
    2, '2026-05-19 22:30:00+00', '2026-05-19 23:30:00+00'
  ) returning id into v_session_fba;

  insert into public.workout_sessions (
    user_id, plan_id, session_date, day_name, day_type, status,
    feel, started_at, submitted_at
  ) values (
    v_user_id, v_plan_id, '2026-05-21', 'Full Body B', 'lift', 'submitted',
    2, '2026-05-21 22:30:00+00', '2026-05-21 23:30:00+00'
  ) returning id into v_session_fbb;

  insert into public.workout_sessions (
    user_id, plan_id, session_date, day_name, day_type, status,
    feel, started_at, submitted_at
  ) values (
    v_user_id, v_plan_id, '2026-05-22', 'Full Body C', 'lift', 'submitted',
    2, '2026-05-22 22:30:00+00', '2026-05-22 23:30:00+00'
  ) returning id into v_session_fbc;

  -- ── Workout sets — FBA (Tue 5/19) ─────────────────────────────────────
  insert into public.workout_sets (session_id, user_id, exercise_name, set_index, target_reps, actual_reps, target_weight, actual_weight, is_bodyweight, completed_at) values
    (v_session_fba, v_user_id, 'Squat (Smith/Goblet)', 1, 8,  8, 160, 160, false, '2026-05-19 22:35:00+00'),
    (v_session_fba, v_user_id, 'Squat (Smith/Goblet)', 2, 8,  8, 160, 160, false, '2026-05-19 22:40:00+00'),
    (v_session_fba, v_user_id, 'Squat (Smith/Goblet)', 3, 8,  8, 160, 160, false, '2026-05-19 22:45:00+00'),
    (v_session_fba, v_user_id, 'Squat (Smith/Goblet)', 4, 8,  8, 160, 160, false, '2026-05-19 22:50:00+00'),
    (v_session_fba, v_user_id, 'Pull-ups',             1, 8, 10, null, null, true,  '2026-05-19 22:55:00+00'),
    (v_session_fba, v_user_id, 'Pull-ups',             2, 8, 10, null, null, true,  '2026-05-19 23:00:00+00'),
    (v_session_fba, v_user_id, 'Pull-ups',             3, 8, 10, null, null, true,  '2026-05-19 23:03:00+00'),
    (v_session_fba, v_user_id, 'Pull-ups',             4, 8, 10, null, null, true,  '2026-05-19 23:06:00+00'),
    (v_session_fba, v_user_id, 'DB Bench Press',       1, 10, 10, 105, 105, false, '2026-05-19 23:08:00+00'),
    (v_session_fba, v_user_id, 'DB Bench Press',       2, 10, 10, 105, 105, false, '2026-05-19 23:11:00+00'),
    (v_session_fba, v_user_id, 'DB Bench Press',       3, 10, 10, 105, 105, false, '2026-05-19 23:14:00+00'),
    (v_session_fba, v_user_id, 'Face Pulls',           1, 20, 20, 90,  90,  false, '2026-05-19 23:16:00+00'),
    (v_session_fba, v_user_id, 'Face Pulls',           2, 20, 20, 90,  90,  false, '2026-05-19 23:18:00+00'),
    (v_session_fba, v_user_id, 'Face Pulls',           3, 20, 20, 90,  90,  false, '2026-05-19 23:20:00+00'),
    (v_session_fba, v_user_id, 'Barbell RDL',          1, 12, 10, 155, 155, false, '2026-05-19 23:22:00+00'),
    (v_session_fba, v_user_id, 'Barbell RDL',          2, 12, 12, 155, 155, false, '2026-05-19 23:25:00+00'),
    -- set 3 skipped per the screenshot's empty row
    (v_session_fba, v_user_id, 'DB Curls',             1, 12, 10, 60,  60,  false, '2026-05-19 23:27:00+00'),
    (v_session_fba, v_user_id, 'DB Curls',             2, 12,  8, 60,  60,  false, '2026-05-19 23:29:00+00');

  -- ── Workout sets — FBB (Thu 5/21) ─────────────────────────────────────
  insert into public.workout_sets (session_id, user_id, exercise_name, set_index, target_reps, actual_reps, target_weight, actual_weight, is_bodyweight, completed_at) values
    (v_session_fbb, v_user_id, 'Bench Press (Smith)',  1, 8,  6, 170, 170, false, '2026-05-21 22:35:00+00'),
    (v_session_fbb, v_user_id, 'Bench Press (Smith)',  2, 8,  5, 170, 170, false, '2026-05-21 22:40:00+00'),
    (v_session_fbb, v_user_id, 'Bench Press (Smith)',  3, 8,  8, 170, 155, false, '2026-05-21 22:45:00+00'),
    (v_session_fbb, v_user_id, 'Bench Press (Smith)',  4, 8,  8, 170, 155, false, '2026-05-21 22:50:00+00'),
    (v_session_fbb, v_user_id, 'Overhead Press (DB)',  1, 10, 10, 70,  60,  false, '2026-05-21 22:55:00+00'),
    (v_session_fbb, v_user_id, 'Overhead Press (DB)',  2, 10, 12, 70,  70,  false, '2026-05-21 22:58:00+00'),
    (v_session_fbb, v_user_id, 'Overhead Press (DB)',  3, 10,  8, 70,  80,  false, '2026-05-21 23:01:00+00'),
    (v_session_fbb, v_user_id, 'Deadlift',             1, 8,  8, 195, 175, false, '2026-05-21 23:05:00+00'),
    (v_session_fbb, v_user_id, 'Deadlift',             2, 8,  8, 195, 175, false, '2026-05-21 23:09:00+00'),
    (v_session_fbb, v_user_id, 'Deadlift',             3, 8,  8, 195, 175, false, '2026-05-21 23:13:00+00'),
    (v_session_fbb, v_user_id, 'DB Rows',              1, 12, 10, 60,  60,  false, '2026-05-21 23:16:00+00'),
    (v_session_fbb, v_user_id, 'DB Rows',              2, 12, 10, 60,  60,  false, '2026-05-21 23:19:00+00'),
    (v_session_fbb, v_user_id, 'DB Rows',              3, 12, 10, 60,  60,  false, '2026-05-21 23:22:00+00'),
    (v_session_fbb, v_user_id, 'Seated Dips',          1, 12, 12, null, null, true, '2026-05-21 23:24:00+00'),
    (v_session_fbb, v_user_id, 'Seated Dips',          2, 12, 12, null, null, true, '2026-05-21 23:26:00+00'),
    (v_session_fbb, v_user_id, 'Seated Dips',          3, 12, 12, null, null, true, '2026-05-21 23:28:00+00'),
    (v_session_fbb, v_user_id, 'Tricep Pushdowns',     1, 15, 15, 80,  80,  false, '2026-05-21 23:30:00+00'),
    (v_session_fbb, v_user_id, 'Tricep Pushdowns',     2, 15, 15, 80,  80,  false, '2026-05-21 23:32:00+00');

  -- ── Workout sets — FBC (Fri 5/22) ─────────────────────────────────────
  insert into public.workout_sets (session_id, user_id, exercise_name, set_index, target_reps, actual_reps, target_weight, actual_weight, is_bodyweight, completed_at) values
    (v_session_fbc, v_user_id, 'Bulgarian Split Squat (DB)', 1, 12, 10, 50, 50, false, '2026-05-22 22:35:00+00'),
    (v_session_fbc, v_user_id, 'Bulgarian Split Squat (DB)', 2, 12, 10, 50, 50, false, '2026-05-22 22:38:00+00'),
    (v_session_fbc, v_user_id, 'Bulgarian Split Squat (DB)', 3, 12,  8, 50, 40, false, '2026-05-22 22:41:00+00'),
    -- Pull-ups: set 1 was +10 added weight, sets 2-3 pure BW
    (v_session_fbc, v_user_id, 'Pull-ups',                   1, 10, 8, null, 10,  false, '2026-05-22 22:45:00+00'),
    (v_session_fbc, v_user_id, 'Pull-ups',                   2, 10, 10, null, null, true,  '2026-05-22 22:48:00+00'),
    (v_session_fbc, v_user_id, 'Pull-ups',                   3, 10,  8, null, null, true,  '2026-05-22 22:51:00+00'),
    (v_session_fbc, v_user_id, 'Incline DB Press',           1, 12, 10, 100, 100, false, '2026-05-22 22:55:00+00'),
    (v_session_fbc, v_user_id, 'Incline DB Press',           2, 12, 10, 100, 100, false, '2026-05-22 22:58:00+00'),
    (v_session_fbc, v_user_id, 'Incline DB Press',           3, 12, 10, 100, 100, false, '2026-05-22 23:01:00+00'),
    (v_session_fbc, v_user_id, 'Barbell RDL',                1, 12, 12, 145, 145, false, '2026-05-22 23:05:00+00'),
    (v_session_fbc, v_user_id, 'Barbell RDL',                2, 12, 12, 145, 145, false, '2026-05-22 23:08:00+00'),
    (v_session_fbc, v_user_id, 'Barbell RDL',                3, 12, 12, 145, 145, false, '2026-05-22 23:11:00+00'),
    (v_session_fbc, v_user_id, 'Face Pulls',                 1, 20, 16, 80, 80, false, '2026-05-22 23:14:00+00'),
    (v_session_fbc, v_user_id, 'Face Pulls',                 2, 20, 15, 80, 80, false, '2026-05-22 23:16:00+00'),
    (v_session_fbc, v_user_id, 'Face Pulls',                 3, 20, 15, 80, 80, false, '2026-05-22 23:18:00+00'),
    (v_session_fbc, v_user_id, 'Face Pulls',                 4, 20, 16, 80, 80, false, '2026-05-22 23:20:00+00'),
    (v_session_fbc, v_user_id, 'Overhead Press (DB)',        1, 12, 10, 70, 60, false, '2026-05-22 23:23:00+00'),
    (v_session_fbc, v_user_id, 'Overhead Press (DB)',        2, 12, 10, 70, 60, false, '2026-05-22 23:25:00+00'),
    (v_session_fbc, v_user_id, 'Overhead Press (DB)',        3, 12, 12, 70, 60, false, '2026-05-22 23:28:00+00');

  raise notice 'jleone plan seeded: plan_id=% fba=% fbb=% fbc=%', v_plan_id, v_session_fba, v_session_fbb, v_session_fbc;
end $$;

-- Phase 4 — Seed the three starter workout templates.
-- Idempotent: deletes existing template rows before inserting so a re-run
-- updates them in place. User-owned forks are untouched.

delete from public.workout_plans where is_template = true and user_id is null;

-- ── Push / Pull / Legs (6-day) ───────────────────────────────────────────
insert into public.workout_plans (user_id, name, description, days_per_week, day_template, is_template)
values (
  null,
  'Push / Pull / Legs (6-day)',
  'Classic 6-day PPL split. Push A · Pull A · Legs A · Push B · Pull B · Legs B · Rest.',
  6,
  '[
    {"dow":"Mon","name":"Push A","type":"lift","exercises":[
      {"name":"Bench press","sets":4,"reps":"6-8","rest_s":180},
      {"name":"Overhead press","sets":3,"reps":"8-10","rest_s":150},
      {"name":"Incline DB press","sets":3,"reps":"10-12","rest_s":120},
      {"name":"Tricep pushdown","sets":3,"reps":"12-15","rest_s":90},
      {"name":"Lateral raises","sets":3,"reps":"12-15","rest_s":60}
    ]},
    {"dow":"Tue","name":"Pull A","type":"lift","exercises":[
      {"name":"Deadlift","sets":3,"reps":"5","rest_s":240},
      {"name":"Pull-ups","sets":3,"reps":"8-10","rest_s":150,"bodyweight":true},
      {"name":"Barbell row","sets":3,"reps":"8-10","rest_s":150},
      {"name":"Face pulls","sets":3,"reps":"15-20","rest_s":60},
      {"name":"Barbell curl","sets":3,"reps":"10-12","rest_s":90}
    ]},
    {"dow":"Wed","name":"Legs A","type":"lift","exercises":[
      {"name":"Back squat","sets":4,"reps":"6-8","rest_s":210},
      {"name":"Romanian deadlift","sets":3,"reps":"8-10","rest_s":150},
      {"name":"Leg press","sets":3,"reps":"10-12","rest_s":120},
      {"name":"Standing calf raise","sets":4,"reps":"12-15","rest_s":75},
      {"name":"Hanging leg raise","sets":3,"reps":"10-12","rest_s":60,"bodyweight":true}
    ]},
    {"dow":"Thu","name":"Push B","type":"lift","exercises":[
      {"name":"Overhead press","sets":4,"reps":"6-8","rest_s":180},
      {"name":"Incline bench","sets":3,"reps":"8-10","rest_s":150},
      {"name":"Dips","sets":3,"reps":"8-10","rest_s":120,"bodyweight":true},
      {"name":"DB lateral raise","sets":4,"reps":"12-15","rest_s":60},
      {"name":"Tricep overhead extension","sets":3,"reps":"10-12","rest_s":90}
    ]},
    {"dow":"Fri","name":"Pull B","type":"lift","exercises":[
      {"name":"Pendlay row","sets":4,"reps":"6-8","rest_s":180},
      {"name":"Lat pulldown","sets":3,"reps":"8-10","rest_s":120},
      {"name":"Cable row","sets":3,"reps":"10-12","rest_s":120},
      {"name":"Hammer curl","sets":3,"reps":"10-12","rest_s":75},
      {"name":"Face pulls","sets":3,"reps":"15-20","rest_s":60}
    ]},
    {"dow":"Sat","name":"Legs B","type":"lift","exercises":[
      {"name":"Front squat","sets":3,"reps":"6-8","rest_s":180},
      {"name":"Bulgarian split squat","sets":3,"reps":"10-12","rest_s":120},
      {"name":"Leg curl","sets":3,"reps":"10-12","rest_s":90},
      {"name":"Seated calf raise","sets":4,"reps":"15-20","rest_s":60},
      {"name":"Plank","sets":3,"reps":"45-60s","rest_s":60,"bodyweight":true}
    ]},
    {"dow":"Sun","name":"Rest","type":"rest","exercises":[]}
  ]'::jsonb,
  true
);

-- ── Upper / Lower (4-day) ────────────────────────────────────────────────
insert into public.workout_plans (user_id, name, description, days_per_week, day_template, is_template)
values (
  null,
  'Upper / Lower (4-day)',
  'Upper / Lower / Rest / Upper / Lower / Rest / Rest. Moderate volume, good recovery.',
  4,
  '[
    {"dow":"Mon","name":"Upper A","type":"lift","exercises":[
      {"name":"Bench press","sets":4,"reps":"6-8","rest_s":180},
      {"name":"Barbell row","sets":4,"reps":"6-8","rest_s":180},
      {"name":"Overhead press","sets":3,"reps":"8-10","rest_s":150},
      {"name":"Pull-ups","sets":3,"reps":"8-10","rest_s":120,"bodyweight":true},
      {"name":"Tricep pushdown","sets":3,"reps":"12-15","rest_s":75},
      {"name":"Barbell curl","sets":3,"reps":"10-12","rest_s":75}
    ]},
    {"dow":"Tue","name":"Lower A","type":"lift","exercises":[
      {"name":"Back squat","sets":4,"reps":"6-8","rest_s":210},
      {"name":"Romanian deadlift","sets":3,"reps":"8-10","rest_s":180},
      {"name":"Leg press","sets":3,"reps":"10-12","rest_s":120},
      {"name":"Leg curl","sets":3,"reps":"10-12","rest_s":90},
      {"name":"Standing calf raise","sets":4,"reps":"12-15","rest_s":60}
    ]},
    {"dow":"Wed","name":"Rest","type":"rest","exercises":[]},
    {"dow":"Thu","name":"Upper B","type":"lift","exercises":[
      {"name":"Incline bench","sets":4,"reps":"6-8","rest_s":180},
      {"name":"Pendlay row","sets":4,"reps":"6-8","rest_s":180},
      {"name":"DB shoulder press","sets":3,"reps":"8-10","rest_s":120},
      {"name":"Lat pulldown","sets":3,"reps":"10-12","rest_s":120},
      {"name":"Dips","sets":3,"reps":"8-10","rest_s":120,"bodyweight":true},
      {"name":"DB curl","sets":3,"reps":"10-12","rest_s":75}
    ]},
    {"dow":"Fri","name":"Lower B","type":"lift","exercises":[
      {"name":"Deadlift","sets":3,"reps":"5","rest_s":240},
      {"name":"Front squat","sets":3,"reps":"8-10","rest_s":180},
      {"name":"Bulgarian split squat","sets":3,"reps":"10-12","rest_s":120},
      {"name":"Seated calf raise","sets":4,"reps":"15-20","rest_s":60},
      {"name":"Hanging leg raise","sets":3,"reps":"10-12","rest_s":60,"bodyweight":true}
    ]},
    {"dow":"Sat","name":"Rest","type":"rest","exercises":[]},
    {"dow":"Sun","name":"Rest","type":"rest","exercises":[]}
  ]'::jsonb,
  true
);

-- ── Full Body (3-day) ────────────────────────────────────────────────────
insert into public.workout_plans (user_id, name, description, days_per_week, day_template, is_template)
values (
  null,
  'Full Body (3-day)',
  'Mon · Wed · Fri full-body. Low-friction default — good recovery, balanced.',
  3,
  '[
    {"dow":"Mon","name":"Full Body A","type":"lift","exercises":[
      {"name":"Back squat","sets":3,"reps":"6-8","rest_s":180},
      {"name":"Bench press","sets":3,"reps":"6-8","rest_s":180},
      {"name":"Barbell row","sets":3,"reps":"8-10","rest_s":150},
      {"name":"Overhead press","sets":2,"reps":"8-10","rest_s":120},
      {"name":"Romanian deadlift","sets":2,"reps":"10-12","rest_s":120}
    ]},
    {"dow":"Tue","name":"Rest","type":"rest","exercises":[]},
    {"dow":"Wed","name":"Full Body B","type":"lift","exercises":[
      {"name":"Deadlift","sets":3,"reps":"5","rest_s":240},
      {"name":"Incline bench","sets":3,"reps":"8-10","rest_s":150},
      {"name":"Pull-ups","sets":3,"reps":"8-10","rest_s":120,"bodyweight":true},
      {"name":"Leg press","sets":2,"reps":"10-12","rest_s":120},
      {"name":"DB lateral raise","sets":3,"reps":"12-15","rest_s":60}
    ]},
    {"dow":"Thu","name":"Rest","type":"rest","exercises":[]},
    {"dow":"Fri","name":"Full Body C","type":"lift","exercises":[
      {"name":"Front squat","sets":3,"reps":"6-8","rest_s":180},
      {"name":"DB bench press","sets":3,"reps":"8-10","rest_s":150},
      {"name":"Pendlay row","sets":3,"reps":"6-8","rest_s":150},
      {"name":"Bulgarian split squat","sets":2,"reps":"10-12","rest_s":120},
      {"name":"Standing calf raise","sets":3,"reps":"12-15","rest_s":60}
    ]},
    {"dow":"Sat","name":"Rest","type":"rest","exercises":[]},
    {"dow":"Sun","name":"Rest","type":"rest","exercises":[]}
  ]'::jsonb,
  true
);

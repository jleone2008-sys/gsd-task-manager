/* ════════════════════════════════════════════════════════════════════
   DEV MOCK-MODE FIXTURES  —  deterministic fake data (no real anything)

   Loaded only in non-production builds (see scripts/inject-dev-mode.mjs)
   and only activates behind the ?mock gate in mock-mode.js. This file just
   defines window.GSD_FIXTURES; it has no side effects and contacts nothing.

   Shapes here mirror the real Supabase row columns the app reads (verified
   against the row→model mappers in src/02-tasks-sync.js, src/03-habits-core.js,
   src/06-notes.js, beta/src/05-brief.js, beta/src/04-home.js, beta/src/06-train.js).
   Unknown tables resolve to [] in the stub, so missing fixtures degrade to
   empty states rather than breaking.
════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const DAY = 86400000;
  // Local YYYY-MM-DD for a given Date (matches briefYesterdayLocal's tz intent).
  function ymd(d) {
    const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return z.toISOString().slice(0, 10);
  }
  const now = Date.now();
  const today = ymd(new Date(now));
  const yesterday = ymd(new Date(now - DAY));
  const daysAgo = (n) => ymd(new Date(now - n * DAY));
  const iso = (msAgo) => new Date(now - msAgo).toISOString();

  const USER_ID = 'mock-user-0000-0000-000000000000';
  const EMAIL = 'dev@gsdtasks.local';

  const user = {
    id: USER_ID,
    email: EMAIL,
    user_metadata: { full_name: 'Dev Tester', name: 'Dev Tester', avatar_url: null },
    app_metadata: { provider: 'mock' },
  };

  const session = {
    access_token: 'mock-access-token',
    refresh_token: 'mock-refresh-token',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor((now + 3600 * 1000) / 1000),
    user,
  };

  const VALID_TABS = ['home', 'tasks', 'habits', 'notes', 'journal', 'train'];

  /* ── Tasks ──────────────────────────────────────────────── */
  let pk = 1;
  const tasks = [
    { id: pk++, client_id: 101, user_id: USER_ID, text: 'Ship the mock-mode dev tool', note: 'Real UI, fake data, no login.', tags: ['dev'], top3: true,  someday: false, done: false, status: 'todo', due: yesterday, order: 0, completed_at: null, created_at: iso(3 * DAY), recur: null, spawned: false },
    { id: pk++, client_id: 102, user_id: USER_ID, text: 'Review the daily brief layout', note: '', tags: ['design'], top3: true, someday: false, done: false, status: 'todo', due: today, order: 1, completed_at: null, created_at: iso(2 * DAY), recur: null, spawned: false },
    { id: pk++, client_id: 103, user_id: USER_ID, text: 'Water the plants', note: '', tags: ['home'], top3: false, someday: false, done: false, status: 'todo', due: today, order: 2, completed_at: null, created_at: iso(1 * DAY), recur: null, spawned: false },
    { id: pk++, client_id: 104, user_id: USER_ID, text: 'Plan weekend hike', note: 'Check the weather first.', tags: ['fun'], top3: false, someday: false, done: false, status: 'todo', due: null, order: 3, completed_at: null, created_at: iso(12 * 3600 * 1000), recur: null, spawned: false },
    { id: pk++, client_id: 105, user_id: USER_ID, text: 'Read a chapter of that book', note: '', tags: [], top3: false, someday: true,  done: false, status: 'todo', due: null, order: 4, completed_at: null, created_at: iso(6 * 3600 * 1000), recur: null, spawned: false },
    { id: pk++, client_id: 106, user_id: USER_ID, text: 'Morning stretch', note: '', tags: ['health'], top3: false, someday: false, done: true, status: 'done', due: today, order: 5, completed_at: iso(2 * 3600 * 1000), created_at: iso(1 * DAY), recur: null, spawned: false },
  ];

  const task_subtasks = [
    { id: pk++, client_id: 'st-1', user_id: USER_ID, task_client_id: '101', text: 'Build the Supabase stub', done: true,  position: 0 },
    { id: pk++, client_id: 'st-2', user_id: USER_ID, task_client_id: '101', text: 'Wire fetch interception', done: false, position: 1 },
    { id: pk++, client_id: 'st-3', user_id: USER_ID, task_client_id: '101', text: 'Author fixtures', done: false, position: 2 },
  ];

  /* ── Habits ─────────────────────────────────────────────── */
  let hpk = 500;
  const habits = [
    { id: hpk++, client_id: 201, user_id: USER_ID, name: 'Drink water',    emoji: '💧', frequency: 'daily', frequency_count: 0, custom_days: [], tags: ['health'], archived: false, order: 0, allow_extras: false, library_kind: null },
    { id: hpk++, client_id: 202, user_id: USER_ID, name: 'Meditate',       emoji: '🧘', frequency: 'daily', frequency_count: 0, custom_days: [], tags: ['mind'],   archived: false, order: 1, allow_extras: false, library_kind: null },
    { id: hpk++, client_id: 203, user_id: USER_ID, name: 'Read',           emoji: '📖', frequency: 'daily', frequency_count: 0, custom_days: [], tags: ['mind'],   archived: false, order: 2, allow_extras: false, library_kind: null },
    { id: hpk++, client_id: 204, user_id: USER_ID, name: 'Workout',        emoji: '🏋️', frequency: 'weekly', frequency_count: 4, custom_days: [], tags: ['health'], archived: false, order: 3, allow_extras: true,  library_kind: null },
    { id: hpk++, client_id: 205, user_id: USER_ID, name: 'No phone in bed', emoji: '🌙', frequency: 'daily', frequency_count: 0, custom_days: [], tags: ['sleep'],  archived: false, order: 4, allow_extras: false, library_kind: null },
  ];
  // Completions across the last 7 days for the heatmap. Map by habit PK.
  const habit_completions = [];
  let cpk = 900;
  // deterministic pattern: each habit hits most days
  const patterns = [
    [0, 1, 2, 3, 4, 6],     // water
    [0, 2, 3, 5],           // meditate
    [1, 2, 4],              // read
    [0, 3, 6],              // workout
    [0, 1, 2, 3, 4, 5, 6],  // no phone
  ];
  habits.forEach((h, hi) => {
    patterns[hi].forEach((d) => {
      habit_completions.push({ id: cpk++, user_id: USER_ID, habit_id: h.id, completed_date: daysAgo(d) });
    });
  });

  /* ── Notes ──────────────────────────────────────────────── */
  const notebooks = [
    { id: 700, client_id: 301, user_id: USER_ID, name: 'Work',     color: '#5b82e0', order: 0, icon: '💼' },
    { id: 701, client_id: 302, user_id: USER_ID, name: 'Personal', color: '#7a8a59', order: 1, icon: '🏡' },
  ];
  const notes = [
    { id: 710, client_id: -1,  user_id: USER_ID, title: '', content: 'Quick scratch space — jot anything here.', notebook_id: null, tags: [], starred: false, trashed: false, trashed_at: null, order: 0, created_at: iso(5 * DAY), updated_at: iso(2 * 3600 * 1000) },
    { id: 711, client_id: 311, user_id: USER_ID, title: 'Project ideas', content: 'A roundup of things to build next quarter.', notebook_id: 301, tags: ['ideas'], starred: true, trashed: false, trashed_at: null, order: 1, created_at: iso(4 * DAY), updated_at: iso(1 * DAY) },
    { id: 712, client_id: 312, user_id: USER_ID, title: 'Grocery list', content: 'Eggs, oats, spinach, coffee.', notebook_id: 302, tags: [], starred: false, trashed: false, trashed_at: null, order: 2, created_at: iso(2 * DAY), updated_at: iso(8 * 3600 * 1000) },
  ];

  /* ── Journal ────────────────────────────────────────────── */
  const journal_entries = [
    { id: 800, user_id: USER_ID, entry_date: yesterday, mood: 4, reflection: 'Productive day. Got the hard thing started.', learning: 'Small steps beat big plans.', created_at: iso(1 * DAY), updated_at: iso(1 * DAY) },
    { id: 801, user_id: USER_ID, entry_date: daysAgo(2), mood: 3, reflection: 'A bit scattered but fine.', learning: '', created_at: iso(2 * DAY), updated_at: iso(2 * DAY) },
  ];
  const mood_checkins = [
    { id: 810, user_id: USER_ID, checkin_at: iso(3 * 3600 * 1000), mood: 4, note: 'Good morning energy' },
  ];

  /* ── Health (Oura) ──────────────────────────────────────── */
  const oura_daily = [];
  for (let i = 0; i < 14; i++) {
    const wob = (base, amp) => Math.round(base + amp * Math.sin(i * 1.1));
    oura_daily.push({
      id: 1000 + i, user_id: USER_ID, date: daysAgo(i),
      sleep_score: wob(82, 8), readiness_score: wob(78, 10), activity_score: wob(74, 12),
    });
  }
  const whoop_daily = [];
  for (let i = 0; i < 14; i++) {
    const wob = (base, amp) => Math.round(base + amp * Math.cos(i * 0.9));
    whoop_daily.push({
      id: 1100 + i, user_id: USER_ID, date: daysAgo(i),
      recovery_score: wob(68, 14), strain: +(10 + 4 * Math.sin(i * 0.7)).toFixed(1), sleep_performance: wob(80, 9),
    });
  }
  const weather_daily = [
    { id: 1200, user_id: USER_ID, date: today,        temp_high_f: 74, temp_low_f: 58, condition: 'Partly cloudy', icon: 'partly-cloudy' },
    { id: 1201, user_id: USER_ID, date: daysAgo(-1),  temp_high_f: 71, temp_low_f: 55, condition: 'Sunny',         icon: 'sunny' },
  ];

  /* ── Daily brief (structured) ───────────────────────────── */
  function briefRow(mode) {
    const isMorning = mode === 'morning';
    const structured = {
      mode,
      headline: isMorning ? 'Protect your deep work' : 'Wind down a little earlier',
      subhead: isMorning
        ? 'Front-load the hard task before noon while focus is high. Your calendar is clear until the 2pm block, so the morning is your deep-work window.'
        : 'Close the two open tasks, then aim for a 10:30 lights-out. Today stayed light and your habits held, so an early night sets tomorrow up well.',
      insight: isMorning
        ? 'Mornings after a clear-calendar block have tended to be your most productive lately — guard this one.'
        : 'Tonight echoes the evenings where an earlier wind-down has paid off for your recovery.',
      weather_chip: isMorning ? '74° · Austin' : null,
      confidence: 'high',
      // Single hero kept for backward-compat (old cached briefs); `rotation`
      // drives the auto-cycling state circle when present.
      hero_metric: { key: 'readiness_score', label: 'READINESS', value: 78, delta_vs_7d: 3 },
      rotation: [
        { key: 'readiness_score', label: 'READINESS', value: 78, delta_vs_7d: 3 },
        { key: 'sleep_score',     label: 'SLEEP',     value: 82, delta_vs_7d: 4 },
        { key: 'activity_score',  label: 'ACTIVITY',  value: 74, delta_vs_7d: -2 },
      ],
      // Scores now live in the circle; stats show Sleep DURATION + Resting HR + HRV.
      stats: [
        { label: 'Sleep',      value: '7h 40m', delta: '↑22m', delta_dir: 'good' },
        { label: 'Resting HR', value: '52 bpm', delta: '↓2',   delta_dir: 'good' },
        { label: 'HRV',        value: '68 ms',  delta: '↑5',   delta_dir: 'good' },
      ],
      evidence_pills: isMorning
        ? [{ text: 'HRV steady', tone: 'neutral' }, { text: 'Slept 7h40m', tone: 'positive' }, { text: 'Overdue tasks', tone: 'negative' }]
        : [{ text: 'On track', tone: 'positive' }, { text: '3/5 habits', tone: 'neutral' }],
      recap: isMorning
        ? {
            left:  { label: 'Yesterday', habits: { pct: 80, done: 4, due: 5 }, steps: 8432, tasks_done: 3, bedtime: '10:45 PM', mood_label: 'Good' },
            right: { label: 'Today', events: 2, task_counts: { priority: 2, due_today: 2, overdue: 1, total_open: 5 }, sleep_target: '10:30 PM', train: { label: 'Push day', detail: '5 lifts' } },
          }
        : {
            left:  { label: 'Today', habits: { pct: 60, done: 3, due: 5 }, steps: 5210, tasks_done: 1, mood_label: 'Good' },
            right: { label: 'Tomorrow', events: 1, task_counts: { priority: 1, due_today: 0, overdue: 0, total_open: 4 }, sleep_target: '10:30 PM', train: { label: 'Rest', detail: '' } },
          },
    };
    return {
      id: mode === 'morning' ? 1300 : 1301,
      user_id: USER_ID,
      brief_date: yesterday, // homeBriefLoad queries briefYesterdayLocal()
      mode,
      structured,
      tldr: structured.subhead,
      narrative: null,
      confidence: 'high',
      status: 'ready',
      fallback_reason: null,
      model: 'mock',
      generated_at: iso(2 * 3600 * 1000),
    };
  }
  const daily_briefs = [briefRow('morning'), briefRow('evening')];

  /* ── Train ──────────────────────────────────────────────── */
  const dayTemplate = [
    { dow: 'Mon', name: 'Push', type: 'lift', exercises: [
      { name: 'Bench press', sets: 4, reps: '6-8', rest_s: 120 },
      { name: 'Overhead press', sets: 3, reps: '8-10', rest_s: 90 },
      { name: 'Incline dumbbell press', sets: 3, reps: '10', rest_s: 90 },
      { name: 'Lateral raise', sets: 3, reps: '12-15', rest_s: 60 },
      { name: 'Triceps pushdown', sets: 3, reps: '12', rest_s: 60 },
    ] },
    { dow: 'Tue', name: 'Pull', type: 'lift', exercises: [
      { name: 'Deadlift', sets: 3, reps: '5', rest_s: 180 },
      { name: 'Pull-up', sets: 3, reps: '8', rest_s: 90, bodyweight: true },
      { name: 'Barbell row', sets: 3, reps: '8-10', rest_s: 90 },
      { name: 'Face pull', sets: 3, reps: '15', rest_s: 60 },
      { name: 'Barbell curl', sets: 3, reps: '10-12', rest_s: 60 },
    ] },
    { dow: 'Wed', name: 'Legs', type: 'lift', exercises: [
      { name: 'Back squat', sets: 4, reps: '6-8', rest_s: 150 },
      { name: 'Romanian deadlift', sets: 3, reps: '8-10', rest_s: 120 },
      { name: 'Leg press', sets: 3, reps: '12', rest_s: 90 },
      { name: 'Calf raise', sets: 4, reps: '15', rest_s: 45 },
    ] },
    { dow: 'Thu', name: 'Cardio', type: 'cardio', exercises: [] },
    { dow: 'Fri', name: 'Push', type: 'lift', exercises: [
      { name: 'Incline bench press', sets: 4, reps: '8', rest_s: 120 },
      { name: 'Dumbbell shoulder press', sets: 3, reps: '10', rest_s: 90 },
      { name: 'Cable fly', sets: 3, reps: '12-15', rest_s: 60 },
    ] },
    { dow: 'Sat', name: 'Pull', type: 'lift', exercises: [
      { name: 'Lat pulldown', sets: 4, reps: '10', rest_s: 90 },
      { name: 'Seated cable row', sets: 3, reps: '10-12', rest_s: 90 },
      { name: 'Hammer curl', sets: 3, reps: '12', rest_s: 60 },
    ] },
    { dow: 'Sun', name: 'Rest', type: 'rest', exercises: [] },
  ];
  const workout_plans = [
    { id: 1400, user_id: USER_ID, name: 'PPL 6-day', description: 'Push / Pull / Legs split.', days_per_week: 6, day_template: dayTemplate, is_template: false, is_active: true, forked_from: 9001, created_at: iso(30 * DAY), last_plan_tune_at: null, last_plan_tune_id: null },
    { id: 9001, user_id: null, name: 'PPL 6-day (template)', description: 'Classic push/pull/legs.', days_per_week: 6, day_template: dayTemplate, is_template: true, is_active: false, forked_from: null, created_at: iso(120 * DAY), last_plan_tune_at: null, last_plan_tune_id: null },
  ];
  const workout_sessions = [
    { id: 1500, user_id: USER_ID, plan_id: 1400, session_date: daysAgo(1), day_name: 'Push', dow: 'Mon', feel: 'good', notes: '', ai_feedback: { summary: 'Strong session — bench moved well.', focus: ['Add a back-off set on OHP'] }, created_at: iso(1 * DAY) },
    { id: 1501, user_id: USER_ID, plan_id: 1400, session_date: daysAgo(3), day_name: 'Legs', dow: 'Wed', feel: 'ok', notes: '', ai_feedback: null, created_at: iso(3 * DAY) },
    { id: 1502, user_id: USER_ID, plan_id: 1400, session_date: daysAgo(8), day_name: 'Push', dow: 'Mon', feel: 'good', notes: '', ai_feedback: null, created_at: iso(8 * DAY) },
  ];
  // Real schema fields: actual_weight / actual_reps / is_bodyweight / completed_at.
  // Most-recent Push session (1500) seeds the progression engine; the older Push
  // session (1502) provides prior-session context for stall detection.
  const st = (id, sid, name, idx, w, reps, t, bw, rir) => ({ id, user_id: USER_ID, session_id: sid, exercise_name: name, set_index: idx, actual_weight: w, actual_reps: reps, is_bodyweight: !!bw, completed_at: iso(t), rir: rir != null ? rir : null });
  const workout_sets = [
    // Push — most recent (1 day ago). RIR stamped on each exercise's last set.
    st(1600, 1500, 'Bench press',            0, 185, 8, 1 * DAY),
    st(1601, 1500, 'Bench press',            1, 185, 8, 1 * DAY),
    st(1602, 1500, 'Bench press',            2, 185, 8, 1 * DAY, false, 2),   // hit top, RIR 2 → ↑190
    st(1603, 1500, 'Overhead press',         0, 95, 9, 1 * DAY),
    st(1604, 1500, 'Overhead press',         1, 95, 9, 1 * DAY),
    st(1605, 1500, 'Overhead press',         2, 95, 8, 1 * DAY, false, 1),    // in range, not top
    st(1606, 1500, 'Incline dumbbell press', 0, 60, 10, 1 * DAY),
    st(1607, 1500, 'Incline dumbbell press', 1, 60, 10, 1 * DAY),
    st(1608, 1500, 'Incline dumbbell press', 2, 60, 10, 1 * DAY, false, 0),   // hit 10 but RIR 0 (grind) → autoreg holds
    st(1609, 1500, 'Triceps pushdown',       0, 50, 12, 1 * DAY),
    st(1610, 1500, 'Triceps pushdown',       1, 50, 12, 1 * DAY),
    st(1611, 1500, 'Triceps pushdown',       2, 50, 12, 1 * DAY, false, 3),   // cable, hit 12, fresh → ↑60
    // Push — prior (8 days ago), Bench only — for stall-detection context
    st(1620, 1502, 'Bench press',            0, 185, 7, 8 * DAY),
    st(1621, 1502, 'Bench press',            1, 185, 6, 8 * DAY),
  ];
  const body_comp_profile = [
    { id: 1700, user_id: USER_ID, weight_lb: 178, body_fat_pct: 16.5, measured_at: daysAgo(2) },
    { id: 1701, user_id: USER_ID, weight_lb: 179, body_fat_pct: 16.8, measured_at: daysAgo(9) },
  ];
  const body_comp_goals = [
    { id: 1710, user_id: USER_ID, kind: 'weight', start_date: daysAgo(40), end_date: daysAgo(-44), start_value: 182, target_value: 175, is_active: true, created_at: iso(40 * DAY) },
  ];
  const progress_pics = [];
  // Weight timeline — decoupled from progress_pics. Descending by measured_date.
  const body_weight = [
    { id: 1720, user_id: USER_ID, measured_date: today,       weight_lbs: 178.2, source: 'manual' },
    { id: 1721, user_id: USER_ID, measured_date: daysAgo(1),  weight_lbs: 178.6, source: 'manual' },
    { id: 1722, user_id: USER_ID, measured_date: daysAgo(2),  weight_lbs: 178.9, source: 'manual' },
    { id: 1723, user_id: USER_ID, measured_date: daysAgo(4),  weight_lbs: 179.4, source: 'manual' },
    { id: 1724, user_id: USER_ID, measured_date: daysAgo(7),  weight_lbs: 180.1, source: 'manual' },
    { id: 1725, user_id: USER_ID, measured_date: daysAgo(14), weight_lbs: 181.0, source: 'progress_pic' },
  ];

  /* ── Insights ───────────────────────────────────────────── */
  const weekly_briefs = [
    { id: 1800, user_id: USER_ID, week_start_date: daysAgo(7), generated_at: iso(2 * DAY), model: 'claude-opus-4-7', status: 'ready', confidence: 'medium', total_iterations: 7, patterns_discovered_ids: [1801],
      structured: { headline: 'A steadier week.', subhead: 'Sleep and readiness moved together — earlier bedtimes paid off.', sections: [ { label: 'What worked', body: 'Earlier bedtimes lined up with your best readiness mornings.' }, { label: 'Watch', body: 'Two late nights mid-week dented HRV the next day.' } ] },
      narrative: 'Sleep was steadier this week; readiness tracked your earlier bedtimes.', created_at: iso(2 * DAY) },
  ];
  const patterns_discovered = [
    { id: 1810, user_id: USER_ID, pattern: 'Higher activity days follow nights with 8h+ sleep.', strength: 0.62, dismissed: false, created_at: iso(2 * DAY) },
  ];
  const knowledge_documents = [
    { id: 1820, user_id: USER_ID, title: 'Bloodwork — Spring panel.pdf', kind: 'lab_results', status: 'ready', created_at: iso(20 * DAY) },
  ];
  const chat_messages = [];

  /* ── Identity / settings ────────────────────────────────── */
  const user_profiles = [
    { id: 1, email: EMAIL, supabase_user_id: USER_ID, access_status: 'active', role: 'standard', status: 'active', tab_permissions: VALID_TABS.slice(), calendar_backfilled_at: iso(10 * DAY) },
  ];
  const user_preferences = [
    { user_id: USER_ID, timezone: 'America/Chicago', weather_lat: 30.27, weather_lng: -97.74, weather_city: 'Austin',
      sex: 'male', dob: '1990-05-12', height_in: 70, activity_level: 'moderate', activity_level_override: false, units: 'imperial', body_comp_profile_set_at: iso(60 * DAY) },
  ];
  const user_settings = [
    { user_id: USER_ID, integrations: { oura: { connected: true }, whoop: { connected: false }, dropbox: { connected: false }, health_source: 'oura' } },
  ];
  const linked_google_accounts = [];
  const google_calendars_synced = [];
  const journal_calendar_cache = [
    { id: 1900, user_id: USER_ID, event_date: today, events: [
      { id: 'evt-1', summary: 'Team standup', start: today + 'T15:00:00Z', end: today + 'T15:15:00Z' },
      { id: 'evt-2', summary: 'Design review',  start: today + 'T18:00:00Z', end: today + 'T19:00:00Z' },
    ] },
  ];
  const sleep_intents = [];
  const calendar_event_meta = [];
  const brief_action_outcomes = [];
  const workout_plan_tunes = [];

  window.GSD_FIXTURES = {
    user,
    session,
    tables: {
      tasks,
      task_subtasks,
      habits,
      habit_completions,
      notes,
      notebooks,
      journal_entries,
      mood_checkins,
      oura_daily,
      whoop_daily,
      weather_daily,
      daily_briefs,
      workout_plans,
      workout_sessions,
      workout_sets,
      body_comp_profile,
      body_comp_goals,
      progress_pics,
      body_weight,
      weekly_briefs,
      patterns_discovered,
      knowledge_documents,
      chat_messages,
      user_profiles,
      user_preferences,
      user_settings,
      linked_google_accounts,
      google_calendars_synced,
      journal_calendar_cache,
      sleep_intents,
      calendar_event_meta,
      brief_action_outcomes,
      workout_plan_tunes,
    },
  };
})();

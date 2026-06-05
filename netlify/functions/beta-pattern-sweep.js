// Deterministic pattern sweep — Phase 2 of docs/formulaic-first-and-brief-insights.md.
//
// Formulaic-first: a CODE statistics pass (no AI) that systematically tests
// signal-pairs over the last 60 days, gates by n/|r|/p IN CODE, and upserts
// clean templated patterns into patterns_discovered (source='sweep', deduped by
// a stable sweep_key). Complements the AI weekly synthesis — it doesn't replace
// it, and it never lets an LLM decide what to test or surface.
//
// Auth: X-Internal-Auth (cron, body {user_id, user_email}) OR a user JWT (manual
// trigger). Reads are service-role.

const { SUPABASE_URL, serviceHeaders } = require('./lib/supabase');
const { json, cors, preflight }        = require('./lib/http');
const { validateBearer }               = require('./lib/auth');
const { sweep }                        = require('./lib/pattern-sweep');

const WINDOW_DAYS = 60;
const GATE = { minN: 12, minR: 0.4, maxP: 0.01, windowDays: WINDOW_DAYS };

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST')    return cors(json(405, { error: 'method_not_allowed' }));

  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!serviceKey) return cors(json(500, { error: 'server_misconfigured' }));

  // ── Auth: internal (cron) or user JWT ──
  let userId, userEmail;
  const got = event.headers['x-internal-auth'] || event.headers['X-Internal-Auth'] || '';
  if (got) {
    const expected = process.env.INTERNAL_FN_SECRET || '';
    if (!expected || got !== expected) return cors(json(403, { error: 'forbidden' }));
    const body = event.body ? JSON.parse(event.body) : {};
    userId = body.user_id; userEmail = body.user_email;
    if (!userId || !userEmail) return cors(json(400, { error: 'cron_requires_user_id_and_user_email' }));
  } else {
    const auth = await validateBearer(event, serviceKey);
    if (auth.error) return cors(json(auth.status, { error: auth.error }));
    userId = auth.userId; userEmail = auth.email;
  }

  try {
    return cors(json(200, await runSweep(userId, userEmail, serviceKey)));
  } catch (e) {
    console.error('beta-pattern-sweep error:', e.message);
    return cors(json(500, { error: 'sweep_failed', detail: e.message }));
  }
};

async function fetchJson(url, headers) {
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`fetch ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
function shiftDate(ymd, d) { const dt = new Date(ymd + 'T12:00:00Z'); dt.setUTCDate(dt.getUTCDate() + d); return dt.toISOString().slice(0, 10); }

const OURA_COLS = {
  hrv: 'hrv_ms', rhr: 'resting_hr', sleep_score: 'sleep_score', sleep_dur: 'total_sleep_min',
  deep_sleep: 'deep_sleep_min', readiness: 'readiness_score', activity: 'activity_score',
  steps: 'steps', body_temp: 'body_temp_deviation_c', stress: 'stress_high_seconds',
};

async function runSweep(userId, userEmail, serviceKey) {
  const hdr = serviceHeaders(serviceKey);
  const today = new Date().toISOString().slice(0, 10);
  const since = shiftDate(today, -WINDOW_DAYS);
  const enc = encodeURIComponent;

  const [oura, journals, habits, workouts, weights, calendars] = await Promise.all([
    fetchJson(`${SUPABASE_URL}/rest/v1/oura_daily?user_email=eq.${enc(userEmail)}&date=gte.${since}&select=date,${Object.values(OURA_COLS).join(',')}`, hdr),
    fetchJson(`${SUPABASE_URL}/rest/v1/journal_entries?user_id=eq.${userId}&entry_date=gte.${since}&select=entry_date,mood`, hdr),
    fetchJson(`${SUPABASE_URL}/rest/v1/habit_completions?user_id=eq.${userId}&completed_date=gte.${since}&select=completed_date`, hdr),
    fetchJson(`${SUPABASE_URL}/rest/v1/workout_sessions?user_id=eq.${userId}&session_date=gte.${since}&select=session_date`, hdr),
    fetchJson(`${SUPABASE_URL}/rest/v1/body_weight?user_id=eq.${userId}&measured_date=gte.${since}&select=measured_date,weight_lbs`, hdr),
    fetchJson(`${SUPABASE_URL}/rest/v1/journal_calendar_cache?user_id=eq.${userId}&entry_date=gte.${since}&select=entry_date,events`, hdr),
  ]);

  // Build per-signal date→value maps. Continuous signals are sparse (value or
  // absent); binary/count signals are filled across the window (0 = genuinely
  // none that day).
  const series = {};
  const set = (k, date, v) => {
    if (v == null || !Number.isFinite(Number(v))) return;
    (series[k] || (series[k] = new Map())).set(date, Number(v));
  };
  for (const row of oura) for (const [k, col] of Object.entries(OURA_COLS)) set(k, row.date, row[col]);
  for (const row of journals) set('mood', row.entry_date, row.mood);
  for (const row of weights)  set('weight', row.measured_date, row.weight_lbs);

  const dateList = [];
  for (let d = since; d <= today; d = shiftDate(d, 1)) dateList.push(d);
  const habitCount = {}; for (const r of habits) habitCount[r.completed_date] = (habitCount[r.completed_date] || 0) + 1;
  const workoutDays = new Set(workouts.map(w => w.session_date));
  const calCount = {}; for (const r of calendars) calCount[r.entry_date] = Array.isArray(r.events) ? r.events.length : 0;
  series.habits_done = new Map();
  series.workout     = new Map();
  series.cal_load    = new Map();
  for (const d of dateList) {
    series.habits_done.set(d, habitCount[d] || 0);
    series.workout.set(d, workoutDays.has(d) ? 1 : 0);
    if (calCount[d] != null) series.cal_load.set(d, calCount[d]);
  }

  const found = sweep(series, GATE);

  // Upsert, deduped by metadata.sweep_key among this user's source='sweep' rows.
  // A dismissed sweep pattern is left alone (respect the user's dismissal).
  // Fetch the user's patterns and filter to source='sweep' in code (avoids a
  // jsonb filter in the PostgREST URL). Keyed by sweep_key for dedupe.
  const existing = await fetchJson(
    `${SUPABASE_URL}/rest/v1/patterns_discovered?user_id=eq.${userId}&select=id,metadata,dismissed_by_user`, hdr);
  const byKey = new Map();
  for (const e of existing) {
    const meta = e.metadata || {};
    if (meta.source === 'sweep' && meta.sweep_key) byKey.set(meta.sweep_key, e);
  }

  let inserted = 0, updated = 0, skipped = 0;
  for (const p of found) {
    const ex = byKey.get(p.sweep_key);
    if (ex && ex.dismissed_by_user) { skipped++; continue; }
    const row = {
      user_id:         userId,
      label:           p.label,
      description:     `${p.brief_line} (r=${p.r} over ${p.n} days)`,
      evidence_window: { start_date: since, end_date: today, n_days: p.n },
      n:               p.n,
      strength_score:  p.strength,
      last_seen_at:    new Date().toISOString(),
      metadata: {
        source: 'sweep', sweep_key: p.sweep_key,
        signal_a: p.signal_a, signal_b: p.signal_b, lag: p.lag, direction: p.direction,
        r: p.r, p: p.p, actionable: p.actionable, brief_line: p.brief_line,
      },
    };
    if (ex) {
      await fetch(`${SUPABASE_URL}/rest/v1/patterns_discovered?id=eq.${ex.id}`, { method: 'PATCH', headers: hdr, body: JSON.stringify(row) });
      updated++;
    } else {
      await fetch(`${SUPABASE_URL}/rest/v1/patterns_discovered`, { method: 'POST', headers: hdr, body: JSON.stringify({ ...row, first_seen_at: new Date().toISOString() }) });
      inserted++;
    }
  }

  return {
    window_days: WINDOW_DAYS, found: found.length, inserted, updated, skipped,
    patterns: found.map(p => ({ key: p.sweep_key, r: p.r, n: p.n, actionable: p.actionable, line: p.brief_line })),
  };
}

// User-facing + cron-callable endpoint that generates and stores the daily
// brief at the top of the Home tab. Phase 1.7 — structured "coach brief":
// returns a typed object the UI renders block by block (header strip,
// weather chip, verb-first headline, subhead, hero ring + stats list,
// evidence pills, Today's Play or Tomorrow's Setup). Two modes per local day:
// morning (04:00-16:00) and evening (16:00-04:00).
//
// Endpoints:
//   GET  ?date=YYYY-MM-DD&mode=morning|evening  → fetch existing row or 404
//   POST {force?, date?, mode?, user_email?, user_id?}
//        Client (JWT):  derives user from /auth/v1/user; mode auto-detected
//                       from user-local hour if not provided.
//        Cron (X-Internal-Auth + INTERNAL_FN_SECRET): passes user_email +
//                       user_id directly; should always pass mode='morning'.
//
// Storage: writes via the service key (bypasses RLS). `structured` jsonb
// column holds the full coach-brief payload; `narrative` is a flattened
// rendering kept for back-compat with legacy clients. UNIQUE constraint:
// (user_id, brief_date, mode) — one row per mode per day.
//
// Defenses (server-side, after Claude response):
//   - Truncate headline (≤30) + subhead (≤80) + evidence_pills word count
//   - Strip greeting prefixes from headline ("Your Saturday Brief.")
//   - Banned-phrase scan across all prose fields → fallback on hit
//   - Validate hero_metric.key against allowed enum; substitute hint on miss

const SUPABASE_URL    = 'https://dmuwncwptvnnlizuxhta.supabase.co';
const ANTHROPIC_URL   = 'https://api.anthropic.com/v1/messages';
const OPEN_METEO_URL  = 'https://api.open-meteo.com/v1/forecast';

const { recommendSleepTarget } = require('./lib/recommendations');
const { MOOD_LABELS, MOOD_SCALE_NOTE, moodLabel } = require('./lib/mood-scale');

// Phase 1.6 banned statistics jargon + Phase 1.7 banned recap filler.
// If any of these surface in headline/subhead/pills/play content, the
// response is rejected and the deterministic fallback is stored instead.
const BANNED_PROSE_REGEX = new RegExp([
  '\\bp\\d{2}\\b',
  '\\bpercentile\\b',
  '\\bmedian\\b',
  '\\bIQR\\b',
  '\\bmilliseconds\\b',
  '\\b\\d+\\s?ms\\b',
  '\\bworth noting\\b',
  '\\bfun evening\\b',
  '\\bthe week\\\'s been rich\\b',
  '\\bactually land\\b',
  '\\bno weather to report\\b',
  '\\byour body\\\'s still\\b',
].join('|'), 'i');

// Greeting prefixes Claude tends to inject into the headline despite the
// system prompt forbidding them. Stripped server-side as belt-and-suspenders.
const GREETING_PREFIX_REGEX = /^(Your\s+\w+\s+Brief\.?\s*|Good\s+(morning|afternoon|evening)\.?\s*|Brief:\s*)/i;

// Defaults — overridable via env vars.
const DEFAULT_MODEL       = 'claude-opus-4-7';
const DEFAULT_MAX_TOKENS  = 1500;
const DEFAULT_TIMEZONE    = 'America/New_York';

// Freshness window for Oura: if today's recovery row is missing OR was last
// fetched >24h ago, the brief is flagged 'preliminary' and the UI shows a
// "still syncing — tap to retry" affordance.
const OURA_STALE_HOURS = 24;

// MOOD_LABELS / MOOD_SCALE_NOTE / moodLabel are imported from
// ./lib/mood-scale.js so every Netlify function that surfaces mood to
// Claude uses the same shared mapping. See that file for the scale
// convention (1=Bad ... 5=Great after the invert_mood_scale migration).

// Hero ring options. Server picks a hint by largest |today - 7d median|;
// Claude can override but only within this enum.
const HERO_METRIC_KEYS = ['sleep_score', 'readiness_score', 'activity_score'];
const HERO_METRIC_LABELS = {
  sleep_score:     'SLEEP',
  readiness_score: 'READINESS',
  activity_score:  'ACTIVITY',
};

// Allowed play icons (also the enum for the tool schema)
const PLAY_ICONS = ['walk', 'tasks', 'habits', 'sleep', 'work', 'meal', 'other'];

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return cors({ statusCode: 204, body: '' });

  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  const anthropic  = process.env.ANTHROPIC_API_KEY;
  if (!serviceKey) return cors(json(500, { error: 'server_misconfigured', detail: 'SUPABASE_SERVICE_KEY' }));

  // ── Authenticate ────────────────────────────────────────────────────────
  let user;
  try {
    if (event.headers['x-internal-auth'] || event.headers['X-Internal-Auth']) {
      const expected = process.env.INTERNAL_FN_SECRET || '';
      const got      = event.headers['x-internal-auth'] || event.headers['X-Internal-Auth'] || '';
      if (!expected || got !== expected) return cors(json(403, { error: 'forbidden' }));
      const body = event.body ? JSON.parse(event.body) : {};
      if (!body.user_email || !body.user_id) {
        return cors(json(400, { error: 'cron_path_requires_user_email_and_user_id' }));
      }
      user = await resolveUser({ email: body.user_email, user_id: body.user_id }, serviceKey);
    } else {
      const bearer = (event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '').trim();
      if (!bearer) return cors(json(401, { error: 'missing_token' }));
      const ur = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { apikey: serviceKey, Authorization: `Bearer ${bearer}` },
      });
      if (!ur.ok) return cors(json(401, { error: 'invalid_token' }));
      const u = await ur.json();
      user = await resolveUser({ email: u.email, user_id: u.id }, serviceKey);
    }
  } catch (err) {
    console.error('daily-brief auth error:', err.message);
    return cors(json(401, { error: 'auth_failed', detail: err.message }));
  }

  try {
    // ── GET: read existing brief for a specific date + mode ───────────────
    if (event.httpMethod === 'GET') {
      const date = event.queryStringParameters?.date || yesterdayLocal(user.timezone);
      const mode = normalizeMode(event.queryStringParameters?.mode, user.timezone);
      const brief = await fetchBrief(user.user_id, date, mode, serviceKey);
      if (!brief) return cors(json(404, { error: 'not_found', brief_date: date, mode }));
      return cors(json(200, brief));
    }

    if (event.httpMethod !== 'POST') return cors(json(405, { error: 'method_not_allowed' }));

    // ── POST: generate (or regenerate) ────────────────────────────────────
    const body  = event.body ? JSON.parse(event.body) : {};
    const force = !!body.force;
    const date  = body.date || yesterdayLocal(user.timezone);
    const mode  = normalizeMode(body.mode, user.timezone);

    // Idempotency: existing row (same date + mode) wins unless force=true
    if (!force) {
      const existing = await fetchBrief(user.user_id, date, mode, serviceKey);
      if (existing) return cors(json(200, { ...existing, _from_cache: true }));
    }

    if (!anthropic) {
      const fallback = buildFallback({ reason: 'no_anthropic_key', mode });
      const stored   = await storeBrief(user, date, mode, fallback, serviceKey);
      return cors(json(200, stored));
    }

    const ctx = await buildContext(user, date, mode, serviceKey);

    let result;
    try {
      result = await callClaude(ctx, mode, anthropic);
    } catch (err) {
      console.error('daily-brief claude call failed:', err.message);
      result = buildFallback({ reason: `claude_error: ${err.message}`, context: ctx, mode });
    }

    if (ctx._oura_stale && result.status === 'ok') {
      result.status = 'preliminary';
      result.fallback_reason = 'oura_data_stale_at_generation';
    }

    const stored = await storeBrief(user, date, mode, result, serviceKey);
    // Phase 7 — mark pending anomaly alerts consumed by THIS brief.
    // Reads from the ctx we built earlier; alerts that influenced this
    // generation won't repeat in the next brief. Best-effort — a
    // failure here doesn't fail the whole brief response.
    if (Array.isArray(ctx.pending_anomalies) && ctx.pending_anomalies.length && stored?.id) {
      const alertIds = ctx.pending_anomalies.map(a => a.id).filter(Boolean);
      consumeAnomalyAlerts(alertIds, stored.id, serviceKey)
        .catch(err => console.warn('[daily-brief] consume anomalies failed:', err.message));
    }
    return cors(json(200, stored));
  } catch (err) {
    console.error('daily-brief handler error:', err.message);
    return cors(json(500, { error: 'internal_error', detail: err.message }));
  }
};

// Mark anomaly alerts as consumed by a brief. PostgREST in.(ids) filter
// with PATCH. The alerts won't reappear in future briefs.
async function consumeAnomalyAlerts(alertIds, briefId, serviceKey) {
  if (!Array.isArray(alertIds) || alertIds.length === 0) return;
  const ids = alertIds.map(id => `"${id}"`).join(',');
  const url = `${SUPABASE_URL}/rest/v1/pending_anomaly_alerts?id=in.(${ids})`;
  const r = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type':  'application/json',
      apikey:          serviceKey,
      Authorization:   `Bearer ${serviceKey}`,
      Prefer:          'return=minimal',
    },
    body: JSON.stringify({
      consumed_at: new Date().toISOString(),
      consumed_by: briefId,
    }),
  });
  if (!r.ok) throw new Error(`consume_anomalies_${r.status}: ${(await r.text()).slice(0, 200)}`);
}

// ── Mode + helper resolution ───────────────────────────────────────────────
function normalizeMode(input, tz) {
  if (input === 'morning' || input === 'evening') return input;
  return computeMode(tz);
}
function computeMode(tz) {
  const h = hourInTz(new Date(), tz || DEFAULT_TIMEZONE);
  return (h >= 4 && h < 16) ? 'morning' : 'evening';
}
function hourInTz(date, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false });
  const h = parseInt(fmt.format(date), 10);
  return Number.isFinite(h) ? (h === 24 ? 0 : h) : 0;
}

// Largest absolute deviation from 7-day median tells us which ring to feature.
// Returns the metric key (sleep_score | readiness_score | activity_score) or
// null if not enough data to decide.
function computeHeroHint(ouraToday, ouraYesterday, baselines7d) {
  if (!baselines7d) return null;
  const candidates = [
    { key: 'sleep_score',     today: ouraToday?.sleep_score,     baseline: baselines7d.sleep_score_median },
    { key: 'readiness_score', today: ouraToday?.readiness_score, baseline: baselines7d.readiness_score_median },
    { key: 'activity_score',  today: ouraYesterday?.activity_score, baseline: baselines7d.activity_score_median },
  ];
  let best = null;
  for (const c of candidates) {
    if (c.today == null || c.baseline == null) continue;
    const dev = Math.abs(Number(c.today) - Number(c.baseline));
    if (!best || dev > best.dev) best = { key: c.key, dev };
  }
  return best?.key || null;
}

// ── User resolution ────────────────────────────────────────────────────────
// Identity (email, supabase_user_id) lives on user_profiles.
// Preferences (timezone, city, weather coords/label) live on
// user_preferences after the table split. Two short queries — one per
// table — and we merge the result.
async function resolveUser({ email, user_id }, serviceKey) {
  const profSel = 'supabase_user_id,email';
  const profUrl = email
    ? `${SUPABASE_URL}/rest/v1/user_profiles?email=eq.${encodeURIComponent(email)}&select=${profSel}`
    : `${SUPABASE_URL}/rest/v1/user_profiles?supabase_user_id=eq.${user_id}&select=${profSel}`;
  const profRes = await fetch(profUrl, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
  if (!profRes.ok) {
    const text = await profRes.text();
    throw new Error(`user_profile_lookup_failed: HTTP ${profRes.status} ${text.slice(0, 200)}`);
  }
  const profRows = await profRes.json();
  if (!Array.isArray(profRows)) {
    throw new Error(`user_profile_lookup_unexpected: ${JSON.stringify(profRows).slice(0, 200)}`);
  }
  const profile = profRows[0];
  if (!profile) throw new Error(`user_profile_not_found_for_${email || user_id}`);
  const resolvedUserId = profile.supabase_user_id || user_id;

  // user_preferences lookup. Missing row (e.g. brand-new user) → no
  // preferences yet; we fall back to DEFAULT_TIMEZONE + null weather.
  let prefs = null;
  if (resolvedUserId) {
    const prefRes = await fetch(
      `${SUPABASE_URL}/rest/v1/user_preferences?user_id=eq.${resolvedUserId}&select=timezone,city,weather_lat,weather_lng,weather_label`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
    );
    if (prefRes.ok) {
      const prefRows = await prefRes.json();
      prefs = Array.isArray(prefRows) ? prefRows[0] || null : null;
    } else {
      // Non-fatal — log and continue with defaults so a transient
      // preferences-lookup hiccup doesn't kill the brief.
      console.warn(`user_preferences_lookup_failed: ${prefRes.status}`);
    }
  }

  return {
    email:         profile.email,
    user_id:       resolvedUserId,
    timezone:      prefs?.timezone || DEFAULT_TIMEZONE,
    weather_lat:   prefs?.weather_lat   ?? null,
    weather_lng:   prefs?.weather_lng   ?? null,
    weather_label: prefs?.weather_label || prefs?.city || null,
  };
}

// ── Read existing brief ────────────────────────────────────────────────────
async function fetchBrief(user_id, brief_date, mode, serviceKey) {
  const url = `${SUPABASE_URL}/rest/v1/daily_briefs`
    + `?user_id=eq.${user_id}&brief_date=eq.${brief_date}&mode=eq.${mode}`
    + `&select=id,brief_date,generated_at,model,mode,structured,tldr,narrative,highlights,actions,confidence,status,fallback_reason`;
  const r = await fetch(url, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
  const rows = await r.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

// ── Context packager ───────────────────────────────────────────────────────
async function buildContext(user, brief_date, mode, serviceKey) {
  const yday     = brief_date;
  const today    = shiftDate(brief_date, +1);
  const tomorrow = shiftDate(brief_date, +2);   // for evening "tomorrow's setup"
  const win7     = shiftDate(yday, -6);
  const hdr      = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };

  const ouraRecoveryCols = [
    'date','sleep_score','readiness_score','total_sleep_min','hrv_ms',
    'resting_hr','sleep_efficiency_pct','sleep_midpoint_offset_min','updated_at',
  ].join(',');
  const ouraActivityCols = [
    'date','activity_score','steps','active_calories','stress_high_seconds',
    'stress_day_summary','body_temp_deviation_c','resilience_level','updated_at',
  ].join(',');

  // Train context: active workout plan + the last 14 days of sessions
  // with their sets. workout_sets.session_id is a real FK so the
  // embedded-resource join below works in one round-trip.
  const trainSince = (() => {
    const d = new Date(today + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - 14);
    return d.toISOString().slice(0, 10);
  })();

  // Phase 6 Layer 1 — pull recent lab results so the brief can frame
  // recommendations against actual current bloodwork values. 90-day
  // window keeps stale labs out automatically; dedupe to latest per
  // test_name happens client-side after the fetch.
  const labSince = (() => {
    const d = new Date(today + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - 90);
    return d.toISOString().slice(0, 10);
  })();

  const [
    ouraToday, ouraYesterday, whoopY, oTagsY, oWorkoutsY, journalY, tasksAll,
    calY, calT, habitsY, baselines30, baselines7, tasksTopOpen, tasksOpen,
    activePlanRows, recentSessions, recentLabs, pendingAnomalies,
  ] = await Promise.all([
    fetchJson(`${SUPABASE_URL}/rest/v1/oura_daily?user_email=eq.${encodeURIComponent(user.email)}&date=eq.${today}&select=${ouraRecoveryCols}`, hdr),
    fetchJson(`${SUPABASE_URL}/rest/v1/oura_daily?user_email=eq.${encodeURIComponent(user.email)}&date=eq.${yday}&select=${ouraActivityCols}`, hdr),
    fetchJson(`${SUPABASE_URL}/rest/v1/whoop_daily?user_email=eq.${encodeURIComponent(user.email)}&date=eq.${yday}&select=date,recovery_score,hrv_ms,resting_hr,strain,sleep_duration_min,sleep_performance,updated_at`, hdr),
    fetchJson(`${SUPABASE_URL}/rest/v1/oura_tags?user_email=eq.${encodeURIComponent(user.email)}&start_day=eq.${yday}&select=tag_type_code,custom_name,start_time`, hdr),
    fetchJson(`${SUPABASE_URL}/rest/v1/oura_workouts?user_email=eq.${encodeURIComponent(user.email)}&day=eq.${yday}&select=activity,duration_min,intensity,load,average_hr,calories`, hdr),
    fetchJson(`${SUPABASE_URL}/rest/v1/journal_entries?user_id=eq.${user.user_id}&entry_date=eq.${yday}&select=mood,reflections`, hdr),
    fetchJson(`${SUPABASE_URL}/rest/v1/tasks?user_id=eq.${user.user_id}&done=eq.true&select=text,completed_at&order=completed_at.desc&limit=30`, hdr),
    fetchJson(`${SUPABASE_URL}/rest/v1/journal_calendar_cache?user_id=eq.${user.user_id}&entry_date=eq.${yday}&select=events`, hdr),
    fetchJson(`${SUPABASE_URL}/rest/v1/journal_calendar_cache?user_id=eq.${user.user_id}&entry_date=eq.${today}&select=events`, hdr),
    fetchJson(`${SUPABASE_URL}/rest/v1/journal_habit_summary?user_id=eq.${user.user_id}&entry_date=eq.${yday}&select=due_count,done_count`, hdr),
    fetchJson(`${SUPABASE_URL}/rest/v1/v_user_baselines_30d?user_id=eq.${user.user_id}&select=*`, hdr),
    fetchJson(`${SUPABASE_URL}/rest/v1/v_user_baselines_7d?user_id=eq.${user.user_id}&select=*`, hdr),
    fetchJson(`${SUPABASE_URL}/rest/v1/tasks?user_id=eq.${user.user_id}&done=eq.false&top3=eq.true&select=text&limit=5`, hdr),
    fetchJson(`${SUPABASE_URL}/rest/v1/tasks?user_id=eq.${user.user_id}&done=eq.false&select=text,top3,due&limit=200`, hdr),
    fetchJson(`${SUPABASE_URL}/rest/v1/workout_plans?user_id=eq.${user.user_id}&is_active=eq.true&is_template=eq.false&select=id,name,day_template&limit=1`, hdr),
    fetchJson(`${SUPABASE_URL}/rest/v1/workout_sessions?user_id=eq.${user.user_id}&session_date=gte.${trainSince}&select=id,session_date,day_name,day_type,feel,session_notes,workout_sets(exercise_name,set_index,actual_weight,actual_reps,is_bodyweight)&order=session_date.desc`, hdr),
    fetchJson(`${SUPABASE_URL}/rest/v1/health_lab_results?user_id=eq.${user.user_id}&test_date=gte.${labSince}&select=test_name,value,unit,ref_range_low,ref_range_high,ref_range_text,flag,test_date&order=test_date.desc`, hdr),
    // Phase 7 — pending anomaly alerts. SQL trigger on oura_daily
    // wrote these when metrics deviated >2σ from 30-day baseline.
    // Brief leads with them in subhead/pills, then marks them consumed.
    fetchJson(`${SUPABASE_URL}/rest/v1/pending_anomaly_alerts?user_id=eq.${user.user_id}&consumed_at=is.null&order=detected_at.desc&limit=10&select=id,for_date,metric,value,baseline_value,z_score,direction`, hdr),
  ]);

  // Evening mode needs tomorrow's calendar + today's data for the recap row
  // (today's mood, today's workouts, today's completed-task count).
  const [calTomorrow, journalToday, ouraWorkoutsToday] = (mode === 'evening') ? await Promise.all([
    fetchJson(`${SUPABASE_URL}/rest/v1/journal_calendar_cache?user_id=eq.${user.user_id}&entry_date=eq.${tomorrow}&select=events`, hdr),
    fetchJson(`${SUPABASE_URL}/rest/v1/journal_entries?user_id=eq.${user.user_id}&entry_date=eq.${today}&select=mood`, hdr),
    fetchJson(`${SUPABASE_URL}/rest/v1/oura_workouts?user_email=eq.${encodeURIComponent(user.email)}&day=eq.${today}&select=activity,duration_min,intensity`, hdr),
  ]) : [[], [], []];

  const [oura7, journal7, habits7, tags7] = await Promise.all([
    fetchJson(`${SUPABASE_URL}/rest/v1/oura_daily?user_email=eq.${encodeURIComponent(user.email)}&date=gte.${win7}&date=lte.${yday}&select=date,sleep_score,readiness_score,activity_score,total_sleep_min,hrv_ms&order=date.asc`, hdr),
    fetchJson(`${SUPABASE_URL}/rest/v1/journal_entries?user_id=eq.${user.user_id}&entry_date=gte.${win7}&entry_date=lte.${yday}&select=entry_date,mood&order=entry_date.asc`, hdr),
    fetchJson(`${SUPABASE_URL}/rest/v1/journal_habit_summary?user_id=eq.${user.user_id}&entry_date=gte.${win7}&entry_date=lte.${yday}&select=entry_date,due_count,done_count&order=entry_date.asc`, hdr),
    fetchJson(`${SUPABASE_URL}/rest/v1/oura_tags?user_email=eq.${encodeURIComponent(user.email)}&start_day=gte.${win7}&start_day=lte.${yday}&select=tag_type_code,start_day`, hdr),
  ]);

  // Morning brief shows today's weather; evening brief shows tomorrow's
  // forecast (the chip in evening mode is prefixed "Tmrw" so it can't be
  // mistaken for current weather).
  const hasLocation = (user.weather_lat != null && user.weather_lng != null);
  const weather = (mode === 'morning' && hasLocation)
    ? await fetchWeather(user.weather_lat, user.weather_lng, today, user.timezone, user.weather_label)
    : null;
  const weatherTomorrow = (mode === 'evening' && hasLocation)
    ? await fetchWeather(user.weather_lat, user.weather_lng, tomorrow, user.timezone, user.weather_label)
    : null;

  // Filter completed tasks to yesterday in user-local TZ
  const yStart = localDayStartUtcMs(yday, user.timezone);
  const yEnd   = yStart + 86400_000;
  const tasksYesterday = (tasksAll || []).filter(t => t.completed_at && t.completed_at >= yStart && t.completed_at < yEnd);

  // Oura freshness
  const recoveryRow = ouraToday?.[0] || null;
  const activityRow = ouraYesterday?.[0] || null;
  const ouraStale = !recoveryRow
    || !recoveryRow.updated_at
    || (Date.now() - new Date(recoveryRow.updated_at).getTime()) > OURA_STALE_HOURS * 3600_000;

  // Tag rollup
  const tagCounts = {};
  for (const t of (tags7 || [])) {
    const k = t.tag_type_code || 'unknown';
    tagCounts[k] = (tagCounts[k] || 0) + 1;
  }

  const reflection = (journalY?.[0]?.reflections || '').slice(0, 500);

  // Mood labels
  const yMood = journalY?.[0]?.mood ?? null;
  const moodWeek = (journal7 || []).map(d => ({
    entry_date: d.entry_date, mood_label: moodLabel(d.mood),
  })).filter(d => d.mood_label != null);

  // Strip percentile fields from both baselines (no p25/p75 → no jargon parroting)
  const baseline30 = stripPercentiles(baselines30?.[0]);
  const baseline7  = stripPercentiles(baselines7?.[0]);

  // Hero hint
  const hero_hint = computeHeroHint(recoveryRow, activityRow, baselines7?.[0]);

  const weekdayName = weekdayInTz(today, user.timezone);

  // ── Train context ───────────────────────────────────────────────────
  // Map weekdayInTz's "Monday" output to the 3-letter codes the
  // workout_plans.day_template uses ("Mon"). Same for tomorrow.
  const DOW3 = { Monday:'Mon', Tuesday:'Tue', Wednesday:'Wed', Thursday:'Thu', Friday:'Fri', Saturday:'Sat', Sunday:'Sun' };
  const activePlan = activePlanRows?.[0] || null;
  const dayForDow = (plan, dow3) => {
    if (!plan || !Array.isArray(plan.day_template)) return null;
    return plan.day_template.find(d => d.dow === dow3) || null;
  };
  const summarizeSession = (s) => {
    if (!s) return null;
    const sets = Array.isArray(s.workout_sets) ? s.workout_sets : [];
    // Group by exercise → top weight × reps + volume.
    const byEx = {};
    for (const x of sets) {
      const k = x.exercise_name || 'Exercise';
      if (!byEx[k]) byEx[k] = { name: k, sets: 0, top_weight: 0, top_reps: 0, volume: 0 };
      byEx[k].sets += 1;
      const w = Number(x.actual_weight) || 0;
      const r = Number(x.actual_reps)   || 0;
      if (w > byEx[k].top_weight) byEx[k].top_weight = w;
      if (r > byEx[k].top_reps)   byEx[k].top_reps   = r;
      if (!x.is_bodyweight) byEx[k].volume += w * r;
    }
    const exercises = Object.values(byEx);
    const totalVolume = exercises.reduce((sum, e) => sum + e.volume, 0);
    return {
      session_date: s.session_date,
      day_name:     s.day_name,
      day_type:     s.day_type,
      feel:         s.feel,
      feel_label:   moodLabel(s.feel),   // explicit label per lib/mood-scale convention
      total_sets:   sets.length,
      total_volume: totalVolume,
      exercises:    exercises.slice(0, 8),   // cap for token budget
    };
  };
  const todayDow3    = DOW3[weekdayName] || null;
  const tomorrowDow3 = DOW3[weekdayInTz(tomorrow, user.timezone)] || null;
  const yesterdayDow3 = DOW3[weekdayInTz(yday, user.timezone)] || null;
  // Today's prescribed session (from the active plan's day_template).
  const workoutTodayPlanned = dayForDow(activePlan, todayDow3);
  // Today's already-logged session (if user logged something earlier today
  // — possible in evening mode or a Same-day cron re-fire).
  const workoutTodayLogged  = (recentSessions || []).find(s => s.session_date === today) || null;
  // Yesterday's logged session.
  const workoutYesterday    = (recentSessions || []).find(s => s.session_date === yday) || null;
  // Last session matching today's planned day_name — for "last time you
  // did Full Body A you hit 215×8" comparisons.
  const workoutSameDayName  = workoutTodayPlanned?.name
    ? (recentSessions || []).find(s => s.day_name === workoutTodayPlanned.name && s.session_date < today) || null
    : null;
  // Tomorrow's prescribed (evening mode).
  const workoutTomorrowPlanned = dayForDow(activePlan, tomorrowDow3);

  const ctx = {
    user: { timezone: user.timezone },
    scales: { mood: MOOD_SCALE_NOTE },
    mode,
    brief_date: brief_date,
    yesterday: {
      recovery: recoveryRow ? {
        as_of_date: today, source: 'last_night_sleep',
        ...stripUpdatedAt(recoveryRow),
        oura_updated_at: recoveryRow.updated_at,
      } : null,
      activity: activityRow ? {
        as_of_date: yday, source: 'yesterday_day',
        ...stripUpdatedAt(activityRow),
        oura_updated_at: activityRow.updated_at,
      } : null,
      whoop: whoopY?.[0] ? stripUpdatedAt(whoopY[0]) : null,
      tags: (oTagsY || []).map(t => ({ kind: t.tag_type_code, name: t.custom_name, at: t.start_time })),
      workouts: oWorkoutsY || [],
      mood: yMood == null ? null : { value_label: moodLabel(yMood) },
      reflection: reflection || null,
      tasks_completed_count: tasksYesterday.length,
      tasks_completed_sample: tasksYesterday.slice(0, 10).map(t => t.text).filter(Boolean),
      calendar_events: ((calY?.[0]?.events) || []).slice(0, 8).map(e => ({
        summary: e.summary, start: e.start, allDay: !!e.isAllDay,
      })),
      habits: habitsY?.[0] ? { due: habitsY[0].due_count, done: habitsY[0].done_count } : null,
      // Train session logged for yesterday (if any). Summary only — full
      // set list is in train_recent for token-budget reasons.
      workout: summarizeSession(workoutYesterday),
    },
    today_plan: {
      date: today,
      weekday: weekdayName,
      weather: weather,
      calendar_events: ((calT?.[0]?.events) || []).slice(0, 8).map(e => ({
        summary: e.summary, start: e.start, allDay: !!e.isAllDay,
      })),
      priority_tasks: (tasksTopOpen || []).map(t => ({ text: t.text })),
      task_counts: computeTaskCounts(tasksOpen, today),
      // Today's training context. `planned` = what the active plan
      // prescribes for today's DOW. `last_same_day` = the user's most
      // recent prior session matching that day_name, so Claude can
      // reference last week's lifts. `logged_today` is non-null when a
      // session is already in the books (evening mode or same-day refire).
      workout: {
        has_active_plan: !!activePlan,
        plan_name:       activePlan?.name || null,
        planned:         workoutTodayPlanned ? {
          dow:           workoutTodayPlanned.dow,
          name:          workoutTodayPlanned.name,
          type:          workoutTodayPlanned.type,
          exercises:     Array.isArray(workoutTodayPlanned.exercises)
            ? workoutTodayPlanned.exercises.slice(0, 8).map(ex => ({
                name: ex.name, sets: ex.sets, reps: ex.reps, bodyweight: !!ex.bodyweight,
              }))
            : [],
        } : null,
        last_same_day:   summarizeSession(workoutSameDayName),
        logged_today:    summarizeSession(workoutTodayLogged),
      },
    },
    tomorrow_plan: (mode === 'evening') ? {
      date: tomorrow,
      weekday: weekdayInTz(tomorrow, user.timezone),
      weather: weatherTomorrow,
      calendar_events: ((calTomorrow?.[0]?.events) || []).slice(0, 8).map(e => ({
        summary: e.summary, start: e.start, allDay: !!e.isAllDay,
      })),
      // Priority tasks carry forward (top3 open = persistent until done)
      priority_tasks: (tasksTopOpen || []).map(t => ({ text: t.text })),
      task_counts: computeTaskCounts(tasksOpen, tomorrow),
      workout: workoutTomorrowPlanned ? {
        dow:       workoutTomorrowPlanned.dow,
        name:      workoutTomorrowPlanned.name,
        type:      workoutTomorrowPlanned.type,
        exercises: Array.isArray(workoutTomorrowPlanned.exercises)
          ? workoutTomorrowPlanned.exercises.slice(0, 8).map(ex => ({
              name: ex.name, sets: ex.sets, reps: ex.reps, bodyweight: !!ex.bodyweight,
            }))
          : [],
      } : null,
    } : null,
    // Evening-only: lightweight recap of TODAY for the "Today" row above
    // Tomorrow's Setup. Counts/mood are real values pulled from data, never
    // generated by Claude. Note: today_habits_done is intentionally absent —
    // journal_habit_summary doesn't finalize today's count until the day
    // rolls over, and live computation requires habit-cadence logic the
    // function doesn't have.
    today_recap: (mode === 'evening') ? {
      mood_label:     moodLabel(journalToday?.[0]?.mood ?? null),
      workouts_today: (ouraWorkoutsToday || []).map(w => ({
        activity: w.activity, duration_min: w.duration_min, intensity: w.intensity,
      })),
      // App-logged Train session for today, if any. Separate from
      // workouts_today (Oura) — that's wearable-detected motion.
      train_session_today: summarizeSession(workoutTodayLogged),
      tasks_completed_today: countTasksInLocalDay(tasksAll, today, user.timezone),
      open_priority_tasks:   (tasksTopOpen || []).length,
    } : null,
    // Compact Train recap — last 5 sessions, summary only. Used by Claude
    // when synthesizing "you've been hitting it hard" / "third skipped
    // workout this week" type observations.
    train_recent: (recentSessions || []).slice(0, 5).map(summarizeSession).filter(Boolean),
    last_7_days: {
      oura: oura7 || [],
      mood: moodWeek,
      habits: habits7 || [],
      tag_counts: tagCounts,
    },
    baselines_7d:  baseline7,
    baselines_30d: baseline30,
    hero_hint: hero_hint,   // server's pick for the hero ring; Claude may keep or override (within enum)
    // Phase 6 Layer 1 — structured recent lab results from the user's
    // uploaded bloodwork docs. Dedupe to the latest value per test_name
    // within the last 90 days. age_days lets the prompt explicitly
    // frame freshness ("from 2 weeks ago" vs "still your most recent").
    // Null when the user hasn't uploaded any labs yet.
    health_labs: buildHealthLabsSnapshot(recentLabs, today),
    // Phase 7 — unconsumed anomaly alerts. The brief leads with these
    // when present. Each alert has metric, value, baseline_value,
    // z_score, direction. After the brief consumes them, they're
    // marked consumed_at so they don't repeat.
    pending_anomalies: (pendingAnomalies || []),
    _oura_stale: ouraStale,
  };

  return ctx;
}

// Dedupe lab results to the latest test_date per test_name. Returns a
// compact snapshot or null when no labs in the 90-day window.
function buildHealthLabsSnapshot(labs, today) {
  if (!Array.isArray(labs) || labs.length === 0) return null;
  // Input is ordered test_date DESC, so the first time we see each
  // test_name is its latest value.
  const latest = new Map();
  for (const row of labs) {
    if (!latest.has(row.test_name)) latest.set(row.test_name, row);
  }
  const results = Array.from(latest.values()).map(r => ({
    test_name:      r.test_name,
    value:          r.value,
    unit:           r.unit,
    flag:           r.flag,   // 'low'|'normal'|'high'|'critical_low'|'critical_high'|null
    ref_range_low:  r.ref_range_low,
    ref_range_high: r.ref_range_high,
    ref_range_text: r.ref_range_text,
    test_date:      r.test_date,
  }));
  // age_days based on the most recent test_date in the snapshot.
  const newestDate = results.reduce((acc, r) => (r.test_date > acc ? r.test_date : acc), '0000-01-01');
  const ageDays = Math.max(0, Math.floor((Date.parse(today + 'T00:00:00Z') - Date.parse(newestDate + 'T00:00:00Z')) / 86_400_000));
  return {
    as_of_date: newestDate,
    age_days:   ageDays,
    results,
  };
}

function stripPercentiles(b) {
  if (!b) return null;
  const out = { ...b };
  out.mood_label_median = moodLabel(out.mood_median);
  for (const k of Object.keys(out)) {
    if (/_p25$|_p75$/.test(k)) delete out[k];
    if (k === 'mood_median' || k === 'mood_p25' || k === 'mood_p75') delete out[k];
  }
  return out;
}

// ── Open-Meteo weather ─────────────────────────────────────────────────────
async function fetchWeather(lat, lng, dateLocal, tz, label) {
  try {
    const params = new URLSearchParams({
      latitude:        String(lat),
      longitude:       String(lng),
      daily:           'temperature_2m_max,temperature_2m_min,weather_code,sunrise,sunset',
      temperature_unit: 'fahrenheit',
      timezone:        tz || 'auto',
      start_date:      dateLocal,
      end_date:        dateLocal,
    });
    const r = await fetch(`${OPEN_METEO_URL}?${params}`);
    if (!r.ok) { console.warn(`weather fetch HTTP ${r.status}`); return null; }
    const j = await r.json();
    const d = j?.daily;
    if (!d || !d.time || !d.time.length) return null;
    const code = d.weather_code?.[0];
    return {
      location:      label || null,
      temp_high_f:   d.temperature_2m_max?.[0] ?? null,
      temp_low_f:    d.temperature_2m_min?.[0] ?? null,
      condition:     weatherCodeToText(code),
      weather_emoji: weatherCodeToEmoji(code),
      sunrise:       d.sunrise?.[0] ?? null,
      sunset:        d.sunset?.[0] ?? null,
    };
  } catch (err) {
    console.warn('weather fetch failed:', err.message);
    return null;
  }
}
function weatherCodeToText(code) {
  if (code == null) return null;
  const c = Number(code);
  if (c === 0) return 'clear';
  if (c <= 3) return 'partly cloudy';
  if (c <= 48) return 'foggy';
  if (c <= 57) return 'drizzle';
  if (c <= 67) return 'rain';
  if (c <= 77) return 'snow';
  if (c <= 82) return 'rain showers';
  if (c <= 86) return 'snow showers';
  if (c <= 99) return 'thunderstorm';
  return null;
}

// WMO weather codes → condition emoji. Same banding as weatherCodeToText so
// the two stay in lockstep. Returns null for unknown codes so the chip
// renders without an emoji rather than a wrong one.
function weatherCodeToEmoji(code) {
  if (code == null) return null;
  const c = Number(code);
  if (c === 0) return '☀️';     // clear sky
  if (c <= 2) return '⛅';       // partly cloudy
  if (c === 3) return '☁️';     // overcast
  if (c <= 48) return '🌫️';    // fog
  if (c <= 57) return '🌦️';    // drizzle
  if (c <= 67) return '🌧️';    // rain
  if (c <= 77) return '❄️';     // snow
  if (c <= 82) return '🌧️';    // rain showers
  if (c <= 86) return '🌨️';    // snow showers
  if (c <= 99) return '⛈️';     // thunderstorm
  return null;
}
function weekdayInTz(dateStr, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(dt);
}

// ── Deterministic builders (Phase 1.7 fix-pass) ────────────────────────────
// Everything factual lives here, not in Claude. Claude contributes ONLY
// headline, subhead, evidence_pills, optional hero_metric_key override, and
// optional sleep_target_time. Everything else (numbers, names, counts,
// task titles, event titles) is computed/copied verbatim from data.

// Count completed tasks whose completed_at epoch ms falls within the given
// user-local day. Reuses the existing localDayStartUtcMs helper.
function countTasksInLocalDay(tasksAll, dateStr, tz) {
  if (!Array.isArray(tasksAll) || !tasksAll.length) return 0;
  const start = localDayStartUtcMs(dateStr, tz);
  const end   = start + 86400_000;
  return tasksAll.filter(t => t.completed_at && t.completed_at >= start && t.completed_at < end).length;
}

// Tally open tasks into priority/due_today/overdue buckets relative to a
// date string (YYYY-MM-DD). Uses the user-local date the caller supplies so
// "due today" is honest regardless of UTC vs local boundaries.
function computeTaskCounts(openTasks, refDate) {
  const arr = Array.isArray(openTasks) ? openTasks : [];
  let priority = 0, due_today = 0, overdue = 0;
  for (const t of arr) {
    const isOver = !!(t.due && t.due < refDate);
    const isToday = !!(t.due && t.due === refDate);
    if (isOver) overdue++;
    else if (isToday) due_today++;
    if (t.top3) priority++;
  }
  return { priority, due_today, overdue, total_open: arr.length };
}

function formatMinutes(m) {
  if (m == null) return null;
  const n = Math.round(Number(m));
  if (!Number.isFinite(n) || n < 0) return null;
  const h = Math.floor(n / 60);
  const r = n % 60;
  if (h === 0) return `${r}m`;
  if (r === 0) return `${h}h`;
  return `${h}h ${r}m`;
}

function formatEventTime(iso, allDay, tz) {
  if (allDay) return 'All day';
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(d).replace(/\s*AM/, 'a').replace(/\s*PM/, 'p');
}

function inferEventIcon(summary) {
  const s = String(summary || '').toLowerCase();
  if (/(walk|run|gym|workout|lift|yoga|hike|bike|swim|exercise|cardio|stretch)/i.test(s)) return 'walk';
  if (/(lunch|dinner|breakfast|coffee|meal|brunch|drinks?)/i.test(s)) return 'meal';
  if (/(meeting|sync|call|review|standup|interview|client|1\:1|check[\s-]?in|catchup|catch-up)/i.test(s)) return 'work';
  return 'other';
}

// Examples:
//   morning: "☀️ 53°/51° · Pelham"
//   evening: "☀️ Tmrw 53°/51° · Pelham"
// Showing both high and low removes the "is that the high or low?" ambiguity
// users hit when only one number is shown. The condition emoji (☀️/⛅/🌧️/❄️
// etc.) is prefixed to make the chip scannable at a glance.
function buildWeatherChip(weather, mode) {
  if (!weather || weather.temp_high_f == null) return null;
  const high  = `${Math.round(weather.temp_high_f)}°`;
  const low   = weather.temp_low_f != null ? `${Math.round(weather.temp_low_f)}°` : null;
  const temps = low ? `${high}/${low}` : high;
  const place = (weather.location || '').split(',')[0].trim();
  const core  = place ? `${temps} · ${place}` : temps;
  const tempsBlock = mode === 'evening' ? `Tmrw ${core}` : core;
  const emoji = weather.weather_emoji;
  return emoji ? `${emoji} ${tempsBlock}` : tempsBlock;
}

// Pick the hero metric: respect Claude's override if valid, else use the
// largest-deviation server hint. Always fill value/label/delta from raw data.
// Oura scores (sleep/readiness/activity) are 1-100 in practice. A literal 0
// means Oura hasn't finalized the day yet (common in the early-morning sync
// window — the user's Oura app shows real numbers because it pulls live from
// the ring; our DB has whatever the last cron sync grabbed). Treat 0 as
// "not yet finalized" so we render "—" instead of misleading "0".
function sanitizeScores(row) {
  if (!row) return row;
  const out = { ...row };
  for (const k of ['sleep_score', 'readiness_score', 'activity_score']) {
    if (out[k] === 0) out[k] = null;
  }
  return out;
}

function buildHeroMetric(claudeKey, ctx) {
  const allowed = HERO_METRIC_KEYS.includes(claudeKey) ? claudeKey : (ctx.hero_hint || 'readiness_score');
  const r  = sanitizeScores(ctx.yesterday?.recovery || {});
  const a  = sanitizeScores(ctx.yesterday?.activity || {});
  const b7 = ctx.baselines_7d || {};
  let value = null, baseline = null;
  if (allowed === 'sleep_score')     { value = r.sleep_score;     baseline = b7.sleep_score_median; }
  if (allowed === 'readiness_score') { value = r.readiness_score; baseline = b7.readiness_score_median; }
  if (allowed === 'activity_score')  { value = a.activity_score;  baseline = b7.activity_score_median; }
  const delta = (value != null && baseline != null) ? Math.round(Number(value) - Number(baseline)) : 0;
  return {
    key: allowed,
    value: value == null ? null : Math.round(Number(value)),     // null lets UI render "—"
    label: HERO_METRIC_LABELS[allowed] || allowed.toUpperCase(),
    delta_vs_7d: delta,
  };
}

// Build the stats list (Sleep, Activity, Resting HR, HRV) — exclude the hero
// metric. All numbers are pulled from the raw recovery/activity rows. Deltas
// are computed against the 7-day baseline. Notes are computed for special
// cases (sleep score, HRV banding, RHR elevation).
// Metrics where a LOWER value is better. The stat-row builder uses this set
// to label the delta direction so the client renders RHR ↓4 (good) green and
// RHR ↑4 (bad) red — the inverse of the default mapping.
const LOWER_IS_BETTER_METRICS = new Set(['Resting HR', 'Stress', 'Sleep latency']);

function buildStats(heroKey, ctx) {
  const r  = sanitizeScores(ctx.yesterday?.recovery || {});
  const a  = sanitizeScores(ctx.yesterday?.activity || {});
  const b7 = ctx.baselines_7d || {};
  // fmtDelta returns both the display string and the signed integer so the
  // direction tagger downstream can apply per-metric "lower is better" rules.
  const fmtDelta = (today, base) => {
    if (today == null || base == null) return { text: null, signed: 0 };
    const d = Math.round(Number(today) - Number(base));
    if (d === 0) return { text: null, signed: 0 };
    return {
      text:   d > 0 ? `↑${d}` : `↓${Math.abs(d)}`,
      signed: d,
    };
  };
  const tagDir = (label, signed) => {
    if (!signed) return null;
    const lowerBetter = LOWER_IS_BETTER_METRICS.has(label);
    // good = direction the user wants. Higher-is-better metric + positive
    // delta → good. Lower-is-better metric + negative delta → good.
    if (lowerBetter) return signed < 0 ? 'good' : 'bad';
    return signed > 0 ? 'good' : 'bad';
  };
  const rows = [];

  // Sleep row: duration as value, score as note (if available)
  if (heroKey !== 'sleep_score' && (r.total_sleep_min != null || r.sleep_score != null)) {
    const dur = formatMinutes(r.total_sleep_min);
    const dd  = fmtDelta(r.total_sleep_min, b7.total_sleep_min_median);
    rows.push({
      label:     'Sleep',
      value:     dur || (r.sleep_score != null ? String(r.sleep_score) : '—'),
      delta:     dd.text,
      delta_dir: tagDir('Sleep', dd.signed),
      note:      (dur && r.sleep_score != null) ? `score ${r.sleep_score}` : null,
    });
  }

  // Activity row: score as value, steps as note — UNLESS score and steps
  // disagree (high score on low-step day = Oura's "rest day credit"), in
  // which case show a qualifier instead so the row doesn't look broken.
  if (heroKey !== 'activity_score' && (a.activity_score != null || a.steps != null)) {
    let note = null;
    if (a.activity_score != null && a.steps != null && a.activity_score >= 80 && a.steps < 4000) {
      note = 'low-movement day';
    } else if (a.steps != null) {
      note = `${a.steps.toLocaleString()} steps · yesterday`;
    }
    const dd = fmtDelta(a.activity_score, b7.activity_score_median);
    rows.push({
      label:     'Activity',
      value:     a.activity_score != null ? String(a.activity_score) : '—',
      delta:     dd.text,
      delta_dir: tagDir('Activity', dd.signed),
      note,
    });
  }

  // Readiness row (only if not the hero)
  if (heroKey !== 'readiness_score' && r.readiness_score != null) {
    const dd = fmtDelta(r.readiness_score, b7.readiness_score_median);
    rows.push({
      label:     'Readiness',
      value:     String(r.readiness_score),
      delta:     dd.text,
      delta_dir: tagDir('Readiness', dd.signed),
      note:      null,
    });
  }

  // Resting HR row: number as value, "elevated" / "low" as note. Lower is
  // better — a negative delta should render GREEN (good), positive RED.
  if (r.resting_hr != null) {
    const diff = b7.resting_hr_median != null ? Math.round(r.resting_hr - Number(b7.resting_hr_median)) : null;
    let note = null;
    if (diff != null && diff > 5) note = 'elevated';
    else if (diff != null && diff < -5) note = 'low';
    const dd = fmtDelta(r.resting_hr, b7.resting_hr_median);
    rows.push({
      label:     'Resting HR',
      value:     String(Math.round(r.resting_hr)),
      delta:     dd.text,
      delta_dir: tagDir('Resting HR', dd.signed),
      note,
    });
  }

  // HRV row: number as value (no "ms" per voice rules), banding note
  if (r.hrv_ms != null) {
    let note = null;
    if (b7.hrv_ms_median != null) {
      const pct = Number(r.hrv_ms) / Number(b7.hrv_ms_median);
      if (pct < 0.7) note = 'well below norm';
      else if (pct < 0.9) note = 'below norm';
      else if (pct > 1.2) note = 'above norm';
    }
    const dd = fmtDelta(r.hrv_ms, b7.hrv_ms_median);
    rows.push({
      label:     'HRV',
      value:     String(Math.round(r.hrv_ms)),
      delta:     dd.text,
      delta_dir: tagDir('HRV', dd.signed),
      note,
    });
  }

  return rows.slice(0, 4);
}

// Compute the time the user got into bed from Oura's sleep midpoint and total
// sleep duration. Returns "10:45 PM" / "11:20 PM" / null. Oura's
// sleep_midpoint_offset_min is signed minutes from midnight of the date col
// (the day the sleep ENDED): negative = before midnight, positive = after.
// Bed-time offset = midpoint − duration/2. Normalize to 0-1439 then format.
function computeBedtime(recovery) {
  if (!recovery) return null;
  const mid = recovery.sleep_midpoint_offset_min;
  const dur = recovery.total_sleep_min;
  if (mid == null || dur == null) return null;
  let minOfDay = Math.round(Number(mid) - Number(dur) / 2);
  while (minOfDay < 0)     minOfDay += 1440;
  while (minOfDay >= 1440) minOfDay -= 1440;
  const h   = Math.floor(minOfDay / 60);
  const m   = minOfDay % 60;
  const pm  = h >= 12;
  const h12 = ((h + 11) % 12) + 1;        // 0→12, 13→1, …
  return `${h12}:${String(m).padStart(2, '0')} ${pm ? 'PM' : 'AM'}`;
}

// Build the Yesterday/Today recap pair the client renders as a two-column
// grid. Everything here is deterministic: habits %, task counts, bedtime
// time, mood label, sleep target. Claude touches none of it. The left block
// shows what just finished (habits closed, tasks done, bedtime, mood); the
// right block shows what's coming (events, task counts, habits in-flight,
// sleep target). For evening mode, "left" is today's recap (now finalized)
// and "right" is tomorrow's setup; the client picks the labels off
// `left.label`/`right.label`.
function buildRecap(mode, ctx, sleepTargetTime) {
  // Habits percentage from {done, due} shape. Returns null when no data, 0%
  // when due > 0 but done = 0 (we still want to render the 0/N row).
  const habitsPct = (h) => {
    if (!h || !h.due) return null;
    const done = Number(h.done) || 0;
    const due  = Number(h.due);
    return { pct: Math.round((done / due) * 100), done, due };
  };

  // Compact Train summary for a recap column. Returns a short string the
  // client renders as one of the Yesterday/Today rows. Falls back to null
  // when nothing relevant happened (so the client skips the row entirely).
  const trainSummary = (session) => {
    if (!session) return null;
    const t = session.day_type;
    const name = session.day_name || (t === 'cardio' ? 'Cardio' : t === 'bonus' ? 'Bonus' : 'Lift');
    if (t === 'cardio') {
      const ex = (session.exercises && session.exercises[0]) || null;
      const mins = ex?.top_reps || 0;          // cardio parks minutes in reps
      return { label: name, detail: mins ? `${mins} min` : null };
    }
    if (t === 'bonus') {
      const ex = (session.exercises && session.exercises[0]) || null;
      const mins = ex?.top_reps || 0;
      return { label: name, detail: mins ? `${mins} min` : null };
    }
    // Lift
    const sets = session.total_sets;
    const vol  = session.total_volume;
    if (vol > 0) return { label: name, detail: `${sets} sets · ${vol.toLocaleString()} lbs` };
    return { label: name, detail: sets ? `${sets} sets` : null };
  };
  // Planned-for-today / tomorrow Train row (when nothing logged yet).
  // Just the workout name — the recap column is space-constrained and
  // "5 exercises" / "cardio session" was overflowing into the next
  // column. The exercise list lives on the Workout tab itself.
  // (trainSummary keeps detail for LOGGED workouts — that's useful
  // retrospective info like "15 min · 1 mile".)
  const plannedSummary = (planned) => {
    if (!planned) return null;
    const t = planned.type;
    if (t === 'rest') return { label: 'Rest day', detail: null };
    if (t === 'cardio') return { label: planned.name || 'Cardio', detail: null };
    return { label: planned.name || 'Lift', detail: null };
  };

  // Morning: left = yesterday (yday data), right = today (today plan).
  // Evening: left = today (today recap from ctx.today_recap, plus yday data
  //          for habits/bedtime which finalize only after the day rolls
  //          over), right = tomorrow (tomorrow plan).
  if (mode === 'morning') {
    const left = {
      label:       'Yesterday',
      habits:      habitsPct(ctx.yesterday?.habits),
      tasks_done:  ctx.yesterday?.tasks_completed_count ?? null,
      bedtime:     computeBedtime(ctx.yesterday?.recovery),
      mood_label:  ctx.yesterday?.mood?.value_label ?? null,
      train:       trainSummary(ctx.yesterday?.workout),
    };
    const right = {
      label:        'Today',
      events:       (ctx.today_plan?.calendar_events || []).length,
      task_counts:  ctx.today_plan?.task_counts || null,
      habits_today: null,        // client recomputes from live habitsArr (Tier 1)
      sleep_target: sleepTargetTime,
      // Prefer logged-for-today when present; fall back to planned otherwise.
      train:        trainSummary(ctx.today_plan?.workout?.logged_today)
                 || plannedSummary(ctx.today_plan?.workout?.planned),
    };
    return { left, right };
  }
  // Evening
  const left = {
    label:       'Today',
    // Today's habits don't fully finalize until midnight; fall back to
    // yesterday's snapshot when journal_habit_summary hasn't been written yet.
    habits:      habitsPct(ctx.yesterday?.habits),
    tasks_done:  ctx.today_recap?.tasks_completed_today ?? null,
    bedtime:     null,           // yesterday's bedtime is stale by evening
    mood_label:  ctx.today_recap?.mood_label ?? null,
    train:       trainSummary(ctx.today_recap?.train_session_today),
    // Sleep target lives under TODAY (it's tonight's bedtime, not
    // tomorrow's). Was previously on the right/Tomorrow column which
    // read as "Tomorrow 10:30 PM" — semantically wrong.
    sleep_target: sleepTargetTime,
  };
  const right = {
    label:        'Tomorrow',
    events:       (ctx.tomorrow_plan?.calendar_events || []).length,
    task_counts:  ctx.tomorrow_plan?.task_counts || null,
    habits_today: null,
    train:        plannedSummary(ctx.tomorrow_plan?.workout),
  };
  return { left, right };
}

// Build the play list deterministically from facts. Morning shows today's plan
// (events + persistent priority tasks + yesterday's habit-snapshot + sleep
// target). Evening shows TOMORROW's plan (events + tasks + sleep target) —
// dropping the today-recap entirely because the cards below already show that.
function buildPlayRows(mode, ctx, sleepTargetTime) {
  const rows = [];
  const tz   = ctx.user?.timezone || DEFAULT_TIMEZONE;

  if (mode === 'morning') {
    // Today's calendar events (first 2)
    const events = (ctx.today_plan?.calendar_events || []).slice(0, 2);
    for (const e of events) {
      const title = String(e.summary || '').trim();
      if (!title) continue;
      rows.push({
        icon:    inferEventIcon(title),
        scope:   formatEventTime(e.start, e.allDay, tz) || 'Today',
        content: title,
      });
    }
    // Tasks row: count summary, not titles. Phase 1.8 — drops individual
    // task names in favor of "3 priority · 2 due today · 1 overdue" so the
    // brief and the Tasks card stop duplicating each other.
    const tcRow = buildTaskCountsRow(ctx.today_plan?.task_counts);
    if (tcRow) rows.push(tcRow);
    // Yesterday's habit snapshot (clear timeframe: "Y'day 3/4")
    const habits = ctx.yesterday?.habits;
    if (habits && habits.due > 0) {
      const done = habits.done ?? 0;
      const due  = habits.due;
      rows.push({
        icon:    'habits',
        scope:   `Y'day ${done}/${due}`,
        content: done >= due ? 'All habits closed yesterday' : 'Set up today\'s habits',
      });
    }
    // Sleep target
    rows.push({
      icon:    'sleep',
      scope:   'Sleep',
      content: sleepTargetTime ? `In bed by ${sleepTargetTime}` : 'Protect tonight\'s sleep',
    });
  } else {
    // EVENING: leads with a one-line TODAY recap, then forward to tonight +
    // tomorrow. The recap exists so the evening brief feels like a hand-off,
    // not just a doom-loop of bad numbers.
    const recap = ctx.today_recap;
    if (recap) {
      const parts = [];
      if (recap.mood_label) parts.push(`Mood: ${recap.mood_label}`);
      if (recap.workouts_today?.length) {
        const w = recap.workouts_today[0];
        const verb = (w.activity || 'workout').toLowerCase();
        parts.push(`${verb} done`);
      }
      if (recap.tasks_completed_today > 0) {
        parts.push(`${recap.tasks_completed_today} task${recap.tasks_completed_today === 1 ? '' : 's'} done`);
      }
      if (recap.open_priority_tasks > 0) {
        parts.push(`${recap.open_priority_tasks} priority left`);
      }
      if (parts.length > 0) {
        rows.push({
          icon:    'other',
          scope:   'Today',
          content: parts.join(' · '),
        });
      }
    }
    // Tonight's sleep next (most immediate action).
    rows.push({
      icon:    'sleep',
      scope:   'Tonight',
      content: sleepTargetTime ? `In bed by ${sleepTargetTime}` : 'Wind down for the night',
    });
    // Tomorrow's calendar events (first 2)
    const tEvents = (ctx.tomorrow_plan?.calendar_events || []).slice(0, 2);
    for (const e of tEvents) {
      const title = String(e.summary || '').trim();
      if (!title) continue;
      rows.push({
        icon:    inferEventIcon(title),
        scope:   formatEventTime(e.start, e.allDay, tz) || 'Tomorrow',
        content: title,
      });
    }
    // Tasks row: count summary based on tomorrow's frame (overdue and
    // due-today both reckoned against tomorrow's date).
    const tcRow2 = buildTaskCountsRow(ctx.tomorrow_plan?.task_counts);
    if (tcRow2) rows.push(tcRow2);
  }

  return rows.slice(0, 5);
}

// Build a tasks play-row from a task_counts block. Returns null when there
// are no open tasks worth surfacing. Format example: "3 priority · 2 due
// today · 1 overdue" — zero-count buckets are omitted.
function buildTaskCountsRow(counts) {
  if (!counts || !counts.total_open) return null;
  const parts = [];
  if (counts.priority   > 0) parts.push(`${counts.priority} priority`);
  if (counts.due_today  > 0) parts.push(`${counts.due_today} due today`);
  if (counts.overdue    > 0) parts.push(`${counts.overdue} overdue`);
  if (parts.length === 0)    parts.push(`${counts.total_open} open`);
  return {
    icon:    'tasks',
    scope:   `${counts.total_open} open`,
    content: parts.join(' · '),
  };
}

// ── Claude call ───────────────────────────────────────────────────────────
async function callClaude(ctx, mode, anthropicKey) {
  const model     = process.env.BRIEF_MODEL || DEFAULT_MODEL;
  const maxTokens = parseInt(process.env.BRIEF_MAX_TOKENS || '', 10) || DEFAULT_MAX_TOKENS;

  // Cold-start gate
  const n_sleep   = ctx.baselines_30d?.n_days_sleep || 0;
  const n_mood    = ctx.baselines_30d?.n_days_mood || 0;
  const baselineN = Math.max(n_sleep, n_mood);
  const coldStart = baselineN < 14;

  const systemPrompt = buildSystemPrompt(mode, ctx, { coldStart, baselineN });

  // Strip internal flags
  const { _oura_stale, ...payload } = ctx;

  const body = {
    model:      model,
    max_tokens: maxTokens,
    system:     systemPrompt,
    messages: [
      { role: 'user', content: `Generate the ${mode} coach brief using record_daily_brief.\n\n${JSON.stringify(payload, null, 0)}` },
    ],
    tools:       [briefToolSchema(mode)],
    tool_choice: { type: 'tool', name: 'record_daily_brief' },
  };

  const r = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         anthropicKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  const j = await r.json();
  if (!r.ok) {
    throw new Error(`anthropic_http_${r.status}: ${j?.error?.message || JSON.stringify(j).slice(0, 200)}`);
  }

  const toolUseBlock = (j.content || []).find(b => b.type === 'tool_use' && b.name === 'record_daily_brief');
  if (!toolUseBlock) throw new Error(`no_tool_use_in_response: stop_reason=${j.stop_reason}`);

  // Server-side normalization
  const raw = toolUseBlock.input || {};
  const normalized = normalizeStructured(raw, mode, ctx);
  if (normalized === null) {
    console.warn('daily-brief: normalization rejected output (banned phrase or invalid shape), substituting fallback');
    return buildFallback({ reason: 'normalization_rejected', context: ctx, mode });
  }

  // Build flat narrative fallback for legacy clients
  const flatNarrative = buildFlatNarrative(normalized);

  return {
    status:            'ok',
    structured:        normalized,
    mode:              mode,
    narrative:         flatNarrative,
    tldr:              null,
    highlights:        [],
    actions:           [],
    confidence:        normalized.confidence || 'low',
    model:             j.model || model,
    prompt_tokens:     j.usage?.input_tokens || null,
    completion_tokens: j.usage?.output_tokens || null,
    input_snapshot:    payload,
    fallback_reason:   null,
  };
}

function buildSystemPrompt(mode, ctx, { coldStart, baselineN }) {
  const hint = ctx.hero_hint;
  const lines = [
    'You are the user\'s chief-of-staff briefing partner. Direct, verb-first, no filler. No emojis. No medical claims.',
    '',
    'YOUR JOB IS NARROW. You only write text-only synthesis. The server builds all factual blocks (weather chip, hero ring numbers, stats list, play rows of events/tasks/habits/sleep). You MUST NOT produce numbers, counts, event titles, or task titles — anything factual.',
    '',
    'FIELDS YOU PRODUCE:',
    'headline — ONE sentence ≤30 chars. Verb-first call. Examples: "Recovery day.", "Push day.", "Light day.", "Hold the line.", "Catch-up morning.". NEVER prefix with a greeting ("Your X Brief", "Good morning") — the card header shows that.',
    'subhead — ONE sentence ≤80 chars stating the play. Examples: "Pull back on intensity. Protect tonight\'s sleep.", "Front-load the hardest task; lift later if recovered."',
    'evidence_pills — 0-3 short context tags ≤4 words each. Pills must ADD context the stats row CAN\'T show. The stats list already shows things like "elevated", "well below norm", "X steps" — pills that just paraphrase those notes are USELESS and will be cut. Good pills surface: CAUSES ("Late night Friday", "Workout yesterday"), STREAKS ("2nd low HRV", "3rd recovery dip"), COUNTERFACTUALS ("Light load worked", "Caffeine helped"), or PATTERNS ("Recovers slow Mondays"). DO NOT name specific events, tasks, or counts. Skip entirely if you have nothing the stats list isn\'t already saying.',
    'hero_metric_key — OPTIONAL override of the server\'s pick for the hero ring. Server hint: ' + (hint || 'none') + '. Set null to accept the server pick; or pick one of "sleep_score", "readiness_score", "activity_score" if a different metric is the story.',
    mode === 'evening'
      ? 'sleep_target_time — OPTIONAL specific time recommendation, e.g. "10:30 PM". The server uses this for the sleep row\'s content. Null if no specific target.'
      : 'sleep_target_time — OPTIONAL specific time recommendation, e.g. "10:30 PM". Used for the sleep row in today\'s play. Null if no specific target.',
    'confidence — "high" if baselines have n>=30 AND last night\'s data is complete; "medium" if n=14-29 or one signal missing; "low" if n<14 or last night missing.',
    '',
    'BANNED — using any of these triggers a fallback: "worth noting", "fun evening", "the week\'s been rich", "actually land", "no weather to report", "your body\'s still", any percentile/median/IQR/p25/p50/p75 reference, any "ms"/"milliseconds" reference. Also: never invent numbers or names — the data you can see (recovery, activity, baselines, weeks-rolling) is for your reasoning only; you must not echo specific numbers/titles in headline/subhead/pills.',
    '',
    'CONTEXT YOU SEE (for reasoning, not for echoing):',
    '- yesterday.recovery = LAST NIGHT\'s sleep that ended this morning (sleep_score, readiness_score, HRV, resting_hr).',
    '- yesterday.activity = YESTERDAY\'s day (activity_score, steps, stress).',
    '- today_plan.workout.planned = today\'s prescribed Train session from the user\'s active plan. Use the day name in the headline when it\'s a lift/cardio day ("Push day.", "Cardio today."). Skip in headline on rest days.',
    '- today_plan.workout.last_same_day = the user\'s most recent prior session matching today\'s day_name. Use for streak / consistency framing only — DO NOT echo specific weights or reps in headline/subhead/pills.',
    '- today_plan.workout.logged_today = a session already in the books for today (evening mode or same-day refire). When present, frame the brief around what got done, not what\'s prescribed.',
    '- yesterday.workout = the Train session logged yesterday (if any). Useful for "Lifted yesterday" pills.',
    '- train_recent = last 5 sessions, summary only. Use for "3rd lift this week" / "skipped 2" streak callouts in pills.',
    '- health_labs = the user\'s most recent bloodwork values, ONE per test_name, within the last 90 days. health_labs.age_days = how old the snapshot is. Use these as REASONING context for the brief\'s framing — e.g. if Lp(a) is flagged HIGH and today is a recovery day, you can frame the play with awareness ("CV-friendly recovery day" in subhead) without quoting numbers. NEVER echo specific lab values in headline/subhead — the server has no UI surface for them yet and quoting them out of context risks medical-claim territory. When you reference labs in an evidence_pill, frame freshness explicitly ("Bloodwork 2 wks ago" not "Bloodwork shows X"). Skip entirely if health_labs is null or all flags are normal — labs without an anomaly aren\'t worth surfacing.',
    '- pending_anomalies = wearable metrics that deviated >2σ from the user\'s 30-day baseline. When present, LEAD the brief with the most severe one (highest |z_score|): headline acknowledges it (e.g. "HRV alarm." for hrv_ms below; "Sleep streak." for sleep_score above), subhead explains the play. Pills can reference "X below norm" / "X above norm" without echoing the numeric value (server already shows the value in the stats row). When pending_anomalies is empty, just write the normal brief — no need to mention "no anomalies today".',
    `- mood values arrive as labels (Bad/Low/Okay/Good/Great). ${MOOD_SCALE_NOTE}`,
    coldStart
      ? `COLD-START: only ${baselineN} days of baseline data. Skip evidence_pills entirely. Set confidence="low". Keep headline factual, no comparative claims.`
      : '',
  ].filter(Boolean);
  return lines.join('\n');
}

function briefToolSchema(mode) {
  const props = {
    headline: {
      type: 'string',
      description: 'ONE sentence ≤30 chars, verb-first call. NEVER a greeting prefix. No specific numbers or names.',
    },
    subhead: {
      type: 'string',
      description: 'ONE sentence ≤80 chars stating the play. No specific numbers or task/event names.',
    },
    evidence_pills: {
      type: 'array',
      maxItems: 3,
      items: { type: 'string' },
      description: '0-3 short context tags, each ≤4 words. No counts, no titles. Examples: "Body still cleaning up", "Late night Friday".',
    },
    hero_metric_key: {
      type: ['string', 'null'],
      enum: [...HERO_METRIC_KEYS, null],
      description: 'OPTIONAL override of server\'s hero pick. Null = accept server pick.',
    },
    sleep_target_time: {
      type: ['string', 'null'],
      description: 'OPTIONAL specific time recommendation for sleep (e.g. "10:30 PM"). Null = generic protect-sleep messaging.',
    },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  };
  return {
    name: 'record_daily_brief',
    description: 'Record the narrative parts of the daily brief. Called exactly once. Server fills in all factual blocks.',
    input_schema: {
      type: 'object',
      properties: props,
      required: ['headline', 'subhead', 'evidence_pills', 'confidence'],
    },
  };
}

// Merge Claude's narrow text-only output with server-built factual blocks.
// Banned-phrase scan applies to Claude's text fields. Returns the full
// structured object ready for storage, or null (→ fallback) if invalid.
function normalizeStructured(raw, mode, ctx) {
  if (!raw || typeof raw !== 'object') return null;

  // ── Claude's text fields ───────────────────────────────────────────────
  // Headline: strip greeting prefix, trim, cap length
  let headline = String(raw.headline || '').trim();
  headline = headline.replace(GREETING_PREFIX_REGEX, '').trim();
  if (!headline) return null;
  if (headline.length > 30) headline = headline.slice(0, 30).trim();

  // Subhead: trim, cap
  let subhead = String(raw.subhead || '').trim();
  if (subhead.length > 80) subhead = subhead.slice(0, 80).trim();

  // Evidence pills: drop pills with >4 words or >30 chars; cap to 3
  const pills = (Array.isArray(raw.evidence_pills) ? raw.evidence_pills : [])
    .map(p => String(p || '').trim())
    .filter(p => p && p.split(/\s+/).length <= 4 && p.length <= 30)
    .slice(0, 3);

  // Banned-phrase scan: only applies to Claude's text (the factual blocks
  // are server-built and trusted).
  const claudeText = [headline, subhead, pills.join(' ')].join(' ');
  if (BANNED_PROSE_REGEX.test(claudeText)) {
    console.warn('daily-brief: banned phrase in Claude output, rejecting:', claudeText.slice(0, 200));
    return null;
  }

  // ── Server-built factual blocks ────────────────────────────────────────
  const heroKey      = HERO_METRIC_KEYS.includes(raw.hero_metric_key) ? raw.hero_metric_key : null;
  const hero_metric  = buildHeroMetric(heroKey, ctx);
  const stats        = buildStats(hero_metric.key, ctx);
  const weatherSrc   = mode === 'evening' ? ctx.tomorrow_plan?.weather : ctx.today_plan?.weather;
  const weather_chip = buildWeatherChip(weatherSrc, mode);
  // Server-side deterministic sleep target wins over Claude's varying output.
  // Falls back to Claude's value only if the server rules return null.
  const serverSleepTarget = recommendSleepTarget(ctx.yesterday?.recovery, mode, ctx.baselines_7d);
  const sleepTarget = serverSleepTarget || (raw.sleep_target_time ? String(raw.sleep_target_time).trim().slice(0, 24) : null);
  const recap        = buildRecap(mode, ctx, sleepTarget);

  const confidence = ['high', 'medium', 'low'].includes(raw.confidence) ? raw.confidence : 'low';

  return {
    mode,
    weather_chip,
    headline,
    subhead,
    hero_metric,
    stats,
    evidence_pills: pills,
    recap,
    confidence,
  };
}

// Flatten structured output into a plain-text narrative for legacy clients
// that don't read the structured column.
function buildFlatNarrative(s) {
  const lines = [s.headline, s.subhead];
  if (s.evidence_pills?.length) lines.push(s.evidence_pills.join(' · '));
  // Recap blocks: flatten left + right columns into prose for the legacy
  // narrative column. Order matches the rendered grid (left first).
  const r = s.recap;
  if (r?.left || r?.right) {
    const fmtCol = (col) => {
      if (!col) return null;
      const bits = [];
      if (col.habits)      bits.push(`Habits ${col.habits.pct}% · ${col.habits.done}/${col.habits.due}`);
      if (col.tasks_done != null) bits.push(`${col.tasks_done} tasks done`);
      if (col.bedtime)     bits.push(`Bed ${col.bedtime}`);
      if (col.mood_label)  bits.push(`Mood ${col.mood_label}`);
      if (col.events != null) bits.push(`${col.events} events`);
      if (col.task_counts) {
        const tc = col.task_counts;
        bits.push(`${tc.priority}p · ${tc.due_today}d · ${tc.overdue}o`);
      }
      if (col.train?.label) {
        bits.push(col.train.detail ? `${col.train.label} · ${col.train.detail}` : col.train.label);
      }
      if (col.sleep_target) bits.push(`Sleep ${col.sleep_target}`);
      return bits.length ? `${col.label}: ${bits.join(' · ')}` : null;
    };
    const L = fmtCol(r.left), R = fmtCol(r.right);
    if (L) lines.push(L);
    if (R) lines.push(R);
  }
  return lines.filter(Boolean).join('\n');
}

// ── Fallback ──────────────────────────────────────────────────────────────
// Uses the same server-side builders as the OK path so the layout matches.
// Headline/subhead/pills get deterministic placeholders; everything factual
// is built from real data when present.
function buildFallback({ reason, context, mode }) {
  const ctxSafe = context || { user: { timezone: DEFAULT_TIMEZONE }, yesterday: {}, today_plan: {}, tomorrow_plan: null, baselines_7d: null };
  const hero_metric  = buildHeroMetric(null, ctxSafe);
  const stats        = buildStats(hero_metric.key, ctxSafe);
  const weatherSrc   = mode === 'evening' ? ctxSafe.tomorrow_plan?.weather : ctxSafe.today_plan?.weather;
  const weather_chip = buildWeatherChip(weatherSrc, mode);
  const serverSleepTarget = recommendSleepTarget(ctxSafe.yesterday?.recovery, mode, ctxSafe.baselines_7d);
  const recap        = buildRecap(mode, ctxSafe, serverSleepTarget);

  const structured = {
    mode,
    weather_chip,
    headline:       mode === 'morning' ? 'Brief unavailable.' : 'Wrap-up unavailable.',
    subhead:        'Generate again when ready.',
    hero_metric,
    stats,
    evidence_pills: [],
    recap,
    confidence:     'low',
  };

  return {
    status:            'fallback',
    structured,
    mode,
    narrative:         buildFlatNarrative(structured),
    tldr:              null,
    highlights:        [],
    actions:           [],
    confidence:        'low',
    model:             null,
    prompt_tokens:     null,
    completion_tokens: null,
    input_snapshot:    context ? (() => { const { _oura_stale, ...p } = context; return p; })() : null,
    fallback_reason:   reason,
  };
}

// ── Store ─────────────────────────────────────────────────────────────────
async function storeBrief(user, brief_date, mode, result, serviceKey) {
  const row = {
    user_id:           user.user_id,
    brief_date:        brief_date,
    mode:              mode,
    generated_at:      new Date().toISOString(),
    model:             result.model,
    prompt_tokens:     result.prompt_tokens,
    completion_tokens: result.completion_tokens,
    structured:        result.structured || null,
    tldr:              result.tldr || null,
    narrative:         result.narrative,
    highlights:        result.highlights,
    actions:           result.actions,
    confidence:        result.confidence,
    status:            result.status,
    fallback_reason:   result.fallback_reason,
    input_snapshot:    result.input_snapshot,
  };
  // on_conflict targets the (user_id, brief_date, mode) UNIQUE introduced in
  // daily_briefs_structured.sql (Phase 1.7).
  const r = await fetch(`${SUPABASE_URL}/rest/v1/daily_briefs?on_conflict=user_id,brief_date,mode`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      apikey:          serviceKey,
      Authorization:   `Bearer ${serviceKey}`,
      Prefer:          'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify(row),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`daily_briefs upsert failed: ${r.status} ${text}`);
  }
  const rows = await r.json();
  return Array.isArray(rows) ? rows[0] : rows;
}

// ── Helpers ───────────────────────────────────────────────────────────────
async function fetchJson(url, hdr) {
  try {
    const r = await fetch(url, { headers: hdr });
    if (!r.ok) { console.warn(`brief: fetch ${url} HTTP ${r.status}`); return []; }
    return await r.json();
  } catch (err) {
    console.warn(`brief: fetch ${url} failed: ${err.message}`);
    return [];
  }
}
function stripUpdatedAt(row) {
  const { updated_at, ...rest } = row;
  return rest;
}
function yesterdayLocal(tz) {
  const today = localDate(new Date(), tz);
  return shiftDate(today, -1);
}
function localDate(date, tz) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(date);
}
function shiftDate(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}
function localDayStartUtcMs(dateStr, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const guessMs   = Date.UTC(y, m - 1, d);
  for (let h = -12; h <= 14; h++) {
    const ms = guessMs + h * 3600_000;
    if (localDate(new Date(ms), tz) === dateStr && new Date(ms).getUTCHours() % 24 !== undefined) {
      let lo = ms - 3600_000;
      while (lo >= guessMs - 24 * 3600_000 && localDate(new Date(lo), tz) === dateStr) lo -= 60_000;
      return lo + 60_000;
    }
  }
  return guessMs;
}
function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
function cors(res) {
  return {
    ...res,
    headers: {
      ...(res.headers || {}),
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Internal-Auth',
    },
  };
}

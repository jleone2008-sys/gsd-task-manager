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

const { json, cors, preflight } = require('./lib/http');
const { SUPABASE_URL }          = require('./lib/supabase');
const {
  fetchJson,
  stripUpdatedAt,
  localDate,
  yesterdayLocal,
  formatLocalClockTime,
  shiftDate,
  localDayStartUtcMs,
  hourInTz,
} = require('./lib/brief-utils');
const {
  HERO_METRIC_KEYS,
  HERO_METRIC_LABELS,
  weekdayInTz,
  countTasksInLocalDay,
  computeTaskCounts,
  formatMinutes,
  formatEventTime,
  inferEventIcon,
  buildWeatherChip,
  sanitizeScores,
  buildHeroMetric,
  buildStats,
  computeBedtime,
  buildRecap,
  buildPlayRows,
  buildTaskCountsRow,
} = require('./lib/brief-builders');

const ANTHROPIC_URL   = 'https://api.anthropic.com/v1/messages';
// OPEN_METEO_URL moved to lib/weather.js along with fetchWeather.

const { recommendSleepTarget } = require('./lib/recommendations');
const { MOOD_LABELS, MOOD_SCALE_NOTE, moodLabel } = require('./lib/mood-scale');
const { getWeather } = require('./lib/weather');

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
      // Distinguish the partial-fill case from full-stale so the brief UI
      // can render an actionable "open the Oura app" hint instead of the
      // generic "tap refresh" message. Both still set status=preliminary
      // so the existing affordance still appears.
      result.fallback_reason = ctx._oura_partial_sleep
        ? 'oura_sleep_data_missing'
        : 'oura_data_stale_at_generation';
    }

    const stored = await storeBrief(user, date, mode, result, serviceKey);
    // Phase 10 — record action outcome stubs for any recognized
    // recommendations in this brief. Fire-and-forget so a stub-insert
    // hiccup doesn't fail the brief response. cron-evaluate-actions.js
    // fills in adherence + outcomes over the following 3 days.
    if (Array.isArray(result.action_stubs) && result.action_stubs.length && stored?.id) {
      recordActionStubs(stored.id, user, date, mode, result.action_stubs, serviceKey)
        .catch(err => console.warn('[daily-brief] action stub insert failed:', err.message));
    }
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
    calY, calT, habitsY, habitCompletionsY, habitsCatalog,
    baselines30, baselines7, tasksTopOpen, tasksOpen,
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
    // Yesterday's habit completion rows + the user's habits catalog,
    // joined client-side below to surface the *names* of habits
    // completed (e.g. 'Reading / Podcast') so the brief AI can
    // reference specific behaviors in framing without the visible
    // recap getting cluttered.
    fetchJson(`${SUPABASE_URL}/rest/v1/habit_completions?user_id=eq.${user.user_id}&completed_date=eq.${yday}&select=habit_id`, hdr),
    fetchJson(`${SUPABASE_URL}/rest/v1/habits?user_id=eq.${user.user_id}&archived=eq.false&select=id,name,emoji`, hdr),
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

  // Phase 5 follow-up — pull individual mood check-ins (with the user's
  // optional reflection notes) for the 2-day window around the brief
  // date. journal_entries.mood is the rounded-average daily summary;
  // these rows carry the qualitative context that the daily AI brief
  // can reference ("you noted 'meeting overload' twice yesterday").
  // Filter is on captured_at (timestamptz), spanning yday 00:00 local
  // through today 23:59 local — approximated with a UTC window that's
  // generously wide; client-side split below buckets per local date.
  const moodWinStart = `${yday}T00:00:00Z`;
  const moodWinEnd   = `${today}T23:59:59.999Z`;
  const moodCheckinsRaw = await fetchJson(
    `${SUPABASE_URL}/rest/v1/mood_checkins?user_id=eq.${user.user_id}` +
    `&captured_at=gte.${encodeURIComponent(moodWinStart)}` +
    `&captured_at=lte.${encodeURIComponent(moodWinEnd)}` +
    `&select=captured_at,mood,note&order=captured_at.asc`,
    hdr
  );
  const moodCheckinForDate = (dateStr) => (moodCheckinsRaw || [])
    .filter(c => {
      // Compare in user's tz so a 12:30am local check-in lands on the
      // right day, not the prior UTC date.
      const d = new Intl.DateTimeFormat('en-CA', {
        timeZone: user.timezone || DEFAULT_TIMEZONE,
        year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date(c.captured_at));
      return d === dateStr;
    })
    .map(c => ({
      at:         c.captured_at,
      mood_label: moodLabel(c.mood),
      note:       (typeof c.note === 'string' && c.note.trim()) ? c.note.trim() : null,
    }));
  const moodCheckinsYesterday = moodCheckinForDate(yday);
  const moodCheckinsToday     = moodCheckinForDate(today);

  const [oura7, journal7, habits7, tags7] = await Promise.all([
    fetchJson(`${SUPABASE_URL}/rest/v1/oura_daily?user_email=eq.${encodeURIComponent(user.email)}&date=gte.${win7}&date=lte.${yday}&select=date,sleep_score,readiness_score,activity_score,total_sleep_min,hrv_ms&order=date.asc`, hdr),
    fetchJson(`${SUPABASE_URL}/rest/v1/journal_entries?user_id=eq.${user.user_id}&entry_date=gte.${win7}&entry_date=lte.${yday}&select=entry_date,mood&order=entry_date.asc`, hdr),
    fetchJson(`${SUPABASE_URL}/rest/v1/journal_habit_summary?user_id=eq.${user.user_id}&entry_date=gte.${win7}&entry_date=lte.${yday}&select=entry_date,due_count,done_count&order=entry_date.asc`, hdr),
    fetchJson(`${SUPABASE_URL}/rest/v1/oura_tags?user_email=eq.${encodeURIComponent(user.email)}&start_day=gte.${win7}&start_day=lte.${yday}&select=tag_type_code,start_day`, hdr),
  ]);

  // Morning brief shows today's weather; evening brief shows tomorrow's
  // Phase 9: read-through via lib/weather.getWeather — checks weather_daily
  // first, falls back to live Open-Meteo + opportunistic write-through.
  // forecast (the chip in evening mode is prefixed "Tmrw" so it can't be
  // mistaken for current weather).
  const hasLocation = (user.weather_lat != null && user.weather_lng != null);
  const weatherCtx = {
    supabaseUrl: SUPABASE_URL,
    serviceKey:  process.env.SUPABASE_SERVICE_KEY,
    userId:      user.user_id,
    lat:         user.weather_lat,
    lng:         user.weather_lng,
    tz:          user.timezone,
    label:       user.weather_label,
  };
  const weather = (mode === 'morning' && hasLocation)
    ? await getWeather({ ...weatherCtx, date: today })
    : null;
  const weatherTomorrow = (mode === 'evening' && hasLocation)
    ? await getWeather({ ...weatherCtx, date: tomorrow })
    : null;

  // Filter completed tasks to yesterday in user-local TZ
  const yStart = localDayStartUtcMs(yday, user.timezone);
  const yEnd   = yStart + 86400_000;
  const tasksYesterday = (tasksAll || []).filter(t => t.completed_at && t.completed_at >= yStart && t.completed_at < yEnd);

  // Oura freshness. Two failure modes:
  //
  //   1. Row missing or stale by wall-clock (>24h since updated_at) — the
  //      classic "Oura hasn't synced at all" case. Brief flagged
  //      preliminary; UI shows generic refresh affordance.
  //
  //   2. Row exists and is recently updated BUT sleep_score is null — the
  //      "partial-fill" case caught 2026-05-27: Oura streamed activity
  //      data overnight but the user hadn't opened the Oura app, so
  //      cloud-side scoring of last night's sleep hasn't happened yet.
  //      Equally preliminary, but the actionable fix is different —
  //      "open the Oura app to push last night" rather than just "tap
  //      refresh." Tagged via _oura_partial_sleep so the UI can render
  //      the more specific hint.
  const recoveryRow = ouraToday?.[0] || null;
  const activityRow = ouraYesterday?.[0] || null;
  const ouraWallClockStale = !recoveryRow
    || !recoveryRow.updated_at
    || (Date.now() - new Date(recoveryRow.updated_at).getTime()) > OURA_STALE_HOURS * 3600_000;
  const ouraPartialSleep = !ouraWallClockStale
    && recoveryRow
    && recoveryRow.sleep_score == null;
  const ouraStale = ouraWallClockStale || ouraPartialSleep;

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

  // Sleep intent (morning mode only) — pull the most recent sleep_intent
  // that's been matched against Oura. If the user tapped "Bed" last
  // night and the cron has computed the delta to Oura's detected onset,
  // surface it on the morning brief so Claude can reference settle time
  // when framing recovery. Skipped on evening briefs (last night's intent
  // already had its morning surfacing) and on briefs with no fresh
  // computed intent. Only the most recent COMPUTED row matters here —
  // unmatched intents (cron hasn't filled the delta yet) are hidden
  // because Claude can't reason about an empty delta.
  let sleepIntentForBrief = null;
  if (mode === 'morning') {
    const cutoffIso = new Date(Date.now() - 18 * 3600_000).toISOString();
    const sleepIntentRows = await fetchJson(
      `${SUPABASE_URL}/rest/v1/sleep_intents`
        + `?user_id=eq.${user.user_id}`
        + `&intent_at=gte.${encodeURIComponent(cutoffIso)}`
        + `&computed_at=not.is.null`
        + `&select=intent_at,oura_detected_onset_at,oura_intent_delta_min`
        + `&order=intent_at.desc&limit=1`,
      hdr,
    );
    const si = sleepIntentRows?.[0];
    if (si && si.oura_intent_delta_min != null) {
      const tz = user.timezone || DEFAULT_TIMEZONE;
      sleepIntentForBrief = {
        intent_local_time:   formatLocalClockTime(si.intent_at, tz),
        onset_local_time:    formatLocalClockTime(si.oura_detected_onset_at, tz),
        // Rounded to whole minutes — sub-minute precision is noise.
        settle_minutes:      Math.round(Number(si.oura_intent_delta_min)),
      };
    }
  }

  // Phase 10 — read this user's efficacy profile from
  // v_user_action_efficacy. Only signatures with >=5 observations are
  // surfaced; the materialized view is refreshed nightly by
  // cron-evaluate-actions.js. Returns [] when there's nothing yet
  // (cold-start: brief runs as today's logic, no efficacy steering).
  const efficacyRowsRaw = await fetchJson(
    `${SUPABASE_URL}/rest/v1/v_user_action_efficacy?user_id=eq.${user.user_id}&n_observations=gte.5&select=recommendation_signature,variant_id,source_metric,n_observations,mean_adherence,mean_delta_t1_when_followed,mean_delta_t1_when_ignored,n_followed,n_ignored,stddev_delta_t1_when_followed`,
    hdr,
  );
  const efficacy_profile = (efficacyRowsRaw || []).map(r => {
    const n          = Number(r.n_observations || 0);
    const stddev     = r.stddev_delta_t1_when_followed != null ? Number(r.stddev_delta_t1_when_followed) : null;
    const confidence = (n >= 20 && stddev != null && stddev < 7) ? 'high'
                     : (n >= 10) ? 'medium' : 'low';
    const round1 = (v) => (v == null ? null : Number(Number(v).toFixed(1)));
    const round2 = (v) => (v == null ? null : Number(Number(v).toFixed(2)));
    return {
      signature:           r.recommendation_signature,
      variant_id:          r.variant_id || null,
      metric:              r.source_metric,
      n:                   n,
      n_followed:          Number(r.n_followed || 0),
      n_ignored:           Number(r.n_ignored || 0),
      adherence:           round2(r.mean_adherence),
      delta_when_followed: round1(r.mean_delta_t1_when_followed),
      delta_when_ignored:  round1(r.mean_delta_t1_when_ignored),
      confidence:          confidence,
    };
  });

  const ctx = {
    user: { timezone: user.timezone, user_id: user.user_id },
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
      // Individual mood check-ins from yesterday with the user's
      // optional reflection notes. Surfaced separately from the
      // rounded-average `mood` field so Claude can quote the user's
      // own words when relevant ("you logged 'rough morning' at 9am").
      mood_checkins: moodCheckinsYesterday,
      reflection: reflection || null,
      tasks_completed_count: tasksYesterday.length,
      tasks_completed_sample: tasksYesterday.slice(0, 10).map(t => t.text).filter(Boolean),
      calendar_events: ((calY?.[0]?.events) || []).slice(0, 8).map(e => ({
        summary: e.summary, start: e.start, allDay: !!e.isAllDay,
      })),
      habits: (() => {
        // Counts come from journal_habit_summary; names come from the
        // catalog ⨯ completions join below. Both can be null on a day
        // with no logged activity — return null only when there's
        // literally nothing to say (no count, no completion).
        const counts = habitsY?.[0] ? { due: habitsY[0].due_count, done: habitsY[0].done_count } : null;
        const byId = {};
        for (const h of (habitsCatalog || [])) byId[h.id] = h;
        const doneNames = (habitCompletionsY || [])
          .map(c => byId[c.habit_id]?.name)
          .filter(Boolean)
          // Stable order so prompt-cache reuse stays high across regens.
          .sort()
          // Cap to keep tokens sane on power-user habit lists.
          .slice(0, 12);
        if (!counts && !doneNames.length) return null;
        // Key the names with their explicit time-window so Claude can't
        // conflate them with "today's habits" in evening mode (where the
        // recap's "Today" column actually carries yesterday's data as a
        // placeholder until midnight).
        return { ...(counts || {}), done_names_yesterday: doneNames };
      })(),
      // Train session logged for yesterday (if any). Summary only — full
      // set list is in train_recent for token-budget reasons.
      workout: summarizeSession(workoutYesterday),
      // Sleep-intent comparison: user-tapped bedtime vs Oura's detected
      // sleep onset for last night. Only populated on morning briefs when
      // the cron has matched the intent against Oura data. Null when no
      // intent was logged, when the cron hasn't computed yet, or when
      // it's an evening brief. Claude uses settle_minutes as the framing
      // signal: <10 = fast (no callout needed), 10-25 = normal,
      // 25+ = long settle (worth surfacing when the night was also low-
      // sleep or low-recovery).
      sleep_intent: sleepIntentForBrief,
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
      // Prefer the most-recent intra-day mood check-in (which the user
      // may have tapped this afternoon/evening) over the journal entry
      // mood (which was likely set this morning and is now stale).
      // mood_checkins is ASC-ordered; the last entry is most recent.
      mood_label: (() => {
        const lastCheckin = moodCheckinsToday[moodCheckinsToday.length - 1];
        if (lastCheckin?.mood_label) return lastCheckin.mood_label;
        return moodLabel(journalToday?.[0]?.mood ?? null);
      })(),
      // Today's individual mood check-ins with optional reflection
      // notes — same shape as yesterday.mood_checkins, scoped to today.
      // Lets the evening brief reference qualitative shifts across
      // the day (morning vs afternoon mood notes).
      mood_checkins:  moodCheckinsToday,
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
    // Internal flag — distinguishes partial-fill staleness ("activity
    // present, sleep null — open the Oura app") from wall-clock staleness
    // ("nothing synced in 24h — tap refresh"). Stripped from the Claude
    // payload in callClaude alongside _oura_stale.
    _oura_partial_sleep: ouraPartialSleep,
    // Phase 10 — internal calibration data. Claude leans into signatures
    // with positive delta_when_followed and away from ones with negative
    // or zero. Empty array during cold-start (≥5 outcomes per signature
    // needed before a row appears). See lib/recommendations.js for how
    // signatures are minted; cron-evaluate-actions.js for how outcomes
    // are scored; v_user_action_efficacy.sql for the rollup.
    efficacy_profile: efficacy_profile,
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
// Phase 9: the local fetchWeather + weatherCodeToText + weatherCodeToEmoji
// moved to lib/weather.js so the new cron-weather-snapshot writer + this
// brief reader share one source. Brief calls getWeather() above, which
// reads from weather_daily first and falls back to live Open-Meteo with
// opportunistic write-through.

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

  // Strip internal flags before sending to Claude
  const { _oura_stale, _oura_partial_sleep, ...payload } = ctx;

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

  // Server-side normalization. Returns { structured, action_stubs } on
  // success, null on rejection.
  const raw = toolUseBlock.input || {};
  const normalized = normalizeStructured(raw, mode, ctx);
  if (normalized === null) {
    console.warn('daily-brief: normalization rejected output (banned phrase or invalid shape), substituting fallback');
    return buildFallback({ reason: 'normalization_rejected', context: ctx, mode });
  }
  const { structured, action_stubs } = normalized;

  // Build flat narrative fallback for legacy clients
  const flatNarrative = buildFlatNarrative(structured);

  return {
    status:            'ok',
    structured,
    action_stubs,
    mode:              mode,
    narrative:         flatNarrative,
    tldr:              null,
    highlights:        [],
    actions:           [],
    confidence:        structured.confidence || 'low',
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
    // Bedtime is fully formulaic now (server decides between 9:30 / 10:00 /
    // 10:30 PM based on recovery + body temp + sickness tags). Do NOT
    // produce sleep_target_time — the field is gone from the tool schema.
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
    '- yesterday.mood_checkins / today_recap.mood_checkins = individual mood entries with optional user reflection notes (e.g. "rough morning, slept badly"). When a note carries a clear theme that connects to other data (low HRV + "anxious meeting day"), reference it in subhead/pills using neutral paraphrase — NEVER quote the user\'s words verbatim back at them in the headline. Mood notes alone aren\'t enough to override the wearable signal but they sharpen the "why" framing.',
    '- yesterday.habits.done_names_yesterday = specific habits the user completed YESTERDAY (e.g. "Reading / Podcast", "10k steps"). The field name carries the time window explicitly — these are NOT today\'s habits. Use ONLY when there\'s a clean tie-in to the day\'s framing (reading streak + better sleep, missed workout + low activity). Reference by name in subhead/pills, never the headline. If no meaningful connection, ignore — listing habit names alone is noise.',
    // Strict guards — these explicitly forbid the "habits sealed a clean
    // day" / "full habits" / "all habits done" hallucinations we kept
    // hitting. The recap's deterministic count is the source of truth;
    // Claude must not contradict it.
    '- NEVER claim "full habits", "all habits sealed", "closed all habits", "every habit done", or equivalent unless yesterday.habits.done >= yesterday.habits.due. If you can\'t verify that from the data, omit any habit-completion claim entirely.',
    '- EVENING MODE specifically: the recap\'s LEFT column ("Today") shows yesterday\'s habit count as a placeholder — today\'s count is not finalized until after midnight. Do NOT write headline/subhead/pills claiming today\'s habits sealed, closed, or completed. You do not know today\'s habit outcome at evening-brief time.',
    '- yesterday.sleep_intent = the user\'s self-reported bedtime + Oura\'s detected sleep onset + the gap in minutes between them (settle_minutes). Present only on morning briefs and only when both the tap and Oura\'s data exist. Use settle_minutes as the framing signal: <10 = fast, 10-25 = normal (no callout), 25+ = long settle. Surface in subhead/pills ONLY when settle_minutes >= 25 AND the night also had poor sleep_score or low recovery — combined signal that the user was trying to wind down but the body wasn\'t cooperating. Phrase as "took ~30 min to fall asleep" or "long settle time" — never quote the exact intent_local_time back at the user; they tapped it, they don\'t need to read it again. Skip entirely when sleep_intent is null or settle_minutes is small.',
    coldStart
      ? `COLD-START: only ${baselineN} days of baseline data. Skip evidence_pills entirely. Set confidence="low". Keep headline factual, no comparative claims.`
      : '',
    // Phase 10 — efficacy profile addendum. Only added when there's at
    // least one signature with the minimum sample size. Tells Claude
    // which of the system's past recommendations have actually moved
    // the target metric for THIS user — so the brief reinforces
    // patterns the data shows are working and de-emphasizes ones that
    // aren't. Never surfaced to the user in copy.
    (Array.isArray(ctx.efficacy_profile) && ctx.efficacy_profile.length > 0)
      ? 'RESPONSE PROFILE: efficacy_profile in your context lists the system\'s past recommendation signatures with measured outcomes for this user — adherence rate, mean delta of the source_metric when followed (≥0.7 score) vs when ignored (≤0.3). Treat positive delta_when_followed as evidence the recommendation TYPE is working for them; negative or zero deltas mean the recommendation isn\'t landing and should be deprioritized in headline/subhead framing. NEVER mention efficacy_profile or its numbers in your output — this is internal calibration only. Do not name signatures back to the user.'
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
    // sleep_target_time was previously a Claude-produced field. Now the
    // bedtime is fully formulaic (lib/recommendations.recommendSleepTarget)
    // so the model no longer produces it — keeping the tool schema lean.
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

  // Habit-claim contradiction guard. If Claude's prose claims "all/full
  // habits sealed/done/closed" but the deterministic count says fewer
  // than all were completed, that's a hallucination — reject and fall
  // back. The prompt forbids this phrasing but Claude still hits it
  // occasionally; this is the validator layer.
  const HABIT_FULL_CLAIM = /\b(all|full|every)\s+habits?\b|\bhabits?\s+(sealed|closed|completed)\b|\bsealed\s+(a|the)\s+(clean|full)\s+day\b/i;
  if (HABIT_FULL_CLAIM.test(claudeText)) {
    const habits = ctx.yesterday?.habits;
    const allDone = habits && habits.due > 0 && Number(habits.done) >= Number(habits.due);
    if (!allDone) {
      console.warn('daily-brief: habit-completion claim contradicts data, rejecting:',
        { claudeText: claudeText.slice(0, 200), habits });
      return null;
    }
  }

  // ── Server-built factual blocks ────────────────────────────────────────
  const heroKey      = HERO_METRIC_KEYS.includes(raw.hero_metric_key) ? raw.hero_metric_key : null;
  const hero_metric  = buildHeroMetric(heroKey, ctx);
  const stats        = buildStats(hero_metric.key, ctx);
  const weatherSrc   = mode === 'evening' ? ctx.tomorrow_plan?.weather : ctx.today_plan?.weather;
  const weather_chip = buildWeatherChip(weatherSrc, mode);
  // Fully deterministic sleep target — Claude's output is no longer
  // considered. recommendSleepTarget picks between 9:30 / 10:00 / 10:30 PM
  // based on recovery + body-temp deviation + logged sickness tags.
  // Phase 10 — returns {value, variant_id, signature, regime, conditions}.
  // value is the legacy string; variant_id is non-null only when
  // pickVariant fired (currently the readiness 61–75 ambiguous band).
  const sleepRec = recommendSleepTarget({
    recovery:    ctx.yesterday?.recovery,
    activity:    ctx.yesterday?.activity,
    tags:        ctx.yesterday?.tags,
    baselines7d: ctx.baselines_7d,
    seed:        `${ctx.user?.user_id || 'anon'}|${ctx.brief_date || ''}|${mode}`,
  });
  const sleepTarget = sleepRec.value;
  const recap       = buildRecap(mode, ctx, sleepTarget);

  const confidence = ['high', 'medium', 'low'].includes(raw.confidence) ? raw.confidence : 'low';

  return {
    structured: {
      mode,
      weather_chip,
      headline,
      subhead,
      hero_metric,
      stats,
      evidence_pills: pills,
      recap,
      confidence,
    },
    action_stubs: buildActionStubs(sleepRec, mode, ctx),
  };
}

// Phase 10 — turn deterministic recommendation outputs into outcome
// stubs the cron later fills in. Only known signatures get stubs;
// the bedtime_target row is the one universally-present recommendation
// today (every brief sets a sleep target). Future entries
// (intensity_reduce, habit_focus, push_workout) wire in here once their
// recommendation functions exist.
function buildActionStubs(sleepRec, mode, ctx) {
  const stubs = [];
  if (sleepRec && sleepRec.signature) {
    // Baseline: today's sleep_score (the night that just ended). T+1
    // outcome read by cron-evaluate-actions will be tomorrow's
    // sleep_score (the night after the bedtime is acted on) — that's
    // the metric the recommendation is trying to move.
    const baselineSleep = ctx.yesterday?.recovery?.sleep_score ?? null;
    stubs.push({
      action_index:             0,
      recommendation_signature: sleepRec.signature,
      variant_id:               sleepRec.variant_id || null,
      source_metric:            'sleep_score',
      baseline_value:           baselineSleep != null ? Number(baselineSleep) : null,
      conditions_snapshot:      {
        regime:    sleepRec.regime || null,
        ...(sleepRec.conditions || {}),
      },
    });
  }
  return stubs;
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
  const sleepRec = recommendSleepTarget({
    recovery:    ctxSafe.yesterday?.recovery,
    activity:    ctxSafe.yesterday?.activity,
    tags:        ctxSafe.yesterday?.tags,
    baselines7d: ctxSafe.baselines_7d,
    seed:        `${ctxSafe.user?.user_id || 'anon'}|${ctxSafe.brief_date || ''}|${mode}|fallback`,
  });
  const serverSleepTarget = sleepRec.value;
  const recap             = buildRecap(mode, ctxSafe, serverSleepTarget);

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
    action_stubs:      buildActionStubs(sleepRec, mode, ctxSafe),
    mode,
    narrative:         buildFlatNarrative(structured),
    tldr:              null,
    highlights:        [],
    actions:           [],
    confidence:        'low',
    model:             null,
    prompt_tokens:     null,
    completion_tokens: null,
    input_snapshot:    context ? (() => { const { _oura_stale, _oura_partial_sleep, ...p } = context; return p; })() : null,
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

// ── Phase 10: action stub recording ───────────────────────────────────────
// Insert one brief_action_outcomes row per recognized recommendation in
// the brief. Idempotent via the (brief_id, action_index) UNIQUE — a
// force-regen of the same brief upserts the same stub rather than
// duplicating. cron-evaluate-actions.js fills in adherence_score (next
// morning) and value_at_t_plus_1 / value_at_t_plus_3 (over 3 days),
// then sets computed_at. Once computed_at is set, v_user_action_efficacy
// picks the row up on the nightly refresh.
async function recordActionStubs(briefId, user, briefDate, briefMode, stubs, serviceKey) {
  if (!Array.isArray(stubs) || stubs.length === 0) return;
  const rows = stubs.map((s, i) => ({
    user_id:                  user.user_id,
    brief_id:                 briefId,
    brief_date:               briefDate,
    brief_mode:               briefMode,
    action_index:             s.action_index ?? i,
    recommendation_signature: s.recommendation_signature,
    variant_id:               s.variant_id || null,
    source_metric:            s.source_metric,
    baseline_value:           s.baseline_value ?? null,
    baseline_value_text:      s.baseline_value_text || null,
    conditions_snapshot:      s.conditions_snapshot || null,
  }));
  const url = `${SUPABASE_URL}/rest/v1/brief_action_outcomes?on_conflict=brief_id,action_index`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      apikey:          serviceKey,
      Authorization:   `Bearer ${serviceKey}`,
      Prefer:          'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`brief_action_outcomes upsert failed: ${r.status} ${text.slice(0, 200)}`);
  }
}


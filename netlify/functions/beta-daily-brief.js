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

// GSD mood scale: 1=best, 5=worst. We send labels (not integers) to Claude.
const MOOD_LABELS = { 1: 'Great', 2: 'Good', 3: 'Okay', 4: 'Low', 5: 'Bad' };
const MOOD_SCALE_NOTE = 'GSD mood scale: 1=Great (best), 2=Good, 3=Okay, 4=Low, 5=Bad (worst). Lower numbers are better.';
function moodLabel(v) {
  if (v == null) return null;
  const k = Math.round(Number(v));
  return MOOD_LABELS[k] || `Unknown(${v})`;
}

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
    return cors(json(200, stored));
  } catch (err) {
    console.error('daily-brief handler error:', err.message);
    return cors(json(500, { error: 'internal_error', detail: err.message }));
  }
};

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
async function resolveUser({ email, user_id }, serviceKey) {
  const sel = 'supabase_user_id,email,timezone,city,weather_lat,weather_lng,weather_label';
  const url = email
    ? `${SUPABASE_URL}/rest/v1/user_profiles?email=eq.${encodeURIComponent(email)}&select=${sel}`
    : `${SUPABASE_URL}/rest/v1/user_profiles?supabase_user_id=eq.${user_id}&select=${sel}`;
  const r = await fetch(url, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`user_profile_lookup_failed: HTTP ${r.status} ${text.slice(0, 200)}`);
  }
  const rows = await r.json();
  if (!Array.isArray(rows)) {
    throw new Error(`user_profile_lookup_unexpected: ${JSON.stringify(rows).slice(0, 200)}`);
  }
  const row = rows[0];
  if (!row) throw new Error(`user_profile_not_found_for_${email || user_id}`);
  return {
    email:         row.email,
    user_id:       row.supabase_user_id || user_id,
    timezone:      row.timezone || DEFAULT_TIMEZONE,
    weather_lat:   row.weather_lat   ?? null,
    weather_lng:   row.weather_lng   ?? null,
    weather_label: row.weather_label || row.city || null,
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

  const [
    ouraToday, ouraYesterday, whoopY, oTagsY, oWorkoutsY, journalY, tasksAll,
    calY, calT, habitsY, baselines30, baselines7, tasksTopOpen,
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
    },
    today_plan: {
      date: today,
      weekday: weekdayName,
      weather: weather,
      calendar_events: ((calT?.[0]?.events) || []).slice(0, 8).map(e => ({
        summary: e.summary, start: e.start, allDay: !!e.isAllDay,
      })),
      priority_tasks: (tasksTopOpen || []).map(t => ({ text: t.text })),
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
      tasks_completed_today: countTasksInLocalDay(tasksAll, today, user.timezone),
      open_priority_tasks:   (tasksTopOpen || []).length,
    } : null,
    last_7_days: {
      oura: oura7 || [],
      mood: moodWeek,
      habits: habits7 || [],
      tag_counts: tagCounts,
    },
    baselines_7d:  baseline7,
    baselines_30d: baseline30,
    hero_hint: hero_hint,   // server's pick for the hero ring; Claude may keep or override (within enum)
    _oura_stale: ouraStale,
  };

  return ctx;
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
    return {
      location:    label || null,
      temp_high_f: d.temperature_2m_max?.[0] ?? null,
      temp_low_f:  d.temperature_2m_min?.[0] ?? null,
      condition:   weatherCodeToText(d.weather_code?.[0]),
      sunrise:     d.sunrise?.[0] ?? null,
      sunset:      d.sunset?.[0] ?? null,
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

// "64° · Pelham" (morning) or "Tmrw 64° · Pelham" (evening, forecast).
// Null when no weather data. The "Tmrw" prefix prevents the chip from being
// read as current weather when it's actually tomorrow's forecast.
function buildWeatherChip(weather, mode) {
  if (!weather || weather.temp_high_f == null) return null;
  const temp = `${Math.round(weather.temp_high_f)}°`;
  const place = (weather.location || '').split(',')[0].trim();
  const core = place ? `${temp} · ${place}` : temp;
  return mode === 'evening' ? `Tmrw ${core}` : core;
}

// Pick the hero metric: respect Claude's override if valid, else use the
// largest-deviation server hint. Always fill value/label/delta from raw data.
function buildHeroMetric(claudeKey, ctx) {
  const allowed = HERO_METRIC_KEYS.includes(claudeKey) ? claudeKey : (ctx.hero_hint || 'readiness_score');
  const r = ctx.yesterday?.recovery || {};
  const a = ctx.yesterday?.activity || {};
  const b7 = ctx.baselines_7d || {};
  let value = null, baseline = null;
  if (allowed === 'sleep_score')     { value = r.sleep_score;     baseline = b7.sleep_score_median; }
  if (allowed === 'readiness_score') { value = r.readiness_score; baseline = b7.readiness_score_median; }
  if (allowed === 'activity_score')  { value = a.activity_score;  baseline = b7.activity_score_median; }
  const delta = (value != null && baseline != null) ? Math.round(Number(value) - Number(baseline)) : 0;
  return {
    key: allowed,
    value: value == null ? 0 : Math.round(Number(value)),
    label: HERO_METRIC_LABELS[allowed] || allowed.toUpperCase(),
    delta_vs_7d: delta,
  };
}

// Build the stats list (Sleep, Activity, Resting HR, HRV) — exclude the hero
// metric. All numbers are pulled from the raw recovery/activity rows. Deltas
// are computed against the 7-day baseline. Notes are computed for special
// cases (sleep score, HRV banding, RHR elevation).
function buildStats(heroKey, ctx) {
  const r  = ctx.yesterday?.recovery || {};
  const a  = ctx.yesterday?.activity || {};
  const b7 = ctx.baselines_7d || {};
  const fmtDelta = (today, base) => {
    if (today == null || base == null) return null;
    const d = Math.round(Number(today) - Number(base));
    if (d === 0) return null;
    return d > 0 ? `↑${d}` : `↓${Math.abs(d)}`;
  };
  const rows = [];

  // Sleep row: duration as value, score as note (if available)
  if (heroKey !== 'sleep_score' && (r.total_sleep_min != null || r.sleep_score != null)) {
    const dur = formatMinutes(r.total_sleep_min);
    rows.push({
      label: 'Sleep',
      value: dur || (r.sleep_score != null ? String(r.sleep_score) : '—'),
      delta: fmtDelta(r.total_sleep_min, b7.total_sleep_min_median),
      note:  (dur && r.sleep_score != null) ? `score ${r.sleep_score}` : null,
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
      note = `${a.steps.toLocaleString()} steps`;
    }
    rows.push({
      label: 'Activity',
      value: a.activity_score != null ? String(a.activity_score) : '—',
      delta: fmtDelta(a.activity_score, b7.activity_score_median),
      note,
    });
  }

  // Readiness row (only if not the hero)
  if (heroKey !== 'readiness_score' && r.readiness_score != null) {
    rows.push({
      label: 'Readiness',
      value: String(r.readiness_score),
      delta: fmtDelta(r.readiness_score, b7.readiness_score_median),
      note:  null,
    });
  }

  // Resting HR row: number as value, "elevated" / "+N vs norm" as note
  if (r.resting_hr != null) {
    const diff = b7.resting_hr_median != null ? Math.round(r.resting_hr - Number(b7.resting_hr_median)) : null;
    let note = null;
    if (diff != null && diff > 5) note = 'elevated';
    else if (diff != null && diff < -5) note = 'low';
    rows.push({
      label: 'Resting HR',
      value: String(Math.round(r.resting_hr)),
      delta: fmtDelta(r.resting_hr, b7.resting_hr_median),
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
    rows.push({
      label: 'HRV',
      value: String(Math.round(r.hrv_ms)),
      delta: fmtDelta(r.hrv_ms, b7.hrv_ms_median),
      note,
    });
  }

  return rows.slice(0, 4);
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
    // Priority tasks — ONE row, verbatim titles joined with " · " (max 2)
    const tasks = (ctx.today_plan?.priority_tasks || []).slice(0, 2);
    if (tasks.length > 0) {
      const titles = tasks.map(t => String(t.text || '').trim()).filter(Boolean);
      if (titles.length > 0) {
        const allTasks = ctx.today_plan?.priority_tasks || [];
        rows.push({
          icon:    'tasks',
          scope:   `${allTasks.length} task${allTasks.length === 1 ? '' : 's'}`,
          content: titles.join(' · '),
        });
      }
    }
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
      if (recap.tasks_completed_today > 0) parts.push(`${recap.tasks_completed_today} done`);
      if (recap.open_priority_tasks > 0)   parts.push(`${recap.open_priority_tasks} open`);
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
    // Persistent priority tasks (carry into tomorrow)
    const tasks = (ctx.tomorrow_plan?.priority_tasks || []).slice(0, 2);
    if (tasks.length > 0) {
      const titles = tasks.map(t => String(t.text || '').trim()).filter(Boolean);
      if (titles.length > 0) {
        const allTasks = ctx.tomorrow_plan?.priority_tasks || [];
        rows.push({
          icon:    'tasks',
          scope:   `${allTasks.length} task${allTasks.length === 1 ? '' : 's'}`,
          content: titles.join(' · '),
        });
      }
    }
  }

  return rows.slice(0, 5);
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
    `- mood values arrive as labels (Great/Good/Okay/Low/Bad). ${MOOD_SCALE_NOTE}`,
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
  const sleepTarget  = raw.sleep_target_time ? String(raw.sleep_target_time).trim().slice(0, 24) : null;
  const playRows     = buildPlayRows(mode, ctx, sleepTarget);
  const playKey      = mode === 'morning' ? 'today_play' : 'tomorrow_setup';

  const confidence = ['high', 'medium', 'low'].includes(raw.confidence) ? raw.confidence : 'low';

  return {
    mode,
    weather_chip,
    headline,
    subhead,
    hero_metric,
    stats,
    evidence_pills: pills,
    [playKey]: playRows,
    confidence,
  };
}

// Flatten structured output into a plain-text narrative for legacy clients
// that don't read the structured column.
function buildFlatNarrative(s) {
  const lines = [s.headline, s.subhead];
  if (s.evidence_pills?.length) lines.push(s.evidence_pills.join(' · '));
  const playKey = s.mode === 'morning' ? 'today_play' : 'tomorrow_setup';
  if (Array.isArray(s[playKey]) && s[playKey].length) {
    lines.push((s.mode === 'morning' ? "Today's Play:" : "Tomorrow's Setup:"));
    for (const r of s[playKey]) lines.push(`  ${r.scope} — ${r.content}`);
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
  const playKey      = mode === 'morning' ? 'today_play' : 'tomorrow_setup';
  const playRows     = buildPlayRows(mode, ctxSafe, null);

  const structured = {
    mode,
    weather_chip,
    headline:       mode === 'morning' ? 'Brief unavailable.' : 'Wrap-up unavailable.',
    subhead:        'Generate again when ready.',
    hero_metric,
    stats,
    evidence_pills: [],
    [playKey]:      playRows,
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

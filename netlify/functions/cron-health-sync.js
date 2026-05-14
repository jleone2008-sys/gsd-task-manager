// Daily Whoop + Oura sync. Two modes:
//
//   1. Scheduled (no query params): iterate every user_profiles row with a
//      refresh token for Whoop and/or Oura, pull the last 3 days of metrics,
//      upsert into whoop_daily / oura_daily. Runs once a day via netlify.toml.
//
//   2. Backfill (?backfill=1&user=<email>&provider=<whoop|oura>&days=<N>):
//      one-user, longer window. Triggered by the OAuth callback right after a
//      user connects, so they have history immediately rather than waiting
//      until tomorrow's scheduled run. Requires X-Internal-Auth header.
//
// Refresh tokens: Whoop rotates the refresh token on every exchange, so a
// successful exchange re-encrypts and re-stores. Oura's refresh token is
// stable but we re-store anyway in case that changes.

const { createCipheriv, createDecipheriv, randomBytes } = require('crypto');

const SUPABASE_URL    = 'https://dmuwncwptvnnlizuxhta.supabase.co';
const WHOOP_TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token';
const WHOOP_API       = 'https://api.prod.whoop.com/developer';
const OURA_TOKEN_URL  = 'https://api.ouraring.com/oauth/token';
const OURA_API        = 'https://api.ouraring.com/v2/usercollection';

exports.handler = async (event) => {
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  const encKey     = process.env.ADMIN_ENCRYPTION_KEY;
  if (!serviceKey || !encKey) {
    console.error('cron-health-sync: missing SUPABASE_SERVICE_KEY or ADMIN_ENCRYPTION_KEY');
    return { statusCode: 500, body: 'misconfigured' };
  }

  const q = event.queryStringParameters || {};
  const isBackfill = q.backfill === '1';

  if (isBackfill) {
    const expected = process.env.INTERNAL_FN_SECRET || '';
    const got      = event.headers['x-internal-auth'] || event.headers['X-Internal-Auth'] || '';
    if (!expected || got !== expected) {
      return { statusCode: 403, body: 'forbidden' };
    }
    const email    = q.user;
    const provider = q.provider;
    const days     = Math.min(parseInt(q.days || '30', 10) || 30, 90);
    if (!email || !['whoop','oura'].includes(provider)) {
      return { statusCode: 400, body: 'bad_params' };
    }
    try {
      const result = await syncOneUser(email, provider, days, serviceKey, encKey);
      return { statusCode: 200, body: JSON.stringify(result) };
    } catch (err) {
      console.error('backfill failed:', err.message);
      return { statusCode: 500, body: err.message };
    }
  }

  // Scheduled mode: sync everyone with a refresh token, 3-day rolling window
  const window = 3;
  const summary = { whoop: { ok: 0, fail: 0 }, oura: { ok: 0, fail: 0 } };

  for (const provider of ['whoop','oura']) {
    const col = provider === 'whoop' ? 'whoop_refresh_token_enc' : 'oura_refresh_token_enc';
    let users;
    try {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/user_profiles?select=email,${col}&${col}=not.is.null`,
        { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
      );
      users = await r.json();
    } catch (err) {
      console.error(`${provider} user list fetch failed:`, err.message);
      continue;
    }
    if (!Array.isArray(users)) {
      console.error(`${provider} user list non-array response:`, users);
      continue;
    }

    for (const u of users) {
      try {
        await syncOneUser(u.email, provider, window, serviceKey, encKey);
        summary[provider].ok++;
      } catch (err) {
        summary[provider].fail++;
        console.error(`${provider} sync for ${u.email} failed:`, err.message);
      }
    }
  }

  return { statusCode: 200, body: JSON.stringify(summary) };
};

// ── Per-user sync ────────────────────────────────────────────────────────
async function syncOneUser(email, provider, days, serviceKey, encKey) {
  const end   = new Date();
  const start = new Date(Date.now() - days * 86400_000);
  let rowsUpserted = 0, error = null;

  try {
    if (provider === 'whoop') {
      rowsUpserted = await syncWhoopUser(email, start, end, serviceKey, encKey);
    } else {
      rowsUpserted = await syncOuraUser(email, start, end, serviceKey, encKey);
    }
  } catch (err) {
    error = err.message;
    throw err;
  } finally {
    await logRun(email, provider, !error, error, rowsUpserted, start, end, serviceKey).catch(() => {});
  }
  return { email, provider, rowsUpserted };
}

// ── Whoop ─────────────────────────────────────────────────────────────────
async function syncWhoopUser(email, start, end, serviceKey, encKey) {
  // Per-user credentials: load refresh token AND the user's own client_id +
  // encrypted client_secret. They register their own Whoop dev app at
  // developer.whoop.com and store credentials via beta-whoop-creds.js.
  const profRes = await fetch(
    `${SUPABASE_URL}/rest/v1/user_profiles?email=eq.${encodeURIComponent(email)}&select=whoop_refresh_token_enc,whoop_client_id,whoop_client_secret_enc`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
  );
  const profRows = await profRes.json();
  const row = profRows?.[0];
  if (!row?.whoop_refresh_token_enc) throw new Error('no_refresh_token');
  if (!row?.whoop_client_id || !row?.whoop_client_secret_enc) throw new Error('no_credentials');
  const refreshToken = decryptToken(row.whoop_refresh_token_enc, encKey);
  const clientId     = row.whoop_client_id;
  const clientSec    = decryptToken(row.whoop_client_secret_enc, encKey);

  // Exchange refresh → access token (Whoop rotates refresh; capture both)
  const tr = await fetch(WHOOP_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
      client_id:     clientId,
      client_secret: clientSec,
      scope:         'offline',
    }),
  });
  const tk = await tr.json();
  if (!tk.access_token) throw new Error(`whoop_token_exchange: ${tk.error || 'unknown'}`);
  if (tk.refresh_token && tk.refresh_token !== refreshToken) {
    await patchUserProfile(email, { whoop_refresh_token_enc: encryptToken(tk.refresh_token, encKey) }, serviceKey);
  }
  const accessToken = tk.access_token;

  const startIso = start.toISOString();
  const endIso   = end.toISOString();
  const authHdr  = { Authorization: `Bearer ${accessToken}` };

  const [cycles, recoveries, sleeps] = await Promise.all([
    whoopPaginate(`${WHOOP_API}/v1/cycle?start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}`, authHdr),
    whoopPaginate(`${WHOOP_API}/v1/recovery?start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}`, authHdr),
    whoopPaginate(`${WHOOP_API}/v1/activity/sleep?start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}`, authHdr),
  ]);

  // Index by cycle_id for join
  const recByCycle = new Map();
  for (const r of recoveries) if (r?.cycle_id != null) recByCycle.set(String(r.cycle_id), r);

  // Pick the longest non-nap sleep per date as the day's main sleep
  const sleepByDate = new Map();
  for (const s of sleeps) {
    if (s?.nap) continue;
    const day = dayKeyFromIso(s?.end || s?.start);
    if (!day) continue;
    const dur = s?.score?.stage_summary?.total_in_bed_time_milli || 0;
    const existing = sleepByDate.get(day);
    if (!existing || dur > (existing?.score?.stage_summary?.total_in_bed_time_milli || 0)) {
      sleepByDate.set(day, s);
    }
  }

  const rows = [];
  for (const c of cycles) {
    const day = dayKeyFromIso(c?.start);
    if (!day) continue;
    const rec = recByCycle.get(String(c.id));
    const slp = sleepByDate.get(day);
    const recScore = rec?.score || {};
    const slpScore = slp?.score || {};
    const slpStage = slpScore.stage_summary || {};

    rows.push({
      user_email:             email,
      date:                   day,
      cycle_id:               c.id != null ? String(c.id) : null,
      recovery_score:         intOrNull(recScore.recovery_score),
      hrv_ms:                 numOrNull(recScore.hrv_rmssd_milli),
      resting_hr:             intOrNull(recScore.resting_heart_rate),
      spo2_percent:           numOrNull(recScore.spo2_percentage),
      skin_temp_c:            numOrNull(recScore.skin_temp_celsius),
      strain:                 numOrNull(c?.score?.strain),
      sleep_duration_min:     slpStage.total_in_bed_time_milli != null ? Math.round(slpStage.total_in_bed_time_milli / 60000) : null,
      sleep_performance:      intOrNull(slpScore.sleep_performance_percentage),
      sleep_efficiency:       intOrNull(slpScore.sleep_efficiency_percentage),
      sleep_consistency:      intOrNull(slpScore.sleep_consistency_percentage),
      sleep_respiratory_rate: numOrNull(slpScore.respiratory_rate),
      raw:                    { cycle: c, recovery: rec || null, sleep: slp || null },
      updated_at:             new Date().toISOString(),
    });
  }

  if (rows.length === 0) return 0;
  await upsert('whoop_daily', rows, serviceKey);
  return rows.length;
}

async function whoopPaginate(baseUrl, authHdr) {
  const all = [];
  let url = baseUrl + '&limit=25';
  // Cap pagination to prevent runaway loops (3 days of data is <<25 pages even for power users)
  for (let i = 0; i < 12; i++) {
    const r = await fetch(url, { headers: authHdr });
    if (!r.ok) throw new Error(`whoop ${baseUrl} HTTP ${r.status}`);
    const j = await r.json();
    if (Array.isArray(j?.records)) all.push(...j.records);
    if (!j?.next_token) break;
    url = baseUrl + `&limit=25&nextToken=${encodeURIComponent(j.next_token)}`;
  }
  return all;
}

// ── Oura ──────────────────────────────────────────────────────────────────
// Pulls every V2 endpoint Oura exposes for personal-tier apps. Endpoints the
// user's app scopes don't cover (403) are skipped silently; the rest of the
// sync proceeds. See docs/health-integrations.md for the full data inventory.
async function syncOuraUser(email, start, end, serviceKey, encKey) {
  const clientId  = process.env.BETA_OURA_CLIENT_ID;
  const clientSec = process.env.BETA_OURA_CLIENT_SECRET;
  if (!clientId || !clientSec) throw new Error('oura_misconfigured');

  const profRes = await fetch(
    `${SUPABASE_URL}/rest/v1/user_profiles?email=eq.${encodeURIComponent(email)}&select=oura_refresh_token_enc`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
  );
  const profRows = await profRes.json();
  const enc = profRows?.[0]?.oura_refresh_token_enc;
  if (!enc) throw new Error('no_refresh_token');
  const refreshToken = decryptToken(enc, encKey);

  const tr = await fetch(OURA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
      client_id:     clientId,
      client_secret: clientSec,
    }),
  });
  const tk = await tr.json();
  if (!tk.access_token) throw new Error(`oura_token_exchange: ${tk.error || 'unknown'}`);
  if (tk.refresh_token && tk.refresh_token !== refreshToken) {
    await patchUserProfile(email, { oura_refresh_token_enc: encryptToken(tk.refresh_token, encKey) }, serviceKey);
  }
  const accessToken = tk.access_token;

  const startDay = dateKey(start);
  const endDay   = dateKey(end);
  const qs = `?start_date=${startDay}&end_date=${endDay}`;
  const authHdr = { Authorization: `Bearer ${accessToken}` };
  const opt = { tolerate403: true };

  // Daily-aggregate endpoints + per-event endpoints, fetched in parallel
  const [
    readiness, sleepDaily, activity, spo2Daily, stressDaily, resilience, cvAge, vo2Max,
    sleepDetail, workouts, sessions, tags, ringConfig,
  ] = await Promise.all([
    ouraFetch(`${OURA_API}/daily_readiness${qs}`,           authHdr),
    ouraFetch(`${OURA_API}/daily_sleep${qs}`,               authHdr),
    ouraFetch(`${OURA_API}/daily_activity${qs}`,            authHdr),
    ouraFetch(`${OURA_API}/daily_spo2${qs}`,                authHdr, opt),
    ouraFetch(`${OURA_API}/daily_stress${qs}`,              authHdr, opt),
    ouraFetch(`${OURA_API}/daily_resilience${qs}`,          authHdr, opt),
    ouraFetch(`${OURA_API}/daily_cardiovascular_age${qs}`,  authHdr, opt),
    ouraFetch(`${OURA_API}/vO2_max${qs}`,                   authHdr, opt),
    ouraFetch(`${OURA_API}/sleep${qs}`,                     authHdr),
    ouraFetch(`${OURA_API}/workout${qs}`,                   authHdr),
    ouraFetch(`${OURA_API}/session${qs}`,                   authHdr),
    ouraFetch(`${OURA_API}/enhanced_tag${qs}`,              authHdr, opt),
    ouraFetch(`${OURA_API}/ring_configuration`,             authHdr, opt),
  ]);

  // Heart rate uses datetime, not date. Pull only the last 24h on nightly to
  // keep storage bounded (1 day ≈ 288 samples at 5-min interval per user).
  const hrEnd   = end.toISOString();
  const hrStart = new Date(end.getTime() - 86400_000).toISOString();
  const heartrate = await ouraFetch(
    `${OURA_API}/heartrate?start_datetime=${encodeURIComponent(hrStart)}&end_datetime=${encodeURIComponent(hrEnd)}`,
    authHdr, opt
  );

  // ── Build oura_daily byDay map ─────────────────────────────────────────
  const byDay = new Map();
  const get = (day) => {
    if (!byDay.has(day)) byDay.set(day, { date: day });
    return byDay.get(day);
  };

  for (const r of readiness) {
    const d = get(r.day);
    const c = r.contributors || {};
    d.readiness_score                  = intOrNull(r.score);
    d.body_temp_deviation_c            = numOrNull(r.temperature_deviation);
    d.temperature_trend_deviation_c    = numOrNull(r.temperature_trend_deviation);
    d.readiness_activity_balance       = intOrNull(c.activity_balance);
    d.readiness_body_temperature       = intOrNull(c.body_temperature);
    d.readiness_hrv_balance            = intOrNull(c.hrv_balance);
    d.readiness_previous_day_activity  = intOrNull(c.previous_day_activity);
    d.readiness_previous_night         = intOrNull(c.previous_night);
    d.readiness_recovery_index         = intOrNull(c.recovery_index);
    d.readiness_resting_hr             = intOrNull(c.resting_heart_rate);
    d.readiness_sleep_balance          = intOrNull(c.sleep_balance);
    d._readiness_raw = r;
  }
  for (const s of sleepDaily) {
    const d = get(s.day);
    d.sleep_score      = intOrNull(s.score);
    d.sleep_timing_score = intOrNull(s?.contributors?.timing);
    d.sleep_restfulness_score = intOrNull(s?.contributors?.restfulness);
    d._sleep_daily_raw = s;
  }
  for (const a of activity) {
    const d = get(a.day);
    d.activity_score                    = intOrNull(a.score);
    d.steps                             = intOrNull(a.steps);
    d.active_calories                   = intOrNull(a.active_calories);
    d.total_calories                    = intOrNull(a.total_calories);
    d.activity_total_seconds            = intOrNull(a.total);
    d.high_activity_seconds             = intOrNull(a.high_activity_time);
    d.medium_activity_seconds           = intOrNull(a.medium_activity_time);
    d.low_activity_seconds              = intOrNull(a.low_activity_time);
    d.non_wear_seconds                  = intOrNull(a.non_wear_time);
    d.sedentary_seconds                 = intOrNull(a.sedentary_time);
    d.target_calories                   = intOrNull(a.target_calories);
    d.target_meters                     = intOrNull(a.target_meters);
    d.equivalent_walking_distance_meters= intOrNull(a.equivalent_walking_distance);
    d.inactivity_alerts                 = intOrNull(a.inactivity_alerts);
    d.met_average                       = numOrNull(a?.met?.average);
    d._activity_raw = a;
  }
  for (const s of spo2Daily) {
    const d = get(s.day);
    d.spo2_percent = numOrNull(s?.spo2_percentage?.average);
    d._spo2_raw = s;
  }
  for (const s of stressDaily) {
    const d = get(s.day);
    d.stress_high_seconds     = intOrNull(s.stress_high);
    d.stress_recovery_seconds = intOrNull(s.recovery_high);
    d.stress_day_summary      = s.day_summary || null;
    d._stress_raw = s;
  }
  for (const r of resilience) {
    const d = get(r.day);
    d.resilience_level = r.level || null;
    d._resilience_raw = r;
  }
  for (const c of cvAge) {
    const d = get(c.day);
    d.cardiovascular_age = intOrNull(c.vascular_age);
    d._cvage_raw = c;
  }
  for (const v of vo2Max) {
    const d = get(v.day);
    d.vo2_max = numOrNull(v.vo2_max);
    d._vo2_raw = v;
  }

  // Pick longest non-rest sleep per day for the denormalized fields on oura_daily.
  // Full per-sleep detail (including naps) goes into oura_sleep_periods below.
  const longestByDay = new Map();
  for (const s of sleepDetail) {
    if (s?.type === 'rest') continue;
    const dur = s?.total_sleep_duration || 0;
    const existing = longestByDay.get(s.day);
    if (!existing || dur > (existing.total_sleep_duration || 0)) longestByDay.set(s.day, s);
  }
  for (const [day, s] of longestByDay) {
    const d = get(day);
    d.total_sleep_min       = s.total_sleep_duration != null ? Math.round(s.total_sleep_duration / 60) : null;
    d.rem_sleep_min         = s.rem_sleep_duration   != null ? Math.round(s.rem_sleep_duration / 60)   : null;
    d.deep_sleep_min        = s.deep_sleep_duration  != null ? Math.round(s.deep_sleep_duration / 60)  : null;
    d.light_sleep_min       = s.light_sleep_duration != null ? Math.round(s.light_sleep_duration / 60) : null;
    d.awake_min             = s.awake_time           != null ? Math.round(s.awake_time / 60)           : null;
    d.sleep_latency_min     = s.latency              != null ? Math.round(s.latency / 60)              : null;
    d.sleep_midpoint_offset_min = s.midpoint_time_offset != null ? Math.round(s.midpoint_time_offset / 60) : null;
    d.sleep_efficiency_pct  = numOrNull(s.efficiency);
    d.hrv_ms                = numOrNull(s.average_hrv);
    d.average_hr            = intOrNull(s.average_heart_rate);
    d.lowest_hr             = intOrNull(s.lowest_heart_rate);
    d.resting_hr            = intOrNull(s.lowest_heart_rate);
    d.average_breathing_rate= numOrNull(s.average_breath);
    d._sleep_detail_raw = s;
  }

  const dailyRows = [];
  for (const [day, d] of byDay) {
    dailyRows.push({
      user_email:                      email,
      date:                            day,
      readiness_score:                 d.readiness_score ?? null,
      sleep_score:                     d.sleep_score ?? null,
      activity_score:                  d.activity_score ?? null,
      total_sleep_min:                 d.total_sleep_min ?? null,
      rem_sleep_min:                   d.rem_sleep_min ?? null,
      deep_sleep_min:                  d.deep_sleep_min ?? null,
      light_sleep_min:                 d.light_sleep_min ?? null,
      awake_min:                       d.awake_min ?? null,
      sleep_latency_min:               d.sleep_latency_min ?? null,
      sleep_midpoint_offset_min:       d.sleep_midpoint_offset_min ?? null,
      sleep_timing_score:              d.sleep_timing_score ?? null,
      sleep_efficiency_pct:            d.sleep_efficiency_pct ?? null,
      sleep_restfulness_score:         d.sleep_restfulness_score ?? null,
      average_breathing_rate:          d.average_breathing_rate ?? null,
      lowest_hr:                       d.lowest_hr ?? null,
      average_hr:                      d.average_hr ?? null,
      hrv_ms:                          d.hrv_ms ?? null,
      resting_hr:                      d.resting_hr ?? null,
      body_temp_deviation_c:           d.body_temp_deviation_c ?? null,
      temperature_trend_deviation_c:   d.temperature_trend_deviation_c ?? null,
      spo2_percent:                    d.spo2_percent ?? null,
      stress_high_seconds:             d.stress_high_seconds ?? null,
      stress_recovery_seconds:         d.stress_recovery_seconds ?? null,
      stress_day_summary:              d.stress_day_summary ?? null,
      resilience_level:                d.resilience_level ?? null,
      cardiovascular_age:              d.cardiovascular_age ?? null,
      vo2_max:                         d.vo2_max ?? null,
      steps:                           d.steps ?? null,
      active_calories:                 d.active_calories ?? null,
      total_calories:                  d.total_calories ?? null,
      activity_total_seconds:          d.activity_total_seconds ?? null,
      high_activity_seconds:           d.high_activity_seconds ?? null,
      medium_activity_seconds:         d.medium_activity_seconds ?? null,
      low_activity_seconds:            d.low_activity_seconds ?? null,
      non_wear_seconds:                d.non_wear_seconds ?? null,
      sedentary_seconds:               d.sedentary_seconds ?? null,
      target_calories:                 d.target_calories ?? null,
      target_meters:                   d.target_meters ?? null,
      equivalent_walking_distance_meters: d.equivalent_walking_distance_meters ?? null,
      inactivity_alerts:               d.inactivity_alerts ?? null,
      met_average:                     d.met_average ?? null,
      readiness_activity_balance:      d.readiness_activity_balance ?? null,
      readiness_body_temperature:      d.readiness_body_temperature ?? null,
      readiness_hrv_balance:           d.readiness_hrv_balance ?? null,
      readiness_previous_day_activity: d.readiness_previous_day_activity ?? null,
      readiness_previous_night:        d.readiness_previous_night ?? null,
      readiness_recovery_index:        d.readiness_recovery_index ?? null,
      readiness_resting_hr:            d.readiness_resting_hr ?? null,
      readiness_sleep_balance:         d.readiness_sleep_balance ?? null,
      raw: {
        readiness:    d._readiness_raw || null,
        sleep_daily:  d._sleep_daily_raw || null,
        activity:     d._activity_raw || null,
        spo2:         d._spo2_raw || null,
        stress:       d._stress_raw || null,
        resilience:   d._resilience_raw || null,
        cvage:        d._cvage_raw || null,
        vo2:          d._vo2_raw || null,
        sleep_detail: d._sleep_detail_raw || null,
      },
      updated_at: new Date().toISOString(),
    });
  }

  // ── Per-event tables ────────────────────────────────────────────────────
  const sleepRows = sleepDetail.map(s => ({
    user_email:           email,
    oura_id:              String(s.id),
    day:                  s.day,
    type:                 s.type || null,
    bedtime_start:        s.bedtime_start || null,
    bedtime_end:          s.bedtime_end || null,
    total_sleep_seconds:  intOrNull(s.total_sleep_duration),
    rem_sleep_seconds:    intOrNull(s.rem_sleep_duration),
    deep_sleep_seconds:   intOrNull(s.deep_sleep_duration),
    light_sleep_seconds:  intOrNull(s.light_sleep_duration),
    awake_seconds:        intOrNull(s.awake_time),
    latency_seconds:      intOrNull(s.latency),
    efficiency:           numOrNull(s.efficiency),
    hrv_average:          numOrNull(s.average_hrv),
    hr_average:           numOrNull(s.average_heart_rate),
    hr_lowest:            intOrNull(s.lowest_heart_rate),
    respiratory_rate:     numOrNull(s.average_breath),
    restless_periods:     intOrNull(s.restless_periods),
    movement_30_sec:      s.movement_30_sec || null,
    hypnogram_5min:       s.sleep_phase_5_min || s.type_5_min || null,
    raw:                  s,
    updated_at:           new Date().toISOString(),
  }));

  const workoutRows = workouts.map(w => ({
    user_email:    email,
    oura_id:       String(w.id),
    day:           w.day,
    activity:      w.activity || null,
    source:        w.source || null,
    start_time:    w.start_datetime || null,
    end_time:      w.end_datetime || null,
    duration_min:  (w.start_datetime && w.end_datetime)
      ? Math.round((new Date(w.end_datetime) - new Date(w.start_datetime)) / 60000)
      : null,
    intensity:     w.intensity || null,
    load:          numOrNull(w.load),
    average_hr:    intOrNull(w.average_heart_rate),
    max_hr:        intOrNull(w.max_heart_rate),
    calories:      intOrNull(w.calories),
    distance_m:    numOrNull(w.distance),
    label:         w.label || null,
    raw:           w,
    updated_at:    new Date().toISOString(),
  }));

  const sessionRows = sessions.map(s => ({
    user_email:    email,
    oura_id:       String(s.id),
    day:           s.day,
    type:          s.type || null,
    mood:          s.mood || null,
    start_time:    s.start_datetime || null,
    end_time:      s.end_datetime || null,
    duration_min:  (s.start_datetime && s.end_datetime)
      ? Math.round((new Date(s.end_datetime) - new Date(s.start_datetime)) / 60000)
      : null,
    raw:           s,
    updated_at:    new Date().toISOString(),
  }));

  const tagRows = tags.map(t => ({
    user_email:     email,
    oura_id:        String(t.id),
    start_day:      t.start_day || t.start_time?.slice(0,10) || null,
    end_day:        t.end_day || null,
    tag_type_code:  t.tag_type_code || null,
    custom_name:    t.custom_name || null,
    start_time:     t.start_time || null,
    end_time:       t.end_time || null,
    comment:        t.comment || null,
    raw:            t,
    updated_at:     new Date().toISOString(),
  })).filter(r => r.start_day);

  const hrRows = heartrate.map(h => ({
    user_email: email,
    ts:         h.timestamp,
    bpm:        intOrNull(h.bpm),
    source:     h.source || null,
    raw:        h,
  })).filter(r => r.ts);

  const ringRows = ringConfig.map(r => ({
    user_email:    email,
    oura_id:       String(r.id),
    ring_color:    r.color || null,
    ring_design:   r.design || null,
    ring_hardware: r.hardware_type || null,
    firmware:      r.firmware_version || null,
    size:          intOrNull(r.size),
    set_up_at:     r.set_up_at || null,
    raw:           r,
    updated_at:    new Date().toISOString(),
  }));

  let total = 0;
  if (dailyRows.length)   { await upsert('oura_daily',          dailyRows,   serviceKey); total += dailyRows.length; }
  if (sleepRows.length)   { await upsert('oura_sleep_periods',  sleepRows,   serviceKey); total += sleepRows.length; }
  if (workoutRows.length) { await upsert('oura_workouts',       workoutRows, serviceKey); total += workoutRows.length; }
  if (sessionRows.length) { await upsert('oura_sessions',       sessionRows, serviceKey); total += sessionRows.length; }
  if (tagRows.length)     { await upsert('oura_tags',           tagRows,     serviceKey); total += tagRows.length; }
  if (hrRows.length)      { await upsert('oura_heartrate',      hrRows,      serviceKey); total += hrRows.length; }
  if (ringRows.length)    { await upsert('oura_ring_config',    ringRows,    serviceKey); total += ringRows.length; }
  return total;
}

async function ouraFetch(url, authHdr, opts) {
  const all = [];
  let next = url;
  for (let i = 0; i < 8; i++) {
    const r = await fetch(next, { headers: authHdr });
    if (r.status === 403 && opts?.tolerate403) {
      // Scope not approved or endpoint unavailable for this user — skip silently
      return all;
    }
    if (!r.ok) throw new Error(`oura ${url} HTTP ${r.status}`);
    const j = await r.json();
    if (Array.isArray(j?.data)) all.push(...j.data);
    else if (j && !j.data && !j.next_token) {
      // Single-object endpoints (e.g. personal_info) — wrap as one-element array
      all.push(j);
      break;
    }
    if (!j?.next_token) break;
    next = `${url}${url.includes('?') ? '&' : '?'}next_token=${encodeURIComponent(j.next_token)}`;
  }
  return all;
}

// ── Supabase helpers ──────────────────────────────────────────────────────
async function upsert(table, rows, serviceKey) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey:         serviceKey,
      Authorization:  `Bearer ${serviceKey}`,
      Prefer:         'resolution=merge-duplicates',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${table} upsert failed: ${res.status} ${text}`);
  }
}

async function patchUserProfile(email, patch, serviceKey) {
  await fetch(`${SUPABASE_URL}/rest/v1/user_profiles?email=eq.${encodeURIComponent(email)}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      apikey:         serviceKey,
      Authorization:  `Bearer ${serviceKey}`,
    },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });
}

async function logRun(email, provider, success, error, rowsUpserted, start, end, serviceKey) {
  await fetch(`${SUPABASE_URL}/rest/v1/health_sync_log`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey:         serviceKey,
      Authorization:  `Bearer ${serviceKey}`,
    },
    body: JSON.stringify({
      user_email:    email,
      provider,
      success,
      error:         error ? String(error).slice(0, 500) : null,
      rows_upserted: rowsUpserted,
      window_start:  dateKey(start),
      window_end:    dateKey(end),
    }),
  });
}

// ── Crypto helpers (match Dropbox pattern) ────────────────────────────────
function encryptToken(plaintext, hexKey) {
  const key = Buffer.from(hexKey, 'hex');
  const iv  = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct  = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

function decryptToken(b64, hexKey) {
  const key = Buffer.from(hexKey, 'hex');
  const buf = Buffer.from(b64, 'base64');
  const iv  = buf.slice(0, 12);
  const tag = buf.slice(12, 28);
  const ct  = buf.slice(28);
  const dec = createDecipheriv('aes-256-gcm', key, iv);
  dec.setAuthTag(tag);
  return Buffer.concat([dec.update(ct), dec.final()]).toString('utf8');
}

// ── Misc ──────────────────────────────────────────────────────────────────
function intOrNull(v) { return v == null || Number.isNaN(Number(v)) ? null : Math.round(Number(v)); }
function numOrNull(v) { return v == null || Number.isNaN(Number(v)) ? null : Number(v); }
function dateKey(d) { return d.toISOString().slice(0, 10); }
function dayKeyFromIso(iso) { return iso ? String(iso).slice(0, 10) : null; }

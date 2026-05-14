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
  const clientId  = process.env.BETA_WHOOP_CLIENT_ID;
  const clientSec = process.env.BETA_WHOOP_CLIENT_SECRET;
  if (!clientId || !clientSec) throw new Error('whoop_misconfigured');

  // Load and decrypt refresh token
  const profRes = await fetch(
    `${SUPABASE_URL}/rest/v1/user_profiles?email=eq.${encodeURIComponent(email)}&select=whoop_refresh_token_enc`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
  );
  const profRows = await profRes.json();
  const enc = profRows?.[0]?.whoop_refresh_token_enc;
  if (!enc) throw new Error('no_refresh_token');
  const refreshToken = decryptToken(enc, encKey);

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

  const [readiness, sleepDaily, activity, sleepDetail] = await Promise.all([
    ouraFetch(`${OURA_API}/daily_readiness${qs}`, authHdr),
    ouraFetch(`${OURA_API}/daily_sleep${qs}`, authHdr),
    ouraFetch(`${OURA_API}/daily_activity${qs}`, authHdr),
    ouraFetch(`${OURA_API}/sleep${qs}`, authHdr),
  ]);

  const byDay = new Map();
  const get = (day) => {
    if (!byDay.has(day)) byDay.set(day, { date: day });
    return byDay.get(day);
  };

  for (const r of readiness) {
    const d = get(r.day);
    d.readiness_score = intOrNull(r.score);
    d.body_temp_deviation_c = numOrNull(r.temperature_deviation);
    d._readiness_raw = r;
  }
  for (const s of sleepDaily) {
    const d = get(s.day);
    d.sleep_score = intOrNull(s.score);
    d._sleep_daily_raw = s;
  }
  for (const a of activity) {
    const d = get(a.day);
    d.activity_score   = intOrNull(a.score);
    d.steps            = intOrNull(a.steps);
    d.active_calories  = intOrNull(a.active_calories);
    d.total_calories   = intOrNull(a.total_calories);
    d._activity_raw    = a;
  }
  // Pick longest non-nap sleep per day for HRV/HR/durations
  const longestByDay = new Map();
  for (const s of sleepDetail) {
    if (s?.type === 'rest' || s?.type === 'nap') continue;
    const dur = s?.total_sleep_duration || 0;
    const existing = longestByDay.get(s.day);
    if (!existing || dur > (existing.total_sleep_duration || 0)) longestByDay.set(s.day, s);
  }
  for (const [day, s] of longestByDay) {
    const d = get(day);
    d.total_sleep_min = s.total_sleep_duration != null ? Math.round(s.total_sleep_duration / 60) : null;
    d.rem_sleep_min   = s.rem_sleep_duration   != null ? Math.round(s.rem_sleep_duration / 60)   : null;
    d.deep_sleep_min  = s.deep_sleep_duration  != null ? Math.round(s.deep_sleep_duration / 60)  : null;
    d.hrv_ms          = numOrNull(s.average_hrv);
    d.resting_hr      = intOrNull(s.lowest_heart_rate);
    d.spo2_percent    = numOrNull(s.average_breath); // placeholder — Oura's spo2 lives in a different endpoint
    d._sleep_detail_raw = s;
  }

  const rows = [];
  for (const [day, d] of byDay) {
    rows.push({
      user_email:            email,
      date:                  day,
      readiness_score:       d.readiness_score ?? null,
      sleep_score:           d.sleep_score ?? null,
      activity_score:        d.activity_score ?? null,
      total_sleep_min:       d.total_sleep_min ?? null,
      rem_sleep_min:         d.rem_sleep_min ?? null,
      deep_sleep_min:        d.deep_sleep_min ?? null,
      hrv_ms:                d.hrv_ms ?? null,
      resting_hr:            d.resting_hr ?? null,
      body_temp_deviation_c: d.body_temp_deviation_c ?? null,
      spo2_percent:          null,  // future: pull from /v2/usercollection/daily_spo2
      steps:                 d.steps ?? null,
      active_calories:       d.active_calories ?? null,
      total_calories:        d.total_calories ?? null,
      raw: {
        readiness:    d._readiness_raw || null,
        sleep_daily:  d._sleep_daily_raw || null,
        activity:     d._activity_raw || null,
        sleep_detail: d._sleep_detail_raw || null,
      },
      updated_at: new Date().toISOString(),
    });
  }

  if (rows.length === 0) return 0;
  await upsert('oura_daily', rows, serviceKey);
  return rows.length;
}

async function ouraFetch(url, authHdr) {
  const all = [];
  let next = url;
  for (let i = 0; i < 5; i++) {
    const r = await fetch(next, { headers: authHdr });
    if (!r.ok) throw new Error(`oura ${url} HTTP ${r.status}`);
    const j = await r.json();
    if (Array.isArray(j?.data)) all.push(...j.data);
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

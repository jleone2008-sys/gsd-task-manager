// User-facing endpoint: live, enriched weather for the brief's weather-detail
// modal. Reads the user's stored coordinates from user_preferences and fetches
// a richer Open-Meteo payload than the daily brief needs (current conditions,
// a 12-hour strip, and today + tomorrow daily) — returned shaped for the modal.
//
// Decoupled from the daily brief on purpose: the brief keeps its compact cached
// chip; this endpoint is hit on demand when the user taps the chip. No new
// table / migration — it's a live read.
//
// GET (auth: Supabase JWT Bearer)
// Returns: { ok, has_location, location_label, updated_at, current, today, hourly[], tomorrow } | { ok, has_location:false }

const { json, cors } = require('./lib/http');
const { SUPABASE_URL } = require('./lib/supabase');
const { weatherCodeToText, weatherCodeToEmoji, computeDaylightMin } = require('./lib/weather');

const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';

// "2026-05-29T14:00" (local, no tz suffix) → "2p" / "11a". "Now" handled by caller.
function hourLabel(localIso) {
  const m = /T(\d{2}):/.exec(String(localIso || ''));
  if (!m) return '';
  let h = parseInt(m[1], 10);
  const ampm = h >= 12 ? 'p' : 'a';
  h = h % 12; if (h === 0) h = 12;
  return `${h}${ampm}`;
}
// "...T06:42" → "6:42a"
function clockLabel(localIso) {
  const m = /T(\d{2}):(\d{2})/.exec(String(localIso || ''));
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = m[2];
  const ampm = h >= 12 ? 'p' : 'a';
  h = h % 12; if (h === 0) h = 12;
  return `${h}:${min}${ampm}`;
}
const r0 = (v) => (v == null ? null : Math.round(Number(v)));

// Open-Meteo's daily weather_code is the single most-SEVERE code of the day,
// so one transient snow-coded hour makes a 56°/42° rainy day read as "snow".
// Derive a more representative daily headline from that day's hourly codes:
// drop frozen-precip codes when the day's low is too warm for them (~>37°F),
// then take the most-severe remaining precip code (or, if no precip, the most
// severe code overall). Falls back to the raw daily code if hourly is absent.
function isFrozenCode(c) {
  return (c >= 71 && c <= 77) || c === 85 || c === 86 || c === 56 || c === 57 || c === 66 || c === 67;
}
function dayHeadlineCode(hourlyTimes, hourlyCodes, dateStr, lowF, fallback) {
  if (!Array.isArray(hourlyTimes) || !Array.isArray(hourlyCodes) || !dateStr) return fallback;
  const day = [];
  for (let i = 0; i < hourlyTimes.length; i++) {
    if (String(hourlyTimes[i]).slice(0, 10) === dateStr && hourlyCodes[i] != null) day.push(Number(hourlyCodes[i]));
  }
  if (!day.length) return fallback;
  const tooWarmForFrozen = lowF != null && Number(lowF) > 37;
  let pool = tooWarmForFrozen ? day.filter(c => !isFrozenCode(c)) : day.slice();
  if (!pool.length) pool = day.slice();
  const precip = pool.filter(c => c >= 51);
  const sel = precip.length ? precip : pool;
  return Math.max(...sel);
}

// Enriched Open-Meteo fetch → modal shape. Throws on transport failure so the
// provider wrapper can fall through (or the handler can surface a 502).
async function openMeteoEnriched(lat, lng, tz, label) {
  const params = new URLSearchParams({
    latitude:         String(lat),
    longitude:        String(lng),
    current:          'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_gusts_10m',
    hourly:           'temperature_2m,precipitation_probability,weather_code',
    daily:            'temperature_2m_max,temperature_2m_min,apparent_temperature_max,precipitation_probability_max,uv_index_max,weather_code,sunrise,sunset',
    temperature_unit: 'fahrenheit',
    wind_speed_unit:  'mph',
    timezone:         tz || 'auto',
    forecast_days:    '2',
  });
  const wr = await fetch(`${OPEN_METEO_URL}?${params}`);
  if (!wr.ok) throw new Error(`open_meteo_HTTP_${wr.status}`);
  const j = await wr.json();

  const cur = j.current || {};
  const d   = j.daily   || {};
  const h   = j.hourly  || {};

  const hourly = [];
  if (Array.isArray(h.time) && h.time.length) {
    const nowIso = (cur.time || '').slice(0, 13);
    let start = h.time.findIndex(t => String(t).slice(0, 13) >= nowIso);
    if (start < 0) start = 0;
    for (let i = start; i < Math.min(start + 12, h.time.length); i++) {
      const code = h.weather_code?.[i] ?? null;
      hourly.push({
        label:      i === start ? 'Now' : hourLabel(h.time[i]),
        temp_f:     r0(h.temperature_2m?.[i]),
        precip_pct: r0(h.precipitation_probability?.[i]),
        emoji:      weatherCodeToEmoji(code),
        code,
      });
    }
  }

  const todayCode = dayHeadlineCode(h.time, h.weather_code, d.time?.[0], d.temperature_2m_min?.[0], d.weather_code?.[0] ?? null);
  const tmrwCode  = dayHeadlineCode(h.time, h.weather_code, d.time?.[1], d.temperature_2m_min?.[1], d.weather_code?.[1] ?? null);
  const sunrise   = d.sunrise?.[0] ?? null;
  const sunset    = d.sunset?.[0]  ?? null;

  return {
    ok: true,
    has_location: true,
    location_label: label || null,
    updated_at: cur.time || null,
    current: {
      temp_f:    r0(cur.temperature_2m),
      feels_f:   r0(cur.apparent_temperature),
      humidity:  r0(cur.relative_humidity_2m),
      wind_mph:  r0(cur.wind_speed_10m),
      gust_mph:  r0(cur.wind_gusts_10m),
      condition: weatherCodeToText(cur.weather_code),
      emoji:     weatherCodeToEmoji(cur.weather_code),
      code:      cur.weather_code ?? null,
    },
    today: {
      high_f:        r0(d.temperature_2m_max?.[0]),
      low_f:         r0(d.temperature_2m_min?.[0]),
      feels_high_f:  r0(d.apparent_temperature_max?.[0]),
      precip_pct:    r0(d.precipitation_probability_max?.[0]),
      uv_max:        r0(d.uv_index_max?.[0]),
      condition:     weatherCodeToText(todayCode),
      emoji:         weatherCodeToEmoji(todayCode),
      code:          todayCode,
      sunrise_label: clockLabel(sunrise),
      sunset_label:  clockLabel(sunset),
      daylight_min:  computeDaylightMin(sunrise, sunset),
    },
    tomorrow: {
      high_f:     r0(d.temperature_2m_max?.[1]),
      low_f:      r0(d.temperature_2m_min?.[1]),
      precip_pct: r0(d.precipitation_probability_max?.[1]),
      condition:  weatherCodeToText(tmrwCode),
      emoji:      weatherCodeToEmoji(tmrwCode),
      code:       tmrwCode,
    },
    hourly,
    provider: 'openmeteo',
  };
}

// Provider-aware enriched fetch. WEATHER_PROVIDER=google (default) tries Google
// first and falls back to Open-Meteo on any error or empty result. Set
// WEATHER_PROVIDER=openmeteo for an instant kill-switch (no redeploy).
async function getEnriched(lat, lng, tz, label) {
  const provider = (process.env.WEATHER_PROVIDER || 'google').toLowerCase();
  if (provider === 'google') {
    try {
      const { googleEnriched } = require('./lib/google-weather');
      const g = await googleEnriched(lat, lng, tz, label);
      if (g && g.current && g.current.temp_f != null) return g;
      console.warn('google enriched returned empty; falling back to open-meteo');
    } catch (err) {
      console.warn('google enriched failed; falling back to open-meteo:', err.message);
    }
  }
  return openMeteoEnriched(lat, lng, tz, label);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return cors({ statusCode: 204, body: '' });

  // Unauthenticated health probe: tests the live provider chain against a fixed
  // public location (no user data, no secrets). Used by the scheduled
  // self-diagnosis check-in to confirm Google is actually serving (vs silently
  // falling back to Open-Meteo). ?healthcheck=1
  if ((event.queryStringParameters || {}).healthcheck === '1') {
    const provider = (process.env.WEATHER_PROVIDER || 'google').toLowerCase();
    const hasKey = !!process.env.GOOGLE_WEATHER_API_KEY;
    // NYC — stable reference point.
    try {
      let googleOk = false, googleErr = null, sample = null;
      if (hasKey) {
        try {
          const { googleEnriched } = require('./lib/google-weather');
          const g = await googleEnriched(40.7128, -74.006, 'America/New_York', 'NYC');
          googleOk = !!(g && g.current && g.current.temp_f != null);
          sample = g && g.current ? { temp_f: g.current.temp_f, condition: g.current.condition, today_high: g.today && g.today.high_f } : null;
        } catch (e) { googleErr = e.message; }
      }
      return cors(json(200, {
        ok: true,
        configured_provider: provider,
        google_key_present: hasKey,
        google_ok: googleOk,
        google_error: googleErr,
        effective_provider: googleOk ? 'google' : 'openmeteo',
        sample,
      }));
    } catch (err) {
      return cors(json(200, { ok: false, error: err.message }));
    }
  }

  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return cors(json(405, { error: 'method_not_allowed' }));
  }

  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!serviceKey) return cors(json(500, { error: 'server_misconfigured' }));

  // Auth — validate the caller's JWT, resolve their user id.
  const bearer = (event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!bearer) return cors(json(401, { error: 'missing_token' }));
  let userId;
  try {
    const ur = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${bearer}` },
    });
    if (!ur.ok) return cors(json(401, { error: 'invalid_token' }));
    const u = await ur.json();
    userId = u.id;
    if (!userId) return cors(json(401, { error: 'invalid_token' }));
  } catch (err) {
    return cors(json(401, { error: 'token_validation_failed', detail: err.message }));
  }

  // Stored coordinates + label + timezone.
  let prefs;
  try {
    const pr = await fetch(
      `${SUPABASE_URL}/rest/v1/user_preferences?user_id=eq.${userId}&select=timezone,weather_lat,weather_lng,weather_label&limit=1`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
    );
    if (!pr.ok) return cors(json(500, { error: 'prefs_read_failed' }));
    prefs = (await pr.json())?.[0] || null;
  } catch (err) {
    return cors(json(500, { error: 'prefs_unreachable', detail: err.message }));
  }

  const lat = prefs?.weather_lat, lng = prefs?.weather_lng;
  if (lat == null || lng == null) {
    return cors(json(200, { ok: true, has_location: false }));
  }
  const tz = prefs?.timezone || 'auto';

  // Provider-aware enriched fetch (Google → Open-Meteo fallback).
  try {
    const out = await getEnriched(lat, lng, tz, prefs.weather_label || null);
    return cors(json(200, out));
  } catch (err) {
    return cors(json(502, { error: 'weather_unreachable', detail: err.message }));
  }
};

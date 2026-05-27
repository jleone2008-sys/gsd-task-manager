// Phase 9 — shared weather helpers.
//
// Live Open-Meteo fetch + WMO code → text/emoji mappers + a thin
// read-from-cache wrapper. Used by:
//   - beta-daily-brief.js: read-through with live fallback
//   - cron-weather-snapshot.js: nightly per-user snapshot write
//
// Why centralize: the daily brief used to call Open-Meteo every
// regeneration and discard the result; the cron now writes a
// weather_daily row at 05:00 user-local and the brief reads from
// there first. Both paths share the same fetch + code-mapping logic
// so a code-table tweak only happens once.

const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';

// Open-Meteo daily fetch. Returns a normalized object suitable for both
// the brief context AND the weather_daily upsert shape — callers may
// pick the fields they need.
//
// Inputs:
//   { lat, lng } — coordinates (numbers; floats OK)
//   dateLocal   — 'YYYY-MM-DD' in the user's local tz
//   tz          — IANA tz string, e.g. 'America/New_York'
//   label       — optional location label for display (city name)
//
// Output (null on any failure — caller treats null as "no weather"):
//   {
//     location:       label,
//     temp_high_f:    number | null,
//     temp_low_f:     number | null,
//     condition:      string | null,
//     weather_emoji:  string | null,
//     weather_code:   number | null,
//     sunrise:        ISO local string | null,
//     sunset:         ISO local string | null,
//     daylight_min:   integer | null,
//   }
async function fetchOpenMeteo(lat, lng, dateLocal, tz, label) {
  try {
    const params = new URLSearchParams({
      latitude:         String(lat),
      longitude:        String(lng),
      daily:            'temperature_2m_max,temperature_2m_min,weather_code,sunrise,sunset',
      temperature_unit: 'fahrenheit',
      timezone:         tz || 'auto',
      start_date:       dateLocal,
      end_date:         dateLocal,
    });
    const r = await fetch(`${OPEN_METEO_URL}?${params}`);
    if (!r.ok) { console.warn(`weather fetch HTTP ${r.status}`); return null; }
    const j = await r.json();
    const d = j?.daily;
    if (!d || !d.time || !d.time.length) return null;

    const code    = d.weather_code?.[0] ?? null;
    const sunrise = d.sunrise?.[0] ?? null;
    const sunset  = d.sunset?.[0]  ?? null;
    return {
      location:      label || null,
      temp_high_f:   d.temperature_2m_max?.[0] ?? null,
      temp_low_f:    d.temperature_2m_min?.[0] ?? null,
      condition:     weatherCodeToText(code),
      weather_emoji: weatherCodeToEmoji(code),
      weather_code:  code,
      sunrise,
      sunset,
      daylight_min:  computeDaylightMin(sunrise, sunset),
    };
  } catch (err) {
    console.warn('weather fetch failed:', err.message);
    return null;
  }
}

// Read the cached weather_daily row for (user_id, date). Returns the
// same normalized shape as fetchOpenMeteo (so the brief doesn't care
// which path produced the data), or null on miss / error.
async function readCachedWeather({ supabaseUrl, serviceKey, userId, date }) {
  try {
    const url = `${supabaseUrl}/rest/v1/weather_daily?user_id=eq.${userId}&date=eq.${date}&select=location_label,temp_min_f,temp_max_f,condition,condition_emoji,sunrise_local,sunset_local,daylight_min,weather_code&limit=1`;
    const r = await fetch(url, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    });
    if (!r.ok) return null;
    const rows = await r.json();
    const row  = Array.isArray(rows) && rows[0] ? rows[0] : null;
    if (!row) return null;
    return {
      location:      row.location_label || null,
      temp_high_f:   row.temp_max_f != null ? Number(row.temp_max_f) : null,
      temp_low_f:    row.temp_min_f != null ? Number(row.temp_min_f) : null,
      condition:     row.condition || null,
      weather_emoji: row.condition_emoji || null,
      weather_code:  row.weather_code ?? null,
      sunrise:       row.sunrise_local || null,
      sunset:        row.sunset_local  || null,
      daylight_min:  row.daylight_min ?? null,
    };
  } catch (err) {
    console.warn('weather cache read failed:', err.message);
    return null;
  }
}

// Upsert a weather snapshot. Used by the cron (primary path) and by
// the brief when a live-fetch fallback succeeded (so the next reader
// hits cache). Idempotent on (user_id, date) — repeat calls overwrite.
async function writeWeatherSnapshot({ supabaseUrl, serviceKey, userId, date, snapshot }) {
  if (!snapshot) return false;
  try {
    const row = {
      user_id:         userId,
      date,
      location_label:  snapshot.location || null,
      temp_min_f:      snapshot.temp_low_f  != null ? Number(snapshot.temp_low_f)  : null,
      temp_max_f:      snapshot.temp_high_f != null ? Number(snapshot.temp_high_f) : null,
      condition:       snapshot.condition     || null,
      condition_emoji: snapshot.weather_emoji || null,
      sunrise_local:   snapshot.sunrise || null,
      sunset_local:    snapshot.sunset  || null,
      daylight_min:    snapshot.daylight_min ?? null,
      weather_code:    snapshot.weather_code ?? null,
      fetched_at:      new Date().toISOString(),
    };
    const r = await fetch(
      `${supabaseUrl}/rest/v1/weather_daily?on_conflict=user_id,date`,
      {
        method: 'POST',
        headers: {
          apikey:        serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
          Prefer:        'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify(row),
      },
    );
    if (!r.ok) {
      console.warn(`weather upsert HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('weather upsert failed:', err.message);
    return false;
  }
}

// Read-through: cache hit → return cached. Miss → live fetch → opportunistic
// upsert (best-effort; failures don't block the return) → return live data.
async function getWeather({ supabaseUrl, serviceKey, userId, lat, lng, date, tz, label }) {
  const cached = await readCachedWeather({ supabaseUrl, serviceKey, userId, date });
  if (cached) return cached;

  const live = await fetchOpenMeteo(lat, lng, date, tz, label);
  if (live) {
    // Fire-and-forget. The await is intentional so a slow Supabase
    // doesn't leak into ongoing requests, but we don't propagate
    // failures to the caller — they got their data either way.
    writeWeatherSnapshot({ supabaseUrl, serviceKey, userId, date, snapshot: live });
  }
  return live;
}

// ── WMO code → text/emoji ────────────────────────────────────────────
// Lifted verbatim from beta-daily-brief.js. Centralizing here so the
// cron + brief stay in lockstep when the table tweaks.
function weatherCodeToText(code) {
  if (code == null) return null;
  const c = Number(code);
  if (c === 0)  return 'clear';
  if (c <= 3)   return 'partly cloudy';
  if (c <= 48)  return 'foggy';
  if (c <= 57)  return 'drizzle';
  if (c <= 67)  return 'rain';
  if (c <= 77)  return 'snow';
  if (c <= 82)  return 'rain showers';
  if (c <= 86)  return 'snow showers';
  if (c <= 99)  return 'thunderstorm';
  return null;
}
function weatherCodeToEmoji(code) {
  if (code == null) return null;
  const c = Number(code);
  if (c === 0)  return '☀️';
  if (c <= 2)   return '⛅';
  if (c === 3)  return '☁️';
  if (c <= 48)  return '🌫️';
  if (c <= 57)  return '🌦️';
  if (c <= 67)  return '🌧️';
  if (c <= 77)  return '❄️';
  if (c <= 82)  return '🌧️';
  if (c <= 86)  return '🌨️';
  if (c <= 99)  return '⛈️';
  return null;
}

// Daylight in minutes from ISO local timestamps. Returns null on any
// parse failure — daylight on the brief is "if we have it" content,
// never load-bearing.
function computeDaylightMin(sunriseLocal, sunsetLocal) {
  if (!sunriseLocal || !sunsetLocal) return null;
  // ISO local strings come back as '2026-05-27T05:32' (no tz suffix);
  // parse as if UTC since we only care about the delta.
  const r = Date.parse(sunriseLocal + 'Z');
  const s = Date.parse(sunsetLocal  + 'Z');
  if (!Number.isFinite(r) || !Number.isFinite(s)) return null;
  return Math.round((s - r) / 60_000);
}

module.exports = {
  fetchOpenMeteo,
  readCachedWeather,
  writeWeatherSnapshot,
  getWeather,
  weatherCodeToText,
  weatherCodeToEmoji,
  computeDaylightMin,
};

// Phase 9.2 — per-user nightly weather snapshot writer.
//
// Walks all users with location set on user_preferences (weather_lat/lng).
// For each, when their local clock is in the snapshot window (default
// 05:00 local), fetches today's + tomorrow's weather from Open-Meteo
// and upserts into weather_daily.
//
// Why hourly cron with local-hour filter (same pattern as
// cron-daily-brief.js): one cron expression covers every timezone, and
// hourly idempotent runs absorb missed ticks + DST transitions without
// special-case logic.
//
// Idempotency: writeWeatherSnapshot upserts on (user_id, date) — re-runs
// overwrite the same row in place. Safe to fire multiple times per day.
//
// Why two days at once: the evening brief shows tomorrow's forecast as
// part of the wind-down framing; writing both at 05:00 means the
// evening brief gets a cache hit instead of paying a live fetch.

const SUPABASE_URL = 'https://dmuwncwptvnnlizuxhta.supabase.co';
const { fetchOpenMeteo, writeWeatherSnapshot } = require('./lib/weather');

// Snapshot fires once per user per day, at this local hour.
const SNAPSHOT_LOCAL_HOUR = 5;

exports.handler = async () => {
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!serviceKey) {
    console.error('cron-weather-snapshot: missing SUPABASE_SERVICE_KEY');
    return { statusCode: 500, body: 'misconfigured' };
  }

  // Pull users + their location preferences. Two queries because
  // user_profiles and user_preferences both FK to auth.users separately
  // and there's no FK between them — PostgREST embedded resources won't
  // pull this in one shot. Merge by user_id in code.
  let users;
  try {
    const [profRes, prefRes] = await Promise.all([
      fetch(
        `${SUPABASE_URL}/rest/v1/user_profiles?select=email,supabase_user_id&supabase_user_id=not.is.null`,
        { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/user_preferences?select=user_id,timezone,weather_lat,weather_lng,weather_label,city`,
        { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
      ),
    ]);
    const profiles = await profRes.json();
    const prefs    = await prefRes.json();
    if (!Array.isArray(profiles) || !Array.isArray(prefs)) {
      console.error('cron-weather-snapshot: bad user list shape:', { profiles, prefs });
      return { statusCode: 500, body: 'bad_user_list' };
    }
    const prefByUserId = {};
    for (const p of prefs) prefByUserId[p.user_id] = p;
    users = profiles
      .map(row => {
        const pref = prefByUserId[row.supabase_user_id] || {};
        return {
          user_id:       row.supabase_user_id,
          email:         row.email,
          timezone:      pref.timezone || null,
          weather_lat:   pref.weather_lat,
          weather_lng:   pref.weather_lng,
          weather_label: pref.weather_label || pref.city || null,
        };
      })
      // Skip users with no coordinates — they don't get a weather chip
      // in the brief either, so there's nothing to snapshot.
      .filter(u => u.weather_lat != null && u.weather_lng != null);
  } catch (err) {
    console.error('cron-weather-snapshot: user list fetch failed:', err.message);
    return { statusCode: 500, body: err.message };
  }

  const now = new Date();
  const summary = { eligible: 0, skipped: 0, written: 0, errors: 0 };

  for (const u of users) {
    const tz = u.timezone || 'America/New_York';
    const hour = localHour(now, tz);
    if (hour !== SNAPSHOT_LOCAL_HOUR) {
      summary.skipped++;
      continue;
    }
    summary.eligible++;

    try {
      const today    = localDate(now, tz);
      const tomorrow = shiftDate(today, +1);

      // Live fetch + write for both today and tomorrow. 05:00 local is
      // the canonical daily-refresh window; we want fresh data, not
      // whatever the read-through cache might be carrying from
      // yesterday. Failures are tolerated — Open-Meteo can be flaky
      // and we don't want a single bad request to skip the other day.
      const todayLive = await fetchOpenMeteo(
        u.weather_lat, u.weather_lng, today, tz, u.weather_label,
      );
      const wroteToday = todayLive && await writeWeatherSnapshot({
        supabaseUrl: SUPABASE_URL, serviceKey, userId: u.user_id, date: today, snapshot: todayLive,
      });

      const tomorrowLive = await fetchOpenMeteo(
        u.weather_lat, u.weather_lng, tomorrow, tz, u.weather_label,
      );
      const wroteTomorrow = tomorrowLive && await writeWeatherSnapshot({
        supabaseUrl: SUPABASE_URL, serviceKey, userId: u.user_id, date: tomorrow, snapshot: tomorrowLive,
      });

      if (wroteToday || wroteTomorrow) summary.written++;
      else summary.errors++;
    } catch (err) {
      summary.errors++;
      console.error(`cron-weather-snapshot: ${u.email} failed:`, err.message);
    }
  }

  console.log('cron-weather-snapshot summary:', JSON.stringify(summary));
  return { statusCode: 200, body: JSON.stringify(summary) };
};

// ── helpers ─────────────────────────────────────────────────────────
function localHour(date, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false });
  const h = parseInt(fmt.format(date), 10);
  return h === 24 ? 0 : h;
}
function localDate(date, tz) {
  // 'YYYY-MM-DD' in the user's tz.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}
function shiftDate(dateStr, deltaDays) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().slice(0, 10);
}

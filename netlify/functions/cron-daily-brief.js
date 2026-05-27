// Per-user daily-brief cache warmer. Calls beta-daily-brief.js for each
// active user every hour their local clock is in the active window. Phase
// 1.8 widened this to "Tier 2 realtime" — hourly across 06-22 local — so
// the AI-written copy (headline, subhead, evidence pills) stays current as
// the day unfolds rather than freezing the morning's snapshot. Mode flips
// morning → evening automatically when local hour crosses 16:00 because we
// let beta-daily-brief.js's normalizeMode derive mode from the user's tz.
//
// Why hourly instead of one-shot: per-user "06:00 local" requires either a
// cron per timezone (impractical) or one cron that filters by local hour.
// Hourly + idempotent picks up missed runs automatically and absorbs DST
// transitions without dedicated handling. Each upsert lands on the same
// (user_id, brief_date, mode) row so no duplicates accumulate.
//
// Schedule: registered in netlify.toml at `0 * * * *` UTC. The function
// filters per user by local hour, so a user in PT sees their first tick at
// ~06:00 local and their last at ~22:00 local.
//
// Cost: ~16 ticks/day × ~$0.02 Opus ≈ $0.32/user/day. Acceptable for the
// private circle. If user count grows, gate regen on "underlying data
// changed enough to warrant it" (new Oura row, journal write, >2 tasks
// completed since last tick).
//
// Gating: today this iterates user_profiles rows. Phase 3 of the master
// plan adds user_profiles.access_status; this function will then filter to
// access_status='active'. Until then, all users with a populated timezone
// (set by the frontend on app load) are considered active.

const { SUPABASE_URL } = require('./lib/supabase');

// Only generate when user's local hour is in this window. After 6 we have a
// good shot at Oura having finalized yesterday's data; cap at 22 so the
// evening brief gets refreshed through bedtime but ticks don't fire in the
// middle of the night.
const LOCAL_HOUR_MIN = 6;
const LOCAL_HOUR_MAX = 22;

exports.handler = async () => {
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  const internal   = process.env.INTERNAL_FN_SECRET;
  if (!serviceKey || !internal) {
    console.error('cron-daily-brief: missing SUPABASE_SERVICE_KEY or INTERNAL_FN_SECRET');
    return { statusCode: 500, body: 'misconfigured' };
  }

  // Site URL for self-call. Netlify exposes URL/DEPLOY_URL; prefer URL (prod).
  const siteUrl = process.env.URL || process.env.DEPLOY_URL;
  if (!siteUrl) {
    console.error('cron-daily-brief: missing URL/DEPLOY_URL env var');
    return { statusCode: 500, body: 'no_site_url' };
  }

  // Pull every user profile that has a usable identity. We don't gate on
  // beta_enabled yet — the brief function itself is the unit of correctness
  // and is idempotent + cheap when nothing to do.
  // Identity lives on user_profiles; timezone now lives on
  // user_preferences. Two queries (no FK between the tables — both
  // reference auth.users separately, so PostgREST embedded-resource
  // syntax can't pull this in one shot). Merge by user_id in code.
  // Users with no preferences row yet default to America/New_York.
  let users;
  try {
    const [profRes, prefRes] = await Promise.all([
      fetch(
        `${SUPABASE_URL}/rest/v1/user_profiles?select=email,supabase_user_id&supabase_user_id=not.is.null`,
        { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/user_preferences?select=user_id,timezone`,
        { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
      ),
    ]);
    const profiles = await profRes.json();
    const prefs    = await prefRes.json();
    if (!Array.isArray(profiles) || !Array.isArray(prefs)) {
      console.error('cron-daily-brief: bad user list shape:', { profiles, prefs });
      return { statusCode: 500, body: 'bad_user_list' };
    }
    const tzByUserId = {};
    for (const p of prefs) tzByUserId[p.user_id] = p.timezone || null;
    users = profiles.map(row => ({
      email:            row.email,
      supabase_user_id: row.supabase_user_id,
      timezone:         tzByUserId[row.supabase_user_id] || null,
    }));
  } catch (err) {
    console.error('cron-daily-brief: user list fetch failed:', err.message);
    return { statusCode: 500, body: err.message };
  }

  const now = new Date();
  const summary = { eligible: 0, skipped: 0, generated: 0, errors: 0 };

  for (const u of users) {
    const tz = u.timezone || 'America/New_York';
    const hour = localHour(now, tz);
    if (hour < LOCAL_HOUR_MIN || hour > LOCAL_HOUR_MAX) {
      summary.skipped++;
      continue;
    }
    summary.eligible++;
    try {
      const r = await fetch(`${siteUrl}/.netlify/functions/beta-daily-brief`, {
        method: 'POST',
        headers: {
          'Content-Type':    'application/json',
          'X-Internal-Auth': internal,
        },
        // Mode omitted on purpose — beta-daily-brief.js derives it from the
        // user's timezone via normalizeMode (04-16 local = morning, else
        // evening), matching the client-side detection used in the UI so
        // cron and on-demand always land on the same row per mode.
        //
        // force=true overrides the per-row idempotency cache so each hourly
        // tick refreshes the AI text fields against the latest data. The
        // (user_id, brief_date, mode) row is upserted in place — no growth.
        body: JSON.stringify({
          user_email: u.email,
          user_id:    u.supabase_user_id,
          force:      true,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        summary.errors++;
        console.error(`cron-daily-brief: ${u.email} HTTP ${r.status}: ${j?.error || ''}`);
        continue;
      }
      if (j._from_cache) {
        summary.skipped++;   // brief already existed for today, not a new generation
      } else {
        summary.generated++;
      }
    } catch (err) {
      summary.errors++;
      console.error(`cron-daily-brief: ${u.email} failed:`, err.message);
    }
  }

  console.log('cron-daily-brief summary:', JSON.stringify(summary));
  return { statusCode: 200, body: JSON.stringify(summary) };
};

function localHour(date, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', hour12: false,
  });
  // Some browsers/Node render "24" for midnight under hour12:false; normalize.
  const h = parseInt(fmt.format(date), 10);
  return h === 24 ? 0 : h;
}

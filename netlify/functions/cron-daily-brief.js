// Per-user daily-brief cache warmer. Calls beta-daily-brief.js for each
// active user when their local clock is past ~6 AM. The brief function is
// idempotent (skips if a row exists for today's user-local date), so this is
// a safe hourly tick — at small user counts (1-5) the per-hour overhead is
// a handful of cheap SELECTs and at most one Anthropic call per user per day.
//
// Why hourly instead of one-shot: per-user "06:00 local" requires either a
// cron per timezone (impractical) or one cron that filters by local hour.
// Hourly + idempotent picks up missed runs automatically and absorbs DST
// transitions without dedicated handling.
//
// Schedule: registered in netlify.toml at `0 9-23 * * *` UTC — covers the
// morning window across US/EU timezones without firing in the middle of
// the night for anyone.
//
// Gating: today this iterates user_profiles rows. Phase 3 of the master
// plan adds user_profiles.access_status; this function will then filter to
// access_status='active'. Until then, all users with a populated timezone
// (set by the frontend on app load) are considered active.

const SUPABASE_URL = 'https://dmuwncwptvnnlizuxhta.supabase.co';

// Only generate when user's local hour is in this window. After 6 we have a
// good shot at Oura having finalized yesterday's data; cap at 14 so a midday
// cold-start still gets covered but late-evening ticks don't fire (yesterday's
// brief by then is stale context for "today should be").
const LOCAL_HOUR_MIN = 6;
const LOCAL_HOUR_MAX = 14;

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
  let users;
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/user_profiles?select=email,supabase_user_id,timezone&supabase_user_id=not.is.null`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
    );
    users = await r.json();
  } catch (err) {
    console.error('cron-daily-brief: user list fetch failed:', err.message);
    return { statusCode: 500, body: err.message };
  }
  if (!Array.isArray(users)) {
    console.error('cron-daily-brief: user list non-array:', users);
    return { statusCode: 500, body: 'bad_user_list' };
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
        body: JSON.stringify({
          user_email: u.email,
          user_id:    u.supabase_user_id,
          mode:       'morning',   // cron only fires in the morning window (06-14 local)
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

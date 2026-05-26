// Phase 7 — Sunday weekly synthesis cron.
//
// Fires once per week (see netlify.toml schedule). Iterates active
// users and triggers beta-weekly-synthesis-background per user. The
// background function does the actual agentic-loop work; this cron
// is just the lightweight trigger.
//
// Auth: CRON_SECRET env var, passed as bearer to the background fn.
//
// Failure handling: per-user failure is logged but the loop continues.
// One user with a flaky baseline shouldn't block others.

const SUPABASE_URL = 'https://dmuwncwptvnnlizuxhta.supabase.co';

exports.handler = async (event) => {
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  const cronSecret = process.env.CRON_SECRET;
  if (!serviceKey) return json(500, { error: 'server_misconfigured', detail: 'SUPABASE_SERVICE_KEY' });
  if (!cronSecret) return json(500, { error: 'server_misconfigured', detail: 'CRON_SECRET' });

  // Fetch active users
  let users;
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/user_profiles?access_status=eq.active&select=supabase_user_id,email`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
    );
    if (!r.ok) throw new Error(`user_profiles_fetch_${r.status}`);
    users = await r.json();
  } catch (e) {
    console.error('[cron-weekly] failed to list users:', e.message);
    return json(500, { error: 'list_users_failed', detail: e.message });
  }

  const results = [];
  // Compute this week's Monday in UTC (matches default in the
  // background function — both must agree on the week_start_date).
  const weekStart = mondayOfThisWeek();

  // Netlify provides URL (current site root) at runtime so we can
  // call sibling functions without hardcoding a domain. DEPLOY_URL
  // falls back to the per-deploy preview URL on PR/branch builds.
  const siteUrl = process.env.URL || process.env.DEPLOY_URL || '';
  if (!siteUrl) return json(500, { error: 'site_url_unknown' });
  const callUrl = `${siteUrl}/.netlify/functions/beta-weekly-synthesis-background`;

  for (const u of users) {
    if (!u.supabase_user_id) continue;
    try {
      // Fire-and-forget — background fn returns 202 immediately,
      // then runs the agentic loop async for up to 15 minutes per
      // user. We only need to confirm the POST was accepted here.
      const res = await fetch(callUrl, {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${cronSecret}`,
        },
        body: JSON.stringify({
          user_id:         u.supabase_user_id,
          user_email:      u.email,
          week_start_date: weekStart,
        }),
      });
      results.push({ user: u.supabase_user_id, status: res.status });
    } catch (e) {
      console.warn(`[cron-weekly] user ${u.supabase_user_id} trigger failed:`, e.message);
      results.push({ user: u.supabase_user_id, error: e.message });
    }
  }

  return json(200, { week_start_date: weekStart, fired: results.length, results });
};

function mondayOfThisWeek() {
  const d = new Date();
  const dow = d.getUTCDay();   // 0 = Sun
  const delta = (dow === 0) ? -6 : (1 - dow);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function json(statusCode, payload) { return { statusCode, body: JSON.stringify(payload) }; }

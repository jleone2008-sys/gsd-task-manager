// Self-serve health re-sync for /beta. Lets a signed-in user pull their own
// Oura/Whoop history on demand instead of waiting for the nightly cron.
//
// Validates the caller's Supabase JWT to resolve their email, then triggers the
// existing cron-health-sync backfill server-side using INTERNAL_FN_SECRET — the
// secret never leaves the backend, and the user can only sync their own data.
//
// Query params: ?provider=oura|whoop|all (default all), ?days=N (default 30, max 90)

const SUPABASE_URL = 'https://dmuwncwptvnnlizuxhta.supabase.co';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return cors({ statusCode: 204, body: '' });

  const bearer = (event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!bearer) return cors(json(401, { error: 'missing_token' }));

  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  const secret     = process.env.INTERNAL_FN_SECRET;
  if (!serviceKey || !secret) return cors(json(500, { error: 'server_misconfigured' }));

  let callerEmail;
  try {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${bearer}` },
    });
    if (!userRes.ok) return cors(json(401, { error: 'invalid_token' }));
    callerEmail = (await userRes.json()).email;
  } catch (err) {
    console.error('sync-now: token validation error:', err.message);
    return cors(json(401, { error: 'token_validation_failed' }));
  }
  if (!callerEmail) return cors(json(401, { error: 'no_email' }));

  const q = event.queryStringParameters || {};
  const days = Math.min(Math.max(parseInt(q.days || '30', 10) || 30, 1), 90);
  const providers = (q.provider && ['oura', 'whoop'].includes(q.provider))
    ? [q.provider] : ['oura', 'whoop'];

  const proto = event.headers['x-forwarded-proto'] || 'https';
  const host  = event.headers.host;
  const results = {};

  for (const provider of providers) {
    const url = `${proto}://${host}/.netlify/functions/cron-health-sync`
      + `?backfill=1&user=${encodeURIComponent(callerEmail)}&provider=${provider}&days=${days}`;
    try {
      const r = await fetch(url, { headers: { 'X-Internal-Auth': secret } });
      const body = await r.json().catch(() => ({}));
      results[provider] = { status: r.status, ...body };
    } catch (err) {
      results[provider] = { error: err.message };
    }
  }

  return cors(json(200, { ok: true, days, results }));
};

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}
function cors(resp) {
  return {
    ...resp,
    headers: {
      ...(resp.headers || {}),
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    },
  };
}

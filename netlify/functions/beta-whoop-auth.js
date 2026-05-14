// OAuth proxy for /beta Whoop connect — exchanges Whoop auth code for tokens
// server-side so the Whoop app secret never touches the browser. Encrypts the
// refresh token with AES-256-GCM (ADMIN_ENCRYPTION_KEY) before storing it in
// user_profiles.whoop_refresh_token_enc.
//
// Identifies the GSD user by validating the Supabase access_token tucked into
// the OAuth `state` param via /auth/v1/user (same pattern as Dropbox).
//
// On success: kicks off a 30-day backfill into whoop_daily, then redirects to
// /beta/app#whoop=connected.

const { createCipheriv, randomBytes } = require('crypto');

const SUPABASE_URL = 'https://dmuwncwptvnnlizuxhta.supabase.co';
const WHOOP_TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token';
const WHOOP_API = 'https://api.prod.whoop.com/developer';

exports.handler = async (event) => {
  const { code, state, error } = event.queryStringParameters || {};

  const proto = event.headers['x-forwarded-proto'] || 'https';
  const host  = event.headers.host;
  const redirectUri = `${proto}://${host}/.netlify/functions/beta-whoop-auth`;

  if (error)        return redirect(`/beta/app#whoop_error=${encodeURIComponent(error)}`);
  if (!code || !state) return redirect('/beta/app#whoop_error=missing_code_or_state');

  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  const clientId   = process.env.BETA_WHOOP_CLIENT_ID;
  const clientSec  = process.env.BETA_WHOOP_CLIENT_SECRET;
  const encKey     = process.env.ADMIN_ENCRYPTION_KEY;
  if (!serviceKey || !clientId || !clientSec || !encKey) {
    console.error('whoop-auth: missing one of SUPABASE_SERVICE_KEY / BETA_WHOOP_CLIENT_ID / BETA_WHOOP_CLIENT_SECRET / ADMIN_ENCRYPTION_KEY');
    return redirect('/beta/app#whoop_error=server_misconfiguration');
  }

  // Validate state and identify the GSD user
  let callerEmail;
  try {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${state}` },
    });
    if (!userRes.ok) return redirect('/beta/app#whoop_error=invalid_state');
    callerEmail = (await userRes.json()).email;
  } catch (err) {
    console.error('whoop-auth: state validation failed:', err.message);
    return redirect('/beta/app#whoop_error=state_validation_failed');
  }
  if (!callerEmail) return redirect('/beta/app#whoop_error=state_no_email');

  // Exchange auth code for tokens
  let tokens;
  try {
    const res = await fetch(WHOOP_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'authorization_code',
        code,
        redirect_uri:  redirectUri,
        client_id:     clientId,
        client_secret: clientSec,
      }),
    });
    tokens = await res.json();
  } catch (err) {
    console.error('whoop-auth: token exchange fetch failed:', err.message);
    return redirect('/beta/app#whoop_error=token_exchange_failed');
  }

  if (tokens.error || !tokens.refresh_token) {
    console.error('whoop-auth: token error:', tokens.error, tokens.error_description);
    return redirect(`/beta/app#whoop_error=${encodeURIComponent(tokens.error || 'no_refresh_token')}`);
  }

  // Fetch profile for display + user_id
  let whoopEmail = null, whoopUserId = null;
  try {
    const profRes = await fetch(`${WHOOP_API}/v1/user/profile/basic`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (profRes.ok) {
      const prof = await profRes.json();
      whoopEmail  = prof?.email ? String(prof.email) : null;
      whoopUserId = prof?.user_id != null ? String(prof.user_id) : null;
    }
  } catch (err) {
    console.warn('whoop-auth: profile fetch failed (non-fatal):', err.message);
  }

  try {
    await storeWhoopRefreshToken(callerEmail, tokens.refresh_token, whoopEmail, whoopUserId, encKey, serviceKey);
  } catch (err) {
    console.error('whoop-auth: store failed:', err.message);
    return redirect('/beta/app#whoop_error=store_failed');
  }

  // Fire-and-forget 30-day backfill so the user has history immediately.
  // We don't await — the OAuth redirect should be snappy. Failures are logged.
  try {
    const backfillUrl = `${proto}://${host}/.netlify/functions/cron-health-sync?backfill=1&user=${encodeURIComponent(callerEmail)}&provider=whoop&days=30`;
    fetch(backfillUrl, { headers: { 'X-Internal-Auth': process.env.INTERNAL_FN_SECRET || '' } }).catch(() => {});
  } catch {}

  return redirect('/beta/app#whoop=connected');
};

function redirect(location) {
  return { statusCode: 302, headers: { Location: location }, body: '' };
}

function encryptToken(plaintext, hexKey) {
  const key = Buffer.from(hexKey, 'hex');
  const iv  = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct  = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

async function storeWhoopRefreshToken(email, refreshToken, whoopEmail, whoopUserId, encKey, serviceKey) {
  const encrypted = encryptToken(refreshToken, encKey);
  const res = await fetch(`${SUPABASE_URL}/rest/v1/user_profiles`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      apikey:          serviceKey,
      Authorization:   `Bearer ${serviceKey}`,
      Prefer:          'resolution=merge-duplicates',
    },
    body: JSON.stringify({
      email,
      whoop_refresh_token_enc: encrypted,
      whoop_account_email:     whoopEmail,
      whoop_user_id:           whoopUserId,
      updated_at:              new Date().toISOString(),
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase upsert failed: ${res.status} ${text}`);
  }
}

// OAuth proxy for /beta Whoop connect. Per-user credentials model: the user's
// own client_id + AES-256-GCM-encrypted client_secret live in user_profiles
// (saved via beta-whoop-creds.js). This callback resolves the GSD user
// from the `state` param (their Supabase access_token), pulls their stored
// credentials, exchanges the code for tokens, and stores the refresh token.
//
// On success: kicks off a 30-day backfill into whoop_daily, then redirects to
// /beta/app#whoop=connected.

const { createCipheriv, createDecipheriv, randomBytes } = require('crypto');

const SUPABASE_URL    = 'https://dmuwncwptvnnlizuxhta.supabase.co';
const WHOOP_TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token';
const WHOOP_API       = 'https://api.prod.whoop.com/developer';

exports.handler = async (event) => {
  const { code, state, error } = event.queryStringParameters || {};

  const proto = event.headers['x-forwarded-proto'] || 'https';
  const host  = event.headers.host;
  const redirectUri = `${proto}://${host}/.netlify/functions/beta-whoop-auth`;

  if (error)            return redirect(`/beta/app#whoop_error=${encodeURIComponent(error)}`);
  if (!code || !state)  return redirect('/beta/app#whoop_error=missing_code_or_state');

  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  const encKey     = process.env.ADMIN_ENCRYPTION_KEY;
  if (!serviceKey || !encKey) {
    console.error('whoop-auth: missing SUPABASE_SERVICE_KEY or ADMIN_ENCRYPTION_KEY');
    return redirect('/beta/app#whoop_error=server_misconfiguration');
  }

  // Validate state → caller email
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

  // Look up this user's stored Whoop credentials
  let clientId, clientSecret;
  try {
    const credRes = await fetch(
      `${SUPABASE_URL}/rest/v1/user_profiles?email=eq.${encodeURIComponent(callerEmail)}&select=whoop_client_id,whoop_client_secret_enc`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
    );
    const rows = await credRes.json();
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row?.whoop_client_id || !row?.whoop_client_secret_enc) {
      return redirect('/beta/app#whoop_error=no_credentials');
    }
    clientId     = row.whoop_client_id;
    clientSecret = decryptToken(row.whoop_client_secret_enc, encKey);
  } catch (err) {
    console.error('whoop-auth: credentials lookup failed:', err.message);
    return redirect('/beta/app#whoop_error=credentials_lookup_failed');
  }

  // Exchange auth code for tokens using the user's own credentials
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
        client_secret: clientSecret,
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

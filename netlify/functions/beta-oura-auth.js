// OAuth proxy for /beta Oura connect — exchanges Oura auth code for tokens
// server-side. Encrypts refresh token (AES-256-GCM, ADMIN_ENCRYPTION_KEY) and
// stores it in user_profiles.oura_refresh_token_enc.
//
// On success: kicks off a 30-day backfill into oura_daily, then redirects to
// /beta/app#oura=connected.

const { createCipheriv, randomBytes } = require('crypto');

const SUPABASE_URL   = 'https://dmuwncwptvnnlizuxhta.supabase.co';
const OURA_TOKEN_URL = 'https://api.ouraring.com/oauth/token';
const OURA_API       = 'https://api.ouraring.com/v2/usercollection';

exports.handler = async (event) => {
  const { code, state, error } = event.queryStringParameters || {};

  const proto = event.headers['x-forwarded-proto'] || 'https';
  const host  = event.headers.host;
  const redirectUri = `${proto}://${host}/.netlify/functions/beta-oura-auth`;

  if (error) return redirect(`/beta/app#oura_error=${encodeURIComponent(error)}`);
  if (!code || !state) return redirect('/beta/app#oura_error=missing_code_or_state');

  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  const clientId   = process.env.BETA_OURA_CLIENT_ID;
  const clientSec  = process.env.BETA_OURA_CLIENT_SECRET;
  const encKey     = process.env.ADMIN_ENCRYPTION_KEY;
  if (!serviceKey || !clientId || !clientSec || !encKey) {
    console.error('oura-auth: missing required env var');
    return redirect('/beta/app#oura_error=server_misconfiguration');
  }

  let callerEmail;
  try {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${state}` },
    });
    if (!userRes.ok) return redirect('/beta/app#oura_error=invalid_state');
    callerEmail = (await userRes.json()).email;
  } catch (err) {
    console.error('oura-auth: state validation failed:', err.message);
    return redirect('/beta/app#oura_error=state_validation_failed');
  }
  if (!callerEmail) return redirect('/beta/app#oura_error=state_no_email');

  let tokens;
  try {
    // Oura token endpoint accepts client_id/secret via Basic auth OR form body.
    // Form body matches our Whoop/Dropbox pattern.
    const res = await fetch(OURA_TOKEN_URL, {
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
    console.error('oura-auth: token exchange fetch failed:', err.message);
    return redirect('/beta/app#oura_error=token_exchange_failed');
  }

  if (tokens.error || !tokens.refresh_token) {
    console.error('oura-auth: token error:', tokens.error, tokens.error_description);
    return redirect(`/beta/app#oura_error=${encodeURIComponent(tokens.error || 'no_refresh_token')}`);
  }

  let ouraEmail = null;
  try {
    const piRes = await fetch(`${OURA_API}/personal_info`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (piRes.ok) {
      const pi = await piRes.json();
      ouraEmail = pi?.email || null;
    }
  } catch (err) {
    console.warn('oura-auth: personal_info fetch failed (non-fatal):', err.message);
  }

  try {
    await storeOuraRefreshToken(callerEmail, tokens.refresh_token, ouraEmail, encKey, serviceKey);
  } catch (err) {
    console.error('oura-auth: store failed:', err.message);
    return redirect('/beta/app#oura_error=store_failed');
  }

  try {
    const backfillUrl = `${proto}://${host}/.netlify/functions/cron-health-sync?backfill=1&user=${encodeURIComponent(callerEmail)}&provider=oura&days=30`;
    fetch(backfillUrl, { headers: { 'X-Internal-Auth': process.env.INTERNAL_FN_SECRET || '' } }).catch(() => {});
  } catch {}

  return redirect('/beta/app#oura=connected');
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

async function storeOuraRefreshToken(email, refreshToken, ouraEmail, encKey, serviceKey) {
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
      oura_refresh_token_enc: encrypted,
      oura_account_email:     ouraEmail,
      updated_at:             new Date().toISOString(),
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase upsert failed: ${res.status} ${text}`);
  }
}

// OAuth proxy for /beta Dropbox connect — exchanges Dropbox auth code for tokens
// server-side so the Dropbox app secret never touches the browser, and encrypts
// the refresh token before storing it in user_profiles.dropbox_refresh_token_enc.
//
// Identifies the GSD user by validating the Supabase JWT passed back in the
// OAuth `state` param (the client puts it there before kicking off authorize).
// This prevents cross-user token planting / CSRF.

const { createCipheriv, randomBytes, createHmac } = require('crypto');

const DROPBOX_CLIENT_ID = '7rf801fqot1xx8n';
const SUPABASE_URL      = 'https://dmuwncwptvnnlizuxhta.supabase.co';

exports.handler = async (event) => {
  const { code, state, error } = event.queryStringParameters || {};

  const proto = event.headers['x-forwarded-proto'] || 'https';
  const host  = event.headers.host;
  const redirectUri = `${proto}://${host}/.netlify/functions/beta-dropbox-auth`;

  if (error) {
    return redirect(`/beta/app#dropbox_error=${encodeURIComponent(error)}`);
  }
  if (!code || !state) {
    return redirect('/beta/app#dropbox_error=missing_code_or_state');
  }

  // Validate the state JWT to identify the caller
  const claims = verifySupabaseJwt(state);
  if (!claims?.email || !claims?.sub) {
    return redirect('/beta/app#dropbox_error=invalid_state');
  }

  const clientSecret = process.env.BETA_DROPBOX_CLIENT_SECRET;
  if (!clientSecret) {
    console.error('Missing BETA_DROPBOX_CLIENT_SECRET env var');
    return redirect('/beta/app#dropbox_error=server_misconfiguration');
  }

  // Exchange auth code for tokens
  let tokens;
  try {
    const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     DROPBOX_CLIENT_ID,
        client_secret: clientSecret,
        redirect_uri:  redirectUri,
        grant_type:    'authorization_code',
      }),
    });
    tokens = await res.json();
  } catch (err) {
    console.error('Dropbox token exchange fetch failed:', err);
    return redirect('/beta/app#dropbox_error=token_exchange_failed');
  }

  if (tokens.error || !tokens.refresh_token) {
    console.error('Dropbox token error:', tokens.error, tokens.error_description);
    return redirect(`/beta/app#dropbox_error=${encodeURIComponent(tokens.error || 'no_refresh_token')}`);
  }

  // Fetch the Dropbox account email for display
  let dropboxAccountEmail = null;
  try {
    const acctRes = await fetch('https://api.dropboxapi.com/2/users/get_current_account', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${tokens.access_token}` },
    });
    if (acctRes.ok) {
      const acct = await acctRes.json();
      dropboxAccountEmail = acct?.email || null;
    }
  } catch (err) {
    console.warn('get_current_account failed (non-fatal):', err.message);
  }

  // Encrypt and store the refresh token
  try {
    await storeDropboxRefreshToken(claims.email, tokens.refresh_token, dropboxAccountEmail);
  } catch (err) {
    console.error('Failed to store Dropbox refresh token:', err.message);
    return redirect('/beta/app#dropbox_error=store_failed');
  }

  return redirect('/beta/app#dropbox=connected');
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

function verifySupabaseJwt(token) {
  const jwtSecret = process.env.SUPABASE_JWT_SECRET;
  if (!jwtSecret) {
    console.error('SUPABASE_JWT_SECRET not set');
    return null;
  }
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [header, payload, sig] = parts;
  const expected = createHmac('sha256', jwtSecret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  if (sig !== expected) return null;

  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (claims.exp && claims.exp < Math.floor(Date.now() / 1000)) return null;
  return claims;
}

async function storeDropboxRefreshToken(email, refreshToken, dropboxAccountEmail) {
  const encKey     = process.env.ADMIN_ENCRYPTION_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!encKey || !serviceKey) throw new Error('Missing ADMIN_ENCRYPTION_KEY or SUPABASE_SERVICE_KEY');

  const encrypted = encryptToken(refreshToken, encKey);

  const res = await fetch(`${SUPABASE_URL}/rest/v1/user_profiles`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'apikey':        serviceKey,
      'Authorization': `Bearer ${serviceKey}`,
      'Prefer':        'resolution=merge-duplicates',
    },
    body: JSON.stringify({
      email,
      dropbox_refresh_token_enc: encrypted,
      dropbox_account_email:     dropboxAccountEmail,
      updated_at:                new Date().toISOString(),
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase upsert failed: ${res.status} ${text}`);
  }
}

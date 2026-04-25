// OAuth proxy for /beta — exchanges Google auth code for tokens server-side
// so the beta Google client secret never touches the browser.
// Flow: browser → Google → here → /beta/app#id_token=...&access_token=...
// Also captures the Google refresh_token (encrypted) into user_profiles for admin use.

const { createCipheriv, randomBytes } = require('crypto');

exports.handler = async (event) => {
  const { code, state, error } = event.queryStringParameters || {};

  const proto = event.headers['x-forwarded-proto'] || 'https';
  const host  = event.headers.host;
  const redirectUri = `${proto}://${host}/.netlify/functions/beta-auth`;

  if (error) {
    return redirect(`/beta/app#error=${encodeURIComponent(error)}&state=${state || ''}`);
  }

  if (!code) {
    return { statusCode: 400, body: 'Missing authorization code.' };
  }

  const clientId     = '508677465416-ptiaqbjlqq8cmf8f1gertead6493u7ei.apps.googleusercontent.com';
  const clientSecret = process.env.BETA_GOOGLE_CLIENT_SECRET;

  if (!clientSecret) {
    console.error('Missing BETA_GOOGLE_CLIENT_SECRET env var');
    return redirect(`/beta/app#error=server_misconfiguration&state=${state || ''}`);
  }

  let tokens;
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     clientId,
        client_secret: clientSecret,
        redirect_uri:  redirectUri,
        grant_type:    'authorization_code',
      }),
    });
    tokens = await res.json();
  } catch (err) {
    console.error('Token exchange fetch failed:', err);
    return redirect(`/beta/app#error=token_exchange_failed&state=${state || ''}`);
  }

  if (tokens.error) {
    console.error('Google token error:', tokens.error, tokens.error_description);
    return redirect(`/beta/app#error=${encodeURIComponent(tokens.error)}&state=${state || ''}`);
  }

  // Store encrypted refresh_token for admin "view as user" feature (non-fatal if it fails)
  if (tokens.refresh_token && tokens.id_token) {
    storeRefreshToken(tokens.id_token, tokens.refresh_token).catch(err => {
      console.error('Failed to store refresh token:', err.message);
    });
  }

  const params = new URLSearchParams({
    id_token:      tokens.id_token     || '',
    access_token:  tokens.access_token || '',
    granted_scope: tokens.scope        || '',
    state:         state               || '',
  });

  return redirect(`/beta/app#${params}`);
};

function redirect(location) {
  return { statusCode: 302, headers: { Location: location }, body: '' };
}

// Decrypt counterpart lives in admin-api.js — must use same key + format.
function encryptToken(plaintext, hexKey) {
  const key = Buffer.from(hexKey, 'hex');
  const iv  = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct  = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Layout: 12-byte IV | 16-byte GCM tag | ciphertext — all base64
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

function decodeJwtPayload(jwt) {
  try {
    const payload = jwt.split('.')[1];
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

async function storeRefreshToken(idToken, refreshToken) {
  const encKey      = process.env.ADMIN_ENCRYPTION_KEY;
  const serviceKey  = process.env.SUPABASE_SERVICE_KEY;
  const supabaseUrl = 'https://dmuwncwptvnnlizuxhta.supabase.co';

  if (!encKey || !serviceKey) {
    console.warn('ADMIN_ENCRYPTION_KEY or SUPABASE_SERVICE_KEY not set — skipping refresh token storage');
    return;
  }

  const payload = decodeJwtPayload(idToken);
  if (!payload?.email) {
    console.warn('Could not decode email from id_token');
    return;
  }

  const encrypted = encryptToken(refreshToken, encKey);

  const res = await fetch(`${supabaseUrl}/rest/v1/user_profiles`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'apikey':        serviceKey,
      'Authorization': `Bearer ${serviceKey}`,
      'Prefer':        'resolution=merge-duplicates',
    },
    body: JSON.stringify({
      email:                    payload.email,
      google_refresh_token_enc: encrypted,
      display_name:             payload.name || null,
      updated_at:               new Date().toISOString(),
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase upsert failed: ${res.status} ${text}`);
  }
}

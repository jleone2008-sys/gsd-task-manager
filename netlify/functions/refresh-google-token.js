// Refreshes a beta user's Google access_token using the refresh_token
// captured during sign-in (stored encrypted in user_profiles) — or, if
// the body specifies `account_email`, the refresh_token for a linked
// secondary Google account (stored in linked_google_accounts).
// Auth: Supabase user JWT in Authorization header.

const { createDecipheriv } = require('crypto');

const GOOGLE_CLIENT_ID = '508677465416-ptiaqbjlqq8cmf8f1gertead6493u7ei.apps.googleusercontent.com';
const SUPABASE_URL     = 'https://dmuwncwptvnnlizuxhta.supabase.co';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return cors({ statusCode: 204, body: '' });
  if (event.httpMethod !== 'POST') return cors(json(405, { error: 'method_not_allowed' }));

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const bearerToken = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!bearerToken) return cors(json(401, { error: 'missing_token' }));

  // Optional body { account_email: "..." } — when present, refresh the
  // token for that linked account instead of the primary signed-in one.
  let linkedEmail = null;
  if (event.body) {
    try {
      const parsed = JSON.parse(event.body);
      if (parsed && typeof parsed.account_email === 'string' && parsed.account_email.trim()) {
        linkedEmail = parsed.account_email.trim().toLowerCase();
      }
    } catch (_) { /* ignore — treat as primary refresh */ }
  }

  const serviceKey   = process.env.SUPABASE_SERVICE_KEY;
  const encKey       = process.env.ADMIN_ENCRYPTION_KEY;
  const clientSecret = process.env.BETA_GOOGLE_CLIENT_SECRET;
  if (!serviceKey || !encKey || !clientSecret) {
    console.error('Missing env vars for refresh-google-token');
    return cors(json(500, { error: 'server_misconfigured' }));
  }

  // Verify the user's Supabase JWT via the auth endpoint
  let userEmail, userId;
  try {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${bearerToken}`, apikey: serviceKey },
    });
    if (!userRes.ok) return cors(json(401, { error: 'invalid_token' }));
    const userData = await userRes.json();
    userEmail = userData.email;
    userId    = userData.id;
  } catch (err) {
    console.error('Token validation error:', err.message);
    return cors(json(401, { error: 'token_validation_failed' }));
  }
  if (!userEmail) return cors(json(401, { error: 'no_email_on_token' }));

  // Look up the encrypted refresh_token — primary lives on user_profiles;
  // linked accounts live on linked_google_accounts.
  let encrypted;
  try {
    if (linkedEmail) {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/linked_google_accounts?user_id=eq.${encodeURIComponent(userId)}&google_email=eq.${encodeURIComponent(linkedEmail)}&select=refresh_token_enc`,
        { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
      );
      const rows = await res.json();
      encrypted = rows?.[0]?.refresh_token_enc;
    } else {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/user_profiles?email=eq.${encodeURIComponent(userEmail)}&select=google_refresh_token_enc`,
        { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
      );
      const rows = await res.json();
      encrypted = rows?.[0]?.google_refresh_token_enc;
    }
  } catch (err) {
    console.error('Profile lookup failed:', err.message);
    return cors(json(500, { error: 'profile_lookup_failed' }));
  }
  if (!encrypted) {
    return cors(json(404, {
      error: 'no_refresh_token',
      message: linkedEmail
        ? 'No stored refresh token for this linked account. Reconnect it from Settings.'
        : 'No stored refresh token. Sign out and sign back in to grant offline access.',
    }));
  }

  // Decrypt the refresh_token
  let refreshToken;
  try {
    refreshToken = decryptToken(encrypted, encKey);
  } catch (err) {
    console.error('Decrypt failed:', err.message);
    return cors(json(500, { error: 'decrypt_failed' }));
  }

  // Exchange with Google for a new access_token
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     GOOGLE_CLIENT_ID,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type:    'refresh_token',
      }),
    });
    const data = await res.json();
    if (data.error) {
      console.error('Google refresh error:', data.error, data.error_description);
      // If invalid_grant — the refresh token was revoked or expired
      if (data.error === 'invalid_grant') {
        return cors(json(401, {
          error: 'refresh_token_invalid',
          message: 'Stored refresh token is no longer valid. Sign out and sign back in.',
        }));
      }
      return cors(json(502, { error: 'google_refresh_failed', detail: data.error }));
    }
    return cors(json(200, {
      access_token: data.access_token,
      expires_in:   data.expires_in,
      scope:        data.scope,
    }));
  } catch (err) {
    console.error('Refresh exchange failed:', err.message);
    return cors(json(502, { error: 'refresh_exchange_failed' }));
  }
};

function decryptToken(b64, hexKey) {
  const buf  = Buffer.from(b64, 'base64');
  const iv   = buf.subarray(0, 12);
  const tag  = buf.subarray(12, 28);
  const ct   = buf.subarray(28);
  const key  = Buffer.from(hexKey, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function cors(response) {
  return {
    ...response,
    headers: {
      ...(response.headers || {}),
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  };
}

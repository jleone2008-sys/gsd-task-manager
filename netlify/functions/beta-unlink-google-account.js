// Unlinks a previously-linked secondary Google account: revokes the
// refresh_token at Google, deletes the linked_google_accounts row, and
// removes any calendar toggles scoped to that account from
// google_calendars_synced. The user's primary signed-in Google account
// cannot be unlinked through this endpoint.
// Auth: Supabase user JWT in Authorization header.
// Body: { account_email: "..." }

const { createDecipheriv } = require('crypto');

const SUPABASE_URL = 'https://dmuwncwptvnnlizuxhta.supabase.co';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return cors({ statusCode: 204, body: '' });
  if (event.httpMethod !== 'POST') return cors(json(405, { error: 'method_not_allowed' }));

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const bearerToken = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!bearerToken) return cors(json(401, { error: 'missing_token' }));

  let accountEmail = null;
  try {
    const parsed = JSON.parse(event.body || '{}');
    accountEmail = parsed?.account_email?.trim().toLowerCase() || null;
  } catch (_) {
    return cors(json(400, { error: 'invalid_body' }));
  }
  if (!accountEmail) return cors(json(400, { error: 'missing_account_email' }));

  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  const encKey     = process.env.ADMIN_ENCRYPTION_KEY;
  if (!serviceKey || !encKey) {
    console.error('Missing env vars for beta-unlink-google-account');
    return cors(json(500, { error: 'server_misconfigured' }));
  }

  // Verify user.
  let userId;
  try {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${bearerToken}`, apikey: serviceKey },
    });
    if (!userRes.ok) return cors(json(401, { error: 'invalid_token' }));
    const userData = await userRes.json();
    userId = userData.id;
  } catch (err) {
    return cors(json(401, { error: 'token_validation_failed' }));
  }
  if (!userId) return cors(json(401, { error: 'no_user' }));

  // Look up the row so we can revoke the refresh token at Google.
  let encrypted;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/linked_google_accounts?user_id=eq.${encodeURIComponent(userId)}&google_email=eq.${encodeURIComponent(accountEmail)}&select=refresh_token_enc`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
    );
    const rows = await res.json();
    encrypted = rows?.[0]?.refresh_token_enc;
  } catch (err) {
    console.error('linked account lookup failed', err);
    return cors(json(500, { error: 'lookup_failed' }));
  }
  if (!encrypted) return cors(json(404, { error: 'not_linked' }));

  // Revoke at Google. Non-fatal — proceed to delete the row even if
  // revocation fails (token might already be invalid).
  try {
    const refreshToken = decryptToken(encrypted, encKey);
    await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshToken }),
    });
  } catch (err) {
    console.warn('Google revoke failed (continuing with row delete):', err.message);
  }

  // Delete calendar toggles scoped to this account.
  try {
    await fetch(
      `${SUPABASE_URL}/rest/v1/google_calendars_synced?user_id=eq.${encodeURIComponent(userId)}&google_account_email=eq.${encodeURIComponent(accountEmail)}`,
      { method: 'DELETE', headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
    );
  } catch (err) {
    console.warn('toggle cleanup failed', err);
  }

  // Delete the linked account row.
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/linked_google_accounts?user_id=eq.${encodeURIComponent(userId)}&google_email=eq.${encodeURIComponent(accountEmail)}`,
      { method: 'DELETE', headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
    );
    if (!res.ok) {
      const text = await res.text();
      console.error('linked account delete failed', res.status, text);
      return cors(json(500, { error: 'delete_failed' }));
    }
  } catch (err) {
    return cors(json(500, { error: 'delete_failed' }));
  }

  return cors(json(200, { unlinked: accountEmail }));
};

function decryptToken(b64, hexKey) {
  const buf = Buffer.from(b64, 'base64');
  const iv  = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct  = buf.subarray(28);
  const key = Buffer.from(hexKey, 'hex');
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

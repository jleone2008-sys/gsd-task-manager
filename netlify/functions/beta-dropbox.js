// User-facing Dropbox endpoint for /beta — handles status check and disconnect.
// Authenticated by the caller's Supabase JWT (no admin role required).
//
// Actions:
//   status     → { connected, dropbox_account_email }
//   disconnect → revoke access token at Dropbox + null the encrypted refresh token

const { createDecipheriv } = require('crypto');

const DROPBOX_CLIENT_ID = '7rf801fqot1xx8n';
const SUPABASE_URL      = 'https://dmuwncwptvnnlizuxhta.supabase.co';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return cors({ statusCode: 204, body: '' });

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const bearerToken = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!bearerToken) return cors(json(401, { error: 'missing_token' }));

  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!serviceKey) return cors(json(500, { error: 'server_misconfigured' }));

  // Validate token and get caller email
  let callerEmail;
  try {
    const userRes = await supabaseFetch('/auth/v1/user', 'GET', null, bearerToken, serviceKey);
    if (!userRes.ok) return cors(json(401, { error: 'invalid_token' }));
    const userData = await userRes.json();
    callerEmail = userData.email;
  } catch (err) {
    console.error('Token validation error:', err.message);
    return cors(json(401, { error: 'token_validation_failed' }));
  }

  const action = event.queryStringParameters?.action ||
    (event.body ? JSON.parse(event.body).action : null);

  try {
    switch (action) {
      case 'status':     return cors(await getStatus(callerEmail, serviceKey));
      case 'disconnect': return cors(await disconnect(callerEmail, serviceKey));
      default:           return cors(json(400, { error: 'unknown_action' }));
    }
  } catch (err) {
    console.error(`Dropbox action ${action} error:`, err.message);
    return cors(json(500, { error: err.message }));
  }
};

async function getStatus(email, serviceKey) {
  const res = await supabaseFetch(
    `/rest/v1/user_profiles?email=eq.${encodeURIComponent(email)}&select=dropbox_refresh_token_enc,dropbox_account_email`,
    'GET', null, null, serviceKey
  );
  const rows = await res.json();
  const row = Array.isArray(rows) ? rows[0] : null;
  return json(200, {
    connected: !!row?.dropbox_refresh_token_enc,
    dropbox_account_email: row?.dropbox_account_email || null,
  });
}

async function disconnect(email, serviceKey) {
  // Fetch the encrypted refresh token so we can mint a fresh access token to revoke
  const profRes = await supabaseFetch(
    `/rest/v1/user_profiles?email=eq.${encodeURIComponent(email)}&select=dropbox_refresh_token_enc`,
    'GET', null, null, serviceKey
  );
  const rows = await profRes.json();
  const enc = Array.isArray(rows) ? rows[0]?.dropbox_refresh_token_enc : null;

  // Best-effort: revoke the token at Dropbox so it can't be used by us anymore.
  // Even if this fails we still null the DB column.
  if (enc) {
    try {
      const accessToken = await exchangeDropboxRefreshToken(enc);
      await fetch('https://api.dropboxapi.com/2/auth/token/revoke', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${accessToken}` },
      });
    } catch (err) {
      console.warn('Dropbox revoke failed (non-fatal):', err.message);
    }
  }

  // Null the column (and the account email) for the caller
  const updRes = await supabaseFetch(
    `/rest/v1/user_profiles?email=eq.${encodeURIComponent(email)}`,
    'PATCH',
    {
      dropbox_refresh_token_enc: null,
      dropbox_account_email:     null,
      updated_at:                new Date().toISOString(),
    },
    null, serviceKey
  );
  if (!updRes.ok) {
    const text = await updRes.text();
    return json(500, { error: `disconnect_failed: ${text}` });
  }
  return json(200, { ok: true });
}

async function exchangeDropboxRefreshToken(encryptedToken) {
  const encKey       = process.env.ADMIN_ENCRYPTION_KEY;
  const clientSecret = process.env.BETA_DROPBOX_CLIENT_SECRET;
  if (!encKey || !clientSecret) throw new Error('Missing encryption key or Dropbox client secret');

  const refreshToken = decryptToken(encryptedToken, encKey);

  const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     DROPBOX_CLIENT_ID,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type:    'refresh_token',
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`Dropbox token refresh failed: ${data.error} — ${data.error_description}`);
  return data.access_token;
}

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

async function supabaseFetch(path, method, body, userToken, serviceKey) {
  const headers = {
    'Content-Type':  'application/json',
    'apikey':        serviceKey,
    'Authorization': `Bearer ${userToken || serviceKey}`,
  };
  if (method === 'PATCH') headers['Prefer'] = 'return=minimal';

  return fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

function json(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function cors(response) {
  return {
    ...response,
    headers: {
      ...(response.headers || {}),
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  };
}

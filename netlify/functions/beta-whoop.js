// User-facing Whoop endpoint for /beta — status check and disconnect.
// Authenticated by the caller's Supabase JWT.
//
// Actions:
//   status     → { connected, whoop_account_email }
//   disconnect → revoke at Whoop + null the encrypted refresh token

const { createCipheriv, createDecipheriv, randomBytes } = require('crypto');

const SUPABASE_URL    = 'https://dmuwncwptvnnlizuxhta.supabase.co';
const WHOOP_TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token';
const WHOOP_REVOKE    = 'https://api.prod.whoop.com/oauth/oauth2/revoke';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return cors({ statusCode: 204, body: '' });

  const bearer = (event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!bearer) return cors(json(401, { error: 'missing_token' }));

  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!serviceKey) return cors(json(500, { error: 'server_misconfigured' }));

  let callerEmail;
  try {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${bearer}` },
    });
    if (!userRes.ok) return cors(json(401, { error: 'invalid_token' }));
    callerEmail = (await userRes.json()).email;
  } catch (err) {
    console.error('whoop: token validation error:', err.message);
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
    console.error(`whoop action ${action} error:`, err.message);
    return cors(json(500, { error: err.message }));
  }
};

async function getStatus(email, serviceKey) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/user_profiles?email=eq.${encodeURIComponent(email)}&select=whoop_refresh_token_enc,whoop_account_email`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
  );
  const rows = await res.json();
  const row = Array.isArray(rows) ? rows[0] : null;
  return json(200, {
    connected:           !!row?.whoop_refresh_token_enc,
    whoop_account_email: row?.whoop_account_email || null,
  });
}

async function disconnect(email, serviceKey) {
  const encKey = process.env.ADMIN_ENCRYPTION_KEY;
  if (!encKey) throw new Error('whoop_misconfigured');

  // Per-user credentials: fetch the user's own client_id + secret alongside
  // the refresh token, so we can revoke at Whoop using their app's credentials.
  const profRes = await fetch(
    `${SUPABASE_URL}/rest/v1/user_profiles?email=eq.${encodeURIComponent(email)}&select=whoop_refresh_token_enc,whoop_client_id,whoop_client_secret_enc`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
  );
  const rows = await profRes.json();
  const row = Array.isArray(rows) ? rows[0] : null;
  const enc       = row?.whoop_refresh_token_enc || null;
  const clientId  = row?.whoop_client_id || null;
  const clientSec = row?.whoop_client_secret_enc ? decryptToken(row.whoop_client_secret_enc, encKey) : null;

  // Best-effort revoke at Whoop
  if (enc) {
    try {
      const refreshToken = decryptToken(enc, encKey);
      const tr = await fetch(WHOOP_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type:    'refresh_token',
          refresh_token: refreshToken,
          client_id:     clientId,
          client_secret: clientSec,
          scope:         'offline',
        }),
      });
      const tk = await tr.json();
      if (tk.access_token) {
        await fetch(WHOOP_REVOKE, {
          method: 'POST',
          headers: {
            'Content-Type':  'application/x-www-form-urlencoded',
            Authorization:   `Bearer ${tk.access_token}`,
          },
          body: new URLSearchParams({
            token:           tk.access_token,
            client_id:       clientId,
            client_secret:   clientSec,
          }),
        }).catch(() => {});
      }
    } catch (err) {
      console.warn('whoop: revoke failed (non-fatal):', err.message);
    }
  }

  // Null the stored token regardless of revoke result
  const upd = await fetch(`${SUPABASE_URL}/rest/v1/user_profiles?email=eq.${encodeURIComponent(email)}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      apikey:         serviceKey,
      Authorization:  `Bearer ${serviceKey}`,
    },
    body: JSON.stringify({
      whoop_refresh_token_enc: null,
      whoop_account_email:     null,
      whoop_user_id:           null,
      updated_at:              new Date().toISOString(),
    }),
  });
  if (!upd.ok) throw new Error(`unset_failed: ${upd.status}`);
  return json(200, { ok: true });
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

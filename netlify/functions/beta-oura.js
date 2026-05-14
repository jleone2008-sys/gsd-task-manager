// User-facing Oura endpoint for /beta — status check and disconnect.
//
// Actions:
//   status     → { connected, oura_account_email }
//   disconnect → revoke at Oura (best-effort) + null the encrypted refresh token

const { createDecipheriv } = require('crypto');

const SUPABASE_URL   = 'https://dmuwncwptvnnlizuxhta.supabase.co';
const OURA_TOKEN_URL = 'https://api.ouraring.com/oauth/token';
const OURA_REVOKE    = 'https://api.ouraring.com/oauth/revoke';

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
    console.error('oura: token validation error:', err.message);
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
    console.error(`oura action ${action} error:`, err.message);
    return cors(json(500, { error: err.message }));
  }
};

async function getStatus(email, serviceKey) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/user_profiles?email=eq.${encodeURIComponent(email)}&select=oura_refresh_token_enc,oura_account_email`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
  );
  const rows = await res.json();
  const row = Array.isArray(rows) ? rows[0] : null;
  return json(200, {
    connected:          !!row?.oura_refresh_token_enc,
    oura_account_email: row?.oura_account_email || null,
  });
}

async function disconnect(email, serviceKey) {
  const encKey    = process.env.ADMIN_ENCRYPTION_KEY;
  const clientId  = process.env.BETA_OURA_CLIENT_ID;
  const clientSec = process.env.BETA_OURA_CLIENT_SECRET;
  if (!encKey || !clientId || !clientSec) throw new Error('oura_misconfigured');

  const profRes = await fetch(
    `${SUPABASE_URL}/rest/v1/user_profiles?email=eq.${encodeURIComponent(email)}&select=oura_refresh_token_enc`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
  );
  const rows = await profRes.json();
  const enc = Array.isArray(rows) ? rows[0]?.oura_refresh_token_enc : null;

  if (enc) {
    try {
      const refreshToken = decryptToken(enc, encKey);
      const tr = await fetch(OURA_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type:    'refresh_token',
          refresh_token: refreshToken,
          client_id:     clientId,
          client_secret: clientSec,
        }),
      });
      const tk = await tr.json();
      if (tk.access_token) {
        await fetch(OURA_REVOKE, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            access_token:  tk.access_token,
            client_id:     clientId,
            client_secret: clientSec,
          }),
        }).catch(() => {});
      }
    } catch (err) {
      console.warn('oura: revoke failed (non-fatal):', err.message);
    }
  }

  const upd = await fetch(`${SUPABASE_URL}/rest/v1/user_profiles?email=eq.${encodeURIComponent(email)}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      apikey:         serviceKey,
      Authorization:  `Bearer ${serviceKey}`,
    },
    body: JSON.stringify({
      oura_refresh_token_enc: null,
      oura_account_email:     null,
      updated_at:             new Date().toISOString(),
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

// User-facing endpoint to manage per-user Whoop developer credentials.
// Whoop's "bring your own app" model: each user creates their own Whoop dev
// app at developer.whoop.com and pastes their client_id + client_secret here.
// We store client_id plaintext (it's public per OAuth spec) and encrypt the
// secret with AES-256-GCM using ADMIN_ENCRYPTION_KEY.
//
// Actions:
//   status → { configured, has_client_id, client_id (last 4 chars only), connected }
//   set    → body { client_id, client_secret } → save both
//   clear  → wipe creds AND any stored refresh token

const { createCipheriv } = require('crypto');

const SUPABASE_URL = 'https://dmuwncwptvnnlizuxhta.supabase.co';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return cors({ statusCode: 204, body: '' });

  const bearer = (event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!bearer) return cors(json(401, { error: 'missing_token' }));

  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  const encKey     = process.env.ADMIN_ENCRYPTION_KEY;
  if (!serviceKey || !encKey) return cors(json(500, { error: 'server_misconfigured' }));

  let callerEmail;
  try {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${bearer}` },
    });
    if (!userRes.ok) return cors(json(401, { error: 'invalid_token' }));
    callerEmail = (await userRes.json()).email;
  } catch (err) {
    console.error('whoop-creds: token validation error:', err.message);
    return cors(json(401, { error: 'token_validation_failed' }));
  }

  let body = {};
  try { body = event.body ? JSON.parse(event.body) : {}; } catch {}
  const action = event.queryStringParameters?.action || body.action;

  try {
    switch (action) {
      case 'status': return cors(await getStatus(callerEmail, serviceKey));
      case 'set':    return cors(await setCreds(callerEmail, body, serviceKey, encKey));
      case 'clear':  return cors(await clearCreds(callerEmail, serviceKey));
      default:       return cors(json(400, { error: 'unknown_action' }));
    }
  } catch (err) {
    console.error(`whoop-creds action ${action} error:`, err.message);
    return cors(json(500, { error: err.message }));
  }
};

async function getStatus(email, serviceKey) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/user_profiles?email=eq.${encodeURIComponent(email)}&select=whoop_client_id,whoop_client_secret_enc,whoop_refresh_token_enc,whoop_account_email`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
  );
  const rows = await res.json();
  const row  = Array.isArray(rows) ? rows[0] : null;
  const clientId = row?.whoop_client_id || null;
  return json(200, {
    configured:          !!(clientId && row?.whoop_client_secret_enc),
    client_id:           clientId,                       // public — fine to return whole
    connected:           !!row?.whoop_refresh_token_enc,
    whoop_account_email: row?.whoop_account_email || null,
  });
}

async function setCreds(email, body, serviceKey, encKey) {
  const clientId     = (body.client_id || '').trim();
  const clientSecret = (body.client_secret || '').trim();
  if (!clientId)     return json(400, { error: 'missing_client_id' });
  if (!clientSecret) return json(400, { error: 'missing_client_secret' });
  if (clientId.length > 200 || clientSecret.length > 500) {
    return json(400, { error: 'value_too_long' });
  }

  const encryptedSecret = encryptToken(clientSecret, encKey);

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
      whoop_client_id:         clientId,
      whoop_client_secret_enc: encryptedSecret,
      updated_at:              new Date().toISOString(),
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`upsert_failed: ${res.status} ${text}`);
  }
  return json(200, { ok: true });
}

async function clearCreds(email, serviceKey) {
  // Wipe creds AND any stored refresh token — a swap of credentials implicitly
  // disconnects, since old tokens won't work with new client_id/secret anyway.
  const res = await fetch(`${SUPABASE_URL}/rest/v1/user_profiles?email=eq.${encodeURIComponent(email)}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      apikey:         serviceKey,
      Authorization:  `Bearer ${serviceKey}`,
    },
    body: JSON.stringify({
      whoop_client_id:         null,
      whoop_client_secret_enc: null,
      whoop_refresh_token_enc: null,
      whoop_account_email:     null,
      whoop_user_id:           null,
      updated_at:              new Date().toISOString(),
    }),
  });
  if (!res.ok) throw new Error(`clear_failed: ${res.status}`);
  return json(200, { ok: true });
}

function encryptToken(plaintext, hexKey) {
  const key = Buffer.from(hexKey, 'hex');
  const iv  = require('crypto').randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct  = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
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

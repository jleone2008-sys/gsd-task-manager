// Admin API — privileged operations for the GSD beta admin dashboard.
// All actions require a valid admin JWT (Bearer token from Supabase session).
//
// Required env vars:
//   SUPABASE_SERVICE_KEY  — service_role key (bypasses RLS)
//   ADMIN_ENCRYPTION_KEY  — 64 hex chars (32 bytes) for AES-256-GCM
//   SUPABASE_JWT_SECRET   — from Supabase Settings > API > JWT Settings
//   BETA_GOOGLE_CLIENT_ID / BETA_GOOGLE_CLIENT_SECRET — for refresh token exchange

const { createCipheriv, createDecipheriv, randomBytes, createHmac } = require('crypto');

const SUPABASE_URL    = 'https://dmuwncwptvnnlizuxhta.supabase.co';
const GOOGLE_CLIENT_ID = '508677465416-ptiaqbjlqq8cmf8f1gertead6493u7ei.apps.googleusercontent.com';

exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return cors({ statusCode: 204, body: '' });
  }

  // Validate admin JWT on every request
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const bearerToken = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!bearerToken) return cors(json(401, { error: 'missing_token' }));

  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!serviceKey) return cors(json(500, { error: 'server_misconfigured' }));

  // Verify token and get caller identity
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

  // Check admin role in user_profiles
  try {
    const profileRes = await supabaseFetch(
      `/rest/v1/user_profiles?email=eq.${encodeURIComponent(callerEmail)}&select=role`,
      'GET', null, null, serviceKey
    );
    const profiles = await profileRes.json();
    if (!profiles?.[0] || profiles[0].role !== 'admin') {
      return cors(json(403, { error: 'not_admin' }));
    }
  } catch (err) {
    console.error('Admin check error:', err.message);
    return cors(json(500, { error: 'admin_check_failed' }));
  }

  // Route to action
  const action = event.queryStringParameters?.action ||
    (event.body ? JSON.parse(event.body).action : null);

  try {
    switch (action) {
      case 'verify-admin':      return cors(json(200, { ok: true, email: callerEmail }));
      case 'list-users':        return cors(await listUsers(serviceKey));
      case 'update-user':       return cors(await updateUser(JSON.parse(event.body), serviceKey));
      case 'revoke-token':      return cors(await revokeToken(JSON.parse(event.body), serviceKey));
      case 'view-as-user':      return cors(await viewAsUser(JSON.parse(event.body), serviceKey));
      case 'get-google-token':  return cors(await getGoogleToken(JSON.parse(event.body), serviceKey));
      case 'get-gsd-data':      return cors(await getGsdData(JSON.parse(event.body), serviceKey));
      default:                  return cors(json(400, { error: 'unknown_action' }));
    }
  } catch (err) {
    console.error(`Action ${action} error:`, err.message);
    return cors(json(500, { error: err.message }));
  }
};

// ── Action handlers ────────────────────────────────────────────────────────

async function listUsers(serviceKey) {
  // Get all user_profiles
  const profilesRes = await supabaseFetch(
    '/rest/v1/user_profiles?select=email,role,status,tab_permissions,display_name,supabase_user_id,updated_at',
    'GET', null, null, serviceKey
  );
  const profiles = await profilesRes.json();
  if (!Array.isArray(profiles)) return json(500, { error: 'failed_to_fetch_profiles' });

  // Get last_sign_in_at from auth.users for each known supabase_user_id
  const uids = profiles.map(p => p.supabase_user_id).filter(Boolean);
  let signInMap = {};
  if (uids.length) {
    try {
      // Fetch auth users in batches (Supabase admin list endpoint)
      const authRes = await supabaseFetch(
        `/auth/v1/admin/users?per_page=1000`,
        'GET', null, null, serviceKey
      );
      if (authRes.ok) {
        const authData = await authRes.json();
        const authUsers = authData.users || [];
        for (const u of authUsers) {
          signInMap[u.id] = u.last_sign_in_at;
        }
      }
    } catch { /* non-fatal */ }
  }

  const users = profiles.map(p => ({
    ...p,
    last_sign_in_at: p.supabase_user_id ? (signInMap[p.supabase_user_id] || null) : null,
    has_refresh_token: !!p.google_refresh_token_enc, // don't expose the token itself
  }));
  // Strip the encrypted token from the list response
  users.forEach(u => delete u.google_refresh_token_enc);

  return json(200, users);
}

async function updateUser(body, serviceKey) {
  const { email, role, status, tab_permissions } = body;
  if (!email) return json(400, { error: 'email_required' });

  const updates = { updated_at: new Date().toISOString() };
  if (role !== undefined)            updates.role = role;
  if (status !== undefined)          updates.status = status;
  if (tab_permissions !== undefined) updates.tab_permissions = tab_permissions;

  const res = await supabaseFetch(
    `/rest/v1/user_profiles?email=eq.${encodeURIComponent(email)}`,
    'PATCH', updates, null, serviceKey
  );
  if (!res.ok) {
    const text = await res.text();
    return json(500, { error: `update_failed: ${text}` });
  }
  return json(200, { ok: true });
}

async function revokeToken(body, serviceKey) {
  const { email } = body;
  if (!email) return json(400, { error: 'email_required' });

  const res = await supabaseFetch(
    `/rest/v1/user_profiles?email=eq.${encodeURIComponent(email)}`,
    'PATCH',
    { google_refresh_token_enc: null, updated_at: new Date().toISOString() },
    null, serviceKey
  );
  if (!res.ok) {
    const text = await res.text();
    return json(500, { error: `revoke_failed: ${text}` });
  }
  return json(200, { ok: true });
}

async function viewAsUser(body, serviceKey) {
  const { target_email } = body;
  if (!target_email) return json(400, { error: 'target_email_required' });

  // Fetch profile
  const profileRes = await supabaseFetch(
    `/rest/v1/user_profiles?email=eq.${encodeURIComponent(target_email)}&select=google_refresh_token_enc,supabase_user_id,display_name`,
    'GET', null, null, serviceKey
  );
  const profiles = await profileRes.json();
  const profile = profiles?.[0];
  if (!profile) return json(404, { error: 'user_not_found' });
  if (!profile.google_refresh_token_enc) return json(400, { error: 'no_refresh_token', message: 'User has not signed in since token capture was enabled. Ask them to sign out and back in.' });

  // Get fresh Google access token
  const googleToken = await exchangeRefreshToken(profile.google_refresh_token_enc);

  // Find supabase_user_id if missing (look up by email in auth.users)
  let userId = profile.supabase_user_id;
  if (!userId) {
    const authRes = await supabaseFetch(
      `/auth/v1/admin/users?per_page=1000`, 'GET', null, null, serviceKey
    );
    if (authRes.ok) {
      const authData = await authRes.json();
      const match = (authData.users || []).find(u => u.email === target_email);
      if (match) {
        userId = match.id;
        // Save it for future calls
        supabaseFetch(
          `/rest/v1/user_profiles?email=eq.${encodeURIComponent(target_email)}`,
          'PATCH', { supabase_user_id: userId }, null, serviceKey
        ).catch(() => {});
      }
    }
  }
  if (!userId) return json(404, { error: 'supabase_user_not_found', message: 'User has never signed in.' });

  // Sign a Supabase JWT for the target user (24-hour session)
  const supabaseToken = signSupabaseJwt(userId, target_email);

  return json(200, {
    supabase_access_token: supabaseToken,
    google_access_token:   googleToken,
    target_email,
    display_name: profile.display_name || target_email.split('@')[0],
  });
}

async function getGoogleToken(body, serviceKey) {
  const { target_email } = body;
  if (!target_email) return json(400, { error: 'target_email_required' });

  const profileRes = await supabaseFetch(
    `/rest/v1/user_profiles?email=eq.${encodeURIComponent(target_email)}&select=google_refresh_token_enc`,
    'GET', null, null, serviceKey
  );
  const profiles = await profileRes.json();
  const profile = profiles?.[0];
  if (!profile?.google_refresh_token_enc) return json(400, { error: 'no_refresh_token' });

  const accessToken = await exchangeRefreshToken(profile.google_refresh_token_enc);
  return json(200, { google_access_token: accessToken });
}

async function getGsdData(body, serviceKey) {
  const { target_email } = body;
  if (!target_email) return json(400, { error: 'target_email_required' });

  // Look up supabase_user_id
  const profileRes = await supabaseFetch(
    `/rest/v1/user_profiles?email=eq.${encodeURIComponent(target_email)}&select=supabase_user_id`,
    'GET', null, null, serviceKey
  );
  const profiles = await profileRes.json();
  const uid = profiles?.[0]?.supabase_user_id;
  if (!uid) return json(404, { error: 'user_not_found' });

  // Fetch counts from each table in parallel
  const [tasks, habits, notes, backups] = await Promise.all([
    supabaseFetch(`/rest/v1/tasks?user_id=eq.${uid}&select=id`, 'GET', null, null, serviceKey)
      .then(r => r.json()).then(rows => rows?.length ?? 0).catch(() => 0),
    supabaseFetch(`/rest/v1/habits?user_id=eq.${uid}&select=id`, 'GET', null, null, serviceKey)
      .then(r => r.json()).then(rows => rows?.length ?? 0).catch(() => 0),
    supabaseFetch(`/rest/v1/notes?user_id=eq.${uid}&select=id`, 'GET', null, null, serviceKey)
      .then(r => r.json()).then(rows => rows?.length ?? 0).catch(() => 0),
    supabaseFetch(`/rest/v1/backups?user_id=eq.${uid}&select=backup_date&order=backup_date.desc&limit=1`, 'GET', null, null, serviceKey)
      .then(r => r.json()).then(rows => rows?.[0]?.backup_date ?? null).catch(() => null),
  ]);

  return json(200, { task_count: tasks, habit_count: habits, note_count: notes, last_backup: backups });
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function exchangeRefreshToken(encryptedToken) {
  const encKey       = process.env.ADMIN_ENCRYPTION_KEY;
  const clientSecret = process.env.BETA_GOOGLE_CLIENT_SECRET;
  if (!encKey || !clientSecret) throw new Error('Missing encryption key or Google client secret');

  const refreshToken = decryptToken(encryptedToken, encKey);

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
  if (data.error) throw new Error(`Google token refresh failed: ${data.error} — ${data.error_description}`);
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

function signSupabaseJwt(userId, email) {
  const jwtSecret = process.env.SUPABASE_JWT_SECRET;
  if (!jwtSecret) throw new Error('SUPABASE_JWT_SECRET not set');

  const header  = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    iss:   'supabase',
    ref:   'dmuwncwptvnnlizuxhta',
    role:  'authenticated',
    aud:   'authenticated',
    sub:   userId,
    email: email,
    iat:   Math.floor(Date.now() / 1000),
    exp:   Math.floor(Date.now() / 1000) + 86400, // 24 hours
  }));

  const sig = createHmac('sha256', jwtSecret)
    .update(`${header}.${payload}`)
    .digest('base64url');

  return `${header}.${payload}.${sig}`;
}

function b64url(str) {
  return Buffer.from(str).toString('base64url');
}

async function supabaseFetch(path, method, body, userToken, serviceKey) {
  const headers = {
    'Content-Type': 'application/json',
    'apikey':       serviceKey,
    'Authorization': `Bearer ${userToken || serviceKey}`,
  };
  if (method === 'PATCH') headers['Prefer'] = 'return=minimal';
  if (method === 'POST')  headers['Prefer'] = 'resolution=merge-duplicates';

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

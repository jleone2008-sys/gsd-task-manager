// Admin API — privileged operations for the GSD beta admin dashboard.
// All actions require a valid admin JWT (Bearer token from Supabase session).
//
// Required env vars:
//   SUPABASE_SERVICE_KEY  — service_role key (bypasses RLS)
//   ADMIN_ENCRYPTION_KEY  — 64 hex chars (32 bytes) for AES-256-GCM
//   SUPABASE_JWT_SECRET   — from Supabase Settings > API > JWT Settings
//   BETA_GOOGLE_CLIENT_ID / BETA_GOOGLE_CLIENT_SECRET — for refresh token exchange

const { createCipheriv, createDecipheriv, randomBytes, createHmac } = require('crypto');

const SUPABASE_URL     = 'https://dmuwncwptvnnlizuxhta.supabase.co';
const GOOGLE_CLIENT_ID = '508677465416-ptiaqbjlqq8cmf8f1gertead6493u7ei.apps.googleusercontent.com';
const DROPBOX_CLIENT_ID = '7rf801fqot1xx8n';

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
      case 'get-drive-download-info': return cors(await getDriveDownloadInfo(JSON.parse(event.body), serviceKey));
      case 'get-dropbox-token': return cors(await getDropboxToken(JSON.parse(event.body), serviceKey));
      case 'get-dropbox-download-info': return cors(await getDropboxDownloadInfo(JSON.parse(event.body), serviceKey));
      case 'revoke-dropbox-token': return cors(await revokeDropboxToken(JSON.parse(event.body), serviceKey));
      case 'list-dropbox-shares':  return cors(await listDropboxShares(JSON.parse(event.body), serviceKey));
      case 'create-dropbox-share': return cors(await createDropboxShare(JSON.parse(event.body), serviceKey, callerEmail));
      case 'remove-dropbox-share': return cors(await removeDropboxShare(JSON.parse(event.body), serviceKey));
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
    '/rest/v1/user_profiles?select=email,role,status,tab_permissions,display_name,supabase_user_id,updated_at,google_refresh_token_enc,dropbox_refresh_token_enc,dropbox_account_email',
    'GET', null, null, serviceKey
  );
  const profiles = await profilesRes.json();
  if (!Array.isArray(profiles)) return json(500, { error: 'failed_to_fetch_profiles' });

  // Get last_sign_in_at + identities from auth.users for each user. Identities
  // tell us which auth method each user actually last used (google vs email
  // vs magic link). Useful for diagnosing "I signed in with Google" claims —
  // if identities.google.last_sign_in_at is stale, they're really using
  // session refresh, not a fresh OAuth handshake.
  const uids = profiles.map(p => p.supabase_user_id).filter(Boolean);
  let signInMap = {}, identitiesMap = {};
  if (uids.length) {
    try {
      const authRes = await supabaseFetch(
        `/auth/v1/admin/users?per_page=1000`,
        'GET', null, null, serviceKey
      );
      if (authRes.ok) {
        const authData = await authRes.json();
        const authUsers = authData.users || [];
        for (const u of authUsers) {
          signInMap[u.id] = u.last_sign_in_at;
          identitiesMap[u.id] = (u.identities || []).map(i => ({
            provider:        i.provider,
            last_sign_in_at: i.last_sign_in_at || null,
          }));
        }
      }
    } catch { /* non-fatal */ }
  }

  const users = profiles.map(p => ({
    ...p,
    last_sign_in_at: p.supabase_user_id ? (signInMap[p.supabase_user_id] || null) : null,
    identities:      p.supabase_user_id ? (identitiesMap[p.supabase_user_id] || []) : [],
    has_refresh_token:         !!p.google_refresh_token_enc,  // don't expose the token itself
    has_dropbox_token:         !!p.dropbox_refresh_token_enc,
  }));
  // Strip the encrypted tokens from the list response
  users.forEach(u => {
    delete u.google_refresh_token_enc;
    delete u.dropbox_refresh_token_enc;
  });

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

  // Look up supabase_user_id — fall back to auth.users lookup if not cached yet
  const profileRes = await supabaseFetch(
    `/rest/v1/user_profiles?email=eq.${encodeURIComponent(target_email)}&select=supabase_user_id`,
    'GET', null, null, serviceKey
  );
  const profiles = await profileRes.json();
  let uid = profiles?.[0]?.supabase_user_id;

  if (!uid) {
    const authRes = await supabaseFetch('/auth/v1/admin/users?per_page=1000', 'GET', null, null, serviceKey);
    if (authRes.ok) {
      const authData = await authRes.json();
      const match = (authData.users || []).find(u => u.email === target_email);
      if (match) uid = match.id;
    }
  }
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

async function getDriveDownloadInfo(body, serviceKey) {
  const { target_email, file_id, mime_type } = body;
  if (!target_email || !file_id) return json(400, { error: 'target_email_and_file_id_required' });

  const profileRes = await supabaseFetch(
    `/rest/v1/user_profiles?email=eq.${encodeURIComponent(target_email)}&select=google_refresh_token_enc`,
    'GET', null, null, serviceKey
  );
  const profiles = await profileRes.json();
  const profile = profiles?.[0];
  if (!profile?.google_refresh_token_enc) return json(400, { error: 'no_refresh_token' });

  const accessToken = await exchangeRefreshToken(profile.google_refresh_token_enc);

  let download_url;
  if (mime_type && mime_type.startsWith('application/vnd.google-apps.')) {
    const exportMime = pickExportMime(mime_type);
    download_url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file_id)}/export?mimeType=${encodeURIComponent(exportMime)}`;
  } else {
    download_url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file_id)}?alt=media`;
  }

  return json(200, { download_url, access_token: accessToken });
}

function pickExportMime(googleMime) {
  switch (googleMime) {
    case 'application/vnd.google-apps.document':     return 'application/pdf';
    case 'application/vnd.google-apps.spreadsheet':  return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'application/vnd.google-apps.presentation': return 'application/pdf';
    case 'application/vnd.google-apps.drawing':      return 'image/png';
    default:                                          return 'application/pdf';
  }
}

// ── Dropbox actions ───────────────────────────────────────────────────────

async function getDropboxToken(body, serviceKey) {
  const { target_email } = body;
  if (!target_email) return json(400, { error: 'target_email_required' });

  const profileRes = await supabaseFetch(
    `/rest/v1/user_profiles?email=eq.${encodeURIComponent(target_email)}&select=dropbox_refresh_token_enc`,
    'GET', null, null, serviceKey
  );
  const profiles = await profileRes.json();
  const enc = profiles?.[0]?.dropbox_refresh_token_enc;
  if (!enc) return json(400, { error: 'no_dropbox_refresh_token' });

  try {
    const accessToken = await exchangeDropboxRefreshToken(enc);
    return json(200, { dropbox_access_token: accessToken });
  } catch (err) {
    return json(400, { error: 'dropbox_token_exchange_failed', message: err.message });
  }
}

async function getDropboxDownloadInfo(body, serviceKey) {
  const { target_email, path } = body;
  if (!target_email || !path) return json(400, { error: 'target_email_and_path_required' });

  const profileRes = await supabaseFetch(
    `/rest/v1/user_profiles?email=eq.${encodeURIComponent(target_email)}&select=dropbox_refresh_token_enc`,
    'GET', null, null, serviceKey
  );
  const profiles = await profileRes.json();
  const enc = profiles?.[0]?.dropbox_refresh_token_enc;
  if (!enc) return json(400, { error: 'no_dropbox_refresh_token' });

  const accessToken = await exchangeDropboxRefreshToken(enc);
  // Dropbox file downloads are POST to the content host with Dropbox-API-Arg
  return json(200, {
    download_url: 'https://content.dropboxapi.com/2/files/download',
    access_token: accessToken,
    dropbox_api_arg: JSON.stringify({ path }),
  });
}

async function revokeDropboxToken(body, serviceKey) {
  const { email } = body;
  if (!email) return json(400, { error: 'email_required' });

  // Best-effort: mint a fresh access token and revoke at Dropbox so the
  // refresh token can no longer be used. Fall through to nulling the column.
  const profRes = await supabaseFetch(
    `/rest/v1/user_profiles?email=eq.${encodeURIComponent(email)}&select=dropbox_refresh_token_enc`,
    'GET', null, null, serviceKey
  );
  const profiles = await profRes.json();
  const enc = profiles?.[0]?.dropbox_refresh_token_enc;
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

  const res = await supabaseFetch(
    `/rest/v1/user_profiles?email=eq.${encodeURIComponent(email)}`,
    'PATCH',
    {
      dropbox_refresh_token_enc: null,
      dropbox_account_email:     null,
      updated_at:                new Date().toISOString(),
    },
    null, serviceKey
  );
  if (!res.ok) {
    const text = await res.text();
    return json(500, { error: `revoke_failed: ${text}` });
  }
  return json(200, { ok: true });
}

async function listDropboxShares(body, serviceKey) {
  const { target_email } = body;
  if (!target_email) return json(400, { error: 'target_email_required' });

  const res = await supabaseFetch(
    `/rest/v1/dropbox_shared_folders?user_email=eq.${encodeURIComponent(target_email)}&select=*&order=created_at.desc`,
    'GET', null, null, serviceKey
  );
  const rows = await res.json();
  return json(200, Array.isArray(rows) ? rows : []);
}

async function createDropboxShare(body, serviceKey, callerEmail) {
  const { target_email, folder_path, folder_name } = body;
  if (!target_email || !folder_path) return json(400, { error: 'target_email_and_folder_path_required' });

  // Need the user's still-valid Dropbox token to create the link on their account
  const profRes = await supabaseFetch(
    `/rest/v1/user_profiles?email=eq.${encodeURIComponent(target_email)}&select=dropbox_refresh_token_enc`,
    'GET', null, null, serviceKey
  );
  const profiles = await profRes.json();
  const enc = profiles?.[0]?.dropbox_refresh_token_enc;
  if (!enc) return json(400, { error: 'no_dropbox_refresh_token', message: 'User has not connected Dropbox.' });

  const accessToken = await exchangeDropboxRefreshToken(enc);

  // Create the public view-only link. If one already exists, Dropbox returns
  // an error containing the existing link — we surface that as success.
  let shareUrl;
  const createRes = await fetch('https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      path: folder_path,
      settings: {
        audience: 'public',
        access:   'viewer',
        requested_visibility: 'public',
      },
    }),
  });
  const createData = await createRes.json();

  if (createRes.ok && createData.url) {
    shareUrl = createData.url;
  } else if (createData.error?.['.tag'] === 'shared_link_already_exists' && createData.error?.shared_link_already_exists?.metadata?.url) {
    shareUrl = createData.error.shared_link_already_exists.metadata.url;
  } else if (createData.error_summary?.includes('shared_link_already_exists')) {
    // Fall back to list_shared_links to grab the existing URL
    const listRes = await fetch('https://api.dropboxapi.com/2/sharing/list_shared_links', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ path: folder_path, direct_only: true }),
    });
    const listData = await listRes.json();
    shareUrl = listData?.links?.[0]?.url;
    if (!shareUrl) return json(500, { error: 'share_lookup_failed', detail: listData });
  } else {
    return json(500, { error: 'create_share_failed', detail: createData });
  }

  // Upsert the share row — use a direct fetch so we can request both
  // resolution=merge-duplicates AND return=representation in one call.
  const upsertRes = await fetch(`${SUPABASE_URL}/rest/v1/dropbox_shared_folders?on_conflict=user_email,folder_path`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'apikey':        serviceKey,
      'Authorization': `Bearer ${serviceKey}`,
      'Prefer':        'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify({
      user_email:      target_email,
      folder_path,
      folder_name:     folder_name || null,
      shared_link_url: shareUrl,
      created_by:      callerEmail,
    }),
  });
  if (!upsertRes.ok) {
    const text = await upsertRes.text();
    return json(500, { error: `share_store_failed: ${text}` });
  }
  const rows = await upsertRes.json();
  return json(200, Array.isArray(rows) ? rows[0] : rows);
}

async function removeDropboxShare(body, serviceKey) {
  const { share_id } = body;
  if (!share_id) return json(400, { error: 'share_id_required' });

  // Look up the row so we know the URL and which user's token to try
  const rowRes = await supabaseFetch(
    `/rest/v1/dropbox_shared_folders?id=eq.${encodeURIComponent(share_id)}&select=*`,
    'GET', null, null, serviceKey
  );
  const rows = await rowRes.json();
  const row  = Array.isArray(rows) ? rows[0] : null;
  if (!row) return json(404, { error: 'share_not_found' });

  // Best-effort revoke at Dropbox (using the user's token if still valid)
  try {
    const profRes = await supabaseFetch(
      `/rest/v1/user_profiles?email=eq.${encodeURIComponent(row.user_email)}&select=dropbox_refresh_token_enc`,
      'GET', null, null, serviceKey
    );
    const profiles = await profRes.json();
    const enc = profiles?.[0]?.dropbox_refresh_token_enc;
    if (enc) {
      const accessToken = await exchangeDropboxRefreshToken(enc);
      await fetch('https://api.dropboxapi.com/2/sharing/revoke_shared_link', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({ url: row.shared_link_url }),
      });
    }
  } catch (err) {
    console.warn('Dropbox shared-link revoke failed (non-fatal):', err.message);
  }

  // Delete the row regardless of revoke outcome
  const delRes = await supabaseFetch(
    `/rest/v1/dropbox_shared_folders?id=eq.${encodeURIComponent(share_id)}`,
    'DELETE', null, null, serviceKey
  );
  if (!delRes.ok) {
    const text = await delRes.text();
    return json(500, { error: `share_delete_failed: ${text}` });
  }
  return json(200, { ok: true });
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

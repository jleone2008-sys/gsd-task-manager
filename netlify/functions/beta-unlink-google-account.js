// Unlinks a previously-linked secondary Google account: revokes the
// refresh_token at Google, deletes the linked_google_accounts row, and
// removes any calendar toggles scoped to that account from
// google_calendars_synced. The user's primary signed-in Google account
// cannot be unlinked through this endpoint.
// Auth: Supabase user JWT in Authorization header.
// Body: { account_email: "..." }

const { json, cors, preflight } = require('./lib/http');
const { decryptToken }          = require('./lib/encryption');
const { validateBearer }        = require('./lib/auth');
const { SUPABASE_URL, serviceHeaders } = require('./lib/supabase');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return cors(json(405, { error: 'method_not_allowed' }));

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

  const auth = await validateBearer(event, serviceKey);
  if (auth.error) return cors(json(auth.status, { error: auth.error }));
  const userId = auth.userId;

  // Look up the row so we can revoke the refresh token at Google.
  let encrypted;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/linked_google_accounts?user_id=eq.${encodeURIComponent(userId)}&google_email=eq.${encodeURIComponent(accountEmail)}&select=refresh_token_enc`,
      { headers: serviceHeaders(serviceKey) }
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
      { method: 'DELETE', headers: serviceHeaders(serviceKey) }
    );
  } catch (err) {
    console.warn('toggle cleanup failed', err);
  }

  // Delete the linked account row.
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/linked_google_accounts?user_id=eq.${encodeURIComponent(userId)}&google_email=eq.${encodeURIComponent(accountEmail)}`,
      { method: 'DELETE', headers: serviceHeaders(serviceKey) }
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

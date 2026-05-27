// OAuth proxy — exchanges Google auth code for tokens server-side, then
// stores the refresh_token in linked_google_accounts so the secondary
// account's calendars can feed Journal + Brief. Unlike beta-auth.js this
// does NOT mint a Supabase session; the user stays signed in as their
// primary account. The state param carries the user's existing Supabase
// JWT so we know which user_id to attach the linked account to.

const { createCipheriv, randomBytes } = require('crypto');

const SUPABASE_URL = 'https://dmuwncwptvnnlizuxhta.supabase.co';
const GOOGLE_CLIENT_ID = '508677465416-ptiaqbjlqq8cmf8f1gertead6493u7ei.apps.googleusercontent.com';

exports.handler = async (event) => {
  const { code, state, error } = event.queryStringParameters || {};

  const proto = event.headers['x-forwarded-proto'] || 'https';
  const host  = event.headers.host;
  const redirectUri = `${proto}://${host}/.netlify/functions/beta-link-google-account`;

  if (error) {
    return redirect(`/app#link_error=${encodeURIComponent(error)}`);
  }
  if (!code || !state) {
    return { statusCode: 400, body: 'Missing code or state.' };
  }

  const clientSecret = process.env.BETA_GOOGLE_CLIENT_SECRET;
  const serviceKey   = process.env.SUPABASE_SERVICE_KEY;
  const encKey       = process.env.ADMIN_ENCRYPTION_KEY;
  if (!clientSecret || !serviceKey || !encKey) {
    console.error('beta-link-google-account: missing env vars');
    return redirect('/app#link_error=server_misconfiguration');
  }

  // state == the user's Supabase access_token. Validate it via Supabase auth.
  let userId;
  try {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${state}`, apikey: serviceKey },
    });
    if (!userRes.ok) return redirect('/app#link_error=invalid_session');
    const userData = await userRes.json();
    userId = userData.id;
  } catch (err) {
    console.error('beta-link-google-account: session validation failed', err);
    return redirect('/app#link_error=session_validation_failed');
  }
  if (!userId) return redirect('/app#link_error=no_user');

  // Exchange auth code for tokens.
  let tokens;
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     GOOGLE_CLIENT_ID,
        client_secret: clientSecret,
        redirect_uri:  redirectUri,
        grant_type:    'authorization_code',
      }),
    });
    tokens = await res.json();
  } catch (err) {
    console.error('beta-link-google-account: token exchange failed', err);
    return redirect('/app#link_error=token_exchange_failed');
  }

  if (tokens.error) {
    console.error('beta-link-google-account: google token error', tokens.error, tokens.error_description);
    return redirect(`/app#link_error=${encodeURIComponent(tokens.error)}`);
  }

  if (!tokens.refresh_token) {
    // Google only returns refresh_token on the first consent. We force
    // prompt=consent on the client to avoid this, but guard anyway.
    return redirect('/app#link_error=no_refresh_token');
  }
  if (!tokens.id_token) return redirect('/app#link_error=no_id_token');

  const payload = decodeJwtPayload(tokens.id_token);
  const linkedEmail = payload?.email;
  const displayName = payload?.name || null;
  if (!linkedEmail) return redirect('/app#link_error=no_email_in_id_token');

  // Block linking a user's primary signed-in account — that account
  // already has its refresh_token stored on user_profiles.
  try {
    const primRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${state}`, apikey: serviceKey },
    });
    const primData = await primRes.json();
    if (primData?.email && primData.email.toLowerCase() === linkedEmail.toLowerCase()) {
      return redirect(`/app#link_error=${encodeURIComponent('same_as_primary')}`);
    }
  } catch (_) { /* non-fatal */ }

  const encrypted = encryptToken(tokens.refresh_token, encKey);

  // Upsert into linked_google_accounts (service role bypasses RLS).
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/linked_google_accounts`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'apikey':        serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Prefer':        'resolution=merge-duplicates',
      },
      body: JSON.stringify({
        user_id:           userId,
        google_email:      linkedEmail,
        refresh_token_enc: encrypted,
        display_name:      displayName,
        updated_at:        new Date().toISOString(),
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error('beta-link-google-account: supabase upsert failed', res.status, text);
      return redirect('/app#link_error=storage_failed');
    }
  } catch (err) {
    console.error('beta-link-google-account: upsert exception', err);
    return redirect('/app#link_error=storage_failed');
  }

  return redirect(`/app#linked=${encodeURIComponent(linkedEmail)}`);
};

function redirect(location) {
  return { statusCode: 302, headers: { Location: location }, body: '' };
}

function encryptToken(plaintext, hexKey) {
  const key = Buffer.from(hexKey, 'hex');
  const iv  = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct  = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
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

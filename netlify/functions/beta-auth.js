// OAuth proxy for /beta — exchanges Google auth code for tokens server-side
// so the beta Google client secret never touches the browser.
// Flow: browser → Google → here → /beta/app#id_token=...&access_token=...

exports.handler = async (event) => {
  const { code, state, error } = event.queryStringParameters || {};

  const proto = event.headers['x-forwarded-proto'] || 'https';
  const host  = event.headers.host;
  const redirectUri = `${proto}://${host}/.netlify/functions/beta-auth`;

  if (error) {
    return redirect(`/beta/app#error=${encodeURIComponent(error)}&state=${state || ''}`);
  }

  if (!code) {
    return { statusCode: 400, body: 'Missing authorization code.' };
  }

  const clientId     = process.env.BETA_GOOGLE_CLIENT_ID;
  const clientSecret = process.env.BETA_GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error('Missing BETA_GOOGLE_CLIENT_ID or BETA_GOOGLE_CLIENT_SECRET env vars');
    return redirect(`/beta/app#error=server_misconfiguration&state=${state || ''}`);
  }

  let tokens;
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     clientId,
        client_secret: clientSecret,
        redirect_uri:  redirectUri,
        grant_type:    'authorization_code',
      }),
    });
    tokens = await res.json();
  } catch (err) {
    console.error('Token exchange fetch failed:', err);
    return redirect(`/beta/app#error=token_exchange_failed&state=${state || ''}`);
  }

  if (tokens.error) {
    console.error('Google token error:', tokens.error, tokens.error_description);
    return redirect(`/beta/app#error=${encodeURIComponent(tokens.error)}&state=${state || ''}`);
  }

  const params = new URLSearchParams({
    id_token:     tokens.id_token     || '',
    access_token: tokens.access_token || '',
    state:        state               || '',
  });

  return redirect(`/beta/app#${params}`);
};

function redirect(location) {
  return { statusCode: 302, headers: { Location: location }, body: '' };
}

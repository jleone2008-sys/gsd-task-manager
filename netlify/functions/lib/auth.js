// Supabase JWT validation helper for Netlify Functions.
//
// Replaces the ~10 copies of the same "extract bearer → hit
// /auth/v1/user → return user" pattern that lived in handlers.
//
// Returns { userId, email, error } where error is null on success.
// Callers should: if (auth.error) return cors(json(auth.status, ...))

const { SUPABASE_URL } = require('./supabase');

async function validateBearer(event, serviceKey) {
  const header = event.headers.authorization || event.headers.Authorization || '';
  const token  = header.replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    return { userId: null, email: null, error: 'missing_token', status: 401 };
  }
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: serviceKey },
    });
    if (!res.ok) {
      return { userId: null, email: null, error: 'invalid_token', status: 401 };
    }
    const data = await res.json();
    if (!data?.id) {
      return { userId: null, email: null, error: 'no_user_on_token', status: 401 };
    }
    return { userId: data.id, email: data.email || null, error: null, status: 200 };
  } catch (err) {
    console.error('[auth] token validation failed', err.message);
    return { userId: null, email: null, error: 'token_validation_failed', status: 401 };
  }
}

module.exports = { validateBearer };

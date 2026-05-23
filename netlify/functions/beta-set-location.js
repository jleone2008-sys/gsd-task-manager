// User-facing endpoint: geocode a city name via Open-Meteo and store the
// resolved lat/lng/label on user_profiles. Called from beta Settings when
// the user enters/updates their location.
//
// Open-Meteo geocoding is free and requires no API key:
//   https://geocoding-api.open-meteo.com/v1/search?name=<city>&count=1
//
// POST body: { city: string }
// Auth:      Supabase JWT (Bearer)
// Returns:   { ok: true, city, weather_lat, weather_lng, weather_label }

const SUPABASE_URL = 'https://dmuwncwptvnnlizuxhta.supabase.co';
const GEOCODE_URL  = 'https://geocoding-api.open-meteo.com/v1/search';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return cors({ statusCode: 204, body: '' });
  if (event.httpMethod !== 'POST')    return cors(json(405, { error: 'method_not_allowed' }));

  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!serviceKey) return cors(json(500, { error: 'server_misconfigured' }));

  // Auth
  const bearer = (event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!bearer) return cors(json(401, { error: 'missing_token' }));
  let callerEmail;
  try {
    const ur = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${bearer}` },
    });
    if (!ur.ok) return cors(json(401, { error: 'invalid_token' }));
    callerEmail = (await ur.json()).email;
  } catch (err) {
    return cors(json(401, { error: 'token_validation_failed', detail: err.message }));
  }

  // Parse body
  let body;
  try { body = event.body ? JSON.parse(event.body) : {}; }
  catch { return cors(json(400, { error: 'bad_json' })); }
  const cityInput = String(body.city || '').trim();
  if (!cityInput) return cors(json(400, { error: 'missing_city' }));
  if (cityInput.length > 200) return cors(json(400, { error: 'city_too_long' }));

  // Geocode
  let geo;
  try {
    const r = await fetch(`${GEOCODE_URL}?name=${encodeURIComponent(cityInput)}&count=1&language=en&format=json`);
    if (!r.ok) return cors(json(502, { error: 'geocode_failed', detail: `HTTP ${r.status}` }));
    geo = await r.json();
  } catch (err) {
    return cors(json(502, { error: 'geocode_unreachable', detail: err.message }));
  }
  const hit = (geo?.results || [])[0];
  if (!hit || hit.latitude == null || hit.longitude == null) {
    return cors(json(404, { error: 'city_not_found', city: cityInput }));
  }

  // Build a human-readable label: "Name, Admin1, Country" (e.g. "Birmingham, Michigan, US")
  const labelParts = [hit.name, hit.admin1, hit.country_code].filter(Boolean);
  const weather_label = labelParts.join(', ');

  // Store
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/user_profiles?email=eq.${encodeURIComponent(callerEmail)}`, {
      method: 'PATCH',
      headers: {
        'Content-Type':  'application/json',
        apikey:          serviceKey,
        Authorization:   `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({
        city:           cityInput,
        weather_lat:    hit.latitude,
        weather_lng:    hit.longitude,
        weather_label:  weather_label,
        updated_at:     new Date().toISOString(),
      }),
    });
    if (!r.ok) {
      const text = await r.text();
      return cors(json(500, { error: 'store_failed', detail: text.slice(0, 200) }));
    }
  } catch (err) {
    return cors(json(500, { error: 'store_unreachable', detail: err.message }));
  }

  return cors(json(200, {
    ok:            true,
    city:          cityInput,
    weather_lat:   hit.latitude,
    weather_lng:   hit.longitude,
    weather_label,
  }));
};

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function cors(res) {
  return {
    ...res,
    headers: {
      ...(res.headers || {}),
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    },
  };
}

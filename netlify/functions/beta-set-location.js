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

// US state code → full name. Open-Meteo returns admin1 as the full state name
// (e.g. "Michigan"), so we expand 2-letter codes before filtering candidates.
const US_STATE_NAME_BY_CODE = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri',
  MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio',
  OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  DC: 'District of Columbia',
};

// Parse "City, ST" or "City, State Name" into parts. Single-token input is
// treated as city with no state filter.
function parseCityInput(input) {
  const parts = input.split(',').map(p => p.trim()).filter(Boolean);
  if (parts.length === 1) return { city: parts[0], state: null };
  return { city: parts[0], state: parts.slice(1).join(', ') };
}

// Expand "MI" → "Michigan"; pass through "Michigan" unchanged.
function expandStateName(state) {
  if (!state) return null;
  const trimmed = state.trim();
  if (trimmed.length === 2) return US_STATE_NAME_BY_CODE[trimmed.toUpperCase()] || trimmed;
  return trimmed;
}

// Pick the best candidate from Open-Meteo's results. Prefer exact admin1
// (state) match when the user supplied a state; otherwise take the first.
function pickBestMatch(results, state) {
  if (!Array.isArray(results) || !results.length) return null;
  if (!state) return results[0];
  const expandedState = (expandStateName(state) || '').toLowerCase();
  const match = results.find(r => r.admin1 && r.admin1.toLowerCase() === expandedState);
  return match || results[0];
}

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

  // Parse "City, State" — Open-Meteo's geocoder expects just the city name
  // (state in the input confuses it). We strip the state for the query and
  // use it to filter results client-side.
  const { city: cityOnly, state } = parseCityInput(cityInput);

  // Geocode (count=10 to give us candidates to filter by state)
  let geo;
  try {
    const r = await fetch(`${GEOCODE_URL}?name=${encodeURIComponent(cityOnly)}&count=10&language=en&format=json`);
    if (!r.ok) return cors(json(502, { error: 'geocode_failed', detail: `HTTP ${r.status}` }));
    geo = await r.json();
  } catch (err) {
    return cors(json(502, { error: 'geocode_unreachable', detail: err.message }));
  }
  const hit = pickBestMatch(geo?.results, state);
  if (!hit || hit.latitude == null || hit.longitude == null) {
    return cors(json(404, {
      error:  'city_not_found',
      detail: `No location matches "${cityInput}". Try "City, ST" (e.g. "Birmingham, MI"), the full state name, or just the city.`,
      input:  cityInput,
    }));
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

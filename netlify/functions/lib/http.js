// Shared HTTP response helpers for Netlify Functions.
//
// Replaces the per-file `cors()` + `json()` pair that ~18 functions all
// redefined. Default Allow-Methods is the superset (GET, POST, OPTIONS)
// — strictly broader than every caller previously declared, which is
// safe (Allow-Methods is a preflight hint, not enforcement).

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function cors(response, methods = 'GET, POST, OPTIONS') {
  return {
    ...response,
    headers: {
      ...(response.headers || {}),
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': methods,
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  };
}

// Standard preflight short-circuit. Use at the top of OPTIONS-supporting handlers:
//   if (event.httpMethod === 'OPTIONS') return preflight();
function preflight() {
  return cors({ statusCode: 204, body: '' });
}

module.exports = { json, cors, preflight };

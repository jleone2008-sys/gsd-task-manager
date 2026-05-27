// Single source of truth for the Supabase project URL and PostgREST
// header boilerplate used by Netlify Functions. Replaces the same
// literal hardcoded in ~29 different files.
//
// SUPABASE_URL is intentionally a constant rather than an env var:
// the project URL is public (RLS + JWT enforce auth; the URL alone
// is not sensitive) and embedded in the client bundle anyway.

const SUPABASE_URL = 'https://dmuwncwptvnnlizuxhta.supabase.co';

// Standard headers for service-role PostgREST calls.
function serviceHeaders(serviceKey, extra = {}) {
  return {
    apikey:          serviceKey,
    Authorization:   `Bearer ${serviceKey}`,
    'Content-Type':  'application/json',
    ...extra,
  };
}

// Pass `Prefer: resolution=merge-duplicates` for upsert behavior.
function upsertHeaders(serviceKey) {
  return serviceHeaders(serviceKey, { Prefer: 'resolution=merge-duplicates' });
}

module.exports = { SUPABASE_URL, serviceHeaders, upsertHeaders };

// Phase 6 — semantic search across the user's knowledge base.
//
// JWT-authenticated POST: { query: string, top_k?: number }
//
// Pipeline:
//   1. Embed the query string via OpenAI text-embedding-3-small.
//   2. Call the search_knowledge_chunks RPC with that embedding +
//      the validated user_id.
//   3. Return top-K chunks (default 5) with parent document context
//      so the caller can render results without a follow-up query.
//
// Used by:
//   - The Brain tab's in-app search bar (client side, returns ranked
//     chunks with snippets + document links).
//   - The daily-brief function as a Claude tool (search_knowledge),
//     so the brief can answer "what was my LDL last test?" by
//     calling this and quoting the chunks back.
//
// Response shape:
//   { chunks: [{ chunk_id, document_id, document_title, document_kind,
//                chunk_index, content, similarity }] }
//
// Returns an empty chunks array (not an error) when the user has no
// documents or when nothing scores above the floor — caller handles
// the empty-state UI.

const SUPABASE_URL = 'https://dmuwncwptvnnlizuxhta.supabase.co';
const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';
const EMBEDDING_MODEL = 'text-embedding-3-small';
const DEFAULT_TOP_K   = 5;
const MAX_TOP_K       = 20;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return cors({ statusCode: 204, body: '' });
  if (event.httpMethod !== 'POST')    return cors(json(405, { error: 'method_not_allowed' }));

  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  const openaiKey  = process.env.OPENAI_API_KEY;
  if (!serviceKey) return cors(json(500, { error: 'server_misconfigured', detail: 'SUPABASE_SERVICE_KEY' }));
  if (!openaiKey)  return cors(json(500, { error: 'server_misconfigured', detail: 'OPENAI_API_KEY' }));

  // ── Auth ───────────────────────────────────────────────────────
  const bearer = (event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!bearer) return cors(json(401, { error: 'missing_token' }));
  const ur = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${bearer}` },
  });
  if (!ur.ok) return cors(json(401, { error: 'invalid_token' }));
  const userJson = await ur.json();
  const userId = userJson.id;
  if (!userId) return cors(json(401, { error: 'invalid_token' }));

  // ── Body ───────────────────────────────────────────────────────
  let body;
  try { body = event.body ? JSON.parse(event.body) : {}; }
  catch (e) { return cors(json(400, { error: 'invalid_json' })); }

  const query = String(body.query || '').trim();
  if (!query) return cors(json(400, { error: 'query_required' }));
  if (query.length > 4000) return cors(json(400, { error: 'query_too_long', detail: 'max 4000 chars' }));

  const topK = Math.min(MAX_TOP_K, Math.max(1, parseInt(body.top_k, 10) || DEFAULT_TOP_K));

  try {
    // ── Embed query ─────────────────────────────────────────────
    const queryVec = await embedOne(query, openaiKey);

    // ── RPC call ────────────────────────────────────────────────
    const rpcUrl = `${SUPABASE_URL}/rest/v1/rpc/search_knowledge_chunks`;
    const r = await fetch(rpcUrl, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        apikey:          serviceKey,
        Authorization:   `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({
        p_user_id:       userId,
        query_embedding: pgvectorLiteral(queryVec),
        match_count:     topK,
      }),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      throw new Error(`rpc_${r.status}: ${text.slice(0, 200)}`);
    }
    const rows = await r.json();

    return cors(json(200, {
      chunks: Array.isArray(rows) ? rows : [],
    }));
  } catch (err) {
    console.error('[knowledge-search] failed:', err.message);
    return cors(json(500, { error: 'search_failed', detail: err.message }));
  }
};

// ── OpenAI single-string embed ────────────────────────────────────────
async function embedOne(text, openaiKey) {
  const r = await fetch(OPENAI_EMBEDDINGS_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${openaiKey}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ input: text, model: EMBEDDING_MODEL }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`openai_embed_${r.status}: ${j?.error?.message || ''}`);
  const vec = j.data?.[0]?.embedding;
  if (!Array.isArray(vec) || vec.length !== 1536) {
    throw new Error(`openai_embed_bad_shape: dims=${vec?.length}`);
  }
  return vec;
}

// pgvector literal format for PostgREST.
function pgvectorLiteral(vec) {
  return '[' + vec.map(v => v.toFixed(6)).join(',') + ']';
}

// ── HTTP helpers ──────────────────────────────────────────────────────
function json(statusCode, payload) {
  return { statusCode, body: JSON.stringify(payload) };
}
function cors(res) {
  return {
    ...res,
    headers: {
      ...(res.headers || {}),
      'Content-Type':                 'application/json',
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    },
  };
}

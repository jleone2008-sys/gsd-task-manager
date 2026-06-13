// Phase 6 — knowledge base ingest pipeline (BACKGROUND function).
//
// File is named beta-knowledge-ingest-background.js so Netlify runs it
// as a background function (15-min timeout). Synchronous functions max
// out at 10s, which isn't enough for Claude vision on a multi-page PDF
// plus embeddings plus summary generation. Caller gets 202 Accepted
// immediately; status is tracked via knowledge_documents.status
// (processing → ready / failed) which the client polls.
//
// JWT-authenticated POST. Requires document_id (client-generated UUID
// so it can poll status without a sync response body). Accepts one of:
//   1. { document_id, kind: 'text',  title, text, metadata? }
//   2. { document_id, kind: 'pdf'|'lab', title, content_base64, filename, metadata? }
//   3. { document_id, kind: 'image', title, content_base64, media_type, filename, metadata? }
//
// Pipeline:
//   a. Create knowledge_documents row with status='processing'.
//   b. For file inputs, decode base64 + upload to the 'knowledge'
//      Storage bucket at {user_id}/{document_id}/{filename}.
//   c. Extract text — Claude vision for PDFs/images, passthrough for text.
//   d. Chunk text (~500 tokens / 50-token overlap, paragraph-aware).
//   e. Embed all chunks in one OpenAI text-embedding-3-small batch.
//   f. Insert into knowledge_chunks.
//   g. Generate AI summary + 3-5 key facts (Claude tool_use).
//   h. For kind='lab': also run structured-extract over the text →
//      one row per test result into health_lab_results.
//   i. Update document row to status='ready' with summary + key_facts.
//
// Any failure mid-pipeline sets status='failed' + failure_reason so the
// timeline shows the error and the user can retry from the detail view.
//
// All DB writes use the service key with explicit user_id enforcement
// — RLS-bypass for performance, but every row carries user_id set from
// the validated JWT.

const { json, cors, preflight } = require('./lib/http');
const { SUPABASE_URL } = require('./lib/supabase');
const { CLAUDE_MODEL, EMBEDDING_MODEL } = require('./lib/models');

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';

const EMBEDDING_DIMS  = 1536;

// claude-opus-4-8 is what beta-daily-brief defaults to and is known to
// work in this user's account. claude-sonnet-4-7 returned 404 on first
// attempt. Configurable via env var (KNOWLEDGE_MODEL) for future tuning.
const KNOWLEDGE_MODEL  = process.env.KNOWLEDGE_MODEL || CLAUDE_MODEL;
const SUMMARY_MODEL    = KNOWLEDGE_MODEL;
const EXTRACT_MODEL    = KNOWLEDGE_MODEL;
const MAX_TEXT_TOKENS  = 100_000;   // ~400KB of text; safety cap before chunking

const CHUNK_TARGET_CHARS  = 2000;   // ~500 tokens at ~4 chars/token
const CHUNK_OVERLAP_CHARS = 200;    // ~50-token overlap

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return cors({ statusCode: 204, body: '' });
  if (event.httpMethod !== 'POST')    return cors(json(405, { error: 'method_not_allowed' }));

  const serviceKey   = process.env.SUPABASE_SERVICE_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey    = process.env.OPENAI_API_KEY;
  if (!serviceKey)   return cors(json(500, { error: 'server_misconfigured', detail: 'SUPABASE_SERVICE_KEY' }));
  if (!anthropicKey) return cors(json(500, { error: 'server_misconfigured', detail: 'ANTHROPIC_API_KEY' }));
  if (!openaiKey)    return cors(json(500, { error: 'server_misconfigured', detail: 'OPENAI_API_KEY' }));

  // ── Authenticate ───────────────────────────────────────────────
  const bearer = (event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!bearer) return cors(json(401, { error: 'missing_token' }));
  const ur = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${bearer}` },
  });
  if (!ur.ok) return cors(json(401, { error: 'invalid_token' }));
  const userJson = await ur.json();
  const userId = userJson.id;
  if (!userId) return cors(json(401, { error: 'invalid_token' }));

  // ── Parse body ─────────────────────────────────────────────────
  let body;
  try { body = event.body ? JSON.parse(event.body) : {}; }
  catch (e) { return cors(json(400, { error: 'invalid_json' })); }

  const kind = body.kind;
  if (!['pdf', 'image', 'text', 'lab'].includes(kind)) {
    return cors(json(400, { error: 'invalid_kind', detail: `expected pdf|image|text|lab, got ${kind}` }));
  }
  const title = (body.title || '').trim().slice(0, 200);
  if (!title) return cors(json(400, { error: 'title_required' }));

  // Background functions return 202 with no body — the client can't
  // read back a server-generated UUID. So the client generates the
  // document_id (via crypto.randomUUID) and passes it in. The function
  // uses that id for the insert + all downstream writes, and the
  // client polls knowledge_documents for that id to track progress.
  const documentId = String(body.document_id || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(documentId)) {
    return cors(json(400, { error: 'document_id_required', detail: 'expected a v4-shaped UUID from the client' }));
  }

  // Validate per-kind required fields
  if (kind === 'text') {
    if (!body.text || typeof body.text !== 'string') {
      return cors(json(400, { error: 'text_required_for_text_kind' }));
    }
  } else {
    if (!body.content_base64 || typeof body.content_base64 !== 'string') {
      return cors(json(400, { error: 'content_base64_required' }));
    }
  }

  // ── Step a: insert document row (status='processing') ──────────
  // Use the client-supplied document_id so the client can poll.
  try {
    await dbInsert(`${SUPABASE_URL}/rest/v1/knowledge_documents`, {
      id:       documentId,
      user_id:  userId,
      kind,
      title,
      status:   'processing',
      metadata: body.metadata || null,
    }, serviceKey);
  } catch (e) {
    console.error('[knowledge-ingest] document insert failed:', e.message);
    return cors(json(500, { error: 'document_insert_failed', detail: e.message }));
  }

  // From here on, any failure marks the document 'failed' and returns
  // 200 with the doc id — the client surfaces the error inline rather
  // than the upload appearing to silently disappear.
  try {
    let storagePath = null;
    let extractedText;

    if (kind === 'text') {
      extractedText = String(body.text).slice(0, MAX_TEXT_TOKENS * 4);
    } else {
      // ── Step b: upload original to Storage ─────────────────────
      const filename = sanitizeFilename(body.filename || 'document');
      storagePath = `${userId}/${documentId}/${filename}`;
      const mediaType = body.media_type || (kind === 'pdf' || kind === 'lab' ? 'application/pdf' : 'image/jpeg');
      const bytes = Buffer.from(body.content_base64, 'base64');
      await storageUpload('knowledge', storagePath, bytes, mediaType, serviceKey);

      // ── Step c: extract text via Claude vision ────────────────
      extractedText = await extractTextFromFile(bytes, mediaType, anthropicKey);
      if (!extractedText || extractedText.trim().length === 0) {
        throw new Error('extracted_text_empty');
      }
    }

    // ── Step d: chunk ─────────────────────────────────────────────
    const chunks = chunkText(extractedText, CHUNK_TARGET_CHARS, CHUNK_OVERLAP_CHARS);
    if (chunks.length === 0) {
      throw new Error('no_chunks_produced');
    }

    // ── Step e: embed ────────────────────────────────────────────
    const embeddings = await embedBatch(chunks, openaiKey);
    if (embeddings.length !== chunks.length) {
      throw new Error(`embedding_count_mismatch: ${embeddings.length} vs ${chunks.length}`);
    }

    // ── Step f: insert chunks ─────────────────────────────────────
    const chunkRows = chunks.map((content, i) => ({
      document_id: documentId,
      user_id:     userId,
      chunk_index: i,
      content,
      embedding:   pgvectorLiteral(embeddings[i]),
    }));
    await dbInsert(`${SUPABASE_URL}/rest/v1/knowledge_chunks`, chunkRows, serviceKey);

    // ── Step g: AI summary + key facts ────────────────────────────
    const summaryResult = await generateSummaryAndFacts(extractedText, kind, title, anthropicKey);

    // ── Step h: lab structured extract (kind='lab' only) ──────────
    let labRowsInserted = 0;
    if (kind === 'lab') {
      try {
        const labRows = await extractLabResults(extractedText, anthropicKey);
        if (labRows.length > 0) {
          const stamped = labRows.map(r => ({
            ...r,
            user_id: userId,
            source_document_id: documentId,
          }));
          await dbInsert(`${SUPABASE_URL}/rest/v1/health_lab_results`, stamped, serviceKey);
          labRowsInserted = labRows.length;
        }
      } catch (labErr) {
        // Lab extract failures don't fail the whole document — the
        // doc + chunks are valuable on their own. Log + continue.
        console.warn('[knowledge-ingest] lab extract failed:', labErr.message);
      }
    }

    // ── Step i: finalize document row ────────────────────────────
    // Scope by user_id as well as id: document_id is client-supplied and the
    // service key bypasses RLS, so match on ownership too (don't rely on the
    // insert's PK-collision as the only cross-user guard).
    await dbPatch(`${SUPABASE_URL}/rest/v1/knowledge_documents?id=eq.${documentId}&user_id=eq.${userId}`, {
      source_text:   extractedText,
      ai_summary:    summaryResult.summary,
      ai_key_facts:  summaryResult.key_facts,
      storage_path:  storagePath,
      status:        'ready',
      processed_at:  new Date().toISOString(),
    }, serviceKey);

    return cors(json(200, {
      document_id: documentId,
      status: 'ready',
      chunks: chunks.length,
      lab_results: labRowsInserted,
    }));
  } catch (err) {
    console.error('[knowledge-ingest] pipeline failed:', err.message);
    await dbPatch(`${SUPABASE_URL}/rest/v1/knowledge_documents?id=eq.${documentId}&user_id=eq.${userId}`, {
      status: 'failed',
      failure_reason: String(err.message || err).slice(0, 500),
    }, serviceKey).catch(() => { /* best-effort */ });
    return cors(json(200, {
      document_id: documentId,
      status: 'failed',
      error: err.message,
    }));
  }
};

// ── Text extraction (Claude vision over PDF/image) ────────────────────
async function extractTextFromFile(bytes, mediaType, anthropicKey) {
  // Claude's document content block handles PDFs natively. Images use
  // the same shape with media_type set accordingly. The instruction
  // is intentionally minimal: just transcribe, no interpretation.
  // Downstream steps (chunking, embedding, summary) work on the raw
  // transcribed text.
  const contentBlock = (mediaType === 'application/pdf')
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: bytes.toString('base64') } }
    : { type: 'image',    source: { type: 'base64', media_type: mediaType,         data: bytes.toString('base64') } };

  const body = {
    model: SUMMARY_MODEL,
    max_tokens: 8000,
    messages: [{
      role: 'user',
      content: [
        contentBlock,
        { type: 'text', text: 'Transcribe ALL text from this document, verbatim. Preserve paragraph breaks. Include tables as tab-separated rows. Do not summarize, interpret, or skip anything. Output only the transcribed text — no preamble, no commentary.' },
      ],
    }],
  };

  const r = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         anthropicKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`anthropic_extract_${r.status}: ${j?.error?.message || ''}`);
  const text = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  if (!text) throw new Error('claude_returned_empty_transcription');
  return text;
}

// ── Chunking ──────────────────────────────────────────────────────────
// Paragraph-aware sliding window. Splits by blank lines first, then
// accumulates paragraphs into ~target-char chunks. Inserts a tail
// overlap from the previous chunk so semantic search can recover
// context that crosses chunk boundaries.
function chunkText(text, targetChars, overlapChars) {
  if (!text || !text.trim()) return [];
  const paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  const chunks = [];
  let buf = '';
  for (const para of paragraphs) {
    // If a single paragraph exceeds target, force-emit current buf
    // and split the long paragraph by sentence.
    if (para.length > targetChars * 2) {
      if (buf.length > 0) { chunks.push(buf); buf = tail(buf, overlapChars); }
      const sentences = para.split(/(?<=[.!?])\s+/);
      for (const s of sentences) {
        if ((buf + ' ' + s).length > targetChars && buf.length > 0) {
          chunks.push(buf.trim());
          buf = tail(buf, overlapChars) + ' ' + s;
        } else {
          buf = (buf ? buf + ' ' : '') + s;
        }
      }
      continue;
    }
    if (buf.length + para.length + 2 > targetChars && buf.length > 0) {
      chunks.push(buf.trim());
      buf = tail(buf, overlapChars) + '\n\n' + para;
    } else {
      buf = buf ? buf + '\n\n' + para : para;
    }
  }
  if (buf.trim().length > 0) chunks.push(buf.trim());
  return chunks;
}

function tail(text, n) {
  if (!text || text.length <= n) return text || '';
  return text.slice(-n);
}

// ── Embedding (OpenAI batch) ──────────────────────────────────────────
async function embedBatch(chunks, openaiKey) {
  // OpenAI accepts up to 2048 input strings per request and ~8191
  // tokens per input for text-embedding-3-small. Our chunks are
  // ~500 tokens, so a personal-scale doc (≤200 chunks) fits in one
  // request. For safety, split into 200-chunk pages.
  const out = [];
  const PAGE = 200;
  for (let i = 0; i < chunks.length; i += PAGE) {
    const page = chunks.slice(i, i + PAGE);
    const r = await fetch(OPENAI_EMBEDDINGS_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ input: page, model: EMBEDDING_MODEL }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`openai_embed_${r.status}: ${j?.error?.message || ''}`);
    if (!Array.isArray(j.data)) throw new Error('openai_embed_no_data');
    // OpenAI returns embeddings ordered by request order; sort by
    // index defensively.
    const sorted = [...j.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    for (const item of sorted) {
      if (!Array.isArray(item.embedding) || item.embedding.length !== EMBEDDING_DIMS) {
        throw new Error(`openai_embed_bad_shape: dims=${item.embedding?.length}`);
      }
      out.push(item.embedding);
    }
  }
  return out;
}

// pgvector accepts vectors as strings in '[v1,v2,...]' format via
// PostgREST. Keep precision tight enough for similarity search
// without bloating the row payload.
function pgvectorLiteral(vec) {
  return '[' + vec.map(v => v.toFixed(6)).join(',') + ']';
}

// ── AI summary + key facts (Claude tool_use) ──────────────────────────
async function generateSummaryAndFacts(text, kind, title, anthropicKey) {
  const systemPrompt = [
    "You are summarizing a document for a personal knowledge base.",
    "Produce: (1) a one-paragraph summary (≤300 chars) capturing what this document is about and its key takeaway, and (2) 3-5 short fact bullets that the user would want to see at a glance on a timeline card.",
    "Style: Direct, plain English. No filler. No 'this document is about...' framing — get straight to the substance.",
    "For lab/medical documents: surface actual values (e.g. 'LDL 105 · HDL 58'), not method commentary.",
    "For articles: surface the key claim + its supporting evidence, not the rhetorical structure.",
    "For notes: surface the decisions + open questions, not the meeting logistics.",
    "Call record_summary with the structured fields. Never reply in free text.",
  ].join('\n');

  const tool = {
    name: 'record_summary',
    description: 'Record the summary and key facts for the document.',
    input_schema: {
      type: 'object',
      properties: {
        summary:   { type: 'string', description: 'One-paragraph summary, ≤300 chars.' },
        key_facts: { type: 'array', items: { type: 'string' }, description: '3-5 short bullets, ≤120 chars each.', minItems: 1, maxItems: 5 },
      },
      required: ['summary', 'key_facts'],
    },
  };

  const r = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         anthropicKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: SUMMARY_MODEL,
      max_tokens: 800,
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: `Document kind: ${kind}\nTitle: ${title}\n\n---\n\n${text.slice(0, 50_000)}`,
      }],
      tools: [tool],
      tool_choice: { type: 'tool', name: 'record_summary' },
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`anthropic_summary_${r.status}: ${j?.error?.message || ''}`);
  const block = (j.content || []).find(b => b.type === 'tool_use' && b.name === 'record_summary');
  if (!block) throw new Error(`no_tool_use_in_summary: stop_reason=${j.stop_reason}`);
  const raw = block.input || {};
  const summary = String(raw.summary || '').trim().slice(0, 300);
  const key_facts = Array.isArray(raw.key_facts)
    ? raw.key_facts.slice(0, 5).map(s => String(s).trim().slice(0, 140)).filter(Boolean)
    : [];
  if (!summary || key_facts.length === 0) throw new Error('summary_or_facts_empty');
  return { summary, key_facts };
}

// ── Lab results structured extraction (Claude tool_use) ───────────────
async function extractLabResults(text, anthropicKey) {
  const systemPrompt = [
    "You are extracting structured test results from a lab/medical document.",
    "For each test reported in the document, emit one row with: test_date (YYYY-MM-DD), test_name (short canonical name like 'LDL' / 'A1C' / 'TSH'), value (numeric), unit, ref_range_low + ref_range_high when numeric, or ref_range_text for non-numeric ranges ('negative', '<1:40'), flag if the lab marked it ('low'|'normal'|'high'|'critical_low'|'critical_high').",
    "Skip narrative commentary, doctor notes, billing info. Only structured test rows.",
    "If a test appears multiple times (e.g. across panels), emit each occurrence.",
    "If no test results are present (this isn't actually a lab document), return an empty array.",
    "Call record_lab_results with the structured rows. Never reply in free text.",
  ].join('\n');

  const tool = {
    name: 'record_lab_results',
    description: 'Record the structured lab test results extracted from the document.',
    input_schema: {
      type: 'object',
      properties: {
        results: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              test_date:       { type: 'string', description: 'YYYY-MM-DD' },
              test_name:       { type: 'string' },
              value:           { type: 'number' },
              unit:            { type: 'string' },
              ref_range_low:   { type: 'number' },
              ref_range_high:  { type: 'number' },
              ref_range_text:  { type: 'string' },
              flag:            { type: 'string', enum: ['low', 'normal', 'high', 'critical_low', 'critical_high'] },
              notes:           { type: 'string' },
            },
            required: ['test_date', 'test_name'],
          },
        },
      },
      required: ['results'],
    },
  };

  const r = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         anthropicKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: EXTRACT_MODEL,
      max_tokens: 4000,
      system: systemPrompt,
      messages: [{ role: 'user', content: text.slice(0, 50_000) }],
      tools: [tool],
      tool_choice: { type: 'tool', name: 'record_lab_results' },
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`anthropic_lab_extract_${r.status}: ${j?.error?.message || ''}`);
  const block = (j.content || []).find(b => b.type === 'tool_use' && b.name === 'record_lab_results');
  if (!block) throw new Error(`no_tool_use_in_lab_extract: stop_reason=${j.stop_reason}`);
  const raw = block.input || {};
  const results = Array.isArray(raw.results) ? raw.results : [];
  // Normalize: ensure test_date is valid, drop rows without test_name.
  return results
    .filter(r => r.test_name && r.test_date && /^\d{4}-\d{2}-\d{2}$/.test(r.test_date))
    .map(r => ({
      test_date:      r.test_date,
      test_name:      String(r.test_name).slice(0, 100),
      value:          (typeof r.value === 'number') ? r.value : null,
      unit:           r.unit ? String(r.unit).slice(0, 30) : null,
      ref_range_low:  (typeof r.ref_range_low  === 'number') ? r.ref_range_low  : null,
      ref_range_high: (typeof r.ref_range_high === 'number') ? r.ref_range_high : null,
      ref_range_text: r.ref_range_text ? String(r.ref_range_text).slice(0, 100) : null,
      flag:           r.flag || null,
      notes:          r.notes ? String(r.notes).slice(0, 500) : null,
    }));
}

// ── DB helpers (PostgREST + Storage) ──────────────────────────────────
async function dbInsertReturning(url, row, serviceKey) {
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      apikey:          serviceKey,
      Authorization:   `Bearer ${serviceKey}`,
      Prefer:          'return=representation',
    },
    body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error(`db_insert_${r.status}: ${(await r.text()).slice(0, 200)}`);
  const arr = await r.json();
  if (!Array.isArray(arr) || arr.length === 0) throw new Error('db_insert_no_row');
  return arr[0];
}

async function dbInsert(url, rows, serviceKey) {
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      apikey:          serviceKey,
      Authorization:   `Bearer ${serviceKey}`,
      Prefer:          'return=minimal',
    },
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`db_insert_batch_${r.status}: ${(await r.text()).slice(0, 200)}`);
}

async function dbPatch(url, patch, serviceKey) {
  const r = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type':  'application/json',
      apikey:          serviceKey,
      Authorization:   `Bearer ${serviceKey}`,
      Prefer:          'return=minimal',
    },
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`db_patch_${r.status}: ${(await r.text()).slice(0, 200)}`);
}

async function storageUpload(bucket, path, bytes, mediaType, serviceKey) {
  const url = `${SUPABASE_URL}/storage/v1/object/${bucket}/${path}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': mediaType,
      'x-upsert':     'false',
    },
    body: bytes,
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`storage_upload_${r.status}: ${text.slice(0, 200)}`);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────
function sanitizeFilename(name) {
  // Strip path separators + unsafe chars; cap length.
  return String(name).replace(/[/\\:*?"<>|]/g, '_').slice(0, 120) || 'document';
}


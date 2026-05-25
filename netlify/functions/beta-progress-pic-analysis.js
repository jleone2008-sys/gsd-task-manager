// Phase 4 commit 7 — Claude vision body-composition analysis for a
// just-uploaded progress_pics row.
//
// JWT-authenticated POST: { progress_pic_id }. The function:
//   1. Reads the row + the most recent prior entry (for comparison)
//   2. Downloads each photo blob from the private progress-pics bucket
//      via the service key (RLS-bypass — we validate user_id match in
//      the row query first, so we never serve another user's blobs).
//   3. Sends the image blocks + a structured-extract prompt to Claude.
//      The tool-use schema enforces the ai_analysis shape that the
//      progress_pics migration documents.
//   4. Writes the analysis back to progress_pics.ai_analysis. When the
//      Navy formula didn't fire (no neck/waist), it also stores the
//      AI body-fat estimate to progress_pics.body_fat_pct so the
//      dashboard always has a number to show — tagged 'ai_estimate'
//      so the UI labels it honestly.
//
// Cost: each pic is downscaled client-side to ≤1600px before upload,
// and Claude vision charges per pixel. With 3 photos the input is
// typically ~4-6k vision tokens; the structured-extract output is
// small (~400 tokens).

const SUPABASE_URL  = 'https://dmuwncwptvnnlizuxhta.supabase.co';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

const DEFAULT_MODEL      = 'claude-opus-4-7';
const DEFAULT_MAX_TOKENS = 800;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return cors({ statusCode: 204, body: '' });
  if (event.httpMethod !== 'POST')    return cors(json(405, { error: 'method_not_allowed' }));

  const serviceKey   = process.env.SUPABASE_SERVICE_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!serviceKey)   return cors(json(500, { error: 'server_misconfigured', detail: 'SUPABASE_SERVICE_KEY' }));
  if (!anthropicKey) return cors(json(500, { error: 'server_misconfigured', detail: 'ANTHROPIC_API_KEY' }));

  // JWT auth
  const bearer = (event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!bearer) return cors(json(401, { error: 'missing_token' }));
  const ur = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${bearer}` },
  });
  if (!ur.ok) return cors(json(401, { error: 'invalid_token' }));
  const userJson = await ur.json();
  const userId = userJson.id;
  if (!userId) return cors(json(401, { error: 'invalid_token' }));

  let body;
  try { body = event.body ? JSON.parse(event.body) : {}; }
  catch (e) { return cors(json(400, { error: 'invalid_json' })); }
  const picId = body.progress_pic_id;
  if (!picId) return cors(json(400, { error: 'progress_pic_id_required' }));

  try {
    // Fetch the row — user_id match guarantees we only ever look at
    // photos belonging to the requesting user.
    const row = await fetchProgressPic(picId, userId, serviceKey);
    if (!row) return cors(json(404, { error: 'progress_pic_not_found' }));

    const photoPaths = [
      { key: 'front', path: row.front_storage_path },
      { key: 'side',  path: row.side_storage_path  },
      { key: 'back',  path: row.back_storage_path  },
    ].filter(x => x.path);
    if (!photoPaths.length) return cors(json(400, { error: 'no_photos_to_analyze' }));

    // Profile (sex + height for the Navy fallback check + AI body-fat estimate context).
    const profile = await fetchProfile(userId, serviceKey);

    // Prior entry — most recent before this one, with at least one photo.
    const prior = await fetchPriorEntryWithPhotos(userId, row, serviceKey);

    // Download all blobs (this + prior) and encode to base64.
    const todayImages = await downloadImages(photoPaths, serviceKey);
    const priorImages = prior
      ? await downloadImages([
          { key: 'front', path: prior.front_storage_path },
          { key: 'side',  path: prior.side_storage_path  },
          { key: 'back',  path: prior.back_storage_path  },
        ].filter(x => x.path), serviceKey)
      : [];

    // Call Claude vision.
    const result = await callClaude({
      todayImages,
      priorImages,
      row,
      prior,
      profile,
    }, anthropicKey);

    // Decide whether to overwrite body_fat_pct: only when the Navy
    // formula didn't already fire (avoids stomping a deterministic
    // number with an AI estimate).
    const patch = { ai_analysis: result.analysis, updated_at: new Date().toISOString() };
    if (row.body_fat_pct == null && Number.isFinite(result.body_fat_estimate)) {
      patch.body_fat_pct         = result.body_fat_estimate;
      patch.body_fat_method      = 'ai_estimate';
      patch.body_fat_confidence  = result.confidence || 'low';
    }
    if (prior?.id) patch.ai_compared_to = prior.id;

    const updated = await updateProgressPic(picId, userId, patch, serviceKey);

    return cors(json(200, {
      status:               'ok',
      ai_analysis:          updated.ai_analysis,
      body_fat_pct:         updated.body_fat_pct,
      body_fat_method:      updated.body_fat_method,
      body_fat_confidence:  updated.body_fat_confidence,
      ai_compared_to:       updated.ai_compared_to,
      model:                result.model,
      prompt_tokens:        result.prompt_tokens,
      completion_tokens:    result.completion_tokens,
    }));
  } catch (err) {
    console.error('[progress-pic-analysis] handler error:', err.message);
    return cors(json(500, { error: 'internal_error', detail: err.message }));
  }
};

// ── Data layer ──────────────────────────────────────────────────────────
async function fetchProgressPic(id, userId, serviceKey) {
  const url = `${SUPABASE_URL}/rest/v1/progress_pics?id=eq.${encodeURIComponent(id)}&user_id=eq.${userId}&select=*`;
  const r = await fetch(url, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
  if (!r.ok) throw new Error(`progress_pic_fetch_${r.status}`);
  const rows = await r.json();
  return rows[0] || null;
}

async function fetchPriorEntryWithPhotos(userId, current, serviceKey) {
  const url = `${SUPABASE_URL}/rest/v1/progress_pics?user_id=eq.${userId}&captured_date=lt.${current.captured_date}&or=(front_storage_path.not.is.null,side_storage_path.not.is.null,back_storage_path.not.is.null)&select=id,captured_date,front_storage_path,side_storage_path,back_storage_path,weight_lbs,body_fat_pct&order=captured_date.desc&limit=1`;
  const r = await fetch(url, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
  if (!r.ok) throw new Error(`prior_pic_fetch_${r.status}`);
  const rows = await r.json();
  return rows[0] || null;
}

// Body-comp profile lives on user_preferences after the table split.
// Keyed on user_id rather than email — fewer joins, same data.
async function fetchProfile(userId, serviceKey) {
  if (!userId) return null;
  const url = `${SUPABASE_URL}/rest/v1/user_preferences?user_id=eq.${userId}&select=sex,dob,height_in,activity_level`;
  const r = await fetch(url, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
  if (!r.ok) return null;
  const rows = await r.json();
  return rows[0] || null;
}

async function downloadImages(items, serviceKey) {
  const out = [];
  for (const item of items) {
    const url = `${SUPABASE_URL}/storage/v1/object/progress-pics/${item.path}`;
    const r = await fetch(url, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
    if (!r.ok) {
      console.warn(`[progress-pic-analysis] download failed ${item.path}: ${r.status}`);
      continue;
    }
    const buf = Buffer.from(await r.arrayBuffer());
    const mediaType = r.headers.get('content-type') || 'image/jpeg';
    out.push({
      key:        item.key,
      media_type: mediaType.split(';')[0].trim(),
      data:       buf.toString('base64'),
    });
  }
  return out;
}

async function updateProgressPic(id, userId, patch, serviceKey) {
  const url = `${SUPABASE_URL}/rest/v1/progress_pics?id=eq.${encodeURIComponent(id)}&user_id=eq.${userId}`;
  const r = await fetch(url, {
    method: 'PATCH',
    headers: {
      apikey:          serviceKey,
      Authorization:   `Bearer ${serviceKey}`,
      'Content-Type':  'application/json',
      Prefer:          'return=representation',
    },
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`progress_pic_update_${r.status}: ${(await r.text()).slice(0, 200)}`);
  const rows = await r.json();
  return rows[0] || null;
}

// ── Claude call ────────────────────────────────────────────────────────
async function callClaude({ todayImages, priorImages, row, prior, profile }, anthropicKey) {
  const model     = process.env.PROGRESS_PIC_MODEL || DEFAULT_MODEL;
  const maxTokens = parseInt(process.env.PROGRESS_PIC_MAX_TOKENS || '', 10) || DEFAULT_MAX_TOKENS;

  const systemPrompt = [
    'You are a body-composition reader looking at progress photos. Your job is structured observation, not diagnosis.',
    '',
    'OUTPUT FORMAT: always call record_progress_analysis with the structured fields.',
    '',
    'STYLE:',
    '- Plain English, second person ("your"). Direct, no filler.',
    '- No medical claims, no eating-disorder framing, no judgmental language.',
    '- Reference visible structure (shoulders, posture, taper, lean tissue distribution).',
    '- DO compare to the prior photos when present — call out what changed.',
    '- DO NOT speculate about diet, supplements, or training prescriptions.',
    '',
    'BODY-FAT ESTIMATE:',
    '- Provide a numeric estimate ONLY when the photos let you see enough of the torso to assess.',
    '- Pair it with a confidence ("high" / "medium" / "low"). Lighting + posing + cropping all affect this.',
    '- A Navy-formula deterministic number may already exist in metadata; if so, your estimate is supplementary.',
  ].join('\n');

  const tool = {
    name: 'record_progress_analysis',
    description: 'Record the structured body-composition reading from the uploaded photos.',
    input_schema: {
      type: 'object',
      properties: {
        overview:    { type: 'string', description: '2-3 sentence prescriptive paragraph. NOT a description ("you have shoulders"), a coaching read ("shoulders are leading, waist isn\'t — hold the bulk 6 more weeks"). ≤320 chars.' },
        needs_work:  { type: 'array', items: { type: 'string' }, maxItems: 4, description: 'Muscle groups that look underdeveloped relative to the rest. Single muscle-group names — "Hamstrings", "Mid-back", "Posterior delts".' },
        balanced:    { type: 'array', items: { type: 'string' }, maxItems: 4, description: 'Muscle groups that look proportional and well-developed. Same naming as needs_work.' },
        focus_areas: {
          type: 'array',
          maxItems: 3,
          description: 'EXACTLY 1-3 programmed training focus areas for the next 4-8 weeks. Each one MUST be a structured object — never a plain string. Order matters: most important first.',
          items: {
            type: 'object',
            properties: {
              title:             { type: 'string', description: 'Short focus area title, muscle-group level. e.g. "Posterior chain — hamstrings + glutes".' },
              rationale:         { type: 'string', description: '1-2 sentence WHY this matters now. e.g. "Hamstrings/glutes are visibly behind from the side pose. Injury risk + V-taper killer."' },
              exercises:         { type: 'array', items: { type: 'string' }, maxItems: 5, description: '2-5 named exercise prescriptions. e.g. ["Romanian deadlift","Hip thrust","Glute-ham raise"].' },
              programming_hint:  { type: 'string', description: 'Frequency + volume. e.g. "2× / week · 12-16 sets total".' },
            },
            required: ['title'],
          },
        },
        posture:     { type: 'string', description: 'One-phrase observation about posture / alignment. e.g. "slight forward head", "neutral spine".' },
        body_type:   { type: 'string', description: 'One word: ectomorph / mesomorph / endomorph / mixed.' },
        stage:       { type: 'string', description: 'One phrase: "early", "developing", "intermediate", "advanced", or "elite".' },
        v_taper:     { type: 'string', description: 'One word: "minimal" / "moderate" / "strong".' },
        upper_lower: { type: 'string', description: 'One phrase comparing upper vs lower development. e.g. "upper ahead of lower", "balanced".' },
        symmetry:    { type: 'string', description: 'One phrase about left/right symmetry. e.g. "symmetric", "right shoulder slightly higher".' },
        skin:        { type: 'string', description: 'One phrase about visible leanness — tightness of skin around midsection / definition. NOT a value judgement.' },
        body_fat_estimate: { type: 'number', description: 'Estimated body fat percentage (0-50). Skip if not enough is visible.' },
        confidence:  { type: 'string', enum: ['high','medium','low'], description: 'Confidence in the body_fat_estimate.' },
        changes:     { type: 'array', items: { type: 'string' }, maxItems: 4, description: 'When prior photos are provided: 1-4 short observations about what changed. Omit when no prior photos.' },
        limitations: { type: 'array', items: { type: 'string' }, maxItems: 3, description: 'Photo conditions that softened the read — e.g. "lighting differs from prior shot", "loose clothing covers waist". 1 short phrase per limitation.' },
      },
      required: ['overview', 'focus_areas'],
    },
  };

  // Build the user-message content blocks. Two groups: today's photos
  // and (optionally) the prior comparison set. Each image is base64-
  // encoded inline.
  const content = [];
  if (priorImages.length) {
    content.push({ type: 'text', text: `Prior entry — captured ${prior?.captured_date || 'unknown date'}${prior?.weight_lbs ? ` at ${prior.weight_lbs} lbs` : ''}:` });
    for (const img of priorImages) {
      content.push({ type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } });
    }
  }
  content.push({ type: 'text', text: `Today's entry — captured ${row.captured_date}${row.weight_lbs ? ` at ${row.weight_lbs} lbs` : ''}${row.body_fat_pct != null ? ` (Navy formula body fat: ${row.body_fat_pct}%)` : ''}:` });
  for (const img of todayImages) {
    content.push({ type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } });
  }
  const meta = {
    sex: profile?.sex || 'unknown',
    age: profile?.dob ? Math.floor((Date.now() - new Date(profile.dob)) / (365.25 * 86400_000)) : 'unknown',
    height_in: profile?.height_in || 'unknown',
    activity_level: profile?.activity_level || 'unknown',
  };
  content.push({ type: 'text', text: `Subject metadata: ${JSON.stringify(meta)}` });

  const body = {
    model:      model,
    max_tokens: maxTokens,
    system:     systemPrompt,
    messages:   [{ role: 'user', content }],
    tools:      [tool],
    tool_choice: { type: 'tool', name: 'record_progress_analysis' },
  };

  const r = await fetch(ANTHROPIC_URL, {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         anthropicKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`anthropic_http_${r.status}: ${j?.error?.message || JSON.stringify(j).slice(0, 200)}`);
  const block = (j.content || []).find(b => b.type === 'tool_use' && b.name === 'record_progress_analysis');
  if (!block) throw new Error(`no_tool_use_in_response: stop_reason=${j.stop_reason}`);
  const raw = block.input || {};

  // Normalize and clip output sizes.
  const clipStr = (s, n) => (s == null ? null : String(s).slice(0, n));
  const clipArr = (a, n, item) => Array.isArray(a) ? a.slice(0, n).map(x => clipStr(x, item)) : [];

  // Normalize focus_areas — accept the new rich object shape AND the
  // legacy string[] shape (Claude occasionally regresses; keeps client
  // back-compat). Strings get wrapped as { title } so the client's render
  // path is uniform.
  const focusAreasRaw = Array.isArray(raw.focus_areas) ? raw.focus_areas.slice(0, 3) : [];
  const focus_areas = focusAreasRaw.map(f => {
    if (typeof f === 'string') return { title: clipStr(f, 80) };
    if (f && typeof f === 'object') {
      return {
        title:            clipStr(f.title || f.name, 100),
        rationale:        clipStr(f.rationale || f.why, 240),
        exercises:        clipArr(f.exercises,    5, 60),
        programming_hint: clipStr(f.programming_hint || f.hint, 60),
      };
    }
    return null;
  }).filter(f => f && f.title);

  const analysis = {
    overview:     clipStr(raw.overview,     320),
    needs_work:   clipArr(raw.needs_work,   4, 60),
    balanced:     clipArr(raw.balanced,     4, 60),
    focus_areas:  focus_areas,
    limitations:  clipArr(raw.limitations,  3, 120),
    posture:      clipStr(raw.posture,      80),
    body_type:    clipStr(raw.body_type,    40),
    stage:        clipStr(raw.stage,        40),
    v_taper:      clipStr(raw.v_taper,      40),
    upper_lower:  clipStr(raw.upper_lower,  80),
    symmetry:     clipStr(raw.symmetry,     80),
    skin:         clipStr(raw.skin,         80),
    confidence:   ['high','medium','low'].includes(raw.confidence) ? raw.confidence : 'low',
    changes:      clipArr(raw.changes,      4, 120),
    generated_at: new Date().toISOString(),
  };

  return {
    analysis,
    body_fat_estimate: Number.isFinite(raw.body_fat_estimate) ? Number(raw.body_fat_estimate) : null,
    confidence:        analysis.confidence,
    model:             j.model || model,
    prompt_tokens:     j.usage?.input_tokens || null,
    completion_tokens: j.usage?.output_tokens || null,
  };
}

// ── HTTP helpers ───────────────────────────────────────────────────────
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

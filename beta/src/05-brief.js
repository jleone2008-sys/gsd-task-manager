/* ══════════════════════════════════════════════════════════════
   DAILY BRIEF — top card on Home (beta-only). Renders the
   per-user narrative + highlights + 0-2 action cards produced by
   netlify/functions/beta-daily-brief.js.

   Data flow:
     - Primary: read public.daily_briefs directly via the
       daily_briefs_select_own RLS policy (same pattern as the
       Home rings reading oura_daily).
     - Fallback: if no row exists for today's user-local date, POST
       to /.netlify/functions/beta-daily-brief with the user's JWT
       to trigger on-demand generation.
     - Refresh: explicit POST with {force: true} when the user
       taps "Refresh" on a preliminary brief.

   States:
     loading      — first paint, fetching
     empty        — no row + no key/no internet; offer "Generate brief"
     ok           — narrative + highlights + actions
     preliminary  — narrative + highlights + actions + refresh affordance
     fallback     — deterministic narrative (Claude unavailable)
     low_conf     — narrative + highlights; actions hidden by design
═══════════════════════════════════════════════════════════════ */

let _briefState = { status: 'loading', brief: null, error: null };
let _briefInflight = null;
let _briefWired = false;

// "Yesterday" in the user's local timezone, as YYYY-MM-DD. We use the
// browser's Intl resolved timezone — same value the frontend will write
// back to user_profiles.timezone on next login.
function briefYesterdayLocal() {
  const tz = (Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC';
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const [y, m, d] = today.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}

function briefEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* ── Styles (injected once) ───────────────────────────────── */

function briefInjectStyles() {
  if (document.getElementById('homeBriefStyles')) return;
  const style = document.createElement('style');
  style.id = 'homeBriefStyles';
  style.textContent = `
    #homeBrief.home-card { padding: 18px 16px; }
    .brief-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
    .brief-title-row { display: flex; align-items: center; gap: 10px; }
    .brief-title { font-size: var(--t-lg); font-weight: 700; color: var(--ink); letter-spacing: -0.01em; }
    .brief-conf {
      display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 999px;
      font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em;
      background: var(--surface-2); color: var(--ink-3);
    }
    .brief-conf.is-low { background: var(--surface-2); color: var(--ink-4); }
    .brief-conf.is-preliminary { background: var(--guava-50); color: var(--guava-700); }
    .brief-narrative { font-size: var(--t-sm); line-height: 1.55; color: var(--ink-2); white-space: pre-wrap; }
    .brief-narrative + .brief-highlights { margin-top: 14px; }
    .brief-highlights { display: flex; flex-wrap: wrap; gap: 6px; }
    .brief-chip {
      display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px;
      border: 1px solid var(--edge); border-radius: 999px;
      background: var(--surface); font-size: var(--t-xs); color: var(--ink-2); white-space: nowrap;
    }
    .brief-chip-label { color: var(--ink-3); }
    .brief-chip-arrow { font-variant-numeric: tabular-nums; font-weight: 700; }
    .brief-chip-arrow.is-up { color: #5e8c4f; }
    .brief-chip-arrow.is-down { color: var(--guava-700); }
    .brief-actions { margin-top: 16px; display: flex; flex-direction: column; gap: 10px; }
    .brief-action {
      display: flex; align-items: flex-start; gap: 10px;
      padding: 12px 14px; background: var(--surface-2); border: 1px solid var(--edge);
      border-radius: var(--r-md);
    }
    .brief-action-body { flex: 1; min-width: 0; }
    .brief-action-title { font-size: var(--t-sm); font-weight: 600; color: var(--ink); line-height: 1.35; }
    .brief-action-why { margin-top: 4px; font-size: var(--t-xs); color: var(--ink-3); line-height: 1.5; }
    .brief-action-meta { margin-top: 4px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--ink-4); }
    .brief-empty {
      display: flex; flex-direction: column; align-items: flex-start; gap: 10px;
      padding: 4px 0 2px;
    }
    .brief-empty-msg { font-size: var(--t-sm); color: var(--ink-3); line-height: 1.5; }
    .brief-skeleton { color: var(--ink-4); font-size: var(--t-sm); }
    .brief-error { color: var(--guava-700); font-size: var(--t-sm); }
    .brief-stale-note { margin-top: 12px; font-size: var(--t-xs); color: var(--ink-4); display: flex; align-items: center; gap: 8px; }
  `;
  document.head.appendChild(style);
}

/* ── Render ───────────────────────────────────────────────── */

function homeBriefMount() {
  briefInjectStyles();
  briefWireOnce();
  // Initial loading skeleton — replaced by homeBriefLoad() once data resolves.
  const el = document.getElementById('homeBrief');
  if (el) el.innerHTML = briefSkeletonHTML();
}

function briefSkeletonHTML() {
  return `<div class="brief-head"><div class="brief-title-row"><div class="brief-title">Daily Brief</div></div></div>
          <div class="brief-skeleton">Loading your brief…</div>`;
}

function briefEmptyHTML() {
  return `<div class="brief-head"><div class="brief-title-row"><div class="brief-title">Daily Brief</div></div></div>
          <div class="brief-empty">
            <div class="brief-empty-msg">No brief yet for yesterday. Generate one to see your daily recap and any suggested actions.</div>
            <button class="home-pill-btn" data-brief-action="generate">Generate brief</button>
          </div>`;
}

function briefErrorHTML(msg) {
  return `<div class="brief-head"><div class="brief-title-row"><div class="brief-title">Daily Brief</div></div></div>
          <div class="brief-error">${briefEsc(msg || 'Failed to load brief.')}</div>
          <div style="margin-top:10px"><button class="home-pill-btn" data-brief-action="retry">Retry</button></div>`;
}

function briefBadgeHTML(brief) {
  if (brief.status === 'preliminary') return `<span class="brief-conf is-preliminary">Preliminary</span>`;
  if (brief.status === 'fallback')    return `<span class="brief-conf is-low">Fallback</span>`;
  if (brief.confidence === 'low')     return `<span class="brief-conf is-low">Building baseline</span>`;
  return '';
}

function briefArrowHTML(h) {
  if (h.direction === 'up')   return `<span class="brief-chip-arrow is-up">↑</span>`;
  if (h.direction === 'down') return `<span class="brief-chip-arrow is-down">↓</span>`;
  if (h.direction === 'flat') return `<span class="brief-chip-arrow">±</span>`;
  return '';
}

function briefHighlightsHTML(highlights) {
  if (!Array.isArray(highlights) || highlights.length === 0) return '';
  const chips = highlights.map(h => {
    const value = (h.value_today != null) ? String(h.value_today) : '—';
    return `<span class="brief-chip">
      <span class="brief-chip-label">${briefEsc(h.label || '')}</span>
      <strong>${briefEsc(value)}</strong>
      ${briefArrowHTML(h)}
    </span>`;
  }).join('');
  return `<div class="brief-highlights">${chips}</div>`;
}

function briefActionsHTML(brief) {
  // Hide actions on low confidence (cold-start mode) or when the array is empty.
  if (brief.confidence === 'low') return '';
  if (!Array.isArray(brief.actions) || brief.actions.length === 0) return '';
  const cards = brief.actions.map(a => {
    const meta = [a.area, a.est_minutes ? `${a.est_minutes} min` : null].filter(Boolean).join(' · ');
    return `<div class="brief-action">
      <div class="brief-action-body">
        <div class="brief-action-title">${briefEsc(a.title || '')}</div>
        ${a.why ? `<div class="brief-action-why">${briefEsc(a.why)}</div>` : ''}
        ${meta ? `<div class="brief-action-meta">${briefEsc(meta)}</div>` : ''}
      </div>
    </div>`;
  }).join('');
  return `<div class="brief-actions">${cards}</div>`;
}

function briefStaleNoteHTML(brief) {
  if (brief.status !== 'preliminary') return '';
  return `<div class="brief-stale-note">
    <span>Wearable data was still syncing when this was generated.</span>
    <button class="home-pill-btn" data-brief-action="refresh">Refresh</button>
  </div>`;
}

function briefHTML(brief) {
  const badge = briefBadgeHTML(brief);
  return `<div class="brief-head">
    <div class="brief-title-row">
      <div class="brief-title">Daily Brief</div>
      ${badge}
    </div>
  </div>
  ${brief.narrative ? `<div class="brief-narrative">${briefEsc(brief.narrative)}</div>` : ''}
  ${briefHighlightsHTML(brief.highlights)}
  ${briefActionsHTML(brief)}
  ${briefStaleNoteHTML(brief)}`;
}

function briefRender() {
  const el = document.getElementById('homeBrief');
  if (!el) return;
  if (_briefState.status === 'loading')          el.innerHTML = briefSkeletonHTML();
  else if (_briefState.status === 'empty')       el.innerHTML = briefEmptyHTML();
  else if (_briefState.status === 'error')       el.innerHTML = briefErrorHTML(_briefState.error);
  else if (_briefState.brief)                    el.innerHTML = briefHTML(_briefState.brief);
}

/* ── Data ─────────────────────────────────────────────────── */

async function homeBriefLoad() {
  if (_briefInflight) return _briefInflight;
  _briefInflight = (async () => {
    try {
      _briefState = { status: 'loading', brief: null, error: null };
      briefRender();

      const yday = briefYesterdayLocal();

      // 1) Try direct PostgREST read (RLS policy: daily_briefs_select_own)
      const { data, error } = await db.from('daily_briefs')
        .select('id,brief_date,generated_at,model,narrative,highlights,actions,confidence,status,fallback_reason')
        .eq('brief_date', yday)
        .maybeSingle();

      if (error) throw error;

      if (data) {
        _briefState = { status: 'ok', brief: data, error: null };
        briefRender();
        return;
      }

      // 2) No row exists — trigger on-demand generation
      const brief = await briefGenerate({ force: false });
      _briefState = { status: 'ok', brief, error: null };
      briefRender();
    } catch (e) {
      console.warn('[brief] load failed', e);
      _briefState = { status: 'error', brief: null, error: e?.message || 'load_failed' };
      briefRender();
    } finally {
      _briefInflight = null;
    }
  })();
  return _briefInflight;
}

async function briefGenerate({ force }) {
  // Get the user's current JWT via the existing supabase client.
  const session = (await db.auth.getSession()).data?.session;
  const token   = session?.access_token;
  if (!token) throw new Error('not_authenticated');

  const res = await fetch('/.netlify/functions/beta-daily-brief', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ force: !!force }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = j?.detail ? `${j.error}: ${j.detail}` : (j?.error || `http_${res.status}`);
    throw new Error(msg);
  }
  return j;
}

async function homeBriefRefresh(force = true) {
  try {
    _briefState = { status: 'loading', brief: _briefState.brief, error: null };
    briefRender();
    const brief = await briefGenerate({ force });
    _briefState = { status: 'ok', brief, error: null };
    briefRender();
  } catch (e) {
    console.warn('[brief] refresh failed', e);
    _briefState = { status: 'error', brief: null, error: e?.message || 'refresh_failed' };
    briefRender();
  }
}

/* ── Click delegation ─────────────────────────────────────── */

function briefWireOnce() {
  if (_briefWired) return;
  _briefWired = true;
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-brief-action]');
    if (!btn) return;
    const action = btn.dataset.briefAction;
    if (action === 'generate' || action === 'retry') {
      homeBriefLoad();
    } else if (action === 'refresh') {
      homeBriefRefresh(true);
    }
  });
}

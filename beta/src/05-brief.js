/* ══════════════════════════════════════════════════════════════
   DAILY BRIEF — top card on Home (beta-only). Phase 1.5 layout:
     Header + confidence badge
     Health rings (Sleep / Readiness / Activity)
     Single-sentence TL;DR (the prose)
     Highlight chips (extras beyond the rings: HRV, total sleep
       time, mood, tasks, habits, resting HR)
     0-2 action cards with color-coded left border
     Stale-data refresh affordance (preliminary only)

   Data flow:
     - Primary: read public.daily_briefs directly via
       daily_briefs_select_own RLS (same pattern as Home rings).
     - Fallback: POST /.netlify/functions/beta-daily-brief with the
       user's JWT when no row exists for today's user-local date.
     - Refresh: explicit POST with {force: true} when the user taps
       "Refresh" on a preliminary brief.

   Rings: brief renders `<div id="briefRingsRow">` placeholder;
   briefHydrateRings() loads via existing loadOuraScores() and
   renders via existing homeRingsRowHTML() — both globals from
   beta/src/04-home.js. Brief owns its own ring slot so it doesn't
   race the legacy hydrateHomeToday() pathway (the homeToday card
   is removed; its ring code becomes a no-op).
═══════════════════════════════════════════════════════════════ */

let _briefState = { status: 'loading', brief: null, error: null };
let _briefInflight = null;
let _briefWired = false;

// "Yesterday" in the user's local timezone, as YYYY-MM-DD.
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

// Minutes → "Xh Ym" defensive client-side formatter. Used for any chip whose
// label or value looks like a minute count (e.g. label="Total sleep" with
// value=358). Even though Claude is instructed to send compact strings, this
// keeps the UI safe if the model regresses.
function briefFormatMinutes(n) {
  const m = Math.round(Number(n));
  if (!Number.isFinite(m) || m < 0) return null;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h === 0) return `${rem}m`;
  if (rem === 0) return `${h}h`;
  return `${h}h ${rem}m`;
}

// Best-effort headline: prefer Phase 1.5 `tldr` field; fall back to the first
// sentence of `narrative` for legacy rows generated under Phase 1 schema.
function briefHeadlineText(brief) {
  if (brief.tldr) return brief.tldr;
  if (brief.narrative) {
    const first = brief.narrative.split(/(?<=[.!?])\s+/)[0] || brief.narrative;
    return first.length > 200 ? first.slice(0, 197) + '…' : first;
  }
  return null;
}

/* ── Styles (injected once) ───────────────────────────────── */

function briefInjectStyles() {
  if (document.getElementById('homeBriefStyles')) return;
  const style = document.createElement('style');
  style.id = 'homeBriefStyles';
  style.textContent = `
    #homeBrief.home-card { padding: 18px 16px; }
    .brief-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 12px; }
    .brief-title-row { display: flex; align-items: center; gap: 10px; }
    .brief-title { font-size: var(--t-lg); font-weight: 700; color: var(--ink); letter-spacing: -0.01em; }
    .brief-conf {
      display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 999px;
      font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em;
      background: var(--surface-2); color: var(--ink-3);
    }
    .brief-conf.is-low { background: var(--surface-2); color: var(--ink-4); }
    .brief-conf.is-preliminary { background: var(--guava-50); color: var(--guava-700); }

    /* Rings slot inside the brief card. Uses the existing .home-rings styles
       (defined in beta/app.html#homeStyles) — the homeRingsRowHTML() helper
       returns markup that targets those classes. */
    #briefRingsRow { margin-bottom: 14px; }

    /* TL;DR — the only prose. Prominent but not heavy. */
    .brief-tldr {
      font-size: var(--t-md, 15px); font-weight: 600; line-height: 1.4;
      color: var(--ink); margin: 0 0 14px 0; letter-spacing: -0.005em;
    }

    .brief-highlights { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 4px; }
    .brief-chip {
      display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px;
      border: 1px solid var(--edge); border-radius: 999px;
      background: var(--surface); font-size: var(--t-xs); color: var(--ink-2); white-space: nowrap;
    }
    .brief-chip-label { color: var(--ink-3); }
    .brief-chip-arrow { font-variant-numeric: tabular-nums; font-weight: 700; }
    .brief-chip-arrow.is-up { color: #5e8c4f; }
    .brief-chip-arrow.is-down { color: var(--guava-700); }

    .brief-actions { margin-top: 14px; display: flex; flex-direction: column; gap: 10px; }
    .brief-action {
      display: flex; align-items: flex-start; gap: 10px;
      padding: 12px 14px; background: var(--surface-2);
      border: 1px solid var(--edge); border-left: 4px solid var(--edge-strong);
      border-radius: var(--r-md);
    }
    /* Action area color map — left border keyed off data-area attribute. */
    .brief-action[data-area="sleep"]      { border-left-color: var(--sky-fg); }
    .brief-action[data-area="recovery"]   { border-left-color: #5e8c4f; }
    .brief-action[data-area="activity"]   { border-left-color: #bf9c47; }
    .brief-action[data-area="work"]       { border-left-color: var(--ink-3); }
    .brief-action[data-area="mood"]       { border-left-color: var(--guava-700); }
    .brief-action[data-area="habits"]     { border-left-color: #7a5a90; }
    .brief-action[data-area="nutrition"]  { border-left-color: #c98a4b; }
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
  const el = document.getElementById('homeBrief');
  if (el) el.innerHTML = briefSkeletonHTML();
}

function briefSkeletonHTML() {
  return `<div class="brief-head"><div class="brief-title-row"><div class="brief-title">Daily Brief</div></div></div>
          <div id="briefRingsRow"><div class="home-skeleton">Loading…</div></div>
          <div class="brief-skeleton">Loading your brief…</div>`;
}

function briefEmptyHTML() {
  return `<div class="brief-head"><div class="brief-title-row"><div class="brief-title">Daily Brief</div></div></div>
          <div id="briefRingsRow"><div class="home-skeleton">Loading…</div></div>
          <div class="brief-empty">
            <div class="brief-empty-msg">No brief yet for yesterday. Generate one to see your daily recap and any suggested actions.</div>
            <button class="home-pill-btn" data-brief-action="generate">Generate brief</button>
          </div>`;
}

function briefErrorHTML(msg) {
  return `<div class="brief-head"><div class="brief-title-row"><div class="brief-title">Daily Brief</div></div></div>
          <div id="briefRingsRow"><div class="home-skeleton">Loading…</div></div>
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

// Defensive client-side formatting: if a highlight's label looks like a
// time-in-minutes field (Total sleep, Sleep, etc.) and the value is a bare
// number, convert to "Xh Ym". Claude is instructed to send compact strings
// already; this is belt-and-suspenders.
function briefChipValue(h) {
  if (h.value_today == null) return '—';
  const label = String(h.label || '').toLowerCase();
  const isTimeLabel = /(sleep|nap|in bed|asleep|min)/i.test(label) && !/score/i.test(label);
  if (isTimeLabel) {
    const n = Number(h.value_today);
    if (Number.isFinite(n) && n >= 30 && n <= 2000) {
      const formatted = briefFormatMinutes(n);
      if (formatted) return formatted;
    }
    // String like "358 min" — convert if we can extract the number
    const m = /^(\d+)\s*min(?:utes?)?$/i.exec(String(h.value_today).trim());
    if (m) {
      const formatted = briefFormatMinutes(parseInt(m[1], 10));
      if (formatted) return formatted;
    }
  }
  return String(h.value_today);
}

function briefHighlightsHTML(highlights) {
  if (!Array.isArray(highlights) || highlights.length === 0) return '';
  const chips = highlights.map(h => `<span class="brief-chip">
      <span class="brief-chip-label">${briefEsc(h.label || '')}</span>
      <strong>${briefEsc(briefChipValue(h))}</strong>
      ${briefArrowHTML(h)}
    </span>`).join('');
  return `<div class="brief-highlights">${chips}</div>`;
}

function briefActionsHTML(brief) {
  // Hide actions on low confidence (cold-start) or empty array.
  if (brief.confidence === 'low') return '';
  if (!Array.isArray(brief.actions) || brief.actions.length === 0) return '';
  const cards = brief.actions.map(a => {
    const area = (a.area || 'other').toLowerCase();
    const meta = [area, a.est_minutes ? `${a.est_minutes} min` : null].filter(Boolean).join(' · ');
    return `<div class="brief-action" data-area="${briefEsc(area)}">
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
  const badge    = briefBadgeHTML(brief);
  const headline = briefHeadlineText(brief);
  return `<div class="brief-head">
    <div class="brief-title-row">
      <div class="brief-title">Daily Brief</div>
      ${badge}
    </div>
  </div>
  <div id="briefRingsRow"><div class="home-skeleton">Loading…</div></div>
  ${headline ? `<div class="brief-tldr">${briefEsc(headline)}</div>` : ''}
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
  // Every render replaces the rings element, so re-hydrate it.
  briefHydrateRings();
}

/* ── Rings hydration (owns its own slot to avoid race with hydrateHomeToday) ── */

async function briefHydrateRings() {
  const el = document.getElementById('briefRingsRow');
  if (!el) return;
  if (typeof homeHealthSource !== 'function' || typeof loadOuraScores !== 'function' || typeof homeRingsRowHTML !== 'function') {
    // 04-home.js helpers not loaded yet; nothing we can do.
    return;
  }
  const source = homeHealthSource();
  if (source === 'whoop') {
    const connected = (typeof homeWhoopConnected === 'function') && homeWhoopConnected();
    const msg = connected ? 'Whoop rings on Home are coming soon.' : 'Connect Whoop to track your health on Home.';
    const cta = connected ? '' : '<button class="home-cta" data-home-cta="settings">Connect Whoop →</button>';
    el.innerHTML = `<div class="home-empty">${msg}</div>${cta}`;
    return;
  }
  if (typeof homeOuraConnected === 'function' && !homeOuraConnected()) {
    el.innerHTML = `<div class="home-empty">Connect your Oura Ring to see sleep, readiness, and activity.</div>
      <button class="home-cta" data-home-cta="settings">Connect Oura →</button>`;
    return;
  }
  try {
    const oura = await loadOuraScores();
    if (document.getElementById('briefRingsRow')) {
      document.getElementById('briefRingsRow').innerHTML = homeRingsRowHTML(oura);
    }
  } catch (e) {
    console.warn('[brief] rings hydration failed', e);
  }
}

/* ── Data ─────────────────────────────────────────────────── */

async function homeBriefLoad() {
  if (_briefInflight) return _briefInflight;
  _briefInflight = (async () => {
    try {
      _briefState = { status: 'loading', brief: null, error: null };
      briefRender();

      const yday = briefYesterdayLocal();

      // 1) Try direct PostgREST read (RLS policy: daily_briefs_select_own).
      //    Include tldr (Phase 1.5) AND narrative (legacy fallback for older rows).
      const { data, error } = await db.from('daily_briefs')
        .select('id,brief_date,generated_at,model,tldr,narrative,highlights,actions,confidence,status,fallback_reason')
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

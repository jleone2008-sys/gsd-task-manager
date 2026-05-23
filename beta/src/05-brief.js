/* ══════════════════════════════════════════════════════════════
   DAILY BRIEF — top card on Home (beta-only). Phase 1.6 layout:
     Header: "Your [Weekday] Brief" + confidence badge
     Health rings (Sleep / Readiness / Activity)
     1-2 conversational paragraphs of prose
     Stale-data refresh affordance (preliminary only)

   No chips. No standalone action cards. Actionable framing weaves
   into the prose.

   Data flow:
     - Primary: read public.daily_briefs directly via
       daily_briefs_select_own RLS (same pattern as Home rings).
     - Fallback: POST /.netlify/functions/beta-daily-brief with the
       user's JWT when no row exists for today's user-local date.
     - Refresh: explicit POST with {force: true} when the user taps
       "Refresh" on a preliminary brief.

   Storage: paragraphs are joined with `\n\n` and written to
   daily_briefs.narrative (the existing column from Phase 1).
   The Phase-1.5 tldr/highlights/actions columns stay nullable
   but unused in Phase 1.6.
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

// Today's weekday name (e.g. "Friday") in the user's local timezone.
function briefWeekdayLocal() {
  const tz = (Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC';
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(new Date());
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

    /* Rings slot inside the brief card — relies on .home-rings styles
       defined in beta/app.html#homeStyles. */
    #briefRingsRow { margin-bottom: 14px; }

    /* Paragraph prose — the body of the brief. */
    .brief-para {
      font-size: var(--t-sm); line-height: 1.55; color: var(--ink);
      margin: 0 0 10px 0;
    }
    .brief-para:last-child { margin-bottom: 0; }
    .brief-para + .brief-para { margin-top: 10px; }

    .brief-empty {
      display: flex; flex-direction: column; align-items: flex-start; gap: 10px;
      padding: 4px 0 2px;
    }
    .brief-empty-msg { font-size: var(--t-sm); color: var(--ink-3); line-height: 1.5; }
    .brief-skeleton { color: var(--ink-4); font-size: var(--t-sm); }
    .brief-error { color: var(--guava-700); font-size: var(--t-sm); }
    .brief-stale-note {
      margin-top: 12px; font-size: var(--t-xs); color: var(--ink-4);
      display: flex; align-items: center; gap: 8px;
    }
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

function briefHeadHTML(badge) {
  const greeting = `Your ${briefWeekdayLocal()} Brief`;
  return `<div class="brief-head">
    <div class="brief-title-row">
      <div class="brief-title">${briefEsc(greeting)}</div>
      ${badge || ''}
    </div>
  </div>`;
}

function briefSkeletonHTML() {
  return `${briefHeadHTML('')}
          <div id="briefRingsRow"><div class="home-skeleton">Loading…</div></div>
          <div class="brief-skeleton">Loading your brief…</div>`;
}

function briefEmptyHTML() {
  return `${briefHeadHTML('')}
          <div id="briefRingsRow"><div class="home-skeleton">Loading…</div></div>
          <div class="brief-empty">
            <div class="brief-empty-msg">No brief yet for today. Generate one to see your morning recap.</div>
            <button class="home-pill-btn" data-brief-action="generate">Generate brief</button>
          </div>`;
}

function briefErrorHTML(msg) {
  return `${briefHeadHTML('')}
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

function briefParagraphsHTML(narrative) {
  if (!narrative) return '';
  const paragraphs = String(narrative).split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  if (!paragraphs.length) return '';
  return paragraphs.map(p => `<p class="brief-para">${briefEsc(p)}</p>`).join('');
}

function briefStaleNoteHTML(brief) {
  if (brief.status !== 'preliminary') return '';
  return `<div class="brief-stale-note">
    <span>Wearable data was still syncing when this was generated.</span>
    <button class="home-pill-btn" data-brief-action="refresh">Refresh</button>
  </div>`;
}

function briefHTML(brief) {
  return `${briefHeadHTML(briefBadgeHTML(brief))}
  <div id="briefRingsRow"><div class="home-skeleton">Loading…</div></div>
  ${briefParagraphsHTML(brief.narrative)}
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

/* ── Rings hydration (brief owns its own slot to avoid race with hydrateHomeToday) ── */

async function briefHydrateRings() {
  const el = document.getElementById('briefRingsRow');
  if (!el) return;
  if (typeof homeHealthSource !== 'function' || typeof loadOuraScores !== 'function' || typeof homeRingsRowHTML !== 'function') {
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
      //    Phase 1.6 reuses `narrative` for the joined paragraphs; tldr is
      //    kept in the SELECT only so old rows can fall back to it.
      const { data, error } = await db.from('daily_briefs')
        .select('id,brief_date,generated_at,model,tldr,narrative,confidence,status,fallback_reason')
        .eq('brief_date', yday)
        .maybeSingle();

      if (error) throw error;

      if (data) {
        // Legacy back-compat: rows generated under Phase 1.5 schema have only
        // tldr, not narrative. If narrative is missing but tldr exists, use
        // tldr as the (single-paragraph) narrative so the brief still renders.
        if (!data.narrative && data.tldr) {
          data.narrative = data.tldr;
        }
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

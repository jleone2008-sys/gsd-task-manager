/* ══════════════════════════════════════════════════════════════
   DAILY BRIEF — top card on Home (beta-only). Phase 1.7 layout:

     Header strip: "[WEEKDAY] BRIEF" (small all-caps) + weather chip
     Headline (verb-first) + subhead (the play)
     ─────────────────────────────────────
     Hero ring (one metric, 120px, score+label+delta inside)
       + stats list (3-4 rows for the OTHER metrics)
     Evidence pills (0-3 short tags)
     ─────────────────────────────────────
     TODAY'S PLAY  (morning) / TOMORROW'S SETUP (evening)
     Icon · scope · content rows (3-5)

   No prose paragraphs. No chips. No standalone action cards.
   The brief is a structured object; the UI renders block by block.

   Two modes per local day:
     morning (04-16 user-local) — forward-looking plan + weather
     evening (16-04 user-local) — recap + tomorrow setup, no weather

   Data flow:
     - Read public.daily_briefs via RLS, filtered by current mode.
     - If no row exists for (today, current mode), POST to the
       Netlify function with {mode} to generate on-demand.
     - Settings → Save Location auto-triggers homeBriefRefresh(true)
       (live update without manual cache bust).

   Back-compat: if a row has only `narrative` (Phase 1.6) and no
   `structured`, render the legacy paragraph layout as a fallback.
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

// Mode for the current local hour.
function briefCurrentMode() {
  const tz = (Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC';
  const h = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(new Date()), 10);
  const hour = (h === 24) ? 0 : h;
  return (hour >= 4 && hour < 16) ? 'morning' : 'evening';
}

// Weekday name (uppercase for the header strip).
function briefWeekdayUpper() {
  const tz = (Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC';
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(new Date()).toUpperCase();
}

function briefEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* ── Inline SVG icons for play rows ───────────────────────── */

const PLAY_ICON_SVG = {
  walk:   '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="3" r="1.4" fill="currentColor" stroke="none"/><path d="M5 14l2-4 2 2 1 2M9 9l2-2 3 1M6 6l3-1"/></svg>',
  tasks:  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5.5"/><path d="M5.5 8l2 2 3-4"/></svg>',
  habits: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 14c2.5 0 4.5-1.8 4.5-4.2 0-1.8-.9-2.7-1.8-3.5C9.7 5.4 9 4.2 9 2.5 7 3.5 5 5.5 5 8c-1 .5-1.5 1.5-1.5 2.5C3.5 12.4 5.3 14 8 14z"/></svg>',
  sleep:  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M13 9.5A5.5 5.5 0 016.5 3 5.5 5.5 0 1013 9.5z"/></svg>',
  work:   '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="5" width="11" height="8" rx="1"/><path d="M6 5V3.5h4V5"/></svg>',
  meal:   '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2v5a2 2 0 002 2v5M6 2v5M11 2c-1.5 0-2 1-2 3s1 3 2 3v5"/></svg>',
  other:  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="2.5" fill="currentColor" stroke="none"/></svg>',
};

function playIconSVG(name) {
  return PLAY_ICON_SVG[name] || PLAY_ICON_SVG.other;
}

/* ── Hero ring SVG (120px, score+label+delta inside) ──────── */

const HERO_RING_COLORS = {
  sleep_score:     '#8a6a84',
  readiness_score: '#bf9c47',
  activity_score:  '#7a8a59',
};

function briefHeroRingSVG(score, label, delta, key) {
  const color = HERO_RING_COLORS[key] || '#8a6a84';
  const r = 52;
  const c = 2 * Math.PI * r;
  const pct = score == null ? 0 : Math.max(0, Math.min(100, score)) / 100;
  const off = c * (1 - pct);
  const deltaDisplay = (delta == null || delta === 0) ? ''
    : (delta > 0 ? `↑${delta}` : `↓${Math.abs(delta)}`);
  const deltaClass = delta > 0 ? 'is-up' : delta < 0 ? 'is-down' : '';
  return `<svg viewBox="0 0 120 120" class="brief-hero-svg">
    <circle cx="60" cy="60" r="${r}" fill="none" stroke="var(--surface-2)" stroke-width="8"/>
    <circle cx="60" cy="60" r="${r}" fill="none" stroke="${color}" stroke-width="8" stroke-linecap="round"
            stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" transform="rotate(-90 60 60)"/>
    <text x="60" y="56" text-anchor="middle" dominant-baseline="central" class="brief-hero-value">${score == null ? '—' : Math.round(score)}</text>
    <text x="60" y="76" text-anchor="middle" dominant-baseline="central" class="brief-hero-label">${briefEsc(label || '')}</text>
    ${deltaDisplay ? `<text x="60" y="92" text-anchor="middle" dominant-baseline="central" class="brief-hero-delta ${deltaClass}">${briefEsc(deltaDisplay)}</text>` : ''}
  </svg>`;
}

/* ── Styles (injected once) ───────────────────────────────── */

function briefInjectStyles() {
  if (document.getElementById('homeBriefStyles')) return;
  const style = document.createElement('style');
  style.id = 'homeBriefStyles';
  style.textContent = `
    #homeBrief.home-card { padding: 20px 18px; }

    .brief-head {
      display: flex; align-items: center; justify-content: space-between;
      gap: 10px; margin-bottom: 14px;
    }
    .brief-eyebrow {
      font-size: 11px; font-weight: 700; letter-spacing: .08em;
      color: var(--ink-3); text-transform: uppercase;
    }
    .brief-head-right { display: inline-flex; align-items: center; gap: 8px; }
    .brief-weather-chip {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 4px 10px; border: 1px solid var(--edge); border-radius: 999px;
      font-size: var(--t-xs); color: var(--ink-2); white-space: nowrap;
    }
    .brief-weather-temp { font-weight: 700; color: var(--ink); }
    .brief-conf {
      display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 999px;
      font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em;
      background: var(--surface-2); color: var(--ink-3);
    }
    .brief-conf.is-low         { background: var(--surface-2); color: var(--ink-4); }
    .brief-conf.is-preliminary { background: var(--guava-50); color: var(--guava-700); }
    .brief-conf.is-fallback    { background: var(--surface-2); color: var(--ink-4); }

    .brief-headline {
      font-size: 22px; font-weight: 700; color: var(--ink);
      letter-spacing: -0.02em; line-height: 1.15;
      margin: 0 0 6px 0;
    }
    .brief-subhead {
      font-size: var(--t-sm); color: var(--ink-2); line-height: 1.45;
      margin: 0 0 16px 0;
    }

    .brief-divider {
      height: 1px; background: var(--edge); margin: 16px 0;
    }

    .brief-hero-grid {
      display: grid; grid-template-columns: 132px 1fr; gap: 16px;
      align-items: center;
    }
    .brief-hero-ring { display: flex; align-items: center; justify-content: center; }
    .brief-hero-svg  { width: 120px; height: 120px; display: block; }
    .brief-hero-value { font-size: 26px; font-weight: 700; fill: var(--ink); }
    .brief-hero-label { font-size: 9px; font-weight: 700; letter-spacing: .08em; fill: var(--ink-3); }
    .brief-hero-delta { font-size: 11px; font-weight: 700; fill: var(--ink-4); font-variant-numeric: tabular-nums; }
    .brief-hero-delta.is-up   { fill: #5e8c4f; }
    .brief-hero-delta.is-down { fill: var(--guava-700); }

    .brief-stats { display: flex; flex-direction: column; }
    .brief-stat-row {
      display: grid; grid-template-columns: 1fr auto; gap: 8px;
      align-items: baseline;
      padding: 6px 0;
      font-size: var(--t-sm);
    }
    .brief-stat-row + .brief-stat-row { border-top: 1px dashed var(--edge); }
    .brief-stat-label { color: var(--ink-2); }
    .brief-stat-value {
      font-variant-numeric: tabular-nums; color: var(--ink);
      display: inline-flex; align-items: baseline; gap: 8px;
    }
    .brief-stat-num { font-weight: 700; }
    .brief-stat-delta { font-size: var(--t-xs); font-weight: 700; }
    .brief-stat-delta.is-up   { color: #5e8c4f; }
    .brief-stat-delta.is-down { color: var(--guava-700); }
    .brief-stat-note { font-size: var(--t-xs); color: var(--ink-4); font-weight: 500; }
    .brief-stats-baseline {
      font-size: 10px; color: var(--ink-4); margin-top: 6px;
      text-align: right; letter-spacing: .02em; font-style: italic;
    }

    .brief-pills {
      display: flex; flex-wrap: wrap; gap: 6px;
      margin-top: 14px;
    }
    .brief-pill {
      display: inline-flex; align-items: center;
      padding: 3px 10px; border: 1px solid var(--guava-50); border-radius: 999px;
      background: var(--guava-50); color: var(--guava-700);
      font-size: var(--t-xs); white-space: nowrap;
    }

    .brief-play-label {
      font-size: 11px; font-weight: 700; letter-spacing: .08em;
      color: var(--ink-3); text-transform: uppercase;
      margin: 0 0 8px 0;
    }
    .brief-play { display: flex; flex-direction: column; }
    .brief-play-row {
      display: grid; grid-template-columns: 22px 76px 1fr; gap: 10px;
      align-items: baseline;
      padding: 8px 0;
      font-size: var(--t-sm);
    }
    .brief-play-row + .brief-play-row { border-top: 1px solid var(--edge); }
    .brief-play-icon {
      width: 18px; height: 18px;
      color: var(--ink-3);
      align-self: center;
    }
    .brief-play-icon svg { width: 100%; height: 100%; display: block; }
    .brief-play-scope {
      font-size: var(--t-xs); color: var(--ink-3);
      font-weight: 600; white-space: nowrap;
    }
    .brief-play-content { color: var(--ink); line-height: 1.4; }

    .brief-empty {
      display: flex; flex-direction: column; align-items: flex-start; gap: 10px;
      padding: 4px 0 2px;
    }
    .brief-empty-msg { font-size: var(--t-sm); color: var(--ink-3); line-height: 1.5; }
    .brief-skeleton  { color: var(--ink-4); font-size: var(--t-sm); }
    .brief-error     { color: var(--guava-700); font-size: var(--t-sm); }
    .brief-stale-note {
      margin-top: 14px; font-size: var(--t-xs); color: var(--ink-4);
      display: flex; align-items: center; gap: 8px;
    }

    .brief-legacy-para {
      font-size: var(--t-sm); line-height: 1.55; color: var(--ink);
      margin: 0 0 10px 0;
    }
    .brief-legacy-para:last-child { margin-bottom: 0; }
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

function briefHeadHTML(weatherChipHtml, badgeHtml) {
  return `<div class="brief-head">
    <span class="brief-eyebrow">${briefEsc(briefWeekdayUpper())} BRIEF</span>
    <span class="brief-head-right">${weatherChipHtml || ''}${badgeHtml || ''}</span>
  </div>`;
}

function briefSkeletonHTML() {
  return `${briefHeadHTML('', '')}
          <div class="brief-skeleton">Loading your brief…</div>`;
}

function briefEmptyHTML() {
  return `${briefHeadHTML('', '')}
          <div class="brief-empty">
            <div class="brief-empty-msg">No brief yet for this mode. Generate one to see your coach-style snapshot.</div>
            <button class="home-pill-btn" data-brief-action="generate">Generate brief</button>
          </div>`;
}

function briefErrorHTML(msg) {
  return `${briefHeadHTML('', '')}
          <div class="brief-error">${briefEsc(msg || 'Failed to load brief.')}</div>
          <div style="margin-top:10px"><button class="home-pill-btn" data-brief-action="retry">Retry</button></div>`;
}

function briefBadgeHTML(brief) {
  if (brief.status === 'preliminary') return `<span class="brief-conf is-preliminary">Preliminary</span>`;
  if (brief.status === 'fallback')    return `<span class="brief-conf is-fallback">Fallback</span>`;
  if (brief.confidence === 'low')     return `<span class="brief-conf is-low">Building baseline</span>`;
  return '';
}

function briefWeatherChipHTML(chip) {
  if (!chip) return '';
  const [temp, place] = String(chip).split(/\s*·\s*/);
  if (place) {
    return `<span class="brief-weather-chip"><span class="brief-weather-temp">${briefEsc(temp)}</span> · ${briefEsc(place)}</span>`;
  }
  return `<span class="brief-weather-chip">${briefEsc(chip)}</span>`;
}

function briefStatsHTML(stats) {
  if (!Array.isArray(stats) || stats.length === 0) return '';
  const hasAnyDelta = stats.some(s => !!s.delta);
  return `<div class="brief-stats">${stats.map(s => {
    const value = (s.value == null) ? '—' : s.value;
    const deltaCls = String(s.delta || '').startsWith('↑') ? 'is-up'
                   : String(s.delta || '').startsWith('↓') ? 'is-down' : '';
    const deltaHtml = s.delta ? `<span class="brief-stat-delta ${deltaCls}">${briefEsc(s.delta)}</span>` : '';
    const noteHtml  = s.note  ? `<span class="brief-stat-note">${briefEsc(s.note)}</span>` : '';
    return `<div class="brief-stat-row">
      <span class="brief-stat-label">${briefEsc(s.label || '')}</span>
      <span class="brief-stat-value">
        <span class="brief-stat-num">${briefEsc(value)}</span>
        ${deltaHtml}
        ${noteHtml}
      </span>
    </div>`;
  }).join('')}${hasAnyDelta ? `<div class="brief-stats-baseline">Δ vs 7-day avg</div>` : ''}</div>`;
}

function briefPillsHTML(pills) {
  if (!Array.isArray(pills) || pills.length === 0) return '';
  return `<div class="brief-pills">${pills.map(p => `<span class="brief-pill">${briefEsc(p)}</span>`).join('')}</div>`;
}

function briefPlayHTML(rows, label) {
  if (!Array.isArray(rows) || rows.length === 0) return '';
  return `<div class="brief-play-label">${briefEsc(label)}</div>
    <div class="brief-play">${rows.map(r => `<div class="brief-play-row">
      <span class="brief-play-icon">${playIconSVG(r.icon)}</span>
      <span class="brief-play-scope">${briefEsc(r.scope || '')}</span>
      <span class="brief-play-content">${briefEsc(r.content || '')}</span>
    </div>`).join('')}</div>`;
}

function briefStaleNoteHTML(brief) {
  if (brief.status !== 'preliminary') return '';
  return `<div class="brief-stale-note">
    <span>Wearable data was still syncing when this was generated.</span>
    <button class="home-pill-btn" data-brief-action="refresh">Refresh</button>
  </div>`;
}

function briefStructuredHTML(brief) {
  const s = brief.structured || {};
  const mode = s.mode || brief.mode || 'morning';
  const hero = s.hero_metric || {};
  const heroHtml = briefHeroRingSVG(hero.value, hero.label, hero.delta_vs_7d, hero.key);
  const playKey   = mode === 'morning' ? 'today_play' : 'tomorrow_setup';
  const playLabel = mode === 'morning' ? "TODAY'S PLAY" : "TOMORROW'S SETUP";
  return `${briefHeadHTML(briefWeatherChipHTML(s.weather_chip), briefBadgeHTML(brief))}
    <h2 class="brief-headline">${briefEsc(s.headline || '')}</h2>
    ${s.subhead ? `<p class="brief-subhead">${briefEsc(s.subhead)}</p>` : ''}
    <div class="brief-divider"></div>
    <div class="brief-hero-grid">
      <div class="brief-hero-ring">${heroHtml}</div>
      ${briefStatsHTML(s.stats)}
    </div>
    ${briefPillsHTML(s.evidence_pills)}
    <div class="brief-divider"></div>
    ${briefPlayHTML(s[playKey], playLabel)}
    ${briefStaleNoteHTML(brief)}`;
}

function briefLegacyHTML(brief) {
  const paragraphs = String(brief.narrative || '').split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  return `${briefHeadHTML('', briefBadgeHTML(brief))}
    ${paragraphs.map(p => `<p class="brief-legacy-para">${briefEsc(p)}</p>`).join('')}
    ${briefStaleNoteHTML(brief)}`;
}

function briefRender() {
  const el = document.getElementById('homeBrief');
  if (!el) return;
  if (_briefState.status === 'loading')          el.innerHTML = briefSkeletonHTML();
  else if (_briefState.status === 'empty')       el.innerHTML = briefEmptyHTML();
  else if (_briefState.status === 'error')       el.innerHTML = briefErrorHTML(_briefState.error);
  else if (_briefState.brief?.structured)        el.innerHTML = briefStructuredHTML(_briefState.brief);
  else if (_briefState.brief?.narrative)         el.innerHTML = briefLegacyHTML(_briefState.brief);
  else if (_briefState.brief)                    el.innerHTML = briefEmptyHTML();
}

/* ── Data ─────────────────────────────────────────────────── */

async function homeBriefLoad() {
  if (_briefInflight) return _briefInflight;
  _briefInflight = (async () => {
    try {
      _briefState = { status: 'loading', brief: null, error: null };
      briefRender();

      const yday = briefYesterdayLocal();
      const mode = briefCurrentMode();

      const { data, error } = await db.from('daily_briefs')
        .select('id,brief_date,generated_at,model,mode,structured,tldr,narrative,confidence,status,fallback_reason')
        .eq('brief_date', yday)
        .eq('mode', mode)
        .maybeSingle();

      if (error) throw error;

      if (data) {
        _briefState = { status: 'ok', brief: data, error: null };
        briefRender();
        return;
      }

      const brief = await briefGenerate({ force: false, mode });
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

async function briefGenerate({ force, mode }) {
  const session = (await db.auth.getSession()).data?.session;
  const token   = session?.access_token;
  if (!token) throw new Error('not_authenticated');

  const res = await fetch('/.netlify/functions/beta-daily-brief', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ force: !!force, mode: mode || briefCurrentMode() }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = j?.detail ? `${j.error}: ${j.detail}` : (j?.error || `http_${res.status}`);
    throw new Error(msg);
  }
  return j;
}

async function homeBriefRefresh(force = true, resyncOura = false) {
  try {
    _briefState = { status: 'loading', brief: _briefState.brief, error: null };
    briefRender();
    // User-initiated Refresh on a preliminary brief: re-pull Oura first so
    // we regenerate against actual fresh data, not the same stale DB rows.
    if (resyncOura) {
      try {
        if (typeof showToast === 'function') showToast('Syncing wearable data…', 'ok');
        await briefResyncOura();
      } catch (e) {
        console.warn('[brief] Oura resync failed; regenerating anyway', e);
        if (typeof showToast === 'function') showToast('Sync failed — regenerating with existing data', 'offline');
      }
    }
    const brief = await briefGenerate({ force, mode: briefCurrentMode() });
    _briefState = { status: 'ok', brief, error: null };
    briefRender();
    // Dismiss the in-progress "Syncing..." toast now that work is complete.
    if (typeof hideToast === 'function') hideToast();
  } catch (e) {
    console.warn('[brief] refresh failed', e);
    _briefState = { status: 'error', brief: null, error: e?.message || 'refresh_failed' };
    briefRender();
    if (typeof hideToast === 'function') hideToast();
  }
}

// Trigger a fresh Oura sync via the existing beta-sync-now endpoint
// (which calls cron-health-sync backfill server-side using the internal
// secret). 2-day window is enough to catch today's row that's mid-day
// stale; longer windows just slow things down for the user.
async function briefResyncOura() {
  const session = (await db.auth.getSession()).data?.session;
  const token   = session?.access_token;
  if (!token) throw new Error('not_authenticated');
  const res = await fetch('/.netlify/functions/beta-sync-now?provider=oura&days=2', {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j?.error || `sync_http_${res.status}`);
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
      // The "Refresh" affordance on a preliminary brief means the user wants
      // fresh data, not just a fresh narrative. Trigger Oura resync first.
      homeBriefRefresh(true, true);
    }
  });
}

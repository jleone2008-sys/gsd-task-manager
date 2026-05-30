/* ══════════════════════════════════════════════════════════════
   DAILY BRIEF — top card on Home (beta-only). Layout:

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

   Back-compat: if a row has only `narrative` and no `structured`,
   render the legacy paragraph layout as a fallback.
═══════════════════════════════════════════════════════════════ */

let _briefState = { status: 'loading', brief: null, error: null };
let _briefInflight = null;
let _briefWired = false;

// Latest sleep_intent for the current "sleep day" (the window from
// ~8 PM tonight through ~4 AM tomorrow). Populated by briefLoadSleepIntent
// on brief mount and patched in-place after insert/delete so the button
// state survives brief regens without a re-fetch. null = no intent
// logged yet; { id, intent_at } = logged.
let _briefSleepIntent = null;
let _briefSleepIntentLoaded = false;

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
  walk:   '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="3" r="1.4" fill="currentColor" stroke="none"/><path d="M5 14l2-4 2 2 1 2M9 9l2-2 3 1M6 6l3-1"/></svg>',
  tasks:  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5.5"/><path d="M5.5 8l2 2 3-4"/></svg>',
  habits: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 14c2.5 0 4.5-1.8 4.5-4.2 0-1.8-.9-2.7-1.8-3.5C9.7 5.4 9 4.2 9 2.5 7 3.5 5 5.5 5 8c-1 .5-1.5 1.5-1.5 2.5C3.5 12.4 5.3 14 8 14z"/></svg>',
  sleep:  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 9.5A5.5 5.5 0 016.5 3 5.5 5.5 0 1013 9.5z"/></svg>',
  work:   '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="5" width="11" height="8" rx="1"/><path d="M6 5V3.5h4V5"/></svg>',
  meal:   '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2v5a2 2 0 002 2v5M6 2v5M11 2c-1.5 0-2 1-2 3s1 3 2 3v5"/></svg>',
  other:  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="8" cy="8" r="2.5" fill="currentColor" stroke="none"/></svg>',
};

function playIconSVG(name) {
  return PLAY_ICON_SVG[name] || PLAY_ICON_SVG.other;
}

// Small trend/insight glyph for the optional learned-insight line. Canonical
// 1.8 stroke, currentColor (inherits the guava icon color from .brief-insight-icon).
const BRIEF_INSIGHT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l5-5 4 4 8-8"/><path d="M17 8h4v4"/></svg>';

/* ── Hero ring SVG (120px, score+label+delta inside) ──────── */

// Vibrant ring strokes (the "B" palette). Rings are strokes, not text, so they
// use brighter values than the earth chip tokens: sleep→violet, readiness→amber,
// activity→green. Literal hex because the SVG stroke attribute can't resolve vars.
const HERO_RING_COLORS = {
  sleep_score:     '#7e5fc0',
  readiness_score: '#dd9412',
  activity_score:  '#46a85a',
};

function briefHeroRingSVG(score, label, delta, key) {
  const color = HERO_RING_COLORS[key] || '#7e5fc0';
  const r = 52;
  const c = 2 * Math.PI * r;
  const pct = score == null ? 0 : Math.max(0, Math.min(100, score)) / 100;
  const off = c * (1 - pct);
  const deltaDisplay = (delta == null || delta === 0) ? ''
    : (delta > 0 ? `↑${delta}` : `↓${Math.abs(delta)}`);
  const deltaClass = delta > 0 ? 'is-up' : delta < 0 ? 'is-down' : '';
  return `<svg viewBox="0 0 120 120" class="brief-hero-svg">
    <circle cx="60" cy="60" r="${r}" fill="none" stroke="var(--surface-2)" stroke-width="8"/>
    <circle class="brief-hero-arc" cx="60" cy="60" r="${r}" fill="none" stroke="${color}" stroke-width="8" stroke-linecap="round"
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
      font-size: var(--fs-meta); font-weight: 700; letter-spacing: .08em;
      color: var(--guava-700); text-transform: uppercase;
    }
    .brief-head-right { display: inline-flex; align-items: center; gap: 8px; }
    .brief-weather-chip {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 4px 10px; border: 1px solid var(--edge); border-radius: var(--r-md);
      font-size: var(--fs-meta); color: var(--ink-2); white-space: nowrap;
    }
    .brief-weather-temp { font-weight: 700; color: var(--ink); }
    /* Sleep self-report chip — slots into the head-right cluster between
       the weather chip (morning) or empty slot (evening) and the
       confidence badge. Same pill height + radius as the weather chip
       so the strip reads as a single row of related affordances. */
    .brief-sleep-chip {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 4px 10px; border: 1px solid var(--edge); border-radius: var(--r-md);
      background: var(--surface); color: var(--ink-2);
      font-family: inherit; font-size: var(--fs-meta); cursor: pointer;
      white-space: nowrap; line-height: 1; -webkit-tap-highlight-color: transparent;
      transition: background var(--dur-fast) ease, border-color var(--dur-fast) ease, color var(--dur-fast) ease;
    }
    .brief-sleep-chip:hover   { background: var(--surface-2); color: var(--ink); border-color: var(--edge-strong); }
    .brief-sleep-chip.is-logged {
      background: var(--guava-50); color: var(--guava-700); border-color: transparent; font-weight: 600;
    }
    .brief-sleep-icon { font-size: var(--fs-pill); line-height: 1; }
    .brief-sleep-label { font-weight: 600; color: var(--ink); }
    .brief-sleep-chip.is-logged .brief-sleep-label { color: inherit; }
    .brief-sleep-time { font-variant-numeric: tabular-nums; }
    .brief-conf {
      display: inline-flex; align-items: center; padding: 2px 8px; border-radius: var(--r-md);
      font-size: var(--fs-label); font-weight: 700; text-transform: uppercase; letter-spacing: .05em;
      background: var(--surface-2); color: var(--ink-3);
    }
    .brief-conf.is-low         { background: var(--surface-2); color: var(--ink-4); }
    .brief-conf.is-preliminary { background: var(--guava-50); color: var(--guava-700); }
    .brief-conf.is-fallback    { background: var(--surface-2); color: var(--ink-4); }

    .brief-headline {
      font-size: var(--fs-title); font-weight: 700; color: var(--ink);
      letter-spacing: -0.02em; line-height: 1.15;
      margin: 0 0 6px 0;
    }
    .brief-subhead {
      font-size: var(--fs-search); color: var(--ink-2); line-height: 1.45;
      margin: 0 0 16px 0;
    }
    /* Optional learned-insight line — a quiet "the system noticed this" note
       under the subhead. Subtler than the subhead (smaller, muted ink), set
       off by a thin guava left-rule + a small trend icon so it reads as a
       distinct register without competing for attention. Only rendered when
       structured.insight is non-null (most days it's absent). */
    .brief-insight {
      display: flex; gap: 7px; align-items: flex-start;
      margin: -4px 0 16px 0; padding-left: 10px;
      border-left: 2px solid var(--guava-300);
      font-size: var(--fs-pill); line-height: 1.45; color: var(--ink-3);
    }
    .brief-insight-icon { flex: 0 0 auto; width: 13px; height: 13px; color: var(--guava-700); margin-top: 2px; }
    .brief-insight-icon svg { width: 100%; height: 100%; display: block; }

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
    .brief-hero-label { font-size: var(--fs-nano); font-weight: 700; letter-spacing: .08em; fill: var(--ink-3); }
    .brief-hero-delta { font-size: var(--fs-meta); font-weight: 700; fill: var(--ink-4); font-variant-numeric: tabular-nums; }
    .brief-hero-delta.is-up   { fill: #5e8c4f; }
    .brief-hero-delta.is-down { fill: var(--guava-700); }

    .brief-stats { display: flex; flex-direction: column; }
    .brief-stat-row {
      display: grid; grid-template-columns: 1fr auto; gap: 8px;
      align-items: baseline;
      padding: 6px 0;
      font-size: var(--fs-search);
    }
    .brief-stat-row + .brief-stat-row { border-top: 1px dashed var(--edge); }
    .brief-stat-label { color: var(--ink-2); }
    .brief-stat-value {
      font-variant-numeric: tabular-nums; color: var(--ink);
      display: inline-flex; align-items: baseline; gap: 8px;
    }
    .brief-stat-num { font-weight: 700; }
    .brief-stat-delta { font-size: var(--fs-meta); font-weight: 700; }
    /* is-good / is-bad are the new server-driven classes (delta_dir field).
       is-up / is-down are kept for back-compat with briefs generated before
       the recap migration; they encode "arrow direction" rather than
       "good/bad" so they read wrong on lower-is-better metrics like RHR. */
    .brief-stat-delta.is-good { color: #5e8c4f; }
    .brief-stat-delta.is-bad  { color: var(--guava-700); }
    .brief-stat-delta.is-up   { color: #5e8c4f; }
    .brief-stat-delta.is-down { color: var(--guava-700); }
    .brief-stat-note { font-size: var(--fs-meta); color: var(--ink-4); font-weight: 500; }
    .brief-stats-baseline {
      font-size: var(--fs-label); color: var(--ink-4); margin-top: 6px;
      text-align: right; letter-spacing: .02em; font-style: italic;
    }

    .brief-pills {
      display: flex; flex-wrap: wrap; gap: 6px;
      margin-top: 14px;
    }
    .brief-pill {
      display: inline-flex; align-items: center;
      padding: 3px 10px; border: 1px solid var(--slate-bg); border-radius: var(--r-md);
      background: var(--slate-bg); color: var(--slate-fg);
      font-size: var(--fs-meta); white-space: nowrap;
    }
    /* Sentiment colouring: positive = green (moss), negative = red (danger). */
    .brief-pill--pos { background: var(--moss-bg); color: var(--moss-fg); border-color: var(--moss-bg); }
    .brief-pill--neg { background: var(--danger-100); color: var(--danger-700); border-color: var(--danger-100); }

    .brief-play-label {
      font-size: var(--fs-meta); font-weight: 700; letter-spacing: .08em;
      color: var(--ink-3); text-transform: uppercase;
      margin: 0 0 8px 0;
    }
    .brief-play { display: flex; flex-direction: column; }
    .brief-play-row {
      display: grid; grid-template-columns: 22px 76px 1fr; gap: 10px;
      align-items: baseline;
      padding: 8px 0;
      font-size: var(--fs-search);
    }
    .brief-play-row + .brief-play-row { border-top: 1px solid var(--edge); }
    .brief-play-icon {
      width: 18px; height: 18px;
      color: var(--ink-3);
      align-self: center;
    }
    .brief-play-icon svg { width: 100%; height: 100%; display: block; }
    .brief-play-scope {
      font-size: var(--fs-meta); color: var(--ink-3);
      font-weight: 600; white-space: nowrap;
    }
    .brief-play-content { color: var(--ink); line-height: 1.4; }

    .brief-empty {
      display: flex; flex-direction: column; align-items: flex-start; gap: 10px;
      padding: 4px 0 2px;
    }
    .brief-empty-msg { font-size: var(--fs-search); color: var(--ink-3); line-height: 1.5; }
    .brief-skeleton  { color: var(--ink-4); font-size: var(--fs-search); }
    .brief-error     { color: var(--guava-700); font-size: var(--fs-search); }
    .brief-stale-note {
      margin-top: 14px; font-size: var(--fs-meta); color: var(--ink-4);
      display: flex; align-items: center; gap: 8px;
    }
    /* "Last updated at H:MM PM" — small, right-aligned, same gray as the
       home-card empty states (var(--ink-4)). Negative bottom margin
       pulls the stamp closer to the card's bottom edge so it doesn't
       feel marooned in the card's 20px bottom padding. */
    .brief-updated-stamp {
      margin-top: 10px;
      margin-bottom: -10px;
      text-align: right;
      font-size: var(--fs-meta);
      color: var(--ink-4);
    }

    .brief-legacy-para {
      font-size: var(--fs-search); line-height: 1.55; color: var(--ink);
      margin: 0 0 10px 0;
    }
    .brief-legacy-para:last-child { margin-bottom: 0; }

    /* ── Recap grid (Yesterday/Today or Today/Tomorrow). Two columns side
          by side; each row icon + label + value. The forward-side fields
          (events, task counts, sleep target) and past-side fields (habits
          closed, tasks done, bedtime, mood) share the same row markup —
          the rows present depend on what data was set in structured.recap. */
    .brief-recap-grid {
      display: grid; grid-template-columns: 1fr 1fr; gap: 14px;
    }
    .brief-recap-col { display: flex; flex-direction: column; }
    .brief-recap-col-label {
      font-size: var(--fs-meta); font-weight: 700; letter-spacing: .08em;
      color: var(--ink-3); text-transform: uppercase; margin: 0 0 8px 0;
    }
    /* Row layout:
       Col 1 = icon (18px fixed)
       Col 2 = label (auto-sized to its short text — 'Train', 'Habits', etc.)
       Col 3 = value (minmax(0, 1fr) so it eats whatever space remains AND
               can shrink below its content width to allow ellipsis when
               the value is long; without min: 0 a grid item's default
               min-content size keeps it from ever shrinking, which is
               exactly what was letting 'Full Body C · 19 sets · 1,920 lbs'
               push past the column edge).
       This is the canonical brief-row contract — any new row added here
       inherits the same overflow protection. */
    .brief-recap-row {
      display: grid; grid-template-columns: 18px auto minmax(0, 1fr); gap: 8px;
      align-items: baseline; padding: 6px 0; font-size: var(--fs-search);
    }
    .brief-recap-row + .brief-recap-row { border-top: 1px dashed var(--edge); }
    .brief-recap-icon { font-size: var(--fs-body); line-height: 1; }
    .brief-recap-name { color: var(--ink-3); white-space: nowrap; }
    .brief-recap-value {
      color: var(--ink); font-weight: 600; text-align: right;
      font-variant-numeric: tabular-nums;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      min-width: 0;
    }
    @media (max-width: 420px) {
      /* Narrow phones: collapse the grid to stacked sections so the values
         don't wrap to two rows each. */
      .brief-recap-grid { grid-template-columns: 1fr; gap: 4px; }
      .brief-recap-col + .brief-recap-col { margin-top: 10px; }
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
  // Kick the sleep-intent fetch in parallel with the brief load. The
  // button is hidden outside the 20:00-04:00 window so the fetch is
  // wasted then, but it's a single cheap RLS read and avoids a "button
  // pops in" beat once the user reopens the app after 8 PM.
  briefLoadSleepIntent();
}

function briefHeadHTML(weatherChipHtml, badgeHtml) {
  // Sleep button slots into the right side of the head strip, before the
  // weather chip / confidence badge. Visible only in the 20:00-04:00
  // local window — outside that, returns '' and contributes nothing to
  // the layout. The button + already-logged pill share the same slot so
  // the strip's width is stable across the tap event.
  const sleepHtml = briefSleepButtonHTML();
  return `<div class="brief-head">
    <span class="brief-eyebrow">${briefEsc(briefWeekdayUpper())} BRIEF</span>
    <span class="brief-head-right">${sleepHtml}${weatherChipHtml || ''}${badgeHtml || ''}</span>
  </div>`;
}

/* ── Sleep Intent (bedtime self-report) ─────────────────────── */

// Sleep button visibility window: from 20:00 local through 04:00 local
// next morning. Spans both the evening brief and the early-morning hours
// before the morning brief regenerates at 04:00. Outside this window the
// button is hidden — there's no reason to log bedtime mid-afternoon.
function briefSleepButtonVisible() {
  const tz = (Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC';
  const h = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(new Date()), 10);
  const hour = (h === 24) ? 0 : h;
  return hour >= 20 || hour < 4;
}

// Format an ISO timestamp as "10:23 PM" in the user's local timezone.
function briefSleepFormatTime(iso) {
  if (!iso) return '';
  const dt = new Date(iso);
  if (isNaN(dt.getTime())) return '';
  return dt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function briefSleepButtonHTML() {
  if (!briefSleepButtonVisible()) return '';
  if (_briefSleepIntent && _briefSleepIntent.intent_at) {
    const t = briefSleepFormatTime(_briefSleepIntent.intent_at);
    // Tap to clear (with confirmation in the handler).
    return `<button class="brief-sleep-chip is-logged" data-brief-action="sleep-clear" title="Clear bedtime log">
      <span class="brief-sleep-icon">🛏</span>
      <span class="brief-sleep-time">${briefEsc(t)}</span>
    </button>`;
  }
  return `<button class="brief-sleep-chip" data-brief-action="sleep-log" title="Log bedtime — compares to Oura's detected onset">
    <span class="brief-sleep-icon">🛏</span>
    <span class="brief-sleep-label">Bed</span>
  </button>`;
}

// Pull the most recent sleep_intent within the last 12 hours. The button
// only shows in a 20:00–04:00 window — anything within 12 hours of "now
// during that window" is necessarily the current night's intent. No
// timezone math needed.
async function briefLoadSleepIntent() {
  if (_briefSleepIntentLoaded) return;
  _briefSleepIntentLoaded = true;
  try {
    const cutoffIso = new Date(Date.now() - 12 * HOUR_MS).toISOString();
    const { data, error } = await db.from('sleep_intents')
      .select('id, intent_at')
      .gte('intent_at', cutoffIso)
      .order('intent_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    _briefSleepIntent = data || null;
    // Re-render to swap the button into its logged state if we found one.
    if (_briefState.status === 'ok') briefRender();
  } catch (e) {
    console.warn('[brief] sleep_intent load failed', e);
  }
}

// Insert a new sleep_intent row (intent_at defaults to now). Optimistic
// local update so the button flips immediately; rolls back if the insert
// fails. db is the global Supabase client; auth.uid() enforces user_id
// via the sleep_intents_insert_own RLS policy, so no user_id needed in
// the payload.
async function briefLogSleepIntent() {
  const prior = _briefSleepIntent;
  const optimistic = { id: 'pending-' + Date.now(), intent_at: new Date().toISOString() };
  _briefSleepIntent = optimistic;
  briefRender();
  try {
    const { data: { user } } = await db.auth.getUser();
    if (!user) throw new Error('not_authenticated');
    const { data, error } = await db.from('sleep_intents')
      .insert({ user_id: user.id, source: 'manual' })
      .select('id, intent_at')
      .single();
    if (error) throw error;
    _briefSleepIntent = data;
    briefRender();
  } catch (e) {
    console.warn('[brief] sleep_intent insert failed', e);
    _briefSleepIntent = prior;
    briefRender();
    if (typeof showToast === 'function') showToast('Could not log bedtime', 'offline');
  }
}

// Clear today's sleep_intent. Confirmation prompt prevents accidental
// taps. On success, button flips back to "Bed" so the user can re-log
// at a corrected time.
async function briefClearSleepIntent() {
  if (!_briefSleepIntent || !_briefSleepIntent.id) return;
  if (!window.confirm('Clear bedtime log? You can tap Bed again at the right time.')) return;
  const prior = _briefSleepIntent;
  _briefSleepIntent = null;
  briefRender();
  try {
    const { error } = await db.from('sleep_intents').delete().eq('id', prior.id);
    if (error) throw error;
  } catch (e) {
    console.warn('[brief] sleep_intent delete failed', e);
    _briefSleepIntent = prior;
    briefRender();
    if (typeof showToast === 'function') showToast('Could not clear bedtime', 'offline');
  }
}

function briefSkeletonHTML() {
  // Phase 3a — content-shaped skeleton: eyebrow line, headline bar,
  // subhead, hero ring placeholder, two stat rows. Replaces the static
  // "Loading your brief…" copy so the layout doesn't jump on resolve.
  return `${briefHeadHTML('', '')}
          <div class="brief-skeleton">
            <div class="skeleton" style="width:35%;height:10px;margin-top:4px;"></div>
            <div class="skeleton" style="width:70%;height:24px;margin-top:14px;"></div>
            <div class="skeleton" style="width:90%;height:14px;margin-top:10px;"></div>
            <div class="skeleton" style="width:120px;height:120px;border-radius:50%;margin:22px auto 18px;"></div>
            <div class="skeleton" style="width:100%;height:14px;"></div>
            <div class="skeleton" style="width:80%;height:14px;"></div>
          </div>`;
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
  // Drop any legacy "· City" suffix (the server no longer sends it) and render
  // a tappable button that opens the weather-detail modal.
  const temp = String(chip).split(/\s*·\s*/)[0];
  return `<button type="button" class="brief-weather-chip is-tappable" data-brief-action="open-weather" title="Weather details" aria-label="Weather details">${briefEsc(temp)}</button>`;
}

function briefStatsHTML(stats) {
  if (!Array.isArray(stats) || stats.length === 0) return '';
  const hasAnyDelta = stats.some(s => !!s.delta);
  return `<div class="brief-stats">${stats.map(s => {
    const value = (s.value == null) ? '—' : s.value;
    // Server now sends delta_dir: 'good' | 'bad' | null. Fall back to the
    // legacy ↑/↓ sniff for old briefs that haven't been regenerated yet
    // (and for fixed positive-is-better metrics where the arrow is the cue).
    let deltaCls = '';
    if (s.delta_dir === 'good')      deltaCls = 'is-good';
    else if (s.delta_dir === 'bad')  deltaCls = 'is-bad';
    else if (String(s.delta || '').startsWith('↑')) deltaCls = 'is-good';
    else if (String(s.delta || '').startsWith('↓')) deltaCls = 'is-bad';
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
  }).join('')}</div>`;
}

// Fallback sentiment for LEGACY string pills (briefs cached before the server
// started tagging tone). New briefs send {text, tone} and skip this.
function briefPillSentiment(text) {
  const t = String(text).toLowerCase();
  if (/(overdue|\blate\b|missed|behind|drop|deficit|high strain|elevated|skip|waiting|stress|poor|restless|fragmented|under-?slept|short on sleep|↓|declin|spik(e|ing)|backed up|low recovery|low readiness|below)/.test(t)) return ' brief-pill--neg';
  if (/(solid|strong|good|great|ready|recover|on track|improv|rested|consistent|streak|complete|done|optimal|steady|calm|stable|deep sleep|efficient|high recovery|high readiness|fresh|↑|crushed|ahead|on top|above)/.test(t)) return ' brief-pill--pos';
  return '';
}

function briefPillsHTML(pills) {
  if (!Array.isArray(pills) || pills.length === 0) return '';
  return `<div class="brief-pills">${pills.map(p => {
    const isObj = p && typeof p === 'object';
    const text = isObj ? (p.text || '') : p;
    let cls;
    if (isObj && p.tone === 'positive') cls = ' brief-pill--pos';
    else if (isObj && p.tone === 'negative') cls = ' brief-pill--neg';
    else if (isObj && p.tone === 'neutral') cls = '';
    else cls = briefPillSentiment(text);   // legacy string pill → heuristic
    return `<span class="brief-pill${cls}">${briefEsc(text)}</span>`;
  }).join('')}</div>`;
}

// Format a task_counts {priority, due_today, overdue, total_open} block
// into the brief's compact "1p · 0d · 1o" shorthand. Hides the row when
// no tasks are open at all (returns null so the caller can skip rendering).
function briefRecapTaskCountsText(tc) {
  if (!tc || !tc.total_open) return null;
  return `${tc.priority || 0}p · ${tc.due_today || 0}d · ${tc.overdue || 0}o`;
}

// Format a habits {pct, done, due} block into "20% · 1/5". Returns null
// when there's nothing to render (no habits due that day).
function briefRecapHabitsText(h) {
  if (!h || !h.due) return null;
  return `${h.pct || 0}% · ${h.done || 0}/${h.due}`;
}

// Two-column Yesterday/Today recap grid. Replaces the old Today's Play /
// Tomorrow's Setup row list. Server emits structured.recap = { left, right }
// where each side has its own label and a fixed set of optional fields.
// Rendering is purely client-side from the data; Tier 1 mutations patch
// the structured.recap fields in place and call briefRender again.
function briefRecapHTML(recap, structured) {
  if (!recap || (!recap.left && !recap.right)) return '';
  // Canonical row order. Rows are tagged with a `slot` and sorted by this so
  // shared rows line up across the two columns — Habits is first, so when both
  // Yesterday and Today have habits they land on the same (top) row.
  const SLOT_ORDER = ['habits', 'steps', 'train', 'tasks', 'sleep', 'mood', 'events'];
  const renderCol = (col) => {
    if (!col) return '';
    const rows = [];
    // Past-side fields (habits closed, tasks done, bedtime, mood).
    const habitsTxt = briefRecapHabitsText(col.habits);
    if (habitsTxt != null) rows.push({ slot: 'habits', icon: '🔥', name: 'Habits',     value: habitsTxt });
    // Steps moved out of the activity callout into the Yesterday recap column.
    if (col.steps != null) rows.push({ slot: 'steps', icon: '👟', name: 'Steps', value: Number(col.steps).toLocaleString() });
    if (col.tasks_done != null) rows.push({ slot: 'tasks', icon: '✓', name: 'Tasks done', value: String(col.tasks_done) });
    if (col.bedtime)            rows.push({ slot: 'sleep', icon: '🌙', name: 'In bed',     value: col.bedtime });
    if (col.mood_label)         rows.push({ slot: 'mood', icon: '😊', name: 'Mood',       value: col.mood_label });
    // Forward-side fields (events, task counts, today's habits, sleep target).
    if (col.events != null && (col.label === 'Today' || col.label === 'Tomorrow')) {
      rows.push({ slot: 'events', icon: '📅', name: 'Events', value: String(col.events) });
    }
    const tcTxt = briefRecapTaskCountsText(col.task_counts);
    if (tcTxt != null) rows.push({ slot: 'tasks', icon: '☐', name: 'Tasks', value: tcTxt });
    // Morning brief: live "Tasks done today" so completions show up
    // without waiting for tonight's brief regen. Only renders when > 0
    // so the row doesn't add noise first thing in the morning.
    if (col.tasks_done_today != null && col.tasks_done_today > 0) {
      rows.push({ slot: 'tasks', icon: '✓', name: 'Done', value: String(col.tasks_done_today) });
    }
    const habitsTodayTxt = briefRecapHabitsText(col.habits_today);
    if (habitsTodayTxt != null) rows.push({ slot: 'habits', icon: '🔥', name: 'Habits', value: habitsTodayTxt });
    // Train row — either today/tomorrow's planned session OR yesterday/
    // today's logged session, formatted server-side as { label, detail }.
    // Skip when null (no active plan AND no session logged).
    if (col.train && col.train.label) {
      const value = col.train.detail
        ? `${col.train.label} · ${col.train.detail}`
        : col.train.label;
      rows.push({ slot: 'train', icon: '🏋️', name: 'Train', value });
    }
    // Sleep target — always labeled "Bed time" regardless of which
    // column it's on. The server now puts it on the TODAY column in
    // both morning and evening modes (it's always tonight's bedtime),
    // so column-aware labeling ("Tonight" / "Tomorrow") was misleading.
    if (col.sleep_target) {
      rows.push({ slot: 'sleep', icon: '🌙', name: 'Bed time', value: col.sleep_target });
    }
    if (!rows.length) return '';
    // Order rows so shared slots align across columns, then cap at 5 callouts.
    rows.sort((a, b) => SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot));
    const capped = rows.slice(0, 5);
    return `<div class="brief-recap-col">
      <div class="brief-recap-col-label">${briefEsc(col.label || '')}</div>
      ${capped.map(r => `<div class="brief-recap-row">
        <span class="brief-recap-icon">${briefEsc(r.icon)}</span>
        <span class="brief-recap-name">${briefEsc(r.name)}</span>
        <span class="brief-recap-value">${briefEsc(r.value)}</span>
      </div>`).join('')}
    </div>`;
  };
  return `<div class="brief-recap-grid">
    ${renderCol(recap.left)}
    ${renderCol(recap.right)}
  </div>`;
}

function briefStaleNoteHTML(brief) {
  if (brief.status !== 'preliminary') return '';
  // Two flavors of preliminary, distinguished by fallback_reason set by
  // beta-daily-brief.js's freshness check:
  //
  //   oura_sleep_data_missing — activity present, sleep null. Oura cloud
  //     has today's row but hasn't received last night's sleep session yet.
  //     The actionable fix is on the phone, not in this app — opening the
  //     Oura app forces it to push the ring's overnight buffer. Refresh
  //     only helps AFTER that push.
  //
  //   oura_data_stale_at_generation (and other / unset) — generic case;
  //     nothing recent in oura_daily at all. Refresh re-pulls and regens.
  const reason = brief.fallback_reason || '';
  if (reason === 'oura_sleep_data_missing') {
    return `<div class="brief-stale-note">
      <span>Sleep data still syncing — open the Oura app to push last night, then tap Refresh.</span>
      <button class="home-pill-btn" data-brief-action="refresh">Refresh</button>
    </div>`;
  }
  return `<div class="brief-stale-note">
    <span>Wearable data was still syncing when this was generated.</span>
    <button class="home-pill-btn" data-brief-action="refresh">Refresh</button>
  </div>`;
}

// Small "Last updated at H:MM AM/PM" stamp pinned to the bottom-right of
// the brief card. Reads brief.generated_at (UTC ISO from the daily-brief
// function) and formats in the user's local time. Bails silently if the
// field is missing (legacy briefs).
function briefUpdatedStampHTML(brief) {
  if (!brief?.generated_at) return '';
  const dt = new Date(brief.generated_at);
  if (isNaN(dt.getTime())) return '';
  const timeStr = dt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `<div class="brief-updated-stamp">Last updated at ${briefEsc(timeStr)}</div>`;
}

function briefStructuredHTML(brief) {
  const s = brief.structured || {};
  const mode = s.mode || brief.mode || 'morning';
  // The hero "state circle" rotates through all available scores (readiness /
  // sleep / activity). Fall back to the single hero_metric for cached briefs.
  const rotation = (Array.isArray(s.rotation) && s.rotation.length) ? s.rotation : (s.hero_metric ? [s.hero_metric] : []);
  const hero = rotation[0] || {};
  const heroHtml = briefHeroRingSVG(hero.value, hero.label, hero.delta_vs_7d, hero.key);
  // Prefer the new recap grid (Yesterday/Today or Today/Tomorrow). For old
  // briefs in the DB that still carry today_play / tomorrow_setup, fall back
  // to the legacy single-column play list so they render until the hourly
  // cron regenerates them in the new shape.
  let bottomHtml = '';
  if (s.recap && (s.recap.left || s.recap.right)) {
    bottomHtml = briefRecapHTML(s.recap, s);
  } else {
    const playKey   = mode === 'morning' ? 'today_play' : 'tomorrow_setup';
    const playLabel = mode === 'morning' ? "TODAY'S PLAY" : "TOMORROW'S SETUP";
    bottomHtml = briefPlayHTML(s[playKey], playLabel);
  }
  return `${briefHeadHTML(briefWeatherChipHTML(s.weather_chip), briefBadgeHTML(brief))}
    <h2 class="brief-headline">${briefEsc(s.headline || '')}</h2>
    ${s.subhead ? `<p class="brief-subhead">${briefEsc(s.subhead)}</p>` : ''}
    ${s.insight ? `<div class="brief-insight"><span class="brief-insight-icon">${BRIEF_INSIGHT_ICON}</span><span>${briefEsc(s.insight)}</span></div>` : ''}
    <div class="brief-divider"></div>
    <div class="brief-hero-grid">
      <div class="brief-hero-ring">${heroHtml}</div>
      ${briefStatsHTML(s.stats)}
    </div>
    ${briefPillsHTML(s.evidence_pills)}
    <div class="brief-divider"></div>
    ${bottomHtml}
    ${briefStaleNoteHTML(brief)}
    ${briefUpdatedStampHTML(brief)}`;
}

// Legacy play renderer kept for back-compat (old briefs in DB before the
// recap migration). Removed when the cron has refreshed every brief.
function briefPlayHTML(rows, label) {
  if (!Array.isArray(rows) || rows.length === 0) return '';
  return `<div class="brief-play-label">${briefEsc(label)}</div>
    <div class="brief-play">${rows.map(r => `<div class="brief-play-row">
      <span class="brief-play-icon">${playIconSVG(r.icon)}</span>
      <span class="brief-play-scope">${briefEsc(r.scope || '')}</span>
      <span class="brief-play-content">${briefEsc(r.content || '')}</span>
    </div>`).join('')}</div>`;
}

function briefLegacyHTML(brief) {
  const paragraphs = String(brief.narrative || '').split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  return `${briefHeadHTML('', briefBadgeHTML(brief))}
    ${paragraphs.map(p => `<p class="brief-legacy-para">${briefEsc(p)}</p>`).join('')}
    ${briefStaleNoteHTML(brief)}
    ${briefUpdatedStampHTML(brief)}`;
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
  briefAnimateStats(el);
  briefStartRotation();
}

// Hero "state circle" rotation — auto-cycle through readiness / sleep / activity
// scores every few seconds. Self-stops when the brief is re-rendered or there's
// nothing to cycle; respects reduced-motion.
let _briefRotationTimer = null;
function briefStopRotation() {
  if (_briefRotationTimer) { clearInterval(_briefRotationTimer); _briefRotationTimer = null; }
}
function briefStartRotation() {
  briefStopRotation();
  const s = _briefState.brief && _briefState.brief.structured;
  const rotation = (s && Array.isArray(s.rotation)) ? s.rotation.filter(m => m && m.value != null) : [];
  if (rotation.length < 2) return;                         // nothing to cycle
  if (window.GSDMotion && window.GSDMotion.reduced) return; // respect reduced-motion
  let i = 0;
  _briefRotationTimer = setInterval(() => {
    const ring = document.querySelector('#homeBrief .brief-hero-ring');
    if (!ring) { briefStopRotation(); return; }            // brief gone/re-rendered
    i = (i + 1) % rotation.length;
    const m = rotation[i];
    ring.innerHTML = briefHeroRingSVG(m.value, m.label, m.delta_vs_7d, m.key);
  }, 3800);
}

// Phase 1a — animate integer stat values once per (brief-date, mode) per session.
// Tier-1 re-renders (task toggle, habit check) replay briefRender() but the
// reveal-key in sessionStorage short-circuits subsequent calls so the numbers
// don't flicker on every micro-update. Non-integer values (e.g. "82%" or
// "—") are ignored — only digits-only text counts up. Reduced-motion users
// see the final value immediately.
function briefAnimateStats(root) {
  if (!root || !window.GSDMotion) return;
  const brief = _briefState && _briefState.brief;
  if (!brief) return;
  const dateKey  = brief.brief_date || brief.date || '';
  const mode     = brief.mode || '';
  const sessionKey = 'brief-stats:' + dateKey + ':' + mode;
  window.GSDMotion.reveal(root, {
    key: sessionKey,
    run: () => {
      // Hero ring arc sweeps in first; numeric stats begin to count up
      // shortly after so the motion reads as one coordinated reveal
      // rather than two independent events firing simultaneously.
      const heroArc = root.querySelector('.brief-hero-arc');
      if (heroArc) {
        const r = parseFloat(heroArc.getAttribute('r')) || 0;
        const C = 2 * Math.PI * r;
        const offsetAttr = heroArc.getAttribute('stroke-dashoffset');
        const off = offsetAttr != null ? parseFloat(offsetAttr) : 0;
        const targetFrac = r > 0 ? 1 - (off / C) : 1;
        window.GSDMotion.drawArc(heroArc, { to: targetFrac });
      }
      const nums = root.querySelectorAll('.brief-stat-num');
      nums.forEach((n) => {
        const raw = (n.textContent || '').trim();
        if (!/^-?\d+$/.test(raw)) return;
        const to = parseInt(raw, 10);
        if (!Number.isFinite(to) || to === 0) return;
        n.textContent = '0';
        window.GSDMotion.countUp(n, { to, dur: 600 });
      });
    },
  });
}

/* ── Tier 1 realtime: client-side recompute of deterministic blocks ───────
   When the user completes a task, checks off a habit, or changes mood, the
   AI-written copy (headline / subhead / evidence pills) stays put but the
   deterministic blocks below it rebuild from live state so the brief is
   never lying about counts. No fetch, no DB write — Tier 2's hourly cron
   refreshes the AI copy on the server.
─────────────────────────────────────────────────────────────────────────── */

// Mirror of netlify/functions/beta-daily-brief.js computeTaskCounts.
function briefComputeTaskCounts(refDate) {
  const arr = (typeof tasks !== 'undefined' && Array.isArray(tasks))
    ? tasks.filter(t => !t.done) : [];
  let priority = 0, due_today = 0, overdue = 0;
  for (const t of arr) {
    if (t.due && t.due < refDate) overdue++;
    else if (t.due && t.due === refDate) due_today++;
    if (t.top3) priority++;
  }
  return { priority, due_today, overdue, total_open: arr.length };
}

// Mirror of beta-daily-brief.js buildTaskCountsRow.
function briefTaskCountsRow(counts) {
  if (!counts || !counts.total_open) return null;
  const parts = [];
  if (counts.priority  > 0) parts.push(`${counts.priority} priority`);
  if (counts.due_today > 0) parts.push(`${counts.due_today} due today`);
  if (counts.overdue   > 0) parts.push(`${counts.overdue} overdue`);
  if (parts.length === 0)   parts.push(`${counts.total_open} open`);
  return {
    icon:    'tasks',
    scope:   `${counts.total_open} open`,
    content: parts.join(' · '),
  };
}

// Today's habit completion as { pct, done, due } using the exact same
// formula updateHabitStatsBar uses to paint the bottom-nav '60%' badge
// (todayContribution per habit, summed). Without this alignment the
// brief shows e.g. '50% · 2/4' (due-habits-only) while the badge shows
// '60%' (due + completed-extras). Returns null when no habits are
// currently "mattering" (no due habits and no extras done) so the
// caller can hide the row.
function briefComputeHabitsToday() {
  if (typeof habitsArr === 'undefined' || !Array.isArray(habitsArr)) return null;
  if (typeof todayContribution !== 'function') return null;
  const today = (typeof jToday === 'function') ? jToday()
              : new Date().toISOString().slice(0, 10);
  const active = habitsArr.filter(h => !h.archived);
  let num = 0, den = 0;
  for (const h of active) {
    const c = todayContribution(h, today);
    num += c.num;
    den += c.den;
  }
  if (den === 0) return null;   // no habits required + no extras done
  return {
    pct:  Math.round((num / den) * 100),
    done: num,
    due:  den,
  };
}

// "YYYY-MM-DD" tomorrow in the user's local timezone.
function briefTomorrowLocal() {
  const tz = (Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC';
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const [y, m, d] = today.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10);
}

// "Today" in the user's local timezone, YYYY-MM-DD.
function briefTodayLocal() {
  const tz = (Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC';
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

// Count tasks completed in the user's local day. Mirrors
// netlify/functions/beta-daily-brief.js countTasksInLocalDay so the live
// recompute matches what the server stored at brief-generation time.
function briefCountTasksDoneToday() {
  if (typeof tasks === 'undefined' || !Array.isArray(tasks)) return 0;
  const tz = (Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC';
  const today = briefTodayLocal();
  const [y, m, d] = today.split('-').map(Number);
  // Local midnight today → local midnight tomorrow in UTC ms.
  const startUtc = new Date(Date.UTC(y, m - 1, d)).getTime()
    - tzOffsetMs(today, tz);
  const endUtc = startUtc + DAY_MS;
  let n = 0;
  for (const t of tasks) {
    if (!t.done || !t.completedAt) continue;
    if (t.completedAt >= startUtc && t.completedAt < endUtc) n++;
  }
  return n;
}

// Approximate timezone offset in ms for a YYYY-MM-DD date in tz. Used to
// turn local-midnight into a UTC ms value without depending on the
// Temporal API. Tolerates DST around the boundary.
function tzOffsetMs(dateStr, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const utcNoon = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const localStr = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(utcNoon);
  const part = (k) => Number(localStr.find(p => p.type === k)?.value || 0);
  const localMs = Date.UTC(
    part('year'), part('month') - 1, part('day'),
    part('hour') === 24 ? 0 : part('hour'),
    part('minute'), part('second')
  );
  return localMs - utcNoon.getTime();
}

// Mood labels come from the canonical MOOD_LABEL array in 03-journal.js
// (1-indexed: 1=Bad, 2=Low, 3=Okay, 4=Good, 5=Great). The earlier
// _BRIEF_MOOD_LABELS table here was the PRE-invert_mood_scale.sql
// orientation and produced contradictions like a happy emoji rendered
// next to "Bad" — same value, opposite reading. Fixed by sharing the
// single source of truth.
function briefMoodLabel(v) {
  if (v == null) return null;
  const k = Math.round(Number(v));
  if (typeof MOOD_LABEL !== 'undefined' && Array.isArray(MOOD_LABEL)) {
    return MOOD_LABEL[k - 1] || null;
  }
  return null;
}

// Replace the task play row in-place. If no row currently exists and there are
// open tasks worth surfacing, append one. If the row exists but should be
// dropped (all counts zero), remove it.
function briefPatchTaskRow(rows, newRow) {
  if (!Array.isArray(rows)) return rows;
  const idx = rows.findIndex(r => r && r.icon === 'tasks');
  if (newRow) {
    if (idx >= 0) rows[idx] = newRow;
    else rows.push(newRow);
  } else if (idx >= 0) {
    rows.splice(idx, 1);
  }
  return rows;
}

// Replace the habits play row's content with a fresh "Y'day X/Y" frame from
// today's live habits state. (Server's morning brief renders habits as
// "yesterday's snapshot" — we keep that scope label and only update the
// "still set up today" / "all closed" framing if it changes.)
function briefPatchHabitsRow(rows) {
  if (!Array.isArray(rows)) return rows;
  const idx = rows.findIndex(r => r && r.icon === 'habits');
  if (idx < 0) return rows;
  const stats = briefComputeHabitsToday();
  if (!stats || stats.due === 0) return rows;
  const row = rows[idx];
  row.content = stats.done >= stats.due
    ? 'All habits closed today'
    : `${stats.done}/${stats.due} habits done today`;
  return rows;
}

function homeBriefRecompute() {
  const brief = _briefState && _briefState.brief;
  const s     = brief && brief.structured;
  if (!s) return;                   // brief not loaded yet — nothing to patch
  const mode  = s.mode || brief.mode || 'morning';

  // ── New recap shape (structured.recap.right) ────────────────────────────
  // The forward-side column (Today on morning, Tomorrow on evening) carries
  // task_counts and habits_today. Both are deterministic from live globals;
  // recompute and patch in place so the user sees instant feedback after
  // toggling a task or checking off a habit.
  if (s.recap && s.recap.right) {
    const ref = mode === 'morning' ? briefTodayLocal() : briefTomorrowLocal();
    s.recap.right.task_counts  = briefComputeTaskCounts(ref);
    // Habits only make sense on a column whose data exists today —
    // morning right-column = 'Today', evening right-column = 'Tomorrow'.
    // Tomorrow's habit progress doesn't exist yet, so explicitly clear
    // it in evening mode. Without this gate the live today-count was
    // bleeding into the Tomorrow column.
    s.recap.right.habits_today = (mode === 'morning')
      ? briefComputeHabitsToday()
      : null;
    // Morning mode: surface tasks-done-today on the Today column so the
    // user sees completions reflected without waiting for tonight's brief
    // regen. (Evening mode already shows this on the left column —
    // patched below.)
    if (mode === 'morning') {
      s.recap.right.tasks_done_today = briefCountTasksDoneToday();
    }
  }

  // Evening mode: recap.left.label === 'Today'. Server-side, today's
  // habits + tasks-done are sourced from journal_habit_summary, which
  // only finalizes after midnight — so the server fills these fields
  // with yesterday's snapshot as a placeholder labeled "Today". That
  // shows up to the user as "yesterday's habits being credited to
  // today". Client owns the live values from here.
  if (mode === 'evening' && s.recap && s.recap.left && s.recap.left.label === 'Today') {
    s.recap.left.tasks_done = briefCountTasksDoneToday();
    // briefComputeHabitsToday already returns { pct, done, due } — null
    // means "no habits matter today" and briefRecapHabitsText hides the
    // row in that case. Bug I just introduced one commit ago: was
    // passing { due, done } without pct, which read as '0%'.
    s.recap.left.habits = briefComputeHabitsToday();
  }

  // ── Legacy shape (today_play / tomorrow_setup) ──────────────────────────
  // Keep patching the old fields too — old briefs in the DB still render
  // via that path until the hourly cron regenerates them in the new shape.
  if (mode === 'morning') {
    const counts = briefComputeTaskCounts(briefTodayLocal());
    s.today_plan = s.today_plan || {};
    s.today_plan.task_counts = counts;
    if (Array.isArray(s.today_play)) {
      s.today_play = briefPatchTaskRow(s.today_play, briefTaskCountsRow(counts));
      s.today_play = briefPatchHabitsRow(s.today_play);
    }
  } else {
    const counts = briefComputeTaskCounts(briefTomorrowLocal());
    s.tomorrow_plan = s.tomorrow_plan || {};
    s.tomorrow_plan.task_counts = counts;
    if (Array.isArray(s.tomorrow_setup)) {
      s.tomorrow_setup = briefPatchTaskRow(s.tomorrow_setup, briefTaskCountsRow(counts));
      s.tomorrow_setup = briefPatchHabitsRow(s.tomorrow_setup);
    }
  }

  // Mood: refresh the live label across (a) the evidence pill if present
  // and (b) the recap.left.mood_label slot. Evening mode reflects TODAY's
  // mood (since recap.left.label === 'Today' there); morning mode's left
  // column shows yesterday's mood which doesn't change in-session, so we
  // skip the recap patch for it.
  if (typeof journalState !== 'undefined') {
    const todayStr = briefTodayLocal();
    const entry = journalState.entries.get(todayStr);
    const label = entry ? briefMoodLabel(entry.mood) : null;
    if (label && Array.isArray(s.evidence_pills)) {
      s.evidence_pills = s.evidence_pills.map(p => {
        if (!p) return p;
        const text = (typeof p === 'object') ? p.text : p;
        if (/^mood\s*[:|-]/i.test(text || '')) {
          return (typeof p === 'object') ? { ...p, text: `Mood: ${label}` } : `Mood: ${label}`;
        }
        return p;
      });
    }
    if (mode === 'evening' && s.recap && s.recap.left && s.recap.left.label === 'Today') {
      s.recap.left.mood_label = label;
    }
  }

  briefRender();
}

// Other modules call this without imports — expose on window for global access.
if (typeof window !== 'undefined') window.homeBriefRecompute = homeBriefRecompute;

// Set _briefState.brief to a freshly-loaded brief AND apply the Tier-1
// client patches before rendering. The server's evening-mode recap
// fills recap.left.habits with yesterday's snapshot (the column is
// labeled "Today" but the data isn't finalized until midnight), which
// reads as "yesterday's habits being credited to today" — the patcher
// rewrites it from live state. Pre-this helper, the patcher only ran
// on user-triggered state mutations (task toggle, mood tap, etc.),
// so the *first* render of every brief showed stale habit / task data.
function _briefSetReady(brief) {
  _briefState = { status: 'ok', brief, error: null };
  // homeBriefRecompute returns early when there's no structured payload
  // (legacy briefs) — make sure we still render in that case.
  if (brief?.structured) {
    homeBriefRecompute();
  } else {
    briefRender();
  }
}

/* ── Data ─────────────────────────────────────────────────── */

async function homeBriefLoad() {
  if (_briefInflight) return _briefInflight;
  _briefInflight = (async () => {
    console.time('[perf] brief.load');
    try {
      _briefState = { status: 'loading', brief: null, error: null };
      briefRender();

      const yday = briefYesterdayLocal();
      const mode = briefCurrentMode();

      console.time('[perf] brief.load:fetch');
      const { data, error } = await db.from('daily_briefs')
        .select('id,brief_date,generated_at,model,mode,structured,tldr,narrative,confidence,status,fallback_reason')
        .eq('brief_date', yday)
        .eq('mode', mode)
        .maybeSingle();
      console.timeEnd('[perf] brief.load:fetch');

      if (error) throw error;

      // Auto-migrate old-shape briefs. A row written before the recap
      // redesign has structured.today_play / structured.tomorrow_setup but
      // no structured.recap. On first view we force a fresh generation so
      // the user sees the new layout immediately instead of waiting for
      // the top-of-hour cron tick. Idempotent — once the row has recap,
      // this branch never fires again for that brief_date+mode.
      if (data && data.structured && !data.structured.recap) {
        _briefState = { status: 'loading', brief: data, error: null };
        briefRender();
        const brief = await briefGenerate({ force: true, mode });
        _briefSetReady(brief);
        return;
      }

      if (data) {
        _briefSetReady(data);
        return;
      }

      const brief = await briefGenerate({ force: false, mode });
      _briefSetReady(brief);
    } catch (e) {
      console.warn('[brief] load failed', e);
      _briefState = { status: 'error', brief: null, error: e?.message || 'load_failed' };
      briefRender();
    } finally {
      console.timeEnd('[perf] brief.load');
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
    _briefSetReady(brief);
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
    } else if (action === 'sleep-log') {
      briefLogSleepIntent();
    } else if (action === 'sleep-clear') {
      briefClearSleepIntent();
    } else if (action === 'open-weather') {
      briefOpenWeather();
    }
  });
}

/* ════════════════════════════════════════
   WEATHER DETAIL MODAL (tap the brief weather chip)
   Live read from /.netlify/functions/beta-weather; lets the user update
   location by ZIP or city via /.netlify/functions/beta-set-location.
════════════════════════════════════════ */
function briefWeatherInjectStyles() {
  if (document.getElementById('bwxStyles')) return;
  const st = document.createElement('style');
  st.id = 'bwxStyles';
  st.textContent = `
    .brief-weather-chip.is-tappable { font-family: inherit; cursor: pointer; -webkit-tap-highlight-color: transparent; transition: background var(--dur-fast) ease, border-color var(--dur-fast) ease; }
    .brief-weather-chip.is-tappable:hover { background: var(--surface-2); border-color: var(--edge-strong); color: var(--ink); }
    .bwx-overlay { position: fixed; inset: 0; z-index: 400; background: var(--scrim); backdrop-filter: var(--scrim-blur); -webkit-backdrop-filter: var(--scrim-blur); display: none; align-items: flex-end; justify-content: center; }
    .bwx-overlay.is-open { display: flex; animation: fadeIn var(--dur) var(--ease); }
    .bwx-card { width: 100%; max-width: 480px; background: var(--surface); border-radius: var(--r-lg) var(--r-lg) 0 0; box-shadow: var(--shadow-raised); max-height: 92vh; overflow-y: auto; padding: 16px 16px calc(20px + env(safe-area-inset-bottom)); animation: fadeUp var(--dur-mid) var(--ease-spring) both; }
    @media (min-width: 600px) { .bwx-overlay { align-items: center; } .bwx-card { border-radius: var(--r-lg); max-height: 86vh; } }
    .bwx-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; margin-bottom: 14px; }
    .bwx-loc { display: flex; align-items: center; gap: 6px; font-size: var(--fs-section); font-weight: 700; color: var(--ink); letter-spacing: -0.01em; }
    .bwx-loc-sub { font-size: var(--fs-meta); color: var(--ink-3); margin-top: 2px; }
    .bwx-close { width: 28px; height: 28px; border-radius: 50%; border: 1px solid var(--edge); background: var(--surface); color: var(--ink-3); display: flex; align-items: center; justify-content: center; cursor: pointer; flex: 0 0 auto; font-size: 15px; }
    .bwx-close:hover { background: var(--surface-2); color: var(--ink); }
    .bwx-now { display: flex; align-items: center; gap: 14px; padding: 6px 2px 14px; border-bottom: 1px solid var(--edge); }
    .bwx-now-emoji { font-size: 46px; line-height: 1; }
    .bwx-now-temp { font-size: 38px; font-weight: 800; letter-spacing: -0.02em; color: var(--ink); font-variant-numeric: tabular-nums; }
    .bwx-now-meta { font-size: var(--fs-search); color: var(--ink-2); }
    .bwx-now-feels { font-size: var(--fs-meta); color: var(--ink-3); }
    .bwx-hilo { font-weight: 700; color: var(--ink-2); }
    .bwx-metrics { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin: 14px 0; }
    .bwx-metric { background: var(--surface-2); border-radius: var(--r-md); padding: 8px 10px; display: flex; flex-direction: column; gap: 2px; }
    .bwx-metric-label { font-size: var(--fs-label); font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-3); }
    .bwx-metric-value { font-size: var(--fs-card); font-weight: 700; color: var(--ink); font-variant-numeric: tabular-nums; }
    .bwx-metric-note { font-size: var(--fs-meta); color: var(--ink-4); }
    .bwx-metric-value .uv-hi { color: var(--ochre-fg); }
    .bwx-section-label { font-size: var(--fs-label); font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--ink-3); margin: 14px 0 8px; }
    .bwx-hourly { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 4px; }
    .bwx-hour { flex: 0 0 auto; width: 52px; background: var(--surface-2); border-radius: var(--r-md); padding: 8px 4px; text-align: center; display: flex; flex-direction: column; gap: 3px; align-items: center; }
    .bwx-hour-t { font-size: var(--fs-meta); color: var(--ink-3); }
    .bwx-hour-e { font-size: 17px; line-height: 1; }
    .bwx-hour-temp { font-size: var(--fs-pill); font-weight: 700; color: var(--ink); }
    .bwx-hour-p { font-size: var(--fs-nano); color: var(--sky-fg); font-weight: 700; min-height: 11px; }
    .bwx-tomorrow { display: flex; align-items: center; justify-content: space-between; background: var(--surface-2); border-radius: var(--r-md); padding: 10px 12px; margin-top: 8px; font-size: var(--fs-search); }
    .bwx-tomorrow-left { display: flex; align-items: center; gap: 8px; color: var(--ink-2); }
    .bwx-tomorrow-right { color: var(--ink); font-weight: 700; }
    .bwx-loc-edit { margin-top: 16px; border-top: 1px solid var(--edge); padding-top: 14px; }
    .bwx-loc-edit-row { display: flex; gap: 8px; margin-top: 8px; }
    .bwx-input { flex: 1; min-width: 0; background: var(--surface); border: 1px solid var(--edge-strong); border-radius: var(--r-md); padding: 8px 10px; font-family: inherit; font-size: var(--fs-search); color: var(--ink); outline: none; }
    .bwx-input:focus { border-color: var(--guava-500); box-shadow: var(--shadow-focus); }
    .bwx-save { background: var(--guava-700); color: #fff; border: none; border-radius: var(--r-md); padding: 8px 16px; font-size: var(--fs-search); font-weight: 600; cursor: pointer; white-space: nowrap; }
    .bwx-save[disabled] { opacity: .55; cursor: default; }
    .bwx-hint { font-size: var(--fs-meta); color: var(--ink-4); margin-top: 6px; }
    .bwx-loading, .bwx-error { padding: 24px 4px; font-size: var(--fs-search); color: var(--ink-3); text-align: center; }
    .bwx-error { color: var(--guava-700); }
  `;
  document.head.appendChild(st);
}

async function briefWeatherToken() {
  try { const s = (await db.auth.getSession()).data?.session; return s?.access_token || null; }
  catch (_) { return null; }
}

function briefWeatherEsc(e) { if (e.key === 'Escape') briefCloseWeather(); }

function briefCloseWeather() {
  const ov = document.getElementById('bwxOverlay');
  if (ov) ov.classList.remove('is-open');
  document.removeEventListener('keydown', briefWeatherEsc);
}

async function briefOpenWeather() {
  briefWeatherInjectStyles();
  let ov = document.getElementById('bwxOverlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'bwxOverlay';
    ov.className = 'bwx-overlay';
    document.body.appendChild(ov);
    ov.addEventListener('click', (e) => {
      if (e.target === ov) { briefCloseWeather(); return; }
      const a = e.target.closest('[data-bwx]');
      if (!a) return;
      if (a.dataset.bwx === 'close') briefCloseWeather();
      else if (a.dataset.bwx === 'save') briefSaveLocation();
    });
    ov.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.id === 'bwxLocInput') { e.preventDefault(); briefSaveLocation(); }
    });
  }
  ov.innerHTML = `<div class="bwx-card"><div class="bwx-loading">Loading weather…</div></div>`;
  ov.classList.add('is-open');
  document.addEventListener('keydown', briefWeatherEsc);

  try {
    const token = await briefWeatherToken();
    const res = await fetch('/.netlify/functions/beta-weather', { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
    briefRenderWeather(data);
  } catch (e) {
    const card = document.querySelector('#bwxOverlay .bwx-card');
    if (card) card.innerHTML = `<div class="bwx-head"><div class="bwx-loc">Weather</div><button class="bwx-close" data-bwx="close" aria-label="Close">✕</button></div><div class="bwx-error">Couldn't load weather — ${briefEsc(String(e.message || ''))}</div>${briefWeatherEditHTML('')}`;
  }
}

function briefWeatherEditHTML(currentLabel) {
  return `<div class="bwx-loc-edit">
    <div class="bwx-section-label" style="margin:0">Location</div>
    <div class="bwx-loc-edit-row">
      <input class="bwx-input" id="bwxLocInput" type="text" inputmode="text" value="" placeholder="ZIP code (or City, ST)">
      <button class="bwx-save" id="bwxLocSave" data-bwx="save">Save</button>
    </div>
    <div class="bwx-hint">Enter a US ZIP for the fastest match, or "City, ST".${currentLabel ? ` Current: ${briefEsc(currentLabel)}.` : ''}</div>
  </div>`;
}

function briefRenderWeather(d) {
  const card = document.querySelector('#bwxOverlay .bwx-card');
  if (!card) return;

  if (!d.has_location) {
    card.innerHTML = `<div class="bwx-head"><div><div class="bwx-loc">Weather</div></div><button class="bwx-close" data-bwx="close" aria-label="Close">✕</button></div>
      <div class="bwx-error" style="color:var(--ink-3)">No location set yet — add one to see your forecast.</div>
      ${briefWeatherEditHTML('')}`;
    return;
  }

  const c = d.current || {}, t = d.today || {}, tm = d.tomorrow || {};

  // Refresh the brief's top-right weather chip with the freshly-fetched
  // conditions (tapping the chip opens this modal → keep the chip current).
  try {
    const chipEl = document.querySelector('.brief-weather-chip');
    if (chipEl && t.high_f != null && t.low_f != null) {
      const emoji = c.emoji || t.emoji || '';
      chipEl.textContent = `${emoji ? emoji + ' ' : ''}${Math.round(t.high_f)}°/${Math.round(t.low_f)}°`;
    }
  } catch (e) { /* non-fatal */ }
  const uvNote = t.uv_max == null ? '' : (t.uv_max >= 8 ? 'very high' : t.uv_max >= 6 ? 'high · cover up' : t.uv_max >= 3 ? 'moderate' : 'low');
  const uvClass = (t.uv_max != null && t.uv_max >= 6) ? ' class="uv-hi"' : '';
  const hours = (d.hourly || []).map(h => `<div class="bwx-hour"><span class="bwx-hour-t">${briefEsc(h.label || '')}</span><span class="bwx-hour-e">${h.emoji || ''}</span><span class="bwx-hour-temp">${h.temp_f != null ? h.temp_f + '°' : '—'}</span><span class="bwx-hour-p">${h.precip_pct ? h.precip_pct + '%' : ''}</span></div>`).join('');

  card.innerHTML = `
    <div class="bwx-head">
      <div>
        <div class="bwx-loc">📍 ${briefEsc(d.location_label || 'Your location')}</div>
        <div class="bwx-loc-sub">${c.condition ? briefEsc(c.condition[0].toUpperCase() + c.condition.slice(1)) : 'Current conditions'}</div>
      </div>
      <button class="bwx-close" data-bwx="close" aria-label="Close">✕</button>
    </div>
    <div class="bwx-now">
      <span class="bwx-now-emoji">${c.emoji || t.emoji || '🌡️'}</span>
      <div>
        <div class="bwx-now-temp">${c.temp_f != null ? c.temp_f + '°' : '—'}</div>
        <div class="bwx-now-meta">${c.condition ? briefEsc(c.condition) + ' · ' : ''}<span class="bwx-hilo">H ${t.high_f != null ? t.high_f + '°' : '—'} / L ${t.low_f != null ? t.low_f + '°' : '—'}</span></div>
        ${c.feels_f != null ? `<div class="bwx-now-feels">Feels like ${c.feels_f}°</div>` : ''}
      </div>
    </div>
    <div class="bwx-metrics">
      <div class="bwx-metric"><span class="bwx-metric-label">Precip</span><span class="bwx-metric-value">${t.precip_pct != null ? t.precip_pct + '%' : '—'}</span><span class="bwx-metric-note">${t.precip_pct != null ? (t.precip_pct >= 50 ? 'likely' : t.precip_pct >= 20 ? 'possible' : 'none expected') : ''}</span></div>
      <div class="bwx-metric"><span class="bwx-metric-label">Wind</span><span class="bwx-metric-value">${c.wind_mph != null ? c.wind_mph + ' mph' : '—'}</span><span class="bwx-metric-note">${c.gust_mph != null ? 'gusts ' + c.gust_mph : ''}</span></div>
      <div class="bwx-metric"><span class="bwx-metric-label">UV index</span><span class="bwx-metric-value"><span${uvClass}>${t.uv_max != null ? t.uv_max : '—'}</span></span><span class="bwx-metric-note">${uvNote}</span></div>
      <div class="bwx-metric"><span class="bwx-metric-label">Humidity</span><span class="bwx-metric-value">${c.humidity != null ? c.humidity + '%' : '—'}</span><span class="bwx-metric-note">${c.humidity != null ? (c.humidity >= 70 ? 'humid' : c.humidity >= 30 ? 'comfortable' : 'dry') : ''}</span></div>
      <div class="bwx-metric"><span class="bwx-metric-label">Sun</span><span class="bwx-metric-value">${t.sunrise_label || '—'}</span><span class="bwx-metric-note">${t.sunset_label ? 'set ' + t.sunset_label : ''}</span></div>
      <div class="bwx-metric"><span class="bwx-metric-label">Daylight</span><span class="bwx-metric-value">${t.daylight_min != null ? Math.floor(t.daylight_min / 60) + 'h ' + (t.daylight_min % 60) + 'm' : '—'}</span><span class="bwx-metric-note"></span></div>
    </div>
    ${hours ? `<div class="bwx-section-label">Next 12 hours</div><div class="bwx-hourly">${hours}</div>` : ''}
    ${(tm.high_f != null) ? `<div class="bwx-tomorrow"><span class="bwx-tomorrow-left">${tm.emoji || ''} Tomorrow${tm.condition ? ' · ' + briefEsc(tm.condition) : ''}</span><span class="bwx-tomorrow-right">${tm.high_f}° / ${tm.low_f != null ? tm.low_f + '°' : '—'}${tm.precip_pct ? ' · ' + tm.precip_pct + '%' : ''}</span></div>` : ''}
    ${briefWeatherEditHTML(d.location_label || '')}
  `;
}

async function briefSaveLocation() {
  const input = document.getElementById('bwxLocInput');
  const btn   = document.getElementById('bwxLocSave');
  const val   = (input?.value || '').trim();
  if (!val) { input?.focus(); return; }
  const body = /^\d{5}$/.test(val) ? { zip: val } : { city: val };
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    const token = await briefWeatherToken();
    const res = await fetch('/.netlify/functions/beta-set-location', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.detail || data.error || ('HTTP ' + res.status));
    if (typeof showToast === 'function') showToast(`Location set to ${data.weather_label || val}`, 'ok');
    // Refetch the modal against the new coordinates. The brief's cached chip
    // catches up on the next weather snapshot / brief regen.
    briefOpenWeather();
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
    if (typeof showToast === 'function') showToast(`Couldn't set location — ${e.message}`, 'offline');
  }
}

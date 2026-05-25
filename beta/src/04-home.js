/* ══════════════════════════════════════════════════════════════
   HOME — daily brief (beta-only). Default tab on load.
   Reuses existing domain data + helpers:
     - greeting/mood/calendar  → beta/src/03-journal.js
     - tasks (tHTML, data-task-action handler) → /src/04-tasks-ui.js
     - habits (isHabitDueToday, toggle)        → /src/03-habits-core.js
     - notes + Quill editor                    → /src/06-notes.js, /src/12-quill-init.js
     - Quick Notes (renderScratch)             → /src/07-scratch.js
   Oura rings read oura_daily directly via the oura_daily_select_own RLS policy.

   Layout: greeting is the page title (topbar). Cards:
     1) Today    — health rings + "How are you feeling?" mood
     2) Agenda   — Calendar · Tasks · Habits (one card, bold section titles)
     3) Notes    — recent notes + Quick Notes
     4) Last 7 Days — per-day scores + mood emoji + average mood
═══════════════════════════════════════════════════════════════ */

const HOME_RING_COLORS = { sleep: '#8a6a84', readiness: '#bf9c47', activity: '#7a8a59' };
const HOME_MOOD_EMOJI  = ['🤩', '😊', '😐', '😔', '😢'];

let _homeOura = null;
let _homeOuraInflight = null;
let _homeWired = false;

// Phase 5 — intra-day mood check-ins. Today's check-ins (newest first
// inside the array; we sort on render). Single fetch on Home mount;
// patched in-place by the tap + delete handlers.
let _homeMoodCheckins = [];

function homeToday() {
  return (typeof jToday === 'function') ? jToday() : new Date().toISOString().slice(0, 10);
}
function hEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function homeMoodEmoji() { return (typeof MOOD_EMOJI !== 'undefined') ? MOOD_EMOJI : HOME_MOOD_EMOJI; }
function homeMoodLabels() { return (typeof MOOD_LABEL !== 'undefined') ? MOOD_LABEL : ['Great','Good','Okay','Low','Bad']; }
function homeOuraConnected() { return !!(typeof userSettings !== 'undefined' && userSettings?.integrations?.oura?.connected); }
function homeWhoopConnected() { return !!(typeof userSettings !== 'undefined' && userSettings?.integrations?.whoop?.connected); }
function homeHealthSource() {
  if (typeof getHealthSource === 'function') return getHealthSource();
  return (typeof userSettings !== 'undefined' && userSettings?.integrations?.health_source === 'whoop') ? 'whoop' : 'oura';
}

/* ── Data ─────────────────────────────────────────────────── */

async function loadOuraScores() {
  if (_homeOura) return _homeOura;
  if (_homeOuraInflight) return _homeOuraInflight;
  _homeOuraInflight = (async () => {
    try {
      const { data, error } = await db.from('oura_daily')
        .select('date,sleep_score,readiness_score,activity_score')
        .order('date', { ascending: false })
        .limit(14);
      if (error) throw error;
      _homeOura = { days: data || [] };
      return _homeOura;
    } catch (e) {
      console.warn('[home] oura scores load failed', e);
      return null;
    } finally {
      _homeOuraInflight = null;
    }
  })();
  return _homeOuraInflight;
}

/* ── Greeting (page title) ────────────────────────────────── */

function homeGreetingText() {
  const h = new Date().getHours();
  const name = (typeof getFirstName === 'function' && getFirstName()) || 'there';
  let part = 'evening';
  if (h < 5) part = 'night';
  else if (h < 12) part = 'morning';
  else if (h < 18) part = 'afternoon';
  else if (h < 22) part = 'evening';
  else part = 'night';
  return `Good ${part}, ${name}`;
}

/* ── Top-level render ─────────────────────────────────────── */

function homeEnsureSubStyles() {
  if (document.getElementById('homeSubsectionStyles')) return;
  const style = document.createElement('style');
  style.id = 'homeSubsectionStyles';
  style.textContent = `
    .home-subsection { margin-top: 2px; }
    .home-subsection-h {
      font-size: 10px; font-weight: 700;
      color: var(--ink-4); letter-spacing: 0.08em;
      text-transform: uppercase; margin: 0 0 8px 0;
    }

    /* Tasks card: tight. The bucket heading should hug the task above and
       the task below — no daylight on either side beyond the heading's own
       built-in vertical rhythm. */
    #homeTasks .home-subsection { margin-top: 0; }
    #homeTasks .home-subsection-h { margin: 0 0 4px 0; }

    /* Journal card: roomy. Daily Reflection, Today I Learned, and Mood are
       three distinct inputs; they need real breathing room between them so
       the reflection text doesn't crowd the Today I Learned heading. */
    #homeJournal .home-subsection + .home-subsection { margin-top: 18px; }

    /* No separator line between Tasks buckets — the next heading is enough
       of a break. #homeTasks .task-item carries border-bottom by default
       (1 ID + 1 class specificity); the selector below matches that to win.
       Lines WITHIN a bucket are kept so a multi-row list reads as grouped. */
    #homeTasks .home-subsection .task-group:last-child .task-item { border-bottom: 0; }
    .home-task-due-inline {
      display: inline-flex; align-items: center;
      margin-right: 8px; flex-shrink: 0;
    }
  `;
  document.head.appendChild(style);
}

function renderHome() {
  const el = document.getElementById('homeContainer');
  if (!el) return;
  _homeOura = null;
  homeSyncChrome();
  homeEnsureSubStyles();

  el.innerHTML = `
    <div class="home-card" id="homeBrief"></div>
    <div class="home-card home-section">
      ${homeSectionHead('Events')}
      <div id="homeCalendar"><div class="home-skeleton">Loading events…</div></div>
    </div>
    <div class="home-card home-section">
      ${homeSectionHead('Tasks', '<button class="home-pill-btn home-pill-btn--icon" data-task-action="open-create" title="Add task">+</button>')}
      <div id="homeTasks">${homeTasksInnerHTML()}</div>
    </div>
    <div class="home-card home-section">
      ${homeSectionHead('Habits', '<span class="home-card-meta" id="homeHabitsMeta">' + homeHabitsMeta() + '</span>')}
      <div id="homeHabits">${homeHabitsInnerHTML()}</div>
    </div>
    <div class="home-card home-section">
      ${homeSectionHead('Journal', '<button class="home-pill-btn" data-home-addphoto>+ Add Photo</button>')}
      <div id="homeJournal">${homeJournalInnerHTML()}</div>
      <input type="file" id="homePhotoInput" accept="image/*" multiple style="position:absolute;left:-9999px;opacity:0;" />
    </div>
    <div class="home-card home-section">
      ${homeSectionHead('Recent Notes', '<span class="home-head-actions"><button class="home-pill-btn home-pill-btn--icon" data-home-newnote title="New note">+</button><button class="home-pill-btn" data-home-quicknotes>Scratchpad</button></span>')}
      <div id="homeNotes">${homeNotesInnerHTML()}</div>
    </div>
    <div class="home-card" id="homeWeek">${homeWeekSkeletonHTML()}</div>
  `;

  homeWireOnce();
  if (typeof homeBriefMount === 'function') homeBriefMount();
  if (typeof homeBriefLoad  === 'function') homeBriefLoad();
  hydrateHomeToday();
  hydrateHomeCalendar();
  hydrateHomeWeek();
}

// Greeting takes the page-title slot (other tabs show their name there); the FAB,
// search, and per-tool pill bars are hidden on Home. Asserted here so it's right
// on the bare initial load (when switchTool isn't called) and on switchTool('home').
function homeSyncChrome() {
  const pt = document.getElementById('pageTitle');
  if (pt) pt.textContent = homeGreetingText();
  document.getElementById('fabBtn')?.classList.add('hidden');
  document.getElementById('floatingSearch')?.classList.add('hidden');
  document.querySelectorAll('[data-tool-view]').forEach(elx => {
    if (elx.dataset.toolView !== 'home' && elx.classList.contains('pill-bar')) elx.style.display = 'none';
  });
}

function homeSectionHead(text, rightHtml) {
  return `<div class="home-section-head">
      <div class="home-section-title">${hEsc(text)}</div>
      ${rightHtml || ''}
    </div>`;
}

/* ── Card 1: Today (rings + mood) ─────────────────────────── */

function homeDateLabel() {
  const d = new Date();
  // e.g. "Today - Fri, May 22"
  return `Today - ${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}`;
}
function homeTodayCardHTML() {
  return `${homeSectionHead(homeDateLabel())}
    <div id="homeRingsRow"><div class="home-skeleton">Loading your numbers…</div></div>`;
}

function ringSvg(score, color) {
  const r = 34, c = 2 * Math.PI * r;
  const pct = score == null ? 0 : Math.max(0, Math.min(100, score)) / 100;
  const off = c * (1 - pct);
  return `<svg viewBox="0 0 80 80">
    <circle class="home-ring-track" cx="40" cy="40" r="${r}" fill="none" stroke-width="7"/>
    <circle cx="40" cy="40" r="${r}" fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round"
            stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" transform="rotate(-90 40 40)"/>
    <text class="home-ring-score" x="40" y="41" text-anchor="middle" dominant-baseline="central">${score == null ? '—' : Math.round(score)}</text>
  </svg>`;
}
// Per-metric latest available score. Sleep/readiness for "today" only finalize
// after the night, so the current day often has only activity — fall back to the
// most recent non-null value for each metric (e.g. last night's sleep/readiness
// + today's activity) and present them together as today's snapshot.
function homePickScore(oura, key) {
  const days = oura?.days || [];
  for (const d of days) if (d[key] != null) return d[key];
  return null;
}
// Latest non-null value for `key` plus the delta vs the previous reading (the
// next non-null day before it) — for the ↑/↓ trend under each ring.
function homePickTrend(oura, key) {
  const days = oura?.days || [];
  let cur = null, prev = null;
  for (const d of days) {
    if (d[key] == null) continue;
    if (cur === null) cur = d[key];
    else { prev = d[key]; break; }
  }
  return { cur, delta: (cur != null && prev != null) ? cur - prev : null };
}
function homeRingTrendHTML(delta) {
  if (delta == null) return '';
  if (delta === 0) return `<span class="home-ring-trend is-flat">±0</span>`;
  const up = delta > 0;
  return `<span class="home-ring-trend ${up ? 'is-up' : 'is-down'}">${up ? '↑' : '↓'}${Math.abs(delta)}</span>`;
}
function homeRingsRowHTML(oura) {
  if (!(oura?.days || []).length) return `<div class="home-empty">No Oura data yet — it syncs overnight.</div>`;
  const ring = (label, key, color) => {
    const { cur, delta } = homePickTrend(oura, key);
    return `<div class="home-ring">${ringSvg(cur, color)}<span class="home-ring-label">${label}</span>${homeRingTrendHTML(delta)}</div>`;
  };
  return `<div class="home-rings">
      ${ring('Sleep', 'sleep_score', HOME_RING_COLORS.sleep)}
      ${ring('Readiness', 'readiness_score', HOME_RING_COLORS.readiness)}
      ${ring('Activity', 'activity_score', HOME_RING_COLORS.activity)}
    </div>`;
}
function homeMoodRowHTML(entry) {
  // Picker stays as-is structurally — same 5 buttons. Each tap now
  // creates a check-in (handled in the click delegator), so there's no
  // single "selected" emoji anymore; we drop the .is-selected logic.
  const labels = homeMoodLabels(), emoji = homeMoodEmoji();
  const btns = emoji.map((e, i) => `
    <button class="home-mood-btn" data-home-mood="${i + 1}" title="Log check-in: ${labels[i] || ''}">
      <span>${e}</span><span class="home-mood-cap">${labels[i] || ''}</span>
    </button>`).join('');
  return `<div class="home-mood">${btns}</div>
    <div class="home-mood-checkins" id="homeMoodCheckins">${homeMoodCheckinsHTML(_homeMoodCheckins, entry)}</div>`;
}

// Today's check-in timeline + summary. Renders inline below the picker.
// Each chip: time · emoji · × (delete). Summary line: avg emoji · N.
function homeMoodCheckinsHTML(checkins, entry) {
  const list = Array.isArray(checkins) ? checkins.slice() : [];
  list.sort((a, b) => new Date(a.captured_at) - new Date(b.captured_at));
  const emoji = homeMoodEmoji();
  if (!list.length) {
    // Quiet empty state — keeps the card uncluttered when no check-ins
    // exist yet. The picker above is the obvious call-to-action.
    const dailyMood = entry?.mood;
    if (dailyMood) {
      return `<div class="home-mood-summary"><span class="home-mood-summary-label">Today</span> <span class="home-mood-summary-emoji">${emoji[dailyMood - 1]}</span></div>`;
    }
    return '';
  }
  const chips = list.map(c => {
    const t = new Date(c.captured_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const em = emoji[c.mood - 1] || '·';
    return `<span class="home-mood-chip">
      <span class="home-mood-chip-time">${hEsc(t)}</span>
      <span class="home-mood-chip-emoji">${em}</span>
      <button class="home-mood-chip-del" data-home-mood-checkin-delete="${hEsc(c.id)}" title="Remove this check-in">×</button>
    </span>`;
  }).join('');
  const avgRaw = list.reduce((s, c) => s + Number(c.mood), 0) / list.length;
  const avgIdx = Math.max(1, Math.min(5, Math.round(avgRaw)));
  const summary = `<div class="home-mood-summary">
    <span class="home-mood-summary-label">Today's mood</span>
    <span class="home-mood-summary-emoji">${emoji[avgIdx - 1]}</span>
    <span class="home-mood-summary-count">· ${list.length} check-in${list.length === 1 ? '' : 's'}</span>
  </div>`;
  return `<div class="home-mood-chips">${chips}</div>${summary}`;
}

// Compute the rounded average of the in-memory check-ins; null when none.
function homeMoodAvg() {
  const list = _homeMoodCheckins;
  if (!list || !list.length) return null;
  const sum = list.reduce((s, c) => s + Number(c.mood), 0);
  return Math.max(1, Math.min(5, Math.round(sum / list.length)));
}

// Pull today's check-ins (single .select). Called on Home mount.
// Filters by user_local "today" date range so DST + tz edges behave.
async function loadHomeMoodCheckins() {
  try {
    const today = homeToday();
    const startISO = new Date(today + 'T00:00:00').toISOString();
    const endISO   = new Date(today + 'T23:59:59.999').toISOString();
    const { data, error } = await db.from('mood_checkins')
      .select('id, captured_at, mood')
      .gte('captured_at', startISO)
      .lte('captured_at', endISO)
      .order('captured_at', { ascending: true });
    if (error) throw error;
    _homeMoodCheckins = data || [];
  } catch (e) {
    console.warn('[home] loadHomeMoodCheckins failed', e);
    _homeMoodCheckins = [];
  }
}

// Insert a check-in + recompute today's daily mood. Patches in-memory
// state + repaints the mood subsection. Calls homeBriefRecompute so any
// mood reference in the brief recap refreshes inline.
async function insertMoodCheckin(value) {
  const v = parseInt(value, 10);
  if (!Number.isFinite(v) || v < 1 || v > 5) return;
  try {
    const { data: { session } } = await db.auth.getSession();
    if (!session) return;
    const captured_at = new Date().toISOString();
    const { data, error } = await db.from('mood_checkins')
      .insert({ user_id: session.user.id, captured_at, mood: v })
      .select('id, captured_at, mood')
      .single();
    if (error) throw error;
    _homeMoodCheckins.push(data);
    await syncDailyMoodFromCheckins();
    repaintHomeMoodRow();
  } catch (e) {
    console.warn('[home] insertMoodCheckin failed', e);
  }
}

async function deleteMoodCheckin(id) {
  if (!id) return;
  try {
    const { error } = await db.from('mood_checkins').delete().eq('id', id);
    if (error) throw error;
    _homeMoodCheckins = _homeMoodCheckins.filter(c => c.id !== id);
    await syncDailyMoodFromCheckins();
    repaintHomeMoodRow();
  } catch (e) {
    console.warn('[home] deleteMoodCheckin failed', e);
  }
}

// Recompute today's daily mood from in-memory check-ins and upsert into
// journal_entries.mood. NULL when there are no check-ins (rather than
// leaving a stale average sitting around).
async function syncDailyMoodFromCheckins() {
  const today = homeToday();
  const avg = homeMoodAvg();
  // Use the existing saveJournalEntry path so the journalState cache
  // also updates (the day card / brief recompute both read from there).
  if (typeof saveJournalEntry === 'function') {
    await saveJournalEntry(today, { mood: avg });
  }
  // Tier-1: brief recap mood label refreshes from journalState.
  if (typeof homeBriefRecompute === 'function') homeBriefRecompute();
}

// Repaint just the picker + check-ins block (not the whole Journal card,
// to avoid clobbering an in-progress reflection / learning textarea).
function repaintHomeMoodRow() {
  const today = homeToday();
  const entry = (typeof journalState !== 'undefined') ? journalState.entries.get(today) : null;
  const moodEl = document.getElementById('homeMoodRow');
  if (moodEl) moodEl.innerHTML = homeMoodRowHTML(entry);
}

/* ── Section bodies (Calendar · Tasks · Habits · Notes) ───── */

function _fmtEventTime(ev) {
  if (ev.isAllDay) return 'All day';
  if (!ev.start) return '';
  const d = new Date(ev.start);
  return isNaN(d) ? '' : d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
function homeCalendarInnerHTML(events, expired) {
  if (expired) {
    return `<div class="home-empty">Connect Google Calendar to see today's events.</div>
      <button class="home-cta" data-home-cta="settings">Connect Google Calendar →</button>`;
  }
  if (!events || !events.length) return `<div class="home-empty">Nothing on the calendar today.</div>`;
  return `<div class="home-item-list">${events.map(ev => `<div class="home-row">
      <span class="home-cal-time ${ev.isAllDay ? 'is-allday' : 'is-timed'}">${hEsc(_fmtEventTime(ev))}</span>
      <span class="home-item-title">${hEsc(ev.summary || '(no title)')}</span>
    </div>`).join('')}</div>`;
}

// Condensed task cards: same .card.task-item chrome as the Tasks tab (incl. the
// red priority strip), no attribute tags, and clicking the body opens the edit
// modal (open-edit) — all wired through the global data-task-action handler.
function homeTaskCardHTML(t) {
  const cardCls = ['card', 'task-item'];
  if (t.top3) cardCls.push('top3', 'is-priority');
  if (t.done) cardCls.push('done', 'is-done');
  const title = (typeof linkify === 'function') ? linkify(t.text) : hEsc(t.text || '');
  // Due badge sits to the LEFT of the complete button (Home only; the Tasks
  // tab keeps its own layout). Inline-flex wrapper keeps it vertically
  // centered with the checkbox.
  const dueHtml = (t.due && typeof dueBadgeHTML === 'function')
    ? `<span class="home-task-due-inline">${dueBadgeHTML(t.due)}</span>`
    : '';
  return `<div class="task-group"><div class="${cardCls.join(' ')}" id="ti-${t.id}" data-id="${t.id}">
      <span class="strip" data-task-action="toggle-top3" title="Toggle priority"></span>
      <div class="card-head">
        <div class="card-body task-content" data-task-action="open-edit">
          <div class="card__title task-text">${title}</div>
        </div>
        ${dueHtml}
        <button class="check checkbox" data-task-action="toggle-done" aria-label="${t.done ? 'Reopen' : 'Complete'}">
          <svg width="9" height="7" viewBox="0 0 10 8" fill="none"><path d="M1 4L3.5 6.5L9 1" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>
        </button>
      </div>
    </div></div>`;
}

// Bucket open tasks into Overdue / Due today / Priority (in that precedence — a
// task only appears in one bucket). Top3 tasks that also have due<=today land in
// Overdue or Due today (the priority strip still renders on those rows).
function homeTaskBuckets() {
  const all = (typeof tasks !== 'undefined' && Array.isArray(tasks)) ? tasks : [];
  const today = homeToday();
  const overdue  = all.filter(t => !t.done && t.due && t.due < today);
  const dueToday = all.filter(t => !t.done && t.due === today);
  // Don't double-count: tasks in earlier buckets are excluded by date semantics
  // (due < today vs due === today are mutually exclusive), so priority filter
  // only needs to exclude what's already in overdue/dueToday by identity.
  const inEarlier = new Set([...overdue, ...dueToday]);
  const priority = all.filter(t => !t.done && t.top3 && !inEarlier.has(t));
  return { overdue, dueToday, priority };
}

function homeTasksInnerHTML() {
  const { overdue, dueToday, priority } = homeTaskBuckets();
  const doneToday = (typeof getCompletedTasksForDate === 'function') ? getCompletedTasksForDate(homeToday()) : [];
  const bucket = (label, arr) => arr.length
    ? `<div class="home-subsection">
         <div class="home-subsection-h">${label}</div>
         ${arr.map(t => homeTaskCardHTML(t)).join('')}
       </div>`
    : '';
  const activeHtml = (overdue.length || dueToday.length || priority.length)
    ? `${bucket('Priority', priority)}${bucket('Due today', dueToday)}${bucket('Overdue', overdue)}`
    : `<div class="home-empty">No priority tasks. Tap + to add one, or star tasks in the Tasks tab.</div>`;
  const doneHtml = doneToday.length
    ? `<div class="home-done-toggle" data-home-done-toggle role="button" tabindex="0">
        <span class="home-done-label">FINISHED TODAY <span class="home-done-pill">${doneToday.length}</span></span>
        <svg class="home-done-arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
      <div class="home-tasks-done" id="homeTasksDone" hidden>${doneToday.map(t => homeTaskCardHTML(t)).join('')}</div>`
    : '';
  return activeHtml + doneHtml;
}

function homeHabitsMeta() {
  const today = homeToday();
  const active = (typeof habitsArr !== 'undefined' && Array.isArray(habitsArr)) ? habitsArr.filter(h => !h.archived) : [];
  const due = (typeof isHabitDueToday === 'function') ? active.filter(h => isHabitDueToday(h)) : active;
  if (!due.length) return '';
  const done = (typeof isCompletedOn === 'function') ? due.filter(h => isCompletedOn(h.id, today)).length : 0;
  return `${done} of ${due.length} done`;
}
function homeHabitsInnerHTML() {
  const today = homeToday();
  const active = (typeof habitsArr !== 'undefined' && Array.isArray(habitsArr)) ? habitsArr.filter(h => !h.archived) : [];
  const due = (typeof isHabitDueToday === 'function') ? active.filter(h => isHabitDueToday(h)) : active;
  if (!active.length) return `<div class="home-empty">No habits yet. Start one in Habits.</div>`;
  if (!due.length) return `<div class="home-empty">Nothing scheduled today — nice.</div>`;
  const esc = (typeof escHTML === 'function') ? escHTML : hEsc;
  return due.map(h => {
    const isDone = (typeof isCompletedOn === 'function') && isCompletedOn(h.id, today);
    const streak = (typeof computeStreak === 'function') ? computeStreak(h.id) : 0;
    const streakHtml = streak > 0 ? `<span class="home-habit-streak">🔥 ${streak}</span>` : '';
    return `<div class="home-row${isDone ? ' is-done' : ''}">
        <span class="home-hrow-emoji">${esc(h.emoji || '•')}</span>
        <span class="home-item-title">${esc(h.name || '')}</span>
        ${streakHtml}
        <button class="home-check${isDone ? ' checked' : ''}" data-habit-action="toggle-complete" data-habit-id="${h.id}" data-habit-date="${today}" title="${isDone ? 'Undo' : 'Mark done'}">
          <svg width="9" height="7" viewBox="0 0 10 8" fill="none"><path d="M1 4L3.5 6.5L9 1" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>
        </button>
      </div>`;
  }).join('');
}

/* ── Card 3: Recent notes (+ Quick Notes) ─────────────────── */

function homeNotesInnerHTML() {
  const SC = (typeof SCRATCH_ID !== 'undefined') ? SCRATCH_ID : -1;
  const all = (typeof notesArr !== 'undefined' && Array.isArray(notesArr)) ? notesArr.filter(n => !n.trashed && n.id !== SC) : [];
  const recent = all.slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 3);
  const fmt = (typeof formatNoteDate === 'function') ? formatNoteDate : (s => s || '');
  if (!recent.length) return `<div class="home-empty">No notes yet — capture a thought.</div>`;
  return `<div class="home-item-list">${recent.map(n => `<div class="home-row home-note-card" data-home-note="${n.id}">
      <span class="home-item-title home-note-title-link">${hEsc(n.title || 'Untitled')}</span>
      <span class="home-trow-meta">${hEsc(fmt(n.updatedAt))}</span>
    </div>`).join('')}</div>`;
}

/* ── Journal quick-capture (single-line tap target) ───────── */

function homeJournalInnerHTML(entry) {
  const today = homeToday();
  const e = entry || ((typeof journalState !== 'undefined') ? journalState.entries.get(today) : null);
  const text = e?.reflections || '';
  const learning = e?.learning || '';
  const esc = (typeof escapeHtml === 'function') ? escapeHtml : hEsc;
  return `<div class="home-subsection">
      <div class="home-subsection-h">Daily Reflection</div>
      <textarea class="home-journal-input" id="homeJournalInput" placeholder="Reflect on today…" spellcheck="true" rows="1">${esc(text)}</textarea>
    </div>
    <div class="home-subsection">
      <div class="home-subsection-h">Today I Learned</div>
      <textarea class="home-journal-input" id="homeLearningInput" placeholder="One thing you learned today…" spellcheck="true" rows="1">${esc(learning)}</textarea>
    </div>
    <div class="home-subsection">
      <div class="home-subsection-h">Mood</div>
      <div class="home-journal-mood"><div id="homeMoodRow">${homeMoodRowHTML(e)}</div></div>
    </div>`;
}
function homeAutoGrow(el) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

/* ── Card 4: Last 7 Days ──────────────────────────────────── */

function homeWeekSkeletonHTML() {
  return homeSectionHead('Last 7 Days') + `<div class="home-skeleton">Loading…</div>`;
}
// Average a metric over `count` days starting at `startIdx` of the (newest-first)
// days array; null when no data in that window.
function homeWeekAvg(days, key, startIdx, count) {
  const vals = [];
  for (let i = startIdx; i < startIdx + count && i < days.length; i++) {
    if (days[i] && days[i][key] != null) vals.push(days[i][key]);
  }
  return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
}
function homeWeekInnerHTML(oura, entriesByDate) {
  const today = homeToday();
  const days = (oura?.days || []);   // newest first, up to 14
  const emoji = homeMoodEmoji();

  // Avg mood across the last 7 days' journal entries.
  let avgHtml = '';
  const moods = [];
  for (let i = 0; i < 7; i++) {
    const d = (typeof jShiftDays === 'function') ? jShiftDays(today, -i) : today;
    const m = entriesByDate.get(d)?.mood;
    if (m) moods.push(m);
  }
  if (moods.length) {
    const avg = Math.round(moods.reduce((a, b) => a + b, 0) / moods.length);
    avgHtml = `<span class="home-week-avg">Avg mood ${emoji[avg - 1]}</span>`;
  }

  // Per-metric 7-day average + week-over-week delta (this 7 vs prior 7).
  const stat = (label, key, color) => {
    const cur = homeWeekAvg(days, key, 0, 7);
    const prev = homeWeekAvg(days, key, 7, 7);
    let delta = '';
    if (cur != null && prev != null) {
      const d = cur - prev;
      const cls = d > 0 ? 'is-up' : d < 0 ? 'is-down' : 'is-flat';
      delta = `<div class="home-stat-delta ${cls}">${d > 0 ? '+' : ''}${d} wk</div>`;
    }
    return `<div class="home-stat">
        <div class="home-stat-label">${label}</div>
        <div class="home-stat-num" style="color:${color}">${cur == null ? '—' : cur}</div>
        ${delta}
      </div>`;
  };
  const stats = `<div class="home-stats">
      ${stat('SLEEP', 'sleep_score', HOME_RING_COLORS.sleep)}
      ${stat('READINESS', 'readiness_score', HOME_RING_COLORS.readiness)}
      ${stat('ACTIVITY', 'activity_score', HOME_RING_COLORS.activity)}
    </div>`;
  // Daily breakdown — newest first, with a header and an AVG footer row.
  const ouraByDate = new Map();
  days.forEach(d => ouraByDate.set(d.date, d));
  const cell = (v, color) => `<span class="hw-col"${v == null ? '' : ` style="color:${color}"`}>${v == null ? '—' : v}</span>`;
  const head = `<div class="hw-row hw-head">
      <span class="hw-day hw-h">Day</span>
      <span class="hw-mood hw-h">Mood</span>
      <span class="hw-col" style="color:${HOME_RING_COLORS.sleep}">Slp</span>
      <span class="hw-col" style="color:${HOME_RING_COLORS.readiness}">Rdy</span>
      <span class="hw-col" style="color:${HOME_RING_COLORS.activity}">Act</span>
    </div>`;
  const dayRows = [];
  for (let i = 0; i < 7; i++) {
    const d = (typeof jShiftDays === 'function') ? jShiftDays(today, -i) : today;
    const o = ouraByDate.get(d) || {};
    const m = entriesByDate.get(d)?.mood;
    const wd = (d === today) ? 'Today' : new Date(d + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short' });
    dayRows.push(`<div class="hw-row">
        <span class="hw-day">${hEsc(wd)}</span>
        <span class="hw-mood">${m ? emoji[m - 1] : ''}</span>
        ${cell(o.sleep_score, HOME_RING_COLORS.sleep)}
        ${cell(o.readiness_score, HOME_RING_COLORS.readiness)}
        ${cell(o.activity_score, HOME_RING_COLORS.activity)}
      </div>`);
  }
  const table = `<div class="home-week-table">${head}${dayRows.join('')}</div>`;
  return homeSectionHead('Last 7 Days', avgHtml) + stats + table;
}

/* ── Hydration ────────────────────────────────────────────── */

async function hydrateHomeToday() {
  // Health rings (gated by selected source + connection).
  const ringsEl = () => document.getElementById('homeRingsRow');
  const source = homeHealthSource();
  if (source === 'whoop') {
    const msg = homeWhoopConnected() ? 'Whoop rings on Home are coming soon.' : 'Connect Whoop to track your health on Home.';
    const cta = homeWhoopConnected() ? '' : '<button class="home-cta" data-home-cta="settings">Connect Whoop →</button>';
    if (ringsEl()) ringsEl().innerHTML = `<div class="home-empty">${msg}</div>${cta}`;
  } else if (!homeOuraConnected()) {
    if (ringsEl()) ringsEl().innerHTML = `<div class="home-empty">Connect your Oura Ring to see sleep, readiness, and activity.</div>
      <button class="home-cta" data-home-cta="settings">Connect Oura →</button>`;
  } else {
    const oura = await loadOuraScores();
    if (ringsEl()) ringsEl().innerHTML = homeRingsRowHTML(oura);
  }
  // Phase 5 — intra-day mood check-ins. Single fetch on mount.
  // Patched in-place by insert/delete handlers; daily journal mood is
  // kept in sync via syncDailyMoodFromCheckins().
  await loadHomeMoodCheckins();

  // Journal reflection + mood (today's journal entry).
  if (typeof loadJournalEntry === 'function') {
    const entry = await loadJournalEntry(homeToday());
    // Prefill the reflection box + mood row once loaded. Don't clobber the
    // textarea while typing — in that case just repaint the mood row.
    const ji = document.getElementById('homeJournalInput');
    const li = document.getElementById('homeLearningInput');
    const activelyTyping = (ji && document.activeElement === ji) || (li && document.activeElement === li);
    if (!activelyTyping) {
      refreshHomeSection('homeJournal', homeJournalInnerHTML(entry));
      homeAutoGrow(document.getElementById('homeJournalInput'));
      homeAutoGrow(document.getElementById('homeLearningInput'));
    } else {
      const moodEl = document.getElementById('homeMoodRow');
      if (moodEl) moodEl.innerHTML = homeMoodRowHTML(entry);
    }
  }
}

async function hydrateHomeCalendar() {
  if (!document.getElementById('homeCalendar')) return;
  const today = homeToday();
  let events = [];
  if (typeof fetchCalendarEventsForDate === 'function') events = await fetchCalendarEventsForDate(today);
  const expired = typeof journalState !== 'undefined' && journalState.eventsError && journalState.eventsError.get(today) === 'expired';
  const el = document.getElementById('homeCalendar');
  if (el) el.innerHTML = homeCalendarInnerHTML(events, expired);
}

async function hydrateHomeWeek() {
  if (!document.getElementById('homeWeek')) return;
  const today = homeToday();
  const start = (typeof jShiftDays === 'function') ? jShiftDays(today, -6) : today;
  if (typeof loadJournalRange === 'function') { try { await loadJournalRange(start, today); } catch (_) {} }
  const oura = homeOuraConnected() && homeHealthSource() === 'oura' ? await loadOuraScores() : null;
  const entriesByDate = (typeof journalState !== 'undefined') ? journalState.entries : new Map();
  const el = document.getElementById('homeWeek');
  if (el) el.innerHTML = homeWeekInnerHTML(oura, entriesByDate);
}

/* ── Section refresh hook (render/renderHabits/renderNotes) ── */

function refreshHomeSection(id, html) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}
function refreshHomeData() {
  if (typeof activeTool === 'undefined' || activeTool !== 'home') return;
  if (!document.getElementById('homeContainer')) return;
  refreshHomeSection('homeTasks', homeTasksInnerHTML());
  refreshHomeSection('homeHabits', homeHabitsInnerHTML());
  const hm = document.getElementById('homeHabitsMeta'); if (hm) hm.textContent = homeHabitsMeta();
  refreshHomeSection('homeNotes', homeNotesInnerHTML());
}

/* ── In-page modals: note editor + Quick Notes ────────────── */

let _homeNoteQuill = null, _homeNoteId = null, _homeNoteSaveTimer = null;

function openHomeNoteModal(noteId) {
  if (typeof notesArr === 'undefined') return;
  const note = notesArr.find(n => n.id === noteId);
  if (!note) return;
  closeHomeNoteModal(true);
  _homeNoteId = noteId;
  const html = `
    <div class="home-modal-overlay" id="homeNoteModal">
      <div class="home-modal home-modal--editor">
        <div class="home-modal-head">
          <input id="homeNoteTitle" class="home-note-title" placeholder="Untitled" value="${hEsc(note.title || '')}" />
          <button class="home-modal-close" data-home-modal-close="note" title="Close">×</button>
        </div>
        <div class="home-modal-body ne-quill">
          ${typeof renderCustomToolbar === 'function' ? renderCustomToolbar('homeNoteToolbar') : ''}
          <div id="homeNoteQuill"></div>
        </div>
      </div>
    </div>`;
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  document.body.appendChild(wrap.firstElementChild);
  document.body.style.overflow = 'hidden';
  requestAnimationFrame(() => document.getElementById('homeNoteModal')?.classList.add('open'));

  const cont = document.getElementById('homeNoteQuill');
  if (cont && typeof createQuillEditor === 'function') {
    _homeNoteQuill = createQuillEditor(cont, { placeholder: 'Write…', toolbarContainer: '#homeNoteToolbar' });
    if (_homeNoteQuill) {
      let saved = note.content || '';
      if (typeof migrateLegacyChecklistHTML === 'function') saved = migrateLegacyChecklistHTML(saved);
      if (saved) _homeNoteQuill.clipboard.dangerouslyPasteHTML(saved, 'silent');
      _homeNoteQuill.on('text-change', (_d, _o, src) => { if (src === 'user') homeNoteSave(); });
      _homeNoteQuill.root.addEventListener('click', e => {
        const a = e.target.closest('a'); if (a && a.href) { e.preventDefault(); window.open(a.href, '_blank', 'noopener'); }
      });
    }
  }
  document.getElementById('homeNoteTitle')?.addEventListener('input', homeNoteSave);
  setTimeout(() => document.getElementById('homeNoteTitle')?.focus(), 60);
}
function homeNoteSave() {
  if (typeof notesArr === 'undefined') return;
  const note = notesArr.find(n => n.id === _homeNoteId);
  if (!note) return;
  const titleEl = document.getElementById('homeNoteTitle');
  if (titleEl) note.title = titleEl.value;
  if (_homeNoteQuill) note.content = _homeNoteQuill.root.innerHTML;
  note.updatedAt = new Date().toISOString();
  if (_homeNoteSaveTimer) clearTimeout(_homeNoteSaveTimer);
  _homeNoteSaveTimer = setTimeout(() => { if (typeof saveNoteToDB === 'function') saveNoteToDB(note); }, 700);
}
function closeHomeNoteModal(skip) {
  if (_homeNoteSaveTimer) { clearTimeout(_homeNoteSaveTimer); _homeNoteSaveTimer = null; }
  const note = (typeof notesArr !== 'undefined') ? notesArr.find(n => n.id === _homeNoteId) : null;
  if (note && typeof saveNoteToDB === 'function') saveNoteToDB(note);
  _homeNoteQuill = null; _homeNoteId = null;
  document.getElementById('homeNoteModal')?.remove();
  if (!skip) {
    document.body.style.overflow = '';
    refreshHomeSection('homeNotes', homeNotesInnerHTML());
  }
}
function homeCreateNote() {
  if (typeof notesArr === 'undefined') return;
  const note = {
    id: Date.now(), title: '', content: '', notebookId: null, tags: [],
    starred: false, trashed: false, trashedAt: null, order: notesArr.length,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  notesArr.unshift(note);
  if (typeof saveNoteToDB === 'function') saveNoteToDB(note);
  openHomeNoteModal(note.id);
}

function openQuickNotesModal() {
  if (document.getElementById('homeQuickNotesModal')) return;
  const html = `
    <div class="home-modal-overlay" id="homeQuickNotesModal">
      <div class="home-modal home-modal--editor">
        <div class="home-modal-head">
          <span class="home-modal-title">Scratchpad</span>
          <button class="home-modal-close" data-home-modal-close="quicknotes" title="Close">×</button>
        </div>
        <div class="home-modal-body"><div id="scratchEditorContent"></div></div>
      </div>
    </div>`;
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  document.body.appendChild(wrap.firstElementChild);
  document.body.style.overflow = 'hidden';
  requestAnimationFrame(() => document.getElementById('homeQuickNotesModal')?.classList.add('open'));
  if (typeof renderScratch === 'function') renderScratch();
}
function closeQuickNotesModal() {
  if (typeof scratchNote !== 'undefined' && typeof saveNoteToDB === 'function') saveNoteToDB(scratchNote);
  document.getElementById('homeQuickNotesModal')?.remove();
  document.body.style.overflow = '';
}

/* ── Event wiring ─────────────────────────────────────────── */

function homeWireOnce() {
  if (_homeWired) return;
  _homeWired = true;

  document.addEventListener('click', e => {
    const mc = e.target.closest('[data-home-modal-close]');
    if (mc) {
      if (mc.dataset.homeModalClose === 'note') closeHomeNoteModal();
      else if (mc.dataset.homeModalClose === 'quicknotes') closeQuickNotesModal();
      return;
    }
    if (e.target.id === 'homeNoteModal') { closeHomeNoteModal(); return; }
    if (e.target.id === 'homeQuickNotesModal') { closeQuickNotesModal(); return; }

    const container = document.getElementById('homeContainer');
    if (activeTool !== 'home' || !container) return;

    // Task-card actions: the Tasks-tab handler is bound to #taskContainer, so it
    // never fires for Home's cards. Dispatch them here to the global task fns.
    const taEl = e.target.closest('[data-task-action]');
    if (taEl && container.contains(taEl)) {
      const action = taEl.dataset.taskAction;
      if (action === 'open-create') { if (typeof openCreatePanel === 'function') openCreatePanel(); return; }
      const card = taEl.closest('.task-item');
      const tid = card ? parseInt(card.dataset.id, 10) : null;
      if (tid != null) {
        if (action === 'toggle-done' && typeof toggleDone_t === 'function') toggleDone_t(tid);
        else if (action === 'toggle-top3' && typeof toggleTop3 === 'function') toggleTop3(tid);
        else if (action === 'open-edit' && typeof openEdit === 'function') openEdit(tid);
      }
      return;
    }

    const doneToggle = e.target.closest('[data-home-done-toggle]');
    if (doneToggle) {
      const list = document.getElementById('homeTasksDone');
      if (list) { list.hidden = !list.hidden; doneToggle.classList.toggle('is-open', !list.hidden); }
      return;
    }

    if (e.target.closest('[data-home-cta="settings"]')) { switchTool('settings'); return; }
    const go = e.target.closest('[data-home-go]');
    if (go) { switchTool(go.dataset.homeGo); return; }
    const noteEl = e.target.closest('[data-home-note]');
    if (noteEl) { openHomeNoteModal(parseInt(noteEl.dataset.homeNote, 10)); return; }
    if (e.target.closest('[data-home-addphoto]')) { document.getElementById('homePhotoInput')?.click(); return; }
    if (e.target.closest('[data-home-newnote]')) { homeCreateNote(); return; }
    if (e.target.closest('[data-home-quicknotes]')) { openQuickNotesModal(); return; }

    // Phase 5 — intra-day mood check-in. Tapping an emoji creates a
    // new check-in at the current timestamp (no toggle/deselect — each
    // tap is a fresh log). The daily journal_entries.mood is recomputed
    // as the rounded average of today's check-ins.
    const moodEl = e.target.closest('[data-home-mood]');
    if (moodEl) {
      const val = parseInt(moodEl.dataset.homeMood, 10);  // 1–5
      insertMoodCheckin(val);
      return;
    }
    const moodDelEl = e.target.closest('[data-home-mood-checkin-delete]');
    if (moodDelEl) {
      deleteMoodCheckin(moodDelEl.dataset.homeMoodCheckinDelete);
      return;
    }
    // Tasks (data-task-action) and habits (data-habit-action) are handled by
    // their own global delegated listeners; render()/renderHabits() then call
    // refreshHomeData to repaint the Home sections.
  });

  // Inline journal reflection + Today I Learned — edits save straight to today's
  // journal entry (same scheduleSave path as the Journal tab) and the box
  // auto-grows.
  document.addEventListener('input', e => {
    if (e.target.id === 'homeJournalInput') {
      const today = homeToday();
      const val = e.target.value;
      if (typeof journalState !== 'undefined') {
        const entry = journalState.entries.get(today) || { entry_date: today, reflections: '', mood: null, photos: [], learning: '' };
        journalState.entries.set(today, { ...entry, reflections: val });
      }
      if (typeof scheduleSave === 'function') scheduleSave(today, { reflections: val });
      homeAutoGrow(e.target);
      return;
    }
    if (e.target.id === 'homeLearningInput') {
      const today = homeToday();
      const val = e.target.value;
      if (typeof journalState !== 'undefined') {
        const entry = journalState.entries.get(today) || { entry_date: today, reflections: '', mood: null, photos: [], learning: '' };
        journalState.entries.set(today, { ...entry, learning: val });
      }
      if (typeof scheduleSave === 'function') scheduleSave(today, { learning: val });
      homeAutoGrow(e.target);
      return;
    }
  });

  // Add Photo — funnels into the Journal entry's photos for today via the same
  // helper the Journal tab uses; photos show up in the Journal tab.
  document.addEventListener('change', async e => {
    if (e.target.id !== 'homePhotoInput') return;
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length && typeof addPhotosFromCardFiles === 'function') {
      await addPhotosFromCardFiles(files, homeToday());
    }
  });

  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (document.getElementById('homeNoteModal')) closeHomeNoteModal();
    else if (document.getElementById('homeQuickNotesModal')) closeQuickNotesModal();
  });
}

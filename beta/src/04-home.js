/* ══════════════════════════════════════════════════════════════
   HOME — daily brief (beta-only). The default tab on load.
   Aggregates existing domains; reuses their data + helpers:
     - greeting/mood/calendar/finished-today  → beta/src/03-journal.js
     - tasks (top3, toggleDone_t)             → beta/src/01-core.js + /src/*
     - habits (isHabitDueToday, toggle)       → /src/03-habits-core.js
     - notes (notesArr) + Quill editor        → /src/06-notes.js, /src/12-quill-init.js
     - Quick Notes (renderScratch)            → /src/07-scratch.js
   Oura rings read oura_daily directly via the oura_daily_select_own RLS policy.

   Layout: single column, every row full width. The greeting acts as the page
   title (the topbar "Home" title is blanked on Home). Quick-add, note editing,
   and Quick Notes all open in-page modals — Home never navigates to another tab.
═══════════════════════════════════════════════════════════════ */

const HOME_RING_COLORS = { sleep: '#6b4862', readiness: '#a37826', activity: '#5e6d3f' };

let _homeOura = null;
let _homeOuraInflight = null;
let _homeWired = false;

function homeToday() {
  return (typeof jToday === 'function') ? jToday() : new Date().toISOString().slice(0, 10);
}
function homeYesterday() {
  return (typeof jShiftDays === 'function') ? jShiftDays(homeToday(), -1) : null;
}
function hEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function homeOuraConnected() {
  return !!(typeof userSettings !== 'undefined' && userSettings?.integrations?.oura?.connected);
}
function homeWhoopConnected() {
  return !!(typeof userSettings !== 'undefined' && userSettings?.integrations?.whoop?.connected);
}
function homeHealthSource() {
  if (typeof getHealthSource === 'function') return getHealthSource();
  return (typeof userSettings !== 'undefined' && userSettings?.integrations?.health_source === 'whoop') ? 'whoop' : 'oura';
}
function homeHealthNoticeHTML(title, msg, ctaLabel) {
  const cta = ctaLabel ? `<button class="home-cta" data-home-cta="settings">${hEsc(ctaLabel)} →</button>` : '';
  return `<div class="home-card-head"><h3 class="home-card-title">${hEsc(title)}</h3></div>
    <div class="home-empty">${hEsc(msg)}</div>${cta}`;
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
        .limit(7);
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

/* ── Greeting ─────────────────────────────────────────────── */

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
function homeDateLabel() {
  return new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

/* ── Top-level render ─────────────────────────────────────── */

function renderHome() {
  const el = document.getElementById('homeContainer');
  if (!el) return;
  _homeOura = null;
  homeSyncChrome();

  el.innerHTML = `
    ${homeGreetingHTML()}
    <div class="home-row"><div class="home-card" id="homeRings">${homeRingsSkeletonHTML()}</div></div>
    <div class="home-row"><div class="home-card" id="homeTasks">${homeTasksHTML()}</div></div>
    <div class="home-row"><div class="home-card" id="homeCalendar">${homeCalendarSkeletonHTML()}</div></div>
    <div class="home-row"><div class="home-card" id="homeMood">${homeMoodHTML(null, null)}</div></div>
    <div class="home-row"><div class="home-card" id="homeHabits">${homeHabitsHTML()}</div></div>
    <div class="home-row"><div class="home-card" id="homeNotes">${homeNotesHTML()}</div></div>
    <div class="home-row"><div class="home-card" id="homeTrend">${homeTrendSkeletonHTML()}</div></div>
  `;

  homeWireOnce();
  hydrateHomeRingsAndTrend();
  hydrateHomeCalendar();
  hydrateHomeMood();
}

// Home is the default tab but switchTool isn't called on the bare initial load,
// so its chrome (page title, FAB, search, per-tool pill bars) must be asserted
// here — covering both first paint and switchTool('home').
function homeSyncChrome() {
  const pt = document.getElementById('pageTitle');
  if (pt) pt.textContent = '';                              // greeting is the heading
  document.getElementById('fabBtn')?.classList.add('hidden');
  document.getElementById('floatingSearch')?.classList.add('hidden');
  document.querySelectorAll('[data-tool-view]').forEach(elx => {
    if (elx.dataset.toolView !== 'home' && elx.classList.contains('pill-bar')) elx.style.display = 'none';
  });
}

function homeGreetingHTML() {
  return `
    <div class="home-greeting">
      <div class="home-greeting-text">
        <h1 class="home-greeting-title">${hEsc(homeGreetingText())}</h1>
        <div class="home-subtitle">${hEsc(homeDateLabel())}</div>
      </div>
      <button class="home-quickadd-btn" id="homeQuickAddBtn">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Quick add
      </button>
      <div class="home-quickadd-menu" id="homeQuickAddMenu">
        <button class="home-quickadd-item" data-home-add="task">📋 Add task</button>
        <button class="home-quickadd-item" data-home-add="journal">📓 Today's journal entry</button>
        <button class="home-quickadd-item" data-home-add="note">📝 Add note</button>
      </div>
    </div>`;
}

/* ── Rings (Oura) ─────────────────────────────────────────── */

function homeRingsSkeletonHTML() {
  return `<div class="home-card-head"><h3 class="home-card-title">Today</h3></div>
    <div class="home-skeleton">Loading your numbers…</div>`;
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
// Assumes Oura source is selected + connected (gated by hydrateHomeRingsAndTrend).
function homeRingsContentHTML(oura) {
  const latest = oura?.days?.[0];
  if (!latest) {
    return `<div class="home-card-head"><h3 class="home-card-title">Today</h3></div>
      <div class="home-empty">No Oura data yet — it syncs overnight.</div>`;
  }
  const stale = latest.date && latest.date !== homeToday();
  const asOf = stale && typeof jFormatShort === 'function'
    ? `<span class="home-card-meta">as of ${hEsc(jFormatShort(latest.date))}</span>`
    : '';
  const ring = (label, score, color) => `
    <div class="home-ring">${ringSvg(score, color)}<span class="home-ring-label">${label}</span></div>`;
  return `<div class="home-card-head"><h3 class="home-card-title">Today</h3>${asOf}</div>
    <div class="home-rings">
      ${ring('Sleep', latest.sleep_score, HOME_RING_COLORS.sleep)}
      ${ring('Readiness', latest.readiness_score, HOME_RING_COLORS.readiness)}
      ${ring('Activity', latest.activity_score, HOME_RING_COLORS.activity)}
    </div>`;
}

/* ── This-week trend ──────────────────────────────────────── */

function homeTrendSkeletonHTML() {
  return `<div class="home-card-head"><h3 class="home-card-title">This week</h3></div>
    <div class="home-skeleton">Loading trend…</div>`;
}
function _trendLine(days, key, color) {
  const n = days.length;
  const pts = days.map((d, i) => {
    const v = d[key];
    if (v == null) return null;
    const x = n === 1 ? 150 : 10 + i * (280 / (n - 1));
    const y = 90 - (Math.max(0, Math.min(100, v)) / 100) * 80;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).filter(Boolean);
  if (!pts.length) return '';
  return `<polyline fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="${pts.join(' ')}"/>`;
}
function homeTrendContentHTML(oura) {
  const head = `<div class="home-card-head"><h3 class="home-card-title">This week</h3></div>`;
  const days = (oura?.days || []).slice().reverse();
  if (days.length < 2) {
    return head + `<div class="home-empty">Not enough data for a trend yet.</div>`;
  }
  return head + `
    <div class="home-trend">
      <svg viewBox="0 0 300 100" preserveAspectRatio="none">
        ${_trendLine(days, 'sleep_score', HOME_RING_COLORS.sleep)}
        ${_trendLine(days, 'readiness_score', HOME_RING_COLORS.readiness)}
        ${_trendLine(days, 'activity_score', HOME_RING_COLORS.activity)}
      </svg>
    </div>
    <div class="home-trend-legend">
      <span><i style="background:${HOME_RING_COLORS.sleep}"></i>Sleep</span>
      <span><i style="background:${HOME_RING_COLORS.readiness}"></i>Readiness</span>
      <span><i style="background:${HOME_RING_COLORS.activity}"></i>Activity</span>
    </div>`;
}

/* ── Today's Tasks (+ finished today) ─────────────────────── */

function homeTaskRow(t, done) {
  const today = homeToday();
  const meta = (!done && t.due && typeof dueBadgeHTML === 'function') ? dueBadgeHTML(t.due) : '';
  return `<div class="home-trow${done ? ' is-done' : ''}">
      <button class="home-check${done ? ' checked' : ''}" data-home-task="${t.id}" title="${done ? 'Mark not done' : 'Mark done'}">
        <svg width="11" height="9" viewBox="0 0 10 8" fill="none"><path d="M1 4L3.5 6.5L9 1" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>
      </button>
      <span class="home-trow-title">${hEsc(t.text || '')}</span>
      ${meta}
    </div>`;
}
function homeTasksHTML() {
  const today = homeToday();
  const list = (typeof tasks !== 'undefined' && Array.isArray(tasks))
    ? tasks.filter(t => t.top3 && !t.done) : [];
  const done = (typeof getCompletedTasksForDate === 'function') ? getCompletedTasksForDate(today) : [];
  const head = `<div class="home-card-head">
      <h3 class="home-card-title">Today's Tasks${list.length ? ' · ' + list.length : ''}</h3>
      <button class="home-card-link" data-home-go="tasks">View all →</button>
    </div>`;
  let body = list.length
    ? list.map(t => homeTaskRow(t, false)).join('')
    : `<div class="home-empty">No priority tasks. Set your top 3 in Tasks.</div>`;
  if (done.length) {
    body += `<div class="home-subsection">Finished today</div>`
      + done.map(t => homeTaskRow(t, true)).join('');
  }
  return head + body;
}

/* ── Calendar (Google) ────────────────────────────────────── */

function homeCalendarSkeletonHTML() {
  return `<div class="home-card-head"><h3 class="home-card-title">Today's calendar</h3></div>
    <div class="home-skeleton">Loading events…</div>`;
}
function _fmtEventTime(ev) {
  if (ev.isAllDay) return 'All day';
  if (!ev.start) return '';
  const d = new Date(ev.start);
  if (isNaN(d)) return '';
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
function homeCalendarContentHTML(events, expired) {
  const head = `<div class="home-card-head"><h3 class="home-card-title">Today's calendar</h3></div>`;
  if (expired) {
    return head + `<div class="home-empty">Connect Google Calendar to see today's events.</div>
      <button class="home-cta" data-home-cta="settings">Connect Google Calendar →</button>`;
  }
  if (!events || !events.length) {
    return head + `<div class="home-empty">Nothing on the calendar today.</div>`;
  }
  const rows = events.map(ev => `<div class="home-cal-event">
      <span class="home-cal-time">${hEsc(_fmtEventTime(ev))}</span>
      <span class="home-cal-title">${hEsc(ev.summary || '(no title)')}</span>
    </div>`).join('');
  return head + rows;
}

/* ── Mood (+ yesterday's entry) ───────────────────────────── */

function homeMoodHTML(entry, yEntry) {
  // Mood is stored 1–5 (1=Great … 5=Bad), null = unset — matching the Journal tab.
  const sel = entry && entry.mood ? entry.mood : null;
  const labels = (typeof MOOD_LABEL !== 'undefined') ? MOOD_LABEL : ['Great', 'Good', 'Okay', 'Low', 'Bad'];
  const emoji = (typeof MOOD_EMOJI !== 'undefined') ? MOOD_EMOJI : ['🤩', '😊', '😐', '😔', '😢'];
  const btns = emoji.map((e, i) => `
    <button class="home-mood-btn${sel === i + 1 ? ' is-selected' : ''}" data-home-mood="${i + 1}">
      <span>${e}</span><span class="home-mood-cap">${labels[i] || ''}</span>
    </button>`).join('');
  let yest = '';
  const yText = yEntry && (yEntry.reflections || '').trim();
  if (yText) {
    const clip = yText.length > 180 ? yText.slice(0, 180).trim() + '…' : yText;
    yest = `<div class="home-mood-yesterday">“${hEsc(clip)}”<span class="home-mood-yesterday-tag">Yesterday's entry</span></div>`;
  }
  return `<div class="home-card-head"><h3 class="home-card-title">How are you feeling?</h3></div>
    <div class="home-mood">${btns}</div>${yest}`;
}

/* ── Today's habits (condensed) ───────────────────────────── */

function homeHabitsHTML() {
  const today = homeToday();
  const active = (typeof habitsArr !== 'undefined' && Array.isArray(habitsArr))
    ? habitsArr.filter(h => !h.archived) : [];
  const due = (typeof isHabitDueToday === 'function') ? active.filter(h => isHabitDueToday(h)) : active;
  const doneCount = (typeof isCompletedOn === 'function') ? due.filter(h => isCompletedOn(h.id, today)).length : 0;
  const head = `<div class="home-card-head">
      <h3 class="home-card-title">Today's habits</h3>
      ${due.length ? `<span class="home-card-meta">${doneCount} of ${due.length} done</span>` : ''}
    </div>`;
  if (!active.length) return head + `<div class="home-empty">No habits yet. Start one in Habits.</div>`;
  if (!due.length) return head + `<div class="home-empty">Nothing scheduled today — nice.</div>`;
  const esc = (typeof escHTML === 'function') ? escHTML : hEsc;
  const rows = due.map(h => {
    const isDone = (typeof isCompletedOn === 'function') && isCompletedOn(h.id, today);
    return `<div class="home-hrow${isDone ? ' is-done' : ''}">
        <span class="home-hrow-emoji">${esc(h.emoji || '•')}</span>
        <span class="home-hrow-title">${esc(h.name || '')}</span>
        <button class="home-check${isDone ? ' checked' : ''}" data-habit-action="toggle-complete" data-habit-id="${h.id}" data-habit-date="${today}" title="${isDone ? 'Undo' : 'Mark done'}">
          <svg width="11" height="9" viewBox="0 0 10 8" fill="none"><path d="M1 4L3.5 6.5L9 1" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>
        </button>
      </div>`;
  }).join('');
  return head + rows;
}

/* ── Recent notes (+ Quick Notes button) ──────────────────── */

function homeNotesHTML() {
  const SC = (typeof SCRATCH_ID !== 'undefined') ? SCRATCH_ID : -1;
  const all = (typeof notesArr !== 'undefined' && Array.isArray(notesArr))
    ? notesArr.filter(n => !n.trashed && n.id !== SC) : [];
  const recent = all.slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 3);
  const head = `<div class="home-card-head">
      <h3 class="home-card-title">Recent notes</h3>
      <button class="home-card-link" data-home-go="notes">View all →</button>
    </div>`;
  const fmt = (typeof formatNoteDate === 'function') ? formatNoteDate : (s => s || '');
  const rows = recent.length
    ? recent.map(n => `<div class="home-trow">
        <span class="home-trow-title" data-home-note="${n.id}" style="cursor:pointer">${hEsc(n.title || 'Untitled')}</span>
        <span class="home-trow-meta">${hEsc(fmt(n.updatedAt))}</span>
      </div>`).join('')
    : `<div class="home-empty">No notes yet — capture a thought.</div>`;
  const quickBtn = `<div class="home-quicknotes-wrap">
      <button class="home-quicknotes-btn" data-home-quicknotes>📝 Quick Notes</button>
    </div>`;
  return head + rows + quickBtn;
}

/* ── Hydration ────────────────────────────────────────────── */

async function hydrateHomeRingsAndTrend() {
  const ringsEl = document.getElementById('homeRings');
  const trendEl = document.getElementById('homeTrend');
  const setBoth = (r, t) => { if (ringsEl) ringsEl.innerHTML = r; if (trendEl) trendEl.innerHTML = t; };
  const source = homeHealthSource();

  if (source === 'whoop') {
    if (homeWhoopConnected()) {
      setBoth(homeHealthNoticeHTML('Today', 'Whoop rings on Home are coming soon.', null),
              homeHealthNoticeHTML('This week', 'Whoop trends are coming soon.', null));
    } else {
      setBoth(homeHealthNoticeHTML('Today', 'Connect Whoop to track your health on Home.', 'Connect Whoop'),
              homeHealthNoticeHTML('This week', 'Connect Whoop to see your weekly trend.', 'Connect Whoop'));
    }
    return;
  }
  if (!homeOuraConnected()) {
    setBoth(homeHealthNoticeHTML('Today', 'Connect your Oura Ring to see sleep, readiness, and activity.', 'Connect Oura'),
            homeHealthNoticeHTML('This week', 'Connect Oura to see your 7-day trend.', 'Connect Oura'));
    return;
  }
  const oura = await loadOuraScores();
  if (ringsEl) ringsEl.innerHTML = homeRingsContentHTML(oura);
  if (trendEl) trendEl.innerHTML = homeTrendContentHTML(oura);
}

async function hydrateHomeCalendar() {
  if (!document.getElementById('homeCalendar')) return;
  const today = homeToday();
  let events = [];
  if (typeof fetchCalendarEventsForDate === 'function') events = await fetchCalendarEventsForDate(today);
  const expired = typeof journalState !== 'undefined' && journalState.eventsError && journalState.eventsError.get(today) === 'expired';
  const still = document.getElementById('homeCalendar');
  if (still) still.innerHTML = homeCalendarContentHTML(events, expired);
}

async function hydrateHomeMood() {
  if (!document.getElementById('homeMood')) return;
  let entry = null, yEntry = null;
  if (typeof loadJournalEntry === 'function') {
    entry = await loadJournalEntry(homeToday());
    const y = homeYesterday();
    if (y) yEntry = await loadJournalEntry(y);
  }
  const still = document.getElementById('homeMood');
  if (still) still.innerHTML = homeMoodHTML(entry, yEntry);
}

/* ── Section refresh hook (called by render/renderHabits/renderNotes) ── */

function refreshHomeSection(id, html) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}
function refreshHomeData() {
  if (typeof activeTool === 'undefined' || activeTool !== 'home') return;
  if (!document.getElementById('homeContainer')) return;
  refreshHomeSection('homeTasks', homeTasksHTML());
  refreshHomeSection('homeHabits', homeHabitsHTML());
  refreshHomeSection('homeNotes', homeNotesHTML());
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
    refreshHomeSection('homeNotes', homeNotesHTML());
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
          <span class="home-modal-title">Quick Notes</span>
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
  if (typeof renderScratch === 'function') renderScratch();   // renders the Quill editor into #scratchEditorContent
}
function closeQuickNotesModal() {
  // Flush the debounced scratch save.
  if (typeof scratchNote !== 'undefined' && typeof saveNoteToDB === 'function') saveNoteToDB(scratchNote);
  document.getElementById('homeQuickNotesModal')?.remove();
  document.body.style.overflow = '';
}

/* ── Event wiring ─────────────────────────────────────────── */

function homeWireOnce() {
  if (_homeWired) return;
  _homeWired = true;

  document.addEventListener('click', e => {
    // Modal closes work regardless of active tab.
    const mc = e.target.closest('[data-home-modal-close]');
    if (mc) {
      if (mc.dataset.homeModalClose === 'note') closeHomeNoteModal();
      else if (mc.dataset.homeModalClose === 'quicknotes') closeQuickNotesModal();
      return;
    }
    // Backdrop click closes the in-page modals.
    if (e.target.id === 'homeNoteModal') { closeHomeNoteModal(); return; }
    if (e.target.id === 'homeQuickNotesModal') { closeQuickNotesModal(); return; }

    if (activeTool !== 'home' || !document.getElementById('homeContainer')) {
      document.getElementById('homeQuickAddMenu')?.classList.remove('open');
      return;
    }

    if (e.target.closest('#homeQuickAddBtn')) {
      e.stopPropagation();
      document.getElementById('homeQuickAddMenu')?.classList.toggle('open');
      return;
    }
    const addItem = e.target.closest('[data-home-add]');
    if (addItem) {
      document.getElementById('homeQuickAddMenu')?.classList.remove('open');
      homeQuickAdd(addItem.dataset.homeAdd);
      return;
    }
    document.getElementById('homeQuickAddMenu')?.classList.remove('open');

    if (e.target.closest('[data-home-cta="settings"]')) { switchTool('settings'); return; }

    const go = e.target.closest('[data-home-go]');
    if (go) { switchTool(go.dataset.homeGo); return; }

    const noteEl = e.target.closest('[data-home-note]');
    if (noteEl) { openHomeNoteModal(parseInt(noteEl.dataset.homeNote, 10)); return; }

    if (e.target.closest('[data-home-quicknotes]')) { openQuickNotesModal(); return; }

    const taskEl = e.target.closest('[data-home-task]');
    if (taskEl) {
      if (typeof toggleDone_t === 'function') toggleDone_t(parseInt(taskEl.dataset.homeTask, 10));
      return; // render() → refreshHomeData repaints the tasks card
    }

    const moodEl = e.target.closest('[data-home-mood]');
    if (moodEl) {
      const val = parseInt(moodEl.dataset.homeMood, 10);  // 1–5
      const today = homeToday();
      const cur = (typeof journalState !== 'undefined' && journalState.entries.get(today)?.mood) || null;
      const newMood = cur === val ? null : val;            // tap same mood to clear
      if (typeof saveJournalEntry === 'function') saveJournalEntry(today, { mood: newMood });
      const entry = (typeof journalState !== 'undefined' && journalState.entries.get(today)) || { mood: newMood };
      const y = homeYesterday();
      const yEntry = (y && typeof journalState !== 'undefined') ? journalState.entries.get(y) : null;
      refreshHomeSection('homeMood', homeMoodHTML(entry, yEntry));
      return;
    }
    // Habit toggles are handled by the global habits handler →
    // toggleCompletion → renderHabits → refreshHomeData.
  });

  // Esc closes whichever in-page modal is open.
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (document.getElementById('homeNoteModal')) closeHomeNoteModal();
    else if (document.getElementById('homeQuickNotesModal')) closeQuickNotesModal();
  });
}

function homeQuickAdd(kind) {
  if (kind === 'task') {
    if (typeof openCreatePanel === 'function') openCreatePanel();   // existing in-page create panel
  } else if (kind === 'journal') {
    if (typeof openEditModal === 'function') openEditModal(homeToday());  // journal day editor modal
  } else if (kind === 'note') {
    homeCreateNote();
  }
}

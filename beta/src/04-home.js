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

const HOME_RING_COLORS = { sleep: '#6b4862', readiness: '#a37826', activity: '#5e6d3f' };
const HOME_MOOD_EMOJI  = ['🤩', '😊', '😐', '😔', '😢'];

let _homeOura = null;
let _homeOuraInflight = null;
let _homeWired = false;

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

function renderHome() {
  const el = document.getElementById('homeContainer');
  if (!el) return;
  _homeOura = null;
  homeSyncChrome();

  el.innerHTML = `
    <div class="home-row"><div class="home-card" id="homeToday">${homeTodayCardHTML()}</div></div>
    <div class="home-row"><div class="home-card" id="homeAgenda">${homeAgendaCardHTML()}</div></div>
    <div class="home-row"><div class="home-card" id="homeNotesCard">${homeNotesCardHTML()}</div></div>
    <div class="home-row"><div class="home-card" id="homeWeek">${homeWeekSkeletonHTML()}</div></div>
  `;

  homeWireOnce();
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

function homeSectionHead(emoji, text, rightHtml) {
  return `<div class="home-section-head">
      <div class="home-section-title"><span class="home-section-emoji">${emoji}</span> ${hEsc(text)}</div>
      ${rightHtml || ''}
    </div>`;
}

/* ── Card 1: Today (rings + mood) ─────────────────────────── */

function homeTodayCardHTML() {
  return `${homeSectionHead('☀️', 'Today', '<span class="home-card-meta" id="homeTodayAsOf"></span>')}
    <div id="homeRingsRow"><div class="home-skeleton">Loading your numbers…</div></div>
    <div class="home-mood-block">
      <div class="home-mood-q">How are you feeling?</div>
      <div id="homeMoodRow">${homeMoodRowHTML(null)}</div>
    </div>`;
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
function homeRingsRowHTML(oura) {
  const latest = oura?.days?.[0];
  if (!latest) return `<div class="home-empty">No Oura data yet — it syncs overnight.</div>`;
  const ring = (label, score, color) => `<div class="home-ring">${ringSvg(score, color)}<span class="home-ring-label">${label}</span></div>`;
  return `<div class="home-rings">
      ${ring('Sleep', latest.sleep_score, HOME_RING_COLORS.sleep)}
      ${ring('Readiness', latest.readiness_score, HOME_RING_COLORS.readiness)}
      ${ring('Activity', latest.activity_score, HOME_RING_COLORS.activity)}
    </div>`;
}
function homeMoodRowHTML(entry) {
  const sel = entry && entry.mood ? entry.mood : null;   // 1–5, null = unset
  const labels = homeMoodLabels(), emoji = homeMoodEmoji();
  const btns = emoji.map((e, i) => `
    <button class="home-mood-btn${sel === i + 1 ? ' is-selected' : ''}" data-home-mood="${i + 1}">
      <span>${e}</span><span class="home-mood-cap">${labels[i] || ''}</span>
    </button>`).join('');
  return `<div class="home-mood">${btns}</div>`;
}

/* ── Card 2: Agenda (Calendar · Tasks · Habits) ───────────── */

function homeAgendaCardHTML() {
  return `
    <div class="home-section">
      ${homeSectionHead('📅', "Today's Calendar")}
      <div id="homeCalendar"><div class="home-skeleton">Loading events…</div></div>
    </div>
    <div class="home-section">
      ${homeSectionHead('✅', "Today's Tasks", '<button class="home-add-btn" data-task-action="open-create" title="Add task">+</button>')}
      <div id="homeTasks">${homeTasksInnerHTML()}</div>
    </div>
    <div class="home-section">
      ${homeSectionHead('🔁', "Today's Habits", '<span class="home-card-meta" id="homeHabitsMeta">' + homeHabitsMeta() + '</span>')}
      <div id="homeHabits">${homeHabitsInnerHTML()}</div>
    </div>`;
}

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
  return events.map(ev => `<div class="home-cal-event">
      <span class="home-cal-time">${hEsc(_fmtEventTime(ev))}</span>
      <span class="home-cal-title">${hEsc(ev.summary || '(no title)')}</span>
    </div>`).join('');
}

// Real task cards (same styling + behaviour as the Tasks tab via the global
// data-task-action handler); category tags are hidden via CSS to condense.
function homeTasksInnerHTML() {
  const list = (typeof tasks !== 'undefined' && Array.isArray(tasks)) ? tasks.filter(t => t.top3 && !t.done) : [];
  if (!list.length) return `<div class="home-empty">No priority tasks. Tap + to add one, or star tasks in the Tasks tab.</div>`;
  if (typeof tHTML !== 'function') return '';
  return list.map(t => tHTML(t)).join('');
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
    return `<div class="home-hrow${isDone ? ' is-done' : ''}">
        <span class="home-hrow-emoji">${esc(h.emoji || '•')}</span>
        <span class="home-hrow-title">${esc(h.name || '')}</span>
        <button class="home-check${isDone ? ' checked' : ''}" data-habit-action="toggle-complete" data-habit-id="${h.id}" data-habit-date="${today}" title="${isDone ? 'Undo' : 'Mark done'}"></button>
      </div>`;
  }).join('');
}

/* ── Card 3: Recent notes (+ Quick Notes) ─────────────────── */

function homeNotesCardHTML() {
  const SC = (typeof SCRATCH_ID !== 'undefined') ? SCRATCH_ID : -1;
  const all = (typeof notesArr !== 'undefined' && Array.isArray(notesArr)) ? notesArr.filter(n => !n.trashed && n.id !== SC) : [];
  const recent = all.slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 3);
  const fmt = (typeof formatNoteDate === 'function') ? formatNoteDate : (s => s || '');
  const head = homeSectionHead('📝', 'Recent Notes', '<button class="home-card-link" data-home-go="notes">View all →</button>');
  const rows = recent.length
    ? recent.map(n => `<div class="home-trow">
        <span class="home-trow-title" data-home-note="${n.id}">${hEsc(n.title || 'Untitled')}</span>
        <span class="home-trow-meta">${hEsc(fmt(n.updatedAt))}</span>
      </div>`).join('')
    : `<div class="home-empty">No notes yet — capture a thought.</div>`;
  const quickBtn = `<div class="home-quicknotes-wrap"><button class="home-quicknotes-btn" data-home-quicknotes>📝 Quick Notes</button></div>`;
  return head + rows + quickBtn;
}

/* ── Card 4: Last 7 Days ──────────────────────────────────── */

function homeWeekSkeletonHTML() {
  return homeSectionHead('📊', 'Last 7 Days') + `<div class="home-skeleton">Loading…</div>`;
}
function homeWeekInnerHTML(oura, entriesByDate) {
  const today = homeToday();
  const ouraByDate = new Map();
  (oura?.days || []).forEach(d => ouraByDate.set(d.date, d));
  const emoji = homeMoodEmoji();

  // Newest first: today, then back 6 days.
  const dates = [];
  for (let i = 0; i < 7; i++) {
    dates.push(typeof jShiftDays === 'function' ? jShiftDays(today, -i) : today);
  }

  const moods = [];
  const num = (v, color) => `<span class="hw-num"${v == null ? '' : ` style="color:${color}"`}>${v == null ? '—' : v}</span>`;
  const rows = dates.map(d => {
    const o = ouraByDate.get(d) || {};
    const m = entriesByDate.get(d)?.mood;
    if (m) moods.push(m);
    const wd = (d === today) ? 'Today' : new Date(d + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short' });
    return `<div class="home-week-row">
        <span class="hw-day">${hEsc(wd)}</span>
        <span class="hw-mood">${m ? emoji[m - 1] : '·'}</span>
        <span class="hw-scores">${num(o.sleep_score, HOME_RING_COLORS.sleep)}${num(o.readiness_score, HOME_RING_COLORS.readiness)}${num(o.activity_score, HOME_RING_COLORS.activity)}</span>
      </div>`;
  }).join('');

  let avgHtml = '';
  if (moods.length) {
    const avg = Math.round(moods.reduce((a, b) => a + b, 0) / moods.length);
    avgHtml = `<span class="home-week-avg">Avg mood ${emoji[avg - 1]}</span>`;
  }
  const legend = `<div class="home-week-legend">
      <span><i style="background:${HOME_RING_COLORS.sleep}"></i>Sleep</span>
      <span><i style="background:${HOME_RING_COLORS.readiness}"></i>Readiness</span>
      <span><i style="background:${HOME_RING_COLORS.activity}"></i>Activity</span>
    </div>`;
  return homeSectionHead('📊', 'Last 7 Days', avgHtml) + legend + `<div class="home-week">${rows}</div>`;
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
    const latest = oura?.days?.[0];
    const asOf = document.getElementById('homeTodayAsOf');
    if (asOf) asOf.textContent = (latest && latest.date && latest.date !== homeToday() && typeof jFormatShort === 'function')
      ? `as of ${jFormatShort(latest.date)}` : '';
  }
  // Mood (today's journal entry).
  if (typeof loadJournalEntry === 'function') {
    const entry = await loadJournalEntry(homeToday());
    const moodEl = document.getElementById('homeMoodRow');
    if (moodEl) moodEl.innerHTML = homeMoodRowHTML(entry);
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
  const nc = document.getElementById('homeNotesCard'); if (nc) nc.innerHTML = homeNotesCardHTML();
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
    const nc = document.getElementById('homeNotesCard'); if (nc) nc.innerHTML = homeNotesCardHTML();
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

    if (activeTool !== 'home' || !document.getElementById('homeContainer')) return;

    if (e.target.closest('[data-home-cta="settings"]')) { switchTool('settings'); return; }
    const go = e.target.closest('[data-home-go]');
    if (go) { switchTool(go.dataset.homeGo); return; }
    const noteEl = e.target.closest('[data-home-note]');
    if (noteEl) { openHomeNoteModal(parseInt(noteEl.dataset.homeNote, 10)); return; }
    if (e.target.closest('[data-home-quicknotes]')) { openQuickNotesModal(); return; }

    const moodEl = e.target.closest('[data-home-mood]');
    if (moodEl) {
      const val = parseInt(moodEl.dataset.homeMood, 10);  // 1–5
      const today = homeToday();
      const cur = (typeof journalState !== 'undefined' && journalState.entries.get(today)?.mood) || null;
      const newMood = cur === val ? null : val;
      if (typeof saveJournalEntry === 'function') saveJournalEntry(today, { mood: newMood });
      const entry = (typeof journalState !== 'undefined' && journalState.entries.get(today)) || { mood: newMood };
      refreshHomeSection('homeMoodRow', homeMoodRowHTML(entry));
      return;
    }
    // Tasks (data-task-action) and habits (data-habit-action) are handled by
    // their own global delegated listeners; render()/renderHabits() then call
    // refreshHomeData to repaint the Home sections.
  });

  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (document.getElementById('homeNoteModal')) closeHomeNoteModal();
    else if (document.getElementById('homeQuickNotesModal')) closeQuickNotesModal();
  });
}

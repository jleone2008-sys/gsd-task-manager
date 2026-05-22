/* ══════════════════════════════════════════════════════════════
   HOME — daily brief (beta-only). The default tab on load.
   Aggregates existing domains; reuses their data + helpers rather
   than duplicating logic:
     - greeting/mood/calendar/finished-today  → beta/src/03-journal.js
     - tasks (top3, toggleDone_t)             → beta/src/01-core.js + /src/*
     - habits (isHabitDueToday, cards)        → /src/03-habits-core.js
     - notes (notesArr, stripHTML)            → /src/06-notes.js, /src/08-editor.js
     - scratch (renderScratch, SCRATCH_ID)    → /src/07-scratch.js
   Oura scores are read directly from oura_daily via a scoped RLS SELECT
   policy (oura_daily_select_own; auth.email() = user_email). The nightly
   cron writes with the service key, so clients still can't mutate the table.

   Render strategy: paint synchronously from in-memory data, then
   hydrate the two network-backed cards (rings/trend + calendar) in
   place — Home is the default tab, so it must show instantly.
═══════════════════════════════════════════════════════════════ */

// Ring colors — pulled from the app.css earth palette for visual kinship.
const HOME_RING_COLORS = { sleep: '#6b4862', readiness: '#a37826', activity: '#5e6d3f' };

let _homeOura = null;        // cached { days: [...] } for the current render
let _homeOuraInflight = null;
let _homeWired = false;      // one-time delegated listener guard

function homeToday() {
  return (typeof jToday === 'function') ? jToday() : new Date().toISOString().slice(0, 10);
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

// Which wearable feeds the Home rings, chosen in Settings. Defaults to Oura.
function homeHealthSource() {
  if (typeof getHealthSource === 'function') return getHealthSource();
  return (typeof userSettings !== 'undefined' && userSettings?.integrations?.health_source === 'whoop') ? 'whoop' : 'oura';
}

// Shared empty/notice card body for the rings + trend when there are no scores
// to show (not connected, or Whoop's "coming soon").
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
      // Direct read, scoped by the oura_daily_select_own RLS policy.
      const { data, error } = await db.from('oura_daily')
        .select('date,sleep_score,readiness_score,activity_score')
        .order('date', { ascending: false })
        .limit(7);
      if (error) throw error;
      _homeOura = { days: data || [] }; // newest-first
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

/* ── Top-level render ─────────────────────────────────────── */

function renderHome() {
  const el = document.getElementById('homeContainer');
  if (!el) return;
  // A fresh visit re-fetches Oura so the rings reflect the latest nightly sync.
  _homeOura = null;

  el.innerHTML = `
    ${homeGreetingHTML()}
    <div class="home-row"><div class="home-card" id="homeRings">${homeRingsSkeletonHTML()}</div></div>
    <div class="home-row cols-2">
      <div class="home-card" id="homePriority">${homePriorityHTML()}</div>
      <div class="home-card" id="homeCalendar">${homeCalendarSkeletonHTML()}</div>
    </div>
    <div class="home-row cols-2">
      <div class="home-card" id="homeMood">${homeMoodHTML(null)}</div>
      <div class="home-card" id="homeHabits">${homeHabitsHTML()}</div>
    </div>
    <div class="home-row"><div class="home-card" id="homeNotes">${homeNotesHTML()}</div></div>
    <div class="home-row"><div class="home-card" id="homeScratch">${homeScratchHTML()}</div></div>
    <div class="home-row cols-2">
      <div class="home-card" id="homeTrend">${homeTrendSkeletonHTML()}</div>
      <div class="home-card" id="homeFinished">${homeFinishedHTML()}</div>
    </div>
  `;

  homeWireOnce();
  hydrateHomeRingsAndTrend();
  hydrateHomeCalendar();
  hydrateHomeMood();
}

/* ── Section: greeting + quick add ────────────────────────── */

function homeGreetingHTML() {
  const name = (typeof getFirstName === 'function') ? getFirstName() : '';
  const greeting = (typeof getTimeBasedGreeting === 'function') ? getTimeBasedGreeting(name) : `Hello${name ? ', ' + name : ''}`;
  const today = homeToday();
  const dateLabel = (typeof jFormatLong === 'function') ? jFormatLong(today) : today;
  return `
    <div class="home-greeting">
      <div>
        <h1>${hEsc(greeting)}</h1>
        <div class="home-subtitle">${hEsc(dateLabel)}</div>
      </div>
      <div class="home-quickadd">
        <button class="home-quickadd-btn" id="homeQuickAddBtn">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Quick add
        </button>
        <div class="home-quickadd-menu" id="homeQuickAddMenu">
          <button class="home-quickadd-item" data-home-add="task">📋 Add task</button>
          <button class="home-quickadd-item" data-home-add="journal">📓 Today's journal entry</button>
          <button class="home-quickadd-item" data-home-add="note">📝 Add note</button>
        </div>
      </div>
    </div>`;
}

/* ── Section: rings (Oura) ────────────────────────────────── */

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

// Assumes the Oura source is selected + connected (gated by hydrateHomeRingsAndTrend).
function homeRingsContentHTML(oura) {
  const latest = oura?.days?.[0];
  if (!latest) {
    return `<div class="home-card-head"><h3 class="home-card-title">Today</h3></div>
      <div class="home-empty">No Oura data yet for today — it syncs overnight.</div>`;
  }
  // The latest row may pre-date today (ring not worn / not yet synced). Label it
  // honestly rather than implying the numbers are from last night.
  const stale = latest.date && latest.date !== homeToday();
  const asOf = stale && typeof jFormatShort === 'function'
    ? `<span class="home-card-link" style="cursor:default;color:var(--ink-4)">as of ${hEsc(jFormatShort(latest.date))}</span>`
    : '';
  const ring = (label, score, color) => `
    <div class="home-ring">
      ${ringSvg(score, color)}
      <span class="home-ring-label">${label}</span>
    </div>`;
  return `<div class="home-card-head"><h3 class="home-card-title">Today</h3>${asOf}</div>
    <div class="home-rings">
      ${ring('Sleep', latest.sleep_score, HOME_RING_COLORS.sleep)}
      ${ring('Readiness', latest.readiness_score, HOME_RING_COLORS.readiness)}
      ${ring('Activity', latest.activity_score, HOME_RING_COLORS.activity)}
    </div>`;
}

/* ── Section: this-week trend ─────────────────────────────── */

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

// Assumes the Oura source is selected + connected (gated by hydrateHomeRingsAndTrend).
function homeTrendContentHTML(oura) {
  const head = `<div class="home-card-head"><h3 class="home-card-title">This week</h3></div>`;
  // Chronological order (rows come back newest-first).
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

/* ── Section: priority tasks ──────────────────────────────── */

function homePriorityHTML() {
  const list = (typeof tasks !== 'undefined' && Array.isArray(tasks))
    ? tasks.filter(t => t.top3 && !t.done) : [];
  const head = `<div class="home-card-head">
      <h3 class="home-card-title">Priority${list.length ? ' · ' + list.length : ''}</h3>
      <button class="home-card-link" data-home-go="tasks">View all →</button>
    </div>`;
  if (!list.length) {
    return head + `<div class="home-empty">No priority tasks. Set your top 3 in Tasks.</div>`;
  }
  const rows = list.map(t => {
    // Reuse the Tasks tab's due badge so styling/wording stays consistent.
    const meta = (t.due && typeof dueBadgeHTML === 'function') ? dueBadgeHTML(t.due) : '';
    return `<div class="home-list-item">
      <button class="home-cta" data-home-task="${t.id}" style="padding:0;color:var(--ink-4)" title="Mark done">○</button>
      <span class="hli-title" data-home-go="tasks" style="flex:1;cursor:pointer">${hEsc(t.text || '')}</span>
      ${meta}
    </div>`;
  }).join('');
  return head + rows;
}

/* ── Section: calendar (Google) ───────────────────────────── */

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

/* ── Section: mood ────────────────────────────────────────── */

function homeMoodHTML(entry) {
  const sel = entry && entry.mood != null ? entry.mood : null;
  const labels = (typeof MOOD_LABEL !== 'undefined') ? MOOD_LABEL : ['Great', 'Good', 'Okay', 'Low', 'Bad'];
  const emoji = (typeof MOOD_EMOJI !== 'undefined') ? MOOD_EMOJI : ['🤩', '😊', '😐', '😔', '😢'];
  const btns = emoji.map((e, i) => `
    <button class="home-mood-btn${sel === i ? ' is-selected' : ''}" data-home-mood="${i}">
      <span>${e}</span><span class="home-mood-cap">${labels[i] || ''}</span>
    </button>`).join('');
  return `<div class="home-card-head"><h3 class="home-card-title">How are you feeling?</h3></div>
    <div class="home-mood">${btns}</div>`;
}

/* ── Section: today's habits ──────────────────────────────── */

function homeHabitsHTML() {
  const today = homeToday();
  const active = (typeof habitsArr !== 'undefined' && Array.isArray(habitsArr))
    ? habitsArr.filter(h => !h.archived) : [];
  const due = (typeof isHabitDueToday === 'function') ? active.filter(h => isHabitDueToday(h)) : active;
  const doneCount = (typeof isCompletedOn === 'function') ? due.filter(h => isCompletedOn(h.id, today)).length : 0;
  const head = `<div class="home-card-head">
      <h3 class="home-card-title">Today's habits</h3>
      ${due.length ? `<span class="home-card-link" style="cursor:default;color:var(--ink-4)">${doneCount} of ${due.length} done</span>` : ''}
    </div>`;
  if (!active.length) {
    return head + `<div class="home-empty">No habits yet. Start one in Habits.</div>`;
  }
  if (!due.length) {
    return head + `<div class="home-empty">Nothing scheduled today — nice.</div>`;
  }
  const cards = (typeof habitTodayCardHTML === 'function')
    ? due.map(h => habitTodayCardHTML(h, today)).join('')
    : '';
  return head + `<div class="habits-content">${cards}</div>`;
}

/* ── Section: recent notes ────────────────────────────────── */

function homeNotesHTML() {
  const all = (typeof notesArr !== 'undefined' && Array.isArray(notesArr))
    ? notesArr.filter(n => !n.trashed && n.id !== (typeof SCRATCH_ID !== 'undefined' ? SCRATCH_ID : -1)) : [];
  const recent = all.slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 3);
  const head = `<div class="home-card-head">
      <h3 class="home-card-title">Recent notes</h3>
      <button class="home-card-link" data-home-go="notes">View all →</button>
    </div>`;
  if (!recent.length) {
    return head + `<div class="home-empty">No notes yet — capture a thought.</div>`;
  }
  const fmt = (typeof formatNoteDate === 'function') ? formatNoteDate : (s => s || '');
  const rows = recent.map(n => `<div class="home-list-item">
      <span class="hli-title" data-home-note="${n.id}" style="flex:1;cursor:pointer">${hEsc(n.title || 'Untitled')}</span>
      <span class="hli-meta">${hEsc(fmt(n.updatedAt))}</span>
    </div>`).join('');
  return head + rows;
}

/* ── Section: scratch quick-capture ───────────────────────── */

function homeScratchHTML() {
  let preview = '';
  try {
    const raw = localStorage.getItem('gsd-scratch') || '';
    if (raw && typeof stripHTML === 'function') preview = stripHTML(raw).trim().slice(0, 140);
  } catch (_) {}
  const placeholder = preview || 'Brain dump… (opens the full scratchpad)';
  return `<div class="home-card-head"><h3 class="home-card-title">Scratch</h3></div>
    <div class="home-scratch-capture" id="homeScratchCapture" tabindex="0" role="button">${hEsc(placeholder)}</div>`;
}

/* ── Section: finished today ──────────────────────────────── */

function homeFinishedHTML() {
  const today = homeToday();
  const doneTasks = (typeof getCompletedTasksForDate === 'function') ? getCompletedTasksForDate(today) : [];
  let habitsDone = 0;
  if (typeof habitCompletions !== 'undefined' && Array.isArray(habitCompletions)) {
    habitsDone = habitCompletions.filter(c => c.completedDate === today).length;
  }
  const head = `<div class="home-card-head"><h3 class="home-card-title">Finished today</h3></div>`;
  if (!doneTasks.length && !habitsDone) {
    return head + `<div class="home-empty">Nothing checked off yet. The day's young.</div>`;
  }
  const taskRows = doneTasks.slice(0, 5).map(t => `<div class="home-list-item">
      <span class="hli-title" style="color:var(--ink-3);text-decoration:line-through">${hEsc(t.text || '')}</span>
    </div>`).join('');
  const more = doneTasks.length > 5 ? `<div class="home-empty">+${doneTasks.length - 5} more</div>` : '';
  const habitLine = habitsDone ? `<div class="home-empty">${habitsDone} habit${habitsDone === 1 ? '' : 's'} completed</div>` : '';
  return head + taskRows + more + habitLine;
}

/* ── Hydration ────────────────────────────────────────────── */

async function hydrateHomeRingsAndTrend() {
  const ringsEl = document.getElementById('homeRings');
  const trendEl = document.getElementById('homeTrend');
  const setBoth = (ringsHtml, trendHtml) => {
    if (ringsEl) ringsEl.innerHTML = ringsHtml;
    if (trendEl) trendEl.innerHTML = trendHtml;
  };

  const source = homeHealthSource();

  if (source === 'whoop') {
    if (homeWhoopConnected()) {
      setBoth(
        homeHealthNoticeHTML('Today', 'Whoop rings on Home are coming soon.', null),
        homeHealthNoticeHTML('This week', 'Whoop trends are coming soon.', null)
      );
    } else {
      setBoth(
        homeHealthNoticeHTML('Today', 'Connect Whoop to track your health on Home.', 'Connect Whoop'),
        homeHealthNoticeHTML('This week', 'Connect Whoop to see your weekly trend.', 'Connect Whoop')
      );
    }
    return;
  }

  // source === 'oura'
  if (!homeOuraConnected()) {
    setBoth(
      homeHealthNoticeHTML('Today', 'Connect your Oura Ring to see sleep, readiness, and activity.', 'Connect Oura'),
      homeHealthNoticeHTML('This week', 'Connect Oura to see your 7-day trend.', 'Connect Oura')
    );
    return;
  }

  const oura = await loadOuraScores();
  if (ringsEl) ringsEl.innerHTML = homeRingsContentHTML(oura);
  if (trendEl) trendEl.innerHTML = homeTrendContentHTML(oura);
}

async function hydrateHomeCalendar() {
  const el = document.getElementById('homeCalendar');
  if (!el) return;
  const today = homeToday();
  let events = [];
  if (typeof fetchCalendarEventsForDate === 'function') {
    events = await fetchCalendarEventsForDate(today);
  }
  const expired = typeof journalState !== 'undefined'
    && journalState.eventsError && journalState.eventsError.get(today) === 'expired';
  // Re-check the element — the user may have navigated away mid-fetch.
  const still = document.getElementById('homeCalendar');
  if (still) still.innerHTML = homeCalendarContentHTML(events, expired);
}

async function hydrateHomeMood() {
  const el = document.getElementById('homeMood');
  if (!el) return;
  let entry = null;
  if (typeof loadJournalEntry === 'function') {
    entry = await loadJournalEntry(homeToday());
  }
  const still = document.getElementById('homeMood');
  if (still) still.innerHTML = homeMoodHTML(entry);
}

/* ── Targeted section refreshes (after in-place edits) ────── */

function refreshHomeSection(id, html) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}

// Called by the shared data loaders (tasks/habits/notes) when their async load
// finishes. They fire-and-forget at sign-in, so Home's first paint can precede
// the data — this repaints the in-memory-backed sections once data arrives.
// Guarded so it's a harmless no-op in prod (where renderHome doesn't exist).
function refreshHomeData() {
  if (typeof activeTool === 'undefined' || activeTool !== 'home') return;
  if (!document.getElementById('homeContainer')) return;
  refreshHomeSection('homePriority', homePriorityHTML());
  refreshHomeSection('homeHabits', homeHabitsHTML());
  refreshHomeSection('homeNotes', homeNotesHTML());
  refreshHomeSection('homeScratch', homeScratchHTML());
  refreshHomeSection('homeFinished', homeFinishedHTML());
}

/* ── Event wiring (delegated, attached once) ──────────────── */

function homeWireOnce() {
  if (_homeWired) return;
  _homeWired = true;

  document.addEventListener('click', e => {
    const container = document.getElementById('homeContainer');
    if (!container || activeTool !== 'home') {
      // Quick-add menu can be left open; close it on any outside click.
      const menu = document.getElementById('homeQuickAddMenu');
      if (menu) menu.classList.remove('open');
      return;
    }

    // Quick-add toggle
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
    // Close menu on any other click
    document.getElementById('homeQuickAddMenu')?.classList.remove('open');

    // CTA → settings
    if (e.target.closest('[data-home-cta="settings"]')) { switchTool('settings'); return; }

    // Navigate to a tab
    const go = e.target.closest('[data-home-go]');
    if (go) { switchTool(go.dataset.homeGo); return; }

    // Open a specific note
    const noteEl = e.target.closest('[data-home-note]');
    if (noteEl) {
      const id = parseInt(noteEl.dataset.homeNote, 10);
      switchTool('notes');
      if (typeof selectNote === 'function') selectNote(id);
      return;
    }

    // Toggle a priority task done. toggleDone_t → render() → refreshHomeData()
    // repaints the priority/finished sections, so no manual refresh here.
    const taskEl = e.target.closest('[data-home-task]');
    if (taskEl) {
      const id = parseInt(taskEl.dataset.homeTask, 10);
      if (typeof toggleDone_t === 'function') toggleDone_t(id);
      return;
    }

    // Mood pick. saveJournalEntry doesn't run a domain render fn, so refresh the
    // mood card directly (journalState is updated synchronously by the call).
    const moodEl = e.target.closest('[data-home-mood]');
    if (moodEl) {
      const idx = parseInt(moodEl.dataset.homeMood, 10);
      const today = homeToday();
      if (typeof saveJournalEntry === 'function') saveJournalEntry(today, { mood: idx });
      const entry = (typeof journalState !== 'undefined' && journalState.entries.get(today)) || { mood: idx };
      refreshHomeSection('homeMood', homeMoodHTML(entry));
      return;
    }

    // Scratch capture → open the full scratchpad
    if (e.target.closest('#homeScratchCapture')) { switchTool('scratch'); return; }

    // Habit toggles are handled by the global habits click handler →
    // toggleCompletion → renderHabits → refreshHomeData, which repaints the
    // Home habits section. Nothing to do here.
  });

  // Keyboard affordance for the scratch capture box.
  document.addEventListener('keydown', e => {
    if (activeTool !== 'home') return;
    if (e.target && e.target.id === 'homeScratchCapture' && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      switchTool('scratch');
    }
  });
}

function homeQuickAdd(kind) {
  if (kind === 'task') {
    if (typeof openCreatePanel === 'function') openCreatePanel();
  } else if (kind === 'journal') {
    const today = homeToday();
    if (typeof journalState !== 'undefined') journalState.selectedDate = today;
    switchTool('journal');
  } else if (kind === 'note') {
    switchTool('notes');
    if (typeof createNote === 'function') createNote();
  }
}

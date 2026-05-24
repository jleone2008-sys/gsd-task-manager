/* ══════════════════════════════════════════════════════════════
   TRAIN tab — Phase 4 (skeleton)

   Three subtabs: Plan / Today / Progress.
   - Plan: browse the 3 starter templates, fork to active, view active plan.
   - Today: log today's prescribed session (set-by-set + 5-emoji feel).
   - Progress: body comp dashboard (goals / calorie target / report /
                trends / photos) + setup wizard + new-entry form + detail.

   This file is the skeleton — it wires up navigation, exposes
   renderTrain() for switchTool, and registers the subtab pill-bar
   handler. Plan / Today / Progress render functions land in follow-up
   commits.

   The deterministic math (Mifflin-St Jeor BMR, TDEE, calorie deficit,
   U.S. Navy body-fat formula, macro split) is centralized at the bottom
   of this file so every subtab uses the same numbers and the formulas
   are easy to verify in one place — no AI guessing in any of them.
═══════════════════════════════════════════════════════════════ */

let _trainWired = false;
let _trainActiveView = 'today';        // 'plan' | 'today' | 'progress'
const TRAIN_VIEWS = ['plan', 'today', 'progress'];

// Shared state across the three subtabs. Loaded on first renderTrain()
// call after sign-in; refreshed on demand (fork, edit, activate).
const _trainState = {
  loaded:      false,    // become true after first successful load
  loading:     false,
  error:       null,
  templates:   [],       // built-in is_template=true plans
  userPlans:   [],       // user's own plans (forked + custom)
  activePlan:  null,     // the user's currently-active plan, or null
};

function renderTrain() {
  ensureTrainStyles();
  trainWireOnce();
  const root = document.getElementById('trainContainer');
  if (!root) return;

  if (!TRAIN_VIEWS.includes(_trainActiveView)) _trainActiveView = 'today';

  // Set the subtab pill-bar's visible-active state.
  document.querySelectorAll('.train-sub-pills .train-pill').forEach(p => {
    p.classList.toggle('active', p.dataset.trainView === _trainActiveView);
  });

  // Lazy-load the plan data the first time the Train tab is opened.
  if (!_trainState.loaded && !_trainState.loading) loadTrainPlans();

  if (_trainActiveView === 'plan')          renderTrainPlan(root);
  else if (_trainActiveView === 'today')    renderTrainToday(root);
  else                                       renderTrainProgress(root);
}

function trainSwitchView(view) {
  if (!TRAIN_VIEWS.includes(view)) return;
  if (view === _trainActiveView) return;
  _trainActiveView = view;
  renderTrain();
}

function trainWireOnce() {
  if (_trainWired) return;
  _trainWired = true;

  // Single click delegator for every Train action. Early-out when the
  // train tab isn't active so we don't pay this dispatch on Home / Tasks
  // clicks. activeTool is a 01-core.js global.
  document.addEventListener('click', e => {
    // Subtab pill-bar (always live so the user can switch even from a
    // mid-Train modal).
    const pill = e.target.closest('.train-sub-pills .train-pill');
    if (pill) { trainSwitchView(pill.dataset.trainView); return; }

    if (typeof activeTool !== 'undefined' && activeTool !== 'train') return;

    const actionEl = e.target.closest('[data-train-action]');
    if (!actionEl) return;
    const action = actionEl.dataset.trainAction;

    if (action === 'fork') {
      trainForkTemplate(actionEl.dataset.templateId);
      return;
    }
    if (action === 'activate-plan') {
      trainActivatePlan(actionEl.dataset.planId);
      return;
    }
    if (action === 'start-today') {
      trainSwitchView('today');
      return;
    }
    if (action === 'manage-plan') {
      // Edit-plan modal lands in a follow-up commit; toast for now so the
      // CTA isn't a dead button.
      showTrainToast('Plan editor coming in the next commit.');
      return;
    }
    if (action === 'day-detail') {
      trainOpenDayDetail(actionEl.dataset.dow);
      return;
    }
    if (action === 'reload') {
      _trainState.loaded = false;
      loadTrainPlans();
      return;
    }
    if (action === 'close-day-detail') {
      trainCloseDayDetail();
      return;
    }

    // ── Today subtab actions ──────────────────────────────────────────
    if (action === 'goto-plan') {
      trainSwitchView('plan');
      return;
    }
    if (action === 'pick-day') {
      const dow = actionEl.dataset.dow;
      const st = _trainTodayState;
      st.isBonus = false;
      st.selectedDow = dow;
      st.day = trainFindDay(dow);
      st.liftSets = trainSeedSetsFromDay(st.day);
      st.cardio = { modality: null, duration: '', distance: '' };
      st.submittedFeedback = null;
      renderTrain();
      return;
    }
    if (action === 'pick-any') {
      const st = _trainTodayState;
      st.isBonus = true;
      st.selectedDow = null;
      st.day = null;
      st.submittedFeedback = null;
      renderTrain();
      return;
    }
    if (action === 'bonus-type') {
      _trainTodayState.bonusType = actionEl.dataset.type;
      renderTrain();
      return;
    }
    if (action === 'bonus-date') {
      _trainTodayState.bonusDate = actionEl.dataset.date;
      renderTrain();
      return;
    }
    if (action === 'activity-add') {
      _trainTodayState.bonusActivities.push({ name: '', duration: '' });
      renderTrain();
      return;
    }
    if (action === 'activity-remove') {
      const i = Number(actionEl.dataset.i);
      _trainTodayState.bonusActivities.splice(i, 1);
      if (_trainTodayState.bonusActivities.length === 0) {
        _trainTodayState.bonusActivities.push({ name: '', duration: '' });
      }
      renderTrain();
      return;
    }
    if (action === 'cardio-modality') {
      _trainTodayState.cardio.modality = actionEl.dataset.modality;
      renderTrain();
      return;
    }
    if (action === 'toggle-done') {
      const ex = actionEl.dataset.ex, i = Number(actionEl.dataset.i);
      const row = _trainTodayState.liftSets[ex]?.[i];
      if (row) { row.done = !row.done; renderTrain(); }
      return;
    }
    if (action === 'feel') {
      _trainTodayState.feel = Number(actionEl.dataset.val);
      renderTrain();
      return;
    }
    if (action === 'submit-session') {
      trainSubmitTodaySession();
      return;
    }
    if (action === 'start-new') {
      _trainTodayState.initialized = false;
      ensureTrainTodayInit();
      renderTrain();
      return;
    }
    if (action === 'habit-link') {
      const habitId = Number(actionEl.dataset.habitId);
      const kind = actionEl.dataset.kind;
      const sessionDate = _trainTodayState.submittedFeedback?._session?.session_date
                       || _trainTodayState.date;
      trainLinkHabitToLibrary(habitId, kind, sessionDate);
      return;
    }
    if (action === 'habit-link-dismiss') {
      const habitId = actionEl.dataset.habitId;
      try { localStorage.setItem(`gsd_habit_link_dismissed:${habitId}`, '1'); } catch (_) {}
      renderTrain();
      return;
    }
  });

  // Input handler for the Today subtab text inputs. Separate listener so
  // every keystroke doesn't blow through the click dispatch above. Uses the
  // same data-train-action attributes for routing.
  document.addEventListener('input', e => {
    if (typeof activeTool !== 'undefined' && activeTool !== 'train') return;
    const el = e.target.closest('[data-train-action]');
    if (!el) return;
    const action = el.dataset.trainAction;
    const v = el.value;
    if (action === 'set-weight') {
      const ex = el.dataset.ex, i = Number(el.dataset.i);
      if (_trainTodayState.liftSets[ex]?.[i]) _trainTodayState.liftSets[ex][i].weight = v;
      // Don't re-render on every keystroke — the inline cell already shows the value.
      return;
    }
    if (action === 'set-reps') {
      const ex = el.dataset.ex, i = Number(el.dataset.i);
      if (_trainTodayState.liftSets[ex]?.[i]) _trainTodayState.liftSets[ex][i].reps = v;
      return;
    }
    if (action === 'cardio-duration') { _trainTodayState.cardio.duration = v; return; }
    if (action === 'cardio-distance') { _trainTodayState.cardio.distance = v; return; }
    if (action === 'notes')           { _trainTodayState.notes          = v; return; }
    if (action === 'activity-name') {
      const i = Number(el.dataset.i);
      if (_trainTodayState.bonusActivities[i]) _trainTodayState.bonusActivities[i].name = v;
      return;
    }
    if (action === 'activity-duration') {
      const i = Number(el.dataset.i);
      if (_trainTodayState.bonusActivities[i]) _trainTodayState.bonusActivities[i].duration = v;
      return;
    }
  });
}

/* ── Day detail modal (read-only for now) ────────────────────────────
   Tapping a day in the active-plan week grid opens a small sheet with
   that day's prescribed exercises (or "Rest" copy). Edit-in-place
   ships in a follow-up commit alongside the plan editor. */
function trainOpenDayDetail(dow) {
  const active = _trainState.activePlan;
  if (!active) return;
  const days = Array.isArray(active.day_template) ? active.day_template : [];
  const day = days.find(d => d.dow === dow);
  if (!day) return;
  trainCloseDayDetail();

  const exercises = Array.isArray(day.exercises) ? day.exercises : [];
  const rows = exercises.length === 0
    ? `<div class="day-detail-empty">No exercises prescribed.</div>`
    : exercises.map(ex => `<div class="day-detail-ex">
        <div class="day-detail-ex-name">${trainEsc(ex.name)}</div>
        <div class="day-detail-ex-target">${ex.sets} × ${trainEsc(String(ex.reps))}${ex.rest_s ? ` · ${ex.rest_s}s rest` : ''}${ex.bodyweight ? ' · BW' : ''}</div>
      </div>`).join('');

  const typeBadge = {
    lift:   { txt: 'Lift',   cls: 'is-lift'   },
    cardio: { txt: 'Cardio', cls: 'is-cardio' },
    bonus:  { txt: 'Bonus',  cls: 'is-bonus'  },
    rest:   { txt: 'Rest',   cls: 'is-rest'   },
  }[day.type || 'lift'] || { txt: day.type, cls: '' };

  const html = `<div class="train-modal-overlay" id="trainDayDetailModal" data-train-action="close-day-detail">
    <div class="train-modal" onclick="event.stopPropagation()">
      <div class="train-modal-head">
        <div>
          <div class="day-detail-dow">${trainEsc(day.dow)}</div>
          <div class="day-detail-name">${trainEsc(day.name)}</div>
        </div>
        <button class="train-modal-close" data-train-action="close-day-detail" title="Close">×</button>
      </div>
      <div class="day-detail-badge ${typeBadge.cls}">${typeBadge.txt}</div>
      <div class="day-detail-body">${rows}</div>
    </div>
  </div>`;
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  document.body.appendChild(wrap.firstElementChild);
}

function trainCloseDayDetail() {
  document.getElementById('trainDayDetailModal')?.remove();
}

/* ════════════════════════════════════════════════════════════════════════
   DATA LAYER — Supabase reads/writes for plans + sessions.
   `db`, `currentUser` are globals from beta/src/01-core.js (classic script
   scope sharing). All RLS policies live in the migration files; this
   layer is a thin shape-converter on top of standard from/select/upsert.
════════════════════════════════════════════════════════════════════════ */

const DOW_ORDER = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

function trainEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
  ));
}

async function loadTrainPlans() {
  _trainState.loading = true; _trainState.error = null;
  try {
    // Templates: is_template=true, user_id is null. RLS lets us read them.
    const { data: templates, error: tErr } = await db
      .from('workout_plans')
      .select('id,name,description,days_per_week,day_template,is_template,is_active,forked_from,created_at')
      .eq('is_template', true)
      .order('days_per_week', { ascending: false });
    if (tErr) throw tErr;

    // User's own plans (forked + custom).
    const { data: userPlans, error: uErr } = await db
      .from('workout_plans')
      .select('id,name,description,days_per_week,day_template,is_template,is_active,forked_from,created_at')
      .eq('is_template', false)
      .order('created_at', { ascending: false });
    if (uErr) throw uErr;

    _trainState.templates  = templates || [];
    _trainState.userPlans  = userPlans || [];
    _trainState.activePlan = (userPlans || []).find(p => p.is_active) || null;
    _trainState.loaded     = true;
  } catch (e) {
    console.warn('[train] loadTrainPlans failed', e);
    _trainState.error = e?.message || 'Failed to load plans.';
  } finally {
    _trainState.loading = false;
    // Re-render whichever subtab is active — they all read off _trainState.
    renderTrain();
  }
}

async function trainForkTemplate(templateId) {
  const tpl = _trainState.templates.find(t => t.id === templateId);
  if (!tpl) return;
  try {
    // Deactivate any currently-active plan first so the unique-active
    // index doesn't fire on the insert below.
    if (_trainState.activePlan) {
      await db.from('workout_plans')
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq('id', _trainState.activePlan.id);
    }
    const { data, error } = await db.from('workout_plans').insert({
      user_id:       currentUser.id,
      name:          tpl.name,
      description:   tpl.description,
      days_per_week: tpl.days_per_week,
      day_template:  tpl.day_template,
      is_template:   false,
      is_active:     true,
      forked_from:   tpl.id,
    }).select().single();
    if (error) throw error;
    // Optimistic local update so the UI flips without a re-fetch.
    if (_trainState.activePlan) _trainState.activePlan.is_active = false;
    _trainState.userPlans.unshift(data);
    _trainState.activePlan = data;
    renderTrain();
  } catch (e) {
    console.warn('[train] fork failed', e);
    showTrainToast('Couldn’t fork that template — try again.');
  }
}

async function trainActivatePlan(planId) {
  try {
    if (_trainState.activePlan && _trainState.activePlan.id !== planId) {
      await db.from('workout_plans')
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq('id', _trainState.activePlan.id);
      _trainState.activePlan.is_active = false;
    }
    const { data, error } = await db.from('workout_plans')
      .update({ is_active: true, updated_at: new Date().toISOString() })
      .eq('id', planId).select().single();
    if (error) throw error;
    const idx = _trainState.userPlans.findIndex(p => p.id === planId);
    if (idx >= 0) _trainState.userPlans[idx] = data;
    _trainState.activePlan = data;
    renderTrain();
  } catch (e) {
    console.warn('[train] activate failed', e);
    showTrainToast('Couldn’t set that plan as active.');
  }
}

// Light toast helper that re-uses the existing showToast if available,
// falls back to a console warning otherwise. Keeps Train decoupled from
// 02-tasks-sync's toast DOM.
function showTrainToast(msg) {
  if (typeof showToast === 'function') showToast(msg);
  else console.warn('[train]', msg);
}

/* ════════════════════════════════════════════════════════════════════════
   PLAN SUBTAB renderer
   - Active plan card with this-week grid + today CTA + manage button
   - Templates list with Fork buttons (marks the one matching the active
     plan's forked_from as "In use" so users don't double-fork)
   - Empty state: no active plan yet → templates are the primary CTA
════════════════════════════════════════════════════════════════════════ */

// Current local day of week ('Mon' .. 'Sun'). Used to highlight today
// in the active-plan week grid and to find today's prescribed session.
function trainTodayDow() {
  // 0=Sun, 1=Mon, ..., 6=Sat. Map to our Mon-Sun string list.
  const jsDay = new Date().getDay();
  return DOW_ORDER[(jsDay + 6) % 7];
}

function renderTrainPlan(root) {
  if (_trainState.loading && !_trainState.loaded) {
    root.innerHTML = `<div class="train-shell"><div class="train-loading">Loading plans…</div></div>`;
    return;
  }
  if (_trainState.error) {
    root.innerHTML = `<div class="train-shell"><div class="train-error">${trainEsc(_trainState.error)}
      <button class="train-retry" data-train-action="reload">Retry</button></div></div>`;
    return;
  }

  const active   = _trainState.activePlan;
  const todayDow = trainTodayDow();

  root.innerHTML = `<div class="train-shell">
    ${active ? renderPlanActiveCard(active, todayDow) : renderPlanEmptyCard()}
    ${renderPlanTemplatesList(_trainState.templates, active)}
  </div>`;
}

function renderPlanActiveCard(plan, todayDow) {
  const days = Array.isArray(plan.day_template) ? plan.day_template : [];
  const dayByDow = {};
  days.forEach(d => { dayByDow[d.dow] = d; });

  // Render the 7-day strip in Mon-Sun order using DOW_ORDER, so days are
  // visually consistent even if the plan's day_template was authored in
  // a different order.
  const dayGrid = DOW_ORDER.map(dow => {
    const d = dayByDow[dow];
    const isToday = dow === todayDow;
    const cls = ['plan-day'];
    if (isToday) cls.push('is-today');
    if (!d || d.type === 'rest') cls.push('is-rest');
    if (d?.type === 'cardio') cls.push('is-cardio');
    const name = d ? d.name : 'Rest';
    return `<div class="${cls.join(' ')}" data-train-action="day-detail" data-dow="${dow}">
      <span class="plan-day-dow">${dow}</span>
      <span class="plan-day-name">${trainEsc(name)}</span>
    </div>`;
  }).join('');

  // Today's day card — pulled from the plan by today's DOW so the user can
  // see what's prescribed and jump to log it. Falls back to "Rest" copy.
  const todayDay = dayByDow[todayDow];
  let todayCardInner;
  if (todayDay && todayDay.type !== 'rest') {
    const exerciseCount = Array.isArray(todayDay.exercises) ? todayDay.exercises.length : 0;
    const typeIcon = todayDay.type === 'cardio' ? '🏃' : '🏋️';
    const exerciseMeta = todayDay.type === 'cardio'
      ? 'Cardio session'
      : `${exerciseCount} lift${exerciseCount === 1 ? '' : 's'}`;
    todayCardInner = `
      <div class="plan-today-icon">${typeIcon}</div>
      <div class="plan-today-text">
        <div class="plan-today-name">Today · ${trainEsc(todayDay.name)}</div>
        <div class="plan-today-meta">${exerciseMeta}</div>
      </div>
      <button class="train-btn-primary" data-train-action="start-today">Start →</button>`;
  } else {
    todayCardInner = `
      <div class="plan-today-icon" style="background:var(--surface-2);color:var(--ink-3);">🛋️</div>
      <div class="plan-today-text">
        <div class="plan-today-name">Today · Rest day</div>
        <div class="plan-today-meta">No session prescribed</div>
      </div>
      <button class="train-btn-secondary" data-train-action="start-today">Log bonus</button>`;
  }

  return `<div class="plan-active-card">
    <div class="plan-active-head">
      <span class="plan-eyebrow">Active plan</span>
      <button class="train-btn-link" data-train-action="manage-plan">Manage ↗</button>
    </div>
    <div class="plan-name">${trainEsc(plan.name)}</div>
    <div class="plan-week-grid">${dayGrid}</div>
    <div class="plan-today-card">${todayCardInner}</div>
  </div>`;
}

function renderPlanEmptyCard() {
  return `<div class="plan-empty-card">
    <div class="plan-empty-title">No active plan yet</div>
    <div class="plan-empty-msg">Pick a starter template below to fork into your own active plan, or build one from scratch in Manage.</div>
  </div>`;
}

function renderPlanTemplatesList(templates, active) {
  if (!Array.isArray(templates) || templates.length === 0) {
    return `<div class="plan-templates-empty">No templates available. Run <code>workout_templates_seed.sql</code> in Supabase to load the 3 starters.</div>`;
  }
  const items = templates.map(tpl => {
    const inUse = active && active.forked_from === tpl.id;
    const days = Array.isArray(tpl.day_template) ? tpl.day_template : [];
    const schedule = days.map(d => d.name).join(' · ');
    return `<div class="plan-template-card">
      <div class="plan-template-text">
        <div class="plan-template-name">${trainEsc(tpl.name)}</div>
        <div class="plan-template-meta">${trainEsc(schedule)}</div>
      </div>
      ${inUse
        ? `<button class="train-btn-secondary" disabled>In use</button>`
        : `<button class="train-btn-primary" data-train-action="fork" data-template-id="${tpl.id}">Fork</button>`}
    </div>`;
  }).join('');
  return `<div class="plan-templates-block">
    <div class="plan-templates-label">Available templates</div>
    ${items}
  </div>`;
}

/* ════════════════════════════════════════════════════════════════════════
   TODAY SUBTAB — V1
   - Day picker (this-week, today active by default).
   - Per-day-type body renderer: lift / cardio / bonus / rest.
   - Inline set entry on lift days; tap a cell, type weight/reps.
   - Session footer: notes textarea + 5-emoji feel + Submit + Get Feedback.
   - Submit creates a workout_sessions row + all workout_sets rows in one
     batch and shows the formulaic feedback inline.

   Deferred (follow-up commit): focus-sheet entry, day-picker backfill,
   Bonus + Activity-Log full UX, AI feedback narrative.
════════════════════════════════════════════════════════════════════════ */

// In-flight session state. Reset whenever the user changes the day or
// successfully submits. All fields live in memory until Submit.
const _trainTodayState = {
  initialized: false,
  date:        null,          // 'YYYY-MM-DD' (user-local today)
  selectedDow: null,          // 'Mon' .. 'Sun' — pill the user has selected
  isBonus:     false,         // true when Any-day pill is selected
  bonusDate:   null,          // when isBonus=true, the date the bonus is
                              //   being logged for (defaults to today; the
                              //   date picker allows the last 7 days for
                              //   backfilling a missed entry)
  day:         null,          // plan.day_template entry for selectedDow (or null for bonus)
  // Per-exercise set entries: { [exerciseName]: [{ weight: '', reps: '', done: false }, ...] }
  liftSets:    {},
  cardio:      { modality: null, duration: '', distance: '' },
  bonusType:   'lift',        // 'lift' | 'activity' — when isBonus
  bonusActivities: [{ name: '', duration: '' }],
  feel:        null,          // 1=Great .. 5=Bad
  notes:       '',
  submitting:  false,
  submittedFeedback: null,    // formulaic feedback object after submit
};

function trainTodayLocalDate() {
  const tz = (Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

// Initialize today state if first render OR the day-of-week changed
// (e.g., user left the app open overnight). Re-uses any work-in-progress
// state for the same day.
function ensureTrainTodayInit() {
  const today = trainTodayLocalDate();
  const dow   = trainTodayDow();
  if (_trainTodayState.initialized && _trainTodayState.date === today) return;
  _trainTodayState.initialized = true;
  _trainTodayState.date = today;
  _trainTodayState.bonusDate = today;
  _trainTodayState.selectedDow = dow;
  _trainTodayState.isBonus = false;
  _trainTodayState.day = trainFindDay(dow);
  _trainTodayState.liftSets = trainSeedSetsFromDay(_trainTodayState.day);
  _trainTodayState.cardio = { modality: null, duration: '', distance: '' };
  _trainTodayState.bonusType = 'lift';
  _trainTodayState.bonusActivities = [{ name: '', duration: '' }];
  _trainTodayState.feel = null;
  _trainTodayState.notes = '';
  _trainTodayState.submittedFeedback = null;
}

// "YYYY-MM-DD" shifted by N days from a base date string. Negative N
// goes backward. Local-tz safe: parses as midnight local, adds 86_400s
// per day, formats back to local YYYY-MM-DD.
function trainShiftDate(dateStr, deltaDays) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + deltaDays);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

// Pretty label for a date string. Today / Yesterday / "Mon Nov 18".
function trainDateLabel(dateStr, todayStr) {
  if (dateStr === todayStr) return 'Today';
  if (dateStr === trainShiftDate(todayStr, -1)) return 'Yesterday';
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function trainFindDay(dow) {
  const active = _trainState.activePlan;
  if (!active || !Array.isArray(active.day_template)) return null;
  return active.day_template.find(d => d.dow === dow) || null;
}

// Build an empty liftSets shape from a day's exercises so the UI has
// one editable row per prescribed set.
function trainSeedSetsFromDay(day) {
  const out = {};
  if (!day || day.type !== 'lift' || !Array.isArray(day.exercises)) return out;
  for (const ex of day.exercises) {
    const n = Math.max(1, Number(ex.sets) || 1);
    out[ex.name] = Array.from({ length: n }, () => ({
      weight: '', reps: '', done: false, is_bodyweight: !!ex.bodyweight,
    }));
  }
  return out;
}

// Tail-recursive load: fetch the last ~300 sets across every exercise
// in the active plan, group by exercise, take only the most recent
// session's sets per exercise. Cache on _trainState.lastSetsByExercise
// so all subtab renders can reference it without re-querying.
async function loadLastSetsForActivePlan() {
  if (!_trainState.activePlan) return;
  const exercises = new Set();
  for (const day of (_trainState.activePlan.day_template || [])) {
    if (day && day.type === 'lift' && Array.isArray(day.exercises)) {
      for (const ex of day.exercises) exercises.add(ex.name);
    }
  }
  if (exercises.size === 0) { _trainState.lastSetsByExercise = {}; return; }

  try {
    const { data, error } = await db.from('workout_sets')
      .select('exercise_name,set_index,actual_weight,actual_reps,is_bodyweight,completed_at,session_id')
      .eq('user_id', currentUser.id)
      .in('exercise_name', Array.from(exercises))
      .not('actual_reps', 'is', null)
      .order('completed_at', { ascending: false })
      .limit(300);
    if (error) throw error;

    const byEx = {};
    for (const row of data || []) {
      if (!byEx[row.exercise_name]) {
        byEx[row.exercise_name] = { sessionId: row.session_id, sets: [] };
      }
      if (byEx[row.exercise_name].sessionId === row.session_id) {
        byEx[row.exercise_name].sets.push(row);
      }
    }
    for (const k of Object.keys(byEx)) byEx[k].sets.sort((a, b) => a.set_index - b.set_index);
    _trainState.lastSetsByExercise = byEx;
  } catch (e) {
    console.warn('[train] load last sets failed', e);
    _trainState.lastSetsByExercise = {};
  }
}

function renderTrainToday(root) {
  if (_trainState.loading && !_trainState.loaded) {
    root.innerHTML = `<div class="train-shell"><div class="train-loading">Loading…</div></div>`;
    return;
  }
  if (_trainState.error) {
    root.innerHTML = `<div class="train-shell"><div class="train-error">${trainEsc(_trainState.error)}
      <button class="train-retry" data-train-action="reload">Retry</button></div></div>`;
    return;
  }
  if (!_trainState.activePlan) {
    root.innerHTML = `<div class="train-shell">
      <div class="train-empty">
        <div class="train-empty-title">No active plan</div>
        <div class="train-empty-msg">Fork a starter template from the Plan subtab to start logging sessions. You can still log a one-off bonus session via the Any pill.</div>
        <button class="train-btn-primary" style="margin-top:12px" data-train-action="goto-plan">Go to Plan →</button>
      </div>
    </div>`;
    return;
  }

  ensureTrainTodayInit();
  // Lazy-fetch the per-exercise last-session reference data once.
  if (!_trainState.lastSetsByExercise) {
    _trainState.lastSetsByExercise = {};
    loadLastSetsForActivePlan();
  }

  const st = _trainTodayState;
  const dayPickerHtml = renderTodayDayPicker(st);

  let body;
  if (st.submittedFeedback) {
    body = renderTodayFeedback(st);
  } else if (st.isBonus) {
    body = renderTodayBonus(st);
  } else if (!st.day || st.day.type === 'rest') {
    body = renderTodayRest(st);
  } else if (st.day.type === 'cardio') {
    body = renderTodayCardio(st);
  } else {
    body = renderTodayLift(st);
  }

  // Footer only renders when there's a session to log (skip on rest day).
  const isLoggable = st.submittedFeedback ? false
                   : (st.isBonus || (st.day && st.day.type !== 'rest'));
  const footer = isLoggable ? renderTodayFooter(st) : '';

  root.innerHTML = `<div class="train-shell">
    ${dayPickerHtml}
    ${body}
    ${footer}
  </div>`;
}

function renderTodayDayPicker(st) {
  const plan = _trainState.activePlan;
  const days = Array.isArray(plan?.day_template) ? plan.day_template : [];
  const dayByDow = {};
  days.forEach(d => { dayByDow[d.dow] = d; });
  const todayDow = trainTodayDow();

  const pills = DOW_ORDER.map(dow => {
    const d = dayByDow[dow];
    const cls = ['day-pill-card'];
    if (!st.isBonus && st.selectedDow === dow) cls.push('is-active');
    if (!d || d.type === 'rest') cls.push('is-rest');
    if (d?.type === 'cardio') cls.push('is-cardio');
    const name = d ? d.name : 'Rest';
    const isToday = dow === todayDow;
    return `<div class="${cls.join(' ')}" data-train-action="pick-day" data-dow="${dow}">
      <span class="day-pill-dow">${dow}${isToday ? ' •' : ''}</span>
      <span class="day-pill-name">${trainEsc(name)}</span>
    </div>`;
  }).join('');

  const anyCls = ['day-pill-card','is-any'];
  if (st.isBonus) anyCls.push('is-active');

  return `<div class="train-day-picker">
    ${pills}
    <div class="${anyCls.join(' ')}" data-train-action="pick-any">
      <span class="day-pill-dow">+</span><span class="day-pill-name">Bonus</span>
    </div>
  </div>`;
}

function renderTodayLift(st) {
  const day = st.day;
  const exercises = Array.isArray(day.exercises) ? day.exercises : [];
  if (exercises.length === 0) {
    return `<div class="train-empty">
      <div class="train-empty-title">No exercises prescribed</div>
      <div class="train-empty-msg">Edit this day in Plan → Manage to add exercises.</div>
    </div>`;
  }
  const cards = exercises.map(ex => renderTodayLiftCard(ex, st)).join('');
  return `<div class="train-today-body">${cards}</div>`;
}

function renderTodayLiftCard(ex, st) {
  const sets = st.liftSets[ex.name] || [];
  const last = (_trainState.lastSetsByExercise || {})[ex.name];
  const lastSummary = last && last.sets.length
    ? last.sets.map(s => s.is_bodyweight
        ? `${s.actual_reps} reps`
        : `${s.actual_weight}×${s.actual_reps}`).join(', ')
    : 'No prior data';

  const target = ex.target_text
    ? `<span class="ex-target target-${ex.target_kind || 'hold'}">${trainEsc(ex.target_text)}</span>`
    : '';

  const rows = sets.map((s, i) => {
    const lastSet = last && last.sets[i];
    const lastCell = lastSet
      ? (lastSet.is_bodyweight ? `${lastSet.actual_reps} reps` : `${lastSet.actual_weight}×${lastSet.actual_reps}`)
      : '—';
    const weightInput = ex.bodyweight && !s.weight
      ? `<input class="ex-cell-input is-bw" type="text" placeholder="BW" value="${trainEsc(s.weight)}" data-train-action="set-weight" data-ex="${trainEsc(ex.name)}" data-i="${i}">`
      : `<input class="ex-cell-input" type="text" inputmode="decimal" placeholder="lbs" value="${trainEsc(s.weight)}" data-train-action="set-weight" data-ex="${trainEsc(ex.name)}" data-i="${i}">`;
    const repsInput = `<input class="ex-cell-input" type="text" inputmode="numeric" placeholder="reps" value="${trainEsc(s.reps)}" data-train-action="set-reps" data-ex="${trainEsc(ex.name)}" data-i="${i}">`;
    const check = s.done
      ? `<button class="ex-set-check is-done" data-train-action="toggle-done" data-ex="${trainEsc(ex.name)}" data-i="${i}" title="Mark not done">✓</button>`
      : `<button class="ex-set-check" data-train-action="toggle-done" data-ex="${trainEsc(ex.name)}" data-i="${i}" title="Mark complete"></button>`;
    return `<div class="ex-set-row ${s.done ? 'is-done' : ''}">
      <span class="ex-set-num">S${i + 1}</span>
      <span class="ex-set-last">${trainEsc(lastCell)}</span>
      <div class="ex-set-today">${weightInput}${repsInput}</div>
      ${check}
    </div>`;
  }).join('');

  return `<div class="ex-card">
    <div class="ex-card-head">
      <div>
        <div class="ex-card-name">${trainEsc(ex.name)}</div>
        <div class="ex-card-meta">${trainEsc(ex.muscle_group || '')}${ex.rest_s ? ` · ${ex.rest_s}s rest` : ''}</div>
      </div>
      ${target}
    </div>
    <div class="ex-table-head">
      <span>Set</span><span>Last session</span>
      <span class="col-today"><span>Today · ${ex.sets} × ${trainEsc(String(ex.reps || ''))}</span></span>
      <span></span>
    </div>
    ${rows}
  </div>`;
}

function renderTodayCardio(st) {
  const c = st.cardio;
  const modalities = ['Run','Bike','Row','Swim','Walk','HIIT','Hike','Other'];
  const emojis = { Run:'🏃', Bike:'🚴', Row:'🚣', Swim:'🏊', Walk:'🚶', HIIT:'🔥', Hike:'🥾', Other:'⋯' };
  const pills = modalities.map(m => `
    <button class="cardio-type-pill ${c.modality === m ? 'is-selected' : ''}" data-train-action="cardio-modality" data-modality="${m}">
      <span class="cardio-type-emoji">${emojis[m]}</span>
      <span class="cardio-type-label">${m}</span>
    </button>`).join('');
  return `<div class="train-today-body">
    <div class="cardio-card">
      <div class="cardio-card-head">
        <div class="cardio-card-title">${trainEsc(st.day.name)}</div>
        <div class="cardio-card-meta">Pick your modality, then log duration + distance.</div>
      </div>
      <div class="cardio-type-grid">${pills}</div>
      <div class="cardio-stats-grid">
        <div class="form-field">
          <label class="form-label">Duration (min)</label>
          <input class="form-input" type="text" inputmode="numeric" placeholder="30" value="${trainEsc(c.duration)}" data-train-action="cardio-duration">
        </div>
        <div class="form-field">
          <label class="form-label">Distance (mi)</label>
          <input class="form-input" type="text" inputmode="decimal" placeholder="—" value="${trainEsc(c.distance)}" data-train-action="cardio-distance">
        </div>
      </div>
    </div>
  </div>`;
}

function renderTodayBonus(st) {
  // V1: only Bonus Lifting is implemented; Activity Log placeholder.
  if (st.bonusType === 'activity') {
    const rows = st.bonusActivities.map((a, i) => `
      <div class="activity-row">
        <div class="form-field">
          <label class="form-label">Activity</label>
          <input class="form-input" type="text" placeholder="e.g. Hiked Mt. Monadnock" value="${trainEsc(a.name)}" data-train-action="activity-name" data-i="${i}">
        </div>
        <div class="form-field">
          <label class="form-label">Duration (min)</label>
          <input class="form-input" type="text" inputmode="numeric" placeholder="60" value="${trainEsc(a.duration)}" data-train-action="activity-duration" data-i="${i}">
        </div>
        <button class="activity-row-remove" data-train-action="activity-remove" data-i="${i}" title="Remove">×</button>
      </div>`).join('');
    return `<div class="train-today-body">
      ${renderBonusTypeToggle(st)}
      <div class="cardio-card">
        <div class="cardio-card-head">
          <div class="cardio-card-title">Freeform activity</div>
          <div class="cardio-card-meta">Hikes, walks, climbing, pickup sports — anything off-program.</div>
        </div>
        ${rows}
        <button class="activity-row-add" data-train-action="activity-add">+ Add another activity</button>
      </div>
    </div>`;
  }
  // Bonus Lifting — empty by default, user adds exercises.
  // V1: prompt user to fork from a template's day or start blank.
  return `<div class="train-today-body">
    ${renderBonusTypeToggle(st)}
    <div class="train-empty">
      <div class="train-empty-title">Bonus lifting</div>
      <div class="train-empty-msg">Custom exercise add lands in a follow-up commit. For now, log a planned day from the picker or use Activity Log for cardio.</div>
    </div>
  </div>`;
}

function renderBonusTypeToggle(st) {
  const today = st.date;
  // Build the 7-day backfill picker: today + 6 days back. Tap any day
  // to log the bonus session for that date; defaults to today.
  const dateOpts = [];
  for (let i = 0; i < 7; i++) {
    const d = trainShiftDate(today, -i);
    dateOpts.push({ date: d, label: trainDateLabel(d, today) });
  }
  const datePills = dateOpts.map(o => `
    <button class="bonus-date-pill ${st.bonusDate === o.date ? 'is-active' : ''}" data-train-action="bonus-date" data-date="${o.date}">
      ${trainEsc(o.label)}
    </button>`).join('');

  return `<div class="when-what-card" style="margin-bottom:12px">
    <div class="when-what-label">When</div>
    <div class="bonus-date-row">${datePills}</div>
    <div class="when-what-label" style="margin-top:12px">Session type</div>
    <div class="session-type-row">
      <button class="session-type-pill ${st.bonusType === 'lift' ? 'is-active' : ''}" data-train-action="bonus-type" data-type="lift">Bonus Lifting</button>
      <button class="session-type-pill ${st.bonusType === 'activity' ? 'is-active' : ''}" data-train-action="bonus-type" data-type="activity">Activity Log</button>
    </div>
  </div>`;
}

function renderTodayRest(st) {
  return `<div class="train-empty">
    <div class="train-empty-title">Rest day</div>
    <div class="train-empty-msg">No session prescribed for ${trainEsc(st.selectedDow)}. Tap <strong>+ Any</strong> above to log a bonus session anyway.</div>
  </div>`;
}

function renderTodayFooter(st) {
  const moodEmojis = ['🤩','😊','😐','😔','😢'];
  const moodLabels = ['Great','Good','Okay','Low','Bad'];
  const mood = moodEmojis.map((e, i) => `
    <button class="mood-btn ${st.feel === i + 1 ? 'is-selected' : ''}" data-train-action="feel" data-val="${i + 1}">
      <span class="mood-emoji">${e}</span><span class="mood-label">${moodLabels[i]}</span>
    </button>`).join('');
  // Live totals
  const totals = trainComputeLiveTotals(st);
  return `<div class="train-session-footer">
    <div class="train-footer-label">Session notes</div>
    <textarea class="train-notes-input" placeholder="How did it go? PRs, anything felt off?" data-train-action="notes">${trainEsc(st.notes)}</textarea>
    <div class="train-feel-block">
      <div class="train-footer-label">How'd the session feel?</div>
      <div class="train-mood-grid">${mood}</div>
    </div>
    <div class="train-totals">
      <div><div class="train-total-num">${totals.left.num}</div><div class="train-total-label">${totals.left.label}</div></div>
      <div><div class="train-total-num">${totals.right.num}</div><div class="train-total-label">${totals.right.label}</div></div>
    </div>
    <button class="train-submit-btn" data-train-action="submit-session" ${st.submitting ? 'disabled' : ''}>
      ${st.submitting ? 'Saving…' : 'Submit + Get Feedback'}
    </button>
  </div>`;
}

function trainComputeLiveTotals(st) {
  if (st.isBonus && st.bonusType === 'activity') {
    const count = st.bonusActivities.filter(a => a.name.trim()).length;
    const mins  = st.bonusActivities.reduce((s, a) => s + (Number(a.duration) || 0), 0);
    return { left: { num: count, label: 'Activities' }, right: { num: mins, label: 'Total min' } };
  }
  if (st.day && st.day.type === 'cardio') {
    const mins = Number(st.cardio.duration) || 0;
    const dist = Number(st.cardio.distance) || 0;
    return { left: { num: mins, label: 'Minutes' }, right: { num: dist || '—', label: 'Miles' } };
  }
  // Lift session: total sets done + total volume (sum of weight × reps for completed sets)
  let setsDone = 0, volume = 0;
  for (const exName of Object.keys(st.liftSets || {})) {
    for (const s of st.liftSets[exName]) {
      if (!s.done) continue;
      setsDone += 1;
      const w = Number(s.weight) || 0;
      const r = Number(s.reps)   || 0;
      if (!s.is_bodyweight) volume += w * r;
    }
  }
  return {
    left:  { num: setsDone, label: 'Sets' },
    right: { num: volume.toLocaleString(), label: 'Volume (lbs)' },
  };
}

function renderTodayFeedback(st) {
  const fb = st.submittedFeedback;
  if (!fb) return '';
  const stats = (fb.stats || []).map(s => `<div class="fb-stat">
      <div class="fb-stat-num">${trainEsc(String(s.value))}</div>
      <div class="fb-stat-label">${trainEsc(s.label)}</div>
    </div>`).join('');
  const lines = (fb.observations || []).map(o => `<li>${trainEsc(o)}</li>`).join('');
  return `<div class="train-today-body">
    <div class="ex-card">
      <div class="ex-card-head">
        <div>
          <div class="ex-card-name">Session logged ✓</div>
          <div class="ex-card-meta">${trainEsc(fb.session_summary)}</div>
        </div>
      </div>
      <div class="fb-stats-grid">${stats}</div>
      ${lines ? `<ul class="fb-observations">${lines}</ul>` : ''}
      ${renderHabitLinkPrompts(fb._session)}
      <button class="train-btn-secondary" style="margin-top:12px" data-train-action="start-new">Start another session</button>
    </div>
  </div>`;
}

// Library kind → display props. Mirrors habit_library rows but client-side
// so we don't need a round-trip just to render the prompt.
const TRAIN_LIBRARY_DISPLAY = {
  lifting:  { name: 'Lifting',      emoji: '🏋️' },
  cardio:   { name: 'Cardio',       emoji: '🏃' },
  activity: { name: 'Activity',     emoji: '🧗' },
  progress: { name: 'Progress pic', emoji: '📸' },
};

// Curated synonyms / related terms used to detect a likely link between
// a user habit's name and a library kind. Case-insensitive word-boundary
// match — keeps "running shoes" from matching but lets "Lift Weights"
// and "Bike Ride" both link cleanly. Synonyms err toward false-positive;
// the prompt is always opt-in and per-habit dismissible.
const TRAIN_LIBRARY_SYNONYMS = {
  lifting: [
    'lifting','lift','lifts','weights','weight training','weight-training',
    'strength','strength training','resistance','gym','barbell','dumbbell',
    'pump','iron','squats','squat','press','bench','deadlift','workout',
    'workouts',
  ],
  cardio: [
    'cardio','cardiovascular','aerobic',
    'run','runs','running','jog','jogging','sprint','sprints','treadmill',
    'bike','biking','cycle','cycling','spin','spinning',
    'swim','swims','swimming','laps',
    'walk','walks','walking','steps',
    'hike','hiking','trail',
    'row','rowing','erg',
    'hiit',
  ],
  activity: [
    'activity','activities','outdoor','outdoors',
    'climb','climbing','bouldering','rock climbing',
    'yoga','pilates','mobility','stretching','stretch','flexibility',
    'sport','sports','pickup','recreation','play','games',
  ],
  progress: [
    'progress','progress pic','progress photo','pic','photo','photos',
    'body comp','body composition','composition',
    'measure','measurement','measurements','weigh','weigh-in','scale',
  ],
};

function trainEscapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Word-boundary match. "lift weights" matches against the 'lifting' kind
// via the 'lift' synonym; "running shoes" intentionally does NOT match
// 'lifting' because 'shoes' isn't there and 'lift' isn't a substring.
function trainHabitMatchesKind(habitName, kind) {
  if (!habitName) return false;
  const synonyms = TRAIN_LIBRARY_SYNONYMS[kind] || [];
  for (const syn of synonyms) {
    const re = new RegExp(`\\b${trainEscapeRegex(syn)}\\b`, 'i');
    if (re.test(habitName)) return true;
  }
  return false;
}

// One-time prompt offering to link an existing user habit (e.g. "Cardio",
// "Lift Weights", "Bike Ride") to the matching library kind after the
// relevant session type submits. Synonyms above drive the match — a
// habit named "Lift Weights" still gets offered for 'lifting' even
// though "Lifting" isn't a substring of it. Dismissal is stored
// per-habit in localStorage so declining doesn't re-prompt forever.
function renderHabitLinkPrompts(session) {
  if (!session) return '';
  const kinds = trainSessionToLibraryKinds(session);
  if (!kinds.length) return '';
  if (typeof habitsArr === 'undefined' || !Array.isArray(habitsArr)) return '';

  const candidates = [];
  for (const h of habitsArr) {
    if (h.archived) continue;
    if (h.libraryKind) continue;
    let dismissed = false;
    try { dismissed = !!localStorage.getItem(`gsd_habit_link_dismissed:${h.id}`); } catch (_) {}
    if (dismissed) continue;
    for (const k of kinds) {
      if (trainHabitMatchesKind(h.name, k)) {
        candidates.push({ habit: h, kind: k });
        break;
      }
    }
  }
  if (!candidates.length) return '';

  return candidates.map(c => {
    const lib = TRAIN_LIBRARY_DISPLAY[c.kind];
    return `<div class="train-habit-prompt">
      <div class="train-habit-prompt-icon">${lib.emoji}</div>
      <div class="train-habit-prompt-body">
        <div class="train-habit-prompt-title">Auto-complete <strong>${trainEsc(c.habit.name)}</strong> from now on?</div>
        <div class="train-habit-prompt-msg">Link it to Train · ${trainEsc(lib.name)} so future ${trainEsc(c.kind)} sessions mark it complete. Past completions stay as they were.</div>
      </div>
      <div class="train-habit-prompt-actions">
        <button class="train-btn-secondary" data-train-action="habit-link-dismiss" data-habit-id="${c.habit.id}">No thanks</button>
        <button class="train-btn-primary" data-train-action="habit-link" data-habit-id="${c.habit.id}" data-kind="${c.kind}">Link it</button>
      </div>
    </div>`;
  }).join('');
}

// Link a habit to a library kind. Persists via the existing saveHabitToDB
// path so any other client (or the Habits tab) refreshes via Supabase
// realtime. Also marks the habit complete for the just-submitted session's
// date so the auto-mark "catches up" the linking moment.
async function trainLinkHabitToLibrary(habitId, kind, sessionDate) {
  const habit = habitsArr.find(h => h.id === habitId);
  if (!habit) return;
  habit.libraryKind = kind;
  if (typeof saveHabitToDB === 'function') saveHabitToDB(habit);

  // Find the server-side habit_id for the completion insert.
  let habitSid = null;
  for (const [sid, cid] of habitRowIdMap) {
    if (cid === habit.id) { habitSid = sid; break; }
  }
  if (habitSid != null && sessionDate) {
    try {
      await db.from('habit_completions').upsert(
        { user_id: currentUser.id, habit_id: habitSid, completed_date: sessionDate },
        { onConflict: 'user_id,habit_id,completed_date', ignoreDuplicates: true }
      );
      if (typeof habitCompletions !== 'undefined' && Array.isArray(habitCompletions)
          && !habitCompletions.some(x => x.habitId === habitSid && x.completedDate === sessionDate)) {
        habitCompletions.push({
          id: -Date.now() - Math.random(),
          habitId: habitSid,
          completedDate: sessionDate,
        });
      }
    } catch (e) {
      console.warn('[train] habit link completion insert failed', e);
    }
  }
  if (typeof renderHabits === 'function') renderHabits();
  if (typeof refreshHomeData === 'function') refreshHomeData();
  renderTrain();
}

// ── Submit: persist session + sets and compute formulaic feedback ────────
async function trainSubmitTodaySession() {
  const st = _trainTodayState;
  if (st.submitting) return;
  st.submitting = true; renderTrain();
  try {
    const dayName = st.isBonus ? (st.bonusType === 'activity' ? 'Bonus Activity' : 'Bonus Lifting') : (st.day?.name || '');
    const dayType = st.isBonus ? (st.bonusType === 'activity' ? 'bonus' : 'bonus') : (st.day?.type || 'lift');

    // Bonus sessions can backfill the last 7 days; planned-day sessions
    // always use today's date.
    const sessionDate = st.isBonus ? (st.bonusDate || st.date) : st.date;
    const sessionInsert = {
      user_id:       currentUser.id,
      plan_id:       _trainState.activePlan?.id || null,
      session_date:  sessionDate,
      day_name:      dayName,
      day_type:      dayType,
      status:        'submitted',
      feel:          st.feel,
      session_notes: st.notes || null,
      submitted_at:  new Date().toISOString(),
    };
    const { data: session, error: sErr } = await db.from('workout_sessions')
      .insert(sessionInsert).select().single();
    if (sErr) throw sErr;

    // Build the rows to insert into workout_sets. Lift sessions: all entered
    // sets (whether or not "done" was checked, as long as reps were entered).
    // Cardio sessions: a single synthetic row recording duration + distance
    // (exercise_name = the modality). Activity Log: one row per activity.
    const setRows = [];
    if (st.isBonus && st.bonusType === 'activity') {
      st.bonusActivities.forEach((a, i) => {
        if (!a.name.trim() && !a.duration) return;
        setRows.push({
          session_id:    session.id,
          user_id:       currentUser.id,
          exercise_name: a.name.trim() || `Activity ${i + 1}`,
          set_index:     1,
          actual_reps:   Number(a.duration) || null,   // duration parked in reps for now
          actual_weight: null,
          is_bodyweight: true,
          completed_at:  new Date().toISOString(),
        });
      });
    } else if (st.day && st.day.type === 'cardio') {
      const dur  = Number(st.cardio.duration) || null;
      const dist = Number(st.cardio.distance) || null;
      setRows.push({
        session_id:    session.id,
        user_id:       currentUser.id,
        exercise_name: st.cardio.modality || 'Cardio',
        set_index:     1,
        actual_reps:   dur,           // minutes parked in reps
        actual_weight: dist,          // distance parked in weight
        is_bodyweight: true,
        completed_at:  new Date().toISOString(),
      });
    } else {
      // Lift session
      for (const exName of Object.keys(st.liftSets)) {
        const sets = st.liftSets[exName];
        sets.forEach((s, i) => {
          if (!s.reps && !s.weight) return;
          setRows.push({
            session_id:    session.id,
            user_id:       currentUser.id,
            exercise_name: exName,
            set_index:     i + 1,
            actual_reps:   Number(s.reps) || null,
            actual_weight: s.is_bodyweight ? null : (Number(s.weight) || null),
            is_bodyweight: !!s.is_bodyweight,
            completed_at:  new Date().toISOString(),
          });
        });
      }
    }

    if (setRows.length) {
      const { error: stErr } = await db.from('workout_sets').insert(setRows);
      if (stErr) throw stErr;
    }

    // Compute formulaic feedback inline. Cheap; everything we need is in
    // memory already. AI insight layer ships in commit 6.
    st.submittedFeedback = trainBuildFormulaicFeedback(st, setRows);
    // Stash the session row on the feedback object so the habit-link
    // prompt can read its day_type + session_date.
    st.submittedFeedback._session = session;
    // Phase 4 commit 4 — auto-mark any habit linked to the matching
    // library kind (lifting / cardio / activity). Idempotent via the
    // habit_completions unique constraint on (user_id, habit_id,
    // completed_date), so re-submits or manual marks before/after this
    // call don't create duplicates or overwrite anything.
    autoMarkLinkedHabitsForSession(session)
      .catch(err => console.warn('[train] auto-mark habits failed', err));
    st.submitting = false;
    renderTrain();
    // Refresh the last-session cache so the next session's render uses
    // these new numbers.
    loadLastSetsForActivePlan();
  } catch (e) {
    console.warn('[train] submit failed', e);
    st.submitting = false;
    renderTrain();
    showTrainToast('Submit failed — ' + (e.message || 'try again'));
  }
}

// Map a workout_sessions row to the habit_library kind(s) it should
// trigger. Returns an array (most sessions trigger exactly one kind, but
// the model leaves room for future multi-kind sessions).
function trainSessionToLibraryKinds(session) {
  const dayType = session.day_type;
  const dayName = String(session.day_name || '').toLowerCase();
  if (dayType === 'lift')   return ['lifting'];
  if (dayType === 'cardio') return ['cardio'];
  if (dayType === 'bonus') {
    if (dayName.includes('activity')) return ['activity'];
    return ['lifting'];   // Bonus Lifting
  }
  return [];
}

// Mark every habit whose library_kind matches this session as complete
// for the session's date. Uses upsert with ignoreDuplicates so the
// unique constraint on habit_completions never throws — and never
// overwrites a manual mark the user already toggled.
async function autoMarkLinkedHabitsForSession(session) {
  const kinds = trainSessionToLibraryKinds(session);
  if (!kinds.length) return;
  if (typeof habitsArr === 'undefined' || !Array.isArray(habitsArr)) return;

  const matches = habitsArr.filter(h =>
    !h.archived && h.libraryKind && kinds.includes(h.libraryKind)
  );
  if (!matches.length) return;

  // habit_completions.habit_id is the DB row id (bigint), not the
  // client-side id. Resolve via habitRowIdMap which holds server→client.
  const completions = [];
  for (const h of matches) {
    let habitSid = null;
    for (const [sid, cid] of habitRowIdMap) {
      if (cid === h.id) { habitSid = sid; break; }
    }
    if (habitSid == null) continue;
    completions.push({
      user_id:        currentUser.id,
      habit_id:       habitSid,
      completed_date: session.session_date,
    });
  }
  if (!completions.length) return;

  const { error } = await db.from('habit_completions').upsert(
    completions,
    { onConflict: 'user_id,habit_id,completed_date', ignoreDuplicates: true }
  );
  if (error) {
    console.warn('[train] auto-mark insert failed', error);
    return;
  }
  // Patch local habitCompletions so the Habits / Home cards reflect
  // immediately without a refetch. Skip rows we already have.
  if (typeof habitCompletions !== 'undefined' && Array.isArray(habitCompletions)) {
    for (const c of completions) {
      const exists = habitCompletions.some(x =>
        x.habitId === c.habit_id && x.completedDate === c.completed_date
      );
      if (!exists) {
        habitCompletions.push({
          id:             -Date.now() - Math.random(),   // temp id; realtime backfills
          habitId:        c.habit_id,
          completedDate:  c.completed_date,
        });
      }
    }
    if (typeof renderHabits === 'function') renderHabits();
    if (typeof refreshHomeData === 'function') refreshHomeData();
  }
  // Tier 1 brief recompute so the daily brief's habit row picks up
  // the new completion without a full reload.
  if (typeof homeBriefRecompute === 'function') homeBriefRecompute();
}

function trainBuildFormulaicFeedback(st, setRows) {
  // V1: simple stat grid + a couple of observations. Comparison vs last
  // session lands in commit 6 alongside the AI narrative.
  const stats = [];
  const observations = [];
  if (st.isBonus && st.bonusType === 'activity') {
    const totalMin = setRows.reduce((s, r) => s + (Number(r.actual_reps) || 0), 0);
    stats.push({ label: 'Activities', value: setRows.length });
    stats.push({ label: 'Total min',  value: totalMin });
    return {
      session_summary: `${setRows.length} activities · ${totalMin} min`,
      stats, observations,
    };
  }
  if (st.day && st.day.type === 'cardio') {
    const row = setRows[0] || {};
    const min  = Number(row.actual_reps)   || 0;
    const dist = Number(row.actual_weight) || 0;
    const pace = (dist > 0 && min > 0) ? (min / dist).toFixed(1) + ' min/mi' : '—';
    stats.push({ label: 'Minutes', value: min });
    stats.push({ label: 'Miles',   value: dist || '—' });
    stats.push({ label: 'Pace',    value: pace });
    if (dist) observations.push(`Pace was ${pace} — heart rate auto-syncs from your wearable when available.`);
    return {
      session_summary: `${st.cardio.modality || 'Cardio'} · ${min} min`,
      stats, observations,
    };
  }
  // Lift
  let totalSets = 0, totalVolume = 0;
  const prs = [];
  for (const row of setRows) {
    totalSets += 1;
    if (!row.is_bodyweight) totalVolume += (Number(row.actual_weight) || 0) * (Number(row.actual_reps) || 0);
    // PR check: compare this row's weight×reps to the last-session top set for the same exercise
    const last = (_trainState.lastSetsByExercise || {})[row.exercise_name];
    if (last && !row.is_bodyweight) {
      const lastTop = last.sets.reduce((max, s) =>
        ((s.actual_weight || 0) * (s.actual_reps || 0) > max
          ? (s.actual_weight || 0) * (s.actual_reps || 0)
          : max), 0);
      const thisVol = (Number(row.actual_weight) || 0) * (Number(row.actual_reps) || 0);
      if (thisVol > lastTop && lastTop > 0 && !prs.includes(row.exercise_name)) {
        prs.push(row.exercise_name);
      }
    }
  }
  stats.push({ label: 'Sets',          value: totalSets });
  stats.push({ label: 'Volume (lbs)',  value: totalVolume.toLocaleString() });
  stats.push({ label: 'Exercises',     value: Object.keys(st.liftSets || {}).filter(k => (st.liftSets[k] || []).some(s => s.reps)).length });
  if (prs.length) observations.push(`PR on ${prs.join(' + ')} (heaviest single set this week)`);
  if (st.feel === 1) observations.push("Great session feel. Keep the recovery dialed and progression should hold.");
  if (st.feel >= 4)  observations.push("Session felt rough. Check sleep / hydration; deload candidates if it persists 2+ weeks.");
  return {
    session_summary: `${st.day?.name || 'Session'} · ${totalSets} sets · ${totalVolume.toLocaleString()} lb volume`,
    stats, observations,
  };
}

function renderTrainProgress(root) {
  root.innerHTML = `
    <div class="train-shell">
      <div class="train-empty">
        <div class="train-empty-title">Progress</div>
        <div class="train-empty-msg">Body composition dashboard lands in commit 5.</div>
      </div>
    </div>`;
}

/* ── Styles (injected once) ──────────────────────────────────────────── */

function ensureTrainStyles() {
  if (document.getElementById('trainStyles')) return;
  const s = document.createElement('style');
  s.id = 'trainStyles';
  s.textContent = `
    #trainContainer { max-width: 720px; margin: 0 auto; padding: 2px 0 40px; }
    .train-shell { display: flex; flex-direction: column; gap: 14px; }
    .train-empty {
      background: var(--surface); border: 1px solid var(--edge);
      border-radius: var(--r-md); padding: 28px 18px;
      box-shadow: var(--shadow-card); text-align: center;
    }
    .train-empty-title {
      font-size: 16px; font-weight: 700; color: var(--ink);
      margin-bottom: 4px; letter-spacing: -0.01em;
    }
    .train-empty-msg { font-size: 13px; color: var(--ink-3); }

    /* Train subtab pill-bar (Plan / Today / Progress). Same chrome as
       habits sub-pills but recoloured to match the tab. */
    .train-sub-pills .train-pill {
      background: var(--surface); border: 1px solid var(--edge);
      color: var(--ink-3);
    }
    .train-sub-pills .train-pill.active {
      background: var(--ink); color: #fff; border-color: var(--ink);
    }

    /* ── Shared train tab chrome ──────────────────────────────────── */
    .train-loading, .train-error {
      background: var(--surface); border: 1px solid var(--edge);
      border-radius: var(--r-md); padding: 24px 18px;
      font-size: 13px; color: var(--ink-3); text-align: center;
      box-shadow: var(--shadow-card);
    }
    .train-error { color: var(--guava-700); }
    .train-retry {
      margin-left: 8px;
      background: var(--guava-700); color: #fff; border: 0;
      border-radius: var(--r-md); padding: 4px 10px;
      font-size: 12px; font-weight: 600; cursor: pointer;
      font-family: inherit;
    }
    .train-btn-primary {
      background: var(--guava-700); color: #fff; border: 0;
      border-radius: var(--r-md); padding: 8px 14px;
      font-family: inherit; font-size: 13px; font-weight: 600;
      cursor: pointer; white-space: nowrap;
    }
    .train-btn-primary:hover { background: var(--guava-800); }
    .train-btn-primary:disabled { background: var(--surface-2); color: var(--ink-4); cursor: not-allowed; }
    .train-btn-secondary {
      background: var(--surface); color: var(--ink-2);
      border: 1px solid var(--edge-strong); border-radius: var(--r-md);
      padding: 8px 14px; font-family: inherit; font-size: 13px; font-weight: 600;
      cursor: pointer; white-space: nowrap;
    }
    .train-btn-secondary:disabled { color: var(--ink-4); cursor: not-allowed; }
    .train-btn-link {
      background: none; border: 0; padding: 0; cursor: pointer;
      font-family: inherit; font-size: 12px; font-weight: 600;
      color: var(--guava-700);
    }

    /* ── Plan subtab: active plan card + week grid + today CTA ────── */
    .plan-active-card, .plan-empty-card {
      background: var(--surface); border: 1px solid var(--edge);
      border-radius: var(--r-md); padding: 16px;
      box-shadow: var(--shadow-card);
    }
    .plan-active-head {
      display: flex; align-items: baseline; justify-content: space-between;
      margin-bottom: 6px;
    }
    .plan-eyebrow {
      font-size: 10px; font-weight: 700; letter-spacing: .08em;
      color: var(--ink-4); text-transform: uppercase;
    }
    .plan-name {
      font-size: 17px; font-weight: 700; color: var(--ink);
      margin-bottom: 12px; letter-spacing: -0.01em;
    }
    .plan-week-grid {
      display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px;
      margin-bottom: 12px;
    }
    .plan-day {
      background: var(--surface); border: 1px solid var(--edge);
      border-radius: var(--r-sm); padding: 6px 4px;
      text-align: center; cursor: pointer; min-width: 0; overflow: hidden;
      display: flex; flex-direction: column; gap: 2px;
      min-height: 50px; justify-content: center;
      transition: background 0.12s ease;
    }
    .plan-day:hover { background: var(--surface-2); }
    .plan-day-dow {
      font-size: 9px; font-weight: 700; color: var(--ink-4);
      letter-spacing: .04em; text-transform: uppercase;
    }
    .plan-day-name {
      font-size: 10px; font-weight: 600; color: var(--ink-2);
      line-height: 1.2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .plan-day.is-today {
      background: var(--guava-50); border-color: var(--guava-700);
    }
    .plan-day.is-today .plan-day-name { color: var(--guava-700); font-weight: 700; }
    .plan-day.is-cardio .plan-day-name { color: var(--moss-fg, #5e8c4f); }
    .plan-day.is-cardio.is-today { background: var(--guava-50); border-color: var(--guava-700); }
    .plan-day.is-rest { background: var(--surface-2); }
    .plan-day.is-rest .plan-day-name { color: var(--ink-4); }

    .plan-today-card {
      background: var(--surface); border: 1px solid var(--edge);
      border-radius: var(--r-md); padding: 12px 14px;
      display: flex; align-items: center; gap: 12px;
    }
    .plan-today-icon {
      width: 36px; height: 36px; border-radius: 50%;
      background: var(--guava-50); color: var(--guava-700);
      display: flex; align-items: center; justify-content: center;
      font-size: 18px; flex-shrink: 0;
    }
    .plan-today-text { flex: 1; min-width: 0; }
    .plan-today-name { font-size: 14px; font-weight: 700; color: var(--ink); }
    .plan-today-meta { font-size: 11px; color: var(--ink-3); margin-top: 2px; }

    .plan-empty-card { text-align: center; padding: 28px 18px; }
    .plan-empty-title { font-size: 16px; font-weight: 700; color: var(--ink); margin-bottom: 4px; }
    .plan-empty-msg { font-size: 13px; color: var(--ink-3); line-height: 1.5; max-width: 380px; margin: 0 auto; }

    /* ── Plan templates list ─────────────────────────────────────── */
    .plan-templates-block { margin-top: 4px; }
    .plan-templates-label {
      font-size: 11px; font-weight: 700; letter-spacing: .08em;
      color: var(--ink-3); text-transform: uppercase; margin: 16px 0 8px 0;
    }
    .plan-template-card {
      background: var(--surface); border: 1px solid var(--edge);
      border-radius: var(--r-md); padding: 12px 14px;
      margin-bottom: 8px;
      display: grid; grid-template-columns: 1fr auto; gap: 12px;
      align-items: center;
      box-shadow: var(--shadow-card);
    }
    .plan-template-text { min-width: 0; }
    .plan-template-name { font-size: 14px; font-weight: 700; color: var(--ink); }
    .plan-template-meta {
      font-size: 11px; color: var(--ink-3); margin-top: 4px; line-height: 1.45;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .plan-templates-empty {
      background: var(--surface-2); border: 1px dashed var(--edge-strong);
      border-radius: var(--r-md); padding: 14px;
      font-size: 12px; color: var(--ink-4); line-height: 1.5;
      margin-top: 16px;
    }
    .plan-templates-empty code {
      background: var(--surface); padding: 2px 6px; border-radius: 3px;
      font-size: 11px; color: var(--ink-2);
    }

    /* ── Day detail modal ─────────────────────────────────────────── */
    .train-modal-overlay {
      position: fixed; inset: 0; background: rgba(20,15,10,0.45);
      backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
      display: flex; align-items: flex-start; justify-content: center;
      z-index: 1100; padding: 60px 16px 16px;
      overflow-y: auto;
    }
    .train-modal {
      background: var(--surface); border-radius: var(--r-lg);
      max-width: 480px; width: 100%; padding: 20px;
      box-shadow: var(--shadow-raised);
    }
    .train-modal-head {
      display: flex; align-items: flex-start; justify-content: space-between;
      margin-bottom: 12px;
    }
    .train-modal-close {
      background: none; border: 0; cursor: pointer; padding: 0 6px;
      font-size: 22px; line-height: 1; color: var(--ink-3);
    }
    .day-detail-dow {
      font-size: 11px; font-weight: 700; letter-spacing: .08em;
      color: var(--ink-4); text-transform: uppercase;
    }
    .day-detail-name {
      font-size: 18px; font-weight: 700; color: var(--ink);
      letter-spacing: -0.01em; margin-top: 2px;
    }
    .day-detail-badge {
      display: inline-block;
      font-size: 10px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase;
      padding: 3px 8px; border-radius: 999px;
      margin-bottom: 12px;
    }
    .day-detail-badge.is-lift   { background: var(--guava-50); color: var(--guava-700); }
    .day-detail-badge.is-cardio { background: var(--moss-bg, #eaf0e3); color: var(--moss-fg, #5e8c4f); }
    .day-detail-badge.is-bonus  { background: var(--guava-50); color: var(--guava-700); }
    .day-detail-badge.is-rest   { background: var(--surface-2); color: var(--ink-4); }
    .day-detail-ex {
      padding: 8px 0; border-top: 1px dashed var(--edge);
    }
    .day-detail-ex:first-child { border-top: 0; }
    .day-detail-ex-name { font-size: 13px; font-weight: 600; color: var(--ink); }
    .day-detail-ex-target { font-size: 11px; color: var(--ink-3); margin-top: 2px; }
    .day-detail-empty {
      font-size: 13px; color: var(--ink-4); padding: 14px 0;
      text-align: center;
    }

    /* ── Today subtab ───────────────────────────────────────────────── */
    .train-day-picker {
      display: grid; grid-template-columns: repeat(8, 1fr); gap: 4px;
      padding: 4px 0 14px;
    }
    /* Below 600px (most phones + the dev-preview side panel) the 8-pill
       row squeezes pill labels too tight. Drop to a 4×2 grid earlier so
       each pill has room for "Cardio / Rest" without truncation. */
    @media (max-width: 600px) {
      .train-day-picker { grid-template-columns: repeat(4, 1fr); }
    }
    .train-day-picker .day-pill-card {
      border: 1px solid var(--edge); border-radius: var(--r-md);
      background: var(--surface); padding: 6px 2px; cursor: pointer;
      text-align: center; min-width: 0; overflow: hidden;
      display: flex; flex-direction: column; gap: 1px;
    }
    .train-day-picker .day-pill-card.is-active {
      border-color: var(--guava-700); border-width: 2px; padding: 5px 1px;
    }
    .train-day-picker .day-pill-card.is-rest   { background: var(--surface-2); }
    .train-day-picker .day-pill-card.is-any    { border-style: dashed; background: var(--surface-2); }
    .train-day-picker .day-pill-dow {
      font-size: 9px; font-weight: 700; color: var(--ink-4);
      letter-spacing: .04em; text-transform: uppercase; line-height: 1.1;
    }
    .train-day-picker .day-pill-name {
      font-size: 10px; font-weight: 700; color: var(--ink); line-height: 1.15;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .train-day-picker .day-pill-card.is-active .day-pill-name { color: var(--guava-700); }
    .train-day-picker .day-pill-card.is-cardio .day-pill-name { color: var(--moss-fg, #5e8c4f); }
    .train-day-picker .day-pill-card.is-rest .day-pill-name   { color: var(--ink-4); }
    .train-day-picker .day-pill-card.is-any .day-pill-name    { color: var(--ink-3); }

    .train-today-body { display: flex; flex-direction: column; gap: 10px; }
    .ex-card {
      background: var(--surface); border: 1px solid var(--edge);
      border-radius: var(--r-md); padding: 12px 12px 8px;
      box-shadow: var(--shadow-card);
    }
    .ex-card-head {
      display: flex; align-items: flex-start; justify-content: space-between;
      gap: 10px; margin-bottom: 10px;
    }
    .ex-card-name { font-size: 14px; font-weight: 700; color: var(--ink); }
    .ex-card-meta { font-size: 11px; color: var(--ink-3); margin-top: 2px; }
    .ex-target {
      flex-shrink: 0;
      font-size: 10px; font-weight: 600;
      padding: 4px 10px; border-radius: 999px; white-space: nowrap;
    }
    .ex-target.target-up      { background: var(--moss-bg, #eaf0e3); color: var(--moss-fg, #5e8c4f); border: 1px solid var(--moss-edge, #c2d1aa); }
    .ex-target.target-hold    { background: var(--guava-50); color: var(--guava-700); border: 1px solid var(--guava-100); }
    .ex-target.target-warning { background: var(--amber-bg, #faf1dc); color: var(--amber-fg, #a87622); border: 1px solid var(--amber-edge, #e2c98c); }

    .ex-table-head {
      display: grid; grid-template-columns: 28px 80px 1fr 28px; gap: 8px;
      padding: 6px 0; border-bottom: 1px solid var(--edge);
      font-size: 9px; font-weight: 700; color: var(--ink-4);
      letter-spacing: .08em; text-transform: uppercase;
    }
    .ex-set-row {
      display: grid; grid-template-columns: 28px 80px 1fr 28px; gap: 8px;
      padding: 7px 0; align-items: center;
    }
    .ex-set-row + .ex-set-row { border-top: 1px dashed var(--edge); }
    .ex-set-num { font-size: 11px; font-weight: 700; color: var(--ink-3); }
    .ex-set-last { font-size: 11px; color: var(--ink-3); font-variant-numeric: tabular-nums; }
    .ex-set-today { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
    .ex-cell-input {
      background: var(--surface-2); border: 1px solid var(--edge);
      border-radius: var(--r-sm); padding: 5px 8px;
      font-family: inherit; font-size: 13px; color: var(--ink);
      width: 100%; text-align: center; box-sizing: border-box;
      font-variant-numeric: tabular-nums;
    }
    .ex-cell-input:focus {
      outline: none; background: var(--surface);
      border-color: var(--guava-700); box-shadow: 0 0 0 2px var(--guava-50);
    }
    .ex-cell-input.is-bw { color: var(--ink-4); }
    .ex-set-row.is-done .ex-cell-input { background: var(--moss-bg, #eaf0e3); color: var(--ink-2); }
    .ex-set-check {
      width: 22px; height: 22px; border-radius: 50%;
      border: 2px solid var(--edge-strong); background: var(--surface);
      cursor: pointer; padding: 0;
      display: flex; align-items: center; justify-content: center;
      font-family: inherit; font-size: 12px; color: transparent;
    }
    .ex-set-check.is-done {
      background: var(--moss-fg, #5e8c4f); border-color: var(--moss-fg, #5e8c4f);
      color: #fff;
    }

    /* Cardio card */
    .cardio-card {
      background: var(--surface); border: 1px solid var(--edge);
      border-radius: var(--r-md); padding: 14px; box-shadow: var(--shadow-card);
    }
    .cardio-card-head { margin-bottom: 12px; }
    .cardio-card-title { font-size: 14px; font-weight: 700; color: var(--ink); }
    .cardio-card-meta { font-size: 11px; color: var(--ink-3); margin-top: 2px; }
    .cardio-type-grid {
      display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px;
      margin-bottom: 12px;
    }
    .cardio-type-pill {
      background: var(--surface); border: 1px solid var(--edge);
      border-radius: var(--r-md); padding: 8px 4px;
      font-family: inherit; font-size: 12px; font-weight: 600; color: var(--ink-2);
      cursor: pointer; text-align: center;
      display: flex; flex-direction: column; align-items: center; gap: 2px;
    }
    .cardio-type-pill:hover { background: var(--surface-2); }
    .cardio-type-pill.is-selected {
      background: var(--moss-bg, #eaf0e3); border-color: var(--moss-fg, #5e8c4f); color: var(--moss-fg, #5e8c4f);
    }
    .cardio-type-emoji { font-size: 18px; line-height: 1; }
    .cardio-type-label { font-size: 10px; font-weight: 700; }
    .cardio-stats-grid {
      display: grid; grid-template-columns: 1fr 1fr; gap: 10px;
    }

    /* Bonus type toggle */
    .when-what-card {
      background: var(--surface); border: 1px solid var(--edge);
      border-radius: var(--r-md); padding: 14px;
    }
    .when-what-label {
      font-size: 11px; font-weight: 700; letter-spacing: .08em;
      color: var(--ink-3); text-transform: uppercase; margin-bottom: 8px;
    }
    .session-type-row { display: flex; gap: 8px; }
    .session-type-pill {
      background: var(--surface-2); color: var(--ink-3);
      border: 1px solid var(--edge); border-radius: 999px;
      padding: 7px 14px; font-family: inherit; font-size: 13px; font-weight: 600;
      cursor: pointer;
    }
    .session-type-pill.is-active {
      background: var(--moss-bg, #eaf0e3); border-color: var(--moss-fg, #5e8c4f); color: var(--moss-fg, #5e8c4f);
    }
    /* Bonus backfill date picker (last 7 days). Horizontally scrolls on
       very narrow widths but on standard mobile the 7 pills fit. */
    .bonus-date-row {
      display: flex; gap: 6px; flex-wrap: wrap;
    }
    .bonus-date-pill {
      background: var(--surface); color: var(--ink-3);
      border: 1px solid var(--edge); border-radius: var(--r-md);
      padding: 6px 10px; font-family: inherit; font-size: 12px; font-weight: 600;
      cursor: pointer; white-space: nowrap;
    }
    .bonus-date-pill:hover { background: var(--surface-2); }
    .bonus-date-pill.is-active {
      background: var(--guava-50); border-color: var(--guava-700); color: var(--guava-700);
    }

    /* Activity Log rows */
    .activity-row {
      display: grid; grid-template-columns: 1fr 100px 30px; gap: 8px;
      align-items: end; padding: 8px 0;
    }
    .activity-row + .activity-row { border-top: 1px dashed var(--edge); }
    .activity-row-add {
      width: 100%;
      background: var(--surface); border: 1px dashed var(--edge-strong);
      border-radius: var(--r-md); padding: 10px;
      font-family: inherit; font-size: 12px; font-weight: 600;
      color: var(--moss-fg, #5e8c4f); cursor: pointer; margin-top: 8px;
    }
    .activity-row-remove {
      background: none; border: 0; cursor: pointer;
      color: var(--ink-4); font-size: 18px; line-height: 1;
      padding: 8px 4px;
    }

    /* Session footer */
    .train-session-footer {
      background: var(--surface-2); border-radius: var(--r-md);
      padding: 14px; margin-top: 6px;
    }
    .train-footer-label {
      font-size: 10px; font-weight: 700; letter-spacing: .08em;
      color: var(--ink-3); text-transform: uppercase; margin-bottom: 6px;
    }
    .train-notes-input {
      width: 100%; min-height: 56px; box-sizing: border-box;
      background: var(--surface); border: 1px solid var(--edge);
      border-radius: var(--r-sm); padding: 8px 10px;
      font-family: inherit; font-size: 12px; color: var(--ink);
      resize: vertical;
    }
    .train-feel-block { margin-top: 12px; }
    .train-mood-grid {
      display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px;
      margin-top: 6px;
    }
    .mood-btn {
      display: flex; flex-direction: column; align-items: center; gap: 3px;
      background: var(--surface); border: 1px solid var(--edge);
      border-radius: var(--r-md); padding: 8px 4px;
      font-family: inherit; cursor: pointer;
    }
    .mood-btn:hover { background: var(--surface-2); }
    .mood-btn.is-selected { background: var(--guava-50); border-color: var(--guava-700); }
    .mood-emoji { font-size: 20px; line-height: 1; }
    .mood-label {
      font-size: 9px; font-weight: 700; color: var(--ink-4);
      letter-spacing: .04em; text-transform: uppercase;
    }
    .train-totals {
      display: flex; gap: 18px; margin-top: 12px; align-items: baseline;
    }
    .train-total-num { font-size: 18px; font-weight: 800; color: var(--ink); }
    .train-total-label {
      font-size: 9px; font-weight: 700; letter-spacing: .08em;
      color: var(--ink-4); text-transform: uppercase;
    }
    .train-submit-btn {
      width: 100%; background: var(--guava-700); color: #fff;
      border: 0; border-radius: var(--r-md);
      padding: 13px 16px; font-family: inherit; font-size: 14px; font-weight: 700;
      cursor: pointer; margin-top: 14px;
    }
    .train-submit-btn:hover { background: var(--guava-800); }
    .train-submit-btn:disabled { background: var(--ink-4); cursor: progress; }

    /* Form-field reused inside cardio + activity rows */
    .form-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
    .form-label {
      font-size: 10px; font-weight: 700; color: var(--ink-3);
      letter-spacing: .05em; text-transform: uppercase;
    }
    .form-input {
      width: 100%; box-sizing: border-box;
      background: var(--surface); border: 1px solid var(--edge);
      border-radius: var(--r-md); padding: 8px 10px;
      font-family: inherit; font-size: 13px; color: var(--ink);
    }
    .form-input:focus {
      outline: none; border-color: var(--guava-700);
      box-shadow: 0 0 0 2px var(--guava-50);
    }

    /* Feedback panel after submit */
    .fb-stats-grid {
      display: grid; grid-template-columns: repeat(auto-fit, minmax(70px, 1fr)); gap: 8px;
      margin: 10px 0;
    }
    .fb-stat {
      background: var(--surface-2); border-radius: var(--r-sm);
      padding: 10px 8px; text-align: center;
    }
    .fb-stat-num {
      font-size: 18px; font-weight: 800; color: var(--guava-700);
      font-variant-numeric: tabular-nums; line-height: 1;
    }
    .fb-stat-label {
      font-size: 9px; font-weight: 700; letter-spacing: .05em;
      color: var(--ink-4); text-transform: uppercase; margin-top: 4px;
    }
    .fb-observations {
      list-style: none; padding: 0; margin: 8px 0 0;
      font-size: 12px; color: var(--ink-2); line-height: 1.55;
    }
    .fb-observations li {
      padding: 6px 10px; background: var(--guava-50); border-left: 3px solid var(--guava-700);
      border-radius: var(--r-sm); margin-bottom: 6px;
    }

    /* Habit library link prompt (post-submit banner). Offers to wire an
       existing user habit ("Cardio", "Lifting") to auto-complete from
       this session type going forward. */
    .train-habit-prompt {
      display: grid; grid-template-columns: 38px 1fr; gap: 12px;
      background: var(--moss-bg, #eaf0e3);
      border: 1px solid var(--moss-edge, #c2d1aa);
      border-radius: var(--r-md); padding: 12px;
      margin-top: 12px;
    }
    .train-habit-prompt-icon {
      width: 38px; height: 38px; border-radius: 50%;
      background: var(--surface);
      border: 1px solid var(--moss-edge, #c2d1aa);
      display: flex; align-items: center; justify-content: center;
      font-size: 18px;
    }
    .train-habit-prompt-body {
      min-width: 0; display: flex; flex-direction: column; gap: 4px;
    }
    .train-habit-prompt-title { font-size: 13px; font-weight: 600; color: var(--ink); }
    .train-habit-prompt-msg { font-size: 11px; color: var(--ink-3); line-height: 1.45; }
    .train-habit-prompt-actions {
      grid-column: 1 / -1;
      display: flex; gap: 8px; justify-content: flex-end;
      margin-top: 4px;
    }
    .train-habit-prompt-actions .train-btn-secondary,
    .train-habit-prompt-actions .train-btn-primary {
      padding: 6px 12px; font-size: 12px;
    }
  `;
  document.head.appendChild(s);
}

/* ════════════════════════════════════════════════════════════════════════
   DETERMINISTIC MATH — used across all subtabs.

   These are pure functions with no AI calls. Anywhere a number is shown
   in the Train tab (calorie target, body fat %, macros, time-to-goal,
   progress %) it traces back to one of these. The cumulative source of
   truth.
════════════════════════════════════════════════════════════════════════ */

/* Mifflin-St Jeor basal metabolic rate (cal/day). */
function trainBMR(sex, weightLbs, heightInches, ageYears) {
  if (sex == null || weightLbs == null || heightInches == null || ageYears == null) return null;
  const kg = Number(weightLbs) * 0.45359237;
  const cm = Number(heightInches) * 2.54;
  const sexOffset = (String(sex).toLowerCase() === 'female') ? -161 : 5;
  return Math.round(10 * kg + 6.25 * cm - 5 * Number(ageYears) + sexOffset);
}

/* Activity multipliers for total daily energy expenditure. */
const TRAIN_ACTIVITY = {
  sedentary:   { mult: 1.2,   label: 'Sedentary',   desc: 'Desk job, little or no exercise' },
  light:       { mult: 1.375, label: 'Light',       desc: 'Light exercise 1-3 days/week' },
  moderate:    { mult: 1.55,  label: 'Moderate',    desc: 'Moderate exercise 3-5 days/week' },
  active:      { mult: 1.725, label: 'Active',      desc: 'Heavy exercise 6-7 days/week' },
  very_active: { mult: 1.9,   label: 'Very active', desc: 'Heavy daily + physical job / 2× day' },
};

function trainTDEE(bmr, activityLevel) {
  if (bmr == null || !TRAIN_ACTIVITY[activityLevel]) return null;
  return Math.round(bmr * TRAIN_ACTIVITY[activityLevel].mult);
}

/* Daily calorie target for a weight goal: TDEE − deficit. 3500 cal ≈ 1 lb.
   Returns { tdee, deficit_per_day, daily_target }. Negative weight_delta
   (gaining) flips to a surplus. */
function trainCalorieTargetForGoal(tdee, currentLbs, targetLbs, startDate, endDate) {
  if (tdee == null || currentLbs == null || targetLbs == null) return null;
  const days = Math.max(1, Math.round((new Date(endDate) - new Date(startDate)) / 86400_000));
  const deltaLbs = Number(currentLbs) - Number(targetLbs);  // positive = losing
  const deficitPerDay = Math.round((deltaLbs * 3500) / days);
  return {
    tdee:            tdee,
    deficit_per_day: deficitPerDay,
    daily_target:    Math.round(tdee - deficitPerDay),
    days_to_goal:    days,
  };
}

/* Macro split: protein 1g/lb bodyweight, fat 30% of daily calories,
   carbs fill the remainder. Returns grams per macro + percent of daily. */
function trainMacros(dailyCalories, weightLbs) {
  if (dailyCalories == null || weightLbs == null) return null;
  const proteinG = Math.round(Number(weightLbs));     // 1 g per lb
  const proteinCal = proteinG * 4;
  const fatCal = Math.round(dailyCalories * 0.30);
  const fatG = Math.round(fatCal / 9);
  const carbCal = dailyCalories - proteinCal - fatCal;
  const carbG = Math.round(carbCal / 4);
  return {
    protein: { g: proteinG, pct: Math.round((proteinCal / dailyCalories) * 100) },
    fat:     { g: fatG,     pct: Math.round((fatCal     / dailyCalories) * 100) },
    carbs:   { g: carbG,    pct: Math.round((carbCal    / dailyCalories) * 100) },
  };
}

/* U.S. Navy body-fat formula. Requires neck + waist + height (in inches).
   For women, hips is required as well. Returns percent or null when any
   input is missing. */
function trainNavyBodyFat(sex, neckIn, waistIn, hipsIn, heightIn) {
  if (neckIn == null || waistIn == null || heightIn == null) return null;
  const isFemale = String(sex).toLowerCase() === 'female';
  if (isFemale && hipsIn == null) return null;
  const log10 = Math.log10 || (x => Math.log(x) / Math.LN10);
  let pct;
  if (isFemale) {
    // 163.205·log10(waist + hips − neck) − 97.684·log10(height) − 78.387
    pct = 163.205 * log10(Number(waistIn) + Number(hipsIn) - Number(neckIn))
          - 97.684 * log10(Number(heightIn))
          - 78.387;
  } else {
    // 86.010·log10(waist − neck) − 70.041·log10(height) + 36.76
    pct = 86.010 * log10(Number(waistIn) - Number(neckIn))
          - 70.041 * log10(Number(heightIn))
          + 36.76;
  }
  if (!Number.isFinite(pct)) return null;
  return Math.round(pct * 10) / 10;   // 1 decimal place
}

/* Age in years from a YYYY-MM-DD date of birth. */
function trainAgeYears(dob) {
  if (!dob) return null;
  const d = new Date(dob);
  if (isNaN(d.getTime())) return null;
  const now = new Date();
  let years = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) years -= 1;
  return years;
}

/* Suggest activity level from logged session frequency. Maps sessions/week
   over the last 28 days to a TRAIN_ACTIVITY key. */
function trainSuggestActivityLevel(sessionsLast28Days) {
  const n = Number(sessionsLast28Days || 0);
  const perWeek = n / 4;
  if (perWeek < 1)   return 'sedentary';
  if (perWeek < 3)   return 'light';
  if (perWeek < 6)   return 'moderate';
  if (perWeek <= 7)  return 'active';
  return 'very_active';
}

/* Progress % toward a goal value: (start − current) / (start − target). */
function trainProgressPct(startValue, currentValue, targetValue) {
  const a = Number(startValue), b = Number(currentValue), c = Number(targetValue);
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) return null;
  const denom = a - c;
  if (denom === 0) return 100;
  return Math.round(((a - b) / denom) * 100);
}

// Exposed on window so the legacy /src/* render path (which doesn't see
// const declarations from beta/src/*) can call this at switchTool time.
if (typeof window !== 'undefined') {
  window.renderTrain = renderTrain;
  window.trainBMR = trainBMR;
  window.trainTDEE = trainTDEE;
  window.trainCalorieTargetForGoal = trainCalorieTargetForGoal;
  window.trainMacros = trainMacros;
  window.trainNavyBodyFat = trainNavyBodyFat;
  window.trainAgeYears = trainAgeYears;
  window.trainSuggestActivityLevel = trainSuggestActivityLevel;
  window.trainProgressPct = trainProgressPct;
}

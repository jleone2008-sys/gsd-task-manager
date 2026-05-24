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
  // Recent-session cache so the Today picker can surface sessions that
  // were already logged for the date currently being viewed (e.g. a
  // Saturday bonus). Last 14 days, refreshed after each submit.
  sessionsByDate: {},    // 'YYYY-MM-DD' → [session row, …]
  setsBySession:  {},    // session_id → [set row, …]
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
      st.bonusModality = null;
      st.bonusDuration = '';
      st.submittedFeedback = null;
      renderTrain();
      return;
    }
    if (action === 'bonus-date') {
      _trainTodayState.bonusDate = actionEl.dataset.date;
      renderTrain();
      return;
    }
    if (action === 'bonus-modality') {
      _trainTodayState.bonusModality = actionEl.dataset.modality;
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

    // ── Progress subtab actions ────────────────────────────────────
    if (action === 'progress-reload') {
      _trainProgressState.loaded = false;
      loadTrainProgressData();
      return;
    }
    if (action === 'progress-edit-profile') {
      _trainProgressState.wizardDraft = null;
      _trainProgressState.view = 'wizard';
      renderTrain();
      return;
    }
    if (action === 'progress-new-entry') {
      _trainProgressState.entryDraft = null;
      _trainProgressState.view = 'new-entry';
      renderTrain();
      return;
    }
    if (action === 'progress-edit-goal') {
      const kind = actionEl.dataset.kind;
      _trainProgressState.goalDraft = null;
      ensureGoalDraft(kind);
      _trainProgressState.view = 'goal';
      renderTrain();
      return;
    }
    if (action === 'progress-back') {
      _trainProgressState.view = 'dashboard';
      _trainProgressState.entryDraft = null;
      _trainProgressState.goalDraft  = null;
      renderTrain();
      return;
    }
    if (action === 'progress-detail') {
      // V1: detail view is the dashboard's recent-entries row. Open the
      // edit form pre-filled so the user can correct or extend the entry.
      const id = actionEl.dataset.id;
      const entry = _trainProgressState.entries.find(e => e.id === id);
      if (entry) {
        _trainProgressState.entryDraft = {
          captured_date: entry.captured_date,
          weight_lbs:    entry.weight_lbs   != null ? String(entry.weight_lbs)   : '',
          neck_in:       entry.neck_in      != null ? String(entry.neck_in)      : '',
          waist_in:      entry.waist_in     != null ? String(entry.waist_in)     : '',
          chest_in:      entry.chest_in     != null ? String(entry.chest_in)     : '',
          arms_in:       entry.arms_in      != null ? String(entry.arms_in)      : '',
          hips_in:       entry.hips_in      != null ? String(entry.hips_in)      : '',
          thighs_in:     entry.thighs_in    != null ? String(entry.thighs_in)    : '',
          notes:         entry.notes        || '',
        };
        _trainProgressState.view = 'new-entry';
        renderTrain();
      }
      return;
    }

    // Wizard pills
    if (action === 'wizard-sex') {
      ensureWizardDraft();
      _trainProgressState.wizardDraft.sex = actionEl.dataset.val;
      renderTrain();
      return;
    }
    if (action === 'wizard-activity') {
      ensureWizardDraft();
      _trainProgressState.wizardDraft.activity_level = actionEl.dataset.val;
      renderTrain();
      return;
    }
    if (action === 'wizard-save')   { saveWizardProfile(); return; }
    if (action === 'wizard-cancel') {
      _trainProgressState.wizardDraft = null;
      _trainProgressState.view = 'dashboard';
      renderTrain();
      return;
    }

    if (action === 'entry-save') { saveProgressEntry(); return; }
    if (action === 'goal-save')   { saveProgressGoal(); return; }
    if (action === 'goal-delete') { deleteProgressGoal(); return; }
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
    if (action === 'bonus-duration')  { _trainTodayState.bonusDuration  = v; return; }

    // ── Progress subtab inputs ────────────────────────────────────
    if (action === 'wizard-dob') {
      ensureWizardDraft();
      _trainProgressState.wizardDraft.dob = v;
      return;
    }
    if (action === 'wizard-height') {
      ensureWizardDraft();
      _trainProgressState.wizardDraft.height_in = v;
      return;
    }
    if (action === 'entry-input') {
      ensureEntryDraft();
      const key = el.dataset.key;
      _trainProgressState.entryDraft[key] = v;
      // For neck / waist / hips, re-render so the live BF preview updates.
      if (['neck_in','waist_in','hips_in'].includes(key)) renderTrain();
      return;
    }
    if (action === 'goal-input') {
      if (!_trainProgressState.goalDraft) return;
      _trainProgressState.goalDraft[el.dataset.key] = v;
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
  // Bonus mode (Phase 4 follow-up): a single icon-grid picker mirroring
  // the Cardio modality grid. 7 presets + Other. Duration only — no
  // sets/reps/distance/name fields. Each preset maps to a library kind
  // (lifting / cardio / activity) so habit-link auto-mark still works.
  bonusModality: null,
  bonusDuration: '',
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
  _trainTodayState.bonusModality = null;
  _trainTodayState.bonusDuration = '';
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

// Fetch the last 14 days of workout_sessions + their sets so the Today
// picker can show "already logged for this date" cards. The day picker
// otherwise re-renders the plan template for every pill, which made
// previously-logged bonus sessions invisible. Cheap query: ≤ ~30 rows
// total for most users.
async function loadRecentTrainSessions() {
  try {
    const today = trainTodayLocalDate();
    const since = trainShiftDate(today, -13);   // 14-day window inclusive
    const { data: sessions, error: sErr } = await db.from('workout_sessions')
      .select('id,session_date,day_name,day_type,feel,session_notes,plan_id,submitted_at,status')
      .eq('user_id', currentUser.id)
      .gte('session_date', since)
      .lte('session_date', today)
      .order('submitted_at', { ascending: false });
    if (sErr) throw sErr;

    const byDate = {};
    const sessionIds = [];
    for (const row of sessions || []) {
      if (!byDate[row.session_date]) byDate[row.session_date] = [];
      byDate[row.session_date].push(row);
      sessionIds.push(row.id);
    }

    const setsBySession = {};
    if (sessionIds.length) {
      const { data: sets, error: stErr } = await db.from('workout_sets')
        .select('session_id,exercise_name,set_index,actual_weight,actual_reps,is_bodyweight,completed_at')
        .in('session_id', sessionIds)
        .order('set_index', { ascending: true });
      if (stErr) throw stErr;
      for (const row of sets || []) {
        if (!setsBySession[row.session_id]) setsBySession[row.session_id] = [];
        setsBySession[row.session_id].push(row);
      }
    }
    _trainState.sessionsByDate = byDate;
    _trainState.setsBySession  = setsBySession;
  } catch (e) {
    console.warn('[train] load recent sessions failed', e);
    _trainState.sessionsByDate = {};
    _trainState.setsBySession  = {};
  }
}

// The date the Today subtab is currently displaying. Bonus mode uses the
// explicit bonusDate picker; planned-day pills are interpreted as "the
// nearest occurrence of that DOW going backward" so tapping Sat shows
// last Saturday's logged session if today is e.g. Wed.
function trainCurrentViewDate(st) {
  if (!st) return null;
  if (st.isBonus) return st.bonusDate || st.date;
  if (!st.selectedDow) return st.date;
  const todayDow = trainTodayDow();
  if (st.selectedDow === todayDow) return st.date;
  // Walk back up to 6 days to find the most recent occurrence of selectedDow.
  for (let i = 1; i <= 7; i++) {
    const d = trainShiftDate(st.date, -i);
    const [y, m, day] = d.split('-').map(Number);
    const dow = DOW_ORDER[(new Date(y, m - 1, day).getDay() + 6) % 7];
    if (dow === st.selectedDow) return d;
  }
  return st.date;
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
  // Lazy-fetch the last-14-days session list so the date currently being
  // viewed (planned-day or bonus) surfaces any already-logged sessions.
  if (!_trainState.sessionsLoaded) {
    _trainState.sessionsLoaded = true;
    loadRecentTrainSessions().then(() => renderTrain());
  }

  const st = _trainTodayState;
  const dayPickerHtml = renderTodayDayPicker(st);

  // If there are already-logged sessions for the date the user is viewing,
  // surface them above the form so a bonus they logged on Saturday isn't
  // "lost" when they tap the Sat pill again.
  const viewDate = trainCurrentViewDate(st);
  const loggedSessions = (viewDate && _trainState.sessionsByDate)
    ? (_trainState.sessionsByDate[viewDate] || [])
    : [];
  const loggedBanner = (!st.submittedFeedback && loggedSessions.length)
    ? renderTodayLoggedSessions(loggedSessions, viewDate, st.date)
    : '';

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
    ${loggedBanner}
    ${body}
    ${footer}
  </div>`;
}

// Read-only summary cards for sessions already logged on the viewed date.
// Each card shows the session's day_name + day_type badge, a one-line
// summary of the sets, and the optional notes/feel. Below it lives the
// usual "log another session" form so users can add a second activity.
function renderTodayLoggedSessions(sessions, viewDate, todayStr) {
  const label = trainDateLabel(viewDate, todayStr);
  const typeBadge = {
    lift:   { txt: 'Lift',   cls: 'is-lift'   },
    cardio: { txt: 'Cardio', cls: 'is-cardio' },
    bonus:  { txt: 'Bonus',  cls: 'is-bonus'  },
    rest:   { txt: 'Rest',   cls: 'is-rest'   },
  };
  const cards = sessions.map(s => {
    const sets = (_trainState.setsBySession || {})[s.id] || [];
    let summary;
    if (s.day_type === 'cardio') {
      const row  = sets[0] || {};
      const dur  = row.actual_reps;
      const dist = row.actual_weight;
      summary = `${row.exercise_name || 'Cardio'} · ${dur != null ? dur + ' min' : '—'}${dist != null ? ' · ' + dist + ' mi' : ''}`;
    } else if (s.day_type === 'bonus') {
      // Phase-4 follow-up bonus shape: one row, exercise_name = preset label,
      // actual_reps = duration. Legacy bonus rows (old Activity-Log shape with
      // multiple rows) fall back to "N activities" totals.
      if (sets.length === 1) {
        const row = sets[0];
        summary = `${row.exercise_name || 'Activity'} · ${row.actual_reps != null ? row.actual_reps + ' min' : '—'}`;
      } else {
        const total = sets.reduce((acc, r) => acc + (Number(r.actual_reps) || 0), 0);
        summary = `${sets.length} activit${sets.length === 1 ? 'y' : 'ies'} · ${total} min`;
      }
    } else {
      // Lift / bonus lifting
      const exerciseNames = Array.from(new Set(sets.map(r => r.exercise_name)));
      const volume = sets.reduce((acc, r) => {
        if (r.is_bodyweight) return acc;
        return acc + (Number(r.actual_weight) || 0) * (Number(r.actual_reps) || 0);
      }, 0);
      summary = `${sets.length} set${sets.length === 1 ? '' : 's'} across ${exerciseNames.length} lift${exerciseNames.length === 1 ? '' : 's'}${volume ? ' · ' + volume.toLocaleString() + ' lbs vol' : ''}`;
    }
    const badge = typeBadge[s.day_type] || { txt: s.day_type, cls: '' };
    const feel = (typeof s.feel === 'number')
      ? ['🤩','😊','😐','😔','😢'][s.feel - 1] || ''
      : '';
    const notes = s.session_notes
      ? `<div class="logged-session-notes">${trainEsc(s.session_notes)}</div>`
      : '';
    return `<div class="logged-session-card">
      <div class="logged-session-head">
        <div class="logged-session-name">${trainEsc(s.day_name)} ${feel ? `<span class="logged-session-feel">${feel}</span>` : ''}</div>
        <span class="day-detail-badge ${badge.cls}">${badge.txt}</span>
      </div>
      <div class="logged-session-summary">${trainEsc(summary)}</div>
      ${notes}
    </div>`;
  }).join('');
  return `<div class="logged-session-block">
    <div class="logged-session-label">Already logged · ${trainEsc(label)}</div>
    ${cards}
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

// 7 preset activities + Other for the Bonus picker. Mirrors the Cardio
// modality grid. Each preset maps to a habit_library kind so submitting
// auto-marks the right linked habit (lifting / cardio / activity).
const TRAIN_BONUS_PRESETS = [
  { key: 'Lift',  emoji: '🏋️', kind: 'lifting'  },
  { key: 'Run',   emoji: '🏃',  kind: 'cardio'   },
  { key: 'Bike',  emoji: '🚴',  kind: 'cardio'   },
  { key: 'Walk',  emoji: '🚶',  kind: 'activity' },
  { key: 'Hike',  emoji: '🥾',  kind: 'activity' },
  { key: 'Climb', emoji: '🧗',  kind: 'activity' },
  { key: 'Yoga',  emoji: '🧘',  kind: 'activity' },
  { key: 'Other', emoji: '⋯',   kind: 'activity' },
];

function trainBonusKindFor(modality) {
  const p = TRAIN_BONUS_PRESETS.find(x => x.key === modality);
  return p ? p.kind : 'activity';
}

function renderTodayBonus(st) {
  const today = st.date;
  // 7-day backfill picker: today + 6 days back.
  const dateOpts = [];
  for (let i = 0; i < 7; i++) {
    const d = trainShiftDate(today, -i);
    dateOpts.push({ date: d, label: trainDateLabel(d, today) });
  }
  const datePills = dateOpts.map(o => `
    <button class="bonus-date-pill ${st.bonusDate === o.date ? 'is-active' : ''}" data-train-action="bonus-date" data-date="${o.date}">
      ${trainEsc(o.label)}
    </button>`).join('');

  // Activity picker — mirrors the cardio modality grid.
  const pills = TRAIN_BONUS_PRESETS.map(p => `
    <button class="cardio-type-pill ${st.bonusModality === p.key ? 'is-selected' : ''}" data-train-action="bonus-modality" data-modality="${p.key}">
      <span class="cardio-type-emoji">${p.emoji}</span>
      <span class="cardio-type-label">${p.key}</span>
    </button>`).join('');

  return `<div class="train-today-body">
    <div class="when-what-card" style="margin-bottom:12px">
      <div class="when-what-label">When</div>
      <div class="bonus-date-row">${datePills}</div>
    </div>
    <div class="cardio-card">
      <div class="cardio-card-head">
        <div class="cardio-card-title">Pick an activity</div>
        <div class="cardio-card-meta">Tap a preset, then log how long. Anything off-program — hikes, walks, climbing, pickup lifts.</div>
      </div>
      <div class="cardio-type-grid">${pills}</div>
      <div class="cardio-stats-grid" style="grid-template-columns:1fr">
        <div class="form-field">
          <label class="form-label">Duration (min)</label>
          <input class="form-input" type="text" inputmode="numeric" placeholder="30" value="${trainEsc(st.bonusDuration)}" data-train-action="bonus-duration">
        </div>
      </div>
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
  if (st.isBonus) {
    const mins = Number(st.bonusDuration) || 0;
    return {
      left:  { num: st.bonusModality || '—', label: 'Activity' },
      right: { num: mins, label: 'Minutes' },
    };
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
    const dayName = st.isBonus
      ? `Bonus ${st.bonusModality || 'Activity'}`
      : (st.day?.name || '');
    const dayType = st.isBonus ? 'bonus' : (st.day?.type || 'lift');

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
    if (st.isBonus) {
      // Single row: exercise_name = preset label, actual_reps = duration.
      setRows.push({
        session_id:    session.id,
        user_id:       currentUser.id,
        exercise_name: st.bonusModality || 'Activity',
        set_index:     1,
        actual_reps:   Number(st.bonusDuration) || null,
        actual_weight: null,
        is_bodyweight: true,
        completed_at:  new Date().toISOString(),
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
    // Also refresh the recent-sessions cache so the "Already logged" banner
    // picks up this submission when the user navigates back to its date.
    loadRecentTrainSessions().then(() => renderTrain());
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
  if (dayType === 'lift')     return ['lifting'];
  if (dayType === 'cardio')   return ['cardio'];
  if (dayType === 'progress') return ['progress'];
  if (dayType === 'bonus') {
    // day_name is "Bonus <Modality>". Pull the modality back out and
    // look up its kind from TRAIN_BONUS_PRESETS so the source-of-truth
    // mapping lives in one place.
    const m = String(session.day_name || '').replace(/^bonus\s+/i, '');
    return [trainBonusKindFor(m)];
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
  if (st.isBonus) {
    const min = Number(st.bonusDuration) || 0;
    stats.push({ label: 'Activity', value: st.bonusModality || '—' });
    stats.push({ label: 'Minutes',  value: min });
    return {
      session_summary: `${st.bonusModality || 'Activity'} · ${min} min`,
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

/* ════════════════════════════════════════════════════════════════════════
   PROGRESS SUBTAB — body composition dashboard.

   Flow:
     1. First visit → setup wizard collects sex / DOB / height / activity.
        These four feed Mifflin-St Jeor BMR and the TDEE multiplier.
     2. After setup → dashboard: latest entry stats, BMR/TDEE/calorie
        target, macros, optional active goal with progress bar, and the
        last 5 logged entries.
     3. "Log new entry" → full-page form (weight + measurements + notes).
        Submit inserts a progress_pics row and auto-marks any habit linked
        to library kind 'progress' for that date.

   Everything in this subtab traces to a pure function in the
   deterministic-math block at the bottom of this file. No AI calls —
   the AI vision layer for actual photos lands alongside commit 6.
════════════════════════════════════════════════════════════════════════ */

const _trainProgressState = {
  loaded:        false,
  loading:       false,
  error:         null,
  profile:       null,     // { sex, dob, height_in, activity_level, activity_level_override, units }
  entries:       [],       // last 90 days of progress_pics rows, desc by captured_date
  goals:         [],       // active body_comp_goals rows
  view:          'dashboard', // 'dashboard' | 'wizard' | 'new-entry' | 'goal'
  // In-flight new-entry form state — survives action handler renders.
  entryDraft:    null,     // { captured_date, weight_lbs, neck_in, waist_in, … }
  // In-flight wizard state.
  wizardDraft:   null,     // { sex, dob, height_in, activity_level }
  // In-flight goal-editor state.
  goalDraft:     null,     // { kind, start_value, target_value, end_date }
  saving:        false,
};

async function loadTrainProgressData() {
  _trainProgressState.loading = true;
  _trainProgressState.error   = null;
  try {
    const since = trainShiftDate(trainTodayLocalDate(), -90);

    const [profRes, entryRes, goalRes] = await Promise.all([
      db.from('user_profiles')
        .select('sex,dob,height_in,activity_level,activity_level_override,units,body_comp_profile_set_at')
        .eq('supabase_user_id', currentUser.id)
        .maybeSingle(),
      db.from('progress_pics')
        .select('id,captured_date,weight_lbs,neck_in,waist_in,chest_in,arms_in,hips_in,thighs_in,notes,body_fat_pct,body_fat_method,body_fat_confidence')
        .eq('user_id', currentUser.id)
        .gte('captured_date', since)
        .order('captured_date', { ascending: false }),
      db.from('body_comp_goals')
        .select('id,kind,start_date,end_date,start_value,target_value,is_active')
        .eq('user_id', currentUser.id)
        .eq('is_active', true),
    ]);

    if (profRes.error)  throw profRes.error;
    if (entryRes.error) throw entryRes.error;
    if (goalRes.error)  throw goalRes.error;

    _trainProgressState.profile = profRes.data || null;
    _trainProgressState.entries = entryRes.data || [];
    _trainProgressState.goals   = goalRes.data  || [];
    _trainProgressState.loaded  = true;
  } catch (e) {
    console.warn('[train] progress load failed', e);
    _trainProgressState.error = e?.message || 'Failed to load progress.';
  } finally {
    _trainProgressState.loading = false;
    if (_trainActiveView === 'progress') renderTrain();
  }
}

function trainProgressNeedsSetup() {
  const p = _trainProgressState.profile;
  if (!p) return true;
  return !p.sex || !p.dob || p.height_in == null || !p.activity_level;
}

function renderTrainProgress(root) {
  if (!_trainProgressState.loaded && !_trainProgressState.loading) loadTrainProgressData();

  if (_trainProgressState.loading && !_trainProgressState.loaded) {
    root.innerHTML = `<div class="train-shell"><div class="train-loading">Loading…</div></div>`;
    return;
  }
  if (_trainProgressState.error) {
    root.innerHTML = `<div class="train-shell"><div class="train-error">${trainEsc(_trainProgressState.error)}
      <button class="train-retry" data-train-action="progress-reload">Retry</button></div></div>`;
    return;
  }

  // Wizard takes priority over other views when the profile is incomplete.
  if (trainProgressNeedsSetup() || _trainProgressState.view === 'wizard') {
    root.innerHTML = `<div class="train-shell">${renderProgressWizard()}</div>`;
    return;
  }

  if (_trainProgressState.view === 'new-entry') {
    root.innerHTML = `<div class="train-shell">${renderProgressNewEntry()}</div>`;
    return;
  }

  if (_trainProgressState.view === 'goal') {
    root.innerHTML = `<div class="train-shell">${renderProgressGoalEditor()}</div>`;
    return;
  }

  root.innerHTML = `<div class="train-shell">${renderProgressDashboard()}</div>`;
}

/* ── Setup wizard ─────────────────────────────────────────────────── */

function ensureWizardDraft() {
  if (_trainProgressState.wizardDraft) return;
  const p = _trainProgressState.profile || {};
  _trainProgressState.wizardDraft = {
    sex:             p.sex || '',
    dob:             p.dob || '',
    height_in:       p.height_in != null ? String(p.height_in) : '',
    activity_level:  p.activity_level || '',
    units:           p.units || 'imperial',
  };
}

function renderProgressWizard() {
  ensureWizardDraft();
  const d = _trainProgressState.wizardDraft;
  const isEdit = !trainProgressNeedsSetup();

  const sexPills = ['male','female'].map(s => `
    <button class="train-choice-pill ${d.sex === s ? 'is-active' : ''}" data-train-action="wizard-sex" data-val="${s}">
      ${s === 'male' ? '♂ Male' : '♀ Female'}
    </button>`).join('');

  const actChoices = Object.entries(TRAIN_ACTIVITY).map(([key, a]) => `
    <button class="train-choice-card ${d.activity_level === key ? 'is-active' : ''}" data-train-action="wizard-activity" data-val="${key}">
      <div class="train-choice-card-title">${trainEsc(a.label)}</div>
      <div class="train-choice-card-desc">${trainEsc(a.desc)}</div>
      <div class="train-choice-card-meta">×${a.mult} multiplier</div>
    </button>`).join('');

  const canSave = d.sex && d.dob && d.height_in && d.activity_level;

  return `<div class="progress-wizard">
    <div class="progress-wizard-head">
      <div class="progress-wizard-title">${isEdit ? 'Edit your profile' : 'Let’s set you up'}</div>
      <div class="progress-wizard-msg">${isEdit
        ? 'Update the values that feed your calorie target and body-fat math. All numbers are stored on your own row only.'
        : 'Four quick questions so the calorie target, BMR and body-fat math actually mean something. You can edit any of these later.'}</div>
    </div>

    <div class="train-form-card">
      <div class="train-form-section">
        <div class="train-form-label">Sex (for BMR formula)</div>
        <div class="train-choice-row">${sexPills}</div>
      </div>

      <div class="train-form-section">
        <div class="train-form-label">Date of birth</div>
        <input class="form-input" type="date" value="${trainEsc(d.dob)}" data-train-action="wizard-dob" max="${trainTodayLocalDate()}">
        <div class="train-form-hint">Used to compute your current age (re-derived every BMR call, so it stays accurate).</div>
      </div>

      <div class="train-form-section">
        <div class="train-form-label">Height (inches)</div>
        <input class="form-input" type="number" inputmode="decimal" step="0.1" min="36" max="96" placeholder="70" value="${trainEsc(d.height_in)}" data-train-action="wizard-height">
        <div class="train-form-hint">1 ft = 12 in. e.g. 5'10" = 70 in. Metric support comes in commit 6.</div>
      </div>

      <div class="train-form-section">
        <div class="train-form-label">Activity level</div>
        <div class="train-choice-stack">${actChoices}</div>
        <div class="train-form-hint">Multiplies BMR to get your daily energy expenditure. We auto-suggest based on your Train sessions later; you can always override.</div>
      </div>

      <div class="train-form-actions">
        ${isEdit ? `<button class="train-btn-secondary" data-train-action="wizard-cancel">Cancel</button>` : ''}
        <button class="train-btn-primary" data-train-action="wizard-save" ${canSave ? '' : 'disabled'}>
          ${_trainProgressState.saving ? 'Saving…' : (isEdit ? 'Save changes' : 'Save & continue')}
        </button>
      </div>
    </div>
  </div>`;
}

async function saveWizardProfile() {
  const d = _trainProgressState.wizardDraft;
  if (!d) return;
  if (!d.sex || !d.dob || !d.height_in || !d.activity_level) return;
  _trainProgressState.saving = true; renderTrain();
  try {
    const patch = {
      sex:            d.sex,
      dob:            d.dob,
      height_in:      Number(d.height_in),
      activity_level: d.activity_level,
      units:          d.units || 'imperial',
      body_comp_profile_set_at: new Date().toISOString(),
    };
    const { error } = await db.from('user_profiles')
      .update(patch)
      .eq('supabase_user_id', currentUser.id);
    if (error) throw error;
    _trainProgressState.profile = { ...(_trainProgressState.profile || {}), ...patch };
    _trainProgressState.wizardDraft = null;
    _trainProgressState.view = 'dashboard';
  } catch (e) {
    console.warn('[train] wizard save failed', e);
    showTrainToast('Save failed — ' + (e.message || 'try again'));
  } finally {
    _trainProgressState.saving = false;
    renderTrain();
  }
}

/* ── Dashboard ────────────────────────────────────────────────────── */

function renderProgressDashboard() {
  const p = _trainProgressState.profile;
  const entries = _trainProgressState.entries;
  const latest = entries[0] || null;

  // Compute the deterministic stack: BMR → TDEE → daily target.
  const age = trainAgeYears(p.dob);
  const weightLbs = latest?.weight_lbs != null ? Number(latest.weight_lbs) : null;
  const bmr = trainBMR(p.sex, weightLbs, p.height_in, age);
  const tdee = trainTDEE(bmr, p.activity_level);

  const weightGoal = _trainProgressState.goals.find(g => g.kind === 'weight') || null;
  const fatGoal    = _trainProgressState.goals.find(g => g.kind === 'body_fat') || null;
  const calMath = (tdee != null && weightGoal && weightLbs != null)
    ? trainCalorieTargetForGoal(tdee, weightLbs, Number(weightGoal.target_value), trainTodayLocalDate(), weightGoal.end_date)
    : null;
  const dailyCal = calMath?.daily_target ?? tdee;
  const macros = (dailyCal != null && weightLbs != null) ? trainMacros(dailyCal, weightLbs) : null;

  // Latest body fat from Navy formula if measurements present.
  const bfPct = latest
    ? trainNavyBodyFat(p.sex, latest.neck_in, latest.waist_in, latest.hips_in, p.height_in)
    : null;

  return `
    ${renderDashboardHeader(p)}
    ${latest ? renderDashboardLatestCard(latest, bfPct) : renderDashboardEmptyCard()}
    ${tdee != null ? renderDashboardCalorieCard(bmr, tdee, dailyCal, macros, weightGoal, calMath) : ''}
    ${renderDashboardGoalsCard(weightGoal, fatGoal, latest, bfPct)}
    ${entries.length > 1 ? renderDashboardTrendCard(entries) : ''}
    ${renderDashboardEntriesList(entries)}
  `;
}

function renderDashboardHeader(p) {
  const ageTxt = p.dob ? `${trainAgeYears(p.dob)} y` : '—';
  const heightTxt = p.height_in
    ? `${Math.floor(p.height_in / 12)}'${Math.round(p.height_in % 12)}" (${p.height_in}\")`
    : '—';
  const actLabel = TRAIN_ACTIVITY[p.activity_level]?.label || '—';
  return `<div class="progress-header">
    <div class="progress-header-stats">
      <span><strong>${trainEsc(String(p.sex || '—'))}</strong> · ${trainEsc(ageTxt)}</span>
      <span class="progress-header-sep">·</span>
      <span>${trainEsc(heightTxt)}</span>
      <span class="progress-header-sep">·</span>
      <span>${trainEsc(actLabel)}</span>
    </div>
    <button class="train-btn-link" data-train-action="progress-edit-profile">Edit profile ↗</button>
  </div>`;
}

function renderDashboardLatestCard(latest, bfPct) {
  const today = trainTodayLocalDate();
  const ageDays = Math.round((new Date(today) - new Date(latest.captured_date)) / 86400_000);
  const ageTxt = ageDays === 0 ? 'today' : ageDays === 1 ? 'yesterday' : `${ageDays} days ago`;
  const bfTxt = bfPct != null
    ? `${bfPct}% <span class="latest-stat-method">Navy</span>`
    : `<span class="latest-stat-method">log neck + waist for body fat %</span>`;
  return `<div class="progress-card progress-latest-card">
    <div class="progress-card-head">
      <div>
        <div class="progress-card-label">Latest entry</div>
        <div class="progress-card-meta">Logged ${trainEsc(ageTxt)}</div>
      </div>
      <button class="train-btn-primary" data-train-action="progress-new-entry">+ Log entry</button>
    </div>
    <div class="latest-stats-grid">
      <div class="latest-stat">
        <div class="latest-stat-num">${latest.weight_lbs != null ? Number(latest.weight_lbs).toFixed(1) : '—'}</div>
        <div class="latest-stat-label">Weight (lbs)</div>
      </div>
      <div class="latest-stat">
        <div class="latest-stat-num">${bfTxt}</div>
        <div class="latest-stat-label">Body fat</div>
      </div>
      <div class="latest-stat">
        <div class="latest-stat-num">${latest.waist_in != null ? Number(latest.waist_in).toFixed(1) + '"' : '—'}</div>
        <div class="latest-stat-label">Waist</div>
      </div>
    </div>
  </div>`;
}

function renderDashboardEmptyCard() {
  return `<div class="progress-card progress-empty-card">
    <div class="progress-empty-title">No entries yet</div>
    <div class="progress-empty-msg">Log your first body-composition entry to start seeing weight, body fat % and macro targets here.</div>
    <button class="train-btn-primary" style="margin-top:12px" data-train-action="progress-new-entry">+ Log first entry</button>
  </div>`;
}

function renderDashboardCalorieCard(bmr, tdee, dailyCal, macros, weightGoal, calMath) {
  const deficit = calMath?.deficit_per_day || 0;
  const deficitTxt = deficit > 0
    ? `<span class="cal-deficit">−${deficit} cal/day deficit</span>`
    : deficit < 0
      ? `<span class="cal-deficit cal-surplus">+${Math.abs(deficit)} cal/day surplus</span>`
      : `<span class="cal-deficit cal-maintain">Maintenance</span>`;

  const macroRow = macros ? `<div class="cal-macros">
    <div class="cal-macro"><div class="cal-macro-g">${macros.protein.g}g</div><div class="cal-macro-l">Protein · ${macros.protein.pct}%</div></div>
    <div class="cal-macro"><div class="cal-macro-g">${macros.carbs.g}g</div><div class="cal-macro-l">Carbs · ${macros.carbs.pct}%</div></div>
    <div class="cal-macro"><div class="cal-macro-g">${macros.fat.g}g</div><div class="cal-macro-l">Fat · ${macros.fat.pct}%</div></div>
  </div>` : '';

  return `<div class="progress-card">
    <div class="progress-card-head">
      <div>
        <div class="progress-card-label">Daily calorie target</div>
        <div class="progress-card-meta">Mifflin-St Jeor · ${TRAIN_ACTIVITY[_trainProgressState.profile.activity_level]?.label || ''}</div>
      </div>
      ${deficitTxt}
    </div>
    <div class="cal-target-grid">
      <div class="cal-target"><div class="cal-target-num">${dailyCal != null ? dailyCal.toLocaleString() : '—'}</div><div class="cal-target-l">Daily target</div></div>
      <div class="cal-target"><div class="cal-target-num">${tdee != null ? tdee.toLocaleString() : '—'}</div><div class="cal-target-l">TDEE</div></div>
      <div class="cal-target"><div class="cal-target-num">${bmr != null ? bmr.toLocaleString() : '—'}</div><div class="cal-target-l">BMR</div></div>
    </div>
    ${macroRow}
  </div>`;
}

function renderDashboardGoalsCard(weightGoal, fatGoal, latest, bfPct) {
  const bar = (goal, current, kind) => {
    if (!goal) return '';
    const pct = Math.max(0, Math.min(100, trainProgressPct(goal.start_value, current, goal.target_value) || 0));
    const startTxt = Number(goal.start_value).toFixed(kind === 'weight' ? 1 : 1);
    const tgtTxt = Number(goal.target_value).toFixed(kind === 'weight' ? 1 : 1);
    const curTxt = current != null ? Number(current).toFixed(kind === 'weight' ? 1 : 1) : '—';
    const daysLeft = Math.max(0, Math.round((new Date(goal.end_date) - new Date()) / 86400_000));
    const unit = kind === 'weight' ? 'lbs' : '%';
    return `<div class="goal-row">
      <div class="goal-row-head">
        <div class="goal-row-title">${kind === 'weight' ? 'Weight' : 'Body fat'} · <strong>${tgtTxt}${unit}</strong> by ${trainEsc(goal.end_date)}</div>
        <div class="goal-row-cur">${curTxt}${unit} <span class="goal-row-pct">${pct}%</span></div>
      </div>
      <div class="goal-bar"><div class="goal-bar-fill" style="width:${pct}%"></div></div>
      <div class="goal-row-meta">Started at ${startTxt}${unit} · ${daysLeft} days left</div>
    </div>`;
  };

  const haveAny = !!(weightGoal || fatGoal);
  if (!haveAny) {
    return `<div class="progress-card">
      <div class="progress-card-head">
        <div>
          <div class="progress-card-label">Goals</div>
          <div class="progress-card-meta">No active goal yet</div>
        </div>
        <button class="train-btn-secondary" data-train-action="progress-edit-goal" data-kind="weight">Set weight goal</button>
      </div>
    </div>`;
  }

  return `<div class="progress-card">
    <div class="progress-card-head">
      <div>
        <div class="progress-card-label">Goals</div>
        <div class="progress-card-meta">Progress vs. start value</div>
      </div>
      <button class="train-btn-link" data-train-action="progress-edit-goal" data-kind="${weightGoal ? 'weight' : 'body_fat'}">Edit ↗</button>
    </div>
    ${bar(weightGoal, latest?.weight_lbs, 'weight')}
    ${bar(fatGoal, bfPct, 'body_fat')}
    ${!weightGoal ? `<button class="train-btn-secondary" style="margin-top:8px" data-train-action="progress-edit-goal" data-kind="weight">+ Add weight goal</button>` : ''}
    ${!fatGoal    ? `<button class="train-btn-secondary" style="margin-top:8px" data-train-action="progress-edit-goal" data-kind="body_fat">+ Add body fat goal</button>` : ''}
  </div>`;
}

function renderDashboardTrendCard(entries) {
  // Mini sparkline for weight only (most reliably filled). Last 8 entries
  // newest-first; reverse for time-going-right.
  const points = entries.slice(0, 8).reverse().filter(e => e.weight_lbs != null);
  if (points.length < 2) return '';
  const W = 280, H = 60, pad = 4;
  const vals = points.map(p => Number(p.weight_lbs));
  const min = Math.min(...vals), max = Math.max(...vals);
  const range = (max - min) || 1;
  const xs = points.map((_, i) => pad + (i * (W - 2 * pad)) / (points.length - 1));
  const ys = vals.map(v => H - pad - ((v - min) / range) * (H - 2 * pad));
  const d = points.map((_, i) => `${i === 0 ? 'M' : 'L'}${xs[i].toFixed(1)},${ys[i].toFixed(1)}`).join(' ');
  const dots = xs.map((x, i) => `<circle cx="${x.toFixed(1)}" cy="${ys[i].toFixed(1)}" r="2.5" fill="var(--guava-700)"/>`).join('');
  const first = vals[0], last = vals[vals.length - 1];
  const delta = last - first;
  const deltaCls = delta < 0 ? 'is-down' : delta > 0 ? 'is-up' : '';
  const deltaTxt = delta === 0 ? '±0.0 lbs' : `${delta > 0 ? '+' : ''}${delta.toFixed(1)} lbs`;
  return `<div class="progress-card">
    <div class="progress-card-head">
      <div>
        <div class="progress-card-label">Weight trend</div>
        <div class="progress-card-meta">Last ${points.length} entries</div>
      </div>
      <span class="trend-delta ${deltaCls}">${deltaTxt}</span>
    </div>
    <svg viewBox="0 0 ${W} ${H}" class="trend-svg" preserveAspectRatio="none">
      <path d="${d}" fill="none" stroke="var(--guava-700)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      ${dots}
    </svg>
  </div>`;
}

function renderDashboardEntriesList(entries) {
  if (!entries.length) return '';
  const rows = entries.slice(0, 6).map(e => `<div class="entry-row" data-train-action="progress-detail" data-id="${e.id}">
    <div class="entry-row-date">${trainEsc(e.captured_date)}</div>
    <div class="entry-row-stats">
      ${e.weight_lbs != null ? `<span><strong>${Number(e.weight_lbs).toFixed(1)}</strong> lbs</span>` : ''}
      ${e.waist_in != null ? `<span>${Number(e.waist_in).toFixed(1)}" waist</span>` : ''}
      ${e.body_fat_pct != null ? `<span>${Number(e.body_fat_pct).toFixed(1)}% BF</span>` : ''}
    </div>
  </div>`).join('');
  return `<div class="progress-card">
    <div class="progress-card-head">
      <div>
        <div class="progress-card-label">Recent entries</div>
        <div class="progress-card-meta">Tap to view details</div>
      </div>
    </div>
    <div class="entries-list">${rows}</div>
  </div>`;
}

/* ── New entry form ───────────────────────────────────────────────── */

function ensureEntryDraft() {
  if (_trainProgressState.entryDraft) return;
  const latest = _trainProgressState.entries[0];
  // Pre-fill measurements from the most recent entry to make repeat
  // logging fast — user typically only updates 1-2 numbers each week.
  _trainProgressState.entryDraft = {
    captured_date: trainTodayLocalDate(),
    weight_lbs:    '',
    neck_in:       latest?.neck_in   != null ? String(latest.neck_in)   : '',
    waist_in:      latest?.waist_in  != null ? String(latest.waist_in)  : '',
    chest_in:      latest?.chest_in  != null ? String(latest.chest_in)  : '',
    arms_in:       latest?.arms_in   != null ? String(latest.arms_in)   : '',
    hips_in:       latest?.hips_in   != null ? String(latest.hips_in)   : '',
    thighs_in:     latest?.thighs_in != null ? String(latest.thighs_in) : '',
    notes:         '',
  };
}

function renderProgressNewEntry() {
  ensureEntryDraft();
  const d = _trainProgressState.entryDraft;
  const p = _trainProgressState.profile;

  // Live preview: if neck + waist are filled, compute body fat now so the
  // user sees the result as they type.
  const bfPreview = (d.neck_in && d.waist_in && (p.sex === 'male' || (p.sex === 'female' && d.hips_in)))
    ? trainNavyBodyFat(p.sex, Number(d.neck_in), Number(d.waist_in), d.hips_in ? Number(d.hips_in) : null, p.height_in)
    : null;
  const bfTxt = bfPreview != null
    ? `Body fat preview: <strong>${bfPreview}%</strong> <span class="train-form-hint" style="display:inline">(Navy formula)</span>`
    : `Body fat will compute when you fill in neck + waist${p.sex === 'female' ? ' + hips' : ''}.`;

  const meas = (key, label, suffix, required = false) => `<div class="train-form-field">
    <label class="train-form-label-inline">${label}${required ? ' <span class="req">*</span>' : ''}</label>
    <input class="form-input" type="number" inputmode="decimal" step="0.1" min="0"
      placeholder="${trainEsc(suffix)}" value="${trainEsc(d[key] || '')}"
      data-train-action="entry-input" data-key="${key}">
  </div>`;

  return `<div class="progress-new-entry">
    <div class="progress-wizard-head">
      <button class="train-btn-link" data-train-action="progress-back" style="margin-bottom:6px">← Back to dashboard</button>
      <div class="progress-wizard-title">Log entry</div>
      <div class="progress-wizard-msg">Weight + a few measurements. Neck and waist (plus hips for women) unlock the Navy body-fat formula.</div>
    </div>

    <div class="train-form-card">
      <div class="train-form-section">
        <div class="train-form-label">Entry date</div>
        <input class="form-input" type="date" value="${trainEsc(d.captured_date)}" max="${trainTodayLocalDate()}" data-train-action="entry-input" data-key="captured_date">
      </div>

      <div class="train-form-section">
        <div class="train-form-label">Weight</div>
        <input class="form-input" type="number" inputmode="decimal" step="0.1" min="0" placeholder="lbs" value="${trainEsc(d.weight_lbs || '')}" data-train-action="entry-input" data-key="weight_lbs">
      </div>

      <div class="train-form-section">
        <div class="train-form-label">Measurements (inches)</div>
        <div class="entry-meas-grid">
          ${meas('neck_in',   'Neck',   'in', true)}
          ${meas('waist_in',  'Waist',  'in', true)}
          ${p.sex === 'female' ? meas('hips_in', 'Hips', 'in', true) : meas('hips_in', 'Hips', 'in')}
          ${meas('chest_in',  'Chest',  'in')}
          ${meas('arms_in',   'Arms',   'in')}
          ${meas('thighs_in', 'Thighs', 'in')}
        </div>
        <div class="train-form-hint">${bfTxt}</div>
      </div>

      <div class="train-form-section">
        <div class="train-form-label">Notes</div>
        <textarea class="train-notes-input" placeholder="How are you feeling? Anything to flag for next entry?" data-train-action="entry-input" data-key="notes">${trainEsc(d.notes || '')}</textarea>
      </div>

      <div class="train-form-actions">
        <button class="train-btn-secondary" data-train-action="progress-back">Cancel</button>
        <button class="train-btn-primary" data-train-action="entry-save" ${_trainProgressState.saving ? 'disabled' : ''}>
          ${_trainProgressState.saving ? 'Saving…' : 'Save entry'}
        </button>
      </div>
    </div>
  </div>`;
}

async function saveProgressEntry() {
  const d = _trainProgressState.entryDraft;
  const p = _trainProgressState.profile;
  if (!d || !d.captured_date) return;
  _trainProgressState.saving = true; renderTrain();
  try {
    // Compute body fat now (deterministic). Falls back to null when
    // neck + waist (+ hips for women) aren't all filled.
    const neck = d.neck_in ? Number(d.neck_in) : null;
    const waist = d.waist_in ? Number(d.waist_in) : null;
    const hips  = d.hips_in ? Number(d.hips_in) : null;
    const bfPct = trainNavyBodyFat(p.sex, neck, waist, hips, p.height_in);
    const bfMethod = bfPct != null ? 'navy_formula' : null;
    const bfConf   = bfPct != null ? 'high' : null;

    const row = {
      user_id:       currentUser.id,
      captured_date: d.captured_date,
      weight_lbs:    d.weight_lbs ? Number(d.weight_lbs) : null,
      neck_in:       neck,
      waist_in:      waist,
      chest_in:      d.chest_in ? Number(d.chest_in) : null,
      arms_in:       d.arms_in ? Number(d.arms_in) : null,
      hips_in:       hips,
      thighs_in:     d.thighs_in ? Number(d.thighs_in) : null,
      notes:         d.notes || null,
      body_fat_pct:  bfPct,
      body_fat_method: bfMethod,
      body_fat_confidence: bfConf,
    };
    // Upsert so re-logging on the same day updates the existing row
    // (matches the unique index in the migration).
    const { data: saved, error } = await db.from('progress_pics')
      .upsert(row, { onConflict: 'user_id,captured_date' })
      .select()
      .single();
    if (error) throw error;

    // Patch the local cache so the dashboard refreshes immediately.
    const existIdx = _trainProgressState.entries.findIndex(e => e.captured_date === saved.captured_date);
    if (existIdx >= 0) _trainProgressState.entries[existIdx] = saved;
    else _trainProgressState.entries.unshift(saved);
    _trainProgressState.entries.sort((a, b) => b.captured_date.localeCompare(a.captured_date));

    // Auto-mark any habit linked to 'progress' for this entry's date.
    autoMarkLinkedHabitsForSession({
      day_type:     'progress',
      day_name:     'Progress entry',
      session_date: saved.captured_date,
    }).catch(err => console.warn('[train] progress auto-mark failed', err));

    _trainProgressState.entryDraft = null;
    _trainProgressState.view = 'dashboard';
  } catch (e) {
    console.warn('[train] save progress entry failed', e);
    showTrainToast('Save failed — ' + (e.message || 'try again'));
  } finally {
    _trainProgressState.saving = false;
    renderTrain();
  }
}

/* ── Goal editor ──────────────────────────────────────────────────── */

function ensureGoalDraft(kind) {
  if (_trainProgressState.goalDraft && _trainProgressState.goalDraft.kind === kind) return;
  const existing = _trainProgressState.goals.find(g => g.kind === kind);
  const latest = _trainProgressState.entries[0];
  const today = trainTodayLocalDate();
  const inTwelveWeeks = trainShiftDate(today, 84);
  let startVal = existing?.start_value;
  if (startVal == null) {
    if (kind === 'weight') startVal = latest?.weight_lbs ?? '';
    else startVal = latest?.body_fat_pct ?? '';
  }
  _trainProgressState.goalDraft = {
    kind,
    start_value:  startVal != null ? String(startVal) : '',
    target_value: existing?.target_value != null ? String(existing.target_value) : '',
    end_date:     existing?.end_date || inTwelveWeeks,
    existing_id:  existing?.id || null,
  };
}

function renderProgressGoalEditor() {
  const g = _trainProgressState.goalDraft;
  if (!g) return '';
  const unit = g.kind === 'weight' ? 'lbs' : '%';
  const title = g.kind === 'weight' ? 'Weight goal' : 'Body fat goal';

  return `<div class="progress-wizard">
    <div class="progress-wizard-head">
      <button class="train-btn-link" data-train-action="progress-back" style="margin-bottom:6px">← Back to dashboard</button>
      <div class="progress-wizard-title">${title}</div>
      <div class="progress-wizard-msg">Sets the deficit/surplus per day so your calorie target makes sense. Start value snapshots today's number — change it only if you're catching up an older starting point.</div>
    </div>
    <div class="train-form-card">
      <div class="train-form-section">
        <div class="train-form-label">Start value (${unit})</div>
        <input class="form-input" type="number" step="0.1" min="0" value="${trainEsc(g.start_value)}" data-train-action="goal-input" data-key="start_value">
      </div>
      <div class="train-form-section">
        <div class="train-form-label">Target value (${unit})</div>
        <input class="form-input" type="number" step="0.1" min="0" value="${trainEsc(g.target_value)}" data-train-action="goal-input" data-key="target_value">
      </div>
      <div class="train-form-section">
        <div class="train-form-label">Target date</div>
        <input class="form-input" type="date" value="${trainEsc(g.end_date)}" min="${trainTodayLocalDate()}" data-train-action="goal-input" data-key="end_date">
      </div>
      <div class="train-form-actions">
        <button class="train-btn-secondary" data-train-action="progress-back">Cancel</button>
        ${g.existing_id ? `<button class="train-btn-secondary" data-train-action="goal-delete">Remove goal</button>` : ''}
        <button class="train-btn-primary" data-train-action="goal-save" ${_trainProgressState.saving ? 'disabled' : ''}>
          ${_trainProgressState.saving ? 'Saving…' : 'Save goal'}
        </button>
      </div>
    </div>
  </div>`;
}

async function saveProgressGoal() {
  const g = _trainProgressState.goalDraft;
  if (!g || !g.kind || !g.start_value || !g.target_value || !g.end_date) return;
  _trainProgressState.saving = true; renderTrain();
  try {
    // Deactivate any existing active goal of this kind.
    await db.from('body_comp_goals')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('user_id', currentUser.id)
      .eq('kind', g.kind)
      .eq('is_active', true);

    const { data, error } = await db.from('body_comp_goals').insert({
      user_id:      currentUser.id,
      kind:         g.kind,
      start_date:   trainTodayLocalDate(),
      end_date:     g.end_date,
      start_value:  Number(g.start_value),
      target_value: Number(g.target_value),
      is_active:    true,
    }).select().single();
    if (error) throw error;

    _trainProgressState.goals = _trainProgressState.goals.filter(x => x.kind !== g.kind);
    _trainProgressState.goals.push(data);
    _trainProgressState.goalDraft = null;
    _trainProgressState.view = 'dashboard';
  } catch (e) {
    console.warn('[train] save goal failed', e);
    showTrainToast('Save failed — ' + (e.message || 'try again'));
  } finally {
    _trainProgressState.saving = false;
    renderTrain();
  }
}

async function deleteProgressGoal() {
  const g = _trainProgressState.goalDraft;
  if (!g || !g.existing_id) return;
  _trainProgressState.saving = true; renderTrain();
  try {
    const { error } = await db.from('body_comp_goals')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', g.existing_id);
    if (error) throw error;
    _trainProgressState.goals = _trainProgressState.goals.filter(x => x.id !== g.existing_id);
    _trainProgressState.goalDraft = null;
    _trainProgressState.view = 'dashboard';
  } catch (e) {
    console.warn('[train] remove goal failed', e);
    showTrainToast('Remove failed — ' + (e.message || 'try again'));
  } finally {
    _trainProgressState.saving = false;
    renderTrain();
  }
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
    /* Match the Today day-picker breakpoint — below 600px the 7-cell row
       squeezes the day names too tight in the side-panel preview and
       narrow phones. Drop to a 4-column grid so each card has room. */
    @media (max-width: 600px) {
      .plan-week-grid { grid-template-columns: repeat(4, 1fr); }
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

    /* ── Already-logged session cards (Today subtab) ───────────────── */
    .logged-session-block { margin-bottom: 14px; }
    .logged-session-label {
      font-size: 11px; font-weight: 700; letter-spacing: .08em;
      color: var(--ink-3); text-transform: uppercase; margin-bottom: 8px;
    }
    .logged-session-card {
      background: var(--surface); border: 1px solid var(--edge);
      border-radius: var(--r-md); padding: 12px 14px;
      margin-bottom: 8px;
      box-shadow: var(--shadow-card);
    }
    .logged-session-head {
      display: flex; align-items: center; justify-content: space-between;
      gap: 10px; margin-bottom: 6px;
    }
    .logged-session-name {
      font-size: 14px; font-weight: 700; color: var(--ink);
      display: inline-flex; align-items: center; gap: 8px;
    }
    .logged-session-feel { font-size: 16px; }
    .logged-session-head .day-detail-badge { margin-bottom: 0; }
    .logged-session-summary { font-size: 12px; color: var(--ink-2); }
    .logged-session-notes {
      font-size: 12px; color: var(--ink-3); margin-top: 6px;
      padding-top: 6px; border-top: 1px dashed var(--edge);
      font-style: italic;
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

    /* ── Progress subtab ──────────────────────────────────────────── */
    .progress-header {
      display: flex; align-items: center; justify-content: space-between;
      gap: 10px; padding: 0 2px 4px;
      flex-wrap: wrap;
    }
    .progress-header-stats {
      font-size: 12px; color: var(--ink-3);
      display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap;
    }
    .progress-header-stats strong { color: var(--ink); font-weight: 700; text-transform: capitalize; }
    .progress-header-sep { color: var(--ink-4); }

    .progress-card {
      background: var(--surface); border: 1px solid var(--edge);
      border-radius: var(--r-md); padding: 14px 16px;
      box-shadow: var(--shadow-card);
    }
    .progress-card-head {
      display: flex; align-items: center; justify-content: space-between;
      gap: 10px; margin-bottom: 10px; flex-wrap: wrap;
    }
    .progress-card-label {
      font-size: 11px; font-weight: 700; letter-spacing: .08em;
      color: var(--ink-3); text-transform: uppercase;
    }
    .progress-card-meta { font-size: 11px; color: var(--ink-4); margin-top: 2px; }

    .progress-empty-card { text-align: center; padding: 28px 18px; }
    .progress-empty-title { font-size: 15px; font-weight: 700; color: var(--ink); margin-bottom: 4px; }
    .progress-empty-msg { font-size: 13px; color: var(--ink-3); line-height: 1.5; max-width: 380px; margin: 0 auto; }

    .latest-stats-grid {
      display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px;
    }
    .latest-stat {
      background: var(--surface-2); border-radius: var(--r-sm);
      padding: 10px 8px; text-align: center;
    }
    .latest-stat-num {
      font-size: 20px; font-weight: 700; color: var(--ink);
      letter-spacing: -0.01em; font-variant-numeric: tabular-nums;
    }
    .latest-stat-label {
      font-size: 10px; font-weight: 700; letter-spacing: .06em;
      color: var(--ink-4); text-transform: uppercase; margin-top: 4px;
    }
    .latest-stat-method {
      font-size: 11px; font-weight: 500; color: var(--ink-4); display: block;
      margin-top: 2px;
    }

    .cal-target-grid {
      display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px;
      margin-bottom: 10px;
    }
    .cal-target {
      background: var(--surface-2); border-radius: var(--r-sm);
      padding: 10px 8px; text-align: center;
    }
    .cal-target-num {
      font-size: 20px; font-weight: 700; color: var(--ink);
      font-variant-numeric: tabular-nums;
    }
    .cal-target-l {
      font-size: 10px; font-weight: 700; letter-spacing: .06em;
      color: var(--ink-4); text-transform: uppercase; margin-top: 4px;
    }
    .cal-deficit {
      font-size: 11px; font-weight: 700;
      padding: 3px 8px; border-radius: 999px;
      background: var(--guava-50); color: var(--guava-700);
    }
    .cal-surplus { background: var(--moss-bg, #eaf0e3); color: var(--moss-fg, #5e8c4f); }
    .cal-maintain { background: var(--surface-2); color: var(--ink-3); }
    .cal-macros {
      display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px;
    }
    .cal-macro {
      background: var(--surface); border: 1px dashed var(--edge);
      border-radius: var(--r-sm); padding: 8px 6px; text-align: center;
    }
    .cal-macro-g { font-size: 14px; font-weight: 700; color: var(--ink); font-variant-numeric: tabular-nums; }
    .cal-macro-l { font-size: 10px; color: var(--ink-4); margin-top: 2px; }

    .goal-row { padding: 8px 0; }
    .goal-row + .goal-row { border-top: 1px dashed var(--edge); }
    .goal-row-head {
      display: flex; align-items: baseline; justify-content: space-between;
      gap: 8px; font-size: 12px;
    }
    .goal-row-title { color: var(--ink-2); }
    .goal-row-title strong { color: var(--ink); }
    .goal-row-cur { color: var(--ink); font-weight: 700; font-variant-numeric: tabular-nums; }
    .goal-row-pct {
      font-size: 11px; font-weight: 700; color: var(--guava-700);
      padding: 2px 6px; background: var(--guava-50); border-radius: 999px;
      margin-left: 6px;
    }
    .goal-bar {
      background: var(--surface-2); border-radius: 999px; height: 8px;
      margin: 8px 0 4px; overflow: hidden;
    }
    .goal-bar-fill {
      background: var(--guava-700); height: 100%; border-radius: 999px;
      transition: width 0.3s ease;
    }
    .goal-row-meta { font-size: 11px; color: var(--ink-4); }

    .trend-svg { width: 100%; height: 60px; display: block; }
    .trend-delta {
      font-size: 12px; font-weight: 700; font-variant-numeric: tabular-nums;
      padding: 3px 8px; border-radius: 999px; background: var(--surface-2);
      color: var(--ink-2);
    }
    .trend-delta.is-down { background: var(--moss-bg, #eaf0e3); color: var(--moss-fg, #5e8c4f); }
    .trend-delta.is-up   { background: var(--guava-50); color: var(--guava-700); }

    .entries-list { display: flex; flex-direction: column; }
    .entry-row {
      display: flex; align-items: center; justify-content: space-between;
      padding: 8px 4px; cursor: pointer; gap: 10px;
      transition: background 0.12s ease;
    }
    .entry-row + .entry-row { border-top: 1px dashed var(--edge); }
    .entry-row:hover { background: var(--surface-2); }
    .entry-row-date {
      font-size: 12px; color: var(--ink-3); font-variant-numeric: tabular-nums;
      flex-shrink: 0;
    }
    .entry-row-stats {
      display: inline-flex; gap: 10px; font-size: 12px; color: var(--ink-2);
      flex-wrap: wrap; justify-content: flex-end;
    }
    .entry-row-stats strong { color: var(--ink); font-weight: 700; }

    /* ── Wizard + form chrome ─────────────────────────────────────── */
    .progress-wizard { display: flex; flex-direction: column; gap: 14px; }
    .progress-wizard-head { padding: 0 2px; }
    .progress-wizard-title {
      font-size: 20px; font-weight: 700; color: var(--ink);
      letter-spacing: -0.02em; margin-bottom: 4px;
    }
    .progress-wizard-msg { font-size: 13px; color: var(--ink-3); line-height: 1.5; }
    .train-form-card {
      background: var(--surface); border: 1px solid var(--edge);
      border-radius: var(--r-md); padding: 16px;
      box-shadow: var(--shadow-card);
      display: flex; flex-direction: column; gap: 16px;
    }
    .train-form-section { display: flex; flex-direction: column; gap: 6px; }
    .train-form-label {
      font-size: 11px; font-weight: 700; letter-spacing: .08em;
      color: var(--ink-3); text-transform: uppercase;
    }
    .train-form-label-inline { font-size: 11px; color: var(--ink-3); }
    .train-form-label-inline .req { color: var(--guava-700); }
    .train-form-hint { font-size: 11px; color: var(--ink-4); line-height: 1.45; }
    .train-choice-row { display: flex; gap: 6px; flex-wrap: wrap; }
    .train-choice-pill {
      background: var(--surface); border: 1px solid var(--edge-strong);
      border-radius: 999px; padding: 6px 14px; cursor: pointer;
      font-family: inherit; font-size: 13px; color: var(--ink-2);
    }
    .train-choice-pill.is-active {
      background: var(--guava-50); border-color: var(--guava-700); color: var(--guava-700);
      font-weight: 700;
    }
    .train-choice-stack { display: flex; flex-direction: column; gap: 6px; }
    .train-choice-card {
      background: var(--surface); border: 1px solid var(--edge-strong);
      border-radius: var(--r-md); padding: 10px 12px; cursor: pointer;
      text-align: left; font-family: inherit;
    }
    .train-choice-card.is-active {
      background: var(--guava-50); border-color: var(--guava-700);
    }
    .train-choice-card-title { font-size: 13px; font-weight: 700; color: var(--ink); }
    .train-choice-card-desc { font-size: 11px; color: var(--ink-3); margin-top: 2px; }
    .train-choice-card-meta {
      font-size: 10px; font-weight: 700; letter-spacing: .06em;
      color: var(--ink-4); margin-top: 4px; text-transform: uppercase;
    }
    .train-choice-card.is-active .train-choice-card-meta { color: var(--guava-700); }
    .train-form-actions {
      display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap;
    }
    .entry-meas-grid {
      display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px;
    }
    @media (max-width: 500px) {
      .entry-meas-grid { grid-template-columns: repeat(2, 1fr); }
    }
    .train-form-field { display: flex; flex-direction: column; gap: 4px; }
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

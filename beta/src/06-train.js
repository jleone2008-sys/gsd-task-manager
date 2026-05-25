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
// Pill order: Workout / History / My Progress. Plan management moved
// behind a "Manage Plans" button on the Workout sub-view (_workoutSubview
// flips between 'pick' = day picker + session UI and 'plans' = the
// existing plan management UI that used to be its own pill).
let _trainActiveView = 'workout';      // 'workout' | 'history' | 'progress'
const TRAIN_VIEWS = ['workout', 'history', 'progress'];
let _workoutSubview = 'pick';          // 'pick' | 'plans'

// In-flight Manage Plan sheet state. The draft holds a deep-cloned copy
// of the plan being edited; committed on Save, discarded on Close.
// _managePlanEscHandler is the Esc-key listener so we can detach it
// when the modal closes (avoids leaking listeners on repeated opens).
let _managePlanDraft = null;
let _managePlanEscHandler = null;

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

  if (!TRAIN_VIEWS.includes(_trainActiveView)) _trainActiveView = 'workout';

  // Set the subtab pill-bar's visible-active state.
  document.querySelectorAll('.train-sub-pills .train-pill').forEach(p => {
    p.classList.toggle('active', p.dataset.trainView === _trainActiveView);
  });

  // Lazy-load the plan data the first time the Train tab is opened.
  if (!_trainState.loaded && !_trainState.loading) loadTrainPlans();

  if (_trainActiveView === 'workout') {
    // The Workout pill has a sub-mode: 'pick' (normal day picker +
    // session UI) and 'plans' (the plan-management surface that used
    // to live in its own pill). The Manage Plans button at the bottom
    // of the day-picker section toggles to 'plans'; a back link
    // returns to 'pick'.
    if (_workoutSubview === 'plans') renderTrainPlan(root);
    else                              renderTrainToday(root);
  } else if (_trainActiveView === 'history') {
    renderTrainHistory(root);
  } else {
    renderTrainProgress(root);
  }
}

function trainSwitchView(view) {
  if (!TRAIN_VIEWS.includes(view)) return;
  if (view === _trainActiveView) return;
  _trainActiveView = view;
  // Always reset the Workout sub-view to the day picker when switching
  // pills — coming back to Workout shouldn't dump the user into Manage
  // Plans mid-session.
  _workoutSubview = 'pick';
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
      trainOpenManagePlanSheet(actionEl.dataset.planId || _trainState.activePlan?.id);
      return;
    }
    if (action === 'rename-plan') {
      trainRenamePlan(actionEl.dataset.planId);
      return;
    }
    if (action === 'delete-plan') {
      trainDeletePlan(actionEl.dataset.planId);
      return;
    }
    // (close-manage-plan + save-manage-plan are bound directly on the
    //  modal elements in trainOpenManagePlanSheet — they don't route
    //  through this document-level delegator because event.stopPropagation
    //  on .train-modal would block them from reaching it.)
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
      // Legacy alias kept for any in-flight callers. Routes through the
      // new sub-view since the Plan pill no longer exists.
      _workoutSubview = 'plans';
      renderTrain();
      return;
    }
    if (action === 'manage-plans-open') {
      _workoutSubview = 'plans';
      renderTrain();
      return;
    }
    if (action === 'manage-plans-back') {
      _workoutSubview = 'pick';
      renderTrain();
      return;
    }
    if (action === 'history-recap') {
      openHistoryRecap(actionEl.dataset.sessionId);
      return;
    }
    if (action === 'history-recap-close') {
      closeHistoryRecap();
      return;
    }
    if (action === 'history-rerun-ai') {
      historyRecapRerunAI(actionEl.dataset.sessionId);
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
          waist_in:      entry.waist_in     != null ? String(entry.waist_in)     : '',
          notes:         entry.notes        || '',
          photos: {
            front: { file: null, preview: null, path: entry.front_storage_path || null },
            side:  { file: null, preview: null, path: entry.side_storage_path  || null },
            back:  { file: null, preview: null, path: entry.back_storage_path  || null },
          },
          _existing_id: entry.id,
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
    if (action === 'photo-remove') {
      const slot = actionEl.dataset.slot;
      ensureEntryDraft();
      const ph = _trainProgressState.entryDraft.photos[slot];
      if (ph?.preview) { try { URL.revokeObjectURL(ph.preview); } catch (_) {} }
      _trainProgressState.entryDraft.photos[slot] = { file: null, preview: null, path: null };
      renderTrain();
      return;
    }
    if (action === 'progress-analyze') {
      // Manual re-run of the vision analysis from the dashboard.
      const id = actionEl.dataset.id;
      runProgressPicAnalysis(id);
      return;
    }
  });

  // File input change handler — Supabase doesn't fire on 'input' for
  // type=file consistently across browsers, so listen for 'change' too.
  document.addEventListener('change', e => {
    if (typeof activeTool !== 'undefined' && activeTool !== 'train') return;
    const el = e.target.closest('[data-train-action="photo-pick"]');
    if (!el) return;
    const slot = el.dataset.slot;
    const file = el.files?.[0];
    if (!file) return;
    handleProgressPhotoPick(slot, file);
    // Reset the input so picking the same file twice still fires change.
    el.value = '';
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

/* ── Manage plan sheet (rename + description) ─────────────────────────
   Opens for any plan the user owns (active or inactive). The full
   day-template editor is a bigger build; this sheet handles the two
   pieces users need most: the plan's name + description. Save calls
   .update() on workout_plans which is RLS-gated to own rows. */
function trainOpenManagePlanSheet(planId) {
  const plan = (_trainState.userPlans || []).find(p => p.id === planId);
  if (!plan) {
    showTrainToast('Plan not found.');
    return;
  }
  trainCloseManagePlanSheet();

  // Deep-clone day_template into the draft so the modal can mutate
  // freely without leaking edits back to the active plan state.
  _managePlanDraft = {
    id:           plan.id,
    name:         plan.name || '',
    description:  plan.description || '',
    day_template: JSON.parse(JSON.stringify(Array.isArray(plan.day_template) ? plan.day_template : [])),
  };
  // Ensure all 7 DOWs are present so the editor can show every row;
  // missing days seed as 'rest'. Then sort Mon → Sun.
  const existing = new Set(_managePlanDraft.day_template.map(d => d.dow));
  for (const dow of DOW_ORDER) {
    if (!existing.has(dow)) {
      _managePlanDraft.day_template.push({ dow, name: 'Rest', type: 'rest', exercises: [] });
    }
  }
  _managePlanDraft.day_template.sort((a, b) => DOW_ORDER.indexOf(a.dow) - DOW_ORDER.indexOf(b.dow));

  // Inner modal pieces use direct listeners (not data-train-action) so
  // event.stopPropagation on .train-modal doesn't block the document
  // delegator. The body is painted by managePlanRender() and re-painted
  // on structural changes (add/remove exercise, change day type).
  const overlayHTML = `<div class="train-modal-overlay" id="trainManagePlanModal">
    <div class="train-modal manage-plan-modal" data-modal-stop>
      <div class="train-modal-head">
        <div>
          <div class="day-detail-dow">Manage plan</div>
          <div class="day-detail-name">${trainEsc(plan.name)}</div>
        </div>
        <button class="train-modal-close" data-modal-close title="Close">×</button>
      </div>
      <div class="manage-plan-body" data-manage-body></div>
      <div class="train-form-actions" style="margin-top:14px">
        <button class="train-btn-secondary" data-modal-close>Cancel</button>
        <button class="train-btn-primary" data-modal-save>Save</button>
      </div>
    </div>
  </div>`;
  const wrap = document.createElement('div');
  wrap.innerHTML = overlayHTML;
  const overlay = wrap.firstElementChild;
  document.body.appendChild(overlay);

  // Click-outside-to-close — only when the overlay itself is the target.
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) trainCloseManagePlanSheet();
  });
  overlay.querySelector('[data-modal-stop]')?.addEventListener('click', (e) => e.stopPropagation());
  overlay.querySelectorAll('[data-modal-close]').forEach(btn => {
    btn.addEventListener('click', trainCloseManagePlanSheet);
  });
  overlay.querySelector('[data-modal-save]')?.addEventListener('click', () => trainSaveManagePlanSheet(plan.id));
  _managePlanEscHandler = (e) => { if (e.key === 'Escape') trainCloseManagePlanSheet(); };
  document.addEventListener('keydown', _managePlanEscHandler);

  managePlanRender(overlay);
  setTimeout(() => overlay.querySelector('[data-manage-field="name"]')?.focus(), 0);
}

// Paint the manage-plan body from the in-flight draft. Called on open
// AND after structural changes (add/remove exercise, change day type).
// Input typing does NOT trigger re-render — that'd kill focus.
function managePlanRender(overlay) {
  const body = overlay.querySelector('[data-manage-body]');
  if (!body) return;
  const d = _managePlanDraft;
  if (!d) return;

  const dayRows = d.day_template.map((day, i) => renderManageDay(day, i)).join('');

  body.innerHTML = `
    <div class="train-form-section">
      <div class="train-form-label">Name</div>
      <input class="form-input" type="text" maxlength="80" value="${trainEsc(d.name)}" data-manage-field="name">
    </div>
    <div class="train-form-section" style="margin-top:12px">
      <div class="train-form-label">Description</div>
      <textarea class="train-notes-input" maxlength="240" placeholder="What's the focus of this plan?" data-manage-field="description">${trainEsc(d.description || '')}</textarea>
    </div>
    <div class="train-form-section" style="margin-top:16px">
      <div class="train-form-label">Days</div>
      <div class="manage-day-list">${dayRows}</div>
    </div>
  `;

  // Input listeners — write into draft on every keystroke, no re-render.
  body.querySelector('[data-manage-field="name"]')?.addEventListener('input', (e) => {
    _managePlanDraft.name = e.target.value;
  });
  body.querySelector('[data-manage-field="description"]')?.addEventListener('input', (e) => {
    _managePlanDraft.description = e.target.value;
  });
  body.querySelectorAll('[data-manage-day-field]').forEach(el => {
    el.addEventListener('input', (e) => {
      const i = Number(e.target.dataset.dayIdx);
      const field = e.target.dataset.manageDayField;
      if (Number.isFinite(i) && _managePlanDraft.day_template[i]) {
        _managePlanDraft.day_template[i][field] = e.target.value;
      }
    });
  });
  body.querySelectorAll('[data-manage-ex-field]').forEach(el => {
    el.addEventListener('input', (e) => {
      const di = Number(e.target.dataset.dayIdx);
      const xi = Number(e.target.dataset.exIdx);
      const field = e.target.dataset.manageExField;
      const ex = _managePlanDraft.day_template[di]?.exercises?.[xi];
      if (!ex) return;
      if (field === 'name')        ex.name   = e.target.value;
      else if (field === 'sets')   ex.sets   = Number(e.target.value) || null;
      else if (field === 'reps')   ex.reps   = e.target.value;   // string (supports '8' or '8-10')
      else if (field === 'rest_s') ex.rest_s = Number(e.target.value) || null;
    });
  });

  // Structural actions — these DO trigger re-render.
  body.querySelectorAll('[data-manage-type-pill]').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = Number(btn.dataset.dayIdx);
      const type = btn.dataset.manageTypePill;
      if (!_managePlanDraft.day_template[i]) return;
      _managePlanDraft.day_template[i].type = type;
      if (type === 'lift' && !Array.isArray(_managePlanDraft.day_template[i].exercises)) {
        _managePlanDraft.day_template[i].exercises = [];
      }
      managePlanRender(overlay);
    });
  });
  body.querySelectorAll('[data-manage-add-ex]').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = Number(btn.dataset.dayIdx);
      const day = _managePlanDraft.day_template[i];
      if (!day) return;
      if (!Array.isArray(day.exercises)) day.exercises = [];
      day.exercises.push({ name: '', sets: 3, reps: '8', rest_s: 90 });
      managePlanRender(overlay);
    });
  });
  body.querySelectorAll('[data-manage-remove-ex]').forEach(btn => {
    btn.addEventListener('click', () => {
      const di = Number(btn.dataset.dayIdx);
      const xi = Number(btn.dataset.exIdx);
      const day = _managePlanDraft.day_template[di];
      if (!day?.exercises) return;
      day.exercises.splice(xi, 1);
      managePlanRender(overlay);
    });
  });
}

function renderManageDay(day, i) {
  const typeBtn = (t, label) => `<button type="button" class="manage-type-pill ${day.type === t ? 'is-active' : ''}" data-manage-type-pill="${t}" data-day-idx="${i}">${label}</button>`;
  let exercisesBlock = '';
  if (day.type === 'lift') {
    const exRows = (day.exercises || []).map((ex, xi) => `
      <div class="manage-ex-row">
        <input class="form-input manage-ex-name" type="text" placeholder="Exercise name" value="${trainEsc(ex.name || '')}" data-manage-ex-field="name" data-day-idx="${i}" data-ex-idx="${xi}">
        <input class="form-input manage-ex-num" type="number" min="1" placeholder="sets" value="${ex.sets != null ? ex.sets : ''}" data-manage-ex-field="sets" data-day-idx="${i}" data-ex-idx="${xi}" title="Sets">
        <input class="form-input manage-ex-num" type="text" placeholder="reps" value="${trainEsc(String(ex.reps != null ? ex.reps : ''))}" data-manage-ex-field="reps" data-day-idx="${i}" data-ex-idx="${xi}" title="Reps (e.g. 8 or 8-10)">
        <input class="form-input manage-ex-num" type="number" min="0" placeholder="rest" value="${ex.rest_s != null ? ex.rest_s : ''}" data-manage-ex-field="rest_s" data-day-idx="${i}" data-ex-idx="${xi}" title="Rest (seconds)">
        <button type="button" class="manage-ex-remove" data-manage-remove-ex data-day-idx="${i}" data-ex-idx="${xi}" title="Remove exercise">×</button>
      </div>
    `).join('');
    exercisesBlock = `
      <div class="manage-ex-list">
        ${(day.exercises || []).length ? `<div class="manage-ex-head">
          <span>Exercise</span><span>Sets</span><span>Reps</span><span>Rest s</span><span></span>
        </div>` : ''}
        ${exRows || '<div class="manage-ex-empty">No exercises yet.</div>'}
        <button type="button" class="train-btn-link manage-add-ex" data-manage-add-ex data-day-idx="${i}">+ Add exercise</button>
      </div>
    `;
  }
  return `<div class="manage-day-card">
    <div class="manage-day-head">
      <div class="manage-day-dow">${trainEsc(day.dow)}</div>
      <input class="form-input manage-day-name" type="text" maxlength="40" placeholder="Day name" value="${trainEsc(day.name || '')}" data-manage-day-field="name" data-day-idx="${i}">
      <div class="manage-type-row">
        ${typeBtn('lift',   'Lift')}
        ${typeBtn('cardio', 'Cardio')}
        ${typeBtn('rest',   'Rest')}
      </div>
    </div>
    ${exercisesBlock}
  </div>`;
}

function trainCloseManagePlanSheet() {
  document.getElementById('trainManagePlanModal')?.remove();
  if (_managePlanEscHandler) {
    document.removeEventListener('keydown', _managePlanEscHandler);
    _managePlanEscHandler = null;
  }
  _managePlanDraft = null;
}

async function trainSaveManagePlanSheet(planId) {
  if (!planId || !_managePlanDraft || _managePlanDraft.id !== planId) return;
  const draft = _managePlanDraft;
  const name = String(draft.name || '').trim();
  const description = String(draft.description || '').trim() || null;
  if (!name) { showTrainToast('Name can\'t be empty.'); return; }

  // Clean the day_template before write:
  // - Coerce numeric fields, drop empty/invalid exercises.
  // - Rest days lose any leftover exercises so the JSON stays tight.
  // - Cardio days don't carry an exercises array (modality is logged at
  //   session time, not in the plan template).
  const days_per_week = draft.day_template.filter(d => d.type === 'lift' || d.type === 'cardio').length;
  const day_template = draft.day_template.map(d => {
    const type = d.type || 'rest';
    const base = { dow: d.dow, name: String(d.name || '').trim() || (type === 'rest' ? 'Rest' : 'Day'), type };
    if (type === 'lift') {
      base.exercises = (Array.isArray(d.exercises) ? d.exercises : [])
        .map(ex => ({
          name:   String(ex.name || '').trim(),
          sets:   ex.sets   != null ? Number(ex.sets)   : null,
          reps:   ex.reps   != null ? String(ex.reps)   : null,
          rest_s: ex.rest_s != null ? Number(ex.rest_s) : null,
        }))
        .filter(ex => ex.name);   // drop blank rows
    }
    return base;
  });

  try {
    const { data, error } = await db.from('workout_plans')
      .update({
        name, description, day_template, days_per_week,
        updated_at: new Date().toISOString(),
      })
      .eq('id', planId)
      .select()
      .single();
    if (error) throw error;
    // Patch local cache so dashboards refresh immediately.
    const idx = _trainState.userPlans.findIndex(p => p.id === planId);
    if (idx >= 0) _trainState.userPlans[idx] = data;
    if (_trainState.activePlan?.id === planId) _trainState.activePlan = data;
    trainCloseManagePlanSheet();
    renderTrain();
    showTrainToast('Plan saved.');
  } catch (e) {
    console.warn('[train] save manage plan failed', e);
    showTrainToast('Save failed — ' + (e.message || 'try again'));
  }
}

// Inline rename via prompt() — same dialog pattern as Fork's confirm.
// For deeper edits (description, days), open the Manage sheet instead.
async function trainRenamePlan(planId) {
  const plan = (_trainState.userPlans || []).find(p => p.id === planId);
  if (!plan) return;
  const next = window.prompt(`Rename "${plan.name}" to:`, plan.name);
  if (next == null) return;       // cancelled
  const name = String(next).trim();
  if (!name || name === plan.name) return;
  try {
    const { data, error } = await db.from('workout_plans')
      .update({ name, updated_at: new Date().toISOString() })
      .eq('id', planId)
      .select()
      .single();
    if (error) throw error;
    const idx = _trainState.userPlans.findIndex(p => p.id === planId);
    if (idx >= 0) _trainState.userPlans[idx] = data;
    if (_trainState.activePlan?.id === planId) _trainState.activePlan = data;
    renderTrain();
  } catch (e) {
    console.warn('[train] rename plan failed', e);
    showTrainToast('Rename failed — ' + (e.message || 'try again'));
  }
}

// Delete a plan. Refuses to delete the active plan (must deactivate
// first — typically by activating another plan). Historical sessions
// keep their plan_id set NULL on cascade (already wired in the workout_
// sessions schema), so session history is preserved.
async function trainDeletePlan(planId) {
  const plan = (_trainState.userPlans || []).find(p => p.id === planId);
  if (!plan) return;
  if (plan.is_active) {
    showTrainToast('Activate another plan first, then delete this one.');
    return;
  }
  const ok = window.confirm(
    `Delete "${plan.name}"?\n\n` +
    `This removes the plan permanently. Sessions you've already logged ` +
    `against it stay in your history (they just lose the plan link). ` +
    `This cannot be undone.`
  );
  if (!ok) return;
  try {
    const { error } = await db.from('workout_plans').delete().eq('id', planId);
    if (error) throw error;
    _trainState.userPlans = _trainState.userPlans.filter(p => p.id !== planId);
    renderTrain();
  } catch (e) {
    console.warn('[train] delete plan failed', e);
    showTrainToast('Delete failed — ' + (e.message || 'try again'));
  }
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
  // Guard: if an active plan exists, confirm before silently swapping
  // it out. The previous flow deactivated and looked permanent —
  // multiple users hit Fork by accident and thought their custom plan
  // was destroyed. The old plan stays in workout_plans (is_active=false)
  // either way, but the confirm makes the intent explicit.
  if (_trainState.activePlan) {
    const ok = window.confirm(
      `You already have an active plan: "${_trainState.activePlan.name}".\n\n` +
      `Forking "${tpl.name}" will set it as your new active plan. ` +
      `Your previous plan is kept (you can re-activate it later from the Plan list), ` +
      `but it will no longer be the active one.\n\nProceed?`
    );
    if (!ok) return;
  }
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
    root.innerHTML = `<div class="train-shell">${planSubviewHeader()}<div class="train-loading">Loading plans…</div></div>`;
    return;
  }
  if (_trainState.error) {
    root.innerHTML = `<div class="train-shell">${planSubviewHeader()}<div class="train-error">${trainEsc(_trainState.error)}
      <button class="train-retry" data-train-action="reload">Retry</button></div></div>`;
    return;
  }

  const active   = _trainState.activePlan;
  const todayDow = trainTodayDow();

  // Inactive forks/customs the user has built up — surfaced as a tiny
  // list with re-activate buttons. Without this surface, the only way
  // back to a deactivated plan was a DB edit; users hit Fork by accident
  // and lost track of their custom plan.
  const inactivePlans = (_trainState.userPlans || []).filter(p => !p.is_active);

  root.innerHTML = `<div class="train-shell">
    ${planSubviewHeader()}
    ${active ? renderPlanActiveCard(active, todayDow) : renderPlanEmptyCard()}
    ${inactivePlans.length ? renderPlanInactiveList(inactivePlans) : ''}
    ${renderPlanTemplatesList(_trainState.templates, active)}
  </div>`;
}

// Header row shown when the Plan management surface is reached via the
// Manage Plans button on the Workout pill. Back link returns to the
// day picker.
function planSubviewHeader() {
  return `<div class="train-subview-head">
    <button class="train-btn-link" data-train-action="manage-plans-back">← Back to workout</button>
    <div class="train-subview-title">Manage plans</div>
  </div>`;
}

function renderPlanInactiveList(plans) {
  const items = plans.map(p => {
    const days = Array.isArray(p.day_template) ? p.day_template : [];
    const schedule = days.map(d => d.name).join(' · ') || `${p.days_per_week || days.length} days/week`;
    return `<div class="plan-template-card">
      <div class="plan-template-text">
        <div class="plan-template-name">${trainEsc(p.name)}</div>
        <div class="plan-template-meta">${trainEsc(schedule)}</div>
      </div>
      <div class="plan-row-actions">
        <button class="train-btn-link" data-train-action="rename-plan" data-plan-id="${p.id}" title="Rename">Rename</button>
        <button class="train-btn-secondary" data-train-action="activate-plan" data-plan-id="${p.id}">Activate</button>
        <button class="train-btn-link train-btn-link--danger" data-train-action="delete-plan" data-plan-id="${p.id}" title="Delete">Delete</button>
      </div>
    </div>`;
  }).join('');
  return `<div class="plan-templates-block">
    <div class="plan-templates-label">Your other plans</div>
    ${items}
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
      <button class="train-btn-link" data-train-action="manage-plan" data-plan-id="${plan.id}">Manage ↗</button>
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
  // AI insight overlay — fetched from beta-train-feedback after the
  // deterministic stats render. { status: 'loading' | 'ok' | 'fallback'
  // | 'error', data: {...}, message? }
  aiFeedback: null,
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
  _trainTodayState.aiFeedback = null;
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
      ? ['😢','😔','😐','😊','🤩'][s.feel - 1] || ''
      : '';
    const notes = s.session_notes
      ? `<div class="logged-session-notes">${trainEsc(s.session_notes)}</div>`
      : '';
    // Tappable — opens the same recap modal the History tab uses, so
    // a session logged earlier today still has a single drill-in path.
    return `<div class="logged-session-card is-clickable" data-train-action="history-recap" data-session-id="${trainEsc(s.id)}">
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

  // Day picker grid + the Manage Plans entry-point in the bottom-right
  // corner. The button used to be a pill ("Plan") in the subtab bar;
  // this brings it inside the Workout surface so the structural-edit
  // affordance lives next to the structure it edits.
  return `<div class="train-day-picker-wrap">
    <div class="train-day-picker">
      ${pills}
      <div class="${anyCls.join(' ')}" data-train-action="pick-any">
        <span class="day-pill-dow">+</span><span class="day-pill-name">Bonus</span>
      </div>
    </div>
    <div class="train-day-picker-actions">
      <button class="train-btn-link" data-train-action="manage-plans-open">Manage plans ↗</button>
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
  // Mood scale: 1=Bad ... 5=Great (matches the conventional 1-5
  // direction after invert_mood_scale.sql).
  const moodEmojis = ['😢','😔','😐','😊','🤩'];
  const moodLabels = ['Bad','Low','Okay','Good','Great'];
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
      ${renderAIFeedbackBlock(st.aiFeedback)}
      ${renderHabitLinkPrompts(fb._session)}
      <button class="train-btn-secondary" style="margin-top:12px" data-train-action="start-new">Start another session</button>
    </div>
  </div>`;
}

// Renders the AI-narrative overlay below the deterministic stats grid.
// Three states: loading skeleton, success (insight + 0-3 observations),
// error (silent unless verbose). The block is always visually distinct
// from the formulaic stats so users can tell which numbers are AI vs
// derived.
function renderAIFeedbackBlock(ai) {
  if (!ai) return '';
  if (ai.status === 'loading') {
    return `<div class="train-ai-block is-loading">
      <div class="train-ai-label">Coach insight</div>
      <div class="train-ai-skel"></div>
      <div class="train-ai-skel" style="width:70%"></div>
    </div>`;
  }
  if (ai.status === 'error') {
    // Quiet failure — the formulaic feedback is already enough on its own.
    return `<div class="train-ai-block is-error">
      <div class="train-ai-label">Coach insight</div>
      <div class="train-ai-msg">Couldn’t reach the coach right now. Your stats above are saved.</div>
    </div>`;
  }
  const data = ai.data || {};
  const insight = data.insight || '';
  const obsList = Array.isArray(data.observations) ? data.observations : [];
  const obs = obsList.length
    ? `<ul class="train-ai-observations">${obsList.map(o => `<li>${trainEsc(o)}</li>`).join('')}</ul>`
    : '';
  const tag = ai.status === 'fallback'
    ? '<span class="train-ai-tag">deterministic</span>'
    : '<span class="train-ai-tag is-ai">AI · Claude</span>';
  return `<div class="train-ai-block">
    <div class="train-ai-head">
      <div class="train-ai-label">Coach insight</div>
      ${tag}
    </div>
    ${insight ? `<div class="train-ai-insight">${trainEsc(insight)}</div>` : ''}
    ${obs}
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
  // Per-section refresh — train only mutates habit completions, so
  // tasks/notes don't need a repaint.
  if (typeof refreshHomeHabits === 'function') refreshHomeHabits();
  else if (typeof refreshHomeData === 'function') refreshHomeData();
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
    // Phase 4 commit 6 — kick off the AI narrative call in the background.
    // The deterministic stats already render; this overlays on top once
    // it returns. Network failure or no-API-key is non-fatal: the
    // function's fallback path returns a one-liner so the UI still has
    // something to show.
    st.aiFeedback = { status: 'loading' };
    loadTrainAIFeedback(session.id);
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
    // Invalidate the History tab cache so the new session shows up next
    // time the user taps the History pill. Forces a re-fetch rather
    // than serving stale data.
    _trainHistoryState.loaded = false;
  } catch (e) {
    console.warn('[train] submit failed', e);
    st.submitting = false;
    renderTrain();
    showTrainToast('Submit failed — ' + (e.message || 'try again'));
  }
}

// Fetch the AI-written narrative for a just-submitted session. Hits
// /.netlify/functions/beta-train-feedback with the current Supabase
// access token. Network errors, missing API key, or model errors all
// flow into the same `status: 'error'` UI path so the formulaic stats
// remain the source of truth.
async function loadTrainAIFeedback(sessionId) {
  try {
    const { data: { session } } = await db.auth.getSession();
    const token = session?.access_token;
    if (!token) {
      _trainTodayState.aiFeedback = { status: 'error', message: 'not signed in' };
      renderTrain();
      return;
    }
    const r = await fetch('/.netlify/functions/beta-train-feedback', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body:    JSON.stringify({ session_id: sessionId }),
    });
    const j = await r.json();
    if (!r.ok) {
      _trainTodayState.aiFeedback = { status: 'error', message: j.error || `http_${r.status}` };
    } else {
      _trainTodayState.aiFeedback = { status: j.status || 'ok', data: j };
    }
  } catch (e) {
    console.warn('[train] ai feedback fetch failed', e);
    _trainTodayState.aiFeedback = { status: 'error', message: e.message || 'fetch failed' };
  } finally {
    if (_trainActiveView === 'today') renderTrain();
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
    // Per-section refresh — train only mutates habit completions.
    if (typeof refreshHomeHabits === 'function') refreshHomeHabits();
    else if (typeof refreshHomeData === 'function') refreshHomeData();
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
  // Mood scale is now 1=Bad .. 5=Great (post invert_mood_scale).
  if (st.feel === 5) observations.push("Great session feel. Keep the recovery dialed and progression should hold.");
  if (st.feel <= 2)  observations.push("Session felt rough. Check sleep / hydration; deload candidates if it persists 2+ weeks.");
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
  entryDraft:    null,     // { captured_date, weight_lbs, waist_in, notes, photos }
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
      // Body-comp profile lives on user_preferences (user-owned table
      // with full RLS — read+write own row). Migrated off user_profiles
      // in user_preferences.sql so the wizard can use a plain upsert
      // below instead of the SECURITY DEFINER RPC workaround.
      db.from('user_preferences')
        .select('sex,dob,height_in,activity_level,activity_level_override,units,body_comp_profile_set_at')
        .eq('user_id', currentUser.id)
        .maybeSingle(),
      db.from('progress_pics')
        .select('id,captured_date,weight_lbs,waist_in,notes,body_fat_pct,body_fat_method,body_fat_confidence,front_storage_path,side_storage_path,back_storage_path,ai_analysis,ai_compared_to')
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

    // Kick off a single signed-URL batch for every photo across the
    // visible entries so thumbnails light up without a per-card fetch.
    const allPaths = [];
    for (const e of _trainProgressState.entries) {
      if (e.front_storage_path) allPaths.push(e.front_storage_path);
      if (e.side_storage_path)  allPaths.push(e.side_storage_path);
      if (e.back_storage_path)  allPaths.push(e.back_storage_path);
    }
    if (allPaths.length) refreshProgressSignedUrls(allPaths);
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

/* ════════════════════════════════════════════════════════════════════════
   HISTORY SUBTAB — list every logged workout as a tappable card.

   Reads workout_sessions + workout_sets via the existing client RLS path
   and renders newest-first. Tap a card → opens a recap modal that
   surfaces the full session detail + the persisted AI feedback (or a
   "Run analysis" button when ai_feedback is null on a legacy row).

   Shares state across the History list and the Workout pill's
   "Already logged" cards — both routes hit openHistoryRecap(sessionId).
════════════════════════════════════════════════════════════════════════ */

const _trainHistoryState = {
  loaded:   false,
  loading:  false,
  error:    null,
  sessions: [],   // workout_sessions with workout_sets[] embedded
};

async function loadTrainHistory() {
  _trainHistoryState.loading = true;
  _trainHistoryState.error = null;
  try {
    const { data, error } = await db.from('workout_sessions')
      .select('id,session_date,day_name,day_type,feel,session_notes,ai_feedback,submitted_at,workout_sets(exercise_name,set_index,actual_weight,actual_reps,is_bodyweight)')
      .eq('user_id', currentUser.id)
      .order('session_date', { ascending: false })
      .order('submitted_at', { ascending: false })
      .limit(200);
    if (error) throw error;
    _trainHistoryState.sessions = data || [];
    _trainHistoryState.loaded = true;
  } catch (e) {
    console.warn('[train] history load failed', e);
    _trainHistoryState.error = e?.message || 'Failed to load history.';
  } finally {
    _trainHistoryState.loading = false;
    if (_trainActiveView === 'history') renderTrain();
  }
}

function renderTrainHistory(root) {
  if (!_trainHistoryState.loaded && !_trainHistoryState.loading) loadTrainHistory();
  if (_trainHistoryState.loading && !_trainHistoryState.loaded) {
    root.innerHTML = `<div class="train-shell"><div class="train-loading">Loading history…</div></div>`;
    return;
  }
  if (_trainHistoryState.error) {
    root.innerHTML = `<div class="train-shell"><div class="train-error">${trainEsc(_trainHistoryState.error)}</div></div>`;
    return;
  }
  const sessions = _trainHistoryState.sessions;
  if (!sessions.length) {
    root.innerHTML = `<div class="train-shell">
      <div class="train-empty">
        <div class="train-empty-title">No logged sessions yet</div>
        <div class="train-empty-msg">Log a workout from the Workout tab and it'll appear here. Tap any past entry to see the recap + AI insight.</div>
      </div>
    </div>`;
    return;
  }
  const cards = sessions.map(renderHistoryCard).join('');
  root.innerHTML = `<div class="train-shell">
    <div class="history-list">${cards}</div>
  </div>`;
}

function renderHistoryCard(s) {
  const typeBadge = {
    lift:     { txt: 'Lift',     cls: 'is-lift' },
    cardio:   { txt: 'Cardio',   cls: 'is-cardio' },
    bonus:    { txt: 'Bonus',    cls: 'is-bonus' },
    progress: { txt: 'Progress', cls: '' },
    rest:     { txt: 'Rest',     cls: 'is-rest' },
  }[s.day_type] || { txt: s.day_type, cls: '' };
  // Mood scale: 1=Bad..5=Great (post invert_mood_scale).
  const feel = (typeof s.feel === 'number') ? (['😢','😔','😐','😊','🤩'][s.feel - 1] || '') : '';
  const sets = Array.isArray(s.workout_sets) ? s.workout_sets : [];
  // Per-type summary line.
  let summary;
  if (s.day_type === 'cardio') {
    const row = sets[0] || {};
    const dur = row.actual_reps;
    const dist = row.actual_weight;
    summary = `${row.exercise_name || 'Cardio'} · ${dur != null ? dur + ' min' : '—'}${dist != null ? ' · ' + dist + ' mi' : ''}`;
  } else if (s.day_type === 'bonus') {
    if (sets.length === 1) {
      const row = sets[0];
      summary = `${row.exercise_name || 'Activity'} · ${row.actual_reps != null ? row.actual_reps + ' min' : '—'}`;
    } else {
      const total = sets.reduce((acc, r) => acc + (Number(r.actual_reps) || 0), 0);
      summary = `${sets.length} entries · ${total} min`;
    }
  } else {
    const exerciseNames = Array.from(new Set(sets.map(r => r.exercise_name)));
    const volume = sets.reduce((acc, r) => {
      if (r.is_bodyweight) return acc;
      return acc + (Number(r.actual_weight) || 0) * (Number(r.actual_reps) || 0);
    }, 0);
    summary = `${sets.length} set${sets.length === 1 ? '' : 's'} across ${exerciseNames.length} lift${exerciseNames.length === 1 ? '' : 's'}${volume ? ' · ' + volume.toLocaleString() + ' lbs vol' : ''}`;
  }
  return `<div class="history-card" data-train-action="history-recap" data-session-id="${trainEsc(s.id)}">
    <div class="history-card-head">
      <div class="history-card-date">${trainEsc(historyFormatDate(s.session_date))}</div>
      <span class="day-detail-badge ${typeBadge.cls}">${typeBadge.txt}</span>
    </div>
    <div class="history-card-name">${trainEsc(s.day_name)} ${feel ? `<span class="history-card-feel">${feel}</span>` : ''}</div>
    <div class="history-card-summary">${trainEsc(summary)}</div>
  </div>`;
}

function historyFormatDate(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

/* ── History recap modal ──────────────────────────────────────────────
   Shared by the History list AND the "Already logged" cards on the
   Workout pill. Always loads the full session row + its sets so it
   never depends on partial state cached elsewhere. */
function openHistoryRecap(sessionId) {
  if (!sessionId) return;
  closeHistoryRecap();
  // Build a placeholder overlay first; populate once the row loads.
  const html = `<div class="train-modal-overlay" id="trainHistoryRecapModal">
    <div class="train-modal history-recap-modal" data-modal-stop>
      <div class="train-modal-head">
        <div>
          <div class="day-detail-dow">Session recap</div>
          <div class="day-detail-name" id="historyRecapTitle">Loading…</div>
        </div>
        <button class="train-modal-close" data-train-action="history-recap-close" title="Close">×</button>
      </div>
      <div class="history-recap-body" id="historyRecapBody">
        <div class="train-loading">Loading session…</div>
      </div>
    </div>
  </div>`;
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  const overlay = wrap.firstElementChild;
  document.body.appendChild(overlay);
  // Click-outside closes. The overlay handler already gates on
  // e.target === overlay so we DON'T stopPropagation inside .train-modal
  // — doing that would block the document-level data-train-action
  // delegator (line ~102) and break "Run analysis" + the close ×, which
  // are dynamic buttons wired through that delegator.
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeHistoryRecap(); });
  // Esc closes.
  const esc = (e) => { if (e.key === 'Escape') closeHistoryRecap(); };
  document.addEventListener('keydown', esc);
  overlay._escHandler = esc;
  // Fetch the row.
  (async () => {
    try {
      const { data, error } = await db.from('workout_sessions')
        .select('id,session_date,day_name,day_type,feel,session_notes,ai_feedback,workout_sets(exercise_name,set_index,actual_weight,actual_reps,is_bodyweight)')
        .eq('id', sessionId)
        .single();
      if (error) throw error;
      const titleEl = document.getElementById('historyRecapTitle');
      const bodyEl  = document.getElementById('historyRecapBody');
      if (titleEl) titleEl.innerHTML = renderHistoryRecapTitle(data);
      if (bodyEl)  bodyEl.innerHTML  = renderHistoryRecapBody(data);
    } catch (e) {
      console.warn('[train] history recap load failed', e);
      const bodyEl = document.getElementById('historyRecapBody');
      if (bodyEl) bodyEl.innerHTML = `<div class="train-error">Couldn't load this session.</div>`;
    }
  })();
}

function closeHistoryRecap() {
  const overlay = document.getElementById('trainHistoryRecapModal');
  if (overlay?._escHandler) document.removeEventListener('keydown', overlay._escHandler);
  overlay?.remove();
}

function renderHistoryRecapTitle(s) {
  const date = historyFormatDate(s.session_date);
  return `${trainEsc(s.day_name)} <span class="history-recap-date">· ${trainEsc(date)}</span>`;
}

function renderHistoryRecapBody(s) {
  const feel = (typeof s.feel === 'number') ? (['😢','😔','😐','😊','🤩'][s.feel - 1] || '') : '';
  const feelLabel = (typeof s.feel === 'number') ? (['Bad','Low','Okay','Good','Great'][s.feel - 1] || '') : '';
  const sets = Array.isArray(s.workout_sets) ? [...s.workout_sets] : [];
  sets.sort((a, b) => (a.set_index || 0) - (b.set_index || 0));
  // Group sets by exercise.
  const byEx = {};
  for (const x of sets) {
    if (!byEx[x.exercise_name]) byEx[x.exercise_name] = [];
    byEx[x.exercise_name].push(x);
  }

  // Per-type body shape.
  let bodyBlock = '';
  if (s.day_type === 'cardio' || (s.day_type === 'bonus' && sets.length === 1)) {
    const row = sets[0] || {};
    const dur  = row.actual_reps;
    const dist = row.actual_weight;
    bodyBlock = `<div class="history-recap-stat-grid">
      <div class="history-recap-stat"><div class="history-recap-stat-num">${row.exercise_name || (s.day_type === 'cardio' ? 'Cardio' : 'Activity')}</div><div class="history-recap-stat-label">Modality</div></div>
      <div class="history-recap-stat"><div class="history-recap-stat-num">${dur != null ? dur : '—'}</div><div class="history-recap-stat-label">Minutes</div></div>
      <div class="history-recap-stat"><div class="history-recap-stat-num">${dist != null ? dist : '—'}</div><div class="history-recap-stat-label">Miles</div></div>
    </div>`;
  } else {
    // Lift / multi-row bonus → per-exercise table.
    const totalSets = sets.length;
    const totalVolume = sets.reduce((acc, r) => acc + (r.is_bodyweight ? 0 : (Number(r.actual_weight) || 0) * (Number(r.actual_reps) || 0)), 0);
    const exCount = Object.keys(byEx).length;
    const stats = `<div class="history-recap-stat-grid">
      <div class="history-recap-stat"><div class="history-recap-stat-num">${totalSets}</div><div class="history-recap-stat-label">Sets</div></div>
      <div class="history-recap-stat"><div class="history-recap-stat-num">${totalVolume.toLocaleString()}</div><div class="history-recap-stat-label">Volume (lbs)</div></div>
      <div class="history-recap-stat"><div class="history-recap-stat-num">${exCount}</div><div class="history-recap-stat-label">Exercises</div></div>
    </div>`;
    const exBlocks = Object.entries(byEx).map(([name, list]) => {
      const rows = list.map((r, i) => {
        const w = r.is_bodyweight ? 'BW' : (r.actual_weight != null ? r.actual_weight : '—');
        const reps = r.actual_reps != null ? r.actual_reps : '—';
        return `<div class="history-recap-set-row">
          <span class="history-recap-set-num">S${(r.set_index || (i + 1))}</span>
          <span class="history-recap-set-w">${trainEsc(String(w))}</span>
          <span class="history-recap-set-x">×</span>
          <span class="history-recap-set-r">${trainEsc(String(reps))}</span>
        </div>`;
      }).join('');
      return `<div class="history-recap-ex">
        <div class="history-recap-ex-name">${trainEsc(name)}</div>
        ${rows}
      </div>`;
    }).join('');
    bodyBlock = `${stats}<div class="history-recap-ex-list">${exBlocks}</div>`;
  }

  const feelBlock = feel
    ? `<div class="history-recap-row"><span class="history-recap-row-label">How it felt</span><span>${feel} ${trainEsc(feelLabel)}</span></div>`
    : '';
  const notesBlock = s.session_notes
    ? `<div class="history-recap-notes"><div class="history-recap-row-label">Notes</div><div>${trainEsc(s.session_notes)}</div></div>`
    : '';
  const aiBlock = renderHistoryRecapAI(s);

  return `${bodyBlock}
    ${feelBlock}
    ${notesBlock}
    ${aiBlock}`;
}

function renderHistoryRecapAI(s) {
  const ai = s.ai_feedback;
  // Treat an empty-insight row the same as "no AI on file" so the user
  // can re-run. This recovers any session that previously landed with a
  // blank "AI · Claude" card (Claude truncating tool input, older client
  // versions, etc). Fallback rows with their own insight are still OK.
  const hasUsableInsight = ai && (
    (typeof ai.insight === 'string' && ai.insight.trim().length > 0) ||
    (Array.isArray(ai.observations) && ai.observations.length > 0)
  );
  if (!ai || !hasUsableInsight) {
    return `<div class="train-ai-block" style="margin-top:14px">
      <div class="train-ai-head">
        <div class="train-ai-label">Coach insight</div>
        <button class="train-btn-link" data-train-action="history-rerun-ai" data-session-id="${trainEsc(s.id)}">Run analysis</button>
      </div>
      <div class="train-ai-msg">No AI analysis on file for this session yet.</div>
    </div>`;
  }
  if (ai.status === 'fallback') {
    return `<div class="train-ai-block" style="margin-top:14px">
      <div class="train-ai-head">
        <div class="train-ai-label">Coach insight</div>
        <span class="train-ai-tag">deterministic</span>
      </div>
      ${ai.insight ? `<div class="train-ai-insight">${trainEsc(ai.insight)}</div>` : ''}
    </div>`;
  }
  const obs = Array.isArray(ai.observations) && ai.observations.length
    ? `<ul class="train-ai-observations">${ai.observations.map(o => `<li>${trainEsc(o)}</li>`).join('')}</ul>`
    : '';
  return `<div class="train-ai-block" style="margin-top:14px">
    <div class="train-ai-head">
      <div class="train-ai-label">Coach insight</div>
      <span class="train-ai-tag is-ai">AI · Claude</span>
    </div>
    ${ai.insight ? `<div class="train-ai-insight">${trainEsc(ai.insight)}</div>` : ''}
    ${obs}
  </div>`;
}

async function historyRecapRerunAI(sessionId) {
  const bodyEl = document.getElementById('historyRecapBody');
  if (!bodyEl) return;
  // Inline loading state inside the AI block area.
  const aiBlock = bodyEl.querySelector('.train-ai-block');
  if (aiBlock) aiBlock.innerHTML = `<div class="train-ai-label">Coach insight</div><div class="train-ai-skel"></div><div class="train-ai-skel" style="width:70%"></div>`;
  try {
    const { data: { session } } = await db.auth.getSession();
    const token = session?.access_token;
    if (!token) throw new Error('not signed in');
    const r = await fetch('/.netlify/functions/beta-train-feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ session_id: sessionId }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `http_${r.status}`);
    // Use the function response directly. The server persists ai_feedback
    // best-effort in the background — if we refetched here we'd race the
    // write (causing blank "AI · Claude" cards on slow persist) and we'd
    // miss the result entirely if persist failed. The function response
    // IS the authoritative answer.
    const refreshed = await db.from('workout_sessions')
      .select('id,session_date,day_name,day_type,feel,session_notes,workout_sets(exercise_name,set_index,actual_weight,actual_reps,is_bodyweight)')
      .eq('id', sessionId)
      .single()
      .then(({ data }) => data ? { ...data, ai_feedback: j } : null);
    if (refreshed) bodyEl.innerHTML = renderHistoryRecapBody(refreshed);
    // Also patch the in-memory history list so the next render shows
    // the new ai_feedback without a full reload.
    const idx = _trainHistoryState.sessions.findIndex(x => x.id === sessionId);
    if (idx >= 0 && refreshed) _trainHistoryState.sessions[idx] = refreshed;
  } catch (e) {
    console.warn('[train] history re-run AI failed', e);
    if (aiBlock) aiBlock.innerHTML = `<div class="train-ai-label">Coach insight</div><div class="train-ai-msg">Couldn't reach the coach. Try again.</div>`;
  }
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
    // user_preferences has full RLS (user owns their row) so a plain
    // upsert works — RLS no longer silently 0-affects. Match on user_id
    // (the table's primary key); inserts when no row exists yet, updates
    // otherwise.
    const { data: updated, error } = await db.from('user_preferences')
      .upsert({ user_id: currentUser.id, ...patch }, { onConflict: 'user_id' })
      .select()
      .single();
    if (error) throw error;
    if (!updated) {
      throw new Error('user_preferences row not written for ' + currentUser.id);
    }
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

  // Body fat now comes from the AI vision pass (Navy formula removed).
  // Just read the stored value off the latest entry.
  const bfPct = latest?.body_fat_pct != null ? Number(latest.body_fat_pct) : null;

  // Dashboard order (latest reshuffle — promotes Goals above the fold):
  //   1. profile header
  //   2. latest-entry eyebrow + 4-cell metrics strip       (where you are)
  //   3. Goals card                                         (where you're heading)
  //   4. Coach Card — AI photo analysis                     (why + how)
  //   5. Daily calorie target                               (today's lever)
  //   6. Weight trend chart                                 (history)
  //   7. Recent entries list                                (drill-in)
  // Goals were previously at position 5 and routinely got buried below
  // the giant Coach Card; promoting them right under the metrics strip
  // keeps the user's North Star above the fold.
  return `
    ${renderDashboardHeader(p)}
    ${latest ? renderDashboardLatestCard(latest, bfPct, entries) : renderDashboardEmptyCard()}
    ${renderDashboardGoalsCard(weightGoal, fatGoal, latest, bfPct)}
    ${latest ? renderProgressAIAnalysis(latest) : ''}
    ${tdee != null ? renderDashboardCalorieCard(bmr, tdee, dailyCal, macros, weightGoal, calMath) : ''}
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

function renderDashboardLatestCard(latest, bfPct, entries) {
  const today = trainTodayLocalDate();
  const ageDays = Math.round((new Date(today) - new Date(latest.captured_date)) / 86400_000);
  const ageTxt = ageDays === 0 ? 'today' : ageDays === 1 ? 'yesterday' : `${ageDays} days ago`;

  // Body fat: stored AI value (Navy removed). Single branch now.
  const bfNum = bfPct != null ? `${bfPct.toFixed(1)}%` : '—';

  // LBM = weight × (1 − bf/100). Deterministic. Skip when either is missing.
  const w = latest.weight_lbs != null ? Number(latest.weight_lbs) : null;
  const bf = bfPct;   // single source: stored AI value (Navy removed)
  const lbm = (w != null && bf != null) ? w * (1 - bf / 100) : null;

  // Sparklines from recent entries (newest-first → reverse). Last 6 points
  // each, only entries where the metric exists.
  const points = (arr) => {
    const vals = entries.slice(0, 6).reverse()
      .map(e => arr === 'weight'  ? e.weight_lbs
              : arr === 'bf'      ? (e.body_fat_pct != null ? Number(e.body_fat_pct) : null)
              : arr === 'lbm'     ? (e.weight_lbs && e.body_fat_pct ? Number(e.weight_lbs) * (1 - Number(e.body_fat_pct) / 100) : null)
              :                     e.waist_in)
      .filter(v => v != null && Number.isFinite(Number(v)))
      .map(Number);
    return vals;
  };
  const spark = (vals, color) => {
    if (vals.length < 2) return `<div class="metric-spark-empty"></div>`;
    const W = 100, H = 28, pad = 2;
    const min = Math.min(...vals), max = Math.max(...vals);
    const range = (max - min) || 1;
    const xs = vals.map((_, i) => pad + (i * (W - 2 * pad)) / (vals.length - 1));
    const ys = vals.map(v => H - pad - ((v - min) / range) * (H - 2 * pad));
    const d = vals.map((_, i) => `${i === 0 ? 'M' : 'L'}${xs[i].toFixed(1)},${ys[i].toFixed(1)}`).join(' ');
    // End-point dot draws attention to the current value at the right edge.
    const lastX = xs[xs.length - 1], lastY = ys[ys.length - 1];
    return `<svg class="metric-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="2.5" fill="${color}"/>
    </svg>`;
  };

  // ── Delta pills: oldest → newest entry within the loaded window ──
  // Compute delta + dynamic window label (1y / Xmo / Xd) so the user
  // sees not just the current value but the trend at-a-glance.
  const weightGoal = _trainProgressState.goals.find(g => g.kind === 'weight') || null;
  const oldest = entries.length > 1 ? entries[entries.length - 1] : null;
  const winDays = oldest
    ? Math.max(1, Math.round((new Date(latest.captured_date) - new Date(oldest.captured_date)) / 86400_000))
    : 0;
  const winLabel = !oldest ? null
                 : winDays >= 330 ? '1y'
                 : winDays >= 150 ? '6mo'
                 : winDays >=  60 ? `${Math.round(winDays / 30)}mo`
                 :                  `${winDays}d`;

  const oldW = oldest?.weight_lbs   != null ? Number(oldest.weight_lbs)   : null;
  const oldBf = oldest?.body_fat_pct != null ? Number(oldest.body_fat_pct) : null;
  const oldWaist = oldest?.waist_in != null ? Number(oldest.waist_in) : null;
  const oldLbm = (oldW != null && oldBf != null) ? oldW * (1 - oldBf / 100) : null;

  const deltaWeight = (w   != null && oldW   != null) ? w   - oldW   : null;
  const deltaBf     = (bf  != null && oldBf  != null) ? bf  - oldBf  : null;
  const deltaLbm    = (lbm != null && oldLbm != null) ? lbm - oldLbm : null;
  const deltaWaist  = (latest.waist_in != null && oldWaist != null) ? Number(latest.waist_in) - oldWaist : null;

  // Direction-correctness map. Weight is goal-aware (bulk → up good,
  // cut → down good); the rest have fixed conventions.
  const isWeightBulk = weightGoal && Number(weightGoal.target_value) > Number(weightGoal.start_value);
  const isWeightCut  = weightGoal && Number(weightGoal.target_value) < Number(weightGoal.start_value);
  const weightIsGood = (d) => isWeightBulk ? d > 0 : isWeightCut ? d < 0 : null;

  const pill = (delta, unit, isGoodFn) => {
    if (delta == null || winLabel == null) return '';
    const abs = Math.abs(delta);
    const sign = delta > 0 ? '+' : delta < 0 ? '−' : '±';
    const good = typeof isGoodFn === 'function' ? isGoodFn(delta) : isGoodFn;
    const cls = good === true ? 'up' : good === false ? 'down' : 'neutral';
    return `<span class="metric-cell-delta ${cls}">${sign}${abs.toFixed(1)}${unit} · ${winLabel}</span>`;
  };

  // Thin 4-cell metrics strip. Each cell: top-aligned delta pill, then
  // label, then big number with small unit suffix, then sparkline.
  const metricsStrip = `<div class="metrics-strip">
    <div class="metric-cell">
      ${pill(deltaLbm, ' lbs', d => d > 0)}
      <div class="metric-cell-label">Lean mass</div>
      <div class="metric-cell-num">${lbm != null ? lbm.toFixed(1) : '—'}<span class="metric-cell-unit">lbs</span></div>
      ${spark(points('lbm'), 'var(--moss-fg, #5e8c4f)')}
    </div>
    <div class="metric-cell">
      ${pill(deltaWeight, ' lbs', weightIsGood)}
      <div class="metric-cell-label">Weight</div>
      <div class="metric-cell-num">${w != null ? w.toFixed(1) : '—'}<span class="metric-cell-unit">lbs</span></div>
      ${spark(points('weight'), 'var(--guava-700)')}
    </div>
    <div class="metric-cell">
      ${pill(deltaBf, '%', d => d < 0)}
      <div class="metric-cell-label">Body fat</div>
      <div class="metric-cell-num">${bfNum}</div>
      ${spark(points('bf'), 'var(--guava-700)')}
    </div>
    <div class="metric-cell">
      ${pill(deltaWaist, '"', d => d < 0)}
      <div class="metric-cell-label">Waist</div>
      <div class="metric-cell-num">${latest.waist_in != null ? Number(latest.waist_in).toFixed(1) : '—'}<span class="metric-cell-unit">in</span></div>
      ${spark(points('waist'), 'var(--ink-3)')}
    </div>
  </div>`;

  // Latest-entry eyebrow row (slim — just date + log-entry CTA) + the
  // 4-cell metrics strip. The Coach Card (renderProgressAIAnalysis) is
  // now rendered separately by renderProgressDashboard so Goals can
  // slot between this block and the AI read.
  return `<div class="progress-latest-eyebrow">
    <div>
      <span class="progress-card-label">Latest entry</span>
      <span class="progress-card-meta" style="margin-left:8px">Logged ${trainEsc(ageTxt)}</span>
    </div>
    <button class="train-btn-primary" data-train-action="progress-new-entry">+ Log entry</button>
  </div>
  ${metricsStrip}`;
}

// Coach Card — Body Comp Report v2 (Variation A "narrative-first").
// Replaces the small AI analysis block on the Latest Entry card. The
// hierarchy is: prescriptive prose → numbered focus areas with named
// exercises → posture callout → limitations. Same `train-ai-block`
// chrome so the AI surface stays visually distinct from formulaic stats.
//
// Supports two focus_areas shapes for back-compat:
//   1. Rich (new):  [{ title, rationale, exercises[], programming_hint }, ...]
//   2. Flat (old):  ['Hamstrings', 'Mid-back', ...]
// New entries from progress-pic-analysis return the rich shape; legacy
// entries still render via the flat fallback path.
function renderProgressAIAnalysis(entry) {
  if (entry._analyzing) {
    return `<div class="train-ai-block is-loading" style="margin-top:14px">
      <div class="train-ai-label">Coach insight</div>
      <div class="train-ai-skel"></div>
      <div class="train-ai-skel" style="width:70%"></div>
    </div>`;
  }
  if (entry._analyzeError) {
    return `<div class="train-ai-block is-error" style="margin-top:14px">
      <div class="train-ai-head">
        <div class="train-ai-label">Coach insight</div>
        <button class="train-btn-link" data-train-action="progress-analyze" data-id="${entry.id}">Retry</button>
      </div>
      <div class="train-ai-msg">Couldn’t reach the vision coach. Your photos are saved.</div>
    </div>`;
  }
  const a = entry.ai_analysis;
  if (!a) {
    if (entry.front_storage_path || entry.side_storage_path || entry.back_storage_path) {
      return `<div class="train-ai-block" style="margin-top:14px">
        <div class="train-ai-head">
          <div class="train-ai-label">Coach insight</div>
          <button class="train-btn-link" data-train-action="progress-analyze" data-id="${entry.id}">Run analysis</button>
        </div>
        <div class="train-ai-msg">Photos uploaded — tap "Run analysis" to get a Claude vision read.</div>
      </div>`;
    }
    return '';
  }

  // Trait pills (Bulk/Cut/Maintain comes from goal direction, not AI).
  const traitPills = [
    a.body_type ? `<span class="train-pill">${trainEsc(a.body_type)}</span>` : '',
    a.stage     ? `<span class="train-pill">${trainEsc(a.stage)}</span>`     : '',
    a.v_taper   ? `<span class="train-pill">V-taper · ${trainEsc(a.v_taper)}</span>` : '',
  ].filter(Boolean).join('');

  // Focus areas — numbered programmed cards. Detect rich vs flat shape.
  const focusItems = Array.isArray(a.focus_areas) ? a.focus_areas : [];
  // Legacy detection: if every entry is a plain string, this analysis
  // predates the rich schema. Offer a one-click re-run so the user can
  // upgrade without re-uploading photos.
  const isLegacyFocus = focusItems.length > 0 && focusItems.every(f => typeof f === 'string');
  const focusHTML = focusItems.map((f, i) => {
    if (typeof f === 'string') {
      // Legacy flat shape — render as a one-line numbered row.
      return `<div class="coach-focus-row coach-focus-row--legacy">
        <div class="coach-focus-num">${i + 1}</div>
        <div>
          <div class="coach-focus-title">${trainEsc(f)}</div>
        </div>
      </div>`;
    }
    const title = f.title || f.name || `Focus ${i + 1}`;
    const rationale = f.rationale || f.why || '';
    const exercises = Array.isArray(f.exercises) ? f.exercises : [];
    const hint = f.programming_hint || f.hint || '';
    return `<div class="coach-focus-row">
      <div class="coach-focus-num">${i + 1}</div>
      <div>
        <div class="coach-focus-title">${trainEsc(title)}</div>
        ${rationale ? `<div class="coach-focus-why">${trainEsc(rationale)}</div>` : ''}
        ${exercises.length ? `<div class="coach-focus-ex">${exercises.map(e =>
          `<span class="coach-ex-pill">${trainEsc(e)}</span>`).join('')}</div>` : ''}
        ${hint ? `<div class="coach-focus-hint">${trainEsc(hint)}</div>` : ''}
      </div>
    </div>`;
  }).join('');
  // "Re-run analysis" CTA banner when the stored data is legacy-flat.
  const legacyUpgradeHTML = isLegacyFocus
    ? `<div class="coach-upgrade-banner">
        <div class="coach-upgrade-msg">This analysis was from an older schema. Re-run to get exercise prescriptions + programming hints.</div>
        <button class="train-btn-primary" data-train-action="progress-analyze" data-id="${entry.id}">Re-run analysis</button>
       </div>`
    : '';

  // Posture / symmetry callout (moss-green callout box).
  const postureBits = [];
  if (a.posture)     postureBits.push(a.posture);
  if (a.symmetry)    postureBits.push(`Symmetry: ${a.symmetry}`);
  if (a.upper_lower) postureBits.push(a.upper_lower);
  const calloutHTML = postureBits.length
    ? `<div class="coach-callout">
        <span class="coach-callout-icon">✓</span>
        <div>${trainEsc(postureBits.join(' · '))}</div>
       </div>`
    : '';

  // Limitations — single italic line at the bottom.
  const limitationsArr = Array.isArray(a.limitations) ? a.limitations : [];
  const limitationsHTML = limitationsArr.length
    ? `<div class="coach-limitation">Limitation: ${trainEsc(limitationsArr.join(' · '))}</div>`
    : '';

  // "Needs work" / "Balanced" — show as muscle-group chips below the focus
  // areas. Lower hierarchy than the numbered focus cards.
  const needsHTML = Array.isArray(a.needs_work) && a.needs_work.length
    ? `<div class="coach-secondary-row"><span class="coach-secondary-label">Needs work</span><span class="coach-chip-group">${a.needs_work.map(x => `<span class="coach-secondary-chip">${trainEsc(x)}</span>`).join('')}</span></div>`
    : '';
  const balancedHTML = Array.isArray(a.balanced) && a.balanced.length
    ? `<div class="coach-secondary-row"><span class="coach-secondary-label">Balanced</span><span class="coach-chip-group">${a.balanced.map(x => `<span class="coach-secondary-chip">${trainEsc(x)}</span>`).join('')}</span></div>`
    : '';

  // Photos block — moved into the Coach Card per the Variation A mockup
  // (was on the Latest Entry card). Renders 2-up (front + side) when
  // both exist; 3-up if back is also present; single column otherwise.
  const photoPaths = [
    { key: 'front', path: entry.front_storage_path, label: 'Front' },
    { key: 'side',  path: entry.side_storage_path,  label: 'Side'  },
    { key: 'back',  path: entry.back_storage_path,  label: 'Back'  },
  ].filter(x => x.path);
  let photosHTML = '';
  if (photoPaths.length) {
    const signed = _trainProgressState.photoSignedUrls || {};
    const cols = photoPaths.length === 1 ? '1fr'
               : photoPaths.length === 2 ? '1fr 1fr'
               :                            '1fr 1fr 1fr';
    photosHTML = `<div class="coach-photos" style="grid-template-columns:${cols}">
      ${photoPaths.map(p => signed[p.path]
        ? `<div class="coach-photo"><img src="${signed[p.path]}" alt="${p.label}"/><span class="coach-photo-label">${p.label}</span></div>`
        : `<div class="coach-photo coach-photo--loading"><span class="coach-photo-label">${p.label}</span></div>`
      ).join('')}
    </div>`;
  }

  return `<div class="train-ai-block coach-card" style="margin-top:14px">
    <div class="train-ai-head">
      <div class="train-ai-label">Coach insight</div>
      <span class="train-ai-tag is-ai">AI · Claude vision</span>
    </div>
    ${traitPills ? `<div class="coach-traits">${traitPills}</div>` : ''}
    ${a.headline ? `<h3 class="coach-headline">${trainEsc(a.headline)}</h3>` : ''}
    ${a.overview ? `<div class="coach-overview">${trainEsc(a.overview)}</div>` : ''}
    ${focusHTML ? `<div class="coach-focus-block">${focusHTML}</div>` : ''}
    ${legacyUpgradeHTML}
    ${(needsHTML || balancedHTML) ? `<div class="coach-secondary">${needsHTML}${balancedHTML}</div>` : ''}
    ${photosHTML}
    ${calloutHTML}
    ${limitationsHTML}
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

// Combined goals card — weight + body fat sections share a single card
// so the Progress dashboard doesn't fragment into two big gradient
// blocks. Each section keeps the headline + Start/Now/Target row + ETA
// from the mockup, separated by a hairline divider.
function renderDashboardGoalsCard(weightGoal, fatGoal, latest, bfPct) {
  return `<div class="goal-combined-card">
    <div class="progress-card-head" style="margin-bottom:10px">
      <div>
        <div class="progress-card-label">Goals</div>
        <div class="progress-card-meta">Progress vs. start value</div>
      </div>
    </div>
    <div class="goal-section ${weightGoal ? '' : 'is-empty'}">
      ${weightGoal
        ? renderGoalSection(weightGoal, latest?.weight_lbs, 'weight')
        : renderGoalSectionEmpty('weight')}
    </div>
    <div class="goal-section ${fatGoal ? '' : 'is-empty'}">
      ${fatGoal
        ? renderGoalSection(fatGoal, bfPct, 'body_fat')
        : renderGoalSectionEmpty('body_fat')}
    </div>
  </div>`;
}

function renderGoalSection(goal, current, kind) {
  const unit  = kind === 'weight' ? 'lbs' : '%';
  const label = kind === 'weight' ? 'Weight' : 'Body fat';
  const startVal  = Number(goal.start_value);
  const targetVal = Number(goal.target_value);
  const curVal    = current != null ? Number(current) : null;

  const direction = targetVal > startVal ? 'up' : (targetVal < startVal ? 'down' : 'flat');
  const totalRange = Math.abs(targetVal - startVal) || 1;
  const movedAbs   = curVal != null ? Math.abs(curVal - startVal) : 0;
  const pct = Math.max(0, Math.min(100, Math.round((movedAbs / totalRange) * 100)));
  const remaining = curVal != null ? Math.abs(targetVal - curVal) : Math.abs(targetVal - startVal);

  // ETA: rate per day from start, project days-to-target.
  const startDate = new Date(goal.start_date + 'T00:00:00');
  const today = new Date();
  const daysSinceStart = Math.max(1, Math.round((today - startDate) / 86400_000));
  const endDate = new Date(goal.end_date + 'T00:00:00');
  const daysLeft = Math.max(0, Math.round((endDate - today) / 86400_000));
  let etaTxt;
  if (curVal == null) {
    etaTxt = `Log an entry to start tracking.`;
  } else {
    const delta = curVal - startVal;
    const ratePerDay = delta / daysSinceStart;
    const ratePerMonth = ratePerDay * 30;
    const correctDirection = (direction === 'up' && ratePerDay > 0)
                          || (direction === 'down' && ratePerDay < 0);
    const ratePart = `<strong>${ratePerMonth > 0 ? '+' : ''}${ratePerMonth.toFixed(2)} ${unit}/mo</strong>`;
    if (Math.abs(ratePerDay) < 1e-6 || !correctDirection) {
      etaTxt = `At your current rate (${ratePart}), you won't hit target by ${trainEsc(goal.end_date)}. Pick up the pace or extend the date.`;
    } else {
      const daysToTarget = (targetVal - curVal) / ratePerDay;
      const monthsToTarget = daysToTarget / 30;
      const onPace = daysToTarget <= daysLeft;
      etaTxt = onPace
        ? `At your current rate (${ratePart}), target lands in ~${monthsToTarget.toFixed(1)} months — on pace.`
        : `At your current rate (${ratePart}), target lands in ~${monthsToTarget.toFixed(1)} months — that's after your ${daysLeft}-day deadline.`;
    }
  }

  // For "lose" goals (down direction), the bar visually fills from start toward target.
  // Same math either way — pct is movement-along-the-range %.
  const directionVerb = direction === 'down' ? 'to lose' : 'to add';
  const headlineRemaining = curVal != null
    ? `${remaining.toFixed(1)} ${unit} ${directionVerb} → target ${targetVal.toFixed(1)} ${unit}`
    : `Target ${targetVal.toFixed(1)} ${unit}`;

  return `<div class="goal-section-inner">
    <div class="goal-section-head">
      <div>
        <div class="goal-section-eyebrow">${trainEsc(label)}</div>
        <div class="goal-section-title">${trainEsc(headlineRemaining)}</div>
      </div>
      <button class="train-btn-link" data-train-action="progress-edit-goal" data-kind="${kind}">Edit ↗</button>
    </div>
    <div class="goal-big-bar"><div class="goal-big-bar-fill" style="width:${pct}%"></div></div>
    <div class="goal-big-stats">
      <span>Start · <strong>${startVal.toFixed(1)} ${unit}</strong></span>
      <span>Now · <strong>${curVal != null ? curVal.toFixed(1) + ' ' + unit : '—'}</strong></span>
      <span>Target · <strong>${targetVal.toFixed(1)} ${unit}</strong></span>
    </div>
    <div class="goal-big-eta">${etaTxt}</div>
  </div>`;
}

function renderGoalSectionEmpty(kind) {
  const label = kind === 'weight' ? 'Weight' : 'Body fat';
  const verb  = kind === 'weight' ? 'weight' : 'body fat';
  return `<div class="goal-section-inner">
    <div class="goal-section-head">
      <div>
        <div class="goal-section-eyebrow">${trainEsc(label)}</div>
        <div class="goal-section-title goal-section-title--empty">No ${verb} goal set</div>
      </div>
      <button class="train-btn-secondary" data-train-action="progress-edit-goal" data-kind="${kind}">Set goal</button>
    </div>
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
  // Navy formula was retired — only waist carries over as a standalone
  // tracking number (it's one of the 4 strip metrics on the dashboard).
  // Neck/hips/chest/arms/thighs are no longer captured.
  _trainProgressState.entryDraft = {
    captured_date: trainTodayLocalDate(),
    weight_lbs:    '',
    waist_in:      latest?.waist_in  != null ? String(latest.waist_in)  : '',
    notes:         '',
    // Photo state — three slots (front / side / back). `file` holds the
    // freshly-picked File pending upload; `preview` is a transient
    // object URL for the thumbnail; `path` is the persisted
    // storage object path once the row has been saved.
    photos: {
      front: { file: null, preview: null, path: null },
      side:  { file: null, preview: null, path: null },
      back:  { file: null, preview: null, path: null },
    },
  };
}

function renderProgressNewEntry() {
  ensureEntryDraft();
  const d = _trainProgressState.entryDraft;

  return `<div class="progress-new-entry">
    <div class="progress-wizard-head">
      <button class="train-btn-link" data-train-action="progress-back" style="margin-bottom:6px">← Back to dashboard</button>
      <div class="progress-wizard-title">Log entry</div>
      <div class="progress-wizard-msg">Claude Vision will analyze your body composition and give your personalized actionable insights to improve.</div>
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
        <div class="train-form-label">Photos</div>
        <div class="train-form-hint" style="margin-bottom:8px">Claude Vision will analyze your body composition and give your personalized actionable insights to improve.</div>
        <div class="progress-photo-grid">
          ${renderProgressPhotoSlot(d.photos.front, 'front', 'Front', true)}
          ${renderProgressPhotoSlot(d.photos.side,  'side',  'Side',  true)}
          ${renderProgressPhotoSlot(d.photos.back,  'back',  'Back',  false)}
        </div>
      </div>

      <div class="train-form-section">
        <div class="train-form-label">Waist (optional)</div>
        <input class="form-input" type="number" inputmode="decimal" step="0.1" min="0" placeholder="inches" value="${trainEsc(d.waist_in || '')}" data-train-action="entry-input" data-key="waist_in">
        <div class="train-form-hint">A single tape-measure number for the Waist metric tile. Body fat % comes from the photos via AI.</div>
      </div>

      <div class="train-form-actions">
        <button class="train-btn-secondary" data-train-action="progress-back">Cancel</button>
        <button class="train-btn-primary" data-train-action="entry-save" ${_trainProgressState.saving ? 'disabled' : ''}>
          ${_trainProgressState.saving ? _trainProgressState.savingStep || 'Saving…' : 'Save entry'}
        </button>
      </div>
    </div>
  </div>`;
}

// Renders one photo slot. Three visual states:
// - Empty: "+ Add photo" placeholder (with optional "Required" / "Optional"
//   pill so the user knows which two are mandatory).
// - Picked (file): shows the local preview from URL.createObjectURL.
// - Persisted (path): shows a signed-URL <img> with a "replace" affordance.
function renderProgressPhotoSlot(slot, key, label, required) {
  const inputId = `progressPhoto_${key}`;
  if (slot.preview) {
    return `<label class="progress-photo-slot is-picked" for="${inputId}">
      <img src="${slot.preview}" alt="${label} preview"/>
      <span class="progress-photo-label">${label}</span>
      <button class="progress-photo-remove" data-train-action="photo-remove" data-slot="${key}" title="Remove">×</button>
      <input id="${inputId}" type="file" accept="image/*" data-train-action="photo-pick" data-slot="${key}" hidden>
    </label>`;
  }
  if (slot.path) {
    const signed = (_trainProgressState.photoSignedUrls || {})[slot.path];
    return `<label class="progress-photo-slot is-persisted" for="${inputId}">
      ${signed ? `<img src="${signed}" alt="${label}"/>` : `<div class="progress-photo-loading">Loading…</div>`}
      <span class="progress-photo-label">${label}</span>
      <span class="progress-photo-replace">Replace</span>
      <input id="${inputId}" type="file" accept="image/*" data-train-action="photo-pick" data-slot="${key}" hidden>
    </label>`;
  }
  return `<label class="progress-photo-slot is-empty ${required ? 'is-required' : ''}" for="${inputId}">
    <span class="progress-photo-plus">+</span>
    <span class="progress-photo-label">${label}</span>
    <span class="progress-photo-req">${required ? 'Required' : 'Optional'}</span>
    <input id="${inputId}" type="file" accept="image/*" data-train-action="photo-pick" data-slot="${key}" hidden>
  </label>`;
}

// Handle a freshly-picked file: revoke any existing preview, downscale
// to ≤1600px on the longest edge (Claude vision works fine at this
// resolution; 5MB phone photos are wasteful + slow), then stash the
// compressed Blob + a new preview URL on the draft.
async function handleProgressPhotoPick(slot, file) {
  ensureEntryDraft();
  const ph = _trainProgressState.entryDraft.photos[slot];
  if (ph?.preview) { try { URL.revokeObjectURL(ph.preview); } catch (_) {} }

  // Optimistic preview from the raw file so the thumbnail appears
  // immediately while the downscale runs.
  const previewUrl = URL.createObjectURL(file);
  _trainProgressState.entryDraft.photos[slot] = {
    file:    file,
    preview: previewUrl,
    path:    null,
  };
  renderTrain();

  try {
    const compressed = await downscaleImage(file, 1600);
    _trainProgressState.entryDraft.photos[slot].file = compressed;
  } catch (e) {
    console.warn('[train] photo downscale failed; using original', e);
    // Keep the original file — upload still works, just slower.
  }
}

// Canvas-based downscale. Reads the file into an Image, draws to a
// canvas at the target max-dimension preserving aspect, returns a JPEG
// Blob at quality 0.85. Falls back to the original file on any error.
function downscaleImage(file, maxDim) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('file_read_failed'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('image_decode_failed'));
      img.onload = () => {
        const { naturalWidth: w, naturalHeight: h } = img;
        const scale = Math.min(1, maxDim / Math.max(w, h));
        const tw = Math.round(w * scale);
        const th = Math.round(h * scale);
        const canvas = document.createElement('canvas');
        canvas.width = tw; canvas.height = th;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, tw, th);
        canvas.toBlob(blob => {
          if (!blob) return reject(new Error('canvas_to_blob_failed'));
          resolve(new File([blob], file.name.replace(/\.\w+$/, '.jpg'), { type: 'image/jpeg' }));
        }, 'image/jpeg', 0.85);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// Upload a single photo to progress-pics/{user}/{date}/{slot}.jpg via
// the supabase-js storage client. Returns the object path. Throws on
// failure so the caller can decide whether to fail the save or keep
// going.
async function uploadProgressPhoto(file, capturedDate, slot) {
  const ext = (file.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
  const path = `${currentUser.id}/${capturedDate}/${slot}.${ext}`;
  const { error } = await db.storage.from('progress-pics')
    .upload(path, file, { upsert: true, contentType: file.type || 'image/jpeg' });
  if (error) throw error;
  return path;
}

// Background fetch of signed URLs for any persisted photo paths on the
// current entry draft (or the most recent dashboard entry). 60-min TTL —
// long enough for typical sessions, short enough that a leaked URL
// can't be replayed forever.
async function refreshProgressSignedUrls(paths) {
  const unique = [...new Set((paths || []).filter(Boolean))];
  if (!unique.length) return;
  if (!_trainProgressState.photoSignedUrls) _trainProgressState.photoSignedUrls = {};
  try {
    const { data, error } = await db.storage.from('progress-pics').createSignedUrls(unique, 3600);
    if (error) throw error;
    for (const row of data || []) {
      if (row.signedUrl) _trainProgressState.photoSignedUrls[row.path] = row.signedUrl;
    }
    if (_trainActiveView === 'progress') renderTrain();
  } catch (e) {
    console.warn('[train] signed url batch failed', e);
  }
}

async function saveProgressEntry() {
  const d = _trainProgressState.entryDraft;
  const p = _trainProgressState.profile;
  if (!d || !d.captured_date) return;
  // Front + Side are required (Back is optional). A persisted path counts
  // — when editing an existing entry that already has photos the user
  // doesn't have to re-pick. Surfacing this with a toast keeps the
  // friction low; the slot itself is visually marked "Required" already.
  const hasFront = !!(d.photos.front.file || d.photos.front.path);
  const hasSide  = !!(d.photos.side.file  || d.photos.side.path);
  if (!hasFront || !hasSide) {
    const missing = [!hasFront && 'Front', !hasSide && 'Side'].filter(Boolean).join(' and ');
    showTrainToast(`Add a ${missing} photo to save the entry.`);
    return;
  }
  _trainProgressState.saving = true;
  _trainProgressState.savingStep = 'Saving…';
  renderTrain();
  try {
    // ── Step 1: upload any freshly-picked photos. Existing paths
    // (no new file) carry over. If a slot was explicitly cleared via
    // photo-remove the path is null and we record that too.
    const photoPaths = { front: null, side: null, back: null };
    const slotsToUpload = ['front','side','back'].filter(k => d.photos[k].file);
    if (slotsToUpload.length) {
      _trainProgressState.savingStep = `Uploading ${slotsToUpload.length} photo${slotsToUpload.length === 1 ? '' : 's'}…`;
      renderTrain();
      for (const k of ['front','side','back']) {
        const ph = d.photos[k];
        if (ph.file) {
          photoPaths[k] = await uploadProgressPhoto(ph.file, d.captured_date, k);
        } else if (ph.path) {
          photoPaths[k] = ph.path;     // keep existing
        }
      }
    } else {
      for (const k of ['front','side','back']) {
        if (d.photos[k].path) photoPaths[k] = d.photos[k].path;
      }
    }

    // ── Step 2: build the row. Body fat is no longer computed
    // client-side — the AI vision pass fills body_fat_pct +
    // body_fat_method='ai_estimate' once it finishes. The Navy formula
    // path has been retired.
    _trainProgressState.savingStep = 'Saving…';
    renderTrain();
    const waist = d.waist_in ? Number(d.waist_in) : null;

    const row = {
      user_id:       currentUser.id,
      captured_date: d.captured_date,
      weight_lbs:    d.weight_lbs ? Number(d.weight_lbs) : null,
      waist_in:      waist,
      notes:         d.notes || null,
      // body_fat_pct / body_fat_method / body_fat_confidence intentionally
      // omitted — the AI vision call writes them. (The columns stay
      // nullable in the schema.)
      front_storage_path: photoPaths.front,
      side_storage_path:  photoPaths.side,
      back_storage_path:  photoPaths.back,
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

    // Refresh signed URLs for whatever was just uploaded so the
    // dashboard thumbnails light up.
    refreshProgressSignedUrls([photoPaths.front, photoPaths.side, photoPaths.back]);

    // Kick off the AI vision analysis (background — failure is non-fatal).
    if (slotsToUpload.length || (!saved.ai_analysis && (photoPaths.front || photoPaths.side || photoPaths.back))) {
      runProgressPicAnalysis(saved.id);
    }

    _trainProgressState.entryDraft = null;
    _trainProgressState.view = 'dashboard';
  } catch (e) {
    console.warn('[train] save progress entry failed', e);
    showTrainToast('Save failed — ' + (e.message || 'try again'));
  } finally {
    _trainProgressState.saving = false;
    _trainProgressState.savingStep = null;
    renderTrain();
  }
}

// Background call to /.netlify/functions/beta-progress-pic-analysis with
// the progress_pic row id. The function reads the row + the photo blobs
// via the service key, sends them to Claude with a vision prompt, and
// writes the result back to progress_pics.ai_analysis. The client
// listens for the response, patches the local cache, and re-renders.
async function runProgressPicAnalysis(progressPicId) {
  if (!progressPicId) return;
  const entry = _trainProgressState.entries.find(e => e.id === progressPicId);
  if (entry) entry._analyzing = true;
  if (_trainActiveView === 'progress') renderTrain();
  try {
    const { data: { session } } = await db.auth.getSession();
    const token = session?.access_token;
    if (!token) return;
    const r = await fetch('/.netlify/functions/beta-progress-pic-analysis', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body:    JSON.stringify({ progress_pic_id: progressPicId }),
    });
    const j = await r.json();
    if (!r.ok) {
      console.warn('[train] progress vision call failed', j);
      if (entry) entry._analyzeError = j.error || `http_${r.status}`;
      return;
    }
    if (entry && j.ai_analysis) {
      entry.ai_analysis = j.ai_analysis;
      if (j.body_fat_pct != null) entry.body_fat_pct = j.body_fat_pct;
      if (j.body_fat_method)      entry.body_fat_method = j.body_fat_method;
      if (j.body_fat_confidence)  entry.body_fat_confidence = j.body_fat_confidence;
    }
  } catch (e) {
    console.warn('[train] progress vision exception', e);
    if (entry) entry._analyzeError = e.message;
  } finally {
    if (entry) entry._analyzing = false;
    if (_trainActiveView === 'progress') renderTrain();
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

    /* Train subtab pill-bar (Workout / History / My Progress). Same
       chrome as habits sub-pills with an inline icon prepended to each
       label. Icon inherits currentColor so the active black-on-pill
       state flips it automatically. */
    .train-sub-pills .train-pill {
      background: var(--surface); border: 1px solid var(--edge);
      color: var(--ink-3);
      display: inline-flex; align-items: center; gap: 6px;
    }
    .train-sub-pills .train-pill.active {
      background: var(--ink); color: #fff; border-color: var(--ink);
    }
    .train-pill-icon { width: 14px; height: 14px; flex-shrink: 0; }

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
    /* Multi-action row on inactive plan cards: Rename / Activate / Delete.
       Stacks vertically on narrow viewports to keep the row card
       legible. */
    .plan-row-actions {
      display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
      justify-content: flex-end;
    }
    .train-btn-link--danger { color: var(--guava-700); }
    .train-btn-link--danger:hover { color: var(--guava-800); }
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
    /* Manage Plan modal: wider canvas for the day-by-day editor. */
    .train-modal.manage-plan-modal { max-width: 640px; }
    .manage-plan-body { max-height: 70vh; overflow-y: auto; padding-right: 4px; }
    .manage-day-list { display: flex; flex-direction: column; gap: 10px; }
    .manage-day-card {
      background: var(--surface-2); border: 1px solid var(--edge);
      border-radius: var(--r-md); padding: 10px 12px;
    }
    .manage-day-head {
      display: grid; grid-template-columns: 42px 1fr auto; gap: 8px;
      align-items: center; margin-bottom: 8px;
    }
    .manage-day-dow {
      font-size: 11px; font-weight: 700; letter-spacing: .06em;
      color: var(--ink-3); text-transform: uppercase; text-align: center;
    }
    .manage-day-name { font-size: 13px; padding: 6px 10px; min-width: 0; }
    .manage-type-row { display: inline-flex; gap: 3px; }
    .manage-type-pill {
      background: var(--surface); border: 1px solid var(--edge);
      border-radius: var(--r-sm); padding: 4px 10px; cursor: pointer;
      font-family: inherit; font-size: 11px; font-weight: 700;
      color: var(--ink-3); letter-spacing: .04em; text-transform: uppercase;
    }
    .manage-type-pill.is-active {
      background: var(--guava-700); border-color: var(--guava-700); color: #fff;
    }
    .manage-ex-list { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; }
    .manage-ex-head {
      display: grid; grid-template-columns: 1fr 56px 64px 64px 22px; gap: 6px;
      font-size: 9px; font-weight: 700; letter-spacing: .06em;
      color: var(--ink-4); text-transform: uppercase;
      padding: 0 4px; align-items: end;
    }
    .manage-ex-row {
      display: grid; grid-template-columns: 1fr 56px 64px 64px 22px; gap: 6px;
      align-items: center;
    }
    .manage-ex-name { font-size: 12px; padding: 5px 8px; min-width: 0; }
    .manage-ex-num  { font-size: 12px; padding: 5px 6px; text-align: center; min-width: 0; }
    .manage-ex-remove {
      background: none; border: 0; cursor: pointer;
      color: var(--ink-4); font-size: 16px; line-height: 1;
      padding: 0; width: 22px; height: 22px;
    }
    .manage-ex-remove:hover { color: var(--guava-700); }
    .manage-ex-empty {
      font-size: 11px; color: var(--ink-4); font-style: italic;
      padding: 6px 4px;
    }
    .manage-add-ex {
      align-self: flex-start; margin-top: 4px;
      font-size: 11px;
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
    .logged-session-card.is-clickable { cursor: pointer; transition: background 0.12s ease, border-color 0.12s ease; }
    .logged-session-card.is-clickable:hover { background: var(--surface-2); border-color: var(--edge-strong); }
    /* Day-picker wrap (Workout pill, pick subview): the day grid grows
       horizontally; below it sits the Manage plans link in the bottom-right
       corner. Replaces what used to be the standalone "Plan" pill. */
    .train-day-picker-wrap { display: flex; flex-direction: column; gap: 4px; padding: 4px 0 6px; }
    .train-day-picker-actions { display: flex; justify-content: flex-end; padding: 2px 4px 0; }
    /* Plan-management sub-view header (shown when Manage Plans is open). */
    .train-subview-head {
      display: flex; align-items: center; gap: 12px; padding: 0 2px 8px;
      flex-wrap: wrap;
    }
    .train-subview-title {
      font-size: 11px; font-weight: 700; letter-spacing: .08em;
      color: var(--ink-3); text-transform: uppercase;
    }
    /* ── History tab list + cards ────────────────────────────────── */
    .history-list { display: flex; flex-direction: column; gap: 8px; }
    .history-card {
      background: var(--surface); border: 1px solid var(--edge);
      border-radius: var(--r-md); padding: 12px 14px;
      box-shadow: var(--shadow-card); cursor: pointer;
      transition: background 0.12s ease, border-color 0.12s ease;
    }
    .history-card:hover { background: var(--surface-2); border-color: var(--edge-strong); }
    .history-card-head {
      display: flex; align-items: center; justify-content: space-between;
      gap: 10px; margin-bottom: 4px;
    }
    .history-card-date {
      font-size: 11px; font-weight: 700; letter-spacing: .04em;
      color: var(--ink-3); text-transform: uppercase;
    }
    .history-card-head .day-detail-badge { margin-bottom: 0; }
    .history-card-name {
      font-size: 14px; font-weight: 700; color: var(--ink);
      display: inline-flex; align-items: center; gap: 8px;
    }
    .history-card-feel { font-size: 16px; }
    .history-card-summary { font-size: 12px; color: var(--ink-3); margin-top: 2px; }
    /* ── History recap modal ──────────────────────────────────────── */
    .history-recap-modal { max-width: 560px; }
    .history-recap-body { max-height: 70vh; overflow-y: auto; padding-right: 4px; }
    .history-recap-date { font-size: 12px; font-weight: 500; color: var(--ink-3); }
    .history-recap-stat-grid {
      display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px;
      margin: 10px 0;
    }
    .history-recap-stat {
      /* Canonical box pattern — same rule as .train-ai-block (see note
         on that rule). Never --surface-2 as a container background. */
      background: var(--surface); border: 1px solid var(--edge);
      border-radius: var(--r-sm); box-shadow: var(--shadow-card);
      padding: 10px 8px; text-align: center;
    }
    .history-recap-stat-num {
      font-size: 18px; font-weight: 700; color: var(--ink);
      font-variant-numeric: tabular-nums; letter-spacing: -0.01em;
    }
    .history-recap-stat-label {
      font-size: 10px; font-weight: 700; letter-spacing: .06em;
      color: var(--ink-4); text-transform: uppercase; margin-top: 3px;
    }
    .history-recap-ex-list { display: flex; flex-direction: column; gap: 8px; margin-top: 6px; }
    .history-recap-ex {
      background: var(--surface); border: 1px solid var(--edge);
      border-radius: var(--r-md); padding: 10px 12px;
    }
    .history-recap-ex-name {
      font-size: 13px; font-weight: 700; color: var(--ink); margin-bottom: 4px;
    }
    .history-recap-set-row {
      display: grid; grid-template-columns: 28px auto 16px auto;
      align-items: baseline; gap: 6px;
      font-size: 12px; color: var(--ink-2); font-variant-numeric: tabular-nums;
      padding: 2px 0;
    }
    .history-recap-set-num { font-size: 10px; font-weight: 700; color: var(--ink-4); letter-spacing: .05em; }
    .history-recap-set-x   { color: var(--ink-4); text-align: center; }
    .history-recap-row {
      display: flex; gap: 10px; align-items: baseline;
      padding: 10px 0; border-top: 1px dashed var(--edge);
      font-size: 13px; color: var(--ink-2);
    }
    .history-recap-row-label {
      font-size: 10px; font-weight: 700; letter-spacing: .06em;
      color: var(--ink-4); text-transform: uppercase;
      min-width: 86px; flex-shrink: 0;
    }
    .history-recap-notes {
      padding-top: 10px; margin-top: 10px; border-top: 1px dashed var(--edge);
      font-size: 13px; color: var(--ink-2); line-height: 1.55;
    }
    .history-recap-notes .history-recap-row-label { display: block; margin-bottom: 4px; }
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

    /* Session footer — same card chrome as the rest of the train shell
       (surface bg, edge border, shadow) so it doesn't read as a darker
       "modal" sub-region. */
    .train-session-footer {
      background: var(--surface); border: 1px solid var(--edge);
      border-radius: var(--r-md); padding: 14px; margin-top: 6px;
      box-shadow: var(--shadow-card);
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

    /* ── Progress photo picker + thumbnails ──────────────────────── */
    .progress-photo-grid {
      display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px;
    }
    .progress-photo-slot {
      position: relative; display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      aspect-ratio: 3/4; min-height: 100px;
      background: var(--surface-2); border: 1px dashed var(--edge-strong);
      border-radius: var(--r-md); cursor: pointer; overflow: hidden;
      color: var(--ink-3); font-size: 12px; transition: background 0.15s ease;
    }
    .progress-photo-slot:hover { background: var(--surface); }
    .progress-photo-slot.is-empty .progress-photo-plus {
      font-size: 28px; line-height: 1; color: var(--ink-4); margin-bottom: 4px;
    }
    /* Required/optional pill on empty photo slots. Required gets a
       guava chip so the two mandatory slots read at a glance. */
    .progress-photo-slot.is-empty .progress-photo-req {
      font-size: 9px; font-weight: 700; letter-spacing: .06em;
      text-transform: uppercase; color: var(--ink-4);
      background: var(--surface); border: 1px solid var(--edge);
      padding: 2px 6px; border-radius: 999px; margin-top: 4px;
    }
    .progress-photo-slot.is-required.is-empty {
      border-color: var(--guava-700);
    }
    .progress-photo-slot.is-required.is-empty .progress-photo-req {
      background: var(--guava-50); color: var(--guava-700); border-color: var(--guava-50);
    }
    /* Collapsible section toggle (measurements). Button-style row with
       a chevron that rotates when open. Body sits under it when expanded. */
    .train-collapse-toggle {
      display: flex; align-items: center; gap: 8px; width: 100%;
      background: none; border: 0; padding: 6px 0; cursor: pointer;
      font-family: inherit; text-align: left;
    }
    .train-collapse-chevron {
      display: inline-block; transition: transform 0.15s ease;
      color: var(--ink-3); font-size: 12px;
    }
    .train-collapse-chevron.is-open { transform: rotate(90deg); }
    .train-collapse-label {
      font-size: 11px; font-weight: 700; letter-spacing: .08em;
      color: var(--ink-3); text-transform: uppercase;
    }
    .train-collapse-badge {
      font-size: 10px; font-weight: 700; color: var(--guava-700);
      background: var(--guava-50); padding: 2px 8px; border-radius: 999px;
      margin-left: auto;
    }
    .train-collapse-body { margin-top: 10px; }
    .progress-photo-slot.is-picked,
    .progress-photo-slot.is-persisted { border-style: solid; padding: 0; }
    .progress-photo-slot img {
      width: 100%; height: 100%; object-fit: cover;
      display: block;
    }
    .progress-photo-slot .progress-photo-label {
      position: absolute; bottom: 4px; left: 6px;
      font-size: 10px; font-weight: 700; letter-spacing: .05em;
      text-transform: uppercase; color: #fff;
      background: rgba(20,15,10,0.55); padding: 2px 6px; border-radius: 4px;
    }
    .progress-photo-slot.is-empty .progress-photo-label {
      position: static; background: none; color: var(--ink-3);
      font-weight: 600;
    }
    .progress-photo-slot .progress-photo-remove {
      position: absolute; top: 4px; right: 4px;
      width: 22px; height: 22px; border-radius: 50%;
      background: rgba(20,15,10,0.65); color: #fff; border: 0;
      font-size: 14px; cursor: pointer; line-height: 1;
      display: flex; align-items: center; justify-content: center;
    }
    .progress-photo-slot .progress-photo-replace {
      position: absolute; top: 4px; right: 4px;
      font-size: 10px; font-weight: 700; letter-spacing: .04em;
      background: rgba(20,15,10,0.55); color: #fff;
      padding: 2px 6px; border-radius: 4px; text-transform: uppercase;
    }
    .progress-photo-loading {
      font-size: 11px; color: var(--ink-4);
    }
    .progress-photo-strip {
      display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px;
      margin-top: 12px;
    }
    .progress-photo-thumb {
      width: 100%; aspect-ratio: 3/4; object-fit: cover;
      border-radius: var(--r-sm); background: var(--surface-2);
    }
    .progress-photo-thumb.is-loading { background: var(--edge); }

    /* AI photo-analysis rows */
    .progress-ai-row {
      display: flex; gap: 8px; align-items: baseline;
      padding: 4px 0; font-size: 13px; color: var(--ink-2);
      line-height: 1.4;
    }
    .progress-ai-row + .progress-ai-row { border-top: 1px dashed var(--edge); }
    .progress-ai-row-label {
      font-size: 10px; font-weight: 700; letter-spacing: .06em;
      color: var(--ink-4); text-transform: uppercase;
      min-width: 78px; flex-shrink: 0;
    }

    /* ── Latest-entry eyebrow + thin 4-cell metrics strip ────────── */
    .progress-latest-eyebrow {
      display: flex; align-items: center; justify-content: space-between;
      gap: 10px; padding: 0 2px; margin-bottom: 8px;
    }
    /* Always 4-wide. On narrow viewports cells shrink rather than wrap to
       a 2x2 grid — keeps the four metrics at-a-glance scannable. */
    .metrics-strip {
      display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px;
      margin-bottom: 10px;
    }
    .metric-cell {
      background: var(--surface); border: 1px solid var(--edge);
      border-radius: var(--r-md); padding: 10px;
      box-shadow: var(--shadow-card);
      display: flex; flex-direction: column; gap: 4px;
      min-width: 0;     /* let cells shrink below content's intrinsic width */
    }
    /* Top-aligned delta pill — small, color-coded by direction. Hidden
       when only one entry exists (no comparison possible). */
    .metric-cell-delta {
      align-self: flex-start;
      font-size: 9px; font-weight: 700; letter-spacing: .02em;
      font-variant-numeric: tabular-nums;
      padding: 2px 7px; border-radius: 999px; line-height: 1.3;
      white-space: nowrap;
    }
    .metric-cell-delta.up      { background: var(--moss-bg, #eaf0e3); color: var(--moss-fg, #5e8c4f); }
    .metric-cell-delta.down    { background: var(--guava-50);          color: var(--guava-700); }
    .metric-cell-delta.neutral { background: var(--surface-2);          color: var(--ink-3); }
    .metric-cell-num {
      font-size: 20px; font-weight: 700; color: var(--ink);
      letter-spacing: -0.02em; font-variant-numeric: tabular-nums;
      line-height: 1.1; white-space: nowrap;
    }
    .metric-cell-unit {
      font-size: 11px; font-weight: 600; color: var(--ink-3);
      margin-left: 2px;
    }
    .metric-cell-label {
      font-size: 10px; font-weight: 700; letter-spacing: .04em;
      color: var(--ink-4); text-transform: uppercase; white-space: nowrap;
    }
    /* Sparkline: bigger now (28px) so the time-series story reads. When
       <2 data points exist, render a flat "need more entries" placeholder
       instead of leaving the slot blank. */
    .metric-spark { display: block; width: 100%; height: 28px; margin-top: auto; }
    .metric-spark-empty {
      display: block; width: 100%; height: 28px; margin-top: auto;
      border-top: 1px dashed var(--edge); position: relative;
    }
    .metric-spark-empty::after {
      content: 'log more entries';
      position: absolute; inset: 50% 0 0 0; transform: translateY(-50%);
      text-align: center; font-size: 9px; color: var(--ink-4);
      letter-spacing: .04em; text-transform: uppercase; font-weight: 600;
    }
    /* (Removed the 480px → 2x2 fallback per usage feedback — the four
       cards must always stay side-by-side. Cells shrink instead.) */

    /* ── Coach Card (Body Comp Report v2 — Variation A) ──────────────
       Now that .train-ai-block uses the canonical card pattern by
       default (white surface, solid edge, shadow), the coach-card
       override only differs in padding. Kept here so the Progress
       report's coach card retains its slightly roomier feel; surface/
       border/shadow inherit from the base rule. */
    .train-ai-block.coach-card { padding: 18px 20px; }
    .coach-headline {
      font-size: 19px; font-weight: 700; color: var(--ink);
      letter-spacing: -0.02em; line-height: 1.3;
      margin: 4px 0 10px 0;
    }
    .coach-traits {
      display: flex; flex-wrap: wrap; gap: 4px;
      margin-bottom: 10px;
    }
    .train-pill {
      display: inline-block; font-size: 10px; font-weight: 700;
      letter-spacing: .05em; padding: 2px 8px; border-radius: 999px;
      background: var(--surface-2); color: var(--ink-3); text-transform: uppercase;
    }
    .coach-overview {
      font-size: 14px; line-height: 1.55; color: var(--ink-2);
      margin-bottom: 14px;
    }
    .coach-focus-block { display: flex; flex-direction: column; gap: 10px; }
    .coach-focus-row {
      display: grid; grid-template-columns: 26px 1fr; gap: 12px;
      align-items: start; padding: 12px;
      background: var(--surface); border: 1px solid var(--edge);
      border-radius: var(--r-md);
    }
    .coach-focus-num {
      width: 22px; height: 22px; border-radius: 50%;
      background: var(--guava-700); color: #fff;
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 11px; font-weight: 700; flex-shrink: 0;
    }
    .coach-focus-title { font-size: 13px; font-weight: 700; color: var(--ink); margin-bottom: 3px; }
    .coach-focus-why { font-size: 12px; color: var(--ink-3); margin-bottom: 6px; line-height: 1.5; }
    .coach-focus-ex { display: flex; flex-wrap: wrap; gap: 4px; }
    .coach-ex-pill {
      background: var(--surface-2); border: 1px solid var(--edge);
      border-radius: 999px; padding: 2px 8px;
      font-size: 11px; color: var(--ink-2);
    }
    .coach-focus-hint {
      font-size: 10px; font-weight: 700; letter-spacing: .05em;
      color: var(--guava-700); margin-top: 6px; text-transform: uppercase;
    }
    .coach-secondary {
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px dashed var(--edge);
      display: flex; flex-direction: column; gap: 6px;
    }
    .coach-secondary-row {
      display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;
      font-size: 12px;
    }
    .coach-secondary-label {
      font-size: 10px; font-weight: 700; letter-spacing: .06em;
      color: var(--ink-4); text-transform: uppercase;
      min-width: 78px; flex-shrink: 0;
    }
    .coach-chip-group { display: inline-flex; flex-wrap: wrap; gap: 4px; }
    .coach-secondary-chip {
      background: var(--surface-2); padding: 2px 8px; border-radius: 999px;
      font-size: 11px; color: var(--ink-2);
    }
    /* Big photo block INSIDE the coach card (Variation A spec). 2-up or
       3-up depending on slots filled. Bigger than the Latest Entry
       thumbnails — these are the "look at the read" surface. */
    .coach-photos {
      display: grid; gap: 8px;
      margin-top: 14px;
    }
    .coach-photo {
      position: relative;
      aspect-ratio: 3/4; border-radius: var(--r-md); overflow: hidden;
      background: var(--surface-2);
    }
    .coach-photo img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .coach-photo--loading {
      background: linear-gradient(135deg, var(--edge) 0%, var(--surface-2) 100%);
    }
    .coach-photo-label {
      position: absolute; bottom: 6px; left: 8px;
      font-size: 10px; font-weight: 700; letter-spacing: .05em;
      color: #fff; background: rgba(20,15,10,0.55);
      padding: 2px 8px; border-radius: 999px; text-transform: uppercase;
    }
    /* Legacy-data banner — surfaces when stored ai_analysis predates the
       rich focus_areas schema. CTA upgrades on click. */
    .coach-upgrade-banner {
      margin-top: 10px; display: flex; align-items: center;
      justify-content: space-between; gap: 10px; flex-wrap: wrap;
      padding: 10px 12px; border-radius: var(--r-md);
      background: var(--surface-2); border: 1px dashed var(--edge-strong);
    }
    .coach-upgrade-msg {
      font-size: 12px; color: var(--ink-3); line-height: 1.5; flex: 1;
      min-width: 200px;
    }
    .coach-focus-row--legacy {
      background: var(--surface-2);   /* dim, signals "less data than usual" */
      border-color: transparent;
    }
    .coach-callout {
      margin-top: 12px; display: flex; gap: 10px; align-items: start;
      background: var(--moss-bg, #eaf0e3); border-radius: var(--r-md);
      padding: 10px 12px; font-size: 12px;
      color: var(--moss-fg, #5e8c4f); line-height: 1.5;
    }
    .coach-callout-icon { font-size: 14px; line-height: 1; flex-shrink: 0; }
    .coach-limitation {
      margin-top: 8px; font-size: 11px; color: var(--ink-4);
      font-style: italic;
    }

    /* ── Combined Goal Card (weight + body fat in one block) ────────
       Promoted above the Coach Card in the dashboard order, so the
       chrome upgrades to a featured-card look: subtle guava tint, a
       prominent header label, and a wider top accent bar so the card
       reads as the user's North Star at a glance. */
    .goal-combined-card {
      background: linear-gradient(180deg, var(--guava-50) 0%, var(--surface) 60%);
      border: 1px solid var(--guava-700);
      border-radius: var(--r-md); padding: 16px 18px;
      box-shadow: var(--shadow-card); margin-bottom: 12px;
      position: relative;
    }
    .goal-combined-card .progress-card-label {
      font-size: 12px; color: var(--guava-700);
    }
    .goal-combined-card .progress-card-meta { color: var(--ink-3); }
    .goal-section { padding: 12px 0; }
    .goal-section + .goal-section { border-top: 1px solid var(--edge); }
    .goal-section-head {
      display: flex; align-items: flex-start; justify-content: space-between;
      gap: 10px; margin-bottom: 10px; flex-wrap: wrap;
    }
    .goal-section-eyebrow {
      font-size: 10px; font-weight: 700; letter-spacing: .08em;
      color: var(--guava-700); text-transform: uppercase; margin-bottom: 4px;
    }
    .goal-section.is-empty .goal-section-eyebrow { color: var(--ink-3); }
    .goal-section-title {
      font-size: 14px; font-weight: 700; color: var(--ink);
      letter-spacing: -0.01em; line-height: 1.3;
    }
    .goal-section-title--empty { color: var(--ink-3); font-weight: 600; }
    .goal-big-bar {
      background: var(--surface-2); border-radius: 999px; height: 12px;
      overflow: hidden; position: relative; margin-bottom: 6px;
    }
    .goal-big-bar-fill {
      background: var(--guava-700); height: 100%; border-radius: 999px;
      transition: width 0.3s ease;
    }
    .goal-big-stats {
      display: flex; justify-content: space-between; gap: 8px;
      font-size: 11px; color: var(--ink-3); font-variant-numeric: tabular-nums;
      flex-wrap: wrap;
    }
    .goal-big-stats strong { color: var(--ink); font-weight: 700; }
    .goal-big-eta {
      font-size: 12px; color: var(--ink-2); margin-top: 8px;
      line-height: 1.5;
    }
    .goal-big-eta strong { color: var(--guava-700); }

    /* ── AI feedback overlay (Today subtab) ─────────────────────────
       Canonical card pattern — used here, on the Progress tab Coach
       Card, and the History Recap stat tiles below. THE RULE for any
       new box/container in the app: white surface, solid edge border,
       --shadow-card. Never --surface-2 as a card background (that
       token is reserved for inline accents — pill bg, hover state,
       progress-bar track, etc). Keeping a single class on this rule
       so updating once propagates to every container that uses it. */
    .train-ai-block {
      background: var(--surface); border: 1px solid var(--edge);
      border-radius: var(--r-md); padding: 12px 14px; margin-top: 14px;
      box-shadow: var(--shadow-card);
    }
    .train-ai-block.is-error { background: var(--surface); border-style: solid; }
    .train-ai-head {
      display: flex; align-items: center; justify-content: space-between;
      gap: 10px; margin-bottom: 8px;
    }
    .train-ai-label {
      font-size: 11px; font-weight: 700; letter-spacing: .08em;
      color: var(--ink-3); text-transform: uppercase;
    }
    .train-ai-tag {
      font-size: 10px; font-weight: 700; letter-spacing: .04em;
      padding: 2px 8px; border-radius: 999px;
      background: var(--surface); color: var(--ink-4); text-transform: uppercase;
    }
    .train-ai-tag.is-ai { background: var(--guava-50); color: var(--guava-700); }
    .train-ai-insight {
      font-size: 14px; color: var(--ink); line-height: 1.5;
      margin-bottom: 6px;
    }
    .train-ai-observations {
      margin: 6px 0 0; padding-left: 18px;
      font-size: 13px; color: var(--ink-2); line-height: 1.55;
    }
    .train-ai-observations li { margin-bottom: 2px; }
    .train-ai-msg { font-size: 12px; color: var(--ink-4); }
    .train-ai-skel {
      height: 12px; border-radius: 6px; background: var(--edge);
      animation: trainAiPulse 1.4s ease-in-out infinite;
      margin-bottom: 6px;
    }
    @keyframes trainAiPulse {
      0%, 100% { opacity: 0.55; }
      50%      { opacity: 0.85; }
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

/* U.S. Navy body-fat formula was retired; body fat now comes from the
   AI vision pass only. Git history has the prior implementation. */

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
  window.trainAgeYears = trainAgeYears;
  window.trainSuggestActivityLevel = trainSuggestActivityLevel;
  window.trainProgressPct = trainProgressPct;
}

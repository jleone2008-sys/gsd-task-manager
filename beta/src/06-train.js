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

/* ── Today / Progress stubs (filled in by commits 3 and 5) ──────────── */

function renderTrainToday(root) {
  root.innerHTML = `
    <div class="train-shell">
      <div class="train-empty">
        <div class="train-empty-title">Today</div>
        <div class="train-empty-msg">Session logging lands in commit 3.</div>
      </div>
    </div>`;
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

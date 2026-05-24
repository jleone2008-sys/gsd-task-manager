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
  // Subtab pill-bar — clicking any pill switches the inner view without
  // changing activeTool (which stays 'train').
  document.addEventListener('click', e => {
    const pill = e.target.closest('.train-sub-pills .train-pill');
    if (!pill) return;
    trainSwitchView(pill.dataset.trainView);
  });
}

/* ── Subtab render stubs ─────────────────────────────────────────────────
   Each of these is a placeholder; the real renderer lands in the
   subsequent Phase 4 commits. The skeleton just renders an empty card
   with the subtab name so the tab is visible end-to-end and the wiring
   is testable now.
─────────────────────────────────────────────────────────────────────────── */

function renderTrainPlan(root) {
  root.innerHTML = `
    <div class="train-shell">
      <div class="train-empty">
        <div class="train-empty-title">Plan</div>
        <div class="train-empty-msg">Workout plan builder lands in the next commit.</div>
      </div>
    </div>`;
}

function renderTrainToday(root) {
  root.innerHTML = `
    <div class="train-shell">
      <div class="train-empty">
        <div class="train-empty-title">Today</div>
        <div class="train-empty-msg">Session logging lands in the next commit.</div>
      </div>
    </div>`;
}

function renderTrainProgress(root) {
  root.innerHTML = `
    <div class="train-shell">
      <div class="train-empty">
        <div class="train-empty-title">Progress</div>
        <div class="train-empty-msg">Body composition dashboard lands in the next commit.</div>
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

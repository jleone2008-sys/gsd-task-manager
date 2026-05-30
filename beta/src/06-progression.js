/* ════════════════════════════════════════════════════════════════════════
   WEIGHT PROGRESSION ENGINE — deterministic, no AI.

   Mirrors the app's "deterministic core" philosophy (cf. lib/recommendations
   + the brief claim set): every weight suggestion traces to logged sets + the
   prescribed rep range + a real equipment ladder. The monthly AI tuner owns
   *exercise selection*; this owns *how much weight*.

   computeNextTarget(ex, history, today) → { weight, target_text, target_kind, reason }
   is a pure function. Loaded as a classic script (top-level consts are shared
   across the app's scripts); also module.exports for node unit tests.
═══════════════════════════════════════════════════════════════════════════ */

// ── Equipment ladders (US gym, NO micro plates/dumbbells per config) ────────
// Everything snaps to a 5 lb grid (dumbbells +5/hand, barbells +5, cables via
// +10 step but still snap to 5 so existing weights are preserved).
const PROG_BASE_STEP = {
  barbell_lower: 10, barbell_upper: 5,
  smith_lower:   10, smith_upper:   5,
  dumbbell:       5,            // per hand, next rung
  cable:         10,
  bodyweight_load: 5,           // added load once bodyweight reps are maxed
};

// Autoregulation thresholds (confirmed): readiness <60 = low, >80 = high.
const PROG_READINESS_LOW = 60;
const PROG_READINESS_HIGH = 80;

function progSnap(weight) {
  // Snap to the nearest 5 lb (no micro). Never below 0.
  return Math.max(0, Math.round(Number(weight) / 5) * 5);
}

function progInferEquipment(ex) {
  if (ex && ex.equipment) return ex.equipment;
  if (ex && ex.bodyweight) return 'bodyweight';
  const n = String(ex && ex.name || '').toLowerCase();
  if (/smith/.test(n)) return 'smith';
  if (/\bdb\b|dumbbell/.test(n)) return 'dumbbell';
  if (/cable|pushdown|press[- ]?down|face pull|pulldown|rope|machine|pec deck|lat pull/.test(n)) return 'cable';
  return 'barbell';
}

function progIsLower(ex) {
  const s = `${ex && ex.name || ''} ${ex && ex.muscle_group || ''}`.toLowerCase();
  return /squat|deadlift|\brdl\b|romanian|leg|lunge|hip thrust|glute|calf|hamstring|quad|split squat|lower/.test(s);
}

// Smallest real jump for this exercise's equipment.
function progBaseStep(ex, equipment) {
  const lower = progIsLower(ex);
  switch (equipment) {
    case 'barbell': return lower ? PROG_BASE_STEP.barbell_lower : PROG_BASE_STEP.barbell_upper;
    case 'smith':   return lower ? PROG_BASE_STEP.smith_lower   : PROG_BASE_STEP.smith_upper;
    case 'dumbbell':return PROG_BASE_STEP.dumbbell;
    case 'cable':   return PROG_BASE_STEP.cable;
    case 'bodyweight': return PROG_BASE_STEP.bodyweight_load;
    default:        return 5;
  }
}

// Parse a prescribed rep string into {min,max}. "6-8"→{6,8}, "8"→{8,8},
// "15-20"→{15,20}. Non-numeric ("AMRAP", "30s") → null (skip progression).
function progParseReps(reps) {
  const s = String(reps == null ? '' : reps).trim();
  let m = s.match(/^(\d+)\s*[-–]\s*(\d+)$/);
  if (m) return { min: +m[1], max: +m[2] };
  m = s.match(/^(\d+)$/);
  if (m) return { min: +m[1], max: +m[1] };
  return null;
}

// The working weight = the top weight used across the session's sets (a final
// drop-set at lighter load shouldn't be read as the working weight). Returns
// { weight, repsAtWeight:[...], bodyweight }.
function progWorkingSets(lastSets) {
  const sets = (lastSets || []).filter(s => s && s.actual_reps != null);
  if (!sets.length) return null;
  const bw = sets.every(s => s.is_bodyweight);
  const weights = sets.map(s => Number(s.actual_weight) || 0);
  const workingWeight = Math.max(...weights);
  const repsAtWeight = sets.filter(s => (Number(s.actual_weight) || 0) === workingWeight).map(s => Number(s.actual_reps));
  return { weight: workingWeight, repsAtWeight, bodyweight: bw };
}

// Did this exercise miss the bottom of its range in the session's working sets?
function progMissedBottom(lastSets, range) {
  const w = progWorkingSets(lastSets);
  if (!w || !range) return false;
  return w.repsAtWeight.some(r => r < range.min);
}

// ── The engine ──────────────────────────────────────────────────────────────
function computeNextTarget(ex, history, today) {
  history = history || {};
  today = today || {};
  const manualOverride = ex && (ex.target_kind === 'warning' || ex.auto_progress === false);
  const range = progParseReps(ex && ex.reps);
  const equipment = progInferEquipment(ex);
  const baseStep = progBaseStep(ex, equipment);

  // Respect manual / warning exercises — never auto-progress.
  if (manualOverride) {
    return { weight: null, target_text: ex.target_text || 'Manual', target_kind: 'warning', reason: 'manual_override' };
  }
  // Time-based / AMRAP / no parseable range → can't double-progress.
  if (!range) {
    return { weight: null, target_text: ex && ex.target_text || '', target_kind: 'hold', reason: 'no_rep_range' };
  }

  const work = progWorkingSets(history.lastSets);

  // Calibration — first time on this exercise (new exercise, tuner swap, or
  // brand-new user). Don't guess a number; ask them to find a working weight.
  if (!work || (history.sessionCount || 0) === 0) {
    const repsLabel = range.min === range.max ? `${range.min} reps` : `${range.min}-${range.max} reps`;
    return { weight: null, target_text: `Find a working weight · ${repsLabel}`, target_kind: 'calibrate', reason: 'calibration' };
  }

  const W = work.weight;
  const reps = work.repsAtWeight;
  const allHitMin = reps.every(r => r >= range.min);
  const allHitTop = reps.every(r => r >= range.max);
  const exceeded  = reps.every(r => r >= range.max + 2);
  const missedBottom = reps.some(r => r < range.min);

  const novice = (history.userSessionCount || 0) < 12;

  // ── Base decision: -1 deload | 0 hold/repeat | +1 add rung | +2 crushed ──
  let tier; // 'deload' | 'hold' | 'up1' | 'up2'
  if (exceeded) {
    tier = 'up2';
  } else if (allHitTop) {
    tier = 'up1';
  } else if (novice && allHitMin) {
    tier = 'up1';                       // novice linear progression: climb on any in-range session
  } else if (missedBottom) {
    // Stall detection: did the prior session also miss the bottom at ~this weight?
    const prior = (history.priorSessions || [])[0];
    const priorMissed = prior ? progMissedBottom(prior, range) : false;
    tier = priorMissed ? 'deload' : 'hold';
  } else {
    tier = 'hold';                      // in range, not top → add a rep
  }

  // ── Autoregulation (bounded ±1 tier). RIR (if logged) is the primary effort
  //    gate; else last-session feel. Today's readiness gates pushing today. ──
  const rir = history.lastRir;
  const feel = history.lastFeel;
  const ready = today.readiness;
  const hrvLow = !!today.hrvLow;
  const wentToFailure = (rir != null && rir <= 0) || feel === 'rough' || feel === 'hard';
  const feltEasy       = (rir != null && rir >= 3) || feel === 'great' || feel === 'easy';
  const readyLow  = (ready != null && ready < PROG_READINESS_LOW) || hrvLow;
  const readyHigh = (ready != null && ready > PROG_READINESS_HIGH);

  let autoNote = '';
  if (tier === 'up1' || tier === 'up2') {
    if (readyLow)        { tier = 'hold'; autoNote = 'recovery low today'; }
    else if (wentToFailure) { tier = 'hold'; autoNote = 'last set was a grind'; }
    else if (tier === 'up1' && feltEasy && readyHigh) { tier = 'up2'; autoNote = 'fresh + had it in the tank'; }
  }

  // ── Build the suggestion, snapped to a real rung ──
  const step = baseStep;
  const mk = (weight, text, kind, reason) => ({ weight, target_text: text, target_kind: kind, reason: reason + (autoNote ? ` (${autoNote})` : '') });

  // Bodyweight: progress reps first, then add load.
  if (equipment === 'bodyweight' && work.bodyweight && W === 0) {
    if (tier === 'up1' || tier === 'up2') return mk(0, `↑ Add weight · keep ${range.max} reps`, 'up', 'bw_add_load');
    if (tier === 'deload') return mk(0, `Hold bodyweight · ${range.min}+ reps`, 'hold', 'bw_hold');
    return mk(0, `Add a rep · aim ${range.max}`, 'hold', 'bw_add_rep');
  }

  if (tier === 'up2') { const w = progSnap(W + 2 * step); return mk(w, `↑ ${w} — crushed it`, 'up', 'crushed'); }
  if (tier === 'up1') { const w = progSnap(W + step);     return mk(w, `↑ ${w}`, 'up', 'progress'); }
  if (tier === 'deload') { const w = progSnap(W * 0.9);   return mk(w, `↓ ${w} — reset & rebuild`, 'warning', 'deload'); }
  // hold
  if (autoNote === 'recovery low today') return mk(W, `Hold ${W} today`, 'hold', 'autoreg_hold');
  return mk(W, `${W} — aim ${range.max} across`, 'hold', 'add_rep');
}

// Expose globally for the app's classic-script render path; export for node tests.
if (typeof window !== 'undefined') {
  window.computeNextTarget = computeNextTarget;
  window.progInferEquipment = progInferEquipment;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { computeNextTarget, progSnap, progInferEquipment, progParseReps, progWorkingSets, progBaseStep, progIsLower };
}

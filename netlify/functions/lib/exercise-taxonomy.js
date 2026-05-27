// Shared exercise taxonomy used by:
//   - beta-train-tune-background.js (validates Claude can't propose
//     swapping/removing a compound primary)
//   - adherence-rules.js (push_workout rule needs to know which sets
//     count toward "heavy enough")
//   - future Train AI work that needs muscle-group inference
//
// COMPOUND_PRIMARIES is a curated set of the lifts most programs build
// strength curves around. The match is case-insensitive substring — if an
// exercise's name *contains* any of these phrases, it's considered a
// primary and the tuner cannot touch it. This is intentionally loose:
// "Incline bench press" and "Close-grip bench" both match "bench press"
// and "bench" respectively (the longer phrase wins, but either way they
// land in the locked set).
//
// MUSCLE_GROUP_LOOKUP is a longest-prefix dictionary used to bucket sets
// by muscle group for volume accounting. Phrases are listed longest-first
// at lookup time so multi-word names ("hip thrust") beat single-word
// prefixes ("hip"). Unknown exercises map to 'other' and are excluded
// from per-group volume rollups.

const COMPOUND_PRIMARIES = [
  // Push primaries
  'bench press',
  'incline bench',          // matches "Incline bench press" too
  'incline db press',
  'incline dumbbell press',
  'overhead press',
  'military press',
  'push press',
  'dips',
  // Pull primaries
  'deadlift',               // matches conventional, sumo, trap bar, RDL
  'romanian deadlift',      // also matched by 'deadlift' but listed for clarity
  'pendlay row',
  'barbell row',
  'pull-up',                // and pull-ups
  'pullup',
  'chin-up',
  'chinup',
  'lat pulldown',
  // Leg primaries
  'back squat',
  'front squat',
  'high-bar squat',
  'low-bar squat',
  'safety bar squat',
];

// Returns true if the exercise name should be treated as a locked primary.
// Case-insensitive substring match against COMPOUND_PRIMARIES.
function isCompoundPrimary(exerciseName) {
  if (!exerciseName) return false;
  const n = String(exerciseName).toLowerCase();
  return COMPOUND_PRIMARIES.some(p => n.includes(p));
}

// Muscle-group inference. Each entry is [keyword, group]. The keyword is
// matched as a case-insensitive substring; we iterate longest-keyword-first
// so "lateral raise" beats "raise". Unknown → null (caller treats as 'other').
const GROUP_RULES = [
  // Multi-word phrases first (longest-prefix wins)
  ['romanian deadlift',    'hamstrings'],
  ['hip thrust',           'glutes'],
  ['bulgarian split squat','quads_glutes'],
  ['walking lunge',        'quads_glutes'],
  ['leg curl',             'hamstrings'],
  ['leg extension',        'quads'],
  ['leg press',            'quads'],
  ['standing calf',        'calves'],
  ['seated calf',          'calves'],
  ['calf raise',           'calves'],
  ['good morning',         'hamstrings'],
  ['glute-ham',            'hamstrings_glutes'],
  ['hyperextension',       'lower_back'],
  ['back extension',       'lower_back'],
  ['face pull',            'rear_delts_traps'],
  ['rear delt',            'rear_delts'],
  ['lateral raise',        'shoulders'],
  ['side raise',           'shoulders'],
  ['front raise',          'shoulders'],
  ['lat pulldown',         'back'],
  ['cable row',            'back'],
  ['barbell row',          'back'],
  ['pendlay row',          'back'],
  ['db row',               'back'],
  ['dumbbell row',         'back'],
  ['t-bar row',            'back'],
  ['chest fly',            'chest'],
  ['cable fly',            'chest'],
  ['incline bench',        'chest'],
  ['incline press',        'chest'],
  ['incline db',           'chest'],
  ['bench press',          'chest'],
  ['bench',                'chest'],
  ['overhead press',       'shoulders'],
  ['shoulder press',       'shoulders'],
  ['hammer curl',          'biceps'],
  ['barbell curl',         'biceps'],
  ['preacher curl',        'biceps'],
  ['db curl',              'biceps'],
  ['dumbbell curl',        'biceps'],
  ['cable curl',           'biceps'],
  ['tricep pushdown',      'triceps'],
  ['tricep extension',     'triceps'],
  ['overhead extension',   'triceps'],
  ['skull crusher',        'triceps'],
  ['close-grip bench',     'triceps'],
  ['back squat',           'quads'],
  ['front squat',          'quads'],
  ['hack squat',           'quads'],
  ['hanging leg raise',    'core'],
  ['ab wheel',             'core'],
  ['cable crunch',         'core'],
  ['weighted plank',       'core'],
  ['russian twist',        'core'],
  ['woodchopper',          'core'],
  ['pall-of press',        'core'],
  // Single-word fallbacks
  ['deadlift',             'posterior_chain'],
  ['squat',                'quads'],
  ['lunge',                'quads_glutes'],
  ['row',                  'back'],
  ['pulldown',             'back'],
  ['pull-up',              'back'],
  ['pullup',               'back'],
  ['chin-up',              'back'],
  ['chinup',               'back'],
  ['curl',                 'biceps'],
  ['tricep',               'triceps'],
  ['pushdown',             'triceps'],
  ['dip',                  'chest_triceps'],
  ['fly',                  'chest'],
  ['press',                'chest_shoulders'],
  ['plank',                'core'],
  ['crunch',               'core'],
  ['ab',                   'core'],
  ['glute',                'glutes'],
  ['raise',                'shoulders'],
];

// Sorted once at module load so longest-prefix-wins works without
// re-sorting on every call.
const SORTED_GROUP_RULES = GROUP_RULES.slice().sort((a, b) => b[0].length - a[0].length);

function inferMuscleGroup(exerciseName) {
  if (!exerciseName) return 'other';
  const n = String(exerciseName).toLowerCase();
  for (const [kw, group] of SORTED_GROUP_RULES) {
    if (n.includes(kw)) return group;
  }
  return 'other';
}

// Roll up an array of workout_sets rows into per-muscle-group weekly
// volume. Volume = working-set count for hypertrophy purposes (per
// Schoenfeld 2017 — the dose-response is best modeled per set, not per
// rep). Bodyweight sets count the same as weighted; the volume cap is
// "sets per week per muscle group", not tonnage.
//
// `sets` is expected to be an array of objects with at least
// `exercise_name`. Date filtering should happen upstream — this just
// buckets whatever you hand it.
function weeklyVolumeByGroup(sets) {
  const out = {};
  if (!Array.isArray(sets)) return out;
  for (const s of sets) {
    const group = inferMuscleGroup(s.exercise_name);
    if (group === 'other') continue;   // exclude unknown from rollup
    out[group] = (out[group] || 0) + 1;
  }
  return out;
}

// Helper: count total accessory exercises in a day_template (used by the
// tuner's policy check — "don't add an exercise to a day with 8+ already").
function countExercises(dayTemplate) {
  if (!Array.isArray(dayTemplate)) return 0;
  return dayTemplate.reduce((sum, d) => sum + (Array.isArray(d.exercises) ? d.exercises.length : 0), 0);
}

// Helper: total weekly working sets across the plan. Sum of all exercises'
// `sets` field. Used by the ±20% volume guardrail.
function totalWeeklySets(dayTemplate) {
  if (!Array.isArray(dayTemplate)) return 0;
  let total = 0;
  for (const day of dayTemplate) {
    if (!Array.isArray(day.exercises)) continue;
    for (const ex of day.exercises) {
      total += (Number(ex.sets) || 0);
    }
  }
  return total;
}

module.exports = {
  COMPOUND_PRIMARIES,
  isCompoundPrimary,
  inferMuscleGroup,
  weeklyVolumeByGroup,
  countExercises,
  totalWeeklySets,
};

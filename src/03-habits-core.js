/* ══════ HABITS DATA LAYER ══════ */
let habitsArr = [], habitCompletions = [];
const habitRowIdMap = new Map();
const completionRowIdMap = new Map();
let activeHabitView = 'today';
let editingHabitId = null;
let newHabitTags = new Set();
let editHabitTags = new Set();

function rowToHabit(r) {
  return {
    id: r.client_id,
    name: r.name || '',
    emoji: r.emoji || '✅',
    frequency: r.frequency || 'daily',
    frequencyCount: r.frequency_count || 0,
    customDays: r.custom_days || [],
    tags: r.tags || [],
    archived: r.archived || false,
    order: r.order || 0,
    allowExtras: r.allow_extras || false,
  };
}
function habitToRow(h) {
  return {
    user_id: currentUser.id,
    client_id: h.id,
    name: h.name,
    emoji: h.emoji,
    frequency: h.frequency,
    frequency_count: h.frequencyCount || 0,
    custom_days: h.customDays,
    tags: h.tags,
    archived: h.archived,
    "order": h.order,
    allow_extras: h.allowExtras || false,
    updated_at: new Date().toISOString(),
  };
}
function rowToCompletion(r) {
  return { id: r.id, habitId: r.habit_id, completedDate: r.completed_date };
}

async function saveHabitToDB(h, retries = 2) {
  setStatus('syncing');
  const row = habitToRow(h);
  let { data, error } = await db.from('habits')
    .upsert(row, { onConflict: 'user_id,client_id' })
    .select('id, client_id');
  // If allow_extras column doesn't exist, retry without it
  if (error && error.message && error.message.includes('allow_extras')) {
    delete row.allow_extras;
    ({ data, error } = await db.from('habits')
      .upsert(row, { onConflict: 'user_id,client_id' })
      .select('id, client_id'));
  }
  // Generic retry on transient errors
  if (error && retries > 0) {
    await new Promise(r => setTimeout(r, 1500));
    return saveHabitToDB(h, retries - 1);
  }
  setStatus(error ? 'error' : 'saved');
  if (error) { console.error('saveHabit:', error.message); return; }
  if (data?.[0]) habitRowIdMap.set(data[0].id, data[0].client_id);
}

async function saveAllHabitsToDB() {
  if (!currentUser) return;
  setStatus('syncing');
  // Upsert all habits
  const rows = habitsArr.map(h => habitToRow(h));
  if (rows.length) {
    const { data, error } = await db.from('habits').upsert(rows, { onConflict: 'user_id,client_id' }).select('id, client_id');
    if (error) { console.error('saveAllHabits:', error.message); setStatus('error'); return; }
    if (data) data.forEach(r => habitRowIdMap.set(r.id, r.client_id));
  }
  // Upsert all completions — need server habit IDs
  if (habitCompletions.length) {
    const compRows = habitCompletions.map(c => ({
      user_id: currentUser.id,
      habit_id: c.habitId,
      completed_date: c.completedDate
    }));
    const { error: cErr } = await db.from('habit_completions').upsert(compRows, { onConflict: 'user_id,habit_id,completed_date' });
    if (cErr) console.error('saveAllCompletions:', cErr.message);
  }
  setStatus('saved');
}

async function deleteHabitFromDB(id) {
  setStatus('syncing');
  const { error } = await db.from('habits').delete().eq('user_id', currentUser.id).eq('client_id', id);
  setStatus(error ? 'error' : 'saved');
  if (error) console.error('deleteHabit:', error.message);
}

async function toggleCompletion(habitClientId, dateStr) {
  // Find the habit's server-side id for the FK
  let habitSid = null;
  for (const [sid, cid] of habitRowIdMap) {
    if (cid === habitClientId) { habitSid = sid; break; }
  }
  if (!habitSid) { console.error('toggleCompletion: no server id for', habitClientId); return; }

  const habit = habitsArr.find(h => h.id === habitClientId);
  const existing = habitCompletions.find(c => c.habitId === habitSid && c.completedDate === dateStr);

  if (existing && !(habit && habit.allowExtras)) {
    // Normal toggle: remove completion
    habitCompletions = habitCompletions.filter(c => c !== existing);
    renderHabits();
    setStatus('syncing');
    const { error } = await db.from('habit_completions').delete().eq('id', existing.id);
    setStatus(error ? 'error' : 'saved');
    if (error) {
      console.error('deleteCompletion:', error.message);
      // Revert optimistic removal so UI matches server state
      if (!habitCompletions.includes(existing)) habitCompletions.push(existing);
      renderHabits();
    }
  } else {
    // Add completion (first time, or extras mode adds another)
    const temp = { id: -Date.now(), habitId: habitSid, completedDate: dateStr };
    habitCompletions.push(temp);
    renderHabits();
    setStatus('syncing');
    const { data, error } = await db.from('habit_completions')
      .insert({ user_id: currentUser.id, habit_id: habitSid, completed_date: dateStr })
      .select();
    setStatus(error ? 'error' : 'saved');
    if (error) { console.error('addCompletion:', error.message); habitCompletions = habitCompletions.filter(c => c !== temp); renderHabits(); return; }
    if (data?.[0]) {
      const idx = habitCompletions.indexOf(temp);
      if (idx >= 0) habitCompletions[idx] = rowToCompletion(data[0]);
      completionRowIdMap.set(data[0].id, data[0].id);
    }
  }
}

// Remove the most recent completion for a habit on a given date (for extras undo)
async function removeLastCompletion(habitClientId, dateStr) {
  let habitSid = null;
  for (const [sid, cid] of habitRowIdMap) {
    if (cid === habitClientId) { habitSid = sid; break; }
  }
  if (!habitSid) return;
  const matches = habitCompletions.filter(c => c.habitId === habitSid && c.completedDate === dateStr);
  if (!matches.length) return;
  const last = matches[matches.length - 1];
  habitCompletions = habitCompletions.filter(c => c !== last);
  renderHabits();
  setStatus('syncing');
  const { error } = await db.from('habit_completions').delete().eq('id', last.id);
  setStatus(error ? 'error' : 'saved');
  if (error) console.error('deleteCompletion:', error.message);
}

// Count completions for a habit on a specific date
function getCompletionCountForDate(habitClientId, dateStr) {
  const sid = habitServerId(habitClientId);
  if (!sid) return 0;
  return habitCompletions.filter(c => c.habitId === sid && c.completedDate === dateStr).length;
}

// Debounced render for realtime — coalesces rapid events into one render
let _habitRenderTimer = null;
function debouncedRenderHabits() {
  if (_habitRenderTimer) clearTimeout(_habitRenderTimer);
  _habitRenderTimer = setTimeout(() => { _habitRenderTimer = null; renderHabits(); }, 300);
}

function subscribeToHabitChanges() {
  db.channel('habits-changes')
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'habits',
      filter: `user_id=eq.${currentUser.id}`
    }, payload => {
      let changed = false;
      if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
        const incoming = rowToHabit(payload.new);
        habitRowIdMap.set(payload.new.id, payload.new.client_id);
        const idx = habitsArr.findIndex(h => h.id === incoming.id);
        if (idx >= 0) {
          // Only flag changed if data actually differs
          const old = habitsArr[idx];
          if (old.name !== incoming.name || old.emoji !== incoming.emoji || old.archived !== incoming.archived ||
              old.frequency !== incoming.frequency || JSON.stringify(old.tags) !== JSON.stringify(incoming.tags)) changed = true;
          habitsArr[idx] = incoming;
        } else { habitsArr.push(incoming); changed = true; }
      } else if (payload.eventType === 'DELETE') {
        const clientId = habitRowIdMap.get(payload.old.id);
        if (clientId !== undefined) {
          habitsArr = habitsArr.filter(h => h.id !== clientId);
          habitRowIdMap.delete(payload.old.id);
          changed = true;
        }
      }
      if (changed) debouncedRenderHabits();
    })
    .subscribe(onChannelStatus);

  db.channel('completions-changes')
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'habit_completions',
      filter: `user_id=eq.${currentUser.id}`
    }, payload => {
      let changed = false;
      if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
        const incoming = rowToCompletion(payload.new);
        completionRowIdMap.set(payload.new.id, payload.new.id);
        const idx = habitCompletions.findIndex(c => c.id === incoming.id);
        if (idx >= 0) { habitCompletions[idx] = incoming; }
        else {
          // Check if we already have this habit+date (optimistic temp entry)
          const dupIdx = habitCompletions.findIndex(c => c.habitId === incoming.habitId && c.completedDate === incoming.completedDate);
          if (dupIdx >= 0) { habitCompletions[dupIdx] = incoming; /* just upgrade temp id, no visual change */ }
          else { habitCompletions.push(incoming); changed = true; }
        }
      } else if (payload.eventType === 'DELETE') {
        const before = habitCompletions.length;
        habitCompletions = habitCompletions.filter(c => c.id !== payload.old.id);
        completionRowIdMap.delete(payload.old.id);
        changed = habitCompletions.length !== before;
      }
      if (changed) debouncedRenderHabits();
    })
    .subscribe(onChannelStatus);
}

async function loadHabits() {
  const { data: hData, error: hErr } = await db.from('habits')
    .select('*').eq('user_id', currentUser.id).order('order', { ascending: true });
  if (hErr) { console.error('loadHabits:', hErr.message); return; }
  habitsArr = hData.map(rowToHabit);
  hData.forEach(r => habitRowIdMap.set(r.id, r.client_id));

  const { data: cData, error: cErr } = await db.from('habit_completions')
    .select('*').eq('user_id', currentUser.id);
  if (cErr) { console.error('loadCompletions:', cErr.message); return; }
  habitCompletions = cData.map(rowToCompletion);
  cData.forEach(r => completionRowIdMap.set(r.id, r.id));

  subscribeToHabitChanges();
  renderHabits();
}

/* ══════ HABITS RENDERING ══════ */
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function dayOfWeek(dateStr) {
  return new Date(dateStr + 'T12:00:00').getDay(); // 0=Sun
}

// Auto-refresh at midnight local time. Timer id stored so it can be cleared on sign-out.
let midnightRefreshTimer = null;
function scheduleMidnightRefresh() {
  const now = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const ms = tomorrow - now + 1000;
  midnightRefreshTimer = setTimeout(() => {
    midnightRefreshTimer = null;
    if (typeof renderHabits === 'function') renderHabits();
    if (typeof render === 'function') render();
    if (typeof renderNotes === 'function') renderNotes();
    scheduleMidnightRefresh();
  }, ms);
}
function cancelMidnightRefresh() {
  if (midnightRefreshTimer) { clearTimeout(midnightRefreshTimer); midnightRefreshTimer = null; }
}
scheduleMidnightRefresh();
function getWeekDates() {
  // Rolling 7 days: today is always the 7th (last) day
  const now = new Date();
  const dates = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now); d.setDate(now.getDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}
const SHORT_DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
function dayLabel(dateStr) {
  return SHORT_DAYS[new Date(dateStr + 'T12:00:00').getDay()];
}
function dayShort(dateStr) {
  return dayLabel(dateStr).charAt(0);
}

function isHabitDueOnDate(habit, dateStr) {
  if (habit.frequency === 'daily') return true;
  const dow = dayOfWeek(dateStr); // 0=Sun
  const dayName = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dow];
  if (habit.frequency === 'weekdays') return dow >= 1 && dow <= 5;
  if (habit.frequency === 'custom') return (habit.customDays || []).includes(dayName);
  // x_per_week and x_per_month: every day is a valid day to complete
  if (habit.frequency === 'x_per_week' || habit.frequency === 'x_per_month') return true;
  return true;
}
/**
 * Per-habit contribution to today's score. Returns { num, den }.
 *   Required today (strict pace): den = 1, num = 1 if done else 0
 *   Optional + user did it:       den = today_count, num = today_count
 *   Optional + user didn't touch: den = 0, num = 0 (excluded)
 * Summed across all habits gives the overall Today %.
 */
function todayContribution(habit, today) {
  const todayCount = getCompletionCountForDate(habit.id, today);
  const required = isHabitDueToday(habit) ? 1 : 0;
  const den = Math.max(required, todayCount);
  const num = todayCount;
  return { num, den };
}

/**
 * "Can be completed today" — the inclusion gate for the second Habits
 * section. Returns true if the user can still meaningfully tap the habit
 * today. Returns false if the habit is already 100% done for its period and
 * doesn't allow extras, or if today isn't a scheduled day for strict cadences.
 */
function canHabitDoToday(habit) {
  const today = todayStr();
  if (habit.frequency === 'x_per_week' || habit.frequency === 'x_per_month') {
    // Quota habits: blocked only when fully met AND no extras allowed.
    if (isQuotaMet(habit, today) && !habit.allowExtras) return false;
    return true;
  }
  // Strict cadences (daily / weekdays / custom): must be a scheduled day.
  if (!isHabitDueOnDate(habit, today)) return false;
  // Done today and no extras → nothing more to do for the period.
  if (isCompletedOn(habit.id, today) && !habit.allowExtras) return false;
  return true;
}

/**
 * Pace-aware "due today" for quota habits.
 * A 3x/month habit with 1 completed and 20 days left in the month is NOT
 * "due today" — you have time. It only becomes "due today" when you'd
 * miss the quota if you don't do it today (days_remaining <= quota_remaining).
 * Daily / weekdays / custom / specific DoW cadences use their strict rule.
 */
function isHabitDueToday(habit) {
  const today = todayStr();
  if (habit.frequency === 'x_per_week') {
    if (isQuotaMet(habit, today) && !habit.allowExtras) return false;
    const quota = habit.frequencyCount || 1;
    const doneThisWeek = getWeekCompletions(habit.id, today);
    const remaining = quota - doneThisWeek;
    if (remaining <= 0) return false;
    const d = new Date(today + 'T12:00:00');
    const dow = d.getDay();                       // 0=Sun, 1=Mon, ...
    const daysLeftIncludingToday = 7 - ((dow + 6) % 7);  // Mon=7, Sun=1
    return daysLeftIncludingToday <= remaining;
  }
  if (habit.frequency === 'x_per_month') {
    if (isQuotaMet(habit, today) && !habit.allowExtras) return false;
    const quota = habit.frequencyCount || 1;
    const doneThisMonth = getMonthCompletions(habit.id, today);
    const remaining = quota - doneThisMonth;
    if (remaining <= 0) return false;
    const d = new Date(today + 'T12:00:00');
    const y = d.getFullYear(), m = d.getMonth();
    const lastDay = new Date(y, m + 1, 0).getDate();
    const daysLeftIncludingToday = lastDay - d.getDate() + 1;
    return daysLeftIncludingToday <= remaining;
  }
  return isHabitDueOnDate(habit, today);
}

// For x_per_week: count completions in the same Mon-Sun week as dateStr
function getWeekCompletions(habitId, dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const dow = d.getDay(); // 0=Sun
  const mon = new Date(d); mon.setDate(d.getDate() - ((dow + 6) % 7)); // Monday
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6); // Sunday
  const monStr = mon.toISOString().slice(0, 10);
  const sunStr = sun.toISOString().slice(0, 10);
  return completionsForHabit(habitId).filter(c => c.completedDate >= monStr && c.completedDate <= sunStr).length;
}

// For x_per_month: count completions in the same calendar month
function getMonthCompletions(habitId, dateStr) {
  const monthPrefix = dateStr.slice(0, 7); // "2026-03"
  return completionsForHabit(habitId).filter(c => c.completedDate.startsWith(monthPrefix)).length;
}

// Check if quota-based habit has met its goal for the period containing dateStr
function isQuotaMet(habit, dateStr) {
  if (habit.frequency === 'x_per_week') return getWeekCompletions(habit.id, dateStr) >= (habit.frequencyCount || 1);
  if (habit.frequency === 'x_per_month') return getMonthCompletions(habit.id, dateStr) >= (habit.frequencyCount || 1);
  return false;
}

function freqLabel(h) {
  if (h.frequency === 'daily') return 'Every day';
  if (h.frequency === 'weekdays') return '5 days per week';
  if (h.frequency === 'custom') {
    const n = (h.customDays || []).length;
    return n === 7 ? 'Every day' : `${n} day${n !== 1 ? 's' : ''} per week`;
  }
  if (h.frequency === 'x_per_week') {
    const n = h.frequencyCount || 1;
    return `${n} day${n !== 1 ? 's' : ''} per week`;
  }
  if (h.frequency === 'x_per_month') {
    const n = h.frequencyCount || 1;
    return `${n} day${n !== 1 ? 's' : ''} per month`;
  }
  return 'Every day';
}

function streakLabel(streak) {
  return streak > 0 ? `🔥 Streak: ${streak}` : `Streak: ${streak}`;
}

function habitServerId(clientId) {
  for (const [sid, cid] of habitRowIdMap) { if (cid === clientId) return sid; }
  return null;
}

function isCompletedOn(habitClientId, dateStr) {
  const sid = habitServerId(habitClientId);
  if (!sid) return false;
  return habitCompletions.some(c => c.habitId === sid && c.completedDate === dateStr);
}

function completionsForHabit(habitClientId) {
  const sid = habitServerId(habitClientId);
  if (!sid) return [];
  return habitCompletions.filter(c => c.habitId === sid);
}

function computeStreak(habitClientId) {
  const habit = habitsArr.find(x => x.id === habitClientId);
  if (!habit) return 0;
  const comps = new Set(completionsForHabit(habitClientId).map(c => c.completedDate));
  if (!comps.size) return 0;
  const today = todayStr();

  // Quota-based: streak = consecutive weeks/months where quota met
  if (habit.frequency === 'x_per_week') {
    let streak = 0;
    const d = new Date(today + 'T12:00:00');
    const dow = d.getDay();
    const thisMon = new Date(d); thisMon.setDate(d.getDate() - ((dow + 6) % 7));
    // Check current week — if not met yet, start from previous week
    let checkDate = thisMon;
    const thisWeekMet = isQuotaMet(habit, today);
    if (!thisWeekMet) { checkDate = new Date(thisMon); checkDate.setDate(thisMon.getDate() - 7); }
    for (let i = 0; i < 52; i++) {
      const ds = checkDate.toISOString().slice(0, 10);
      if (isQuotaMet(habit, ds)) { streak++; checkDate.setDate(checkDate.getDate() - 7); }
      else break;
    }
    return streak;
  }
  if (habit.frequency === 'x_per_month') {
    let streak = 0;
    const d = new Date(today + 'T12:00:00');
    let y = d.getFullYear(), m = d.getMonth();
    const thisMonthMet = isQuotaMet(habit, today);
    if (!thisMonthMet) { m--; if (m < 0) { m = 11; y--; } }
    for (let i = 0; i < 24; i++) {
      const ds = `${y}-${String(m + 1).padStart(2, '0')}-15`;
      if (isQuotaMet(habit, ds)) { streak++; m--; if (m < 0) { m = 11; y--; } }
      else break;
    }
    return streak;
  }

  // Day-based streak (daily/weekdays/custom)
  let streak = 0;
  let d = new Date(today + 'T12:00:00');
  if (isHabitDueOnDate(habit, today) && !comps.has(today)) d.setDate(d.getDate() - 1);
  else if (!isHabitDueOnDate(habit, today)) { /* skip today */ }
  for (let safety = 0; safety < 365; safety++) {
    const ds = d.toISOString().slice(0, 10);
    if (!isHabitDueOnDate(habit, ds)) { d.setDate(d.getDate() - 1); continue; }
    if (comps.has(ds)) { streak++; d.setDate(d.getDate() - 1); }
    else break;
  }
  return streak;
}

function computeBestStreak(habitClientId) {
  const habit = habitsArr.find(x => x.id === habitClientId);
  if (!habit) return 0;
  const comps = new Set(completionsForHabit(habitClientId).map(c => c.completedDate));
  if (!comps.size) return 0;

  // Quota-based: best consecutive weeks/months
  if (habit.frequency === 'x_per_week') {
    const d = new Date(todayStr() + 'T12:00:00');
    const dow = d.getDay();
    const thisMon = new Date(d); thisMon.setDate(d.getDate() - ((dow + 6) % 7));
    let best = 0, cur = 0;
    for (let i = 0; i < 52; i++) {
      const checkDate = new Date(thisMon); checkDate.setDate(thisMon.getDate() - i * 7);
      if (isQuotaMet(habit, checkDate.toISOString().slice(0, 10))) { cur++; if (cur > best) best = cur; }
      else cur = 0;
    }
    return best;
  }
  if (habit.frequency === 'x_per_month') {
    const d = new Date(todayStr() + 'T12:00:00');
    let y = d.getFullYear(), m = d.getMonth();
    let best = 0, cur = 0;
    for (let i = 0; i < 24; i++) {
      const ds = `${y}-${String(m + 1).padStart(2, '0')}-15`;
      if (isQuotaMet(habit, ds)) { cur++; if (cur > best) best = cur; }
      else cur = 0;
      m--; if (m < 0) { m = 11; y--; }
    }
    return best;
  }

  // Day-based best streak
  const today = new Date(todayStr() + 'T12:00:00');
  const dueDates = [];
  for (let i = 0; i < 365; i++) {
    const d = new Date(today); d.setDate(today.getDate() - i);
    const ds = d.toISOString().slice(0, 10);
    if (isHabitDueOnDate(habit, ds)) dueDates.push(ds);
  }
  dueDates.reverse();
  let best = 0, cur = 0;
  for (const ds of dueDates) {
    if (comps.has(ds)) { cur++; if (cur > best) best = cur; }
    else cur = 0;
  }
  return best;
}

/**
 * Cadence-aware score per gsd-handoff/DESIGN_HANDOFF.md §4.
 *   pct(habit) = clamp(actual / expected, 0, 1) × 100
 * "actual"   = completions in the current period.
 * "expected" = how many were scheduled in the period so far, per cadence.
 *
 * The period is the current calendar month for daily/weekday/specific-DoW
 * cadences, and the natural cadence period (week/month) for x_per_week and
 * x_per_month. Always clamped 0–100 — a 1×/month habit completed once
 * shows 100% (not 5%, the old bug).
 */
function computeScore(habit) {
  const today = todayStr();                                  // YYYY-MM-DD
  const todayD = new Date(today + 'T12:00:00');
  const comps = completionsForHabit(habit.id);

  // x_per_week — period = current week (Mon–today). Expected = quota for the week.
  if (habit.frequency === 'x_per_week') {
    const dow = todayD.getDay();
    const monday = new Date(todayD); monday.setDate(todayD.getDate() - ((dow + 6) % 7));
    const monStr = monday.toISOString().slice(0, 10);
    const actual = comps.filter(c => c.completedDate >= monStr && c.completedDate <= today).length;
    const expected = habit.frequencyCount || habit.quota || 1;
    return Math.min(100, Math.round((actual / expected) * 100));
  }

  // x_per_month — period = current month. Expected = quota for the month.
  if (habit.frequency === 'x_per_month') {
    const y = todayD.getFullYear(), m = todayD.getMonth();
    const monStart = `${y}-${String(m + 1).padStart(2, '0')}-01`;
    const actual = comps.filter(c => c.completedDate >= monStart && c.completedDate <= today).length;
    const expected = habit.frequencyCount || habit.quota || 1;
    return Math.min(100, Math.round((actual / expected) * 100));
  }

  // Day-based (every day, weekdays, specific DoW) — period = current month so far.
  // Expected = count of due days from day 1 → today (inclusive) per the cadence.
  const y = todayD.getFullYear(), m = todayD.getMonth();
  let actual = 0, expected = 0;
  for (let day = 1; day <= todayD.getDate(); day++) {
    const d = new Date(y, m, day, 12, 0, 0);
    const ds = d.toISOString().slice(0, 10);
    if (isHabitDueOnDate(habit, ds)) {
      expected++;
      if (comps.some(c => c.completedDate === ds)) actual++;
    }
  }
  if (expected === 0) return 0;
  return Math.min(100, Math.round((actual / expected) * 100));
}

function scoreColor(score) {
  if (score >= 80) return 'var(--guava-700)';
  if (score >= 60) return 'var(--guava-700)';
  if (score >= 40) return 'var(--guava-800)';
  return 'var(--guava-700)';
}

const CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>';

function renderHabits() {
  if (typeof habitsArr === 'undefined') return;
  const active = habitsArr.filter(h => !h.archived);
  renderHabitToday(active);
  renderHabitAll(active);
  renderHabitStats(active);
  updateHabitStatsBar(active);
}

/**
 * Build the Today view card HTML for a single habit. Extracted so both the
 * DUE TODAY and HABITS sections can reuse the exact same markup.
 * "isExtras + isDone" branch renders the +/- controls; the default is the
 * standard toggle check.
 */
function habitTodayCardHTML(h, today) {
  const streak = computeStreak(h.id);
  const isDone = isCompletedOn(h.id, today);
  const isExtras = !!h.allowExtras;
  const todayCount = getCompletionCountForDate(h.id, today);
  const periodCount = h.frequency === 'x_per_month' ? getMonthCompletions(h.id, today)
                   : h.frequency === 'x_per_week'  ? getWeekCompletions(h.id, today)
                   : 0;
  const periodGoal = h.frequencyCount || 1;
  const periodLabel = h.frequency === 'x_per_month' ? 'this month'
                    : h.frequency === 'x_per_week'  ? 'this week'
                    : '';
  const cardCls = `habit-card habit-today-card${isDone ? ' habit-done' : ''}`;

  if (isDone && isExtras) {
    // Completed + extras allowed → show count badge + +/- controls.
    const countBadge = todayCount > 1
      ? `<span style="font-size:10px;font-weight:700;color:var(--guava-700);background:var(--guava-100);padding:1px 6px;border-radius:8px;margin-left:4px">×${todayCount}</span>`
      : '';
    const progressMeta = periodLabel
      ? `<span style="color:var(--guava-700);font-weight:600">${periodCount}/${periodGoal}</span> ${periodLabel}`
      : '';
    return `<div class="${cardCls}" data-habit-id="${h.id}">
      <div class="swipe-complete-bg">✓</div>
      <span class="habit-emoji-lg" data-habit-action="drill" data-habit-id="${h.id}">${escHTML(h.emoji || '')}</span>
      <div class="habit-today-content" data-habit-action="drill" data-habit-id="${h.id}" style="cursor:pointer">
        <div class="habit-card-top">
          <span class="habit-name">${escHTML(h.name || '')}</span>${countBadge}
        </div>
        <div class="habit-card-meta">${progressMeta ? progressMeta + ' · ' : ''}<span class="habit-streak${streak===0?' dead':''}">${streakLabel(streak)}</span></div>
      </div>
      <div style="display:flex;align-items:center;gap:4px;flex-shrink:0">
        <button data-habit-action="remove-last" data-habit-id="${h.id}" data-habit-date="${today}" style="width:22px;height:22px;border-radius:50%;border:1.5px solid var(--edge-strong);background:var(--surface);color:var(--ink-3);font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1" title="Remove one">−</button>
        <button data-habit-action="toggle-complete" data-habit-id="${h.id}" data-habit-date="${today}" style="width:22px;height:22px;border-radius:50%;border:1.5px solid var(--guava-700);background:var(--guava-700);color:#fff;font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;font-weight:700" title="Add another">+</button>
      </div>
    </div>`;
  }

  // Standard card — either incomplete or done-without-extras.
  return `<div class="${cardCls}" data-habit-id="${h.id}">
    <div class="swipe-complete-bg">✓</div>
    <span class="habit-emoji-lg" data-habit-action="drill" data-habit-id="${h.id}">${escHTML(h.emoji || '')}</span>
    <div class="habit-today-content" data-habit-action="drill" data-habit-id="${h.id}" style="cursor:pointer">
      <div class="habit-card-top">
        <span class="habit-name">${escHTML(h.name || '')}</span>
      </div>
      <div class="habit-card-meta"><span class="habit-streak${streak===0?' dead':''}">${streakLabel(streak)}</span> · ${freqLabel(h)}</div>
    </div>
    <div class="habit-check${isDone ? ' checked' : ''}" data-habit-action="toggle-complete" data-habit-id="${h.id}" data-habit-date="${today}"><svg width="9" height="7" viewBox="0 0 10 8" fill="none"><path d="M1 4L3.5 6.5L9 1" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg></div>
  </div>`;
}

function renderHabitToday(active) {
  const el = document.getElementById('habit-today');
  if (!el) return;
  const today = todayStr();

  // Two sections:
  //   DUE TODAY — habits that must be completed today to stay on pace. Both
  //     remaining and already-done-today entries show here (done ones visibly
  //     checked); this gives a complete view of "what was required today".
  //   HABITS — habits that CAN still be completed today but aren't strictly
  //     required. Excludes habits that are fully complete for their period
  //     and don't allow extras.
  const dueToday = active.filter(h => isHabitDueToday(h));
  const optional = active.filter(h => !isHabitDueToday(h) && canHabitDoToday(h));

  if (active.length === 0) {
    el.innerHTML = `<div class="empty-state">
      <div class="empty-state-title">No habits yet. Start one.</div>
    </div>`;
    return;
  }

  // Stats strip removed from the Today tab — the same Today % is surfaced
  // in the Today filter pill via updateHabitStatsBar(). Best streak and
  // 'done today' counters live on the Statistics tab.
  const dueHTML = dueToday.map(h => habitTodayCardHTML(h, today)).join('');
  const optHTML = optional.map(h => habitTodayCardHTML(h, today)).join('');

  el.innerHTML = `
    ${dueToday.length
      ? `<div class="section-label">Due today</div>${dueHTML}`
      : '<div style="text-align:center;padding:24px;color:var(--ink-3);font-size:13px">Nothing required today — nice.</div>'}
    ${optional.length ? `<div class="section-label">Habits</div>${optHTML}` : ''}
  `;
}

function renderHabitAll(active) {
  const el = document.getElementById('habit-all');
  if (!el) return;
  const today = todayStr();
  const weekDates = getWeekDates();

  const archived = habitsArr.filter(h => h.archived);
  if (!active.length && !archived.length) {
    el.innerHTML = `<div style="text-align:center;padding:60px 20px;color:var(--ink-3)">
      <div style="font-size:32px;margin-bottom:12px">🔥</div>
      <div style="font-size:15px;font-weight:600;color:var(--ink-2);margin-bottom:4px">No habits yet</div>
      <div style="font-size:13px">Tap + to create your first habit.</div>
    </div>`;
    return;
  }

  let html = '<div class="section-label">🔥 ALL HABITS</div>';
  active.forEach(h => {
    const streak = computeStreak(h.id);

    // Weekly dots — date numbers inside circles
    let dots = '';
    weekDates.forEach((ds, i) => {
      const due = isHabitDueOnDate(h, ds);
      const done = due && isCompletedOn(h.id, ds);
      const isToday = ds === today;
      const dayNum = parseInt(ds.slice(8), 10);
      if (!due) {
        dots += `<div class="habit-day"><span class="habit-day-label">${dayShort(ds)}</span><div class="habit-day-dot disabled">${dayNum}</div></div>`;
      } else {
        const cls = `habit-day-dot${done?' done':''}${isToday?' today':''}`;
        dots += `<div class="habit-day"><span class="habit-day-label">${dayShort(ds)}</span><div class="${cls}" data-habit-action="toggle-complete-dot" data-habit-id="${h.id}" data-habit-date="${ds}">${dayNum}</div></div>`;
      }
    });

    // Cadence-aware score — 1x/month done once is 100% for the month.
    // Daily/weekdays use the current-month running total; x_per_week uses
    // the current week; x_per_month uses the current month.
    const pct = computeScore(h);
    const periodLabel =
      h.frequency === 'x_per_week'  ? 'this week'  :
      h.frequency === 'x_per_month' ? 'this month' :
                                      'this month';

    html += `<div class="habit-card" data-habit-action="drill" data-habit-id="${h.id}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <div>
          <div class="habit-name" style="font-size:15px;font-weight:600">${escHTML(h.name || '')}</div>
          <div style="font-size:12px;color:var(--guava-700);margin-top:2px">${freqLabel(h)}</div>
        </div>
        <span style="font-size:28px;line-height:1">${escHTML(h.emoji || '')}</span>
      </div>
      <div class="habit-week-dots">${dots}</div>
      <div class="habit-card-footer" style="padding-left:0;margin-top:14px;padding-bottom:0">
        <div class="habit-card-meta"><span class="habit-streak${streak===0?' dead':''}">${streakLabel(streak)}</span> · <span style="color:var(--guava-700)">✓</span> ${pct}% ${periodLabel}</div>
        <div class="habit-card-actions">
          <button class="habit-action-btn" data-habit-action="drill-calendar" data-habit-id="${h.id}" title="Calendar"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg></button>
          <button class="habit-action-btn" data-habit-action="drill-stats" data-habit-id="${h.id}" title="Statistics"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="12" width="4" height="9"/><rect x="10" y="7" width="4" height="14"/><rect x="17" y="3" width="4" height="18"/></svg></button>
          <button class="habit-action-btn" data-habit-action="drill-edit" data-habit-id="${h.id}" title="More"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg></button>
        </div>
      </div>
    </div>`;
  });

  // Archived habits section
  if (archived.length) {
    html += `<div class="section-label" style="margin-top:24px;cursor:pointer;user-select:none" data-habit-action="toggle-archived">📦 ARCHIVED <span class="arch-arrow">▸</span> <span style="font-weight:400;color:var(--ink-3);font-size:11px">${archived.length}</span></div>`;
    html += `<div id="archivedHabitsSection" style="display:none">`;
    archived.forEach(h => {
      html += `<div class="habit-card" style="opacity:0.6">
        <div class="habit-card-top">
          <span class="habit-emoji">${escHTML(h.emoji || '')}</span><span class="habit-name">${escHTML(h.name || '')}</span>
          <button data-habit-action="unarchive" data-habit-id="${h.id}" style="margin-left:auto;background:none;border:1px solid var(--edge);border-radius:8px;padding:4px 12px;font-size:11px;font-family:inherit;cursor:pointer;color:var(--ink-2);">Unarchive</button>
        </div>
      </div>`;
    });
    html += `</div>`;
  }

  el.innerHTML = html;
}

function unarchiveHabit(habitId) {
  const h = habitsArr.find(x => x.id === habitId);
  if (!h) return;
  h.archived = false;
  renderHabits();
  saveHabitToDB(h);
}

let statsMonth = new Date().getMonth();
let statsMonthYear = new Date().getFullYear();
let statsYear = new Date().getFullYear();
// Default view: the current month so the most relevant insights show first.
// 'monthly' starts on statsMonth/statsMonthYear (init'd to now above);
// user can zoom out to 'yearly' from the month header.
let statsView = 'monthly';

function renderHabitStats(active) {
  const el = document.getElementById('habit-stats');
  if (!el) return;

  if (!active.length) {
    el.innerHTML = `<div style="text-align:center;padding:60px 20px;color:var(--ink-3)">
      <div style="font-size:32px;margin-bottom:12px">📊</div>
      <div style="font-size:15px;font-weight:600;color:var(--ink-2);margin-bottom:4px">No statistics yet</div>
      <div style="font-size:13px">Create some habits to see your stats.</div>
    </div>`;
    return;
  }

  el.innerHTML = '<div id="statsContent"></div>';
  if (statsView === 'monthly') renderStatsMonthly(active);
  else renderStatsYearly(active);
}

function computeStatsData(active, startDate, endDate) {
  const today = todayStr();
  const dailyData = {};
  let totalDue = 0, totalDone = 0;
  const start = new Date(startDate + 'T12:00:00');
  const end = new Date(endDate + 'T12:00:00');
  for (let dt = new Date(start); dt <= end; dt.setDate(dt.getDate() + 1)) {
    const ds = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    if (ds > today) { dailyData[ds] = { due: 0, done: 0, future: true }; continue; }
    let due = 0, done = 0;
    active.forEach(h => {
      if (isHabitDueOnDate(h, ds)) { due++; if (isCompletedOn(h.id, ds)) done++; }
    });
    dailyData[ds] = { due, done, future: false };
    totalDue += due; totalDone += done;
  }
  const completionRate = totalDue > 0 ? Math.round((totalDone / totalDue) * 100) : 0;
  const allDates = Object.keys(dailyData).sort();

  // Habit ranking — cadence-aware so a 1x/month habit done once in the
  // month shows 100%, not (1 / days-in-month). Counts PERIODS for quota
  // habits (months or weeks fully within the date range, capped at today)
  // and DUE DAYS for strict cadences.
  const todayD = new Date(today + 'T12:00:00');
  const rangeEnd = end > todayD ? todayD : end;
  const rankings = active.map(h => {
    const comps = completionsForHabit(h.id);
    let expected = 0, actual = 0;

    if (h.frequency === 'x_per_month') {
      // Count each calendar month that has any day in [start..rangeEnd].
      const iter = new Date(start.getFullYear(), start.getMonth(), 1);
      while (iter <= rangeEnd) {
        expected += h.frequencyCount || 1;
        const y = iter.getFullYear(), m = iter.getMonth();
        const monStart = `${y}-${String(m + 1).padStart(2, '0')}-01`;
        const monEnd   = `${y}-${String(m + 1).padStart(2, '0')}-${String(new Date(y, m + 1, 0).getDate()).padStart(2, '0')}`;
        // Clamp monthly actuals to the quota so extras don't inflate %.
        const inMonth = comps.filter(c => c.completedDate >= monStart && c.completedDate <= monEnd && c.completedDate <= today).length;
        actual += Math.min(inMonth, h.frequencyCount || 1);
        iter.setMonth(iter.getMonth() + 1);
      }
    } else if (h.frequency === 'x_per_week') {
      // Iterate by week starting at the Monday on/before `start`.
      const anchor = new Date(start);
      const dow = anchor.getDay();
      anchor.setDate(anchor.getDate() - ((dow + 6) % 7));
      const iter = new Date(anchor);
      while (iter <= rangeEnd) {
        expected += h.frequencyCount || 1;
        const monStr = iter.toISOString().slice(0, 10);
        const sun = new Date(iter); sun.setDate(iter.getDate() + 6);
        const sunStr = sun.toISOString().slice(0, 10);
        const inWeek = comps.filter(c => c.completedDate >= monStr && c.completedDate <= sunStr && c.completedDate <= today).length;
        actual += Math.min(inWeek, h.frequencyCount || 1);
        iter.setDate(iter.getDate() + 7);
      }
    } else {
      // Strict cadence — daily / weekdays / custom. Count due days.
      allDates.forEach(ds => {
        const dd = dailyData[ds];
        if (dd && !dd.future && isHabitDueOnDate(h, ds)) {
          expected++;
          if (isCompletedOn(h.id, ds)) actual++;
        }
      });
    }

    const pct = expected > 0 ? Math.min(100, Math.round((actual / expected) * 100)) : 0;
    return { emoji: h.emoji, name: h.name, pct };
  }).sort((a, b) => b.pct - a.pct);

  let rankHtml = '';
  rankings.forEach((h, i) => {
    const color = h.pct >= 80 ? 'var(--guava-700)' : h.pct >= 60 ? 'var(--guava-700)' : h.pct >= 40 ? 'var(--guava-700)' : 'var(--guava-700)';
    rankHtml += `<div class="st-rank"><span class="rn">${i + 1}</span><span class="re">${escHTML(h.emoji || '')}</span><span class="rname">${escHTML(h.name || '')}</span><div class="rbar"><div class="rbar-fill" style="width:${h.pct}%;background:${color}"></div></div><span class="rpct" style="color:${color}">${h.pct}%</span></div>`;
  });

  return { dailyData, totalDue, totalDone, completionRate, allDates, rankings, rankHtml };
}

function renderStatsYearly(active) {
  const el = document.getElementById('statsContent');
  if (!el) return;
  const MO_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const y = statsYear;
  const today = todayStr();
  const isCurrentYear = y === new Date().getFullYear();
  const startDate = `${y}-01-01`;
  const endDate = `${y}-12-31`;

  const s = computeStatsData(active, startDate, endDate);

  // Monthly trend bars (clickable to drill into month)
  let trendHtml = '';
  let bestMonthIdx = 0, bestMonthRate = 0;
  for (let mo = 0; mo < 12; mo++) {
    const moStart = `${y}-${String(mo + 1).padStart(2, '0')}-01`;
    const moDays = new Date(y, mo + 1, 0).getDate();
    let mDue = 0, mDone = 0;
    for (let d = 1; d <= moDays; d++) {
      const ds = `${y}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const dd = s.dailyData[ds];
      if (dd && !dd.future) { mDue += dd.due; mDone += dd.done; }
    }
    const pct = mDue > 0 ? Math.round((mDone / mDue) * 100) : 0;
    if (pct > bestMonthRate) { bestMonthRate = pct; bestMonthIdx = mo; }
    const h = pct > 0 ? (pct / 100) * 65 : 0;
    const isCurrent = y === new Date().getFullYear() && mo === new Date().getMonth();
    const isPast = moStart <= today;
    const barColor = isCurrent ? 'var(--guava-700)' : isPast && pct > 0 ? 'var(--guava-700)' : 'var(--surface-2)';
    const opacity = isPast ? 1 : 0.2;
    trendHtml += `<div class="st-trend-wrap" style="cursor:pointer" data-stats-action="to-monthly" data-stats-month="${mo}" data-stats-year="${y}" title="View ${MO_SHORT[mo]} ${y}">${pct > 0 ? `<div class="st-trend-pct">${pct}%</div>` : ''}<div class="st-trend-bar" style="height:${Math.max(h, 2)}px;background:${barColor};opacity:${opacity}"></div><div class="st-trend-mo">${MO_SHORT[mo]}</div></div>`;
  }
  const longestStreak = Math.max(...active.map(h => computeBestStreak(h.id)), 0);

  // Insight
  let insightText = '';
  if (s.totalDue > 0 && s.rankings[0] && s.rankings[0].pct > 0) {
    insightText = `<strong>Best month: ${MO_SHORT[bestMonthIdx]}</strong> at ${bestMonthRate}%. <strong>${s.rankings[0].name}</strong> leads at ${s.rankings[0].pct}%.`;
  }

  el.innerHTML = `
    <div class="stat-cards-grid" style="margin-bottom:10px">
      <div class="stat-card"><div class="sc-val" style="color:var(--guava-700)">${s.completionRate}%</div><div class="sc-lbl">Completion Rate</div></div>
      <div class="stat-card"><div class="sc-val" style="color:var(--guava-700)">${bestMonthRate > 0 ? MO_SHORT[bestMonthIdx] : '—'}</div><div class="sc-lbl">Best Month</div></div>
      <div class="stat-card"><div class="sc-val" style="color:var(--guava-700)">${longestStreak}</div><div class="sc-lbl">Longest Streak</div></div>
    </div>
    <div class="st-card">
      <div class="st-nav">
        <button data-stats-action="year-prev" data-stats-year="${y - 1}">← ${y - 1}</button>
        <span class="st-nav-label">${y}</span>
        <button data-stats-action="year-next" data-stats-year="${y + 1}" ${isCurrentYear?'disabled style="opacity:0.3;cursor:default"':''}>${y + 1} →</button>
      </div>
      <div class="st-card-title" style="margin-top:8px">Monthly Trend</div>
      <div class="st-trend">${trendHtml}</div>
      <div style="text-align:center;font-size:10px;color:var(--ink-3);margin-top:6px">Tap a month to drill in</div>
    </div>
    <div class="st-card">
      <div class="st-card-title">Habit Ranking</div>
      ${s.rankHtml}
    </div>
    ${insightText ? `<div class="st-insight" style="margin-top:10px">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
      <div class="st-insight-text">${insightText}</div>
    </div>` : ''}
  `;
}

function renderStatsMonthly(active) {
  const el = document.getElementById('statsContent');
  if (!el) return;
  const MO = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const MO_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const y = statsMonthYear, m = statsMonth;
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const startDate = `${y}-${String(m + 1).padStart(2, '0')}-01`;
  const endDate = `${y}-${String(m + 1).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;

  const prevM = m === 0 ? 11 : m - 1;
  const prevY = m === 0 ? y - 1 : y;
  const nextM = m === 11 ? 0 : m + 1;
  const nextY = m === 11 ? y + 1 : y;
  const isCurrentMonth = y === new Date().getFullYear() && m === new Date().getMonth();

  const s = computeStatsData(active, startDate, endDate);
  const currentStreak = Math.max(...active.map(h => computeStreak(h.id)), 0);
  const longestStreak = Math.max(...active.map(h => computeBestStreak(h.id)), 0);

  // Weekly trend bars
  let trendHtml = '';
  const weeks = [];
  let weekDue = 0, weekDone = 0, weekNum = 1;
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const dd = s.dailyData[ds];
    if (dd && !dd.future) { weekDue += dd.due; weekDone += dd.done; }
    const dow = (new Date(ds + 'T12:00:00').getDay() + 6) % 7;
    if (dow === 6 || d === daysInMonth) {
      weeks.push({ label: `W${weekNum}`, pct: weekDue > 0 ? Math.round((weekDone / weekDue) * 100) : 0 });
      weekDue = 0; weekDone = 0; weekNum++;
    }
  }
  weeks.forEach(w => {
    const h = w.pct > 0 ? (w.pct / 100) * 65 : 0;
    const barColor = w.pct > 0 ? 'var(--guava-700)' : 'var(--surface-2)';
    trendHtml += `<div class="st-trend-wrap">${w.pct > 0 ? `<div class="st-trend-pct">${w.pct}%</div>` : ''}<div class="st-trend-bar" style="height:${Math.max(h, 2)}px;background:${barColor}"></div><div class="st-trend-mo">${w.label}</div></div>`;
  });

  // Insight — best week
  let insightText = '';
  if (s.totalDue > 0 && s.rankings[0] && s.rankings[0].pct > 0) {
    const bestWeek = weeks.reduce((best, w) => w.pct > best.pct ? w : best, { label: 'W1', pct: 0 });
    insightText = `<strong>Best week: ${bestWeek.label}</strong> at ${bestWeek.pct}%. <strong>${s.rankings[0].name}</strong> leads at ${s.rankings[0].pct}%.`;
  }

  el.innerHTML = `
    <div class="stat-cards-grid" style="margin-bottom:10px">
      <div class="stat-card"><div class="sc-val" style="color:var(--guava-700)">${s.completionRate}%</div><div class="sc-lbl">Completion Rate</div></div>
      <div class="stat-card"><div class="sc-val" style="color:var(--guava-700)">${currentStreak}</div><div class="sc-lbl">Current Streak</div></div>
      <div class="stat-card"><div class="sc-val" style="color:var(--guava-700)">${longestStreak}</div><div class="sc-lbl">Longest Streak</div></div>
    </div>
    <div class="st-card">
      <div class="st-nav">
        <button data-stats-action="month-nav" data-stats-month="${prevM}" data-stats-year="${prevY}">← ${MO_SHORT[prevM]}</button>
        <span class="st-nav-label" style="cursor:pointer" data-stats-action="to-yearly" data-stats-year="${y}" title="Back to ${y} overview">${MO[m]} ${y} ▴</span>
        <button data-stats-action="month-nav" data-stats-month="${nextM}" data-stats-year="${nextY}" ${isCurrentMonth?'disabled style="opacity:0.3;cursor:default"':''}>${MO_SHORT[nextM]} →</button>
      </div>
      <div class="st-card-title" style="margin-top:8px">Weekly Trend</div>
      <div class="st-trend">${trendHtml}</div>
    </div>
    <div class="st-card">
      <div class="st-card-title">Habit Ranking</div>
      ${s.rankHtml}
    </div>
    ${insightText ? `<div class="st-insight" style="margin-top:10px">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
      <div class="st-insight-text">${insightText}</div>
    </div>` : ''}
  `;
}

function updateHabitStatsBar(active) {
  // Badge always updates regardless of active tool
  paintBadge('habitsBadgeMobile', active.length);
  const sbc = document.getElementById('sidebarHabitsCount'); if (sbc) sbc.textContent = active.length;
  // Today pill shows the contribution-weighted % done today (matches the
  // formula used in renderHabitToday). 'All' pill shows the habit count.
  const todayStr_ = typeof todayStr === 'function' ? todayStr() : new Date().toISOString().slice(0,10);
  let tNum = 0, tDen = 0;
  active.forEach(h => { const c = todayContribution(h, todayStr_); tNum += c.num; tDen += c.den; });
  const tPct = tDen > 0 ? Math.round((tNum / tDen) * 100) : 100;
  const pcHT = document.getElementById('pc-habit-today'); if (pcHT) pcHT.textContent = tPct + '%';
  const pcHA = document.getElementById('pc-habit-all');   if (pcHA) pcHA.textContent = active.length;
}

/* ── HABIT CARD + STATS DELEGATION ──
 * One document-level listener dispatches habit actions (drill-in, toggle
 * completion, archive toggle) and stats navigation (year/month switches).
 * Cards live in #habit-today, #habit-all, #habit-stats — each re-renders
 * innerHTML; doc-level delegation avoids rebinding per render.
 */
document.addEventListener('click', e => {
  const hAction = e.target.closest('[data-habit-action]');
  if (hAction) {
    const action = hAction.dataset.habitAction;
    const id = hAction.dataset.habitId ? parseInt(hAction.dataset.habitId) : null;
    const date = hAction.dataset.habitDate || null;
    switch (action) {
      case 'drill':          openHabitDrillIn(id); return;
      case 'drill-calendar': openHabitDrillIn(id, 'calendar'); return;
      case 'drill-stats':    openHabitDrillIn(id, 'stats'); return;
      case 'drill-edit':     openHabitDrillIn(id, 'edit'); return;
      case 'remove-last':    removeLastCompletion(id, date); return;
      case 'toggle-complete': toggleCompletion(id, date); return;
      case 'toggle-complete-dot':
        hAction.classList.add('just-toggled');
        toggleCompletion(id, date);
        return;
      case 'unarchive':      unarchiveHabit(id); return;
      case 'toggle-archived': {
        const sec = document.getElementById('archivedHabitsSection');
        const hidden = sec.style.display === 'none';
        sec.style.display = hidden ? 'block' : 'none';
        const arrow = hAction.querySelector('.arch-arrow');
        if (arrow) arrow.textContent = hidden ? '▾' : '▸';
        return;
      }
    }
  }
  const sAction = e.target.closest('[data-stats-action]');
  if (sAction) {
    const action = sAction.dataset.statsAction;
    const y = sAction.dataset.statsYear ? parseInt(sAction.dataset.statsYear) : null;
    const m = sAction.dataset.statsMonth ? parseInt(sAction.dataset.statsMonth) : null;
    switch (action) {
      case 'year-prev':
      case 'year-next':  statsYear = y; renderHabits(); return;
      case 'month-nav':  statsMonth = m; statsMonthYear = y; renderHabits(); return;
      case 'to-yearly':  statsView = 'yearly'; statsYear = y; renderHabits(); return;
      case 'to-monthly': statsMonth = m; statsMonthYear = y; statsView = 'monthly'; renderHabits(); return;
    }
  }
});

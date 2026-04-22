
/* ══════ HABITS CRUD ══════ */
function openHabitCreatePanel() {
  document.getElementById('fabBtn').classList.add('hidden');
  document.getElementById('floatingSearch').classList.add('hidden');
  document.getElementById('habitCreatePanel').classList.add('open');
  document.getElementById('habitNameInput').value = '';
  document.getElementById('habitEmojiBtn').textContent = '✅';
  document.getElementById('habitEmojiGrid').style.display = 'none';
  newHabitTags = new Set();
  // Reset freq
  document.querySelectorAll('#habitFreqOptions .freq-btn').forEach(b => b.classList.toggle('active', b.dataset.freq === 'daily'));
  document.getElementById('habitCustomDays').style.display = 'none';
  document.getElementById('habitFreqCount').style.display = 'none';
  document.getElementById('habitFreqCountInput').value = 3;
  document.getElementById('habitExtrasToggle').style.display = 'none';
  document.getElementById('habitAllowExtras').checked = false;
  document.querySelectorAll('.custom-day').forEach(b => b.classList.remove('active'));
  setTimeout(() => document.getElementById('habitNameInput').focus(), 50);
}
function closeHabitCreatePanel() {
  document.getElementById('fabBtn').classList.remove('hidden');
  updateFloatingSearch();
  document.getElementById('habitCreatePanel').classList.remove('open');
}
function pickHabitEmoji(em) {
  document.getElementById('habitEmojiBtn').textContent = em;
  document.getElementById('habitEmojiGrid').style.display = 'none';
}
function toggleHabitTag(tag) {
  if (newHabitTags.has(tag)) newHabitTags.delete(tag); else newHabitTags.add(tag);
  document.getElementById('habit-opt-' + tag).classList.toggle('selected', newHabitTags.has(tag));
}

// Freq button click handlers
document.addEventListener('click', e => {
  // Create panel freq
  const fb = e.target.closest('#habitFreqOptions .freq-btn');
  if (fb) {
    document.querySelectorAll('#habitFreqOptions .freq-btn').forEach(b => b.classList.remove('active'));
    fb.classList.add('active');
    const f = fb.dataset.freq;
    document.getElementById('habitCustomDays').style.display = f === 'custom' ? '' : 'none';
    const isQuota = f === 'x_per_week' || f === 'x_per_month';
    document.getElementById('habitFreqCount').style.display = isQuota ? '' : 'none';
    document.getElementById('habitExtrasToggle').style.display = isQuota ? '' : 'none';
    if (f === 'x_per_week') { document.getElementById('habitFreqCountLabel').textContent = 'days per week'; document.getElementById('habitFreqCountInput').max = 7; }
    if (f === 'x_per_month') { document.getElementById('habitFreqCountLabel').textContent = 'days per month'; document.getElementById('habitFreqCountInput').max = 31; }
    return;
  }
  // Create panel custom day toggle
  const cd = e.target.closest('.custom-day');
  if (cd) { cd.classList.toggle('active'); return; }
  // Edit panel freq
  const efb = e.target.closest('#habitEditFreqOptions .freq-btn');
  if (efb) {
    document.querySelectorAll('#habitEditFreqOptions .freq-btn').forEach(b => b.classList.remove('active'));
    efb.classList.add('active');
    const ef = efb.dataset.freq;
    document.getElementById('habitEditCustomDays').style.display = ef === 'custom' ? '' : 'none';
    const isEditQuota = ef === 'x_per_week' || ef === 'x_per_month';
    document.getElementById('habitEditFreqCount').style.display = isEditQuota ? '' : 'none';
    document.getElementById('habitEditExtrasToggle').style.display = isEditQuota ? '' : 'none';
    if (ef === 'x_per_week') { document.getElementById('habitEditFreqCountLabel').textContent = 'days per week'; document.getElementById('habitEditFreqCountInput').max = 7; }
    if (ef === 'x_per_month') { document.getElementById('habitEditFreqCountLabel').textContent = 'days per month'; document.getElementById('habitEditFreqCountInput').max = 31; }
    return;
  }
  // Edit panel custom day toggle
  const ecd = e.target.closest('.custom-day-edit');
  if (ecd) { ecd.classList.toggle('active'); return; }
  // Drill-in freq
  const dfb = e.target.closest('#drillEditFreqOptions .freq-btn');
  if (dfb) {
    document.querySelectorAll('#drillEditFreqOptions .freq-btn').forEach(b => b.classList.remove('active'));
    dfb.classList.add('active');
    const df = dfb.dataset.freq;
    document.getElementById('drillEditCustomDays').style.display = df === 'custom' ? '' : 'none';
    const isDrillQuota = df === 'x_per_week' || df === 'x_per_month';
    document.getElementById('drillEditFreqCount').style.display = isDrillQuota ? '' : 'none';
    document.getElementById('drillEditExtrasToggle').style.display = isDrillQuota ? '' : 'none';
    if (df === 'x_per_week') { document.getElementById('drillEditFreqCountLabel').textContent = 'days per week'; document.getElementById('drillEditFreqCountInput').max = 7; }
    if (df === 'x_per_month') { document.getElementById('drillEditFreqCountLabel').textContent = 'days per month'; document.getElementById('drillEditFreqCountInput').max = 31; }
    return;
  }
  // Drill-in custom day toggle
  const dcd = e.target.closest('.custom-day-drill');
  if (dcd) { dcd.classList.toggle('active'); return; }
});

function addHabit() {
  const name = document.getElementById('habitNameInput').value.trim();
  if (!name) return;
  const emoji = document.getElementById('habitEmojiBtn').textContent;
  const freqBtn = document.querySelector('#habitFreqOptions .freq-btn.active');
  const frequency = freqBtn ? freqBtn.dataset.freq : 'daily';
  let customDays = [];
  let frequencyCount = 0;
  if (frequency === 'custom') {
    document.querySelectorAll('.custom-day.active').forEach(b => customDays.push(b.dataset.day));
  }
  if (frequency === 'x_per_week' || frequency === 'x_per_month') {
    frequencyCount = parseInt(document.getElementById('habitFreqCountInput').value) || 1;
  }
  const allowExtras = (frequency === 'x_per_week' || frequency === 'x_per_month') && document.getElementById('habitAllowExtras').checked;
  const habit = {
    id: Date.now(),
    name, emoji, frequency, frequencyCount, customDays,
    tags: [...newHabitTags],
    archived: false,
    order: habitsArr.length,
    allowExtras,
  };
  habitsArr.push(habit);
  closeHabitCreatePanel();
  renderHabits();
  saveHabitToDB(habit);
}

function openHabitEdit(habitId) {
  const h = habitsArr.find(x => x.id === habitId);
  if (!h) return;
  editingHabitId = habitId;
  document.getElementById('habitEditName').value = h.name;
  document.getElementById('habitEditEmojiBtn').textContent = h.emoji;
  document.getElementById('habitEditEmojiGrid').style.display = 'none';
  // Freq
  document.querySelectorAll('#habitEditFreqOptions .freq-btn').forEach(b => b.classList.toggle('active', b.dataset.freq === h.frequency));
  document.getElementById('habitEditCustomDays').style.display = h.frequency === 'custom' ? '' : 'none';
  document.querySelectorAll('.custom-day-edit').forEach(b => b.classList.toggle('active', (h.customDays || []).includes(b.dataset.day)));
  const isXFreq = h.frequency === 'x_per_week' || h.frequency === 'x_per_month';
  document.getElementById('habitEditFreqCount').style.display = isXFreq ? '' : 'none';
  if (isXFreq) {
    document.getElementById('habitEditFreqCountInput').value = h.frequencyCount || 1;
    document.getElementById('habitEditFreqCountLabel').textContent = h.frequency === 'x_per_week' ? 'days per week' : 'days per month';
    document.getElementById('habitEditFreqCountInput').max = h.frequency === 'x_per_week' ? 7 : 31;
  }
  const isEditQuotaFreq = h.frequency === 'x_per_week' || h.frequency === 'x_per_month';
  document.getElementById('habitEditExtrasToggle').style.display = isEditQuotaFreq ? '' : 'none';
  document.getElementById('habitEditAllowExtras').checked = h.allowExtras || false;
  editHabitTags = new Set(h.tags);
  document.getElementById('habitEditOverlay').classList.add('open');
}
function closeHabitEdit() {
  document.getElementById('habitEditOverlay').classList.remove('open');
  editingHabitId = null;
}
function pickHabitEditEmoji(em) {
  document.getElementById('habitEditEmojiBtn').textContent = em;
  document.getElementById('habitEditEmojiGrid').style.display = 'none';
}
function toggleHabitEditTag(tag) {
  if (editHabitTags.has(tag)) editHabitTags.delete(tag); else editHabitTags.add(tag);
  document.getElementById('habit-edit-opt-' + tag).classList.toggle('selected', editHabitTags.has(tag));
}
function saveHabitEdit() {
  const h = habitsArr.find(x => x.id === editingHabitId);
  if (!h) return;
  h.name = document.getElementById('habitEditName').value.trim() || h.name;
  h.emoji = document.getElementById('habitEditEmojiBtn').textContent;
  const freqBtn = document.querySelector('#habitEditFreqOptions .freq-btn.active');
  h.frequency = freqBtn ? freqBtn.dataset.freq : h.frequency;
  if (h.frequency === 'custom') {
    h.customDays = [];
    document.querySelectorAll('.custom-day-edit.active').forEach(b => h.customDays.push(b.dataset.day));
  }
  if (h.frequency === 'x_per_week' || h.frequency === 'x_per_month') {
    h.frequencyCount = parseInt(document.getElementById('habitEditFreqCountInput').value) || 1;
    h.allowExtras = document.getElementById('habitEditAllowExtras').checked;
  } else {
    h.allowExtras = false;
  }
  h.tags = [...editHabitTags];
  closeHabitEdit();
  renderHabits();
  saveHabitToDB(h);
}
function archiveHabit() {
  const h = habitsArr.find(x => x.id === editingHabitId);
  if (!h) return;
  h.archived = true;
  closeHabitEdit();
  renderHabits();
  saveHabitToDB(h);
}
function confirmDeleteHabit() {
  if (!confirm('Delete this habit and all its data? This cannot be undone.')) return;
  const id = editingHabitId;
  habitsArr = habitsArr.filter(h => h.id !== id);
  closeHabitEdit();
  renderHabits();
  deleteHabitFromDB(id);
}

/* ══════ HABIT DRILL-IN ══════ */
let drillHabitId = null;
let drillCalYear = null;
let drillCalMonth = null;
let drillEditTags = new Set();
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function openHabitDrillIn(habitId, tab) {
  const h = habitsArr.find(x => x.id === habitId);
  if (!h) return;
  drillHabitId = habitId;
  const now = new Date();
  drillCalYear = now.getFullYear();
  drillCalMonth = now.getMonth();
  document.getElementById('drillEmoji').textContent = h.emoji;
  document.getElementById('drillName').textContent = h.name;
  switchDrillTab(tab || 'calendar');
  document.getElementById('habitDrillOverlay').classList.add('open');
  if (!_navFromPop) history.pushState({tool: 'habits', note: null, drill: true}, '');
}

function closeDrillIn() {
  document.getElementById('habitDrillOverlay').classList.remove('open');
  drillHabitId = null;
}

function switchDrillTab(tabName) {
  document.querySelectorAll('.drill-tab').forEach(t => t.classList.toggle('active', t.dataset.drillTab === tabName));
  document.querySelectorAll('.habit-drill-tab-content').forEach(c => c.classList.remove('active'));
  const target = document.getElementById('drillTab' + tabName.charAt(0).toUpperCase() + tabName.slice(1));
  if (target) target.classList.add('active');
  if (tabName === 'calendar') renderDrillCalendar();
  if (tabName === 'stats') renderDrillStats();
  if (tabName === 'edit') populateDrillEdit();
}

function renderDrillCalendar() {
  if (!drillHabitId) return;
  const today = todayStr();
  document.getElementById('drillCalMonth').textContent = MONTH_NAMES[drillCalMonth] + ' ' + drillCalYear;

  const firstDay = new Date(drillCalYear, drillCalMonth, 1);
  const daysInMonth = new Date(drillCalYear, drillCalMonth + 1, 0).getDate();
  let startDow = firstDay.getDay(); // 0=Sun
  startDow = startDow === 0 ? 6 : startDow - 1; // Convert to Mon=0

  let html = '';
  ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].forEach(d => {
    html += `<div class="habit-cal-label">${d}</div>`;
  });

  // Empty cells before first day
  for (let i = 0; i < startDow; i++) {
    html += '<div class="habit-cal-cell empty"></div>';
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${drillCalYear}-${String(drillCalMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const isToday = ds === today;
    const isFuture = ds > today;
    const completed = isCompletedOn(drillHabitId, ds);
    let cls = 'habit-cal-cell';
    if (completed) cls += ' completed';
    if (isToday) cls += ' today';
    if (isFuture) cls += ' future';
    const dataAttr = isFuture ? '' : `data-drill-date="${ds}"`;
    html += `<div class="${cls}" ${dataAttr}>${d}</div>`;
  }

  document.getElementById('drillCalGrid').innerHTML = html;

  // Streaks
  const streak = computeStreak(drillHabitId);
  const best = computeBestStreak(drillHabitId);
  document.getElementById('drillCalStreak').innerHTML = `
    <div class="habit-cal-streak-item"><div class="streak-val" style="color:var(--guava-700)">${streak}</div><div class="streak-lbl">Current Streak</div></div>
    <div class="habit-cal-streak-item"><div class="streak-val" style="color:var(--guava-700)">${best}</div><div class="streak-lbl">Best Streak</div></div>
  `;
}

function drillCalPrev() { drillCalMonth--; if (drillCalMonth < 0) { drillCalMonth = 11; drillCalYear--; } renderDrillCalendar(); }
function drillCalNext() {
  const now = new Date();
  // Don't navigate past current month
  if (drillCalYear === now.getFullYear() && drillCalMonth === now.getMonth()) return;
  drillCalMonth++; if (drillCalMonth > 11) { drillCalMonth = 0; drillCalYear++; } renderDrillCalendar();
}

async function toggleDrillCompletion(dateStr) {
  await toggleCompletion(drillHabitId, dateStr);
  renderDrillCalendar();
  renderDrillStats();
}

function renderDrillStats() {
  if (!drillHabitId) return;
  const h = habitsArr.find(x => x.id === drillHabitId);
  if (!h) return;

  const score = computeScore(h);
  const sColor = scoreColor(score);
  const streak = computeStreak(drillHabitId);
  const best = computeBestStreak(drillHabitId);
  const comps = completionsForHabit(drillHabitId);

  // Time-based counts
  const today = todayStr();
  const weekDates = getWeekDates();
  const weekCount = comps.filter(c => weekDates.includes(c.completedDate)).length;
  const monthStart = today.slice(0, 8) + '01';
  const monthCount = comps.filter(c => c.completedDate >= monthStart && c.completedDate <= today).length;
  const yearStart = today.slice(0, 5) + '01-01';
  const yearCount = comps.filter(c => c.completedDate >= yearStart && c.completedDate <= today).length;
  const allCount = comps.length;

  // Score ring
  const r = 50, cx = 60, cy = 60;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - score / 100);

  document.getElementById('drillStatRing').innerHTML = `
    <svg width="120" height="120" viewBox="0 0 120 120">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--edge)" stroke-width="10"/>
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${sColor}" stroke-width="10"
        stroke-dasharray="${circ.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}" stroke-linecap="round"/>
    </svg>
    <div class="ring-label" style="color:${sColor}">${score}<span class="ring-sub">Habit Score</span></div>
  `;

  document.getElementById('drillStatGrid').innerHTML = `
    <div class="habit-drill-stat-card"><div class="ds-val" style="color:var(--guava-700)">${streak}</div><div class="ds-lbl">Current Streak</div></div>
    <div class="habit-drill-stat-card"><div class="ds-val" style="color:var(--guava-700)">${best}</div><div class="ds-lbl">Best Streak</div></div>
    <div class="habit-drill-stat-card"><div class="ds-val" style="color:var(--guava-700)">${weekCount}</div><div class="ds-lbl">This Week</div></div>
    <div class="habit-drill-stat-card"><div class="ds-val">${monthCount}</div><div class="ds-lbl">This Month</div></div>
    <div class="habit-drill-stat-card"><div class="ds-val">${yearCount}</div><div class="ds-lbl">This Year</div></div>
    <div class="habit-drill-stat-card"><div class="ds-val">${allCount}</div><div class="ds-lbl">All Time</div></div>
  `;
}

function populateDrillEdit() {
  const h = habitsArr.find(x => x.id === drillHabitId);
  if (!h) return;
  document.getElementById('drillEditName').value = h.name;
  document.getElementById('drillEditEmojiBtn').textContent = h.emoji;
  document.getElementById('drillEditEmojiGrid').style.display = 'none';
  document.querySelectorAll('#drillEditFreqOptions .freq-btn').forEach(b => b.classList.toggle('active', b.dataset.freq === h.frequency));
  document.getElementById('drillEditCustomDays').style.display = h.frequency === 'custom' ? '' : 'none';
  document.querySelectorAll('.custom-day-drill').forEach(b => b.classList.toggle('active', (h.customDays || []).includes(b.dataset.day)));
  const isXFreq = h.frequency === 'x_per_week' || h.frequency === 'x_per_month';
  document.getElementById('drillEditFreqCount').style.display = isXFreq ? '' : 'none';
  document.getElementById('drillEditExtrasToggle').style.display = isXFreq ? '' : 'none';
  document.getElementById('drillEditAllowExtras').checked = h.allowExtras || false;
  if (isXFreq) {
    document.getElementById('drillEditFreqCountInput').value = h.frequencyCount || 1;
    document.getElementById('drillEditFreqCountLabel').textContent = h.frequency === 'x_per_week' ? 'days per week' : 'days per month';
    document.getElementById('drillEditFreqCountInput').max = h.frequency === 'x_per_week' ? 7 : 31;
  }
  drillEditTags = new Set(h.tags);
}

function pickDrillEditEmoji(em) {
  document.getElementById('drillEditEmojiBtn').textContent = em;
  document.getElementById('drillEditEmojiGrid').style.display = 'none';
}
function toggleDrillEditTag(tag) {
  if (drillEditTags.has(tag)) drillEditTags.delete(tag); else drillEditTags.add(tag);
  document.getElementById('drill-edit-opt-' + tag).classList.toggle('selected', drillEditTags.has(tag));
}

function saveHabitDrill() {
  const h = habitsArr.find(x => x.id === drillHabitId);
  if (!h) return;
  h.name = document.getElementById('drillEditName').value.trim() || h.name;
  h.emoji = document.getElementById('drillEditEmojiBtn').textContent;
  const freqBtn = document.querySelector('#drillEditFreqOptions .freq-btn.active');
  h.frequency = freqBtn ? freqBtn.dataset.freq : h.frequency;
  if (h.frequency === 'custom') {
    h.customDays = [];
    document.querySelectorAll('.custom-day-drill.active').forEach(b => h.customDays.push(b.dataset.day));
  }
  if (h.frequency === 'x_per_week' || h.frequency === 'x_per_month') {
    h.frequencyCount = parseInt(document.getElementById('drillEditFreqCountInput').value) || 1;
    h.allowExtras = document.getElementById('drillEditAllowExtras').checked;
  } else {
    h.allowExtras = false;
  }
  h.tags = [...drillEditTags];
  closeDrillIn();
  renderHabits();
  saveHabitToDB(h);
}

function archiveHabitDrill() {
  const h = habitsArr.find(x => x.id === drillHabitId);
  if (!h) return;
  h.archived = true;
  closeDrillIn();
  renderHabits();
  saveHabitToDB(h);
}

function confirmDeleteHabitDrill() {
  if (!confirm('Delete this habit and all its data? This cannot be undone.')) return;
  const id = drillHabitId;
  habitsArr = habitsArr.filter(h => h.id !== id);
  closeDrillIn();
  renderHabits();
  deleteHabitFromDB(id);
}

// Escape to close drill-in
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.getElementById('habitDrillOverlay').classList.contains('open')) {
    closeDrillIn();
  }
});

/* ── HABIT CREATE PANEL HANDLERS ── */
document.getElementById('habitCreatePanel').addEventListener('click', function(e) {
  if (e.target === this) closeHabitCreatePanel();
});
document.getElementById('habitEmojiBtn').addEventListener('click', () => {
  const g = document.getElementById('habitEmojiGrid');
  g.style.display = g.style.display === 'grid' ? 'none' : 'grid';
});
document.getElementById('habitNameInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') addHabit();
  else if (e.key === 'Escape') closeHabitCreatePanel();
});
document.getElementById('habitCreateCancelBtn').addEventListener('click', closeHabitCreatePanel);
document.getElementById('habitCreateAddBtn').addEventListener('click', addHabit);

/* ── HABIT EDIT OVERLAY HANDLERS ── */
document.getElementById('habitEditOverlay').addEventListener('click', function(e) {
  if (e.target === this) closeHabitEdit();
});
document.getElementById('habitEditEmojiBtn').addEventListener('click', () => {
  const g = document.getElementById('habitEditEmojiGrid');
  g.style.display = g.style.display === 'grid' ? 'none' : 'grid';
});
document.getElementById('habitEditName').addEventListener('keydown', e => {
  if (e.key === 'Enter') saveHabitEdit();
});
document.getElementById('habitEditArchiveBtn').addEventListener('click', archiveHabit);
document.getElementById('habitEditDeleteBtn').addEventListener('click', confirmDeleteHabit);
document.getElementById('habitEditCancelBtn').addEventListener('click', closeHabitEdit);
document.getElementById('habitEditSaveBtn').addEventListener('click', saveHabitEdit);

/* ── HABIT DRILL-IN HANDLERS ── */
document.getElementById('habitDrillOverlay').addEventListener('click', function(e) {
  if (e.target === this) closeDrillIn();
});
document.getElementById('habitDrillBackBtn').addEventListener('click', closeDrillIn);
document.querySelectorAll('.habit-drill-tabs [data-drill-tab]').forEach(btn => {
  btn.addEventListener('click', () => switchDrillTab(btn.dataset.drillTab));
});
document.getElementById('drillCalPrevBtn').addEventListener('click', drillCalPrev);
document.getElementById('drillCalNextBtn').addEventListener('click', drillCalNext);
document.getElementById('drillEditEmojiBtn').addEventListener('click', () => {
  const g = document.getElementById('drillEditEmojiGrid');
  g.style.display = g.style.display === 'grid' ? 'none' : 'grid';
});
document.getElementById('drillEditName').addEventListener('keydown', e => {
  if (e.key === 'Enter') saveHabitDrill();
});
document.getElementById('drillEditArchiveBtn').addEventListener('click', archiveHabitDrill);
document.getElementById('drillEditDeleteBtn').addEventListener('click', confirmDeleteHabitDrill);
document.getElementById('drillEditSaveBtn').addEventListener('click', saveHabitDrill);

/* ── DRILL CALENDAR DELEGATION ── */
document.getElementById('drillCalGrid').addEventListener('click', e => {
  const cell = e.target.closest('.habit-cal-cell[data-drill-date]');
  if (cell) toggleDrillCompletion(cell.dataset.drillDate);
});

/* ── EMOJI GRIDS (delegation on each grid, buttons carry data-emoji) ── */
const _emojiPickers = {
  create: pickHabitEmoji,
  edit:   pickHabitEditEmoji,
  drill:  pickDrillEditEmoji,
};
['habitEmojiGrid', 'habitEditEmojiGrid', 'drillEditEmojiGrid'].forEach(gridId => {
  document.getElementById(gridId).addEventListener('click', e => {
    const btn = e.target.closest('button[data-emoji]');
    if (!btn) return;
    const fn = _emojiPickers[btn.dataset.emojiTarget];
    if (fn) fn(btn.dataset.emoji);
  });
});

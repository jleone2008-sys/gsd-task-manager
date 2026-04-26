/* ══════════════════════════════════════════════════════════════
   JOURNAL — beta-only
   Daily entries with calendar nav, auto-prefill (Google Calendar
   events + completed tasks), photo upload (resized + base64),
   reflections textarea, and 5-emoji mood picker.
   Auto-saves on change with debounce.
═══════════════════════════════════════════════════════════════ */

const journalState = {
  selectedDate: null,                // 'YYYY-MM-DD'
  viewMonth: null,                   // {year, month}  month is 0-indexed
  entries: new Map(),                // dateStr -> entry row
  monthsLoaded: new Set(),           // 'YYYY-MM' keys we've fetched dates for
  calendarEvents: new Map(),         // dateStr -> [{summary,start,isAllDay}]
  saveTimer: null,
  saveStatus: 'idle'                 // idle | saving | saved | error
};

const MOOD_EMOJI = ['🤩', '😊', '😐', '😔', '😢'];

function jToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function jParseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m-1, d);
}

function jFormatLong(s) {
  const d = jParseDate(s);
  return d.toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric', year:'numeric' });
}

function jFormatShort(s) {
  const d = jParseDate(s);
  return d.toLocaleDateString(undefined, { month:'short', day:'numeric', year:'numeric' });
}

function jMonthKey(y, m) { return `${y}-${String(m+1).padStart(2,'0')}`; }

/* ── DATA LAYER ───────────────────────────────────────────── */

async function loadJournalMonth(year, month) {
  const key = jMonthKey(year, month);
  if (journalState.monthsLoaded.has(key)) return;
  const start = `${year}-${String(month+1).padStart(2,'0')}-01`;
  const lastDay = new Date(year, month+1, 0).getDate();
  const end = `${year}-${String(month+1).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;
  try {
    const { data, error } = await db.from('journal_entries')
      .select('entry_date, reflections, mood, photos, updated_at')
      .gte('entry_date', start).lte('entry_date', end);
    if (error) throw error;
    (data || []).forEach(row => journalState.entries.set(row.entry_date, row));
    journalState.monthsLoaded.add(key);
  } catch (e) {
    console.warn('[journal] loadMonth failed', e);
  }
}

async function loadJournalEntry(dateStr) {
  if (journalState.entries.has(dateStr)) return journalState.entries.get(dateStr);
  try {
    const { data, error } = await db.from('journal_entries')
      .select('entry_date, reflections, mood, photos, updated_at')
      .eq('entry_date', dateStr).maybeSingle();
    if (error) throw error;
    if (data) journalState.entries.set(dateStr, data);
    return data || null;
  } catch (e) {
    console.warn('[journal] loadEntry failed', e);
    return null;
  }
}

async function saveJournalEntry(dateStr, patch) {
  const existing = journalState.entries.get(dateStr) || { entry_date: dateStr, reflections: '', mood: null, photos: [] };
  const merged = { ...existing, ...patch };
  journalState.entries.set(dateStr, merged);
  journalState.saveStatus = 'saving';
  updateSaveIndicator();
  try {
    const { data: { session } } = await db.auth.getSession();
    if (!session) throw new Error('No session');
    const row = {
      user_id: session.user.id,
      entry_date: dateStr,
      reflections: merged.reflections || null,
      mood: merged.mood ?? null,
      photos: merged.photos || [],
      updated_at: new Date().toISOString()
    };
    const { error } = await db.from('journal_entries').upsert(row, { onConflict: 'user_id,entry_date' });
    if (error) throw error;
    journalState.saveStatus = 'saved';
  } catch (e) {
    console.error('[journal] save failed', e);
    journalState.saveStatus = 'error';
  }
  updateSaveIndicator();
}

function scheduleSave(dateStr, patch) {
  clearTimeout(journalState.saveTimer);
  journalState.saveTimer = setTimeout(() => saveJournalEntry(dateStr, patch), 900);
  journalState.saveStatus = 'saving';
  updateSaveIndicator();
}

function getCompletedTasksForDate(dateStr) {
  if (typeof tasks === 'undefined' || !Array.isArray(tasks)) return [];
  return tasks.filter(t => {
    if (!t.done || !t.completedAt) return false;
    const c = new Date(t.completedAt);
    const local = `${c.getFullYear()}-${String(c.getMonth()+1).padStart(2,'0')}-${String(c.getDate()).padStart(2,'0')}`;
    return local === dateStr;
  });
}

async function fetchCalendarEventsForDate(dateStr) {
  if (journalState.calendarEvents.has(dateStr)) return journalState.calendarEvents.get(dateStr);
  try {
    const { data: { session } } = await db.auth.getSession();
    const token = session?.provider_token;
    if (!token) { journalState.calendarEvents.set(dateStr, []); return []; }
    const startISO = new Date(dateStr + 'T00:00:00').toISOString();
    const endISO = new Date(dateStr + 'T23:59:59').toISOString();
    const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events`
      + `?timeMin=${encodeURIComponent(startISO)}&timeMax=${encodeURIComponent(endISO)}`
      + `&singleEvents=true&orderBy=startTime`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) { journalState.calendarEvents.set(dateStr, []); return []; }
    const data = await res.json();
    const events = (data.items || []).map(e => ({
      summary: e.summary || '(no title)',
      start: e.start?.dateTime || e.start?.date || '',
      isAllDay: !!e.start?.date && !e.start?.dateTime
    }));
    journalState.calendarEvents.set(dateStr, events);
    return events;
  } catch (e) {
    console.warn('[journal] calendar fetch failed', e);
    journalState.calendarEvents.set(dateStr, []);
    return [];
  }
}

/* ── IMAGE RESIZE ─────────────────────────────────────────── */

async function resizeImageFile(file, maxDim = 1600, quality = 0.85) {
  const dataUrl = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = dataUrl;
  });
  let { width, height } = img;
  if (width > maxDim || height > maxDim) {
    const ratio = Math.min(maxDim / width, maxDim / height);
    width = Math.round(width * ratio); height = Math.round(height * ratio);
  }
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  canvas.getContext('2d').drawImage(img, 0, 0, width, height);
  return canvas.toDataURL('image/jpeg', quality);
}

/* ── STYLES ───────────────────────────────────────────────── */

function ensureJournalStyles() {
  if (document.getElementById('journalStyles')) return;
  const style = document.createElement('style');
  style.id = 'journalStyles';
  style.textContent = `
    .content[data-tool-view="journal"] { max-width: none; padding: 0; }
    .j-shell { display: grid; grid-template-columns: 280px 1fr; gap: 24px; max-width: 1100px; margin: 0 auto; padding: 24px 24px 80px; }
    .j-side { display: flex; flex-direction: column; gap: 16px; }
    .j-cal { background: var(--surface); border: 1px solid var(--edge); border-radius: var(--r-lg); padding: 12px; box-shadow: var(--shadow-card); }
    .j-cal-head { display: flex; align-items: center; justify-content: space-between; padding: 0 4px 8px; }
    .j-cal-month { font-size: 13px; font-weight: 600; color: var(--ink); }
    .j-cal-nav { background: none; border: none; padding: 4px 8px; cursor: pointer; color: var(--ink-3); border-radius: var(--r-sm); }
    .j-cal-nav:hover { background: var(--surface-2); color: var(--ink); }
    .j-cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; }
    .j-cal-dow { font-size: 9px; font-weight: 600; color: var(--ink-4); text-align: center; padding: 4px 0; letter-spacing: 0.05em; }
    .j-cal-cell { position: relative; aspect-ratio: 1/1; border: none; background: none; font-family: inherit; font-size: 12px; color: var(--ink-2); border-radius: var(--r-sm); cursor: pointer; padding: 0; display: flex; align-items: center; justify-content: center; }
    .j-cal-cell:hover { background: var(--surface-2); }
    .j-cal-cell.is-today { font-weight: 700; color: var(--guava-700); }
    .j-cal-cell.is-selected { background: var(--guava-700); color: #fff; font-weight: 600; }
    .j-cal-cell.has-entry::after { content: ''; position: absolute; bottom: 4px; left: 50%; transform: translateX(-50%); width: 4px; height: 4px; border-radius: 50%; background: var(--guava-500); }
    .j-cal-cell.is-selected.has-entry::after { background: #fff; }
    .j-cal-cell.is-other { color: var(--ink-5); }
    .j-list { background: var(--surface); border: 1px solid var(--edge); border-radius: var(--r-lg); padding: 6px; box-shadow: var(--shadow-card); max-height: 380px; overflow-y: auto; }
    .j-list-empty { padding: 16px 12px; font-size: 11.5px; color: var(--ink-4); text-align: center; }
    .j-list-item { width: 100%; text-align: left; background: none; border: none; padding: 8px 12px; font-family: inherit; font-size: 12px; color: var(--ink-2); cursor: pointer; border-radius: var(--r-sm); }
    .j-list-item:hover { background: var(--surface-2); }
    .j-list-item.is-active { background: var(--guava-100); color: var(--guava-900); font-weight: 600; }
    .j-main { background: var(--surface); border: 1px solid var(--edge); border-radius: var(--r-lg); padding: 28px 32px 32px; box-shadow: var(--shadow-card); min-width: 0; }
    .j-date-row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid var(--edge); }
    .j-date-h { font-size: 22px; font-weight: 600; color: var(--ink); letter-spacing: -0.02em; }
    .j-save-ind { font-size: 11px; color: var(--ink-4); }
    .j-save-ind.saved { color: var(--moss-fg); }
    .j-save-ind.error { color: var(--guava-700); }
    .j-section { margin-bottom: 22px; }
    .j-section-h { font-size: 10px; font-weight: 700; color: var(--ink-4); letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 8px; }
    .j-list-row { display: flex; gap: 8px; padding: 6px 0; font-size: 13px; color: var(--ink-2); line-height: 1.5; }
    .j-list-row .j-bullet { color: var(--guava-500); flex-shrink: 0; }
    .j-list-row .j-check { color: var(--moss-fg); flex-shrink: 0; font-weight: 700; }
    .j-empty { font-size: 12px; color: var(--ink-4); font-style: italic; padding: 4px 0; }
    .j-photos { display: flex; flex-wrap: wrap; gap: 10px; }
    .j-photo { position: relative; width: 88px; height: 88px; border-radius: var(--r-md); overflow: hidden; background: var(--surface-2); border: 1px solid var(--edge); }
    .j-photo img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .j-photo-del { position: absolute; top: 4px; right: 4px; background: rgba(0,0,0,0.6); border: none; color: #fff; width: 20px; height: 20px; border-radius: 50%; font-size: 11px; cursor: pointer; line-height: 1; padding: 0; display: flex; align-items: center; justify-content: center; }
    .j-photo-del:hover { background: rgba(0,0,0,0.85); }
    .j-photo-add { width: 88px; height: 88px; border: 1.5px dashed var(--edge-strong); border-radius: var(--r-md); background: none; cursor: pointer; color: var(--ink-3); display: flex; align-items: center; justify-content: center; font-size: 22px; font-weight: 300; }
    .j-photo-add:hover { border-color: var(--guava-500); color: var(--guava-700); background: var(--guava-50); }
    .j-textarea { width: 100%; min-height: 120px; padding: 12px 14px; border: 1px solid var(--edge-strong); border-radius: var(--r-md); background: var(--surface); font-family: inherit; font-size: 13px; line-height: 1.6; color: var(--ink); resize: vertical; outline: none; box-sizing: border-box; }
    .j-textarea:focus { border-color: var(--guava-500); box-shadow: var(--shadow-focus); }
    .j-mood { display: flex; gap: 8px; }
    .j-mood-btn { width: 44px; height: 44px; border-radius: 50%; background: var(--surface-2); border: 1.5px solid transparent; cursor: pointer; font-size: 22px; padding: 0; display: flex; align-items: center; justify-content: center; transition: transform 0.1s; }
    .j-mood-btn:hover { transform: scale(1.08); }
    .j-mood-btn.is-selected { border-color: var(--guava-700); background: var(--guava-50); }
    @media (max-width: 900px) {
      .j-shell { grid-template-columns: 1fr; padding: 16px 14px 80px; gap: 16px; }
      .j-side { display: contents; }
      .j-cal { order: 1; }
      .j-list { order: 2; max-height: 220px; }
      .j-main { order: 3; padding: 22px 18px; }
      .j-date-h { font-size: 18px; }
    }
  `;
  document.head.appendChild(style);
}

/* ── CALENDAR RENDER ──────────────────────────────────────── */

function renderJournalCalendar() {
  const { year, month } = journalState.viewMonth;
  const monthName = new Date(year, month, 1).toLocaleDateString(undefined, { month:'long', year:'numeric' });
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month+1, 0).getDate();
  const today = jToday();

  const cells = [];
  for (let i = 0; i < firstDay; i++) cells.push({ blank: true });
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    cells.push({ d, ds, isToday: ds === today, isSelected: ds === journalState.selectedDate, hasEntry: journalState.entries.has(ds) });
  }

  const dowRow = ['S','M','T','W','T','F','S'].map(l => `<div class="j-cal-dow">${l}</div>`).join('');
  const cellsHtml = cells.map(c => {
    if (c.blank) return `<div class="j-cal-cell is-other"></div>`;
    const cls = ['j-cal-cell'];
    if (c.isToday) cls.push('is-today');
    if (c.isSelected) cls.push('is-selected');
    if (c.hasEntry) cls.push('has-entry');
    return `<button class="${cls.join(' ')}" data-jcal-date="${c.ds}">${c.d}</button>`;
  }).join('');

  return `
    <div class="j-cal">
      <div class="j-cal-head">
        <button class="j-cal-nav" data-jcal-nav="-1" title="Previous month">‹</button>
        <div class="j-cal-month">${monthName}</div>
        <button class="j-cal-nav" data-jcal-nav="1" title="Next month">›</button>
      </div>
      <div class="j-cal-grid">${dowRow}${cellsHtml}</div>
    </div>`;
}

function renderJournalList() {
  const items = [...journalState.entries.values()]
    .sort((a, b) => b.entry_date.localeCompare(a.entry_date))
    .slice(0, 30);
  if (!items.length) {
    return `<div class="j-list"><div class="j-list-empty">No entries yet — pick a date and start writing.</div></div>`;
  }
  const rows = items.map(e => {
    const cls = e.entry_date === journalState.selectedDate ? 'j-list-item is-active' : 'j-list-item';
    return `<button class="${cls}" data-jlist-date="${e.entry_date}">${jFormatShort(e.entry_date)}</button>`;
  }).join('');
  return `<div class="j-list">${rows}</div>`;
}

/* ── EDITOR RENDER ────────────────────────────────────────── */

async function renderJournalEditor() {
  const ds = journalState.selectedDate;
  const entry = journalState.entries.get(ds) || { reflections: '', mood: null, photos: [] };
  const tasksDone = getCompletedTasksForDate(ds);
  const events = await fetchCalendarEventsForDate(ds);

  const eventsHtml = events.length ? events.map(ev => {
    const time = ev.isAllDay ? 'All day' : new Date(ev.start).toLocaleTimeString(undefined, { hour:'numeric', minute:'2-digit' });
    return `<div class="j-list-row"><span class="j-bullet">•</span><span>${escapeHtml(ev.summary)} · ${time}</span></div>`;
  }).join('') : `<div class="j-empty">No calendar events.</div>`;

  const tasksHtml = tasksDone.length ? tasksDone.map(t =>
    `<div class="j-list-row"><span class="j-check">✓</span><span>${escapeHtml(t.text)}</span></div>`
  ).join('') : `<div class="j-empty">No tasks completed on this day.</div>`;

  const photosHtml = (entry.photos || []).map((src, i) =>
    `<div class="j-photo"><img src="${src}" alt="" /><button class="j-photo-del" data-jphoto-del="${i}" title="Remove">×</button></div>`
  ).join('');

  const moodHtml = MOOD_EMOJI.map((emoji, i) => {
    const sel = entry.mood === (i+1) ? ' is-selected' : '';
    return `<button class="j-mood-btn${sel}" data-jmood="${i+1}">${emoji}</button>`;
  }).join('');

  return `
    <div class="j-main">
      <div class="j-date-row">
        <div class="j-date-h">${jFormatLong(ds)}</div>
        <div class="j-save-ind" id="jSaveInd"></div>
      </div>

      <div class="j-section">
        <div class="j-section-h">What happened today</div>
        ${eventsHtml}
      </div>

      <div class="j-section">
        <div class="j-section-h">What you finished</div>
        ${tasksHtml}
      </div>

      <div class="j-section">
        <div class="j-section-h">Photos</div>
        <div class="j-photos">
          ${photosHtml}
          <button class="j-photo-add" id="jPhotoAdd" title="Add photo">+</button>
          <input type="file" id="jPhotoInput" accept="image/*" multiple style="display:none" />
        </div>
      </div>

      <div class="j-section">
        <div class="j-section-h">Reflections</div>
        <textarea class="j-textarea" id="jReflections" placeholder="How did today go? What's on your mind?">${escapeHtml(entry.reflections || '')}</textarea>
      </div>

      <div class="j-section">
        <div class="j-section-h">Mood</div>
        <div class="j-mood">${moodHtml}</div>
      </div>
    </div>`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function updateSaveIndicator() {
  const el = document.getElementById('jSaveInd');
  if (!el) return;
  el.classList.remove('saved', 'error');
  if (journalState.saveStatus === 'saving') { el.textContent = 'Saving…'; }
  else if (journalState.saveStatus === 'saved') { el.textContent = 'Saved'; el.classList.add('saved'); }
  else if (journalState.saveStatus === 'error') { el.textContent = 'Save failed'; el.classList.add('error'); }
  else { el.textContent = ''; }
}

/* ── MAIN RENDER ──────────────────────────────────────────── */

async function renderJournal() {
  ensureJournalStyles();
  const root = document.getElementById('journalContainer');
  if (!root) return;

  if (!journalState.selectedDate) journalState.selectedDate = jToday();
  if (!journalState.viewMonth) {
    const d = jParseDate(journalState.selectedDate);
    journalState.viewMonth = { year: d.getFullYear(), month: d.getMonth() };
  }

  await loadJournalMonth(journalState.viewMonth.year, journalState.viewMonth.month);
  await loadJournalEntry(journalState.selectedDate);

  root.innerHTML = `
    <div class="j-shell">
      <div class="j-side">
        ${renderJournalCalendar()}
        ${renderJournalList()}
      </div>
      <div id="jMainSlot"></div>
    </div>`;

  const main = await renderJournalEditor();
  document.getElementById('jMainSlot').outerHTML = main;
}

async function rerenderJournalEditorOnly() {
  const slot = document.querySelector('.j-main');
  if (!slot) return;
  const html = await renderJournalEditor();
  slot.outerHTML = html;
}

function rerenderJournalSidebar() {
  const cal = document.querySelector('.j-cal');
  const list = document.querySelector('.j-list');
  if (cal) cal.outerHTML = renderJournalCalendar();
  if (list) list.outerHTML = renderJournalList();
}

/* ── EVENT HANDLERS ───────────────────────────────────────── */

document.addEventListener('click', async e => {
  const dateBtn = e.target.closest('[data-jcal-date]');
  if (dateBtn) {
    journalState.selectedDate = dateBtn.dataset.jcalDate;
    await loadJournalEntry(journalState.selectedDate);
    rerenderJournalSidebar();
    await rerenderJournalEditorOnly();
    return;
  }
  const navBtn = e.target.closest('[data-jcal-nav]');
  if (navBtn) {
    const delta = parseInt(navBtn.dataset.jcalNav, 10);
    let { year, month } = journalState.viewMonth;
    month += delta;
    if (month < 0) { month = 11; year--; }
    if (month > 11) { month = 0; year++; }
    journalState.viewMonth = { year, month };
    await loadJournalMonth(year, month);
    rerenderJournalSidebar();
    return;
  }
  const listBtn = e.target.closest('[data-jlist-date]');
  if (listBtn) {
    journalState.selectedDate = listBtn.dataset.jlistDate;
    const d = jParseDate(journalState.selectedDate);
    if (d.getFullYear() !== journalState.viewMonth.year || d.getMonth() !== journalState.viewMonth.month) {
      journalState.viewMonth = { year: d.getFullYear(), month: d.getMonth() };
      await loadJournalMonth(journalState.viewMonth.year, journalState.viewMonth.month);
    }
    await loadJournalEntry(journalState.selectedDate);
    rerenderJournalSidebar();
    await rerenderJournalEditorOnly();
    return;
  }
  if (e.target.closest('#jPhotoAdd')) {
    document.getElementById('jPhotoInput')?.click();
    return;
  }
  const photoDel = e.target.closest('[data-jphoto-del]');
  if (photoDel) {
    const idx = parseInt(photoDel.dataset.jphotoDel, 10);
    const ds = journalState.selectedDate;
    const entry = journalState.entries.get(ds) || { reflections:'', mood:null, photos:[] };
    const photos = [...(entry.photos || [])];
    photos.splice(idx, 1);
    journalState.entries.set(ds, { ...entry, photos });
    await rerenderJournalEditorOnly();
    saveJournalEntry(ds, { photos });
    return;
  }
  const moodBtn = e.target.closest('[data-jmood]');
  if (moodBtn) {
    const m = parseInt(moodBtn.dataset.jmood, 10);
    const ds = journalState.selectedDate;
    const entry = journalState.entries.get(ds) || { reflections:'', mood:null, photos:[] };
    const newMood = entry.mood === m ? null : m;
    journalState.entries.set(ds, { ...entry, mood: newMood });
    document.querySelectorAll('.j-mood-btn').forEach(b => {
      b.classList.toggle('is-selected', parseInt(b.dataset.jmood, 10) === newMood);
    });
    saveJournalEntry(ds, { mood: newMood });
    return;
  }
});

document.addEventListener('change', async e => {
  if (e.target.id === 'jPhotoInput') {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    const ds = journalState.selectedDate;
    const entry = journalState.entries.get(ds) || { reflections:'', mood:null, photos:[] };
    const photos = [...(entry.photos || [])];
    journalState.saveStatus = 'saving';
    updateSaveIndicator();
    for (const f of files) {
      try { photos.push(await resizeImageFile(f)); }
      catch (err) { console.warn('[journal] image resize failed', err); }
    }
    journalState.entries.set(ds, { ...entry, photos });
    e.target.value = '';
    await rerenderJournalEditorOnly();
    saveJournalEntry(ds, { photos });
  }
});

document.addEventListener('input', e => {
  if (e.target.id === 'jReflections') {
    const ds = journalState.selectedDate;
    const entry = journalState.entries.get(ds) || { reflections:'', mood:null, photos:[] };
    journalState.entries.set(ds, { ...entry, reflections: e.target.value });
    scheduleSave(ds, { reflections: e.target.value });
  }
});

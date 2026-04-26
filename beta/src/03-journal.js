/* ══════════════════════════════════════════════════════════════
   JOURNAL — beta-only
   Daily entries with calendar popover, read & edit modes,
   personalized empty-state greeting, photo upload (resized + base64),
   auto-fetch & cache of Google Calendar events, completed tasks
   prefill, mood picker, and full-text search.
   Auto-saves on change with debounce.
═══════════════════════════════════════════════════════════════ */

const journalState = {
  selectedDate: null,                // 'YYYY-MM-DD'
  viewMonth: null,                   // {year, month}  month is 0-indexed
  entries: new Map(),                // dateStr -> entry row
  monthsLoaded: new Set(),           // 'YYYY-MM' keys we've fetched dates for
  calendarEvents: new Map(),         // dateStr -> [{summary,start,isAllDay}]
  eventsError: new Map(),            // dateStr -> error code/string ('expired','api','none')
  historySynced: false,              // whether we've done the initial bulk calendar sync this session
  editMode: false,                   // false = read view, true = edit form
  calendarOpen: false,               // calendar popover visibility
  saveTimer: null,
  saveStatus: 'idle',                // idle | saving | saved | error
  searchQuery: '',
  searchResults: null
};

const MOOD_EMOJI = ['🤩', '😊', '😐', '😔', '😢'];
const MOOD_LABEL = ['Great', 'Good', 'Okay', 'Down', 'Hard'];

/* ── DATE HELPERS ─────────────────────────────────────────── */

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

function jIsToday(s) { return s === jToday(); }
function jIsPast(s) { return s < jToday(); }
function jIsFuture(s) { return s > jToday(); }

/* ── PERSONALIZATION ──────────────────────────────────────── */

function getFirstName() {
  const meta = (typeof currentUser !== 'undefined' && currentUser?.user_metadata) || {};
  if (meta.given_name) return meta.given_name;
  if (meta.full_name) return String(meta.full_name).trim().split(/\s+/)[0];
  if (meta.name) return String(meta.name).trim().split(/\s+/)[0];
  return '';
}

function getTimeBasedGreeting(name) {
  const hour = new Date().getHours();
  const n = name || 'there';
  if (hour < 5)  return `Hey ${n}, how's the day going?`;
  if (hour < 12) return `Good morning, ${n} — how's your day starting?`;
  if (hour < 17) return `Hey ${n}, how's the day going?`;
  if (hour < 21) return `Evening, ${n} — how was today?`;
  return `Winding down, ${n}? Reflect on today before bed.`;
}

function getEmptyStatePrompt(dateStr) {
  const name = getFirstName();
  if (jIsToday(dateStr)) return getTimeBasedGreeting(name);
  if (jIsPast(dateStr)) {
    const n = name || 'you';
    return `No entry for ${jFormatShort(dateStr)} yet. ${n.charAt(0).toUpperCase() + n.slice(1)} can capture it now if it still feels worth it.`;
  }
  return `${name ? name + ', this' : 'This'} day is still ahead. Anything you're looking forward to?`;
}

/* ── DATA: ENTRIES ────────────────────────────────────────── */

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

/* ── DATA: CALENDAR EVENTS (cache + live) ─────────────────── */

const CALENDAR_CACHE_FRESH_MS = 5 * 60 * 1000;

async function readCalendarCache(dateStr) {
  try {
    const { data, error } = await db.from('journal_calendar_cache')
      .select('events, last_synced').eq('entry_date', dateStr).maybeSingle();
    if (error) return null;
    return data || null;
  } catch (e) { return null; }
}

async function writeCalendarCache(rows) {
  if (!rows.length) return;
  try {
    await db.from('journal_calendar_cache').upsert(rows, { onConflict: 'user_id,entry_date' });
  } catch (e) { console.warn('[journal] cache write failed', e); }
}

async function fetchLiveCalendarEvents(dateStr) {
  const { data: { session } } = await db.auth.getSession();
  const token = session?.provider_token;
  if (!token) {
    journalState.eventsError.set(dateStr, 'expired');
    return null;
  }
  const startISO = new Date(dateStr + 'T00:00:00').toISOString();
  const endISO   = new Date(dateStr + 'T23:59:59').toISOString();
  const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events`
    + `?timeMin=${encodeURIComponent(startISO)}&timeMax=${encodeURIComponent(endISO)}`
    + `&singleEvents=true&orderBy=startTime`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401 || res.status === 403) {
      journalState.eventsError.set(dateStr, 'expired');
      return null;
    }
    if (!res.ok) {
      journalState.eventsError.set(dateStr, 'api');
      return null;
    }
    const data = await res.json();
    const events = (data.items || []).map(e => ({
      summary: e.summary || '(no title)',
      start: e.start?.dateTime || e.start?.date || '',
      isAllDay: !!e.start?.date && !e.start?.dateTime
    }));
    journalState.eventsError.delete(dateStr);
    return events;
  } catch (e) {
    console.warn('[journal] live fetch failed', e);
    journalState.eventsError.set(dateStr, 'api');
    return null;
  }
}

async function fetchCalendarEventsForDate(dateStr) {
  if (journalState.calendarEvents.has(dateStr) && jIsPast(dateStr)) {
    return journalState.calendarEvents.get(dateStr);
  }

  const cached = await readCalendarCache(dateStr);
  const isPast = jIsPast(dateStr);
  const isFresh = cached && (Date.now() - new Date(cached.last_synced).getTime() < CALENDAR_CACHE_FRESH_MS);

  if (cached && (isPast || isFresh)) {
    journalState.calendarEvents.set(dateStr, cached.events || []);
    journalState.eventsError.delete(dateStr);
    return cached.events || [];
  }

  const live = await fetchLiveCalendarEvents(dateStr);
  if (live === null) {
    if (cached) {
      journalState.calendarEvents.set(dateStr, cached.events || []);
      return cached.events || [];
    }
    journalState.calendarEvents.set(dateStr, []);
    return [];
  }
  journalState.calendarEvents.set(dateStr, live);

  try {
    const { data: { session } } = await db.auth.getSession();
    if (session) {
      writeCalendarCache([{ user_id: session.user.id, entry_date: dateStr, events: live, last_synced: new Date().toISOString() }]);
    }
  } catch (_) {}
  return live;
}

async function syncCalendarHistory() {
  if (journalState.historySynced) return;
  journalState.historySynced = true;

  try {
    const { data: { session } } = await db.auth.getSession();
    const token = session?.provider_token;
    if (!token) return;

    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    const signupAt = currentUser?.created_at ? new Date(currentUser.created_at) : oneYearAgo;
    const start = signupAt > oneYearAgo ? signupAt : oneYearAgo;
    const end = new Date();
    end.setDate(end.getDate() + 30);

    const allEvents = [];
    let pageToken = '';
    let pages = 0;
    do {
      const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
      url.searchParams.set('timeMin', start.toISOString());
      url.searchParams.set('timeMax', end.toISOString());
      url.searchParams.set('singleEvents', 'true');
      url.searchParams.set('orderBy', 'startTime');
      url.searchParams.set('maxResults', '250');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return;
      const data = await res.json();
      allEvents.push(...(data.items || []));
      pageToken = data.nextPageToken || '';
      pages++;
    } while (pageToken && pages < 12);

    const byDate = {};
    for (const ev of allEvents) {
      const startStr = ev.start?.dateTime || ev.start?.date || '';
      const dateKey = startStr.slice(0, 10);
      if (!dateKey) continue;
      if (!byDate[dateKey]) byDate[dateKey] = [];
      byDate[dateKey].push({
        summary: ev.summary || '(no title)',
        start: startStr,
        isAllDay: !!ev.start?.date && !ev.start?.dateTime
      });
    }

    const userId = session.user.id;
    const rows = Object.entries(byDate).map(([date, events]) => ({
      user_id: userId, entry_date: date, events, last_synced: new Date().toISOString()
    }));
    if (rows.length) await writeCalendarCache(rows);
    for (const [date, events] of Object.entries(byDate)) {
      journalState.calendarEvents.set(date, events);
    }
    if (journalState.selectedDate && document.querySelector('.j-shell')) {
      rerenderJournalBody();
    }
  } catch (e) {
    console.warn('[journal] history sync failed', e);
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
    .j-shell { max-width: 760px; margin: 0; padding: 28px 25px 80px; position: relative; }
    .j-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
    .j-date-h { font-size: 24px; font-weight: 600; color: var(--ink); letter-spacing: -0.02em; line-height: 1.2; }
    .j-date-sub { font-size: 12px; color: var(--ink-4); margin-top: 2px; }
    .j-actions { display: flex; gap: 6px; }
    .j-action-btn { width: 36px; height: 36px; border-radius: var(--r-md); border: 1px solid var(--edge); background: var(--surface); color: var(--ink-2); cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 0; transition: background 0.12s; }
    .j-action-btn:hover { background: var(--surface-2); color: var(--ink); }
    .j-action-btn.is-on { background: var(--guava-700); border-color: var(--guava-700); color: #fff; }
    .j-action-btn svg { width: 16px; height: 16px; }
    .j-save-ind { font-size: 11px; color: var(--ink-4); margin-left: 8px; min-width: 60px; text-align: right; }
    .j-save-ind.saved { color: var(--moss-fg); }
    .j-save-ind.error { color: var(--guava-700); }
    .j-search-bar { position: relative; margin-bottom: 16px; }
    .j-search-input { width: 100%; padding: 10px 14px 10px 36px; border: 1px solid var(--edge-strong); border-radius: var(--r-md); font-family: inherit; font-size: 13px; color: var(--ink); background: var(--surface); outline: none; box-sizing: border-box; }
    .j-search-input:focus { border-color: var(--guava-500); box-shadow: var(--shadow-focus); }
    .j-search-icon { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); width: 14px; height: 14px; color: var(--ink-4); pointer-events: none; }
    .j-search-results { position: absolute; left: 0; right: 0; top: 100%; margin-top: 4px; background: var(--surface); border: 1px solid var(--edge); border-radius: var(--r-md); box-shadow: var(--shadow-raised); max-height: 360px; overflow-y: auto; z-index: 10; }
    .j-sr-item { width: 100%; text-align: left; background: none; border: none; padding: 10px 14px; font-family: inherit; cursor: pointer; border-bottom: 1px solid var(--edge); display: block; }
    .j-sr-item:last-child { border-bottom: none; }
    .j-sr-item:hover { background: var(--surface-2); }
    .j-sr-date { font-size: 12px; font-weight: 600; color: var(--ink); margin-bottom: 2px; }
    .j-sr-meta { font-size: 10px; color: var(--ink-4); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px; }
    .j-sr-snippet { font-size: 12px; color: var(--ink-3); line-height: 1.5; }
    .j-sr-snippet mark { background: var(--guava-100); color: var(--guava-900); padding: 0 2px; border-radius: 2px; }
    .j-sr-empty { padding: 16px; font-size: 12px; color: var(--ink-4); text-align: center; }

    .j-cal-pop { position: absolute; right: 24px; top: 80px; width: 280px; background: var(--surface); border: 1px solid var(--edge); border-radius: var(--r-md); box-shadow: var(--shadow-raised); padding: 12px; z-index: 20; }
    @media (max-width: 600px) { .j-cal-pop { right: 12px; left: 12px; width: auto; } }
    .j-cal-head { display: flex; align-items: center; justify-content: space-between; padding: 0 4px 8px; }
    .j-cal-month { font-size: 13px; font-weight: 600; color: var(--ink); }
    .j-cal-nav { background: none; border: none; padding: 4px 8px; cursor: pointer; color: var(--ink-3); border-radius: var(--r-sm); font-size: 16px; line-height: 1; }
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

    .j-body { background: var(--surface); border: 1px solid var(--edge); border-radius: var(--r-md); padding: 28px 32px; box-shadow: var(--shadow-card); margin-top: 16px; }
    @media (max-width: 600px) { .j-body { padding: 22px 18px; } .j-shell { padding: 20px 14px 80px; } .j-date-h { font-size: 20px; } }

    .j-empty { text-align: center; padding: 24px 16px 8px; }
    .j-empty-msg { font-size: 16px; color: var(--ink-2); line-height: 1.5; max-width: 460px; margin: 0 auto 18px; font-weight: 500; }
    .j-empty-cta { background: var(--guava-700); color: #fff; border: none; padding: 10px 22px; font-family: inherit; font-size: 13px; font-weight: 600; border-radius: var(--r-md); cursor: pointer; }
    .j-empty-cta:hover { background: var(--guava-800); }

    .j-section { margin-bottom: 22px; }
    .j-section-h { font-size: 10px; font-weight: 700; color: var(--ink-4); letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 8px; }
    .j-list-row { display: flex; gap: 8px; padding: 6px 0; font-size: 13px; color: var(--ink-2); line-height: 1.5; }
    .j-list-row .j-bullet { color: var(--guava-500); flex-shrink: 0; }
    .j-list-row .j-check { color: var(--moss-fg); flex-shrink: 0; font-weight: 700; }
    .j-empty-row { font-size: 12px; color: var(--ink-4); font-style: italic; padding: 4px 0; }
    .j-error-row { font-size: 12px; color: var(--guava-700); padding: 4px 0; line-height: 1.5; }
    .j-error-row a { color: var(--guava-800); text-decoration: underline; cursor: pointer; }

    .j-reflection-read { font-size: 14px; color: var(--ink); line-height: 1.7; white-space: pre-wrap; }
    .j-mood-read { display: flex; align-items: center; gap: 10px; font-size: 32px; }
    .j-mood-read-label { font-size: 12px; color: var(--ink-4); }

    .j-photos { display: flex; flex-wrap: wrap; gap: 10px; }
    .j-photo { position: relative; width: 88px; height: 88px; border-radius: var(--r-md); overflow: hidden; background: var(--surface-2); border: 1px solid var(--edge); cursor: pointer; }
    .j-photo img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .j-photo-del { position: absolute; top: 4px; right: 4px; background: rgba(0,0,0,0.6); border: none; color: #fff; width: 20px; height: 20px; border-radius: 50%; font-size: 11px; cursor: pointer; line-height: 1; padding: 0; display: flex; align-items: center; justify-content: center; }
    .j-photo-del:hover { background: rgba(0,0,0,0.85); }
    .j-photo-add { width: 88px; height: 88px; border: 1.5px dashed var(--edge-strong); border-radius: var(--r-md); background: none; cursor: pointer; color: var(--ink-3); display: flex; align-items: center; justify-content: center; font-size: 22px; font-weight: 300; }
    .j-photo-add:hover { border-color: var(--guava-500); color: var(--guava-700); background: var(--guava-50); }

    .j-textarea { width: 100%; min-height: 140px; padding: 12px 14px; border: 1px solid var(--edge-strong); border-radius: var(--r-md); background: var(--surface); font-family: inherit; font-size: 13px; line-height: 1.6; color: var(--ink); resize: vertical; outline: none; box-sizing: border-box; }
    .j-textarea:focus { border-color: var(--guava-500); box-shadow: var(--shadow-focus); }

    .j-mood { display: flex; gap: 8px; flex-wrap: wrap; }
    .j-mood-btn { width: 44px; height: 44px; border-radius: 50%; background: var(--surface-2); border: 1.5px solid transparent; cursor: pointer; font-size: 22px; padding: 0; display: flex; align-items: center; justify-content: center; transition: transform 0.1s; }
    .j-mood-btn:hover { transform: scale(1.08); }
    .j-mood-btn.is-selected { border-color: var(--guava-700); background: var(--guava-50); }

    /* Photo source modal */
    .j-photo-modal { position: fixed; inset: 0; background: rgba(20,15,10,0.45); display: flex; align-items: center; justify-content: center; z-index: 1000; padding: 20px; }
    .j-photo-modal-card { background: var(--surface); border-radius: var(--r-lg); padding: 22px; max-width: 360px; width: 100%; box-shadow: var(--shadow-raised); }
    .j-photo-modal-h { font-size: 15px; font-weight: 600; color: var(--ink); margin-bottom: 14px; }
    .j-photo-modal-opt { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border: 1px solid var(--edge); border-radius: var(--r-md); background: var(--surface); cursor: pointer; width: 100%; font-family: inherit; text-align: left; margin-bottom: 8px; transition: background 0.12s; }
    .j-photo-modal-opt:hover { background: var(--surface-2); }
    .j-photo-modal-opt[disabled] { opacity: 0.45; cursor: not-allowed; }
    .j-photo-modal-opt svg { width: 20px; height: 20px; color: var(--ink-3); flex-shrink: 0; }
    .j-photo-modal-opt-text { display: flex; flex-direction: column; gap: 2px; }
    .j-photo-modal-opt-name { font-size: 13px; font-weight: 600; color: var(--ink); }
    .j-photo-modal-opt-desc { font-size: 11px; color: var(--ink-4); }
    .j-photo-modal-cancel { background: none; border: none; color: var(--ink-3); padding: 10px; cursor: pointer; font-family: inherit; font-size: 12px; width: 100%; margin-top: 4px; }
    .j-photo-modal-cancel:hover { color: var(--ink); }
  `;
  document.head.appendChild(style);
}

/* ── ESCAPE ───────────────────────────────────────────────── */

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/* ── CALENDAR POPOVER RENDER ─────────────────────────────── */

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
    <div class="j-cal-pop" id="jCalPop">
      <div class="j-cal-head">
        <button class="j-cal-nav" data-jcal-nav="-1" title="Previous month">‹</button>
        <div class="j-cal-month">${monthName}</div>
        <button class="j-cal-nav" data-jcal-nav="1" title="Next month">›</button>
      </div>
      <div class="j-cal-grid">${dowRow}${cellsHtml}</div>
    </div>`;
}

/* ── EVENTS / TASKS SECTIONS ─────────────────────────────── */

function renderEventsSection(ds) {
  if (!journalState.calendarEvents.has(ds) && !journalState.eventsError.has(ds)) {
    return `<div class="j-empty-row">Loading…</div>`;
  }
  const err = journalState.eventsError.get(ds);
  if (err === 'expired') {
    return `<div class="j-error-row">Couldn't reach Google Calendar — your sign-in may need to be refreshed. <a data-jrefresh-auth="1">Refresh sign-in</a></div>`;
  }
  if (err === 'api') {
    return `<div class="j-error-row">Calendar unavailable — please try again. <a data-jretry-events="1">Retry</a></div>`;
  }
  const events = journalState.calendarEvents.get(ds) || [];
  if (!events.length) return `<div class="j-empty-row">No calendar events.</div>`;
  return events.map(ev => {
    const time = ev.isAllDay ? 'All day' : new Date(ev.start).toLocaleTimeString(undefined, { hour:'numeric', minute:'2-digit' });
    return `<div class="j-list-row"><span class="j-bullet">•</span><span>${escapeHtml(ev.summary)} · ${time}</span></div>`;
  }).join('');
}

function renderTasksSection(ds) {
  const tasksDone = getCompletedTasksForDate(ds);
  if (!tasksDone.length) return `<div class="j-empty-row">No tasks completed on this day.</div>`;
  return tasksDone.map(t =>
    `<div class="j-list-row"><span class="j-check">✓</span><span>${escapeHtml(t.text)}</span></div>`
  ).join('');
}

/* ── HEADER / SHELL ──────────────────────────────────────── */

function renderJournalHeader() {
  const ds = journalState.selectedDate;
  const calOn = journalState.calendarOpen ? ' is-on' : '';
  const editOn = journalState.editMode ? ' is-on' : '';
  const editIcon = journalState.editMode
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>`;
  const todayBadge = jIsToday(ds) ? `<span class="j-date-sub">Today</span>` : '';

  return `
    <div class="j-header">
      <div>
        <div class="j-date-h">${jFormatLong(ds)}</div>
        ${todayBadge}
      </div>
      <div class="j-actions">
        <span class="j-save-ind" id="jSaveInd"></span>
        <button class="j-action-btn${calOn}" id="jCalToggle" title="Choose date" aria-pressed="${journalState.calendarOpen}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
        </button>
        <button class="j-action-btn${editOn}" id="jEditToggle" title="${journalState.editMode ? 'Done' : 'Edit'}">
          ${editIcon}
        </button>
      </div>
    </div>
  `;
}

/* ── BODY: READ MODE / EDIT MODE / EMPTY STATE ───────────── */

function renderEmptyState(ds) {
  return `
    <div class="j-body">
      <div class="j-empty">
        <div class="j-empty-msg">${escapeHtml(getEmptyStatePrompt(ds))}</div>
        <button class="j-empty-cta" id="jStartWriting">Start writing</button>
      </div>
      <div class="j-section">
        <div class="j-section-h">What happened today</div>
        <div id="jEventsSlot">${renderEventsSection(ds)}</div>
      </div>
      <div class="j-section">
        <div class="j-section-h">What you finished</div>
        ${renderTasksSection(ds)}
      </div>
    </div>`;
}

function renderReadView(ds) {
  const entry = journalState.entries.get(ds);
  const hasReflection = !!(entry?.reflections && entry.reflections.trim());
  const hasMood = entry?.mood;
  const hasPhotos = entry?.photos?.length;

  const reflectionHtml = hasReflection
    ? `<div class="j-section"><div class="j-section-h">Reflection</div><div class="j-reflection-read">${escapeHtml(entry.reflections)}</div></div>`
    : '';
  const moodHtml = hasMood
    ? `<div class="j-section"><div class="j-section-h">Mood</div><div class="j-mood-read"><span>${MOOD_EMOJI[entry.mood-1]}</span><span class="j-mood-read-label">${MOOD_LABEL[entry.mood-1]}</span></div></div>`
    : '';
  const photosHtml = hasPhotos
    ? `<div class="j-section"><div class="j-section-h">Photos</div><div class="j-photos">${entry.photos.map(src => `<div class="j-photo"><img src="${src}" alt="" /></div>`).join('')}</div></div>`
    : '';

  return `
    <div class="j-body">
      ${reflectionHtml}
      ${moodHtml}
      ${photosHtml}
      <div class="j-section">
        <div class="j-section-h">What happened today</div>
        <div id="jEventsSlot">${renderEventsSection(ds)}</div>
      </div>
      <div class="j-section">
        <div class="j-section-h">What you finished</div>
        ${renderTasksSection(ds)}
      </div>
    </div>`;
}

function renderEditView(ds) {
  const entry = journalState.entries.get(ds) || { reflections: '', mood: null, photos: [] };

  const photosHtml = (entry.photos || []).map((src, i) =>
    `<div class="j-photo"><img src="${src}" alt="" /><button class="j-photo-del" data-jphoto-del="${i}" title="Remove">×</button></div>`
  ).join('');

  const moodHtml = MOOD_EMOJI.map((emoji, i) => {
    const sel = entry.mood === (i+1) ? ' is-selected' : '';
    return `<button class="j-mood-btn${sel}" data-jmood="${i+1}" title="${MOOD_LABEL[i]}">${emoji}</button>`;
  }).join('');

  return `
    <div class="j-body">
      <div class="j-section">
        <div class="j-section-h">Reflection</div>
        <textarea class="j-textarea" id="jReflections" placeholder="How did today go? What's on your mind?">${escapeHtml(entry.reflections || '')}</textarea>
      </div>
      <div class="j-section">
        <div class="j-section-h">Mood</div>
        <div class="j-mood">${moodHtml}</div>
      </div>
      <div class="j-section">
        <div class="j-section-h">Photos</div>
        <div class="j-photos">
          ${photosHtml}
          <button class="j-photo-add" id="jPhotoAdd" title="Add photo">+</button>
        </div>
      </div>
      <div class="j-section">
        <div class="j-section-h">What happened today</div>
        <div id="jEventsSlot">${renderEventsSection(ds)}</div>
      </div>
      <div class="j-section">
        <div class="j-section-h">What you finished</div>
        ${renderTasksSection(ds)}
      </div>
    </div>`;
}

function isEntryEmpty(entry) {
  if (!entry) return true;
  const hasRef = entry.reflections && entry.reflections.trim();
  const hasMood = !!entry.mood;
  const hasPhotos = entry.photos && entry.photos.length;
  return !(hasRef || hasMood || hasPhotos);
}

function renderJournalBody() {
  const ds = journalState.selectedDate;
  const entry = journalState.entries.get(ds);
  if (journalState.editMode) return renderEditView(ds);
  if (isEntryEmpty(entry)) return renderEmptyState(ds);
  return renderReadView(ds);
}

function rerenderJournalBody() {
  const slot = document.getElementById('jBodySlot');
  if (!slot) return;
  slot.innerHTML = renderJournalBody();
}

function rerenderJournalHeader() {
  const slot = document.getElementById('jHeaderSlot');
  if (!slot) return;
  slot.innerHTML = renderJournalHeader();
}

function rerenderJournalCalendarPopover() {
  const existing = document.getElementById('jCalPop');
  if (existing) existing.outerHTML = renderJournalCalendar();
  if (!journalState.calendarOpen) {
    const el = document.getElementById('jCalPop');
    if (el) el.style.display = 'none';
  }
}

/* ── SAVE INDICATOR ──────────────────────────────────────── */

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

  if (typeof routerSyncUrl === 'function') {
    routerSyncUrl({ tool: 'journal', date: journalState.selectedDate }, { replace: true });
  }

  root.innerHTML = `
    <div class="j-shell">
      <div class="j-search-bar">
        <svg class="j-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input type="text" class="j-search-input" id="jSearchInput" placeholder="Search entries, events, tasks…" value="${escapeHtml(journalState.searchQuery)}" />
        <div id="jSearchResults"></div>
      </div>
      <div id="jHeaderSlot">${renderJournalHeader()}</div>
      <div id="jCalPopSlot" style="${journalState.calendarOpen ? '' : 'display:none'}">${renderJournalCalendar()}</div>
      <div id="jBodySlot">${renderJournalBody()}</div>
    </div>`;

  // Refresh data in background
  fetchCalendarEventsForDate(journalState.selectedDate).then(() => {
    if (journalState.selectedDate === journalState.selectedDate) refreshEventsSlot();
  });
  loadJournalMonth(journalState.viewMonth.year, journalState.viewMonth.month).then(rerenderJournalCalendarPopover);
  loadJournalEntry(journalState.selectedDate).then(() => rerenderJournalBody());
  syncCalendarHistory();
}

function refreshEventsSlot() {
  const slot = document.getElementById('jEventsSlot');
  if (slot) slot.innerHTML = renderEventsSection(journalState.selectedDate);
}

/* ── SEARCH ───────────────────────────────────────────────── */

let jSearchTimer = null;
async function performJournalSearch(q) {
  q = (q || '').trim();
  journalState.searchQuery = q;
  if (!q) { journalState.searchResults = null; renderSearchResults(); return; }
  try {
    const { data, error } = await db.rpc('search_journal', { p_query: q });
    if (error) throw error;
    journalState.searchResults = data || [];
  } catch (e) {
    console.warn('[journal] search failed', e);
    journalState.searchResults = [];
  }
  renderSearchResults();
}

function renderSearchResults() {
  const slot = document.getElementById('jSearchResults');
  if (!slot) return;
  if (journalState.searchResults === null || !journalState.searchQuery) {
    slot.innerHTML = '';
    return;
  }
  const results = journalState.searchResults;
  if (!results.length) {
    slot.innerHTML = `<div class="j-search-results"><div class="j-sr-empty">No matches.</div></div>`;
    return;
  }
  const rows = results.map(r => {
    const sources = (r.sources || []).map(s => s.charAt(0).toUpperCase()+s.slice(1)).join(' · ');
    const snippet = r.snippet || '';
    return `<button class="j-sr-item" data-jsr-date="${r.entry_date}">
      <div class="j-sr-date">${jFormatShort(r.entry_date)}</div>
      <div class="j-sr-meta">${sources}</div>
      <div class="j-sr-snippet">${snippet}</div>
    </button>`;
  }).join('');
  slot.innerHTML = `<div class="j-search-results">${rows}</div>`;
}

/* ── EVENT HANDLERS ───────────────────────────────────────── */

document.addEventListener('click', async e => {
  // Calendar date click
  const dateBtn = e.target.closest('[data-jcal-date]');
  if (dateBtn) {
    const newDate = dateBtn.dataset.jcalDate;
    journalState.selectedDate = newDate;
    journalState.editMode = false;
    journalState.calendarOpen = false;
    rerenderJournalHeader();
    rerenderJournalBody();
    document.getElementById('jCalPopSlot').style.display = 'none';
    rerenderJournalCalendarPopover();
    if (typeof routerSyncUrl === 'function') routerSyncUrl({ tool: 'journal', date: newDate });
    fetchCalendarEventsForDate(newDate).then(() => {
      if (journalState.selectedDate === newDate) refreshEventsSlot();
    });
    loadJournalEntry(newDate).then(() => {
      if (journalState.selectedDate === newDate) rerenderJournalBody();
    });
    return;
  }

  // Calendar month nav
  const navBtn = e.target.closest('[data-jcal-nav]');
  if (navBtn) {
    e.stopPropagation();
    const delta = parseInt(navBtn.dataset.jcalNav, 10);
    let { year, month } = journalState.viewMonth;
    month += delta;
    if (month < 0) { month = 11; year--; }
    if (month > 11) { month = 0; year++; }
    journalState.viewMonth = { year, month };
    rerenderJournalCalendarPopover();
    loadJournalMonth(year, month).then(rerenderJournalCalendarPopover);
    return;
  }

  // Toggle calendar popover
  if (e.target.closest('#jCalToggle')) {
    journalState.calendarOpen = !journalState.calendarOpen;
    const popSlot = document.getElementById('jCalPopSlot');
    if (popSlot) popSlot.style.display = journalState.calendarOpen ? '' : 'none';
    rerenderJournalHeader();
    return;
  }

  // Toggle edit mode
  if (e.target.closest('#jEditToggle')) {
    journalState.editMode = !journalState.editMode;
    rerenderJournalHeader();
    rerenderJournalBody();
    return;
  }

  // Start writing → edit mode
  if (e.target.closest('#jStartWriting')) {
    journalState.editMode = true;
    rerenderJournalHeader();
    rerenderJournalBody();
    setTimeout(() => document.getElementById('jReflections')?.focus(), 50);
    return;
  }

  // Add photo → open source modal
  if (e.target.closest('#jPhotoAdd')) {
    openPhotoSourceModal();
    return;
  }
  const photoSrc = e.target.closest('[data-jphoto-source]');
  if (photoSrc) {
    handlePhotoSource(photoSrc.dataset.jphotoSource);
    return;
  }
  if (e.target.closest('[data-jphoto-cancel]') || e.target.classList.contains('j-photo-modal')) {
    closePhotoSourceModal();
    return;
  }

  // Photo delete
  const photoDel = e.target.closest('[data-jphoto-del]');
  if (photoDel) {
    const idx = parseInt(photoDel.dataset.jphotoDel, 10);
    const ds = journalState.selectedDate;
    const entry = journalState.entries.get(ds) || { reflections:'', mood:null, photos:[] };
    const photos = [...(entry.photos || [])];
    photos.splice(idx, 1);
    journalState.entries.set(ds, { ...entry, photos });
    rerenderJournalBody();
    saveJournalEntry(ds, { photos });
    return;
  }

  // Mood click
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

  // Search result click
  const sr = e.target.closest('[data-jsr-date]');
  if (sr) {
    const date = sr.dataset.jsrDate;
    journalState.selectedDate = date;
    const d = jParseDate(date);
    journalState.viewMonth = { year: d.getFullYear(), month: d.getMonth() };
    journalState.searchQuery = '';
    journalState.searchResults = null;
    journalState.editMode = false;
    journalState.calendarOpen = false;
    if (typeof routerSyncUrl === 'function') routerSyncUrl({ tool: 'journal', date });
    renderJournal();
    return;
  }

  // Refresh sign-in
  if (e.target.closest('[data-jrefresh-auth]')) {
    location.reload();
    return;
  }
  if (e.target.closest('[data-jretry-events]')) {
    journalState.calendarEvents.delete(journalState.selectedDate);
    journalState.eventsError.delete(journalState.selectedDate);
    refreshEventsSlot();
    fetchCalendarEventsForDate(journalState.selectedDate).then(refreshEventsSlot);
    return;
  }
});

document.addEventListener('change', async e => {
  if (e.target.id === 'jPhotoInputDevice' || e.target.id === 'jPhotoInputCamera') {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    closePhotoSourceModal();
    await addPhotosFromFiles(files);
  }
});

document.addEventListener('input', e => {
  if (e.target.id === 'jReflections') {
    const ds = journalState.selectedDate;
    const entry = journalState.entries.get(ds) || { reflections:'', mood:null, photos:[] };
    journalState.entries.set(ds, { ...entry, reflections: e.target.value });
    scheduleSave(ds, { reflections: e.target.value });
    return;
  }
  if (e.target.id === 'jSearchInput') {
    const q = e.target.value;
    clearTimeout(jSearchTimer);
    jSearchTimer = setTimeout(() => performJournalSearch(q), 200);
    return;
  }
});

/* ── PHOTO SOURCE MODAL ──────────────────────────────────── */

function openPhotoSourceModal() {
  if (document.getElementById('jPhotoModal')) return;
  const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
  const cameraOpt = isMobile
    ? `<button class="j-photo-modal-opt" data-jphoto-source="camera">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
        <div class="j-photo-modal-opt-text"><span class="j-photo-modal-opt-name">Take photo</span><span class="j-photo-modal-opt-desc">Use your camera</span></div>
      </button>` : '';
  const html = `
    <div class="j-photo-modal" id="jPhotoModal">
      <div class="j-photo-modal-card" onclick="event.stopPropagation()">
        <div class="j-photo-modal-h">Add photo</div>
        ${cameraOpt}
        <button class="j-photo-modal-opt" data-jphoto-source="device">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          <div class="j-photo-modal-opt-text"><span class="j-photo-modal-opt-name">Upload from device</span><span class="j-photo-modal-opt-desc">Pick one or more files</span></div>
        </button>
        <input type="file" id="jPhotoInputDevice" accept="image/*" multiple style="display:none" />
        <input type="file" id="jPhotoInputCamera" accept="image/*" capture="environment" style="display:none" />
        <button class="j-photo-modal-cancel" data-jphoto-cancel="1">Cancel</button>
      </div>
    </div>`;
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  document.body.appendChild(wrap.firstElementChild);
}

function closePhotoSourceModal() {
  const m = document.getElementById('jPhotoModal');
  if (m) m.remove();
}

function handlePhotoSource(source) {
  if (source === 'device') document.getElementById('jPhotoInputDevice')?.click();
  else if (source === 'camera') document.getElementById('jPhotoInputCamera')?.click();
}

async function addPhotosFromFiles(files) {
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
  rerenderJournalBody();
  saveJournalEntry(ds, { photos });
}

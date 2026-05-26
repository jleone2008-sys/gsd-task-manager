/* ══════════════════════════════════════════════════════════════
   JOURNAL — beta-only
   Card timeline of daily entries (today on top, scroll older).
   Each card shows photos, reflection, mood, with auto-prefill of
   completed tasks and Google Calendar events.
   Click card to edit; click photos for lightbox; calendar popover
   to jump dates; full-text search; future dates disabled.
═══════════════════════════════════════════════════════════════ */

const journalState = {
  entries: new Map(),                // dateStr -> entry row
  monthsLoaded: new Set(),
  calendarEvents: new Map(),
  eventsError: new Map(),
  historySynced: false,

  // Timeline view. Small initial window (last 7 days) so cold-open
  // paints fast; user scrolls to extend in 7-day chunks. Phase 2 audit:
  // 30/30 paid for content most users never read on a given session.
  timelineLoadedThrough: null,       // earliest date string loaded
  timelineDays: 7,                   // initial window size
  timelineLoading: false,

  // Calendar popover
  viewMonth: null,
  calendarOpen: false,

  // Edit modal state
  editingDate: null,
  viewingDate: null,
  saveTimer: null,
  saveStatus: 'idle',

  // Lightbox state
  lightboxPhotos: null,              // {date, index}

  // Phase 5: per-event metadata cache (relationship_tag, energy_after,
  // notes). Map<event_id, { relationship_tag, energy_after, notes }>.
  // Loaded incrementally — only meta for events in the currently-loaded
  // timeline window is fetched, and only IDs not already in the Map are
  // requested. eventMetaFetched tracks which IDs we've already asked the
  // server about (regardless of whether the server returned a row) so we
  // don't re-query for events that simply have no meta yet.
  eventMeta: new Map(),
  eventMetaFetched: new Set(),
  eventMetaEditing: null,             // event-id currently open in the editor

  // Search
  searchQuery: '',
  searchResults: null,

  // Card-initiated photo upload (date whose card "Add photo" was clicked)
  cardPhotoTargetDate: null,

  // Frozen per-day habit summary {due, done} keyed by date. Backed by
  // public.journal_habit_summary; only past days are stored — today is live.
  habitSummaries: new Map()
};

// Mood scale: 1=Bad ... 5=Great (array index N → mood value N+1).
// Inverted from the original 1=best convention via the
// invert_mood_scale.sql migration so the order matches every standard
// 1-5 rating UX + LLMs read it correctly without a custom prompt note.
const MOOD_EMOJI = ['😢', '😔', '😐', '😊', '🤩'];
const MOOD_LABEL = ['Bad', 'Low', 'Okay', 'Good', 'Great'];

/* ── DATE HELPERS ─────────────────────────────────────────── */

function jToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function jParseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m-1, d);
}

function jFormatDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function jShiftDays(s, delta) {
  const d = jParseDate(s);
  d.setDate(d.getDate() + delta);
  return jFormatDate(d);
}

function jFormatLong(s) {
  const d = jParseDate(s);
  return d.toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric', year:'numeric' });
}

function jFormatCardDate(s) {
  const d = jParseDate(s);
  return d.toLocaleDateString(undefined, { weekday:'long', month:'short', day:'numeric' });
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

/* ── DATA: ENTRIES ────────────────────────────────────────── */

async function loadJournalMonth(year, month) {
  const key = jMonthKey(year, month);
  if (journalState.monthsLoaded.has(key)) return;
  const start = `${year}-${String(month+1).padStart(2,'0')}-01`;
  const lastDay = new Date(year, month+1, 0).getDate();
  const end = `${year}-${String(month+1).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;
  try {
    const { data, error } = await db.from('journal_entries')
      .select('entry_date, reflections, mood, photos, photo_paths, learning, updated_at')
      .gte('entry_date', start).lte('entry_date', end);
    if (error) throw error;
    (data || []).forEach(row => journalState.entries.set(row.entry_date, row));
    journalState.monthsLoaded.add(key);
  } catch (e) {
    console.warn('[journal] loadMonth failed', e);
  }
}

async function loadJournalRange(startDate, endDate) {
  console.time('[perf] journal.loadInitial:entries');
  try {
    const { data, error } = await db.from('journal_entries')
      .select('entry_date, reflections, mood, photos, photo_paths, learning, updated_at')
      .gte('entry_date', startDate).lte('entry_date', endDate);
    if (error) throw error;
    (data || []).forEach(row => journalState.entries.set(row.entry_date, row));
  } catch (e) { console.warn('[journal] loadRange failed', e); }
  finally { console.timeEnd('[perf] journal.loadInitial:entries'); }
}

async function loadCalendarCacheRange(startDate, endDate) {
  console.time('[perf] journal.loadInitial:cache');
  try {
    const { data, error } = await db.from('journal_calendar_cache')
      .select('entry_date, events')
      .gte('entry_date', startDate).lte('entry_date', endDate);
    if (error) throw error;
    (data || []).forEach(row => journalState.calendarEvents.set(row.entry_date, row.events || []));
  } catch (e) { /* table may not exist yet — silent */ }
  finally { console.timeEnd('[perf] journal.loadInitial:cache'); }
}

async function loadJournalEntry(dateStr) {
  if (journalState.entries.has(dateStr)) return journalState.entries.get(dateStr);
  try {
    const { data, error } = await db.from('journal_entries')
      .select('entry_date, reflections, mood, photos, photo_paths, learning, updated_at')
      .eq('entry_date', dateStr).maybeSingle();
    if (error) throw error;
    if (data) journalState.entries.set(dateStr, data);
    if (dateStr === jToday()) updateJournalBadge();
    return data || null;
  } catch (e) {
    console.warn('[journal] loadEntry failed', e);
    return null;
  }
}

async function saveJournalEntry(dateStr, patch) {
  const existing = journalState.entries.get(dateStr) || { entry_date: dateStr, reflections: '', mood: null, photos: [], learning: '' };
  const merged = { ...existing, ...patch };
  journalState.entries.set(dateStr, merged);
  updateJournalBadge();
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
      // Phase 2 audit: photo_paths is the new home for Storage-hosted
      // photos (relative bucket paths). Coexists with the legacy
      // photos[] (data-URLs inline) during the migration window;
      // unmigrated entries keep rendering until backfill runs. After
      // backfill + spot-check, photos[] will be nulled out.
      photo_paths: merged.photo_paths || [],
      learning: merged.learning || null,
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

/**
 * Today's live habit completion. Uses the Habits tab's pace-aware
 * isHabitDueToday so quota habits show up only when their deadline forces it.
 */
function computeTodayHabitStats(dateStr) {
  if (typeof habitsArr === 'undefined' || !Array.isArray(habitsArr)) return null;
  if (typeof isHabitDueToday !== 'function' || typeof isCompletedOn !== 'function') return null;
  const due = habitsArr.filter(h => !h.archived && isHabitDueToday(h));
  if (!due.length) return null;
  const done = due.reduce((n, h) => n + (isCompletedOn(h.id, dateStr) ? 1 : 0), 0);
  return { due: due.length, done };
}

/**
 * "Option 1" backfill: for any past day without a stored summary we compute
 * one from current habit + completion data and freeze it. Strict-cadence
 * habits use isHabitDueOnDate; quota habits count as 1/1 only on days they
 * were actually completed (no per-day penalty for missed quotas).
 */
function computeHabitSummaryOption1(dateStr) {
  if (typeof habitsArr === 'undefined' || !Array.isArray(habitsArr)) return null;
  if (typeof isHabitDueOnDate !== 'function' || typeof isCompletedOn !== 'function') return null;
  let due = 0, done = 0;
  for (const h of habitsArr) {
    if (h.archived) continue;
    if (h.frequency === 'x_per_week' || h.frequency === 'x_per_month') {
      if (isCompletedOn(h.id, dateStr)) { due++; done++; }
    } else {
      if (!isHabitDueOnDate(h, dateStr)) continue;
      due++;
      if (isCompletedOn(h.id, dateStr)) done++;
    }
  }
  return { due, done };
}

/**
 * Read existing habit summaries in [startDate, endDate] into state,
 * backfill any missing past dates with Option 1, and persist the new rows.
 * Today is intentionally skipped — its value is always live.
 */
async function loadHabitSummariesForRange(startDate, endDate) {
  console.time('[perf] journal.loadInitial:habitSummary');
  try {
    const { data, error } = await db.from('journal_habit_summary')
      .select('entry_date, due_count, done_count')
      .gte('entry_date', startDate).lte('entry_date', endDate);
    console.timeEnd('[perf] journal.loadInitial:habitSummary');
    if (error) { console.warn('[journal] habit summary fetch failed', error); return; }
    if (data) {
      for (const row of data) {
        journalState.habitSummaries.set(row.entry_date, { due: row.due_count, done: row.done_count });
      }
    }
  } catch (e) {
    console.warn('[journal] habit summary fetch error', e);
    return;
  }
  // Wait for habits-core to finish loading habitsArr + habitCompletions before
  // computing any backfill rows — otherwise we'd freeze every past day at 0%.
  if (typeof habitsLoaded !== 'undefined' && habitsLoaded && typeof habitsLoaded.then === 'function') {
    await habitsLoaded;
  }
  await backfillHabitSummaries(startDate, endDate);
}

async function backfillHabitSummaries(startDate, endDate) {
  if (typeof habitsArr === 'undefined' || !habitsArr.length) return;
  const today = (typeof jToday === 'function') ? jToday() : null;
  const toWrite = [];
  let d = startDate;
  while (d <= endDate) {
    if (today && d >= today) break; // skip today + future
    if (!journalState.habitSummaries.has(d)) {
      const stats = computeHabitSummaryOption1(d);
      if (stats) {
        journalState.habitSummaries.set(d, stats);
        toWrite.push({ entry_date: d, due_count: stats.due, done_count: stats.done });
      }
    }
    d = jShiftDays(d, 1);
  }
  if (!toWrite.length) return;
  try {
    const { data: { session } } = await db.auth.getSession();
    if (!session) return;
    const rows = toWrite.map(r => ({ ...r, user_id: session.user.id, updated_at: new Date().toISOString() }));
    const { error } = await db.from('journal_habit_summary')
      .upsert(rows, { onConflict: 'user_id,entry_date', ignoreDuplicates: false });
    if (error) console.warn('[journal] habit summary backfill upsert failed', error);
  } catch (e) {
    console.warn('[journal] habit summary backfill error', e);
  }
}

function getHabitCompletionForDate(dateStr) {
  const isToday = (typeof jIsToday === 'function') && jIsToday(dateStr);
  if (isToday) {
    const stats = computeTodayHabitStats(dateStr);
    if (!stats || stats.due === 0) return null;
    return { ...stats, pct: Math.round((stats.done / stats.due) * 100) };
  }
  const s = journalState.habitSummaries.get(dateStr);
  if (!s || s.due === 0) return null;
  return { due: s.due, done: s.done, pct: Math.round((s.done / s.due) * 100) };
}

function isJournalSectionEnabled(tool) {
  if (tool === 'tasks') return true;
  if (typeof userSettings === 'undefined' || !userSettings) return true;
  const enabled = userSettings.enabled_tools || [];
  return enabled.includes(tool);
}

/* ── DATA: CALENDAR EVENTS ───────────────────────────────── */

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

// In-memory cache of a refreshed Google access_token (Supabase doesn't auto-refresh provider_token)
let _googleAccessTokenCache = { token: null, expiresAt: 0 };

async function getGoogleAccessToken(forceRefresh) {
  const now = Date.now();
  if (!forceRefresh && _googleAccessTokenCache.token && now < _googleAccessTokenCache.expiresAt - 60000) {
    return _googleAccessTokenCache.token;
  }
  // Try Supabase session first if cache is empty
  if (!forceRefresh && !_googleAccessTokenCache.token) {
    try {
      const { data: { session } } = await db.auth.getSession();
      if (session?.provider_token) {
        _googleAccessTokenCache = { token: session.provider_token, expiresAt: now + 30 * 60 * 1000 };
        return session.provider_token;
      }
    } catch (_) {}
  }
  // Refresh via Netlify function
  try {
    const { data: { session } } = await db.auth.getSession();
    if (!session) return null;
    const res = await fetch('/.netlify/functions/refresh-google-token', {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      console.warn('[journal] google token refresh failed', res.status, detail);
      return null;
    }
    const data = await res.json();
    if (!data.access_token) return null;
    const expiresMs = (data.expires_in || 3600) * 1000;
    _googleAccessTokenCache = { token: data.access_token, expiresAt: now + expiresMs };
    return data.access_token;
  } catch (err) {
    console.warn('[journal] refresh request failed', err);
    return null;
  }
}

// Phase 5 — calendar event metadata (relationship_tag, energy_after,
// notes). Loaded incrementally for the events in the currently-loaded
// timeline window, not the user's entire history. Mutated in-place by
// save/delete from the editor.
//
// Pre-Phase 2 audit this used to be a single all-time query that grew
// linearly with the user's lifetime tagged-event count — that was the
// primary "journal slows down every day" symptom because the payload
// (and resulting Map) got heavier with every metadata save the user
// ever made. Now: scoped to event IDs we actually have on screen.
async function loadCalendarEventMetaForEvents(eventIds) {
  if (!Array.isArray(eventIds) || eventIds.length === 0) return;
  // Filter to IDs we haven't already asked the server about. The
  // eventMetaFetched Set tracks "asked" (vs eventMeta which only tracks
  // "got back a row") so events with no metadata yet don't keep getting
  // re-queried each time the user re-renders the timeline.
  const missing = [];
  for (const id of eventIds) {
    if (id && !journalState.eventMetaFetched.has(id)) missing.push(id);
  }
  if (missing.length === 0) return;
  // Mark as fetched up-front so concurrent calls don't dogpile the same
  // IDs. If the request fails we'll un-mark them in the catch.
  for (const id of missing) journalState.eventMetaFetched.add(id);
  try {
    const { data: { session } } = await db.auth.getSession();
    if (!session) return;
    // PostgREST `in.()` can comfortably handle a few hundred values
    // (URL length limit is the real cap). A 30-day window is typically
    // ~50-200 events; even 6 months of scroll-back stays well under.
    const { data, error } = await db.from('calendar_event_meta')
      .select('calendar_event_id,relationship_tag,energy_after,notes')
      .eq('user_id', session.user.id)
      .in('calendar_event_id', missing);
    if (error) throw error;
    let added = 0;
    for (const row of (data || [])) {
      journalState.eventMeta.set(row.calendar_event_id, {
        relationship_tag: row.relationship_tag,
        energy_after:     row.energy_after,
        notes:            row.notes,
      });
      added++;
    }
    // If any rows came back, the event rows currently rendered need to
    // pick up their relationship/energy badges. Touch every loaded date
    // — cheap because renderEventsSection only re-renders the inner
    // .j-events-list of each card, not the card itself.
    if (added > 0 && typeof rerenderEventsAfterMetaLoad === 'function') {
      rerenderEventsAfterMetaLoad();
    }
  } catch (e) {
    console.warn('[journal] calendar_event_meta scoped load failed', e);
    // Allow retry on next call by removing the IDs we just marked.
    for (const id of missing) journalState.eventMetaFetched.delete(id);
  }
}

// Re-renders the events sub-section if an entry editor / viewer modal
// is currently open. Day cards themselves don't show meta-driven
// badges (those only appear in the modal via renderEventsSection), so
// the cards don't need a refresh. The modal slots are mounted by ID
// in the edit/view templates — touch whichever is live.
function rerenderEventsAfterMetaLoad() {
  const editSlot = document.getElementById('jEventsSlot');
  if (editSlot && journalState.editingDate) {
    editSlot.innerHTML = renderEventsSection(journalState.editingDate);
  }
  const viewSlot = document.getElementById('jViewEventsSlot');
  if (viewSlot && journalState.viewingDate) {
    viewSlot.innerHTML = renderEventsSection(journalState.viewingDate);
  }
}

// Collects every event id present in the currently-loaded calendar
// cache. Used to scope the meta fetch to what's actually on screen.
function collectLoadedEventIds() {
  const ids = [];
  for (const events of journalState.calendarEvents.values()) {
    if (!Array.isArray(events)) continue;
    for (const ev of events) {
      if (ev && ev.id) ids.push(ev.id);
    }
  }
  return ids;
}

// Phase 5 — multi-Google-calendar sync. Loads enabled calendar IDs
// once per session (cached in journalState.enabledCalendarIds). Returns
// ['primary'] as a back-compat fallback when no rows exist yet.
async function getEnabledCalendarIds() {
  if (journalState.enabledCalendarIds) return journalState.enabledCalendarIds;
  try {
    const { data: { session } } = await db.auth.getSession();
    if (!session) return ['primary'];
    const { data, error } = await db.from('google_calendars_synced')
      .select('google_calendar_id,enabled')
      .eq('user_id', session.user.id)
      .eq('enabled', true);
    if (error) throw error;
    // No rows yet → user hasn't configured anything → fall back to
    // 'primary' so existing behavior continues unchanged.
    const ids = (data || []).map(r => r.google_calendar_id);
    journalState.enabledCalendarIds = ids.length ? ids : ['primary'];
    return journalState.enabledCalendarIds;
  } catch (e) {
    console.warn('[journal] enabled-calendars load failed; falling back to primary', e);
    journalState.enabledCalendarIds = ['primary'];
    return journalState.enabledCalendarIds;
  }
}

async function fetchLiveCalendarEvents(dateStr) {
  let token = await getGoogleAccessToken(false);
  if (!token) {
    journalState.eventsError.set(dateStr, 'expired');
    return null;
  }
  const startISO = new Date(dateStr + 'T00:00:00').toISOString();
  const endISO   = new Date(dateStr + 'T23:59:59').toISOString();
  const calIds = await getEnabledCalendarIds();

  // Fetch each enabled calendar in parallel; merge events.
  const fetchOne = async (calId) => {
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`
      + `?timeMin=${encodeURIComponent(startISO)}&timeMax=${encodeURIComponent(endISO)}`
      + `&singleEvents=true&orderBy=startTime`;
    let res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401 || res.status === 403) {
      token = await getGoogleAccessToken(true);
      if (!token) throw new Error('expired');
      res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    }
    if (res.status === 401 || res.status === 403) throw new Error('expired');
    if (!res.ok) throw new Error(`api_${res.status}`);
    const data = await res.json();
    return (data.items || []).map(e => ({
      id:         e.id,
      summary:    e.summary || '(no title)',
      start:      e.start?.dateTime || e.start?.date || '',
      isAllDay:   !!e.start?.date && !e.start?.dateTime,
      calendarId: calId,
    }));
  };

  try {
    const lists = await Promise.all(calIds.map(id => fetchOne(id).catch(err => {
      // One calendar failing shouldn't kill the whole fetch; just log and skip.
      console.warn(`[journal] calendar ${id} fetch failed`, err.message);
      return [];
    })));
    const events = lists.flat();
    // Sort merged events chronologically (timed first by time, all-day after).
    events.sort((a, b) => {
      if (a.isAllDay && !b.isAllDay) return 1;
      if (!a.isAllDay && b.isAllDay) return -1;
      return String(a.start).localeCompare(String(b.start));
    });
    journalState.eventsError.delete(dateStr);
    return events;
  } catch (e) {
    if (e.message === 'expired') {
      journalState.eventsError.set(dateStr, 'expired');
    } else {
      console.warn('[journal] live fetch failed', e);
      journalState.eventsError.set(dateStr, 'api');
    }
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
    let token = await getGoogleAccessToken(false);
    if (!token) return;
    const { data: { session } } = await db.auth.getSession();
    if (!session) return;
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    const signupAt = currentUser?.created_at ? new Date(currentUser.created_at) : oneYearAgo;
    const start = signupAt > oneYearAgo ? signupAt : oneYearAgo;
    const end = new Date();
    end.setDate(end.getDate() + 30);
    const calIds = await getEnabledCalendarIds();

    // Iterate enabled calendars; merge events from each into a single
    // by-date map. One calendar failing is logged + skipped so the
    // others still land.
    const allEvents = [];
    for (const calId of calIds) {
      let pageToken = '';
      let pages = 0;
      try {
        do {
          const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`);
          url.searchParams.set('timeMin', start.toISOString());
          url.searchParams.set('timeMax', end.toISOString());
          url.searchParams.set('singleEvents', 'true');
          url.searchParams.set('orderBy', 'startTime');
          url.searchParams.set('maxResults', '250');
          if (pageToken) url.searchParams.set('pageToken', pageToken);
          let res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
          if (res.status === 401 || res.status === 403) {
            token = await getGoogleAccessToken(true);
            if (!token) return;
            res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
          }
          if (!res.ok) {
            console.warn(`[journal] history sync ${calId} failed: ${res.status}`);
            break;
          }
          const data = await res.json();
          for (const ev of (data.items || [])) allEvents.push({ ...ev, _calId: calId });
          pageToken = data.nextPageToken || '';
          pages++;
        } while (pageToken && pages < 12);
      } catch (err) {
        console.warn(`[journal] history sync ${calId} threw`, err);
      }
    }

    const byDate = {};
    for (const ev of allEvents) {
      const startStr = ev.start?.dateTime || ev.start?.date || '';
      const dateKey = startStr.slice(0, 10);
      if (!dateKey) continue;
      if (!byDate[dateKey]) byDate[dateKey] = [];
      byDate[dateKey].push({
        id:         ev.id,
        summary:    ev.summary || '(no title)',
        start:      startStr,
        isAllDay:   !!ev.start?.date && !ev.start?.dateTime,
        calendarId: ev._calId,
      });
    }
    // Stable chronological sort within each date (timed first, all-day after).
    for (const k of Object.keys(byDate)) {
      byDate[k].sort((a, b) => {
        if (a.isAllDay && !b.isAllDay) return 1;
        if (!a.isAllDay && b.isAllDay) return -1;
        return String(a.start).localeCompare(String(b.start));
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
    // Re-render only the cards whose events changed — avoids a full timeline
    // rebuild for what's often a handful of affected dates. rerenderTimelineCard
    // is a no-op when the card isn't in the DOM yet (i.e. older than the
    // currently-loaded window), so iterating every byDate key is cheap.
    if (document.getElementById('jTimeline')) {
      for (const date of Object.keys(byDate)) rerenderTimelineCard(date);
    }
  } catch (e) { console.warn('[journal] history sync failed', e); }
}

/* ── IMAGE RESIZE + STORAGE UPLOAD ────────────────────────── */

// Legacy data-URL resizer — kept for the backfill script and any code
// path still reading the deprecated photos[] column. New uploads go
// through resizeImageToBlob + uploadJournalPhoto below.
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

// Phase 2 audit: resize an image file and return a JPEG Blob (instead
// of a data URL). The Blob can be uploaded directly to Supabase
// Storage without the base64 round-trip — keeps memory + bandwidth
// linear with image size rather than +33%.
async function resizeImageToBlob(file, maxDim = 1600, quality = 0.85) {
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
  return await new Promise((resolve, reject) => {
    canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob_failed')), 'image/jpeg', quality);
  });
}

// Upload a resized photo Blob to the journal-photos Storage bucket
// and return the relative path (what gets stored in photo_paths[]).
// Path convention: {user_id}/{entry_date}/{uuid}.jpg
// Errors propagate to the caller; the upload helpers above handle
// per-file failure by skipping that file.
async function uploadJournalPhoto(blob, dateStr) {
  const { data: { session } } = await db.auth.getSession();
  if (!session) throw new Error('not_authenticated');
  const userId = session.user.id;
  // crypto.randomUUID is available in all modern browsers (Safari
  // 15.4+, Chrome 92+, Firefox 95+). Fallback to a timestamp+random
  // string for older runtimes.
  const uuid = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const path = `${userId}/${dateStr}/${uuid}.jpg`;
  const { error } = await db.storage
    .from('journal-photos')
    .upload(path, blob, { contentType: 'image/jpeg', cacheControl: '3600', upsert: false });
  if (error) throw error;
  return path;
}

// Resolve a list of photo_paths to signed URLs for display. The
// Storage client batches the request — one round-trip for N paths.
// Cached per-path on the session to avoid re-signing on every render
// (signed URLs are valid for 1 hour; render-cycle reuse is safe).
const _photoUrlCache = new Map();   // path -> { url, expiresAt }
async function signedUrlsForPaths(paths) {
  if (!Array.isArray(paths) || paths.length === 0) return {};
  const now = Date.now();
  const need = [];
  const out = {};
  for (const p of paths) {
    const hit = _photoUrlCache.get(p);
    if (hit && hit.expiresAt > now + 60_000) out[p] = hit.url;
    else need.push(p);
  }
  if (need.length === 0) return out;
  try {
    const { data, error } = await db.storage
      .from('journal-photos')
      .createSignedUrls(need, 3600);   // 1 hour
    if (error) throw error;
    const expiresAt = now + 3600_000;
    for (const item of (data || [])) {
      if (item.signedUrl && item.path) {
        _photoUrlCache.set(item.path, { url: item.signedUrl, expiresAt });
        out[item.path] = item.signedUrl;
      }
    }
  } catch (e) {
    console.warn('[journal] signedUrlsForPaths failed', e);
  }
  return out;
}

/* ── STYLES ───────────────────────────────────────────────── */

function ensureJournalStyles() {
  if (document.getElementById('journalStyles')) return;
  const style = document.createElement('style');
  style.id = 'journalStyles';
  style.textContent = `
    .content[data-tool-view="journal"] { max-width: none; padding: 0; }
    .j-shell { max-width: 720px; margin: 0; padding: 0 25px 80px; position: relative; }
    .j-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
    .j-page-title { font-size: 22px; font-weight: 700; color: var(--ink); letter-spacing: -0.02em; line-height: 1.25; flex: 1; min-width: 0; }
    .j-actions { display: flex; gap: 6px; align-items: center; }
    .j-action-btn { width: 36px; height: 36px; border-radius: var(--r-md); border: 1px solid var(--edge); background: var(--surface); color: var(--ink-2); cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 0; transition: background 0.12s; }
    .j-action-btn:hover { background: var(--surface-2); color: var(--ink); }
    .j-action-btn.is-on { background: var(--guava-700); border-color: var(--guava-700); color: #fff; }
    .j-action-btn svg { width: 16px; height: 16px; }

    .j-search-row { position: sticky; top: var(--gsd-topbar-h, 60px); z-index: 5; display: flex; gap: 8px; align-items: center; background: var(--bg); padding: 10px 0; margin-bottom: 8px; }
    .j-search-row .j-search-bar { flex: 1; margin-bottom: 0; min-width: 0; }
    .j-cal-pop-slot { position: absolute; top: 100%; right: 0; margin-top: 4px; z-index: 26; width: 280px; }
    @media (max-width: 600px) { .j-cal-pop-slot { left: 0; right: 0; width: auto; } }
    .j-search-bar { position: relative; margin-bottom: 14px; }
    .j-search-input { width: 100%; padding: 10px 14px 10px 36px; border: 1px solid var(--edge-strong); border-radius: var(--r-md); font-family: inherit; font-size: 13px; color: var(--ink); background: var(--surface); outline: none; box-sizing: border-box; }
    .j-search-input:focus { border-color: var(--guava-500); box-shadow: var(--shadow-focus); }
    .j-search-icon { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); width: 14px; height: 14px; color: var(--ink-4); pointer-events: none; }
    .j-search-results { position: absolute; left: 0; right: 0; top: 100%; margin-top: 4px; background: var(--surface); border: 1px solid var(--edge); border-radius: var(--r-md); box-shadow: var(--shadow-raised); max-height: 360px; overflow-y: auto; z-index: 30; }
    .j-sr-item { width: 100%; text-align: left; background: none; border: none; padding: 10px 14px; font-family: inherit; cursor: pointer; border-bottom: 1px solid var(--edge); display: block; }
    .j-sr-item:last-child { border-bottom: none; }
    .j-sr-item:hover { background: var(--surface-2); }
    .j-sr-date { font-size: 12px; font-weight: 600; color: var(--ink); margin-bottom: 2px; }
    .j-sr-meta { font-size: 10px; color: var(--ink-4); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px; }
    .j-sr-snippet { font-size: 12px; color: var(--ink-3); line-height: 1.5; }
    .j-sr-snippet mark { background: var(--guava-100); color: var(--guava-900); padding: 0 2px; border-radius: 2px; }
    .j-sr-empty { padding: 16px; font-size: 12px; color: var(--ink-4); text-align: center; }

    .j-cal-pop { position: relative; width: 100%; box-sizing: border-box; background: var(--surface); border: 1px solid var(--edge); border-radius: var(--r-md); box-shadow: var(--shadow-raised); padding: 12px; }
    .j-cal-head { display: flex; align-items: center; justify-content: space-between; padding: 0 4px 8px; }
    .j-cal-month { font-size: 13px; font-weight: 600; color: var(--ink); }
    .j-cal-nav { background: none; border: none; padding: 4px 8px; cursor: pointer; color: var(--ink-3); border-radius: var(--r-sm); font-size: 16px; line-height: 1; }
    .j-cal-nav:hover { background: var(--surface-2); color: var(--ink); }
    .j-cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; }
    .j-cal-dow { font-size: 9px; font-weight: 600; color: var(--ink-4); text-align: center; padding: 4px 0; letter-spacing: 0.05em; }
    .j-cal-cell { position: relative; aspect-ratio: 1/1; border: none; background: none; font-family: inherit; font-size: 12px; color: var(--ink-2); border-radius: var(--r-sm); cursor: pointer; padding: 0; display: flex; align-items: center; justify-content: center; }
    .j-cal-cell:hover:not([disabled]) { background: var(--surface-2); }
    .j-cal-cell.is-today { font-weight: 700; color: var(--guava-700); }
    .j-cal-cell.has-entry::after { content: ''; position: absolute; bottom: 4px; left: 50%; transform: translateX(-50%); width: 4px; height: 4px; border-radius: 50%; background: var(--guava-500); }
    .j-cal-cell.is-other { color: var(--ink-5); }
    .j-cal-cell[disabled] { color: var(--ink-5); cursor: not-allowed; opacity: 0.45; }

    .j-timeline { display: flex; flex-direction: column; gap: 16px; }
    .j-card {
      background: var(--surface); border: 1px solid var(--edge); border-radius: var(--r-md);
      overflow: hidden; box-shadow: var(--shadow-card); cursor: pointer;
      transition: box-shadow 0.15s, transform 0.08s;
      /* Browser-native virtualization (Phase 2 audit) — skips layout +
         paint for off-screen cards while keeping correct scroll height.
         contain-intrinsic-size is the placeholder height the browser
         reserves for unrendered cards; 220px is a rough avg for a card
         with one or two auto-sections. Cards in/near viewport render
         normally. Supported in Chrome/Edge/Safari 18+; Firefox falls
         back to no-op (renders everything, same as today). */
      content-visibility: auto;
      contain-intrinsic-size: 0 220px;
    }
    .j-card:hover { box-shadow: var(--shadow-card-hover); }
    .j-card:active { transform: translateY(1px); }
    .j-card.j-card--empty { box-shadow: none; }
    .j-card.j-card--placeholder { background: transparent; border: 1px dashed var(--edge); box-shadow: none; padding: 12px 16px; cursor: pointer; }
    .j-card.j-card--placeholder:hover { background: var(--surface); border-color: var(--edge-strong); }
    .j-card-placeholder-text { font-size: 12px; color: var(--ink-4); }

    .j-card-photos { background: #1a1714; }
    .j-card-photos img { display: block; cursor: pointer; }
    .j-card-photos--1 { position: relative; display: flex; align-items: center; justify-content: center; height: 420px; overflow: hidden; }
    .j-card-photos--1 .j-card-photo-bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; filter: blur(28px) saturate(1.1); transform: scale(1.1); pointer-events: none; cursor: default; }
    .j-card-photos--1 > img:not(.j-card-photo-bg) { position: relative; z-index: 1; width: 100%; height: 100%; object-fit: contain; }
    @media (max-width: 600px) { .j-card-photos--1 { height: 300px; } }
    .j-card-photos--2, .j-card-photos--3, .j-card-photos--4, .j-card-photos--5plus { display: grid; gap: 2px; height: 320px; overflow: hidden; }
    @media (max-width: 600px) { .j-card-photos--2, .j-card-photos--3, .j-card-photos--4, .j-card-photos--5plus { height: 240px; } }
    .j-card-photos--2 { grid-template-columns: 1fr 1fr; grid-template-rows: 1fr; }
    .j-card-photos--3 { grid-template-columns: 2fr 1fr; grid-template-rows: 1fr 1fr; }
    .j-card-photos--3 img:nth-child(1) { grid-row: span 2; }
    .j-card-photos--4 { grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; }
    .j-card-photos--5plus { grid-template-columns: 2fr 1fr 1fr; grid-template-rows: 1fr 1fr; }
    .j-card-photos--5plus img:nth-child(1) { grid-row: span 2; }
    .j-card-photos--2 img, .j-card-photos--3 img, .j-card-photos--4 img, .j-card-photos--5plus img { width: 100%; height: 100%; object-fit: cover; }
    .j-card-photos--5plus .j-card-photo-more { position: relative; }
    .j-card-photos--5plus .j-card-photo-more::after { content: attr(data-extra); position: absolute; inset: 0; background: rgba(0,0,0,0.55); color: #fff; font-size: 18px; font-weight: 600; display: flex; align-items: center; justify-content: center; pointer-events: none; }

    .j-card-body { padding: 18px 22px 14px; }
    .j-card-title { font-size: 16px; font-weight: 600; color: var(--ink); line-height: 1.3; margin-bottom: 8px; letter-spacing: -0.01em; }
    .j-card-text { font-size: 14px; color: var(--ink-2); line-height: 1.7; white-space: pre-wrap; word-break: break-word; }
    .j-card-text--clamped { display: -webkit-box; -webkit-line-clamp: 6; -webkit-box-orient: vertical; overflow: hidden; }
    .j-card-mood-inline { font-size: 22px; vertical-align: middle; margin-right: 4px; }

    .j-card-meta { display: flex; gap: 14px; padding: 0 22px 12px; flex-wrap: wrap; font-size: 12px; color: var(--ink-3); }
    .j-card-meta-item { display: inline-flex; align-items: center; gap: 4px; }
    .j-card-meta-item svg { width: 12px; height: 12px; }

    .j-card-footer { display: flex; justify-content: space-between; align-items: center; padding: 10px 22px; border-top: 1px solid var(--edge); background: var(--bg); font-size: 11.5px; color: var(--ink-3); }
    .j-card-date { font-weight: 500; }
    .j-card-edit { background: none; border: none; cursor: pointer; padding: 4px 8px; color: var(--ink-3); border-radius: var(--r-sm); display: flex; align-items: center; gap: 4px; font-family: inherit; font-size: 11.5px; font-weight: 500; }
    .j-card-edit:hover { background: var(--surface-2); color: var(--ink); }
    .j-card-edit svg { width: 12px; height: 12px; }
    .j-card-footer-actions { display: flex; align-items: center; gap: 4px; }
    .j-card-add-photo svg { width: 13px; height: 13px; }
    .j-card-empty-prompt { color: var(--ink-3); font-style: italic; }
    .j-card-start-wrap { padding: 2px 0 4px; }
    .j-card-start-btn { display: inline-flex; align-items: center; gap: 6px; background: var(--guava-700); color: #fff; border: none; padding: 9px 16px; font-family: inherit; font-size: 13px; font-weight: 600; border-radius: var(--r-md); cursor: pointer; transition: background 0.12s; }
    .j-card-start-btn:hover { background: var(--guava-800); }
    .j-card-auto { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--edge); }
    .j-card-body > .j-card-auto:first-child { margin-top: 0; padding-top: 0; border-top: none; }
    .j-card-auto-label { font-size: 9.5px; font-weight: 700; color: var(--ink-4); letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 6px; }
    .j-card-auto-row { display: flex; gap: 6px; padding: 3px 0; font-size: 12.5px; color: var(--ink-2); line-height: 1.5; }
    .j-card-auto-row .j-bullet { color: var(--guava-500); flex-shrink: 0; }
    .j-card-auto-row .j-check { color: var(--moss-fg); flex-shrink: 0; font-weight: 700; }
    .j-card-habit-pct { color: var(--guava-700); font-weight: 700; flex-shrink: 0; }

    .j-back-to-top { position: fixed; bottom: 24px; right: 24px; z-index: 20; width: 44px; height: 44px; border-radius: 50%; background: var(--guava-700); color: #fff; border: none; box-shadow: var(--shadow-raised); cursor: pointer; display: none; align-items: center; justify-content: center; transition: background 0.12s, opacity 0.15s; }
    .j-back-to-top.is-visible { display: flex; }
    .j-back-to-top:hover { background: var(--guava-800); }
    .j-back-to-top svg { width: 18px; height: 18px; }
    @media (max-width: 600px) { .j-back-to-top { bottom: 76px; right: 16px; } }
    .j-card-entry { font-size: 13px; margin-top: 4px; }
    .j-card-auto-more { font-size: 11px; color: var(--ink-4); font-style: italic; padding-top: 2px; }
    /* "Today I learned" block on the day card. Sits under the
       reflection / mood block, gets its own small label like the
       'What happened' / 'What you finished' auto sections. */
    .j-card-learning { margin-top: 10px; padding-top: 8px; border-top: 1px dashed var(--edge); }
    .j-card-learning-label {
      font-size: 10px; font-weight: 700; color: var(--ink-4);
      letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 4px;
    }
    .j-card-learning .j-card-text { font-size: 13px; }

    .j-load-sentinel { padding: 24px 0; text-align: center; font-size: 12px; color: var(--ink-4); }

    /* Edit modal */
    .j-edit-modal { position: fixed; inset: 0; background: rgba(20,15,10,0.45); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); display: flex; align-items: flex-start; justify-content: center; z-index: 1100; overflow-y: auto; padding: 40px 16px; }
    @media (max-width: 600px) { .j-edit-modal { padding: 24px 14px; align-items: center; } }
    .j-edit-card { background: var(--surface); border-radius: var(--r-md); max-width: 680px; width: 100%; box-shadow: var(--shadow-raised); margin-bottom: 40px; max-height: calc(100vh - 80px); display: flex; flex-direction: column; overflow: hidden; }
    @media (max-width: 600px) { .j-edit-card { max-height: calc(100vh - 48px); margin-bottom: 0; } }
    .j-edit-head { display: flex; justify-content: space-between; align-items: flex-start; padding: 18px 22px 14px; border-bottom: 1px solid var(--edge); flex-shrink: 0; }
    .j-edit-title { font-size: 18px; font-weight: 600; color: var(--ink); letter-spacing: -0.02em; line-height: 1.2; }
    .j-edit-save-ind { font-size: 11px; color: var(--ink-4); margin-top: 4px; }
    .j-edit-save-ind.saved { color: var(--moss-fg); }
    .j-edit-save-ind.error { color: var(--guava-700); }
    .j-edit-close { background: none; border: none; cursor: pointer; color: var(--ink-3); padding: 4px 8px; font-size: 22px; line-height: 1; border-radius: var(--r-sm); }
    .j-edit-close:hover { background: var(--surface-2); color: var(--ink); }
    .j-edit-body { padding: 18px 22px 8px; overflow-y: auto; flex: 1; min-height: 0; }
    .j-edit-footer { padding: 14px 22px 18px; border-top: 1px solid var(--edge); flex-shrink: 0; background: var(--surface); }
    .j-edit-submit { width: 100%; background: var(--guava-700); color: #fff; border: none; padding: 11px 18px; font-family: inherit; font-size: 13px; font-weight: 600; border-radius: var(--r-md); cursor: pointer; }
    .j-edit-submit:hover { background: var(--guava-800); }

    .j-view-photos { display: flex; flex-direction: column; gap: 10px; margin-bottom: 18px; }
    .j-view-photos img { width: 100%; max-height: 70vh; border-radius: var(--r-md); display: block; cursor: zoom-in; object-fit: contain; background: #1a1714; }
    .j-view-mood-title { font-size: 18px; font-weight: 600; color: var(--ink); margin-bottom: 8px; letter-spacing: -0.01em; line-height: 1.3; }
    .j-view-text { font-size: 14px; color: var(--ink-2); line-height: 1.7; white-space: pre-wrap; word-break: break-word; }

    .j-section { margin-bottom: 22px; }
    .j-section-h { font-size: 10px; font-weight: 700; color: var(--ink-4); letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 8px; }
    .j-list-row { display: flex; gap: 8px; padding: 6px 0; font-size: 13px; color: var(--ink-2); line-height: 1.5; align-items: center; }
    .j-list-row .j-bullet { color: var(--guava-500); flex-shrink: 0; }
    .j-list-row .j-check { color: var(--moss-fg); flex-shrink: 0; font-weight: 700; }
    .j-empty-row { font-size: 12px; color: var(--ink-4); font-style: italic; padding: 4px 0; }
    .j-error-row { font-size: 12px; color: var(--guava-700); padding: 4px 0; line-height: 1.5; }
    .j-error-row a { color: var(--guava-800); text-decoration: underline; cursor: pointer; }
    /* Phase 5 — tappable event row. Cursor hint + subtle hover bg so
       users discover the affordance. Energy emoji + tag chip surface
       on the right side when meta exists. */
    .j-event-row { border-radius: 4px; }
    .j-event-row.is-editable { cursor: pointer; }
    .j-event-row.is-editable:hover { background: var(--surface-2); padding-left: 4px; padding-right: 4px; margin-left: -4px; margin-right: -4px; }
    .j-event-text { flex: 1; min-width: 0; }
    .j-event-energy { font-size: 14px; line-height: 1; flex-shrink: 0; }
    .j-event-tag {
      display: inline-block; flex-shrink: 0;
      font-size: 10px; font-weight: 700; letter-spacing: .03em;
      padding: 2px 8px; border-radius: 999px;
      background: var(--surface-2); color: var(--ink-3);
      text-transform: uppercase;
    }
    /* Phase 5 — event meta editor modal. Built on the journal-native
       .j-edit-modal/.j-edit-card chrome so the styles are always loaded
       (the previous build used train-* classes which only injected when
       the user opened the Train tab — leading to an un-styled overlay
       that rendered as block content at the bottom of the page). */
    .j-event-meta-modal .j-edit-card { max-width: 480px; }
    .j-event-meta-time {
      font-size: 11px; color: var(--ink-4); margin-top: 4px;
      letter-spacing: 0.02em;
    }
    /* Relationship dropdown — native <select> styled to match the
       journal's input look. Caret-down chevron drawn via SVG bg. */
    .j-event-meta-tag {
      width: 100%; box-sizing: border-box;
      padding: 8px 36px 8px 12px; font-size: 14px;
      background: var(--surface);
      border: 1px solid var(--edge-strong);
      border-radius: var(--r-sm);
      color: var(--ink);
      font-family: inherit;
      cursor: pointer;
      appearance: none; -webkit-appearance: none; -moz-appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%236e6559' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 12px center;
    }
    .j-event-meta-tag:focus { outline: 2px solid var(--guava-700); outline-offset: -1px; }
    .j-event-meta-footer {
      display: flex; gap: 8px; align-items: center; justify-content: flex-end;
      flex-wrap: wrap;
    }
    .j-event-meta-footer .j-edit-submit {
      width: auto; padding: 8px 16px;
    }
    .j-edit-cancel {
      background: var(--surface); color: var(--ink-2);
      border: 1px solid var(--edge-strong);
      padding: 8px 16px; font-family: inherit; font-size: 13px;
      font-weight: 600; border-radius: var(--r-md); cursor: pointer;
    }
    .j-edit-cancel:hover { background: var(--surface-2); }
    .j-event-meta-remove {
      margin-right: auto;       /* push Cancel + Save to the right */
      background: none; border: 0;
      color: var(--guava-700); cursor: pointer;
      font-family: inherit; font-size: 12px; font-weight: 600;
      padding: 6px 8px;
    }
    .j-event-meta-remove:hover { color: var(--guava-800); text-decoration: underline; }
    /* (.j-event-chip-row / .j-event-chip removed — relationship is now
        a native <select> dropdown.) */

    .j-photos { display: flex; flex-wrap: wrap; gap: 10px; }
    .j-photo { position: relative; width: 88px; height: 88px; border-radius: var(--r-md); overflow: hidden; background: var(--surface-2); border: 1px solid var(--edge); cursor: pointer; }
    .j-photo img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .j-photo-del { position: absolute; top: 4px; right: 4px; background: rgba(0,0,0,0.6); border: none; color: #fff; width: 20px; height: 20px; border-radius: 50%; font-size: 11px; cursor: pointer; line-height: 1; padding: 0; display: flex; align-items: center; justify-content: center; }
    .j-photo-del:hover { background: rgba(0,0,0,0.85); }
    .j-photo-add { width: 88px; height: 88px; border: 1.5px dashed var(--edge-strong); border-radius: var(--r-md); background: none; cursor: pointer; color: var(--ink-3); display: flex; align-items: center; justify-content: center; font-size: 22px; font-weight: 300; }
    .j-photo-add:hover { border-color: var(--guava-500); color: var(--guava-700); background: var(--guava-50); }

    .j-textarea { width: 100%; min-height: 140px; padding: 12px 14px; border: 1px solid var(--edge-strong); border-radius: var(--r-md); background: var(--surface); font-family: inherit; font-size: 14px; line-height: 1.65; color: var(--ink); resize: vertical; outline: none; box-sizing: border-box; }
    .j-textarea:focus { border-color: var(--guava-500); box-shadow: var(--shadow-focus); }

    .j-mood { display: flex; gap: 8px; flex-wrap: wrap; }
    .j-mood-btn { width: 44px; height: 44px; border-radius: 50%; background: var(--surface-2); border: 1.5px solid transparent; cursor: pointer; font-size: 22px; padding: 0; display: flex; align-items: center; justify-content: center; transition: transform 0.1s; }
    .j-mood-btn:hover { transform: scale(1.08); }
    .j-mood-btn.is-selected { border-color: var(--guava-700); background: var(--guava-50); }
    /* Phase 5 — today's edit-modal picker is read-only; intra-day
       check-ins on Home are the new entry point. */
    .j-mood.is-readonly .j-mood-btn { cursor: default; opacity: 0.65; }
    .j-mood.is-readonly .j-mood-btn:hover { transform: none; }
    .j-mood-btn[disabled] { pointer-events: none; }
    .j-mood-hint { font-size: 11px; color: var(--ink-4); margin-top: 8px; line-height: 1.4; }

    /* Photo source modal */
    .j-photo-modal { position: fixed; inset: 0; background: rgba(20,15,10,0.45); display: flex; align-items: center; justify-content: center; z-index: 1200; padding: 20px; }
    .j-photo-modal-card { background: var(--surface); border-radius: var(--r-lg); padding: 22px; max-width: 360px; width: 100%; box-shadow: var(--shadow-raised); }
    .j-photo-modal-h { font-size: 15px; font-weight: 600; color: var(--ink); margin-bottom: 14px; }
    .j-photo-modal-opt { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border: 1px solid var(--edge); border-radius: var(--r-md); background: var(--surface); cursor: pointer; width: 100%; font-family: inherit; text-align: left; margin-bottom: 8px; transition: background 0.12s; }
    .j-photo-modal-opt:hover { background: var(--surface-2); }
    .j-photo-modal-opt svg { width: 20px; height: 20px; color: var(--ink-3); flex-shrink: 0; }
    .j-photo-modal-opt-text { display: flex; flex-direction: column; gap: 2px; }
    .j-photo-modal-opt-name { font-size: 13px; font-weight: 600; color: var(--ink); }
    .j-photo-modal-opt-desc { font-size: 11px; color: var(--ink-4); }
    .j-photo-modal-cancel { background: none; border: none; color: var(--ink-3); padding: 10px; cursor: pointer; font-family: inherit; font-size: 12px; width: 100%; margin-top: 4px; }
    .j-photo-modal-cancel:hover { color: var(--ink); }

    /* Lightbox */
    .j-lightbox { position: fixed; inset: 0; background: rgba(0,0,0,0.92); display: flex; align-items: center; justify-content: center; z-index: 1300; cursor: zoom-out; }
    .j-lightbox-img { max-width: 95vw; max-height: 92vh; object-fit: contain; box-shadow: 0 4px 30px rgba(0,0,0,0.5); border-radius: 4px; }
    .j-lightbox-close { position: absolute; top: 14px; right: 14px; background: rgba(255,255,255,0.12); border: none; color: #fff; width: 36px; height: 36px; border-radius: 50%; cursor: pointer; font-size: 20px; line-height: 1; display: flex; align-items: center; justify-content: center; }
    .j-lightbox-close:hover { background: rgba(255,255,255,0.22); }
    .j-lightbox-nav { position: absolute; top: 50%; transform: translateY(-50%); background: rgba(255,255,255,0.12); border: none; color: #fff; width: 44px; height: 44px; border-radius: 50%; cursor: pointer; font-size: 20px; line-height: 1; display: flex; align-items: center; justify-content: center; }
    .j-lightbox-nav:hover { background: rgba(255,255,255,0.22); }
    .j-lightbox-nav.prev { left: 16px; }
    .j-lightbox-nav.next { right: 16px; }
    .j-lightbox-counter { position: absolute; bottom: 16px; left: 50%; transform: translateX(-50%); color: #fff; font-size: 12px; opacity: 0.75; }
  `;
  document.head.appendChild(style);
}

/* ── ESCAPE / UTILITY ────────────────────────────────────── */

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function isEntryEmpty(entry) {
  if (!entry) return true;
  return !((entry.reflections && entry.reflections.trim()) || entry.mood || (entry.photos && entry.photos.length) || (entry.learning && entry.learning.trim()));
}

// Journal nav badge: ✓ when today's entry is filled, ! when it isn't.
function updateJournalBadge() {
  const filled = !isEntryEmpty(journalState.entries.get(jToday()));
  const mark = filled ? '✓' : '!';
  const mb = document.getElementById('journalBadgeMobile');
  if (mb) { mb.textContent = mark; mb.dataset.empty = 'false'; mb.classList.toggle('badge-ok', filled); }
  const sb = document.getElementById('sidebarJournalCount');
  if (sb) sb.textContent = mark;
}

/* ── CALENDAR POPOVER ────────────────────────────────────── */

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
    cells.push({ d, ds, isToday: ds === today, hasEntry: journalState.entries.has(ds), isFuture: ds > today });
  }
  const dowRow = ['S','M','T','W','T','F','S'].map(l => `<div class="j-cal-dow">${l}</div>`).join('');
  const cellsHtml = cells.map(c => {
    if (c.blank) return `<div class="j-cal-cell is-other"></div>`;
    const cls = ['j-cal-cell'];
    if (c.isToday) cls.push('is-today');
    if (c.hasEntry) cls.push('has-entry');
    const disabled = c.isFuture ? 'disabled' : '';
    return `<button class="${cls.join(' ')}" data-jcal-date="${c.ds}" ${disabled}>${c.d}</button>`;
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

/* ── PHOTO GRID (in card) ────────────────────────────────── */

// Combine an entry's photo sources into a single ordered list of
// renderable src strings. Order: legacy photos[] data-URLs first (so
// existing layouts don't reshuffle), then Storage-hosted photo_paths
// resolved via signed URLs. Paths whose signed URLs aren't cached yet
// return null in the list — render skips them on this pass and kicks
// an async resolution that re-renders the card when URLs arrive.
// Phase 2 audit: keeps cards painting fast (data-URLs render
// immediately, Storage photos pop in shortly after).
function resolveEntryPhotoSrcs(dateStr, entry) {
  const legacyData = Array.isArray(entry?.photos) ? entry.photos : [];
  const paths = Array.isArray(entry?.photo_paths) ? entry.photo_paths : [];
  const srcs = [...legacyData];
  let needFetch = false;
  for (const p of paths) {
    const hit = _photoUrlCache.get(p);
    if (hit && hit.expiresAt > Date.now() + 60_000) {
      srcs.push(hit.url);
    } else {
      needFetch = true;
      // Skip this entry from the renderable list for now — it'll
      // appear after async resolution + rerenderTimelineCard.
    }
  }
  if (needFetch && paths.length) {
    // Fire-and-forget. signedUrlsForPaths is idempotent (cache hits
    // skip the network); rerenderTimelineCard is a no-op for cards
    // not in the DOM (content-visibility:auto + offscreen-skip).
    signedUrlsForPaths(paths).then(() => {
      if (typeof rerenderTimelineCard === 'function') rerenderTimelineCard(dateStr);
    });
  }
  return srcs;
}

function renderCardPhotos(dateStr, photosOrEntry) {
  // Accept either a raw photos array (legacy callers) or an entry
  // object with photos + photo_paths (new callers). The entry path
  // resolves Storage paths to signed URLs and falls back to legacy
  // data-URLs when present.
  let photos;
  if (Array.isArray(photosOrEntry)) {
    photos = photosOrEntry;
  } else if (photosOrEntry && typeof photosOrEntry === 'object') {
    photos = resolveEntryPhotoSrcs(dateStr, photosOrEntry);
  } else {
    photos = [];
  }
  if (!photos?.length) return '';
  const n = photos.length;
  let cls, items;
  if (n === 1) {
    cls = 'j-card-photos--1';
    const src = photos[0];
    items = `<img class="j-card-photo-bg" src="${src}" alt="" aria-hidden="true" />` +
            `<img src="${src}" data-jlightbox="${dateStr}|0" alt="" />`;
  } else if (n === 2) {
    cls = 'j-card-photos--2';
    items = photos.slice(0, 2).map((src, i) => `<img src="${src}" data-jlightbox="${dateStr}|${i}" alt="" />`).join('');
  } else if (n === 3) {
    cls = 'j-card-photos--3';
    items = photos.slice(0, 3).map((src, i) => `<img src="${src}" data-jlightbox="${dateStr}|${i}" alt="" />`).join('');
  } else if (n === 4) {
    cls = 'j-card-photos--4';
    items = photos.slice(0, 4).map((src, i) => `<img src="${src}" data-jlightbox="${dateStr}|${i}" alt="" />`).join('');
  } else {
    cls = 'j-card-photos--5plus';
    const first4 = photos.slice(0, 4).map((src, i) => `<img src="${src}" data-jlightbox="${dateStr}|${i}" alt="" />`).join('');
    const fifth = photos[4];
    const extra = n - 5;
    const moreCls = extra > 0 ? ' class="j-card-photo-more" data-extra="+' + extra + '"' : '';
    items = first4 + `<div${moreCls}><img src="${fifth}" data-jlightbox="${dateStr}|4" alt="" /></div>`;
  }
  return `<div class="j-card-photos ${cls}">${items}</div>`;
}

/* ── DAY CARD ────────────────────────────────────────────── */

function renderDayCard(dateStr) {
  const entry = journalState.entries.get(dateStr);
  const isToday = jIsToday(dateStr);
  const hasReflection = !!(entry?.reflections && entry.reflections.trim());
  const hasLearning   = !!(entry?.learning && entry.learning.trim());
  const hasMood = !!entry?.mood;
  // hasPhotos checks BOTH the legacy photos[] (data-URLs) and the new
  // photo_paths[] (Storage paths) — either source indicates the entry
  // has photos to render.
  const hasPhotos = !!(entry?.photos?.length || entry?.photo_paths?.length);
  const hasManual = hasReflection || hasMood || hasPhotos || hasLearning;

  // Auto-collected: events + completed tasks
  const events = journalState.calendarEvents.get(dateStr) || [];
  const tasksDone = getCompletedTasksForDate(dateStr);
  const hasAuto = events.length > 0 || tasksDone.length > 0;

  // Past day with literally nothing: minimal clickable placeholder
  if (!hasManual && !hasAuto && !isToday) {
    return `
      <div class="j-card j-card--placeholder" data-jcard-date="${dateStr}" data-jcard-edit="${dateStr}">
        <div class="j-card-placeholder-text">${jFormatCardDate(dateStr)} · No activity</div>
      </div>`;
  }

  // Card content. Pass the full entry so renderCardPhotos can resolve
  // photo_paths[] → signed URLs + fall back to legacy photos[] data-URLs.
  const photosHtml = hasPhotos ? renderCardPhotos(dateStr, entry) : '';
  const reflection = (entry?.reflections || '').trim();
  const lines = reflection.split(/\n+/);
  const title = lines[0] || '';
  const body = lines.slice(1).join('\n').trim();
  const moodIcon = hasMood ? `<span class="j-card-mood-inline">${MOOD_EMOJI[entry.mood-1]}</span>` : '';

  let manualHtml = '';
  if (!hasManual && isToday) {
    manualHtml = `<div class="j-card-start-wrap"><button class="j-card-start-btn" data-jcard-edit="${dateStr}" type="button">Start writing</button></div>`;
  } else if (hasMood) {
    const fullReflection = [title, body].filter(Boolean).join('\n').trim();
    const entryHtml = fullReflection
      ? `<div class="j-card-text j-card-text--clamped j-card-entry">${escapeHtml(fullReflection)}</div>`
      : '';
    manualHtml = `<div class="j-card-title">${moodIcon}Feeling ${MOOD_LABEL[entry.mood-1]}</div>${entryHtml}`;
  } else if (title || body) {
    manualHtml = `
      ${title ? `<div class="j-card-title">${escapeHtml(title)}</div>` : ''}
      ${body ? `<div class="j-card-text j-card-text--clamped">${escapeHtml(body)}</div>` : ''}`;
  }
  // "Today I learned" — its own labeled block on the card, shown
  // whenever the entry has learning text. Sits under the reflection /
  // mood block in the same manual section.
  if (hasLearning) {
    manualHtml += `<div class="j-card-learning">
      <div class="j-card-learning-label">Today I learned</div>
      <div class="j-card-text j-card-text--clamped">${escapeHtml(entry.learning.trim())}</div>
    </div>`;
  }

  let autoHtml = '';
  if (events.length) {
    const items = events.slice(0, 4).map(ev => {
      const time = ev.isAllDay ? 'All day' : new Date(ev.start).toLocaleTimeString(undefined, { hour:'numeric', minute:'2-digit' });
      return `<div class="j-card-auto-row"><span class="j-bullet">•</span><span>${escapeHtml(ev.summary)} · ${time}</span></div>`;
    }).join('');
    const more = events.length > 4 ? `<div class="j-card-auto-more">+${events.length - 4} more</div>` : '';
    autoHtml += `<div class="j-card-auto"><div class="j-card-auto-label">What happened</div>${items}${more}</div>`;
  }
  if (tasksDone.length) {
    const items = tasksDone.slice(0, 4).map(t => `<div class="j-card-auto-row"><span class="j-check">✓</span><span>${escapeHtml(t.text)}</span></div>`).join('');
    const more = tasksDone.length > 4 ? `<div class="j-card-auto-more">+${tasksDone.length - 4} more</div>` : '';
    autoHtml += `<div class="j-card-auto"><div class="j-card-auto-label">What you finished</div>${items}${more}</div>`;
  }
  const habitStats = isJournalSectionEnabled('habits') ? getHabitCompletionForDate(dateStr) : null;
  if (habitStats) {
    autoHtml += `<div class="j-card-auto"><div class="j-card-auto-label">Daily habits</div><div class="j-card-auto-row"><span class="j-card-habit-pct">${habitStats.pct}%</span><span>- ${habitStats.done}/${habitStats.due} completed</span></div></div>`;
  }

  const bodyHtml = (manualHtml || autoHtml)
    ? `<div class="j-card-body">${manualHtml}${autoHtml}</div>`
    : '';

  const todayLabel = isToday ? ' · Today' : '';
  const isStartWriting = !hasManual && isToday;
  const addPhotoHtml = `
        <button class="j-card-edit j-card-add-photo" data-jcard-add-photo="${dateStr}" title="Add photos" type="button">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
          <span class="j-card-edit-label">Add photos</span>
        </button>`;
  const footerEditHtml = isStartWriting ? '' : `
        <button class="j-card-edit" data-jcard-edit="${dateStr}" title="Edit">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
          <span class="j-card-edit-label">Edit</span>
        </button>`;

  // Empty today (no manual, no auto) → tap card opens edit directly. Otherwise tap opens read-only view.
  const cardActionAttr = (hasManual || hasAuto)
    ? `data-jcard-view="${dateStr}"`
    : `data-jcard-edit="${dateStr}"`;

  return `
    <div class="j-card" data-jcard-date="${dateStr}" ${cardActionAttr}>
      ${photosHtml}
      ${bodyHtml}
      <div class="j-card-footer">
        <span class="j-card-date">${jFormatCardDate(dateStr)}${todayLabel}</span>
        <div class="j-card-footer-actions">
          ${addPhotoHtml}
          ${footerEditHtml}
        </div>
      </div>
    </div>`;
}

/* ── TIMELINE ────────────────────────────────────────────── */

function getTimelineDateList() {
  const dates = [];
  const today = jToday();
  const lastDate = journalState.timelineLoadedThrough || jShiftDays(today, -(journalState.timelineDays - 1));
  let d = today;
  while (d >= lastDate) {
    dates.push(d);
    d = jShiftDays(d, -1);
  }
  return dates;
}

function renderTimeline() {
  const dates = getTimelineDateList();
  const html = dates.map(renderDayCard).join('');
  return `
    <div class="j-timeline" id="jTimeline">
      ${html}
      <div class="j-load-sentinel" id="jLoadSentinel">Loading older entries…</div>
    </div>`;
}

function rerenderTimeline() {
  const root = document.getElementById('jTimeline');
  if (!root) return;
  const dates = getTimelineDateList();
  const sentinel = document.getElementById('jLoadSentinel');
  const sentinelText = journalState.timelineLoading ? 'Loading older entries…' : 'Scroll for more';

  // Cold start (or root was cleared) — build everything in one shot, attach
  // the IntersectionObserver to the new sentinel.
  if (!sentinel || sentinel.parentNode !== root) {
    root.innerHTML = dates.map(renderDayCard).join('')
      + `<div class="j-load-sentinel" id="jLoadSentinel">${sentinelText}</div>`;
    setupScrollObserver();
    return;
  }

  // Incremental: append only dates not already in the DOM. Dates are returned
  // newest-first; missing ones are guaranteed older than the last-rendered
  // card and go before the sentinel. The sentinel stays as the same node, so
  // the IntersectionObserver doesn't have to re-attach on every scroll-load.
  const rendered = new Set();
  root.querySelectorAll('[data-jcard-date]').forEach(el => rendered.add(el.dataset.jcardDate));
  const toAppend = dates.filter(d => !rendered.has(d));
  if (toAppend.length === 0) {
    sentinel.textContent = sentinelText;
    return;
  }
  const tmp = document.createElement('div');
  tmp.innerHTML = toAppend.map(renderDayCard).join('');
  const frag = document.createDocumentFragment();
  while (tmp.firstElementChild) frag.appendChild(tmp.firstElementChild);
  root.insertBefore(frag, sentinel);
  sentinel.textContent = sentinelText;
}

async function loadInitialTimeline() {
  console.time('[perf] journal.loadInitial');
  const today = jToday();
  const start = jShiftDays(today, -(journalState.timelineDays - 1));
  journalState.timelineLoadedThrough = start;
  await Promise.all([
    loadJournalRange(start, today),
    loadCalendarCacheRange(start, today),
    loadHabitSummariesForRange(start, today),
  ]);
  console.timeEnd('[perf] journal.loadInitial');
  console.log(`[perf] journal.loadInitial window: ${journalState.timelineDays}d, entries=${journalState.entries.size}, events=${journalState.calendarEvents.size}`);
  // Meta load is scoped to the events that just landed in the cache —
  // ensures the editor affordance (relationship/energy tags on event
  // rows) renders without a full-history query. Fire-and-forget so the
  // timeline can paint immediately.
  loadCalendarEventMetaForEvents(collectLoadedEventIds());
}

async function loadOlderTimelineDays(count = 7) {
  if (journalState.timelineLoading) return;
  journalState.timelineLoading = true;
  const oldStart = journalState.timelineLoadedThrough || jToday();
  const newStart = jShiftDays(oldStart, -count);
  const newEnd = jShiftDays(oldStart, -1);
  await Promise.all([
    loadJournalRange(newStart, newEnd),
    loadCalendarCacheRange(newStart, newEnd),
    loadHabitSummariesForRange(newStart, newEnd),
  ]);
  journalState.timelineLoadedThrough = newStart;
  journalState.timelineDays += count;
  journalState.timelineLoading = false;
  rerenderTimeline();
  // Pull meta for the newly-loaded events too (scoped — fetched-set
  // dedupe means already-loaded IDs won't be re-requested).
  loadCalendarEventMetaForEvents(collectLoadedEventIds());
}

async function ensureTimelineCovers(dateStr) {
  const today = jToday();
  if (dateStr > today) return; // future not allowed
  const currentEarliest = journalState.timelineLoadedThrough || jShiftDays(today, -(journalState.timelineDays - 1));
  if (dateStr >= currentEarliest) return;
  // Need to extend back to dateStr (with a small buffer)
  const target = jShiftDays(dateStr, -7);
  const newEnd = jShiftDays(currentEarliest, -1);
  await Promise.all([
    loadJournalRange(target, newEnd),
    loadHabitSummariesForRange(target, newEnd),
  ]);
  // Update window
  const todayDate = jParseDate(today);
  const targetDate = jParseDate(target);
  const days = Math.round((todayDate - targetDate) / 86400000) + 1;
  journalState.timelineDays = days;
  journalState.timelineLoadedThrough = target;
  rerenderTimeline();
  loadCalendarEventMetaForEvents(collectLoadedEventIds());
}

function scrollTimelineToDate(dateStr) {
  const card = document.querySelector(`[data-jcard-date="${dateStr}"]`);
  if (card) {
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function setupScrollObserver() {
  const sentinel = document.getElementById('jLoadSentinel');
  if (!sentinel) return;
  if (journalState._observer) journalState._observer.disconnect();
  const obs = new IntersectionObserver(entries => {
    if (entries.some(e => e.isIntersecting)) loadOlderTimelineDays(7);
  }, { rootMargin: '300px' });
  obs.observe(sentinel);
  journalState._observer = obs;
}

/* ── HEADER ──────────────────────────────────────────────── */

function renderJournalHeader() {
  const greeting = getTimeBasedGreeting(getFirstName());
  return `
    <div class="j-header">
      <div class="j-page-title">${escapeHtml(greeting)}</div>
    </div>`;
}

function renderJournalSearchRow() {
  const calOn = journalState.calendarOpen ? ' is-on' : '';
  return `
    <div class="j-search-row" id="jSearchRow">
      <div class="j-search-bar">
        <svg class="j-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input type="text" class="j-search-input" id="jSearchInput" placeholder="Search entries, events, tasks…" value="${escapeHtml(journalState.searchQuery)}" />
        <div id="jSearchResults"></div>
      </div>
      <button class="j-action-btn${calOn}" id="jCalToggle" title="Choose date" aria-pressed="${journalState.calendarOpen}" type="button">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
      </button>
      <div id="jCalPopSlot" class="j-cal-pop-slot" style="${journalState.calendarOpen ? '' : 'display:none'}">${renderJournalCalendar()}</div>
    </div>`;
}

function setCalendarOpen(open) {
  journalState.calendarOpen = open;
  const btn = document.getElementById('jCalToggle');
  if (btn) {
    btn.classList.toggle('is-on', open);
    btn.setAttribute('aria-pressed', String(open));
  }
  const popSlot = document.getElementById('jCalPopSlot');
  if (popSlot) popSlot.style.display = open ? '' : 'none';
}

function rerenderJournalCalendarPopover() {
  const existing = document.getElementById('jCalPop');
  if (existing) existing.outerHTML = renderJournalCalendar();
}

/* ── EDIT MODAL ──────────────────────────────────────────── */

function renderEventsSection(ds) {
  if (!journalState.calendarEvents.has(ds) && !journalState.eventsError.has(ds)) {
    return `<div class="j-empty-row">Loading…</div>`;
  }
  const err = journalState.eventsError.get(ds);
  if (err === 'expired') return `<div class="j-error-row">Couldn't reach Google Calendar — your sign-in may need to be refreshed. <a data-jrefresh-auth="1">Refresh sign-in</a></div>`;
  if (err === 'api') return `<div class="j-error-row">Calendar unavailable — please try again. <a data-jretry-events="1">Retry</a></div>`;
  const events = journalState.calendarEvents.get(ds) || [];
  if (!events.length) return `<div class="j-empty-row">No calendar events.</div>`;
  return events.map(ev => {
    const time = ev.isAllDay ? 'All day' : new Date(ev.start).toLocaleTimeString(undefined, { hour:'numeric', minute:'2-digit' });
    // Phase 5: tag indicator + tap-to-edit. Events fetched before the
    // Phase 5 commit that captured `id` won't have one — they render
    // without the editor affordance until the next calendar sync.
    const meta = ev.id ? journalState.eventMeta.get(ev.id) : null;
    const energyEmoji = (meta && meta.energy_after) ? MOOD_EMOJI[meta.energy_after - 1] : '';
    const tagBadge = (meta && meta.relationship_tag)
      ? `<span class="j-event-tag">${escapeHtml(meta.relationship_tag)}</span>` : '';
    const clickable = ev.id ? ` data-jevent-edit="${escapeHtml(ev.id)}"` : '';
    const editCls = ev.id ? ' is-editable' : '';
    return `<div class="j-list-row j-event-row${editCls}"${clickable}>
      <span class="j-bullet">•</span>
      <span class="j-event-text">${escapeHtml(ev.summary)} · ${time}</span>
      ${energyEmoji ? `<span class="j-event-energy" title="Energy after">${energyEmoji}</span>` : ''}
      ${tagBadge}
    </div>`;
  }).join('');
}

/* ── Phase 5 — Calendar event metadata editor ───────────────────────
   Tap an event row → opens a sheet to record relationship_tag,
   energy_after, and notes. Same modal pattern as Train's Manage Plan
   (direct listeners on inner buttons; stop-propagation on the
   .train-modal-style wrapper). */
function openEventMetaEditor(eventId) {
  // Find the event in the in-memory cache so we can show its title/time.
  let ev = null;
  for (const events of journalState.calendarEvents.values()) {
    const hit = events.find(e => e.id === eventId);
    if (hit) { ev = hit; break; }
  }
  if (!ev) return;
  // Inject journal styles up-front. The modal uses .j-edit-modal /
  // .j-edit-card classes, which live in ensureJournalStyles() and are
  // normally injected only on the first renderJournal() call. When the
  // editor is opened from Home (Phase 5 home-event-click feature)
  // BEFORE the user has visited Journal, those styles don't exist yet
  // and the modal renders as flat HTML at the bottom of the page.
  // ensureJournalStyles is idempotent — safe to call from any surface.
  if (typeof ensureJournalStyles === 'function') ensureJournalStyles();
  closeEventMetaEditor();
  journalState.eventMetaEditing = eventId;
  const meta = journalState.eventMeta.get(eventId) || {};
  const time = ev.isAllDay ? 'All day' : new Date(ev.start).toLocaleTimeString(undefined, { hour:'numeric', minute:'2-digit', weekday:'short', month:'short', day:'numeric' });

  // Relationship dropdown options. If the stored value is a legacy
  // custom string that's not in this list, it's appended as an extra
  // option below so users don't lose data on re-open.
  const RELATIONSHIPS = ['Boss', 'Peer', 'Direct report', 'Partner', 'Family', 'Friend', 'Date', 'Stranger'];
  const moodRow = MOOD_EMOJI.map((emoji, i) => {
    const val = i + 1;
    const sel = meta.energy_after === val ? ' is-selected' : '';
    return `<button type="button" class="j-mood-btn${sel}" data-jevent-energy="${val}" title="${MOOD_LABEL[i]}">${emoji}</button>`;
  }).join('');
  const cur = meta.relationship_tag || '';
  const isKnown = RELATIONSHIPS.includes(cur);
  const optionsHTML = RELATIONSHIPS.map(o =>
    `<option value="${escapeHtml(o)}"${cur === o ? ' selected' : ''}>${escapeHtml(o)}</option>`
  ).join('');
  const customOptionHTML = (cur && !isKnown)
    ? `<option value="${escapeHtml(cur)}" selected>${escapeHtml(cur)} (custom)</option>`
    : '';

  // Uses the journal-native modal classes (j-edit-modal / j-edit-card)
  // so the CSS is always present, regardless of whether the user has
  // visited Train this session.
  const html = `<div class="j-edit-modal j-event-meta-modal" id="jEventMetaModal">
    <div class="j-edit-card" data-modal-stop>
      <div class="j-edit-head">
        <div>
          <div class="j-edit-title">${escapeHtml(ev.summary)}</div>
          <div class="j-event-meta-time">${escapeHtml(time)}</div>
        </div>
        <button class="j-edit-close" data-modal-close title="Close" type="button">×</button>
      </div>
      <div class="j-edit-body">
        <div class="j-section">
          <div class="j-section-h">Relationship</div>
          <select class="j-event-meta-tag" id="jEventTag">
            <option value="">— None —</option>
            ${optionsHTML}
            ${customOptionHTML}
          </select>
        </div>
        <div class="j-section">
          <div class="j-section-h">Energy after</div>
          <div class="j-mood">${moodRow}</div>
        </div>
        <div class="j-section">
          <div class="j-section-h">Notes</div>
          <textarea class="j-textarea" id="jEventNotes" maxlength="400" placeholder="What happened? Decisions, vibes, follow-ups…">${escapeHtml(meta.notes || '')}</textarea>
        </div>
      </div>
      <div class="j-edit-footer j-event-meta-footer">
        ${meta.energy_after != null || meta.relationship_tag || meta.notes
          ? `<button class="j-event-meta-remove" data-jevent-remove type="button">Remove</button>` : ''}
        <button class="j-edit-cancel" data-modal-close type="button">Cancel</button>
        <button class="j-edit-submit" data-jevent-save type="button">Save</button>
      </div>
    </div>
  </div>`;

  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  const overlay = wrap.firstElementChild;
  document.body.appendChild(overlay);

  // Click-outside-to-close.
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeEventMetaEditor(); });
  overlay.querySelector('[data-modal-stop]')?.addEventListener('click', (e) => e.stopPropagation());
  overlay.querySelectorAll('[data-modal-close]').forEach(b => b.addEventListener('click', closeEventMetaEditor));

  // Energy buttons toggle selection in-place (single-select).
  overlay.querySelectorAll('[data-jevent-energy]').forEach(b => {
    b.addEventListener('click', () => {
      overlay.querySelectorAll('[data-jevent-energy]').forEach(x => x.classList.remove('is-selected'));
      b.classList.add('is-selected');
      b.dataset.selected = '1';
    });
  });
  // Initial selection — mark current value if any.
  if (meta.energy_after != null) {
    const cur = overlay.querySelector(`[data-jevent-energy="${meta.energy_after}"]`);
    if (cur) cur.dataset.selected = '1';
  }

  // (Chip click handler removed — relationship is now a native <select>
  //  so the dropdown UI does the picking itself.)

  // Save / Remove.
  overlay.querySelector('[data-jevent-save]')?.addEventListener('click', () => {
    const tag    = overlay.querySelector('#jEventTag')?.value.trim() || null;
    const notes  = overlay.querySelector('#jEventNotes')?.value.trim() || null;
    const selectedBtn = overlay.querySelector('[data-jevent-energy][data-selected="1"]');
    const energy = selectedBtn ? Number(selectedBtn.dataset.jeventEnergy) : null;
    saveEventMeta(eventId, ev, { relationship_tag: tag, energy_after: energy, notes });
  });
  overlay.querySelector('[data-jevent-remove]')?.addEventListener('click', () => {
    deleteEventMeta(eventId);
  });

  // Esc closes.
  const escHandler = (e) => { if (e.key === 'Escape') closeEventMetaEditor(); };
  document.addEventListener('keydown', escHandler);
  overlay.dataset._escBound = '1';
  overlay._escHandler = escHandler;

  setTimeout(() => overlay.querySelector('#jEventTag')?.focus(), 0);
}

function closeEventMetaEditor() {
  const overlay = document.getElementById('jEventMetaModal');
  if (overlay?._escHandler) document.removeEventListener('keydown', overlay._escHandler);
  overlay?.remove();
  journalState.eventMetaEditing = null;
}

async function saveEventMeta(eventId, ev, patch) {
  // No-op save when nothing's set — treat as remove for cleanliness.
  if (patch.relationship_tag == null && patch.energy_after == null && !patch.notes) {
    return deleteEventMeta(eventId);
  }
  try {
    const { data: { session } } = await db.auth.getSession();
    if (!session) return;
    const row = {
      user_id:            session.user.id,
      calendar_event_id:  eventId,
      google_calendar_id: ev.calendarId || null,
      event_summary:      ev.summary || null,
      event_start:        ev.start || null,
      relationship_tag:   patch.relationship_tag,
      energy_after:       patch.energy_after,
      notes:              patch.notes,
    };
    const { error } = await db.from('calendar_event_meta')
      .upsert(row, { onConflict: 'user_id,calendar_event_id' });
    if (error) throw error;
    journalState.eventMeta.set(eventId, {
      relationship_tag: patch.relationship_tag,
      energy_after:     patch.energy_after,
      notes:            patch.notes,
    });
    closeEventMetaEditor();
    // Re-render whatever date this event belongs to so the row picks up
    // the new energy emoji + tag badge immediately.
    rerenderEventDate(eventId);
  } catch (e) {
    console.warn('[journal] event meta save failed', e);
    if (typeof showToast === 'function') showToast('Save failed', 'offline');
  }
}

async function deleteEventMeta(eventId) {
  try {
    const { data: { session } } = await db.auth.getSession();
    if (!session) return;
    const { error } = await db.from('calendar_event_meta').delete()
      .eq('user_id', session.user.id)
      .eq('calendar_event_id', eventId);
    if (error) throw error;
    journalState.eventMeta.delete(eventId);
    closeEventMetaEditor();
    rerenderEventDate(eventId);
  } catch (e) {
    console.warn('[journal] event meta delete failed', e);
    if (typeof showToast === 'function') showToast('Delete failed', 'offline');
  }
}

// Find which dateStr owns this event id, then re-render that timeline card.
// Also opportunistically refresh the Home calendar section if it's
// mounted — the event-meta editor can be opened from Home too (since
// the Phase 5 hookup), so its save path needs to update both surfaces.
function rerenderEventDate(eventId) {
  for (const [date, events] of journalState.calendarEvents.entries()) {
    if (events.some(e => e.id === eventId)) {
      if (typeof rerenderTimelineCard === 'function') rerenderTimelineCard(date);
      break;
    }
  }
  if (typeof homeRerenderCalendarIfMounted === 'function') {
    homeRerenderCalendarIfMounted();
  }
}

function renderTasksSection(ds) {
  const tasksDone = getCompletedTasksForDate(ds);
  if (!tasksDone.length) return `<div class="j-empty-row">No tasks completed on this day.</div>`;
  return tasksDone.map(t => `<div class="j-list-row"><span class="j-check">✓</span><span>${escapeHtml(t.text)}</span></div>`).join('');
}

function renderEditModalBody(ds) {
  const entry = journalState.entries.get(ds) || { reflections: '', mood: null, photos: [], photo_paths: [], learning: '' };
  // Combined photo list — legacy data-URLs + Storage-hosted signed URLs.
  // resolveEntryPhotoSrcs handles the path → signed URL resolution
  // and kicks an async rerender if any signatures aren't cached.
  const allSrcs = resolveEntryPhotoSrcs(ds, entry);
  const photosHtml = allSrcs.map((src, i) =>
    `<div class="j-photo"><img src="${src}" alt="" data-jlightbox="${ds}|${i}" /><button class="j-photo-del" data-jphoto-del="${i}" title="Remove">×</button></div>`
  ).join('');
  // Phase 5 — for TODAY, the mood picker becomes read-only with a
  // pointer to the Home check-in flow (mood is now the rounded average
  // of intra-day check-ins). For PAST days, keep the existing manual
  // single-tap override since no check-in data exists for those dates.
  const isTodayEntry = ds === jToday();
  const moodHtml = MOOD_EMOJI.map((emoji, i) => {
    const sel = entry.mood === (i+1) ? ' is-selected' : '';
    const disabled = isTodayEntry ? ' disabled' : '';
    return `<button class="j-mood-btn${sel}" data-jmood="${i+1}" title="${MOOD_LABEL[i]}"${disabled}>${emoji}</button>`;
  }).join('');
  const moodHint = isTodayEntry
    ? `<div class="j-mood-hint">Today's mood is the average of your Home check-ins. Tap an emoji on the Home tab to log a check-in.</div>`
    : '';
  return `
    <div class="j-section">
      <div class="j-section-h">Daily Reflection</div>
      <textarea class="j-textarea" id="jReflections" placeholder="How did today go? What's on your mind?" spellcheck="true">${escapeHtml(entry.reflections || '')}</textarea>
    </div>
    <div class="j-section">
      <div class="j-section-h">Today I Learned</div>
      <textarea class="j-textarea" id="jLearning" placeholder="One thing you learned today…" spellcheck="true">${escapeHtml(entry.learning || '')}</textarea>
    </div>
    <div class="j-section">
      <div class="j-section-h">Mood</div>
      <div class="j-mood${isTodayEntry ? ' is-readonly' : ''}">${moodHtml}</div>
      ${moodHint}
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
    </div>`;
}

function openEditModal(dateStr) {
  if (jIsFuture(dateStr)) return;
  closeEditModal(true);  // close any existing first; skip card rerender
  journalState.editingDate = dateStr;
  const isToday = jIsToday(dateStr);
  const existing = journalState.entries.get(dateStr);
  const submitLabel = isEntryEmpty(existing)
    ? (isToday ? 'Submit My Day' : 'Save Entry')
    : (isToday ? 'Update My Day' : 'Update Entry');
  const html = `
    <div class="j-edit-modal" id="jEditModal">
      <div class="j-edit-card">
        <div class="j-edit-head">
          <div>
            <div class="j-edit-title">${jFormatLong(dateStr)}</div>
            <div class="j-edit-save-ind" id="jEditSaveInd"></div>
          </div>
          <button class="j-edit-close" id="jEditClose" title="Close">×</button>
        </div>
        <div class="j-edit-body" id="jEditBody">${renderEditModalBody(dateStr)}</div>
        <div class="j-edit-footer">
          <button class="j-edit-submit" id="jEditSubmit">${submitLabel}</button>
        </div>
        <input type="file" id="jHiddenPhotoInput" accept="image/*" multiple style="position:absolute;left:-9999px;opacity:0;" />
        <input type="file" id="jHiddenCameraInput" accept="image/*" capture="environment" style="position:absolute;left:-9999px;opacity:0;" />
      </div>
    </div>`;
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  document.body.appendChild(wrap.firstElementChild);
  document.body.style.overflow = 'hidden';
  fetchCalendarEventsForDate(dateStr).then(() => {
    if (journalState.editingDate === dateStr) {
      const slot = document.getElementById('jEventsSlot');
      if (slot) slot.innerHTML = renderEventsSection(dateStr);
    }
  });
  loadJournalEntry(dateStr).then(() => {
    if (journalState.editingDate === dateStr) {
      const body = document.getElementById('jEditBody');
      if (body) body.innerHTML = renderEditModalBody(dateStr);
    }
  });
}

function closeEditModal(skipRerender) {
  const m = document.getElementById('jEditModal');
  if (m) m.remove();
  document.body.style.overflow = '';
  if (!skipRerender && journalState.editingDate) {
    rerenderTimelineCard(journalState.editingDate);
    rerenderJournalCalendarPopover();
  }
  if (!skipRerender) journalState.editingDate = null;
}

function renderViewModalBody(dateStr) {
  const entry = journalState.entries.get(dateStr) || { reflections:'', mood:null, photos:[], photo_paths:[], learning:'' };
  const reflection = (entry.reflections || '').trim();
  const learning   = (entry.learning   || '').trim();
  const moodTitle = entry.mood
    ? `<div class="j-view-mood-title"><span class="j-card-mood-inline">${MOOD_EMOJI[entry.mood-1]}</span>Feeling ${MOOD_LABEL[entry.mood-1]}</div>`
    : '';
  const reflectionHtml = reflection ? `<div class="j-view-text">${escapeHtml(reflection)}</div>` : '';
  // Combined photo list (legacy + Storage). resolveEntryPhotoSrcs
  // handles signed-URL resolution and async rerender.
  const allSrcs = resolveEntryPhotoSrcs(dateStr, entry);
  const photosHtml = allSrcs.length
    ? `<div class="j-view-photos">${allSrcs.map((src, i) =>
        `<img src="${src}" data-jlightbox="${dateStr}|${i}" alt="" />`).join('')}</div>`
    : '';
  const habitStats = isJournalSectionEnabled('habits') ? getHabitCompletionForDate(dateStr) : null;
  const habitsBlock = habitStats
    ? `<div class="j-section">
         <div class="j-section-h">Daily habits</div>
         <div class="j-list-row"><span class="j-card-habit-pct">${habitStats.pct}%</span><span>- ${habitStats.done}/${habitStats.due} completed</span></div>
       </div>`
    : '';
  const manualBlock = (moodTitle || reflectionHtml)
    ? `<div class="j-section"><div class="j-section-h">Daily Reflection</div>${moodTitle}${reflectionHtml}</div>`
    : '';
  // "Today I learned" — own labeled section, mirrors the edit modal's
  // section structure so the read view and edit view feel consistent.
  const learningBlock = learning
    ? `<div class="j-section">
         <div class="j-section-h">Today I learned</div>
         <div class="j-view-text">${escapeHtml(learning)}</div>
       </div>`
    : '';
  return `
    ${photosHtml}
    ${manualBlock}
    ${learningBlock}
    <div class="j-section">
      <div class="j-section-h">What happened</div>
      <div id="jViewEventsSlot">${renderEventsSection(dateStr)}</div>
    </div>
    <div class="j-section">
      <div class="j-section-h">What you finished</div>
      ${renderTasksSection(dateStr)}
    </div>
    ${habitsBlock}`;
}

function openViewModal(dateStr) {
  closeViewModal(true);
  journalState.viewingDate = dateStr;
  const html = `
    <div class="j-edit-modal j-view-modal" id="jViewModal">
      <div class="j-edit-card">
        <div class="j-edit-head">
          <div>
            <div class="j-edit-title">${jFormatLong(dateStr)}</div>
          </div>
          <button class="j-edit-close" id="jViewClose" title="Close" type="button">×</button>
        </div>
        <div class="j-edit-body" id="jViewBody">${renderViewModalBody(dateStr)}</div>
        <div class="j-edit-footer">
          <button class="j-edit-submit" data-jview-edit="${dateStr}" type="button">Edit</button>
        </div>
      </div>
    </div>`;
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  document.body.appendChild(wrap.firstElementChild);
  document.body.style.overflow = 'hidden';
  fetchCalendarEventsForDate(dateStr).then(() => {
    if (journalState.viewingDate !== dateStr) return;
    const slot = document.getElementById('jViewEventsSlot');
    if (slot) slot.innerHTML = renderEventsSection(dateStr);
  });
  loadJournalEntry(dateStr).then(() => {
    if (journalState.viewingDate !== dateStr) return;
    const body = document.getElementById('jViewBody');
    if (body) body.innerHTML = renderViewModalBody(dateStr);
  });
}

function closeViewModal(skipBodyReset) {
  const m = document.getElementById('jViewModal');
  if (m) m.remove();
  journalState.viewingDate = null;
  if (!skipBodyReset && !document.getElementById('jEditModal')) {
    document.body.style.overflow = '';
  }
}

function closeViewModal(skipBodyReset) {
  const m = document.getElementById('jViewModal');
  if (m) m.remove();
  if (!skipBodyReset && !document.getElementById('jEditModal')) {
    document.body.style.overflow = '';
  }
}

function rerenderEditBody() {
  if (!journalState.editingDate) return;
  const body = document.getElementById('jEditBody');
  if (body) body.innerHTML = renderEditModalBody(journalState.editingDate);
}

function rerenderTimelineCard(dateStr) {
  // Find and replace the card
  const oldCard = document.querySelector(`.j-card[data-jcard-date="${dateStr}"]`);
  if (!oldCard) return;
  const wrap = document.createElement('div');
  wrap.innerHTML = renderDayCard(dateStr);
  const newCard = wrap.firstElementChild;
  oldCard.replaceWith(newCard);
}

/* ── SAVE INDICATOR ──────────────────────────────────────── */

function updateSaveIndicator() {
  const el = document.getElementById('jEditSaveInd');
  if (!el) return;
  el.classList.remove('saved', 'error');
  if (journalState.saveStatus === 'saving') { el.textContent = 'Saving…'; }
  else if (journalState.saveStatus === 'saved') { el.textContent = 'Saved'; el.classList.add('saved'); }
  else if (journalState.saveStatus === 'error') { el.textContent = 'Save failed'; el.classList.add('error'); }
  else { el.textContent = ''; }
}

/* ── LIGHTBOX ────────────────────────────────────────────── */

// Phase 2 audit: lightbox now reads photos from resolveEntryPhotoSrcs
// so it covers BOTH legacy photos[] (data-URLs) and the new
// photo_paths[] (Storage signed URLs). _entryHasAnyPhotos checks
// either source — guards openLightbox/navLightbox against being
// called for an empty entry.
function _entryHasAnyPhotos(entry) {
  return !!(entry?.photos?.length || entry?.photo_paths?.length);
}

function openLightbox(dateStr, index) {
  const entry = journalState.entries.get(dateStr);
  if (!_entryHasAnyPhotos(entry)) return;
  journalState.lightboxPhotos = { date: dateStr, index };
  renderLightbox();
}

function renderLightbox() {
  closeLightbox(true);
  if (!journalState.lightboxPhotos) return;
  const { date, index } = journalState.lightboxPhotos;
  const entry = journalState.entries.get(date);
  if (!_entryHasAnyPhotos(entry)) return;
  // Resolve to the combined src list (data-URLs + signed URLs). If a
  // Storage path hasn't been signed yet, resolveEntryPhotoSrcs kicks
  // the async fetch and will rerender the card — but the lightbox is
  // already open here. To keep the lightbox in sync, request the
  // signed URLs explicitly and re-render once they land.
  const srcs = resolveEntryPhotoSrcs(date, entry);
  const total = srcs.length;
  if (!total) {
    // Paths exist but signed URLs not ready yet — kick the resolve
    // and let it re-call us when ready.
    if (Array.isArray(entry.photo_paths) && entry.photo_paths.length) {
      signedUrlsForPaths(entry.photo_paths).then(() => renderLightbox());
    }
    return;
  }
  const safeIdx = Math.max(0, Math.min(index, total - 1));
  const navHtml = total > 1
    ? `<button class="j-lightbox-nav prev" data-jlightbox-nav="-1" title="Previous">‹</button>
       <button class="j-lightbox-nav next" data-jlightbox-nav="1" title="Next">›</button>
       <div class="j-lightbox-counter">${safeIdx + 1} / ${total}</div>`
    : '';
  const html = `
    <div class="j-lightbox" id="jLightbox">
      <button class="j-lightbox-close" id="jLightboxClose" title="Close">×</button>
      <img class="j-lightbox-img" src="${srcs[safeIdx]}" onclick="event.stopPropagation()" alt="" />
      ${navHtml}
    </div>`;
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  document.body.appendChild(wrap.firstElementChild);
}

function closeLightbox(soft) {
  const m = document.getElementById('jLightbox');
  if (m) m.remove();
  if (!soft) journalState.lightboxPhotos = null;
}

function navLightbox(delta) {
  if (!journalState.lightboxPhotos) return;
  const { date, index } = journalState.lightboxPhotos;
  const entry = journalState.entries.get(date);
  if (!_entryHasAnyPhotos(entry)) return;
  // Count via the resolved src list so navigation matches what's
  // actually visible (the same list renderLightbox uses).
  const total = resolveEntryPhotoSrcs(date, entry).length;
  if (!total) return;
  const next = (index + delta + total) % total;
  journalState.lightboxPhotos = { date, index: next };
  renderLightbox();
}

/* ── MAIN RENDER ─────────────────────────────────────────── */

async function renderJournal() {
  ensureJournalStyles();
  const root = document.getElementById('journalContainer');
  if (!root) return;

  const today = jToday();
  if (!journalState.viewMonth) {
    const d = jParseDate(today);
    journalState.viewMonth = { year: d.getFullYear(), month: d.getMonth() };
  }
  if (typeof routerSyncUrl === 'function') {
    routerSyncUrl({ tool: 'journal' }, { replace: true });
  }

  await loadInitialTimeline();

  root.innerHTML = `
    <div class="j-shell">
      <div id="jHeaderSlot">${renderJournalHeader()}</div>
      ${renderJournalSearchRow()}
      ${renderTimeline()}
      <input type="file" id="jCardPhotoInput" accept="image/*" multiple style="position:absolute;left:-9999px;opacity:0;" />
      <input type="file" id="jCardCameraInput" accept="image/*" capture="environment" style="position:absolute;left:-9999px;opacity:0;" />
    </div>
    <button class="j-back-to-top" id="jBackToTop" type="button" title="Back to top" aria-label="Back to top">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>
    </button>`;

  setupScrollObserver();
  syncCalendarHistory();
  // Meta load is now driven by loadInitialTimeline / loadOlderTimelineDays
  // (scoped to the events actually loaded into the cache), not an
  // unbounded one-shot fetch here. See loadCalendarEventMetaForEvents
  // for the rationale (Phase 2 journal-slowdown audit).
  updateTopbarHeightVar();
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

function highlightSearchMatch(text, query) {
  if (!text) return '';
  const escaped = escapeHtml(text);
  if (!query) return escaped;
  const escapedQuery = escapeHtml(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!escapedQuery) return escaped;
  return escaped.replace(new RegExp(`(${escapedQuery})`, 'gi'), '<mark>$1</mark>');
}

function renderSearchResults() {
  const slot = document.getElementById('jSearchResults');
  if (!slot) return;
  if (journalState.searchResults === null || !journalState.searchQuery) { slot.innerHTML = ''; return; }
  const results = journalState.searchResults;
  if (!results.length) { slot.innerHTML = `<div class="j-search-results"><div class="j-sr-empty">No matches.</div></div>`; return; }
  const rows = results.map(r => {
    const sources = (r.sources || []).map(s => escapeHtml(s.charAt(0).toUpperCase()+s.slice(1))).join(' · ');
    const snippet = highlightSearchMatch(r.snippet || '', journalState.searchQuery);
    return `<button class="j-sr-item" data-jsr-date="${escapeHtml(r.entry_date)}">
      <div class="j-sr-date">${escapeHtml(jFormatShort(r.entry_date))}</div>
      <div class="j-sr-meta">${sources}</div>
      <div class="j-sr-snippet">${snippet}</div>
    </button>`;
  }).join('');
  slot.innerHTML = `<div class="j-search-results">${rows}</div>`;
}

/* ── EVENT HANDLERS ──────────────────────────────────────── */

document.addEventListener('click', async e => {
  // Early-out: this handler does ~20 selector checks per click. When the user
  // is on any other tab and no journal modal/lightbox is open, none of them
  // can match — skip the entire chain. Keeps Home/Tasks/Habits click latency
  // off the journal accumulated state.
  if (typeof activeTool !== 'undefined' && activeTool !== 'journal'
      && !journalState.editingDate && !journalState.viewingDate
      && !journalState.lightboxPhotos && !journalState.calendarOpen) return;

  // Calendar date click → jump to that date in timeline
  const dateBtn = e.target.closest('[data-jcal-date]');
  if (dateBtn && !dateBtn.disabled) {
    const newDate = dateBtn.dataset.jcalDate;
    setCalendarOpen(false);
    await ensureTimelineCovers(newDate);
    scrollTimelineToDate(newDate);
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
    setCalendarOpen(!journalState.calendarOpen);
    return;
  }

  // Back-to-top
  if (e.target.closest('#jBackToTop')) {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }

  // Lightbox photo click (from card)
  const lightboxImg = e.target.closest('[data-jlightbox]');
  if (lightboxImg) {
    e.stopPropagation();
    const [date, idxStr] = lightboxImg.dataset.jlightbox.split('|');
    openLightbox(date, parseInt(idxStr, 10));
    return;
  }
  if (e.target.closest('#jLightboxClose')) {
    closeLightbox();
    return;
  }
  const lightboxNav = e.target.closest('[data-jlightbox-nav]');
  if (lightboxNav) {
    e.stopPropagation();
    navLightbox(parseInt(lightboxNav.dataset.jlightboxNav, 10));
    return;
  }
  if (isCleanBackdropClick(e, document.getElementById('jLightbox'))) {
    closeLightbox();
    return;
  }

  // Card "Add photo" click → open file picker / source modal directly (no edit modal)
  const addPhotoEl = e.target.closest('[data-jcard-add-photo]');
  if (addPhotoEl) {
    e.stopPropagation();
    journalState.cardPhotoTargetDate = addPhotoEl.dataset.jcardAddPhoto;
    const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
    if (isMobile) openPhotoSourceModal();
    else document.getElementById('jCardPhotoInput')?.click();
    return;
  }

  // Card edit click → open edit modal (Edit button or empty-today card)
  const editBtn = e.target.closest('[data-jcard-edit]');
  if (editBtn) {
    openEditModal(editBtn.dataset.jcardEdit);
    return;
  }

  // View modal close / backdrop / "Edit" footer button
  if (e.target.closest('#jViewClose')) { closeViewModal(); return; }
  if (isCleanBackdropClick(e, document.getElementById('jViewModal'))) { closeViewModal(); return; }
  const viewEditBtn = e.target.closest('[data-jview-edit]');
  if (viewEditBtn) {
    const ds = viewEditBtn.dataset.jviewEdit;
    closeViewModal(true);
    openEditModal(ds);
    return;
  }

  // Card view tap (anywhere on a card with content) → read-only modal
  const viewBtn = e.target.closest('[data-jcard-view]');
  if (viewBtn) {
    openViewModal(viewBtn.dataset.jcardView);
    return;
  }

  // Edit modal close
  if (e.target.closest('#jEditClose')) {
    closeEditModal();
    return;
  }
  if (isCleanBackdropClick(e, document.getElementById('jEditModal'))) {
    closeEditModal();
    return;
  }

  // Add photo — uses persistent inputs inside the edit modal
  if (e.target.closest('#jPhotoAdd')) {
    const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
    if (isMobile) openPhotoSourceModal();
    else document.getElementById('jHiddenPhotoInput')?.click();
    return;
  }
  const photoSrc = e.target.closest('[data-jphoto-source]');
  if (photoSrc) {
    closePhotoSourceModal();
    const isCard = !!journalState.cardPhotoTargetDate;
    const cameraId = isCard ? 'jCardCameraInput' : 'jHiddenCameraInput';
    const photoId = isCard ? 'jCardPhotoInput' : 'jHiddenPhotoInput';
    const id = photoSrc.dataset.jphotoSource === 'camera' ? cameraId : photoId;
    document.getElementById(id)?.click();
    return;
  }
  if (e.target.closest('[data-jphoto-cancel]') || isCleanBackdropClick(e, document.getElementById('jPhotoModal'))) {
    closePhotoSourceModal();
    return;
  }

  // Submit/Update button just closes the modal (changes are auto-saved on input)
  if (e.target.closest('#jEditSubmit')) {
    closeEditModal();
    return;
  }

  // Photo delete (in edit modal). The visible list combines legacy
  // photos[] (data-URLs) and photo_paths[] (Storage), in that order
  // (see resolveEntryPhotoSrcs). Translate the visible index back
  // to the right underlying array. For Storage-backed photos we
  // also delete the object from the bucket so we're not leaving
  // orphaned files.
  const photoDel = e.target.closest('[data-jphoto-del]');
  if (photoDel) {
    e.stopPropagation();
    const visibleIdx = parseInt(photoDel.dataset.jphotoDel, 10);
    const ds = journalState.editingDate;
    if (!ds) return;
    const entry = journalState.entries.get(ds) || { reflections:'', mood:null, photos:[], photo_paths:[] };
    const photos      = [...(entry.photos      || [])];
    const photo_paths = [...(entry.photo_paths || [])];
    const patch = {};
    if (visibleIdx < photos.length) {
      // Legacy data-URL — splice out of photos[].
      photos.splice(visibleIdx, 1);
      patch.photos = photos;
    } else {
      // Storage path — splice out of photo_paths[] and remove the
      // bucket object. Index into photo_paths is visibleIdx -
      // photos.length (since data-URLs come first in the combined list).
      const pIdx = visibleIdx - photos.length;
      const removed = photo_paths[pIdx];
      photo_paths.splice(pIdx, 1);
      patch.photo_paths = photo_paths;
      if (removed) {
        db.storage.from('journal-photos').remove([removed])
          .catch(err => console.warn('[journal] storage remove failed', err));
      }
    }
    journalState.entries.set(ds, { ...entry, photos, photo_paths });
    rerenderEditBody();
    saveJournalEntry(ds, patch);
    return;
  }

  // Mood click (in edit modal). For today's entry the picker is
  // disabled — Home check-ins are the new write path. Honor the
  // disabled attribute defensively in case a future child element
  // makes the click bubble through.
  const moodBtn = e.target.closest('[data-jmood]');
  if (moodBtn) {
    if (moodBtn.disabled) return;
    const m = parseInt(moodBtn.dataset.jmood, 10);
    const ds = journalState.editingDate;
    if (!ds) return;
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
    journalState.searchQuery = '';
    journalState.searchResults = null;
    document.getElementById('jSearchInput').value = '';
    renderSearchResults();
    await ensureTimelineCovers(date);
    scrollTimelineToDate(date);
    openViewModal(date);
    return;
  }

  // Phase 5 — tap a calendar event row to edit metadata.
  const eventEdit = e.target.closest('[data-jevent-edit]');
  if (eventEdit) {
    openEventMetaEditor(eventEdit.dataset.jeventEdit);
    return;
  }

  // Refresh sign-in / retry events
  if (e.target.closest('[data-jrefresh-auth]')) { location.reload(); return; }
  if (e.target.closest('[data-jretry-events]')) {
    const ds = journalState.editingDate;
    if (!ds) return;
    journalState.calendarEvents.delete(ds);
    journalState.eventsError.delete(ds);
    const slot = document.getElementById('jEventsSlot');
    if (slot) slot.innerHTML = renderEventsSection(ds);
    fetchCalendarEventsForDate(ds).then(() => {
      if (journalState.editingDate === ds) {
        const s = document.getElementById('jEventsSlot');
        if (s) s.innerHTML = renderEventsSection(ds);
      }
    });
    return;
  }

  // Close calendar popover when clicking outside
  if (journalState.calendarOpen && !e.target.closest('#jCalToggle') && !e.target.closest('#jCalPop')) {
    setCalendarOpen(false);
  }
});

document.addEventListener('keydown', e => {
  if (journalState.lightboxPhotos) {
    if (e.key === 'Escape') closeLightbox();
    else if (e.key === 'ArrowLeft') navLightbox(-1);
    else if (e.key === 'ArrowRight') navLightbox(1);
    return;
  }
  if (journalState.editingDate && e.key === 'Escape') {
    if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
    closeEditModal();
  }
});

function updateTopbarHeightVar() {
  const tb = document.querySelector('.topbar');
  if (!tb) return;
  document.documentElement.style.setProperty('--gsd-topbar-h', tb.offsetHeight + 'px');
}

window.addEventListener('resize', updateTopbarHeightVar);

window.addEventListener('scroll', () => {
  const btn = document.getElementById('jBackToTop');
  if (!btn) return;
  const y = window.scrollY || document.documentElement.scrollTop || 0;
  btn.classList.toggle('is-visible', y > 200);
}, { passive: true });

document.addEventListener('change', async e => {
  if (e.target.id === 'jHiddenPhotoInput' || e.target.id === 'jHiddenCameraInput') {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length) await addPhotosFromFiles(files);
  }
  if (e.target.id === 'jCardPhotoInput' || e.target.id === 'jCardCameraInput') {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    const ds = journalState.cardPhotoTargetDate;
    journalState.cardPhotoTargetDate = null;
    if (files.length && ds) await addPhotosFromCardFiles(files, ds);
  }
});

document.addEventListener('input', e => {
  if (e.target.id === 'jReflections') {
    const ds = journalState.editingDate;
    if (!ds) return;
    const entry = journalState.entries.get(ds) || { reflections:'', mood:null, photos:[], learning:'' };
    journalState.entries.set(ds, { ...entry, reflections: e.target.value });
    scheduleSave(ds, { reflections: e.target.value });
    return;
  }
  if (e.target.id === 'jLearning') {
    const ds = journalState.editingDate;
    if (!ds) return;
    const entry = journalState.entries.get(ds) || { reflections:'', mood:null, photos:[], learning:'' };
    journalState.entries.set(ds, { ...entry, learning: e.target.value });
    scheduleSave(ds, { learning: e.target.value });
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
  const html = `
    <div class="j-photo-modal" id="jPhotoModal">
      <div class="j-photo-modal-card">
        <div class="j-photo-modal-h">Add photo</div>
        <button class="j-photo-modal-opt" data-jphoto-source="camera">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
          <div class="j-photo-modal-opt-text"><span class="j-photo-modal-opt-name">Take photo</span><span class="j-photo-modal-opt-desc">Use your camera</span></div>
        </button>
        <button class="j-photo-modal-opt" data-jphoto-source="device">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          <div class="j-photo-modal-opt-text"><span class="j-photo-modal-opt-name">Upload from device</span><span class="j-photo-modal-opt-desc">Pick one or more files</span></div>
        </button>
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

async function addPhotosFromFiles(files) {
  const ds = journalState.editingDate;
  if (!ds) return;
  const entry = journalState.entries.get(ds) || { reflections:'', mood:null, photos:[], photo_paths:[] };
  // Phase 2 audit: new uploads go to Storage. photo_paths accumulates
  // the relative bucket paths; the legacy photos[] array is preserved
  // unchanged (existing data-URLs still render via the dual-read path
  // in renderCardPhotos / renderLightbox). Backfill moves old photos
  // to photo_paths in a separate one-time script.
  const photo_paths = [...(entry.photo_paths || [])];
  journalState.saveStatus = 'saving';
  updateSaveIndicator();
  for (const f of files) {
    try {
      const blob = await resizeImageToBlob(f);
      const path = await uploadJournalPhoto(blob, ds);
      photo_paths.push(path);
    } catch (err) { console.warn('[journal] photo upload failed', err); }
  }
  journalState.entries.set(ds, { ...entry, photo_paths });
  rerenderEditBody();
  saveJournalEntry(ds, { photo_paths });
}

async function addPhotosFromCardFiles(files, ds) {
  const entry = journalState.entries.get(ds) || { reflections:'', mood:null, photos:[], photo_paths:[] };
  const photo_paths = [...(entry.photo_paths || [])];
  for (const f of files) {
    try {
      const blob = await resizeImageToBlob(f);
      const path = await uploadJournalPhoto(blob, ds);
      photo_paths.push(path);
    } catch (err) { console.warn('[journal] photo upload failed', err); }
  }
  journalState.entries.set(ds, { ...entry, photo_paths });
  rerenderTimeline();
  saveJournalEntry(ds, { photo_paths });
}

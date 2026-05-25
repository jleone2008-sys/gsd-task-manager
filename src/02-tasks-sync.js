
function linkify(t) {
  // Escape first so untrusted task text can never inject HTML;
  // then wrap http(s) URLs in anchors. The URL regex excludes `<`, `>`, `"`
  // so captured URLs are always safe to interpolate into href/text.
  const escaped = escHTML(String(t ?? ''));
  return escaped.replace(/(\bhttps?:\/\/[^\s<>"]+)/gi, u => {
    const d = u.length > 55 ? u.slice(0,52)+'...' : u;
    return `<a href="${u}" target="_blank" rel="noopener">${d}</a>`;
  });
}

// ── Error / offline toast system ──
let toastTimer = null;
function showToast(msg, type) {
  const toast = document.getElementById('errorToast');
  const dot = document.getElementById('errDot');
  const msgEl = document.getElementById('errMsg');
  const retry = document.getElementById('errRetry');
  if (!toast) return;
  msgEl.textContent = msg;
  dot.className = 'err-dot ' + (type === 'sync' ? 'amber' : 'red');
  retry.style.display = type === 'sync' ? '' : 'none';
  toast.classList.add('visible');
  clearTimeout(toastTimer);
}
function hideToast() {
  const toast = document.getElementById('errorToast');
  if (toast) toast.classList.remove('visible');
}
function setStatus(state) {
  if (state === 'offline') {
    showToast("You're offline — changes saved locally", 'offline');
  } else if (state === 'error') {
    showToast("Sync failed — retrying…", 'sync');
  } else {
    hideToast();
  }
}
let offlineRecheck = null;
window.addEventListener('online', () => { clearInterval(offlineRecheck); hideToast(); });
window.addEventListener('offline', () => {
  setStatus('offline');
  offlineRecheck = setInterval(() => {
    if (!navigator.onLine) showToast("You're offline — changes saved locally", 'offline');
  }, 30000);
});
/* ════════════════════════════════════════
   SUPABASE DATA LAYER
════════════════════════════════════════ */

function rowToTask(r) {
  // status takes precedence; fall back to done for older rows that haven't
  // been touched since the migration backfill.
  const status = r.status || (r.done ? 'done' : 'todo');
  return {
    id:          r.client_id,
    text:        r.text        || '',
    note:        r.note        || '',
    tags:        r.tags        || [],
    top3:        r.top3        || false,
    someday:     r.someday     || false,
    done:        status === 'done',
    status:      status,
    due:         r.due         || null,
    order:       r.order       || 0,
    completedAt: r.completed_at || null,
    createdAt:   r.created_at ? new Date(r.created_at).getTime() : r.client_id,
    recur:       r.recur || null,
    spawned:     r.spawned || false,
  };
}

function taskToRow(t) {
  // Keep done and status in sync. status is the source of truth going
  // forward; done remains for any legacy code path still reading it.
  const status = t.status || (t.done ? 'done' : 'todo');
  return {
    user_id:      currentUser.id,
    client_id:    t.id,
    text:         t.text        || '',
    note:         t.note        || '',
    tags:         t.tags        || [],
    top3:         t.top3        || false,
    someday:      t.someday     || false,
    done:         status === 'done',
    status:       status,
    due:          t.due         || null,
    order:        t.order       || 0,
    completed_at: t.completedAt || null,
    recur:        t.recur || null,
    spawned:      t.spawned || false,
  };
}

async function saveTask(t, retries = 2) {
  setStatus('syncing');
  try {
    const { data, error } = await db.from('tasks')
      .upsert(taskToRow(t), { onConflict: 'user_id,client_id' })
      .select('id, client_id');
    if (error && retries > 0) {
      await new Promise(r => setTimeout(r, 1500));
      return saveTask(t, retries - 1);
    }
    setStatus(error ? 'error' : 'saved');
    if (error) { console.error('saveTask:', error.message); return; }
    if (data?.[0]) rowIdMap.set(data[0].id, data[0].client_id);
  } catch (e) {
    setStatus('error');
    console.error('saveTask threw:', e);
  }
}

async function retrySyncAll() {
  hideToast();
  try {
    await saveAllHabitsToDB();
    // Batch the notes upsert instead of N sequential round-trips. Per-row
    // upsert in a loop scales O(n) RTTs on a slow link; a single upsert with
    // the same on_conflict target writes all rows in one request. noteToRow
    // preserves each row's own updated_at, so timestamps don't get clobbered.
    if (Array.isArray(notesArr) && notesArr.length) {
      setStatus('syncing');
      const rows = notesArr.map(noteToRow);
      const { data, error } = await db.from('notes')
        .upsert(rows, { onConflict: 'user_id,client_id' })
        .select('id, client_id');
      setStatus(error ? 'error' : 'saved');
      if (error) { console.error('retrySyncAll notes:', error.message); }
      else if (data) {
        for (const r of data) noteRowIdMap.set(r.id, r.client_id);
      }
    }
  } catch(e) { console.error('retrySyncAll:', e); setStatus('error'); }
}

async function deleteTask(id) {
  setStatus('syncing');
  try {
    const { error } = await db.from('tasks').delete().eq('user_id', currentUser.id).eq('client_id', id);
    setStatus(error ? 'error' : 'saved');
    if (error) console.error('deleteTask:', error.message);
  } catch (e) {
    setStatus('error');
    console.error('deleteTask threw:', e);
  }
}

async function save() {
  if (!tasks.length) return;
  setStatus('syncing');
  try {
    const { error } = await db.from('tasks').upsert(tasks.map(taskToRow), { onConflict: 'user_id,client_id' });
    setStatus(error ? 'error' : 'saved');
    if (error) console.error('save:', error.message);
  } catch (e) {
    setStatus('error');
    console.error('save threw:', e);
  }
}

// Maps Supabase row id (bigint PK) → client_id, so DELETE events can identify the task
const rowIdMap = new Map();

function subscribeToChanges() {
  db.channel('tasks-changes')
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'tasks',
      filter: `user_id=eq.${currentUser.id}`
    }, payload => {
      if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
        const incoming = rowToTask(payload.new);
        rowIdMap.set(payload.new.id, payload.new.client_id);
        const idx = tasks.findIndex(t => t.id === incoming.id);
        if (idx >= 0) tasks[idx] = incoming; else tasks.push(incoming);
      } else if (payload.eventType === 'DELETE') {
        // payload.old only contains the PK (id) by default — look up client_id via rowIdMap
        const clientId = rowIdMap.get(payload.old.id);
        if (clientId !== undefined) {
          tasks = tasks.filter(t => t.id !== clientId);
          rowIdMap.delete(payload.old.id);
        }
      }
      render();
    })
    .subscribe(onChannelStatus);
}

// Cold-open task load. Pre-Phase 2 audit this was a single
// `.select('*')` with no filter — pulling every task the user had
// EVER created, including completed/archived ones from years back.
// Loaded on every cold open, scaling linearly with the user's lifetime
// task count, and indirectly slowing every downstream consumer
// (journal "what you finished", home counts, AI brief context).
//
// New shape:
//   1. ALL open tasks (status != 'done'). Bounded by user behavior —
//      power users typically run 50-200 open tasks; not a growth axis.
//   2. RECENT done tasks (completed_at within DONE_LOOKBACK_DAYS). This
//      covers the journal's default 7-day window with generous slack,
//      plus the Tasks tab's "Show completed" toggle for recent history.
//
// For older completions (journal scroll-back past the window, or a
// Tasks-tab "Load older" affordance), see loadDoneTasksForRange below.
const DONE_LOOKBACK_DAYS = 90;

function _tasksLookbackSince() {
  const d = new Date();
  d.setDate(d.getDate() - DONE_LOOKBACK_DAYS);
  return d.toISOString();
}

// Tracks the earliest completed_at we've loaded into `tasks` so journal
// scroll-back can decide whether it needs to pull more done rows.
let tasksDoneLoadedThrough = null;

async function load() {
  setStatus('syncing');
  const since = _tasksLookbackSince();

  const [openRes, doneRes] = await Promise.all([
    // Open: every task that isn't done. Filter on the `done` boolean
    // (not `status`) because legacy rows can have NULL status — the
    // client side does `r.status || (r.done ? 'done' : 'todo')` to
    // tolerate that, but PostgREST `neq('status','done')` excludes
    // NULLs and would drop every legacy open task.
    db.from('tasks')
      .select('*')
      .eq('user_id', currentUser.id)
      .eq('done', false)
      .order('order', { ascending: true }),
    // Done: last DONE_LOOKBACK_DAYS only. Same reasoning — filter on
    // the `done` boolean which is reliably set across legacy and new
    // rows.
    db.from('tasks')
      .select('*')
      .eq('user_id', currentUser.id)
      .eq('done', true)
      .gte('completed_at', since)
      .order('completed_at', { ascending: false }),
  ]);

  if (openRes.error || doneRes.error) {
    console.error('load:', (openRes.error || doneRes.error).message);
    setStatus('error');
    render();
    return;
  }

  const allRows = [...(openRes.data || []), ...(doneRes.data || [])];
  tasks = allRows.map(rowToTask);
  // Populate rowIdMap so realtime DELETE events can resolve client_id
  allRows.forEach(r => rowIdMap.set(r.id, r.client_id));
  tasksDoneLoadedThrough = since;
  render();
  setStatus('saved');

  // Lazy-spawn any recurring tasks whose next due date has arrived while the
  // app was closed. Idempotent — completed-recurring rows track a `spawned`
  // flag so we never create duplicates.
  if (typeof ensureRecurringSpawns === 'function') ensureRecurringSpawns();

  subscribeToChanges();
  autoBackup();
}

// Pull additional completed tasks into `tasks` for the given date range
// (inclusive). Used by the journal when the user scrolls back past the
// initial 90-day window so the "What you finished" section continues to
// populate. Idempotent — rows whose client_id is already in `tasks` are
// skipped so concurrent calls don't dupe.
async function loadDoneTasksForRange(startIso, endIso) {
  if (!startIso || !endIso) return;
  try {
    const { data, error } = await db.from('tasks')
      .select('*')
      .eq('user_id', currentUser.id)
      .eq('done', true)
      .gte('completed_at', startIso)
      .lte('completed_at', endIso);
    if (error) throw error;
    const existing = new Set(tasks.map(t => t.id));
    for (const row of (data || [])) {
      if (!existing.has(row.client_id)) {
        tasks.push(rowToTask(row));
        rowIdMap.set(row.id, row.client_id);
      }
    }
    // Track how far back we've loaded so the journal can decide whether
    // to call this again on the next scroll-back.
    if (!tasksDoneLoadedThrough || startIso < tasksDoneLoadedThrough) {
      tasksDoneLoadedThrough = startIso;
    }
  } catch (e) {
    console.warn('[tasks] loadDoneTasksForRange failed', e);
  }
}

/* ══════ SUBTASKS DATA LAYER ══════ */
const subtaskRowIdMap = new Map();   // DB row id → client_id

function rowToSubtask(r) {
  return {
    id:              r.client_id,
    client_id:       r.client_id,
    task_client_id:  r.task_client_id,
    text:            r.text || '',
    done:            !!r.done,
    position:        r.position ?? 0,
  };
}
function subtaskToRow(s) {
  return {
    user_id:         currentUser.id,
    client_id:       s.client_id,
    task_client_id:  s.task_client_id,
    text:            s.text || '',
    done:            !!s.done,
    position:        s.position ?? 0,
  };
}

async function loadSubtasks() {
  const { data, error } = await db.from('task_subtasks')
    .select('*')
    .eq('user_id', currentUser.id)
    .order('position', { ascending: true });
  if (error) { console.error('loadSubtasks:', error.message); return; }
  subtasks = data.map(rowToSubtask);
  data.forEach(r => subtaskRowIdMap.set(r.id, r.client_id));
  rebuildSubtasksIndex();
  if (activeTool === 'tasks') render();
  subscribeToSubtaskChanges();
}

function subscribeToSubtaskChanges() {
  db.channel('task_subtasks-changes')
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'task_subtasks',
      filter: `user_id=eq.${currentUser.id}`
    }, payload => {
      if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
        const incoming = rowToSubtask(payload.new);
        subtaskRowIdMap.set(payload.new.id, payload.new.client_id);
        const idx = subtasks.findIndex(s => s.client_id === incoming.client_id);
        if (idx >= 0) subtasks[idx] = incoming; else subtasks.push(incoming);
      } else if (payload.eventType === 'DELETE') {
        const cid = subtaskRowIdMap.get(payload.old.id);
        if (cid !== undefined) {
          subtasks = subtasks.filter(s => s.client_id !== cid);
          subtaskRowIdMap.delete(payload.old.id);
        }
      }
      rebuildSubtasksIndex();
      if (activeTool === 'tasks') render();
    })
    .subscribe();
}

async function pushSubtask(s) {
  if (!currentUser || s.isNew || s.client_id.startsWith('tmp-')) return;
  const { error } = await db.from('task_subtasks')
    .upsert(subtaskToRow(s), { onConflict: 'user_id,client_id' });
  if (error) { setStatus('error'); console.error('pushSubtask:', error.message); }
}

async function dbDeleteSubtask(clientId) {
  if (!currentUser) return;
  const { error } = await db.from('task_subtasks')
    .delete()
    .eq('user_id', currentUser.id)
    .eq('client_id', clientId);
  if (error) { setStatus('error'); console.error('dbDeleteSubtask:', error.message); }
}

function nextSubtaskPosition(taskClientId) {
  const arr = subtasksByTask.get(taskClientId) || [];
  if (!arr.length) return 0;
  return Math.max(...arr.map(s => s.position ?? 0)) + 10;
}

/* ── ERROR TOAST HANDLERS ── */
document.getElementById('errRetry').addEventListener('click', retrySyncAll);
document.getElementById('errDismissBtn').addEventListener('click', hideToast);



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
  return {
    id:      r.client_id,
    text:    r.text    || '',
    note:    r.note    || '',
    tags:    r.tags    || [],
    top3:    r.top3    || false,
    someday: r.someday || false,
    done:    r.done    || false,
    due:     r.due     || null,
    order:   r.order   || 0,
  };
}

function taskToRow(t) {
  return {
    user_id:   currentUser.id,
    client_id: t.id,
    text:      t.text    || '',
    note:      t.note    || '',
    tags:      t.tags    || [],
    top3:      t.top3    || false,
    someday:   t.someday || false,
    done:      t.done    || false,
    due:       t.due     || null,
    order:     t.order   || 0,
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
    for (const n of notesArr) await saveNoteToDB(n);
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

async function load() {
  setStatus('syncing');
  const { data, error } = await db.from('tasks')
    .select('*')
    .eq('user_id', currentUser.id)
    .order('order', { ascending: true });

  if (error) {
    console.error('load:', error.message);
    setStatus('error');
    render();
    return;
  }

  tasks = data.map(rowToTask);
  // Populate rowIdMap so realtime DELETE events can resolve client_id
  data.forEach(r => rowIdMap.set(r.id, r.client_id));
  render();
  setStatus('saved');

  subscribeToChanges();
  autoBackup();
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


const KEY = 'gsd_v3';
let tasks = [], filter = 'all', filterStarred = false, newTags = new Set(), editId = null, showDone = false, sortBy = 'default';
let noteOpen = false, dueDateOpen = false;
let dragId = null, dragOverId = null;
let searchQuery = '';
/* ── Task inline expansion + subtasks (lifestyle redesign) ── */
const expandedTaskIds = new Set();   // task.id (numeric) — which cards are expanded
let subtasks = [];                    // [{id, client_id, task_client_id, text, done, position, ...}]
const subtasksByTask = new Map();     // task_client_id -> sorted array of subtasks

function escapeHTML(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

/** Write a tabbar/sidebar badge count and hide the pill when it's zero. */
function paintBadge(id, n) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = n;
  el.dataset.empty = (!n || n === 0) ? 'true' : 'false';
}

function toggleTaskExpand(id) {
  if (expandedTaskIds.has(id)) expandedTaskIds.delete(id);
  else expandedTaskIds.add(id);
  render();
}

function rebuildSubtasksIndex() {
  subtasksByTask.clear();
  for (const s of subtasks) {
    if (!subtasksByTask.has(s.task_client_id)) subtasksByTask.set(s.task_client_id, []);
    subtasksByTask.get(s.task_client_id).push(s);
  }
  for (const arr of subtasksByTask.values()) {
    arr.sort((a,b) => (a.position ?? 0) - (b.position ?? 0));
  }
}

/* ── Subtask UI handlers (Supabase-backed via pushSubtask / dbDeleteSubtask) ── */
function startNewSubtask(taskClientId) {
  taskClientId = String(taskClientId);
  // If already a tmp draft for this task, just refocus it
  const existingTmp = subtasks.find(s => s.task_client_id === taskClientId && s.isNew);
  if (existingTmp) {
    focusSubtaskInput(existingTmp.client_id);
    return;
  }
  const tmpId = 'tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2,7);
  subtasks.push({
    id: tmpId,
    client_id: tmpId,
    task_client_id: taskClientId,
    text: '',
    done: false,
    position: nextSubtaskPosition(taskClientId),
    isNew: true,
  });
  rebuildSubtasksIndex();
  // Ensure card is expanded so the new input is visible
  const numId = Number(taskClientId);
  if (!isNaN(numId)) expandedTaskIds.add(numId);
  render();
  focusSubtaskInput(tmpId);
}
function focusSubtaskInput(clientId) {
  setTimeout(() => {
    const row = document.querySelector(`[data-sub-id="${clientId}"]`);
    if (!row) return;
    const input = row.querySelector('.subtask-input');
    if (input) { input.focus(); input.select(); }
  }, 30);
}
function commitNewSubtask(taskClientId, tmpId, text) {
  const trimmed = (text || '').trim();
  const idx = subtasks.findIndex(s => s.client_id === tmpId);
  if (idx < 0) return;
  if (!trimmed) {
    // Cancel — drop the tmp row
    subtasks.splice(idx, 1);
    rebuildSubtasksIndex();
    render();
    return;
  }
  // Promote tmp → real
  const realId = String(Date.now()) + '-' + Math.random().toString(36).slice(2,8);
  const promoted = {
    id: realId,
    client_id: realId,
    task_client_id: taskClientId,
    text: trimmed,
    done: false,
    position: subtasks[idx].position,
  };
  subtasks[idx] = promoted;
  rebuildSubtasksIndex();
  render();
  pushSubtask(promoted);
}
function handleSubtaskInputKey(e, taskClientId, tmpId) {
  if (e.key === 'Enter') {
    e.preventDefault();
    const value = e.target.value;
    if (value.trim()) {
      // Save this subtask, then immediately start a new one so the user
      // can keep typing a list in a single uninterrupted flow.
      commitNewSubtask(taskClientId, tmpId, value);
      startNewSubtask(taskClientId);
    } else {
      // Empty Enter exits the flow (cancel the blank draft).
      commitNewSubtask(taskClientId, tmpId, '');
    }
  } else if (e.key === 'Escape') {
    e.preventDefault();
    commitNewSubtask(taskClientId, tmpId, '');
  }
}
async function toggleSubtask(taskClientId, subClientId) {
  const s = subtasks.find(x => x.client_id === subClientId);
  if (!s || s.isNew) return;
  s.done = !s.done;
  rebuildSubtasksIndex();
  render();
  pushSubtask(s);
}
function startEditSubtask(taskClientId, subClientId) {
  const s = subtasks.find(x => x.client_id === subClientId);
  if (!s || s.isNew) return;
  const row = document.querySelector(`[data-sub-id="${subClientId}"]`);
  if (!row) return;
  const span = row.querySelector('.subtask-text');
  if (!span) return;
  const input = document.createElement('input');
  input.className = 'subtask-input';
  input.value = s.text;
  let cancelled = false;
  input.addEventListener('click', e => e.stopPropagation());
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')      { e.preventDefault(); input.blur(); }
    else if (e.key === 'Escape'){ e.preventDefault(); cancelled = true; input.blur(); }
  });
  input.addEventListener('blur', () => {
    if (cancelled) { render(); return; }
    commitEditSubtask(taskClientId, subClientId, input.value);
  });
  span.replaceWith(input);
  input.focus();
  input.select();
}
function commitEditSubtask(taskClientId, subClientId, text) {
  const s = subtasks.find(x => x.client_id === subClientId);
  if (!s || s.isNew) return;
  const trimmed = (text || '').trim();
  // Blank edit or unchanged text: just re-render to restore the span view.
  // Deletion is reserved for the × button so a stray blur can't drop a row.
  if (!trimmed || trimmed === s.text) { render(); return; }
  s.text = trimmed;
  rebuildSubtasksIndex();
  render();
  pushSubtask(s);
}
async function deleteSubtask(taskClientId, subClientId) {
  const idx = subtasks.findIndex(s => s.client_id === subClientId);
  if (idx < 0) return;
  const wasNew = subtasks[idx].isNew;
  subtasks.splice(idx, 1);
  rebuildSubtasksIndex();
  render();
  if (!wasNew) dbDeleteSubtask(subClientId);
}

/* ════════════════════════════════════════
   SUPABASE CONFIG + REAL AUTH
════════════════════════════════════════ */
const SUPABASE_URL = 'https://dmuwncwptvnnlizuxhta.supabase.co';
const SUPABASE_KEY = 'sb_publishable_IAw1Nc8XezPPWos8iS-kLg_YrNpRIe_';
const { createClient } = supabase;
const db = createClient(SUPABASE_URL, SUPABASE_KEY);
let currentUser = null;
let authMode = 'signin';


function toggleAuthMode() {
  authMode = authMode === 'signin' ? 'signup' : 'signin';
  document.getElementById('authSubmitBtn').textContent =
    authMode === 'signin' ? 'Sign In' : 'Create Account';
  document.getElementById('authToggle').innerHTML = authMode === 'signin'
    ? 'No account? <a onclick="toggleAuthMode()">Sign up free</a>'
    : 'Already have an account? <a onclick="toggleAuthMode()">Sign in</a>';
  clearAuthError();
}

function showAuthError(msg) {
  const el = document.getElementById('authError');
  el.textContent = msg; el.classList.add('show');
}
function clearAuthError() {
  document.getElementById('authError').classList.remove('show');
}

// Shared status callback for all Supabase realtime channels.
// Logs CHANNEL_ERROR/TIMED_OUT so silent subscription failures become visible.
function onChannelStatus(status, err) {
  if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
    console.warn('realtime channel', status, err || '');
  }
}

async function signInWithGoogle() {
  const { error } = await db.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin + '/app' }
  });
  if (error) showAuthError('Google sign-in failed: ' + error.message);
}

async function handleEmailAuth() {
  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value;
  if (!email) { showAuthError('Please enter your email address.'); return; }
  if (!password || password.length < 6) { showAuthError('Password must be at least 6 characters.'); return; }

  const btn = document.getElementById('authSubmitBtn');
  btn.textContent = 'Please wait…';
  btn.disabled = true;
  let result;

  if (authMode === 'signin') {
    result = await db.auth.signInWithPassword({ email, password });
  } else {
    result = await db.auth.signUp({ email, password });
  }

  btn.disabled = false;
  btn.textContent = authMode === 'signin' ? 'Sign In' : 'Create Account';

  if (result.error) {
    showAuthError(result.error.message);
    return;
  }
  if (authMode === 'signup' && result.data && !result.data.session) {
    showAuthError('Check your email to confirm your account, then sign in.');
    return;
  }
}

function signInUser(user) {
  // Clear any stale realtime channels from a prior session before re-subscribing.
  try { db.removeAllChannels(); } catch (_) {}
  currentUser = user;
  document.getElementById('authScreen').classList.add('hidden');
  setUserUI(user);
  load();
  loadHabits();
  loadNotes();
  loadSubtasks();
}

async function signOut() {
  cancelMidnightRefresh();
  db.removeAllChannels();
  await db.auth.signOut();
  currentUser = null;
  tasks = [];
  subtasks = []; subtasksByTask.clear(); subtaskRowIdMap.clear(); expandedTaskIds.clear();
  habitsArr = []; habitCompletions = [];
  notesArr = []; notebooksArr = []; activeNoteId = null; notesSidebarView = 'all';
  toggleUserDropdown(false);
  document.getElementById('userMenu').style.display = 'none';
  document.getElementById('authScreen').classList.remove('hidden');
  // Reset auth form
  document.getElementById('authEmail').value = '';
  document.getElementById('authPassword').value = '';
  clearAuthError();
  // Clear task container and stats
  document.getElementById('taskContainer').innerHTML = '';
}

function setUserUI(user) {
  const avatar = document.getElementById('userAvatar');
  const name = user.user_metadata?.full_name || user.user_metadata?.name || user.email.split('@')[0];
  const pic  = user.user_metadata?.avatar_url || user.user_metadata?.picture || null;
  avatar.replaceChildren();
  if (pic && /^https?:\/\//i.test(pic)) {
    const img = document.createElement('img');
    img.src = pic;
    img.alt = name;
    img.style.cssText = 'width:100%;height:100%;border-radius:50%;object-fit:cover;';
    avatar.appendChild(img);
  } else {
    avatar.textContent = name.split(' ').map(n=>n[0]).join('').slice(0,2).toUpperCase();
  }
  document.getElementById('userMenu').style.display = 'flex';
  document.getElementById('dropdownName').textContent = name;
  document.getElementById('dropdownEmail').textContent = user.email;
  // Sidebar footer (desktop ≥900px)
  const sbName = document.getElementById('sidebarUserName');
  const sbEmail = document.getElementById('sidebarUserEmail');
  const sbAv = document.getElementById('sidebarAvatar');
  if (sbName) sbName.textContent = name;
  if (sbEmail) sbEmail.textContent = user.email;
  if (sbAv) {
    sbAv.replaceChildren();
    if (pic && /^https?:\/\//i.test(pic)) {
      const img = document.createElement('img');
      img.src = pic; img.alt = name;
      img.style.cssText = 'width:100%;height:100%;border-radius:50%;object-fit:cover;';
      sbAv.appendChild(img);
    } else {
      sbAv.textContent = name.split(' ').map(n=>n[0]).join('').slice(0,2).toUpperCase();
    }
  }
}

function toggleUserDropdown(force) {
  const dd = document.getElementById('userDropdown');
  const open = force !== undefined ? force : !dd.classList.contains('open');
  dd.classList.toggle('open', open);
}

// Close dropdown on outside click. "Outside" must also exclude the sidebar
// footer — it is a dropdown trigger on desktop (the mobile header avatar is
// the trigger on small screens). Without this check the click that opens
// the dropdown bubbles to document and is then treated as outside, closing
// the dropdown again on the same tick.
document.addEventListener('click', e => {
  const menu = document.getElementById('userMenu');
  if (!menu || menu.style.display === 'none') return;
  const sbFoot = document.getElementById('sidebarFooter');
  const inside = menu.contains(e.target) || (sbFoot && sbFoot.contains(e.target));
  if (!inside) toggleUserDropdown(false);
});

/* ── DELETE ACCOUNT ── */
function openDeleteAccountModal() {
  document.getElementById('deleteConfirmInput').value = '';
  document.getElementById('deleteConfirmBtn').disabled = true;
  document.getElementById('deleteConfirmBtn').style.opacity = '0.4';
  document.getElementById('deleteConfirmBtn').style.cursor = 'not-allowed';
  document.getElementById('deleteAccountModal').classList.add('open');
}
function closeDeleteAccountModal() {
  document.getElementById('deleteAccountModal').classList.remove('open');
}
// ── Tool switching ──────────────────────────────────────
let activeTool = 'tasks';
let _navFromPop = false; // flag to prevent pushState during popstate handling
function switchTool(tool) {
  if (tool === activeTool) return;
  if (activeTool === 'tasks' && searchQuery) { searchQuery = ''; }
  if (activeTool === 'notes' && noteSearchQuery) { noteSearchQuery = ''; }
  activeTool = tool;
  if (!_navFromPop) history.pushState({tool, note: null, drill: false}, '');
  // Show/hide tool views
  document.querySelectorAll('[data-tool-view]').forEach(el => {
    el.style.display = el.dataset.toolView === tool ? '' : 'none';
  });
  // Sync mobile bottom nav
  document.querySelectorAll('.mobile-nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tool === tool);
  });
  // Sync desktop sidebar
  document.querySelectorAll('.sidebar-btn[data-tool]').forEach(btn => {
    btn.classList.toggle('is-active', btn.dataset.tool === tool);
  });
  // Update page title (mobile header + desktop header)
  const titles = { tasks: 'Tasks', habits: 'Habits', notes: 'Notes', scratch: 'Scratch' };
  const pt = document.getElementById('pageTitle');
  if (pt) pt.textContent = titles[tool] || '';
  // Update floating search
  updateFloatingSearch();
  // Update stats bar and render for the active tool
  // Restore FAB unless scratch hides it
  if (tool !== 'scratch') document.getElementById('fabBtn')?.classList.remove('hidden');
  if (tool === 'habits') { renderHabits(); }
  else if (tool === 'tasks') { render(); }
  else if (tool === 'notes') { renderNotes(); }
  else if (tool === 'scratch') { renderScratch(); }
}
// Wire click handlers for tool tabs, mobile nav, and sidebar
document.addEventListener('click', e => {
  const tab = e.target.closest('.mobile-nav-btn, .sidebar-btn');
  if (tab && tab.dataset.tool) switchTool(tab.dataset.tool);
});
// Tool keyboard shortcuts — Shift+T/H/N/S, only when not in a typeable context
document.addEventListener('keydown', e => {
  if (!e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
  const tag = document.activeElement?.tagName;
  const editable = document.activeElement?.isContentEditable;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || editable) return;
  const map = { T: 'tasks', H: 'habits', N: 'notes', S: 'scratch' };
  const tool = map[e.key.toUpperCase()];
  if (tool) { e.preventDefault(); switchTool(tool); }
});
// Set initial history state
history.replaceState({tool: 'tasks', note: null, drill: false}, '');
// Handle browser back/forward (swipe gestures on mobile)
window.addEventListener('popstate', e => {
  _navFromPop = true;
  // Close any open overlay first
  const drillOverlay = document.getElementById('habitDrillOverlay');
  if (drillOverlay && drillOverlay.classList.contains('open')) { closeDrillIn(); _navFromPop = false; return; }
  // Close open note on mobile
  if (activeNoteId && activeTool === 'notes') { deselectNote(); _navFromPop = false; return; }
  // Restore tool from state
  const state = e.state || {tool: 'tasks', note: null, drill: false};
  if (state.tool && state.tool !== activeTool) switchTool(state.tool);
  if (state.tool === 'notes' && state.note) { activeNoteId = state.note; renderNotes(); }
  _navFromPop = false;
});
// Habit sub-pill switching
document.addEventListener('click', e => {
  const pill = e.target.closest('.habit-sub-pills .pill');
  if (!pill || !pill.dataset.habitView) return;
  activeHabitView = pill.dataset.habitView;
  document.querySelectorAll('.habit-sub-pills .pill').forEach(p => p.classList.remove('active'));
  pill.classList.add('active');
  document.querySelectorAll('.habit-sub-content').forEach(c => c.classList.remove('active'));
  const target = document.getElementById('habit-' + activeHabitView);
  if (target) target.classList.add('active');
});

// Notes pill-bar (All / Pinned) — routes to the existing notes sidebar-view state
document.addEventListener('click', e => {
  const pill = e.target.closest('[data-tool-view="notes"].pill-bar .pill[data-notes-filter]');
  if (!pill) return;
  const f = pill.dataset.notesFilter;
  const map = { all: 'all', pinned: 'starred' };
  if (typeof setNotesSidebarView === 'function') setNotesSidebarView(map[f] || 'all');
  document.querySelectorAll('[data-tool-view="notes"].pill-bar .pill').forEach(p => p.classList.remove('active'));
  pill.classList.add('active');
});

document.getElementById('deleteAccountModal').addEventListener('click', function(e) {
  if (e.target === this) closeDeleteAccountModal();
});
document.addEventListener('DOMContentLoaded', () => {
  const inp = document.getElementById('deleteConfirmInput');
  if (inp) {
    inp.addEventListener('input', () => {
      const valid = inp.value === 'DELETE';
      const btn = document.getElementById('deleteConfirmBtn');
      btn.disabled = !valid;
      btn.style.opacity = valid ? '1' : '0.4';
      btn.style.cursor = valid ? 'pointer' : 'not-allowed';
    });
  }
});
async function confirmDeleteAccount() {
  if (document.getElementById('deleteConfirmInput').value !== 'DELETE') return;
  if (currentUser) {
    // delete_user() deletes the auth record; cascade removes their tasks
    const { error } = await db.rpc('delete_user');
    if (error) { console.error('delete_user:', error.message); return; }
    await db.auth.signOut();
  }
  currentUser = null;
  tasks = [];
  closeDeleteAccountModal();
  document.getElementById('userMenu').style.display = 'none';
  document.getElementById('taskContainer').innerHTML = '';
  document.getElementById('authScreen').classList.remove('hidden');
}

/* ── EXPORT CSV ── */
function exportCSV() {
  if (!tasks.length) { alert('No tasks to export.'); return; }
  const stripHtml = h => { const d=document.createElement('div'); d.innerHTML=h; return d.textContent||''; };
  const headers = ['Text','Note','Tags','Priority','Later','Done',];
  const rows = tasks.map(t => [
    `"${(t.text||'').replace(/"/g,'""')}"`,
    `"${stripHtml(t.note||'').replace(/"/g,'""')}"`,
    `"${(t.tags||[]).join(', ')}"`,
    t.top3 ? 'Yes' : 'No',
    t.someday ? 'Yes' : 'No',
    t.done ? 'Yes' : 'No',
  ]);
  const csv = [headers, ...rows].map(r=>r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'gsd-tasks.csv'; a.click();
  URL.revokeObjectURL(url);
}

/* ── RESTORE SESSION ON LOAD ── */
async function restoreSession() {
  const { data: { session } } = await db.auth.getSession();
  if (session?.user) {
    signInUser(session.user);
  } else {
    document.getElementById('authScreen').classList.remove('hidden');
  }
  // Listen for auth state changes (e.g. OAuth redirect)
  db.auth.onAuthStateChange((_event, session) => {
    if (session?.user && !currentUser) {
      signInUser(session.user);
    }
  });
}


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
      <span class="habit-emoji-lg" onclick="openHabitDrillIn(${h.id})">${escHTML(h.emoji || '')}</span>
      <div class="habit-today-content" onclick="openHabitDrillIn(${h.id})" style="cursor:pointer">
        <div class="habit-card-top">
          <span class="habit-name">${escHTML(h.name || '')}</span>${countBadge}
        </div>
        <div class="habit-card-meta">${progressMeta ? progressMeta + ' · ' : ''}<span class="habit-streak${streak===0?' dead':''}">${streakLabel(streak)}</span></div>
      </div>
      <div style="display:flex;align-items:center;gap:4px;flex-shrink:0">
        <button onclick="event.stopPropagation();removeLastCompletion(${h.id},'${today}')" style="width:22px;height:22px;border-radius:50%;border:1.5px solid var(--edge-strong);background:var(--surface);color:var(--ink-3);font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1" title="Remove one">−</button>
        <button onclick="event.stopPropagation();toggleCompletion(${h.id},'${today}')" style="width:22px;height:22px;border-radius:50%;border:1.5px solid var(--guava-700);background:var(--guava-700);color:#fff;font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;font-weight:700" title="Add another">+</button>
      </div>
    </div>`;
  }

  // Standard card — either incomplete or done-without-extras.
  return `<div class="${cardCls}" data-habit-id="${h.id}">
    <div class="swipe-complete-bg">✓</div>
    <span class="habit-emoji-lg" onclick="openHabitDrillIn(${h.id})">${escHTML(h.emoji || '')}</span>
    <div class="habit-today-content" onclick="openHabitDrillIn(${h.id})" style="cursor:pointer">
      <div class="habit-card-top">
        <span class="habit-name">${escHTML(h.name || '')}</span>
      </div>
      <div class="habit-card-meta"><span class="habit-streak${streak===0?' dead':''}">${streakLabel(streak)}</span> · ${freqLabel(h)}</div>
    </div>
    <div class="habit-check${isDone ? ' checked' : ''}" onclick="toggleCompletion(${h.id},'${today}')"><svg width="9" height="7" viewBox="0 0 10 8" fill="none"><path d="M1 4L3.5 6.5L9 1" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg></div>
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
        dots += `<div class="habit-day"><span class="habit-day-label">${dayShort(ds)}</span><div class="${cls}" onclick="event.stopPropagation();this.classList.add('just-toggled');toggleCompletion(${h.id},'${ds}')">${dayNum}</div></div>`;
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

    html += `<div class="habit-card" onclick="openHabitDrillIn(${h.id})">
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
          <button class="habit-action-btn" onclick="event.stopPropagation();openHabitDrillIn(${h.id},'calendar')" title="Calendar"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg></button>
          <button class="habit-action-btn" onclick="event.stopPropagation();openHabitDrillIn(${h.id},'stats')" title="Statistics"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="12" width="4" height="9"/><rect x="10" y="7" width="4" height="14"/><rect x="17" y="3" width="4" height="18"/></svg></button>
          <button class="habit-action-btn" onclick="event.stopPropagation();openHabitDrillIn(${h.id},'edit')" title="More"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg></button>
        </div>
      </div>
    </div>`;
  });

  // Archived habits section
  if (archived.length) {
    html += `<div class="section-label" style="margin-top:24px;cursor:pointer;user-select:none" onclick="document.getElementById('archivedHabitsSection').style.display=document.getElementById('archivedHabitsSection').style.display==='none'?'block':'none';this.querySelector('.arch-arrow').textContent=document.getElementById('archivedHabitsSection').style.display==='none'?'▸':'▾'">📦 ARCHIVED <span class="arch-arrow">▸</span> <span style="font-weight:400;color:var(--ink-3);font-size:11px">${archived.length}</span></div>`;
    html += `<div id="archivedHabitsSection" style="display:none">`;
    archived.forEach(h => {
      html += `<div class="habit-card" style="opacity:0.6">
        <div class="habit-card-top">
          <span class="habit-emoji">${escHTML(h.emoji || '')}</span><span class="habit-name">${escHTML(h.name || '')}</span>
          <button onclick="unarchiveHabit(${h.id})" style="margin-left:auto;background:none;border:1px solid var(--edge);border-radius:8px;padding:4px 12px;font-size:11px;font-family:inherit;cursor:pointer;color:var(--ink-2);">Unarchive</button>
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
    trendHtml += `<div class="st-trend-wrap" style="cursor:pointer" onclick="statsMonth=${mo};statsMonthYear=${y};statsView='monthly';renderHabits()" title="View ${MO_SHORT[mo]} ${y}">${pct > 0 ? `<div class="st-trend-pct">${pct}%</div>` : ''}<div class="st-trend-bar" style="height:${Math.max(h, 2)}px;background:${barColor};opacity:${opacity}"></div><div class="st-trend-mo">${MO_SHORT[mo]}</div></div>`;
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
        <button onclick="statsYear=${y - 1};renderHabits()">← ${y - 1}</button>
        <span class="st-nav-label">${y}</span>
        <button onclick="statsYear=${y + 1};renderHabits()" ${isCurrentYear?'disabled style="opacity:0.3;cursor:default"':''}>${y + 1} →</button>
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
        <button onclick="statsMonth=${prevM};statsMonthYear=${prevY};renderHabits()">← ${MO_SHORT[prevM]}</button>
        <span class="st-nav-label" style="cursor:pointer" onclick="statsView='yearly';statsYear=${y};renderHabits()" title="Back to ${y} overview">${MO[m]} ${y} ▴</span>
        <button onclick="statsMonth=${nextM};statsMonthYear=${nextY};renderHabits()" ${isCurrentMonth?'disabled style="opacity:0.3;cursor:default"':''}>${MO_SHORT[nextM]} →</button>
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

function highlight(text, query) {
  if (!query) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`(${escaped})`, 'gi'), '<span class="search-hl">$1</span>');
}

function applySearch(list) {
  if (!searchQuery) return list;
  const q = searchQuery.toLowerCase();
  return list.filter(t =>
    t.text.toLowerCase().includes(q) ||
    (t.note && t.note.toLowerCase().includes(q)) ||
    (t.tags && t.tags.some(tg => tg.toLowerCase().includes(q)))
  );
}

function emptyState(type) {
  // Per gsd-handoff/DESIGN_HANDOFF.md §9.3: one-line Inter copy, single ghost-
  // button CTA, no illustrations. No emoji icons.
  const states = {
    search:   { title: 'No results.',                       btn: null },
    biz:      { title: 'No Work tasks yet.',                btn: 'Add Work task' },
    personal: { title: 'No Personal tasks yet.',            btn: 'Add Personal task' },
    top3:     { title: 'No priority tasks.',                btn: null },
    priority: { title: 'No priority tasks.',                btn: null },
    overdue:  { title: 'Nothing overdue.',                  btn: null },
    someday:  { title: 'Nothing Later.',                    btn: 'Add task' },
    all:      { title: 'Nothing to do. Add something.',     btn: 'Add task' },
  };
  const s = states[type] || states.all;
  const btnHtml = s.btn ? `<button class="expand-action empty-state-btn" onclick="event.stopPropagation();openCreatePanel()">${s.btn}</button>` : '';
  return `<div class="empty-state">
    <div class="empty-state-title">${s.title}</div>
    ${btnHtml}
  </div>`;
}

function render() {
  const c = document.getElementById('taskContainer');
  let active = tasks.filter(t=>!t.done).sort((a,b)=>(a.order??0)-(b.order??0));
  let done = tasks.filter(t=>t.done);
  let view = [...active];
  // Tasks filter set: all · overdue · personal · biz (Work).
  const _todayStr = typeof todayStr === 'function' ? todayStr() : new Date().toISOString().slice(0,10);
  if (filter==='overdue')  { view = view.filter(t => t.due && t.due < _todayStr); done = done.filter(t => t.due && t.due < _todayStr); }
  if (filter==='priority') { view = view.filter(t => t.top3); done = done.filter(t => t.top3); }
  if (filter==='biz')      { view = view.filter(t=>t.tags?.includes('biz')); done = done.filter(t=>t.tags?.includes('biz')); }
  if (filter==='personal') { view = view.filter(t=>t.tags?.includes('personal')); done = done.filter(t=>t.tags?.includes('personal')); }
  // Legacy internal filter still honored by callers not going through the pills.
  if (filter==='someday')  view = view.filter(t=>t.someday);
  // filterStarred drives the Priority pill.
  if (filterStarred && filter !== 'priority') { view = view.filter(t=>t.top3); done = done.filter(t=>t.top3); }

  // Apply search across active + done
  const isSearching = !!searchQuery;
  if (isSearching) {
    view = applySearch(view);
    done = applySearch(done);
  }

  // Apply sort (default = drag order already applied above)
  if (sortBy === 'recent') {
    view.sort((a,b) => b.id - a.id);
  } else if (sortBy === 'due') {
    view.sort((a,b) => {
      const da = a.due || '', db = b.due || '';
      if (da && db) return da.localeCompare(db);
      if (da) return -1;
      if (db) return 1;
      return b.id - a.id; // no due date: newest first
    });
  }

  let html = '';

  if (isSearching) {
    const all = [...view, ...done];
    if (!all.length) {
      html = emptyState('search');
    } else {
      html += slabel(`Results for "${searchQuery}"`, all.length);
      html += `<div class="task-list" data-section="search">${all.map(t=>tHTMLsearch(t, searchQuery)).join('')}</div>`;
    }
  } else if (filter!=='someday') {
    if (filterStarred) {
      // Legacy priority-only branch (filter='priority' no longer has a pill,
      // but internal callers may still route through here).
      const lbl = filter==='biz'?'Priority · Work':filter==='personal'?'Priority · Personal':'Priority';
      if (view.length) {
        html += slabel(lbl, view.length, true);
        html += `<div class="task-list" data-section="top3">${view.map(t=>tHTML(t)).join('')}</div>`;
      } else {
        html += emptyState('top3');
      }
    } else {
      // Every non-priority filter (All / Overdue / Personal / Work) renders as
      // Priority section first, then the main bucket labelled for the filter.
      // Later (someday) only surfaces under All — tag filters don't show it.
      const top3    = view.filter(t => t.top3);
      const regular = view.filter(t => !t.top3 && !t.someday);
      const someday = view.filter(t => t.someday && !t.top3);
      const regLabel = filter === 'biz'     ? 'Work'
                     : filter === 'personal' ? 'Personal'
                     : filter === 'overdue'  ? 'Overdue'
                     :                         'Tasks';
      if (top3.length) {
        html += slabel('Priority', top3.length, true);
        html += `<div class="task-list" data-section="top3">${top3.map(t=>tHTML(t)).join('')}</div>`;
      }
      if (regular.length) {
        html += slabel(regLabel, regular.length, !top3.length);
        html += `<div class="task-list" data-section="main">${regular.map(t=>tHTML(t)).join('')}</div>`;
      } else if (!top3.length && !someday.length) {
        html += emptyState(filter);
      }
      if (filter === 'all' && someday.length) {
        html += slabel('Later', someday.length);
        html += `<div class="task-list" data-section="someday">${someday.map(t=>tHTML(t)).join('')}</div>`;
      }
    }
  } else {
    if (view.length) {
      html += slabel('Later', view.length, true);
      html += `<div class="task-list" data-section="someday">${view.map(t=>tHTML(t)).join('')}</div>`;
    } else {
      html += emptyState('someday');
    }
  }

  if (!isSearching && done.length && ['all','biz','personal'].includes(filter)) {
    html += `<div class="done-toggle" onclick="toggleDone()">&#9654;&nbsp; Completed (${done.length})</div>`;
    if (showDone) html += `<div class="task-list" data-section="done" style="margin-top:4px">${done.map(t=>tHTML(t)).join('')}</div>`;
  }
  c.innerHTML = html;

  c.querySelectorAll('.task-item[draggable]').forEach(el => {
    el.addEventListener('dragstart', onDragStart);
    el.addEventListener('dragend', onDragEnd);
    el.addEventListener('dragover', onDragOver);
    el.addEventListener('drop', onDrop);
    el.addEventListener('dragleave', onDragLeave);
  });

  const actN = tasks.filter(t => !t.done).length;
  // Mobile bottom-nav badge + desktop sidebar count
  paintBadge('tasksBadgeMobile', actN);
  const sbc=document.getElementById('sidebarTasksCount');if(sbc)sbc.textContent=actN;
  // Dynamic pill counts
  updateTaskPillCounts();
  requestAnimationFrame(initNoteClamps);
}

function slabel(l,n,showSort) {
  // Strip legacy "&#9733; " (☆) prefix used for Starred sections — strip is the only signal now
  const cleaned = l.replace(/^&#9733;\s*/,'').replace(/^Starred\s*/,'Priority ').trim();
  const sortLabels = {default:'User Sorted',recent:'Recent',due:'Due Date'};
  const sortHtml = showSort ? `<div class="sort-wrap"><button class="sort-btn" onclick="toggleSortDropdown(event)">Sort by <span class="sort-val">${sortLabels[sortBy]}</span> <span style="font-size:7px">▼</span></button></div>` : '';
  return `<div class="section-label">${cleaned}<span class="cnt">${n}</span>${sortHtml}</div>`;
}

// Search variant — highlights matched text, disables drag, opens edit on body tap
function tHTMLsearch(t, query) {
  const tagHtml = t.tags.map(tg=>`<span class="tag ${tg}">${tg==='biz'?'Work':'Personal'}</span>`).join('');
  const sdTag = t.someday?`<span class="tag someday">Later</span>`:'';
  const noteTag = t.note?`<span class="tag has-note" title="Has note"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>Note</span>`:'';
  const subsTag = subtasksTagHTML(t);
  const dueHtml = dueBadgeHTML(t.due);
  const hasMeta = t.tags.length||t.someday||t.due||t.note||subsTag;
  const cardCls = ['card','task-item'];
  if (t.top3) cardCls.push('top3','is-priority');
  if (t.done) cardCls.push('done','is-done');
  return `<div class="${cardCls.join(' ')}" id="ti-${t.id}" data-id="${t.id}">
    <div class="swipe-delete-bg">🗑</div>
    <div class="swipe-complete-bg">✓</div>
    <span class="strip" onclick="event.stopPropagation();toggleTop3(${t.id})" title="Toggle priority"></span>
    <div class="card-head">
      <div class="card-body task-content" onclick="openEdit(${t.id})">
        <div class="card__title task-text">${highlight(linkify(t.text), query)}</div>
        ${hasMeta ? `<div class="card__meta task-meta">${tagHtml}${sdTag}${noteTag}${subsTag}${dueHtml}</div>` : ''}
      </div>
      <button class="check checkbox" onclick="event.stopPropagation();toggleDone_t(${t.id})" aria-label="${t.done?'Reopen':'Complete'}">
        <svg width="9" height="7" viewBox="0 0 10 8" fill="none"><path d="M1 4L3.5 6.5L9 1" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>
      </button>
    </div>
  </div>`;
}

function handleSearch(val) {
  searchQuery = val.trim();
  render();
}
function clearSearch() {
  searchQuery = '';
  const si = document.getElementById('floatingSearchInput');
  if (si) si.value = '';
  render();
}

// ── Floating search bar ──
function expandFloatingSearch() {
  const el = document.getElementById('floatingSearch');
  if (el.classList.contains('expanded')) return;
  el.classList.add('expanded');
  document.getElementById('floatingSearchInput').focus();
}
function collapseFloatingSearch() {
  const el = document.getElementById('floatingSearch');
  const input = document.getElementById('floatingSearchInput');
  if (input.value.trim()) return; // don't collapse if has query
  el.classList.remove('expanded');
  input.blur();
  // clear both search states
  if (activeTool === 'tasks') { searchQuery = ''; render(); }
  else if (activeTool === 'notes') { noteSearchQuery = ''; renderNoteList(); }
}
function handleFloatingSearch(val) {
  const el = document.getElementById('floatingSearch');
  el.classList.toggle('has-query', val.trim().length > 0);
  if (activeTool === 'tasks') { searchQuery = val.trim(); render(); }
  else if (activeTool === 'notes') { noteSearchQuery = val.trim(); renderNoteList(); }
}
function clearFloatingSearch() {
  const input = document.getElementById('floatingSearchInput');
  input.value = '';
  const el = document.getElementById('floatingSearch');
  el.classList.remove('has-query');
  if (activeTool === 'tasks') { searchQuery = ''; render(); }
  else if (activeTool === 'notes') { noteSearchQuery = ''; renderNoteList(); }
  input.focus();
}
function updateFloatingSearch() {
  const el = document.getElementById('floatingSearch');
  const input = document.getElementById('floatingSearchInput');
  if (!el) return;
  // Show only for tasks and notes
  if (activeTool === 'tasks' || activeTool === 'notes') {
    el.classList.remove('hidden');
    input.placeholder = activeTool === 'tasks' ? 'Search tasks...' : 'Search notes...';
  } else {
    el.classList.add('hidden');
  }
  // Reset on tool switch
  input.value = '';
  el.classList.remove('expanded', 'has-query');
}
// Collapse when clicking outside
document.addEventListener('mousedown', e => {
  const el = document.getElementById('floatingSearch');
  if (el && el.classList.contains('expanded') && !el.contains(e.target)) {
    collapseFloatingSearch();
  }
});

function subtasksTagHTML(t) {
  const arr = (subtasksByTask.get(String(t.id)) || []).filter(s => !s.isNew);
  if (!arr.length) return '';
  const done = arr.filter(s => s.done).length;
  return `<span class="tag has-subtasks" title="Subtasks"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>${done} / ${arr.length} subtasks</span>`;
}

function dueBadgeHTML(due) {
  if (!due || due === '') return '';
  const today = new Date(); today.setHours(0,0,0,0);
  const d = new Date(due + 'T00:00:00');
  if (isNaN(d.getTime())) return '';
  const diff = Math.round((d - today) / 86400000);
  let cls = 'due-badge';
  let label = '';
  if (diff < 0) { cls += ' due-overdue'; label = `Overdue · ${d.toLocaleDateString('en-US',{month:'short',day:'numeric'})}`; }
  else if (diff === 0) { cls += ' due-today'; label = 'Due today'; }
  else if (diff <= 3) { cls += ' due-soon'; label = `Due ${d.toLocaleDateString('en-US',{month:'short',day:'numeric'})}`; }
  else { label = `Due ${d.toLocaleDateString('en-US',{month:'short',day:'numeric'})}`; }
  return `<span class="${cls}"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>${label}</span>`;
}

function tHTML(t) {
  const tagHtml = t.tags.map(tg=>`<span class="tag ${tg}">${tg==='biz'?'Work':'Personal'}</span>`).join('');
  const sdTag = t.someday?`<span class="tag someday">Later</span>`:'';
  const noteTag = t.note?`<span class="tag has-note" title="Has note"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>Note</span>`:'';
  const subsTag = subtasksTagHTML(t);
  const dueHtml = dueBadgeHTML(t.due);
  const hasMeta = t.tags.length||t.someday||t.due||t.note||subsTag;
  const isExpanded = expandedTaskIds.has(t.id);
  const expandHtml = isExpanded ? expansionBodyHTML(t) : '';
  const cardCls = ['card','task-item'];
  if (t.top3)  cardCls.push('top3','is-priority');
  if (t.done)  cardCls.push('done','is-done');
  if (isExpanded) cardCls.push('is-expanded');
  return `<div class="${cardCls.join(' ')}" id="ti-${t.id}" draggable="true" data-id="${t.id}">
    <div class="swipe-delete-bg">🗑</div>
    <div class="swipe-complete-bg">✓</div>
    <span class="strip" onclick="event.stopPropagation();toggleTop3(${t.id})" title="Toggle priority"></span>
    <div class="card-head">
      <div class="card-body task-content" onclick="toggleTaskExpand(${t.id})">
        <div class="card__title task-text">${linkify(t.text)}</div>
        ${hasMeta ? `<div class="card__meta task-meta">${tagHtml}${sdTag}${noteTag}${subsTag}${dueHtml}</div>` : ''}
      </div>
      <button class="check checkbox" onclick="event.stopPropagation();toggleDone_t(${t.id})" aria-label="${t.done?'Reopen':'Complete'}">
        <svg width="9" height="7" viewBox="0 0 10 8" fill="none"><path d="M1 4L3.5 6.5L9 1" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>
      </button>
    </div>
    ${expandHtml}
  </div>`;
}

function expansionBodyHTML(t) {
  const tcid = String(t.id);
  // Notes are stored as rich HTML from the contenteditable editor. Use
  // richToDisplay (DOMPurify-backed) so tags render as formatted text, not
  // escaped source. linkify would escape the HTML and show raw <b>…</b>.
  const noteHtml = t.note ? `<div class="card__note task-expand__note">${richToDisplay(t.note)}</div>` : '';
  const subs = subtasksByTask.get(tcid) || [];
  const subsHtml = `<div class="card__subtasks task-expand__subs" id="subs-${tcid}">${subs.map(s=>subtaskRowHTML(tcid, s)).join('')}</div>`;
  const priorityOn = t.top3 ? ' is-on' : '';
  return `<div class="card__expand task-expand">
    ${noteHtml}
    ${subsHtml}
    <div class="card__actions task-expand__actions">
      <button class="expand-action" onclick="event.stopPropagation();startNewSubtask('${tcid}')">+ subtask</button>
      <button class="expand-action" onclick="event.stopPropagation();openEdit(${t.id})">edit</button>
      <button class="expand-action${priorityOn}" onclick="event.stopPropagation();toggleTop3(${t.id})">priority</button>
    </div>
  </div>`;
}

function subtaskRowHTML(taskClientId, s) {
  const inner = s.isNew
    ? `<input class="subtask-input"
         placeholder="New subtask…"
         onclick="event.stopPropagation()"
         onkeydown="handleSubtaskInputKey(event,'${taskClientId}','${s.client_id}')"
         onblur="commitNewSubtask('${taskClientId}','${s.client_id}',this.value)" />`
    : `<span class="subtask-text" onclick="event.stopPropagation();startEditSubtask('${taskClientId}','${s.client_id}')">${escapeHTML(s.text)}</span>`;
  const radioClick = s.isNew
    ? ''
    : ` onclick="event.stopPropagation();toggleSubtask('${taskClientId}','${s.client_id}')"`;
  return `<div class="subtask-row${s.done?' done':''}" data-sub-id="${s.client_id}">
    <span class="subtask-radio"${radioClick}></span>
    ${inner}
    <button class="subtask-del" onclick="event.stopPropagation();deleteSubtask('${taskClientId}','${s.client_id}')" aria-label="Delete subtask">×</button>
  </div>`;
}

function onDragStart(e) {
  dragId = parseInt(e.currentTarget.dataset.id);
  e.currentTarget.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}
function onDragEnd(e) {
  e.currentTarget.classList.remove('dragging');
  document.querySelectorAll('.task-item').forEach(el=>el.classList.remove('drag-target'));
  dragId = null; dragOverId = null;
}
function onDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const id = parseInt(e.currentTarget.dataset.id);
  if (id === dragId) return;
  if (id !== dragOverId) {
    document.querySelectorAll('.task-item').forEach(el=>el.classList.remove('drag-target'));
    e.currentTarget.classList.add('drag-target');
    dragOverId = id;
  }
}
function onDragLeave(e) { e.currentTarget.classList.remove('drag-target'); }
function onDrop(e) {
  e.preventDefault();
  const targetId = parseInt(e.currentTarget.dataset.id);
  if (!dragId || dragId === targetId) return;
  reorder(dragId, targetId);
  render();
}
function reorder(fromId, toId) {
  const from = tasks.find(t=>t.id===fromId);
  const to   = tasks.find(t=>t.id===toId);
  if (!from||!to) return;
  // Section check: same section only
  const section = t => t.top3 ? 'top3' : t.someday ? 'someday' : 'main';
  if (section(from) !== section(to)) return;
  const sectionTasks = tasks.filter(t=>!t.done && section(t)===section(from))
                            .sort((a,b)=>(a.order??0)-(b.order??0));
  const fromIdx = sectionTasks.findIndex(t=>t.id===fromId);
  const toIdx   = sectionTasks.findIndex(t=>t.id===toId);
  if (fromIdx===-1||toIdx===-1) return;
  const [moved] = sectionTasks.splice(fromIdx, 1);
  sectionTasks.splice(toIdx, 0, moved);
  sectionTasks.forEach((t,i)=>{ const task=tasks.find(x=>x.id===t.id); if(task) task.order=i*10; });
  save();
}

/**
 * Tasks filter set: All · Overdue · Personal · Work.
 * `filter` drives the render predicate. filterStarred remains accessible
 * for any internal callers but is no longer driven by a pill click.
 */
function setCatFilter(f, el) {
  filter = f;
  filterStarred = false;
  const bar = document.querySelector('[data-tool-view="tasks"].pill-bar');
  if (bar) bar.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
  if (el) el.classList.add('active');
  render();
}
function toggleStarredFilter(el) {
  filterStarred = !filterStarred;
  if (el) el.classList.toggle('active', filterStarred);
  render();
}
function setFilter(f, el) {
  if (f === 'top3' || f === 'priority') { filter = 'priority'; toggleStarredFilter(el); return; }
  setCatFilter(f, el);
}

/** Recompute Task pill counts from real data on every render. */
function updateTaskPillCounts() {
  const today = typeof todayStr === 'function' ? todayStr() : new Date().toISOString().slice(0,10);
  const active = tasks.filter(t => !t.done);
  const counts = {
    all:      active.length,
    overdue:  active.filter(t => t.due && t.due < today).length,
    personal: active.filter(t => t.tags?.includes('personal')).length,
    biz:      active.filter(t => t.tags?.includes('biz')).length,
  };
  for (const [k, v] of Object.entries(counts)) {
    const el = document.getElementById('pc-' + k);
    if (el) el.textContent = v;
  }
}

function openCreatePanel() {
  if (activeTool === 'habits') { openHabitCreatePanel(); return; }
  if (activeTool === 'notes') { createNote(); return; }
  document.getElementById('fabBtn').classList.add('hidden');
  document.getElementById('floatingSearch').classList.add('hidden');
  document.getElementById('createPanel').classList.add('open');
  setTimeout(() => document.getElementById('newTaskInput').focus(), 50);
}
function closeCreatePanel() {
  document.getElementById('fabBtn').classList.remove('hidden');
  updateFloatingSearch();
  document.getElementById('createPanel').classList.remove('open');
}
document.addEventListener('click', function(e) {
  const panel = document.getElementById('createPanel');
  const fab = document.getElementById('fabBtn');
  if (panel && panel.classList.contains('open') && !panel.contains(e.target) && !fab.contains(e.target)) {
    closeCreatePanel();
  }
  const hPanel = document.getElementById('habitCreatePanel');
  if (hPanel && hPanel.classList.contains('open') && !hPanel.contains(e.target) && !fab.contains(e.target)) {
    closeHabitCreatePanel();
  }
});

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
    const onclick = isFuture ? '' : `onclick="toggleDrillCompletion('${ds}')"`;
    html += `<div class="${cls}" ${onclick}>${d}</div>`;
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

/* ══════ NOTES DATA LAYER ══════ */
let notesArr = [], notebooksArr = [];
const noteRowIdMap = new Map();
const notebookRowIdMap = new Map();
let activeNoteId = null;
let noteSearchQuery = '';
let noteSortOrder = 'updated'; // 'updated' | 'created' | 'alpha'
let _noteSaveTimer = null;

// Scratch uses reserved client_id -1 in the notes table
const SCRATCH_ID = -1;
let scratchNote = {
  id: SCRATCH_ID, title: '', content: '', notebookId: null, tags: [],
  starred: false, trashed: false, trashedAt: null, order: 0,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
};

function rowToNote(r) {
  // IMPORTANT: do NOT default missing timestamps to new Date(). That makes
  // every freshly-loaded row share the exact same "now" — which is why every
  // note in the list was rendering "47m ago" at once. Fall back to the other
  // timestamp if available, else leave null so formatNoteDate can show nothing.
  return {
    id: r.client_id,
    title: r.title || '',
    content: r.content || '',
    notebookId: r.notebook_id || null,
    tags: r.tags || [],
    starred: r.starred || false,
    trashed: r.trashed || false,
    trashedAt: r.trashed_at || null,
    order: r.order || 0,
    createdAt: r.created_at || r.updated_at || null,
    updatedAt: r.updated_at || r.created_at || null,
  };
}
function noteToRow(n) {
  // IMPORTANT: pass n.updatedAt through instead of blindly writing new Date().
  // Edit handlers (onNoteTitleChange, onNoteContentChange, toggleNoteStar, etc.)
  // set n.updatedAt = now() BEFORE calling saveNoteToDB, so we already have the
  // correct time on the object. Overwriting here meant every bulk save (e.g.,
  // retrySyncAll after an offline blip) would mass-reset every note to the
  // same 'now', which is why all notes previously showed identical relative
  // times like '58m ago'.
  return {
    user_id: currentUser.id,
    client_id: n.id,
    title: n.title,
    content: n.content,
    notebook_id: n.notebookId || null,
    tags: n.tags,
    starred: n.starred,
    trashed: n.trashed,
    trashed_at: n.trashedAt || null,
    "order": n.order,
    created_at: n.createdAt || new Date().toISOString(),
    updated_at: n.updatedAt || n.createdAt || new Date().toISOString(),
  };
}

async function saveNoteToDB(n, retries = 2) {
  setStatus('syncing');
  const { data, error } = await db.from('notes')
    .upsert(noteToRow(n), { onConflict: 'user_id,client_id' })
    .select('id, client_id');
  if (error && retries > 0) {
    await new Promise(r => setTimeout(r, 1500));
    return saveNoteToDB(n, retries - 1);
  }
  setStatus(error ? 'error' : 'saved');
  if (error) { console.error('saveNote:', error.message); return; }
  if (data?.[0]) noteRowIdMap.set(data[0].id, data[0].client_id);
}

async function deleteNoteFromDB(id) {
  setStatus('syncing');
  const { error } = await db.from('notes').delete().eq('user_id', currentUser.id).eq('client_id', id);
  setStatus(error ? 'error' : 'saved');
  if (error) console.error('deleteNote:', error.message);
}

let _noteRenderTimer = null;
function debouncedRenderNotes() {
  if (_noteRenderTimer) clearTimeout(_noteRenderTimer);
  _noteRenderTimer = setTimeout(() => {
    _noteRenderTimer = null;
    // If user is actively editing, only update sidebar/list, not the editor
    const ce = document.getElementById('noteContentEditable');
    if (ce && document.activeElement === ce) {
      renderNotesSidebar(); renderNoteList(); updateNotesBadge();
    } else {
      renderNotes();
    }
  }, 300);
}

function subscribeToNoteChanges() {
  db.channel('notes-changes')
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'notes',
      filter: `user_id=eq.${currentUser.id}`
    }, payload => {
      let changed = false;
      if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
        const incoming = rowToNote(payload.new);
        noteRowIdMap.set(payload.new.id, payload.new.client_id);
        // Route scratch updates separately — never mix into notesArr
        if (incoming.id === SCRATCH_ID) {
          scratchNote = incoming;
          localStorage.setItem('gsd-scratch', scratchNote.content);
          if (activeTool === 'scratch') {
            const ce = document.getElementById('scratchContentEditable');
            // Only patch DOM if user isn't actively typing
            if (ce && document.activeElement !== ce) ce.innerHTML = scratchNote.content;
          }
          return;
        }
        const idx = notesArr.findIndex(n => n.id === incoming.id);
        if (idx >= 0) {
          const old = notesArr[idx];
          if (old.title !== incoming.title || old.content !== incoming.content ||
              old.starred !== incoming.starred || old.trashed !== incoming.trashed) changed = true;
          notesArr[idx] = incoming;
        } else { notesArr.push(incoming); changed = true; }
      } else if (payload.eventType === 'DELETE') {
        const clientId = noteRowIdMap.get(payload.old.id);
        if (clientId !== undefined && clientId !== SCRATCH_ID) {
          notesArr = notesArr.filter(n => n.id !== clientId);
          noteRowIdMap.delete(payload.old.id);
          if (activeNoteId === clientId) activeNoteId = null;
          changed = true;
        }
      }
      if (changed) debouncedRenderNotes();
    })
    .subscribe(onChannelStatus);
}

async function loadNotes() {
  // Load notebooks first
  const { data: nbData, error: nbErr } = await db.from('notebooks')
    .select('*').eq('user_id', currentUser.id).order('order', { ascending: true });
  if (!nbErr && nbData) {
    notebooksArr = nbData.map(rowToNotebook);
    nbData.forEach(r => notebookRowIdMap.set(r.id, r.client_id));
  }
  // Load notes
  const { data, error } = await db.from('notes')
    .select('*').eq('user_id', currentUser.id).order('updated_at', { ascending: false });
  if (error) { console.error('loadNotes:', error.message); return; }
  notesArr = data.map(rowToNote);
  data.forEach(r => noteRowIdMap.set(r.id, r.client_id));
  // Extract scratch note (client_id -1) — keep it separate from the notes list
  const scratchIdx = notesArr.findIndex(n => n.id === SCRATCH_ID);
  if (scratchIdx >= 0) {
    scratchNote = notesArr[scratchIdx];
    notesArr.splice(scratchIdx, 1);
    localStorage.setItem('gsd-scratch', scratchNote.content);
  } else {
    // First load for this user — persist scratch to DB
    saveNoteToDB(scratchNote);
  }
  // Auto-clear trash older than 30 days
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  notesArr.filter(n => n.trashed && n.trashedAt && new Date(n.trashedAt).getTime() < thirtyDaysAgo).forEach(n => {
    notesArr = notesArr.filter(x => x.id !== n.id);
    deleteNoteFromDB(n.id);
  });
  subscribeToNoteChanges();
  subscribeToNotebookChanges();
  renderNotes();
}

/* ══════ NOTEBOOKS DATA ══════ */
function rowToNotebook(r) {
  return { id: r.client_id, name: r.name || '', color: r.color || '#5b82e0', order: r.order || 0, icon: r.icon || '' };
}
function notebookToRow(nb) {
  return { user_id: currentUser.id, client_id: nb.id, name: nb.name, color: nb.color, "order": nb.order, icon: nb.icon || '', updated_at: new Date().toISOString() };
}
async function saveNotebookToDB(nb, retries = 2) {
  setStatus('syncing');
  const row = notebookToRow(nb);
  const { data, error } = await db.from('notebooks')
    .upsert(row, { onConflict: 'user_id,client_id' })
    .select('id, client_id');
  if (error && error.message && error.message.includes('icon') && retries > 0) {
    // icon column may not exist yet — retry without it
    delete row.icon;
    const r2 = await db.from('notebooks').upsert(row, { onConflict: 'user_id,client_id' }).select('id, client_id');
    setStatus(r2.error ? 'error' : 'saved');
    if (r2.error) { console.error('saveNotebook:', r2.error.message); return; }
    if (r2.data?.[0]) notebookRowIdMap.set(r2.data[0].id, r2.data[0].client_id);
    return;
  }
  setStatus(error ? 'error' : 'saved');
  if (error) { console.error('saveNotebook:', error.message); return; }
  if (data?.[0]) notebookRowIdMap.set(data[0].id, data[0].client_id);
}
async function deleteNotebookFromDB(id) {
  setStatus('syncing');
  const { error } = await db.from('notebooks').delete().eq('user_id', currentUser.id).eq('client_id', id);
  setStatus(error ? 'error' : 'saved');
  if (error) console.error('deleteNotebook:', error.message);
}

function subscribeToNotebookChanges() {
  db.channel('notebooks-changes')
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'notebooks',
      filter: `user_id=eq.${currentUser.id}`
    }, payload => {
      let changed = false;
      if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
        const incoming = rowToNotebook(payload.new);
        notebookRowIdMap.set(payload.new.id, payload.new.client_id);
        const idx = notebooksArr.findIndex(n => n.id === incoming.id);
        if (idx >= 0) { notebooksArr[idx] = incoming; changed = true; }
        else { notebooksArr.push(incoming); changed = true; }
      } else if (payload.eventType === 'DELETE') {
        const clientId = notebookRowIdMap.get(payload.old.id);
        if (clientId !== undefined) {
          notebooksArr = notebooksArr.filter(n => n.id !== clientId);
          notebookRowIdMap.delete(payload.old.id);
          if (notesSidebarView === 'notebook-' + clientId) notesSidebarView = 'all';
          changed = true;
        }
      }
      if (changed) debouncedRenderNotes();
    })
    .subscribe(onChannelStatus);
}

let notesSidebarView = 'all'; // 'all' | 'starred' | 'trash' | 'notebook-{id}'

/* ══════ NOTES RENDERING ══════ */
function renderNotes() {
  renderNotesSidebar();
  renderNoteList();
  renderNoteEditor();
  updateNotesBadge();
  // Toggle the list / editor swap on desktop via a class. CSS uses this to
  // hide the notes-list and expand the editor to fill the same space.
  const layout = document.querySelector('[data-tool-view="notes"] .notes-layout');
  if (layout) layout.classList.toggle('has-active-note', !!activeNoteId);
}

function getFilteredNotes() {
  let list;
  if (notesSidebarView === 'trash') {
    list = notesArr.filter(n => n.trashed);
  } else if (notesSidebarView === 'starred') {
    list = notesArr.filter(n => !n.trashed && n.starred);
  } else if (notesSidebarView.startsWith('notebook-')) {
    const nbId = parseInt(notesSidebarView.split('-')[1]);
    list = notesArr.filter(n => !n.trashed && n.notebookId === nbId);
  } else {
    list = notesArr.filter(n => !n.trashed);
  }
  if (noteSearchQuery) {
    const q = noteSearchQuery.toLowerCase();
    list = list.filter(n => n.title.toLowerCase().includes(q) || n.content.toLowerCase().includes(q));
  }
  if (noteSortOrder === 'updated') list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  else if (noteSortOrder === 'created') list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  else if (noteSortOrder === 'alpha') list.sort((a, b) => a.title.localeCompare(b.title));
  else if (noteSortOrder === 'manual') list.sort((a, b) => (a.order || 0) - (b.order || 0));
  return list;
}

function renderNotesSidebar() {
  const el = document.getElementById('notesSidebar');
  if (!el) return;
  const allCount = notesArr.filter(n => !n.trashed).length;
  const starCount = notesArr.filter(n => !n.trashed && n.starred).length;
  const trashCount = notesArr.filter(n => n.trashed).length;

  let html = `<div class="ns-section">
    <div class="ns-item${notesSidebarView==='all'?' active':''}" onclick="setNotesSidebarView('all')">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
      <span>All Notes</span><span class="cnt">${allCount}</span>
    </div>
    <div class="ns-item${notesSidebarView==='starred'?' active':''}" onclick="setNotesSidebarView('starred')">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 17v5M9 10.76V6a2 2 0 1 1 4 0v4.76l3 1.54V15H6v-2.7l3-1.54z"/></svg>
      <span>Pinned</span><span class="cnt">${starCount}</span>
    </div>
    <div class="ns-item${notesSidebarView==='trash'?' active':''}" onclick="setNotesSidebarView('trash')">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      <span>Trash</span><span class="cnt">${trashCount}</span>
    </div>
  </div>
  <div class="ns-divider"></div>
  <div class="ns-section">
    <div class="ns-label">Notebooks<button onclick="createNotebook()"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button></div>`;
  notebooksArr.sort((a, b) => (a.order || 0) - (b.order || 0)).forEach(nb => {
    const nbCount = notesArr.filter(n => !n.trashed && n.notebookId === nb.id).length;
    const active = notesSidebarView === 'notebook-' + nb.id ? ' active' : '';
    const nbIcon = nb.icon ? `<span style="font-size:14px;line-height:1;flex-shrink:0">${nb.icon}</span>` : `<div class="nb-dot" style="background:${nb.color}"></div>`;
    html += `<div class="ns-item${active}" draggable="true" data-nb-id="${nb.id}" onclick="setNotesSidebarView('notebook-${nb.id}')" oncontextmenu="event.preventDefault();showNotebookMenu(event,${nb.id})">
      ${nbIcon}
      <span>${escHTML(nb.name || 'Untitled')}</span><span class="cnt">${nbCount}</span>
      <button class="nb-edit-btn" onclick="event.stopPropagation();showNotebookMenu(event,${nb.id})" title="Edit notebook">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>
      </button>
    </div>`;
  });
  html += `</div>`;

  el.innerHTML = html;

  // Wire sidebar items as drop targets for drag-to-trash/notebook
  el.querySelectorAll('.ns-item').forEach(item => {
    item.addEventListener('dragover', e => {
      if (!noteDragId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      item.classList.add('drop-target');
    });
    item.addEventListener('dragleave', () => item.classList.remove('drop-target'));
    item.addEventListener('drop', e => {
      e.preventDefault();
      item.classList.remove('drop-target');
      if (!noteDragId) return;
      const note = notesArr.find(n => n.id === noteDragId);
      if (!note) return;
      // Determine target from onclick attr
      const onclick = item.getAttribute('onclick') || '';
      if (onclick.includes("'trash'")) {
        note.trashed = true;
        note.trashedAt = new Date().toISOString();
        note.updatedAt = new Date().toISOString();
        if (activeNoteId === note.id) activeNoteId = null;
      } else if (onclick.includes("'starred'")) {
        note.starred = true;
        note.updatedAt = new Date().toISOString();
      } else if (onclick.includes("'all'")) {
        note.notebookId = null;
        note.updatedAt = new Date().toISOString();
      } else if (onclick.includes("'notebook-")) {
        const m = onclick.match(/notebook-(\d+)/);
        if (m) { note.notebookId = parseInt(m[1]); note.updatedAt = new Date().toISOString(); }
      }
      saveNoteToDB(note);
      noteDragId = null;
      renderNotes();
    });
  });

  // Wire notebook drag-to-reorder
  let nbDragId = null;
  el.querySelectorAll('.ns-item[data-nb-id]').forEach(item => {
    item.addEventListener('dragstart', e => {
      nbDragId = parseInt(item.dataset.nbId);
      e.dataTransfer.effectAllowed = 'move';
      item.style.opacity = '0.4';
    });
    item.addEventListener('dragend', () => { item.style.opacity = ''; nbDragId = null; });
    item.addEventListener('dragover', e => {
      const targetNbId = parseInt(item.dataset.nbId);
      if (!nbDragId || nbDragId === targetNbId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      item.classList.add('drop-target');
    });
    item.addEventListener('dragleave', () => item.classList.remove('drop-target'));
    item.addEventListener('drop', e => {
      e.preventDefault(); e.stopPropagation();
      item.classList.remove('drop-target');
      const targetNbId = parseInt(item.dataset.nbId);
      if (!nbDragId || nbDragId === targetNbId) return;
      reorderNotebooks(nbDragId, targetNbId);
      nbDragId = null;
    });
  });

  // Populate mobile notebook toggle + drawer
  const mobileToggle = document.getElementById('mobileNbToggle');
  const mobileDrawer = document.getElementById('mobileNbDrawer');
  if (mobileToggle) {
    let currentLabel = 'All Notes';
    if (notesSidebarView === 'starred') currentLabel = 'Pinned';
    else if (notesSidebarView === 'trash') currentLabel = 'Trash';
    else if (notesSidebarView.startsWith('notebook-')) {
      const nbId = parseInt(notesSidebarView.split('-')[1]);
      const nb = notebooksArr.find(n => n.id === nbId);
      currentLabel = nb ? escHTML(nb.name) : 'Notebook';
    }
    mobileToggle.removeAttribute('style');
    mobileToggle.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
      <span class="current-nb">${currentLabel}</span>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px;margin-left:auto"><polyline points="6 9 12 15 18 9"/></svg>`;
  }
  if (mobileDrawer) {
    let drawerHtml = `
      <div class="ns-item${notesSidebarView==='all'?' active':''}" onclick="setNotesSidebarView('all');document.getElementById('mobileNbDrawer').classList.remove('open')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        All Notes <span class="cnt">${allCount}</span>
      </div>
      <div class="ns-item${notesSidebarView==='starred'?' active':''}" onclick="setNotesSidebarView('starred');document.getElementById('mobileNbDrawer').classList.remove('open')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 17v5M9 10.76V6a2 2 0 1 1 4 0v4.76l3 1.54V15H6v-2.7l3-1.54z"/></svg>
        Pinned <span class="cnt">${starCount}</span>
      </div>
      <div class="ns-item${notesSidebarView==='trash'?' active':''}" onclick="setNotesSidebarView('trash');document.getElementById('mobileNbDrawer').classList.remove('open')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        Trash <span class="cnt">${trashCount}</span>
      </div>`;
    notebooksArr.forEach(nb => {
      const nbCount = notesArr.filter(n => !n.trashed && n.notebookId === nb.id).length;
      const active = notesSidebarView === 'notebook-' + nb.id ? ' active' : '';
      const nbIcon = nb.icon ? `<span style="font-size:14px;line-height:1">${nb.icon}</span>` : `<div class="nb-dot" style="background:${nb.color}"></div>`;
      drawerHtml += `<div class="ns-item${active}" onclick="setNotesSidebarView('notebook-${nb.id}');document.getElementById('mobileNbDrawer').classList.remove('open')">
        ${nbIcon}
        ${escHTML(nb.name || 'Untitled')} <span class="cnt">${nbCount}</span>
      </div>`;
    });
    drawerHtml += `<div class="ns-item" onclick="createNotebook();document.getElementById('mobileNbDrawer').classList.remove('open')" style="color:var(--guava-700);font-weight:600">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      New Notebook
    </div>`;
    mobileDrawer.innerHTML = drawerHtml;
  }

  // Update list header title
  updateNlTitle();
}
function updateNlTitle() {
  const titleEl = document.getElementById('nlTitle');
  const countEl = document.getElementById('nlCount');
  if (!titleEl) return;
  const list = getFilteredNotes();
  let label = 'All Notes';
  if (notesSidebarView === 'starred') label = 'Pinned';
  else if (notesSidebarView === 'trash') label = 'Trash';
  else if (notesSidebarView.startsWith('notebook-')) {
    const nbId = parseInt(notesSidebarView.split('-')[1]);
    const nb = notebooksArr.find(n => n.id === nbId);
    label = nb ? escHTML(nb.name) : 'Notebook';
  }
  let extra = '';
  if (notesSidebarView === 'trash' && list.length > 0) {
    extra = `<button onclick="emptyTrash()" style="margin-left:auto;border:none;background:none;cursor:pointer;font-size:11px;color:var(--guava-700);font-family:inherit;font-weight:600;padding:2px 6px;border-radius:4px" onmouseover="this.style.background='var(--guava-700)10a';this.style.color='#fff'" onmouseout="this.style.background='none';this.style.color='var(--guava-700)'">Empty Trash</button>`;
  } else if (notesSidebarView !== 'trash') {
    extra = `<button onclick="enterNoteSelectMode()" title="Select notes" style="margin-left:auto;border:none;background:none;cursor:pointer;padding:2px 4px;border-radius:4px;color:var(--ink-3);display:flex;align-items:center">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 12l2 2 4-4"/></svg>
    </button>`;
  }
  titleEl.innerHTML = `${label} <span class="nl-count">${list.length}</span>${extra}`;
}

function setNotesSidebarView(view) {
  notesSidebarView = view;
  activeNoteId = null;
  renderNotes();
}

function renderNoteList() {
  const el = document.getElementById('nlScroll');
  if (!el) return;
  const list = getFilteredNotes();
  updateNlTitle();

  // Render bulk bar
  const bulkBar = document.getElementById('nlBulkBar');
  if (bulkBar) {
    if (noteSelectMode && notesSidebarView !== 'trash') {
      const cnt = selectedNoteIds.size;
      bulkBar.style.display = '';
      bulkBar.innerHTML = `
        <button onclick="toggleSelectAllNotes()">
          ${cnt === list.length && list.length > 0 ? 'Deselect all' : 'Select all'}
        </button>
        <button class="danger" onclick="bulkTrashNotes()" ${cnt === 0 ? 'disabled' : ''}>Trash (${cnt})</button>
        <button onclick="bulkMoveNotes(event)" ${cnt === 0 ? 'disabled' : ''}>Move (${cnt})</button>
        <span class="bulk-count">${cnt} selected</span>
        <button onclick="exitNoteSelectMode()" style="border:none;padding:4px;color:var(--ink-3)">✕</button>`;
    } else {
      bulkBar.style.display = 'none';
    }
  }

  if (!list.length && !noteSearchQuery) {
    el.innerHTML = `<div style="text-align:center;padding:40px 20px;color:var(--ink-3)">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin-bottom:10px;opacity:0.4"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
      <div style="font-size:14px;font-weight:600;color:var(--ink-2);margin-bottom:4px">No notes yet</div>
      <div style="font-size:12px">Tap + to create your first note.</div>
    </div>`;
    return;
  }
  if (!list.length && noteSearchQuery) {
    el.innerHTML = `<div style="text-align:center;padding:40px 20px;color:var(--ink-3)">
      <div style="font-size:14px;font-weight:600;color:var(--ink-2)">No results</div>
      <div style="font-size:12px;margin-top:4px">Try a different search term.</div>
    </div>`;
    return;
  }

  let html = '';
  list.forEach(n => {
    const active = n.id === activeNoteId ? ' active' : '';
    const selClass = noteSelectMode ? ' select-mode' : '';
    const checked = selectedNoteIds.has(n.id) ? ' checked' : '';
    const preview = stripHTML(n.content).slice(0, 120) || 'No content';
    const date = formatNoteDate(n.updatedAt);
    const nb = n.notebookId ? notebooksArr.find(nb => nb.id === n.notebookId) : null;
    // Map notebook to one of the spec's earth-tone chip tones. Notebook color
    // is kept in the DB as a CSS var name; this coerces it to the chip tone
    // that reads best on the warm surface.
    const toneFor = (color) => {
      if (!color) return 'slate';
      if (color.includes('biz') || color.includes('sky'))    return 'slate';
      if (color.includes('personal') || color.includes('plum')) return 'ochre';
      if (color.includes('mint') || color.includes('check')) return 'moss';
      if (color.includes('yellow') || color.includes('top3')) return 'ochre';
      if (color.includes('coral') || color.includes('danger')) return 'guava';
      return 'slate';
    };
    const tagHtml = nb
      ? `<span class="chip chip--${toneFor(nb.color)}">${escHTML(nb.name)}</span>`
      : '';
    if (notesSidebarView === 'trash') {
      html += `<div class="nl-item${active}${selClass}" data-note-id="${n.id}" oncontextmenu="showNoteContextMenu(event,${n.id})">
        <div class="nl-item-head">
          <div class="nl-item-title">${escHTML(n.title || 'Untitled')}</div>
          <div class="nl-item-date">${date}</div>
        </div>
        <div class="nl-item-preview">${escHTML(preview)}</div>
        <div class="nl-item-meta" style="gap:6px">
          <button onclick="event.stopPropagation();restoreNote(${n.id})" class="expand-action">Restore</button>
          <button onclick="event.stopPropagation();permanentDeleteNote(${n.id})" class="expand-action" style="color:var(--guava-700);border-color:var(--guava-200)">Delete</button>
        </div>
      </div>`;
    } else {
      html += `<div class="nl-item${active}${selClass}" onclick="${noteSelectMode ? `toggleNoteSelect(${n.id})` : `selectNote(${n.id})`}" data-note-id="${n.id}" draggable="true" style="animation-delay:${list.indexOf(n) * 0.03}s" oncontextmenu="showNoteContextMenu(event,${n.id})">
        <input type="checkbox" class="nl-checkbox" ${checked} onclick="event.stopPropagation();toggleNoteSelect(${n.id})">
        <div class="nl-item-head">
          <div class="nl-item-title">${escHTML(n.title || 'Untitled')}</div>
          <div class="nl-item-date">${date}</div>
        </div>
        <div class="nl-item-preview">${escHTML(preview)}</div>
        ${tagHtml ? `<div class="nl-item-meta">${tagHtml}</div>` : ''}
      </div>`;
    }
  });
  el.innerHTML = html;

  // Wire drag events (for reorder + drag to sidebar)
  el.querySelectorAll('.nl-item[draggable]').forEach(item => {
    item.addEventListener('dragstart', onNoteDragStart);
    item.addEventListener('dragend', onNoteDragEnd);
    item.addEventListener('dragover', onNoteDragOver);
    item.addEventListener('dragleave', e => e.currentTarget.classList.remove('drag-target'));
    item.addEventListener('drop', onNoteDrop);
  });
}

function renderNoteEditor() {
  const el = document.getElementById('notesEditorContent');
  if (!el) return;
  const editorEl = document.getElementById('notesEditor');
  const note = notesArr.find(n => n.id === activeNoteId);

  if (!note) {
    el.innerHTML = `<div class="notes-editor-empty">
      <div style="text-align:center">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin-bottom:10px;opacity:0.3"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        <div>Select a note or create a new one</div>
      </div>
    </div>`;
    editorEl?.classList.remove('mobile-open');
    return;
  }

  // On mobile, show editor overlay
  editorEl?.classList.add('mobile-open');

  const starFill = note.starred ? 'currentColor' : 'none';
  const nbOptions = notebooksArr.map(nb => `<option value="${nb.id}"${note.notebookId === nb.id ? ' selected' : ''}>${escHTML(nb.name)}</option>`).join('') + '<option value="__new__">+ New notebook</option>';
  const noteNb = note.notebookId ? notebooksArr.find(nb => nb.id === note.notebookId) : null;
  let noteNbTag = '';
  if (noteNb) {
    const tc = noteNb.color === 'var(--slate-fg)' ? 'tag-biz' : noteNb.color === 'var(--ochre-fg)' ? 'tag-personal' : '';
    const ts = tc ? '' : ` style="background:${noteNb.color}22;color:${noteNb.color}"`;
    noteNbTag = `<span class="nl-tag ${tc}"${ts}>${escHTML(noteNb.name)}</span><span class="dot-sep"></span>`;
  }

  el.innerHTML = `
    <div class="mobile-note-header">
      <button class="mobile-note-back" onclick="deselectNote()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
      </button>
      <div class="mobile-note-actions">
        <button class="mobile-note-action" onmousedown="event.preventDefault();document.execCommand('undo')" title="Undo">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
        </button>
        <button class="mobile-note-action" onmousedown="event.preventDefault();document.execCommand('redo')" title="Redo">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.13-9.36L23 10"/></svg>
        </button>
        <button class="mobile-note-action" onclick="confirmTrashNote()" title="Trash" style="color:var(--guava-700)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
        <button class="mobile-note-action" onclick="toggleNoteStar()" title="Star">
          <svg viewBox="0 0 24 24" fill="${starFill}" stroke="currentColor" stroke-width="2" style="color:var(--guava-700)"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
        </button>
      </div>
    </div>
    <div class="ne-body">
      <div class="ne-page">
        <input class="ne-title" id="noteTitleInput" type="text" placeholder="Untitled" value="${escAttr(note.title)}" oninput="onNoteTitleChange(this.value)" autocomplete="off" autocorrect="off" spellcheck="false">
        <div class="ne-meta">
          <div class="ne-meta-item">
            ${noteNbTag}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:11px;height:11px"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
            Created ${formatNoteDate(note.createdAt)}
            <span class="dot-sep"></span>
            Edited ${formatNoteDate(note.updatedAt)}
          </div>
          <div class="ne-meta-item" style="margin-left:auto;gap:8px">
            <select onchange="handleNoteNbChange(this, ${note.id})" style="border:1px solid var(--edge);border-radius:5px;padding:2px 6px;font-size:10px;font-family:inherit;background:var(--surface);color:var(--ink-2);cursor:pointer">
              <option value="">No notebook</option>
              ${nbOptions}
            </select>
            <button class="note-action-btn" onclick="confirmTrashNote()" title="Move to Trash" style="color:var(--guava-700);padding:3px">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
            <button class="note-action-btn${note.starred ? ' starred' : ''}" id="noteStarBtn" onclick="toggleNoteStar()" title="Star" style="padding:3px">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="${starFill}" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
            </button>
          </div>
        </div>
        <div class="ne-toolbar">
          <div class="tb-group tb-desktop-only">
            <button class="tb-btn" onmousedown="event.preventDefault();document.execCommand('undo')" title="Undo">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
            </button>
            <button class="tb-btn" onmousedown="event.preventDefault();document.execCommand('redo')" title="Redo">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.13-9.36L23 10"/></svg>
            </button>
          </div>
          <div class="tb-group">
            <select class="tb-select" onchange="noteHeading(this.value)">
              <option value="p">Normal</option>
              <option value="h1">Heading 1</option>
              <option value="h2">Heading 2</option>
            </select>
          </div>
          <div class="tb-group">
            <button class="tb-btn" onmousedown="noteCmd(event,'bold')" title="Bold">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 4h8a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"/><path d="M6 12h9a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"/></svg>
            </button>
            <button class="tb-btn" onmousedown="noteCmd(event,'italic')" title="Italic">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="19" y1="4" x2="10" y2="4"/><line x1="14" y1="20" x2="5" y2="20"/><line x1="15" y1="4" x2="9" y2="20"/></svg>
            </button>
            <button class="tb-btn" onmousedown="noteCmd(event,'underline')" title="Underline">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 3v7a6 6 0 0 0 6 6 6 6 0 0 0 6-6V3"/><line x1="4" y1="21" x2="20" y2="21"/></svg>
            </button>
          </div>
          <div class="tb-group">
            <button class="tb-btn" onmousedown="noteInsertChecklist(event)" title="Checklist">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="6" height="6" rx="1"/><path d="M5 8l1.5 1.5L9 6"/><line x1="12" y1="8" x2="21" y2="8"/><rect x="3" y="14" width="6" height="6" rx="1"/><line x1="12" y1="17" x2="21" y2="17"/></svg>
            </button>
            <button class="tb-btn" onmousedown="noteCmd(event,'insertUnorderedList')" title="Bullet list">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1" fill="currentColor"/><circle cx="4" cy="12" r="1" fill="currentColor"/><circle cx="4" cy="18" r="1" fill="currentColor"/></svg>
            </button>
            <button class="tb-btn" onmousedown="noteCmd(event,'insertOrderedList')" title="Numbered list">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><text x="4" y="7.5" font-size="7" font-weight="600" fill="currentColor" stroke="none" font-family="system-ui">1</text><text x="4" y="13.5" font-size="7" font-weight="600" fill="currentColor" stroke="none" font-family="system-ui">2</text><text x="4" y="19.5" font-size="7" font-weight="600" fill="currentColor" stroke="none" font-family="system-ui">3</text></svg>
            </button>
            <button class="tb-btn" onmousedown="noteInsertLink(event)" title="Insert link">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
            </button>
            <button class="tb-btn tb-highlight" onmousedown="noteHighlight(event)" title="Highlight" style="background:var(--highlight-yellow);border-radius:var(--r-sm)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
            </button>
          </div>
          <div class="tb-group">
            <button class="tb-btn" onmousedown="noteCmd(event,'indent')" title="Indent">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="8" x2="21" y2="8"/><line x1="9" y1="12" x2="21" y2="12"/><line x1="9" y1="16" x2="21" y2="16"/><polyline points="3 12 6 14 3 16"/></svg>
            </button>
            <button class="tb-btn" onmousedown="noteCmd(event,'outdent')" title="Outdent">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="8" x2="21" y2="8"/><line x1="9" y1="12" x2="21" y2="12"/><line x1="9" y1="16" x2="21" y2="16"/><polyline points="6 12 3 14 6 16"/></svg>
            </button>
          </div>
        </div>
        <div class="ne-text" id="noteContentEditable" contenteditable="true" data-placeholder="Start writing..." oninput="onNoteContentChange()">${note.content}</div>
      </div>
    </div>
  `;
  // Make links clickable — open in new tab on click
  const ce = document.getElementById('noteContentEditable');
  if (ce) {
    ce.addEventListener('click', e => {
      const a = e.target.closest('a');
      if (a && a.href) { e.preventDefault(); window.open(a.href, '_blank', 'noopener'); }
    });
    // Sanitize pasted content — strip external formatting, keep only safe tags
    ce.addEventListener('paste', e => {
      e.preventDefault();
      const html = e.clipboardData.getData('text/html');
      const plain = e.clipboardData.getData('text/plain').trim();
      // Auto-link bare URLs
      if (/^https?:\/\/\S+$/.test(plain)) {
        document.execCommand('insertHTML', false, `<a href="${escAttr(plain)}" target="_blank" rel="noopener">${escHTML(plain)}</a>`);
        onNoteContentChange();
        return;
      }
      if (html) {
        const tmp = document.createElement('div');
        tmp.innerHTML = html;
        // Remove script, style, iframe, object, embed, form, svg, link, meta tags
        tmp.querySelectorAll('script,style,iframe,object,embed,form,link,meta,noscript').forEach(el => el.remove());
        // Remove all event handler attributes and dangerous attrs
        tmp.querySelectorAll('*').forEach(el => {
          [...el.attributes].forEach(attr => {
            if (attr.name.startsWith('on') || attr.name === 'style' || attr.name === 'class' || attr.name === 'id') el.removeAttribute(attr.name);
          });
          // Only keep safe tags
          const safe = ['P','DIV','BR','B','STRONG','I','EM','U','A','H1','H2','H3','UL','OL','LI','BLOCKQUOTE','SPAN','SUB','SUP'];
          if (!safe.includes(el.tagName)) {
            el.replaceWith(...el.childNodes);
          }
        });
        // Clean up links
        tmp.querySelectorAll('a').forEach(a => { a.setAttribute('target','_blank'); a.setAttribute('rel','noopener'); });
        document.execCommand('insertHTML', false, tmp.innerHTML);
      } else {
        document.execCommand('insertText', false, plain);
      }
      onNoteContentChange();
    });
  }
}
function noteHeading(tag) {
  const ce = document.getElementById('noteContentEditable');
  if (!ce) return;
  ce.focus();
  // Always reset to <p> first to prevent nested headings
  document.execCommand('formatBlock', false, '<p>');
  if (tag !== 'p') {
    document.execCommand('formatBlock', false, '<' + tag + '>');
  }
  onNoteContentChange();
}

function updateNotesBadge() {
  const count = notesArr.filter(n => !n.trashed).length;
  paintBadge('notesBadgeMobile', count);
  const sbc = document.getElementById('sidebarNotesCount'); if (sbc) sbc.textContent = count;
  const pcAll = document.getElementById('pc-notes-all'); if (pcAll) pcAll.textContent = count;
  const pinned = notesArr.filter(n => !n.trashed && n.pinned).length;
  const pcPin = document.getElementById('pc-notes-pinned'); if (pcPin) pcPin.textContent = pinned;
}

/* ══════ NOTES ACTIONS ══════ */
function createNote() {
  // Auto-assign notebook if viewing one
  const nbId = notesSidebarView.startsWith('notebook-') ? parseInt(notesSidebarView.split('-')[1]) : null;
  const note = {
    id: Date.now(),
    title: '',
    content: '',
    notebookId: nbId,
    tags: [],
    starred: false,
    trashed: false,
    trashedAt: null,
    order: notesArr.length,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  notesArr.unshift(note);
  activeNoteId = note.id;
  if (!_navFromPop) history.pushState({tool: 'notes', note: note.id, drill: false}, '');
  renderNotes();
  saveNoteToDB(note);
  // Focus title input after render
  setTimeout(() => {
    const inp = document.getElementById('noteTitleInput');
    if (inp) inp.focus();
  }, 50);
}

function selectNote(id) {
  activeNoteId = id;
  if (!_navFromPop) history.pushState({tool: 'notes', note: id, drill: false}, '');
  renderNotes();
}

function deselectNote() {
  activeNoteId = null;
  renderNotes();
}

function onNoteTitleChange(val) {
  const note = notesArr.find(n => n.id === activeNoteId);
  if (!note) return;
  note.title = val;
  note.updatedAt = new Date().toISOString();
  // Debounced save
  if (_noteSaveTimer) clearTimeout(_noteSaveTimer);
  _noteSaveTimer = setTimeout(() => { saveNoteToDB(note); renderNoteList(); }, 500);
}

function onNoteContentChange() {
  const note = notesArr.find(n => n.id === activeNoteId);
  if (!note) return;
  const el = document.getElementById('noteContentEditable');
  if (!el) return;
  note.content = el.innerHTML;
  note.updatedAt = new Date().toISOString();
  if (_noteSaveTimer) clearTimeout(_noteSaveTimer);
  _noteSaveTimer = setTimeout(() => { saveNoteToDB(note); renderNoteList(); updateNoteToolbarState(); }, 1000);
}

function toggleNoteStar() {
  const note = notesArr.find(n => n.id === activeNoteId);
  if (!note) return;
  note.starred = !note.starred;
  note.updatedAt = new Date().toISOString();
  // Update all star buttons without re-rendering editor
  const fill = note.starred ? 'currentColor' : 'none';
  document.querySelectorAll('button[onclick*="toggleNoteStar"] svg polygon').forEach(p => p.setAttribute('fill', fill));
  const starBtn = document.getElementById('noteStarBtn');
  if (starBtn) starBtn.classList.toggle('starred', note.starred);
  renderNotesSidebar(); renderNoteList();
  saveNoteToDB(note);
}

function confirmTrashNote() {
  const note = notesArr.find(n => n.id === activeNoteId);
  if (!note) return;
  const title = note.title || 'Untitled';
  showInlineConfirm(`Move "${title}" to Trash?`, 'You can restore it from Trash later.', () => {
    trashNote();
  });
}
function trashNote() {
  const note = notesArr.find(n => n.id === activeNoteId);
  if (!note) return;
  note.trashed = true;
  note.trashedAt = new Date().toISOString();
  note.updatedAt = new Date().toISOString();
  activeNoteId = null;
  renderNotes();
  saveNoteToDB(note);
}
function restoreNote(id) {
  const note = notesArr.find(n => n.id === id);
  if (!note) return;
  note.trashed = false;
  note.trashedAt = null;
  note.updatedAt = new Date().toISOString();
  renderNotes();
  saveNoteToDB(note);
}
function permanentDeleteNote(id) {
  showInlineConfirm('Permanently delete?', 'This note will be gone forever.', () => {
    notesArr = notesArr.filter(n => n.id !== id);
    if (activeNoteId === id) activeNoteId = null;
    renderNotes();
    deleteNoteFromDB(id);
  });
}

function showNotebookMenu(e, id) {
  e.stopPropagation();
  // Remove any existing menu
  document.querySelectorAll('.nb-context-menu').forEach(m => m.remove());
  const menu = document.createElement('div');
  menu.className = 'nb-context-menu';
  Object.assign(menu.style, {
    position:'fixed', zIndex:'450', background:'var(--surface)', border:'1px solid var(--edge)',
    borderRadius:'10px', padding:'4px', boxShadow:'0 4px 16px rgba(0,0,0,0.12)',
    minWidth:'140px', animation:'fadeUp 0.15s ease both'
  });
  menu.innerHTML = `
    <button onclick="event.stopPropagation();this.closest('.nb-context-menu').remove();renameNotebook(${id})" style="display:flex;align-items:center;gap:8px;width:100%;padding:8px 12px;border:none;background:none;font-family:inherit;font-size:12px;cursor:pointer;border-radius:7px;color:var(--ink)">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
      Edit
    </button>
    <button onclick="event.stopPropagation();this.closest('.nb-context-menu').remove();deleteNotebook(${id})" style="display:flex;align-items:center;gap:8px;width:100%;padding:8px 12px;border:none;background:none;font-family:inherit;font-size:12px;cursor:pointer;border-radius:7px;color:var(--guava-700)">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      Delete
    </button>`;
  menu.querySelectorAll('button').forEach(b => {
    b.addEventListener('mouseenter', () => b.style.background = 'var(--surface-2)');
    b.addEventListener('mouseleave', () => b.style.background = 'none');
  });
  document.body.appendChild(menu);
  // Position near click
  const x = Math.min(e.clientX, window.innerWidth - 160);
  const y = Math.min(e.clientY, window.innerHeight - 100);
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  // Close on outside click
  setTimeout(() => {
    const close = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', close); } };
    document.addEventListener('click', close);
  }, 10);
}

function showInlinePrompt(title, defaultVal, onConfirm) {
  let overlay = document.getElementById('inlinePromptOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'inlinePromptOverlay';
    Object.assign(overlay.style, {position:'fixed',inset:'0',background:'rgba(20,20,60,0.35)',backdropFilter:'blur(3px)',zIndex:'500',display:'flex',alignItems:'center',justifyContent:'center'});
    document.body.appendChild(overlay);
  }
  overlay.style.display = 'flex';
  overlay.innerHTML = `<div style="background:var(--surface);border-radius:12px;padding:20px 24px;width:90%;max-width:360px;box-shadow:0 8px 40px rgba(0,0,0,0.15)">
    <div style="font-size:15px;font-weight:700;margin-bottom:12px">${title}</div>
    <input id="inlinePromptInput" type="text" value="${escAttr(defaultVal || '')}" style="width:100%;box-sizing:border-box;border:1px solid var(--edge-strong);border-radius:8px;padding:8px 12px;font-family:inherit;font-size:13px;outline:none" autofocus>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
      <button onclick="document.getElementById('inlinePromptOverlay').style.display='none'" style="padding:7px 16px;border-radius:8px;border:1px solid var(--edge);background:var(--surface);font-family:inherit;font-size:12px;cursor:pointer">Cancel</button>
      <button id="inlinePromptConfirm" style="padding:7px 16px;border-radius:8px;border:none;background:var(--guava-700);color:#fff;font-family:inherit;font-size:12px;font-weight:600;cursor:pointer">OK</button>
    </div>
  </div>`;
  const inp = document.getElementById('inlinePromptInput');
  const confirmBtn = document.getElementById('inlinePromptConfirm');
  setTimeout(() => { inp.focus(); inp.select(); }, 50);
  const doConfirm = () => { const v = inp.value.trim(); overlay.style.display = 'none'; if (v) onConfirm(v); };
  confirmBtn.onclick = doConfirm;
  inp.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); doConfirm(); } if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); overlay.style.display = 'none'; } };
  overlay.onclick = e => { if (e.target === overlay) overlay.style.display = 'none'; };
}

function createNotebook() {
  showNotebookPrompt('New notebook', '', '', null, (name, icon, color) => {
    const nb = {
      id: Date.now(),
      name: name,
      icon: icon || '',
      color: color,
      order: notebooksArr.length,
    };
    notebooksArr.push(nb);
    notesSidebarView = 'notebook-' + nb.id;
    renderNotes();
    saveNotebookToDB(nb);
  });
}

function renameNotebook(id) {
  const nb = notebooksArr.find(n => n.id === id);
  if (!nb) return;
  showNotebookPrompt('Edit notebook', nb.name, nb.icon || '', nb.color, (name, icon, color) => {
    nb.name = name;
    nb.icon = icon || '';
    nb.color = color;
    renderNotes();
    saveNotebookToDB(nb);
  });
}

function showNotebookPrompt(title, defaultName, defaultIcon, defaultColor, onConfirm) {
  const NB_COLORS = ['#5b82e0', '#e74c3c', '#27ae60', '#f39c12', '#8e44ad', '#1abc9c', '#e91e63', '#00bcd4', '#ff5722', '#607d8b'];
  const NB_EMOJIS = ['📓','📔','📒','📕','📗','📘','📙','📚','📖','✏️','🖊️','📝','💼','🎯','💡','🧠','🔬','🎨','🎵','🏋️','🍳','✈️','🏠','💰','📊','🌱','❤️','⭐','🔥','🚀','🎮','📸','🎬','🛠️','📱','💻','👤','👥','👨‍💻','👩‍💼','🤝','👪','📞','☎️','📲'];
  const selectedColor = defaultColor || NB_COLORS[notebooksArr.length % NB_COLORS.length];
  let overlay = document.getElementById('nbPromptOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'nbPromptOverlay';
    Object.assign(overlay.style, {position:'fixed',inset:'0',background:'rgba(20,20,60,0.35)',backdropFilter:'blur(3px)',zIndex:'500',display:'flex',alignItems:'center',justifyContent:'center'});
    document.body.appendChild(overlay);
  }
  overlay.style.display = 'flex';
  overlay.innerHTML = `<div style="background:var(--surface);border-radius:12px;padding:20px 24px;width:90%;max-width:380px;box-shadow:0 8px 40px rgba(0,0,0,0.15);max-height:80vh;overflow-y:auto">
    <div style="font-size:15px;font-weight:700;margin-bottom:14px">${title}</div>
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
      <button class="emoji-pick-btn" id="nbEmojiBtn" title="Tap to pick icon">${defaultIcon || '📓'}</button>
      <div style="flex:1">
        <input id="nbPromptInput" type="text" value="${escAttr(defaultName || '')}" placeholder="Notebook name..." style="width:100%;box-sizing:border-box;border:1px solid var(--edge-strong);border-radius:8px;padding:8px 12px;font-family:inherit;font-size:13px;outline:none" autofocus>
      </div>
    </div>
    <div class="emoji-grid" id="nbEmojiGrid" style="display:none">
      ${NB_EMOJIS.map(e => `<button onclick="document.getElementById('nbEmojiBtn').textContent='${e}';document.getElementById('nbEmojiGrid').style.display='none'">${e}</button>`).join('')}
    </div>
    <div style="margin-bottom:14px">
      <div style="font-size:11px;color:var(--ink-3);margin-bottom:6px;font-weight:500">Color</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap" id="nbColorPicker">
        ${NB_COLORS.map(c => `<button onclick="document.querySelectorAll('#nbColorPicker button').forEach(b=>b.style.outline='none');this.style.outline='2px solid var(--ink)';this.dataset.selected='true'" data-color="${c}" style="width:24px;height:24px;border-radius:50%;border:none;cursor:pointer;background:${c}${c === selectedColor ? ';outline:2px solid var(--ink)' : ''}" ${c === selectedColor ? 'data-selected="true"' : ''}></button>`).join('')}
      </div>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
      <button onclick="document.getElementById('nbPromptOverlay').style.display='none'" style="padding:7px 16px;border-radius:8px;border:1px solid var(--edge);background:var(--surface);font-family:inherit;font-size:12px;cursor:pointer">Cancel</button>
      <button id="nbPromptConfirm" style="padding:7px 16px;border-radius:8px;border:none;background:var(--guava-700);color:#fff;font-family:inherit;font-size:12px;font-weight:600;cursor:pointer">OK</button>
    </div>
  </div>`;
  const emojiBtn = document.getElementById('nbEmojiBtn');
  emojiBtn.onclick = () => {
    const grid = document.getElementById('nbEmojiGrid');
    grid.style.display = grid.style.display === 'grid' ? 'none' : 'grid';
  };
  const inp = document.getElementById('nbPromptInput');
  setTimeout(() => { inp.focus(); inp.select(); }, 50);
  const doConfirm = () => {
    const name = inp.value.trim();
    if (!name) return;
    overlay.style.display = 'none';
    const icon = emojiBtn.textContent.trim();
    const selColorBtn = document.querySelector('#nbColorPicker button[data-selected="true"]');
    const color = selColorBtn ? selColorBtn.dataset.color : selectedColor;
    onConfirm(name, icon, color);
  };
  document.getElementById('nbPromptConfirm').onclick = doConfirm;
  inp.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); doConfirm(); } if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); overlay.style.display = 'none'; } };
  overlay.onclick = e => { if (e.target === overlay) overlay.style.display = 'none'; };
}

function deleteNotebook(id) {
  const nb = notebooksArr.find(n => n.id === id);
  if (!nb) return;
  showInlineConfirm(`Delete "${nb.name}"?`, 'Notes inside will be moved to All Notes.', () => {
    notesArr.filter(n => n.notebookId === id).forEach(n => { n.notebookId = null; saveNoteToDB(n); });
    notebooksArr = notebooksArr.filter(n => n.id !== id);
    if (notesSidebarView === 'notebook-' + id) notesSidebarView = 'all';
    renderNotes();
    deleteNotebookFromDB(id);
  });
}

function reorderNotebooks(fromId, toId) {
  const sorted = notebooksArr.sort((a, b) => (a.order || 0) - (b.order || 0));
  const fromIdx = sorted.findIndex(n => n.id === fromId);
  const toIdx = sorted.findIndex(n => n.id === toId);
  if (fromIdx < 0 || toIdx < 0) return;
  const [moved] = sorted.splice(fromIdx, 1);
  sorted.splice(toIdx, 0, moved);
  sorted.forEach((nb, i) => { nb.order = i; saveNotebookToDB(nb); });
  renderNotesSidebar();
}

function emptyTrash() {
  const trashed = notesArr.filter(n => n.trashed);
  if (!trashed.length) return;
  showInlineConfirm(`Delete all ${trashed.length} trashed note${trashed.length > 1 ? 's' : ''}?`, 'This cannot be undone.', () => {
    trashed.forEach(n => { notesArr = notesArr.filter(x => x.id !== n.id); deleteNoteFromDB(n.id); });
    activeNoteId = null;
    renderNotes();
  });
}

function showInlineConfirm(title, message, onConfirm) {
  let overlay = document.createElement('div');
  Object.assign(overlay.style, {position:'fixed',inset:'0',background:'rgba(20,20,60,0.35)',backdropFilter:'blur(3px)',zIndex:'500',display:'flex',alignItems:'center',justifyContent:'center'});
  const card = document.createElement('div');
  Object.assign(card.style, {background:'var(--surface)',borderRadius:'14px',padding:'24px 28px',maxWidth:'340px',width:'90%',boxShadow:'0 8px 32px rgba(0,0,0,0.15)',animation:'fadeUp 0.2s cubic-bezier(0.34,1.4,0.64,1) both'});
  card.innerHTML = `<div style="font-weight:600;font-size:15px;margin-bottom:6px">${title}</div>
    <div style="font-size:13px;color:var(--ink-2);margin-bottom:20px">${message}</div>
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button id="icCancel" style="padding:7px 16px;border-radius:8px;border:1px solid var(--edge-strong);background:var(--surface);font-family:inherit;font-size:12px;cursor:pointer;color:var(--ink-2)">Cancel</button>
      <button id="icConfirm" style="padding:7px 16px;border-radius:8px;border:none;background:var(--guava-700);color:#fff;font-family:inherit;font-size:12px;cursor:pointer;font-weight:600">Delete</button>
    </div>`;
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  card.querySelector('#icCancel').onclick = close;
  card.querySelector('#icConfirm').onclick = () => { close(); onConfirm(); };
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } });
}

function handleNoteNbChange(selectEl, noteId) {
  if (selectEl.value === '__new__') {
    selectEl.value = ''; // reset dropdown
    showNotebookPrompt('New notebook', '', '', null, (name, icon, color) => {
      const nb = { id: Date.now(), name, icon: icon || '', color, order: notebooksArr.length };
      notebooksArr.push(nb);
      moveNoteToNotebook(noteId, nb.id);
      renderNotes();
      saveNotebookToDB(nb);
    });
  } else {
    moveNoteToNotebook(noteId, selectEl.value ? parseInt(selectEl.value) : null);
  }
}

function moveNoteToNotebook(noteId, nbId) {
  const note = notesArr.find(n => n.id === noteId);
  if (!note) return;
  note.notebookId = nbId;
  note.updatedAt = new Date().toISOString();
  renderNotes();
  saveNoteToDB(note);
}

/* ══════ BULK SELECT ══════ */
function enterNoteSelectMode() {
  noteSelectMode = true;
  selectedNoteIds.clear();
  renderNoteList();
}
function exitNoteSelectMode() {
  noteSelectMode = false;
  selectedNoteIds.clear();
  renderNoteList();
}
function toggleNoteSelect(id) {
  if (selectedNoteIds.has(id)) selectedNoteIds.delete(id);
  else selectedNoteIds.add(id);
  renderNoteList();
}
function toggleSelectAllNotes() {
  const list = getFilteredNotes();
  if (selectedNoteIds.size === list.length) {
    selectedNoteIds.clear();
  } else {
    list.forEach(n => selectedNoteIds.add(n.id));
  }
  renderNoteList();
}
function bulkTrashNotes() {
  if (selectedNoteIds.size === 0) return;
  showInlineConfirm(`Trash ${selectedNoteIds.size} note${selectedNoteIds.size > 1 ? 's' : ''}?`, 'They can be restored from trash.', () => {
    selectedNoteIds.forEach(id => {
      const note = notesArr.find(n => n.id === id);
      if (note) {
        note.trashed = true;
        note.trashedAt = new Date().toISOString();
        note.updatedAt = new Date().toISOString();
        saveNoteToDB(note);
      }
    });
    activeNoteId = null;
    exitNoteSelectMode();
    renderNotes();
  });
}
function bulkMoveNotes(e) {
  e.stopPropagation();
  if (selectedNoteIds.size === 0) return;
  document.querySelectorAll('.note-ctx-menu').forEach(m => m.remove());
  const menu = document.createElement('div');
  menu.className = 'note-ctx-menu';
  let html = `<button onclick="this.closest('.note-ctx-menu').remove();bulkMoveToNotebook(null)">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    No notebook</button>`;
  notebooksArr.forEach(nb => {
    html += `<button onclick="this.closest('.note-ctx-menu').remove();bulkMoveToNotebook(${nb.id})">
      <div class="nb-dot" style="background:${nb.color}"></div>${escHTML(nb.name)}</button>`;
  });
  menu.innerHTML = html;
  document.body.appendChild(menu);
  const x = Math.min(e.clientX || 100, window.innerWidth - 180);
  const y = Math.min(e.clientY || 100, window.innerHeight - 200);
  menu.style.left = x + 'px'; menu.style.top = y + 'px';
  setTimeout(() => {
    const close = ev => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', close); } };
    document.addEventListener('click', close);
  }, 10);
}
function bulkMoveToNotebook(nbId) {
  selectedNoteIds.forEach(id => {
    const note = notesArr.find(n => n.id === id);
    if (note) { note.notebookId = nbId; note.updatedAt = new Date().toISOString(); saveNoteToDB(note); }
  });
  exitNoteSelectMode();
  renderNotes();
}

/* ══════ NOTE CONTEXT MENU ══════ */
function showNoteContextMenu(e, noteId) {
  e.preventDefault(); e.stopPropagation();
  document.querySelectorAll('.note-ctx-menu').forEach(m => m.remove());
  const note = notesArr.find(n => n.id === noteId);
  if (!note) return;
  const menu = document.createElement('div');
  menu.className = 'note-ctx-menu';
  let html = '';
  if (note.trashed) {
    html = `
      <button onclick="this.closest('.note-ctx-menu').remove();restoreNote(${noteId})">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
        Restore</button>
      <button class="danger" onclick="this.closest('.note-ctx-menu').remove();permanentDeleteNote(${noteId})">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        Delete permanently</button>`;
  } else {
    const starLabel = note.starred ? 'Unstar' : 'Star';
    const starFill = note.starred ? 'currentColor' : 'none';
    html = `
      <button onclick="this.closest('.note-ctx-menu').remove();activeNoteId=${noteId};toggleNoteStar()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="${starFill}" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
        ${starLabel}</button>
      <div class="ctx-submenu">
        <button style="justify-content:space-between">
          <span style="display:flex;align-items:center;gap:8px"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg> Move to</span>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
        <div class="ctx-sub-items">
          <button onclick="this.closest('.note-ctx-menu').remove();moveNoteToNotebook(${noteId},null)">No notebook</button>`;
    notebooksArr.forEach(nb => {
      html += `<button onclick="this.closest('.note-ctx-menu').remove();moveNoteToNotebook(${noteId},${nb.id})">
        <div class="nb-dot" style="background:${nb.color}"></div>${escHTML(nb.name)}</button>`;
    });
    html += `</div></div>
      <button onclick="this.closest('.note-ctx-menu').remove();enterNoteSelectMode();toggleNoteSelect(${noteId})">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 12l2 2 4-4"/></svg>
        Select</button>
      <div class="ctx-divider"></div>
      <button class="danger" onclick="this.closest('.note-ctx-menu').remove();activeNoteId=${noteId};trashNote()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        Move to Trash</button>`;
  }
  menu.innerHTML = html;
  document.body.appendChild(menu);
  const x = Math.min(e.clientX, window.innerWidth - 190);
  const y = Math.min(e.clientY, window.innerHeight - 200);
  menu.style.left = x + 'px'; menu.style.top = y + 'px';
  setTimeout(() => {
    const close = ev => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', close); } };
    document.addEventListener('click', close);
  }, 10);
}

function sortNotesToggle() {
  const orders = ['updated', 'created', 'alpha', 'manual'];
  const idx = orders.indexOf(noteSortOrder);
  noteSortOrder = orders[(idx + 1) % orders.length];
  renderNoteList();
}

// Note drag-to-reorder
let noteDragId = null;
let noteSelectMode = false;
let selectedNoteIds = new Set();
function onNoteDragStart(e) {
  noteDragId = parseInt(e.currentTarget.dataset.noteId);
  e.currentTarget.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}
function onNoteDragEnd(e) {
  e.currentTarget.classList.remove('dragging');
  document.querySelectorAll('.nl-item').forEach(el => el.classList.remove('drag-target'));
  document.querySelectorAll('.ns-item').forEach(el => el.classList.remove('drop-target'));
  noteDragId = null;
}
function onNoteDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const id = parseInt(e.currentTarget.dataset.noteId);
  if (id === noteDragId) return;
  document.querySelectorAll('.nl-item').forEach(el => el.classList.remove('drag-target'));
  e.currentTarget.classList.add('drag-target');
}
function onNoteDrop(e) {
  e.preventDefault();
  const targetId = parseInt(e.currentTarget.dataset.noteId);
  if (!noteDragId || noteDragId === targetId) return;
  const list = getFilteredNotes();
  const fromIdx = list.findIndex(n => n.id === noteDragId);
  const toIdx = list.findIndex(n => n.id === targetId);
  if (fromIdx < 0 || toIdx < 0) return;
  // Reorder
  const [moved] = list.splice(fromIdx, 1);
  list.splice(toIdx, 0, moved);
  list.forEach((n, i) => { n.order = i; });
  noteSortOrder = 'manual';
  renderNoteList();
  // Save all reordered notes
  list.forEach(n => saveNoteToDB(n));
}

/* ══════ SCRATCH ══════ */
let _scratchSaveTimer = null;

function renderScratch() {
  const el = document.getElementById('scratchEditorContent');
  if (!el) return;
  // IMPORTANT: don't add .mobile-open here. That class turns the editor into
  // a position:fixed top:0 overlay which covers the app header. Scratch
  // should flow in-page with the header visible above it.
  document.getElementById('scratchEditor')?.classList.remove('mobile-open');
  const saved = scratchNote.content || localStorage.getItem('gsd-scratch') || '';
  el.innerHTML = `
    <div class="ne-body">
      <div class="ne-page"><!-- scratch-header removed: redundant with app header -->
        <div class="ne-toolbar">
          <div class="tb-group tb-desktop-only">
            <button class="tb-btn" onmousedown="scratchCmd(event,'undo')" title="Undo">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
            </button>
            <button class="tb-btn" onmousedown="scratchCmd(event,'redo')" title="Redo">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.13-9.36L23 10"/></svg>
            </button>
          </div>
          <div class="tb-group">
            <select class="tb-select" onchange="scratchHeading(this.value)">
              <option value="p">Normal</option>
              <option value="h1">Heading 1</option>
              <option value="h2">Heading 2</option>
            </select>
          </div>
          <div class="tb-group">
            <button class="tb-btn" onmousedown="scratchCmd(event,'bold')" title="Bold">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 4h8a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"/><path d="M6 12h9a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"/></svg>
            </button>
            <button class="tb-btn" onmousedown="scratchCmd(event,'italic')" title="Italic">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="19" y1="4" x2="10" y2="4"/><line x1="14" y1="20" x2="5" y2="20"/><line x1="15" y1="4" x2="9" y2="20"/></svg>
            </button>
            <button class="tb-btn" onmousedown="scratchCmd(event,'underline')" title="Underline">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 3v7a6 6 0 0 0 6 6 6 6 0 0 0 6-6V3"/><line x1="4" y1="21" x2="20" y2="21"/></svg>
            </button>
          </div>
          <div class="tb-group">
            <button class="tb-btn" onmousedown="scratchInsertChecklist(event)" title="Checklist">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="6" height="6" rx="1"/><path d="M5 8l1.5 1.5L9 6"/><line x1="12" y1="8" x2="21" y2="8"/><rect x="3" y="14" width="6" height="6" rx="1"/><line x1="12" y1="17" x2="21" y2="17"/></svg>
            </button>
            <button class="tb-btn" onmousedown="scratchCmd(event,'insertUnorderedList')" title="Bullet list">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1" fill="currentColor"/><circle cx="4" cy="12" r="1" fill="currentColor"/><circle cx="4" cy="18" r="1" fill="currentColor"/></svg>
            </button>
            <button class="tb-btn" onmousedown="scratchCmd(event,'insertOrderedList')" title="Numbered list">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><text x="4" y="7.5" font-size="7" font-weight="600" fill="currentColor" stroke="none" font-family="system-ui">1</text><text x="4" y="13.5" font-size="7" font-weight="600" fill="currentColor" stroke="none" font-family="system-ui">2</text><text x="4" y="19.5" font-size="7" font-weight="600" fill="currentColor" stroke="none" font-family="system-ui">3</text></svg>
            </button>
            <button class="tb-btn" onmousedown="scratchInsertLink(event)" title="Insert link">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
            </button>
            <button class="tb-btn tb-highlight" onmousedown="scratchHighlight(event)" title="Highlight" style="background:var(--highlight-yellow);border-radius:var(--r-sm)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
            </button>
          </div>
          <div class="tb-group">
            <button class="tb-btn" onmousedown="scratchCmd(event,'indent')" title="Indent">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="8" x2="21" y2="8"/><line x1="9" y1="12" x2="21" y2="12"/><line x1="9" y1="16" x2="21" y2="16"/><polyline points="3 12 6 14 3 16"/></svg>
            </button>
            <button class="tb-btn" onmousedown="scratchCmd(event,'outdent')" title="Outdent">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="8" x2="21" y2="8"/><line x1="9" y1="12" x2="21" y2="12"/><line x1="9" y1="16" x2="21" y2="16"/><polyline points="6 12 3 14 6 16"/></svg>
            </button>
          </div>
        </div>
        <div class="ne-text" id="scratchContentEditable" contenteditable="true" data-placeholder="Brain dump here..." oninput="onScratchContentChange()">${saved}</div>
      </div>
    </div>
  `;
  // Wire paste handler (same sanitization as notes)
  const ce = document.getElementById('scratchContentEditable');
  if (ce) {
    ce.addEventListener('click', e => {
      const a = e.target.closest('a');
      if (a && a.href) { e.preventDefault(); window.open(a.href, '_blank', 'noopener'); }
    });
    ce.addEventListener('paste', e => {
      e.preventDefault();
      const html = e.clipboardData.getData('text/html');
      const plain = e.clipboardData.getData('text/plain').trim();
      // Auto-link bare URLs
      if (/^https?:\/\/\S+$/.test(plain)) {
        document.execCommand('insertHTML', false, `<a href="${escAttr(plain)}" target="_blank" rel="noopener">${escHTML(plain)}</a>`);
        onScratchContentChange();
        return;
      }
      if (html) {
        const tmp = document.createElement('div');
        tmp.innerHTML = html;
        tmp.querySelectorAll('script,style,iframe,object,embed,form,link,meta,noscript').forEach(el => el.remove());
        tmp.querySelectorAll('*').forEach(el => {
          [...el.attributes].forEach(attr => {
            if (attr.name.startsWith('on') || attr.name === 'style' || attr.name === 'class' || attr.name === 'id') el.removeAttribute(attr.name);
          });
          const safe = ['P','DIV','BR','B','STRONG','I','EM','U','A','H1','H2','H3','UL','OL','LI','BLOCKQUOTE','SPAN','SUB','SUP'];
          if (!safe.includes(el.tagName)) el.replaceWith(...el.childNodes);
        });
        tmp.querySelectorAll('a').forEach(a => { a.setAttribute('target','_blank'); a.setAttribute('rel','noopener'); });
        document.execCommand('insertHTML', false, tmp.innerHTML);
      } else {
        document.execCommand('insertText', false, plain);
      }
      onScratchContentChange();
    });
    // Auto-focus the content area
    setTimeout(() => ce.focus(), 50);
  }
  // Hide FAB — not relevant for scratch
  document.getElementById('fabBtn')?.classList.add('hidden');
}

function onScratchContentChange() {
  const ce = document.getElementById('scratchContentEditable');
  if (!ce) return;
  // Update in-memory state immediately — no lag
  scratchNote.content = ce.innerHTML;
  scratchNote.updatedAt = new Date().toISOString();
  // Cache locally for fast reload
  localStorage.setItem('gsd-scratch', scratchNote.content);
  // Debounced DB sync — 1s matches notes, avoids hammering on every keystroke
  if (_scratchSaveTimer) clearTimeout(_scratchSaveTimer);
  _scratchSaveTimer = setTimeout(() => { saveNoteToDB(scratchNote); }, 1000);
}

function scratchCmd(e, cmd) {
  e.preventDefault();
  document.getElementById('scratchContentEditable')?.focus();
  document.execCommand(cmd, false, null);
}
function scratchHeading(tag) {
  const ce = document.getElementById('scratchContentEditable');
  if (!ce) return;
  ce.focus();
  document.execCommand('formatBlock', false, '<p>');
  if (tag !== 'p') document.execCommand('formatBlock', false, '<' + tag + '>');
  onScratchContentChange();
}
function scratchInsertChecklist(e) {
  e.preventDefault();
  const editor = document.getElementById('scratchContentEditable');
  if (!editor) return;
  editor.focus();
  const sel = window.getSelection();
  const text = sel.rangeCount ? sel.toString().trim() : '';
  const label = text || 'Item';
  document.execCommand('insertHTML', false, '<div class="note-checklist-item"><input type="checkbox" onclick="this.parentElement.classList.toggle(\'checked\',this.checked)"> <span>' + label.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</span></div>');
}
function scratchHighlight(e) {
  e.preventDefault();
  document.getElementById('scratchContentEditable')?.focus();
  document.execCommand('hiliteColor', false, '#fef08a');
}
function scratchInsertLink(e) {
  e.preventDefault();
  const sel = window.getSelection();
  const range = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
  showInlinePrompt('Insert link', 'https://', url => {
    if (!url) return;
    const editor = document.getElementById('scratchContentEditable');
    if (!editor) return;
    editor.focus();
    if (range) { sel.removeAllRanges(); sel.addRange(range); }
    document.execCommand('createLink', false, url);
    setTimeout(() => {
      document.querySelectorAll('#scratchContentEditable a').forEach(a => {
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener');
      });
    }, 50);
  });
}

function noteCmd(e, cmd) {
  e.preventDefault();
  document.getElementById('noteContentEditable')?.focus();
  document.execCommand(cmd, false, null);
  setTimeout(updateNoteToolbarState, 10);
}
function noteInsertChecklist(e) {
  e.preventDefault();
  const editor = document.getElementById('noteContentEditable');
  if (!editor) return;
  editor.focus();
  const sel = window.getSelection();
  const text = sel.rangeCount ? sel.toString().trim() : '';
  const label = text || 'Item';
  document.execCommand('insertHTML', false, '<div class="note-checklist-item"><input type="checkbox" onclick="this.parentElement.classList.toggle(\'checked\',this.checked)"> <span>' + label.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</span></div>');
}
function noteHighlight(e) {
  e.preventDefault();
  document.getElementById('noteContentEditable')?.focus();
  document.execCommand('hiliteColor', false, '#fef08a');
}
function noteFontSize(size) {
  document.getElementById('noteContentEditable')?.focus();
  document.execCommand('fontSize', false, size);
}
function noteInsertLink(e) {
  e.preventDefault();
  // Save selection before opening modal
  const sel = window.getSelection();
  const range = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
  showInlinePrompt('Insert link', 'https://', url => {
    if (!url) return;
    const editor = document.getElementById('noteContentEditable');
    if (!editor) return;
    editor.focus();
    if (range) { sel.removeAllRanges(); sel.addRange(range); }
    document.execCommand('createLink', false, url);
    setTimeout(() => {
      document.querySelectorAll('#noteContentEditable a').forEach(a => {
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener');
      });
    }, 50);
  });
}

function showNoteMenu(e) {
  e.preventDefault(); e.stopPropagation();
  document.querySelectorAll('.nb-context-menu').forEach(m => m.remove());
  const menu = document.createElement('div');
  menu.className = 'nb-context-menu';
  Object.assign(menu.style, {
    position:'fixed', zIndex:'450', background:'var(--surface)', border:'1px solid var(--edge)',
    borderRadius:'10px', padding:'4px', boxShadow:'0 4px 16px rgba(0,0,0,0.12)',
    minWidth:'150px', animation:'fadeUp 0.15s ease both'
  });
  const note = notesArr.find(n => n.id === activeNoteId);
  const starLabel = note?.starred ? 'Unstar' : 'Star';
  menu.innerHTML = `
    <button class="nb-menu-btn" onclick="this.closest('.nb-context-menu').remove();toggleNoteStar()">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="${note?.starred?'currentColor':'none'}" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
      ${starLabel}
    </button>
    <button class="nb-menu-btn" onclick="this.closest('.nb-context-menu').remove();trashNote()" style="color:var(--guava-700)">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      Move to Trash
    </button>`;
  menu.querySelectorAll('.nb-menu-btn').forEach(b => {
    Object.assign(b.style, {display:'flex',alignItems:'center',gap:'8px',width:'100%',padding:'8px 12px',border:'none',background:'none',fontFamily:'inherit',fontSize:'12px',cursor:'pointer',borderRadius:'7px',color:b.style.color||'var(--ink)'});
    b.addEventListener('mouseenter', () => b.style.background = 'var(--surface-2)');
    b.addEventListener('mouseleave', () => b.style.background = 'none');
  });
  document.body.appendChild(menu);
  const x = Math.min(e.clientX || (window.innerWidth - 160), window.innerWidth - 170);
  const y = Math.min(e.clientY || 60, window.innerHeight - 100);
  menu.style.left = x + 'px'; menu.style.top = y + 'px';
  setTimeout(() => {
    const close = ev => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', close); } };
    document.addEventListener('click', close);
  }, 10);
}

// Toolbar active state tracking
function updateNoteToolbarState() {
  const btns = document.querySelectorAll('.ne-toolbar .tb-btn');
  btns.forEach(btn => {
    const title = btn.getAttribute('title');
    let active = false;
    if (title === 'Bold') active = document.queryCommandState('bold');
    else if (title === 'Italic') active = document.queryCommandState('italic');
    else if (title === 'Underline') active = document.queryCommandState('underline');
    btn.classList.toggle('tb-active', active);
  });
  // Update heading dropdown
  const sel = document.querySelector('.ne-toolbar .tb-select');
  if (sel) {
    const block = document.queryCommandValue('formatBlock');
    if (block === 'h1') sel.value = 'h1';
    else if (block === 'h2') sel.value = 'h2';
    else sel.value = 'p';
  }
}

// Tab indent/outdent in note editor + Enter to break out of indent
document.addEventListener('keydown', e => {
  const editor = document.getElementById('noteContentEditable');
  if (!editor || !editor.contains(e.target)) return;
  if (e.key === 'Tab') {
    e.preventDefault();
    document.execCommand(e.shiftKey ? 'outdent' : 'indent', false, null);
  }
  // Ctrl+Z / Ctrl+Y for undo/redo
  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); document.execCommand('undo'); }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); document.execCommand('redo'); }
});

// Track selection changes for toolbar state
document.addEventListener('selectionchange', () => {
  const editor = document.getElementById('noteContentEditable');
  if (editor && editor.contains(document.activeElement)) updateNoteToolbarState();
});

// Helper functions
function stripHTML(html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  return tmp.textContent || tmp.innerText || '';
}
function escHTML(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function escAttr(s) {
  return s.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
}
function formatNoteDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const diff = now - d;
  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  if (diff < 604800000) return Math.floor(diff / 86400000) + 'd ago';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
function formatNoteDateFull(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ' at ' +
    d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}


function toggleNoteField() {
  noteOpen = !noteOpen;
  document.getElementById('noteWrap').classList.toggle('open', noteOpen);
  document.getElementById('noteToggle').classList.toggle('active', noteOpen);
  if (noteOpen) document.getElementById('newNoteInput').focus();
}
function toggleDueDateField() {
  dueDateOpen = !dueDateOpen;
  document.getElementById('dueDateWrap').classList.toggle('open', dueDateOpen);
  document.getElementById('dueDateToggle').classList.toggle('active', dueDateOpen);
  if (dueDateOpen) document.getElementById('newDueDate').focus();
}
function toggleNewTag(tag) {
  const btn = document.getElementById('opt-'+tag);
  if (newTags.has(tag)) { newTags.delete(tag); btn.classList.remove('selected'); }
  else { newTags.add(tag); btn.classList.add('selected'); }
}
function addTask() {
  const text = document.getElementById('newTaskInput').value.trim();
  if (!text) return;
  const note = document.getElementById('newNoteInput').value.trim();
  const due = document.getElementById('newDueDate').value || null;
  const newTask = {
    id: Date.now(), text,
    tags: [...newTags].filter(t=>t!=='top3'&&t!=='someday'),
    top3: newTags.has('top3'),
    someday: newTags.has('someday'),
    done: false, note, due, order: -1
  };
  tasks.unshift(newTask);
  tasks.filter(t=>!t.done).sort((a,b)=>(a.order??0)-(b.order??0)).forEach((t,i)=>t.order=i);
  document.getElementById('newTaskInput').value = '';
  document.getElementById('newNoteInput').value = '';
  document.getElementById('newDueDate').value = '';
  noteOpen = false; dueDateOpen = false;
  document.getElementById('noteWrap').classList.remove('open');
  document.getElementById('noteToggle').classList.remove('active');
  document.getElementById('dueDateWrap').classList.remove('open');
  document.getElementById('dueDateToggle').classList.remove('active');
  newTags.clear();
  document.querySelectorAll('.create-panel-tags .tag-btn').forEach(b=>b.classList.remove('selected'));
  closeCreatePanel();
  render();
  saveTask(newTask);
  const newEl = document.getElementById('ti-' + newTask.id);
  if (newEl) { newEl.classList.add('new-task'); setTimeout(()=>newEl.classList.remove('new-task'), 400); }
}
function toggleDone_t(id) {
  const t = tasks.find(t=>t.id===id);
  if (t) { t.done=!t.done; render(); saveTask(t); }
}
function toggleTop3(id) {
  const t = tasks.find(t=>t.id===id);
  if (!t) return;
  t.top3=!t.top3; render(); saveTask(t);
}
function delTask(id) {
  const t = tasks.find(t=>t.id===id);
  if (!t) return;
  showConfirm({
    icon: '🗑️',
    title: 'Delete task?',
    desc: `"${t.text.length > 60 ? t.text.slice(0,60)+'…' : t.text}" will be permanently removed.`,
    confirmLabel: 'Delete',
    confirmClass: 'danger',
    onConfirm: () => {
      tasks = tasks.filter(t=>t.id!==id);
      // Cascade: drop subtasks for this task (local + DB)
      const tcid = String(id);
      const orphaned = subtasks.filter(s => s.task_client_id === tcid && !s.isNew);
      subtasks = subtasks.filter(s => s.task_client_id !== tcid);
      rebuildSubtasksIndex();
      expandedTaskIds.delete(id);
      render();
      deleteTask(id);
      orphaned.forEach(s => dbDeleteSubtask(s.client_id));
    }
  });
}
function toggleDone() { showDone=!showDone; render(); }

function toggleSortDropdown(e) {
  e.stopPropagation();
  const dd = document.getElementById('sortDropdown');
  if (!dd) return;
  const isOpen = dd.classList.toggle('open');
  if (isOpen) {
    const r = e.currentTarget.getBoundingClientRect();
    dd.style.top = (r.bottom + 4) + 'px';
    dd.style.right = (window.innerWidth - r.right) + 'px';
  }
}
function setSort(val) {
  sortBy = val;
  const dd = document.getElementById('sortDropdown');
  if (dd) {
    dd.classList.remove('open');
    dd.querySelectorAll('.sort-opt').forEach(o => o.classList.toggle('active', o.textContent === {default:'User Sorted',recent:'Recently Created',due:'Due Date'}[val]));
  }
  render();
}
document.addEventListener('click', () => {
  const dd = document.getElementById('sortDropdown');
  if (dd) dd.classList.remove('open');
});

function openEdit(id) {
  const t = tasks.find(t=>t.id===id);
  if (!t) return;
  editId = id;
  document.getElementById('editText').value = t.text;
  // Rich text note
  const editor = document.getElementById('editNoteRich');
  editor.innerHTML = t.note || '';
  document.getElementById('editDueDate').value = t.due||'';
  // Tags
  document.getElementById('editTags').innerHTML = [
    {key:'top3',label:'&#9733;',cls:'t3',title:'Priority'},
    {key:'biz',label:'Work',cls:'biz'},
    {key:'personal',label:'Personal',cls:'personal'},
    {key:'someday',label:'Later',cls:''},
  ].map(td=>{
    const sel=(td.key==='top3'?t.top3:td.key==='someday'?t.someday:t.tags.includes(td.key))?'selected':'';
    return `<button class="tag-btn ${td.cls} ${sel}" data-key="${td.key}" title="${td.title||td.label}" onclick="this.classList.toggle('selected')">${td.label}</button>`;
  }).join('');
  document.getElementById('editModal').classList.add('open');
  setTimeout(()=>updateRichToolbarState(), 50);
}
function saveEdit() {
  const t = tasks.find(t=>t.id===editId);
  if (!t) return;
  t.text = document.getElementById('editText').value.trim();
  t.note = document.getElementById('editNoteRich').innerHTML.trim();
  // Clean empty note
  if (t.note === '<br>' || t.note === '<div><br></div>') t.note = '';
  t.due = document.getElementById('editDueDate').value || null;
  const sel=[...document.querySelectorAll('#editTags .tag-btn.selected')].map(b=>b.dataset.key).filter(Boolean);
  t.tags=sel.filter(s=>s==='biz'||s==='personal');
  t.top3=sel.includes('top3'); t.someday=sel.includes('someday');
  closeModal(); render(); saveTask(t);
}
function closeModal() { document.getElementById('editModal').classList.remove('open'); editId=null; }
document.getElementById('editModal').addEventListener('click',function(e){if(e.target===this)closeModal();});

/* ═══════════════════════════════════════════════
   RICH TEXT NOTE EDITOR
═══════════════════════════════════════════════ */
function richCmd(e, cmd) {
  e.preventDefault();
  document.getElementById('editNoteRich').focus();
  document.execCommand(cmd, false, null);
  updateRichToolbarState();
}
function richInsertLink(e) {
  e.preventDefault();
  const editor = document.getElementById('editNoteRich');
  editor.focus();
  const sel = window.getSelection();
  const text = sel && sel.toString();
  const url = prompt('Enter URL:', 'https://');
  if (url && url !== 'https://') {
    document.execCommand('insertHTML', false,
      `<a href="${url}" target="_blank">${text||url}</a>`);
  }
}
function updateRichToolbarState() {
  ['bold','italic'].forEach(cmd=>{
    const btn = document.querySelector(`.rich-btn[data-cmd="${cmd}"]`);
    if (btn) btn.classList.toggle('active', document.queryCommandState(cmd));
  });
}
function richAutoLink(el) {
  // Auto-linkify plain-typed URLs — only on space/enter
}
// Paste handler for task note editor — auto-links bare URLs
document.getElementById('editNoteRich').addEventListener('paste', e => {
  const plain = e.clipboardData.getData('text/plain').trim();
  if (/^https?:\/\/\S+$/.test(plain)) {
    e.preventDefault();
    document.execCommand('insertHTML', false, `<a href="${escAttr(plain)}" target="_blank" rel="noopener">${escHTML(plain)}</a>`);
  }
});
// Convert stored HTML to display-safe note.
// Uses DOMPurify (loaded via CDN in <head>) — strips scripts, styles,
// event-handler attributes (onerror, onload, etc.), javascript: URLs, and other
// XSS vectors while preserving the rich-text tags we actually use.
function richToDisplay(html) {
  if (!html) return '';
  if (typeof DOMPurify === 'undefined') {
    // Defensive fallback if CDN fails to load — strip everything to plain text.
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    return (tmp.textContent || tmp.innerText || '').replace(/[<>&"']/g, c =>
      ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c]));
  }
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['target', 'rel'],
  });
}

/* ═══════════════════════════════════════════════
   SWIPE TO DELETE
═══════════════════════════════════════════════ */
/* ═══════════════════════════════════════════════
   NOTE CLAMP TOGGLE
═══════════════════════════════════════════════ */
function toggleNote(e, id) {
  e.stopPropagation();
  const note = document.getElementById('note-' + id);
  const btn  = document.getElementById('nmr-' + id);
  if (!note || !btn) return;
  const expanded = !note.classList.contains('clamped');
  note.classList.toggle('clamped', expanded);
  btn.textContent = expanded ? 'Read more' : 'Show less';
}

// After render, hide "Read more" buttons for notes that don't overflow
function initNoteClamps() {
  document.querySelectorAll('.task-note.clamped').forEach(note => {
    const btn = note.nextElementSibling;
    if (!btn || !btn.classList.contains('note-read-more')) return;
    // If not clamped (content fits in 2 lines), hide button
    const isClamped = note.scrollHeight > note.clientHeight + 2;
    btn.style.display = isClamped ? 'block' : 'none';
  });
}

/* ═══════════════════════════════════════════════
   TOUCH DRAG TO REORDER
   Right-swipe on handle triggers drag mode
═══════════════════════════════════════════════ */
let tdDragId = null, tdGhost = null, tdStartY = 0, tdStartX = 0;
let tdDragging = false, tdOverId = null;
const TD_MOVE_THRESHOLD = 8; // px before drag starts

function getTouchItem(y) {
  // Find which task-item is at this Y position
  const items = [...document.querySelectorAll('.task-item:not(.touch-dragging)')];
  for (const item of items) {
    const r = item.getBoundingClientRect();
    if (y >= r.top && y <= r.bottom) return item;
  }
  return null;
}

document.addEventListener('touchstart', function(e) {
  const handle = e.target.closest('.drag-handle');
  const item   = e.target.closest('.task-item');
  const habitCard = e.target.closest('.habit-today-card');

  if (handle && item && !item.classList.contains('done')) {
    // Drag mode — initiated from handle
    tdDragId   = parseInt(item.dataset.id);
    tdStartY   = e.touches[0].clientY;
    tdStartX   = e.touches[0].clientX;
    tdDragging = false;
    e.preventDefault(); // prevent scroll
  } else if (item) {
    // Potential swipe on task card
    swipeEl      = item;
    swipeType    = 'task';
    swipeId      = parseInt(item.dataset.id);
    swipeStartX  = e.touches[0].clientX;
    swipeStartY  = e.touches[0].clientY;
    swipeDelta   = 0;
    swipeDir     = null; // null = undecided, 'h' = horizontal, 'v' = vertical
  } else if (habitCard) {
    // Potential swipe on habit card
    swipeEl      = habitCard;
    swipeType    = 'habit';
    swipeId      = parseInt(habitCard.dataset.habitId);
    swipeStartX  = e.touches[0].clientX;
    swipeStartY  = e.touches[0].clientY;
    swipeDelta   = 0;
    swipeDir     = null;
  }
}, {passive: false});

document.addEventListener('touchmove', function(e) {
  // ── DRAG REORDER ──
  if (tdDragId !== null) {
    const touch = e.touches[0];
    const dy = touch.clientY - tdStartY;
    const dx = touch.clientX - tdStartX;

    if (!tdDragging && (Math.abs(dy) > TD_MOVE_THRESHOLD || Math.abs(dx) > TD_MOVE_THRESHOLD)) {
      tdDragging = true;
      const srcEl = document.getElementById('ti-' + tdDragId);
      if (srcEl) srcEl.classList.add('touch-dragging');
      // Create ghost
      tdGhost = document.createElement('div');
      tdGhost.className = 'touch-drag-ghost';
      const t = tasks.find(t => t.id === tdDragId);
      tdGhost.textContent = t ? t.text : '';
      document.body.appendChild(tdGhost);
    }

    if (tdDragging) {
      e.preventDefault();
      // Move ghost
      if (tdGhost) {
        tdGhost.style.left = (touch.clientX - 20) + 'px';
        tdGhost.style.top  = (touch.clientY - 20) + 'px';
      }
      // Highlight target
      const overItem = getTouchItem(touch.clientY);
      const overId   = overItem ? parseInt(overItem.dataset.id) : null;
      if (overId !== tdOverId) {
        document.querySelectorAll('.task-item').forEach(el => el.classList.remove('touch-drag-over'));
        if (overItem && overId !== tdDragId) overItem.classList.add('touch-drag-over');
        tdOverId = overId;
      }
    }
    return;
  }

  // ── SWIPE (DELETE LEFT / COMPLETE RIGHT) ──
  if (!swipeEl) return;
  const dx = e.touches[0].clientX - swipeStartX;
  const dy = e.touches[0].clientY - swipeStartY;

  // Direction lock: decide on first 15px of movement
  if (swipeDir === null) {
    if (Math.abs(dx) < 15 && Math.abs(dy) < 15) return; // dead zone
    swipeDir = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
  }
  if (swipeDir === 'v') { swipeEl = null; return; } // vertical scroll, cancel swipe

  e.preventDefault(); // lock to horizontal

  if (dx < 0 && swipeType === 'task') {
    // Left swipe — delete (tasks only)
    swipeDelta = Math.abs(dx);
    swipeIsRight = false;
    const progress = Math.min(swipeDelta / SWIPE_THRESHOLD, 1);
    const bg = swipeEl.querySelector('.swipe-delete-bg');
    if (bg) bg.style.opacity = progress;
    const cbg = swipeEl.querySelector('.swipe-complete-bg');
    if (cbg) cbg.style.opacity = 0;
    swipeEl.classList.add('swiping');
    swipeEl.classList.remove('swiping-right');
    const inner = swipeEl.querySelectorAll('.task-content,.task-actions-col');
    inner.forEach(el => el.style.transform = `translateX(${-Math.min(swipeDelta, SWIPE_THRESHOLD)}px)`);
  } else if (dx > 0) {
    // Right swipe — complete
    swipeDelta = dx;
    swipeIsRight = true;
    const progress = Math.min(swipeDelta / SWIPE_THRESHOLD, 1);
    const cbg = swipeEl.querySelector('.swipe-complete-bg');
    if (cbg) cbg.style.opacity = progress;
    const dbg = swipeEl.querySelector('.swipe-delete-bg');
    if (dbg) dbg.style.opacity = 0;
    swipeEl.classList.add('swiping-right');
    swipeEl.classList.remove('swiping');
    // Shift inner content right
    if (swipeType === 'task') {
      const inner = swipeEl.querySelectorAll('.task-content,.task-actions-col');
      inner.forEach(el => el.style.transform = `translateX(${Math.min(swipeDelta, SWIPE_THRESHOLD)}px)`);
    } else {
      const inner = swipeEl.querySelectorAll('.habit-emoji-lg,.habit-today-content,.habit-check');
      inner.forEach(el => el.style.transform = `translateX(${Math.min(swipeDelta, SWIPE_THRESHOLD)}px)`);
    }
  } else {
    swipeDelta = 0;
  }
}, {passive: false});

document.addEventListener('touchend', function(e) {
  // ── END DRAG REORDER ──
  if (tdDragId !== null) {
    document.querySelectorAll('.task-item').forEach(el => {
      el.classList.remove('touch-dragging', 'touch-drag-over');
    });
    if (tdGhost) { tdGhost.remove(); tdGhost = null; }

    if (tdDragging && tdOverId && tdOverId !== tdDragId) {
      reorder(tdDragId, tdOverId);
      render();
    }
    tdDragId = null; tdOverId = null; tdDragging = false;
    return;
  }

  // ── END SWIPE ──
  if (!swipeEl) return;
  const item  = swipeEl;
  const id    = swipeId;
  const type  = swipeType;
  const isRight = swipeIsRight;

  const innerSel = type === 'task'
    ? '.task-content,.task-actions-col'
    : '.habit-emoji-lg,.habit-today-content,.habit-check';
  const inner = item.querySelectorAll(innerSel);

  if (swipeDelta >= SWIPE_THRESHOLD) {
    if (isRight) {
      // Swipe right — complete
      inner.forEach(el => { el.style.transition = 'transform 0.2s ease'; el.style.transform = ''; });
      const cbg = item.querySelector('.swipe-complete-bg');
      if (cbg) { cbg.style.transition = 'opacity 0.2s ease'; cbg.style.opacity = '0'; }
      item.classList.remove('swiping-right');
      if (type === 'task') {
        toggleDone_t(id);
      } else {
        toggleCompletion(id, todayStr());
      }
      setTimeout(() => { inner.forEach(el => el.style.transition = ''); if (cbg) cbg.style.transition = ''; }, 200);
    } else {
      // Swipe left — delete (tasks only)
      item.style.transition = 'transform 0.2s ease, opacity 0.2s ease';
      item.style.transform  = 'translateX(-100%)';
      item.style.opacity    = '0';
      setTimeout(() => swipeDeleteTask(id), 200);
    }
  } else {
    // Snap back
    inner.forEach(el => { el.style.transition = 'transform 0.2s ease'; el.style.transform = ''; });
    const bg = item.querySelector('.swipe-delete-bg');
    if (bg) bg.style.opacity = '';
    const cbg = item.querySelector('.swipe-complete-bg');
    if (cbg) cbg.style.opacity = '';
    item.classList.remove('swiping', 'swiping-right');
    setTimeout(() => { inner.forEach(el => el.style.transition = ''); }, 200);
  }
  swipeEl = null; swipeId = null; swipeDelta = 0; swipeDir = null; swipeType = null; swipeIsRight = false;
});

let swipeStartX = 0, swipeStartY = 0, swipeEl = null, swipeId = null, swipeDelta = 0;
let swipeDir = null, swipeType = null, swipeIsRight = false;
const SWIPE_THRESHOLD = 120;


let undoStack = null, undoTimer = null;
function swipeDeleteTask(id) {
  const t = tasks.find(t=>t.id===id);
  if (!t) return;
  undoStack = {...t, _idx: tasks.indexOf(t)};
  tasks = tasks.filter(t=>t.id!==id);
  render();
  showUndoToast(`"${t.text.length>40?t.text.slice(0,40)+'…':t.text}" deleted`, id);
}
function showUndoToast(msg, pendingDeleteId) {
  clearTimeout(undoTimer);
  const toast = document.getElementById('undoToast');
  document.getElementById('undoMsg').textContent = msg;
  toast.classList.add('show');
  // Progress bar
  const bar = document.getElementById('toastProgress');
  bar.style.transition = 'none';
  bar.style.width = '100%';
  requestAnimationFrame(()=>{
    requestAnimationFrame(()=>{
      bar.style.transition = 'width 5s linear';
      bar.style.width = '0%';
    });
  });
  undoTimer = setTimeout(()=>{
    toast.classList.remove('show');
    if (undoStack !== null) {
      // Undo window expired — commit the delete to Supabase
      deleteTask(pendingDeleteId);
      undoStack = null;
    }
  }, 5000);
}
function undoDelete() {
  if (!undoStack) return;
  clearTimeout(undoTimer);
  const t = undoStack;
  undoStack = null; // Nullify before saveTask so the timeout guard won't fire deleteTask
  tasks.splice(Math.min(t._idx, tasks.length), 0, t);
  document.getElementById('undoToast').classList.remove('show');
  render(); saveTask(t);
}

/* ═══════════════════════════════════════════════
   BACKUP & RESTORE
═══════════════════════════════════════════════ */
/* ═══════════════════════════════════════════════
   LEGAL MODAL
═══════════════════════════════════════════════ */
const LEGAL_EFFECTIVE = 'March 6, 2026';
const LEGAL_COMPANY   = 'GSD Technologies LLC';
const LEGAL_EMAIL     = 'legal@gsdtasks.com';

const LEGAL_TERMS = `
<h2>1. Agreement to Terms</h2>
<p>By accessing or using GSD Task Manager ("the Service") operated by <strong>${LEGAL_COMPANY}</strong> ("we," "us," or "our"), you agree to be bound by these Terms and Conditions. If you do not agree to these Terms, please do not use the Service.</p>
<p>These Terms were last updated on <strong>${LEGAL_EFFECTIVE}</strong>. We may update these Terms from time to time and will notify you of material changes through the Service or by email.</p>

<h2>2. Description of Service</h2>
<p>GSD Task Manager is a productivity application that allows you to create, organize, and manage tasks and to-do lists. The Service is currently provided free of charge. We reserve the right to introduce paid features in the future, and will provide advance notice before doing so.</p>

<h2>3. Your Account</h2>
<p>To use the Service, you must create an account using a valid email address or supported third-party login (such as Google). You are responsible for:</p>
<ul>
  <li>Keeping your account credentials secure and confidential</li>
  <li>All activity that occurs under your account</li>
  <li>Notifying us immediately of any unauthorized access</li>
</ul>
<p>You must be at least 13 years of age to use the Service. By using the Service, you represent that you meet this age requirement.</p>

<h2>4. Acceptable Use</h2>
<p>You agree not to use the Service to:</p>
<ul>
  <li>Violate any applicable laws or regulations</li>
  <li>Store or transmit content that is unlawful, harmful, or infringes on any third-party rights</li>
  <li>Attempt to gain unauthorized access to any part of the Service or its infrastructure</li>
  <li>Interfere with or disrupt the integrity or performance of the Service</li>
  <li>Use automated means to access the Service without our express written permission</li>
</ul>

<h2>5. Your Data</h2>
<p>You retain ownership of all tasks, notes, and content you create in the Service ("User Content"). By using the Service, you grant us a limited, non-exclusive, royalty-free license to store and process your User Content solely as necessary to provide the Service to you.</p>
<p>We do not sell, rent, or share your User Content with third parties for advertising or marketing purposes. See our Privacy Policy for full details on how we handle your data.</p>

<h2>6. Data Storage &amp; Security</h2>
<p>In the current version of the Service, task data and local backups are stored in your browser's local storage on your device. This data is not transmitted to our servers unless you are signed in with a synced account. You are responsible for maintaining backups of your own data. We are not liable for data loss resulting from browser data clearing, device changes, or local storage limitations.</p>

<h2>7. Intellectual Property</h2>
<p>The Service, including its design, code, logo, and branding, is owned by <strong>${LEGAL_COMPANY}</strong> and protected by applicable intellectual property laws. You may not copy, modify, distribute, or create derivative works from any part of the Service without our prior written consent.</p>

<h2>8. Disclaimer of Warranties</h2>
<p>The Service is provided on an "as is" and "as available" basis without warranties of any kind, either express or implied, including but not limited to warranties of merchantability, fitness for a particular purpose, or non-infringement. We do not warrant that the Service will be uninterrupted, error-free, or completely secure.</p>

<h2>9. Limitation of Liability</h2>
<p>To the fullest extent permitted by applicable law, <strong>${LEGAL_COMPANY}</strong> shall not be liable for any indirect, incidental, special, consequential, or punitive damages, including loss of data, profits, or business opportunities, arising out of or related to your use of the Service, even if we have been advised of the possibility of such damages.</p>
<p>Our total liability to you for any claims arising under these Terms shall not exceed the greater of $100 USD or the amount you paid us in the twelve months preceding the claim.</p>

<h2>10. Termination</h2>
<p>You may stop using the Service at any time. You may delete your account and all associated data through the account settings. We reserve the right to suspend or terminate access to the Service for any user who violates these Terms, with or without notice.</p>

<h2>11. Governing Law</h2>
<p>These Terms are governed by and construed in accordance with the laws of the United States, without regard to its conflict of law provisions. Any disputes arising under these Terms shall be resolved in the courts of competent jurisdiction in the United States.</p>

<h2>12. Contact</h2>
<p>If you have any questions about these Terms, please contact us at <strong>${LEGAL_EMAIL}</strong>.</p>
`;

const LEGAL_PRIVACY = `
<h2>1. Overview</h2>
<p>This Privacy Policy explains how <strong>${LEGAL_COMPANY}</strong> ("we," "us," or "our") collects, uses, and protects information when you use GSD Task Manager ("the Service"). We are committed to protecting your privacy and handling your data transparently.</p>
<p>This policy was last updated on <strong>${LEGAL_EFFECTIVE}</strong>.</p>

<h2>2. Information We Collect</h2>
<p><strong>Account information:</strong> When you create an account, we collect your email address and, if you sign in with Google, your name and profile photo as provided by Google.</p>
<p><strong>Task data:</strong> The tasks, notes, tags, and other content you create within the Service.</p>
<p><strong>Usage data:</strong> Basic analytics such as feature usage frequency, session duration, and error logs. This data is aggregated and does not identify you personally.</p>
<p><strong>Device &amp; browser data:</strong> Browser type, operating system, and IP address, used solely for security and service improvement purposes.</p>

<h2>3. How We Use Your Information</h2>
<ul>
  <li>To provide, operate, and improve the Service</li>
  <li>To authenticate your identity and maintain your account</li>
  <li>To send important service notices (e.g., security updates, policy changes)</li>
  <li>To diagnose technical problems and prevent abuse</li>
  <li>To comply with legal obligations</li>
</ul>
<p>We do not use your task content for advertising, machine learning training, or any purpose beyond providing the Service to you.</p>

<h2>4. Local Data &amp; Browser Storage</h2>
<p>GSD Task Manager stores your task data securely in your account on our servers, synced in real time across all your signed-in devices. You can download manual backups at any time from the Backup &amp; Restore menu. We strongly recommend keeping regular backups as an extra safety net.</p>

<h2>5. Data Sharing</h2>
<p>We do not sell, rent, or trade your personal information. We may share data only in the following limited circumstances:</p>
<ul>
  <li><strong>Service providers:</strong> Trusted third-party vendors who assist us in operating the Service (e.g., hosting, authentication), bound by confidentiality agreements</li>
  <li><strong>Legal requirements:</strong> When required by law, court order, or to protect the rights and safety of our users or the public</li>
  <li><strong>Business transfers:</strong> In the event of a merger, acquisition, or sale of assets, your data may be transferred as part of that transaction, with advance notice provided to you</li>
</ul>

<h2>6. Data Retention</h2>
<p>We retain your account data for as long as your account is active. If you delete your account, we will delete your personal data within 30 days, except where we are required to retain it for legal or compliance purposes. Local backups stored in your browser are managed entirely by you and are not subject to our retention controls.</p>

<h2>7. Security</h2>
<p>We implement industry-standard security measures to protect your data, including encrypted data transmission (TLS) and secure authentication. However, no method of transmission over the internet or electronic storage is 100% secure. We cannot guarantee absolute security and encourage you to use a strong, unique password.</p>

<h2>8. Your Rights</h2>
<p>Depending on your location, you may have the following rights regarding your personal data:</p>
<ul>
  <li><strong>Access:</strong> Request a copy of the personal data we hold about you</li>
  <li><strong>Correction:</strong> Request that we correct inaccurate data</li>
  <li><strong>Deletion:</strong> Request deletion of your account and associated data via account settings or by contacting us</li>
  <li><strong>Portability:</strong> Export your task data at any time using the built-in export feature</li>
  <li><strong>Objection:</strong> Object to certain uses of your data</li>
</ul>
<p>To exercise any of these rights, contact us at <strong>${LEGAL_EMAIL}</strong>.</p>

<h2>9. Children's Privacy</h2>
<p>The Service is not directed to children under the age of 13. We do not knowingly collect personal information from children under 13. If we become aware that we have inadvertently collected such information, we will take steps to delete it promptly.</p>

<h2>10. Changes to This Policy</h2>
<p>We may update this Privacy Policy from time to time. We will notify you of significant changes by posting a notice in the Service or by email. Your continued use of the Service after such changes constitutes your acceptance of the updated policy.</p>

<h2>11. Contact</h2>
<p>If you have any questions, concerns, or requests regarding this Privacy Policy, please contact us at <strong>${LEGAL_EMAIL}</strong>.</p>
`;

function openLegalModal(tab = 'terms') {
  document.getElementById('legalModal').classList.add('open');
  switchLegalTab(tab);
}

function closeLegalModal() {
  document.getElementById('legalModal').classList.remove('open');
}

function switchLegalTab(tab) {
  const isTerms = tab === 'terms';
  document.getElementById('legalTabTerms').classList.toggle('active', isTerms);
  document.getElementById('legalTabPrivacy').classList.toggle('active', !isTerms);
  document.getElementById('legalModalTitle').textContent = isTerms ? 'Terms & Conditions' : 'Privacy Policy';
  document.getElementById('legalBody').innerHTML = isTerms ? LEGAL_TERMS : LEGAL_PRIVACY;
  document.getElementById('legalBody').scrollTop = 0;
}

async function openBackupModal() {
  document.getElementById('restoreFileName').textContent = 'No file selected';
  document.getElementById('restoreFile').value = '';
  document.getElementById('backupModal').classList.add('open');
  await renderBackupDates();
}
function closeBackupModal() {
  document.getElementById('backupModal').classList.remove('open');
}
document.getElementById('backupModal').addEventListener('click', function(e) {
  if (e.target === this) closeBackupModal();
});
function exportJSON() {
  if (!tasks.length && !habitsArr.length && !notesArr.length) { alert('No data to export.'); return; }
  const data = {
    version: 4,
    exported: new Date().toISOString(),
    tasks: tasks,
    habits: habitsArr,
    habitCompletions: habitCompletions,
    notes: notesArr,
    notebooks: notebooksArr
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `gsd-backup-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
function restoreJSON(input) {
  const file = input.files[0]; if (!file) return;
  document.getElementById('restoreFileName').textContent = file.name;
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const data = JSON.parse(e.target.result);
      const restoredTasks = data.tasks || (Array.isArray(data) ? data : null);
      const restoredHabits = data.habits || [];
      const restoredCompletions = data.habitCompletions || [];
      const restoredNotes = data.notes || [];
      const restoredNotebooks = data.notebooks || [];
      if (!restoredTasks && !restoredHabits.length && !restoredNotes.length) throw new Error('Invalid format');
      const parts = [];
      if (restoredTasks && restoredTasks.length) parts.push(`${restoredTasks.length} tasks`);
      if (restoredHabits.length) parts.push(`${restoredHabits.length} habits`);
      if (restoredNotes.length) parts.push(`${restoredNotes.length} notes`);
      if (restoredNotebooks.length) parts.push(`${restoredNotebooks.length} notebooks`);
      showConfirm({
        icon: '⚠️',
        title: 'Replace all data?',
        desc: `This will load ${parts.join(' + ')} from "${file.name}" and replace your current data.`,
        confirmLabel: 'Restore',
        confirmClass: 'primary',
        onConfirm: () => {
          if (restoredTasks) { tasks = restoredTasks; save(); render(); }
          if (restoredHabits.length) { habitsArr = restoredHabits; habitCompletions = restoredCompletions; renderHabits(); saveAllHabitsToDB(); }
          if (restoredNotes.length) { notesArr = restoredNotes; renderNotes(); notesArr.forEach(n => saveNoteToDB(n)); }
          if (restoredNotebooks.length) { notebooksArr = restoredNotebooks; renderNotes(); restoredNotebooks.forEach(nb => saveNotebookToDB(nb)); }
          closeBackupModal();
          showUndoToast(`Restored ${parts.join(' + ')} from backup`);
        }
      });
    } catch(err) {
      alert('Could not read backup file. Make sure it\'s a valid GSD JSON export.');
    }
  };
  reader.readAsText(file);
}

/* ═══════════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════════ */
/* ═══════════════════════════════════════════════
   AUTO-BACKUP (Supabase, 30-day rolling)
   table: backups(user_id, date TEXT, snapshot JSONB)
═══════════════════════════════════════════════ */
const BACKUP_DAYS = 30;

async function autoBackup() {
  if (!currentUser || (!tasks.length && !habitsArr.length)) return;
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // Only write once per day — check if today's backup already exists
  const { data: existing } = await db.from('backups')
    .select('backup_date')
    .eq('user_id', currentUser.id)
    .eq('backup_date', today)
    .maybeSingle();
  if (existing) return;

  // Write today's snapshot — pass object directly, Supabase handles JSONB serialization
  await db.from('backups').upsert({
    user_id:     currentUser.id,
    backup_date: today,
    snapshot:    { tasks: tasks, habits: habitsArr, habitCompletions: habitCompletions, notes: notesArr, notebooks: notebooksArr, savedAt: new Date().toISOString() },
    task_count:  tasks.length,
  }, { onConflict: 'user_id,backup_date' });

  // Prune entries older than 30 days
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - BACKUP_DAYS);
  await db.from('backups')
    .delete()
    .eq('user_id', currentUser.id)
    .lt('backup_date', cutoff.toISOString().slice(0, 10));
}

async function getBackupDates() {
  if (!currentUser) return [];
  const { data } = await db.from('backups')
    .select('backup_date, task_count, snapshot')
    .eq('user_id', currentUser.id)
    .order('backup_date', { ascending: false });
  return (data || []).map(r => {
    const snap = typeof r.snapshot === 'string' ? JSON.parse(r.snapshot) : (r.snapshot || {});
    return { backup_date: r.backup_date, task_count: r.task_count, habit_count: snap.habits?.length || 0 };
  });
}

async function restoreFromDate(date) {
  if (!currentUser) return;
  const { data, error } = await db.from('backups')
    .select('snapshot')
    .eq('user_id', currentUser.id)
    .eq('backup_date', date)
    .maybeSingle();
  if (error || !data?.snapshot) { alert('Backup not found for ' + date); return; }
  const snap = typeof data.snapshot === 'string' ? JSON.parse(data.snapshot) : data.snapshot;
  if (!snap.tasks && !snap.habits && !snap.notes) { alert('Backup not found for ' + date); return; }
  const parts = [];
  if (snap.tasks?.length) parts.push(`${snap.tasks.length} tasks`);
  if (snap.habits?.length) parts.push(`${snap.habits.length} habits`);
  if (snap.notes?.length) parts.push(`${snap.notes.length} notes`);
  showConfirm({
    icon: '⏪',
    title: `Restore backup from ${date}?`,
    desc: `This will load ${parts.join(' + ')} from ${date} and replace your current data.`,
    confirmLabel: 'Restore',
    confirmClass: 'primary',
    onConfirm: async () => {
      if (snap.tasks) { tasks = snap.tasks; await save(); render(); }
      if (snap.habits) { habitsArr = snap.habits; habitCompletions = snap.habitCompletions || []; renderHabits(); saveAllHabitsToDB(); }
      if (snap.notes) { notesArr = snap.notes; renderNotes(); snap.notes.forEach(n => saveNoteToDB(n)); }
      if (snap.notebooks) { notebooksArr = snap.notebooks; renderNotes(); snap.notebooks.forEach(nb => saveNotebookToDB(nb)); }
      closeBackupModal();
      showUndoToast(`Restored ${parts.join(' + ')} from ${date}`);
    }
  });
}

async function renderBackupDates() {
  const el = document.getElementById('backupDateList');
  if (!el) return;
  el.innerHTML = '<div style="font-size:12px;color:var(--ink-3);padding:6px 0;">Loading…</div>';
  const dates = await getBackupDates();
  if (!dates.length) {
    el.innerHTML = '<div style="font-size:12px;color:var(--ink-3);padding:6px 0;">No auto-backups yet — one will be created on your next session.</div>';
    return;
  }
  const todayStr = new Date().toISOString().slice(0, 10);
  el.innerHTML = dates.map(({ backup_date: d, task_count: tCount, habit_count: hCount }) => {
    const label = d === todayStr ? `${d} <span style="color:var(--guava-800);font-size:10px;">today</span>` : d;
    const parts = [];
    if (tCount) parts.push(`${tCount} tasks`);
    if (hCount) parts.push(`${hCount} habits`);
    const summary = parts.length ? parts.join(', ') : 'no data';
    return `<div style="display:flex;align-items:center;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--edge);">
      <span style="font-size:12px;">${label} <span style="color:var(--ink-3);font-size:11px;">(${summary})</span></span>
      <button class="btn-sm" onclick="restoreFromDate('${d}')" style="font-size:11px;padding:3px 9px;">Restore</button>
    </div>`;
  }).join('');
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}




/* ═══════════════════════════════════════════════
   CUSTOM CONFIRM DIALOG
═══════════════════════════════════════════════ */
let _confirmResolve = null;

function showConfirm({ icon='🗑️', title='Are you sure?', desc='', confirmLabel='Confirm', confirmClass='danger', onConfirm }) {
  document.getElementById('confirmIcon').textContent = icon;
  document.getElementById('confirmTitle').textContent = title;
  document.getElementById('confirmDesc').textContent = desc;
  const btn = document.getElementById('confirmOkBtn');
  btn.textContent = confirmLabel;
  btn.className = `confirm-btn-confirm ${confirmClass}`;
  document.getElementById('confirmDialog').classList.add('open');
  _confirmResolve = onConfirm;
}

function resolveConfirm(confirmed) {
  document.getElementById('confirmDialog').classList.remove('open');
  if (confirmed && typeof _confirmResolve === 'function') _confirmResolve();
  _confirmResolve = null;
}

// Close on backdrop click
document.getElementById('confirmDialog').addEventListener('click', function(e) {
  if (e.target === this) resolveConfirm(false);
});

/* ═══════════════════════════════════════════════
   KEYBOARD SHORTCUTS
   N        → New task (open create panel)
   /        → Focus search
   Escape   → Close any open panel/modal
   E        → Edit focused/last task (if none open)
═══════════════════════════════════════════════ */
let kbdHintTimer = null;

function showKbdHint(html) {
  const el = document.getElementById('kbdHint');
  el.innerHTML = html;
  el.classList.add('show');
  clearTimeout(kbdHintTimer);
  kbdHintTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

document.addEventListener('keydown', function(e) {
  // Don't fire shortcuts when typing in an input/textarea
  const tag = document.activeElement.tagName.toLowerCase();
  const isTyping = tag === 'input' || tag === 'textarea' || document.activeElement.isContentEditable;

  // Escape — close anything open
  if (e.key === 'Escape') {
    if (document.getElementById('confirmDialog').classList.contains('open')) {
      resolveConfirm(false); return;
    }
    if (document.getElementById('editModal').classList.contains('open')) {
      closeModal(); return;
    }
    if (document.getElementById('deleteAccountModal').classList.contains('open')) {
      closeDeleteAccountModal(); return;
    }
    if (document.getElementById('createPanel').classList.contains('open')) {
      closeCreatePanel(); return;
    }
    if (document.getElementById('userDropdown').classList.contains('open')) {
      toggleUserDropdown(false); return;
    }
    if (searchQuery) {
      clearSearch(); return;
    }
    return;
  }

  if (isTyping) return;

  // N → new task/habit (lowercase only — Shift+N is reserved for switching to Notes tab)
  if (e.key === 'n') {
    e.preventDefault();
    openCreatePanel();
    showKbdHint(activeTool === 'habits' ? '<kbd>N</kbd> New habit' : '<kbd>N</kbd> New task');
    return;
  }

  // / → focus floating search (tasks & notes)
  if (e.key === '/' && (activeTool === 'tasks' || activeTool === 'notes')) {
    e.preventDefault();
    expandFloatingSearch();
    showKbdHint('<kbd>/</kbd> Search');
    return;
  }

  // ? → show shortcut cheatsheet
  if (e.key === '?') {
    showKbdHint('<kbd>N</kbd> New &nbsp; <kbd>/</kbd> Search &nbsp; <kbd>Esc</kbd> Close');
    return;
  }
});

// Start by restoring session (or showing login screen)
restoreSession();

/* ── FAQ MODAL ── */
function openFaqModal() { document.getElementById('faqModal').classList.add('open'); }
function closeFaqModal() { document.getElementById('faqModal').classList.remove('open'); }
function toggleFaq(btn) {
  const item = btn.closest('.faq-item');
  const isOpen = item.classList.contains('open');
  document.querySelectorAll('.faq-item.open').forEach(i => i.classList.remove('open'));
  if (!isOpen) item.classList.add('open');
}

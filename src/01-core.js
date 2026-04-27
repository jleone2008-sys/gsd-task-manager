/* Track mousedown target so modals can ignore clicks that started inside
   (e.g. dragging text selection from a textarea out onto the backdrop). */
let _gsdLastMouseDownTarget = null;
document.addEventListener('mousedown', e => { _gsdLastMouseDownTarget = e.target; }, true);
function isCleanBackdropClick(e, backdropEl) {
  return e.target === backdropEl && _gsdLastMouseDownTarget === backdropEl;
}

const KEY = 'gsd_v3';
let tasks = [], filter = 'all', filterStarred = false, newTags = new Set(), editId = null, showDone = false, sortBy = 'default';
let taskStatsView = 'daily';
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
// Auth defaults are already on by default in supabase-js v2, but pinning
// them explicitly makes our intent obvious and survives any future
// upstream default changes. Storage is forced to localStorage so a
// session in one tab is recoverable from another.
const db = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,
    storage: typeof window !== 'undefined' ? window.localStorage : undefined,
  },
});

// Temporary diagnostic for the sporadic forced-sign-in bug. Logs every
// auth state transition with a timestamp so we can correlate it with
// what the user was doing right before. Remove once the cause is found.
try {
  db.auth.onAuthStateChange((event, session) => {
    const expISO = session?.expires_at ? new Date(session.expires_at * 1000).toISOString() : null;
    console.info('[auth]', new Date().toISOString(), event, { expires_at: expISO, hasSession: !!session });
  });
} catch (_) {}
let currentUser = null;
let authMode = 'signin';


function toggleAuthMode() {
  authMode = authMode === 'signin' ? 'signup' : 'signin';
  document.getElementById('authSubmitBtn').textContent =
    authMode === 'signin' ? 'Sign In' : 'Create Account';
  document.getElementById('authToggle').innerHTML = authMode === 'signin'
    ? 'No account? <a id="authToggleLink">Sign up free</a>'
    : 'Already have an account? <a id="authToggleLink">Sign in</a>';
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
  // Apply URL-driven routing now that the app shell is visible.
  if (typeof routerInitFromUrl === 'function') routerInitFromUrl();
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
  if (!_navFromPop) {
    const route = { tool };
    if (tool === 'habits' && typeof activeHabitView === 'string' && activeHabitView !== 'today') route.view = activeHabitView;
    if (typeof routerSyncUrl === 'function') routerSyncUrl(route);
    else history.pushState({tool, note: null, drill: false}, '');
  }
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
  // Wordmark logo click → home (Tasks) without a full reload
  const logo = e.target.closest('#headerLogo');
  if (logo) {
    e.preventDefault();
    if (typeof switchTool === 'function') switchTool('tasks');
  }
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
// Handle browser back/forward (swipe gestures on mobile). Re-parse the URL so
// path-based state (tool + habit view + task filter) is restored on every nav.
window.addEventListener('popstate', e => {
  _navFromPop = true;
  // Close any open overlay first
  const drillOverlay = document.getElementById('habitDrillOverlay');
  if (drillOverlay && drillOverlay.classList.contains('open')) { closeDrillIn(); _navFromPop = false; return; }
  // Close open note on mobile
  if (activeNoteId && activeTool === 'notes') { deselectNote(); _navFromPop = false; return; }
  try {
    if (typeof routerApplyRoute === 'function' && typeof parseAppRoute === 'function') {
      const r = parseAppRoute();
      if (r) routerApplyRoute(r);
    } else {
      const state = e.state || { tool: 'tasks' };
      if (state.tool && state.tool !== activeTool) switchTool(state.tool);
    }
  } finally { _navFromPop = false; }
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
  if (typeof routerSyncUrl === 'function') routerSyncUrl({ tool: 'habits', view: activeHabitView });
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
  if (isCleanBackdropClick(e, this)) closeDeleteAccountModal();
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

/* ── AUTH SCREEN HANDLERS ── */
document.getElementById('btnGoogleSignIn').addEventListener('click', signInWithGoogle);
document.getElementById('authSubmitBtn').addEventListener('click', handleEmailAuth);
// Delegated because toggleAuthMode replaces #authToggle innerHTML, losing the id binding
document.getElementById('authToggle').addEventListener('click', e => {
  if (e.target.closest('#authToggleLink')) toggleAuthMode();
});
['authEmail', 'authPassword'].forEach(id => {
  document.getElementById(id).addEventListener('keydown', e => {
    if (e.key === 'Enter') handleEmailAuth();
  });
});
document.getElementById('authLegalTermsBtn').addEventListener('click', e => {
  e.stopPropagation();
  openLegalModal('terms');
});
document.getElementById('authLegalPrivacyBtn').addEventListener('click', e => {
  e.stopPropagation();
  openLegalModal('privacy');
});

/* ── USER MENU / SIDEBAR FOOTER ── */
document.getElementById('sidebarFooter').addEventListener('click', () => toggleUserDropdown());
document.getElementById('userAvatar').addEventListener('click', () => toggleUserDropdown());
document.getElementById('userDropdown').addEventListener('click', e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  switch (action) {
    case 'backup':          openBackupModal(); break;
    case 'legal-terms':     openLegalModal('terms'); break;
    case 'legal-privacy':   openLegalModal('privacy'); break;
    case 'faq':             openFaqModal(); break;
    case 'delete-account':  openDeleteAccountModal(); break;
    case 'signout':         signOut(); return;
    default: return;
  }
  toggleUserDropdown(false);
});

/* ── DELETE ACCOUNT MODAL HANDLERS ── */
document.getElementById('deleteAccountModalClose').addEventListener('click', closeDeleteAccountModal);
document.getElementById('deleteAccountCancelBtn').addEventListener('click', closeDeleteAccountModal);
document.getElementById('deleteConfirmBtn').addEventListener('click', confirmDeleteAccount);
document.getElementById('deleteConfirmInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') confirmDeleteAccount();
});


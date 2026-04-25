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
    subtasks.splice(idx, 1);
    rebuildSubtasksIndex();
    render();
    return;
  }
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
      commitNewSubtask(taskClientId, tmpId, value);
      startNewSubtask(taskClientId);
    } else {
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

// Set this after creating the beta Google Cloud project
const BETA_GOOGLE_CLIENT_ID = '508677465416-ptiaqbjlqq8cmf8f1gertead6493u7ei.apps.googleusercontent.com';

function showAuthError(msg) {
  const el = document.getElementById('authError');
  el.textContent = msg; el.classList.add('show');
}
function clearAuthError() {
  document.getElementById('authError').classList.remove('show');
}

function onChannelStatus(status, err) {
  if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
    console.warn('realtime channel', status, err || '');
  }
}

/* ── BETA: Custom OAuth flow via Netlify function proxy ── */
function signInWithGoogle() {
  const state = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));
  sessionStorage.setItem('beta_oauth_state', state);

  const params = new URLSearchParams({
    client_id:     BETA_GOOGLE_CLIENT_ID,
    redirect_uri:  window.location.origin + '/.netlify/functions/beta-auth',
    response_type: 'code',
    scope: [
      'openid', 'email', 'profile',
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/calendar.events.owned',
      'https://www.googleapis.com/auth/calendar.events.owned.readonly',
      'https://www.googleapis.com/auth/photoslibrary',
      'https://www.googleapis.com/auth/tasks',
      'https://www.googleapis.com/auth/drive',
    ].join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
  });

  window.location.href = 'https://accounts.google.com/o/oauth2/v2/auth?' + params;
}

/* ── BETA: Handle redirect back from Netlify function ── */
async function handleBetaOAuthCallback() {
  if (!location.hash.includes('id_token=')) return false;

  const params = new URLSearchParams(location.hash.slice(1));
  const idToken     = params.get('id_token');
  const accessToken = params.get('access_token');
  const state       = params.get('state');
  const error       = params.get('error');

  // Clear hash from URL immediately
  history.replaceState(null, '', location.pathname);

  if (error) {
    showAuthError('Google sign-in failed: ' + error);
    document.getElementById('authScreen').classList.remove('hidden');
    return true;
  }

  // CSRF check
  const expectedState = sessionStorage.getItem('beta_oauth_state');
  sessionStorage.removeItem('beta_oauth_state');
  if (!state || state !== expectedState) {
    showAuthError('Sign-in failed: invalid state. Please try again.');
    document.getElementById('authScreen').classList.remove('hidden');
    return true;
  }

  const grantedScopes = (params.get('granted_scope') || '').split(' ');
  const REQUIRED_SCOPES = [
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/calendar.events.owned',
    'https://www.googleapis.com/auth/calendar.events.owned.readonly',
    'https://www.googleapis.com/auth/photoslibrary',
    'https://www.googleapis.com/auth/tasks',
    'https://www.googleapis.com/auth/drive',
  ];
  const missing = REQUIRED_SCOPES.filter(s => !grantedScopes.includes(s));
  if (missing.length) {
    showAuthError('Beta features require permissions to work. Please try again.');
    document.getElementById('authScreen').classList.remove('hidden');
    return true;
  }

  const { error: authError } = await db.auth.signInWithIdToken({
    provider: 'google',
    token: idToken,
    access_token: accessToken,
  });

  if (authError) {
    showAuthError('Sign-in failed: ' + authError.message);
    document.getElementById('authScreen').classList.remove('hidden');
  }

  return true;
}

/* ── BETA: Show not-invited screen ── */
function showBetaNotInvitedScreen() {
  const authCard = document.querySelector('.auth-card');
  if (authCard) {
    authCard.innerHTML = `
      <div style="text-align:center;padding:2.5rem 1.5rem;">
        <div style="font-size:2.5rem;margin-bottom:1rem;">🔒</div>
        <div style="font-size:1.25rem;font-weight:700;margin-bottom:0.5rem;">Beta Access Required</div>
        <p style="color:#888;margin-bottom:1.5rem;font-size:0.9rem;line-height:1.5;">
          Your account hasn't been invited to the GSD beta yet.
        </p>
        <a href="https://gsdtasks.com/app" style="display:inline-block;color:#1e3a5f;font-weight:600;font-size:0.9rem;text-decoration:none;border:1px solid #1e3a5f;padding:0.5rem 1.25rem;border-radius:8px;">
          ← Back to GSD Tasks
        </a>
      </div>
    `;
  }
  document.getElementById('authScreen').classList.remove('hidden');
}

/* ── BETA: Check whitelist before loading user data ── */
async function signInUser(user) {
  const { data } = await db.from('beta_users')
    .select('email')
    .eq('email', user.email)
    .maybeSingle();

  if (!data) {
    showBetaNotInvitedScreen();
    db.auth.signOut();
    return;
  }

  try { db.removeAllChannels(); } catch (_) {}
  currentUser = user;
  document.getElementById('authScreen').classList.add('hidden');
  setUserUI(user);
  load();
  loadHabits();
  loadNotes();
  loadSubtasks();
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
  document.getElementById('authEmail').value = '';
  document.getElementById('authPassword').value = '';
  clearAuthError();
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
let _navFromPop = false;
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
  document.querySelectorAll('[data-tool-view]').forEach(el => {
    el.style.display = el.dataset.toolView === tool ? '' : 'none';
  });
  document.querySelectorAll('.mobile-nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tool === tool);
  });
  document.querySelectorAll('.sidebar-btn[data-tool]').forEach(btn => {
    btn.classList.toggle('is-active', btn.dataset.tool === tool);
  });
  const titles = { tasks: 'Tasks', habits: 'Habits', notes: 'Notes', scratch: 'Scratch' };
  const pt = document.getElementById('pageTitle');
  if (pt) pt.textContent = titles[tool] || '';
  updateFloatingSearch();
  if (tool !== 'scratch') document.getElementById('fabBtn')?.classList.remove('hidden');
  if (tool === 'habits') { renderHabits(); }
  else if (tool === 'tasks') { render(); }
  else if (tool === 'notes') { renderNotes(); }
  else if (tool === 'scratch') { renderScratch(); }
}
document.addEventListener('click', e => {
  const tab = e.target.closest('.mobile-nav-btn, .sidebar-btn');
  if (tab && tab.dataset.tool) switchTool(tab.dataset.tool);
});
document.addEventListener('keydown', e => {
  if (!e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
  const tag = document.activeElement?.tagName;
  const editable = document.activeElement?.isContentEditable;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || editable) return;
  const map = { T: 'tasks', H: 'habits', N: 'notes', S: 'scratch' };
  const tool = map[e.key.toUpperCase()];
  if (tool) { e.preventDefault(); switchTool(tool); }
});
window.addEventListener('popstate', e => {
  _navFromPop = true;
  const drillOverlay = document.getElementById('habitDrillOverlay');
  if (drillOverlay && drillOverlay.classList.contains('open')) { closeDrillIn(); _navFromPop = false; return; }
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

  /* ── BETA: Inject badge into header logo ── */
  const logoMain = document.querySelector('.logo-main');
  if (logoMain) {
    const badge = document.createElement('span');
    badge.textContent = 'BETA';
    badge.style.cssText = 'display:inline-block;background:#f59e0b;color:#000;font-size:9px;font-weight:700;padding:2px 5px;border-radius:3px;margin-left:5px;letter-spacing:0.5px;vertical-align:middle;line-height:1;';
    logoMain.after(badge);
  }
});
async function confirmDeleteAccount() {
  if (document.getElementById('deleteConfirmInput').value !== 'DELETE') return;
  if (currentUser) {
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
  // Auth state listener must be set up before the callback handler fires signInWithIdToken
  db.auth.onAuthStateChange((_event, session) => {
    if (session?.user && !currentUser) {
      signInUser(session.user);
    }
  });

  // Handle redirect back from Netlify OAuth proxy
  if (await handleBetaOAuthCallback()) return;

  const { data: { session } } = await db.auth.getSession();
  if (session?.user) {
    signInUser(session.user);
  } else {
    document.getElementById('authScreen').classList.remove('hidden');
  }
}

/* ── AUTH SCREEN HANDLERS ── */
document.getElementById('btnGoogleSignIn').addEventListener('click', signInWithGoogle);
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

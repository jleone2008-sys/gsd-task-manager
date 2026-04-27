
/* ══════ NOTES DATA LAYER ══════ */
let notesArr = [], notebooksArr = [];
const noteRowIdMap = new Map();
const notebookRowIdMap = new Map();
let activeNoteId = null;
let noteSearchQuery = '';
let noteSortOrder = 'updated'; // 'updated' | 'created' | 'alpha'
let _noteSaveTimer = null;
// Active Quill instance for the notes editor. Recreated on every
// renderNoteEditor() call (which rebuilds the DOM via innerHTML).
let _noteQuill = null;

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
    // If user is actively editing, only update sidebar/list, not the editor.
    // Quill renders the editable area as .ql-editor inside #noteEditor.
    const editor = document.querySelector('#noteEditor .ql-editor');
    const titleInput = document.getElementById('noteTitleInput');
    const isEditing = editor && document.activeElement === editor
                   || titleInput && document.activeElement === titleInput;
    if (isEditing) {
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
          if (activeTool === 'scratch' && typeof _scratchQuill !== 'undefined' && _scratchQuill) {
            // Only patch DOM if user isn't actively typing in the Quill editor
            const editor = _scratchQuill.root;
            if (editor && document.activeElement !== editor) {
              const migrated = (typeof migrateLegacyChecklistHTML === 'function')
                ? migrateLegacyChecklistHTML(scratchNote.content || '')
                : (scratchNote.content || '');
              _scratchQuill.clipboard.dangerouslyPasteHTML(migrated, 'silent');
            }
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
    <div class="ns-item${notesSidebarView==='all'?' active':''}" data-notes-action="view" data-view="all">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
      <span>All Notes</span><span class="cnt">${allCount}</span>
    </div>
    <div class="ns-item${notesSidebarView==='starred'?' active':''}" data-notes-action="view" data-view="starred">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 17v5M9 10.76V6a2 2 0 1 1 4 0v4.76l3 1.54V15H6v-2.7l3-1.54z"/></svg>
      <span>Pinned</span><span class="cnt">${starCount}</span>
    </div>
    <div class="ns-item${notesSidebarView==='trash'?' active':''}" data-notes-action="view" data-view="trash">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      <span>Trash</span><span class="cnt">${trashCount}</span>
    </div>
  </div>
  <div class="ns-divider"></div>
  <div class="ns-section">
    <div class="ns-label">Notebooks<button data-notes-action="create-notebook"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button></div>`;
  notebooksArr.sort((a, b) => (a.order || 0) - (b.order || 0)).forEach(nb => {
    const nbCount = notesArr.filter(n => !n.trashed && n.notebookId === nb.id).length;
    const active = notesSidebarView === 'notebook-' + nb.id ? ' active' : '';
    const nbIcon = nb.icon ? `<span style="font-size:14px;line-height:1;flex-shrink:0">${nb.icon}</span>` : `<div class="nb-dot" style="background:${nb.color}"></div>`;
    html += `<div class="ns-item${active}" draggable="true" data-nb-id="${nb.id}" data-notes-action="view-notebook">
      ${nbIcon}
      <span>${escHTML(nb.name || 'Untitled')}</span><span class="cnt">${nbCount}</span>
      <button class="nb-edit-btn" data-notes-action="show-nb-menu" data-nb-id="${nb.id}" title="Edit notebook">
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
      <div class="ns-item${notesSidebarView==='all'?' active':''}" data-notes-action="view-mobile" data-view="all">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        All Notes <span class="cnt">${allCount}</span>
      </div>
      <div class="ns-item${notesSidebarView==='starred'?' active':''}" data-notes-action="view-mobile" data-view="starred">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 17v5M9 10.76V6a2 2 0 1 1 4 0v4.76l3 1.54V15H6v-2.7l3-1.54z"/></svg>
        Pinned <span class="cnt">${starCount}</span>
      </div>
      <div class="ns-item${notesSidebarView==='trash'?' active':''}" data-notes-action="view-mobile" data-view="trash">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        Trash <span class="cnt">${trashCount}</span>
      </div>`;
    notebooksArr.forEach(nb => {
      const nbCount = notesArr.filter(n => !n.trashed && n.notebookId === nb.id).length;
      const active = notesSidebarView === 'notebook-' + nb.id ? ' active' : '';
      const nbIcon = nb.icon ? `<span style="font-size:14px;line-height:1">${nb.icon}</span>` : `<div class="nb-dot" style="background:${nb.color}"></div>`;
      drawerHtml += `<div class="ns-item${active}" data-notes-action="view-notebook-mobile" data-nb-id="${nb.id}">
        ${nbIcon}
        ${escHTML(nb.name || 'Untitled')} <span class="cnt">${nbCount}</span>
      </div>`;
    });
    drawerHtml += `<div class="ns-item" data-notes-action="create-notebook-mobile" style="color:var(--guava-700);font-weight:600">
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
    extra = `<button data-notes-action="empty-trash" style="margin-left:auto;border:none;background:none;cursor:pointer;font-size:11px;color:var(--guava-700);font-family:inherit;font-weight:600;padding:2px 6px;border-radius:4px">Empty Trash</button>`;
  } else if (notesSidebarView !== 'trash') {
    extra = `<button data-notes-action="enter-select-mode" title="Select notes" style="margin-left:auto;border:none;background:none;cursor:pointer;padding:2px 4px;border-radius:4px;color:var(--ink-3);display:flex;align-items:center">
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
        <button data-notes-action="toggle-select-all">
          ${cnt === list.length && list.length > 0 ? 'Deselect all' : 'Select all'}
        </button>
        <button class="danger" data-notes-action="bulk-trash" ${cnt === 0 ? 'disabled' : ''}>Trash (${cnt})</button>
        <button data-notes-action="bulk-move" ${cnt === 0 ? 'disabled' : ''}>Move (${cnt})</button>
        <span class="bulk-count">${cnt} selected</span>
        <button data-notes-action="exit-select-mode" style="border:none;padding:4px;color:var(--ink-3)">✕</button>`;
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
      html += `<div class="nl-item${active}${selClass}" data-note-id="${n.id}" data-notes-ctx="note">
        <div class="nl-item-head">
          <div class="nl-item-title">${escHTML(n.title || 'Untitled')}</div>
          <div class="nl-item-date">${date}</div>
        </div>
        <div class="nl-item-preview">${escHTML(preview)}</div>
        <div class="nl-item-meta" style="gap:6px">
          <button data-notes-action="note-restore" class="expand-action">Restore</button>
          <button data-notes-action="note-permanent-delete" class="expand-action" style="color:var(--guava-700);border-color:var(--guava-200)">Delete</button>
        </div>
      </div>`;
    } else {
      html += `<div class="nl-item${active}${selClass}" data-notes-action="note-click" data-note-id="${n.id}" draggable="true" style="animation-delay:${list.indexOf(n) * 0.03}s" data-notes-ctx="note">
        <input type="checkbox" class="nl-checkbox" ${checked} data-notes-action="note-toggle-select">
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
      <button class="mobile-note-back" data-notes-action="deselect-note">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
      </button>
      <div class="mobile-note-actions">
        <button class="mobile-note-action" data-notes-action="quill-undo" title="Undo">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
        </button>
        <button class="mobile-note-action" data-notes-action="quill-redo" title="Redo">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.13-9.36L23 10"/></svg>
        </button>
        <button class="mobile-note-action" data-notes-action="confirm-trash" title="Trash" style="color:var(--guava-700)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
        <button class="mobile-note-action" data-notes-action="toggle-star" title="Star">
          <svg viewBox="0 0 24 24" fill="${starFill}" stroke="currentColor" stroke-width="2" style="color:var(--guava-700)"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
        </button>
      </div>
    </div>
    <div class="ne-body">
      <div class="ne-page">
        <input class="ne-title" id="noteTitleInput" type="text" placeholder="Untitled" value="${escAttr(note.title)}" autocomplete="off" autocorrect="off" spellcheck="false">
        <div class="ne-meta">
          <div class="ne-meta-item">
            ${noteNbTag}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:11px;height:11px"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
            Created ${formatNoteDate(note.createdAt)}
            <span class="dot-sep"></span>
            Edited ${formatNoteDate(note.updatedAt)}
          </div>
          <div class="ne-meta-item" style="margin-left:auto;gap:8px">
            <select data-notes-change="note-nb" data-note-id="${note.id}" style="border:1px solid var(--edge);border-radius:5px;padding:2px 6px;font-size:10px;font-family:inherit;background:var(--surface);color:var(--ink-2);cursor:pointer">
              <option value="">No notebook</option>
              ${nbOptions}
            </select>
            <button class="note-action-btn" data-notes-action="confirm-trash" title="Move to Trash" style="color:var(--guava-700);padding:3px">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
            <button class="note-action-btn${note.starred ? ' starred' : ''}" id="noteStarBtn" data-notes-action="toggle-star" title="Star" style="padding:3px">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="${starFill}" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
            </button>
          </div>
        </div>
        <div id="noteEditor" class="ne-quill"></div>
      </div>
    </div>
  `;
  // Instantiate Quill on the freshly-rendered container, paste in the
  // existing content (with the legacy checklist migration), and wire
  // change/click handlers. Quill owns its own toolbar, paste sanitization,
  // and keyboard shortcuts so most of the old code paths are gone.
  const editorContainer = document.getElementById('noteEditor');
  if (editorContainer && typeof createQuillEditor === 'function') {
    _noteQuill = createQuillEditor(editorContainer, { placeholder: 'Start writing...' });
    if (_noteQuill) {
      if (note.content) {
        const migrated = migrateLegacyChecklistHTML(note.content);
        _noteQuill.clipboard.dangerouslyPasteHTML(migrated, 'silent');
      }
      _noteQuill.on('text-change', (_delta, _old, source) => {
        if (source === 'user') onNoteContentChange();
      });
      // Quill renders <a> tags but doesn't navigate when clicked in editor mode.
      _noteQuill.root.addEventListener('click', e => {
        const a = e.target.closest('a');
        if (a && a.href) { e.preventDefault(); window.open(a.href, '_blank', 'noopener'); }
      });
    }
  }
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
  if (!note || !_noteQuill) return;
  note.content = _noteQuill.root.innerHTML;
  note.updatedAt = new Date().toISOString();
  if (_noteSaveTimer) clearTimeout(_noteSaveTimer);
  _noteSaveTimer = setTimeout(() => { saveNoteToDB(note); renderNoteList(); }, 1000);
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
    <button data-notes-action="nb-rename" data-nb-id="${id}" style="display:flex;align-items:center;gap:8px;width:100%;padding:8px 12px;border:none;background:none;font-family:inherit;font-size:12px;cursor:pointer;border-radius:7px;color:var(--ink)">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
      Edit
    </button>
    <button data-notes-action="nb-delete" data-nb-id="${id}" style="display:flex;align-items:center;gap:8px;width:100%;padding:8px 12px;border:none;background:none;font-family:inherit;font-size:12px;cursor:pointer;border-radius:7px;color:var(--guava-700)">
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
      <button data-notes-action="close-inline-prompt" style="padding:7px 16px;border-radius:8px;border:1px solid var(--edge);background:var(--surface);font-family:inherit;font-size:12px;cursor:pointer">Cancel</button>
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
      ${NB_EMOJIS.map(e => `<button data-nb-emoji="${e}">${e}</button>`).join('')}
    </div>
    <div style="margin-bottom:14px">
      <div style="font-size:11px;color:var(--ink-3);margin-bottom:6px;font-weight:500">Color</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap" id="nbColorPicker">
        ${NB_COLORS.map(c => `<button data-nb-color="${c}" data-color="${c}" style="width:24px;height:24px;border-radius:50%;border:none;cursor:pointer;background:${c}${c === selectedColor ? ';outline:2px solid var(--ink)' : ''}" ${c === selectedColor ? 'data-selected="true"' : ''}></button>`).join('')}
      </div>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
      <button data-notes-action="close-nb-prompt" style="padding:7px 16px;border-radius:8px;border:1px solid var(--edge);background:var(--surface);font-family:inherit;font-size:12px;cursor:pointer">Cancel</button>
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
  overlay.addEventListener('click', e => { if (isCleanBackdropClick(e, overlay)) close(); });
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
  let html = `<button data-notes-action="ctx-bulk-move-nb" data-nb-id="">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    No notebook</button>`;
  notebooksArr.forEach(nb => {
    html += `<button data-notes-action="ctx-bulk-move-nb" data-nb-id="${nb.id}">
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
      <button data-notes-action="ctx-restore" data-note-id="${noteId}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
        Restore</button>
      <button class="danger" data-notes-action="ctx-permanent-delete" data-note-id="${noteId}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        Delete permanently</button>`;
  } else {
    const starLabel = note.starred ? 'Unstar' : 'Star';
    const starFill = note.starred ? 'currentColor' : 'none';
    html = `
      <button data-notes-action="ctx-star" data-note-id="${noteId}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="${starFill}" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
        ${starLabel}</button>
      <div class="ctx-submenu">
        <button style="justify-content:space-between">
          <span style="display:flex;align-items:center;gap:8px"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg> Move to</span>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
        <div class="ctx-sub-items">
          <button data-notes-action="ctx-move-nb" data-note-id="${noteId}" data-nb-id="">No notebook</button>`;
    notebooksArr.forEach(nb => {
      html += `<button data-notes-action="ctx-move-nb" data-note-id="${noteId}" data-nb-id="${nb.id}">
        <div class="nb-dot" style="background:${nb.color}"></div>${escHTML(nb.name)}</button>`;
    });
    html += `</div></div>
      <button data-notes-action="ctx-select" data-note-id="${noteId}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 12l2 2 4-4"/></svg>
        Select</button>
      <div class="ctx-divider"></div>
      <button class="danger" data-notes-action="ctx-trash" data-note-id="${noteId}">
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

/* ── MOBILE NOTEBOOK DRAWER TOGGLE ── */
document.getElementById('mobileNbToggle').addEventListener('click', () => {
  document.getElementById('mobileNbDrawer').classList.toggle('open');
});

/* ── NOTES DOM DELEGATION ──
 * Notes UI is rendered into multiple dynamic containers (sidebar, mobile
 * drawer, notes list, editor). Document-level delegation keyed on
 * [data-notes-action] + [data-notes-change] binds once and survives every
 * re-render. (Toolbar markup is gone — Quill renders its own.)
 */

// Click dispatcher
document.addEventListener('click', e => {
  const el = e.target.closest('[data-notes-action]');
  if (!el) return;
  const action = el.dataset.notesAction;
  const nbId = el.dataset.nbId;
  const nbIdNum = nbId === '' ? null : (nbId !== undefined ? parseInt(nbId) : null);
  const noteId = el.dataset.noteId ? parseInt(el.dataset.noteId) : null;
  const view = el.dataset.view || null;

  // Context-menu auto-close
  const noteCtxMenu = el.closest('.note-ctx-menu');
  const nbCtxMenu = el.closest('.nb-context-menu');
  const closeDrawer = () => document.getElementById('mobileNbDrawer').classList.remove('open');

  switch (action) {
    case 'view':            setNotesSidebarView(view); return;
    case 'view-mobile':     setNotesSidebarView(view); closeDrawer(); return;
    case 'view-notebook':   setNotesSidebarView('notebook-' + el.dataset.nbId); return;
    case 'view-notebook-mobile': setNotesSidebarView('notebook-' + el.dataset.nbId); closeDrawer(); return;
    case 'create-notebook': createNotebook(); return;
    case 'create-notebook-mobile': createNotebook(); closeDrawer(); return;
    case 'show-nb-menu':    e.stopPropagation(); showNotebookMenu(e, nbIdNum); return;
    case 'empty-trash':     emptyTrash(); return;
    case 'enter-select-mode': enterNoteSelectMode(); return;
    case 'toggle-select-all': toggleSelectAllNotes(); return;
    case 'bulk-trash':      bulkTrashNotes(); return;
    case 'bulk-move':       bulkMoveNotes(e); return;
    case 'exit-select-mode': exitNoteSelectMode(); return;
    case 'note-click':
      if (noteSelectMode) toggleNoteSelect(noteId);
      else selectNote(noteId);
      return;
    case 'note-toggle-select': e.stopPropagation(); toggleNoteSelect(noteId); return;
    case 'note-restore':    e.stopPropagation(); restoreNote(noteId); return;
    case 'note-permanent-delete': e.stopPropagation(); permanentDeleteNote(noteId); return;
    case 'deselect-note':   deselectNote(); return;
    case 'confirm-trash':   confirmTrashNote(); return;
    case 'toggle-star':     toggleNoteStar(); return;
    case 'quill-undo':      e.preventDefault(); _noteQuill && _noteQuill.history.undo(); return;
    case 'quill-redo':      e.preventDefault(); _noteQuill && _noteQuill.history.redo(); return;
    case 'nb-rename':       e.stopPropagation(); if (nbCtxMenu) nbCtxMenu.remove(); renameNotebook(nbIdNum); return;
    case 'nb-delete':       e.stopPropagation(); if (nbCtxMenu) nbCtxMenu.remove(); deleteNotebook(nbIdNum); return;
    case 'close-inline-prompt': document.getElementById('inlinePromptOverlay').style.display = 'none'; return;
    case 'close-nb-prompt': document.getElementById('nbPromptOverlay').style.display = 'none'; return;
    case 'ctx-bulk-move-nb': if (noteCtxMenu) noteCtxMenu.remove(); bulkMoveToNotebook(nbIdNum); return;
    case 'ctx-restore':     if (noteCtxMenu) noteCtxMenu.remove(); restoreNote(noteId); return;
    case 'ctx-permanent-delete': if (noteCtxMenu) noteCtxMenu.remove(); permanentDeleteNote(noteId); return;
    case 'ctx-star':        if (noteCtxMenu) noteCtxMenu.remove(); activeNoteId = noteId; toggleNoteStar(); return;
    case 'ctx-move-nb':     if (noteCtxMenu) noteCtxMenu.remove(); moveNoteToNotebook(noteId, nbIdNum); return;
    case 'ctx-select':      if (noteCtxMenu) noteCtxMenu.remove(); enterNoteSelectMode(); toggleNoteSelect(noteId); return;
    case 'ctx-trash':       if (noteCtxMenu) noteCtxMenu.remove(); activeNoteId = noteId; trashNote(); return;
  }
});

// NB emoji grid click (inline DOM manipulation)
document.addEventListener('click', e => {
  const btn = e.target.closest('[data-nb-emoji]');
  if (!btn) return;
  document.getElementById('nbEmojiBtn').textContent = btn.dataset.nbEmoji;
  document.getElementById('nbEmojiGrid').style.display = 'none';
});

// NB color picker (inline DOM manipulation)
document.addEventListener('click', e => {
  const btn = e.target.closest('[data-nb-color]');
  if (!btn) return;
  document.querySelectorAll('#nbColorPicker button').forEach(b => b.style.outline = 'none');
  btn.style.outline = '2px solid var(--ink)';
  btn.dataset.selected = 'true';
});

// Change dispatcher — only the notebook <select> remains; the heading
// <select> moved into the Quill toolbar.
document.addEventListener('change', e => {
  const el = e.target.closest('[data-notes-change]');
  if (!el) return;
  const kind = el.dataset.notesChange;
  if (kind === 'note-nb') return handleNoteNbChange(el, parseInt(el.dataset.noteId));
});

// Input dispatcher for the note title input (Quill manages the content
// editor via its text-change event — not via document input bubbling).
document.addEventListener('input', e => {
  if (e.target.id === 'noteTitleInput') return onNoteTitleChange(e.target.value);
});

// Context menu dispatcher (right-click on notes / notebooks)
document.addEventListener('contextmenu', e => {
  const noteEl = e.target.closest('[data-notes-ctx="note"][data-note-id]');
  if (noteEl) {
    e.preventDefault();
    showNoteContextMenu(e, parseInt(noteEl.dataset.noteId));
    return;
  }
  const nbEl = e.target.closest('.ns-item[data-nb-id]');
  if (nbEl && nbEl.dataset.notesAction === 'view-notebook') {
    e.preventDefault();
    showNotebookMenu(e, parseInt(nbEl.dataset.nbId));
  }
});

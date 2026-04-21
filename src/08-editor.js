
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

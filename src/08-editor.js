
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
  document.execCommand('insertHTML', false, '<div class="note-checklist-item"><input type="checkbox"> <span>' + label.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</span></div>');
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
    <button class="nb-menu-btn" data-note-action="star">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="${note?.starred?'currentColor':'none'}" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
      ${starLabel}
    </button>
    <button class="nb-menu-btn" data-note-action="trash" style="color:var(--guava-700)">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      Move to Trash
    </button>`;
  menu.querySelectorAll('.nb-menu-btn').forEach(b => {
    Object.assign(b.style, {display:'flex',alignItems:'center',gap:'8px',width:'100%',padding:'8px 12px',border:'none',background:'none',fontFamily:'inherit',fontSize:'12px',cursor:'pointer',borderRadius:'7px',color:b.style.color||'var(--ink)'});
    b.addEventListener('mouseenter', () => b.style.background = 'var(--surface-2)');
    b.addEventListener('mouseleave', () => b.style.background = 'none');
    b.addEventListener('click', () => {
      menu.remove();
      if (b.dataset.noteAction === 'star') toggleNoteStar();
      else if (b.dataset.noteAction === 'trash') trashNote();
    });
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
    done: false, note, due, order: -1,
    recur: newRecur || null,
  };
  tasks.unshift(newTask);
  tasks.filter(t=>!t.done).sort((a,b)=>(a.order??0)-(b.order??0)).forEach((t,i)=>t.order=i);
  document.getElementById('newTaskInput').value = '';
  document.getElementById('newNoteInput').value = '';
  document.getElementById('newDueDate').value = '';
  noteOpen = false; dueDateOpen = false; repeatOpen = false;
  document.getElementById('noteWrap').classList.remove('open');
  document.getElementById('noteToggle').classList.remove('active');
  document.getElementById('dueDateWrap').classList.remove('open');
  document.getElementById('dueDateToggle').classList.remove('active');
  document.getElementById('repeatWrap').innerHTML = '';
  document.getElementById('repeatToggle').classList.remove('active');
  newRecur = null;
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
  if (!t) return;
  t.done = !t.done;
  t.completedAt = t.done ? Date.now() : null;
  // Re-uncheck clears spawned so a future re-completion re-evaluates.
  if (!t.done) t.spawned = false;
  render();
  saveTask(t);
  // Lazy-spawn handles recurrence: if the parent was overdue and the next
  // due date is already today/past, spawn now; otherwise wait for the
  // load-time / day-change check.
  if (t.done && t.recur) ensureRecurringSpawns();
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

function toggleSortDropdown(e, btn) {
  e.stopPropagation();
  const dd = document.getElementById('sortDropdown');
  if (!dd) return;
  const isOpen = dd.classList.toggle('open');
  if (isOpen) {
    const r = (btn || e.currentTarget).getBoundingClientRect();
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
    return `<button class="tag-btn ${td.cls} ${sel}" data-key="${td.key}" title="${td.title||td.label}">${td.label}</button>`;
  }).join('');
  editRecur = t.recur || null;
  const editRepeatSection = document.getElementById('editRepeatSection');
  editRepeatSection.innerHTML = repeatSectionHTML(editRecur);
  initRepeatListeners(editRepeatSection, true);
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
  t.recur = editRecur;
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
document.getElementById('editTags').addEventListener('click', e => {
  const btn = e.target.closest('.tag-btn');
  if (btn) btn.classList.toggle('selected');
});
// Checklist item toggle inside any note contenteditable
document.addEventListener('click', e => {
  const cb = e.target;
  if (cb && cb.matches && cb.matches('.note-checklist-item > input[type="checkbox"]')) {
    cb.parentElement.classList.toggle('checked', cb.checked);
  }
});
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
   RECURRING TASKS
═══════════════════════════════════════════════ */
let newRecur = null;
let editRecur = null;
let repeatOpen = false;

const _RECUR_SVG = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>`;

function repeatSectionHTML(currentRecur) {
  const on = !!currentRecur;
  const freq = currentRecur?.freq || 'daily';
  const days = currentRecur?.days || [];
  const end  = currentRecur?.end  || 'never';
  const FREQ_LABELS = ['daily','weekly','monthly','yearly'];
  const DAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

  const optsHtml = on ? `<div class="repeat-opts">
    <div class="repeat-freq-row">
      <span class="repeat-label">Freq</span>
      ${FREQ_LABELS.map(f=>`<button class="freq-btn${f===freq?' sel':''}" data-rfreq="${f}">${f.charAt(0).toUpperCase()+f.slice(1)}</button>`).join('')}
    </div>
    ${freq==='weekly'?`<div class="repeat-days-row">
      <span class="repeat-label">Days</span>
      ${DAYS.map(d=>`<button class="day-btn${days.includes(d)?' sel':''}" data-rday="${d}">${d[0]}</button>`).join('')}
    </div>`:''}
    <div class="repeat-end-row">
      <span class="repeat-label">End</span>
      <button class="end-btn${end==='never'?' sel':''}" data-rend="never">Never</button>
      <button class="end-btn${end==='after'?' sel':''}" data-rend="after">After…</button>
      <button class="end-btn${end==='date'?' sel':''}" data-rend="date">On date</button>
    </div>
    ${end==='after'?`<input type="number" class="repeat-end-input" id="repeatAfterCount" placeholder="# of times" min="1" value="${currentRecur?.afterCount||''}">` :''}
    ${end==='date' ?`<input type="date"   class="repeat-end-input" id="repeatEndDate"    value="${currentRecur?.endDate||''}">` :''}
  </div>` : '';

  return `<div class="repeat-row">
    <div class="repeat-icon">${_RECUR_SVG}</div>
    <span style="font-size:12px;font-weight:600;color:var(--ink-2);flex:1;">Repeat</span>
    <label class="toggle-switch">
      <input type="checkbox" class="recur-toggle-chk" ${on?'checked':''}>
      <span class="track"></span>
    </label>
  </div>
  ${optsHtml}`;
}

function initRepeatListeners(wrapEl, isEdit) {
  const version = String(Date.now() + Math.random());
  wrapEl.dataset.repeatV = version;
  const live = () => wrapEl.dataset.repeatV === version;

  const getRecur = () => isEdit ? editRecur : newRecur;
  const setRecur = r => { if (isEdit) editRecur = r; else newRecur = r; };

  wrapEl.addEventListener('change', e => {
    if (!live()) return;
    const chk = e.target.closest('.recur-toggle-chk');
    if (!chk) return;
    setRecur(chk.checked ? { freq:'daily', days:[], end:'never' } : null);
    wrapEl.innerHTML = repeatSectionHTML(getRecur());
    initRepeatListeners(wrapEl, isEdit);
  });

  wrapEl.addEventListener('click', e => {
    if (!live()) return;
    const fb = e.target.closest('[data-rfreq]');
    const db = e.target.closest('[data-rday]');
    const eb = e.target.closest('[data-rend]');
    if (!fb && !db && !eb) return;
    const cur = getRecur();
    if (!cur) return;

    if (fb) {
      setRecur({ ...cur, freq: fb.dataset.rfreq, days: fb.dataset.rfreq === 'weekly' ? cur.days : [] });
      wrapEl.innerHTML = repeatSectionHTML(getRecur());
      initRepeatListeners(wrapEl, isEdit);
    } else if (db) {
      const d = db.dataset.rday;
      const newDays = cur.days.includes(d) ? cur.days.filter(x=>x!==d) : [...cur.days, d];
      setRecur({ ...cur, days: newDays });
      db.classList.toggle('sel', !cur.days.includes(d));
    } else if (eb) {
      setRecur({ ...cur, end: eb.dataset.rend });
      wrapEl.innerHTML = repeatSectionHTML(getRecur());
      initRepeatListeners(wrapEl, isEdit);
    }
  });

  wrapEl.addEventListener('input', e => {
    if (!live()) return;
    const inp = e.target;
    const cur = getRecur();
    if (!cur) return;
    if (inp.id === 'repeatAfterCount') setRecur({ ...cur, afterCount: parseInt(inp.value)||null });
    if (inp.id === 'repeatEndDate')    setRecur({ ...cur, endDate: inp.value || null });
  });
}

function toggleRepeatField() {
  repeatOpen = !repeatOpen;
  const wrap = document.getElementById('repeatWrap');
  document.getElementById('repeatToggle').classList.toggle('active', repeatOpen);
  if (repeatOpen) {
    wrap.innerHTML = repeatSectionHTML(newRecur);
    initRepeatListeners(wrap, false);
  } else {
    wrap.innerHTML = '';
    newRecur = null;
  }
}

function nextDueDate(due, recur) {
  if (!due) return null;
  const d = new Date(due + 'T00:00:00');
  if (recur.freq === 'daily')   d.setDate(d.getDate() + 1);
  if (recur.freq === 'weekly')  d.setDate(d.getDate() + 7);
  if (recur.freq === 'monthly') d.setMonth(d.getMonth() + 1);
  if (recur.freq === 'yearly')  d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Lazy spawning for recurring tasks. Replaces the old eager spawn that
 * fired inside toggleDone — that approach made completion feel
 * unacknowledged because an identical row reappeared in the same spot.
 *
 * Rules:
 *   - Skip unless the task is done + recurring + recur.end === 'never'
 *     + not yet spawned.
 *   - Compute the next due date from the parent's due date.
 *   - If the next due date is in the future → leave alone, wait for the
 *     next load / day-change pass to revisit.
 *   - If the next due date has arrived (today) or is in the past
 *     (overdue parent), create one new instance dated max(nextDue, today)
 *     and mark the parent as spawned. We deliberately do NOT spawn one
 *     row per missed period — it'd be noise.
 */
function ensureRecurringSpawns() {
  if (typeof tasks === 'undefined' || !Array.isArray(tasks)) return;
  const today = (typeof todayStr === 'function')
    ? todayStr()
    : new Date().toISOString().slice(0, 10);
  let changed = false;
  // Snapshot to avoid iterating into newly-pushed spawns
  for (const t of tasks.slice()) {
    if (!t.done || !t.recur || t.spawned) continue;
    if (t.recur.end !== 'never') continue;
    const next = nextDueDate(t.due, t.recur);
    if (!next) continue;
    if (next > today) continue; // future — wait
    const dueStr = next < today ? today : next;
    const spawn = {
      ...t,
      id: Date.now() + Math.floor(Math.random() * 1000),
      done: false,
      completedAt: null,
      spawned: false,
      due: dueStr,
      order: -1,
    };
    tasks.unshift(spawn);
    saveTask(spawn);
    t.spawned = true;
    saveTask(t);
    changed = true;
  }
  if (changed) {
    tasks.filter(x => !x.done).sort((a,b)=>(a.order??0)-(b.order??0)).forEach((x,i) => x.order = i);
    render();
  }
}

// Day-change watcher: ensures recurring tasks spawn even when the user
// keeps the tab open across midnight or returns to it the next day.
let _gsdLastSpawnCheckDate = (typeof todayStr === 'function')
  ? todayStr()
  : new Date().toISOString().slice(0, 10);
function _gsdMaybeSpawnOnDayChange() {
  const now = (typeof todayStr === 'function')
    ? todayStr()
    : new Date().toISOString().slice(0, 10);
  if (now !== _gsdLastSpawnCheckDate) {
    _gsdLastSpawnCheckDate = now;
    ensureRecurringSpawns();
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') _gsdMaybeSpawnOnDayChange();
});
setInterval(_gsdMaybeSpawnOnDayChange, 5 * 60 * 1000);

/* ── CREATE-PANEL FORM & SORT DROPDOWN ── */
document.getElementById('newTaskInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') addTask();
  else if (e.key === 'Escape') closeCreatePanel();
});
document.getElementById('newDueDate').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); addTask(); }
});
document.querySelectorAll('.create-panel-tags .tag-btn[data-new-tag]').forEach(btn => {
  btn.addEventListener('click', () => toggleNewTag(btn.dataset.newTag));
});
document.getElementById('noteToggle').addEventListener('click', toggleNoteField);
document.getElementById('dueDateToggle').addEventListener('click', toggleDueDateField);
document.getElementById('repeatToggle').addEventListener('click', toggleRepeatField);
document.getElementById('btnAddTask').addEventListener('click', addTask);

document.getElementById('sortDropdown').addEventListener('click', e => {
  e.stopPropagation();
  const opt = e.target.closest('.sort-opt[data-sort]');
  if (opt) setSort(opt.dataset.sort);
});

/* ── TASK EDIT MODAL HANDLERS ── */
document.getElementById('editModalClose').addEventListener('click', closeModal);
document.getElementById('editCancelBtn').addEventListener('click', closeModal);
document.getElementById('editSaveBtn').addEventListener('click', saveEdit);
document.getElementById('editDeleteBtn').addEventListener('click', () => {
  delTask(editId);
  closeModal();
});

document.querySelectorAll('#richToolbar .rich-btn[data-cmd]').forEach(btn => {
  btn.addEventListener('mousedown', e => richCmd(e, btn.dataset.cmd));
});
document.getElementById('richLinkBtn').addEventListener('mousedown', richInsertLink);

const editNoteRichEl = document.getElementById('editNoteRich');
editNoteRichEl.addEventListener('keyup', () => richAutoLink(editNoteRichEl));
editNoteRichEl.addEventListener('input', updateRichToolbarState);

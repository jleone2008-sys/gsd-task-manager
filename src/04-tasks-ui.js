
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
  const btnHtml = s.btn ? `<button class="expand-action empty-state-btn" data-task-action="open-create">${s.btn}</button>` : '';
  return `<div class="empty-state">
    <div class="empty-state-title">${s.title}</div>
    ${btnHtml}
  </div>`;
}

let taskStatsOffset = 0;

function computeTaskStatsData(period, offset) {
  const now = new Date();
  let start, end, bars = [], navLabel = '';

  if (period === 'daily') {
    start = new Date(now); start.setDate(start.getDate() + offset); start.setHours(0,0,0,0);
    end   = new Date(start); end.setHours(23,59,59,999);
    navLabel = start.toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' });
    for (let h = 0; h < 24; h++) {
      const hs = new Date(start); hs.setHours(h,0,0,0);
      const he = new Date(start); he.setHours(h,59,59,999);
      bars.push({ l: h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h-12}p`,
        created:   tasks.filter(t => { const d=new Date(t.createdAt || t.id); return d>=hs&&d<=he; }).length,
        completed: tasks.filter(t => { if (!t.completedAt) return false; const d=new Date(t.completedAt); return d>=hs&&d<=he; }).length });
    }
  } else if (period === 'weekly') {
    const dow = now.getDay();
    const weekStart = new Date(now); weekStart.setDate(weekStart.getDate() - dow + offset * 7); weekStart.setHours(0,0,0,0);
    const weekEnd   = new Date(weekStart); weekEnd.setDate(weekEnd.getDate() + 6); weekEnd.setHours(23,59,59,999);
    start = weekStart; end = weekEnd;
    const wFmt = d => d.toLocaleDateString('en-US',{month:'short',day:'numeric'});
    navLabel = `${wFmt(weekStart)} – ${wFmt(weekEnd)}`;
    const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    for (let d = 0; d < 7; d++) {
      const ds = new Date(weekStart); ds.setDate(ds.getDate()+d); ds.setHours(0,0,0,0);
      const de = new Date(ds); de.setHours(23,59,59,999);
      bars.push({ l: days[d],
        created:   tasks.filter(t => { const x=new Date(t.createdAt || t.id); return x>=ds&&x<=de; }).length,
        completed: tasks.filter(t => { if (!t.completedAt) return false; const x=new Date(t.completedAt); return x>=ds&&x<=de; }).length });
    }
  } else if (period === 'monthly') {
    const mo = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    start = new Date(mo); start.setHours(0,0,0,0);
    end   = new Date(mo.getFullYear(), mo.getMonth()+1, 0, 23, 59, 59, 999);
    navLabel = mo.toLocaleDateString('en-US',{month:'long',year:'numeric'});
    const weeksInMonth = Math.ceil((end.getDate() + start.getDay()) / 7);
    for (let w = 0; w < weeksInMonth; w++) {
      const ws = new Date(start); ws.setDate(ws.getDate() + w*7 - start.getDay()); ws.setHours(0,0,0,0);
      const we = new Date(ws); we.setDate(we.getDate()+6); we.setHours(23,59,59,999);
      const wsC = ws < start ? new Date(start) : ws;
      const weC = we > end   ? new Date(end)   : we;
      bars.push({ l: `W${w+1}`,
        created:   tasks.filter(t => { const x=new Date(t.createdAt || t.id); return x>=wsC&&x<=weC; }).length,
        completed: tasks.filter(t => { if (!t.completedAt) return false; const x=new Date(t.completedAt); return x>=wsC&&x<=weC; }).length });
    }
  } else { // yearly
    const yr = now.getFullYear() + offset;
    start = new Date(yr, 0, 1, 0, 0, 0, 0);
    end   = new Date(yr, 11, 31, 23, 59, 59, 999);
    navLabel = String(yr);
    const mNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    for (let m = 0; m < 12; m++) {
      const ms = new Date(yr, m, 1, 0, 0, 0, 0);
      const me = new Date(yr, m+1, 0, 23, 59, 59, 999);
      bars.push({ l: mNames[m],
        created:   tasks.filter(t => { const x=new Date(t.createdAt || t.id); return x>=ms&&x<=me; }).length,
        completed: tasks.filter(t => { if (!t.completedAt) return false; const x=new Date(t.completedAt); return x>=ms&&x<=me; }).length });
    }
  }

  const created   = tasks.filter(t => { const x=new Date(t.createdAt || t.id); return x>=start&&x<=end; }).length;
  const completed = tasks.filter(t => { if (!t.completedAt) return false; const x=new Date(t.completedAt); return x>=start&&x<=end; }).length;
  const rate = created > 0 ? Math.round(completed / created * 100) : 0;

  const best = bars.reduce((b,x) => x.completed > b.completed ? x : b, bars[0] || {l:'',completed:0});
  const insight = best && best.completed > 0
    ? `Best period: ${best.l} (${best.completed} completed)`
    : 'No completed tasks this period.';

  return { created, completed, rate, bars, navLabel, insight };
}

function renderTaskStats() {
  const periods = ['daily','weekly','monthly','yearly'];
  const pillsHtml = periods.map(p =>
    `<button class="pill${taskStatsView===p?' active':''}" data-stats-period="${p}">${p.charAt(0).toUpperCase()+p.slice(1)}</button>`
  ).join('');

  const { created, completed, rate, bars, navLabel, insight } = computeTaskStatsData(taskStatsView, taskStatsOffset);
  const maxVal = Math.max(1, ...bars.map(b => Math.max(b.created, b.completed)));

  const barsHtml = bars.map(b => {
    const cH = Math.max(2, Math.round((b.created   / maxVal) * 60));
    const dH = Math.max(2, Math.round((b.completed / maxVal) * 60));
    return `<div class="st-trend-wrap">
      <div style="display:flex;gap:2px;align-items:flex-end;width:100%">
        <div class="st-trend-bar" style="height:${b.created>0?cH:0}px;flex:1;background:var(--edge-strong);opacity:0.6" title="Created: ${b.created}"></div>
        <div class="st-trend-bar" style="height:${b.completed>0?dH:0}px;flex:1;background:var(--guava-500)" title="Completed: ${b.completed}"></div>
      </div>
      <div class="st-trend-mo">${b.l}</div>
    </div>`;
  }).join('');

  return `
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">${pillsHtml}</div>
    <div class="stat-cards-grid" style="margin-bottom:10px">
      <div class="stat-card"><div class="sc-val" style="color:var(--ink)">${created}</div><div class="sc-lbl">Created</div></div>
      <div class="stat-card"><div class="sc-val" style="color:var(--guava-700)">${completed}</div><div class="sc-lbl">Completed</div></div>
      <div class="stat-card"><div class="sc-val" style="color:var(--guava-700)">${rate}%</div><div class="sc-lbl">Rate</div></div>
    </div>
    <div class="st-card">
      <div class="st-nav">
        <button data-stats-nav="-1">&#8592;</button>
        <span class="st-nav-label">${navLabel}</span>
        <button data-stats-nav="1" ${taskStatsOffset >= 0 ? 'disabled style="opacity:0.3;cursor:default"' : ''}>${taskStatsOffset < 0 ? '&#8594;' : '&#8594;'}</button>
      </div>
      <div class="st-card-title" style="margin-top:8px">${taskStatsView.toUpperCase()} BREAKDOWN</div>
      <div class="st-trend">${barsHtml}</div>
      <div style="display:flex;gap:8px;margin-top:6px;font-size:10px;color:var(--ink-3)">
        <span style="display:flex;align-items:center;gap:4px"><span style="display:inline-block;width:8px;height:8px;background:var(--edge-strong);opacity:0.6;border-radius:2px"></span>Created</span>
        <span style="display:flex;align-items:center;gap:4px"><span style="display:inline-block;width:8px;height:8px;background:var(--guava-500);border-radius:2px"></span>Completed</span>
      </div>
    </div>
    <div class="st-insight" style="margin-top:10px">
      <div class="st-insight-text">${insight}</div>
    </div>`;
}

function render() {
  const c = document.getElementById('taskContainer');
  if (filter === 'stats') {
    c.innerHTML = renderTaskStats();
    updateTaskPillCounts();
    document.getElementById('fabBtn')?.classList.add('hidden');
    return;
  }
  let active = tasks.filter(t=>!t.done).sort((a,b)=>(a.order??0)-(b.order??0));
  let done = tasks.filter(t=>t.done).sort((a,b) => (b.completedAt||b.id) - (a.completedAt||a.id));
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
    html += `<div class="done-toggle" data-task-action="toggle-done-section">&#9654;&nbsp; Completed (${done.length})</div>`;
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
  const sortHtml = showSort ? `<div class="sort-wrap"><button class="sort-btn" data-task-action="toggle-sort">Sort by <span class="sort-val">${sortLabels[sortBy]}</span> <span style="font-size:7px">▼</span></button></div>` : '';
  return `<div class="section-label">${cleaned}<span class="cnt">${n}</span>${sortHtml}</div>`;
}

// Search variant — highlights matched text, disables drag, opens edit on body tap
function tHTMLsearch(t, query) {
  const tagHtml = t.tags.map(tg=>`<span class="tag ${tg}">${tg==='biz'?'Work':'Personal'}</span>`).join('');
  const sdTag = t.someday?`<span class="tag someday">Later</span>`:'';
  const noteTag = t.note?`<span class="tag has-note" title="Has note"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>Note</span>`:'';
  const subsTag = subtasksTagHTML(t);
  const dueHtml = dueBadgeHTML(t.due);
  const recurHtml = recurChipHTML(t.recur);
  const hasMeta = t.tags.length||t.someday||t.due||t.note||subsTag||t.recur;
  const cardCls = ['card','task-item'];
  if (t.top3) cardCls.push('top3','is-priority');
  if (t.done) cardCls.push('done','is-done');
  return `<div class="${cardCls.join(' ')}" id="ti-${t.id}" data-id="${t.id}">
    <div class="swipe-delete-bg">🗑</div>
    <div class="swipe-complete-bg">✓</div>
    <span class="strip" data-task-action="toggle-top3" title="Toggle priority"></span>
    <div class="card-head">
      <div class="card-body task-content" data-task-action="open-edit">
        <div class="card__title task-text">${highlight(linkify(t.text), query)}</div>
        ${hasMeta ? `<div class="card__meta task-meta">${tagHtml}${sdTag}${noteTag}${subsTag}${dueHtml}${recurHtml}</div>` : ''}
      </div>
      <button class="check checkbox" data-task-action="toggle-done" aria-label="${t.done?'Reopen':'Complete'}">
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

const RECUR_ICON_SVG = `<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>`;

function freqLabel(freq) {
  return freq === 'daily' ? 'Daily' : freq === 'weekly' ? 'Weekly' : freq === 'monthly' ? 'Monthly' : 'Yearly';
}

function recurChipHTML(recur) {
  if (!recur) return '';
  const lbl = recur.freq === 'daily'   ? 'Daily'
             : recur.freq === 'weekly'  ? `Weekly · ${(recur.days||[]).join(', ')}`
             : recur.freq === 'monthly' ? 'Monthly' : 'Yearly';
  return `<span class="chip chip--sky">${RECUR_ICON_SVG} ${lbl}</span>`;
}

function tHTML(t) {
  const tagHtml = t.tags.map(tg=>`<span class="tag ${tg}">${tg==='biz'?'Work':'Personal'}</span>`).join('');
  const sdTag = t.someday?`<span class="tag someday">Later</span>`:'';
  const noteTag = t.note?`<span class="tag has-note" title="Has note"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>Note</span>`:'';
  const subsTag = subtasksTagHTML(t);
  const dueHtml = dueBadgeHTML(t.due);
  const recurHtml = recurChipHTML(t.recur);
  const hasMeta = t.tags.length||t.someday||t.due||t.note||subsTag||t.recur;
  const isExpanded = expandedTaskIds.has(t.id);
  const expandHtml = isExpanded ? expansionBodyHTML(t) : '';
  const tcid = String(t.id);
  const subs = subtasksByTask.get(tcid) || [];
  const subsListHtml = (isExpanded && subs.length)
    ? `<div class="subtask-list" id="subs-${tcid}" data-tcid="${tcid}">${subs.map(s=>subtaskRowHTML(tcid, s)).join('')}</div>`
    : '';
  const cardCls = ['card','task-item'];
  if (t.top3)  cardCls.push('top3','is-priority');
  if (t.done)  cardCls.push('done','is-done');
  if (isExpanded) cardCls.push('is-expanded');
  return `<div class="task-group">
    <div class="${cardCls.join(' ')}" id="ti-${t.id}" draggable="true" data-id="${t.id}">
      <div class="swipe-delete-bg">🗑</div>
      <div class="swipe-complete-bg">✓</div>
      <span class="strip" data-task-action="toggle-top3" title="Toggle priority"></span>
      <div class="card-head">
        <div class="card-body task-content" data-task-action="toggle-expand">
          <div class="card__title task-text">${linkify(t.text)}</div>
          ${hasMeta ? `<div class="card__meta task-meta">${tagHtml}${sdTag}${noteTag}${subsTag}${dueHtml}${recurHtml}</div>` : ''}
        </div>
        <button class="check checkbox" data-task-action="toggle-done" aria-label="${t.done?'Reopen':'Complete'}">
          <svg width="9" height="7" viewBox="0 0 10 8" fill="none"><path d="M1 4L3.5 6.5L9 1" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>
        </button>
      </div>
      ${expandHtml}
    </div>
    ${subsListHtml}
  </div>`;
}

function expansionBodyHTML(t) {
  // Notes are stored as rich HTML from the contenteditable editor. Use
  // richToDisplay (DOMPurify-backed) so tags render as formatted text, not
  // escaped source. linkify would escape the HTML and show raw <b>…</b>.
  const noteHtml = t.note ? `<div class="card__note task-expand__note">${richToDisplay(t.note)}</div>` : '';
  const priorityOn = t.top3 ? ' is-on' : '';
  return `<div class="card__expand task-expand">
    ${noteHtml}
    <div class="card__actions task-expand__actions">
      <button class="expand-action" data-task-action="new-subtask">+ subtask</button>
      <button class="expand-action" data-task-action="open-edit">edit</button>
      <button class="expand-action${priorityOn}" data-task-action="toggle-top3">priority</button>
      ${t.recur ? `<button class="expand-action is-sky" data-task-action="edit-recur">↻ ${freqLabel(t.recur.freq)}</button>` : ''}
    </div>
  </div>`;
}

// Mini-card subtask renderer. Emits a `.card.card--mini.subtask-row`
// so existing `.closest('.subtask-row')` queries keep working. The
// guava spine + node are drawn by `.subtask-wrap` pseudos in app.css.
function subtaskRowHTML(taskClientId, s) {
  const bodyInner = s.isNew
    ? `<input class="subtask-input" data-new-subtask-input placeholder="New subtask…" />`
    : `<div class="card__title subtask-text" data-task-action="edit-subtask">${escapeHTML(s.text)}</div>`;
  const doneCls = s.done ? ' is-done' : '';
  const checkAttr = s.isNew ? '' : ' data-task-action="toggle-subtask"';
  const checkAria = s.isNew ? 'aria-hidden="true"' : `aria-label="${s.done?'Reopen':'Complete'}"`;
  return `<div class="subtask-wrap">
    <span class="node"></span>
    <div class="card card--mini subtask-row${doneCls}" data-sub-id="${s.client_id}">
      <span class="strip"></span>
      <button class="subtask-del" data-task-action="delete-subtask" aria-label="Delete subtask">×</button>
      <div class="card-body">${bodyInner}</div>
      <button class="check"${checkAttr} ${checkAria}></button>
    </div>
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
  if (f !== 'stats') document.getElementById('fabBtn')?.classList.remove('hidden');
  filter = f;
  filterStarred = false;
  const bar = document.querySelector('[data-tool-view="tasks"].pill-bar');
  if (bar) bar.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
  if (!el && bar) el = bar.querySelector(`.pill[data-filter="${f}"]`);
  if (el) el.classList.add('active');
  render();
  if (typeof routerSyncUrl === 'function' && activeTool === 'tasks') {
    routerSyncUrl({ tool: 'tasks', filter: f === 'all' ? null : f }, { replace: true });
  }
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

/* ── PILL BAR, FLOATING SEARCH, FAB & CREATE PANEL SHELL ── */
document.querySelector('.pill-bar[data-tool-view="tasks"] .pill-bar-inner')
  .addEventListener('click', e => {
    const pill = e.target.closest('.pill[data-filter]');
    if (!pill) return;
    setCatFilter(pill.dataset.filter, pill);
  });

document.getElementById('floatingSearch').addEventListener('click', expandFloatingSearch);
document.getElementById('floatingSearchInput').addEventListener('input', e => handleFloatingSearch(e.target.value));
document.getElementById('floatingSearchInput').addEventListener('keydown', e => {
  if (e.key === 'Escape') collapseFloatingSearch();
});
document.getElementById('fsClear').addEventListener('click', e => {
  e.stopPropagation();
  clearFloatingSearch();
});

document.getElementById('fabBtn').addEventListener('click', openCreatePanel);
document.getElementById('createPanel').addEventListener('click', e => {
  if (isCleanBackdropClick(e, e.currentTarget)) closeCreatePanel();
});

/* ── TASK LIST DELEGATION ──
 * One click listener on #taskContainer dispatches all task-card actions
 * based on [data-task-action]. Task id comes from closest .task-item
 * (parent card) OR, when the event originated inside a subtask that
 * lives outside its parent .task-item, from [data-tcid] on the
 * enclosing .subtask-list. Subtask id comes from closest .subtask-row.
 */
function taskContextFromEvent(el) {
  const taskItem = el.closest('.task-item');
  if (taskItem) return { tid: parseInt(taskItem.dataset.id), tcid: taskItem.dataset.id };
  const subList = el.closest('.subtask-list');
  if (subList) return { tid: parseInt(subList.dataset.tcid), tcid: subList.dataset.tcid };
  return { tid: null, tcid: null };
}
document.getElementById('taskContainer').addEventListener('click', e => {
  // Stats sub-period pills
  const periodBtn = e.target.closest('[data-stats-period]');
  if (periodBtn) {
    taskStatsView = periodBtn.dataset.statsPeriod;
    taskStatsOffset = 0;
    render();
    return;
  }
  // Stats period nav (prev/next)
  const navBtn = e.target.closest('[data-stats-nav]');
  if (navBtn && !navBtn.disabled) {
    taskStatsOffset += parseInt(navBtn.dataset.statsNav, 10);
    render();
    return;
  }

  const actionEl = e.target.closest('[data-task-action]');
  if (!actionEl) return;
  const action = actionEl.dataset.taskAction;
  const { tid, tcid } = taskContextFromEvent(actionEl);
  const subRow = actionEl.closest('.subtask-row');
  const subCid = subRow ? subRow.dataset.subId : null;

  switch (action) {
    case 'open-create':         openCreatePanel(); break;
    case 'toggle-done-section': toggleDone(); break;
    case 'toggle-sort':         toggleSortDropdown(e, actionEl); break;
    case 'toggle-top3':         toggleTop3(tid); break;
    case 'toggle-done':         toggleDone_t(tid); break;
    case 'toggle-expand':       toggleTaskExpand(tid); break;
    case 'open-edit':           openEdit(tid); break;
    case 'edit-recur':          openEdit(tid); break;
    case 'new-subtask':         startNewSubtask(tcid); break;
    case 'toggle-subtask':      toggleSubtask(tcid, subCid); break;
    case 'edit-subtask':        startEditSubtask(tcid, subCid); break;
    case 'delete-subtask':      deleteSubtask(tcid, subCid); break;
  }
});
document.getElementById('taskContainer').addEventListener('keydown', e => {
  const inp = e.target.closest('.subtask-input[data-new-subtask-input]');
  if (!inp) return;
  const { tcid } = taskContextFromEvent(inp);
  const subRow = inp.closest('.subtask-row');
  if (tcid && subRow) handleSubtaskInputKey(e, tcid, subRow.dataset.subId);
});
document.getElementById('taskContainer').addEventListener('focusout', e => {
  const inp = e.target.closest('.subtask-input[data-new-subtask-input]');
  if (!inp) return;
  const { tcid } = taskContextFromEvent(inp);
  const subRow = inp.closest('.subtask-row');
  if (tcid && subRow) commitNewSubtask(tcid, subRow.dataset.subId, inp.value);
});

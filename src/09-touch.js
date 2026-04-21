
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


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

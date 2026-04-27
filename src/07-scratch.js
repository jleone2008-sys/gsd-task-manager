
/* ══════ SCRATCH ══════
   Brain-dump editor. Single row in `notes` (client_id = SCRATCH_ID = -1)
   with HTML content. Powered by Quill 2.x — see src/12-quill-init.js for
   the shared editor factory and the legacy-checklist migration helper.
*/
let _scratchSaveTimer = null;
// Active Quill instance for the scratch editor. Recreated on every
// renderScratch() call (which rebuilds the DOM via innerHTML).
let _scratchQuill = null;

function renderScratch() {
  const el = document.getElementById('scratchEditorContent');
  if (!el) return;
  // IMPORTANT: don't add .mobile-open here. That class turns the editor into
  // a position:fixed top:0 overlay which covers the app header. Scratch
  // should flow in-page with the header visible above it.
  document.getElementById('scratchEditor')?.classList.remove('mobile-open');
  el.innerHTML = `
    <div class="ne-body">
      <div class="ne-page ne-quill">
        ${renderCustomToolbar('scratchToolbar', 'scratchHeadingSelect')}
        <div id="scratchEditorQuill"></div>
      </div>
    </div>
  `;

  const editorContainer = document.getElementById('scratchEditorQuill');
  if (editorContainer && typeof createQuillEditor === 'function') {
    _scratchQuill = createQuillEditor(editorContainer, {
      placeholder: 'Brain dump here...',
      toolbarContainer: '#scratchToolbar',
    });
    if (_scratchQuill) {
      wireQuillHeadingSelect(document.getElementById('scratchHeadingSelect'), _scratchQuill);
      const saved = scratchNote.content || localStorage.getItem('gsd-scratch') || '';
      if (saved) {
        const migrated = migrateLegacyChecklistHTML(saved);
        _scratchQuill.clipboard.dangerouslyPasteHTML(migrated, 'silent');
      }
      _scratchQuill.on('text-change', (_delta, _old, source) => {
        if (source === 'user') onScratchContentChange();
      });
      _scratchQuill.root.addEventListener('click', e => {
        const a = e.target.closest('a');
        if (a && a.href) { e.preventDefault(); window.open(a.href, '_blank', 'noopener'); }
      });
      // Auto-focus the editor on first render
      setTimeout(() => _scratchQuill && _scratchQuill.focus(), 50);
    }
  }
  // Hide FAB — not relevant for scratch
  document.getElementById('fabBtn')?.classList.add('hidden');
}

function onScratchContentChange() {
  if (!_scratchQuill) return;
  // Update in-memory state immediately — no lag
  scratchNote.content = _scratchQuill.root.innerHTML;
  scratchNote.updatedAt = new Date().toISOString();
  // Cache locally for fast reload
  localStorage.setItem('gsd-scratch', scratchNote.content);
  // Debounced DB sync — 1s matches notes, avoids hammering on every keystroke
  if (_scratchSaveTimer) clearTimeout(_scratchSaveTimer);
  _scratchSaveTimer = setTimeout(() => { saveNoteToDB(scratchNote); }, 1000);
}


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
            <button class="tb-btn" data-scratch-cmd="undo" title="Undo">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
            </button>
            <button class="tb-btn" data-scratch-cmd="redo" title="Redo">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.13-9.36L23 10"/></svg>
            </button>
          </div>
          <div class="tb-group">
            <select class="tb-select" data-scratch-heading>
              <option value="p">Normal</option>
              <option value="h1">Heading 1</option>
              <option value="h2">Heading 2</option>
            </select>
          </div>
          <div class="tb-group">
            <button class="tb-btn" data-scratch-cmd="bold" title="Bold">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 4h8a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"/><path d="M6 12h9a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"/></svg>
            </button>
            <button class="tb-btn" data-scratch-cmd="italic" title="Italic">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="19" y1="4" x2="10" y2="4"/><line x1="14" y1="20" x2="5" y2="20"/><line x1="15" y1="4" x2="9" y2="20"/></svg>
            </button>
            <button class="tb-btn" data-scratch-cmd="underline" title="Underline">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 3v7a6 6 0 0 0 6 6 6 6 0 0 0 6-6V3"/><line x1="4" y1="21" x2="20" y2="21"/></svg>
            </button>
          </div>
          <div class="tb-group">
            <button class="tb-btn" data-scratch-action="checklist" title="Checklist">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="6" height="6" rx="1"/><path d="M5 8l1.5 1.5L9 6"/><line x1="12" y1="8" x2="21" y2="8"/><rect x="3" y="14" width="6" height="6" rx="1"/><line x1="12" y1="17" x2="21" y2="17"/></svg>
            </button>
            <button class="tb-btn" data-scratch-cmd="insertUnorderedList" title="Bullet list">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1" fill="currentColor"/><circle cx="4" cy="12" r="1" fill="currentColor"/><circle cx="4" cy="18" r="1" fill="currentColor"/></svg>
            </button>
            <button class="tb-btn" data-scratch-cmd="insertOrderedList" title="Numbered list">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><text x="4" y="7.5" font-size="7" font-weight="600" fill="currentColor" stroke="none" font-family="system-ui">1</text><text x="4" y="13.5" font-size="7" font-weight="600" fill="currentColor" stroke="none" font-family="system-ui">2</text><text x="4" y="19.5" font-size="7" font-weight="600" fill="currentColor" stroke="none" font-family="system-ui">3</text></svg>
            </button>
            <button class="tb-btn" data-scratch-action="link" title="Insert link">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
            </button>
            <button class="tb-btn tb-highlight" data-scratch-action="highlight" title="Highlight" style="background:var(--highlight-yellow);border-radius:var(--r-sm)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
            </button>
          </div>
          <div class="tb-group">
            <button class="tb-btn" data-scratch-cmd="indent" title="Indent">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="8" x2="21" y2="8"/><line x1="9" y1="12" x2="21" y2="12"/><line x1="9" y1="16" x2="21" y2="16"/><polyline points="3 12 6 14 3 16"/></svg>
            </button>
            <button class="tb-btn" data-scratch-cmd="outdent" title="Outdent">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="8" x2="21" y2="8"/><line x1="9" y1="12" x2="21" y2="12"/><line x1="9" y1="16" x2="21" y2="16"/><polyline points="6 12 3 14 6 16"/></svg>
            </button>
          </div>
        </div>
        <div class="ne-text" id="scratchContentEditable" contenteditable="true" data-placeholder="Brain dump here...">${saved}</div>
      </div>
    </div>
  `;
  // Wire toolbar (fresh each render — toolbar DOM is re-created)
  const toolbar = el.querySelector('.ne-toolbar');
  if (toolbar) {
    toolbar.addEventListener('mousedown', e => {
      const btn = e.target.closest('.tb-btn');
      if (!btn) return;
      if (btn.dataset.scratchCmd) { scratchCmd(e, btn.dataset.scratchCmd); return; }
      const action = btn.dataset.scratchAction;
      if (action === 'checklist') scratchInsertChecklist(e);
      else if (action === 'link')  scratchInsertLink(e);
      else if (action === 'highlight') scratchHighlight(e);
    });
    const sel = toolbar.querySelector('select[data-scratch-heading]');
    if (sel) sel.addEventListener('change', e => scratchHeading(e.target.value));
  }
  // Wire paste handler (same sanitization as notes)
  const ce = document.getElementById('scratchContentEditable');
  if (ce) {
    ce.addEventListener('input', onScratchContentChange);
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
  document.execCommand('insertHTML', false, '<div class="note-checklist-item"><input type="checkbox"> <span>' + label.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</span></div>');
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

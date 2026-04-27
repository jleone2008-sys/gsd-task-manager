/* ══════ QUILL EDITOR INITIALIZATION ══════
   Shared helpers for the Notes and Scratch editors. Quill 2.x is loaded
   via CDN as a UMD bundle (see <script> tag in app.html / beta/app.html);
   `window.Quill` is the global. This module exposes:

   - renderCustomToolbar(toolbarId) — HTML string for the in-house toolbar
       (custom SVG icons; Quill drives behavior via .ql-bold / .ql-italic /
       .ql-list etc. classes on the buttons).
   - createQuillEditor(container, opts) — instantiate Quill on a div, wire
       it up to a custom toolbar element if `opts.toolbarContainer` is set,
       and register handlers for highlight + undo + redo.
   - migrateLegacyChecklistHTML(html) — one-time transform for old
       <div class="note-checklist-item"> markup so existing notes render
       correctly under Quill's TaskList format. Transform-on-read; the
       data is only mutated when the user next saves.
*/

const HIGHLIGHT_COLOR = '#fef08a';

function quillToolbarHandlers() {
  return {
    highlight: function () {
      const range = this.quill.getSelection(true);
      if (!range) return;
      const cur = this.quill.getFormat(range).background;
      this.quill.format('background', cur ? false : HIGHLIGHT_COLOR, 'user');
    },
    undo: function () { this.quill.history.undo(); },
    redo: function () { this.quill.history.redo(); },
  };
}

function createQuillEditor(editorContainer, opts = {}) {
  if (typeof Quill === 'undefined') {
    console.error('[quill] global Quill not loaded — check the CDN <script> tag');
    return null;
  }
  const toolbar = opts.toolbarContainer
    ? { container: opts.toolbarContainer, handlers: quillToolbarHandlers() }
    : false;
  return new Quill(editorContainer, {
    theme: 'snow',
    placeholder: opts.placeholder || '',
    modules: { toolbar },
  });
}

function renderCustomToolbar(toolbarId) {
  const undoSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>';
  const redoSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.13-9.36L23 10"/></svg>';
  const boldSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 4h8a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"/><path d="M6 12h9a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"/></svg>';
  const italicSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="19" y1="4" x2="10" y2="4"/><line x1="14" y1="20" x2="5" y2="20"/><line x1="15" y1="4" x2="9" y2="20"/></svg>';
  const underlineSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 3v7a6 6 0 0 0 6 6 6 6 0 0 0 6-6V3"/><line x1="4" y1="21" x2="20" y2="21"/></svg>';
  const checklistSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="6" height="6" rx="1"/><path d="M5 8l1.5 1.5L9 6"/><line x1="12" y1="8" x2="21" y2="8"/><rect x="3" y="14" width="6" height="6" rx="1"/><line x1="12" y1="17" x2="21" y2="17"/></svg>';
  const bulletSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1" fill="currentColor"/><circle cx="4" cy="12" r="1" fill="currentColor"/><circle cx="4" cy="18" r="1" fill="currentColor"/></svg>';
  const numberSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><text x="4" y="7.5" font-size="7" font-weight="600" fill="currentColor" stroke="none" font-family="system-ui">1</text><text x="4" y="13.5" font-size="7" font-weight="600" fill="currentColor" stroke="none" font-family="system-ui">2</text><text x="4" y="19.5" font-size="7" font-weight="600" fill="currentColor" stroke="none" font-family="system-ui">3</text></svg>';
  const linkSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';
  const highlightSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>';
  const indentSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="8" x2="21" y2="8"/><line x1="9" y1="12" x2="21" y2="12"/><line x1="9" y1="16" x2="21" y2="16"/><polyline points="3 12 6 14 3 16"/></svg>';
  const outdentSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="8" x2="21" y2="8"/><line x1="9" y1="12" x2="21" y2="12"/><line x1="9" y1="16" x2="21" y2="16"/><polyline points="6 12 3 14 6 16"/></svg>';
  return `
    <div class="ne-toolbar" id="${toolbarId}">
      <div class="tb-group tb-desktop-only">
        <button class="tb-btn ql-undo" type="button" title="Undo">${undoSvg}</button>
        <button class="tb-btn ql-redo" type="button" title="Redo">${redoSvg}</button>
      </div>
      <div class="tb-group">
        <button class="tb-btn ql-bold" type="button" title="Bold">${boldSvg}</button>
        <button class="tb-btn ql-italic" type="button" title="Italic">${italicSvg}</button>
        <button class="tb-btn ql-underline" type="button" title="Underline">${underlineSvg}</button>
      </div>
      <div class="tb-group">
        <button class="tb-btn ql-list" value="check" type="button" title="Checklist">${checklistSvg}</button>
        <button class="tb-btn ql-list" value="bullet" type="button" title="Bullet list">${bulletSvg}</button>
        <button class="tb-btn ql-list" value="ordered" type="button" title="Numbered list">${numberSvg}</button>
        <button class="tb-btn ql-link" type="button" title="Insert link">${linkSvg}</button>
        <button class="tb-btn tb-highlight ql-highlight" type="button" title="Highlight" style="background:var(--highlight-yellow);border-radius:var(--r-sm)">${highlightSvg}</button>
      </div>
      <div class="tb-group">
        <button class="tb-btn ql-indent" value="+1" type="button" title="Indent">${indentSvg}</button>
        <button class="tb-btn ql-indent" value="-1" type="button" title="Outdent">${outdentSvg}</button>
      </div>
    </div>`;
}

/**
 * Convert legacy checklist markup to Quill's check-list format.
 *
 * Input shape (what the old editor stored):
 *   <div class="note-checklist-item"><input type="checkbox" [checked]>
 *     <span>label</span>
 *   </div>
 *
 * Output shape (what Quill renders for `list: 'check'`):
 *   <ol>
 *     <li data-list="checked|unchecked">label</li>
 *   </ol>
 *
 * Consecutive legacy items collapse into a single <ol>.
 */
function migrateLegacyChecklistHTML(html) {
  if (!html || typeof html !== 'string' || !html.includes('note-checklist-item')) {
    return html;
  }
  const tmp = document.createElement('div');
  tmp.innerHTML = html;

  const items = Array.from(tmp.querySelectorAll('.note-checklist-item'));
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item)) continue;
    const run = [item]; seen.add(item);
    let next = item.nextElementSibling;
    while (next && next.classList && next.classList.contains('note-checklist-item')) {
      run.push(next); seen.add(next);
      next = next.nextElementSibling;
    }
    const ol = document.createElement('ol');
    for (const div of run) {
      const checkbox = div.querySelector('input[type="checkbox"]');
      const label = div.querySelector('span');
      const li = document.createElement('li');
      li.setAttribute('data-list', checkbox && checkbox.checked ? 'checked' : 'unchecked');
      li.textContent = (label ? label.textContent : div.textContent || '').trim();
      ol.appendChild(li);
    }
    run[0].replaceWith(ol);
    for (let i = 1; i < run.length; i++) run[i].remove();
  }
  return tmp.innerHTML;
}

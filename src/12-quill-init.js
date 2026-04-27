/* ══════ QUILL EDITOR INITIALIZATION ══════
   Shared helpers for the Notes and Scratch editors. Quill 2.x is loaded
   via CDN as a UMD bundle (see <script> tag in app.html / beta/app.html);
   `window.Quill` is the global. This module exposes:

   - QUILL_TOOLBAR — toolbar config used by both editors
   - createQuillEditor(container, opts) — instantiate one
   - migrateLegacyChecklistHTML(html) — one-time transform for old
       <div class="note-checklist-item"> markup so existing notes render
       correctly under Quill's TaskList format. Transform-on-read; the
       data is only mutated when the user next saves.
*/

const QUILL_TOOLBAR = [
  [{ header: [1, 2, 3, false] }],
  ['bold', 'italic', 'underline'],
  [{ list: 'bullet' }, { list: 'ordered' }, { list: 'check' }],
  [{ indent: '-1' }, { indent: '+1' }],
  ['blockquote', 'link'],
  ['clean'],
];

function createQuillEditor(container, opts = {}) {
  if (typeof Quill === 'undefined') {
    console.error('[quill] global Quill not loaded — check the CDN <script> tag');
    return null;
  }
  return new Quill(container, {
    theme: 'snow',
    placeholder: opts.placeholder || '',
    modules: {
      toolbar: opts.toolbar || QUILL_TOOLBAR,
    },
  });
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
 *   <ul data-checked="true|false">
 *     <li>label</li>
 *   </ul>
 *
 * Consecutive legacy items collapse into a single <ul>, but since the old
 * format mixed checked + unchecked freely we use Quill's per-item
 * data-list attribute instead — Quill 2 accepts both `<ul data-checked>`
 * and `<li data-list="checked|unchecked">`. We emit the latter inside an
 * <ol> wrapper because that's what Quill's getSemanticHTML() round-trips.
 */
function migrateLegacyChecklistHTML(html) {
  if (!html || typeof html !== 'string' || !html.includes('note-checklist-item')) {
    return html;
  }
  const tmp = document.createElement('div');
  tmp.innerHTML = html;

  // Walk in source order. Whenever we hit a .note-checklist-item, scoop up
  // it and any consecutive sibling items into a single <ol> wrapper.
  const items = Array.from(tmp.querySelectorAll('.note-checklist-item'));
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item)) continue;
    // Build the run of consecutive items
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

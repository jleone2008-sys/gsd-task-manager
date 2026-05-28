/* ══════════════════════════════════════════════════════════════
   BRAIN — knowledge upload + documents render
   Phase 6, Commits 5-6.

   Commit 5: upload affordance — POST to background ingest
   function, poll knowledge_documents.status, surface result.

   Commit 6: documents render — load knowledge_documents on app
   ready, render them as cards above the existing notes list.
   Tap to expand inline (summary + key facts + actions). Delete
   affordance for cleanup of failed/old docs.

   Doesn't touch the existing Notes data layer or UI. Lives next
   to it in the same tab.
══════════════════════════════════════════════════════════════ */

(function () {
  // ── State ───────────────────────────────────────────────────────────
  // In-memory cache of the user's knowledge documents.
  let _brainDocs = [];
  let _brainDocsLoading = false;
  let _brainExpandedId = null;   // which doc detail is currently open

  // Cap incoming files to keep us under Netlify's 6 MB body limit
  // (after base64 expansion that's ~4.5 MB on the wire).
  const BRAIN_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;

  // ── Bootstrap ───────────────────────────────────────────────────────
  function _onReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      setTimeout(fn, 0);
    }
  }

  _onReady(() => {
    wireUploadButton();
    // Wait for currentUser to be set by the auth flow before loading.
    waitForUser().then(() => loadBrainDocuments());
  });

  // Polls window.currentUser until set (auth flow populates it
  // asynchronously). Bails after 10 seconds — if no user by then,
  // we're on the auth screen and the Brain tab isn't visible anyway.
  async function waitForUser() {
    const start = Date.now();
    while (Date.now() - start < 10_000) {
      if (typeof currentUser !== 'undefined' && currentUser?.id) return;
      await new Promise(r => setTimeout(r, 250));
    }
  }

  // ── Upload button wiring ────────────────────────────────────────────
  function wireUploadButton() {
    const btn   = document.getElementById('brainUploadBtn');
    const input = document.getElementById('brainUploadInput');
    if (!btn || !input) return;

    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      input.click();
    });

    // "+ Note" — replaces the global FAB on Insights (FAB slot is now
    // the chat button). Calls into the shared createNote() flow.
    const newNote = document.getElementById('newNoteBtn');
    if (newNote && !newNote._wired) {
      newNote._wired = true;
      newNote.addEventListener('click', () => {
        if (typeof createNote === 'function') createNote();
      });
    }

    // "Scratchpad" — replaces the floating-scratch FAB. Same handler as
    // the Home tab Quick Notes shortcut.
    const scratchBtn = document.getElementById('scratchpadBtn');
    if (scratchBtn && !scratchBtn._wired) {
      scratchBtn._wired = true;
      scratchBtn.addEventListener('click', () => {
        if (typeof openQuickNotesModal === 'function') openQuickNotesModal();
      });
    }

    // Inline search bar — replaces the floating-search FAB on Insights.
    // Wires straight into the existing noteSearchQuery + renderNoteList
    // (defined in src/04-tasks-ui.js) so filtering matches the old flow.
    const searchInput = document.getElementById('insightsSearchInput');
    if (searchInput && !searchInput._wired) {
      searchInput._wired = true;
      searchInput.addEventListener('input', (e) => {
        const val = (e.target.value || '').trim();
        // noteSearchQuery is declared with `let` in src/06-notes.js
        // and is in the shared classic-script scope.
        // eslint-disable-next-line no-undef
        noteSearchQuery = val;
        if (typeof renderNoteList === 'function') renderNoteList();
      });
    }

    input.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      input.value = '';   // reset so picking same file re-fires change
      if (!file) return;
      await handleBrainFileSelected(file);
    });

    // Phase 6 Commit 7: doc cards now live inside the unified
    // timeline in #nlScroll (not the standalone #brainDocsList).
    // Delegate at the document level so the handler catches clicks
    // regardless of where the card is mounted. Filters at the top
    // to avoid running on non-doc clicks.
    document.addEventListener('click', onBrainDocsClick);
  }

  // ── Documents load + render ─────────────────────────────────────────
  async function loadBrainDocuments() {
    if (_brainDocsLoading) return;
    _brainDocsLoading = true;
    try {
      const { data, error } = await db.from('knowledge_documents')
        .select('id, kind, title, ai_summary, ai_key_facts, status, failure_reason, uploaded_at, storage_path')
        .order('uploaded_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      _brainDocs = data || [];
      renderBrainDocuments();
    } catch (e) {
      console.warn('[brain] loadDocuments failed', e);
    } finally {
      _brainDocsLoading = false;
    }
  }

  function renderBrainDocuments() {
    // Phase 6 Commit 7: the standalone Documents section is now
    // hidden — documents live inside the unified timeline in
    // .nl-scroll (rendered by renderBrainUnifiedList below).
    // Trigger that re-render whenever brain state changes.
    const section = document.getElementById('brainDocsSection');
    if (section) section.style.display = 'none';
    if (typeof renderNoteList === 'function') {
      try { renderNoteList(); } catch (_) {}
    }
  }

  // Phase 6 Commit 7 — unified Variation B timeline. Called by
  // src/06-notes.js renderNoteList AFTER it's done its filter +
  // bulk-bar setup. Receives the filtered notes list and the
  // target element (#nlScroll). Merges with _brainDocs, sorts by
  // date desc, groups by relative time bucket, renders.
  function renderBrainUnifiedList(el, notes) {
    if (!el) return;

    // Build a unified list of typed items, normalized to {type, date, raw}.
    const items = [];
    for (const n of (notes || [])) {
      const date = n.updatedAt || n.createdAt;
      if (!date) continue;
      items.push({ type: 'note', date: new Date(date).getTime(), raw: n });
    }
    for (const d of _brainDocs) {
      const date = d.uploaded_at;
      if (!date) continue;
      items.push({ type: 'doc', date: new Date(date).getTime(), raw: d });
    }
    items.sort((a, b) => b.date - a.date);

    if (!items.length) {
      el.innerHTML = renderUnifiedEmptyState();
      return;
    }

    // Group by bucket. Keys: 'today', 'this-week', 'last-week',
    // 'this-month', '<YYYY-MM>'.
    const buckets = bucketItems(items);
    let html = '';
    for (const b of buckets) {
      html += `<div class="brain-tl-section-h">${escapeHtml(b.label)}</div>`;
      html += b.items.map(it => it.type === 'note' ? renderNoteCard(it.raw) : renderDocCardInline(it.raw)).join('');
    }
    el.innerHTML = html;
  }

  function renderUnifiedEmptyState() {
    return `<div class="brain-empty">
      <div class="brain-empty-icon">🧠</div>
      <div class="brain-empty-title">Your Brain is empty</div>
      <div class="brain-empty-hint">Upload a document or create your first note to get started.</div>
    </div>`;
  }

  function bucketItems(items) {
    const now = Date.now();
    const day = DAY_MS;
    const startOfToday = (() => { const d = new Date(); d.setHours(0,0,0,0); return d.getTime(); })();
    const startOfWeek  = startOfToday - (new Date().getDay()) * day;     // Sun-start week
    const startOfLastWeek = startOfWeek - 7 * day;
    const startOfMonth = (() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); })();

    const buckets = new Map();   // key -> { label, order, items[] }
    function ensure(key, label, order) {
      if (!buckets.has(key)) buckets.set(key, { label, order, items: [] });
      return buckets.get(key);
    }

    for (const it of items) {
      let key, label, order;
      if (it.date >= startOfToday) {
        key = 'today'; label = 'Today'; order = 0;
      } else if (it.date >= startOfWeek) {
        key = 'this-week'; label = 'This week'; order = 1;
      } else if (it.date >= startOfLastWeek) {
        key = 'last-week'; label = 'Last week'; order = 2;
      } else if (it.date >= startOfMonth) {
        key = 'this-month'; label = 'Earlier this month'; order = 3;
      } else {
        const d = new Date(it.date);
        const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        key = ym;
        label = d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
        // Order older months by reverse YYYY-MM string so newer months come first.
        order = 100 + (9999 - d.getFullYear()) * 12 + (12 - d.getMonth());
      }
      ensure(key, label, order).items.push(it);
    }

    return Array.from(buckets.values()).sort((a, b) => a.order - b.order);
  }

  function renderNoteCard(n) {
    // Preserve the existing notes click + drag affordances so the
    // existing handlers in src/06-notes.js keep working unchanged.
    const isActive = (typeof activeNoteId !== 'undefined' && activeNoteId === n.id);
    const active = isActive ? ' is-active' : '';
    const preview = (n.content || '').replace(/<[^>]+>/g, '').slice(0, 180).trim();
    const date = formatRelTime(n.updatedAt || n.createdAt);
    // Notebook chip — looks up the note's notebook for the tag-like
    // pill (Personal / People / Work / etc.) shown in the legacy card.
    let nbChip = '';
    if (n.notebookId && typeof notebooksArr !== 'undefined') {
      const nb = notebooksArr.find(x => x.id === n.notebookId);
      if (nb) {
        const tone = toneForNotebookColor(nb.color);
        nbChip = `<span class="chip chip--${tone}">${escapeHtml(nb.name)}</span>`;
      }
    }
    return `<div class="nl-item brain-tl-card brain-tl-note${active}" data-notes-action="note-click" data-note-id="${escapeHtml(n.id)}" draggable="true" data-notes-ctx="note">
      <div class="brain-tl-card-icon">📝</div>
      <div class="brain-tl-card-body">
        <div class="brain-tl-card-title">${escapeHtml(n.title || 'Untitled')}</div>
        ${preview ? `<div class="brain-tl-card-facts">${escapeHtml(preview)}</div>` : ''}
        <div class="brain-tl-card-meta">
          ${nbChip}
          <span>${escapeHtml(date)}</span>
        </div>
      </div>
    </div>`;
  }

  // Map notebook color string to a chip-tone class. Mirrors the
  // toneFor function in src/06-notes.js renderNoteList so chip
  // colors stay consistent with the rest of the notes UI.
  function toneForNotebookColor(color) {
    const c = (color || '').toLowerCase();
    if (c.includes('blue') || c.includes('sky'))    return 'sky';
    if (c.includes('green') || c.includes('moss'))  return 'moss';
    if (c.includes('purple') || c.includes('lilac'))return 'lilac';
    if (c.includes('yellow') || c.includes('top3')) return 'ochre';
    if (c.includes('coral') || c.includes('danger'))return 'guava';
    return 'slate';
  }

  // Document card inside the unified timeline. Same data-brain-doc-id
  // hook as the standalone docs card so the existing click handler
  // (toggle expand / collapse / delete) keeps working.
  function renderDocCardInline(doc) {
    const isExpanded = _brainExpandedId === doc.id;
    const cls = ['nl-item', 'brain-tl-card', 'brain-tl-doc'];
    if (doc.status === 'processing') cls.push('is-processing');
    if (doc.status === 'failed')     cls.push('is-failed');
    if (isExpanded)                  cls.push('is-expanded');

    const icon = kindIcon(doc.kind);
    const factsArr = Array.isArray(doc.ai_key_facts) ? doc.ai_key_facts : [];
    const factsLine = factsArr.length
      ? factsArr.slice(0, 2).map(escapeHtml).join(' · ')
      : (doc.ai_summary ? escapeHtml(doc.ai_summary.slice(0, 180)) : '');
    const statusBadge = `<span class="b-doc-status is-${doc.status}">${doc.status}</span>`;
    const detailHtml = isExpanded ? renderDocDetail(doc) : '';

    return `<div class="${cls.join(' ')}" data-brain-doc-id="${escapeHtml(doc.id)}">
      <div class="brain-tl-card-icon">${icon}</div>
      <div class="brain-tl-card-body">
        <div class="brain-tl-card-title">${escapeHtml(doc.title || 'Untitled')}</div>
        ${factsLine ? `<div class="brain-tl-card-facts">${factsLine}</div>` : ''}
        <div class="brain-tl-card-meta">
          ${statusBadge}<span>·</span><span>${escapeHtml(formatRelTime(doc.uploaded_at))}</span>
          <span>·</span><span>${escapeHtml(kindLabel(doc.kind))}</span>
        </div>
      </div>
      ${detailHtml}
    </div>`;
  }

  // Expose so src/06-notes.js renderNoteList can call it.
  window.renderBrainUnifiedList = renderBrainUnifiedList;

  function renderDocCard(doc) {
    const isExpanded = _brainExpandedId === doc.id;
    const icon = kindIcon(doc.kind);
    const cls = ['brain-doc-card'];
    if (doc.status === 'processing') cls.push('is-processing');
    if (doc.status === 'failed')     cls.push('is-failed');
    if (isExpanded)                  cls.push('is-expanded');

    const statusBadge = `<span class="b-doc-status is-${doc.status}">${doc.status}</span>`;
    const facts = (Array.isArray(doc.ai_key_facts) && doc.ai_key_facts.length)
      ? doc.ai_key_facts.slice(0, 2).map(escapeHtml).join(' · ')
      : (doc.ai_summary ? escapeHtml(doc.ai_summary.slice(0, 180)) : '');
    const factsHtml = facts ? `<div class="brain-doc-facts">${facts}</div>` : '';

    const uploadedAt = formatRelTime(doc.uploaded_at);

    const detailHtml = isExpanded ? renderDocDetail(doc) : '';

    return `
      <div class="${cls.join(' ')}" data-brain-doc-id="${escapeHtml(doc.id)}">
        <div class="brain-doc-icon">${icon}</div>
        <div class="brain-doc-body">
          <div class="brain-doc-title">${escapeHtml(doc.title || 'Untitled')}</div>
          ${factsHtml}
          <div class="brain-doc-meta">
            ${statusBadge}
            <span>·</span>
            <span>${escapeHtml(uploadedAt)}</span>
            <span>·</span>
            <span>${escapeHtml(kindLabel(doc.kind))}</span>
          </div>
        </div>
        ${detailHtml}
      </div>`;
  }

  function renderDocDetail(doc) {
    let body = '';
    if (doc.status === 'failed') {
      body = `<div class="brain-doc-summary"><strong>Failed:</strong> ${escapeHtml(doc.failure_reason || 'Unknown error.')}</div>`;
    } else if (doc.status === 'processing') {
      body = `<div class="brain-doc-summary">Still processing… The background task can take up to 60s for large PDFs. Refresh in a minute.</div>`;
    } else {
      if (doc.ai_summary) {
        body += `<div class="brain-doc-summary">${escapeHtml(doc.ai_summary)}</div>`;
      }
      if (Array.isArray(doc.ai_key_facts) && doc.ai_key_facts.length) {
        body += `<ul class="brain-doc-keyfacts">${doc.ai_key_facts.map(f => `<li>${escapeHtml(f)}</li>`).join('')}</ul>`;
      }
    }
    return `<div class="brain-doc-detail">
      ${body}
      <div class="brain-doc-actions">
        <button data-brain-action="collapse">Collapse</button>
        <button data-brain-action="delete" class="is-destructive">Delete</button>
      </div>
    </div>`;
  }

  // ── Card click delegation ───────────────────────────────────────────
  function onBrainDocsClick(e) {
    // Bail fast for non-doc clicks (this handler is document-level).
    const card = e.target.closest('[data-brain-doc-id]');
    if (!card) return;
    const actionBtn = e.target.closest('[data-brain-action]');
    const docId = card.dataset.brainDocId;

    if (actionBtn) {
      e.stopPropagation();
      const action = actionBtn.dataset.brainAction;
      if (action === 'collapse') {
        _brainExpandedId = null;
        renderBrainDocuments();
      } else if (action === 'delete') {
        deleteBrainDocument(docId);
      }
      return;
    }

    // Tap on card body — toggle expand.
    _brainExpandedId = (_brainExpandedId === docId) ? null : docId;
    renderBrainDocuments();
  }

  async function deleteBrainDocument(docId) {
    const doc = _brainDocs.find(d => d.id === docId);
    if (!doc) return;
    const ok = confirm(`Delete "${doc.title}"? This removes the document, all its chunks, and any extracted lab results. Cannot be undone.`);
    if (!ok) return;
    try {
      // 1. Delete the Storage object if we have a path
      if (doc.storage_path) {
        await db.storage.from('knowledge').remove([doc.storage_path])
          .catch(err => console.warn('[brain] storage remove failed (continuing):', err));
      }
      // 2. Delete the document row. The schema's ON DELETE CASCADE on
      //    knowledge_chunks.document_id AND health_lab_results.source_document_id
      //    means chunks + lab rows go too.
      const { error } = await db.from('knowledge_documents')
        .delete()
        .eq('id', docId);
      if (error) throw error;
      // 3. Update local state + rerender
      _brainDocs = _brainDocs.filter(d => d.id !== docId);
      if (_brainExpandedId === docId) _brainExpandedId = null;
      renderBrainDocuments();
    } catch (err) {
      console.error('[brain] delete failed:', err);
      alert('Delete failed: ' + (err.message || err));
    }
  }

  // ── Upload handler ──────────────────────────────────────────────────
  async function handleBrainFileSelected(file) {
    const btn = document.getElementById('brainUploadBtn');
    if (file.size > BRAIN_UPLOAD_MAX_BYTES) {
      setBrainStatus('error',
        'File too large',
        `${formatBytes(file.size)} exceeds the 4 MB upload cap. Try a smaller PDF, or compress the image.`);
      return;
    }

    const kind = detectKind(file);
    if (!kind) {
      setBrainStatus('error', 'Unsupported file', `Type ${file.type || '(unknown)'} not supported. Use PDF or image.`);
      return;
    }

    const title = file.name.replace(/\.[^.]+$/, '') || 'Untitled';

    if (btn) btn.disabled = true;
    setBrainStatus('busy', `Uploading ${file.name}…`, `${formatBytes(file.size)} · ${kind}`);

    const documentId = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : fallbackUuid();

    try {
      const base64 = await fileToBase64(file);

      const { data: { session } } = await db.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error('not_signed_in');

      const res = await fetch('/.netlify/functions/beta-knowledge-ingest-background', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({
          document_id:    documentId,
          kind,
          title,
          content_base64: base64,
          filename:       file.name,
          media_type:     file.type || undefined,
          metadata:       { original_size_bytes: file.size },
        }),
      });

      if (res.status !== 202 && !res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.detail || body?.error || `http_${res.status}`);
      }

      // Insert a placeholder in the docs list immediately so the user
      // sees "Processing…" while the background job runs. Polling
      // updates the same row in place.
      _brainDocs = [{
        id: documentId,
        kind, title,
        status: 'processing',
        ai_summary: null,
        ai_key_facts: null,
        uploaded_at: new Date().toISOString(),
        storage_path: null,
      }, ..._brainDocs];
      renderBrainDocuments();

      setBrainStatus('busy', `Processing ${file.name}…`, 'Extracting text, embedding chunks, generating summary. PDFs can take up to 60s.');

      const result = await pollDocumentStatus(documentId, 180_000);
      if (result.status === 'ready') {
        setBrainStatus('ready', `Ready: ${file.name}`, buildReadyFacts(result));
        await loadBrainDocuments();   // refresh the list with the final row
      } else if (result.status === 'failed') {
        setBrainStatus('error', `Failed to process ${file.name}`, result.failure_reason || 'See server logs.');
        await loadBrainDocuments();
      } else {
        // timeout — leave the placeholder + show a hint
        setBrainStatus('error', 'Still processing…', `Background task is taking longer than expected. Tap the card to expand, or refresh in a minute.`);
      }
    } catch (err) {
      console.error('[brain] upload failed:', err);
      setBrainStatus('error', 'Upload failed', String(err.message || err));
      // Remove the optimistic placeholder if we added one
      _brainDocs = _brainDocs.filter(d => d.id !== documentId);
      renderBrainDocuments();
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function pollDocumentStatus(documentId, budgetMs) {
    const start = Date.now();
    const INTERVAL = 3000;
    while (Date.now() - start < budgetMs) {
      const { data, error } = await db.from('knowledge_documents')
        .select('id, status, failure_reason, ai_summary, ai_key_facts, kind, title')
        .eq('id', documentId)
        .maybeSingle();
      if (error) {
        console.warn('[brain] poll error', error);
      } else if (data) {
        // Patch local state with whatever just came back so the card
        // reflects partial progress.
        const idx = _brainDocs.findIndex(d => d.id === documentId);
        if (idx >= 0) _brainDocs[idx] = { ..._brainDocs[idx], ...data };
        renderBrainDocuments();
        if (data.status === 'ready' || data.status === 'failed') return data;
      }
      await new Promise(r => setTimeout(r, INTERVAL));
    }
    return { status: 'timeout' };
  }

  function buildReadyFacts(doc) {
    const parts = [];
    if (Array.isArray(doc.ai_key_facts) && doc.ai_key_facts.length) {
      parts.push(doc.ai_key_facts[0]);
    } else if (doc.ai_summary) {
      parts.push(doc.ai_summary.slice(0, 140));
    }
    parts.push('Searchable now.');
    return parts.join(' · ');
  }

  // ── Helpers ─────────────────────────────────────────────────────────
  function kindIcon(kind) {
    if (kind === 'lab')   return '🩺';
    if (kind === 'pdf')   return '📄';
    if (kind === 'image') return '🖼️';
    if (kind === 'text')  return '📝';
    return '📄';
  }
  function kindLabel(kind) {
    if (kind === 'lab')   return 'Lab panel';
    if (kind === 'pdf')   return 'PDF';
    if (kind === 'image') return 'Image';
    if (kind === 'text')  return 'Note';
    return 'Document';
  }

  function detectKind(file) {
    if (file.type === 'application/pdf') return 'pdf';
    if (file.type && file.type.startsWith('image/')) return 'image';
    const name = (file.name || '').toLowerCase();
    if (name.endsWith('.pdf')) return 'pdf';
    if (/\.(jpe?g|png|gif|webp|heic)$/.test(name)) return 'image';
    return null;
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => {
        const url = r.result;
        if (typeof url !== 'string') return reject(new Error('reader_not_string'));
        const idx = url.indexOf(',');
        if (idx < 0) return reject(new Error('no_base64_delimiter'));
        resolve(url.slice(idx + 1));
      };
      r.onerror = () => reject(r.error || new Error('reader_failed'));
      r.readAsDataURL(file);
    });
  }

  function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  function formatRelTime(iso) {
    if (!iso) return '';
    const then = new Date(iso).getTime();
    const now = Date.now();
    const diff = (now - then) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function setBrainStatus(kind, titleText, metaText) {
    const el = document.getElementById('brainUploadStatus');
    if (!el) return;
    el.classList.remove('is-error', 'is-ready');
    if (kind === 'error') el.classList.add('is-error');
    if (kind === 'ready') el.classList.add('is-ready');
    el.innerHTML = `<div class="b-status-title">${escapeHtml(titleText || '')}</div>` +
                   (metaText ? `<div class="b-status-meta">${escapeHtml(metaText)}</div>` : '');
    el.style.display = '';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fallbackUuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }
})();

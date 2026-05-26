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

    input.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      input.value = '';   // reset so picking same file re-fires change
      if (!file) return;
      await handleBrainFileSelected(file);
    });

    // Delegated click handler for document card actions.
    const list = document.getElementById('brainDocsList');
    if (list) {
      list.addEventListener('click', onBrainDocsClick);
    }
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
    const section = document.getElementById('brainDocsSection');
    const list    = document.getElementById('brainDocsList');
    const countEl = document.getElementById('brainDocsCount');
    if (!section || !list) return;

    if (!_brainDocs.length) {
      section.style.display = 'none';
      return;
    }
    section.style.display = '';

    const readyCount = _brainDocs.filter(d => d.status === 'ready').length;
    if (countEl) countEl.textContent = String(readyCount);

    list.innerHTML = _brainDocs.map(renderDocCard).join('');
  }

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
    const actionBtn = e.target.closest('[data-brain-action]');
    const card = e.target.closest('[data-brain-doc-id]');
    if (!card) return;
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

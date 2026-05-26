/* ══════════════════════════════════════════════════════════════
   BRAIN — knowledge upload + (eventually) timeline
   Phase 6, Commit 5 — upload affordance only.

   This module wires the + Upload button in the Brain tab to the
   beta-knowledge-ingest Netlify function. File is read as base64
   in-browser, POSTed to the ingest endpoint, and the ingest
   pipeline does extraction + chunking + embedding + summary
   server-side.

   Scope of this commit:
     - Detect file kind (pdf | image), set the right body shape
     - Show a live status pill: "Uploading…" → "Processing…" →
       "Ready" / "Failed"
     - Log the document_id to the console for verification
       (Commit 6 ships the timeline that actually renders it)

   Doesn't touch the existing Notes data layer or UI. Lives next
   to it in the same tab.
══════════════════════════════════════════════════════════════ */

// Cap incoming files to keep us under Netlify's 6 MB body limit
// (after base64 expansion that's ~4.5 MB on the wire). PDFs and
// images larger than this need to be downsized client-side before
// upload, or we'd need a background-function path.
const BRAIN_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;   // 4 MB pre-base64

(function () {
  // Wait for DOM. The Brain elements live in app.html and exist by
  // the time defer scripts run, so DOMContentLoaded isn't required.
  // But the click handler attachment is harmless either way; wire
  // on next tick to keep load order forgiving.
  function _onReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      setTimeout(fn, 0);
    }
  }

  _onReady(() => {
    const btn   = document.getElementById('brainUploadBtn');
    const input = document.getElementById('brainUploadInput');
    if (!btn || !input) return;   // not on a page that has the Brain UI

    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      input.click();
    });

    input.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      // Reset the input so picking the same file twice still fires change.
      input.value = '';
      if (!file) return;
      await handleBrainFileSelected(file);
    });
  });

  // ── File selection handler ──────────────────────────────────────────
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

    // Default title to the filename without extension. The detail
    // panel in a future commit will let the user rename.
    const title = file.name.replace(/\.[^.]+$/, '') || 'Untitled';

    if (btn) btn.disabled = true;
    setBrainStatus('busy', `Uploading ${file.name}…`, `${formatBytes(file.size)} · ${kind}`);

    // Client-generated document_id so we can poll status without
    // waiting on the background function (which returns 202 with no
    // body). crypto.randomUUID is available in all current browsers.
    const documentId = (crypto && crypto.randomUUID) ? crypto.randomUUID() : fallbackUuid();

    try {
      // Read file as base64. FileReader → DataURL → strip prefix.
      const base64 = await fileToBase64(file);

      const { data: { session } } = await db.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error('not_signed_in');

      // POST to the BACKGROUND function (15-min timeout). It returns
      // 202 immediately with no body; we poll knowledge_documents for
      // status updates.
      const res = await fetch('/.netlify/functions/beta-knowledge-ingest-background', {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${token}`,
        },
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

      // 202 Accepted is the success path for background functions.
      // 400/401/etc still come back with a JSON body explaining why.
      if (res.status !== 202 && !res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.detail || body?.error || `http_${res.status}`);
      }

      // ── Poll until status terminal ─────────────────────────────
      setBrainStatus('busy', `Processing ${file.name}…`, 'Extracting text, embedding chunks, generating summary. PDFs with images can take up to 60s.');

      const result = await pollDocumentStatus(documentId, 180_000);   // 3-min poll budget
      if (result.status === 'ready') {
        const facts = buildReadyFacts(result);
        setBrainStatus('ready', `Ready: ${file.name}`, facts);
        console.log('[brain] document ready:', result);
      } else if (result.status === 'failed') {
        setBrainStatus('error', `Failed to process ${file.name}`, result.failure_reason || 'See server logs.');
      } else if (result.status === 'timeout') {
        setBrainStatus('error', 'Still processing…', `Background task is taking longer than expected. Refresh in a minute and check the timeline — doc id ${documentId.slice(0, 8)}.`);
      }
    } catch (err) {
      console.error('[brain] upload failed:', err);
      setBrainStatus('error', 'Upload failed', String(err.message || err));
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // Poll knowledge_documents.status for the given id every 3s, with
  // a total budget. Returns { status, failure_reason?, ... } or
  // { status: 'timeout' } if we exceed budget.
  async function pollDocumentStatus(documentId, budgetMs) {
    const start = Date.now();
    const INTERVAL = 3000;
    while (Date.now() - start < budgetMs) {
      const { data, error } = await db.from('knowledge_documents')
        .select('id, status, failure_reason, ai_summary, ai_key_facts, kind')
        .eq('id', documentId)
        .maybeSingle();
      if (error) {
        console.warn('[brain] poll error', error);
      } else if (data && (data.status === 'ready' || data.status === 'failed')) {
        return data;
      }
      await new Promise(r => setTimeout(r, INTERVAL));
    }
    return { status: 'timeout' };
  }

  function buildReadyFacts(doc) {
    const facts = [];
    if (Array.isArray(doc.ai_key_facts) && doc.ai_key_facts.length) {
      facts.push(doc.ai_key_facts[0]);   // first key fact as the headline
    } else if (doc.ai_summary) {
      facts.push(doc.ai_summary.slice(0, 140));
    }
    facts.push('Searchable now.');
    return facts.join(' · ');
  }

  function fallbackUuid() {
    // RFC4122 v4-shape fallback for old browsers. crypto.randomUUID
    // is available in Safari 15.4+ / Chrome 92+ / Firefox 95+ so this
    // path rarely fires.
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  // ── Helpers ─────────────────────────────────────────────────────────
  function detectKind(file) {
    if (file.type === 'application/pdf') return 'pdf';
    if (file.type && file.type.startsWith('image/')) return 'image';
    // Fall back on extension for browsers that don't set type reliably.
    const name = (file.name || '').toLowerCase();
    if (name.endsWith('.pdf')) return 'pdf';
    if (/\.(jpe?g|png|gif|webp|heic)$/.test(name)) return 'image';
    return null;
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => {
        const url = r.result;   // "data:<mime>;base64,<data>"
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
})();

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

    try {
      // Read file as base64. FileReader → DataURL → strip prefix.
      const base64 = await fileToBase64(file);

      setBrainStatus('busy', `Processing ${file.name}…`, 'Extracting text, embedding chunks, generating summary — this can take 10-30s for a typical PDF.');

      const { data: { session } } = await db.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error('not_signed_in');

      const res = await fetch('/.netlify/functions/beta-knowledge-ingest', {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          kind,
          title,
          content_base64: base64,
          filename: file.name,
          media_type: file.type || undefined,
          metadata: { original_size_bytes: file.size },
        }),
      });

      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detail = body?.detail || body?.error || `http_${res.status}`;
        throw new Error(detail);
      }

      if (body.status === 'failed') {
        setBrainStatus('error', `Failed to process ${file.name}`, body.error || 'See server logs.');
        return;
      }

      console.log('[brain] document ingested:', body);
      const facts = [
        body.chunks ? `${body.chunks} chunks indexed` : null,
        body.lab_results ? `${body.lab_results} lab results extracted` : null,
      ].filter(Boolean).join(' · ');
      setBrainStatus('ready',
        `Ready: ${file.name}`,
        facts || `Document ${body.document_id?.slice(0, 8)} is searchable.`);
    } catch (err) {
      console.error('[brain] upload failed:', err);
      setBrainStatus('error', 'Upload failed', String(err.message || err));
    } finally {
      if (btn) btn.disabled = false;
    }
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

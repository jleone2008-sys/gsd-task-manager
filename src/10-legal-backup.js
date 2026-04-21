
/* ═══════════════════════════════════════════════
   BACKUP & RESTORE
═══════════════════════════════════════════════ */
/* ═══════════════════════════════════════════════
   LEGAL MODAL
═══════════════════════════════════════════════ */
const LEGAL_EFFECTIVE = 'March 6, 2026';
const LEGAL_COMPANY   = 'GSD Technologies LLC';
const LEGAL_EMAIL     = 'legal@gsdtasks.com';

const LEGAL_TERMS = `
<h2>1. Agreement to Terms</h2>
<p>By accessing or using GSD Task Manager ("the Service") operated by <strong>${LEGAL_COMPANY}</strong> ("we," "us," or "our"), you agree to be bound by these Terms and Conditions. If you do not agree to these Terms, please do not use the Service.</p>
<p>These Terms were last updated on <strong>${LEGAL_EFFECTIVE}</strong>. We may update these Terms from time to time and will notify you of material changes through the Service or by email.</p>

<h2>2. Description of Service</h2>
<p>GSD Task Manager is a productivity application that allows you to create, organize, and manage tasks and to-do lists. The Service is currently provided free of charge. We reserve the right to introduce paid features in the future, and will provide advance notice before doing so.</p>

<h2>3. Your Account</h2>
<p>To use the Service, you must create an account using a valid email address or supported third-party login (such as Google). You are responsible for:</p>
<ul>
  <li>Keeping your account credentials secure and confidential</li>
  <li>All activity that occurs under your account</li>
  <li>Notifying us immediately of any unauthorized access</li>
</ul>
<p>You must be at least 13 years of age to use the Service. By using the Service, you represent that you meet this age requirement.</p>

<h2>4. Acceptable Use</h2>
<p>You agree not to use the Service to:</p>
<ul>
  <li>Violate any applicable laws or regulations</li>
  <li>Store or transmit content that is unlawful, harmful, or infringes on any third-party rights</li>
  <li>Attempt to gain unauthorized access to any part of the Service or its infrastructure</li>
  <li>Interfere with or disrupt the integrity or performance of the Service</li>
  <li>Use automated means to access the Service without our express written permission</li>
</ul>

<h2>5. Your Data</h2>
<p>You retain ownership of all tasks, notes, and content you create in the Service ("User Content"). By using the Service, you grant us a limited, non-exclusive, royalty-free license to store and process your User Content solely as necessary to provide the Service to you.</p>
<p>We do not sell, rent, or share your User Content with third parties for advertising or marketing purposes. See our Privacy Policy for full details on how we handle your data.</p>

<h2>6. Data Storage &amp; Security</h2>
<p>In the current version of the Service, task data and local backups are stored in your browser's local storage on your device. This data is not transmitted to our servers unless you are signed in with a synced account. You are responsible for maintaining backups of your own data. We are not liable for data loss resulting from browser data clearing, device changes, or local storage limitations.</p>

<h2>7. Intellectual Property</h2>
<p>The Service, including its design, code, logo, and branding, is owned by <strong>${LEGAL_COMPANY}</strong> and protected by applicable intellectual property laws. You may not copy, modify, distribute, or create derivative works from any part of the Service without our prior written consent.</p>

<h2>8. Disclaimer of Warranties</h2>
<p>The Service is provided on an "as is" and "as available" basis without warranties of any kind, either express or implied, including but not limited to warranties of merchantability, fitness for a particular purpose, or non-infringement. We do not warrant that the Service will be uninterrupted, error-free, or completely secure.</p>

<h2>9. Limitation of Liability</h2>
<p>To the fullest extent permitted by applicable law, <strong>${LEGAL_COMPANY}</strong> shall not be liable for any indirect, incidental, special, consequential, or punitive damages, including loss of data, profits, or business opportunities, arising out of or related to your use of the Service, even if we have been advised of the possibility of such damages.</p>
<p>Our total liability to you for any claims arising under these Terms shall not exceed the greater of $100 USD or the amount you paid us in the twelve months preceding the claim.</p>

<h2>10. Termination</h2>
<p>You may stop using the Service at any time. You may delete your account and all associated data through the account settings. We reserve the right to suspend or terminate access to the Service for any user who violates these Terms, with or without notice.</p>

<h2>11. Governing Law</h2>
<p>These Terms are governed by and construed in accordance with the laws of the United States, without regard to its conflict of law provisions. Any disputes arising under these Terms shall be resolved in the courts of competent jurisdiction in the United States.</p>

<h2>12. Contact</h2>
<p>If you have any questions about these Terms, please contact us at <strong>${LEGAL_EMAIL}</strong>.</p>
`;

const LEGAL_PRIVACY = `
<h2>1. Overview</h2>
<p>This Privacy Policy explains how <strong>${LEGAL_COMPANY}</strong> ("we," "us," or "our") collects, uses, and protects information when you use GSD Task Manager ("the Service"). We are committed to protecting your privacy and handling your data transparently.</p>
<p>This policy was last updated on <strong>${LEGAL_EFFECTIVE}</strong>.</p>

<h2>2. Information We Collect</h2>
<p><strong>Account information:</strong> When you create an account, we collect your email address and, if you sign in with Google, your name and profile photo as provided by Google.</p>
<p><strong>Task data:</strong> The tasks, notes, tags, and other content you create within the Service.</p>
<p><strong>Usage data:</strong> Basic analytics such as feature usage frequency, session duration, and error logs. This data is aggregated and does not identify you personally.</p>
<p><strong>Device &amp; browser data:</strong> Browser type, operating system, and IP address, used solely for security and service improvement purposes.</p>

<h2>3. How We Use Your Information</h2>
<ul>
  <li>To provide, operate, and improve the Service</li>
  <li>To authenticate your identity and maintain your account</li>
  <li>To send important service notices (e.g., security updates, policy changes)</li>
  <li>To diagnose technical problems and prevent abuse</li>
  <li>To comply with legal obligations</li>
</ul>
<p>We do not use your task content for advertising, machine learning training, or any purpose beyond providing the Service to you.</p>

<h2>4. Local Data &amp; Browser Storage</h2>
<p>GSD Task Manager stores your task data securely in your account on our servers, synced in real time across all your signed-in devices. You can download manual backups at any time from the Backup &amp; Restore menu. We strongly recommend keeping regular backups as an extra safety net.</p>

<h2>5. Data Sharing</h2>
<p>We do not sell, rent, or trade your personal information. We may share data only in the following limited circumstances:</p>
<ul>
  <li><strong>Service providers:</strong> Trusted third-party vendors who assist us in operating the Service (e.g., hosting, authentication), bound by confidentiality agreements</li>
  <li><strong>Legal requirements:</strong> When required by law, court order, or to protect the rights and safety of our users or the public</li>
  <li><strong>Business transfers:</strong> In the event of a merger, acquisition, or sale of assets, your data may be transferred as part of that transaction, with advance notice provided to you</li>
</ul>

<h2>6. Data Retention</h2>
<p>We retain your account data for as long as your account is active. If you delete your account, we will delete your personal data within 30 days, except where we are required to retain it for legal or compliance purposes. Local backups stored in your browser are managed entirely by you and are not subject to our retention controls.</p>

<h2>7. Security</h2>
<p>We implement industry-standard security measures to protect your data, including encrypted data transmission (TLS) and secure authentication. However, no method of transmission over the internet or electronic storage is 100% secure. We cannot guarantee absolute security and encourage you to use a strong, unique password.</p>

<h2>8. Your Rights</h2>
<p>Depending on your location, you may have the following rights regarding your personal data:</p>
<ul>
  <li><strong>Access:</strong> Request a copy of the personal data we hold about you</li>
  <li><strong>Correction:</strong> Request that we correct inaccurate data</li>
  <li><strong>Deletion:</strong> Request deletion of your account and associated data via account settings or by contacting us</li>
  <li><strong>Portability:</strong> Export your task data at any time using the built-in export feature</li>
  <li><strong>Objection:</strong> Object to certain uses of your data</li>
</ul>
<p>To exercise any of these rights, contact us at <strong>${LEGAL_EMAIL}</strong>.</p>

<h2>9. Children's Privacy</h2>
<p>The Service is not directed to children under the age of 13. We do not knowingly collect personal information from children under 13. If we become aware that we have inadvertently collected such information, we will take steps to delete it promptly.</p>

<h2>10. Changes to This Policy</h2>
<p>We may update this Privacy Policy from time to time. We will notify you of significant changes by posting a notice in the Service or by email. Your continued use of the Service after such changes constitutes your acceptance of the updated policy.</p>

<h2>11. Contact</h2>
<p>If you have any questions, concerns, or requests regarding this Privacy Policy, please contact us at <strong>${LEGAL_EMAIL}</strong>.</p>
`;

function openLegalModal(tab = 'terms') {
  document.getElementById('legalModal').classList.add('open');
  switchLegalTab(tab);
}

function closeLegalModal() {
  document.getElementById('legalModal').classList.remove('open');
}

function switchLegalTab(tab) {
  const isTerms = tab === 'terms';
  document.getElementById('legalTabTerms').classList.toggle('active', isTerms);
  document.getElementById('legalTabPrivacy').classList.toggle('active', !isTerms);
  document.getElementById('legalModalTitle').textContent = isTerms ? 'Terms & Conditions' : 'Privacy Policy';
  document.getElementById('legalBody').innerHTML = isTerms ? LEGAL_TERMS : LEGAL_PRIVACY;
  document.getElementById('legalBody').scrollTop = 0;
}

async function openBackupModal() {
  document.getElementById('restoreFileName').textContent = 'No file selected';
  document.getElementById('restoreFile').value = '';
  document.getElementById('backupModal').classList.add('open');
  await renderBackupDates();
}
function closeBackupModal() {
  document.getElementById('backupModal').classList.remove('open');
}
document.getElementById('backupModal').addEventListener('click', function(e) {
  if (e.target === this) closeBackupModal();
});
function exportJSON() {
  if (!tasks.length && !habitsArr.length && !notesArr.length) { alert('No data to export.'); return; }
  const data = {
    version: 4,
    exported: new Date().toISOString(),
    tasks: tasks,
    habits: habitsArr,
    habitCompletions: habitCompletions,
    notes: notesArr,
    notebooks: notebooksArr
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `gsd-backup-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
function restoreJSON(input) {
  const file = input.files[0]; if (!file) return;
  document.getElementById('restoreFileName').textContent = file.name;
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const data = JSON.parse(e.target.result);
      const restoredTasks = data.tasks || (Array.isArray(data) ? data : null);
      const restoredHabits = data.habits || [];
      const restoredCompletions = data.habitCompletions || [];
      const restoredNotes = data.notes || [];
      const restoredNotebooks = data.notebooks || [];
      if (!restoredTasks && !restoredHabits.length && !restoredNotes.length) throw new Error('Invalid format');
      const parts = [];
      if (restoredTasks && restoredTasks.length) parts.push(`${restoredTasks.length} tasks`);
      if (restoredHabits.length) parts.push(`${restoredHabits.length} habits`);
      if (restoredNotes.length) parts.push(`${restoredNotes.length} notes`);
      if (restoredNotebooks.length) parts.push(`${restoredNotebooks.length} notebooks`);
      showConfirm({
        icon: '⚠️',
        title: 'Replace all data?',
        desc: `This will load ${parts.join(' + ')} from "${file.name}" and replace your current data.`,
        confirmLabel: 'Restore',
        confirmClass: 'primary',
        onConfirm: () => {
          if (restoredTasks) { tasks = restoredTasks; save(); render(); }
          if (restoredHabits.length) { habitsArr = restoredHabits; habitCompletions = restoredCompletions; renderHabits(); saveAllHabitsToDB(); }
          if (restoredNotes.length) { notesArr = restoredNotes; renderNotes(); notesArr.forEach(n => saveNoteToDB(n)); }
          if (restoredNotebooks.length) { notebooksArr = restoredNotebooks; renderNotes(); restoredNotebooks.forEach(nb => saveNotebookToDB(nb)); }
          closeBackupModal();
          showUndoToast(`Restored ${parts.join(' + ')} from backup`);
        }
      });
    } catch(err) {
      alert('Could not read backup file. Make sure it\'s a valid GSD JSON export.');
    }
  };
  reader.readAsText(file);
}

/* ═══════════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════════ */
/* ═══════════════════════════════════════════════
   AUTO-BACKUP (Supabase, 30-day rolling)
   table: backups(user_id, date TEXT, snapshot JSONB)
═══════════════════════════════════════════════ */
const BACKUP_DAYS = 30;

async function autoBackup() {
  if (!currentUser || (!tasks.length && !habitsArr.length)) return;
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // Only write once per day — check if today's backup already exists
  const { data: existing } = await db.from('backups')
    .select('backup_date')
    .eq('user_id', currentUser.id)
    .eq('backup_date', today)
    .maybeSingle();
  if (existing) return;

  // Write today's snapshot — pass object directly, Supabase handles JSONB serialization
  await db.from('backups').upsert({
    user_id:     currentUser.id,
    backup_date: today,
    snapshot:    { tasks: tasks, habits: habitsArr, habitCompletions: habitCompletions, notes: notesArr, notebooks: notebooksArr, savedAt: new Date().toISOString() },
    task_count:  tasks.length,
  }, { onConflict: 'user_id,backup_date' });

  // Prune entries older than 30 days
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - BACKUP_DAYS);
  await db.from('backups')
    .delete()
    .eq('user_id', currentUser.id)
    .lt('backup_date', cutoff.toISOString().slice(0, 10));
}

async function getBackupDates() {
  if (!currentUser) return [];
  const { data } = await db.from('backups')
    .select('backup_date, task_count, snapshot')
    .eq('user_id', currentUser.id)
    .order('backup_date', { ascending: false });
  return (data || []).map(r => {
    const snap = typeof r.snapshot === 'string' ? JSON.parse(r.snapshot) : (r.snapshot || {});
    return { backup_date: r.backup_date, task_count: r.task_count, habit_count: snap.habits?.length || 0 };
  });
}

async function restoreFromDate(date) {
  if (!currentUser) return;
  const { data, error } = await db.from('backups')
    .select('snapshot')
    .eq('user_id', currentUser.id)
    .eq('backup_date', date)
    .maybeSingle();
  if (error || !data?.snapshot) { alert('Backup not found for ' + date); return; }
  const snap = typeof data.snapshot === 'string' ? JSON.parse(data.snapshot) : data.snapshot;
  if (!snap.tasks && !snap.habits && !snap.notes) { alert('Backup not found for ' + date); return; }
  const parts = [];
  if (snap.tasks?.length) parts.push(`${snap.tasks.length} tasks`);
  if (snap.habits?.length) parts.push(`${snap.habits.length} habits`);
  if (snap.notes?.length) parts.push(`${snap.notes.length} notes`);
  showConfirm({
    icon: '⏪',
    title: `Restore backup from ${date}?`,
    desc: `This will load ${parts.join(' + ')} from ${date} and replace your current data.`,
    confirmLabel: 'Restore',
    confirmClass: 'primary',
    onConfirm: async () => {
      if (snap.tasks) { tasks = snap.tasks; await save(); render(); }
      if (snap.habits) { habitsArr = snap.habits; habitCompletions = snap.habitCompletions || []; renderHabits(); saveAllHabitsToDB(); }
      if (snap.notes) { notesArr = snap.notes; renderNotes(); snap.notes.forEach(n => saveNoteToDB(n)); }
      if (snap.notebooks) { notebooksArr = snap.notebooks; renderNotes(); snap.notebooks.forEach(nb => saveNotebookToDB(nb)); }
      closeBackupModal();
      showUndoToast(`Restored ${parts.join(' + ')} from ${date}`);
    }
  });
}

async function renderBackupDates() {
  const el = document.getElementById('backupDateList');
  if (!el) return;
  el.innerHTML = '<div style="font-size:12px;color:var(--ink-3);padding:6px 0;">Loading…</div>';
  const dates = await getBackupDates();
  if (!dates.length) {
    el.innerHTML = '<div style="font-size:12px;color:var(--ink-3);padding:6px 0;">No auto-backups yet — one will be created on your next session.</div>';
    return;
  }
  const todayStr = new Date().toISOString().slice(0, 10);
  el.innerHTML = dates.map(({ backup_date: d, task_count: tCount, habit_count: hCount }) => {
    const label = d === todayStr ? `${d} <span style="color:var(--guava-800);font-size:10px;">today</span>` : d;
    const parts = [];
    if (tCount) parts.push(`${tCount} tasks`);
    if (hCount) parts.push(`${hCount} habits`);
    const summary = parts.length ? parts.join(', ') : 'no data';
    return `<div style="display:flex;align-items:center;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--edge);">
      <span style="font-size:12px;">${label} <span style="color:var(--ink-3);font-size:11px;">(${summary})</span></span>
      <button class="btn-sm" onclick="restoreFromDate('${d}')" style="font-size:11px;padding:3px 9px;">Restore</button>
    </div>`;
  }).join('');
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}




/* ═══════════════════════════════════════════════
   CUSTOM CONFIRM DIALOG
═══════════════════════════════════════════════ */
let _confirmResolve = null;

function showConfirm({ icon='🗑️', title='Are you sure?', desc='', confirmLabel='Confirm', confirmClass='danger', onConfirm }) {
  document.getElementById('confirmIcon').textContent = icon;
  document.getElementById('confirmTitle').textContent = title;
  document.getElementById('confirmDesc').textContent = desc;
  const btn = document.getElementById('confirmOkBtn');
  btn.textContent = confirmLabel;
  btn.className = `confirm-btn-confirm ${confirmClass}`;
  document.getElementById('confirmDialog').classList.add('open');
  _confirmResolve = onConfirm;
}

function resolveConfirm(confirmed) {
  document.getElementById('confirmDialog').classList.remove('open');
  if (confirmed && typeof _confirmResolve === 'function') _confirmResolve();
  _confirmResolve = null;
}

// Close on backdrop click
document.getElementById('confirmDialog').addEventListener('click', function(e) {
  if (e.target === this) resolveConfirm(false);
});

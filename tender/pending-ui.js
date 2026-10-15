// "Pending Correspondence Downloads" view: account panel, one-click download of every pending letter,
// live progress table, counts, retry. All values shown come from IREPS responses; text is set via textContent only.
import { downloadPendingCorrespondence } from './tender-pending.js';
import { getActiveIrepsAccountContext, ACCOUNT_UNVERIFIED_MSG } from './tender-account.js';
import { SESSION_MSG, getLogTail } from './tender-core.js';

const $ = (id) => document.getElementById(id);
const main = $('view-main');
const view = $('view-pending');
const gate = $('view-gate');

let running = false;
const rows = new Map(); // letter key / record nitOid -> <tr>

function show(open) {
  view.hidden = !open;
  if (open) {
    main.hidden = true;
    refreshAccount();
  } else if (gate.hidden) main.hidden = false;
}

function setBusy(busy) {
  running = busy;
  for (const id of ['btn-pc-run', 'btn-pc-retry', 'btn-pc-account-refresh']) $(id).disabled = busy;
  $('btn-pc-run').classList.toggle('is-busy', busy);
}

function renderAccount(a) {
  const ok = !!(a && a.authenticated && a.verified);
  $('pc-acc-connection').textContent = a?.authenticated ? 'Connected' : 'Not connected';
  $('pc-acc-company').textContent = ok || a?.companyName ? a.companyName : '—';
  $('pc-acc-unit').textContent = ok ? a.operatingUnit || 'Not stated' : '—';
  $('pc-acc-id').textContent = ok || a?.irepsAccountId ? a.irepsAccountId : '—';
  $('pc-acc-status').textContent = ok ? 'Verified' : 'Account not verified';
  $('pc-acc-status').className = ok ? 'tender-ok' : 'tender-bad';
  const w = $('pc-acc-warning');
  w.textContent = ok ? '' : a && !a.authenticated ? SESSION_MSG : ACCOUNT_UNVERIFIED_MSG;
  w.hidden = ok;
}

async function refreshAccount() {
  if (running) return;
  $('pc-acc-connection').textContent = 'Checking…';
  $('pc-acc-status').textContent = 'Checking…';
  try {
    renderAccount(await getActiveIrepsAccountContext());
  } catch (e) {
    console.error('[DocLink][Account] check failed:', e.message);
    renderAccount(null);
  }
}

function cell(tr, text, small) {
  const td = document.createElement('td');
  td.textContent = text || '';
  if (small) {
    const s = document.createElement('small');
    s.textContent = small;
    td.append(s);
  }
  tr.append(td);
  return td;
}

function fill(tr, o) {
  tr.replaceChildren();
  cell(tr, o.tenderNo, o.railway);
  cell(tr, o.letterNo, o.letterDate);
  cell(tr, o.subject);
  cell(tr, o.deadline);
  const st = cell(tr, o.status.replace(/_/g, ' '), o.note);
  st.className = `pc-st-${o.status}`;
}

function upsert(key, o) {
  let tr = rows.get(key);
  if (!tr) {
    tr = document.createElement('tr');
    rows.set(key, tr);
    $('pc-tbody').append(tr);
  }
  fill(tr, o);
}

function onEvent(ev) {
  if (ev.type === 'records') {
    $('pc-table-wrap').hidden = !ev.records.length && !ev.skipped.length;
    $('pc-counts').hidden = false;
    for (const r of ev.records) upsert(`r:${r.nitOid}`, { tenderNo: r.tenderNo, railway: r.railway, letterNo: '—', letterDate: '', subject: r.tenderTitle, deadline: r.replyDeadline, status: 'PENDING' });
    for (const [i, s] of ev.skipped.entries()) upsert(`s:${i}`, { tenderNo: s.tenderNo, railway: s.railway, letterNo: '—', subject: s.tenderTitle, deadline: s.replyDeadline, status: 'NEEDS_REVIEW', note: s.reason });
  } else if (ev.type === 'record') {
    const r = ev.record;
    // a record row is replaced by its letter rows once they exist; until then it carries the record's own state
    if (['NO_PENDING_LETTERS', 'FAILED', 'SESSION_EXPIRED', 'NEEDS_REVIEW', 'IN_PROGRESS'].includes(r.status) || !rows.has(`r:${r.nitOid}`)) {
      upsert(`r:${r.nitOid}`, { tenderNo: r.tenderNo, railway: r.railway, letterNo: '—', subject: r.tenderTitle, deadline: r.replyDeadline, status: r.status, note: r.status === 'NO_PENDING_LETTERS' ? 'No pending letters at download time' : r.error });
    }
  } else if (ev.type === 'letter') {
    const l = ev.letter;
    const rec = rows.get(`r:${l.nitOid}`);
    if (rec) { rec.remove(); rows.delete(`r:${l.nitOid}`); }
    const att = l.files.filter((f) => f.role === 'attachment' && f.status === 'DOWNLOADED').length;
    const note = [l.alreadyDownloaded ? 'already downloaded' : '', att ? `${att} attachment(s)` : '', l.status === 'FAILED' || l.status === 'NEEDS_REVIEW' ? l.error : ''].filter(Boolean).join(' · ');
    upsert(`l:${ev.key}`, { tenderNo: l.tenderNo, letterNo: l.letterNo, letterDate: l.letterDate, subject: l.subject, deadline: l.replyDeadline, status: l.status, note });
  } else if (ev.type === 'summary') {
    renderSummary(ev.summary);
  }
}

function renderSummary(s) {
  $('pc-counts').hidden = false;
  const set = (id, v) => ($(id).textContent = String(v));
  set('pc-n-records', s.pendingRecords);
  set('pc-n-letters', s.lettersDiscovered);
  set('pc-n-downloaded', `${s.lettersDownloaded}${s.alreadyDownloaded ? ` (${s.alreadyDownloaded} already saved)` : ''}`);
  set('pc-n-attachments', s.attachmentsDownloaded);
  set('pc-n-unavailable', s.unavailable);
  set('pc-n-failed', s.failed);
  set('pc-n-review', s.needsReview);
  set('pc-n-noletters', s.noPendingLetters);
  $('btn-pc-retry').hidden = !(s.failed || s.unavailable || s.sessionExpired);
}

async function run(mode) {
  if (running) return;
  $('pc-error').hidden = true;
  $('pc-empty').hidden = true;
  $('pc-tbody').replaceChildren();
  rows.clear();
  $('pc-table-wrap').hidden = true;
  setBusy(true);
  $('pc-progress').hidden = false;
  try {
    const r = await downloadPendingCorrespondence({
      mode, force: $('pc-force').checked,
      onProgress: (m) => ($('pc-progress-message').textContent = m),
      onAccount: renderAccount,
      onEvent,
    });
    renderSummary(r.summary);
    $('pc-folder').textContent = r.folder;
    $('pc-empty').hidden = !r.empty;
    if (r.aborted) {
      $('pc-error-message').textContent = `Stopped early: ${r.aborted.message}`;
      $('pc-error').hidden = false;
    }
  } catch (e) {
    $('pc-error-message').textContent = e.code === 'SESSION_EXPIRED' ? SESSION_MSG : e.code === 'ACCOUNT' ? ACCOUNT_UNVERIFIED_MSG : e.message || 'Something went wrong.';
    $('pc-error').hidden = false;
    if (e.code === 'SESSION_EXPIRED' || e.code === 'ACCOUNT') renderAccount(await getActiveIrepsAccountContext().catch(() => null));
    console.error('[DocLink][Pending] run failed:', e.code || '', e.message);
  } finally {
    $('pc-progress').hidden = true;
    setBusy(false);
  }
}

$('btn-pending-open').addEventListener('click', () => show(true));
$('btn-pc-back').addEventListener('click', () => show(false));
$('btn-pc-run').addEventListener('click', () => run('all'));
$('btn-pc-retry').addEventListener('click', () => run('retry')); // saved letters are skipped, so nothing is duplicated
$('btn-pc-account-refresh').addEventListener('click', refreshAccount);
$('btn-pc-diag').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(getLogTail() || '(no log yet)');
    $('btn-pc-diag').textContent = 'Copied';
  } catch {
    $('btn-pc-diag').textContent = 'Copy failed';
  }
  setTimeout(() => ($('btn-pc-diag').textContent = 'Copy diagnostics'), 1500);
});

const refreshIfVisible = () => !view.hidden && !running && refreshAccount();
window.addEventListener('focus', refreshIfVisible);
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && refreshIfVisible());

// If DocLink's "go to IREPS" gate takes over, keep this view out of the way.
new MutationObserver(() => {
  if (!gate.hidden) view.hidden = true;
}).observe(gate, { attributes: true, attributeFilter: ['hidden'] });

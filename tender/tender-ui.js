// "Download Tender Documents" view: account panel + automatic discovery from My Messages.
import { runAutomatic, runLetterType } from './tender-auto.js';
import { getActiveIrepsAccountContext, ACCOUNT_UNVERIFIED_MSG } from './tender-account.js';
import { SESSION_MSG, getLogTail } from './tender-core.js';
import { ECM_OUTCOME, describeEcmOutcome } from '../services/ecm-service.js';
import { describeSkip } from '../services/download-log.js';

const $ = (id) => document.getElementById(id);
const main = $('view-main');
const view = $('view-tender');
const gate = $('view-gate');

let running = false;
let lastIds = [];

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const fromIso = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };

function show(open) {
  view.hidden = !open;
  if (open) {
    main.hidden = true;
    if (!$('auto-from').value) { $('auto-from').value = iso(new Date()); $('auto-to').value = iso(new Date()); }
    refreshAccount();
  } else if (gate.hidden) main.hidden = false;
}

function setBusy(busy) {
  running = busy;
  $('btn-auto-run').disabled = busy;
  $('btn-auto-retry').disabled = busy;
  document.querySelectorAll('[data-status]').forEach((b) => { b.disabled = busy; });
  $('btn-account-refresh').disabled = busy;
  $('btn-auto-run').classList.toggle('is-busy', busy);
}

// ---------------------------------------------------------------- account panel

/** Render a detected (or failed) account context. Nothing here is assumed: every value is from IREPS. */
export function renderAccount(a) {
  const ok = !!(a && a.authenticated && a.verified);
  $('acc-connection').textContent = a ? (a.authenticated ? 'Connected' : 'Not connected') : 'Not connected';
  $('acc-company').textContent = ok || a?.companyName ? a.companyName : '—';
  $('acc-unit').textContent = ok ? a.operatingUnit || 'Not stated' : '—';
  $('acc-id').textContent = ok || a?.irepsAccountId ? a.irepsAccountId : '—';
  $('acc-status').textContent = ok ? 'Verified' : 'Account not verified';
  $('acc-status').className = ok ? 'tender-ok' : 'tender-bad';
  const w = $('acc-warning');
  w.textContent = ok ? '' : a && !a.authenticated ? SESSION_MSG : ACCOUNT_UNVERIFIED_MSG;
  w.hidden = ok;
}

async function refreshAccount() {
  if (running) return;
  $('acc-connection').textContent = 'Checking…';
  $('acc-status').textContent = 'Checking…';
  try {
    renderAccount(await getActiveIrepsAccountContext());
  } catch (e) {
    console.error('[DocLink][Account] check failed:', e.message);
    renderAccount(null);
  }
}

// ---------------------------------------------------------------- rendering

function li(label, value, cls, title, reason) {
  const row = document.createElement('li');
  row.className = 'tender-row';
  const a = document.createElement('span');
  a.textContent = label;
  const b = document.createElement('span');
  b.textContent = value;
  if (cls) b.className = cls;
  if (title) b.title = title;
  row.append(a, b);
  if (reason) {
    const small = document.createElement('small');
    small.textContent = reason;
    a.append(small);
  }
  return row;
}

// Save to: ECM / S3 - how many of a category's documents the ECM holds; a document the ECM did not take was saved locally
const inEcm = (c) => (c.files || []).filter((f) => f.ecm && f.ecm.status !== ECM_OUTCOME.FAILED).length;
const catText = (c) => {
  // all of a category already downloaded (skipped) reads "already downloaded", not "none"
  const text = c.status === 'NOT_AVAILABLE' ? (c.alreadyDownloaded ? 'already downloaded' : 'none') : c.status === 'FAILED' ? 'failed' : c.status === 'PARTIAL' ? `${c.downloaded} ok, ${c.failed} failed` : `${c.downloaded} downloaded`;
  const extra = [inEcm(c) ? `${inEcm(c)} in ECM` : '', c.alreadyDownloaded && c.status !== 'NOT_AVAILABLE' ? `${c.alreadyDownloaded} already downloaded` : ''].filter(Boolean);
  return extra.length ? `${text} (${extra.join(', ')})` : text;
};
// download-log skips say when / where, the ledger's only that they were skipped
const reasons = (c) => [c.note, ...(c.files || []).map((f) => f.error || (f.ecm?.status === ECM_OUTCOME.FAILED ? describeEcmOutcome(f.ecm) : '')), ...(c.skippedFiles || []).map((f) => `${f.title || f.id}: ${describeSkip(f.skip)}`), ...(c.warnings || []).filter((w) => /download log|ECM could not be checked/i.test(w))].filter(Boolean).join('\n');
const LABEL = { tenderPdf: 'NIT', attachments: 'Attachments', myOffer: 'My Offer', corrigenda: 'Corrigenda', negotiation: 'Negotiation', counterOffer: 'Counter offer', loa: 'LOA', correspondence: 'Correspondence' };

const LETTER_PAGE = { MyNegotiation: 'Negotiation', MyCounterOffer: 'Counter Offer', MyAdvanceAcceptanceLetter: 'Advance Acceptance Letter' };

const tenderRows = new Map(); // tenderNo -> <li>, updated live as each tender finishes
function renderDiscovered(ev) {
  $('auto-discovered').hidden = false;
  const list = $('auto-discovered-rows');
  list.replaceChildren();
  tenderRows.clear();
  for (const t of ev.tenders) {
    const row = li(`${t.tenderNo}`, 'queued', 'tender-muted', '', `${t.title || ''}${t.due ? ` · due ${t.due.toLocaleString?.() || t.due}` : ''} · ${t.kinds.join('/')} message ${t.sentAt}`);
    tenderRows.set(t.tenderNo, row);
    list.append(row);
  }
  $('auto-review').hidden = !ev.review.length;
  $('auto-review-rows').replaceChildren(...ev.review.map((r) => li(r.subject || `message ${r.oid}`, 'NEEDS_REVIEW', 'tender-bad', r.reason, r.reason)));
  if (!ev.tenders.length && !ev.review.length) list.append(li('No new NIT / corrigendum messages in this date range', '', 'tender-muted'));
}

function renderTender(ev) {
  const row = tenderRows.get(ev.tenderNo);
  if (!row) return;
  const parts = Object.entries(ev.categories || {}).map(([k, c]) => `${LABEL[k] || k}: ${catText(c)}`);
  const text = ev.status === 'ALREADY_DOWNLOADED' ? 'already downloaded' : ev.status === 'NOT_FOUND' ? 'not found in IREPS' : ev.status === 'FAILED' && !parts.length ? 'failed' : parts.join(' · ') || ev.status;
  const bad = ev.status === 'FAILED' || ev.status === 'NOT_FOUND';
  const fresh = li(ev.tenderNo, text, bad ? 'tender-bad' : 'tender-ok', '', [ev.error, ...Object.values(ev.categories || {}).map(reasons)].filter(Boolean).join('\n'));
  row.replaceWith(fresh);
  tenderRows.set(ev.tenderNo, fresh);
}

function renderResult(r) {
  const body = $('tender-result-rows');
  body.replaceChildren();
  if (r.letters) {
    const n = r.letters.summary?.newLetters || 0;
    body.append(li('Negotiation / Counter offer / LOA letters (by date)', n ? `${n} downloaded` : 'none for these dates', n ? 'tender-ok' : 'tender-muted', r.letters.error || '', r.letters.error || ''));
    for (const [st, msg] of Object.entries(r.letters.listErrors || {})) body.append(li(`  ${LETTER_PAGE[st]}`, 'failed', 'tender-bad', '', msg));
    for (const t of r.letters.tenders) {
      const parts = Object.entries(t.categories).map(([k, c]) => `${LABEL[k]}: ${catText(c)}`);
      body.append(li(`  ${t.tenderNo}`, t.error ? 'failed' : parts.join(' · '), t.error ? 'tender-bad' : 'tender-ok', '', t.error || Object.values(t.categories).map(reasons).filter(Boolean).join('\n')));
    }
  }
  for (const c of r.correspondence) {
    if (c.error || c.correspondence?.discovered) body.append(li(`Correspondence ${c.tenderNo}`, c.error ? 'failed' : catText(c.correspondence), c.error ? 'tender-bad' : 'tender-ok', '', c.error || reasons(c.correspondence)));
  }
  $('tender-result-tender').textContent = `Dates ${r.range.from} - ${r.range.to}: ${r.messages.relevant} NIT/corrigendum message(s) of ${r.messages.scanned}, ${r.messages.pagesRead} page(s) read`;
  $('tender-result-totals').textContent = `Downloaded: ${r.summary.downloaded}   Failed tenders: ${r.summary.failed}   Needs review: ${r.summary.needsReview}${r.messages.truncated ? '   (page limit reached - narrow the date range)' : ''}`;
  $('tender-result-folder').textContent = 'Downloads/DocLink/<unit>/Tender_<no>/';
  lastIds = [];
  $('btn-tender-show').hidden = true;
  $('tender-result').hidden = false;
  $('btn-auto-retry').hidden = !(r.summary.failed || r.tenders.some((t) => t.status === 'FAILED'));
  if (r.aborted) {
    $('tender-error-message').textContent = `Stopped early: ${r.aborted.message}`;
    $('tender-error').hidden = false;
  }
}

// ---------------------------------------------------------------- one letter type

function renderLetterResult(status, r) {
  const name = LETTER_PAGE[status];
  const body = $('tender-result-rows');
  body.replaceChildren();
  const l = r.letters;
  const n = l.summary?.newLetters || 0;
  const err = l.listErrors?.[status];
  body.append(li(`${name} letters (by Letter Date)`, err ? 'failed' : n ? `${n} downloaded` : 'none for these dates', err ? 'tender-bad' : n ? 'tender-ok' : 'tender-muted', '', err || ''));
  for (const t of l.tenders) {
    const parts = Object.entries(t.categories).map(([k, c]) => `${LABEL[k]}: ${catText(c)}`);
    body.append(li(`  ${t.tenderNo}`, t.error ? 'failed' : parts.join(' · '), t.error ? 'tender-bad' : 'tender-ok', '', t.error || Object.values(t.categories).map(reasons).filter(Boolean).join('\n')));
  }
  $('tender-result-tender').textContent = `${name} letters with Letter Date ${r.range.from} - ${r.range.to}${l.listed ? `: ${l.listed} found` : ''}`;
  $('tender-result-totals').textContent = `Downloaded: ${n}`;
  $('tender-result-folder').textContent = 'Downloads/DocLink/<unit>/Tender_<no>/';
  $('btn-tender-show').hidden = true;
  $('tender-result').hidden = false;
  $('btn-auto-retry').hidden = true;
  if (l.aborted) {
    $('tender-error-message').textContent = `Stopped early: ${l.aborted.message}`;
    $('tender-error').hidden = false;
  }
}

async function runLetters(status) {
  if (running) return;
  $('tender-error').hidden = true;
  $('tender-result').hidden = true;
  $('auto-discovered').hidden = true;
  let from;
  let to;
  try {
    from = fromIso($('auto-from').value);
    to = fromIso($('auto-to').value);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) throw new Error('Choose a valid From / To date.');
  } catch (e) {
    $('tender-error-message').textContent = e.message;
    $('tender-error').hidden = false;
    return;
  }
  setBusy(true);
  $('tender-progress').hidden = false;
  const stopGuard = guardTabs();
  try {
    renderLetterResult(status, await runLetterType({
      status, from, to, tenderNo: $('letter-tender-no').value,
      onProgress: (m) => ($('tender-progress-message').textContent = m),
      onAccount: renderAccount,
    }));
  } catch (e) {
    $('tender-error-message').textContent = e.code === 'SESSION_EXPIRED' ? SESSION_MSG : e.code === 'ACCOUNT' ? ACCOUNT_UNVERIFIED_MSG : e.message || 'Something went wrong.';
    $('tender-error').hidden = false;
    console.error('[DocLink][Tender] letters failed:', e.code || '', e.message);
  } finally {
    stopGuard();
    $('tender-progress').hidden = true;
    setBusy(false);
  }
}

// ---------------------------------------------------------------- keep the user on the IREPS tab while downloading

/**
 * While a download run is going, a tab that Chrome opens for a saved file (PDF viewer, file:// or blob: page,
 * the downloads page) is closed again and the IREPS tab the run started on is brought back, so DocLink
 * stays on the IREPS portal. Pages the user opens themselves (normal http/https sites) are left alone.
 */
function guardTabs() {
  let origin = null;
  const strays = (url) => /^(blob:|file:|filesystem:|data:|chrome:\/\/downloads)/i.test(url || '') || /\.pdf([?#]|$)/i.test(url || '');
  chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => { origin = t || null; }).catch(() => {});
  const restore = () => { if (origin) chrome.tabs.update(origin.id, { active: true }).catch(() => {}); };
  const check = (tab) => {
    if (!tab || origin === null || tab.id === origin.id) return;
    if (strays(tab.url) || strays(tab.pendingUrl)) chrome.tabs.remove(tab.id).then(restore).catch(() => {});
  };
  const onCreated = (tab) => check(tab);
  const onUpdated = (_id, change, tab) => { if (change.url || change.status) check(tab); };
  // a downloaded file's tab can take focus before its URL is known: look again as soon as it becomes the active tab
  const onActivated = ({ tabId }) => { if (origin && tabId !== origin.id) chrome.tabs.get(tabId).then(check).catch(() => {}); };
  chrome.tabs.onCreated.addListener(onCreated);
  chrome.tabs.onUpdated.addListener(onUpdated);
  chrome.tabs.onActivated.addListener(onActivated);
  return () => {
    chrome.tabs.onActivated.removeListener(onActivated);
    chrome.tabs.onCreated.removeListener(onCreated);
    chrome.tabs.onUpdated.removeListener(onUpdated);
  };
}

// ---------------------------------------------------------------- run

async function run() {
  if (running) return;
  $('tender-error').hidden = true;
  $('tender-result').hidden = true;
  $('auto-discovered').hidden = true;
  let from;
  let to;
  try {
    from = fromIso($('auto-from').value);
    to = fromIso($('auto-to').value);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) throw new Error('Choose a valid From / To date.');
  } catch (e) {
    $('tender-error-message').textContent = e.message;
    $('tender-error').hidden = false;
    return;
  }
  setBusy(true);
  $('tender-progress').hidden = false;
  const stopGuard = guardTabs();
  try {
    const r = await runAutomatic({
      from, to,
      onProgress: (m) => ($('tender-progress-message').textContent = m),
      onAccount: renderAccount, // the account in use stays visible for the whole run
      onEvent: (ev) => (ev.type === 'discovered' ? renderDiscovered(ev) : ev.type === 'tender' ? renderTender(ev) : null),
    });
    renderResult(r);
  } catch (e) {
    $('tender-error-message').textContent = e.code === 'SESSION_EXPIRED' ? SESSION_MSG : e.code === 'ACCOUNT' ? ACCOUNT_UNVERIFIED_MSG : e.message || 'Something went wrong.';
    $('tender-error').hidden = false;
    if (e.code === 'SESSION_EXPIRED' || e.code === 'ACCOUNT') renderAccount(await getActiveIrepsAccountContext().catch(() => null));
    console.error('[DocLink][Tender] run failed:', e.code || '', e.message);
  } finally {
    stopGuard();
    $('tender-progress').hidden = true;
    setBusy(false);
  }
}

$('btn-tender-open').addEventListener('click', () => show(true));
$('btn-tender-back').addEventListener('click', () => show(false));
$('btn-auto-run').addEventListener('click', run);
document.querySelectorAll('[data-status]').forEach((b) => b.addEventListener('click', () => runLetters(b.dataset.status)));
$('btn-auto-retry').addEventListener('click', run); // already-downloaded documents are skipped via the ledger
$('btn-account-refresh').addEventListener('click', refreshAccount);
$('btn-copy-diag').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(getLogTail() || '(no log yet)');
    $('btn-copy-diag').textContent = 'Copied';
  } catch {
    $('btn-copy-diag').textContent = 'Copy failed';
  }
  setTimeout(() => ($('btn-copy-diag').textContent = 'Copy diagnostics'), 1500);
});

// The user may switch IREPS accounts in another tab: re-detect whenever the panel regains focus.
const refreshIfVisible = () => !view.hidden && !running && refreshAccount();
window.addEventListener('focus', refreshIfVisible);
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && refreshIfVisible());

// If DocLink's "go to IREPS" gate takes over, keep this view out of the way.
new MutationObserver(() => {
  if (!gate.hidden) view.hidden = true;
}).observe(gate, { attributes: true, attributeFilter: ['hidden'] });

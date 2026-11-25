// "Download Tender Documents" view: account panel + automatic discovery from My Messages.
import { runAutomatic, runLetterType, runTabulations } from './tender-auto.js';
import { ACCOUNT_UNVERIFIED_MSG } from './tender-account.js';
import { SESSION_MSG, log } from './tender-core.js';
import { renderAccountPanel, refreshAccountPanel, wireCopyDiagnostics, wireViewLifecycle, guardTabs } from './view-common.js';
import { ECM_OUTCOME, describeEcmOutcome } from '../services/ecm-service.js';
import { describeSkip } from '../services/download-log.js';
import { claimPanelRun, releasePanelRun, isPanelBusy, PANEL_BUSY_MSG } from './run-lock.js';
import { localIsoDate } from '../utils/dates.js';

const $ = (id) => document.getElementById(id);
const main = $('view-main');
const view = $('view-tender');
const gate = $('view-gate');

let running = false;

const fromIso = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };

function show(open) {
  view.hidden = !open;
  if (open) {
    main.hidden = true;
    if (!$('auto-from').value) { $('auto-from').value = localIsoDate(new Date()); $('auto-to').value = localIsoDate(new Date()); }
    refreshAccount();
  } else if (gate.hidden) main.hidden = false;
}

/** Disable every download button while a run goes; the clicked one shows the spinner. */
function setBusy(busy, button) {
  running = busy;
  if (busy) claimPanelRun('tender'); else releasePanelRun('tender');
  $('btn-auto-run').disabled = busy;
  $('btn-auto-retry').disabled = busy;
  document.querySelectorAll('[data-status],[data-tabulation]').forEach((b) => { b.disabled = busy; });
  $('btn-account-refresh').disabled = busy;
  document.querySelectorAll('.tender-actions .btn').forEach((b) => b.classList.toggle('is-busy', busy && b === button));
}

// ---------------------------------------------------------------- account panel

/** Render a detected (or failed) account context. Nothing here is assumed: every value is from IREPS. */
const renderAccount = (a) => renderAccountPanel('', a);

async function refreshAccount() {
  if (!running) await refreshAccountPanel('');
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
// documents attached to a corrigendum page, saved next to it
const attached = (c) => (c.files || []).filter((f) => f.role === 'attachment' && f.status === 'DOWNLOADED').length;
const catText = (c) => {
  // all of a category already downloaded (skipped) reads "already downloaded", not "none"
  const text = c.status === 'NOT_AVAILABLE' ? (c.alreadyDownloaded ? 'already downloaded' : 'none') : c.status === 'FAILED' ? 'failed' : c.status === 'PARTIAL' ? `${c.downloaded} ok, ${c.failed} failed` : `${c.downloaded} downloaded`;
  const extra = [attached(c) ? `+${attached(c)} attached` : '', inEcm(c) ? `${inEcm(c)} in ECM` : '', c.alreadyDownloaded && c.status !== 'NOT_AVAILABLE' ? `${c.alreadyDownloaded} already downloaded` : ''].filter(Boolean);
  return extra.length ? `${text} (${extra.join(', ')})` : text;
};
// download-log skips say when / where, the ledger's only that they were skipped
const reasons = (c) => [c.note, ...(c.files || []).map((f) => f.error || (f.ecm?.status === ECM_OUTCOME.FAILED ? describeEcmOutcome(f.ecm) : '')), ...(c.skippedFiles || []).map((f) => `${f.title || f.id}: ${describeSkip(f.skip)}`), ...(c.warnings || []).filter((w) => /download log|ECM could not be checked|attached document/i.test(w))].filter(Boolean).join('\n');
const LABEL = { tenderPdf: 'NIT', attachments: 'Attachments', myOffer: 'My Offer', corrigenda: 'Corrigenda', negotiation: 'Negotiation', counterOffer: 'Counter offer', loa: 'LOA', correspondence: 'Correspondence', financialTabulation: 'Financial Tabulation', commercialTabulation: 'Commercial Tabulation' };
const TABULATION_NAME = { financialTabulation: 'Financial Tabulation', commercialTabulation: 'Commercial Tabulation' };

const LETTER_PAGE = { MyNegotiation: 'Negotiation', MyCounterOffer: 'Counter Offer', MyAdvanceAcceptanceLetter: 'Advance Acceptance Letter' };

/** A category or tender row that did not get everything it found: shown red. */
const catFailed = (c) => c.status === 'FAILED' || c.status === 'PARTIAL';
const rowFailed = (t) => Boolean(t.error) || Object.values(t.categories || {}).some(catFailed);
/**
 * What a by-date run (letters, tabulations) did with what it found: downloaded, failed (letters and tabulations
 * that failed, tenders that could not be handled), already downloaded before.
 */
function found(tenders) {
  const cats = tenders.flatMap((t) => Object.values(t.categories || {}));
  const sum = (f) => cats.reduce((n, c) => n + (c[f] || 0), 0);
  return { failed: sum('failed') + tenders.filter((t) => t.error).length, already: sum('alreadyDownloaded') };
}
/** "2 downloaded, 1 failed, 3 already downloaded"; '' when none of them. */
const foundText = (downloaded, { failed, already }) => [downloaded ? `${downloaded} downloaded` : '', failed ? `${failed} failed` : '', already ? `${already} already downloaded` : ''].filter(Boolean).join(', ');

const tenderRows = new Map(); // tender key (number and railway) -> <li>, updated live as each tender finishes
function renderDiscovered(ev) {
  $('auto-discovered').hidden = false;
  const list = $('auto-discovered-rows');
  list.replaceChildren();
  tenderRows.clear();
  for (const t of ev.tenders) {
    // two railways may use one tender number: each is its own row, with its railway
    const row = li(`${t.tenderNo}`, 'queued', 'tender-muted', '', `${t.title || ''}${t.railwayUnit ? ` · ${t.railwayUnit}` : ''}${t.due ? ` · due ${t.due.toLocaleString?.() || t.due}` : ''} · ${t.kinds.join('/')} message ${t.sentAt}`);
    tenderRows.set(t.key || t.tenderNo, row);
    list.append(row);
  }
  // a message IREPS did not open is a failure, not one to review: "Retry failed" opens it again
  const failedMessages = ev.failedMessages || [];
  for (const m of failedMessages) list.append(li(m.subject || `Message of ${m.sentDate}`, 'failed', 'tender-bad', m.reason, `Message of ${m.sentDate}${m.sentTime ? ` ${m.sentTime}` : ''} · ${m.reason}`));
  $('auto-review').hidden = !ev.review.length;
  $('auto-review-rows').replaceChildren(...ev.review.map((r) => li(r.subject || `message ${r.oid}`, 'NEEDS_REVIEW', 'tender-bad', r.reason, r.reason)));
  if (!ev.tenders.length && !ev.review.length && !failedMessages.length) list.append(li('No new NIT / corrigendum messages in this date range', '', 'tender-muted'));
}

function renderTender(ev) {
  const key = ev.key || ev.tenderNo;
  const row = tenderRows.get(key);
  if (!row) return;
  const parts = Object.entries(ev.categories || {}).map(([k, c]) => `${LABEL[k] || k}: ${catText(c)}`);
  const text = ev.status === 'ALREADY_DOWNLOADED' ? 'already downloaded' : ev.status === 'NOT_FOUND' ? 'not found in IREPS' : ev.status === 'FAILED' && !parts.length ? 'failed' : parts.join(' · ') || ev.status;
  const bad = ev.status === 'FAILED' || ev.status === 'NOT_FOUND';
  const fresh = li(ev.tenderNo, text, bad ? 'tender-bad' : 'tender-ok', '', [ev.railwayUnit, ev.error, ...Object.values(ev.categories || {}).map(reasons)].filter(Boolean).join('\n'));
  row.replaceWith(fresh);
  tenderRows.set(key, fresh);
}

function renderResult(r) {
  const body = $('tender-result-rows');
  body.replaceChildren();
  const notOpened = r.summary.failedMessages || 0;
  $('tender-result-tender').textContent = `Dates ${r.range.from} - ${r.range.to}: ${r.messages.relevant} NIT/corrigendum message(s) of ${r.messages.scanned}, ${r.messages.pagesRead} page(s) read`;
  $('tender-result-totals').textContent = `Downloaded: ${r.summary.downloaded}   Failed tenders: ${r.summary.failed}${notOpened ? `   Messages not opened: ${notOpened}` : ''}   Needs review: ${r.summary.needsReview}${r.messages.truncated ? '   (page limit reached - narrow the date range)' : ''}`;
  $('tender-result-folder').textContent = 'Downloads/DocLink/<unit>/Tender_<no>/';
  $('btn-tender-show').hidden = true;
  $('tender-result').hidden = false;
  $('btn-auto-retry').hidden = !(r.summary.failed || notOpened || r.tenders.some((t) => t.status === 'FAILED') || r.messages.incomplete);
  // My Messages not read to its end (H4): the messages after it were not looked at
  const problems = [r.aborted ? `Stopped early: ${r.aborted.message}` : '', r.messages.incomplete ? `My Messages was not read to the end: ${r.messages.incomplete}` : ''].filter(Boolean);
  if (problems.length) {
    $('tender-error-message').textContent = problems.join('\n');
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
  const warn = l.listWarnings?.[status]; // rows of the list DocLink could not read (shown, never silently skipped)
  // "none for these dates" only when the list was read and has no letter of these dates: letters found but not
  // downloaded are "failed" (red), letters downloaded before are "already downloaded" (1.15)
  const f = found(l.tenders);
  const text = err ? 'failed' : foundText(n, f) || (l.listed ? 'nothing new' : 'none for these dates');
  body.append(li(`${name} letters (by Letter Date)`, text, err || warn || f.failed ? 'tender-bad' : n ? 'tender-ok' : 'tender-muted', '', err || warn || ''));
  for (const t of l.tenders) {
    const parts = Object.entries(t.categories).map(([k, c]) => `${LABEL[k]}: ${catText(c)}`);
    const why = [t.error, ...Object.values(t.categories).map(reasons), t.tenderDateProblem].filter(Boolean).join('\n');
    body.append(li(`  ${t.tenderNo}`, t.error ? 'failed' : parts.join(' · '), rowFailed(t) ? 'tender-bad' : 'tender-ok', '', why));
  }
  $('tender-result-tender').textContent = `${name} letters with Letter Date ${r.range.from} - ${r.range.to}${l.listed ? `: ${l.listed} found` : ''}`;
  $('tender-result-totals').textContent = `Downloaded: ${n}${f.failed ? `   Failed: ${f.failed}` : ''}${f.already ? `   Already downloaded: ${f.already}` : ''}`;
  $('tender-result-folder').textContent = 'Downloads/DocLink/<unit>/Tender_<no>/';
  $('btn-tender-show').hidden = true;
  $('tender-result').hidden = false;
  $('btn-auto-retry').hidden = true;
  if (l.aborted) {
    $('tender-error-message').textContent = `Stopped early: ${l.aborted.message}`;
    $('tender-error').hidden = false;
  }
}

// ---------------------------------------------------------------- one tabulation type (by closing date)

function renderTabulationResult(pdfType, r) {
  const name = TABULATION_NAME[pdfType];
  const body = $('tender-result-rows');
  body.replaceChildren();
  const t = r.tabulations;
  // the tenders of earlier dates still waiting for a tabulation, checked again by their Tender Number (tender-jobs.js WAITING)
  const w = t.waiting || { checked: 0, downloaded: 0, dropped: 0, later: 0, still: 0, problem: '' };
  const inRange = t.tenders.filter((x) => !x.rechecked);
  const earlier = t.tenders.filter((x) => x.rechecked);
  const n = t.summary.downloaded;
  // a tabulation found but not downloaded is "failed" (red), never "nothing new"; one downloaded before says so (1.15)
  const f = found(inRange.filter((x) => !x.notAvailable));
  const text = foundText(n, f) || (t.summary.withTabulation ? 'nothing new' : 'none for these dates');
  body.append(li(`${name} (by Closing Date)`, text, f.failed || t.incomplete ? 'tender-bad' : n ? 'tender-ok' : 'tender-muted', '', t.incomplete || ''));
  const tenderRow = (x) => {
    if (x.notAvailable) {
      body.append(li(`  ${x.tenderNo}`, 'not available yet', 'tender-muted', '', `${x.title || ''}${x.closingDate ? ` · closed ${x.closingDate}` : ''} · IREPS shows no ${name} yet`));
      return;
    }
    const parts = Object.entries(x.categories).map(([k, c]) => `${LABEL[k]}: ${catText(c)}`);
    const closed = x.rechecked && x.closingDate ? `closed ${x.closingDate}` : '';
    body.append(li(`  ${x.tenderNo}`, x.error ? 'failed' : parts.join(' · '), rowFailed(x) ? 'tender-bad' : 'tender-ok', '', [closed, x.error, ...Object.values(x.categories).map(reasons)].filter(Boolean).join('\n')));
  };
  for (const x of inRange) tenderRow(x);
  if (w.checked || w.still || w.problem || earlier.length) {
    const fe = found(earlier);
    const wText = foundText(w.downloaded, fe) || (w.checked ? 'not published yet' : `${w.still} waiting`);
    const why = [w.problem ? `Not all checked: ${w.problem}` : '', `${w.checked} checked again by Tender Number, ${w.still} still waiting. IREPS shows a tabulation once the bids are opened: the price bids of a two-packet tender weeks after closing.`].filter(Boolean).join('\n');
    body.append(li(`Earlier tenders waiting for a ${name}`, wText, fe.failed || w.problem ? 'tender-bad' : w.downloaded ? 'tender-ok' : 'tender-muted', '', why));
    for (const x of earlier) tenderRow(x);
  }
  $('tender-result-tender').textContent = `${name} of tenders closing ${r.range.from} - ${r.range.to}: ${t.listed} tender(s) of this vendor, ${t.summary.withTabulation} with a ${name}`;
  const all = found(t.tenders.filter((x) => !x.notAvailable));
  $('tender-result-totals').textContent = `Downloaded: ${n + (w.downloaded || 0)}${all.failed ? `   Failed: ${all.failed}` : ''}${all.already ? `   Already downloaded: ${all.already}` : ''}   Not available yet: ${t.summary.notAvailable}${w.still ? `   Waiting from earlier dates: ${w.still}` : ''}`;
  $('tender-result-folder').textContent = 'Downloads/DocLink/<unit>/Tender_<no>/Tabulation/';
  $('btn-tender-show').hidden = true;
  $('tender-result').hidden = false;
  $('btn-auto-retry').hidden = true;
  // the IREPS tender search not read to its end (H4): tenders on the part not read were not looked at
  const problems = [t.aborted ? `Stopped early: ${t.aborted.message}` : '', t.incomplete ? `The IREPS tender search was not read to the end: ${t.incomplete}` : '',
    w.problem ? `Tenders of earlier dates waiting for a ${name} were not all checked: ${w.problem}` : ''].filter(Boolean);
  if (problems.length) {
    $('tender-error-message').textContent = problems.join('\n');
    $('tender-error').hidden = false;
  }
}

/** A run over the From / To dates (and the optional Tender Number): `task({ from, to, tenderNo, onProgress, onAccount })`. */
async function runByDate(what, task, render, button) {
  if (running) return;
  $('tender-error').hidden = true;
  $('tender-result').hidden = true;
  $('auto-discovered').hidden = true;
  if (isPanelBusy('tender')) {
    $('tender-error-message').textContent = PANEL_BUSY_MSG;
    $('tender-error').hidden = false;
    return;
  }
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
  setBusy(true, button);
  $('tender-progress').hidden = false;
  const stopGuard = guardTabs();
  try {
    render(await task({
      from, to, tenderNo: $('letter-tender-no').value,
      onProgress: (m) => ($('tender-progress-message').textContent = m),
      onAccount: renderAccount,
    }));
  } catch (e) {
    $('tender-error-message').textContent = e.code === 'SESSION_EXPIRED' ? SESSION_MSG : e.code === 'ACCOUNT' ? ACCOUNT_UNVERIFIED_MSG : e.message || 'Something went wrong.';
    $('tender-error').hidden = false;
    log('Tender', `${what} failed: ${e.code || ''} ${e.message}`, 'error');
  } finally {
    stopGuard();
    $('tender-progress').hidden = true;
    setBusy(false);
  }
}

const runLetters = (status, button) => runByDate('letters', (o) => runLetterType({ status, ...o }), (r) => renderLetterResult(status, r), button);
const runTabulationType = (pdfType, button) => runByDate('tabulations', (o) => runTabulations({ pdfType, ...o }), (r) => renderTabulationResult(pdfType, r), button);

// ---------------------------------------------------------------- keep the user on the IREPS tab while downloading
// guardTabs (view-common.js): during a run only the tabs DocLink's own work opened are closed (M23)

// ---------------------------------------------------------------- run

async function run() {
  if (running) return;
  $('tender-error').hidden = true;
  $('tender-result').hidden = true;
  $('auto-discovered').hidden = true;
  if (isPanelBusy('tender')) {
    $('tender-error-message').textContent = PANEL_BUSY_MSG;
    $('tender-error').hidden = false;
    return;
  }
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
  setBusy(true, $('btn-auto-run'));
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
    if (e.code === 'SESSION_EXPIRED' || e.code === 'ACCOUNT') await refreshAccountPanel('');
    log('Tender', `run failed: ${e.code || ''} ${e.message}`, 'error');
  } finally {
    stopGuard();
    $('tender-progress').hidden = true;
    setBusy(false);
  }
}

$('btn-tender-open').addEventListener('click', () => show(true));
$('btn-tender-back').addEventListener('click', () => show(false));
$('btn-auto-run').addEventListener('click', run);
document.querySelectorAll('[data-status]').forEach((b) => b.addEventListener('click', () => runLetters(b.dataset.status, b)));
document.querySelectorAll('[data-tabulation]').forEach((b) => b.addEventListener('click', () => runTabulationType(b.dataset.tabulation, b)));
$('btn-auto-retry').addEventListener('click', run); // already-downloaded documents are skipped via the ledger
$('btn-account-refresh').addEventListener('click', refreshAccount);
wireCopyDiagnostics($('btn-copy-diag'));

// Re-detect the account when the panel comes back into view; step aside for the "go to IREPS" gate.
wireViewLifecycle({ view, gate, isRunning: () => running, refresh: refreshAccount });

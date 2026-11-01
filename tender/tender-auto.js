// Automatic mode ("NIT Documents"): no tender number is typed. DocLink reads My Messages, opens each
// NIT / corrigendum message, takes the tender number from it and downloads that tender's NIT, supporting
// documents and My Offer, and its corrigenda dated in the range. Nothing else: Negotiation, Counter Offer
// and LOA letters have their own run (runLetterType, by Letter Date), Financial and Commercial Tabulation
// theirs (runTabulations, by Closing Date), and correspondence comes from the Correspondence view.

import { TenderError, log, norm } from './tender-core.js';
import { runSteps, publicAccount } from './tender-workflows.js';
import { beginJob, dayRange, openTender, recordManifest, downloadLettersByDate, downloadTabulationsByDate } from './tender-jobs.js';
import { scanMessages, readMessageDetail, dmyOf } from './tender-messages.js';

const DAY = 86400000;

/** Search windows around the tender's due date (IREPS ranges are <= 6 months), then "next 6 months". */
export function windowsFor(dueDate, now = new Date()) {
  const out = [];
  if (dueDate) {
    const d = Math.round((dueDate.getTime() - now.getTime()) / DAY);
    out.push([d - 90, d + 90]);
  }
  out.push([0, 180], [-180, 0]);
  return out;
}

/**
 * @param from,to  Date objects (inclusive days) - message range AND the date range for the corrigenda
 * @param onEvent  progress events for the UI: {type:'discovered'|'tender', ...}
 */
export async function runAutomatic({ from, to, onProgress = () => {}, onAccount = () => {}, onEvent = () => {} }) {
  if (!(from instanceof Date) || !(to instanceof Date) || from > to) throw new TenderError('INPUT', 'Choose a valid From / To date.');
  const job = await beginJob({ onProgress, onAccount });
  const dates = dayRange(from, to);
  const rangeSet = new Set(dates);
  const range = { from: dates[0], to: dates[dates.length - 1] };

  // ---- Stage A: My Messages -> tender numbers
  const scan = await scanMessages(job.base, { from, to, onProgress });
  const relevant = scan.rows.filter((r) => r.kind === 'NIT' || r.kind === 'CORRIGENDUM');
  log('Messages', `${scan.rows.length} message(s) in ${range.from}..${range.to}; ${relevant.length} NIT/corrigendum; ${scan.pagesRead} page(s) read${scan.truncated ? ' (page limit reached)' : ''}`);

  const tenders = new Map(); // lower(tenderNo) -> info
  const review = [];
  let opened = 0;
  for (const row of relevant) {
    if (job.ledger.has('msgs', row.oid)) continue; // fully handled on an earlier run
    onProgress(`Opening message ${++opened}...`);
    let d;
    try {
      d = await readMessageDetail(job.base, row.oid);
    } catch (e) {
      if (e.code === 'SESSION_EXPIRED') throw e;
      review.push({ oid: row.oid, sentDate: row.sentDate, subject: row.subject, status: 'NEEDS_REVIEW', reason: `Could not read the message: ${e.message}` });
      continue;
    }
    if (d.status !== 'OK') {
      review.push({ oid: row.oid, sentDate: row.sentDate, subject: d.subject || row.subject, status: 'NEEDS_REVIEW', reason: d.reason, candidates: d.candidates });
      continue;
    }
    const k = norm(d.tenderNo).toLowerCase();
    const t = tenders.get(k) || { tenderNo: d.tenderNo, title: d.tenderTitle, railwayUnit: d.railwayUnit, dueDate: d.dueDate, kinds: new Set(), messages: [] };
    t.kinds.add(d.kind);
    t.dueDate = t.dueDate || d.dueDate;
    t.messages.push({ oid: row.oid, sentAt: d.sentAt || `${row.sentDate} ${row.sentTime}`, subject: d.subject, kind: d.kind });
    tenders.set(k, t);
  }
  onEvent({ type: 'discovered', tenders: [...tenders.values()].map((t) => ({ tenderNo: t.tenderNo, title: t.title, due: t.dueDate, sentAt: t.messages[0].sentAt, kinds: [...t.kinds] })), review });

  // ---- Stage B/C: per discovered tender
  const results = [];
  let aborted = null;
  for (const [i, t] of [...tenders.values()].entries()) {
    const out = { tenderNo: t.tenderNo, title: t.title, status: '', categories: {} };
    results.push(out);
    if (aborted) { out.status = 'SKIPPED'; out.error = aborted.message; continue; }
    const steps = [];
    if (t.kinds.has('NIT') && !job.ledger.has('nit', t.tenderNo)) steps.push('tenderPdf', 'attachments', 'myOffer');
    if (t.kinds.has('CORRIGENDUM')) steps.push('corrigenda');
    if (!steps.length) { out.status = 'ALREADY_DOWNLOADED'; onEvent({ type: 'tender', ...out }); continue; }
    onProgress(`Tender ${t.tenderNo} (${i + 1}/${tenders.size})...`);
    try {
      const run = await openTender(job, t.tenderNo, windowsFor(t.dueDate), onProgress);
      run.ctx.dueDate = t.dueDate ? t.dueDate.toISOString() : '';
      run.dateRange = rangeSet;
      const { categories, aborted: ab } = await runSteps(run, steps, onProgress);
      if (ab) aborted = ab;
      out.categories = categories;
      out.folder = `Downloads/${run.saver.root}/`;
      out.nitOid = run.ids.nitOid || '';
      const nitOk = categories.tenderPdf?.status === 'DOWNLOADED';
      if (nitOk) job.ledger.mark('nit', t.tenderNo);
      const failed = Object.values(categories).some((c) => c.status === 'FAILED' || c.status === 'PARTIAL');
      out.status = failed ? 'FAILED' : 'DOWNLOADED';
      // a message is "done" once its documents are in; otherwise it is looked at again next time
      for (const m of t.messages) {
        const done = m.kind === 'NIT' ? nitOk : ['DOWNLOADED'].includes(categories.corrigenda?.status);
        if (done) job.ledger.mark('msgs', m.oid);
      }
      await recordManifest(job, run, categories, { range, sources: t.messages });
    } catch (e) {
      if (e.code === 'SESSION_EXPIRED' || e.code === 'ACCOUNT_CHANGED') aborted = { code: e.code, message: e.message };
      out.status = e.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'FAILED';
      out.error = e.message;
    }
    onEvent({ type: 'tender', ...out });
  }

  await job.ledger.save();
  const sumDl = (cats) => Object.values(cats || {}).reduce((n, c) => n + c.downloaded, 0);
  return {
    account: publicAccount(job.account),
    range,
    messages: { scanned: scan.rows.length, relevant: relevant.length, opened, pagesRead: scan.pagesRead, total: scan.total, truncated: scan.truncated },
    tenders: results, review, aborted,
    summary: {
      downloaded: results.reduce((n, r) => n + sumDl(r.categories), 0),
      failed: results.filter((r) => r.status === 'FAILED' || r.status === 'NOT_FOUND').length,
      needsReview: review.length,
    },
  };
}

export { dmyOf };

/**
 * One kind of letter (Negotiation / Counter Offer / Advance Acceptance Letter) for the selected Letter Dates,
 * optionally for one Tender Number. Only published letters are downloaded - nothing is submitted or changed.
 * @param status  'MyNegotiation' | 'MyCounterOffer' | 'MyAdvanceAcceptanceLetter'
 */
export async function runLetterType({ status, from, to, tenderNo = '', onProgress = () => {}, onAccount = () => {} }) {
  if (!(from instanceof Date) || !(to instanceof Date) || from > to) throw new TenderError('INPUT', 'Choose a valid From / To date.');
  const job = await beginJob({ onProgress, onAccount });
  const dates = dayRange(from, to);
  const letters = await downloadLettersByDate({ job, dates, statuses: [status], tenderNo, onProgress });
  await job.ledger.save();
  return { range: { from: dates[0], to: dates[dates.length - 1] }, letters };
}

/**
 * Financial or Commercial Tabulation of the tenders CLOSING on the selected dates (IREPS Closed Tenders),
 * optionally for one Tender Number. Only the published tabulation is downloaded - nothing is changed.
 * @param pdfType  'financialTabulation' | 'commercialTabulation'
 */
export async function runTabulations({ pdfType, from, to, tenderNo = '', onProgress = () => {}, onAccount = () => {} }) {
  if (!(from instanceof Date) || !(to instanceof Date) || from > to) throw new TenderError('INPUT', 'Choose a valid From / To date.');
  const job = await beginJob({ onProgress, onAccount });
  const tabulations = await downloadTabulationsByDate({ job, from, to, pdfTypes: [pdfType], tenderNo, onProgress });
  await job.ledger.save();
  return { range: tabulations.range, tabulations };
}

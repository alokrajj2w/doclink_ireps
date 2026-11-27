// Automatic mode ("NIT Documents"): no tender number is typed. DocLink reads My Messages, opens each
// NIT / corrigendum message, takes the tender number (and the railway) from it and downloads that tender's NIT,
// supporting documents and My Offer (not in a scheduled run: the ECM has no kind for it), and its corrigenda
// dated in the range. Nothing else: Negotiation, Counter Offer and LOA letters have their own run (runLetterType,
// by Letter Date), Financial and Commercial Tabulation theirs (runTabulations, by Closing Date), and
// correspondence comes from the Correspondence view.

import { TenderError, log, norm } from './tender-core.js';
import { runSteps, publicAccount } from './tender-workflows.js';
import { beginJob, dayRange, openTender, recordManifest, downloadLettersByDate, downloadTabulationsByDate } from './tender-jobs.js';
import { scanMessages, readMessageDetail, dmyOf } from './tender-messages.js';
import { railwayOf } from './tender-search.js';
import { sharedRun } from './tender-shared-run.js';

const DAY = 86400000;
/** "25/11/2026" -> "20261125": IREPS's dd/mm/yyyy dates in day order. */
const dayKey = (dmy) => String(dmy || '').split('/').reverse().join('');

/** What a NIT message brings: the tender PDF, its attached documents and My Offer. */
const NIT_STEPS = ['tenderPdf', 'attachments', 'myOffer'];
/**
 * A scheduled run saves to the ECM only, and the ECM has no document type for My Offer (tender-ecm.js): it
 * could never save one, so it leaves My Offer out (and says so once), and a NIT is done without it. A manual
 * run downloads it as before.
 */
const SCHEDULED_NIT_STEPS = ['tenderPdf', 'attachments'];
export const MY_OFFER_NOT_SCHEDULED = 'My Offer is not part of scheduled downloads: the ECM has no document type for it, and a scheduled download saves to the ECM only. Download it with NIT Documents in the DocLink panel.';
/** A category with nothing left to fetch: all downloaded, or nothing (more) there (already downloaded, none shown). */
const succeeded = (c) => !!c && (c.status === 'DOWNLOADED' || c.status === 'NOT_AVAILABLE');

/**
 * Railways reuse tender numbers, so a NIT message's tender is its number and the railway its subject names
 * ("NIT for CSD/PER/SOUTHERN RLY, Tender Number: 78266659": SOUTHERN RLY), when it names one. The key of the
 * tender's "NIT downloaded" mark too: a NIT of the same number for another railway is not "already downloaded".
 */
const railwayKey = (tenderNo, railway) => `${norm(tenderNo).toLowerCase()}|${railwayOf(railway)}`;
const nitMark = (t) => (t.railway ? `${t.tenderNo}|${t.railway}` : t.tenderNo);

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

  const tenders = new Map(); // railwayKey(tenderNo, railway) -> info
  const review = [];
  const failedMessages = [];
  const read = [];
  let opened = 0;
  for (const row of relevant) {
    if (job.ledger.has('msgs', row.oid)) continue; // fully handled on an earlier run
    onProgress(`Opening message ${++opened}...`);
    let d;
    try {
      d = await readMessageDetail(job.base, row.oid);
    } catch (e) {
      if (e.code === 'SESSION_EXPIRED') throw e;
      // IREPS did not open the message (an HTTP error, a timeout, a busy page): a failure, counted and opened again
      // by the next run ("Retry failed", the next scheduled check), never a message that needs review
      failedMessages.push({ oid: row.oid, sentDate: row.sentDate, sentTime: row.sentTime, subject: row.subject, status: 'FAILED', code: e.code || '', reason: `IREPS did not open the message: ${e.message}` });
      continue;
    }
    if (d.status !== 'OK') {
      review.push({ oid: row.oid, sentDate: row.sentDate, subject: d.subject || row.subject, status: 'NEEDS_REVIEW', reason: d.reason, candidates: d.candidates });
      continue;
    }
    read.push({ row, d });
  }
  // one tender per number and railway (6.1); a message that names no railway belongs to its number's one railway
  const railwaysOf = new Map();
  for (const { d } of read) {
    const no = norm(d.tenderNo).toLowerCase();
    if (!railwaysOf.has(no)) railwaysOf.set(no, new Set());
    if (railwayOf(d.railwayUnit)) railwaysOf.get(no).add(railwayOf(d.railwayUnit));
  }
  for (const { row, d } of read) {
    const named = [...railwaysOf.get(norm(d.tenderNo).toLowerCase())];
    const railway = railwayOf(d.railwayUnit) || (named.length === 1 ? named[0] : '');
    const k = railwayKey(d.tenderNo, railway);
    const t = tenders.get(k) || { key: k, tenderNo: d.tenderNo, title: d.tenderTitle, railway, railwayUnit: '', dueDate: d.dueDate, kinds: new Set(), messages: [] };
    t.kinds.add(d.kind);
    t.dueDate = t.dueDate || d.dueDate;
    t.railwayUnit = t.railwayUnit || (railwayOf(d.railwayUnit) ? d.railwayUnit : '');
    t.messages.push({ oid: row.oid, sentAt: d.sentAt || `${row.sentDate} ${row.sentTime}`, subject: d.subject, kind: d.kind });
    // the NIT's published date in the ECM: the day IREPS sent its NIT message (the first, when it sent one twice)
    if (d.kind === 'NIT' && (!t.nitSentDate || dayKey(row.sentDate) < dayKey(t.nitSentDate))) t.nitSentDate = row.sentDate;
    tenders.set(k, t);
  }
  onEvent({ type: 'discovered', tenders: [...tenders.values()].map((t) => ({ key: t.key, tenderNo: t.tenderNo, title: t.title, railwayUnit: t.railwayUnit, due: t.dueDate, sentAt: t.messages[0].sentAt, kinds: [...t.kinds] })), review, failedMessages });

  // ---- Stage B/C: per discovered tender
  const scheduled = Boolean(sharedRun());
  const nitSteps = scheduled ? SCHEDULED_NIT_STEPS : NIT_STEPS;
  let myOfferLeftOut = false;
  const results = [];
  let aborted = null;
  for (const [i, t] of [...tenders.values()].entries()) {
    const out = { key: t.key, tenderNo: t.tenderNo, title: t.title, railwayUnit: t.railwayUnit, status: '', categories: {} };
    results.push(out);
    if (aborted) { Object.assign(out, { status: 'SKIPPED', code: aborted.code, error: aborted.message }); continue; }
    const steps = [];
    if (t.kinds.has('NIT') && !job.ledger.has('nit', nitMark(t))) steps.push(...nitSteps);
    if (t.kinds.has('CORRIGENDUM')) steps.push('corrigenda');
    if (!steps.length) { out.status = 'ALREADY_DOWNLOADED'; onEvent({ type: 'tender', ...out }); continue; }
    onProgress(`Tender ${t.tenderNo} (${i + 1}/${tenders.size})...`);
    try {
      // the message's railway and due date pick this tender when another railway uses the same tender number
      const run = await openTender(job, t.tenderNo, windowsFor(t.dueDate), onProgress, { railway: t.railwayUnit, dueDate: t.dueDate || null });
      run.ctx.dueDate = t.dueDate ? t.dueDate.toISOString() : '';
      run.ctx.nitSentDate = t.nitSentDate || '';
      run.dateRange = rangeSet;
      const { categories, aborted: ab } = await runSteps(run, steps, onProgress);
      if (ab) aborted = ab;
      out.categories = categories;
      out.folder = `Downloads/${run.saver.root}/`;
      out.nitOid = run.ids.nitOid || '';
      // the NIT is done only when every one of its categories is (H7): a failed attachment or My Offer keeps the
      // tender and its message open, so "Retry failed" fetches them (the ledger's docs bucket skips the rest)
      const nitRan = steps.includes('tenderPdf');
      myOfferLeftOut = myOfferLeftOut || (nitRan && scheduled);
      const nitDone = nitRan ? nitSteps.every((k) => succeeded(categories[k])) : job.ledger.has('nit', nitMark(t));
      if (nitRan && nitDone) job.ledger.mark('nit', nitMark(t));
      const corrDone = categories.corrigenda?.status === 'DOWNLOADED' || (categories.corrigenda?.status === 'NOT_AVAILABLE' && categories.corrigenda.alreadyDownloaded > 0);
      const failed = Object.values(categories).some((c) => c.status === 'FAILED' || c.status === 'PARTIAL');
      out.status = failed ? 'FAILED' : 'DOWNLOADED';
      // a message is "done" once all its documents are in; otherwise it is looked at again next time
      for (const m of t.messages) {
        const done = m.kind === 'NIT' ? nitDone : corrDone;
        if (done) job.ledger.mark('msgs', m.oid);
      }
      await recordManifest(job, run, categories, { range, sources: t.messages });
    } catch (e) {
      if (e.code === 'SESSION_EXPIRED' || e.code === 'ACCOUNT_CHANGED') aborted = { code: e.code, message: e.message };
      out.status = e.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'FAILED';
      out.code = e.code || '';
      out.error = e.message;
    }
    // after every tender (M21): a run cut short (panel closed, Chrome stopped) keeps what it did
    await job.ledger.save();
    onEvent({ type: 'tender', ...out });
  }

  await job.ledger.save();
  const sumDl = (cats) => Object.values(cats || {}).reduce((n, c) => n + c.downloaded, 0);
  return {
    account: publicAccount(job.account),
    range,
    messages: { scanned: scan.rows.length, relevant: relevant.length, opened, pagesRead: scan.pagesRead, total: scan.total, truncated: scan.truncated, incomplete: scan.incomplete || '' },
    tenders: results, review, failedMessages, aborted,
    // one note for the run, not one per tender (2.4)
    notes: myOfferLeftOut ? [MY_OFFER_NOT_SCHEDULED] : [],
    summary: {
      downloaded: results.reduce((n, r) => n + sumDl(r.categories), 0),
      failed: results.filter((r) => r.status === 'FAILED' || r.status === 'NOT_FOUND').length,
      failedMessages: failedMessages.length,
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
 * Financial or Commercial Tabulation of the tenders CLOSING on the selected dates (IREPS Search Tender),
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

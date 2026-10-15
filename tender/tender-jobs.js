// Scheduled jobs. Each is safe to run as often as you like: a ledger (tender-ledger.js) remembers
// what was already downloaded, so a run only fetches what is NEW. Wire these to any trigger later.
//
//   downloadNewNits()          once a day   - NIT documents announced in the inbox (covers Sundays/holidays)
//   downloadTodaysCorrigenda() once a day   - corrigendum published today (only that document)
//   downloadLettersByDate()    3-4x a day   - negotiation / counter offer / LOA letters published on a date
//                                            (alias: checkNewLetters)
//
// Financial and Commercial Tabulation are not part of any job.

import { TenderError, SESSION_MSG, log, norm, getBaseUrl } from './tender-core.js';
import { assertSameAccount } from './tender-account.js';
import { getActiveIrepsAccountContext, accountFolderLabel, ACCOUNT_UNVERIFIED_MSG } from './tender-account.js';
import { searchTender, fmtDate } from './tender-search.js';
import { openLedger } from './tender-ledger.js';
import {
  startTenderRun, runSteps, findNitNotices, findCorrigendumNotices, scanPostTenderList, LETTER_SPECS, LETTER_KINDS, downloadLetterItems, publicAccount, todayStr,
} from './tender-workflows.js';
import { tenderEcmSink } from './tender-ecm.js';

const DAY = 86400000;
const ddmmyyyy = (d) => fmtDate(d);

export async function beginJob({ onProgress, onAccount }) {
  const base = await getBaseUrl();
  onProgress('Verifying IREPS account...');
  const account = await getActiveIrepsAccountContext({ base });
  onAccount(account);
  if (!account.authenticated) throw new TenderError('SESSION_EXPIRED', SESSION_MSG);
  if (!account.verified) throw new TenderError('ACCOUNT', ACCOUNT_UNVERIFIED_MSG);
  const folderLabel = accountFolderLabel(account);
  const ledger = await openLedger(account.irepsAccountId);
  return { base, account, folderLabel, ledger };
}

/** dd/mm/yyyy strings from `from` to `to` inclusive. */
export function dayRange(from, to) {
  const out = [];
  for (let t = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime(); t <= to.getTime(); t += DAY) out.push(ddmmyyyy(new Date(t)));
  return out;
}
const parseDmy = (s) => { const [d, m, y] = s.split('/').map(Number); return new Date(y, m - 1, d); };

/**
 * The tender's closing date (IREPS "Due Date/Time"), searched once per job; '' when IREPS does not
 * find the tender. Only for ECM uploads (their tender date): the Post Tenders letter lists do not
 * show it, and a Local run never pays for this search.
 */
export async function closingDateFor(job, tenderNo, onProgress = () => {}) {
  job.closingDates = job.closingDates || new Map();
  if (!job.closingDates.has(tenderNo)) {
    let date = '';
    try {
      date = (await searchTender(job.base, tenderNo, { preferWindows: [[-90, 0], [0, 90]], onProgress })).closingDate || '';
    } catch (e) {
      if (e.code === 'SESSION_EXPIRED') throw e;
      log('Letters', `Closing date of ${tenderNo} not found (${e.message}); the ECM tender date is left blank`);
    }
    job.closingDates.set(tenderNo, date);
  }
  return job.closingDates.get(tenderNo);
}

/** Search for the tender, preferring the date windows implied by its closing date. */
export async function openTender(job, tenderNo, preferWindows, onProgress) {
  const found = await searchTender(job.base, tenderNo, { preferWindows, onProgress });
  const { run } = startTenderRun(job.base, job.account, found, job.folderLabel);
  run.ledger = job.ledger;
  run.ledgerMode = 'skip';
  return run;
}


// ---------------------------------------------------------------- manifest

/**
 * Create/update download_manifest.json for a tender: the verified account, the tender, the source
 * messages, every document (category, title, source date, saved name, validation, timestamp, status/reason)
 * and every run with its date range. The merged record is kept in the ledger so each run adds to it.
 * Holds no cookies, tokens or credentials.
 */
export async function recordManifest(job, run, categories, { range = null, sources = [] } = {}) {
  const ctx = run.ctx;
  const prev = job.ledger.manifest(ctx.tenderNo) || { files: [], sources: [], runs: [] };
  const files = prev.files.filter((f) => f.status !== 'FAILED'); // a failed attempt is superseded by the next try
  for (const [category, c] of Object.entries(categories)) {
    for (const f of c.files || []) {
      // the same document again: same local file, or the same ECM document
      const key = (x) => x.relPath || x.ecm?.uid || null;
      if (f.status === 'DOWNLOADED' && key(f) && files.some((x) => key(x) === key(f))) continue;
      const { downloadId, ...rest } = f;
      files.push({ category: c.category || category, ...rest });
    }
  }
  const manifest = {
    generatedAt: new Date().toISOString(),
    account: publicAccount(job.account),
    tender: { tenderNo: ctx.tenderNo, tenderTitle: ctx.tenderTitle || prev.tender?.tenderTitle || '', railwayUnit: ctx.railwayUnit || prev.tender?.railwayUnit || '', nitId: run.ids.nitId || prev.tender?.nitId || null, nitOid: run.ids.nitOid || prev.tender?.nitOid || null, dueDate: ctx.dueDate || prev.tender?.dueDate || '' },
    sources: [...new Map([...prev.sources, ...sources].map((s) => [s.oid, s])).values()],
    files,
    runs: [...prev.runs.slice(-30), {
      at: new Date().toISOString(), range,
      categories: Object.fromEntries(Object.entries(categories).map(([k, c]) => [k, { status: c.status, discovered: c.discovered, downloaded: c.downloaded, failed: c.failed, note: c.note || '' }])),
    }],
  };
  job.ledger.setManifest(ctx.tenderNo, manifest);
  try {
    await run.saver.saveJson('download_manifest.json', manifest);
  } catch (e) {
    log('Download', `manifest not saved: ${e.message}`);
  }
}

// ---------------------------------------------------------------- NIT documents (daily)

/**
 * NITs are announced daily in the inbox ("NIT for <unit>, Tender Number: X"). Reads every day since the
 * last run - so a Sunday/holiday that was missed is picked up the next working day - and downloads the
 * Tender PDF + attachments of each new tender, searching "next 6 months" (closing date in the future).
 */
export async function downloadNewNits({ onProgress = () => {}, onAccount = () => {}, today = new Date() } = {}) {
  const job = await beginJob({ onProgress, onAccount });
  const last = job.ledger.meta('lastNitDate');
  const from = last ? parseDmy(last) : new Date(today.getTime() - 2 * DAY);
  const dates = dayRange(from, today);
  onProgress(`Checking inbox for NITs published ${dates[0]} - ${dates[dates.length - 1]}...`);
  const notices = await findNitNotices({ base: job.base }, dates);
  const pending = job.ledger.meta('pendingNit') || [];
  const tenders = [...new Set([...pending, ...notices.map((n) => n.tenderNo)])].filter((t) => !job.ledger.has('nit', t));
  log('NIT', `${notices.length} NIT notice(s) over ${dates.length} day(s); ${tenders.length} new tender(s)`);

  const results = [];
  const retry = [];
  let aborted = null;
  for (const [i, tenderNo] of tenders.entries()) {
    if (aborted) { retry.push(tenderNo); continue; }
    onProgress(`NIT ${tenderNo} (${i + 1}/${tenders.length})...`);
    try {
      const run = await openTender(job, tenderNo, [[0, 180]], onProgress);
      const { categories, aborted: ab } = await runSteps(run, ['tenderPdf', 'attachments'], onProgress);
      if (ab) aborted = ab;
      if (categories.tenderPdf.status === 'DOWNLOADED') job.ledger.mark('nit', tenderNo);
      else retry.push(tenderNo);
      await recordManifest(job, run, categories, { range: { from: dates[0], to: dates[dates.length - 1] } });
      results.push({ tenderNo, tenderPdf: categories.tenderPdf, attachments: categories.attachments, folder: `Downloads/${run.saver.root}/` });
    } catch (e) {
      retry.push(tenderNo);
      if (e.code === 'SESSION_EXPIRED' || e.code === 'ACCOUNT_CHANGED') aborted = { code: e.code, message: e.message };
      results.push({ tenderNo, error: e.message });
    }
  }
  if (!aborted) job.ledger.setMeta('lastNitDate', ddmmyyyy(today)); // today is re-read next time (more may arrive)
  job.ledger.setMeta('pendingNit', retry);
  await job.ledger.save();
  return { account: publicAccount(job.account), dates, notices: notices.length, tenders: results, retryLater: retry, aborted };
}

// ---------------------------------------------------------------- Corrigenda (daily)

/**
 * Tenders with a corrigendum notice in the inbox dated `dateStr` (today by default), whatever the tender
 * number. For each, ONLY the corrigendum published that day is downloaded (not the tender's older ones).
 * Closing dates can be past or future, so the search tries next 6 months, then last 6 months.
 */
export async function downloadTodaysCorrigenda({ onProgress = () => {}, onAccount = () => {}, dateStr = todayStr() } = {}) {
  const job = await beginJob({ onProgress, onAccount });
  onProgress(`Checking inbox for corrigenda published on ${dateStr}...`);
  const notices = await findCorrigendumNotices({ base: job.base }, { dateStr });
  const tenders = [...new Map(notices.map((n) => [norm(n.tenderNo).toLowerCase(), n.tenderNo])).values()];
  log('Corrigendum', `Inbox notices dated ${dateStr}: ${notices.length} for ${tenders.length} tender(s)`);

  const results = [];
  let aborted = null;
  for (const [i, tenderNo] of tenders.entries()) {
    if (aborted) { results.push({ tenderNo, error: `Skipped: ${aborted.message}` }); continue; }
    onProgress(`Corrigendum for ${tenderNo} (${i + 1}/${tenders.length})...`);
    try {
      const run = await openTender(job, tenderNo, [[0, 180], [-180, 0]], onProgress);
      run.onlyDate = dateStr;
      const { categories, aborted: ab } = await runSteps(run, ['corrigenda'], onProgress);
      if (ab) aborted = ab;
      await recordManifest(job, run, categories, { range: { from: dateStr, to: dateStr } });
      results.push({ tenderNo, tenderTitle: run.ctx.tenderTitle, corrigenda: categories.corrigenda, folder: `Downloads/${run.saver.root}/` });
    } catch (e) {
      if (e.code === 'SESSION_EXPIRED' || e.code === 'ACCOUNT_CHANGED') aborted = { code: e.code, message: e.message };
      results.push({ tenderNo, error: e.message });
    }
  }
  await job.ledger.save();
  const sum = (f) => results.reduce((n, r) => n + (r.corrigenda?.[f] || 0), 0);
  return { account: publicAccount(job.account), date: dateStr, notices: notices.length, tenders: results, aborted, summary: { downloaded: sum('downloaded'), failed: sum('failed') } };
}

// ---------------------------------------------------------------- Letters (several times a day)

/**
 * Negotiation, Counter Offer and LOA letters published on a DATE - no tender number involved.
 * The three Post Tenders lists are read once (tender number blank), rows are kept when the letter's own
 * published date is one of the wanted days, and each is downloaded straight from its row. Like the NIT job
 * it reads every day since the last run (so a Sunday/holiday is picked up), and the ledger means a letter
 * is only ever downloaded once - one published later in the day is simply picked up by the next run.
 * Pass `dateStr` (dd/mm/yyyy) to fetch one specific day.
 */
export async function downloadLettersByDate({ onProgress = () => {}, onAccount = () => {}, today = new Date(), dateStr = '', dates: datesOverride = null, job: sharedJob = null } = {}) {
  const job = sharedJob || (await beginJob({ onProgress, onAccount }));
  const last = job.ledger.meta('lastLetterDate');
  const dates = datesOverride || (dateStr ? [dateStr] : dayRange(last ? parseDmy(last) : today, today));
  const wanted = new Set(dates);
  const probe = { base: job.base, ctx: { tenderNo: '' }, inboxCache: new Map() };

  onProgress(`Reading Negotiation, Counter Offer and LOA lists for ${dates[0]}${dates.length > 1 ? ` - ${dates[dates.length - 1]}` : ''}...`);
  const statuses = Object.keys(LETTER_SPECS);
  const scans = await Promise.all(statuses.map((st) => scanPostTenderList(probe, st))); // independent lists, read together

  const byTender = new Map(); // tenderNo -> { categories, folder }
  // Save to: ECM / S3 (asked once, and only when there is a letter to save), or null
  let ecm;
  const ecmSink = async () => (ecm === undefined ? (ecm = await tenderEcmSink(job.account)) : ecm);
  let aborted = null;
  let newLetters = 0;
  let listed = 0;
  for (const [i, status] of statuses.entries()) {
    const { entries, scripts } = scans[i];
    const todays = entries.filter((e) => wanted.has(e.date));
    listed += todays.length;
    const tenders = [...new Set(todays.map((e) => e.tenderNo))];
    log('Letters', `${status}: ${todays.length} letter(s) dated ${[...wanted].join(', ')} for ${tenders.length} tender(s)`);
    for (const tenderNo of tenders) {
      const rec = byTender.get(tenderNo) || { tenderNo, categories: {}, folder: '' };
      byTender.set(tenderNo, rec);
      if (aborted) { rec.error = `Skipped: ${aborted.message}`; continue; }
      onProgress(`${LETTER_KINDS[status].tag} letters for ${tenderNo}...`);
      try {
        const run = startLetterRun(job, tenderNo);
        await assertSameAccount(job.account, { base: job.base });
        run.ecm = await ecmSink();
        if (run.ecm) run.ctx.closingDate = await closingDateFor(job, tenderNo, onProgress);
        const items = todays.filter((e) => e.tenderNo === tenderNo).map(({ id, rq, url, date }) => ({ id, rq, url, date }));
        const r = await downloadLetterItems(run, status, items, scripts);
        rec.categories[LETTER_SPECS[status].key] = r;
        await recordManifest(job, run, { [LETTER_SPECS[status].key]: r }, { range: { from: dates[0], to: dates[dates.length - 1] } });
        rec.folder = `Downloads/${run.saver.root}/`;
        rec.nitOid = run.ids.nitOid || rec.nitOid || '';
        newLetters += r.downloaded;
      } catch (e) {
        if (e.code === 'SESSION_EXPIRED' || e.code === 'ACCOUNT_CHANGED') aborted = { code: e.code, message: e.message };
        rec.error = e.message;
      }
    }
  }
  if (!aborted && !dateStr && !datesOverride) job.ledger.setMeta('lastLetterDate', ddmmyyyy(today)); // today is re-read next time
  if (!sharedJob) await job.ledger.save();
  return { account: publicAccount(job.account), dates, listed, tenders: [...byTender.values()], aborted, summary: { newLetters } };
}

/** The 3-4x-a-day check: letters dated since the last run (normally just today). */
export const checkNewLetters = downloadLettersByDate;

export function startLetterRun(job, tenderNo) {
  const found = { tenderNo, tenderTitle: '', railwayUnit: '', department: '', tenderStatus: '', searchUrl: '', row: { actions: [] } };
  const { run } = startTenderRun(job.base, job.account, found, job.folderLabel);
  run.ledger = job.ledger;
  run.ledgerMode = 'skip';
  return run;
}

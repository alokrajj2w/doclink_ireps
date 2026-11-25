// Scheduled jobs. Each is safe to run as often as you like: a ledger (tender-ledger.js) remembers
// what was already downloaded, so a run only fetches what is NEW. Wire these to any trigger later.
//
//   downloadNewNits()          once a day   - NIT documents announced in the inbox (covers Sundays/holidays)
//   downloadTodaysCorrigenda() once a day   - corrigendum published today (only that document)
//   downloadLettersByDate()    3-4x a day   - negotiation / counter offer / LOA letters published on a date
//   downloadTabulationsByDate()                - Financial / Commercial Tabulation of tenders CLOSING on the dates
//                                            (IREPS Search Tender); a tabulation shows up some days after closing,
//                                            and one still missing is checked again by Tender Number (WAITING)

import { IREPS_DOWN_CODES, log, norm } from './tender-core.js';
import { assertSameAccount, startTenderJob } from './tender-account.js';
import { searchTender, fmtDate, railwayOf, tenderEquals } from './tender-search.js';
import { openLedger } from './tender-ledger.js';
import { ledgerIdFor } from './tender-shared-run.js';
import {
  startTenderRun, runSteps, findNitNotices, findCorrigendumNotices, scanPostTenderList, LETTER_SPECS, LETTER_KINDS, downloadLetterItems, publicAccount, todayStr,
  scanTenderSearch, searchTenderOnClosingDay, downloadTabulation, TABULATIONS,
} from './tender-workflows.js';
import { tenderEcmSink, ECM_TAKES_TENDER_DATE } from './tender-ecm.js';

const DAY = 86400000;
const ddmmyyyy = (d) => fmtDate(d);
/** Runs kept in a tender's download record (M21: the record must not grow without end). */
const RUNS_KEPT = 10;
/**
 * Errors of one tender (outside its documents) that stop a letters / tabulations run: the session or the
 * account is gone, IREPS's home page did not answer (the account check: IREPS is down, every other tender
 * would wait for it too), or a scheduled run can no longer reserve its documents. The tenders not reached are
 * reported as skipped, and the run says why it stopped.
 */
const stopsRun = (e) => ['SESSION_EXPIRED', 'ACCOUNT_CHANGED', 'IREPS_UNAVAILABLE'].includes(e.code) || IREPS_DOWN_CODES.has(e.code) || /^SCHEDULE_/.test(e.code || '');

export async function beginJob({ onProgress, onAccount }) {
  const { base, account, folderLabel } = await startTenderJob({ onProgress, onAccount });
  const ledger = await openLedger(ledgerIdFor(account.irepsAccountId));
  // "same answer for the rest of this run" of the download-again prompt, shared by its tenders
  return { base, account, folderLabel, ledger, redownloadMemo: {} };
}

/** dd/mm/yyyy strings from `from` to `to` inclusive. */
export function dayRange(from, to) {
  const out = [];
  for (let t = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime(); t <= to.getTime(); t += DAY) out.push(ddmmyyyy(new Date(t)));
  return out;
}
const parseDmy = (s) => { const [d, m, y] = s.split('/').map(Number); return new Date(y, m - 1, d); };

/** Tries of the closing-date search when IREPS does not answer it (a timeout, an HTTP error, a page DocLink does not recognise). */
const CLOSING_DATE_TRIES = 2;

/**
 * The tender's closing date (IREPS "Due Date/Time"), searched once per job; '' when IREPS does not
 * find the tender. Only for ECM uploads (their tender date): the Post Tenders letter lists do not
 * show it, and a Local run - or an ECM without a tenderDate property (ECM_TAKES_TENDER_DATE) -
 * never pays for this search.
 *   railway: the letter row's "Dept/Rly. Unit"; when two railways use the tender number, the search takes
 *            that railway's tender (tender-search.js preferredRows)
 *   onUnanswered(why): the search got no answer, also when tried again: the date is '' for this letter, and
 *            nothing is kept for the rest of the job (a later letter of the tender searches again)
 * Only IREPS's own answer is kept for the job: the date, or "not found" (every search answered without the tender).
 */
export async function closingDateFor(job, tenderNo, onProgress = () => {}, { railway = '', onUnanswered = () => {} } = {}) {
  job.closingDates = job.closingDates || new Map();
  const key = `${tenderNo}|${railwayOf(railway)}`;
  if (job.closingDates.has(key)) return job.closingDates.get(key);
  let why = '';
  for (let attempt = 1; attempt <= CLOSING_DATE_TRIES; attempt++) {
    try {
      const date = (await searchTender(job.base, tenderNo, { preferWindows: [[-90, 0], [0, 90]], onProgress, prefer: { railway } })).closingDate || '';
      job.closingDates.set(key, date);
      return date;
    } catch (e) {
      if (e.code === 'SESSION_EXPIRED') throw e;
      if (e.code === 'NOT_FOUND') {
        log('Letters', `Closing date of ${tenderNo} not found (${e.message}); the ECM tender date is left blank`);
        job.closingDates.set(key, '');
        return '';
      }
      why = e.message;
      log('Letters', `Closing date of ${tenderNo}: the tender search got no answer (${e.message})${attempt < CLOSING_DATE_TRIES ? '; trying again' : ''}`, 'warn');
    }
  }
  onUnanswered(why);
  return '';
}

/**
 * Search for the tender, preferring the date windows implied by its closing date.
 *   prefer: { railway, dueDate } - what the caller knows of the tender, used only when two railways use its number
 */
export async function openTender(job, tenderNo, preferWindows, onProgress, prefer = {}) {
  const found = await searchTender(job.base, tenderNo, { preferWindows, onProgress, prefer });
  const { run } = startTenderRun(job.base, job.account, found, job.folderLabel);
  run.ledger = job.ledger;
  run.ledgerMode = 'skip';
  run.redownloadMemo = job.redownloadMemo;
  return run;
}


// ---------------------------------------------------------------- manifest

/**
 * Create/update the download record for a tender (kept in extension storage, never downloaded): the verified account, the tender, the source
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
    runs: [...prev.runs.slice(-(RUNS_KEPT - 1)), {
      at: new Date().toISOString(), range,
      categories: Object.fromEntries(Object.entries(categories).map(([k, c]) => [k, { status: c.status, discovered: c.discovered, downloaded: c.downloaded, failed: c.failed, note: c.note || '' }])),
    }],
  };
  job.ledger.setManifest(ctx.tenderNo, manifest); // kept in extension storage only; no download_manifest.json is saved
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
    await job.ledger.save(); // after every tender (M21)
  }
  if (!aborted) job.ledger.setMeta('lastNitDate', ddmmyyyy(today)); // today is re-read next time (more may arrive)
  job.ledger.setMeta('pendingNit', retry);
  await job.ledger.save();
  return { account: publicAccount(job.account), dates, notices: notices.length, tenders: results, retryLater: retry, aborted, incomplete: notices.incomplete || '' };
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
    await job.ledger.save(); // after every tender (M21)
  }
  await job.ledger.save();
  const sum = (f) => results.reduce((n, r) => n + (r.corrigenda?.[f] || 0), 0);
  return { account: publicAccount(job.account), date: dateStr, notices: notices.length, tenders: results, aborted, incomplete: notices.incomplete || '', summary: { downloaded: sum('downloaded'), failed: sum('failed') } };
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
export async function downloadLettersByDate({ onProgress = () => {}, onAccount = () => {}, today = new Date(), dateStr = '', dates: datesOverride = null, job: sharedJob = null, statuses: onlyStatuses = null, tenderNo: onlyTender = '' } = {}) {
  const job = sharedJob || (await beginJob({ onProgress, onAccount }));
  const last = job.ledger.meta('lastLetterDate');
  const dates = datesOverride || (dateStr ? [dateStr] : dayRange(last ? parseDmy(last) : today, today));
  const wanted = new Set(dates);
  const probe = { base: job.base, ctx: { tenderNo: '' }, inboxCache: new Map(), onProgress };

  const statuses = onlyStatuses || Object.keys(LETTER_SPECS);
  const wantTender = norm(onlyTender).toLowerCase(); // optional exact (normalized) Tender Number filter
  onProgress(`Reading ${statuses.map((st) => LETTER_KINDS[st].page).join(', ')} list(s) for ${dates[0]}${dates.length > 1 ? ` - ${dates[dates.length - 1]}` : ''}...`);
  // the lists are newest first: none is read past the earliest wanted Letter Date
  const stopBefore = dates.length ? new Date(Math.min(...dates.map((d) => parseDmy(d).getTime()))) : null;
  // independent lists, read together; one that IREPS fails to open is reported on its own and never blocks the others
  const settled = await Promise.allSettled(statuses.map((st) => scanPostTenderList(probe, st, { stopBefore })));
  const listErrors = {};
  const listWarnings = {};
  const scans = settled.map((s, i) => {
    const page = LETTER_KINDS[statuses[i]].page;
    if (s.status === 'fulfilled') {
      // never silently "no letters" (H4): rows with a letter but no readable Letter Date / tender number, and a
      // list not read to its end, are reported; the letters that were read are downloaded as before
      const { unparsed, entries, incomplete } = s.value;
      const problems = [incomplete, unparsed ? `${unparsed} row(s) with a letter have no Letter Date or tender number DocLink can read` : ''].filter(Boolean);
      if (problems.length && !entries.length) listErrors[statuses[i]] = `Could not read the ${page} page: ${problems.join('; ')}`;
      else if (problems.length) listWarnings[statuses[i]] = `The ${page} list was not read in full (${problems.join('; ')}); letters on the part not read were not downloaded.`;
      return s.value;
    }
    const e = s.reason;
    if (e.code === 'SESSION_EXPIRED') throw e;
    listErrors[statuses[i]] = IREPS_DOWN_CODES.has(e.code) ? `IREPS failed to open the ${page} page - IREPS is not responding.` : `Could not read the ${page} page: ${e.message}`;
    log('Letters', `${statuses[i]} list failed: ${e.message}`);
    return { entries: [], scripts: '', unparsed: 0 };
  });

  const byTender = new Map(); // tenderNo -> { categories, folder }
  // Save to: ECM / S3 (asked once, and only when there is a letter to save), or null
  let ecm;
  const ecmSink = async () => (ecm === undefined ? (ecm = await tenderEcmSink(job.account)) : ecm);
  let aborted = null;
  let newLetters = 0;
  let listed = 0;
  for (const [i, status] of statuses.entries()) {
    const { entries, scripts } = scans[i];
    const todays = entries.filter((e) => wanted.has(e.date) && (!wantTender || norm(e.tenderNo).toLowerCase() === wantTender)); // Letter Date only
    listed += todays.length;
    const tenders = [...new Set(todays.map((e) => e.tenderNo))];
    log('Letters', `${status}: ${todays.length} letter(s) dated ${[...wanted].join(', ')} for ${tenders.length} tender(s)`);
    for (const tenderNo of tenders) {
      const rec = byTender.get(tenderNo) || { tenderNo, categories: {}, folder: '' };
      byTender.set(tenderNo, rec);
      if (aborted) { Object.assign(rec, { status: 'SKIPPED', code: aborted.code, error: `Skipped: ${aborted.message}` }); continue; }
      onProgress(`${LETTER_KINDS[status].tag} letters for ${tenderNo}...`);
      try {
        const run = startLetterRun(job, tenderNo);
        run.onProgress = onProgress;
        await assertSameAccount(job.account, { base: job.base });
        run.ecm = await ecmSink();
        const items = todays.filter((e) => e.tenderNo === tenderNo).map(({ id, rq, url, date, unit }) => ({ id, rq, url, date, unit }));
        // the list row's railway picks this tender when another railway uses the same tender number; a search
        // IREPS did not answer leaves the ECM tender date blank for this letter, and the result says so
        const onUnanswered = (why) => { rec.tenderDateProblem = `The ECM tender date was left blank: IREPS's tender search did not answer (${why}).`; };
        if (run.ecm && ECM_TAKES_TENDER_DATE) run.ctx.closingDate = await closingDateFor(job, tenderNo, onProgress, { railway: items.find((x) => x.unit)?.unit || '', onUnanswered });
        const r = await downloadLetterItems(run, status, items, scripts);
        rec.categories[LETTER_SPECS[status].key] = r;
        await recordManifest(job, run, { [LETTER_SPECS[status].key]: r }, { range: { from: dates[0], to: dates[dates.length - 1] } });
        rec.folder = `Downloads/${run.saver.root}/`;
        rec.nitOid = run.ids.nitOid || rec.nitOid || '';
        newLetters += r.downloaded;
      } catch (e) {
        // IREPS_UNAVAILABLE (the account check), like an expired session, stops the run: never a "done" run
        // with every other tender failing on its own
        if (stopsRun(e)) aborted = { code: e.code, message: e.message };
        Object.assign(rec, { status: 'FAILED', code: e.code || '', error: e.message });
      }
      await job.ledger.save(); // after every tender (M21): a run cut short keeps what it did
    }
  }
  if (!aborted && !dateStr && !datesOverride) job.ledger.setMeta('lastLetterDate', ddmmyyyy(today)); // today is re-read next time
  if (!sharedJob) await job.ledger.save();
  return { account: publicAccount(job.account), dates, listed, tenders: [...byTender.values()], aborted, listErrors, listWarnings, summary: { newLetters } };
}


// ---------------------------------------------------------------- Tabulations (by closing date)

/**
 * The tabulations waiting list. IREPS shows a tender's tabulations on its Search Tender row once the bids are
 * opened, but it cannot be searched by the date a tabulation is published: the runs search by closing date. A
 * tabulation published after its tender's closing day has left the dates the runs search would so never be fetched:
 * in a two-packet tender the price bids, and with them the Financial Tabulation, are opened weeks after closing.
 * So a tender this vendor bid on (its row shows My Offer) whose Financial or Commercial Tabulation IREPS does not show
 * yet, or one a run found but could not download, is kept in the ledger (meta META), with each tabulation it waits
 * for and when that one was last looked at. Every run first checks again the waiting tenders whose closing day is
 * not in its own dates (its own search reads those), each by its Tender Number on its closing day
 * (searchTenderOnClosingDay): a tabulation IREPS shows by then is downloaded as the range's are, and a tabulation
 * downloaded, or found downloaded before, is no longer waited for.
 *   RECHECK_MS  a tabulation is looked at again at most this often (with the Tender Number given, at once)
 *   PER_RUN     tenders one run checks again, the longest unchecked first (the others in a later run)
 *   KEEP_DAYS   a tender that closed longer ago is no longer waited for
 *   MISSES      IREPS answers the tender's closing day this many times without it: it is no longer waited for
 *   MAX         tenders kept (the latest closing dates)
 * A tender whose row says it was cancelled, dropped or retendered is no longer waited for.
 */
export const WAITING = Object.freeze({ META: 'tabulationsWaiting', RECHECK_MS: 6 * 3600000, PER_RUN: 25, KEEP_DAYS: 180, MISSES: 3, MAX: 500 });
/** How the waiting tenders are named in a run's lists (the scheduled run's warnings, the panel). */
export const WAITING_LABEL = 'Earlier tenders waiting for a tabulation';
const NO_TABULATION_COMING = /cancel|drop|retender/i;

/** "20/10/2026 11:30" or "20/10/2026" -> that day (local midnight), or null. */
const dayOf = (text) => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(norm(text));
  return m ? new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])) : null;
};
const waitKey = (x) => `${norm(x.tenderNo).toLowerCase()}|${x.nitId || ''}`;
/** Whether a tabulation's category ends the wait: downloaded now, or downloaded before (skipped). */
const tabulationSaved = (c) => Boolean(c) && (c.status === 'DOWNLOADED' || (c.status === 'NOT_AVAILABLE' && c.alreadyDownloaded > 0));

/** The waiting list in the ledger: key -> { tenderNo, nitId, closingDate, dept, title, since, types: { pdfType: last looked at }, misses }. */
function openWaiting(job, now) {
  const list = job.ledger.meta(WAITING.META);
  const waiting = new Map();
  for (const e of Array.isArray(list) ? list : []) {
    const day = e && dayOf(e.closingDate);
    const types = Object.fromEntries(Object.entries((e && e.types) || {}).filter(([t]) => TABULATIONS[t]));
    if (!e || !e.tenderNo || !day || !Object.keys(types).length) continue;
    if (now - day.getTime() > WAITING.KEEP_DAYS * DAY) {
      log('Tabulation', `${e.tenderNo}: no longer waited for (closed ${e.closingDate}, more than ${WAITING.KEEP_DAYS} days ago)`);
      continue;
    }
    waiting.set(waitKey(e), { ...e, types });
  }
  return waiting;
}

/** Put the list in the ledger (saved with it): the tenders still waiting, the latest closing dates first, at most MAX. */
function keepWaiting(job, waiting) {
  job.ledger.setMeta(WAITING.META, [...waiting.values()].sort((a, b) => dayOf(b.closingDate) - dayOf(a.closingDate)).slice(0, WAITING.MAX));
}

/**
 * What a tender's search row and this run's downloads (`rec`, or null) say about its waiting tabulations; `tried`:
 * the tabulations this run set out to download from the row. For each tabulation:
 *   - downloaded by this run, or downloaded before: no longer waited for;
 *   - not shown by IREPS yet, or tried and not downloaded (failed, or the run stopped first): waited for, looked at now;
 *   - shown and not tried (the other button's, or one downloaded by an earlier run): left as it was.
 * Only a tender this vendor bid on (My Offer) starts to be waited for, and one IREPS says was cancelled, dropped or
 * retendered is no longer. -> 'waiting' | 'done' | 'dropped' | null (not this vendor's, nothing to wait for)
 */
function noteWaiting(waiting, row, rec, tried, now, key = waitKey(row)) {
  const at = new Date(now).toISOString();
  const known = waiting.get(key);
  const entry = known || (row.offer ? { tenderNo: row.tenderNo, nitId: row.nitId || '', closingDate: row.closingDate, dept: row.dept || '', title: row.title || '', since: at, types: {}, misses: 0 } : null);
  if (!entry) return null;
  for (const t of Object.keys(TABULATIONS)) {
    if (tabulationSaved(rec && rec.categories && rec.categories[TABULATIONS[t].key])) delete entry.types[t];
    else if (!row.links[t] || tried.includes(t)) entry.types[t] = at;
  }
  Object.assign(entry, { nitId: entry.nitId || row.nitId || '', closingDate: row.closingDate || entry.closingDate, dept: row.dept || entry.dept, title: row.title || entry.title, misses: 0 });
  if (!Object.keys(entry.types).length) {
    waiting.delete(key);
    return known ? 'done' : null;
  }
  if (NO_TABULATION_COMING.test(row.status || '')) {
    waiting.delete(key);
    if (known) log('Tabulation', `${entry.tenderNo}: no longer waited for (IREPS says "${row.status}")`);
    return known ? 'dropped' : null;
  }
  if (!known) log('Tabulation', `${entry.tenderNo}: waiting for the ${Object.keys(entry.types).map((t) => TABULATIONS[t].label).join(' and ')} (closed ${entry.closingDate})`);
  waiting.set(key, entry);
  return 'waiting';
}

/** Download `types` of one tender straight from its search row -> { rec, downloaded, aborted }. */
async function downloadRowTabulations(job, row, types, { ecmSink, onProgress, range }) {
  const rec = { tenderNo: row.tenderNo, title: row.title, closingDate: row.closingDate, categories: {}, folder: '' };
  let downloaded = 0;
  let aborted = null;
  onProgress(`Tabulation for ${row.tenderNo}...`);
  try {
    const run = startLetterRun(job, row.tenderNo);
    run.onProgress = onProgress;
    Object.assign(run.ctx, { closingDate: row.closingDate, tenderTitle: row.title, railwayUnit: row.dept });
    await assertSameAccount(job.account, { base: job.base });
    run.ecm = await ecmSink();
    for (const t of types) {
      const r = await downloadTabulation(run, t, row.links[t], { relativeTo: row.pageUrl });
      rec.categories[TABULATIONS[t].key] = r;
      downloaded += r.downloaded;
    }
    await recordManifest(job, run, rec.categories, { range });
    rec.folder = `Downloads/${run.saver.root}/`;
  } catch (e) {
    // the tender is failed and named (the scheduled run is partial); IREPS not answering stops the run
    if (stopsRun(e)) aborted = { code: e.code, message: e.message };
    Object.assign(rec, { status: 'FAILED', code: e.code || '', error: e.message });
  }
  return { rec, downloaded, aborted };
}

/**
 * Check the waiting tenders again (WAITING): those waiting for a tabulation this run wants, whose closing day is not
 * in the run's dates, each by its Tender Number on its closing day, the longest unchecked first and at most PER_RUN
 * of those due. A tabulation IREPS shows now is downloaded; its tender's record (rechecked: true) goes to `earlier`.
 * When IREPS stops answering or the session is gone before any tender was handled, it throws, as the range's search
 * would; after that, the run stops there (`aborted`).
 * -> { checked, downloaded, dropped, later (due, left to a later run), problems (tenders whose search was not answered in full), aborted }
 */
async function recheckWaiting(job, waiting, { from, to, pdfTypes, onlyTender, now, onProgress, earlier, download }) {
  const lo = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
  const hi = new Date(to.getFullYear(), to.getMonth(), to.getDate()).getTime();
  const wantedTypes = (e) => Object.keys(e.types).filter((t) => pdfTypes.includes(t));
  const lastLook = (e) => Math.min(...wantedTypes(e).map((t) => Date.parse(e.types[t]) || 0));
  const outside = [...waiting.entries()].filter(([, e]) => {
    const day = dayOf(e.closingDate).getTime();
    return (day < lo || day > hi) && wantedTypes(e).length > 0 && (!onlyTender || tenderEquals(e.tenderNo, onlyTender));
  });
  // the Tender Number asks for that tender at once; otherwise a tabulation is looked at again after RECHECK_MS
  const due = outside.filter(([, e]) => onlyTender || now - lastLook(e) >= WAITING.RECHECK_MS)
    .sort(([, a], [, b]) => lastLook(a) - lastLook(b) || dayOf(a.closingDate) - dayOf(b.closingDate));
  const batch = due.slice(0, WAITING.PER_RUN);
  const out = { checked: 0, downloaded: 0, dropped: 0, later: due.length - batch.length, problems: [], aborted: null };
  if (batch.length) log('Tabulation', `${batch.length} earlier tender(s) waiting for a tabulation are checked again${out.later ? ` (${out.later} more in a later run)` : ''}`);
  const forms = {};
  for (const [i, [key, e]] of batch.entries()) {
    const closed = e.closingDate.slice(0, 10);
    onProgress(`Checking tenders of earlier dates still waiting for a tabulation: ${e.tenderNo} (closed ${closed}), ${i + 1} of ${batch.length}...`);
    let got;
    try {
      got = await searchTenderOnClosingDay({ base: job.base, onProgress }, e.tenderNo, dayOf(e.closingDate), forms);
    } catch (err) {
      if (stopsRun(err)) {
        if (!earlier.length && !out.checked) throw err; // nothing done yet: as when the range's search is not answered
        out.aborted = { code: err.code, message: err.message };
        break;
      }
      out.problems.push(`${e.tenderNo} (closed ${closed}): ${err.message}`);
      if (err.code === 'SEARCH_FORM') break; // the next searches need the same form
      continue;
    }
    if (got.problem) { out.problems.push(`${e.tenderNo} (closed ${closed}): ${got.problem}`); continue; }
    out.checked++;
    const row = got.rows.find((r) => !e.nitId || !r.nitId || r.nitId === e.nitId) || null;
    if (!row) {
      e.misses = (Number(e.misses) || 0) + 1;
      for (const t of wantedTypes(e)) e.types[t] = new Date(now).toISOString();
      if (e.misses >= WAITING.MISSES) {
        waiting.delete(key);
        out.dropped++;
        log('Tabulation', `${e.tenderNo}: no longer waited for (IREPS did not list it on its closing day ${closed}, ${e.misses} times)`);
      }
    } else {
      const types = wantedTypes(e).filter((t) => row.links[t]);
      let rec = null;
      if (types.length) {
        const got2 = await download(row, types);
        rec = { ...got2.rec, rechecked: true };
        earlier.push(rec);
        out.downloaded += got2.downloaded;
        if (got2.aborted) out.aborted = got2.aborted;
      }
      if (noteWaiting(waiting, row, rec, types, now, key) === 'dropped') out.dropped++;
    }
    keepWaiting(job, waiting);
    await job.ledger.save(); // after every tender (M21)
    if (out.aborted) break;
  }
  return out;
}

/**
 * Financial / Commercial Tabulations of the tenders that CLOSED between `from` and `to` (Dates, both included),
 * optionally of one Tender Number: the panel's Financial / Commercial Tabulation buttons and the scheduled
 * tenderTabulations run (both tabulations) both come here. IREPS Search Tender is searched one closing day at
 * a time (scanTenderSearch); each tender this vendor bid on that shows a wanted tabulation is downloaded straight
 * from its row, with the row's closing date (Due Date/Time) as the ECM tender date. A tender of this vendor
 * without the link is reported as "not available yet" (IREPS adds it once the bids are opened), and what
 * was downloaded before is skipped (download log, or the ledger), so the same range can be re-run.
 * Before the range, the tenders of earlier dates still waiting for a tabulation are checked again by their Tender
 * Number (WAITING, recheckWaiting), so a tabulation IREPS publishes long after closing is still fetched; they are
 * the records with `rechecked`, after the range's, and `waiting` says what was done with them.
 * @param pdfTypes  keys of TABULATIONS (default both)
 * @param now       the time of the run (ms; the tests set it)
 */
export async function downloadTabulationsByDate({ from, to, pdfTypes = Object.keys(TABULATIONS), tenderNo: onlyTender = '', onProgress = () => {}, onAccount = () => {}, job: sharedJob = null, now = Date.now() } = {}) {
  const job = sharedJob || (await beginJob({ onProgress, onAccount }));
  const range = { from: ddmmyyyy(from), to: ddmmyyyy(to) };
  const wantTender = norm(onlyTender);
  let ecm;
  const ecmSink = async () => (ecm === undefined ? (ecm = await tenderEcmSink(job.account)) : ecm);

  // first the tenders of earlier dates still waiting for a tabulation: a long search of the range cannot crowd them out
  const waiting = openWaiting(job, now);
  const earlier = [];
  const recheck = await recheckWaiting(job, waiting, {
    from, to, pdfTypes, onlyTender: wantTender, now, onProgress, earlier,
    download: (row, types) => downloadRowTabulations(job, row, types, { ecmSink, onProgress, range }),
  });
  let aborted = recheck.aborted;

  let rows = [];
  let pages = 0;
  let incomplete = '';
  if (!aborted) {
    onProgress(`Searching IREPS tenders closing ${range.from} - ${range.to}...`);
    ({ rows, pages, incomplete } = await scanTenderSearch({ base: job.base, onProgress }, { from, to, tenderNo: wantTender }));
  }
  const listed = rows.filter((r) => !wantTender || norm(r.tenderNo).toLowerCase() === wantTender.toLowerCase());

  const tenders = [];
  let downloaded = 0;
  for (const row of listed) {
    const wanted = pdfTypes.filter((t) => row.links[t]);
    let rec;
    if (!wanted.length) rec = { tenderNo: row.tenderNo, title: row.title, closingDate: row.closingDate, categories: {}, folder: '', notAvailable: true };
    else if (aborted) rec = { tenderNo: row.tenderNo, title: row.title, closingDate: row.closingDate, categories: {}, folder: '', status: 'SKIPPED', code: aborted.code, error: `Skipped: ${aborted.message}` };
    else {
      const got = await downloadRowTabulations(job, row, wanted, { ecmSink, onProgress, range });
      rec = got.rec;
      downloaded += got.downloaded;
      if (got.aborted) aborted = got.aborted;
    }
    tenders.push(rec);
    noteWaiting(waiting, row, rec, wanted, now);
    if (wanted.length && rec.status !== 'SKIPPED') {
      keepWaiting(job, waiting);
      await job.ledger.save(); // after every tender (M21): a run cut short keeps what it did
    }
  }
  keepWaiting(job, waiting);
  if (!sharedJob) await job.ledger.save();

  const lo = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
  const hi = new Date(to.getFullYear(), to.getMonth(), to.getDate()).getTime();
  const still = [...waiting.values()].filter((e) => {
    const day = dayOf(e.closingDate).getTime();
    return (day < lo || day > hi) && Object.keys(e.types).some((t) => pdfTypes.includes(t)) && (!wantTender || tenderEquals(e.tenderNo, wantTender));
  }).length;
  const p = recheck.problems;
  const problem = p.length ? `${p.length} not checked: ${p[0]}${p.length > 1 ? ` (and ${p.length - 1} more)` : ''}` : '';
  return {
    account: publicAccount(job.account), range, pages, listed: listed.length, tenders: [...tenders, ...earlier], aborted, incomplete: incomplete || '',
    summary: { downloaded, withTabulation: tenders.filter((t) => !t.notAvailable).length, notAvailable: tenders.filter((t) => t.notAvailable).length },
    // the tenders of earlier dates: checked again, their tabulations downloaded, no longer waited for, due but left to a
    // later run, and still waiting after this run; a search IREPS did not answer in full means a scheduled run is not done
    waiting: { checked: recheck.checked, downloaded: recheck.downloaded, dropped: recheck.dropped, later: recheck.later, still, problem },
    listWarnings: problem ? { [WAITING_LABEL]: problem } : {},
    notes: recheck.later ? [`${recheck.later} tender(s) of earlier dates waiting for a tabulation are checked again by a later run (${WAITING.PER_RUN} a run).`] : [],
  };
}

export function startLetterRun(job, tenderNo) {
  const found = { tenderNo, tenderTitle: '', railwayUnit: '', department: '', tenderStatus: '', searchUrl: '', row: { actions: [] } };
  const { run } = startTenderRun(job.base, job.account, found, job.folderLabel);
  run.ledger = job.ledger;
  run.ledgerMode = 'skip';
  run.redownloadMemo = job.redownloadMemo;
  return run;
}

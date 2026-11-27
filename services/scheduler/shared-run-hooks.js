/**
 * How a scheduled (shared) run saves documents (plan sections 5.3 and 8.3). It replaces the
 * per-user pieces a manual run uses (the "download again?" question, the per-user download-log
 * check, the local fallback) with:
 *
 *   - reserve: before anything is fetched, every document key is reserved for this run's claim in
 *     the Recon Engine. A key that anyone already saved for this IREPS account (or that another
 *     run holds) is skipped, without asking - "Already saved by Priya on ...";
 *   - S3 / ECM only, never local: exports go to the Recon Engine (S3), PDFs to the ECM. A refused
 *     upload is a failed document (the next check fetches it again), never a file in Downloads;
 *   - complete: each saved document is reported, with its download-log record, so the next
 *     reservation by anyone sees it at once (a tender run reports each one as soon as it is saved,
 *     a PDF run in batches). Failed documents are released for the next check;
 *   - the claim check: before each upload the run must still hold its claim (fresh heartbeat).
 *
 * Phase 2 (tender documents) uses the same pieces through `tenderHooks`, installed in the tender code
 * by tender/tender-shared-run.js: reserveDocuments before a category or letter is fetched, an ECM sink
 * that never saves locally, documentSaved for each file the ECM took, and documentFailed for each
 * document that could not be saved, with its reason.
 *
 * `details()` lists what the run saved, skipped and could not save (with the code and reason of each),
 * for the slot's result and this browser's run log (run-details.js, run-log.js), and `seen`: every document the
 * run's IREPS lists named, once, with what helps find it in IREPS and what became of it (document-ledger.js,
 * My Downloads > Missed documents). `seen` never goes to the Recon Engine.
 */

import { downloadKey, exportFingerprint, downloadRecord, logDownload, describeSkip, SKIP_REASON, LOG_DESTINATION } from "../download-log.js";
import { uploadToEcm, ECM_OUTCOME, EcmError } from "../ecm-service.js";
import { saveExportFileTo, WorkflowError } from "../export-save-service.js";
import { SAVE_DESTINATION } from "../recon-service.js";
import { DOCUMENT_DOWNLOAD_STATUS } from "../search-po/document-downloader.js";
import { failureEntry, docEntry, withKey, labelFromKey, tenderCode, docInfo, seenList, LOG_DOCS_MAX, SEEN_MAX, SEEN_STATUS } from "./run-details.js";
import { logger } from "../../utils/logger.js";

/** Keys per reserve request (the backend takes up to 100). */
export const RESERVE_CHUNK = 100;
/** A PDF run's saved documents are reported in batches of this size while it goes on (a tender run's at once: documentSaved). */
const COMPLETE_BATCH = 10;

/** An IREPS-free failure of a scheduled save, with a code from utils/messages.js. */
export class SharedRunError extends Error {
  constructor(code, detail = "") {
    super(detail || code);
    this.name = "SharedRunError";
    this.code = code;
    this.detail = detail;
  }
}

/**
 * A reservation's "already saved" as `seen` keeps it: by whom and when (IST). A document another run holds right now
 * is not saved yet: whichever run saves it, the next one finds it saved.
 */
function seenTaken(skip) {
  if (skip && skip.inProgress) return { status: SEEN_STATUS.UNREAD, code: "SCHEDULE_NOT_RESERVED", detail: `being saved by ${skip.by || "another DocLink run"}` };
  const when = skip && skip.date ? `${skip.date}${skip.time ? ` ${String(skip.time).slice(0, 5)}` : ""}` : "";
  return { status: SEEN_STATUS.ALREADY, by: (skip && skip.by) || "", when };
}

/** "2026-11-16T04:38:00+00:00" -> { date: "2026-11-16", time: "10:08:00" } in IST. */
export function istParts(iso) {
  const ms = Date.parse(iso || "");
  if (!Number.isFinite(ms)) return { date: "", time: "" };
  const ist = new Date(ms + 330 * 60000).toISOString();
  return { date: ist.slice(0, 10), time: ist.slice(11, 19) };
}

function takenSkip(taken) {
  const by = taken && taken.by && taken.by.name ? String(taken.by.name) : "";
  return { reason: SKIP_REASON.ALREADY_SAVED_FOR_ACCOUNT, by, inProgress: taken && taken.status === "in_progress", ...istParts(taken && taken.at) };
}

/** Where a saved PDF went, for the run log: "IC_45.pdf in ECM /Hosur/IC" (" - already there" when the ECM had it). */
function ecmNote(filename, ecm) {
  const where = ecm && ecm.path ? ` in ECM ${ecm.path}` : " in the ECM";
  return `${filename || "file"}${where}${ecm && ecm.status === ECM_OUTCOME.ALREADY_STORED ? " - already there" : ""}`;
}

/**
 * @param {object} deps
 * @param {object} deps.api                 services/scheduler/schedule-api.js
 * @param {string} deps.claimId
 * @param {{ irepsAccountId: string, operatingUnit?: string|null }} deps.account   the verified IREPS account
 * @param {() => boolean|Promise<boolean>} deps.isClaimLive  false once the claim may have been lost (stale heartbeat,
 *   CLAIM_LOST); a tender run's answers later (tender-runner.js createClaimWatch asks the worker), and is awaited
 * @param {Function} [deps.uploadEcm]       uploadToEcm (tests pass a fake)
 * @param {Function} [deps.uploadExport]    (file, target) => saveExportFileTo(...) (tests pass a fake)
 * @param {Function} [deps.logFallback]     the download-log queue, used when `complete` cannot be sent
 * @param {number} [deps.completeAttempts]
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 */
export function createSharedRunHooks(deps) {
  const { api, claimId, account, isClaimLive } = deps;
  const uploadEcm = deps.uploadEcm || uploadToEcm;
  const uploadExport = deps.uploadExport || ((file, target) => saveExportFileTo(file, target));
  const logFallback = deps.logFallback || logDownload;
  const attempts = deps.completeAttempts ?? 3;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const accountId = String(account.irepsAccountId);

  /** item id -> its document key, for the documents this run reserved */
  const granted = new Map();
  /** item id -> the code and reason a scheduled save failed with (the downloader only keeps its own code) */
  const failureInfo = new Map();
  /** item id -> its name in the run's lists ("PO 123", "IC 45 (PO 123 Sr. 1)") */
  const labels = new Map();
  let pendingDone = [];
  const stats = { saved: 0, skipped: 0, failed: 0, notReported: 0 };
  let aborted = null;
  /** tender runs: keys this run reserved, keys it saved, and the reason of each key that failed */
  const grantedKeys = new Set();
  const savedKeys = new Set();
  const tenderFailures = new Map();
  /** what the run did, document by document (details()) */
  const lists = { failures: [], saved: [], skipped: [] };
  const more = { failures: 0, saved: 0, skipped: 0 };
  /** every document the run's lists named ("item:<id>" in a PDF run, "key:<key>" in a tender run) -> what became of it */
  const seen = new Map();

  /** Note a document IREPS listed, or what became of it: the entry is made the first time, then updated. */
  function see(id, entry) {
    const known = seen.get(id);
    if (known) Object.assign(known, entry);
    else if (seen.size < SEEN_MAX) seen.set(id, { ...entry });
  }

  /** Add an entry to one of the run's lists, counting what does not fit. */
  function note(list, entry) {
    if (lists[list].length < LOG_DOCS_MAX) lists[list].push(entry);
    else more[list]++;
  }

  async function assertClaim() {
    if (aborted) throw new SharedRunError(aborted);
    const live = await isClaimLive();
    if (aborted) throw new SharedRunError(aborted);
    if (!live) {
      aborted = "SCHEDULE_CLAIM_LOST";
      throw new SharedRunError(aborted, "this run no longer holds its claim");
    }
  }

  /** Reserve `keys` for `destination`; returns { granted: Set, taken: Map }. Throws on any failure. */
  async function reserve(keys, destination) {
    const ok = new Set();
    const taken = new Map();
    for (let i = 0; i < keys.length; i += RESERVE_CHUNK) {
      const answer = await api.reserve({ claimId, account: accountId, destination, keys: keys.slice(i, i + RESERVE_CHUNK) });
      for (const k of answer.granted || []) ok.add(k);
      for (const [k, v] of Object.entries(answer.taken || {})) taken.set(k, v);
    }
    return { granted: ok, taken };
  }

  /** Send `complete` with retries; the done records go to the download-log queue when it never gets through. */
  async function complete(done, failed) {
    if (done.length === 0 && failed.length === 0) return true;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await api.complete({ claimId, done, failed });
        return true;
      } catch (error) {
        if (error && error.code === "SCHEDULE_CLAIM_LOST") aborted = "SCHEDULE_CLAIM_LOST";
        const last = attempt === attempts || aborted;
        logger.warn(`Scheduled run: could not report ${done.length} saved / ${failed.length} failed document(s)${last ? "" : "; trying again"}`, { code: error && error.code });
        if (last) break;
        await sleep(2000 * attempt);
      }
    }
    // the files were saved: keep their records in the normal download log so nothing is lost
    for (const record of done) await logFallback(record);
    stats.notReported += done.length;
    return false;
  }

  async function flushDone() {
    const done = pendingDone;
    pendingDone = [];
    await complete(done, []);
  }

  /** preflight of a PDF run: reserve every document before anything is fetched. Never throws. */
  async function preflight(items) {
    const skip = new Map();
    const byKey = new Map();
    for (const item of items) {
      const key = item.log && item.log.key;
      labels.set(item.id, item.label || labelFromKey(key) || String(item.id));
      // listed by IREPS: named by its key when it has one (its numbers; an IC's with its PO)
      see(`item:${item.id}`, { key, doc: labelFromKey(key) || labels.get(item.id), info: docInfo(item), status: SEEN_STATUS.UNREAD });
      if (!key) {
        skip.set(item.id, { reason: SKIP_REASON.ALREADY_SAVED_FOR_ACCOUNT, by: "", note: "no document key" });
        note("skipped", docEntry(labels.get(item.id), "not downloaded: no document number to reserve it by"));
        see(`item:${item.id}`, { status: SEEN_STATUS.FAILED, code: "SCHEDULE_NOT_RESERVED", detail: "not downloaded: no document number to reserve it by" });
      } else byKey.set(item.id, key);
    }
    let alreadySaved = 0;
    try {
      await assertClaim();
      const answer = await reserve([...new Set(byKey.values())], LOG_DESTINATION.ECM);
      for (const [id, key] of byKey) {
        if (answer.granted.has(key)) granted.set(id, key);
        else {
          const taken = takenSkip(answer.taken.get(key));
          skip.set(id, taken);
          alreadySaved++;
          note("skipped", withKey(docEntry(labels.get(id), describeSkip(taken)), key));
          see(`item:${id}`, seenTaken(taken));
        }
      }
    } catch (error) {
      // a reservation that cannot be made must not turn into "download everything"
      aborted = aborted || (error && error.code) || "SCHEDULE_BACKEND_UNAVAILABLE";
      logger.warn(`Scheduled run: documents not reserved (${aborted}); none is downloaded`);
      for (const id of byKey.keys()) if (!skip.has(id)) skip.set(id, { reason: SKIP_REASON.ALREADY_SAVED_FOR_ACCOUNT, by: "", note: aborted });
    }
    // only what someone already saved counts as "already saved": documents left out because the reservation
    // failed were not checked at all (the run ends failed with the reservation's code)
    stats.skipped += alreadySaved;
    return { skip, replace: new Map(), warnings: [] };
  }

  /** saveFile of a PDF run: the ECM only. */
  async function saveFile(bytes, path, item) {
    try {
      await assertClaim();
      if (!granted.has(item.id)) throw new SharedRunError("SCHEDULE_NOT_RESERVED", "the document was not reserved for this run");
      if (!item.ecm) throw new SharedRunError("SCHEDULE_DESTINATION_REFUSED", "the document has no ECM filing");
      const filename = path.split("/").pop();
      const stored = await uploadEcm({ kind: item.ecm.kind, fields: item.ecm.fields, title: item.ecm.title, bytes, filename, account });
      const ecm = { status: stored.deduplicated ? ECM_OUTCOME.ALREADY_STORED : ECM_OUTCOME.STORED, site: stored.site, uid: stored.uid, path: stored.path };
      return { filename, downloadId: null, ecm };
    } catch (error) {
      // the downloader reports any saver error as "Chrome could not save the file": keep the real reason
      const known = error instanceof EcmError || error instanceof SharedRunError;
      failureInfo.set(item.id, { code: known ? error.code : "SCHEDULE_DESTINATION_REFUSED", detail: (error && (error.detail || error.message)) || null });
      throw error;
    }
  }

  /** onSaved of a PDF run: queue the record for `complete`. */
  async function onSaved(item, done) {
    if (!item.log || !granted.has(item.id)) return;
    pendingDone.push(downloadRecord(item.log, { filename: done.filename, ecm: done.ecm, account }));
    stats.saved++;
    note("saved", withKey(docEntry(labels.get(item.id) || item.label, ecmNote(done.filename, done.ecm)), granted.get(item.id)));
    see(`item:${item.id}`, { status: SEEN_STATUS.SAVED });
    if (pendingDone.length >= COMPLETE_BATCH) await flushDone();
  }

  /**
   * A PDF run's final row: what it adds about the document (a batch row carries the PO's or IC's date and railway),
   * and a row never offered to the reservation (no PDF link: skipped with the link error) as a document not saved.
   */
  function seeFinal(item) {
    const id = `item:${item.id}`;
    const known = seen.get(id);
    if (known) {
      known.info = { ...docInfo(item), ...(known.info || {}) };
      return;
    }
    const error = item.error || {};
    if (item.status === DOCUMENT_DOWNLOAD_STATUS.COMPLETED || !error.code) return;
    const key = item.log && item.log.key;
    see(id, { key, doc: labelFromKey(key) || item.label || String(item.id), info: docInfo(item), status: SEEN_STATUS.FAILED, code: error.code, detail: error.detail || null });
  }

  /** Documents listed but never reached (the reservation failed, the run stopped): with the code the run stopped with. */
  function seeUnread() {
    for (const entry of seen.values()) {
      if (entry.status !== SEEN_STATUS.UNREAD || entry.code) continue;
      entry.code = aborted || "SCHEDULE_DOWNLOAD_FAILED";
      entry.detail = "not downloaded: the run stopped before it";
    }
  }

  /**
   * After a PDF run: report what was saved and release what failed. `items` are the run's final
   * item states ({ id, label, status, error }). Returns the counts for the slot's result; details()
   * then names each failed document with its code and reason.
   */
  async function finishDocuments(items) {
    const failed = [];
    for (const item of items || []) {
      seeFinal(item);
      const key = granted.get(item.id);
      if (!key || item.status === DOCUMENT_DOWNLOAD_STATUS.COMPLETED) continue;
      const info = failureInfo.get(item.id) || {};
      const error = item.error || {};
      const code = info.code || error.code || "SCHEDULE_DOWNLOAD_FAILED";
      failed.push({ doc_key: key, destination: LOG_DESTINATION.ECM, code });
      const detail = info.detail || error.detail || (error.status ? `HTTP ${error.status}` : null);
      note("failures", withKey(failureEntry({ doc: labels.get(item.id) || item.label, key, code, detail }), key));
      see(`item:${item.id}`, { status: SEEN_STATUS.FAILED, code, detail });
    }
    seeUnread();
    stats.failed += failed.length;
    const done = pendingDone;
    pendingDone = [];
    await complete(done, failed);
    return { ...stats, aborted };
  }

  /**
   * saveExport of an export run (Bill Status, CRN, R-NOTE): same contract as saveExportFile
   * (services/export-save-service.js), but reserved for the account and saved to S3 only.
   * @param {object} file    the export file
   * @param {{ docType: string, records: object[], label: string, filename: string, localPath: string, localErrorCode: string }} target
   */
  async function saveExport(file, target) {
    if (!Array.isArray(target.records)) throw new TypeError(`saveExport: ${target.label || target.docType} records must be an array`);
    const log = { docType: target.docType, key: downloadKey.export(target.docType, await exportFingerprint(file.format || file.extension, target.records)) };
    const doc = `${target.label || labelFromKey(log.key)} export (${target.records.length} record${target.records.length === 1 ? "" : "s"})`;
    const failedWith = (code, detail) => note("failures", failureEntry({ doc, code, detail }));
    try {
      await assertClaim();
    } catch (error) {
      failedWith(error.code, error.detail);
      throw new WorkflowError(error.code);
    }
    let answer;
    try {
      answer = await reserve([log.key], LOG_DESTINATION.S3);
    } catch (error) {
      const code = (error && error.code) || "SCHEDULE_BACKEND_UNAVAILABLE";
      failedWith(code, `not reserved: ${(error && error.detail) || code}`);
      throw new WorkflowError(code, { detail: error && error.detail });
    }
    if (!answer.granted.has(log.key)) {
      const skip = takenSkip(answer.taken.get(log.key));
      stats.skipped++;
      note("skipped", docEntry(doc, `the same rows: ${describeSkip(skip)}`));
      logger.info(`${target.label}: identical export already saved for account ${accountId}; not saved again`, { by: skip.by, date: skip.date });
      return { destination: SAVE_DESTINATION.RECON, downloadId: null, filename: null, storedPath: null, deduplicated: false, ingestStats: null, skipped: true, skip, warnings: [] };
    }
    let saved;
    try {
      await assertClaim();
      saved = await uploadExport(file, { ...target, destination: SAVE_DESTINATION.RECON });
    } catch (error) {
      stats.failed++;
      const code = (error && error.code) || "SCHEDULE_DESTINATION_REFUSED";
      failedWith(code, (error && (error.detail || (error.details && error.details.detail))) || null);
      await complete([], [{ doc_key: log.key, destination: LOG_DESTINATION.S3, code }]);
      throw error instanceof WorkflowError ? error : new WorkflowError(code, { detail: error && error.detail });
    }
    stats.saved++;
    note("saved", docEntry(doc, `${saved.filename || target.filename} to S3${saved.storedPath ? ` (${saved.storedPath})` : ""}${saved.deduplicated ? " - the same file was already there" : ""}`));
    await complete([downloadRecord(log, { filename: saved.filename, destination: LOG_DESTINATION.S3, account })], []);
    return { ...saved, skipped: false, warnings: [] };
  }

  /**
   * Tender runs: reserve `keys` (download-log keys) before anything is fetched.
   * -> { granted: Set<key>, taken: Map<key, skip> }. A reservation that cannot be made aborts the run:
   * it throws, so nothing is fetched without one.
   */
  async function reserveDocuments(keys) {
    await assertClaim();
    let answer;
    try {
      answer = await reserve([...new Set(keys)], LOG_DESTINATION.ECM);
    } catch (error) {
      aborted = aborted || (error && error.code) || "SCHEDULE_BACKEND_UNAVAILABLE";
      logger.warn(`Scheduled run: documents not reserved (${aborted}); none is downloaded`);
      throw new SharedRunError(aborted, "the documents could not be reserved for this run");
    }
    for (const k of answer.granted) grantedKeys.add(k);
    const taken = new Map([...answer.taken].map(([k, v]) => [k, takenSkip(v)]));
    stats.skipped += taken.size;
    for (const [k, skip] of taken) note("skipped", withKey(docEntry(labelFromKey(k), describeSkip(skip)), k));
    for (const k of new Set(keys)) if (!seen.has(`key:${k}`)) see(`key:${k}`, { key: k, doc: labelFromKey(k), status: SEEN_STATUS.UNREAD });
    for (const [k, skip] of taken) see(`key:${k}`, seenTaken(skip));
    return { granted: answer.granted, taken };
  }

  /** The ECM sink of a tender run (the shape of tender-ecm.js tenderEcmSink): the ECM only, never local. */
  const ecmSink = {
    // the second argument (save locally instead) is ignored on purpose: a refused upload is a failed document
    async save(doc) {
      await assertClaim();
      const stored = await uploadEcm({ ...doc, account });
      return { ecm: { status: stored.deduplicated ? ECM_OUTCOME.ALREADY_STORED : ECM_OUTCOME.STORED, site: stored.site, uid: stored.uid, path: stored.path }, local: null };
    }
  };

  /**
   * A tender file the ECM took: its download-log record goes to `complete` at once (5.8). A tender run lives in a
   * runner tab, which is closed whatever stops the run (the runner time limit, the user, Chrome): a saved document
   * whose report still waited for a batch would be lost with the tab and downloaded again by the next check. So the
   * run is reported as far as it got, one document after the other.
   */
  async function documentSaved(record) {
    pendingDone.push(record);
    savedKeys.add(record.doc_key);
    stats.saved++;
    const ecm = record.ecm || null;
    note("saved", withKey(docEntry(labelFromKey(record.doc_key), ecmNote(record.filename, ecm && { status: ecm.status, path: ecm.path })), record.doc_key));
    see(`key:${record.doc_key}`, { key: record.doc_key, doc: labelFromKey(record.doc_key), status: SEEN_STATUS.SAVED });
    await flushDone();
  }

  /**
   * A tender document the run could not save, with why (the tender code's error). Every report is named
   * and counted as a failed document when the run ends. A reserved key that was not saved is released with
   * this code; a document without a reservation of its own (an attachment of a saved letter or corrigendum),
   * or one saved only in part, has nothing to release.
   * @param {{ key?: string, doc?: string, code?: string, detail?: string }} failure
   */
  function documentFailed({ key, doc, code, detail } = {}) {
    const entry = failureEntry({ doc: doc || labelFromKey(key), key, code: tenderCode(code, "SCHEDULE_DOWNLOAD_FAILED"), detail });
    tenderFailures.set(key || `#${tenderFailures.size + 1}`, entry);
  }

  /**
   * After a tender run: report what was saved and release what was reserved but not saved, each with
   * the reason the tender code gave (documentFailed). `stopped` is the code the job stopped with: the
   * documents it never reached are listed with it.
   * @param {{ stopped?: string|null }} [run]
   */
  async function finishTenderRun({ stopped = null } = {}) {
    const failed = [];
    for (const key of grantedKeys) {
      if (savedKeys.has(key)) continue;
      const entry = tenderFailures.get(key)
        || failureEntry({ key, code: stopped ? tenderCode(stopped) : "SCHEDULE_DOWNLOAD_FAILED", detail: stopped ? "not downloaded: the run stopped before it" : "reserved, but no file was saved and no error was reported" });
      failed.push({ doc_key: key, destination: LOG_DESTINATION.ECM, code: entry.code });
      note("failures", withKey(entry, key));
      see(`key:${key}`, { key, doc: entry.doc, status: SEEN_STATUS.FAILED, code: entry.code, detail: entry.detail });
    }
    // the reported failures that are not a reservation to release: still documents that were not saved
    let unreserved = 0;
    for (const [key, entry] of tenderFailures) {
      if (grantedKeys.has(key) && !savedKeys.has(key)) continue;
      note("failures", withKey(entry, key));
      unreserved++;
      // a document saved only in part (an attachment missing) is not saved; one without a key keeps the tender code's name
      const keyless = key.startsWith("#");
      see(keyless ? key : `key:${key}`, { key: keyless ? undefined : key, doc: entry.doc, status: SEEN_STATUS.FAILED, code: entry.code, detail: entry.detail });
    }
    stats.failed += failed.length + unreserved;
    const done = pendingDone;
    pendingDone = [];
    await complete(done, failed);
    return { ...stats, aborted };
  }

  /** What the run did, document by document: { failures, saved, skipped } (and how many more did not fit). */
  function details() {
    return { failures: [...lists.failures], saved: [...lists.saved], skipped: [...lists.skipped], more: Object.fromEntries(Object.entries(more).filter(([, n]) => n > 0)), seen: seenList([...seen.values()]) };
  }

  return {
    /** deps for tender runs (tender/tender-shared-run.js) */
    tenderHooks: { reserveDocuments, ecmSink, documentSaved, documentFailed },
    finishTenderRun,
    /** deps for MA / PO-by-date / IC runs (document-downloader.js) */
    documentHooks: { preflight, saveFile, onSaved },
    finishDocuments,
    saveExport,
    stats: () => ({ ...stats, aborted }),
    details
  };
}

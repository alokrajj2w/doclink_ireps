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
 *     reservation by anyone sees it at once. Failed documents are released for the next check;
 *   - the claim check: before each upload the run must still hold its claim (fresh heartbeat).
 *
 * Phase 2 (tender documents) uses the same pieces through `tenderHooks`, installed in the tender code
 * by tender/tender-shared-run.js: reserveDocuments before a category or letter is fetched, an ECM sink
 * that never saves locally, and documentSaved for each file the ECM took.
 */

import { downloadKey, exportFingerprint, downloadRecord, logDownload, SKIP_REASON, LOG_DESTINATION } from "../download-log.js";
import { uploadToEcm, ECM_OUTCOME, EcmError } from "../ecm-service.js";
import { saveExportFileTo, WorkflowError } from "../export-save-service.js";
import { SAVE_DESTINATION } from "../recon-service.js";
import { DOCUMENT_DOWNLOAD_STATUS } from "../search-po/document-downloader.js";
import { logger } from "../../utils/logger.js";

/** Keys per reserve request (the backend takes up to 100). */
export const RESERVE_CHUNK = 100;
/** Saved documents are reported in batches of this size while a run goes on. */
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

/**
 * @param {object} deps
 * @param {object} deps.api                 services/scheduler/schedule-api.js
 * @param {string} deps.claimId
 * @param {{ irepsAccountId: string, operatingUnit?: string|null }} deps.account   the verified IREPS account
 * @param {() => boolean} deps.isClaimLive  false once the claim may have been lost (stale heartbeat, CLAIM_LOST)
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
  /** item id -> the code a scheduled save failed with (the downloader only keeps its own code) */
  const failureCodes = new Map();
  let pendingDone = [];
  const stats = { saved: 0, skipped: 0, failed: 0, notReported: 0 };
  let aborted = null;
  /** tender runs: keys this run reserved, and keys it saved */
  const grantedKeys = new Set();
  const savedKeys = new Set();

  function assertClaim() {
    if (aborted) throw new SharedRunError(aborted);
    if (!isClaimLive()) {
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
      if (!key) skip.set(item.id, { reason: SKIP_REASON.ALREADY_SAVED_FOR_ACCOUNT, by: "", note: "no document key" });
      else byKey.set(item.id, key);
    }
    try {
      assertClaim();
      const answer = await reserve([...new Set(byKey.values())], LOG_DESTINATION.ECM);
      for (const [id, key] of byKey) {
        if (answer.granted.has(key)) granted.set(id, key);
        else skip.set(id, takenSkip(answer.taken.get(key)));
      }
    } catch (error) {
      // a reservation that cannot be made must not turn into "download everything"
      aborted = aborted || (error && error.code) || "SCHEDULE_BACKEND_UNAVAILABLE";
      logger.warn(`Scheduled run: documents not reserved (${aborted}); none is downloaded`);
      for (const id of byKey.keys()) if (!skip.has(id)) skip.set(id, { reason: SKIP_REASON.ALREADY_SAVED_FOR_ACCOUNT, by: "", note: aborted });
    }
    stats.skipped += [...skip.keys()].filter((id) => byKey.has(id) && !granted.has(id)).length;
    return { skip, replace: new Map(), warnings: [] };
  }

  /** saveFile of a PDF run: the ECM only. */
  async function saveFile(bytes, path, item) {
    try {
      assertClaim();
      if (!granted.has(item.id)) throw new SharedRunError("SCHEDULE_NOT_RESERVED", "the document was not reserved for this run");
      if (!item.ecm) throw new SharedRunError("SCHEDULE_DESTINATION_REFUSED", "the document has no ECM filing");
      const filename = path.split("/").pop();
      const stored = await uploadEcm({ kind: item.ecm.kind, fields: item.ecm.fields, title: item.ecm.title, bytes, filename, account });
      const ecm = { status: stored.deduplicated ? ECM_OUTCOME.ALREADY_STORED : ECM_OUTCOME.STORED, site: stored.site, uid: stored.uid, path: stored.path };
      return { filename, downloadId: null, ecm };
    } catch (error) {
      failureCodes.set(item.id, error instanceof EcmError || error instanceof SharedRunError ? error.code : "SCHEDULE_DESTINATION_REFUSED");
      throw error;
    }
  }

  /** onSaved of a PDF run: queue the record for `complete`. */
  async function onSaved(item, done) {
    if (!item.log || !granted.has(item.id)) return;
    pendingDone.push(downloadRecord(item.log, { filename: done.filename, ecm: done.ecm, account }));
    stats.saved++;
    if (pendingDone.length >= COMPLETE_BATCH) await flushDone();
  }

  /**
   * After a PDF run: report what was saved and release what failed. `items` are the run's final
   * item states ({ id, status, error }). Returns the counts for the slot's result.
   */
  async function finishDocuments(items) {
    const failed = [];
    for (const item of items || []) {
      const key = granted.get(item.id);
      if (!key || item.status === DOCUMENT_DOWNLOAD_STATUS.COMPLETED) continue;
      failed.push({ doc_key: key, destination: LOG_DESTINATION.ECM, code: failureCodes.get(item.id) || (item.error && item.error.code) || "SCHEDULE_DOWNLOAD_FAILED" });
    }
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
    try {
      assertClaim();
    } catch (error) {
      throw new WorkflowError(error.code);
    }
    let answer;
    try {
      answer = await reserve([log.key], LOG_DESTINATION.S3);
    } catch (error) {
      throw new WorkflowError((error && error.code) || "SCHEDULE_BACKEND_UNAVAILABLE", { detail: error && error.detail });
    }
    if (!answer.granted.has(log.key)) {
      const skip = takenSkip(answer.taken.get(log.key));
      stats.skipped++;
      logger.info(`${target.label}: identical export already saved for account ${accountId}; not saved again`, { by: skip.by, date: skip.date });
      return { destination: SAVE_DESTINATION.RECON, downloadId: null, filename: null, storedPath: null, deduplicated: false, ingestStats: null, skipped: true, skip, warnings: [] };
    }
    let saved;
    try {
      assertClaim();
      saved = await uploadExport(file, { ...target, destination: SAVE_DESTINATION.RECON });
    } catch (error) {
      stats.failed++;
      const code = (error && error.code) || "SCHEDULE_DESTINATION_REFUSED";
      await complete([], [{ doc_key: log.key, destination: LOG_DESTINATION.S3, code }]);
      throw error instanceof WorkflowError ? error : new WorkflowError(code, { detail: error && error.detail });
    }
    stats.saved++;
    await complete([downloadRecord(log, { filename: saved.filename, destination: LOG_DESTINATION.S3, account })], []);
    return { ...saved, skipped: false, warnings: [] };
  }

  /**
   * Tender runs: reserve `keys` (download-log keys) before anything is fetched.
   * -> { granted: Set<key>, taken: Map<key, skip> }. A reservation that cannot be made aborts the run:
   * it throws, so nothing is fetched without one.
   */
  async function reserveDocuments(keys) {
    assertClaim();
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
    return { granted: answer.granted, taken };
  }

  /** The ECM sink of a tender run (the shape of tender-ecm.js tenderEcmSink): the ECM only, never local. */
  const ecmSink = {
    // the second argument (save locally instead) is ignored on purpose: a refused upload is a failed document
    async save(doc) {
      assertClaim();
      const stored = await uploadEcm({ ...doc, account });
      return { ecm: { status: stored.deduplicated ? ECM_OUTCOME.ALREADY_STORED : ECM_OUTCOME.STORED, site: stored.site, uid: stored.uid, path: stored.path }, local: null };
    }
  };

  /** A tender file the ECM took: its download-log record goes to `complete`. */
  async function documentSaved(record) {
    pendingDone.push(record);
    savedKeys.add(record.doc_key);
    stats.saved++;
    if (pendingDone.length >= COMPLETE_BATCH) await flushDone();
  }

  /** After a tender run: report what was saved and release what was reserved but not saved. */
  async function finishTenderRun() {
    const failed = [...grantedKeys].filter((k) => !savedKeys.has(k)).map((k) => ({ doc_key: k, destination: LOG_DESTINATION.ECM, code: "SCHEDULE_DOWNLOAD_FAILED" }));
    stats.failed += failed.length;
    const done = pendingDone;
    pendingDone = [];
    await complete(done, failed);
    return { ...stats, aborted };
  }

  return {
    /** deps for tender runs (tender/tender-shared-run.js) */
    tenderHooks: { reserveDocuments, ecmSink, documentSaved },
    finishTenderRun,
    /** deps for MA / PO-by-date / IC runs (document-downloader.js) */
    documentHooks: { preflight, saveFile, onSaved },
    finishDocuments,
    saveExport,
    stats: () => ({ ...stats, aborted })
  };
}

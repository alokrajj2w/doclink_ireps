/**
 * Saving a generated export (Bill Status, CRN, R-NOTE workbook / CSV) where the user
 * chose: the Downloads folder, or the Recon Engine (S3). Used by the service worker's
 * Bill Status and PO Search document jobs.
 *
 *   download log (services/download-log.js): an export is "the same" when it has the same
 *   rows in the same format (its file name and bytes carry the run's time). Asked before
 *   saving (the user may skip an identical export), recorded after.
 *
 * Failures surface as WorkflowError: the Recon Engine's own code for an upload, or the
 * caller's `localErrorCode` for a local save.
 */

import { logger } from "../utils/logger.js";
import { uploadToRecon, ReconError, SAVE_DESTINATION } from "./recon-service.js";
import { downloadBytes } from "./download-service.js";
import { loadDownloadLogConfig, preflightDownloads, logDownload, flushDownloadLog, downloadRecord, downloadKey, exportFingerprint, LOG_DESTINATION } from "./download-log.js";

/** A job failure with an error code (resolved to text by describeError) and its details. */
export class WorkflowError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = "WorkflowError";
    this.code = code;
    this.details = details;
  }
}

/** A user-chosen destination, defaulting to the Downloads folder. */
export function sanitiseDestination(value) {
  return value === SAVE_DESTINATION.RECON ? SAVE_DESTINATION.RECON : SAVE_DESTINATION.LOCAL;
}

const DEFAULT_DEPS = { uploadToRecon, downloadBytes };

/** Upload to the Recon Engine or save to Downloads, with no download-log check. */
export async function saveExportFileTo(file, target, deps = DEFAULT_DEPS) {
  if (target.destination === SAVE_DESTINATION.RECON) {
    try {
      const stored = await deps.uploadToRecon({ docType: target.docType, bytes: file.bytes, filename: target.filename, mimeType: file.mimeType });
      return { destination: SAVE_DESTINATION.RECON, downloadId: null, filename: target.filename, storedPath: stored.storedPath, deduplicated: stored.deduplicated, ingestStats: stored.stats };
    } catch (error) {
      if (error instanceof ReconError) throw new WorkflowError(error.code, { status: error.status, detail: error.detail });
      throw error;
    }
  }
  try {
    const download = await deps.downloadBytes(file.bytes, { path: target.localPath, mimeType: file.mimeType });
    return { destination: SAVE_DESTINATION.LOCAL, downloadId: download.downloadId, filename: download.filename, storedPath: null, deduplicated: false, ingestStats: null };
  } catch (error) {
    logger.error("Download failed", error);
    throw new WorkflowError(target.localErrorCode);
  }
}

/**
 * Save an export file, checking the download log first.
 *
 * @param {import("./search-po/search-po-export.js").ExportFile} file
 * @param {{ destination: string, docType: string, localPath: string, filename: string, localErrorCode: string, records: object[], label: string, ask?: Function }} target
 *        ask: the panel prompt for "download again?" (services/download-log.js preflightDownloads)
 * @param {{ uploadToRecon?: Function, downloadBytes?: Function, logDeps?: object }} [deps]
 *        logDeps: forwarded to the download-log check (tests pass a fake Recon fetch)
 * @returns {Promise<{ destination: string, downloadId: number|null, filename: string|null, storedPath: string|null, deduplicated: boolean, ingestStats: object|null, skipped?: boolean, skip?: object, warnings: string[] }>}
 */
export async function saveExportFile(file, target, deps = {}) {
  const { logDeps = {}, ...overrides } = deps;
  const io = { ...DEFAULT_DEPS, ...overrides };
  const log = (await loadDownloadLogConfig()) ? { docType: target.docType, key: downloadKey.export(target.docType, await exportFingerprint(file.format || file.extension, target.records)) } : null;
  const destination = target.destination === SAVE_DESTINATION.RECON ? LOG_DESTINATION.S3 : LOG_DESTINATION.LOCAL;
  let warnings = [];
  if (log) {
    const n = (target.records || []).length;
    const checked = await preflightDownloads([{ id: "export", label: `${target.label} export: the same ${n} record${n === 1 ? "" : "s"}`, log }], { destination, ask: target.ask, deps: logDeps });
    warnings = checked.warnings;
    const skip = checked.skip.get("export");
    if (skip) {
      logger.info(`${target.label}: identical export already downloaded; not saved again`, { date: skip.date, time: skip.time, count: skip.count });
      return { destination: target.destination, downloadId: null, filename: null, storedPath: null, deduplicated: false, ingestStats: null, skipped: true, skip, warnings };
    }
  }
  const saved = await saveExportFileTo(file, target, io);
  if (log) {
    await logDownload(downloadRecord(log, { filename: saved.filename, destination }));
    flushDownloadLog();
  }
  return { ...saved, warnings };
}

/** The save outcome fields every export job summary carries. */
export function savedSummary(saved) {
  return {
    destination: saved.destination,
    downloadId: saved.downloadId,
    filename: saved.filename,
    storedPath: saved.storedPath,
    deduplicated: saved.deduplicated,
    ingestStats: saved.ingestStats,
    skipped: saved.skipped === true,
    skip: saved.skip || null,
    warnings: saved.warnings || []
  };
}

/** The "last download" line kept in chrome.storage.local for the panel's footer. */
export function lastDownloadEntry(summary) {
  return {
    lastDownloadAt: summary.downloadedAt,
    lastDownloadFilename: summary.storedPath || summary.filename,
    lastRecordCount: summary.recordCount,
    lastFilter: summary.filter,
    lastStatus: summary.skipped
      ? "Not saved again: identical export already downloaded"
      : summary.destination === SAVE_DESTINATION.RECON
        ? "Saved to Recon Engine (S3)"
        : "Downloaded successfully"
  };
}

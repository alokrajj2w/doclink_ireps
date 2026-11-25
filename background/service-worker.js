/**
 * DocLink service worker (Manifest V3).
 *
 * Orchestrates the Download IREPS Bill Status workflow:
 *
 *   popup click -> POST viewBills.do (empty) -> session validation ->
 *   Struts token -> POST viewBills.do (Show Results) -> parser (offscreen
 *   document) -> validation -> Excel (.xlsx) export -> save -> popup status
 *
 * "Save" is the user's choice per download (options.destination): the local
 * Downloads folder (chrome.downloads), or the Recon Engine, which stores the
 * file in S3 under a directory per document type and loads it into
 * reconciliation (services/recon-service.js). The same choice applies to the
 * CRN and R-NOTE exports below.
 *
 * All real work is delegated to the service modules; this file only wires
 * the steps together, tracks job state and relays progress to the popup.
 *
 * The PO Search document workflows (CRN, R-NOTE) are wired separately below:
 *
 *   popup DOWNLOAD_IREPS_DOCUMENTS { criteria } -> POST searchPO.do
 *   (searchParam=showPage) -> session validation -> Struts token ->
 *   POST searchPO.do (searchCriteria=CRN | RNOTE) -> type-specific parser
 *   (offscreen document) -> every result page -> export file (Excel .xlsx by
 *   default, like the portal's "Export to Excel"; CSV also available) ->
 *   local download into Downloads/DocLink/IREPS/<TYPE>/
 *
 * The MA copies workflow (searchCriteria=MA) downloads the actual MA PDFs:
 *   popup MA_SEARCH -> same PO Search flow -> MA parser -> records filtered by
 *   MA Date -> MA list to the popup; popup MA_DOWNLOAD -> each
 *   "View/Download MA" href fetched with the browser session, verified as PDF,
 *   saved to Downloads/DocLink/IREPS/MA/<date>/MA_<PO>_<MA>.pdf (3 at a time)
 *
 * The PO / Inspection Certificate screen (one PO number, two independent
 * downloads) is wired separately below:
 *   popup PO_DOWNLOAD { poNo } -> same PO Search flow (searchCriteria=PO,
 *   searchRange=3) -> the PO's "Click to View/Download PO" href downloaded
 *   popup IC_DOWNLOAD { poNo } -> POST vendorInspectionCallList.do
 *   (a different endpoint - services/inspection-certificate/) -> every
 *   issued IC of that PO -> each "View/ Download IC PDF" href downloaded
 *
 * It never touches viewBills.do; only the session/network helpers, the
 * offscreen document and chrome.downloads are shared.
 */

import { IREPS_CONFIG, IrepsError, IREPS_ERROR, loadIrepsConfig } from "../services/ireps-api.js";
import { checkIrepsSession } from "../services/session-service.js";
import { extractBillStatusForm, publicFormInfo } from "../services/ireps-form.js";
import { fetchBillStatus } from "../services/bill-status-service.js";
import { buildBillStatusExport } from "../services/bill-status-export.js";
import { loadReconConfig, RECON_CONFIG, RECON_DOC_TYPE, SAVE_DESTINATION } from "../services/recon-service.js";
import { createBillUploadJob } from "./bill-upload-job.js";
import { createSchedulerJob } from "./scheduler-job.js";
import { searchIrepsDocuments, validateSearchPoSession, SEARCH_PO_FLOW_STAGES } from "../services/search-po/search-po-service.js";
import { loadSearchPoPage, SEARCH_PO_ERROR, SEARCH_PO_CRITERIA, SEARCH_PO_DOCUMENT_TYPES } from "../services/search-po/search-po-api.js";
import { extractSearchPoForm, publicSearchPoFormInfo } from "../services/search-po/search-po-form.js";
import { EXPORT_FORMAT } from "../services/search-po/search-po-export.js";
import { buildCrnExport } from "../services/crn/crn-export.js";
import { buildRnoteExport } from "../services/rnote/rnote-export.js";
import { searchMa, downloadMaPdfs, MA_ERROR, MA_FLOW_STAGES } from "../services/ma/ma-service.js";
import { downloadBytes } from "../services/download-service.js";
import { WorkflowError, saveExportFile, sanitiseDestination, savedSummary, lastDownloadEntry } from "../services/export-save-service.js";
import { saveToEcmOrLocally, canReplaceInEcm } from "../services/ecm-service.js";
import { loadDownloadLogConfig, preflightDownloads, logDownload, flushDownloadLog, downloadRecord, runDestination } from "../services/download-log.js";
import { readIrepsAccount } from "../services/ireps-account-service.js";
import { downloadPo, PO_FLOW_STAGES } from "../services/po/po-service.js";
import { downloadInspectionCertificates, IC_FLOW_STAGES, IC_ERROR } from "../services/inspection-certificate/ic-service.js";
import { downloadIrepsDocuments, DOCUMENT_DOWNLOAD_STATUS } from "../services/search-po/document-downloader.js";
import { runPoDateDownload, retryPoDateFailures } from "../services/po/po-date-service.js";
import { runIcNotificationDownload, retryIcNotificationFailures, publicIcState } from "../services/inspection-certificate/ic-notification-service.js";
import { runIcDateDownload, retryIcDateFailures } from "../services/inspection-certificate/ic-date-service.js";
import { isoToIrepsDate } from "../services/batch-utils.js";
import { IC_DOWNLOAD_SUBFOLDER } from "../utils/filename.js";
import { buildDocumentExportDownloadPath, buildDocumentExportFilename, buildBillStatusExportDownloadPath, buildBillStatusExportFilename } from "../utils/filename.js";
import { MESSAGE_TYPES, TARGETS, STAGES, DOCUMENT_STAGES, MA_STAGES, PO_STAGES, IC_STAGES, documentStageLabel, describeError, STORAGE_KEYS, SESSION_KEYS, SCHEDULED_RUN } from "../utils/messages.js";
import { logger, installLogCollector, installConsoleHelpers, clearLogEntries } from "../utils/logger.js";
import { holdWorker } from "./keep-alive.js";
import { withIrepsFormLock } from "../services/ireps-form-lock.js";
import { classifyTabUrl, compileMatchPatterns } from "../utils/url-scope.js";

// One stored DocLink log for all contexts (see utils/logger.js). Registered
// first so entries sent by the panel / parser are never missed.
installLogCollector();
installConsoleHelpers();

const OFFSCREEN_URL = chrome.runtime.getURL("background/offscreen.html");
const PREVIEW_URL = chrome.runtime.getURL("pages/preview.html");
const SESSION_CHECK_CACHE_MS = 20000;

/* -------------------------------------------------------------------------- */
/* State                                                                      */
/* -------------------------------------------------------------------------- */

/** @type {{ status: "idle"|"running"|"complete"|"error", stage: string, message: string, detail?: string, error?: object, result?: object, updatedAt: number }} */
let jobState = { status: "idle", stage: STAGES.IDLE.id, message: "", updatedAt: Date.now() };
let jobRunning = false;

/**
 * Cache of the last live session check (public info + the loaded page) so
 * that opening the popup and clicking Download does not hit IREPS twice.
 * The HTML is discarded as soon as it has been used or the cache expires.
 */
let lastSessionCheck = null;

/**
 * Keep a job's state in chrome.storage.session (memory only) so a reopened panel can
 * restore it. Never fails the job; returns whether it was stored.
 */
async function persistSession(key, value, what) {
  try {
    await chrome.storage.session.set({ [key]: value });
    return true;
  } catch (error) {
    logger.debug(`Could not persist ${what}`, error);
    return false;
  }
}

/**
 * After Chrome restarts the worker, a job's state saved in chrome.storage.session is read back once
 * (before it is shown or a new run starts): a finished run shows as it ended; a run that was still
 * in progress cannot continue in a new worker, so it shows as interrupted instead of vanishing.
 * @param {string} key   the SESSION_KEYS entry
 * @param {(saved: object) => boolean} wasRunning
 * @param {(saved: object, error: object) => object} asInterrupted
 * @returns {Promise<object|null>} the state to use, or null when nothing was saved
 */
async function restoreSavedJob(key, wasRunning, asInterrupted) {
  try {
    const stored = await chrome.storage.session.get(key);
    const saved = stored && stored[key];
    if (!saved || typeof saved !== "object") return null;
    if (!wasRunning(saved)) return saved;
    logger.warn(`A run was interrupted by a worker restart (${key})`, { stage: saved.stage || null });
    return asInterrupted(saved, describeError("JOB_INTERRUPTED", { detail: saved.message || "a run in progress" }));
  } catch (error) {
    logger.debug(`Could not restore ${key}`, error);
    return null;
  }
}

/**
 * The "last download" line for the panel's footer. A storage failure (quota) here never turns a
 * run whose files were saved into a failed one.
 */
async function rememberLastDownload(key, value) {
  try {
    await chrome.storage.local.set({ [key]: value });
  } catch (error) {
    logger.warn("Could not record the last download line (the files themselves were saved)", error);
  }
}

let jobRestored = false;
/** Bill Status: the state saved before a worker restart. */
async function restoreJobState() {
  if (jobRestored) return;
  jobRestored = true;
  if (jobRunning || jobState.status !== "idle") return;
  const saved = await restoreSavedJob(SESSION_KEYS.JOB_STATE, (j) => j.status === "running", (j, error) => ({ ...j, status: "error", stage: STAGES.ERROR.id, message: error.title, error, result: undefined }));
  if (saved && jobState.status === "idle" && !jobRunning) jobState = saved;
}

async function setJobState(patch) {
  jobState = { ...jobState, ...patch, updatedAt: Date.now() };
  await persistSession(SESSION_KEYS.JOB_STATE, jobState, "job state");
}

function broadcast(type, payload = {}) {
  chrome.runtime.sendMessage({ target: TARGETS.POPUP, type, ...payload }).catch(() => {
    /* popup is closed; state is still available via GET_JOB_STATE */
  });
}

/**
 * The panel a run request came from (popup.js send: the panel's tab id), or null. Every job state and
 * broadcast carries who started the run (`startedBy`: this, or SCHEDULED_RUN for a scheduled run), so a
 * panel shows only its own runs as its own (popup-gate.js isOwnRun).
 */
const panelTabOf = (message) => (Number.isInteger(message && message.panelTabId) ? message.panelTabId : null);

/** Last Bill Status step written to the log (the same step can be reported by two layers). */
let lastLoggedStep = "";

async function progress(stage, message, detail) {
  const text = message || stage.label;
  if (text !== lastLoggedStep) logger.info(`Bill Status: ${text}`, ...(detail ? [{ detail }] : []));
  lastLoggedStep = text;
  await setJobState({ status: "running", stage: stage.id, message: text, detail: detail || "", error: undefined });
  broadcast(MESSAGE_TYPES.IREPS_PROGRESS, { stage: stage.id, message: text, detail: detail || "", startedBy: jobState.startedBy ?? null });
}

/* -------------------------------------------------------------------------- */
/* Offscreen parsing                                                          */
/* -------------------------------------------------------------------------- */

let offscreenCreating = null;

async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [OFFSCREEN_URL]
  });
  if (contexts.length > 0) return;
  if (!offscreenCreating) {
    offscreenCreating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ["DOM_PARSER"],
        justification: "Parse the IREPS Bill Status HTML with DOMParser (not available in service workers)."
      })
      .finally(() => {
        offscreenCreating = null;
      });
  }
  await offscreenCreating;
}

async function closeOffscreenDocument() {
  try {
    await chrome.offscreen.closeDocument();
  } catch {
    /* already closed */
  }
}

/** Number of parse calls currently using the offscreen document (every job's parser). */
let offscreenUsers = 0;
/** The document stays open this long after its last use (a run parses page after page). */
const OFFSCREEN_IDLE_MS = 30000;
let offscreenCloseTimer = null;
/** Opening and closing the document run one after the other, never at the same time (review M1). */
let offscreenLifecycle = Promise.resolve();

function inOffscreenLifecycle(step) {
  offscreenLifecycle = offscreenLifecycle.then(step, step);
  return offscreenLifecycle;
}

/**
 * Run fn() with the offscreen document open. It is closed only after OFFSCREEN_IDLE_MS without a
 * user, and a new user cancels a pending close, so one job finishing can never close the document
 * another job has just started to use ("Parser returned no result" when jobs overlapped).
 */
async function withOffscreen(fn) {
  offscreenUsers++;
  if (offscreenCloseTimer) {
    clearTimeout(offscreenCloseTimer);
    offscreenCloseTimer = null;
  }
  try {
    await inOffscreenLifecycle(ensureOffscreenDocument);
    return await fn();
  } finally {
    offscreenUsers--;
    if (offscreenUsers === 0 && !offscreenCloseTimer) {
      offscreenCloseTimer = setTimeout(() => {
        offscreenCloseTimer = null;
        if (offscreenUsers === 0) inOffscreenLifecycle(closeOffscreenDocument);
      }, OFFSCREEN_IDLE_MS);
    }
  }
}

/**
 * Ask the offscreen document (which owns DOMParser) to parse `payload.html`. A failed parse
 * rejects with the parser's message, and its code when the parser gave one.
 */
async function askOffscreen(type, payload, what) {
  return withOffscreen(async () => {
    const response = await chrome.runtime.sendMessage({ target: TARGETS.OFFSCREEN, type, ...payload });
    if (!response || !response.ok) {
      const error = new Error(response && response.error ? response.error : `${what} returned no result`);
      if (response && response.code) error.code = response.code;
      throw error;
    }
    return response.result;
  });
}

/**
 * @param {string} html
 * @param {{ filter?: string, sourceUrl?: string|null }} options
 * @returns {Promise<import("../services/bill-parser.js").BillStatusResult>}
 */
const parseInOffscreen = (html, options = {}) =>
  askOffscreen(MESSAGE_TYPES.PARSE_BILL_STATUS, { html, filter: options.filter || "", sourceUrl: options.sourceUrl || null }, "Parser");

/** PO Search results (CRN / R-NOTE / MA / PO) by the type-specific parser; `criteria` selects it. */
const parseSearchPoInOffscreen = (html, options = {}) =>
  askOffscreen(MESSAGE_TYPES.PARSE_SEARCH_PO_RESULTS, { criteria: options.criteria, html, sourceUrl: options.sourceUrl || null, startIndex: options.startIndex || 1 }, `${options.criteria} parser`);

/** Inspection Certificate results (vendorInspectionCallList.do, a different endpoint from PO Search). */
const parseIcInOffscreen = (html, poNo, options = {}) =>
  askOffscreen(MESSAGE_TYPES.PARSE_IC_RESULTS, { html, poNo, sourceUrl: options.sourceUrl || null }, "IC parser");

/** The signed-in IREPS account (home page). */
const parseAccountInOffscreen = (html) => askOffscreen(MESSAGE_TYPES.PARSE_IREPS_ACCOUNT, { html }, "Account parser");

/* -------------------------------------------------------------------------- */
/* Save to: ECM / S3 (IC, PO, MA)                                             */
/* -------------------------------------------------------------------------- */

/**
 * The account whose unit's ECM folder gets this run's documents, or null when it cannot be
 * verified (the documents are then saved locally - a site is never guessed). A Local run
 * reads it only for the download log (forEcm: false), where a missing account is no warning.
 */
async function irepsAccountForEcm({ forEcm = true } = {}) {
  const read = await readActiveIrepsAccount();
  if (read.ok) return read.account;
  const text = `IREPS account not read (${read.detail})`;
  if (forEcm) logger.warn(`ECM: ${text}; documents will be saved locally`, { code: read.code });
  else logger.debug(`Download log: ${text}`, { code: read.code });
  return null;
}

/**
 * The logged-in IREPS account from the home page (services/ireps-account-service.js): { ok, account }, or
 * { ok: false, code, detail } where only IREPS_SESSION_EXPIRED means "not logged in". Never rejects.
 */
async function readActiveIrepsAccount() {
  await loadIrepsConfig();
  const read = await readIrepsAccount({ baseUrl: IREPS_CONFIG.baseUrl, parse: parseAccountInOffscreen });
  if (!read.ok) return read;
  logger.info(`IREPS account ${read.account.irepsAccountId} (${read.account.operatingUnit || "unit not stated"})`);
  try {
    // the scheduler asks the Recon Engine what is due for this account without loading IREPS
    await schedulerJob.recordAccount(read.account.irepsAccountId);
  } catch (error) {
    logger.warn("Scheduler: IREPS account not remembered", error);
  }
  return read;
}

/** How long a run waits for the panel's "download again?" answer before skipping those files. */
const REDOWNLOAD_ANSWER_TIMEOUT_MS = 4 * 60 * 1000;

/**
 * The `ask` of preflightDownloads for a run started from the side panel of tab `panelTabId`:
 * that panel shows which files are already downloaded / in the ECM and answers which to
 * download again. No answer (panel closed, or no choice within 4 minutes) = download none
 * of them again. The question carries the time this run stops waiting (`deadline`), so a
 * question the panel shows after another one is never answered after it (7.4).
 */
function askPanel(panelTabId) {
  return async (question) => {
    let timer;
    const deadline = Date.now() + REDOWNLOAD_ANSWER_TIMEOUT_MS;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), REDOWNLOAD_ANSWER_TIMEOUT_MS);
    });
    try {
      const answer = await Promise.race([
        chrome.runtime.sendMessage({ target: TARGETS.POPUP, type: MESSAGE_TYPES.CONFIRM_REDOWNLOAD, panelTabId: panelTabId ?? null, question, deadline }).catch(() => null),
        timeout
      ]);
      if (!answer) logger.info("Download again? not answered: those files are skipped");
      return answer;
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Everything a document run (MA, PO, IC, the batches) hands to its service, as deps:
 *   saveFile   Save to: ECM / S3 -> the ECM (else undefined: the default local save)
 *   preflight  the already-downloaded / already-in-ECM check, asked in the panel
 *   onSaved    each saved document goes to the download log
 * preflight and onSaved only while the download log is on (config.json "downloadLog").
 * `preflight: false` leaves the check out (a retry only fetches what failed).
 * Under ECM / S3 in direct mode, a document the user downloads again although it is already
 * in the ECM goes into the document there (a healthy old PDF is kept in it as <name>_old.pdf).
 */
async function documentRunHooks(rawDestination, panelTabId, { preflight = true } = {}) {
  const destination = sanitiseDestination(rawDestination);
  const toEcm = destination === SAVE_DESTINATION.RECON;
  const logging = await loadDownloadLogConfig();
  const account = toEcm || logging ? await irepsAccountForEcm({ forEcm: toEcm }) : null;
  const replaceInEcm = toEcm && (await canReplaceInEcm());
  return {
    saveFile: toEcm ? ecmSaveFile(account) : undefined,
    preflight: logging && preflight ? (items) => preflightDownloads(items, { destination: runDestination(destination), account, ask: askPanel(panelTabId), replaceInEcm }) : undefined,
    onSaved: logging ? (item, done) => item.log && logDownload(downloadRecord(item.log, { filename: done.filename, ecm: done.ecm, account })) : undefined
  };
}

/**
 * The saveFile hook of a run under "ECM / S3" (services/search-po/document-downloader.js):
 * each item that says how it is filed (item.ecm) goes to the ECM, and is saved locally
 * instead when that fails.
 */
function ecmSaveFile(account) {
  return async (bytes, path, item) => {
    const saveLocally = () => downloadBytes(bytes, { path, mimeType: "application/pdf" });
    if (!item || !item.ecm) return saveLocally();
    const filename = path.split("/").pop();
    const { ecm, local } = await saveToEcmOrLocally(
      { kind: item.ecm.kind, fields: item.ecm.fields, title: item.ecm.title, replace: item.ecm.replace, bytes, filename, account: account || {} },
      saveLocally
    );
    return local ? { ...local, ecm } : { filename, downloadId: null, ecm };
  };
}

/* -------------------------------------------------------------------------- */
/* Session check                                                              */
/* -------------------------------------------------------------------------- */

async function performSessionCheck({ useCache = true } = {}) {
  if (useCache && lastSessionCheck && Date.now() - lastSessionCheck.at < SESSION_CHECK_CACHE_MS) {
    return lastSessionCheck.result;
  }
  // a DocLink search is running on this session (it holds the form lock): loading the Bill Status page now
  // would give the session a new Struts token and break that search, and the search itself shows the
  // session is alive (it reports "Login required" if IREPS logs out)
  const result = await withIrepsFormLock(() => checkIrepsSession(), { ifBusy: () => SESSION_BUSY_RESULT });
  if (result !== SESSION_BUSY_RESULT) lastSessionCheck = { at: Date.now(), result };
  return result;
}

/** The session check's answer while a DocLink search holds the IREPS session (no page loaded). */
const SESSION_BUSY_RESULT = Object.freeze({ authenticated: true, reason: null, code: "OK", busy: true });

/** Session info for the popup: never the HTML, never the token. */
function publicSessionInfo(result) {
  const form = result.authenticated && result.html ? publicFormInfo(extractBillStatusForm(result.html)) : null;
  return {
    authenticated: result.authenticated,
    code: result.code,
    reason: result.reason,
    detail: result.detail ?? null,
    status: result.status ?? null,
    form
  };
}

/** Take (and clear) a recently loaded Bill Status page so the download can reuse it. */
function takeCachedPage() {
  if (!lastSessionCheck) return null;
  const fresh = Date.now() - lastSessionCheck.at < SESSION_CHECK_CACHE_MS;
  const page = fresh && lastSessionCheck.result.authenticated ? lastSessionCheck.result.response : null;
  lastSessionCheck = null;
  return page;
}

/* -------------------------------------------------------------------------- */
/* Download workflow                                                          */
/* -------------------------------------------------------------------------- */

const STAGE_FOR_PROGRESS = {
  CHECKING_SESSION: STAGES.CHECKING_SESSION,
  CONNECTED: STAGES.CONNECTED,
  FETCHING: STAGES.FETCHING,
  PROCESSING: STAGES.PROCESSING
};

/**
 * @param {{ mode?: string, zone?: string, dateFrom?: string, dateTo?: string, destination?: string }} options
 * @param {{ saveExport?: Function }} [hooks]   a scheduled run saves through its own saveExport (S3 only)
 */
async function runDownloadWorkflow(options, panelTabId, hooks = {}) {
  const startedAt = new Date();
  const { destination, ...searchOptions } = options;

  // Steps 1-4: session, token, search, parse (services/bill-status-service.js).
  await progress(STAGES.CHECKING_SESSION);
  let fetched;
  try {
    fetched = await fetchBillStatus(searchOptions, {
      initialPage: takeCachedPage(),
      parseHtml: (html, parseOptions) => parseInOffscreen(html, parseOptions),
      onProgress: (stage) => {
        const s = STAGE_FOR_PROGRESS[stage];
        if (s) progress(s);
      }
    });
  } catch (error) {
    if (error instanceof IrepsError) {
      throw new WorkflowError(error.code, { status: error.status, detail: error.detail });
    }
    throw error;
  }
  const result = fetched.parsed;
  await progress(STAGES.PROCESSING, `Processing ${result.recordCount} bills...`);

  // Keep the parsed result (memory-only) so the preview page can render it.
  // The printable HTML is rebuilt by the preview from the records, so it is
  // not stored (it can be several MB for a full Bill Status page).
  try {
    await chrome.storage.session.set({ [SESSION_KEYS.LAST_RESULT]: { ...result, printableHtml: "" } });
  } catch (error) {
    logger.warn("Could not store parsed result for preview", error);
  }

  // Step 5: Excel export (same workbook layout as the CRN / R-NOTE downloads).
  await progress(STAGES.GENERATING_FILE);
  let file;
  try {
    file = buildBillStatusExport(result);
    logger.info("[DocLink][BillStatus] download generated", { rows: file.recordCount });
  } catch (error) {
    logger.error("Excel generation failed", error);
    throw new WorkflowError("EXPORT_ERROR");
  }

  // Step 6: save - Downloads folder or the Recon Engine (S3).
  const toRecon = destination === SAVE_DESTINATION.RECON;
  await progress(STAGES.DOWNLOADING, toRecon ? "Uploading to the Recon Engine (S3)..." : undefined);
  const saveExport = hooks.saveExport || saveExportFile;
  const saved = await saveExport(file, {
    destination,
    docType: RECON_DOC_TYPE.BILL_STATUS,
    localPath: buildBillStatusExportDownloadPath(startedAt),
    filename: buildBillStatusExportFilename(startedAt),
    localErrorCode: "DOWNLOAD_ERROR",
    records: result.bills,
    label: "Bill Status",
    ask: askPanel(panelTabId)
  });

  const summary = {
    ...savedSummary(saved),
    recordCount: result.recordCount,
    skippedCount: result.skippedCount || 0,
    warningCount: (result.warnings || []).length,
    request: fetched.request,
    filter: fetched.filter,
    fetchedAt: fetched.fetchedAt,
    downloadedAt: new Date().toISOString()
  };
  await rememberLastDownload(STORAGE_KEYS.LAST_DOWNLOAD, lastDownloadEntry(summary));
  return summary;
}

/** Update only the status line shown at the bottom of the popup. */
async function recordLastStatus(status) {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.LAST_DOWNLOAD);
    const previous = stored[STORAGE_KEYS.LAST_DOWNLOAD] || {};
    await chrome.storage.local.set({ [STORAGE_KEYS.LAST_DOWNLOAD]: { ...previous, lastStatus: status } });
  } catch (error) {
    logger.debug("Could not record status", error);
  }
}

/** Only accept the documented option keys from the popup. */
function sanitiseOptions(raw) {
  const options = raw && typeof raw === "object" ? raw : {};
  const out = {};
  if (typeof options.mode === "string") out.mode = options.mode;
  if (typeof options.zone === "string") out.zone = options.zone;
  if (typeof options.dateFrom === "string") out.dateFrom = options.dateFrom;
  if (typeof options.dateTo === "string") out.dateTo = options.dateTo;
  out.destination = sanitiseDestination(options.destination);
  return out;
}

/**
 * Start a Bill Status run. `done` settles when it ends: { ok: true, summary } or
 * { ok: false, code, error } (the scheduler waits for it; a panel click does not).
 * `panelTabId`: the panel that started it, or SCHEDULED_RUN (its state and broadcasts say so).
 */
async function launchBillStatusJob(rawOptions, panelTabId, hooks = {}) {
  await restoreJobState();
  if (jobRunning) return { started: false, error: describeError("BUSY") };
  jobRunning = true;
  const startedBy = panelTabId ?? null;
  jobState = { ...jobState, startedBy };
  const options = sanitiseOptions(rawOptions);
  lastLoggedStep = "";
  logger.info("Bill Status started", { mode: options.mode || "last90Days", zone: options.zone || "-1", destination: options.destination });

  const done = holdWorker(async () => {
    try {
      const summary = await runDownloadWorkflow(options, panelTabId, hooks);
      await setJobState({ status: "complete", stage: STAGES.COMPLETE.id, message: STAGES.COMPLETE.label, result: summary, error: undefined });
      broadcast(MESSAGE_TYPES.IREPS_DOWNLOAD_COMPLETE, { ...summary, startedBy });
      logger.info(`Bill Status complete: ${summary.recordCount} bills saved as ${summary.storedPath || summary.filename}`, summary);
      return { ok: true, summary };
    } catch (error) {
      const code = error instanceof WorkflowError ? error.code : "UNKNOWN";
      const described = describeError(code, error instanceof WorkflowError ? error.details : {});
      if (code === "UNKNOWN") logger.error("Bill Status failed", error);
      else logger.warn(`Bill Status stopped: ${described.title}`, { code, message: described.message, status: (error && error.details && error.details.status) ?? null });
      if (code === IREPS_ERROR.SESSION_EXPIRED) forgetSessionChecks();
      await recordLastStatus(described.title);
      await setJobState({ status: "error", stage: STAGES.ERROR.id, message: described.title, error: described, result: undefined });
      broadcast(MESSAGE_TYPES.IREPS_DOWNLOAD_ERROR, { ...described, startedBy });
      return { ok: false, code, error: described };
    } finally {
      jobRunning = false;
      localJobEnded();
    }
  });

  return { started: true, done };
}

/** A launch's answer to the panel: whether it started (the `done` promise stays in the worker). */
function startedOnly({ done: _done, ...response }) {
  return response;
}

const startDownloadJob = (rawOptions, panelTabId) => launchBillStatusJob(rawOptions, panelTabId).then(startedOnly);


/* -------------------------------------------------------------------------- */
/* PO Search document workflows: CRN, R-NOTE (separate from Bill Status)      */
/* -------------------------------------------------------------------------- */

const EXPORT_BUILDERS = {
  [SEARCH_PO_CRITERIA.CRN]: buildCrnExport,
  [SEARCH_PO_CRITERIA.RNOTE]: buildRnoteExport
};
const RECON_DOC_TYPES = {
  [SEARCH_PO_CRITERIA.CRN]: RECON_DOC_TYPE.CRN,
  [SEARCH_PO_CRITERIA.RNOTE]: RECON_DOC_TYPE.RNOTE
};
const LAST_DOWNLOAD_KEYS = {
  [SEARCH_PO_CRITERIA.CRN]: STORAGE_KEYS.LAST_CRN_DOWNLOAD,
  [SEARCH_PO_CRITERIA.RNOTE]: STORAGE_KEYS.LAST_RNOTE_DOWNLOAD
};

/**
 * One job state per document type, so a CRN result stays visible while an
 * R-NOTE download runs. Only one PO Search job runs at a time (the portal's
 * single-use token makes parallel searches pointless).
 * @type {Record<string, { status: "idle"|"running"|"complete"|"error", stage: string, message: string, detail?: string, result?: object, error?: object, updatedAt: number }>}
 */
const documentJobs = {};
let documentJobRunning = null; // criteria of the running job, or null
/** Cache of the last PO Search form load (railway list) - never the HTML or the token. */
let lastSearchPoFormCheck = null;

/**
 * IREPS said the session expired (or a run found it so): both cached "the session is fine" answers
 * (the Bill Status page and the PO Search form) are stale now, so the next check asks IREPS (M4).
 */
function forgetSessionChecks() {
  lastSessionCheck = null;
  lastSearchPoFormCheck = null;
}

function documentJob(criteria) {
  if (!documentJobs[criteria]) documentJobs[criteria] = { status: "idle", stage: DOCUMENT_STAGES.IDLE.id, message: "", updatedAt: Date.now() };
  return documentJobs[criteria];
}

function typeLabel(criteria) {
  const type = SEARCH_PO_DOCUMENT_TYPES.find((t) => t.criteria === criteria);
  return type ? type.shortLabel : criteria;
}

let documentJobsRestored = false;
/** CRN / R-NOTE: the job states saved before a worker restart. */
async function restoreDocumentJobs() {
  if (documentJobsRestored) return;
  documentJobsRestored = true;
  if (documentJobRunning) return;
  const saved = await restoreSavedJob(SESSION_KEYS.DOCUMENT_JOBS, (all) => Object.values(all).some((j) => j && j.status === "running"), (all, error) =>
    Object.fromEntries(Object.entries(all).map(([criteria, j]) => [criteria, j && j.status === "running" ? { ...j, status: "error", stage: DOCUMENT_STAGES.ERROR.id, message: error.title, error: { ...error, criteria }, result: undefined } : j]))
  );
  if (!saved || documentJobRunning) return;
  for (const [criteria, j] of Object.entries(saved)) {
    if (j && (!documentJobs[criteria] || documentJobs[criteria].status === "idle")) documentJobs[criteria] = j;
  }
}

async function setDocumentJob(criteria, patch) {
  documentJobs[criteria] = { ...documentJob(criteria), ...patch, criteria, updatedAt: Date.now() };
  await persistSession(SESSION_KEYS.DOCUMENT_JOBS, documentJobs, "document job state");
}

async function documentProgress(criteria, stage, message, detail) {
  const text = message || documentStageLabel(stage, typeLabel(criteria));
  logger.info(`${typeLabel(criteria)}: ${text}`);
  await setDocumentJob(criteria, { status: "running", stage: stage.id, message: text, detail: detail || "", error: undefined });
  broadcast(MESSAGE_TYPES.DOCUMENT_PROGRESS, { criteria, stage: stage.id, message: text, detail: detail || "", startedBy: documentJob(criteria).startedBy ?? null });
}

const DOCUMENT_STAGE_FOR_PROGRESS = {
  [SEARCH_PO_FLOW_STAGES.CHECKING_SESSION]: DOCUMENT_STAGES.CHECKING_SESSION,
  [SEARCH_PO_FLOW_STAGES.CONNECTED]: DOCUMENT_STAGES.CONNECTED,
  [SEARCH_PO_FLOW_STAGES.SEARCHING]: DOCUMENT_STAGES.SEARCHING,
  [SEARCH_PO_FLOW_STAGES.PAGING]: DOCUMENT_STAGES.PAGING,
  [SEARCH_PO_FLOW_STAGES.PARSING]: DOCUMENT_STAGES.PARSING
};

/** Only accept the documented option keys from the popup. */
function sanitiseDocumentOptions(raw) {
  const options = raw && typeof raw === "object" ? raw : {};
  const out = {};
  for (const key of ["mode", "railway", "poNo", "dateFrom", "dateTo"]) {
    if (typeof options[key] === "string") out[key] = options[key].trim();
  }
  if (options.pageNo !== undefined && Number.isFinite(Number(options.pageNo))) out.pageNo = Number(options.pageNo);
  if (options.recordsPerPage !== undefined && Number.isFinite(Number(options.recordsPerPage))) out.recordsPerPage = Number(options.recordsPerPage);
  out.destination = sanitiseDestination(options.destination);
  // The Recon Engine reads Excel only, so an upload is always .xlsx.
  out.format = out.destination === SAVE_DESTINATION.RECON ? EXPORT_FORMAT.XLSX
    : Object.values(EXPORT_FORMAT).includes(options.format) ? options.format : EXPORT_FORMAT.XLSX;
  return out;
}

/**
 * Load the PO Search page once to (a) confirm the session and (b) hand the
 * popup the railway list. Cached for a few seconds like the Bill Status check.
 */
async function loadSearchPoFormInfo({ useCache = true } = {}) {
  const fresh = useCache && lastSearchPoFormCheck && Date.now() - lastSearchPoFormCheck.at < SESSION_CHECK_CACHE_MS ? lastSearchPoFormCheck.result : null;
  if (fresh && fresh.authenticated) return fresh;
  // while a DocLink search holds the IREPS session, loading the form would replace its Struts token (M2):
  // the railway list does not change, so the last one is answered instead; but only an answer that was
  // logged in, as the running search shows the session is alive: a cached "login required" or "IREPS not
  // responding" is never answered then, the busy answer is (as performSessionCheck does, 4.8)
  const whileBusy = () => (lastSearchPoFormCheck && lastSearchPoFormCheck.result.authenticated ? lastSearchPoFormCheck.result : { ...SESSION_BUSY_RESULT, form: null });
  return withIrepsFormLock(async () => fresh || loadSearchPoFormInfoNow(), { ifBusy: whileBusy });
}

async function loadSearchPoFormInfoNow() {
  let result;
  try {
    const page = await loadSearchPoPage();
    const verdict = validateSearchPoSession(page.html, page);
    result = {
      authenticated: verdict.authenticated,
      code: verdict.code,
      reason: verdict.reason,
      status: page.status,
      form: verdict.authenticated ? publicSearchPoFormInfo(extractSearchPoForm(page.html)) : null
    };
  } catch (error) {
    const code = error instanceof IrepsError ? error.code : "UNKNOWN";
    result = { authenticated: false, code, reason: error.message, detail: error instanceof IrepsError ? error.detail : null, status: error.status ?? null, form: null };
  }
  lastSearchPoFormCheck = { at: Date.now(), result };
  return result;
}

/**
 * Search one document type and download the result table as a file
 * (DocLink's version of the portal's "Export to Excel" - every row, not only
 * the visible page).
 * @param {string} criteria   "CRN" | "RNOTE"
 * @param {{ format: string, destination: string, mode?: string, railway?: string, poNo?: string, dateFrom?: string, dateTo?: string, recordsPerPage?: number }} options
 */
async function runDocumentDownloadWorkflow(criteria, options, panelTabId, hooks = {}) {
  const startedAt = new Date();
  const { format, destination, ...searchOptions } = options;
  const label = typeLabel(criteria);

  // Steps 1-5: page, session, token, search, parse, further result pages (shared layer).
  await documentProgress(criteria, DOCUMENT_STAGES.CHECKING_SESSION);
  let result;
  try {
    result = await searchIrepsDocuments({ ...searchOptions, criteria }, {
      parseHtml: (html, parseOptions) => parseSearchPoInOffscreen(html, parseOptions),
      onProgress: (stage, detail) => {
        const s = DOCUMENT_STAGE_FOR_PROGRESS[stage];
        if (!s) return;
        if (stage === SEARCH_PO_FLOW_STAGES.PAGING && detail) {
          const [n, m] = String(detail).split("/");
          documentProgress(criteria, s, `Loading ${label} result page ${n} of ${m}...`, detail);
        } else documentProgress(criteria, s);
      }
    });
  } catch (error) {
    if (error instanceof IrepsError) throw new WorkflowError(error.code, { status: error.status, detail: error.detail });
    throw error;
  }
  lastSearchPoFormCheck = { at: Date.now(), result: { authenticated: true, code: "OK", reason: null, status: 200, form: result.form } };

  // Step 6: export file (xlsx / csv) via the type-specific column set. No PDF is assumed.
  await documentProgress(criteria, DOCUMENT_STAGES.GENERATING_FILE, `Building the ${format === EXPORT_FORMAT.CSV ? "CSV" : "Excel"} file (${result.recordCount} ${label} records)...`);
  let file;
  try {
    const build = EXPORT_BUILDERS[criteria];
    if (!build) throw new Error(`No export builder for ${criteria}`);
    file = build(result, { format, now: startedAt });
  } catch (error) {
    logger.error(`${criteria} export generation failed`, error);
    throw new WorkflowError("DOCUMENT_EXPORT_ERROR");
  }

  // Step 7: save - Downloads folder or the Recon Engine (S3).
  const toRecon = destination === SAVE_DESTINATION.RECON;
  await documentProgress(criteria, DOCUMENT_STAGES.DOWNLOADING, toRecon ? "Uploading to the Recon Engine (S3)..." : undefined);
  const saveExport = hooks.saveExport || saveExportFile;
  const saved = await saveExport(file, {
    destination,
    docType: RECON_DOC_TYPES[criteria],
    localPath: buildDocumentExportDownloadPath(criteria, startedAt, file.extension),
    filename: buildDocumentExportFilename(criteria, startedAt, file.extension),
    localErrorCode: "DOCUMENT_DOWNLOAD_ERROR",
    records: result.records,
    label,
    ask: askPanel(panelTabId)
  });

  const summary = {
    criteria,
    typeLabel: label,
    ...savedSummary(saved),
    format: file.format,
    recordCount: result.recordCount,
    columnCount: file.columnCount,
    warningCount: (result.warnings || []).length,
    // fewer records read than IREPS reported (search-po-service.js): the panel and a scheduled run say so
    incomplete: result.incomplete || null,
    pagesFetched: result.pagination.pagesFetched,
    search: result.search,
    filter: result.filter,
    fetchedAt: result.fetchedAt,
    form: result.form,
    downloadedAt: new Date().toISOString()
  };
  const key = LAST_DOWNLOAD_KEYS[criteria];
  if (key) await rememberLastDownload(key, lastDownloadEntry(summary));
  return summary;
}

/** Start a CRN / R-NOTE run; `done` settles like launchBillStatusJob's (`panelTabId` too). */
async function launchDocumentJob(rawCriteria, rawOptions, panelTabId, hooks = {}) {
  const criteria = SEARCH_PO_DOCUMENT_TYPES.some((t) => t.criteria === rawCriteria) ? rawCriteria : null;
  if (!criteria) return { started: false, error: describeError(SEARCH_PO_ERROR.UNSUPPORTED_CRITERIA, { detail: String(rawCriteria) }) };
  await restoreDocumentJobs();
  if (documentJobRunning) return { started: false, error: describeError("DOCUMENT_BUSY") };
  documentJobRunning = criteria;
  const startedBy = panelTabId ?? null;
  documentJobs[criteria] = { ...documentJob(criteria), startedBy };
  const options = sanitiseDocumentOptions(rawOptions);
  logger.info(`${criteria} download started`, { mode: options.mode || "(inferred)", railway: options.railway || "-1", format: options.format, destination: options.destination });

  const done = holdWorker(async () => {
    try {
      const summary = await runDocumentDownloadWorkflow(criteria, options, panelTabId, hooks);
      const doneLabel = documentStageLabel(DOCUMENT_STAGES.COMPLETE, typeLabel(criteria));
      await setDocumentJob(criteria, { status: "complete", stage: DOCUMENT_STAGES.COMPLETE.id, message: doneLabel, result: summary, error: undefined });
      broadcast(MESSAGE_TYPES.DOCUMENT_DOWNLOAD_COMPLETE, { ...summary, startedBy });
      logger.info(`${typeLabel(criteria)} complete: ${summary.recordCount} records saved as ${summary.storedPath || summary.filename}`, { records: summary.recordCount, pages: summary.pagesFetched, format: summary.format, destination: summary.destination, downloadId: summary.downloadId });
      return { ok: true, summary };
    } catch (error) {
      const code = error instanceof WorkflowError ? error.code : "UNKNOWN";
      const described = { ...describeError(code, error instanceof WorkflowError ? error.details : {}), criteria };
      if (code === "UNKNOWN") logger.error(`${typeLabel(criteria)} failed`, error);
      else logger.warn(`${typeLabel(criteria)} stopped: ${described.title}`, { code, message: described.message, status: (error && error.details && error.details.status) ?? null });
      if (code === SEARCH_PO_ERROR.SESSION_EXPIRED) forgetSessionChecks();
      await setDocumentJob(criteria, { status: "error", stage: DOCUMENT_STAGES.ERROR.id, message: described.title, error: described, result: undefined });
      broadcast(MESSAGE_TYPES.DOCUMENT_DOWNLOAD_ERROR, { ...described, startedBy });
      return { ok: false, code, error: described };
    } finally {
      documentJobRunning = null;
      localJobEnded();
    }
  });

  return { started: true, done };
}

const startDocumentDownloadJob = (rawCriteria, rawOptions, panelTabId) => launchDocumentJob(rawCriteria, rawOptions, panelTabId).then(startedOnly);


/* -------------------------------------------------------------------------- */
/* MA copies workflow (search + per-MA PDF downloads)                         */
/* -------------------------------------------------------------------------- */

/**
 * The MA list a panel searched (startedBy: its tab id), and its downloads.
 * @type {{ status: "idle"|"searching"|"ready"|"downloading"|"complete"|"error", stage: string, message: string,
 *          detail?: string, search?: object|null, filter?: string|null, dateFilter?: object|null, fetchedAt?: string|null,
 *          recordCount: number, allRecordCount: number, records: object[], form?: object|null, warnings?: string[],
 *          incomplete?: string|null, pagination?: object|null, downloads?: object|null, error?: object|null,
 *          startedBy?: number|null, updatedAt: number }}
 */
let maState = emptyMaState();
let maRunning = false;
/** Who holds the MA job while it runs: a panel's tab id, SCHEDULED_RUN, or null. */
let maRunningFor = null;
let maRestored = false;
/**
 * The records a scheduled MA run found (background/scheduler-job.js runMa): kept apart from the panel's
 * list (maState), so an hourly slot never replaces the list or the selection someone is working on.
 */
let scheduledMaRecords = [];

function emptyMaState() {
  return {
    status: "idle",
    stage: MA_STAGES.IDLE.id,
    message: "",
    detail: "",
    search: null,
    filter: null,
    dateFilter: null,
    fetchedAt: null,
    recordCount: 0,
    allRecordCount: 0,
    records: [],
    form: null,
    warnings: [],
    incomplete: null,
    pagination: null,
    downloads: null,
    error: null,
    startedBy: null,
    updatedAt: Date.now()
  };
}

async function setMaState(patch) {
  maState = { ...maState, ...patch, updatedAt: Date.now() };
  // a long MA list can exceed the session quota: then keep the state without its records
  if (!(await persistSession(SESSION_KEYS.MA_STATE, maState, "MA state with records; storing without them"))) {
    await persistSession(SESSION_KEYS.MA_STATE, { ...maState, records: [], recordsDropped: true }, "MA state");
  }
}

/**
 * Reload the MA state after a service-worker restart (memory-only storage). A search or download that Chrome
 * cut off shows as interrupted (JOB_INTERRUPTED, as every other job): a search keeps no list; a download
 * keeps the list to download from again, without the summary of the run before it (7.16).
 */
async function restoreMaState() {
  if (maRestored) return;
  maRestored = true;
  if (maState.status !== "idle" || maRunning) return;
  const saved = await restoreSavedJob(SESSION_KEYS.MA_STATE, (s) => s.status === "searching" || s.status === "downloading", (s, error) =>
    s.status === "searching"
      ? { ...emptyMaState(), status: "error", stage: MA_STAGES.ERROR.id, message: error.title, error, startedBy: s.startedBy ?? null }
      : { ...s, status: "ready", stage: MA_STAGES.READY.id, message: error.title, downloads: null, error }
  );
  if (saved && saved.status && saved.status !== "idle" && maState.status === "idle" && !maRunning) maState = { ...saved, records: saved.records || [] };
}

function maProgress(stage, message, detail) {
  const text = message || stage.label;
  logger.info(`MA: ${text}`);
  setMaState({ status: maState.status === "downloading" ? "downloading" : "searching", stage: stage.id, message: text, detail: detail || "", error: null });
  broadcast(MESSAGE_TYPES.MA_PROGRESS, { stage: stage.id, message: text, detail: detail || "", status: maState.status, startedBy: maState.startedBy ?? null });
}

/** A step of a scheduled MA run, as the panels hear it: only that an MA job runs (their MA list is left as it is). */
function scheduledMaStep(type, payload = {}) {
  broadcast(type, { ...payload, startedBy: SCHEDULED_RUN });
}

const MA_STAGE_FOR_PROGRESS = {
  [MA_FLOW_STAGES.CHECKING_SESSION]: MA_STAGES.CHECKING_SESSION,
  [MA_FLOW_STAGES.CONNECTED]: MA_STAGES.CONNECTED,
  [MA_FLOW_STAGES.SEARCHING]: MA_STAGES.SEARCHING,
  [MA_FLOW_STAGES.PAGING]: MA_STAGES.PAGING,
  [MA_FLOW_STAGES.PARSING]: MA_STAGES.PARSING
};

/** Only accept the documented MA option keys from the popup. */
function sanitiseMaOptions(raw) {
  const options = raw && typeof raw === "object" ? raw : {};
  const out = {};
  for (const key of ["railway", "poNo", "dateMode", "date", "dateFrom", "dateTo"]) {
    if (typeof options[key] === "string") out[key] = options[key].trim();
  }
  if (options.recordsPerPage !== undefined && Number.isFinite(Number(options.recordsPerPage))) out.recordsPerPage = Number(options.recordsPerPage);
  return out;
}

/** Short, redaction-safe description of an unexpected error for the popup (no IREPS data is ever in these messages). */
function errorDetail(error) {
  const text = error && error.message ? String(error.message) : String(error || "unexpected error");
  return text.replace(/\s+/g, " ").trim().slice(0, 160) || "unexpected error";
}

/**
 * A job failure as the panel shows it: an IREPS error by its code, anything else as
 * UNKNOWN (and logged as an error). An expired session also drops the cached session check.
 */
function describeJobError(error, what) {
  let described;
  if (error instanceof IrepsError) {
    described = describeError(error.code, { status: error.status, detail: error.detail });
  } else {
    logger.error(`${what} failed`, error);
    described = describeError("UNKNOWN", { detail: errorDetail(error) });
  }
  if (described.code === IREPS_ERROR.SESSION_EXPIRED) forgetSessionChecks();
  return described;
}

/**
 * Start an MA search; `done` settles with { ok: true, recordCount, incomplete } or { ok: false, code, error }.
 * `panelTabId`: the panel that searches (its list becomes maState), or SCHEDULED_RUN: a scheduled run's
 * search keeps its records apart and leaves the panel's list and selection as they are.
 */
async function launchMaSearch(rawOptions, panelTabId = null) {
  await restoreMaState();
  if (maRunning) return { started: false, error: describeError("MA_BUSY") };
  maRunning = true;
  maRunningFor = panelTabId ?? null;
  const scheduled = panelTabId === SCHEDULED_RUN;
  const options = sanitiseMaOptions(rawOptions);
  logger.info("MA search started", { railway: options.railway || "-1", dateMode: options.dateMode || "date", date: options.date || "(today)", poNo: options.poNo ? "yes" : "no", scheduled });

  const done = holdWorker(async () => {
    try {
      if (scheduled) return await scheduledMaSearch(options);
      maState = { ...emptyMaState(), status: "searching", startedBy: panelTabId ?? null };
      maProgress(MA_STAGES.CHECKING_SESSION);
      const result = await searchMa(options, {
        parseHtml: (html, parseOptions) => parseSearchPoInOffscreen(html, parseOptions),
        onProgress: (stage, detail) => {
          const s = MA_STAGE_FOR_PROGRESS[stage];
          if (!s) return;
          if (stage === MA_FLOW_STAGES.PAGING && detail) {
            const [n, m] = String(detail).split("/");
            maProgress(s, `Loading MA result page ${n} of ${m}...`, detail);
          } else maProgress(s);
        }
      });
      await setMaState({
        status: "ready",
        stage: MA_STAGES.READY.id,
        message: `${result.recordCount} MA${result.recordCount === 1 ? "" : "s"} found`,
        detail: "",
        search: result.search,
        filter: result.filter,
        dateFilter: result.dateFilter,
        fetchedAt: result.fetchedAt,
        recordCount: result.recordCount,
        allRecordCount: result.allRecordCount,
        records: result.records,
        form: result.form,
        warnings: result.warnings.slice(0, 50),
        // fewer MAs read than IREPS reported: the MA view says so (the list is not complete)
        incomplete: result.incomplete || null,
        pagination: result.pagination,
        downloads: null,
        error: null
      });
      lastSearchPoFormCheck = { at: Date.now(), result: { authenticated: true, code: "OK", reason: null, status: 200, form: result.form } };
      broadcast(MESSAGE_TYPES.MA_SEARCH_COMPLETE, publicMaState());
      logger.info("MA search complete", { matched: result.recordCount, total: result.allRecordCount, pages: result.pagination.pagesFetched, filter: result.filter });
      return { ok: true, recordCount: result.recordCount, incomplete: result.incomplete || null };
    } catch (error) {
      const described = describeJobError(error, "MA search");
      if (described.code === MA_ERROR.SESSION_EXPIRED) forgetSessionChecks();
      logger.warn(`MA search stopped: ${described.title}`, { code: described.code, message: described.message, status: (error && error.status) ?? null, scheduled });
      if (scheduled) {
        scheduledMaStep(MESSAGE_TYPES.MA_ERROR, { ...described, phase: "search" });
      } else {
        await setMaState({ status: "error", stage: MA_STAGES.ERROR.id, message: described.title, error: described, records: [], recordCount: 0, downloads: null });
        broadcast(MESSAGE_TYPES.MA_ERROR, { ...described, phase: "search", startedBy: maState.startedBy ?? null });
      }
      return { ok: false, code: described.code, error: described };
    } finally {
      maRunning = false;
      maRunningFor = null;
      localJobEnded();
    }
  });

  return { started: true, done };
}

/** The search of a scheduled MA run: its records are kept for its own download (scheduledMaRecords), never in maState. */
async function scheduledMaSearch(options) {
  scheduledMaRecords = [];
  scheduledMaStep(MESSAGE_TYPES.MA_PROGRESS, { stage: MA_STAGES.SEARCHING.id, message: "Scheduled download: searching MAs...", status: "searching" });
  const result = await searchMa(options, { parseHtml: (html, parseOptions) => parseSearchPoInOffscreen(html, parseOptions) });
  scheduledMaRecords = result.records;
  lastSearchPoFormCheck = { at: Date.now(), result: { authenticated: true, code: "OK", reason: null, status: 200, form: result.form } };
  scheduledMaStep(MESSAGE_TYPES.MA_SEARCH_COMPLETE, { status: "ready", recordCount: result.recordCount });
  logger.info("Scheduled MA search complete", { matched: result.recordCount, total: result.allRecordCount, pages: result.pagination.pagesFetched, filter: result.filter });
  return { ok: true, recordCount: result.recordCount, incomplete: result.incomplete || null };
}

const startMaSearch = (rawOptions, panelTabId) => launchMaSearch(rawOptions, panelTabId).then(startedOnly);

/**
 * Start downloading MA copies; `done` settles with { ok: true, summary } or { ok: false, code, error }.
 * @param {string[]|"all"} selection   record ids to download, or "all"
 * @param {string} [destination]        SAVE_DESTINATION ("recon" = ECM / S3)
 * @param {number|string|null} panelTabId   the panel that downloads from its list, or SCHEDULED_RUN (the
 *        scheduled run's own records, saved through its hooks; the panel's MA state is not touched)
 * @param {{ documentHooks?: object }} [hooks]   a scheduled run's preflight / saveFile / onSaved
 */
async function launchMaDownload(selection, destination, panelTabId, hooks = {}) {
  await restoreMaState();
  if (maRunning) return { started: false, error: describeError("MA_BUSY") };
  const scheduled = panelTabId === SCHEDULED_RUN;
  // a panel downloads from the list it shows: never from a list another tab's search has put in its place (ids are positions)
  if (!scheduled && maState.startedBy != null && panelTabId != null && maState.startedBy !== panelTabId) {
    return { started: false, error: describeError("MA_LIST_REPLACED", { detail: "the MA list DocLink holds was searched in another tab" }) };
  }
  const list = scheduled ? scheduledMaRecords : maState.records;
  if (!Array.isArray(list) || list.length === 0) return { started: false, error: describeError(MA_ERROR.NOT_FOUND, { detail: "no MA list loaded" }) };
  const wanted = selection === "all" ? null : new Set(Array.isArray(selection) ? selection.map(String) : []);
  const records = wanted ? list.filter((r) => wanted.has(String(r.id))) : list;
  if (records.length === 0) return { started: false, error: describeError("MA_NO_SELECTION") };

  maRunning = true;
  const startedBy = panelTabId ?? maState.startedBy ?? null;
  maRunningFor = startedBy;
  logger.info("MA download started", { count: records.length, scheduled });
  const done = holdWorker(async () => {
    try {
      if (scheduled) return await scheduledMaDownload(records, hooks);
      // the run before this one's summary goes: it is never shown (or restored) as this run's (7.16)
      await setMaState({ status: "downloading", stage: MA_STAGES.DOWNLOADING.id, message: `Downloading ${records.length} MA cop${records.length === 1 ? "y" : "ies"}...`, downloads: null, error: null });
      broadcast(MESSAGE_TYPES.MA_PROGRESS, { stage: MA_STAGES.DOWNLOADING.id, message: maState.message, status: "downloading", startedBy });
      const summary = await downloadMaPdfs(records, {
        ...(hooks.documentHooks || (await documentRunHooks(destination, panelTabId))),
        onProgress: (snapshot) => {
          maState = { ...maState, downloads: snapshot, updatedAt: Date.now() };
          broadcast(MESSAGE_TYPES.MA_DOWNLOAD_PROGRESS, { downloads: snapshot, startedBy });
        }
      });
      const described = summary.sessionExpired ? describeError("MA_SESSION_EXPIRED_DURING_DOWNLOAD") : null;
      if (summary.sessionExpired) forgetSessionChecks();
      await setMaState({
        status: "complete",
        stage: MA_STAGES.COMPLETE.id,
        message: `${summary.completed} of ${summary.total} MA cop${summary.total === 1 ? "y" : "ies"} downloaded${summary.skipped ? ` (${summary.skipped} skipped: already downloaded)` : ""}`,
        downloads: summary,
        error: described
      });
      await rememberLastDownload(STORAGE_KEYS.LAST_MA_DOWNLOAD, {
        lastDownloadAt: summary.finishedAt,
        lastCompleted: summary.completed,
        lastFailed: summary.failed,
        lastTotal: summary.total,
        lastFilter: maState.filter,
        lastStatus: summary.failed ? `${summary.completed} downloaded, ${summary.failed} failed` : "Downloaded successfully"
      });
      broadcast(MESSAGE_TYPES.MA_DOWNLOAD_COMPLETE, { downloads: summary, error: described, message: maState.message, startedBy });
      logger.info("MA download finished", { completed: summary.completed, failed: summary.failed, skipped: summary.skipped, sessionExpired: summary.sessionExpired });
      flushDownloadLog();
      return { ok: true, summary };
    } catch (error) {
      const described = describeJobError(error, "MA download");
      logger.warn(`MA download stopped: ${described.title}`, { code: described.code, message: described.message, status: (error && error.status) ?? null, scheduled });
      if (scheduled) {
        scheduledMaStep(MESSAGE_TYPES.MA_ERROR, { ...described, phase: "download" });
      } else {
        await setMaState({ status: "ready", stage: MA_STAGES.READY.id, message: described.title, error: described });
        broadcast(MESSAGE_TYPES.MA_ERROR, { ...described, phase: "download", startedBy });
      }
      return { ok: false, code: described.code, error: described };
    } finally {
      maRunning = false;
      maRunningFor = null;
      localJobEnded();
    }
  });
  return { started: true, done };
}

/** The download of a scheduled MA run: S3 / ECM through its shared hooks only; the panel's MA state is not touched. */
async function scheduledMaDownload(records, hooks) {
  // never the local save a panel run falls back to: without the scheduled run's hooks nothing is downloaded
  if (!hooks.documentHooks) throw new Error("a scheduled MA download needs the scheduled run's hooks");
  scheduledMaStep(MESSAGE_TYPES.MA_PROGRESS, { stage: MA_STAGES.DOWNLOADING.id, message: `Scheduled download: ${records.length} MA cop${records.length === 1 ? "y" : "ies"}...`, status: "downloading" });
  const summary = await downloadMaPdfs(records, { ...hooks.documentHooks });
  if (summary.sessionExpired) forgetSessionChecks();
  scheduledMaStep(MESSAGE_TYPES.MA_DOWNLOAD_COMPLETE, { message: `Scheduled download: ${summary.completed} of ${summary.total} MA copies saved` });
  logger.info("Scheduled MA download finished", { completed: summary.completed, failed: summary.failed, skipped: summary.skipped, sessionExpired: summary.sessionExpired });
  flushDownloadLog();
  return { ok: true, summary };
}

const startMaDownload = (selection, destination, panelTabId) => launchMaDownload(selection, destination, panelTabId).then(startedOnly);

/**
 * State handed to the popup (records included; never HTML or tokens). `busyWith`: who holds the MA job
 * while it runs (a scheduled run leaves this list as it is, but the MA buttons wait for it).
 */
function publicMaState() {
  return { ...maState, running: maRunning, busyWith: maRunning ? maRunningFor : null };
}

async function resetMaState() {
  await restoreMaState();
  if (maRunning) return { ok: false, error: describeError("MA_BUSY") };
  maState = emptyMaState();
  try {
    await chrome.storage.session.remove(SESSION_KEYS.MA_STATE);
  } catch (error) {
    logger.debug("Could not clear the MA state", error);
  }
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* PO / Inspection Certificate download (one PO number, two independent jobs) */
/* -------------------------------------------------------------------------- */

/** @type {{ status: "idle"|"running"|"complete"|"error", stage: string, message: string, poNumber?: string|null, result?: object, error?: object|null, updatedAt: number }} */
let poState = { status: "idle", stage: PO_STAGES.IDLE.id, message: "", poNumber: null, updatedAt: Date.now() };
let poRunning = false;

/**
 * `retryItems`: the run's download items (each IC's link and filing), kept for its Retry; never sent to the panel.
 * @type {{ status: "idle"|"searching"|"downloading"|"complete"|"error", stage: string, message: string,
 *          poNumber?: string|null, count: number, downloads?: object|null, error?: object|null, retryItems?: object[], updatedAt: number }}
 */
let icState = { status: "idle", stage: IC_STAGES.IDLE.id, message: "", poNumber: null, count: 0, downloads: null, error: null, updatedAt: Date.now() };
let icRunning = false;

let poIcRestored = false;
/** PO and IC: the states saved before a worker restart. */
async function restorePoIcStates() {
  if (poIcRestored) return;
  poIcRestored = true;
  if (!poRunning && poState.status === "idle") {
    const saved = await restoreSavedJob(SESSION_KEYS.PO_STATE, (p) => p.status === "running", (p, error) => ({ ...p, status: "error", stage: PO_STAGES.ERROR.id, message: error.title, error, result: undefined }));
    if (saved && !poRunning && poState.status === "idle") poState = saved;
  }
  if (!icRunning && icState.status === "idle") {
    const saved = await restoreSavedJob(SESSION_KEYS.IC_STATE, (i) => i.status === "searching" || i.status === "downloading", (i, error) => ({ ...i, status: "error", stage: IC_STAGES.ERROR.id, message: error.title, error }));
    if (saved && !icRunning && icState.status === "idle") icState = saved;
  }
}

async function setPoState(patch) {
  poState = { ...poState, ...patch, updatedAt: Date.now() };
  await persistSession(SESSION_KEYS.PO_STATE, poState, "PO state");
}

async function setIcState(patch) {
  icState = { ...icState, ...patch, updatedAt: Date.now() };
  // a long IC list's retry items can exceed the session quota: then keep the state without them (a Retry then searches again)
  if (!(await persistSession(SESSION_KEYS.IC_STATE, icState, "IC state with its retry items; storing without them"))) {
    await persistSession(SESSION_KEYS.IC_STATE, { ...icState, retryItems: [] }, "IC state");
  }
}

const PO_STAGE_FOR_PROGRESS = {
  [PO_FLOW_STAGES.CHECKING_SESSION]: PO_STAGES.CHECKING_SESSION,
  [PO_FLOW_STAGES.CONNECTED]: PO_STAGES.CONNECTED,
  [PO_FLOW_STAGES.SEARCHING]: PO_STAGES.SEARCHING,
  [PO_FLOW_STAGES.PARSING]: PO_STAGES.PARSING
};
const IC_STAGE_FOR_PROGRESS = {
  [IC_FLOW_STAGES.CHECKING_SESSION]: IC_STAGES.CHECKING_SESSION,
  [IC_FLOW_STAGES.CONNECTED]: IC_STAGES.CONNECTED,
  [IC_FLOW_STAGES.SEARCHING]: IC_STAGES.SEARCHING,
  [IC_FLOW_STAGES.PARSING]: IC_STAGES.PARSING
};

/** Only accept a trimmed PO number string from the popup. */
function sanitisePoNumber(raw) {
  return typeof raw === "string" ? raw.trim() : "";
}

async function startPoDownload(rawPoNo, destination, panelTabId) {
  await restorePoIcStates();
  if (poRunning) return { started: false, error: describeError("PO_BUSY") };
  const poNo = sanitisePoNumber(rawPoNo);
  if (!poNo) return { started: false, error: describeError("IREPS_INVALID_REQUEST", { detail: "Please enter a PO Number." }) };
  poRunning = true;
  const startedBy = panelTabId ?? null;
  logger.info("PO download started", { poNo });

  holdWorker(async () => {
    try {
      await setPoState({ status: "running", stage: PO_STAGES.CHECKING_SESSION.id, message: PO_STAGES.CHECKING_SESSION.label, poNumber: poNo, error: null, result: undefined, startedBy });
      broadcast(MESSAGE_TYPES.PO_PROGRESS, { poNumber: poNo, stage: PO_STAGES.CHECKING_SESSION.id, message: PO_STAGES.CHECKING_SESSION.label, startedBy });
      const result = await downloadPo(poNo, {
        ...(await documentRunHooks(destination, panelTabId)),
        parseHtml: (html, options) => parseSearchPoInOffscreen(html, { ...options, criteria: SEARCH_PO_CRITERIA.PO }),
        onProgress: (stage) => {
          const s = PO_STAGE_FOR_PROGRESS[stage];
          if (!s) return;
          logger.info(`PO ${poNo}: ${s.label}`);
          setPoState({ stage: s.id, message: s.label });
          broadcast(MESSAGE_TYPES.PO_PROGRESS, { poNumber: poNo, stage: s.id, message: s.label, startedBy });
        }
      });
      // the PO as IREPS shows it, the number it is filed under (item 6.6), else the number typed
      const filedAs = result.poNumber || poNo;
      const message = result.skipped ? `PO ${filedAs} not downloaded again` : PO_STAGES.COMPLETE.label;
      await setPoState({ status: "complete", stage: PO_STAGES.COMPLETE.id, message, result, error: null });
      if (!result.skipped) {
        await rememberLastDownload(STORAGE_KEYS.LAST_PO_DOWNLOAD, { lastDownloadAt: new Date().toISOString(), lastDownloadFilename: result.filename, lastPoNumber: filedAs, lastStatus: "Downloaded successfully" });
      }
      broadcast(MESSAGE_TYPES.PO_DOWNLOAD_COMPLETE, { poNumber: poNo, ...result, startedBy });
      logger.info(result.skipped ? "PO download skipped: already downloaded" : "PO download complete", { poNo, filename: result.filename, skip: result.skip ? result.skip.reason : null });
      flushDownloadLog();
    } catch (error) {
      const described = describeJobError(error, "PO download");
      if (error instanceof IrepsError) logger.warn(`PO download stopped: ${described.title}`, { poNo, code: error.code, message: described.message, status: error.status ?? null });
      await setPoState({ status: "error", stage: PO_STAGES.ERROR.id, message: described.title, error: described, result: undefined });
      broadcast(MESSAGE_TYPES.PO_DOWNLOAD_ERROR, { poNumber: poNo, ...described, startedBy });
    } finally {
      poRunning = false;
      // a scheduled download that waited for this one may start now (5.9)
      localJobEnded();
    }
  });

  return { started: true };
}

async function startIcDownload(rawPoNo, destination, panelTabId) {
  await restorePoIcStates();
  if (icRunning) return { started: false, error: describeError("IC_BUSY") };
  const poNo = sanitisePoNumber(rawPoNo);
  if (!poNo) return { started: false, error: describeError("IREPS_INVALID_REQUEST", { detail: "Please enter a PO Number." }) };
  icRunning = true;
  const startedBy = panelTabId ?? null;
  logger.info("IC download started", { poNo });

  holdWorker(async () => {
    try {
      await setIcState({ status: "searching", stage: IC_STAGES.CHECKING_SESSION.id, message: IC_STAGES.CHECKING_SESSION.label, poNumber: poNo, count: 0, downloads: null, warnings: [], error: null, retryItems: [], startedBy });
      broadcast(MESSAGE_TYPES.IC_PROGRESS, { poNumber: poNo, stage: IC_STAGES.CHECKING_SESSION.id, message: IC_STAGES.CHECKING_SESSION.label, status: "searching", startedBy });
      let announcedCount = false;
      const hooks = await documentRunHooks(destination, panelTabId);
      let items = [];
      const result = await downloadInspectionCertificates(poNo, {
        ...hooks,
        // every IC's download item passes here before anything is fetched: kept, so that a Retry fetches only
        // the failed ICs again, by the links this search read (7.3)
        preflight: async (list) => {
          items = list;
          return hooks.preflight ? hooks.preflight(list) : { skip: new Map() };
        },
        parseHtml: (html, options) => parseIcInOffscreen(html, poNo, options),
        onProgress: (stage) => {
          const s = IC_STAGE_FOR_PROGRESS[stage];
          if (!s) return;
          logger.info(`IC ${poNo}: ${s.label}`);
          setIcState({ stage: s.id, message: s.label });
          broadcast(MESSAGE_TYPES.IC_PROGRESS, { poNumber: poNo, stage: s.id, message: s.label, status: "searching", startedBy });
        },
        onDownloadProgress: (snapshot) => {
          if (!announcedCount) {
            announcedCount = true;
            const label = `${snapshot.total} issued Inspection Certificate${snapshot.total === 1 ? "" : "s"} found`;
            setIcState({ status: "downloading", stage: IC_STAGES.DOWNLOADING.id, message: snapshot.total ? `Downloading ${label}...` : "No issued Inspection Certificates were found for this PO.", count: snapshot.total, downloads: snapshot });
            broadcast(MESSAGE_TYPES.IC_PROGRESS, { poNumber: poNo, stage: IC_STAGES.DOWNLOADING.id, message: label, status: "downloading", startedBy });
          } else {
            icState = { ...icState, downloads: snapshot, updatedAt: Date.now() };
          }
          broadcast(MESSAGE_TYPES.IC_DOWNLOAD_PROGRESS, { poNumber: poNo, downloads: snapshot, startedBy });
        }
      });
      await finishIcRun(poNo, result, startedBy, items);
    } catch (error) {
      await failIcRun(poNo, error, startedBy, "IC download");
    } finally {
      icRunning = false;
      // a scheduled download that waited for this one may start now (5.9)
      localJobEnded();
    }
  });

  return { started: true };
}

/**
 * An IC run (or its retry) ended: its state (with the download items a Retry needs), the last IC download
 * line, and the panel's result.
 */
async function finishIcRun(poNo, result, startedBy, retryItems) {
  const described = result.downloads.sessionExpired ? describeError("IC_SESSION_EXPIRED_DURING_DOWNLOAD") : null;
  if (result.downloads.sessionExpired) forgetSessionChecks();
  // the search's own warnings (a list short of IREPS's total, a page limit) are shown with the result (1.19)
  const warnings = result.warnings || [];
  const message =
    result.count === 0
      ? "No issued Inspection Certificates were found for this PO."
      : `${result.downloads.completed} of ${result.downloads.total} Inspection Certificate${result.downloads.total === 1 ? "" : "s"} downloaded${result.downloads.skipped ? ` (${result.downloads.skipped} skipped: already downloaded)` : ""}`;
  await setIcState({ status: "complete", stage: IC_STAGES.COMPLETE.id, message, count: result.count, downloads: result.downloads, warnings, error: described, retryItems });
  await rememberLastDownload(STORAGE_KEYS.LAST_IC_DOWNLOAD, {
    lastDownloadAt: result.downloads.finishedAt,
    lastPoNumber: poNo,
    lastCount: result.count,
    lastCompleted: result.downloads.completed,
    lastFailed: result.downloads.failed,
    lastStatus: result.downloads.failed ? `${result.downloads.completed} downloaded, ${result.downloads.failed} failed` : message
  });
  broadcast(MESSAGE_TYPES.IC_DOWNLOAD_COMPLETE, { poNumber: poNo, count: result.count, downloads: result.downloads, warnings, error: described, message, startedBy });
  logger.info("IC download finished", { poNo, count: result.count, completed: result.downloads.completed, failed: result.downloads.failed, skipped: result.downloads.skipped });
  flushDownloadLog();
}

/** An IC run (or its retry) stopped with an error. */
async function failIcRun(poNo, error, startedBy, what) {
  const described = describeJobError(error, what);
  if (error instanceof IrepsError) logger.warn(`${what} stopped: ${described.title}`, { poNo, code: error.code, message: described.message, status: error.status ?? null });
  await setIcState({ status: "error", stage: IC_STAGES.ERROR.id, message: described.title, error: described });
  broadcast(MESSAGE_TYPES.IC_DOWNLOAD_ERROR, { poNumber: poNo, ...described, startedBy });
}

/** The IC downloader's error codes, as ic-service.js downloads ICs: a retried IC fails as it would in its run. */
const IC_DOWNLOAD_CODES = Object.freeze({
  LINK_NOT_FOUND: IC_ERROR.LINK_NOT_FOUND,
  DOWNLOAD_FAILED: IC_ERROR.DOWNLOAD_FAILED,
  INVALID_PDF: IC_ERROR.INVALID_PDF,
  SESSION_EXPIRED: IC_ERROR.SESSION_EXPIRED
});

/** The download items of the IC run's failed ICs worth another try (a row without an IC link never succeeds). */
function failedIcItems(state) {
  const items = (state.downloads && state.downloads.items) || [];
  const failed = new Set(items.filter((i) => i.status === DOCUMENT_DOWNLOAD_STATUS.FAILED && !(i.error && i.error.code === IC_ERROR.LINK_NOT_FOUND)).map((i) => i.id));
  return (state.retryItems || []).filter((item) => item.url && failed.has(item.id));
}

/** The IC run's downloads with the retried ICs' new outcome; every other IC stays as it ended. */
function mergeIcDownloads(previous, retried) {
  const byId = new Map(retried.items.map((i) => [i.id, i]));
  const items = previous.items.map((i) => byId.get(i.id) || i);
  const count = (status) => items.filter((i) => i.status === status).length;
  return {
    ...previous,
    total: items.length,
    queued: count(DOCUMENT_DOWNLOAD_STATUS.QUEUED),
    downloading: count(DOCUMENT_DOWNLOAD_STATUS.DOWNLOADING),
    completed: count(DOCUMENT_DOWNLOAD_STATUS.COMPLETED),
    failed: count(DOCUMENT_DOWNLOAD_STATUS.FAILED),
    skipped: count(DOCUMENT_DOWNLOAD_STATUS.SKIPPED),
    sessionExpired: retried.sessionExpired === true,
    warnings: [...new Set([...(previous.warnings || []), ...(retried.warnings || [])])],
    items,
    finishedAt: retried.finishedAt || previous.finishedAt
  };
}

/**
 * "Retry failed downloads" of the IC result (7.3): the failed ICs of the last IC run, for that run's own PO
 * (never the PO now typed in the box), fetched again by the links its search read, without a new search,
 * and only from the panel that started the run. A run whose items were not kept (one from before a worker
 * update) is searched again, for its own PO.
 */
async function retryIcDownload(destination, panelTabId) {
  await restorePoIcStates();
  if (icRunning) return { started: false, error: describeError("IC_BUSY") };
  const owner = icState.startedBy ?? null;
  if (owner === SCHEDULED_RUN || (owner !== null && panelTabId !== null && owner !== panelTabId)) {
    return { started: false, error: describeError("BATCH_RETRY_ELSEWHERE", { detail: "the Inspection Certificate download DocLink holds was not started in this tab" }) };
  }
  const items = icState.status === "complete" ? failedIcItems(icState) : [];
  if (items.length === 0) return startIcDownload(icState.poNumber, destination, panelTabId);
  icRunning = true;
  const poNo = icState.poNumber;
  const previous = icState.downloads;
  const startedBy = panelTabId ?? owner;
  logger.info("IC retry started", { poNo, count: items.length });

  holdWorker(async () => {
    try {
      const message = `Retrying ${items.length} Inspection Certificate${items.length === 1 ? "" : "s"}...`;
      await setIcState({ status: "downloading", stage: IC_STAGES.DOWNLOADING.id, message, error: null, startedBy });
      broadcast(MESSAGE_TYPES.IC_PROGRESS, { poNumber: poNo, stage: IC_STAGES.DOWNLOADING.id, message, status: "downloading", startedBy });
      // a retry only fetches what failed, so it is not checked against the download log again (as a batch retry)
      const { saveFile, onSaved } = await documentRunHooks(destination, panelTabId, { preflight: false });
      const retried = await downloadIrepsDocuments(items, {
        saveFile,
        onSaved,
        codes: IC_DOWNLOAD_CODES,
        onProgress: (snapshot) => {
          const downloads = mergeIcDownloads(previous, snapshot);
          icState = { ...icState, downloads, updatedAt: Date.now() };
          broadcast(MESSAGE_TYPES.IC_DOWNLOAD_PROGRESS, { poNumber: poNo, downloads, startedBy });
        }
      });
      await finishIcRun(poNo, { count: icState.count, downloads: mergeIcDownloads(previous, retried), warnings: icState.warnings || [] }, startedBy, icState.retryItems);
    } catch (error) {
      await failIcRun(poNo, error, startedBy, "IC retry");
    } finally {
      icRunning = false;
      // a scheduled download that waited for this one may start now (5.9)
      localJobEnded();
    }
  });

  return { started: true };
}


/* -------------------------------------------------------------------------- */
/* Batch downloads: PO by date, IC from main-page notifications               */
/* -------------------------------------------------------------------------- */

/**
 * Each batch workflow keeps one state object (kind "po-date" / "ic-date" /
 * "ic-notif"); the popup is a pure view of it. The state is broadcast
 * (throttled) as BATCH_UPDATE, mirrored into chrome.storage.session for a
 * popup that opens later, and the full state (including what a retry needs)
 * stays in memory here.
 *
 * `batch` holds the last batch a panel started (startedBy: its tab id): what the panel shows and what
 * its Retry repeats. A scheduled run's batch is kept apart in `scheduledBatch`: it never replaces the
 * panel's finished batch, and its failures are never offered for a Retry in the panel (7.1, 7.2).
 */
const BATCH_KINDS = ["po-date", "ic-date", "ic-notif"];
const batch = { "po-date": null, "ic-date": null, "ic-notif": null };
const scheduledBatch = { "po-date": null, "ic-date": null, "ic-notif": null };
const batchRunning = { "po-date": false, "ic-date": false, "ic-notif": false };
/** Who runs the batch of a kind while it runs: a panel's tab id, SCHEDULED_RUN, or null. */
const batchRunningFor = { "po-date": null, "ic-date": null, "ic-notif": null };
const anyBatchRunning = () => BATCH_KINDS.some((k) => batchRunning[k]);
const batchTimers = {};

/**
 * The panel's batch state of a kind. `running`: its own run goes on; `busyWith`: who runs a batch of
 * the kind now (a scheduled run is busy without being this state's run).
 */
function publicBatchState(kind) {
  const state = batch[kind];
  const busyWith = batchRunning[kind] ? batchRunningFor[kind] : null;
  const running = batchRunning[kind] && busyWith !== SCHEDULED_RUN;
  // a panel's run that has just started has no state yet: it is still that panel's (startedBy)
  if (!state) return { kind, phase: "idle", running, busyWith, startedBy: running ? busyWith : null };
  return { ...(kind === "ic-notif" ? publicIcState(state) : state), running, busyWith };
}

/** A scheduled batch starts or ends: the panels hear only that (their own batch state is left as it is). */
function announceScheduledBatch(kind, running) {
  broadcast(MESSAGE_TYPES.BATCH_UPDATE, { kind, state: { kind, phase: running ? "searching" : "complete", running, busyWith: running ? SCHEDULED_RUN : null, startedBy: SCHEDULED_RUN } });
}

function pushBatchState(kind, { immediately = false } = {}) {
  const send = () => {
    batchTimers[kind] = null;
    const snapshot = publicBatchState(kind);
    broadcast(MESSAGE_TYPES.BATCH_UPDATE, { kind, state: snapshot });
    chrome.storage.session.set({ [`${SESSION_KEYS.BATCH_STATE}.${kind}`]: snapshot }).catch((error) => logger.debug("Could not persist batch state", error));
  };
  if (immediately) {
    if (batchTimers[kind]) clearTimeout(batchTimers[kind]);
    send();
  } else if (!batchTimers[kind]) {
    batchTimers[kind] = setTimeout(send, 250);
  }
}

async function restoreBatchState(kind) {
  if (batch[kind] || batchRunning[kind]) return;
  try {
    const stored = await chrome.storage.session.get(`${SESSION_KEYS.BATCH_STATE}.${kind}`);
    const saved = stored[`${SESSION_KEYS.BATCH_STATE}.${kind}`];
    // A run that was in flight when the worker stopped cannot continue; show it as stopped.
    if (saved) {
      const { running, ...rest } = saved;
      batch[kind] = rest.phase === "complete" || rest.phase === "error" ? rest : { ...rest, phase: "error", error: describeError("UNKNOWN", { detail: "the download was interrupted" }) };
    }
  } catch (error) {
    logger.debug("Could not restore batch state", error);
  }
}

/** The state to hand to the retry functions: re-adds the working indexes of the IC run after a restore. */
function ensureIcIndexes(state) {
  if (state.urlIndex) return state;
  state.urlIndex = new Map(state.items.filter((i) => i.url).map((i) => [i.url, i]));
  state.pathIndex = new Set(state.items.map((i) => i.path));
  state.lookupCache = new Map();
  return state;
}

function batchErrorState(kind, previous, error, startedBy = null) {
  const described = describeJobError(error, `${kind} batch`);
  if (error instanceof IrepsError) logger.warn(`${kind} batch stopped: ${described.title}`, { code: error.code, status: error.status ?? null });
  return { ...(previous || { kind }), kind, phase: "error", error: described, finishedAt: new Date().toISOString(), startedBy };
}

/** Save the IC manifest (identifiers and outcomes only - never cookies, tokens or headers). */
async function saveIcManifest(state) {
  if (!state.manifest || state.manifest.length === 0) return;
  try {
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
    const payload = { generatedAt: new Date().toISOString(), counts: state.counts, records: state.manifest };
    const saved = await downloadBytes(new TextEncoder().encode(JSON.stringify(payload, null, 2)), {
      path: `${IC_DOWNLOAD_SUBFOLDER}/IC_notifications_manifest_${stamp}.json`,
      mimeType: "application/json"
    });
    state.manifestFile = saved.filename;
  } catch (error) {
    logger.warn("Could not save the IC manifest", error);
  }
}

/**
 * `saveManifest: false` (a scheduled run: S3 / ECM only) leaves out the IC run's local manifest file.
 * `startedBy`: the panel's tab id, or SCHEDULED_RUN (its state goes to scheduledBatch, never to the panel's).
 */
function runBatch(kind, work, { saveManifest = true, startedBy = null } = {}) {
  return holdWorker(() => runBatchHeld(kind, work, { saveManifest, startedBy }));
}

async function runBatchHeld(kind, work, { saveManifest, startedBy }) {
  const scheduled = startedBy === SCHEDULED_RUN;
  const store = scheduled ? scheduledBatch : batch;
  batchRunning[kind] = true;
  batchRunningFor[kind] = startedBy;
  if (scheduled) announceScheduledBatch(kind, true);
  const update = (state) => {
    state.startedBy = startedBy;
    store[kind] = state;
    if (!scheduled) pushBatchState(kind);
  };
  try {
    const finalState = await work(update);
    finalState.startedBy = startedBy;
    store[kind] = finalState;
    if (kind === "ic-notif" && saveManifest) await saveIcManifest(finalState);
    if (finalState.sessionExpired) forgetSessionChecks();
    await chrome.storage.local.set({ [`doclink.last.${kind}`]: { at: new Date().toISOString(), counts: finalState.counts } }).catch((error) => logger.debug("Could not record the batch summary", error));
  } catch (error) {
    store[kind] = batchErrorState(kind, store[kind], error, startedBy);
  } finally {
    batchRunning[kind] = false;
    batchRunningFor[kind] = null;
    if (scheduled) announceScheduledBatch(kind, false);
    else pushBatchState(kind, { immediately: true });
    flushDownloadLog();
    localJobEnded();
  }
}

/** Parser bridges to the offscreen document, per workflow. */
function batchParser(kind) {
  return kind === "po-date"
    ? (html, options) => parseSearchPoInOffscreen(html, { ...options, criteria: SEARCH_PO_CRITERIA.PO })
    : (html, options) => parseIcInOffscreen(html, (options && options.poNo) || null, options);
}

/**
 * Save to (Local / ECM / S3) applies to a batch as to a single PO or IC download: each run and
 * each retry takes the user's current choice. The saver is built inside the run, so an
 * account lookup that fails ends as the batch's error state, not an unanswered message.
 * `done` settles with the batch's final state; a scheduled run (panelTabId SCHEDULED_RUN) passes its own
 * documentHooks, and its state is kept apart from the panel's (scheduledBatch).
 */
async function launchBatch(message, hooks = {}) {
  const kind = message.kind;
  if (!BATCH_KINDS.includes(kind)) return { started: false, error: describeError("UNKNOWN", { detail: "unknown download type" }) };
  if (anyBatchRunning()) return { started: false, error: describeError("BATCH_BUSY") };
  const startedBy = message.panelTabId ?? null;
  const scheduled = startedBy === SCHEDULED_RUN;
  const store = scheduled ? scheduledBatch : batch;
  const destination = sanitiseDestination(message.destination);
  const runHooks = async () => hooks.documentHooks || documentRunHooks(destination, startedBy);
  const options = { saveManifest: !hooks.documentHooks, startedBy };
  let running;
  if (kind === "po-date") {
    const dateFrom = isoToIrepsDate(message.dateFrom) || message.dateFrom;
    const dateTo = isoToIrepsDate(message.dateTo) || message.dateTo;
    store[kind] = null;
    running = runBatch(kind, async (update) => runPoDateDownload({ dateFrom, dateTo }, { parseHtml: batchParser(kind), ...(await runHooks()), onUpdate: update }), options);
  } else if (kind === "ic-date") {
    const dateFrom = isoToIrepsDate(message.dateFrom) || message.dateFrom;
    const dateTo = isoToIrepsDate(message.dateTo) || message.dateTo;
    store[kind] = null;
    running = runBatch(kind, async (update) => runIcDateDownload({ dateFrom, dateTo }, { parseHtml: batchParser(kind), ...(await runHooks()), onUpdate: update }), options);
  } else {
    store[kind] = null;
    running = runBatch(kind, async (update) => runIcNotificationDownload({ parseHtml: batchParser(kind), ...(await runHooks()), onUpdate: update }), options);
  }
  if (!scheduled) pushBatchState(kind, { immediately: true });
  return { started: true, done: running.then(() => store[kind]) };
}

const startBatch = (message) => launchBatch(message).then(startedOnly);

/**
 * Retry the failed documents of the panel's finished batch, from the panel that started it. A batch
 * another tab started (or a newer one that replaced the panel's) is refused, and a scheduled run's
 * batch is never in `batch` at all: its failures go to the next scheduled check, never to a panel run.
 */
async function retryBatch(kind, rawDestination, panelTabId) {
  await restoreBatchState(kind);
  if (anyBatchRunning()) return { started: false, error: describeError("BATCH_BUSY") };
  const state = batch[kind];
  if (!state || state.phase !== "complete") return { started: false, error: describeError("UNKNOWN", { detail: "nothing to retry" }) };
  const startedBy = state.startedBy ?? null;
  if (startedBy === SCHEDULED_RUN || (startedBy !== null && panelTabId !== null && startedBy !== panelTabId)) {
    return { started: false, error: describeError("BATCH_RETRY_ELSEWHERE", { detail: "the batch DocLink holds was not started in this tab" }) };
  }
  const destination = sanitiseDestination(rawDestination);
  // a retry only fetches what failed, so it is not checked against the log again
  const hooks = async () => documentRunHooks(destination, panelTabId, { preflight: false });
  const options = { startedBy: panelTabId ?? startedBy };
  if (kind === "po-date") runBatch(kind, async (update) => retryPoDateFailures(state, { parseHtml: batchParser(kind), ...(await hooks()), onUpdate: () => update(state) }).then(() => state), options);
  else if (kind === "ic-date") runBatch(kind, async (update) => retryIcDateFailures(state, { parseHtml: batchParser(kind), ...(await hooks()), onUpdate: () => update(state) }).then(() => state), options);
  else runBatch(kind, async (update) => retryIcNotificationFailures(ensureIcIndexes(state), { parseHtml: batchParser(kind), ...(await hooks()), onUpdate: () => update(state) }), options);
  pushBatchState(kind, { immediately: true });
  return { started: true };
}

/* -------------------------------------------------------------------------- */
/* Message router                                                             */
/* -------------------------------------------------------------------------- */

/** Bill upload (ECM invoice -> IREPS supplier bill, started by hand): background/bill-upload-job.js */
const billUploadJob = createBillUploadJob({
  broadcast,
  parseSearchPo: (html, options) => parseSearchPoInOffscreen(html, options),
  // a scheduled download that waited for the bill upload may run once its step ends (inspection 5.9)
  onJobEnded: () => localJobEnded()
});

/** Phase 1 scheduled downloads (config.json "schedular_phase1"): background/scheduler-job.js */
const schedulerJob = createSchedulerJob({
  broadcast,
  launch: { billStatus: launchBillStatusJob, document: launchDocumentJob, maSearch: launchMaSearch, maDownload: launchMaDownload, batch: launchBatch },
  isBusy: () => jobRunning || Boolean(documentJobRunning) || maRunning || poRunning || icRunning || anyBatchRunning() || billUploadJob.isBusy(),
  readIrepsAccount: () => readActiveIrepsAccount(),
  irepsBaseUrl: () => IREPS_CONFIG.baseUrl
});

/** A job ended: a scheduled download that waited for it may start (background/scheduler-job.js). */
function localJobEnded() {
  schedulerJob.jobEnded();
}

const handlers = {
  ...billUploadJob,
  ...schedulerJob.handlers,
  [MESSAGE_TYPES.CHECK_IREPS_SESSION]: async (message) => {
    const result = await performSessionCheck({ useCache: !message.force });
    // IREPS just answered "logged in": a scheduled download that waits for an IREPS user may run
    if (result.authenticated && !result.busy) schedulerJob.onIrepsActive().catch((error) => logger.warn("Scheduler: IREPS activity not recorded", error));
    return publicSessionInfo(result);
  },
  [MESSAGE_TYPES.DOWNLOAD_IREPS_BILL_STATUS]: (message) => startDownloadJob(message.options, panelTabOf(message)),
  [MESSAGE_TYPES.GET_JOB_STATE]: async () => {
    await restoreJobState();
    return jobState;
  },
  [MESSAGE_TYPES.OPEN_IREPS]: async (message) => {
    const url = `${IREPS_CONFIG.baseUrl}${IREPS_CONFIG.homePath}`;
    // From a side panel: load IREPS in that panel's own tab, so the panel
    // (which belongs to the tab) stays open and switches to DocLink's tools.
    if (typeof message.tabId === "number") {
      try {
        await chrome.tabs.update(message.tabId, { url, active: true });
        return { ok: true };
      } catch {
        /* tab gone: fall back to a new tab */
      }
    }
    await chrome.tabs.create({ url });
    return { ok: true };
  },
  // Which view the side panel shows for a tab (see utils/url-scope.js).
  [MESSAGE_TYPES.GET_TAB_SCOPE]: (message) => classifyTabUrl(message.url, IREPS_CONFIG, chrome.runtime.getManifest().host_permissions || []),
  [MESSAGE_TYPES.OPEN_PREVIEW]: async () => {
    await chrome.tabs.create({ url: PREVIEW_URL });
    return { ok: true };
  },
  // Sign-in for "Save to: Recon Engine (S3)": the Recon Engine opens in a new tab, IREPS stays put.
  [MESSAGE_TYPES.OPEN_RECON]: async () => {
    await loadReconConfig();
    if (!RECON_CONFIG.appUrl) return { ok: false, error: describeError("RECON_NOT_CONFIGURED", { detail: "reconBaseUrl is not set in config.json" }) };
    await chrome.tabs.create({ url: RECON_CONFIG.appUrl });
    return { ok: true };
  },

  // PO Search document workflows (CRN, R-NOTE)
  [MESSAGE_TYPES.SEARCH_PO_LOAD_FORM]: (message) => loadSearchPoFormInfo({ useCache: !message.force }),
  [MESSAGE_TYPES.DOWNLOAD_IREPS_DOCUMENTS]: (message) => startDocumentDownloadJob(message.criteria, message.options, panelTabOf(message)),
  [MESSAGE_TYPES.GET_DOCUMENT_JOB_STATE]: async (message) => {
    await restoreDocumentJobs();
    return { ...documentJob(message.criteria), criteria: message.criteria, running: documentJobRunning };
  },

  // MA copies
  [MESSAGE_TYPES.MA_SEARCH]: (message) => startMaSearch(message.options, panelTabOf(message)),
  [MESSAGE_TYPES.MA_DOWNLOAD]: (message) => startMaDownload(message.ids, message.destination, panelTabOf(message)),
  [MESSAGE_TYPES.GET_MA_STATE]: async () => {
    await restoreMaState();
    return publicMaState();
  },
  [MESSAGE_TYPES.MA_RESET]: () => resetMaState(),

  // PO / Inspection Certificate (one PO number, two independent downloads)
  [MESSAGE_TYPES.PO_DOWNLOAD]: (message) => startPoDownload(message.poNo, message.destination, panelTabOf(message)),
  [MESSAGE_TYPES.GET_PO_STATE]: async () => {
    await restorePoIcStates();
    return { ...poState, running: poRunning };
  },
  [MESSAGE_TYPES.IC_DOWNLOAD]: (message) => startIcDownload(message.poNo, message.destination, panelTabOf(message)),
  [MESSAGE_TYPES.IC_RETRY]: (message) => retryIcDownload(message.destination, panelTabOf(message)),
  [MESSAGE_TYPES.GET_IC_STATE]: async () => {
    await restorePoIcStates();
    // the run's download items (IREPS links) stay here: the panel shows only how each IC ended
    const { retryItems, ...state } = icState;
    return { ...state, running: icRunning };
  },

  // Batch downloads: PO by date, IC from notifications
  [MESSAGE_TYPES.BATCH_START]: (message) => startBatch({ ...message, panelTabId: panelTabOf(message) }),
  [MESSAGE_TYPES.BATCH_RETRY]: (message) => retryBatch(message.kind, message.destination, panelTabOf(message)),
  [MESSAGE_TYPES.BATCH_GET_STATE]: async (message) => {
    await restoreBatchState(message.kind);
    return publicBatchState(message.kind);
  }
};

/** Jobs that send requests to IREPS: refused up front when the IREPS origin is not in host_permissions. */
const IREPS_JOB_TYPES = new Set([
  MESSAGE_TYPES.DOWNLOAD_IREPS_BILL_STATUS,
  MESSAGE_TYPES.DOWNLOAD_IREPS_DOCUMENTS,
  MESSAGE_TYPES.MA_SEARCH,
  MESSAGE_TYPES.MA_DOWNLOAD,
  MESSAGE_TYPES.PO_DOWNLOAD,
  MESSAGE_TYPES.IC_DOWNLOAD,
  MESSAGE_TYPES.IC_RETRY,
  MESSAGE_TYPES.BATCH_START,
  MESSAGE_TYPES.BATCH_RETRY,
  // bill upload steps that call IREPS (the receipt search from here, the bill calls, the signer
  // and save.php through the IREPS tab); its ECM-only, local and state steps are not refused
  MESSAGE_TYPES.BILL_UPLOAD_SEARCH,
  MESSAGE_TYPES.BILL_UPLOAD_PREPARE,
  MESSAGE_TYPES.BILL_UPLOAD_REVIEW,
  MESSAGE_TYPES.BILL_UPLOAD_CREATE,
  MESSAGE_TYPES.BILL_UPLOAD_SAVE_ITEM,
  MESSAGE_TYPES.BILL_UPLOAD_ADD_DOCUMENT
]);

/** The configured IREPS origin when host_permissions do not cover it (so nothing may be sent), else null. */
function irepsOriginNotPermitted() {
  if (compileMatchPatterns(chrome.runtime.getManifest().host_permissions || [])(IREPS_CONFIG.baseUrl)) return null;
  try {
    return new URL(IREPS_CONFIG.baseUrl).origin;
  } catch {
    return String(IREPS_CONFIG.baseUrl || "(no IREPS URL)");
  }
}

function guardIrepsJob(message) {
  if (!IREPS_JOB_TYPES.has(message.type)) return null;
  const origin = irepsOriginNotPermitted();
  if (!origin) return null;
  logger.warn(`Refused ${message.type}: ${origin} is not in host_permissions`);
  const detail = IREPS_CONFIG.baseUrl ? `${origin} is not in manifest.json host_permissions` : 'config.json could not be read or has no valid "target"';
  return { ok: false, started: false, error: describeError("IREPS_NOT_CONFIGURED", { detail }) };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return false;
  if (message.target && message.target !== TARGETS.SERVICE_WORKER) return false;
  const handler = handlers[message.type];
  if (!handler) return false;

  // config.json (mock vs. real IREPS) is read once per service-worker
  // lifetime, before the first request it can affect; the listener itself
  // stays registered synchronously above so no wake-up event is missed.
  loadIrepsConfig()
    .then(() => guardIrepsJob(message) || handler(message, sender))
    .then((response) => sendResponse(response ?? { ok: true }))
    .catch((error) => {
      logger.error(`Handler ${message.type} failed`, error);
      sendResponse({ ok: false, error: describeError("UNKNOWN", { detail: errorDetail(error) }) });
    });
  return true; // keep the channel open for the async response
});

/**
 * The UI lives in Chrome's side panel (docked to the right edge, full height,
 * the page content shrinks to make room) rather than a floating popup.
 * Clicking the toolbar icon opens/closes it. Called at top level so it also
 * applies after every service-worker restart.
 */
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error) => {
  logger.warn("Could not configure side panel behaviour", error);
});

/* -------------------------------------------------------------------------- */
/* One side panel per tab                                                     */
/* -------------------------------------------------------------------------- */

/**
 * DocLink belongs to the tab it was opened on, not to the window. Chrome
 * keeps a tab-specific side panel's open/closed state per tab: it hides the
 * panel when the user switches to another tab and shows it again, as it was,
 * when they come back. A tab where DocLink was never opened shows nothing.
 *
 * So the window-wide (global) panel is disabled, and every tab gets its own
 * panel (the tab id in the URL only keeps the per-tab entries distinct; the
 * panel itself follows whichever tab it is showing on, see
 * popup/popup-gate.js): DocLink's tools on the configured IREPS portal, the
 * "Go to IREPS and log in" page anywhere else.
 */
const SIDE_PANEL_PATH = (chrome.runtime.getManifest().side_panel || {}).default_path || "popup/popup.html";

/** @param {number} tabId */
async function enableTabPanel(tabId) {
  if (typeof tabId !== "number" || tabId < 0) return;
  try {
    await chrome.sidePanel.setOptions({ tabId, path: `${SIDE_PANEL_PATH}?tabId=${tabId}`, enabled: true });
  } catch (error) {
    logger.debug(`Could not set the side panel for tab ${tabId}`, error);
  }
}

async function enableTabPanelsForAllTabs() {
  try {
    await chrome.sidePanel.setOptions({ enabled: false }); // no window-wide panel
    const tabs = await chrome.tabs.query({});
    await Promise.all(tabs.map((tab) => enableTabPanel(tab.id)));
  } catch (error) {
    logger.warn("Could not set up per-tab side panels", error);
  }
}

chrome.tabs.onCreated.addListener((tab) => enableTabPanel(tab.id));
// A tab swapped in by prerendering / instant search gets a new id.
chrome.tabs.onReplaced.addListener((addedTabId) => enableTabPanel(addedTabId));
enableTabPanelsForAllTabs();

chrome.runtime.onInstalled.addListener((details) => {
  // a build loaded (or reloaded) starts both logs afresh: the last build's runs and lines, maybe of another Recon
  // server, are not this one's. Queued download-log records are data, not a log: they stay. Chrome updating
  // itself ("chrome_update") loads no new build.
  if (details.reason === "install" || details.reason === "update") {
    clearLogEntries();
    schedulerJob.clearRunLog();
  }
  logger.info(`DocLink installed (${details.reason})`);
  loadIrepsConfig().then(() => schedulerJob.onBrowserStart());
});

chrome.runtime.onStartup.addListener(() => {
  logger.debug("Service worker started");
  loadIrepsConfig().then(() => schedulerJob.onBrowserStart());
});

/* -------------------------------------------------------------------------- */
/* Scheduled downloads: the alarm and IREPS page loads wake the scheduler     */
/* -------------------------------------------------------------------------- */

if (chrome.alarms) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (schedulerJob.isSchedulerAlarm(alarm)) loadIrepsConfig().then(() => schedulerJob.onAlarm());
  });
}

// a scheduled tender download's runner tab closed before it finished: its slot is given back
chrome.tabs.onRemoved.addListener((tabId) => schedulerJob.onTabRemoved(tabId));

// the tab goes along: a page loading in a tab DocLink opened itself (a print tab) is never the user's IREPS activity
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab || !tab.url) return;
  loadIrepsConfig()
    .then(() => schedulerJob.onPageLoaded(tab.url, tab))
    .catch((error) => logger.warn("Scheduler: page load not handled", error));
});

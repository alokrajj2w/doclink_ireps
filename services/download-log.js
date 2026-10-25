/**
 * The download log: which files DocLink saved for the signed-in Recon Engine user, and the
 * check before a run of what that user already downloaded.
 *
 *   POST {reconBaseUrl}/api/doclink/downloads        { records: [...] }   after files are saved
 *   POST {reconBaseUrl}/api/doclink/downloads/check  { destination, keys } before a run
 *
 * The backend (recon-engine app/downloads.py) takes the user from the Recon sign-in (the
 * same session cookie as the S3 / ECM uploads, credentials: "include"), never from the
 * request. A document is identified by downloadKey() - its numbers, not its file name - so
 * a PO downloaded last week is recognised whatever the saved file was called; "already
 * downloaded" is per user and per destination (local / ecm).
 *
 * Before a document run preflightDownloads() asks the backend (and, under Save to: ECM, the
 * ECM itself: services/ecm-service.js findInEcm) which documents are already there, lets the
 * user pick which to download again (the panel's prompt, popup/popup-redownload.js), and
 * returns the rest to skip. Neither check ever blocks a run: when one cannot be made the
 * documents are simply downloaded.
 *
 * Saved files are queued in chrome.storage.local (one queue per context, so the service
 * worker and the panel never overwrite each other) and posted in batches shortly after;
 * a failed post keeps them queued for the next one, so the log survives a backend restart
 * or an expired sign-in.
 *
 * config.json "downloadLog": { "enabled": false } turns all of it off (and the required
 * Recon sign-in with it); config.local.json may override it.
 */

import { logger } from "../utils/logger.js";
import { RECON_CONFIG, loadReconConfig, reconConfigProblem, manifestHostPermissions, apiErrorDetail } from "./recon-service.js";
import { readConfigFiles } from "./ecm-config.js";
import { findInEcm } from "./ecm-service.js";

/** Where a file went, as the backend records it. */
export const LOG_DESTINATION = Object.freeze({ LOCAL: "local", ECM: "ecm", S3: "s3" });

/** doc_type values (the backend accepts any [a-z_]{1,32}). */
export const LOG_DOC_TYPE = Object.freeze({
  PO: "po",
  IC: "ic",
  MA: "ma",
  BILL_STATUS: "bill_status",
  CRN: "crn",
  RNOTE: "rnote"
});

/** Tender category (tender-workflows newCategory) -> doc_type. */
export const TENDER_DOC_TYPE = Object.freeze({
  TENDER_PDF: "tender_nit",
  ATTACHMENTS: "tender_attachment",
  CORRIGENDA: "corrigendum",
  MY_OFFER: "my_offer",
  NEGOTIATION: "negotiation",
  COUNTER_OFFER: "counter_offer",
  LOA: "loa",
  CORRESPONDENCE: "correspondence",
  PENDING_CORRESPONDENCE: "pending_correspondence"
});

/** Why a document was not downloaded. */
export const SKIP_REASON = Object.freeze({ ALREADY_DOWNLOADED: "already_downloaded", ALREADY_IN_ECM: "already_in_ecm" });

/** Error codes; each has an entry in utils/messages.js ERROR_CATALOG. */
export const DOWNLOAD_LOG_ERROR = Object.freeze({
  SIGN_IN_REQUIRED: "DOWNLOAD_LOG_SIGN_IN_REQUIRED",
  UNAVAILABLE: "DOWNLOAD_LOG_UNAVAILABLE"
});

const QUEUE_KEY_PREFIX = "doclink.downloadLog.queue.";
const MAX_RECORDS_PER_POST = 500;
const MAX_KEYS_PER_CHECK = 1000;
const MAX_QUEUE = 5000;
const REQUEST_TIMEOUT_MS = 30000;
const FLUSH_DELAY_MS = 2000;

/* -------------------------------------------------------------------------- */
/* Settings                                                                   */
/* -------------------------------------------------------------------------- */

let enabled = true;
let configLoaded = false;
let context = "sw";
let storageOverride = null;
let flushDelayMs = FLUSH_DELAY_MS;
let fetchOverride = null;
let hostPermissionsOverride = null;

/** Apply settings from a parsed (merged) config object; also used by the tests. */
export function applyDownloadLogConfig(config) {
  const d = config && typeof config === "object" ? config.downloadLog : null;
  enabled = !(d && typeof d === "object" && d.enabled === false);
  configLoaded = true;
}

/** Read "downloadLog" from config.json / config.local.json, once (or again with force). */
export async function loadDownloadLogConfig({ force = false } = {}) {
  if (configLoaded && !force) return enabled;
  try {
    const files = await readConfigFiles();
    if (files) applyDownloadLogConfig(files.config);
  } catch (error) {
    logger.warn("Could not read the download log settings; it stays on", error);
  } finally {
    configLoaded = true;
  }
  return enabled;
}

/** Whether downloads are logged and checked (and every run needs the Recon sign-in). */
export function isDownloadLogEnabled() {
  return enabled;
}

/**
 * Per-context wiring: `context` names this context's queue ("sw" for the service worker,
 * "panel" for the side panel); the tests also pass storage, fetch, hostPermissions and a
 * flush delay (0 = flush only when asked).
 */
export function configureDownloadLog(options = {}) {
  if (options.context) context = options.context;
  if ("storage" in options) storageOverride = options.storage;
  if ("fetch" in options) fetchOverride = options.fetch;
  if ("hostPermissions" in options) hostPermissionsOverride = options.hostPermissions;
  if ("flushDelayMs" in options) flushDelayMs = options.flushDelayMs;
}

/* -------------------------------------------------------------------------- */
/* Document identity                                                          */
/* -------------------------------------------------------------------------- */

const t = (v) => String(v ?? "").trim();

/** Stable keys: the document's own numbers, never the saved file name (it changes with " (1)"). */
export const downloadKey = Object.freeze({
  po: (poNo) => `po:${t(poNo)}`,
  ic: ({ poNo, poSerial, callId, icNumber }) => `ic:${t(poNo)}|${t(poSerial)}|${t(callId || icNumber)}`,
  ma: (poNo, maNo) => `ma:${t(poNo)}|${t(maNo)}`,
  tender: (category, tenderNo, id) => `tender:${t(category)}|${t(tenderNo)}|${t(id)}`,
  pending: (key, fileName) => `pending:${t(key)}|${t(fileName)}`,
  // Bill Status / CRN / R-NOTE: the fingerprint of the rows (exportFingerprint), not the file
  export: (docType, fingerprint) => `export:${t(docType)}:${t(fingerprint)}`
});

/**
 * The fingerprint of an export's data: SHA-256 (hex) of its format and the parsed rows as
 * IREPS returned them. The file itself cannot be compared - its name and contents carry the
 * time of the run - but the same rows in the same format are the same export.
 * @param {string} format   e.g. "xlsx", "csv"
 * @param {object[]} records
 */
export async function exportFingerprint(format, records) {
  const data = new TextEncoder().encode(JSON.stringify({ format: t(format), records: records || [] }));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The `log` an IREPS download item carries ({ docType, key }). */
export const logInfo = (docType, key) => ({ docType, key });

/** "local" or "ecm": where a run's documents go (Save to: ECM / S3 = "recon"). */
export function runDestination(saveDestination) {
  return saveDestination === "recon" ? LOG_DESTINATION.ECM : LOG_DESTINATION.LOCAL;
}

/** Where one saved document actually went: the ECM when it took it, else the Downloads folder. */
export function savedDestination(ecm) {
  return ecm && (ecm.status === "stored" || ecm.status === "already_stored") ? LOG_DESTINATION.ECM : LOG_DESTINATION.LOCAL;
}

/**
 * The log record of one saved document.
 * @param {{ docType: string, key: string }} log
 * @param {{ filename: string, ecm?: object|null, destination?: string, account?: { irepsAccountId?: string|null }|null }} saved
 */
export function downloadRecord(log, saved) {
  const destination = saved.destination || savedDestination(saved.ecm);
  const record = { doc_type: log.docType, doc_key: log.key, filename: t(saved.filename).split("/").pop() || "(unnamed)", destination };
  const account = saved.account && saved.account.irepsAccountId ? String(saved.account.irepsAccountId) : null;
  if (account) record.ireps_account_id = account;
  if (destination === LOG_DESTINATION.ECM && saved.ecm) {
    record.ecm = { status: saved.ecm.status, uid: saved.ecm.uid || null, path: saved.ecm.path || null, site: saved.ecm.site || null };
  }
  return record;
}

/* -------------------------------------------------------------------------- */
/* Backend calls                                                              */
/* -------------------------------------------------------------------------- */

export class DownloadLogError extends Error {
  constructor(code, { status = null, detail = "" } = {}) {
    super(detail || code);
    this.name = "DownloadLogError";
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

const post = (path, body, deps) => request("POST", path, body, deps);

async function request(method, path, body, deps = {}) {
  await loadReconConfig();
  const baseUrl = RECON_CONFIG.baseUrl;
  const problem = reconConfigProblem(baseUrl, deps.hostPermissions || hostPermissionsOverride || manifestHostPermissions(), path);
  if (problem) throw new DownloadLogError("RECON_NOT_CONFIGURED", { detail: problem });
  const fetchImpl = deps.fetch || fetchOverride || ((...args) => globalThis.fetch(...args));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    const init = method === "GET" ? { method } : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
    response = await fetchImpl(`${baseUrl}${path}`, { ...init, credentials: "include", signal: controller.signal });
  } catch {
    throw new DownloadLogError(DOWNLOAD_LOG_ERROR.UNAVAILABLE, { detail: `could not reach ${new URL(baseUrl).origin}` });
  } finally {
    clearTimeout(timer);
  }
  let answer = null;
  try {
    answer = await response.json();
  } catch {
    answer = null;
  }
  if (response.status === 401) throw new DownloadLogError("RECON_AUTH_REQUIRED", { status: 401 });
  if (response.status === 403) throw new DownloadLogError("FORBIDDEN", { status: 403, detail: apiErrorDetail(answer) || "not allowed" });
  if (!response.ok || !answer) throw new DownloadLogError(DOWNLOAD_LOG_ERROR.UNAVAILABLE, { status: response.status, detail: apiErrorDetail(answer) || `HTTP ${response.status}` });
  return answer;
}

/**
 * Which of `keys` the signed-in user already downloaded to `destination`.
 * Never throws: { ok: false, code } when the backend cannot answer.
 * @returns {Promise<{ ok: boolean, downloaded: Object<string, { count: number, filename: string, downloaded_at: string, date: string, time: string }>, code?: string, detail?: string }>}
 */
export async function checkDownloaded({ destination, keys }, deps = {}) {
  const unique = [...new Set((keys || []).filter(Boolean))];
  if (unique.length === 0) return { ok: true, downloaded: {} };
  try {
    const downloaded = {};
    for (let i = 0; i < unique.length; i += MAX_KEYS_PER_CHECK) {
      const answer = await post("/api/doclink/downloads/check", { destination, keys: unique.slice(i, i + MAX_KEYS_PER_CHECK) }, deps);
      Object.assign(downloaded, answer.downloaded || {});
    }
    logger.info(`Download log: ${Object.keys(downloaded).length} of ${unique.length} document(s) already downloaded (${destination})`);
    return { ok: true, downloaded };
  } catch (error) {
    const code = error instanceof DownloadLogError ? error.code : "UNKNOWN";
    logger.warn(`Download log check not made (${code})`, { status: error.status ?? null, detail: error.detail || null });
    return { ok: false, downloaded: {}, code, detail: error.detail || null };
  }
}

/**
 * @typedef {Object} LoggedDownload
 * @property {number} id
 * @property {number} user_id
 * @property {string|null} user_email
 * @property {string|null} user_name
 * @property {string|null} ireps_account_id
 * @property {string} doc_type
 * @property {string} doc_key
 * @property {string} filename
 * @property {string} destination      local | ecm | s3
 * @property {{ status: string|null, uid: string|null, path: string|null, site: string|null }|null} ecm
 * @property {string} downloaded_at    ISO, UTC
 * @property {string} date             IST, YYYY-MM-DD
 * @property {string} time             IST, HH:MM:SS
 */

/**
 * The log, newest first (GET /api/doclink/downloads): the signed-in user's own downloads,
 * or (an admin, all: true) everyone's. Throws DownloadLogError: RECON_AUTH_REQUIRED (sign
 * in), FORBIDDEN (all users without the admin role), DOWNLOAD_LOG_UNAVAILABLE, RECON_NOT_CONFIGURED.
 * @param {{ from?: string, to?: string, docType?: string, destination?: string, site?: string, all?: boolean, limit?: number, offset?: number }} [filters]
 *        from / to: IST days, YYYY-MM-DD; site: an ECM site key (hosur, rohtak)
 * @returns {Promise<{ count: number, downloads: LoggedDownload[] }>}
 */
export async function listDownloads(filters = {}, deps = {}) {
  const q = new URLSearchParams();
  if (filters.from) q.set("from", filters.from);
  if (filters.to) q.set("to", filters.to);
  if (filters.docType) q.set("doc_type", filters.docType);
  if (filters.destination) q.set("destination", filters.destination);
  if (filters.site) q.set("site", filters.site);
  if (filters.all) q.set("all", "true");
  q.set("limit", String(filters.limit || 50));
  if (filters.offset) q.set("offset", String(filters.offset));
  const answer = await request("GET", `/api/doclink/downloads?${q}`, null, deps);
  return { count: answer.count || 0, downloads: Array.isArray(answer.downloads) ? answer.downloads : [] };
}

/** How each doc_type reads in the panel. */
export const DOC_TYPE_LABEL = Object.freeze({
  po: "PO",
  ic: "Inspection Certificate",
  ma: "MA",
  bill_status: "Bill Status",
  crn: "CRN",
  rnote: "R-NOTE",
  tender_nit: "Tender NIT",
  tender_attachment: "Tender attachment",
  corrigendum: "Corrigendum",
  my_offer: "My Offer",
  negotiation: "Negotiation letter",
  counter_offer: "Counter offer",
  loa: "LOA",
  correspondence: "Correspondence",
  pending_correspondence: "Pending correspondence"
});

/* -------------------------------------------------------------------------- */
/* Queue                                                                      */
/* -------------------------------------------------------------------------- */

const memoryStore = new Map();

function storage() {
  if (storageOverride) return storageOverride;
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) return chrome.storage.local;
  return {
    get: async (key) => (memoryStore.has(key) ? { [key]: memoryStore.get(key) } : {}),
    set: async (items) => {
      for (const [k, v] of Object.entries(items)) memoryStore.set(k, v);
    }
  };
}

const queueKey = () => `${QUEUE_KEY_PREFIX}${context}`;
let chain = Promise.resolve();
let flushTimer = null;

/** Run `fn` after every earlier queue operation of this context (read-modify-write safety). */
function serial(fn) {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

async function readQueue() {
  try {
    const stored = await storage().get(queueKey());
    const q = stored && stored[queueKey()];
    return Array.isArray(q) ? q : [];
  } catch {
    return [];
  }
}

async function writeQueue(queue) {
  await storage().set({ [queueKey()]: queue });
}

/** Queue one saved file for the log (no-op when the log is off). Never throws. */
export async function logDownload(record) {
  if (!enabled || !record || !record.doc_key || !record.doc_type) return;
  try {
    await serial(async () => {
      const queue = await readQueue();
      queue.push(record);
      // a backend that stays unreachable must not grow the queue without end: the oldest go first
      await writeQueue(queue.slice(-MAX_QUEUE));
    });
  } catch (error) {
    logger.warn("Could not queue a download log record", error);
    return;
  }
  if (flushDelayMs > 0 && !flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushDownloadLog();
    }, flushDelayMs);
  }
}

/**
 * Post the queued records (up to 500 per request). What the backend took leaves the queue;
 * on a failure the rest stays for the next flush. Never throws.
 * @returns {Promise<{ posted: number, pending: number, code?: string }>}
 */
export function flushDownloadLog(deps = {}) {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  return serial(async () => {
    let queue = await readQueue();
    let posted = 0;
    while (queue.length) {
      const batch = queue.slice(0, MAX_RECORDS_PER_POST);
      try {
        await post("/api/doclink/downloads", { records: batch }, deps);
      } catch (error) {
        const code = error instanceof DownloadLogError ? error.code : "UNKNOWN";
        logger.warn(`Download log: ${queue.length} record(s) kept for later (${code})`, { status: error.status ?? null });
        return { posted, pending: queue.length, code };
      }
      posted += batch.length;
      queue = queue.slice(batch.length);
      await writeQueue(queue);
    }
    if (posted) logger.info(`Download log: ${posted} record(s) sent`);
    return { posted, pending: 0 };
  }).catch((error) => {
    logger.warn("Download log flush failed", error);
    return { posted: 0, pending: -1, code: "UNKNOWN" };
  });
}

/* -------------------------------------------------------------------------- */
/* Before a run                                                               */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} PreflightItem
 * @property {string} id
 * @property {string} [label]
 * @property {{ docType: string, key: string }} [log]
 * @property {{ kind: string, fields: object, title?: string }|null} [ecm]   how it is filed in the ECM
 */

/**
 * @typedef {Object} RedownloadQuestion
 * @property {string} destination   "local" | "ecm"
 * @property {{ id: string, label: string, count: number, filename: string, date: string, time: string }[]} alreadyDownloaded
 * @property {{ id: string, label: string, path: string|null }[]} inEcm
 */

/**
 * Which of a run's documents to skip because this user already downloaded them to the same
 * destination, or (destination "ecm") they are already in their ECM folder. `ask` gets the
 * matches and answers which ids to download again (none when it gives no answer).
 *
 * @param {PreflightItem[]} items
 * @param {{ destination: string, account?: object|null, ask?: (q: RedownloadQuestion) => Promise<{ redownload?: string[] }|null>, deps?: object }} options
 * @returns {Promise<{ skip: Map<string, object>, warnings: string[], checked: boolean }>}
 *          skip: id -> { reason, date?, time?, count?, filename?, path? };
 *          checked: the download log answered (false: off, or unreachable)
 */
export async function preflightDownloads(items, { destination, account = null, ask = null, deps = {} } = {}) {
  const skip = new Map();
  const warnings = [];
  await loadDownloadLogConfig();
  const list = (items || []).filter((i) => i && i.id);
  if (!enabled || list.length === 0) return { skip, warnings, checked: false };

  const logged = list.filter((i) => i.log && i.log.key);
  const toEcm = destination === LOG_DESTINATION.ECM;
  const kinds = toEcm ? [...new Set(list.filter((i) => i.ecm && i.ecm.kind).map((i) => i.ecm.kind))] : [];
  const [checked, ...ecmChecks] = await Promise.all([
    checkDownloaded({ destination, keys: logged.map((i) => i.log.key) }, deps),
    ...kinds.map((kind) => findInEcm({ kind, account, candidates: list.filter((i) => i.ecm && i.ecm.kind === kind).map((i) => ({ ref: i.id, fields: i.ecm.fields, title: i.ecm.title })) }, deps))
  ]);
  if (!checked.ok) warnings.push(checked.code === "RECON_AUTH_REQUIRED" ? "Download log: sign in to the Recon Engine to see what you already downloaded." : "Download log unavailable: already-downloaded files could not be checked.");
  if (ecmChecks.some((c) => !c.ok)) warnings.push("The ECM could not be checked for documents already there.");

  const inEcmById = new Map();
  for (const c of ecmChecks) for (const [ref, doc] of c.found) inEcmById.set(ref, doc);
  const alreadyDownloaded = [];
  const inEcm = [];
  for (const item of list) {
    const label = item.label || item.id;
    const hit = item.log && checked.downloaded[item.log.key];
    if (hit) alreadyDownloaded.push({ id: item.id, label, count: hit.count || 1, filename: hit.filename || "", date: hit.date || "", time: hit.time || "" });
    const doc = inEcmById.get(item.id);
    if (doc) inEcm.push({ id: item.id, label, path: doc.path || null });
  }
  if (alreadyDownloaded.length === 0 && inEcm.length === 0) return { skip, warnings, checked: checked.ok };

  let answer = null;
  if (typeof ask === "function") {
    try {
      answer = await ask({ destination, alreadyDownloaded, inEcm });
    } catch (error) {
      logger.warn("The download-again question was not answered", error);
    }
  }
  const again = new Set(answer && Array.isArray(answer.redownload) ? answer.redownload.map(String) : []);
  const byId = new Map(alreadyDownloaded.map((a) => [a.id, a]));
  for (const e of inEcm) {
    if (!again.has(e.id)) skip.set(e.id, { reason: SKIP_REASON.ALREADY_IN_ECM, path: e.path, ...(byId.has(e.id) ? pick(byId.get(e.id)) : {}) });
  }
  for (const a of alreadyDownloaded) {
    if (!again.has(a.id) && !skip.has(a.id)) skip.set(a.id, { reason: SKIP_REASON.ALREADY_DOWNLOADED, ...pick(a) });
  }
  logger.info(`Download check: ${skip.size} skipped, ${again.size} downloaded again`, { alreadyDownloaded: alreadyDownloaded.length, inEcm: inEcm.length, answered: Boolean(answer) });
  return { skip, warnings, checked: checked.ok };
}

const pick = ({ count, filename, date, time }) => ({ count, filename, date, time });

/** One line for a skipped document's row, e.g. "Already downloaded on 2026-10-22 at 10:05". */
export function describeSkip(skip) {
  if (!skip) return "";
  const when = skip.date ? ` on ${skip.date}${skip.time ? ` at ${skip.time.slice(0, 5)}` : ""}` : "";
  if (skip.reason === SKIP_REASON.ALREADY_IN_ECM) return `Already in ECM${skip.path ? `: ${skip.path}` : ""}${skip.date ? ` (you downloaded it${when})` : ""}`;
  if (skip.reason === SKIP_REASON.ALREADY_DOWNLOADED) return `Already downloaded${when}${skip.count > 1 ? ` (${skip.count} times)` : ""}`;
  return "";
}

/** The chip text of a skipped document. */
export function skipChipText(skip) {
  return skip && skip.reason === SKIP_REASON.ALREADY_IN_ECM ? "Already in ECM" : "Already downloaded";
}

/** Panel event: "ask which of these files to download again" (popup/popup-redownload.js answers it). */
export const REDOWNLOAD_EVENT = "doclink:confirm-redownload";

/**
 * From panel code that cannot reach popup-redownload.js directly (the tender view is bundled
 * separately): the prompt's answer { redownload: ids, sameForRun }, or null when no prompt
 * answers (no panel, or the tests) - then nothing is downloaded again.
 * @param {RedownloadQuestion & { forRun?: boolean }} question
 */
export function confirmRedownload(question) {
  if (typeof document === "undefined" || typeof CustomEvent === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const event = new CustomEvent(REDOWNLOAD_EVENT, { detail: { question, resolve }, cancelable: true });
    if (document.dispatchEvent(event)) resolve(null);
  });
}

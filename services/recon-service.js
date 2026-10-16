/**
 * Recon Engine upload: the "Save to: Recon Engine (S3)" destination of the
 * Bill Status, CRN and R-NOTE downloads.
 *
 * Instead of handing the export file to chrome.downloads, the service worker
 * POSTs the same bytes to the Recon Engine's document API:
 *
 *   POST {reconBaseUrl}/api/documents   multipart: customer_id, doc_type, file
 *
 * The backend stores the file in its managed storage - S3 when the Recon
 * Engine runs with STORAGE_BACKEND=s3 - in one directory per document type:
 *
 *   s3://<bucket>/<prefix>bronze/<customer>/bill_status/<sha256>.xlsx
 *   s3://<bucket>/<prefix>bronze/<customer>/rnote/<sha256>.xlsx
 *   s3://<bucket>/<prefix>bronze/<customer>/crn/<sha256>.xlsx
 *
 * and then loads it into the reconciliation data exactly as a manual upload
 * would. Identical bytes are stored once (the response says deduplicated).
 *
 * Authentication is the Recon Engine's own sign-in, made from DocLink's
 * "Sign in to Recon Engine" page (services/recon-auth.js: password or Okta)
 * or in a Recon Engine tab of this Chrome profile. Either way the backend
 * sets its httponly session cookie in Chrome's cookie jar and the request
 * carries it (credentials: "include"); DocLink never reads, stores or logs
 * the cookie, and a typed password is sent once to the Recon Engine and kept
 * nowhere. The Recon origin must be in manifest.json host_permissions, which
 * is also what lets DocLink call it without CORS. A 401 therefore means
 * "sign in to the Recon Engine first".
 *
 * Settings (config.json): reconBaseUrl, reconCustomerId, optionally
 * reconAppUrl (the page "Open Recon Engine" opens; defaults to reconBaseUrl)
 * and okta (the Okta sign-in, see services/recon-auth.js).
 */

import { logger } from "../utils/logger.js";
import { compileMatchPatterns } from "../utils/url-scope.js";

/** doc_type values the Recon Engine's POST /api/documents accepts. */
export const RECON_DOC_TYPE = Object.freeze({
  BILL_STATUS: "bill_status",
  RNOTE: "rnote",
  CRN: "crn"
});

/** Where a download is saved: the user's Downloads folder, or the Recon Engine (S3). */
export const SAVE_DESTINATION = Object.freeze({
  LOCAL: "local",
  RECON: "recon"
});

/** Error codes; each has an entry in utils/messages.js ERROR_CATALOG. */
export const RECON_ERROR = Object.freeze({
  NOT_CONFIGURED: "RECON_NOT_CONFIGURED",
  AUTH_REQUIRED: "RECON_AUTH_REQUIRED",
  UNAVAILABLE: "RECON_UNAVAILABLE",
  REJECTED: "RECON_REJECTED",
  NOT_INGESTED: "RECON_NOT_INGESTED"
});

export class ReconError extends Error {
  /**
   * @param {string} code     one of RECON_ERROR
   * @param {{ status?: number|null, detail?: string }} [details]
   */
  constructor(code, details = {}) {
    super(details.detail || code);
    this.name = "ReconError";
    this.code = code;
    this.status = details.status ?? null;
    this.detail = details.detail || "";
  }
}

const DEFAULT_CUSTOMER_ID = "default";
const UPLOAD_TIMEOUT_MS = 120000;

let currentBaseUrl = "";
let currentAppUrl = "";
let currentCustomerId = DEFAULT_CUSTOMER_ID;
let currentOkta = Object.freeze({ enabled: false, issuer: "", clientId: "", redirectPath: "okta" });
let configLoaded = false;

/** Live view of the Recon settings; mutable only through loadReconConfig(). */
export const RECON_CONFIG = Object.freeze({
  get baseUrl() {
    return currentBaseUrl;
  },
  get appUrl() {
    return currentAppUrl || currentBaseUrl;
  },
  get customerId() {
    return currentCustomerId;
  },
  /** Okta sign-in settings: { enabled, issuer, clientId, redirectPath }. Never a secret. */
  get okta() {
    return currentOkta;
  },
  timeoutMs: UPLOAD_TIMEOUT_MS
});

function trimUrl(value) {
  return typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
}

/** config.json "okta" -> the settings DocLink's Okta sign-in uses. */
function oktaSettings(okta) {
  const o = okta && typeof okta === "object" ? okta : {};
  const text = (v) => (typeof v === "string" ? v.trim() : "");
  const issuer = trimUrl(o.issuer);
  const clientId = text(o.clientId);
  return Object.freeze({
    enabled: o.enabled !== false && Boolean(issuer && clientId),
    issuer,
    clientId,
    redirectPath: text(o.redirectPath).replace(/^\/+/, "") || "okta"
  });
}

/**
 * Apply Recon settings from a parsed config.json object (also used by the
 * tests, which have no extension context to read the file from).
 * @param {{ reconBaseUrl?: string, reconAppUrl?: string, reconCustomerId?: string, okta?: object }} config
 */
export function applyReconConfig(config) {
  currentBaseUrl = trimUrl(config && config.reconBaseUrl);
  currentAppUrl = trimUrl(config && config.reconAppUrl);
  currentCustomerId = (config && typeof config.reconCustomerId === "string" && config.reconCustomerId.trim()) || DEFAULT_CUSTOMER_ID;
  currentOkta = oktaSettings(config && config.okta);
  configLoaded = true;
  return RECON_CONFIG;
}

/**
 * Read the Recon settings from config.json (the same hand-edited file as the
 * IREPS target). Safe to call repeatedly; a no-op after the first load
 * unless `force` is passed. On any error the current settings are kept.
 * @param {{ force?: boolean }} [options]
 */
export async function loadReconConfig({ force = false } = {}) {
  if (configLoaded && !force) return RECON_CONFIG;
  try {
    const url = typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL ? chrome.runtime.getURL("config.json") : "./config.json";
    applyReconConfig(await (await fetch(url, { cache: "no-store" })).json());
    logger.info(`Recon config loaded: ${currentBaseUrl || "(no reconBaseUrl)"}, customer=${currentCustomerId}`);
  } catch (error) {
    logger.warn("Could not load the Recon settings from config.json", error);
  } finally {
    configLoaded = true;
  }
  return RECON_CONFIG;
}

/**
 * Why `${baseUrl}${path}` cannot be called, or "" when it can: reconBaseUrl must be set,
 * valid and covered by host_permissions. Shared with the ECM upload (services/ecm-service.js).
 */
export function reconConfigProblem(baseUrl, hostPermissions, path) {
  if (!baseUrl) return "reconBaseUrl is not set in config.json";
  try {
    new URL(baseUrl);
  } catch {
    return `reconBaseUrl "${baseUrl}" is not a valid URL`;
  }
  if (!compileMatchPatterns(hostPermissions)(`${baseUrl}${path}`)) return `${new URL(baseUrl).origin} is missing from manifest.json host_permissions`;
  return "";
}

/** host_permissions of this extension (the tests pass their own). */
export function manifestHostPermissions() {
  return typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getManifest ? chrome.runtime.getManifest().host_permissions || [] : [];
}

/** Throws RECON_NOT_CONFIGURED unless reconBaseUrl is set, valid and covered by host_permissions. */
function assertConfigured(baseUrl, hostPermissions) {
  const problem = reconConfigProblem(baseUrl, hostPermissions, "/api/documents");
  if (problem) throw new ReconError(RECON_ERROR.NOT_CONFIGURED, { detail: problem });
}

/** The API's error text ({ detail: { error, detail } } or { detail: "..." }), or "". */
export function apiErrorDetail(body) {
  const d = body && body.detail;
  if (!d) return "";
  if (typeof d === "string") return d;
  if (typeof d.detail === "string") return d.detail;
  return "";
}

/**
 * @typedef {Object} ReconUploadResult
 * @property {number} bronzeFileId
 * @property {string} docType
 * @property {string} storedPath     s3://bucket/key (or a local path when the Recon Engine stores locally)
 * @property {boolean} deduplicated  the same bytes were already stored
 * @property {string|null} originalName
 * @property {number|null} sizeBytes
 * @property {object|null} stats     the Recon Engine's ingest counters (rows_inserted, by_frame, ...)
 */

/**
 * Upload one export file to the Recon Engine.
 *
 * @param {{ docType: string, bytes: Uint8Array, filename: string, mimeType?: string }} file
 * @param {{ fetch?: typeof fetch, hostPermissions?: string[] }} [deps]
 * @returns {Promise<ReconUploadResult>}
 */
export async function uploadToRecon(file, deps = {}) {
  await loadReconConfig();
  const baseUrl = RECON_CONFIG.baseUrl;
  const hostPermissions = deps.hostPermissions || manifestHostPermissions();
  assertConfigured(baseUrl, hostPermissions);
  if (!Object.values(RECON_DOC_TYPE).includes(file.docType)) throw new Error(`Unsupported Recon doc_type: ${file.docType}`);

  const form = new FormData();
  form.append("customer_id", RECON_CONFIG.customerId);
  form.append("doc_type", file.docType);
  form.append("file", new Blob([file.bytes], { type: file.mimeType || "application/octet-stream" }), file.filename);

  const endpoint = `${baseUrl}/api/documents`;
  const fetchImpl = deps.fetch || globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RECON_CONFIG.timeoutMs);
  logger.info(`Uploading ${file.filename} to the Recon Engine`, { docType: file.docType, bytes: file.bytes.length, customer: RECON_CONFIG.customerId });

  let response;
  try {
    response = await fetchImpl(endpoint, { method: "POST", body: form, credentials: "include", signal: controller.signal });
  } catch (error) {
    const timedOut = error && error.name === "AbortError";
    logger.warn("Recon Engine unreachable", error);
    throw new ReconError(RECON_ERROR.UNAVAILABLE, { detail: timedOut ? "no response within 2 minutes" : `could not reach ${new URL(baseUrl).origin}` });
  } finally {
    clearTimeout(timer);
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (response.status === 401) throw new ReconError(RECON_ERROR.AUTH_REQUIRED, { status: 401 });
  if (response.status === 422) {
    // The file is stored before it is parsed, so it is in S3 but not loaded.
    throw new ReconError(RECON_ERROR.NOT_INGESTED, { status: 422, detail: apiErrorDetail(body) || "the Recon Engine could not read the file" });
  }
  if (!response.ok || !body) {
    throw new ReconError(RECON_ERROR.REJECTED, { status: response.status, detail: apiErrorDetail(body) || `HTTP ${response.status}` });
  }

  const result = {
    bronzeFileId: body.bronze_file_id,
    docType: body.doc_type || file.docType,
    storedPath: body.stored_path || "",
    deduplicated: body.deduplicated === true,
    originalName: body.original_name ?? null,
    sizeBytes: body.size_bytes ?? null,
    stats: body.stats || null
  };
  logger.info(`Recon Engine stored ${file.filename}${result.deduplicated ? " (already stored)" : ""}`, { status: response.status, bronzeFileId: result.bronzeFileId, storedPath: result.storedPath });
  return result;
}

/**
 * One line for the result panel from the Recon Engine's ingest counters,
 * e.g. "Loaded into Recon: 12 new, 3 updated, 40 unchanged". Recovery lines
 * ride along with their bills and are not counted separately.
 * @param {object|null} stats   ReconUploadResult.stats
 * @returns {string}            "" when the response carried no counters
 */
export function describeIngestStats(stats) {
  const frames = stats && stats.by_frame ? Object.entries(stats.by_frame).filter(([name]) => name !== "recoveries") : [];
  if (frames.length === 0) return "";
  const sum = (key) => frames.reduce((n, [, f]) => n + (Number(f && f[key]) || 0), 0);
  const parts = [`${sum("inserted")} new`, `${sum("updated")} updated`, `${sum("unchanged")} unchanged`];
  const conflicts = sum("conflicts");
  if (conflicts) parts.push(`${conflicts} locked (not changed)`);
  return `Loaded into Recon: ${parts.join(", ")}`;
}

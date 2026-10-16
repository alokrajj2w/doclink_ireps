/**
 * ECM upload: the "Save to: ECM / S3" destination of the IC, PO, MA and tender
 * documents ("TSG India Doculink ECM specifications.xlsx", sheet "ECM - Download speci-v1").
 *
 * Instead of handing the PDF to chrome.downloads, DocLink POSTs it to the Recon
 * Engine's ECM gateway, which stores it in the ECM (Nuxeo) folder of the IREPS
 * account's operating unit:
 *
 *   POST {reconBaseUrl}/api/ecm/documents   multipart: kind, file, title, fields (JSON),
 *                                           ireps_account_id, operating_unit
 *
 *   IREPS account 833   -> Hosur - Brakes and Safety (HSR)
 *   IREPS account 60828 -> Rohtak - Brakes and Safety (BRH)
 *
 * The gateway owns the ECM credentials, the folder ids and the metadata names
 * (InvoiceCertificateSchema:*); DocLink sends the document kind and plain field keys.
 * A document already in the ECM (same kind, folder, title, file name and metadata)
 * is not stored twice: the answer says deduplicated.
 *
 * Authentication, settings and host permission are the Recon Engine's (see
 * services/recon-service.js): reconBaseUrl in config.json, the Recon Engine sign-in
 * cookie (DocLink's sign-in page, services/recon-auth.js), and the Recon origin in
 * manifest.json host_permissions.
 *
 * Bill Status, CRN and R-NOTE are not ECM documents: under the same switch they keep
 * going to the Recon Engine (S3).
 */

import { logger } from "../utils/logger.js";
import { RECON_CONFIG, loadReconConfig, reconConfigProblem, manifestHostPermissions, apiErrorDetail } from "./recon-service.js";

/** ECM document kinds (InvoiceCertificateSchema:type) DocLink uploads. */
export const ECM_KIND = Object.freeze({
  INSPECTION_CERTIFICATE: "inspectionCertificate",
  PO_COPY: "poCopy",
  MODIFICATION_ADVISE: "modificationAdvise",
  NIT: "nit", //                 Tender (NIT) and its attached documents
  LOI: "loi", //                 Advance Acceptance Letter / LOI (IREPS "LOA")
  NBSP: "nbsp", //               Negotiation Bid Submission Pending
  EXTENSION: "extension", //     Tender extension / qty change (Corrigendum)
  CRP: "crp", //                 Correspondence Reply pending
  COUNTER_OFFER: "co"
});

/** Error codes; each has an entry in utils/messages.js ERROR_CATALOG. */
export const ECM_ERROR = Object.freeze({
  NOT_CONFIGURED: "ECM_NOT_CONFIGURED",
  ACCOUNT_UNKNOWN: "ECM_ACCOUNT_UNKNOWN",
  AUTH_REQUIRED: "ECM_AUTH_REQUIRED",
  REJECTED: "ECM_REJECTED",
  UNAVAILABLE: "ECM_UNAVAILABLE"
});

/** What happened to one document under "ECM / S3". */
export const ECM_OUTCOME = Object.freeze({
  STORED: "stored",
  ALREADY_STORED: "already_stored",
  FAILED: "failed" // saved locally instead
});

export class EcmError extends Error {
  /**
   * @param {string} code     one of ECM_ERROR
   * @param {{ status?: number|null, detail?: string }} [details]
   */
  constructor(code, details = {}) {
    super(details.detail || code);
    this.name = "EcmError";
    this.code = code;
    this.status = details.status ?? null;
    this.detail = details.detail || "";
  }
}

const ENDPOINT = "/api/ecm/documents";
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/**
 * An IREPS date as YYYY-MM-DD, or "" when it is not a date.
 * Accepts "16/01/2026", "16-01-2026", "16-Jan-2026", "16 Jan 2026", "2026-01-16" (a time after it is ignored).
 */
export function toIsoDate(value) {
  const text = String(value ?? "").trim();
  let y, m, d;
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/.exec(text);
  if (match) [, y, m, d] = match.map(Number);
  else if ((match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?!\d)/.exec(text))) [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else if ((match = /^(\d{1,2})[\s/.-]+([A-Za-z]{3})[A-Za-z]*[\s/.,-]+(\d{4})(?!\d)/.exec(text))) [d, m, y] = [Number(match[1]), MONTHS[match[2].toLowerCase()], Number(match[3])];
  else return "";
  const date = new Date(Date.UTC(y, (m || 0) - 1, d));
  if (!m || date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return "";
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Fields worth sending: blanks dropped, *_date fields as YYYY-MM-DD (an unreadable optional date is dropped). */
export function ecmFields(fields) {
  const out = {};
  for (const [key, raw] of Object.entries(fields || {})) {
    const value = typeof raw === "string" ? raw.trim() : raw;
    if (value === null || value === undefined || value === "") continue;
    if (key.endsWith("_date")) {
      const iso = toIsoDate(value);
      if (!iso) {
        logger.warn(`ECM upload: ${key} "${value}" is not a date; sent without it`);
        continue;
      }
      out[key] = iso;
    } else {
      out[key] = String(value);
    }
  }
  return out;
}

/**
 * @typedef {Object} EcmAccount
 * @property {string|null} irepsAccountId   IREPS vendor code, e.g. "833" (picks the unit's folder)
 * @property {string|null} operatingUnit    e.g. "HOSUR"; sent too, the gateway checks they agree
 */

/**
 * @typedef {Object} EcmUploadResult
 * @property {string} uid
 * @property {string|null} path
 * @property {string|null} title
 * @property {string|null} site            the gateway's site key, e.g. "hosur"
 * @property {boolean} deduplicated        already in the ECM; nothing new was stored
 */

/**
 * Upload one document to the ECM folder of the account's unit.
 *
 * @param {{ kind: string, bytes: Uint8Array, filename: string, title?: string, fields?: object,
 *           account: EcmAccount, mimeType?: string }} doc
 * @param {{ fetch?: typeof fetch, hostPermissions?: string[] }} [deps]
 * @returns {Promise<EcmUploadResult>}
 */
export async function uploadToEcm(doc, deps = {}) {
  await loadReconConfig();
  const baseUrl = RECON_CONFIG.baseUrl;
  const problem = reconConfigProblem(baseUrl, deps.hostPermissions || manifestHostPermissions(), ENDPOINT);
  if (problem) throw new EcmError(ECM_ERROR.NOT_CONFIGURED, { detail: problem });
  if (!Object.values(ECM_KIND).includes(doc.kind)) throw new Error(`Unsupported ECM kind: ${doc.kind}`);
  const account = doc.account || {};
  if (!account.irepsAccountId && !account.operatingUnit) {
    throw new EcmError(ECM_ERROR.ACCOUNT_UNKNOWN, { detail: "the IREPS account could not be verified" });
  }

  const fields = ecmFields(doc.fields);
  const form = new FormData();
  form.append("kind", doc.kind);
  if (account.irepsAccountId) form.append("ireps_account_id", String(account.irepsAccountId));
  if (account.operatingUnit) form.append("operating_unit", String(account.operatingUnit));
  if (doc.title) form.append("title", doc.title);
  form.append("fields", JSON.stringify(fields));
  form.append("file", new Blob([doc.bytes], { type: doc.mimeType || "application/pdf" }), doc.filename);

  const fetchImpl = deps.fetch || globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RECON_CONFIG.timeoutMs);
  logger.info(`Uploading ${doc.filename} to the ECM`, { kind: doc.kind, account: account.irepsAccountId, unit: account.operatingUnit, bytes: doc.bytes.length, fields: Object.keys(fields) });

  let response;
  try {
    response = await fetchImpl(`${baseUrl}${ENDPOINT}`, { method: "POST", body: form, credentials: "include", signal: controller.signal });
  } catch (error) {
    const timedOut = error && error.name === "AbortError";
    logger.warn("ECM gateway unreachable", error);
    throw new EcmError(ECM_ERROR.UNAVAILABLE, { detail: timedOut ? "no response within 2 minutes" : `could not reach ${new URL(baseUrl).origin}` });
  } finally {
    clearTimeout(timer);
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const detail = apiErrorDetail(body);
  const code = body && body.detail && typeof body.detail === "object" ? body.detail.error : null;

  if (response.status === 401 || response.status === 403) throw new EcmError(ECM_ERROR.AUTH_REQUIRED, { status: response.status, detail });
  if (code === "ECM_NOT_CONFIGURED") throw new EcmError(ECM_ERROR.NOT_CONFIGURED, { status: response.status, detail: detail || "the Recon Engine has no ECM settings" });
  if (response.status === 400 || response.status === 413 || response.status === 422) {
    throw new EcmError(ECM_ERROR.REJECTED, { status: response.status, detail: detail || `HTTP ${response.status}` });
  }
  if (!response.ok || !body || !body.uid) {
    throw new EcmError(ECM_ERROR.UNAVAILABLE, { status: response.status, detail: detail || `HTTP ${response.status}` });
  }

  const result = { uid: body.uid, path: body.path ?? null, title: body.title ?? null, site: body.site ?? null, deduplicated: body.deduplicated === true };
  logger.info(`ECM ${result.deduplicated ? "already had" : "stored"} ${doc.filename}`, { kind: doc.kind, site: result.site, uid: result.uid });
  return result;
}

/**
 * Upload to the ECM, and save locally instead when that fails, so nothing is lost.
 *
 * @param {{ kind: string, bytes: Uint8Array, filename: string, title?: string, fields?: object, account: EcmAccount, mimeType?: string }} doc
 * @param {() => Promise<object>} saveLocally   the usual local save (its result is returned as `local`)
 * @param {{ fetch?: typeof fetch, hostPermissions?: string[] }} [deps]
 * @returns {Promise<{ ecm: { status: string, site?: string|null, uid?: string, path?: string|null, code?: string, detail?: string }, local: object|null }>}
 */
export async function saveToEcmOrLocally(doc, saveLocally, deps = {}) {
  try {
    const stored = await uploadToEcm(doc, deps);
    return {
      ecm: { status: stored.deduplicated ? ECM_OUTCOME.ALREADY_STORED : ECM_OUTCOME.STORED, site: stored.site, uid: stored.uid, path: stored.path },
      local: null
    };
  } catch (error) {
    if (!(error instanceof EcmError)) throw error;
    logger.warn(`ECM upload failed (${error.code}); saving ${doc.filename} locally`, { status: error.status, detail: error.detail });
    const local = await saveLocally();
    return { ecm: { status: ECM_OUTCOME.FAILED, code: error.code, detail: error.detail || null }, local };
  }
}

const siteName = (site) => `${site.charAt(0).toUpperCase()}${site.slice(1)}`;

/** One line for a document's row, e.g. "Saved to ECM (Hosur)". */
export function describeEcmOutcome(ecm) {
  if (!ecm) return "";
  const site = ecm.site ? ` (${siteName(ecm.site)})` : "";
  if (ecm.status === ECM_OUTCOME.STORED) return `Saved to ECM${site}`;
  if (ecm.status === ECM_OUTCOME.ALREADY_STORED) return `Already in ECM${site}`;
  if (ecm.status === ECM_OUTCOME.FAILED) return `ECM upload failed, saved locally: ${ECM_FAILURE_TEXT[ecm.code] || ecm.code}${ecm.detail ? ` (${ecm.detail})` : ""}`;
  return "";
}

/**
 * One line for a batch, e.g. "ECM (Hosur): 3 saved, 1 already there, 1 saved locally instead".
 * @param {{ ecm?: object|null }[]} items   document-downloader snapshot items
 * @returns {string}  "" when nothing went to the ECM
 */
export function summariseEcm(items) {
  const outcomes = (items || []).map((i) => i && i.ecm).filter(Boolean);
  if (outcomes.length === 0) return "";
  const count = (status) => outcomes.filter((e) => e.status === status).length;
  const sites = [...new Set(outcomes.filter((e) => e.site).map((e) => siteName(e.site)))];
  const parts = [
    [count(ECM_OUTCOME.STORED), "saved"],
    [count(ECM_OUTCOME.ALREADY_STORED), "already there"],
    [count(ECM_OUTCOME.FAILED), "saved locally instead"]
  ].filter(([n]) => n > 0).map(([n, text]) => `${n} ${text}`);
  return `ECM${sites.length ? ` (${sites.join(", ")})` : ""}: ${parts.join(", ")}`;
}

const ECM_FAILURE_TEXT = Object.freeze({
  [ECM_ERROR.NOT_CONFIGURED]: "ECM not configured",
  [ECM_ERROR.ACCOUNT_UNKNOWN]: "IREPS account not verified",
  [ECM_ERROR.AUTH_REQUIRED]: "sign in to the Recon Engine",
  [ECM_ERROR.REJECTED]: "ECM refused the document",
  [ECM_ERROR.UNAVAILABLE]: "ECM unavailable"
});

/**
 * Direct ECM upload (config.json "ecmBackendAws": false, for local testing): DocLink calls
 * the ECM (Nuxeo) REST API itself instead of the Recon Engine's ECM gateway. A port of the
 * gateway's backend/ECM/ecm_client (client.py, auth.py, service.save_document), following
 * "ECM_API_DOC" and "TSG India Doculink ECM specifications.xlsx":
 *
 *   POST {domain}/nuxeo/oauth2/token?grant_type=client_credentials&...   bearer token
 *   GET  {domain}/nuxeo/api/v1/id/{folderUid}                             the folder exists (once)
 *   GET  {domain}/nuxeo/api/v1/search/lang/NXQL/execute?query=...         search (NXQL)
 *   POST {domain}/nuxeo/api/v1/upload                                     open a batch
 *   POST {domain}/nuxeo/api/v1/upload/{batchId}/0                         the file
 *   POST {domain}/nuxeo/api/v1/id/{folderUid}                             create the document
 *   GET  {domain}/nuxeo/api/v1/id/{uid} + /@blob/file:content (last byte) its file reads back in full
 *   PUT  {domain}/nuxeo/api/v1/id/{uid}                                   download again: the new PDF in the
 *                                                                          same document (old one kept as _old)
 *   POST {domain}/nuxeo/api/v1/id/{uid}/@op/Document.Trash                 damaged copies to the trash
 *   POST {domain}/nuxeo/api/v1/upload/{batchId}/0/execute/Blob.AttachOnDocument
 *                                                                          grouped kinds: one more PDF in the
 *                                                                          tender's document (files:files)
 *
 * Same folders (services/ecm-catalog.js), same metadata and the same answer as the gateway
 * ({ uid, path, title, site, deduplicated }), and the same EcmError codes, so callers,
 * the local fallback and the panel do not know which path was taken. A document already
 * in the folder (same kind, title, file name and metadata) is not stored twice.
 * Grouped kinds (NIT, LOA, Result: one document per tender) are direct-only, see
 * addToTenderDocument.
 *
 * The bearer token is kept in this JS context's memory until shortly before it expires
 * (the service worker and the side panel each fetch their own); it is never stored or
 * logged, and neither is the client secret. A 401 drops it and retries the call once.
 */

import { logger } from "../utils/logger.js";
import { ECM_CONFIG, loadEcmConfig, ecmDirectProblem } from "./ecm-config.js";
import { DOC_TYPE, TYPE_PROPERTY, ECM_FIELDS, ECM_KINDS, ECM_SITES, routeSite, renderTitle } from "./ecm-catalog.js";
import { EcmError, ECM_ERROR, ecmFields } from "./ecm-service.js";
import { manifestHostPermissions } from "./recon-service.js";

const API = "/nuxeo/api/v1";
const TOKEN_REFRESH_MARGIN_S = 60;
const TOKEN_TTL_FALLBACK_S = 3600;
const NAME_UNSAFE = /[/\\\x00-\x1f]+/g;

let token = null; // { key, value, expiresAt }; key = domain + client id, so a config change drops it
const folderUids = new Map(); // domain + path -> folder uid (folder uids never change)

/** Forget the cached token and folder uids (tests). */
export function resetEcmDirectState() {
  token = null;
  folderUids.clear();
}

/** A value as NXQL: booleans as 1/0, numbers bare, anything else quoted and escaped. */
export function nxqlLiteral(value) {
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") return String(value);
  return `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

const isDateField = (key) => key.endsWith("_date");
const IST_OFFSET_MS = 5.5 * 3600 * 1000;

function fieldClause(key, value) {
  if (!ECM_FIELDS[key]) throw new Error(`Unknown ECM field: ${key}`);
  if (!isDateField(key)) return `${ECM_FIELDS[key]} = ${nxqlLiteral(value)}`;
  // The ECM keeps dates as timestamps (1 Jul from IREPS is 2025-06-30T18:30:00.000Z) and
  // answers HTTP 400 to a date compared with a plain string, so match the whole IST day
  const start = Date.parse(`${value}T00:00:00Z`) - IST_OFFSET_MS;
  if (!Number.isFinite(start)) throw new Error(`Not a YYYY-MM-DD date for ${key}: ${value}`);
  const at = (ms) => `TIMESTAMP '${new Date(ms).toISOString()}'`;
  return `(${ECM_FIELDS[key]} >= ${at(start)} AND ${ECM_FIELDS[key]} < ${at(start + 86400000)})`;
}

/**
 * The spreadsheet's "Query to retrieve" for a kind in a site (type + ecm:ancestorId), plus
 * live documents only, newest first, and optional field filters, e.g.
 * { customer_po_number: "PO-1" }. Same NXQL as the gateway's build_query.
 * @param {{ env?: string, site: string, kind?: string, filters?: object }} query
 */
export function buildEcmQuery({ env = ECM_CONFIG.env, site, kind, filters = {} }) {
  const s = (ECM_SITES[env] || {})[site];
  if (!s) throw new Error(`Unknown ECM site: ${site} (${env})`);
  const clauses = ["ecm:isVersion = 0", "ecm:isTrashed = 0"];
  clauses.push(kind ? `${TYPE_PROPERTY} = ${nxqlLiteral(kind)}` : `ecm:primaryType = ${nxqlLiteral(DOC_TYPE)}`);
  clauses.push(`ecm:ancestorId = ${nxqlLiteral(s.siteId)}`);
  // blanks dropped, dates as YYYY-MM-DD (as uploads send them)
  for (const [key, value] of Object.entries(ecmFields(filters))) clauses.push(fieldClause(key, value));
  return `SELECT * FROM Document WHERE ${clauses.join(" AND ")} ORDER BY dc:created DESC`;
}

/** Settings check + the fetch to use; throws ECM_NOT_CONFIGURED when the ECM cannot be called. */
async function connection(deps = {}) {
  await loadEcmConfig();
  const problem = ecmDirectProblem(deps.hostPermissions || manifestHostPermissions());
  if (problem) throw new EcmError(ECM_ERROR.NOT_CONFIGURED, { detail: problem });
  return { fetch: deps.fetch || ((...args) => globalThis.fetch(...args)) };
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** One HTTP request to the ECM with the timeout; network failure -> ECM_UNAVAILABLE. */
async function send(conn, method, path, { headers = {}, body } = {}) {
  const fetchImpl = conn.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ECM_CONFIG.timeoutMs);
  try {
    return await fetchImpl(`${ECM_CONFIG.domain}${path}`, { method, headers, body, credentials: "omit", signal: controller.signal });
  } catch (error) {
    const timedOut = error && error.name === "AbortError";
    // never log `path`: the token request carries the client secret in its query string
    logger.warn(`ECM unreachable (${method})`, { error: error && error.message });
    throw new EcmError(ECM_ERROR.UNAVAILABLE, { detail: timedOut ? `no response within ${Math.round(ECM_CONFIG.timeoutMs / 1000)} seconds` : `could not reach ${new URL(ECM_CONFIG.domain).origin}` });
  } finally {
    clearTimeout(timer);
  }
}

/** The cached bearer token, or a new one from the client-credentials pair. */
async function bearer(conn) {
  const key = `${ECM_CONFIG.domain}|${ECM_CONFIG.clientId}`;
  if (token && token.key === key && Date.now() < token.expiresAt) return token.value;
  const query = new URLSearchParams({ grant_type: "client_credentials", client_id: ECM_CONFIG.clientId, client_secret: ECM_CONFIG.clientSecret });
  const response = await send(conn, "POST", `/nuxeo/oauth2/token?${query}`);
  const body = await readJson(response);
  if (response.status === 400 || response.status === 401 || response.status === 403) {
    throw new EcmError(ECM_ERROR.NOT_CONFIGURED, { status: response.status, detail: "the ECM refused the client id / secret" });
  }
  if (!response.ok || !body || !body.access_token) {
    throw new EcmError(ECM_ERROR.UNAVAILABLE, { status: response.status, detail: `token request failed (HTTP ${response.status})` });
  }
  const ttl = Number(body.expires_in) > 0 ? Number(body.expires_in) : TOKEN_TTL_FALLBACK_S;
  token = { key, value: body.access_token, expiresAt: Date.now() + Math.max(ttl - TOKEN_REFRESH_MARGIN_S, 0) * 1000 };
  logger.info(`ECM token fetched (valid ${ttl}s)`);
  return token.value;
}

/** An authenticated request to a full path; on 401 the token is dropped and the call retried once. */
async function authed(conn, method, fullPath, { headers = {}, body } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    const response = await send(conn, method, fullPath, { headers: { Authorization: `Bearer ${await bearer(conn)}`, ...headers }, body });
    if (response.status !== 401 || attempt === 2) return response;
    logger.warn("ECM returned 401; fetching a new token and retrying once");
    token = null;
  }
}

/** An authenticated REST API call (path below /nuxeo/api/v1). */
function call(conn, method, path, options) {
  return authed(conn, method, `${API}${path}`, options);
}

/** A non-2xx answer as an EcmError: 4xx -> ECM_REJECTED (the reason kept), else ECM_UNAVAILABLE. */
function httpError(response, body, what) {
  const status = response.status;
  const message = body && typeof body.message === "string" ? body.message : "";
  if (status === 401 || status === 403) {
    return new EcmError(ECM_ERROR.REJECTED, { status, detail: `the ECM denied access (HTTP ${status})${message ? `: ${message}` : ""}` });
  }
  const detail = `${what}: HTTP ${status}${message ? ` - ${message}` : ""}`;
  return new EcmError(status >= 400 && status < 500 ? ECM_ERROR.REJECTED : ECM_ERROR.UNAVAILABLE, { status, detail });
}

async function callJson(conn, method, path, options) {
  const response = await call(conn, method, path, options);
  const body = await readJson(response);
  if (!response.ok) throw httpError(response, body, `${method} ${path.split("?")[0]}`);
  if (!body || typeof body !== "object") throw new EcmError(ECM_ERROR.UNAVAILABLE, { status: response.status, detail: `${method} ${path.split("?")[0]}: unexpected answer` });
  return body;
}

/** Run an NXQL query, following pages until `limit` entries or the last page. */
async function search(conn, nxql, { limit = 200, pageSize = 100, properties = "*" } = {}) {
  const results = [];
  for (let page = 0; ; page += 1) {
    const query = new URLSearchParams({ query: nxql, pageSize: String(Math.min(pageSize, limit)), currentPageIndex: String(page) });
    const body = await callJson(conn, "GET", `/search/lang/NXQL/execute?${query}`, { headers: { Properties: properties } });
    const entries = Array.isArray(body.entries) ? body.entries : [];
    results.push(...entries);
    if (results.length >= limit) return results.slice(0, limit);
    if (entries.length === 0 || !body.isNextPageAvailable) return results;
  }
}

/**
 * Run an NXQL query against the ECM (e.g. one from buildEcmQuery) and return its entries.
 * @param {string} nxql
 * @param {{ limit?: number, pageSize?: number, properties?: string }} [options]
 * @param {{ fetch?: typeof fetch, hostPermissions?: string[] }} [deps]
 */
export async function searchEcm(nxql, options = {}, deps = {}) {
  return search(await connection(deps), nxql, options);
}

/**
 * Run a Nuxeo automation operation at the path "Meta data from ECM Bill upload" gives
 * (the bill upload's RetrieveInvoiceData / GetAttachmentFromInvoice):
 *   POST {domain}/nuxeo/site/api/v1/automation/<operation>   application/json+nxrequest  {"params":{...}}
 * The answer's shape is not documented yet, so it is returned as received: parsed JSON, or
 * { bytes, contentType } for anything else (a blob).
 * @param {string} operation
 * @param {object} params
 * @param {{ fetch?: typeof fetch, hostPermissions?: string[] }} [deps]
 */
export async function callEcmAutomation(operation, params, deps = {}) {
  const conn = await connection(deps);
  const path = `/nuxeo/site/api/v1/automation/${encodeURIComponent(operation)}`;
  const response = await authed(conn, "POST", path, {
    headers: { "Content-Type": "application/json+nxrequest", Accept: "application/json, */*" },
    body: JSON.stringify({ params: params || {} })
  });
  const contentType = response.headers.get("content-type") || "";
  if (/json/i.test(contentType)) {
    const body = await readJson(response);
    if (!response.ok) throw httpError(response, body, `automation ${operation}`);
    return body;
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!response.ok) throw httpError(response, null, `automation ${operation}`);
  // Nuxeo answers 204 when the operation returns nothing
  if (bytes.length === 0) return null;
  return { bytes, contentType };
}

/**
 * The main file of a document: GET /nuxeo/api/v1/id/{uid}/@blob/file:content.
 * @returns {Promise<{ bytes: Uint8Array, contentType: string, filename: string|null }>}
 */
export async function fetchEcmBlob(uid, deps = {}) {
  const conn = await connection(deps);
  const response = await call(conn, "GET", `/id/${encodeURIComponent(uid)}/@blob/file:content`);
  if (!response.ok) throw httpError(response, await readJson(response), "GET document file");
  const disposition = response.headers.get("content-disposition") || "";
  const named = /filename\*=UTF-8''([^;]+)/i.exec(disposition) || /filename="?([^";]+)"?/i.exec(disposition);
  let filename = null;
  if (named) {
    try {
      filename = decodeURIComponent(named[1]);
    } catch {
      filename = named[1];
    }
  }
  return { bytes: new Uint8Array(await response.arrayBuffer()), contentType: response.headers.get("content-type") || "", filename };
}

/** Documents of a kind in a site, e.g. findEcmDocuments({ site: "hosur", kind: "poCopy", filters: { customer_po_number: "PO-1" } }). */
export async function findEcmDocuments({ site, kind, filters, limit = 200 }, deps = {}) {
  return searchEcm(buildEcmQuery({ site, kind, filters }), { limit }, deps);
}

/**
 * A site location's folder uid, checked once per session: the uid the ECM team supplied is
 * opened (a folder that was deleted, is not readable by the client, or whose folder type the
 * ECM no longer has fails here, by name, instead of as a puzzling search error), else the
 * path is looked up.
 */
async function folderUid(conn, site, location) {
  const known = site.folderIds[location];
  const path = site.locations[location];
  const cacheKey = `${ECM_CONFIG.domain}|${known || path}`;
  if (folderUids.has(cacheKey)) return folderUids.get(cacheKey);
  let uid;
  if (known) {
    const response = await call(conn, "GET", `/id/${encodeURIComponent(known)}`, { headers: { Properties: "dublincore" } });
    const body = await readJson(response);
    if (response.status >= 500) throw httpError(response, body, `GET /id/${known}`);
    if (!response.ok || !body || body.uid !== known) {
      const message = body && typeof body.message === "string" ? ` - ${body.message}` : "";
      throw new EcmError(ECM_ERROR.REJECTED, { status: response.status, detail: `the ${site.name} ${location} folder ${path} (uid ${known}) cannot be opened on the ECM: HTTP ${response.status}${message}` });
    }
    if (body.path && body.path !== path) logger.warn(`ECM folder ${known} is at ${body.path}, not ${path}`);
    uid = known;
  } else {
    const entries = await search(conn, `SELECT * FROM Document WHERE ecm:path = ${nxqlLiteral(path)}`, { limit: 1, properties: "dublincore" });
    if (!entries.length || !entries[0].uid) {
      throw new EcmError(ECM_ERROR.REJECTED, { detail: `no ECM folder at ${path} (check the path and the client's permissions)` });
    }
    uid = entries[0].uid;
  }
  folderUids.set(cacheKey, uid);
  return uid;
}

/**
 * The live document of this kind in this folder with the same title, file name and
 * metadata (the gateway's _find_existing). IREPS is re-checked daily, so the same
 * document comes back; this keeps it to one copy.
 * Dates are left out: the ECM keeps them as timestamps whose day depends on the time zone
 * of whoever stored them (1 Jul IST is 2025-06-30T18:30:00.000Z), and the other fields
 * already pin the document down.
 */
export function existingDocumentQuery({ kind, folderUid: parent, title, filename, values }) {
  const clauses = [
    "ecm:isVersion = 0",
    "ecm:isTrashed = 0",
    `${TYPE_PROPERTY} = ${nxqlLiteral(kind)}`,
    `ecm:parentId = ${nxqlLiteral(parent)}`,
    `dc:title = ${nxqlLiteral(title)}`,
    `file:content/name = ${nxqlLiteral(filename)}`,
    ...Object.entries(values)
      .filter(([key]) => !isDateField(key))
      .map(([key, value]) => fieldClause(key, value))
  ];
  return `SELECT * FROM Document WHERE ${clauses.join(" AND ")}`;
}

/**
 * The live grouped document (services/ecm-catalog.js groupKind) of this kind in this folder with
 * this title and tender number, oldest first: the one DocLink adds to. Only the kind's required
 * non-date fields are compared, so a document made before the ECM had tenderDate still matches.
 */
export function groupDocumentQuery({ kind, folderUid: parent, title, values }) {
  const required = (ECM_KINDS[kind] || { required: [] }).required.filter((key) => !isDateField(key) && key in values);
  const clauses = [
    "ecm:isVersion = 0",
    "ecm:isTrashed = 0",
    `${TYPE_PROPERTY} = ${nxqlLiteral(kind)}`,
    `ecm:parentId = ${nxqlLiteral(parent)}`,
    `dc:title = ${nxqlLiteral(title)}`,
    ...required.map((key) => fieldClause(key, values[key]))
  ];
  return `SELECT * FROM Document WHERE ${clauses.join(" AND ")} ORDER BY dc:created ASC`;
}

/** Where a document holds the file called `name`: "file:content", "files:files/<n>/file", or null. */
export function fileXpath(props, name) {
  if ((props["file:content"] || {}).name === name) return "file:content";
  const index = (props["files:files"] || []).findIndex((entry) => entry && entry.file && entry.file.name === name);
  return index >= 0 ? `files:files/${index}/file` : null;
}

function saved(entry, site, deduplicated) {
  const props = entry.properties || {};
  return { uid: entry.uid, path: entry.path ?? null, title: entry.title ?? props["dc:title"] ?? null, site, deduplicated };
}

const reject = (detail) => new EcmError(ECM_ERROR.REJECTED, { detail });

/** A document's file record at `xpath`: "file:content" (the main file) or "files:files/<n>/file" (an attachment). */
function fileAt(props, xpath) {
  if (xpath === "file:content") return props["file:content"] || null;
  const match = /^files:files\/(\d+)\/file$/.exec(xpath);
  return match ? ((props["files:files"] || [])[Number(match[1])] || {}).file || null : null;
}

/** The whole file at `xpath`, or null when the ECM does not serve all `length` bytes of it. */
async function readFile(conn, uid, xpath, length) {
  const response = await call(conn, "GET", `/id/${encodeURIComponent(uid)}/@blob/${xpath}`);
  try {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (response.ok && bytes.length === length) return bytes;
  } catch {
    // the ECM dropped the connection mid-file
  }
  return null;
}

/** Upload files into one new batch (file i = "upload-fileId" i) and return the batch id. */
async function uploadBatch(conn, files) {
  const batch = await callJson(conn, "POST", "/upload");
  if (!batch.batchId) throw new EcmError(ECM_ERROR.UNAVAILABLE, { detail: "the upload batch answer had no batchId" });
  for (const [i, file] of files.entries()) {
    await callJson(conn, "POST", `/upload/${encodeURIComponent(batch.batchId)}/${i}`, {
      // header values must be ASCII
      headers: { "X-File-Name": encodeURIComponent(file.name), "X-File-Type": file.mimeType, "Content-Type": file.mimeType },
      body: file.bytes
    });
  }
  return batch.batchId;
}

const batchRef = (batchId, i) => ({ "upload-batch": batchId, "upload-fileId": String(i) });

/** "A.pdf" -> "A_old.pdf", or "A_old_2.pdf", ... when that name is taken. */
export function oldFileName(name, taken = []) {
  const dot = name.lastIndexOf(".");
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 1; ; n += 1) {
    const candidate = `${base}_old${n === 1 ? "" : `_${n}`}${ext}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

/**
 * Can the ECM serve the document's file in full? Its last byte is read back (a ranged GET).
 * The ECM re-saves IC / PO / MA PDFs while creating them; when that goes wrong the record
 * keeps the uploaded length while the stored file is shorter, and every download of it
 * breaks off ("Failed to skip in stream" past the real end). Such a document is reported
 * as ECM_FILE_DAMAGED, so the caller saves it locally instead of calling it stored.
 */
async function assertFileReadable(conn, uid, filename, xpath = "file:content") {
  const doc = await callJson(conn, "GET", `/id/${encodeURIComponent(uid)}`, { headers: { Properties: "file,files" } });
  const length = Number((fileAt(doc.properties || {}, xpath) || {}).length);
  const damaged = (detail) => new EcmError(ECM_ERROR.DAMAGED, { detail: `document ${uid}: ${detail}` });
  if (!(length > 0)) throw damaged(`it has no file${xpath === "file:content" ? "" : ` at ${xpath}`}`);
  const response = await call(conn, "GET", `/id/${encodeURIComponent(uid)}/@blob/${xpath}`, { headers: { Range: `bytes=${length - 1}-` } });
  let served = -1;
  try {
    served = (await response.arrayBuffer()).byteLength;
  } catch {
    // the ECM dropped the connection mid-file
  }
  // the one byte asked for (the TEST ECM answers it with 200, not 206), or the whole file when
  // ranges are not honoured; a damaged file is an HTTP 500 error page
  if (response.ok && (served === 1 || served === length)) return;
  logger.warn(`ECM cannot serve ${filename} in full`, { uid, length, status: response.status, served });
  throw damaged(`the record says ${length} bytes but the file cannot be read to its end (HTTP ${response.status})`);
}

/**
 * Move a document to the ECM trash (Nuxeo's Document.Trash; not in ECM_API_DOC). It is not
 * deleted: the ECM team can restore it. Used only for damaged copies: DocLink's own new one, or
 * a further damaged copy of a document downloaded again.
 */
async function trashDocument(conn, uid) {
  const body = await callJson(conn, "POST", `/id/${encodeURIComponent(uid)}/@op/Document.Trash`, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ params: {} })
  });
  if (body.isTrashed === false) throw new EcmError(ECM_ERROR.UNAVAILABLE, { detail: `document ${uid} was not moved to the trash` });
}

/**
 * Download again into an existing document (uid): the new PDF becomes its main file, under the
 * main file's current name (the ECM renames files when it creates a document, e.g.
 * <PO>_MODIFICATIONADVISE.pdf). The old main file is
 *   - kept as an attachment (files:files) named <name>_old.pdf when the ECM can serve it in full,
 *   - dropped when it is damaged (confirmed by the ranged read of assertFileReadable).
 * A list property is replaced as a whole, so attachments already there are read and sent again;
 * one that cannot be read leaves the document unchanged (ECM_UNAVAILABLE). Title and metadata
 * are not touched.
 */
async function replaceInDocument(conn, uid, { bytes, filename, mimeType }) {
  const current = await callJson(conn, "GET", `/id/${encodeURIComponent(uid)}`, { headers: { Properties: "file,files" } });
  const props = current.properties || {};
  const main = props["file:content"] || null;
  const name = (main && main.name) || filename;
  const unchanged = (detail) => new EcmError(ECM_ERROR.UNAVAILABLE, { detail: `document ${uid}: ${detail}; the document was not changed` });

  const old = main && Number(main.length) > 0 ? await readFile(conn, uid, "file:content", Number(main.length)) : null;
  let oldDamaged = false;
  if (main && !old) {
    // only a file the ECM really cannot serve is dropped; anything else stops the replace
    try {
      await assertFileReadable(conn, uid, name);
    } catch (error) {
      if (!(error instanceof EcmError && error.code === ECM_ERROR.DAMAGED)) throw error;
      oldDamaged = true;
    }
    if (!oldDamaged) throw unchanged(`its current file ${name} could not be read`);
  }
  const kept = [];
  for (const [i, entry] of (props["files:files"] || []).entries()) {
    const file = entry && entry.file;
    if (!file) continue;
    const content = await readFile(conn, uid, `files:files/${i}/file`, Number(file.length));
    if (!content) throw unchanged(`its attachment ${file.name} could not be read`);
    kept.push({ name: file.name, mimeType: file["mime-type"] || "application/octet-stream", bytes: content });
  }
  const oldFile = old ? oldFileName(name, kept.map((k) => k.name)) : null;
  const files = [{ name, mimeType, bytes }, ...kept, ...(old ? [{ name: oldFile, mimeType: main["mime-type"] || mimeType, bytes: old }] : [])];

  const batchId = await uploadBatch(conn, files);
  const properties = { "file:content": batchRef(batchId, 0) };
  if (files.length > 1) properties["files:files"] = files.slice(1).map((_, i) => ({ file: batchRef(batchId, i + 1) }));
  const updated = await callJson(conn, "PUT", `/id/${encodeURIComponent(uid)}`, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ "entity-type": "document", properties })
  });
  await assertFileReadable(conn, uid, name);
  let oldFileReadable = null;
  if (oldFile) {
    oldFileReadable = await assertFileReadable(conn, uid, oldFile, `files:files/${files.length - 2}/file`).then(() => true, (error) => {
      logger.warn(`The ECM cannot serve the kept old file ${oldFile} in full`, { uid, detail: error && error.detail });
      return false;
    });
  }
  return { document: { ...current, ...updated, uid }, oldFile, oldDamaged, oldFileReadable };
}

/**
 * Upload one document straight to the ECM folder of the account's unit.
 * Same input and answer as ecm-service uploadToEcm (it dispatches here in direct mode).
 *
 * A new document the ECM damaged is moved to the trash (DocLink's own copy), and the error is
 * ECM_FILE_DAMAGED: the caller saves the file locally.
 *
 * `replace` (uids of the copies already in the folder, from findInFolder, when the user chose
 * to download them again): no new document; the first copy gets the new PDF
 * (replaceInDocument: a healthy old PDF is kept in it as <name>_old.pdf, a damaged one is
 * dropped). Any further copy the ECM damaged goes to the trash; healthy ones are left alone.
 *
 * @param {{ kind: string, bytes: Uint8Array, filename: string, title?: string, fields?: object,
 *           account: { irepsAccountId?: string|null, operatingUnit?: string|null }, mimeType?: string,
 *           replace?: string[] }} doc
 * @param {{ fetch?: typeof fetch, hostPermissions?: string[] }} [deps]
 * @returns {Promise<{ uid: string, path: string|null, title: string|null, site: string, deduplicated: boolean,
 *           replaced?: { oldFile: string|null, oldDamaged: boolean, oldFileReadable: boolean|null, trashed: string[] } }>}
 *          replaced (a replace only): the old PDF's name in the document (null: it was damaged and dropped),
 *          and the further damaged copies moved to the trash
 */
export async function uploadToNuxeo(doc, deps = {}) {
  const conn = await connection(deps);
  const kind = ECM_KINDS[doc.kind];
  if (!kind) throw new Error(`Unsupported ECM kind: ${doc.kind}`);
  const account = doc.account || {};
  if (!account.irepsAccountId && !account.operatingUnit) {
    throw new EcmError(ECM_ERROR.ACCOUNT_UNKNOWN, { detail: "the IREPS account could not be verified" });
  }

  const env = ECM_CONFIG.env;
  let siteKey;
  try {
    siteKey = routeSite(env, account);
  } catch (error) {
    throw reject(error.message);
  }
  const site = ECM_SITES[env][siteKey];
  const values = ecmFields(doc.fields);
  const unknown = Object.keys(values).filter((key) => !kind.fields.includes(key));
  if (unknown.length) throw reject(`${doc.kind} has no field ${unknown.join(", ")}`);
  const missing = kind.required.filter((key) => !(key in values));
  if (missing.length) throw reject(`${doc.kind} requires ${missing.join(", ")}`);
  if (!site.locations[kind.location]) throw reject(`the ${site.name} site has no ${kind.location} folder on ${env}, so it cannot hold ${doc.kind} documents`);

  const filename = String(doc.filename || "").split("/").pop() || "upload";
  const title = String(doc.title || "").trim() || renderTitle(kind.title, values) || filename.replace(/\.[^.]*$/, "");
  const mimeType = doc.mimeType || "application/pdf";
  logger.info(`Uploading ${filename} to the ECM directly`, { kind: doc.kind, env, site: siteKey, bytes: doc.bytes.length, fields: Object.keys(values) });

  const parent = await folderUid(conn, site, kind.location);
  if (kind.group) {
    // never asked for: the download check does not look grouped documents up in the ECM
    if (doc.replace && doc.replace.length) logger.warn(`ECM: ${filename} goes into the ${doc.kind} document of its tender; nothing is replaced`);
    return addToTenderDocument(conn, { kind: doc.kind, parent, siteKey, title, filename, mimeType, bytes: doc.bytes, values });
  }
  const replace = [...new Set((doc.replace || []).filter(Boolean).map(String))];
  if (replace.length) {
    const [target, ...others] = replace;
    const done = await replaceInDocument(conn, target, { bytes: doc.bytes, filename, mimeType });
    const trashed = [];
    for (const uid of others) {
      const damaged = await assertFileReadable(conn, uid, filename).then(() => false, (error) => error instanceof EcmError && error.code === ECM_ERROR.DAMAGED);
      if (!damaged) continue;
      await trashDocument(conn, uid).then(() => trashed.push(uid), (error) => logger.warn(`Could not move the damaged copy ${uid} to the ECM trash`, { detail: error && error.detail }));
    }
    logger.info(`ECM: ${filename} replaced the PDF of document ${target}`, { oldFile: done.oldFile, oldDamaged: done.oldDamaged, trashed });
    return { ...saved(done.document, siteKey, false), replaced: { oldFile: done.oldFile, oldDamaged: done.oldDamaged, oldFileReadable: done.oldFileReadable, trashed } };
  }
  const [existing] = await search(conn, existingDocumentQuery({ kind: doc.kind, folderUid: parent, title, filename, values }), { limit: 1 });
  if (existing) {
    logger.info(`ECM already had ${filename}`, { kind: doc.kind, site: siteKey, uid: existing.uid });
    // an earlier copy the ECM damaged keeps DocLink's name and metadata, so it is found here
    await assertFileReadable(conn, existing.uid, filename);
    return saved(existing, siteKey, true);
  }

  const created = await createDocument(conn, { kind: doc.kind, parent, title, filename, mimeType, bytes: doc.bytes, values });
  logger.info(`ECM stored ${filename}`, { kind: doc.kind, site: siteKey, uid: created.uid });
  return saved(created, siteKey, false);
}

/**
 * A new document in `parent` with the file as its main file, read back in full. A copy the ECM
 * damaged is moved to the trash (DocLink's own copy) and ECM_FILE_DAMAGED is thrown.
 */
async function createDocument(conn, { kind, parent, title, filename, mimeType, bytes, values }) {
  const batchId = await uploadBatch(conn, [{ name: filename, mimeType, bytes }]);
  const properties = { "dc:title": title, [TYPE_PROPERTY]: kind };
  for (const [key, value] of Object.entries(values)) properties[ECM_FIELDS[key]] = value;
  properties["file:content"] = batchRef(batchId, 0);
  const created = await callJson(conn, "POST", `/id/${encodeURIComponent(parent)}`, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ "entity-type": "document", name: title.replace(NAME_UNSAFE, "-").slice(0, 120) || kind, type: DOC_TYPE, properties })
  });
  if (!created.uid) throw new EcmError(ECM_ERROR.UNAVAILABLE, { detail: "the ECM answer had no document uid" });
  try {
    await assertFileReadable(conn, created.uid, filename);
  } catch (error) {
    // DocLink's own broken copy is not left in the folder (the file is saved locally instead)
    if (error instanceof EcmError && error.code === ECM_ERROR.DAMAGED) {
      await trashDocument(conn, created.uid).catch((e) => logger.warn(`Could not move the damaged copy ${created.uid} to the ECM trash`, { detail: e && e.detail }));
    }
    throw error;
  }
  return created;
}

/**
 * A grouped kind (services/ecm-catalog.js groupKind): one document per tender, "<T> - NIT",
 * "<T> - LOA", "<T> - Result". The first PDF creates it as its main file; each later PDF is
 * appended to its attachments (files:files) by Nuxeo's Blob.AttachOnDocument, which adds one
 * file without re-sending the others. A file already in it under the same name is not added
 * again (deduplicated). Metadata the document lacks (a tender date) is filled in, never changed.
 * Uploads are serialised by ecm-service.js uploadToEcm, so two PDFs of a tender never race to
 * create two documents.
 *
 * An attachment the ECM damaged stays in the document (removing one means re-sending the
 * others) and ECM_FILE_DAMAGED is thrown, so the caller saves the PDF locally; the same happens
 * on the next run, as the damaged attachment is found by name.
 */
async function addToTenderDocument(conn, { kind, parent, siteKey, title, filename, mimeType, bytes, values }) {
  const [group] = await search(conn, groupDocumentQuery({ kind, folderUid: parent, title, values }), { limit: 1 });
  if (!group) {
    const created = await createDocument(conn, { kind, parent, title, filename, mimeType, bytes, values });
    logger.info(`ECM stored ${filename} as the new document ${title}`, { kind, site: siteKey, uid: created.uid });
    return saved(created, siteKey, false);
  }
  const uid = group.uid;
  const props = group.properties || {};
  const held = fileXpath(props, filename);
  if (held) {
    logger.info(`ECM already had ${filename} in ${title}`, { kind, site: siteKey, uid, xpath: held });
    await assertFileReadable(conn, uid, filename, held);
    return saved(group, siteKey, true);
  }

  const batchId = await uploadBatch(conn, [{ name: filename, mimeType, bytes }]);
  const attached = await call(conn, "POST", `/upload/${encodeURIComponent(batchId)}/0/execute/Blob.AttachOnDocument`, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ params: { document: uid, xpath: "files:files", save: true } })
  });
  // the answer is the attached file itself, so only its status is read
  if (!attached.ok) throw httpError(attached, await readJson(attached), `Blob.AttachOnDocument ${uid}`);

  const lacking = Object.entries(values).filter(([key]) => props[ECM_FIELDS[key]] === undefined || props[ECM_FIELDS[key]] === null || props[ECM_FIELDS[key]] === "");
  if (lacking.length) {
    // best effort: the PDF is already in the document, so a failure here must not save it locally too
    await callJson(conn, "PUT", `/id/${encodeURIComponent(uid)}`, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ "entity-type": "document", properties: Object.fromEntries(lacking.map(([key, value]) => [ECM_FIELDS[key], value])) })
    }).catch((error) => logger.warn(`Could not fill ${lacking.map(([key]) => key).join(", ")} of ECM document ${uid}`, { detail: error && error.detail }));
  }

  const after = await callJson(conn, "GET", `/id/${encodeURIComponent(uid)}`, { headers: { Properties: "file,files" } });
  const xpath = fileXpath(after.properties || {}, filename);
  if (!xpath) throw new EcmError(ECM_ERROR.UNAVAILABLE, { detail: `document ${uid}: ${filename} is not among its files after it was attached` });
  await assertFileReadable(conn, uid, filename, xpath);
  logger.info(`ECM added ${filename} to ${title}`, { kind, site: siteKey, uid, xpath });
  return saved(group, siteKey, false);
}

const IN_CHUNK = 100; // values per "IN (...)" in findInFolder

/**
 * Which candidates are already in the folder their upload would go to (the gateway's
 * find_in_folder, for ecm-service findInEcm in direct mode). One query per chunk of the
 * kind's first required field, then each candidate must match every one of its non-date
 * fields, and its title when given; file names are not compared.
 *
 * @param {{ kind: string, account: object, candidates: { ref: string, fields: object, title?: string }[] }} query
 *        fields already as ecmFields() makes them
 * @param {{ fetch?: typeof fetch, hostPermissions?: string[] }} [deps]
 * @returns {Promise<Map<string, { uid: string, path: string|null, title: string|null, uids: string[] }>>}
 *          uid / path / title: the first match; uids: every matching copy (what a replace trashes)
 */
export async function findInFolder({ kind: kindKey, account, candidates }, deps = {}) {
  const conn = await connection(deps);
  const kind = ECM_KINDS[kindKey];
  if (!kind) throw new Error(`Unsupported ECM kind: ${kindKey}`);
  const env = ECM_CONFIG.env;
  let site;
  try {
    site = ECM_SITES[env][routeSite(env, account || {})];
  } catch (error) {
    throw reject(error.message);
  }
  if (!site.locations[kind.location]) throw reject(`the ${site.name} site has no ${kind.location} folder on ${env}`);
  const anchor = kind.required.find((key) => !isDateField(key));
  const wanted = candidates
    .map((c) => ({ ref: c.ref, title: c.title ? String(c.title).trim() : "", fields: Object.fromEntries(Object.entries(c.fields || {}).filter(([key]) => !isDateField(key) && kind.fields.includes(key))) }))
    .filter((c) => c.fields[anchor]);
  const found = new Map();
  if (wanted.length === 0) return found;

  const parent = await folderUid(conn, site, kind.location);
  const values = [...new Set(wanted.map((c) => c.fields[anchor]))].sort();
  const docs = [];
  for (let i = 0; i < values.length; i += IN_CHUNK) {
    const list = values.slice(i, i + IN_CHUNK).map(nxqlLiteral).join(", ");
    const nxql = `SELECT * FROM Document WHERE ecm:isVersion = 0 AND ecm:isTrashed = 0 AND ${TYPE_PROPERTY} = ${nxqlLiteral(kindKey)} AND ecm:parentId = ${nxqlLiteral(parent)} AND ${ECM_FIELDS[anchor]} IN (${list})`;
    docs.push(...(await search(conn, nxql, { limit: 10000 })));
  }
  const same = (doc, c) => {
    const props = doc.properties || {};
    if (c.title && String(props["dc:title"] ?? doc.title ?? "").trim() !== c.title) return false;
    return Object.entries(c.fields).every(([key, value]) => String(props[ECM_FIELDS[key]] ?? "").trim() === String(value));
  };
  for (const c of wanted) {
    const hits = docs.filter((d) => same(d, c));
    const [hit] = hits;
    if (hit) found.set(c.ref, { uid: hit.uid, path: hit.path ?? null, title: hit.title ?? (hit.properties || {})["dc:title"] ?? null, uids: hits.map((d) => d.uid) });
  }
  return found;
}

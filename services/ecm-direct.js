/**
 * Direct ECM upload (config.json "ecmBackendAws": false, for local testing): DocLink calls
 * the ECM (Nuxeo) REST API itself instead of the Recon Engine's ECM gateway. A port of the
 * gateway's backend/ECM/ecm_client (client.py, auth.py, service.save_document), following
 * "ECM_API_DOC" and "TSG India Doculink ECM specifications.xlsx":
 *
 *   POST {domain}/nuxeo/oauth2/token?grant_type=client_credentials&...   bearer token
 *   GET  {domain}/nuxeo/api/v1/search/lang/NXQL/execute?query=...         search (NXQL)
 *   POST {domain}/nuxeo/api/v1/upload                                     open a batch
 *   POST {domain}/nuxeo/api/v1/upload/{batchId}/0                         the file
 *   POST {domain}/nuxeo/api/v1/id/{folderUid}                             create the document
 *
 * Same folders (services/ecm-catalog.js), same metadata and the same answer as the gateway
 * ({ uid, path, title, site, deduplicated }), and the same EcmError codes, so callers,
 * the local fallback and the panel do not know which path was taken. A document already
 * in the folder (same kind, title, file name and metadata) is not stored twice.
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

/** An authenticated API call; on 401 the token is dropped and the call retried once. */
async function call(conn, method, path, { headers = {}, body } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    const response = await send(conn, method, `${API}${path}`, { headers: { Authorization: `Bearer ${await bearer(conn)}`, ...headers }, body });
    if (response.status !== 401 || attempt === 2) return response;
    logger.warn("ECM returned 401; fetching a new token and retrying once");
    token = null;
  }
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

/** Documents of a kind in a site, e.g. findEcmDocuments({ site: "hosur", kind: "poCopy", filters: { customer_po_number: "PO-1" } }). */
export async function findEcmDocuments({ site, kind, filters, limit = 200 }, deps = {}) {
  return searchEcm(buildEcmQuery({ site, kind, filters }), { limit }, deps);
}

/** A site location's folder uid: the one the ECM team supplied, else the path looked up once. */
async function folderUid(conn, site, location) {
  const known = site.folderIds[location];
  if (known) return known;
  const path = site.locations[location];
  const cacheKey = `${ECM_CONFIG.domain}|${path}`;
  if (folderUids.has(cacheKey)) return folderUids.get(cacheKey);
  const entries = await search(conn, `SELECT * FROM Document WHERE ecm:path = ${nxqlLiteral(path)}`, { limit: 1, properties: "dublincore" });
  if (!entries.length || !entries[0].uid) {
    throw new EcmError(ECM_ERROR.REJECTED, { detail: `no ECM folder at ${path} (check the path and the client's permissions)` });
  }
  folderUids.set(cacheKey, entries[0].uid);
  return entries[0].uid;
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

function saved(entry, site, deduplicated) {
  const props = entry.properties || {};
  return { uid: entry.uid, path: entry.path ?? null, title: entry.title ?? props["dc:title"] ?? null, site, deduplicated };
}

const reject = (detail) => new EcmError(ECM_ERROR.REJECTED, { detail });

/**
 * Upload one document straight to the ECM folder of the account's unit.
 * Same input and answer as ecm-service uploadToEcm (it dispatches here in direct mode).
 *
 * @param {{ kind: string, bytes: Uint8Array, filename: string, title?: string, fields?: object,
 *           account: { irepsAccountId?: string|null, operatingUnit?: string|null }, mimeType?: string }} doc
 * @param {{ fetch?: typeof fetch, hostPermissions?: string[] }} [deps]
 * @returns {Promise<{ uid: string, path: string|null, title: string|null, site: string, deduplicated: boolean }>}
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
  const [existing] = await search(conn, existingDocumentQuery({ kind: doc.kind, folderUid: parent, title, filename, values }), { limit: 1 });
  if (existing) {
    logger.info(`ECM already had ${filename}`, { kind: doc.kind, site: siteKey, uid: existing.uid });
    return saved(existing, siteKey, true);
  }

  const batch = await callJson(conn, "POST", "/upload");
  if (!batch.batchId) throw new EcmError(ECM_ERROR.UNAVAILABLE, { detail: "the upload batch answer had no batchId" });
  await callJson(conn, "POST", `/upload/${encodeURIComponent(batch.batchId)}/0`, {
    // header values must be ASCII
    headers: { "X-File-Name": encodeURIComponent(filename), "X-File-Type": mimeType, "Content-Type": mimeType },
    body: doc.bytes
  });
  const properties = { "dc:title": title, [TYPE_PROPERTY]: doc.kind };
  for (const [key, value] of Object.entries(values)) properties[ECM_FIELDS[key]] = value;
  properties["file:content"] = { "upload-batch": batch.batchId, "upload-fileId": "0" };
  const created = await callJson(conn, "POST", `/id/${encodeURIComponent(parent)}`, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ "entity-type": "document", name: title.replace(NAME_UNSAFE, "-").slice(0, 120) || doc.kind, type: DOC_TYPE, properties })
  });
  if (!created.uid) throw new EcmError(ECM_ERROR.UNAVAILABLE, { detail: "the ECM answer had no document uid" });
  logger.info(`ECM stored ${filename}`, { kind: doc.kind, site: siteKey, uid: created.uid });
  return saved(created, siteKey, false);
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
 * @returns {Promise<Map<string, { uid: string, path: string|null, title: string|null }>>}
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
    const hit = docs.find((d) => same(d, c));
    if (hit) found.set(c.ref, { uid: hit.uid, path: hit.path ?? null, title: hit.title ?? (hit.properties || {})["dc:title"] ?? null });
  }
  return found;
}

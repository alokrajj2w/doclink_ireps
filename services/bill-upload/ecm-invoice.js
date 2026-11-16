/**
 * The ECM side of the bill upload (upload.md section 5, sheet "Meta data from ECM Bill upload").
 *
 *   retrieveInvoice()        POST <ECM>/nuxeo/site/api/v1/automation/RetrieveInvoiceData
 *                            {"params":{customerPO, customerPOSrNo, invoiceQuantity}}
 *                            -> exactly one invoice (none / several / already "Sent to Doculink" stop)
 *   findBillDocuments()      the spec's per-type queries (InvoiceCertificateSchema:type + site),
 *                            narrowed to this invoice / PO, newest document per type
 *   fetchBillDocument()      the document's file (GET .../id/{uid}/@blob/file:content)
 *
 * RetrieveInvoiceData has not been run yet and its answer is not documented, so the answer
 * is read defensively: a list, { entries | value | data | invoices | results: [...] }, or one
 * record; each record flat or a Nuxeo document with `properties`; column names compared
 * without schema prefix and case ("InvoiceCertificateSchema:invoiceNumber" == "invoiceNumber").
 *
 * Only the direct ECM mode (config.json "ecmBackendAws": false) can call these: the Recon
 * Engine's ECM gateway has no invoice lookup.
 */

import { loadEcmConfig, ECM_CONFIG, isDirectEcm } from "../ecm-config.js";
import { callEcmAutomation, searchEcm, fetchEcmBlob, nxqlLiteral } from "../ecm-direct.js";
import { ECM_SITES, TYPE_PROPERTY, ECM_FIELDS } from "../ecm-catalog.js";
import { EcmError } from "../ecm-service.js";
import { IrepsError } from "../ireps-api.js";
import { BILL_ERROR } from "./bill-upload-api.js";

export const RETRIEVE_INVOICE_OPERATION = "RetrieveInvoiceData";

/**
 * The bill documents: spec step 9 (a-g) plus the PO copy the team uploads too. `by` says
 * which number finds the document in the ECM; `fileDesc` is the description to type in
 * IREPS (the business still has to confirm them - upload.md open item 8).
 */
export const BILL_DOCUMENTS = Object.freeze([
  { kind: "generatedMerge", code: "INVOICE", label: "Invoice", fileDesc: "INVOICE", by: "invoice", when: "always" },
  { kind: "garrantyWarrantyCertificate", code: "GCWC", label: "GC/WC (Guarantee/Warranty Certificate)", fileDesc: "GUARANTEE WARRANTY CERTIFICATE", by: "invoice", when: "always" },
  { kind: "modvatDeclarationCertificate", code: "MODVAT", label: "Modvat Declaration", fileDesc: "MODVAT DECLARATION", by: "invoice", when: "always" },
  { kind: "workCertificate", code: "WTC", label: "WTC (Work Test Certificate)", fileDesc: "WORK TEST CERTIFICATE", by: "invoice", when: "always" },
  { kind: "eDispatchNote", code: "EDECL", label: "E-Declaration", fileDesc: "E INVOICING DECLARATION", by: "invoice", when: "CONSG" },
  { kind: "inspectionCertificate", code: "IC", label: "IC (Inspection Certificate)", fileDesc: "INSPECTION CERTIFICATE", by: "po", when: "TPI" },
  { kind: "modificationAdvise", code: "MA", label: "DP/MA", fileDesc: "MODIFICATION ADVICE", by: "po", when: "optional" },
  { kind: "poCopy", code: "PO", label: "PO copy", fileDesc: "PURCHASE ORDER", by: "po", when: "optional" }
].map(Object.freeze));

/** The signer refuses files of 8 MB or more (screenshot 12). */
export const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;

/** Invoice fields DocLink reads, keyed by the column name without prefix, lower-cased. */
const INVOICE_COLUMNS = Object.freeze({
  invoicenumber: "invoiceNumber",
  salesinvoicedate: "invoiceDate",
  onivla: "amount",
  quantity: "quantity",
  offeredquantity: "offeredQuantity",
  rate: "rate",
  totaltaxvalue: "taxAmount",
  taxcode: "taxCode",
  serviceaccountingcode: "hsn",
  customerponumber: "customerPONumber",
  customerposrnumber: "customerPOSrNumber",
  division: "division",
  gstinrecipient: "gstinRecipient",
  gstinsupplier: "gstinSupplier",
  supplyplace: "supplyPlace",
  consigneelocation: "consigneeLocation",
  consigneename: "consigneeName",
  consigneeaddressline4: "consigneeAddressLine4",
  partdescription: "partDescription",
  paymentterm: "paymentTerm",
  senttodoculink: "sentToDoculink",
  linenumber: "lineNumber"
});

const columnKey = (name) => String(name).split(":").pop().toLowerCase().replace(/[^a-z0-9]/g, "");

/** One ECM record (flat, or a Nuxeo document with properties) as DocLink's invoice. */
export function normaliseInvoice(raw, source = "ECM") {
  const flat = { ...(raw || {}), ...((raw && raw.properties) || {}) };
  const invoice = { source };
  for (const [name, value] of Object.entries(flat)) {
    const key = INVOICE_COLUMNS[columnKey(name)];
    if (key && invoice[key] === undefined && value !== null && value !== "") invoice[key] = typeof value === "string" ? value.trim() : value;
  }
  if (invoice.quantity === undefined && invoice.offeredQuantity !== undefined) invoice.quantity = invoice.offeredQuantity;
  return invoice;
}

/** The records of an automation answer, whatever its envelope. */
export function invoiceRecords(answer) {
  let body = answer;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return [];
    }
  }
  if (body && body.bytes instanceof Uint8Array) {
    try {
      body = JSON.parse(new TextDecoder().decode(body.bytes));
    } catch {
      return [];
    }
  }
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== "object") return [];
  for (const key of ["entries", "value", "data", "invoices", "results", "records"]) {
    if (Array.isArray(body[key])) return body[key];
  }
  // an automation answer wrapping its result: { "entity-type": "string", "value": "<json>" } or { value: {...} }
  if (body.value && (typeof body.value === "string" || typeof body.value === "object")) return invoiceRecords(body.value);
  return Object.keys(body).some((k) => INVOICE_COLUMNS[columnKey(k)] === "invoiceNumber") || body.properties ? [body] : [];
}

/** "Sent to Doculink" set? (Y / Yes / true / 1 / a date) */
export function isSentToDoculink(value) {
  if (value === true || value === 1) return true;
  const t = String(value ?? "").trim().toLowerCase();
  return t !== "" && !["n", "no", "false", "0", "null"].includes(t);
}

function ecmUnavailable(error) {
  if (error instanceof IrepsError) return error;
  const detail = error instanceof EcmError ? error.detail || error.code : (error && error.message) || "ECM request failed";
  return new IrepsError(BILL_ERROR.ECM_UNAVAILABLE, `ECM: ${detail}`, { detail, cause: error });
}

async function requireDirectEcm() {
  await loadEcmConfig();
  if (!isDirectEcm()) {
    throw new IrepsError(BILL_ERROR.ECM_UNAVAILABLE, "invoice lookup needs the direct ECM mode", { detail: "the invoice lookup needs the direct ECM connection (config.json \"ecmBackendAws\": false); enter the invoice details by hand instead" });
  }
}

/**
 * The one invoice ECM holds for a receipt.
 * @param {{ customerPO: string, customerPOSrNo: string, invoiceQuantity: string|number }} key
 * @param {{ fetch?: typeof fetch, hostPermissions?: string[], automation?: typeof callEcmAutomation }} [deps]
 */
export async function retrieveInvoice(key, deps = {}) {
  const automation = deps.automation || callEcmAutomation;
  if (!deps.automation) await requireDirectEcm();
  const params = { customerPO: String(key.customerPO), customerPOSrNo: String(key.customerPOSrNo), invoiceQuantity: String(key.invoiceQuantity) };
  let answer;
  try {
    answer = await automation(RETRIEVE_INVOICE_OPERATION, params, deps);
  } catch (error) {
    throw ecmUnavailable(error);
  }
  const all = invoiceRecords(answer).map((r) => normaliseInvoice(r, "ECM"));
  const fresh = all.filter((inv) => !isSentToDoculink(inv.sentToDoculink));
  const label = `PO ${params.customerPO}, PO Sr ${params.customerPOSrNo}, qty ${params.invoiceQuantity}`;
  if (fresh.length === 1) {
    if (!fresh[0].invoiceNumber) throw new IrepsError(BILL_ERROR.ECM_NOT_FOUND, "ECM record without invoice number", { detail: `ECM answered for ${label}, but the record has no invoice number` });
    return fresh[0];
  }
  if (fresh.length > 1) {
    throw new IrepsError(BILL_ERROR.ECM_AMBIGUOUS, "several ECM invoices", { detail: `${fresh.length} ECM invoices match ${label} (${fresh.map((i) => i.invoiceNumber).join(", ")})` });
  }
  if (all.length) throw new IrepsError(BILL_ERROR.ECM_ALREADY_SENT, "already sent", { detail: `invoice ${all.map((i) => i.invoiceNumber).join(", ")} for ${label} is already marked "Sent to Doculink"` });
  throw new IrepsError(BILL_ERROR.ECM_NOT_FOUND, "no ECM invoice", { detail: `no ECM invoice for ${label}` });
}

/**
 * An invoice typed by the user (while ECM cannot be matched - it has no customer PO Sr no.
 * yet). Same shape as an ECM invoice; source "entered by you".
 */
export function manualInvoice(fields = {}) {
  const pick = (k) => (fields[k] === undefined || fields[k] === null ? undefined : String(fields[k]).trim() || undefined);
  const invoice = { source: "entered by you" };
  for (const k of ["invoiceNumber", "invoiceDate", "amount", "quantity", "hsn", "taxAmount", "taxCode", "division", "gstinSupplier", "gstinRecipient", "supplyPlace", "partDescription"]) {
    const v = pick(k);
    if (v !== undefined) invoice[k] = v;
  }
  return invoice;
}

/** NXQL for this invoice's documents of the given kinds in every site of the environment. */
export function billDocumentsQuery({ kinds, field, value, env = ECM_CONFIG.env }) {
  const sites = Object.values(ECM_SITES[env] || {}).map((s) => `ecm:ancestorId = ${nxqlLiteral(s.siteId)}`);
  const types = kinds.map(nxqlLiteral).join(", ");
  return `SELECT * FROM Document WHERE ecm:isVersion = 0 AND ecm:isTrashed = 0 AND ${TYPE_PROPERTY} IN (${types}) AND ${ECM_FIELDS[field]} = ${nxqlLiteral(value)}${sites.length ? ` AND (${sites.join(" OR ")})` : ""} ORDER BY dc:created DESC`;
}

/**
 * The newest ECM document of each bill document type for this invoice / PO.
 * @param {{ invoiceNumber: string, poNumber: string }} key
 * @returns {Promise<{ document: object, uid: string|null, title: string|null, filename: string|null, others: number }[]>}
 *          one entry per BILL_DOCUMENTS type, uid null when the ECM has none
 */
export async function findBillDocuments({ invoiceNumber, poNumber }, deps = {}) {
  const search = deps.searchEcm || searchEcm;
  if (!deps.searchEcm) await requireDirectEcm();
  const byInvoice = BILL_DOCUMENTS.filter((d) => d.by === "invoice").map((d) => d.kind);
  const byPo = BILL_DOCUMENTS.filter((d) => d.by === "po").map((d) => d.kind);
  let found = [];
  try {
    if (invoiceNumber) found = found.concat(await search(billDocumentsQuery({ kinds: byInvoice, field: "invoice_number", value: invoiceNumber }), { limit: 100 }, deps));
    if (poNumber) found = found.concat(await search(billDocumentsQuery({ kinds: byPo, field: "customer_po_number", value: poNumber }), { limit: 100 }, deps));
  } catch (error) {
    throw ecmUnavailable(error);
  }
  return BILL_DOCUMENTS.map((document) => {
    const hits = found.filter((e) => ((e.properties || {})[TYPE_PROPERTY] ?? e.type) === document.kind);
    const newest = hits[0] || null;
    const props = (newest && newest.properties) || {};
    const content = props["file:content"] || {};
    return { document, uid: newest ? newest.uid : null, title: newest ? newest.title ?? props["dc:title"] ?? null : null, filename: content.name || null, others: Math.max(0, hits.length - 1) };
  });
}

/** The file of one ECM document. */
export async function fetchBillDocument(uid, deps = {}) {
  try {
    return await (deps.fetchEcmBlob || fetchEcmBlob)(uid, deps);
  } catch (error) {
    throw ecmUnavailable(error);
  }
}

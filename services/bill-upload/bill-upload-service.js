/**
 * Bill upload: an ECM invoice billed against an IREPS receipt (R-Note / CRN), up to the
 * point where IREPS needs the user's digital signature (upload.md section 4). Started by
 * hand from the side panel; every step is a separate call so the user sees and confirms
 * the values before anything is written:
 *
 *   1. findBillableReceipts()  R-NOTE and CRN search (read-only) -> receipts with a Bill Claim link
 *   2. retrieveInvoice()       ECM RetrieveInvoiceData (ecm-invoice.js), or manualInvoice()
 *   3. prepareBill()           read-only IREPS calls: bill page, paying authority, PO Sr list,
 *                              GSTIN check, receipt list + details -> every header value with its
 *                              source and the checks (nothing is written)
 *      reviewBill()            the user's corrections (supplier GSTIN, state / place of supply,
 *                              bill description) applied and re-checked
 *   4. createDraftBill()       WRITES saveBillHeader.do (the draft bill; the header cannot be edited
 *                              afterwards), then saveItem()
 *      saveItem()              fetchPOItemDetails / RO list / RO details -> amounts computed and
 *                              checked -> WRITES saveBillDetails.do
 *   5. collectBillDocuments()  the invoice's documents from ECM, checked (PDF, < 8 MB) and saved to
 *                              Downloads/DocLink/IREPS/BillUpload/<invoice>/ with the IREPS description
 *
 * Attaching the signed documents, the preview and Sign & Submit stay with the user in IREPS
 * (signing is manual by decision). A receipt with a bill DocLink created is never billed
 * again (bill-upload-store.js), and nothing is written while an error check stands or a
 * warning is unconfirmed.
 *
 * deps: fetch (IREPS transport - the service worker runs it in the IREPS tab), store,
 * searchRnote / searchCrn, ecm functions (tests inject fakes), today.
 */

import { IrepsError } from "../ireps-api.js";
import { isIrepsLoginPage } from "../session-service.js";
import { SEARCH_PO_MODE } from "../search-po/search-po-api.js";
import { sanitiseFilename } from "../../utils/filename.js";
import { looksLikePdf } from "../search-po/document-downloader.js";
import { logger } from "../../utils/logger.js";
import {
  BILL_ERROR,
  loadBillForm,
  fetchPayAuthList,
  fetchPoSrList,
  checkGstin,
  saveBillHeader,
  fetchItemDetails,
  fetchRoList,
  fetchRoDetails,
  saveBillDetails
} from "./bill-upload-api.js";
import { hasBillForm, parseBillForm } from "./bill-form.js";
import { buildHeader, buildItem, precheckReceipt, quantityOf, deriveSupplierGstin } from "./bill-rules.js";
import { BILL_DOCUMENTS, MAX_DOCUMENT_BYTES, findBillDocuments, fetchBillDocument } from "./ecm-invoice.js";

export const BILL_UPLOAD_SUBFOLDER = "DocLink/IREPS/BillUpload";

/* -------------------------------------------------------------------------- */
/* 1. Receipts                                                                */
/* -------------------------------------------------------------------------- */

const pad3 = (v) => (/^\d{1,3}$/.test(String(v || "").trim()) ? String(v).trim().padStart(3, "0") : String(v || "").trim());

export function receiptKey(r) {
  return [r.source, (r.billClaim && r.billClaim.rly) || "", (r.billClaim && r.billClaim.poKey) || "", r.poNo || "", r.poSr || "", r.roNo || r.receiptNo || ""].join("|");
}

function finishReceipt(r) {
  const returned = /return/i.test(r.status || "");
  if (!r.billClaim) {
    r.billable = false;
    r.reason = r.status || (r.existingBillRegNo ? `IREPS already shows bill ${r.existingBillRegNo} for this receipt` : "IREPS shows no Bill Claim link for this receipt");
  } else if (r.existingBillRegNo && !returned) {
    r.billable = false;
    r.reason = `IREPS already shows bill ${r.existingBillRegNo} for this receipt`;
  } else {
    r.billable = true;
    r.reason = returned && r.existingBillRegNo ? `bill ${r.existingBillRegNo} was returned; a new bill can be claimed` : null;
  }
  r.key = receiptKey(r);
  return r;
}

/** An R-NOTE search record (services/rnote/rnote-parser.js) as a receipt. */
export function receiptFromRnote(record) {
  const raw = record.rawColumns || {};
  return finishReceipt({
    source: "RNOTE",
    poNo: record.poNo,
    poDate: record.poDate,
    poSr: pad3(record.poSerial),
    receiptNo: record.rnoteNo,
    receiptDate: record.rnoteDate,
    roNo: record.roNo || null,
    roDate: record.roDate || null,
    qty: quantityOf(record.quantity),
    qtyText: record.quantity,
    drrNo: record.drrNo || null,
    challanNo: record.challanNo || null,
    railway: raw["Dept / Rly. Unit"] || record.railway || null,
    billClaim: record.billClaim || null,
    status: record.billClaimStatus || null,
    existingBillRegNo: record.billRegNo || null
  });
}

/** A CRN search record (services/crn/crn-parser.js) as a receipt; IREPS lists the CRN as its RO. */
export function receiptFromCrn(record) {
  return finishReceipt({
    source: "CRN",
    poNo: record.poNo,
    poDate: record.poDate,
    poSr: pad3(record.poSerial),
    receiptNo: record.crnNo,
    receiptDate: record.crnDate,
    roNo: record.crnNo || null,
    roDate: record.crnDate || null,
    qty: quantityOf(record.crnQty),
    qtyText: record.crnQty,
    drrNo: null,
    challanNo: record.challanNo || null,
    railway: record.railway || null,
    billClaim: record.billClaim || null,
    status: record.billClaimStatus || null,
    existingBillRegNo: record.billRegNo || null
  });
}

const isNotFound = (error) => error instanceof IrepsError && /_NOT_FOUND$/.test(error.code);

/**
 * R-NOTE and CRN receipts of one PO (or of the last 180 days), billable ones first.
 * @param {{ poNo?: string }} options
 * @param {{ searchRnote: Function, searchCrn: Function }} deps
 */
export async function findBillableReceipts({ poNo } = {}, deps = {}) {
  const po = String(poNo || "").trim();
  const options = po ? { mode: SEARCH_PO_MODE.PO_NUMBER, poNo: po } : { mode: SEARCH_PO_MODE.LAST_180_DAYS };
  const [rnote, crn] = await Promise.allSettled([deps.searchRnote(options), deps.searchCrn(options)]);
  const warnings = [];
  const receipts = [];
  for (const [label, outcome, convert] of [["R-NOTE", rnote, receiptFromRnote], ["CRN", crn, receiptFromCrn]]) {
    if (outcome.status === "fulfilled") receipts.push(...outcome.value.records.map(convert));
    else if (!isNotFound(outcome.reason)) warnings.push({ label, error: outcome.reason });
  }
  if (receipts.length === 0 && warnings.length) throw warnings[0].error;
  if (receipts.length === 0) {
    throw new IrepsError(BILL_ERROR.NO_RECEIPTS, "no receipts", { detail: po ? `IREPS shows no R-Note or CRN for PO ${po}` : "IREPS shows no R-Note or CRN in the last 180 days" });
  }
  receipts.sort((a, b) => Number(b.billable) - Number(a.billable));
  return {
    receipts,
    warnings: warnings.map((w) => `${w.label} search failed: ${(w.error && (w.error.detail || w.error.message)) || "error"}`)
  };
}

/* -------------------------------------------------------------------------- */
/* 3. Prepare and review (read-only)                                          */
/* -------------------------------------------------------------------------- */

const err = (text) => ({ level: "error", text });
const warn = (text) => ({ level: "warning", text });

/** Header + all checks of a prepared context, recomputed from what it holds. */
export function assembleHeader(context, today = new Date()) {
  const header = buildHeader({
    receipt: context.receipt,
    invoice: context.invoice,
    form: context.form,
    payAuths: context.payAuths,
    stockNonstock: context.stockNonstock,
    gstinStatus: context.gstinStatus,
    overrides: context.overrides || {},
    today
  });
  const checks = [...context.readChecks, ...header.checks];
  if (context.existing) checks.unshift(err(`DocLink already created bill ${context.existing.billRegNo} for this receipt (${context.existing.status === "item-saved" ? "header and item saved" : "header saved"}).`));
  return { ...header, checks };
}

async function gstinCheck(gstin, form, deps) {
  if (!gstin || !form.supplierGstins.some((o) => o.value === gstin)) return null;
  const status = await checkGstin(gstin, deps);
  return { gstin, valid: status.valid, message: status.message };
}

/**
 * Read everything the bill needs from IREPS and build the header. Writes nothing.
 * @param {{ receipt: object, invoice: object, overrides?: object }} input
 * @param {{ fetch?: typeof fetch, store: ReturnType<import("./bill-upload-store.js").createBillStore>, today?: Date }} deps
 */
export async function prepareBill({ receipt, invoice, overrides = {} }, deps) {
  if (!receipt || !receipt.billClaim) {
    throw new IrepsError(BILL_ERROR.NOT_BILLABLE, "receipt not billable", { detail: (receipt && receipt.reason) || "IREPS shows no Bill Claim link for this receipt" });
  }
  const readChecks = [];
  if (!receipt.billable && receipt.reason) readChecks.push(err(receipt.reason));
  else if (receipt.reason) readChecks.push(warn(receipt.reason));
  const existing = await deps.store.get(receipt.key);

  const html = await loadBillForm(receipt.billClaim, deps);
  if (!hasBillForm(html)) {
    if (isIrepsLoginPage(html)) throw new IrepsError(BILL_ERROR.SESSION_EXPIRED, "login page instead of the bill page");
    throw new IrepsError(BILL_ERROR.FORM_INVALID, "bill page not recognised", { detail: `PO ${receipt.poNo}` });
  }
  const form = parseBillForm(html);
  const L = form.literals;
  if (L.poNumber && receipt.poNo && L.poNumber !== receipt.poNo) readChecks.push(err(`IREPS opened the bill page of PO ${L.poNumber}, not ${receipt.poNo}.`));
  const payingRly = (form.payingRailways.find((r) => r.selected) || form.payingRailways[0] || {}).value || L.rly;

  const payAuths = await fetchPayAuthList({ payingRly, poKey: L.poKey }, deps);

  // Stock / non-stock follows the receipt (R-NOTE -> S, CRN -> N in the captures); IREPS lists the
  // PO Sr only under the right one, so the other is tried before giving up.
  let stockNonstock = receipt.source === "CRN" ? "N" : "S";
  let poSrList = [];
  if (payAuths.length === 1) {
    const srList = (sn) => fetchPoSrList({ rly: L.rly, poNumber: L.poNumber, payingAuthorityCode: payAuths[0].code, billType: L.billType || "S", billRegNo: "null", stockNonstock: sn, payingRly }, deps).catch(() => []);
    poSrList = await srList(stockNonstock);
    if (!poSrList.includes(receipt.poSr)) {
      const other = stockNonstock === "S" ? "N" : "S";
      const otherList = await srList(other);
      if (otherList.includes(receipt.poSr)) {
        readChecks.push(warn(`IREPS lists PO Sr ${receipt.poSr} under ${other === "S" ? "Stock" : "Non-Stock"}, not under what the ${receipt.source === "CRN" ? "CRN" : "R-Note"} suggests; DocLink uses ${other === "S" ? "Stock" : "Non-Stock"}.`));
        stockNonstock = other;
        poSrList = otherList;
      } else {
        readChecks.push(err(`IREPS lists no PO Sr ${receipt.poSr} for this paying authority (Stock: ${poSrList.join(", ") || "none"}; Non-Stock: ${otherList.join(", ") || "none"}).`));
      }
    }
  }

  const derived = deriveSupplierGstin(invoice);
  const gstinStatus = await gstinCheck(String(overrides.supplierGSTIN || (derived && derived.value) || "").toUpperCase(), form, deps);

  // Receipt: IREPS' RO list and the receipt's details (quantity, item value) - read-only calls.
  const roList = await fetchRoList({ rly: L.rly, poNumber: L.poNumber, poSrNo: receipt.poSr, billType: L.billType || "S", billRegNo: "null", payingRly }, deps);
  let roNo = receipt.roNo && roList.includes(receipt.roNo) ? receipt.roNo : null;
  if (!roNo && roList.length === 1) {
    if (receipt.roNo) readChecks.push(warn(`IREPS lists receipt ${roList[0]} for this PO Sr, not ${receipt.roNo}; DocLink uses ${roList[0]}.`));
    roNo = roList[0];
  }
  let ro = null;
  if (!roNo) readChecks.push(err(roList.length ? `IREPS lists ${roList.length} receipts for PO Sr ${receipt.poSr} (${roList.join(", ")}) and none matches ${receipt.roNo || receipt.receiptNo}.` : `IREPS lists no receipt for PO Sr ${receipt.poSr}.`));
  else {
    ro = await fetchRoDetails({ rly: L.rly, poNumber: L.poNumber, poSrNo: receipt.poSr, roNo, billType: L.billType || "S", paymentPercent: "100", payingRly }, deps);
    readChecks.push(...precheckReceipt({ receipt, invoice, ro }));
  }

  const context = { receipt, invoice, overrides: { ...overrides }, form, payAuths, payingRly, stockNonstock, poSrList, gstinStatus, roList, roNo, ro, readChecks, existing, preparedAt: new Date().toISOString() };
  context.header = assembleHeader(context, deps.today);
  logger.info("Bill upload: prepared", { po: receipt.poNo, poSr: receipt.poSr, ro: roNo, invoice: invoice.invoiceNumber, errors: context.header.checks.filter((c) => c.level === "error").length, warnings: context.header.checks.filter((c) => c.level === "warning").length });
  return context;
}

/**
 * Apply the user's corrections and re-check. A changed supplier GSTIN is validated with
 * IREPS again; nothing is written.
 */
export async function reviewBill(context, overrides = {}, deps = {}) {
  const next = { ...context, overrides: { ...context.overrides } };
  for (const key of ["supplierGSTIN", "stateOfSupply", "placeOfSupply", "billDescription"]) {
    if (overrides[key] === undefined) continue;
    const value = String(overrides[key]).trim();
    if (value === "") delete next.overrides[key];
    else next.overrides[key] = key === "supplierGSTIN" ? value.toUpperCase() : value;
  }
  const derived = deriveSupplierGstin(next.invoice);
  const gstin = String(next.overrides.supplierGSTIN || (derived && derived.value) || "").toUpperCase();
  if (gstin !== ((next.gstinStatus && next.gstinStatus.gstin) || "")) next.gstinStatus = await gstinCheck(gstin, next.form, deps);
  next.existing = await deps.store.get(next.receipt.key);
  next.header = assembleHeader(next, deps.today);
  return next;
}

/* -------------------------------------------------------------------------- */
/* 4. Write                                                                   */
/* -------------------------------------------------------------------------- */

function checksFailed(checks, acknowledged, what) {
  const errors = checks.filter((c) => c.level === "error");
  if (errors.length) return new IrepsError(BILL_ERROR.CHECKS_FAILED, `${what}: ${errors.length} check(s) failed`, { detail: errors.map((c) => c.text).join(" ") });
  const warnings = checks.filter((c) => c.level === "warning");
  if (warnings.length && !acknowledged) return new IrepsError(BILL_ERROR.CHECKS_FAILED, `${what}: warnings not confirmed`, { detail: `confirm the ${warnings.length} warning(s) first` });
  return null;
}

/** The header values worth keeping for the item step (no bank details). */
function savedHeader(values) {
  const { bankAccountNo, ifscCode, ...rest } = values;
  void bankAccountNo;
  void ifscCode;
  return rest;
}

/**
 * WRITES: saves the bill header (creates the draft bill), records it, then saves the item.
 * @param {object} context    from prepareBill / reviewBill
 * @param {{ acknowledged?: boolean }} options   true when the user confirmed the warnings
 * @returns {Promise<{ outcome: "item-saved"|"item-review"|"item-blocked", context: object }>}
 *          a failure after the header was saved carries error.billRegNo
 */
export async function createDraftBill(context, { acknowledged = false } = {}, deps) {
  const existing = await deps.store.get(context.receipt.key);
  if (existing) {
    throw new IrepsError(BILL_ERROR.DRAFT_EXISTS, "draft exists", { detail: `DocLink already created bill ${existing.billRegNo} for this receipt` });
  }
  const header = assembleHeader({ ...context, existing: null }, deps.today);
  const blocked = checksFailed(header.checks, acknowledged, "bill header");
  if (blocked) throw blocked;

  logger.info("Bill upload: saving the bill header (creates the draft bill)", { po: header.values.poNumber, invoice: header.values.invoiceNo });
  const { billRegNo } = await saveBillHeader(header.values, deps);
  await deps.store.put(context.receipt.key, { status: "header-saved", billRegNo, invoiceNo: header.values.invoiceNo, poNumber: header.values.poNumber, poSr: context.receipt.poSr, roNo: context.roNo });
  logger.info(`Bill upload: draft bill ${billRegNo} created`);
  const next = { ...context, header, billRegNo, headerSaved: savedHeader(header.values), existing: await deps.store.get(context.receipt.key) };
  try {
    return await saveItem(next, { acknowledged: false }, deps);
  } catch (error) {
    // the draft exists now: the caller must keep showing it, whatever failed after
    if (error && typeof error === "object") Object.assign(error, { billRegNo, context: next });
    throw error;
  }
}

/**
 * Item of a saved header: fetch, compute, check, and - when nothing stops it - WRITE
 * saveBillDetails.do. Re-runnable (e.g. after the user confirmed the warnings).
 */
export async function saveItem(context, { acknowledged = false } = {}, deps) {
  const billRegNo = context.billRegNo;
  if (!billRegNo || !context.headerSaved) throw new IrepsError(BILL_ERROR.NOT_PREPARED, "no saved header", { detail: "the bill header has not been saved yet" });
  const stored = await deps.store.get(context.receipt.key);
  if (stored && stored.status === "item-saved") {
    throw new IrepsError(BILL_ERROR.DRAFT_EXISTS, "item already saved", { detail: `the item of bill ${stored.billRegNo} is already saved` });
  }
  const H = context.headerSaved;
  const payingRly = H.payingRly;
  const item = await fetchItemDetails(
    { poSrNo: context.receipt.poSr, rly: H.rly, poKey: H.poKey, poNumber: H.poNumber, billNo: H.invoiceNo, paymentType: H.paymentType, billRegNo, gstFlag: "Y", payingRly, billType: H.billType, spmBillRegNo: "null" },
    deps
  );
  const roList = await fetchRoList({ rly: H.rly, poNumber: H.poNumber, poSrNo: context.receipt.poSr, billType: H.billType, billRegNo: "null", payingRly }, deps);
  const extra = [];
  const roNo = context.roNo && roList.includes(context.roNo) ? context.roNo : null;
  if (!roNo) extra.push(err(`Receipt ${context.roNo} is no longer in IREPS' list (${roList.join(", ") || "empty"}).`));
  const ro = roNo ? await fetchRoDetails({ rly: H.rly, poNumber: H.poNumber, poSrNo: context.receipt.poSr, roNo, billType: H.billType, paymentPercent: H.paymentPercent, payingRly }, deps) : context.ro;
  const plan = buildItem({ header: H, billRegNo, receipt: context.receipt, invoice: context.invoice, item, roNo: roNo || context.roNo, ro, railwayGstins: context.form.railwayGstins });
  const checks = [...extra, ...plan.checks];
  const next = { ...context, item: { review: plan.review, checks, amounts: plan.amounts, inspectionAgency: item.inspectionAgency, consigneeName: item.consigneeName } };

  if (checks.some((c) => c.level === "error")) return { outcome: "item-blocked", context: next };
  if (checks.some((c) => c.level === "warning") && !acknowledged) return { outcome: "item-review", context: next };

  logger.info(`Bill upload: saving the item of bill ${billRegNo}`, { total: plan.values.totalAmount });
  const saved = await saveBillDetails(plan.values, deps);
  await deps.store.put(context.receipt.key, { status: "item-saved", dispatchNo: saved.dispatchNo });
  logger.info(`Bill upload: item saved (dispatch ${saved.dispatchNo})`);
  return { outcome: "item-saved", context: { ...next, dispatchNo: saved.dispatchNo, documentsOnBill: saved.documents, existing: await deps.store.get(context.receipt.key) } };
}

/* -------------------------------------------------------------------------- */
/* 5. Documents                                                               */
/* -------------------------------------------------------------------------- */

/** Is a bill document expected for this inspection agency? "required" | "conditional" | "optional" */
export function documentNeed(document, inspectionAgency) {
  if (document.when === "always") return "required";
  if (document.when === "TPI") return inspectionAgency === "TPI" ? "required" : inspectionAgency ? "not-needed" : "conditional";
  if (document.when === "CONSG") return inspectionAgency === "CONSG" ? "required" : inspectionAgency ? "optional" : "conditional";
  return "optional";
}

/**
 * Fetch the invoice's documents from ECM and save them locally for the user to attach in IREPS.
 * @param {{ invoice: object, receipt: object, inspectionAgency?: string|null }} input
 * @param {{ saveFile: (bytes: Uint8Array, path: string) => Promise<{ downloadId: number|null, filename: string }>, findBillDocuments?: Function, fetchBillDocument?: Function }} deps
 */
export async function collectBillDocuments({ invoice, receipt, inspectionAgency = null }, deps) {
  const invoiceNumber = String(invoice.invoiceNumber || "").trim();
  const find = deps.findBillDocuments || findBillDocuments;
  const fetchDoc = deps.fetchBillDocument || fetchBillDocument;
  const found = await find({ invoiceNumber, poNumber: receipt.poNo }, deps);
  const folder = `${BILL_UPLOAD_SUBFOLDER}/${sanitiseFilename(invoiceNumber || receipt.poNo)}`;
  const results = [];
  for (const entry of found) {
    const { document } = entry;
    const need = documentNeed(document, inspectionAgency);
    const row = { kind: document.kind, code: document.code, label: document.label, fileDesc: document.fileDesc, need, status: "missing", filename: null, downloadId: null, bytes: 0, note: null };
    if (!entry.uid) {
      row.note = need === "required" ? "not found in ECM" : null;
      results.push(row);
      continue;
    }
    if (entry.others) row.note = `${entry.others} older ${document.label} document(s) in ECM were not used`;
    try {
      const blob = await fetchDoc(entry.uid, deps);
      row.bytes = blob.bytes.length;
      if (!looksLikePdf(blob.bytes)) {
        row.status = "invalid";
        row.note = "the ECM file is not a PDF";
      } else if (blob.bytes.length >= MAX_DOCUMENT_BYTES) {
        row.status = "too-large";
        row.note = `${(blob.bytes.length / 1048576).toFixed(1)} MB; IREPS accepts files below 8 MB`;
      } else {
        const name = `${sanitiseFilename(invoiceNumber || receipt.poNo)}_${document.code}.pdf`;
        const saved = await deps.saveFile(blob.bytes, `${folder}/${name}`);
        row.status = "saved";
        row.filename = saved.filename || name;
        row.downloadId = saved.downloadId ?? null;
      }
    } catch (error) {
      row.status = "failed";
      row.note = (error && (error.detail || error.message)) || "download failed";
    }
    results.push(row);
  }
  const missingRequired = results.filter((r) => r.need === "required" && r.status !== "saved");
  return { folder, documents: results, missingRequired: missingRequired.map((r) => r.label) };
}

/** The document types, for the panel (labels, descriptions to type). */
export function billDocumentTypes() {
  return BILL_DOCUMENTS.map((d) => ({ kind: d.kind, code: d.code, label: d.label, fileDesc: d.fileDesc, when: d.when }));
}

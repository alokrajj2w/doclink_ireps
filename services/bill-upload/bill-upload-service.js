/**
 * Bill upload: an ECM invoice billed against an IREPS receipt (R-Note / CRN), up to the
 * point where IREPS needs the user's digital signature (upload.md section 4). Started by
 * hand from the side panel; every step is a separate call so the user sees and confirms
 * the values before anything is written:
 *
 *   1. findBillableReceipts()  R-NOTE and CRN search (read-only) -> receipts with a Bill Claim link
 *   2. invoiceForReceipt()     ECM RetrieveInvoiceData (ecm-invoice.js), a picked JSON file
 *                              (invoice-file.js) or manualInvoice(), checked the same way
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
 * again (bill-upload-store.js), an invoice DocLink billed on one receipt is not billed on
 * another, and nothing is written while an error check stands or a warning is unconfirmed.
 *
 * Every write (header, item, document) is recorded before it is sent and cleared by IREPS's
 * answer (guardedWrite). When the answer does not arrive, IREPS may have saved it: the step stays
 * stopped for that receipt, with what to check in IREPS, until the user confirms they checked
 * (confirmCheckedInIreps). DocLink never retries a write by itself (review 3.1).
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
  saveBillDetails,
  missingAnswerReason
} from "./bill-upload-api.js";
import { hasBillForm, parseBillForm } from "./bill-form.js";
import { buildHeader, buildItem, precheckReceipt, quantityOf, deriveSupplierGstin, hsnCheck } from "./bill-rules.js";
import { BILL_DOCUMENTS, MAX_DOCUMENT_BYTES, findBillDocuments, fetchBillDocument, retrieveInvoice, manualInvoice } from "./ecm-invoice.js";
import { invoiceFromFile, receiptInvoiceKey } from "./invoice-file.js";
import { uploadBillDocument, irepsFileName } from "./bill-document-upload.js";

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
/* 2. Invoice                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Stops an invoice that lacks what every bill needs (number, date, amount, HSN code), or whose
 * HSN code IREPS does not take, before IREPS is read or written. The HSN only goes into the
 * item, which is saved after the draft bill exists, so a bad one found there would leave the
 * draft behind (review M25).
 * @param {object} invoice
 * @param {string} [where]  "in ECM" / "in <file name>"; empty for an invoice the user typed
 */
export function requireInvoiceFields(invoice, where = "") {
  const missing = [];
  if (!invoice.invoiceNumber) missing.push("invoice number");
  if (!invoice.invoiceDate) missing.push("invoice date");
  if (!invoice.amount) missing.push("invoice amount");
  if (!invoice.hsn) missing.push("HSN code");
  if (missing.length) {
    throw new IrepsError(BILL_ERROR.INVOICE_INVALID, "invoice incomplete", { detail: where ? `Invoice ${invoice.invoiceNumber} ${where} has no ${missing.join(", ")}.` : `Enter the ${missing.join(", ")}.` });
  }
  const hsn = hsnCheck(invoice);
  if (hsn) throw new IrepsError(BILL_ERROR.INVOICE_INVALID, "invoice HSN code not accepted", { detail: where ? `Invoice ${invoice.invoiceNumber} ${where}: ${hsn.text}` : hsn.text });
}

/**
 * The receipt's invoice from ECM, from the JSON file the user picked, or as typed; every source
 * goes through requireInvoiceFields.
 * @param {{ receipt: object, mode?: "ecm"|"file"|"manual", fields?: object, file?: { name: string, records: object[] }|null }} input
 * @param {{ retrieveInvoice?: (key: object) => Promise<object> }} [deps]  the ECM lookup (tests inject one)
 * @returns {Promise<object>} the invoice, normalised like an ECM one (ecm-invoice.js)
 */
export async function invoiceForReceipt({ receipt, mode = "ecm", fields = {}, file = null }, deps = {}) {
  if (mode === "manual") {
    const invoice = manualInvoice(fields || {});
    requireInvoiceFields(invoice);
    return invoice;
  }
  if (mode === "file") {
    const invoice = invoiceFromFile(file, receiptInvoiceKey(receipt));
    requireInvoiceFields(invoice, `in ${file.name}`);
    return invoice;
  }
  const invoice = await (deps.retrieveInvoice || retrieveInvoice)(receiptInvoiceKey(receipt));
  requireInvoiceFields(invoice, "in ECM");
  return invoice;
}

/* -------------------------------------------------------------------------- */
/* 3. Prepare and review (read-only)                                          */
/* -------------------------------------------------------------------------- */

const err = (text) => ({ level: "error", text });
const warn = (text) => ({ level: "warning", text });

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** "24/11/2026 16:32" in IST from an ISO time ("" when it is not one). */
function istTime(iso) {
  const d = new Date(Date.parse(iso) + IST_OFFSET_MS);
  if (!Number.isFinite(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** The reason recorded with a write until IREPS's answer, or the reason it is missing, replaces it. */
const STOPPED_BEFORE_ANSWER = "DocLink's background work stopped before IREPS answered";

/**
 * What the user reads and confirms about a write whose answer did not arrive (review 3.1): which
 * step, which bill / invoice, why the answer is missing and what to check in IREPS. Built from
 * the receipt's store entry; null when it records no such write.
 * @param {import("./bill-upload-store.js").BillUploadEntry|null} entry
 * @returns {{ step: string, at: string, text: string, confirm: string, button: string }|null}
 */
export function unknownOutcome(entry) {
  const u = entry && entry.unknown;
  if (!u) return null;
  const when = istTime(u.at);
  const sent = `${when ? `On ${when} ` : ""}DocLink sent`;
  const lost = `but IREPS's answer did not arrive: ${u.why || STOPPED_BEFORE_ANSWER}.`;
  const invoice = entry.invoiceNo || "?";
  const bill = entry.billRegNo || "?";
  const shown = { step: u.step, at: u.at };
  if (u.step === "header") {
    return {
      ...shown,
      text: `${sent} the bill header for invoice ${invoice} (PO ${entry.poNumber || "?"}, PO Sr ${entry.poSr || "?"}) to IREPS, ${lost} IREPS may have created the draft bill. Open the PO's Bills for Pay tab in IREPS and look for a draft bill with invoice ${invoice}. If there is one, finish that bill in IREPS, or delete it there before you go on. If there is none, confirm it in DocLink to create the bill.`,
      confirm: `I checked the PO's Bills for Pay in IREPS: there is no draft bill for invoice ${invoice}.`,
      button: "Allow creating the bill again"
    };
  }
  if (u.step === "item") {
    return {
      ...shown,
      text: `${sent} the item of draft bill ${bill} (invoice ${invoice}) to IREPS, ${lost} IREPS may have saved the item. Open bill ${bill} in IREPS (the PO's Bills for Pay tab) and check its item. If it is saved, finish the bill in IREPS and attach the documents there. If it is not, confirm it in DocLink to save the item.`,
      confirm: `I checked draft bill ${bill} in IREPS: its item is not saved.`,
      button: "Allow saving the item again"
    };
  }
  return {
    ...shown,
    text: `${sent} ${u.fileName || "a document"}${u.fileDesc ? ` ("${u.fileDesc}")` : ""} to draft bill ${bill} (invoice ${invoice}), ${lost} IREPS may have added it to the bill. Open bill ${bill} in IREPS (the PO's Bills for Pay tab) and check its documents before you upload one again.`,
    confirm: `I checked the documents of draft bill ${bill} in IREPS.`,
    button: "Allow uploading documents again"
  };
}

/** BILL_OUTCOME_UNKNOWN for the entry's write, carrying the context to show. */
function unknownOutcomeError(entry, context, cause) {
  const error = new IrepsError(BILL_ERROR.OUTCOME_UNKNOWN, `${entry.unknown.step}: IREPS's answer is missing`, { detail: unknownOutcome(entry).text, cause });
  error.context = context;
  return error;
}

/**
 * The store entries of OTHER receipts that DocLink billed with this invoice number (review 3.4):
 * a draft bill created, or one whose creation IREPS has not confirmed.
 */
async function invoiceBilledElsewhere(store, invoiceNo, receiptKeyOfBill) {
  const no = String(invoiceNo || "").trim().toUpperCase();
  if (!no) return [];
  return (await store.list()).filter((e) => e.receiptKey !== receiptKeyOfBill && String(e.invoiceNo || "").trim().toUpperCase() === no);
}

function invoiceUsedText(entry) {
  const which = entry.billRegNo ? `draft bill ${entry.billRegNo}` : "a bill whose creation IREPS has not confirmed";
  return `Invoice ${entry.invoiceNo} is already on another receipt's bill that DocLink created: ${which} (PO ${entry.poNumber || "?"}, PO Sr ${entry.poSr || "?"}, receipt ${entry.roNo || "?"}). One invoice is billed once: check the invoice.`;
}

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
  for (const used of context.invoiceUsed || []) checks.unshift(err(invoiceUsedText(used)));
  const stored = context.existing;
  if (stored && stored.billRegNo) checks.unshift(err(`DocLink already created bill ${stored.billRegNo} for this receipt (${stored.status === "item-saved" ? "header and item saved" : "header saved"}).`));
  if (stored && stored.unknown) checks.unshift(err(unknownOutcome(stored).text));
  return { ...header, checks };
}

/**
 * The context with the receipt's store entry read again (after a write, a worker restart or the
 * user's confirmation); while the bill is not created, its header checks are recomputed too.
 */
export async function withStoredBill(context, deps) {
  const next = { ...context, existing: await deps.store.get(context.receipt.key) };
  if (!next.billRegNo && next.header && next.form) {
    next.invoiceUsed = await invoiceBilledElsewhere(deps.store, next.invoice && next.invoice.invoiceNumber, next.receipt.key);
    next.header = assembleHeader(next, deps.today);
  }
  return next;
}

/** The stop when IREPS's receipt list for the PO Sr does not hold the chosen receipt (review 3.5). */
function receiptNotListed(receipt, roList) {
  const listed = roList.length ? `it lists ${roList.join(", ")}` : "it lists none";
  if (!receipt.roNo) {
    return `The ${receipt.source === "CRN" ? "CRN" : "R-Note"} row shows no RO number, so DocLink cannot tell which receipt IREPS lists for PO Sr ${receipt.poSr} is this one (${listed}). Bill this receipt in IREPS yourself.`;
  }
  return `IREPS does not list receipt ${receipt.roNo} for PO Sr ${receipt.poSr} (${listed}). DocLink bills only the receipt you chose: check it in IREPS (it may be billed already).`;
}

async function gstinCheck(gstin, form, deps) {
  if (!gstin || !form.supplierGstins.some((o) => o.value === gstin)) return null;
  const status = await checkGstin(gstin, deps);
  return { gstin, valid: status.valid, message: status.message };
}

const stockName = (sn) => (sn === "S" ? "Stock" : "Non-Stock");

/**
 * IREPS's PO Sr list for one Stock / Non-Stock choice (review 3.12): `list` when IREPS gave one (empty
 * included), else `refused` with IREPS's own words. A request IREPS did not answer (deadline, network,
 * a server error) or its login page is not a list: it stops the step and is reported as itself.
 * @returns {Promise<{ list: string[], refused: null }|{ list: null, refused: string }>}
 */
async function poSrListFor(values, deps) {
  try {
    return { list: await fetchPoSrList(values, deps), refused: null };
  } catch (error) {
    if (error instanceof IrepsError && error.code === BILL_ERROR.IREPS_REJECTED) return { list: null, refused: error.answer || error.detail || "an answer DocLink does not know" };
    throw error;
  }
}

/** IREPS refused a receipt the way the bill page knows ("duplicate", "multi"; review 3.13). */
const isReceiptRefused = (error) => error instanceof IrepsError && error.code === BILL_ERROR.RECEIPT_REFUSED;

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
  const invoiceUsed = await invoiceBilledElsewhere(deps.store, invoice.invoiceNumber, receipt.key);

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
  // PO Sr only under the right one, so the other is tried before giving up. Only lists IREPS gave
  // count: a refusal is shown in IREPS's words and never switches Stock / Non-Stock (review 3.12).
  let stockNonstock = receipt.source === "CRN" ? "N" : "S";
  let poSrList = [];
  if (payAuths.length === 1) {
    const srList = (sn) => poSrListFor({ rly: L.rly, poNumber: L.poNumber, payingAuthorityCode: payAuths[0].code, billType: L.billType || "S", billRegNo: "null", stockNonstock: sn, payingRly }, deps);
    const own = await srList(stockNonstock);
    if (own.refused !== null) {
      readChecks.push(err(`IREPS did not give the ${stockName(stockNonstock)} PO Sr list for this paying authority; it answered "${own.refused}". DocLink takes Stock / Non-Stock only from a list IREPS gave, so it stops here: check PO Sr ${receipt.poSr} in IREPS.`));
    } else {
      poSrList = own.list;
      if (!poSrList.includes(receipt.poSr)) {
        const other = stockNonstock === "S" ? "N" : "S";
        const theirs = await srList(other);
        if (theirs.refused !== null) {
          readChecks.push(err(`IREPS lists no PO Sr ${receipt.poSr} under ${stockName(stockNonstock)} (${poSrList.join(", ") || "none"}), and did not give the ${stockName(other)} list; it answered "${theirs.refused}". Check PO Sr ${receipt.poSr} in IREPS.`));
        } else if (theirs.list.includes(receipt.poSr)) {
          readChecks.push(warn(`IREPS lists PO Sr ${receipt.poSr} under ${stockName(other)}, not under what the ${receipt.source === "CRN" ? "CRN" : "R-Note"} suggests; DocLink uses ${stockName(other)}.`));
          stockNonstock = other;
          poSrList = theirs.list;
        } else {
          readChecks.push(err(`IREPS lists no PO Sr ${receipt.poSr} for this paying authority (${stockName(stockNonstock)}: ${poSrList.join(", ") || "none"}; ${stockName(other)}: ${theirs.list.join(", ") || "none"}).`));
        }
      }
    }
  }

  const derived = deriveSupplierGstin(invoice);
  const gstinStatus = await gstinCheck(String(overrides.supplierGSTIN || (derived && derived.value) || "").toUpperCase(), form, deps);

  // Receipt: IREPS' RO list and the receipt's details (quantity, item value) - read-only calls.
  // Only the receipt the user chose is billed, never another one IREPS lists (review 3.5).
  const roList = await fetchRoList({ rly: L.rly, poNumber: L.poNumber, poSrNo: receipt.poSr, billType: L.billType || "S", billRegNo: "null", payingRly }, deps);
  const roNo = receipt.roNo && roList.includes(receipt.roNo) ? receipt.roNo : null;
  let ro = null;
  if (!roNo) readChecks.push(err(receiptNotListed(receipt, roList)));
  else {
    try {
      ro = await fetchRoDetails({ rly: L.rly, poNumber: L.poNumber, poSrNo: receipt.poSr, roNo, billType: L.billType || "S", paymentPercent: "100", payingRly }, deps);
      readChecks.push(...precheckReceipt({ receipt, invoice, ro }));
    } catch (error) {
      // "duplicate" / "multi": what IREPS means, in the review (review 3.13)
      if (!isReceiptRefused(error)) throw error;
      readChecks.push(err(`${error.detail}.`));
    }
  }

  const context = { receipt, invoice, overrides: { ...overrides }, form, payAuths, payingRly, stockNonstock, poSrList, gstinStatus, roList, roNo, ro, readChecks, existing, invoiceUsed, preparedAt: new Date().toISOString() };
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
  next.invoiceUsed = await invoiceBilledElsewhere(deps.store, next.invoice.invoiceNumber, next.receipt.key);
  next.header = assembleHeader(next, deps.today);
  return next;
}

/**
 * "Start fresh" for a receipt DocLink already created a bill for: forgets DocLink's record of
 * that bill so a new draft can be created, and re-checks the header. Writes nothing to IREPS -
 * the earlier draft bill stays there until the user deletes it (PO's Bills for Pay). DocLink
 * no longer tracks it after this, so its number is kept in `forgottenBills` for the panel to
 * say where it is (review M26).
 * A header whose creation IREPS has not confirmed is not forgotten this way: only the user's
 * confirmation that they checked Bills for Pay clears it (confirmCheckedInIreps, review 3.1).
 * @returns {Promise<{ forgotten: object|null, context: object }>}
 */
export async function forgetBill(context, deps = {}) {
  const stored = await deps.store.get(context.receipt.key);
  if (stored && stored.unknown && !stored.billRegNo) throw unknownOutcomeError(stored, await withStoredBill(context, deps));
  const forgotten = await deps.store.remove(context.receipt.key);
  if (forgotten) logger.info(`Bill upload: forgot bill ${forgotten.billRegNo} for this receipt (start fresh)`, { po: context.receipt.poNo, poSr: context.receipt.poSr });
  const left = forgotten || context.existing;
  const forgottenBills = [...(context.forgottenBills || [])];
  if (left && left.billRegNo && !forgottenBills.some((b) => b.billRegNo === left.billRegNo)) forgottenBills.push({ billRegNo: left.billRegNo, status: left.status || null });
  const next = { ...context, existing: null, billRegNo: null, headerSaved: null, item: null, dispatchNo: null, documentsOnBill: null, forgottenBills };
  next.header = assembleHeader(next, deps.today);
  return { forgotten, context: next };
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
 * One IREPS bill write whose outcome is never lost (review 3.1). Right before the request leaves,
 * the receipt's store entry records it as `unknown`, so a service worker stopped mid-request
 * leaves it recorded. IREPS's answer clears it: a success with `saved(result)` merged in, a
 * refusal (its own text, its login page, an HTTP 4xx) as if nothing was sent. A missing answer
 * keeps it, with the reason, and throws BILL_OUTCOME_UNKNOWN. Nothing is sent when the record
 * cannot be written; nothing is ever sent twice.
 * @template T
 * @param {{ key: string, patch?: object, unknown: object, created?: boolean, saved?: (result: T) => object }} write
 *        patch: entry values recorded with the write; created: the entry exists only for this write
 *        (the header), so a refusal removes it again
 * @param {{ store: object, fetch?: typeof fetch }} deps
 * @param {(deps: object) => Promise<T>} send  the request, made with the deps it is given
 * @returns {Promise<T>}
 */
async function guardedWrite({ key, patch = {}, unknown, created = false, saved = () => ({}) }, deps, send) {
  const fetchImpl = deps.fetch || ((url, init) => globalThis.fetch(url, init));
  let sentAt = null;
  let notRecorded = null;
  const fetch = async (url, init) => {
    if (!sentAt) {
      const at = new Date().toISOString();
      try {
        await deps.store.put(key, { ...patch, unknown: { ...unknown, why: STOPPED_BEFORE_ANSWER, at } });
      } catch (error) {
        notRecorded = error;
        throw error;
      }
      sentAt = at;
    }
    return fetchImpl(url, init);
  };
  let result;
  try {
    result = await send({ ...deps, fetch });
  } catch (error) {
    // not sent; a record that could not be written is reported as itself, not as an IREPS failure
    if (!sentAt) throw notRecorded || error;
    const why = missingAnswerReason(error);
    if (why === null) {
      // IREPS answered and did not carry the write out
      try {
        if (created) await deps.store.remove(key);
        else await deps.store.put(key, { unknown: null });
      } catch (storeError) {
        logger.warn("Bill upload: could not clear the record of a write IREPS refused; the step stays stopped", storeError);
      }
      throw error;
    }
    let entry;
    try {
      entry = await deps.store.put(key, { unknown: { ...unknown, why, at: sentAt } });
    } catch (storeError) {
      // the record written before the request still stops the step
      logger.warn("Bill upload: could not record why IREPS's answer is missing", storeError);
      entry = { ...patch, receiptKey: key, unknown: { ...unknown, why, at: sentAt } };
    }
    logger.warn(`Bill upload: IREPS's answer to the ${unknown.step} write is missing; the step stays stopped until the user checked IREPS`, { why, bill: entry.billRegNo || null, invoice: entry.invoiceNo || null });
    throw unknownOutcomeError(entry, null, error);
  }
  if (sentAt) await deps.store.put(key, { ...saved(result), unknown: null });
  return result;
}

/**
 * WRITES: saves the bill header (creates the draft bill), records it, then saves the item.
 * @param {object} context    from prepareBill / reviewBill
 * @param {{ acknowledged?: boolean }} options   true when the user confirmed the warnings
 * @returns {Promise<{ outcome: "item-saved"|"item-review"|"item-blocked", context: object }>}
 *          a failure after the header was saved carries error.billRegNo; a failure that changed
 *          what is shown (a missing answer) carries error.context
 */
export async function createDraftBill(context, { acknowledged = false } = {}, deps) {
  const key = context.receipt.key;
  const existing = await deps.store.get(key);
  if (existing && existing.unknown && !existing.billRegNo) throw unknownOutcomeError(existing, await withStoredBill(context, deps));
  if (existing) {
    throw new IrepsError(BILL_ERROR.DRAFT_EXISTS, "draft exists", { detail: `DocLink already created bill ${existing.billRegNo} for this receipt` });
  }
  const invoiceUsed = await invoiceBilledElsewhere(deps.store, context.invoice.invoiceNumber, key);
  const header = assembleHeader({ ...context, existing: null, invoiceUsed }, deps.today);
  const blocked = checksFailed(header.checks, acknowledged, "bill header");
  if (blocked) throw blocked;

  logger.info("Bill upload: saving the bill header (creates the draft bill)", { po: header.values.poNumber, invoice: header.values.invoiceNo });
  const record = { invoiceNo: header.values.invoiceNo, poNumber: header.values.poNumber, poSr: context.receipt.poSr, roNo: context.roNo };
  let billRegNo;
  try {
    ({ billRegNo } = await guardedWrite(
      { key, patch: { ...record, billRegNo: null }, unknown: { step: "header" }, created: true, saved: (answer) => ({ status: "header-saved", billRegNo: answer.billRegNo }) },
      deps,
      (d) => saveBillHeader(header.values, d)
    ));
  } catch (error) {
    // the review shows the stop and what to check in IREPS
    if (error && error.code === BILL_ERROR.OUTCOME_UNKNOWN) error.context = await withStoredBill(context, deps);
    throw error;
  }
  logger.info(`Bill upload: draft bill ${billRegNo} created`);
  const next = { ...context, header, billRegNo, headerSaved: savedHeader(header.values), existing: await deps.store.get(key) };
  try {
    return await saveItem(next, { acknowledged: false }, deps);
  } catch (error) {
    // the draft exists now: the caller must keep showing it, whatever failed after
    if (error && typeof error === "object") Object.assign(error, { billRegNo, context: error.context || next });
    throw error;
  }
}

/**
 * Item of a saved header: fetch, compute, check, and - when nothing stops it - WRITE
 * saveBillDetails.do. Re-runnable (e.g. after the user confirmed the warnings), but not while
 * the answer to an earlier item write is missing.
 */
export async function saveItem(context, { acknowledged = false } = {}, deps) {
  const billRegNo = context.billRegNo;
  if (!billRegNo || !context.headerSaved) throw new IrepsError(BILL_ERROR.NOT_PREPARED, "no saved header", { detail: "the bill header has not been saved yet" });
  const key = context.receipt.key;
  const stored = await deps.store.get(key);
  if (stored && stored.unknown) throw Object.assign(unknownOutcomeError(stored, { ...context, existing: stored }), { billRegNo });
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
  let ro = context.ro;
  if (roNo) {
    try {
      ro = await fetchRoDetails({ rly: H.rly, poNumber: H.poNumber, poSrNo: context.receipt.poSr, roNo, billType: H.billType, paymentPercent: H.paymentPercent, payingRly }, deps);
    } catch (error) {
      // "duplicate" / "multi" stop the item with what IREPS means; the item shows the receipt as prepared (review 3.13)
      if (!isReceiptRefused(error)) throw error;
      extra.push(err(`${error.detail}.`));
    }
  }
  const plan = buildItem({ header: H, billRegNo, receipt: context.receipt, invoice: context.invoice, item, roNo: roNo || context.roNo, ro, railwayGstins: context.form.railwayGstins });
  const checks = [...extra, ...plan.checks];
  const next = { ...context, item: { review: plan.review, checks, amounts: plan.amounts, inspectionAgency: item.inspectionAgency, consigneeName: item.consigneeName } };

  if (checks.some((c) => c.level === "error")) return { outcome: "item-blocked", context: next };
  if (checks.some((c) => c.level === "warning") && !acknowledged) return { outcome: "item-review", context: next };

  logger.info(`Bill upload: saving the item of bill ${billRegNo}`, { total: plan.values.totalAmount });
  let saved;
  try {
    saved = await guardedWrite(
      { key, patch: { billRegNo }, unknown: { step: "item" }, saved: (answer) => ({ status: "item-saved", dispatchNo: answer.dispatchNo }) },
      deps,
      (d) => saveBillDetails(plan.values, d)
    );
  } catch (error) {
    // the bill stays on screen with the stop and what to check in IREPS
    if (error && error.code === BILL_ERROR.OUTCOME_UNKNOWN) Object.assign(error, { billRegNo, context: { ...next, existing: await deps.store.get(key) } });
    throw error;
  }
  logger.info(`Bill upload: item saved (dispatch ${saved.dispatchNo})`);
  return { outcome: "item-saved", context: { ...next, dispatchNo: saved.dispatchNo, documentsOnBill: saved.documents, existing: await deps.store.get(key) } };
}

/**
 * WRITES: one PDF onto the draft bill, signed by the user in the IREPS signer, stored and
 * registered (bill-document-upload.js). The registration is guarded like the bill's other
 * writes, and refused while the answer to an earlier write of this bill is missing (review 3.1).
 * @param {object} context  the bill's context (receipt, billRegNo)
 * @param {{ bill: object, file: { name: string, base64: string }, fileDesc: string }} input  as uploadBillDocument takes it
 * @param {{ store: object, fetch: typeof fetch, signPdf: Function, saveFile: Function, today?: Date }} deps
 */
export async function addDocumentToBill(context, { bill, file, fileDesc }, deps) {
  const key = context.receipt.key;
  const stored = await deps.store.get(key);
  if (stored && stored.unknown) throw unknownOutcomeError(stored, { ...context, existing: stored });
  const unknown = { step: "document", fileName: irepsFileName(file && file.name), fileDesc: String(fileDesc || "").trim() };
  const patch = { status: (stored && stored.status) || "item-saved", billRegNo: bill.billRegNo, dispatchNo: bill.dispatchNo };
  try {
    return await guardedWrite({ key, patch, unknown }, deps, (d) => uploadBillDocument({ bill, file, fileDesc }, d));
  } catch (error) {
    if (error && error.code === BILL_ERROR.OUTCOME_UNKNOWN) error.context = { ...context, existing: await deps.store.get(key) };
    throw error;
  }
}

/**
 * The user checked the bill in IREPS after a write's answer did not arrive, and confirms it
 * (review 3.1): DocLink may send that step again. `step` and `at` are what the panel showed, so
 * a confirmation never clears another write than the one the user read about.
 * @returns {Promise<object>} the context with the store read again
 */
export async function confirmCheckedInIreps(context, { step, at } = {}, deps) {
  const key = context.receipt.key;
  const entry = await deps.store.get(key);
  const u = entry && entry.unknown;
  if (!u) return withStoredBill(context, deps);
  if (u.step !== step || u.at !== at) {
    throw new IrepsError(BILL_ERROR.CHECKS_FAILED, "another unconfirmed write", { detail: "what DocLink asks you to check in IREPS has changed; read it again" });
  }
  if (!entry.billRegNo) await deps.store.remove(key);
  else await deps.store.put(key, { unknown: null });
  logger.info(`Bill upload: the user checked IREPS after the ${u.step} answer was missing; DocLink may send that step again`, { po: entry.poNumber, poSr: entry.poSr, bill: entry.billRegNo || null, invoice: entry.invoiceNo });
  return withStoredBill(context, deps);
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

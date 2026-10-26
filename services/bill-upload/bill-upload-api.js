/**
 * IREPS supplier bill endpoints (/epsn/ct/*) used by the bill upload (upload.md, sections
 * 4-7). Request bodies reproduce the captured requests field for field and in the same
 * order (stock bill HAR #109-#117, non-stock bill HAR #369-#373); responses are parsed from
 * the portal's own text formats:
 *
 *   POST /epsn/ct/fetchPODetails.do       rly, poKey                -> bill form (HTML, bill-form.js)
 *   POST /epsn/ct/populatePayAuthList.do  payingRly, poKey          -> success^^<code>-<rly>^^<label>
 *   POST /epsn/ct/populatePOSrList.do     ... stockNonstock         -> success^^<poSr>[^^...]
 *   POST /epsn/common/getAjaxData.do      gstNo                     -> <id>:<state>^false^Valid GSTIN^<gstin>^...^Y^...
 *   POST /epsn/ct/saveBillHeader.do       header fields             -> success^^<billRegNo>        WRITES: creates a draft bill
 *   POST /epsn/ct/fetchPOItemDetails.do   poSrNo, billRegNo ...     -> success@#$%<block>@#$%...   (fields ^^)
 *   POST /epsn/ct/populateROList.do       poSrNo                    -> success^^<count>^^<roNo>[^^...]
 *   POST /epsn/ct/populateRODetails.do    roNo                      -> success^^ + 15 fields
 *   POST /epsn/ct/saveBillDetails.do      item fields               -> success^^<dispatchNo>^^<amount>^^<rlyGSTIN>^^OK#<n><><docs>   WRITES
 *
 * The AJAX calls carry the headers the bill page's jQuery sends (Content-Type with charset,
 * X-Requested-With, Accept). The transport is `deps.fetch` (the service worker passes one that
 * runs the request inside the user's IREPS tab, see tab-transport.js).
 *
 * Anything that does not start with "success" is IREPS refusing the call; its text is the
 * reason the page would have shown in an alert, so it is kept as the error detail.
 */

import { IrepsError, IREPS_ERROR, requestIreps } from "../ireps-api.js";
import { isIrepsLoginPage } from "../session-service.js";

export const BILL_ENDPOINTS = Object.freeze({
  FORM: "/epsn/ct/fetchPODetails.do",
  PAY_AUTH_LIST: "/epsn/ct/populatePayAuthList.do",
  PO_SR_LIST: "/epsn/ct/populatePOSrList.do",
  GSTIN: "/epsn/common/getAjaxData.do",
  SAVE_HEADER: "/epsn/ct/saveBillHeader.do",
  ITEM_DETAILS: "/epsn/ct/fetchPOItemDetails.do",
  RO_LIST: "/epsn/ct/populateROList.do",
  RO_DETAILS: "/epsn/ct/populateRODetails.do",
  SAVE_DETAILS: "/epsn/ct/saveBillDetails.do"
});

/** Headers of the bill page's jQuery AJAX posts (captured). */
export const AJAX_HEADERS = Object.freeze({
  Accept: "text/plain, */*; q=0.01",
  "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
  "X-Requested-With": "XMLHttpRequest"
});

/** Controlled error codes of the bill upload (texts in utils/messages.js). */
export const BILL_ERROR = Object.freeze({
  SESSION_EXPIRED: IREPS_ERROR.SESSION_EXPIRED,
  REQUEST_FAILED: "BILL_REQUEST_FAILED",
  FORM_INVALID: "BILL_FORM_INVALID",
  IREPS_REJECTED: "BILL_IREPS_REJECTED",
  RESPONSE_INVALID: "BILL_RESPONSE_INVALID",
  NO_RECEIPTS: "BILL_NO_RECEIPTS",
  NOT_BILLABLE: "BILL_NOT_BILLABLE",
  DRAFT_EXISTS: "BILL_DRAFT_EXISTS",
  CHECKS_FAILED: "BILL_CHECKS_FAILED",
  INVOICE_INVALID: "BILL_INVOICE_INVALID",
  ECM_NOT_FOUND: "BILL_ECM_NOT_FOUND",
  ECM_AMBIGUOUS: "BILL_ECM_AMBIGUOUS",
  ECM_ALREADY_SENT: "BILL_ECM_ALREADY_SENT",
  ECM_UNAVAILABLE: "BILL_ECM_UNAVAILABLE",
  NO_DOCUMENTS: "BILL_NO_DOCUMENTS",
  TAB_UNAVAILABLE: "BILL_TAB_UNAVAILABLE",
  BUSY: "BILL_BUSY",
  NOT_PREPARED: "BILL_NOT_PREPARED"
});

/** Separators of the bill responses. */
const FIELD_SEP = "^^";
const BLOCK_SEP = "@#$%";

/** Ordered field names of the captured requests (upload.md section 6). */
export const SAVE_HEADER_FIELDS = Object.freeze([
  "invoiceAmount", "invoiceType", "payingRly", "stockNonstock", "fuelNonFuel", "multiInvoiceFlag", "invoiceCount", "billType",
  "spmBillRegNo", "organization", "department", "unit", "rly", "poKey", "poNumber", "poDate", "companyName", "pvc", "svcFlag",
  "gstFlag", "gstRegFlag", "reverseChargeFlag", "compositeFlag", "supplierGSTIN", "vendorCode", "payingAuthorityCode", "invoiceNo",
  "invoiceDate", "paymentType", "paymentPercent", "bankAccountNo", "ifscCode", "billDescription", "placeOfSupply", "stateOfSupply",
  "supplierState", "ipasAUCode", "nitOid", "supplementaryBillType", "paymentCode", "additionalPayment", "totalAmount", "rcvIdStr",
  "rcvRefundClaimAmtStr", "rrlNoStr", "rrlDateStr", "rrlValueStr", "totalBalanceAmtWraDouble"
]);

export const SAVE_DETAILS_FIELDS = Object.freeze([
  "billType", "gstFlag", "rly", "poKey", "poNumber", "poDate", "pvc", "billRegNo", "paymentType", "poSrNo", "invoiceNo", "invoiceDate",
  "billItemSrNo", "plNo", "description", "consigneeCode", "unitCode", "deliveryDate", "allocation", "qtyOrdered", "poRate",
  "paymentPercent", "dispatchNo", "pvcOnPoRate", "dispatchMode", "rrNumber", "rrDate", "rrQuantity", "icNumber", "icDate",
  "icPassedQuantity", "icPreviouslyBilledQuantity", "icBalanceQuantity", "icQuantityNowBilled", "disUnit", "disRate", "disAmt",
  "pkgUnit", "pkgRate", "pkgAmt", "edUnit", "edRate", "edAmt", "stUnit", "stRate", "fwdUnit", "fwdRate", "frtUnit", "frtRate",
  "oth1Unit", "oth2Unit", "oth1Rate", "oth2Rate", "fwdAmt", "frtAmt", "oth1Amt", "oth2Amt", "stAmt", "oth1Des", "oth2Des",
  "netBasicRate", "expenseAmount", "basicAmount", "totalAmount", "amountClaimed", "gstCategory", "itcFlagRail", "hsnCode", "cessRate",
  "igstRate", "cgstRate", "sgstRate", "utgstRate", "igstAmount", "cgstAmount", "sgstAmount", "utgstAmount", "cessAmount",
  "challanNumber", "challanDate", "drrNumber", "drrDate", "drrQuantity", "itcFlagRoad", "itcFlagFinal", "roNo", "roDate", "roQty",
  "roQtyBilled", "itc", "addExpStr", "compositeFlag", "inspectionAgency", "rlyGSTIN", "spmBillRegNo", "vendorRemarks", "grossAmt",
  "passedAmount", "balanceAmt", "additionalPayment", "maxClaim", "rNoteNumber", "rNoteDate", "deliveryChallanNo",
  "deliveryChallanDate", "fuelNonFuel", "rnUrl"
]);

/**
 * url-encoded body with exactly `fields`, in that order. Every field must be present in
 * `values` (a missing one is a programming error, not something to send blank silently).
 */
export function orderedBody(fields, values) {
  const body = new URLSearchParams();
  for (const key of fields) {
    if (!(key in values)) throw new Error(`bill request field "${key}" has no value`);
    const v = values[key];
    body.append(key, v === null || v === undefined ? "" : String(v));
  }
  const extra = Object.keys(values).filter((k) => !fields.includes(k));
  if (extra.length) throw new Error(`unexpected bill request fields: ${extra.join(", ")}`);
  return body.toString();
}

/* -------------------------------------------------------------------------- */
/* Transport                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * POST to a bill endpoint. Network / HTTP failures -> BILL_REQUEST_FAILED, a login page ->
 * IREPS_SESSION_EXPIRED. Returns the trimmed response text.
 * @param {string} path
 * @param {string} body
 * @param {{ fetch?: typeof fetch }} deps
 * @param {{ ajax?: boolean }} [options]   ajax=false for the page load (fetchPODetails.do)
 */
export async function postBill(path, body, deps = {}, { ajax = true } = {}) {
  let response;
  try {
    response = await requestIreps({ path, method: "POST", body, headers: ajax ? AJAX_HEADERS : undefined }, { fetch: deps.fetch });
  } catch (error) {
    if (error instanceof IrepsError && error.code === IREPS_ERROR.REQUEST_FAILED) {
      throw new IrepsError(BILL_ERROR.REQUEST_FAILED, error.message, { status: error.status, reason: error.reason, detail: `${error.detail || "request failed"} (${path.split("/").pop()})`, cause: error });
    }
    throw error;
  }
  const text = String(response.html || "").trim();
  // An AJAX answer is plain text; a whole HTML page here means IREPS sent its login page.
  if (ajax && /<\s*(!doctype|html|body|form)\b/i.test(text.slice(0, 2000)) && isIrepsLoginPage(text, response)) {
    throw new IrepsError(BILL_ERROR.SESSION_EXPIRED, "IREPS answered a bill call with the login page");
  }
  return { text, response };
}

function rejected(endpoint, text) {
  const reason = String(text || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300) || "empty answer";
  return new IrepsError(BILL_ERROR.IREPS_REJECTED, `${endpoint} refused: ${reason}`, { detail: `${endpoint}: ${reason}` });
}

function invalid(endpoint, text) {
  return new IrepsError(BILL_ERROR.RESPONSE_INVALID, `${endpoint}: unexpected answer`, { detail: `${endpoint} answered "${String(text).slice(0, 120)}"` });
}

/** Fields of a "success^^a^^b" answer (without the leading "success"); throws when IREPS refused. */
export function successFields(endpoint, text) {
  const parts = String(text || "").trim().split(FIELD_SEP);
  if (parts[0].trim() !== "success") throw rejected(endpoint, text);
  return parts.slice(1);
}

/* -------------------------------------------------------------------------- */
/* Response parsers (pure)                                                    */
/* -------------------------------------------------------------------------- */

/**
 * populatePayAuthList.do: success^^A1001-11^^PFA/ECoR/BBS(A1001)-3101-ECOR[^^...]
 * The page takes payingAuthorityCode = value before "-" and ipasAUCode = the label's
 * second-last "-" part.
 */
export function parsePayAuthList(text) {
  const fields = successFields("populatePayAuthList", text);
  const out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const value = fields[i].trim();
    const label = fields[i + 1].trim();
    const labelParts = label.split("-");
    out.push({ value, label, code: value.split("-")[0], ipasAUCode: labelParts.length >= 2 ? labelParts[labelParts.length - 2] : "" });
  }
  return out;
}

/** populatePOSrList.do: success^^001[^^002...] */
export function parsePoSrList(text) {
  return successFields("populatePOSrList", text).map((s) => s.trim()).filter(Boolean);
}

/**
 * getAjaxData.do (gstNo): 1013:Haryana^false^Valid GSTIN^06AAGCS8525B1ZI^<legal name>^^^^^^Y^<date>^...^Regular
 * The page treats it as valid when field 1 starts with "false" and field 10 is "Y".
 */
export function parseGstinStatus(text) {
  const parts = String(text || "").trim().split("^");
  const state = (parts[0] || "").split(":");
  const valid = parts.length > 10 && (parts[1] || "").slice(0, 5) === "false" && parts[10] === "Y";
  return {
    valid,
    message: valid ? parts[2] || "Valid GSTIN" : (parts[1] || "").slice(0, 5) === "false" ? "Inactive GSTIN" : parts[1] || "GSTIN not recognised by IREPS",
    stateName: state[1] || null,
    gstin: parts[3] || null,
    legalName: parts[4] || null,
    type: parts[parts.length - 1] || null
  };
}

/** saveBillHeader.do: success^^3816672 */
export function parseSaveHeader(text) {
  const fields = successFields("saveBillHeader", text);
  const billRegNo = (fields[0] || "").trim();
  if (!/^\d+$/.test(billRegNo)) throw invalid("saveBillHeader", text);
  return { billRegNo };
}

/**
 * fetchPOItemDetails.do: success@#$%<item>@#$%<units>@#$%<rates>@#$%<other descs>@#$%<consignee>@#$%<inspection>...
 *   item:      poSr ^^ plNo ^^ description ^^ deliveryDate ^^ allocation ^^ qtyOrdered ^^ poRate ^^ unit ^^ unitCode ^^ billItemSrNo
 *   units:     dis ^^ pkg ^^ ed ^^ frt ^^ fwd ^^ st ^^ oth1 ^^ oth2   (charge units, "-1" = none)
 *   rates:     same order; st = the PO's GST rate
 *   consignee: ? ^^ code ^^ "NAME (State, GST# 37AAAGM0289C1ZI)" ^^ ...
 * Field meanings follow what the page sends to saveBillDetails.do (upload.md, step 7).
 */
export function parseItemDetails(text) {
  const raw = String(text || "").trim();
  const blocks = raw.split(BLOCK_SEP);
  if (blocks[0].trim() !== "success") throw rejected("fetchPOItemDetails", raw);
  if (blocks.length < 7) throw invalid("fetchPOItemDetails", raw);
  const f = (i) => blocks[i].split(FIELD_SEP).map((s) => s.trim());
  const item = f(1);
  const units = f(2);
  const rates = f(3);
  const descs = f(4);
  const consignee = f(5);
  const charges = ["dis", "pkg", "ed", "frt", "fwd", "st", "oth1", "oth2"];
  const unitOf = {};
  const rateOf = {};
  charges.forEach((c, i) => {
    unitOf[c] = units[i] ?? "-1";
    rateOf[c] = rates[i] ?? "0";
  });
  const consigneeName = consignee[2] || "";
  const gst = /GST#\s*([0-9A-Z]{15})/i.exec(consigneeName);
  const stateMatch = /\(([^,()]+),\s*GST#/i.exec(consigneeName);
  return {
    poSrNo: item[0] || "",
    plNo: item[1] || "",
    description: item[2] || "",
    deliveryDate: item[3] || "",
    allocation: item[4] || "",
    qtyOrdered: item[5] || "",
    poRate: item[6] || "",
    unit: item[7] || "",
    unitCode: item[8] || "",
    billItemSrNo: item[9] || "1",
    units: unitOf,
    rates: rateOf,
    otherChargeDescriptions: [descs[0] || "NA", descs[1] || "NA"],
    consigneeCode: consignee[1] || "",
    consigneeName,
    consigneeState: stateMatch ? stateMatch[1].trim() : null,
    consigneeGstin: gst ? gst[1].toUpperCase() : null,
    inspectionAgency: (blocks[6] || "").trim()
  };
}

/** populateROList.do: success^^1^^48302601243 */
export function parseRoList(text) {
  const fields = successFields("populateROList", text).map((s) => s.trim());
  const count = Number(fields[0]);
  if (!Number.isInteger(count)) throw invalid("populateROList", text);
  return fields.slice(1).filter(Boolean);
}

/**
 * populateRODetails.do: success^^14/10/2026^^87^^RT260464^^0^^4826100504^^14/10/2026^^0^^ 4826100504:87^^^^87.0^^^^812656.56^^0^^812656.56^^<url>
 * Index meanings from upload.md (step 7 table); "Not Applicable" / "NA" are kept as sent.
 */
export function parseRoDetails(text) {
  const f = successFields("populateRODetails", text).map((s) => s.trim());
  if (f.length < 14) throw invalid("populateRODetails", text);
  return {
    roDate: f[0],
    roQty: f[1],
    drrNumber: f[2],
    rNoteNumber: f[4],
    rNoteDate: f[5],
    rNoteBreakup: f[7],
    billableQty: f[9],
    itemValue: f[11],
    passedAmount: f[12],
    maxClaim: f[13],
    receiptUrl: f[14] || ""
  };
}

/**
 * saveBillDetails.do: success^^3970712^^123964.56^^29AAAGM0289C1ZF^^OK#1<>48302601243.pdf#<path>#RNOTE / CRN - SYSTEM UPLOAD#14/10/2026 16:32#<user>#<id><>
 */
export function parseSaveDetails(text) {
  const raw = String(text || "").trim();
  const fields = successFields("saveBillDetails", raw);
  const dispatchNo = (fields[0] || "").trim();
  if (!/^\d+$/.test(dispatchNo)) throw invalid("saveBillDetails", raw);
  return { dispatchNo, amount: (fields[1] || "").trim(), rlyGSTIN: (fields[2] || "").trim(), documents: parseDocumentList(fields.slice(3).join(FIELD_SEP)) };
}

/** "OK#<n><>file#path#description#date time#user#id<>..." -> document rows. */
export function parseDocumentList(text) {
  const raw = String(text || "").trim();
  if (!raw.startsWith("OK#")) return [];
  return raw
    .split("<>")
    .slice(1)
    .map((row) => row.split("#"))
    .filter((cols) => cols.length >= 3 && cols[0])
    .map((cols) => ({ fileName: cols[0], path: cols[1] || "", description: cols[2] || "", uploadedAt: cols[3] || "", uploadedBy: cols[4] || "", id: cols[5] || "" }));
}

/* -------------------------------------------------------------------------- */
/* Calls                                                                      */
/* -------------------------------------------------------------------------- */

/** The bill entry page of a PO (read-only; what "Bill Claim" opens). Returns its HTML. */
export async function loadBillForm({ rly, poKey }, deps = {}) {
  const body = new URLSearchParams({ rly, poKey }).toString();
  const { text } = await postBill(BILL_ENDPOINTS.FORM, body, deps, { ajax: false });
  return text;
}

export async function fetchPayAuthList({ payingRly, poKey }, deps = {}) {
  const { text } = await postBill(BILL_ENDPOINTS.PAY_AUTH_LIST, orderedBody(["payingRly", "poKey"], { payingRly, poKey }), deps);
  return parsePayAuthList(text);
}

export async function fetchPoSrList(values, deps = {}) {
  const fields = ["rly", "poNumber", "payingAuthorityCode", "billType", "billRegNo", "stockNonstock", "payingRly"];
  const { text } = await postBill(BILL_ENDPOINTS.PO_SR_LIST, orderedBody(fields, values), deps);
  return parsePoSrList(text);
}

export async function checkGstin(gstNo, deps = {}) {
  const { text } = await postBill(BILL_ENDPOINTS.GSTIN, orderedBody(["gstNo"], { gstNo }), deps);
  return parseGstinStatus(text);
}

/** WRITES: creates the draft bill on IREPS. `values` must hold every SAVE_HEADER_FIELDS key. */
export async function saveBillHeader(values, deps = {}) {
  const { text } = await postBill(BILL_ENDPOINTS.SAVE_HEADER, orderedBody(SAVE_HEADER_FIELDS, values), deps);
  return parseSaveHeader(text);
}

export async function fetchItemDetails(values, deps = {}) {
  const fields = ["poSrNo", "rly", "poKey", "poNumber", "billNo", "paymentType", "billRegNo", "gstFlag", "payingRly", "billType", "spmBillRegNo"];
  const { text } = await postBill(BILL_ENDPOINTS.ITEM_DETAILS, orderedBody(fields, values), deps);
  return parseItemDetails(text);
}

export async function fetchRoList(values, deps = {}) {
  const fields = ["rly", "poNumber", "poSrNo", "billType", "billRegNo", "payingRly"];
  const { text } = await postBill(BILL_ENDPOINTS.RO_LIST, orderedBody(fields, values), deps);
  return parseRoList(text);
}

export async function fetchRoDetails(values, deps = {}) {
  const fields = ["rly", "poNumber", "poSrNo", "roNo", "billType", "paymentPercent", "payingRly"];
  const { text } = await postBill(BILL_ENDPOINTS.RO_DETAILS, orderedBody(fields, values), deps);
  return parseRoDetails(text);
}

/** WRITES: saves the bill item; returns dispatchNo and the documents IREPS attached itself. */
export async function saveBillDetails(values, deps = {}) {
  const { text } = await postBill(BILL_ENDPOINTS.SAVE_DETAILS, orderedBody(SAVE_DETAILS_FIELDS, values), deps);
  return parseSaveDetails(text);
}

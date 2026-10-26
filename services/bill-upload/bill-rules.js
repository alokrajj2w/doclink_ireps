/**
 * Business rules of the bill upload, kept pure (no network, no chrome.*) so they can be
 * tested on the captured numbers. Sources: upload.md sections 6-8, the bill page script
 * billFunctions.js (stock HAR #77: calculateExpAmt, saveDtls, setResetGSTCommon, isUT) and
 * the captured requests.
 *
 *   buildHeader()  every saveBillHeader.do field, where each value came from, and the checks
 *                  that must pass before the draft bill is created
 *   buildItem()    every saveBillDetails.do field, the amounts (computed like the page does)
 *                  and the checks that must pass before the item is saved
 *
 * Checks are { level: "error" | "warning", text }. An error stops the step; a warning is
 * shown and has to be acknowledged.
 */

import { SAVE_HEADER_FIELDS, SAVE_DETAILS_FIELDS } from "./bill-upload-api.js";

/** GST state codes (the bill page's stateOfSupply options) with the names / abbreviations ECM addresses use. */
export const GST_STATES = Object.freeze([
  ["35", "Andaman And Nicobar", ["AN"]],
  ["37", "Andhra Pradesh", ["AP", "AD"]],
  ["12", "Arunachal Pradesh", ["AR"]],
  ["18", "Assam", ["AS"]],
  ["10", "Bihar", ["BR", "BH"]],
  ["04", "Chandigarh", ["CH"]],
  ["22", "Chhattisgarh", ["CG", "CT"]],
  ["26", "Dadra & Nagar Haveli and Daman & Diu", ["DN", "DD", "DH"]],
  ["07", "Delhi", ["DL"]],
  ["30", "Goa", ["GA"]],
  ["24", "Gujarat", ["GJ"]],
  ["06", "Haryana", ["HR"]],
  ["02", "Himachal Pradesh", ["HP"]],
  ["01", "Jammu And Kashmir", ["JK"]],
  ["20", "Jharkhand", ["JH"]],
  ["29", "Karnataka", ["KA"]],
  ["32", "Kerala", ["KL"]],
  ["38", "Ladakh", ["LA"]],
  ["31", "Lakshadweep", ["LD"]],
  ["23", "Madhya Pradesh", ["MP"]],
  ["27", "Maharashtra", ["MH"]],
  ["14", "Manipur", ["MN"]],
  ["17", "Meghalaya", ["ML"]],
  ["15", "Mizoram", ["MZ"]],
  ["13", "Nagaland", ["NL"]],
  ["21", "Odisha", ["OD", "OR"]],
  ["34", "Puducherry", ["PY"]],
  ["03", "Punjab", ["PB"]],
  ["08", "Rajasthan", ["RJ"]],
  ["11", "Sikkim", ["SK"]],
  ["33", "Tamil Nadu", ["TN"]],
  ["36", "Telangana", ["TS", "TG"]],
  ["16", "Tripura", ["TR"]],
  ["09", "Uttar Pradesh", ["UP"]],
  ["05", "Uttarakhand", ["UK", "UT"]],
  ["19", "West Bengal", ["WB"]]
].map(([code, name, abbr]) => Object.freeze({ code, name, abbr })));

/** billFunctions.js isUT(): SGST becomes UTGST for these states of supply. */
export const UT_STATE_CODES = Object.freeze(["35", "04", "26", "25", "31"]);
/** The item screen's IGST / CGST rate drop-downs (stock HAR #55). */
export const IGST_RATES = Object.freeze(["0", "1", "2", "3", "5", "8.9", "12", "13.8", "18", "28", "40"]);
export const CGST_RATES = Object.freeze(["0", "0.5", "1", "1.5", "2.5", "4.45", "6", "6.9", "9", "14", "20"]);

/**
 * Supplier GSTIN of the invoicing plant, from ECM `division`, until ECM carries
 * `gstinSupplier` (upload.md section 8, note 1 - to be confirmed by the business).
 */
export const SUPPLIER_GSTIN_BY_DIVISION = Object.freeze({ WABHSR: "33AAGCS8525B1ZL", WABRTK: "06AAGCS8525B1ZI" });

/** Rounding tolerance between ECM's invoice amount and the amount IREPS computes (485777 vs 485776.50 was accepted). */
export const AMOUNT_TOLERANCE = 1;
/** IREPS field limits (bill page). */
export const LIMITS = Object.freeze({ invoiceNo: 16, invoiceAmount: 12, placeOfSupply: 20, billDescription: 200, hsnMax: 8, hsnMin: 4 });

const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

export function isValidGstin(value) {
  return GSTIN_RE.test(String(value || "").trim().toUpperCase());
}

export function stateName(code) {
  const s = GST_STATES.find((x) => x.code === code);
  return s ? s.name : null;
}

/** "TN", "Tamil Nadu", "TAMILNADU" -> "33"; null when unknown. */
export function stateCodeOf(text) {
  const t = String(text || "").trim();
  if (!t) return null;
  const upper = t.toUpperCase();
  const compact = upper.replace(/[^A-Z]/g, "");
  for (const s of GST_STATES) {
    if (s.abbr.includes(upper)) return s.code;
    if (s.name.toUpperCase().replace(/[^A-Z]/g, "") === compact) return s.code;
  }
  return null;
}

/** dd/mm/yyyy from "2026-08-18 00:00:00.000", "2026-08-18T..", "18/08/2026", "18-08-2026", "18-Aug-2026" or epoch ms. */
export function toIrepsDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const pad = (n) => String(n).padStart(2, "0");
  const valid = (y, m, d) => {
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? `${pad(d)}/${pad(m)}/${y}` : null;
  };
  if (typeof value === "number") {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? valid(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()) : null;
  }
  const t = String(value).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T].*)?$/.exec(t);
  if (m) return valid(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(t);
  if (m) return valid(+m[3], +m[2], +m[1]);
  m = /^(\d{1,2})[-/ ]([A-Za-z]{3})[A-Za-z]*[-/ ](\d{4})$/.exec(t);
  if (m && MONTHS[m[2].toLowerCase()]) return valid(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  return null;
}

function irepsDateValue(ddmmyyyy) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(ddmmyyyy || "");
  return m ? Date.UTC(+m[3], +m[2] - 1, +m[1]) : NaN;
}

/** "1,23,456.50" / 123456.5 -> 123456.5; NaN when not a number. */
export function parseAmount(value) {
  if (typeof value === "number") return value;
  const t = String(value ?? "").replace(/,/g, "").trim();
  return t && /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : NaN;
}

/** Two-decimal rounding as the page's toFixed(2) does it, without float drift. */
export function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** "87 Set" -> 87 */
export function quantityOf(text) {
  const m = /-?\d+(?:\.\d+)?/.exec(String(text ?? "").replace(/,/g, ""));
  return m ? Number(m[0]) : NaN;
}

/** Header invoice amount as typed: whole rupees without decimals, else two decimals. */
export function formatInvoiceAmount(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/** A rate as the page's drop-down value: 18 -> "18", 4.45 -> "4.45". */
function rateText(n) {
  return String(round2(n));
}

/**
 * State of supply from the invoice: the railway GSTIN ECM holds as `gstinRecipient`
 * (its first two digits), else the state in the consignee address
 * ("CHENNAI, TN, 600038, IN"). Both are derivations to be confirmed (upload.md section 8, note 2).
 * @returns {{ value: string, source: string }|null}
 */
export function deriveStateOfSupply(invoice) {
  if (isValidGstin(invoice.gstinRecipient)) {
    const code = invoice.gstinRecipient.trim().slice(0, 2);
    if (stateName(code)) return { value: code, source: `ECM gstinRecipient ${invoice.gstinRecipient.trim()}` };
  }
  const address = String(invoice.consigneeAddressLine4 || "");
  for (const part of address.split(",").map((p) => p.trim()).filter(Boolean)) {
    const code = stateCodeOf(part);
    if (code) return { value: code, source: `ECM consigneeAddressLine4 "${address.trim()}"` };
  }
  return null;
}

/** @returns {{ value: string, source: string }|null} */
export function deriveSupplierGstin(invoice) {
  if (isValidGstin(invoice.gstinSupplier)) return { value: invoice.gstinSupplier.trim().toUpperCase(), source: "ECM gstinSupplier" };
  const division = String(invoice.division || "").trim().toUpperCase();
  if (SUPPLIER_GSTIN_BY_DIVISION[division]) return { value: SUPPLIER_GSTIN_BY_DIVISION[division], source: `ECM division ${division} (rule to confirm)` };
  return null;
}

/** Payment % from ECM paymentTerm ("100% against receipt ..." -> 100); null when it names none. */
export function paymentPercentFrom(paymentTerm) {
  const m = /(\d{1,3}(?:\.\d+)?)\s*%/.exec(String(paymentTerm || ""));
  return m ? Number(m[1]) : null;
}

const err = (text) => ({ level: "error", text });
const warn = (text) => ({ level: "warning", text });

/**
 * The header of the bill (saveBillHeader.do).
 *
 * @param {{
 *   receipt: object,            normalised receipt (bill-upload-service.js)
 *   invoice: object,            normalised invoice (ecm-invoice.js)
 *   form: import("./bill-form.js").BillForm,
 *   payAuths: { value: string, label: string, code: string, ipasAUCode: string }[],
 *   stockNonstock: "S"|"N",
 *   gstinStatus?: { valid: boolean, message: string }|null,
 *   overrides?: { supplierGSTIN?: string, stateOfSupply?: string, placeOfSupply?: string, billDescription?: string },
 *   today?: Date
 * }} input
 * @returns {{ values: Record<string,string>, review: object[], checks: object[] }}
 */
export function buildHeader({ receipt, invoice, form, payAuths, stockNonstock, gstinStatus = null, overrides = {}, today = new Date() }) {
  const checks = [];
  const review = [];
  const show = (key, label, value, source, extra = {}) => review.push({ key, label, value: value ?? "", source, ...extra });
  const L = form.literals;

  if (form.missing.length) checks.push(err(`The IREPS bill page did not contain ${form.missing.join(", ")}.`));
  if (L.pvc && L.pvc !== "N") checks.push(err("This PO has price variation (PVC); PVC bills are not supported yet."));

  // invoice
  const invoiceNo = String(invoice.invoiceNumber || "").trim();
  if (!invoiceNo) checks.push(err("The invoice has no invoice number."));
  else if (invoiceNo.length > LIMITS.invoiceNo || !/^[A-Za-z0-9\-/]+$/.test(invoiceNo)) checks.push(err(`Invoice number "${invoiceNo}" is not accepted by IREPS (at most 16 characters; letters, digits, - and / only).`));
  const invoiceDate = toIrepsDate(invoice.invoiceDate);
  if (!invoiceDate) checks.push(err(`Invoice date "${invoice.invoiceDate ?? ""}" is not a date.`));
  else if (irepsDateValue(invoiceDate) > Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())) checks.push(err(`Invoice date ${invoiceDate} is in the future.`));
  const amount = parseAmount(invoice.amount);
  if (!(amount > 0)) checks.push(err(`Invoice amount "${invoice.amount ?? ""}" is not a positive amount.`));
  const invoiceAmount = amount > 0 ? formatInvoiceAmount(round2(amount)) : "";
  if (invoiceAmount.length > LIMITS.invoiceAmount) checks.push(err("Invoice amount is longer than IREPS accepts (12 characters)."));

  // payment
  const percent = paymentPercentFrom(invoice.paymentTerm);
  if (percent !== null && percent !== 100) checks.push(err(`ECM payment term is ${percent}%; only 100% (Final) bills are supported yet.`));
  const terms = form.paymentTerms || {};
  if (terms.advancePercent > 0 || (terms.finalPercent > 0 && terms.finalPercent !== 100)) {
    checks.push(warn(`The PO's payment terms in IREPS are ${terms.advancePercent || 0}% advance / ${terms.finalPercent || 0}% final; DocLink bills 100% Final.`));
  }

  // paying railway / authority
  const railways = form.payingRailways || [];
  const payingRly = (railways.find((r) => r.selected) || railways[0] || {}).value || L.rly || "";
  if (railways.length > 1 && !railways.some((r) => r.selected)) checks.push(err("IREPS offers more than one paying railway for this PO; choose it in IREPS."));
  if (!payAuths || payAuths.length === 0) checks.push(err("IREPS returned no paying authority for this PO."));
  else if (payAuths.length > 1) checks.push(err(`IREPS offers ${payAuths.length} paying authorities for this PO; DocLink only handles POs with one.`));
  const payAuth = (payAuths && payAuths[0]) || { code: "", ipasAUCode: "", label: "" };

  // supplier GSTIN
  const derivedGstin = deriveSupplierGstin(invoice);
  const supplierGSTIN = String(overrides.supplierGSTIN || (derivedGstin && derivedGstin.value) || "").trim().toUpperCase();
  const gstinSource = overrides.supplierGSTIN ? "chosen by you" : derivedGstin ? derivedGstin.source : "not available - choose";
  if (!supplierGSTIN) checks.push(err("Supplier GSTIN is not known (ECM has no gstinSupplier and no division rule matched). Choose it."));
  else if (!form.supplierGstins.some((o) => o.value === supplierGSTIN)) checks.push(err(`Supplier GSTIN ${supplierGSTIN} is not one of this IREPS account's GSTINs (${form.supplierGstins.map((o) => o.value).join(", ")}).`));
  else if (gstinStatus && !gstinStatus.valid) checks.push(err(`IREPS reports supplier GSTIN ${supplierGSTIN} as not valid: ${gstinStatus.message}.`));
  const supplierState = supplierGSTIN.slice(0, 2);

  // state / place of supply
  const derivedState = deriveStateOfSupply(invoice);
  const stateOfSupply = String(overrides.stateOfSupply || (derivedState && derivedState.value) || "").trim();
  const stateSource = overrides.stateOfSupply ? "chosen by you" : derivedState ? `${derivedState.source} (rule to confirm)` : "not available - choose";
  if (!stateOfSupply) checks.push(err("State of supply is not known from ECM. Choose it."));
  else if (form.states.length && !form.states.some((o) => o.value === stateOfSupply)) checks.push(err(`State of supply "${stateOfSupply}" is not an IREPS state code.`));
  let placeOfSupply = String(overrides.placeOfSupply ?? (invoice.supplyPlace || invoice.consigneeLocation || "")).replace(/\s+/g, " ").trim();
  if (!placeOfSupply) checks.push(err("Place of supply is empty. Enter it."));
  if (placeOfSupply.length > LIMITS.placeOfSupply) {
    checks.push(warn(`Place of supply shortened to IREPS' 20 characters: "${placeOfSupply.slice(0, LIMITS.placeOfSupply)}".`));
    placeOfSupply = placeOfSupply.slice(0, LIMITS.placeOfSupply);
  }
  const taxCode = String(invoice.taxCode || "").toUpperCase();
  if (supplierState && stateOfSupply && taxCode) {
    const interState = supplierState !== stateOfSupply;
    if (interState && /CGST|SGST|UTGST/.test(taxCode) && !/IGST/.test(taxCode)) checks.push(warn(`ECM tax code is ${taxCode}, but supplier state ${supplierState} and state of supply ${stateOfSupply} differ, so IREPS will apply IGST.`));
    if (!interState && /IGST/.test(taxCode)) checks.push(warn(`ECM tax code is IGST, but supplier state and state of supply are both ${stateOfSupply}, so IREPS will apply CGST + SGST.`));
  }

  // bill description
  let billDescription = String(overrides.billDescription ?? (invoice.partDescription || "CLAIM FOR 100% PAYMENT")).replace(/\s+/g, " ").trim();
  if (billDescription.length > LIMITS.billDescription) billDescription = billDescription.slice(0, LIMITS.billDescription);
  if (!billDescription) checks.push(err("Bill description is empty."));

  if (!form.bankAccountNo || !form.ifscCode) checks.push(err("The IREPS bill page has no prefilled bank account / IFSC."));

  const values = {
    invoiceAmount,
    invoiceType: "I",
    payingRly,
    stockNonstock,
    fuelNonFuel: "N",
    multiInvoiceFlag: "N",
    invoiceCount: "1",
    billType: L.billType || "S",
    spmBillRegNo: L.spmBillRegNo || "null",
    organization: L.organization || "",
    department: L.department || "",
    unit: L.unit || "",
    rly: L.rly || "",
    poKey: L.poKey || "",
    poNumber: L.poNumber || "",
    poDate: L.poDate || "",
    companyName: form.companyName,
    pvc: L.pvc || "N",
    svcFlag: L.svcFlag || "Y",
    gstFlag: "Y",
    gstRegFlag: "Y",
    reverseChargeFlag: "N",
    compositeFlag: "N",
    supplierGSTIN,
    vendorCode: L.vendorCode || "",
    payingAuthorityCode: payAuth.code,
    invoiceNo,
    invoiceDate: invoiceDate || "",
    paymentType: "F",
    paymentPercent: "100",
    bankAccountNo: form.bankAccountNo || "",
    ifscCode: form.ifscCode || "",
    billDescription,
    placeOfSupply,
    stateOfSupply,
    supplierState,
    ipasAUCode: payAuth.ipasAUCode,
    nitOid: L.nitOid || "",
    supplementaryBillType: "",
    paymentCode: L.paymentCode || "",
    additionalPayment: "",
    totalAmount: "",
    rcvIdStr: "",
    rcvRefundClaimAmtStr: "",
    rrlNoStr: "",
    rrlDateStr: "",
    rrlValueStr: "",
    totalBalanceAmtWraDouble: "0"
  };
  if (Object.keys(values).length !== SAVE_HEADER_FIELDS.length) throw new Error("buildHeader: field list out of step with SAVE_HEADER_FIELDS");

  show("poNumber", "PO No.", `${values.poNumber} (PO Sr ${receipt.poSr})`, "IREPS");
  show("stockNonstock", "Stock / Non-stock", stockNonstock === "S" ? "Stock" : "Non-Stock", `IREPS (${receipt.source === "CRN" ? "CRN" : "R-NOTE"} receipt)`);
  show("payingAuthority", "Paying authority", payAuth.label, "IREPS");
  show("invoiceNo", "Tax invoice no.", invoiceNo, invoice.source);
  show("invoiceDate", "Tax invoice date", invoiceDate || String(invoice.invoiceDate ?? ""), invoice.source);
  show("invoiceAmount", "Invoice amount (incl. GST)", invoiceAmount, invoice.source);
  show("payment", "Payment % / type", "100 / Final", "default");
  show("supplierGSTIN", "Supplier GSTIN", supplierGSTIN, gstinSource, { editable: "select", options: form.supplierGstins.map((o) => ({ value: o.value, label: o.label })) });
  show("stateOfSupply", "State of supply", stateOfSupply ? `${stateOfSupply} ${stateName(stateOfSupply) || ""}`.trim() : "", stateSource, {
    editable: "select",
    raw: stateOfSupply,
    options: (form.states.length ? form.states : GST_STATES.map((s) => ({ value: s.code, label: s.name }))).map((o) => ({ value: o.value, label: o.label }))
  });
  show("placeOfSupply", "Place of supply", placeOfSupply, overrides.placeOfSupply !== undefined ? "entered by you" : "ECM supplyPlace", { editable: "text", maxLength: LIMITS.placeOfSupply });
  show("billDescription", "Bill description", billDescription, overrides.billDescription !== undefined ? "entered by you" : invoice.partDescription ? "ECM partDescription" : "template", { editable: "text", maxLength: LIMITS.billDescription });
  show("bank", "Bank account / IFSC", form.bankAccountNo && form.ifscCode ? "prefilled by IREPS" : "", "IREPS");
  return { values, review, checks };
}

/**
 * GST split of the PO rate: IGST when the header's state of supply differs from the
 * supplier state, else CGST + SGST at half the rate (UTGST instead of SGST for a union
 * territory) - billFunctions.js setResetGSTCommon / setSUGST.
 */
export function gstSplit(rate, supplierState, stateOfSupply) {
  if (supplierState !== stateOfSupply) return { igst: rate, cgst: 0, sgst: 0, utgst: 0, interState: true };
  const half = round2(rate / 2);
  return UT_STATE_CODES.includes(stateOfSupply) ? { igst: 0, cgst: half, sgst: 0, utgst: half, interState: false } : { igst: 0, cgst: half, sgst: half, utgst: 0, interState: false };
}

/**
 * Amounts of one bill item as the page's calculateExpAmt computes them for a Final bill
 * without discount, PVC or charges: taxable = rate x qty billed x payment% / 100; each GST
 * component = taxable x its rate, to two decimals; total = taxable + tax.
 */
export function computeAmounts({ rate, qty, paymentPercent = 100, gstRate, supplierState, stateOfSupply }) {
  const taxable = round2((rate * qty * paymentPercent) / 100);
  const split = gstSplit(gstRate, supplierState, stateOfSupply);
  const igst = round2((taxable * split.igst) / 100);
  const cgst = round2((taxable * split.cgst) / 100);
  const sgst = round2((taxable * split.sgst) / 100);
  const utgst = round2((taxable * split.utgst) / 100);
  const tax = round2(igst + cgst + sgst + utgst);
  return { taxable, tax, total: round2(taxable + tax), split, igst, cgst, sgst, utgst };
}

/**
 * The item of the bill (saveBillDetails.do), after the header is saved.
 *
 * @param {{
 *   header: Record<string,string>,     buildHeader().values as saved
 *   billRegNo: string,
 *   receipt: object, invoice: object,
 *   item: ReturnType<import("./bill-upload-api.js").parseItemDetails>,
 *   roNo: string,
 *   ro: ReturnType<import("./bill-upload-api.js").parseRoDetails>,
 *   railwayGstins?: { value: string }[]
 * }} input
 * @returns {{ values: Record<string,string>, amounts: object, review: object[], checks: object[] }}
 */
export function buildItem({ header, billRegNo, receipt, invoice, item, roNo, ro, railwayGstins = [] }) {
  const checks = [];
  if (item.poSrNo && item.poSrNo !== receipt.poSr) checks.push(err(`IREPS returned item ${item.poSrNo} for PO Sr ${receipt.poSr}.`));
  const rate = parseAmount(item.poRate);
  const roQty = parseAmount(ro.roQty);
  const gstRate = parseAmount(item.rates.st);
  if (!(rate > 0)) checks.push(err(`PO rate "${item.poRate}" is not a number.`));
  if (!(roQty > 0)) checks.push(err(`Receipt quantity "${ro.roQty}" is not a number.`));
  if (Number.isFinite(receipt.qty) && roQty > 0 && receipt.qty !== roQty) checks.push(err(`Receipt quantity in IREPS (${roQty}) differs from the search result (${receipt.qty}).`));
  const invoiceQty = parseAmount(invoice.quantity);
  if (Number.isFinite(invoiceQty) && roQty > 0 && invoiceQty !== roQty) checks.push(err(`Invoice quantity (${invoiceQty}) differs from the receipt quantity (${roQty}).`));
  for (const charge of ["dis", "pkg", "ed", "frt", "fwd", "oth1", "oth2"]) {
    const r = parseAmount(item.rates[charge]);
    if (Number.isFinite(r) && r !== 0) checks.push(err(`The PO has a ${charge} charge/discount of ${item.rates[charge]}; such bills are not supported yet.`));
  }
  if (parseAmount(ro.passedAmount) > 0) checks.push(err(`IREPS already passed ${ro.passedAmount} against this receipt; part bills are not supported yet.`));

  const { supplierState, stateOfSupply } = header;
  const amounts = Number.isFinite(gstRate) && rate > 0 && roQty > 0 ? computeAmounts({ rate, qty: roQty, gstRate, supplierState, stateOfSupply }) : null;
  if (amounts) {
    const { split } = amounts;
    if (split.interState && !IGST_RATES.includes(rateText(split.igst))) checks.push(err(`GST rate ${gstRate}% is not an IGST rate IREPS offers.`));
    if (!split.interState && !CGST_RATES.includes(rateText(split.cgst))) checks.push(err(`GST rate ${gstRate}% does not split into a CGST rate IREPS offers.`));
  } else if (!Number.isFinite(gstRate)) checks.push(err(`The PO's GST rate "${item.rates.st}" is not a number.`));

  const invoiceAmount = parseAmount(invoice.amount);
  const maxClaim = parseAmount(ro.maxClaim);
  let claim = amounts ? amounts.total : NaN;
  if (amounts && Number.isFinite(invoiceAmount) && Math.abs(invoiceAmount - amounts.total) > AMOUNT_TOLERANCE) {
    checks.push(err(`Invoice amount ${invoiceAmount} differs from what IREPS computes for this receipt (${amounts.total} = ${amounts.taxable} + ${amounts.tax} GST).`));
  }
  if (Number.isFinite(maxClaim) && claim > maxClaim + 0.001) checks.push(err(`The claim ${claim} is more than IREPS allows (${maxClaim}).`));
  // The page raises the max claim to the header invoice amount when that is larger (billFunctions.js calculateExpAmt).
  const headerInvoiceAmount = parseAmount(header.invoiceAmount);
  const maxClaimSent = Number.isFinite(headerInvoiceAmount) && Number.isFinite(maxClaim) && Math.round(headerInvoiceAmount) > Math.round(maxClaim) ? String(headerInvoiceAmount) : ro.maxClaim;

  const hsn = String(invoice.hsn || "").replace(/\s+/g, "");
  if (!/^\d+$/.test(hsn) || hsn.length < LIMITS.hsnMin || hsn.length > LIMITS.hsnMax) checks.push(err(`HSN code "${invoice.hsn ?? ""}" must be 4 to 8 digits.`));

  const rlyGSTIN = item.consigneeGstin || "";
  if (!rlyGSTIN) checks.push(err("IREPS returned no consignee GSTIN for the railway GSTIN."));
  else if (railwayGstins.length && !railwayGstins.some((o) => o.value === rlyGSTIN)) checks.push(err(`Consignee GSTIN ${rlyGSTIN} is not in IREPS' railway GSTIN list.`));
  if (rlyGSTIN && rlyGSTIN.slice(0, 2) !== stateOfSupply) {
    checks.push(warn(`The consignee is in state ${rlyGSTIN.slice(0, 2)} (${item.consigneeState || "?"}) but the saved state of supply is ${stateOfSupply}; IREPS will apply ${supplierState !== stateOfSupply ? "IGST" : "CGST + SGST"} as saved.`));
  }
  if (!["TPI", "CONSG"].includes(item.inspectionAgency)) checks.push(warn(`Inspection agency "${item.inspectionAgency}" is neither TPI nor CONSG.`));

  const a = amounts || { taxable: 0, tax: 0, igst: 0, cgst: 0, sgst: 0, utgst: 0, split: { igst: 0, cgst: 0, sgst: 0, utgst: 0 } };
  const values = {
    billType: header.billType,
    gstFlag: "Y",
    rly: header.rly,
    poKey: header.poKey,
    poNumber: header.poNumber,
    poDate: header.poDate,
    pvc: "Not Applicable",
    billRegNo,
    paymentType: header.paymentType,
    poSrNo: receipt.poSr,
    invoiceNo: header.invoiceNo,
    invoiceDate: header.invoiceDate,
    billItemSrNo: item.billItemSrNo,
    plNo: item.plNo,
    description: item.description,
    consigneeCode: item.consigneeCode,
    unitCode: item.unitCode,
    deliveryDate: item.deliveryDate,
    allocation: item.allocation,
    qtyOrdered: item.qtyOrdered,
    poRate: item.poRate,
    paymentPercent: header.paymentPercent,
    dispatchNo: "0",
    pvcOnPoRate: "0",
    dispatchMode: "NA",
    rrNumber: "0",
    rrDate: "0",
    rrQuantity: "0",
    icNumber: "",
    icDate: "",
    icPassedQuantity: "",
    icPreviouslyBilledQuantity: "",
    icBalanceQuantity: "",
    icQuantityNowBilled: "",
    disUnit: item.units.dis,
    disRate: "0",
    disAmt: "0.00",
    pkgUnit: item.units.pkg,
    pkgRate: "0",
    pkgAmt: "0.00",
    edUnit: item.units.ed,
    edRate: "0",
    edAmt: "0.00",
    stUnit: item.units.st,
    stRate: item.rates.st,
    fwdUnit: item.units.fwd,
    fwdRate: "0",
    frtUnit: item.units.frt,
    frtRate: "0",
    oth1Unit: item.units.oth1,
    oth2Unit: item.units.oth2,
    oth1Rate: "0",
    oth2Rate: "0",
    fwdAmt: "0.00",
    frtAmt: "0.00",
    oth1Amt: "0.00",
    oth2Amt: "0.00",
    stAmt: "0.00",
    oth1Des: item.otherChargeDescriptions[0],
    oth2Des: item.otherChargeDescriptions[1],
    netBasicRate: item.poRate,
    expenseAmount: a.taxable.toFixed(2),
    basicAmount: a.tax.toFixed(2),
    totalAmount: Number.isFinite(claim) ? claim.toFixed(2) : "",
    amountClaimed: "0",
    gstCategory: "0",
    itcFlagRail: "N",
    hsnCode: hsn,
    cessRate: "0",
    igstRate: rateText(a.split.igst),
    cgstRate: rateText(a.split.cgst),
    sgstRate: rateText(a.split.sgst),
    utgstRate: rateText(a.split.utgst),
    igstAmount: String(a.igst),
    cgstAmount: String(a.cgst),
    sgstAmount: String(a.sgst),
    utgstAmount: String(a.utgst),
    cessAmount: "0",
    challanNumber: "0",
    challanDate: "0",
    drrNumber: ro.drrNumber,
    drrDate: "0",
    drrQuantity: "0",
    itcFlagRoad: "N",
    itcFlagFinal: "N",
    roNo,
    roDate: ro.roDate,
    roQty: ro.roQty,
    roQtyBilled: ro.roQty,
    itc: "0",
    addExpStr: "",
    compositeFlag: "N",
    inspectionAgency: item.inspectionAgency,
    rlyGSTIN,
    spmBillRegNo: "null",
    vendorRemarks: "",
    grossAmt: "",
    passedAmount: ro.passedAmount || "0",
    balanceAmt: "",
    additionalPayment: "0",
    maxClaim: maxClaimSent,
    rNoteNumber: ro.rNoteNumber,
    rNoteDate: ro.rNoteDate,
    deliveryChallanNo: "",
    deliveryChallanDate: "",
    fuelNonFuel: header.fuelNonFuel,
    rnUrl: ro.receiptUrl
  };
  if (Object.keys(values).length !== SAVE_DETAILS_FIELDS.length) throw new Error("buildItem: field list out of step with SAVE_DETAILS_FIELDS");

  const review = [
    { key: "item", label: "Item", value: `PL ${item.plNo}: ${item.description}`.slice(0, 160), source: "IREPS" },
    { key: "receipt", label: "Receipt", value: `RO ${roNo}, qty ${ro.roQty} ${item.unit}${ro.rNoteNumber && ro.rNoteNumber !== "Not Applicable" ? `, R-Note ${ro.rNoteNumber}` : ""}`, source: "IREPS" },
    { key: "rate", label: "PO rate / GST", value: `${item.poRate} / ${item.rates.st}%`, source: "IREPS (PO)" },
    { key: "tax", label: "Tax", value: amounts ? (amounts.split.interState ? `IGST ${rateText(amounts.split.igst)}%` : `CGST ${rateText(amounts.split.cgst)}% + ${amounts.split.utgst ? "UTGST" : "SGST"} ${rateText(amounts.split.cgst)}%`) : "", source: "header states" },
    { key: "amounts", label: "Taxable + tax = total", value: amounts ? `${amounts.taxable.toFixed(2)} + ${amounts.tax.toFixed(2)} = ${amounts.total.toFixed(2)}` : "", source: "computed" },
    { key: "claim", label: "Item-wise claim", value: values.totalAmount, source: `computed; ECM invoice amount ${invoice.amount ?? ""}` },
    { key: "hsn", label: "HSN code", value: hsn, source: invoice.source },
    { key: "rlyGSTIN", label: "Railway GSTIN", value: rlyGSTIN, source: "IREPS (consignee)" },
    { key: "inspection", label: "Inspection agency", value: item.inspectionAgency, source: "IREPS" }
  ];
  return { values, amounts, review, checks };
}

/**
 * The check that can run before anything is written: the item value IREPS reports for the
 * receipt (populateRODetails.do) against the invoice amount. Only meaningful for an
 * untouched receipt billed at 100%.
 */
export function precheckReceipt({ receipt, invoice, ro }) {
  const checks = [];
  const roQty = parseAmount(ro.roQty);
  if (Number.isFinite(receipt.qty) && Number.isFinite(roQty) && receipt.qty !== roQty) checks.push(err(`IREPS reports receipt quantity ${roQty}, the search result ${receipt.qty}.`));
  const invoiceQty = parseAmount(invoice.quantity);
  if (Number.isFinite(invoiceQty) && Number.isFinite(roQty) && invoiceQty !== roQty) checks.push(err(`Invoice quantity (${invoiceQty}) differs from the receipt quantity in IREPS (${roQty}).`));
  if (parseAmount(ro.passedAmount) > 0) checks.push(err(`IREPS already passed ${ro.passedAmount} against this receipt; part bills are not supported yet.`));
  const itemValue = parseAmount(ro.itemValue);
  const amount = parseAmount(invoice.amount);
  if (Number.isFinite(itemValue) && Number.isFinite(amount) && Math.abs(itemValue - amount) > AMOUNT_TOLERANCE) {
    checks.push(err(`Invoice amount ${amount} differs from the receipt's value in IREPS (${itemValue}).`));
  }
  return checks;
}

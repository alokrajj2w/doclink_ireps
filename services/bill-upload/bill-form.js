/**
 * The IREPS bill entry page (POST /epsn/ct/fetchPODetails.do, stock HAR #55): the values
 * the header save needs that only the page knows (upload.md, step 4).
 *
 * Most of them are not form inputs but literals inside the page script that builds the
 * saveBillHeader.do request, e.g.
 *
 *   function saveBillHeader() { ... companyName = 'FAIVELEY ... -HOSUR', ...
 *     data: { ... organization:'01', department:'19', unit:'14651', rly:'11', poKey: '6749760',
 *             poNumber:'02261018101611', poDate: '01/07/2026', pvc: 'N', svcFlag:'Y',
 *             vendorCode: ':833', nitOid:'107092947', paymentCode:'000000', ... }
 *
 * so the page is read with regular expressions (no DOM): this runs in the service worker.
 * The prefilled bank account / IFSC are input values; the GSTIN, paying railway, railway
 * GSTIN and state-of-supply choices are <select> options. PO payment terms come from the
 * literals in checkPaymentTerms() (0 / 0 in both captures).
 */

import { decodeEntities, parseTagAttributes } from "../ireps-form.js";

/** Literals the header request takes from the page script. */
const SCRIPT_LITERALS = ["billType", "spmBillRegNo", "organization", "department", "unit", "rly", "poKey", "poNumber", "poDate", "pvc", "svcFlag", "vendorCode", "nitOid", "paymentCode"];
/** Literals without which the header cannot be saved. */
const REQUIRED_LITERALS = ["organization", "department", "unit", "rly", "poKey", "poNumber", "poDate", "vendorCode", "nitOid", "paymentCode"];

/** Is this the bill entry page (and not a login / error page)? */
export function hasBillForm(html) {
  const s = String(html || "");
  return /\/ct\/saveBillHeader\.do/.test(s) && /<select[^>]*name=["']supplierGSTIN["']/i.test(s);
}

/** The body of the page's saveBillHeader() function (up to its success handler). */
function saveHeaderScript(html) {
  const start = html.search(/function\s+saveBillHeader\s*\(/);
  if (start < 0) return "";
  const end = html.indexOf("success:", start);
  return html.slice(start, end > start ? end : start + 20000);
}

/** key:'value' pairs of an object literal (single or double quotes). */
function scriptLiterals(script) {
  const out = {};
  const re = /([A-Za-z_$][\w$]*)\s*:\s*(?:'([^'\n]*)'|"([^"\n]*)")/g;
  let m;
  while ((m = re.exec(script))) if (!(m[1] in out)) out[m[1]] = decodeEntities(m[2] ?? m[3] ?? "");
  return out;
}

/** Options of a <select> found by its name or id: [{ value, label }] without the "-1" Select entry. */
export function selectOptions(html, nameOrId) {
  const re = new RegExp(`<select\\b[^>]*\\b(?:name|id)\\s*=\\s*["']${nameOrId}["'][^>]*>([\\s\\S]*?)</select>`, "i");
  const m = re.exec(html);
  if (!m) return [];
  const out = [];
  const optionRe = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
  let o;
  while ((o = optionRe.exec(m[1]))) {
    const attrs = parseTagAttributes(`<option ${o[1]}>`);
    const label = decodeEntities(o[2].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
    const value = attrs.value !== undefined ? attrs.value.trim() : label;
    if (value === "-1" || value === "") continue;
    out.push({ value, label, selected: "selected" in attrs });
  }
  return out;
}

/** value="" of the <input> with this name or id, or null. */
export function inputValue(html, nameOrId) {
  const re = new RegExp(`<input\\b[^>]*\\b(?:name|id)\\s*=\\s*["']${nameOrId}["'][^>]*>`, "i");
  const m = re.exec(html);
  if (!m) return null;
  const attrs = parseTagAttributes(m[0]);
  return attrs.value !== undefined ? attrs.value.trim() : null;
}

function percentLiteral(html, name) {
  const m = new RegExp(`var\\s+${name}\\s*=\\s*parseInt\\(\\s*['"]?(\\d*)['"]?\\s*\\)`).exec(html);
  return m && m[1] !== "" ? Number(m[1]) : null;
}

/**
 * @typedef {Object} BillForm
 * @property {Record<string, string>} literals  organization, department, unit, rly, poKey, poNumber, poDate, pvc, svcFlag,
 *                                              vendorCode, nitOid, paymentCode, billType, spmBillRegNo
 * @property {string} companyName
 * @property {string|null} bankAccountNo
 * @property {string|null} ifscCode
 * @property {{ value: string, label: string }[]} supplierGstins
 * @property {{ value: string, label: string }[]} payingRailways
 * @property {{ value: string, label: string }[]} railwayGstins    the item screen's RLY GSTIN choices
 * @property {{ value: string, label: string }[]} states           state-of-supply codes ("29" -> Karnataka)
 * @property {{ advancePercent: number|null, finalPercent: number|null }} paymentTerms
 * @property {string[]} missing     required literals the page did not contain
 */

/**
 * Read the bill entry page.
 * @param {string} html
 * @returns {BillForm}
 */
export function parseBillForm(html) {
  const source = String(html || "");
  const script = saveHeaderScript(source);
  const all = scriptLiterals(script);
  const literals = {};
  for (const key of SCRIPT_LITERALS) if (all[key] !== undefined) literals[key] = all[key].trim();

  // frmVals = ["11","6749760","02261018101611","01/07/2026","Not Applicable",":833"] - a second copy of the PO keys
  const frm = /var\s+frmVals\s*=\s*\[([^\]]*)\]/.exec(source);
  if (frm) {
    const vals = Array.from(frm[1].matchAll(/["']([^"']*)["']/g)).map((m) => m[1]);
    const fallback = { rly: vals[0], poKey: vals[1], poNumber: vals[2], poDate: vals[3], vendorCode: vals[5] };
    for (const [k, v] of Object.entries(fallback)) if (!literals[k] && v) literals[k] = v;
  }
  if (!literals.organization) literals.organization = inputValue(source, "organization") || "";
  if (!literals.department) literals.department = inputValue(source, "department") || "";
  if (!literals.unit) literals.unit = inputValue(source, "unit") || "";

  const company = /companyName\s*=\s*'([^'\n]*)'/.exec(script) || /companyName\s*=\s*"([^"\n]*)"/.exec(script);
  return {
    literals,
    companyName: company ? decodeEntities(company[1]).trim() : "",
    bankAccountNo: inputValue(source, "bankAccountNo"),
    ifscCode: inputValue(source, "ifscCode"),
    supplierGstins: selectOptions(source, "supplierGSTIN"),
    payingRailways: selectOptions(source, "payingRlySelect"),
    railwayGstins: selectOptions(source, "rlyGSTINFinal"),
    states: selectOptions(source, "stateOfSupply"),
    paymentTerms: { advancePercent: percentLiteral(source, "advancePercent"), finalPercent: percentLiteral(source, "finalPercent") },
    missing: REQUIRED_LITERALS.filter((k) => !literals[k])
  };
}

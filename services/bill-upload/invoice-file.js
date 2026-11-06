/**
 * The JSON-file invoice source of the bill upload: the user picks a .json file in the
 * panel (step 2, "From a JSON file") while the invoices do not come from ECM or another
 * system yet. Nothing is bundled: the file is read when it is picked, so this works in the
 * built extension too.
 *
 * The invoices are in ECM's RetrieveInvoiceData shape (ecm-invoice.js), so switching the
 * source later changes nothing downstream. The file may be a list of invoices,
 * { "invoices": [...] } (or entries / data / records / ...), or a single invoice. Other
 * top-level keys (notes, "_..." comments) are ignored.
 *
 * The invoice for a receipt is chosen as the ECM lookup chooses it: same customer PO,
 * PO Sr and quantity, not marked "Sent to Doculink", exactly one. Numbers compare by value
 * here ("1" == "001", "87.0" == "87"), since the file is typed by hand.
 *
 * Pure module (no chrome.*): the panel uses it to show what the file holds, the service
 * worker to pick the invoice.
 */

import { normaliseInvoice, invoiceRecords, isSentToDoculink } from "./ecm-invoice.js";
import { IrepsError } from "../ireps-api.js";
import { BILL_ERROR } from "./bill-upload-api.js";

export const MAX_INVOICE_FILE_BYTES = 1024 * 1024;
export const MAX_INVOICE_FILE_RECORDS = 500;

const invalid = (detail) => new IrepsError(BILL_ERROR.FILE_INVALID, "invoice file invalid", { detail });

/**
 * The invoices of a picked file.
 * @param {string} text   the file's content
 * @param {string} name   the file's name (shown as the source of every invoice value)
 * @returns {{ name: string, records: object[] }}
 */
export function parseInvoiceFile(text, name = "invoices.json") {
  if (typeof text !== "string" || !text.trim()) throw invalid(`${name} is empty`);
  if (text.length > MAX_INVOICE_FILE_BYTES) throw invalid(`${name} is larger than 1 MB`);
  let body;
  try {
    body = JSON.parse(text);
  } catch (error) {
    throw invalid(`${name} is not valid JSON (${error.message})`);
  }
  const records = invoiceRecords(body).filter((r) => r && typeof r === "object" && !Array.isArray(r));
  if (!records.length) throw invalid(`${name} has no invoices: expected a list, or { "invoices": [...] }, of invoices with an invoiceNumber`);
  if (records.length > MAX_INVOICE_FILE_RECORDS) throw invalid(`${name} has ${records.length} invoices; at most ${MAX_INVOICE_FILE_RECORDS} are read`);
  const withNumber = records.filter((r) => normaliseInvoice(r).invoiceNumber);
  if (!withNumber.length) throw invalid(`no invoice in ${name} has an invoiceNumber`);
  return { name: String(name), records };
}

/** The receipt's lookup key, the same one the ECM lookup sends. */
export function receiptInvoiceKey(receipt) {
  return {
    customerPO: String(receipt.poNo ?? ""),
    customerPOSrNo: String(receipt.poSr ?? ""),
    invoiceQuantity: String(Number.isFinite(receipt.qty) ? receipt.qty : receipt.qtyText ?? "")
  };
}

const text = (v) => String(v ?? "").trim();
const number = (v) => {
  const t = text(v).replace(/,/g, "");
  return /^\d+(\.\d+)?$/.test(t) ? Number(t) : null;
};
/** Equal as numbers when both are numbers ("001" == "1"), else as trimmed text. */
const same = (a, b) => {
  const x = number(a);
  const y = number(b);
  return x !== null && y !== null ? x === y : text(a) !== "" && text(a).toUpperCase() === text(b).toUpperCase();
};

const describeKey = (inv) => `PO ${inv.customerPONumber ?? "?"} / Sr ${inv.customerPOSrNumber ?? "?"} / qty ${inv.quantity ?? "?"}`;

/**
 * The file's invoice for a receipt.
 * @param {{ name: string, records: object[] }} file  parseInvoiceFile()'s answer
 * @param {{ customerPO: string, customerPOSrNo: string, invoiceQuantity: string }} key  receiptInvoiceKey()
 * @returns {object} the invoice, normalised like an ECM one, source "JSON file <name>"
 */
export function invoiceFromFile(file, key) {
  if (!file || !Array.isArray(file.records)) throw invalid("choose the JSON file first");
  const source = `JSON file ${file.name}`;
  const all = file.records.map((r) => normaliseInvoice(r, source)).filter((inv) => inv.invoiceNumber);
  const label = `PO ${key.customerPO}, PO Sr ${key.customerPOSrNo}, qty ${key.invoiceQuantity}`;
  const matching = all.filter((inv) => same(inv.customerPONumber, key.customerPO) && same(inv.customerPOSrNumber, key.customerPOSrNo) && same(inv.quantity, key.invoiceQuantity));
  const fresh = matching.filter((inv) => !isSentToDoculink(inv.sentToDoculink));
  if (fresh.length === 1) return fresh[0];
  if (fresh.length > 1) {
    throw new IrepsError(BILL_ERROR.FILE_AMBIGUOUS, "several file invoices", { detail: `${fresh.length} invoices in ${file.name} match ${label} (${fresh.map((i) => i.invoiceNumber).join(", ")})` });
  }
  if (matching.length) {
    throw new IrepsError(BILL_ERROR.ECM_ALREADY_SENT, "already sent", { detail: `invoice ${matching.map((i) => i.invoiceNumber).join(", ")} in ${file.name} for ${label} is marked "Sent to Doculink"` });
  }
  const held = all.slice(0, 5).map((inv) => `${inv.invoiceNumber} (${describeKey(inv)})`).join("; ");
  throw new IrepsError(BILL_ERROR.FILE_NO_MATCH, "no file invoice", { detail: `${file.name} has no invoice for ${label}. It holds: ${held}${all.length > 5 ? ` and ${all.length - 5} more` : ""}` });
}

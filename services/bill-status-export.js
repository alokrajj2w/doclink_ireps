/**
 * Bill Status export: the parsed bills (services/bill-parser.js) handed to the
 * shared table exporter (services/search-po/search-po-export.js), so the
 * Download Bill Status workflow saves an Excel workbook like the CRN / R-NOTE
 * downloads: a "Bill Status" sheet (one row per bill, columns in BILL_FIELDS
 * order) and an "Info" sheet (source, retrieval time, filter, record count).
 *
 * Values are copied verbatim; nothing is calculated. The preview page keeps
 * its own PDF download (services/pdf-service.js).
 */

import { buildTableExport } from "./search-po/search-po-export.js";
import { BILL_FIELDS } from "./bill-parser.js";

/** Header labels + one array per bill (strings or null). */
export function billStatusTable(bills) {
  const headers = BILL_FIELDS.map((f) => f.label);
  const rows = (bills || []).map((bill) =>
    BILL_FIELDS.map((f) => {
      const v = bill[f.key];
      return v === null || v === undefined ? null : String(v);
    })
  );
  return { headers, rows };
}

/**
 * Build the export file for a parsed Bill Status result.
 *
 * @param {{ bills: object[], filter?: string, fetchedAt?: string, warnings?: string[] }} result
 * @param {{ format?: string, now?: Date }} [options]  format defaults to xlsx
 * @returns {import("./search-po/search-po-export.js").ExportFile}
 */
export function buildBillStatusExport(result, options = {}) {
  if (!result || !Array.isArray(result.bills)) throw new Error("Invalid Bill Status result");
  const { headers, rows } = billStatusTable(result.bills);
  return buildTableExport(
    {
      sheetName: "Bill Status",
      documentLabel: "Bill Status",
      sourceLabel: "IREPS - View Bills (/epsn/admin/viewBills.do)",
      headers,
      rows,
      filter: result.filter,
      fetchedAt: result.fetchedAt,
      pagesFetched: 1,
      warnings: result.warnings
    },
    { format: "xlsx", ...options }
  );
}

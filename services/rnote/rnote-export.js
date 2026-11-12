/**
 * R-NOTE export: the result table exactly as IREPS rendered it (every column
 * label of the page, in page order, from `rawColumns`), followed by the
 * document link DocLink identified in the row and any other links the row
 * carried. Handed to the shared table exporter.
 *
 * Because the real R-NOTE result layout is not captured yet, no column set is
 * hard-coded here: the headers come from the parsed page.
 */

import { buildTableExport, EXPORT_FORMAT, EXPORT_FORMATS, exportFormatInfo } from "../search-po/search-po-export.js";

export const RNOTE_EXPORT_FORMAT = EXPORT_FORMAT;
export const RNOTE_EXPORT_FORMATS = EXPORT_FORMATS;
export const rnoteExportFormatInfo = exportFormatInfo;

/** Extra columns appended after the page's own columns. */
export const RNOTE_EXTRA_COLUMNS = Object.freeze(["R-Note Document Link", "Other Links"]);

/**
 * Header labels + one array per record. Column order = the page's header
 * labels (from the first result page), then the extra link columns.
 * @param {object[]} records
 * @param {string[]} [headerLabels]   from the parser; derived from the records when omitted
 */
export function rnoteTable(records, headerLabels) {
  const list = records || [];
  // Page order first ("#" for the unlabeled serial column, "Label (n)" for a
  // repeated label, as the parser names them), then every other column any
  // record carries (cells beyond the header, later result pages), so no
  // value the page showed is left out. Action columns appear only when a
  // row had text there besides its links.
  const columns = [];
  const seen = new Set();
  const add = (label) => {
    if (seen.has(label)) return;
    seen.add(label);
    columns.push(label);
  };
  (Array.isArray(headerLabels) ? headerLabels : []).forEach((l, i) => {
    const label = l || "#";
    if (/^actions?$/i.test(label)) return;
    add(seen.has(label) ? `${label} (${i + 1})` : label);
  });
  for (const r of list) for (const k of Object.keys(r.rawColumns || {})) add(k);
  const headers = [...columns, ...RNOTE_EXTRA_COLUMNS];
  const rows = list.map((record) => {
    const raw = record.rawColumns || {};
    const cells = columns.map((label) => {
      const v = raw[label];
      return v === null || v === undefined ? null : String(v);
    });
    const docUrl = record.documentUrl || null;
    const others = (record.links || [])
      .filter((l) => l.url && l.url !== docUrl)
      .map((l) => (l.text || l.title ? `${l.text || l.title}: ${l.url}` : l.url))
      .join("\n");
    cells.push(docUrl, others || null);
    return cells;
  });
  return { headers, rows };
}

/**
 * Build the export file for an R-NOTE search result.
 *
 * @param {{ records: object[], headerLabels?: string[], filter?: string, fetchedAt?: string, pagination?: object, warnings?: string[] }} result
 * @param {{ format?: string, now?: Date }} [options]
 * @returns {import("../search-po/search-po-export.js").ExportFile}
 */
export function buildRnoteExport(result, options = {}) {
  if (!result || !Array.isArray(result.records)) throw new Error("Invalid R-NOTE search result");
  const { headers, rows } = rnoteTable(result.records, result.headerLabels);
  return buildTableExport(
    {
      sheetName: "R-NOTE",
      documentLabel: "Receipt Note (R-NOTE)",
      sourceLabel: "IREPS - PO Search (/epsn/searchPO.do, searchCriteria=RNOTE)",
      headers,
      rows,
      filter: result.filter,
      fetchedAt: result.fetchedAt,
      pagesFetched: result.pagination && result.pagination.pagesFetched,
      warnings: result.warnings
    },
    options
  );
}

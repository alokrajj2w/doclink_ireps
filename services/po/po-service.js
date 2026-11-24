/**
 * Purchase Order (PO) download: search IREPS by PO number and download the
 * PO PDF.
 *
 *   const found = await searchPo("27253922100240", { parseHtml });
 *   // -> the one PO record matching that PO number (IREPS_PO_NOT_FOUND when
 *   //    there is none), with its "Click to View/Download PO" href
 *   const result = await downloadPo("27253922100240", { parseHtml });
 *   // -> Downloads/DocLink/IREPS/PO/PO_27253922100240.pdf
 *
 * Search: the shared PO Search layer (searchIrepsDocuments) with
 * searchCriteria=PO, searchRange=3 (PO No.) - exactly the captured real
 * request (POST /epsn/searchPO.do, mode "poNumber"). IREPS returns "Total 1
 * result(s)" for a PO that exists and is visible to the logged-in vendor.
 *
 * Download: services/search-po/document-downloader.js with PO error codes.
 * Only the "Click to View/Download PO" / "View/Download PO" link is used -
 * never "Manage Your Purchase Order" (that opens Dispatch Particulars).
 *
 * downloadPo() takes a bare PO number, not a DOM element or input field, so
 * the caller (manual entry today, an automatic source later) never needs to
 * know anything about IREPS.
 */

import { IrepsError } from "../ireps-api.js";
import { SEARCH_PO_CRITERIA, errorCodesFor } from "../search-po/search-po-api.js";
import { searchIrepsDocuments, SEARCH_PO_FLOW_STAGES } from "../search-po/search-po-service.js";
import { downloadIrepsDocument } from "../search-po/document-downloader.js";
import { downloadKey, logInfo, LOG_DOC_TYPE } from "../download-log.js";
import { buildPoDownloadPath } from "../../utils/filename.js";
import { parsePoSearchResults, comparablePoNo } from "./po-parser.js";
import { ECM_KIND } from "../ecm-service.js";

/** Controlled error codes for the PO flow (mapped to UI text in utils/messages.js). */
export const PO_ERROR = Object.freeze({
  ...errorCodesFor(SEARCH_PO_CRITERIA.PO),
  LINK_NOT_FOUND: "IREPS_PO_LINK_NOT_FOUND",
  DOWNLOAD_FAILED: "IREPS_PO_DOWNLOAD_FAILED",
  INVALID_PDF: "IREPS_PO_INVALID_PDF",
  // IREPS lists the PO number for more than one railway unit: two documents, and nothing says which one is meant
  SEVERAL_UNITS: "IREPS_PO_SEVERAL_UNITS"
});
export const PO_FLOW_STAGES = SEARCH_PO_FLOW_STAGES;

const DOWNLOAD_CODES = Object.freeze({
  LINK_NOT_FOUND: PO_ERROR.LINK_NOT_FOUND,
  DOWNLOAD_FAILED: PO_ERROR.DOWNLOAD_FAILED,
  INVALID_PDF: PO_ERROR.INVALID_PDF,
  SESSION_EXPIRED: PO_ERROR.SESSION_EXPIRED
});

/** Trim and validate a PO number; throws IrepsError(IREPS_INVALID_REQUEST) when empty. */
export function normalisePoNumber(poNumber) {
  const poNo = String(poNumber || "").trim();
  if (!poNo) throw new IrepsError(PO_ERROR.INVALID_REQUEST, "PO number is required", { detail: "Please enter a PO Number." });
  return poNo;
}

/**
 * Search IREPS for one PO by number.
 *
 * @param {string} poNumber
 * @param {import("../search-po/search-po-service.js").SearchIrepsDocumentsDeps} [deps]
 *        deps.parseHtml defaults to parsePoSearchResults (needs a DOMParser)
 * @returns {Promise<import("../search-po/search-po-service.js").SearchIrepsDocumentsResult & { record: object }>}
 */
export async function searchPo(poNumber, deps = {}) {
  const poNo = normalisePoNumber(poNumber);
  const parseHtml = deps.parseHtml || ((html, o) => parsePoSearchResults(html, o));
  let result;
  try {
    result = await searchIrepsDocuments({ criteria: SEARCH_PO_CRITERIA.PO, poNo }, { ...deps, parseHtml });
  } catch (error) {
    if (error instanceof IrepsError && error.code === PO_ERROR.NOT_FOUND && !error.detail) {
      throw new IrepsError(error.code, error.message, { status: error.status, detail: poNo });
    }
    throw error;
  }
  // "Total 1 result(s)" is the normal case. Only a row of THIS PO is ever used: a row of another PO
  // (IREPS echoing unrelated rows) must never give its PDF as this PO's. Of several rows for the
  // same PO No. and unit, the first with a PDF is used and the rest are kept in `records` so callers can see them.
  const wanted = comparablePoNo(poNo);
  const matching = result.records.filter((r) => comparablePoNo(r.poNo) === wanted);
  if (matching.length === 0) {
    throw new IrepsError(PO_ERROR.NOT_FOUND, `IREPS listed ${result.records.length} PO row(s), none for PO ${poNo}`, { detail: poNo });
  }
  // the number listed for two railway units is two Purchase Orders: nothing says which one is meant (the
  // ECM's PO copy has no unit either), so none is taken, never "the first with a PDF" (1.20)
  const units = [...new Set(matching.map((r) => String(r.railwayUnit || "").trim()).filter(Boolean))];
  if (units.length > 1) {
    throw new IrepsError(PO_ERROR.SEVERAL_UNITS, `IREPS listed PO ${poNo} for ${units.length} railway units`, { detail: `${poNo} for ${units.length} railway units (${units.join(", ")})` });
  }
  const record = matching.find((r) => r.poPdfUrl) || matching[0];
  return { ...result, record };
}

/**
 * How a PO copy is filed under Save to: ECM / S3 and recorded in the download log (one rule for every PO flow).
 * `unit`: only when the same PO number was listed for more than one railway unit (PO by date), so
 * the two documents keep separate download-log records. The ECM's PO copy has no unit field.
 */
export function poFiling(poNo, { unit = null } = {}) {
  return { ecm: { kind: ECM_KIND.PO_COPY, fields: { customer_po_number: poNo } }, log: logInfo(LOG_DOC_TYPE.PO, downloadKey.po(poNo, unit)) };
}

/** Download item for one PO record. */
export function poDownloadItem(record, poNo) {
  return {
    id: record ? record.id : `po-${poNo}`,
    url: record ? record.poPdfUrl : null,
    path: buildPoDownloadPath(poNo),
    label: `PO ${poNo}`,
    meta: { poNo, poDate: record ? record.poDate : null, railwayUnit: record ? record.railwayUnit : null },
    ...poFiling(poNo)
  };
}

/**
 * Search IREPS for a PO number and download its PO PDF.
 *
 * @param {string} poNumber
 * `deps.preflight` may answer that the PO is not to be downloaded (already downloaded / in the
 * ECM): the result then has skipped: true and the reason as `skip`, and no file.
 * @param {import("../search-po/search-po-service.js").SearchIrepsDocumentsDeps & { fetch?: typeof fetch, saveFile?: Function, preflight?: Function, onSaved?: Function }} [deps]
 * @returns {Promise<{ success: true, poNumber: string, documentType: "PO", url: string, filename: string|null, downloadId: number|null, search: object, skipped?: boolean, skip?: object, warnings?: string[] }>}
 */
export async function downloadPo(poNumber, deps = {}) {
  const typed = normalisePoNumber(poNumber);
  const found = await searchPo(typed, deps);
  // filed and recorded under the PO number IREPS shows, however it was typed: "l325..." is one
  // document with IREPS's "L325...", never a second ECM document or download-log key (6.6)
  const poNo = (found.record && found.record.poNo) || typed;
  if (!found.record || !found.record.poPdfUrl) {
    throw new IrepsError(PO_ERROR.LINK_NOT_FOUND, `IREPS did not provide a PO PDF link for PO ${poNo}`, { detail: `IREPS did not provide a PO PDF link for PO ${poNo}.` });
  }
  const item = poDownloadItem(found.record, poNo);
  const checked = typeof deps.preflight === "function" ? await deps.preflight([item]) : null;
  // the search's own warnings (a row IREPS listed that could not be read, a list short of its total) go along (1.20)
  const warnings = [...new Set([...(found.warnings || []), ...((checked && checked.warnings) || [])])];
  const skip = checked && checked.skip && checked.skip.get(item.id);
  if (skip) {
    return { success: true, poNumber: poNo, documentType: "PO", url: item.url, filename: null, downloadId: null, ecm: null, search: found.search, skipped: true, skip, warnings };
  }
  const done = await downloadIrepsDocument(item, { fetch: deps.fetch, saveFile: deps.saveFile, onSaved: deps.onSaved, codes: DOWNLOAD_CODES });
  return {
    warnings,
    success: true,
    poNumber: poNo,
    documentType: "PO",
    url: item.url,
    filename: done.filename,
    downloadId: done.downloadId,
    ecm: done.ecm,
    search: found.search
  };
}

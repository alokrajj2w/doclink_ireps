/**
 * Offscreen document script.
 *
 * Receives raw IREPS HTML from the service worker, parses it with DOMParser
 * (unavailable in service workers) and returns the structured result.
 * The HTML is parsed into a detached Document; nothing from IREPS is ever
 * inserted into this page, so no IREPS script can execute.
 *
 * Parsers served:
 *   PARSE_BILL_STATUS         -> services/bill-parser.js          (viewBills.do page)
 *   PARSE_SEARCH_PO_RESULTS   -> routed by `criteria`:
 *                                PO    services/po/po-parser.js       (searchPO.do PO results)
 *                                CRN   services/crn/crn-parser.js     (searchPO.do CRN results)
 *                                RNOTE services/rnote/rnote-parser.js (searchPO.do R-NOTE results)
 *                                MA    services/ma/ma-parser.js       (searchPO.do MA results)
 *   PARSE_IC_RESULTS          -> services/inspection-certificate/ic-parser.js
 *                                (vendorInspectionCallList.do results, a different endpoint)
 *   PARSE_IREPS_ACCOUNT       -> utils/ireps-account.js (home page: which IREPS account,
 *                                and so which ECM unit, is signed in)
 */

import { parseBillStatus } from "../services/bill-parser.js";
import { parsePoSearchResults } from "../services/po/po-parser.js";
import { parseCrnSearchResults } from "../services/crn/crn-parser.js";
import { parseRnoteSearchResults } from "../services/rnote/rnote-parser.js";
import { parseMaSearchResults } from "../services/ma/ma-parser.js";
import { parseIcSearchResults } from "../services/inspection-certificate/ic-parser.js";
import { SEARCH_PO_CRITERIA } from "../services/search-po/search-po-api.js";
import { accountFromHomeDocument } from "../utils/ireps-account.js";

const SEARCH_PO_PARSERS = {
  [SEARCH_PO_CRITERIA.PO]: parsePoSearchResults,
  [SEARCH_PO_CRITERIA.CRN]: parseCrnSearchResults,
  [SEARCH_PO_CRITERIA.RNOTE]: parseRnoteSearchResults,
  [SEARCH_PO_CRITERIA.MA]: parseMaSearchResults
};
import { MESSAGE_TYPES, TARGETS } from "../utils/messages.js";
import { loadIrepsConfig } from "../services/ireps-api.js";
import { logger } from "../utils/logger.js";

/**
 * Parsers resolve relative IREPS links (e.g. "/ireps/etender/...") against
 * IREPS_CONFIG.baseUrl (config.json's target). This is a separate JS context
 * from the service worker, so config.json is read here too, before the
 * first parse call - never assumed to already be loaded.
 */
/** Answer one parse request: { ok: true, result }, or { ok: false, error: message, code } on failure. */
function answer(sendResponse, label, parse, summary) {
  loadIrepsConfig()
    .then(parse)
    .then((result) => {
      if (summary) logger.info(...summary(result));
      sendResponse({ ok: true, result });
    })
    .catch((error) => {
      logger.error(`${label} failed`, error);
      sendResponse({ ok: false, error: error && error.message ? error.message : String(error), code: (error && error.code) || null });
    });
  return true; // the answer is sent asynchronously
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== TARGETS.OFFSCREEN) return false;
  const source = { sourceUrl: message.sourceUrl || null };

  switch (message.type) {
    case MESSAGE_TYPES.PARSE_BILL_STATUS:
      return answer(sendResponse, "Parser", () => parseBillStatus(message.html, { ...source, filter: message.filter || undefined }), (r) => [
        `Bills parsed: ${r.recordCount}`,
        { structure: r.structure, blocks: r.blockCount, skipped: r.skippedCount }
      ]);
    case MESSAGE_TYPES.PARSE_SEARCH_PO_RESULTS: {
      const parser = SEARCH_PO_PARSERS[message.criteria];
      if (!parser) {
        sendResponse({ ok: false, error: `UNSUPPORTED_IREPS_SEARCH_TYPE: ${message.criteria}`, code: "UNSUPPORTED_IREPS_SEARCH_TYPE" });
        return false;
      }
      return answer(sendResponse, `${message.criteria} parser`, () => parser(message.html, { ...source, startIndex: message.startIndex || 1 }), (r) => [
        `${message.criteria} records parsed: ${r.recordCount}`,
        { structure: r.structure, rows: r.rowCount, skipped: r.skippedCount, pages: r.pagination.maxPage }
      ]);
    }
    case MESSAGE_TYPES.PARSE_IREPS_ACCOUNT:
      return answer(sendResponse, "Account parser", () => accountFromHomeDocument(new DOMParser().parseFromString(message.html || "", "text/html"), message.html || ""));
    case MESSAGE_TYPES.PARSE_IC_RESULTS:
      return answer(sendResponse, "IC parser", () => parseIcSearchResults(message.html, message.poNo || null, source), (r) => [
        `IC records parsed: ${r.recordCount}`,
        { structure: r.structure, rows: r.rowCount, filteredOut: r.filteredCount }
      ]);
    default:
      return false;
  }
});

/**
 * Bill Status retrieval service.
 *
 * Wires the IREPS request layer, the form extractor and the parser into the
 * public DocLink API:
 *
 *   const result = await fetchBillStatus({ mode: "last90Days", zone: "-1" }, deps);
 *
 * Flow (all requests use the user's authenticated browser session):
 *
 *   POST viewBills.do (empty body)  -> Bill Status page
 *   validate session                -> IREPS_SESSION_EXPIRED if not authenticated
 *   extract Struts token            -> sent when present (logged, never fatal)
 *   build "Show Results" form       -> IREPS_INVALID_REQUEST on bad options
 *   POST viewBills.do (form)        -> Bill Status results page
 *   validate response               -> retry once with a fresh token (only if the
 *                                      page had one), else IREPS_INVALID_RESPONSE
 *   parse every table#table_id      -> IREPS_PARSE_FAILED / IREPS_NO_RECORDS
 *
 * The token only ever lives in local variables of this function. The result
 * returned to callers never contains it, and the diagnostics logged here only
 * describe page structure (counts, form / hidden-field names, markers).
 *
 * Parsing needs a DOMParser, which the service worker does not have, so the
 * parser is injected (`deps.parseHtml`): the service worker passes a function
 * that forwards to the offscreen document; tests pass parseBillStatus.
 */

import {
  loadBillStatusPage,
  submitBillStatusSearch,
  buildBillStatusRequest,
  describeBillStatusRequest,
  describeBillStatusFilter,
  IREPS_ERROR,
  IrepsError
} from "./ireps-api.js";
import { validateIrepsSession } from "./session-service.js";
import { extractBillStatusForm, publicFormInfo } from "./ireps-form.js";
import { logger } from "../utils/logger.js";

/**
 * @typedef {Object} FetchBillStatusDeps
 * @property {typeof fetch} [fetch]              injectable fetch (tests)
 * @property {(html: string, options: { filter: string, sourceUrl: string|null }) => Promise<object>|object} parseHtml
 * @property {(stage: string, detail?: string) => void} [onProgress]
 * @property {import("./ireps-api.js").IrepsResponse|null} [initialPage]  reuse an already loaded page
 * @property {boolean} [noRetry]                 disable the single fresh-token retry
 */

/**
 * @typedef {Object} BillStatusFetchResult
 * @property {true} success
 * @property {{ mode: string, zone: string, dateFrom?: string, dateTo?: string }} request
 * @property {string} filter
 * @property {string} fetchedAt      ISO timestamp
 * @property {number} recordCount
 * @property {object[]} bills
 * @property {string[]} warnings
 * @property {object} form           zones / searchRange controls (no token)
 * @property {object} parsed         full parser result (bills, printableHtml, ...)
 */

/**
 * Load the page, extract the token, run the search and parse the result.
 *
 * @param {import("./ireps-api.js").BillStatusRequestOptions} [options]
 * @param {FetchBillStatusDeps} deps
 * @returns {Promise<BillStatusFetchResult>}
 */
export async function fetchBillStatus(options = {}, deps = {}) {
  if (typeof deps.parseHtml !== "function") throw new Error("fetchBillStatus requires deps.parseHtml");
  const progress = typeof deps.onProgress === "function" ? deps.onProgress : () => {};
  const requestDeps = { fetch: deps.fetch };

  // Step 1: Bill Status page (also the session check).
  progress("CHECKING_SESSION");
  let page = deps.initialPage || null;
  if (!page) page = await loadBillStatusPage(requestDeps);
  assertAuthenticated(page);
  progress("CONNECTED");

  // Step 2: dynamic Struts token + form metadata (token stays in memory only).
  // Not every IREPS deployment renders the token; the search is sent without
  // it rather than failing up front.
  let form = extractBillStatusForm(page.html);
  logger.info(`[DocLink][BillStatus] token present: ${!!form.token}`);
  logger.info(`[DocLink][BillStatus] form page structure ${JSON.stringify(describePageStructure(page.html))}`);
  let request = buildBillStatusRequest(options, form.token);
  page = null;

  // Step 3: Show Results.
  progress("FETCHING");
  logger.info("[DocLink][BillStatus] requesting /epsn/admin/viewBills.do");
  let results = await submitBillStatusSearch(request, requestDeps);
  let verdict = validateIrepsSession(results.html, results);
  logger.info("[DocLink][BillStatus] response", {
    status: results.status,
    url: pathOf(results.url),
    contentType: results.contentType,
    length: results.html.length,
    loginMarkers: verdict.code === IREPS_ERROR.SESSION_EXPIRED,
    billStatusMarkers: verdict.authenticated
  });
  logger.info(`[DocLink][BillStatus] result page structure ${JSON.stringify(describePageStructure(results.html))}`);
  if (!verdict.authenticated && verdict.code !== IREPS_ERROR.SESSION_EXPIRED && !deps.noRetry && form.token) {
    // The Struts token is single-use per page render; if the user reloaded an
    // IREPS page in another tab in between, the token was consumed. Retry once
    // with a fresh page and token.
    logger.warn("Search response not recognised; retrying once with a fresh form token");
    const fresh = await loadBillStatusPage(requestDeps);
    assertAuthenticated(fresh);
    form = extractBillStatusForm(fresh.html);
    request = buildBillStatusRequest(options, form.token);
    results = await submitBillStatusSearch(request, requestDeps);
    verdict = validateIrepsSession(results.html, results);
  }
  if (!verdict.authenticated) {
    throw new IrepsError(verdict.code, verdict.reason || "IREPS response not recognised", { status: verdict.status });
  }
  request = { ...request, body: null };

  // Step 4: parse.
  progress("PROCESSING");
  const filter = describeBillStatusFilter(options, form.zones);
  let parsed;
  try {
    parsed = await deps.parseHtml(results.html, { filter, sourceUrl: results.url || null });
  } catch (error) {
    throw new IrepsError(IREPS_ERROR.PARSE_FAILED, "Bill Status HTML could not be parsed", { cause: error });
  }
  results = null;
  logger.info(`[DocLink][BillStatus] parsed ${parsed && parsed.recordCount} rows`);
  if (!parsed || !Array.isArray(parsed.bills)) {
    throw new IrepsError(IREPS_ERROR.PARSE_FAILED, "Parser returned no result");
  }
  if (parsed.recordCount === 0) {
    if (parsed.blockCount > 0) {
      throw new IrepsError(IREPS_ERROR.PARSE_FAILED, `${parsed.blockCount} bill blocks found but none could be read`);
    }
    throw new IrepsError(IREPS_ERROR.NO_RECORDS, "IREPS returned no bill records for the selected search");
  }
  if (parsed.warnings && parsed.warnings.length) {
    logger.info(`Parser warnings: ${parsed.warnings.length}`, parsed.warnings.slice(0, 5));
  }

  return {
    success: true,
    request: describeBillStatusRequest(request),
    filter,
    fetchedAt: new Date().toISOString(),
    recordCount: parsed.recordCount,
    bills: parsed.bills,
    warnings: parsed.warnings || [],
    form: publicFormInfo(form),
    parsed
  };
}

/**
 * Structure of an IREPS page for the diagnostics log: counts, form and
 * hidden-field names, and a few text markers. Never field values (the Struts
 * token is reported only as present / absent).
 * @param {string} html
 */
export function describePageStructure(html) {
  const source = String(html || "");
  const names = (re) => Array.from(new Set(Array.from(source.matchAll(re), (m) => m[1]))).slice(0, 30);
  const text = source.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").toLowerCase();
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(source) || [])[1];
  return {
    length: source.length,
    title: title ? title.replace(/\s+/g, " ").trim().slice(0, 80) : null,
    tables: (source.match(/<table\b/gi) || []).length,
    tableIdTables: (source.match(/<table[^>]*id\s*=\s*["']?table_id/gi) || []).length,
    forms: names(/<form\b[^>]*\bname\s*=\s*["']?([\w.-]+)/gi),
    hiddenFieldNames: names(/<input\b[^>]*type\s*=\s*["']?hidden["']?[^>]*\bname\s*=\s*["']?([\w.-]+)/gi),
    hasStrutsToken: source.includes("org.apache.struts.taglib.html.TOKEN"),
    mentions: {
      contractNo: text.includes("contract no"),
      billNumber: text.includes("bill number") || text.includes("bill no"),
      noRecords: /no records? (found|available)|no data/.test(text),
      viewBillsStatus: text.includes("view bills status")
    }
  };
}

/** Path of a response URL (no query string) for the log. */
function pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

function assertAuthenticated(page) {
  const verdict = validateIrepsSession(page.html, page);
  if (!verdict.authenticated) {
    logger.warn(`[DocLink][BillStatus] page rejected: ${JSON.stringify({
      code: verdict.code,
      status: page.status,
      url: pathOf(page.url),
      redirected: !!page.redirected,
      contentType: page.contentType,
      ...describePageStructure(page.html)
    })}`);
    throw new IrepsError(verdict.code, verdict.reason || "IREPS session is not active", { status: verdict.status });
  }
}

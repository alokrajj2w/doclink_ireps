/**
 * The one Inspection Call List search loop, shared by every IC flow:
 *
 *   searchInspectionCertificates (ic-service.js)        one PO, first result page
 *   searchIcsByDate              (ic-date-service.js)   IC Date range, every page
 *   findIcRows                   (ic-notification-service.js)  PO + serial, every page
 *
 *   load vendorInspectionCallList.do -> check the session from the HTML ->
 *   read the live form + its single-use Struts token -> POST the search ->
 *   check the response -> parse -> next page with the token of the page just read
 *
 * As in the PO Search flow (services/search-po/search-po-service.js), a first
 * results page that is not recognised (the token was consumed elsewhere, e.g.
 * IREPS reloaded in another tab) is retried exactly once with a fresh page
 * and token. A session expiry is never retried.
 */

import { IrepsError } from "../ireps-api.js";
import { isIrepsLoginPage } from "../session-service.js";
import { logger } from "../../utils/logger.js";
import { loadIcListPage, submitIcSearch, buildIcPageRequest, extractIcPageCount, IC_ERROR } from "./ic-api.js";
import { extractIcForm, hasIcForm } from "./ic-form.js";

/** Validate a vendorInspectionCallList.do response and decide whether the user is authenticated. */
export function validateIcSession(html, response = {}, notRecognisedCode = IC_ERROR.LIST_PAGE_FAILED) {
  if (response.status !== undefined && response.ok === false) {
    return { authenticated: false, reason: `IREPS returned HTTP ${response.status}`, code: notRecognisedCode, status: response.status };
  }
  if (!html || html.trim().length === 0) {
    return { authenticated: false, reason: "IREPS returned an empty response", code: notRecognisedCode };
  }
  if (isIrepsLoginPage(html, response)) {
    return { authenticated: false, reason: "IREPS session expired", code: IC_ERROR.SESSION_EXPIRED };
  }
  if (hasIcForm(html)) return { authenticated: true, reason: null, code: "OK" };
  return { authenticated: false, reason: "IREPS response was not recognised as the Inspection Call List page", code: notRecognisedCode };
}

function assertIcPage(verdict, fallbackReason) {
  if (!verdict.authenticated) throw new IrepsError(verdict.code, verdict.reason || fallbackReason, { status: verdict.status });
}

const noRetry = (task) => task();

/** Load the Inspection Call List page, check the session, return the live form (with its token). */
async function openIcForm(requestDeps, retry) {
  const listPage = await retry(() => loadIcListPage(requestDeps));
  assertIcPage(validateIcSession(listPage.html, listPage), "IREPS session is not active");
  const form = extractIcForm(listPage.html);
  if (!form.token) throw new IrepsError(IC_ERROR.TOKEN_NOT_FOUND, "Struts token not found on the Inspection Call List page");
  return form;
}

async function submitChecked(request, requestDeps, retry) {
  const results = await retry(() => submitIcSearch(request, requestDeps));
  return { results, verdict: validateIcSession(results.html, results, IC_ERROR.RESULTS_INVALID) };
}

async function parsePage(parseHtml, results, parseOptions) {
  let parsed;
  try {
    parsed = await parseHtml(results.html, { sourceUrl: results.url || null, ...parseOptions });
  } catch (error) {
    throw new IrepsError(IC_ERROR.PARSE_FAILED, "IC results HTML could not be parsed", { cause: error });
  }
  if (!parsed || !Array.isArray(parsed.records)) throw new IrepsError(IC_ERROR.PARSE_FAILED, "Parser returned no result");
  return parsed;
}

/**
 * Run one IC search and hand every parsed result page to `onPage`.
 *
 * @param {object} options
 * @param {(form: object) => object} options.buildRequest   the first search request from the live form
 * @param {Function} options.parseHtml                      (html, options) => { records, warnings }
 * @param {object} [options.parseOptions]                   extra parser options (poNo ...); sourceUrl is added
 * @param {(parsed: object, page: { pageNo: number, pageCount: number }) => (boolean|void|Promise<boolean|void>)} options.onPage
 *        return false to stop after this page
 * @param {number} [options.maxPages=1]                     stop after this many pages
 * @param {() => void} [options.onPageLimit]                called when maxPages stopped a search that had more pages
 * @param {(stage: string) => void} [options.onStage]       "CONNECTED" after the session check, "SEARCHING", "PARSING"
 * @param {{ fetch?: typeof fetch, retry?: Function, noTokenRetry?: boolean }} [deps]
 *        retry wraps each request (transient network failures, services/batch-utils.js withRetry)
 * @returns {Promise<{ pages: number }>}
 */
export async function runIcSearch({ buildRequest, parseHtml, parseOptions = {}, onPage, maxPages = 1, onPageLimit, onStage = () => {} }, deps = {}) {
  const requestDeps = { fetch: deps.fetch };
  const retry = deps.retry || noRetry;

  let form = await openIcForm(requestDeps, retry);
  onStage("CONNECTED");
  onStage("SEARCHING");
  let request = buildRequest(form);
  let { results, verdict } = await submitChecked(request, requestDeps, retry);
  if (!verdict.authenticated && verdict.code !== IC_ERROR.SESSION_EXPIRED && !deps.noTokenRetry) {
    logger.warn("IC search response not recognised; retrying once with a fresh form token");
    form = await openIcForm(requestDeps, retry);
    request = buildRequest(form);
    ({ results, verdict } = await submitChecked(request, requestDeps, retry));
  }

  let pageNo = 1;
  for (;;) {
    assertIcPage(verdict, "IREPS response not recognised");
    if (pageNo === 1) onStage("PARSING");
    const parsed = await parsePage(parseHtml, results, parseOptions);
    // Re-read the page count each time: the portal only prints ~10 page links at once.
    const pageCount = extractIcPageCount(results.html);
    if ((await onPage(parsed, { pageNo, pageCount })) === false) break;
    if (pageNo >= pageCount) break;
    if (pageNo >= maxPages) {
      if (typeof onPageLimit === "function") onPageLimit();
      break;
    }
    pageNo++;
    request = buildIcPageRequest(request, extractIcForm(results.html).token, pageNo);
    ({ results, verdict } = await submitChecked(request, requestDeps, retry));
  }
  return { pages: pageNo };
}

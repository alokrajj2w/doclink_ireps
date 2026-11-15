/**
 * Download every Inspection Certificate issued in an IC Date range, for every PO.
 *
 *   const run = await runIcDateDownload({ dateFrom: "01/10/2026", dateTo: "28/10/2026" }, { parseHtml, onUpdate });
 *   // -> Downloads/DocLink/IREPS/IC/<PO>/IC_<PO>_<POSR>_<CALLID>.pdf, 3 at a time
 *
 * Search: the Inspection Call List (vendorInspectionCallList.do, Completed / IC
 * Issued) with PO No. left empty and IC Date From / To set (buildIcDateSearchRequest),
 * as a user filling in only the IC dates on the portal would. The page lists 50
 * calls of every PO at a time; each result page is followed in turn with the
 * token printed on the page just read (the Struts token is session-wide, so
 * pages are never fetched in parallel).
 *
 * The result is not trusted to be filtered: each row's IC Date is checked
 * against the range here, only IC-issued rows are kept, and rows are
 * de-duplicated on their IC PDF URL. Should IREPS ignore the IC dates, the
 * newest-first list is not read further once whole pages fall before From.
 *
 * Download: only the "View/ Download IC PDF" href IREPS printed in the row
 * (nothing is constructed); the bytes must carry a %PDF signature
 * (document-downloader.js). The download log key and the ECM fields are the
 * same as for the single-PO and notification IC downloads, so an IC already
 * downloaded by either of them is recognised.
 */

import { parseIrepsDate } from "../ireps-api.js";
import { BATCH_ITEM_STATUS, countItemStatuses, downloadStateItems, retryFailedItems } from "../batch-download.js";
import { withRetry, readDateSelection } from "../batch-utils.js";
import { buildIcDownloadPath } from "../../utils/filename.js";
import { buildIcDateSearchRequest, IC_ERROR } from "./ic-api.js";
import { runIcSearch } from "./ic-search.js";
import { parseIcSearchResults, icNumberFromUrl } from "./ic-parser.js";
import { icFiling } from "./ic-service.js";

export const IC_DATE_STATUS = BATCH_ITEM_STATUS;

const DOWNLOAD_CODES = Object.freeze({
  LINK_NOT_FOUND: IC_ERROR.LINK_NOT_FOUND,
  DOWNLOAD_FAILED: IC_ERROR.DOWNLOAD_FAILED,
  INVALID_PDF: IC_ERROR.INVALID_PDF,
  SESSION_EXPIRED: IC_ERROR.SESSION_EXPIRED
});

/** Result pages read at most (50 calls each). */
export const MAX_IC_DATE_PAGES = 200;
/** Consecutive pages with no IC on or after From after which the list is not read further. */
const OLD_PAGES_TO_STOP = 2;
const IC_ISSUED_STATUS_RE = /ic\s*issued/i;

/**
 * Validate the From / To dates. Throws IrepsError(IREPS_INVALID_REQUEST).
 * @param {string} dateFrom DD/MM/YYYY
 * @param {string} dateTo   DD/MM/YYYY
 */
export function validateIcDateSelection(dateFrom, dateTo) {
  const sel = readDateSelection(dateFrom, dateTo, IC_ERROR.INVALID_REQUEST);
  return { dateFrom: sel.dateFrom, dateTo: sel.dateTo, from: sel.from.getTime(), to: sel.to.getTime() };
}

/**
 * Search IREPS for every IC issued in the range: all result pages, IC-issued rows whose
 * IC Date is in the range, de-duplicated on the IC PDF URL.
 *
 * @param {{ dateFrom: string, dateTo: string }} options DD/MM/YYYY
 * @param {{ fetch?: typeof fetch, parseHtml?: Function, sleep?: Function, retryDelayMs?: number, onPage?: (info: object) => void }} [deps]
 * @returns {Promise<{ dateFrom: string, dateTo: string, records: object[], stats: object }>}
 */
export async function searchIcsByDate(options, deps = {}) {
  const sel = validateIcDateSelection(options.dateFrom, options.dateTo);
  const parseHtml = deps.parseHtml || ((html, opts) => parseIcSearchResults(html, null, opts));
  const retry = (task) => withRetry(task, { attempts: 3, sleep: deps.sleep, delayMs: deps.retryDelayMs });
  const stats = { pages: 0, scanned: 0, outOfRange: 0, notIssued: 0, duplicates: 0, stoppedEarly: false, pageLimit: false };
  const seen = new Set();
  const records = [];
  let oldPages = 0;

  await runIcSearch(
    {
      buildRequest: (form) => buildIcDateSearchRequest(form, { dateFromIC: sel.dateFrom, dateToIC: sel.dateTo }),
      parseHtml,
      parseOptions: { poNo: null },
      maxPages: MAX_IC_DATE_PAGES,
      onPageLimit: () => {
        stats.pageLimit = true;
      },
      onPage: (parsed, { pageNo, pageCount }) => {
        stats.pages++;
        stats.scanned += parsed.records.length;
        let reachedRange = false;
        for (const r of parsed.records) {
          const d = parseIrepsDate(r.icDate);
          if (d && d.getTime() >= sel.from) reachedRange = true;
          if (!d || d.getTime() < sel.from || d.getTime() > sel.to) {
            stats.outOfRange++;
            continue;
          }
          if (!IC_ISSUED_STATUS_RE.test(r.callStatus || "")) {
            stats.notIssued++;
            continue;
          }
          const key = r.icPdfUrl || `${r.poNo}|${r.poSerial}|${r.callId}`;
          if (seen.has(key)) {
            stats.duplicates++;
            continue;
          }
          seen.add(key);
          records.push(r);
        }
        if (typeof deps.onPage === "function") deps.onPage({ pageNo, pages: pageCount, found: records.length });
        oldPages = parsed.records.length && !reachedRange ? oldPages + 1 : 0;
        if (oldPages >= OLD_PAGES_TO_STOP) {
          stats.stoppedEarly = true;
          return false;
        }
        return true;
      }
    },
    { fetch: deps.fetch, retry }
  );
  return { dateFrom: sel.dateFrom, dateTo: sel.dateTo, records, stats };
}

/** The per-IC state items, with collision-free paths (the same Call Id with another document gets a suffix). */
export function icDateItems(records) {
  const used = new Set();
  return records.map((r, i) => {
    let path = buildIcDownloadPath(r);
    let n = 1;
    while (used.has(path)) path = buildIcDownloadPath({ ...r, callId: `${r.callId || "unknown"}_${++n}` });
    used.add(path);
    const url = r.icPdfUrl || null;
    return {
      id: `ic-${i + 1}`,
      label: `IC ${r.callId || "?"} (PO ${r.poNo || "?"} Sr. ${r.poSerial || "?"})`,
      poNo: r.poNo,
      poSerial: r.poSerial,
      callId: r.callId,
      icNumber: r.icNumber || icNumberFromUrl(url),
      icDate: r.icDate || null,
      tpiAgency: r.tpiAgency || null,
      url,
      path,
      status: url ? IC_DATE_STATUS.QUEUED : IC_DATE_STATUS.SKIPPED,
      filename: null,
      downloadId: null,
      ecm: null,
      error: url ? null : { code: IC_ERROR.LINK_NOT_FOUND, detail: "IREPS did not provide a \"View/ Download IC PDF\" link for this row" }
    };
  });
}

function summarise(state) {
  countItemStatuses(state);
  state.counts.found = state.items.length;
  state.counts.pos = new Set(state.items.map((i) => i.poNo)).size;
  return state;
}

const downloadItems = (state, items, deps) => downloadStateItems(state, items, deps, { filing: icFiling, codes: DOWNLOAD_CODES, summarise });

/**
 * Search then download. `deps.onUpdate(state)` receives the whole, current
 * state after every change (the UI is a pure view of it).
 *
 * @returns {Promise<object>} the final state
 */
export async function runIcDateDownload(options, deps = {}) {
  const sel = validateIcDateSelection(options.dateFrom, options.dateTo);
  const state = {
    kind: "ic-date",
    phase: "searching",
    dateFrom: sel.dateFrom,
    dateTo: sel.dateTo,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    counts: { found: 0, pos: 0, downloaded: 0, duplicates: 0, failed: 0, skipped: 0, inProgress: 0, outOfRange: 0, pages: 0 },
    items: [],
    warnings: [],
    sessionExpired: false
  };
  const notify = () => typeof deps.onUpdate === "function" && deps.onUpdate(summarise(state));
  notify();

  const found = await searchIcsByDate(options, {
    ...deps,
    onPage: (p) => {
      state.pageProgress = p;
      notify();
    }
  });
  state.counts.duplicates = found.stats.duplicates;
  state.counts.outOfRange = found.stats.outOfRange;
  state.counts.pages = found.stats.pages;
  if (found.stats.pageLimit) state.warnings.push(`IREPS listed more than ${MAX_IC_DATE_PAGES} result pages; only those were read. Choose a shorter date range for the rest.`);
  state.items = icDateItems(found.records);
  state.phase = "downloading";
  notify();

  await downloadItems(state, state.items.filter((i) => i.status === IC_DATE_STATUS.QUEUED), deps);
  state.phase = "complete";
  state.finishedAt = new Date().toISOString();
  notify();
  return state;
}

/**
 * Re-attempt only the failed items of a finished run; completed items are
 * never fetched again.
 * @param {object} state a state returned by runIcDateDownload()
 */
export async function retryIcDateFailures(state, deps = {}) {
  return retryFailedItems(state, deps, { download: downloadItems, summarise });
}

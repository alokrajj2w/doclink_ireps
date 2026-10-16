/**
 * Download every Purchase Order of a PO date (or date range).
 *
 *   const run = await runPoDateDownload({ dateFrom: "01/10/2026", dateTo: "15/10/2026" }, { parseHtml, onUpdate });
 *   // -> Downloads/DocLink/IREPS/PO/<YYYY-MM-DD>/PO_<PO>_<YYYY-MM-DD>.pdf, 3 at a time
 *
 * Search: the shared PO Search layer (searchIrepsDocuments) with
 * searchCriteria=PO and searchRange=2 ("Select Date"), dd/mm/yyyy, exactly
 * the live form. The portal's own script rejects a span of more than 180
 * days, so a longer selection is split into consecutive windows that are
 * searched one after the other (the Struts token is session-wide, so
 * searches are never run in parallel) and merged. Every server-side result
 * page of every window is followed by searchIrepsDocuments.
 *
 * The result is not trusted to be filtered: each row's "PO Date" is checked
 * against the selected range here, and rows are de-duplicated on PO number +
 * railway/unit + document URL.
 *
 * Download: only the href IREPS printed in the row ("Click to View/Download
 * PO"); nothing is constructed. Rows without a usable link are reported as
 * skipped with the reason. The bytes must carry a %PDF signature
 * (document-downloader.js), so a login or error page is never saved.
 */

import { IrepsError, parseIrepsDate } from "../ireps-api.js";
import { SEARCH_PO_CRITERIA, SEARCH_PO_MODE, errorCodesFor } from "../search-po/search-po-api.js";
import { searchIrepsDocuments } from "../search-po/search-po-service.js";
import { downloadIrepsDocuments, DOCUMENT_DOWNLOAD_STATUS } from "../search-po/document-downloader.js";
import { NO_RECORDS_MARKERS } from "../session-service.js";
import { buildPoDateDownloadPath } from "../../utils/filename.js";
import { splitDateRange, irepsDateToIso } from "../batch-utils.js";
import { ECM_KIND } from "../ecm-service.js";

export const PO_DATE_ERROR = Object.freeze({
  ...errorCodesFor(SEARCH_PO_CRITERIA.PO),
  LINK_NOT_FOUND: "IREPS_PO_LINK_NOT_FOUND",
  DOWNLOAD_FAILED: "IREPS_PO_DOWNLOAD_FAILED",
  INVALID_PDF: "IREPS_PO_INVALID_PDF"
});

const DOWNLOAD_CODES = Object.freeze({
  LINK_NOT_FOUND: PO_DATE_ERROR.LINK_NOT_FOUND,
  DOWNLOAD_FAILED: PO_DATE_ERROR.DOWNLOAD_FAILED,
  INVALID_PDF: PO_DATE_ERROR.INVALID_PDF,
  SESSION_EXPIRED: PO_DATE_ERROR.SESSION_EXPIRED
});

/** Item status vocabulary (the downloader's, plus "skipped" for rows with no link). */
export const PO_ITEM_STATUS = Object.freeze({ ...DOCUMENT_DOWNLOAD_STATUS, SKIPPED: "skipped" });

/** Largest selection accepted (about ten years of 180-day windows). */
export const MAX_PO_DATE_WINDOWS = 20;

/**
 * Validate the From / To dates. Throws IrepsError(IREPS_INVALID_REQUEST).
 * @param {string} dateFrom DD/MM/YYYY
 * @param {string} dateTo   DD/MM/YYYY
 */
export function validatePoDateSelection(dateFrom, dateTo) {
  const fail = (detail) => new IrepsError(PO_DATE_ERROR.INVALID_REQUEST, detail, { detail });
  const from = String(dateFrom || "").trim();
  const to = String(dateTo || "").trim();
  const dFrom = parseIrepsDate(from);
  const dTo = parseIrepsDate(to);
  if (!dFrom) throw fail("From Date must be a valid date in DD/MM/YYYY format.");
  if (!dTo) throw fail("To Date must be a valid date in DD/MM/YYYY format.");
  if (dFrom > dTo) throw fail("From Date must not be later than To Date.");
  const windows = splitDateRange(from, to);
  if (windows.length > MAX_PO_DATE_WINDOWS) throw fail(`Please select a range of at most ${MAX_PO_DATE_WINDOWS * 180} days.`);
  return { dateFrom: from, dateTo: to, windows };
}

/** Did IREPS answer a search with "nothing found" rather than with a failure? */
export function isEmptySearchError(error) {
  if (!(error instanceof IrepsError)) return false;
  if (error.code === PO_DATE_ERROR.NOT_FOUND) return true;
  if (error.code !== PO_DATE_ERROR.RESULTS_INVALID) return false;
  const text = `${error.detail || ""} ${error.message || ""}`.toLowerCase();
  return NO_RECORDS_MARKERS.some((m) => text.includes(m)) || /\bno (po|purchase order)s?\b.*\bfound\b/.test(text);
}

function dedupeKey(r) {
  return [r.poNo || "", r.railwayUnit || "", r.poPdfUrl || ""].join("|");
}

/**
 * Search IREPS for the POs of a date range and return the matching,
 * de-duplicated records.
 *
 * @param {{ dateFrom: string, dateTo: string, railway?: string, recordsPerPage?: number }} options
 * @param {import("../search-po/search-po-service.js").SearchIrepsDocumentsDeps & { onWindow?: (info: object) => void }} deps
 */
export async function searchPosByDate(options, deps = {}) {
  const { dateFrom, dateTo, windows } = validatePoDateSelection(options.dateFrom, options.dateTo);
  const from = parseIrepsDate(dateFrom).getTime();
  const to = parseIrepsDate(dateTo).getTime();
  const seen = new Set();
  const records = [];
  const searches = [];
  const stats = { windows: windows.length, fetched: 0, outOfRange: 0, duplicates: 0, pages: 0 };

  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    if (typeof deps.onWindow === "function") deps.onWindow({ index: i + 1, total: windows.length, ...w });
    let result = null;
    try {
      result = await searchIrepsDocuments(
        { criteria: SEARCH_PO_CRITERIA.PO, mode: SEARCH_PO_MODE.DATE_RANGE, dateFrom: w.dateFrom, dateTo: w.dateTo, railway: options.railway, recordsPerPage: options.recordsPerPage },
        deps
      );
    } catch (error) {
      if (!isEmptySearchError(error)) throw error;
    }
    const got = result ? result.records : [];
    searches.push({ dateFrom: w.dateFrom, dateTo: w.dateTo, count: got.length, pages: result ? result.pagination.pagesFetched : 0 });
    stats.fetched += got.length;
    stats.pages += result ? result.pagination.pagesFetched : 0;
    for (const r of got) {
      const d = parseIrepsDate(r.poDate);
      if (!d || d.getTime() < from || d.getTime() > to) {
        stats.outOfRange++;
        continue;
      }
      const key = dedupeKey(r);
      if (seen.has(key)) {
        stats.duplicates++;
        continue;
      }
      seen.add(key);
      records.push({ ...r, dateKey: irepsDateToIso(r.poDate) });
    }
  }
  return { dateFrom, dateTo, records, searches, stats };
}

/**
 * Assign every record a collision-free download path: PO number + date, then
 * + railway/unit when two different documents share that name, then a
 * numeric suffix as the last resort.
 * @param {object[]} records
 * @returns {Map<object, string>} record -> path
 */
export function assignPoDatePaths(records) {
  const plain = new Map();
  for (const r of records) {
    const p = buildPoDateDownloadPath(r);
    plain.set(p, (plain.get(p) || 0) + 1);
  }
  const used = new Set();
  const paths = new Map();
  for (const r of records) {
    let path = buildPoDateDownloadPath(r);
    if (plain.get(path) > 1) path = buildPoDateDownloadPath(r, { withUnit: true });
    let n = 1;
    let candidate = path;
    while (used.has(candidate)) candidate = buildPoDateDownloadPath(r, { withUnit: plain.get(path) > 1, suffix: ++n });
    used.add(candidate);
    paths.set(r, candidate);
  }
  return paths;
}

/** Build the per-PO state items from search records. */
export function poDateItems(records) {
  const paths = assignPoDatePaths(records);
  return records.map((r, i) => {
    const hasLink = !!r.poPdfUrl;
    return {
      id: `po-${i + 1}`,
      label: `PO ${r.poNo || "?"}`,
      poNo: r.poNo,
      poDate: r.poDate,
      railwayUnit: r.railwayUnit || null,
      poValue: r.poValue || null,
      url: r.poPdfUrl || null,
      path: paths.get(r),
      status: hasLink ? PO_ITEM_STATUS.QUEUED : PO_ITEM_STATUS.SKIPPED,
      filename: null,
      downloadId: null,
      ecm: null,
      error: hasLink ? null : { code: PO_DATE_ERROR.LINK_NOT_FOUND, detail: "IREPS did not provide a PO PDF link for this row" }
    };
  });
}

function summarise(state) {
  const count = (s) => state.items.filter((i) => i.status === s).length;
  const c = state.counts;
  c.found = state.items.length;
  c.downloaded = count(PO_ITEM_STATUS.COMPLETED);
  c.failed = count(PO_ITEM_STATUS.FAILED);
  c.skipped = count(PO_ITEM_STATUS.SKIPPED);
  c.inProgress = count(PO_ITEM_STATUS.DOWNLOADING) + count(PO_ITEM_STATUS.QUEUED);
  return state;
}

function applySnapshot(state, snapshot) {
  const byId = new Map(snapshot.items.map((s) => [s.id, s]));
  for (const item of state.items) {
    const s = byId.get(item.id);
    if (!s) continue;
    item.status = s.status;
    item.filename = s.filename;
    item.downloadId = s.downloadId;
    item.ecm = s.ecm || null;
    item.error = s.error;
  }
  state.sessionExpired = snapshot.sessionExpired === true;
}

async function downloadItems(state, items, deps) {
  const notify = () => typeof deps.onUpdate === "function" && deps.onUpdate(summarise(state));
  const batch = await downloadIrepsDocuments(
    // `ecm` says how the PO is filed under Save to: ECM / S3 (ignored by a local save)
    items.map((i) => ({ id: i.id, url: i.url, path: i.path, label: i.label, ecm: { kind: ECM_KIND.PO_COPY, fields: { customer_po_number: i.poNo } } })),
    {
      fetch: deps.fetch,
      saveFile: deps.saveFile,
      concurrency: deps.concurrency,
      retries: deps.retries ?? 2,
      retryDelayMs: deps.retryDelayMs,
      codes: DOWNLOAD_CODES,
      onProgress: (snapshot) => {
        applySnapshot(state, snapshot);
        notify();
      }
    }
  );
  applySnapshot(state, batch);
  summarise(state);
}

/**
 * Search then download. `deps.onUpdate(state)` receives the whole, current
 * state after every change (the UI is a pure view of it).
 *
 * @returns {Promise<object>} the final state
 */
export async function runPoDateDownload(options, deps = {}) {
  const sel = validatePoDateSelection(options.dateFrom, options.dateTo);
  const state = {
    kind: "po-date",
    phase: "searching",
    dateFrom: sel.dateFrom,
    dateTo: sel.dateTo,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    counts: { found: 0, downloaded: 0, duplicates: 0, failed: 0, skipped: 0, inProgress: 0, outOfRange: 0, windows: sel.windows.length },
    searches: [],
    items: [],
    sessionExpired: false
  };
  const notify = () => typeof deps.onUpdate === "function" && deps.onUpdate(summarise(state));
  notify();

  const found = await searchPosByDate(options, {
    ...deps,
    onWindow: (w) => {
      state.windowProgress = w;
      notify();
    }
  });
  state.searches = found.searches;
  state.counts.duplicates = found.stats.duplicates;
  state.counts.outOfRange = found.stats.outOfRange;
  state.counts.windows = found.stats.windows;
  state.items = poDateItems(found.records);
  state.phase = "downloading";
  notify();

  await downloadItems(state, state.items.filter((i) => i.status === PO_ITEM_STATUS.QUEUED), deps);
  state.phase = "complete";
  state.finishedAt = new Date().toISOString();
  notify();
  return state;
}

/**
 * Re-attempt only the failed items of a finished run; completed items are
 * never fetched again.
 * @param {object} state a state returned by runPoDateDownload()
 */
export async function retryPoDateFailures(state, deps = {}) {
  const retry = state.items.filter((i) => i.status === PO_ITEM_STATUS.FAILED && i.url);
  if (retry.length === 0) return state;
  for (const i of retry) {
    i.status = PO_ITEM_STATUS.QUEUED;
    i.error = null;
  }
  state.phase = "downloading";
  state.sessionExpired = false;
  state.finishedAt = null;
  await downloadItems(state, retry, deps);
  state.phase = "complete";
  state.finishedAt = new Date().toISOString();
  if (typeof deps.onUpdate === "function") deps.onUpdate(summarise(state));
  return state;
}

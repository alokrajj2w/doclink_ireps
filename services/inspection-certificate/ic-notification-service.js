/**
 * Download the Inspection Certificates named by the IREPS main-page
 * "IC issued" notifications.
 *
 *   notifications (getMyActivitesData)             services/notifications/notification-service.js
 *     -> "IC issued for PONo : <PO> , POSrNo : <SR>"  (LOA etc. ignored)
 *     -> per (PO, serial): vendorInspectionCallList.do search, Completed / IC Issued,
 *        poNo + poSr filled in the live form (fresh Struts token each time), every result page
 *     -> rows with the exact PO number, exact PO serial (leading zeros kept) and an IC-issued status
 *     -> each row's "View/ Download IC PDF" href (never constructed)
 *     -> download, verify %PDF, save under DocLink/IREPS/IC/<PO>/
 *
 * Searches run one after another because the Struts token lives in the
 * user's IREPS session: a second page load invalidates the first token.
 * Downloads run with bounded concurrency. Nothing here submits, approves,
 * withdraws or "revalidates" anything - it only reads and downloads.
 *
 * The notification's REF_ID is compared with the row's Call Id and reported
 * (`refIdMatchesCallId`) as extra verification only; it is never treated as
 * the certificate number.
 */

import { IrepsError, IREPS_ERROR } from "../ireps-api.js";
import { downloadIrepsDocuments, DOCUMENT_DOWNLOAD_STATUS } from "../search-po/document-downloader.js";
import { fetchNotifications, selectIcNotifications, NOTIFICATION_ERROR } from "../notifications/notification-service.js";
import { withRetry } from "../batch-utils.js";
import { buildIcDownloadPath } from "../../utils/filename.js";
import { loadIcListPage, submitIcSearch, buildIcSearchRequest, buildIcPageRequest, extractIcPageCount, IC_ERROR } from "./ic-api.js";
import { extractIcForm } from "./ic-form.js";
import { validateIcSession } from "./ic-service.js";
import { parseIcSearchResults } from "./ic-parser.js";

export const IC_NOTIF_STATUS = Object.freeze({ ...DOCUMENT_DOWNLOAD_STATUS, SKIPPED: "skipped", DUPLICATE: "duplicate" });

/** Per-notification outcome. */
export const NOTIFICATION_OUTCOME = Object.freeze({
  PENDING: "pending",
  MATCHED: "matched",
  UNPARSED: "unparsed", // IC-issued notification, but PO number / serial could not be read
  NOT_FOUND: "not_found", // no inspection-call row for that PO + serial
  NO_LINK: "no_link", // row(s) found, none with an IC PDF link
  ERROR: "error", // search failed (network, unreadable page...)
  SESSION_EXPIRED: "session_expired"
});

const DOWNLOAD_CODES = Object.freeze({
  LINK_NOT_FOUND: IC_ERROR.LINK_NOT_FOUND,
  DOWNLOAD_FAILED: IC_ERROR.DOWNLOAD_FAILED,
  INVALID_PDF: IC_ERROR.INVALID_PDF,
  SESSION_EXPIRED: IC_ERROR.SESSION_EXPIRED
});

/** Earliest date tried when the portal's default window finds nothing (one widening, then give up). */
export const IC_WIDE_FROM = "01/01/2015";
const MAX_PAGES = 100;
const IC_ISSUED_STATUS_RE = /ic\s*issued/i;

/**
 * Rows of a parsed result that belong to the notification: exact PO number,
 * exact PO serial, IC-issued status. Rows are annotated with whether the
 * notification REF_ID equals their Call Id.
 */
export function matchIcRows(records, { poNo, poSerial, refId }) {
  return (records || [])
    .filter((r) => r.poNo === poNo && r.poSerial === poSerial && IC_ISSUED_STATUS_RE.test(r.callStatus || ""))
    .map((r) => ({ ...r, refIdMatchesCallId: !!refId && r.callId === refId }));
}

/**
 * Search the Completed / IC Issued list for one PO + serial and return every
 * matching row of every result page.
 *
 * @param {{ poNo: string, poSerial: string, refId?: string|null }} target
 * @param {{ fetch?: typeof fetch, parseHtml?: Function, sleep?: Function, retryDelayMs?: number }} deps
 * @returns {Promise<{ rows: object[], scanned: number, pages: number, widened: boolean }>}
 */
export async function findIcRows(target, deps = {}) {
  const parseHtml = deps.parseHtml || ((html, options) => parseIcSearchResults(html, target.poNo, options));
  const retry = (task) => withRetry(task, { attempts: 3, sleep: deps.sleep, delayMs: deps.retryDelayMs });
  const requestDeps = { fetch: deps.fetch };

  const attempt = async (widen) => {
    const listPage = await retry(() => loadIcListPage(requestDeps));
    const listVerdict = validateIcSession(listPage.html, listPage);
    if (!listVerdict.authenticated) throw new IrepsError(listVerdict.code, listVerdict.reason || "IREPS session is not active", { status: listVerdict.status });
    const form = extractIcForm(listPage.html);
    if (!form.token) throw new IrepsError(IC_ERROR.TOKEN_NOT_FOUND, "Struts token not found on the Inspection Call List page");

    let request = buildIcSearchRequest(form, target.poNo, { poSerial: target.poSerial, ...(widen ? { dateFrom: IC_WIDE_FROM, dateFromIC: IC_WIDE_FROM } : {}) });
    const records = [];
    let pages = 0;
    let pageNo = 1;
    for (;;) {
      const results = await retry(() => submitIcSearch(request, requestDeps));
      const verdict = validateIcSession(results.html, results, IC_ERROR.RESULTS_INVALID);
      if (!verdict.authenticated) throw new IrepsError(verdict.code, verdict.reason || "IREPS response not recognised", { status: verdict.status });
      let parsed;
      try {
        parsed = await parseHtml(results.html, { sourceUrl: results.url || null, poNo: target.poNo });
      } catch (error) {
        throw new IrepsError(IC_ERROR.PARSE_FAILED, "IC results HTML could not be parsed", { cause: error });
      }
      if (!parsed || !Array.isArray(parsed.records)) throw new IrepsError(IC_ERROR.PARSE_FAILED, "Parser returned no result");
      records.push(...parsed.records);
      pages++;
      // Re-read the page count each time: the portal only prints ~10 page links at once.
      if (pageNo >= extractIcPageCount(results.html) || pages >= MAX_PAGES) break;
      pageNo++;
      const next = extractIcForm(results.html);
      request = buildIcPageRequest(request, next.token, pageNo);
    }
    return { records, pages };
  };

  let { records, pages } = await attempt(false);
  let rows = matchIcRows(records, target);
  let widened = false;
  if (rows.length === 0) {
    // The default window starts at the portal's own default; one wider try before reporting "not found".
    const wide = await attempt(true);
    widened = true;
    records = wide.records;
    pages += wide.pages;
    rows = matchIcRows(records, target);
  }
  return { rows, scanned: records.length, pages, widened };
}

/* -------------------------------------------------------------------------- */
/* State                                                                      */
/* -------------------------------------------------------------------------- */

function summarise(state) {
  const c = state.counts;
  const items = state.items;
  const n = (s) => items.filter((i) => i.status === s).length;
  const noteCount = (o) => state.notifications.filter((x) => x.outcome === o).length;
  c.matchedRecords = items.length + c.duplicates;
  c.downloaded = n(IC_NOTIF_STATUS.COMPLETED);
  c.failed = n(IC_NOTIF_STATUS.FAILED);
  c.skipped = n(IC_NOTIF_STATUS.SKIPPED);
  c.inProgress = n(IC_NOTIF_STATUS.QUEUED) + n(IC_NOTIF_STATUS.DOWNLOADING);
  c.unparsed = noteCount(NOTIFICATION_OUTCOME.UNPARSED);
  c.notFound = noteCount(NOTIFICATION_OUTCOME.NOT_FOUND);
  c.searchErrors = noteCount(NOTIFICATION_OUTCOME.ERROR) + noteCount(NOTIFICATION_OUTCOME.SESSION_EXPIRED);
  c.noLink = noteCount(NOTIFICATION_OUTCOME.NO_LINK);
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
    item.error = s.error;
  }
  if (snapshot.sessionExpired) state.sessionExpired = true;
}

/** The public error info stored on state objects (no stack, no cause). */
function publicError(error) {
  if (error instanceof IrepsError) return { code: error.code, detail: error.detail || null, status: error.status ?? null };
  return { code: "UNKNOWN", detail: null, status: null };
}

/** Register the rows found for one notification as download items (deduplicated by URL). */
function addRows(state, note, rows) {
  const urls = state.urlIndex;
  note.itemIds = [];
  let usable = 0;
  for (const row of rows) {
    const url = row.icPdfUrl || null;
    if (url && urls.has(url)) {
      // Same document already queued for another notification (or an earlier row).
      state.counts.duplicates++;
      const existing = urls.get(url);
      note.itemIds.push(existing.id);
      existing.notificationIds.push(note.notificationId);
      note.duplicateOf = (note.duplicateOf || []).concat(existing.id);
      usable++;
      continue;
    }
    const item = {
      id: `ic-${state.items.length + 1}`,
      label: `IC ${row.callId || "?"} (PO ${row.poNo} Sr. ${row.poSerial})`,
      notificationIds: [note.notificationId],
      poNo: row.poNo,
      poSerial: row.poSerial,
      callId: row.callId,
      icDate: row.icDate || null,
      refIdMatchesCallId: row.refIdMatchesCallId === true,
      url,
      path: null,
      status: url ? IC_NOTIF_STATUS.QUEUED : IC_NOTIF_STATUS.SKIPPED,
      filename: null,
      downloadId: null,
      error: url ? null : { code: IC_ERROR.LINK_NOT_FOUND, detail: "the matching row has no IC PDF link" }
    };
    // Collision-safe path: the same Call Id with a different document gets a numeric suffix.
    let path = buildIcDownloadPath(row);
    let n = 1;
    while (state.pathIndex.has(path)) path = buildIcDownloadPath({ ...row, callId: `${row.callId || "unknown"}_${++n}` });
    state.pathIndex.add(path);
    item.path = path;
    state.items.push(item);
    note.itemIds.push(item.id);
    if (url) {
      urls.set(url, item);
      usable++;
    }
  }
  note.outcome = usable > 0 ? NOTIFICATION_OUTCOME.MATCHED : NOTIFICATION_OUTCOME.NO_LINK;
  note.note = usable > 0 ? null : "A matching inspection-call record exists but it has no IC PDF link.";
}

async function lookupNotification(state, note, deps) {
  const key = `${note.poNo}\u0000${note.poSerial}`;
  try {
    let found = state.lookupCache.get(key);
    if (!found) {
      found = await findIcRows({ poNo: note.poNo, poSerial: note.poSerial, refId: note.refId }, deps);
      state.lookupCache.set(key, found);
    }
    // refId is per notification, so recompute the REF_ID flag on a cached lookup.
    const rows = found.rows.map((r) => ({ ...r, refIdMatchesCallId: !!note.refId && r.callId === note.refId }));
    note.scanned = found.scanned;
    note.pages = found.pages;
    if (rows.length === 0) {
      note.outcome = NOTIFICATION_OUTCOME.NOT_FOUND;
      note.note = `No completed / IC-issued inspection call matched PO ${note.poNo}, PO Sr. ${note.poSerial}${found.widened ? " (also searched back to " + IC_WIDE_FROM + ")" : ""}.`;
      note.error = null;
      return;
    }
    addRows(state, note, rows);
    note.error = null;
  } catch (error) {
    note.error = publicError(error);
    if (error instanceof IrepsError && error.code === IREPS_ERROR.SESSION_EXPIRED) {
      note.outcome = NOTIFICATION_OUTCOME.SESSION_EXPIRED;
      state.sessionExpired = true;
    } else {
      note.outcome = NOTIFICATION_OUTCOME.ERROR;
    }
    note.note = null;
  }
}

async function downloadQueued(state, deps) {
  const queued = state.items.filter((i) => i.status === IC_NOTIF_STATUS.QUEUED);
  if (queued.length === 0) return;
  const notify = () => typeof deps.onUpdate === "function" && deps.onUpdate(summarise(state));
  const batch = await downloadIrepsDocuments(
    queued.map((i) => ({ id: i.id, url: i.url, path: i.path, label: i.label })),
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
}

/**
 * Manifest rows (no cookies, tokens or headers - only identifiers and outcomes).
 * @param {object} state
 */
export function buildIcManifest(state) {
  const rows = [];
  const itemsById = new Map(state.items.map((i) => [i.id, i]));
  for (const note of state.notifications) {
    const base = { notificationId: note.notificationId, poNo: note.poNo, poSerial: note.poSerial, refId: note.refId };
    if (!note.itemIds || note.itemIds.length === 0) {
      rows.push({ ...base, callId: null, icPdfUrl: null, filename: null, outcome: note.outcome, error: note.error ? note.error.code : null, reason: note.note || (note.error && note.error.detail) || null });
      continue;
    }
    for (const id of note.itemIds) {
      const item = itemsById.get(id);
      const duplicate = (note.duplicateOf || []).includes(id);
      rows.push({
        ...base,
        callId: item.callId,
        refIdMatchesCallId: item.refIdMatchesCallId,
        icPdfUrl: item.url,
        filename: item.filename,
        outcome: duplicate ? "duplicate_skipped" : item.status,
        error: duplicate ? null : item.error ? item.error.code : null,
        reason: duplicate ? `same document as ${id}` : item.error ? item.error.detail : null
      });
    }
  }
  return rows;
}

/**
 * Notifications -> inspection-call rows -> IC PDFs.
 *
 * @param {{ fetch?: typeof fetch, parseHtml?: Function, saveFile?: Function, concurrency?: number,
 *          onUpdate?: (state: object) => void }} deps
 * @returns {Promise<object>} the final state
 */
export async function runIcNotificationDownload(deps = {}) {
  const state = {
    kind: "ic-notif",
    phase: "reading-notifications",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    sessionExpired: false,
    counts: { inspected: 0, icNotifications: 0, matchedRecords: 0, downloaded: 0, duplicates: 0, failed: 0, skipped: 0, inProgress: 0, unparsed: 0, notFound: 0, noLink: 0, searchErrors: 0 },
    notifications: [],
    items: [],
    manifest: [],
    // working indexes (not part of the public snapshot, see publicIcState)
    urlIndex: new Map(),
    pathIndex: new Set(),
    lookupCache: new Map()
  };
  const notify = () => typeof deps.onUpdate === "function" && deps.onUpdate(summarise(state));
  notify();

  const list = await fetchNotifications(deps); // throws: session expired / unreadable
  const { inspected, icNotifications } = selectIcNotifications(list);
  state.counts.inspected = inspected;
  state.counts.icNotifications = icNotifications.length;
  state.notifications = icNotifications.map((n) => ({
    ...n,
    outcome: n.poNo && n.poSerial ? NOTIFICATION_OUTCOME.PENDING : NOTIFICATION_OUTCOME.UNPARSED,
    note: n.poNo && n.poSerial ? null : "The notification is an IC-issued notice, but its PO number or PO serial number could not be read.",
    error: null,
    itemIds: []
  }));
  state.phase = "searching";
  notify();

  for (const note of state.notifications) {
    if (note.outcome !== NOTIFICATION_OUTCOME.PENDING) continue;
    if (state.sessionExpired) {
      note.outcome = NOTIFICATION_OUTCOME.SESSION_EXPIRED;
      note.error = { code: IREPS_ERROR.SESSION_EXPIRED, detail: "not attempted: IREPS session expired", status: null };
      continue;
    }
    note.outcome = NOTIFICATION_OUTCOME.PENDING;
    await lookupNotification(state, note, deps);
    notify();
  }

  state.phase = "downloading";
  notify();
  await downloadQueued(state, deps);
  return finish(state, deps);
}

function finish(state, deps) {
  state.phase = "complete";
  state.finishedAt = new Date().toISOString();
  summarise(state);
  state.manifest = buildIcManifest(state);
  if (typeof deps.onUpdate === "function") deps.onUpdate(state);
  return state;
}

/**
 * Retry what failed without repeating what succeeded: notifications whose
 * search failed (or never ran because the session expired) are searched
 * again, and failed downloads are re-fetched. Completed items are untouched.
 */
export async function retryIcNotificationFailures(state, deps = {}) {
  state.sessionExpired = false;
  state.phase = "searching";
  state.finishedAt = null;
  const notify = () => typeof deps.onUpdate === "function" && deps.onUpdate(summarise(state));
  notify();
  for (const note of state.notifications) {
    if (note.outcome !== NOTIFICATION_OUTCOME.ERROR && note.outcome !== NOTIFICATION_OUTCOME.SESSION_EXPIRED) continue;
    if (state.sessionExpired) continue;
    state.lookupCache.delete(`${note.poNo}\u0000${note.poSerial}`);
    await lookupNotification(state, note, deps);
    notify();
  }
  for (const item of state.items) {
    if (item.status === IC_NOTIF_STATUS.FAILED && item.url) {
      item.status = IC_NOTIF_STATUS.QUEUED;
      item.error = null;
    }
  }
  state.phase = "downloading";
  notify();
  await downloadQueued(state, deps);
  return finish(state, deps);
}

/** The state without its working indexes - safe to send to the popup / store. */
export function publicIcState(state) {
  const { urlIndex, pathIndex, lookupCache, ...rest } = state;
  return rest;
}

export { NOTIFICATION_ERROR };

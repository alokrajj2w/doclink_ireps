/**
 * The download half shared by the batch workflows (PO by date, IC by date, IC from
 * notifications): a run's `state.items` are fed to the generic downloader
 * (services/search-po/document-downloader.js), and every progress snapshot is copied back
 * onto the state the panel shows. Searching, item building and the per-kind counts stay in
 * each workflow.
 */

import { downloadIrepsDocuments, DOCUMENT_DOWNLOAD_STATUS } from "./search-po/document-downloader.js";

/** Status of a batch item: the downloader's statuses plus "skipped" (no link / already downloaded). */
export const BATCH_ITEM_STATUS = Object.freeze({ ...DOCUMENT_DOWNLOAD_STATUS, SKIPPED: "skipped" });

/** The status counts every batch reports (found / downloaded / failed / skipped / already downloaded / in progress). */
export function countItemStatuses(state) {
  const count = (s) => state.items.filter((i) => i.status === s).length;
  const c = state.counts;
  c.downloaded = count(BATCH_ITEM_STATUS.COMPLETED);
  c.failed = count(BATCH_ITEM_STATUS.FAILED);
  c.skipped = count(BATCH_ITEM_STATUS.SKIPPED);
  c.alreadyDownloaded = state.items.filter((i) => i.status === BATCH_ITEM_STATUS.SKIPPED && i.skip).length;
  c.inProgress = count(BATCH_ITEM_STATUS.DOWNLOADING) + count(BATCH_ITEM_STATUS.QUEUED);
  return state;
}

/**
 * Copy a downloader snapshot onto the state: each item's outcome, the warnings, and the
 * session flag. `stickySessionExpired` keeps a session expiry seen earlier in the run
 * (the notification workflow downloads in several rounds).
 */
export function applyDownloadSnapshot(state, snapshot, { stickySessionExpired = false } = {}) {
  const byId = new Map(snapshot.items.map((s) => [s.id, s]));
  for (const item of state.items) {
    const s = byId.get(item.id);
    if (!s) continue;
    item.status = s.status;
    item.filename = s.filename;
    item.downloadId = s.downloadId;
    item.ecm = s.ecm || null;
    item.error = s.error;
    item.skip = s.skip || null;
  }
  if (stickySessionExpired) {
    if (snapshot.sessionExpired) state.sessionExpired = true;
  } else {
    state.sessionExpired = snapshot.sessionExpired === true;
  }
  if (snapshot.warnings && snapshot.warnings.length) state.warnings = [...new Set([...(state.warnings || []), ...snapshot.warnings])];
}

/**
 * Download `items` (a subset of state.items) and keep the state current.
 *
 * @param {object} state
 * @param {object[]} items
 * @param {object} deps        fetch, saveFile, preflight, onSaved, concurrency, retries, retryDelayMs, onUpdate
 * @param {object} kind
 * @param {(item: object) => { ecm: object, log: object }} kind.filing   how the item is filed (ECM kind + fields) and logged
 * @param {object} kind.codes                                          the downloader's error codes for this document type
 * @param {(state: object) => object} kind.summarise                   recompute the state's counts
 * @param {boolean} [kind.stickySessionExpired]
 */
export async function downloadStateItems(state, items, deps, { filing, codes, summarise, stickySessionExpired = false }) {
  const notify = () => typeof deps.onUpdate === "function" && deps.onUpdate(summarise(state));
  const apply = (snapshot) => applyDownloadSnapshot(state, snapshot, { stickySessionExpired });
  const batch = await downloadIrepsDocuments(
    // `ecm` says how the document is filed under Save to: ECM / S3 (ignored by a local save)
    items.map((i) => ({ id: i.id, url: i.url, path: i.path, label: i.label, ...filing(i) })),
    {
      fetch: deps.fetch,
      saveFile: deps.saveFile,
      preflight: deps.preflight,
      onSaved: deps.onSaved,
      concurrency: deps.concurrency,
      retries: deps.retries ?? 2,
      retryDelayMs: deps.retryDelayMs,
      codes,
      onProgress: (snapshot) => {
        apply(snapshot);
        notify();
      }
    }
  );
  apply(batch);
  summarise(state);
}

/**
 * Re-attempt only the failed items (with a link) of a finished run; completed items are
 * never fetched again. `download(state, items, deps)` is the workflow's downloader.
 */
export async function retryFailedItems(state, deps, { download, summarise }) {
  const retry = state.items.filter((i) => i.status === BATCH_ITEM_STATUS.FAILED && i.url);
  if (retry.length === 0) return state;
  for (const i of retry) {
    i.status = BATCH_ITEM_STATUS.QUEUED;
    i.error = null;
  }
  state.phase = "downloading";
  state.sessionExpired = false;
  state.finishedAt = null;
  await download(state, retry, deps);
  state.phase = "complete";
  state.finishedAt = new Date().toISOString();
  if (typeof deps.onUpdate === "function") deps.onUpdate(summarise(state));
  return state;
}

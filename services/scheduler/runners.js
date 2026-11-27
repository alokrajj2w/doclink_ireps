/**
 * The runners of Phase 1 scheduled downloads: how one claimed slot becomes a DocLink job, and how
 * the job's end becomes the slot's outcome for the Recon Engine (done / partial / failed).
 *
 * Two kinds:
 *   - export runs (Bill Status, CRN, R-NOTE): one file, reserved and saved to S3 by saveExport;
 *   - document runs (MA, POs by date, ICs by date, ICs from notifications): many PDFs, reserved,
 *     saved to the ECM and reported by the shared hooks.
 * `start(ctx, hooks)` is the worker's launcher, adapted in background/scheduler-job.js; it answers
 * { started, error?, done } where `done` settles with
 *   export runs:   { ok, code?, detail?, summary? }   (summary.incomplete: the list was short of IREPS's total)
 *   document runs: { ok, code?, detail?, items, sessionExpired, warnings?, problems? }
 *     warnings: lists read short of IREPS's own total (one line each);
 *     problems: { doc, code, detail } of what could not be read besides the documents (a notification's
 *     IC search that failed, a notification not understood, no matching IC row).
 *
 * How a run ends:
 *   done    everything the run had to read was read and saved, or IREPS said there was nothing ("nothing new");
 *   partial something was saved, but a document failed, a row had no PDF link, a search failed, or a list was
 *           short of IREPS's own total;
 *   failed  nothing was saved and one of those happened, or the run stopped.
 * Partial and failed runs are retried at the next check; each document or list not read is named.
 *
 * The slot's result says what the run searched (`range`), why it stopped (`detail`), the first
 * documents it could not save (`failures`, `failuresMore`) and the lists not read in full (`warnings`);
 * the outcome's `log` has the full lists for this browser's run log (run-details.js).
 */

import { createSharedRunHooks } from "./shared-run-hooks.js";
import { withKey, scheduledSearch, resultFailures, failureEntry, shortText } from "./run-details.js";

/** A manual run of the same kind holds the job: the slot is given back without counting an attempt. */
const BUSY_CODES = new Set(["BUSY", "DOCUMENT_BUSY", "MA_BUSY", "BATCH_BUSY"]);
/** Settings a retry cannot fix: the slot ends as failed_final. */
const PERMANENT_CODES = new Set(["RECON_NOT_CONFIGURED", "IREPS_NOT_CONFIGURED", "SCHEDULE_NO_PERMISSION", "SCHEDULE_TYPE_NOT_SUPPORTED"]);
/** The Recon Engine keeps at most this many warnings with a slot. */
const WARNINGS_MAX = 5;

export const isSessionExpired = (code) => /SESSION_EXPIRED/.test(String(code || ""));

/** IREPS said it has no record for the search (Bill Status "No Bill Records Found", CRN / R-NOTE "not found"). */
export const isNothingFound = (code) => /^IREPS_(NO_RECORDS|[A-Z]+_NOT_FOUND)$/.test(String(code || ""));

/** The outcome of a run that ended with `code` (after `result`). */
export function failedOutcome(code, result = null) {
  const c = code || "UNKNOWN";
  if (isSessionExpired(c)) return { outcome: "failed", code: c, countsAsAttempt: false, sessionExpired: true, result };
  if (c === "RECON_AUTH_REQUIRED") return { outcome: "failed", code: c, countsAsAttempt: false, stopWake: true, result };
  if (c === "SCHEDULE_CLAIM_LOST") return { outcome: "failed", code: c, countsAsAttempt: false, stopWake: true, result };
  return { outcome: "failed", code: c, countsAsAttempt: true, permanent: PERMANENT_CODES.has(c), result };
}

function notStarted(launched) {
  const code = (launched.error && launched.error.code) || "BUSY";
  // the local job is taken (a manual run): give the slot back; the scheduler wakes when that job ends (waitForJob)
  if (BUSY_CODES.has(code)) return { outcome: "failed", code, countsAsAttempt: false, stopWake: true, waitForJob: true };
  return failedOutcome(code);
}

/** The run's range and its first failed documents, for the slot's result. */
function resultBase(ctx, failures) {
  const range = scheduledSearch(ctx && ctx.slot && ctx.slot.doc_type, ctx && ctx.params).text;
  return { ...(range ? { range } : {}), ...resultFailures(failures) };
}

/** A failed run's result, with the reason the job gave (one line). */
const withDetail = (result, detail) => (typeof detail === "string" && detail.trim() ? { ...result, detail: detail.replace(/\s+/g, " ").trim().slice(0, 200) } : result);

/** The lists a run read short of IREPS's own total, as the slot's result keeps them: short, redacted, at most 5. */
function listWarnings(list) {
  return [...new Set((Array.isArray(list) ? list : []).map(shortText).filter(Boolean))].slice(0, WARNINGS_MAX);
}

const withWarnings = (result, warnings) => (warnings.length ? { ...result, warnings } : result);

/**
 * The rows a document run listed but never fetched because IREPS gave no PDF link for them (PO by date,
 * IC by date, IC from notifications keep them as skipped, with the link error): named, so they are not
 * forgotten once the look-back has passed. A document already saved (skipped with a `skip` reason) is not one.
 */
function rowsNotFetched(items) {
  return (Array.isArray(items) ? items : [])
    .filter((i) => i && i.status === "skipped" && !i.skip && i.error && i.error.code)
    .map((i) => withKey(failureEntry({ doc: i.label || String(i.id || ""), code: i.error.code, detail: i.error.detail || null }), i.log && i.log.key));
}

/** done when nothing went wrong; partial when something was saved; failed (retried) when nothing was. */
function troubledOutcome(saved, code, result) {
  return saved > 0 ? { outcome: "partial", code, result } : failedOutcome(code, result);
}

/**
 * @param {object} deps
 * @param {object} deps.api                       services/scheduler/schedule-api.js
 * @param {Function} [deps.makeHooks]             createSharedRunHooks (tests pass a fake)
 */
export function createRunnerFactory(deps) {
  const makeHooks = deps.makeHooks || createSharedRunHooks;
  const hooksFor = (ctx) => makeHooks({ api: deps.api, claimId: ctx.claimId, account: ctx.account, isClaimLive: ctx.isClaimLive });

  /** An export run (one file to S3). */
  function exportRunner(start) {
    return async (ctx) => {
      const shared = hooksFor(ctx);
      const launched = await start(ctx, { saveExport: shared.saveExport });
      if (!launched.started) return notStarted(launched);
      const res = await launched.done;
      const stats = shared.stats();
      const details = shared.details();
      const result = { saved: stats.saved, skipped: stats.skipped, failed: stats.failed, notReported: stats.notReported, ...resultBase(ctx, details.failures) };
      // IREPS said it has no record in the range: nothing to save today, which is no failure to retry (1.11)
      if (!res.ok && isNothingFound(res.code)) return { outcome: "done", result: { ...result, records: 0 }, log: details };
      if (!res.ok) return { ...failedOutcome(res.code, withDetail(result, res.detail)), log: details };
      const s = res.summary || {};
      const saved = { ...result, records: s.recordCount ?? null, file: s.storedPath || s.filename || null };
      // the file holds fewer rows than IREPS listed: kept, said, and read again at the next check
      const warnings = listWarnings([s.incomplete]);
      if (warnings.length) return { ...troubledOutcome(stats.saved, "SCHEDULE_LIST_INCOMPLETE", withWarnings(saved, warnings)), log: details };
      return { outcome: "done", result: saved, log: details };
    };
  }

  /** A document run (PDFs to the ECM). */
  function documentRunner(start) {
    return async (ctx) => {
      const shared = hooksFor(ctx);
      const launched = await start(ctx, { documentHooks: shared.documentHooks });
      if (!launched.started) return notStarted(launched);
      const res = await launched.done;
      // always report what was saved / failed, whatever the end, so nothing is fetched twice
      const counts = await shared.finishDocuments(res.items || []);
      const details = shared.details();
      // besides the reserved documents: rows without a PDF link, and what the job could not read (named)
      const unread = [...rowsNotFetched(res.items), ...(Array.isArray(res.problems) ? res.problems : []).map(failureEntry)];
      const failures = [...details.failures, ...unread];
      const warnings = listWarnings(res.warnings);
      const result = withWarnings({ found: (res.items || []).length, saved: counts.saved, skipped: counts.skipped, failed: counts.failed + unread.length, notReported: counts.notReported, ...resultBase(ctx, failures) }, warnings);
      // every IREPS list of the range was read to its end, whatever became of its documents: the run can count as
      // this type's last successful run (run-details.js lastSuccessAfter)
      const searchedAll = res.ok && !counts.aborted && !res.sessionExpired && warnings.length === 0 && !(Array.isArray(res.problems) && res.problems.length > 0);
      const withLog = (outcome) => ({ ...outcome, ...(searchedAll ? { searchedAll: true } : {}), log: { ...details, failures } });
      if (!res.ok) return withLog(failedOutcome(res.code, withDetail(result, res.detail)));
      if (counts.aborted) return withLog(failedOutcome(counts.aborted, result));
      if (res.sessionExpired) return withLog(failedOutcome("IREPS_SESSION_EXPIRED", result));
      if (counts.failed > 0) return withLog(troubledOutcome(counts.saved, "SCHEDULE_DOWNLOAD_FAILED", result));
      if (unread.length > 0) return withLog(troubledOutcome(counts.saved, unread[0].code, result));
      if (warnings.length > 0) return withLog(troubledOutcome(counts.saved, "SCHEDULE_LIST_INCOMPLETE", result));
      return withLog({ outcome: "done", result });
    };
  }

  return { exportRunner, documentRunner };
}

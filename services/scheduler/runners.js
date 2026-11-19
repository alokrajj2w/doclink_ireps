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
 *   export runs:   { ok, code?, detail?, summary? }
 *   document runs: { ok, code?, detail?, items, sessionExpired }.
 *
 * The slot's result says what the run searched (`range`), why it stopped (`detail`) and the first
 * documents it could not save (`failures`, `failuresMore`); the outcome's `log` has the full lists for
 * this browser's run log (run-details.js).
 */

import { createSharedRunHooks } from "./shared-run-hooks.js";
import { scheduledSearch, resultFailures } from "./run-details.js";

/** A manual run of the same kind holds the job: the slot is given back without counting an attempt. */
const BUSY_CODES = new Set(["BUSY", "DOCUMENT_BUSY", "MA_BUSY", "BATCH_BUSY"]);
/** Settings a retry cannot fix: the slot ends as failed_final. */
const PERMANENT_CODES = new Set(["RECON_NOT_CONFIGURED", "IREPS_NOT_CONFIGURED", "SCHEDULE_NO_PERMISSION", "SCHEDULE_TYPE_NOT_SUPPORTED"]);

export const isSessionExpired = (code) => /SESSION_EXPIRED/.test(String(code || ""));

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
  // the local job is taken (a manual run): give the slot back; this DocLink tries again when it ends
  if (BUSY_CODES.has(code)) return { outcome: "failed", code, countsAsAttempt: false, stopWake: true };
  return failedOutcome(code);
}

/** The run's range and its first failed documents, for the slot's result. */
function resultBase(ctx, details) {
  const range = scheduledSearch(ctx && ctx.slot && ctx.slot.doc_type, ctx && ctx.params).text;
  return { ...(range ? { range } : {}), ...resultFailures(details.failures) };
}

/** A failed run's result, with the reason the job gave (one line). */
const withDetail = (result, detail) => (typeof detail === "string" && detail.trim() ? { ...result, detail: detail.replace(/\s+/g, " ").trim().slice(0, 200) } : result);

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
      const result = { saved: stats.saved, skipped: stats.skipped, failed: stats.failed, notReported: stats.notReported, ...resultBase(ctx, details) };
      if (!res.ok) return { ...failedOutcome(res.code, withDetail(result, res.detail)), log: details };
      const s = res.summary || {};
      return { outcome: "done", result: { ...result, records: s.recordCount ?? null, file: s.storedPath || s.filename || null }, log: details };
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
      const result = { found: (res.items || []).length, saved: counts.saved, skipped: counts.skipped, failed: counts.failed, notReported: counts.notReported, ...resultBase(ctx, details) };
      const withLog = (outcome) => ({ ...outcome, log: details });
      if (!res.ok) return withLog(failedOutcome(res.code, withDetail(result, res.detail)));
      if (counts.aborted) return withLog(failedOutcome(counts.aborted, result));
      if (res.sessionExpired) return withLog(failedOutcome("IREPS_SESSION_EXPIRED", result));
      if (counts.failed > 0) return withLog({ outcome: "partial", code: "SCHEDULE_DOWNLOAD_FAILED", result });
      return withLog({ outcome: "done", result });
    };
  }

  return { exportRunner, documentRunner };
}

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
 *   export runs:   { ok, code?, summary? }
 *   document runs: { ok, code?, items, sessionExpired }.
 */

import { createSharedRunHooks } from "./shared-run-hooks.js";

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
      const result = { saved: stats.saved, skipped: stats.skipped, failed: stats.failed, notReported: stats.notReported };
      if (!res.ok) return failedOutcome(res.code, result);
      const s = res.summary || {};
      return { outcome: "done", result: { ...result, records: s.recordCount ?? null, file: s.storedPath || s.filename || null } };
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
      const result = { found: (res.items || []).length, saved: counts.saved, skipped: counts.skipped, failed: counts.failed, notReported: counts.notReported };
      if (!res.ok) return failedOutcome(res.code, result);
      if (counts.aborted) return failedOutcome(counts.aborted, result);
      if (res.sessionExpired) return failedOutcome("IREPS_SESSION_EXPIRED", result);
      if (counts.failed > 0) return { outcome: "partial", code: "SCHEDULE_DOWNLOAD_FAILED", result };
      return { outcome: "done", result };
    };
  }

  return { exportRunner, documentRunner };
}

/**
 * Phase 2 scheduled downloads: tender documents. The tender code needs a page: it parses IREPS pages
 * with DOMParser, prints letters with Chrome's print-to-PDF (chrome.debugger) and runs in the side panel,
 * never in the worker. So a tender slot this DocLink has claimed runs in a background DocLink tab
 * (tender/schedule-runner.html) that the worker opens and closes:
 *
 *   worker: claim (scheduler.js) -> open the runner tab -> wait (holdWorker) -> close it -> finish
 *   tab:    READY (gets the job) -> runs the tender job with the shared-run hooks -> DONE (its outcome)
 *           PING every 20 s: is the claim still live? (the worker's heartbeat keeps it)
 *
 * The tab is closed whatever the end. A tab the user closes gives the slot back without an attempt; a run
 * that takes longer than RUNNER_TIMEOUT_MS fails (the lease would have run out anyway).
 *
 * No chrome.* here: background/scheduler-job.js passes openTab / closeTab / holdWorker, so the rules are
 * tested with fakes (test/scheduler-tests.js).
 */

import { failedOutcome } from "./runners.js";

export const RUNNER_PAGE = "tender/schedule-runner.html";
/** The longest a tender run may take before it counts as failed. */
export const RUNNER_TIMEOUT_MS = 50 * 60000;
/** How often the runner tab asks whether its claim is still live, and how stale an answer may be. */
export const RUNNER_PING_MS = 20000;
export const RUNNER_LIVE_MS = 60000;

const OUTCOMES = new Set(["done", "partial", "failed"]);
const RESULT_KEYS = ["found", "saved", "skipped", "failed", "notReported", "tenders"];

/**
 * The outcome a runner tab reported, kept to known fields: the page is DocLink's own, but what reaches
 * the Recon Engine is checked anyway.
 * @param {object} reported
 */
export function cleanOutcome(reported) {
  const r = reported && typeof reported === "object" ? reported : {};
  if (!OUTCOMES.has(r.outcome)) return { outcome: "failed", code: "SCHEDULE_TENDER_FAILED" };
  const code = typeof r.code === "string" && /^[A-Z0-9_]{1,64}$/.test(r.code) ? r.code : null;
  const result = r.result && typeof r.result === "object" ? Object.fromEntries(RESULT_KEYS.filter((k) => Number.isFinite(r.result[k])).map((k) => [k, r.result[k]])) : null;
  return {
    outcome: r.outcome,
    code,
    countsAsAttempt: r.countsAsAttempt !== false,
    permanent: r.permanent === true,
    sessionExpired: r.sessionExpired === true,
    stopWake: r.stopWake === true,
    result
  };
}

/** Tender error codes (tender/tender-core.js TenderError) -> slot codes (utils/messages.js). */
const TENDER_CODES = Object.freeze({
  SESSION_EXPIRED: "IREPS_SESSION_EXPIRED",
  ACCOUNT_CHANGED: "SCHEDULE_ACCOUNT_MISMATCH",
  ACCOUNT_MISMATCH: "SCHEDULE_ACCOUNT_MISMATCH",
  TIMEOUT: "IREPS_REQUEST_FAILED",
  UNREACHABLE: "IREPS_REQUEST_FAILED"
});

/** The slot code of a tender job's error code (a SCHEDULE_* / ECM_* code passes as it is). */
export function tenderCode(code) {
  const c = String(code || "");
  if (TENDER_CODES[c]) return TENDER_CODES[c];
  if (/^(SCHEDULE|ECM|RECON|IREPS)_[A-Z0-9_]+$/.test(c)) return c;
  return "SCHEDULE_TENDER_FAILED";
}

/** Whether a tender job's result says it stopped early ({ aborted } of the job, or of its letters / tabulations part). */
function abortedCode(result) {
  const r = result || {};
  const a = r.aborted || (r.letters && r.letters.aborted) || (r.tabulations && r.tabulations.aborted) || null;
  return a ? a.code || "SESSION_EXPIRED" : null;
}

/** Tenders a job could not handle (not found, failed): a reason to look again at the next check. */
function failedTenders(result) {
  const r = result || {};
  const s = r.summary || (r.letters && r.letters.summary) || (r.tabulations && r.tabulations.summary) || {};
  return Number.isFinite(s.failed) ? s.failed : 0;
}

/**
 * How a tender run ended, for the slot: from the job's result (or the error it threw) and the shared
 * hooks' counts (services/scheduler/shared-run-hooks.js finishTenderRun).
 * @param {{ result?: object, error?: { code?: string }|null, counts: { saved: number, skipped: number, failed: number, notReported: number, aborted: string|null } }} run
 */
export function tenderRunOutcome({ result = null, error = null, counts }) {
  const summary = { saved: counts.saved, skipped: counts.skipped, failed: counts.failed, notReported: counts.notReported };
  if (counts.aborted) return failedOutcome(counts.aborted, summary);
  const stopped = error ? error.code || "UNKNOWN" : abortedCode(result);
  if (stopped) return failedOutcome(tenderCode(stopped), summary);
  if (counts.failed > 0 || failedTenders(result) > 0) return { outcome: "partial", code: "SCHEDULE_DOWNLOAD_FAILED", result: summary };
  return { outcome: "done", result: summary };
}

/**
 * @param {object} deps
 * @param {(path: string) => Promise<number>} deps.openTab      opens the runner page in a background tab -> its id
 * @param {(tabId: number) => Promise<void>} deps.closeTab
 * @param {<T>(task: () => Promise<T>) => Promise<T>} deps.holdWorker
 * @param {{ setTimeout: Function, clearTimeout: Function }} [deps.timers]
 * @param {number} [deps.timeoutMs]
 */
export function createTenderRunner(deps) {
  const timers = deps.timers || { setTimeout, clearTimeout };
  const timeoutMs = deps.timeoutMs || RUNNER_TIMEOUT_MS;
  /** claimId -> { ctx, tabId, end(outcome) } */
  const runs = new Map();

  /** The scheduler's runner for every tender type: ctx = { slot, claimId, params, account, isClaimLive }. */
  function run(ctx) {
    return deps.holdWorker(async () => {
      let resolveEnd;
      const ended = new Promise((resolve) => {
        resolveEnd = resolve;
      });
      const entry = { ctx, tabId: null, done: false, opened: null };
      entry.end = (outcome) => {
        if (entry.done) return;
        entry.done = true;
        resolveEnd(outcome);
      };
      runs.set(ctx.claimId, entry);
      const timer = timers.setTimeout(() => entry.end({ outcome: "failed", code: "SCHEDULE_RUNNER_TIMEOUT" }), timeoutMs);
      try {
        try {
          // the page may ask for its job before openTab answers: ready() waits for this
          entry.opened = Promise.resolve(deps.openTab(`${RUNNER_PAGE}?claim=${encodeURIComponent(ctx.claimId)}`));
          entry.tabId = await entry.opened;
        } catch {
          entry.end({ outcome: "failed", code: "SCHEDULE_RUNNER_NOT_OPENED", countsAsAttempt: false, stopWake: true });
        }
        return await ended;
      } finally {
        timers.clearTimeout(timer);
        runs.delete(ctx.claimId);
        if (entry.tabId !== null) await Promise.resolve(deps.closeTab(entry.tabId)).catch(() => {});
      }
    });
  }

  return {
    run,
    /**
     * The runner tab asks for its job; nothing when the claim is not running here (a worker restart) or
     * the message does not come from the tab this run opened.
     */
    async ready(claimId, tabId) {
      const entry = runs.get(claimId);
      if (entry && entry.opened && entry.tabId === null) await entry.opened.catch(() => {});
      if (!entry || entry.done || entry.tabId !== tabId) return { ok: false };
      const { slot, params, account } = entry.ctx;
      return { ok: true, job: { claimId, docType: slot.doc_type, slotId: slot.id, params: params || {}, account } };
    },
    /** Whether the claim is still live (fresh heartbeat, not lost). */
    ping(claimId, tabId) {
      const entry = runs.get(claimId);
      return { ok: true, live: Boolean(entry && !entry.done && entry.tabId === tabId && entry.ctx.isClaimLive()) };
    },
    /** The runner tab's outcome. */
    done(claimId, outcome, tabId) {
      const entry = runs.get(claimId);
      if (!entry || entry.tabId !== tabId) return { ok: false };
      entry.end(cleanOutcome(outcome));
      return { ok: true };
    },
    /** A tab was closed: the user closed a runner tab before it finished -> the slot is given back. */
    tabRemoved(tabId) {
      for (const entry of runs.values()) {
        if (entry.tabId === tabId) entry.end({ outcome: "failed", code: "SCHEDULE_RUNNER_CLOSED", countsAsAttempt: false, stopWake: true });
      }
    },
    isRunnerTab: (tabId) => [...runs.values()].some((e) => e.tabId === tabId)
  };
}


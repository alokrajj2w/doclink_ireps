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
import { failureEntry, docEntry, resultFailures, capped, shortText, tenderCode, RESULT_FAILURES_MAX } from "./run-details.js";

export { tenderCode };

export const RUNNER_PAGE = "tender/schedule-runner.html";
/** The longest a tender run may take before it counts as failed. */
export const RUNNER_TIMEOUT_MS = 50 * 60000;
/** How often the runner tab asks whether its claim is still live, and how stale an answer may be. */
export const RUNNER_PING_MS = 20000;
export const RUNNER_LIVE_MS = 60000;

const OUTCOMES = new Set(["done", "partial", "failed"]);
const RESULT_KEYS = ["found", "saved", "skipped", "failed", "notReported", "tenders", "failuresMore"];
const WARNINGS_MAX = 5;

/** The run log's lists from a runner tab, each entry rebuilt by run-details.js (short, redacted). */
function cleanLog(log) {
  const l = log && typeof log === "object" ? log : {};
  const list = (items, clean) => capped(Array.isArray(items) ? items.filter((x) => x && typeof x === "object") : []).map(clean);
  return {
    failures: list(l.failures, failureEntry),
    saved: list(l.saved, (d) => docEntry(d.doc, d.note)),
    skipped: list(l.skipped, (d) => docEntry(d.doc, d.note)),
    more: Object.fromEntries(["failures", "saved", "skipped"].filter((k) => l.more && Number.isFinite(l.more[k]) && l.more[k] > 0).map((k) => [k, l.more[k]]))
  };
}

/**
 * The outcome a runner tab reported, kept to known fields: the page is DocLink's own, but what reaches
 * the Recon Engine is checked anyway.
 * @param {object} reported
 */
export function cleanOutcome(reported) {
  const r = reported && typeof reported === "object" ? reported : {};
  if (!OUTCOMES.has(r.outcome)) return { outcome: "failed", code: "SCHEDULE_TENDER_FAILED" };
  const code = typeof r.code === "string" && /^[A-Z0-9_]{1,64}$/.test(r.code) ? r.code : null;
  let result = null;
  if (r.result && typeof r.result === "object") {
    result = Object.fromEntries(RESULT_KEYS.filter((k) => Number.isFinite(r.result[k])).map((k) => [k, r.result[k]]));
    for (const k of ["range", "detail"]) if (shortText(r.result[k])) result[k] = shortText(r.result[k]);
    if (Array.isArray(r.result.failures) && r.result.failures.length) result.failures = r.result.failures.slice(0, RESULT_FAILURES_MAX).map(failureEntry);
    const warnings = Array.isArray(r.result.warnings) ? r.result.warnings.map(shortText).filter(Boolean).slice(0, WARNINGS_MAX) : [];
    if (warnings.length) result.warnings = warnings;
  }
  return {
    outcome: r.outcome,
    code,
    countsAsAttempt: r.countsAsAttempt !== false,
    permanent: r.permanent === true,
    sessionExpired: r.sessionExpired === true,
    stopWake: r.stopWake === true,
    result,
    ...(r.log ? { log: cleanLog(r.log) } : {})
  };
}

/**
 * The code a tender job stopped with: its error's, else the { aborted } of the job or of its letters /
 * tabulations part; null when it ran to the end.
 * @param {object|null} result
 * @param {{ code?: string }|null} [error]
 */
export function stoppedCode(result, error = null) {
  if (error) return error.code || "UNKNOWN";
  const a = abortedOf(result);
  return a ? a.code || "SESSION_EXPIRED" : null;
}

/** The { aborted } of a tender job's result, or of its letters / tabulations part. */
function abortedOf(result) {
  const r = result || {};
  return r.aborted || (r.letters && r.letters.aborted) || (r.tabulations && r.tabulations.aborted) || null;
}

/** Why the job stopped early, in its own words ("" when it did not). */
const abortedMessage = (result) => (abortedOf(result) && abortedOf(result).message) || "";

/** Tenders a job could not handle (not found, failed): a reason to look again at the next check. */
function failedTenders(result) {
  const r = result || {};
  const s = r.summary || (r.letters && r.letters.summary) || (r.tabulations && r.tabulations.summary) || {};
  return Number.isFinite(s.failed) ? s.failed : 0;
}

/**
 * How a tender run ended, for the slot: from the job's result (or the error it threw) and the shared
 * hooks' counts and lists (services/scheduler/shared-run-hooks.js finishTenderRun / details). The slot's
 * result carries the searched `range`, the stop reason (`detail`) and the first failed documents; the
 * outcome's `log` carries the full lists for this browser's run log.
 * @param {{ result?: object, error?: { code?: string, message?: string }|null, range?: string,
 *           counts: { saved: number, skipped: number, failed: number, notReported: number, aborted: string|null },
 *           details?: { failures: object[], saved: object[], skipped: object[] } }} run
 */
export function tenderRunOutcome({ result = null, error = null, counts, range = "", details = null }) {
  const summary = { saved: counts.saved, skipped: counts.skipped, failed: counts.failed, notReported: counts.notReported, ...(range ? { range } : {}), ...resultFailures(details && details.failures) };
  const withLog = (outcome) => (details ? { ...outcome, log: details } : outcome);
  if (counts.aborted) return withLog(failedOutcome(counts.aborted, summary));
  const stopped = stoppedCode(result, error);
  const detail = shortText(error ? error.message : stopped && abortedMessage(result));
  if (stopped) return withLog(failedOutcome(tenderCode(stopped), detail ? { ...summary, detail } : summary));
  if (counts.failed > 0 || failedTenders(result) > 0) return withLog({ outcome: "partial", code: "SCHEDULE_DOWNLOAD_FAILED", result: summary });
  return withLog({ outcome: "done", result: summary });
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
  // wrapped: Chrome throws "Illegal invocation" when its timer functions are called as methods of another object
  const timers = deps.timers || { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) };
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


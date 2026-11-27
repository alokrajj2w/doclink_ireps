/**
 * Phase 2 scheduled downloads: tender documents. The tender code needs a page: it parses IREPS pages
 * with DOMParser, prints letters with Chrome's print-to-PDF (chrome.debugger) and runs in the side panel,
 * never in the worker. So a tender slot this DocLink has claimed runs in a background DocLink tab
 * (tender/schedule-runner.html) that the worker opens and closes:
 *
 *   worker: claim (scheduler.js) -> open the runner tab -> wait (holdWorker) -> close it -> finish
 *   tab:    READY (gets the job) -> runs the tender job with the shared-run hooks -> DONE (its outcome)
 *           PING every 20 s, and again before an upload when the last answer is older: is the claim still
 *           live? (the worker's heartbeat keeps it; createClaimWatch)
 *
 * The tab is closed whatever the end. A tab the user closes gives the slot back without an attempt; a run
 * that takes longer than RUNNER_TIMEOUT_MS fails (the lease would have run out anyway).
 *
 * No chrome.* here: background/scheduler-job.js passes openTab / closeTab / holdWorker, so the rules are
 * tested with fakes (test/scheduler-tests.js).
 */

import { failedOutcome } from "./runners.js";
import { failureEntry, docEntry, withKey, resultFailures, capped, shortText, tenderCode, seenList, RESULT_FAILURES_MAX } from "./run-details.js";

export { tenderCode };

export const RUNNER_PAGE = "tender/schedule-runner.html";
/** The longest a tender run may take before it counts as failed. */
export const RUNNER_TIMEOUT_MS = 50 * 60000;
/**
 * The runner tab and its claim (5.7). The worker answers a PING from its heartbeat (scheduler.js): "live" only while
 * its last heartbeat got through less than LEASE_MS - HEARTBEAT_MS ago (8 of the lease's 10 minutes), so at that
 * moment the lease has at least HEARTBEAT_MS (2 minutes) left. The tab asks every RUNNER_PING_MS, but Chrome
 * throttles the timers of a hidden tab: once it has been hidden for 5 minutes they fire at most once a minute,
 * aligned to the minute, and later still while the page is busy. A timer-fed answer can so be more than a minute old,
 * and a run that trusted only its timer would stop as CLAIM_LOST with its claim alive. So before an upload the tab
 * asks again whenever its last answer is older than RUNNER_PING_MS (a message, which no timer throttling delays), and
 * an answer counts for RUNNER_LIVE_MS at most (a worker that does not answer the new question). An answer a run
 * relies on is thus at most 1 minute old: the lease still has at least 1 minute left, also when every heartbeat failed
 * for 8 minutes; with the heartbeats getting through, 7 minutes or more.
 */
export const RUNNER_PING_MS = 20000;
export const RUNNER_LIVE_MS = 60000;

/**
 * The runner tab's view of its claim (tender/schedule-runner.js), see RUNNER_PING_MS.
 *   refresh(): ask the worker now (one question at a time); the interval of the tab calls it too.
 *   isClaimLive(): async; asks first when the last answer is older than RUNNER_PING_MS, waiting for the answer up to
 *   RUNNER_PING_MS (`wait`), then true only for a "live" answer younger than RUNNER_LIVE_MS.
 * The claim counts as live when the watch starts: the worker opened the tab for a claim it held.
 * @param {{ ask: () => Promise<{ live?: boolean }|null>, now?: () => number, wait?: (ms: number) => Promise<void> }} deps
 */
export function createClaimWatch({ ask, now = () => Date.now(), wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  let last = { live: true, at: now() };
  let asking = null;
  function refresh() {
    asking = asking || Promise.resolve()
      .then(ask)
      .then((answer) => {
        last = { live: Boolean(answer && answer.live), at: now() };
      }, () => {
        /* no answer: the last one ages out (RUNNER_LIVE_MS) */
      })
      .finally(() => {
        asking = null;
      });
    return asking;
  }
  async function isClaimLive() {
    if (now() - last.at >= RUNNER_PING_MS) await Promise.race([refresh(), wait(RUNNER_PING_MS)]);
    return last.live && now() - last.at < RUNNER_LIVE_MS;
  }
  return { refresh, isClaimLive };
}

const OUTCOMES = new Set(["done", "partial", "failed"]);
const RESULT_KEYS = ["found", "saved", "skipped", "failed", "notReported", "tenders", "failuresMore"];
const WARNINGS_MAX = 5;

/**
 * The run log's lists from a runner tab, each entry rebuilt by run-details.js (short, redacted, with its document key),
 * and what IREPS listed to the run (`seen`, for document-ledger.js), rebuilt the same way.
 */
function cleanLog(log) {
  const l = log && typeof log === "object" ? log : {};
  const list = (items, clean) => capped(Array.isArray(items) ? items.filter((x) => x && typeof x === "object") : []).map(clean);
  return {
    failures: list(l.failures, (f) => withKey(failureEntry(f), f.key)),
    saved: list(l.saved, (d) => withKey(docEntry(d.doc, d.note), d.key)),
    skipped: list(l.skipped, (d) => withKey(docEntry(d.doc, d.note), d.key)),
    more: Object.fromEntries(["failures", "saved", "skipped"].filter((k) => l.more && Number.isFinite(l.more[k]) && l.more[k] > 0).map((k) => [k, l.more[k]])),
    seen: seenList(l.seen)
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
    ...(r.searchedAll === true ? { searchedAll: true } : {}),
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

/** Failed items a job counted (its summary's `failed`): a reason to look again at the next check. */
function failedTenders(result) {
  const r = result || {};
  const s = r.summary || (r.letters && r.letters.summary) || (r.tabulations && r.tabulations.summary) || {};
  return Number.isFinite(s.failed) ? s.failed : 0;
}

/** The code of a document DocLink did not download because it could not match it safely (needs review). */
const NEEDS_REVIEW = "SCHEDULE_NEEDS_REVIEW";
/** How the tender views name a job's categories (tender/tender-ui.js), for the run's lists. */
const CATEGORY_LABEL = Object.freeze({
  tenderPdf: "NIT", attachments: "NIT attachments", myOffer: "My Offer", corrigenda: "Corrigenda", negotiation: "Negotiation letter",
  counterOffer: "Counter Offer letter", loa: "LOA", correspondence: "Correspondence", financialTabulation: "Financial Tabulation", commercialTabulation: "Commercial Tabulation"
});
const LIST_LABEL = Object.freeze({ MyNegotiation: "Negotiation letter list", MyCounterOffer: "Counter Offer letter list", MyAdvanceAcceptanceLetter: "LOA letter list" });

/** Whether a run-list name ("Tender 123 - LOA letter 9", "Tender 123 LOA 9") is one of tender `tenderNo`'s documents. */
const ofTender = (doc, tenderNo) => {
  const head = `Tender ${tenderNo}`;
  return doc === head || String(doc).startsWith(`${head} `);
};

/**
 * What a tender job could not do beyond the documents the shared hooks already name (`known`, their
 * details().failures): the tenders, categories, messages and correspondence records it could not handle
 * (`failures`), the IREPS lists it could not read to their end (`lists`, said in `warnings`), the documents it
 * could not match safely (`review`, listed with SCHEDULE_NEEDS_REVIEW) and its notes (`warnings`).
 * A category failure the hooks already named (the same tender, the same reason) is not listed twice.
 * @param {object|null} result   the tender job's result (NIT, letters, tabulations or correspondence)
 * @param {object[]} [known]
 * @returns {{ failures: object[], warnings: string[], lists: number, review: number }}
 */
export function tenderJobProblems(result, known = []) {
  const failures = [];
  const listWarnings = [];
  const otherWarnings = [];
  let review = 0;
  const pool = (Array.isArray(known) ? known : []).map((k) => ({ doc: String((k && k.doc) || ""), detail: (k && k.detail) || null, used: false }));
  /** whether the hooks named a document of the tender with this reason (null: any reason); each is matched once */
  const namedAlready = (tenderNo, detail) => {
    const hit = pool.find((k) => !k.used && ofTender(k.doc, tenderNo) && (detail === null || k.detail === detail));
    if (hit) hit.used = true;
    return Boolean(hit);
  };
  const fail = (entry) => failures.push(failureEntry(entry));
  const needsReview = (doc, detail) => {
    review++;
    fail({ doc, code: NEEDS_REVIEW, detail });
  };
  const r = result && typeof result === "object" ? result : {};
  const blankDates = [];
  for (const part of [r, r.letters, r.tabulations].filter((p) => p && typeof p === "object")) {
    for (const t of Array.isArray(part.tenders) ? part.tenders : []) {
      if (!t || typeof t !== "object") continue;
      const no = String(t.tenderNo || "?");
      // the tender as a whole: not found, not opened, or not reached after the run stopped
      if (t.error && t.status !== "ALREADY_DOWNLOADED") fail({ doc: `Tender ${no}`, code: tenderCode(t.code, "SCHEDULE_TENDER_FAILED"), detail: t.error });
      for (const [key, c] of Object.entries(t.categories || {})) {
        if (!c || (c.status !== "FAILED" && c.status !== "PARTIAL")) continue;
        const doc = `Tender ${no} - ${CATEGORY_LABEL[key] || key}`;
        const files = (Array.isArray(c.files) ? c.files : []).filter((f) => f && f.status === "FAILED");
        for (const f of files) {
          const entry = failureEntry({ doc, code: tenderCode(f.code, "SCHEDULE_DOWNLOAD_FAILED"), detail: f.error || c.note });
          if (!namedAlready(no, entry.detail)) failures.push(entry);
        }
        // failed without a failed file (an attachment of a saved document): named unless the hooks named one
        if (!files.length && c.failed > 0 && !namedAlready(no, null)) {
          fail({ doc, code: "SCHEDULE_DOWNLOAD_FAILED", detail: c.note || (Array.isArray(c.warnings) && c.warnings[0]) || `${c.failed} document(s) not downloaded` });
        }
      }
      if (t.tenderDateProblem) blankDates.push(no);
    }
    for (const [status, message] of Object.entries(part.listErrors || {})) listWarnings.push(`${LIST_LABEL[status] || status}: ${message}`);
    for (const [status, message] of Object.entries(part.listWarnings || {})) listWarnings.push(`${LIST_LABEL[status] || status}: ${message}`);
    if (part.incomplete) listWarnings.push(String(part.incomplete));
    const messages = part.messages && typeof part.messages === "object" ? part.messages : null;
    if (messages && (messages.incomplete || messages.truncated)) listWarnings.push(`My Messages was not read to the end: ${messages.incomplete || "DocLink stopped at its page limit, so older messages were not read"}`);
    // NIT Documents: a message IREPS did not open is a failure (the next check opens it again)
    for (const m of Array.isArray(part.failedMessages) ? part.failedMessages : []) {
      fail({ doc: `Message of ${m.sentDate || "?"}${m.subject ? `: ${m.subject}` : ""}`, code: tenderCode(m.code, "SCHEDULE_DOWNLOAD_FAILED"), detail: m.reason });
    }
    if (Array.isArray(part.review) && part.review.length) otherWarnings.push(`${part.review.length} IREPS message(s) could not be matched to a tender: open NIT Documents in the panel to review them.`);
    // Correspondence: records it could not read, and letters / records / rows it could not match safely
    for (const f of Array.isArray(part.failedRecords) ? part.failedRecords : []) {
      fail({ doc: `Correspondence of tender ${f.tenderNo || "?"}`, code: tenderCode(f.code, "SCHEDULE_DOWNLOAD_FAILED"), detail: f.error });
    }
    for (const x of Array.isArray(part.needsReview) ? part.needsReview : []) {
      needsReview(x.letterNo ? `Tender ${x.tenderNo || "?"} - letter ${x.letterNo}` : `Correspondence of tender ${x.tenderNo || "?"}`, x.reason);
    }
    for (const n of Array.isArray(part.notes) ? part.notes : []) if (typeof n === "string" && n) otherWarnings.push(n);
  }
  if (blankDates.length) otherWarnings.push(`The ECM tender date was left blank for ${blankDates.length > 1 ? "tenders" : "tender"} ${blankDates.join(", ")}: IREPS's tender search did not answer.`);
  return { failures, warnings: [...listWarnings, ...otherWarnings], lists: listWarnings.length, review };
}

/**
 * How a tender run ended, for the slot: from the job's result (or the error it threw) and the shared
 * hooks' counts and lists (services/scheduler/shared-run-hooks.js finishTenderRun / details).
 *   done:    everything the run had to read was read and saved (or skipped as already saved), or IREPS
 *            listed nothing;
 *   partial: something was saved, but a document, a tender, a list page or a letter failed, was not read,
 *            or needs review;
 *   failed:  nothing was saved and something failed; and a run that stopped (its error's code), unless it
 *            saved something first and the stop is one to retry (then partial with that code).
 * Every failure is named in `failures` (documents, tenders, messages, records) or `warnings` (lists not read
 * in full, notes), so "Partly done" always says why. The slot's result carries the searched `range`, the
 * stop reason (`detail`) and the first failures; the outcome's `log` carries the full lists for this
 * browser's run log. `searchedAll` (a run that did not stop, read every list to its end and named every
 * document it did not save) lets the run count as the type's last successful run (run-details.js lastSuccessAfter).
 * @param {{ result?: object, error?: { code?: string, message?: string }|null, range?: string,
 *           counts: { saved: number, skipped: number, failed: number, notReported: number, aborted: string|null },
 *           details?: { failures: object[], saved: object[], skipped: object[], more?: object } }} run
 */
export function tenderRunOutcome({ result = null, error = null, counts, range = "", details = null }) {
  const known = (details && Array.isArray(details.failures) && details.failures) || [];
  const problems = tenderJobProblems(result, known);
  const failures = [...known, ...problems.failures];
  const moreFailures = Number((details && details.more && details.more.failures) || 0);
  const listed = resultFailures(failures);
  const summary = {
    saved: counts.saved, skipped: counts.skipped, failed: counts.failed + problems.failures.length, notReported: counts.notReported,
    ...(range ? { range } : {}), ...listed,
    ...(listed.failures && moreFailures ? { failuresMore: (listed.failuresMore || 0) + moreFailures } : {}),
    ...(problems.warnings.length ? { warnings: problems.warnings } : {})
  };
  const log = details ? { ...details, failures } : problems.failures.length ? { failures, saved: [], skipped: [], more: {} } : null;
  const withLog = (outcome) => (log ? { ...outcome, log } : outcome);
  // a run that stopped after it saved something is partial, retried as a failed one would be; a stop that
  // must not count as an attempt (expired session, lost claim, Recon sign-in) or that a retry cannot fix stays failed
  const stoppedWith = (code, stopResult) => {
    const failed = failedOutcome(code, stopResult);
    return counts.saved > 0 && failed.countsAsAttempt && !failed.permanent ? withLog({ outcome: "partial", code: failed.code, result: stopResult }) : withLog(failed);
  };
  if (counts.aborted) return stoppedWith(counts.aborted, summary);
  const stopped = stoppedCode(result, error);
  const detail = shortText(error ? error.message : stopped && abortedMessage(result));
  if (stopped) return stoppedWith(tenderCode(stopped), detail ? { ...summary, detail } : summary);
  const docsFailed = counts.failed > 0 || problems.failures.some((f) => f.code !== NEEDS_REVIEW) || failedTenders(result) > 0;
  const code = docsFailed ? "SCHEDULE_DOWNLOAD_FAILED" : problems.lists > 0 ? "SCHEDULE_LIST_INCOMPLETE" : problems.review > 0 ? NEEDS_REVIEW : null;
  // every IREPS list of the range was read to its end, and every document not saved is named: the run can count
  // as this type's last successful run (run-details.js lastSuccessAfter)
  const searched = (outcome) => (problems.lists === 0 && !(docsFailed && !summary.failures) ? { ...outcome, searchedAll: true } : outcome);
  if (!code) return withLog(searched({ outcome: "done", result: summary }));
  // never "Partly done" without a reason: a failure the job counted but did not name is said in a line
  const said = summary.failures || summary.warnings ? summary : { ...summary, warnings: ["Some documents of this download were not saved, and DocLink could not tell which: run it from the DocLink panel to see them."] };
  return counts.saved > 0 ? withLog(searched({ outcome: "partial", code, result: said })) : withLog(searched(failedOutcome(code, said)));
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


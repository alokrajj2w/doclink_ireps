/**
 * The scheduler of Phase 1 shared downloads (plan section 8.4): wakes on an alarm, an IREPS page
 * load or a panel nudge, asks the Recon Engine what is due for this IREPS account, and - when this
 * DocLink may - claims one slot, checks IREPS once, runs it, and reports how it ended.
 *
 * The order of checks never contacts IREPS before this DocLink has won a claim, and never on a
 * timer: Recon sign-in -> known account -> due? -> nothing running locally -> recent IREPS activity
 * -> claim -> ONE IREPS check -> run. Twenty DocLinks waking at 09:00 send one IREPS request in
 * total (the winner's). Only one slot of an account runs at a time; the rest follow one by one, on
 * that check while it is younger than ACCOUNT_CHECK_MS, else each after a check of its own.
 *
 * No chrome.* here: the wiring (background/scheduler-job.js) passes the API, the local signals,
 * the runners, the alarm, the clock and the run log, so every rule is tested with fakes
 * (test/scheduler-tests.js).
 *
 * Every decision that leaves a due slot unrun (waiting for an IREPS page, a manual run, the Recon
 * Engine; another DocLink running the account; a claim given back) is written to this browser's run
 * log and the DocLink log, in plain words, with the types it concerns. Each run's start and end go to
 * the run log too, with every document it could not save and why.
 */

import { SCHEDULE_TYPES, SCHEDULE_TYPE_LABEL } from "./schedule-types.js";
import { scheduledSearch, fitResult, limitedParams, MAX_LOOKBACK } from "./run-details.js";
import { describeError } from "../../utils/messages.js";
import { logger } from "../../utils/logger.js";

export const HEARTBEAT_MS = 120000;
export const LEASE_MS = 600000;
/** Triggers closer together than this make one wake (an alarm always wakes). */
export const DEBOUNCE_MS = 15000;
/** Another DocLink runs this account's slot: look again this soon (the backend only, never IREPS). */
export const RUNNING_POLL_MS = 150000;
/** No Recon sign-in, no permission, no account or no backend: look again this soon. */
export const IDLE_RECHECK_MS = 30 * 60000;
/** Alarms get up to this much random delay, so DocLinks do not all call at the same second. */
export const JITTER_MS = 30000;
/** Slots run one after the other in one wake; this many at most. */
const MAX_SLOTS_PER_WAKE = 10;
/**
 * How long one IREPS account check covers the slots that follow it in a wake (5.6). A run can take an
 * hour, and an IREPS account switched in the meantime must never get another account's downloads: past
 * this, the next slot is checked again after its claim, like the first one. Two minutes: slots that end at
 * once (nothing new to download) still share one check. The next slot needs no new page load: it is checked
 * at once while IREPS was logged in here and no check found it logged out since (local-signals.js irepsReady).
 */
export const ACCOUNT_CHECK_MS = 2 * 60000;

export const RUN_PERMISSION = "doclink.schedule.run";
export const MANAGE_PERMISSION = "doclink.schedule.manage";

/** Backend answers that mean "not this slot, try the next one". */
const NEXT_SLOT = new Set(["SCHEDULE_SLOT_DONE", "SCHEDULE_NOT_DUE", "SCHEDULE_SLOT_NOT_FOUND"]);
/** Backend answers that mean "another DocLink runs this account now". */
const SOMEONE_ELSE = new Set(["SCHEDULE_ACCOUNT_BUSY", "SCHEDULE_SLOT_TAKEN"]);

/**
 * Types whose run takes long, run after every other due slot. The account runs one slot at a time, and a tabulation
 * run reads every closing day of its look-back from IREPS Search Tender (25 Nov 2026: 43 minutes for 15 days), so
 * run first it held back Correspondence and Negotiation past their window. The Schedule view keeps SCHEDULE_TYPES'
 * order; only the run order changes.
 */
export const RUN_LAST = Object.freeze(["tenderTabulations"]);
/** The order due slots run in: SCHEDULE_TYPES' order, RUN_LAST types after all the others. */
const order = (slot) => (RUN_LAST.includes(slot.doc_type) ? SCHEDULE_TYPES.length : 0) + SCHEDULE_TYPES.indexOf(slot.doc_type);
const labelOf = (type) => SCHEDULE_TYPE_LABEL[type] || type;
/** Failed documents written one per line to the DocLink log for a run (the run log keeps them all). */
const LOGGED_FAILURES_MAX = 50;
/** No run log: the scheduler still runs (tests, or a storage that cannot be written). */
const NO_RUN_LOG = Object.freeze({ event: () => {}, runStarted: () => {}, runFinished: () => {} });

/** "RECON_UNAVAILABLE: could not reach ..." -> "Recon Engine unavailable (could not reach ...)". */
const problemText = (code, detail) => `${describeError(code).title}${detail ? ` (${detail})` : ""}`;

/**
 * IREPS did not answer the account check (an HTTP error, a timeout, a busy page): that is no logout,
 * so the next check (alarm or page load) tries again instead of waiting for a new IREPS page load.
 */
const irepsAnswersLater = (code) => code === "IREPS_UNAVAILABLE";

/** Why the IREPS check failed, for the Schedule view: only IREPS's login page is "not logged in". */
const irepsCheckProblem = (code, detail) =>
  code === "IREPS_SESSION_EXPIRED" ? "IREPS is not logged in here" : `IREPS could not be checked here: ${problemText(code, detail)}`;

/**
 * @param {object} deps
 * @param {() => Promise<{ enabled: boolean, types: string[], unknown: string[], reason: string|null }>} deps.loadConfig
 * @param {object} deps.api                 services/scheduler/schedule-api.js
 * @param {() => Promise<{ signedIn: boolean, user?: { name: string, permissions?: string[] } }>} deps.whoAmI
 * @param {object} deps.signals             services/scheduler/local-signals.js
 * @param {() => boolean} deps.isBusy       a manual job (or the bill upload) is running here
 * @param {() => Promise<{ ok: boolean, code?: string, detail?: string|null, account?: { irepsAccountId: string, operatingUnit?: string|null } }>} deps.checkIreps
 *        the IREPS session check + account (the only IREPS request the scheduler itself makes); code
 *        IREPS_SESSION_EXPIRED = the login page, IREPS_UNAVAILABLE = no usable answer (tried again at the next check)
 * @param {Object<string, (ctx: object) => Promise<object>>} deps.runners   per schedule type
 * @param {{ set: (whenMs: number) => any, clear: () => any }} deps.alarms
 * @param {(state: object) => void} [deps.onState]
 * @param {() => number} [deps.now]
 * @param {() => number} [deps.random]
 * @param {() => string} [deps.uuid]
 * @param {{ setInterval: Function, clearInterval: Function, setTimeout: Function, clearTimeout: Function }} [deps.timers]
 * @param {{ event: Function, runStarted: Function, runFinished: Function }} [deps.runLog]   services/scheduler/run-log.js
 */
export function createScheduler(deps) {
  const now = deps.now || (() => Date.now());
  const random = deps.random || Math.random;
  const uuid = deps.uuid || (() => crypto.randomUUID());
  // wrapped: Chrome throws "Illegal invocation" when its timer functions are called as methods of another object
  const timers = deps.timers || {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (id) => clearInterval(id),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id)
  };
  const onState = deps.onState || (() => {});
  const runLog = deps.runLog || NO_RUN_LOG;
  let lastNote = "";

  /**
   * One decision of the scheduler, in plain words: to the run log (a repeat only moves its time) and,
   * when it differs from the last one, to the DocLink log. Never throws.
   * @param {string} kind
   * @param {string} text
   * @param {string[]} [types]   the schedule types it concerns
   */
  function note(kind, text, types = []) {
    if (text !== lastNote) {
      (kind === "error" ? logger.warn : logger.info)(`Scheduler: ${text}`);
      lastNote = text;
    }
    try {
      Promise.resolve(runLog.event(kind, text, types)).catch(() => {});
    } catch (error) {
      logger.debug("Scheduler: run log event not kept", error);
    }
  }

  /** A run-log write that is awaited (run start and end) but never fails the run. */
  async function logRun(write) {
    try {
      await write();
    } catch (error) {
      logger.debug("Scheduler: run log not written", error);
    }
  }

  const state = {
    enabled: false,
    types: [],
    unknown: [],
    reason: null,
    waitingFor: null, // null | "recon" | "permission" | "account" | "ireps" | "busy" | "backend"
    user: null,
    account: null,
    slots: [],
    running: null,
    nextCheckAt: null,
    lastError: null,
    lastRun: null,
    checkedAt: null
  };

  let waking = null;
  let again = false;
  let lastWakeAt = -Infinity;
  let deferred = null;

  const publish = (patch = {}) => {
    Object.assign(state, patch, { checkedAt: new Date(now()).toISOString() });
    try {
      onState(getState());
    } catch (error) {
      logger.debug("Scheduler: state listener failed", error);
    }
  };

  function getState() {
    return JSON.parse(JSON.stringify(state));
  }

  async function setAlarm(times) {
    const valid = times.filter((t) => Number.isFinite(t));
    if (valid.length === 0) {
      await deps.alarms.clear();
      return;
    }
    const when = Math.max(Math.min(...valid), now() + 1000) + Math.floor(random() * JITTER_MS);
    await deps.alarms.set(when);
  }

  const waitFor = async (waitingFor, extra = {}, recheckMs = IDLE_RECHECK_MS) => {
    await setAlarm([now() + recheckMs]);
    publish({ waitingFor, ...extra });
  };

  /**
   * Wake the scheduler. Triggers within DEBOUNCE_MS of the last wake are folded into one
   * (deferred to the end of that window); `force` (the alarm, a job that ended) always runs.
   * `quietable` (an IREPS page load) does nothing while the last look found nothing to do and
   * the backend's next check is still ahead, so browsing IREPS does not call the backend.
   * @param {string} trigger
   * @param {{ force?: boolean, quietable?: boolean }} [options]
   */
  async function wake(trigger, { force = false, quietable = false } = {}) {
    if (quietable && !waking && now() < (await deps.signals.quietUntil())) return;
    if (waking) {
      again = true;
      return waking;
    }
    const since = now() - lastWakeAt;
    if (!force && since < DEBOUNCE_MS) {
      if (deferred === null) {
        deferred = timers.setTimeout(() => {
          deferred = null;
          wake(`${trigger} (deferred)`, { force: true });
        }, DEBOUNCE_MS - since);
      }
      return Promise.resolve();
    }
    lastWakeAt = now();
    waking = runWake(trigger)
      .catch((error) => {
        logger.error("Scheduler: wake failed", error);
        const detail = String((error && error.message) || error);
        note("error", `The scheduler stopped with an error: ${detail}.`);
        publish({ lastError: { code: "UNKNOWN", detail } });
      })
      .finally(() => {
        waking = null;
        if (again) {
          again = false;
          wake("again", { force: true });
        }
      });
    return waking;
  }

  async function runWake(trigger) {
    const cfg = await deps.loadConfig();
    Object.assign(state, { enabled: cfg.enabled, types: cfg.types, unknown: cfg.unknown, reason: cfg.reason });
    if (!cfg.enabled) {
      await deps.alarms.clear();
      publish({ waitingFor: null, slots: [], running: null, nextCheckAt: null });
      return;
    }
    logger.debug(`Scheduler: wake (${trigger})`);

    let who;
    try {
      who = await deps.whoAmI();
    } catch (error) {
      const code = (error && error.code) || "RECON_UNAVAILABLE";
      const detail = (error && error.detail) || null;
      note("backend", `The Recon Engine could not be reached: ${problemText(code, detail)}. No scheduled download runs from this browser until it answers.`);
      return waitFor("backend", { lastError: { code, detail } });
    }
    if (!who || !who.signedIn) {
      note("recon", "Not signed in to the Recon Engine: this browser runs no scheduled download until someone signs in.");
      return waitFor("recon", { user: null });
    }
    const permissions = (who.user && who.user.permissions) || [];
    const user = { name: (who.user && who.user.name) || "", canRun: permissions.includes(RUN_PERMISSION), canManage: permissions.includes(MANAGE_PERMISSION) };
    state.user = user;
    if (!user.canRun) {
      note("permission", `The signed-in Recon Engine user has no ${RUN_PERMISSION} permission: this browser runs no scheduled download.`);
      return waitFor("permission");
    }

    let account = await deps.signals.account();
    let verified = null;
    let verifiedAt = 0;
    if (!account) {
      // the first time: the account is read from IREPS, but only while the user is active there
      if (deps.isBusy() || !(await deps.signals.irepsReady())) {
        note("account", deps.isBusy() ? "The IREPS account is not known yet: waiting for the DocLink run in this browser to end." : "The IREPS account is not known yet: open any IREPS page (logged in) in this browser.");
        return waitFor("account", { account: null });
      }
      const check = await deps.checkIreps();
      if (!check.ok || !check.account) {
        if (!irepsAnswersLater(check.code)) await deps.signals.recordIrepsCheckFailed();
        note("account", `The IREPS account could not be read: ${problemText(check.code || "SCHEDULE_ACCOUNT_UNVERIFIED", check.detail)}.`);
        return waitFor("account", { account: null, lastError: check.code ? { code: check.code, detail: null } : state.lastError });
      }
      account = String(check.account.irepsAccountId);
      await deps.signals.recordAccount(account);
      verified = check;
      verifiedAt = now();
    }
    state.account = account;

    for (let round = 0; round < MAX_SLOTS_PER_WAKE; round++) {
      let due;
      try {
        due = await deps.api.due(account, cfg.types);
      } catch (error) {
        if (error && error.code === "RECON_AUTH_REQUIRED") {
          note("recon", "Not signed in to the Recon Engine: this browser runs no scheduled download until someone signs in.");
          return waitFor("recon", { user: null });
        }
        if (error && error.code === "SCHEDULE_NO_PERMISSION") {
          note("permission", `The signed-in Recon Engine user has no ${RUN_PERMISSION} permission: this browser runs no scheduled download.`);
          return waitFor("permission");
        }
        const code = (error && error.code) || "SCHEDULE_BACKEND_UNAVAILABLE";
        const detail = (error && error.detail) || null;
        note("backend", `The Recon Engine's schedules could not be reached: ${problemText(code, detail)}.`);
        return waitFor("backend", { lastError: { code, detail } });
      }
      const running = due.running ? { slotId: due.running.id, docType: due.running.doc_type, holder: due.running.holder || null, mine: false } : null;
      const othersRun = running !== null;
      await setAlarm([Date.parse(due.next_check_at), othersRun ? now() + RUNNING_POLL_MS : NaN]);
      publish({ slots: due.slots || [], running, nextCheckAt: due.next_check_at || null, waitingFor: null, lastError: null });

      const candidates = (due.due || []).filter((s) => cfg.types.includes(s.doc_type)).sort((a, b) => order(a) - order(b));
      // at most IDLE_RECHECK_MS: a schedule an admin adds during the day is seen within that time
      const quietUntil = Math.min(Date.parse(due.next_check_at) || Infinity, now() + IDLE_RECHECK_MS);
      await deps.signals.setQuietUntil(candidates.length === 0 && !othersRun ? quietUntil : 0);
      if (candidates.length === 0) return;
      const dueTypes = [...new Set(candidates.map((s) => s.doc_type))];
      const dueText = `Due now: ${dueTypes.map(labelOf).join(", ")}`;
      if (deps.isBusy()) {
        note("busy", `${dueText}. Waiting for the DocLink run in this browser to end.`, dueTypes);
        return publish({ waitingFor: "busy" });
      }
      if (verified && now() - verifiedAt > ACCOUNT_CHECK_MS) {
        // the last run took a while: this slot gets its own account check, as the first one did (5.6)
        logger.debug(`Scheduler: the IREPS account check is ${Math.round((now() - verifiedAt) / 1000)} s old; checking it again for the next slot`);
        verified = null;
      }
      // no page load is needed: only a browser where IREPS was never logged in since Chrome started, or whose
      // last check found IREPS logged out (or another account), waits for the user to log in again
      if (!verified && !(await deps.signals.irepsReady())) {
        note("ireps", `${dueText}. Waiting for IREPS: log in to IREPS in this browser (IREPS was logged out at the last check, or has not been opened since Chrome started).`, dueTypes);
        return publish({ waitingFor: "ireps" });
      }

      const claimed = await claimFirst(candidates, account);
      if (!claimed) return;
      if (claimed.someoneElse) {
        const other = claimed.someoneElse;
        note("other", `${labelOf(other.docType)}: being run by ${(other.holder && other.holder.name) || "another DocLink user"}; this browser looks again in a few minutes.`, [other.docType]);
        await setAlarm([Date.parse(due.next_check_at), now() + RUNNING_POLL_MS]);
        return publish({ running: claimed.someoneElse });
      }

      if (!verified) {
        const check = await deps.checkIreps();
        const sameAccount = check.ok && check.account && String(check.account.irepsAccountId) === account;
        if (!sameAccount) {
          const code = check.ok ? "SCHEDULE_ACCOUNT_MISMATCH" : check.code || "IREPS_SESSION_EXPIRED";
          logger.info(`Scheduler: claim given back (${code}); another DocLink may run it`);
          const why = check.ok ? `IREPS account ${check.account ? check.account.irepsAccountId : "?"} is logged in here, not ${account}` : irepsCheckProblem(code, check.detail);
          note("ireps", `${labelOf(claimed.slot.doc_type)}: claimed, but ${why}; given back so that another DocLink can run it.`, [claimed.slot.doc_type]);
          await finish(claimed, { outcome: "failed", code, countsAsAttempt: false });
          if (!irepsAnswersLater(code)) await deps.signals.recordIrepsCheckFailed();
          if (check.ok && check.account) await deps.signals.recordAccount(check.account.irepsAccountId);
          // only IREPS's login page means "log in to IREPS" (and the "!" badge); IREPS not answering, another
          // account logged in or an account that cannot be read is the last check's failure, said as it is
          if (code === "IREPS_SESSION_EXPIRED") return publish({ waitingFor: "ireps", running: null });
          return publish({ waitingFor: null, running: null, lastError: { code, detail: check.ok ? why : check.detail || null } });
        }
        verified = check;
        verifiedAt = now();
      }

      const result = await runClaimed(claimed, verified.account);
      if (result.waitForJob && !deps.isBusy()) {
        // the run that held the job ended before this wake waited for it: look again once this wake ends
        wake("job ended", { force: true });
        return;
      }
      if (result.stopWake) return;
    }
  }

  /** Claim the first slot that can be claimed; null when none could, { someoneElse } when another DocLink runs. */
  async function claimFirst(candidates, account) {
    for (const slot of candidates) {
      const claimId = uuid();
      try {
        const answer = await deps.api.claim({ slotId: slot.id, claimId, account });
        const period = slot.period && slot.period !== "day" ? ` ${slot.period}` : "";
        logger.info(`Scheduler: claimed ${slot.doc_type} for ${slot.slot_date}${period} (account ${account})`);
        // Tabulations search 7 days at most, whatever the schedule's look-back (run-details.js MAX_LOOKBACK)
        const asked = answer.params || {};
        const params = limitedParams(slot.doc_type, asked);
        if (params.dateFrom !== asked.dateFrom) logger.info(`Scheduler: ${slot.doc_type} searches ${MAX_LOOKBACK[slot.doc_type]} days at most: ${params.dateFrom} - ${params.dateTo} (the schedule's look-back gave ${asked.dateFrom})`);
        return { slot, claimId, params };
      } catch (error) {
        const code = error && error.code;
        if (NEXT_SLOT.has(code)) continue;
        if (SOMEONE_ELSE.has(code)) return { someoneElse: { slotId: slot.id, docType: error.docType || slot.doc_type, holder: error.holder || null, mine: false } };
        const detail = (error && error.detail) || null;
        note("backend", `${labelOf(slot.doc_type)}: the Recon Engine did not hand this browser the download: ${problemText(code || "SCHEDULE_BACKEND_UNAVAILABLE", detail)}.`, [slot.doc_type]);
        publish({ waitingFor: "backend", lastError: { code: code || "SCHEDULE_BACKEND_UNAVAILABLE", detail } });
        return null;
      }
    }
    return null;
  }

  async function finish(claimed, outcome) {
    try {
      await deps.api.finish({
        claimId: claimed.claimId,
        outcome: outcome.outcome,
        code: outcome.code || null,
        countsAsAttempt: outcome.countsAsAttempt !== false,
        permanent: outcome.permanent === true,
        // never so long that the Recon Engine refuses it (a refused finish would leave the slot to its lease)
        result: fitResult(outcome.result || null)
      });
    } catch (error) {
      // CLAIM_LOST: another DocLink took the slot over; anything else: the lease ends it
      logger.warn(`Scheduler: could not report how ${claimed.slot.doc_type} ended (${error && error.code})`);
    }
  }

  async function runClaimed(claimed, account) {
    const { slot, claimId } = claimed;
    let lastBeat = now();
    let lost = false;
    const beat = timers.setInterval(async () => {
      try {
        await deps.api.heartbeat(claimId);
        lastBeat = now();
      } catch (error) {
        if (error && error.code === "SCHEDULE_CLAIM_LOST") lost = true;
        logger.warn(`Scheduler: heartbeat failed (${error && error.code})`);
      }
    }, HEARTBEAT_MS);
    const isClaimLive = () => !lost && now() - lastBeat < LEASE_MS - HEARTBEAT_MS;
    publish({ running: { slotId: slot.id, docType: slot.doc_type, holder: null, mine: true, since: new Date(now()).toISOString() } });
    const range = scheduledSearch(slot.doc_type, claimed.params).text;
    logger.info(`Scheduler: running ${slot.doc_type}${slot.period && slot.period !== "day" ? ` (${slot.period} run)` : ""} for account ${account.irepsAccountId}: ${range || "no date range"}`);
    await logRun(() => runLog.runStarted({ id: claimId, docType: slot.doc_type, slotId: slot.id, slotDate: slot.slot_date || null, period: slot.period || null, account: String(account.irepsAccountId), range, user: (state.user && state.user.name) || null }));

    let outcome;
    try {
      const runner = deps.runners[slot.doc_type];
      outcome = runner
        ? await runner({ slot, claimId, params: claimed.params, account, isClaimLive })
        : { outcome: "failed", code: "SCHEDULE_TYPE_NOT_SUPPORTED", permanent: true };
    } catch (error) {
      logger.error(`Scheduler: ${slot.doc_type} run failed`, error);
      outcome = { outcome: "failed", code: (error && error.code) || "UNKNOWN", result: { detail: String((error && error.message) || error).slice(0, 200) } };
    } finally {
      timers.clearInterval(beat);
    }
    if (lost) outcome = { ...outcome, code: outcome.code || "SCHEDULE_CLAIM_LOST" };
    await finish(claimed, outcome);
    logOutcome(slot, outcome);
    await logRun(() => runLog.runFinished(claimId, outcome));
    // a manual run took the job first (BUSY): given back, and run when that job ends (scheduler-job.js jobEnded)
    const waitForJob = outcome.waitForJob === true;
    if (waitForJob) note("busy", `${labelOf(slot.doc_type)}: a DocLink run in this browser started first; this download runs when it ends.`, [slot.doc_type]);
    publish({ running: null, ...(waitForJob ? { waitingFor: "busy" } : {}), lastRun: { docType: slot.doc_type, outcome: outcome.outcome, code: outcome.code || null, result: outcome.result || null, at: new Date(now()).toISOString() } });
    // an expired IREPS session or a lost claim ends this wake; the next trigger starts afresh
    return { stopWake: outcome.sessionExpired === true || lost || outcome.stopWake === true, waitForJob };
  }

  /**
   * How a run ended, in the DocLink log: one line (a warning unless it is done), then one info line per
   * document it could not save, so the stored log names them without filling Chrome's Errors page.
   */
  function logOutcome(slot, outcome) {
    const { log: lists, ...rest } = outcome;
    (outcome.outcome === "done" ? logger.info : logger.warn)(`Scheduler: ${slot.doc_type} ${outcome.outcome}${outcome.code ? ` (${outcome.code})` : ""}`, rest.result || {});
    const failures = (lists && lists.failures) || (outcome.result && outcome.result.failures) || [];
    for (const f of failures.slice(0, LOGGED_FAILURES_MAX)) logger.info(`Scheduler: ${slot.doc_type}: not saved: ${f.doc} - ${f.code}${f.detail ? ` (${f.detail})` : ""}`);
    if (failures.length > LOGGED_FAILURES_MAX) logger.info(`Scheduler: ${slot.doc_type}: ${failures.length - LOGGED_FAILURES_MAX} more not saved (the Schedule view's run log lists them all)`);
  }

  return { wake, getState };
}

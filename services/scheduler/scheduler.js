/**
 * The scheduler of Phase 1 shared downloads (plan section 8.4): wakes on an alarm, an IREPS page
 * load or a panel nudge, asks the Recon Engine what is due for this IREPS account, and - when this
 * DocLink may - claims one slot, checks IREPS once, runs it, and reports how it ended.
 *
 * The order of checks never contacts IREPS before this DocLink has won a claim, and never on a
 * timer: Recon sign-in -> known account -> due? -> nothing running locally -> recent IREPS activity
 * -> claim -> ONE IREPS check -> run. Twenty DocLinks waking at 09:00 send one IREPS request in
 * total (the winner's). Only one slot of an account runs at a time; the rest follow one by one.
 *
 * No chrome.* here: the wiring (background/scheduler-job.js) passes the API, the local signals,
 * the runners, the alarm and the clock, so every rule is tested with fakes (test/scheduler-tests.js).
 */

import { SCHEDULE_TYPES } from "./schedule-types.js";
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

export const RUN_PERMISSION = "doclink.schedule.run";
export const MANAGE_PERMISSION = "doclink.schedule.manage";

/** Backend answers that mean "not this slot, try the next one". */
const NEXT_SLOT = new Set(["SCHEDULE_SLOT_DONE", "SCHEDULE_NOT_DUE", "SCHEDULE_SLOT_NOT_FOUND"]);
/** Backend answers that mean "another DocLink runs this account now". */
const SOMEONE_ELSE = new Set(["SCHEDULE_ACCOUNT_BUSY", "SCHEDULE_SLOT_TAKEN"]);

const order = (slot) => SCHEDULE_TYPES.indexOf(slot.doc_type);

/**
 * @param {object} deps
 * @param {() => Promise<{ enabled: boolean, types: string[], unknown: string[], reason: string|null }>} deps.loadConfig
 * @param {object} deps.api                 services/scheduler/schedule-api.js
 * @param {() => Promise<{ signedIn: boolean, user?: { name: string, permissions?: string[] } }>} deps.whoAmI
 * @param {object} deps.signals             services/scheduler/local-signals.js
 * @param {() => boolean} deps.isBusy       a manual job (or the bill upload) is running here
 * @param {() => Promise<{ ok: boolean, code?: string, account?: { irepsAccountId: string, operatingUnit?: string|null } }>} deps.checkIreps
 *        the IREPS session check + account (the only IREPS request the scheduler itself makes)
 * @param {Object<string, (ctx: object) => Promise<object>>} deps.runners   per schedule type
 * @param {{ set: (whenMs: number) => any, clear: () => any }} deps.alarms
 * @param {(state: object) => void} [deps.onState]
 * @param {() => number} [deps.now]
 * @param {() => number} [deps.random]
 * @param {() => string} [deps.uuid]
 * @param {{ setInterval: Function, clearInterval: Function, setTimeout: Function, clearTimeout: Function }} [deps.timers]
 */
export function createScheduler(deps) {
  const now = deps.now || (() => Date.now());
  const random = deps.random || Math.random;
  const uuid = deps.uuid || (() => crypto.randomUUID());
  const timers = deps.timers || { setInterval, clearInterval, setTimeout, clearTimeout };
  const onState = deps.onState || (() => {});

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
        publish({ lastError: { code: "UNKNOWN", detail: String((error && error.message) || error) } });
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
      return waitFor("backend", { lastError: { code: (error && error.code) || "RECON_UNAVAILABLE", detail: (error && error.detail) || null } });
    }
    if (!who || !who.signedIn) return waitFor("recon", { user: null });
    const permissions = (who.user && who.user.permissions) || [];
    const user = { name: (who.user && who.user.name) || "", canRun: permissions.includes(RUN_PERMISSION), canManage: permissions.includes(MANAGE_PERMISSION) };
    state.user = user;
    if (!user.canRun) return waitFor("permission");

    let account = await deps.signals.account();
    let verified = null;
    if (!account) {
      // the first time: the account is read from IREPS, but only while the user is active there
      if (deps.isBusy() || !(await deps.signals.irepsReady())) return waitFor("account", { account: null });
      const check = await deps.checkIreps();
      if (!check.ok || !check.account) {
        await deps.signals.recordIrepsCheckFailed();
        return waitFor("account", { account: null, lastError: check.code ? { code: check.code, detail: null } : state.lastError });
      }
      account = String(check.account.irepsAccountId);
      await deps.signals.recordAccount(account);
      verified = check;
    }
    state.account = account;

    for (let round = 0; round < MAX_SLOTS_PER_WAKE; round++) {
      let due;
      try {
        due = await deps.api.due(account, cfg.types);
      } catch (error) {
        if (error && error.code === "RECON_AUTH_REQUIRED") return waitFor("recon", { user: null });
        if (error && error.code === "SCHEDULE_NO_PERMISSION") return waitFor("permission");
        return waitFor("backend", { lastError: { code: (error && error.code) || "SCHEDULE_BACKEND_UNAVAILABLE", detail: (error && error.detail) || null } });
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
      if (deps.isBusy()) return publish({ waitingFor: "busy" });
      if (!verified && !(await deps.signals.irepsReady())) return publish({ waitingFor: "ireps" });

      const claimed = await claimFirst(candidates, account);
      if (!claimed) return;
      if (claimed.someoneElse) {
        await setAlarm([Date.parse(due.next_check_at), now() + RUNNING_POLL_MS]);
        return publish({ running: claimed.someoneElse });
      }

      if (!verified) {
        const check = await deps.checkIreps();
        const sameAccount = check.ok && check.account && String(check.account.irepsAccountId) === account;
        if (!sameAccount) {
          const code = check.ok ? "SCHEDULE_ACCOUNT_MISMATCH" : check.code || "IREPS_SESSION_EXPIRED";
          logger.info(`Scheduler: claim given back (${code}); another DocLink may run it`);
          await finish(claimed, { outcome: "failed", code, countsAsAttempt: false });
          await deps.signals.recordIrepsCheckFailed();
          if (check.ok && check.account) await deps.signals.recordAccount(check.account.irepsAccountId);
          return publish({ waitingFor: "ireps", running: null });
        }
        verified = check;
      }

      const result = await runClaimed(claimed, verified.account);
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
        return { slot, claimId, params: answer.params || {} };
      } catch (error) {
        const code = error && error.code;
        if (NEXT_SLOT.has(code)) continue;
        if (SOMEONE_ELSE.has(code)) return { someoneElse: { slotId: slot.id, docType: error.docType || slot.doc_type, holder: error.holder || null, mine: false } };
        publish({ waitingFor: "backend", lastError: { code: code || "SCHEDULE_BACKEND_UNAVAILABLE", detail: (error && error.detail) || null } });
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
        result: outcome.result || null
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

    let outcome;
    try {
      const runner = deps.runners[slot.doc_type];
      outcome = runner
        ? await runner({ slot, claimId, params: claimed.params, account, isClaimLive })
        : { outcome: "failed", code: "SCHEDULE_TYPE_NOT_SUPPORTED", permanent: true };
    } catch (error) {
      logger.error(`Scheduler: ${slot.doc_type} run failed`, error);
      outcome = { outcome: "failed", code: (error && error.code) || "UNKNOWN" };
    } finally {
      timers.clearInterval(beat);
    }
    if (lost) outcome = { ...outcome, code: outcome.code || "SCHEDULE_CLAIM_LOST" };
    await finish(claimed, outcome);
    logger.info(`Scheduler: ${slot.doc_type} ${outcome.outcome}${outcome.code ? ` (${outcome.code})` : ""}`, outcome.result || {});
    publish({ running: null, lastRun: { docType: slot.doc_type, outcome: outcome.outcome, code: outcome.code || null, result: outcome.result || null, at: new Date(now()).toISOString() } });
    // an expired IREPS session or a lost claim ends this wake; the next trigger starts afresh
    return { stopWake: outcome.sessionExpired === true || lost || outcome.stopWake === true };
  }

  return { wake, getState };
}

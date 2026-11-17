/**
 * Scheduled downloads in the service worker: the chrome.* side of services/scheduler/.
 *
 *   - wakes the scheduler on its alarm, on an IREPS page load (the user is active there), on a
 *     panel nudge (Recon sign-in, a passing IREPS check), on browser start and when a manual job
 *     ends while a slot waited for it;
 *   - runs a claimed slot through the worker's own jobs (launchers passed in), with the shared
 *     hooks: reserved for the IREPS account, saved to S3 / ECM only, reported to the Recon Engine;
 *   - runs a claimed tender slot (Phase 2) in a background DocLink tab (services/scheduler/tender-runner.js,
 *     tender/schedule-runner.js) and answers that tab's READY / PING / DONE;
 *   - shows "!" on the toolbar icon while a slot of this account waits for an IREPS login;
 *   - answers the Schedule view (state, today's slots, schedules).
 *
 * Off unless config.json "schedular_phase1" / "schedular_phase2" say otherwise (services/scheduler/schedule-types.js).
 */

import { createScheduler, RUN_PERMISSION, MANAGE_PERMISSION } from "../services/scheduler/scheduler.js";
import { createScheduleApi, ScheduleApiError } from "../services/scheduler/schedule-api.js";
import { createLocalSignals } from "../services/scheduler/local-signals.js";
import { createRunnerFactory } from "../services/scheduler/runners.js";
import { parseSchedulerConfig, TENDER_SCHEDULE_TYPES } from "../services/scheduler/schedule-types.js";
import { createTenderRunner } from "../services/scheduler/tender-runner.js";
import { holdWorker } from "./keep-alive.js";
import { readConfigFiles } from "../utils/config.js";
import { reconWhoAmI } from "../services/recon-auth.js";
import { SAVE_DESTINATION } from "../services/recon-service.js";
import { EXPORT_FORMAT } from "../services/search-po/search-po-export.js";
import { SEARCH_PO_CRITERIA } from "../services/search-po/search-po-api.js";
import { MA_DATE_MODE, MA_ERROR } from "../services/ma/ma-service.js";
import { MESSAGE_TYPES, describeError } from "../utils/messages.js";
import { logger } from "../utils/logger.js";

export const SCHEDULER_ALARM = "doclink.scheduler";
const BADGE_COLOR = "#d97706";

/** Schedule fields the panel may set (the backend validates them again). */
const EDITABLE = ["window_start", "window_end", "check_every_minutes", "repeat_every_minutes", "days", "lookback_days", "enabled"];

/**
 * A page load on IREPS that says the user is active there: the configured IREPS origin, and not
 * the public start page or a login / logout page.
 */
export function isIrepsActivityUrl(url, irepsBaseUrl) {
  if (!url || !irepsBaseUrl) return false;
  let page;
  let base;
  try {
    page = new URL(url);
    base = new URL(irepsBaseUrl);
  } catch {
    return false;
  }
  if (page.origin !== base.origin) return false;
  return page.pathname !== "/" && !/log(in|out)/i.test(page.pathname);
}

/**
 * @param {object} deps
 * @param {(type: string, payload?: object) => void} deps.broadcast
 * @param {{ billStatus: Function, document: Function, maSearch: Function, maDownload: Function, batch: Function }} deps.launch
 *        the worker's launchers (each answers { started, error?, done })
 * @param {() => boolean} deps.isBusy                  a manual job or the bill upload runs here
 * @param {() => Promise<{ irepsAccountId: string, operatingUnit?: string|null }|null>} deps.readIrepsAccount
 *        the verified IREPS account (the IREPS home page), or null
 * @param {() => string} deps.irepsBaseUrl
 */
export function createSchedulerJob(deps) {
  const api = createScheduleApi();
  const signals = createLocalSignals();
  const { exportRunner, documentRunner } = createRunnerFactory({ api });
  const toS3OrEcm = SAVE_DESTINATION.RECON;

  const loadConfig = async () => parseSchedulerConfig(((await readConfigFiles()) || {}).config);

  /** Bill Status: "Last 90 Days" when the look-back covers it, else the claim's date range. */
  const billStatusOptions = (p) => (Number(p.lookbackDays) >= 90 ? { mode: "last90Days" } : { mode: "dateRange", dateFrom: p.dateFrom, dateTo: p.dateTo });

  /** A batch launch whose `done` (the final batch state) becomes a document run's result. */
  function asDocumentRun(launched) {
    if (!launched.started) return launched;
    const done = launched.done.then((state) =>
      state && state.phase === "error"
        ? { ok: false, code: (state.error && state.error.code) || "UNKNOWN", items: state.items || [] }
        : { ok: true, items: (state && state.items) || [], sessionExpired: Boolean(state && state.sessionExpired) }
    );
    return { ...launched, done };
  }

  async function runMa(ctx, hooks) {
    const search = await deps.launch.maSearch({ dateMode: MA_DATE_MODE.RANGE, dateFrom: ctx.params.dateFrom, dateTo: ctx.params.dateTo });
    if (!search.started) return search;
    const found = await search.done;
    // no MA in the range is what IREPS said, not a failure: nothing to save today
    if (!found.ok && found.code === MA_ERROR.NOT_FOUND) return { started: true, done: Promise.resolve({ ok: true, items: [] }) };
    if (!found.ok) return { started: true, done: Promise.resolve({ ok: false, code: found.code, items: [] }) };
    const download = await deps.launch.maDownload("all", toS3OrEcm, null, hooks);
    if (!download.started) return download;
    const done = download.done.then((r) => (r.ok ? { ok: true, items: r.summary.items || [], sessionExpired: Boolean(r.summary.sessionExpired) } : { ok: false, code: r.code, items: [] }));
    return { started: true, done };
  }

  const searchPoExport = (criteria) => (ctx, hooks) =>
    deps.launch.document(criteria, { dateFrom: ctx.params.dateFrom, dateTo: ctx.params.dateTo, destination: toS3OrEcm, format: EXPORT_FORMAT.XLSX }, null, hooks);
  const batch = (kind, withDates) => async (ctx, hooks) =>
    asDocumentRun(await deps.launch.batch({ kind, destination: toS3OrEcm, ...(withDates ? { dateFrom: ctx.params.dateFrom, dateTo: ctx.params.dateTo } : {}) }, hooks));

  const runners = {
    billStatus: exportRunner((ctx, hooks) => deps.launch.billStatus({ ...billStatusOptions(ctx.params), destination: toS3OrEcm }, null, hooks)),
    crn: exportRunner(searchPoExport(SEARCH_PO_CRITERIA.CRN)),
    rnote: exportRunner(searchPoExport(SEARCH_PO_CRITERIA.RNOTE)),
    ma: documentRunner(runMa),
    poDate: documentRunner(batch("po-date", true)),
    icDate: documentRunner(batch("ic-date", true)),
    icNotifications: documentRunner(batch("ic-notif", false))
  };
  // Phase 2: tender documents run in a background DocLink tab
  const tenderRunner = createTenderRunner({
    openTab: async (path) => (await chrome.tabs.create({ url: chrome.runtime.getURL(path), active: false })).id,
    closeTab: (tabId) => chrome.tabs.remove(tabId),
    holdWorker
  });
  for (const type of TENDER_SCHEDULE_TYPES) runners[type] = tenderRunner.run;
  const senderTab = (sender) => (sender && sender.tab ? sender.tab.id : null);

  const alarms = {
    set: async (when) => {
      if (chrome.alarms) await chrome.alarms.create(SCHEDULER_ALARM, { when });
      else logger.warn('Scheduler: the "alarms" permission is missing; scheduled checks run on IREPS page loads only');
    },
    clear: async () => {
      if (chrome.alarms) await chrome.alarms.clear(SCHEDULER_ALARM);
    }
  };

  function showBadge(state) {
    const text = state.enabled && state.waitingFor === "ireps" ? "!" : "";
    try {
      chrome.action.setBadgeText({ text }).catch(() => {});
      if (text) chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR }).catch(() => {});
    } catch (error) {
      logger.debug("Scheduler: could not set the badge", error);
    }
  }

  const scheduler = createScheduler({
    loadConfig,
    api,
    whoAmI: () => reconWhoAmI(),
    signals,
    isBusy: deps.isBusy,
    checkIreps: async () => {
      const account = await deps.readIrepsAccount();
      return account ? { ok: true, account } : { ok: false, code: "SCHEDULE_ACCOUNT_UNVERIFIED" };
    },
    runners,
    alarms,
    onState: (state) => {
      showBadge(state);
      deps.broadcast(MESSAGE_TYPES.SCHEDULE_STATE, { state });
    }
  });

  const failure = (error) => ({ ok: false, error: describeError(error instanceof ScheduleApiError ? error.code : "UNKNOWN", { detail: (error && (error.detail || error.message)) || "" }) });

  /** Run `fn(account)` for the last verified IREPS account; a panel error when there is none. */
  async function withAccount(fn) {
    const account = await signals.account();
    if (!account) return { ok: false, error: describeError("SCHEDULE_ACCOUNT_UNVERIFIED", { detail: "open an IREPS page and log in first" }) };
    try {
      return await fn(account);
    } catch (error) {
      if (!(error instanceof ScheduleApiError)) logger.error("Scheduler: Schedule view request failed", error);
      return failure(error);
    }
  }

  /** What the Schedule view shows: settings, who is signed in, today's slots and the schedules. */
  async function viewState() {
    const config = await loadConfig();
    const st = scheduler.getState();
    const account = await signals.account();
    let user = st.user;
    try {
      const who = await reconWhoAmI();
      const permissions = (who.signedIn && who.user.permissions) || [];
      user = who.signedIn ? { name: who.user.name, canRun: permissions.includes(RUN_PERMISSION), canManage: permissions.includes(MANAGE_PERMISSION) } : null;
    } catch (error) {
      logger.debug("Scheduler: Recon sign-in not checked for the Schedule view", error);
    }
    let today = null;
    let error = null;
    if (config.enabled && account && user && user.canRun) {
      try {
        today = await api.today(account, config.types);
      } catch (e) {
        error = failure(e).error;
      }
    }
    return {
      config,
      account,
      user,
      waitingFor: st.waitingFor,
      lastError: st.lastError,
      running: st.running,
      lastRun: st.lastRun,
      nextCheckAt: st.nextCheckAt,
      slots: today ? today.slots || [] : st.slots,
      schedules: today ? today.schedules || [] : [],
      error
    };
  }

  const handlers = {
    [MESSAGE_TYPES.SCHEDULE_GET_STATE]: () => viewState(),
    [MESSAGE_TYPES.SCHEDULE_NUDGE]: (message) => {
      scheduler.wake(`panel: ${message.reason || "nudge"}`, { force: true });
      return { ok: true };
    },
    [MESSAGE_TYPES.SCHEDULE_LIST]: () => withAccount(async (account) => ({ ok: true, ...(await api.listSchedules(account)) })),
    [MESSAGE_TYPES.SCHEDULE_SAVE]: (message) =>
      withAccount(async (account) => {
        const s = message.schedule || {};
        const changes = Object.fromEntries(EDITABLE.filter((k) => s[k] !== undefined).map((k) => [k, s[k]]));
        const answer = s.id ? await api.updateSchedule(s.id, changes) : await api.createSchedule({ ...changes, ireps_account_id: account, doc_type: s.doc_type });
        await signals.setQuietUntil(0);
        scheduler.wake("schedule saved", { force: true });
        return { ok: true, schedule: answer.schedule };
      }),
    [MESSAGE_TYPES.SCHEDULE_DELETE]: (message) =>
      withAccount(async () => {
        await api.deleteSchedule(message.id);
        return { ok: true };
      }),
    // the runner tab of a tender slot (only the tab this run opened is answered)
    [MESSAGE_TYPES.SCHEDULE_RUNNER_READY]: (message, sender) => tenderRunner.ready(message.claimId, senderTab(sender)),
    [MESSAGE_TYPES.SCHEDULE_RUNNER_PING]: (message, sender) => tenderRunner.ping(message.claimId, senderTab(sender)),
    [MESSAGE_TYPES.SCHEDULE_RUNNER_DONE]: (message, sender) => tenderRunner.done(message.claimId, message.outcome, senderTab(sender))
  };

  return {
    handlers,
    isSchedulerAlarm: (alarm) => Boolean(alarm && alarm.name === SCHEDULER_ALARM),
    onAlarm: () => scheduler.wake("alarm", { force: true }),
    /** A tab finished loading `url`: IREPS activity is recorded, and a due slot may run. */
    async onPageLoaded(url) {
      if (!isIrepsActivityUrl(url, deps.irepsBaseUrl())) return;
      await signals.recordIrepsActivity();
      await scheduler.wake("ireps page", { quietable: true });
    },
    /** IREPS answered "logged in" to the panel's session check: the same as a page load. */
    async onIrepsActive() {
      await signals.recordIrepsActivity();
      await scheduler.wake("ireps session check", { quietable: true });
    },
    onBrowserStart: () => scheduler.wake("browser start", { force: true }),
    /** A tab closed: a tender runner tab closed before its run ended gives the slot back. */
    onTabRemoved: (tabId) => tenderRunner.tabRemoved(tabId),
    /** A manual job ended: a slot that waited for it may run now. */
    jobEnded() {
      if (scheduler.getState().waitingFor === "busy") scheduler.wake("job ended", { force: true });
    },
    /** The IREPS account was verified (any run reads it): remembered for the next check. */
    recordAccount: (irepsAccountId) => signals.recordAccount(irepsAccountId)
  };
}

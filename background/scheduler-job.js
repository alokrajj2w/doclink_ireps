/**
 * Scheduled downloads in the service worker: the chrome.* side of services/scheduler/.
 *
 *   - wakes the scheduler on its alarm, on an IREPS page load (the user is active there; never a
 *     load in a tab DocLink opened itself, such as a print tab), on a panel nudge (Recon sign-in, a
 *     passing IREPS check), on browser start and when a manual job ends while a slot waited for it;
 *   - runs a claimed slot through the worker's own jobs (launchers passed in), with the shared
 *     hooks: reserved for the IREPS account, saved to S3 / ECM only, reported to the Recon Engine;
 *   - runs a claimed tender slot (Phase 2) in a background DocLink tab (services/scheduler/tender-runner.js,
 *     tender/schedule-runner.js) and answers that tab's READY / PING / DONE;
 *   - shows "!" on the toolbar icon while a slot of this account waits for an IREPS login;
 *   - keeps this browser's run log (services/scheduler/run-log.js): every run with the documents it
 *     saved, skipped and could not save (and why), and why a due slot did not run;
 *   - answers the Schedule view (state, today's slots, schedules, the run log).
 *
 * Off unless config.json "schedular_phase1" / "schedular_phase2" say otherwise (services/scheduler/schedule-types.js).
 */

import { createScheduler, RUN_PERMISSION, MANAGE_PERMISSION } from "../services/scheduler/scheduler.js";
import { createScheduleApi, ScheduleApiError } from "../services/scheduler/schedule-api.js";
import { createLocalSignals } from "../services/scheduler/local-signals.js";
import { createRunnerFactory } from "../services/scheduler/runners.js";
import { createRunLog } from "../services/scheduler/run-log.js";
import { scheduledSearch, FIXED_LOOKBACK, MAX_LOOKBACK } from "../services/scheduler/run-details.js";
import { parseSchedulerConfig, TENDER_SCHEDULE_TYPES, SCHEDULE_TYPE_LABEL } from "../services/scheduler/schedule-types.js";
import { createTenderRunner } from "../services/scheduler/tender-runner.js";
import { holdWorker } from "./keep-alive.js";
import { isPortalOtherHost } from "../utils/url-scope.js";
import { readConfigFiles } from "../utils/config.js";
import { reconWhoAmI } from "../services/recon-auth.js";
import { SAVE_DESTINATION } from "../services/recon-service.js";
import { EXPORT_FORMAT } from "../services/search-po/search-po-export.js";
import { SEARCH_PO_CRITERIA } from "../services/search-po/search-po-api.js";
import { MA_DATE_MODE, MA_ERROR } from "../services/ma/ma-service.js";
import { MESSAGE_TYPES, SCHEDULED_RUN, describeError } from "../utils/messages.js";
import { logger } from "../utils/logger.js";

export const SCHEDULER_ALARM = "doclink.scheduler";
const BADGE_COLOR = "#d97706";

/** Schedule fields the panel may set (the backend validates them again). */
const EDITABLE = ["window_start", "window_end", "check_every_minutes", "repeat_every_minutes", "days", "lookback_days", "enabled"];

/**
 * The options a scheduled export run (Bill Status, CRN, R-NOTE) is launched with: always the last
 * 90 days (services/scheduler/run-details.js scheduledSearch), saved as .xlsx to the Recon Engine's
 * S3, the same place an "ECM / S3" run of the panel saves it (bronze/<customer>/<bill_status|crn|rnote>/).
 * @param {"billStatus"|"crn"|"rnote"} docType
 * @param {{ dateFrom?: string, dateTo?: string }} params   the claim's (the Recon Engine's today, IST)
 */
export function exportLaunchOptions(docType, params) {
  const search = scheduledSearch(docType, params);
  if (docType === "billStatus") return { mode: search.mode, destination: SAVE_DESTINATION.RECON };
  return { dateFrom: search.dateFrom, dateTo: search.dateTo, destination: SAVE_DESTINATION.RECON, format: EXPORT_FORMAT.XLSX };
}

/** A saved schedule in one line for the run log: "Bill Status: 11:00-12:00, once a day, on". */
function scheduleText(type, s) {
  const runs = s.repeat_every_minutes ? `every ${s.repeat_every_minutes} min` : "once a day";
  return `${SCHEDULE_TYPE_LABEL[type] || type}: ${s.window_start}-${s.window_end}, ${runs}, retry every ${s.check_every_minutes} min, ${s.enabled === false ? "off" : "on"}`;
}

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
  // the portal without / with "www." is the same IREPS session (one domain-wide login cookie)
  if (page.origin !== base.origin && !isPortalOtherHost(url, irepsBaseUrl)) return false;
  return page.pathname !== "/" && !/log(in|out)/i.test(page.pathname);
}

/**
 * Whether a tab's finished page load is the user's activity on IREPS (isIrepsActivityUrl), and not
 * DocLink's own work: a tab DocLink opened itself (a print tab, the tender runner tab) or a popup one
 * of them opened (which is then noted as DocLink's too, for the tabs it opens in turn). Such a load
 * never counts, so the scheduler neither claims nor sends anything to IREPS because of it.
 * @param {string} url
 * @param {{ id?: number, openerTabId?: number }|null} tab
 * @param {{ irepsBaseUrl: string, signals: { isOwnTab: Function, recordOwnTab: Function } }} context
 */
export async function isUserIrepsActivity(url, tab, { irepsBaseUrl, signals }) {
  if (!isIrepsActivityUrl(url, irepsBaseUrl)) return false;
  if (tab && (await signals.isOwnTab(tab))) {
    await signals.recordOwnTab(tab.id);
    return false;
  }
  return true;
}

/**
 * A batch's final state as a document run's end (runners.js): its items, the lists it read short of
 * IREPS's total (`warnings`), and what it could not read besides the documents (`problems`: the IC
 * notifications whose search failed or found nothing, ic-notification-service.js).
 * @param {object|null} state   the final batch state (services/po/po-date-service.js, inspection-certificate/*)
 */
export function batchRunEnd(state) {
  if (state && state.phase === "error") {
    const error = state.error || {};
    return { ok: false, code: error.code || "UNKNOWN", detail: error.detail || error.message || null, items: state.items || [] };
  }
  return {
    ok: true,
    items: (state && state.items) || [],
    sessionExpired: Boolean(state && state.sessionExpired),
    warnings: (state && Array.isArray(state.warnings) && state.warnings) || [],
    problems: (state && Array.isArray(state.problems) && state.problems) || []
  };
}

/**
 * @param {object} deps
 * @param {(type: string, payload?: object) => void} deps.broadcast
 * @param {{ billStatus: Function, document: Function, maSearch: Function, maDownload: Function, batch: Function }} deps.launch
 *        the worker's launchers (each answers { started, error?, done }); every scheduled run is started as
 *        SCHEDULED_RUN, so no panel shows it as its own run
 * @param {() => boolean} deps.isBusy                  a manual job or the bill upload runs here
 * @param {() => Promise<{ ok: true, account: { irepsAccountId: string, operatingUnit?: string|null } }|{ ok: false, code: string, detail?: string }>} deps.readIrepsAccount
 *        the verified IREPS account (the IREPS home page; services/ireps-account-service.js), or why not
 * @param {() => string} deps.irepsBaseUrl
 */
export function createSchedulerJob(deps) {
  const api = createScheduleApi();
  const signals = createLocalSignals();
  const runLog = createRunLog();
  const { exportRunner, documentRunner } = createRunnerFactory({ api });
  const toS3OrEcm = SAVE_DESTINATION.RECON;

  const loadConfig = async () => parseSchedulerConfig(((await readConfigFiles()) || {}).config);

  /** The reason a failed job gave, for the slot's result (the job's described message). */
  const reasonOf = (error) => (error && (error.detail || error.message)) || null;

  /** A batch launch whose `done` (the final batch state) becomes a document run's result. */
  const asDocumentRun = (launched) => (launched.started ? { ...launched, done: launched.done.then(batchRunEnd) } : launched);

  async function runMa(ctx, hooks) {
    const search = await deps.launch.maSearch({ dateMode: MA_DATE_MODE.RANGE, dateFrom: ctx.params.dateFrom, dateTo: ctx.params.dateTo }, SCHEDULED_RUN);
    if (!search.started) return search;
    const found = await search.done;
    // no MA in the range is what IREPS said, not a failure: nothing to save today
    if (!found.ok && found.code === MA_ERROR.NOT_FOUND) return { started: true, done: Promise.resolve({ ok: true, items: [] }) };
    if (!found.ok) return { started: true, done: Promise.resolve({ ok: false, code: found.code, detail: reasonOf(found.error), items: [] }) };
    // a list short of IREPS's own total: what was read is downloaded, and the run is not done
    const warnings = found.incomplete ? [`MA search: ${found.incomplete}; some MAs may be missing.`] : [];
    const download = await deps.launch.maDownload("all", toS3OrEcm, SCHEDULED_RUN, hooks);
    if (!download.started) return download;
    const done = download.done.then((r) => (r.ok ? { ok: true, items: r.summary.items || [], sessionExpired: Boolean(r.summary.sessionExpired), warnings } : { ok: false, code: r.code, detail: reasonOf(r.error), items: [] }));
    return { started: true, done };
  }

  /** A Bill Status / CRN / R-NOTE launch whose failure carries the job's reason. */
  const withReason = (launched) => (launched.started ? { ...launched, done: launched.done.then((r) => (r.ok ? r : { ...r, detail: reasonOf(r.error) })) } : launched);
  const searchPoExport = (criteria, docType) => async (ctx, hooks) => withReason(await deps.launch.document(criteria, exportLaunchOptions(docType, ctx.params), SCHEDULED_RUN, hooks));
  const batch = (kind, withDates) => async (ctx, hooks) =>
    asDocumentRun(await deps.launch.batch({ kind, destination: toS3OrEcm, panelTabId: SCHEDULED_RUN, ...(withDates ? { dateFrom: ctx.params.dateFrom, dateTo: ctx.params.dateTo } : {}) }, hooks));

  const runners = {
    billStatus: exportRunner(async (ctx, hooks) => withReason(await deps.launch.billStatus(exportLaunchOptions("billStatus", ctx.params), SCHEDULED_RUN, hooks))),
    crn: exportRunner(searchPoExport(SEARCH_PO_CRITERIA.CRN, "crn")),
    rnote: exportRunner(searchPoExport(SEARCH_PO_CRITERIA.RNOTE, "rnote")),
    ma: documentRunner(runMa),
    poDate: documentRunner(batch("po-date", true)),
    icDate: documentRunner(batch("ic-date", true)),
    icNotifications: documentRunner(batch("ic-notif", false))
  };
  // Phase 2: tender documents run in a background DocLink tab
  const tenderRunner = createTenderRunner({
    openTab: async (path) => {
      const tab = await chrome.tabs.create({ url: chrome.runtime.getURL(path), active: false });
      // DocLink's own tab: a page it (or a tab it opens) loads is never the user's IREPS activity
      await signals.recordOwnTab(tab.id);
      return tab.id;
    },
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
      const read = await deps.readIrepsAccount();
      return read && read.ok ? { ok: true, account: read.account } : { ok: false, code: (read && read.code) || "SCHEDULE_ACCOUNT_UNVERIFIED", detail: (read && read.detail) || null };
    },
    runners,
    alarms,
    runLog,
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
      log: await runLog.read(),
      version: chrome.runtime.getManifest().version,
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
        // Bill Status, CRN and R-NOTE always search 90 days: the stored look-back says so too
        if (FIXED_LOOKBACK[s.doc_type]) changes.lookback_days = FIXED_LOOKBACK[s.doc_type];
        // Tabulations search 7 days at most: a longer look-back is stored as 7
        if (MAX_LOOKBACK[s.doc_type] && !(changes.lookback_days <= MAX_LOOKBACK[s.doc_type])) changes.lookback_days = MAX_LOOKBACK[s.doc_type];
        const answer = s.id ? await api.updateSchedule(s.id, changes) : await api.createSchedule({ ...changes, ireps_account_id: account, doc_type: s.doc_type });
        const saved = answer.schedule || { ...changes, doc_type: s.doc_type };
        runLog.event("schedule", `Schedule ${s.id ? "changed" : "added"}: ${scheduleText(s.doc_type, saved)}.`, [s.doc_type]);
        await signals.setQuietUntil(0);
        scheduler.wake("schedule saved", { force: true });
        return { ok: true, schedule: answer.schedule };
      }),
    [MESSAGE_TYPES.SCHEDULE_DELETE]: (message) =>
      withAccount(async () => {
        await api.deleteSchedule(message.id);
        if (message.docType) runLog.event("schedule", `Schedule deleted: ${SCHEDULE_TYPE_LABEL[message.docType] || message.docType}.`, [message.docType]);
        return { ok: true };
      }),
    // the runner tab of a tender slot (only the tab this run opened is answered)
    [MESSAGE_TYPES.SCHEDULE_RUNNER_READY]: (message, sender) => tenderRunner.ready(message.claimId, senderTab(sender)),
    [MESSAGE_TYPES.SCHEDULE_RUNNER_PING]: (message, sender) => tenderRunner.ping(message.claimId, senderTab(sender)),
    [MESSAGE_TYPES.SCHEDULE_RUNNER_DONE]: (message, sender) => tenderRunner.done(message.claimId, message.outcome, senderTab(sender)),
    // a print tab DocLink opened (tender/tender-print.js): answered once it is noted, before its page loads
    [MESSAGE_TYPES.NOTE_OWN_TAB]: async (message) => {
      await signals.recordOwnTab(message.tabId);
      return { ok: true };
    }
  };

  return {
    handlers,
    isSchedulerAlarm: (alarm) => Boolean(alarm && alarm.name === SCHEDULER_ALARM),
    onAlarm: () => scheduler.wake("alarm", { force: true }),
    /**
     * A tab finished loading `url`: IREPS activity is recorded, and a due slot may run; never for a tab
     * DocLink opened itself (isUserIrepsActivity).
     * @param {string} url
     * @param {{ id?: number, openerTabId?: number }} [tab]
     */
    async onPageLoaded(url, tab = null) {
      if (!(await isUserIrepsActivity(url, tab, { irepsBaseUrl: deps.irepsBaseUrl(), signals }))) return;
      await signals.recordIrepsActivity();
      await scheduler.wake("ireps page", { quietable: true });
    },
    /** IREPS answered "logged in" to the panel's session check: the same as a page load. */
    async onIrepsActive() {
      await signals.recordIrepsActivity();
      await scheduler.wake("ireps session check", { quietable: true });
    },
    onBrowserStart: () => scheduler.wake("browser start", { force: true }),
    /** A tab closed: a tender runner tab closed before its run ended gives the slot back; an own tab is forgotten. */
    onTabRemoved: (tabId) => {
      tenderRunner.tabRemoved(tabId);
      signals.forgetOwnTab(tabId);
    },
    /** A manual job ended: a slot that waited for it may run now. */
    jobEnded() {
      if (scheduler.getState().waitingFor === "busy") scheduler.wake("job ended", { force: true });
    },
    /** The IREPS account was verified (any run reads it): remembered for the next check. */
    recordAccount: (irepsAccountId) => signals.recordAccount(irepsAccountId)
  };
}

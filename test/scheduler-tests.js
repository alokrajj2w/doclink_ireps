/**
 * Tests for Phase 1 scheduled downloads (services/scheduler/, background/scheduler-job.js helpers,
 * popup/popup-schedule.js helpers): the schedular_phase1 setting, the order of checks (nothing is
 * sent to IREPS before this DocLink has won a claim, and never on a timer), claims and hand-overs,
 * the runners' outcomes, the shared hooks (reserved per IREPS account, S3 / ECM only, never local)
 * and the Recon Engine client. Everything runs on fakes: no extension API, no network, a fake clock.
 * Invoked from run-tests.js.
 */

import { parseSchedulerConfig, SCHEDULE_TYPES, SCHEDULE_DEFAULT_TIMING, TENDER_SCHEDULE_TYPES } from "../services/scheduler/schedule-types.js";
import { createTenderRunner, tenderRunOutcome, tenderJobProblems, cleanOutcome, tenderCode, stoppedCode, RUNNER_PAGE } from "../services/scheduler/tender-runner.js";
import { createScheduler, LEASE_MS, HEARTBEAT_MS, RUNNING_POLL_MS, DEBOUNCE_MS, ACCOUNT_CHECK_MS } from "../services/scheduler/scheduler.js";
import { createRunnerFactory, failedOutcome } from "../services/scheduler/runners.js";
import { createSharedRunHooks, istParts, RESERVE_CHUNK } from "../services/scheduler/shared-run-hooks.js";
import { createScheduleApi, ScheduleApiError } from "../services/scheduler/schedule-api.js";
import { createLocalSignals, IREPS_ACTIVITY_MS } from "../services/scheduler/local-signals.js";
import { scheduledSearch, labelFromKey, failureEntry, fitResult, RESULT_FAILURES_MAX, RESULT_MAX_CHARS, FIXED_LOOKBACK } from "../services/scheduler/run-details.js";
import { createRunLog, runLogText, MAX_RUNS } from "../services/scheduler/run-log.js";
import { isIrepsActivityUrl, isUserIrepsActivity, exportLaunchOptions, batchRunEnd } from "../background/scheduler-job.js";
import { icDateItems } from "../services/inspection-certificate/ic-date-service.js";
import { icFiling } from "../services/inspection-certificate/ic-service.js";
import { slotText, istTime, todayRows, earlierText, editorTypes, lastErrorText, initSchedule, slotDetails, savedNotice, handleScheduleMessage } from "../popup/popup-schedule.js";
import { describeSkip, SKIP_REASON } from "../services/download-log.js";
import { EcmError } from "../services/ecm-service.js";
import { WorkflowError } from "../services/export-save-service.js";
import { DOCUMENT_DOWNLOAD_STATUS } from "../services/search-po/document-downloader.js";
import { describeError, MESSAGE_TYPES } from "../utils/messages.js";
import { readIrepsAccount, ACCOUNT_READ_ERROR } from "../services/ireps-account-service.js";
import { accountFromHomeDocument } from "../utils/ireps-account.js";

const T0 = Date.parse("2026-11-17T03:30:00Z"); // 09:00 IST
const ON = { enabled: true, types: [...SCHEDULE_TYPES], unknown: [], reason: null };
const ADMIN = { signedIn: true, user: { name: "Priya", permissions: ["read", "doclink.schedule.run", "doclink.schedule.manage"] } };
const ACCOUNT = { irepsAccountId: "833", operatingUnit: "Hosur" };

const slot = (id, docType, extra = {}) => ({ id, doc_type: docType, slot_date: "2026-11-17", status: "pending", ...extra });
const conflict = (code, extra = {}) => new ScheduleApiError(code, { status: 409, detail: code, ...extra });

/** A memory chrome.storage area. */
function memoryArea() {
  const data = new Map();
  return {
    data,
    get: async (key) => (data.has(key) ? { [key]: data.get(key) } : {}),
    set: async (items) => {
      for (const [k, v] of Object.entries(items)) data.set(k, v);
    }
  };
}

/** A scheduler on fakes. Every IREPS-facing step is counted. */
function harness(options = {}) {
  let clock = options.now ?? T0;
  const calls = { due: [], claim: [], finish: [], heartbeat: [], checkIreps: 0, whoAmI: 0, alarmsSet: [], alarmsCleared: 0, runs: [], failedCheck: 0, quiet: [] };
  const intervals = [];
  const timeouts = [];
  const signals = {
    account: async () => (options.account === undefined ? "833" : options.account),
    irepsReady: async () => (options.irepsReady === undefined ? true : options.irepsReady),
    recordIrepsCheckFailed: async () => void calls.failedCheck++,
    recordAccount: async (id) => void (calls.recordedAccount = id),
    quietUntil: async () => options.quietUntil || 0,
    setQuietUntil: async (ms) => void calls.quiet.push(ms)
  };
  let dueIndex = 0;
  const dues = options.dues || [{ due: [], running: null, next_check_at: new Date(T0 + 15 * 60000).toISOString(), slots: [] }];
  const api = {
    due: async (account, types) => {
      calls.due.push({ account, types });
      if (options.dueError) throw options.dueError;
      return dues[Math.min(dueIndex++, dues.length - 1)];
    },
    claim: async (req) => {
      calls.claim.push(req);
      const answer = options.claim ? options.claim(req) : { slot: { id: req.slotId }, params: { lookbackDays: 2, dateFrom: "16/11/2026", dateTo: "17/11/2026" } };
      if (answer instanceof Error) throw answer;
      return answer;
    },
    heartbeat: async (claimId) => {
      calls.heartbeat.push(claimId);
      if (options.heartbeatError) throw options.heartbeatError;
      return {};
    },
    finish: async (req) => void calls.finish.push(req)
  };
  const runnerFor = (type) => async (ctx) => {
    calls.runs.push({ type, ctx });
    if (options.during) await options.during(ctx, { intervals, advance: (ms) => (clock += ms) });
    return (options.outcomes && options.outcomes[type]) || { outcome: "done", result: { saved: 1 } };
  };
  const scheduler = createScheduler({
    loadConfig: async () => options.config || ON,
    api,
    whoAmI: async () => {
      calls.whoAmI++;
      return options.who || ADMIN;
    },
    signals,
    isBusy: () => options.busy === true,
    checkIreps: async () => {
      calls.checkIreps++;
      return options.check || { ok: true, account: ACCOUNT };
    },
    runners: Object.fromEntries(SCHEDULE_TYPES.map((t) => [t, runnerFor(t)])),
    alarms: { set: async (when) => void calls.alarmsSet.push(when), clear: async () => void calls.alarmsCleared++ },
    ...(options.runLog ? { runLog: options.runLog } : {}),
    now: () => clock,
    random: () => 0,
    uuid: (() => {
      let n = 0;
      return () => `claim-${++n}`;
    })(),
    // realTimers: none injected, so the scheduler uses the browser's own timers, as in the extension
    ...(options.realTimers
      ? {}
      : {
          timers: {
            setInterval: (fn, ms) => intervals.push({ fn, ms }) - 1,
            clearInterval: () => {},
            setTimeout: (fn, ms) => timeouts.push({ fn, ms }) - 1,
            clearTimeout: () => {}
          }
        })
  });
  return { scheduler, calls, intervals, timeouts, advance: (ms) => (clock += ms) };
}

/** A fake schedule API for the shared hooks: grants every key not listed as taken. */
function hooksApi({ taken = {}, reserveError = null, completeErrors = 0 } = {}) {
  const calls = { reserve: [], complete: [] };
  let failures = completeErrors;
  return {
    calls,
    reserve: async (req) => {
      calls.reserve.push(req);
      if (reserveError) throw reserveError;
      return { granted: req.keys.filter((k) => !taken[k]), taken: Object.fromEntries(req.keys.filter((k) => taken[k]).map((k) => [k, taken[k]])) };
    },
    complete: async (req) => {
      calls.complete.push(req);
      if (failures > 0) {
        failures--;
        throw new ScheduleApiError("SCHEDULE_BACKEND_UNAVAILABLE");
      }
      return { done: req.done.length, failed: req.failed.length };
    }
  };
}

const pdfItem = (n) => ({ id: `it-${n}`, log: { docType: "ic", key: `ic:PO${n}|1|C${n}` }, ecm: { kind: "inspectionCertificate", fields: { ic_number: `IC${n}` } } });
/** The shared hooks' details() of a run that listed nothing. */
const noDetails = () => ({ failures: [], saved: [], skipped: [], more: {} });

export async function runSchedulerTests({ test, assert, eq }) {
  /* ------------------------------------------------------------ settings */

  await test("schedular_phase1: on only with enabled: true and at least one known document type", () => {
    const on = parseSchedulerConfig({ schedular_phase1: { enabled: true, documents: ["BillStatus", "CRN", "RNote", "MA", "PO", "IC"] } });
    eq(on.enabled, true);
    eq(on.types.join(), "billStatus,crn,rnote,ma,poDate,icDate,icNotifications", "IC = both IC runs; run order kept");
    for (const block of [undefined, null, { enabled: false, documents: ["CRN"] }, { enabled: "true", documents: ["CRN"] }, { enabled: 1, documents: ["CRN"] }, { enabled: true }, { enabled: true, documents: [] }, { enabled: true, documents: "CRN" }, { enabled: true, documents: ["Tender"] }]) {
      eq(parseSchedulerConfig({ schedular_phase1: block }).enabled, false, `off for ${JSON.stringify(block)}`);
    }
    eq(parseSchedulerConfig(null).enabled, false, "an unreadable config is off");
  });

  await test("schedular_phase1: names ignore case; IC left out = no IC run; unknown names are reported", () => {
    const cfg = parseSchedulerConfig({ schedular_phase1: { enabled: true, documents: [" billstatus ", "RNOTE", "BilStatus", "po"] } });
    eq(cfg.types.join(), "billStatus,rnote,poDate");
    eq(cfg.unknown.join(), "BilStatus");
    assert(!cfg.types.includes("icDate") && !cfg.types.includes("icNotifications"), "no IC type");
  });

  /* ---------------------------------------------------- order of checks */

  await test("Scheduler: off -> no Recon call, no backend call, no IREPS call, the alarm is cleared", async () => {
    const h = harness({ config: { enabled: false, types: [], unknown: [], reason: "off" } });
    await h.scheduler.wake("alarm", { force: true });
    eq(h.calls.whoAmI, 0);
    eq(h.calls.due.length, 0);
    eq(h.calls.checkIreps, 0);
    eq(h.calls.alarmsCleared, 1);
  });

  await test("Scheduler: no Recon sign-in -> nothing asked of the backend or IREPS", async () => {
    const h = harness({ who: { signedIn: false } });
    await h.scheduler.wake("alarm", { force: true });
    eq(h.calls.due.length, 0);
    eq(h.calls.checkIreps, 0);
    eq(h.scheduler.getState().waitingFor, "recon");
  });

  await test("Scheduler: without doclink.schedule.run nothing is asked or claimed", async () => {
    const h = harness({ who: { signedIn: true, user: { name: "Viewer", permissions: ["read"] } } });
    await h.scheduler.wake("alarm", { force: true });
    eq(h.calls.due.length, 0);
    eq(h.scheduler.getState().waitingFor, "permission");
  });

  await test("Scheduler: unknown account and no IREPS activity -> no IREPS request", async () => {
    const h = harness({ account: null, irepsReady: false });
    await h.scheduler.wake("alarm", { force: true });
    eq(h.calls.checkIreps, 0);
    eq(h.calls.due.length, 0);
    eq(h.scheduler.getState().waitingFor, "account");
  });

  await test("Scheduler: unknown account but the user is active on IREPS -> the account is read once and kept", async () => {
    const h = harness({ account: null });
    await h.scheduler.wake("ireps page");
    eq(h.calls.checkIreps, 1);
    eq(h.calls.recordedAccount, "833");
    eq(h.calls.due[0].account, "833");
  });

  await test("Scheduler: nothing due -> no claim, no IREPS; alarm at the backend's next check; quiet until then", async () => {
    const next = new Date(T0 + 15 * 60000).toISOString();
    const h = harness({ dues: [{ due: [], running: null, next_check_at: next, slots: [] }] });
    await h.scheduler.wake("alarm", { force: true });
    eq(h.calls.claim.length, 0);
    eq(h.calls.checkIreps, 0);
    eq(h.calls.alarmsSet.at(-1), Date.parse(next), "alarm at the next tick (no jitter with random() = 0)");
    eq(h.calls.quiet.at(-1), Date.parse(next));
  });

  await test("Scheduler: due but the user is not active on IREPS -> no claim, no IREPS request; waits", async () => {
    const h = harness({ irepsReady: false, dues: [{ due: [slot(1, "billStatus")], running: null, next_check_at: new Date(T0 + 15 * 60000).toISOString(), slots: [] }] });
    await h.scheduler.wake("alarm", { force: true });
    eq(h.calls.claim.length, 0);
    eq(h.calls.checkIreps, 0);
    eq(h.scheduler.getState().waitingFor, "ireps");
  });

  await test("Scheduler: a manual job is running -> no claim", async () => {
    const h = harness({ busy: true, dues: [{ due: [slot(1, "crn")], running: null, next_check_at: null, slots: [] }] });
    await h.scheduler.wake("alarm", { force: true });
    eq(h.calls.claim.length, 0);
    eq(h.scheduler.getState().waitingFor, "busy");
  });

  /* ------------------------------------------------------ claims and runs */

  await test("Scheduler: the winner checks IREPS ONCE and runs the due types one after the other, in run order", async () => {
    const h = harness({
      dues: [
        { due: [slot(2, "crn"), slot(1, "billStatus")], running: null, next_check_at: null, slots: [] },
        { due: [slot(2, "crn")], running: null, next_check_at: null, slots: [] },
        { due: [], running: null, next_check_at: null, slots: [] }
      ]
    });
    await h.scheduler.wake("ireps page");
    eq(h.calls.runs.map((r) => r.type).join(), "billStatus,crn");
    eq(h.calls.checkIreps, 1, "one IREPS check for the whole wake");
    eq(h.calls.finish.map((f) => f.outcome).join(), "done,done");
    eq(h.calls.claim[0].slotId, 1);
    eq(h.calls.runs[0].ctx.account.irepsAccountId, "833", "the verified account goes to the run");
    eq(h.calls.runs[0].ctx.params.dateFrom, "16/11/2026", "the claim's date range goes to the run");
  });

  await test("Scheduler (5.6): one IREPS check covers the next slot only for ACCOUNT_CHECK_MS; after a longer run another account logged in gets no download", async () => {
    const dues = () => [
      { due: [slot(2, "crn"), slot(1, "billStatus")], running: null, next_check_at: null, slots: [] },
      { due: [slot(2, "crn")], running: null, next_check_at: null, slots: [] },
      { due: [], running: null, next_check_at: null, slots: [] }
    ];
    const quick = harness({ dues: dues(), during: async (ctx, { advance }) => void advance(ACCOUNT_CHECK_MS) });
    await quick.scheduler.wake("ireps page");
    eq(quick.calls.runs.map((r) => r.type).join(), "billStatus,crn");
    eq(quick.calls.checkIreps, 1, "a run that ended within ACCOUNT_CHECK_MS: the next slot runs on the same check");

    // the Bill Status run takes 40 minutes, and meanwhile IREPS account 60828 is logged in here
    const opts = { dues: dues() };
    opts.during = async (ctx, { advance }) => {
      if (ctx.slot.doc_type !== "billStatus") return;
      advance(40 * 60000);
      opts.check = { ok: true, account: { irepsAccountId: "60828" } };
    };
    const long = harness(opts);
    await long.scheduler.wake("ireps page");
    eq(long.calls.runs.map((r) => r.type).join(), "billStatus", "the CRN slot never runs for 833 while 60828 is logged in");
    eq(long.calls.checkIreps, 2, "the CRN slot had a check of its own");
    eq(long.calls.claim.map((c) => c.slotId).join(), "1,2", "made only after its claim was won");
    eq(long.calls.finish[1].code, "SCHEDULE_ACCOUNT_MISMATCH");
    eq(long.calls.finish[1].countsAsAttempt, false, "given back, no attempt counted");
    eq(long.calls.recordedAccount, "60828");
  });

  await test("Scheduler (5.6): after a longer run with no IREPS page loaded since, the next slot waits for one; nothing is claimed or sent to IREPS", async () => {
    const opts = {
      dues: [
        { due: [slot(2, "crn"), slot(1, "billStatus")], running: null, next_check_at: null, slots: [] },
        { due: [slot(2, "crn")], running: null, next_check_at: null, slots: [] }
      ]
    };
    opts.during = async (ctx, { advance }) => {
      advance(40 * 60000);
      opts.irepsReady = false; // the last IREPS page load is older than IREPS_ACTIVITY_MS now
    };
    const h = harness(opts);
    await h.scheduler.wake("ireps page");
    eq(h.calls.runs.map((r) => r.type).join(), "billStatus");
    eq(h.calls.claim.length, 1, "the CRN slot is not claimed");
    eq(h.calls.checkIreps, 1, "and IREPS is not asked");
    eq(h.scheduler.getState().waitingFor, "ireps");
  });

  await test("Scheduler: another DocLink runs the account (409) -> no IREPS request; looks again soon", async () => {
    const h = harness({
      dues: [{ due: [slot(1, "billStatus")], running: null, next_check_at: new Date(T0 + 15 * 60000).toISOString(), slots: [] }],
      claim: () => conflict("SCHEDULE_ACCOUNT_BUSY", { holder: { user_id: 4, name: "Rahul" } })
    });
    await h.scheduler.wake("ireps page");
    eq(h.calls.checkIreps, 0);
    eq(h.calls.runs.length, 0);
    eq(h.scheduler.getState().running.holder.name, "Rahul");
    eq(h.calls.alarmsSet.at(-1), T0 + RUNNING_POLL_MS);
  });

  await test("Scheduler: a slot already done (409 SLOT_DONE) is passed over for the next one", async () => {
    const h = harness({
      dues: [{ due: [slot(1, "billStatus"), slot(2, "crn")], running: null, next_check_at: null, slots: [] }, { due: [], running: null, next_check_at: null, slots: [] }],
      claim: (req) => (req.slotId === 1 ? conflict("SCHEDULE_SLOT_DONE") : { params: {} })
    });
    await h.scheduler.wake("ireps page");
    eq(h.calls.runs.map((r) => r.type).join(), "crn");
  });

  await test("Scheduler: the winner's IREPS check fails -> slot given back without an attempt; no claim again until a new page load", async () => {
    const h = harness({ check: { ok: false, code: "SCHEDULE_ACCOUNT_UNVERIFIED" }, dues: [{ due: [slot(1, "billStatus")], running: null, next_check_at: null, slots: [] }] });
    await h.scheduler.wake("ireps page");
    eq(h.calls.runs.length, 0);
    eq(h.calls.finish.length, 1);
    eq(h.calls.finish[0].outcome, "failed");
    eq(h.calls.finish[0].countsAsAttempt, false);
    eq(h.calls.failedCheck, 1, "recorded, so this DocLink waits for a new IREPS page");
  });

  /** A run log on fakes: what the scheduler wrote. */
  const fakeRunLog = () => {
    const log = { events: [], started: [], finished: [] };
    return { log, event: (kind, text, types) => void log.events.push({ kind, text, types }), runStarted: (run) => void log.started.push(run), runFinished: (id, outcome) => void log.finished.push({ id, outcome }) };
  };

  await test("Scheduler: IREPS not responding to the winner's check -> given back, said so (never 'not logged in'), asked again at the next check", async () => {
    const runLog = fakeRunLog();
    const h = harness({ check: { ok: false, code: "IREPS_UNAVAILABLE", detail: "the home page answered HTTP 503" }, dues: [{ due: [slot(1, "billStatus")], running: null, next_check_at: null, slots: [] }], runLog });
    await h.scheduler.wake("ireps page");
    eq(h.calls.runs.length, 0);
    eq(h.calls.finish[0].code, "IREPS_UNAVAILABLE");
    eq(h.calls.finish[0].countsAsAttempt, false);
    eq(h.calls.failedCheck, 0, "not recorded: the next alarm or page load asks IREPS again");
    const text = runLog.log.events.at(-1).text;
    assert(/^Bill Status: claimed, but IREPS could not be checked here: IREPS not responding \(the home page answered HTTP 503\); given back/.test(text), text);
    assert(!/not logged in/.test(text), text);
  });

  await test("Scheduler (1.12): a claim given back because IREPS did not answer or another account is logged in never asks to log in to IREPS (no '!' badge)", async () => {
    const due = () => [{ due: [slot(1, "billStatus")], running: null, next_check_at: null, slots: [] }];
    const unavailable = harness({ check: { ok: false, code: "IREPS_UNAVAILABLE", detail: "the home page answered HTTP 503" }, dues: due() });
    await unavailable.scheduler.wake("ireps page");
    const u = unavailable.scheduler.getState();
    eq(u.waitingFor, null, "not 'open IREPS (logged in)': the user is logged in");
    eq(JSON.stringify(u.lastError), JSON.stringify({ code: "IREPS_UNAVAILABLE", detail: "the home page answered HTTP 503" }));
    eq(lastErrorText(u.lastError), "Last check failed: IREPS not responding (the home page answered HTTP 503).");
    const other = harness({ check: { ok: true, account: { irepsAccountId: "60828" } }, dues: due() });
    await other.scheduler.wake("ireps page");
    const o = other.scheduler.getState();
    eq(o.waitingFor, null);
    eq(o.lastError.code, "SCHEDULE_ACCOUNT_MISMATCH");
    eq(o.lastError.detail, "IREPS account 60828 is logged in here, not 833");
    const loggedOut = harness({ check: { ok: false, code: "IREPS_SESSION_EXPIRED", detail: "IREPS answered with its login page" }, dues: due() });
    await loggedOut.scheduler.wake("ireps page");
    eq(loggedOut.scheduler.getState().waitingFor, "ireps", "IREPS's login page: log in to IREPS (and the badge)");
  });

  await test("Scheduler (1.12): a claim given back because a manual run took the job first (BUSY) waits for that run, and goes on at once when it has ended", async () => {
    const dues = () => [{ due: [slot(1, "crn")], running: null, next_check_at: null, slots: [] }, { due: [], running: null, next_check_at: null, slots: [] }];
    const factory = createRunnerFactory({ api: {}, makeHooks: () => ({ saveExport: () => {}, stats: () => ({}), details: noDetails }) });
    const taken = await factory.exportRunner(async () => ({ started: false, error: { code: "DOCUMENT_BUSY" } }))({});
    eq(JSON.stringify([taken.outcome, taken.countsAsAttempt, taken.waitForJob]), JSON.stringify(["failed", false, true]));
    const opts = { dues: dues(), outcomes: { crn: taken }, during: async () => void (opts.busy = true) };
    const waiting = harness(opts);
    await waiting.scheduler.wake("ireps page");
    eq(waiting.scheduler.getState().waitingFor, "busy", "so scheduler-job.js jobEnded wakes it when that run ends");
    const ended = harness({ dues: dues(), outcomes: { crn: taken } });
    await ended.scheduler.wake("ireps page");
    for (let i = 0; i < 50 && ended.calls.due.length < 2; i++) await new Promise((r) => setTimeout(r, 0));
    eq(ended.calls.due.length, 2, "the run that held the job had ended already: looked again at once");
  });

  await test("Scheduler: the winner's check meets IREPS's login page -> 'IREPS is not logged in here', recorded", async () => {
    const runLog = fakeRunLog();
    const h = harness({ check: { ok: false, code: "IREPS_SESSION_EXPIRED", detail: "IREPS answered with its login page" }, dues: [{ due: [slot(1, "billStatus")], running: null, next_check_at: null, slots: [] }], runLog });
    await h.scheduler.wake("ireps page");
    eq(h.calls.finish[0].code, "IREPS_SESSION_EXPIRED");
    eq(h.calls.failedCheck, 1);
    const text = runLog.log.events.at(-1).text;
    assert(/^Bill Status: claimed, but IREPS is not logged in here; given back/.test(text), text);
  });

  await test("Scheduler: the first account read meets a busy IREPS -> waits for the account, the next check may try again", async () => {
    const runLog = fakeRunLog();
    const h = harness({ account: null, check: { ok: false, code: "IREPS_UNAVAILABLE", detail: "the home page answered HTTP 502" }, runLog });
    await h.scheduler.wake("ireps page");
    eq(h.scheduler.getState().waitingFor, "account");
    eq(h.calls.failedCheck, 0);
    eq(runLog.log.events.at(-1).text, "The IREPS account could not be read: IREPS not responding (the home page answered HTTP 502).");
  });

  /** IREPS home-page answers for readIrepsAccount, as fetch gives them. */
  const HOME_833 = '<html><head><title>Bidder Home Page</title></head><body><table><tr><td class="welcomeLabel">A GIRIJA , FAIVELEY TRANSPORT RAIL TECHNOLOGIES INDIA PRIVATE LIMITED-HOSUR (IREPS ID- 833)</td></tr></table><a href="/epsn/home/logout.do">Log Out</a></body></html>';
  const LOGIN_PAGE = '<html><head><title>Log into IREPS</title></head><body><form name="LogonForm" method="post" action="/epsn/home/userLoginAction.do"></form></body></html>';
  const parseHome = async (html) => accountFromHomeDocument(new DOMParser().parseFromString(html, "text/html"), html);
  /** A fake fetch answering from `list` in turn (the last one again after that); an Error is thrown. */
  const answers = (...list) => {
    const calls = [];
    const fetch = async (url, init) => {
      calls.push({ url, init });
      const a = list[Math.min(calls.length - 1, list.length - 1)];
      if (a instanceof Error) throw a;
      const response = new Response(a.body ?? "", { status: a.status ?? 200 });
      if (a.url) Object.defineProperty(response, "url", { value: a.url });
      return response;
    };
    return { calls, fetch };
  };
  const readAccount = (fake, extra = {}) => readIrepsAccount({ baseUrl: "https://www.ireps.gov.in", parse: parseHome, fetch: fake.fetch, sleep: async () => {}, ...extra });

  await test("IREPS account read: the home page -> the account; 502 / 503 / 504 asked again first; the same GET as before", async () => {
    const busyThenHome = answers({ status: 503 }, { status: 502 }, { body: HOME_833 });
    const r = await readAccount(busyThenHome);
    eq(r.ok, true);
    eq(r.account.irepsAccountId, "833");
    eq(r.account.operatingUnit, "HOSUR");
    eq(busyThenHome.calls.length, 3);
    eq(busyThenHome.calls[0].url, "https://www.ireps.gov.in/epsn/home/showHome.do");
    eq(busyThenHome.calls[0].init.credentials, "include");
    eq(busyThenHome.calls[0].init.method, undefined, "a GET");
  });

  await test("IREPS account read: IREPS not answering is IREPS_UNAVAILABLE, never 'not logged in'", async () => {
    const busy = answers({ status: 503 });
    const r = await readAccount(busy);
    eq(r.code, ACCOUNT_READ_ERROR.UNAVAILABLE);
    eq(r.detail, "the home page answered HTTP 503");
    eq(busy.calls.length, 3, "the first try and two more");
    const serverError = answers({ status: 500 });
    eq((await readAccount(serverError)).code, "IREPS_UNAVAILABLE");
    eq(serverError.calls.length, 1, "a 500 is not asked again");
    const offline = answers(new TypeError("Failed to fetch"));
    eq((await readAccount(offline)).code, "IREPS_UNAVAILABLE");
    eq(offline.calls.length, 3);
    const busyPage = answers({ body: "<html><body><p>The server is busy. Please try after some time.</p></body></html>" });
    eq((await readAccount(busyPage)).code, "IREPS_UNAVAILABLE", "a page that is neither the home page nor the login page");
    const stalled = { fetch: (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))) };
    const late = await readAccount(stalled, { settings: { timeoutMs: 20, retryDelaysMs: [1, 1] } });
    eq(late.code, "IREPS_UNAVAILABLE");
    assert(/did not answer/.test(late.detail), late.detail);
    eq(describeError("IREPS_UNAVAILABLE").title, "IREPS not responding");
  });

  await test("IREPS account read: only IREPS's login page (or a password form) is IREPS_SESSION_EXPIRED; no account line is unverified", async () => {
    eq((await readAccount(answers({ body: LOGIN_PAGE }))).code, ACCOUNT_READ_ERROR.SESSION_EXPIRED);
    eq((await readAccount(answers({ body: "<html><body>x</body></html>", url: "https://www.ireps.gov.in/epsn/home/userLogin.do" }))).code, "IREPS_SESSION_EXPIRED", "redirected to the login");
    eq((await readAccount(answers({ status: 403, body: LOGIN_PAGE }))).code, "IREPS_SESSION_EXPIRED", "the login page, whatever its HTTP status");
    eq((await readAccount(answers({ body: '<form action="/x.do"><input type="password" name="p"></form>' }))).code, "IREPS_SESSION_EXPIRED");
    eq((await readAccount(answers({ body: '<html><body><p>Welcome</p><a href="/epsn/home/logout.do">Log Out</a></body></html>' }))).code, ACCOUNT_READ_ERROR.UNVERIFIED);
    const unconfigured = answers({ body: HOME_833 });
    eq((await readIrepsAccount({ baseUrl: "", parse: parseHome, fetch: unconfigured.fetch })).code, "IREPS_NOT_CONFIGURED");
    eq(unconfigured.calls.length, 0, "nothing is sent without a portal");
  });

  await test("Scheduler: logged in to another IREPS account -> SCHEDULE_ACCOUNT_MISMATCH, not run", async () => {
    const h = harness({ check: { ok: true, account: { irepsAccountId: "60828" } }, dues: [{ due: [slot(1, "ma")], running: null, next_check_at: null, slots: [] }] });
    await h.scheduler.wake("ireps page");
    eq(h.calls.runs.length, 0);
    eq(h.calls.finish[0].code, "SCHEDULE_ACCOUNT_MISMATCH");
    eq(h.calls.recordedAccount, "60828", "the account now logged in is remembered");
  });

  await test("Scheduler: an expired IREPS session ends the wake (the next slot is not claimed)", async () => {
    const h = harness({
      dues: [{ due: [slot(1, "billStatus"), slot(2, "crn")], running: null, next_check_at: null, slots: [] }],
      outcomes: { billStatus: failedOutcome("IREPS_SESSION_EXPIRED") }
    });
    await h.scheduler.wake("ireps page");
    eq(h.calls.claim.length, 1);
    eq(h.calls.finish[0].countsAsAttempt, false, "a lost session is no attempt");
  });

  await test("Scheduler: heartbeat every 2 minutes; CLAIM_LOST makes the run see a lost claim", async () => {
    let liveAfter = null;
    const h = harness({
      heartbeatError: conflict("SCHEDULE_CLAIM_LOST"),
      dues: [{ due: [slot(1, "icDate")], running: null, next_check_at: null, slots: [] }, { due: [], running: null, next_check_at: null, slots: [] }],
      during: async (ctx, { intervals }) => {
        eq(intervals[0].ms, HEARTBEAT_MS);
        assert(ctx.isClaimLive(), "live at the start");
        await intervals[0].fn();
        liveAfter = ctx.isClaimLive();
      }
    });
    await h.scheduler.wake("ireps page");
    eq(liveAfter, false);
    eq(h.calls.finish[0].code, "SCHEDULE_CLAIM_LOST");
  });

  await test("Scheduler: a heartbeat older than the lease minus one beat counts as lost (no upload after it)", async () => {
    let live = null;
    const h = harness({
      dues: [{ due: [slot(1, "poDate")], running: null, next_check_at: null, slots: [] }, { due: [], running: null, next_check_at: null, slots: [] }],
      during: async (ctx, { advance }) => {
        advance(LEASE_MS - HEARTBEAT_MS + 1);
        live = ctx.isClaimLive();
      }
    });
    await h.scheduler.wake("ireps page");
    eq(live, false);
  });

  await test("Scheduler: triggers within 15 s make one wake; a quiet period skips IREPS page loads", async () => {
    const h = harness();
    await h.scheduler.wake("ireps page");
    for (let i = 0; i < 4; i++) await h.scheduler.wake("ireps page");
    eq(h.calls.whoAmI, 1, "one wake");
    eq(h.timeouts.length, 1, "one deferred wake at the end of the window");
    assert(h.timeouts[0].ms <= DEBOUNCE_MS);
    const quiet = harness({ quietUntil: T0 + 60000 });
    await quiet.scheduler.wake("ireps page", { quietable: true });
    eq(quiet.calls.whoAmI, 0, "quiet: no call at all");
    await quiet.scheduler.wake("alarm", { force: true, quietable: false });
    eq(quiet.calls.whoAmI, 1, "the alarm still runs");
  });

  await test("Scheduler: with the browser's own timers (none injected) a claimed slot runs, and a trigger inside 15 s is deferred", async () => {
    // Chrome throws "Illegal invocation" when its timer functions are called as methods of another object
    const h = harness({
      realTimers: true,
      dues: [
        { due: [slot(1, "ma")], running: null, next_check_at: null, slots: [] },
        { due: [], running: null, next_check_at: null, slots: [] }
      ]
    });
    await h.scheduler.wake("ireps page");
    eq(h.calls.runs.map((r) => r.type).join(), "ma", "the claimed slot ran (the heartbeat timer started)");
    eq(h.calls.finish.map((f) => f.outcome).join(), "done", "and its end was reported");
    eq(h.scheduler.getState().lastError, null);
    await h.scheduler.wake("ireps page");
    eq(h.calls.whoAmI, 1, "a trigger right after the wake is deferred, not thrown");
  });

  await test("Scheduler: IC not in schedular_phase1 -> IC types are not asked for, and an IC slot is never claimed", async () => {
    const cfg = parseSchedulerConfig({ schedular_phase1: { enabled: true, documents: ["BillStatus", "CRN", "RNote", "MA", "PO"] } });
    const h = harness({ config: cfg, dues: [{ due: [slot(9, "icDate"), slot(10, "icNotifications")], running: null, next_check_at: null, slots: [] }] });
    await h.scheduler.wake("ireps page");
    assert(!h.calls.due[0].types.includes("icDate") && !h.calls.due[0].types.includes("icNotifications"), "not asked for");
    eq(h.calls.claim.length, 0, "an IC slot the backend returns anyway is not claimed");
    eq(h.calls.runs.length, 0);
  });

  await test("Scheduler: why a due download did not run here goes to the run log, in plain words, with its types", async () => {
    const due = { due: [slot(2, "crn"), slot(1, "billStatus")], running: null, next_check_at: null, slots: [] };
    const notOnIreps = fakeRunLog();
    await harness({ irepsReady: false, dues: [due], runLog: notOnIreps }).scheduler.wake("alarm", { force: true });
    const ireps = notOnIreps.log.events.at(-1);
    eq(ireps.kind, "ireps");
    assert(/^Due now: Bill Status, CRN\. Waiting for IREPS/.test(ireps.text), ireps.text);
    eq(ireps.types.join(), "billStatus,crn");

    const busy = fakeRunLog();
    await harness({ busy: true, dues: [due], runLog: busy }).scheduler.wake("alarm", { force: true });
    eq(busy.log.events.at(-1).kind, "busy");

    const other = fakeRunLog();
    await harness({ dues: [due], runLog: other, claim: () => conflict("SCHEDULE_ACCOUNT_BUSY", { holder: { user_id: 4, name: "Rahul" }, docType: "ma" }) }).scheduler.wake("ireps page");
    eq(other.log.events.at(-1).text, "MA copies: being run by Rahul; this browser looks again in a few minutes.");

    const handedBack = fakeRunLog();
    await harness({ check: { ok: true, account: { irepsAccountId: "60828" } }, dues: [{ due: [slot(1, "ma")], running: null, next_check_at: null, slots: [] }], runLog: handedBack }).scheduler.wake("ireps page");
    assert(/^MA copies: claimed, but IREPS account 60828 is logged in here, not 833; given back/.test(handedBack.log.events.at(-1).text), handedBack.log.events.at(-1).text);

    const signedOut = fakeRunLog();
    await harness({ who: { signedIn: false }, runLog: signedOut }).scheduler.wake("alarm", { force: true });
    eq(signedOut.log.events.at(-1).kind, "recon");
  });

  await test("Scheduler: each run goes to the run log with its range, how it ended and the documents it could not save", async () => {
    const runLog = fakeRunLog();
    const failures = [{ doc: "Tender 1 - NIT", code: "ECM_UNAVAILABLE", detail: "the ECM did not answer" }];
    const h = harness({
      runLog,
      dues: [{ due: [slot(1, "billStatus"), slot(2, "tenderNit", { period: "10:30" })], running: null, next_check_at: null, slots: [] }, { due: [slot(2, "tenderNit", { period: "10:30" })], running: null, next_check_at: null, slots: [] }, { due: [], running: null, next_check_at: null, slots: [] }],
      outcomes: { tenderNit: { outcome: "partial", code: "SCHEDULE_DOWNLOAD_FAILED", result: { saved: 3, failed: 1, failures }, log: { failures, saved: [], skipped: [] } } }
    });
    await h.scheduler.wake("ireps page");
    eq(runLog.log.started.map((r) => `${r.docType}|${r.range}|${r.account}|${r.period || ""}`).join(), "billStatus|Last 90 Days|833|,tenderNit|16/11/2026 - 17/11/2026|833|10:30");
    eq(runLog.log.finished.map((f) => `${f.id}|${f.outcome.outcome}`).join(), "claim-1|done,claim-2|partial");
    eq(runLog.log.finished[1].outcome.log.failures[0].doc, "Tender 1 - NIT", "the full list goes to the run log");
    assert(!("log" in h.calls.finish[1]), "the run log's lists are not sent to the Recon Engine");
    eq(h.calls.finish[1].result.failures[0].code, "ECM_UNAVAILABLE", "the slot's result names the failed document for every user");
  });

  await test("Scheduler: the result sent with finish never exceeds what the Recon Engine accepts", async () => {
    const long = "x".repeat(400);
    const failures = Array.from({ length: 60 }, (_, i) => ({ doc: `PO ${i} ${long}`, code: "ECM_UNAVAILABLE", detail: long }));
    const h = harness({ dues: [{ due: [slot(1, "poDate")], running: null, next_check_at: null, slots: [] }, { due: [], running: null, next_check_at: null, slots: [] }], outcomes: { poDate: { outcome: "partial", code: "SCHEDULE_DOWNLOAD_FAILED", result: { saved: 1, failed: 60, failures } } } });
    await h.scheduler.wake("ireps page");
    const sent = h.calls.finish[0].result;
    assert(JSON.stringify(sent).length <= RESULT_MAX_CHARS, `${JSON.stringify(sent).length} characters`);
    eq(sent.failures.length + sent.failuresMore, 60, "what does not fit is counted");
  });

  /* -------------------------------------------------------------- runners */

  await test("Runners: an export saved -> done; an identical export already saved -> done (skipped), never retried", async () => {
    const statsFor = { saved: 1, skipped: 0, failed: 0, notReported: 0 };
    const factory = createRunnerFactory({ api: {}, makeHooks: () => ({ saveExport: () => {}, stats: () => statsFor, details: noDetails }) });
    const run = factory.exportRunner(async () => ({ started: true, done: Promise.resolve({ ok: true, summary: { recordCount: 12, storedPath: "s3://x" } }) }));
    const done = await run({});
    eq(done.outcome, "done");
    eq(done.result.records, 12);
    Object.assign(statsFor, { saved: 0, skipped: 1 });
    const skipped = await run({});
    eq(skipped.outcome, "done");
    eq(skipped.result.skipped, 1);
  });

  await test("Runners (1.11): IREPS saying it has no record is done, nothing new; never a failed run retried every 10 minutes", async () => {
    const factory = createRunnerFactory({ api: {}, makeHooks: () => ({ saveExport: () => {}, stats: () => ({ saved: 0, skipped: 0, failed: 0, notReported: 0 }), details: noDetails }) });
    for (const code of ["IREPS_NO_RECORDS", "IREPS_CRN_NOT_FOUND", "IREPS_RNOTE_NOT_FOUND"]) {
      const run = await factory.exportRunner(async () => ({ started: true, done: Promise.resolve({ ok: false, code }) }))({ slot: { doc_type: "crn" }, params: { dateTo: "18/11/2026" } });
      eq(run.outcome, "done", code);
      eq(run.result.records, 0);
      eq(slotText({ status: "done", done_by: { name: "Priya" }, ended_at: "2026-11-18T04:00:00Z", result: run.result }), "Done by Priya at 09:30 · nothing new in IREPS");
    }
    const unrecognised = await factory.exportRunner(async () => ({ started: true, done: Promise.resolve({ ok: false, code: "IREPS_CRN_RESULTS_INVALID" }) }))({});
    eq(unrecognised.outcome, "failed", "a page DocLink does not recognise is no 'nothing found'");
  });

  await test("Runners (1.1): a CRN / R-NOTE list short of IREPS's total is not done (retried), and says the shortfall", async () => {
    let stats = { saved: 1, skipped: 0, failed: 0, notReported: 0 };
    const factory = createRunnerFactory({ api: {}, makeHooks: () => ({ saveExport: () => {}, stats: () => stats, details: noDetails }) });
    const incomplete = "IREPS reported 500 CRN result(s) but 450 were read";
    const start = async () => ({ started: true, done: Promise.resolve({ ok: true, summary: { recordCount: 450, storedPath: "s3://bronze/crn/CRN.xlsx", incomplete } }) });
    const short = await factory.exportRunner(start)({ slot: { doc_type: "crn" }, params: { dateTo: "18/11/2026" } });
    eq(JSON.stringify([short.outcome, short.code, short.result.records, short.result.warnings]), JSON.stringify(["partial", "SCHEDULE_LIST_INCOMPLETE", 450, [incomplete]]));
    stats = { saved: 0, skipped: 1, failed: 0, notReported: 0 };
    const again = await factory.exportRunner(start)({ slot: { doc_type: "crn" }, params: {} });
    eq(JSON.stringify([again.outcome, again.code, again.countsAsAttempt]), JSON.stringify(["failed", "SCHEDULE_LIST_INCOMPLETE", true]), "the same short list was already saved: still not done");
    eq(describeError("SCHEDULE_LIST_INCOMPLETE").title, "IREPS list not read in full");
  });

  await test("Runners: a manual run holds the job -> given back without an attempt; a lost session -> no attempt", async () => {
    const factory = createRunnerFactory({ api: {}, makeHooks: () => ({ saveExport: () => {}, stats: () => ({}), details: noDetails }) });
    const busy = await factory.exportRunner(async () => ({ started: false, error: { code: "DOCUMENT_BUSY" } }))({});
    eq(busy.outcome, "failed");
    eq(busy.countsAsAttempt, false);
    const expired = await factory.exportRunner(async () => ({ started: true, done: Promise.resolve({ ok: false, code: "IREPS_SESSION_EXPIRED" }) }))({});
    eq(expired.countsAsAttempt, false);
    eq(expired.sessionExpired, true);
    eq(failedOutcome("RECON_NOT_CONFIGURED").permanent, true);
    eq(failedOutcome("IREPS_REQUEST_FAILED").countsAsAttempt, true);
  });

  await test("Runners: documents with failures -> partial; all saved -> done; a lost claim -> failed", async () => {
    let counts = { saved: 3, skipped: 1, failed: 1, notReported: 0, aborted: null };
    const factory = createRunnerFactory({ api: {}, makeHooks: () => ({ documentHooks: {}, finishDocuments: async () => counts, details: noDetails }) });
    const run = factory.documentRunner(async () => ({ started: true, done: Promise.resolve({ ok: true, items: [{}, {}, {}, {}, {}] }) }));
    eq((await run({})).outcome, "partial");
    counts = { ...counts, failed: 0 };
    eq((await run({})).outcome, "done");
    counts = { ...counts, aborted: "SCHEDULE_CLAIM_LOST" };
    const lost = await run({});
    eq(lost.outcome, "failed");
    eq(lost.code, "SCHEDULE_CLAIM_LOST");
  });

  await test("Runners (1.7, 1.2): rows without a PDF link, failed searches and short lists are named; partial when something was saved, failed when nothing was", async () => {
    let counts = { saved: 2, skipped: 0, failed: 0, notReported: 0, aborted: null };
    const factory = createRunnerFactory({ api: {}, makeHooks: () => ({ documentHooks: {}, finishDocuments: async () => counts, details: noDetails }) });
    const run = (end) => factory.documentRunner(async () => ({ started: true, done: Promise.resolve({ ok: true, ...end }) }))({ slot: { doc_type: "poDate" }, params: { dateFrom: "17/11/2026", dateTo: "18/11/2026" } });
    const noLink = { id: "po-3", label: "PO 27253922000301", status: "skipped", error: { code: "IREPS_PO_LINK_NOT_FOUND", detail: "IREPS did not provide a PO PDF link for this row" } };
    const alreadySaved = { id: "po-4", label: "PO 4", status: "skipped", skip: { reason: "already_saved_for_account" }, error: null };

    const rows = await run({ items: [{ id: "po-1", status: "completed" }, { id: "po-2", status: "completed" }, noLink, alreadySaved] });
    eq(JSON.stringify([rows.outcome, rows.code, rows.result.failed]), JSON.stringify(["partial", "IREPS_PO_LINK_NOT_FOUND", 1]), "a row never fetched is not 'done' (1.7)");
    eq(JSON.stringify(rows.result.failures), JSON.stringify([{ doc: "PO 27253922000301", code: "IREPS_PO_LINK_NOT_FOUND", detail: "IREPS did not provide a PO PDF link for this row" }]));
    eq(rows.log.failures.length, 1, "the run log names it too");

    counts = { saved: 0, skipped: 0, failed: 0, notReported: 0, aborted: null };
    const searches = await run({ items: [], problems: [{ doc: "Notification 77 (PO 27253922100240 Sr. 001)", code: "IREPS_IC_SEARCH_FAILED", detail: "IREPS returned HTTP 503" }] });
    eq(JSON.stringify([searches.outcome, searches.code, searches.countsAsAttempt]), JSON.stringify(["failed", "IREPS_IC_SEARCH_FAILED", true]), "no IC read: never 'done, nothing new in IREPS' (1.2)");
    eq(searches.result.failures[0].doc, "Notification 77 (PO 27253922100240 Sr. 001)");
    const line = slotText({ status: "failed", code: searches.code, result: searches.result });
    assert(!/nothing new/.test(line) && line.includes("1 failed"), line);

    counts = { saved: 3, skipped: 0, failed: 0, notReported: 0, aborted: null };
    const shortList = "IC dates 17/11/2026 to 18/11/2026: IREPS reported 5 inspection calls but 3 were read; some ICs may be missing.";
    const short = await run({ items: [{}, {}, {}], warnings: [shortList] });
    eq(JSON.stringify([short.outcome, short.code, short.result.warnings]), JSON.stringify(["partial", "SCHEDULE_LIST_INCOMPLETE", [shortList]]));
    eq(slotDetails({ id: 9, doc_type: "icDate", status: "partial", code: short.code, result: short.result }).warnings.join(), shortList, "the Schedule view lists the warning");

    counts = { saved: 0, skipped: 2, failed: 1, notReported: 0, aborted: null };
    eq((await run({ items: [{}, {}, {}] })).outcome, "failed", "nothing saved and a document failed: failed, not partial");
    counts = { saved: 0, skipped: 2, failed: 0, notReported: 0, aborted: null };
    eq((await run({ items: [{}, {}] })).outcome, "done", "everything already saved: done");
  });

  await test("Scheduled batches (1.2, 4.3): a batch's list warnings and the notifications it could not read reach the runner", () => {
    const end = batchRunEnd({ phase: "complete", items: [{ id: "ic-1" }], sessionExpired: false, warnings: ["short"], problems: [{ doc: "Notification 1", code: "IREPS_IC_SEARCH_FAILED", detail: null }] });
    eq(JSON.stringify([end.ok, end.items.length, end.warnings, end.problems.map((p) => p.code)]), JSON.stringify([true, 1, ["short"], ["IREPS_IC_SEARCH_FAILED"]]));
    const stopped = batchRunEnd({ phase: "error", error: { code: "IREPS_NOTIFICATIONS_FAILED", message: "DocLink could not read the notifications" }, items: [] });
    eq(JSON.stringify([stopped.ok, stopped.code, stopped.detail]), JSON.stringify([false, "IREPS_NOTIFICATIONS_FAILED", "DocLink could not read the notifications"]));
  });

  await test("Runners: the result names the failed documents (the first 20, then how many more) and the range; the log has them all", async () => {
    const failures = Array.from({ length: 25 }, (_, i) => ({ doc: `PO ${i}`, code: "ECM_UNAVAILABLE", detail: "the ECM did not answer in time" }));
    const details = () => ({ failures, saved: [{ doc: "PO 99", note: "PO_99.pdf in the ECM" }], skipped: [], more: {} });
    const docs = createRunnerFactory({ api: {}, makeHooks: () => ({ documentHooks: {}, finishDocuments: async () => ({ saved: 1, skipped: 0, failed: 25, notReported: 0, aborted: null }), details }) });
    const ctx = { slot: { doc_type: "poDate" }, params: { dateFrom: "17/11/2026", dateTo: "18/11/2026" } };
    const partial = await docs.documentRunner(async () => ({ started: true, done: Promise.resolve({ ok: true, items: new Array(26).fill({}) }) }))(ctx);
    eq(partial.outcome, "partial");
    eq(JSON.stringify([partial.result.range, partial.result.failures.length, partial.result.failuresMore, partial.result.failures[0].doc]), JSON.stringify(["17/11/2026 - 18/11/2026", RESULT_FAILURES_MAX, 5, "PO 0"]));
    eq(partial.log.failures.length, 25, "the run log keeps every failed document");

    const exports = createRunnerFactory({ api: {}, makeHooks: () => ({ saveExport: () => {}, stats: () => ({ saved: 0, skipped: 0, failed: 0, notReported: 0 }), details: noDetails }) });
    const failed = await exports.exportRunner(async () => ({ started: true, done: Promise.resolve({ ok: false, code: "IREPS_REQUEST_FAILED", detail: "IREPS did not respond in time" }) }))({ slot: { doc_type: "crn" }, params: { dateTo: "18/11/2026" } });
    eq(JSON.stringify([failed.outcome, failed.code, failed.result.detail, failed.result.range]), JSON.stringify(["failed", "IREPS_REQUEST_FAILED", "IREPS did not respond in time", "21/08/2026 - 18/11/2026"]));
  });

  /* --------------------------------------------------------- shared hooks */

  await test("Shared hooks: every document is reserved (chunks of 100) before download; taken ones are skipped, by whom", async () => {
    const items = Array.from({ length: 150 }, (_, i) => pdfItem(i));
    const api = hooksApi({ taken: { [items[3].log.key]: { status: "done", by: { user_id: 4, name: "Rahul" }, at: "2026-11-16T09:32:00+00:00" } } });
    const hooks = createSharedRunHooks({ api, claimId: "c1", account: ACCOUNT, isClaimLive: () => true });
    const checked = await hooks.documentHooks.preflight(items);
    eq(api.calls.reserve.length, Math.ceil(150 / RESERVE_CHUNK));
    eq(api.calls.reserve[0].destination, "ecm");
    eq(api.calls.reserve[0].account, "833");
    eq(checked.skip.size, 1);
    const skip = checked.skip.get("it-3");
    eq(skip.reason, SKIP_REASON.ALREADY_SAVED_FOR_ACCOUNT);
    eq(describeSkip(skip), "Already saved by Rahul on 2026-11-16 at 15:02");
  });

  await test("Shared hooks: a reservation that fails downloads NOTHING (never 'download everything')", async () => {
    const items = [pdfItem(1), pdfItem(2)];
    const hooks = createSharedRunHooks({ api: hooksApi({ reserveError: conflict("SCHEDULE_CLAIM_LOST") }), claimId: "c1", account: ACCOUNT, isClaimLive: () => true });
    const checked = await hooks.documentHooks.preflight(items);
    eq(checked.skip.size, 2);
    eq(hooks.stats().aborted, "SCHEDULE_CLAIM_LOST");
  });

  await test("Shared hooks: documents left out because the reservation failed are never counted as 'already saved' (1.9)", async () => {
    const items = [pdfItem(1), pdfItem(2), pdfItem(3)];
    const hooks = createSharedRunHooks({ api: hooksApi({ reserveError: new ScheduleApiError("SCHEDULE_BACKEND_UNAVAILABLE") }), claimId: "c1", account: ACCOUNT, isClaimLive: () => true });
    const checked = await hooks.documentHooks.preflight(items);
    eq(checked.skip.size, 3, "none is downloaded");
    eq(JSON.stringify([hooks.stats().skipped, hooks.details().skipped.length, hooks.stats().aborted]), JSON.stringify([0, 0, "SCHEDULE_BACKEND_UNAVAILABLE"]), "nothing was checked, so nothing is 'already saved'");
    const taken = createSharedRunHooks({ api: hooksApi({ taken: { [items[0].log.key]: { status: "done", by: { name: "Rahul" } } } }), claimId: "c2", account: ACCOUNT, isClaimLive: () => true });
    await taken.documentHooks.preflight(items);
    eq(taken.stats().skipped, 1, "a document someone saved still counts");
  });

  await test("Shared hooks: the ECM only - a refused upload fails the document (no local save); a lost claim uploads nothing", async () => {
    const items = [pdfItem(1), pdfItem(2)];
    let live = true;
    let uploads = 0;
    const api = hooksApi();
    const hooks = createSharedRunHooks({
      api,
      claimId: "c1",
      account: ACCOUNT,
      isClaimLive: () => live,
      uploadEcm: async () => {
        uploads++;
        throw new EcmError("ECM_REJECTED", { status: 400, detail: "No such property" });
      }
    });
    await hooks.documentHooks.preflight(items);
    let thrown = null;
    try {
      await hooks.documentHooks.saveFile(new Uint8Array([37, 80]), "DocLink/IREPS/IC/PO1/IC.pdf", items[0]);
    } catch (error) {
      thrown = error;
    }
    assert(thrown instanceof EcmError, "the ECM refusal is the failure; nothing is saved locally");
    live = false;
    let lostError = null;
    try {
      await hooks.documentHooks.saveFile(new Uint8Array([37, 80]), "DocLink/IREPS/IC/PO2/IC.pdf", items[1]);
    } catch (error) {
      lostError = error;
    }
    eq(lostError && lostError.code, "SCHEDULE_CLAIM_LOST");
    eq(uploads, 1, "no upload once the claim may be lost");
    const counts = await hooks.finishDocuments([
      { id: "it-1", status: DOCUMENT_DOWNLOAD_STATUS.FAILED, error: { code: "IREPS_IC_DOWNLOAD_FAILED" } },
      { id: "it-2", status: DOCUMENT_DOWNLOAD_STATUS.FAILED, error: { code: "IREPS_IC_DOWNLOAD_FAILED" } }
    ]);
    eq(counts.failed, 2);
    const failed = api.calls.complete.at(-1).failed;
    eq(failed[0].code, "ECM_REJECTED", "the ECM's own code is reported, not the downloader's");
    eq(failed[1].code, "SCHEDULE_CLAIM_LOST");
  });

  await test("Shared hooks: each document not saved is named with its code and reason; skipped and saved ones are listed", async () => {
    const item = (n, label) => ({ ...pdfItem(n), label });
    const items = [item(1, "IC C1 (PO PO1 Sr. 1)"), item(2, "IC C2 (PO PO2 Sr. 1)"), item(3, "IC C3 (PO PO3 Sr. 1)"), item(4, "IC C4 (PO PO4 Sr. 1)")];
    const api = hooksApi({ taken: { [items[3].log.key]: { status: "done", by: { user_id: 4, name: "Rahul" }, at: "2026-11-16T09:32:00+00:00" } } });
    let uploads = 0;
    const hooks = createSharedRunHooks({
      api,
      claimId: "c1",
      account: ACCOUNT,
      isClaimLive: () => true,
      uploadEcm: async () => {
        if (++uploads === 1) throw new EcmError("ECM_UNAVAILABLE", { status: 503, detail: "the ECM did not answer in time" });
        return { uid: "u3", path: "/ECM/Hosur/IC", site: "hosur", deduplicated: false };
      }
    });
    await hooks.documentHooks.preflight(items);
    await hooks.documentHooks.saveFile(new Uint8Array([1]), "x/IC_C1.pdf", items[0]).catch(() => {});
    const done = await hooks.documentHooks.saveFile(new Uint8Array([1]), "x/IC_C3.pdf", items[2]);
    await hooks.documentHooks.onSaved(items[2], done);
    await hooks.finishDocuments([
      // the downloader's own code ("Chrome could not save the file") must not hide the ECM's reason
      { id: "it-1", label: items[0].label, status: DOCUMENT_DOWNLOAD_STATUS.FAILED, error: { code: "IREPS_IC_DOWNLOAD_FAILED", detail: "Chrome could not save the file" } },
      { id: "it-2", label: items[1].label, status: DOCUMENT_DOWNLOAD_STATUS.FAILED, error: { code: "IREPS_IC_DOWNLOAD_FAILED", detail: "IREPS returned HTTP 500", status: 500 } },
      { id: "it-3", label: items[2].label, status: DOCUMENT_DOWNLOAD_STATUS.COMPLETED },
      { id: "it-4", label: items[3].label, status: DOCUMENT_DOWNLOAD_STATUS.SKIPPED }
    ]);
    const d = hooks.details();
    eq(JSON.stringify(d.failures), JSON.stringify([
      { doc: "IC C1 (PO PO1 Sr. 1)", code: "ECM_UNAVAILABLE", detail: "the ECM did not answer in time" },
      { doc: "IC C2 (PO PO2 Sr. 1)", code: "IREPS_IC_DOWNLOAD_FAILED", detail: "IREPS returned HTTP 500" }
    ]));
    eq(JSON.stringify(d.skipped), JSON.stringify([{ doc: "IC C4 (PO PO4 Sr. 1)", note: "Already saved by Rahul on 2026-11-16 at 15:02" }]));
    eq(JSON.stringify(d.saved), JSON.stringify([{ doc: "IC C3 (PO PO3 Sr. 1)", note: "IC_C3.pdf in ECM /ECM/Hosur/IC" }]));
    eq(api.calls.complete.at(-1).failed.map((f) => f.code).join(), "ECM_UNAVAILABLE,IREPS_IC_DOWNLOAD_FAILED", "the Recon Engine gets the same codes");

    const exportApi = hooksApi();
    const exp = createSharedRunHooks({ api: exportApi, claimId: "c2", account: ACCOUNT, isClaimLive: () => true, uploadExport: async () => { throw new WorkflowError("RECON_UNAVAILABLE", { detail: "could not reach the Recon Engine" }); } });
    await exp.saveExport({ bytes: new Uint8Array([1]), format: "xlsx" }, { docType: "crn", records: [{ a: 1 }, { a: 2 }], label: "CRN", filename: "CRN.xlsx" }).catch(() => {});
    eq(JSON.stringify(exp.details().failures), JSON.stringify([{ doc: "CRN export (2 records)", code: "RECON_UNAVAILABLE", detail: "could not reach the Recon Engine" }]));
  });

  await test("Shared hooks: saved documents are reported in batches of 10 with the account; complete retried, then the log queue", async () => {
    const items = Array.from({ length: 12 }, (_, i) => pdfItem(i));
    const api = hooksApi();
    const hooks = createSharedRunHooks({
      api,
      claimId: "c1",
      account: ACCOUNT,
      isClaimLive: () => true,
      uploadEcm: async () => ({ uid: "u1", path: "/ECM/Hosur/IC", site: "hosur", deduplicated: false })
    });
    await hooks.documentHooks.preflight(items);
    for (const item of items) {
      const done = await hooks.documentHooks.saveFile(new Uint8Array([1]), `x/${item.id}.pdf`, item);
      await hooks.documentHooks.onSaved(item, done);
    }
    eq(api.calls.complete.length, 1, "first 10 reported while the run goes on");
    eq(api.calls.complete[0].done.length, 10);
    eq(api.calls.complete[0].done[0].ireps_account_id, "833");
    eq(api.calls.complete[0].done[0].destination, "ecm");
    const counts = await hooks.finishDocuments(items.map((i) => ({ id: i.id, status: DOCUMENT_DOWNLOAD_STATUS.COMPLETED })));
    eq(counts.saved, 12);

    const queued = [];
    const down = hooksApi({ completeErrors: 99 });
    const failing = createSharedRunHooks({ api: down, claimId: "c2", account: ACCOUNT, isClaimLive: () => true, uploadEcm: async () => ({}), logFallback: async (r) => void queued.push(r), sleep: async () => {} });
    await failing.documentHooks.preflight([pdfItem(1)]);
    const saved = await failing.documentHooks.saveFile(new Uint8Array([1]), "x/1.pdf", pdfItem(1));
    await failing.documentHooks.onSaved(pdfItem(1), saved);
    const c = await failing.finishDocuments([{ id: "it-1", status: DOCUMENT_DOWNLOAD_STATUS.COMPLETED }]);
    eq(down.calls.complete.length, 3, "three attempts");
    eq(queued.length, 1, "the saved file's record goes to the download log queue");
    eq(c.notReported, 1);
  });

  await test("Shared hooks: an export already saved for the account is skipped (no upload); a new one goes to S3 only", async () => {
    const file = { bytes: new Uint8Array([80, 75]), format: "xlsx", extension: "xlsx", mimeType: "x" };
    const target = { docType: "crn", records: [{ crnNo: "1" }], label: "CRN", filename: "CRN.xlsx", localPath: "x/CRN.xlsx", localErrorCode: "DOCUMENT_DOWNLOAD_ERROR" };
    const uploads = [];
    const takenApi = {
      reserve: async (req) => ({ granted: [], taken: { [req.keys[0]]: { status: "done", by: { name: "Priya" }, at: "2026-11-17T03:40:00+00:00" } } }),
      complete: async () => ({})
    };
    const skipHooks = createSharedRunHooks({ api: takenApi, claimId: "c1", account: ACCOUNT, isClaimLive: () => true, uploadExport: async (f, t) => (uploads.push(t), {}) });
    const skipped = await skipHooks.saveExport(file, target);
    eq(skipped.skipped, true);
    eq(uploads.length, 0);
    eq(skipped.skip.by, "Priya");

    const api = hooksApi();
    const hooks = createSharedRunHooks({ api, claimId: "c1", account: ACCOUNT, isClaimLive: () => true, uploadExport: async (f, t) => (uploads.push(t), { destination: "recon", filename: "CRN.xlsx", storedPath: "s3://b/crn/CRN.xlsx" }) });
    const saved = await hooks.saveExport(file, target);
    eq(saved.skipped, false);
    eq(uploads[0].destination, "recon", "S3, whatever the panel's switch says");
    eq(api.calls.reserve[0].destination, "s3");
    eq(api.calls.complete[0].done[0].destination, "s3");

    const failing = createSharedRunHooks({
      api: hooksApi(),
      claimId: "c1",
      account: ACCOUNT,
      isClaimLive: () => true,
      uploadExport: async () => {
        throw new WorkflowError("RECON_UNAVAILABLE");
      }
    });
    let error = null;
    try {
      await failing.saveExport(file, target);
    } catch (e) {
      error = e;
    }
    eq(error && error.code, "RECON_UNAVAILABLE");
    eq(failing.stats().failed, 1);
  });

  await test("Shared hooks: istParts gives IST date and time", () => {
    const p = istParts("2026-11-16T22:00:00+00:00");
    eq(p.date, "2026-11-17");
    eq(p.time, "03:30:00");
    eq(istParts("not a date").date, "");
  });

  /* ------------------------------------------------------ backend client */

  await test("Schedule API: 409 codes, holder and lease; 401 / 403 / network mapped to DocLink codes", async () => {
    const answers = [];
    const fetch = async (url, init) => {
      answers.push({ url, init });
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return new Response(JSON.stringify(next.body), { status: next.status, headers: { "Content-Type": "application/json" } });
    };
    const queue = [
      { status: 200, body: { due: [], running: null, next_check_at: null, slots: [] } },
      { status: 409, body: { detail: { error: "ACCOUNT_BUSY", detail: "Rahul runs crn", holder: { user_id: 4, name: "Rahul" }, lease_until: "2026-11-17T03:40:00+00:00", doc_type: "crn" } } },
      { status: 401, body: { detail: "not signed in" } },
      { status: 403, body: { detail: { error: "FORBIDDEN", detail: "no doclink.schedule.run" } } },
      new TypeError("Failed to fetch")
    ];
    const api = createScheduleApi({ fetch, baseUrl: "http://localhost:8000", hostPermissions: ["http://localhost:8000/*"] });
    await api.due("833", ["billStatus", "crn"]);
    assert(answers[0].url.endsWith("/api/doclink/schedule/due?account=833&types=billStatus%2Ccrn"), answers[0].url);
    eq(answers[0].init.credentials, "include");
    const codeOf = async (p) => {
      try {
        await p;
      } catch (error) {
        return error;
      }
      return null;
    };
    const busy = await codeOf(api.claim({ slotId: 1, claimId: "abcdefgh", account: "833" }));
    eq(busy.code, "SCHEDULE_ACCOUNT_BUSY");
    eq(busy.holder.name, "Rahul");
    eq(busy.docType, "crn");
    eq(JSON.parse(answers[1].init.body).ireps_account_id, "833");
    eq((await codeOf(api.heartbeat("abcdefgh"))).code, "RECON_AUTH_REQUIRED");
    eq((await codeOf(api.heartbeat("abcdefgh"))).code, "SCHEDULE_NO_PERMISSION");
    eq((await codeOf(api.heartbeat("abcdefgh"))).code, "SCHEDULE_BACKEND_UNAVAILABLE");
    for (const code of ["SCHEDULE_ACCOUNT_BUSY", "SCHEDULE_CLAIM_LOST", "SCHEDULE_SLOT_DONE", "SCHEDULE_NO_PERMISSION", "SCHEDULE_BACKEND_UNAVAILABLE", "SCHEDULE_DESTINATION_REFUSED", "SCHEDULE_ACCOUNT_MISMATCH", "SCHEDULE_MISSED"]) {
      eq(describeError(code).code, code, `${code} has text in the error catalogue`);
    }
  });

  await test("Schedule API: a Recon Engine missing from host_permissions sends nothing", async () => {
    let sent = 0;
    const api = createScheduleApi({ fetch: async () => (sent++, new Response("{}")), baseUrl: "https://elsewhere.example", hostPermissions: ["http://localhost:8000/*"] });
    let error = null;
    try {
      await api.due("833");
    } catch (e) {
      error = e;
    }
    eq(error.code, "RECON_NOT_CONFIGURED");
    eq(sent, 0);
  });

  /* ------------------------------------------------- local signals, helpers */

  await test("Local signals: IREPS counts as active for 4 minutes after a page load, and not after a failed check", async () => {
    let clock = T0;
    const signals = createLocalSignals({ session: memoryArea(), local: memoryArea(), now: () => clock });
    eq(await signals.irepsReady(), false, "no page load yet");
    await signals.recordIrepsActivity();
    eq(await signals.irepsReady(), true);
    clock += 1000;
    await signals.recordIrepsCheckFailed();
    eq(await signals.irepsReady(), false, "failed check after the last page load");
    clock += 1000;
    await signals.recordIrepsActivity();
    eq(await signals.irepsReady(), true, "a new page load allows a claim again");
    clock += IREPS_ACTIVITY_MS + 1;
    eq(await signals.irepsReady(), false, "too long ago: IREPS logs out after about 5 idle minutes");
    await signals.recordAccount("833");
    eq(await signals.account(), "833");
  });

  await test("IREPS activity: the configured portal's pages count; its start page, login pages and other sites do not", () => {
    const base = "https://www.ireps.gov.in";
    eq(isIrepsActivityUrl("https://www.ireps.gov.in/epsn/home/showHome.do", base), true);
    eq(isIrepsActivityUrl("https://www.ireps.gov.in/", base), false);
    eq(isIrepsActivityUrl("https://www.ireps.gov.in/epsn/login.do", base), false);
    eq(isIrepsActivityUrl("https://evil.example/epsn/home/showHome.do", base), false);
    eq(isIrepsActivityUrl("https://ireps.gov.in/epsn/home/showHome.do", base), true, "the same IREPS without www (one domain-wide login)");
    eq(isIrepsActivityUrl("https://ireps.gov.in/epsn/home/userLogin.do", base), false);
    eq(isIrepsActivityUrl("http://ireps.gov.in/epsn/home/showHome.do", base), false, "another scheme is another site");
    eq(isIrepsActivityUrl("https://evilireps.gov.in/epsn/home/showHome.do", base), false);
    eq(isIrepsActivityUrl("not a url", base), false);
    eq(isIrepsActivityUrl("https://www.ireps.gov.in/epsn/home/showHome.do", ""), false, "no configured portal: nothing counts");
  });

  await test("IREPS activity (5.1): a page loading in a tab DocLink opened itself (a print tab, or a popup of one) never counts, also after a worker restart", async () => {
    const session = memoryArea();
    const local = memoryArea();
    const signals = createLocalSignals({ session, local, now: () => T0 });
    const base = "https://www.ireps.gov.in";
    const letter = `${base}/epsn/supply/tds/publishLOALetter.do`;
    const context = { irepsBaseUrl: base, signals };
    await signals.recordOwnTab(41); // tender-print.js's print tab (NOTE_OWN_TAB)
    eq(await isUserIrepsActivity(letter, { id: 41 }, context), false, "the print tab");
    eq(await isUserIrepsActivity(letter, { id: 42, openerTabId: 41 }, context), false, "a popup the letter page opened");
    eq(await isUserIrepsActivity(letter, { id: 43, openerTabId: 42 }, context), false, "a tab that popup opened in turn");
    eq(await isUserIrepsActivity(letter, { id: 7 }, context), true, "the user's own IREPS tab still counts");
    const restarted = createLocalSignals({ session, local, now: () => T0 });
    eq(await isUserIrepsActivity(letter, { id: 41 }, { irepsBaseUrl: base, signals: restarted }), false, "kept in chrome.storage.session across a worker restart");
    await restarted.forgetOwnTab(41);
    eq(await isUserIrepsActivity(letter, { id: 41 }, { irepsBaseUrl: base, signals: restarted }), true, "a closed tab is forgotten");
    eq(await restarted.irepsReady(), false, "and none of those loads was recorded as IREPS activity");
  });

  await test("Schedule view: slot lines say who did what, in IST", () => {
    eq(istTime("2026-11-17T04:38:00+00:00"), "10:08");
    eq(slotText({ status: "done", done_by: { name: "Priya" }, ended_at: "2026-11-17T04:38:00+00:00", result: { saved: 1, skipped: 2 } }), "Done by Priya at 10:08 · 1 saved, 2 already saved");
    eq(slotText({ status: "in_progress", holder: { name: "Rahul" } }), "Running - Rahul");
    const nineToNoon = { window_start_at: "2026-11-17T03:30:00+00:00", window_end_at: "2026-11-17T06:30:00+00:00" }; // 09:00-12:00 IST
    eq(slotText({ status: "pending", ...nineToNoon }, null, T0 - 60000), "Scheduled 09:00-12:00", "before its window");
    eq(slotText({ status: "pending", ...nineToNoon }, null, T0 + 60000), "Due 09:00-12:00, not run yet", "inside its window");
    eq(slotText({ status: "missed", ...nineToNoon }), "Not run during 09:00-12:00");
    eq(slotText({ status: "missed", code: "IREPS_SESSION_EXPIRED", ...nineToNoon }), `Not run during 09:00-12:00 (last: ${describeError("IREPS_SESSION_EXPIRED").title})`);
    for (const status of ["pending", "missed"]) {
      assert(!/logged in/i.test(slotText({ status, ...nineToNoon }, null, T0)), `a ${status} slot claims nothing about IREPS logins`);
    }
    for (const status of ["pending", "missed", "in_progress", "done", "partial", "failed"]) {
      assert(!/[\u2013\u2014]/.test(slotText({ status, holder: { name: "R" }, done_by: { name: "P" }, ...nineToNoon }, null, T0)), `${status}: only the plain "-" in the panel, never an en or em dash`);
    }
  });

  await test("Schedule view (1.13): a slot that ran but did not end clean before its window closed is never shown as 'Not run'", () => {
    const nineToTen = { window_start_at: "2026-11-17T03:30:00+00:00", window_end_at: "2026-11-17T04:30:00+00:00" };
    const ran = { id: 4, doc_type: "poDate", status: "missed", code: "SCHEDULE_DOWNLOAD_FAILED", attempts: 2, started_at: "2026-11-17T03:40:00+00:00", ended_at: "2026-11-17T03:44:00+00:00", result: { saved: 3, failed: 1, failures: [{ doc: "PO 1", code: "ECM_UNAVAILABLE", detail: null }] }, ...nineToTen };
    eq(slotText(ran), `Ran, but not finished during 09:00-10:00 (last: ${describeError("SCHEDULE_DOWNLOAD_FAILED").title}) \u00b7 3 saved, 1 failed`);
    const later = Date.parse("2026-11-17T06:00:00Z");
    const ranDetails = slotDetails(ran, { log: { runs: [], events: [] }, now: later });
    assert(!ranDetails.events.some((e) => /noted nothing/.test(e)), "it ran: no 'Chrome was closed'");
    eq(ranDetails.failures[0].doc, "PO 1");
    const never = { id: 5, doc_type: "ma", status: "missed", ...nineToTen };
    eq(slotText(never), "Not run during 09:00-10:00");
    assert(slotDetails(never, { log: { runs: [], events: [] }, now: later }).events[0].includes("noted nothing"), "a slot no DocLink ran still says what this browser noted");
  });

  await test("Schedule view: the scheduler's last failure is shown in the status line", () => {
    eq(lastErrorText(null), "");
    eq(lastErrorText({ code: "UNKNOWN", detail: "Illegal invocation" }), `Last check failed: ${describeError("UNKNOWN").title} (Illegal invocation).`);
    eq(lastErrorText({ code: "SCHEDULE_BACKEND_UNAVAILABLE", detail: null }), `Last check failed: ${describeError("SCHEDULE_BACKEND_UNAVAILABLE").title}.`);
  });

  await test("Schedule view: the admin list offers only the types this DocLink runs; an existing schedule stays editable", () => {
    const phase1 = parseSchedulerConfig({
      schedular_phase1: { enabled: true, documents: ["BillStatus", "CRN", "RNote", "MA", "PO", "IC"] },
      schedular_phase2: { enabled: false, documents: ["NIT", "LOA"] }
    });
    const PHASE1 = "billStatus,crn,rnote,ma,poDate,icDate,icNotifications";
    eq(editorTypes(phase1, []).join(), PHASE1, "phase 2 off: no tender type is offered");
    eq(editorTypes(phase1, [{ doc_type: "tenderLoa" }]).join(), `${PHASE1},tenderLoa`, "an existing tender schedule can still be edited or deleted");
    const noIc = parseSchedulerConfig({ schedular_phase1: { enabled: true, documents: ["BillStatus", "MA"] } });
    eq(editorTypes(noIc, [{ doc_type: "icDate" }]).join(), "billStatus,ma,icDate", "in run order");
    const both = parseSchedulerConfig({ schedular_phase1: { enabled: true, documents: ["MA"] }, schedular_phase2: { enabled: true, documents: ["LOA"] } });
    eq(editorTypes(both, undefined).join(), "ma,tenderLoa", "phase 2 on: its types are offered");
  });

  await test("Schedule view: an hourly type shows its latest run, the next run and the earlier ones folded", () => {
    const ist = (hour) => new Date(Date.UTC(2026, 10, 17, hour) - 330 * 60000).toISOString(); // IST hour:00 as UTC
    const slot = (id, type, period, status, extra = {}) => {
      const hour = period === "day" ? 9 : Number(period.slice(0, 2));
      return { id, doc_type: type, period, status, window_start_at: ist(hour), window_end_at: ist(hour + 1), ...extra };
    };
    const rows = todayRows([
      slot(5, "ma", "10:00", "pending"),
      slot(1, "billStatus", "day", "done", { done_by: { name: "Priya" }, ended_at: "2026-11-17T03:35:00+00:00" }),
      slot(2, "ma", "09:00", "done", { result: { saved: 3 } }),
      slot(9, "ma", "11:00", "done", { done_by: { name: "Rahul" }, ended_at: "2026-11-17T05:35:00+00:00", result: { saved: 1 } }),
      slot(3, "ma", "08:00", "missed")
    ]);
    eq(JSON.stringify(rows.map((r) => [r.slot.doc_type, r.slot.id, r.earlier.map((s) => s.id)])), JSON.stringify([["billStatus", 1, []], ["ma", 9, [3, 2, 5]]]));
    eq(earlierText(rows[1].earlier), "Earlier today: 1 of 3 runs done, 3 saved");
    eq(earlierText(rows[0].earlier), "");
    const hourly = { doc_type: "ma", window_end: "18:00", enabled: true };
    eq(slotText(rows[1].slot, hourly), "Done by Rahul at 11:05 · 1 saved · next run 12:00");
    eq(slotText(rows[1].slot, { ...hourly, window_end: "12:00" }), "Done by Rahul at 11:05 · 1 saved · next run 12:00", "a run starts AT window_end too");
    eq(slotText(rows[1].slot, { ...hourly, window_end: "11:00" }), "Done by Rahul at 11:05 · 1 saved", "the last run (window_end): no next run today");
    eq(slotText(rows[0].slot, { doc_type: "billStatus", window_end: "10:00" }), "Done by Priya at 09:05", "a once-a-day slot never names a next run");
  });

  // The panel's layout is checked with its own stylesheet and markup, loaded here (outside the timed
  // tests); the stylesheet is removed after them.
  const panelCss = Object.assign(document.createElement("link"), { rel: "stylesheet", href: new URL("../popup/popup.css", import.meta.url).href });
  const panelCssLoaded = new Promise((resolve) => {
    panelCss.onload = panelCss.onerror = resolve;
  });
  document.head.append(panelCss);
  await panelCssLoaded;
  const panelHtml = new DOMParser().parseFromString(await (await fetch(new URL("../popup/popup.html", import.meta.url))).text(), "text/html");
  const TEAL = "rgb(56, 152, 144)"; // --primary
  await test("Schedule view: the admin list fits a 320 px side panel and uses DocLink's buttons and toggles", async () => {
    const host = document.createElement("div");
    host.className = "app-main";
    host.style.cssText = "position: absolute; left: -10000px; top: 0; width: 320px";
    host.innerHTML = `<section id="view-schedule" class="view" hidden><article class="card">
      <div class="card-heading"><h2>Scheduled downloads</h2><button id="btn-schedule-back" class="btn btn-secondary btn-back" type="button">Back</button></div>
      <p class="card-text schedule-status" id="schedule-status"></p>
      <div id="schedule-error" class="result result-error" hidden><div class="result-title" id="schedule-error-title"></div><p id="schedule-error-message" class="result-text"></p></div>
      <ul class="schedule-list" id="schedule-today"></ul><p class="schedule-empty" id="schedule-today-empty" hidden></p>
      <div id="schedule-manage" hidden><div class="schedule-editors" id="schedule-editors"></div></div>
      <button id="btn-schedule-refresh" class="btn btn-primary" type="button">Refresh</button>
    </article></section><button id="btn-schedule-open" type="button"></button>`;
    document.body.append(host);
    const view = {
      config: { enabled: true, types: ["billStatus", "crn", "rnote", "ma", "poDate", "icDate", "icNotifications"], unknown: [], reason: null },
      account: "833",
      user: { name: "Priya", canRun: true, canManage: true },
      waitingFor: null,
      lastError: null,
      slots: [],
      schedules: [
        { id: 1, doc_type: "billStatus", enabled: true, window_start: "09:00", window_end: "10:00", check_every_minutes: 10, repeat_every_minutes: null, days: [0, 1, 2, 3, 4, 5, 6], lookback_days: 90 },
        { id: 2, doc_type: "ma", enabled: false, window_start: "08:07", window_end: "18:00", check_every_minutes: 15, repeat_every_minutes: 60, days: [1, 2, 3, 4, 5], lookback_days: 2 }
      ],
      error: null
    };
    const sent = [];
    let answerSave = null;
    const tick = () => new Promise((r) => setTimeout(r, 0));
    const until = async (check) => {
      for (let i = 0; i < 100 && !check(); i++) await tick();
    };
    try {
      await initSchedule({
        send: async (type, payload) => {
          sent.push({ type, payload });
          if (type === MESSAGE_TYPES.SCHEDULE_SAVE) return new Promise((resolve) => (answerSave = () => resolve({ ok: true })));
          return view;
        },
        showView: (name) => {
          host.querySelector("#view-schedule").hidden = name !== "schedule";
        }
      });
      host.querySelector("#btn-schedule-open").click();
      await until(() => host.querySelector("#schedule-editors > *"));
      const boxes = () => [...host.querySelectorAll("#schedule-editors > details.options")];
      eq(boxes().length, 7, "one DocLink option box per type this DocLink runs");
      for (const box of boxes()) box.open = true;
      await tick();

      const card = host.querySelector(".card");
      const fields = host.querySelector(".schedule-fields");
      assert(fields && getComputedStyle(fields).display === "grid", "the fields are laid out by the panel's stylesheet");
      const style = getComputedStyle(card);
      const edge = card.getBoundingClientRect().right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight);
      // only drawn elements: a hidden one (or an <option>) has an empty box at 0, 0
      const sticking = [...card.querySelectorAll("*")].filter((n) => {
        const box = n.getBoundingClientRect();
        return box.width > 0 && box.right > edge + 0.5;
      });
      assert(card.scrollWidth <= card.clientWidth && sticking.length === 0, `nothing is pushed past the panel's edge: ${sticking.map((n) => `<${n.tagName.toLowerCase()} class="${n.className}"> "${n.textContent.trim().slice(0, 30)}"`).join(", ")}`);

      const summary = (i) => boxes()[i].querySelector("summary").textContent;
      eq(summary(0), "Bill Status09:00-10:00 · once a day");
      eq(summary(1), "CRNNot scheduled");
      eq(summary(3), "MA copiesOff08:07-18:00 · every hour");
      const buttons = [...host.querySelectorAll("#schedule-editors button")];
      assert(buttons.length > 0 && buttons.every((b) => b.classList.contains("btn") && !b.classList.contains("btn-link")), "Add schedule / Save / Delete are buttons, not links");
      eq(boxes()[0].querySelector(".btn-primary").textContent, "Save");
      eq(boxes()[0].querySelector(".btn-danger").textContent, "Delete");
      eq(boxes()[1].querySelector(".btn-primary").textContent, "Add schedule");
      assert(!boxes()[1].querySelector(".btn-danger"), "nothing to delete before it is added");
      const choices = [...host.querySelectorAll('#schedule-editors input[type="checkbox"], #schedule-editors input[type="radio"]')];
      assert(choices.every((input) => input.closest(".segmented")), "every on / off and day choice is a DocLink toggle, not a bare browser checkbox");
      eq(boxes()[3].querySelectorAll(".schedule-days input:checked").length, 5, "MA runs Monday to Friday");
      eq(boxes()[3].querySelector('input[type="radio"]:checked').parentElement.textContent, "Off");
      assert(!host.querySelector('#schedule-editors input[type="time"]'), "no browser time picker: From and To are DocLink dropdowns");
      const times = [...boxes()[3].querySelectorAll(".schedule-time select")];
      eq(times.map((s) => s.value).join(","), "08,07,18,00", "hour and minute dropdowns for From and To; a stored 08:07 is shown as it is");

      // Save: busy (sent once), with the toggles' values; the box stays open when the list is drawn again
      const save = boxes()[3].querySelector(".btn-primary");
      save.click();
      await until(() => answerSave);
      assert(save.classList.contains("is-busy") && save.disabled && boxes()[3].querySelector(".btn-danger").disabled, "busy while the Recon Engine answers");
      answerSave();
      await until(() => sent.filter((s) => s.type === MESSAGE_TYPES.SCHEDULE_GET_STATE).length === 2);
      await until(() => !boxes()[3] || boxes()[3].querySelector(".btn-primary") !== save);
      const saved = sent.find((s) => s.type === MESSAGE_TYPES.SCHEDULE_SAVE).payload.schedule;
      eq(JSON.stringify([saved.id, saved.doc_type, saved.enabled, saved.days.join(""), saved.repeat_every_minutes, saved.lookback_days, saved.window_start, saved.window_end]), JSON.stringify([2, "ma", false, "12345", 60, 2, "08:07", "18:00"]));
      assert(boxes()[3].open, "the edited box is still open after the save");
      answerSave = null;
      boxes()[1].querySelector(".btn-primary").click();
      await until(() => answerSave);
      const added = sent.filter((s) => s.type === MESSAGE_TYPES.SCHEDULE_SAVE)[1].payload.schedule;
      eq(JSON.stringify([added.id, added.doc_type, added.enabled, added.window_start, added.window_end]), JSON.stringify([undefined, "crn", true, "09:00", "10:00"]), "a new schedule is added switched on, from the defaults");
      answerSave();
    } finally {
      host.remove();
    }
  });

  await test("Schedule view: a state message while an admin edits keeps the edited time; Save sends it; rows and the run log open to what failed", async () => {
    const host = document.createElement("div");
    host.className = "app-main";
    host.style.cssText = "position: absolute; left: -10000px; top: 0; width: 320px";
    host.innerHTML = `<section id="view-schedule" class="view" hidden><article class="card">
      <div class="card-heading"><h2>Scheduled downloads</h2><button id="btn-schedule-back" class="btn btn-secondary btn-back" type="button">Back</button></div>
      <p class="card-text schedule-status" id="schedule-status"></p>
      <p class="schedule-notice" id="schedule-notice" role="status" hidden></p>
      <div id="schedule-error" class="result result-error" hidden><div class="result-title" id="schedule-error-title"></div><p id="schedule-error-message" class="result-text"></p></div>
      <ul class="schedule-list" id="schedule-today"></ul><p class="schedule-empty" id="schedule-today-empty" hidden></p>
      ${panelHtml.querySelector("#schedule-log").outerHTML}
      <div id="schedule-manage" hidden><div class="schedule-editors" id="schedule-editors"></div></div>
      <button id="btn-schedule-refresh" class="btn btn-primary" type="button">Refresh</button>
    </article></section><button id="btn-schedule-open" type="button"></button>`;
    document.body.append(host);
    const nineToTen = { window_start_at: "2026-11-19T03:30:00+00:00", window_end_at: "2026-11-19T04:30:00+00:00" };
    const longDetail = "the ECM did not answer in time: https://wctsrvecmtstsn1.wabtec.com:8080/nuxeo/api/v1/path/default-domain/workspaces/Hosur/Tenders/a-very-long-folder-name-without-spaces";
    const failures = [{ doc: "Tender 10263703 - Annexure 4 with a long title", code: "ECM_UNAVAILABLE", detail: longDetail }, { doc: "Tender 10263703 - My Offer", code: "SCHEDULE_TENDER_FAILED", detail: "The file was not a valid PDF." }];
    const view = {
      config: { enabled: true, types: ["billStatus", "crn", "rnote", "tenderNit"], unknown: [], reason: null },
      account: "833",
      user: { name: "Priya", canRun: true, canManage: true },
      waitingFor: null,
      lastError: null,
      version: "1.6.9",
      slots: [
        { id: 1, doc_type: "billStatus", period: "day", status: "missed", ...nineToTen },
        { id: 3, doc_type: "tenderNit", period: "10:30", status: "partial", code: "SCHEDULE_DOWNLOAD_FAILED", attempts: 1, started_at: "2026-11-19T05:15:00+00:00", ended_at: "2026-11-19T05:22:00+00:00", window_start_at: "2026-11-19T05:00:00+00:00", window_end_at: "2026-11-19T06:00:00+00:00", next_try_at: "2026-11-19T05:45:00+00:00", result: { saved: 35, skipped: 18, failed: 2, range: "17/11/2026 - 18/11/2026", failures } }
      ],
      schedules: [{ id: 1, doc_type: "billStatus", enabled: true, window_start: "09:00", window_end: "10:00", check_every_minutes: 10, repeat_every_minutes: null, days: [0, 1, 2, 3, 4, 5, 6], lookback_days: 30 }],
      log: {
        runs: [{ id: "c7", docType: "tenderNit", slotId: 9, period: "09:30", account: "833", range: "17/11/2026 - 18/11/2026", startedAt: "2026-11-19T04:00:00Z", endedAt: "2026-11-19T04:06:00Z", outcome: "partial", code: "SCHEDULE_DOWNLOAD_FAILED", counts: { saved: 3, failed: 5 }, failures: new Array(5).fill(failures[0]), saved: [{ doc: "Tender 1 tender PDF", note: "T1.pdf in the ECM" }], skipped: [], more: {} }],
        events: [{ kind: "ireps", first: "2026-11-19T03:32:00Z", at: "2026-11-19T04:20:00Z", count: 6, text: "Due now: Bill Status, CRN, R-NOTE. Waiting for IREPS: no IREPS page has loaded in this browser in the last 4 minutes.", types: ["billStatus", "crn", "rnote"] }]
      },
      error: null
    };
    const sent = [];
    let answerSave = null;
    const tick = () => new Promise((r) => setTimeout(r, 0));
    const until = async (check) => {
      for (let i = 0; i < 100 && !check(); i++) await tick();
    };
    const states = () => sent.filter((s) => s.type === MESSAGE_TYPES.SCHEDULE_GET_STATE).length;
    try {
      await initSchedule({
        send: async (type, payload) => {
          sent.push({ type, payload });
          if (type === MESSAGE_TYPES.SCHEDULE_SAVE) return new Promise((resolve) => (answerSave = () => resolve({ ok: true })));
          return JSON.parse(JSON.stringify(view));
        },
        showView: (name) => {
          host.querySelector("#view-schedule").hidden = name !== "schedule";
        }
      });
      host.querySelector("#btn-schedule-open").click();
      await until(() => host.querySelector("#schedule-editors > *"));

      // Today: the partly done row opens to the documents not saved, each with why
      const rows = [...host.querySelectorAll("#schedule-today > li")];
      const nit = rows[1].querySelector("details.schedule-run");
      assert(nit, "a row with something to say opens");
      nit.open = true;
      const nitText = nit.textContent;
      for (const part of ["Searched: 17/11/2026 - 18/11/2026", "Not saved (2)", `Tender 10263703 - My Offer: ${describeError("SCHEDULE_TENDER_FAILED").title} (The file was not a valid PDF.)`]) assert(nitText.includes(part), `"${part}" in: ${nitText}`);
      const missed = rows[0].querySelector("details.schedule-run");
      missed.open = true;
      assert(missed.textContent.includes("09:02-09:50 (6 checks): Due now: Bill Status"), missed.textContent);
      // the run log: the run opens to its five documents; the event is listed
      const log = host.querySelector("#schedule-log");
      log.open = true;
      const run = host.querySelector("#schedule-log-runs details.schedule-run");
      run.open = true;
      assert(run.textContent.includes("Not saved (5)") && run.textContent.includes("Saved (1)"), run.textContent);
      eq(getComputedStyle(run.querySelector("summary"), "::before").content, "none", "a run of the run log has its own marker only, not the option box's too");
      assert(host.querySelector("#schedule-log-events").textContent.includes("Waiting for IREPS"), "the scheduler's events are listed");
      eq(host.querySelector("#schedule-log-summary").textContent, "1 run · 1 event");
      await tick();
      const card = host.querySelector(".card");
      const style = getComputedStyle(card);
      const edge = card.getBoundingClientRect().right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight);
      const sticking = [...card.querySelectorAll("*")].filter((n) => {
        const box = n.getBoundingClientRect();
        return box.width > 0 && box.right > edge + 0.5;
      });
      assert(card.scrollWidth <= card.clientWidth && sticking.length === 0, `long reasons wrap inside a 320 px panel: ${sticking.map((n) => `<${n.tagName.toLowerCase()} class="${n.className}">`).join(", ")}`);

      // the admin edits Bill Status's From; a state message from the worker arrives before Save
      const boxes = () => [...host.querySelectorAll("#schedule-editors > details.options")];
      const bill = boxes()[0];
      bill.open = true;
      assert(!bill.querySelector('input[type="number"]') && bill.textContent.includes("Last 90 days"), "Bill Status: a fixed 90-day range, no look-back to edit");
      const fromHour = bill.querySelector(".schedule-time select");
      fromHour.value = "11";
      fromHour.dispatchEvent(new Event("change", { bubbles: true }));
      const toHour = bill.querySelectorAll(".schedule-time select")[2];
      toHour.value = "12";
      toHour.dispatchEvent(new Event("change", { bubbles: true }));
      const before = states();
      handleScheduleMessage({ type: MESSAGE_TYPES.SCHEDULE_STATE });
      await until(() => states() > before);
      await tick();
      eq(boxes()[0], bill, "the box being edited is kept when the view is drawn again");
      eq(boxes()[0].querySelector(".schedule-time select").value, "11", "the edited hour is still there");
      bill.querySelector(".btn-primary").click();
      await until(() => answerSave);
      const saved = sent.find((s) => s.type === MESSAGE_TYPES.SCHEDULE_SAVE).payload.schedule;
      eq(JSON.stringify([saved.id, saved.window_start, saved.window_end, saved.lookback_days]), JSON.stringify([1, "11:00", "12:00", 90]), "Save sends the edited time, and 90 days");
      answerSave();
      await until(() => !host.querySelector("#schedule-notice").hidden);
      assert(/Today's Bill Status slot \(09:00-10:00\) has ended .*applies from tomorrow/.test(host.querySelector("#schedule-notice").textContent), host.querySelector("#schedule-notice").textContent);
      assert(boxes()[0] !== bill, "after the save the box is drawn from the saved schedule");
      // CRN, not scheduled yet: added with the 90-day range
      answerSave = null;
      const crn = boxes()[1];
      assert(crn.textContent.includes("Last 90 days"), "CRN: a fixed 90-day range");
      crn.querySelector(".btn-primary").click();
      await until(() => answerSave);
      eq(sent.filter((s) => s.type === MESSAGE_TYPES.SCHEDULE_SAVE)[1].payload.schedule.lookback_days, 90);
      answerSave();
    } finally {
      host.remove();
    }
  });

  await test("Panel header: the logo on the left, centred, nothing under it; the status pills and icons in the right corner", async () => {
    for (const width of [320, 400, 480, 540, 760]) {
      const host = document.createElement("div");
      host.style.cssText = `position: absolute; left: -10000px; top: 0; width: ${width}px`;
      host.append(document.importNode(panelHtml.querySelector("header.app-header"), true));
      document.body.append(host);
      try {
        const header = host.querySelector(".app-header");
        const logo = header.querySelector(".brand-logo");
        if (!logo.complete) await new Promise((resolve) => (logo.onload = logo.onerror = resolve));
        assert(logo.naturalWidth > 0, "the logo is drawn (its width counts)");
        header.querySelector("#connection").dataset.state = "login";
        header.querySelector("#connection-text").textContent = "Login Required";
        header.querySelector("#recon-connection").hidden = false;
        header.querySelector("#recon-connection-text").textContent = "firstname.lastname@joulestowatts.com";
        header.querySelector("#btn-schedule-open").hidden = false;
        const box = (selector) => header.querySelector(selector).getBoundingClientRect();
        const [brand, icons, ireps, recon, row] = [box(".brand"), box(".header-actions"), box("#connection"), box("#recon-connection"), box(".app-header-row")];
        assert(icons.left >= brand.right && icons.top < brand.bottom, `${width} px: the icons sit on the brand's row, right of it`);
        if (width >= 480) {
          assert(ireps.left >= brand.right && recon.left >= brand.right, `${width} px: nothing under the logo: the pills are right of it`);
          assert(recon.top >= ireps.bottom && Math.abs(recon.right - ireps.right) < 1, `${width} px: IREPS above RECON, right-aligned`);
          assert(icons.left >= Math.max(ireps.right, recon.right), `${width} px: the icons right of the pills, in the corner`);
          assert(Math.abs((brand.top + brand.bottom) / 2 - (row.top + row.bottom) / 2) < 1, `${width} px: the logo is vertically centred`);
        } else {
          assert(ireps.top >= brand.bottom && recon.top >= brand.bottom, `${width} px: too narrow for the corner: the pills go under the brand`);
          assert(Math.abs(ireps.top - recon.top) < 1 && recon.left >= ireps.right, `${width} px: the two pills share one line, side by side`);
        }
        assert(header.scrollWidth <= header.clientWidth, `${width} px: the header is ${header.scrollWidth - header.clientWidth} px too wide`);
        assert(recon.right <= header.getBoundingClientRect().right - 15.5, `${width} px: the RECON pill stays inside the header`);
        if (width === 320) {
          const email = header.querySelector("#recon-connection-text");
          assert(email.scrollWidth > email.clientWidth, "a long e-mail ends in … (the full one is in the tooltip)");
          eq(getComputedStyle(header.querySelector("#connection")).backgroundColor, "rgb(251, 231, 233)", "Login Required tints its pill (--danger-soft)");
        }
      } finally {
        host.remove();
      }
    }
  });

  await test("Every view's Back is a small DocLink button, not a link and not full width", () => {
    const backs = [...panelHtml.querySelectorAll('button[id$="-back"]')];
    assert(backs.length > 0, "the views have a Back");
    for (const back of backs) assert(back.classList.contains("btn-secondary") && back.classList.contains("btn-back"), `${back.id} is the small outlined Back button`);
    const host = document.createElement("div");
    host.className = "card";
    host.style.cssText = "position: absolute; left: -10000px; top: 0; width: 320px";
    host.innerHTML = '<button class="btn btn-primary" type="button">Open IREPS</button><button class="btn btn-secondary btn-back" type="button">Back</button>';
    document.body.append(host);
    try {
      const [open, back] = host.querySelectorAll("button");
      assert(back.getBoundingClientRect().width < 120, `Back is small (${Math.round(back.getBoundingClientRect().width)} px in a 320 px card)`);
      eq(Math.round(back.getBoundingClientRect().top - open.getBoundingClientRect().bottom), 8, "8 px under the button above it");
    } finally {
      host.remove();
    }
  });

  await test("No action looks like link text: every .btn-link is a small outlined button", () => {
    const actions = [...panelHtml.querySelectorAll(".btn-link")];
    assert(actions.length > 0 && actions.every((b) => b.tagName === "BUTTON"), "the panel's .btn-link actions are buttons");
    const host = document.createElement("div");
    host.className = "card";
    host.style.cssText = "position: absolute; left: -10000px; top: 0; width: 320px";
    host.innerHTML = '<div class="result-actions"><button class="btn btn-link" type="button">Show in folder</button></div><button class="btn btn-link" type="button">Load more</button>';
    document.body.append(host);
    try {
      for (const b of host.querySelectorAll(".btn-link")) {
        const s = getComputedStyle(b);
        eq(s.textDecorationLine, "none", `${b.textContent}: not underlined`);
        eq(s.borderTopWidth, "1px", `${b.textContent}: a border`);
        eq(s.borderTopColor, "rgb(214, 224, 223)", `${b.textContent}: DocLink's border colour (--border)`);
        eq(s.borderTopLeftRadius, "8px", `${b.textContent}: rounded`);
        assert(b.getBoundingClientRect().width < 160, `${b.textContent}: small, not full width`);
      }
      const [inRow, alone] = host.querySelectorAll(".btn-link");
      eq(getComputedStyle(inRow).marginTop, "0px", "in a row of actions, the row's gap spaces it");
      eq(getComputedStyle(alone).marginTop, "10px", "on its own line (Load more), it keeps 10 px from what is above it");
    } finally {
      host.remove();
    }
  });

  await test("Dropdowns, checkboxes and radio buttons use DocLink's teal, the opened list included", () => {
    const host = document.createElement("div");
    host.style.cssText = "position: absolute; left: -10000px; top: 0; width: 320px";
    host.innerHTML = `<label class="field"><span class="field-label">Railway</span><select><option value="-1">All</option><option value="1" selected>CENTRAL RLY</option></select></label>
      <input type="checkbox" checked><input type="radio" checked>`;
    document.body.append(host);
    try {
      eq(getComputedStyle(host.querySelector('input[type="checkbox"]')).accentColor, TEAL, "checkboxes");
      eq(getComputedStyle(host.querySelector('input[type="radio"]')).accentColor, TEAL, "radio buttons");
      const select = host.querySelector("select");
      eq(getComputedStyle(select).borderTopLeftRadius, "8px", "the closed dropdown");
      // the opened list can be styled from Chrome 135 (customizable select); older Chrome keeps its own
      if (CSS.supports("appearance", "base-select")) {
        eq(getComputedStyle(select).appearance, "base-select");
        const [all, chosen] = select.options;
        eq(getComputedStyle(chosen).backgroundColor, TEAL, "the chosen option");
        eq(getComputedStyle(chosen).color, "rgb(255, 255, 255)");
        eq(getComputedStyle(all).backgroundColor, "rgba(0, 0, 0, 0)", "the other options plain");
      }
    } finally {
      host.remove();
    }
  });
  panelCss.remove();

  await test("Schedule defaults: the exports once 09:00-10:00 every 10 min, the PDFs hourly 09:00-18:00", () => {
    const once = { window_start: "09:00", window_end: "10:00", check_every_minutes: 10, repeat_every_minutes: null };
    const hourly = { window_start: "09:00", window_end: "18:00", check_every_minutes: 15, repeat_every_minutes: 60 };
    eq(Object.keys(SCHEDULE_DEFAULT_TIMING).join(), SCHEDULE_TYPES.join());
    for (const t of ["billStatus", "crn", "rnote"]) eq(JSON.stringify(SCHEDULE_DEFAULT_TIMING[t]), JSON.stringify(once), t);
    for (const t of ["ma", "poDate", "icDate", "icNotifications"]) eq(JSON.stringify(SCHEDULE_DEFAULT_TIMING[t]), JSON.stringify(hourly), t);
  });
  /* ------------------------------------------------------------ Phase 2: tender documents */

  await test("schedular_phase2: its own switch and names; either phase on turns scheduling on", () => {
    const p2 = parseSchedulerConfig({ schedular_phase2: { enabled: true, documents: ["NIT", "loa", "Tabulation", "Correspondence", "CounterOffer", "Negotiation"] } });
    eq(p2.enabled, true);
    eq(p2.types.join(), TENDER_SCHEDULE_TYPES.join(), "every tender type, in run order (Negotiation last)");
    const both = parseSchedulerConfig({ schedular_phase1: { enabled: true, documents: ["CRN"] }, schedular_phase2: { enabled: true, documents: ["LOA"] } });
    eq(both.types.join(), "crn,tenderLoa");
    const onlyOne = parseSchedulerConfig({ schedular_phase1: { enabled: true, documents: ["CRN"] }, schedular_phase2: { enabled: false, documents: ["LOA"] } });
    eq(onlyOne.types.join(), "crn", "phase 2 off: no tender type");
    const mixed = parseSchedulerConfig({ schedular_phase1: { enabled: true, documents: ["CRN", "NIT"] }, schedular_phase2: { enabled: true, documents: ["IC", "NIT"] } });
    eq(mixed.types.join(), "crn,tenderNit", "a name counts only in its own phase");
    eq(mixed.unknown.join(), "NIT,IC");
    const off = parseSchedulerConfig({ schedular_phase1: { enabled: false, documents: ["CRN"] }, schedular_phase2: { enabled: "true", documents: ["LOA"] } });
    eq(off.enabled, false);
    eq(off.reason, "schedular_phase1.enabled is not true; schedular_phase2.enabled is not true");
    eq(parseSchedulerConfig({ schedular_phase1: { enabled: false } }).reason, "schedular_phase1.enabled is not true", "phase 2 absent: phase 1's reason alone");
  });

  await test("Tender defaults: hourly 10:30-18:30 (runs at 10:30 ... 18:30); Negotiation 12:30, 15:30, 18:30", () => {
    for (const t of TENDER_SCHEDULE_TYPES.filter((x) => x !== "tenderNegotiation")) {
      eq(JSON.stringify(SCHEDULE_DEFAULT_TIMING[t]), JSON.stringify({ window_start: "10:30", window_end: "18:30", check_every_minutes: 15, repeat_every_minutes: 60 }), t);
    }
    eq(JSON.stringify(SCHEDULE_DEFAULT_TIMING.tenderNegotiation), JSON.stringify({ window_start: "12:30", window_end: "18:30", check_every_minutes: 30, repeat_every_minutes: 180 }));
  });

  /** A tender runner on fakes: tabs open as ids 41, 42 ...; timers run by hand. */
  function tenderHarness({ openFails = false, live = true, realTimers = false } = {}) {
    const tabs = { opened: [], closed: [] };
    const pending = [];
    const runner = createTenderRunner({
      openTab: async (path) => {
        if (openFails) throw new Error("no window");
        tabs.opened.push(path);
        return 40 + tabs.opened.length;
      },
      closeTab: async (id) => tabs.closed.push(id),
      holdWorker: (task) => task(),
      ...(realTimers ? {} : { timers: { setTimeout: (fn) => (pending.push(fn), pending.length), clearTimeout: () => {} } }),
      timeoutMs: 1000
    });
    const ctx = { slot: { id: 7, doc_type: "tenderLoa" }, claimId: "claim-1", params: { dateFrom: "16/11/2026", dateTo: "17/11/2026", lookbackDays: 2 }, account: ACCOUNT, isClaimLive: () => live };
    return { runner, ctx, tabs, fireTimeout: () => pending.forEach((fn) => fn()) };
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));

  await test("Tender runner: opens a background tab, gives it the job (only that tab), and closes it with the tab's outcome", async () => {
    const h = tenderHarness();
    const ended = h.runner.run(h.ctx);
    await tick();
    eq(h.tabs.opened.join(), `${RUNNER_PAGE}?claim=claim-1`);
    eq((await h.runner.ready("claim-1", 99)).ok, false, "another tab gets nothing");
    const job = await h.runner.ready("claim-1", 41);
    eq(job.ok, true);
    eq(JSON.stringify(job.job), JSON.stringify({ claimId: "claim-1", docType: "tenderLoa", slotId: 7, params: h.ctx.params, account: ACCOUNT }));
    eq(h.runner.ping("claim-1", 41).live, true);
    eq(h.runner.ping("claim-1", 99).live, false);
    eq(h.runner.done("claim-1", { outcome: "done", result: { saved: 2 } }, 99).ok, false, "another tab cannot end it");
    eq(h.runner.done("claim-1", { outcome: "partial", code: "SCHEDULE_DOWNLOAD_FAILED", result: { saved: 2, failed: 1, secret: "x" } }, 41).ok, true);
    const outcome = await ended;
    eq(outcome.outcome, "partial");
    eq(JSON.stringify(outcome.result), JSON.stringify({ saved: 2, failed: 1 }), "only known result fields");
    eq(h.tabs.closed.join(), "41");
    eq((await h.runner.ready("claim-1", 41)).ok, false, "a finished run has no job");
  });

  await test("Tender runner: a lost claim shows in the ping; a closed tab gives the slot back without an attempt; a slow run times out", async () => {
    const lost = tenderHarness({ live: false });
    const r0 = lost.runner.run(lost.ctx);
    await tick();
    eq(lost.runner.ping("claim-1", 41).live, false);
    lost.runner.tabRemoved(41);
    const closed = await r0;
    eq(JSON.stringify([closed.outcome, closed.code, closed.countsAsAttempt, closed.stopWake]), JSON.stringify(["failed", "SCHEDULE_RUNNER_CLOSED", false, true]));
    const slow = tenderHarness();
    const r1 = slow.runner.run(slow.ctx);
    await tick();
    slow.fireTimeout();
    eq((await r1).code, "SCHEDULE_RUNNER_TIMEOUT");
    eq(slow.tabs.closed.join(), "41", "the tab is closed");
    const none = tenderHarness({ openFails: true });
    const r2 = await none.runner.run(none.ctx);
    eq(JSON.stringify([r2.code, r2.countsAsAttempt]), JSON.stringify(["SCHEDULE_RUNNER_NOT_OPENED", false]));
  });

  await test("Tender runner (5.7): Chrome throttling the hidden runner tab's timers never stops a live run; before an upload the tab asks the worker again when its answer is old", async () => {
    const { createClaimWatch, RUNNER_PING_MS: PING, RUNNER_LIVE_MS: LIVE } = await import("../services/scheduler/tender-runner.js");
    let clock = T0;
    const asked = [];
    let live = true;
    const watch = createClaimWatch({ ask: async () => (asked.push(clock), { ok: true, live }), now: () => clock, wait: () => new Promise(() => {}) });
    eq(await watch.isClaimLive(), true, "live when the worker opened the tab");
    eq(asked.length, 0, "an answer younger than the ping interval is used as it is");
    // none of the tab's timers ran for 70 s (hidden for 5 minutes, Chrome wakes them once a minute at most)
    clock += 70000;
    eq(await watch.isClaimLive(), true, "the worker is asked again, and the run goes on");
    eq(await watch.isClaimLive(), true);
    eq(asked.length, 1, "a fresh answer is not asked for again");
    clock += PING;
    live = false;
    eq(await watch.isClaimLive(), false, "the worker says the claim is lost: the next upload is refused");
    // a worker that does not answer: the last "live" answer counts for RUNNER_LIVE_MS, never longer
    const silent = createClaimWatch({ ask: () => new Promise(() => {}), now: () => clock, wait: async () => {} });
    clock += PING;
    eq(await silent.isClaimLive(), true, `an answer ${PING / 1000} s old still counts`);
    clock += LIVE - PING;
    eq(await silent.isClaimLive(), false, `no answer for ${LIVE / 1000} s: the claim may be lost`);
    // the tab's interval and an upload asking at the same time are one question to the worker
    const once = createClaimWatch({ ask: () => (asked.push("once"), new Promise((resolve) => setTimeout(() => resolve({ live: true }), 0))), now: () => clock, wait: () => new Promise(() => {}) });
    clock += PING;
    await Promise.all([once.refresh(), once.isClaimLive()]);
    eq(asked.filter((a) => a === "once").length, 1);
    // the worker says "live" until LEASE_MS - HEARTBEAT_MS after its last heartbeat, so a "live" answer leaves HEARTBEAT_MS
    // of lease: the oldest answer the tab relies on still leaves at least a minute of it
    assert(HEARTBEAT_MS - LIVE >= 60000 && PING < LIVE && LIVE < LEASE_MS, `${LIVE} ms of trust inside the ${HEARTBEAT_MS} ms a live answer leaves`);
  });

  await test("Tender runner: with the browser's own timers (none injected) a run starts and ends", async () => {
    const h = tenderHarness({ realTimers: true });
    const ended = h.runner.run(h.ctx);
    await tick();
    eq(h.tabs.opened.length, 1, "the runner tab opened (the timeout timer started)");
    eq(h.runner.done("claim-1", { outcome: "done", result: { saved: 1 } }, 41).ok, true);
    eq((await ended).outcome, "done");
    eq(h.tabs.closed.join(), "41");
  });

  await test("Tender run outcome: aborted reservation, session lost, failures -> partial (failed when nothing was saved), else done", () => {
    const counts = (o = {}) => ({ saved: 0, skipped: 0, failed: 0, notReported: 0, aborted: null, ...o });
    eq(tenderRunOutcome({ result: {}, counts: counts({ aborted: "SCHEDULE_CLAIM_LOST" }) }).code, "SCHEDULE_CLAIM_LOST");
    const expired = tenderRunOutcome({ error: { code: "SESSION_EXPIRED" }, counts: counts({ saved: 1 }) });
    eq(JSON.stringify([expired.outcome, expired.code, expired.countsAsAttempt, expired.sessionExpired]), JSON.stringify(["failed", "IREPS_SESSION_EXPIRED", false, true]), "an expired session stays failed, also after a save");
    eq(tenderRunOutcome({ result: { letters: { aborted: { code: "SESSION_EXPIRED" } } }, counts: counts() }).code, "IREPS_SESSION_EXPIRED", "a job that stopped early");
    eq(tenderRunOutcome({ result: {}, counts: counts({ saved: 3, failed: 1 }) }).outcome, "partial");
    eq(tenderRunOutcome({ result: {}, counts: counts({ failed: 1 }) }).outcome, "failed", "nothing saved, a document failed");
    eq(tenderRunOutcome({ result: { summary: { failed: 1 } }, counts: counts() }).outcome, "failed", "a tender the job could not handle, nothing saved");
    eq(tenderRunOutcome({ result: { summary: { failed: 1 } }, counts: counts({ saved: 1 }) }).outcome, "partial", "a tender the job could not handle, after a save");
    const done = tenderRunOutcome({ result: { summary: { failed: 0 } }, counts: counts({ saved: 2, skipped: 5 }) });
    eq(JSON.stringify([done.outcome, done.result.saved, done.result.skipped]), JSON.stringify(["done", 2, 5]));
    eq(tenderCode("ACCOUNT_CHANGED"), "SCHEDULE_ACCOUNT_MISMATCH");
    eq(tenderCode("ECM_REJECTED"), "ECM_REJECTED");
    eq(tenderCode("weird code"), "SCHEDULE_TENDER_FAILED");
    eq(cleanOutcome({ outcome: "won" }).code, "SCHEDULE_TENDER_FAILED", "an unknown outcome is a failure");
    eq(cleanOutcome({ outcome: "done", code: "not a code!" }).code, null);
  });

  await test("Shared hooks: a scheduled IC reaches the ECM with the IREPS row's PO Sr. and Passed Qty.", async () => {
    // the IC list row as IREPS shows it (IC 5445639, TEST ECM 16/11/2026), through the IC flows' own filing
    const row = { poNo: "27253922100240", poSerial: "003", callId: "C1", icNumber: "5445639", icDate: "12/11/2026", passedQty: "4", icPdfUrl: "https://ireps.example/ic.pdf" };
    const [item] = icDateItems([row]).map((i) => ({ id: i.id, url: i.url, path: i.path, label: i.label, ...icFiling(i) }));
    const uploads = [];
    const hooks = createSharedRunHooks({ api: hooksApi(), claimId: "c1", account: ACCOUNT, isClaimLive: () => true, uploadEcm: async (doc) => (uploads.push(doc), { uid: "u1", site: "hosur", path: "/x", deduplicated: false }) });
    await hooks.documentHooks.preflight([item]);
    await hooks.documentHooks.saveFile(new Uint8Array([1]), item.path, item);
    eq(uploads.length, 1);
    eq(uploads[0].kind, "inspectionCertificate");
    eq(JSON.stringify(uploads[0].fields), JSON.stringify({ ic_number: "5445639", customer_po_number: "27253922100240", ic_date: "12/11/2026", customer_po_serial_number: "003", passed_quantity: "4" }), "PO Sr. with its leading zeros, Passed Qty. as IREPS gives it");
  });

  await test("Shared hooks (tender): reserve -> granted / taken; a failed reservation throws; ECM only; unsaved keys released", async () => {
    const api = hooksApi({ taken: { "tender:LOA|T1|2": { status: "done", by: { user_id: 4, name: "Rahul" }, at: "2026-11-16T09:32:00+00:00" } } });
    const uploads = [];
    const hooks = createSharedRunHooks({ api, claimId: "c1", account: ACCOUNT, isClaimLive: () => true, uploadEcm: async (doc) => (uploads.push(doc), { uid: "u1", site: "hosur", path: "/x", deduplicated: false }) });
    const t = hooks.tenderHooks;
    const r = await t.reserveDocuments(["tender:LOA|T1|1", "tender:LOA|T1|2", "tender:LOA|T1|3", "tender:LOA|T1|1"]);
    eq([...r.granted].join(), "tender:LOA|T1|1,tender:LOA|T1|3");
    eq(describeSkip(r.taken.get("tender:LOA|T1|2")), "Already saved by Rahul on 2026-11-16 at 15:02");
    eq(api.calls.reserve[0].keys.length, 3, "each key once");
    const saved = await t.ecmSink.save({ kind: "loi", title: "T1 - LOA", bytes: new Uint8Array([1]), filename: "LOA_T1.pdf" }, () => { throw new Error("must never save locally"); });
    eq(JSON.stringify([saved.local, saved.ecm.uid, uploads[0].account.irepsAccountId]), JSON.stringify([null, "u1", "833"]));
    await t.documentSaved({ doc_type: "loa", doc_key: "tender:LOA|T1|1", filename: "LOA_T1.pdf", destination: "ecm" });
    const counts = await hooks.finishTenderRun();
    eq(JSON.stringify([counts.saved, counts.skipped, counts.failed, counts.aborted]), JSON.stringify([1, 1, 1, null]));
    eq(api.calls.complete.flatMap((c) => c.done.map((d) => d.doc_key)).join(), "tender:LOA|T1|1", "the saved one is reported (at once, 5.8)");
    eq(api.calls.complete.at(-1).failed.map((d) => d.doc_key).join(), "tender:LOA|T1|3", "reserved but not saved: released");

    const down = createSharedRunHooks({ api: hooksApi({ reserveError: conflict("SCHEDULE_CLAIM_LOST") }), claimId: "c2", account: ACCOUNT, isClaimLive: () => true });
    let thrown = null;
    try {
      await down.tenderHooks.reserveDocuments(["tender:LOA|T1|1"]);
    } catch (error) {
      thrown = error;
    }
    eq(thrown && thrown.code, "SCHEDULE_CLAIM_LOST");
    eq((await down.finishTenderRun()).aborted, "SCHEDULE_CLAIM_LOST");
  });

  await test("Shared hooks (tender, 5.8): each saved tender document is reported as soon as it is saved, so a run the runner time limit stops has reported all it saved", async () => {
    const api = hooksApi();
    const hooks = createSharedRunHooks({ api, claimId: "c1", account: ACCOUNT, isClaimLive: () => true });
    const t = hooks.tenderHooks;
    const keys = Array.from({ length: 12 }, (_, i) => `tender:FINANCIAL_TABULATION|T${i}|-`);
    await t.reserveDocuments(keys);
    for (const key of keys.slice(0, 9)) await t.documentSaved({ doc_type: "tender_result", doc_key: key, filename: `${key.split("|")[1]}.pdf`, destination: "ecm" });
    // the worker's time limit (RUNNER_TIMEOUT_MS) closes the runner tab here: finishTenderRun never runs
    eq(api.calls.complete.flatMap((c) => c.done.map((d) => d.doc_key)).join(), keys.slice(0, 9).join(), "the nine saved documents are with the Recon Engine already");
    eq(JSON.stringify([api.calls.complete.length, api.calls.complete.every((c) => c.done.length === 1 && c.failed.length === 0)]), JSON.stringify([9, true]), "one report per saved document");
  });

  await test("Shared hooks (5.7): a claim check that answers later (the runner tab asking the worker) is waited for before each reservation and upload", async () => {
    let live = true;
    const api = hooksApi();
    const uploads = [];
    const hooks = createSharedRunHooks({
      api,
      claimId: "c1",
      account: ACCOUNT,
      isClaimLive: () => new Promise((resolve) => setTimeout(() => resolve(live), 0)),
      uploadEcm: async (doc) => (uploads.push(doc.filename), { uid: "u1", site: "hosur", path: "/x", deduplicated: false })
    });
    const t = hooks.tenderHooks;
    eq([...(await t.reserveDocuments(["tender:LOA|T1|1"])).granted].join(), "tender:LOA|T1|1");
    await t.ecmSink.save({ kind: "loi", title: "T1 - LOA", bytes: new Uint8Array([1]), filename: "LOA_T1_1.pdf" });
    live = false;
    let lost = null;
    try {
      await t.ecmSink.save({ kind: "loi", title: "T1 - LOA", bytes: new Uint8Array([1]), filename: "LOA_T1_2.pdf" });
    } catch (error) {
      lost = error;
    }
    eq(lost && lost.code, "SCHEDULE_CLAIM_LOST");
    let refused = null;
    try {
      await t.reserveDocuments(["tender:LOA|T1|2"]);
    } catch (error) {
      refused = error;
    }
    eq(refused && refused.code, "SCHEDULE_CLAIM_LOST");
    eq(JSON.stringify([uploads, api.calls.reserve.length]), JSON.stringify([["LOA_T1_1.pdf"], 1]), "nothing uploaded or reserved once the answer was 'lost'");
  });

  /* ------------------------------------------------- what a run tells (logs) */

  await test("Shared hooks (tender): a failure the tender code reports is released with its code and named; one never reached says the run stopped", async () => {
    const api = hooksApi();
    const hooks = createSharedRunHooks({ api, claimId: "c1", account: ACCOUNT, isClaimLive: () => true });
    const t = hooks.tenderHooks;
    const keys = ["tender:TENDER_PDF|T7|-", "tender:ATTACHMENTS|T7|a1", "tender:CORRIGENDA|T7|c1"];
    await t.reserveDocuments(keys);
    await t.documentSaved({ doc_type: "tender_nit", doc_key: keys[0], filename: "T7.pdf", destination: "ecm", ecm: { status: "stored", path: "/ECM/Hosur/Tenders" } });
    t.documentFailed({ key: keys[1], doc: "Tender T7 - Annexure A", code: "NOT_PDF", detail: "The file was not a valid PDF." });
    await hooks.finishTenderRun({ stopped: "SESSION_EXPIRED" });
    const sent = api.calls.complete.at(-1).failed;
    // one document that was not downloaded: "Scheduled document not downloaded", not "the download stopped" (1.14)
    eq(sent.map((f) => `${f.doc_key}|${f.code}`).join(), `${keys[1]}|SCHEDULE_DOWNLOAD_FAILED,${keys[2]}|IREPS_SESSION_EXPIRED`);
    const d = hooks.details();
    eq(JSON.stringify(d.failures), JSON.stringify([
      { doc: "Tender T7 - Annexure A", code: "SCHEDULE_DOWNLOAD_FAILED", detail: "The file was not a valid PDF." },
      { doc: "Tender T7 corrigendum c1", code: "IREPS_SESSION_EXPIRED", detail: "not downloaded: the run stopped before it" }
    ]));
    eq(JSON.stringify(d.saved), JSON.stringify([{ doc: "Tender T7 tender PDF", note: "T7.pdf in ECM /ECM/Hosur/Tenders" }]));
  });

  await test("Shared hooks (tender): a failure reported for a document without a reservation of its own, or saved only in part, is named and counted; only reservations are released", async () => {
    const api = hooksApi();
    const hooks = createSharedRunHooks({ api, claimId: "c1", account: ACCOUNT, isClaimLive: () => true });
    const t = hooks.tenderHooks;
    const letter = "pending:833|1|2|3|letter";
    const corrigendum = "tender:CORRIGENDA|T7|c1";
    await t.reserveDocuments([letter, corrigendum]);
    // an attachment of a letter (never reserved on its own), and a corrigendum whose page was saved but not its attachment
    t.documentFailed({ key: "pending:833|1|2|3|attachment:ab", doc: "Tender A - letter 1 attachment", code: "HTTP", detail: "IREPS returned HTTP 500." });
    await t.documentSaved({ doc_type: "tender_corrigendum", doc_key: corrigendum, filename: "C1.pdf", destination: "ecm" });
    t.documentFailed({ key: corrigendum, doc: "Tender T7 - Corrigendum 1 attachment", code: "TIMEOUT", detail: "Failed because IREPS is not responding." });
    t.documentFailed({ doc: "Tender T7 - an attachment with no key", code: "NOT_PDF", detail: "not a PDF" });
    const counts = await hooks.finishTenderRun();
    eq(counts.failed, 4, "the letter never saved, and the three reported failures");
    eq(api.calls.complete.at(-1).failed.map((f) => f.doc_key).join(), letter, "only a reservation that was not saved is released");
    eq(JSON.stringify(hooks.details().failures.map((f) => [f.doc, f.code])), JSON.stringify([
      ["Correspondence letter 3", "SCHEDULE_DOWNLOAD_FAILED"],
      ["Tender A - letter 1 attachment", "SCHEDULE_IREPS_ERROR"],
      ["Tender T7 - Corrigendum 1 attachment", "IREPS_UNAVAILABLE"],
      ["Tender T7 - an attachment with no key", "SCHEDULE_DOWNLOAD_FAILED"]
    ]));
  });

  await test("Tender runner: the tab's failures, warnings and lists reach the worker short and redacted", async () => {
    const long = `upload refused: token=SECRET123 ${"y".repeat(400)}`;
    const cleaned = cleanOutcome({
      outcome: "partial",
      code: "SCHEDULE_DOWNLOAD_FAILED",
      result: { saved: 2, failed: 1, range: "17/11/2026 - 18/11/2026", failures: [{ doc: "Tender 1 - NIT", code: "ECM_UNAVAILABLE", detail: long }], warnings: ["a", "b", "c", "d", "e", "f"], html: "<html>" },
      log: { failures: [{ doc: "Tender 1 - NIT", code: "bad code!", detail: long }], saved: [{ doc: "Tender 2 - LOA", note: "LOA.pdf in the ECM" }], skipped: "not a list" }
    });
    const f = cleaned.result.failures[0];
    assert(!f.detail.includes("SECRET123") && f.detail.length <= 200, f.detail);
    eq(cleaned.result.range, "17/11/2026 - 18/11/2026");
    eq(cleaned.result.warnings.length, 5);
    assert(!("html" in cleaned.result), "unknown fields are dropped");
    eq(cleaned.log.failures[0].code, "SCHEDULE_DOWNLOAD_FAILED", "a code that is not one becomes the generic one");
    eq(JSON.stringify([cleaned.log.saved.length, cleaned.log.skipped.length]), "[1,0]");
  });

  await test("Tender run outcome: the result carries the failed documents, the range and why the job stopped", () => {
    const counts = { saved: 1, skipped: 0, failed: 2, notReported: 0, aborted: null };
    const details = { failures: [{ doc: "Tender 5 LOA 9", code: "IREPS_SESSION_EXPIRED", detail: "not downloaded: the run stopped before it" }], saved: [], skipped: [], more: {} };
    const stopped = tenderRunOutcome({ result: { letters: { aborted: { code: "SESSION_EXPIRED", message: "IREPS logged this session out." } } }, counts, details, range: "17/11/2026 - 18/11/2026" });
    eq(JSON.stringify([stopped.outcome, stopped.code, stopped.result.detail, stopped.result.range, stopped.result.failures.length]), JSON.stringify(["failed", "IREPS_SESSION_EXPIRED", "IREPS logged this session out.", "17/11/2026 - 18/11/2026", 1]));
    eq(JSON.stringify(stopped.log), JSON.stringify(details), "the full lists go to this browser's run log");
    eq(stoppedCode(null, { code: "TIMEOUT" }), "TIMEOUT");
    eq(stoppedCode({ tabulations: { aborted: { code: "ACCOUNT_CHANGED" } } }), "ACCOUNT_CHANGED");
    eq(stoppedCode({ summary: { failed: 1 } }), null);
  });

  /** The counts finishTenderRun gives, and a category of a tender job (tender-workflows.js newCategory). */
  const tenderCounts = (o = {}) => ({ saved: 0, skipped: 0, failed: 0, notReported: 0, aborted: null, ...o });
  const category = (o = {}) => ({ status: "DOWNLOADED", discovered: 1, downloaded: 1, failed: 0, files: [], warnings: [], note: "", ...o });

  await test("Tender run outcome: a letter list that did not open, or was read only in part, is never 'done'; the list is named (known issue 1, 1.5)", () => {
    const letters = (o) => ({ letters: { tenders: [], listErrors: {}, listWarnings: {}, aborted: null, summary: { newLetters: 0 }, ...o } });
    const closed = tenderRunOutcome({ result: letters({ listErrors: { MyNegotiation: "IREPS failed to open the Negotiation page - IREPS is not responding." } }), counts: tenderCounts(), details: noDetails() });
    eq(JSON.stringify([closed.outcome, closed.code]), JSON.stringify(["failed", "SCHEDULE_LIST_INCOMPLETE"]), "nothing read, nothing saved");
    eq(closed.result.warnings[0], "Negotiation letter list: IREPS failed to open the Negotiation page - IREPS is not responding.");
    const inPart = tenderRunOutcome({
      result: letters({ tenders: [{ tenderNo: "P1", categories: { negotiation: category() } }], listWarnings: { MyNegotiation: "The Negotiation list was not read in full (HTTP 500); letters on the part not read were not downloaded." } }),
      counts: tenderCounts({ saved: 1 }), details: noDetails()
    });
    eq(JSON.stringify([inPart.outcome, inPart.code]), JSON.stringify(["partial", "SCHEDULE_LIST_INCOMPLETE"]), "the letters read were saved, the rest is fetched at the next check");
    assert(/^Negotiation letter list: The Negotiation list was not read in full/.test(inPart.result.warnings[0]), inPart.result.warnings[0]);
    eq(describeError("SCHEDULE_LIST_INCOMPLETE").title, "IREPS list not read in full");
    const clean = tenderRunOutcome({ result: letters({ tenders: [{ tenderNo: "P1", categories: { negotiation: category() } }] }), counts: tenderCounts({ saved: 1 }), details: noDetails() });
    eq(JSON.stringify([clean.outcome, clean.result.warnings]), JSON.stringify(["done", undefined]), "a list read to its end, every letter saved");
  });

  await test("Tender run outcome: a tender a letters or tabulations run could not handle is named and the run is not 'done'; a run stopped after saves is partial (known issue 1, 1.4)", () => {
    const busy = "IREPS is not responding (its home page answered HTTP 503). This is not a logout: try again in a minute.";
    const tabulations = {
      tenders: [
        { tenderNo: "42263731", categories: { financialTabulation: category(), commercialTabulation: category() } },
        { tenderNo: "69261051", status: "FAILED", code: "IREPS_UNAVAILABLE", error: busy, categories: {} },
        { tenderNo: "24261658", status: "SKIPPED", code: "IREPS_UNAVAILABLE", error: `Skipped: ${busy}`, categories: {} },
        { tenderNo: "11111111", notAvailable: true, categories: {} }
      ],
      aborted: { code: "IREPS_UNAVAILABLE", message: busy }, incomplete: "", summary: { downloaded: 2, withTabulation: 3, notAvailable: 1 }
    };
    const stopped = tenderRunOutcome({ result: { tabulations }, counts: tenderCounts({ saved: 2 }), details: noDetails() });
    eq(JSON.stringify([stopped.outcome, stopped.code, stopped.result.detail]), JSON.stringify(["partial", "IREPS_UNAVAILABLE", busy]), "two tabulations saved, then IREPS stopped answering");
    eq(JSON.stringify(stopped.result.failures.map((f) => [f.doc, f.code])), JSON.stringify([["Tender 69261051", "IREPS_UNAVAILABLE"], ["Tender 24261658", "IREPS_UNAVAILABLE"]]));
    eq(stopped.result.failed, 2);
    eq(tenderRunOutcome({ result: { tabulations }, counts: tenderCounts(), details: noDetails() }).outcome, "failed", "the same stop before anything was saved");
    const thrown = { tenderNo: "T9", status: "FAILED", code: "", error: "the tender record could not be written", categories: {} };
    const one = tenderRunOutcome({ result: { tabulations: { ...tabulations, tenders: [tabulations.tenders[0], thrown], aborted: null } }, counts: tenderCounts({ saved: 2 }), details: noDetails() });
    eq(JSON.stringify([one.outcome, one.code, one.result.failures[0].doc, one.result.failures[0].code]), JSON.stringify(["partial", "SCHEDULE_DOWNLOAD_FAILED", "Tender T9", "SCHEDULE_TENDER_FAILED"]), "one tender's step threw: partial, the tender named");
    const day = tenderRunOutcome({ result: { tabulations: { ...tabulations, tenders: [tabulations.tenders[0]], aborted: null, incomplete: "IREPS did not return the list (Search Tender 20/10/2026 page 2: IREPS returned HTTP 500)." } }, counts: tenderCounts({ saved: 2 }), details: noDetails() });
    eq(JSON.stringify([day.outcome, day.code]), JSON.stringify(["partial", "SCHEDULE_LIST_INCOMPLETE"]), "a closing day not read to its end");
    assert(/Search Tender 20\/10\/2026 page 2/.test(day.result.warnings[0]), day.result.warnings[0]);
  });

  await test("Tender run outcome: NIT Documents - a message IREPS did not open, or My Messages not read to its end, is not 'done'; a message naming no tender, and My Offer left out, are notes (1.3, 2.4)", () => {
    const nit = (o) => ({ messages: { scanned: 3, relevant: 2, opened: 2, pagesRead: 1, total: 3, truncated: false, incomplete: "" }, tenders: [], review: [], failedMessages: [], notes: [], aborted: null, summary: { downloaded: 0, failed: 0, needsReview: 0 }, ...o });
    const notOpened = tenderRunOutcome({ result: nit({ failedMessages: [{ sentDate: "24/11/2026", subject: "NIT for CSD/PER/SOUTHERN RLY, Tender Number: 78266659", code: "HTTP", reason: "IREPS did not open the message: Message detail returned HTTP 503." }] }), counts: tenderCounts(), details: noDetails() });
    eq(JSON.stringify([notOpened.outcome, notOpened.code]), JSON.stringify(["failed", "SCHEDULE_DOWNLOAD_FAILED"]), "retried at the next check");
    eq(JSON.stringify(notOpened.result.failures), JSON.stringify([{ doc: "Message of 24/11/2026: NIT for CSD/PER/SOUTHERN RLY, Tender Number: 78266659", code: "SCHEDULE_IREPS_ERROR", detail: "IREPS did not open the message: Message detail returned HTTP 503." }]));
    assert(!(notOpened.result.warnings || []).some((w) => /could not be matched/.test(w)), "never 'could not be matched to a tender'");
    for (const messages of [{ truncated: true, incomplete: "" }, { truncated: false, incomplete: "IREPS answered with a page DocLink does not recognise (My Messages page 2: \"Error\")." }]) {
      const cut = tenderRunOutcome({ result: nit({ messages: { ...nit().messages, ...messages } }), counts: tenderCounts({ saved: 1 }), details: noDetails() });
      eq(JSON.stringify([cut.outcome, cut.code]), JSON.stringify(["partial", "SCHEDULE_LIST_INCOMPLETE"]), JSON.stringify(messages));
      assert(/^My Messages was not read to the end: /.test(cut.result.warnings[0]), cut.result.warnings[0]);
    }
    const noted = tenderRunOutcome({ result: nit({ review: [{ oid: "1", reason: "No labelled tender number found in the subject or body." }], notes: ["My Offer is not part of scheduled downloads."] }), counts: tenderCounts({ saved: 2 }), details: noDetails() });
    eq(noted.outcome, "done", "IREPS's message names no tender: nothing to retry");
    eq(JSON.stringify(noted.result.warnings), JSON.stringify(["1 IREPS message(s) could not be matched to a tender: open NIT Documents in the panel to review them.", "My Offer is not part of scheduled downloads."]));
  });

  await test("Tender run outcome: a category failure the hooks named is listed once; one they could not name is named; 'Partly done' always says why (1.8)", () => {
    const known = [{ doc: "Tender T7 - Annexure A", code: "SCHEDULE_DOWNLOAD_FAILED", detail: "The file was not a valid PDF." }];
    const result = {
      messages: { truncated: false, incomplete: "" }, review: [], failedMessages: [], summary: { downloaded: 1, failed: 1, needsReview: 0 },
      tenders: [{ tenderNo: "T7", status: "FAILED", categories: {
        tenderPdf: category({ status: "FAILED", downloaded: 0, failed: 1, files: [{ fileName: "", status: "FAILED", error: "Could not open the NIT page (HTTP 500)." }] }),
        attachments: category({ status: "PARTIAL", discovered: 2, failed: 1, files: [{ fileName: "a0.pdf", status: "DOWNLOADED" }, { fileName: "", id: "a1", status: "FAILED", error: "The file was not a valid PDF.", code: "NOT_PDF" }] }),
        corrigenda: category({ status: "PARTIAL", failed: 1, warnings: ["Corrigendum_01_T7.pdf: an attached document could not be downloaded (HTTP 500)"] })
      } }]
    };
    const o = tenderRunOutcome({ result, counts: tenderCounts({ saved: 2, failed: 1 }), details: { failures: known, saved: [], skipped: [], more: {} } });
    eq(JSON.stringify([o.outcome, o.code, o.result.failed]), JSON.stringify(["partial", "SCHEDULE_DOWNLOAD_FAILED", 3]));
    eq(JSON.stringify(o.result.failures.map((f) => [f.doc, f.detail])), JSON.stringify([
      ["Tender T7 - Annexure A", "The file was not a valid PDF."],
      ["Tender T7 - NIT", "Could not open the NIT page (HTTP 500)."],
      ["Tender T7 - Corrigenda", "Corrigendum_01_T7.pdf: an attached document could not be downloaded (HTTP 500)"]
    ]), "the attachment the hooks named once; the NIT step that failed before reserving, and the corrigendum attachment, named here");
    eq(o.log.failures.length, 3, "the run log has them all");
    const unnamed = tenderRunOutcome({ result: { summary: { failed: 2 } }, counts: tenderCounts({ saved: 1 }), details: noDetails() });
    eq(unnamed.outcome, "partial");
    assert(unnamed.result.failures || (unnamed.result.warnings && /could not tell which/.test(unnamed.result.warnings[0])), JSON.stringify(unnamed.result));
    const problems = tenderJobProblems({ tenders: [{ tenderNo: "T1", status: "ALREADY_DOWNLOADED", categories: {} }] });
    eq(JSON.stringify([problems.failures, problems.lists, problems.review]), JSON.stringify([[], 0, 0]), "a tender already downloaded is no problem");
  });

  await test("Tender run outcome: correspondence - a record DocLink could not read is named; letters and rows it could not match are 'Needs review', never 'done' (1.6, 1.8)", () => {
    const corres = (o) => ({ empty: false, summary: { pendingRecords: 2, failed: 0, needsReview: 0 }, skipped: [], failedRecords: [], needsReview: [], aborted: null, ...o });
    const o = tenderRunOutcome({
      result: corres({ failedRecords: [{ tenderNo: "A", code: "HTTP", error: "IREPS returned HTTP 500." }], needsReview: [{ tenderNo: "B", letterNo: "502", reason: "The letter belongs to a different nitOid than the pending record; not downloaded." }, { tenderNo: "C", reason: "No pending-correspondence action with a nitOid was found on this row" }] }),
      counts: tenderCounts(), details: noDetails()
    });
    eq(JSON.stringify([o.outcome, o.code]), JSON.stringify(["failed", "SCHEDULE_DOWNLOAD_FAILED"]));
    eq(JSON.stringify(o.result.failures.map((f) => [f.doc, f.code])), JSON.stringify([["Correspondence of tender A", "SCHEDULE_IREPS_ERROR"], ["Tender B - letter 502", "SCHEDULE_NEEDS_REVIEW"], ["Correspondence of tender C", "SCHEDULE_NEEDS_REVIEW"]]));
    const review = tenderRunOutcome({ result: corres({ needsReview: [{ tenderNo: "C", reason: "No pending-correspondence action with a nitOid was found on this row" }] }), counts: tenderCounts({ saved: 1 }), details: noDetails() });
    eq(JSON.stringify([review.outcome, review.code]), JSON.stringify(["partial", "SCHEDULE_NEEDS_REVIEW"]), "letters saved, one row needs review");
    eq(describeError("SCHEDULE_NEEDS_REVIEW").title, "Needs review");
    eq(tenderRunOutcome({ result: corres({ empty: true, summary: { pendingRecords: 0 } }), counts: tenderCounts(), details: noDetails() }).outcome, "done", "IREPS lists nothing pending");
  });

  await test("Run details: tender IREPS errors get IREPS texts, never the Bill Status or network text (1.14)", () => {
    for (const code of ["TIMEOUT", "UNREACHABLE", "IREPS_UNAVAILABLE"]) eq(tenderCode(code), "IREPS_UNAVAILABLE", code);
    eq(describeError(tenderCode("TIMEOUT")).title, "IREPS not responding");
    eq(describeError(tenderCode("HTTP")).title, "IREPS answered with an error");
    eq(JSON.stringify(["PAGE", "LIST", "SEARCH_INCOMPLETE", "LOA_SCRIPT", "ACCOUNT", "TENDER_SEARCH_SHORT"].map((c) => tenderCode(c))),
      JSON.stringify(["TENDER_PAGE_NOT_RECOGNISED", "TENDER_LIST_FAILED", "TENDER_SEARCH_INCOMPLETE", "TENDER_LOA_SCRIPT_UNREADABLE", "SCHEDULE_ACCOUNT_UNVERIFIED", "TENDER_SEARCH_SHORT"]));
    eq(tenderCode("NOT_PDF", "SCHEDULE_DOWNLOAD_FAILED"), "SCHEDULE_DOWNLOAD_FAILED", "one document: not downloaded, not 'the download stopped'");
    for (const code of ["TIMEOUT", "UNREACHABLE", "HTTP", "PAGE", "LIST", "SEARCH_INCOMPLETE", "NOT_PDF", "EMPTY"]) {
      const text = describeError(tenderCode(code, "SCHEDULE_DOWNLOAD_FAILED"));
      assert(!/Bill Status|network connection/i.test(`${text.title} ${text.message}`), `${code}: ${text.title} - ${text.message}`);
    }
    for (const code of ["SCHEDULE_IREPS_ERROR", "SCHEDULE_LIST_INCOMPLETE", "SCHEDULE_NEEDS_REVIEW"]) {
      const text = describeError(code);
      assert(text.code === code && !/[\u2013\u2014]/.test(`${text.title}${text.message}`), `${code} has its own text, with no en or em dash`);
    }
  });

  await test("90 days: Bill Status, CRN and R-NOTE always search the last 90 days, whatever the schedule's look-back", () => {
    const thirtyDays = { lookbackDays: 30, dateFrom: "20/10/2026", dateTo: "18/11/2026" };
    eq(JSON.stringify(exportLaunchOptions("billStatus", thirtyDays)), JSON.stringify({ mode: "last90Days", destination: "recon" }), 'Bill Status: IREPS "Last 90 Days", to S3');
    for (const type of ["crn", "rnote"]) {
      eq(JSON.stringify(exportLaunchOptions(type, thirtyDays)), JSON.stringify({ dateFrom: "21/08/2026", dateTo: "18/11/2026", destination: "recon", format: "xlsx" }), `${type}: 90 days up to the claim's today, .xlsx to S3`);
    }
    eq(scheduledSearch("crn", { dateTo: "15/01/2027" }).dateFrom, "18/10/2026", "across the year end");
    eq(scheduledSearch("rnote", {}, Date.parse("2026-11-18T20:00:00Z")).text, "22/08/2026 - 19/11/2026", "no date in the claim: today in IST");
    eq(scheduledSearch("ma", { dateFrom: "17/11/2026", dateTo: "18/11/2026" }).text, "17/11/2026 - 18/11/2026", "the other types keep the claim's range");
    eq(scheduledSearch("icNotifications", { dateFrom: "17/11/2026", dateTo: "18/11/2026" }).text, "");
    eq(JSON.stringify(FIXED_LOOKBACK), JSON.stringify({ billStatus: 90, crn: 90, rnote: 90 }));
  });

  await test("Run details: document keys read as the panel's names; an entry is short and keeps no secret", () => {
    eq(labelFromKey("po:1234|NFR"), "PO 1234 (NFR)");
    eq(labelFromKey("ic:PO1|2|C3"), "IC C3 (PO PO1 Sr. 2)");
    eq(labelFromKey("ma:PO1|007327"), "MA 007327 (PO PO1)");
    eq(labelFromKey("tender:LOA|10263703|1503282"), "Tender 10263703 LOA 1503282");
    eq(labelFromKey("pending:833|101|55|9001|letter"), "Correspondence letter 9001");
    eq(labelFromKey("export:crn:abc123"), "CRN export");
    const entry = failureEntry({ key: "po:1", code: "lower", detail: `Authorization: Bearer abc.def ${"z".repeat(300)}` });
    eq(entry.doc, "PO 1");
    eq(entry.code, "SCHEDULE_DOWNLOAD_FAILED");
    assert(!entry.detail.includes("abc.def") && entry.detail.length <= 200, entry.detail);
    const big = { saved: 1, failures: Array.from({ length: 40 }, (_, i) => ({ doc: `PO ${i}`, code: "X", detail: "d".repeat(500) })) };
    const fitted = fitResult(big);
    assert(JSON.stringify(fitted).length <= RESULT_MAX_CHARS && fitted.failures.length + fitted.failuresMore === 40, "cut to fit, the rest counted");
    eq(fitResult({ saved: 1 }).saved, 1, "a small result is left as it is");
  });

  await test("Run log: runs with their documents and the scheduler's events; a repeated event is one line with a count; capped", async () => {
    let clock = Date.parse("2026-11-19T03:32:00Z"); // 09:02 IST
    const area = memoryArea();
    const runLog = createRunLog({ storage: area, now: () => clock });
    for (let i = 0; i < 3; i++) {
      await runLog.event("ireps", "Due now: Bill Status. Waiting for IREPS: no IREPS page has loaded.", ["billStatus"]);
      clock += 10 * 60000;
    }
    await runLog.event("other", "MA copies: being run by Rahul.", ["ma"]);
    await runLog.runStarted({ id: "c9", docType: "tenderNit", slotId: 7, period: "10:30", account: "833", range: "17/11/2026 - 18/11/2026" });
    const failures = Array.from({ length: 5 }, (_, i) => ({ doc: `Tender ${i} tender PDF`, code: "ECM_UNAVAILABLE", detail: "the ECM did not answer in time" }));
    await runLog.runFinished("c9", { outcome: "partial", code: "SCHEDULE_DOWNLOAD_FAILED", result: { saved: 35, skipped: 18, failed: 5 }, log: { failures, saved: [{ doc: "Tender 9 tender PDF", note: "T9.pdf in the ECM" }], skipped: [], more: { saved: 34 } } });
    const log = await runLog.read();
    eq(log.events.length, 2);
    eq(JSON.stringify([log.events[1].count, log.events[1].first, log.events[1].at]), JSON.stringify([3, "2026-11-19T03:32:00.000Z", "2026-11-19T03:52:00.000Z"]));
    const run = log.runs[0];
    eq(JSON.stringify([run.outcome, run.counts, run.failures.length, run.more]), JSON.stringify(["partial", { saved: 35, skipped: 18, failed: 5 }, 5, { saved: 34 }]));
    const text = runLogText(log, { account: "833", version: "1.6.6", savedAt: "2026-11-19T05:00:00Z" });
    for (const line of ["IREPS account 833", "Tender NIT documents (10:30 run)  PARTLY DONE", "Searched: 17/11/2026 - 18/11/2026", "Counts: 35 saved, 18 already saved, 5 failed", "Not saved (5):", `- Tender 0 tender PDF: ${describeError("ECM_UNAVAILABLE").title} (the ECM did not answer in time) [ECM_UNAVAILABLE]`, "Saved (35):", "... and 34 more", "2026-11-19 09:02 to 09:22 (3 times)  Due now: Bill Status."]) {
      assert(text.includes(line), `the text has "${line}"\n${text}`);
    }
    assert(!/[\u2013\u2014]/.test(text), "no en or em dash");
    for (let i = 0; i < MAX_RUNS + 5; i++) await runLog.runStarted({ id: `r${i}`, docType: "ma" });
    eq((await runLog.read()).runs.length, MAX_RUNS, "the oldest runs go");
    const broken = createRunLog({ storage: { get: async () => { throw new Error("quota"); }, set: async () => { throw new Error("quota"); } } });
    await broken.event("ireps", "x");
    eq(JSON.stringify(await broken.read()), JSON.stringify({ runs: [], events: [] }), "a storage that fails never throws");
  });

  await test("Schedule view: an opened row names every document not saved and why; a missed slot says what this browser noted in its window", () => {
    const nineToTen = { window_start_at: "2026-11-19T03:30:00+00:00", window_end_at: "2026-11-19T04:30:00+00:00" }; // 09:00-10:00 IST
    const now = Date.parse("2026-11-19T05:00:00Z");
    const partial = { id: 3, doc_type: "tenderNit", period: "10:30", status: "partial", code: "SCHEDULE_DOWNLOAD_FAILED", attempts: 1, started_at: "2026-11-19T05:15:00+00:00", ended_at: "2026-11-19T05:22:00+00:00", ...nineToTen,
      result: { saved: 35, skipped: 18, failed: 5, range: "17/11/2026 - 18/11/2026", failures: [{ doc: "Tender 1 - NIT", code: "ECM_UNAVAILABLE", detail: "the ECM did not answer in time" }], failuresMore: 4 } };
    const d = slotDetails(partial, { now });
    assert(d.facts.includes("Searched: 17/11/2026 - 18/11/2026") && d.facts.includes("Attempts so far: 1"), d.facts.join(" | "));
    eq(JSON.stringify([d.failures.length, d.failuresMore, d.failures[0].doc]), JSON.stringify([1, 4, "Tender 1 - NIT"]));
    // this browser ran it: its run log has all five, and the row says so
    const local = { runs: [{ id: "c1", slotId: 3, startedAt: "2026-11-19T05:15:02Z", outcome: "partial", failures: new Array(5).fill({ doc: "Tender X", code: "ECM_UNAVAILABLE", detail: null }), more: {} }], events: [] };
    const mine = slotDetails(partial, { log: local, now });
    eq(JSON.stringify([mine.failures.length, mine.failuresMore]), "[5,0]");
    assert(mine.facts.some((f) => f.includes("(this browser)")), mine.facts.join(" | "));

    const missed = { id: 1, doc_type: "billStatus", period: "day", status: "missed", ...nineToTen };
    const log = { runs: [], events: [
      { kind: "ireps", first: "2026-11-19T03:32:00Z", at: "2026-11-19T04:20:00Z", count: 6, text: "Due now: Bill Status, CRN, R-NOTE. Waiting for IREPS.", types: ["billStatus", "crn", "rnote"] },
      { kind: "other", first: "2026-11-19T03:40:00Z", at: "2026-11-19T03:40:00Z", text: "MA copies: being run by Rahul.", types: ["ma"] },
      { kind: "ireps", first: "2026-11-19T06:00:00Z", at: "2026-11-19T06:00:00Z", text: "Later.", types: ["billStatus"] }
    ] };
    eq(JSON.stringify(slotDetails(missed, { log, now }).events), JSON.stringify(["09:02-09:50 (6 checks): Due now: Bill Status, CRN, R-NOTE. Waiting for IREPS."]));
    assert(/noted nothing during 09:00-10:00/.test(slotDetails(missed, { log: { runs: [], events: [] }, now }).events[0]), "nothing noted is said too");
    eq(slotDetails({ id: 2, doc_type: "crn", status: "pending", window_start_at: "2026-11-19T06:00:00+00:00", window_end_at: "2026-11-19T07:00:00+00:00" }, { now }), null, "a slot still to come has nothing to open");
    // an hourly type: an earlier run that failed shows under the latest one
    const earlier = [{ id: 4, doc_type: "ma", period: "09:00", status: "partial", code: "SCHEDULE_DOWNLOAD_FAILED", ...nineToTen, result: { saved: 1, failed: 1, failures: [{ doc: "MA 7 (PO 1)", code: "IREPS_MA_DOWNLOAD_FAILED", detail: "HTTP 500" }] } }];
    const hourly = slotDetails({ id: 5, doc_type: "ma", period: "10:00", status: "done", done_by: { name: "Priya" }, started_at: "2026-11-19T04:35:00+00:00", ended_at: "2026-11-19T04:36:00+00:00", window_start_at: "2026-11-19T04:30:00+00:00", window_end_at: "2026-11-19T05:30:00+00:00", result: { saved: 2, found: 3 } }, { earlier, now });
    eq(hourly.earlier.length, 1);
    eq(hourly.earlier[0].failures[0].doc, "MA 7 (PO 1)");
    assert(hourly.facts.includes("Ran 10:05 to 10:06 (Priya)") && hourly.facts.includes("Counts: 3 found"), hourly.facts.join(" | "));
  });

  await test("Schedule view: after a save, a once-a-day slot that kept its old time says when the new time applies", () => {
    const schedule = { doc_type: "billStatus", window_start: "11:00", window_end: "12:00", repeat_every_minutes: null, enabled: true };
    const slotAt = (status, from, to) => ({ doc_type: "billStatus", period: "day", status, window_start_at: from, window_end_at: to });
    const old = ["2026-11-19T03:30:00+00:00", "2026-11-19T04:30:00+00:00"]; // 09:00-10:00
    const moved = ["2026-11-19T05:30:00+00:00", "2026-11-19T06:30:00+00:00"]; // 11:00-12:00
    assert(/applies from tomorrow/.test(savedNotice(schedule, { slots: [slotAt("missed", ...old)] })), "missed and not reopened");
    assert(/already ran today/.test(savedNotice(schedule, { slots: [slotAt("done", ...old)] })), "done today");
    eq(savedNotice(schedule, { slots: [slotAt("pending", ...moved)] }), "", "the slot took the new time: nothing to say");
    eq(savedNotice(schedule, { slots: [] }), "", "no slot today yet");
    eq(savedNotice({ ...schedule, doc_type: "ma", repeat_every_minutes: 60 }, { slots: [slotAt("missed", ...old)] }), "", "hourly types make the right slot at the next look");
  });
}

/**
 * Tests for Phase 1 scheduled downloads (services/scheduler/, background/scheduler-job.js helpers,
 * popup/popup-schedule.js helpers): the schedular_phase1 setting, the order of checks (nothing is
 * sent to IREPS before this DocLink has won a claim, and never on a timer), claims and hand-overs,
 * the runners' outcomes, the shared hooks (reserved per IREPS account, S3 / ECM only, never local)
 * and the Recon Engine client. Everything runs on fakes: no extension API, no network, a fake clock.
 * Invoked from run-tests.js.
 */

import { parseSchedulerConfig, SCHEDULE_TYPES, SCHEDULE_DEFAULT_TIMING, TENDER_SCHEDULE_TYPES } from "../services/scheduler/schedule-types.js";
import { createTenderRunner, tenderRunOutcome, cleanOutcome, tenderCode, RUNNER_PAGE } from "../services/scheduler/tender-runner.js";
import { createScheduler, LEASE_MS, HEARTBEAT_MS, RUNNING_POLL_MS, DEBOUNCE_MS } from "../services/scheduler/scheduler.js";
import { createRunnerFactory, failedOutcome } from "../services/scheduler/runners.js";
import { createSharedRunHooks, istParts, RESERVE_CHUNK } from "../services/scheduler/shared-run-hooks.js";
import { createScheduleApi, ScheduleApiError } from "../services/scheduler/schedule-api.js";
import { createLocalSignals, IREPS_ACTIVITY_MS } from "../services/scheduler/local-signals.js";
import { isIrepsActivityUrl } from "../background/scheduler-job.js";
import { slotText, istTime, todayRows, earlierText } from "../popup/popup-schedule.js";
import { describeSkip, SKIP_REASON } from "../services/download-log.js";
import { EcmError } from "../services/ecm-service.js";
import { WorkflowError } from "../services/export-save-service.js";
import { DOCUMENT_DOWNLOAD_STATUS } from "../services/search-po/document-downloader.js";
import { describeError } from "../utils/messages.js";

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
    now: () => clock,
    random: () => 0,
    uuid: (() => {
      let n = 0;
      return () => `claim-${++n}`;
    })(),
    timers: {
      setInterval: (fn, ms) => intervals.push({ fn, ms }) - 1,
      clearInterval: () => {},
      setTimeout: (fn, ms) => timeouts.push({ fn, ms }) - 1,
      clearTimeout: () => {}
    }
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

  await test("Scheduler: IC not in schedular_phase1 -> IC types are not asked for, and an IC slot is never claimed", async () => {
    const cfg = parseSchedulerConfig({ schedular_phase1: { enabled: true, documents: ["BillStatus", "CRN", "RNote", "MA", "PO"] } });
    const h = harness({ config: cfg, dues: [{ due: [slot(9, "icDate"), slot(10, "icNotifications")], running: null, next_check_at: null, slots: [] }] });
    await h.scheduler.wake("ireps page");
    assert(!h.calls.due[0].types.includes("icDate") && !h.calls.due[0].types.includes("icNotifications"), "not asked for");
    eq(h.calls.claim.length, 0, "an IC slot the backend returns anyway is not claimed");
    eq(h.calls.runs.length, 0);
  });

  /* -------------------------------------------------------------- runners */

  await test("Runners: an export saved -> done; an identical export already saved -> done (skipped), never retried", async () => {
    const statsFor = { saved: 1, skipped: 0, failed: 0, notReported: 0 };
    const factory = createRunnerFactory({ api: {}, makeHooks: () => ({ saveExport: () => {}, stats: () => statsFor }) });
    const run = factory.exportRunner(async () => ({ started: true, done: Promise.resolve({ ok: true, summary: { recordCount: 12, storedPath: "s3://x" } }) }));
    const done = await run({});
    eq(done.outcome, "done");
    eq(done.result.records, 12);
    Object.assign(statsFor, { saved: 0, skipped: 1 });
    const skipped = await run({});
    eq(skipped.outcome, "done");
    eq(skipped.result.skipped, 1);
  });

  await test("Runners: a manual run holds the job -> given back without an attempt; a lost session -> no attempt", async () => {
    const factory = createRunnerFactory({ api: {}, makeHooks: () => ({ saveExport: () => {}, stats: () => ({}) }) });
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
    const factory = createRunnerFactory({ api: {}, makeHooks: () => ({ documentHooks: {}, finishDocuments: async () => counts }) });
    const run = factory.documentRunner(async () => ({ started: true, done: Promise.resolve({ ok: true, items: [{}, {}, {}, {}, {}] }) }));
    eq((await run({})).outcome, "partial");
    counts = { ...counts, failed: 0 };
    eq((await run({})).outcome, "done");
    counts = { ...counts, aborted: "SCHEDULE_CLAIM_LOST" };
    const lost = await run({});
    eq(lost.outcome, "failed");
    eq(lost.code, "SCHEDULE_CLAIM_LOST");
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
    eq(isIrepsActivityUrl("not a url", base), false);
    eq(isIrepsActivityUrl("https://www.ireps.gov.in/epsn/home/showHome.do", ""), false, "no configured portal: nothing counts");
  });

  await test("Schedule view: slot lines say who did what, in IST", () => {
    eq(istTime("2026-11-17T04:38:00+00:00"), "10:08");
    eq(slotText({ status: "done", done_by: { name: "Priya" }, ended_at: "2026-11-17T04:38:00+00:00", result: { saved: 1, skipped: 2 } }), "Done by Priya at 10:08 · 1 saved, 2 already saved");
    eq(slotText({ status: "in_progress", holder: { name: "Rahul" } }), "Running – Rahul");
    assert(slotText({ status: "pending", window_start_at: "2026-11-17T03:30:00+00:00", window_end_at: "2026-11-17T06:30:00+00:00" }).includes("09:00–12:00"));
    assert(slotText({ status: "missed", window_start_at: "2026-11-17T03:30:00+00:00", window_end_at: "2026-11-17T06:30:00+00:00" }).startsWith("Nobody with DocLink"));
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
  function tenderHarness({ openFails = false, live = true } = {}) {
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
      timers: { setTimeout: (fn) => (pending.push(fn), pending.length), clearTimeout: () => {} },
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

  await test("Tender run outcome: aborted reservation, session lost, failures -> partial, else done", () => {
    const counts = (o = {}) => ({ saved: 0, skipped: 0, failed: 0, notReported: 0, aborted: null, ...o });
    eq(tenderRunOutcome({ result: {}, counts: counts({ aborted: "SCHEDULE_CLAIM_LOST" }) }).code, "SCHEDULE_CLAIM_LOST");
    const expired = tenderRunOutcome({ error: { code: "SESSION_EXPIRED" }, counts: counts({ saved: 1 }) });
    eq(JSON.stringify([expired.code, expired.countsAsAttempt, expired.sessionExpired]), JSON.stringify(["IREPS_SESSION_EXPIRED", false, true]));
    eq(tenderRunOutcome({ result: { letters: { aborted: { code: "SESSION_EXPIRED" } } }, counts: counts() }).code, "IREPS_SESSION_EXPIRED", "a job that stopped early");
    eq(tenderRunOutcome({ result: {}, counts: counts({ saved: 3, failed: 1 }) }).outcome, "partial");
    eq(tenderRunOutcome({ result: { summary: { failed: 1 } }, counts: counts() }).outcome, "partial", "a tender the job could not handle");
    const done = tenderRunOutcome({ result: { summary: { failed: 0 } }, counts: counts({ saved: 2, skipped: 5 }) });
    eq(JSON.stringify([done.outcome, done.result.saved, done.result.skipped]), JSON.stringify(["done", 2, 5]));
    eq(tenderCode("ACCOUNT_CHANGED"), "SCHEDULE_ACCOUNT_MISMATCH");
    eq(tenderCode("ECM_REJECTED"), "ECM_REJECTED");
    eq(tenderCode("weird code"), "SCHEDULE_TENDER_FAILED");
    eq(cleanOutcome({ outcome: "won" }).code, "SCHEDULE_TENDER_FAILED", "an unknown outcome is a failure");
    eq(cleanOutcome({ outcome: "done", code: "not a code!" }).code, null);
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
    const last = api.calls.complete[api.calls.complete.length - 1];
    eq(last.done.map((d) => d.doc_key).join(), "tender:LOA|T1|1");
    eq(last.failed.map((d) => d.doc_key).join(), "tender:LOA|T1|3", "reserved but not saved: released");

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
}

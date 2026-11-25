/**
 * "Scheduled downloads" (Phase 1): what the shared schedules of this IREPS account did today, and
 * - for an admin (doclink.schedule.manage) - the schedules themselves.
 *
 * The schedules live in the Recon Engine, per IREPS account; whichever DocLink user is logged in
 * to IREPS first runs a due download - once a day, or once per period (hourly) for a repeating
 * schedule - always to S3 / ECM (background/scheduler-job.js).
 * This view only shows and edits; it never starts a download itself. The header icon appears only
 * when config.json "schedular_phase1" switches scheduling on for this DocLink.
 *
 * A row of Today opens to say what its run searched, who ran it and when, why it stopped, and which
 * documents it could not save, each with its reason (the slot's result, kept by the Recon Engine for
 * every user; this browser's own runs in full). A slot that did not run shows what this browser's
 * scheduler noted during its window. "Run log of this browser" lists every run and decision of this
 * DocLink's scheduler, and copies or saves it as text.
 */

import { MESSAGE_TYPES, describeError } from "../utils/messages.js";
import { readConfigFiles } from "../utils/config.js";
import { parseSchedulerConfig, SCHEDULE_TYPES, SCHEDULE_TYPE_LABEL, SCHEDULE_DEFAULT_TIMING } from "../services/scheduler/schedule-types.js";
import { FIXED_LOOKBACK, NO_RANGE_TYPES, MAX_LOOKBACK } from "../services/scheduler/run-details.js";
import { runLogText, istDateTime, countsText } from "../services/scheduler/run-log.js";
import { logger } from "../utils/logger.js";

const $ = (id) => document.getElementById(id);
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const INTERVALS = [10, 15, 30, 60];
/** The From / To dropdowns: 24 hours, and minutes in 5-minute steps. */
const HOURS = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0"));
const MINUTES = Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, "0"));
/** repeat_every_minutes choices: null runs once a day, a number once per period of that length. */
const REPEATS = [
  [null, "once a day"],
  [30, "every 30 min"],
  [60, "every hour"],
  [120, "every 2 hours"],
  [180, "every 3 hours"]
];
// the Recon Engine's defaults (schedules.py LOOKBACK_DEFAULT); tabulations go by closing date and appear days later,
// and search 5 days at most (run-details.js MAX_LOOKBACK: the field stops there, and a run never searches more).
// Bill Status, CRN and R-NOTE always search 90 days (run-details.js FIXED_LOOKBACK): their look-back is not editable.
const DEFAULT_LOOKBACK = {
  billStatus: 90, crn: 90, rnote: 90, ma: 2, poDate: 2, icDate: 2, icNotifications: 1,
  tenderNit: 2, tenderCounterOffer: 2, tenderLoa: 2, tenderTabulations: 5, tenderCorrespondence: 1, tenderNegotiation: 2
};
/** Types whose run takes no date range (what IREPS lists now). */
const NO_LOOKBACK = new Set(NO_RANGE_TYPES);
/** Failed documents shown under a row (the run log's text has them all). */
const SHOWN_FAILURES = 50;
/** Runs and events shown in "Run log of this browser" (Copy / Save give all of them). */
const SHOWN_RUNS = 30;
const SHOWN_EVENTS = 60;
/** Saved / skipped documents shown per run in the run log. */
const SHOWN_DOCS = 25;

let el = null;
let ctx = null;
let loading = false;
/** The last view drawn: what Copy / Save write. */
let lastView = null;
/** Types whose schedule box the admin opened: kept open when the list is drawn again (after a save). */
const openEditors = new Set();
/** Today rows and run-log runs the user opened: kept open when the view is drawn again. */
const openRows = new Set();
/**
 * The schedule boxes drawn, by type, and the types whose box has changes not saved yet. The worker's
 * state messages redraw the view every few minutes while downloads run: a box being edited (or holding
 * the focus, e.g. an open dropdown) is kept as it is, so a Save never sends the old values.
 */
const editorBoxes = new Map();
const dirtyEditors = new Set();

/** "2026-11-16T04:38:00+00:00" -> "10:08" (IST), "" when not a time. */
export function istTime(iso) {
  const ms = Date.parse(iso || "");
  return Number.isFinite(ms) ? new Date(ms + 330 * 60000).toISOString().slice(11, 16) : "";
}

const typeLabel = (type) => SCHEDULE_TYPE_LABEL[type] || type;
const who = (person) => (person && person.name ? person.name : "another DocLink user");

/** The result line of a finished slot, e.g. "2 saved, 5 already saved". */
function resultText(result) {
  if (!result) return "";
  const parts = [];
  if (result.saved) parts.push(`${result.saved} saved`);
  if (result.skipped) parts.push(`${result.skipped} already saved`);
  if (result.failed) parts.push(`${result.failed} failed`);
  // "nothing new" only when IREPS listed nothing: never over a run that could not read or save something
  const troubled = (Array.isArray(result.failures) && result.failures.length > 0) || (Array.isArray(result.warnings) && result.warnings.length > 0);
  if (parts.length === 0 && !troubled && (result.found === 0 || result.records === 0)) parts.push("nothing new in IREPS");
  return parts.join(", ");
}

/**
 * A slot that ran in its window (started, or counted an attempt), as against one no DocLink ever ran:
 * a run that did not end clean before its window closed is "missed" too, but it did run.
 */
const ranInWindow = (slot) => Boolean(slot.started_at) || Number(slot.attempts) > 0;

/** Chip text and class of a slot status. */
const STATUS_CHIP = {
  pending: ["Waiting", "chip-queued"],
  in_progress: ["Running", "chip-downloading"],
  done: ["Done", "chip-completed"],
  partial: ["Partly done", "chip-queued"],
  failed: ["Will retry", "chip-queued"],
  failed_final: ["Failed", "chip-failed"],
  missed: ["Missed", "chip-failed"]
};

/** A slot of a repeating schedule (one per period, e.g. hourly), not the day's only slot. */
const isPeriodSlot = (slot) => Boolean(slot.period) && slot.period !== "day";

/** A slot's window in IST: "09:00-10:00". */
const slotWindow = (slot) => `${istTime(slot.window_start_at)}-${istTime(slot.window_end_at)}`;

/** "10:15" for a time today (IST), "2026-11-18 10:15" for an earlier day. */
function whenText(iso, now = Date.now()) {
  const full = istDateTime(iso);
  return full && full.slice(0, 10) === istDateTime(new Date(now).toISOString()).slice(0, 10) ? full.slice(11) : full;
}

/** "09:02" or "09:02-09:50 (6 checks)" for a run-log event. */
function eventTime(event, now = Date.now()) {
  const first = event.first || event.at;
  const span = first && first !== event.at ? `${whenText(first, now)}-${istTime(event.at)}` : whenText(event.at, now);
  return `${span}${Number(event.count) > 1 ? ` (${event.count} checks)` : ""}`;
}

/** How far this browser's clock may be from the Recon Engine's when a run of the log is matched to a slot's run. */
const CLOCK_SLACK_MS = 10 * 60000;

/**
 * This browser's run of `slot` from its run log, when it is the slot's latest run (started when the slot
 * says its run started: another DocLink may have run the slot again since), or null.
 */
function localRunOf(slot, log) {
  const started = Date.parse(slot.started_at || "");
  const runs = (log && Array.isArray(log.runs) ? log.runs : []).filter((r) => r.slotId === slot.id && r.outcome !== "running");
  const run = runs[0] || null;
  return run && Number.isFinite(started) && Math.abs(Date.parse(run.startedAt || "") - started) < CLOCK_SLACK_MS ? run : null;
}

/**
 * The run-log events of this browser that fall in `slot`'s window and concern its type (an event
 * without types, such as "not signed in to the Recon Engine", concerns every type).
 */
function windowEvents(slot, log) {
  const start = Date.parse(slot.window_start_at || "");
  const end = Date.parse(slot.window_end_at || "");
  if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
  return (log && Array.isArray(log.events) ? log.events : []).filter((e) => {
    const first = Date.parse(e.first || e.at || "");
    const last = Date.parse(e.at || "");
    const ofType = !Array.isArray(e.types) || e.types.length === 0 || e.types.includes(slot.doc_type);
    return ofType && first <= end && last >= start && e.kind !== "schedule";
  });
}

/**
 * What a Today row shows when it is opened, beyond its one line: the facts of its run (range searched,
 * when and by whom, file saved, why it stopped), every document it could not save with the reason, the
 * warnings, the earlier runs of the day that did not end clean, and, for a slot that has not run, what
 * this browser's scheduler noted during its window. Nothing (null) when there is nothing to add.
 * Failed documents come from this browser's run log when it ran the slot (the full list), else from the
 * slot's result (the first 20, kept by the Recon Engine for every user).
 * @param {object} slot
 * @param {{ earlier?: object[], log?: { runs: object[], events: object[] }|null, now?: number }} [context]
 * @returns {{ facts: string[], failures: object[], failuresMore: number, fromLog: boolean, warnings: string[], earlier: { text: string, failures: object[] }[], events: string[] }|null}
 *          fromLog: the failures come from this browser's run log (all of them), not the slot's result
 */
export function slotDetails(slot, { earlier = [], log = null, now = Date.now() } = {}) {
  const r = slot.result && typeof slot.result === "object" ? slot.result : {};
  const local = localRunOf(slot, log);
  const facts = [];
  if (r.range || (local && local.range)) facts.push(`Searched: ${r.range || local.range}`);
  if (slot.started_at && slot.status !== "pending") {
    const by = slot.status === "done" ? slot.done_by : slot.holder;
    const byText = local ? "this browser" : by && by.name ? by.name : "";
    facts.push(`Ran ${istTime(slot.started_at)}${slot.ended_at ? ` to ${istTime(slot.ended_at)}` : ""}${byText ? ` (${byText})` : ""}`);
  }
  const counts = countsText({ found: r.found, records: r.records, notReported: r.notReported });
  if (counts) facts.push(`Counts: ${counts}`);
  if (r.file) facts.push(`Saved to: ${r.file}`);
  if (slot.code && slot.status !== "done" && (r.detail || slot.code !== "SCHEDULE_DOWNLOAD_FAILED")) facts.push(`Why: ${describeError(slot.code).title}${r.detail ? ` (${r.detail})` : ""}`);
  if (Number(slot.attempts) > 0 && slot.status !== "done") facts.push(`Attempts so far: ${slot.attempts}`);

  const fromLog = Boolean(local && local.failures && local.failures.length);
  const failures = fromLog ? local.failures : Array.isArray(r.failures) ? r.failures : [];
  const failuresMore = fromLog ? Number((local.more && local.more.failures) || 0) : Number(r.failuresMore || 0);
  const warnings = (Array.isArray(r.warnings) ? r.warnings : (local && local.warnings) || []).filter((w) => typeof w === "string");

  const notClean = earlier.filter((s) => ["partial", "failed", "failed_final", "missed"].includes(s.status) || (s.result && Array.isArray(s.result.failures) && s.result.failures.length));
  const earlierRuns = notClean.map((s) => ({
    text: `${isPeriodSlot(s) ? `${s.period} run` : "Earlier run"}: ${(STATUS_CHIP[s.status] || [s.status])[0]}${slotText(s, null, now) ? ` - ${slotText(s, null, now)}` : ""}`,
    failures: (localRunOf(s, log) && localRunOf(s, log).failures) || (s.result && Array.isArray(s.result.failures) ? s.result.failures : [])
  }));

  // a missed slot that ran (and did not end clean) is no slot that never ran (1.13)
  const neverRan = slot.status === "missed" && !ranInWindow(slot);
  const notRun = neverRan || (slot.status === "pending" && Date.parse(slot.window_start_at || "") <= now);
  let events = [];
  if (notRun || slot.status === "failed" || slot.status === "missed") {
    events = windowEvents(slot, log).map((e) => `${eventTime(e, now)}: ${e.text}`);
    if (events.length === 0 && neverRan) events = [`This browser noted nothing during ${slotWindow(slot)}: Chrome was closed, or its scheduler was not checking this account then.`];
  }
  const empty = facts.length + failures.length + warnings.length + earlierRuns.length + events.length === 0;
  return empty ? null : { facts, failures, failuresMore, fromLog, warnings, earlier: earlierRuns, events };
}

/**
 * Today's slots as one row per type, in run order: the type's latest slot, and the earlier
 * periods of a repeating schedule (09:00, 10:00, ...) folded into `earlier`.
 * @param {object[]} slots
 * @returns {{ slot: object, earlier: object[] }[]}
 */
export function todayRows(slots) {
  const byType = new Map();
  const start = (s) => Date.parse(s.window_start_at || "") || 0;
  for (const slot of slots || []) {
    const list = byType.get(slot.doc_type) || [];
    list.push(slot);
    byType.set(slot.doc_type, list);
  }
  const rank = (type) => (SCHEDULE_TYPES.includes(type) ? SCHEDULE_TYPES.indexOf(type) : SCHEDULE_TYPES.length);
  return [...byType.entries()]
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([, list]) => {
      const sorted = list.slice().sort((a, b) => start(a) - start(b) || a.id - b.id);
      return { slot: sorted[sorted.length - 1], earlier: sorted.slice(0, -1) };
    });
}

/** "Earlier today: 2 of 3 runs done, 5 saved" for the folded periods of a repeating schedule. */
export function earlierText(earlier) {
  if (!earlier || earlier.length === 0) return "";
  const done = earlier.filter((s) => s.status === "done").length;
  const saved = earlier.reduce((n, s) => n + ((s.result && Number(s.result.saved)) || 0), 0);
  return `Earlier today: ${done} of ${earlier.length} run${earlier.length === 1 ? "" : "s"} done${saved ? `, ${saved} saved` : ""}`;
}

/**
 * One line saying what a slot did or waits for. `schedule` (optional) is the slot's schedule: a
 * finished period of a repeating schedule then names the next run.
 * The pending and missed lines state only what the slot record says: why a slot has not run
 * (no IREPS login, a busy DocLink, an error) is in the status line, from this DocLink's scheduler.
 */
export function slotText(slot, schedule = null, now = Date.now()) {
  const window = slotWindow(slot);
  const reason = slot.code ? describeError(slot.code).title : "";
  switch (slot.status) {
    case "done": {
      const nextRun = istTime(slot.window_end_at);
      // a repeating schedule's runs start up to and including window_end (09:00-18:00 hourly: the last at 18:00)
      const more = isPeriodSlot(slot) && schedule && schedule.enabled !== false && nextRun <= schedule.window_end ? `next run ${nextRun}` : "";
      return [`Done by ${who(slot.done_by)} at ${istTime(slot.ended_at)}`, resultText(slot.result), more].filter(Boolean).join(" · ");
    }
    case "in_progress":
      return `Running - ${who(slot.holder)}`;
    case "pending":
      return Date.parse(slot.window_start_at || "") > now ? `Scheduled ${window}` : `Due ${window}, not run yet`;
    case "partial":
    case "failed":
      return [reason, resultText(slot.result), slot.next_try_at ? `next try ${istTime(slot.next_try_at)}` : ""].filter(Boolean).join(" · ");
    case "failed_final":
      return reason || "Failed";
    case "missed":
      // a slot that ran but did not end clean before its window closed says so, with what it did (1.13)
      if (ranInWindow(slot)) return [`Ran, but not finished during ${window}${reason ? ` (last: ${reason})` : ""}`, resultText(slot.result)].filter(Boolean).join(" · ");
      return `Not run during ${window}${reason ? ` (last: ${reason})` : ""}`;
    default:
      return "";
  }
}

/** What this DocLink is waiting for, in one sentence. */
function waitingText(waitingFor) {
  switch (waitingFor) {
    case "ireps":
      return "A download is due: log in to IREPS in this browser and DocLink runs it.";
    case "busy":
      return "A download is due: it starts when your current DocLink run ends.";
    case "backend":
      return "The Recon Engine's schedules could not be reached; DocLink tries again later.";
    default:
      return "";
  }
}

/** The scheduler's last failure ("" when its last check went through), so a failing run is never hidden. */
export function lastErrorText(lastError) {
  if (!lastError || !lastError.code) return "";
  return `Last check failed: ${describeError(lastError.code).title}${lastError.detail ? ` (${lastError.detail})` : ""}.`;
}

function statusLine(view) {
  const { config, user, account } = view;
  if (!config.enabled) return `Scheduled downloads are off in this DocLink (${config.reason}).`;
  if (!user) return "Sign in to the Recon Engine to take part in scheduled downloads.";
  if (!user.canRun) return "Your Recon Engine role does not include scheduled downloads (doclink.schedule.run).";
  if (!account) return "Open an IREPS page and log in: DocLink then knows which IREPS account's schedules to run.";
  const runs = config.types.map(typeLabel).join(", ");
  const unknown = config.unknown.length ? ` Unknown document type in config: ${config.unknown.join(", ")}.` : "";
  return [`IREPS account ${account}. This DocLink runs: ${runs}.${unknown}`, waitingText(view.waitingFor), lastErrorText(view.lastError)].filter(Boolean).join(" ");
}

const node = (tag, className, text) => Object.assign(document.createElement(tag), { className, ...(text !== undefined ? { textContent: text } : {}) });

/** A list of documents under a row: "doc: reason", the first `max` of them, then how many more (and where they are). */
function docList(items, text, max, more = 0, where = "") {
  const ul = node("ul", "schedule-docs");
  for (const item of items.slice(0, max)) ul.append(node("li", "", text(item)));
  const rest = Math.max(0, items.length - max) + Number(more || 0);
  if (rest > 0) ul.append(node("li", "schedule-docs-more", `... and ${rest} more${where ? ` (${where})` : ""}`));
  return ul;
}

/** Where the documents a list leaves out can be read. */
const SAVE_LOG_HAS_ALL = "Save log lists them all";
const OTHER_LOG_HAS_ALL = "the run log of the browser that ran it lists them all";

/** One failed document as the panel shows it: its name, then why. */
function failureLine(f) {
  return `${f.doc}: ${describeError(f.code).title}${f.detail ? ` (${f.detail})` : ""}`;
}

/** The opened part of a Today row (slotDetails). */
function detailsBody(details) {
  const body = node("div", "schedule-run-body");
  if (details.facts.length) {
    const facts = node("ul", "schedule-facts");
    for (const fact of details.facts) facts.append(node("li", "", fact));
    body.append(facts);
  }
  if (details.failures.length) {
    body.append(node("div", "schedule-docs-title schedule-docs-failed", `Not saved (${details.failures.length + details.failuresMore})`));
    body.append(docList(details.failures, failureLine, SHOWN_FAILURES, details.failuresMore, details.fromLog ? SAVE_LOG_HAS_ALL : OTHER_LOG_HAS_ALL));
  }
  if (details.warnings.length) {
    body.append(node("div", "schedule-docs-title", "Warnings"));
    body.append(docList(details.warnings, (w) => w, 10));
  }
  for (const run of details.earlier) {
    body.append(node("div", "schedule-docs-title", run.text));
    if (run.failures.length) body.append(docList(run.failures, failureLine, 10));
  }
  if (details.events.length) {
    body.append(node("div", "schedule-docs-title", "This browser's scheduler during the window"));
    body.append(docList(details.events, (e) => e, 10));
  }
  return body;
}

/** A row that opens: its line is the summary, slotDetails under it. `key` keeps it open across redraws. */
function openableRow(li, key, head, body) {
  const box = node("details", "schedule-run");
  box.open = openRows.has(key);
  box.addEventListener("toggle", () => (box.open ? openRows.add(key) : openRows.delete(key)));
  const summary = document.createElement("summary");
  summary.append(...head);
  box.append(summary, body);
  li.classList.add("schedule-row-open");
  li.append(box);
}

function renderToday(view) {
  el.today.replaceChildren();
  const rows = todayRows(view.slots);
  const scheduleOf = new Map((view.schedules || []).map((s) => [s.doc_type, s]));
  el.todayEmpty.hidden = rows.length > 0 || !view.account;
  for (const { slot, earlier } of rows) {
    const li = document.createElement("li");
    li.className = "schedule-row";
    const name = node("span", "schedule-type", typeLabel(slot.doc_type));
    const [chipText, chipClass] = STATUS_CHIP[slot.status] || [slot.status, ""];
    const chip = node("span", `chip ${chipClass}`, chipText);
    const text = node("span", "schedule-text");
    const notHere = view.config.enabled && !view.config.types.includes(slot.doc_type) && ["pending", "failed", "partial"].includes(slot.status);
    text.textContent = [slotText(slot, scheduleOf.get(slot.doc_type)), notHere ? "Not scheduled in this DocLink" : "", earlierText(earlier)].filter(Boolean).join(" · ");
    const details = slotDetails(slot, { earlier, log: view.log });
    if (details) openableRow(li, `today:${slot.doc_type}`, [name, chip, text], detailsBody(details));
    else li.append(name, chip, text);
    el.today.append(li);
  }
}

const RUN_CHIP = { running: STATUS_CHIP.in_progress, done: STATUS_CHIP.done, partial: STATUS_CHIP.partial, failed: ["Failed", "chip-failed"] };

/** One run of this browser's run log, as a row that opens to its document lists. */
function runRow(run) {
  const li = document.createElement("li");
  li.className = "schedule-row";
  const period = run.period && run.period !== "day" ? ` (${run.period} run)` : "";
  const name = node("span", "schedule-type", `${whenText(run.startedAt)} ${typeLabel(run.docType)}${period}`);
  const [chipText, chipClass] = RUN_CHIP[run.outcome] || [run.outcome, ""];
  const chip = node("span", `chip ${chipClass}`, chipText);
  const why = run.code && run.outcome !== "done" && run.outcome !== "partial" ? describeError(run.code).title : "";
  const text = node("span", "schedule-text", [countsText(run.counts || {}), why, run.range].filter(Boolean).join(" · ") || "No documents");
  const body = node("div", "schedule-run-body");
  const facts = node("ul", "schedule-facts");
  if (run.range) facts.append(node("li", "", `Searched: ${run.range}`));
  facts.append(node("li", "", `Ran ${istDateTime(run.startedAt)}${run.endedAt ? ` to ${istTime(run.endedAt)}` : ""}${run.user ? ` (${run.user})` : ""}, IREPS account ${run.account || "?"}`));
  if (run.code && run.outcome !== "done") facts.append(node("li", "", `Why: ${describeError(run.code).title}${run.detail ? ` (${run.detail})` : ""}`));
  if (run.file) facts.append(node("li", "", `Saved to: ${run.file}`));
  body.append(facts);
  const more = run.more || {};
  const section = (title, items, count, text, className = "") => {
    if (!items || items.length === 0) return;
    body.append(node("div", `schedule-docs-title ${className}`.trim(), `${title} (${items.length + Number(count || 0)})`));
    body.append(docList(items, text, title === "Not saved" ? SHOWN_FAILURES : SHOWN_DOCS, count, SAVE_LOG_HAS_ALL));
  };
  for (const w of run.warnings || []) facts.append(node("li", "", `Warning: ${w}`));
  section("Not saved", run.failures, more.failures, failureLine, "schedule-docs-failed");
  section("Already saved, skipped", run.skipped, more.skipped, (d) => `${d.doc}${d.note ? `: ${d.note}` : ""}`);
  section("Saved", run.saved, more.saved, (d) => `${d.doc}${d.note ? `: ${d.note}` : ""}`);
  openableRow(li, `run:${run.id}`, [name, chip, text], body);
  return li;
}

/** "Run log of this browser": its runs and the scheduler's events, newest first. */
function renderLog(view) {
  if (!el.logRuns) return;
  const log = view.log && typeof view.log === "object" ? view.log : { runs: [], events: [] };
  const runs = Array.isArray(log.runs) ? log.runs : [];
  const events = Array.isArray(log.events) ? log.events : [];
  el.logSummary.textContent = `${runs.length} run${runs.length === 1 ? "" : "s"} · ${events.length} event${events.length === 1 ? "" : "s"}`;
  el.logRuns.replaceChildren(...runs.slice(0, SHOWN_RUNS).map(runRow));
  el.logRunsEmpty.hidden = runs.length > 0;
  el.logEvents.replaceChildren(...events.slice(0, SHOWN_EVENTS).map((e) => node("li", `schedule-event schedule-event-${e.kind}`, `${eventTime(e)}: ${e.text}`)));
  el.logEventsEmpty.hidden = events.length > 0;
}

/** The run log as a text file's content (Copy / Save). */
function logText() {
  const view = lastView || {};
  return runLogText(view.log, { account: view.account, version: view.version, savedAt: new Date().toISOString() });
}

/** Copy the run log; the button says whether it worked. */
async function copyLog() {
  const label = el.btnLogCopy.textContent;
  try {
    await navigator.clipboard.writeText(logText());
    el.btnLogCopy.textContent = "Copied";
  } catch (error) {
    logger.warn("Scheduler run log not copied", error);
    el.btnLogCopy.textContent = "Not copied: use Save log";
  }
  setTimeout(() => (el.btnLogCopy.textContent = label), 2500);
}

/** Save the run log as a .txt file in Downloads. */
function saveLog() {
  const url = URL.createObjectURL(new Blob([logText()], { type: "text/plain" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: `DocLink_scheduler_log_${new Date().toISOString().replace(/[:.]/g, "-")}.txt` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function field(labelText, input) {
  const label = document.createElement("label");
  label.className = "field";
  const span = document.createElement("span");
  span.className = "field-label";
  span.textContent = labelText;
  label.append(span, input);
  return label;
}

/** A labelled group of several controls (one label element cannot hold them). */
function group(labelText, content) {
  const box = document.createElement("div");
  box.className = "field";
  const span = document.createElement("span");
  span.className = "field-label";
  span.textContent = labelText;
  box.append(span, content);
  return box;
}

/** DocLink's toggle buttons (.segmented, as Save to: Local | ECM / S3) over radio or checkbox inputs. */
function toggles(label, items, className = "") {
  const box = document.createElement("div");
  box.className = `segmented ${className}`.trim();
  box.setAttribute("role", "group");
  box.setAttribute("aria-label", label);
  for (const { text, input } of items) {
    const option = document.createElement("label");
    option.append(input, document.createTextNode(text));
    box.append(option);
  }
  return box;
}

/**
 * A time of day (IST "HH:MM") as two DocLink dropdowns, hour and minute: the browser's own time picker
 * cannot take DocLink's style. A stored time off the 5-minute steps keeps its minute (it is added to the list).
 * @returns {{ element: HTMLElement, value: () => string }}
 */
function timeInput(label, value) {
  const [h = "00", m = "00"] = String(value || "").split(":");
  const box = document.createElement("div");
  box.className = "schedule-time";
  const dropdown = (values, current, part) => {
    const select = document.createElement("select");
    select.setAttribute("aria-label", `${label} ${part}`);
    const list = values.includes(current) ? values : [...values, current].sort();
    for (const v of list) select.append(new Option(v, v, v === current, v === current));
    return select;
  };
  const hour = dropdown(HOURS, h.padStart(2, "0"), "hour");
  const minute = dropdown(MINUTES, m.padStart(2, "0"), "minute");
  const colon = Object.assign(document.createElement("span"), { className: "schedule-time-sep", textContent: ":" });
  colon.setAttribute("aria-hidden", "true");
  box.append(hour, colon, minute);
  return { element: box, value: () => `${hour.value}:${minute.value}` };
}

/** A DocLink button (.btn) with the spinner its busy state shows. */
function button(text, variant) {
  const b = Object.assign(document.createElement("button"), { type: "button", className: `btn ${variant}` });
  const spinner = Object.assign(document.createElement("span"), { className: "btn-spinner" });
  spinner.setAttribute("aria-hidden", "true");
  b.append(spinner, Object.assign(document.createElement("span"), { className: "btn-label", textContent: text }));
  return b;
}

/** Run a box's request with its button busy and every button of the box off, so it is sent once. */
async function whileBusy(busyButton, buttons, request) {
  for (const b of buttons) b.disabled = true;
  busyButton.classList.add("is-busy");
  try {
    await request();
  } catch (error) {
    logger.warn("Schedule change not sent", error);
    showError(describeError("UNKNOWN", { detail: String((error && error.message) || error) }));
  } finally {
    busyButton.classList.remove("is-busy");
    for (const b of buttons) b.disabled = false;
  }
}

/** A saved schedule's timing for its box's summary line: ["09:00-10:00", "once a day"]. */
function timingParts(s) {
  const repeat = REPEATS.find(([m]) => m === (s.repeat_every_minutes ?? null));
  return [`${s.window_start}-${s.window_end}`, repeat ? repeat[1] : `every ${s.repeat_every_minutes} min`];
}

/**
 * The right side of a box's summary: the timing, marked "Off" / "Not scheduled" when it does not run.
 * Each part is its own piece, so a narrow panel wraps between them, never inside one.
 */
function editorSummary(schedule) {
  const summary = document.createElement("span");
  summary.className = "options-summary";
  const state = !schedule ? "Not scheduled" : schedule.enabled === false ? "Off" : "";
  if (state) summary.append(Object.assign(document.createElement("span"), { className: "chip", textContent: state }));
  if (schedule) {
    const [window, runs] = timingParts(schedule);
    summary.append(Object.assign(document.createElement("span"), { textContent: window }), Object.assign(document.createElement("span"), { textContent: ` · ${runs}` }));
  }
  return summary;
}

/**
 * One box per document type, like DocLink's other option boxes ("More filters"): the account's
 * schedule, or the defaults for a new one. The summary line shows the timing without opening it.
 */
function editor(type, schedule) {
  const s = schedule || { doc_type: type, ...SCHEDULE_DEFAULT_TIMING[type], days: [0, 1, 2, 3, 4, 5, 6], lookback_days: DEFAULT_LOOKBACK[type], enabled: true };
  const box = document.createElement("details");
  box.className = "options schedule-editor";
  box.open = openEditors.has(type);
  box.addEventListener("toggle", () => (box.open ? openEditors.add(type) : openEditors.delete(type)));
  // a change not saved yet: the box is kept as it is when the view is drawn again (renderManage)
  const touched = () => dirtyEditors.add(type);
  box.addEventListener("input", touched);
  box.addEventListener("change", touched);
  const summary = document.createElement("summary");
  summary.append(Object.assign(document.createElement("span"), { className: "schedule-editor-name", textContent: typeLabel(type) }), editorSummary(schedule));
  const body = document.createElement("div");
  body.className = "options-body";

  // a saved schedule can be switched off; a new one is added switched on
  const on = Object.assign(document.createElement("input"), { type: "radio", name: `schedule-${type}-on`, checked: !schedule || schedule.enabled !== false });
  const off = Object.assign(document.createElement("input"), { type: "radio", name: `schedule-${type}-on`, checked: Boolean(schedule) && schedule.enabled === false });
  if (schedule) body.append(group("Schedule", toggles("Schedule", [{ text: "On", input: on }, { text: "Off", input: off }])));

  const from = timeInput("From", s.window_start);
  const to = timeInput("To", s.window_end);
  const runs = document.createElement("select");
  const repeat = s.repeat_every_minutes ?? null;
  for (const [m, text] of REPEATS) runs.append(Object.assign(document.createElement("option"), { value: m === null ? "" : String(m), textContent: text, selected: m === repeat }));
  const every = document.createElement("select");
  for (const m of INTERVALS) every.append(Object.assign(document.createElement("option"), { value: String(m), textContent: `every ${m} min`, selected: m === s.check_every_minutes }));
  // Tabulations: 5 days at most, so a longer stored look-back shows what a run really searches
  const cap = MAX_LOOKBACK[type];
  const lookback = Object.assign(document.createElement("input"), { type: "number", min: "1", max: String(cap || 180), value: String(cap ? Math.min(Number(s.lookback_days) || cap, cap) : s.lookback_days) });
  const fields = document.createElement("div");
  fields.className = "schedule-fields";
  fields.append(group("From", from.element), group("To", to.element), field("Runs", runs), field("Retry", every));
  if (FIXED_LOOKBACK[type]) {
    // Bill Status, CRN and R-NOTE always search the last 90 days: shown, not editable
    const range = type === "billStatus" ? 'Last 90 days (IREPS "Last 90 Days")' : "Last 90 days, up to today";
    fields.append(group("Date range", node("span", "schedule-fixed", range)));
  } else if (!NO_LOOKBACK.has(type)) {
    fields.append(field("Look back (days)", lookback));
  }

  const dayBoxes = DAYS.map((d, i) => Object.assign(document.createElement("input"), { type: "checkbox", checked: s.days.includes(i) }));
  const days = group("Days", toggles("Days", DAYS.map((d, i) => ({ text: d, input: dayBoxes[i] })), "schedule-days"));

  const actions = document.createElement("div");
  actions.className = "schedule-actions";
  const save = button(schedule ? "Save" : "Add schedule", "btn-primary");
  const remove = schedule ? button("Delete", "btn-danger") : null;
  const buttons = [save, remove].filter(Boolean);
  save.addEventListener("click", () =>
    whileBusy(save, buttons, () =>
      saveSchedule({
        id: schedule ? schedule.id : undefined,
        doc_type: type,
        enabled: !schedule || on.checked,
        window_start: from.value(),
        window_end: to.value(),
        check_every_minutes: Number(every.value),
        repeat_every_minutes: runs.value === "" ? null : Number(runs.value),
        days: dayBoxes.map((b, i) => (b.checked ? i : -1)).filter((i) => i >= 0),
        lookback_days: FIXED_LOOKBACK[type] || Math.min(Number(lookback.value) || DEFAULT_LOOKBACK[type], cap || Infinity)
      })
    )
  );
  actions.append(save);
  if (remove) {
    remove.addEventListener("click", () => whileBusy(remove, buttons, () => deleteSchedule(schedule.id, type)));
    actions.append(remove);
  }
  body.append(fields, days, actions);
  box.append(summary, body);
  return box;
}

/**
 * The types the admin list shows, in run order: those this DocLink runs (tender types only with
 * schedular_phase2 on, so a type the Recon Engine may not know yet is never offered), and every
 * type that already has a schedule, so it can still be edited or deleted.
 * @param {{ types: string[] }} config   parseSchedulerConfig() result
 * @param {{ doc_type: string }[]} [schedules]
 * @returns {string[]}
 */
export function editorTypes(config, schedules) {
  const scheduled = new Set((schedules || []).map((s) => s.doc_type));
  return SCHEDULE_TYPES.filter((type) => config.types.includes(type) || scheduled.has(type));
}

function renderManage(view) {
  const canManage = Boolean(view.user && view.user.canManage && view.account && view.config.enabled);
  el.manage.hidden = !canManage;
  if (!canManage) {
    el.editors.replaceChildren();
    editorBoxes.clear();
    return;
  }
  const byType = new Map((view.schedules || []).map((s) => [s.doc_type, s]));
  const boxes = editorTypes(view.config, view.schedules).map((type) => {
    // a box with unsaved changes, or one being used (an open dropdown), stays as it is
    const current = editorBoxes.get(type);
    const keep = current && (dirtyEditors.has(type) || current.contains(document.activeElement));
    const box = keep ? current : editor(type, byType.get(type));
    editorBoxes.set(type, box);
    return box;
  });
  el.editors.replaceChildren(...boxes);
}

function showError(described) {
  el.error.hidden = !described;
  if (!described) return;
  el.errorTitle.textContent = described.title;
  el.errorMessage.textContent = described.message;
}

/** A line under the status after a save ("" hides it). */
function showNotice(text) {
  if (!el.notice) return;
  el.notice.hidden = !text;
  el.notice.textContent = text || "";
}

/**
 * After a once-a-day schedule is saved: when today's slot did not take the new time (it already ran,
 * runs now, or stayed missed: a Recon Engine that does not reopen a missed slot), say when the new time
 * applies, so the change never looks lost. "" when today's slot has the new time, or there is none.
 * @param {{ doc_type: string, window_start: string, window_end: string, repeat_every_minutes: number|null, enabled?: boolean }} schedule
 * @param {{ slots?: object[] }} view   the view loaded after the save
 */
export function savedNotice(schedule, view) {
  if (!schedule || schedule.repeat_every_minutes != null || schedule.enabled === false) return "";
  const slots = (view && view.slots ? view.slots : []).filter((s) => s.doc_type === schedule.doc_type && !isPeriodSlot(s));
  const slot = slots[slots.length - 1];
  if (!slot) return "";
  const window = slotWindow(slot);
  const wanted = `${schedule.window_start}-${schedule.window_end}`;
  if (window === wanted) return "";
  const label = typeLabel(schedule.doc_type);
  if (slot.status === "done") return `Saved. ${label} already ran today (${window}): the new time ${wanted} applies from tomorrow.`;
  if (slot.status === "in_progress") return `Saved. ${label} is running now (${window}): the new time ${wanted} applies from tomorrow.`;
  if (slot.status === "missed" || slot.status === "failed_final") return `Saved. Today's ${label} slot (${window}) has ended and was not reopened by the Recon Engine: the new time ${wanted} applies from tomorrow.`;
  return `Saved. Today's ${label} slot still shows ${window}: refresh in a minute; if it does not change, the new time applies from tomorrow.`;
}

function render(view) {
  lastView = view;
  el.status.textContent = statusLine(view);
  showError(view.error || null);
  renderToday(view);
  renderLog(view);
  renderManage(view);
}

/** Load and draw the view; resolves with the view drawn (null when none came). */
async function load() {
  if (loading) return loading;
  el.btnRefresh.disabled = true;
  loading = (async () => {
    try {
      const view = await ctx.send(MESSAGE_TYPES.SCHEDULE_GET_STATE);
      if (view && view.config) {
        render(view);
        return view;
      }
      showError(describeError("UNKNOWN", { detail: "no answer from DocLink's background worker" }));
    } catch (error) {
      logger.warn("Schedule view could not be loaded", error);
      showError(describeError("UNKNOWN", { detail: String((error && error.message) || error) }));
    }
    return null;
  })();
  try {
    return await loading;
  } finally {
    loading = false;
    el.btnRefresh.disabled = false;
  }
}

/** Load once more after a load that was already running ends: a save must be drawn from a load made after it. */
async function reload() {
  if (loading) await loading;
  return load();
}

async function saveSchedule(schedule) {
  showNotice("");
  const answer = await ctx.send(MESSAGE_TYPES.SCHEDULE_SAVE, { schedule });
  if (answer && answer.ok === false) return showError(answer.error);
  dirtyEditors.delete(schedule.doc_type);
  const view = await reload();
  showNotice(view ? savedNotice(schedule, view) : "");
}

async function deleteSchedule(id, docType) {
  showNotice("");
  const answer = await ctx.send(MESSAGE_TYPES.SCHEDULE_DELETE, { id, docType });
  if (answer && answer.ok === false) return showError(answer.error);
  dirtyEditors.delete(docType);
  await reload();
}

function open() {
  ctx.showView("schedule");
  load();
}

/** The worker's SCHEDULE_STATE broadcast: refresh an open view. Returns whether it was handled. */
export function handleScheduleMessage(message) {
  if (!message || message.type !== MESSAGE_TYPES.SCHEDULE_STATE) return false;
  if (el && !el.view.hidden) load();
  return true;
}

/**
 * @param {{ send: (type: string, payload?: object) => Promise<any>, showView: (name: string) => void }} context
 */
export async function initSchedule(context) {
  ctx = context;
  el = {
    view: $("view-schedule"),
    btnOpen: $("btn-schedule-open"),
    btnBack: $("btn-schedule-back"),
    btnRefresh: $("btn-schedule-refresh"),
    status: $("schedule-status"),
    error: $("schedule-error"),
    errorTitle: $("schedule-error-title"),
    errorMessage: $("schedule-error-message"),
    today: $("schedule-today"),
    todayEmpty: $("schedule-today-empty"),
    notice: $("schedule-notice"),
    logSummary: $("schedule-log-summary"),
    logRuns: $("schedule-log-runs"),
    logRunsEmpty: $("schedule-log-runs-empty"),
    logEvents: $("schedule-log-events"),
    logEventsEmpty: $("schedule-log-events-empty"),
    btnLogCopy: $("btn-schedule-log-copy"),
    btnLogSave: $("btn-schedule-log-save"),
    manage: $("schedule-manage"),
    editors: $("schedule-editors")
  };
  el.btnOpen.addEventListener("click", () => (el.view.hidden ? open() : ctx.showView("main")));
  el.btnBack.addEventListener("click", () => ctx.showView("main"));
  el.btnRefresh.addEventListener("click", () => load());
  if (el.btnLogCopy) el.btnLogCopy.addEventListener("click", () => copyLog());
  if (el.btnLogSave) el.btnLogSave.addEventListener("click", () => saveLog());
  const files = await readConfigFiles();
  el.btnOpen.hidden = !parseSchedulerConfig(files && files.config).enabled;
}

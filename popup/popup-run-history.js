/**
 * My Downloads > Scheduled runs: what this browser's scheduled downloads did on the last 3 days with runs (the run
 * log, services/scheduler/run-log.js, read from the worker with SCHEDULE_GET_STATE). A Day dropdown, newest first;
 * for the day picked (the newest until the user picks another):
 *   - Downloaded: each document saved, with the time of its run, its type and where it was saved;
 *   - Not saved: each document a run could not save, once, with why, how often, and "saved later" when a later run
 *     saved it (or found it already saved), else "not saved since": those are the ones to download by hand;
 *   - Runs: each opens to its range, its lists and why it ended as it did;
 *   - Scheduler events: why a due download did not run here.
 * Download Excel gives all the days as a workbook (documents, runs, scheduler events) to match by hand; My Downloads
 * offers no text copy of the log (the user's choice, 27 Nov 2026). The tab shows only when scheduling is on (config.json
 * schedular_phase1 / schedular_phase2); Saved files (popup-downloads.js) keeps every download, manual or scheduled, and
 * Missed documents (popup-missed.js) what IREPS listed to the scheduled runs. This module switches the three tabs.
 */

import { MESSAGE_TYPES, describeError } from "../utils/messages.js";
import { readConfigFiles } from "../utils/config.js";
import { parseSchedulerConfig } from "../services/scheduler/schedule-types.js";
import { runLogSheets, notSavedList, downloadedOn, logDays, dayLabel, istDateTime } from "../services/scheduler/run-log.js";
import { buildWorkbook, XLSX_MIME_TYPE } from "../utils/xlsx-writer.js";
import { saveFile, fillDaySelect } from "./popup-common.js";
import { node, failureLine, runRow, typeLabel, istTime } from "./popup-schedule.js";
import { loadMissed } from "./popup-missed.js";
import { logger } from "../utils/logger.js";

const $ = (id) => document.getElementById(id);
/** Rows shown per list of the day picked (Download Excel gives all of them). */
const SHOWN = 100;

let el = null;
let ctx = null;
/** The last state drawn: what Download Excel writes. */
let lastView = null;
/** The day the user picked ("2026-11-30"); null: the newest day, whichever that is at each drawing. */
let picked = null;
let loading = null;

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "16:30" today (IST), else "Fri 27/11 16:30". */
function dayTime(iso, now = Date.now()) {
  const day = istDateTime(iso).slice(0, 10);
  if (!day) return "";
  return day === istDateTime(new Date(now).toISOString()).slice(0, 10) ? istTime(iso) : `${dayLabel(day).slice(0, 9)} ${istTime(iso)}`;
}

/** "08:52" or "08:52-08:58 (3 checks)" for an event of the day shown. */
function eventTime(event) {
  const first = event.first || event.at;
  const span = first && first !== event.at ? `${istTime(first)}-${istTime(event.at)}` : istTime(event.at);
  return `${span}${Number(event.count) > 1 ? ` (${event.count} checks)` : ""}`;
}

/** A document downloaded: "11:30 · Tender NIT documents: Tender 78266659 tender PDF · 78266659.pdf in ECM /ECM/Hosur/Tenders". */
const downloadedLine = (d) => `${istTime(d.at)} · ${typeLabel(d.docType)}: ${d.doc}${d.note ? ` · ${d.note}` : ""}`;

/** A document not saved: when, the type, the document and why, how often that day, and whether a later run saved it. */
function notSavedLine(entry) {
  const times = entry.times > 1 ? ` (${entry.times} times)` : "";
  return `${istTime(entry.at)} · ${typeLabel(entry.docType)}: ${failureLine(entry)}${times} · ${entry.savedAt ? `saved later, ${dayTime(entry.savedAt)}` : "not saved since"}`;
}

/** A list's first SHOWN rows, then how many more (`total` counts the ones only counted, not listed, too). */
function fill(list, items, line, { total = items.length, className = () => "schedule-event" } = {}) {
  const shown = items.slice(0, SHOWN);
  list.replaceChildren(...shown.map((item) => node("li", className(item), line(item))));
  const rest = total - shown.length;
  if (rest > 0) list.append(node("li", "schedule-docs-more", `... and ${rest} more${items.length > shown.length ? " (Download Excel lists them)" : ""}`));
}

/** The day shown: the one picked while the log still has it, else the newest. */
const shownDay = (days) => (days.some((d) => d.day === picked) ? picked : days.length ? days[0].day : null);

/** The Day dropdown: the days kept, newest first ("Mon 30/11/2026 · 18 downloaded", "Sat 28/11/2026 · no runs"). */
function renderDays(days, day, log) {
  const choices = days.map((d) => ({ value: d.day, text: `${dayLabel(d.day)} · ${d.runs.length ? `${downloadedOn(log, d.day).total} downloaded` : "no runs"}` }));
  fillDaySelect(el.days, choices, day, "Only the last 3 days with runs are kept.");
  el.dayField.hidden = days.length === 0;
}

function render(view) {
  lastView = view || {};
  const log = lastView.log && typeof lastView.log === "object" ? lastView.log : { runs: [], events: [] };
  const days = logDays(log);
  const runs = days.reduce((n, d) => n + d.runs.length, 0);
  // the days that had runs: "the last 3 days with runs" (a day between them with only the scheduler's notes is not one)
  const runDays = days.filter((d) => d.runs.length > 0).length;
  const downloaded = days.reduce((n, d) => n + downloadedOn(log, d.day).total, 0);
  const open = notSavedList(log).filter((n) => !n.savedAt).length;
  el.summary.textContent = days.length ? [plural(runDays, "day"), plural(runs, "run"), `${downloaded} downloaded`, ...(open ? [`${open} not saved`] : [])].join(" · ") : "";
  const day = shownDay(days);
  renderDays(days, day, log);
  const label = day ? dayLabel(day) : "";
  const shown = days.find((d) => d.day === day) || { runs: [], events: [] };

  const down = day ? downloadedOn(log, day) : { entries: [], total: 0 };
  el.downloadedTitle.textContent = day ? `Downloaded on ${label} (${down.total})` : "Downloaded";
  fill(el.downloaded, down.entries, downloadedLine, { total: down.total });
  el.downloadedEmpty.hidden = down.total > 0;
  el.downloadedEmpty.textContent = day ? `Nothing downloaded on ${label}.` : "Nothing downloaded yet.";

  const notSaved = day ? notSavedList(log, { day }) : [];
  el.notSavedTitle.textContent = `Not saved (${notSaved.length})`;
  fill(el.notSaved, notSaved, notSavedLine, { className: (n) => `schedule-event ${n.savedAt ? "schedule-saved-later" : "schedule-event-error"}` });
  el.notSavedEmpty.hidden = notSaved.length > 0;
  el.notSavedEmpty.textContent = shown.runs.length ? "Nothing: every document of this day was saved." : "Nothing on this day.";

  el.runsTitle.textContent = `Runs (${shown.runs.length})`;
  el.runs.replaceChildren(...shown.runs.slice(0, SHOWN).map(runRow));
  el.runsEmpty.hidden = shown.runs.length > 0;
  el.runsEmpty.textContent = day ? `No scheduled download ran in this browser on ${label}.` : "No scheduled download ran in this browser yet.";

  el.eventsTitle.textContent = `Scheduler events (${shown.events.length})`;
  fill(el.events, shown.events, (e) => `${eventTime(e)}: ${e.text}`, { className: (e) => `schedule-event schedule-event-${e.kind}` });
  el.eventsEmpty.hidden = shown.events.length > 0;
  el.eventsEmpty.textContent = day ? `Nothing noted on ${label}.` : "Nothing noted yet.";
}

function showError(error) {
  el.error.hidden = !error;
  if (!error) return;
  el.errorTitle.textContent = error.title;
  el.errorMessage.textContent = error.message;
}

/** Read the run log from the worker and draw it; one read at a time. */
async function load() {
  if (loading) return loading;
  loading = (async () => {
    try {
      const view = await ctx.send(MESSAGE_TYPES.SCHEDULE_GET_STATE);
      if (view && view.config) {
        showError(null);
        render(view);
        return;
      }
      showError(describeError("UNKNOWN", { detail: "no answer from DocLink's background worker" }));
    } catch (error) {
      logger.warn("Scheduled runs could not be read", error);
      showError(describeError("UNKNOWN", { detail: String((error && error.message) || error) }));
    }
  })();
  try {
    return await loading;
  } finally {
    loading = null;
  }
}

/**
 * Show one tab: "files" (the download log), "runs" (the run log) or "missed" (what IREPS listed to the scheduled runs);
 * the last two are read again each time they are shown.
 */
function selectTab(name) {
  const tabs = [["files", el.tabFiles, el.filesPanel], ["runs", el.tabRuns, el.runsPanel], ["missed", el.tabMissed, el.missedPanel]];
  for (const [id, tab, panel] of tabs) {
    if (tab) tab.setAttribute("aria-selected", String(id === name));
    if (panel) panel.hidden = id !== name;
  }
  if (name === "runs") load();
  if (name === "missed") loadMissed({ check: true });
}

/** The days kept as an Excel workbook in Downloads: DocLink_scheduled_runs_<oldest day>_to_<newest day>.xlsx. */
function saveExcel() {
  const log = (lastView && lastView.log) || { runs: [], events: [] };
  const days = logDays(log).map((d) => d.day);
  const span = days.length ? `${days[days.length - 1]}_to_${days[0]}` : "empty";
  saveFile(buildWorkbook({ sheets: runLogSheets(log) }), `DocLink_scheduled_runs_${span}.xlsx`, XLSX_MIME_TYPE);
}

/**
 * A worker message: the scheduler's state changed, so the tab is read again while it is shown. Never consumes the
 * message (the Schedule view handles it too).
 * @param {object} message
 */
export function handleRunHistoryMessage(message) {
  if (message && message.type === MESSAGE_TYPES.SCHEDULE_STATE && el && !el.view.hidden && !el.runsPanel.hidden) load();
  return false;
}

/**
 * @param {{ send: (type: string, payload?: object) => Promise<any> }} context
 */
export async function initRunHistory(context) {
  ctx = context;
  el = {
    view: $("view-downloads"),
    btnOpen: $("btn-downloads-open"),
    tabs: $("downloads-tabs"),
    tabFiles: $("downloads-tab-files"),
    tabRuns: $("downloads-tab-runs"),
    tabMissed: $("downloads-tab-missed"),
    filesPanel: $("downloads-files"),
    runsPanel: $("downloads-runs"),
    missedPanel: $("downloads-missed"),
    summary: $("history-summary"),
    days: $("history-days"),
    dayField: $("history-day-field"),
    downloadedTitle: $("history-downloaded-title"),
    downloaded: $("history-downloaded"),
    downloadedEmpty: $("history-downloaded-empty"),
    notSavedTitle: $("history-not-saved-title"),
    notSaved: $("history-not-saved"),
    notSavedEmpty: $("history-not-saved-empty"),
    runsTitle: $("history-runs-title"),
    runs: $("history-runs"),
    runsEmpty: $("history-runs-empty"),
    eventsTitle: $("history-events-title"),
    events: $("history-events"),
    eventsEmpty: $("history-events-empty"),
    btnExcel: $("btn-history-excel"),
    btnRefresh: $("btn-history-refresh"),
    error: $("history-error"),
    errorTitle: $("history-error-title"),
    errorMessage: $("history-error-message")
  };
  if (!el.view || !el.tabs || !el.runsPanel) return;
  el.tabFiles.addEventListener("click", () => selectTab("files"));
  el.tabRuns.addEventListener("click", () => selectTab("runs"));
  if (el.tabMissed) el.tabMissed.addEventListener("click", () => selectTab("missed"));
  if (el.btnExcel) el.btnExcel.addEventListener("click", () => saveExcel());
  el.btnRefresh.addEventListener("click", () => load());
  el.days.addEventListener("change", () => {
    picked = el.days.value;
    render(lastView);
  });
  // My Downloads opens on the tab shown last: read it again when that is the runs or the missed documents
  if (el.btnOpen) el.btnOpen.addEventListener("click", () => {
    if (el.view.hidden) return;
    if (!el.runsPanel.hidden) load();
    if (el.missedPanel && !el.missedPanel.hidden) loadMissed({ check: true });
  });
  const files = await readConfigFiles();
  const on = parseSchedulerConfig(files && files.config).enabled;
  el.tabs.hidden = !on;
  if (!on) selectTab("files");
}

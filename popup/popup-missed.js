/**
 * My Downloads > Missed documents: what IREPS listed to this browser's scheduled downloads, by the day DocLink first
 * found each document (services/scheduler/document-ledger.js, read from the worker with SCHEDULE_GET_DOCUMENTS),
 * asked for by the client on 27 Nov 2026. A Day found dropdown, newest first; for the day picked:
 *   - the day in five tiles: In IREPS, Auto (downloaded by this browser's schedule), Manual (saved with DocLink by a
 *     user: before the scheduled run found it, or by you since), Missed, Pending (not saved yet: the next run tries
 *     again); then a row per type with the same split as a bar and in words ("2 auto · 1 missed");
 *   - Missed: each document no run will try again, with what finds it in IREPS (its numbers, its IREPS date, its
 *     railway, where to look) and why it was not saved: download those in IREPS by hand;
 *   - Pending: the ones the next run tries again.
 * When the tab is opened (or Refresh), the documents not saved are checked against the signed-in user's own download
 * log (services/download-log.js checkDownloaded, read-only): one downloaded with DocLink since shows as such.
 * Download Excel gives every day as a workbook (missed, by day, every document) to match by hand. The tab shows only
 * when scheduling is on, next to Saved files and Scheduled runs (popup-run-history.js switches the tabs).
 */

import { MESSAGE_TYPES, describeError } from "../utils/messages.js";
import { checkDownloaded, LOG_DESTINATION } from "../services/download-log.js";
import { documentDays, ledgerSheets, whyNotSaved, dateLabel, istText, inTypeOrder, FIND_IN_IREPS, DOC_STATE } from "../services/scheduler/document-ledger.js";
import { dayLabel } from "../services/scheduler/run-log.js";
import { SCHEDULE_TYPE_LABEL } from "../services/scheduler/schedule-types.js";
import { buildWorkbook, XLSX_MIME_TYPE } from "../utils/xlsx-writer.js";
import { saveFile, fillDaySelect } from "./popup-common.js";
import { node } from "./popup-schedule.js";
import { logger } from "../utils/logger.js";

const $ = (id) => document.getElementById(id);
/** Documents shown per list of the day picked (Download Excel has all of them). */
const SHOWN = 100;
/** Keys asked about per check of the download log (it takes them in chunks itself). */
const CHECK_MAX = 1000;
const EXCEL_LABEL = "Download Excel";

let el = null;
let ctx = null;
/** The last answer drawn: { account, ledger }. */
let lastView = null;
/** The day the user picked; null: the newest day, whichever that is at each drawing. */
let picked = null;
/** key -> the download log's answer for a document not saved that the user downloaded with DocLink since. */
let byHand = {};
/** What the last check of the download log said: null (not made), "ok", or why it could not be made. */
let checked = null;
let loading = null;
let excelTimer = null;

const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const typeName = (type) => SCHEDULE_TYPE_LABEL[type] || type;

/** How a list ended, in the order the tiles, bars and lines show it: Auto, Manual, Missed, Pending. */
const SPLIT = [
  ["auto", "Auto", (c) => c.scheduled],
  ["manual", "Manual", (c) => c.already + c.byHand],
  ["missed", "Missed", (c) => c.missed],
  ["pending", "Pending", (c) => c.pending]
];

/** "Mon 30/11/2026 · 2 missed", "· 1 pending", "· all saved". */
function dayText(d) {
  const label = dayLabel(d.day);
  if (d.totals.missed) return `${label} · ${d.totals.missed} missed`;
  if (d.totals.pending) return `${label} · ${d.totals.pending} pending`;
  return `${label} · all saved`;
}

/** The day shown: the one picked while the ledger still has it, else the newest. */
const shownDay = (days) => (days.some((d) => d.day === picked) ? picked : days.length ? days[0].day : null);

/** The Day found dropdown: the days kept, newest first, each with what is missed or not saved yet. */
function renderDays(days, day) {
  fillDaySelect(el.days, days.map((d) => ({ value: d.day, text: dayText(d) })), day, "Only the last 3 days with documents are kept.");
  el.dayField.hidden = days.length === 0;
}

/** The day in five tiles: In IREPS, then how its documents ended (a zero is muted). */
function tiles(c) {
  const tile = (kind, label, value) => {
    const div = node("div", `missed-tile missed-tile-${kind}${value ? "" : " missed-tile-zero"}`, "");
    div.append(node("div", "missed-tile-value", String(value)), node("div", "missed-tile-label", label));
    return div;
  };
  return [tile("listed", "In IREPS", c.listed), ...SPLIT.map(([kind, label, n]) => tile(kind, label, n(c)))];
}

/**
 * A type of the day: its name and how many documents IREPS listed, a bar of how they ended (decoration: the line
 * under it says the same in words, "2 auto · 1 missed"), and a note when no run read its lists to their end.
 */
function typeItem(t) {
  const li = node("li", "missed-type-row", "");
  const head = node("div", "missed-type-head", "");
  head.append(node("span", "missed-type-name", typeName(t.type)), node("span", "missed-type-count", `${t.listed} in IREPS`));
  const bar = node("div", "missed-bar", "");
  bar.setAttribute("aria-hidden", "true");
  const line = node("div", "missed-type-line", "");
  for (const [kind, , n] of SPLIT) {
    const count = n(t);
    if (!count) continue;
    const segment = node("span", `missed-bar-${kind}`, "");
    segment.style.width = `${(100 * count) / t.listed}%`;
    bar.append(segment);
    if (line.childNodes.length) line.append(" · ");
    line.append(node("span", `missed-part-${kind}`, `${count} ${kind}`));
  }
  li.append(head, bar, line);
  if (t.read === "part") li.append(node("div", "downloads-muted", "List not read in full on this day: the count may be short."));
  return li;
}

/** What finds a document in IREPS, under its name: its IREPS date, railway, IC number. */
function infoLine(d) {
  const i = d.info || {};
  return [i.date ? `${dateLabel(d.type)} ${i.date}` : "", i.unit ? `Railway ${i.unit}` : "", i.ic ? `IC no. ${i.ic}` : ""].filter(Boolean).join(" · ");
}

/** One document not saved: its type and name, what finds it in IREPS, why it was not saved, and where to look. */
function docItem(d) {
  const li = node("li", `missed-doc missed-doc-${d.state}`, "");
  li.append(node("div", "missed-doc-name", `${typeName(d.type)} · ${d.doc}`));
  const info = infoLine(d);
  if (info) li.append(node("div", "missed-doc-info", info));
  const why = whyNotSaved(d);
  const tries = Number(d.tries) > 1 ? ` · ${d.tries} runs could not save it` : "";
  li.append(node("div", "missed-doc-why", `${why ? `Not saved: ${why}` : "Not reached by a run"}${tries} · last listed ${istText(d.last)}`));
  const where = FIND_IN_IREPS[d.type];
  const lead = d.state === DOC_STATE.MISSED ? "Missed: download it in IREPS" : "Pending: the next run tries again";
  li.append(node("div", "missed-doc-where", `${lead}${where ? ` (${d.state === DOC_STATE.MISSED ? "" : "in IREPS: "}${where})` : ""}.`));
  return li;
}

/** A list's first SHOWN documents, then how many more. */
function fill(list, docs) {
  list.replaceChildren(...docs.slice(0, SHOWN).map(docItem));
  if (docs.length > SHOWN) list.append(node("li", "schedule-docs-more", `... and ${docs.length - SHOWN} more (Download Excel lists them)`));
}

function render() {
  const view = lastView || {};
  const ledger = view.ledger || { docs: [], runs: [] };
  const days = documentDays(ledger, { byHand });
  const total = days.reduce((t, d) => ({ listed: t.listed + d.totals.listed, downloaded: t.downloaded + d.totals.downloaded, missed: t.missed + d.totals.missed, pending: t.pending + d.totals.pending }), { listed: 0, downloaded: 0, missed: 0, pending: 0 });
  el.summary.textContent = days.length
    ? [plural(days.length, "day"), `${total.listed} in IREPS`, `${total.downloaded} downloaded`, `${total.missed} missed`, ...(total.pending ? [`${total.pending} pending`] : [])].join(" · ")
    : view.account
      ? "No scheduled download has listed a document in this browser yet."
      : "Open IREPS and log in: the documents are kept per IREPS account.";
  el.btnExcel.disabled = days.length === 0;
  const day = shownDay(days);
  renderDays(days, day);
  const shown = days.find((d) => d.day === day);
  el.dayBox.hidden = !shown;
  if (!shown) return;
  const label = dayLabel(day);
  el.typesTitle.textContent = `Found in IREPS on ${label}`;
  el.tiles.replaceChildren(...tiles(shown.totals));
  el.types.replaceChildren(...shown.types.map(typeItem));

  const missed = inTypeOrder(shown.docs.filter((d) => d.state === DOC_STATE.MISSED));
  el.missedTitle.textContent = `Missed (${missed.length}): download these in IREPS`;
  fill(el.missed, missed);
  el.missedEmpty.hidden = missed.length > 0;
  el.missedEmpty.textContent = shown.totals.pending ? "None yet." : "None: every document IREPS listed was downloaded.";

  const pending = inTypeOrder(shown.docs.filter((d) => d.state === DOC_STATE.PENDING));
  el.pendingTitle.textContent = `Pending (${pending.length}): the next run tries again`;
  fill(el.pending, pending);
  el.pendingBox.hidden = pending.length === 0;

  el.checkNote.hidden = !checked || checked === "ok";
  el.checkNote.textContent = checked && checked !== "ok" ? `Not checked against your own downloads with DocLink: ${checked}.` : "";
}

function showError(error) {
  el.error.hidden = !error;
  if (!error) return;
  el.errorTitle.textContent = error.title;
  el.errorMessage.textContent = error.message;
}

/** The keys of the documents not saved (the ones a check of the download log can change). */
function keysNotSaved(ledger) {
  return [...new Set((ledger.docs || []).filter((d) => d.key && (d.status === "failed" || d.status === "unread")).map((d) => d.key))].slice(0, CHECK_MAX);
}

/**
 * Ask the signed-in user's download log whether they downloaded any document not saved with DocLink since (to the
 * ECM or locally). Never throws: a log that cannot answer is said under the lists.
 */
async function checkByHand(ledger) {
  const keys = keysNotSaved(ledger);
  if (keys.length === 0) {
    checked = "ok";
    return;
  }
  const found = {};
  const problems = [];
  for (const destination of [LOG_DESTINATION.ECM, LOG_DESTINATION.LOCAL]) {
    const answer = await ctx.check({ destination, keys });
    if (!answer || !answer.ok) {
      problems.push(describeError((answer && answer.code) || "DOWNLOAD_LOG_LIST_UNAVAILABLE").title);
      continue;
    }
    for (const [key, value] of Object.entries(answer.downloaded || {})) if (!found[key]) found[key] = { ...value, destination };
  }
  byHand = found;
  checked = problems.length ? [...new Set(problems)].join("; ") : "ok";
}

/**
 * Read the documents from the worker and draw them; one read at a time. `check`: ask the download log again for the
 * documents not saved (when the tab is opened or refreshed, not at every change of the scheduler's state).
 * @param {{ check?: boolean }} [options]
 */
export async function loadMissed({ check = false } = {}) {
  if (!el) return null;
  if (loading) return loading;
  loading = (async () => {
    try {
      const view = await ctx.send(MESSAGE_TYPES.SCHEDULE_GET_DOCUMENTS);
      if (!view || !view.ok) {
        showError(describeError("UNKNOWN", { detail: "no answer from DocLink's background worker" }));
        return;
      }
      showError(null);
      lastView = { account: view.account || null, ledger: view.ledger || { docs: [], runs: [] } };
      render();
      if (check) {
        await checkByHand(lastView.ledger);
        render();
      }
    } catch (error) {
      logger.warn("Missed documents could not be read", error);
      showError(describeError("UNKNOWN", { detail: String((error && error.message) || error) }));
    }
  })();
  try {
    return await loading;
  } finally {
    loading = null;
  }
}

/** Download Excel: every day kept as DocLink_missed_documents_<first day>_to_<last day>.xlsx in Downloads. */
function saveExcel() {
  clearTimeout(excelTimer);
  const ledger = (lastView && lastView.ledger) || { docs: [], runs: [] };
  const days = documentDays(ledger, { byHand }).map((d) => d.day);
  const span = days.length ? `${days[days.length - 1]}_to_${days[0]}` : "empty";
  saveFile(buildWorkbook({ sheets: ledgerSheets(ledger, { byHand }) }), `DocLink_missed_documents_${span}.xlsx`, XLSX_MIME_TYPE);
  el.btnExcel.textContent = "Saved";
  excelTimer = setTimeout(() => (el.btnExcel.textContent = EXCEL_LABEL), 3000);
}

/**
 * A worker message: the scheduler's state changed (a run ended), so the tab is read again while it is shown, without
 * asking the download log again. Never consumes the message.
 * @param {object} message
 */
export function handleMissedMessage(message) {
  if (message && message.type === MESSAGE_TYPES.SCHEDULE_STATE && el && !el.view.hidden && !el.panel.hidden) loadMissed();
  return false;
}

/**
 * @param {{ send: (type: string, payload?: object) => Promise<any>, check?: Function }} context
 *        check: services/download-log.js checkDownloaded (tests pass a fake)
 */
export function initMissed(context) {
  ctx = { check: checkDownloaded, ...context };
  el = {
    view: $("view-downloads"),
    panel: $("downloads-missed"),
    summary: $("missed-summary"),
    days: $("missed-days"),
    dayField: $("missed-day-field"),
    dayBox: $("missed-day"),
    typesTitle: $("missed-types-title"),
    tiles: $("missed-tiles"),
    types: $("missed-types"),
    missedTitle: $("missed-list-title"),
    missed: $("missed-list"),
    missedEmpty: $("missed-list-empty"),
    pendingBox: $("missed-pending-box"),
    pendingTitle: $("missed-pending-title"),
    pending: $("missed-pending"),
    checkNote: $("missed-check"),
    btnExcel: $("btn-missed-excel"),
    btnRefresh: $("btn-missed-refresh"),
    error: $("missed-error"),
    errorTitle: $("missed-error-title"),
    errorMessage: $("missed-error-message")
  };
  if (!el.view || !el.panel) {
    el = null;
    return;
  }
  el.btnExcel.addEventListener("click", () => saveExcel());
  el.btnRefresh.addEventListener("click", () => loadMissed({ check: true }));
  el.days.addEventListener("change", () => {
    picked = el.days.value;
    render();
  });
}

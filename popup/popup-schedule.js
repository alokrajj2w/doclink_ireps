/**
 * "Scheduled downloads" (Phase 1): what the shared schedules of this IREPS account did today, and
 * - for an admin (doclink.schedule.manage) - the schedules themselves.
 *
 * The schedules live in the Recon Engine, per IREPS account; whichever DocLink user is logged in
 * to IREPS first runs a due download - once a day, or once per period (hourly) for a repeating
 * schedule - always to S3 / ECM (background/scheduler-job.js).
 * This view only shows and edits; it never starts a download itself. The header icon appears only
 * when config.json "schedular_phase1" switches scheduling on for this DocLink.
 */

import { MESSAGE_TYPES, describeError } from "../utils/messages.js";
import { readConfigFiles } from "../utils/config.js";
import { parseSchedulerConfig, SCHEDULE_TYPES, SCHEDULE_TYPE_LABEL, SCHEDULE_DEFAULT_TIMING } from "../services/scheduler/schedule-types.js";
import { logger } from "../utils/logger.js";

const $ = (id) => document.getElementById(id);
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const INTERVALS = [10, 15, 30, 60];
/** repeat_every_minutes choices: null runs once a day, a number once per period of that length. */
const REPEATS = [
  [null, "once a day"],
  [30, "every 30 min"],
  [60, "every hour"],
  [120, "every 2 hours"],
  [180, "every 3 hours"]
];
// the Recon Engine's defaults (schedules.py LOOKBACK_DEFAULT); tabulations go by closing date and appear days later
const DEFAULT_LOOKBACK = {
  billStatus: 90, crn: 30, rnote: 30, ma: 2, poDate: 2, icDate: 2, icNotifications: 1,
  tenderNit: 2, tenderCounterOffer: 2, tenderLoa: 2, tenderTabulations: 15, tenderCorrespondence: 1, tenderNegotiation: 2
};
/** Types whose run takes no date range (what IREPS lists now). */
const NO_LOOKBACK = new Set(["icNotifications", "tenderCorrespondence"]);

let el = null;
let ctx = null;
let loading = false;

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
  if (parts.length === 0 && result.found === 0) parts.push("nothing new in IREPS");
  return parts.join(", ");
}

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
 */
export function slotText(slot, schedule = null) {
  const window = `${istTime(slot.window_start_at)}–${istTime(slot.window_end_at)}`;
  const reason = slot.code ? describeError(slot.code).title : "";
  switch (slot.status) {
    case "done": {
      const nextRun = istTime(slot.window_end_at);
      // a repeating schedule's runs start up to and including window_end (09:00-18:00 hourly: the last at 18:00)
      const more = isPeriodSlot(slot) && schedule && schedule.enabled !== false && nextRun <= schedule.window_end ? `next run ${nextRun}` : "";
      return [`Done by ${who(slot.done_by)} at ${istTime(slot.ended_at)}`, resultText(slot.result), more].filter(Boolean).join(" · ");
    }
    case "in_progress":
      return `Running – ${who(slot.holder)}`;
    case "pending":
      return `Waits for a DocLink user logged in to IREPS (${window})`;
    case "partial":
    case "failed":
      return [reason, resultText(slot.result), slot.next_try_at ? `next try ${istTime(slot.next_try_at)}` : ""].filter(Boolean).join(" · ");
    case "failed_final":
      return reason || "Failed";
    case "missed":
      return `Nobody with DocLink was logged in to IREPS ${window}${reason ? ` (last: ${reason})` : ""}`;
    default:
      return "";
  }
}

/** What this DocLink is waiting for, in one sentence. */
function waitingText(waitingFor) {
  switch (waitingFor) {
    case "ireps":
      return "A download is due: open IREPS (logged in) and DocLink runs it.";
    case "busy":
      return "A download is due: it starts when your current DocLink run ends.";
    case "backend":
      return "The Recon Engine's schedules could not be reached; DocLink tries again later.";
    default:
      return "";
  }
}

function statusLine(view) {
  const { config, user, account } = view;
  if (!config.enabled) return `Scheduled downloads are off in this DocLink (${config.reason}).`;
  if (!user) return "Sign in to the Recon Engine to take part in scheduled downloads.";
  if (!user.canRun) return "Your Recon Engine role does not include scheduled downloads (doclink.schedule.run).";
  if (!account) return "Open an IREPS page and log in: DocLink then knows which IREPS account's schedules to run.";
  const runs = config.types.map(typeLabel).join(", ");
  const unknown = config.unknown.length ? ` Unknown document type in config: ${config.unknown.join(", ")}.` : "";
  return [`IREPS account ${account}. This DocLink runs: ${runs}.${unknown}`, waitingText(view.waitingFor)].filter(Boolean).join(" ");
}

function renderToday(view) {
  el.today.replaceChildren();
  const rows = todayRows(view.slots);
  const scheduleOf = new Map((view.schedules || []).map((s) => [s.doc_type, s]));
  el.todayEmpty.hidden = rows.length > 0 || !view.account;
  for (const { slot, earlier } of rows) {
    const li = document.createElement("li");
    li.className = "schedule-row";
    const name = document.createElement("span");
    name.className = "schedule-type";
    name.textContent = typeLabel(slot.doc_type);
    const [chipText, chipClass] = STATUS_CHIP[slot.status] || [slot.status, ""];
    const chip = document.createElement("span");
    chip.className = `chip ${chipClass}`;
    chip.textContent = chipText;
    const text = document.createElement("span");
    text.className = "schedule-text";
    const notHere = view.config.enabled && !view.config.types.includes(slot.doc_type) && ["pending", "failed", "partial"].includes(slot.status);
    text.textContent = [slotText(slot, scheduleOf.get(slot.doc_type)), notHere ? "Not scheduled in this DocLink" : "", earlierText(earlier)].filter(Boolean).join(" · ");
    li.append(name, chip, text);
    el.today.append(li);
  }
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

/** One editor card per document type: the account's schedule, or the defaults for a new one. */
function editor(type, schedule) {
  const s = schedule || { doc_type: type, ...SCHEDULE_DEFAULT_TIMING[type], days: [0, 1, 2, 3, 4, 5, 6], lookback_days: DEFAULT_LOOKBACK[type], enabled: true };
  const box = document.createElement("div");
  box.className = "schedule-editor";

  const head = document.createElement("label");
  head.className = "schedule-editor-head";
  const enabled = document.createElement("input");
  enabled.type = "checkbox";
  enabled.checked = schedule ? schedule.enabled !== false : false;
  const title = document.createElement("span");
  title.textContent = `${typeLabel(type)}${schedule ? "" : " (not scheduled)"}`;
  head.append(enabled, title);

  const from = Object.assign(document.createElement("input"), { type: "time", value: s.window_start });
  const to = Object.assign(document.createElement("input"), { type: "time", value: s.window_end });
  const runs = document.createElement("select");
  const repeat = s.repeat_every_minutes ?? null;
  for (const [m, text] of REPEATS) runs.append(Object.assign(document.createElement("option"), { value: m === null ? "" : String(m), textContent: text, selected: m === repeat }));
  const every = document.createElement("select");
  for (const m of INTERVALS) every.append(Object.assign(document.createElement("option"), { value: String(m), textContent: `every ${m} min`, selected: m === s.check_every_minutes }));
  const lookback = Object.assign(document.createElement("input"), { type: "number", min: "1", max: "180", value: String(s.lookback_days) });
  const row = document.createElement("div");
  row.className = "date-row";
  row.append(field("From", from), field("To", to), field("Runs", runs), field("Retry", every));
  if (!NO_LOOKBACK.has(type)) row.append(field(type === "billStatus" ? "Look back (days; 90 = Last 90 Days)" : "Look back (days)", lookback));

  const days = document.createElement("div");
  days.className = "schedule-days";
  const dayBoxes = DAYS.map((d, i) => {
    const input = Object.assign(document.createElement("input"), { type: "checkbox", checked: s.days.includes(i) });
    const label = document.createElement("label");
    label.append(input, document.createTextNode(d));
    days.append(label);
    return input;
  });

  const actions = document.createElement("div");
  actions.className = "result-actions";
  const save = Object.assign(document.createElement("button"), { type: "button", className: "btn btn-link", textContent: schedule ? "Save" : "Add schedule" });
  save.addEventListener("click", () =>
    saveSchedule({
      id: schedule ? schedule.id : undefined,
      doc_type: type,
      enabled: enabled.checked || !schedule,
      window_start: from.value,
      window_end: to.value,
      check_every_minutes: Number(every.value),
      repeat_every_minutes: runs.value === "" ? null : Number(runs.value),
      days: dayBoxes.map((b, i) => (b.checked ? i : -1)).filter((i) => i >= 0),
      lookback_days: Number(lookback.value) || DEFAULT_LOOKBACK[type]
    })
  );
  actions.append(save);
  if (schedule) {
    const remove = Object.assign(document.createElement("button"), { type: "button", className: "btn btn-link", textContent: "Delete" });
    remove.addEventListener("click", () => deleteSchedule(schedule.id));
    actions.append(remove);
  }
  box.append(head, row, days, actions);
  return box;
}

function renderManage(view) {
  const canManage = Boolean(view.user && view.user.canManage && view.account && view.config.enabled);
  el.manage.hidden = !canManage;
  el.editors.replaceChildren();
  if (!canManage) return;
  const byType = new Map((view.schedules || []).map((s) => [s.doc_type, s]));
  for (const type of SCHEDULE_TYPES) el.editors.append(editor(type, byType.get(type)));
}

function showError(described) {
  el.error.hidden = !described;
  if (!described) return;
  el.errorTitle.textContent = described.title;
  el.errorMessage.textContent = described.message;
}

function render(view) {
  el.status.textContent = statusLine(view);
  showError(view.error || null);
  renderToday(view);
  renderManage(view);
}

async function load() {
  if (loading) return;
  loading = true;
  el.btnRefresh.disabled = true;
  try {
    const view = await ctx.send(MESSAGE_TYPES.SCHEDULE_GET_STATE);
    if (view && view.config) render(view);
    else showError(describeError("UNKNOWN", { detail: "no answer from DocLink's background worker" }));
  } catch (error) {
    logger.warn("Schedule view could not be loaded", error);
    showError(describeError("UNKNOWN", { detail: String((error && error.message) || error) }));
  } finally {
    loading = false;
    el.btnRefresh.disabled = false;
  }
}

async function saveSchedule(schedule) {
  const answer = await ctx.send(MESSAGE_TYPES.SCHEDULE_SAVE, { schedule });
  if (answer && answer.ok === false) return showError(answer.error);
  await load();
}

async function deleteSchedule(id) {
  const answer = await ctx.send(MESSAGE_TYPES.SCHEDULE_DELETE, { id });
  if (answer && answer.ok === false) return showError(answer.error);
  await load();
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
    manage: $("schedule-manage"),
    editors: $("schedule-editors")
  };
  el.btnOpen.addEventListener("click", () => (el.view.hidden ? open() : ctx.showView("main")));
  el.btnBack.addEventListener("click", () => ctx.showView("main"));
  el.btnRefresh.addEventListener("click", () => load());
  const files = await readConfigFiles();
  el.btnOpen.hidden = !parseSchedulerConfig(files && files.config).enabled;
}

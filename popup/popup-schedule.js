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
/** Types whose schedule box the admin opened: kept open when the list is drawn again (after a save). */
const openEditors = new Set();

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
 * The pending and missed lines state only what the slot record says: why a slot has not run
 * (no IREPS login, a busy DocLink, an error) is in the status line, from this DocLink's scheduler.
 */
export function slotText(slot, schedule = null, now = Date.now()) {
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
      return Date.parse(slot.window_start_at || "") > now ? `Scheduled ${window}` : `Due ${window}, not run yet`;
    case "partial":
    case "failed":
      return [reason, resultText(slot.result), slot.next_try_at ? `next try ${istTime(slot.next_try_at)}` : ""].filter(Boolean).join(" · ");
    case "failed_final":
      return reason || "Failed";
    case "missed":
      return `Not run during ${window}${reason ? ` (last: ${reason})` : ""}`;
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

/** A saved schedule's timing for its box's summary line: ["09:00–10:00", "once a day"]. */
function timingParts(s) {
  const repeat = REPEATS.find(([m]) => m === (s.repeat_every_minutes ?? null));
  return [`${s.window_start}–${s.window_end}`, repeat ? repeat[1] : `every ${s.repeat_every_minutes} min`];
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
  const lookback = Object.assign(document.createElement("input"), { type: "number", min: "1", max: "180", value: String(s.lookback_days) });
  const fields = document.createElement("div");
  fields.className = "schedule-fields";
  fields.append(group("From", from.element), group("To", to.element), field("Runs", runs), field("Retry", every));
  if (!NO_LOOKBACK.has(type)) {
    const look = field("Look back (days)", lookback);
    if (type === "billStatus") look.append(Object.assign(document.createElement("span"), { className: "field-hint", textContent: '90 = IREPS "Last 90 Days"' }));
    fields.append(look);
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
        lookback_days: Number(lookback.value) || DEFAULT_LOOKBACK[type]
      })
    )
  );
  actions.append(save);
  if (remove) {
    remove.addEventListener("click", () => whileBusy(remove, buttons, () => deleteSchedule(schedule.id)));
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
  el.editors.replaceChildren();
  if (!canManage) return;
  const byType = new Map((view.schedules || []).map((s) => [s.doc_type, s]));
  for (const type of editorTypes(view.config, view.schedules)) el.editors.append(editor(type, byType.get(type)));
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

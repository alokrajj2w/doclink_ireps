/**
 * "Download POs by PO Date" and "Download ICs from Notifications" views.
 *
 * Both are pure views of the state object the service worker keeps per kind
 * ("po-date" / "ic-notif") and broadcasts as BATCH_UPDATE: the panel sends
 * BATCH_START / BATCH_RETRY, then renders whatever state arrives, so closing
 * and reopening the panel mid-run just fetches the state again
 * (BATCH_GET_STATE). Everything that came from IREPS is written with
 * textContent, never as markup.
 */

import { MESSAGE_TYPES, describeError } from "../utils/messages.js";
import { ECM_OUTCOME, describeEcmOutcome, summariseEcm } from "../services/ecm-service.js";
import { SAVE_DESTINATION } from "../services/recon-service.js";
import { describeSkip, skipChipText } from "../services/download-log.js";

const $ = (id) => document.getElementById(id);

let ctx = null;
const el = {};

const ITEM_LABEL = { queued: "Queued", downloading: "Downloading", completed: "Downloaded", failed: "Failed", skipped: "Skipped", duplicate: "Duplicate" };
const OUTCOME_LABEL = { pending: "Pending", matched: "Matched", unparsed: "Unreadable", not_found: "No record", no_link: "No IC link", error: "Failed", session_expired: "Login needed" };

const KINDS = {
  "po-date": { prefix: "pod", name: "PO" },
  "ic-notif": { prefix: "icn", name: "IC" }
};

const IDLE_LABEL = { pod: "Download All Matching POs", icn: "Download IC from Notifications" };

/** The idle button label; under Save to: ECM / S3 it reads "... to ECM", like the single PO / IC buttons. */
function idleLabel(prefix) {
  const toEcm = ctx && ctx.getDestination && ctx.getDestination() === SAVE_DESTINATION.RECON;
  return `${IDLE_LABEL[prefix]}${toEcm ? " to ECM" : ""}`;
}

/**
 * Where the finished documents went: the ECM summary when any went there, plus the
 * Downloads folder when any were saved on this computer (Local, or an ECM upload that failed).
 */
function savedWhere(items, localFolder) {
  const done = items.filter((i) => i.status === "completed");
  const local = done.some((i) => !i.ecm || i.ecm.status === ECM_OUTCOME.FAILED);
  return [summariseEcm(done), local ? `Saved to ${localFolder}.` : ""].filter(Boolean).join("\n");
}

function bind() {
  Object.assign(el, {
    view: $("view-po-ic-batch"),
    btnOpen: $("btn-po-ic-batch-open"),
    btnBack: $("btn-pod-back"),
    from: $("pod-from"),
    to: $("pod-to")
  });
  for (const { prefix } of Object.values(KINDS)) {
    el[prefix] = {
      button: $(`btn-${prefix}-download`),
      label: document.querySelector(`#btn-${prefix}-download .btn-label`),
      progress: $(`${prefix}-progress`),
      progressMessage: $(`${prefix}-progress-message`),
      bar: $(`${prefix}-bar`),
      error: $(`${prefix}-error`),
      errorTitle: $(`${prefix}-error-title`),
      errorMessage: $(`${prefix}-error-message`),
      openIreps: $(`btn-${prefix}-open-ireps`),
      result: $(`${prefix}-result`),
      resultTitle: $(`${prefix}-result-title`),
      resultText: $(`${prefix}-result-text`),
      counts: $(`${prefix}-counts`),
      retry: $(`btn-${prefix}-retry`),
      details: $(`${prefix}-details`),
      list: $(`${prefix}-list`)
    };
  }
}

/** "YYYY-MM-DD" in local time. */
function localIso(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function setBusy(prefix, busy, label) {
  const v = el[prefix];
  v.button.disabled = busy;
  v.button.classList.toggle("is-busy", busy);
  v.label.textContent = label;
}

function hideAll(prefix) {
  const v = el[prefix];
  v.progress.hidden = true;
  v.error.hidden = true;
  v.result.hidden = true;
}

function showError(prefix, error) {
  const v = el[prefix];
  const described = error && error.title ? error : describeError((error && error.code) || "UNKNOWN", { detail: error && error.detail, status: error && error.status });
  hideAll(prefix);
  setBusy(prefix, false, idleLabel(prefix));
  ctx.setConnectionForError(described);
  v.errorTitle.textContent = described.title;
  v.errorMessage.textContent = described.message;
  v.openIreps.hidden = described.connection !== "login";
  v.error.classList.toggle("is-notice", described.notice === true);
  v.error.hidden = false;
}

function renderCounts(prefix, rows) {
  const dl = el[prefix].counts;
  dl.replaceChildren();
  for (const [label, value, bad] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = String(value);
    if (bad && value > 0) dd.classList.add("is-bad");
    dl.append(dt, dd);
  }
}

function errorText(error) {
  if (!error) return "";
  const d = describeError(error.code, { detail: error.detail, status: error.status });
  return `${d.title}: ${d.message}`;
}

function chip(status, labels, title, text) {
  const c = document.createElement("span");
  c.className = `chip chip-${status}`;
  c.textContent = text || labels[status] || status;
  if (title) c.title = title;
  return c;
}

function listItem(title, meta, status, labels, why, chipText) {
  const li = document.createElement("li");
  li.className = "doc-item batch-item";
  const body = document.createElement("div");
  const no = document.createElement("div");
  no.className = "doc-no";
  no.textContent = title;
  const m = document.createElement("div");
  m.className = "doc-meta";
  m.textContent = meta;
  body.append(no, m);
  if (why) {
    const w = document.createElement("div");
    w.className = "doc-meta";
    w.textContent = why;
    body.append(w);
  }
  li.append(body, chip(status, labels, why, chipText));
  return li;
}

/* -------------------------------------------------------------------------- */
/* PO by date                                                                 */
/* -------------------------------------------------------------------------- */

function renderPoDate(state) {
  const v = el.pod;
  if (!state || state.phase === "idle") {
    hideAll("pod");
    setBusy("pod", false, idleLabel("pod"));
    v.details.hidden = true;
    return;
  }
  if (state.phase === "error") {
    showError("pod", state.error);
    return;
  }
  const c = state.counts;
  const done = c.downloaded + c.failed + c.skipped;
  // "skipped" holds both: rows without a PDF link, and POs the user already has (not a problem)
  const already = c.alreadyDownloaded || 0;
  const noLink = c.skipped - already;
  renderCounts("pod", [
    ["Date range searched", `${state.dateFrom} – ${state.dateTo}`],
    ["Matching PO records found", c.found],
    ["PDFs downloaded", c.downloaded],
    ["Already downloaded (skipped)", already],
    ["Duplicates skipped", c.duplicates],
    ["Failed", c.failed, true],
    ["Skipped (no PDF link)", noLink, true]
  ]);

  const running = state.running || state.phase === "searching" || state.phase === "downloading";
  hideAll("pod");
  if (running) {
    v.progress.hidden = false;
    const w = state.windowProgress;
    v.progressMessage.textContent =
      state.phase === "searching" ? (w && w.total > 1 ? `Searching IREPS (period ${w.index} of ${w.total})...` : "Searching IREPS for POs...") : `Downloading POs... ${done} of ${c.found}`;
    v.bar.max = Math.max(c.found, 1);
    v.bar.value = state.phase === "searching" ? 0 : done;
    setBusy("pod", true, state.phase === "searching" ? "Searching..." : "Downloading...");
    v.result.hidden = false;
    v.result.className = "result";
    v.resultTitle.textContent = "";
    v.resultText.textContent = "";
  } else {
    setBusy("pod", false, idleLabel("pod"));
    ctx.setConnection("connected", "Connected");
    v.result.hidden = false;
    const retryable = state.items.filter((i) => i.status === "failed" && i.url).length;
    if (c.found === 0) {
      v.result.className = "result result-error is-notice";
      v.resultTitle.textContent = "No matching PO records";
      v.resultText.textContent = `IREPS returned no Purchase Orders dated ${state.dateFrom}${state.dateFrom === state.dateTo ? "" : " to " + state.dateTo}.`;
    } else if (c.failed === 0 && noLink === 0) {
      v.result.className = "result result-success";
      v.resultTitle.textContent = `✓ ${c.downloaded} PO${c.downloaded === 1 ? "" : "s"} downloaded`;
      v.resultText.textContent = [savedWhere(state.items, "Downloads/DocLink/IREPS/PO/<PO date>/"), already ? `${already} already downloaded before: skipped (see the list).` : "", ...(state.warnings || [])].filter(Boolean).join("\n");
    } else {
      v.result.className = "result result-error is-notice";
      v.resultTitle.textContent = c.downloaded ? `Partly done: ${c.downloaded} downloaded, ${c.failed + noLink} not` : already && !c.failed && !noLink ? "Nothing new to download" : "No PO could be downloaded";
      v.resultText.textContent = [
        state.sessionExpired ? "Your IREPS session expired. Log in again, then retry the failed downloads." : "Open the list below to see why each PO failed or was skipped.",
        already ? `${already} already downloaded before: skipped.` : "",
        summariseEcm(state.items.filter((i) => i.status === "completed")),
        ...(state.warnings || [])
      ].filter(Boolean).join("\n");
    }
    v.retry.hidden = retryable === 0;
  }

  v.details.hidden = state.items.length === 0;
  v.list.replaceChildren(
    ...state.items.map((i) => {
      const why = i.skip ? describeSkip(i.skip) : i.error ? errorText(i.error) || i.error.detail : describeEcmOutcome(i.ecm) || null;
      return listItem(`PO ${i.poNo || "?"}`, [i.poDate, i.railwayUnit, i.poValue ? `₹${i.poValue}` : null].filter(Boolean).join(" · "), i.status, ITEM_LABEL, why, i.skip ? skipChipText(i.skip) : undefined);
    })
  );
}

/* -------------------------------------------------------------------------- */
/* IC from notifications                                                      */
/* -------------------------------------------------------------------------- */

function renderIcNotif(state) {
  const v = el.icn;
  if (!state || state.phase === "idle") {
    hideAll("icn");
    setBusy("icn", false, idleLabel("icn"));
    v.details.hidden = true;
    return;
  }
  if (state.phase === "error") {
    showError("icn", state.error);
    return;
  }
  const c = state.counts;
  renderCounts("icn", [
    ["Notifications inspected", c.inspected],
    ["IC-issued notifications found", c.icNotifications],
    ["Inspection-call records matched", c.matchedRecords],
    ["IC PDFs downloaded", c.downloaded],
    ["Already downloaded (skipped)", c.alreadyDownloaded || 0],
    ["Duplicate PDFs skipped", c.duplicates],
    ["Failed / skipped documents", c.failed + c.skipped - (c.alreadyDownloaded || 0), true],
    ["Notifications not processed", c.unparsed + c.notFound + c.searchErrors + c.noLink, true]
  ]);

  const running = state.running || state.phase === "reading-notifications" || state.phase === "searching" || state.phase === "downloading";
  hideAll("icn");
  const docsDone = c.downloaded + c.failed + c.skipped;
  const docsTotal = state.items.length;
  if (running) {
    v.progress.hidden = false;
    const looked = state.notifications.filter((n) => n.outcome !== "pending").length;
    v.progressMessage.textContent =
      state.phase === "reading-notifications"
        ? "Reading IREPS notifications..."
        : state.phase === "searching"
        ? `Finding inspection calls (${looked} of ${state.notifications.length})...`
        : `Downloading ICs... ${docsDone} of ${docsTotal}`;
    v.bar.max = Math.max(state.phase === "downloading" ? docsTotal : state.notifications.length, 1);
    v.bar.value = state.phase === "downloading" ? docsDone : looked;
    setBusy("icn", true, state.phase === "downloading" ? "Downloading..." : "Working...");
    v.result.hidden = false;
    v.result.className = "result";
    v.resultTitle.textContent = "";
    v.resultText.textContent = "";
  } else {
    setBusy("icn", false, idleLabel("icn"));
    ctx.setConnection("connected", "Connected");
    v.result.hidden = false;
    const already = c.alreadyDownloaded || 0;
    const problems = c.failed + c.skipped - already + c.unparsed + c.notFound + c.searchErrors + c.noLink;
    const retryable = state.items.filter((i) => i.status === "failed" && i.url).length + state.notifications.filter((n) => n.outcome === "error" || n.outcome === "session_expired").length;
    if (c.icNotifications === 0) {
      v.result.className = "result result-error is-notice";
      v.resultTitle.textContent = "No IC-issued notifications";
      v.resultText.textContent = c.inspected === 0 ? "IREPS returned no notifications." : `None of the ${c.inspected} current notification${c.inspected === 1 ? "" : "s"} says an IC was issued.`;
    } else if (problems === 0) {
      v.result.className = "result result-success";
      v.resultTitle.textContent = `✓ ${c.downloaded} IC${c.downloaded === 1 ? "" : "s"} downloaded`;
      v.resultText.textContent = [savedWhere(state.items, "Downloads/DocLink/IREPS/IC/<PO>/") + (state.manifestFile ? ` Manifest: ${state.manifestFile}.` : ""), already ? `${already} already downloaded before: skipped (see the list).` : "", ...(state.warnings || [])].filter(Boolean).join("\n");
    } else {
      v.result.className = "result result-error is-notice";
      v.resultTitle.textContent = c.downloaded ? `Partly done: ${c.downloaded} downloaded, ${problems} problem${problems === 1 ? "" : "s"}` : "No IC could be downloaded";
      v.resultText.textContent = [
        state.sessionExpired ? "Your IREPS session expired. Log in again, then retry." : "Open the list below to see each notification's outcome.",
        already ? `${already} already downloaded before: skipped.` : "",
        summariseEcm(state.items.filter((i) => i.status === "completed")),
        ...(state.warnings || [])
      ].filter(Boolean).join("\n");
    }
    v.retry.hidden = retryable === 0;
  }

  v.details.hidden = state.notifications.length === 0;
  const rows = [];
  for (const n of state.notifications) {
    const label = n.poNo && n.poSerial ? `PO ${n.poNo} · Sr. ${n.poSerial}` : "Unreadable notification";
    const why = n.note || (n.error ? errorText(n.error) : null);
    rows.push(listItem(label, `Notification ${n.notificationId || "?"}${n.date ? " · " + n.date : ""}`, n.outcome, OUTCOME_LABEL, why));
    for (const id of n.itemIds || []) {
      const i = state.items.find((x) => x.id === id);
      if (!i) continue;
      const dup = (n.duplicateOf || []).includes(id);
      const why = dup ? null : i.skip ? describeSkip(i.skip) : i.error ? errorText(i.error) || i.error.detail : describeEcmOutcome(i.ecm) || null;
      rows.push(listItem(`   IC Call ${i.callId || "?"}`, [i.icDate, i.filename].filter(Boolean).join(" · "), dup ? "duplicate" : i.status, ITEM_LABEL, why, !dup && i.skip ? skipChipText(i.skip) : undefined));
    }
  }
  v.list.replaceChildren(...rows);
}

/* -------------------------------------------------------------------------- */

const RENDERERS = { "po-date": renderPoDate, "ic-notif": renderIcNotif };

async function start(kind) {
  const prefix = KINDS[kind].prefix;
  const message = { kind };
  if (kind === "po-date") {
    if (!el.from.value || !el.to.value) return showError("pod", describeError("IREPS_INVALID_REQUEST", { detail: "Please select both From Date and To Date." }));
    if (el.from.value > el.to.value) return showError("pod", describeError("IREPS_INVALID_REQUEST", { detail: "From Date must not be later than To Date." }));
    message.dateFrom = el.from.value;
    message.dateTo = el.to.value;
  }
  message.destination = ctx.getDestination();
  hideAll(prefix);
  setBusy(prefix, true, "Starting...");
  const response = await ctx.send(MESSAGE_TYPES.BATCH_START, message);
  if (!response) showError(prefix, describeError("NO_BACKGROUND_RESPONSE", { detail: "no reply to the download request" }));
  else if (response.started === false) showError(prefix, response.error || describeError("BATCH_BUSY"));
}

async function retry(kind) {
  const response = await ctx.send(MESSAGE_TYPES.BATCH_RETRY, { kind, destination: ctx.getDestination() });
  if (!response || response.started === false) showError(KINDS[kind].prefix, (response && response.error) || describeError("NO_BACKGROUND_RESPONSE", { detail: "no reply to the retry request" }));
}

async function refresh(kind) {
  const state = await ctx.send(MESSAGE_TYPES.BATCH_GET_STATE, { kind });
  RENDERERS[kind](state);
  return state;
}

export function initBatch(context) {
  ctx = context;
  bind();
  const today = localIso();
  el.from.value = today;
  el.to.value = today;
  el.btnOpen.addEventListener("click", async () => {
    ctx.showView("po-ic-batch");
    await Promise.all(Object.keys(KINDS).map(refresh));
  });
  el.btnBack.addEventListener("click", () => ctx.showView("po-ic"));
  for (const [kind, { prefix }] of Object.entries(KINDS)) {
    el[prefix].button.addEventListener("click", () => start(kind));
    el[prefix].retry.addEventListener("click", () => retry(kind));
    el[prefix].openIreps.addEventListener("click", () => ctx.send(MESSAGE_TYPES.OPEN_IREPS));
  }
}

/** Save to changed: the idle download buttons say where the POs and ICs go. */
export function refreshBatchDestination() {
  if (!ctx) return;
  for (const { prefix } of Object.values(KINDS)) {
    if (!el[prefix].button.classList.contains("is-busy")) setBusy(prefix, false, idleLabel(prefix));
  }
}

/** Route BATCH_UPDATE broadcasts. Returns true when handled. */
export function handleBatchMessage(message) {
  if (message.type !== MESSAGE_TYPES.BATCH_UPDATE) return false;
  if (!el.view.hidden && RENDERERS[message.kind]) RENDERERS[message.kind](message.state);
  return true;
}

/** Reopen the batch view when a batch is still running. */
export async function restoreBatch() {
  const states = await Promise.all(Object.keys(KINDS).map((kind) => ctx.send(MESSAGE_TYPES.BATCH_GET_STATE, { kind })));
  if (!states.some((s) => s && s.running)) return false;
  ctx.showView("po-ic-batch");
  Object.keys(KINDS).forEach((kind, i) => RENDERERS[kind](states[i]));
  return true;
}

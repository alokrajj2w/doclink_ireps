/**
 * PO / Inspection Certificate view of the DocLink popup.
 *
 * One PO Number, two independent downloads:
 *
 *   Download PO                        -> PO_DOWNLOAD { poNo }
 *   Download Inspection Certificate    -> IC_DOWNLOAD { poNo }
 *   Retry failed downloads (IC result) -> IC_RETRY: the failed ICs of that run, its own PO
 *
 * Both buttons read the same input and use the exact same PO number; the
 * popup never re-asks for it. Today the PO number is typed manually
 * (getManualPoNumber() below); later it can come from a configured source
 * without any other change here, since the service worker only ever
 * receives a bare PO number string.
 *
 * Each download runs in the service worker (continues if the popup closes)
 * and is a thin view over PO_DOWNLOAD / IC_DOWNLOAD / GET_PO_STATE /
 * GET_IC_STATE, exactly like the CRN/R-NOTE and MA views.
 *
 * Only this panel's own runs are shown here (popup-gate.js isOwnRun): a PO or IC download started in
 * another tab's panel is only noted, and this view's button waits for it. A state read when the view
 * opens may be old: it never sets the IREPS indicator, and an old "login required" is not shown again.
 */

import { MESSAGE_TYPES, describeError, asDescribedError } from "../utils/messages.js";
import { ECM_OUTCOME, describeEcmOutcome, summariseEcm } from "../services/ecm-service.js";
import { describeSkip } from "../services/download-log.js";
import { noteBackgroundRun, backgroundRunText, irepsAnswered } from "./popup-common.js";
import { isOwnRun } from "./popup-gate.js";

const $ = (id) => document.getElementById(id);

let ctx = null;
const el = {};

function bindElements() {
  Object.assign(el, {
    view: $("view-po-ic"),
    btnOpen: $("btn-po-ic-open"),
    btnBack: $("btn-po-ic-back"),
    poNumber: $("po-ic-number"),

    btnPoDownload: $("btn-po-download"),
    poDownloadLabel: document.querySelector("#btn-po-download .btn-label"),
    poProgress: $("po-progress"),
    poProgressMessage: $("po-progress-message"),
    poError: $("po-error"),
    poErrorTitle: $("po-error-title"),
    poErrorMessage: $("po-error-message"),
    btnPoOpenIreps: $("btn-po-open-ireps"),
    poResult: $("po-result"),
    poResultTitle: $("po-result-title"),
    poResultFilename: $("po-result-filename"),
    btnPoShowFile: $("btn-po-show-file"),

    btnIcDownload: $("btn-ic-download"),
    icDownloadLabel: document.querySelector("#btn-ic-download .btn-label"),
    icProgress: $("ic-progress"),
    icProgressMessage: $("ic-progress-message"),
    icError: $("ic-error"),
    icErrorTitle: $("ic-error-title"),
    icErrorMessage: $("ic-error-message"),
    btnIcOpenIreps: $("btn-ic-open-ireps"),
    icResult: $("ic-result"),
    icResultTitle: $("ic-result-title"),
    icResultText: $("ic-result-text"),
    icResultFolder: $("ic-result-folder"),
    btnIcShowFolder: $("btn-ic-show-folder"),
    btnIcRetry: $("btn-ic-retry")
  });
}

/** The PO number source for today's manual-entry UI. Replace only this to read it from elsewhere later. */
function getManualPoNumber() {
  return el.poNumber.value.trim();
}

let poDownloadId = null;
let icFolderDownloadId = null;
/** The PO of the IC result shown (its Retry retries that run, whatever the box holds now, 7.3). */
let icResultPo = null;

/** A restored "login required" error: not shown again on open, the panel's live session check decides (4.10). */
const staleLogin = (state) => state.status === "error" && Boolean(state.error && state.error.loginRequired);

/**
 * A PO or IC download this panel did not start (another tab's) runs or ended: the panel says so and its
 * button waits; the view keeps what it shows.
 */
function noteBackground(job, startedBy, running) {
  const button = job === "po" ? el.btnPoDownload : el.btnIcDownload;
  noteBackgroundRun(job, running ? backgroundRunText(job === "po" ? "PO" : "Inspection Certificates", startedBy) : null);
  if (!button.classList.contains("is-busy")) button.disabled = running;
}

/* -------------------------------------------------------------------------- */
/* Purchase Order                                                             */
/* -------------------------------------------------------------------------- */

function setPoBusy(busy, label) {
  el.btnPoDownload.disabled = busy;
  el.btnPoDownload.classList.toggle("is-busy", busy);
  el.poDownloadLabel.textContent = label || "Download PO";
}

function resetPoResults() {
  el.poProgress.hidden = true;
  el.poError.hidden = true;
  el.poResult.hidden = true;
}

/**
 * `live`: false for a state read when the view opens (it never sets the IREPS indicator). `stage`: the run's
 * stage; "Connected" only once IREPS answered the run's session check (7.15).
 */
function renderPoProgress(message, { live = true, stage = null } = {}) {
  resetPoResults();
  el.poProgress.hidden = false;
  el.poProgressMessage.textContent = message || "";
  setPoBusy(true, message || "Working...");
  if (live && irepsAnswered(stage)) ctx.setConnection("connected", "Connected");
}

const PO_ECM_TITLE = {
  [ECM_OUTCOME.STORED]: "✓ PO saved to ECM",
  [ECM_OUTCOME.ALREADY_STORED]: "✓ PO already in ECM",
  [ECM_OUTCOME.FAILED]: "PO saved locally (not in ECM)"
};

function renderPoComplete(result, { live = true } = {}) {
  resetPoResults();
  setPoBusy(false);
  if (live) ctx.setConnection("connected", "Connected");
  poDownloadId = result.downloadId ?? null;
  const ecm = result.ecm || null;
  if (result.skipped) {
    // already downloaded by this user / already in the ECM, and not chosen to download again
    el.poResultTitle.textContent = `PO ${result.poNumber || ""} not downloaded again`.replace(/\s+/g, " ");
    el.poResultFilename.textContent = [describeSkip(result.skip), ...(result.warnings || [])].filter(Boolean).join("\n");
  } else {
    el.poResultTitle.textContent = ecm ? PO_ECM_TITLE[ecm.status] : "✓ PO downloaded successfully";
    el.poResultFilename.textContent = [ecm ? describeEcmOutcome(ecm) : result.filename || "", ...(result.warnings || [])].filter(Boolean).join("\n");
  }
  el.btnPoShowFile.hidden = poDownloadId === null;
  el.poResult.hidden = false;
}

function renderPoError(error, { live = true } = {}) {
  const described = asDescribedError(error);
  resetPoResults();
  setPoBusy(false);
  if (live) ctx.setConnectionForError(described);
  el.poErrorTitle.textContent = described.title;
  el.poErrorMessage.textContent = described.message;
  el.btnPoOpenIreps.hidden = described.connection !== "login";
  el.poError.classList.toggle("is-notice", described.notice === true);
  el.poError.hidden = false;
}

async function startPoDownload() {
  const poNo = getManualPoNumber();
  if (!poNo) {
    renderPoError(describeError("IREPS_INVALID_REQUEST", { detail: "Please enter a PO Number." }));
    return;
  }
  renderPoProgress("Searching PO...");
  const response = await ctx.send(MESSAGE_TYPES.PO_DOWNLOAD, { poNo, destination: ctx.getDestination() });
  if (!response) renderPoError(describeError("NO_BACKGROUND_RESPONSE", { detail: "no reply to the PO download request" }));
  else if (response.started === false) renderPoError(response.error || describeError("PO_BUSY"));
}

/** The PO state when the view opens: this panel's own, and not an old "login required" (4.10). */
async function refreshPoState() {
  const state = await ctx.send(MESSAGE_TYPES.GET_PO_STATE);
  if (state && !isOwnRun(state.startedBy)) {
    noteBackground("po", state.startedBy, state.status === "running");
    return state;
  }
  if (!state || state.status === "idle" || staleLogin(state)) {
    resetPoResults();
    setPoBusy(false);
    return state;
  }
  if (state.poNumber && !el.poNumber.value) el.poNumber.value = state.poNumber;
  if (state.status === "running") renderPoProgress(state.message, { live: false });
  else if (state.status === "complete" && state.result) renderPoComplete(state.result, { live: false });
  else if (state.status === "error" && state.error) renderPoError(state.error, { live: false });
  return state;
}

/* -------------------------------------------------------------------------- */
/* Inspection Certificate                                                     */
/* -------------------------------------------------------------------------- */

function setIcBusy(busy, label) {
  el.btnIcDownload.disabled = busy;
  el.btnIcDownload.classList.toggle("is-busy", busy);
  el.icDownloadLabel.textContent = label || "Download Inspection Certificate";
}

function resetIcResults() {
  el.icProgress.hidden = true;
  el.icError.hidden = true;
  el.icResult.hidden = true;
}

/** As renderPoProgress: "Connected" only once IREPS answered the run's session check (7.15). */
function renderIcProgress(message, { live = true, stage = null } = {}) {
  resetIcResults();
  el.icProgress.hidden = false;
  el.icProgressMessage.textContent = message || "";
  setIcBusy(true, message || "Working...");
  if (live && irepsAnswered(stage)) ctx.setConnection("connected", "Connected");
}

/** Failed items worth retrying (a row without an IC link never succeeds). */
function retryableIcFailures(downloads) {
  return ((downloads && downloads.items) || []).filter((i) => i.status === "failed" && !(i.error && i.error.code === "IREPS_IC_LINK_NOT_FOUND"));
}

function renderIcDownloading(message, downloads, { live = true } = {}) {
  resetIcResults();
  el.icProgress.hidden = false;
  const d = downloads;
  el.icProgressMessage.textContent = d ? `${message} (${d.completed + d.failed} of ${d.total})` : message || "";
  setIcBusy(true, "Downloading...");
  if (live) ctx.setConnection("connected", "Connected");
}

/** One IC not downloaded, with why (the IC card has no item list to hover, 1.16). */
function icFailureLine(item) {
  const error = item.error || {};
  const described = describeError(error.code, { detail: error.detail, status: error.status });
  const why = error.detail || (error.status ? `IREPS returned HTTP ${error.status}` : "");
  return `${item.label}: ${described.title}${why ? ` (${why})` : ""}`;
}

/**
 * The IC result. `warnings`: the search's own (a list short of IREPS's total, a page limit, 1.19);
 * `error`: why the run did not finish clean (an expired session, which the indicator then shows, 1.18);
 * `live`: false for a state read when the view opens (it never sets the indicator, 4.10);
 * `poNumber`: the run's PO, named in the result: its Retry retries that run (7.3).
 */
function renderIcComplete(message, count, downloads, { warnings = [], error = null, live = true, poNumber = null } = {}) {
  resetIcResults();
  setIcBusy(false);
  icResultPo = poNumber || null;
  if (live) {
    if (error) ctx.setConnectionForError(error);
    else ctx.setConnection("connected", "Connected");
  }
  const items = (downloads && downloads.items) || [];
  const failed = items.filter((i) => i.status === "failed");
  const po = icResultPo ? `PO ${icResultPo}` : "this PO";
  // every IC of the PO was already there: nothing was downloaded, which is said as it is (1.17)
  const nothingNew = count > 0 && downloads.failed === 0 && downloads.completed === 0 && downloads.skipped > 0;
  el.icResultTitle.textContent =
    count === 0 ? "No Inspection Certificates found"
    : nothingNew ? "Nothing new to download"
    : downloads.failed === 0 ? `✓ ${downloads.completed} Inspection Certificate${downloads.completed === 1 ? "" : "s"} downloaded`
    : `${downloads.completed} downloaded, ${downloads.failed} failed`;
  const outcome =
    count === 0 ? `No issued Inspection Certificates were found for ${po}.`
    : downloads.failed > 0 ? `Not downloaded from ${po}${retryableIcFailures(downloads).length ? " (Retry fetches them again)" : ""}:`
    : nothingNew ? `Every issued Inspection Certificate of ${po} was already downloaded or is already in the ECM:`
    : downloads.skipped ? `Every other issued Inspection Certificate of ${po} was saved.`
    : `All issued Inspection Certificates of ${po} were saved.`;
  el.icResultText.textContent = [
    outcome,
    ...failed.map(icFailureLine),
    ...items.filter((i) => i.status === "skipped" && i.skip).map((i) => `${i.label}: ${describeSkip(i.skip)}`),
    error && error.message,
    summariseEcm(items),
    ...warnings,
    ...((downloads && downloads.warnings) || [])
  ].filter(Boolean).join("\n");
  // only files saved on this computer (an IC stored in the ECM has no local copy)
  const local = (downloads && downloads.items ? downloads.items : []).filter((i) => i.status === "completed" && i.path && (!i.ecm || i.ecm.status === ECM_OUTCOME.FAILED));
  const folders = new Set(local.map((i) => i.path.split("/").slice(0, -1).join("/")));
  el.icResultFolder.textContent = count === 0 || local.length === 0 ? "" : folders.size === 1 ? `Downloads/${Array.from(folders)[0]}/` : "Downloads/DocLink/IREPS/IC/<PO>/";
  const first = ((downloads && downloads.items) || []).find((i) => i.status === "completed" && i.downloadId !== null && i.downloadId !== undefined);
  icFolderDownloadId = first ? first.downloadId : null;
  el.btnIcShowFolder.hidden = icFolderDownloadId === null;
  el.btnIcRetry.hidden = !downloads || retryableIcFailures(downloads).length === 0;
  el.icResult.hidden = false;
}

function renderIcError(error, { live = true } = {}) {
  const described = asDescribedError(error);
  resetIcResults();
  setIcBusy(false);
  if (live) ctx.setConnectionForError(described);
  el.icErrorTitle.textContent = described.title;
  el.icErrorMessage.textContent = described.message;
  el.btnIcOpenIreps.hidden = described.connection !== "login";
  el.icError.classList.toggle("is-notice", described.notice === true);
  el.icError.hidden = false;
}

async function startIcDownload() {
  const poNo = getManualPoNumber();
  if (!poNo) {
    renderIcError(describeError("IREPS_INVALID_REQUEST", { detail: "Please enter a PO Number." }));
    return;
  }
  renderIcProgress("Searching issued ICs...");
  const response = await ctx.send(MESSAGE_TYPES.IC_DOWNLOAD, { poNo, destination: ctx.getDestination() });
  if (!response) renderIcError(describeError("NO_BACKGROUND_RESPONSE", { detail: "no reply to the IC download request" }));
  else if (response.started === false) renderIcError(response.error || describeError("IC_BUSY"));
}

/**
 * "Retry failed downloads": the IC run shown here, for its own PO, whatever the box holds now. The worker
 * fetches only that run's failed ICs again, without a new search (7.3).
 */
async function retryIcDownload() {
  renderIcProgress(`Retrying the failed downloads${icResultPo ? ` of PO ${icResultPo}` : ""}...`);
  const response = await ctx.send(MESSAGE_TYPES.IC_RETRY, { destination: ctx.getDestination() });
  if (!response) renderIcError(describeError("NO_BACKGROUND_RESPONSE", { detail: "no reply to the IC retry request" }));
  else if (response.started === false) renderIcError(response.error || describeError("IC_BUSY"));
}

/** The IC state when the view opens: this panel's own, and not an old "login required" (4.10). */
async function refreshIcState() {
  const state = await ctx.send(MESSAGE_TYPES.GET_IC_STATE);
  if (state && !isOwnRun(state.startedBy)) {
    noteBackground("ic", state.startedBy, state.status === "searching" || state.status === "downloading");
    return state;
  }
  if (!state || state.status === "idle" || staleLogin(state)) {
    resetIcResults();
    setIcBusy(false);
    return state;
  }
  if (state.poNumber && !el.poNumber.value) el.poNumber.value = state.poNumber;
  const old = { live: false };
  if (state.status === "searching") renderIcProgress(state.message, old);
  else if (state.status === "downloading") renderIcDownloading(state.message, state.downloads, old);
  else if (state.status === "complete") renderIcComplete(state.message, state.count, state.downloads, { ...old, warnings: state.warnings || [], error: state.error || null, poNumber: state.poNumber });
  else if (state.status === "error" && state.error) renderIcError(state.error, old);
  return state;
}

/* -------------------------------------------------------------------------- */
/* View lifecycle                                                             */
/* -------------------------------------------------------------------------- */

async function openView() {
  ctx.showView("po-ic");
  await Promise.all([refreshPoState(), refreshIcState()]);
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * @param {{ send: Function, showView: Function, setConnection: Function, setConnectionForError: Function }} context
 */
/** Reset the idle download buttons' labels (the labels name the file type only, whatever Save to says). */
export function refreshPoIcDestination() {
  if (!ctx) return;
  if (!el.btnPoDownload.classList.contains("is-busy")) setPoBusy(false);
  if (!el.btnIcDownload.classList.contains("is-busy")) setIcBusy(false);
}

export function initPoIc(context) {
  ctx = context;
  bindElements();
  el.btnOpen.addEventListener("click", openView);
  el.btnBack.addEventListener("click", () => ctx.showView("main"));
  el.btnPoDownload.addEventListener("click", startPoDownload);
  el.btnIcDownload.addEventListener("click", startIcDownload);
  el.btnPoOpenIreps.addEventListener("click", () => ctx.send(MESSAGE_TYPES.OPEN_IREPS));
  el.btnIcOpenIreps.addEventListener("click", () => ctx.send(MESSAGE_TYPES.OPEN_IREPS));
  el.btnPoShowFile.addEventListener("click", () => {
    if (poDownloadId !== null) chrome.downloads.show(poDownloadId);
  });
  el.btnIcShowFolder.addEventListener("click", () => {
    if (icFolderDownloadId !== null) chrome.downloads.show(icFolderDownloadId);
  });
  el.btnIcRetry.addEventListener("click", retryIcDownload);
}

/**
 * Route PO / IC broadcasts from the service worker. Returns true when handled. A download another tab's
 * panel started is only noted (its button waits): never shown in this view as this panel's.
 */
export function handlePoIcMessage(message) {
  const own = isOwnRun(message.startedBy);
  switch (message.type) {
    case MESSAGE_TYPES.PO_PROGRESS:
      if (!own) noteBackground("po", message.startedBy, true);
      else if (!el.view.hidden) renderPoProgress(message.message, { stage: message.stage });
      return true;
    case MESSAGE_TYPES.PO_DOWNLOAD_COMPLETE:
      if (!own) noteBackground("po", message.startedBy, false);
      else if (!el.view.hidden) renderPoComplete(message);
      return true;
    case MESSAGE_TYPES.PO_DOWNLOAD_ERROR:
      if (!own) noteBackground("po", message.startedBy, false);
      else if (!el.view.hidden) renderPoError(message);
      return true;
    case MESSAGE_TYPES.IC_PROGRESS:
      if (!own) noteBackground("ic", message.startedBy, true);
      else if (!el.view.hidden) {
        if (message.status === "downloading") renderIcDownloading(message.message, null);
        else renderIcProgress(message.message, { stage: message.stage });
      }
      return true;
    case MESSAGE_TYPES.IC_DOWNLOAD_PROGRESS:
      if (own && !el.view.hidden) renderIcDownloading("Downloading Inspection Certificates...", message.downloads);
      return true;
    case MESSAGE_TYPES.IC_DOWNLOAD_COMPLETE:
      if (!own) noteBackground("ic", message.startedBy, false);
      else if (!el.view.hidden) renderIcComplete(message.message, message.count, message.downloads, { warnings: message.warnings || [], error: message.error || null, poNumber: message.poNumber });
      return true;
    case MESSAGE_TYPES.IC_DOWNLOAD_ERROR:
      if (!own) noteBackground("ic", message.startedBy, false);
      else if (!el.view.hidden) renderIcError(message);
      return true;
    default:
      return false;
  }
}

/** Called once at popup start-up. Opens the PO/IC view when either job of this panel's is still running. */
export async function restorePoIc() {
  const [po, ic] = await Promise.all([ctx.send(MESSAGE_TYPES.GET_PO_STATE), ctx.send(MESSAGE_TYPES.GET_IC_STATE)]);
  const poRunning = po && po.status === "running" && isOwnRun(po.startedBy);
  const icRunning = ic && (ic.status === "searching" || ic.status === "downloading") && isOwnRun(ic.startedBy);
  if (!poRunning && !icRunning) return false;
  ctx.showView("po-ic");
  if (poRunning && po.poNumber) el.poNumber.value = po.poNumber;
  else if (icRunning && ic.poNumber) el.poNumber.value = ic.poNumber;
  if (poRunning) renderPoProgress(po.message, { stage: po.stage });
  if (icRunning) {
    if (ic.status === "downloading") renderIcDownloading(ic.message, ic.downloads);
    else renderIcProgress(ic.message, { stage: ic.stage });
  }
  return true;
}

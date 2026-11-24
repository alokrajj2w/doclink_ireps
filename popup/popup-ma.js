/**
 * Modification Advice (MA) copies view of the DocLink popup.
 *
 * Flow: pick an MA date (default today), a date range, or all of the last
 * 180 days -> Search MAs -> the matching MAs are listed with checkboxes ->
 * Download Selected / Download All fetches the actual MA PDFs from IREPS
 * (service worker, 3 at a time) into Downloads/DocLink/IREPS/MA/<date>/.
 *
 * The popup is a thin view over MA_SEARCH / MA_DOWNLOAD / GET_MA_STATE;
 * searching and downloading continue in the service worker when the popup
 * closes, and reopening restores the list and the per-MA status chips.
 *
 * Only this panel's own MA runs are shown here (popup-gate.js isOwnRun). A scheduled MA run, or an MA
 * search from another tab's panel, never replaces this panel's list or selection and never switches its
 * view: the panel only says that it runs, and its Search / Download buttons wait for it.
 */

import { MESSAGE_TYPES, MA_STAGES, describeError, asDescribedError } from "../utils/messages.js";
import { ECM_OUTCOME, describeEcmOutcome, summariseEcm } from "../services/ecm-service.js";
import { describeSkip, skipChipText } from "../services/download-log.js";
import { toIrepsDate, localIsoDate } from "../utils/dates.js";
import { fillSelect, noteBackgroundRun, backgroundRunText, irepsAnswered } from "./popup-common.js";
import { isOwnRun } from "./popup-gate.js";

const $ = (id) => document.getElementById(id);
const ALL_RAILWAYS = "-1";
const STATUS_LABEL = { queued: "Queued", downloading: "Downloading", completed: "Completed", failed: "Failed", skipped: "Skipped" };

let ctx = null;
let currentState = null;
/** Who holds the MA job when this panel did not start it (a scheduled run, another tab's), else null. */
let backgroundStarter = null;
const selected = new Set();
let renderedIds = [];
let itemNodes = new Map();
const el = {};

function bindElements() {
  Object.assign(el, {
    view: $("view-ma"),
    btnOpen: $("btn-ma-open"),
    btnBack: $("btn-ma-back"),
    form: $("ma-form"),
    dateModes: Array.from(document.querySelectorAll('input[name="ma-date-mode"]')),
    dateRow: $("ma-date-row"),
    rangeRow: $("ma-range-row"),
    date: $("ma-date"),
    dateFrom: $("ma-date-from"),
    dateTo: $("ma-date-to"),
    options: $("ma-options"),
    optionsSummary: $("ma-options-summary"),
    rly: $("ma-rly"),
    po: $("ma-po"),
    btnSearch: $("btn-ma-search"),
    btnSearchLabel: document.querySelector("#btn-ma-search .btn-label"),
    progress: $("ma-progress"),
    progressMessage: $("ma-progress-message"),
    error: $("ma-error"),
    errorTitle: $("ma-error-title"),
    errorMessage: $("ma-error-message"),
    btnOpenIreps: $("btn-ma-open-ireps"),
    btnRetryFailed: $("btn-ma-retry-failed"),
    results: $("ma-results"),
    resultsTitle: $("ma-results-title"),
    resultsFilter: $("ma-results-filter"),
    resultsWarning: $("ma-results-warning"),
    btnNewSearch: $("btn-ma-new-search"),
    selectAll: $("ma-select-all"),
    selectAllLabel: $("ma-select-all-label"),
    filter: $("ma-filter"),
    list: $("ma-list"),
    btnDownloadSelected: $("btn-ma-download-selected"),
    btnDownloadAll: $("btn-ma-download-all"),
    downloadSummary: $("ma-download-summary"),
    downloadTitle: $("ma-download-title"),
    downloadText: $("ma-download-text"),
    downloadFolder: $("ma-download-folder"),
    btnShowFolder: $("btn-ma-show-folder")
  });
}

/* -------------------------------------------------------------------------- */
/* Options                                                                    */
/* -------------------------------------------------------------------------- */

function dateMode() {
  const checked = el.dateModes.find((r) => r.checked);
  return checked ? checked.value : "date";
}

function collectOptions() {
  const mode = dateMode();
  const out = { dateMode: mode, railway: el.rly.value || ALL_RAILWAYS };
  const poNo = el.po.value.trim();
  if (poNo) out.poNo = poNo;
  if (mode === "date") out.date = toIrepsDate(el.date.value);
  if (mode === "dateRange") {
    out.dateFrom = toIrepsDate(el.dateFrom.value);
    out.dateTo = toIrepsDate(el.dateTo.value);
  }
  return out;
}

function describeOptions(options) {
  const rly = options.railway === ALL_RAILWAYS ? "All Railways" : el.rly.selectedOptions[0]?.textContent || options.railway;
  return options.poNo ? `${rly} · PO ${options.poNo}` : rly;
}

function syncDateRows() {
  const mode = dateMode();
  el.dateRow.hidden = mode !== "date";
  el.rangeRow.hidden = mode !== "dateRange";
  el.optionsSummary.textContent = describeOptions(collectOptions());
}

function populateRailways(railways) {
  if (fillSelect(el.rly, railways, ALL_RAILWAYS)) syncDateRows();
}

function setSearchBusy(busy, label) {
  el.btnSearch.disabled = busy || backgroundStarter !== null;
  el.btnSearch.classList.toggle("is-busy", busy);
  el.btnSearchLabel.textContent = label || "Search MAs";
}

/**
 * An MA job this panel did not start (a scheduled run, another tab's search) runs or ended: the panel says
 * so, and its Search / Download buttons wait for it. Its own MA list and selection are left as they are.
 */
function noteBackground(startedBy, running) {
  backgroundStarter = running ? startedBy : null;
  noteBackgroundRun("ma", running ? backgroundRunText("MA copies", startedBy) : null);
  if (!el.btnSearch.classList.contains("is-busy")) el.btnSearch.disabled = running;
  updateSelectionUi();
}

function hideError() {
  el.error.hidden = true;
  el.error.classList.remove("is-notice");
  el.btnOpenIreps.hidden = true;
}

function showError(described) {
  el.errorTitle.textContent = described.title;
  el.errorMessage.textContent = described.message;
  el.error.classList.toggle("is-notice", described.notice === true);
  el.btnOpenIreps.hidden = described.connection !== "login";
  el.error.hidden = false;
}

/** Failed items worth retrying (a row without an MA link never succeeds). */
function retryableFailures(downloads) {
  return ((downloads && downloads.items) || []).filter((i) => i.status === "failed" && !(i.error && i.error.code === "IREPS_MA_LINK_NOT_FOUND"));
}

function display(value) {
  return value === null || value === undefined || String(value).trim() === "" ? "-" : String(value);
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

function downloadsById(state) {
  const map = new Map();
  if (state && state.downloads && Array.isArray(state.downloads.items)) {
    for (const item of state.downloads.items) map.set(String(item.id), item);
  }
  return map;
}

function chipFor(item) {
  const chip = document.createElement("span");
  if (!item) {
    chip.className = "chip";
    chip.hidden = true;
    return chip;
  }
  chip.className = `chip chip-${item.status}`;
  chip.textContent = STATUS_LABEL[item.status] || item.status;
  if (item.status === "completed" && item.ecm) {
    chip.textContent = item.ecm.status === ECM_OUTCOME.FAILED ? "Saved locally" : "In ECM";
    chip.title = describeEcmOutcome(item.ecm);
  }
  if (item.status === "failed" && item.error) {
    const described = describeError(item.error.code, { status: item.error.status, detail: item.error.detail });
    chip.title = `${described.title}: ${described.message}`;
  }
  if (item.status === "skipped" && item.skip) {
    chip.textContent = skipChipText(item.skip);
    chip.title = describeSkip(item.skip);
  }
  return chip;
}

function strong(text) {
  const s = document.createElement("strong");
  s.textContent = text;
  return s;
}

function renderList(state) {
  const records = Array.isArray(state.records) ? state.records : [];
  const statuses = downloadsById(state);
  el.list.replaceChildren();
  itemNodes = new Map();
  renderedIds = records.map((r) => String(r.id));
  for (const id of Array.from(selected)) if (!renderedIds.includes(id)) selected.delete(id);

  if (records.length === 0) {
    const li = document.createElement("li");
    li.className = "doc-empty";
    li.textContent = "No MA records.";
    el.list.append(li);
    return;
  }
  const frag = document.createDocumentFragment();
  for (const record of records) {
    const id = String(record.id);
    const li = document.createElement("li");
    li.className = "doc-item";
    li.dataset.id = id;
    li.dataset.search = [record.maNo, record.poNo, record.railwayUnit, record.maDate, record.poDate].filter(Boolean).join(" ").toLowerCase();

    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = selected.has(id);
    check.disabled = !record.maPdfUrl;
    check.title = record.maPdfUrl ? "" : "IREPS did not provide a View/Download MA link for this row";
    check.addEventListener("change", () => {
      if (check.checked) selected.add(id);
      else selected.delete(id);
      updateSelectionUi();
    });

    const body = document.createElement("div");
    const no = document.createElement("div");
    no.className = "doc-no";
    no.textContent = `MA ${display(record.maNo)}`;
    const meta = document.createElement("div");
    meta.className = "doc-meta";
    const line1 = document.createElement("div");
    line1.append(strong("PO: "), document.createTextNode(display(record.poNo)), document.createTextNode(`  ·  Unit: ${display(record.railwayUnit)}`));
    const line2 = document.createElement("div");
    line2.append(strong("PO Date: "), document.createTextNode(display(record.poDate)), document.createTextNode(`  ·  MA Date: ${display(record.maDate)}`));
    meta.append(line1, line2);
    if (!record.maPdfUrl) {
      const warn = document.createElement("div");
      warn.textContent = "No MA copy link on IREPS";
      warn.style.color = "var(--danger)";
      meta.append(warn);
    }
    body.append(no, meta);
    const chip = chipFor(statuses.get(id) || null);
    li.append(check, body, chip);
    itemNodes.set(id, { li, check, chip });
    frag.append(li);
  }
  el.list.append(frag);
  applyFilter();
}

function updateStatuses(state) {
  const statuses = downloadsById(state);
  for (const [id, node] of itemNodes) {
    const chip = chipFor(statuses.get(id) || null);
    node.chip.replaceWith(chip);
    node.chip = chip;
  }
}

function visibleIds() {
  return renderedIds.filter((id) => {
    const node = itemNodes.get(id);
    return node && !node.li.classList.contains("is-hidden") && !node.check.disabled;
  });
}

function applyFilter() {
  const q = el.filter.value.trim().toLowerCase();
  let shown = 0;
  for (const [, node] of itemNodes) {
    const hit = !q || node.li.dataset.search.includes(q);
    node.li.classList.toggle("is-hidden", !hit);
    if (hit) shown++;
  }
  el.selectAllLabel.textContent = q ? `Select all shown (${shown})` : "Select all";
  updateSelectionUi();
}

function updateSelectionUi() {
  const n = selected.size;
  const busy = backgroundStarter !== null || Boolean(currentState && (currentState.status === "downloading" || currentState.status === "searching"));
  el.btnDownloadSelected.textContent = n ? `Download Selected (${n})` : "Download Selected";
  el.btnDownloadAll.textContent = "Download All";
  el.btnDownloadSelected.disabled = busy || n === 0;
  el.btnDownloadAll.disabled = busy || renderedIds.length === 0;
  // the worker keeps the list while an MA search or download runs (7.11)
  el.btnNewSearch.disabled = busy;
  const visible = visibleIds();
  el.selectAll.checked = visible.length > 0 && visible.every((id) => selected.has(id));
  el.selectAll.indeterminate = !el.selectAll.checked && visible.some((id) => selected.has(id));
}

function renderDownloads(state) {
  const d = state.downloads;
  if (!d) {
    el.downloadSummary.hidden = true;
    return;
  }
  const running = state.status === "downloading";
  el.downloadSummary.hidden = false;
  el.downloadSummary.classList.toggle("result-success", !running && d.failed === 0);
  el.downloadSummary.classList.toggle("result-error", !running && d.failed > 0);
  el.downloadSummary.classList.toggle("is-notice", !running && d.failed > 0 && d.completed > 0);
  if (running) {
    el.downloadTitle.textContent = `Downloading MA copies… ${d.completed + d.failed} of ${d.total}`;
    el.downloadText.textContent = `${d.downloading} downloading · ${d.queued} queued · ${d.completed} completed · ${d.failed} failed`;
  } else {
    // every selected MA was already there: nothing was downloaded, which is said as it is (1.17)
    const nothingNew = d.failed === 0 && d.completed === 0 && d.skipped > 0;
    el.downloadTitle.textContent = nothingNew ? "Nothing new to download" : d.failed === 0 ? `✓ ${d.completed} MA cop${d.completed === 1 ? "y" : "ies"} downloaded` : `${d.completed} downloaded, ${d.failed} failed`;
    const ecm = summariseEcm(d.items);
    const skipped = !d.skipped
      ? ""
      : nothingNew
        ? `All ${d.skipped} selected MA${d.skipped === 1 ? " was" : "s were"} already downloaded or already in the ECM (hover the chip for when / where).`
        : `${d.skipped} skipped: already downloaded or already in the ECM (hover the chip for when / where).`;
    const outcome = d.failed > 0 ? "Hover a Failed chip to see why. Failed MAs can be retried." : nothingNew ? "" : d.skipped ? "Every other selected MA PDF was saved." : "All selected MA PDFs were saved.";
    el.downloadText.textContent = [outcome, skipped, ecm, ...(d.warnings || [])].filter(Boolean).join("\n");
  }
  // only files saved on this computer (an MA stored in the ECM has no local copy)
  const local = (d.items || []).filter((i) => i.status === "completed" && i.path && (!i.ecm || i.ecm.status === ECM_OUTCOME.FAILED));
  const folders = new Set(local.map((i) => i.path.split("/").slice(0, -1).join("/")));
  el.downloadFolder.textContent = folders.size === 1 ? `Downloads/${Array.from(folders)[0]}/` : local.length ? "Downloads/DocLink/IREPS/MA/<MA date>/" : "";
  const first = (d.items || []).find((i) => i.status === "completed" && i.downloadId !== null && i.downloadId !== undefined);
  el.btnShowFolder.hidden = !first;
  el.btnShowFolder.dataset.downloadId = first ? String(first.downloadId) : "";
  el.btnRetryFailed.hidden = running || retryableFailures(d).length === 0;
}

/**
 * Render the whole MA state (from GET_MA_STATE or a broadcast). `live`: the state of a run that just moved
 * on. false for a state read when the view opens, which may be old: it never sets the IREPS indicator, and an
 * old "login required" error is not shown again (the form check that follows decides, 4.9, 4.10).
 * A list another tab's panel searched is not this panel's: it is neither shown nor downloaded from here.
 */
function render(state, { live = true } = {}) {
  const previousIds = renderedIds.join("|");
  hideError();
  el.progress.hidden = true;
  setSearchBusy(false);
  // an MA job this panel did not start holds the job now (a scheduled run, another tab's)
  const busyWith = state && state.busyWith != null && !isOwnRun(state.busyWith) ? state.busyWith : null;
  noteBackground(busyWith, busyWith !== null);
  const mine = state && isOwnRun(state.startedBy) ? state : null;
  currentState = mine;

  const staleLogin = !live && mine && mine.status === "error" && mine.error && mine.error.loginRequired;
  if (!mine || mine.status === "idle" || staleLogin) {
    el.results.hidden = true;
    el.downloadSummary.hidden = true;
    return;
  }
  if (mine.form && mine.form.railways) populateRailways(mine.form.railways);

  if (mine.status === "searching") {
    el.results.hidden = true;
    el.progress.hidden = false;
    el.progressMessage.textContent = mine.message || MA_STAGES.SEARCHING.label;
    setSearchBusy(true, mine.message || "Searching…");
    // "Connected" only once IREPS answered the search's session check (7.15)
    if (live && irepsAnswered(mine.stage)) ctx.setConnection("connected", "Connected");
    return;
  }
  if (mine.status === "error") {
    el.results.hidden = true;
    const described = mine.error || describeError("UNKNOWN");
    if (live) ctx.setConnectionForError(described);
    if (described.loginRequired) {
      ctx.showLogin(described);
      return;
    }
    showError(described);
    return;
  }

  // ready / downloading / complete; the indicator says what the run found: an expired session as such (1.18).
  // A download still running has not told yet (7.15)
  if (live && mine.status !== "downloading") {
    if (mine.error) ctx.setConnectionForError(mine.error);
    else ctx.setConnection("connected", "Connected");
  }
  el.results.hidden = false;
  const n = mine.recordCount || (mine.records || []).length;
  const total = mine.allRecordCount && mine.allRecordCount !== n ? ` of ${mine.allRecordCount}` : "";
  el.resultsTitle.textContent = `MA Results (${n}${total})`;
  const pages = mine.pagination && mine.pagination.pagesFetched > 1 ? ` · ${mine.pagination.pagesFetched} result pages` : "";
  el.resultsFilter.textContent = `${mine.filter || ""}${pages}`;
  // fewer MAs read than IREPS listed: said over the list, never a silent short list (1.1)
  el.resultsWarning.textContent = mine.incomplete ? `${mine.incomplete}; some MAs may be missing from this list.` : "";
  el.resultsWarning.hidden = !mine.incomplete;
  renderLoaded(mine, previousIds);
}

/** The list, its chips and the download summary of a loaded MA state. */
function renderLoaded(state, previousIds) {
  const ids = (state.records || []).map((r) => String(r.id)).join("|");
  if (ids !== previousIds || itemNodes.size === 0) renderList(state);
  else updateStatuses(state);
  renderDownloads(state);
  if (state.status === "downloading") setSearchBusy(true, "Downloading…");
  if (state.error) showError(state.error);
  updateSelectionUi();
}

/* -------------------------------------------------------------------------- */
/* Actions                                                                    */
/* -------------------------------------------------------------------------- */

/** `live`: the state follows a run's own end (false when the view opens: the state may be old). */
async function refreshState({ live = true } = {}) {
  const state = await ctx.send(MESSAGE_TYPES.GET_MA_STATE);
  render(state, { live });
  return state;
}

async function loadForm(force = false) {
  const info = await ctx.send(MESSAGE_TYPES.SEARCH_PO_LOAD_FORM, { force });
  if (!info) {
    ctx.setConnection("offline", "Unavailable");
    return null;
  }
  if (info.authenticated) {
    ctx.setConnection("connected", "Connected");
    if (info.form && info.form.railways) populateRailways(info.form.railways);
  } else {
    const described = describeError(info.code || "UNKNOWN", { status: info.status, detail: info.detail });
    ctx.setConnectionForError(described);
    if (described.loginRequired) ctx.showLogin(described);
    else showError(described);
  }
  return info;
}

async function openView() {
  ctx.showView("ma");
  if (!el.date.value) el.date.value = localIsoDate();
  syncDateRows();
  // the state may be old: an old "login required" never locks the view; the live form check decides (4.9)
  const state = await refreshState({ live: false });
  if (!state || state.status === "idle" || state.status === "error" || !isOwnRun(state.startedBy)) await loadForm(false);
}

async function startSearch(event) {
  if (event) event.preventDefault();
  const options = collectOptions();
  if (options.dateMode === "date" && !options.date) {
    showError(describeError("IREPS_INVALID_REQUEST", { detail: "Please choose the MA date." }));
    return;
  }
  if (options.dateMode === "dateRange" && (!options.dateFrom || !options.dateTo)) {
    showError(describeError("IREPS_INVALID_REQUEST", { detail: "Please choose both From and To dates." }));
    return;
  }
  hideError();
  selected.clear();
  el.filter.value = "";
  el.options.open = false;
  el.results.hidden = true;
  el.downloadSummary.hidden = true;
  el.progress.hidden = false;
  el.progressMessage.textContent = MA_STAGES.CHECKING_SESSION.label;
  setSearchBusy(true, "Searching…");
  const response = await ctx.send(MESSAGE_TYPES.MA_SEARCH, { options });
  if (!response) render({ status: "error", error: describeError("NO_BACKGROUND_RESPONSE", { detail: "no reply to the MA search request" }) });
  else if (response.started === false) render({ status: "error", error: response.error || describeError("MA_BUSY") });
}

async function startDownload(ids) {
  hideError();
  const response = await ctx.send(MESSAGE_TYPES.MA_DOWNLOAD, { ids, destination: ctx.getDestination() });
  if (!response) showError(describeError("NO_BACKGROUND_RESPONSE", { detail: "no reply to the MA download request" }));
  else if (response.started === false) showError(response.error || describeError("MA_BUSY"));
  else {
    el.btnDownloadSelected.disabled = true;
    el.btnDownloadAll.disabled = true;
    el.btnNewSearch.disabled = true;
  }
}

function retryFailed() {
  if (!currentState || !currentState.downloads) return;
  const ids = retryableFailures(currentState.downloads).map((i) => String(i.id));
  if (ids.length) startDownload(ids);
}

/** "New search": the worker forgets the list, unless an MA search or download runs; then the panel keeps it too and says why (7.11). */
async function newSearch() {
  const response = await ctx.send(MESSAGE_TYPES.MA_RESET);
  if (!response || response.ok === false) {
    showError(response ? asDescribedError(response.error, "MA_BUSY") : describeError("NO_BACKGROUND_RESPONSE", { detail: "no reply to the New search request" }));
    return;
  }
  selected.clear();
  render({ status: "idle" });
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/** Save to changed: refresh the download buttons (their labels do not name the destination). */
export function refreshMaDestination() {
  if (ctx) updateSelectionUi();
}

export function initMa(context) {
  ctx = context;
  bindElements();
  el.date.value = localIsoDate();
  el.btnOpen.addEventListener("click", openView);
  el.btnBack.addEventListener("click", () => ctx.showView("main"));
  el.form.addEventListener("submit", startSearch);
  for (const radio of el.dateModes) radio.addEventListener("change", syncDateRows);
  el.rly.addEventListener("change", syncDateRows);
  el.po.addEventListener("input", syncDateRows);
  el.filter.addEventListener("input", applyFilter);
  el.selectAll.addEventListener("change", () => {
    const ids = visibleIds();
    if (el.selectAll.checked) ids.forEach((id) => selected.add(id));
    else ids.forEach((id) => selected.delete(id));
    for (const id of ids) {
      const node = itemNodes.get(id);
      if (node) node.check.checked = selected.has(id);
    }
    updateSelectionUi();
  });
  el.btnDownloadSelected.addEventListener("click", () => startDownload(Array.from(selected)));
  el.btnDownloadAll.addEventListener("click", () => startDownload("all"));
  el.btnRetryFailed.addEventListener("click", retryFailed);
  el.btnNewSearch.addEventListener("click", newSearch);
  el.btnOpenIreps.addEventListener("click", () => ctx.send(MESSAGE_TYPES.OPEN_IREPS));
  el.btnShowFolder.addEventListener("click", () => {
    const id = Number(el.btnShowFolder.dataset.downloadId);
    if (Number.isFinite(id)) chrome.downloads.show(id);
  });
  syncDateRows();
}

/**
 * Route MA broadcasts from the service worker. Returns true when handled. A run this panel did not start
 * (a scheduled run, another tab's search) is only noted: this panel's list, selection and view stay.
 */
export function handleMaMessage(message) {
  const own = isOwnRun(message.startedBy);
  switch (message.type) {
    case MESSAGE_TYPES.MA_PROGRESS:
      if (!own) noteBackground(message.startedBy, true);
      else if (!el.view.hidden) {
        if (message.status === "downloading") {
          if (currentState) currentState.status = "downloading";
          setSearchBusy(true, "Downloading…");
          updateSelectionUi();
        } else {
          el.results.hidden = true;
          el.progress.hidden = false;
          el.progressMessage.textContent = message.message || "";
          setSearchBusy(true, message.message || "Searching…");
          // "Connected" only once IREPS answered the search's session check; a download says so when it ends (7.15)
          if (irepsAnswered(message.stage)) ctx.setConnection("connected", "Connected");
        }
      }
      return true;
    case MESSAGE_TYPES.MA_SEARCH_COMPLETE:
      if (!own) {
        noteBackground(message.startedBy, false);
        return true;
      }
      selected.clear();
      if (!el.view.hidden) render(message);
      else currentState = message;
      return true;
    case MESSAGE_TYPES.MA_DOWNLOAD_PROGRESS:
      if (own && currentState) {
        currentState = { ...currentState, status: "downloading", downloads: message.downloads };
        if (!el.view.hidden) {
          updateStatuses(currentState);
          renderDownloads(currentState);
          updateSelectionUi();
        }
      }
      return true;
    case MESSAGE_TYPES.MA_DOWNLOAD_COMPLETE:
    case MESSAGE_TYPES.MA_ERROR:
      if (!own) noteBackground(message.startedBy, false);
      else if (!el.view.hidden) refreshState();
      return true;
    default:
      return false;
  }
}

/** Called once at popup start-up. Opens the MA view when an MA job of this panel's is running. */
export async function restoreMa() {
  const state = await ctx.send(MESSAGE_TYPES.GET_MA_STATE);
  if (!state || state.status === "idle") return false;
  // a run this panel did not start never opens the MA view here
  if (!isOwnRun(state.startedBy)) return false;
  if (state.status === "searching" || state.status === "downloading") {
    ctx.showView("ma");
    if (!el.date.value) el.date.value = localIsoDate();
    syncDateRows();
    render(state);
    return true;
  }
  return false;
}

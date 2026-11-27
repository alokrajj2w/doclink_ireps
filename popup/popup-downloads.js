/**
 * "My downloads": what the download log (services/download-log.js) holds for the signed-in
 * Recon user - every file DocLink saved, newest first, with its date and time (IST), type,
 * file name and where it went (Local, ECM with its folder path, or S3). Read from
 * GET {reconBaseUrl}/api/doclink/downloads; an admin may switch to everyone's downloads.
 *
 * A table: date, document type, file (with the user under it when an admin shows everyone's), location.
 * It opens on the last 3 days that had downloads (DAYS_SHOWN; on a Monday also Friday and Thursday), in a Day dropdown
 * with each day's count, found by asking the log for each day back from today (DAYS_LOOKED at most); "Other dates" gives a
 * From - To range instead. Filters: location (Local, ECM - all sites or one
 * site, S3) and document type; 50 rows at a time with "Load more". Nothing is stored here.
 */

import { describeError } from "../utils/messages.js";
import { listDownloads, DOC_TYPE_LABEL, LOG_DESTINATION } from "../services/download-log.js";
import { logger } from "../utils/logger.js";
import { localIsoDate } from "../utils/dates.js";
import { dayLabel } from "../services/scheduler/run-log.js";
import { buildWorkbook, XLSX_MIME_TYPE } from "../utils/xlsx-writer.js";
import { saveFile, fillDaySelect } from "./popup-common.js";

const $ = (id) => document.getElementById(id);
const PAGE = 50;
const DAY = 86400000;
/** The days with downloads offered as buttons, and how many days back they are looked for. */
const DAYS_SHOWN = 3;
const DAYS_LOOKED = 14;
/** `picked` for a From - To range ("Other dates"). */
const RANGE = "range";
/** Download Excel reads the selection page by page (as the table does), this many rows at most. */
const MAX_EXPORT_ROWS = 5000;

let el = null;
let ctx = null;
let shown = 0;
let loading = false;
/** Counts the first-page loads (each filter change, Refresh, opening the view): a page read for older filters is never shown (7.9). */
let generation = 0;
/** The last days with downloads for the filters, newest first: [{ day: "2026-11-30", count }]. */
let days = [];
/** The day shown ("2026-11-30"), RANGE for the From - To inputs, null before the days are known. */
let picked = null;

const siteName = (site) => (site ? `${site.charAt(0).toUpperCase()}${site.slice(1)}` : "");

/** "2026-10-23" -> "23/10/2026", as IREPS writes dates. */
const dmy = (iso) => String(iso || "").split("-").reverse().join("/");

/** "ecm:hosur" (the Location filter) -> { destination: "ecm", site: "hosur" }. */
function locationFilter(value) {
  const [destination, site] = String(value || "").split(":");
  return { destination: destination || undefined, site: site || undefined };
}

function destinationChip(d) {
  const chip = document.createElement("span");
  chip.className = `chip chip-dest chip-dest-${d.destination}`;
  if (d.destination === LOG_DESTINATION.ECM) {
    const ecm = d.ecm || {};
    chip.textContent = ecm.site ? `ECM · ${siteName(ecm.site)}` : "ECM";
    chip.title = [ecm.status === "already_stored" ? "Already in the ECM (not stored twice)" : "Saved to the ECM", ecm.path, ecm.uid ? `uid ${ecm.uid}` : ""].filter(Boolean).join("\n");
  } else if (d.destination === LOG_DESTINATION.S3) {
    chip.textContent = "S3";
    chip.title = "Saved to Recon Engine storage (S3)";
  } else {
    chip.textContent = "Local";
    chip.title = "Saved to Downloads on this computer";
  }
  return chip;
}

function cell(...children) {
  const td = document.createElement("td");
  td.append(...children);
  return td;
}

function textDiv(text, className) {
  const div = document.createElement("div");
  if (className) div.className = className;
  div.textContent = text;
  return div;
}

/** One table row: date / time, document type, file (IREPS account; the user when showing everyone's), location (ECM folder). */
function row(d, allUsers) {
  const tr = document.createElement("tr");
  const location = cell(destinationChip(d));
  if (d.destination === LOG_DESTINATION.ECM && d.ecm) {
    if (d.ecm.status === "already_stored") location.append(textDiv("already there", "downloads-muted"));
    // the folder only (e.g. "Inputs"); the full path is in the cell's tooltip
    const folder = d.ecm.path ? d.ecm.path.split("/").slice(-2, -1)[0] : "";
    if (folder) location.append(textDiv(`in ${folder}`, "downloads-path"));
    if (d.ecm.path) location.title = d.ecm.path;
  }
  tr.append(
    cell(textDiv(dmy(d.date), "downloads-date"), textDiv(String(d.time || "").slice(0, 5), "downloads-muted")),
    cell(DOC_TYPE_LABEL[d.doc_type] || d.doc_type),
    cell(
      textDiv(d.filename, "downloads-file"),
      ...(d.ireps_account_id ? [textDiv(`IREPS ${d.ireps_account_id}`, "downloads-muted")] : []),
      ...(allUsers ? [textDiv(d.user_email || d.user_name || `user ${d.user_id}`, "downloads-user")] : [])
    ),
    location
  );
  return tr;
}

function filters() {
  const range = !picked || picked === RANGE;
  return {
    from: range ? el.from.value || undefined : picked,
    to: range ? el.to.value || undefined : picked,
    ...locationFilter(el.destination.value),
    docType: el.docType.value || undefined,
    all: !el.allWrap.hidden && el.all.checked
  };
}

function showError(described) {
  el.error.hidden = false;
  el.errorTitle.textContent = described.title;
  el.errorMessage.textContent = described.message;
  el.btnSignIn.hidden = !described.reconSignIn;
}

function errorFor(error) {
  const code = error && error.code;
  if (code === "RECON_AUTH_REQUIRED") return describeError("RECON_AUTH_REQUIRED");
  if (code === "RECON_NOT_CONFIGURED") return describeError("RECON_NOT_CONFIGURED", { detail: error.detail });
  if (code === "FORBIDDEN") return { title: "Admins only", message: "Only an admin may see other users' downloads." };
  return describeError("DOWNLOAD_LOG_LIST_UNAVAILABLE", { detail: (error && error.detail) || (error && error.status ? `HTTP ${error.status}` : "no answer") });
}

/**
 * Load the first page (reset) or the next one. A first-page load always runs, also while a page is being
 * read: the filters may have changed meanwhile, and the page read for the older filters is then dropped
 * (7.9). "Load more" waits for the page being read (its button is disabled meanwhile).
 */
async function load({ reset = true } = {}) {
  if (!reset && loading) return;
  if (reset) generation++;
  const mine = generation;
  const current = () => mine === generation;
  loading = true;
  el.error.hidden = true;
  el.btnRefresh.disabled = true;
  el.btnMore.disabled = true;
  const f = filters();
  if (reset) {
    shown = 0;
    el.list.replaceChildren();
    el.summary.textContent = "Loading…";
    el.tableWrap.hidden = true;
  }
  try {
    const page = await listDownloads({ ...f, limit: PAGE, offset: shown });
    if (!current()) return;
    el.list.append(...page.downloads.map((d) => row(d, f.all)));
    shown += page.downloads.length;
    el.tableWrap.hidden = shown === 0;
    el.exportRow.hidden = shown === 0;
    el.btnMore.hidden = page.downloads.length < PAGE;
    const when = picked && picked !== RANGE ? ` on ${dayLabel(picked)}` : "";
    el.summary.textContent = shown
      ? `${shown} download${shown === 1 ? "" : "s"}${when}${page.downloads.length < PAGE ? "" : " so far"}${f.all ? " by all users" : ""}, newest first.`
      : `No downloads${f.all ? "" : " by you"} ${when ? when.trim() : "in this range"}.`;
  } catch (error) {
    if (!current()) return;
    logger.warn("Could not read the download log", { code: error && error.code, status: error && error.status });
    el.summary.textContent = "";
    el.btnMore.hidden = true;
    showError(errorFor(error));
  } finally {
    if (current()) {
      loading = false;
      el.btnRefresh.disabled = false;
      el.btnMore.disabled = false;
    }
  }
}

/**
 * Every download of `f` (the day shown or the From - To range, with the filters), newest first, read page by page as
 * the table reads them; MAX_EXPORT_ROWS at most -> { rows, cut } (cut: there were more).
 * @param {object} f   filters()
 */
export async function allDownloads(f) {
  const rows = [];
  let total = 0;
  for (let offset = 0; rows.length < MAX_EXPORT_ROWS; offset += PAGE) {
    const page = await listDownloads({ ...f, limit: PAGE, offset });
    rows.push(...page.downloads);
    total = Math.max(total, page.count);
    // a short page is the last; so is the page that reaches the count the log gave (exactly MAX_EXPORT_ROWS is no cut)
    if (page.downloads.length < PAGE || (page.count > 0 && rows.length >= page.count)) return { rows, cut: false };
  }
  return { rows: rows.slice(0, MAX_EXPORT_ROWS), cut: !(total > 0 && total <= MAX_EXPORT_ROWS) };
}

const LOCATION_TEXT = { [LOG_DESTINATION.ECM]: "ECM", [LOG_DESTINATION.S3]: "S3" };

/**
 * The downloads as a spreadsheet sheet (Download Excel), each cell text as the log gives it: date, time, type, file,
 * IREPS account, where it went (and the ECM site and folder), and the user when an admin shows everyone's.
 * @param {object[]} records   GET /api/doclink/downloads rows
 * @param {boolean} [allUsers]
 */
export function savedFilesSheet(records, allUsers = false) {
  const headers = ["Date", "Time", "Type", "File", "IREPS account", "Location", "ECM site", "ECM folder", "Note", ...(allUsers ? ["User"] : [])];
  const rows = (records || []).map((d) => {
    const ecm = d.destination === LOG_DESTINATION.ECM && d.ecm ? d.ecm : {};
    return [
      dmy(d.date), String(d.time || "").slice(0, 8), DOC_TYPE_LABEL[d.doc_type] || d.doc_type || "", d.filename || "", d.ireps_account_id || "",
      LOCATION_TEXT[d.destination] || "Local", siteName(ecm.site), ecm.path || "", ecm.status === "already_stored" ? "already in the ECM, not stored twice" : "",
      ...(allUsers ? [d.user_email || d.user_name || (d.user_id ? `user ${d.user_id}` : "")] : [])
    ];
  });
  return { name: "Saved files", headers, rows };
}

const EXCEL_LABEL = "Download Excel";
let excelTimer = null;

/**
 * Download Excel: the selection shown, every page of it, as DocLink_saved_files_<day or range>.xlsx in Downloads; the
 * button says how many rows went in for a few seconds. A log that does not answer is said as the list says it.
 */
async function saveExcel() {
  clearTimeout(excelTimer);
  el.btnExcel.disabled = true;
  el.btnExcel.textContent = "Preparing…";
  el.error.hidden = true;
  let said = EXCEL_LABEL;
  try {
    const f = filters();
    const { rows, cut } = await allDownloads(f);
    const span = f.from && f.to ? (f.from === f.to ? f.from : `${f.from}_to_${f.to}`) : "all";
    saveFile(buildWorkbook({ sheets: [savedFilesSheet(rows, f.all)] }), `DocLink_saved_files_${span}.xlsx`, XLSX_MIME_TYPE);
    said = cut ? `Saved the first ${MAX_EXPORT_ROWS} rows: pick fewer dates for the rest` : `Saved ${rows.length} row${rows.length === 1 ? "" : "s"}`;
  } catch (error) {
    logger.warn("Downloads not saved as Excel", { code: error && error.code, status: error && error.status });
    showError(errorFor(error));
  } finally {
    el.btnExcel.disabled = false;
    el.btnExcel.textContent = said;
    if (said !== EXCEL_LABEL) excelTimer = setTimeout(() => (el.btnExcel.textContent = EXCEL_LABEL), 4000);
  }
}

/**
 * The last DAYS_SHOWN days that had downloads for the filters (location, type, all users), newest first, each with
 * its count: one request per day back from today, DAYS_LOOKED days at most, each asking for one row (its `count`).
 * null when newer filters took over meanwhile (`current`).
 */
async function findDays(f, current) {
  const found = [];
  for (let back = 0; back < DAYS_LOOKED && found.length < DAYS_SHOWN; back++) {
    const day = localIsoDate(new Date(Date.now() - back * DAY));
    const page = await listDownloads({ ...f, from: day, to: day, limit: 1 });
    if (!current()) return null;
    if (page.count > 0) found.push({ day, count: page.count });
  }
  return found;
}

/** The Day dropdown: each day with downloads ("Mon 30/11/2026 · 21 downloads"), then "Other dates" (the From - To inputs). */
function renderDays() {
  const choices = days.map((d) => ({ value: d.day, text: `${dayLabel(d.day)} · ${d.count} download${d.count === 1 ? "" : "s"}` }));
  fillDaySelect(el.days, [...choices, { value: RANGE, text: "Other dates" }], picked, `Only the last ${DAYS_SHOWN} days with downloads are listed here.`);
  el.dayField.hidden = false;
  el.range.hidden = picked !== RANGE;
}

/** Show a day (its downloads) or RANGE (the From - To inputs, starting on the days offered). */
function pick(value) {
  if (value === RANGE && picked !== RANGE && days.length) {
    el.from.value = days[days.length - 1].day;
    el.to.value = localIsoDate(new Date());
  }
  picked = value;
  renderDays();
  load();
}

/**
 * Find the days with downloads again (opening the view, a filter changed, Refresh), keep the day shown while it is
 * still one of them (else the newest; the From - To range when no day had downloads), then load its first page.
 */
async function refresh() {
  const mine = ++generation;
  const current = () => mine === generation;
  el.error.hidden = true;
  el.btnRefresh.disabled = true;
  el.summary.textContent = "Loading…";
  el.list.replaceChildren();
  el.tableWrap.hidden = true;
  el.btnMore.hidden = true;
  let found;
  try {
    found = await findDays({ ...filters(), from: undefined, to: undefined }, current);
  } catch (error) {
    if (!current()) return;
    logger.warn("Could not read the download log", { code: error && error.code, status: error && error.status });
    el.summary.textContent = "";
    el.btnRefresh.disabled = false;
    showError(errorFor(error));
    return;
  }
  if (!found) return;
  days = found;
  if (picked !== RANGE && !days.some((d) => d.day === picked)) picked = days.length ? days[0].day : RANGE;
  renderDays();
  await load();
}

/**
 * Open the view: the Recon sign-in first (the log is per user), then the first page. A Recon Engine that
 * cannot be reached is said as such, never as a missing sign-in (4.11).
 */
async function open() {
  ctx.showView("downloads");
  const signedIn = await ctx.ensureSignedIn();
  const user = ctx.currentUser();
  el.allWrap.hidden = !(user && user.isAdmin);
  el.who.textContent = user ? `Signed in as ${user.name || user.email}${user.email && user.name && user.name !== user.email ? ` (${user.email})` : ""}` : "";
  if (!signedIn) {
    el.list.replaceChildren();
    el.summary.textContent = "";
    showError(ctx.reconUnreachable && ctx.reconUnreachable() ? describeError("DOWNLOAD_LOG_LIST_UNAVAILABLE", { detail: "it did not answer" }) : describeError("RECON_AUTH_REQUIRED"));
    return;
  }
  // the view opens on the newest day with downloads; a day picked (or Other dates) stays only while it is open
  picked = null;
  await refresh();
}

/**
 * @param {{ showView: (name: string) => void, ensureSignedIn: () => Promise<boolean>,
 *           currentUser: () => object|null, openSignIn: () => Promise<void>, reconUnreachable?: () => boolean }} context
 *        reconUnreachable: whether the last Recon check could not reach it at all (popup-recon-auth.js)
 */
export function initDownloads(context) {
  ctx = context;
  el = {
    view: $("view-downloads"),
    btnOpen: $("btn-downloads-open"),
    btnBack: $("btn-downloads-back"),
    who: $("downloads-who"),
    from: $("downloads-from"),
    to: $("downloads-to"),
    destination: $("downloads-destination"),
    docType: $("downloads-type"),
    allWrap: $("downloads-all-wrap"),
    all: $("downloads-all"),
    btnRefresh: $("btn-downloads-refresh"),
    summary: $("downloads-summary"),
    list: $("downloads-list"),
    tableWrap: $("downloads-table-wrap"),
    btnMore: $("btn-downloads-more"),
    error: $("downloads-error"),
    errorTitle: $("downloads-error-title"),
    errorMessage: $("downloads-error-message"),
    btnSignIn: $("btn-downloads-sign-in"),
    days: $("downloads-days"),
    dayField: $("downloads-day-field"),
    range: $("downloads-range"),
    exportRow: $("downloads-export"),
    btnExcel: $("btn-downloads-excel")
  };
  const today = new Date();
  el.to.value = localIsoDate(today);
  // the last 3 days, today included (the client asked for 3 days of history, 26 Nov 2026)
  el.from.value = localIsoDate(new Date(today.getTime() - 2 * DAY));
  el.docType.append(
    ...Object.entries(DOC_TYPE_LABEL).map(([value, label]) => {
      const o = document.createElement("option");
      o.value = value;
      o.textContent = label;
      return o;
    })
  );
  // the header icon opens the view, and closes it again when it is open
  el.btnOpen.addEventListener("click", () => (el.view.hidden ? open() : ctx.showView("main")));
  el.btnBack.addEventListener("click", () => ctx.showView("main"));
  el.btnRefresh.addEventListener("click", () => refresh());
  el.btnExcel.addEventListener("click", () => saveExcel());
  el.days.addEventListener("change", () => pick(el.days.value));
  el.btnMore.addEventListener("click", () => load({ reset: false }));
  // the days with downloads depend on the filters; a From - To change shows that range
  for (const input of [el.destination, el.docType, el.all]) input.addEventListener("change", () => refresh());
  for (const input of [el.from, el.to]) input.addEventListener("change", () => {
    picked = RANGE;
    renderDays();
    load();
  });
  el.btnSignIn.addEventListener("click", async () => {
    await ctx.openSignIn();
    if (ctx.currentUser()) open();
  });
}

/**
 * "My downloads": what the download log (services/download-log.js) holds for the signed-in
 * Recon user - every file DocLink saved, newest first, with its date and time (IST), type,
 * file name and where it went (Local, ECM with its folder path, or S3). Read from
 * GET {reconBaseUrl}/api/doclink/downloads; an admin may switch to everyone's downloads.
 *
 * A table: date, document type, file (with the user under it when an admin shows everyone's), location.
 * Filters: a date range (the last 7 days by default), location (Local, ECM - all sites or one
 * site, S3) and document type; 50 rows at a time with "Load more". Nothing is stored here.
 */

import { describeError } from "../utils/messages.js";
import { listDownloads, DOC_TYPE_LABEL, LOG_DESTINATION } from "../services/download-log.js";
import { logger } from "../utils/logger.js";

const $ = (id) => document.getElementById(id);
const PAGE = 50;
const DAY = 86400000;

let el = null;
let ctx = null;
let shown = 0;
let loading = false;

/** The browser's local day (IST for DocLink's users), YYYY-MM-DD. */
function day(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

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
  return {
    from: el.from.value || undefined,
    to: el.to.value || undefined,
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
  return { title: "Download log unavailable", message: `DocLink could not read the download log from the Recon Engine${error && error.detail ? ` (${error.detail})` : ""}. Try again.` };
}

/** Load the first page (reset) or the next one. */
async function load({ reset = true } = {}) {
  if (loading) return;
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
    el.list.append(...page.downloads.map((d) => row(d, f.all)));
    shown += page.downloads.length;
    el.tableWrap.hidden = shown === 0;
    el.btnMore.hidden = page.downloads.length < PAGE;
    el.summary.textContent = shown
      ? `${shown} download${shown === 1 ? "" : "s"}${page.downloads.length < PAGE ? "" : " so far"}${f.all ? " by all users" : ""}, newest first.`
      : `No downloads${f.all ? "" : " by you"} in this range.`;
  } catch (error) {
    logger.warn("Could not read the download log", { code: error && error.code, status: error && error.status });
    el.summary.textContent = "";
    el.btnMore.hidden = true;
    showError(errorFor(error));
  } finally {
    loading = false;
    el.btnRefresh.disabled = false;
    el.btnMore.disabled = false;
  }
}

/** Open the view: the Recon sign-in first (the log is per user), then the first page. */
async function open() {
  ctx.showView("downloads");
  const signedIn = await ctx.ensureSignedIn();
  const user = ctx.currentUser();
  el.allWrap.hidden = !(user && user.isAdmin);
  el.who.textContent = user ? `Signed in as ${user.name || user.email}${user.email && user.name && user.name !== user.email ? ` (${user.email})` : ""}` : "";
  if (!signedIn) {
    el.list.replaceChildren();
    el.summary.textContent = "";
    showError(describeError("RECON_AUTH_REQUIRED"));
    return;
  }
  await load();
}

/**
 * @param {{ showView: (name: string) => void, ensureSignedIn: () => Promise<boolean>,
 *           currentUser: () => object|null, openSignIn: () => Promise<void> }} context
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
    btnSignIn: $("btn-downloads-sign-in")
  };
  const today = new Date();
  el.to.value = day(today);
  el.from.value = day(new Date(today.getTime() - 6 * DAY));
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
  el.btnRefresh.addEventListener("click", () => load());
  el.btnMore.addEventListener("click", () => load({ reset: false }));
  for (const input of [el.from, el.to, el.destination, el.docType, el.all]) input.addEventListener("change", () => load());
  el.btnSignIn.addEventListener("click", async () => {
    await ctx.openSignIn();
    if (ctx.currentUser()) open();
  });
}

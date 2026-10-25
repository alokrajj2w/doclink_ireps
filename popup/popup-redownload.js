/**
 * "Already downloaded - download again?": the panel's answer to a run's check of what the
 * signed-in user already downloaded, or what is already in the ECM (services/download-log.js
 * preflightDownloads). The page covers the panel like the Recon sign-in page; the user ticks
 * the files to download again (none by default) and the run carries on with the rest.
 *
 * Asked by the service worker (MA, PO, IC and the batches: MESSAGE_TYPES.CONFIRM_REDOWNLOAD,
 * answered only by the panel of the tab that started the run) and by the tender view in
 * this panel (REDOWNLOAD_EVENT). Questions come one at a time; a question left unanswered
 * for 4 minutes counts as "skip them", as the service worker does.
 */

import { MESSAGE_TYPES, TARGETS } from "../utils/messages.js";
import { REDOWNLOAD_EVENT } from "../services/download-log.js";
import { logger } from "../utils/logger.js";

const $ = (id) => document.getElementById(id);
const ANSWER_TIMEOUT_MS = 4 * 60 * 1000 - 5000; // just inside the service worker's wait

let el = null;
let currentTabId = async () => null;
/** Questions wait their turn: the page shows one at a time. */
let turn = Promise.resolve();
/** The question on screen: { resolve, timer } */
let open = null;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const destinationText = (d) => (d === "ecm" ? "ECM" : d === "s3" ? "Recon Engine storage (S3)" : "your Downloads folder");

function rows(question) {
  const byId = new Map();
  for (const a of question.alreadyDownloaded || []) byId.set(a.id, { id: a.id, label: a.label, downloaded: a });
  for (const e of question.inEcm || []) byId.set(e.id, { ...(byId.get(e.id) || { id: e.id, label: e.label }), ecm: e });
  return [...byId.values()];
}

function detailText(row) {
  const parts = [];
  if (row.downloaded) {
    const d = row.downloaded;
    parts.push(`Downloaded${d.date ? ` on ${d.date}${d.time ? ` at ${d.time.slice(0, 5)}` : ""}` : ""}${d.count > 1 ? ` (${d.count} times)` : ""}${d.filename ? ` as ${d.filename}` : ""}`);
  }
  if (row.ecm) parts.push(`In ECM${row.ecm.path ? `: ${row.ecm.path}` : ""}`);
  return parts.join(" · ");
}

function render(question) {
  const list = rows(question);
  const done = (question.alreadyDownloaded || []).length;
  const inEcm = (question.inEcm || []).length;
  const lines = [];
  if (done) lines.push(`${plural(done, "file was", "files were")} already downloaded by you to ${destinationText(question.destination)}.`);
  if (inEcm) lines.push(`${plural(inEcm, "file is", "files are")} already in the ECM folder they would go to.`);
  el.summary.textContent = `${lines.join(" ")} Tick the ones to download again; the others are skipped.`;
  el.list.replaceChildren(
    ...list.map((row) => {
      const li = document.createElement("li");
      li.className = "redownload-item";
      const label = document.createElement("label");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.value = row.id;
      const text = document.createElement("span");
      text.className = "redownload-label";
      text.textContent = row.label;
      const detail = document.createElement("span");
      detail.className = "redownload-detail";
      detail.textContent = detailText(row);
      label.append(box, text, detail);
      li.append(label);
      return li;
    })
  );
  el.remember.hidden = !question.forRun;
  el.rememberBox.checked = true;
  updateAgainButton();
}

const ticked = () => [...el.list.querySelectorAll("input[type=checkbox]:checked")].map((b) => b.value);

function updateAgainButton() {
  const n = ticked().length;
  el.btnAgain.disabled = n === 0;
  el.btnAgain.textContent = n ? `Download ${plural(n, "file", "files")} again` : "Download selected again";
  el.btnAll.textContent = n === el.list.querySelectorAll("input[type=checkbox]").length ? "Select none" : "Select all";
}

function close(answer) {
  if (!open) return;
  const { resolve, timer } = open;
  open = null;
  clearTimeout(timer);
  el.view.hidden = true;
  delete document.body.dataset.redownload;
  resolve(answer);
}

/**
 * Show the question and resolve with { redownload: ids, sameForRun } (ids may be empty).
 * @param {import("../services/download-log.js").RedownloadQuestion & { forRun?: boolean }} question
 */
export function askRedownload(question) {
  const answer = turn.then(
    () =>
      new Promise((resolve) => {
        render(question);
        open = { resolve, timer: setTimeout(() => close({ redownload: [], sameForRun: false, timedOut: true }), ANSWER_TIMEOUT_MS) };
        el.view.hidden = false;
        document.body.dataset.redownload = "on";
        el.btnSkip.focus();
      })
  );
  turn = answer.catch(() => {});
  return answer;
}

/** @param {{ currentTabId: () => Promise<number|null> }} context */
export function initRedownload(context) {
  currentTabId = context.currentTabId;
  el = {
    view: $("view-redownload"),
    summary: $("redownload-summary"),
    list: $("redownload-list"),
    btnAll: $("btn-redownload-all"),
    btnSkip: $("btn-redownload-skip"),
    btnAgain: $("btn-redownload-again"),
    remember: $("redownload-remember"),
    rememberBox: $("redownload-remember-box")
  };
  const answer = (ids) => close({ redownload: ids, sameForRun: !el.remember.hidden && el.rememberBox.checked });
  el.list.addEventListener("change", updateAgainButton);
  el.btnAll.addEventListener("click", () => {
    const boxes = [...el.list.querySelectorAll("input[type=checkbox]")];
    const all = boxes.every((b) => b.checked);
    for (const b of boxes) b.checked = !all;
    updateAgainButton();
  });
  el.btnSkip.addEventListener("click", () => answer([]));
  el.btnAgain.addEventListener("click", () => answer(ticked()));

  // the service worker's runs (MA, PO, IC, batches): only the panel that started the run answers
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.target !== TARGETS.POPUP || message.type !== MESSAGE_TYPES.CONFIRM_REDOWNLOAD) return false;
    (async () => {
      const mine = await currentTabId();
      if (message.panelTabId !== null && message.panelTabId !== undefined && mine !== null && mine !== message.panelTabId) return null;
      return askRedownload(message.question || {});
    })()
      .then((reply) => reply && sendResponse(reply))
      .catch((error) => logger.warn("Download-again prompt failed", error));
    return true;
  });
  // the tender view (bundled separately) asks through this event
  document.addEventListener(REDOWNLOAD_EVENT, (event) => {
    event.preventDefault();
    askRedownload(event.detail.question || {}).then(event.detail.resolve);
  });
}

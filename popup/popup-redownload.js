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
 *
 * The worker sends the time it stops waiting (`deadline`) with its question, so a question
 * that waited behind another one is never shown longer than the worker waits (7.4). A question
 * whose time ran out, on screen or while it waited its turn, says so on the page (with OK),
 * and so does an answer given too late: such an answer is never dropped unsaid.
 */

import { MESSAGE_TYPES, TARGETS, describeError } from "../utils/messages.js";
import { REDOWNLOAD_EVENT } from "../services/download-log.js";
import { logger } from "../utils/logger.js";

const $ = (id) => document.getElementById(id);
/** How long a question without a deadline (the tender view's) waits on screen. */
const ANSWER_TIMEOUT_MS = 4 * 60 * 1000 - 5000; // just inside the service worker's wait
/** An answer must reach the worker this long before its deadline (the reply takes a moment). */
const ANSWER_MARGIN_MS = 5000;

let el = null;
let currentTabId = async () => null;
let ownTabId = () => null;
let tabExists = async () => false;

/**
 * Whether this panel started the run that asks (review M3). The panel that started it answers even
 * while the user looks at another tab (its prompt waits there); the active tab decides only when
 * this panel's own tab id is unknown or no longer exists (Chrome replaced it).
 */
async function startedHere(panelTabId) {
  if (panelTabId === null || panelTabId === undefined) return true;
  const own = ownTabId();
  if (own === panelTabId) return true;
  if (own !== null && (await tabExists(own))) return false;
  const active = await currentTabId();
  return active === null || active === panelTabId;
}
/** Questions wait their turn: the page shows one at a time. */
let turn = Promise.resolve();
/** The question on screen: { resolve, timer, deadline, files } */
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
  if (inEcm && question.replacesEcm) lines.push("Downloading one of those again puts the new PDF in that ECM document; the old PDF stays in it, renamed _old (a damaged one is removed).");
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
  setLate(false);
  el.remember.hidden = !question.forRun;
  el.rememberBox.checked = true;
  updateAgainButton();
}

/** The page as a question (boxes and answers), or as the notice that its time ran out (only OK). */
function setLate(late) {
  for (const box of el.list.querySelectorAll("input[type=checkbox]")) box.disabled = late;
  el.btnAll.hidden = late;
  el.btnSkip.hidden = late;
  el.btnAgain.hidden = late;
  el.btnOk.hidden = !late;
  if (late) el.remember.hidden = true;
}

const ticked = () => [...el.list.querySelectorAll("input[type=checkbox]:checked")].map((b) => b.value);

function updateAgainButton() {
  const n = ticked().length;
  el.btnAgain.disabled = n === 0;
  el.btnAgain.textContent = n ? `Download ${plural(n, "file", "files")} again` : "Download selected again";
  el.btnAll.textContent = n === el.list.querySelectorAll("input[type=checkbox]").length ? "Select none" : "Select all";
}

function showPage() {
  el.view.hidden = false;
  document.body.dataset.redownload = "on";
}

function hidePage() {
  el.view.hidden = true;
  delete document.body.dataset.redownload;
}

/** Whether the run asking has stopped waiting (its deadline, less the time a reply takes, has passed). */
const tooLate = (question) => question.deadline !== null && Date.now() >= question.deadline - ANSWER_MARGIN_MS;

/** The user's answer to the question on screen. One given after the run stopped waiting is not sent as an answer: the page says it came too late (7.4). */
function settleAnswer(answer) {
  if (!open) return;
  if (tooLate(open)) {
    timeUp();
    return;
  }
  const { resolve, timer } = open;
  open = null;
  clearTimeout(timer);
  hidePage();
  resolve(answer);
}

/**
 * The question's time ran out, on screen or while it waited its turn: "skip them" is the answer (as the
 * worker takes it), and the page says what that means until the user clicks OK (7.4).
 */
function timeUp() {
  if (!open) return;
  const { resolve, timer, files } = open;
  open = null;
  clearTimeout(timer);
  const late = describeError("REDOWNLOAD_TOO_LATE", { detail: files === 1 ? "the file below" : `the ${files} files below` });
  el.summary.textContent = `${late.title}: ${late.message}`;
  setLate(true);
  showPage();
  el.btnOk.focus();
  resolve({ redownload: [], sameForRun: false, timedOut: true });
}

/**
 * Show the question and resolve with { redownload: ids, sameForRun } (ids may be empty).
 * `deadline`: when the run that asks stops waiting (ms since 1970, the worker's questions). The question
 * is answered "skip them" before then, also when it waited for its turn behind another question; without
 * it (the tender view's questions) the question waits 4 minutes on screen.
 * @param {import("../services/download-log.js").RedownloadQuestion & { forRun?: boolean }} question
 * @param {{ deadline?: number|null }} [options]
 */
export function askRedownload(question, { deadline = null } = {}) {
  const answer = turn.then(
    () =>
      new Promise((resolve) => {
        render(question);
        open = { resolve, timer: null, deadline: Number.isFinite(deadline) ? deadline : null, files: rows(question).length };
        const wait = open.deadline === null ? ANSWER_TIMEOUT_MS : open.deadline - ANSWER_MARGIN_MS - Date.now();
        if (wait <= 0) {
          timeUp();
          return;
        }
        open.timer = setTimeout(timeUp, wait);
        showPage();
        el.btnSkip.focus();
      })
  );
  turn = answer.catch(() => {});
  return answer;
}

/** @param {{ currentTabId: () => Promise<number|null>, ownTabId?: () => number|null, tabExists?: (id: number) => Promise<boolean> }} context */
export function initRedownload(context) {
  currentTabId = context.currentTabId;
  if (context.ownTabId) ownTabId = context.ownTabId;
  if (context.tabExists) tabExists = context.tabExists;
  el = {
    view: $("view-redownload"),
    summary: $("redownload-summary"),
    list: $("redownload-list"),
    btnAll: $("btn-redownload-all"),
    btnSkip: $("btn-redownload-skip"),
    btnAgain: $("btn-redownload-again"),
    btnOk: $("btn-redownload-ok"),
    remember: $("redownload-remember"),
    rememberBox: $("redownload-remember-box")
  };
  const answer = (ids) => settleAnswer({ redownload: ids, sameForRun: !el.remember.hidden && el.rememberBox.checked });
  el.list.addEventListener("change", updateAgainButton);
  el.btnAll.addEventListener("click", () => {
    const boxes = [...el.list.querySelectorAll("input[type=checkbox]")];
    const all = boxes.every((b) => b.checked);
    for (const b of boxes) b.checked = !all;
    updateAgainButton();
  });
  el.btnSkip.addEventListener("click", () => answer([]));
  el.btnAgain.addEventListener("click", () => answer(ticked()));
  // OK on the "not answered in time" notice (no question is open then)
  el.btnOk.addEventListener("click", () => {
    if (!open) hidePage();
  });

  // the service worker's runs (MA, PO, IC, batches): only the panel that started the run answers
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.target !== TARGETS.POPUP || message.type !== MESSAGE_TYPES.CONFIRM_REDOWNLOAD) return false;
    (async () => {
      if (!(await startedHere(message.panelTabId))) return null;
      return askRedownload(message.question || {}, { deadline: message.deadline });
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

/**
 * Small DOM helpers shared by the side-panel views (popup/popup-*.js).
 */

import { SCHEDULED_RUN } from "../utils/messages.js";

/**
 * Save `content` as a file in Downloads, the way Chrome saves a link the user clicked (Download Excel).
 * @param {string|Uint8Array} content
 * @param {string} filename
 * @param {string} type   its MIME type
 */
export function saveFile(content, filename, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/**
 * The Day filter of My Downloads' tabs (a dropdown in place of a button per day, the user's choice on 27 Nov 2026):
 * an option per day kept, newest first, the day shown selected, and at the foot of the list a line that cannot be
 * picked saying how many days are kept (.day-note: small in Chrome's customizable select). The options are rebuilt
 * only when they change, so a state message never closes the list while it is open.
 * @param {HTMLSelectElement} select
 * @param {{ value: string, text: string }[]} choices
 * @param {string|null} value   the day shown
 * @param {string} note
 */
export function fillDaySelect(select, choices, value, note) {
  const signature = JSON.stringify([choices, note]);
  if (select.dataset.signature !== signature) {
    select.replaceChildren(
      ...choices.map((c) => Object.assign(document.createElement("option"), { value: c.value, textContent: c.text })),
      Object.assign(document.createElement("option"), { value: "", textContent: note, disabled: true, className: "day-note" })
    );
    select.dataset.signature = signature;
  }
  if (value !== null && value !== undefined && select.value !== value) select.value = value;
}

/** The runs this panel did not start that hold a job now: key -> the line that says so. */
const backgroundRuns = new Map();

/**
 * The panel's line about a run it did not start (a scheduled download, a run from another tab's panel)
 * while that run holds a job: `text` says which, null takes the line away. Such a run never switches a
 * view or shows its result here; this line (#background-runs, above the views) is all the panel says.
 * @param {string} key    the job ("billStatus", "doc:CRN", "ma", "po", "ic", "batch:po-date" ...)
 * @param {string|null} text
 */
export function noteBackgroundRun(key, text) {
  if (text) backgroundRuns.set(key, text);
  else backgroundRuns.delete(key);
  const line = document.getElementById("background-runs");
  if (!line) return;
  line.textContent = [...backgroundRuns.values()].join("\n");
  line.hidden = backgroundRuns.size === 0;
}

/**
 * Whether a run's progress stage comes after IREPS answered the run's session check, so that the IREPS
 * indicator may say "Connected" (7.15): not at "Checking IREPS session", and not for the panel's own
 * "Searching..." shown before the worker reported a stage (no stage).
 * @param {string|null|undefined} stage   the stage id of a progress message or job state
 */
export function irepsAnswered(stage) {
  return typeof stage === "string" && stage !== "" && stage !== "IDLE" && stage !== "CHECKING_SESSION";
}

/** What #background-runs says about a run of `label` this panel did not start. */
export function backgroundRunText(label, startedBy) {
  return startedBy === SCHEDULED_RUN
    ? `${label}: a scheduled download is running in the background (it saves to S3 / ECM; see Scheduled downloads).`
    : `${label}: a download started in another tab's DocLink panel is running.`;
}

/**
 * Replace a <select>'s options with IREPS's list ({ value, label }), keeping the current
 * choice when it is still offered and falling back to `fallbackValue` otherwise.
 * An empty or missing list leaves the select as it is; returns whether it was filled.
 */
export function fillSelect(select, options, fallbackValue) {
  if (!Array.isArray(options) || options.length === 0) return false;
  const current = select.value;
  select.replaceChildren();
  for (const o of options) {
    const option = document.createElement("option");
    option.value = o.value;
    option.textContent = o.label;
    select.append(option);
  }
  select.value = options.some((o) => o.value === current) ? current : fallbackValue;
  return true;
}

/**
 * This browser's log of scheduled downloads, shown in My Downloads > Scheduled runs (popup/popup-run-history.js)
 * and copied or saved as text from there:
 *   - runs: every slot this DocLink ran, newest first: the type, the slot and its day, the range it searched,
 *     how it ended (code and reason), and the documents it saved, skipped and could not save, each with why
 *     (and its download-log key, run-details.js logKey);
 *   - events: what the scheduler decided when it did not run something (waiting for an IREPS page, for a
 *     manual run, for the Recon Engine; another DocLink running the account; a schedule changed). A repeat
 *     of the newest event of the same day only moves its time and counts it, so a long wait stays one line.
 *
 * Kept for the last RUN_DAYS days that had runs (asked for on 26 Nov 2026; until then the last 60 runs), so a
 * Monday still shows Friday and Thursday. A run's day is its slot's date (the Recon Engine's IST date), an
 * event's the IST day it was first noted; the events of the days between are kept too (EVENT_DAYS at most while
 * fewer days had runs). Every day keeps what its runs downloaded and could not save; older days drop the lists of
 * documents found already saved (counted instead), the bulk of a log. A document a later run saved is marked on
 * its failure when that run ends (markSavedLater), so "saved later" stays when lists are cut. Loading a build keeps
 * the log, apart from what was recorded against another Recon Engine server (keepServer, the user's choice on
 * 27 Nov 2026); a run that was still running when the worker started was cut off (markInterrupted).
 * MAX_RUNS, MAX_EVENTS and MAX_LOG_CHARS bound it: past MAX_LOG_CHARS the oldest runs' skipped, then saved lists go
 * first (their counts stay), their failures last.
 *
 * Kept in chrome.storage.local. The worker is the only writer, and every change runs after the one before; a
 * log that cannot be read is never written over. Only document numbers and keys, codes and DocLink's own texts
 * are kept (cut and redacted by run-details.js): never a URL, an IREPS page, a token or a cookie.
 */

import { STORAGE_KEYS, describeError } from "../../utils/messages.js";
import { failureEntry, docEntry, withKey, capped, CATCH_UP_RETRIES } from "./run-details.js";
import { SCHEDULE_TYPES, SCHEDULE_TYPE_LABEL } from "./schedule-types.js";
import { lastSuccessEntry } from "./last-success.js";
import { logger } from "../../utils/logger.js";

/** The days with runs the log keeps (today included when it had one). */
export const RUN_DAYS = 3;
/** A browser that ran on fewer days keeps the events of this many days at most (one that rarely wins a claim). */
export const EVENT_DAYS = 7;
export const MAX_RUNS = 600;
export const MAX_EVENTS = 600;
/** The stored log stays under this many characters of JSON (each change rewrites it). */
export const MAX_LOG_CHARS = 1000000;
const COUNT_KEYS = ["found", "saved", "skipped", "failed", "notReported", "records"];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const emptyLog = () => ({ runs: [], events: [] });

/** The stored value as a log (anything else reads as empty). */
function asLog(value) {
  if (!value || typeof value !== "object") return emptyLog();
  return { runs: Array.isArray(value.runs) ? value.runs : [], events: Array.isArray(value.events) ? value.events : [] };
}

/** "2026-11-19T04:45:00Z" -> "2026-11-19 10:15" (IST); "" when not a time. */
export function istDateTime(iso) {
  const ms = Date.parse(iso || "");
  if (!Number.isFinite(ms)) return "";
  const ist = new Date(ms + 330 * 60000).toISOString();
  return `${ist.slice(0, 10)} ${ist.slice(11, 16)}`;
}

const istDay = (iso) => istDateTime(iso).slice(0, 10);
const timeOf = (iso) => Date.parse(iso || "") || 0;

/** The day `n` days before `day` ("2026-11-30", 6 -> "2026-11-24"); "" when `day` is not one. */
function dayBefore(day, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ""));
  return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - n * 86400000).toISOString().slice(0, 10) : "";
}

/** A run's day ("2026-11-30"): its slot's date (the Recon Engine's IST date), else the IST day it started; "" when neither. */
export function runDay(run) {
  const r = run && typeof run === "object" ? run : {};
  for (const day of [r.day, r.slotDate]) if (DAY_RE.test(String(day || ""))) return day;
  return istDay(r.startedAt);
}

/** An event's day: the IST day it was first noted; "" when it has no time. */
export function eventDay(event) {
  const e = event && typeof event === "object" ? event : {};
  return DAY_RE.test(String(e.day || "")) ? e.day : istDay(e.first || e.at);
}

/** What a run's outcome adds to its entry: how it ended, its counts and its lists. */
function finishedFields(outcome) {
  const o = outcome && typeof outcome === "object" ? outcome : {};
  const r = o.result && typeof o.result === "object" ? o.result : {};
  const log = o.log && typeof o.log === "object" ? o.log : {};
  // a runner tab's log may be missing: the result's short list is all there is then
  const failures = Array.isArray(log.failures) ? log.failures : Array.isArray(r.failures) ? r.failures : [];
  const more = { ...(log.more || {}) };
  if (!Array.isArray(log.failures) && Number(r.failuresMore) > 0) more.failures = Number(r.failuresMore);
  const doc = (d) => withKey(docEntry(d && d.doc, d && d.note), d && d.key);
  return {
    outcome: o.outcome || "failed",
    code: o.code || null,
    detail: typeof r.detail === "string" ? r.detail : null,
    counts: Object.fromEntries(COUNT_KEYS.filter((k) => Number.isFinite(r[k])).map((k) => [k, r[k]])),
    file: typeof r.file === "string" ? r.file : null,
    warnings: Array.isArray(r.warnings) ? r.warnings.filter((w) => typeof w === "string").slice(0, 10) : [],
    failures: capped(failures).map((f) => withKey(failureEntry(f), f && f.key)),
    saved: capped(log.saved).map(doc),
    skipped: capped(log.skipped).map(doc),
    more: Object.fromEntries(Object.entries(more).filter(([, n]) => Number(n) > 0))
  };
}

/* ---------------------------------------------------- the same document in several runs */

const keyId = (key) => `key:${key}`;
const docId = (docType, doc) => `doc:${docType}|${doc}`;
/** A failed document's identity across runs: its key, else its type and name. */
const failureId = (run, f) => (f.key ? keyId(f.key) : docId(run.docType, f.doc));

/** The identities a run saved: its saved documents (by key and by name) and the ones it found already saved (by key). */
function savedIds(run) {
  const ids = new Set();
  for (const d of Array.isArray(run.saved) ? run.saved : []) {
    if (!d || typeof d !== "object") continue;
    if (d.key) ids.add(keyId(d.key));
    ids.add(docId(run.docType, d.doc));
  }
  for (const d of Array.isArray(run.skipped) ? run.skipped : []) if (d && d.key) ids.add(keyId(d.key));
  return ids;
}

/** The failures of earlier runs that `run` saved or found already saved get `savedAt`, which stays when lists are cut. */
function markSavedLater(log, run) {
  const ids = savedIds(run);
  if (ids.size === 0) return;
  const at = timeOf(run.startedAt);
  for (const r of log.runs) {
    if (!r || r === run || timeOf(r.startedAt) > at) continue;
    for (const f of Array.isArray(r.failures) ? r.failures : []) if (f && !f.savedAt && ids.has(failureId(r, f))) f.savedAt = run.startedAt;
  }
}

const sizeOf = (value) => JSON.stringify(value).length + 1;

/** `run` without its `lists` ("skipped", "saved"), each counted in `more` instead. */
function withoutLists(run, lists) {
  const m = run.more && typeof run.more === "object" ? { ...run.more } : {};
  const cut = { ...run };
  let changed = false;
  for (const list of lists) {
    const n = Array.isArray(run[list]) ? run[list].length : 0;
    if (!n) continue;
    m[list] = (Number(m[list]) || 0) + n;
    cut[list] = [];
    changed = true;
  }
  return changed ? { ...cut, more: m } : run;
}

/**
 * The log as it is kept (see the top of this file): the runs of the last RUN_DAYS days that had runs, older days
 * without their "found already saved" lists, the events from the oldest kept day on, then MAX_RUNS / MAX_EVENTS,
 * then MAX_LOG_CHARS. Both lists stay newest first.
 * @param {{ runs: object[], events: object[] }} log
 */
export function keptLog(log) {
  const { runs: allRuns, events: allEvents } = asLog(log);
  const days = [...new Set(allRuns.map(runDay).filter(Boolean))].sort().reverse().slice(0, RUN_DAYS);
  const newestRunDay = days[0] || "";
  const newest = [newestRunDay, ...allEvents.map(eventDay)].filter(Boolean).sort().pop() || "";
  const floor = days.length >= RUN_DAYS ? days[days.length - 1] : dayBefore(newest, EVENT_DAYS - 1);
  const runs = allRuns.filter((r) => days.includes(runDay(r))).slice(0, MAX_RUNS)
    .map((r) => (runDay(r) < newestRunDay ? withoutLists(r, ["skipped"]) : r));
  const events = allEvents.filter((e) => !floor || eventDay(e) >= floor).slice(0, MAX_EVENTS);
  let size = sizeOf({ runs, events });
  // too big: the oldest runs' skipped, then saved lists (counted in `more`), then the oldest runs and events
  for (const lists of [["skipped"], ["saved"]]) {
    for (let i = runs.length - 1; i >= 0 && size > MAX_LOG_CHARS; i--) {
      const cut = withoutLists(runs[i], lists);
      if (cut === runs[i]) continue;
      size -= sizeOf(runs[i]) - sizeOf(cut);
      runs[i] = cut;
    }
  }
  while (size > MAX_LOG_CHARS && runs.length > 1) size -= sizeOf(runs.pop());
  while (size > MAX_LOG_CHARS && events.length > 0) size -= sizeOf(events.pop());
  return { runs, events };
}

/**
 * @param {{ storage?: chrome.storage.StorageArea, now?: () => number, recon?: () => string }} [deps]
 *        recon: the Recon Engine server (origin) runs and events are recorded against ("" when not known)
 */
export function createRunLog(deps = {}) {
  const storage = deps.storage || chrome.storage.local;
  const now = deps.now || (() => Date.now());
  const recon = () => {
    try {
      return String((deps.recon && deps.recon()) || "");
    } catch {
      return "";
    }
  };
  const key = STORAGE_KEYS.SCHEDULER_RUN_LOG;
  let chain = Promise.resolve();

  async function load() {
    try {
      return asLog((await storage.get(key))[key]);
    } catch (error) {
      logger.debug("Scheduler: run log not read", error);
      return emptyLog();
    }
  }

  /**
   * Apply `change` to the stored log after every earlier change; a `change` that returns false changed nothing.
   * Never throws: the log never stops a run. A log that cannot be read is not written: its days would be lost.
   */
  function update(change) {
    chain = chain
      .then(async () => {
        const log = asLog((await storage.get(key))[key]);
        if (change(log) === false) return;
        await storage.set({ [key]: keptLog(log) });
      })
      .catch((error) => logger.debug("Scheduler: run log not written", error));
    return chain;
  }

  const iso = () => new Date(now()).toISOString();

  return {
    /** The log, newest first: { runs, events }. */
    read: () => chain.then(load),
    /**
     * A decision of the scheduler. `types` are the schedule types it is about (none: all).
     * @param {string} kind     waiting reason or "other" / "schedule" / "error"
     * @param {string} text
     * @param {string[]} [types]
     */
    event(kind, text, types = []) {
      return update((log) => {
        const at = iso();
        const last = log.events[0];
        if (last && last.kind === kind && last.text === text && eventDay(last) === istDay(at)) {
          last.at = at;
          last.count = (Number(last.count) || 1) + 1;
          return;
        }
        log.events.unshift({ first: at, at, day: istDay(at), recon: recon(), kind, text, ...(types.length ? { types: [...new Set(types)] } : {}) });
      });
    },
    /** A claimed slot starts: { id (the claim), docType, slotId, period, slotDate, account, range, user }. */
    runStarted(run) {
      return update((log) => {
        const startedAt = iso();
        log.runs.unshift({ ...run, day: runDay({ ...run, startedAt }), recon: recon(), startedAt, outcome: "running" });
      });
    },
    /** How the run `id` ended: the scheduler's outcome (outcome, code, result, log). */
    runFinished(id, outcome) {
      return update((log) => {
        const run = log.runs.find((r) => r.id === id);
        if (!run) return false;
        Object.assign(run, finishedFields(outcome), { endedAt: iso() });
        markSavedLater(log, run);
      });
    },
    /**
     * The worker started: a run still "running" was cut off (a build loaded, Chrome stopping the worker), so it says
     * so instead of running for days. Called before the scheduler wakes, so it never touches a run of this worker.
     */
    markInterrupted() {
      return update((log) => {
        const cut = log.runs.filter((r) => r && r.outcome === "running");
        for (const r of cut) Object.assign(r, { outcome: "failed", code: "SCHEDULE_RUN_INTERRUPTED", detail: "it was running when DocLink started again" });
        return cut.length > 0;
      });
    },
    /**
     * A build was loaded: keep what was recorded against this Recon Engine server, drop the rest (another
     * server's, and entries of a build that did not record its server). Nothing changes while the server is not known.
     * @param {string} server   the origin of the Recon Engine in use
     */
    keepServer(server) {
      if (!server) return chain;
      return update((log) => {
        log.runs = log.runs.filter((r) => r && r.recon === server);
        log.events = log.events.filter((e) => e && e.recon === server);
      });
    },
    clear() {
      return update((log) => {
        log.runs = [];
        log.events = [];
      });
    }
  };
}

const typeLabel = (type) => SCHEDULE_TYPE_LABEL[type] || type || "Scheduled download";
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "2026-11-30" -> "Mon 30/11/2026"; "" when not a day. */
export function dayLabel(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ""));
  if (!m) return "";
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return `${WEEKDAYS[date.getUTCDay()]} ${m[3]}/${m[2]}/${m[1]}`;
}

/** "Tender 1234 tender PDF: Not saved to S3 / ECM (the ECM did not answer) [ECM_UNAVAILABLE]" */
export function failureText(f) {
  const title = describeError(f.code).title;
  return `${f.doc}: ${title}${f.detail ? ` (${f.detail})` : ""} [${f.code}]`;
}

/** "35 saved, 18 already saved, 5 failed" for a run's counts. */
export function countsText(counts = {}) {
  const parts = [];
  if (Number.isFinite(counts.found)) parts.push(`${counts.found} found`);
  if (counts.saved) parts.push(`${counts.saved} saved`);
  if (counts.skipped) parts.push(`${counts.skipped} already saved`);
  if (counts.failed) parts.push(`${counts.failed} failed`);
  if (counts.notReported) parts.push(`${counts.notReported} not reported to the Recon Engine`);
  if (Number.isFinite(counts.records)) parts.push(`${counts.records} records`);
  return parts.join(", ");
}

/**
 * The days of the log, newest first, each with its runs and events: [{ day, runs, events }]. A day has runs, events
 * or both; an entry without a day is left out.
 * @param {{ runs: object[], events: object[] }} log
 */
export function logDays(log) {
  const { runs, events } = asLog(log);
  const byDay = new Map();
  const dayOf = (day) => {
    if (!byDay.has(day)) byDay.set(day, { day, runs: [], events: [] });
    return byDay.get(day);
  };
  for (const r of runs) if (runDay(r)) dayOf(runDay(r)).runs.push(r);
  for (const e of events) if (eventDay(e)) dayOf(eventDay(e)).events.push(e);
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
}

/**
 * What the runs of `day` downloaded, newest first: { entries: [{ at (when its run started), docType, doc, note, key? }],
 * total (with those its lists leave out, from the runs' counts) }.
 * @param {{ runs: object[], events: object[] }} log
 * @param {string} day   "2026-11-30"
 */
export function downloadedOn(log, day) {
  const runs = asLog(log).runs.filter((r) => r && typeof r === "object" && runDay(r) === day).sort((a, b) => timeOf(b.startedAt) - timeOf(a.startedAt));
  const entries = [];
  let total = 0;
  for (const run of runs) {
    const listed = (Array.isArray(run.saved) ? run.saved : []).filter((d) => d && typeof d === "object");
    for (const d of listed) entries.push({ ...d, at: run.startedAt, docType: run.docType });
    const counted = Number(run.counts && run.counts.saved);
    total += Math.max(Number.isFinite(counted) ? counted : 0, listed.length + (Number(run.more && run.more.saved) || 0));
  }
  return { entries, total };
}

/**
 * Every document the kept runs did not save, once each (its latest failure), the ones still not saved first, each
 * part newest first: { doc, code, detail, key?, docType, day, at (when that run started), times (how many runs did
 * not save it), savedAt (when a later run saved it or found it already saved; null when none did) }. A document is
 * the same by its key (run-details.js logKey), else by its type and name; a skip ("already saved") counts by key only.
 * With `day`, only the failures of that day's runs, still marked by any later save.
 * @param {{ runs: object[], events: object[] }} log
 * @param {{ day?: string }} [options]
 */
export function notSavedList(log, { day = "" } = {}) {
  const runs = asLog(log).runs.filter((r) => r && typeof r === "object").slice().sort((a, b) => timeOf(a.startedAt) - timeOf(b.startedAt));
  // when each identity was saved: a failure counts as saved by the first save at or after it
  const saves = new Map();
  for (const run of runs) {
    for (const id of savedIds(run)) {
      if (!saves.has(id)) saves.set(id, []);
      saves.get(id).push(run.startedAt);
    }
  }
  const savedAfter = (id, at) => (saves.get(id) || []).find((s) => timeOf(s) >= timeOf(at)) || null;
  const byDoc = new Map();
  for (const run of runs) {
    if (day && runDay(run) !== day) continue;
    for (const f of Array.isArray(run.failures) ? run.failures : []) {
      if (!f || typeof f !== "object") continue;
      const id = failureId(run, f);
      const before = byDoc.get(id);
      byDoc.set(id, { ...f, docType: run.docType, day: runDay(run), at: run.startedAt, times: (before ? before.times : 0) + 1, savedAt: f.savedAt || savedAfter(id, run.startedAt) });
    }
  }
  return [...byDoc.values()].sort((a, b) => Number(Boolean(a.savedAt)) - Number(Boolean(b.savedAt)) || timeOf(b.at) - timeOf(a.at) || String(a.doc).localeCompare(String(b.doc)));
}

/** One line of a "not saved" list: "2026-11-30 09:05  MA copies  MA 1 (PO 2): ... [ECM_UNAVAILABLE] (2 times)  saved later 2026-11-30 10:05". */
export function notSavedText(entry) {
  const times = entry.times > 1 ? ` (${entry.times} times)` : "";
  const later = entry.savedAt ? `saved later ${istDateTime(entry.savedAt)}` : "not saved since";
  return `${istDateTime(entry.at)}  ${typeLabel(entry.docType)}  ${failureText(entry)}${times}  ${later}`;
}

const OUTCOME_TEXT = { running: "RUNNING", done: "DONE", partial: "PARTLY DONE", failed: "FAILED" };

/**
 * The stored last successful runs (services/scheduler/last-success.js) as lines, in the Schedule view's order:
 * ["MA copies: 27/11/2026", "POs by PO date: 27/11/2026 (searched again: documents of its catch-up not saved, 1 of 3)"];
 * a type DocLink does not know comes last, by its name.
 * @param {Object<string, { day: string, held?: number }|string>|null|undefined} entries
 */
export function lastSuccessLines(entries) {
  const all = entries && typeof entries === "object" ? Object.entries(entries).map(([type, value]) => [type, lastSuccessEntry(value)]).filter(([, entry]) => entry) : [];
  const rank = (type) => (SCHEDULE_TYPES.includes(type) ? SCHEDULE_TYPES.indexOf(type) : SCHEDULE_TYPES.length);
  const held = (entry) => (entry.held > 0 ? ` (searched again: documents of its catch-up not saved, ${Math.min(entry.held, CATCH_UP_RETRIES)} of ${CATCH_UP_RETRIES})` : "");
  return all.sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b)).map(([type, entry]) => `${typeLabel(type)}: ${entry.day}${held(entry)}`);
}

/** "2026-11-30" -> "30/11/2026". */
const dmyDay = (day) => String(day || "").split("-").reverse().join("/");
const istTimeOf = (iso) => istDateTime(iso).slice(11);
const OUTCOME_LABEL = { running: "Running", done: "Done", partial: "Partly done", failed: "Failed" };

/**
 * The log as spreadsheet sheets (My Downloads > Scheduled runs: Download Excel), newest day first, every cell text
 * (utils/xlsx-writer.js buildWorkbook): "Documents" (each document a run downloaded, then each one it did not save,
 * once a day, with where it went or why not), "Runs" (one row each) and "Scheduler events" (why nothing ran).
 * @param {{ runs: object[], events: object[] }} log
 * @returns {{ name: string, headers: string[], rows: string[][] }[]}
 */
export function runLogSheets(log) {
  const days = logDays(log);
  const documents = [];
  const runs = [];
  const events = [];
  const reason = (f) => `${describeError(f.code).title}${f.detail ? ` (${f.detail})` : ""}`;
  for (const d of days) {
    const day = dmyDay(d.day);
    for (const e of downloadedOn(log, d.day).entries) documents.push([day, istTimeOf(e.at), typeLabel(e.docType), e.doc, "Downloaded", e.note || "", ""]);
    for (const n of notSavedList(log, { day: d.day })) {
      const times = n.times > 1 ? `; not saved by ${n.times} runs` : "";
      const later = n.savedAt ? `; saved later ${istDateTime(n.savedAt)}` : "";
      documents.push([day, istTimeOf(n.at), typeLabel(n.docType), n.doc, n.savedAt ? "Saved later" : "Not saved", `${reason(n)}${times}${later}`, n.code || ""]);
    }
    for (const r of d.runs) {
      const c = r.counts || {};
      const count = (k) => (Number.isFinite(c[k]) ? String(c[k]) : "");
      runs.push([day, istTimeOf(r.startedAt), r.endedAt ? istTimeOf(r.endedAt) : "", typeLabel(r.docType), r.period && r.period !== "day" ? `${r.period} run` : "once a day",
        OUTCOME_LABEL[r.outcome] || String(r.outcome || ""), r.range || "", count("found"), count("saved"), count("skipped"), count("failed"), count("notReported"), count("records"),
        r.code && r.outcome !== "done" ? `${describeError(r.code).title}${r.detail ? ` (${r.detail})` : ""}` : ""]);
    }
    for (const e of d.events) {
      events.push([day, istTimeOf(e.first || e.at), istTimeOf(e.at), String(Number(e.count) || 1), e.text]);
    }
  }
  return [
    { name: "Documents", headers: ["Day", "Run time", "Type", "Document", "Status", "Saved to / why not", "Error code"], rows: documents },
    { name: "Runs", headers: ["Day", "Started", "Ended", "Type", "Run", "Outcome", "Searched", "Found", "Saved", "Already saved", "Failed", "Not reported to the Recon Engine", "Records", "Why"], rows: runs },
    { name: "Scheduler events", headers: ["Day", "From", "To", "Checks", "What the scheduler noted"], rows: events }
  ];
}

/** A run of the log as text lines (runLogText). */
function runLines(run) {
  const lines = [];
  const period = run.period && run.period !== "day" ? ` (${run.period} run)` : "";
  lines.push(`${istDateTime(run.startedAt)}${run.endedAt ? ` to ${istDateTime(run.endedAt).slice(11)}` : ""}  ${typeLabel(run.docType)}${period}  ${OUTCOME_TEXT[run.outcome] || String(run.outcome || "").toUpperCase()}`);
  if (run.range) lines.push(`  Searched: ${run.range}`);
  const counts = countsText(run.counts);
  if (counts) lines.push(`  Counts: ${counts}`);
  if (run.code && run.outcome !== "done") lines.push(`  Why: ${describeError(run.code).title}${run.detail ? ` (${run.detail})` : ""} [${run.code}]`);
  if (run.file) lines.push(`  File: ${run.file}`);
  for (const w of run.warnings || []) lines.push(`  Warning: ${w}`);
  const list = (title, items, more, text) => {
    if ((!items || items.length === 0) && !more) return;
    lines.push(`  ${title} (${(items || []).length + (more || 0)}):`);
    for (const item of items || []) lines.push(`    - ${text(item)}`);
    if (more) lines.push(`    ... and ${more} more`);
  };
  const more = run.more || {};
  list("Not saved", run.failures, more.failures, failureText);
  list("Already saved, skipped", run.skipped, more.skipped, (d) => `${d.doc}${d.note ? `: ${d.note}` : ""}`);
  list("Saved", run.saved, more.saved, (d) => `${d.doc}${d.note ? `: ${d.note}` : ""}`);
  return lines;
}

/**
 * The log as plain text (My Downloads > Scheduled runs: Copy / Save), newest day first: per day what was downloaded,
 * what was not saved, the runs and the scheduler's events. Times are IST.
 * @param {{ runs: object[], events: object[] }} log
 * @param {{ account?: string|null, version?: string, savedAt?: string, lastSuccess?: Object<string, { day: string, held?: number }> }} [about]
 *        lastSuccess: each type's last successful run in this browser, which the first run after a gap searches from
 */
export function runLogText(log, about = {}) {
  const days = logDays(log);
  const lines = [`DocLink scheduled downloads: run log of this browser (times IST)`];
  lines.push([about.savedAt ? `Saved ${istDateTime(about.savedAt)}` : "", about.version ? `DocLink ${about.version}` : "", about.account ? `IREPS account ${about.account}` : ""].filter(Boolean).join(" · "));
  lines.push(`Kept: the last ${RUN_DAYS} days with runs and the days between${days.length ? ` (${days.map((d) => dayLabel(d.day)).join(", ")})` : ""}`);
  if (about.lastSuccess && typeof about.lastSuccess === "object") {
    const last = lastSuccessLines(about.lastSuccess);
    lines.push("", "LAST SUCCESSFUL RUN OF EACH TYPE (this browser; the first run after a gap searches from it)");
    if (last.length === 0) lines.push("  none stored yet");
    for (const line of last) lines.push(`  ${line}`);
  }
  const open = notSavedList(log).filter((n) => !n.savedAt);
  lines.push("", `STILL NOT SAVED (${open.length}; each document once, its last failure: download these by hand)`);
  if (open.length === 0) lines.push("  none");
  for (const entry of open) lines.push(`  ${notSavedText(entry)}`);
  if (days.length === 0) lines.push("", "RUNS (0)", "  none", "", "SCHEDULER EVENTS (0)", "  none");
  for (const d of days) {
    const down = downloadedOn(log, d.day);
    const notSaved = notSavedList(log, { day: d.day });
    lines.push("", `${dayLabel(d.day).toUpperCase()}`, `DOWNLOADED (${down.total})`);
    if (down.total === 0) lines.push("  none");
    for (const e of down.entries) lines.push(`  ${istDateTime(e.at).slice(11)}  ${typeLabel(e.docType)}  ${e.doc}${e.note ? `: ${e.note}` : ""}`);
    if (down.total > down.entries.length) lines.push(`  ... and ${down.total - down.entries.length} more (counted by their runs, not listed)`);
    lines.push(`NOT SAVED (${notSaved.length})`);
    if (notSaved.length === 0) lines.push("  none");
    for (const entry of notSaved) lines.push(`  ${notSavedText(entry)}`);
    lines.push(`RUNS (${d.runs.length})`);
    if (d.runs.length === 0) lines.push("  none");
    for (const run of d.runs) lines.push(...runLines(run));
    lines.push(`SCHEDULER EVENTS (${d.events.length})`);
    if (d.events.length === 0) lines.push("  none");
    for (const e of d.events) {
      const span = e.first && e.first !== e.at ? `${istDateTime(e.first)} to ${istDateTime(e.at).slice(11)}` : istDateTime(e.at);
      lines.push(`${span}${Number(e.count) > 1 ? ` (${e.count} times)` : ""}  ${e.text}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

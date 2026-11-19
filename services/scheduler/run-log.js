/**
 * This browser's log of scheduled downloads, shown in the Schedule view ("Run log of this browser") and
 * copied or saved as text from there:
 *   - runs: every slot this DocLink ran, newest first: the type, the slot, the range it searched, how it
 *     ended (code and reason), and the documents it saved, skipped and could not save, each with why;
 *   - events: what the scheduler decided when it did not run something (waiting for an IREPS page, for a
 *     manual run, for the Recon Engine; another DocLink running the account; a schedule changed). A repeat
 *     of the newest event only moves its time and counts it, so a long wait stays one line.
 *
 * Kept in chrome.storage.local (MAX_RUNS runs, MAX_EVENTS events). The worker is the only writer, and every
 * change runs after the one before. Only document numbers, codes and DocLink's own texts are kept (cut and
 * redacted by run-details.js): never a URL, an IREPS page, a token or a cookie.
 */

import { STORAGE_KEYS, describeError } from "../../utils/messages.js";
import { failureEntry, docEntry, capped } from "./run-details.js";
import { SCHEDULE_TYPE_LABEL } from "./schedule-types.js";
import { logger } from "../../utils/logger.js";

export const MAX_RUNS = 60;
export const MAX_EVENTS = 200;
const COUNT_KEYS = ["found", "saved", "skipped", "failed", "notReported", "records"];

const emptyLog = () => ({ runs: [], events: [] });

/** The stored value as a log (anything else reads as empty). */
function asLog(value) {
  if (!value || typeof value !== "object") return emptyLog();
  return { runs: Array.isArray(value.runs) ? value.runs : [], events: Array.isArray(value.events) ? value.events : [] };
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
  return {
    outcome: o.outcome || "failed",
    code: o.code || null,
    detail: typeof r.detail === "string" ? r.detail : null,
    counts: Object.fromEntries(COUNT_KEYS.filter((k) => Number.isFinite(r[k])).map((k) => [k, r[k]])),
    file: typeof r.file === "string" ? r.file : null,
    warnings: Array.isArray(r.warnings) ? r.warnings.filter((w) => typeof w === "string").slice(0, 10) : [],
    failures: capped(failures).map(failureEntry),
    saved: capped(log.saved).map((d) => docEntry(d && d.doc, d && d.note)),
    skipped: capped(log.skipped).map((d) => docEntry(d && d.doc, d && d.note)),
    more: Object.fromEntries(Object.entries(more).filter(([, n]) => Number(n) > 0))
  };
}

/**
 * @param {{ storage?: chrome.storage.StorageArea, now?: () => number }} [deps]
 */
export function createRunLog(deps = {}) {
  const storage = deps.storage || chrome.storage.local;
  const now = deps.now || (() => Date.now());
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

  /** Apply `change` to the stored log after every earlier change. Never throws: the log never stops a run. */
  function update(change) {
    chain = chain
      .then(async () => {
        const log = await load();
        change(log);
        await storage.set({ [key]: { runs: log.runs.slice(0, MAX_RUNS), events: log.events.slice(0, MAX_EVENTS) } });
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
        const last = log.events[0];
        if (last && last.kind === kind && last.text === text) {
          last.at = iso();
          last.count = (Number(last.count) || 1) + 1;
          return;
        }
        log.events.unshift({ first: iso(), at: iso(), kind, text, ...(types.length ? { types: [...new Set(types)] } : {}) });
      });
    },
    /** A claimed slot starts: { id (the claim), docType, slotId, period, slotDate, account, range, user }. */
    runStarted(run) {
      return update((log) => {
        log.runs.unshift({ ...run, startedAt: iso(), outcome: "running" });
      });
    },
    /** How the run `id` ended: the scheduler's outcome (outcome, code, result, log). */
    runFinished(id, outcome) {
      return update((log) => {
        const run = log.runs.find((r) => r.id === id);
        if (run) Object.assign(run, finishedFields(outcome), { endedAt: iso() });
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

/** "2026-11-19T04:45:00Z" -> "2026-11-19 10:15" (IST); "" when not a time. */
export function istDateTime(iso) {
  const ms = Date.parse(iso || "");
  if (!Number.isFinite(ms)) return "";
  const ist = new Date(ms + 330 * 60000).toISOString();
  return `${ist.slice(0, 10)} ${ist.slice(11, 16)}`;
}

const typeLabel = (type) => SCHEDULE_TYPE_LABEL[type] || type || "Scheduled download";

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

const OUTCOME_TEXT = { running: "RUNNING", done: "DONE", partial: "PARTLY DONE", failed: "FAILED" };

/**
 * The log as plain text, newest first (the Schedule view's Copy / Save). Times are IST.
 * @param {{ runs: object[], events: object[] }} log
 * @param {{ account?: string|null, version?: string, savedAt?: string }} [about]
 */
export function runLogText(log, about = {}) {
  const { runs, events } = asLog(log);
  const lines = [`DocLink scheduled downloads: run log of this browser (times IST)`];
  lines.push([about.savedAt ? `Saved ${istDateTime(about.savedAt)}` : "", about.version ? `DocLink ${about.version}` : "", about.account ? `IREPS account ${about.account}` : ""].filter(Boolean).join(" · "));
  lines.push("", `RUNS (${runs.length})`);
  if (runs.length === 0) lines.push("  none");
  for (const run of runs) {
    const period = run.period && run.period !== "day" ? ` (${run.period} run)` : "";
    lines.push(`${istDateTime(run.startedAt)}${run.endedAt ? ` to ${istDateTime(run.endedAt).slice(11)}` : ""}  ${typeLabel(run.docType)}${period}  ${OUTCOME_TEXT[run.outcome] || String(run.outcome || "").toUpperCase()}`);
    if (run.range) lines.push(`  Searched: ${run.range}`);
    const counts = countsText(run.counts);
    if (counts) lines.push(`  Counts: ${counts}`);
    if (run.code && run.outcome !== "done") lines.push(`  Why: ${describeError(run.code).title}${run.detail ? ` (${run.detail})` : ""} [${run.code}]`);
    if (run.file) lines.push(`  File: ${run.file}`);
    for (const w of run.warnings || []) lines.push(`  Warning: ${w}`);
    const list = (title, items, more, text) => {
      if (!items || items.length === 0) return;
      lines.push(`  ${title} (${items.length + (more || 0)}):`);
      for (const item of items) lines.push(`    - ${text(item)}`);
      if (more) lines.push(`    ... and ${more} more`);
    };
    const more = run.more || {};
    list("Not saved", run.failures, more.failures, failureText);
    list("Already saved, skipped", run.skipped, more.skipped, (d) => `${d.doc}${d.note ? `: ${d.note}` : ""}`);
    list("Saved", run.saved, more.saved, (d) => `${d.doc}${d.note ? `: ${d.note}` : ""}`);
  }
  lines.push("", `SCHEDULER EVENTS (${events.length})`);
  if (events.length === 0) lines.push("  none");
  for (const e of events) {
    const span = e.first && e.first !== e.at ? `${istDateTime(e.first)} to ${istDateTime(e.at).slice(11)}` : istDateTime(e.at);
    lines.push(`${span}${Number(e.count) > 1 ? ` (${e.count} times)` : ""}  ${e.text}`);
  }
  return `${lines.join("\n")}\n`;
}

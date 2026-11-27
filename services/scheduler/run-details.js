/**
 * What a scheduled run says about itself beyond its counts: the IREPS range it searched, which documents
 * it could not save and why, and what it saved and skipped.
 *
 * Two readers:
 *   - every DocLink user of the IREPS account sees the slot's `result`, which the Recon Engine keeps with
 *     the slot (at most 16,000 characters of JSON). It carries `range`, `detail` and a short failure list:
 *     `failures` (the first RESULT_FAILURES_MAX) and `failuresMore` (how many more);
 *   - this browser's run log (run-log.js) keeps the full lists.
 *
 * Only document numbers, error codes and DocLink's own error texts go in, redacted and cut short: never a
 * URL, an IREPS page, a token or a cookie.
 */

import { redact } from "../../utils/logger.js";

/** Failed documents listed in a slot's `result` (the rest are counted in `failuresMore`). */
export const RESULT_FAILURES_MAX = 20;
/** Documents kept per list (failed / saved / skipped) of one run in this browser's run log. */
export const LOG_DOCS_MAX = 200;
const DOC_MAX = 120;
const DETAIL_MAX = 200;
const CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Bill Status, CRN and R-NOTE always search the last 90 days (asked for on 19 Nov 2026), whatever the schedule's look-back. */
export const EXPORT_LOOKBACK_DAYS = 90;
/** Types whose look-back is fixed: the Schedule view shows it instead of an input. */
export const FIXED_LOOKBACK = Object.freeze({ billStatus: EXPORT_LOOKBACK_DAYS, crn: EXPORT_LOOKBACK_DAYS, rnote: EXPORT_LOOKBACK_DAYS });
/** Types whose run takes no date range: what IREPS lists now. */
export const NO_RANGE_TYPES = Object.freeze(["icNotifications", "tenderCorrespondence"]);
/**
 * Types whose scheduled run searches at most this many days (today included), whatever the schedule's look-back
 * (asked for on 25 Nov 2026): a tabulation run reads every closing day of its range from IREPS Search Tender, and a
 * tabulation published later is followed by the waiting list (tender/tender-jobs.js WAITING).
 */
export const MAX_LOOKBACK = Object.freeze({ tenderTabulations: 5 });

/** One line of text, cut to `max` characters. */
function clip(value, max) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

/** "18/11/2026" -> a UTC date, or null. */
function parseDmy(dmy) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(dmy || "").trim());
  if (!m) return null;
  const date = new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])));
  return date.getUTCDate() === Number(m[1]) && date.getUTCMonth() === Number(m[2]) - 1 ? date : null;
}

const dmy = (date) => `${String(date.getUTCDate()).padStart(2, "0")}/${String(date.getUTCMonth() + 1).padStart(2, "0")}/${date.getUTCFullYear()}`;

/** Today in IST as DD/MM/YYYY. */
export function istToday(now = Date.now()) {
  return dmy(new Date(now + 330 * 60000));
}

/**
 * The claim's `params` with its range cut to MAX_LOOKBACK days ending on its dateTo, for a type that has a limit.
 * Any other type, a range already within the limit, or params without a valid range: the params as they are.
 * @param {string} docType
 * @param {{ dateFrom?: string, dateTo?: string }} [params]
 */
export function limitedParams(docType, params = {}) {
  const p = params || {};
  const max = MAX_LOOKBACK[docType];
  const from = max ? parseDmy(p.dateFrom) : null;
  const to = max ? parseDmy(p.dateTo) : null;
  if (!from || !to) return p;
  const earliest = new Date(to.getTime() - (max - 1) * 86400000);
  return from < earliest ? { ...p, dateFrom: dmy(earliest) } : p;
}

/**
 * The first run after a gap searches back at most this many days before its own day (its dateTo): Monday's run
 * reaches the Monday before. Days further back are named as not searched in the run's range.
 */
export const CATCH_UP_DAYS = 7;

/**
 * Whether a scheduled type catches up after a gap: every type that searches the claim's date range. Not Bill
 * Status, CRN and R-NOTE (always the last 90 days), nor ICs from notifications and Correspondence (no range).
 * @param {string} docType
 */
export const catchesUp = (docType) => typeof docType === "string" && !FIXED_LOOKBACK[docType] && !NO_RANGE_TYPES.includes(docType);

/**
 * The claim's `params` searched from `last`, the day of this type's last successful run in this browser, when that
 * day is earlier than the range's own start: the first run after days nobody ran the type (a weekend, a holiday,
 * IREPS logged out overnight) searches those days too. The look-back stays the least a run searches: on a normal day
 * `last` is today or yesterday and the range stays as it is. The start goes back CATCH_UP_DAYS days at most (fewer for
 * a type with a MAX_LOOKBACK), and never moves later than the claim's own start; the days from `last` to the start
 * that are left out are named in `catchUp.notSearched`.
 * A changed range carries `catchUp` ({ last, lookback: the claim's own dateFrom, widened, notSearched? }) for its
 * range text (scheduledSearch); otherwise the params come back as they are.
 * @param {string} docType
 * @param {{ dateFrom?: string, dateTo?: string }} [params]   the claim's, after limitedParams
 * @param {string|null} [last]   "DD/MM/YYYY", null when none is stored
 */
export function caughtUpParams(docType, params = {}, last = null) {
  const p = params || {};
  if (!catchesUp(docType)) return p;
  const from = parseDmy(p.dateFrom);
  const to = parseDmy(p.dateTo);
  const since = parseDmy(last);
  if (!from || !to || !since || from > to || since >= from) return p;
  const back = MAX_LOOKBACK[docType] ? Math.min(CATCH_UP_DAYS, MAX_LOOKBACK[docType] - 1) : CATCH_UP_DAYS;
  const earliest = new Date(to.getTime() - back * 86400000);
  const start = since < earliest ? earliest : since;
  const dateFrom = start < from ? start : from;
  const catchUp = { last: dmy(since), lookback: p.dateFrom, widened: dateFrom < from };
  // the last successful run read its own day only up to its time, so that day is left out too
  if (since < dateFrom) catchUp.notSearched = `${dmy(since)} - ${dmy(new Date(dateFrom.getTime() - 86400000))}`;
  return { ...p, dateFrom: dmy(dateFrom), catchUp };
}

/**
 * How many runs in a row search a gap again when its first run after the gap (a catch-up) left documents not saved.
 * Whatever the reason (IREPS slow, the ECM refusing, a file broken in IREPS), the next runs try them again; a document
 * that can never be saved stops holding the range back after this many (as the tabulation waiting list's FAILS).
 */
export const CATCH_UP_RETRIES = 3;

/** Whether a run left any document not saved, listed or only counted. */
function leftDocuments(outcome) {
  const result = outcome.result && typeof outcome.result === "object" ? outcome.result : {};
  const log = outcome.log && typeof outcome.log === "object" ? outcome.log : {};
  const listed = (list) => Array.isArray(list) && list.length > 0;
  return Number(result.failed) > 0 || Number(result.failuresMore) > 0 || listed(result.failures) || listed(log.failures) || Number(log.more && log.more.failures) > 0;
}

/**
 * What this browser stores as `docType`'s last successful run once a run of `params` ended with `outcome`, given what
 * was stored before (`before`: { day, held }, null: nothing): { day, held }, or null to keep what is stored.
 *   - The run did not read every IREPS list of its range to its end (`outcome.searchedAll` is set by runners.js and
 *     tender-runner.js only when it did: not when it stopped, IREPS logged out, a list was read short): null, so the
 *     next run after a gap searches those days again.
 *   - It read them all and every document was saved or already saved: its dateTo, `held` 0.
 *   - It read them all but left documents not saved: its dateTo as well, unless it was a catch-up (its range started
 *     at the stored day, before the look-back's start) not yet tried again CATCH_UP_RETRIES times. Then the stored
 *     day stays and `held` counts the try, so the next run searches the gap again and retries those documents. A run
 *     within its look-back needs no hold: the next run's look-back searches its days again anyway.
 * A stored day is never moved back (a claim of another Recon server, a clock that is off).
 * @param {string} docType
 * @param {{ dateFrom?: string, dateTo?: string, catchUp?: object }} params   the run's (after caughtUpParams)
 * @param {object} outcome   the run's outcome
 * @param {{ day: string, held?: number }|null} [before]
 * @returns {{ day: string, held: number }|null}
 */
export function lastSuccessAfter(docType, params, outcome, before = null) {
  if (!catchesUp(docType)) return null;
  const p = params || {};
  const to = parseDmy(p.dateTo);
  if (!to || !parseDmy(p.dateFrom)) return null;
  const o = outcome && typeof outcome === "object" ? outcome : {};
  if (o.searchedAll !== true) return null;
  const prevDay = before && typeof before === "object" ? parseDmy(before.day) : null;
  const held = prevDay ? Math.max(0, Math.floor(Number(before.held) || 0)) : 0;
  const caughtUp = Boolean(p.catchUp && typeof p.catchUp === "object" && p.catchUp.widened === true);
  if (prevDay && caughtUp && held < CATCH_UP_RETRIES && leftDocuments(o)) return { day: dmy(prevDay), held: held + 1 };
  return { day: dmy(prevDay && prevDay > to ? prevDay : to), held: 0 };
}

const DMY_RE = /^\d{2}\/\d{2}\/\d{4}$/;
const DMY_SPAN_RE = /^\d{2}\/\d{2}\/\d{4} - \d{2}\/\d{2}\/\d{4}$/;

/** What a catch-up adds to its range's text (caughtUpParams): where it started, or the days it could not reach. */
function catchUpNote(c) {
  if (!c || typeof c !== "object" || !DMY_RE.test(String(c.last))) return "";
  if (DMY_SPAN_RE.test(String(c.notSearched))) return ` (the last successful run was on ${c.last}: ${c.notSearched} not searched)`;
  return c.widened === true && DMY_RE.test(String(c.lookback)) ? ` (from the last successful run; the look-back gave ${c.lookback})` : "";
}

/**
 * The IREPS search of a scheduled run of `docType`, from the claim's `params` ({ dateFrom, dateTo } in
 * DD/MM/YYYY, IST, computed by the Recon Engine):
 *   - Bill Status: IREPS's own "Last 90 Days";
 *   - CRN and R-NOTE: the 90 days up to the claim's dateTo (the Recon Engine's today), the same range
 *     whatever look-back the schedule has;
 *   - ICs from notifications and tender correspondence: no range (what IREPS lists now);
 *   - the other types: the claim's range, after a gap from the last successful run (caughtUpParams).
 * `text` says it in one line for the panel ("Last 90 Days", "21/08/2026 - 18/11/2026", "", "27/11/2026 -
 * 30/11/2026 (from the last successful run; the look-back gave 29/11/2026)").
 * @param {string} docType
 * @param {{ dateFrom?: string, dateTo?: string, catchUp?: object }} [params]
 * @param {number} [now]    only when the claim has no valid dateTo
 * @returns {{ mode?: string, dateFrom?: string, dateTo?: string, text: string }}
 */
export function scheduledSearch(docType, params = {}, now = Date.now()) {
  const p = params || {};
  if (docType === "billStatus") return { mode: "last90Days", text: "Last 90 Days" };
  if (docType === "crn" || docType === "rnote") {
    const to = parseDmy(p.dateTo) || parseDmy(istToday(now));
    const from = new Date(to.getTime() - (EXPORT_LOOKBACK_DAYS - 1) * 86400000);
    return { dateFrom: dmy(from), dateTo: dmy(to), text: `${dmy(from)} - ${dmy(to)}` };
  }
  if (NO_RANGE_TYPES.includes(docType)) return { text: "" };
  const text = p.dateFrom && p.dateTo ? `${p.dateFrom} - ${p.dateTo}${catchUpNote(p.catchUp)}` : "";
  return { dateFrom: p.dateFrom, dateTo: p.dateTo, text };
}

const TENDER_CATEGORY_LABEL = Object.freeze({
  TENDER_PDF: "tender PDF",
  ATTACHMENTS: "NIT attachment",
  MY_OFFER: "My Offer",
  CORRIGENDA: "corrigendum",
  NEGOTIATION: "negotiation letter",
  COUNTER_OFFER: "counter offer letter",
  LOA: "LOA",
  CORRESPONDENCE: "correspondence letter",
  FINANCIAL_TABULATION: "Financial Tabulation",
  COMMERCIAL_TABULATION: "Commercial Tabulation"
});
const EXPORT_LABEL = Object.freeze({ bill_status: "Bill Status", crn: "CRN", rnote: "R-NOTE" });

/**
 * A readable name for a download-log key (services/download-log.js downloadKey), the same words the
 * runs use for their items: "po:123" -> "PO 123", "tender:LOA|10263703|1503282" -> "Tender 10263703 LOA 1503282".
 * @param {string} key
 */
export function labelFromKey(key) {
  const text = String(key || "");
  const colon = text.indexOf(":");
  if (colon < 0) return text;
  const kind = text.slice(0, colon);
  const rest = text.slice(colon + 1);
  const parts = rest.split("|");
  switch (kind) {
    case "po":
      return `PO ${parts[0]}${parts[1] ? ` (${parts[1]})` : ""}`;
    case "ic":
      return `IC ${parts[2] || "?"} (PO ${parts[0] || "?"} Sr. ${parts[1] || "?"})`;
    case "ma":
      return `MA ${parts[1] || "?"} (PO ${parts[0] || "?"})`;
    case "tender":
      return [`Tender ${parts[1] || "?"}`, TENDER_CATEGORY_LABEL[parts[0]] || parts[0], parts[2] && parts[2] !== "-" ? parts[2] : ""].filter(Boolean).join(" ");
    case "pending":
      // pending:<account>|<nitOid>|<corresId>|<letterId>|<file role>
      return `Correspondence letter ${parts[3] || parts[parts.length - 2] || "?"}${parts[parts.length - 1] && parts[parts.length - 1] !== "letter" ? ` (${parts[parts.length - 1]})` : ""}`;
    case "export": {
      const type = rest.split(":")[0];
      return `${EXPORT_LABEL[type] || type} export`;
    }
    default:
      return text;
  }
}

/**
 * One document a scheduled run could not save, kept short and free of secrets.
 * @param {{ doc?: string, key?: string, code?: string, detail?: string|null }} failure
 * @returns {{ doc: string, code: string, detail: string|null }}
 */
export function failureEntry(failure = {}) {
  const f = failure || {};
  const code = String(f.code || "");
  const detail = clip(redact(String(f.detail || "")), DETAIL_MAX);
  return {
    doc: clip(redact(String(f.doc || labelFromKey(f.key) || "document")), DOC_MAX),
    code: CODE_RE.test(code) ? code : "SCHEDULE_DOWNLOAD_FAILED",
    detail: detail || null
  };
}

/** A line of DocLink's own text (a reason, a warning, a range) as a result may carry it: one line, short, redacted. */
export function shortText(value) {
  return typeof value === "string" ? clip(redact(value), DETAIL_MAX) : "";
}

/** A saved or skipped document for the run log: { doc, note }. */
export function docEntry(doc, note = "") {
  const text = clip(redact(String(note || "")), DETAIL_MAX);
  return { doc: clip(redact(String(doc || "document")), DOC_MAX), ...(text ? { note: text } : {}) };
}

const KEY_PREFIX_RE = /^(po|ic|ma|tender|pending|export):/;

/**
 * A document's download-log key (services/download-log.js downloadKey: document numbers, an attachment's file name)
 * as this browser's run log keeps it with a run's documents, so a later run that saved the same document is found
 * (run-log.js notSavedList); "" for anything else. Never sent to the Recon Engine: a slot's result keeps only
 * failureEntry's doc, code and detail.
 */
export function logKey(key) {
  const k = typeof key === "string" ? key : "";
  return KEY_PREFIX_RE.test(k) && k.length <= 300 && ![...k].some((c) => c.charCodeAt(0) < 32) ? k : "";
}

/** A run list's entry with its document's key (logKey), when it has one. */
export const withKey = (entry, key) => (logKey(key) ? { ...entry, key: logKey(key) } : entry);

/** A list kept to LOG_DOCS_MAX entries (the run log counts the rest). */
export const capped = (list, max = LOG_DOCS_MAX) => (Array.isArray(list) ? list.slice(0, max) : []);

/** The most documents a run's `seen` list keeps (what IREPS listed to it: document-ledger.js). */
export const SEEN_MAX = 3000;
/**
 * What became of a document a run's lists named: saved by this run, found already saved (by anyone, by hand or by
 * another run), not saved (with why), or never reached (listed, but the run stopped or could not reserve it).
 */
export const SEEN_STATUS = Object.freeze({ SAVED: "saved", ALREADY: "already", FAILED: "failed", UNREAD: "unread" });
const SEEN_STATUSES = new Set(Object.values(SEEN_STATUS));
const INFO_MAX = 40;
const WHEN_RE = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/;

/** The first value that is text (or a number), one short redacted line; "" when none is. */
function infoText(...values) {
  for (const v of values) {
    const text = typeof v === "number" && Number.isFinite(v) ? String(v) : typeof v === "string" ? v : "";
    if (text.trim()) return clip(redact(text), INFO_MAX);
  }
  return "";
}

/** { date, unit, ic } without the empty ones. */
const infoOf = (date, unit, ic) => Object.fromEntries(Object.entries({ date, unit, ic }).filter(([, v]) => v));

/**
 * What helps find a listed document in IREPS besides the numbers in its name: the date IREPS shows on it (an MA's,
 * PO's or IC's date), its railway unit and an IC's own number, as IREPS printed them. From a download item (`meta`,
 * the ECM fields) or a batch row (its own fields).
 * @param {object} item
 * @returns {{ date?: string, unit?: string, ic?: string }}
 */
export function docInfo(item) {
  const i = item && typeof item === "object" ? item : {};
  const meta = i.meta && typeof i.meta === "object" ? i.meta : {};
  const fields = i.ecm && i.ecm.fields && typeof i.ecm.fields === "object" ? i.ecm.fields : {};
  return infoOf(
    infoText(meta.maDate, meta.poDate, meta.icDate, i.maDate, i.poDate, i.icDate, fields.ic_date),
    infoText(meta.railwayUnit, i.railwayUnit),
    infoText(meta.icNumber, i.icNumber, fields.ic_number)
  );
}

/**
 * One document of a run's `seen` list as it is kept (document-ledger.js): its key (logKey), its name, what helps
 * find it in IREPS (docInfo's fields), what became of it, and by whom / why not; nothing else. null when it is no
 * document (no key and no name, or no known status).
 * @param {{ key?: string, doc?: string, status?: string, info?: object, by?: string, when?: string, code?: string, detail?: string }} value
 */
export function seenEntry(value) {
  const v = value && typeof value === "object" ? value : null;
  if (!v || !SEEN_STATUSES.has(v.status)) return null;
  const key = logKey(v.key);
  const doc = clip(redact(String(v.doc || labelFromKey(key) || "")), DOC_MAX);
  if (!doc) return null;
  const i = v.info && typeof v.info === "object" ? v.info : {};
  const info = infoOf(infoText(i.date), infoText(i.unit), infoText(i.ic));
  const notSaved = v.status === SEEN_STATUS.FAILED || v.status === SEEN_STATUS.UNREAD;
  const code = String(v.code || "");
  const detail = notSaved ? clip(redact(String(v.detail || "")), DETAIL_MAX) : "";
  const by = v.status === SEEN_STATUS.ALREADY ? infoText(v.by) : "";
  return {
    ...(key ? { key } : {}),
    doc,
    status: v.status,
    ...(Object.keys(info).length ? { info } : {}),
    ...(by ? { by } : {}),
    ...(v.status === SEEN_STATUS.ALREADY && WHEN_RE.test(String(v.when || "")) ? { when: v.when } : {}),
    ...(notSaved && CODE_RE.test(code) ? { code } : {}),
    ...(detail ? { detail } : {})
  };
}

/** A run's `seen` list as it is kept: each entry cleaned (seenEntry), SEEN_MAX at most. */
export const seenList = (list) => (Array.isArray(list) ? list.map(seenEntry).filter(Boolean).slice(0, SEEN_MAX) : []);

/**
 * The slot result's share of a failure list: the first RESULT_FAILURES_MAX entries, and how many more.
 * Nothing when the list is empty.
 * @param {object[]} list
 */
export function resultFailures(list) {
  const all = Array.isArray(list) ? list : [];
  if (all.length === 0) return {};
  const more = all.length - RESULT_FAILURES_MAX;
  return { failures: all.slice(0, RESULT_FAILURES_MAX).map(failureEntry), ...(more > 0 ? { failuresMore: more } : {}) };
}

/** The Recon Engine refuses a `finish` whose result is over 16,000 characters of JSON: DocLink stays well under it. */
export const RESULT_MAX_CHARS = 12000;

/**
 * `result` cut to RESULT_MAX_CHARS: failed documents are dropped from the end (and counted in
 * `failuresMore`) until it fits, so a long list can never make the Recon Engine refuse how a run ended.
 * @param {object|null} result
 */
export function fitResult(result) {
  if (!result || typeof result !== "object") return result ?? null;
  let out = result;
  while (JSON.stringify(out).length > RESULT_MAX_CHARS && Array.isArray(out.failures) && out.failures.length > 0) {
    const { failures, failuresMore = 0, ...rest } = out;
    const keep = Math.floor(failures.length / 2);
    out = { ...rest, ...(keep > 0 ? { failures: failures.slice(0, keep) } : {}), failuresMore: failuresMore + failures.length - keep };
  }
  return out;
}

/**
 * Tender error codes (tender/tender-core.js TenderError) -> slot codes (utils/messages.js). IREPS not answering
 * is "IREPS not responding" and an IREPS error page an IREPS text, never the Bill Status or network text.
 */
const TENDER_CODES = Object.freeze({
  SESSION_EXPIRED: "IREPS_SESSION_EXPIRED",
  ACCOUNT_CHANGED: "SCHEDULE_ACCOUNT_MISMATCH",
  ACCOUNT_MISMATCH: "SCHEDULE_ACCOUNT_MISMATCH",
  ACCOUNT: "SCHEDULE_ACCOUNT_UNVERIFIED",
  TIMEOUT: "IREPS_UNAVAILABLE",
  UNREACHABLE: "IREPS_UNAVAILABLE",
  HTTP: "SCHEDULE_IREPS_ERROR",
  PAGE: "TENDER_PAGE_NOT_RECOGNISED",
  PARSE: "TENDER_PAGE_NOT_RECOGNISED",
  LIST: "TENDER_LIST_FAILED",
  SEARCH_INCOMPLETE: "TENDER_SEARCH_INCOMPLETE",
  BLOCKED: "TENDER_REQUEST_BLOCKED",
  EXCLUDED: "TENDER_REQUEST_BLOCKED",
  LOA_SCRIPT: "TENDER_LOA_SCRIPT_UNREADABLE"
});

/**
 * The slot code of a tender job's error code (a SCHEDULE_* / ECM_* / RECON_* / IREPS_* / TENDER_* code passes as
 * it is). `fallback`: the code of anything else - a run that stopped (SCHEDULE_TENDER_FAILED), or one document
 * that was not downloaded (SCHEDULE_DOWNLOAD_FAILED).
 */
export function tenderCode(code, fallback = "SCHEDULE_TENDER_FAILED") {
  const c = String(code || "");
  if (TENDER_CODES[c]) return TENDER_CODES[c];
  if (/^(SCHEDULE|ECM|RECON|IREPS|TENDER)_[A-Z0-9_]+$/.test(c)) return c;
  return fallback;
}

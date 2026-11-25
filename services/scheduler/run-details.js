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
export const MAX_LOOKBACK = Object.freeze({ tenderTabulations: 7 });

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
 * The IREPS search of a scheduled run of `docType`, from the claim's `params` ({ dateFrom, dateTo } in
 * DD/MM/YYYY, IST, computed by the Recon Engine):
 *   - Bill Status: IREPS's own "Last 90 Days";
 *   - CRN and R-NOTE: the 90 days up to the claim's dateTo (the Recon Engine's today), the same range
 *     whatever look-back the schedule has;
 *   - ICs from notifications and tender correspondence: no range (what IREPS lists now);
 *   - the other types: the claim's range.
 * `text` says it in one line for the panel ("Last 90 Days", "21/08/2026 - 18/11/2026", "").
 * @param {string} docType
 * @param {{ dateFrom?: string, dateTo?: string }} [params]
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
  const text = p.dateFrom && p.dateTo ? `${p.dateFrom} - ${p.dateTo}` : "";
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

/** A list kept to LOG_DOCS_MAX entries (the run log counts the rest). */
export const capped = (list, max = LOG_DOCS_MAX) => (Array.isArray(list) ? list.slice(0, max) : []);

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

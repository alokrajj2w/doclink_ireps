/**
 * IREPS main-page notifications ("My Activities"), read-only.
 *
 *   POST /epsn/vndr/activity/ajax.do   ajaxMode=getMyActivitesData
 *   -> JSON { nl: [ { MESSAGE, SUBJECT, NOTIFICATION_ID, NOTIFICATION_DT, DATED, REF_ID, ... } ], ... }
 *
 * This is the same call the IREPS home page makes. Only the entries it
 * returns are processed; no further notification endpoint is invented.
 *
 * An "IC issued" notification looks like
 *   SUBJECT "Inspection"
 *   MESSAGE "IC issued for PONo : <PO number> , POSrNo : <PO serial>"
 * LOA, negotiation and every other notification are ignored.
 * Identifier values are kept exactly as printed (leading zeros included).
 */

import { IrepsError, IREPS_ERROR, requestIreps } from "../ireps-api.js";
import { isIrepsLoginPage } from "../session-service.js";
import { withRetry } from "../batch-utils.js";

export const NOTIFICATION_CONFIG = Object.freeze({
  endpoint: "/epsn/vndr/activity/ajax.do",
  ajaxModeField: "ajaxMode",
  ajaxModeValue: "getMyActivitesData"
});

export const NOTIFICATION_ERROR = Object.freeze({
  SESSION_EXPIRED: IREPS_ERROR.SESSION_EXPIRED,
  REQUEST_FAILED: "IREPS_NOTIFICATIONS_FAILED",
  INVALID_RESPONSE: "IREPS_NOTIFICATIONS_INVALID"
});

/** "IC issued" - tolerant of case and spacing ("IC  Issued", "ic issued"). */
const IC_ISSUED_RE = /\bI\.?C\.?\s+issued\b/i;
/** "PONo : X , POSrNo : Y" - tolerant of case, spaces, ":"/"-"/"=" and ","/";" separators. */
const PO_NO_RE = /\bPO\s*No\.?\s*[:=\-]?\s*([A-Za-z0-9][A-Za-z0-9/\-_.]*)/i;
const PO_SR_RE = /\bPO\s*Sr\.?\s*No\.?\s*[:=\-]?\s*([A-Za-z0-9]+)/i;

/**
 * Parse the body of getMyActivitesData into notifications.
 * @param {string} text  response body
 * @returns {object[]}   the `nl` entries (may be empty)
 * @throws {IrepsError} session expired / malformed JSON
 */
export function parseNotificationResponse(text, response = {}) {
  const body = String(text || "");
  let json;
  try {
    json = JSON.parse(body);
  } catch (error) {
    if (isIrepsLoginPage(body, response)) throw new IrepsError(NOTIFICATION_ERROR.SESSION_EXPIRED, "IREPS answered the notification request with its login page");
    throw new IrepsError(NOTIFICATION_ERROR.INVALID_RESPONSE, "Notification response was not valid JSON", { detail: "IREPS returned an unreadable notification list", cause: error });
  }
  if (!json || typeof json !== "object") throw new IrepsError(NOTIFICATION_ERROR.INVALID_RESPONSE, "Notification response had no object", { detail: "IREPS returned an unreadable notification list" });
  return Array.isArray(json.nl) ? json.nl.filter((n) => n && typeof n === "object") : [];
}

/** Fetch the current notifications with the browser session. */
export async function fetchNotifications(deps = {}) {
  const body = new URLSearchParams();
  body.set(NOTIFICATION_CONFIG.ajaxModeField, NOTIFICATION_CONFIG.ajaxModeValue);
  let response;
  try {
    response = await withRetry(() => requestIreps({ path: NOTIFICATION_CONFIG.endpoint, method: "POST", body: body.toString() }, { fetch: deps.fetch }), { attempts: 3, sleep: deps.sleep, delayMs: deps.retryDelayMs });
  } catch (error) {
    if (error instanceof IrepsError && error.code === IREPS_ERROR.REQUEST_FAILED) {
      throw new IrepsError(NOTIFICATION_ERROR.REQUEST_FAILED, "Could not load the IREPS notifications", { status: error.status, reason: error.reason, detail: error.detail, cause: error });
    }
    throw error;
  }
  return parseNotificationResponse(response.html, response);
}

/** Does this notification say an Inspection Certificate was issued? */
export function isIcIssuedNotification(n) {
  const message = String((n && n.MESSAGE) || "");
  const subject = String((n && n.SUBJECT) || "");
  // SUBJECT narrows to the Inspection category; a missing SUBJECT falls back to the message alone.
  const subjectOk = subject === "" || /inspection/i.test(subject);
  return subjectOk && IC_ISSUED_RE.test(message);
}

/**
 * Extract the identifiers of one IC-issued notification. PO number and PO
 * serial are never guessed: when either is missing `poNo` / `poSerial` is null.
 * @param {object} n  one `nl` entry
 */
export function parseIcNotification(n) {
  const message = String((n && n.MESSAGE) || "");
  // "POSrNo" never satisfies PO_NO_RE ("PO" + "Sr" + "No"), so the two are independent.
  const po = PO_NO_RE.exec(message);
  const sr = PO_SR_RE.exec(message);
  return {
    notificationId: n && n.NOTIFICATION_ID != null ? String(n.NOTIFICATION_ID) : null,
    refId: n && n.REF_ID != null ? String(n.REF_ID) : null,
    date: (n && (n.DATED || n.NOTIFICATION_DT)) || null,
    subject: String((n && n.SUBJECT) || ""),
    message,
    poNo: po ? po[1].replace(/[.\-_/]+$/, "") : null,
    poSerial: sr ? sr[1] : null
  };
}

/**
 * Split raw notifications into IC-issued ones (parsed) and counts.
 * @param {object[]} list
 * @returns {{ inspected: number, icNotifications: object[], ignored: number }}
 */
export function selectIcNotifications(list) {
  const icNotifications = [];
  for (const n of list || []) {
    if (isIcIssuedNotification(n)) icNotifications.push(parseIcNotification(n));
  }
  return { inspected: (list || []).length, icNotifications, ignored: (list || []).length - icNotifications.length };
}

/**
 * Small helpers shared by the two batch download workflows (PO by date,
 * IC from notifications): bounded retry for transient failures and
 * DD/MM/YYYY date arithmetic.
 */

import { IrepsError, IREPS_ERROR, MAX_DATE_RANGE_DAYS, parseIrepsDate } from "./ireps-api.js";

const DAY_MS = 24 * 3600 * 1000;

/**
 * Is this failure worth retrying? Network errors, timeouts and HTTP 5xx are;
 * an expired session, bad input or a "not a PDF" answer never is.
 * @param {unknown} error
 */
export function isTransientError(error) {
  if (!(error instanceof IrepsError)) return false;
  if (error.code === IREPS_ERROR.SESSION_EXPIRED) return false;
  if (error.reason === "network" || error.reason === "timeout") return true;
  if (error.reason === "http" && error.status >= 500) return true;
  return false;
}

/**
 * Run `task` up to `attempts` times, retrying only transient failures.
 * Authentication errors are never retried.
 * @template T
 * @param {() => Promise<T>} task
 * @param {{ attempts?: number, delayMs?: number, sleep?: (ms: number) => Promise<void> }} [options]
 * @returns {Promise<T>}
 */
export async function withRetry(task, options = {}) {
  const attempts = Math.max(1, Number(options.attempts) || 3);
  const delayMs = options.delayMs ?? 400;
  const sleep = options.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !isTransientError(error)) throw error;
      await sleep(delayMs * attempt);
    }
  }
  throw lastError;
}

/** Date -> "DD/MM/YYYY" (UTC fields, as parseIrepsDate() builds UTC dates). */
export function formatIrepsDate(date) {
  return `${String(date.getUTCDate()).padStart(2, "0")}/${String(date.getUTCMonth() + 1).padStart(2, "0")}/${date.getUTCFullYear()}`;
}

/** "DD/MM/YYYY" -> "YYYY-MM-DD", or null when not a real date. */
export function irepsDateToIso(text) {
  const d = parseIrepsDate(text);
  return d ? d.toISOString().slice(0, 10) : null;
}

/** "YYYY-MM-DD" (an <input type="date"> value) -> "DD/MM/YYYY", or null. */
export function isoToIrepsDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || "").trim());
  if (!m) return null;
  const text = `${m[3]}/${m[2]}/${m[1]}`;
  return parseIrepsDate(text) ? text : null;
}

/**
 * Split an inclusive DD/MM/YYYY range into windows IREPS accepts (its own
 * script rejects a span of more than 180 days between From and To).
 * A range that already fits is returned as a single window.
 *
 * @param {string} dateFrom
 * @param {string} dateTo
 * @param {number} [maxSpanDays]  largest (To - From) allowed per window
 * @returns {{ dateFrom: string, dateTo: string }[]}
 */
export function splitDateRange(dateFrom, dateTo, maxSpanDays = MAX_DATE_RANGE_DAYS) {
  const from = parseIrepsDate(dateFrom);
  const to = parseIrepsDate(dateTo);
  if (!from || !to || from > to) return [];
  const windows = [];
  let start = from.getTime();
  const end = to.getTime();
  while (start <= end) {
    const stop = Math.min(start + maxSpanDays * DAY_MS, end);
    windows.push({ dateFrom: formatIrepsDate(new Date(start)), dateTo: formatIrepsDate(new Date(stop)) });
    start = stop + DAY_MS;
  }
  return windows;
}

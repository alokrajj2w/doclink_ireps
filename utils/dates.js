/**
 * Date helpers for the side panel (popup/, tender/): <input type="date"> values are
 * "YYYY-MM-DD" in the user's local time zone, IREPS forms take "DD/MM/YYYY".
 * The service side has its own UTC-based helpers (services/batch-utils.js).
 */

const pad = (n) => String(n).padStart(2, "0");

/** A Date's local calendar day as "YYYY-MM-DD" (the value an <input type="date"> shows). */
export function localIsoDate(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * An <input type="date"> value ("YYYY-MM-DD", always a real day) -> "DD/MM/YYYY"; "" for an empty input. Dates from
 * other sources (an ECM invoice date) go through services/bill-upload/bill-rules.js invoiceDateToIreps instead.
 */
export function toIrepsDate(isoDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate || "");
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
}

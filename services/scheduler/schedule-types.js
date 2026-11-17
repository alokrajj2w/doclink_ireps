/**
 * The document types of Phase 1 scheduled downloads, and the `schedular_phase1` block of
 * config.json that switches scheduling on and names the types this DocLink may trigger.
 *
 * Two vocabularies meet here:
 *   - the names in config.json (`documents`): BillStatus, CRN, RNote, MA, PO, IC;
 *   - the schedule types of the Recon Engine (Appendix A of schedular_implementation_plan.md):
 *     billStatus, crn, rnote, ma, poDate, icDate, icNotifications.
 * "IC" stands for both IC runs (by IC date and from notifications).
 */

/** Schedule types in the order they run when several are due for one account. */
export const SCHEDULE_TYPES = Object.freeze(["billStatus", "crn", "rnote", "ma", "poDate", "icDate", "icNotifications"]);

/** Where each type is saved: exports to the Recon Engine's S3, PDFs to the ECM. Never local. */
export const SCHEDULE_DESTINATION = Object.freeze({
  billStatus: "s3",
  crn: "s3",
  rnote: "s3",
  ma: "ecm",
  poDate: "ecm",
  icDate: "ecm",
  icNotifications: "ecm"
});

const ONCE_A_MORNING = Object.freeze({ window_start: "09:00", window_end: "10:00", check_every_minutes: 10, repeat_every_minutes: null });
const HOURLY = Object.freeze({ window_start: "09:00", window_end: "18:00", check_every_minutes: 15, repeat_every_minutes: 60 });

/**
 * A new schedule's timing, as the Recon Engine makes it (schedules.py TIMING_DEFAULT): the exports
 * once between 09:00 and 10:00 IST, checked every 10 minutes until done; the PDFs every hour from
 * 09:00 to 18:00 (runs start at 09:00, 10:00 ... 18:00, window_end included), each run fetching what
 * is new, retried every 15 minutes within its hour.
 * repeat_every_minutes null = once a day.
 */
export const SCHEDULE_DEFAULT_TIMING = Object.freeze({
  billStatus: ONCE_A_MORNING,
  crn: ONCE_A_MORNING,
  rnote: ONCE_A_MORNING,
  ma: HOURLY,
  poDate: HOURLY,
  icDate: HOURLY,
  icNotifications: HOURLY
});

/** How each type reads in the panel. */
export const SCHEDULE_TYPE_LABEL = Object.freeze({
  billStatus: "Bill Status",
  crn: "CRN",
  rnote: "R-NOTE",
  ma: "MA copies",
  poDate: "POs by PO date",
  icDate: "ICs by IC date",
  icNotifications: "ICs from notifications"
});

/** config.json `documents` names -> schedule types (matched without regard to case). */
export const CONFIG_DOCUMENT_TYPES = Object.freeze({
  BillStatus: ["billStatus"],
  CRN: ["crn"],
  RNote: ["rnote"],
  MA: ["ma"],
  PO: ["poDate"],
  IC: ["icDate", "icNotifications"]
});

const BY_LOWER_NAME = new Map(Object.entries(CONFIG_DOCUMENT_TYPES).map(([name, types]) => [name.toLowerCase(), types]));

/**
 * The scheduler settings from the merged config (config.json with config.local.json over it).
 * Fails closed: scheduling is on only when `enabled` is the JSON value true AND `documents`
 * names at least one known type. Unknown names are returned so they can be reported.
 * @param {object|null|undefined} config
 * @returns {{ enabled: boolean, types: string[], unknown: string[], reason: string|null }}
 *          types: schedule types in run order; reason: why it is off (null when on)
 */
export function parseSchedulerConfig(config) {
  const block = config && typeof config === "object" ? config.schedular_phase1 : undefined;
  const off = (reason, unknown = []) => ({ enabled: false, types: [], unknown, reason });
  if (!block || typeof block !== "object" || Array.isArray(block)) return off("schedular_phase1 is not set");
  const documents = block.documents;
  const unknown = [];
  const wanted = new Set();
  if (Array.isArray(documents)) {
    for (const raw of documents) {
      const name = typeof raw === "string" ? raw.trim() : "";
      const types = BY_LOWER_NAME.get(name.toLowerCase());
      if (types) types.forEach((t) => wanted.add(t));
      else unknown.push(String(raw));
    }
  }
  if (block.enabled !== true) return off("schedular_phase1.enabled is not true", unknown);
  if (!Array.isArray(documents)) return off("schedular_phase1.documents is not a list", unknown);
  const types = SCHEDULE_TYPES.filter((t) => wanted.has(t));
  if (types.length === 0) return off("schedular_phase1.documents names no known document type", unknown);
  return { enabled: true, types, unknown, reason: null };
}

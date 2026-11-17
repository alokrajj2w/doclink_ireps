/**
 * The document types of scheduled downloads, and the two config.json blocks that switch scheduling
 * on and name the types this DocLink may trigger: `schedular_phase1` (non-tender documents) and
 * `schedular_phase2` (tender documents).
 *
 * Two vocabularies meet here:
 *   - the names in config.json (`documents`): BillStatus, CRN, RNote, MA, PO, IC (phase 1);
 *     NIT, CounterOffer, LOA, Tabulation, Correspondence, Negotiation (phase 2);
 *   - the schedule types of the Recon Engine (Appendix A of schedular_implementation_plan.md):
 *     billStatus, crn, rnote, ma, poDate, icDate, icNotifications, and the tender* types.
 * "IC" stands for both IC runs (by IC date and from notifications); "Tabulation" for the Financial
 * and the Commercial Tabulation.
 */

/** Phase 2: tender documents, run in a background DocLink tab (tender/schedule-runner.js). */
export const TENDER_SCHEDULE_TYPES = Object.freeze(["tenderNit", "tenderCounterOffer", "tenderLoa", "tenderTabulations", "tenderCorrespondence", "tenderNegotiation"]);

/** Schedule types in the order they run when several are due for one account. */
export const SCHEDULE_TYPES = Object.freeze(["billStatus", "crn", "rnote", "ma", "poDate", "icDate", "icNotifications", ...TENDER_SCHEDULE_TYPES]);

/** Whether `type` is a tender (Phase 2) schedule type. */
export const isTenderScheduleType = (type) => TENDER_SCHEDULE_TYPES.includes(type);

/** Where each type is saved: exports to the Recon Engine's S3, PDFs to the ECM. Never local. */
export const SCHEDULE_DESTINATION = Object.freeze({
  billStatus: "s3",
  crn: "s3",
  rnote: "s3",
  ma: "ecm",
  poDate: "ecm",
  icDate: "ecm",
  icNotifications: "ecm",
  ...Object.fromEntries(TENDER_SCHEDULE_TYPES.map((t) => [t, "ecm"]))
});

const ONCE_A_MORNING = Object.freeze({ window_start: "09:00", window_end: "10:00", check_every_minutes: 10, repeat_every_minutes: null });
const HOURLY = Object.freeze({ window_start: "09:00", window_end: "18:00", check_every_minutes: 15, repeat_every_minutes: 60 });
const TENDER_HOURLY = Object.freeze({ window_start: "10:30", window_end: "18:30", check_every_minutes: 15, repeat_every_minutes: 60 });
const NEGOTIATION = Object.freeze({ window_start: "12:30", window_end: "18:30", check_every_minutes: 30, repeat_every_minutes: 180 });

/**
 * A new schedule's timing, as the Recon Engine makes it (schedules.py TIMING_DEFAULT): the exports
 * once between 09:00 and 10:00 IST, checked every 10 minutes until done; the PDFs every hour from
 * 09:00 to 18:00 (runs start at 09:00, 10:00 ... 18:00, window_end included), each run fetching what
 * is new, retried every 15 minutes within its hour; the tender documents every hour from 10:30 to
 * 18:30, except Negotiation (its IREPS pages are very slow): 12:30, 15:30 and 18:30.
 * repeat_every_minutes null = once a day.
 */
export const SCHEDULE_DEFAULT_TIMING = Object.freeze({
  billStatus: ONCE_A_MORNING,
  crn: ONCE_A_MORNING,
  rnote: ONCE_A_MORNING,
  ma: HOURLY,
  poDate: HOURLY,
  icDate: HOURLY,
  icNotifications: HOURLY,
  ...Object.fromEntries(TENDER_SCHEDULE_TYPES.map((t) => [t, TENDER_HOURLY])),
  tenderNegotiation: NEGOTIATION
});

/** How each type reads in the panel. */
export const SCHEDULE_TYPE_LABEL = Object.freeze({
  billStatus: "Bill Status",
  crn: "CRN",
  rnote: "R-NOTE",
  ma: "MA copies",
  poDate: "POs by PO date",
  icDate: "ICs by IC date",
  icNotifications: "ICs from notifications",
  tenderNit: "Tender NIT documents",
  tenderCounterOffer: "Counter Offer letters",
  tenderLoa: "LOA letters",
  tenderTabulations: "Financial / Commercial Tabulations",
  tenderCorrespondence: "Tender correspondence",
  tenderNegotiation: "Negotiation letters"
});

/** config.json `schedular_phase1.documents` names -> schedule types (matched without regard to case). */
export const CONFIG_DOCUMENT_TYPES = Object.freeze({
  BillStatus: ["billStatus"],
  CRN: ["crn"],
  RNote: ["rnote"],
  MA: ["ma"],
  PO: ["poDate"],
  IC: ["icDate", "icNotifications"]
});

/** config.json `schedular_phase2.documents` names -> tender schedule types. */
export const CONFIG_TENDER_DOCUMENT_TYPES = Object.freeze({
  NIT: ["tenderNit"],
  CounterOffer: ["tenderCounterOffer"],
  LOA: ["tenderLoa"],
  Tabulation: ["tenderTabulations"],
  Correspondence: ["tenderCorrespondence"],
  Negotiation: ["tenderNegotiation"]
});

const byLowerName = (names) => new Map(Object.entries(names).map(([name, types]) => [name.toLowerCase(), types]));
const PHASES = Object.freeze([
  { key: "schedular_phase1", names: byLowerName(CONFIG_DOCUMENT_TYPES) },
  { key: "schedular_phase2", names: byLowerName(CONFIG_TENDER_DOCUMENT_TYPES) }
]);

/** One block: { present, enabled, types, unknown, reason } (fails closed like the whole). */
function parsePhase(config, { key, names }) {
  const block = config && typeof config === "object" ? config[key] : undefined;
  const off = (reason, unknown = []) => ({ present: block !== undefined && block !== null, enabled: false, types: [], unknown, reason });
  if (!block || typeof block !== "object" || Array.isArray(block)) return off(`${key} is not set`);
  const documents = block.documents;
  const unknown = [];
  const wanted = new Set();
  if (Array.isArray(documents)) {
    for (const raw of documents) {
      const name = typeof raw === "string" ? raw.trim() : "";
      const types = names.get(name.toLowerCase());
      if (types) types.forEach((t) => wanted.add(t));
      else unknown.push(String(raw));
    }
  }
  if (block.enabled !== true) return off(`${key}.enabled is not true`, unknown);
  if (!Array.isArray(documents)) return off(`${key}.documents is not a list`, unknown);
  const types = SCHEDULE_TYPES.filter((t) => wanted.has(t));
  if (types.length === 0) return off(`${key}.documents names no known document type`, unknown);
  return { present: true, enabled: true, types, unknown, reason: null };
}

/**
 * The scheduler settings from the merged config (config.json with config.local.json over it).
 * Each block (schedular_phase1, schedular_phase2) fails closed on its own: it is on only when its
 * `enabled` is the JSON value true AND its `documents` names at least one known type of that phase.
 * Scheduling is on when either is. Unknown names are returned so they can be reported.
 * @param {object|null|undefined} config
 * @returns {{ enabled: boolean, types: string[], unknown: string[], reason: string|null }}
 *          types: schedule types in run order; reason: why it is off (null when on)
 */
export function parseSchedulerConfig(config) {
  const [one, two] = PHASES.map((phase) => parsePhase(config, phase));
  const unknown = [...one.unknown, ...two.unknown];
  if (!one.enabled && !two.enabled) {
    const reason = two.present ? `${one.reason}; ${two.reason}` : one.reason;
    return { enabled: false, types: [], unknown, reason };
  }
  const wanted = new Set([...one.types, ...two.types]);
  return { enabled: true, types: SCHEDULE_TYPES.filter((t) => wanted.has(t)), unknown, reason: null };
}

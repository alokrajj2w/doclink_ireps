/**
 * What IREPS listed to this browser's scheduled downloads, document by document: My Downloads > Missed documents
 * (popup/popup-missed.js). The client asked for it on 27 Nov 2026: how many documents IREPS had, how many DocLink
 * downloaded (by its schedule, or earlier: by hand in DocLink or by another DocLink) and which it missed, with what a
 * user needs to download a missed one in IREPS by hand.
 *
 * Every scheduled run of a document type hands over `seen` (shared-run-hooks.js details()): each document its IREPS
 * lists named, with what became of it. A document is kept once per IREPS account, under the day DocLink first found
 * it (the run's day: its slot's date, run-log.js runDay), with:
 *   - status: "saved" (a scheduled run here saved it), "already" (someone had saved it: by hand in DocLink, or
 *     another DocLink), "failed" (the last reason, and `tries`: how many runs could not save it) or "unread" (listed,
 *     but no run reached it: a reservation that failed, a run that stopped);
 *   - first / last: when a run first and last listed it.
 * A document once saved stays saved. One not saved is MISSED once a later run of its type read every list of its
 * range (runners' searchedAll) without listing it: DocLink no longer finds it (its date left the look-back, or IREPS
 * no longer lists it), so no run tries it again and it must be downloaded in IREPS. Until then it is "not saved
 * yet": the next run tries again (docState).
 *
 * Bill Status, CRN and R-NOTE are not kept: their export is no document IREPS lists, and the next export holds the
 * rows of a day whose export failed (My Downloads > Scheduled runs shows those runs).
 *
 * Kept: the documents of the last LEDGER_DAYS days with documents and the days between, the runs of those days, and
 * each type's newest complete search (docState needs it); MAX_LEDGER_CHARS bounds it, the oldest day going first.
 * Loading a build keeps it, unless it was recorded against another Recon Engine server (keepServer). Kept in
 * chrome.storage.local; the worker is the only writer and every change runs after the one before; a ledger that
 * cannot be read is never written over. Only document numbers, keys, dates and railway units as IREPS shows them,
 * codes and DocLink's own texts (run-details.js seenEntry): never a URL, an IREPS page, a token or a cookie.
 */

import { STORAGE_KEYS, describeError } from "../../utils/messages.js";
import { seenList, SEEN_STATUS, FIXED_LOOKBACK } from "./run-details.js";
import { SCHEDULE_TYPES, SCHEDULE_TYPE_LABEL } from "./schedule-types.js";
import { istDateTime } from "./run-log.js";
import { logger } from "../../utils/logger.js";

/** The days with documents the ledger keeps (and the days between). */
export const LEDGER_DAYS = 3;
export const MAX_LEDGER_DOCS = 8000;
export const MAX_LEDGER_RUNS = 600;
/** The stored ledger stays under this many characters of JSON (each change rewrites it). */
export const MAX_LEDGER_CHARS = 1500000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const RESOLVED = new Set([SEEN_STATUS.SAVED, SEEN_STATUS.ALREADY]);

const emptyLedger = () => ({ recon: "", docs: [], runs: [] });
const isDoc = (d) => Boolean(d) && typeof d === "object" && typeof d.id === "string" && typeof d.account === "string" && DAY_RE.test(String(d.day || ""));
const isRun = (r) => Boolean(r) && typeof r === "object" && typeof r.type === "string" && typeof r.account === "string" && DAY_RE.test(String(r.day || ""));

/** The stored value as a ledger (anything else reads as empty). */
function asLedger(value) {
  if (!value || typeof value !== "object") return emptyLedger();
  return {
    recon: typeof value.recon === "string" ? value.recon : "",
    docs: Array.isArray(value.docs) ? value.docs.filter(isDoc) : [],
    runs: Array.isArray(value.runs) ? value.runs.filter(isRun) : []
  };
}

/** Whether a schedule type's runs list documents IREPS shows (not the Bill Status, CRN and R-NOTE exports). */
export const listsDocuments = (type) => SCHEDULE_TYPES.includes(type) && !FIXED_LOOKBACK[type];

/** A document's identity in the ledger (per IREPS account): its key, else its type and name. */
const docIdOf = (type, entry) => entry.key || `${type}|${entry.doc}`;

/** What one run's entry `s` (seenEntry) changes about the kept document `d`, listed by that run at `at`. */
function merge(d, s, at) {
  if (at > d.last) d.last = at;
  if (s.info) d.info = { ...(d.info || {}), ...s.info };
  // saved once is saved: a later run only finds it already saved
  if (RESOLVED.has(d.status)) return;
  if (s.status === SEEN_STATUS.SAVED) Object.assign(d, { status: s.status, savedAt: at });
  else if (s.status === SEEN_STATUS.ALREADY) Object.assign(d, { status: s.status, ...(s.by ? { by: s.by } : {}), ...(s.when ? { when: s.when } : {}) });
  else if (s.status === SEEN_STATUS.FAILED) {
    Object.assign(d, { status: s.status, code: s.code || "SCHEDULE_DOWNLOAD_FAILED", detail: s.detail || null, tries: (Number(d.tries) || 0) + 1, triedAt: at });
  } else if (d.status !== SEEN_STATUS.FAILED) {
    // listed but not reached: the reason a run gave before, if any, stays the reason
    Object.assign(d, { status: SEEN_STATUS.UNREAD, ...(s.code ? { code: s.code } : {}), ...(s.detail ? { detail: s.detail } : {}) });
  }
}

const sizeOf = (value) => JSON.stringify(value).length + 1;

/**
 * The ledger as it is kept (see the top of this file): the documents of the last LEDGER_DAYS days with documents and
 * the days between, the runs from the oldest of those days on plus each account's and type's newest complete search,
 * then MAX_LEDGER_DOCS / MAX_LEDGER_RUNS, then MAX_LEDGER_CHARS (the oldest day first). Lists stay newest first.
 * @param {{ recon?: string, docs: object[], runs: object[] }} value
 */
export function keptLedger(value) {
  const { recon, docs: allDocs, runs: allRuns } = asLedger(value);
  const days = [...new Set(allDocs.map((d) => d.day))].sort().reverse().slice(0, LEDGER_DAYS);
  const floor = days.length ? days[days.length - 1] : "";
  let docs = allDocs.filter((d) => d.day >= floor).slice(0, MAX_LEDGER_DOCS);
  const newestFull = new Set();
  let runs = allRuns.filter((r) => {
    const id = `${r.account}|${r.type}`;
    const newest = r.full === true && !newestFull.has(id);
    if (r.full === true) newestFull.add(id);
    return r.day >= floor || newest;
  }).slice(0, MAX_LEDGER_RUNS);
  // too big: the oldest day goes first, then (one day left) its oldest documents
  while (sizeOf({ recon, docs, runs }) > MAX_LEDGER_CHARS && docs.length > 0) {
    const kept = [...new Set(docs.map((d) => d.day))].sort();
    if (kept.length > 1) {
      docs = docs.filter((d) => d.day !== kept[0]);
      runs = runs.filter((r) => r.day !== kept[0]);
    } else docs = docs.slice(0, Math.floor(docs.length * 0.9));
  }
  return { recon, docs, runs };
}

/**
 * @param {{ storage?: chrome.storage.StorageArea, recon?: () => string }} [deps]
 *        recon: the Recon Engine server (origin) the documents are recorded against ("" when not known)
 */
export function createDocumentLedger(deps = {}) {
  const storage = deps.storage || chrome.storage.local;
  const recon = () => {
    try {
      return String((deps.recon && deps.recon()) || "");
    } catch {
      return "";
    }
  };
  const key = STORAGE_KEYS.SCHEDULER_DOCUMENTS;
  let chain = Promise.resolve();

  async function load() {
    try {
      return asLedger((await storage.get(key))[key]);
    } catch (error) {
      logger.debug("Scheduler: document ledger not read", error);
      return emptyLedger();
    }
  }

  /**
   * Apply `change` after every earlier change; a `change` that returns false changed nothing. Never throws: the
   * ledger never stops a run. A ledger that cannot be read is not written: its days would be lost.
   */
  function update(change) {
    chain = chain
      .then(async () => {
        const ledger = asLedger((await storage.get(key))[key]);
        if (change(ledger) === false) return;
        await storage.set({ [key]: keptLedger(ledger) });
      })
      .catch((error) => logger.debug("Scheduler: document ledger not written", error));
    return chain;
  }

  return {
    /** The documents and runs of one IREPS account, newest first: { docs, runs }. */
    read: (account) => chain.then(load).then((l) => ({ docs: l.docs.filter((d) => d.account === String(account)), runs: l.runs.filter((r) => r.account === String(account)) })),
    /**
     * A scheduled run ended: what its IREPS lists named (`seen`) and whether it read every list of its range (`full`).
     * Types without documents (the exports) are not kept.
     * @param {{ account: string, type: string, day: string, at: string, full: boolean, seen: object[] }} run
     */
    recordRun({ account, type, day, at, full, seen }) {
      if (!account || !listsDocuments(type) || !DAY_RE.test(String(day || "")) || !Number.isFinite(Date.parse(at || ""))) return chain;
      const entries = seenList(seen);
      const acct = String(account);
      return update((ledger) => {
        const server = recon();
        // recorded against another Recon Engine server: those documents are not this server's
        if (server && ledger.recon && ledger.recon !== server) Object.assign(ledger, emptyLedger());
        if (server) ledger.recon = server;
        const byId = new Map(ledger.docs.filter((d) => d.account === acct).map((d) => [d.id, d]));
        for (const s of entries) {
          const id = docIdOf(type, s);
          let d = byId.get(id);
          if (!d) {
            d = { account: acct, type, id, ...(s.key ? { key: s.key } : {}), doc: s.doc, day, first: at, last: at, status: SEEN_STATUS.UNREAD, tries: 0 };
            ledger.docs.unshift(d);
            byId.set(id, d);
          }
          merge(d, s, at);
        }
        ledger.runs.unshift({ account: acct, type, day, at, full: full === true, listed: entries.length });
      });
    },
    /**
     * A build was loaded: keep the ledger when it was recorded against this Recon Engine server, else start afresh.
     * Nothing changes while the server is not known.
     * @param {string} server
     */
    keepServer(server) {
      if (!server) return chain;
      return update((ledger) => {
        if (ledger.recon === server) return false;
        if (ledger.recon) Object.assign(ledger, emptyLedger());
        ledger.recon = server;
      });
    },
    clear: () => update((ledger) => Object.assign(ledger, emptyLedger()))
  };
}

/* ------------------------------------------------------------------ what the panel and the workbook show */

/** What a document's row says (docState). */
export const DOC_STATE = Object.freeze({ SCHEDULED: "scheduled", ALREADY: "already", BY_HAND: "byHand", MISSED: "missed", PENDING: "pending" });
const DOWNLOADED = new Set([DOC_STATE.SCHEDULED, DOC_STATE.ALREADY, DOC_STATE.BY_HAND]);

/** Each account's and type's newest complete search: "<account>|<type>" -> its start (ISO). */
export function newestFullSearch(runs) {
  const newest = new Map();
  for (const r of Array.isArray(runs) ? runs : []) {
    const id = `${r.account}|${r.type}`;
    if (r.full === true && !(newest.get(id) >= r.at)) newest.set(id, r.at);
  }
  return newest;
}

/**
 * Saved by the schedule here, already saved, downloaded by you since (`byHand`: the download log's answer for its
 * key), missed (a later complete search of its type did not list it), or not saved yet (the next run tries again).
 * @param {object} doc
 * @param {Map<string, string>} full     newestFullSearch(runs)
 * @param {Object<string, object>} [byHand]
 */
export function docState(doc, full, byHand = {}) {
  if (doc.status === SEEN_STATUS.SAVED) return DOC_STATE.SCHEDULED;
  if (doc.status === SEEN_STATUS.ALREADY) return DOC_STATE.ALREADY;
  if (doc.key && byHand && byHand[doc.key]) return DOC_STATE.BY_HAND;
  const newest = full.get(`${doc.account}|${doc.type}`);
  return newest && newest > doc.last ? DOC_STATE.MISSED : DOC_STATE.PENDING;
}

const zero = () => ({ listed: 0, downloaded: 0, scheduled: 0, already: 0, byHand: 0, missed: 0, pending: 0 });

function count(totals, state) {
  totals.listed++;
  if (DOWNLOADED.has(state)) totals.downloaded++;
  totals[state]++;
}

/**
 * The days of the ledger, newest first, each with a line per type (in the Schedule's order) and its documents:
 * [{ day, totals, types: [{ type, ...counts, read: "full" | "part" | null }], docs: [doc + { state }] }].
 * `read` says whether a run of that day read the type's lists to their end ("part": none did; the count may be short).
 * @param {{ docs: object[], runs: object[] }} ledger
 * @param {{ byHand?: Object<string, object> }} [options]
 */
export function documentDays(ledger, { byHand = {} } = {}) {
  const docs = (ledger && Array.isArray(ledger.docs) ? ledger.docs : []).filter(isDoc);
  const runs = (ledger && Array.isArray(ledger.runs) ? ledger.runs : []).filter(isRun);
  const full = newestFullSearch(runs);
  const days = new Map();
  for (const d of docs) {
    if (!days.has(d.day)) days.set(d.day, []);
    days.get(d.day).push({ ...d, state: docState(d, full, byHand) });
  }
  return [...days.keys()].sort().reverse().map((day) => {
    const dayDocs = days.get(day);
    const totals = zero();
    const byType = new Map();
    for (const d of dayDocs) {
      if (!byType.has(d.type)) byType.set(d.type, zero());
      count(byType.get(d.type), d.state);
      count(totals, d.state);
    }
    const order = (t) => (SCHEDULE_TYPES.includes(t) ? SCHEDULE_TYPES.indexOf(t) : SCHEDULE_TYPES.length);
    const types = [...byType.entries()].sort(([a], [b]) => order(a) - order(b)).map(([type, c]) => {
      const dayRuns = runs.filter((r) => r.day === day && r.type === type);
      return { type, ...c, read: dayRuns.length === 0 ? null : dayRuns.some((r) => r.full === true) ? "full" : "part" };
    });
    return { day, totals, types, docs: dayDocs };
  });
}

/** Where to look for a document in IREPS, by schedule type. */
export const FIND_IN_IREPS = Object.freeze({
  ma: "the MAs of its PO",
  poDate: "search the PO by its number",
  icDate: "the inspection certificates of its PO",
  icNotifications: "the inspection certificates of its PO",
  tenderNit: "Search Tender by the tender number: its NIT, attachments and corrigenda",
  tenderCounterOffer: "the Counter Offer letters, by Letter Date",
  tenderLoa: "the LOA letters, by Letter Date",
  tenderTabulations: "Search Tender by the tender number: its tabulations",
  tenderCorrespondence: "the tender's pending correspondence",
  tenderNegotiation: "the Negotiation letters, by Letter Date"
});

/** A day's documents in the Schedule's type order, then by name. */
export function inTypeOrder(docs) {
  const order = (t) => (SCHEDULE_TYPES.includes(t) ? SCHEDULE_TYPES.indexOf(t) : SCHEDULE_TYPES.length);
  return [...docs].sort((a, b) => order(a.type) - order(b.type) || String(a.doc).localeCompare(String(b.doc)));
}

/** What the date of a type's document is called. */
const DATE_LABEL = Object.freeze({ ma: "MA date", poDate: "PO date", icDate: "IC date", icNotifications: "IC date" });
export const dateLabel = (type) => DATE_LABEL[type] || "Date";

/** "2026-11-30T05:30:00Z" -> "30/11/2026 11:00" (IST); "" when not a time. */
export function istText(iso) {
  const t = istDateTime(iso);
  return t ? `${t.slice(8, 10)}/${t.slice(5, 7)}/${t.slice(0, 4)} ${t.slice(11)}` : "";
}

/** "2026-11-27 10:05" (a reservation's IST time) -> "27/11/2026 10:05". */
const whenText = (when) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}:\d{2}))?$/.exec(String(when || ""));
  return m ? `${m[3]}/${m[2]}/${m[1]}${m[4] ? ` ${m[4]}` : ""}` : "";
};

/** "2026-11-30" -> "30/11/2026". */
const dmy = (day) => String(day || "").split("-").reverse().join("/");

/** Why a document was not saved: the code's title and the reason, or "" when none was given. */
export function whyNotSaved(doc) {
  if (!doc.code) return "";
  return `${describeError(doc.code).title}${doc.detail ? ` (${doc.detail})` : ""}`;
}

/**
 * What became of a document, in words: "Auto: downloaded by the scheduler on ...", "Manual: already saved by Priya on
 * 27/11/2026 10:05", "Manual: downloaded by you with DocLink on 30/11/2026 12:10", "Missed: download it in IREPS",
 * "Pending: DocLink tries again at its next run".
 * @param {object} doc      a documentDays document (with `state`)
 * @param {Object<string, object>} [byHand]
 */
export function stateText(doc, byHand = {}) {
  switch (doc.state) {
    case DOC_STATE.SCHEDULED:
      return `Auto: downloaded by the scheduler${doc.savedAt ? ` on ${istText(doc.savedAt)}` : ""}${doc.tries ? ` (after ${doc.tries} run${doc.tries === 1 ? "" : "s"} could not)` : ""}`;
    case DOC_STATE.ALREADY:
      return `Manual: already saved${doc.by ? ` by ${doc.by}` : ""}${whenText(doc.when) ? ` on ${whenText(doc.when)}` : ""}`;
    case DOC_STATE.BY_HAND: {
      const h = (doc.key && byHand[doc.key]) || {};
      const when = h.date ? `${dmy(h.date)}${h.time ? ` ${String(h.time).slice(0, 5)}` : ""}` : "";
      return `Manual: downloaded by you with DocLink${when ? ` on ${when}` : ""}`;
    }
    case DOC_STATE.MISSED:
      return "Missed: download it in IREPS";
    default:
      return "Pending: DocLink tries again at its next run";
  }
}

const typeName = (type) => SCHEDULE_TYPE_LABEL[type] || type;
const READ_TEXT = { full: "yes", part: "no: the count may be short" };

/**
 * The ledger as spreadsheet sheets (My Downloads > Missed documents: Download Excel), every cell text, newest day
 * first: "Missed documents" (missed, then pending, with what finds each in IREPS), "By day" (a line per day and type:
 * in IREPS, downloaded, auto, manual, missed, pending, lists read in full) and "All documents" (every document IREPS
 * listed and what became of it), to match by hand.
 * @param {{ docs: object[], runs: object[] }} ledger
 * @param {{ byHand?: Object<string, object> }} [options]
 */
export function ledgerSheets(ledger, { byHand = {} } = {}) {
  const days = documentDays(ledger, { byHand });
  const info = (d) => [(d.info && d.info.date) || "", (d.info && d.info.unit) || "", (d.info && d.info.ic) || ""];
  const missed = [];
  const byDay = [];
  const all = [];
  for (const { day, types, docs } of days) {
    for (const want of [DOC_STATE.MISSED, DOC_STATE.PENDING]) {
      for (const d of inTypeOrder(docs.filter((x) => x.state === want))) {
        missed.push([dmy(day), typeName(d.type), d.doc, ...info(d), stateText(d, byHand), whyNotSaved(d), d.code || "", String(Number(d.tries) || 0), istText(d.first), istText(d.last), FIND_IN_IREPS[d.type] || ""]);
      }
    }
    for (const t of types) {
      byDay.push([dmy(day), typeName(t.type), String(t.listed), String(t.downloaded), String(t.scheduled), String(t.already + t.byHand), String(t.missed), String(t.pending), READ_TEXT[t.read] || ""]);
    }
    for (const d of inTypeOrder(docs)) all.push([dmy(day), typeName(d.type), d.doc, ...info(d), stateText(d, byHand), whyNotSaved(d), d.code || "", istText(d.first), istText(d.last)]);
  }
  return [
    { name: "Missed documents", headers: ["Day found", "Type", "Document", "IREPS date", "Railway", "IC number", "Status", "Why not saved", "Error code", "Runs that could not save it", "First found", "Last listed", "Find it in IREPS"], rows: missed },
    { name: "By day", headers: ["Day found", "Type", "In IREPS", "Downloaded", "Auto (scheduler)", "Manual", "Missed", "Pending", "Lists read in full"], rows: byDay },
    { name: "All documents", headers: ["Day found", "Type", "Document", "IREPS date", "Railway", "IC number", "Status", "Why not saved", "Error code", "First found", "Last listed"], rows: all }
  ];
}

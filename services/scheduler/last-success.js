/**
 * Each scheduled type's last successful run in this browser, per IREPS account: the day (DD/MM/YYYY, the Recon
 * Engine's IST date) that run searched up to, and `held`, how many runs in a row searched a gap again because its
 * catch-up left documents not saved. The first run after a gap searches from that day when the schedule's look-back
 * starts later (run-details.js caughtUpParams), so the days nobody ran the type (a weekend, a holiday, a night IREPS
 * stayed logged out) are searched too. run-details.js lastSuccessAfter says what a run stores.
 *
 * Kept in chrome.storage.local, apart from the run log, and kept when a build is loaded:
 * { "<IREPS account>": { "<docType>": { day: "DD/MM/YYYY", held: 0 } } }, days, counts and type names only. A plain
 * "DD/MM/YYYY" (as an earlier copy of this build stored it) reads as that day, never held. Each browser keeps its
 * own: one that has not run a type for a while catches up from its own older day, which only searches more.
 * The worker is the only writer, and every change runs after the one before. Never throws: a store that cannot be
 * read gives no day (the look-back alone, as before) and is never written over.
 */

import { STORAGE_KEYS } from "../../utils/messages.js";
import { logger } from "../../utils/logger.js";

const DMY_RE = /^\d{2}\/\d{2}\/\d{4}$/;
const TYPE_RE = /^[A-Za-z]{1,40}$/;
const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** A stored entry as { day, held }, or null when it is neither a day nor { day, held }. */
export function lastSuccessEntry(value) {
  if (typeof value === "string") return DMY_RE.test(value) ? { day: value, held: 0 } : null;
  if (!isRecord(value) || !DMY_RE.test(String(value.day))) return null;
  const held = Number(value.held);
  return { day: value.day, held: Number.isInteger(held) && held > 0 ? Math.min(held, 99) : 0 };
}

/** One account's stored entries, kept to their known shape: { docType: { day, held } }. */
function entriesOf(record) {
  if (!isRecord(record)) return {};
  return Object.fromEntries(Object.entries(record).filter(([type]) => TYPE_RE.test(type)).map(([type, value]) => [type, lastSuccessEntry(value)]).filter(([, entry]) => entry));
}

/**
 * @param {{ storage?: chrome.storage.StorageArea }} [deps]
 */
export function createLastSuccess(deps = {}) {
  const storage = deps.storage || chrome.storage.local;
  const key = STORAGE_KEYS.SCHEDULER_LAST_SUCCESS;
  let chain = Promise.resolve();

  /** Every account's entries; throws when the storage cannot be read. */
  async function load() {
    const value = (await storage.get(key))[key];
    return isRecord(value) ? value : {};
  }

  /** The entries of `account` (after every change before), {} when there are none or the storage cannot be read. */
  function read(account) {
    return chain.then(async () => {
      try {
        return entriesOf((await load())[String(account)]);
      } catch (error) {
        logger.debug("Scheduler: last successful runs not read", error);
        return {};
      }
    });
  }

  return {
    read,
    /** `docType`'s last successful run for `account` ({ day, held }), or null. */
    async get(account, docType) {
      return (await read(account))[docType] || null;
    },
    /** Store `entry` ({ day, held }) as `docType`'s last successful run for `account`. Never throws. */
    set(account, docType, entry) {
      const value = lastSuccessEntry(entry);
      if (!account || !TYPE_RE.test(String(docType)) || !value) return chain;
      chain = chain
        .then(async () => {
          // a storage that cannot be read throws here, so the entries of other types and accounts are never lost
          const all = await load();
          const id = String(account);
          await storage.set({ [key]: { ...all, [id]: { ...entriesOf(all[id]), [docType]: value } } });
        })
        .catch((error) => logger.warn(`Scheduler: the last successful run of ${docType} was not stored`, error));
      return chain;
    }
  };
}

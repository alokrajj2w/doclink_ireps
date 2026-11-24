/**
 * What DocLink has already written to IREPS, per receipt, so a second click, a retry or a
 * restarted service worker never creates a second draft bill for the same receipt
 * (upload.md section 10, "Store progress per bill").
 *
 * chrome.storage.local, key "doclink.billUploads": { [receiptKey]: entry }. Entries hold
 * identifiers only (bill reg no., dispatch no., invoice / PO numbers), never amounts, bank
 * or GST data. The storage area is injectable for tests.
 *
 * A write is recorded as `unknown` right before it is sent, and stays so when its answer does not
 * arrive (the tab was reloaded, the network dropped, the deadline passed, IREPS answered 5xx, or
 * the service worker stopped): IREPS may have saved it. Only IREPS's answer, or the user's
 * confirmation that they checked the bill in IREPS, clears it (bill-upload-service.js, review 3.1).
 */

const STORE_KEY = "doclink.billUploads";

/**
 * @typedef {Object} BillUploadEntry
 * @property {string} receiptKey
 * @property {"header-saved"|"item-saved"} [status]  absent while the header's own outcome is unknown
 * @property {string|null} billRegNo                   null until IREPS answered the header
 * @property {string|null} dispatchNo
 * @property {string} invoiceNo
 * @property {string} poNumber
 * @property {string} poSr
 * @property {string} roNo
 * @property {{ step: "header"|"item"|"document", why: string, at: string, fileName?: string, fileDesc?: string }|null} [unknown]
 *           a write whose answer did not arrive (IREPS may have saved it)
 * @property {string} createdAt   ISO
 * @property {string} updatedAt   ISO
 */

/**
 * @param {{ get: (key: string) => Promise<object>, set: (items: object) => Promise<void> }} [area]  default chrome.storage.local
 */
export function createBillStore(area) {
  const storage = area || (typeof chrome !== "undefined" && chrome.storage ? chrome.storage.local : null);
  if (!storage) throw new Error("No storage area for the bill upload progress");
  const readAll = async () => {
    const got = await storage.get(STORE_KEY);
    return (got && got[STORE_KEY]) || {};
  };
  return {
    /** @returns {Promise<BillUploadEntry|null>} */
    async get(receiptKey) {
      return (await readAll())[receiptKey] || null;
    },
    /** @returns {Promise<BillUploadEntry[]>} newest first */
    async list() {
      return Object.values(await readAll()).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    },
    /** Merge `patch` into the receipt's entry. */
    async put(receiptKey, patch) {
      const all = await readAll();
      const now = new Date().toISOString();
      all[receiptKey] = { ...(all[receiptKey] || { receiptKey, createdAt: now, dispatchNo: null }), ...patch, receiptKey, updatedAt: now };
      await storage.set({ [STORE_KEY]: all });
      return all[receiptKey];
    },
    /**
     * Forget the receipt's entry ("Start fresh"): the next create for this receipt is allowed again.
     * @returns {Promise<BillUploadEntry|null>} the entry that was removed
     */
    async remove(receiptKey) {
      const all = await readAll();
      const removed = all[receiptKey] || null;
      if (!removed) return null;
      delete all[receiptKey];
      await storage.set({ [STORE_KEY]: all });
      return removed;
    }
  };
}

/** An in-memory storage area with the chrome.storage.local interface (tests). */
export function memoryStorageArea(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(key) {
      return key in data ? { [key]: JSON.parse(JSON.stringify(data[key])) } : {};
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) data[k] = JSON.parse(JSON.stringify(v));
    }
  };
}

// Tracks which documents DocLink has already downloaded, so the scheduled jobs only fetch what is
// NEW (a letter that was "not published yet" on the last check is picked up on a later one).
// Stored per IREPS account in chrome.storage.local. Holds tender numbers / letter ids / dates only -
// never cookies, tokens, passwords or document content.
//
// The ledger must stay small (M21): chrome.storage.local holds 10 MB for the whole extension (no
// unlimitedStorage), shared with the log, the download-log queue and a ledger per IREPS account. So it is
// pruned on every open and save: entries older than LEDGER_LIMITS.keepMs, beyond maxPerBucket per bucket and
// beyond maxManifests tender records go, and the whole ledger is kept under budgetBytes (the oldest tender
// records first). The jobs save it after each tender, so a run that is cut short keeps what it did.

import { log } from './tender-core.js';

const KEY = (accountId) => `doclink.tender.ledger.${accountId}`;
const DAY = 86400000;

/** Pruning limits (exported for the tests). */
export const LEDGER_LIMITS = { keepMs: 400 * DAY, maxPerBucket: 5000, maxManifests: 300, budgetBytes: 2 * 1024 * 1024 };

/** "already downloaded" buckets: key -> ISO time. docs: the NIT documents (tender PDF, attachments, My Offer). */
const BUCKETS = ['nit', 'corrigenda', 'letters', 'msgs', 'docs'];
/** Manifests that are not a tender's download record (tender-pending.js keeps the correspondence state here). */
const NOT_TENDER_RECORDS = new Set(['pending-correspondence']);

const empty = () => ({ v: 1, nit: {}, corrigenda: {}, letters: {}, msgs: {}, docs: {}, manifests: {}, meta: {} });
const at = (iso) => Date.parse(iso || '') || 0;
const sizeOf = (data) => JSON.stringify(data).length;

/**
 * Drop what the ledger no longer needs (see LEDGER_LIMITS), in place: old and surplus bucket entries, old and
 * surplus tender records, then - while the ledger is over budgetBytes - the oldest tender records and finally
 * the older half of each bucket. Forgetting an entry only means a document may be offered for download again.
 */
export function pruneLedger(data, now = Date.now(), limits = LEDGER_LIMITS) {
  const cutoff = now - limits.keepMs;
  for (const b of BUCKETS) {
    const kept = Object.entries(data[b] || {}).filter(([, ts]) => !(Date.parse(ts) < cutoff)).sort((x, y) => at(y[1]) - at(x[1]));
    data[b] = Object.fromEntries(kept.slice(0, limits.maxPerBucket));
  }
  const records = Object.entries(data.manifests || {}).filter(([k]) => !NOT_TENDER_RECORDS.has(k)).sort((x, y) => at(y[1]?.generatedAt) - at(x[1]?.generatedAt));
  const keep = new Set(records.filter(([, m]) => at(m?.generatedAt) >= cutoff).slice(0, limits.maxManifests).map(([k]) => k));
  for (const [k] of records) if (!keep.has(k)) delete data.manifests[k];
  // over budget: the oldest tender records go first, then the older half of every bucket
  const oldestFirst = records.filter(([k]) => keep.has(k)).reverse();
  let size = sizeOf(data);
  while (size > limits.budgetBytes && oldestFirst.length) {
    const [k, m] = oldestFirst.shift();
    size -= (JSON.stringify(m) || '').length + JSON.stringify(k).length + 2;
    delete data.manifests[k];
  }
  for (let round = 0; round < 8 && sizeOf(data) > limits.budgetBytes; round++) {
    for (const b of BUCKETS) {
      const entries = Object.entries(data[b]);
      data[b] = Object.fromEntries(entries.slice(0, Math.floor(entries.length / 2))); // newest first (sorted above)
    }
  }
  return data;
}

export async function openLedger(accountId, storage = globalThis.chrome?.storage?.local) {
  let data = empty();
  try {
    const got = await storage.get(KEY(accountId));
    if (got?.[KEY(accountId)]?.v === 1) data = { ...empty(), ...got[KEY(accountId)] };
  } catch {
    /* unreadable storage: start empty (worst case: a document is downloaded twice) */
  }
  pruneLedger(data);
  return {
    has: (bucket, key) => !!data[bucket]?.[key],
    mark: (bucket, key) => { (data[bucket] ||= {})[key] = new Date().toISOString(); },
    manifest: (tenderNo) => data.manifests[tenderNo] || null,
    setManifest: (tenderNo, m) => { data.manifests[tenderNo] = m; },
    meta: (k) => data.meta[k],
    setMeta: (k, v) => { data.meta[k] = v; },
    /**
     * Write the ledger (pruned first). When chrome.storage refuses it (the extension's quota is full), it is
     * pruned to half its budget and written once more. -> true when it was saved.
     */
    async save() {
      pruneLedger(data);
      try {
        await storage.set({ [KEY(accountId)]: data });
        return true;
      } catch (e) {
        log('Ledger', `not saved (${e.message}); trying again with older entries dropped`, 'warn');
      }
      try {
        pruneLedger(data, Date.now(), { ...LEDGER_LIMITS, budgetBytes: Math.floor(LEDGER_LIMITS.budgetBytes / 2) });
        await storage.set({ [KEY(accountId)]: data });
        return true;
      } catch (e) {
        log('Ledger', `not saved: ${e.message}`, 'warn');
        return false;
      }
    },
  };
}

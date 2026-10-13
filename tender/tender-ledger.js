// Tracks which documents DocLink has already downloaded, so the scheduled jobs only fetch what is
// NEW (a letter that was "not published yet" on the last check is picked up on a later one).
// Stored per IREPS account in chrome.storage.local. Holds tender numbers / letter ids / dates only -
// never cookies, tokens, passwords or document content.

const KEY = (accountId) => `doclink.tender.ledger.${accountId}`;
const KEEP_MS = 400 * 86400000;

export async function openLedger(accountId, storage = globalThis.chrome?.storage?.local) {
  const empty = () => ({ v: 1, nit: {}, corrigenda: {}, letters: {}, msgs: {}, manifests: {}, meta: {} });
  let data = empty();
  try {
    const got = await storage.get(KEY(accountId));
    if (got?.[KEY(accountId)]?.v === 1) data = { ...empty(), ...got[KEY(accountId)] };
  } catch {
    /* unreadable storage: start empty (worst case: a document is downloaded twice) */
  }
  const cutoff = Date.now() - KEEP_MS;
  for (const bucket of ['nit', 'corrigenda', 'letters', 'msgs']) {
    for (const [k, ts] of Object.entries(data[bucket])) if (Date.parse(ts) < cutoff) delete data[bucket][k];
  }
  return {
    has: (bucket, key) => !!data[bucket]?.[key],
    mark: (bucket, key) => { data[bucket][key] = new Date().toISOString(); },
    manifest: (tenderNo) => data.manifests[tenderNo] || null,
    setManifest: (tenderNo, m) => { data.manifests[tenderNo] = m; },
    meta: (k) => data.meta[k],
    setMeta: (k, v) => { data.meta[k] = v; },
    async save() {
      try {
        await storage.set({ [KEY(accountId)]: data });
      } catch (e) {
        console.warn('[DocLink][Ledger] not saved:', e.message);
      }
    },
  };
}

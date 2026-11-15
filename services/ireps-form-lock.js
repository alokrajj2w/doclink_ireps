/**
 * One IREPS form sequence at a time (review M2).
 *
 * IREPS is a Struts 1 application: the single-use form TOKEN is kept in the user's HTTP session,
 * one per session. Loading any search form (Bill Status, PO Search, Inspection Call List) replaces
 * it, so two DocLink searches running at once (say Bill Status and a PO-by-date batch), or the
 * panel's session check during a batch, make the other's token invalid. Every "load the form ->
 * post the search -> follow the token-bound pages" sequence therefore runs under this lock.
 * Downloading the PDFs (plain GET links, no token) is not locked and stays parallel.
 *
 * Inside the extension the lock is a Web Lock, shared by the service worker and every panel.
 * Elsewhere (the browser tests on file://, Node) the runs are ordered within the page. A lock is
 * released when the context that holds it goes away, and every IREPS request has its own timeout,
 * so a waiting run cannot wait for ever.
 */

const LOCK_NAME = "doclink.ireps.form";
let chain = Promise.resolve();
let heldHere = 0;

function webLocks() {
  const inExtension = typeof location !== "undefined" && location.protocol === "chrome-extension:";
  return inExtension && typeof navigator !== "undefined" && navigator.locks && typeof navigator.locks.request === "function" ? navigator.locks : null;
}

/**
 * Run `fn` holding the IREPS form lock.
 * `ifBusy`: when given and another sequence holds the lock, `ifBusy()` is answered at once instead
 * of waiting (used by the session check: a running search shows the session is alive).
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{ ifBusy?: () => T }} [options]
 * @returns {Promise<T>}
 */
export async function withIrepsFormLock(fn, { ifBusy } = {}) {
  const locks = webLocks();
  if (locks) {
    if (ifBusy) return locks.request(LOCK_NAME, { ifAvailable: true }, (lock) => (lock ? fn() : ifBusy()));
    return locks.request(LOCK_NAME, () => fn());
  }
  if (ifBusy && heldHere > 0) return ifBusy();
  const run = chain.then(async () => {
    heldHere++;
    try {
      return await fn();
    } finally {
      heldHere--;
    }
  });
  chain = run.catch(() => {});
  return run;
}

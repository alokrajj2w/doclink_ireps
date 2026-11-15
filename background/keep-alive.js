/**
 * Keeps the extension's service worker running while DocLink works (review H8).
 *
 * Chrome stops an idle extension service worker after about 30 seconds, and waiting for a slow
 * IREPS, ECM or Recon answer does not count as activity, so a long run could be cut off half way.
 * Any extension API call resets that timer (Chrome 110+), so while at least one job is held a
 * trivial call is made every 20 seconds; it stops when the last job ends. A job that is cut off
 * anyway (Chrome restarted, the extension reloaded) is shown as interrupted when its state is
 * read back (service-worker.js restoreSavedJob).
 */

const PING_MS = 20000;
let held = 0;
let timer = null;

function ping() {
  try {
    chrome.runtime.getPlatformInfo().catch(() => {});
  } catch {
    // no extension context (tests): nothing to keep alive
  }
}

/**
 * Run `task` (an async function) with the worker kept alive until it settles.
 * @template T
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
export async function holdWorker(task) {
  held++;
  if (!timer) timer = setInterval(ping, PING_MS);
  try {
    return await task();
  } finally {
    held--;
    if (held === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  }
}


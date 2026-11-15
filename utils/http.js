/**
 * fetch() with one deadline for the whole exchange: the response headers AND the body.
 *
 * Clearing an AbortController timer as soon as fetch() resolves (the headers have arrived)
 * leaves response.json() / text() / arrayBuffer() without any limit, so a server that stalls
 * in the middle of the body freezes the caller for good. Here the same timer keeps running
 * until the body has been read, so one deadline covers both.
 *
 * Used by the Recon Engine, ECM and download-log clients (services/recon-auth.js,
 * services/recon-service.js, services/ecm-service.js, services/ecm-direct.js,
 * services/download-log.js). IREPS requests have their own wrapper (services/ireps-api.js).
 */

/** The error thrown when the deadline passes (name "TimeoutError", like AbortSignal.timeout()). */
export class DeadlineError extends Error {
  constructor(timeoutMs) {
    super(`no complete answer within ${timeoutMs < 1000 ? `${timeoutMs} ms` : `${Math.round(timeoutMs / 1000)} seconds`}`);
    this.name = "TimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * @param {string} url
 * @param {RequestInit} [init]
 * @param {{ timeoutMs: number, fetch?: Function, read?: "json"|"text"|"arrayBuffer"|"none" }} options
 *        read: how the body is read inside the deadline. "json": null when the body is not JSON
 *        (an empty 204, an HTML error page); "none": not read (the caller reads it, unguarded).
 * @returns {Promise<{ response: Response, body: any }>}
 * @throws DeadlineError when the deadline passes (before the headers or during the body); the
 *         fetch's own error (TypeError "Failed to fetch", ...) when the request cannot be made
 */
export async function fetchWithDeadline(url, init = {}, { timeoutMs, fetch: fetchImpl, read = "json" } = {}) {
  const doFetch = fetchImpl || ((...args) => globalThis.fetch(...args));
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  // a caller's own signal (a cancel button) still aborts the request
  const outer = init.signal;
  const onOuterAbort = () => controller.abort();
  if (outer) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener("abort", onOuterAbort, { once: true });
  }
  try {
    let response;
    try {
      response = await doFetch(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (timedOut) throw new DeadlineError(timeoutMs);
      throw error;
    }
    let body = null;
    if (read !== "none") {
      try {
        body = read === "text" ? await response.text() : read === "arrayBuffer" ? await response.arrayBuffer() : await response.json();
      } catch (error) {
        if (timedOut) throw new DeadlineError(timeoutMs);
        if (controller.signal.aborted || read !== "json") throw error;
        body = null; // not JSON: the caller looks at the status
      }
    }
    return { response, body };
  } finally {
    clearTimeout(timer);
    if (outer) outer.removeEventListener("abort", onOuterAbort);
  }
}

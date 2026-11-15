// Tests for utils/http.js fetchWithDeadline (review M15): one deadline over the answer's headers AND its
// body, so a server that stalls in the middle of a body cannot freeze a run; and that the Recon clients
// built on it report such a stall as "unavailable".
//
// In Node, not the browser suite: headless Chrome's --virtual-time-budget stops the clock while a stream
// read is pending, so a stalled body can never reach its deadline there. Real timers here.
//   node --test test/node/http-tests.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchWithDeadline, DeadlineError } from '../../utils/http.js';
import { reconWhoAmI, ReconAuthError, RECON_AUTH_ERROR } from '../../services/recon-auth.js';
import { applyReconConfig } from '../../services/recon-service.js';
import { checkDownloaded, applyDownloadLogConfig } from '../../services/download-log.js';

const RECON = 'http://localhost:8000';
const hostPermissions = [`${RECON}/*`];
applyReconConfig({ reconBaseUrl: RECON });
applyDownloadLogConfig({ downloadLog: { enabled: true } });

/** A fetch whose answer sends half a JSON body and then stalls, until the request's signal aborts it (as a real fetch does). */
function stallingFetch() {
  return async (url, init = {}) => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"half":'));
        if (init.signal) init.signal.addEventListener('abort', () => controller.error(new DOMException('The operation was aborted.', 'AbortError')));
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

test('http (M15): the deadline covers the body - a stalled body ends in a DeadlineError at the deadline, not a hang', async () => {
  const started = Date.now();
  await assert.rejects(fetchWithDeadline('http://x.test/a', {}, { timeoutMs: 100, fetch: stallingFetch() }), (e) => e instanceof DeadlineError && e.name === 'TimeoutError');
  const took = Date.now() - started;
  assert.ok(took >= 90 && took < 3000, `stopped at the deadline (${took} ms)`);
});

test('http (M15): a full answer is read inside the deadline; a non-JSON body is null; a network failure is not a timeout', async () => {
  const ok = await fetchWithDeadline('http://x.test/a', {}, { timeoutMs: 1000, fetch: async () => new Response('{"a":1}', { status: 200 }) });
  assert.equal(ok.body.a, 1);
  assert.equal(ok.response.status, 200);
  const html = await fetchWithDeadline('http://x.test/a', {}, { timeoutMs: 1000, fetch: async () => new Response('<html>502</html>', { status: 502 }) });
  assert.equal(html.body, null);
  assert.equal(html.response.status, 502);
  const text = await fetchWithDeadline('http://x.test/a', {}, { timeoutMs: 1000, read: 'text', fetch: async () => new Response('plain', { status: 200 }) });
  assert.equal(text.body, 'plain');
  await assert.rejects(
    fetchWithDeadline('http://x.test/a', {}, { timeoutMs: 1000, fetch: async () => { throw new TypeError('Failed to fetch'); } }),
    (e) => e instanceof TypeError && !(e instanceof DeadlineError),
  );
});

test("http (M15): a caller's own abort signal still cancels the request", async () => {
  const cancel = new AbortController();
  const pending = fetchWithDeadline('http://x.test/a', { signal: cancel.signal }, { timeoutMs: 60000, fetch: stallingFetch() });
  setTimeout(() => cancel.abort(), 20);
  await assert.rejects(pending, (e) => e.name === 'AbortError');
});

test('http (M15): a stalled Recon answer is "unavailable" for the sign-in check and never hangs the download-log check', async () => {
  // reconWhoAmI has a 30 s deadline: a fetch that fails as the deadline would shows the mapping without waiting
  const timedOut = async () => { throw new DeadlineError(30000); };
  await assert.rejects(reconWhoAmI({ fetch: timedOut, hostPermissions }), (e) => e instanceof ReconAuthError && e.code === RECON_AUTH_ERROR.UNAVAILABLE && /30 seconds/.test(e.detail));
  const checked = await checkDownloaded({ destination: 'local', keys: ['po:1'] }, { fetch: timedOut, hostPermissions });
  assert.equal(checked.ok, false);
  assert.equal(checked.code, 'DOWNLOAD_LOG_UNAVAILABLE');
});

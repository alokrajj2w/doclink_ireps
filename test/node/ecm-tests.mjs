// Tests for the ECM clients that the browser suite cannot run (review M15, M16):
//   - a response body that stalls: the deadline (utils/http.js fetchWithDeadline) must end it, in direct mode
//     (services/ecm-direct.js); headless Chrome's --virtual-time-budget stops the clock while a stream read is
//     pending, so this needs real timers;
//   - uploads from two JS contexts (the service worker and a panel) never overlap: the Web Lock in
//     services/ecm-service.js uploadToEcm. Two module instances of ecm-service.js stand for the two contexts.
//   node --test test/node/ecm-tests.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uploadToEcm, EcmError, ECM_ERROR } from '../../services/ecm-service.js';
import { uploadToNuxeo, searchEcm, resetEcmDirectState } from '../../services/ecm-direct.js';
import { applyEcmConfig } from '../../services/ecm-config.js';

const NUXEO = 'http://ecm.test:8080';
const hostPermissions = [`${NUXEO}/*`];
const HOSUR = { irepsAccountId: '833', operatingUnit: 'HOSUR' };
const IC = { kind: 'inspectionCertificate', bytes: new Uint8Array([37, 80, 68, 70, 45]), filename: 'IC_1.pdf', fields: { ic_number: '1', customer_po_number: 'PO-1' }, account: HOSUR };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function direct(timeoutMs) {
  resetEcmDirectState();
  applyEcmConfig({ ecmBackendAws: false, ecm: { env: 'TEST', domain: NUXEO, clientId: 'id', clientSecret: 'secret', timeoutMs } });
}

/** An answer that sends the start of its body and then stalls until the request's signal aborts it (as a real fetch does). */
function stalled(init, start = '{"entries":[') {
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(start));
      init.signal.addEventListener('abort', () => controller.error(new DOMException('The operation was aborted.', 'AbortError')));
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

/** A small Nuxeo: a token, the Inputs folder, one document old-1 (5 bytes), uploads and creates; `stall(path, init)` picks answers that stall. */
function fakeNuxeo({ stall = () => false, delayMs = 0, onOpen = () => {} } = {}) {
  const calls = [];
  let docs = 0;
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    calls.push(`${method} ${u.pathname}${init.headers && init.headers.Range ? ' (last byte)' : ''}`);
    const done = onOpen();
    try {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (stall(u.pathname, init)) return stalled(init);
      if (u.pathname === '/nuxeo/oauth2/token') return json(200, { access_token: 'tok', expires_in: 3600 });
      if (u.pathname === '/nuxeo/api/v1/search/lang/NXQL/execute') return json(200, { entries: [], isNextPageAvailable: false });
      if (u.pathname === '/nuxeo/api/v1/upload') return json(201, { batchId: 'b' });
      if (u.pathname.startsWith('/nuxeo/api/v1/upload/')) return json(201, { uploaded: 'true' });
      const [uid, blob] = decodeURIComponent(u.pathname.replace('/nuxeo/api/v1/id/', '')).split('/@blob/');
      if (method === 'GET' && blob) return new Response(new Uint8Array(init.headers && init.headers.Range ? 1 : 5), { status: 200 });
      if (method === 'GET' && (uid === 'old-1' || uid.startsWith('n-'))) return json(200, { uid, properties: { 'file:content': { name: 'f.pdf', length: '5' }, 'files:files': [] } });
      if (method === 'GET') return json(200, { uid, path: '/FT/folder' }); // the folder check
      if (method === 'POST') return json(201, { uid: `n-${++docs}`, path: '/x', title: 'x' });
      return json(200, { uid });
    } finally {
      if (typeof done === 'function') done();
    }
  };
  fetch.calls = calls;
  return fetch;
}

test('ECM direct (M15): a search answer whose body stalls ends at the deadline as ECM_UNAVAILABLE, not a hang', async () => {
  direct(150);
  const fetch = fakeNuxeo({ stall: (path) => path === '/nuxeo/api/v1/search/lang/NXQL/execute' });
  const started = Date.now();
  await assert.rejects(searchEcm('SELECT * FROM Document', {}, { fetch, hostPermissions }), (e) => e instanceof EcmError && e.code === ECM_ERROR.UNAVAILABLE && e.detail === 'no complete answer within 150 ms');
  const took = Date.now() - started;
  assert.ok(took >= 140 && took < 3000, `stopped at the deadline (${took} ms)`);
});

test('ECM direct (M15, H9): a file whose body stalls is read 3 times, then a download again leaves the document unchanged', async () => {
  direct(150);
  const fetch = fakeNuxeo({ stall: (path, init) => path === '/nuxeo/api/v1/id/old-1/@blob/file:content' && !(init.headers && init.headers.Range) });
  await assert.rejects(
    uploadToNuxeo({ ...IC, replace: ['old-1'] }, { fetch, hostPermissions, retryDelaysMs: [0, 0] }),
    (e) => e instanceof EcmError && e.code === ECM_ERROR.UNAVAILABLE && e.detail === 'document old-1: its current file f.pdf could not be read (no complete answer within 150 ms, 3 attempts); the document was not changed',
  );
  assert.equal(fetch.calls.filter((c) => c === 'GET /nuxeo/api/v1/id/old-1/@blob/file:content').length, 3, 'read 3 times');
  assert.ok(!fetch.calls.some((c) => c.startsWith('PUT') || c.startsWith('POST /nuxeo/api/v1/upload')), `nothing uploaded, nothing updated: ${fetch.calls.join(' | ')}`);
});

test('ECM (M16): uploads from two contexts never overlap inside the extension (Web Lock); outside it they would', async () => {
  // a second instance of ecm-service.js has its own queue, as the service worker and a panel do
  const other = await import('../../services/ecm-service.js?context=panel');
  const run = async () => {
    let open = 0;
    let most = 0;
    const fetch = fakeNuxeo({
      delayMs: 5,
      onOpen: () => {
        open += 1;
        most = Math.max(most, open);
        return () => { open -= 1; };
      },
    });
    direct(5000);
    await Promise.all([
      uploadToEcm(IC, { fetch, hostPermissions }),
      other.uploadToEcm({ ...IC, filename: 'IC_2.pdf', fields: { ic_number: '2', customer_po_number: 'PO-1' } }, { fetch, hostPermissions }),
    ]);
    return most;
  };
  assert.equal(await run(), 2, 'without the lock the two contexts upload at the same time');
  globalThis.location = { protocol: 'chrome-extension:', pathname: '/background/service-worker.js' };
  try {
    assert.equal(await run(), 1, 'with it, one request at a time across both');
  } finally {
    delete globalThis.location;
  }
});

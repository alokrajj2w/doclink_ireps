// IREPS settings fail closed (review M6). Inside the extension, a config.json that cannot be read,
// or one without a valid "target", leaves NO IREPS URL: nothing is sent and the panel shows a
// configuration error. Never the mock portal in its place.
//
// In Node, not the browser suite: each check needs a fresh copy of services/ireps-api.js (a config
// applied once is kept), and headless Chrome's virtual clock runs on while module files load, so
// fresh imports there take "seconds" and hit the per-test timeout.
//   node --test test/node/config-tests.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTabUrl, TAB_SCOPE } from '../../utils/url-scope.js';

const EXTENSION = { runtime: { id: 'cglncbgakabfoenpkbaoigpclmgkklcl', getURL: (p) => `chrome-extension://test/${p}` } };
const HOSTS = ['http://localhost:8765/*', 'https://www.ireps.gov.in/*'];

async function sendFrom(api) {
  let calls = 0;
  try {
    await api.requestIreps({ path: '/epsn/admin/viewBills.do', method: 'POST', body: '' }, { fetch: async () => (calls++, new Response('')) });
  } catch (error) {
    return { calls, code: error.code };
  }
  return { calls, code: null };
}

test('loadIrepsConfig fails closed (M6): config.json unreadable -> no IREPS URL, a configuration error, nothing sent', async () => {
  const realFetch = globalThis.fetch;
  globalThis.chrome = EXTENSION;
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };
  try {
    const api = await import('../../services/ireps-api.js?fail-closed-unreadable');
    assert.equal(api.IREPS_CONFIG.baseUrl, '', 'no IREPS URL before config.json is read');
    await api.loadIrepsConfig({ force: true });
    assert.equal(api.IREPS_CONFIG.baseUrl, '', 'config.json unreadable: no IREPS URL, not the mock');
    assert.equal(api.IREPS_CONFIG.target, 'unconfigured');
    assert.equal(classifyTabUrl('https://www.ireps.gov.in/epsn/home/showHome.do', api.IREPS_CONFIG, HOSTS).scope, TAB_SCOPE.MISCONFIGURED, 'the panel shows the configuration error');
    assert.equal(classifyTabUrl('http://localhost:8765/', api.IREPS_CONFIG, HOSTS).scope, TAB_SCOPE.MISCONFIGURED, 'also on the mock portal tab');
    const sent = await sendFrom(api);
    assert.equal(sent.code, 'IREPS_NOT_CONFIGURED');
    assert.equal(sent.calls, 0, 'nothing is sent');
  } finally {
    globalThis.fetch = realFetch;
    delete globalThis.chrome;
  }
});

test('loadIrepsConfig fails closed (M6): a "target" that is neither "mock" nor "real" is no target', async () => {
  const realFetch = globalThis.fetch;
  globalThis.chrome = EXTENSION;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('config.local.json')) throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify({ target: 'Real' }), { status: 200 });
  };
  try {
    const api = await import('../../services/ireps-api.js?fail-closed-typo');
    await api.loadIrepsConfig({ force: true });
    assert.equal(api.IREPS_CONFIG.baseUrl, '');
    assert.equal((await sendFrom(api)).calls, 0);
  } finally {
    globalThis.fetch = realFetch;
    delete globalThis.chrome;
  }
});

test('loadIrepsConfig (M6): a valid config.json still selects the portal; outside the extension the mock stays the default', async () => {
  const realFetch = globalThis.fetch;
  globalThis.chrome = EXTENSION;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('config.local.json')) throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify({ target: 'real' }), { status: 200 });
  };
  try {
    const api = await import('../../services/ireps-api.js?valid-real');
    await api.loadIrepsConfig({ force: true });
    assert.equal(api.IREPS_CONFIG.baseUrl, 'https://www.ireps.gov.in');
  } finally {
    globalThis.fetch = realFetch;
    delete globalThis.chrome;
  }
  const outside = await import('../../services/ireps-api.js?outside-extension');
  assert.equal(outside.IREPS_CONFIG.baseUrl, 'http://localhost:8765', 'test pages and Node keep the mock default');
});

test('schedular_phase1: config.local.json replaces the whole block, and only enabled: true with a known type turns scheduling on', async () => {
  const { mergeConfig } = await import('../../utils/config.js');
  const { parseSchedulerConfig } = await import('../../services/scheduler/schedule-types.js');
  const base = { schedular_phase1: { enabled: false, documents: ['BillStatus', 'CRN', 'RNote', 'MA', 'PO', 'IC'] } };
  assert.equal(parseSchedulerConfig(base).enabled, false, 'the shipped config.json is off');
  const local = mergeConfig(base, { schedular_phase1: { enabled: true, documents: ['CRN'] } });
  const on = parseSchedulerConfig(local);
  assert.equal(on.enabled, true);
  assert.deepEqual(on.types, ['crn'], 'the local block replaces documents too (top-level keys replace)');
  assert.equal(parseSchedulerConfig(mergeConfig(base, { schedular_phase1: { enabled: true } })).enabled, false, 'a local block without documents is off');
});

// Panel code in Node: the real popup.html in jsdom, the panel modules imported as they are, and a
// fake Recon Engine behind globalThis.fetch. Run with the other node suites (npm test -- node), or:
//   node --test test/node/panel-tests.mjs
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const req = createRequire((process.env.JSDOM_ROOT || process.cwd()) + '/');
const { JSDOM } = req('jsdom');

const RECON = 'http://recon.test';
const html = readFileSync(new URL('../../popup/popup.html', import.meta.url), 'utf8').replace(/<script[^>]*><\/script>/g, '');
const dom = new JSDOM(html, { pretendToBeVisual: true });
Object.assign(globalThis, { document: dom.window.document, window: dom.window, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent });
const messageListeners = [];
globalThis.chrome = {
  runtime: {
    getManifest: () => ({ host_permissions: [`${RECON}/*`] }),
    getURL: (p) => `${RECON}/__ext__/${p}`,
    onMessage: { addListener: (fn) => messageListeners.push(fn) },
  },
};

/**
 * The fake Recon Engine: `mode` is "down" (unreachable), "signedOut" (401) or "signedIn".
 * `downloads(query)` -> [status, body] answers GET /api/doclink/downloads ("My downloads"); `listed` keeps each query.
 */
const recon = { mode: 'down', listed: [], downloads: () => [200, { count: 0, downloads: [] }] };
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/__ext__/')) return new Response('{}', { status: 404 });
  if (recon.mode === 'down') throw new TypeError('Failed to fetch');
  if (u.endsWith('/api/auth/me')) {
    return recon.mode === 'signedIn'
      ? new Response(JSON.stringify({ id: 7, email: 'a@b.test', name: 'A', roles: ['tendering'] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      : new Response(JSON.stringify({ detail: 'not signed in' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }
  if (u.endsWith('/api/auth/providers')) return new Response(JSON.stringify({ password: true, okta: false }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (u.includes('/api/doclink/downloads?')) {
    const query = new URL(u).searchParams;
    recon.listed.push(query);
    const [status, body] = recon.downloads(query);
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }
  return new Response('{}', { status: 404 });
};

const { applyReconConfig } = await import('../../services/recon-service.js');
const { applyDownloadLogConfig } = await import('../../services/download-log.js');
const { applyEcmConfig } = await import('../../services/ecm-config.js');
applyReconConfig({ reconBaseUrl: RECON });
applyDownloadLogConfig({ downloadLog: { enabled: true } });
applyEcmConfig({ ecmBackendAws: false });
const { initReconAuth, ensureReconSignedIn, RECON_OFFLINE } = await import('../../popup/popup-recon-auth.js');

let destination = 'local';
initReconAuth({ getDestination: () => destination, setDestination: (v) => (destination = v) });
const $ = (id) => document.getElementById(id);
const tick = () => new Promise((r) => setTimeout(r, 0));
/** Wait until the sign-in page is up (ensureReconSignedIn asks the Recon Engine first). */
async function pageOpen() {
  for (let i = 0; i < 100 && $('view-recon-login').hidden; i++) await tick();
  assert.equal($('view-recon-login').hidden, false, 'the sign-in page is shown');
}

test('Recon gate (H2): Recon unreachable -> the run may go ahead without it ("offline")', async () => {
  recon.mode = 'down';
  const answer = ensureReconSignedIn({ always: true, allowOffline: true });
  await pageOpen();
  assert.equal($('btn-recon-offline').hidden, false, 'offered while the Recon Engine cannot be reached');
  assert.equal($('btn-recon-use-local').textContent, 'Cancel');
  $('btn-recon-offline').click();
  assert.equal(await answer, RECON_OFFLINE);
  assert.equal($('view-recon-login').hidden, true);
});

test('Recon gate (H2): signed out (401) -> sign in or cancel, never "offline"', async () => {
  recon.mode = 'signedOut';
  const answer = ensureReconSignedIn({ always: true, allowOffline: true });
  await pageOpen();
  assert.equal($('btn-recon-offline').hidden, true, 'a reachable Recon Engine needs a real sign-in');
  $('btn-recon-use-local').click();
  assert.equal(await answer, false);
});

test('Recon gate (H2): a caller that does not allow it never gets "offline"', async () => {
  recon.mode = 'down';
  const plain = ensureReconSignedIn({ always: true });
  await pageOpen();
  assert.equal($('btn-recon-offline').hidden, true);
  $('btn-recon-use-local').click();
  assert.equal(await plain, false);

  // two runs waiting on one page: the offline choice is offered only if both accept it
  const a = ensureReconSignedIn({ always: true, allowOffline: true });
  await pageOpen();
  assert.equal($('btn-recon-offline').hidden, false);
  const b = ensureReconSignedIn({ always: true });
  await tick();
  await tick();
  assert.equal($('btn-recon-offline').hidden, true, 'hidden once a waiting run does not accept it');
  $('btn-recon-use-local').click();
  assert.deepEqual([await a, await b], [false, false]);
});

test('Recon gate: signed in -> true at once, no page', async () => {
  recon.mode = 'signedIn';
  assert.equal(await ensureReconSignedIn({ always: true, allowOffline: true }), true);
  assert.equal($('view-recon-login').hidden, true);
});

// ------------------------------------------------ M3: which panel answers "download again?"
const { initRedownload } = await import('../../popup/popup-redownload.js');
const tabs = { own: 5, active: 5, existing: new Set([5, 7, 9]) };
initRedownload({ currentTabId: async () => tabs.active, ownTabId: () => tabs.own, tabExists: async (id) => tabs.existing.has(id) });
const QUESTION = { destination: 'local', alreadyDownloaded: [{ id: 'po-1', label: 'PO 1', count: 1, filename: 'PO_1.pdf', date: '2026-11-01', time: '10:00:00' }], inEcm: [] };

/** Deliver the worker's CONFIRM_REDOWNLOAD for a run started from `panelTabId`; resolves with the panel's answer, or null when it ignored it. */
function confirmFromWorker(panelTabId) {
  return new Promise((resolve) => {
    let answered = false;
    for (const fn of messageListeners) {
      fn({ target: 'popup', type: 'CONFIRM_REDOWNLOAD', panelTabId, question: QUESTION }, {}, (reply) => {
        answered = true;
        resolve(reply);
      });
    }
    setTimeout(() => !answered && resolve(null), 300);
  });
}
const promptShown = async () => {
  for (let i = 0; i < 50 && $('view-redownload').hidden; i++) await tick();
  return !$('view-redownload').hidden;
};

test('download again (M3): the panel that started the run answers even while the user looks at another tab', async () => {
  Object.assign(tabs, { own: 5, active: 9 });
  const reply = confirmFromWorker(5);
  assert.equal(await promptShown(), true, 'the prompt waits in the run\'s own panel');
  $('btn-redownload-skip').click();
  assert.deepEqual((await reply).redownload, []);
});

test("download again (M3): another tab's panel never answers for it", async () => {
  Object.assign(tabs, { own: 7, active: 5 });
  const reply = await confirmFromWorker(5);
  assert.equal(reply, null);
  assert.equal($('view-redownload').hidden, true);
});

test('download again (M3): when Chrome replaced this panel\'s tab id, the active tab decides (as before)', async () => {
  Object.assign(tabs, { own: 3, active: 5 });
  const reply = confirmFromWorker(5);
  assert.equal(await promptShown(), true);
  $('btn-redownload-skip').click();
  assert.ok(await reply);
});

// ------------------------------------------------ L10: "My downloads" (popup-downloads.js)
const { initDownloads } = await import('../../popup/popup-downloads.js');
const { localIsoDate } = await import('../../utils/dates.js');
const who = { user: { name: 'A', email: 'a@b.test', isAdmin: false }, signedIn: true };
initDownloads({
  showView: (name) => { $('view-downloads').hidden = name !== 'downloads'; },
  ensureSignedIn: async () => who.signedIn,
  currentUser: () => who.user,
  openSignIn: async () => {},
});
const rowsShown = () => [...$('downloads-list').querySelectorAll('tr')];
const record = (i, extra = {}) => ({ date: '2026-11-14', time: '10:05:30', doc_type: 'ic', filename: `IC_${i}.pdf`, destination: 'local', ireps_account_id: '833', ...extra });
/** Let the view's request to the fake Recon Engine and its rendering finish. */
const settle = async () => { for (let i = 0; i < 50; i++) await tick(); };
/** Open the view from the header icon (it is closed first, as the icon toggles it). */
async function openDownloads() {
  $('view-downloads').hidden = true;
  $('btn-downloads-open').click();
  await settle();
}

test('My downloads (L10): the signed-in user\'s downloads of the last 7 days, 50 at a time, each with where it went', async () => {
  recon.mode = 'signedIn';
  recon.listed.length = 0;
  const first = Array.from({ length: 50 }, (_, i) => record(i + 1));
  first[0] = record(1, { filename: '3480517.pdf', destination: 'ecm', ecm: { site: 'hosur', status: 'stored', uid: 'u-1', path: '/FT/workspaces/Sites/HSR/Invoice Certificate/Inputs/3480517 - IC' } });
  first[1] = record(2, { doc_type: 'bill_status', filename: 'IREPS_Bill_Status.xlsx', destination: 's3' });
  recon.downloads = (q) => [200, q.get('offset') === '50' ? { count: 53, downloads: [record(51), record(52), record(53)] } : { count: 53, downloads: first }];
  await openDownloads();
  assert.equal($('view-downloads').hidden, false);
  assert.equal($('downloads-who').textContent, 'Signed in as A (a@b.test)');
  assert.deepEqual([recon.listed[0].get('to'), recon.listed[0].get('limit'), recon.listed[0].get('offset'), recon.listed[0].get('all')], [localIsoDate(new Date()), '50', null, null], 'today back to 7 days ago, 50 rows, only this user');
  assert.equal(rowsShown().length, 50);
  assert.equal($('downloads-summary').textContent, '50 downloads so far, newest first.');
  const ecmCells = rowsShown()[0].querySelectorAll('td');
  assert.deepEqual([ecmCells[0].querySelector('.downloads-date').textContent, ecmCells[1].textContent, ecmCells[2].querySelector('.downloads-file').textContent], ['14/11/2026', 'Inspection Certificate', '3480517.pdf']);
  assert.equal(ecmCells[3].querySelector('.chip').textContent, 'ECM · Hosur');
  assert.equal(ecmCells[3].querySelector('.downloads-path').textContent, 'in Inputs', 'the folder; the full path is in the tooltip');
  assert.equal(ecmCells[3].title, '/FT/workspaces/Sites/HSR/Invoice Certificate/Inputs/3480517 - IC');
  assert.deepEqual([rowsShown()[1], rowsShown()[2]].map((tr) => tr.querySelector('.chip').textContent), ['S3', 'Local']);
  assert.equal($('btn-downloads-more').hidden, false);
  $('btn-downloads-more').click();
  await settle();
  assert.equal(recon.listed[1].get('offset'), '50');
  assert.equal(rowsShown().length, 53);
  assert.equal($('downloads-summary').textContent, '53 downloads, newest first.');
  assert.equal($('btn-downloads-more').hidden, true, 'a short page is the last one');
});

test('My downloads (L10): the filters go to the Recon Engine, and an admin may show everyone\'s downloads, the user under each file', async () => {
  recon.mode = 'signedIn';
  recon.listed.length = 0;
  who.user = { name: 'Admin', email: 'admin@b.test', isAdmin: true };
  try {
    recon.downloads = () => [200, { count: 1, downloads: [record(1, { user_email: 'someone@b.test', destination: 'ecm', ecm: { site: 'rohtak', status: 'already_stored', path: '/FT/x/Inputs/1 - IC' } })] }];
    await openDownloads();
    assert.equal($('downloads-all-wrap').hidden, false, 'only an admin gets "all users"');
    $('downloads-destination').value = 'ecm:rohtak';
    $('downloads-type').value = 'ic';
    $('downloads-all').checked = true;
    $('downloads-all').dispatchEvent(new Event('change'));
    await settle();
    const q = recon.listed.at(-1);
    assert.deepEqual([q.get('destination'), q.get('site'), q.get('doc_type'), q.get('all')], ['ecm', 'rohtak', 'ic', 'true']);
    const cells = rowsShown()[0].querySelectorAll('td');
    assert.equal(cells[2].querySelector('.downloads-user').textContent, 'someone@b.test');
    assert.match(cells[3].textContent, /already there/);
    assert.equal($('downloads-summary').textContent, '1 download by all users, newest first.');
  } finally {
    who.user = { name: 'A', email: 'a@b.test', isAdmin: false };
    $('downloads-destination').value = '';
    $('downloads-type').value = '';
    $('downloads-all').checked = false;
  }
});

test('My downloads (L10): not signed in, not allowed, or the Recon Engine down: each is said, and nothing is listed', async () => {
  recon.listed.length = 0;
  who.signedIn = false;
  try {
    await openDownloads();
    assert.equal(recon.listed.length, 0, 'nothing is asked before the sign-in');
    assert.equal($('downloads-error').hidden, false);
    assert.equal($('downloads-error-title').textContent, 'Recon Engine sign-in required');
    assert.equal($('btn-downloads-sign-in').hidden, false);
    who.signedIn = true;
    recon.mode = 'signedIn';
    recon.downloads = () => [403, { detail: 'admins only' }];
    $('btn-downloads-refresh').click();
    await settle();
    assert.equal($('downloads-error-title').textContent, 'Admins only');
    assert.equal($('btn-downloads-sign-in').hidden, true);
    recon.mode = 'down';
    $('btn-downloads-refresh').click();
    await settle();
    assert.equal($('downloads-error-title').textContent, 'Download log unavailable');
    assert.equal(rowsShown().length, 0);
    assert.equal($('btn-downloads-more').hidden, true);
  } finally {
    who.signedIn = true;
  }
});

// ------------------------------------------------ PO / IC bulk downloads (popup-po-ic-batch.js)
const { initBatch, restoreBatch } = await import('../../popup/popup-po-ic-batch.js');
const batch = { view: 'main', running: [] };
initBatch({
  send: async (type, { kind } = {}) => (type === 'BATCH_GET_STATE' ? { kind, phase: 'idle', running: batch.running.includes(kind) } : null),
  showView: (name) => { batch.view = name; },
  setConnection: () => {},
  setConnectionForError: () => {},
  getDestination: () => 'local',
});
const CARDS = { 'po-date': 'card-pod', 'ic-date': 'card-icd', 'ic-notif': 'card-icn' };
const cardsShown = () => Object.entries(CARDS).filter(([, id]) => !$(id).hidden).map(([kind]) => kind);

test('PO / IC bulk downloads: each of the three buttons opens the batch view with its own card only', async () => {
  for (const [button, kind] of [['btn-batch-pod', 'po-date'], ['btn-batch-icd', 'ic-date'], ['btn-batch-icn', 'ic-notif']]) {
    batch.view = 'po-ic';
    $(button).click();
    await tick();
    assert.equal(batch.view, 'po-ic-batch', button);
    assert.deepEqual(cardsShown(), [kind], `${button} shows only its card`);
  }
});

test("PO / IC bulk downloads: every card's Back button returns to the PO / IC view", () => {
  for (const back of ['btn-pod-back', 'btn-icd-back', 'btn-icn-back']) {
    batch.view = 'po-ic-batch';
    $(back).click();
    assert.equal(batch.view, 'po-ic', back);
  }
});

test('PO / IC bulk downloads: a run still going when the panel reopens brings back its own card', async () => {
  batch.running = ['ic-date'];
  try {
    assert.equal(await restoreBatch(), true);
    assert.equal(batch.view, 'po-ic-batch');
    assert.deepEqual(cardsShown(), ['ic-date']);
    batch.running = [];
    batch.view = 'main';
    assert.equal(await restoreBatch(), false, 'nothing running: the panel stays where it is');
    assert.equal(batch.view, 'main');
  } finally {
    batch.running = [];
  }
});

test('Back buttons are buttons, not links: every Back in the panel has the btn-back style', () => {
  const backs = [...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Back');
  assert.ok(backs.length >= 10, `${backs.length} Back buttons`);
  for (const b of backs) assert.ok(b.classList.contains('btn-back') && !b.classList.contains('btn-link'), b.id);
});

test('No em or en dash in what the panel shows: popup.html and the panel and tender UI scripts use "-"', () => {
  const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
  const files = ['popup/popup.html', 'pages/preview.html', 'utils/messages.js', 'tender/view-common.js', 'tender/pending-ui.js', 'tender/tender-ui.js',
    ...['popup', 'pages'].flatMap((dir) => readdirSync(new URL(`../../${dir}/`, import.meta.url)).filter((f) => f.endsWith('.js')).map((f) => `${dir}/${f}`))];
  for (const file of files) {
    const line = read(file).split('\n').findIndex((l) => /[–—]/.test(l));
    assert.equal(line, -1, `${file}:${line + 1} has an em or en dash`);
  }
});

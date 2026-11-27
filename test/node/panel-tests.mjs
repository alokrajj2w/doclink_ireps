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
 * `downloads(query)` -> [status, body] answers GET /api/doclink/downloads ("My downloads"); `listed` keeps each query;
 * `hold` (a promise) keeps the next such answer until it settles.
 */
const recon = { mode: 'down', listed: [], downloads: () => [200, { count: 0, downloads: [] }], hold: null };
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
    const hold = recon.hold;
    recon.hold = null;
    if (hold) await hold;
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
const { initReconAuth, ensureReconSignedIn, openReconSignIn, refreshReconStatus, reconUnreachable, RECON_OFFLINE } = await import('../../popup/popup-recon-auth.js');

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

test('7.6: under Save to: Local the RECON pill and "Sign in to Recon" open the sign-in page; Cancel leaves Save to as it is', async () => {
  recon.mode = 'signedOut';
  destination = 'local';
  await refreshReconStatus();
  assert.equal($('recon-connection-text').textContent, 'Sign in');
  $('recon-connection').click();
  await pageOpen();
  assert.equal($('btn-recon-use-local').textContent, 'Cancel', 'Save to is Local already');
  $('btn-recon-use-local').click();
  assert.equal($('view-recon-login').hidden, true);
  assert.equal(destination, 'local');
  // an error panel's "Sign in to Recon" (popup.js: OPEN_RECON)
  const asked = openReconSignIn();
  await pageOpen();
  $('btn-recon-use-local').click();
  await asked;
  assert.equal($('view-recon-login').hidden, true);
});

// ------------------------------------------------ M3: which panel answers "download again?"
const { initRedownload } = await import('../../popup/popup-redownload.js');
const tabs = { own: 5, active: 5, existing: new Set([5, 7, 9]) };
initRedownload({ currentTabId: async () => tabs.active, ownTabId: () => tabs.own, tabExists: async (id) => tabs.existing.has(id) });
const QUESTION = { destination: 'local', alreadyDownloaded: [{ id: 'po-1', label: 'PO 1', count: 1, filename: 'PO_1.pdf', date: '2026-11-01', time: '10:00:00' }], inEcm: [] };

/**
 * Deliver the worker's CONFIRM_REDOWNLOAD for a run started from `panelTabId` (with the time the run stops waiting,
 * `deadline`, when given); resolves with the panel's answer, or null when none came within `wait` ms.
 */
function confirmFromWorker(panelTabId, { deadline, wait = 300 } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    for (const fn of messageListeners) {
      fn({ target: 'popup', type: 'CONFIRM_REDOWNLOAD', panelTabId, question: QUESTION, ...(deadline ? { deadline } : {}) }, {}, (reply) => {
        answered = true;
        resolve(reply);
      });
    }
    setTimeout(() => !answered && resolve(null), wait);
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

/** The "not answered in time" notice is up: the files with their boxes off, only OK; OK closes it. */
function lateNoticeShown() {
  assert.equal($('view-redownload').hidden, false, 'the page says what happened');
  assert.match($('redownload-summary').textContent, /^Not answered in time: The download waited 4 minutes for this answer, then went on without the file below: they were skipped/);
  assert.deepEqual([$('btn-redownload-skip').hidden, $('btn-redownload-again').hidden, $('btn-redownload-ok').hidden], [true, true, false], 'only OK');
  assert.ok([...$('redownload-list').querySelectorAll('input')].every((box) => box.disabled), 'nothing to tick any more');
  $('btn-redownload-ok').click();
  assert.equal($('view-redownload').hidden, true);
}

test('7.4: the question\'s time counts from when the worker asked: one whose time is up is answered "skip" at once, and the page says so', async () => {
  Object.assign(tabs, { own: 5, active: 5 });
  // the worker stops waiting in 1 s: less than the moment an answer needs to reach it
  const answer = await confirmFromWorker(5, { deadline: Date.now() + 1000 });
  assert.deepEqual(answer, { redownload: [], sameForRun: false, timedOut: true }, 'answered as the worker takes it, never left open past its wait');
  lateNoticeShown();
  // a question in time is asked and answered as before
  const reply = confirmFromWorker(5, { deadline: Date.now() + 4 * 60 * 1000 });
  assert.equal(await promptShown(), true);
  assert.equal($('btn-redownload-ok').hidden, true);
  $('btn-redownload-skip').click();
  assert.deepEqual(await reply, { redownload: [], sameForRun: false });
});

test('7.4: a question that waited behind another is never shown past the worker\'s wait: it says it was not answered in time', async () => {
  Object.assign(tabs, { own: 5, active: 5 });
  const first = confirmFromWorker(5, { deadline: Date.now() + 4 * 60 * 1000, wait: 3000 });
  assert.equal(await promptShown(), true);
  // asked while the first is on screen; the worker stops waiting for it 150 ms past the answer margin
  const second = confirmFromWorker(5, { deadline: Date.now() + 5000 + 150, wait: 3000 });
  await new Promise((r) => setTimeout(r, 250));
  $('btn-redownload-skip').click();
  assert.deepEqual((await first).redownload, []);
  assert.equal((await second).timedOut, true, 'its time ran out while it waited: "skip", not a fresh question');
  lateNoticeShown();
});

test('7.5: the download-again question, the Recon sign-in page and the gate never hide each other into a blank panel; the question stays on top', async () => {
  // jsdom does not load popup.html's stylesheet: the real popup.css, for the computed display of each view
  const style = document.createElement('style');
  style.textContent = readFileSync(new URL('../../popup/popup.css', import.meta.url), 'utf8');
  document.head.append(style);
  const displayed = () => ['view-gate', 'view-recon-login', 'view-redownload', 'view-main'].filter((id) => dom.window.getComputedStyle($(id)).display !== 'none');
  try {
    Object.assign(tabs, { own: 5, active: 5 });
    recon.mode = 'signedOut';
    const reply = confirmFromWorker(5, { wait: 3000 });
    assert.equal(await promptShown(), true);
    assert.deepEqual(displayed(), ['view-redownload']);
    // a run that needs the Recon sign-in opens its page meanwhile (as the RECON pill does)
    const signIn = ensureReconSignedIn({ always: true });
    await pageOpen();
    assert.deepEqual(displayed(), ['view-redownload'], 'the question stays over the sign-in page');
    // the tab leaves IREPS: the gate comes up (popup-gate.js)
    $('view-gate').hidden = false;
    document.body.dataset.gate = 'on';
    assert.deepEqual(displayed(), ['view-redownload'], 'and over the gate');
    $('btn-redownload-skip').click();
    assert.deepEqual(await reply, { redownload: [], sameForRun: false }, 'answered by the user, never skipped unseen');
    assert.deepEqual(displayed(), ['view-recon-login'], 'then the sign-in page, over the gate');
    $('btn-recon-use-local').click();
    assert.equal(await signIn, false);
    assert.deepEqual(displayed(), ['view-gate'], 'then the gate: never a blank panel');
    $('view-gate').hidden = true;
    delete document.body.dataset.gate;
    assert.deepEqual(displayed(), ['view-main']);
  } finally {
    $('view-gate').hidden = true;
    delete document.body.dataset.gate;
    style.remove();
  }
});

// ------------------------------------------------ L10: "My downloads" (popup-downloads.js)
const { initDownloads, allDownloads, savedFilesSheet } = await import('../../popup/popup-downloads.js');
const { XLSX_MIME_TYPE } = await import('../../utils/xlsx-writer.js');
const { describeError: describeErr } = await import('../../utils/messages.js');
const { localIsoDate } = await import('../../utils/dates.js');
const { dayLabel } = await import('../../services/scheduler/run-log.js');
/** The local day `back` days before today, as the view asks for it. */
const dayBack = (back) => localIsoDate(new Date(Date.now() - back * 86400000));
const who = { user: { name: 'A', email: 'a@b.test', isAdmin: false }, signedIn: true, unreachable: false };
initDownloads({
  showView: (name) => { $('view-downloads').hidden = name !== 'downloads'; },
  ensureSignedIn: async () => who.signedIn,
  currentUser: () => who.user,
  openSignIn: async () => {},
  reconUnreachable: () => who.unreachable,
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

test('My downloads (L10): a button for each of the last 3 days with downloads; the newest is shown, 50 at a time, each with where it went', async () => {
  recon.mode = 'signedIn';
  recon.listed.length = 0;
  const first = Array.from({ length: 50 }, (_, i) => record(i + 1));
  first[0] = record(1, { filename: '3480517.pdf', destination: 'ecm', ecm: { site: 'hosur', status: 'stored', uid: 'u-1', path: '/FT/workspaces/Sites/HSR/Invoice Certificate/Inputs/3480517 - IC' } });
  first[1] = record(2, { doc_type: 'bill_status', filename: 'IREPS_Bill_Status.xlsx', destination: 's3' });
  recon.downloads = (q) => [200, q.get('offset') === '50' ? { count: 53, downloads: [record(51), record(52), record(53)] } : { count: 53, downloads: q.get('limit') === '1' ? first.slice(0, 1) : first }];
  await openDownloads();
  assert.equal($('view-downloads').hidden, false);
  assert.equal($('downloads-who').textContent, 'Signed in as A (a@b.test)');
  const counts = recon.listed.filter((q) => q.get('limit') === '1');
  assert.deepEqual(counts.map((q) => `${q.get('from')}|${q.get('to')}`), [0, 1, 2].map((b) => `${dayBack(b)}|${dayBack(b)}`), 'one count per day back from today, until 3 days had downloads');
  const page = recon.listed.find((q) => q.get('limit') === '50');
  assert.deepEqual([page.get('from'), page.get('to'), page.get('offset'), page.get('all')], [dayBack(0), dayBack(0), null, null], 'the newest day, 50 rows, only this user');
  assert.deepEqual([...$('downloads-days').options].map((o) => `${o.textContent}|${o.selected}|${o.disabled}`), [...[0, 1, 2].map((b) => `${dayLabel(dayBack(b))} · 53 downloads|${b === 0}|false`), 'Other dates|false|false', 'Only the last 3 days with downloads are listed here.|false|true'], 'a Day dropdown, its note at the foot');
  assert.equal($('downloads-range').hidden, true, 'the From - To row only for other dates');
  assert.equal(rowsShown().length, 50);
  assert.equal($('downloads-summary').textContent, `50 downloads on ${dayLabel(dayBack(0))} so far, newest first.`);
  const ecmCells = rowsShown()[0].querySelectorAll('td');
  assert.deepEqual([ecmCells[0].querySelector('.downloads-date').textContent, ecmCells[1].textContent, ecmCells[2].querySelector('.downloads-file').textContent], ['14/11/2026', 'Inspection Certificate', '3480517.pdf']);
  assert.equal(ecmCells[3].querySelector('.chip').textContent, 'ECM · Hosur');
  assert.equal(ecmCells[3].querySelector('.downloads-path').textContent, 'in Inputs', 'the folder; the full path is in the tooltip');
  assert.equal(ecmCells[3].title, '/FT/workspaces/Sites/HSR/Invoice Certificate/Inputs/3480517 - IC');
  assert.deepEqual([rowsShown()[1], rowsShown()[2]].map((tr) => tr.querySelector('.chip').textContent), ['S3', 'Local']);
  assert.equal($('btn-downloads-more').hidden, false);
  $('btn-downloads-more').click();
  await settle();
  assert.equal(recon.listed.at(-1).get('offset'), '50');
  assert.equal(rowsShown().length, 53);
  assert.equal($('downloads-summary').textContent, `53 downloads on ${dayLabel(dayBack(0))}, newest first.`);
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
    assert.equal($('downloads-summary').textContent, `1 download on ${dayLabel(dayBack(0))} by all users, newest first.`);
    assert.deepEqual([q.get('from'), q.get('to')], [dayBack(0), dayBack(0)], 'the day shown');
    assert.equal(recon.listed.filter((x) => x.get('limit') === '1').every((x) => x.get('doc_type') === 'ic' || x.get('doc_type') === null), true, 'the days are counted with the filters');
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

test('4.11: My downloads with the Recon Engine down says it is unavailable, never "sign-in required"', async () => {
  // the sign-in check tells "cannot be reached" from "nobody signed in" (popup-recon-auth.js, which popup.js hands the view)
  recon.mode = 'down';
  await refreshReconStatus();
  assert.equal(reconUnreachable(), true);
  recon.mode = 'signedOut';
  await refreshReconStatus();
  assert.equal(reconUnreachable(), false, 'signed out is not unreachable');
  recon.listed.length = 0;
  Object.assign(who, { signedIn: false, unreachable: true });
  try {
    await openDownloads();
    assert.equal(recon.listed.length, 0);
    assert.equal($('downloads-error-title').textContent, 'Download log unavailable');
    assert.match($('downloads-error-message').textContent, /could not reach the Recon Engine to read your downloads \(it did not answer\)\. This is not a sign-in problem/);
    assert.equal($('btn-downloads-sign-in').hidden, true, 'signing in cannot help while it does not answer');
  } finally {
    Object.assign(who, { signedIn: true, unreachable: false });
  }
});

test('7.9: My downloads: a filter changed while a page is being read is never dropped: the list is the new filter\'s', async () => {
  recon.mode = 'signedIn';
  recon.listed.length = 0;
  let release;
  recon.hold = new Promise((r) => (release = r));
  recon.downloads = (q) => [200, { count: 1, downloads: [record(1, q.get('doc_type') === 'ic' ? { filename: 'IC_new.pdf' } : { doc_type: 'po', filename: 'PO_old.pdf' })] }];
  try {
    $('view-downloads').hidden = true;
    $('btn-downloads-open').click();
    for (let i = 0; i < 50 && recon.listed.length === 0; i++) await tick();
    assert.equal(recon.listed.length, 1, 'the first request (today\'s count) is being read');
    $('downloads-type').value = 'ic';
    $('downloads-type').dispatchEvent(new Event('change'));
    await settle();
    release();
    await settle();
    assert.equal(recon.listed.at(-1).get('doc_type'), 'ic', 'the new filter is asked for');
    assert.deepEqual(rowsShown().map((tr) => tr.querySelector('.downloads-file').textContent), ['IC_new.pdf'], 'and only its downloads are listed');
    assert.equal($('downloads-summary').textContent, `1 download on ${dayLabel(dayBack(0))}, newest first.`);
    assert.equal($('btn-downloads-refresh').disabled, false);
  } finally {
    $('downloads-type').value = '';
    recon.hold = null;
  }
});

test('My downloads: days without downloads (a weekend) are skipped; a day button shows that day, "Other dates" the From - To range', async () => {
  recon.mode = 'signedIn';
  recon.listed.length = 0;
  // downloads today, none on the 2 days before, then 4 and 2 (a Monday after a weekend)
  const perDay = { [dayBack(0)]: 5, [dayBack(3)]: 4, [dayBack(4)]: 2 };
  recon.downloads = (q) => {
    const n = q.get('from') === q.get('to') ? perDay[q.get('from')] || 0 : 11;
    return [200, { count: n, downloads: Array.from({ length: Math.min(n, Number(q.get('limit'))) }, (_, i) => record(i + 1)) }];
  };
  const choices = () => [...$('downloads-days').options].filter((o) => !o.disabled);
  const choose = (option) => {
    $('downloads-days').value = option.value;
    $('downloads-days').dispatchEvent(new Event('change'));
  };
  await openDownloads();
  assert.deepEqual(choices().map((o) => o.textContent), [`${dayLabel(dayBack(0))} · 5 downloads`, `${dayLabel(dayBack(3))} · 4 downloads`, `${dayLabel(dayBack(4))} · 2 downloads`, 'Other dates']);
  assert.equal(recon.listed.filter((q) => q.get('limit') === '1').length, 5, 'asked day by day until 3 days had downloads');
  choose(choices()[1]);
  await settle();
  const day = recon.listed.at(-1);
  assert.deepEqual([day.get('from'), day.get('to'), day.get('limit')], [dayBack(3), dayBack(3), '50']);
  assert.equal(rowsShown().length, 4);
  assert.equal(choices()[1].selected, true);
  // other dates: the From - To row, starting on the oldest day offered
  choose(choices().at(-1));
  await settle();
  assert.equal($('downloads-range').hidden, false);
  assert.deepEqual([$('downloads-from').value, $('downloads-to').value], [dayBack(4), dayBack(0)]);
  const range = recon.listed.at(-1);
  assert.deepEqual([range.get('from'), range.get('to')], [dayBack(4), dayBack(0)]);
  assert.equal($('downloads-summary').textContent, '11 downloads, newest first.');
});
/** Catch the files the panel saves (URL.createObjectURL + a link clicked) while `run` runs: [{ blob, name }]. */
async function filesSaved(run) {
  const files = [];
  const { createObjectURL, revokeObjectURL } = URL;
  const click = dom.window.HTMLAnchorElement.prototype.click;
  URL.createObjectURL = (blob) => (files.push({ blob }), `blob:test/${files.length}`);
  URL.revokeObjectURL = () => {};
  dom.window.HTMLAnchorElement.prototype.click = function () { files.at(-1).name = this.download; };
  try {
    await run();
  } finally {
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    dom.window.HTMLAnchorElement.prototype.click = click;
  }
  return files;
}

test('My downloads: Download Excel saves every download of the day shown (every page, the same filters) as one .xlsx; the button says how many', async () => {
  recon.mode = 'signedIn';
  recon.listed.length = 0;
  const all = Array.from({ length: 120 }, (_, i) => record(i + 1));
  all[0] = record(1, { destination: 'ecm', ecm: { site: 'hosur', status: 'stored', path: '/FT/workspaces/Sites/HSR/Invoice Certificate/Inputs/IC_1 - IC' } });
  recon.downloads = (q) => {
    const offset = Number(q.get('offset') || 0);
    return [200, { count: all.length, downloads: all.slice(offset, offset + Number(q.get('limit'))) }];
  };
  await openDownloads();
  assert.equal($('downloads-export').hidden, false, 'shown with rows');
  const table = recon.listed.find((q) => q.get('limit') === '50');
  const before = recon.listed.length;
  const files = await filesSaved(async () => {
    $('btn-downloads-excel').click();
    await settle();
  });
  const reads = recon.listed.slice(before);
  assert.deepEqual(reads.map((q) => q.get('offset')), [null, '50', '100'], 'page by page to the end');
  const keys = ['from', 'to', 'doc_type', 'destination', 'site', 'all', 'limit'];
  for (const q of reads) assert.deepEqual(keys.map((k) => q.get(k)), keys.map((k) => table.get(k)), 'the selection the table shows');
  assert.deepEqual(files.map((f) => [f.name, f.blob.type]), [[`DocLink_saved_files_${dayBack(0)}.xlsx`, XLSX_MIME_TYPE]]);
  const xml = Buffer.from(await files[0].blob.arrayBuffer()).toString('utf8');
  assert.ok(xml.startsWith('PK'), 'an .xlsx (a zip)');
  for (const cell of ['IREPS account', 'ECM folder', 'IC_1.pdf', 'IC_120.pdf', '/FT/workspaces/Sites/HSR/Invoice Certificate/Inputs/IC_1 - IC']) assert.ok(xml.includes(`>${cell}<`), cell);
  assert.equal($('btn-downloads-excel').textContent, 'Saved 120 rows');
  assert.equal($('btn-downloads-excel').disabled, false);
});

test('My downloads: the Excel sheet keeps each row as the log gives it, where it went, and the user when an admin shows everyone\x27s', () => {
  const ecm = record(7, { time: '09:41:18', destination: 'ecm', ecm: { site: 'rohtak', status: 'already_stored', path: '/FT/x/Inputs/7 - IC' }, user_email: 's@b.test' });
  const sheet = savedFilesSheet([ecm, record(8, { doc_type: 'bill_status', filename: 'IREPS_Bill_Status.xlsx', destination: 's3' })], true);
  assert.deepEqual(sheet.headers, ['Date', 'Time', 'Type', 'File', 'IREPS account', 'Location', 'ECM site', 'ECM folder', 'Note', 'User']);
  assert.deepEqual(sheet.rows, [
    ['14/11/2026', '09:41:18', 'Inspection Certificate', 'IC_7.pdf', '833', 'ECM', 'Rohtak', '/FT/x/Inputs/7 - IC', 'already in the ECM, not stored twice', 's@b.test'],
    ['14/11/2026', '10:05:30', 'Bill Status', 'IREPS_Bill_Status.xlsx', '833', 'S3', '', '', '', '']
  ]);
  assert.deepEqual(savedFilesSheet([record(9)]).rows[0].slice(5), ['Local', '', '', ''], 'no user column for your own');
});

test('My downloads: Download Excel reads 5,000 rows at most and says when there were more; exactly 5,000 are all of them', async () => {
  recon.mode = 'signedIn';
  for (const [count, cut] of [[5000, false], [5060, true]]) {
    recon.downloads = (q) => {
      const offset = Number(q.get('offset') || 0);
      const n = Math.max(0, Math.min(Number(q.get('limit')), count - offset));
      return [200, { count, downloads: Array.from({ length: n }, (_, i) => record(offset + i + 1)) }];
    };
    recon.listed.length = 0;
    const got = await allDownloads({ from: dayBack(0), to: dayBack(0) });
    assert.deepEqual([got.rows.length, got.cut, recon.listed.length], [5000, cut, 100], `${count} in the log`);
  }
});

test('My downloads: no rows, no Download Excel; an export the download log does not answer is said in the view, and nothing is saved', async () => {
  recon.mode = 'signedIn';
  recon.downloads = () => [200, { count: 0, downloads: [] }];
  await openDownloads();
  assert.equal($('downloads-export').hidden, true, 'nothing to export');
  recon.downloads = (q) => [200, { count: 2, downloads: [record(1), record(2)].slice(0, Number(q.get('limit'))) }];
  await openDownloads();
  assert.equal($('downloads-export').hidden, false);
  recon.downloads = () => [503, { detail: 'down' }];
  const files = await filesSaved(async () => {
    $('btn-downloads-excel').click();
    await settle();
  });
  assert.equal(files.length, 0);
  assert.deepEqual([$('downloads-error').hidden, $('downloads-error-title').textContent], [false, describeErr('DOWNLOAD_LOG_LIST_UNAVAILABLE').title]);
  assert.equal($('btn-downloads-excel').textContent, 'Download Excel', 'back to its label at once');
  assert.equal(rowsShown().length, 2, 'the rows shown stay');
});

// ------------------------------------------------ the whole panel (popup.js) on a fake worker: whose runs it shows (7.1),
// what a result says (1.1, 1.16-1.19), and states read when a view opens (4.9, 4.10)
const { MESSAGE_TYPES: MT, describeError: described, SCHEDULED_RUN } = await import('../../utils/messages.js');
const OWN_TAB = 5;
const IREPS = 'http://localhost:8765';
/** The job states the fake worker answers GET_* with, and every request the panel sent it. */
const worker = { states: {}, sent: [] };
const memoryArea = () => {
  const data = new Map();
  return {
    data,
    get: async (key) => (typeof key === 'string' ? (data.has(key) ? { [key]: data.get(key) } : {}) : Object.fromEntries(data)),
    set: async (items) => { for (const [k, v] of Object.entries(items)) data.set(k, v); },
    remove: async (key) => void data.delete(key),
  };
};
function fakeWorker(message) {
  worker.sent.push(message);
  const s = worker.states;
  switch (message.type) {
    case MT.GET_TAB_SCOPE: return { scope: 'ACTIVE_PORTAL', target: 'mock', portalUrl: IREPS };
    case MT.CHECK_IREPS_SESSION: case MT.SEARCH_PO_LOAD_FORM: return { authenticated: true, code: 'OK', reason: null, form: null };
    case MT.GET_JOB_STATE: return s.job || { status: 'idle' };
    case MT.GET_DOCUMENT_JOB_STATE: return (s.docs && s.docs[message.criteria]) || { status: 'idle', criteria: message.criteria };
    case MT.GET_MA_STATE: return s.ma || { status: 'idle' };
    case MT.MA_RESET: return s.maReset || { ok: true };
    case MT.GET_PO_STATE: return s.po || { status: 'idle' };
    case MT.GET_IC_STATE: return s.ic || { status: 'idle' };
    case MT.BATCH_GET_STATE: return (s.batch && s.batch[message.kind]) || { kind: message.kind, phase: 'idle', running: false, busyWith: null };
    case MT.BILL_UPLOAD_GET_STATE: case MT.SCHEDULE_GET_STATE: return null;
    default: return { ok: true, started: true };
  }
}
/** A worker broadcast, to every listener of the panel (as chrome.runtime.sendMessage delivers it). */
const toPanel = (message) => { for (const fn of messageListeners) fn({ target: 'popup', ...message }, {}, () => {}); };
const shownViews = () => [...document.querySelectorAll('main > section.view')].filter((v) => !v.hidden).map((v) => v.id);
const SKIP = { reason: 'already_saved_for_account', by: 'Rahul', date: '2026-11-16', time: '15:02:00' };

test('Panel: the whole side panel (popup.js) opens on an IREPS tab and asks the worker only for state', async () => {
  chrome.runtime.sendMessage = async (m) => fakeWorker(m);
  chrome.storage = { local: memoryArea(), session: memoryArea(), onChanged: { addListener() {} } };
  const tab = { id: OWN_TAB, active: true, windowId: 1, url: `${IREPS}/epsn/home/showHome.do` };
  chrome.tabs = { query: async () => [tab], get: async (id) => ({ id }), onActivated: { addListener() {} }, onUpdated: { addListener() {} }, onReplaced: { addListener() {} } };
  chrome.windows = { getCurrent: async () => ({ id: 1 }) };
  chrome.downloads = { show() {} };
  dom.window.HTMLElement.prototype.scrollIntoView = () => {}; // not in jsdom
  // this panel belongs to tab 5 (the worker opens each tab's panel as popup.html?tabId=<id>)
  globalThis.location = { search: `?tabId=${OWN_TAB}`, protocol: 'http:' };
  recon.mode = 'signedIn';
  // a reopened panel (7.7): a Bill Status error of a minute ago, this panel's CRN export and MA download still
  // running, and a batch another tab's panel runs
  worker.states = {
    job: { status: 'error', stage: 'ERROR', error: described('IREPS_UNAVAILABLE', { detail: 'IREPS returned HTTP 503' }), startedBy: OWN_TAB, updatedAt: Date.now() - 60000 },
    docs: { CRN: { status: 'running', stage: 'SEARCHING', message: 'Searching CRNs...', criteria: 'CRN', startedBy: OWN_TAB, updatedAt: Date.now() } },
    ma: { status: 'downloading', startedBy: OWN_TAB, recordCount: 1, allRecordCount: 1, records: [{ id: 'ma-9', maNo: '009', poNo: 'PO9', maPdfUrl: `${IREPS}/ma/9.pdf` }], downloads: null, error: null, running: true, busyWith: OWN_TAB },
    batch: { 'ic-date': { kind: 'ic-date', phase: 'searching', running: false, busyWith: 9, startedBy: 9 } },
  };
  await import('../../popup/popup.js');
  await settle();
  assert.deepEqual(shownViews(), ['view-main']);
  assert.equal($('connection-text').textContent, 'Connected');
});

test('7.7: on reopen every view\'s state comes back on its own: a recent Bill Status result does not leave the other jobs looking idle', async () => {
  assert.equal($('result-error').hidden, false, 'the Bill Status error is shown');
  assert.equal($('error-title').textContent, 'IREPS not responding');
  const crn = $('card-crn');
  assert.equal(crn.querySelector('[data-role="progress"]').hidden, false, 'the running CRN export shows its progress');
  assert.equal(crn.querySelector('[data-role="download"]').disabled, true, 'and its Download button waits');
  assert.equal($('btn-ma-search').disabled, true, 'the running MA download is restored: Search MAs waits for it');
  assert.match($('background-runs').textContent, /^ICs by IC date: a download started in another tab's DocLink panel is running/);
  assert.equal($('btn-icd-download').disabled, true, "the batch buttons wait for the other tab's batch");
  // the other tab's batch ends; the panel's own jobs are left to the tests below
  worker.states = {};
  toPanel({ type: MT.BATCH_UPDATE, kind: 'ic-date', state: { kind: 'ic-date', phase: 'complete', running: false, busyWith: null, startedBy: 9 } });
  assert.equal($('background-runs').hidden, true);
  assert.equal($('btn-icd-download').disabled, false);
});

test('7.14: the footer says it shows the last Bill Status download, not the last download of every kind', () => {
  assert.equal($('meta-last-download-label').textContent, 'Last Bill Status download:');
  assert.match(document.querySelector('.app-footer').title, /^The last Bill Status download in this browser \(yours or a scheduled one\)\. Every other download shows its result in its own card or view\.$/);
});

test('7.1: a scheduled Bill Status run never takes the panel over: no view switch, no login view, no result; the panel says it runs and its button waits', async () => {
  $('btn-ma-open').click();
  await settle();
  assert.deepEqual(shownViews(), ['view-ma']);
  toPanel({ type: MT.IREPS_PROGRESS, stage: 'FETCHING', message: 'Retrieving Bill Status...', startedBy: SCHEDULED_RUN });
  assert.deepEqual(shownViews(), ['view-ma'], 'the MA view stays');
  assert.match($('background-runs').textContent, /^Bill Status: a scheduled download is running in the background/);
  assert.equal($('background-runs').hidden, false);
  assert.equal($('btn-download').disabled, true, 'the Bill Status button waits for it');
  toPanel({ type: MT.IREPS_DOWNLOAD_ERROR, ...described('IREPS_SESSION_EXPIRED'), startedBy: SCHEDULED_RUN });
  assert.deepEqual(shownViews(), ['view-ma'], 'no login view for a run this panel did not start');
  assert.equal($('background-runs').hidden, true);
  assert.equal($('btn-download').disabled, false);
  toPanel({ type: MT.IREPS_DOWNLOAD_COMPLETE, recordCount: 3, destination: 'recon', startedBy: 9 });
  assert.equal($('main-result').hidden, true, "another tab's result is not shown as this panel's");
  // this panel's own run shows as before, and says the download log's warning (1.1)
  toPanel({ type: MT.IREPS_PROGRESS, stage: 'FETCHING', message: 'Retrieving Bill Status...', startedBy: OWN_TAB });
  assert.deepEqual(shownViews(), ['view-main']);
  const logWarning = described('DOWNLOAD_LOG_UNAVAILABLE', { detail: 'the Recon Engine did not answer' }).message;
  toPanel({ type: MT.IREPS_DOWNLOAD_COMPLETE, recordCount: 3, destination: 'local', filename: 'Bill_Status.xlsx', warnings: [logWarning], startedBy: OWN_TAB });
  assert.equal($('main-result-title').textContent, '✓ Bill Status downloaded successfully');
  assert.ok($('main-result-summary').textContent.includes(logWarning), $('main-result-summary').textContent);
});

test("1.1, 7.1: a CRN export short of IREPS's total says so, never a plain \"successfully\"; a scheduled R-NOTE result never replaces it", async () => {
  const incomplete = 'IREPS reported 500 CRN result(s) but 450 were read';
  toPanel({ type: MT.DOCUMENT_DOWNLOAD_COMPLETE, criteria: 'CRN', recordCount: 450, pagesFetched: 23, destination: 'local', format: 'xlsx', filename: 'CRN.xlsx', incomplete, warnings: [], startedBy: OWN_TAB });
  assert.equal($('main-result-title').textContent, 'CRN export downloaded, but IREPS listed more records');
  assert.ok($('main-result').classList.contains('is-notice') && !$('main-result').classList.contains('result-success'), $('main-result').className);
  assert.ok($('main-result-summary').textContent.includes(`${incomplete}; some may be missing from this file.`), $('main-result-summary').textContent);
  const rnoteButton = document.querySelector('#card-rnote [data-role="download"]');
  toPanel({ type: MT.DOCUMENT_PROGRESS, criteria: 'RNOTE', stage: 'SEARCHING', message: 'Searching R-NOTEs...', startedBy: SCHEDULED_RUN });
  assert.equal(rnoteButton.disabled, true);
  assert.match($('background-runs').textContent, /^R-NOTE: a scheduled download is running/);
  toPanel({ type: MT.DOCUMENT_DOWNLOAD_COMPLETE, criteria: 'RNOTE', recordCount: 9, destination: 'recon', startedBy: SCHEDULED_RUN });
  assert.equal($('main-result-title').textContent, 'CRN export downloaded, but IREPS listed more records', "the scheduled R-NOTE result is not this panel's");
  assert.equal(rnoteButton.disabled, false);
  toPanel({ type: MT.DOCUMENT_DOWNLOAD_ERROR, criteria: 'CRN', ...described('IREPS_SESSION_EXPIRED'), startedBy: SCHEDULED_RUN });
  assert.deepEqual(shownViews(), ['view-main'], 'no login view');
});

test("7.8: this panel's Bill Status run never takes away the CRN result that just finished; only a CRN run makes way for its own", async () => {
  const crnTitle = 'CRN export downloaded, but IREPS listed more records';
  assert.equal($('main-result-title').textContent, crnTitle);
  toPanel({ type: MT.IREPS_PROGRESS, stage: 'FETCHING', message: 'Retrieving Bill Status...', startedBy: OWN_TAB });
  assert.equal($('main-result').hidden, false, 'the CRN result stays while Bill Status runs');
  assert.equal($('main-result-title').textContent, crnTitle);
  toPanel({ type: MT.IREPS_DOWNLOAD_ERROR, ...described('IREPS_UNAVAILABLE', { detail: 'IREPS returned HTTP 503' }), startedBy: OWN_TAB });
  assert.deepEqual([$('main-result').hidden, $('result-error').hidden], [false, false], 'and when Bill Status fails, beside its error');
  // a new CRN export takes its own old result away
  $('card-crn').querySelector('[data-role="download"]').click();
  await settle();
  assert.equal($('main-result').hidden, true);
  assert.ok(worker.sent.some((m) => m.type === MT.DOWNLOAD_IREPS_DOCUMENTS && m.criteria === 'CRN'));
  toPanel({ type: MT.DOCUMENT_DOWNLOAD_COMPLETE, criteria: 'CRN', recordCount: 3, pagesFetched: 1, destination: 'local', format: 'xlsx', filename: 'CRN.xlsx', incomplete: null, warnings: [], startedBy: OWN_TAB });
  assert.equal($('main-result-title').textContent, '✓ CRN export downloaded successfully');
});

test('7.1, 1.17, 1.18: a scheduled MA run never replaces the MA list or the selection shown here', async () => {
  const record = (n) => ({ id: `ma-${n}`, maNo: `00${n}`, poNo: `PO${n}`, railwayUnit: 'HQ', maDate: '18/11/2026', poDate: '01/11/2026', maPdfUrl: `${IREPS}/ma/${n}.pdf` });
  worker.states.ma = { status: 'ready', startedBy: OWN_TAB, recordCount: 2, allRecordCount: 2, records: [record(1), record(2)], filter: 'MA Date 18/11/2026', incomplete: 'IREPS reported 3 MA result(s) but 2 were read', downloads: null, error: null, running: false, busyWith: null };
  $('btn-ma-open').click();
  await settle();
  const listed = () => [...document.querySelectorAll('#ma-list li.doc-item')].map((li) => li.dataset.id);
  assert.deepEqual(listed(), ['ma-1', 'ma-2']);
  assert.equal($('ma-results-warning').hidden, false, 'a list short of IREPS\'s total says so (1.1)');
  assert.equal($('ma-results-warning').textContent, 'IREPS reported 3 MA result(s) but 2 were read; some MAs may be missing from this list.');
  document.querySelector('#ma-list li[data-id="ma-2"] input').click();
  assert.equal($('btn-ma-download-selected').textContent, 'Download Selected (1)');
  toPanel({ type: MT.MA_PROGRESS, status: 'searching', message: 'Scheduled download: searching MAs...', startedBy: SCHEDULED_RUN });
  assert.equal($('btn-ma-search').disabled, true);
  assert.equal($('btn-ma-download-selected').disabled, true);
  toPanel({ type: MT.MA_SEARCH_COMPLETE, status: 'ready', recordCount: 1, records: [record(7)], startedBy: SCHEDULED_RUN });
  toPanel({ type: MT.MA_PROGRESS, status: 'downloading', message: 'Scheduled download: 1 MA copy...', startedBy: SCHEDULED_RUN });
  toPanel({ type: MT.MA_DOWNLOAD_PROGRESS, downloads: { total: 1, completed: 0, failed: 1, skipped: 0, items: [{ id: 'ma-1', status: 'failed', error: { code: 'ECM_UNAVAILABLE' } }] }, startedBy: SCHEDULED_RUN });
  assert.deepEqual(listed(), ['ma-1', 'ma-2'], 'the list stays');
  assert.equal(document.querySelector('#ma-list li[data-id="ma-1"] .chip').hidden, true, 'no chip of the scheduled run');
  toPanel({ type: MT.MA_DOWNLOAD_COMPLETE, message: 'Scheduled download: 0 of 1 MA copies saved', startedBy: SCHEDULED_RUN });
  assert.equal($('btn-ma-download-selected').disabled, false);
  assert.equal($('btn-ma-download-selected').textContent, 'Download Selected (1)', 'the selection stays');
  assert.deepEqual(shownViews(), ['view-ma']);
  // this panel's own download where every MA was already there: "Nothing new", not "✓ 0 downloaded" (1.17)
  worker.states.ma = { ...worker.states.ma, status: 'complete', downloads: { total: 2, completed: 0, failed: 0, skipped: 2, warnings: [], items: [{ id: 'ma-1', status: 'skipped', skip: SKIP }, { id: 'ma-2', status: 'skipped', skip: SKIP }] } };
  toPanel({ type: MT.MA_DOWNLOAD_COMPLETE, startedBy: OWN_TAB });
  await settle();
  assert.equal($('ma-download-title').textContent, 'Nothing new to download');
  assert.doesNotMatch($('ma-download-text').textContent, /Every other/);
  // an MA download the session expired in: the indicator says so, never "Connected" (1.18)
  worker.states.ma = { ...worker.states.ma, downloads: { total: 2, completed: 1, failed: 1, skipped: 0, sessionExpired: true, warnings: [], items: [{ id: 'ma-1', status: 'completed' }, { id: 'ma-2', status: 'failed', error: { code: 'IREPS_SESSION_EXPIRED' } }] }, error: described('MA_SESSION_EXPIRED_DURING_DOWNLOAD') };
  toPanel({ type: MT.MA_DOWNLOAD_COMPLETE, startedBy: OWN_TAB });
  await settle();
  assert.equal($('connection-text').textContent, 'Login Required');
});

test('4.9: an old MA "login required" never locks the MA view: the live form check decides', async () => {
  $('btn-ma-back').click();
  worker.states.ma = { status: 'error', stage: 'ERROR', error: described('IREPS_SESSION_EXPIRED'), startedBy: OWN_TAB, records: [], recordCount: 0, running: false, busyWith: null, updatedAt: Date.now() - 3600000 };
  $('btn-ma-open').click();
  await settle();
  assert.deepEqual(shownViews(), ['view-ma'], 'IREPS answers the form check (logged in): the MA view opens');
  assert.equal($('btn-ma-search').disabled, false, '"Search MAs" can be reached');
  assert.equal($('connection-text').textContent, 'Connected');
});

test('7.15: MA: "Connected" only once IREPS answered the search, never at "Checking IREPS session"', async () => {
  $('connection').dataset.state = 'offline';
  $('connection-text').textContent = 'Unavailable';
  toPanel({ type: MT.MA_PROGRESS, stage: 'CHECKING_SESSION', status: 'searching', message: 'Checking IREPS session...', startedBy: OWN_TAB });
  assert.equal($('ma-progress').hidden, false);
  assert.equal($('connection-text').textContent, 'Unavailable', 'IREPS has not answered yet');
  toPanel({ type: MT.MA_PROGRESS, stage: 'SEARCHING', status: 'searching', message: 'Searching Modification Advices...', startedBy: OWN_TAB });
  assert.equal($('connection-text').textContent, 'Connected');
});

test('7.11: MA "New search" waits while a download runs; a reset the worker refuses keeps the list and says why', async () => {
  const record = (n) => ({ id: `ma-${n}`, maNo: `00${n}`, poNo: `PO${n}`, railwayUnit: 'HQ', maDate: '18/11/2026', poDate: '01/11/2026', maPdfUrl: `${IREPS}/ma/${n}.pdf` });
  const listed = () => [...document.querySelectorAll('#ma-list li.doc-item')].map((li) => li.dataset.id);
  const ready = { status: 'ready', startedBy: OWN_TAB, recordCount: 2, allRecordCount: 2, records: [record(1), record(2)], filter: 'MA Date 18/11/2026', downloads: null, error: null, running: false, busyWith: null };
  worker.states.ma = ready;
  toPanel({ type: MT.MA_SEARCH_COMPLETE, ...ready });
  assert.deepEqual(listed(), ['ma-1', 'ma-2']);
  assert.equal($('btn-ma-new-search').disabled, false);
  // this panel's download of the list starts
  toPanel({ type: MT.MA_PROGRESS, stage: 'DOWNLOADING', status: 'downloading', message: 'Downloading 2 MA copies...', startedBy: OWN_TAB });
  assert.equal($('btn-ma-new-search').disabled, true, 'New search waits for the download');
  toPanel({ type: MT.MA_DOWNLOAD_COMPLETE, startedBy: OWN_TAB });
  await settle();
  assert.equal($('btn-ma-new-search').disabled, false);
  // a New search that reaches the worker while it runs an MA job is refused: the panel keeps the list too
  worker.states.maReset = { ok: false, error: described('MA_BUSY') };
  try {
    $('btn-ma-new-search').click();
    await settle();
    assert.equal($('ma-results').hidden, false, 'the list stays');
    assert.deepEqual(listed(), ['ma-1', 'ma-2']);
    assert.deepEqual([$('ma-error').hidden, $('ma-error-title').textContent], [false, 'MA Task Already Running']);
  } finally {
    delete worker.states.maReset;
  }
  $('btn-ma-new-search').click();
  await settle();
  assert.equal($('ma-results').hidden, true, 'once the worker resets, so does the view');
});

test('7.1, 7.2: a scheduled batch never erases the finished batch shown here, nor its Retry', async () => {
  const finished = {
    kind: 'po-date', phase: 'complete', startedBy: OWN_TAB, dateFrom: '17/11/2026', dateTo: '18/11/2026', running: false, busyWith: null, warnings: [],
    counts: { found: 2, downloaded: 1, failed: 1, skipped: 0, duplicates: 0, alreadyDownloaded: 0 },
    items: [{ id: 'po-1', poNo: 'P1', status: 'completed' }, { id: 'po-2', poNo: 'P2', status: 'failed', url: `${IREPS}/p2.pdf`, error: { code: 'IREPS_PO_DOWNLOAD_FAILED', detail: 'IREPS returned HTTP 500' } }],
  };
  worker.states.batch = { 'po-date': finished };
  $('btn-ma-back').click();
  $('btn-po-ic-open').click();
  await settle();
  $('connection').dataset.state = 'offline';
  $('connection-text').textContent = 'Unavailable';
  $('btn-po-ic-batch-open').click();
  await settle();
  assert.deepEqual(shownViews(), ['view-po-ic-batch']);
  assert.equal($('connection-text').textContent, 'Unavailable', 'a batch state read when the view opens never says "Connected" (4.10)');
  const title = $('pod-result-title').textContent;
  assert.match(title, /^Partly done: 1 downloaded/);
  assert.equal($('btn-pod-retry').hidden, false);
  toPanel({ type: MT.BATCH_UPDATE, kind: 'po-date', state: { kind: 'po-date', phase: 'searching', running: true, busyWith: SCHEDULED_RUN, startedBy: SCHEDULED_RUN } });
  assert.equal($('pod-result-title').textContent, title, 'the finished batch stays');
  assert.equal($('btn-pod-retry').hidden, false, 'and its Retry');
  assert.equal($('btn-pod-download').disabled, true);
  assert.match($('background-runs').textContent, /^POs by PO date: a scheduled download is running/);
  toPanel({ type: MT.BATCH_UPDATE, kind: 'po-date', state: { kind: 'po-date', phase: 'complete', running: false, busyWith: null, startedBy: SCHEDULED_RUN } });
  assert.equal($('btn-pod-download').disabled, false);
  assert.equal($('btn-pod-retry').disabled, false);
  assert.equal($('pod-result-title').textContent, title);
  assert.equal($('background-runs').hidden, true);
});

test('7.10: a batch of this panel that is starting shows "Starting..." with its button busy, never idle', async () => {
  assert.deepEqual(shownViews(), ['view-po-ic-batch']);
  $('btn-icd-download').click();
  await settle();
  assert.ok(worker.sent.some((m) => m.type === MT.BATCH_START && m.kind === 'ic-date'));
  // the worker's first word on it: the run is on, with no state of its own yet (it reads the IREPS account first)
  const starting = { kind: 'ic-date', phase: 'idle', running: true, busyWith: OWN_TAB, startedBy: OWN_TAB };
  toPanel({ type: MT.BATCH_UPDATE, kind: 'ic-date', state: starting });
  assert.equal($('btn-icd-download').disabled, true, 'its button stays busy');
  assert.deepEqual([$('icd-progress').hidden, $('icd-progress-message').textContent], [false, 'Starting...']);
  // the same when the view opens meanwhile
  worker.states.batch = { ...worker.states.batch, 'ic-date': starting };
  $('btn-pod-back').click();
  $('btn-po-ic-batch-open').click();
  await settle();
  assert.equal($('btn-icd-download').disabled, true);
  assert.equal($('icd-progress-message').textContent, 'Starting...');
  // its first state, then its end
  const counts = { found: 0, pos: 0, downloaded: 0, failed: 0, skipped: 0, duplicates: 0, alreadyDownloaded: 0 };
  const searching = { ...starting, phase: 'searching', dateFrom: '24/11/2026', dateTo: '24/11/2026', counts, items: [], warnings: [] };
  toPanel({ type: MT.BATCH_UPDATE, kind: 'ic-date', state: searching });
  assert.equal($('icd-progress-message').textContent, 'Searching IREPS for ICs...');
  toPanel({ type: MT.BATCH_UPDATE, kind: 'ic-date', state: { ...searching, phase: 'complete', running: false, busyWith: null } });
  assert.equal($('btn-icd-download').disabled, false);
  assert.equal($('icd-result-title').textContent, 'No ICs issued in the range');
  delete worker.states.batch['ic-date'];
});

test('9.3: ICs from notifications: an IC listed twice for one notice shows once, with a "Duplicate" row for the repeat (and the older shape as before)', () => {
  const counts = { inspected: 2, icNotifications: 2, matchedRecords: 3, downloaded: 1, alreadyDownloaded: 0, duplicates: 2, failed: 0, skipped: 0, unparsed: 0, notFound: 0, searchErrors: 0, noLink: 0 };
  const item = { id: 'ic-1', callId: '6038184070', icDate: '18/11/2026', filename: 'IC_27253922100240_001_6038184070.pdf', status: 'completed', url: `${IREPS}/ic/3480517.pdf` };
  const notifications = [
    { notificationId: '77', poNo: '27253922100240', poSerial: '001', date: '18/11/2026', outcome: 'matched', itemIds: ['ic-1'], repeats: [{ itemId: 'ic-1' }] },
    // another notice for the same IC: the shape without `repeats`
    { notificationId: '78', poNo: '27253922100240', poSerial: '001', date: '18/11/2026', outcome: 'matched', itemIds: ['ic-1'], duplicateOf: ['ic-1'] },
  ];
  toPanel({ type: MT.BATCH_UPDATE, kind: 'ic-notif', state: { kind: 'ic-notif', phase: 'complete', running: false, busyWith: null, startedBy: OWN_TAB, warnings: [], counts, notifications, items: [item] } });
  const rows = [...$('icn-list').querySelectorAll('li')].map((li) => [li.querySelector('.doc-no').textContent.trim(), li.querySelector('.chip').textContent]);
  assert.deepEqual(rows, [
    ['PO 27253922100240 · Sr. 001', 'Matched'],
    ['IC Call 6038184070', 'Downloaded'],
    ['IC Call 6038184070', 'Duplicate'],
    ['PO 27253922100240 · Sr. 001', 'Matched'],
    ['IC Call 6038184070', 'Duplicate'],
  ]);
});

test('1.16-1.19: the single-PO IC result names each IC not downloaded and why, says "nothing new" when all were there, and an expired session as such', async () => {
  $('btn-pod-back').click();
  await settle();
  assert.deepEqual(shownViews(), ['view-po-ic']);
  const failedIc = { id: 'ic-2', label: 'IC 3778184071 (PO Sr. 002)', status: 'failed', error: { code: 'IREPS_IC_DOWNLOAD_FAILED', detail: 'IREPS returned HTTP 500', status: 500 } };
  const shortList = 'PO 27253922100240: IREPS reported 3 inspection calls but 2 were read; some Inspection Certificates may be missing.';
  toPanel({ type: MT.IC_DOWNLOAD_COMPLETE, startedBy: OWN_TAB, count: 2, message: '1 of 2', warnings: [shortList], error: null, downloads: { total: 2, completed: 1, failed: 1, skipped: 0, warnings: [], items: [{ id: 'ic-1', label: 'IC 1', status: 'completed' }, failedIc] } });
  const text = $('ic-result-text').textContent;
  assert.ok(text.includes('IC 3778184071 (PO Sr. 002): IC copy download failed (IREPS returned HTTP 500)'), text);
  assert.ok(text.includes(shortList), 'the search warning is shown (1.19)');
  assert.doesNotMatch(text, /Hover/, 'the IC card has no item list to hover (1.16)');
  toPanel({ type: MT.IC_DOWNLOAD_COMPLETE, startedBy: OWN_TAB, count: 2, message: '0 of 2', warnings: [], error: null, downloads: { total: 2, completed: 0, failed: 0, skipped: 2, warnings: [], items: [{ id: 'ic-1', label: 'IC 1', status: 'skipped', skip: SKIP }, { id: 'ic-2', label: 'IC 2', status: 'skipped', skip: SKIP }] } });
  assert.equal($('ic-result-title').textContent, 'Nothing new to download', 'not "✓ 0 downloaded" (1.17)');
  assert.doesNotMatch($('ic-result-text').textContent, /Every other/);
  toPanel({ type: MT.IC_DOWNLOAD_COMPLETE, startedBy: OWN_TAB, count: 2, message: '1 of 2', warnings: [], error: described('IC_SESSION_EXPIRED_DURING_DOWNLOAD'), downloads: { total: 2, completed: 1, failed: 1, skipped: 0, sessionExpired: true, warnings: [], items: [{ id: 'ic-1', label: 'IC 1', status: 'completed' }, { ...failedIc, error: { code: 'IREPS_SESSION_EXPIRED', detail: 'not attempted: IREPS session expired' } }] } });
  assert.equal($('connection-text').textContent, 'Login Required', 'never "Connected" over an expired session (1.18)');
  // another tab's IC download is only noted here
  toPanel({ type: MT.IC_PROGRESS, status: 'searching', message: 'Searching issued ICs...', startedBy: 9 });
  assert.equal($('btn-ic-download').disabled, true);
  assert.match($('background-runs').textContent, /^Inspection Certificates: a download started in another tab's DocLink panel is running/);
  toPanel({ type: MT.IC_DOWNLOAD_ERROR, ...described('IREPS_SESSION_EXPIRED'), startedBy: 9 });
  assert.equal($('btn-ic-download').disabled, false);
  assert.ok(!$('ic-result').hidden && $('ic-error').hidden, "another tab's error is not shown here");
});

test('4.10: a PO / IC state read when the view opens never sets the IREPS indicator, and an old "login required" is not shown again', async () => {
  $('btn-po-ic-back').click();
  $('connection').dataset.state = 'offline';
  $('connection-text').textContent = 'Unavailable';
  worker.states.po = { status: 'complete', startedBy: OWN_TAB, poNumber: 'P1', result: { poNumber: 'P1', filename: 'PO_P1.pdf', downloadId: null, warnings: [] }, updatedAt: Date.now() - 3600000 };
  worker.states.ic = { status: 'error', startedBy: OWN_TAB, poNumber: 'P1', error: described('IREPS_SESSION_EXPIRED'), updatedAt: Date.now() - 3600000 };
  $('btn-po-ic-open').click();
  await settle();
  assert.equal($('connection-text').textContent, 'Unavailable', 'an hour-old success does not say "Connected"');
  assert.equal($('po-result').hidden, false);
  assert.equal($('ic-error').hidden, true, 'an old "login required" is not shown again');
});

test('7.15: PO / IC: a click on Download, or "Checking IREPS session", never says "Connected"; IREPS\'s answer does', async () => {
  worker.states.po = null;
  worker.states.ic = null;
  $('po-ic-number').value = '27253922100240';
  const unavailable = () => {
    $('connection').dataset.state = 'offline';
    $('connection-text').textContent = 'Unavailable';
  };
  unavailable();
  $('btn-po-download').click();
  await settle();
  assert.equal($('po-progress').hidden, false);
  assert.equal($('connection-text').textContent, 'Unavailable', 'the run has not reached IREPS yet');
  toPanel({ type: MT.PO_PROGRESS, poNumber: '27253922100240', stage: 'CHECKING_SESSION', message: 'Checking IREPS session...', startedBy: OWN_TAB });
  assert.equal($('connection-text').textContent, 'Unavailable');
  toPanel({ type: MT.PO_PROGRESS, poNumber: '27253922100240', stage: 'SEARCHING', message: 'Searching PO...', startedBy: OWN_TAB });
  assert.equal($('connection-text').textContent, 'Connected', 'IREPS answered the session check');
  unavailable();
  $('btn-ic-download').click();
  await settle();
  assert.equal($('connection-text').textContent, 'Unavailable');
  toPanel({ type: MT.IC_PROGRESS, poNumber: '27253922100240', stage: 'CHECKING_SESSION', status: 'searching', message: 'Checking IREPS session...', startedBy: OWN_TAB });
  assert.equal($('connection-text').textContent, 'Unavailable');
  toPanel({ type: MT.IC_PROGRESS, poNumber: '27253922100240', stage: 'CONNECTED', status: 'searching', message: 'Loading IREPS Inspection Call List...', startedBy: OWN_TAB });
  assert.equal($('connection-text').textContent, 'Connected');
  toPanel({ type: MT.PO_DOWNLOAD_ERROR, poNumber: '27253922100240', ...described('IREPS_PO_NOT_FOUND', { detail: '27253922100240' }), startedBy: OWN_TAB });
});

test("7.3: the IC result's \"Retry failed downloads\" retries that IC run (its own PO), whatever the box holds now", async () => {
  const items = [{ id: 'ic-1', label: 'IC 1', status: 'completed' }, { id: 'ic-2', label: 'IC 2 (PO Sr. 002)', status: 'failed', error: { code: 'IREPS_IC_DOWNLOAD_FAILED', detail: 'IREPS returned HTTP 503', status: 503 } }];
  toPanel({ type: MT.IC_DOWNLOAD_COMPLETE, startedBy: OWN_TAB, poNumber: '27253922100240', count: 2, message: '1 of 2', warnings: [], error: null, downloads: { total: 2, completed: 1, failed: 1, skipped: 0, warnings: [], items } });
  assert.match($('ic-result-text').textContent, /^Not downloaded from PO 27253922100240 \(Retry fetches them again\):\nIC 2 \(PO Sr\. 002\): IC copy download failed/, 'the result names its PO');
  assert.equal($('btn-ic-retry').hidden, false);
  // the box now holds another PO (typed since, or restored from the PO download)
  $('po-ic-number').value = '99999999999999';
  const from = worker.sent.length;
  $('btn-ic-retry').click();
  await settle();
  const sent = worker.sent.slice(from).filter((m) => m.type === MT.IC_RETRY || m.type === MT.IC_DOWNLOAD);
  assert.deepEqual(sent.map((m) => m.type), [MT.IC_RETRY], 'a retry of that run, not a new IC download');
  assert.equal(sent[0].poNo, undefined, 'the box\'s PO is not sent: the worker retries the run it holds');
  assert.equal(sent[0].panelTabId, OWN_TAB);
  assert.match($('ic-progress-message').textContent, /^Retrying the failed downloads of PO 27253922100240/);
  toPanel({ type: MT.IC_DOWNLOAD_ERROR, poNumber: '27253922100240', ...described('IREPS_SESSION_EXPIRED'), startedBy: OWN_TAB });
});

test('5.1: a print tab is told to the worker as DocLink\'s own before its IREPS page loads', async () => {
  const { fakeChromeDebugger } = await import('../../tender/tests/fake-ireps.js');
  const before = { tabs: chrome.tabs, debugger: chrome.debugger, sendMessage: chrome.runtime.sendMessage };
  const dbg = fakeChromeDebugger(chrome);
  chrome.runtime.sendMessage = async (m) => {
    dbg.calls.push(['sendMessage', m]);
    return { ok: true };
  };
  try {
    const { printPageToPdf } = await import('../../tender/tender-print.js');
    const pdf = await printPageToPdf({ url: 'https://www.ireps.gov.in/epsn/supply/tds/publishLOALetter.do', bytes: new TextEncoder().encode('<html><body>LOA</body></html>'), contentType: 'text/html' });
    assert.ok(pdf.length > 0);
    const noted = dbg.calls.findIndex((c) => c[0] === 'sendMessage' && c[1].type === MT.NOTE_OWN_TAB && c[1].tabId === 7 && c[1].target === 'service-worker');
    const navigated = dbg.calls.findIndex((c) => c[0] === 'Page.navigate');
    assert.ok(noted >= 0 && noted < navigated, dbg.calls.map((c) => c[0]).join(', '));
  } finally {
    Object.assign(chrome, { tabs: before.tabs, debugger: before.debugger });
    chrome.runtime.sendMessage = before.sendMessage;
  }
});

// ------------------------------------------------ the worker (background/service-worker.js) on a fake chrome, IREPS and Recon
// Engine: a scheduled run is kept apart from the panel's run (7.1, 7.2), what it could not read is named (1.2), and a manual
// PO download that ends wakes a scheduled slot that waited for it (5.9)
const { accountFromHomeDocument } = await import('../../utils/ireps-account.js');
const { parseIcSearchResults } = await import('../../services/inspection-certificate/ic-parser.js');
const { parseMaSearchResults } = await import('../../services/ma/ma-parser.js');
const { parsePoSearchResults } = await import('../../services/po/po-parser.js');
const fixture = (name) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');
const HOME_833 = '<html><head><title>Bidder Home Page</title></head><body><table><tr><td class="welcomeLabel">A GIRIJA , FAIVELEY TRANSPORT RAIL TECHNOLOGIES INDIA PRIVATE LIMITED-HOSUR (IREPS ID- 833)</td></tr></table><a href="/epsn/home/logout.do">Log Out</a></body></html>';
const WORKER_CONFIG = {
  target: 'mock', mockBaseUrl: IREPS, reconBaseUrl: RECON, reconCustomerId: 'default', downloadLog: { enabled: false },
  schedular_phase1: { enabled: true, documents: ['BillStatus', 'IC'] }, schedular_phase2: { enabled: false, documents: [] },
  ecmBackendAws: false, ecm: { env: 'TEST', domain: 'http://ecm.test', clientId: 'x', clientSecret: 'y' },
};
/**
 * What the worker did: its broadcasts, the slots it finished, how often it asked who is signed in, how many IC
 * searches it posted. A test may answer an IC search (`icSearch`), a PDF link (`pdf`) and the download log's
 * "already downloaded?" check (`downloadsCheck`, keys -> answer).
 */
const sw = { listener: null, alarm: null, broadcasts: [], finish: [], whoAmI: 0, due: [], notifications: [], poSearch: null, icSearch: null, icSearches: 0, pdf: null, downloadsCheck: null };
const answer = (status, body, type = 'application/json') => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': type } });
const page = (html, status = 200) => answer(status, html, 'text/html; charset=utf-8');
async function workerFetch(url, init = {}) {
  const u = new URL(String(url));
  const body = init.body ? String(init.body) : '';
  if (u.origin === RECON) {
    if (u.pathname === '/__ext__/config.json') return answer(200, WORKER_CONFIG);
    if (u.pathname === '/api/auth/me') return (sw.whoAmI++, answer(200, { id: 7, email: 'a@b.test', name: 'A', roles: ['tendering'], permissions: ['doclink.schedule.run'] }));
    if (u.pathname === '/api/doclink/schedule/due') return answer(200, sw.due.shift() || { due: [], running: null, next_check_at: null, slots: [] });
    if (u.pathname === '/api/doclink/schedule/claim') return answer(200, { slot: { id: JSON.parse(body).slot_id }, params: {} });
    if (u.pathname === '/api/doclink/schedule/finish') return (sw.finish.push(JSON.parse(body)), answer(200, { slot: {} }));
    if (u.pathname === '/api/doclink/documents/reserve') return answer(200, { granted: JSON.parse(body).keys, taken: {} });
    if (u.pathname === '/api/doclink/downloads/check' && sw.downloadsCheck) return answer(200, sw.downloadsCheck(JSON.parse(body).keys));
    if (u.pathname.startsWith('/api/doclink/')) return answer(200, {});
    return answer(404, {});
  }
  if (u.origin === IREPS) {
    if (u.pathname === '/epsn/home/showHome.do') return page(HOME_833);
    if (u.pathname === '/epsn/vndr/activity/ajax.do') return answer(200, { nl: sw.notifications });
    // the Inspection Call List opens; every IC search on it fails (HTTP 404), unless a test answers it
    if (u.pathname === '/epsn/tpi/vendorInspectionCallList.do') {
      if (!body.includes('TOKEN')) return page(fixture('ic-list-page.html'));
      sw.icSearches++;
      return sw.icSearch ? sw.icSearch(body) : page('<html><body>Not Found</body></html>', 404);
    }
    if (u.pathname === '/epsn/searchPO.do' && sw.poSearch) return sw.poSearch(body);
    if (u.pathname.endsWith('.pdf') && sw.pdf) return sw.pdf(u.pathname);
  }
  return page('<html><body>Not Found</body></html>', 404);
}
const SEARCH_PO_PARSERS = { PO: parsePoSearchResults, MA: parseMaSearchResults };
/** The offscreen document (its parsers) and the panels (the broadcasts) as the worker reaches them. */
async function workerSends(m) {
  if (m.target === 'offscreen') {
    const parser = new dom.window.DOMParser();
    if (m.type === MT.PARSE_IREPS_ACCOUNT) return { ok: true, result: accountFromHomeDocument(parser.parseFromString(m.html, 'text/html'), m.html) };
    if (m.type === MT.PARSE_IC_RESULTS) return { ok: true, result: parseIcSearchResults(m.html, m.poNo || null, { DOMParser: dom.window.DOMParser, sourceUrl: m.sourceUrl }) };
    if (m.type === MT.PARSE_SEARCH_PO_RESULTS) return { ok: true, result: SEARCH_PO_PARSERS[m.criteria](m.html, { DOMParser: dom.window.DOMParser, sourceUrl: m.sourceUrl, startIndex: m.startIndex }) };
    return { ok: false, error: `no parser for ${m.type}` };
  }
  if (m.target === 'popup') sw.broadcasts.push(m);
  return undefined;
}
/** A message to the worker, as a panel sends it; resolves with its answer. */
const ask = (message) => new Promise((resolve) => {
  if (sw.listener({ target: 'service-worker', ...message }, {}, resolve) !== true) resolve(undefined);
});
const until = async (check, rounds = 200) => {
  for (let i = 0; i < rounds && !(await check()); i++) await new Promise((r) => setTimeout(r, 5));
};

test('Worker: background/service-worker.js loads on a fake chrome and answers the panel', async () => {
  const listen = () => ({ addListener() {} });
  globalThis.chrome = {
    runtime: {
      getURL: (p) => `${RECON}/__ext__/${p}`,
      getManifest: () => ({ version: '1.7.1', host_permissions: [`${RECON}/*`, `${IREPS}/*`], side_panel: { default_path: 'popup/popup.html' } }),
      onMessage: { addListener: (fn) => messageListeners.push(fn) },
      onInstalled: { addListener: (fn) => (sw.installed = fn) }, onStartup: listen(),
      getContexts: async () => [{}],
      getPlatformInfo: async () => ({}),
      sendMessage: (m) => workerSends(m),
    },
    storage: { local: memoryArea(), session: memoryArea(), onChanged: listen() },
    tabs: { query: async () => [], create: async () => ({ id: 77 }), update: async () => ({}), remove: async () => {}, get: async (id) => ({ id }), onCreated: listen(), onReplaced: listen(), onRemoved: { addListener: (fn) => (sw.tabRemoved = fn) }, onUpdated: { addListener: (fn) => (sw.tabUpdated = fn) }, onActivated: listen() },
    sidePanel: { setPanelBehavior: async () => {}, setOptions: async () => {} },
    alarms: { create: async () => {}, clear: async () => {}, onAlarm: { addListener: (fn) => (sw.alarm = fn) } },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    offscreen: { createDocument: async () => {}, closeDocument: async () => {} },
  };
  globalThis.fetch = workerFetch;
  globalThis.DOMParser = dom.window.DOMParser;
  // the worker's long timers (the offscreen document's idle close, the keep-alive ping) must not hold this test process open
  for (const name of ['setTimeout', 'setInterval']) {
    const real = globalThis[name];
    globalThis[name] = (fn, ms, ...args) => {
      const timer = real(fn, ms, ...args);
      if (ms >= 5000 && timer && typeof timer.unref === 'function') timer.unref();
      return timer;
    };
  }
  const listeners = messageListeners.length;
  await import('../../background/service-worker.js');
  assert.equal(messageListeners.length, listeners + 1, 'the worker listens once');
  sw.listener = messageListeners[listeners];
  assert.equal((await ask({ type: MT.GET_JOB_STATE })).status, 'idle');
});

test('7.2 (worker): a batch is retried only from the panel that started it', async () => {
  sw.notifications = [];
  assert.equal((await ask({ type: MT.BATCH_START, kind: 'ic-notif', destination: 'local', panelTabId: OWN_TAB })).started, true);
  await until(async () => (await ask({ type: MT.BATCH_GET_STATE, kind: 'ic-notif' })).phase === 'complete');
  const state = await ask({ type: MT.BATCH_GET_STATE, kind: 'ic-notif' });
  assert.equal(state.startedBy, OWN_TAB);
  const elsewhere = await ask({ type: MT.BATCH_RETRY, kind: 'ic-notif', destination: 'local', panelTabId: 9 });
  assert.deepEqual([elsewhere.started, elsewhere.error.code], [false, 'BATCH_RETRY_ELSEWHERE']);
  assert.equal((await ask({ type: MT.BATCH_RETRY, kind: 'ic-notif', destination: 'local', panelTabId: OWN_TAB })).started, true);
  await until(async () => !(await ask({ type: MT.BATCH_GET_STATE, kind: 'ic-notif' })).running);
  const updates = sw.broadcasts.filter((b) => b.type === MT.BATCH_UPDATE);
  assert.ok(updates.length > 0 && updates.every((b) => b.state.startedBy === OWN_TAB), 'every update says which panel started the batch');
});

test("7.1, 1.2 (worker): a scheduled IC run keeps its state apart from the panel's batch, and ends failed, naming the notification, when its IC search failed", async () => {
  const panelBefore = await ask({ type: MT.BATCH_GET_STATE, kind: 'ic-notif' });
  sw.notifications = [{ MESSAGE: 'IC issued for PONo : 27253922100240 , POSrNo : 001', NOTIFICATION_ID: '77', NOTIFICATION_DT: '2026-11-18 10:24:49.0', MODULE_WA: 'PT', SUBJECT: 'Inspection', NOTIFICATION_STATUS: '0', DATED: '18/11/2026', REF_ID: '6038184070' }];
  await chrome.storage.local.set({ 'doclink.scheduler.account': { id: '833', at: Date.now() } });
  await chrome.storage.session.set({ 'doclink.scheduler.signals': { irepsActivityAt: Date.now() } });
  sw.due.push({ due: [{ id: 31, doc_type: 'icNotifications', slot_date: '2026-11-18', period: '10:00', status: 'pending' }], running: null, next_check_at: null, slots: [] });
  const from = sw.broadcasts.length;
  sw.alarm({ name: 'doclink.scheduler' });
  await until(() => sw.finish.length === 1, 600);
  const [finish] = sw.finish;
  assert.equal(finish.outcome, 'failed', 'no IC was read: never "done, nothing new in IREPS" (1.2)');
  assert.equal(finish.code, 'IREPS_IC_SEARCH_FAILED');
  assert.deepEqual(finish.result.failures, [{ doc: 'Notification 77 (PO 27253922100240 Sr. 001)', code: 'IREPS_IC_SEARCH_FAILED', detail: 'IREPS returned HTTP 404' }]);
  const panelAfter = await ask({ type: MT.BATCH_GET_STATE, kind: 'ic-notif' });
  assert.deepEqual([panelAfter.startedBy, panelAfter.phase, panelAfter.finishedAt, panelAfter.notifications.length], [OWN_TAB, 'complete', panelBefore.finishedAt, 0], "the panel's finished batch is kept (7.1)");
  const during = sw.broadcasts.slice(from).filter((b) => b.type === MT.BATCH_UPDATE);
  assert.ok(during.length >= 2 && during.every((b) => b.state.startedBy === SCHEDULED_RUN && !b.state.notifications), 'the panels only hear that a scheduled batch runs');
  const retry = await ask({ type: MT.BATCH_RETRY, kind: 'ic-notif', destination: 'local', panelTabId: OWN_TAB });
  assert.equal(retry.started, true, "the panel's Retry repeats its own batch");
  await until(async () => !(await ask({ type: MT.BATCH_GET_STATE, kind: 'ic-notif' })).running);
  assert.equal((await ask({ type: MT.BATCH_GET_STATE, kind: 'ic-notif' })).notifications.length, 0, "never the scheduled run's failures (7.2)");
});

test('5.9 (worker): a scheduled slot that waited for a manual PO download runs when that download ends', async () => {
  let release;
  const held = new Promise((r) => (release = r));
  sw.poSearch = async () => {
    await held;
    return page('<html><body>Server is busy</body></html>');
  };
  sw.due.push({ due: [{ id: 41, doc_type: 'billStatus', slot_date: '2026-11-18', period: 'day', status: 'pending' }], running: null, next_check_at: null, slots: [] });
  assert.equal((await ask({ type: MT.PO_DOWNLOAD, poNo: '27253922100240', destination: 'local', panelTabId: OWN_TAB })).started, true);
  const asked = sw.whoAmI;
  sw.alarm({ name: 'doclink.scheduler' });
  await until(() => sw.due.length === 0);
  await until(async () => (await ask({ type: MT.GET_PO_STATE })).status === 'running');
  await settle();
  const waited = sw.whoAmI;
  assert.ok(waited > asked, 'the alarm asked what is due, and the slot waits for the PO download');
  release();
  await until(() => sw.whoAmI > waited, 600);
  assert.ok(sw.whoAmI > waited, 'the PO download ending woke the scheduler');
  assert.equal((await ask({ type: MT.GET_PO_STATE })).status, 'error');
});

test('5.1 (worker): an IREPS page loading in a print tab DocLink noted is not the user being active on IREPS; the user\'s own tab is', async () => {
  const signals = async () => ((await chrome.storage.session.get('doclink.scheduler.signals'))['doclink.scheduler.signals'] || {});
  await chrome.storage.session.set({ 'doclink.scheduler.signals': { irepsActivityAt: 0 } });
  assert.deepEqual(await ask({ type: MT.NOTE_OWN_TAB, tabId: 41 }), { ok: true });
  const loaded = (tab) => sw.tabUpdated(tab.id, { status: 'complete' }, { url: `${IREPS}/epsn/supply/tds/publishLOALetter.do`, ...tab });
  loaded({ id: 41 });
  loaded({ id: 42, openerTabId: 41 });
  await settle();
  assert.equal((await signals()).irepsActivityAt, 0, 'the print tab and its popup are DocLink\'s own work');
  loaded({ id: 7 });
  await until(async () => (await signals()).irepsActivityAt > 0);
  assert.ok((await signals()).irepsActivityAt > 0, 'the user\'s own IREPS tab still counts');
  sw.tabRemoved(41);
});

test('7.1 (worker): an MA list searched in another tab is never downloaded from here by position', async () => {
  sw.poSearch = async (body) => page(body.includes('searchParam=showPage') ? fixture('crn-search-page.html') : fixture('ma-results-page.html'));
  assert.equal((await ask({ type: MT.MA_SEARCH, options: { dateMode: 'all' }, panelTabId: 9 })).started, true);
  await until(async () => (await ask({ type: MT.GET_MA_STATE })).status === 'ready');
  const ma = await ask({ type: MT.GET_MA_STATE });
  assert.ok(ma.records.length > 0, 'the other tab found MAs');
  assert.equal(ma.startedBy, 9);
  assert.equal(sw.broadcasts.filter((b) => b.type === MT.MA_SEARCH_COMPLETE).at(-1).startedBy, 9);
  const refused = await ask({ type: MT.MA_DOWNLOAD, ids: [ma.records[0].id], destination: 'local', panelTabId: OWN_TAB });
  assert.deepEqual([refused.started, refused.error.code], [false, 'MA_LIST_REPLACED']);
});

/** A fresh copy of the worker, as Chrome starts it again after stopping it; resolves with a way to ask it. */
async function restartedWorker(name) {
  const listeners = messageListeners.length;
  await import(`../../background/service-worker.js?${name}`);
  assert.equal(messageListeners.length, listeners + 1, 'the new worker listens once');
  const listener = messageListeners[listeners];
  return (message) => new Promise((resolve) => {
    if (listener({ target: 'service-worker', ...message }, {}, resolve) !== true) resolve(undefined);
  });
}

test("7.16 (worker): an MA download or search cut off by a worker restart shows as interrupted, never as the run before it", async () => {
  const records = [{ id: 'ma-1', maNo: '001' }, { id: 'ma-2', maNo: '002' }];
  const before = { total: 2, completed: 2, failed: 0, skipped: 0, queued: 0, downloading: 0, sessionExpired: false, warnings: [], items: [] };
  await chrome.storage.session.set({ 'doclink.maState': { status: 'downloading', stage: 'DOWNLOADING', message: 'Downloading 2 MA copies...', startedBy: OWN_TAB, recordCount: 2, records, downloads: before, error: null, updatedAt: Date.now() } });
  const askNew = await restartedWorker('restart-ma-download');
  const ma = await askNew({ type: MT.GET_MA_STATE });
  assert.deepEqual([ma.status, ma.error && ma.error.code, ma.downloads, ma.records.length, ma.startedBy], ['ready', 'JOB_INTERRUPTED', null, 2, OWN_TAB], 'interrupted, with its list to download from again, and no summary of the run before it');
  assert.match(ma.error.message, /while this run was in progress \(Downloading 2 MA copies\.\.\.\)/);
  await chrome.storage.session.set({ 'doclink.maState': { status: 'searching', stage: 'SEARCHING', message: 'Searching Modification Advices...', startedBy: OWN_TAB, records: [], updatedAt: Date.now() } });
  const askAgain = await restartedWorker('restart-ma-search');
  const search = await askAgain({ type: MT.GET_MA_STATE });
  assert.deepEqual([search.status, search.error && search.error.code, search.records.length], ['error', 'JOB_INTERRUPTED', 0], 'a search cut off says so too (it used to say "Something Went Wrong")');
});

test('4.8 (worker): while a search holds the IREPS form lock, the PO Search form check never answers an old "login required"', async () => {
  sw.poSearch = async () => page(fixture('login-page.html'));
  const loggedOut = await ask({ type: MT.SEARCH_PO_LOAD_FORM, force: true });
  assert.deepEqual([loggedOut.authenticated, loggedOut.code], [false, 'IREPS_SESSION_EXPIRED'], 'IREPS answered with its login page');
  // the user logs in again and downloads a PO: its search holds the lock while IREPS answers
  let release;
  let searching = false;
  const held = new Promise((r) => (release = r));
  sw.poSearch = async () => {
    searching = true;
    await held;
    return page('<html><body>Server is busy</body></html>');
  };
  assert.equal((await ask({ type: MT.PO_DOWNLOAD, poNo: '27253922100240', destination: 'local', panelTabId: OWN_TAB })).started, true);
  await until(() => searching);
  const forced = await ask({ type: MT.SEARCH_PO_LOAD_FORM, force: true });
  assert.deepEqual([forced.authenticated, forced.busy], [true, true], 'Refresh: the running search shows the session is alive');
  const cached = await ask({ type: MT.SEARCH_PO_LOAD_FORM, force: false });
  assert.deepEqual([cached.authenticated, cached.busy], [true, true], 'nor the 20-second cache: a cached failure is not answered while busy');
  release();
  await until(async () => (await ask({ type: MT.GET_PO_STATE })).status !== 'running');
  sw.poSearch = null;
});

test('7.4 (worker): the "download again?" question carries the time the run stops waiting for its answer', async () => {
  sw.poSearch = async (body) => page(body.includes('searchParam=showPage') ? fixture('crn-search-page.html') : fixture('po-results-page.html'));
  // the download log knows the PO: this user downloaded it before
  sw.downloadsCheck = (keys) => ({ downloaded: Object.fromEntries(keys.map((k) => [k, { count: 1, filename: 'PO_old.pdf', downloaded_at: '2026-11-20T04:30:00Z', date: '2026-11-20', time: '10:00:00' }])) });
  const from = sw.broadcasts.length;
  const asked = Date.now();
  try {
    assert.equal((await ask({ type: MT.PO_DOWNLOAD, poNo: '27253922100240', destination: 'local', panelTabId: OWN_TAB })).started, true);
    await until(() => sw.broadcasts.slice(from).some((b) => b.type === MT.CONFIRM_REDOWNLOAD));
    const question = sw.broadcasts.slice(from).find((b) => b.type === MT.CONFIRM_REDOWNLOAD);
    assert.equal(question.panelTabId, OWN_TAB);
    assert.ok(question.deadline >= asked + 4 * 60 * 1000 && question.deadline <= Date.now() + 4 * 60 * 1000, `deadline ${question.deadline - asked} ms after the ask`);
    await until(async () => (await ask({ type: MT.GET_PO_STATE })).status !== 'running');
    const po = await ask({ type: MT.GET_PO_STATE });
    assert.equal(po.result && po.result.skipped, true, 'no answer (no panel here): the PO is not downloaded again');
  } finally {
    sw.poSearch = null;
    sw.downloadsCheck = null;
  }
});

/** chrome.downloads as Chrome answers a save: each download completes at once, under the name asked for. */
function fakeDownloads() {
  let nextId = 100;
  const names = new Map();
  const listeners = new Set();
  return {
    download: async ({ filename }) => {
      const id = nextId++;
      names.set(id, filename);
      setTimeout(() => listeners.forEach((fn) => fn({ id, state: { current: 'complete' } })), 0);
      return id;
    },
    search: async ({ id }) => [{ id, state: 'complete', filename: `C:\\Downloads\\${names.get(id)}` }],
    onChanged: { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) },
  };
}

test('7.3 (worker): an IC Retry fetches only the failed ICs of the run, for its own PO, without a new search, and only from its panel', async () => {
  const fetched = [];
  const failing = new Set(['2975517', '6691517']);
  sw.icSearch = () => page(fixture('ic-results-page.html'));
  sw.pdf = (path) => {
    const n = /(\d+)\.pdf$/.exec(path)[1];
    fetched.push(n);
    return failing.has(n) ? page('<html><body>Busy</body></html>', 503) : answer(200, '%PDF-1.4\n% IC\n', 'application/pdf');
  };
  chrome.downloads = fakeDownloads();
  const icDone = async () => (await ask({ type: MT.GET_IC_STATE })).status === 'complete';
  // the session storage refuses the IC state with its retry items (its quota): the state is kept without them
  const set = chrome.storage.session.set;
  chrome.storage.session.set = async (items) => {
    const ic = items['doclink.icState'];
    if (ic && ic.retryItems && ic.retryItems.length) throw new Error('Session storage quota bytes exceeded');
    return set(items);
  };
  try {
    assert.equal((await ask({ type: MT.IC_DOWNLOAD, poNo: '27253922100240', destination: 'local', panelTabId: OWN_TAB })).started, true);
    await until(icDone, 600);
    const first = await ask({ type: MT.GET_IC_STATE });
    assert.deepEqual([first.count, first.downloads.completed, first.downloads.failed], [4, 2, 2]);
    assert.equal('retryItems' in first, false, "the IC links stay in the worker: the panel gets each IC's outcome only");
    const stored = (await chrome.storage.session.get('doclink.icState'))['doclink.icState'];
    assert.deepEqual([stored.status, stored.downloads.failed, stored.retryItems], ['complete', 2, []], 'a state too big is kept without its items');
    chrome.storage.session.set = set;
    const searches = sw.icSearches;
    failing.clear();
    fetched.length = 0;
    const elsewhere = await ask({ type: MT.IC_RETRY, destination: 'local', panelTabId: 9 });
    assert.deepEqual([elsewhere.started, elsewhere.error.code], [false, 'BATCH_RETRY_ELSEWHERE'], "another tab's panel cannot retry it");
    assert.equal((await ask({ type: MT.IC_RETRY, destination: 'local', panelTabId: OWN_TAB })).started, true);
    await until(icDone, 600);
    const after = await ask({ type: MT.GET_IC_STATE });
    assert.deepEqual(fetched.sort(), ['2975517', '6691517'], 'only the two failed ICs are fetched again');
    assert.equal(sw.icSearches, searches, 'with no new IC search');
    assert.deepEqual([after.poNumber, after.count, after.downloads.total, after.downloads.completed, after.downloads.failed], ['27253922100240', 4, 4, 4, 0]);
    const done = sw.broadcasts.filter((b) => b.type === MT.IC_DOWNLOAD_COMPLETE).at(-1);
    assert.deepEqual([done.poNumber, done.startedBy, done.downloads.completed], ['27253922100240', OWN_TAB, 4]);
  } finally {
    chrome.storage.session.set = set;
    sw.icSearch = null;
    sw.pdf = null;
    delete chrome.downloads;
  }
});

test('Worker: a build loaded (installed, updated or reloaded) keeps the run log of this Recon server and drops the rest; Chrome updating itself changes nothing; queued download-log records stay', async () => {
  const RUN_LOG = 'doclink.scheduler.runLog';
  const QUEUE = 'doclink.downloadLog.queue.sw';
  const stored = async (key) => (await chrome.storage.local.get(key))[key];
  const here = new URL(RECON).origin;
  const other = 'https://recon-test.example';
  const at = '2026-11-27T04:00:00Z';
  // a run and an event of this Recon server, of another one, and of a build that did not record its server
  const lastBuild = () => chrome.storage.local.set({
    [RUN_LOG]: {
      runs: [
        { id: 'this-run', docType: 'ma', outcome: 'done', day: '2026-11-27', startedAt: at, recon: here },
        { id: 'other-run', docType: 'ma', outcome: 'done', day: '2026-11-27', startedAt: at, recon: other },
        { id: 'old-run', docType: 'billStatus', outcome: 'done', day: '2026-11-27', startedAt: at },
      ],
      events: [
        { first: at, at, day: '2026-11-27', recon: here, kind: 'other', text: 'this server' },
        { first: at, at, day: '2026-11-27', recon: other, kind: 'other', text: 'other server' },
        { first: at, at, kind: 'other', text: 'last build' },
      ],
    },
    [QUEUE]: [{ qid: 'q1', doc_type: 'po', key: 'po:1' }],
  });
  const kept = async () => {
    const log = (await stored(RUN_LOG)) || { runs: [], events: [] };
    return [...log.runs.map((r) => r.id), ...log.events.map((e) => e.text)].join();
  };
  await lastBuild();
  sw.installed({ reason: 'chrome_update', previousVersion: '1.7.0' });
  await settle();
  assert.equal(await kept(), 'this-run,other-run,old-run,this server,other server,last build', 'Chrome updating itself keeps the log as it is');
  for (const reason of ['update', 'install']) {
    await lastBuild();
    sw.installed({ reason, previousVersion: '1.7.0' });
    await until(async () => (await kept()) === 'this-run,this server');
    assert.equal(await kept(), 'this-run,this server', `${reason}: this Recon server's runs and events stay (3 days of history); another server's, and a build's that did not record its server, go`);
    assert.equal((await stored(QUEUE)).length, 1, `${reason}: a queued download-log record is data, not a log, and stays`);
  }
});

test('No em or en dash anywhere in DocLink: what the panel shows, the code, the tests and the docs use the plain "-"', () => {
  // the code that turns a dash in IREPS data into "-" writes it as an escape (\u2013, \u2014); captured IREPS
  // pages (fixtures) and the mock portal's third-party scripts stay as they are
  const root = new URL('../../', import.meta.url);
  const files = ['CLAUDE.md', 'README.md', 'TESTING.md', 'upload.md', 'schedular_implementation_plan.md', 'config.json', 'manifest.json', 'package.json', 'eslint.config.js'];
  const walk = (dir) => {
    for (const e of readdirSync(new URL(`${dir}/`, root), { withFileTypes: true })) {
      const path = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name !== 'fixtures' && path !== 'test/mock/static') walk(path);
      } else if (/\.(m?js|html|css|json|md)$/.test(e.name)) files.push(path);
    }
  };
  ['assets', 'background', 'pages', 'popup', 'scripts', 'services', 'tender', 'test', 'utils'].forEach(walk);
  const found = files.flatMap((f) => readFileSync(new URL(f, root), 'utf8').split('\n').flatMap((l, i) => (/[\u2013\u2014]/.test(l) ? [`${f}:${i + 1}`] : [])));
  assert.ok(files.length > 100, 'every DocLink file is looked at');
  assert.deepEqual(found, [], 'these lines have an em or en dash');
});

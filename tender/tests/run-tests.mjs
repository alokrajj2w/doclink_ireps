// Run:  JSDOM_ROOT=/path/to/dir-containing-node_modules node --test tender/tests/run-tests.mjs
// (jsdom is only a test-time stand-in for the browser's DOMParser; it is not shipped in the extension.)
import { createRequire } from 'node:module';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { FakeIreps, PDF, corresPage, fakeChromeDebugger, LOA_SCRIPT, resultsPage, resultRow, searchFormPage } from './fake-ireps.js';

const req = createRequire((process.env.JSDOM_ROOT || process.cwd()) + '/');
const { JSDOM } = req('jsdom');
globalThis.DOMParser = new JSDOM('').window.DOMParser;

// ---- fake chrome + fetch -------------------------------------------------------------------
let server;
const saved = [];
const listeners = new Set();
globalThis.chrome = {
  runtime: { getURL: (p) => `https://ext.invalid/${p}` },
  downloads: {
    onChanged: { addListener: (f) => listeners.add(f), removeListener: (f) => listeners.delete(f) },
    download: async ({ url, filename }) => {
      const blob = await (await fetch0(url)).arrayBuffer().catch(() => null);
      const id = saved.length + 1;
      saved.push({ id, filename, size: blob?.byteLength ?? 0, blobUrl: url });
      return id;
    },
    search: async ({ id }) => [{ id, state: 'complete' }],
  },
};
const fetch0 = globalThis.fetch;
const blobs = new Map();
const origCreate = URL.createObjectURL.bind(URL);
URL.createObjectURL = (b) => { const u = origCreate(b); blobs.set(u, b); return u; };
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith('blob:')) return fetch0(u);
  const r = await server.handle(init.method || 'GET', u.replace('https://ext.invalid/', 'https://www.ireps.gov.in/'), init.body);
  return new Response(r.bytes, { status: r.status, headers: { 'content-type': r.type, ...(r.disposition ? { 'content-disposition': r.disposition } : {}) } });
};
// downloads.download must read the blob we created. Like Chrome, a name already on disk is uniquified
// ("name (1).pdf", conflictAction 'uniquify') and the DownloadItem's filename is the full path written.
const disk = new Set();
const DOWNLOADS_DIR = 'C:\\Users\\tester\\Downloads\\';
chrome.downloads.download = async ({ url, filename, conflictAction }) => {
  const b = blobs.get(url);
  const buf = new Uint8Array(await b.arrayBuffer());
  let final = filename;
  if (conflictAction !== 'overwrite') for (let n = 1; disk.has(final.toLowerCase()); n++) final = filename.replace(/(\.[^./]+)?$/, ` (${n})$1`);
  disk.add(final.toLowerCase());
  const id = saved.length + 1;
  saved.push({ id, filename, final, size: buf.length, bytes: buf });
  return id;
};
chrome.downloads.search = async ({ id }) => {
  const s = saved.find((x) => x.id === id);
  return [{ id, state: 'complete', ...(s ? { filename: DOWNLOADS_DIR + s.final.replace(/\//g, '\\') } : {}) }];
};

const core = await import('../tender-core.js');
const acct = await import('../tender-account.js');
const search = await import('../tender-search.js');
const wf = await import('../tender-workflows.js');
const jobs = await import('../tender-jobs.js');
const auto = await import('../tender-auto.js');
const msgs = await import('../tender-messages.js');
const dlog = await import('../../services/download-log.js');
// the download log needs a Recon Engine: off here, on only in the "Download log" tests at the end
dlog.applyDownloadLogConfig({ downloadLog: { enabled: false } });
dlog.configureDownloadLog({ flushDelayMs: 0 });
const store = {};
globalThis.chrome.storage = { local: { get: async (k) => ({ [k]: store[k] }), set: async (o) => Object.assign(store, JSON.parse(JSON.stringify(o))) } };

const T = (o) => ({ no: '29263265', nitId: '5569207', oid: '107200478', title: 'Kit for Duplex Check Valve', status: 'Published', dept: 'STORES-PCMM/SOUTH EASTERN RLY', closing: new Date(2026, 10, 9), attachments: [], corrigenda: [], ...o });
const daysAgo = (n) => new Date(2026, 9, 9 - n);
const paths = () => server.log.map((l) => l.path);
const savedNames = () => saved.map((s) => s.filename);
const run = (no = '29263265', opts = {}) => wf.downloadTenderDocuments(no, opts);
const mk = (state) => { server = new FakeIreps(state); saved.length = 0; disk.clear(); for (const k of Object.keys(store)) delete store[k]; };
beforeEach(() => mk({}));

// =========================== unit tests =====================================================
test('parseWelcomeText: id, company and explicit operating unit', () => {
  const p = acct.parseWelcomeText('A GIRIJA , FAIVELEY TRANSPORT RAIL TECHNOLOGIES INDIA PRIVATE LIMITED-HOSUR (IREPS ID- 833)');
  assert.deepEqual([p.irepsAccountId, p.companyName, p.operatingUnit], ['833', 'FAIVELEY TRANSPORT RAIL TECHNOLOGIES INDIA PRIVATE LIMITED-HOSUR', 'HOSUR']);
});
test('parseWelcomeText: no unit unless the company text states one', () => {
  assert.equal(acct.parseWelcomeText('X Y , ACME STEEL PRIVATE LIMITED (IREPS ID-12)').operatingUnit, null);
  assert.equal(acct.parseWelcomeText('X Y , TATA-STEEL WORKS (IREPS ID-12)').operatingUnit, null);
  assert.equal(acct.parseWelcomeText('X Y , ACME LTD-PUNE (IREPS ID-77)').operatingUnit, 'PUNE');
  assert.equal(acct.parseWelcomeText('nonsense'), null);
});
test('parseWelcomeText: account 60828 is always ROHTAK', () => {
  assert.equal(acct.parseWelcomeText('X Y , FAIVELEY TRANSPORT RAIL TECHNOLOGIES INDIA PRIVATE LIMITED (IREPS ID- 60828)').operatingUnit, 'ROHTAK');
  assert.equal(acct.parseWelcomeText('X Y , FAIVELEY TRANSPORT RAIL TECHNOLOGIES INDIA PRIVATE LIMITED-HOSUR (IREPS ID- 60828)').operatingUnit, 'ROHTAK');
  assert.equal(acct.parseWelcomeText('X Y , FAIVELEY TRANSPORT RAIL TECHNOLOGIES INDIA PRIVATE LIMITED-HOSUR (IREPS ID- 833)').operatingUnit, 'HOSUR');
});
test('isExcludedUrl blocks the Techno-Commercial Tabulation but not My Offer or the Financial / Commercial Tabulation', () => {
  assert.equal(core.isExcludedUrl('/epsn/tbo/commTboPdfAction.do?pdfType=financialTabulation&tenderOID=1'), false);
  assert.equal(core.isExcludedUrl('/epsn/tbo/commTboPdfAction.do?pdfType=commercialTabulation&tenderOID=1'), false);
  assert.equal(core.isExcludedUrl('/ireps/upload/tbo/financialTabulation_107204732.pdf'), false, 'a file the tabulation page links to');
  assert.equal(core.isExcludedUrl('/ireps/upload/tbo/technoCommercialTabulation_1.pdf'), true);
  assert.equal(core.isExcludedUrl('/epsn/tbo/viewTabulation.do?id=1'), true, 'an unknown tabulation');
  assert.equal(core.isExcludedUrl('/epsn/tbo/commTboPdfAction.do?pdfType=technoCommercialTabulation&tenderOID=1'), true);
  assert.equal(core.isExcludedUrl('/epsn/tbo/commTboPdfAction.do?tenderOID=1'), true);
  assert.equal(core.isExcludedUrl('/epsn/tbo/commTboPdfAction.do?pdfType=offer&tenderOID=1&accountID=833'), false);
});
test('toRequest mirrors postRequest.js: POST puts the query in the body, GET keeps it', () => {
  const r = core.toRequest('/epsn/x.do?a=1&b=14/09/2026', 'POST');
  assert.equal(r.method, 'POST'); assert.equal(r.url, '/epsn/x.do'); assert.equal(r.form.get('b'), '14/09/2026');
  assert.equal(core.toRequest('/p.pdf?z=1', 'GET').url, '/p.pdf?z=1');
  assert.equal(core.toRequest('/supply/tds/a.do?x=1', 'POST', { prefix: '/epsn' }).url, '/epsn/supply/tds/a.do');
});
test('elementActions: window.open=GET, postRequest*=POST, loaLetterViewActivity=POST, class=postRequest url=POST', () => {
  const d = new JSDOM(`<a href=# onclick="window.open('/a.do?x=1','','w=1')">a</a><a onclick=postRequestNewWindow('/b.do?y=2','t=0')>b</a>
  <a onclick=loaLetterViewActivity('/supply/c.do?z=3','77')>c</a><a href="#" class="linkStyle postRequest" url=/d.do?q=4>d</a><a href=/e.do?k=5>e</a>`).window.document;
  const m = core.elementActions(d.body).flatMap((a) => a.reqs).map((r) => `${r.method} ${r.url}`);
  assert.deepEqual(m, ['GET /a.do?x=1', 'POST /b.do?y=2', 'POST /supply/c.do?z=3', 'POST /d.do?q=4', 'GET /e.do?k=5']);
});
test('elementActions: a letter URL built by string concatenation is read as one URL', () => {
  const d = new JSDOM(`<a onclick="postRequestNewWindow('/epsn/supply/tds/publishIndiNegotiationLetter.do?nitOId=5' + '&negoLetterId=229935' + '&opValue=ViewPublishedLetter','toolbar=0')">v</a>`).window.document;
  const r = core.elementActions(d.body).flatMap((a) => a.reqs);
  assert.deepEqual(r.map((x) => `${x.method} ${x.url}`), ['POST /epsn/supply/tds/publishIndiNegotiationLetter.do?nitOId=5&negoLetterId=229935&opValue=ViewPublishedLetter']);
});
test('elementActions: mixed literal and variable concatenation still keeps the URL and letter id', () => {
  const d = new JSDOM(`<a onclick="postRequestNewWindow('/epsn/supply/tds/publishCounterOfferLetter.do?Action=ViewPublishedLetter' + '&responseDate=' + responseDate + '&nitOId=' + oid + '&letterId=781' + '&signId=' + signId, 'toolbar=0')">v</a>`).window.document;
  const reqs = core.elementActions(d.body).flatMap((a) => a.reqs);
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].method, 'POST');
  assert.match(reqs[0].url, /publishCounterOfferLetter\.do/);
  assert.match(reqs[0].url, /Action=ViewPublishedLetter/);
  assert.match(reqs[0].url, /letterId=781/);
});
test('viewer page embedding the document through an extension-less iframe resolves to the real PDF', async () => {
  const realFetch = globalThis.fetch;
  const html = '<html><body><p>Negotiation letter viewer page with enough text to be real</p><iframe src="/epsn/supply/tds/showLetter.do?id=1"></iframe></body></html>';
  globalThis.fetch = async (u) => (String(u).includes('showLetter')
    ? new Response(PDF, { status: 200, headers: { 'content-type': 'application/pdf' } })
    : new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }));
  try {
    const out = await core.fetchDocument('https://www.ireps.gov.in', { method: 'POST', url: '/epsn/supply/tds/publishIndiNegotiationLetter.do', form: new URLSearchParams({ a: '1' }) }, { allowHtml: true, allowAnyFile: true });
    assert.equal(out.kind, 'file'); assert.equal(out.ext, '.pdf'); assert.equal(out.converted, false);
  } finally { globalThis.fetch = realFetch; }
});
test('isLoginResponse recognises the real IREPS login page shape and not the authenticated pages', () => {
  const mk = (h) => { const bytes = new TextEncoder().encode(h); return { url: 'https://www.ireps.gov.in/epsn/x.do', contentType: 'text/html', bytes, text: () => h }; };
  assert.equal(core.isLoginResponse(mk('<html><head><title>Log into IREPS</title></head><body><form name="LogonForm" method="post" action="/epsn/home/userLoginAction.do"></form></body></html>')), true);
  assert.equal(core.isLoginResponse(mk('<html><head><title>Bidder Home Page</title></head><body><td class="welcomeLabel">x</td></body></html>')), false);
});
test('sniffKind recognises documents and refuses HTML as a document', () => {
  assert.equal(core.sniffKind(PDF()), 'pdf');
  assert.equal(core.sniffKind(new TextEncoder().encode('<html><body>Login</body></html>')), 'html');
  assert.equal(core.sniffKind(new Uint8Array([0x50, 0x4b, 3, 4])), 'zip');
  assert.equal(core.sniffKind(new Uint8Array()), 'empty');
});
test('inferRoute reads the PT corrigendum route (not the first/Works one) and POST method', () => {
  const html = new TextDecoder().decode(new FakeIreps({}).constructor === FakeIreps ? new Uint8Array() : new Uint8Array());
  return import('./fake-ireps.js').then(({ corrigendumList }) => {
    const doc = new JSDOM(new TextDecoder().decode(corrigendumList(T({ corrigenda: [{ id: '9', cn: '1', date: 'd' }] })))).window.document;
    const s = [...doc.querySelectorAll('script')].map((x) => x.textContent).join('\n');
    const r = wf.inferRoute(s, 'showPubCorriDetail', ['1204920', '1']);
    assert.deepEqual(r, { method: 'POST', url: '/epsn/supply/viewCorrigendum.do?activity=displayPubCorri&nitId=5569207&cn=1&corrigendumId=1204920' });
  });
});
test('finalize statuses', () => {
  const f = (d, dl, fl) => wf.finalize({ ...wf.newCategory('X'), discovered: d, downloaded: dl, failed: fl }).status;
  assert.deepEqual([f(0, 0, 0), f(2, 2, 0), f(2, 0, 2), f(2, 1, 1)], ['NOT_AVAILABLE', 'DOWNLOADED', 'FAILED', 'PARTIAL']);
});
test('saver: sanitises paths, no traversal, unique names', async () => {
  const s = core.createSaver({ accountLabel: '../HOSUR/..', tenderNo: 'A/B..C' });
  assert.equal(s.root.includes('..'), false);
  const a = await s.save('NIT_and_Supporting_Documents', '../../evil.pdf', PDF());
  const b = await s.save('NIT_and_Supporting_Documents', '../../evil.pdf', PDF());
  assert.notEqual(a.relPath, b.relPath);
  assert.ok(saved.every((x) => !x.filename.split('/').includes('..')));
  await assert.rejects(() => s.save('', 'x.pdf', new TextEncoder().encode('<html><body>login</body></html>')), /non-PDF/);
});

// =========================== account detection (1-4) ========================================
test('1. Hosur / 833 is detected live', async () => {
  const a = await acct.getActiveIrepsAccountContext();
  assert.deepEqual([a.irepsAccountId, a.operatingUnit, a.authenticated, a.verified, a.source], ['833', 'HOSUR', true, true, 'ireps_home_page']);
  assert.match(a.companyName, /FAIVELEY.*HOSUR/);
});
test('2. A different account is shown, never forced to Hosur', async () => {
  mk({ account: { id: '4711', company: 'ACME RAIL PRIVATE LIMITED-PUNE' } });
  const a = await acct.getActiveIrepsAccountContext();
  assert.deepEqual([a.irepsAccountId, a.operatingUnit], ['4711', 'PUNE']);
  mk({ account: { id: '9', company: 'PLAIN COMPANY PRIVATE LIMITED' } });
  const b = await acct.getActiveIrepsAccountContext();
  assert.equal(b.operatingUnit, null);
  assert.equal(acct.accountFolderLabel(b), 'IREPS_9');
});
test('3. Missing account information => not verified, download refused', async () => {
  mk({ homeOverride: '<p>Welcome</p><a href="/epsn/home/logout.do">Log Out</a>' });
  const a = await acct.getActiveIrepsAccountContext();
  assert.equal(a.verified, false); assert.equal(a.irepsAccountId, null);
  await assert.rejects(() => run(), (e) => e.code === 'ACCOUNT' && /Unable to verify the active IREPS account/.test(e.message));
  assert.ok(!paths().includes('/epsn/search/advancedSearch.do'));
});
test('3b. Page id disagreeing with script id => not verified', async () => {
  mk({ account: { id: '833', scriptId: '999', company: 'X LTD-HOSUR' } });
  assert.equal((await acct.getActiveIrepsAccountContext()).verified, false);
});
test('3c. Logged out => not authenticated (session error)', async () => {
  mk({ loggedIn: false });
  const a = await acct.getActiveIrepsAccountContext();
  assert.deepEqual([a.authenticated, a.verified], [false, false]);
  await assert.rejects(() => run(), (e) => e.code === 'SESSION_EXPIRED');
});
/** The home page answers HTTP 503 `times` times (Infinity: always), then IREPS answers as usual. Counts home-page requests. */
function homeBusy(times = Infinity) {
  const orig = server.handle.bind(server);
  const seen = { home: 0 };
  server.handle = async (m, u, b) => {
    if (!u.includes('showHome.do') || ++seen.home > times) return orig(m, u, b);
    return { status: 503, type: 'text/html', bytes: new TextEncoder().encode('<html><body>Service Unavailable</body></html>') };
  };
  return seen;
}
const quickRetries = async (fn) => {
  const before = core.fetchSettings.netRetryMs;
  core.fetchSettings.netRetryMs = [5, 5];
  try { return await fn(); } finally { core.fetchSettings.netRetryMs = before; }
};
test('3d. IREPS busy (HTTP 503 on the home page) => asked twice more, then IREPS_UNAVAILABLE: never "log in"', () => quickRetries(async () => {
  const seen = homeBusy();
  await assert.rejects(() => acct.getActiveIrepsAccountContext(), (e) => e.code === 'IREPS_UNAVAILABLE' && /HTTP 503/.test(e.message) && /not a logout/.test(e.message));
  assert.equal(seen.home, 3, 'the first answer and two more tries');
  await assert.rejects(() => run(), (e) => e.code === 'IREPS_UNAVAILABLE', 'the run does not start, and does not say the session expired');
  assert.ok(!paths().includes('/epsn/search/advancedSearch.do'));
}));
test('3e. One busy answer, then the home page => the account is verified', () => quickRetries(async () => {
  const seen = homeBusy(1);
  const a = await acct.getActiveIrepsAccountContext();
  assert.deepEqual([a.irepsAccountId, a.authenticated, a.verified, seen.home], ['833', true, true, 2]);
}));
test('3f. A page that is neither the home page nor the login page => IREPS_UNAVAILABLE; a password form => not signed in', async () => {
  mk({ homeOverride: '<p>The server is busy. Please try after some time.</p>' });
  await assert.rejects(() => acct.getActiveIrepsAccountContext(), (e) => e.code === 'IREPS_UNAVAILABLE');
  mk({ homeOverride: '<form action="/epsn/x.do"><input name="u"><input type="password" name="p"></form>' });
  const a = await acct.getActiveIrepsAccountContext();
  assert.deepEqual([a.authenticated, a.verified], [false, false]);
});
test('3g. IREPS busy during a run => the parts it stops say "IREPS is not responding"; the run is not ended as an expired session', () => quickRetries(async () => {
  mk({ tenders: [T({})] });
  const orig = server.handle.bind(server);
  let n = 0;
  server.handle = async (m, u, b) => (u.includes('showHome.do') && ++n >= 2
    ? { status: 503, type: 'text/html', bytes: new TextEncoder().encode('<html><body>Service Unavailable</body></html>') }
    : orig(m, u, b));
  const r = await run();
  assert.notEqual(r.aborted?.code, 'SESSION_EXPIRED');
  const failed = Object.values(r.categories).filter((c) => c.status === 'FAILED');
  assert.ok(failed.length >= 1, JSON.stringify(r.categories));
  assert.ok(failed.every((c) => /IREPS is not responding/.test(JSON.stringify(c)) && !/session expired/i.test(JSON.stringify(c))), JSON.stringify(failed));
}));
test('3h. A step stopped before it downloads anything keeps the error\'s own code on its FAILED file (a scheduled run names it)', () => quickRetries(async () => {
  mk({ tenders: [T({})] });
  const orig = server.handle.bind(server);
  let n = 0;
  // the run's start sees the home page; the step's own account check finds IREPS busy
  server.handle = async (m, u, b) => (u.includes('showHome.do') && ++n >= 2
    ? { status: 503, type: 'text/html', bytes: new TextEncoder().encode('<html><body>Service Unavailable</body></html>') }
    : orig(m, u, b));
  const c = (await run('29263265', { only: ['tenderPdf'] })).categories.tenderPdf;
  assert.deepEqual([c.status, c.files.length, c.files[0].status, c.files[0].code], ['FAILED', 1, 'FAILED', 'IREPS_UNAVAILABLE']);
  assert.equal(c.files[0].error, c.note);
  assert.match(c.files[0].error, /IREPS is not responding/);
}));
test('4. Switching accounts refreshes the context', async () => {
  assert.equal((await acct.getActiveIrepsAccountContext()).irepsAccountId, '833');
  server.s.account = { id: '55', company: 'OTHER CO LIMITED-DELHI' };
  const b = await acct.getActiveIrepsAccountContext();
  assert.deepEqual([b.irepsAccountId, b.operatingUnit], ['55', 'DELHI']);
});
test('4b. Account switch DURING a run stops the categories that have not started downloading (steps run in parallel)', async () => {
  mk({ tenders: [T({})] });
  let n = 0;
  const orig = server.handle.bind(server);
  server.handle = async (m, u, b) => { if (u.includes('showHome.do') && ++n === 4) server.s.account = { id: '55', company: 'OTHER LTD-DELHI' }; return orig(m, u, b); };
  const r = await run();
  assert.equal(r.aborted.code, 'ACCOUNT_CHANGED');
  const failed = Object.values(r.categories).filter((c) => c.status === 'FAILED');
  assert.ok(failed.length >= 1 && failed.every((c) => /account|Skipped/i.test(c.note || c.error || JSON.stringify(c))));
});

// =========================== search (5-9) ===================================================
test('5. Exact tender found; folder is account-specific', async () => {
  mk({ tenders: [T({})] });
  const r = await run();
  assert.equal(r.tender.tenderNo, '29263265'); assert.equal(r.tender.nitId, '5569207');
  assert.ok(r.folder.startsWith('Downloads/DocLink/HOSUR/Tender_29263265'));
  assert.ok(savedNames().includes('DocLink/HOSUR/Tender_29263265/NIT_and_Supporting_Documents/viewNitPdf_5569207.pdf'), 'the tender PDF keeps its IREPS name');
});
test('6. Tender outside the initial date range is found by retry (past and far-future)', async () => {
  mk({ tenders: [T({ closing: new Date(2027, 2, 1) })] });
  assert.equal((await run()).tender.tenderNo, '29263265');
  mk({ tenders: [T({ closing: daysAgo(250) })] });
  assert.equal((await run()).tender.tenderNo, '29263265');
  assert.ok(server.log.filter((l) => l.path === '/epsn/search/advancedSearch.do' && l.body.advancedSearch).length > 2);
  // every search window respected the 6-month limit
  for (const l of server.log.filter((x) => x.body.dateFrom)) {
    const [d1, m1, y1] = l.body.dateFrom.split('/').map(Number); const [d2, m2, y2] = l.body.dateTo.split('/').map(Number);
    assert.ok((new Date(y2, m2 - 1, d2) - new Date(y1, m1 - 1, d1)) / 86400000 <= 183);
  }
});
test('7. Tender number longer than the form limit: prefix search, exact match, never truncated download', async () => {
  const long = '13-CWMLGDS-ET-2026-27-EXTRA-LONG';
  mk({ tenders: [T({ no: long, nitId: '77', oid: '700' }), T({ no: long.slice(0, 19) + 'X-OTHER', nitId: '78', oid: '701' })] });
  const r = await run(long);
  assert.equal(r.tender.tenderNo, long); assert.equal(r.tender.nitId, '77');
  const sent = server.log.find((l) => l.body.advancedSearch)?.body.advancedSearch;
  assert.equal(sent.length, 19);
  assert.ok(savedNames().some((n) => n.includes(`Tender_${long}`)));
});
test('8. Similar tender numbers: only the exact one is processed', async () => {
  mk({ tenders: [T({ no: '2926326', nitId: '1', oid: '10' }), T({ no: '29263265', nitId: '2', oid: '20' }), T({ no: '292632650', nitId: '3', oid: '30' })] });
  const r = await run('29263265');
  assert.equal(r.tender.nitId, '2');
  assert.ok(paths().some((p) => p.endsWith('viewNitPdf_2.pdf')));
  assert.ok(!paths().some((p) => /viewNitPdf_[13]\.pdf/.test(p)));
});
test('8b. Prefix-only matches are never downloaded', async () => {
  mk({ tenders: [T({ no: '292632650', nitId: '3', oid: '30' })] });
  await assert.rejects(() => run('29263265'), (e) => e.code === 'NOT_FOUND');
  assert.equal(saved.length, 0);
});
test('9. Genuinely not found => NOT_FOUND, nothing downloaded', async () => {
  mk({ tenders: [] });
  await assert.rejects(() => run('99999999'), (e) => e.code === 'NOT_FOUND' && /was not found/.test(e.message));
  assert.equal(saved.length, 0);
});
test('9b. IREPS rejecting "all departments" => each department tried', async () => {
  mk({ rejectAllDepts: true, tenders: [T({ deptCode: '06' })] });
  assert.equal((await run()).tender.tenderNo, '29263265');
});

// =========================== downloads (10-23) ==============================================
const FULL = () => T({
  attachments: [
    { name: 'Annexure.pdf', desc: 'Annexure.pdf', href: '/ireps/upload/att/Annexure.pdf' },
    { name: '5595304.pdf', desc: 'IRS CONDITIONS', href: '/ireps/upload/att/5595304.pdf' },
    { name: '5595313.pdf', desc: 'TENDER CONDITIONS', href: '/ireps/upload/att/5595313.pdf' },
    { name: 'drawing.zip', desc: 'DRAWING', href: '/ireps/upload/att/drawing.zip' },
  ],
  corrigenda: [{ id: '1204920', cn: '1', date: '06/10/2026 16:08' }, { id: '1204999', cn: '2', date: '07/10/2026 10:00', asHtml: true }],
  offer: true,
});
const letters = (no) => ({
  MyNegotiation: [{ no, oid: '107200478', letter: '224222', date: daysAgo(10) }, { no, oid: '107200478', letter: '224300', date: daysAgo(200) }],
  MyCounterOffer: [{ no, oid: '107200478', letter: '1461275', date: daysAgo(12) }],
  MyAdvanceAcceptanceLetter: [{ no, oid: '107200478', letter: '1461928', date: daysAgo(5) }],
});

test('10-14,15-19 full run: every category, correct methods, no manifest file downloaded', async () => {
  mk({ tenders: [FULL()], inbox: letters('29263265'), letterAsPdf: true, corres: { 107200478: { nitOid: '107200478', tenderNo: '29263265', letters: [{ no: '306789', id: '306789', corresId: '225319', subject: 'Withdrawal' }, { no: '306790', id: '306790', corresId: '225320', subject: 'Clarif' }] } } });
  const r = await run();
  const c = r.categories;
  assert.equal(c.tenderPdf.status, 'DOWNLOADED');
  assert.deepEqual([c.attachments.status, c.attachments.downloaded], ['DOWNLOADED', 4]);
  assert.deepEqual([c.corrigenda.status, c.corrigenda.downloaded], ['DOWNLOADED', 2]);
  assert.equal(c.myOffer.status, 'DOWNLOADED');
  assert.deepEqual([c.financialTabulation.status, c.commercialTabulation.status], ['DOWNLOADED', 'DOWNLOADED'], 'both tabulations from the tender row');
  assert.deepEqual([c.negotiation.status, c.negotiation.downloaded], ['DOWNLOADED', 2]); // second letter is in an older window
  assert.deepEqual([c.counterOffer.status, c.counterOffer.downloaded], ['DOWNLOADED', 1]);
  assert.deepEqual([c.loa.status, c.loa.downloaded], ['DOWNLOADED', 1]);
  assert.deepEqual([c.correspondence.status, c.correspondence.downloaded], ['DOWNLOADED', 2]);
  assert.equal(r.summary.failed, 0);
  const n = savedNames().map((x) => x.replace('DocLink/HOSUR/Tender_29263265/', ''));
  // files IREPS served keep their IREPS names; DocLink names the printed / rendered pages and files served
  // without a name (My Offer and the tabulations: POSTs to commTboPdfAction.do)
  for (const want of ['NIT_and_Supporting_Documents/viewNitPdf_5569207.pdf', 'My_Offer/My_Offer_29263265.pdf', 'NIT_and_Supporting_Documents/Annexure.pdf', 'NIT_and_Supporting_Documents/5595304.pdf', 'NIT_and_Supporting_Documents/drawing.zip',
    'Corrigenda/Corrigendum_01_29263265.pdf', 'Corrigenda/Corrigendum_02_29263265.pdf', 'Corrigenda/Corrigendum_02_29263265.html', 'Negotiation/Negotiation_29263265_224222.pdf', 'Negotiation/Negotiation_29263265_224300.pdf',
    'Counter_Offers/Counter_Offer_29263265_1461275.pdf', 'Advance_Acceptance_LOA/LOA_29263265.pdf', 'Correspondence/Correspondence_29263265_306789.pdf',
    'Tabulation/Financial_Tabulation_29263265.pdf', 'Tabulation/Commercial_Tabulation_29263265.pdf']) assert.ok(n.includes(want), `missing ${want}\n${n.join('\n')}`);
  // identifier discipline
  assert.equal(r.tender.nitId, '5569207'); assert.equal(r.tender.nitOid, '107200478'); assert.equal(r.context.tenderOID, '107200478');
  // no download_manifest.json in Downloads; the result still names the account and exclusions
  assert.ok(!n.some((x) => /manifest/i.test(x)), n.join('\n'));
  assert.deepEqual([r.account.irepsAccountId, r.account.operatingUnit, r.account.verified], ['833', 'HOSUR', true]);
  assert.deepEqual(r.exclusions, ['Techno-Commercial Tabulation']);
});
test('10b. Tender PDF is validated: HTML/login response is never saved as .pdf (21)', async () => {
  mk({ tenders: [T({})], failPaths: [] });
  const orig = server.handle.bind(server);
  server.handle = async (m, u, b) => (u.includes('viewNitPdf') ? { status: 200, type: 'text/html', bytes: new TextEncoder().encode('<html><title>Sign In</title><form action="/epsn/home/userLogin.do">Sign in</form></html>') } : orig(m, u, b));
  const r = await run();
  assert.equal(r.categories.tenderPdf.status, 'FAILED');
  assert.ok(!savedNames().some((n) => n.includes('NIT_')));
});
test('10.2: a "%" in an IREPS file name (the link text, a Content-Disposition, a URL) never fails the download with "URI malformed"', async () => {
  assert.equal(core.safeDecode('Spec%20A 50%.pdf'), 'Spec A 50%.pdf', 'the well-formed %XX runs are decoded, the lone "%" is kept');
  assert.equal(core.safeDecode('Annex%E2%82.pdf'), 'Annex%E2%82.pdf', 'an incomplete sequence stays as it is');
  assert.equal(core.safeDecode('Annexure%201.pdf'), 'Annexure 1.pdf');
  const res = { headers: { 'content-disposition': 'attachment; filename="Price 10%.xlsx"' }, url: 'https://www.ireps.gov.in/ireps/upload/att/Rates 5%.zip' };
  assert.equal(core.hintedExtension(res, 'Rates 50%.zip'), '.xlsx');
  assert.equal(core.hintedExtension({ headers: {}, url: res.url }, 'Rates 50%.zip'), '.zip');
  assert.equal(core.extensionFor('zip', { headers: {}, url: res.url }, ''), '.zip');
  // a NIT attachment (not a PDF) whose name on the NIT page holds a "%"
  mk({ tenders: [T({ attachments: [{ name: 'Rates 50%.zip', desc: 'RATES', href: '/ireps/upload/att/rates.zip' }] })] });
  const c = (await run('29263265', { only: ['attachments'] })).categories.attachments;
  assert.deepEqual([c.status, c.downloaded], ['DOWNLOADED', 1], JSON.stringify(c));
  assert.ok(savedNames().some((n) => /NIT_and_Supporting_Documents\/rates\.zip$/.test(n)), savedNames().join('\n'));
});
test('11/12/14/19. No attachments / no corrigenda / no letters are NOT_AVAILABLE, not FAILED', async () => {
  mk({ tenders: [T({})] });
  const c = (await run()).categories;
  assert.equal(c.tenderPdf.status, 'DOWNLOADED');
  for (const k of ['attachments', 'corrigenda', 'myOffer', 'negotiation', 'counterOffer', 'loa', 'correspondence']) assert.equal(c[k].status, 'NOT_AVAILABLE', k);
});
test('13. Corrigendum details are requested with POST on the Goods route read from the page', async () => {
  mk({ tenders: [FULL()] });
  await run();
  const calls = server.log.filter((l) => l.path.endsWith('viewCorrigendum.do') && l.path !== '/epsn/works/rfq/viewCorrigendum.do');
  assert.equal(calls.length, 2);
  assert.ok(calls.every((l) => l.method === 'POST' && l.path === '/epsn/supply/viewCorrigendum.do' && l.body.activity === 'displayPubCorri'));
});
test('15/16. Letters are POSTed (as postRequestNewWindow does) and counter-offer uses the published-letter action, not coResponse', async () => {
  mk({ tenders: [T({})], inbox: letters('29263265') });
  await run();
  const letterCalls = server.log.filter((l) => /publish(IndiNegotiation|CounterOffer)Letter/.test(l.path));
  assert.ok(letterCalls.length >= 3 && letterCalls.every((l) => l.method === 'POST' && Object.keys(l.query).length === 0));
  assert.ok(!paths().some((p) => /coResponse|negoBid|vendorCorresSubmitReply/.test(p)));
});
test('17. LOA letter is requested only after the preliminary request returns exactly OK', async () => {
  mk({ tenders: [T({})], inbox: letters('29263265') });
  const r = await run();
  assert.equal(r.categories.loa.status, 'DOWNLOADED');
  const seq = server.log.filter((l) => /ajxdata|publishLOALetter/.test(l.path));
  assert.deepEqual(seq.map((l) => l.path.split('/').pop()), ['ajxdata.do', 'publishLOALetter.do']);
  assert.deepEqual(seq[0].body, { ajaxMode: 'updateLoaViewedDataByBidder', docId: '1461928', docType: '11' });
  assert.equal(seq[1].path, '/epsn/supply/tds/publishLOALetter.do'); // '/epsn' + url, as the page does
});
test('17b. LOA not OK => letter is NOT requested and the failure is reported', async () => {
  mk({ tenders: [T({})], inbox: letters('29263265'), loaAck: 'Try Again' });
  const r = await run();
  assert.equal(r.categories.loa.status, 'FAILED');
  assert.match(r.categories.loa.files[0].error, /did not confirm/);
  assert.ok(!paths().includes('/epsn/supply/tds/publishLOALetter.do'));
});
test('18. Correspondence: several published letters; reply endpoint never called; nitOid found without guessing from nitId', async () => {
  mk({ tenders: [T({})], corres: { 107200478: { nitOid: '107200478', tenderNo: '29263265', letters: [{ no: '1', id: '11', corresId: '21', subject: 'a' }, { no: '2', id: '12', corresId: '22', subject: 'b' }, { no: '3', id: '13', corresId: '23', subject: 'c' }] } } });
  const r = await run();
  assert.equal(r.categories.correspondence.downloaded, 3);
  const calls = server.log.filter((l) => l.path === '/epsn/corres/rly/viewpubIndltr.do');
  assert.ok(calls.every((l) => l.method === 'POST' && l.body.nitOid === '107200478' && l.body.letterID && l.body.corresId));
  assert.ok(!paths().some((p) => /vendorCorresSubmitReply/.test(p)));
  assert.notEqual(r.tender.nitOid, r.tender.nitId);
});
test('18b. Correspondence page for a different tender is discarded', async () => {
  mk({ tenders: [T({})], corres: { 107200478: { nitOid: '107200478', tenderNo: 'SOMETHING-ELSE', letters: [{ no: '1', id: '11', corresId: '21', subject: 'a' }] } } });
  const r = await run();
  assert.equal(r.categories.correspondence.status, 'FAILED');
  assert.ok(!paths().includes('/epsn/corres/rly/viewpubIndltr.do'));
});
test('20. One failing download does not stop the others (PARTIAL)', async () => {
  mk({ tenders: [FULL()], failPaths: ['Annexure.pdf'] });
  const r = await run();
  assert.equal(r.categories.attachments.status, 'PARTIAL');
  assert.deepEqual([r.categories.attachments.downloaded, r.categories.attachments.failed], [3, 1]);
  assert.equal(r.categories.corrigenda.status, 'DOWNLOADED');
  assert.equal(r.categories.myOffer.status, 'DOWNLOADED');
});
test('20b. HTML wrapper with a PDF link resolves to the real PDF (Case B)', async () => {
  const t = T({ attachments: [{ name: 'Spec.pdf', desc: 'SPEC', href: '/ireps/upload/att/Spec.pdf', asHtml: true }] });
  mk({ tenders: [t] });
  const r = await run();
  assert.equal(r.categories.attachments.status, 'DOWNLOADED');
  assert.ok(saved.find((s) => s.filename.includes('NIT_and_Supporting_Documents'))?.bytes.slice(0, 4).join() === '37,80,68,70');
});
test('print-ready HTML letters without Chrome printing: original .html + text PDF, flagged, never a fake pdf of HTML', async () => {
  mk({ tenders: [T({})], inbox: letters('29263265') }); // letters default to HTML; no chrome.debugger here
  const r = await run();
  assert.equal(r.categories.negotiation.status, 'DOWNLOADED');
  const pdfs = saved.filter((s) => s.filename.includes('Negotiation') && s.filename.endsWith('.pdf'));
  assert.ok(pdfs.length >= 1 && pdfs.every((s) => String.fromCharCode(...s.bytes.slice(0, 4)) === '%PDF'));
  assert.ok(saved.some((s) => s.filename.includes('Negotiation') && s.filename.endsWith('.html')));
  const w = r.categories.negotiation.warnings;
  assert.equal(w.length, 2, w.join('\n'));
  assert.match(w[0], /could not print.*"debugger" permission/);
  assert.match(w[1], /text-only PDF/);
});
// ---- letters printed by Chrome (tender-print.js)
const fakeDebugger = (o) => fakeChromeDebugger(chrome, o);
const withoutDebugger = () => { delete chrome.debugger; delete chrome.tabs; };
const loaOnly = () => mk({ tenders: [T({})], inbox: { MyNegotiation: [], MyCounterOffer: [], MyAdvanceAcceptanceLetter: [{ no: '29263265', oid: '107200478', letter: '1461928', date: daysAgo(5) }] } });

test('LOA: Chrome prints the fetched letter like Ctrl+P (A4, background); IREPS is asked once; no .html; tab closed', async () => {
  loaOnly();
  const dbg = fakeDebugger();
  try {
    const r = await run('29263265', { only: ['loa'] });
    const loa = r.categories.loa;
    assert.deepEqual([loa.status, loa.downloaded, loa.warnings], ['DOWNLOADED', 1, []]);
    const files = saved.filter((s) => s.filename.includes('Advance_Acceptance_LOA'));
    assert.deepEqual(files.map((s) => s.filename.split('/').pop()), ['LOA_29263265.pdf']);
    assert.match(new TextDecoder().decode(files[0].bytes), /chrome-print/);
    assert.equal(loa.files[0].printed, true);
    // the tab was given the letter IREPS returned, at the letter's own address
    const served = dbg.cmd('Fetch.fulfillRequest');
    assert.match(Buffer.from(served.body, 'base64').toString(), /Letter 1461928/);
    assert.match(dbg.cmd('Page.navigate').url, /\/epsn\/supply\/tds\/publishLOALetter\.do$/);
    assert.equal(paths().filter((p) => p.endsWith('publishLOALetter.do')).length, 1);
    assert.deepEqual(dbg.cmd('Page.printToPDF'), { paperWidth: 8.27, paperHeight: 11.69, printBackground: true, displayHeaderFooter: false, preferCSSPageSize: true });
    assert.deepEqual([dbg.tabs.created, dbg.tabs.removed], [1, [7]]);
    assert.ok(dbg.calls.some((c) => c[0] === 'detach'));
  } finally {
    withoutDebugger();
  }
});
test('LOA: when Chrome will not let DocLink print (policy), the one text PDF is kept (no .html) and the run says why', async () => {
  loaOnly();
  const dbg = fakeDebugger({ attachError: 'Cannot access a chrome:// URL' });
  try {
    const loa = (await run('29263265', { only: ['loa'] })).categories.loa;
    assert.equal(loa.status, 'DOWNLOADED');
    const names = saved.filter((s) => s.filename.includes('Advance_Acceptance_LOA')).map((s) => s.filename.split('/').pop());
    assert.deepEqual(names, ['LOA_29263265.pdf']);
    assert.ok(loa.warnings.some((w) => /could not print.*Cannot access/i.test(w)), loa.warnings.join('\n'));
    assert.deepEqual(dbg.tabs.removed, [7]);
  } finally {
    withoutDebugger();
  }
});
test('LOA: only the letter page is saved, printed by Chrome - nothing it links, embeds or redirects to is downloaded', async () => {
  loaOnly();
  server.s.loaExtra = '<p>Annexure: <a href="/ireps/upload/loa/Annexure_A.pdf" target="_blank">Annexure_A.pdf</a></p><iframe src="/ireps/upload/loa/viewer.do?id=1"></iframe>' +
    '<embed src="/ireps/upload/loa/Terms.pdf"><a href="#" onclick="window.open(\'/ireps/upload/loa/Sign.docx\')">sign</a><script>if(0){window.location=\'/ireps/upload/loa/next.pdf\'}</script>';
  const dbg = fakeDebugger();
  try {
    const loa = (await run('29263265', { only: ['loa'] })).categories.loa;
    assert.deepEqual([loa.status, loa.downloaded], ['DOWNLOADED', 1]);
    const files = saved.filter((s) => s.filename.includes('Advance_Acceptance_LOA'));
    assert.deepEqual(files.map((s) => s.filename.split('/').pop()), ['LOA_29263265.pdf']);
    assert.match(new TextDecoder().decode(files[0].bytes), /chrome-print/);
    assert.ok(!server.loaAttachmentHit, `a file inside the letter was fetched: ${paths().filter((p) => p.includes('/loa/')).join(', ')}`);
    assert.match(Buffer.from(dbg.cmd('Fetch.fulfillRequest').body, 'base64').toString(), /Letter 1461928/);
  } finally {
    withoutDebugger();
  }
});
const coOnly = () => mk({ tenders: [T({})], inbox: { MyNegotiation: [], MyCounterOffer: [{ no: '29263265', oid: '107200478', letter: '1461275', date: daysAgo(12) }], MyAdvanceAcceptanceLetter: [] } });
test('Counter Offer: a letter with a document attached saves the letter page printed by Chrome, never the attachment', async () => {
  coOnly();
  server.s.coExtra = '<p>Attached document: <a href="/ireps/upload/co/CounterOffer_Annexure.pdf" target="_blank">CounterOffer_Annexure.pdf</a></p>' +
    '<iframe src="/ireps/upload/co/viewer.do?id=1"></iframe><embed src="/ireps/upload/co/Rates.pdf"><a href="#" onclick="window.open(\'/ireps/upload/co/Sheet.xlsx\')">rates</a>';
  const dbg = fakeDebugger();
  try {
    const co = (await run('29263265', { only: ['counterOffer'] })).categories.counterOffer;
    assert.deepEqual([co.status, co.downloaded, co.warnings], ['DOWNLOADED', 1, []]);
    const files = saved.filter((s) => s.filename.includes('Counter_Offers'));
    assert.deepEqual(files.map((s) => s.filename.split('/').pop()), ['Counter_Offer_29263265_1461275.pdf']);
    assert.match(new TextDecoder().decode(files[0].bytes), /chrome-print/);
    assert.ok(!server.coAttachmentHit, `a file attached to the letter was fetched: ${paths().filter((p) => p.includes('/co/')).join(', ')}`);
    assert.match(Buffer.from(dbg.cmd('Fetch.fulfillRequest').body, 'base64').toString(), /Letter 1461275/);
    assert.match(dbg.cmd('Page.navigate').url, /\/epsn\/supply\/tds\/publishCounterOfferLetter\.do$/);
    assert.equal(paths().filter((p) => p.endsWith('publishCounterOfferLetter.do')).length, 1);
  } finally {
    withoutDebugger();
  }
});
test('Counter Offer: when Chrome cannot print, the one text PDF of the letter is kept (no .html, no attachment)', async () => {
  coOnly();
  server.s.coExtra = '<a href="/ireps/upload/co/CounterOffer_Annexure.pdf">CounterOffer_Annexure.pdf</a>';
  const co = (await run('29263265', { only: ['counterOffer'] })).categories.counterOffer;
  assert.equal(co.status, 'DOWNLOADED');
  assert.deepEqual(saved.filter((s) => s.filename.includes('Counter_Offers')).map((s) => s.filename.split('/').pop()), ['Counter_Offer_29263265_1461275.pdf']);
  assert.ok(!server.coAttachmentHit);
});
test('LOA: a letter IREPS serves as a PDF file is kept as it is (one PDF, no print)', async () => {
  loaOnly();
  server.s.letterAsPdf = true;
  const loa = (await run('29263265', { only: ['loa'] })).categories.loa;
  assert.equal(loa.status, 'DOWNLOADED');
  const files = saved.filter((s) => s.filename.includes('Advance_Acceptance_LOA'));
  assert.deepEqual(files.map((s) => s.filename.split('/').pop()), ['LOA_29263265.pdf']);
  assert.match(new TextDecoder().decode(files[0].bytes), /letter1461928/);
});
test('LOA: cancelling the "started debugging" bar falls back to the text PDF', async () => {
  loaOnly();
  fakeDebugger({ cancel: true });
  try {
    const loa = (await run('29263265', { only: ['loa'] })).categories.loa;
    assert.equal(loa.status, 'DOWNLOADED');
    assert.ok(loa.warnings.some((w) => /bar was cancelled/.test(w)), loa.warnings.join('\n'));
  } finally {
    withoutDebugger();
  }
});
test('Every published letter and corrigendum page is printed by Chrome (negotiation, counter offer, LOA, correspondence, corrigendum); a corrigendum file is saved as is', async () => {
  mk({ tenders: [FULL()], inbox: letters('29263265'), corres: { 107200478: { nitOid: '107200478', tenderNo: '29263265', letters: [{ no: '306789', id: '306789', corresId: '225319', subject: 'Withdrawal' }] } } });
  const dbg = fakeDebugger();
  try {
    const c = (await run()).categories;
    const counts = {};
    for (const k of ['negotiation', 'counterOffer', 'loa', 'correspondence']) {
      assert.equal(c[k].status, 'DOWNLOADED', k);
      assert.ok(c[k].files.every((f) => f.printed && f.fileName.endsWith('.pdf')), `${k}: ${JSON.stringify(c[k].files)}`);
      assert.deepEqual(c[k].warnings, [], k);
      counts[k] = c[k].files.length;
    }
    assert.deepEqual(counts, { negotiation: 2, counterOffer: 1, loa: 1, correspondence: 1 });
    // corrigendum 02 is a web page (POST supply/viewCorrigendum.do): printed like the letters; 01 is a PDF file: saved as is
    const corr = Object.fromEntries(c.corrigenda.files.map((f) => [f.fileName, f]));
    assert.deepEqual(Object.keys(corr).sort(), ['Corrigendum_01_29263265.pdf', 'Corrigendum_02_29263265.pdf']);
    assert.equal(corr['Corrigendum_02_29263265.pdf'].printed, true);
    assert.equal(corr['Corrigendum_01_29263265.pdf'].printed, undefined);
    assert.deepEqual(c.corrigenda.warnings, []);
    assert.equal(dbg.tabs.created, 6);
    const names = savedNames();
    assert.ok(!names.some((n) => /(Negotiation|Counter_Offers|Advance_Acceptance_LOA|Correspondence|Corrigenda)\/.*\.html$/.test(n)), names.join('\n'));
    // the corrigendum page is asked for as its view icon does: POST with activity=displayPubCorri, nitId, cn, corrigendumId
    const asked = server.log.filter((l) => l.path === '/epsn/supply/viewCorrigendum.do');
    assert.equal(asked.length, 2);
    assert.ok(asked.every((l) => l.method === 'POST' && l.body.activity === 'displayPubCorri' && l.body.nitId === '5569207' && l.body.cn && l.body.corrigendumId), JSON.stringify(asked));
  } finally {
    withoutDebugger();
  }
});
const ATT_CORR = (attached) => T({ corrigenda: [{ id: '1204999', cn: '2', date: '07/10/2026 10:00', attached }] });
const savedText = (suffix) => new TextDecoder().decode(saved.find((x) => x.filename.endsWith(suffix))?.bytes || new Uint8Array());
test('Corrigendum with an attached document: the corrigendum page (printed) AND the attached file are saved, never the file alone', async () => {
  mk({ tenders: [ATT_CORR(['Revised_Spec.pdf'])] });
  const dbg = fakeDebugger();
  try {
    const c = (await run('29263265', { only: ['corrigenda'] })).categories.corrigenda;
    assert.equal(c.status, 'DOWNLOADED');
    assert.equal(c.downloaded, 1, 'one corrigendum (its attachment is not counted as another)');
    const files = Object.fromEntries(c.files.map((f) => [f.fileName, f]));
    assert.deepEqual(Object.keys(files).sort(), ['Corrigendum_02_29263265.pdf', 'Revised_Spec.pdf'], 'the printed page is named by DocLink, the attached file keeps its IREPS name');
    assert.equal(files['Corrigendum_02_29263265.pdf'].printed, true, 'the page itself is printed by Chrome');
    assert.equal(files['Revised_Spec.pdf'].role, 'attachment');
    assert.equal(files['Revised_Spec.pdf'].attachmentOf, 'Corrigendum_02_29263265.pdf');
    assert.match(savedText('Revised_Spec.pdf'), /corratt\/ireps\/upload\/corrigendum\/1204999\/Revised_Spec\.pdf/, 'the attachment is the linked file');
    assert.doesNotMatch(savedText('Corrigendum_02_29263265.pdf'), /corratt/, 'the corrigendum is the page, not the attachment');
    assert.equal(dbg.tabs.created, 1);
    assert.deepEqual(c.warnings, []);
    assert.ok(savedNames().every((n) => n.includes('/Corrigenda/')), savedNames().join('\n'));
  } finally {
    withoutDebugger();
  }
});
test('Corrigendum attachments: several are numbered in page order; one that fails is a failed document (PARTIAL) and the rest are kept (2.1)', async () => {
  mk({ tenders: [ATT_CORR(['Revised_Spec.pdf', 'missing.pdf', 'Annexure.pdf'])] });
  fakeDebugger();
  try {
    const c = (await run('29263265', { only: ['corrigenda'] })).categories.corrigenda;
    assert.deepEqual([c.status, c.downloaded, c.failed], ['PARTIAL', 1, 1], 'the corrigendum is saved, the attachment that failed is a failed document');
    assert.deepEqual(c.files.filter((f) => f.status === 'DOWNLOADED').map((f) => f.fileName), ['Corrigendum_02_29263265.pdf', 'Revised_Spec.pdf', 'Annexure.pdf']);
    assert.match(savedText('Corrigenda/Annexure.pdf'), /Annexure\.pdf/);
    const failed = c.files.filter((f) => f.status === 'FAILED');
    assert.deepEqual(failed.map((f) => [f.role, f.code]), [['attachment', 'HTTP']]);
    assert.match(failed[0].error, /Corrigendum_02_29263265\.pdf: an attached document \(missing\.pdf\) could not be downloaded \(IREPS returned HTTP 404/);
    assert.deepEqual(c.warnings, [], 'said once, by the failed document');
  } finally {
    withoutDebugger();
  }
});
test('Corrigendum attachments without Chrome printing: text PDF + original HTML + the attached file', async () => {
  mk({ tenders: [ATT_CORR(['Revised_Spec.pdf'])] });
  const c = (await run('29263265', { only: ['corrigenda'] })).categories.corrigenda;
  assert.deepEqual(c.files.map((f) => f.fileName), ['Corrigendum_02_29263265.pdf', 'Corrigendum_02_29263265.html', 'Revised_Spec.pdf']);
  assert.match(savedText('Corrigendum_02_29263265.pdf'), /%PDF/);
});
test('A NIT viewer page still gives the NIT PDF only (keepPage is for corrigenda alone)', async () => {
  mk({ tenders: [T({ attachments: [{ name: 'Spec.pdf', desc: 'SPEC', href: '/ireps/upload/att/Spec.pdf', asHtml: true }] })] });
  const c = (await run('29263265', { only: ['attachments'] })).categories.attachments;
  assert.equal(c.status, 'DOWNLOADED');
  assert.ok(c.files.every((f) => !f.role && f.fileName.endsWith('.pdf')), JSON.stringify(c.files));
  assert.ok(!savedNames().some((n) => /\.html$|_Attachment_/.test(n)), savedNames().join('\n'));
});
test('21. Session expiry mid-run is reported and nothing HTML is saved as a document', async () => {
  mk({ tenders: [FULL()] });
  const orig = server.handle.bind(server);
  server.handle = async (m, u, b) => { if (u.includes('upload/att/5595304')) server.s.loggedIn = false; return orig(m, u, b); };
  const r = await run();
  assert.equal(r.aborted.code, 'SESSION_EXPIRED');
  // the .html files are the deliberately saved originals of printable pages; no .pdf may be a web page
  assert.ok(saved.every((s) => !s.filename.endsWith('.pdf') || sniffOk(s.bytes)));
});
function sniffOk(b) { return core.sniffKind(b) !== 'html'; }
test('22. Pagination: letters on later pages are found; loop terminates', async () => {
  const rows = [1, 2, 3].map((n) => ({ no: '29263265', oid: '107200478', letter: String(500 + n), date: daysAgo(3), page: n }));
  mk({ tenders: [T({})], inbox: { MyNegotiation: rows, MyCounterOffer: [], MyAdvanceAcceptanceLetter: [] }, inboxPages: { MyNegotiation: 3 } });
  const r = await run();
  assert.equal(r.categories.negotiation.downloaded, 3);
  assert.ok(server.log.filter((l) => l.body.pageNo && l.body.status === 'MyNegotiation').length < 40);
});
test('23. Identical URLs are not downloaded twice', async () => {
  const dup = { no: '29263265', oid: '107200478', letter: '777', date: daysAgo(3) };
  mk({ tenders: [T({})], inbox: { MyNegotiation: [dup, { ...dup }], MyCounterOffer: [], MyAdvanceAcceptanceLetter: [] } });
  const r = await run();
  assert.equal(r.categories.negotiation.discovered, 1);
  assert.equal(server.log.filter((l) => l.path.endsWith('publishIndiNegotiationLetter.do')).length, 1);
});
test('Counter-offer / LOA letters for another bidder account are skipped with an account-mismatch error', async () => {
  mk({ tenders: [T({})], inbox: { MyNegotiation: [], MyCounterOffer: [{ no: '29263265', oid: '1', letter: '5', date: daysAgo(2), bidder: '999' }], MyAdvanceAcceptanceLetter: [{ no: '29263265', oid: '1', letter: '6', date: daysAgo(2), bidder: '999' }] } });
  const r = await run();
  for (const k of ['counterOffer', 'loa']) { assert.equal(r.categories[k].status, 'FAILED'); assert.match(r.categories[k].files[0].error, /Account mismatch.*999.*833/); }
  assert.ok(!paths().some((p) => /publishCounterOfferLetter|publishLOALetter|ajxdata/.test(p)));
});
test('My Offer for a different account id is refused', async () => {
  mk({ tenders: [T({ offer: true, offerAcct: '12' })] });
  const r = await run();
  assert.equal(r.categories.myOffer.status, 'FAILED');
  assert.match(r.categories.myOffer.files[0].error, /Account mismatch/);
});

// =========================== corrigendum regression (footer PDFs) ===========================
test('No corrigendum issued: footer PDFs (About/Disclaimer/Privacy/Terms/Copyright) are NOT downloaded as corrigenda', async () => {
  mk({ tenders: [T({})] });
  const r = await run();
  assert.equal(r.categories.corrigenda.status, 'NOT_AVAILABLE');
  assert.equal(r.categories.corrigenda.downloaded, 0);
  assert.ok(!server.footerHit);
  assert.ok(!savedNames().some((n) => /Corrigenda/.test(n)));
});
test('Empty list + corrigendum notice in TODAY\'s inbox: nothing downloaded, user told to retry', async () => {
  const today = new Date();
  const d = `${String(today.getDate()).padStart(2, '0')}/${String(today.getMonth() + 1).padStart(2, '0')}/${today.getFullYear()}`;
  mk({ tenders: [T({})], messages: [
    { date: d, subject: 'Issue of Corrigendum towards STORES-PCMM/SOUTH EASTERN RLY, Tender no: 29263265' },
    { date: d, subject: 'Issue of Corrigendum towards STORES, Tender no: 292632650' },
    { date: '01/01/2020', subject: 'Issue of Corrigendum towards X, Tender no: 29263265' },
  ] });
  const r = await run();
  assert.equal(r.categories.corrigenda.status, 'NOT_AVAILABLE');
  assert.match(r.categories.corrigenda.note, /notice.*dated today/);
  const n = await wf.findCorrigendumNotices({ base: 'https://www.ireps.gov.in' }, { tenderNo: '29263265' });
  assert.equal(n.length, 1);
});
test('Published corrigenda in the list are still downloaded (and no inbox lookup is needed)', async () => {
  mk({ tenders: [T({ corrigenda: [{ id: '5', cn: '1', date: 'd' }] })] });
  const r = await run();
  assert.equal(r.categories.corrigenda.downloaded, 1);
  assert.ok(!server.log.some((l) => l.body.listType === 'MyMsg'));
});

test('Daily corrigendum job: any tender with a notice dated today is downloaded, regardless of tender number', async () => {
  const d = new Date();
  const today = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
  mk({
    tenders: [T({ no: 'AAA111', nitId: '11', oid: '110', corrigenda: [{ id: '1', cn: '1', date: `${today} 09:00` }] }), T({ no: 'BBB222', nitId: '22', oid: '220', corrigenda: [{ id: '2', cn: '1', date: `${today} 09:00` }, { id: '3', cn: '2', date: `${today} 11:00` }] }), T({ no: 'CCC333', nitId: '33', oid: '330', corrigenda: [{ id: '4', cn: '1', date: 'd' }] })],
    messages: [
      { date: today, subject: 'Issue of Corrigendum towards STORES/X RLY, Tender no: AAA111' },
      { date: today, subject: 'NIT for STORES/EASTERN RLY, Tender Number: 20261011' },
      { date: today, subject: 'Issue of Corrigendum towards STORES/Y RLY, Tender no: BBB222' },
      { date: today, subject: 'Issue of Corrigendum towards STORES/Y RLY, Tender no: BBB222' },
      { date: '01/01/2020', subject: 'Issue of Corrigendum towards STORES/Z RLY, Tender no: CCC333' },
    ],
  });
  const r = await jobs.downloadTodaysCorrigenda();
  assert.deepEqual(r.tenders.map((x) => x.tenderNo), ['AAA111', 'BBB222']);
  assert.deepEqual(r.tenders.map((x) => x.corrigenda.downloaded), [1, 2]);
  assert.equal(r.summary.downloaded, 3);
  assert.ok(savedNames().some((n) => n.includes('Tender_BBB222/Corrigenda/Corrigendum_02_BBB222.pdf')));
  assert.ok(!savedNames().some((n) => n.includes('CCC333')));
});

test('Each document type can be downloaded on its own', async () => {
  mk({ tenders: [FULL()], inbox: letters('29263265'), letterAsPdf: true });
  const only = async (keys) => { saved.length = 0; server.log.length = 0; return run('29263265', { only: keys }); };
  let r = await only(['tenderPdf', 'attachments']);
  assert.deepEqual(Object.keys(r.categories), ['tenderPdf', 'attachments']);
  assert.deepEqual(r.categories.attachments.downloaded, 4);
  assert.ok(!paths().some((p) => /viewCorrigendum|vendorInboxLink|publish/.test(p)));
  r = await only(['corrigenda']);
  assert.deepEqual(Object.keys(r.categories), ['corrigenda']);
  assert.ok(savedNames().every((n) => /Corrigenda|manifest/.test(n)));
  r = await only(['negotiation']);
  assert.equal(r.categories.negotiation.downloaded, 2);
  assert.ok(!paths().some((p) => /publishCounterOffer|publishLOA|ajxdata|viewCorrigendum/.test(p)));
  r = await only(['counterOffer']); assert.equal(r.categories.counterOffer.downloaded, 1);
  r = await only(['loa']); assert.equal(r.categories.loa.downloaded, 1);
  assert.equal(r.summary.downloaded, 1);
});

// =========================== scheduled jobs ===============================================
const D = 86400000;
const dmy = (ms) => { const d = new Date(ms); return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`; };
const NOW = () => Date.now();

test('Corrigendum job downloads ONLY the corrigendum published that day, and not again on a re-run', async () => {
  const today = dmy(NOW());
  mk({
    tenders: [T({ no: 'AAA111', nitId: '11', oid: '110', closing: new Date(NOW() + 20 * D), corrigenda: [{ id: '1', cn: '1', date: '01/09/2026 10:00' }, { id: '2', cn: '2', date: `${today} 10:00` }] })],
    messages: [{ date: today, subject: 'Issue of Corrigendum towards STORES/X RLY, Tender no: AAA111' }],
  });
  const r1 = await jobs.downloadTodaysCorrigenda();
  assert.equal(r1.tenders[0].corrigenda.downloaded, 1);
  assert.deepEqual(savedNames().filter((n) => n.includes('Corrigenda')).map((n) => n.split('/').pop()), ['Corrigendum_02_AAA111.pdf']);
  assert.equal(server.log.filter((l) => l.path === '/epsn/supply/viewCorrigendum.do').length, 1);
  const docs = () => saved.filter((s) => !s.filename.endsWith('.json')).length;
  const before = docs();
  const r2 = await jobs.downloadTodaysCorrigenda();
  assert.equal(r2.tenders[0].corrigenda.downloaded, 0);
  assert.equal(r2.tenders[0].corrigenda.alreadyDownloaded, 1);
  assert.equal(saved.filter((s) => s.filename.includes('Corrigenda')).length, 1);
  assert.equal(docs(), before);
});
test('Corrigendum job: notice today but corrigendum not listed yet => nothing downloaded, retried on the next run', async () => {
  const today = dmy(NOW());
  mk({ tenders: [T({ no: 'AAA111', nitId: '11', oid: '110', closing: new Date(NOW() + 20 * D), corrigenda: [{ id: '1', cn: '1', date: '01/09/2026 10:00' }] })], messages: [{ date: today, subject: 'Issue of Corrigendum towards X, Tender no: AAA111' }] });
  const r = await jobs.downloadTodaysCorrigenda();
  assert.equal(r.tenders[0].corrigenda.status, 'NOT_AVAILABLE');
  assert.match(r.tenders[0].corrigenda.note, /no corrigendum dated/);
  assert.equal(saved.filter((s) => s.filename.includes('Corrigenda')).length, 0);
});
test('NIT job: reads every day since the last run (Sunday/holiday gap), downloads Tender PDF + attachments, never twice', async () => {
  const att = (n) => [{ name: n + '.pdf', desc: 'Annexure', href: `/ireps/upload/att/${n}.pdf` }];
  mk({
    tenders: [
      T({ no: 'SUN1', nitId: '71', oid: '710', closing: new Date(NOW() + 30 * D), attachments: att('s1') }),
      T({ no: 'MON1', nitId: '72', oid: '720', closing: new Date(NOW() + 40 * D), attachments: att('m1') }),
      T({ no: 'OLD1', nitId: '73', oid: '730', closing: new Date(NOW() + 50 * D) }),
    ],
    messages: [
      { date: dmy(NOW()), subject: 'NIT for STORES/A RLY, Tender Number: MON1' },
      { date: dmy(NOW() - 1 * D), subject: 'NIT for STORES/B RLY, Tender Number: SUN1' },   // the missed day
      { date: dmy(NOW() - 9 * D), subject: 'NIT for STORES/C RLY, Tender Number: OLD1' },  // before the last run
      { date: dmy(NOW()), subject: 'Issue of Corrigendum towards X, Tender no: MON1' },    // not a NIT notice
    ],
  });
  // the previous run was 2 days ago
  const key = 'doclink.tender.ledger.833';
  store[key] = { v: 1, nit: {}, corrigenda: {}, letters: {}, meta: { lastNitDate: dmy(NOW() - 2 * D) } };
  const r1 = await jobs.downloadNewNits();
  assert.deepEqual(r1.tenders.map((t) => t.tenderNo).sort(), ['MON1', 'SUN1']);
  assert.ok(r1.tenders.every((t) => t.tenderPdf.status === 'DOWNLOADED' && t.attachments.status === 'DOWNLOADED'));
  assert.ok(savedNames().some((n) => /Tender_SUN1\/NIT_and_Supporting_Documents\/viewNitPdf_\w+\.pdf$/.test(n)) && savedNames().filter((n) => n.includes('Tender_MON1/NIT_and_Supporting_Documents/')).length >= 2, savedNames().join('\n'));
  assert.ok(!savedNames().some((n) => n.includes('OLD1')));
  // searched "next 6 months" first
  assert.ok(server.log.find((l) => l.body.advancedSearch === 'MON1').body.dateFrom === dmy(NOW()));
  const n1 = saved.length;
  const r2 = await jobs.downloadNewNits();
  assert.equal(r2.tenders.length, 0); assert.equal(saved.length, n1);
});
test('NIT job: a tender that cannot be found/downloaded is retried on the next run', async () => {
  mk({ tenders: [], messages: [{ date: dmy(NOW()), subject: 'NIT for STORES/A RLY, Tender Number: LATE1' }] });
  const r1 = await jobs.downloadNewNits();
  assert.deepEqual(r1.retryLater, ['LATE1']);
  server.s.tenders = [T({ no: 'LATE1', nitId: '81', oid: '810', closing: new Date(NOW() + 10 * D) })];
  const r2 = await jobs.downloadNewNits();
  assert.equal(r2.tenders[0].tenderPdf.status, 'DOWNLOADED');
  assert.deepEqual(r2.retryLater, []);
});
test('Letters job is by DATE: only letters published today, no tender number, no tender search, never twice', async () => {
  const at = (n) => new Date(NOW() - n * D);
  mk({
    inbox: {
      MyNegotiation: [{ no: 'NEG1', oid: '5001', letter: '11', date: at(0) }, { no: 'OLD9', oid: '5009', letter: '10', date: at(5) }],
      MyCounterOffer: [{ no: 'CO7', oid: '5007', letter: '21', date: at(0) }],
      MyAdvanceAcceptanceLetter: [{ no: 'LOA3', oid: '5003', letter: '31', date: at(0) }],
    },
    letterAsPdf: true,
  });
  const r1 = await jobs.downloadLettersByDate();
  assert.equal(r1.summary.newLetters, 3);
  const names = savedNames().map((n) => n.split('/').slice(-3).join('/'));
  for (const w of ['Tender_NEG1/Negotiation/Negotiation_NEG1_11.pdf', 'Tender_CO7/Counter_Offers/Counter_Offer_CO7_21.pdf', 'Tender_LOA3/Advance_Acceptance_LOA/LOA_LOA3.pdf']) assert.ok(names.includes(w), w);
  assert.ok(!names.some((n) => n.includes('OLD9')));
  // fast: three list reads (+form loads), no tender search, no per-tender re-query by tender number
  assert.ok(!server.log.some((l) => l.path === '/epsn/search/advancedSearch.do'));
  assert.ok(!server.log.some((l) => l.path === '/epsn/vendorInboxLink.do' && l.body.tenderNo));
  assert.ok(server.log.filter((l) => l.path === '/epsn/vendorInboxLink.do' && l.body.startDate).length <= 3 * 2 * 2);
  const docs = () => saved.filter((s) => !s.filename.endsWith('.json')).length;
  const n1 = docs();
  assert.equal((await jobs.downloadLettersByDate()).summary.newLetters, 0);
  assert.equal(docs(), n1);
  server.s.inbox.MyNegotiation.push({ no: 'NEG1', oid: '5001', letter: '12', date: at(0) }); // published later today
  assert.equal((await jobs.downloadLettersByDate()).summary.newLetters, 1);
  assert.ok(savedNames().some((n) => n.includes('Negotiation_NEG1_12')));
  assert.ok(!server.log.some((l) => /vendorCorresSubmitReply|coResponse|negoBid/.test(l.path)));
});
test('Letters job: catches up on days since the last run (Sunday/holiday) and can fetch one chosen date', async () => {
  const at = (n) => new Date(NOW() - n * D);
  mk({ inbox: { MyNegotiation: [{ no: 'A1', oid: '1', letter: '1', date: at(0) }, { no: 'B1', oid: '2', letter: '2', date: at(1) }, { no: 'C1', oid: '3', letter: '3', date: at(4) }], MyCounterOffer: [], MyAdvanceAcceptanceLetter: [] }, letterAsPdf: true });
  store['doclink.tender.ledger.833'] = { v: 1, nit: {}, corrigenda: {}, letters: {}, meta: { lastLetterDate: dmy(NOW() - 2 * D) } };
  const r = await jobs.downloadLettersByDate();
  assert.deepEqual(r.tenders.map((x) => x.tenderNo).sort(), ['A1', 'B1']);
  const one = await jobs.downloadLettersByDate({ dateStr: dmy(NOW() - 4 * D) });
  assert.deepEqual(one.tenders.map((x) => x.tenderNo), ['C1']);
});
test('Letters job: LOA letter needs the OK acknowledgement; not-OK is reported with the reason', async () => {
  mk({ inbox: { MyNegotiation: [], MyCounterOffer: [], MyAdvanceAcceptanceLetter: [{ no: 'L1', oid: '9', letter: '77', date: new Date(NOW()) }] }, loaAck: 'Try Again' });
  const r = await jobs.downloadLettersByDate();
  assert.equal(r.tenders[0].categories.loa.status, 'FAILED');
  assert.match(r.tenders[0].categories.loa.files[0].error, /did not confirm/);
});
// IREPS ignores startDate/endDate on these lists and returns them newest first (the fake does the same)
const longList = (extra = []) => [...Array.from({ length: 60 }, (_, i) => ({ no: `T${i}`, oid: `6${i}`, letter: `40${i}`, date: new Date(NOW() - (1 + i) * D) })), ...extra];
const negoPages = () => server.listPages.filter((l) => l.status === 'MyNegotiation');
test('Letters job reads the list once and stops after 2 pages older than From (not the whole list, twice)', async () => {
  mk({ inbox: { MyNegotiation: longList([{ no: 'NEW1', oid: '71', letter: '901', date: new Date(NOW()) }, { no: 'NEW2', oid: '72', letter: '902', date: new Date(NOW()) }]), MyCounterOffer: [], MyAdvanceAcceptanceLetter: [] }, letterAsPdf: true });
  const r = await jobs.downloadLettersByDate({ dates: [dmy(NOW())], statuses: ['MyNegotiation'] });
  assert.deepEqual(r.tenders.map((t) => t.tenderNo).sort(), ['NEW1', 'NEW2']);
  assert.deepEqual(negoPages().map((l) => l.pageNo), ['1', '2', '3'], '62 rows = 5 pages; page 1 has today, pages 2-3 are older, 4-5 never read');
  assert.equal(new Set(negoPages().map((l) => `${l.startDate}..${l.endDate}`)).size, 1, 'one date window');
  assert.match(core.getLogTail(), /MyNegotiation: pages 2-3 are all older than \d{2}\/\d{2}\/\d{4}; stopping/);
});
test('Letters job: a letter dated today behind a full page of older live-bid rows is still found', async () => {
  const live = Array.from({ length: 14 }, (_, i) => ({ no: `LIVE${i}`, oid: `8${i}`, letter: `50${i}`, date: new Date(NOW() - (3 + i) * D), live: true }));
  mk({ inbox: { MyNegotiation: longList([...live, { no: 'LAPSED_TODAY', oid: '79', letter: '909', date: new Date(NOW()) }]), MyCounterOffer: [], MyAdvanceAcceptanceLetter: [] }, letterAsPdf: true });
  const r = await jobs.downloadLettersByDate({ dates: [dmy(NOW())], statuses: ['MyNegotiation'] });
  assert.deepEqual(r.tenders.map((t) => t.tenderNo), ['LAPSED_TODAY']);
  assert.deepEqual(negoPages().map((l) => l.pageNo), ['1', '2', '3', '4']);
});
test('Letters job: a From date far back reads the list to its end and finds every letter in range', async () => {
  mk({ inbox: { MyNegotiation: longList(), MyCounterOffer: [], MyAdvanceAcceptanceLetter: [] }, letterAsPdf: true });
  const r = await jobs.downloadLettersByDate({ dates: jobs.dayRange(new Date(NOW() - 70 * D), new Date(NOW())), statuses: ['MyNegotiation'] });
  assert.equal(r.summary.newLetters, 60);
  assert.deepEqual(negoPages().map((l) => l.pageNo), ['1', '2', '3', '4', '5']);
});
test('Download by tender number: the date ranges stop once IREPS returns the same list for a second range', async () => {
  mk({ tenders: [T({})], inbox: letters('29263265'), letterAsPdf: true });
  await run('29263265', { only: ['negotiation'] });
  assert.equal(negoPages().length, 2, JSON.stringify(negoPages()));
  assert.equal(new Set(negoPages().map((l) => l.startDate)).size, 2);
});
// 'Jobs never request tabulation endpoints': see the L12 section at the end (it now runs the jobs)

// =========================== automatic mode: tender numbers come from My Messages ===========
const TODAY = () => new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
const nitMsg = (no, date = dmy(NOW()), title) => ({ date, subject: `NIT for STORES-PCMM/SOUTH EASTERN RLY, Tender Number: ${no}`, title });
const autoRun = (o = {}) => auto.runAutomatic({ from: TODAY(), to: TODAY(), ...o });
const futureT = (o) => T({ closing: new Date(NOW() + 30 * D), ...o });
const att = (n) => [{ name: n + '.pdf', desc: 'Annexure', href: `/ireps/upload/att/${n}.pdf` }];

test('extractTenderNumber: labelled formats only; numeric, alphanumeric, hyphen/leading-zero; never ids', () => {
  const x = msgs.extractTenderNumber;
  assert.equal(x('NIT for A/B RLY, Tender Number: 33263530A', '').tenderNo, '33263530A');
  assert.equal(x('', 'invited towards X, Tender No. 013-CWMLGDS-ET-2026-27 due on 12-Nov-2026').tenderNo, '013-CWMLGDS-ET-2026-27');
  assert.equal(x('Issue of Corrigendum towards S, Tender no: 29263265', 'A corrigendum ... Tender no: 29263265. Please').tenderNo, '29263265');
  assert.equal(x('NIT for A, Tender Number: 007', '').tenderNo, '007');
  assert.equal(x('PO 33261371102052 dated 28-SEP-26, Msg Id 5903361', '').status, 'NEEDS_REVIEW');
  assert.equal(x('Tender Number: 111', 'Tender No. 222 due').status, 'NEEDS_REVIEW'); // conflicting
  assert.equal(x('Tender Number: due', '').status, 'NEEDS_REVIEW'); // no digits
});
test('A1-A3. Numeric, alphanumeric (suffix) and hyphen/leading-zero tender numbers come from the messages; folders per spec; no tender number typed', async () => {
  const L = '013-CWMLGDS-ET-2026-27';
  mk({
    tenders: [futureT({ no: '29263265', nitId: '1', oid: '10', attachments: att('a1') }), futureT({ no: '33263530A', nitId: '2', oid: '20', attachments: att('a2') }), futureT({ no: L, nitId: '3', oid: '30', attachments: att('a3') })],
    messages: [nitMsg('29263265'), nitMsg('33263530A', undefined, 'Silent Block'), nitMsg(L)],
  });
  const r = await autoRun();
  assert.deepEqual(r.tenders.map((t) => t.tenderNo).sort(), [L, '29263265', '33263530A'].sort());
  assert.ok(r.tenders.every((t) => t.status === 'DOWNLOADED'));
  for (const [no, nit] of [['29263265', '1'], ['33263530A', '2'], [L, '3']]) {
    assert.ok(savedNames().includes(`DocLink/HOSUR/Tender_${no}/NIT_and_Supporting_Documents/viewNitPdf_${nit}.pdf`), no);
    assert.ok(savedNames().filter((n) => n.startsWith(`DocLink/HOSUR/Tender_${no}/NIT_and_Supporting_Documents/`)).length >= 2, no);
  }
  assert.equal(r.messages.opened, 3);
  assert.ok(server.log.filter((l) => l.path.endsWith('ViewMessageDetailAction.do')).every((l) => l.method === 'POST' && /^\d+$/.test(l.body.oid)));
  // the long number was searched by prefix and matched exactly
  assert.equal(server.log.find((l) => l.body.advancedSearch?.startsWith('013-CWML')).body.advancedSearch.length, 19);
});
test('A4-A5. Many NIT messages across several Inbox pages, duplicates of one tender processed once', async () => {
  mk({
    msgPageSize: 2,
    tenders: [futureT({ no: 'T1', nitId: '1', oid: '10' }), futureT({ no: 'T2', nitId: '2', oid: '20' }), futureT({ no: 'T3', nitId: '3', oid: '30' })],
    messages: [nitMsg('T1'), nitMsg('T2'), nitMsg('T1'), { date: dmy(NOW()), subject: 'Something else entirely' }, nitMsg('T3'), nitMsg('T2')],
  });
  const r = await autoRun();
  assert.equal(r.messages.pagesRead, 3);
  assert.deepEqual(r.tenders.map((t) => t.tenderNo).sort(), ['T1', 'T2', 'T3']);
  assert.equal(server.log.filter((l) => l.body.advancedSearch === 'T1').length >= 1, true);
  assert.equal(saved.filter((s) => /Tender_T1\/NIT_and_Supporting_Documents\/viewNitPdf_1\.pdf$/.test(s.filename)).length, 1);
  assert.equal(new Set(server.log.filter((l) => l.path.endsWith('ViewMessageDetailAction.do')).map((l) => l.body.oid)).size, 5); // 5 NIT messages opened once each
});
test('A6. A message without a confident tender number is NEEDS_REVIEW and starts no download', async () => {
  mk({ tenders: [futureT({ no: '123', nitId: '1', oid: '10' })], messages: [{ date: dmy(NOW()), subject: 'NIT for STORES, no number here' }, { date: dmy(NOW()), subject: 'NIT for STORES, Tender Number: 111', body: 'towards X, Tender No. 222 due on 12-Nov-2026' }] });
  const r = await autoRun();
  assert.equal(r.review.length, 2);
  assert.equal(r.tenders.length, 0);
  assert.equal(r.summary.needsReview, 2);
  assert.ok(!server.log.some((l) => l.body.advancedSearch));
  assert.equal(saved.filter((s) => !s.filename.endsWith('.json')).length, 0);
});
test('B1. Tender found only after widening the date range', async () => {
  mk({ tenders: [T({ no: 'OLD5', nitId: '5', oid: '50', closing: new Date(NOW() - 120 * D) })], messages: [nitMsg('OLD5')] });
  const r = await autoRun();
  assert.equal(r.tenders[0].status, 'DOWNLOADED');
  assert.ok(server.log.filter((l) => l.body.advancedSearch === 'OLD5').length > 1);
});
test('B2-B3. Multiple attachments, and a tender with none', async () => {
  mk({ tenders: [futureT({ no: 'M1', nitId: '1', oid: '10', attachments: [{ name: 'a.pdf', desc: 'A', href: '/ireps/upload/att/a.pdf' }, { name: 'b.pdf', desc: 'B', href: '/ireps/upload/att/b.pdf' }, { name: 'c.zip', desc: 'C', href: '/ireps/upload/att/c.zip' }] }), futureT({ no: 'N1', nitId: '2', oid: '20' })], messages: [nitMsg('M1'), nitMsg('N1')] });
  const r = await autoRun();
  assert.equal(r.tenders.find((t) => t.tenderNo === 'M1').categories.attachments.downloaded, 3);
  assert.equal(r.tenders.find((t) => t.tenderNo === 'N1').categories.attachments.status, 'NOT_AVAILABLE');
});
test('B4. An invalid PDF response is not saved; the message is retried on the next run, successes are not repeated', async () => {
  mk({ tenders: [futureT({ no: 'F1', nitId: '1', oid: '10' }), futureT({ no: 'G1', nitId: '2', oid: '20' })], messages: [nitMsg('F1'), nitMsg('G1')] });
  const orig = server.handle.bind(server);
  let broken = true;
  server.handle = async (m, u, b) => (broken && u.includes('viewNitPdf_1.pdf') ? { status: 200, type: 'text/html', bytes: new TextEncoder().encode('<html><title>Server busy</title><body>The document service is temporarily unavailable, please try again later.</body></html>') } : orig(m, u, b));
  const r1 = await autoRun();
  assert.equal(r1.tenders.find((t) => t.tenderNo === 'F1').status, 'FAILED');
  assert.equal(r1.tenders.find((t) => t.tenderNo === 'G1').status, 'DOWNLOADED');
  assert.ok(!savedNames().some((n) => /Tender_F1.*\.pdf$/.test(n)));
  broken = false;
  const before = saved.filter((s) => /NIT_G1/.test(s.filename)).length;
  const r2 = await autoRun();
  assert.equal(r2.tenders.find((t) => t.tenderNo === 'F1').status, 'DOWNLOADED');
  assert.ok(!r2.tenders.some((t) => t.tenderNo === 'G1')); // already handled: its message is not even re-opened
  assert.equal(saved.filter((s) => /NIT_G1/.test(s.filename)).length, before);
});
test('C. NIT Documents: corrigendum dated in range only; letters and correspondence are left to their own buttons; nothing unrelated', async () => {
  const today = dmy(NOW());
  mk({
    tenders: [futureT({ no: 'C1', nitId: '1', oid: '10', corrigenda: [{ id: '1', cn: '1', date: '01/09/2026 10:00' }, { id: '2', cn: '2', date: `${today} 10:00` }] }), futureT({ no: 'U1', nitId: '9', oid: '90', corrigenda: [{ id: '9', cn: '1', date: `${today} 09:00` }] })],
    messages: [{ date: today, subject: 'Issue of Corrigendum towards STORES/X RLY, Tender no: C1' }],
    inbox: {
      MyNegotiation: [{ no: 'N7', oid: '77', letter: '71', date: new Date(NOW()) }, { no: 'N8', oid: '88', letter: '81', date: new Date(NOW() - 10 * D) }],
      MyCounterOffer: [{ no: 'K7', oid: '66', letter: '61', date: new Date(NOW()) }],
      MyAdvanceAcceptanceLetter: [{ no: 'L7', oid: '55', letter: '51', date: new Date(NOW()) }],
    },
    corres: { 77: { nitOid: '77', tenderNo: 'N7', letters: [{ no: '1', id: '11', corresId: '21', subject: 'in range', date: today }, { no: '2', id: '12', corresId: '22', subject: 'old', date: '01/01/2020' }] } },
    letterAsPdf: true,
  });
  const r = await autoRun();
  const n = savedNames().map((x) => x.replace('DocLink/HOSUR/', ''));
  assert.ok(n.includes('Tender_C1/Corrigenda/Corrigendum_02_C1.pdf'));
  assert.ok(!n.some((x) => /Corrigendum_01_C1/.test(x))); // older corrigendum is not in the range
  assert.ok(!n.some((x) => x.includes('Tender_U1')));      // a tender with no message is unrelated
  // Negotiation / Counter Offer / LOA have their own buttons, correspondence its own view: none of it is read here
  assert.ok(!n.some((x) => /^Tender_(N7|N8|K7|L7)\/|\/(Negotiation|Counter_Offers|Advance_Acceptance_LOA|Correspondence)\//.test(x)), n.join('\n'));
  assert.ok(!server.log.some((l) => /MyNegotiation|MyCounterOffer|MyAdvanceAcceptanceLetter/.test(JSON.stringify(l.body) + JSON.stringify(l.query))), 'no Post Tenders letter list is read');
  assert.ok(!server.log.some((l) => l.path.startsWith('/epsn/corres/')), 'no correspondence page is read');
  assert.deepEqual(Object.keys(r).filter((k) => k === 'letters' || k === 'correspondence'), []);
  assert.ok(!server.log.some((l) => /vendorCorresSubmitReply|coResponse|negoBid|tabulation/i.test(JSON.stringify(l))));
});
test('C. No matching documents for the dates => nothing downloaded', async () => {
  mk({ tenders: [], messages: [{ date: '01/01/2020', subject: 'NIT for X, Tender Number: OLD' }], inbox: { MyNegotiation: [{ no: 'Z', oid: '1', letter: '1', date: new Date(NOW() - 30 * D) }], MyCounterOffer: [], MyAdvanceAcceptanceLetter: [] } });
  const r = await autoRun();
  assert.equal(r.summary.downloaded, 0); assert.equal(r.tenders.length, 0);
});
test('D. Another account (not Hosur) is used for the folder; the stored record keeps source message, dates and validation (no manifest file)', async () => {
  mk({ account: { id: '4711', company: 'ACME RAIL PRIVATE LIMITED-PUNE' }, tenders: [futureT({ no: 'P1', nitId: '1', oid: '10', attachments: att('p'), offer: true, offerAcct: '4711' })], messages: [nitMsg('P1', undefined, 'Title P1')] });
  const r = await autoRun();
  assert.ok(savedNames().some((n) => n.startsWith('DocLink/PUNE/Tender_P1/')));
  assert.ok(!savedNames().some((n) => n.includes('/HOSUR/')));
  assert.ok(savedNames().includes('DocLink/PUNE/Tender_P1/My_Offer/My_Offer_P1.pdf'));
  assert.ok(!savedNames().some((n) => /manifest/i.test(n)));
  const mf = store['doclink.tender.ledger.4711'].manifests.P1;
  assert.deepEqual([mf.account.irepsAccountId, mf.account.operatingUnit], ['4711', 'PUNE']);
  assert.equal(mf.tender.tenderNo, 'P1'); assert.ok(mf.tender.nitId);
  assert.equal(mf.sources.length, 1); assert.match(mf.sources[0].subject, /Tender Number: P1/);
  const f = mf.files.find((x) => x.category === 'ATTACHMENTS');
  assert.ok(f.title && f.downloadedAt && f.validation.kind === 'file' && f.validation.httpStatus === 200 && f.relPath);
  assert.ok(mf.runs[0].range.from && !/JSESSIONID|cookie|token/i.test(JSON.stringify(mf)));
});
test('E. Unauthenticated / expired session and unverified account stop the run', async () => {
  mk({ loggedIn: false });
  await assert.rejects(() => autoRun(), (e) => e.code === 'SESSION_EXPIRED');
  mk({ homeOverride: '<p>Welcome</p><a href="/epsn/home/logout.do">Log Out</a>' });
  await assert.rejects(() => autoRun(), (e) => e.code === 'ACCOUNT');
  assert.ok(!server.log.some((l) => l.path.includes('vendorInboxLink')));
});
test('F. Financial / Commercial Tabulation are not part of automatic mode (they have their own run)', async () => {
  mk({ tenders: [futureT({ no: 'X1', nitId: '1', oid: '10', offer: true })], messages: [nitMsg('X1')] });
  await autoRun();
  assert.ok(!server.excludedHit);
  assert.ok(server.log.filter((l) => l.path === '/epsn/tbo/commTboPdfAction.do').every((l) => (l.query.pdfType || l.body.pdfType) === 'offer'));
  assert.ok(!server.log.some((l) => l.body.status === 'MyBidsClosed'), 'Closed Tenders is not read');
});

// =========================== exclusions (24-26) =============================================
test('24-26. FIN-TAB / COM-TAB are fetched from the row; TECH-TAB is never invoked, even when listed on the row', async () => {
  mk({ tenders: [FULL()], inbox: letters('29263265') });
  const r = await run();
  assert.ok(!server.excludedHit);
  const types = server.log.filter((l) => l.path === '/epsn/tbo/commTboPdfAction.do').map((l) => l.query.pdfType || l.body.pdfType).sort();
  assert.deepEqual(types, ['commercialTabulation', 'financialTabulation', 'offer']);
  assert.equal(r.categories.myOffer.status, 'DOWNLOADED');
  assert.deepEqual(r.exclusions, ['Techno-Commercial Tabulation']);
  await assert.rejects(() => core.irepsFetch('https://www.ireps.gov.in', '/epsn/tbo/commTboPdfAction.do?pdfType=technoCommercialTabulation&tenderOID=1'), (e) => e.code === 'EXCLUDED');
});
// 'no password / cookie / token is stored': see the L12 section at the end (every tender file, and what is stored)

// =========================== Save to: ECM / S3 ==============================================
const tecm = await import('../tender-ecm.js');
const recon = await import('../../services/recon-service.js');
const ecmCfg = await import('../../services/ecm-config.js');
const ECM_URL = 'http://localhost:8000/api/ecm/documents';
const NUXEO = 'http://ecm.test:8080';
const CORRES = { 107200478: { nitOid: '107200478', tenderNo: '29263265', letters: [{ no: '306789', id: '306789', corresId: '225319', subject: 'Withdrawal' }, { no: '306790', id: '306790', corresId: '225320', subject: 'Clarif' }] } };

/** Run fn with the ECM gateway faked: respond(post, n) -> [status, body]. Records every upload. */
async function withEcm(respond, fn) {
  ecmCfg.applyEcmConfig({ ecmBackendAws: true });
  recon.applyReconConfig({ reconBaseUrl: 'http://localhost:8000' });
  chrome.runtime.getManifest = () => ({ host_permissions: ['http://localhost:8000/*'] });
  const prev = globalThis.fetch;
  const posts = [];
  globalThis.fetch = async (url, init = {}) => {
    if (String(url) !== ECM_URL) return prev(url, init);
    const f = init.body;
    const post = { kind: f.get('kind'), title: f.get('title'), fields: JSON.parse(f.get('fields')), account: f.get('ireps_account_id'), unit: f.get('operating_unit'), file: f.get('file').name, credentials: init.credentials };
    posts.push(post);
    const [status, body] = respond(post, posts.length);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  try {
    return await fn(posts);
  } finally {
    globalThis.fetch = prev;
    delete chrome.runtime.getManifest;
  }
}

/**
 * Run fn with ECM documents going straight to a fake ECM (Nuxeo) ("ecmBackendAws": false).
 * fn gets { creates, gateway, asked }: each created document, gateway calls, Recon sign-in asks.
 */
async function withDirectEcm(fn) {
  ecmCfg.applyEcmConfig({ ecmBackendAws: false, ecm: { env: 'TEST', domain: NUXEO, clientId: 'id', clientSecret: 'secret' } });
  chrome.runtime.getManifest = () => ({ host_permissions: [`${NUXEO}/*`, 'http://localhost:8000/*'] });
  const prev = globalThis.fetch;
  const prevDocument = globalThis.document;
  // creates: the new documents' properties; attaches: [title, file name] added to an existing document;
  // docs: uid -> { props, main, files } (main / files: { name, length }), what the ECM holds
  const seen = { creates: [], attaches: [], puts: [], gateway: [], asked: 0, docs: new Map() };
  // the panel's Recon sign-in page answers this event; count whether it is asked at all
  globalThis.document = { dispatchEvent: () => { seen.asked += 1; return true; } };
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  let uploaded = { name: '', length: 0 };
  const fileJson = (f) => ({ name: f.name, length: String(f.length) });
  const entry = (uid) => {
    const d = seen.docs.get(uid);
    return { uid, path: `/x/${uid}`, title: d.props['dc:title'], properties: { ...d.props, 'file:content': fileJson(d.main), 'files:files': d.files.map((f) => ({ file: fileJson(f) })) } };
  };
  const literal = (query, prop) => { const m = new RegExp(`${prop} = '((?:[^'\\\\]|\\\\.)*)'`).exec(query); return m ? m[1].replace(/\\(.)/g, '$1') : null; };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u === ECM_URL) seen.gateway.push(u);
    if (!u.startsWith(NUXEO)) return prev(url, init);
    const { pathname: path, searchParams } = new URL(u);
    const method = init.method || 'GET';
    if (path === '/nuxeo/oauth2/token') return json(200, { access_token: 'tok', expires_in: 3600 });
    if (path === '/nuxeo/api/v1/search/lang/NXQL/execute') {
      // a document of this type and title (and, for a single-file kind, this file name)
      const q = searchParams.get('query');
      const [type, title, file] = [literal(q, 'InvoiceCertificateSchema:type'), literal(q, 'dc:title'), literal(q, 'file:content/name')];
      const hits = title === null ? [] : [...seen.docs.keys()].filter((uid) => {
        const d = seen.docs.get(uid);
        return d.props['InvoiceCertificateSchema:type'] === type && d.props['dc:title'] === title && (file === null || d.main.name === file);
      });
      return json(200, { entries: hits.map(entry), isNextPageAvailable: false });
    }
    if (path === '/nuxeo/api/v1/upload') return json(201, { batchId: 'b' });
    if (path.endsWith('/execute/Blob.AttachOnDocument')) {
      const { document: uid, xpath } = JSON.parse(init.body).params;
      const d = seen.docs.get(uid);
      if (!d || xpath !== 'files:files') return json(404, { message: `no document ${uid}` });
      d.files.push({ ...uploaded });
      seen.attaches.push([d.props['dc:title'], uploaded.name]);
      return new Response(new Uint8Array(uploaded.length), { status: 200, headers: { 'content-type': 'application/pdf' } });
    }
    if (path.startsWith('/nuxeo/api/v1/upload/')) {
      uploaded = { name: decodeURIComponent(init.headers['X-File-Name'] || ''), length: init.body.length };
      return json(201, { uploaded: 'true' });
    }
    const [uid, blob] = decodeURIComponent(path.replace('/nuxeo/api/v1/id/', '')).split('/@blob/');
    if (method === 'GET') {
      // the read-back: the document, then the last byte of the file at `blob`
      if (seen.docs.has(uid)) return blob ? new Response(new Uint8Array(1), { status: 200 }) : json(200, entry(uid));
      return json(200, { uid, path: '/FT/folder' }); // the folder check
    }
    const body = JSON.parse(init.body);
    if (method === 'PUT') {
      seen.puts.push({ uid, ...body.properties });
      Object.assign(seen.docs.get(uid).props, body.properties);
      return json(200, entry(uid));
    }
    const { 'file:content': _, ...props } = body.properties;
    seen.creates.push({ folder: uid, ...body.properties });
    const created = `n-${seen.creates.length}`;
    seen.docs.set(created, { props, main: { ...uploaded }, files: [] });
    return json(201, { uid: created, path: `/x/${body.name}`, title: body.properties['dc:title'] });
  };
  try {
    return await fn(seen);
  } finally {
    globalThis.fetch = prev;
    if (prevDocument === undefined) delete globalThis.document;
    else globalThis.document = prevDocument;
    delete chrome.runtime.getManifest;
    ecmCfg.applyEcmConfig({ ecmBackendAws: true });
  }
}

test('ECM: account 833 is always HOSUR', () => {
  assert.equal(acct.parseWelcomeText('X Y , FAIVELEY TRANSPORT RAIL TECHNOLOGIES INDIA PRIVATE LIMITED-UNIT 1 (IREPS ID- 833)').operatingUnit, 'HOSUR');
  assert.equal(acct.parseWelcomeText('X Y , FAIVELEY TRANSPORT RAIL TECHNOLOGIES INDIA PRIVATE LIMITED (IREPS ID- 833)').operatingUnit, 'HOSUR');
});
test('ECM: each tender category maps to its ECM kind with the tender number and tender date; My Offer stays local', () => {
  const ctx = { tenderNo: '29263265', closingDate: '09/11/2026 15:00' };
  const doc = (category, action) => tecm.ecmDocumentFor(category, action, ctx);
  assert.deepEqual(doc('TENDER_PDF', { id: '5569207', meta: { title: 'NIT / Tender document' } }), { kind: 'nit', title: '29263265 - NIT', fields: { tender_number: '29263265', tender_date: '09/11/2026 15:00' } }, 'the closing date as IREPS shows it; ecmFields() makes it YYYY-MM-DD');
  assert.equal(doc('ATTACHMENTS', { id: 'Annexure', meta: { title: 'Annexure - SPEC' } }).title, '29263265 - NIT', 'grouped: an attachment goes into the tender\'s "<T> - NIT" document');
  assert.deepEqual([doc('CORRIGENDA', { id: '1204920', meta: { title: '1' } }).title, doc('NEGOTIATION', { id: '77' }).title, doc('COUNTER_OFFER', { id: '78' }).title, doc('CORRESPONDENCE', { id: '9', meta: { title: 'Withdrawal' } }).title], ['29263265 - Extension - 1', '29263265 - NBSP - 77', '29263265 - CO - 78', '29263265 - CRP - Withdrawal'], 'titles: <tender no> - <spec code> - what tells them apart');
  assert.equal(doc('ATTACHMENTS', { id: 'x', meta: {} }).kind, 'nit');
  assert.deepEqual([doc('CORRIGENDA', { id: '1204920', meta: { title: '1' } }).kind, doc('NEGOTIATION', { id: '1' }).kind, doc('COUNTER_OFFER', { id: '1' }).kind, doc('CORRESPONDENCE', { id: '1', meta: { title: 'Withdrawal' } }).kind], ['extension', 'nbsp', 'co', 'crp']);
  assert.deepEqual(doc('LOA', { id: '1461928', meta: { docDate: '04/10/2026' } }), { kind: 'loi', title: '29263265 - LOA', fields: { tender_number: '29263265', tender_date: '09/11/2026 15:00' } }, 'grouped: every LOA letter goes into "<T> - LOA"');
  assert.deepEqual(doc('FINANCIAL_TABULATION', { id: 'x' }), { kind: 'tenderResult', title: '29263265 - Result', fields: { tender_number: '29263265', tender_date: '09/11/2026 15:00' } }, 'the Financial Tabulation is the tender\'s Result (ECM type "Tender Result")');
  assert.deepEqual([doc('COMMERCIAL_TABULATION', { id: 'x' }).kind, doc('COMMERCIAL_TABULATION', { id: 'x' }).title], ['vct', '29263265 - Commercial Tabulation']);
  // the download check looks only single-file kinds up in the ECM (a grouped title says nothing about one PDF)
  assert.deepEqual(['TENDER_PDF', 'ATTACHMENTS', 'LOA', 'FINANCIAL_TABULATION'].map((c) => tecm.ecmCheckDocumentFor(c, { id: '1', meta: {} }, ctx)), [null, null, null, null]);
  assert.equal(tecm.ecmCheckDocumentFor('CORRIGENDA', { id: '1', meta: { title: '1' } }, ctx).title, '29263265 - Extension - 1');
  // in a grouped document file names tell the PDFs apart: an LOA letter always carries its id
  assert.equal(tecm.ecmFileName('LOA', 'LOA_29263265.pdf', '1461928'), 'LOA_29263265_1461928.pdf');
  assert.equal(tecm.ecmFileName('LOA', 'LOA_29263265_1461928.pdf', '1461928'), 'LOA_29263265_1461928.pdf', 'already there: unchanged');
  assert.equal(tecm.ecmFileName('LOA', 'LOA_29263265.pdf', ''), 'LOA_29263265.pdf');
  assert.equal(tecm.ecmFileName('ATTACHMENTS', 'Attachment_01_Spec.pdf', 'Spec'), 'Attachment_01_Spec.pdf', 'other categories keep their name');
  assert.equal(doc('MY_OFFER', { id: '1' }), null);
  assert.equal(tecm.ecmDocumentFor('NIT', {}, { tenderNo: 'T', dueDate: '' }), null);
  assert.deepEqual(tecm.ecmDocumentFor('TENDER_PDF', {}, { tenderNo: 'T', dueDate: new Date(2026, 10, 9).toISOString() }).fields, { tender_number: 'T', tender_date: '2026-11-09' }, 'without a closing date, the due date\'s local day');
  assert.deepEqual(tecm.ecmDocumentFor('TENDER_PDF', {}, { tenderNo: 'T' }).fields, { tender_number: 'T', tender_date: '' }, 'no date known: blank, which ecmFields() drops');
  assert.equal(tecm.ECM_TAKES_TENDER_DATE, true);
  // an NIT's published date: the day IREPS sent its NIT message (NIT Documents sets ctx.nitSentDate); NIT documents only
  const sent = { ...ctx, nitSentDate: '25/11/2026' };
  assert.deepEqual(tecm.ecmDocumentFor('TENDER_PDF', { id: '1' }, sent).fields, { tender_number: '29263265', tender_date: '09/11/2026 15:00', published_date: '25/11/2026' }, 'as IREPS shows it; ecmFields() makes it YYYY-MM-DD');
  assert.equal(tecm.ecmDocumentFor('ATTACHMENTS', { id: 'x', meta: {} }, sent).fields.published_date, '25/11/2026', 'an attachment carries it too: it fills in an NIT document that lacks it');
  assert.deepEqual(['CORRIGENDA', 'NEGOTIATION', 'COUNTER_OFFER', 'LOA', 'CORRESPONDENCE', 'FINANCIAL_TABULATION', 'COMMERCIAL_TABULATION'].filter((c) => 'published_date' in tecm.ecmDocumentFor(c, { id: '1', meta: { title: '1' } }, sent).fields), [], 'only NIT documents get it');
});
test('ECM: Save to Local (the default) never calls the ECM', async () => {
  mk({ tenders: [FULL()] });
  await withEcm(() => [201, {}], async (posts) => {
    await run();
    assert.equal(posts.length, 0);
    assert.ok(savedNames().some((n) => n.endsWith('viewNitPdf_5569207.pdf')));
  });
});
test('ECM gateway: Save to ECM / S3 files the single-file tender documents in the Hosur folder; NIT, LOA and Result (one document per tender, direct ECM only) and My Offer stay local', async () => {
  mk({ tenders: [FULL()], inbox: letters('29263265'), letterAsPdf: true, corres: CORRES });
  store['doclink.saveDestination'] = 'recon';
  await withEcm((p, n) => [201, { uid: `u-${n}`, path: `/FT/x/${n}`, title: p.title, site: 'hosur', deduplicated: false }], async (posts) => {
    const r = await run();
    const c = r.categories;
    assert.equal(r.summary.failed, 0);
    const kinds = posts.reduce((m, p) => ({ ...m, [p.kind]: (m[p.kind] || 0) + 1 }), {});
    assert.deepEqual(kinds, { extension: 2, nbsp: 2, co: 1, crp: 2, vct: 1 }, 'the gateway cannot add PDFs to a document: no nit / loi / tenderResult is posted');
    assert.deepEqual(posts.filter((p) => p.kind === 'vct').map((p) => p.title), ['29263265 - Commercial Tabulation']);
    assert.ok(posts.every((p) => p.account === '833' && p.unit === 'HOSUR' && p.fields.tender_number === '29263265' && p.credentials === 'include'));
    assert.ok(posts.every((p) => Object.keys(p.fields).join() === 'tender_number,tender_date' && p.fields.tender_date === '2026-11-09'), `the tender number and closing date: ${JSON.stringify(posts.map((p) => p.fields))}`);
    assert.equal(new Set(posts.map((p) => p.title)).size, posts.length, 'every title is unique within the tender');
    const local = savedNames().map((x) => x.replace('DocLink/HOSUR/Tender_29263265/', ''));
    // nothing the gateway took is in Downloads; My Offer (no ECM kind) is, and no manifest file is
    assert.ok(local.includes('My_Offer/My_Offer_29263265.pdf') && !local.some((n) => /manifest/i.test(n)));
    assert.ok(!local.some((n) => /^(Negotiation|Counter_Offers|Correspondence)\//.test(n)), local.join('\n'));
    assert.ok(local.includes('Corrigenda/Corrigendum_02_29263265.html'), 'without Chrome printing, a corrigendum page keeps its original HTML locally');
    // the grouped kinds: saved locally, with the reason
    for (const want of ['NIT_and_Supporting_Documents/viewNitPdf_5569207.pdf', 'Advance_Acceptance_LOA/LOA_29263265.pdf']) assert.ok(local.includes(want), `missing ${want}`);
    for (const f of [c.tenderPdf.files[0], ...c.attachments.files, c.loa.files[0], c.financialTabulation.files[0]]) {
      assert.deepEqual([f.ecm.status, f.ecm.code], ['failed', 'ECM_REJECTED'], f.fileName);
      assert.match(f.ecm.detail, /need the direct ECM upload/);
      assert.ok(f.relPath, `${f.fileName} is saved locally`);
    }
    assert.equal(c.myOffer.files[0].ecm, undefined);
    const co = posts.find((p) => p.kind === 'co');
    assert.equal(c.counterOffer.files[0].ecm.uid, `u-${posts.indexOf(co) + 1}`, 'the result records where each document went');
  });
});
test('ECM: a corrigendum\'s attached document is filed next to it as "<tender> - Extension - <corrigendum> - Attachment N"', async () => {
  mk({ tenders: [ATT_CORR(['Revised_Spec.pdf'])] });
  store['doclink.saveDestination'] = 'recon';
  fakeDebugger();
  try {
    await withEcm((p, n) => [201, { uid: `u-${n}`, path: `/FT/x/${n}`, title: p.title, site: 'hosur', deduplicated: false }], async (posts) => {
      const c = (await run('29263265', { only: ['corrigenda'] })).categories.corrigenda;
      assert.deepEqual(posts.map((p) => [p.kind, p.title, p.file]), [
        ['extension', '29263265 - Extension - Corrigendum - 2', 'Corrigendum_02_29263265.pdf'],
        ['extension', '29263265 - Extension - Corrigendum - 2 - Attachment 1', 'Revised_Spec.pdf'],
      ]);
      assert.ok(c.files.every((f) => f.ecm?.status === 'stored'));
      assert.equal(saved.length, 0, 'nothing local');
    });
  } finally {
    withoutDebugger();
  }
});
test('ECM: when the ECM refuses or is down, each document is saved locally instead and the reason is kept', async () => {
  mk({ tenders: [FULL()], inbox: letters('29263265'), letterAsPdf: true, corres: CORRES });
  store['doclink.saveDestination'] = 'recon';
  await withEcm((p) => (p.kind === 'crp' ? [400, { detail: { error: 'INVALID_INPUT', detail: 'crp requires tender_number' } }] : [502, { detail: { error: 'ECM_UPSTREAM_ERROR', detail: 'HTTP 500' } }]), async (posts) => {
    const r = await run();
    assert.equal(r.summary.failed, 0, 'nothing is lost');
    assert.equal(posts.length, 8, 'the single-file kinds; NIT, LOA and Result never reach the gateway');
    const local = savedNames().map((x) => x.replace('DocLink/HOSUR/Tender_29263265/', ''));
    for (const want of ['NIT_and_Supporting_Documents/viewNitPdf_5569207.pdf', 'Advance_Acceptance_LOA/LOA_29263265.pdf', 'Correspondence/Correspondence_29263265_306789.pdf']) assert.ok(local.includes(want), `missing ${want}:\n${local.join('\n')}`);
    assert.ok(local.some((n) => /^Negotiation\//.test(n)), 'the gateway being down: saved locally');
    const crp = r.categories.correspondence.files[0];
    assert.deepEqual([crp.ecm.status, crp.ecm.code, crp.ecm.detail], ['failed', 'ECM_REJECTED', 'crp requires tender_number']);
    assert.equal(r.categories.negotiation.files[0].ecm.code, 'ECM_UNAVAILABLE');
  });
});
test('ECM direct: with ecmBackendAws false every tender document goes straight to the Hosur TEST Tenders folder, NIT / LOA / Result as one document each with the PDFs inside, without the Recon sign-in', async () => {
  mk({ tenders: [FULL()], inbox: letters('29263265'), letterAsPdf: true, corres: CORRES });
  store['doclink.saveDestination'] = 'recon';
  await withDirectEcm(async ({ creates, attaches, docs, gateway }) => {
    const r = await run();
    const c = r.categories;
    assert.equal(r.summary.failed, 0);
    assert.equal(gateway.length, 0, 'the Recon Engine gateway is not called');
    const kinds = creates.reduce((m, p) => ({ ...m, [p['InvoiceCertificateSchema:type']]: (m[p['InvoiceCertificateSchema:type']] || 0) + 1 }), {});
    assert.deepEqual(kinds, { nit: 1, loi: 1, tenderResult: 1, extension: 2, nbsp: 2, co: 1, crp: 2, vct: 1 }, 'one NIT, one LOA and one Result document for the tender');
    assert.ok(creates.every((p) => p.folder === 'aa28acbe-add1-49d3-b0ab-16ab1263996c' && p['InvoiceCertificateSchema:tenderNumber'] === '29263265'));
    const byTitle = (title) => [...docs.values()].find((d) => d.props['dc:title'] === title);
    // "<T> - NIT": the tender PDF is the main file (the attachments wait for it), the attached documents its attachments
    const nit = byTitle('29263265 - NIT');
    assert.equal(nit.main.name, 'viewNitPdf_5569207.pdf', 'the IREPS name, in the ECM too');
    assert.equal(nit.files.length, 4);
    assert.deepEqual(nit.files.map((f) => f.name).sort(), ['5595304.pdf', '5595313.pdf', 'Annexure.pdf', 'drawing.zip'], 'the attachments keep their IREPS names');
    assert.deepEqual(attaches.map(([title]) => title), Array(4).fill('29263265 - NIT'), 'only the NIT document had more than one PDF');
    assert.ok(c.attachments.files.every((f) => f.ecm.status === 'stored' && f.ecm.uid === c.tenderPdf.files[0].ecm.uid), 'every attachment is in the NIT document');
    // "<T> - LOA": the letter id in the file name, so a later letter cannot clash with it
    assert.equal(byTitle('29263265 - LOA').main.name, 'LOA_29263265_1461928.pdf');
    // "<T> - Result": the Financial Tabulation, type tenderResult ("Tender Result")
    const result = byTitle('29263265 - Result');
    assert.deepEqual([result.props['InvoiceCertificateSchema:type'], result.main.name], ['tenderResult', 'Financial_Tabulation_29263265.pdf']);
    assert.equal(byTitle('29263265 - Commercial Tabulation').props['InvoiceCertificateSchema:type'], 'vct');
    // the properties the TEST ECM's InvoiceCertificateSchema has (anything else: HTTP 400 "No such property")
    const props = new Set(['dc:title', 'file:content', 'InvoiceCertificateSchema:type', 'InvoiceCertificateSchema:tenderNumber', 'InvoiceCertificateSchema:tenderDate']);
    assert.ok(creates.every((p) => Object.keys(p).filter((k) => k !== 'folder').every((k) => props.has(k))), JSON.stringify(creates[0]));
    assert.ok(creates.every((p) => p['InvoiceCertificateSchema:tenderDate'] === '2026-11-09'), `the tender date on every document: ${JSON.stringify(creates.map((p) => p['InvoiceCertificateSchema:tenderDate']))}`);
    assert.equal(r.categories.tenderPdf.files[0].ecm.status, 'stored');
    assert.equal(r.categories.tenderPdf.files[0].ecm.uid.startsWith('n-'), true);
    const local = savedNames().map((x) => x.replace('DocLink/HOSUR/Tender_29263265/', ''));
    assert.ok(local.includes('My_Offer/My_Offer_29263265.pdf'));
    assert.ok(!local.some((n) => /^NIT_and_Supporting_Documents\//.test(n)), 'nothing that went to the ECM is in Downloads');
  });
  const asked = await withDirectEcm(async (seen) => seen.asked);
  assert.equal(asked, 0, 'no Recon sign-in asked in direct mode');
});
test('ECM direct, NIT Documents: the NIT document carries its published date, the day IREPS sent the NIT message (the first of two; never a corrigendum message\'s day)', async () => {
  const day = (back) => new Date(TODAY().getFullYear(), TODAY().getMonth(), TODAY().getDate() - back);
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  mk({ tenders: [futureT({ no: 'P7', nitId: '7', oid: '70', attachments: att('p7') })], messages: [
    nitMsg('P7', dmy(day(0).getTime())),
    { date: dmy(day(2).getTime()), subject: 'Issue of Corrigendum towards STORES-PCMM/SOUTH EASTERN RLY, Tender no: P7' },
    nitMsg('P7', dmy(day(1).getTime())),
  ] });
  store['doclink.saveDestination'] = 'recon';
  await withDirectEcm(async ({ creates, attaches, puts }) => {
    const r = await autoRun({ from: day(2) });
    assert.equal(r.tenders.length, 1, 'one tender: its NIT and corrigendum messages');
    assert.equal(r.tenders[0].categories.tenderPdf.status, 'DOWNLOADED');
    const nits = creates.filter((p) => p['InvoiceCertificateSchema:type'] === 'nit');
    assert.deepEqual(nits.map((p) => [p['dc:title'], p['InvoiceCertificateSchema:publishedDate']]), [['P7 - NIT', iso(day(1))]], 'IREPS sent the NIT message twice: the day it first did, not the earlier corrigendum message\'s');
    assert.deepEqual(Object.keys(nits[0]).filter((k) => k !== 'folder').sort(), ['InvoiceCertificateSchema:publishedDate', 'InvoiceCertificateSchema:tenderDate', 'InvoiceCertificateSchema:tenderNumber', 'InvoiceCertificateSchema:type', 'dc:title', 'file:content']);
    assert.deepEqual(attaches.map(([title]) => title), ['P7 - NIT'], 'the attachment goes into it');
    assert.equal(puts.length, 0, 'the document has the date from its first PDF');
  });
});
test('ECM direct, NIT Documents: an NIT document stored before the ECM had the published date is still found, and the next PDF fills the date in', async () => {
  mk({ tenders: [futureT({ no: 'P8', nitId: '8', oid: '80', attachments: att('p8') })], messages: [nitMsg('P8')] });
  store['doclink.saveDestination'] = 'recon';
  await withDirectEcm(async ({ creates, attaches, puts, docs }) => {
    docs.set('old-1', { props: { 'dc:title': 'P8 - NIT', 'InvoiceCertificateSchema:type': 'nit', 'InvoiceCertificateSchema:tenderNumber': 'P8', 'InvoiceCertificateSchema:tenderDate': '2026-01-05' }, main: { name: 'older.pdf', length: 10 }, files: [] });
    const r = await autoRun();
    assert.equal(r.tenders[0].status, 'DOWNLOADED');
    assert.equal(creates.length, 0, 'no second "P8 - NIT" document');
    assert.deepEqual(attaches.map(([title]) => title), ['P8 - NIT', 'P8 - NIT']);
    const t = TODAY();
    assert.deepEqual(puts, [{ uid: 'old-1', 'InvoiceCertificateSchema:publishedDate': `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}` }], 'only what it lacked: the tender date it has stays');
  });
});
test('ECM direct: when IREPS serves the tender PDF last, it is still the main file of "<T> - NIT" (the attachments wait for it)', async () => {
  mk({ tenders: [FULL()] });
  store['doclink.saveDestination'] = 'recon';
  const orig = server.handle.bind(server);
  server.handle = async (m, u, b) => {
    if (/viewNitPdf_\d+\.pdf$/.test(new URL(u, 'http://x').pathname)) await new Promise((r) => setTimeout(r, 300));
    return orig(m, u, b);
  };
  await withDirectEcm(async ({ creates, docs }) => {
    const r = await run('29263265', { only: ['tenderPdf', 'attachments'] });
    assert.equal(r.summary.failed, 0);
    assert.equal(creates.length, 1);
    const nit = [...docs.values()][0];
    assert.equal(nit.main.name, 'viewNitPdf_5569207.pdf', 'the IREPS name, in the ECM too');
    assert.equal(nit.files.length, 4);
  });
});
test('ECM: letters by date go to the ECM with the tender number and the tender date IREPS search finds (blank when it finds no tender)', async () => {
  const at = (n) => new Date(NOW() - n * D);
  const closing = new Date(NOW() - 3 * D);
  mk({
    tenders: [T({ no: 'LOA3', nitId: '31', oid: '310', closing }), T({ no: 'NEG1', nitId: '11', oid: '110', closing })],
    inbox: {
      MyNegotiation: [{ no: 'NEG1', oid: '5001', letter: '11', date: at(0) }, { no: 'NEG1', oid: '5001', letter: '12', date: at(0) }],
      MyCounterOffer: [{ no: 'GONE', oid: '5007', letter: '21', date: at(0) }],
      MyAdvanceAcceptanceLetter: [{ no: 'LOA3', oid: '5003', letter: '31', date: at(0) }],
    },
    letterAsPdf: true,
  });
  store['doclink.saveDestination'] = 'recon';
  await withEcm((p, n) => [201, { uid: `u-${n}`, path: '/x', title: p.title, site: 'hosur', deduplicated: false }], async (posts) => {
    const r = await jobs.downloadLettersByDate();
    assert.equal(r.summary.newLetters, 4);
    assert.deepEqual(posts.map((p) => p.kind).sort(), ['co', 'nbsp', 'nbsp'], 'the LOA ("<T> - LOA", one document per tender) needs the direct ECM upload');
    const day = `${closing.getFullYear()}-${String(closing.getMonth() + 1).padStart(2, '0')}-${String(closing.getDate()).padStart(2, '0')}`;
    assert.ok(posts.filter((p) => p.kind === 'nbsp').every((p) => p.fields.tender_date === day), 'NEG1\'s closing date');
    assert.deepEqual(posts.find((p) => p.kind === 'co').fields, { tender_number: 'GONE' }, 'a tender IREPS search does not find: no tender date, still uploaded');
    assert.ok(posts.every((p) => p.account === '833' && p.unit === 'HOSUR'));
    assert.ok(server.log.filter((l) => l.path === '/epsn/search/advancedSearch.do').length > 0, 'the tender is searched for its closing date (once per tender)');
    assert.ok(!savedNames().some((n) => /\/(Negotiation|Counter_Offers)\//.test(n)), 'nothing that went to the ECM is in Downloads');
    assert.ok(savedNames().some((n) => /\/Advance_Acceptance_LOA\//.test(n)), 'the LOA is saved locally instead');
  });
});
test('ECM direct: an LOA letter found on a later day goes into the tender\'s "<T> - LOA" document as an attachment, with the tender date', async () => {
  const at = (n) => new Date(NOW() - n * D);
  const closing = new Date(NOW() - 3 * D);
  const day = `${closing.getFullYear()}-${String(closing.getMonth() + 1).padStart(2, '0')}-${String(closing.getDate()).padStart(2, '0')}`;
  const withLetters = (...letterIds) => mk({
    tenders: [T({ no: 'LOA3', nitId: '31', oid: '310', closing })],
    inbox: { MyAdvanceAcceptanceLetter: letterIds.map((letter) => ({ no: 'LOA3', oid: '5003', letter, date: at(0) })) },
    letterAsPdf: true,
  });
  await withDirectEcm(async ({ creates, attaches, docs }) => {
    withLetters('31');
    store['doclink.saveDestination'] = 'recon';
    await jobs.downloadLettersByDate();
    assert.deepEqual(creates.map((p) => [p['InvoiceCertificateSchema:type'], p['dc:title'], p['InvoiceCertificateSchema:tenderDate']]), [['loi', 'LOA3 - LOA', day]]);
    // a second letter, alone in a later run: locally "LOA_LOA3.pdf" again, in the ECM its own name
    withLetters('32');
    store['doclink.saveDestination'] = 'recon';
    await jobs.downloadLettersByDate();
    assert.equal(creates.length, 1, 'no second LOA document');
    assert.deepEqual(attaches, [['LOA3 - LOA', 'LOA_LOA3_32.pdf']]);
    const loa = [...docs.values()][0];
    assert.deepEqual([loa.main.name, ...loa.files.map((f) => f.name)], ['LOA_LOA3_31.pdf', 'LOA_LOA3_32.pdf']);
  });
});
test('ECM: the correspondence page\'s Closing Date fills the tender date when the run did not search the tender', () => {
  const doc = new JSDOM(new TextDecoder().decode(corresPage({ nitOid: '1', tenderNo: 'X1', letters: [] }))).window.document;
  assert.equal(wf.pageClosingDate(doc), '09/09/2026');
  assert.equal(wf.pageClosingDate(new JSDOM('<table><tr><td>Tender No</td><td>X</td></tr></table>').window.document), '');
});

// =========================== 13 Nov 2026 meeting: the ECM fields the client asked for ============
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dmyDay = (d) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
test('ECM (13 Nov meeting): an LOA carries its LOA number and LOA date, built from its list row', () => {
  const ctx = { tenderNo: '61265711C', closingDate: '12/11/2026 11:00' };
  const loa = { id: '1503282', unit: 'DAHOD / WESTERN RLY', meta: { docDate: '12/11/2026' } };
  const fields = (action = loa, category = 'LOA') => tecm.ecmDocumentFor(category, action, ctx).fields;
  assert.deepEqual(fields(), { tender_number: '61265711C', tender_date: '12/11/2026 11:00', loi_number: 'DAHOD / 61265711C / 1503282', loi_date: '12/11/2026' },
    'the number as IREPS prints it on the letter: "Letter No: DAHOD / 61265711C / 1503282 Dated: 12/11/2026"');
  assert.equal(fields({ ...loa, unit: 'TRS/ELS/HWH-STORES / EASTERN RLY' }).loi_number, 'TRS/ELS/HWH-STORES / 61265711C / 1503282', 'a department with slashes of its own');
  assert.equal(fields({ ...loa, unit: '  BCT DIVISION-STORES /\n WESTERN RLY ' }).loi_number, 'BCT DIVISION-STORES / 61265711C / 1503282', 'the cell\'s line breaks and spaces');
  for (const [why, action] of [['no unit', { ...loa, unit: '' }], ['a unit without " / "', { ...loa, unit: 'ICF' }], ['no Letter Date', { ...loa, meta: {} }], ['no letter id', { ...loa, id: '' }]]) {
    assert.deepEqual(Object.keys(fields(action)), ['tender_number', 'tender_date'], `${why}: neither the number nor the date`);
  }
  assert.deepEqual(fields({ id: '232721', unit: 'KGP DIV / SOUTH EASTERN RLY', meta: { docDate: '07/11/2026' } }, 'NEGOTIATION'), { tender_number: '61265711C', tender_date: '12/11/2026 11:00' }, 'only LOA documents get them');
});
test('LOA list (13 Nov meeting): the "Dept/Rly. Unit" column is found by its header in the page as IREPS sends it (the header row left open)', () => {
  // the markup of the 22 Oct 2026 capture ("Response LOI.txt"), other values
  const page = `<table width="100%" class="nit_summary"><tr><td colspan="5">&nbsp;</td></tr> <tr bgcolor="#E9E9EF"> <td width="15%"><strong>Dept/Rly. Unit</strong></td> <td><strong>Tender No. </strong></td> <td><strong>Tender Title</strong></td> <td><strong>Letter Date (LetterId)</strong></td> <td><strong>LOA Status</strong></td> <td><strong>Actions</strong></td> <tr> <td width="15%" style="color: black">RATLAM-DIV / WESTERN RLY</td><td><a class="linkStyle" title="To View NIT Click the NIT No" href="#" onclick=postRequest('/epsn/works/rfq/nitPublish.do?activity=viewNIT&nitId=1')>83260001</a></td> <td>ITEM </td> <td nowrap="nowrap">10/09/2026 18:33&nbsp;(1461928)</td><td>Published</td><td>v</td></tr></table>`;
  const doc = new JSDOM(page).window.document;
  const col = wf.listColumn(doc, /^Dept\/Rly\.?\s*Unit$/i);
  assert.equal(col, 0);
  const row = [...doc.querySelectorAll('tr')].find((tr) => tr.querySelector('a'));
  assert.equal(core.norm([...row.children][col].textContent), 'RATLAM-DIV / WESTERN RLY');
  assert.equal(wf.listColumn(new JSDOM('<table><tr><td>Tender No</td><td>Dept</td></tr></table>').window.document, /^Dept\/Rly\.?\s*Unit$/i), -1, 'no such header: -1, the unit is then unknown');
});
test('ECM direct (13 Nov meeting): the "<T> - LOA" document gets the LOA number and date from the LOA list row; a list without a "Dept/Rly. Unit" column sends neither', async () => {
  const letterDay = new Date(NOW());
  const closing = new Date(NOW() - 3 * D);
  const scenario = (liveInbox) => {
    mk({
      tenders: [T({ no: 'LOA3', nitId: '31', oid: '310', closing })],
      inbox: { MyAdvanceAcceptanceLetter: [{ no: 'LOA3', oid: '5003', letter: '1503282', date: letterDay, unit: 'DAHOD / WESTERN RLY' }] },
      letterAsPdf: true,
      liveInbox,
    });
    store['doclink.saveDestination'] = 'recon';
  };
  const props = (creates) => creates.map((p) => [p['dc:title'], p['InvoiceCertificateSchema:tenderDate'], p['InvoiceCertificateSchema:loiNumber'], p['InvoiceCertificateSchema:loiDate']]);
  scenario(true);
  await withDirectEcm(async ({ creates }) => {
    await jobs.downloadLettersByDate();
    assert.deepEqual(props(creates), [['LOA3 - LOA', isoDay(closing), 'DAHOD / LOA3 / 1503282', isoDay(letterDay)]], 'the list as IREPS sends it (22 Oct 2026 capture)');
  });
  scenario(false);
  await withDirectEcm(async ({ creates }) => {
    await jobs.downloadLettersByDate();
    assert.deepEqual(props(creates), [['LOA3 - LOA', isoDay(closing), undefined, undefined]], 'no "Dept/Rly. Unit" header: the LOA document as before');
  });
});
test('Tender search (13 Nov meeting): when two railways use one tender number, the letter\'s railway or the NIT message\'s due date picks the tender; a hint no row fits changes nothing', async () => {
  const nf = new Date(NOW() + 10 * D);
  const ec = new Date(NOW() + 40 * D);
  mk({ tenders: [T({ no: '10263703', nitId: '71', oid: '710', dept: 'STORES/N F RLY', closing: nf }), T({ no: '10263703', nitId: '72', oid: '720', dept: 'STORES/EAST CENTRAL RLY', closing: ec })] });
  const find = async (prefer) => (await search.searchTender('https://www.ireps.gov.in', '10263703', { prefer })).closingDate;
  assert.match(await find({}), new RegExp(`^${dmyDay(nf)}`), 'no hint: the first of two equal rows, as before');
  assert.match(await find({ railway: 'TRS-GMO-STORES / EAST CENTRAL RLY' }), new RegExp(`^${dmyDay(ec)}`));
  assert.match(await find({ railway: 'KATIHAR / N F RLY' }), new RegExp(`^${dmyDay(nf)}`));
  assert.match(await find({ dueDate: new Date(ec.getFullYear(), ec.getMonth(), ec.getDate(), 14, 0) }), new RegExp(`^${dmyDay(ec)}`));
  assert.match(await find({ railway: 'STORES / WESTERN RLY' }), new RegExp(`^${dmyDay(nf)}`), 'a railway no row has: as without a hint');
  assert.equal(search.railwayOf('LOWER PAREL/WESTERN RLY'), search.railwayOf('DAHOD / WESTERN RLY'));
});
test('Tender search (6.5): the railway or due-date hint picks between the tenders of every date window with the number; a first window that fits sends no further search', async () => {
  const nf = new Date(NOW() + 10 * D); // in the first window searched (-90 .. 90 days)
  const ec = new Date(NOW() + 200 * D); // only in the second (90 .. 270 days)
  mk({ tenders: [T({ no: '10263703', nitId: '71', oid: '710', dept: 'STORES/N F RLY', closing: nf }), T({ no: '10263703', nitId: '72', oid: '720', dept: 'STORES/EAST CENTRAL RLY', closing: ec })] });
  const find = async (prefer) => {
    server.log.length = 0;
    const r = await search.searchTender('https://www.ireps.gov.in', '10263703', { prefer });
    return { day: r.closingDate.slice(0, 10), nitId: core.qparam(r.row.actions.flatMap((a) => a.urls).find((u) => /nitPublish/.test(u)) || '', 'nitId'),
      searches: server.log.filter((l) => l.path === '/epsn/search/advancedSearch.do' && l.method === 'POST' && 'advancedSearch' in l.body).length };
  };
  assert.deepEqual(await find({ railway: 'TRS-GMO-STORES / EAST CENTRAL RLY' }), { day: dmyDay(ec), nitId: '72', searches: 2 }, 'the first window has only the N F RLY tender: the next window is searched too, and its EAST CENTRAL RLY tender taken');
  assert.deepEqual(await find({ railway: 'KATIHAR / N F RLY' }), { day: dmyDay(nf), nitId: '71', searches: 1 }, 'the first window fits: no further search');
  assert.deepEqual(await find({}), { day: dmyDay(nf), nitId: '71', searches: 1 }, 'no hint: the first window\'s tender, as before');
  assert.deepEqual(await find({ dueDate: new Date(ec.getFullYear(), ec.getMonth(), ec.getDate(), 14, 0) }), { day: dmyDay(ec), nitId: '72', searches: 2 }, 'the NIT message\'s due date, found in the one window that holds that day');
  assert.deepEqual(await find({ railway: 'KATIHAR / N F RLY', dueDate: new Date(ec.getFullYear(), ec.getMonth(), ec.getDate(), 14, 0) }), { day: dmyDay(nf), nitId: '71', searches: 2 },
    'the railway weighs more than the due date: only the window holding the due day is searched for a row of both, and the N F RLY tender is kept');
  // a hint no tender fits: every window is searched (IREPS answering "no results" twice in a window with none: Stores,
  // then all departments), and the first window's tender is taken, as without a hint
  assert.deepEqual(await find({ railway: 'STORES / WESTERN RLY' }), { day: dmyDay(nf), nitId: '71', searches: 10 });
});
test('ECM (13 Nov meeting): letters by date take the tender date of the letter\'s own railway when another railway uses the tender number', async () => {
  const nf = new Date(NOW() - 20 * D);
  const ec = new Date(NOW() - 5 * D);
  mk({
    tenders: [T({ no: '10263703', nitId: '71', oid: '710', dept: 'STORES/N F RLY', closing: nf }), T({ no: '10263703', nitId: '72', oid: '720', dept: 'STORES/EAST CENTRAL RLY', closing: ec })],
    inbox: { MyNegotiation: [{ no: '10263703', oid: '5001', letter: '11', date: new Date(NOW()), unit: 'DEMU-SEE-STORES / EAST CENTRAL RLY' }] },
    letterAsPdf: true,
    liveInbox: true,
  });
  store['doclink.saveDestination'] = 'recon';
  await withEcm((p, n) => [201, { uid: `u-${n}`, path: '/x', title: p.title, site: 'hosur', deduplicated: false }], async (posts) => {
    await jobs.downloadLettersByDate();
    assert.deepEqual(posts.map((p) => [p.kind, p.fields.tender_date]), [['nbsp', isoDay(ec)]]);
  });
});
test('Automatic mode (13 Nov meeting): when two railways use one tender number, the NIT message\'s due date picks the tender whose NIT is downloaded', async () => {
  const other = new Date(NOW() + 10 * D);
  const due = new Date(NOW() + 40 * D);
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][due.getMonth()];
  const body = `Dear Sir/Madam, <br><br>Your attention is invited towards X, Tender No. 10263703 due on ${String(due.getDate()).padStart(2, '0')}-${mon}-${due.getFullYear()} 14:00 IST for <i>'Magnet coil'</i>.<br><br>Thanks`;
  mk({
    tenders: [futureT({ no: '10263703', nitId: '71', oid: '710', dept: 'STORES/N F RLY', closing: other, attachments: att('d71') }), futureT({ no: '10263703', nitId: '72', oid: '720', dept: 'STORES/EAST CENTRAL RLY', closing: due, attachments: att('d72') })],
    messages: [{ ...nitMsg('10263703'), body }],
  });
  const r = await autoRun();
  assert.equal(r.tenders[0].status, 'DOWNLOADED');
  const nit = savedNames().filter((n) => n.includes('/Tender_10263703/NIT_and_Supporting_Documents/viewNitPdf_'));
  assert.deepEqual(nit.map((n) => n.split('/').pop()), ['viewNitPdf_72.pdf'], 'the EAST CENTRAL RLY tender, due on the message\'s date');
});
test('Automatic mode (6.1): two railways\' NIT messages with one tender number are two tenders, each opened with its railway; the NIT of one does not make the other "already downloaded"', async () => {
  // the subjects as IREPS writes them (27 Oct 2026 capture: "NIT for CSD/PER/SOUTHERN RLY, Tender Number: 78266659")
  const msg = (railway) => ({ date: dmy(NOW()), subject: `NIT for STORES/${railway}, Tender Number: 10263703` });
  const twoRailways = [futureT({ no: '10263703', nitId: '71', oid: '710', dept: 'STORES/N F RLY', closing: new Date(NOW() + 10 * D), attachments: att('d71') }), futureT({ no: '10263703', nitId: '72', oid: '720', dept: 'STORES/EAST CENTRAL RLY', closing: new Date(NOW() + 40 * D), attachments: att('d72') })];
  const nitPdfs = () => savedNames().filter((n) => /\/Tender_10263703\/NIT_and_Supporting_Documents\/viewNitPdf_/.test(n)).map((n) => n.split('/').pop()).sort();
  mk({ tenders: twoRailways, messages: [msg('N F RLY'), msg('EAST CENTRAL RLY')] });
  const both = await autoRun();
  assert.deepEqual(both.tenders.map((t) => [t.tenderNo, t.railwayUnit, t.status]), [['10263703', 'STORES/N F RLY', 'DOWNLOADED'], ['10263703', 'STORES/EAST CENTRAL RLY', 'DOWNLOADED']]);
  assert.notEqual(both.tenders[0].key, both.tenders[1].key);
  assert.deepEqual(nitPdfs(), ['viewNitPdf_71.pdf', 'viewNitPdf_72.pdf'], 'each railway\'s own NIT');
  // the N F RLY NIT first; the EAST CENTRAL RLY message arrives later: its NIT is still downloaded
  mk({ tenders: twoRailways, messages: [msg('N F RLY')] });
  await autoRun();
  assert.deepEqual(nitPdfs(), ['viewNitPdf_71.pdf']);
  server.s.messages.push(msg('EAST CENTRAL RLY'));
  const later = await autoRun();
  assert.deepEqual(later.tenders.map((t) => [t.railwayUnit, t.status]), [['STORES/EAST CENTRAL RLY', 'DOWNLOADED']]);
  assert.deepEqual(nitPdfs(), ['viewNitPdf_71.pdf', 'viewNitPdf_72.pdf']);
  assert.deepEqual(Object.keys(store['doclink.tender.ledger.833'].nit).sort(), ['10263703|EAST CENTRAL RLY', '10263703|N F RLY'], 'one NIT mark per railway');
});
// T({}) is the SOUTH EASTERN RLY tender 29263265; WESTERN RLY uses the same number (6.2)
const OTHER_RLY = { unit: 'DAHOD / WESTERN RLY', nitOid: '900' };
const OWN_RLY = { unit: 'STORES / SOUTH EASTERN RLY', nitOid: '107200478' };
const corresOf = (r, id, subject) => ({ nitOid: r.nitOid, tenderNo: '29263265', unit: r.unit, letters: [{ no: id, id, corresId: `c${id}`, subject }] });
test('Two railways, one tender number (6.2): the tender\'s letter list and its correspondence take only the rows of the tender\'s own railway', async () => {
  mk({
    tenders: [T({})], liveInbox: true, letterAsPdf: true,
    inbox: { MyNegotiation: [], MyCounterOffer: [], MyAdvanceAcceptanceLetter: [
      { no: '29263265', oid: OTHER_RLY.nitOid, letter: '111', date: daysAgo(3), unit: OTHER_RLY.unit },
      { no: '29263265', oid: OWN_RLY.nitOid, letter: '222', date: daysAgo(4), unit: OWN_RLY.unit },
    ] },
    corresRows: [{ ...OTHER_RLY, no: '29263265' }, { ...OWN_RLY, no: '29263265' }],
    corres: { [OTHER_RLY.nitOid]: corresOf(OTHER_RLY, '9001', 'Other railway'), [OWN_RLY.nitOid]: corresOf(OWN_RLY, '1072', 'Ours') },
  });
  const c = (await run('29263265', { only: ['loa', 'correspondence'] })).categories;
  assert.deepEqual(c.loa.files.map((f) => f.id), ['222'], 'only the SOUTH EASTERN RLY LOA');
  assert.deepEqual(c.correspondence.files.map((f) => f.id), ['1072'], 'only its correspondence');
  assert.ok(!server.log.some((l) => l.body.nitOid === OTHER_RLY.nitOid), 'the WESTERN RLY correspondence page is never opened');
  // one railway in the list, or no unit column (the fake's default list): every row, as before
  mk({ tenders: [T({})], letterAsPdf: true, inbox: { MyNegotiation: [], MyCounterOffer: [], MyAdvanceAcceptanceLetter: [{ no: '29263265', oid: '1', letter: '333', date: daysAgo(3) }, { no: '29263265', oid: '2', letter: '444', date: daysAgo(4) }] } });
  assert.deepEqual((await run('29263265', { only: ['loa'] })).categories.loa.files.map((f) => f.id), ['333', '444']);
});
test('Two railways, one tender number (6.2): a correspondence page of another railway is discarded, nothing of it is downloaded', async () => {
  mk({ tenders: [T({})], corresRows: [{ ...OTHER_RLY, no: '29263265' }], corres: { [OTHER_RLY.nitOid]: corresOf(OTHER_RLY, '9001', 'Other railway') } });
  const c = (await run('29263265', { only: ['correspondence'] })).categories.correspondence;
  assert.equal(c.status, 'FAILED');
  assert.match(c.note, /The correspondence page is for tender 29263265 of WESTERN RLY, not of SOUTH EASTERN RLY; nothing was downloaded/);
  assert.ok(!server.log.some((l) => l.path === '/epsn/corres/rly/viewpubIndltr.do'), 'no letter of the other railway is fetched');
  mk({ tenders: [T({})], corresRows: [{ ...OWN_RLY, no: '29263265' }], corres: { [OWN_RLY.nitOid]: corresOf(OWN_RLY, '1072', 'Ours') } });
  assert.equal((await run('29263265', { only: ['correspondence'] })).categories.correspondence.status, 'DOWNLOADED', 'its own railway: as before');
});

// =========================== parallel scanning =============================================
const isNegoList = (b) => { const p = new URLSearchParams(b || ''); return p.get('status') === 'MyNegotiation' && p.has('pageNo'); };
test('P1. A slow Negotiation list does not hold back NIT, LOA, counter offer or the rest; negotiation downloads when it arrives', async () => {
  mk({ tenders: [FULL()], inbox: letters('29263265') });
  const orig = server.handle.bind(server);
  server.handle = async (m, u, b) => {
    if (isNegoList(b)) await new Promise((r) => setTimeout(r, 400));
    return orig(m, u, b);
  };
  const r = await run();
  const order = saved.map((s) => s.filename);
  const idx = (re) => order.findIndex((f) => re.test(f));
  const nego = idx(/\/Negotiation\//), loa = idx(/Advance_Acceptance_LOA/), co = idx(/Counter_Offers/), nit = idx(/NIT_and_Supporting_Documents\/viewNitPdf_/);
  assert.ok(nego >= 0 && loa >= 0 && co >= 0 && nit >= 0, order.join('\n'));
  assert.ok(nego > loa && nego > co && nego > nit, `negotiation must be saved last:\n${order.join('\n')}`);
  assert.equal(r.categories.negotiation.status, 'DOWNLOADED');
  assert.equal(r.categories.loa.status, 'DOWNLOADED');
  assert.equal(r.categories.counterOffer.status, 'DOWNLOADED');
});

const listOf = (status) => (b) => { const p = new URLSearchParams(b || ''); return p.get('status') === status && p.has('pageNo'); };
const abortableFetch = (shim) => (url, init = {}) => new Promise((resolve, reject) => {
  init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
  shim(url, init).then(resolve, reject);
});
test('P2. Negotiation and Counter Offer get longer than the normal limit: DocLink waits for the page to open and downloads', async () => {
  mk({ tenders: [FULL()], inbox: letters('29263265') });
  const orig = server.handle.bind(server);
  const slow = (b) => isNegoList(b) || listOf('MyCounterOffer')(b);
  server.handle = async (m, u, b) => { if (slow(b)) await new Promise((r) => setTimeout(r, 900)); return orig(m, u, b); }; // well past the limit
  const shim = globalThis.fetch;
  globalThis.fetch = abortableFetch(shim);
  core.fetchSettings.timeoutMs = 300;
  try {
    const r = await run();
    assert.equal(r.categories.negotiation.status, 'DOWNLOADED');
    assert.equal(r.categories.counterOffer.status, 'DOWNLOADED');
    assert.equal(r.categories.tenderPdf.status, 'DOWNLOADED');
    assert.equal(r.aborted, null);
  } finally { globalThis.fetch = shim; core.fetchSettings.timeoutMs = 45000; }
});
test('P2d. Negotiation waits up to waitMs (3 minutes) and then fails as not responding; the rest still download', async () => {
  assert.equal(core.fetchSettings.waitMs, 180000);
  mk({ tenders: [FULL()], inbox: letters('29263265') });
  const orig = server.handle.bind(server);
  server.handle = (m, u, b) => (isNegoList(b) ? new Promise(() => {}) : orig(m, u, b)); // never answers
  const shim = globalThis.fetch;
  globalThis.fetch = abortableFetch(shim);
  core.fetchSettings.waitMs = 400;
  try {
    const r = await run();
    assert.equal(r.categories.negotiation.status, 'FAILED');
    assert.match(JSON.stringify(r.categories.negotiation), /Negotiation page did not open within/);
    assert.equal(r.categories.counterOffer.status, 'DOWNLOADED');
    assert.equal(r.categories.loa.status, 'DOWNLOADED');
    assert.equal(r.aborted, null);
  } finally { globalThis.fetch = shim; core.fetchSettings.waitMs = 180000; }
});
test('P2b. Other pages keep the time limit: an LOA list that never answers fails on its own; the rest download', async () => {
  mk({ tenders: [FULL()], inbox: letters('29263265') });
  const orig = server.handle.bind(server);
  server.handle = (m, u, b) => (listOf('MyAdvanceAcceptanceLetter')(b) ? new Promise(() => {}) : orig(m, u, b)); // never answers
  const shim = globalThis.fetch;
  globalThis.fetch = abortableFetch(shim);
  core.fetchSettings.timeoutMs = 300;
  try {
    const r = await run();
    assert.equal(r.categories.loa.status, 'FAILED');
    assert.match(JSON.stringify(r.categories.loa), /not responding/);
    assert.equal(r.categories.negotiation.status, 'DOWNLOADED');
    assert.equal(r.categories.counterOffer.status, 'DOWNLOADED');
    assert.equal(r.aborted, null);
  } finally { globalThis.fetch = shim; core.fetchSettings.timeoutMs = 45000; }
});
test('P2c. While IREPS cannot be reached / answers 503, the Negotiation page is retried (with a waiting message) until it opens', async () => {
  mk({ tenders: [FULL()], inbox: letters('29263265') });
  const orig = server.handle.bind(server);
  let negoTries = 0;
  const shim = globalThis.fetch;
  globalThis.fetch = (url, init = {}) => {
    if (isNegoList(init.body) && ++negoTries <= 2) return Promise.reject(new TypeError('Failed to fetch'));
    return shim(url, init);
  };
  let coTries = 0;
  server.handle = (m, u, b) => (listOf('MyCounterOffer')(b) && ++coTries <= 1 ? { status: 503, type: 'text/html', bytes: new TextEncoder().encode('Service Unavailable') } : orig(m, u, b));
  Object.assign(core.fetchSettings, { waitRetryMs: 20, waitRetryMaxMs: 50 });
  const progress = [];
  try {
    const r = await run('29263265', { onProgress: (m) => progress.push(m) });
    assert.equal(r.categories.negotiation.status, 'DOWNLOADED');
    assert.equal(r.categories.counterOffer.status, 'DOWNLOADED');
    assert.ok(negoTries > 2 && coTries > 1);
    assert.ok(progress.some((m) => /Waiting for IREPS to open the Negotiation page/.test(m)), progress.join('\n'));
    assert.ok(progress.some((m) => /Waiting for IREPS to open the Counter Offer page/.test(m)), progress.join('\n'));
  } finally { globalThis.fetch = shim; Object.assign(core.fetchSettings, { waitRetryMs: 5000, waitRetryMaxMs: 60000 }); }
});


// =========================== Download log ===================================================
/**
 * Run fn with the download log on and a fake Recon Engine: `already(key)` says whether the user
 * downloaded a key before. fn gets { checks, logged, prompts, signIns, answer }: check bodies,
 * logged records, download-again questions and Recon sign-in asks; set answer(question) to reply.
 */
async function withDownloadLog(already, fn) {
  dlog.applyDownloadLogConfig({});
  recon.applyReconConfig({ reconBaseUrl: 'http://localhost:8000' });
  chrome.runtime.getManifest = () => ({ host_permissions: ['http://localhost:8000/*'] });
  const prev = globalThis.fetch;
  const prevDocument = globalThis.document;
  const seen = { checks: [], logged: [], prompts: [], signIns: 0, answer: () => ({ redownload: [], sameForRun: true }) };
  globalThis.document = {
    // the panel's sign-in page and download-again prompt answer these events
    dispatchEvent: (event) => {
      if (event.type === dlog.REDOWNLOAD_EVENT) {
        seen.prompts.push(event.detail.question);
        event.detail.resolve(seen.answer(event.detail.question));
      } else {
        seen.signIns += 1;
        event.detail.resolve(true);
      }
      return false;
    },
  };
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u === 'http://localhost:8000/api/doclink/downloads/check') {
      const body = JSON.parse(init.body);
      seen.checks.push(body);
      const downloaded = Object.fromEntries(body.keys.filter(already).map((k) => [k, { count: 1, filename: 'old.pdf', downloaded_at: '2026-10-01T04:30:00+00:00', date: '2026-10-01', time: '10:00:00' }]));
      return json(200, { destination: body.destination, downloaded });
    }
    if (u === 'http://localhost:8000/api/doclink/downloads') {
      seen.logged.push(...JSON.parse(init.body).records);
      return json(201, { logged: 1 });
    }
    return prev(url, init);
  };
  try {
    return await fn(seen);
  } finally {
    globalThis.fetch = prev;
    if (prevDocument === undefined) delete globalThis.document;
    else globalThis.document = prevDocument;
    delete chrome.runtime.getManifest;
    dlog.applyDownloadLogConfig({ downloadLog: { enabled: false } });
  }
}

test('Download log: documents this user already downloaded are skipped after one question, the rest are downloaded and logged', async () => {
  mk({ tenders: [FULL()] });
  const before = (k) => k.startsWith('tender:TENDER_PDF|29263265|') || k.startsWith('tender:CORRIGENDA|29263265|');
  await withDownloadLog(before, async (seen) => {
    const r = await run();
    const c = r.categories;
    assert.equal(seen.signIns, 1, 'the Recon sign-in is asked once, before anything is fetched');
    assert.equal(seen.prompts.length, 1, 'one question; "same answer for the rest of this run" answers the next category');
    assert.ok(seen.prompts[0].alreadyDownloaded.every((a) => a.date === '2026-10-01'));
    assert.ok(seen.checks.every((b) => b.destination === 'local'));
    assert.deepEqual([c.tenderPdf.alreadyDownloaded, c.tenderPdf.downloaded, c.corrigenda.alreadyDownloaded, c.corrigenda.downloaded], [1, 0, 2, 0]);
    assert.equal(c.tenderPdf.skippedFiles[0].skip.reason, 'already_downloaded');
    assert.ok(!savedNames().some((n) => /viewNitPdf_5569207\.pdf|Corrigendum_/.test(n)), 'skipped documents are not fetched');
    assert.equal(c.attachments.downloaded, 4);
    await dlog.flushDownloadLog();
    const types = seen.logged.reduce((m, x) => ({ ...m, [x.doc_type]: (m[x.doc_type] || 0) + 1 }), {});
    assert.deepEqual(types, { tender_attachment: 4, my_offer: 1, financial_tabulation: 1, commercial_tabulation: 1 });
    assert.ok(seen.logged.every((x) => x.destination === 'local' && x.ireps_account_id === '833' && x.doc_key.startsWith('tender:') && x.filename));
  });
});
test('Download log: "download again" fetches the chosen documents and logs them again', async () => {
  mk({ tenders: [FULL()] });
  await withDownloadLog((k) => k.startsWith('tender:TENDER_PDF|'), async (seen) => {
    seen.answer = (q) => ({ redownload: q.alreadyDownloaded.map((a) => a.id), sameForRun: false });
    const r = await run();
    assert.equal(r.categories.tenderPdf.downloaded, 1);
    assert.equal(r.categories.tenderPdf.alreadyDownloaded, 0);
    await dlog.flushDownloadLog();
    assert.ok(seen.logged.some((x) => x.doc_type === 'tender_nit'));
  });
});
test('Download log: when the log cannot be reached the run downloads everything and says so', async () => {
  mk({ tenders: [FULL()] });
  await withDownloadLog(() => true, async (seen) => {
    const shim = globalThis.fetch;
    globalThis.fetch = async (url, init) => (String(url).includes('/api/doclink/') ? new Response('{}', { status: 503 }) : shim(url, init));
    try {
      const r = await run();
      assert.equal(seen.prompts.length, 0);
      assert.equal(r.categories.tenderPdf.downloaded, 1);
      assert.ok(r.categories.tenderPdf.warnings.some((w) => /Download log unavailable/.test(w)));
    } finally {
      globalThis.fetch = shim;
    }
  });
});
test('Download log: cancelling the Recon sign-in stops the run before anything is fetched', async () => {
  mk({ tenders: [FULL()] });
  await withDownloadLog(() => false, async () => {
    globalThis.document.dispatchEvent = (event) => { event.detail.resolve(false); return false; };
    await assert.rejects(run(), (e) => e.code === 'SIGN_IN_REQUIRED');
    assert.equal(server.log.length, 0, 'IREPS was not called');
  });
});
test('Download log (2.1): a corrigendum whose attached document failed is not logged as downloaded, so the next run fetches it again without asking', async () => {
  mk({ tenders: [ATT_CORR(['Revised_Spec.pdf', 'Annexure.pdf'])], failPaths: ['Annexure.pdf'] });
  const corrKey = dlog.downloadKey.tender('CORRIGENDA', '29263265', '1204999');
  const logged = new Set();
  await withDownloadLog((k) => logged.has(k), async (seen) => {
    const keep = async () => { await dlog.flushDownloadLog(); for (const x of seen.logged) logged.add(x.doc_key); };
    assert.equal((await run('29263265', { only: ['corrigenda'] })).categories.corrigenda.status, 'PARTIAL');
    await keep();
    assert.ok(!logged.has(corrKey), 'the corrigendum is not logged while its attachment is missing');
    assert.ok(logged.has(`${corrKey}#1`), 'the attachment that was saved is logged');
    server.s.failPaths = [];
    assert.equal((await run('29263265', { only: ['corrigenda'] })).categories.corrigenda.status, 'DOWNLOADED');
    assert.equal(seen.prompts.length, 0, 'never asked "download again?": it was not logged as downloaded');
    assert.ok(savedNames().some((n) => n.endsWith('Corrigenda/Annexure.pdf')), 'the attachment is fetched');
    await keep();
    assert.ok(logged.has(corrKey), 'complete now: logged');
  });
});

// =========================== Financial / Commercial Tabulation ===============================
const { readFileSync } = await import('node:fs');
const CLOSED_FIXTURE = readFileSync(new URL('./fixtures/closed-tenders.html', import.meta.url), 'utf8');
const closed = (no, o = {}) => ({ no, nitId: `55${no.slice(-5)}`, oid: `107${no.slice(-6)}`, bidId: `208${no.slice(-5)}`, title: `Item ${no}`, closing: new Date(2026, 9, 20), tab: true, ...o });
const tabRequests = () => server.log.filter((l) => l.path === '/epsn/tbo/commTboPdfAction.do');
const closedPosts = () => server.log.filter((l) => l.path === '/epsn/vendorInboxLink.do' && l.body.status === 'MyBidsClosed' && l.body.startDate);
// Search Tender rows (fake-ireps.js resultRow): a tender this vendor bid on (My Offer, and both tabulations unless
// tab: false), and a tender of another vendor on the same result pages (neither)
const bid = (no, o = {}) => T({ no, nitId: `55${no.slice(-5)}`, oid: `107${no.slice(-6)}`, title: `Item ${no}`, status: 'Tender Finalized', closing: new Date(2026, 9, 20), offer: true, ...o });
const other = (no, o = {}) => T({ no, nitId: `66${no.slice(-5)}`, oid: `108${no.slice(-6)}`, title: `Other ${no}`, status: 'Tender Box Open', closing: new Date(2026, 9, 20), offer: false, ...o });
const searchPosts = () => server.log.filter((l) => l.path === '/epsn/search/advancedSearch.do' && l.method === 'POST' && l.body.submit);
const searchPageGets = () => server.log.filter((l) => l.path === '/epsn/search/advancedSearch.do' && l.method === 'GET' && l.query.pageNo);
/** IREPS Closed Tenders read directly: the one-tender fallback (closedTenderRow) still reads it. */
const closedScan = (from, to, tenderNo = '') => wf.scanClosedTenders({ base: 'https://www.ireps.gov.in', ctx: { tenderNo: '' }, inboxCache: new Map(), onProgress: () => {} }, { from, to, tenderNo });
/** The fields of the Search Tender search in the order the browser sends them (20 Nov 2026 capture). */
const BROWSER_SEARCH_FIELDS = ['searchOption', 'searchOptorOption', 'advancedSearch', 'organization', 'workArea', 'changezone', 'railwayZone', 'division', 'unit', 'tenderStage', 'tenderType', 'bidding', 'selectDate', 'dateFrom', 'dateTo', 'direction', 'noMonthDay', 'monthDay', 'radioDuration', 'submit', 'searchParam'];

test('Tabulation: parseClosedTenders reads every row of the captured Closed Tenders page (HAR entry 82)', () => {
  const rows = wf.parseClosedTenders(core.parseHtml(CLOSED_FIXTURE));
  assert.equal(rows.length, 10);
  const withTab = rows.filter((r) => r.links.financialTabulation);
  assert.deepEqual(withTab.map((r) => r.tenderNo), ['42263731', '69261051', '04241210', '03263926B', 'NB265748']);
  assert.ok(withTab.every((r) => r.links.commercialTabulation), 'Financial and Commercial come together');
  const r = rows.find((x) => x.tenderNo === '42263731');
  assert.deepEqual([r.bidId, r.nitId, r.tenderOid, r.dept, r.title, r.closingDate], ['20874501', '5574420', '107204732', 'STORES / CENTRAL RLY', 'WHEEL MOUNTED BRAKE', '23/10/2026 11:30']);
  assert.equal(r.links.financialTabulation.method, 'POST', 'postRequestNewWindow posts');
  assert.equal(r.links.financialTabulation.url, '/epsn/tbo/commTboPdfAction.do?tenderOID=107204732&pdfType=financialTabulation&accountID=833');
  assert.equal(r.links.commercialTabulation.url, '/epsn/tbo/commTboPdfAction.do?pdfType=commercialTabulation&tenderOID=107204732&accountID=833');
  assert.deepEqual([rows[0].tenderNo, rows[0].links.financialTabulation], ['36265202', null], 'a tender whose bids are not opened has no link');
  assert.equal(rows.find((x) => x.tenderNo === 'RS11031149').closingDate, '22/10/2026 15:00');
});
test('Tabulation: a POSTed commTboPdfAction.do is checked on its body - My Offer and the tabulations pass, Techno-Commercial does not', async () => {
  const post = (pdfType) => core.irepsFetch('https://www.ireps.gov.in', '/epsn/tbo/commTboPdfAction.do', { method: 'POST', form: { tenderOID: '1', pdfType, accountID: '833' } });
  for (const t of ['offer', 'financialTabulation', 'commercialTabulation']) assert.equal((await post(t)).status, 200, t);
  await assert.rejects(() => post('technoCommercialTabulation'), (e) => e.code === 'EXCLUDED');
  await assert.rejects(() => core.irepsFetch('https://www.ireps.gov.in', '/epsn/tbo/commTboPdfAction.do', { method: 'POST', form: { tenderOID: '1' } }), (e) => e.code === 'EXCLUDED');
  assert.ok(!server.excludedHit);
});
test('Tabulation by closing date: every tender this vendor bid on that shows the link is downloaded from Search Tender across result pages; one without is "not available yet"; other vendors\' tenders are not listed', async () => {
  mk({ searchPageSize: 2, tenders: [bid('42263731'), other('51111111'), bid('24261658', { tab: false }), other('52222222'), bid('69261051'), bid('11111111', { closing: new Date(2026, 8, 1) })] });
  const r = await auto.runTabulations({ pdfType: 'financialTabulation', from: new Date(2026, 9, 20), to: new Date(2026, 9, 20) });
  const t = r.tabulations;
  assert.deepEqual([r.range, t.listed, t.summary, t.incomplete], [{ from: '20/10/2026', to: '20/10/2026' }, 3, { downloaded: 2, withTabulation: 2, notAvailable: 1 }, '']);
  const by = Object.fromEntries(t.tenders.map((x) => [x.tenderNo, x]));
  assert.equal(by['24261658'].notAvailable, true, 'My Offer without the tabulation: not available yet');
  assert.equal(by['42263731'].categories.financialTabulation.status, 'DOWNLOADED');
  assert.equal(by['69261051'].categories.financialTabulation.status, 'DOWNLOADED', 'page 3 is read');
  assert.ok(!by['51111111'] && !by['52222222'], 'tenders this vendor did not bid on are not listed');
  assert.deepEqual(savedNames().sort(), ['DocLink/HOSUR/Tender_42263731/Tabulation/Financial_Tabulation_42263731.pdf', 'DocLink/HOSUR/Tender_69261051/Tabulation/Financial_Tabulation_69261051.pdf']);
  assert.ok(tabRequests().every((l) => l.method === 'GET' && l.query.pdfType === 'financialTabulation'), 'only the chosen tabulation, opened as the search row opens it (GET)');
  assert.deepEqual(searchPageGets().map((l) => l.query.pageNo), ['2', '3']);
  assert.ok(!server.log.some((l) => l.path === '/epsn/vendorInboxLink.do'), 'Closed Tenders is not read');
  assert.ok(!paths().some((x) => /billSubmission/i.test(x)), 'Bill Tracking on the row is never requested');
  // the same range again: the ledger skips what was downloaded
  saved.length = 0;
  const again = await auto.runTabulations({ pdfType: 'financialTabulation', from: new Date(2026, 9, 20), to: new Date(2026, 9, 20) });
  assert.equal(again.tabulations.summary.downloaded, 0);
  assert.equal(again.tabulations.tenders.find((x) => x.tenderNo === '42263731').categories.financialTabulation.alreadyDownloaded, 1);
  assert.equal(saved.length, 0);
});
test('Tabulation by closing date: a range of days is searched one closing day at a time; the Tender Number narrows the search', async () => {
  mk({ tenders: [bid('42263731', { closing: new Date(2026, 9, 18) }), bid('69261051', { closing: new Date(2026, 9, 20) })] });
  const r = await auto.runTabulations({ pdfType: 'commercialTabulation', from: new Date(2026, 9, 18), to: new Date(2026, 9, 20) });
  assert.equal(r.tabulations.summary.downloaded, 2);
  assert.deepEqual(searchPosts().map((l) => [l.body.dateFrom, l.body.dateTo]), [['18/10/2026', '18/10/2026'], ['19/10/2026', '19/10/2026'], ['20/10/2026', '20/10/2026']]);
  assert.equal(r.tabulations.incomplete, '', 'a day IREPS answers "No Results Found" is a day nothing closed');
  assert.ok(savedNames().includes('DocLink/HOSUR/Tender_42263731/Tabulation/Commercial_Tabulation_42263731.pdf'));
  mk({ tenders: [bid('42263731'), bid('69261051')] });
  const one = await auto.runTabulations({ pdfType: 'commercialTabulation', from: new Date(2026, 9, 20), to: new Date(2026, 9, 20), tenderNo: ' 69261051 ' });
  assert.deepEqual([one.tabulations.listed, one.tabulations.summary.downloaded], [1, 1]);
  assert.ok(searchPosts().every((l) => l.body.advancedSearch === '69261051'));
});
test('Tabulation by closing date: the Search Tender search is sent as the browser sends it (20 Nov 2026 capture), the form opened once for all the days', async () => {
  mk({ tenders: [bid('42263731')] });
  await auto.runTabulations({ pdfType: 'financialTabulation', from: new Date(2026, 9, 19), to: new Date(2026, 9, 20) });
  const posts = searchPosts();
  assert.equal(posts.length, 2);
  for (const l of posts) assert.deepEqual(Object.keys(l.body), BROWSER_SEARCH_FIELDS, 'the browser\'s field order');
  const b = posts[1].body;
  assert.deepEqual([b.searchOption, b.searchOptorOption, b.advancedSearch, b.organization, b.workArea, b.railwayZone, b.division, b.unit, b.selectDate, b.dateFrom, b.dateTo, b.radioDuration, b.submit],
    ['1', '0', '', '01', 'PT', '-1', '19', '-1', 'TENDER_OPENING_DATE', '20/10/2026', '20/10/2026', '0', 'Show Results']);
  assert.equal(server.log.filter((l) => l.path === '/epsn/search/advancedSearch.do' && l.body.searchParam === 'showPage').length, 1, 'the form (no Struts token) is opened once');
});
test('Tabulation by closing date: every result page is asked for through a link IREPS showed on a page read before, exactly as shown', async () => {
  // 13 pages: pages 1-10 show the links of pages 1-10 and "next" (11), pages 11-13 show 11-13
  mk({ searchPageSize: 1, tenders: [bid('42263731'), ...Array.from({ length: 11 }, (_, i) => other(String(50000000 + i))), bid('69261051')] });
  const r = await auto.runTabulations({ pdfType: 'financialTabulation', from: new Date(2026, 9, 20), to: new Date(2026, 9, 20) });
  assert.deepEqual([r.tabulations.summary.downloaded, r.tabulations.incomplete], [2, ''], 'the tenders on the first and the last page');
  const gets = searchPageGets();
  assert.deepEqual(gets.map((l) => l.query.pageNo), ['2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13'], 'each page once');
  assert.deepEqual(server.unshownPageGets, [], 'never a link no page showed: pages 12 and 13 wait for page 11, the first to show them');
  assert.deepEqual(gets.map((l) => l.query.railwayzone), ['-1', '-1', '-1', '', '', '', '', '', '', '', '', ''],
    'pages 2-4 through page 1\'s links (railwayzone=-1), the others through later pages\' links (railwayzone=)');
  assert.ok(gets.every((l) => l.query.count === '13' && l.query.linkVal === 'department'));
});
test('Tabulation by closing date: a day\'s result pages are asked for three at a time and read in order', async () => {
  mk({ searchPageSize: 1, searchPageMs: 25, tenders: [other('51111111'), bid('42263731'), other('52222222'), other('53333333'), bid('69261051'), other('54444444'), bid('24261658')] });
  const r = await auto.runTabulations({ pdfType: 'financialTabulation', from: new Date(2026, 9, 20), to: new Date(2026, 9, 20) });
  assert.equal(server.maxPagesInFlight, 3, 'three result pages under way at once, never more');
  assert.deepEqual(searchPageGets().map((l) => l.query.pageNo), ['2', '3', '4', '5', '6', '7']);
  assert.deepEqual(r.tabulations.tenders.map((t) => t.tenderNo), ['42263731', '69261051', '24261658'], 'in page order');
  assert.deepEqual([r.tabulations.summary.downloaded, r.tabulations.incomplete], [3, '']);
  assert.match(core.getLogTail(), /Search Tender 20\/10\/2026: 7 of 7 tender\(s\) over 7 page\(s\) in \d+ s, 3 of this vendor/);
});
test('Tabulation by closing date: when a day stops at a page, the pages asked for after it are waited for and not read, so no request is left under way', async () => {
  // two tenders join the top of the list before page 2 is served: IREPS's count goes from 5 to 7, more than a page
  mk({ searchPageSize: 1, searchPageMs: (n) => (n === 2 ? 5 : 150), tenders: [bid('42263731'), other('51111111'), other('52222222'), bid('69261051'), other('53333333')],
    searchChanges: [{ beforePage: 2, add: other('50000001'), at: 0 }, { beforePage: 2, add: other('50000002'), at: 0 }] });
  const got = await wf.scanTenderSearch({ base: 'https://www.ireps.gov.in', onProgress: () => {} }, { from: new Date(2026, 9, 20), to: new Date(2026, 9, 20) });
  assert.equal(server.pagesInFlight, 0, 'nothing still under way when the day, and the IREPS form lock, is over');
  assert.deepEqual(searchPageGets().map((l) => l.query.pageNo), ['2', '3', '4'], 'pages 3 and 4 were asked for with page 2');
  assert.deepEqual(got.rows.map((r) => r.tenderNo), ['42263731'], 'only page 1 is taken: the day stopped at page 2');
  assert.match(got.incomplete, /Search Tender 20\/10\/2026 page 2: IREPS's count changed from 5 to 7, so another search in this IREPS session replaced this one/);
});
test('Tabulation by closing date: a tender that leaves the day\'s list between two pages (IREPS\'s count drops by one, 23 Nov 2026) does not hide the tender that slides onto the page already read', async () => {
  // page 1: 51111111, 52222222 | page 2: 42263731, 53333333 | page 3: 69261051; 51111111 leaves the list just before
  // page 2 is served, so 42263731 moves up onto page 1 (read already) and page 2 is 53333333, 69261051
  mk({ searchPageSize: 2, tenders: [other('51111111'), other('52222222'), bid('42263731'), other('53333333'), bid('69261051')], searchChanges: [{ beforePage: 2, remove: '51111111' }] });
  const r = await auto.runTabulations({ pdfType: 'financialTabulation', from: new Date(2026, 9, 20), to: new Date(2026, 9, 20) });
  assert.deepEqual(r.tabulations.tenders.map((t) => t.tenderNo).sort(), ['42263731', '69261051']);
  assert.equal(r.tabulations.summary.downloaded, 2);
  assert.equal(r.tabulations.incomplete, '', 'the day is read to its end');
  assert.deepEqual(searchPageGets().map((l) => l.query.pageNo), ['2', '3', '1'],
    'pages 2 and 3 together (page 1 shows both), then page 1 again; page 2 now says it is the last, so page 3\'s answer is not read');
  assert.match(core.getLogTail(), /Search Tender 20\/10\/2026 page 2: IREPS's count changed from 5 to 4 while its pages were read; page 1 is read again/);
});
test('Tabulation by closing date: a tender that joins the day\'s list between two pages (IREPS\'s count rises) repeats a tender, which is taken once; the day goes on, and its count says the new one was not read', async () => {
  // page 1: 51111111, 52222222 | page 2: 42263731, 53333333; 50000000 joins at the top before page 2 is served,
  // so page 2 is 52222222 (again), 42263731 and page 3 is 53333333
  mk({ searchPageSize: 2, tenders: [other('51111111'), other('52222222'), bid('42263731'), other('53333333')], searchChanges: [{ beforePage: 2, add: other('50000000'), at: 0 }] });
  const r = await auto.runTabulations({ pdfType: 'financialTabulation', from: new Date(2026, 9, 20), to: new Date(2026, 9, 20) });
  assert.deepEqual([r.tabulations.listed, r.tabulations.summary.downloaded], [1, 1], '42263731 once');
  assert.deepEqual(searchPageGets().map((l) => l.query.pageNo), ['2', '3'], 'no page is read again');
  assert.match(r.tabulations.incomplete, /Search Tender 20\/10\/2026: IREPS lists 5 tender\(s\), 4 were read/);
});
test('Tabulation by closing date: the scheduled run (no button: both tabulations) searches Search Tender the same way', async () => {
  mk({ tenders: [bid('42263731'), other('51111111')] });
  const t = await jobs.downloadTabulationsByDate({ from: new Date(2026, 9, 20), to: new Date(2026, 9, 20) });
  assert.deepEqual([t.listed, t.summary.downloaded, Object.keys(t.tenders[0].categories).sort()], [1, 2, ['commercialTabulation', 'financialTabulation']]);
  assert.deepEqual(tabRequests().map((l) => `${l.method} ${l.query.pdfType}`).sort(), ['GET commercialTabulation', 'GET financialTabulation']);
  assert.ok(!server.log.some((l) => l.path === '/epsn/vendorInboxLink.do'), 'Closed Tenders is not read');
});
// 40 closed tenders, one a day back from 23/10/2026, for an IREPS that returns the whole list whatever the dates
const closedDaily = () => Array.from({ length: 40 }, (_, i) => closed(`4226${String(i).padStart(4, '0')}`, { closing: new Date(2026, 9, 23 - i) }));
test('Closed Tenders (read by the one-tender fallback): when IREPS ignores the dates, only rows whose own Closing Date is in the range are kept, and paging stops', async () => {
  mk({ closed: closedDaily(), closedIgnoresDates: true });
  const { rows } = await closedScan(new Date(2026, 9, 15), new Date(2026, 9, 16));
  assert.deepEqual(rows.map((t) => [t.tenderNo, t.closingDate]), [['42260007', '16/10/2026 11:30'], ['42260008', '15/10/2026 11:30']]);
  assert.deepEqual(server.listPages.map((l) => l.pageNo), ['1', '2', '3'], 'page 1 has the range, pages 2-3 closed earlier, page 4 is never read');
  assert.match(core.getLogTail(), /Pages 2-3 all closed before 15\/10\/2026; stopping/);
  assert.match(core.getLogTail(), /2 closed tender\(s\) closing 15\/10\/2026\.\.16\/10\/2026 .*; 28 outside the dates skipped/);
});
test('Closed Tenders (read by the one-tender fallback): a range over 90 days does not re-read the same list when IREPS ignores the dates', async () => {
  mk({ closed: closedDaily(), closedIgnoresDates: true });
  const { rows } = await closedScan(new Date(2026, 5, 1), new Date(2026, 9, 23));
  assert.equal(rows.length, 40);
  assert.deepEqual(closedPosts().map((l) => `${l.body.startDate}..${l.body.endDate} p${l.body.pageNo}`), ['01/06/2026..29/08/2026 p1', '01/06/2026..29/08/2026 p2', '01/06/2026..29/08/2026 p3', '01/06/2026..29/08/2026 p4', '30/08/2026..23/10/2026 p1']);
});
test('Tabulation: a single tender whose row has no tabulation link finds it in Closed Tenders around its closing date (one scan for both)', async () => {
  const closing = new Date(2026, 10, 9);
  mk({ tenders: [T({ offer: false, closing })], closed: [closed('29263265', { nitId: '5569207', oid: '107200478', closing })] });
  const r = await run('29263265', { only: ['financialTabulation', 'commercialTabulation'] });
  assert.deepEqual([r.categories.financialTabulation.status, r.categories.commercialTabulation.status], ['DOWNLOADED', 'DOWNLOADED']);
  assert.equal(closedPosts().length, 1, 'both steps share one Closed Tenders scan');
  assert.deepEqual([closedPosts()[0].body.startDate, closedPosts()[0].body.endDate, closedPosts()[0].body.tenderNo], ['08/11/2026', '10/11/2026', '29263265']);
  mk({ tenders: [T({ offer: false })], closed: [] });
  const none = await run('29263265', { only: ['financialTabulation'] });
  assert.equal(none.categories.financialTabulation.status, 'NOT_AVAILABLE');
  assert.match(none.categories.financialTabulation.note, /no Financial Tabulation for this tender yet/);
});
test('Tabulation: a Closed Tenders link (one-tender fallback) whose accountID is another IREPS account is refused, nothing is saved', async () => {
  const closing = new Date(2026, 10, 9);
  mk({ tenders: [T({ offer: false, closing })], closed: [closed('29263265', { nitId: '5569207', oid: '107200478', closing, tabAcct: '60828' })] });
  const r = await run('29263265', { only: ['financialTabulation'] });
  assert.equal(r.categories.financialTabulation.status, 'FAILED');
  assert.match(r.categories.financialTabulation.files[0].error, /Account mismatch: .*60828/);
  assert.equal(tabRequests().length, 0, 'the tabulation is not requested');
  assert.deepEqual(savedNames(), []);
});
test('Tabulation: a web page with no PDF behind it fails with what IREPS showed; nothing is saved as the tabulation', async () => {
  mk({ tenders: [bid('42263731')], tabulationAsHtml: true });
  const r = await auto.runTabulations({ pdfType: 'financialTabulation', from: new Date(2026, 9, 15), to: new Date(2026, 9, 23) });
  assert.equal(r.tabulations.summary.downloaded, 0);
  const cat = r.tabulations.tenders[0].categories.financialTabulation;
  assert.equal(cat.status, 'FAILED');
  assert.match(cat.files[0].error, /only a web page: "financialTabulation 107263731/);
  assert.deepEqual(savedNames(), []);
});
test('Tabulation: the real IREPS answer (a page that opens the PDF from <body onload>) gives the FIN-TAB PDF, saved as the Financial Tabulation', async () => {
  mk({ tenders: [bid('42263731')], tabulationAs: 'onload' });
  const r = await auto.runTabulations({ pdfType: 'financialTabulation', from: new Date(2026, 9, 15), to: new Date(2026, 9, 23) });
  assert.equal(r.tabulations.summary.downloaded, 1, JSON.stringify(r.tabulations.tenders[0]));
  assert.ok(paths().includes('/ireps/supply/pdfdocs//112026/107263731/FIN-TAB-42263731-107263731.pdf'), paths().join('\n'));
  const f = saved.find((x) => x.filename.endsWith('Tabulation/FIN-TAB-42263731-107263731.pdf'));
  assert.ok(f, `the linked IREPS file keeps its name:\n${savedNames().join('\n')}`);
  assert.match(new TextDecoder().decode(f.bytes), /^%PDF/);
});
for (const [pdfType, own, other] of [['financialTabulation', 'FIN-TAB', 'TECH-TAB'], ['commercialTabulation', 'TECH-TAB', 'FIN-TAB']]) {
  test(`Tabulation: the ${pdfType} button downloads that tabulation only, never the other one (both links on the row)`, async () => {
    mk({ tenders: [bid('42263731'), bid('69261051')], tabulationAs: 'onload' });
    const r = await auto.runTabulations({ pdfType, from: new Date(2026, 9, 15), to: new Date(2026, 9, 23) });
    assert.equal(r.tabulations.summary.downloaded, 2);
    const asked = server.log.filter((l) => l.path === '/epsn/tbo/commTboPdfAction.do').map((l) => l.body.pdfType || l.query.pdfType);
    assert.deepEqual(asked, [pdfType, pdfType], 'one request per tender, for this tabulation');
    assert.ok(!paths().some((p) => p.includes(other)), paths().join('\n'));
    const names = savedNames().map((n) => n.split('/').pop()).sort();
    assert.deepEqual(names, [`${own}-42263731-107263731.pdf`, `${own}-69261051-107261051.pdf`]);
    assert.ok(Object.values(r.tabulations.tenders).every((t) => Object.keys(t.categories).join() === pdfType));
  });
}
test('Tabulation: the real IREPS Commercial answer opens TECH-TAB-<no>-<oid>.pdf from <body onload>; it is saved as the Commercial Tabulation', async () => {
  mk({ tenders: [bid('42263731')], tabulationAs: 'onload' });
  const r = await auto.runTabulations({ pdfType: 'commercialTabulation', from: new Date(2026, 9, 15), to: new Date(2026, 9, 23) });
  assert.equal(r.tabulations.summary.downloaded, 1, JSON.stringify(r.tabulations.tenders[0]));
  assert.deepEqual(server.tabFileHits, ['/ireps/supply/pdfdocs//112026/107263731/TECH-TAB-42263731-107263731.pdf']);
  const f = saved.find((x) => x.filename.endsWith('Tabulation/TECH-TAB-42263731-107263731.pdf'));
  assert.ok(f, `the linked IREPS file keeps its name:\n${savedNames().join('\n')}`);
  assert.match(new TextDecoder().decode(f.bytes), /^%PDF/);
});
test('File names: a tabulation IREPS names in Content-Disposition keeps that name; without one it gets DocLink\'s name', async () => {
  mk({ tenders: [bid('42263731')], tabulationDisposition: 'attachment; filename="FinTab 42263731.pdf"' });
  await auto.runTabulations({ pdfType: 'financialTabulation', from: new Date(2026, 9, 15), to: new Date(2026, 9, 23) });
  assert.deepEqual(savedNames(), ['DocLink/HOSUR/Tender_42263731/Tabulation/FinTab 42263731.pdf'], 'spaces and case are kept');
  mk({ tenders: [bid('42263731')] });
  await auto.runTabulations({ pdfType: 'financialTabulation', from: new Date(2026, 9, 15), to: new Date(2026, 9, 23) });
  assert.deepEqual(savedNames(), ['DocLink/HOSUR/Tender_42263731/Tabulation/Financial_Tabulation_42263731.pdf'], 'commTboPdfAction.do names no file');
});
test('File names: two different attachments with one IREPS name are both kept, the later one as "_2" - locally and in the "<T> - NIT" ECM document', async () => {
  const twins = [{ name: 'Spec.pdf', desc: 'SPEC A', href: '/ireps/upload/att/a/Spec.pdf' }, { name: 'Spec.pdf', desc: 'SPEC B', href: '/ireps/upload/att/b/Spec.pdf' }];
  mk({ tenders: [T({ attachments: twins })] });
  await run('29263265', { only: ['tenderPdf', 'attachments'] });
  const local = savedNames().map((x) => x.replace('DocLink/HOSUR/Tender_29263265/NIT_and_Supporting_Documents/', '')).sort();
  assert.deepEqual(local, ['Spec.pdf', 'Spec_2.pdf', 'viewNitPdf_5569207.pdf']);
  mk({ tenders: [T({ attachments: twins })] });
  store['doclink.saveDestination'] = 'recon';
  await withDirectEcm(async ({ docs }) => {
    const r = await run('29263265', { only: ['tenderPdf', 'attachments'] });
    assert.equal(r.summary.failed, 0);
    const nit = [...docs.values()].find((d) => d.props['dc:title'] === '29263265 - NIT');
    assert.equal(nit.main.name, 'viewNitPdf_5569207.pdf');
    assert.deepEqual(nit.files.map((f) => f.name).sort(), ['Spec.pdf', 'Spec_2.pdf'], 'the second Spec.pdf is not taken for the first');
  });
});
test('Tabulation: a TECH-TAB file passes only inside a Commercial Tabulation response; Techno-Commercial names and pdfTypes never do', async () => {
  mk({});
  const tech = '/ireps/supply/pdfdocs//112026/1/TECH-TAB-X-1.pdf';
  const get = (url, trusted) => core.irepsFetch('https://www.ireps.gov.in', url, { trusted });
  assert.equal((await get(tech, 'commercialTabulation')).status, 200);
  for (const trusted of [false, true, 'financialTabulation']) await assert.rejects(() => get(tech, trusted), (e) => e.code === 'EXCLUDED', String(trusted));
  assert.equal(core.isExcludedUrl(tech), true, 'outside a tabulation response it stays blocked');
  for (const url of ['/ireps/upload/tbo/TechnoCommercial_Tabulation_1.pdf', '/ireps/supply/pdfdocs//112026/1/TECHNO-TAB-X-1.pdf', '/ireps/upload/tbo/TECH-TAB-X-1.pdf', `${tech}?x=1`, '/epsn/tbo/commTboPdfAction.do?pdfType=technoCommercialTabulation&tenderOID=1']) {
    await assert.rejects(() => get(url, 'commercialTabulation'), (e) => e.code === 'EXCLUDED', url);
  }
  assert.ok(!server.excludedHit);
});
for (const [mode, file] of [['iframe', '/ireps/upload/tbo/Tabulation_'], ['form', '/epsn/tbo/showTabulation.do'], ['open', '/ireps/upload/tbo/view'], ['onload', '/ireps/supply/pdfdocs//112026/107263731/TECH-TAB-']]) {
  test(`Tabulation: the PDF behind a viewer page (${mode}) is downloaded; Techno-Commercial links in it are never requested`, async () => {
    mk({ tenders: [bid('42263731')], tabulationAs: mode });
    const r = await auto.runTabulations({ pdfType: 'commercialTabulation', from: new Date(2026, 9, 15), to: new Date(2026, 9, 23) });
    assert.equal(r.tabulations.summary.downloaded, 1, JSON.stringify(r.tabulations.tenders[0]));
    const f = saved.find((x) => x.filename.includes('/Tabulation/'));
    assert.ok(f, savedNames().join('\n'));
    // the file the viewer leads to keeps its IREPS name; one the viewer POSTs to a .do action has none
    if (mode === 'form' || mode === 'open') assert.ok(f.filename.endsWith('Tabulation/Commercial_Tabulation_42263731.pdf'), f.filename);
    else assert.ok(f.filename.split('/').pop().startsWith(file.split('/').pop()), f.filename);
    assert.match(new TextDecoder().decode(f.bytes), /^%PDF/);
    assert.ok(paths().some((x) => x.startsWith(file)), paths().join('\n'));
    assert.ok(!server.excludedHit, 'a Techno-Commercial link was requested');
  });
}
test('Tabulation: the 29 Oct capture of Closed Tenders lists the seven tenders with both tabulations', () => {
  const rows = wf.parseClosedTenders(core.parseHtml(readFileSync(new URL('./fixtures/closed-tenders-29oct.html', import.meta.url), 'utf8')));
  assert.equal(rows.length, 10);
  const withTab = rows.filter((r) => r.links.financialTabulation && r.links.commercialTabulation);
  assert.deepEqual(withTab.map((r) => r.tenderNo), ['24260725', '61266411', '61262196', '82261482', '26261089', 'LN265570', 'LF265194']);
  assert.deepEqual([withTab[0].closingDate, withTab[0].tenderOid, withTab[0].links.financialTabulation.method], ['29/10/2026 11:30', '107120554', 'POST']);
});
test('Tabulation: the 20 Nov capture of Search Tender (page 2) reads 25 rows, one with My Offer and both tabulations as GETs, its count and its page links', () => {
  const doc = core.parseHtml(readFileSync(new URL('./fixtures/search-tender-20nov.html', import.meta.url), 'utf8'));
  assert.equal(search.classifySearchResponse(doc), 'results');
  const rows = wf.parseSearchTenderRows(doc);
  assert.equal(rows.length, 25);
  assert.deepEqual(rows.filter((r) => r.offer).map((r) => r.tenderNo), ['LK265182'], 'only the tender this vendor bid on shows My Offer');
  assert.ok(rows.filter((r) => !r.offer).every((r) => !r.links.financialTabulation && !r.links.commercialTabulation));
  const r = rows.find((x) => x.offer);
  assert.deepEqual([r.nitId, r.tenderOid, r.dept, r.title, r.status, r.closingDate], ['5613388', '107238095', 'ELS/KAZIPET/SOUTH CENTRAL RLY', 'Repair kit for PR switch MCS 11', 'Tender Finalized', '19/11/2026 10:30']);
  assert.deepEqual([r.links.financialTabulation.method, r.links.financialTabulation.url], ['GET', '/epsn/tbo/commTboPdfAction.do?pdfType=financialTabulation&tenderOID=107238095']);
  assert.deepEqual([r.links.commercialTabulation.method, r.links.commercialTabulation.url], ['GET', '/epsn/tbo/commTboPdfAction.do?pdfType=commercialTabulation&tenderOID=107238095']);
  assert.ok(rows.every((x) => /^19\/11\/2026 /.test(x.closingDate)), 'Due Date/Time, not Opening Date/Time');
  const cut = rows.find((x) => x.tenderNo === '04261123A');
  assert.equal(cut.title, 'Upper Bearing Arrangement of Entrance Door for LHB coaches to RCF Drg No. LA51150 alt. a or latest.', 'a cut title ("......") is read whole from its image title');
  assert.equal(search.searchResultsTotal(doc), 1214);
  assert.equal(search.nextResultPage(doc, 2), '/epsn/search/advancedSearch.do?advancedSearch=&railwayzone=&dateFrom=19/11/2026&linkVal=department&dateTo=19/11/2026&selectDate=TENDER_OPENING_DATE&count=1214&pageNo=3');
  assert.equal(search.nextResultPage(doc, 10), '/epsn/search/advancedSearch.do?advancedSearch=&railwayzone=&dateFrom=19/11/2026&linkVal=department&dateTo=19/11/2026&selectDate=TENDER_OPENING_DATE&count=1214&pageNo=11', '"next"');
  assert.equal(search.nextResultPage(doc, 11), '', 'no link beyond what the page shows');
});
test('Tabulation: Save to ECM files the Financial Tabulation as "<tender no> - Result" (tenderResult) and the Commercial one as vct, with the tender number and the search row\'s closing date (Due Date/Time)', async () => {
  mk({ tenders: [bid('42263731', { closing: new Date(2026, 9, 23) })] });
  store['doclink.saveDestination'] = 'recon';
  await withDirectEcm(async ({ creates }) => {
    await auto.runTabulations({ pdfType: 'financialTabulation', from: new Date(2026, 9, 15), to: new Date(2026, 9, 23) });
    await auto.runTabulations({ pdfType: 'commercialTabulation', from: new Date(2026, 9, 15), to: new Date(2026, 9, 23) });
    assert.deepEqual(creates.map((p) => [p['InvoiceCertificateSchema:type'], p['dc:title'], p['InvoiceCertificateSchema:tenderNumber'], p['InvoiceCertificateSchema:tenderDate']]), [
      ['tenderResult', '42263731 - Result', '42263731', '2026-10-23'],
      ['vct', '42263731 - Commercial Tabulation', '42263731', '2026-10-23'],
    ]);
    assert.equal(saved.length, 0, 'nothing that went to the ECM is in Downloads');
  });
});

// =========================== review fixes: H4-H7, M20-M23, L11, L12 =========================
const ledgerMod = await import('../tender-ledger.js');
const printMod = await import('../tender-print.js');
const viewCommon = await import('../view-common.js');
const BASE = 'https://www.ireps.gov.in';
const enc8 = (s) => new TextEncoder().encode(s);
const ledgerOf = (id = '833') => store[`doclink.tender.ledger.${id}`];
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
/** Answer the requests `when(method, url, body)` picks with `answer` instead of the fake IREPS. */
const intercept = (when, answer) => { const orig = server.handle.bind(server); server.handle = async (m, u, b) => (when(m, u, new URLSearchParams(b || '')) ? answer() : orig(m, u, b)); };
const html200 = (title, body) => () => ({ status: 200, type: 'text/html', bytes: enc8(`<html><head><title>${title}</title></head><body>${body}</body></html>`) });

// ---- H5: one write guard in the shared request function
test('H5: the request layer refuses write actions for every tender request (submitbid, finalSubmission, withdrawalOfBid, logout ...); nothing reaches IREPS', async () => {
  const writes = ['/epsn/supply/bid/submitbid.do', '/epsn/supply/tds/finalSubmission.do', '/epsn/supply/tds/withdrawalOfBid.do', '/epsn/home/logout.do',
    '/epsn/corres/vendor/vendorCorresSubmitReply.do', '/epsn/x/saveReply.do', '/epsn/x/uploadDocument.do', '/epsn/supply/tds/negoBid.do', '/epsn/supply/tds/coResponse.do'];
  for (const path of writes) {
    for (const method of ['GET', 'POST']) await assert.rejects(() => core.irepsFetch(BASE, path, { method, form: { a: '1' } }), (e) => e.code === 'BLOCKED', `${method} ${path}`);
  }
  // an action parameter that names a write is refused on any page, as is a method other than GET / POST
  for (const form of [{ activity: 'saveBid' }, { ajaxMode: 'updateBankDetails' }, { opValue: 'SubmitBid' }, { Action: 'withdrawLetter' }]) {
    await assert.rejects(() => core.irepsFetch(BASE, '/epsn/supply/tds/ajxdata.do', { method: 'POST', form }), (e) => e.code === 'BLOCKED', JSON.stringify(form));
  }
  await assert.rejects(() => core.irepsFetch(BASE, '/epsn/x/view.do', { method: 'DELETE' }), (e) => e.code === 'BLOCKED');
  assert.deepEqual(server.log, [], 'nothing was sent');
});
test('H5: every request the real flows send passes the guard (captured IREPS requests and the links the flows follow)', () => {
  const allowed = [
    ['GET', '/epsn/home/showHome.do'],
    ['POST', '/epsn/search/advancedSearch.do', 'searchParam=showPage'],
    ['POST', '/epsn/search/advancedSearch.do', 'org.apache.struts.taglib.html.TOKEN=0a1b2c&searchOption=1&searchOptorOption=0&advancedSearch=29263265&division=-1&dateFrom=09%2F10%2F2026&dateTo=09%2F11%2F2026&radioDuration=0&submit=Show+Results&searchParam='],
    ['POST', '/epsn/vendorInboxLink.do', 'listType=MyMsg&pageNo=2'],
    ['POST', '/epsn/vendorInboxLink.do', 'menuLink=PostTenders&status=MyAdvanceAcceptanceLetter&tenderNo=&startDate=24%2F07%2F2026&endDate=22%2F10%2F2026&raStatus=-1&pageNo=1&listType=MyAdvanceAcceptanceLetter'],
    ['POST', '/epsn/vendorInboxLink.do', 'menuLink=Tenders&status=MyBidsClosed&tenderNo=&startDate=31%2F07%2F2026&endDate=29%2F10%2F2026&raStatus=-1&pageNo=1&listType=MyBidsClosed'],
    ['POST', '/epsn/admin/myMessages/ViewMessageDetailAction.do', 'oid=27534757'],
    ['GET', '/epsn/supply/rfq/nitPublish.do?nitId=5567396&activity=viewNIT'],
    ['GET', '/ireps/supply/pdfdocs/112026/107200478/viewNitPdf_5569207.pdf'],
    ['GET', '/epsn/works/rfq/viewCorrigendum.do?nitId=5569207'],
    ['POST', '/epsn/supply/viewCorrigendum.do', 'activity=displayPubCorri&nitId=5569207&cn=1&corrigendumId=1204920'],
    ['POST', '/epsn/tbo/commTboPdfAction.do', 'pdfType=offer&tenderOID=107200478&accountID=833&bid_id=1&bidType=N'],
    ['POST', '/epsn/tbo/commTboPdfAction.do', 'tenderOID=107204732&pdfType=financialTabulation&accountID=833'],
    ['GET', '/epsn/tbo/commTboPdfAction.do?pdfType=commercialTabulation&tenderOID=107204732&accountID=833'],
    ['POST', '/epsn/supply/tds/publishIndiNegotiationLetter.do', 'nitOId=107164217&negoLetterId=224222&opValue=ViewPublishedLetter'],
    ['POST', '/epsn/supply/tds/publishCounterOfferLetter.do', 'Action=ViewPublishedLetter&responseDate=14/09/2026&nitOId=1&tdId=3&tdVersion=1&bidid=2&bidderAccId=833&letterId=5&signId=95'],
    ['POST', '/epsn/supply/tds/ajxdata.do', 'ajaxMode=updateLoaViewedDataByBidder&docId=1488946&docType=11'],
    ['POST', '/epsn/supply/tds/publishLOALetter.do', 'Action=ViewPublishedLetter&nitOId=107198913&tdId=3096443&letterId=1488946&tdVersion=1&bidid=20834392&bidderAccId=833&signId=179112494'],
    ['POST', '/epsn/corres/vendorRelatedCorrespondence.do', ''],
    ['POST', '/epsn/corres/vendorCorrespondencePendingReply.do', 'nitOid=107202979'],
    ['POST', '/epsn/corres/rly/viewpubIndltr.do', 'nitOid=107202979&letterID=313083&corresId=229609'],
    ['GET', '/ireps/upload/att/Annexure.pdf'], ['GET', '/ireps/upload/corrigendum/1204999/Revised_Spec.pdf'], ['GET', '/ireps/corr/Submission_List.pdf'],
    ['GET', '/epsn/x/viewUploadedDoc.do'], ['GET', '/epsn/supply/tds/showLetter.do?id=1'],
    ['GET', '/ireps/supply/pdfdocs//112026/107263731/FIN-TAB-42263731-107263731.pdf'],
    ['GET', '/ireps/supply/pdfdocs//112026/107263731/TECH-TAB-42263731-107263731.pdf', '', 'commercialTabulation'],
    ['GET', '/ireps/upload/tbo/Tabulation_107263731.pdf', '', 'commercialTabulation'],
    ['POST', '/epsn/tbo/showTabulation.do', 'oid=1&pdfType=commercialTabulation', 'commercialTabulation'],
  ];
  for (const [method, path, body = '', trusted = false] of allowed) assert.equal(core.requestRefusal({ method, url: BASE + path, body: body || null, trusted }), null, `${method} ${path} ${body}`);
});
test('H5/H6: only the exact "LOA viewed" update passes; that page with another write, method, field or a query is refused', () => {
  const code = (method, path, body) => core.requestRefusal({ method, url: BASE + path, body })?.code || 'ok';
  assert.equal(code('POST', '/epsn/supply/tds/ajxdata.do', 'ajaxMode=updateLoaViewedDataByBidder&docId=1488946&docType=11'), 'ok');
  assert.deepEqual([
    code('GET', '/epsn/supply/tds/ajxdata.do?ajaxMode=updateLoaViewedDataByBidder&docId=1&docType=11', null),
    code('POST', '/epsn/supply/tds/ajxdata.do?x=1', 'ajaxMode=updateLoaViewedDataByBidder&docId=1&docType=11'),
    code('POST', '/epsn/supply/tds/ajxdata.do', 'ajaxMode=updateLoaViewedDataByBidder&docId=1&docType=11&extra=1'),
    code('POST', '/epsn/supply/tds/ajxdata.do', 'ajaxMode=updateLoaViewedDataByBidder&docId=abc&docType=11'),
    code('POST', '/epsn/supply/tds/ajxdata.do', 'ajaxMode=updateBidAmount&docId=1&docType=11'),
    code('POST', '/epsn/bid/getAjaxData.do', 'ajaxMode=updateLoaViewedDataByBidder&docId=1&docType=11'),
  ], Array(6).fill('BLOCKED'));
});
test('H5: a write-action frame on a page DocLink reads is never requested; the corrigendum and its attached file still download as before', async () => {
  mk({ tenders: [T({ corrigenda: [{ id: '1204999', cn: '2', date: '07/10/2026 10:00', attached: ['Revised_Spec.pdf'], extra: '<iframe src="/epsn/supply/bid/submitbid.do?bidId=1"></iframe><iframe src="/epsn/home/logout.do"></iframe>' }] })] });
  const c = (await run('29263265', { only: ['corrigenda'] })).categories.corrigenda;
  assert.deepEqual(c.files.map((f) => f.fileName), ['Corrigendum_02_29263265.pdf', 'Corrigendum_02_29263265.html', 'Revised_Spec.pdf']);
  assert.ok(!paths().some((p) => /submitbid|logout/.test(p)), paths().join('\n'));
});

// ---- M22: the tabulation guard runs on the request as sent
test('M22: a form field cannot change the pdfType behind an allowed URL (GET or POST); the allowed tabulations still pass as sent', async () => {
  const url = '/epsn/tbo/commTboPdfAction.do?pdfType=financialTabulation&tenderOID=1&accountID=833';
  for (const method of ['GET', 'POST']) await assert.rejects(() => core.irepsFetch(BASE, url, { method, form: { pdfType: 'technoCommercialTabulation' } }), (e) => e.code === 'EXCLUDED', method);
  assert.ok(!server.excludedHit);
  assert.deepEqual(server.log, []);
  for (const t of ['offer', 'financialTabulation', 'commercialTabulation']) assert.equal((await core.irepsFetch(BASE, '/epsn/tbo/commTboPdfAction.do', { method: 'POST', form: { tenderOID: '1', pdfType: t, accountID: '833' } })).status, 200, t);
});

// ---- H6: the "LOA viewed" update only from the live script
const loaByDate = (o = {}) => mk({ inbox: { MyNegotiation: [], MyCounterOffer: [], MyAdvanceAcceptanceLetter: [{ no: 'L1', oid: '9', letter: '77', date: new Date(NOW()), ...o.row }] }, letterAsPdf: true, ...o.state });
const loaRun = async () => (await auto.runLetterType({ status: 'MyAdvanceAcceptanceLetter', from: TODAY(), to: TODAY() })).letters.tenders[0].categories.loa;
test('H6: when the LOA list page\'s own View LOA script cannot be read, no "viewed" update is sent (nothing hard-coded) and the LOA fails clearly', async () => {
  for (const loaScript of ['', LOA_SCRIPT.replace('var docType = "11";', ''), LOA_SCRIPT.replace('ajaxMode:"updateLoaViewedDataByBidder",', '')]) {
    loaByDate({ state: { loaScript } });
    const loa = await loaRun();
    assert.equal(loa.status, 'FAILED');
    assert.match(loa.files[0].error, /could not read how IREPS's "View LOA Letter" link opens this letter/);
    assert.ok(!paths().some((p) => /ajxdata|publishLOALetter/.test(p)), paths().join('\n'));
  }
});
test('H6: the letter id of the update is the one the row\'s own link passes, never guessed from its URL', async () => {
  loaByDate({ row: { noDocId: true } });
  const loa = await loaRun();
  assert.equal(loa.status, 'FAILED');
  assert.match(loa.files[0].error, /passes no letter id/);
  assert.ok(!paths().some((p) => /ajxdata|publishLOALetter/.test(p)));
  loaByDate();
  assert.equal((await loaRun()).status, 'DOWNLOADED', 'with the script and the id, the LOA downloads as before');
  assert.deepEqual(server.log.filter((l) => /ajxdata|publishLOALetter/.test(l.path)).map((l) => [l.path, l.body.ajaxMode || '', l.body.docId || '', l.body.docType || '']),
    [['/epsn/supply/tds/ajxdata.do', 'updateLoaViewedDataByBidder', '77', '11'], ['/epsn/supply/tds/publishLOALetter.do', '', '', '']]);
});

// ---- H4: "nothing found" only when IREPS says so
test('H4: letters by date - a list page IREPS fails to give keeps the letters already read and says the list was not read in full', async () => {
  const rows = [1, 2].map((n) => ({ no: `P${n}`, oid: `70${n}`, letter: `80${n}`, date: new Date(NOW()), page: n }));
  mk({ inbox: { MyNegotiation: rows, MyCounterOffer: [], MyAdvanceAcceptanceLetter: [] }, inboxPages: { MyNegotiation: 2 }, letterAsPdf: true });
  intercept((m, u, b) => b.get('status') === 'MyNegotiation' && b.get('pageNo') === '2', () => ({ status: 500, type: 'text/html', bytes: enc8('<html><body>boom</body></html>') }));
  const r = await jobs.downloadLettersByDate({ dates: [dmy(NOW())], statuses: ['MyNegotiation'] });
  assert.deepEqual(r.tenders.map((t) => t.tenderNo), ['P1'], 'the letter of page 1 is downloaded, as before');
  assert.match(r.listWarnings.MyNegotiation, /not read in full .*HTTP 500/);
  assert.equal(r.listErrors.MyNegotiation, undefined);
});
test('H4: letters by date - a page that is not the list (no rows, no list form) is an error, never "none for these dates"', async () => {
  mk({ inbox: { MyNegotiation: [{ no: 'Q1', oid: '1', letter: '9', date: new Date(NOW()) }], MyCounterOffer: [], MyAdvanceAcceptanceLetter: [] }, letterAsPdf: true });
  intercept((m, u, b) => u.includes('vendorInboxLink') && b.has('pageNo'), html200('Maintenance', 'IREPS is under maintenance, please visit later.'));
  const r = await jobs.downloadLettersByDate({ dates: [dmy(NOW())], statuses: ['MyNegotiation'] });
  assert.equal(r.tenders.length, 0);
  assert.match(r.listErrors.MyNegotiation, /does not recognise .*Maintenance/);
});
// ---- what the panel's tender view (tender-ui.js, in the real popup.html under jsdom) says after a run
let panelDom = null;
/** Run `fn($)` with popup.html as the page and tender-ui.js loaded in it; the globals are put back afterwards. */
async function withTenderPanel(fn) {
  const { readFileSync } = await import('node:fs');
  panelDom ||= new JSDOM(readFileSync(new URL('../../popup/popup.html', import.meta.url), 'utf8').replace(/<script[^>]*><\/script>/g, ''), { pretendToBeVisual: true });
  const keep = ['document', 'window', 'MutationObserver', 'Event', 'CustomEvent'].map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]);
  const w = panelDom.window;
  Object.assign(globalThis, { document: w.document, window: w, MutationObserver: w.MutationObserver, Event: w.Event, CustomEvent: w.CustomEvent });
  try {
    await import('../tender-ui.js');
    return await fn((id) => w.document.getElementById(id));
  } finally {
    for (const [k, d] of keep) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; }
  }
}
/** Click a run button of the tender view and wait for its result (or error). */
async function clickRun($, id, { from, to } = {}) {
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  $('auto-from').value = iso(from || new Date(NOW()));
  $('auto-to').value = iso(to || new Date(NOW()));
  $(id).click();
  for (let i = 0; i < 500 && (($('tender-result').hidden && $('tender-error').hidden) || $('btn-auto-run').disabled); i++) await sleepMs(10);
}
/** The rows of a result list: [label, value, value's class]. */
const panelRows = ($, id) => [...$(id).children].map((li) => [li.children[0].firstChild?.textContent?.trim() || '', li.children[1].textContent, li.children[1].className]);
test('Panel (1.15): a letter or tabulation found but not downloaded reads "failed" in red, never "none for these dates" / "nothing new"; letters downloaded before say so', () => withTenderPanel(async ($) => {
  mk({ inbox: { MyNegotiation: [], MyCounterOffer: [], MyAdvanceAcceptanceLetter: [{ no: 'L1', oid: '9', letter: '77', date: new Date(NOW()) }] }, loaAck: 'Try Again' });
  await clickRun($, 'btn-letter-loa');
  let rows = panelRows($, 'tender-result-rows');
  assert.deepEqual(rows[0].slice(1), ['1 failed', 'tender-bad'], JSON.stringify(rows));
  assert.deepEqual(rows[1].slice(1), ['LOA: failed', 'tender-bad'], 'the tender row is red');
  assert.match($('tender-result-totals').textContent, /Failed: 1/);
  // the same letter once it was downloaded: the next run says it was downloaded before (known issue 2)
  server.s.loaAck = 'OK';
  await clickRun($, 'btn-letter-loa');
  assert.deepEqual(panelRows($, 'tender-result-rows')[0].slice(1), ['1 downloaded', 'tender-ok']);
  await clickRun($, 'btn-letter-loa');
  rows = panelRows($, 'tender-result-rows');
  assert.deepEqual(rows[0].slice(1), ['1 already downloaded', 'tender-muted'], JSON.stringify(rows));
  // a Financial Tabulation IREPS shows only as a web page: found, not downloaded
  mk({ tenders: [bid('42263731')], tabulationAsHtml: true });
  await clickRun($, 'btn-tab-financial', { from: new Date(2026, 9, 20), to: new Date(2026, 9, 20) });
  rows = panelRows($, 'tender-result-rows');
  assert.deepEqual(rows[0].slice(1), ['1 failed', 'tender-bad'], JSON.stringify(rows));
  assert.deepEqual(rows[1].slice(1), ['Financial Tabulation: failed', 'tender-bad']);
  // NIT Documents: a message IREPS did not open is a failed row, and "Retry failed" is offered (1.3)
  mk({ tenders: [futureT({ no: 'M1', nitId: '1', oid: '10' })], messages: [nitMsg('M1')] });
  intercept((m, u) => u.includes('ViewMessageDetailAction.do'), () => ({ status: 503, type: 'text/html', bytes: enc8('<html><body>Service Unavailable</body></html>') }));
  await clickRun($, 'btn-auto-run');
  rows = panelRows($, 'auto-discovered-rows');
  assert.deepEqual(rows.map((r) => r.slice(1)), [['failed', 'tender-bad']], JSON.stringify(rows));
  assert.equal($('auto-review').hidden, true, 'not "needs review"');
  assert.equal($('btn-auto-retry').hidden, false);
  assert.match($('tender-result-totals').textContent, /Messages not opened: 1/);
  // two railways' tenders with one number: a row each (6.1)
  mk({ tenders: [futureT({ no: '10263703', nitId: '71', oid: '710', dept: 'STORES/N F RLY' }), futureT({ no: '10263703', nitId: '72', oid: '720', dept: 'STORES/EAST CENTRAL RLY' })],
    messages: ['N F RLY', 'EAST CENTRAL RLY'].map((rly) => ({ date: dmy(NOW()), subject: `NIT for STORES/${rly}, Tender Number: 10263703` })) });
  await clickRun($, 'btn-auto-run');
  rows = panelRows($, 'auto-discovered-rows');
  assert.equal(rows.length, 2, JSON.stringify(rows));
  assert.ok(rows.every((r) => r[0] === '10263703' && r[2] === 'tender-ok'), JSON.stringify(rows));
}));
test('H4: NIT Documents - a first My Messages page that is not the inbox is an error; a later one keeps the messages read and says so', async () => {
  const notInbox = (n) => intercept((m, u, b) => b.get('listType') === 'MyMsg' && b.get('pageNo') === String(n), html200('Error', 'Please try again later.'));
  mk({ messages: [nitMsg('Z1')], tenders: [futureT({ no: 'Z1', nitId: '1', oid: '10' })] });
  notInbox(1);
  await assert.rejects(() => autoRun(), (e) => e.code === 'PAGE' && /My Messages page 1/.test(e.message));
  mk({ msgPageSize: 1, messages: [nitMsg('Z1'), nitMsg('Z2')], tenders: [futureT({ no: 'Z1', nitId: '1', oid: '10' }), futureT({ no: 'Z2', nitId: '2', oid: '20' })] });
  notInbox(2);
  const r = await autoRun();
  assert.deepEqual(r.tenders.map((t) => [t.tenderNo, t.status]), [['Z1', 'DOWNLOADED']], 'the NIT of page 1 is downloaded, as before');
  assert.match(r.messages.incomplete, /My Messages page 2/);
});
test('H4: Closed Tenders (one-tender fallback) - an empty page that is not the list keeps the tenders read and says so', async () => {
  mk({ closed: [closed('42263731'), closed('69261051', { page: 2 })] });
  intercept((m, u, b) => b.get('status') === 'MyBidsClosed' && b.get('pageNo') === '2', html200('Busy', 'The server is busy.'));
  const { rows, incomplete } = await closedScan(new Date(2026, 9, 15), new Date(2026, 9, 23));
  assert.deepEqual(rows.map((r) => r.tenderNo), ['42263731']);
  assert.match(incomplete, /does not recognise .*Closed Tenders/);
});
test('H4: Search Tender - a result page that is not one keeps the tenders read, downloads them and says the day was not read to the end', async () => {
  mk({ searchPageSize: 1, tenders: [bid('42263731'), bid('69261051')] });
  intercept((m, u) => m === 'GET' && /advancedSearch\.do\?.*pageNo=2/.test(u), html200('Busy', 'The server is busy.'));
  const r = await auto.runTabulations({ pdfType: 'financialTabulation', from: new Date(2026, 9, 20), to: new Date(2026, 9, 20) });
  assert.deepEqual([r.tabulations.listed, r.tabulations.summary.downloaded], [1, 1]);
  assert.match(r.tabulations.incomplete, /does not recognise .*Search Tender 20\/10\/2026 page 2/);
});
test('H4: Search Tender - fewer tenders read than IREPS counts is said out loud, never taken as the whole day', async () => {
  mk({ tenders: [bid('42263731')] });
  intercept((m, u, b) => m === 'POST' && b.get('submit') === 'Show Results', () => ({ status: 200, type: 'text/html', bytes: resultsPage([resultRow(bid('42263731'))], { total: 3 }) }));
  const r = await auto.runTabulations({ pdfType: 'financialTabulation', from: new Date(2026, 9, 20), to: new Date(2026, 9, 20) });
  assert.equal(r.tabulations.summary.downloaded, 1, 'what was read is still downloaded');
  assert.match(r.tabulations.incomplete, /DocLink read fewer tenders than IREPS listed \(Search Tender 20\/10\/2026: IREPS lists 3 tender\(s\), 1 were read\)/);
});
test('H4: Search Tender - a day IREPS does not answer (HTTP error) is said, and the other days are still read', async () => {
  mk({ tenders: [bid('42263731', { closing: new Date(2026, 9, 21) })] });
  intercept((m, u, b) => m === 'POST' && b.get('dateFrom') === '20/10/2026', () => ({ status: 500, type: 'text/html', bytes: enc8('<html><body>error</body></html>') }));
  const r = await auto.runTabulations({ pdfType: 'financialTabulation', from: new Date(2026, 9, 20), to: new Date(2026, 9, 21) });
  assert.equal(r.tabulations.summary.downloaded, 1);
  assert.match(r.tabulations.incomplete, /Search Tender 20\/10\/2026 page 1: IREPS returned HTTP 500/);
});
test('H4: Search Tender - a page of another search (IREPS\'s count far off, or no tender closing that day) stops the day there and says so', async () => {
  const page2 = (answer) => intercept((m, u) => m === 'GET' && /advancedSearch\.do\?.*pageNo=2/.test(u), () => ({ status: 200, type: 'text/html', bytes: answer }));
  const run20 = () => auto.runTabulations({ pdfType: 'financialTabulation', from: new Date(2026, 9, 20), to: new Date(2026, 9, 20) });
  mk({ searchPageSize: 2, tenders: [bid('42263731'), other('51111111'), bid('69261051')] });
  page2(resultsPage([resultRow(other('59999999'))], { total: 40 }));
  let r = await run20();
  assert.deepEqual([r.tabulations.listed, r.tabulations.summary.downloaded], [1, 1], 'what page 1 showed is still downloaded');
  assert.match(r.tabulations.incomplete, /Search Tender 20\/10\/2026 page 2: IREPS's count changed from 3 to 40, so another search in this IREPS session replaced this one/);
  mk({ searchPageSize: 2, tenders: [bid('42263731'), other('51111111'), bid('69261051')] });
  page2(resultsPage([resultRow(bid('69261051', { closing: new Date(2026, 9, 25) }))], { total: 3 }));
  r = await run20();
  assert.deepEqual([r.tabulations.listed, r.tabulations.summary.downloaded], [1, 1], 'a tender of another day is not taken for this one');
  assert.match(r.tabulations.incomplete, /Search Tender 20\/10\/2026 page 2: none of its tenders closes on 20\/10\/2026, so another search in this IREPS session replaced this one/);
});
/** IREPS cannot be reached for the requests `when` picks: fetch rejects, as Chrome's does on a network failure. */
const unreachable = (when) => { const orig = server.handle.bind(server); server.handle = async (m, u, b) => { if (when(m, u, new URLSearchParams(b || ''))) throw new TypeError('Failed to fetch'); return orig(m, u, b); }; };
test('2.5: Search Tender - a later result page IREPS cannot be reached for keeps the tenders read; the days after it are said not searched', () => quickRetries(async () => {
  mk({ searchPageSize: 1, tenders: [bid('42263731'), bid('69261051'), bid('77261111', { closing: new Date(2026, 9, 21) })] });
  unreachable((m, u) => m === 'GET' && /advancedSearch\.do\?.*pageNo=2/.test(u));
  const r = await auto.runTabulations({ pdfType: 'financialTabulation', from: new Date(2026, 9, 20), to: new Date(2026, 9, 21) });
  assert.deepEqual([r.tabulations.listed, r.tabulations.summary.downloaded], [1, 1], 'the tender of page 1 is downloaded');
  assert.match(r.tabulations.incomplete, /Search Tender 20\/10\/2026 page 2: IREPS could not be reached/);
  assert.match(r.tabulations.incomplete, /Search Tender 21\/10\/2026\.\.21\/10\/2026: not searched, as IREPS stopped answering/);
  assert.ok(!searchPosts().some((l) => l.body.dateFrom === '21/10/2026'), 'nothing more is sent once IREPS stopped answering');
}));
test('2.5: letter lists - a later page IREPS cannot be reached for keeps the letters read and says the list was not read in full (by date, and for one tender)', async () => {
  const loaRows = (no) => [1, 2].map((n) => ({ no: no || `P${n}`, oid: `70${n}`, letter: `80${n}`, date: new Date(NOW() - 3 * D), page: n }));
  const page2 = () => unreachable((m, u, b) => b.get('status') === 'MyAdvanceAcceptanceLetter' && b.get('pageNo') === '2');
  mk({ inbox: { MyNegotiation: [], MyCounterOffer: [], MyAdvanceAcceptanceLetter: loaRows() }, inboxPages: { MyAdvanceAcceptanceLetter: 2 }, letterAsPdf: true });
  page2();
  const r = await jobs.downloadLettersByDate({ dates: [dmy(NOW() - 3 * D)], statuses: ['MyAdvanceAcceptanceLetter'] });
  assert.deepEqual(r.tenders.map((t) => t.tenderNo), ['P1'], 'the letter of page 1 is downloaded');
  assert.match(r.listWarnings.MyAdvanceAcceptanceLetter, /not read in full .*Advance Acceptance Letter list page 2: IREPS could not be reached/);
  mk({ tenders: [T({})], inbox: { MyNegotiation: [], MyCounterOffer: [], MyAdvanceAcceptanceLetter: loaRows('29263265') }, inboxPages: { MyAdvanceAcceptanceLetter: 2 }, letterAsPdf: true });
  page2();
  const c = (await run('29263265', { only: ['loa'] })).categories.loa;
  assert.deepEqual([c.status, c.downloaded], ['PARTIAL', 1], 'the letter of page 1 is downloaded');
  assert.match(c.note, /Advance Acceptance Letter list .* page 2: IREPS could not be reached/);
});
test('2.5: Closed Tenders and My Messages - a later page IREPS cannot be reached for (or fails to give) keeps what was read and says so', async () => {
  const closedPage2 = (m, u, b) => b.get('status') === 'MyBidsClosed' && b.get('pageNo') === '2';
  mk({ closed: [closed('42263731'), closed('69261051', { page: 2 })] });
  unreachable(closedPage2);
  let scan = await closedScan(new Date(2026, 9, 15), new Date(2026, 9, 23));
  assert.deepEqual(scan.rows.map((x) => x.tenderNo), ['42263731']);
  assert.match(scan.incomplete, /Closed Tenders 15\/10\/2026\.\.23\/10\/2026 page 2: IREPS could not be reached/);
  mk({ closed: [closed('42263731'), closed('69261051', { page: 2 })] });
  intercept(closedPage2, () => ({ status: 500, type: 'text/html', bytes: enc8('<html><body>boom</body></html>') }));
  scan = await closedScan(new Date(2026, 9, 15), new Date(2026, 9, 23));
  assert.deepEqual(scan.rows.map((x) => x.tenderNo), ['42263731'], 'an HTTP error on a later page keeps the rows read too');
  assert.match(scan.incomplete, /page 2: IREPS returned HTTP 500/);
  // My Messages: the NIT notices (scanInbox) and NIT Documents (scanMessages)
  mk({ msgPageSize: 1, messages: [nitMsg('Z1'), nitMsg('Z2')] });
  unreachable((m, u, b) => b.get('listType') === 'MyMsg' && b.get('pageNo') === '2');
  const notices = await wf.findNitNotices({ base: 'https://www.ireps.gov.in' }, [dmy(NOW())]);
  assert.deepEqual(notices.map((n) => n.tenderNo), ['Z1']);
  assert.match(notices.incomplete, /My Messages page 2: IREPS could not be reached/);
  const messages = await msgs.scanMessages('https://www.ireps.gov.in', { from: TODAY(), to: TODAY() });
  assert.equal(messages.rows.length, 1);
  assert.match(messages.incomplete, /My Messages page 2: IREPS could not be reached/);
});
test('10.1: a letter list and Closed Tenders stopped at their 60-page limit say so; never a silent partial list', async () => {
  mk({ inbox: { MyNegotiation: [], MyCounterOffer: [], MyAdvanceAcceptanceLetter: Array.from({ length: 61 }, (_, i) => ({ no: `L${i}`, oid: `9${i}`, letter: `7${i}`, date: new Date(NOW()) })) }, inboxPageSize: 1 });
  const probe = { base: 'https://www.ireps.gov.in', ctx: { tenderNo: '' }, inboxCache: new Map(), onProgress: () => {} };
  const list = await wf.scanPostTenderList(probe, 'MyAdvanceAcceptanceLetter', { stopBefore: TODAY() });
  assert.equal(list.entries.length, 60, 'the 60 pages are read');
  assert.match(list.incomplete, /DocLink read 60 pages of the Advance Acceptance Letter list, its page limit, and stopped there/);
  mk({ closed: Array.from({ length: 61 }, (_, i) => closed(`4226${String(i).padStart(4, '0')}`, { page: i + 1 })) });
  const scan = await closedScan(new Date(2026, 9, 15), new Date(2026, 9, 23));
  assert.equal(scan.rows.length, 60);
  assert.match(scan.incomplete, /DocLink read 60 pages of Closed Tenders 15\/10\/2026\.\.23\/10\/2026, its page limit/);
});
test('10.1: inbox scans stopped at their 15-page limit say so (one tender\'s letter list, the My Messages notices)', async () => {
  const mine = Array.from({ length: 16 }, (_, i) => ({ no: '29263265', oid: '107200478', letter: `60${String(i).padStart(2, '0')}`, date: daysAgo(3) }));
  mk({ tenders: [T({})], inbox: { MyNegotiation: [], MyCounterOffer: [], MyAdvanceAcceptanceLetter: mine }, inboxPageSize: 1, letterAsPdf: true });
  const c = (await run('29263265', { only: ['loa'] })).categories.loa;
  assert.deepEqual([c.status, c.downloaded], ['PARTIAL', 15]);
  assert.match(c.note, /DocLink read 15 pages of the Advance Acceptance Letter list \S+\.\.\S+, its page limit/);
  // (each page's message looks different: a page that repeats the one before ends the scan)
  mk({ msgPageSize: 1, messages: Array.from({ length: 16 }, (_, i) => ({ date: dmy(NOW()), subject: `NIT for S${i}, Tender Number: N${i}` })) });
  const notices = await wf.findNitNotices({ base: 'https://www.ireps.gov.in' }, [dmy(NOW())]);
  assert.equal(notices.length, 15);
  assert.match(notices.incomplete, /DocLink read 15 pages of My Messages, its page limit/);
});
test('10.1: My Messages stopped at its 60-page limit says so in `incomplete`, besides `truncated`', async () => {
  mk({ msgPageSize: 1, messages: Array.from({ length: 61 }, (_, i) => ({ date: dmy(NOW()), subject: `Message ${i}` })) });
  const scan = await msgs.scanMessages('https://www.ireps.gov.in', { from: TODAY(), to: TODAY() });
  assert.deepEqual([scan.pagesRead, scan.rows.length, scan.truncated], [60, 60, true]);
  assert.match(scan.incomplete, /DocLink read 60 pages of My Messages, its page limit, and stopped there/);
});
test('M2: each day\'s Search Tender search and result pages wait for the IREPS form lock', async () => {
  const formLock = await import('../../services/ireps-form-lock.js');
  mk({ tenders: [bid('42263731')] });
  let release;
  const held = formLock.withIrepsFormLock(() => new Promise((r) => { release = r; }));
  const p = auto.runTabulations({ pdfType: 'financialTabulation', from: new Date(2026, 9, 20), to: new Date(2026, 9, 20) });
  await sleepMs(50);
  assert.ok(!server.log.some((l) => l.path === '/epsn/search/advancedSearch.do'), 'nothing is searched while another IREPS form sequence holds the lock');
  release();
  await held;
  assert.equal((await p).tabulations.summary.downloaded, 1);
});
test('5.3: a tender search by number and My Messages wait for the IREPS form lock, and never take it twice', async () => {
  const formLock = await import('../../services/ireps-form-lock.js');
  const hold = () => { let release; const held = formLock.withIrepsFormLock(() => new Promise((r) => { release = r; })); return { held, release: () => release() }; };
  // a run that took the lock inside the lock would wait for ever (Web Locks are not re-entrant)
  const settle = async (p) => {
    let timer;
    try {
      return await Promise.race([p, new Promise((_, no) => { timer = setTimeout(() => no(new Error('the run waits for ever: it took the IREPS form lock twice')), 5000); })]);
    } finally {
      clearTimeout(timer);
    }
  };
  mk({ tenders: [T({})] });
  let lock = hold();
  const p = run('29263265', { only: ['tenderPdf'] });
  await sleepMs(50);
  assert.ok(!server.log.some((l) => l.path === '/epsn/search/advancedSearch.do'), 'no tender search while another IREPS form sequence holds the lock');
  lock.release();
  await lock.held;
  assert.equal((await settle(p)).categories.tenderPdf.status, 'DOWNLOADED');
  mk({ messages: [nitMsg('Z1')], tenders: [futureT({ no: 'Z1', nitId: '1', oid: '10' })] });
  lock = hold();
  const q = autoRun();
  await sleepMs(50);
  assert.ok(!server.log.some((l) => l.body.listType === 'MyMsg'), 'My Messages is not read while another sequence holds the lock');
  lock.release();
  await lock.held;
  assert.deepEqual((await settle(q)).tenders.map((t) => t.status), ['DOWNLOADED']);
});
test('H4: a tender search IREPS does not answer (HTTP errors) is "search incomplete", never "not found"', async () => {
  mk({ tenders: [T({})] });
  intercept((m, u, b) => b.get('advancedSearch'), () => ({ status: 500, type: 'text/html', bytes: enc8('<html><body>error</body></html>') }));
  await assert.rejects(() => run(), (e) => e.code === 'SEARCH_INCOMPLETE' && /could not tell whether the tender is in IREPS/.test(e.message));
});
test('4.4: the Search Tender form\'s own notes are not IREPS refusing the search: a page that is no result is "search incomplete", never "not found", and starts no search per department', async () => {
  const kind = (page) => search.classifySearchResponse(core.parseHtml(page));
  assert.equal(kind(new TextDecoder().decode(searchFormPage())), 'other', 'the form page as captured: department list, notes, hidden date-range note');
  assert.equal(kind('<html><body><form>Please select Department <input type=text></form></body></html>'), 'invalid', 'IREPS refusing the search');
  assert.equal(kind(readFileSync(new URL('./fixtures/search-tender-20nov.html', import.meta.url), 'utf8')), 'results');
  mk({ tenders: [T({})] });
  const searches = [];
  intercept((m, u, b) => m === 'POST' && b.get('submit') === 'Show Results' && searches.push(b.get('division')), () => ({ status: 200, type: 'text/html', bytes: searchFormPage() }));
  await assert.rejects(() => run(), (e) => e.code === 'SEARCH_INCOMPLETE' && /could not tell whether the tender is in IREPS/.test(e.message));
  assert.deepEqual([searches.length, [...new Set(searches)].sort()], [12, ['-1', '19']], 'six date ranges, Stores and all departments: no search per department');
});

// ---- H7: a NIT message is done only when every NIT category succeeded
test('H7: NIT Documents retries a NIT whose attachment failed; the next run fetches only what failed, then the message is done', async () => {
  mk({ tenders: [futureT({ no: 'R1', nitId: '1', oid: '10', offer: true, attachments: [...att('r1'), { name: 'r2.pdf', desc: 'B', href: '/ireps/upload/att/r2.pdf' }] })], messages: [nitMsg('R1')], failPaths: ['r2.pdf'] });
  const r1 = await autoRun();
  assert.deepEqual([r1.tenders[0].status, r1.tenders[0].categories.tenderPdf.status, r1.tenders[0].categories.attachments.status], ['FAILED', 'DOWNLOADED', 'PARTIAL']);
  const before = saved.length;
  server.s.failPaths = [];
  const r2 = await autoRun();
  assert.equal(r2.messages.opened, 1, 'the message is opened again');
  assert.equal(r2.tenders[0].status, 'DOWNLOADED');
  assert.deepEqual(savedNames().slice(before), ['DocLink/HOSUR/Tender_R1/NIT_and_Supporting_Documents/r2.pdf'], 'only the attachment that failed: the NIT PDF, the other attachment and My Offer are not downloaded again');
  assert.equal((await autoRun()).messages.opened, 0, 'now done: not opened again');
});
/** Tender C1 with a corrigendum dated today that links two attached documents, and its corrigendum message. */
const corrWithAttachments = (o = {}) => mk({
  tenders: [futureT({ no: 'C1', nitId: '71', oid: '710', corrigenda: [{ id: '7001', cn: '1', date: `${dmy(NOW())} 10:00`, attached: ['First.pdf', 'Second.pdf'] }] })],
  messages: [{ date: dmy(NOW()), subject: 'Issue of Corrigendum towards STORES/X RLY, Tender no: C1' }], ...o,
});
test('2.1: NIT Documents retries a corrigendum whose attached document failed; the next run saves only that attachment (not the corrigendum again), then the message is done', async () => {
  corrWithAttachments({ failPaths: ['Second.pdf'] });
  const r1 = await autoRun();
  assert.deepEqual([r1.tenders[0].status, r1.tenders[0].categories.corrigenda.status], ['FAILED', 'PARTIAL']);
  const before = saved.length;
  server.s.failPaths = [];
  const r2 = await autoRun();
  assert.equal(r2.messages.opened, 1, 'the message is opened again');
  assert.deepEqual([r2.tenders[0].status, r2.tenders[0].categories.corrigenda.status], ['DOWNLOADED', 'DOWNLOADED']);
  assert.deepEqual(savedNames().slice(before), ['DocLink/HOSUR/Tender_C1/Corrigenda/Second.pdf'], 'the corrigendum page (and its .html) and First.pdf are not saved twice');
  assert.equal((await autoRun()).messages.opened, 0, 'now done: not opened again');
});
test('2.1: a corrigendum the user chooses to download again is downloaded in full, also after a run left it without an attachment', async () => {
  corrWithAttachments({ failPaths: ['Second.pdf'] });
  const corrKey = dlog.downloadKey.tender('CORRIGENDA', 'C1', '7001');
  let loggedElsewhere = false; // as when a later run by tender number completed it and logged it
  await withDownloadLog((k) => loggedElsewhere && k === corrKey, async (seen) => {
    assert.equal((await autoRun()).tenders[0].categories.corrigenda.status, 'PARTIAL');
    loggedElsewhere = true;
    server.s.failPaths = [];
    seen.answer = (q) => ({ redownload: q.alreadyDownloaded.map((a) => a.id), sameForRun: false });
    const before = saved.length;
    assert.equal((await autoRun()).tenders[0].categories.corrigenda.status, 'DOWNLOADED');
    assert.equal(seen.prompts.length, 1, 'asked once');
    assert.deepEqual(savedNames().slice(before).map((n) => n.split('/').pop()).sort(), ['Corrigendum_01_C1.html', 'Corrigendum_01_C1.pdf', 'First.pdf', 'Second.pdf'], 'all of it again, as asked');
  });
});

// ---- M21: the ledger is saved as it goes, and stays small
test('M21: the ledger is saved after every tender, so a run cut short keeps what it did', async () => {
  mk({ tenders: [futureT({ no: 'S1', nitId: '1', oid: '10' }), futureT({ no: 'S2', nitId: '2', oid: '20' })], messages: [nitMsg('S1'), nitMsg('S2')] });
  let release;
  const held = new Promise((r) => { release = r; });
  const orig = server.handle.bind(server);
  server.handle = async (m, u, b) => { if (new URLSearchParams(b || '').get('advancedSearch') === 'S2') await held; return orig(m, u, b); };
  const running = autoRun();
  // the NIT mark is the tender number and the railway the message names (6.1)
  const s1 = 'S1|SOUTH EASTERN RLY';
  for (let i = 0; i < 300 && !ledgerOf()?.nit?.[s1]; i++) await sleepMs(10);
  assert.ok(ledgerOf()?.nit?.[s1], 'S1 is recorded while S2 is still being looked for');
  assert.equal(Object.keys(ledgerOf().msgs).length, 1);
  release();
  await running;
  assert.ok(ledgerOf().nit['S2|SOUTH EASTERN RLY']);
});
test('M21: pruning drops old and surplus entries and keeps the newest tender records within the byte budget (the correspondence record stays)', () => {
  const now = Date.parse('2026-11-15T10:00:00Z');
  const iso = (days) => new Date(now - days * D).toISOString();
  const data = { v: 1, nit: { OLD: iso(500), NEW: iso(1) }, corrigenda: {}, letters: {}, msgs: {}, docs: {}, manifests: {}, meta: {} };
  for (let i = 0; i < 6000; i++) data.letters[`NEGOTIATION|T|${i}`] = iso(i % 300);
  for (let i = 0; i < 400; i++) data.manifests[`T${i}`] = { generatedAt: iso(i), files: [{ note: 'x'.repeat(10000) }] };
  data.manifests['pending-correspondence'] = { records: {}, letters: {} };
  ledgerMod.pruneLedger(data, now);
  const L = ledgerMod.LEDGER_LIMITS;
  assert.deepEqual(Object.keys(data.nit), ['NEW'], 'older than 400 days: gone');
  assert.equal(Object.keys(data.letters).length, L.maxPerBucket);
  assert.ok(JSON.stringify(data).length <= L.budgetBytes, `${JSON.stringify(data).length} bytes`);
  assert.ok(data.manifests['pending-correspondence']);
  const kept = Object.keys(data.manifests).filter((k) => k !== 'pending-correspondence');
  assert.ok(kept.length > 0 && kept.length <= L.maxManifests && kept.includes('T0') && !kept.includes('T399'), 'the newest tender records are kept');
});
test('M21: when chrome.storage refuses the ledger (quota full), it is pruned harder and saved again', async () => {
  const writes = [];
  let refuse = true;
  const storage = { get: async () => ({}), set: async (o) => { if (refuse) { refuse = false; throw new Error('QUOTA_BYTES quota exceeded'); } writes.push(JSON.stringify(o).length); } };
  const ledger = await ledgerMod.openLedger('quota-test', storage);
  for (let i = 0; i < 300; i++) ledger.setManifest(`T${i}`, { generatedAt: new Date(Date.now() - i * 1000).toISOString(), files: [{ note: 'y'.repeat(12000) }] });
  assert.equal(await ledger.save(), true);
  assert.equal(writes.length, 1);
  assert.ok(writes[0] <= ledgerMod.LEDGER_LIMITS.budgetBytes / 2 + 200, `${writes[0]} bytes`);
});

// ---- M20: the print tab
test('M20: in the print tab only requests the write guard refuses are failed; every other GET and POST goes on, and the letter prints the same', async () => {
  loaOnly();
  const dbg = fakeDebugger({ pageRequests: [
    { method: 'POST', url: `${BASE}/epsn/supply/tds/ajxdata.do`, postData: 'ajaxMode=updateBidAmount&docId=1', resourceType: 'XHR' },
    { method: 'GET', url: `${BASE}/epsn/home/logout.do`, resourceType: 'Image' },
    { method: 'POST', url: `${BASE}/epsn/supply/tds/ajxdata.do`, postData: 'ajaxMode=getLetterDetails&docId=1', resourceType: 'XHR' },
    { method: 'GET', url: `${BASE}/ireps/images/common/logo.gif`, resourceType: 'Image' },
    { method: 'GET', url: `${BASE}/epsn/home/showHome.do`, resourceType: 'Document' },
  ] });
  try {
    const loa = (await run('29263265', { only: ['loa'] })).categories.loa;
    assert.deepEqual([loa.status, loa.downloaded, loa.warnings], ['DOWNLOADED', 1, []]);
    const files = saved.filter((s) => s.filename.includes('Advance_Acceptance_LOA'));
    assert.deepEqual(files.map((s) => s.filename.split('/').pop()), ['LOA_29263265.pdf']);
    assert.match(new TextDecoder().decode(files[0].bytes), /chrome-print/);
    assert.deepEqual(['p1', 'p2', 'p3', 'p4', 'p5'].map(dbg.outcome), ['failed', 'failed', 'continued', 'continued', 'continued']);
    assert.deepEqual(dbg.cmd('Fetch.enable').patterns, [{ urlPattern: '*', requestStage: 'Request' }], 'every request of the tab is seen, not only documents');
  } finally {
    withoutDebugger();
  }
});
test('M20: a print tab still open when the side panel closes is stopped, detached and closed', async () => {
  const dbg = fakeDebugger({ hang: true });
  try {
    const printing = printMod.printPageToPdf({ url: `${BASE}/epsn/supply/tds/publishLOALetter.do`, bytes: enc8('<html><body>Letter text</body></html>'), contentType: 'text/html' });
    for (let i = 0; i < 100 && !dbg.calls.some((c) => c[0] === 'Fetch.fulfillRequest'); i++) await sleepMs(5);
    await printMod.closePrintTabs();
    await assert.rejects(printing, (e) => e.code === 'PRINT' && /side panel was closed/.test(e.message));
    assert.deepEqual(dbg.tabs.removed, [7]);
    assert.ok(dbg.calls.some((c) => c[0] === 'detach'));
  } finally {
    withoutDebugger();
  }
});
test('10.3: a print tab that could not be handed the letter page is never printed: the letter keeps its text PDF and the run says why', async () => {
  loaOnly();
  const dbg = fakeDebugger({ fulfillError: 'Invalid InterceptionId.' });
  try {
    const loa = (await run('29263265', { only: ['loa'] })).categories.loa;
    assert.deepEqual([loa.status, loa.downloaded], ['DOWNLOADED', 1]);
    assert.ok(!dbg.calls.some((c) => c[0] === 'Page.printToPDF'), 'the blank tab is not printed');
    const files = saved.filter((s) => s.filename.includes('Advance_Acceptance_LOA'));
    assert.deepEqual(files.map((s) => s.filename.split('/').pop()), ['LOA_29263265.pdf']);
    assert.doesNotMatch(new TextDecoder().decode(files[0].bytes), /chrome-print/);
    assert.match(new TextDecoder('latin1').decode(files[0].bytes), /Letter 1461928/, 'the text PDF of the letter');
    assert.notEqual(loa.files[0].printed, true);
    assert.ok(loa.warnings.some((w) => /could not be handed to the print tab \(Invalid InterceptionId\.\)/.test(w)), loa.warnings.join('\n'));
    assert.deepEqual(dbg.tabs.removed, [7]);
  } finally {
    withoutDebugger();
  }
});
const multipartBody = (fields) => `${fields.map(([k, v]) => `------WebKitFormBoundaryQ1\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`).join('')}------WebKitFormBoundaryQ1--\r\n`;
test('10.4: a write action in a JSON or multipart body is refused like one in a form; the "LOA viewed" exception stays the exact form POST', () => {
  const code = (body, path = '/epsn/supply/tds/ajxdata.do') => core.requestRefusal({ method: 'POST', url: BASE + path, body })?.code || 'ok';
  assert.deepEqual([
    code('{"ajaxMode":"updateBidAmount","docId":"1"}'),
    code('{"request":{"items":[{"activity":"saveBid"}]}}'),
    code(multipartBody([['opValue', 'SubmitBid'], ['bidId', '1']])),
    code(multipartBody([['ajaxMode', 'updateLoaViewedDataByBidder'], ['docId', '1488946'], ['docType', '11']])),
    code('{"ajaxMode":"updateLoaViewedDataByBidder","docId":"1488946","docType":"11"}'),
    code(multipartBody([['pdfType', 'technoCommercialTabulation'], ['tenderOID', '1']]), '/epsn/tbo/commTboPdfAction.do'),
  ], ['BLOCKED', 'BLOCKED', 'BLOCKED', 'BLOCKED', 'BLOCKED', 'EXCLUDED']);
  assert.deepEqual([
    code('{"ajaxMode":"getLetterDetails","docId":"1"}'),
    code(multipartBody([['ajaxMode', 'getLetterDetails'], ['docId', '1']])),
    code('ajaxMode=updateLoaViewedDataByBidder&docId=1488946&docType=11'),
    code('[1, 2, 3]'),
    code('{not json'),
  ], ['ok', 'ok', 'ok', 'ok', 'ok']);
  assert.deepEqual(core.bodyFields(multipartBody([['a', '1'], ['b', 'two words']])).slice(-2), [['a', '1'], ['b', 'two words']]);
});
test('10.4: in the print tab a POST body CDP leaves out is read through CDP and checked, or refused when it cannot be read; the letter still prints', async () => {
  loaOnly();
  const ajx = `${BASE}/epsn/supply/tds/ajxdata.do`;
  const b64 = (s) => Buffer.from(s).toString('base64');
  const dbg = fakeDebugger({
    pageRequests: [
      { method: 'POST', url: ajx, postData: '{"ajaxMode":"updateBidAmount","docId":"1"}' },
      { method: 'POST', url: ajx, postData: multipartBody([['ajaxMode', 'submitBid'], ['docId', '1']]) },
      { method: 'POST', url: ajx, postData: '{"ajaxMode":"getLetterDetails","docId":"1"}' },
      { method: 'POST', url: ajx, hasPostData: true, networkId: 'n4' },
      { method: 'POST', url: ajx, hasPostData: true, networkId: 'n5' },
      { method: 'POST', url: ajx, hasPostData: true, networkId: 'n6' },
      { method: 'POST', url: ajx, hasPostData: true },
      { method: 'POST', url: ajx, hasPostData: true, postDataEntries: [{ bytes: b64('opValue=Submit') }, { bytes: b64('Bid&bidId=1') }] },
      { method: 'POST', url: ajx, hasPostData: true, postDataEntries: [{ bytes: b64('ajaxMode=getLetter') }, { bytes: b64('Details&docId=1') }] },
      { method: 'POST', url: `${BASE}/epsn/supply/tds/viewLetter.do` },
    ],
    postData: { n4: 'ajaxMode=getLetterDetails&docId=1', n5: 'activity=saveBid&docId=1' },
  });
  try {
    const loa = (await run('29263265', { only: ['loa'] })).categories.loa;
    assert.deepEqual([loa.status, loa.downloaded, loa.warnings], ['DOWNLOADED', 1, []]);
    assert.match(new TextDecoder().decode(saved.find((s) => s.filename.includes('Advance_Acceptance_LOA')).bytes), /chrome-print/);
    await sleepMs(10);
    assert.deepEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'p10'].map(dbg.outcome),
      ['failed', 'failed', 'continued', 'continued', 'failed', 'failed', 'failed', 'failed', 'continued', 'continued']);
    assert.deepEqual(dbg.calls.filter((c) => c[0] === 'Network.getRequestPostData').map((c) => c[1].requestId), ['n4', 'n5', 'n6'], 'read through CDP when it left the body out');
  } finally {
    withoutDebugger();
  }
});
test('10.4: the letter page in a print tab opens no window: window.open gives nothing, a form or link aimed at a new window is dropped (one aimed at the page or its frame goes on); a window it opens anyway is closed at once', async () => {
  loaOnly();
  const dbg = fakeDebugger({ popup: true });
  try {
    const loa = (await run('29263265', { only: ['loa'] })).categories.loa;
    assert.deepEqual([loa.status, loa.downloaded], ['DOWNLOADED', 1]);
    await sleepMs(10);
    assert.ok(dbg.tabs.removed.includes(8), `the window the page opened is closed (closed: ${dbg.tabs.removed.join()})`);
    // the script the print tab runs in every document before the page's own scripts
    const page = new JSDOM('<html><body><iframe name="content"></iframe><form id="own" action="/x"></form><form id="frame" target="content" action="/y"></form>'
      + '<form id="blank" target="_blank" action="/z"></form><form id="named" target="newWin" action="/w"></form><a id="a1" href="/v" target="_blank">v</a><a id="a2" href="/u">u</a></body></html>', { runScripts: 'outside-only' });
    const w = page.window;
    const sent = [];
    w.HTMLFormElement.prototype.submit = function submit() { sent.push(this.id); };
    w.eval(dbg.cmd('Page.addScriptToEvaluateOnNewDocument').source);
    assert.equal(w.open('/epsn/supply/bid/viewBid.do', 'newWin'), null);
    for (const id of ['own', 'frame', 'blank', 'named']) w.document.getElementById(id).submit();
    assert.deepEqual(sent, ['own', 'frame'], 'only the forms aimed at the page itself or at its frame are sent');
    const followed = (id) => {
      let dropped = null;
      const a = w.document.getElementById(id);
      a.addEventListener('click', (e) => { dropped = e.defaultPrevented; e.preventDefault(); });
      a.click();
      return !dropped;
    };
    assert.deepEqual([followed('a1'), followed('a2')], [false, true], 'a link into a new window is dropped, a link in the page is not');
  } finally {
    withoutDebugger();
  }
});

// ---- M23: during a run only DocLink's own tabs are closed
test('M23: only the tabs DocLink opened are closed (its print tab\'s popups, Chrome opening a file it saved) - never the user\'s own PDF, file, data: or downloads tabs', async () => {
  const listeners = { onCreated: new Set(), onUpdated: new Set(), onActivated: new Set() };
  const removed = [];
  const tabs = {
    query: async () => [{ id: 1, url: `${BASE}/epsn/home/showHome.do` }], update: async () => {}, get: async (id) => ({ id }), remove: async (id) => { removed.push(id); },
    ...Object.fromEntries(Object.entries(listeners).map(([k, set]) => [k, { addListener: (f) => set.add(f), removeListener: (f) => set.delete(f) }])),
  };
  core.noteOwnTab(7); // a DocLink print tab
  await core.createSaver({ accountLabel: 'HOSUR', tenderNo: 'G1' }).save('NIT_and_Supporting_Documents', 'viewNitPdf_1.pdf', PDF());
  const stop = viewCommon.guardTabs({ tabs });
  await sleepMs(0);
  const create = (tab) => listeners.onCreated.forEach((f) => f(tab));
  // the user's own
  create({ id: 10, url: 'file:///C:/Users/tester/Documents/own.pdf' });
  create({ id: 11, openerTabId: 1, url: `${BASE}/ireps/upload/att/Spec.pdf` });
  create({ id: 12, url: 'chrome://downloads/' });
  create({ id: 13, url: 'data:application/pdf;base64,JVBERi0=' });
  create({ id: 14, url: 'blob:https://example.com/0f8f' });
  // DocLink's: a popup of its print tab, Chrome showing the PDF it saved (and the "(1)" twin of a later run), a tab that popup opened
  create({ id: 20, openerTabId: 7, url: `${BASE}/ireps/supply/pdfdocs/112026/1/viewNitPdf_1.pdf` });
  create({ id: 21, url: 'file:///C:/Users/tester/Downloads/DocLink/HOSUR/Tender_G1/NIT_and_Supporting_Documents/viewNitPdf_1.pdf' });
  create({ id: 22, url: 'file:///C:/Users/tester/Downloads/DocLink/HOSUR/Tender_G1/NIT_and_Supporting_Documents/viewNitPdf_1%20(1).pdf' });
  create({ id: 23, openerTabId: 20, url: 'about:blank' });
  await sleepMs(0);
  stop();
  assert.deepEqual(removed.sort((a, b) => a - b), [20, 21, 22, 23]);
});

// ---- L11: the name Chrome actually used
test('L11: a file of an earlier run is kept; the new one is recorded under the name Chrome gave it (names and folders asked for are unchanged)', async () => {
  mk({ tenders: [T({})] });
  const first = (await run('29263265', { only: ['tenderPdf'] })).categories.tenderPdf.files[0];
  const second = (await run('29263265', { only: ['tenderPdf'] })).categories.tenderPdf.files[0];
  assert.deepEqual(savedNames(), Array(2).fill('DocLink/HOSUR/Tender_29263265/NIT_and_Supporting_Documents/viewNitPdf_5569207.pdf'), 'the same name and folder asked for, as before');
  assert.deepEqual([first.fileName, first.relPath, first.requestedPath], ['viewNitPdf_5569207.pdf', 'NIT_and_Supporting_Documents/viewNitPdf_5569207.pdf', undefined]);
  assert.deepEqual([second.fileName, second.relPath, second.requestedPath], ['viewNitPdf_5569207 (1).pdf', 'NIT_and_Supporting_Documents/viewNitPdf_5569207 (1).pdf', 'NIT_and_Supporting_Documents/viewNitPdf_5569207.pdf']);
});

// ---- L12: tests that can fail, storage, network retry
test('L12: the NIT, corrigendum and letter jobs never request a tabulation, even when the tender row and Closed Tenders show both', async () => {
  const today = dmy(NOW());
  mk({
    tenders: [futureT({ no: 'J1', nitId: '61', oid: '610', offer: true, attachments: att('j1'), corrigenda: [{ id: '7', cn: '1', date: `${today} 09:00` }] })],
    closed: [closed('J1', { nitId: '61', oid: '610', closing: new Date(NOW() - 2 * D) })],
    messages: [nitMsg('J1'), { date: today, subject: 'Issue of Corrigendum towards STORES/X RLY, Tender no: J1' }],
    inbox: { MyNegotiation: [{ no: 'J1', oid: '610', letter: '71', date: new Date(NOW()) }], MyCounterOffer: [{ no: 'J1', oid: '610', letter: '73', date: new Date(NOW()) }], MyAdvanceAcceptanceLetter: [{ no: 'J1', oid: '610', letter: '72', date: new Date(NOW()) }] },
    letterAsPdf: true,
  });
  await autoRun();
  await jobs.downloadLettersByDate();
  await jobs.downloadTodaysCorrigenda();
  await jobs.downloadNewNits();
  const names = savedNames().map((n) => n.replace('DocLink/HOSUR/Tender_J1/', ''));
  for (const want of ['NIT_and_Supporting_Documents/viewNitPdf_61.pdf', 'NIT_and_Supporting_Documents/j1.pdf', 'My_Offer/My_Offer_J1.pdf', 'Corrigenda/Corrigendum_01_J1.pdf', 'Negotiation/Negotiation_J1_71.pdf', 'Counter_Offers/Counter_Offer_J1_73.pdf', 'Advance_Acceptance_LOA/LOA_J1.pdf']) {
    assert.ok(names.includes(want), `the jobs ran: ${want} missing\n${names.join('\n')}`);
  }
  const tabulation = (l) => (l.path === '/epsn/tbo/commTboPdfAction.do' && !/^offer$/i.test(l.query.pdfType || l.body.pdfType || '')) || /-TAB-|tabulation/i.test(l.path) || l.body.status === 'MyBidsClosed' || l.body.listType === 'MyBidsClosed';
  assert.deepEqual(server.log.filter(tabulation).map((l) => `${l.method} ${l.path}`), []);
  assert.ok(!server.excludedHit);
});
test('L12: no password / cookie / token is stored - every tender file is checked, including the ones that write storage, and so is what the jobs store', async () => {
  const fs = await import('node:fs');
  const dir = new URL('../', import.meta.url);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  assert.ok(['tender-ledger.js', 'tender-pending.js', 'tender-jobs.js', 'tender-auto.js', 'tender-ecm.js', 'tender-print.js'].every((f) => files.includes(f)), files.join(','));
  const storageUsers = [];
  for (const f of files) {
    const src = fs.readFileSync(new URL(f, dir), 'utf8');
    assert.ok(!/localStorage|sessionStorage|document\.cookie|chrome\.cookies/.test(src), `${f} reads cookies or web storage`);
    if (/chrome\??\.storage|storage\.(?:get|set|remove)\(/.test(src)) storageUsers.push(f);
  }
  // the ledger is the only writer of extension storage; tender-ecm.js only reads the Save to choice
  assert.deepEqual(storageUsers.sort(), ['tender-ecm.js', 'tender-ledger.js']);
  assert.ok(!/\.set\(/.test(fs.readFileSync(new URL('tender-ecm.js', dir), 'utf8')));
  // what the jobs store, from pages that carry a Struts token, a session id and a password field
  const today = dmy(NOW());
  mk({
    tenders: [futureT({ no: 'K1', nitId: '81', oid: '810', offer: true, attachments: att('k1'), corrigenda: [{ id: '8', cn: '1', date: `${today} 09:00` }] })],
    messages: [nitMsg('K1')], closed: [closed('K1', { nitId: '81', oid: '810', closing: new Date(2026, 9, 20) })],
    inbox: { MyNegotiation: [{ no: 'K1', oid: '810', letter: '91', date: new Date(NOW()) }], MyCounterOffer: [], MyAdvanceAcceptanceLetter: [{ no: 'K1', oid: '810', letter: '92', date: new Date(NOW()) }] },
    letterAsPdf: true,
  });
  const orig = server.handle.bind(server);
  const SECRET = '<input type="hidden" name="org.apache.struts.taglib.html.TOKEN" value="SECRETTOKEN0a1b2c3d"><input type="password" name="password" value="SECRETPASSWORD"><a href="/epsn/x.do;jsessionid=SECRETSESSION">x</a>';
  server.handle = async (m, u, b) => {
    const r = await orig(m, u, b);
    if (!/html/.test(r.type)) return r;
    return { ...r, bytes: enc8(new TextDecoder().decode(r.bytes).replace(/<\/form>/i, `${SECRET}</form>`).replace(/<\/body>/i, `${SECRET}</body>`)) };
  };
  await autoRun();
  await auto.runLetterType({ status: 'MyNegotiation', from: TODAY(), to: TODAY() });
  await auto.runLetterType({ status: 'MyAdvanceAcceptanceLetter', from: TODAY(), to: TODAY() });
  await auto.runTabulations({ pdfType: 'financialTabulation', from: new Date(2026, 9, 15), to: new Date(2026, 9, 23) });
  assert.ok(server.log.some((l) => l.body['org.apache.struts.taglib.html.TOKEN'] === 'SECRETTOKEN0a1b2c3d'), 'the token was on the pages (and sent back with the forms, as IREPS needs)');
  const stored = JSON.stringify(store);
  assert.ok(ledgerOf() && Object.keys(ledgerOf().manifests).length > 0, 'the jobs stored their records');
  assert.doesNotMatch(stored, /SECRET|JSESSIONID|password|cookie|struts/i);
});
test('L12: a GET that cannot reach IREPS is tried again (1s, then 3s); a POST is not', async () => {
  core.fetchSettings.netRetryMs = [5, 5];
  mk({ tenders: [T({})], inbox: { MyNegotiation: [], MyCounterOffer: [], MyAdvanceAcceptanceLetter: [{ no: '29263265', oid: '107200478', letter: '1461928', date: daysAgo(5) }] }, letterAsPdf: true });
  const shim = globalThis.fetch;
  const tries = {};
  globalThis.fetch = (url, init = {}) => {
    const p = new URL(String(url).replace('https://ext.invalid/', `${BASE}/`)).pathname;
    tries[p] = (tries[p] || 0) + 1;
    if (/viewNitPdf_|publishLOALetter/.test(p) && tries[p] === 1) return Promise.reject(new TypeError('Failed to fetch'));
    return shim(url, init);
  };
  try {
    const c = (await run('29263265', { only: ['tenderPdf', 'loa'] })).categories;
    assert.equal(c.tenderPdf.status, 'DOWNLOADED', 'the GET was tried again');
    assert.equal(tries['/ireps/supply/pdfdocs/112026/107200478/viewNitPdf_5569207.pdf'], 2);
    assert.equal(c.loa.status, 'FAILED', 'the POST was not repeated');
    assert.equal(tries['/epsn/supply/tds/publishLOALetter.do'], 1);
    assert.match(c.loa.files[0].error, /could not reach/);
  } finally {
    globalThis.fetch = shim;
    core.fetchSettings.netRetryMs = [1000, 3000];
  }
});

// =========================== scheduled downloads, Phase 2 (tender-shared-run.js) ===========================
const sharedRun = await import('../tender-shared-run.js');
/** Fake hooks of services/scheduler/shared-run-hooks.js tenderHooks: `taken` keys are skipped, `refuse` makes the ECM refuse. */
function fakeShared({ taken = [], failReserve = false, refuse = false } = {}) {
  const calls = { reserved: [], ecm: [], saved: [], failed: [] };
  const hooks = {
    reserveDocuments: async (keys) => {
      calls.reserved.push(...keys);
      if (failReserve) throw Object.assign(new Error('backend down'), { code: 'SCHEDULE_BACKEND_UNAVAILABLE' });
      return { granted: new Set(keys.filter((k) => !taken.includes(k))), taken: new Map(keys.filter((k) => taken.includes(k)).map((k) => [k, { reason: 'already_saved_for_account', by: 'Priya' }])) };
    },
    ecmSink: {
      save: async (doc, saveLocally) => {
        calls.ecm.push({ ...doc, hadLocalFallback: typeof saveLocally === 'function' });
        if (refuse) throw Object.assign(new Error('ECM refused'), { code: 'ECM_REFUSED' });
        return { ecm: { status: 'stored', uid: `u${calls.ecm.length}`, site: 'hosur' }, local: null };
      },
    },
    documentSaved: async (record) => { calls.saved.push(record); },
    documentFailed: (failure) => { calls.failed.push(failure); },
  };
  return { hooks, calls };
}
const scheduledCo = () => mk({ tenders: [T({})], inbox: { MyNegotiation: [], MyCounterOffer: [{ no: '29263265', oid: '107200478', letter: '1461275', date: daysAgo(12) }], MyAdvanceAcceptanceLetter: [] }, letterAsPdf: true });
const coKey = dlog.downloadKey.tender('COUNTER_OFFER', '29263265', '1461275');
async function scheduled(shared, fn) {
  sharedRun.beginSharedRun(shared.hooks);
  try {
    return await fn();
  } finally {
    sharedRun.endSharedRun();
  }
}
const coRun = () => auto.runLetterType({ status: 'MyCounterOffer', from: daysAgo(13), to: daysAgo(0) });

test('Scheduled run: each letter is reserved first, goes to the ECM only (no local fallback) and is reported', async () => {
  scheduledCo();
  const shared = fakeShared();
  const r = await scheduled(shared, coRun);
  assert.equal(r.letters.summary.newLetters, 1);
  assert.deepEqual(shared.calls.reserved, [coKey]);
  assert.equal(shared.calls.ecm.length, 1);
  assert.equal(shared.calls.ecm[0].kind, 'co');
  assert.deepEqual(saved, [], 'nothing was saved to Downloads');
  assert.deepEqual(shared.calls.saved.map((x) => [x.doc_key, x.destination, x.ecm.uid]), [[coKey, 'ecm', 'u1']]);
  assert.ok(Object.keys(store).some((k) => k.includes('#scheduled')), 'the scheduled run keeps its own ledger');
});
test('Scheduled run: a letter anyone already saved for the account is skipped without being fetched', async () => {
  scheduledCo();
  const shared = fakeShared({ taken: [coKey] });
  const r = await scheduled(shared, coRun);
  assert.equal(r.letters.summary.newLetters, 0);
  assert.ok(!server.log.some((l) => l.path.endsWith('publishCounterOfferLetter.do')), 'the letter was not opened');
  assert.deepEqual([shared.calls.ecm.length, saved.length, shared.calls.saved.length], [0, 0, 0]);
});
test('Scheduled run: an ECM refusal fails the letter; it is never saved locally', async () => {
  scheduledCo();
  const shared = fakeShared({ refuse: true });
  await scheduled(shared, coRun);
  assert.equal(shared.calls.ecm.length, 1);
  assert.deepEqual([saved.length, shared.calls.saved.length], [0, 0]);
});
test('Scheduled run: a document that fails is reported to the scheduler with its key, its name and the reason', async () => {
  scheduledCo();
  const shared = fakeShared({ refuse: true });
  const r = await scheduled(shared, coRun);
  assert.equal(shared.calls.failed.length, 1);
  const f = shared.calls.failed[0];
  assert.deepEqual([f.key, f.code, f.detail], [coKey, 'ECM_REFUSED', 'ECM refused']);
  assert.match(f.doc, /^Tender 29263265 - /, f.doc);
  const file = r.letters.tenders[0].categories.counterOffer.files.find((x) => x.status === 'FAILED');
  assert.deepEqual([file.error, file.code], [f.detail, f.code], 'the failed file says what was reported, so the run lists it once');
});
test('Scheduled run: a document saved is never reported as failed', async () => {
  scheduledCo();
  const shared = fakeShared();
  await scheduled(shared, coRun);
  assert.deepEqual(shared.calls.failed, []);
});
test('Scheduled run: a reservation that cannot be made fetches nothing', async () => {
  scheduledCo();
  const shared = fakeShared({ failReserve: true });
  await scheduled(shared, coRun);
  assert.ok(!server.log.some((l) => l.path.endsWith('publishCounterOfferLetter.do')));
  assert.deepEqual([shared.calls.ecm.length, saved.length], [0, 0]);
});

// ---- how a scheduled tender run ends (done / partial / failed), as tender/schedule-runner.js computes it
const sharedHooksMod = await import('../../services/scheduler/shared-run-hooks.js');
const tenderRunner = await import('../../services/scheduler/tender-runner.js');
/**
 * A scheduled run as schedule-runner.js runs it: the real shared hooks on a fake Recon Engine (`taken`: keys
 * someone saved) and a fake ECM, the job, then the slot's outcome. -> { result, error, outcome, api }
 */
async function scheduledOutcome(job, { taken = [] } = {}) {
  const api = { reserved: [], completed: [] };
  api.reserve = async (req) => { api.reserved.push(...req.keys); return { granted: req.keys.filter((k) => !taken.includes(k)), taken: Object.fromEntries(req.keys.filter((k) => taken.includes(k)).map((k) => [k, { status: 'done', by: { name: 'Priya' } }])) }; };
  api.complete = async (req) => { api.completed.push(req); return {}; };
  const hooks = sharedHooksMod.createSharedRunHooks({ api, claimId: 'c1', account: { irepsAccountId: '833', operatingUnit: 'HOSUR' }, isClaimLive: () => true, sleep: async () => {},
    uploadEcm: async (doc) => ({ uid: `u-${doc.filename}`, site: 'hosur', path: '/ECM/Hosur/Tenders', deduplicated: false }) });
  let result = null;
  let error = null;
  sharedRun.beginSharedRun(hooks.tenderHooks);
  try {
    result = await job();
  } catch (e) {
    error = { code: e.code || 'UNKNOWN', message: e.message };
  } finally {
    sharedRun.endSharedRun();
  }
  const counts = await hooks.finishTenderRun({ stopped: tenderRunner.stoppedCode(result, error) });
  return { result, error, api, outcome: tenderRunner.tenderRunOutcome({ result, error, counts, details: hooks.details() }) };
}
const letterRun = (status) => () => auto.runLetterType({ status, from: new Date(NOW()), to: new Date(NOW()) });
const tabulationRun = (from, to) => async () => {
  const job = await jobs.beginJob({});
  return { tabulations: await jobs.downloadTabulationsByDate({ from, to, job }) };
};
test('Scheduled run: a letter list read only in part, or one IREPS did not open, never ends "done"; the list is named (known issue 1, 1.5)', async () => {
  const rows = [1, 2].map((n) => ({ no: `P${n}`, oid: `70${n}`, letter: `80${n}`, date: new Date(NOW()), page: n }));
  mk({ inbox: { MyNegotiation: rows, MyCounterOffer: [], MyAdvanceAcceptanceLetter: [] }, inboxPages: { MyNegotiation: 2 }, letterAsPdf: true });
  intercept((m, u, b) => b.get('status') === 'MyNegotiation' && b.get('pageNo') === '2', () => ({ status: 500, type: 'text/html', bytes: enc8('<html><body>boom</body></html>') }));
  const inPart = (await scheduledOutcome(letterRun('MyNegotiation'))).outcome;
  assert.deepEqual([inPart.outcome, inPart.code, inPart.result.saved], ['partial', 'SCHEDULE_LIST_INCOMPLETE', 1], JSON.stringify(inPart));
  assert.match(inPart.result.warnings[0], /^Negotiation letter list: The Negotiation list was not read in full .*HTTP 500/);
  mk({ inbox: { MyNegotiation: rows, MyCounterOffer: [], MyAdvanceAcceptanceLetter: [] }, letterAsPdf: true });
  intercept((m, u, b) => u.includes('vendorInboxLink') && b.has('pageNo'), html200('Maintenance', 'IREPS is under maintenance, please visit later.'));
  const notOpened = (await scheduledOutcome(letterRun('MyNegotiation'))).outcome;
  assert.deepEqual([notOpened.outcome, notOpened.code], ['failed', 'SCHEDULE_LIST_INCOMPLETE'], JSON.stringify(notOpened));
  assert.match(notOpened.result.warnings[0], /^Negotiation letter list: Could not read the Negotiation page/);
});
test('Scheduled run: IREPS not answering its home page during a letters run stops the run; the tender is named, the rest skipped, never "done" (known issue 1)', () => quickRetries(async () => {
  // one time for all three letters: letters a millisecond apart were listed in another order (a flaky test)
  const at = NOW();
  mk({ inbox: { MyNegotiation: [], MyCounterOffer: ['CO1', 'CO2', 'CO3'].map((no, i) => ({ no, oid: `90${i}`, letter: `91${i}`, date: new Date(at) })), MyAdvanceAcceptanceLetter: [] }, letterAsPdf: true });
  const orig = server.handle.bind(server);
  let lettersServed = 0;
  server.handle = async (m, u, b) => {
    if (u.includes('publishCounterOfferLetter.do')) lettersServed++;
    // once the first tender's letter is saved, IREPS answers its home page (the account check) with 503
    if (u.includes('showHome.do') && lettersServed >= 1) return { status: 503, type: 'text/html', bytes: enc8('<html><body>Service Unavailable</body></html>') };
    return orig(m, u, b);
  };
  const { result, outcome } = await scheduledOutcome(letterRun('MyCounterOffer'));
  const l = result.letters;
  assert.equal(l.aborted?.code, 'IREPS_UNAVAILABLE', 'the run stopped');
  assert.deepEqual(l.tenders.map((t) => [t.tenderNo, t.status || 'DOWNLOADED']), [['CO1', 'DOWNLOADED'], ['CO2', 'FAILED'], ['CO3', 'SKIPPED']]);
  assert.equal(lettersServed, 1, 'no other tender was tried while IREPS was down');
  assert.deepEqual([outcome.outcome, outcome.code, outcome.result.saved], ['partial', 'IREPS_UNAVAILABLE', 1], JSON.stringify(outcome));
  assert.deepEqual(outcome.result.failures.map((f) => [f.doc, f.code]), [['Tender CO2', 'IREPS_UNAVAILABLE'], ['Tender CO3', 'IREPS_UNAVAILABLE']]);
  assert.match(outcome.result.detail, /IREPS is not responding/);
}));
test('Scheduled run: tabulations - a tender whose step failed is named, and a closing day not read to its end makes the run partial (1.4)', () => quickRetries(async () => {
  mk({ tenders: [bid('42263731'), bid('69261051')] });
  const orig = server.handle.bind(server);
  let tabsServed = 0;
  server.handle = async (m, u, b) => {
    if (u.includes('commTboPdfAction.do')) tabsServed++;
    if (u.includes('showHome.do') && tabsServed >= 2) return { status: 503, type: 'text/html', bytes: enc8('<html><body>Service Unavailable</body></html>') };
    return orig(m, u, b);
  };
  const day = new Date(2026, 9, 20);
  const stopped = await scheduledOutcome(tabulationRun(day, day));
  assert.deepEqual(stopped.result.tabulations.tenders.map((t) => [t.tenderNo, t.status || 'DOWNLOADED']), [['42263731', 'DOWNLOADED'], ['69261051', 'FAILED']]);
  assert.deepEqual([stopped.outcome.outcome, stopped.outcome.code, stopped.outcome.result.saved], ['partial', 'IREPS_UNAVAILABLE', 2], JSON.stringify(stopped.outcome));
  assert.deepEqual(stopped.outcome.result.failures.map((f) => f.doc), ['Tender 69261051']);
  mk({ searchPageSize: 1, tenders: [bid('42263731'), bid('69261051')] });
  intercept((m, u) => m === 'GET' && /advancedSearch\.do\?.*pageNo=2/.test(u), html200('Busy', 'The server is busy.'));
  const short = (await scheduledOutcome(tabulationRun(day, day))).outcome;
  assert.deepEqual([short.outcome, short.code, short.result.saved], ['partial', 'SCHEDULE_LIST_INCOMPLETE', 2], JSON.stringify(short));
  assert.match(short.result.warnings[0], /Search Tender 20\/10\/2026 page 2/);
}));
test('Scheduled run: NIT Documents - a message IREPS did not open is a failure, opened again next time; never "could not be matched to a tender" (1.3)', async () => {
  mk({ tenders: [futureT({ no: 'M1', nitId: '1', oid: '10' })], messages: [nitMsg('M1')] });
  let busy = true;
  intercept((m, u) => busy && u.includes('ViewMessageDetailAction.do'), () => ({ status: 503, type: 'text/html', bytes: enc8('<html><body>Service Unavailable</body></html>') }));
  const first = await scheduledOutcome(() => autoRun());
  assert.deepEqual([first.result.failedMessages.length, first.result.review.length, first.result.summary.failedMessages], [1, 0, 1]);
  assert.deepEqual([first.outcome.outcome, first.outcome.code], ['failed', 'SCHEDULE_DOWNLOAD_FAILED'], JSON.stringify(first.outcome));
  assert.match(first.outcome.result.failures[0].doc, /^Message of \d{2}\/\d{2}\/\d{4}: NIT for STORES-PCMM\/SOUTH EASTERN RLY, Tender Number: M1$/);
  assert.equal(first.outcome.result.failures[0].code, 'SCHEDULE_IREPS_ERROR');
  assert.ok(!(first.outcome.result.warnings || []).some((w) => /could not be matched/.test(w)));
  busy = false;
  const second = await scheduledOutcome(() => autoRun());
  assert.equal(second.result.messages.opened, 1, 'the message is opened again');
  assert.deepEqual([second.outcome.outcome, second.result.tenders[0].status], ['done', 'DOWNLOADED'], JSON.stringify(second.outcome));
});
test('Scheduled run: NIT Documents leaves My Offer out (the ECM has no kind for it), says so once, and the NIT is done (2.4); a manual run still downloads it', async () => {
  mk({ tenders: [futureT({ no: 'O1', nitId: '1', oid: '10', offer: true }), futureT({ no: 'O2', nitId: '2', oid: '20', offer: true })], messages: [nitMsg('O1'), nitMsg('O2')] });
  const first = await scheduledOutcome(() => autoRun());
  assert.ok(!server.log.some((l) => l.path === '/epsn/tbo/commTboPdfAction.do'), 'My Offer is not requested');
  assert.deepEqual(first.result.tenders.map((t) => [t.tenderNo, t.status, Object.keys(t.categories).sort().join()]), [['O1', 'DOWNLOADED', 'attachments,tenderPdf'], ['O2', 'DOWNLOADED', 'attachments,tenderPdf']]);
  assert.deepEqual([first.outcome.outcome, first.outcome.result.warnings], ['done', [auto.MY_OFFER_NOT_SCHEDULED]], JSON.stringify(first.outcome));
  assert.equal((await scheduledOutcome(() => autoRun())).result.messages.opened, 0, 'the NIT is done: its message is not opened every hour');
  mk({ tenders: [futureT({ no: 'O1', nitId: '1', oid: '10', offer: true })], messages: [nitMsg('O1')] });
  const manual = await autoRun();
  assert.equal(manual.tenders[0].categories.myOffer.status, 'DOWNLOADED');
  assert.deepEqual(manual.notes, []);
});
test('Scheduled run: a letter saved while IREPS\'s tender search did not answer is saved without the ECM tender date, says so, and the search is tried again (2.6)', async () => {
  mk({ tenders: [T({ no: 'LD1', nitId: '81', oid: '810', closing: new Date(NOW() - 5 * D) })], inbox: { MyNegotiation: [], MyCounterOffer: [], MyAdvanceAcceptanceLetter: [{ no: 'LD1', oid: '5003', letter: '31', date: new Date(NOW()) }] }, letterAsPdf: true });
  let searchDown = true;
  let busySearches = 0;
  intercept((m, u, b) => searchDown && m === 'POST' && b.get('advancedSearch') === 'LD1' && ++busySearches > 0, () => ({ status: 503, type: 'text/html', bytes: enc8('<html><body>busy</body></html>') }));
  const { result, outcome } = await scheduledOutcome(letterRun('MyAdvanceAcceptanceLetter'));
  assert.match(result.letters.tenders[0].tenderDateProblem, /tender date was left blank: IREPS's tender search did not answer/);
  assert.deepEqual([outcome.outcome, outcome.result.saved], ['done', 1], 'the letter itself is saved');
  assert.match(outcome.result.warnings[0], /^The ECM tender date was left blank for tender LD1/);
  // within one job, a search that got no answer is tried again, and is not kept as "no closing date"
  const job = { base: BASE };
  const unanswered = [];
  const before = busySearches;
  assert.equal(await jobs.closingDateFor(job, 'LD1', () => {}, { onUnanswered: (why) => unanswered.push(why) }), '');
  const perTry = before / 2;
  assert.equal(busySearches - before, 2 * perTry, 'the search was tried twice');
  assert.equal(unanswered.length, 1);
  searchDown = false;
  assert.match(await jobs.closingDateFor(job, 'LD1'), /^\d{2}\/\d{2}\/\d{4}/, 'IREPS answers now: the date is found, not the blank of the failed search');
});
test('Scheduled run (5.10): when IREPS stops answering at the account check after the letter was reserved, it is reported failed with that reason', () => quickRetries(async () => {
  scheduledCo();
  const shared = fakeShared();
  const orig = server.handle.bind(server);
  let home = 0;
  // the job's own check and the one before the letter's list pass; the re-check after the reservation finds IREPS busy
  server.handle = async (m, u, b) => (u.includes('showHome.do') && ++home >= 3 ? { status: 503, type: 'text/html', bytes: enc8('<html><body>Service Unavailable</body></html>') } : orig(m, u, b));
  await scheduled(shared, coRun);
  assert.deepEqual(shared.calls.reserved, [coKey], 'the letter was reserved');
  assert.ok(!server.log.some((l) => l.path.endsWith('publishCounterOfferLetter.do')), 'and not fetched');
  assert.deepEqual(shared.calls.failed.map((f) => [f.key, f.code]), [[coKey, 'IREPS_UNAVAILABLE']], 'never "reserved, but no error was reported"');
  assert.match(shared.calls.failed[0].detail, /IREPS is not responding/);
}));
test('Scheduled run (5.10): a tender step whose account re-check fails after its reservation reports the document failed, and its FAILED file says the same with the same code', () => quickRetries(async () => {
  mk({ tenders: [T({})] });
  const shared = fakeShared();
  const orig = server.handle.bind(server);
  let home = 0;
  // the run's start and the step's own check pass; the re-check after the NIT is reserved finds IREPS busy
  server.handle = async (m, u, b) => (u.includes('showHome.do') && ++home >= 3 ? { status: 503, type: 'text/html', bytes: enc8('<html><body>Service Unavailable</body></html>') } : orig(m, u, b));
  const c = (await scheduled(shared, () => run('29263265', { only: ['tenderPdf'] }))).categories.tenderPdf;
  const nitKey = dlog.downloadKey.tender('TENDER_PDF', '29263265', '5569207');
  assert.deepEqual(shared.calls.reserved, [nitKey]);
  assert.ok(!server.log.some((l) => /viewNitPdf_/.test(l.path)), 'the NIT is not fetched');
  assert.deepEqual(shared.calls.failed.map((f) => [f.key, f.code]), [[nitKey, 'IREPS_UNAVAILABLE']]);
  assert.deepEqual([c.status, c.files[0].code, c.files[0].error], ['FAILED', 'IREPS_UNAVAILABLE', shared.calls.failed[0].detail], 'one failure, told the same way twice');
}));
test('Scheduled run (2.1): a corrigendum whose attached document fails is released as failed, never as saved; the next run reserves it again and uploads only what was missing', async () => {
  const { createSharedRunHooks } = await import('../../services/scheduler/shared-run-hooks.js');
  corrWithAttachments({ failPaths: ['Second.pdf'] });
  // the Recon Engine's document status for the account, and what each run reported
  const status = new Map();
  const reported = [];
  const api = {
    reserve: async ({ keys }) => {
      const granted = keys.filter((k) => status.get(k) !== 'done');
      for (const k of granted) status.set(k, 'in_progress');
      return { granted, taken: Object.fromEntries(keys.filter((k) => !granted.includes(k)).map((k) => [k, { status: 'done', by: null, at: null }])) };
    },
    complete: async ({ done, failed }) => {
      reported.push({ done: done.map((x) => x.doc_key), failed: failed.map((f) => [f.doc_key, f.code]) });
      for (const x of done) status.set(x.doc_key, 'done');
      for (const f of failed) status.set(f.doc_key, 'failed');
      return { done: done.length, failed: failed.length };
    },
  };
  const uploads = [];
  const uploadEcm = async (doc) => { uploads.push(doc.filename); return { uid: `u${uploads.length}`, site: 'hosur', path: `/x/${doc.filename}`, deduplicated: false }; };
  const told = []; // what the tender code reported failed, as it sent it
  const scheduledRun = async () => {
    const hooks = createSharedRunHooks({ api, claimId: 'c1', account: { irepsAccountId: '833', operatingUnit: 'HOSUR' }, isClaimLive: () => true, uploadEcm });
    reported.length = 0;
    uploads.length = 0;
    told.length = 0;
    sharedRun.beginSharedRun({ ...hooks.tenderHooks, documentFailed: (f) => { told.push(f); hooks.tenderHooks.documentFailed(f); } });
    let result;
    try {
      result = await autoRun();
    } finally {
      sharedRun.endSharedRun();
    }
    return { ...(await hooks.finishTenderRun()), result };
  };
  const corrKey = dlog.downloadKey.tender('CORRIGENDA', 'C1', '7001');
  const first = await scheduledRun();
  assert.equal(first.failed, 1, 'the slot ends partial');
  assert.deepEqual(uploads, ['Corrigendum_01_C1.pdf', 'First.pdf']);
  // the attachment's IREPS HTTP error keeps an IREPS text in the slot (run-details.js TENDER_CODES: HTTP -> SCHEDULE_IREPS_ERROR)
  assert.deepEqual(reported.flatMap((x) => x.failed), [[corrKey, 'SCHEDULE_IREPS_ERROR']], 'the corrigendum is released as failed, with the attachment\'s reason');
  assert.ok(!reported.some((x) => x.done.includes(corrKey)), 'never reported saved without its attachment');
  const failedFile = first.result.tenders[0].categories.corrigenda.files.find((f) => f.status === 'FAILED');
  assert.deepEqual([told.length, failedFile.error, failedFile.code], [1, told[0].detail, told[0].code], 'the failed file says what was reported, so the run lists it once');
  server.s.failPaths = [];
  const second = await scheduledRun();
  assert.deepEqual([second.failed, second.saved], [0, 2]);
  assert.deepEqual(uploads, ['Second.pdf'], 'the corrigendum page and the attachment saved before are not uploaded again');
  assert.equal(status.get(corrKey), 'done', 'complete now');
  assert.deepEqual(saved, [], 'nothing local');
});
test('Scheduled run: a manual run after it is unchanged (no hooks left installed)', async () => {
  scheduledCo();
  await scheduled(fakeShared(), coRun);
  assert.equal(sharedRun.sharedRun(), null);
  scheduledCo();
  await coRun();
  assert.equal(saved.length, 1, 'the manual run saves to Downloads as before');
});

// ---- tabulations IREPS publishes after closing: the waiting list (tender-jobs.js WAITING), checked by Tender Number
const LEDGER_833 = 'doclink.tender.ledger.833';
/** The waiting list in ledger `id`: [[tender number, the tabulations it waits for]]. */
const waitingList = (id = LEDGER_833) => (store[id]?.meta?.[jobs.WAITING.META] || []).map((e) => [e.tenderNo, Object.keys(e.types).sort().join('+')]);
const HOUR = 3600000;
/** Day `d` at `h` o'clock (local), in ms: the runs' clock. */
const atHour = (d, h = 12) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), h).getTime();
const tabsAt = (from, to, now, o = {}) => jobs.downloadTabulationsByDate({ from, to, now, ...o });
/** The Search Tender searches with a Tender Number: [number, closing day]. */
const numberSearches = () => searchPosts().filter((l) => l.body.advancedSearch).map((l) => [l.body.advancedSearch, l.body.dateFrom]);
test('Tabulation waiting list: a Financial Tabulation IREPS shows only weeks after closing (two-packet tender) is found by the Tender Number on its closing day and downloaded; the tender then leaves the list', async () => {
  const closing = new Date(2026, 9, 20);
  mk({ tenders: [bid('42263731', { tab: ['commercialTabulation'] }), other('51111111')] });
  const first = await tabsAt(closing, closing, atHour(closing, 18));
  assert.deepEqual(first.tenders.map((x) => [x.tenderNo, Object.keys(x.categories).join()]), [['42263731', 'commercialTabulation']], 'the Commercial Tabulation IREPS shows is downloaded');
  assert.deepEqual(waitingList(), [['42263731', 'financialTabulation']], 'the Financial one is waited for');
  // weeks later the price bids are opened: IREPS shows the Financial Tabulation on the tender's row
  server.s.tenders[0].tab = true;
  server.log.length = 0;
  const later = new Date(2026, 10, 25);
  const r = await tabsAt(later, later, atHour(later));
  assert.deepEqual(searchPosts().map((l) => [l.body.advancedSearch, l.body.dateFrom, l.body.dateTo]), [['42263731', '20/10/2026', '20/10/2026'], ['', '25/11/2026', '25/11/2026']],
    'first the waiting tender, by its number on its closing day; then the run\'s own dates');
  const rec = r.tenders.find((x) => x.tenderNo === '42263731');
  assert.deepEqual([rec.rechecked, Object.keys(rec.categories).join(), rec.categories.financialTabulation.status], [true, 'financialTabulation', 'DOWNLOADED'], 'only the tabulation it waited for');
  assert.deepEqual([r.waiting.checked, r.waiting.downloaded, r.waiting.still, r.waiting.problem], [1, 1, 0, '']);
  assert.deepEqual([r.listed, r.summary], [0, { downloaded: 0, withTabulation: 0, notAvailable: 0 }], 'the run\'s own dates are counted apart');
  assert.ok(savedNames().includes('DocLink/HOSUR/Tender_42263731/Tabulation/Financial_Tabulation_42263731.pdf'), savedNames().join('\n'));
  assert.deepEqual(waitingList(), [], 'no longer waited for');
  server.log.length = 0;
  await tabsAt(later, later, atHour(later, 20));
  assert.deepEqual(numberSearches(), [], 'nothing is searched again');
});
test('Tabulation waiting list: a tender is looked at again at most every 6 hours, at once with its Tender Number; a run for one tabulation leaves the other one IREPS shows to a run for it', async () => {
  const closing = new Date(2026, 9, 20);
  const later = new Date(2026, 9, 22);
  const t0 = atHour(closing, 18);
  const fin = { pdfTypes: ['financialTabulation'] };
  mk({ tenders: [bid('24261658', { tab: false })] });
  const first = await tabsAt(closing, closing, t0, fin);
  assert.equal(first.tenders[0].notAvailable, true, 'not available yet, as before');
  assert.deepEqual(waitingList(), [['24261658', 'commercialTabulation+financialTabulation']], 'a Financial run notes both tabulations IREPS does not show yet');
  server.log.length = 0;
  await tabsAt(later, later, t0 + 2 * HOUR, fin);
  assert.deepEqual(numberSearches(), [], 'looked at 2 hours ago: not yet');
  const asked = await tabsAt(later, later, t0 + 2 * HOUR, { ...fin, tenderNo: '24261658' });
  assert.deepEqual(numberSearches(), [['24261658', '20/10/2026'], ['24261658', '22/10/2026']], 'with its Tender Number: at once (the run\'s own dates are narrowed to it too)');
  assert.deepEqual([asked.waiting.checked, asked.waiting.downloaded, asked.waiting.still], [1, 0, 1], 'not published yet');
  // IREPS shows the Commercial Tabulation now: the Financial run that looks first leaves it to a Commercial run
  server.s.tenders[0].tab = ['commercialTabulation'];
  server.log.length = 0;
  const finRun = await tabsAt(later, later, t0 + 9 * HOUR, fin);
  assert.deepEqual([finRun.waiting.checked, finRun.waiting.downloaded, tabRequests().length], [1, 0, 0]);
  const comRun = await tabsAt(later, later, t0 + 10 * HOUR, { pdfTypes: ['commercialTabulation'] });
  assert.equal(comRun.tenders.find((x) => x.rechecked).categories.commercialTabulation.status, 'DOWNLOADED', 'an hour later the Commercial run fetches it');
  assert.deepEqual(waitingList(), [['24261658', 'financialTabulation']], 'the Financial one is still waited for');
});
test('Tabulation waiting list: a tender IREPS says was cancelled, one IREPS no longer lists on its closing day (3 times) and one that closed over 180 days ago are no longer waited for', async () => {
  const closing = new Date(2026, 9, 20);
  const april = new Date(2026, 3, 1);
  const later = new Date(2026, 9, 25);
  const t0 = atHour(closing, 18);
  mk({ tenders: [bid('11111111', { tab: false }), bid('22222222', { tab: false }), bid('33333333', { tab: false, closing: april })] });
  await tabsAt(april, april, atHour(april, 18));
  assert.deepEqual(waitingList().map(([no]) => no), ['33333333']);
  await tabsAt(closing, closing, t0);
  assert.deepEqual(waitingList().map(([no]) => no).sort(), ['11111111', '22222222'], 'the tender that closed on 01/04/2026 is no longer waited for');
  server.s.tenders.find((t) => t.no === '11111111').status = 'Cancelled';
  server.s.tenders = server.s.tenders.filter((t) => t.no !== '22222222');
  const r1 = await tabsAt(later, later, t0 + 7 * HOUR);
  assert.deepEqual([r1.waiting.checked, r1.waiting.dropped], [2, 1], 'the cancelled tender goes at once');
  assert.deepEqual(waitingList().map(([no]) => no), ['22222222']);
  await tabsAt(later, later, t0 + 14 * HOUR);
  assert.deepEqual(waitingList().map(([no]) => no), ['22222222'], 'not listed twice: still waited for');
  const r3 = await tabsAt(later, later, t0 + 21 * HOUR);
  assert.deepEqual([r3.waiting.dropped, waitingList()], [1, []], 'not listed a third time: no longer waited for');
});
test('Tabulation waiting list: one run checks at most 25 tenders again, the longest unchecked first; the others are left to a later run, and the run says so', async () => {
  const closing = new Date(2026, 9, 20);
  const later = new Date(2026, 9, 25);
  const t0 = atHour(closing, 18);
  const nos = Array.from({ length: 27 }, (_, i) => `7726${String(i).padStart(4, '0')}`);
  mk({ tenders: nos.map((no) => bid(no, { tab: false })) });
  await tabsAt(closing, closing, t0);
  assert.equal(waitingList().length, 27);
  server.log.length = 0;
  const r = await tabsAt(later, later, t0 + 7 * HOUR);
  assert.deepEqual([r.waiting.checked, r.waiting.later, r.waiting.still, numberSearches().length], [jobs.WAITING.PER_RUN, 2, 27, 25]);
  assert.match(r.notes[0], /^2 tender\(s\) of earlier dates waiting for a tabulation are checked again by a later run/);
  assert.equal(server.log.filter((l) => l.body.searchParam === 'showPage').length, 2, 'the form (no Struts token) is opened once for the 25 searches, once for the run\'s own dates');
  server.log.length = 0;
  await tabsAt(later, later, t0 + 8 * HOUR);
  assert.deepEqual(numberSearches().map(([no]) => no), nos.slice(25), 'the next run takes the two left out');
});
test('Tabulation waiting list: a search IREPS does not answer in full keeps the tender waiting and asks again next time; the scheduled run is not "done" and says why; IREPS not answering at all stops the run', () => quickRetries(async () => {
  const closing = new Date(2026, 9, 20);
  const later = new Date(2026, 9, 25);
  const t0 = atHour(closing, 18);
  // as tender/schedule-runner.js runs it: the job, then its ledger saved
  const scheduledTabs = (from, to, now) => scheduledOutcome(async () => {
    const job = await jobs.beginJob({});
    const tabulations = await jobs.downloadTabulationsByDate({ from, to, now, job });
    await job.ledger.save();
    return { tabulations };
  });
  mk({ tenders: [bid('42263731', { tab: ['commercialTabulation'] })] });
  const first = await scheduledTabs(closing, closing, t0);
  assert.equal(first.outcome.outcome, 'done', JSON.stringify(first.outcome));
  assert.deepEqual(waitingList(`${LEDGER_833}#scheduled`), [['42263731', 'financialTabulation']], 'a scheduled run keeps its own list, in its own ledger');
  const handle = server.handle;
  intercept((m, u, b) => b.get('advancedSearch') === '42263731', () => ({ status: 500, type: 'text/html', bytes: enc8('<html><body>boom</body></html>') }));
  const second = await scheduledTabs(later, later, t0 + 7 * HOUR);
  assert.deepEqual([second.outcome.outcome, second.outcome.code], ['failed', 'SCHEDULE_LIST_INCOMPLETE'], JSON.stringify(second.outcome));
  assert.match(second.outcome.result.warnings[0], /^Earlier tenders waiting for a tabulation: 1 not checked: 42263731 \(closed 20\/10\/2026\): .*HTTP 500/);
  assert.deepEqual(waitingList(`${LEDGER_833}#scheduled`), [['42263731', 'financialTabulation']], 'still waited for');
  server.handle = handle;
  server.s.tenders[0].tab = true;
  server.log.length = 0;
  const third = await scheduledTabs(later, later, t0 + 7 * HOUR + 60000);
  assert.deepEqual(numberSearches(), [['42263731', '20/10/2026']], 'asked again at once: its last look did not count');
  assert.deepEqual([third.outcome.outcome, third.outcome.result.saved], ['done', 1], JSON.stringify(third.outcome));
  assert.deepEqual(waitingList(`${LEDGER_833}#scheduled`), []);
  // a manual run: IREPS cannot be reached for the first search, before anything was done -> the run stops, as when the range's search is not answered
  mk({ tenders: [bid('42263731', { tab: ['commercialTabulation'] })] });
  await tabsAt(closing, closing, t0);
  unreachable((m, u, b) => b.get('advancedSearch') === '42263731');
  await assert.rejects(() => tabsAt(later, later, t0 + 7 * HOUR), (e) => e.code === 'UNREACHABLE');
  assert.deepEqual(waitingList(), [['42263731', 'financialTabulation']], 'still waited for');
}));
test('Tabulation waiting list: the panel shows the tenders of earlier dates apart, after the dates the run searched', () => withTenderPanel(async ($) => {
  const closing = new Date(2026, 9, 20);
  mk({ tenders: [bid('42263731', { tab: ['commercialTabulation'] })] });
  await tabsAt(closing, closing, Date.now() - 7 * HOUR, { pdfTypes: ['commercialTabulation'] });
  server.s.tenders[0].tab = true;
  await clickRun($, 'btn-tab-financial', { from: new Date(2026, 9, 25), to: new Date(2026, 9, 25) });
  const rows = panelRows($, 'tender-result-rows');
  assert.deepEqual(rows.map((r) => r.slice(0, 2)), [['Financial Tabulation · closing in these dates', 'none for these dates'], ['Earlier tenders waiting for a Financial Tabulation', '1 downloaded'], ['42263731', 'Financial Tabulation: 1 downloaded']], JSON.stringify(rows));
  assert.equal($('btn-tab-financial').closest('.tender-group').querySelector('.group-title').textContent, 'Tabulations · all published', 'the heading says every published tabulation, not only closed tenders');
  assert.match($('tender-result-totals').textContent, /^Downloaded: 1 /);
  assert.match($('tender-result-tender').textContent, /: 0 tender\(s\) of this vendor, 0 with a Financial Tabulation$/);
}));
test('Tabulation waiting list: a tabulation IREPS shows but that fails to download 3 times is no longer waited for; every failure is still reported by its run', async () => {
  const closing = new Date(2026, 9, 20);
  const t0 = atHour(closing, 18);
  const fin = { pdfTypes: ['financialTabulation'] };
  mk({ tenders: [bid('42263731')], tabulationAsHtml: true }); // IREPS answers the tabulation with a web page: it never downloads
  for (let i = 0; i < 2; i++) {
    const r = await tabsAt(closing, closing, t0 + i * HOUR, fin);
    assert.equal(r.tenders[0].categories.financialTabulation.status, 'FAILED');
  }
  assert.deepEqual(waitingList(), [['42263731', 'financialTabulation']], 'two failed downloads: still waited for');
  const third = await tabsAt(closing, closing, t0 + 2 * HOUR, fin);
  assert.equal(third.tenders[0].categories.financialTabulation.status, 'FAILED', 'the third failure is reported as the others were');
  assert.deepEqual(waitingList(), [], 'no longer waited for');
  server.log.length = 0;
  const later = new Date(2026, 9, 25);
  await tabsAt(later, later, t0 + 10 * HOUR, fin);
  assert.deepEqual(numberSearches(), [], 'not checked again by its number');
});

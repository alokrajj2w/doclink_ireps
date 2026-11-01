// Run:  JSDOM_ROOT=/path/to/dir-containing-node_modules node --test tender/tests/run-tests.mjs
// (jsdom is only a test-time stand-in for the browser's DOMParser; it is not shipped in the extension.)
import { createRequire } from 'node:module';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { FakeIreps, PDF, corresPage, fakeChromeDebugger } from './fake-ireps.js';

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
  return new Response(r.bytes, { status: r.status, headers: { 'content-type': r.type } });
};
// downloads.download must read the blob we created
chrome.downloads.download = async ({ url, filename }) => {
  const b = blobs.get(url);
  const buf = new Uint8Array(await b.arrayBuffer());
  const id = saved.length + 1;
  saved.push({ id, filename, size: buf.length, bytes: buf });
  return id;
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
const mk = (state) => { server = new FakeIreps(state); saved.length = 0; for (const k of Object.keys(store)) delete store[k]; };
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
  assert.ok(savedNames().includes('DocLink/HOSUR/Tender_29263265/NIT_and_Supporting_Documents/NIT_29263265.pdf'));
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
  for (const want of ['NIT_and_Supporting_Documents/NIT_29263265.pdf', 'My_Offer/My_Offer_29263265.pdf', 'NIT_and_Supporting_Documents/Attachment_01_Annexure.pdf', 'NIT_and_Supporting_Documents/Attachment_02_IRS_CONDITIONS_5595304.pdf', 'NIT_and_Supporting_Documents/Attachment_04_drawing.zip',
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
    assert.deepEqual(Object.keys(files).sort(), ['Corrigendum_02_29263265.pdf', 'Corrigendum_02_29263265_Attachment_1.pdf']);
    assert.equal(files['Corrigendum_02_29263265.pdf'].printed, true, 'the page itself is printed by Chrome');
    assert.equal(files['Corrigendum_02_29263265_Attachment_1.pdf'].role, 'attachment');
    assert.equal(files['Corrigendum_02_29263265_Attachment_1.pdf'].attachmentOf, 'Corrigendum_02_29263265.pdf');
    assert.match(savedText('Corrigendum_02_29263265_Attachment_1.pdf'), /corratt\/ireps\/upload\/corrigendum\/1204999\/Revised_Spec\.pdf/, 'the attachment is the linked file');
    assert.doesNotMatch(savedText('Corrigendum_02_29263265.pdf'), /corratt/, 'the corrigendum is the page, not the attachment');
    assert.equal(dbg.tabs.created, 1);
    assert.deepEqual(c.warnings, []);
    assert.ok(savedNames().every((n) => n.includes('/Corrigenda/')), savedNames().join('\n'));
  } finally {
    withoutDebugger();
  }
});
test('Corrigendum attachments: several are numbered in page order; one that fails is a warning and the rest are kept', async () => {
  mk({ tenders: [ATT_CORR(['Revised_Spec.pdf', 'missing.pdf', 'Annexure.pdf'])] });
  fakeDebugger();
  try {
    const c = (await run('29263265', { only: ['corrigenda'] })).categories.corrigenda;
    assert.equal(c.status, 'DOWNLOADED', 'the corrigendum is saved even when an attachment fails');
    assert.deepEqual(c.files.map((f) => f.fileName), ['Corrigendum_02_29263265.pdf', 'Corrigendum_02_29263265_Attachment_1.pdf', 'Corrigendum_02_29263265_Attachment_2.pdf']);
    assert.match(savedText('_Attachment_2.pdf'), /Annexure\.pdf/);
    assert.equal(c.warnings.length, 1);
    assert.match(c.warnings[0], /Corrigendum_02_29263265\.pdf: an attached document could not be downloaded/);
  } finally {
    withoutDebugger();
  }
});
test('Corrigendum attachments without Chrome printing: text PDF + original HTML + the attached file', async () => {
  mk({ tenders: [ATT_CORR(['Revised_Spec.pdf'])] });
  const c = (await run('29263265', { only: ['corrigenda'] })).categories.corrigenda;
  assert.deepEqual(c.files.map((f) => f.fileName), ['Corrigendum_02_29263265.pdf', 'Corrigendum_02_29263265.html', 'Corrigendum_02_29263265_Attachment_1.pdf']);
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
  assert.ok(savedNames().some((n) => n.includes('Tender_SUN1/NIT_and_Supporting_Documents/NIT_SUN1.pdf')) && savedNames().some((n) => n.includes('Tender_MON1/NIT_and_Supporting_Documents/Attachment_01_Annexure_m1.pdf')));
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
test('Jobs never request tabulation endpoints', () => {
  assert.ok(!server.log.some((l) => /tabulation/i.test(JSON.stringify(l))));
});

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
  for (const no of ['29263265', '33263530A', L]) {
    assert.ok(savedNames().includes(`DocLink/HOSUR/Tender_${no}/NIT_and_Supporting_Documents/NIT_${no}.pdf`), no);
    assert.ok(savedNames().some((n) => n.startsWith(`DocLink/HOSUR/Tender_${no}/NIT_and_Supporting_Documents/Attachment_01_`)), no);
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
  assert.equal(saved.filter((s) => /NIT_T1\.pdf$/.test(s.filename)).length, 1);
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
test('no password / cookie / token is stored by the extension code', async () => {
  const fs = await import('node:fs');
  const src = ['tender-core.js', 'tender-account.js', 'tender-search.js', 'tender-workflows.js', 'tender-ui.js'].map((f) => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8')).join('\n');
  assert.ok(!/chrome\.storage|localStorage|sessionStorage|document\.cookie/.test(src));
});

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
  const seen = { creates: [], gateway: [], asked: 0 };
  // the panel's Recon sign-in page answers this event; count whether it is asked at all
  globalThis.document = { dispatchEvent: () => { seen.asked += 1; return true; } };
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const stored = new Map(); // created uid -> file length
  let uploaded = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u === ECM_URL) seen.gateway.push(u);
    if (!u.startsWith(NUXEO)) return prev(url, init);
    const path = new URL(u).pathname;
    if (path === '/nuxeo/oauth2/token') return json(200, { access_token: 'tok', expires_in: 3600 });
    if (path === '/nuxeo/api/v1/search/lang/NXQL/execute') return json(200, { entries: [], isNextPageAvailable: false });
    if (path === '/nuxeo/api/v1/upload') return json(201, { batchId: 'b' });
    if (path.startsWith('/nuxeo/api/v1/upload/')) {
      uploaded = init.body.length;
      return json(201, { uploaded: 'true' });
    }
    if ((init.method || 'GET') === 'GET') {
      const [uid, blob] = decodeURIComponent(path.replace('/nuxeo/api/v1/id/', '')).split('/@blob/');
      // the read-back after a create: the document, then the last byte of its file
      if (stored.has(uid)) return blob ? new Response(new Uint8Array(1), { status: 200 }) : json(200, { uid, properties: { 'file:content': { length: String(stored.get(uid)) } } });
      return json(200, { uid, path: '/FT/folder' }); // the folder check
    }
    const body = JSON.parse(init.body);
    seen.creates.push({ folder: path.replace('/nuxeo/api/v1/id/', ''), ...body.properties });
    stored.set(`n-${seen.creates.length}`, uploaded);
    return json(201, { uid: `n-${seen.creates.length}`, path: `/x/${body.name}`, title: body.properties['dc:title'] });
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
test('ECM: each tender category maps to its ECM kind with the tender number (the only tender property the ECM has); My Offer stays local', () => {
  const ctx = { tenderNo: '29263265', closingDate: '09/11/2026 15:00' };
  const doc = (category, action) => tecm.ecmDocumentFor(category, action, ctx);
  assert.deepEqual(doc('TENDER_PDF', { id: '5569207', meta: { title: 'NIT / Tender document' } }), { kind: 'nit', title: '29263265 - NIT', fields: { tender_number: '29263265' } });
  assert.equal(doc('ATTACHMENTS', { id: 'Annexure', meta: { title: 'Annexure - SPEC' } }).title, '29263265 - NIT - Annexure - SPEC');
  assert.deepEqual([doc('CORRIGENDA', { id: '1204920', meta: { title: '1' } }).title, doc('NEGOTIATION', { id: '77' }).title, doc('COUNTER_OFFER', { id: '78' }).title, doc('CORRESPONDENCE', { id: '9', meta: { title: 'Withdrawal' } }).title], ['29263265 - Extension - 1', '29263265 - NBSP - 77', '29263265 - CO - 78', '29263265 - CRP - Withdrawal'], 'titles: <tender no> - <spec code> - what tells them apart');
  assert.equal(doc('ATTACHMENTS', { id: 'x', meta: {} }).kind, 'nit');
  assert.deepEqual([doc('CORRIGENDA', { id: '1204920', meta: { title: '1' } }).kind, doc('NEGOTIATION', { id: '1' }).kind, doc('COUNTER_OFFER', { id: '1' }).kind, doc('CORRESPONDENCE', { id: '1', meta: { title: 'Withdrawal' } }).kind], ['extension', 'nbsp', 'co', 'crp']);
  assert.deepEqual(doc('LOA', { id: '1461928', meta: { docDate: '04/10/2026' } }), { kind: 'loi', title: '29263265 - LOI - 1461928', fields: { tender_number: '29263265' } }, 'no loiNumber / loiDate on the ECM: the letter id goes in the title');
  assert.equal(doc('MY_OFFER', { id: '1' }), null);
  assert.equal(tecm.ecmDocumentFor('NIT', {}, { tenderNo: 'T', dueDate: '' }), null);
  assert.deepEqual(tecm.ecmDocumentFor('TENDER_PDF', {}, { tenderNo: 'T', dueDate: new Date(2026, 10, 9).toISOString() }).fields, { tender_number: 'T' }, 'no tenderDate on the ECM: the due date is not sent');
  assert.equal(tecm.ECM_TAKES_TENDER_DATE, false);
});
test('ECM: Save to Local (the default) never calls the ECM', async () => {
  mk({ tenders: [FULL()] });
  await withEcm(() => [201, {}], async (posts) => {
    await run();
    assert.equal(posts.length, 0);
    assert.ok(savedNames().some((n) => n.endsWith('NIT_29263265.pdf')));
  });
});
test('ECM: Save to ECM / S3 files every tender document in the Hosur folder; My Offer and the manifest stay local', async () => {
  mk({ tenders: [FULL()], inbox: letters('29263265'), letterAsPdf: true, corres: CORRES });
  store['doclink.saveDestination'] = 'recon';
  await withEcm((p, n) => [201, { uid: `u-${n}`, path: `/FT/x/${n}`, title: p.title, site: 'hosur', deduplicated: false }], async (posts) => {
    const r = await run();
    const c = r.categories;
    assert.equal(r.summary.failed, 0);
    const kinds = posts.reduce((m, p) => ({ ...m, [p.kind]: (m[p.kind] || 0) + 1 }), {});
    assert.deepEqual(kinds, { nit: 5, extension: 2, nbsp: 2, co: 1, loi: 1, crp: 2, vft: 1, vct: 1 });
    assert.deepEqual(posts.filter((p) => /^v[fc]t$/.test(p.kind)).map((p) => p.title).sort(), ['29263265 - Commercial Tabulation', '29263265 - Financial Tabulation']);
    assert.ok(posts.every((p) => p.account === '833' && p.unit === 'HOSUR' && p.fields.tender_number === '29263265' && p.credentials === 'include'));
    assert.ok(posts.every((p) => Object.keys(p.fields).join() === 'tender_number'), 'only the tender number: the ECM has no tenderDate / loiNumber / loiDate');
    const loi = posts.find((p) => p.kind === 'loi');
    assert.equal(loi.title, '29263265 - LOI - 1461928');
    assert.equal(new Set(posts.map((p) => p.title)).size, posts.length, 'every title is unique within the tender');
    // nothing that went to the ECM is in Downloads; My Offer (no ECM kind) is, and no manifest file is
    const local = savedNames().map((x) => x.replace('DocLink/HOSUR/Tender_29263265/', ''));
    assert.ok(local.includes('My_Offer/My_Offer_29263265.pdf') && !local.some((n) => /manifest/i.test(n)));
    assert.ok(!local.some((n) => /^(NIT_and_Supporting_Documents|Negotiation|Counter_Offers|Advance_Acceptance_LOA|Correspondence)\//.test(n)), local.join('\n'));
    assert.ok(local.includes('Corrigenda/Corrigendum_02_29263265.html'), 'without Chrome printing, a corrigendum page keeps its original HTML locally');
    assert.equal(c.tenderPdf.files[0].ecm.status, 'stored');
    assert.equal(c.tenderPdf.files[0].relPath, null);
    assert.equal(c.myOffer.files[0].ecm, undefined);
    assert.equal(c.loa.files[0].ecm.uid, `u-${posts.indexOf(loi) + 1}`, 'the result records where each document went');
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
        ['extension', '29263265 - Extension - Corrigendum - 2 - Attachment 1', 'Corrigendum_02_29263265_Attachment_1.pdf'],
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
  await withEcm((p, n) => (n === 1 ? [400, { detail: { error: 'INVALID_INPUT', detail: 'nit requires tender_number' } }] : [502, { detail: { error: 'ECM_UPSTREAM_ERROR', detail: 'HTTP 500' } }]), async (posts) => {
    const r = await run();
    assert.equal(r.summary.failed, 0, 'nothing is lost');
    assert.equal(posts.length, 15);
    const local = savedNames().map((x) => x.replace('DocLink/HOSUR/Tender_29263265/', ''));
    for (const want of ['NIT_and_Supporting_Documents/NIT_29263265.pdf', 'Advance_Acceptance_LOA/LOA_29263265.pdf', 'Correspondence/Correspondence_29263265_306789.pdf']) assert.ok(local.includes(want), `missing ${want}`);
    const nit = r.categories.tenderPdf.files[0];
    assert.deepEqual([nit.ecm.status, nit.ecm.code, nit.ecm.detail], ['failed', 'ECM_REJECTED', 'nit requires tender_number']);
    assert.equal(r.categories.loa.files[0].ecm.code, 'ECM_UNAVAILABLE');
  });
});
test('ECM direct: with ecmBackendAws false every tender document goes straight to the Hosur TEST Tenders folder, without the Recon sign-in', async () => {
  mk({ tenders: [FULL()], inbox: letters('29263265'), letterAsPdf: true, corres: CORRES });
  store['doclink.saveDestination'] = 'recon';
  await withDirectEcm(async ({ creates, gateway, asked }) => {
    const r = await run();
    assert.equal(r.summary.failed, 0);
    assert.equal(gateway.length, 0, 'the Recon Engine gateway is not called');
    const kinds = creates.reduce((m, p) => ({ ...m, [p['InvoiceCertificateSchema:type']]: (m[p['InvoiceCertificateSchema:type']] || 0) + 1 }), {});
    assert.deepEqual(kinds, { nit: 5, extension: 2, nbsp: 2, co: 1, loi: 1, crp: 2, vft: 1, vct: 1 });
    assert.ok(creates.every((p) => p.folder === 'aa28acbe-add1-49d3-b0ab-16ab1263996c' && p['InvoiceCertificateSchema:tenderNumber'] === '29263265'));
    const loi = creates.find((p) => p['InvoiceCertificateSchema:type'] === 'loi');
    assert.equal(loi['dc:title'], '29263265 - LOI - 1461928');
    // the properties the TEST ECM's InvoiceCertificateSchema has (anything else: HTTP 400 "No such property")
    const props = new Set(['dc:title', 'file:content', 'InvoiceCertificateSchema:type', 'InvoiceCertificateSchema:tenderNumber']);
    assert.ok(creates.every((p) => Object.keys(p).filter((k) => k !== 'folder').every((k) => props.has(k))), JSON.stringify(creates[0]));
    assert.equal(r.categories.tenderPdf.files[0].ecm.status, 'stored');
    assert.equal(r.categories.tenderPdf.files[0].ecm.uid.startsWith('n-'), true);
    const local = savedNames().map((x) => x.replace('DocLink/HOSUR/Tender_29263265/', ''));
    assert.ok(local.includes('My_Offer/My_Offer_29263265.pdf'));
    assert.ok(!local.some((n) => /^NIT_and_Supporting_Documents\//.test(n)), 'nothing that went to the ECM is in Downloads');
  });
  const asked = await withDirectEcm(async (seen) => seen.asked);
  assert.equal(asked, 0, 'no Recon sign-in asked in direct mode');
});
test('ECM: letters by date go to the ECM with the tender number only, without searching IREPS for the tender date', async () => {
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
    assert.deepEqual(posts.map((p) => p.kind).sort(), ['co', 'loi', 'nbsp', 'nbsp']);
    const loi = posts.find((p) => p.kind === 'loi');
    assert.deepEqual([loi.title, loi.fields], ['LOA3 - LOI - 31', { tender_number: 'LOA3' }]);
    assert.ok(posts.every((p) => Object.keys(p.fields).join() === 'tender_number'));
    assert.ok(posts.every((p) => p.account === '833' && p.unit === 'HOSUR'));
    assert.equal(server.log.filter((l) => l.path === '/epsn/search/advancedSearch.do').length, 0, 'no tender search: the ECM has no tenderDate to fill');
    assert.ok(!savedNames().some((n) => /\/(Negotiation|Counter_Offers|Advance_Acceptance_LOA)\//.test(n)), 'nothing that went to the ECM is in Downloads');
  });
});
test('ECM: the correspondence page\'s Closing Date fills the tender date when the run did not search the tender', () => {
  const doc = new JSDOM(new TextDecoder().decode(corresPage({ nitOid: '1', tenderNo: 'X1', letters: [] }))).window.document;
  assert.equal(wf.pageClosingDate(doc), '09/09/2026');
  assert.equal(wf.pageClosingDate(new JSDOM('<table><tr><td>Tender No</td><td>X</td></tr></table>').window.document), '');
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
  const nego = idx(/\/Negotiation\//), loa = idx(/Advance_Acceptance_LOA/), co = idx(/Counter_Offers/), nit = idx(/NIT_and_Supporting_Documents\/NIT_/);
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
    assert.ok(!savedNames().some((n) => /NIT_29263265\.pdf|Corrigendum_/.test(n)), 'skipped documents are not fetched');
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

// =========================== Financial / Commercial Tabulation ===============================
const { readFileSync } = await import('node:fs');
const CLOSED_FIXTURE = readFileSync(new URL('./fixtures/closed-tenders.html', import.meta.url), 'utf8');
const closed = (no, o = {}) => ({ no, nitId: `55${no.slice(-5)}`, oid: `107${no.slice(-6)}`, bidId: `208${no.slice(-5)}`, title: `Item ${no}`, closing: new Date(2026, 9, 20), tab: true, ...o });
const tabPosts = () => server.log.filter((l) => l.path === '/epsn/tbo/commTboPdfAction.do');
const closedPosts = () => server.log.filter((l) => l.path === '/epsn/vendorInboxLink.do' && l.body.status === 'MyBidsClosed' && l.body.startDate);

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
test('Tabulation by closing date: every closed tender with the link is downloaded across pages, one without is "not available yet", another account is refused', async () => {
  mk({ closed: [closed('42263731'), closed('24261658', { tab: false }), closed('69261051', { page: 2 }), closed('03263926B', { tabAcct: '60828' }), closed('11111111', { closing: new Date(2026, 8, 1) })] });
  const r = await auto.runTabulations({ pdfType: 'financialTabulation', from: new Date(2026, 9, 15), to: new Date(2026, 9, 23) });
  const t = r.tabulations;
  assert.deepEqual([r.range, t.listed, t.summary], [{ from: '15/10/2026', to: '23/10/2026' }, 4, { downloaded: 2, withTabulation: 3, notAvailable: 1 }]);
  const by = Object.fromEntries(t.tenders.map((x) => [x.tenderNo, x]));
  assert.equal(by['24261658'].notAvailable, true);
  assert.equal(by['42263731'].categories.financialTabulation.status, 'DOWNLOADED');
  assert.equal(by['69261051'].categories.financialTabulation.status, 'DOWNLOADED', 'page 2 is read');
  assert.match(by['03263926B'].categories.financialTabulation.files[0].error, /Account mismatch: .*60828/);
  assert.deepEqual(savedNames().sort(), ['DocLink/HOSUR/Tender_42263731/Tabulation/Financial_Tabulation_42263731.pdf', 'DocLink/HOSUR/Tender_69261051/Tabulation/Financial_Tabulation_69261051.pdf']);
  assert.ok(tabPosts().every((l) => l.method === 'POST' && l.body.pdfType === 'financialTabulation'), 'only the chosen tabulation, POSTed as IREPS does');
  assert.ok(closedPosts().every((l) => l.body.menuLink === 'Tenders' && l.body.listType === 'MyBidsClosed' && l.body.startDate === '15/10/2026' && l.body.endDate === '23/10/2026'));
  // the same range again: the ledger skips what was downloaded
  saved.length = 0;
  const again = await auto.runTabulations({ pdfType: 'financialTabulation', from: new Date(2026, 9, 15), to: new Date(2026, 9, 23) });
  assert.equal(again.tabulations.summary.downloaded, 0);
  assert.equal(again.tabulations.tenders.find((x) => x.tenderNo === '42263731').categories.financialTabulation.alreadyDownloaded, 1);
  assert.equal(saved.length, 0);
});
test('Tabulation by closing date: a range longer than 90 days is read in windows; the Tender Number narrows it', async () => {
  mk({ closed: [closed('42263731', { closing: new Date(2026, 5, 10) }), closed('69261051', { closing: new Date(2026, 9, 20) })] });
  const r = await auto.runTabulations({ pdfType: 'commercialTabulation', from: new Date(2026, 5, 1), to: new Date(2026, 9, 23) });
  assert.equal(r.tabulations.summary.downloaded, 2);
  assert.deepEqual(closedPosts().map((l) => [l.body.startDate, l.body.endDate]), [['01/06/2026', '29/08/2026'], ['30/08/2026', '23/10/2026']]);
  assert.ok(savedNames().includes('DocLink/HOSUR/Tender_42263731/Tabulation/Commercial_Tabulation_42263731.pdf'));
  mk({ closed: [closed('42263731'), closed('69261051')] });
  const one = await auto.runTabulations({ pdfType: 'commercialTabulation', from: new Date(2026, 9, 15), to: new Date(2026, 9, 23), tenderNo: ' 69261051 ' });
  assert.deepEqual([one.tabulations.listed, one.tabulations.summary.downloaded], [1, 1]);
  assert.ok(closedPosts().every((l) => l.body.tenderNo === '69261051'));
});
// 40 closed tenders, one a day back from 23/10/2026, for an IREPS that returns the whole list whatever the dates
const closedDaily = () => Array.from({ length: 40 }, (_, i) => closed(`4226${String(i).padStart(4, '0')}`, { closing: new Date(2026, 9, 23 - i) }));
test('Tabulation by closing date: when IREPS ignores the dates, only tenders whose own Closing Date is in the range are downloaded, and paging stops', async () => {
  mk({ closed: closedDaily(), closedIgnoresDates: true });
  const r = await auto.runTabulations({ pdfType: 'financialTabulation', from: new Date(2026, 9, 15), to: new Date(2026, 9, 16) });
  assert.deepEqual(r.tabulations.tenders.map((t) => [t.tenderNo, t.closingDate]), [['42260007', '16/10/2026 11:30'], ['42260008', '15/10/2026 11:30']]);
  assert.equal(r.tabulations.summary.downloaded, 2);
  assert.deepEqual(savedNames().sort(), ['DocLink/HOSUR/Tender_42260007/Tabulation/Financial_Tabulation_42260007.pdf', 'DocLink/HOSUR/Tender_42260008/Tabulation/Financial_Tabulation_42260008.pdf']);
  assert.deepEqual(server.listPages.map((l) => l.pageNo), ['1', '2', '3'], 'page 1 has the range, pages 2-3 closed earlier, page 4 is never read');
  assert.match(core.getLogTail(), /Pages 2-3 all closed before 15\/10\/2026; stopping/);
  assert.match(core.getLogTail(), /2 closed tender\(s\) closing 15\/10\/2026\.\.16\/10\/2026 .*; 28 outside the dates skipped/);
});
test('Tabulation by closing date: a range over 90 days does not re-read the same list when IREPS ignores the dates', async () => {
  mk({ closed: closedDaily(), closedIgnoresDates: true });
  const r = await auto.runTabulations({ pdfType: 'commercialTabulation', from: new Date(2026, 5, 1), to: new Date(2026, 9, 23) });
  assert.equal(r.tabulations.summary.downloaded, 40);
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
test('Tabulation: a web page with no PDF behind it fails with what IREPS showed; nothing is saved as the tabulation', async () => {
  mk({ closed: [closed('42263731')], tabulationAsHtml: true });
  const r = await auto.runTabulations({ pdfType: 'financialTabulation', from: new Date(2026, 9, 15), to: new Date(2026, 9, 23) });
  assert.equal(r.tabulations.summary.downloaded, 0);
  const cat = r.tabulations.tenders[0].categories.financialTabulation;
  assert.equal(cat.status, 'FAILED');
  assert.match(cat.files[0].error, /only a web page: "financialTabulation 107263731/);
  assert.deepEqual(savedNames(), []);
});
for (const [mode, file] of [['iframe', '/ireps/upload/tbo/Tabulation_'], ['form', '/epsn/tbo/showTabulation.do'], ['open', '/ireps/upload/tbo/view']]) {
  test(`Tabulation: the PDF behind a viewer page (${mode}) is downloaded; Techno-Commercial links in it are never requested`, async () => {
    mk({ closed: [closed('42263731')], tabulationAs: mode });
    const r = await auto.runTabulations({ pdfType: 'commercialTabulation', from: new Date(2026, 9, 15), to: new Date(2026, 9, 23) });
    assert.equal(r.tabulations.summary.downloaded, 1, JSON.stringify(r.tabulations.tenders[0]));
    const f = saved.find((x) => x.filename.endsWith('Tabulation/Commercial_Tabulation_42263731.pdf'));
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
test('Tabulation: Save to ECM files them as vft / vct with "<tender no> - <type>" and the tender number', async () => {
  mk({ closed: [closed('42263731', { closing: new Date(2026, 9, 23) })] });
  store['doclink.saveDestination'] = 'recon';
  await withEcm((p, n) => [201, { uid: `u-${n}`, path: `/FT/x/${n}`, title: p.title, site: 'hosur', deduplicated: false }], async (posts) => {
    await auto.runTabulations({ pdfType: 'financialTabulation', from: new Date(2026, 9, 15), to: new Date(2026, 9, 23) });
    await auto.runTabulations({ pdfType: 'commercialTabulation', from: new Date(2026, 9, 15), to: new Date(2026, 9, 23) });
    assert.deepEqual(posts.map((p) => [p.kind, p.title, p.fields.tender_number, p.fields.tender_date, p.account]), [
      ['vft', '42263731 - Financial Tabulation', '42263731', undefined, '833'],
      ['vct', '42263731 - Commercial Tabulation', '42263731', undefined, '833'],
    ]);
    assert.equal(saved.length, 0, 'nothing that went to the ECM is in Downloads');
  });
});

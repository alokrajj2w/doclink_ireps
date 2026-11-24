// Tests for "Download All Correspondence" (tender/tender-pending.js).
// Run:  JSDOM_ROOT=/path/to/dir-containing-node_modules node --test tender/tests/pending-tests.mjs
// The fixtures in tender/tests/fixtures are the real IREPS pages from the supplied HAR (names redacted);
// the fake server below rewrites their rows so the tests can vary how many records / letters exist.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PDF, homePage, loginPage, fakeChromeDebugger } from './fake-ireps.js';

const req = createRequire((process.env.JSDOM_ROOT || process.cwd()) + '/');
const { JSDOM } = req('jsdom');
globalThis.DOMParser = new JSDOM('').window.DOMParser;

const FIX = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const LIST_FIX = FIX('pending-list.html');
const DETAIL_FIX = FIX('pending-reply-single.html');
const enc = (s) => new TextEncoder().encode(s);

// ---------------------------------------------------------------- fake IREPS
const LIST = '/epsn/corres/vendorRelatedCorrespondence.do';
const REPLY = '/epsn/corres/vendorCorrespondencePendingReply.do';
const VIEW = '/epsn/corres/rly/viewpubIndltr.do';

function listHtml(rows) {
  const tr = rows.map((r) => `<tr height="25px;">
<td class="dataText">${r.dept || 'STORES / TEST RLY'}</td><td class="dataText">${r.no}</td><td class="dataText">01/10/2026 11:00</td>
<td class="dataText" style="padding:3px;">${r.title || 'Title ' + r.no}....<img title="${r.title || 'Title ' + r.no} FULL" src="/x.png"></td>
<td class="dataText">14/10/2026</td><td class="dataText" style="color: #C00000">
 ${r.status || 'Pending'}
</td><td><a href="#" class="linkStyle" onclick="postRequest('/epsn/corres/vendorCorrespondencePendingReply.do?nitOid=${r.oid}')"><img src="/y.gif"></a></td></tr>`).join('\n');
  return LIST_FIX.replace(/<tbody>[\s\S]*?<\/tbody>/, `<tbody>${tr}</tbody>`);
}

function detailHtml(d) {
  const row = (l) => `<tr height="25px;"><td class="dataText">${l.no} dated : ${l.date || '11/10/2026'}</td><td class="dataText">${l.subject}</td><td class="dataText">15/10/2026</td>
<td><a href="#" onclick="viewPublishedLtr('${l.oid || d.oid}', '${l.corresId || '229609'}', '${l.id}');"><img src="/v.png"></a>&nbsp;
<a href="#" onclick="postRequest('/epsn/corres/vendor/vendorCorresSubmitReply.do?nitOid=${d.oid}&corresId=${l.corresId || '229609'}&letterId=${l.id}&bidId=1')"><img title="Submit Response" src="/s.gif"></a></td></tr>`;
  const none = '<tr height="25px"><td colspan="4" align="center"> No record found </td></tr>';
  let h = DETAIL_FIX.replace(/L1265428/g, d.tenderNo);
  if (d.noPendingHeading) h = h.replace('Pending Replies', 'Replies'); // a changed page: its Pending Replies table is not recognised
  // the three result tables, in page order: Pending Replies, Lapsed, Previous Replies
  const parts = h.split(/<tr height="25px;?">[\s\S]*?<\/tr>/);
  assert.equal(parts.length, 4, 'fixture shape: pending row + 2 no-record rows');
  const hist = (id) => `<tr height="25px"><td class="dataText">HIST${id} dated : 01/01/2026</td><td class="dataText">Old letter</td><td class="dataText">x</td><td><a href="#" onclick="viewPublishedLtr('${d.oid}', '1', '${id}');">v</a></td></tr>`;
  return parts[0] + ((d.letters || []).map(row).join('') || none) + parts[1] + (d.lapsed ? hist('LAPSED1') : none) + parts[2] + (d.previous ? hist('PREV1') : none) + parts[3];
}

class Fake {
  constructor(s = {}) {
    this.s = { account: { id: '833', company: 'FAIVELEY TRANSPORT RAIL TECHNOLOGIES INDIA PRIVATE LIMITED-HOSUR' }, rows: [], details: {}, letters: {}, attachments: {}, ...s };
    this.log = [];
    this.hits = {};
  }
  async handle(method, url, body) {
    const u = new URL(url);
    const p = u.pathname;
    const form = new URLSearchParams(typeof body === 'string' ? body : '');
    this.log.push({ method, path: p, form: Object.fromEntries(form), query: u.search });
    const ok = (bytes, type = 'text/html;charset=ISO-8859-1', extra = {}) => ({ status: 200, bytes: typeof bytes === 'string' ? enc(bytes) : bytes, type, extra });
    if (p === '/config.json') return ok(JSON.stringify({ target: 'real', realBaseUrl: 'https://www.ireps.gov.in' }), 'application/json');
    if (p === '/epsn/home/showHome.do') {
      if (this.s.expired) return ok(loginPage());
      return ok(homePage({ id: this.s.account.id, company: this.s.account.company }));
    }
    if (this.s.expired) return ok(loginPage());
    if (p === LIST) return method === 'POST' ? ok(this.s.listOverride ?? listHtml(this.s.rows)) : { status: 405, bytes: enc('no'), type: 'text/plain' };
    if (p === REPLY) {
      const d = this.s.details[form.get('nitOid')];
      if (!d) return { status: 500, bytes: enc('server error'), type: 'text/plain' };
      return ok(detailHtml(d));
    }
    if (p === VIEW) {
      const id = form.get('letterID'); // note: letterID, exactly as the portal sends it
      this.hits[id] = (this.hits[id] || 0) + 1;
      const f = this.s.letters[id];
      if (!f) return { status: 404, bytes: enc('nf'), type: 'text/plain' };
      return f(this.hits[id], form);
    }
    if (p.startsWith('/ireps/corr/')) {
      const f = this.s.attachments[p.split('/').pop()];
      return f ? f() : { status: 404, bytes: enc('nf'), type: 'text/plain' };
    }
    return { status: 404, bytes: enc('nf'), type: 'text/plain' };
  }
}

// ---------------------------------------------------------------- fake chrome + fetch
let server;
const saved = [];
const store = {};
const blobs = new Map();
const origCreate = URL.createObjectURL.bind(URL);
URL.createObjectURL = (b) => { const u = origCreate(b); blobs.set(u, b); return u; };
const fetch0 = globalThis.fetch;
let failSaveFor = null;
globalThis.chrome = {
  runtime: { getURL: (p) => `https://ext.invalid/${p}` },
  storage: { local: { get: async (k) => ({ [k]: store[k] }), set: async (o) => Object.assign(store, JSON.parse(JSON.stringify(o))) } },
  downloads: {
    onChanged: { addListener() {}, removeListener() {} },
    download: async ({ url, filename, conflictAction }) => {
      if (failSaveFor && filename.includes(failSaveFor)) throw new Error('disk full');
      const buf = new Uint8Array(await blobs.get(url).arrayBuffer());
      const id = saved.length + 1;
      saved.push({ id, filename, size: buf.length, bytes: buf, conflictAction });
      return id;
    },
    search: async ({ id }) => { const s = saved.find((x) => x.id === id); return [{ id, state: 'complete', exists: true, fileSize: s?.size }]; },
  },
};
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith('blob:')) return fetch0(u);
  const r = await server.handle(init.method || 'GET', u.replace('https://ext.invalid/', 'https://www.ireps.gov.in/'), init.body);
  return new Response(r.bytes, { status: r.status, headers: { 'content-type': r.type, ...(r.extra || {}) } });
};

const core = await import('../tender-core.js');
const P = await import('../tender-pending.js');
const noSleep = async () => {};
const mk = (s) => { server = new Fake(s); saved.length = 0; failSaveFor = null; for (const k of Object.keys(store)) delete store[k]; };
const go = (o = {}) => P.downloadPendingCorrespondence({ sleep: noSleep, pace: 0, ...o });
const letterPdf = (tag) => () => ({ status: 200, bytes: PDF(tag), type: 'application/pdf', extra: {} });
const letterHtml = (body) => () => ({ status: 200, bytes: enc(`<html><head><title>Letter</title></head><body><table><tr><td>${body}</td></tr></table></body></html>`), type: 'text/html', extra: {} });
const pdfs = () => saved.filter((s) => s.filename.endsWith('.pdf'));
// progress is kept in extension storage only; download_manifest.json is never saved to Downloads
const stored = () => { const s = store['doclink.tender.ledger.833'].manifests['pending-correspondence']; return { records: Object.values(s.records), letters: Object.values(s.letters) }; };
const noManifestFile = () => assert.ok(!saved.some((s) => /manifest/i.test(s.filename)), saved.map((s) => s.filename).join('\n'));
const submitCalls = () => server.log.filter((l) => /SubmitReply|vendorCorresSubmit/i.test(l.path));
beforeEach(() => mk());

// =========================== parsers (HAR fixtures) =====================================
test('T1 list fixture: all 5 Pending rows parsed from the Pending section, Lapsed/Replied excluded', () => {
  const r = P.parsePendingList(LIST_FIX);
  assert.deepEqual(r.rows.map((x) => x.nitOid), ['107202603', '107202612', '107202979', '107105975', '107169728']);
  assert.deepEqual(r.rows.map((x) => x.tenderNo), ['19264728', '19260818', 'L1265428', '20263194', '30261513']);
  assert.ok(r.rows.every((x) => x.status === 'Pending'));
  assert.equal(r.rows[2].railway, 'DSD-UBL / SOUTH WESTERN RLY');
  assert.equal(r.rows[2].replyDeadline, '15/10/2026');
  assert.match(r.rows[0].tenderTitle, /D125916-220 Qty-01 No\.$/); // the full title (from the icon), not the "...." cut
  assert.ok(r.sections.some((s) => /Lapsed/i.test(s)));
  assert.equal(r.rows.some((x) => /All Replied/.test(x.status)), false);
});
test('T1b row count is not hardcoded (8 rows -> 8) and leading zeros / letters are preserved', () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({ no: i === 0 ? '0012/AB-7' : `T${100 + i}`, oid: 500 + i }));
  const r = P.parsePendingList(listHtml(rows));
  assert.equal(r.rows.length, 8);
  assert.equal(r.rows[0].tenderNo, '0012/AB-7');
});
test('T3 a Lapsed table row that says Pending is still excluded (section decides), and a non-Pending row in the Pending table is skipped, not downloaded', () => {
  const html = listHtml([{ no: 'A1', oid: 1 }, { no: 'B2', oid: 2, status: 'Replied' }]);
  const lapsedPending = html.replace('All Replied', 'Pending');
  const r = P.parsePendingList(lapsedPending);
  assert.deepEqual(r.rows.map((x) => x.nitOid), ['1']);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0].reason, /not Pending/);
});
test('T4 empty Pending table -> zero rows; non-correspondence page -> PAGE error', () => {
  assert.equal(P.parsePendingList(listHtml([])).rows.length, 0);
  assert.throws(() => P.parsePendingList('<html><body>Something else</body></html>'), (e) => e.code === 'PAGE');
});
test('T2 details fixture: Pending Replies letter parsed with live ids; Lapsed / Previous excluded', () => {
  const r = P.parsePendingReplies(DETAIL_FIX);
  assert.equal(r.tender.tenderNo, 'L1265428');
  assert.equal(r.tender.closingDate, '09/10/2026 10:30');
  assert.deepEqual(r.letters, [{ nitOid: '107202979', corresId: '229609', letterId: '313083', letterNo: '313083', letterDate: '11/10/2026', subject: 'Confirmation;', replyDeadline: '15/10/2026' }]);
  const many = P.parsePendingReplies(detailHtml({ oid: '9', tenderNo: 'Z', letters: [{ no: 'A/1', id: '11', subject: 'S1' }, { no: 'A/2', id: '12', subject: 'S1' }, { no: 'A/3', id: '13', subject: 'S3' }], lapsed: true, previous: true }));
  assert.deepEqual(many.letters.map((l) => l.letterId), ['11', '12', '13']);
  assert.equal(P.parsePendingReplies(detailHtml({ oid: '9', tenderNo: 'Z', letters: [] })).letters.length, 0);
});
test('T6 letter request mirrors viewPublishedLtr: POST, form fields nitOid/letterID/corresId (letterID spelling)', () => {
  const page = P.parsePendingReplies(DETAIL_FIX);
  const rq = P.buildLetterRequest(page.letters[0], page.scripts, 'https://www.ireps.gov.in/epsn/corres/vendorCorrespondencePendingReply.do');
  assert.equal(rq.method, 'POST');
  assert.equal(rq.url, '/epsn/corres/rly/viewpubIndltr.do');
  assert.deepEqual([...rq.form], [['nitOid', '107202979'], ['letterID', '313083'], ['corresId', '229609']]);
  assert.equal(rq.fromPageScript, true);
  const fb = P.buildLetterRequest(page.letters[0], '', '');
  assert.equal(fb.form.get('letterID'), '313083');
});

// =========================== read-only guard ============================================
test('T9 the reply endpoint and write-like actions are refused; view endpoints and static files are allowed', async () => {
  assert.throws(() => P.assertReadOnly('/epsn/corres/vendor/vendorCorresSubmitReply.do'), (e) => e.code === 'BLOCKED');
  assert.throws(() => P.assertReadOnly('/epsn/x/saveReply.do'), (e) => e.code === 'BLOCKED');
  assert.throws(() => P.assertReadOnly('/epsn/x/uploadDocument.do'), (e) => e.code === 'BLOCKED');
  P.assertReadOnly(VIEW); P.assertReadOnly(REPLY); P.assertReadOnly(LIST);
  P.assertReadOnly('/ireps/corr/Submission_List.pdf'); P.assertReadOnly('/epsn/x/viewUploadedDoc.do');
  await assert.rejects(() => P.pcFetch('https://www.ireps.gov.in', '/epsn/corres/vendor/vendorCorresSubmitReply.do', { method: 'POST', form: { nitOid: '1' } }), (e) => e.code === 'BLOCKED');
  assert.equal(server.log.length, 0);
});

// =========================== end-to-end =================================================
function scenario() {
  const L = {};
  mk({
    rows: [{ no: '19264728', oid: '101' }, { no: 'L1265428', oid: '102' }, { no: '20263194', oid: '103' }, { no: '30261513', oid: '104', status: 'Replied' }],
    details: {
      101: { oid: '101', tenderNo: '19264728', letters: [{ no: '501', id: '9001', subject: 'Confirmation;' }, { no: '502', id: '9002', subject: 'Confirmation;' }], lapsed: true, previous: true },
      102: { oid: '102', tenderNo: 'L1265428', letters: [{ no: '777/B', id: '9003', subject: 'Clarification / price' }] },
      103: { oid: '103', tenderNo: '20263194', letters: [] },
    },
    letters: L,
    attachments: {
      'annex1.pdf': () => ({ status: 200, bytes: PDF('annex1'), type: 'application/pdf', extra: { 'content-disposition': 'attachment; filename="Annexure 1.pdf"' } }),
      'drawing.pdf': () => ({ status: 200, bytes: PDF('drawing'), type: 'application/pdf', extra: {} }),
    },
  });
  L['9001'] = letterPdf('direct');
  L['9002'] = letterHtml('Letter body: please confirm the offer validity and submit rates for item 1.<br>Signed: DY CMM');
  L['9003'] = () => ({ status: 200, bytes: enc('<html><body><iframe src="/ireps/corr/letter9003.pdf"></iframe><a href="/ireps/corr/annex1.pdf">Annexure 1</a> <a href="/ireps/corr/drawing.pdf">Drawing</a> <a href="/epsn/corres/vendor/vendorCorresSubmitReply.do?nitOid=102">Reply</a><img src="/x.png"><a href="/epsn/home/showHome.do">Home</a></body></html>'), type: 'text/html', extra: {} });
  server.s.attachments['letter9003.pdf'] = letterPdf('embedded');
  return L;
}

test('T1/T2/T3/T6/T7/T9 full run: every pending record, every letter, attachments, manifest; no reply endpoint ever called', async () => {
  scenario();
  const events = [];
  const r = await go({ onEvent: (e) => events.push(e) });
  assert.equal(r.aborted, null);
  assert.deepEqual(r.summary, { pendingRecords: 3, lettersDiscovered: 3, lettersDownloaded: 3, alreadyDownloaded: 0, attachmentsDownloaded: 2, unavailable: 0, failed: 0, needsReview: 0, noPendingLetters: 1, sessionExpired: 0 });
  // requests: list once, details for every pending record, each letter, never the reply endpoint, Replied row not opened
  const paths = server.log.map((l) => l.path);
  assert.equal(paths.filter((p) => p === LIST).length, 1);
  assert.deepEqual(server.log.filter((l) => l.path === REPLY).map((l) => l.form.nitOid), ['101', '102', '103']);
  assert.deepEqual(server.log.filter((l) => l.path === VIEW).map((l) => l.form.letterID), ['9001', '9002', '9003']);
  assert.ok(server.log.filter((l) => l.path === VIEW).every((l) => l.method === 'POST' && l.form.nitOid && l.form.corresId));
  assert.equal(submitCalls().length, 0);
  // files: valid PDFs under DocLink/HOSUR/Correspondence/Pending/<tender>/
  const names = saved.map((s) => s.filename);
  assert.ok(names.includes('DocLink/HOSUR/Correspondence/Pending/19264728/Correspondence_501_11-10-2026_Confirmation;.pdf'), names.join('\n'));
  assert.ok(names.some((n) => /Pending\/19264728\/Correspondence_502_11-10-2026_Confirmation;\.pdf$/.test(n)), 'same subject, different letter id -> different file');
  assert.ok(names.some((n) => /Pending\/19264728\/Correspondence_502_.*\.html$/.test(n)), 'original HTML kept next to the rendered PDF');
  // files IREPS served keep their IREPS names: the embedded letter PDF, and the attachments (Content-Disposition, else the URL)
  assert.ok(names.some((n) => /Pending\/L1265428\/letter9003\.pdf$/.test(n)), names.join('\n'));
  assert.ok(names.some((n) => /Pending\/L1265428\/Annexure 1\.pdf$/.test(n)), names.join('\n'));
  assert.ok(names.some((n) => /Pending\/L1265428\/drawing\.pdf$/.test(n)));
  assert.ok(pdfs().every((s) => core.isPdfBytes(s.bytes) && s.size > 0));
  assert.ok(!names.some((n) => /20263194/.test(n) && n.endsWith('.pdf')), 'no-letters record produced no document');
  assert.ok(!names.some((n) => /LAPSED|PREV|HIST/i.test(n)));
  // the HTML letter was rendered to a real PDF that contains the letter text
  const rendered = pdfs().find((s) => /Correspondence_502/.test(s.filename));
  assert.match(new TextDecoder('latin1').decode(rendered.bytes), /please confirm the offer validity/);
  // no manifest file; the record is in extension storage
  noManifestFile();
  const m = stored();
  assert.equal(r.account.irepsAccountId, '833');
  assert.equal(m.records.length, 3);
  assert.equal(m.records.find((x) => x.nitOid === '103').status, 'NO_PENDING_LETTERS');
  assert.equal(m.records.find((x) => x.nitOid === '103').reason, 'NO_PENDING_LETTERS_AT_DOWNLOAD_TIME');
  const l3 = m.letters.find((x) => x.letterId === '9003');
  assert.equal(l3.status, 'DOWNLOADED');
  assert.equal(l3.files.filter((f) => f.role === 'attachment').length, 2);
  assert.equal(l3.files.find((f) => f.role === 'letter').validation.source, 'embedded_pdf');
  assert.equal(l3.files.find((f) => f.role === 'letter').validation.pdfSignature, true);
  assert.deepEqual([l3.nitOid, l3.corresId, l3.letterId, l3.letterNo, l3.letterDate], ['102', '229609', '9003', '777/B', '11/10/2026']);
  assert.match(l3.sourceAction, /POST \/epsn\/corres\/rly\/viewpubIndltr\.do \[nitOid=102&letterID=9003&corresId=229609\]/);
  // live UI events were emitted for every letter
  assert.ok(events.filter((e) => e.type === 'letter' && e.letter.status === 'DOWNLOADED').length >= 3);
  // T9: nothing secret persisted
  const blob = JSON.stringify(store);
  assert.doesNotMatch(blob, /JSESSIONID|password|cookie|TOKEN/i);
});

test('a letter IREPS serves as a web page is printed by Chrome (as Ctrl+P); PDF letters are not; no .html kept', async () => {
  scenario();
  const dbg = fakeChromeDebugger(chrome);
  try {
    const r = await go();
    assert.equal(r.summary.lettersDownloaded, 3);
    assert.equal(dbg.tabs.created, 1, 'only 9002 is a web page; 9001 is a PDF, 9003 embeds one');
    const names = saved.map((s) => s.filename);
    const printed = saved.find((s) => /Pending\/19264728\/Correspondence_502_.*\.pdf$/.test(s.filename));
    assert.match(new TextDecoder().decode(printed.bytes), /chrome-print/);
    assert.ok(!names.some((n) => n.endsWith('.html')), names.join('\n'));
    assert.match(Buffer.from(dbg.cmd('Fetch.fulfillRequest').body, 'base64').toString(), /please confirm the offer validity/);
    const v = stored().letters.find((x) => x.letterId === '9002').files.find((f) => f.role === 'letter').validation;
    assert.deepEqual([v.kind, v.source, v.pdfSignature], ['pdf (printed by Chrome)', 'chrome_print', true]);
  } finally {
    delete chrome.debugger;
    delete chrome.tabs;
  }
});
test('when Chrome cannot print, the letter keeps the text rendering + original .html and records why', async () => {
  scenario();
  fakeChromeDebugger(chrome, { attachError: 'blocked by policy' });
  try {
    await go();
    assert.ok(saved.some((s) => /Correspondence_502_.*\.html$/.test(s.filename)));
    const v = stored().letters.find((x) => x.letterId === '9002').files.find((f) => f.role === 'letter').validation;
    assert.equal(v.kind, 'pdf (rendered from HTML)');
    assert.match(v.printError, /blocked by policy/);
  } finally {
    delete chrome.debugger;
    delete chrome.tabs;
  }
});
test('10.3: when the print tab cannot be handed the letter page, the blank tab is not saved as the letter: the text rendering + original .html are kept, with why', async () => {
  scenario();
  const dbg = fakeChromeDebugger(chrome, { fulfillError: 'Invalid InterceptionId.' });
  try {
    const r = await go();
    assert.equal(r.summary.lettersDownloaded, 3);
    assert.ok(!dbg.calls.some((c) => c[0] === 'Page.printToPDF'), 'the tab that did not get the page is not printed');
    const letter = saved.find((s) => /Pending\/19264728\/Correspondence_502_.*\.pdf$/.test(s.filename));
    assert.doesNotMatch(new TextDecoder().decode(letter.bytes), /chrome-print/);
    assert.match(new TextDecoder('latin1').decode(letter.bytes), /please confirm the offer validity/);
    assert.ok(saved.some((s) => /Correspondence_502_.*\.html$/.test(s.filename)), 'the original page is kept');
    const v = stored().letters.find((x) => x.letterId === '9002').files.find((f) => f.role === 'letter').validation;
    assert.equal(v.kind, 'pdf (rendered from HTML)');
    assert.match(v.printError, /could not be handed to the print tab \(Invalid InterceptionId\.\)/);
  } finally {
    delete chrome.debugger;
    delete chrome.tabs;
  }
});
// ---- Save to: ECM / S3 (straight to a fake ECM, "ecmBackendAws": false: no Recon sign-in)
const ecmCfg = await import('../../services/ecm-config.js');
const NUXEO = 'http://ecm.test:8080';
async function withDirectEcm(fn, { refuse = false } = {}) {
  ecmCfg.applyEcmConfig({ ecmBackendAws: false, ecm: { env: 'TEST', domain: NUXEO, clientId: 'id', clientSecret: 'secret' } });
  chrome.runtime.getManifest = () => ({ host_permissions: [`${NUXEO}/*`] });
  const prev = globalThis.fetch;
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const seen = { creates: [] };
  const sizes = new Map();
  let uploaded = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (!u.startsWith(NUXEO)) return prev(url, init);
    const path = new URL(u).pathname;
    if (path === '/nuxeo/oauth2/token') return json(200, { access_token: 'tok', expires_in: 3600 });
    if (path === '/nuxeo/api/v1/search/lang/NXQL/execute') return json(200, { entries: [], isNextPageAvailable: false });
    if (path === '/nuxeo/api/v1/upload') return json(201, { batchId: 'b' });
    if (path.startsWith('/nuxeo/api/v1/upload/')) { uploaded = init.body.length; return json(201, { uploaded: 'true' }); }
    if ((init.method || 'GET') === 'GET') {
      const [uid, blob] = decodeURIComponent(path.replace('/nuxeo/api/v1/id/', '')).split('/@blob/');
      if (sizes.has(uid)) return blob ? new Response(new Uint8Array(1), { status: 200 }) : json(200, { uid, properties: { 'file:content': { length: String(sizes.get(uid)) } } });
      return json(200, { uid, path: '/FT/folder' }); // the folder check
    }
    if (refuse) return json(500, { message: 'ECM down' });
    const body = JSON.parse(init.body);
    seen.creates.push({ folder: path.replace('/nuxeo/api/v1/id/', ''), ...body.properties });
    sizes.set(`n-${seen.creates.length}`, uploaded);
    return json(201, { uid: `n-${seen.creates.length}`, path: `/x/${body.name}`, title: body.properties['dc:title'] });
  };
  try {
    return await fn(seen);
  } finally {
    globalThis.fetch = prev;
    delete chrome.runtime.getManifest;
    ecmCfg.applyEcmConfig({ ecmBackendAws: true });
  }
}

test('Save to ECM / S3: every pending letter and attachment goes to the unit\'s ECM Tenders folder as crp, not to Downloads', async () => {
  scenario();
  store['doclink.saveDestination'] = 'recon';
  await withDirectEcm(async ({ creates }) => {
    const r = await go();
    assert.equal(r.toEcm, true);
    assert.match(r.folder, /^ECM \(/);
    assert.equal(r.summary.lettersDownloaded, 3);
    assert.equal(r.summary.attachmentsDownloaded, 2);
    assert.ok(creates.every((p) => p['InvoiceCertificateSchema:type'] === 'crp' && p.folder === 'aa28acbe-add1-49d3-b0ab-16ab1263996c'), JSON.stringify(creates));
    assert.deepEqual(creates.map((p) => p['dc:title']).sort(), [
      '19264728 - CRP - 501 - Confirmation;', '19264728 - CRP - 502 - Confirmation;',
      'L1265428 - CRP - 777/B - Attachment - Annexure 1.pdf', 'L1265428 - CRP - 777/B - Attachment - drawing.pdf', 'L1265428 - CRP - 777/B - Clarification / price',
    ]);
    assert.deepEqual(creates.map((p) => p['InvoiceCertificateSchema:tenderNumber']).sort(), ['19264728', '19264728', 'L1265428', 'L1265428', 'L1265428']);
    // the tender date (13 Nov 2026 meeting): every details page here shows "Closing Date 09/10/2026 10:30" (the fixture
    // of L1265428); the letters' own "Last date for submission of reply" (15/10/2026) is not the tender's date
    assert.deepEqual([...new Set(creates.map((p) => p['InvoiceCertificateSchema:tenderDate']))], ['2026-10-09']);
    // nothing that went to the ECM is in Downloads (only the original page of the letter Chrome could not print)
    assert.deepEqual(saved.map((s) => s.filename.split('/').pop()), ['Correspondence_502_11-10-2026_Confirmation;.html']);
    const l3 = stored().letters.find((x) => x.letterId === '9003');
    const letter = l3.files.find((f) => f.role === 'letter');
    assert.deepEqual([letter.ecm.status, letter.relPath, letter.fileName], ['stored', null, 'letter9003.pdf']);
    assert.ok(l3.files.filter((f) => f.role === 'attachment').every((f) => f.ecm.status === 'stored' && f.relPath === null));
  });
});
test('Save to ECM / S3: a letter the ECM does not take is saved to Downloads instead, with the reason', async () => {
  scenario();
  store['doclink.saveDestination'] = 'recon';
  await withDirectEcm(async ({ creates }) => {
    const r = await go();
    assert.equal(creates.length, 0);
    assert.equal(r.summary.lettersDownloaded, 3);
    const names = saved.map((s) => s.filename);
    assert.ok(names.includes('DocLink/HOSUR/Correspondence/Pending/19264728/Correspondence_501_11-10-2026_Confirmation;.pdf'), names.join('\n'));
    assert.ok(names.some((n) => /Pending\/L1265428\/Annexure 1\.pdf$/.test(n)));
    const letter = stored().letters.find((x) => x.letterId === '9001').files.find((f) => f.role === 'letter');
    assert.equal(letter.ecm.status, 'failed');
    assert.match(letter.relPath, /Correspondence_501/);
  }, { refuse: true });
});
test('Save to Local: nothing is sent to the ECM', async () => {
  scenario();
  store['doclink.saveDestination'] = 'local';
  await withDirectEcm(async ({ creates }) => {
    const r = await go();
    assert.equal(r.toEcm, false);
    assert.equal(creates.length, 0);
    assert.ok(stored().letters.every((l) => l.files.every((f) => !f.ecm)));
  });
});

test('T4 empty pending table: finishes cleanly, only the list is requested', async () => {
  mk({ rows: [] });
  const r = await go();
  assert.equal(r.empty, true);
  assert.equal(r.summary.pendingRecords, 0);
  assert.deepEqual(server.log.map((l) => l.path).filter((p) => p.startsWith('/epsn/corres')), [LIST]);
  assert.equal(pdfs().length, 0);
});

test('T5 parent still Pending but its details page lists no pending letters -> NO_PENDING_LETTERS, others continue', async () => {
  mk({ rows: [{ no: 'A', oid: '1' }, { no: 'B', oid: '2' }], details: { 1: { oid: '1', tenderNo: 'A', letters: [] }, 2: { oid: '2', tenderNo: 'B', letters: [{ no: '1', id: '7', subject: 'x' }] } }, letters: { 7: letterPdf('b') } });
  const r = await go();
  assert.equal(r.summary.noPendingLetters, 1);
  assert.equal(r.summary.lettersDownloaded, 1);
});

test('T8 failure then retry: failed letter does not stop the next one; retry fetches only the failed one, no duplicates', async () => {
  mk({
    rows: [{ no: 'A', oid: '1' }],
    details: { 1: { oid: '1', tenderNo: 'A', letters: [{ no: '1', id: '7', subject: 'first' }, { no: '2', id: '8', subject: 'second' }] } },
    letters: { 7: () => ({ status: 503, bytes: enc('busy'), type: 'text/plain', extra: {} }), 8: letterPdf('second') },
  });
  const r1 = await go();
  assert.equal(server.hits['7'], 3, 'bounded retries with backoff, then give up');
  assert.deepEqual([r1.summary.lettersDownloaded, r1.summary.failed], [1, 1]);
  assert.equal(pdfs().length, 1);
  server.s.letters[7] = letterPdf('first');
  const before = server.hits['8'];
  const r2 = await go({ mode: 'retry' });
  assert.equal(server.hits['8'], before, 'the already-saved letter is not requested again');
  assert.deepEqual([r2.summary.lettersDownloaded, r2.summary.failed, r2.summary.alreadyDownloaded], [2, 0, 1]);
  assert.equal(pdfs().length, 2, 'exactly one file per letter');
  // a plain second "Download All" also never duplicates
  await go();
  assert.equal(pdfs().length, 2);
  assert.equal(stored().letters.filter((l) => l.status === 'DOWNLOADED').length, 2);
  noManifestFile();
});

test('T8b a failed attachment keeps the letter saved; retry downloads only the missing attachment', async () => {
  mk({
    rows: [{ no: 'A', oid: '1' }],
    details: { 1: { oid: '1', tenderNo: 'A', letters: [{ no: '1', id: '7', subject: 'with attachment' }] } },
    letters: { 7: () => ({ status: 200, bytes: enc('<html><body><iframe src="/ireps/corr/l.pdf"></iframe><a href="/ireps/corr/ok.pdf">ok</a><a href="/ireps/corr/bad.pdf">bad</a></body></html>'), type: 'text/html', extra: {} }) },
    attachments: { 'l.pdf': letterPdf('l'), 'ok.pdf': letterPdf('ok') },
  });
  const r1 = await go();
  assert.equal(r1.summary.failed, 1);
  assert.equal(pdfs().length, 2);
  server.s.attachments['bad.pdf'] = letterPdf('bad');
  const r2 = await go({ mode: 'retry' });
  assert.deepEqual([r2.summary.failed, r2.summary.lettersDownloaded], [0, 1]);
  assert.equal(pdfs().length, 3);
  assert.equal(pdfs().filter((s) => /\/l\.pdf$/.test(s.filename)).length, 1, 'letter not saved twice');
});

test('10.2: an attachment that is not a PDF and whose Content-Disposition name holds a "%" is saved under that name, never failed with "URI malformed"', async () => {
  const OLE = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
  mk({
    rows: [{ no: 'A', oid: '1' }],
    details: { 1: { oid: '1', tenderNo: 'A', letters: [{ no: '1', id: '7', subject: 'rates' }] } },
    letters: { 7: () => ({ status: 200, bytes: enc('<html><body><iframe src="/ireps/corr/l.pdf"></iframe><a href="/ireps/corr/rates.doc">Rates</a></body></html>'), type: 'text/html', extra: {} }) },
    attachments: { 'l.pdf': letterPdf('l'), 'rates.doc': () => ({ status: 200, bytes: OLE, type: 'application/msword', extra: { 'content-disposition': 'attachment; filename="Rates 10%.doc"' } }) },
  });
  const r = await go();
  assert.deepEqual([r.summary.lettersDownloaded, r.summary.attachmentsDownloaded, r.summary.failed], [1, 1, 0], JSON.stringify(stored().letters.map((l) => l.error)));
  assert.ok(saved.some((s) => s.filename.endsWith('/Pending/A/Rates 10%.doc')), saved.map((s) => s.filename).join('\n'));
});
test('File names: two letters of a tender attach different files with one IREPS name - both are kept, the later with its letter number; again on a re-run', async () => {
  const page = (dir) => () => ({ status: 200, bytes: enc(`<html><body><iframe src="/ireps/corr/${dir}/letter.pdf"></iframe><a href="/ireps/corr/${dir}/Annexure.pdf">Annexure</a></body></html>`), type: 'text/html', extra: {} });
  mk({
    rows: [{ no: 'A', oid: '1' }],
    details: { 1: { oid: '1', tenderNo: 'A', letters: [{ no: '11', id: '7', subject: 'first' }, { no: '12', id: '8', subject: 'second' }] } },
    letters: { 7: page('x'), 8: page('y') },
    attachments: { 'letter.pdf': letterPdf('l'), 'Annexure.pdf': letterPdf('a') },
  });
  await go();
  const names = () => saved.map((s) => s.filename.replace('DocLink/HOSUR/Correspondence/Pending/A/', '')).sort();
  assert.deepEqual(names(), ['Annexure.pdf', 'Annexure_12.pdf', 'letter.pdf', 'letter_8.pdf']);
  saved.length = 0;
  await go({ force: true });
  assert.deepEqual(names(), ['Annexure.pdf', 'Annexure_12.pdf', 'letter.pdf', 'letter_8.pdf'], 'the same names each run, so a re-download overwrites its own file');
});
test('T6b login page, HTTP error page or empty reply is never saved as a letter', async () => {
  mk({
    rows: [{ no: 'A', oid: '1' }],
    details: { 1: { oid: '1', tenderNo: 'A', letters: [{ no: '1', id: '7', subject: 'a' }, { no: '2', id: '8', subject: 'b' }, { no: '3', id: '9', subject: 'c' }] } },
    letters: {
      7: () => ({ status: 200, bytes: enc('<html><head><title>Error</title></head><body>An error occurred while processing your request. Contact the administrator.</body></html>'), type: 'text/html', extra: {} }),
      8: () => ({ status: 200, bytes: new Uint8Array(), type: 'text/html', extra: {} }),
      9: letterPdf('ok'),
    },
  });
  const r = await go();
  assert.equal(r.summary.unavailable, 2);
  assert.equal(r.summary.lettersDownloaded, 1);
  assert.equal(pdfs().length, 1);
  assert.ok(saved.every((s) => !s.filename.endsWith('.html')));
});

test('session expiry mid-run stops safely, marks the rest SESSION_EXPIRED, saves nothing from the login page', async () => {
  mk({
    rows: [{ no: 'A', oid: '1' }, { no: 'B', oid: '2' }],
    details: { 1: { oid: '1', tenderNo: 'A', letters: [{ no: '1', id: '7', subject: 'a' }, { no: '2', id: '8', subject: 'b' }] }, 2: { oid: '2', tenderNo: 'B', letters: [{ no: '3', id: '9', subject: 'c' }] } },
    letters: { 7: letterPdf('a'), 8: () => { server.s.expired = true; return { status: 200, bytes: loginPage(), type: 'text/html', extra: {} }; }, 9: letterPdf('c') },
  });
  const r = await go();
  assert.equal(r.aborted.code, 'SESSION_EXPIRED');
  assert.equal(r.summary.lettersDownloaded, 1);
  assert.equal(r.summary.sessionExpired, 1);
  assert.equal(pdfs().length, 1);
  assert.equal(server.log.filter((l) => l.path === REPLY).length, 1, 'record B was not requested after expiry');
  noManifestFile();
});

test('not logged in at start -> SESSION_EXPIRED error; unverifiable account -> ACCOUNT error and no correspondence request', async () => {
  mk({ expired: true });
  await assert.rejects(() => go(), (e) => e.code === 'SESSION_EXPIRED');
  mk({ account: { id: '833', company: 'X' } });
  server.s.account = { id: '', company: '' };
  await assert.rejects(() => go(), (e) => e.code === 'ACCOUNT');
  assert.equal(server.log.filter((l) => l.path.startsWith('/epsn/corres')).length, 0);
});

test('a details page for a different tender, or a letter with a foreign nitOid, is flagged for review and not downloaded', async () => {
  mk({
    rows: [{ no: 'A', oid: '1' }, { no: 'B', oid: '2' }],
    details: { 1: { oid: '1', tenderNo: 'SOMETHING-ELSE', letters: [{ no: '1', id: '7', subject: 'a' }] }, 2: { oid: '2', tenderNo: 'B', letters: [{ no: '2', id: '8', subject: 'b', oid: '999' }] } },
    letters: { 7: letterPdf('a'), 8: letterPdf('b') },
  });
  const r = await go();
  assert.equal(r.summary.lettersDownloaded, 0);
  assert.ok(r.summary.needsReview >= 2);
  assert.equal(server.log.filter((l) => l.path === VIEW).length, 0);
  assert.equal(pdfs().length, 0);
});

test('two tenders sharing a number get separate folders; a filename collision across letters gets the letter id', async () => {
  mk({
    rows: [{ no: 'SAME', oid: '1' }, { no: 'SAME', oid: '2' }],
    details: { 1: { oid: '1', tenderNo: 'SAME', letters: [{ no: '5', id: '70', subject: 'dup' }] }, 2: { oid: '2', tenderNo: 'SAME', letters: [{ no: '5', id: '71', subject: 'dup' }] } },
    letters: { 70: letterPdf('a'), 71: letterPdf('b') },
  });
  await go();
  const names = pdfs().map((s) => s.filename);
  assert.ok(names.some((n) => /Pending\/SAME_1\//.test(n)) && names.some((n) => /Pending\/SAME_2\//.test(n)), names.join('\n'));
});

// =========================== review fixes: H4, H5, M21, L12 ===============================
test('H5: the guard also refuses verbs that start the name or run together with it (submitbid, finalSubmission, withdrawalOfBid) and logout', async () => {
  for (const p of ['/epsn/supply/bid/submitbid.do', '/epsn/supply/tds/finalSubmission.do', '/epsn/supply/tds/withdrawalOfBid.do', '/epsn/home/logout.do', '/epsn/corres/vendor/submitReplyLetter.do']) {
    assert.throws(() => P.assertReadOnly(p), (e) => e.code === 'BLOCKED', p);
    await assert.rejects(() => P.pcFetch('https://www.ireps.gov.in', p, { method: 'POST', form: { nitOid: '1' } }), (e) => e.code === 'BLOCKED', p);
  }
  P.assertReadOnly('/epsn/x/viewUploadedDoc.do'); P.assertReadOnly('/ireps/corr/Submission_List.pdf'); P.assertReadOnly(VIEW);
  assert.equal(server.log.length, 0);
});
test('H4: a correspondence page without a "Correspondence - Pending" table DocLink can read is an error, never "No correspondence found"', async () => {
  for (const listOverride of [LIST_FIX.replace('Correspondence - Pending', 'Correspondence - Lapsed'), LIST_FIX.replace(/>Tender No\.<\/th>/, '>Reference</th>')]) {
    mk({ listOverride });
    await assert.rejects(() => go(), (e) => e.code === 'PAGE' && /does not recognise/.test(e.message) && /Correspondence - Pending/.test(e.message));
    assert.deepEqual(server.log.filter((l) => l.path.startsWith('/epsn/corres')).map((l) => l.path), [LIST], 'nothing guessed from it');
  }
  mk({ rows: [] });
  assert.equal((await go()).empty, true, 'IREPS\'s own empty Pending table is still "No correspondence found"');
});
test('1.6: a Pending row DocLink cannot open (no nitOid) is reported for review, never "No correspondence found"', async () => {
  mk({ rows: [{ no: 'X1', oid: '' }] });
  const events = [];
  const r = await go({ onEvent: (e) => events.push(e) });
  assert.equal(r.empty, false, 'the panel does not say "No correspondence found"');
  assert.equal(r.summary.needsReview, 1);
  assert.deepEqual(r.needsReview, [{ tenderNo: 'X1', reason: 'No pending-correspondence action with a nitOid was found on this row' }]);
  assert.ok(events.some((e) => e.type === 'records' && e.skipped.some((s) => s.tenderNo === 'X1' && s.unreadable)), 'the row is shown in the table, for review');
  mk({ rows: [{ no: 'X1', oid: '' }, { no: 'A', oid: '1' }], details: { 1: { oid: '1', tenderNo: 'A', letters: [{ no: '1', id: '7', subject: 'x' }] } }, letters: { 7: letterPdf('a') } });
  const mixed = await go();
  assert.deepEqual([mixed.empty, mixed.summary.lettersDownloaded, mixed.summary.needsReview], [false, 1, 1]);
});
test('H4: a details page without a "Pending Replies" table fails that record (Retry failed retries it); an empty one is still "no pending letters"', async () => {
  mk({
    rows: [{ no: 'A', oid: '1' }, { no: 'B', oid: '2' }],
    details: { 1: { oid: '1', tenderNo: 'A', letters: [{ no: '1', id: '7', subject: 'x' }], noPendingHeading: true }, 2: { oid: '2', tenderNo: 'B', letters: [] } },
    letters: { 7: letterPdf('a') },
  });
  const r = await go();
  assert.deepEqual([r.summary.failed, r.summary.noPendingLetters, r.summary.lettersDownloaded], [1, 1, 0]);
  const rec = stored().records.find((x) => x.nitOid === '1');
  assert.equal(rec.status, 'FAILED');
  assert.match(rec.error, /no "Pending Replies" table/);
  assert.equal(server.log.filter((l) => l.path === VIEW).length, 0, 'nothing was guessed from the page');
  server.s.details[1].noPendingHeading = false;
  const again = await go({ mode: 'retry' });
  assert.equal(again.summary.lettersDownloaded, 1, 'retried, and downloaded once IREPS shows the table');
});
test('2.3: a record that fails this run is counted as failed (Retry failed is offered) even when an earlier run listed its letters', async () => {
  mk({ rows: [{ no: 'A', oid: '1' }], details: { 1: { oid: '1', tenderNo: 'A', letters: [{ no: '1', id: '7', subject: 'x' }] } }, letters: { 7: letterPdf('a') } });
  assert.equal((await go()).summary.lettersDownloaded, 1);
  server.s.details = {}; // IREPS now answers the record's details page with HTTP 500
  const r = await go();
  assert.equal(stored().records.find((x) => x.nitOid === '1').status, 'FAILED');
  assert.equal(r.summary.failed, 1, 'the red row is counted, so the panel offers "Retry failed"');
  assert.deepEqual(r.failedRecords.map((f) => [f.tenderNo, f.code]), [['A', 'HTTP']]);
});
test('M21: letters and records not seen in a run for 400 days are forgotten; at most 2,000 letters are kept', () => {
  const now = Date.parse('2026-11-15T10:00:00Z');
  const iso = (d) => new Date(now - d * 86400000).toISOString();
  const state = { records: { a: { updatedAt: iso(10) }, b: { updatedAt: iso(500) } }, letters: {} };
  for (let i = 0; i < 2500; i++) state.letters[`k${i}`] = { key: `k${i}`, seenAt: iso(i % 450) };
  state.letters.legacy = { key: 'legacy', downloadedAt: '' }; // written before letters had seenAt
  P.pruneCorrespondenceState(state, now);
  assert.deepEqual(Object.keys(state.records), ['a']);
  assert.equal(Object.keys(state.letters).length, P.STATE_LIMITS.maxLetters);
  assert.ok(Object.values(state.letters).every((l) => Date.parse(l.seenAt) >= now - P.STATE_LIMITS.keepMs));
  assert.ok(state.letters.legacy, 'a letter without seenAt is stamped and kept, not dropped');
});
test('L12: an attachment GET that cannot reach IREPS is tried again; the letter POST is not', async () => {
  core.fetchSettings.netRetryMs = [5, 5];
  mk({
    rows: [{ no: 'A', oid: '1' }],
    details: { 1: { oid: '1', tenderNo: 'A', letters: [{ no: '1', id: '7', subject: 'net' }, { no: '2', id: '8', subject: 'post' }] } },
    letters: { 7: () => ({ status: 200, bytes: enc('<html><body><iframe src="/ireps/corr/l7.pdf"></iframe><a href="/ireps/corr/att7.pdf">Annex</a></body></html>'), type: 'text/html', extra: {} }), 8: letterPdf('eight') },
    attachments: { 'l7.pdf': letterPdf('l7'), 'att7.pdf': letterPdf('att7') },
  });
  const shim = globalThis.fetch;
  const tries = {};
  globalThis.fetch = (url, init = {}) => {
    const key = `${new URL(String(url).replace('https://ext.invalid/', 'https://www.ireps.gov.in/')).pathname}${init.body ? `?${init.body}` : ''}`;
    tries[key] = (tries[key] || 0) + 1;
    if ((key === '/ireps/corr/att7.pdf' || /letterID=8/.test(key)) && tries[key] === 1) return Promise.reject(new TypeError('Failed to fetch'));
    return shim(url, init);
  };
  try {
    const r = await go();
    assert.equal(tries['/ireps/corr/att7.pdf'], 2, 'the attachment GET was tried again');
    assert.deepEqual([r.summary.lettersDownloaded, r.summary.attachmentsDownloaded, r.summary.failed], [1, 1, 1]);
    assert.equal(Object.keys(tries).filter((k) => /letterID=8/.test(k)).map((k) => tries[k]).join(), '1', 'the letter POST was not repeated');
    assert.match(stored().letters.find((l) => l.letterId === '8').error, /could not reach/);
  } finally {
    globalThis.fetch = shim;
    core.fetchSettings.netRetryMs = [1000, 3000];
  }
});

// =========================== UI (real popup.html in jsdom) ==============================
let panelLoaded = null;
/** popup.html in jsdom with tender/pending-ui.js loaded, once for all the UI tests (the view's listeners belong to that page). */
function correspondencePanel() {
  panelLoaded ||= (async () => {
    const dom = new JSDOM(readFileSync(new URL('../../popup/popup.html', import.meta.url), 'utf8').replace(/<script[^>]*><\/script>/g, ''), { pretendToBeVisual: true });
    // the panel's own events (Recon sign-in, download-again prompt) must be jsdom's, as in the real page
    Object.assign(globalThis, { document: dom.window.document, window: dom.window, MutationObserver: dom.window.MutationObserver, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent });
    Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
    await import('../pending-ui.js');
  })();
  return panelLoaded;
}
const pcEl = (id) => document.getElementById(id);
/** Until the view's run has ended (its progress line is hidden again). */
const pcFinished = async () => { for (let i = 0; i < 400 && (pcEl('pc-progress').hidden === true ? i < 3 : true); i++) await new Promise((r) => setTimeout(r, 25)); await new Promise((r) => setTimeout(r, 400)); };
const pcRows = () => [...document.querySelectorAll('#pc-tbody tr')].map((tr) => tr.textContent.replace(/\s+/g, ' '));

test('UI: clicking "Download All Correspondence" fills the progress table and counts; empty state shown when nothing pending', async () => {
  scenario();
  await correspondencePanel();
  const $ = pcEl;
  assert.equal($('btn-pending-open').textContent, 'Correspondence');
  assert.match($('btn-pc-run').textContent, /Download All Correspondence/);
  const finished = pcFinished;
  $('btn-pc-run').click();
  await finished();
  const text = [...document.querySelectorAll('#pc-tbody tr')].map((tr) => tr.textContent.replace(/\s+/g, ' '));
  assert.ok(text.some((t) => /19264728/.test(t) && /501/.test(t) && /DOWNLOADED/.test(t)), text.join('\n'));
  assert.ok(text.some((t) => /20263194/.test(t) && /NO PENDING LETTERS/.test(t)), text.join('\n'));
  assert.equal($('pc-n-records').textContent, '3');
  assert.equal($('pc-n-letters').textContent, '3');
  assert.match($('pc-n-downloaded').textContent, /^3/);
  assert.equal($('pc-n-attachments').textContent, '2');
  assert.equal($('pc-error').hidden, true);
  mk({ rows: [] });
  $('btn-pc-run').click();
  await finished();
  assert.equal($('pc-empty').hidden, false);
  assert.equal($('pc-empty').textContent, 'No correspondence found');
});
test('UI (7.12): a run that fails at its start shows its own error alone, never the last run\'s counts, folder or "Retry failed"', async () => {
  // a run that leaves a letter to retry (IREPS answers it with HTTP 404): its counts, folder and Retry are shown
  mk({ rows: [{ no: 'A', oid: '1' }], details: { 1: { oid: '1', tenderNo: 'A', letters: [{ no: '1', id: '7', subject: 'x' }] } }, letters: {} });
  await correspondencePanel();
  const $ = pcEl;
  $('btn-pc-run').click();
  await pcFinished();
  assert.deepEqual([$('pc-counts').hidden, $('pc-n-failed').textContent, $('btn-pc-retry').hidden], [false, '1', false]);
  assert.match($('pc-folder').textContent, /^Downloads\//);
  // the next run meets IREPS's login page before anything is listed
  server.s.expired = true;
  $('btn-pc-run').click();
  await pcFinished();
  assert.deepEqual([$('pc-error').hidden, $('pc-error-message').textContent], [false, core.SESSION_MSG]);
  assert.deepEqual([$('pc-counts').hidden, $('pc-folder').textContent, $('btn-pc-retry').hidden, $('pc-n-failed').textContent], [true, '', true, '0'], 'nothing of the last run next to the error');
  assert.deepEqual(pcRows(), []);
});
test('7.13: "Retry failed" counts what an earlier run saved as already saved, never as new, and a record that earlier run finished shows as downloaded', async () => {
  const twoRecords = () => mk({
    rows: [{ no: 'A', oid: '1' }, { no: 'B', oid: '2' }],
    details: { 1: { oid: '1', tenderNo: 'A', letters: [{ no: '1', id: '7', subject: 'done' }] }, 2: { oid: '2', tenderNo: 'B', letters: [{ no: '2', id: '8', subject: 'later' }] } },
    letters: { 7: () => ({ status: 200, bytes: enc('<html><body><iframe src="/ireps/corr/l7.pdf"></iframe><a href="/ireps/corr/a7.pdf">Annex</a></body></html>'), type: 'text/html', extra: {} }) },
    attachments: { 'l7.pdf': letterPdf('l7'), 'a7.pdf': letterPdf('a7') },
  });
  twoRecords();
  const first = await go();
  assert.deepEqual([first.summary.lettersDownloaded, first.summary.attachmentsDownloaded, first.summary.failed], [1, 1, 1]);
  server.s.letters[8] = letterPdf('eight'); // IREPS now gives B's letter
  const events = [];
  const again = await go({ mode: 'retry', onEvent: (e) => events.push(e) });
  assert.deepEqual([again.summary.lettersDownloaded, again.summary.alreadyDownloaded, again.summary.attachmentsDownloaded, again.summary.failed], [2, 1, 0, 0],
    'B\'s letter is this run\'s; A\'s letter and its attachment were saved by the first run');
  assert.equal(server.hits['7'], 1, 'A\'s letter is not opened again');
  const recordA = events.filter((e) => e.type === 'record' && e.nitOid === '1').pop().record;
  assert.deepEqual([recordA.status, recordA.savedEarlier], ['DOWNLOADED', true]);
  assert.ok(events.some((e) => e.type === 'letter' && e.letter.letterId === '7' && e.letter.status === 'DOWNLOADED' && e.letter.alreadyDownloaded), 'A\'s letter is listed, as already downloaded');
  // the same in the view: no row stays "PENDING", and the counts say what the retry did
  twoRecords();
  await correspondencePanel();
  const $ = pcEl;
  $('btn-pc-run').click();
  await pcFinished();
  assert.equal($('btn-pc-retry').hidden, false);
  server.s.letters[8] = letterPdf('eight');
  $('btn-pc-retry').click();
  await pcFinished();
  assert.ok(!pcRows().some((t) => /PENDING/.test(t)), pcRows().join('\n'));
  const rowsOfA = pcRows().filter((t) => t.startsWith('A'));
  assert.ok(rowsOfA.length && rowsOfA.every((t) => /DOWNLOADED/.test(t) && /Downloaded by an earlier run|already downloaded/.test(t)), pcRows().join('\n'));
  assert.deepEqual([$('pc-n-downloaded').textContent, $('pc-n-attachments').textContent, $('pc-n-failed').textContent], ['2 (1 already saved)', '0', '0']);
  // a finished record whose letters DocLink no longer keeps (STATE_LIMITS) shows as downloaded too, never "PENDING"
  twoRecords();
  $('btn-pc-run').click();
  await pcFinished();
  const kept = store['doclink.tender.ledger.833'].manifests['pending-correspondence'];
  for (const k of Object.keys(kept.letters)) if (kept.letters[k].letterId === '7') delete kept.letters[k];
  server.s.letters[8] = letterPdf('eight');
  $('btn-pc-retry').click();
  await pcFinished();
  assert.ok(!pcRows().some((t) => /PENDING/.test(t)), pcRows().join('\n'));
  assert.ok(pcRows().some((t) => t.startsWith('A') && /DOWNLOADED/.test(t) && /Downloaded by an earlier run/.test(t)), pcRows().join('\n'));
});

// =========================== scheduled downloads, Phase 2 (tender-shared-run.js) ===========================
const sharedRun = await import('../tender-shared-run.js');
const dlog = await import('../../services/download-log.js');
test('Scheduled run: each pending letter is reserved; one already saved is not opened; the rest go to the ECM only', async () => {
  scenario();
  const calls = { reserved: [], ecm: [], saved: [] };
  const firstKey = [];
  sharedRun.beginSharedRun({
    reserveDocuments: async (keys) => {
      calls.reserved.push(...keys);
      if (!firstKey.length) firstKey.push(keys[0]); // the first letter: already saved by someone else
      const taken = keys.filter((k) => k === firstKey[0]);
      return { granted: new Set(keys.filter((k) => !taken.includes(k))), taken: new Map(taken.map((k) => [k, { by: 'Priya' }])) };
    },
    ecmSink: { save: async (doc) => { calls.ecm.push(doc); return { ecm: { status: 'stored', uid: `u${calls.ecm.length}` }, local: null }; } },
    documentSaved: async (record) => { calls.saved.push(record); },
  });
  try {
    await go();
  } finally {
    sharedRun.endSharedRun();
  }
  assert.equal(calls.reserved.length, 3, 'every letter reserved');
  assert.ok(calls.reserved.every((k) => k.startsWith('pending:') && k.endsWith('|letter')));
  assert.deepEqual(server.log.filter((l) => l.path === VIEW).map((l) => l.form.letterID), ['9002', '9003'], 'the taken letter (9001) was not opened');
  assert.deepEqual(saved, [], 'nothing in Downloads (no .html copy either)');
  assert.ok(calls.ecm.length >= 2 && calls.ecm.every((d) => d.kind === 'crp'));
  assert.equal(calls.saved.length, calls.ecm.length, 'every ECM save reported');
  assert.ok(calls.saved.every((r) => r.destination === 'ecm' && r.doc_type === dlog.TENDER_DOC_TYPE.PENDING_CORRESPONDENCE));
  assert.ok(Object.keys(store).some((k) => k.endsWith('#scheduled')), 'its own ledger');
});

// ---- how a scheduled correspondence run ends, as tender/schedule-runner.js computes it
const sharedHooksMod = await import('../../services/scheduler/shared-run-hooks.js');
const tenderRunner = await import('../../services/scheduler/tender-runner.js');
/**
 * A fake Recon Engine that remembers what was saved for the account (`done`), so the next run's reservation
 * says "taken" for it; `completeFails`: its answers to `complete` are lost (the runner tab was killed).
 */
const reconEngine = () => ({ done: new Set(), completed: [], completeFails: false });
async function scheduledRun(recon, { uploads = [] } = {}) {
  const api = {
    reserve: async (req) => ({ granted: req.keys.filter((k) => !recon.done.has(k)), taken: Object.fromEntries(req.keys.filter((k) => recon.done.has(k)).map((k) => [k, { status: 'done', by: { name: 'Priya' } }])) }),
    complete: async (req) => {
      if (recon.completeFails) throw Object.assign(new Error('no answer'), { code: 'SCHEDULE_BACKEND_UNAVAILABLE' });
      recon.completed.push(req);
      for (const d of req.done) recon.done.add(d.doc_key);
      return {};
    },
  };
  const hooks = sharedHooksMod.createSharedRunHooks({ api, claimId: 'c1', account: { irepsAccountId: '833', operatingUnit: 'HOSUR' }, isClaimLive: () => true, sleep: async () => {}, logFallback: async () => {},
    uploadEcm: async (doc) => (uploads.push(doc.filename), { uid: `u-${doc.filename}`, site: 'hosur', path: '/ECM/Hosur/Tenders', deduplicated: false }) });
  let result = null;
  let error = null;
  sharedRun.beginSharedRun(hooks.tenderHooks);
  try {
    result = await go();
  } catch (e) {
    error = { code: e.code || 'UNKNOWN', message: e.message };
  } finally {
    sharedRun.endSharedRun();
  }
  const counts = await hooks.finishTenderRun({ stopped: tenderRunner.stoppedCode(result, error) });
  return { result, outcome: tenderRunner.tenderRunOutcome({ result, error, counts, details: hooks.details() }), uploads };
}
const letterKeyOf = (letterId) => dlog.downloadKey.pending(`833|1|229609|${letterId}`, 'letter');
test('Scheduled run (2.2): a letter saved without one of its attachments is not done: it is named, and the next check fetches only the missing attachment', async () => {
  mk({
    rows: [{ no: 'A', oid: '1' }],
    details: { 1: { oid: '1', tenderNo: 'A', letters: [{ no: '1', id: '7', subject: 'with attachment' }] } },
    letters: { 7: () => ({ status: 200, bytes: enc('<html><body><iframe src="/ireps/corr/l.pdf"></iframe><a href="/ireps/corr/ok.pdf">ok</a><a href="/ireps/corr/bad.pdf">bad</a></body></html>'), type: 'text/html', extra: {} }) },
    attachments: { 'l.pdf': letterPdf('l'), 'ok.pdf': letterPdf('ok') },
  });
  const recon = reconEngine();
  const first = await scheduledRun(recon);
  assert.deepEqual([first.outcome.outcome, first.outcome.code], ['partial', 'SCHEDULE_DOWNLOAD_FAILED'], JSON.stringify(first.outcome));
  assert.deepEqual(first.outcome.result.failures.map((f) => f.doc), ['Tender A - letter 1 (attachment)']);
  assert.match(first.outcome.result.failures[0].detail, /1 attachment\(s\) could not be downloaded \(the letter itself was saved\)\. IREPS returned HTTP 404/);
  assert.ok(!recon.done.has(letterKeyOf('7')), 'the letter is not marked saved while its attachment is missing');
  assert.ok(recon.completed.some((c) => c.failed.some((f) => f.doc_key === letterKeyOf('7'))), 'its reservation is released as failed');
  server.s.attachments['bad.pdf'] = letterPdf('bad');
  const second = await scheduledRun(recon);
  assert.deepEqual(second.uploads, ['bad.pdf'], 'only the missing attachment: the letter and the other attachment are not uploaded again');
  assert.equal(second.outcome.outcome, 'done', JSON.stringify(second.outcome));
  assert.ok(recon.done.has(letterKeyOf('7')), 'now the letter is saved for the account');
  const viewsBefore = server.hits['7'];
  assert.equal((await scheduledRun(recon)).outcome.outcome, 'done');
  assert.equal(server.hits['7'], viewsBefore, 'the next check does not open it again');
});
test('Scheduled run (1.10): a letter an earlier run saved to the ECM, but never reported (the runner tab was closed), is reported now; the slot ends done', async () => {
  mk({ rows: [{ no: 'A', oid: '1' }], details: { 1: { oid: '1', tenderNo: 'A', letters: [{ no: '1', id: '7', subject: 'x' }] } }, letters: { 7: letterPdf('a') } });
  const recon = reconEngine();
  recon.completeFails = true; // the tab is gone before it can tell the Recon Engine
  await scheduledRun(recon);
  assert.ok(!recon.done.has(letterKeyOf('7')));
  recon.completeFails = false;
  const views = server.hits['7'];
  const next = await scheduledRun(recon);
  assert.equal(server.hits['7'], views, 'the letter is not downloaded again');
  assert.deepEqual(next.uploads, []);
  assert.deepEqual([next.outcome.outcome, next.outcome.result.failed], ['done', 0], JSON.stringify(next.outcome));
  assert.ok(recon.done.has(letterKeyOf('7')), 'the letter in the ECM is reported, so no check finds it "reserved, but not saved" again');
});
test('Scheduled run (1.6): letters and Pending rows DocLink could not match are "Needs review", never a "done" run; nothing pending at all is done', async () => {
  mk({
    rows: [{ no: 'A', oid: '1' }, { no: 'X1', oid: '' }],
    details: { 1: { oid: '1', tenderNo: 'A', letters: [{ no: '1', id: '7', subject: 'ok' }, { no: '2', id: '8', subject: 'foreign', oid: '999' }] } },
    letters: { 7: letterPdf('a'), 8: letterPdf('b') },
  });
  const { outcome } = await scheduledRun(reconEngine());
  assert.deepEqual([outcome.outcome, outcome.code, outcome.result.saved], ['partial', 'SCHEDULE_NEEDS_REVIEW', 1], JSON.stringify(outcome));
  assert.deepEqual(outcome.result.failures.map((f) => [f.doc, f.code]), [['Correspondence of tender X1', 'SCHEDULE_NEEDS_REVIEW'], ['Tender A - letter 2', 'SCHEDULE_NEEDS_REVIEW']]);
  mk({ rows: [{ no: 'X1', oid: '' }] });
  const unreadable = (await scheduledRun(reconEngine())).outcome;
  assert.deepEqual([unreadable.outcome, unreadable.code], ['failed', 'SCHEDULE_NEEDS_REVIEW'], 'never "No correspondence found" as done');
  mk({ rows: [] });
  assert.equal((await scheduledRun(reconEngine())).outcome.outcome, 'done', 'IREPS lists nothing pending');
});
test('Scheduled run: a letter the ECM refuses is reported to the scheduler with its key, its name and the reason', async () => {
  scenario();
  const failed = [];
  sharedRun.beginSharedRun({
    reserveDocuments: async (keys) => ({ granted: new Set(keys), taken: new Map() }),
    ecmSink: { save: async () => { throw Object.assign(new Error('the ECM did not answer in time'), { code: 'ECM_UNAVAILABLE' }); } },
    documentSaved: async () => { throw new Error('nothing is saved'); },
    documentFailed: (f) => { failed.push(f); },
  });
  try {
    await go();
  } finally {
    sharedRun.endSharedRun();
  }
  assert.ok(failed.length >= 2, `every letter that failed is reported (${failed.length})`);
  assert.ok(failed.every((f) => f.key.startsWith('pending:') && f.key.endsWith('|letter')), failed.map((f) => f.key).join());
  assert.ok(failed.every((f) => f.code === 'ECM_UNAVAILABLE' && f.detail === 'the ECM did not answer in time'));
  assert.ok(failed.some((f) => /^Tender L1265428 - letter 777\/B$/.test(f.doc)), failed.map((f) => f.doc).join());
});

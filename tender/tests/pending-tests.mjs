// Tests for "Download All Pending Correspondence" (tender/tender-pending.js).
// Run:  JSDOM_ROOT=/path/to/dir-containing-node_modules node --test tender/tests/pending-tests.mjs
// The fixtures in tender/tests/fixtures are the real IREPS pages from the supplied HAR (names redacted);
// the fake server below rewrites their rows so the tests can vary how many records / letters exist.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PDF, homePage, loginPage } from './fake-ireps.js';

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
const manifestSaved = () => JSON.parse(new TextDecoder().decode([...saved].reverse().find((s) => s.filename.endsWith('download_manifest.json')).bytes));
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
  assert.ok(names.some((n) => /Pending\/L1265428\/Attachment_777_B_Annexure 1\.pdf$/.test(n)), names.join('\n'));
  assert.ok(names.some((n) => /Pending\/L1265428\/Attachment_777_B_drawing\.pdf$/.test(n)));
  assert.ok(pdfs().every((s) => core.isPdfBytes(s.bytes) && s.size > 0));
  assert.ok(!names.some((n) => /20263194/.test(n) && n.endsWith('.pdf')), 'no-letters record produced no document');
  assert.ok(!names.some((n) => /LAPSED|PREV|HIST/i.test(n)));
  // the HTML letter was rendered to a real PDF that contains the letter text
  const rendered = pdfs().find((s) => /Correspondence_502/.test(s.filename));
  assert.match(new TextDecoder('latin1').decode(rendered.bytes), /please confirm the offer validity/);
  // manifest
  const m = manifestSaved();
  assert.equal(m.account.irepsAccountId, '833');
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
  const blob = JSON.stringify(store) + JSON.stringify({ ...m, notes: [] });
  assert.doesNotMatch(blob, /JSESSIONID|password|cookie|TOKEN/i);
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
  assert.equal(manifestSaved().letters.filter((l) => l.status === 'DOWNLOADED').length, 2);
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
  assert.equal(pdfs().filter((s) => /Correspondence_1/.test(s.filename)).length, 1, 'letter not saved twice');
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
  assert.equal(manifestSaved().aborted.code, 'SESSION_EXPIRED');
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

// =========================== UI (real popup.html in jsdom) ==============================
test('UI: clicking "Download All Pending Correspondence" fills the progress table and counts; empty state shown when nothing pending', async () => {
  const dom = new JSDOM(readFileSync(new URL('../../popup/popup.html', import.meta.url), 'utf8').replace(/<script[^>]*><\/script>/g, ''), { pretendToBeVisual: true });
  Object.assign(globalThis, { document: dom.window.document, window: dom.window, MutationObserver: dom.window.MutationObserver });
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
  const $ = (id) => document.getElementById(id);
  scenario();
  await import('../pending-ui.js');
  assert.match($('card-pending').textContent, /Pending Correspondence Downloads/);
  assert.match($('btn-pc-run').textContent, /Download All Pending Correspondence/);
  const finished = async () => { for (let i = 0; i < 400 && ($('pc-progress').hidden === true ? i < 3 : true); i++) await new Promise((r) => setTimeout(r, 25)); await new Promise((r) => setTimeout(r, 400)); };
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
  assert.equal($('pc-empty').textContent, 'No pending correspondence found');
});

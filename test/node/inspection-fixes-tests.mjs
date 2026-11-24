// Fixes from the 24 Nov 2026 inspection (Wabtec/docs/DocLink-Bug-Inspection-2026-11-24.md, items 4.1, 4.2,
// 5.2 and 8.2): PO Search, Bill Status and reading config.local.json. Fake fetch only, no network.
// Run with the other node suites (npm test -- node), or: node --test test/node/inspection-fixes-tests.mjs
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const req = createRequire((process.env.JSDOM_ROOT || process.cwd()) + '/');
const { JSDOM } = req('jsdom');
globalThis.DOMParser = new JSDOM('').window.DOMParser;

const { searchIrepsDocuments } = await import('../../services/search-po/search-po-service.js');
const { parseCrnSearchResults } = await import('../../services/crn/crn-parser.js');
const { withIrepsFormLock } = await import('../../services/ireps-form-lock.js');
const { fetchBillStatus, rejectionMessage } = await import('../../services/bill-status-service.js');
const { parseBillStatus } = await import('../../services/bill-parser.js');
const { jsonErrorPlace, readConfigFiles } = await import('../../utils/config.js');

const fixture = (name) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');
const html = (body) => new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });

// ---------------------------------------------------------------- PO Search (CRN as the example)

const SEARCH_FORM = '<form name="searchPOForm" method="post" action="/epsn/searchPO.do"><input type="hidden" name="org.apache.struts.taglib.html.TOKEN" value="T"><select name="rly"><option value="-1">All</option></select></form>';
const parseCrn = (h, o) => parseCrnSearchResults(h, { ...o, baseUrl: 'http://localhost:8765' });
/** IREPS answering the PO Search page load (searchParam=showPage) with `page` and the search with `results`. */
const portal = (results, page = `<html><body>${SEARCH_FORM}</body></html>`) => async (_url, init = {}) =>
  html(String(init.body || '').includes('showPage') ? page : results);

test('PO Search: IREPS reports results but DocLink reads none -> RESULTS_INVALID, never "nothing found" (4.1)', async () => {
  // rows whose cells IREPS groups (4 cells instead of 6): the parser skips them without counting them
  const rows = [1, 2, 3].map((i) => `<tr><td>${i}</td><td>PO-${i}</td><td>01/10/2026</td><td><a href="/ireps/etender/ct/MMIS/CONS/2026/x/${i}.pdf">CRN-${i}</a> 02/10/2026</td></tr>`).join('');
  const header = '<thead><tr><th>#</th><th>PO No.</th><th>PO Date</th><th>Challan No.</th><th>CRN No.</th><th>CRN date</th></tr></thead>';
  const results = `<html><body>${SEARCH_FORM}<div id="divResults"><table><tr><td class="formLabel"><b>Total 3 result(s)</b></td></tr></table>`
    + `<table id="table_id"><tr><td><table class="recordsTbl" id="dTbl">${header}<tbody>${rows}</tbody></table></td></tr></table></div></body></html>`;
  await assert.rejects(
    () => searchIrepsDocuments({ criteria: 'CRN' }, { fetch: portal(results), parseHtml: parseCrn }),
    (e) => e.code === 'IREPS_CRN_RESULTS_INVALID' && /IREPS reported 3 CRN result\(s\) but none could be read/.test(e.detail)
  );
});

test('PO Search: IREPS\'s own "no records" answer is still "nothing found" (4.1, unchanged)', async () => {
  await assert.rejects(
    () => searchIrepsDocuments({ criteria: 'CRN' }, { fetch: portal(fixture('crn-no-records.html'), fixture('crn-search-page.html')), parseHtml: parseCrn }),
    (e) => e.code === 'IREPS_CRN_NOT_FOUND'
  );
});

test('PO Search: when page 1 fails, no result page request is still under way after the form lock is let go (5.2)', async () => {
  const PAGES = 40;
  const links = Array.from({ length: PAGES }, (_, i) => `<a href="#" onclick="postRequest('/epsn/searchPO.do?rly=-1&dateFrom=&dateTo=&pageNo=${i + 1}&searchRange=1&poNo=&count=${PAGES * 20}&recordsPerPage=20');">${i + 1}</a>`).join(' ');
  const page = (extra) => `<html><body>${SEARCH_FORM}${extra}</body></html>`;
  let inFlight = 0;
  let pageRequests = 0;
  let afterRelease = 0;
  let released = false;
  const fetchImpl = async (_url, init = {}) => {
    const body = String(init.body || '');
    if (body.includes('count=')) {
      pageRequests++;
      if (released) afterRelease++;
      inFlight++;
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return html(page(`<div>page</div>${links}`));
    }
    return html(body.includes('showPage') ? page('') : page(`<div>results page 1</div>${links}`));
  };
  let first = true;
  const parseHtml = async () => {
    if (first) {
      first = false;
      throw new Error('offscreen parser failed');
    }
    return { records: [], structure: 'table', rowCount: 0, warnings: [] };
  };
  await assert.rejects(() => searchIrepsDocuments({ criteria: 'PO', mode: 'last180Days', recordsPerPage: 20 }, { fetch: fetchImpl, parseHtml }));
  let stillRunning = -1;
  await withIrepsFormLock(async () => {
    released = true;
    stillRunning = inFlight;
  });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(stillRunning, 0, 'every page request asked ahead had ended when the next form sequence got the lock');
  assert.equal(afterRelease, 0, 'no page request was sent after the search had ended');
  assert.ok(pageRequests <= 3, `only the requests already under way were sent (${pageRequests}), the queued ones were cancelled`);
});

// ---------------------------------------------------------------- Bill Status

const BILL_PAGE = fixture('bill-status-page.html');
const DATA_START = '<!-- Display Data From here -->';
const DATA_END = '<!-- Display Data Up to here -->';
const PAGE_HEAD = BILL_PAGE.slice(0, BILL_PAGE.indexOf(DATA_START) + DATA_START.length);
const PAGE_TAIL = BILL_PAGE.slice(BILL_PAGE.indexOf(DATA_END));
const withIrepsMessage = (message) => PAGE_HEAD.replace('<span class="errorStyle"></span>', `<span class="errorStyle">${message}</span>`) + PAGE_TAIL;

/** IREPS answering the page load (empty body) with the Bill Status page and every search with `answer`. */
function billPortal(answer) {
  const searches = [];
  const fetchImpl = async (_url, init = {}) => {
    const body = String(init.body || '');
    if (body === '') return html(PAGE_HEAD.replace(/(name="org\.apache\.struts\.taglib\.html\.TOKEN"\s+value=")[^"]*(")/, '$1T1$2') + PAGE_TAIL);
    searches.push(body);
    return html(answer);
  };
  return { fetchImpl, searches };
}

test('Bill Status: a page with an IREPS message and no bills is that message after one fresh-token retry, not "No Bill Records Found" (4.2)', async () => {
  assert.ok(PAGE_HEAD.includes('<span class="errorStyle"></span>'), 'the fixture carries the empty IREPS message span');
  const busy = billPortal(withIrepsMessage('Server is busy. Please try after some time.'));
  await assert.rejects(
    () => fetchBillStatus({ mode: 'last90Days' }, { fetch: busy.fetchImpl, parseHtml: (h, o) => parseBillStatus(h, o) }),
    (e) => e.code === 'IREPS_SEARCH_REJECTED' && e.detail === 'Server is busy. Please try after some time.'
  );
  assert.equal(busy.searches.length, 2, 'the search was sent again once with a fresh token');
});

test('Bill Status: IREPS\'s "No Records Found", or no message at all, is still "No Bill Records Found" (4.2, unchanged)', async () => {
  for (const answer of [withIrepsMessage('No Records Found for the selected period'), PAGE_HEAD + PAGE_TAIL]) {
    const empty = billPortal(answer);
    await assert.rejects(
      () => fetchBillStatus({ mode: 'last90Days' }, { fetch: empty.fetchImpl, parseHtml: (h, o) => parseBillStatus(h, o) }),
      (e) => e.code === 'IREPS_NO_RECORDS'
    );
    assert.equal(empty.searches.length, 1, 'no retry for an empty answer');
  }
});

test('Bill Status: rejectionMessage reads the IREPS message span, and ignores it on a page with bills (4.2)', () => {
  assert.equal(rejectionMessage(withIrepsMessage('Please select a valid <b>date</b> range')), 'Please select a valid date range');
  assert.equal(rejectionMessage(withIrepsMessage('No Records Found')), '');
  assert.equal(rejectionMessage(`${withIrepsMessage('Server is busy')}<table id="table_id"><tr><td>bill</td></tr></table>`), '');
  assert.equal(rejectionMessage(''), '');
});

// ---------------------------------------------------------------- file names

test('A lone "%" in an IREPS file name keeps the name (urlFileName, next to inspection item 10.2)', async () => {
  const { urlFileName, safeDecodeURIComponent } = await import('../../utils/filename.js');
  assert.equal(urlFileName('https://www.ireps.gov.in/ireps/upload/Rates%2010%.pdf'), 'Rates 10%.pdf');
  assert.equal(urlFileName('https://www.ireps.gov.in/ireps/upload/Rates%20100%25.pdf'), 'Rates 100%.pdf', 'a well-formed name as before');
  assert.equal(urlFileName('https://www.ireps.gov.in/epsn/supply/view.do'), '', 'an action is still no file name');
  assert.equal(safeDecodeURIComponent('%E2%82%AC 5% off'), '€ 5% off');
});

// ---------------------------------------------------------------- config.local.json

test('A malformed config.local.json is reported without the text around the mistake (no part of a secret reaches the log) (8.2)', async () => {
  const broken = '{\n  "ecm": {\n    "clientId": "FAKEID",\n    "clientSecret": \'FAKESECRETVALUE123\'\n  }\n}\n';
  let parseError = null;
  try {
    JSON.parse(broken);
  } catch (error) {
    parseError = error;
  }
  assert.ok(parseError && /FAKESECRE/.test(parseError.message), 'the JSON parser quotes the text around the mistake');
  assert.doesNotMatch(jsonErrorPlace(parseError), /FAKE|ecm|clientSecret/);

  const realFetch = globalThis.fetch;
  const lines = [];
  const saved = { error: console.error, warn: console.warn, log: console.log };
  for (const level of Object.keys(saved)) console[level] = (...args) => lines.push(args.map(String).join(' '));
  globalThis.fetch = async (url) => new Response(String(url).endsWith('config.local.json') ? broken : '{"target":"mock"}', { status: 200 });
  try {
    const files = await readConfigFiles({ force: true });
    assert.equal(files.local, null, 'the broken file is ignored');
  } finally {
    globalThis.fetch = realFetch;
    Object.assign(console, saved);
  }
  const said = lines.join('\n');
  assert.match(said, /config\.local\.json is not valid JSON/);
  assert.doesNotMatch(said, /FAKESECRE|FAKEID|clientSecret/);
});

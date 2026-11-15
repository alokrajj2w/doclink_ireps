/**
 * The HTML sanitiser the IREPS parsers use (utils/sanitizer.js): stripDangerousNodes() runs on
 * every parsed IREPS page (the Bill Status, CRN, R-NOTE, MA, PO and IC parsers), normaliseText()
 * on the text they read, escapeHtml() on the Bill Status printable HTML. Runs on the browser's
 * DOMParser, as the parsers do in the offscreen document.
 */

import { stripDangerousNodes, normaliseText, escapeHtml } from "../utils/sanitizer.js";
import { parseBillStatus } from "../services/bill-parser.js";
import { parsePoSearchResults } from "../services/po/po-parser.js";

const parse = (html) => new DOMParser().parseFromString(html, "text/html");
const count = (root, selector) => root.querySelectorAll(selector).length;
/** Every attribute name in the tree whose name starts with "on" (an inline event handler). */
const handlers = (root) => Array.from(root.querySelectorAll("*")).flatMap((el) => Array.from(el.attributes).map((a) => a.name)).filter((n) => n.startsWith("on"));

/** An IREPS-like page with one of each element the parsers must never keep, around a bill table. */
const DIRTY_PAGE = `<html><head>
  <script>window.stolen = document.cookie</script><style>td { color: red }</style>
  <link rel="stylesheet" href="/epsn/x.css"><meta http-equiv="refresh" content="0;url=https://evil.example/"><base href="https://evil.example/">
</head><body>
  <nav>Home | Logout</nav><header>Indian Railways</header><menu><li>Menu</li></menu>
  <iframe src="https://evil.example/"></iframe><object data="x.swf"></object><embed src="x.swf"><applet code="X.class"></applet>
  <form name="vendorPartyCodeForm" action="/epsn/admin/viewBills.do"><input type="hidden" name="TOKEN" value="FAKE-TOKEN">
    <select name="zone"><option value="-1">All</option></select><textarea>notes</textarea><button>Show Results</button></form>
  <noscript>enable javascript</noscript><template><b>later</b></template>
  <svg><script>1</script></svg><math><mi>x</mi></math><canvas></canvas><audio src="a.mp3"></audio><video src="v.mp4"></video><img src="logo.png">
  <table id="table_id"><tr><th>Contract No</th><th>Bill Number</th></tr><tr><td>C-1</td><td>B-1</td></tr></table>
  <footer>Copyright</footer>
</body></html>`;

const REMOVED_TAGS = [
  "script", "style", "link", "meta", "base", "nav", "header", "menu", "iframe", "object", "embed", "applet",
  "form", "input", "select", "option", "textarea", "button", "noscript", "template", "svg", "math", "canvas",
  "audio", "video", "img", "footer"
];

export async function runSanitizerTests({ test, assert, eq }) {
  await test("sanitizer: stripDangerousNodes removes every element that can run code, load something or is not data", () => {
    const doc = parse(DIRTY_PAGE);
    const goneText = ["stolen", "color: red", "Home", "Indian Railways", "notes", "Show Results", "enable javascript", "Copyright"];
    for (const tag of REMOVED_TAGS) assert(count(doc, tag) > 0, `the test page has a <${tag}>`);
    for (const text of goneText) assert(doc.documentElement.textContent.includes(text), `the test page has "${text}"`);
    eq(stripDangerousNodes(doc), doc, "returns what it cleaned");
    for (const tag of REMOVED_TAGS) eq(count(doc, tag), 0, `<${tag}> removed`);
    eq(doc.querySelector("#table_id").textContent, "Contract NoBill NumberC-1B-1", "the data table is untouched");
    for (const text of goneText) assert(!doc.documentElement.textContent.includes(text), `"${text}" is gone with its element`);
    eq(doc.querySelector("[value]"), null, "no form field (the page's token) is left");

    const frames = parse(`<html><frameset><frame src="https://evil.example/"></frameset></html>`);
    assert(count(frames, "frameset") === 1 && count(frames, "frame") === 1, "the frameset page parses");
    stripDangerousNodes(frames);
    eq(count(frames, "frameset, frame"), 0, "<frameset> and <frame> removed");
  });

  await test("sanitizer: inline event handlers are removed everywhere; onclick stays only as inert data-onclick", () => {
    const doc = parse(`<body onload="steal()"><table onmouseover="steal()"><tr ONDBLCLICK="steal()">
      <td onclick="postRequest('/epsn/ct/fetchPODetails.do?rly=01&amp;poKey=9')" onfocus="steal()">Bill Claim</td>
      <td><a href="/ireps/x.pdf" onclick="steal()" onmouseenter="steal()">PDF</a></td></tr></table></body>`);
    assert(handlers(doc).length >= 7, "the test page has handlers");
    stripDangerousNodes(doc);
    eq(handlers(doc).join(","), "", "no on* attribute left");
    const claim = doc.querySelector("td");
    eq(claim.getAttribute("data-onclick"), "postRequest('/epsn/ct/fetchPODetails.do?rly=01&poKey=9')", "the link target IREPS keeps in onclick stays readable");
    eq(claim.textContent, "Bill Claim");
    eq(doc.querySelector("a").getAttribute("href"), "/ireps/x.pdf", "an ordinary link is kept");
  });

  await test("sanitizer: javascript:, vbscript: and data: URLs are removed (any case, leading spaces, entity-encoded); other links kept", () => {
    const doc = parse(`<table><tr>
      <td><a id="js" href="javascript:steal()">a</a></td>
      <td><a id="js-spaced" href="  JavaScript:steal()">b</a></td>
      <td><a id="js-entity" href="&#106;avascript:steal()">c</a></td>
      <td><a id="vb" href="vbscript:steal()">d</a></td>
      <td><a id="data" href="data:text/html,&lt;script&gt;steal()&lt;/script&gt;">e</a></td>
      <td><div id="data-attr" data="javascript:steal()">f</div></td>
      <td><a id="relative" href="/ireps/etender/pdfdocs/MMIS/PO/2026/01/P1.pdf">P1</a></td>
      <td><a id="absolute" href="https://www.ireps.gov.in/epsn/searchPO.do?pageNo=2">2</a></td>
      <td><a id="hash" href="#" title="Manage Your Purchase Order">m</a></td>
    </tr></table>`);
    stripDangerousNodes(doc);
    for (const id of ["js", "js-spaced", "js-entity", "vb", "data"]) eq(doc.getElementById(id).getAttribute("href"), null, `#${id}: href removed`);
    eq(doc.getElementById("data-attr").getAttribute("data"), null, "#data-attr: data removed");
    for (const id of ["js", "js-spaced", "js-entity", "vb", "data", "data-attr"]) assert(doc.getElementById(id), `#${id}: the element and its text stay`);
    eq(doc.getElementById("relative").getAttribute("href"), "/ireps/etender/pdfdocs/MMIS/PO/2026/01/P1.pdf");
    eq(doc.getElementById("absolute").getAttribute("href"), "https://www.ireps.gov.in/epsn/searchPO.do?pageNo=2");
    eq(doc.getElementById("hash").getAttribute("href"), "#");
  });

  await test("sanitizer: text, tables, nested tables, line breaks and anchors are kept as they are", () => {
    const html = `<table id="table_id">
      <tr><th>Status</th><th>Bill Amt</th></tr>
      <tr><td>PAYMENT MADE</td><td><b>1,000</b></td></tr>
      <tr><th colspan="2">Recovery Details</th></tr>
      <tr><td colspan="2"><table><tr><td>GST TDS</td><td>10</td></tr><tr><td>TDS</td><td>20</td></tr></table></td></tr>
      <tr><td colspan="2">line one<br>line&nbsp;two<br/>line three</td></tr>
      <tr><td colspan="2"><a href="/ireps/etender/x.pdf" title="View/Download MA">MA copy</a> <font>kept</font> <span>too</span></td></tr>
    </table>`;
    const doc = parse(html);
    const before = doc.body.innerHTML;
    stripDangerousNodes(doc);
    eq(doc.body.innerHTML, before, "nothing in a clean results table changes");
    eq(count(doc, "table"), 2);
    eq(count(doc, "br"), 2, "line breaks stay (the parsers turn them into new lines)");
    eq(doc.querySelector("a").title, "View/Download MA");
  });

  await test("sanitizer: stripDangerousNodes cleans an element's subtree too, and leaves anything that is not a DOM node alone", () => {
    const doc = parse(`<div id="cell">value<script>steal()</script><span onclick="x()">s</span></div>`);
    const cell = doc.getElementById("cell");
    eq(stripDangerousNodes(cell), cell);
    eq(cell.textContent, "values");
    eq(handlers(cell).join(","), "");
    eq(stripDangerousNodes(null), null);
    eq(stripDangerousNodes(undefined), undefined);
    eq(stripDangerousNodes("<script>x</script>"), "<script>x</script>", "a string is not parsed or changed");
  });

  await test("sanitizer: normaliseText collapses spaces, tabs and no-break spaces, keeps one line break, trims", () => {
    eq(normaliseText("  a  b\t c  "), "a b c");
    eq(normaliseText("x \n\n  y\r\n z"), "x\ny\nz");
    eq(normaliseText(" "), "");
    eq(normaliseText("RR-PR-WC-2034-25-26-04"), "RR-PR-WC-2034-25-26-04", "business values are not otherwise touched");
    eq(normaliseText(null), "");
    eq(normaliseText(undefined), "");
    eq(normaliseText(0), "0");
  });

  await test("sanitizer: escapeHtml escapes & < > \" ' and turns null / undefined into empty text", () => {
    eq(escapeHtml(`<td onclick="x">Tom & 'Jerry'</td>`), "&lt;td onclick=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/td&gt;");
    eq(escapeHtml(null), "");
    eq(escapeHtml(undefined), "");
    eq(escapeHtml(5), "5");
  });

  await test("sanitizer in the parsers: Bill Status values and printable HTML carry no script or style text", () => {
    const result = parseBillStatus(`<html><body><form name="vendorPartyCodeForm" action="/epsn/admin/viewBills.do"></form>
      <table id="table_id"><tr><th>Contract No</th><th>Bill Number</th><th>Status</th></tr>
      <tr><td>C-1<script>steal()</script></td><td onclick="steal()">B-1<style>td{}</style></td><td><a href="javascript:steal()">PASSED</a></td></tr></table></body></html>`);
    eq(result.recordCount, 1);
    const bill = result.bills[0];
    eq(bill.contractNo, "C-1", "no script text in the value");
    eq(bill.billNumber, "B-1", "no style text in the value");
    eq(bill.status, "PASSED");
    assert(!/steal|<script|<style|javascript:|onclick/i.test(result.printableHtml), "nothing unsafe in the printable HTML");
  });

  await test("sanitizer in the parsers: a PO Search row keeps its data and PDF link, never script text or a javascript: link", () => {
    const result = parsePoSearchResults(`<table id="dTbl2"><thead><tr><th>Sr. No.</th><th>Dept / Rly. Unit</th><th>PO No.</th><th>PO Date</th><th>Action(s)</th></tr></thead><tbody>
      <tr onmouseover="steal()"><td>1</td><td>HQ/CR<script>steal()</script></td>
        <td><a href="/ireps/etender/pdfdocs/MMIS/PO/2026/01/P1.pdf" title="Click to View/Download PO">P1</a></td>
        <td>01/01/2026<style>td{}</style></td><td><a href="javascript:steal()" title="Acknowledge">ack</a></td></tr></tbody></table>`);
    eq(result.recordCount, 1);
    const r = result.records[0];
    eq(r.railwayUnit, "HQ/CR");
    eq(r.poDate, "01/01/2026");
    assert(r.poPdfUrl && r.poPdfUrl.endsWith("/ireps/etender/pdfdocs/MMIS/PO/2026/01/P1.pdf"), `PO PDF link kept: ${r.poPdfUrl}`);
    assert(!/steal|javascript:/i.test(JSON.stringify(result)), "no script text, handler or javascript: URL in the result");
  });
}

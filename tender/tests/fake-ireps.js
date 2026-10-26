// A controllable fake IREPS server. Markup shapes are taken from the captured HAR / text files
// (home welcomeLabel, advancedSearch form + result row, View Published Corrigendum, Post Tenders
// rows with postRequest*/loaLetterViewActivity, Tender Related Correspondence).
// It records every request so tests can assert what was (and was never) called.

const enc = (s) => new TextEncoder().encode(s);
export const PDF = (tag = 'x') => enc(`%PDF-1.4\n% ${tag}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n`);
const html = (body, title = 'IREPS') => enc(`<html><head><title>${title}</title></head><body>${body}</body></html>`);
const fmt = (d) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
const parseD = (s) => { const [d, m, y] = s.split('/').map(Number); return new Date(y, m - 1, d); };
const DAY = 86400000;

export function homePage(a) {
  return html(`<table><tr><td class="welcomeLabel"><font size="2">${a.user || 'A GIRIJA'} , ${a.company} (IREPS ID-&nbsp;${a.id})</font></td></tr></table>
<a href="/epsn/home/logout.do">Log Out</a>
<script>$.ajax({ data: { reqMod:"SwitchUser",accountId: '${a.scriptId || a.id}'	} });</script>
<a href="#" url=/epsn/admin/viewAccountAction.do?accountId=${a.scriptId || a.id} class="linkStyle postRequest">View My Account Profile</a>`, 'Bidder Home Page');
}

export const loginPage = () => html('<form action="/epsn/home/userLogin.do">Sign In</form>', 'IREPS Login');

export function searchFormPage() {
  return html(`<form name="advancedSearchForm" method="post" action="/epsn/search/advancedSearch.do">
<select name="searchOption"><option value="1">Tender Number</option></select>
<select name="searchOptorOption" id="searchOptorOption"></select>
<input type="text" name="advancedSearch" maxlength="19" value="">
<select name="organization"><option value="12">X</option><option value="01" selected="selected">Indian Railway</option></select>
<select name="workArea"><option value="PT" selected>Goods &amp; Services</option></select>
<input type="hidden" name="changezone" id="changezone">
<select name="railwayZone"><option value="">---Select---</option><option value="561">Central Railway</option></select>
<select name="division"><option value="-1">Please Select Department</option><option value="01">Accounts</option><option value="19">Stores</option><option value="06">Mechanical</option></select>
<select name="unit"></select>
<select name="tenderStage"><option value="-1" selected>All</option></select>
<select name="tenderType"><option value="-1" selected>All</option></select>
<select name="bidding"><option value="-1" selected>All</option></select>
<select name="selectDate"><option value="TENDER_OPENING_DATE">Tender Closing Date</option></select>
<input type="text" name="dateFrom" value="09/10/2026" readonly><input type="text" name="dateTo" value="09/10/2026" readonly>
<select name="direction"><option value="P">Previous</option></select><input type="number" name="noMonthDay" value=""><select name="monthDay"><option value="M">M</option></select>
<input type="radio" name="radioDuration" value="-3"><input type="radio" name="radioDuration" value="0" checked>
<input type="submit" name="submit" value="Show Results"><input type="hidden" name="searchParam" id="searchParam">
</form>`, 'Search-Indian Railways tenders');
}

const TH = `<tr class="table_head"><td class="formLabel">Deptt./Rly. Unit&nbsp;</td><td class="formLabel">Tender No&nbsp;</td><td class="formLabel">Tender Title&nbsp;</td><td class="formLabel">Status&nbsp;</td><td class="formLabel">Opening Date/Time&nbsp;</td><td class="formLabel">Due Date/Time&nbsp;</td><td class="formLabel">Due Days&nbsp;</td><td class="formLabel">Actions&nbsp;</td></tr>`;

export function resultRow(t) {
  return `<tr><td>${t.dept}&nbsp;</td>
<td><a title="View Tender Document / Corrigendum" class="linkStyle" href=# onclick="window.open('/epsn/supply/rfq/nitPublish.do?nitId=${t.nitId}&activity=viewNIT', '', 'toolbar=0,titlebar=0,scrollbars=1,location=1,resizable=1,width=950,height=600')">${t.no}</a>&nbsp;</td>
<td><span class="dataText">${t.title}</span></td><td>${t.status}&nbsp;</td><td>NOT OPENED</td><td>${fmt(t.closing)}&nbsp;</td><td>34&nbsp;</td>
<td>&nbsp;<a title="View Tender Document / Corrigendum" href="#" onclick="window.open('/ireps/supply/pdfdocs/112026/${t.oid}/viewNitPdf_${t.nitId}.pdf', '', 'toolbar=0')"><img src="/x.gif"></a>&nbsp;<a title="View Published Corrigendum" class=linkStyle href=/epsn/works/rfq/viewCorrigendum.do?nitId=${t.nitId}><img src="/y.gif"></a>&nbsp;${
  t.offer ? `<a title="My Offer" href=# onclick="window.open('/epsn/tbo/commTboPdfAction.do?pdfType=offer&tenderOID=${t.oid}&accountID=${t.offerAcct || '833'}', '', 'toolbar=0')">o</a><a title="Financial Tabulation" href=# onclick="window.open('/epsn/tbo/commTboPdfAction.do?pdfType=financialTabulation&tenderOID=${t.oid}', '', 'toolbar=0')">f</a><a title="View Commercial Tabulation" href=# onclick="window.open('/epsn/tbo/commTboPdfAction.do?pdfType=commercialTabulation&tenderOID=${t.oid}', '', 'toolbar=0')">c</a>` : ''
}<a title="Bid Process" class=linkStyle href=/epsn/supply/bid/bidProcess.do?oid=${t.oid}&bidStartDate=>b</a></td></tr>`;
}

export const resultsPage = (rows) => html(`<form><table>${TH}${rows.join('')}</table></form><div>Tender search results ${rows.length}</div>`, 'Search');
export const noResultsPage = () => html('<form>No Results Found <input type="button" value="Print Results"></form>', 'Search');

export function nitPage(t) {
  const rows = (t.attachments || []).map((a, i) => `<tr><td>${i + 1}</td><td><a href="${a.href}" target="_blank">${a.name}</a></td><td>${a.desc}</td></tr>`).join('');
  return html(`<table><tr><td>Tender No</td><td>${t.no}</td></tr></table>
<input type="button" value="Download Tender Doc. (Pdf)" onclick="window.open('/ireps/supply/pdfdocs/112026/${t.oid}/viewNitPdf_${t.nitId}.pdf')">
<table><tr><td><b>List of documents attached with the tender</b></td></tr></table>
${rows ? `<table border=1><tr><th>S.No</th><th>Name</th><th>Description</th></tr>${rows}</table>` : '<p>No documents attached</p>'}
<table><tr><td>Corrigenda</td></tr><tr><td><a href="#" onclick="x()">${(t.corrigenda || []).length ? 'Corrigendum 1' : 'No Corrigendum Issued'}</a></td></tr></table>`, 'View NIT');
}

const FOOTER = ['AboutUs', 'Disclamier_en', 'PrivacyPolicy', 'TermsAndCondition', 'Copyright'].map((n) => `<a href="/ireps/upload/resources/${n}.pdf" target="_blank">${n}</a>`).join(' | ');

export const msgBody = (m) => m.body ?? (/corrigendum/i.test(m.subject)
  ? `Dear Sir/Madam,<br><br>A corrigendum has been issued on ${m.date} towards X, ${/Tender\s*no.*$/i.exec(m.subject)?.[0] || ''}. Please login into IREPS.`
  : `Dear Sir/Madam, <br><br>Your attention is invited towards X, ${/Tender\s*Number.*$/i.exec(m.subject)?.[0]?.replace('Number', 'No.') || ''} due on 12-Nov-2026 14:00 IST for <i>'${m.title || 'Some item'}'</i>.<br><br>Thanks`);

export function inboxMessages(msgs, pageNo = 1, pageSize = 100) {
  const pages = Math.max(1, Math.ceil(msgs.length / pageSize));
  const slice = msgs.slice((pageNo - 1) * pageSize, pageNo * pageSize);
  const rows = slice.map((m) => `<tr><td><b>${m.date} 10:00</b></td><td>EPS Admin</td><td><A HREF="#" onclick=postRequest('/epsn/admin/myMessages/ViewMessageDetailAction.do?oid=${1000 + msgs.indexOf(m)}') title="${m.subject}" class="linkStyle"><B>${m.subject.slice(0, 30)}....</B></a></td><td><a title="View Message" onclick=postRequest('/epsn/admin/myMessages/ViewMessageDetailAction.do?oid=${1000 + msgs.indexOf(m)}')>v</a></td></tr>`).join('');
  const links = Array.from({ length: pages }, (_, i) => `<a href="#" onClick="return menuexpand('MyMsg',${i + 1})">${i + 1}</a>`).join('&nbsp;');
  return html(`<form id="schForm"><strong>Total Messages:</strong>${msgs.length}&nbsp;&nbsp;<table><tr><td>Sent Date/Time</td><td>From</td><td>Subject</td><td>Action</td></tr>${rows}</table><table><tr><td align="right">${links}</td></tr></table></form>`, 'Folder Details');
}

export function messageDetail(m, idx) {
  return html(`<table><tr><td class="formLabel"><b>&nbsp;&nbsp;Msg Id:</b></td><td class="datatext">&nbsp;${5000 + idx}</td></tr>
<tr><td class="formLabel"><b>&nbsp;&nbsp;Sent Date/Time:</b></td><td class="datatext">&nbsp;${m.date} 11:43</td></tr>
<tr><td class="formLabel"><b>&nbsp;&nbsp;Sent By:</b></td><td class="datatext">&nbsp;System Generated Message</td></tr>
<tr><td class="formLabel"><b>&nbsp;&nbsp;Subject:</b></td><td class="datatext">${m.subject}&nbsp;</td></tr>
<tr><td class="formLabel" colspan="4"><fieldset><table><tr><td class="htmlAreaStyle">&nbsp;${msgBody(m)}</td></tr></table></fieldset></td></tr></table>`, 'Message Details');
}

export function corrigendumList(t) {
  const rows = (t.corrigenda || []).map((c, i) => `<tr><td>${i + 1}</td><td>Corrigendum - ${c.cn}</td><td>${c.date}</td><td><a href="#" onclick="showPubCorriDetail('${c.id}','${c.cn}');"><img src="v.png"></a></td></tr>`).join('');
  return html(`<table><tr><td>Tender No.</td><td>${t.no}</td></tr></table><b>List Of Published Corrigenda</b>
<table border=1><tr><td>#</td><td>Corrigendum No</td><td>Corrigendum Date</td><td>Action</td></tr>${rows}</table>
<script>
function showPubCorriDetail(corrigId,cn)
{ var url="";
 var wkArea='PT'
 var nitId = '${t.nitId}';
 if(wkArea=="WT"){
 url = '/epsn/works/rfq/viewCorrigendum.do?activity=displayPubCorri&nitId='+nitId+'&cn='+cn+'&corrigendumId='+corrigId;
 }
 if(wkArea=="LT"){
 url = '/epsn/works/rfq/viewCorrigendum.do?activity=displayPubCorri&nitId='+nitId+'&cn='+cn+'&corrigendumId='+corrigId;
 }
 else if(wkArea=="PT"){
 url = '/epsn/supply/viewCorrigendum.do?activity=displayPubCorri&nitId='+nitId+'&cn='+cn+'&corrigendumId='+corrigId;
 }
 //window.open(url,'','scrollbars=yes, resizable=yes,left=100,top=20,width=1100, height=1200');
 postRequestNewWindow(url,'toolbar=0,titlebar=0,location=0,statusbar=0,menubar=0,scrollbars=yes, resizable=yes,left=100,top=20,width=1100, height=1200');
}
function home()
{ var url = '/epsn/home/showHome.do'; }
</script>${FOOTER}`, 'View Published Corrigendum');
}

export function inboxForm() {
  return html(`<form name="buyerInboxLinkForm" method="post" action="/epsn/vendorInboxLink.do">
<input type="text" name="tenderNo" value="" id="tenderNumber"><input type="text" name="startDate" value="11/07/2026" readonly><input type="text" name="endDate" value="09/10/2026" readonly>
<input type="hidden" name="pageNo" id="pageNo"><input type="hidden" name="listType" id="listType" value="MyNegotiation"><input type="hidden" name="raStatus" value="-1"></form>`, 'Folder Details');
}

const LOA_SCRIPT = `<script>
function loaLetterViewActivity(url,docId){
	var docType = "11";
	var getAjaxData = '/epsn/supply/tds/ajxdata.do';
	$.ajax({ type: "POST", url: getAjaxData, data: {ajaxMode:"updateLoaViewedDataByBidder",docId:docId,docType:docType}, dataType:'text',
	    success: function(result) { if(result!=null && result == "OK"){ postRequestNewWindow('/epsn'+url,'toolbar=0'); } else { alert("Try Again."); } } });
}
</script>`;

export function inboxRows(status, tenderNo, rows, { more = false } = {}) {
  const trs = rows.map((r) => {
    let action = '';
    if (status === 'MyNegotiation') action = `<a title="Nego Bid Process" onclick=postRequest('/epsn/supply/tds/negoBid.do?nitOId=${r.oid}')>n</a><a title="View Negotiation Letters" class="linkStyle"href="#" onclick=postRequestNewWindow('/epsn/supply/tds/publishIndiNegotiationLetter.do?nitOId=${r.oid}&negoLetterId=${r.letter}&opValue=ViewPublishedLetter','toolbar=0,width=775')>v</a>`;
    if (status === 'MyCounterOffer') action = `<a title="Counter Offer Response Page" class="linkStyle"href="#" onclick=postRequest('/epsn/supply/tds/coResponse.do?oid=${r.oid}&nitId=${r.nitId || 1}&coBidId=2&tdId=3&letterId=${r.letter}&responseDate=14/09/2026&tdVersion=1')>r</a><a title="View Counter Offer Letters" class="linkStyle"href="#" onclick=postRequestNewWindow('/epsn/supply/tds/publishCounterOfferLetter.do?Action=ViewPublishedLetter&responseDate=14/09/2026&nitOId=${r.oid}&tdId=3&tdVersion=1&bidid=2&bidderAccId=${r.bidder || '833'}&letterId=${r.letter}&signId=9${r.letter}','toolbar=0')>v</a>`;
    if (status === 'MyAdvanceAcceptanceLetter') action = `<a title="View LOA Letter" class="linkStyle"href="#" onclick=loaLetterViewActivity('/supply/tds/publishLOALetter.do?Action=ViewPublishedLetter&nitOId=${r.oid}&tdId=3&letterId=${r.letter}&tdVersion=1&bidid=2&bidderAccId=${r.bidder || '833'}&signId=9${r.letter}','${r.letter}')>v</a>`;
    const d = r.date; const stamp = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()} 17:40&nbsp;(${r.letter})`;
    return `<tr><td>${r.no === tenderNo ? '' : ''}Dept / RLY</td><td><a class="linkStyle" title="To View NIT Click the NIT No" href="#" onclick=postRequest('/epsn/works/rfq/nitPublish.do?activity=viewNIT&nitId=9${r.letter}')>${r.no}</a></td><td>${stamp}</td><td>${action}</td></tr>`;
  }).join('');
  return html(`<form><table><tr><td>Tender No</td><td>Dept</td><td>Action</td></tr>${trs}</table>${more ? '<a href="#" onclick="gotoPage(2)">Next</a>' : ''}</form>${status === 'MyAdvanceAcceptanceLetter' ? LOA_SCRIPT : ''}`, 'Folder Details');
}

export function corresPage(c) {
  const rows = c.letters.map((l) => `<tr><td class="dataText">${l.no} dated : ${l.date || '11/09/2026'}</td><td class="dataText">${l.subject}</td><td>12/09/2026</td><td>
<a href="#" onclick="viewPublishedLtr('${c.nitOid}', '${l.corresId}', '${l.id}');" title="View Published Letter"><img src="v.png"></a>
<a href="#" class="linkStyle" onclick="postRequest('/epsn/corres/vendor/vendorCorresSubmitReply.do?nitOid=${c.nitOid}&corresId=${l.corresId}&letterId=${l.id}&bidId=9')"><img title="Submit Response"></a></td></tr>`).join('');
  return html(`<table><tr><td class="formLabel">Tender No</td><td class="dataText">
 ${c.tenderNo}
</td><td class="formLabel">Closing Date</td><td>09/09/2026</td></tr></table>
<table><tr><td>Letter No &amp; date</td><td>Subject</td><td>Last date</td><td>Action</td></tr>${rows}</table>
<script>
function viewPublishedLtr(nitOid, corresId, letterId){
 var url = '/epsn/corres/rly/viewpubIndltr.do?nitOid='+nitOid+'&letterID='+letterId+'&corresId='+corresId;
 postRequestNewWindow(url,'width=1150,height=650,scrollbars=yes,resizable=yes');
}
function viewResponse(nitOid, corresId, letterId,bidId){
 var url = '/epsn/corres/vendor/vendorCorresViewReply.do?nitOid='+nitOid;
 postRequestNewWindow(url,'w');
}
</script>`, 'Tender Related Correspondence');
}

/**
 * IREPS Closed Tenders (Vendor inbox, menuLink=Tenders, status/listType=MyBidsClosed), as captured in
 * 01_api_data/finncial and commercial documentation response.har: the schForm, then one row per tender
 * with the tabulation links once the bids are opened.
 *   rows: [{ no, bidId, nitId, oid, dept, title, closing: Date, tab: bool, tabAcct }]
 */
export function closedTendersPage(rows, { more = false, pageNo = 1 } = {}) {
  const row = (t) => `<tr>
<td width="15%" style="color: black;">${t.dept || 'STORES / CENTRAL RLY'}</td><td width="15%"><a class="linkStyle" style="color: #4A4AFB;" href="#" onclick=postRequest('/epsn/works/rfq/nitPublish.do?activity=viewNIT&nitId=${t.nitId}') title="To View NIT Click the NIT No">${t.no}</a><br>(${t.bidId || '2087' + t.nitId})</td>
			<td width="35%" style="padding:5px;color: black;">${t.title || 'WHEEL MOUNTED BRAKE'}</td>
			<td width="15%" style="padding:5px;color: black;">${fmt(t.closing)} 11:30</td>
			<td nowrap width="20%" align="left" style="color: black;"><a href="#" title="View Tender Document / Corrigendum" onclick="postRequestNewWindow('/ireps/supply/pdfdocs/102026/${t.oid}/viewNitPdf_${t.nitId}.pdf',  'toolbar=0')"><img src="/ireps/images/common/viewTndrDoc.gif"></a>&nbsp;<a href="#"  title="View Corrigenda" onclick=postRequest('/epsn/works/rfq/viewCorrigendum.do?nitId=${t.nitId}')><img src="/v.gif"></a>&nbsp;
<a title="Submit Payment Details" class="linkStyle" href="#" onclick=postRequest('/epsn/bid/paymentProcess.do?oid=${t.oid}')><img src="/c.gif"></a>&nbsp;
<a href="#" title="My Offer" onclick="postRequestNewWindow('/epsn/tbo/commTboPdfAction.do?pdfType=offer&tenderOID=${t.oid}&accountID=833&bid_id=1&bidType=N', 'toolbar=0')"><img src="/o.png"></a>&nbsp;
${t.tab ? `<a href="#" title="View Financial Tabulation" onclick="postRequestNewWindow('/epsn/tbo/commTboPdfAction.do?tenderOID=${t.oid}&pdfType=financialTabulation&accountID=${t.tabAcct || '833'}', 'toolbar=0')"><img src="/ireps/images/common/barchart.jpg"></a>&nbsp;<a href="#" title="View Commercial Tabulation" onclick="postRequestNewWindow('/epsn/tbo/commTboPdfAction.do?pdfType=commercialTabulation&tenderOID=${t.oid}&accountID=${t.tabAcct || '833'}',  'toolbar=0')"><img src="/t.jpg"></a>&nbsp;<a href="#" title="Bill Tracking" onclick=postRequest('/epsn/works/bills/billSubmission.do?activity=display&oid=${t.oid}')><img src="/b.gif"></a>` : ''}
<a href="#" title="View offer Documents"  onclick="postRequestNewWindow('/epsn/tbo/downloaddocs.do?tenderOID=${t.oid}&accountID=833&bid_id=1',  'toolbar=0')"><img src=/ireps/images/common/Vdocs.png></a>
</tr>
</tr>`;
  const links = more ? `<table width="98%"><tr><td colspan="3" align="right"><a href="#" onClick="return menuexpand('MyBidsClosed',${pageNo})">${pageNo}</a>&nbsp;<a href="#" onClick="return menuexpand('MyBidsClosed',${pageNo + 1})">${pageNo + 1}</a></td></tr></table>` : '';
  return html(`<form name="buyerInboxLinkForm" method="post" action="/epsn/vendorInboxLink.do" id="schForm">
<select id="menuLink" name="menuLink"><option value="Tenders" selected>Tenders</option></select>
<select id="status" name="status"><option value="Payments">My payments</option><option value="MyBidsClosed">Closed Tenders</option></select>
<input type="text" name="tenderNo" value="" id="tenderNumber">
<input type="text" name="startDate" value="25/07/2026" readonly><input type="text" name="endDate" value="23/10/2026" readonly>
<select name="raStatus" id="raStatus"><option value="-1" selected="selected">All</option></select>
<input type="hidden" name="pageNo" id="pageNo"><input type="hidden" name="listType" id="listType" value='MyBidsClosed'>
<table width="100%" class="nit_summary" border="0"><tr><td colspan="5">&nbsp;</td></tr>
<tr bgcolor="#E9E9EF"><td><strong>Dept/Rly. Unit</strong></td><td><strong>Tender No.
		/Bid Id</strong></td><td><strong>Tender Title</strong></td><td><strong>Closing Date/Time</strong></td><td><strong>Actions</strong></td>
${rows.map(row).join('\n')}
</table>${links}</form>`, 'Folder Details');
}

/** Letter responses: print-ready HTML wrapper (default) or a direct PDF. */
export const letterHtml = (label) => html(`<div><h2>${label}</h2><table><tr><td>Letter No</td><td>306789</td></tr><tr><td>Date</td><td>11/09/2026</td></tr></table><p>Please note the revised terms and conditions apply to the above tender in all respects.</p></div>`, label);

export class FakeIreps {
  constructor(state) {
    this.s = {
      account: { id: '833', company: 'FAIVELEY TRANSPORT RAIL TECHNOLOGIES INDIA PRIVATE LIMITED-HOSUR' },
      loggedIn: true,
      today: new Date(2026, 9, 9),
      tenders: [],
      inbox: { MyNegotiation: [], MyCounterOffer: [], MyAdvanceAcceptanceLetter: [] },
      corres: {},
      loaAck: 'OK',
      rejectAllDepts: false,
      inboxPages: {},
      letterAsPdf: false,
      failPaths: [],
      ...state,
    };
    this.log = [];
  }

  tenderBy(f, v) { return this.s.tenders.find((t) => String(t[f]) === String(v)); }

  async handle(method, urlStr, bodyStr) {
    const u = new URL(urlStr);
    const p = u.pathname;
    const q = u.searchParams;
    const body = new URLSearchParams(bodyStr || '');
    this.log.push({ method, path: p, query: Object.fromEntries(q), body: Object.fromEntries(body) });
    const ok = (bytes, type = 'text/html;charset=UTF-8') => ({ status: 200, type, bytes });
    const pdf = (tag) => ok(PDF(tag), 'application/pdf');
    if (p === '/config.json') return ok(enc(JSON.stringify({ target: 'real', realBaseUrl: 'https://www.ireps.gov.in' })), 'application/json');
    if (this.s.failPaths.some((f) => p.includes(f))) return { status: 500, type: 'text/html', bytes: html('boom') };
    if (!this.s.loggedIn) return ok(loginPage());

    if (p === '/epsn/home/showHome.do') return ok(this.s.homeOverride ? html(this.s.homeOverride) : homePage({ id: this.s.account.id, company: this.s.account.company, scriptId: this.s.account.scriptId }));

    if (p === '/epsn/search/advancedSearch.do') {
      if (method === 'GET' || body.get('searchParam') === 'showPage') return ok(searchFormPage());
      const term = body.get('advancedSearch');
      const dept = body.get('division');
      if (dept === '-1' && this.s.rejectAllDepts) return ok(html('<form>Please select Department <input type=text></form>'));
      const from = parseD(body.get('dateFrom'));
      const to = parseD(body.get('dateTo'));
      if ((to - from) / DAY > 186) return ok(html('<form>Date range should be within 6 months</form>'));
      const hits = this.s.tenders.filter((t) => t.no.startsWith(term) && t.closing >= from && t.closing <= to && (dept === '-1' || dept === (t.deptCode || '19')));
      return ok(hits.length ? resultsPage(hits.map(resultRow)) : noResultsPage());
    }

    if (p === '/epsn/supply/rfq/nitPublish.do') { const t = this.tenderBy('nitId', q.get('nitId')); return ok(t ? nitPage(t) : html('none')); }
    const nitPdf = /viewNitPdf_(\d+)\.pdf$/.exec(p);
    if (nitPdf) return pdf('nit' + nitPdf[1]);
    if (p.startsWith('/ireps/upload/resources/')) { this.footerHit = true; return pdf('footer'); }
    if (p.startsWith('/ireps/upload/att/')) {
      const t = this.s.tenders.flatMap((x) => x.attachments || []).find((a) => a.href === p);
      if (t && t.asHtml) return ok(html(`<a href="${p}.real.pdf">open</a>`));
      if (p.endsWith('.real.pdf')) return pdf('att');
      if (p.endsWith('.zip')) return ok(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0, 0, 0]), 'application/zip');
      return pdf('att' + p);
    }
    if (p === '/epsn/works/rfq/viewCorrigendum.do') { const t = this.tenderBy('nitId', q.get('nitId')); return ok(t ? corrigendumList(t) : html('x')); }
    if (p === '/epsn/supply/viewCorrigendum.do') {
      if (method !== 'POST') return { status: 405, type: 'text/html', bytes: html('POST only') };
      const t = this.tenderBy('nitId', body.get('nitId'));
      const c = t?.corrigenda?.find((x) => x.id === body.get('corrigendumId'));
      if (!c) return ok(html('<h1>Error</h1>'));
      return c.asHtml ? ok(letterHtml(`Corrigendum ${c.cn}`)) : pdf('corr' + c.id);
    }
    if (p === '/epsn/works/rfq/viewCorrigendumDetail.do') return { status: 404, type: 'text/html', bytes: html('wrong route') };

    if (p === '/epsn/tbo/commTboPdfAction.do') {
      // postRequestNewWindow POSTs the query as the body; window.open GETs it
      const arg = (k) => q.get(k) || body.get(k);
      const type = arg('pdfType');
      if (!['offer', 'financialTabulation', 'commercialTabulation'].includes(type)) { this.excludedHit = true; return pdf('FORBIDDEN'); }
      if (type !== 'offer' && this.s.tabulationAsHtml) return ok(letterHtml(`${type} ${arg('tenderOID')}`));
      return pdf(type + arg('tenderOID'));
    }

    if (p === '/epsn/vendorInboxLink.do') {
      const status = body.get('status') || q.get('status');
      if (body.get('listType') === 'MyMsg') return ok(inboxMessages(this.s.messages || [], Number(body.get('pageNo') || 1), this.s.msgPageSize || 100));
      if (status === 'MyBidsClosed' || body.get('listType') === 'MyBidsClosed') {
        const all = this.s.closed || [];
        if (!body.get('startDate')) return ok(closedTendersPage([]));
        const from = parseD(body.get('startDate'));
        const to = parseD(body.get('endDate'));
        if ((to - from) / DAY > 90) return ok(html('<form>Date range should be within 90 days</form>'));
        const pageNo = Number(body.get('pageNo') || 1);
        const want = body.get('tenderNo');
        const hits = all.filter((t) => (!want || t.no === want) && t.closing >= from && t.closing <= to);
        const pages = Math.max(1, ...hits.map((t) => t.page || 1));
        return ok(closedTendersPage(hits.filter((t) => (t.page || 1) === pageNo), { more: pageNo < pages, pageNo }));
      }
      if (!body.get('startDate')) return ok(inboxForm());
      const from = parseD(body.get('startDate'));
      const to = parseD(body.get('endDate'));
      const pageNo = Number(body.get('pageNo') || 1);
      const want = body.get('tenderNo');
      const rows = (this.s.inbox[status] || []).filter((r) => (!want || r.no === want) && r.date >= from && r.date <= to);
      const pages = this.s.inboxPages[status];
      if (pages) return ok(inboxRows(status, body.get('tenderNo'), rows.filter((r) => (r.page || 1) === pageNo), { more: pageNo < pages }));
      return ok(inboxRows(status, body.get('tenderNo'), rows));
    }

    const letterPaths = ['/epsn/supply/tds/publishIndiNegotiationLetter.do', '/epsn/supply/tds/publishCounterOfferLetter.do', '/epsn/supply/tds/publishLOALetter.do', '/epsn/corres/rly/viewpubIndltr.do'];
    if (letterPaths.includes(p)) {
      if (method !== 'POST') return { status: 405, type: 'text/html', bytes: html('POST only') };
      if (p.endsWith('publishLOALetter.do') && !this.loaAcked) return ok(html('<h1>Not viewed</h1> You have not acknowledged the letter first, error occurred'));
      const id = body.get('negoLetterId') || body.get('letterId') || body.get('letterID');
      return this.s.letterAsPdf ? pdf('letter' + id) : ok(letterHtml('Letter ' + id));
    }
    if (p === '/epsn/supply/tds/ajxdata.do') {
      this.loaAcked = this.s.loaAck === 'OK';
      return ok(enc(this.s.loaAck), 'text/plain');
    }
    if (p === '/epsn/admin/myMessages/ViewMessageDetailAction.do') {
      const idx = Number(body.get('oid')) - 1000;
      const m = (this.s.messages || [])[idx];
      return m ? ok(messageDetail(m, idx)) : ok(html('no such message'));
    }
    if (p === '/epsn/corres/vendorRelatedCorrespondence.do') return ok(html('<table><tr><td>Tender No</td></tr></table>'));
    if (p === '/epsn/corres/vendorCorrespondencePendingReply.do') {
      const c = this.s.corres[body.get('nitOid')];
      return ok(c ? corresPage(c) : html('<table><tr><td>Tender No</td></tr></table>', 'Tender Related Correspondence'));
    }
    return { status: 404, type: 'text/html', bytes: html('not found') };
  }
}

/**
 * A fake chrome.debugger + chrome.tabs answering like the DevTools protocol (tender-print.js):
 * navigate -> the page request pauses -> fulfilled -> load -> printToPDF returns a PDF.
 *   attachError: attach throws (blocked by policy); cancel: the user cancels the "started debugging" bar.
 */
export function fakeChromeDebugger(chrome, { attachError = null, cancel = false } = {}) {
  const onEvent = new Set();
  const onDetach = new Set();
  const calls = [];
  const tabs = { created: 0, removed: [] };
  const fire = (set, ...args) => setTimeout(() => set.forEach((f) => f({ tabId: 7 }, ...args)), 0);
  chrome.tabs = { create: async () => { tabs.created++; return { id: 7 }; }, remove: async (id) => { tabs.removed.push(id); } };
  chrome.debugger = {
    onEvent: { addListener: (f) => onEvent.add(f), removeListener: (f) => onEvent.delete(f) },
    onDetach: { addListener: (f) => onDetach.add(f), removeListener: (f) => onDetach.delete(f) },
    attach: async () => { if (attachError) throw new Error(attachError); calls.push(['attach']); },
    detach: async () => { calls.push(['detach']); },
    sendCommand: async (target, method, params) => {
      calls.push([method, params]);
      if (method === 'Page.navigate') {
        if (cancel) fire(onDetach, 'canceled_by_user');
        else fire(onEvent, 'Fetch.requestPaused', { requestId: 'r1', request: { url: params.url } });
      }
      if (method === 'Fetch.fulfillRequest') fire(onEvent, 'Page.loadEventFired', {});
      if (method === 'Page.printToPDF') return { data: Buffer.from(PDF('chrome-print')).toString('base64') };
      return {};
    },
  };
  return { calls, tabs, cmd: (m) => calls.find((c) => c[0] === m)?.[1] };
}

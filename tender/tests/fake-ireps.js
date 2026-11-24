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

/**
 * The Search Tender form page. As on every captured Search Tender page (corrigendum response.har, the form page and
 * the results page), it carries IREPS's empty message box (errorStyle), the note on the search term, the department
 * list's "Please Select Department" and the hidden note on the date range: none of them is an answer to a search.
 */
export function searchFormPage() {
  return html(`<table><tr><td class="formLabel"><b><div class="errorStyle"></div> <br></td></tr></table>
<form name="advancedSearchForm" method="post" action="/epsn/search/advancedSearch.do">
<table><tr height="40px;"><td class="formLabel" colspan="4"> <font size="1">Note:- Please enter minimum first 3 characters of Tender Number or PLNO (these are case sensitive) or any 3 consecutive characters of Tender title or item description. </font></td></tr></table>
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
<table><tr height="20px;"><td align="left" COLSPAN=4><div style="display: none" id="dateRangeDiv"><font color="brown"><br>&nbsp;*Date range should be within 6 months.</font></div></td></tr></table>
<input type="submit" name="submit" value="Show Results"><input type="hidden" name="searchParam" id="searchParam">
</form>`, 'Search-Indian Railways tenders');
}

const TH = `<tr class="table_head"><td class="formLabel">Deptt./Rly. Unit&nbsp;</td><td class="formLabel">Tender No&nbsp;</td><td class="formLabel">Tender Title&nbsp;</td><td class="formLabel">Status&nbsp;</td><td class="formLabel">Opening Date/Time&nbsp;</td><td class="formLabel">Due Date/Time&nbsp;</td><td class="formLabel">Due Days&nbsp;</td><td class="formLabel">Actions&nbsp;</td></tr>`;

/**
 * A Search Tender result row. t.offer: this vendor bid (My Offer), and then the tabulation links and Bill
 * Tracking follow unless t.tab === false (bids not opened yet), as on the 20 Nov 2026 capture.
 */
export function resultRow(t) {
  return `<tr><td>${t.dept}&nbsp;</td>
<td><a title="View Tender Document / Corrigendum" class="linkStyle" href=# onclick="window.open('/epsn/supply/rfq/nitPublish.do?nitId=${t.nitId}&activity=viewNIT', '', 'toolbar=0,titlebar=0,scrollbars=1,location=1,resizable=1,width=950,height=600')">${t.no}</a>&nbsp;</td>
<td><span class="dataText">${t.title}</span></td><td>${t.status}&nbsp;</td><td>NOT OPENED</td><td>${fmt(t.closing)}&nbsp;</td><td>34&nbsp;</td>
<td>&nbsp;<a title="View Tender Document / Corrigendum" href="#" onclick="window.open('/ireps/supply/pdfdocs/112026/${t.oid}/viewNitPdf_${t.nitId}.pdf', '', 'toolbar=0')"><img src="/x.gif"></a>&nbsp;<a title="View Published Corrigendum" class=linkStyle href=/epsn/works/rfq/viewCorrigendum.do?nitId=${t.nitId}><img src="/y.gif"></a>&nbsp;${
  t.offer ? `<a title="My Offer" href=# onclick="window.open('/epsn/tbo/commTboPdfAction.do?pdfType=offer&tenderOID=${t.oid}&accountID=${t.offerAcct || '833'}', '', 'toolbar=0')">o</a>${t.tab === false ? '' : `<a title="Financial Tabulation" href=# onclick="window.open('/epsn/tbo/commTboPdfAction.do?pdfType=financialTabulation&tenderOID=${t.oid}', '', 'toolbar=0')">f</a><a title="View Commercial Tabulation" href=# onclick="window.open('/epsn/tbo/commTboPdfAction.do?pdfType=commercialTabulation&tenderOID=${t.oid}', '', 'toolbar=0')">c</a>&nbsp;<a title="Bill Tracking" class=linkStyle href=/epsn/works/bills/billSubmission.do?activity=display&oid=${t.oid}><img src="/ireps/images/common/Submit Pending Bill Details.png"></a>`}` : ''
}<a title="Bid Process" class=linkStyle href=/epsn/supply/bid/bidProcess.do?oid=${t.oid}&bidStartDate=>b</a></td></tr>`;
}

/** A Search Tender result page: the rows, IREPS's count as captured ("Tender search results <B>N</B>") and the page links. */
export const resultsPage = (rows, { total = rows.length, links = '' } = {}) => html(`<table><tr><td class="formLabel"><b>&nbsp;Tender search results &nbsp;</b><B>${total}</B></td></tr></table>
<form><table>${TH}${rows.join('')}</table></form>${links}`, 'Search');
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

/**
 * The search form IREPS draws on every vendor inbox page (vendorInboxLink.do: My Messages, the Post Tenders
 * lists, Closed Tenders), with or without rows - as in the captures of 22 and 29 Oct 2026.
 */
export const schFormFields = (listType) => `<input type="text" name="tenderNo" value="" id="tenderNumber"><input type="text" name="startDate" value="11/07/2026" readonly><input type="text" name="endDate" value="09/10/2026" readonly>
<input type="hidden" name="pageNo" id="pageNo"><input type="hidden" name="listType" id="listType" value="${listType}"><input type="hidden" name="raStatus" value="-1">`;

export function inboxMessages(msgs, pageNo = 1, pageSize = 100) {
  const pages = Math.max(1, Math.ceil(msgs.length / pageSize));
  const slice = msgs.slice((pageNo - 1) * pageSize, pageNo * pageSize);
  const rows = slice.map((m) => `<tr><td><b>${m.date} 10:00</b></td><td>EPS Admin</td><td><A HREF="#" onclick=postRequest('/epsn/admin/myMessages/ViewMessageDetailAction.do?oid=${1000 + msgs.indexOf(m)}') title="${m.subject}" class="linkStyle"><B>${m.subject.slice(0, 30)}....</B></a></td><td><a title="View Message" onclick=postRequest('/epsn/admin/myMessages/ViewMessageDetailAction.do?oid=${1000 + msgs.indexOf(m)}')>v</a></td></tr>`).join('');
  const links = Array.from({ length: pages }, (_, i) => `<a href="#" onClick="return menuexpand('MyMsg',${i + 1})">${i + 1}</a>`).join('&nbsp;');
  return html(`<form name="buyerInboxLinkForm" method="post" action="/epsn/vendorInboxLink.do" id="schForm">${schFormFields('MyMsg')}<strong>Total Messages:</strong>${msgs.length}&nbsp;&nbsp;<table><tr><td>Sent Date/Time</td><td>From</td><td>Subject</td><td>Action</td></tr>${rows}</table><table><tr><td align="right">${links}</td></tr></table></form>`, 'Folder Details');
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
${schFormFields('MyNegotiation')}</form>`, 'Folder Details');
}

export const LOA_SCRIPT = `<script>
function loaLetterViewActivity(url,docId){
	var docType = "11";
	var getAjaxData = '/epsn/supply/tds/ajxdata.do';
	$.ajax({ type: "POST", url: getAjaxData, data: {ajaxMode:"updateLoaViewedDataByBidder",docId:docId,docType:docType}, dataType:'text',
	    success: function(result) { if(result!=null && result == "OK"){ postRequestNewWindow('/epsn'+url,'toolbar=0'); } else { alert("Try Again."); } } });
}
</script>`;

/**
 * A Post Tenders list page. loaScript: the LOA list's own script (default LOA_SCRIPT; '' = none, or a changed one).
 * live: the layout of the captured lists (22 Oct 2026, "Response LOI.txt"): IREPS's header row (left unclosed, as
 * IREPS sends it) with "Dept/Rly. Unit" first, and each row's unit ("DAHOD / WESTERN RLY", row.unit) in that column.
 */
export function inboxRows(status, tenderNo, rows, { more = false, loaScript = LOA_SCRIPT, live = false } = {}) {
  const trs = rows.map((r) => {
    let action = '';
    if (status === 'MyNegotiation') action = `<a title="Nego Bid Process" onclick=postRequest('/epsn/supply/tds/negoBid.do?nitOId=${r.oid}')>n</a><a title="View Negotiation Letters" class="linkStyle"href="#" onclick=postRequestNewWindow('/epsn/supply/tds/publishIndiNegotiationLetter.do?nitOId=${r.oid}&negoLetterId=${r.letter}&opValue=ViewPublishedLetter','toolbar=0,width=775')>v</a>`;
    if (status === 'MyCounterOffer') action = `<a title="Counter Offer Response Page" class="linkStyle"href="#" onclick=postRequest('/epsn/supply/tds/coResponse.do?oid=${r.oid}&nitId=${r.nitId || 1}&coBidId=2&tdId=3&letterId=${r.letter}&responseDate=14/09/2026&tdVersion=1')>r</a><a title="View Counter Offer Letters" class="linkStyle"href="#" onclick=postRequestNewWindow('/epsn/supply/tds/publishCounterOfferLetter.do?Action=ViewPublishedLetter&responseDate=14/09/2026&nitOId=${r.oid}&tdId=3&tdVersion=1&bidid=2&bidderAccId=${r.bidder || '833'}&letterId=${r.letter}&signId=9${r.letter}','toolbar=0')>v</a>`;
    if (status === 'MyAdvanceAcceptanceLetter') action = `<a title="View LOA Letter" class="linkStyle"href="#" onclick=loaLetterViewActivity('/supply/tds/publishLOALetter.do?Action=ViewPublishedLetter&nitOId=${r.oid}&tdId=3&letterId=${r.letter}&tdVersion=1&bidid=2&bidderAccId=${r.bidder || '833'}&signId=9${r.letter}'${r.noDocId ? '' : `,'${r.letter}'`})>v</a>`;
    const d = r.date; const stamp = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()} 17:40&nbsp;(${r.letter})`;
    const nit = `<a class="linkStyle" title="To View NIT Click the NIT No" href="#" onclick=postRequest('/epsn/works/rfq/nitPublish.do?activity=viewNIT&nitId=9${r.letter}')>${r.no}</a>`;
    if (live) return `<tr> <td width="15%" style="color: black">${r.unit || 'STORES / WESTERN RLY'}</td><td width="15%">${nit}</td> <td width="35%" style= "padding:5px; color: black;">${r.title || 'Some item'} </td> <td width="35%" style= "padding:5px; color: black;" nowrap="nowrap">${stamp}</td><td>Published</td><td align="center">${action}</td></tr>`;
    return `<tr><td>${r.no === tenderNo ? '' : ''}Dept / RLY</td><td>${nit}</td><td>${stamp}</td><td>${action}</td></tr>`;
  }).join('');
  const head = live
    ? '<table width="100%" class="nit_summary" border="0" cellpadding="0" cellspacing="0" border="1"><tr><td colspan="5">&nbsp;</td></tr> <tr bgcolor="#E9E9EF"> <td width="15%" style="color: black"><strong>Dept/Rly. Unit</strong></td> <td width="15%" style="color: black"><strong>Tender No. </strong></td> <td width="30%" style="color: black"><strong>Tender Title</strong></td> <td width="35%" style="color: black"><strong>Letter Date (LetterId)</strong></td> <td width="15%" style="color: black"><strong>LOA Status</strong></td> <td width="20%" align="center" style="color: black"><strong>Actions</strong></td> '
    : '<table><tr><td>Tender No</td><td>Dept</td><td>Action</td></tr>';
  return html(`<form name="buyerInboxLinkForm" method="post" action="/epsn/vendorInboxLink.do" id="schForm">${schFormFields(status)}${head}${trs}</table>${more ? '<a href="#" onclick="gotoPage(2)">Next</a>' : ''}</form>${status === 'MyAdvanceAcceptanceLetter' ? loaScript : ''}`, 'Folder Details');
}

/** The heading IREPS shows on every Tender Related Correspondence page (list and details). */
const CORRES_HEADING = '<table><tr><td class="formLabel">Tender Related Correspondence</td></tr></table>';
/**
 * The Tender Related Correspondence list: the Pending table, empty unless rows are given ([{ unit, no, nitOid }],
 * each row as captured in pending-list.html: Dept/Rly, Tender No., ..., the link to the tender's correspondence page).
 */
export const corresList = (rows = []) => html(`${CORRES_HEADING}<table><tr><td class="cvap-block-heading"><b>Correspondence - Pending</b></td></tr></table><table><thead><tr><th>Dept/Rly</th><th>Tender No.</th><th>Status</th><th>Action</th></tr></thead><tbody>${rows.map((r) => `<tr><td class="dataText">${r.unit}</td><td class="dataText">${r.no}</td><td class="dataText">Pending</td><td><a href="#" class="linkStyle" onclick="postRequest('/epsn/corres/vendorCorrespondencePendingReply.do?nitOid=${r.nitOid}')"><img title="View Related Correspondence Letter(s)"></a></td></tr>`).join('')}</tbody></table>`, 'Tender Related Correspondence');
/** A tender's correspondence page without any letter. */
export const corresEmpty = () => html(`${CORRES_HEADING}<table><tr><td>Tender No</td></tr></table>`, 'Tender Related Correspondence');

/** A tender's correspondence page; c.unit: its "Dept/Rly. Unit", shown as captured (pending-reply-single.html). */
export function corresPage(c) {
  const rows = c.letters.map((l) => `<tr><td class="dataText">${l.no} dated : ${l.date || '11/09/2026'}</td><td class="dataText">${l.subject}</td><td>12/09/2026</td><td>
<a href="#" onclick="viewPublishedLtr('${c.nitOid}', '${l.corresId}', '${l.id}');" title="View Published Letter"><img src="v.png"></a>
<a href="#" class="linkStyle" onclick="postRequest('/epsn/corres/vendor/vendorCorresSubmitReply.do?nitOid=${c.nitOid}&corresId=${l.corresId}&letterId=${l.id}&bidId=9')"><img title="Submit Response"></a></td></tr>`).join('');
  return html(`${CORRES_HEADING}<table><tr><td class="formLabel">Tender No</td><td class="dataText">
 ${c.tenderNo}
</td><td class="formLabel">Closing Date</td><td>09/09/2026</td></tr>${c.unit ? `<tr><td class="formLabel">Dept/Rly. Unit</td><td class="dataText" colspan="3">
 ${c.unit.replace(' / ', ' &nbsp;/&nbsp;\n ')}
</td></tr>` : ''}</table>
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
export const letterHtml = (label, extra = '') => html(`<div><h2>${label}</h2><table><tr><td>Letter No</td><td>306789</td></tr><tr><td>Date</td><td>11/09/2026</td></tr></table><p>Please note the revised terms and conditions apply to the above tender in all respects.</p>${extra}</div>`, label);
/** A corrigendum page with its attached documents linked (c.attached = ['Revised_Spec.pdf', ...]; c.extra: more markup). */
export const corrigendumPage = (c) => letterHtml(`Corrigendum ${c.cn}`, (c.attached || []).map((f) => `<p>Attached Document: <a href="/ireps/upload/corrigendum/${c.id}/${f}" target="_blank">${f}</a></p>`).join('') + (c.extra || ''));

/**
 * Tabulation answers that are not the PDF itself (commTboPdfAction.do opens in a popup, so no HAR has the real one):
 *   iframe  a viewer embedding /ireps/upload/tbo/Tabulation_<oid>.pdf (no "financial"/"commercial" in the name),
 *           next to a Techno-Commercial link that must never be requested
 *   form    a page that posts itself on to the file (showTabulation.do), as postRequest.js does
 *   open    a page whose script opens a servlet URL with no extension
 *   onload  what real IREPS answers (captured 03 Nov 2026, LN265611): <body onload="openwindow('<absolute pdfdocs URL>')">,
 *           FIN-TAB-<no>-<oid>.pdf for the Financial Tabulation and TECH-TAB-<no>-<oid>.pdf for the Commercial one
 */
export function tabulationViewer(mode, type, oid, no = '') {
  if (mode === 'onload') {
    const file = `https://www.ireps.gov.in/ireps/supply/pdfdocs//112026/${oid}/${type === 'financialTabulation' ? 'FIN' : 'TECH'}-TAB-${no}-${oid}.pdf`;
    return enc(`<html>
<head>
<script language="javascript">
function openwindow(pdfName)
{
   day = new Date();
   id = day.getTime();
   //alert("inside script");
   var URL=pdfName;
   //alert(URL);
   eval("page" + id + " = window.open(URL, '" + id + "', 'toolbar=0,titlebar=0,scrollbars=1,location=0,statusbar=0,menubar=0,resizable=1,width=1024,height=768');");
   window.close();
}
</script>
</head>

<body onload="openwindow('${file}');">
<bean:message key = "bid.label.load"/><br>
<img src="/ireps/images/common/loderBar.gif">

</body>
</html>`);
  }
  if (mode === 'iframe') return html(`<a href="/ireps/upload/tbo/TechnoCommercial_Tabulation_${oid}.pdf">TCT</a><a href="#" onclick="postRequestNewWindow('/epsn/tbo/commTboPdfAction.do?pdfType=technoCommercialTabulation&tenderOID=${oid}')">t</a><iframe src="/ireps/upload/tbo/Tabulation_${oid}.pdf" width="100%"></iframe>`, 'Tabulation');
  if (mode === 'form') return html(`<form action="/epsn/tbo/showTabulation.do" method="post"><input type="hidden" name="oid" value="${oid}"><input type="hidden" name="pdfType" value="${type}"></form><script>document.forms[0].submit();</script>`, 'Please wait');
  if (mode === 'open') return html(`<p>Opening...</p><script>window.open('/ireps/upload/tbo/view?oid=${oid}&t=${type}', '_self');</script>`, 'Tabulation');
  return html('<h1>Error</h1> unknown mode');
}

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
      inboxPageSize: 14, // rows per Post Tenders list page, as on IREPS
      letterAsPdf: false,
      failPaths: [],
      ...state,
    };
    this.log = [];
    this.listPages = []; // every Post Tenders list page requested: { status, startDate, endDate, pageNo }
    this.lastSearch = null; // IREPS keeps the last Search Tender search in the session; its page links read it
    this.shownLinks = new Set(); // every Search Tender page link a result page showed
    this.unshownPageGets = []; // the page numbers asked for through a link no result page showed before
    this.pagesInFlight = 0; // Search Tender page requests being answered (s.searchPageMs makes them take time)
    this.maxPagesInFlight = 0;
  }

  tenderBy(f, v) { return this.s.tenders.find((t) => String(t[f]) === String(v)); }

  /**
   * Result page `pageNo` of the last search, s.searchPageSize rows a page (25, as IREPS), with IREPS's page links:
   * hrefs to advancedSearch.do with count= and pageNo=, page 1's with railwayzone=-1 and later pages' with
   * railwayzone=, the ten around this page and "next" to the first of the next ten (20 Nov 2026 capture).
   */
  searchPage(pageNo) {
    const s = this.lastSearch;
    // s.searchChanges: [{ beforePage, remove: '<tender no>' } | { beforePage, add: tender, at }]: the day's list changes
    // just before that page is served, as on the closing day itself (IREPS runs the search again for every page)
    for (const c of this.s.searchChanges || []) {
      if (c.beforePage !== pageNo || c.done) continue;
      c.done = true;
      if (c.remove) s.hits = s.hits.filter((t) => t.no !== c.remove);
      if (c.add) s.hits.splice(c.at || 0, 0, c.add);
    }
    const per = this.s.searchPageSize || 25;
    const pages = Math.ceil(s.hits.length / per);
    const link = (n, text = n) => {
      const href = `/epsn/search/advancedSearch.do?advancedSearch=${s.term}&railwayzone=${pageNo === 1 ? '-1' : ''}&dateFrom=${s.dateFrom}&linkVal=department&dateTo=${s.dateTo}&selectDate=TENDER_OPENING_DATE&count=${s.hits.length}&pageNo=${n}`;
      this.shownLinks.add(href);
      return `<a href="${href}">${text}</a>`;
    };
    const first = Math.floor((pageNo - 1) / 10) * 10 + 1;
    const shown = Array.from({ length: Math.max(0, Math.min(10, pages - first + 1)) }, (_, i) => link(first + i));
    if (first + 10 <= pages) shown.push(link(first + 10, 'next'));
    const links = pages > 1 ? `<table><tr><td>${shown.join('&nbsp;')}</td></tr></table>` : '';
    return resultsPage(s.hits.slice((pageNo - 1) * per, pageNo * per).map(resultRow), { total: s.hits.length, links });
  }

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
      // a page link (GET ...&count=N&pageNo=n): a page of the search this session made last
      if (method === 'GET' && q.get('pageNo')) {
        if (!this.shownLinks.has(p + u.search)) this.unshownPageGets.push(Number(q.get('pageNo')));
        this.maxPagesInFlight = Math.max(this.maxPagesInFlight, ++this.pagesInFlight);
        // s.searchPageMs (ms, or pageNo -> ms): IREPS takes its time over each page (about 13 s on 23 Nov 2026)
        const ms = typeof this.s.searchPageMs === 'function' ? this.s.searchPageMs(Number(q.get('pageNo'))) : this.s.searchPageMs;
        if (ms) await new Promise((r) => setTimeout(r, ms));
        this.pagesInFlight--;
        return ok(this.lastSearch && this.lastSearch.hits.length ? this.searchPage(Number(q.get('pageNo'))) : searchFormPage());
      }
      if (method === 'GET' || body.get('searchParam') === 'showPage') return ok(searchFormPage());
      const term = body.get('advancedSearch');
      const dept = body.get('division');
      if (dept === '-1' && this.s.rejectAllDepts) return ok(html('<form>Please select Department <input type=text></form>'));
      const from = parseD(body.get('dateFrom'));
      const to = parseD(body.get('dateTo'));
      if ((to - from) / DAY > 186) return ok(html('<form>Date range should be within 6 months</form>'));
      const hits = this.s.tenders.filter((t) => t.no.startsWith(term) && t.closing >= from && t.closing <= to && (dept === '-1' || dept === (t.deptCode || '19')));
      this.lastSearch = { hits, term, dateFrom: body.get('dateFrom'), dateTo: body.get('dateTo') };
      return ok(hits.length ? this.searchPage(1) : noResultsPage());
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
      return c.asHtml || c.attached ? ok(corrigendumPage(c)) : pdf('corr' + c.id);
    }
    if (p.startsWith('/ireps/upload/corrigendum/')) {
      if (p.includes('missing')) return { status: 404, type: 'text/html', bytes: html('not found') };
      return pdf('corratt' + p);
    }
    if (p === '/epsn/works/rfq/viewCorrigendumDetail.do') return { status: 404, type: 'text/html', bytes: html('wrong route') };

    if (p === '/epsn/tbo/commTboPdfAction.do') {
      // postRequestNewWindow POSTs the query as the body; window.open GETs it
      const arg = (k) => q.get(k) || body.get(k);
      const type = arg('pdfType');
      if (!['offer', 'financialTabulation', 'commercialTabulation'].includes(type)) { this.excludedHit = true; return pdf('FORBIDDEN'); }
      if (type !== 'offer' && this.s.tabulationAsHtml) return ok(letterHtml(`${type} ${arg('tenderOID')}`));
      if (type !== 'offer' && this.s.tabulationAs) return ok(tabulationViewer(this.s.tabulationAs, type, arg('tenderOID'), [...(this.s.closed || []), ...this.s.tenders].find((c) => c.oid === arg('tenderOID'))?.no));
      // s.tabulationDisposition: IREPS names the file it serves in Content-Disposition
      if (type !== 'offer' && this.s.tabulationDisposition) return { ...pdf(type + arg('tenderOID')), disposition: this.s.tabulationDisposition };
      return pdf(type + arg('tenderOID'));
    }
    if (p.startsWith('/ireps/upload/tbo/')) {
      if (/techno/i.test(p)) { this.excludedHit = true; return pdf('FORBIDDEN'); }
      return pdf('tabfile' + p);
    }
    if (/^\/ireps\/supply\/pdfdocs\/.*-TAB-/.test(p)) {
      if (/techno/i.test(p)) { this.excludedHit = true; return pdf('FORBIDDEN'); }
      this.tabFileHits = [...(this.tabFileHits || []), p];
      return pdf('tabfile' + p);
    }
    if (p === '/epsn/tbo/showTabulation.do') return method === 'POST' && body.get('oid') ? pdf('tabform' + body.get('oid')) : ok(html('<h1>Error</h1> missing'));
    if (p.startsWith('/ireps/upload/loa/')) { this.loaAttachmentHit = true; return pdf('loa-attachment'); }
    if (p.startsWith('/ireps/upload/co/')) { this.coAttachmentHit = true; return pdf('co-attachment'); }
    if (p.startsWith('/ireps/upload/nego/')) { this.negoHits = [...(this.negoHits || []), p]; return pdf('nego-file' + p); }
    if (p.startsWith('/ireps/upload/corres/')) { this.corresHits = [...(this.corresHits || []), p]; return pdf('corres-file' + p); }

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
        this.listPages.push({ status: 'MyBidsClosed', startDate: body.get('startDate'), endDate: body.get('endDate'), pageNo: body.get('pageNo') });
        if (this.s.closedIgnoresDates) {
          // whole list whatever the dates, newest closing first, 10 rows a page (as the captured page)
          const list = all.filter((t) => !want || t.no === want).sort((a, b) => b.closing - a.closing);
          return ok(closedTendersPage(list.slice((pageNo - 1) * 10, pageNo * 10), { more: pageNo * 10 < list.length, pageNo }));
        }
        const hits = all.filter((t) => (!want || t.no === want) && t.closing >= from && t.closing <= to);
        const pages = Math.max(1, ...hits.map((t) => t.page || 1));
        return ok(closedTendersPage(hits.filter((t) => (t.page || 1) === pageNo), { more: pageNo < pages, pageNo }));
      }
      if (!body.get('startDate')) return ok(inboxForm());
      this.listPages.push({ status, startDate: body.get('startDate'), endDate: body.get('endDate'), pageNo: body.get('pageNo') });
      const pageNo = Number(body.get('pageNo') || 1);
      const want = body.get('tenderNo');
      // like IREPS: startDate/endDate are ignored on Post Tenders lists; newest Letter Date first, live bids before lapsed
      const rows = (this.s.inbox[status] || []).filter((r) => !want || r.no === want)
        .sort((a, b) => (a.live ? 0 : 1) - (b.live ? 0 : 1) || b.date - a.date);
      const pages = this.s.inboxPages[status];
      const loaScript = this.s.loaScript ?? LOA_SCRIPT;
      const live = !!this.s.liveInbox;
      if (pages) return ok(inboxRows(status, want, rows.filter((r) => (r.page || 1) === pageNo), { more: pageNo < pages, loaScript, live }));
      const per = this.s.inboxPageSize;
      return ok(inboxRows(status, want, rows.slice((pageNo - 1) * per, pageNo * per), { more: pageNo * per < rows.length, loaScript, live }));
    }

    const letterPaths = ['/epsn/supply/tds/publishIndiNegotiationLetter.do', '/epsn/supply/tds/publishCounterOfferLetter.do', '/epsn/supply/tds/publishLOALetter.do', '/epsn/corres/rly/viewpubIndltr.do'];
    if (letterPaths.includes(p)) {
      if (method !== 'POST') return { status: 405, type: 'text/html', bytes: html('POST only') };
      if (p.endsWith('publishLOALetter.do') && !this.loaAcked) return ok(html('<h1>Not viewed</h1> You have not acknowledged the letter first, error occurred'));
      const id = body.get('negoLetterId') || body.get('letterId') || body.get('letterID');
      // s.letterBody: { '<letter page>.do': (id) => '<body html>' } - a letter page of another shape (a viewer page)
      const custom = this.s.letterBody?.[p.split('/').pop()];
      if (custom) return ok(html(custom(id), 'Letter'));
      const extra = p.endsWith('publishLOALetter.do') ? this.s.loaExtra : p.endsWith('publishCounterOfferLetter.do') ? this.s.coExtra
        : p.endsWith('publishIndiNegotiationLetter.do') ? this.s.negoExtra : p.endsWith('viewpubIndltr.do') ? this.s.corresExtra : '';
      return this.s.letterAsPdf ? pdf('letter' + id) : ok(letterHtml('Letter ' + id, extra || ''));
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
    if (p === '/epsn/corres/vendorRelatedCorrespondence.do') return ok(corresList(this.s.corresRows || []));
    if (p === '/epsn/corres/vendorCorrespondencePendingReply.do') {
      const c = this.s.corres[body.get('nitOid')];
      return ok(c ? corresPage(c) : corresEmpty());
    }
    return { status: 404, type: 'text/html', bytes: html('not found') };
  }
}

/**
 * A fake chrome.debugger + chrome.tabs answering like the DevTools protocol (tender-print.js):
 * navigate -> the page request pauses -> fulfilled -> load -> printToPDF returns a PDF.
 *   attachError: attach throws (blocked by policy); cancel: the user cancels the "started debugging" bar.
 *   pageRequests: what the letter's page then asks for, [{ method, url, postData, resourceType, hasPostData,
 *     postDataEntries, networkId }] (each pauses as Fetch.requestPaused, requestId p1, p2 ...); hang: the page never
 *     finishes loading.
 *   postData: networkId -> the body Network.getRequestPostData reads (any other id: CDP answers with an error).
 *   fulfillError: Fetch.fulfillRequest fails with this message, and the tab loads a blank page instead.
 *   popup: when the page is handed over, it opens a window (tab 8, opener 7; chrome.tabs.onCreated).
 * Closing the tab while attached ends the session (onDetach 'target_closed'), as Chrome does.
 */
export function fakeChromeDebugger(chrome, { attachError = null, cancel = false, pageRequests = [], hang = false, postData = {}, fulfillError = null, popup = false } = {}) {
  const onEvent = new Set();
  const onDetach = new Set();
  const onCreated = new Set();
  const calls = [];
  const tabs = { created: 0, removed: [] };
  let attached = false;
  const fire = (set, ...args) => setTimeout(() => set.forEach((f) => f({ tabId: 7 }, ...args)), 0);
  chrome.tabs = {
    create: async () => { tabs.created++; return { id: 7 }; },
    remove: async (id) => { tabs.removed.push(id); if (attached && id === 7) { attached = false; fire(onDetach, 'target_closed'); } },
    onCreated: { addListener: (f) => onCreated.add(f), removeListener: (f) => onCreated.delete(f) },
  };
  chrome.debugger = {
    onEvent: { addListener: (f) => onEvent.add(f), removeListener: (f) => onEvent.delete(f) },
    onDetach: { addListener: (f) => onDetach.add(f), removeListener: (f) => onDetach.delete(f) },
    attach: async () => { if (attachError) throw new Error(attachError); attached = true; calls.push(['attach']); },
    detach: async () => { attached = false; calls.push(['detach']); },
    sendCommand: async (target, method, params) => {
      calls.push([method, params]);
      if (method === 'Page.navigate') {
        if (cancel) { attached = false; fire(onDetach, 'canceled_by_user'); }
        else fire(onEvent, 'Fetch.requestPaused', { requestId: 'r1', frameId: 'main', resourceType: 'Document', request: { url: params.url, method: 'GET' } });
        return { frameId: 'main' };
      }
      if (method === 'Fetch.fulfillRequest') {
        if (fulfillError) {
          if (!hang) fire(onEvent, 'Page.loadEventFired', {});
          throw new Error(fulfillError);
        }
        pageRequests.forEach((r, i) => fire(onEvent, 'Fetch.requestPaused', { requestId: `p${i + 1}`, frameId: r.frameId || 'main', resourceType: r.resourceType || 'XHR', ...(r.networkId ? { networkId: r.networkId } : {}),
          request: { url: r.url, method: r.method || 'GET', ...(r.postData ? { postData: r.postData } : {}), ...(r.hasPostData ? { hasPostData: true } : {}), ...(r.postDataEntries ? { postDataEntries: r.postDataEntries } : {}) } }));
        if (popup) setTimeout(() => onCreated.forEach((f) => f({ id: 8, openerTabId: 7, pendingUrl: 'https://www.ireps.gov.in/epsn/supply/bid/viewBid.do' })), 0);
        if (!hang) fire(onEvent, 'Page.loadEventFired', {});
      }
      if (method === 'Network.getRequestPostData') {
        if (!(params.requestId in postData)) throw new Error('No resource with given id was found');
        return { postData: postData[params.requestId] };
      }
      if (method === 'Page.printToPDF') return { data: Buffer.from(PDF('chrome-print')).toString('base64') };
      return {};
    },
  };
  /** what became of a paused request: 'continued' | 'failed' | undefined */
  const outcome = (requestId) => (calls.some((c) => c[0] === 'Fetch.failRequest' && c[1].requestId === requestId) ? 'failed'
    : calls.some((c) => c[0] === 'Fetch.continueRequest' && c[1].requestId === requestId) ? 'continued' : undefined);
  return { calls, tabs, cmd: (m) => calls.find((c) => c[0] === m)?.[1], outcome };
}

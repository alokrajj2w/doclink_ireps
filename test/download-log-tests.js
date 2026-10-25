/**
 * Tests for the download log (services/download-log.js): document keys and records, the
 * already-downloaded check against a fake Recon Engine, the queue (flush, retry, a 401
 * keeping records), the pre-flight decisions (skip / download again / no answer), the
 * ECM folder check in both modes (ecm-service findInEcm: the gateway's /exists, and the
 * direct NXQL with ecm:parentId and IN) and the shared downloader's preflight / onSaved
 * hooks. No extension APIs are used. Invoked from run-tests.js.
 */

import {
  downloadKey, downloadRecord, savedDestination, runDestination, checkDownloaded, logDownload, flushDownloadLog,
  preflightDownloads, applyDownloadLogConfig, configureDownloadLog, describeSkip, listDownloads, exportFingerprint, DOC_TYPE_LABEL, SKIP_REASON, LOG_DESTINATION
} from "../services/download-log.js";
import { findInEcm, ECM_KIND } from "../services/ecm-service.js";
import { resetEcmDirectState } from "../services/ecm-direct.js";
import { applyEcmConfig } from "../services/ecm-config.js";
import { applyReconConfig } from "../services/recon-service.js";
import { downloadIrepsDocuments, DOCUMENT_DOWNLOAD_STATUS } from "../services/search-po/document-downloader.js";
import { IREPS_CONFIG } from "../services/ireps-api.js";

const RECON = "http://localhost:8000";
const NUXEO = "http://ecm.test:8080";
const HOSTS = [`${RECON}/*`, `${NUXEO}/*`];
const HOSUR = { irepsAccountId: "833", operatingUnit: "HOSUR" };
const HOSUR_INPUTS = "d440070d-3a60-4ad7-bf67-8efeb198e26b";

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** A fake Recon Engine: `already` = { key: hit }; `status` forces every answer's status. Records calls. */
function fakeRecon({ already = {}, status = null } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), body, credentials: init.credentials, method: init.method });
    if (status) return json(status, { detail: { error: "X", detail: `HTTP ${status}` } });
    if (String(url).endsWith("/api/doclink/downloads/check")) {
      return json(200, { destination: body.destination, downloaded: Object.fromEntries(body.keys.filter((k) => already[k]).map((k) => [k, already[k]])) });
    }
    if (String(url).endsWith("/api/doclink/downloads")) return json(201, { logged: body.records.length });
    if (String(url).endsWith("/api/ecm/documents/exists")) return json(200, { found: {} });
    return json(404, {});
  };
  fn.calls = calls;
  return fn;
}

/** An in-memory chrome.storage.local stand-in. */
function memoryStorage() {
  const data = {};
  return { data, get: async (k) => (k in data ? { [k]: data[k] } : {}), set: async (o) => Object.assign(data, JSON.parse(JSON.stringify(o))) };
}

const HIT = { count: 2, filename: "PO_PO-1.pdf", downloaded_at: "2026-10-22T04:35:00+00:00", date: "2026-10-22", time: "10:05:00" };

export async function runDownloadLogTests({ test, assert, eq }) {
  applyReconConfig({ reconBaseUrl: RECON });
  applyDownloadLogConfig({});
  configureDownloadLog({ hostPermissions: HOSTS, flushDelayMs: 0, storage: memoryStorage() });

  await test("download log: keys are the document's numbers, never the file name", () => {
    eq(downloadKey.po(" PO-1 "), "po:PO-1");
    eq(downloadKey.ma("PO-1", "007012"), "ma:PO-1|007012");
    eq(downloadKey.ic({ poNo: "PO-1", poSerial: "2", callId: "C9" }), "ic:PO-1|2|C9");
    eq(downloadKey.ic({ poNo: "PO-1", poSerial: "2", icNumber: "IC7" }), "ic:PO-1|2|IC7", "no call id: the IC number");
    eq(downloadKey.tender("TENDER_PDF", "29263265", ""), "tender:TENDER_PDF|29263265|");
    eq(downloadKey.export("crn", "ab12"), "export:crn:ab12");
    eq(runDestination("recon"), "ecm");
    eq(runDestination("local"), "local");
  });

  await test("download log: an export is the same when its rows and format are, whatever the run's file name", async () => {
    const rows = [{ crnNo: "013801-26-20001", poNo: "RR-1", crnDate: "12/09/2026" }, { crnNo: "013802-26-20002", poNo: "702", crnDate: "17/09/2026" }];
    const a = await exportFingerprint("xlsx", rows);
    eq(a.length, 64, "SHA-256 hex");
    eq(await exportFingerprint("xlsx", JSON.parse(JSON.stringify(rows))), a, "the same rows fetched again");
    assert((await exportFingerprint("xlsx", [...rows, { crnNo: "013803-26-20003" }])) !== a, "a new row in IREPS = a new export");
    assert((await exportFingerprint("xlsx", [{ ...rows[0], crnDate: "13/09/2026" }, rows[1]])) !== a, "a changed row = a new export");
    assert((await exportFingerprint("csv", rows)) !== a, "the same rows as CSV are a different file");
    eq((await exportFingerprint("xlsx", [])).length, 64);
  });

  await test("download log: a record says where the file actually went", () => {
    eq(savedDestination({ status: "stored" }), "ecm");
    eq(savedDestination({ status: "already_stored" }), "ecm");
    eq(savedDestination({ status: "failed", code: "ECM_UNAVAILABLE" }), "local", "an ECM failure saved locally is a local download");
    eq(savedDestination(null), "local");
    const ecm = downloadRecord({ docType: "ma", key: "ma:PO-1|007012" }, { filename: "DocLink/IREPS/MA/x/MA_1.pdf", ecm: { status: "stored", uid: "u-1", path: "/FT/x", site: "hosur" }, account: HOSUR });
    eq(JSON.stringify(ecm), JSON.stringify({ doc_type: "ma", doc_key: "ma:PO-1|007012", filename: "MA_1.pdf", destination: "ecm", ireps_account_id: "833", ecm: { status: "stored", uid: "u-1", path: "/FT/x", site: "hosur" } }));
    const local = downloadRecord({ docType: "po", key: "po:PO-1" }, { filename: "PO_1 (1).pdf", ecm: { status: "failed" } });
    eq(local.destination, "local");
    eq(local.ecm, undefined, "no ECM details for a file that is not in the ECM");
    eq(downloadRecord({ docType: "crn", key: "k" }, { filename: "CRN.xlsx", destination: "s3" }).destination, "s3");
  });

  await test("download log: the check sends destination + unique keys with the Recon cookie, and never throws", async () => {
    const fetch = fakeRecon({ already: { "po:PO-1": HIT } });
    const r = await checkDownloaded({ destination: "local", keys: ["po:PO-1", "po:PO-2", "po:PO-1", ""] }, { fetch });
    eq(r.ok, true);
    eq(Object.keys(r.downloaded).join(), "po:PO-1");
    eq(fetch.calls.length, 1);
    eq(fetch.calls[0].url, `${RECON}/api/doclink/downloads/check`);
    eq(fetch.calls[0].credentials, "include");
    eq(JSON.stringify(fetch.calls[0].body), JSON.stringify({ destination: "local", keys: ["po:PO-1", "po:PO-2"] }));
    const empty = await checkDownloaded({ destination: "local", keys: [] }, { fetch });
    eq(empty.ok, true);
    eq(fetch.calls.length, 1, "no keys: no request");
    const down = await checkDownloaded({ destination: "local", keys: ["po:PO-1"] }, { fetch: fakeRecon({ status: 503 }) });
    eq(down.ok, false);
    eq(down.code, "DOWNLOAD_LOG_UNAVAILABLE");
    eq((await checkDownloaded({ destination: "local", keys: ["po:PO-1"] }, { fetch: fakeRecon({ status: 401 }) })).code, "RECON_AUTH_REQUIRED");
    const offline = await checkDownloaded({ destination: "local", keys: ["po:PO-1"] }, { fetch: async () => { throw new TypeError("Failed to fetch"); } });
    eq(offline.ok, false);
  });

  await test("download log: queued records are posted in one batch; a failed post (even a 401) keeps them for the next", async () => {
    const storage = memoryStorage();
    configureDownloadLog({ storage, context: "test" });
    await logDownload(downloadRecord({ docType: "po", key: "po:A" }, { filename: "a.pdf" }));
    await logDownload(downloadRecord({ docType: "po", key: "po:B" }, { filename: "b.pdf" }));
    const queueKey = "doclink.downloadLog.queue.test";
    eq(storage.data[queueKey].length, 2);

    const signedOut = fakeRecon({ status: 401 });
    const kept = await flushDownloadLog({ fetch: signedOut });
    eq(kept.posted, 0);
    eq(kept.pending, 2);
    eq(kept.code, "RECON_AUTH_REQUIRED");
    eq(storage.data[queueKey].length, 2, "nothing lost while signed out");

    const fetch = fakeRecon();
    const sent = await flushDownloadLog({ fetch });
    eq(sent.posted, 2);
    eq(storage.data[queueKey].length, 0);
    eq(fetch.calls.length, 1);
    eq(fetch.calls[0].body.records.map((r) => r.doc_key).join(), "po:A,po:B");
    eq((await flushDownloadLog({ fetch })).posted, 0, "an empty queue posts nothing");
    eq(fetch.calls.length, 1);

    applyDownloadLogConfig({ downloadLog: { enabled: false } });
    await logDownload(downloadRecord({ docType: "po", key: "po:C" }, { filename: "c.pdf" }));
    eq(storage.data[queueKey].length, 0, "the log off: nothing queued");
    applyDownloadLogConfig({});
    configureDownloadLog({ storage: memoryStorage(), context: "sw" });
  });

  const PO = (n) => ({ id: `po-${n}`, label: `PO ${n}`, log: { docType: "po", key: downloadKey.po(n) }, ecm: { kind: ECM_KIND.PO_COPY, fields: { customer_po_number: n } } });

  await test("download log: preflight skips what this user already has, after asking which to download again", async () => {
    const fetch = fakeRecon({ already: { "po:1": HIT, "po:2": HIT } });
    const questions = [];
    const skipAll = await preflightDownloads([PO("1"), PO("2"), PO("3")], { destination: "local", ask: async (q) => (questions.push(q), { redownload: [] }), deps: { fetch } });
    eq(questions.length, 1);
    eq(questions[0].alreadyDownloaded.map((a) => a.id).join(), "po-1,po-2");
    eq(questions[0].alreadyDownloaded[0].date, "2026-10-22");
    eq(questions[0].inEcm.length, 0, "a local run does not ask the ECM");
    eq([...skipAll.skip.keys()].join(), "po-1,po-2");
    eq(skipAll.skip.get("po-1").reason, SKIP_REASON.ALREADY_DOWNLOADED);
    eq(skipAll.checked, true);
    eq(describeSkip(skipAll.skip.get("po-1")), "Already downloaded on 2026-10-22 at 10:05 (2 times)");

    const again = await preflightDownloads([PO("1"), PO("2"), PO("3")], { destination: "local", ask: async () => ({ redownload: ["po-2"] }), deps: { fetch } });
    eq([...again.skip.keys()].join(), "po-1", "the ticked one is downloaded again");

    const unanswered = await preflightDownloads([PO("1"), PO("3")], { destination: "local", ask: async () => null, deps: { fetch } });
    eq([...unanswered.skip.keys()].join(), "po-1", "no answer: not downloaded again");

    let asked = 0;
    const fresh = await preflightDownloads([PO("3")], { destination: "local", ask: async () => (asked++, null), deps: { fetch } });
    eq(fresh.skip.size, 0);
    eq(asked, 0, "nothing to ask about: no question");

    const down = await preflightDownloads([PO("1")], { destination: "local", ask: async () => (asked++, null), deps: { fetch: fakeRecon({ status: 500 }) } });
    eq(down.skip.size, 0, "the log unreachable: everything is downloaded");
    eq(down.checked, false);
    assert(down.warnings.some((w) => /unavailable/.test(w)), down.warnings.join());

    applyDownloadLogConfig({ downloadLog: { enabled: false } });
    const off = await preflightDownloads([PO("1")], { destination: "local", ask: async () => (asked++, null), deps: { fetch } });
    eq(off.skip.size, 0);
    eq(asked, 0);
    applyDownloadLogConfig({});
  });

  await test("download log: under ECM the gateway is asked which documents its folder already holds", async () => {
    applyEcmConfig({ ecmBackendAws: true });
    const base = fakeRecon();
    const fetch = async (url, init) => {
      if (String(url).endsWith("/api/ecm/documents/exists")) {
        base.calls.push({ url: String(url), body: JSON.parse(init.body), credentials: init.credentials });
        return json(200, { found: { "po-3": { uid: "u-9", path: "/FT/workspaces/Sites/HSR/Invoice Certificate - TS/Inputs/PO-3", title: "PO-3" } } });
      }
      return base(url, init);
    };
    let question = null;
    const r = await preflightDownloads([PO("1"), PO("3")], { destination: "ecm", account: HOSUR, ask: async (q) => ((question = q), { redownload: [] }), deps: { fetch, hostPermissions: HOSTS } });
    const exists = base.calls.find((c) => c.url.endsWith("/exists"));
    eq(JSON.stringify(exists.body), JSON.stringify({ kind: "poCopy", candidates: [{ ref: "po-1", fields: { customer_po_number: "1" } }, { ref: "po-3", fields: { customer_po_number: "3" } }], ireps_account_id: "833", operating_unit: "HOSUR" }));
    eq(exists.credentials, "include");
    eq(base.calls.find((c) => c.url.endsWith("/check")).body.destination, "ecm");
    eq(question.inEcm.map((e) => e.id).join(), "po-3");
    eq(r.skip.get("po-3").reason, SKIP_REASON.ALREADY_IN_ECM);
    eq(r.skip.get("po-3").path, "/FT/workspaces/Sites/HSR/Invoice Certificate - TS/Inputs/PO-3");
    eq(r.skip.has("po-1"), false);

    const unknown = await findInEcm({ kind: "poCopy", account: {}, candidates: [{ ref: "x", fields: { customer_po_number: "1" } }] }, { fetch, hostPermissions: HOSTS });
    eq(unknown.ok, false);
    eq(unknown.code, "ECM_ACCOUNT_UNKNOWN", "no verified account: no ECM check (the documents are downloaded)");
  });

  await test("download log: in direct mode the ECM is searched in the upload folder, by the kind's numbers, not file names", async () => {
    resetEcmDirectState();
    applyEcmConfig({ ecmBackendAws: false, ecm: { env: "TEST", domain: NUXEO, clientId: "id", clientSecret: "s" } });
    const queries = [];
    const fetch = async (url) => {
      const u = new URL(url);
      if (u.pathname === "/nuxeo/oauth2/token") return json(200, { access_token: "tok", expires_in: 3600 });
      if (u.pathname === "/nuxeo/api/v1/search/lang/NXQL/execute") {
        queries.push(u.searchParams.get("query"));
        const doc = (uid, po, ma, title) => ({ uid, path: `/FT/workspaces/Sites/HSR/Invoice Certificate - TS/Inputs/${title}`, title, properties: { "dc:title": title, "InvoiceCertificateSchema:customerPONumber": po, "InvoiceCertificateSchema:modificationAdviseNumber": ma, "file:content": { name: "05250369100012_MODIFICATIONADVISE.pdf" } } });
        return json(200, { entries: [doc("u-1", "05250369100012", "007012", "007012"), doc("u-2", "05250369100012", "007099", "007099")], isNextPageAvailable: false });
      }
      return json(404, {});
    };
    const MA = (po, ma) => ({ ref: `ma-${ma}`, fields: { customer_po_number: po, modification_advise_number: ma } });
    const r = await findInEcm({ kind: ECM_KIND.MODIFICATION_ADVISE, account: HOSUR, candidates: [MA("05250369100012", "007012"), MA("05250369100012", "007013"), MA("OTHER", "007099")] }, { fetch, hostPermissions: HOSTS });
    eq(r.ok, true);
    eq([...r.found.keys()].join(), "ma-007012", "every field must match: 007099 belongs to another PO");
    eq(r.found.get("ma-007012").uid, "u-1");
    eq(queries.length, 1, "one query for the whole list");
    eq(queries[0], `SELECT * FROM Document WHERE ecm:isVersion = 0 AND ecm:isTrashed = 0 AND InvoiceCertificateSchema:type = 'modificationAdvise' AND ecm:parentId = '${HOSUR_INPUTS}' AND InvoiceCertificateSchema:customerPONumber IN ('05250369100012', 'OTHER')`);
    assert(!/file:content|icDate|dc:title/.test(queries[0]), "neither file names nor dates nor titles in the query");
    applyEcmConfig({ ecmBackendAws: true });
  });

  await test("download log: the shared downloader skips what preflight says, fetches the rest and reports each save", async () => {
    const base = IREPS_CONFIG.baseUrl;
    const pdf = new TextEncoder().encode("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n");
    const fetched = [];
    const fetchImpl = async (url) => (fetched.push(String(url)), new Response(pdf, { status: 200, headers: { "content-type": "application/pdf" } }));
    const items = ["1", "2", "3"].map((n) => ({ id: `po-${n}`, url: `${base}/epsn/po/${n}.pdf`, path: `DocLink/IREPS/PO/PO_${n}.pdf`, label: `PO ${n}`, log: { docType: "po", key: downloadKey.po(n) } }));
    const saved = [];
    const summary = await downloadIrepsDocuments(items, {
      fetch: fetchImpl,
      saveFile: async (bytes, path) => ({ downloadId: 1, filename: path.split("/").pop(), path }),
      preflight: async (list) => ({ skip: new Map([[list[1].id, { reason: SKIP_REASON.ALREADY_DOWNLOADED, date: "2026-10-22" }]]), warnings: ["w"] }),
      onSaved: async (item, done) => saved.push(downloadRecord(item.log, { filename: done.filename, ecm: done.ecm }))
    });
    eq(summary.completed, 2);
    eq(summary.skipped, 1);
    eq(summary.items[1].status, DOCUMENT_DOWNLOAD_STATUS.SKIPPED);
    eq(summary.items[1].skip.reason, "already_downloaded");
    eq(fetched.some((u) => u.endsWith("/2.pdf")), false, "a skipped document is not fetched");
    eq(saved.map((r) => `${r.doc_key}:${r.filename}:${r.destination}`).join(), "po:1:PO_1.pdf:local,po:3:PO_3.pdf:local");
    eq(summary.warnings.join(), "w");

    const failingLog = await downloadIrepsDocuments(items.slice(0, 1), {
      fetch: fetchImpl,
      saveFile: async (bytes, path) => ({ downloadId: 1, filename: path.split("/").pop(), path }),
      preflight: async () => { throw new Error("boom"); },
      onSaved: async () => { throw new Error("log down"); }
    });
    eq(failingLog.completed, 1, "a broken check or log never fails the download");
  });

  await test("download log: My downloads reads the user's log with the filters, and says why it cannot", async () => {
    const calls = [];
    const row = { id: 7, user_id: 3, user_email: "a@x.com", user_name: "A", ireps_account_id: "833", doc_type: "ma", doc_key: "ma:1|2", filename: "MA_1_2.pdf", destination: "ecm", ecm: { status: "stored", uid: "u", path: "/FT/x/2", site: "hosur" }, downloaded_at: "2026-10-22T04:35:00+00:00", date: "2026-10-22", time: "10:05:00" };
    const fetch = async (url, init) => (calls.push({ url: String(url), init }), json(200, { count: 1, downloads: [row] }));
    const page = await listDownloads({ from: "2026-10-16", to: "2026-10-22", destination: "ecm", docType: "ma", limit: 50, offset: 50 }, { fetch });
    eq(page.count, 1);
    eq(page.downloads[0].filename, "MA_1_2.pdf");
    eq(calls[0].url, `${RECON}/api/doclink/downloads?from=2026-10-16&to=2026-10-22&doc_type=ma&destination=ecm&limit=50&offset=50`);
    eq(calls[0].init.method, "GET");
    eq(calls[0].init.credentials, "include");
    eq(calls[0].init.body, undefined, "a GET has no body");
    await listDownloads({ all: true }, { fetch });
    eq(calls[1].url, `${RECON}/api/doclink/downloads?all=true&limit=50`);
    await listDownloads({ destination: "ecm", site: "rohtak" }, { fetch });
    eq(calls[2].url, `${RECON}/api/doclink/downloads?destination=ecm&site=rohtak&limit=50`, "Location: ECM - Rohtak");

    const code = async (status) => {
      try {
        await listDownloads({}, { fetch: async () => json(status, { detail: { error: "X", detail: "no" } }) });
      } catch (error) {
        return error.code;
      }
      return "resolved";
    };
    eq(await code(401), "RECON_AUTH_REQUIRED");
    eq(await code(403), "FORBIDDEN");
    eq(await code(500), "DOWNLOAD_LOG_UNAVAILABLE");
    eq(DOC_TYPE_LABEL.tender_nit, "Tender NIT");
  });

  eq(LOG_DESTINATION.S3, "s3");
}

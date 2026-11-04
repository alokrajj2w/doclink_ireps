/**
 * Tests for the direct ECM upload (config.json "ecmBackendAws": false): DocLink calls the
 * ECM (Nuxeo) REST API itself (services/ecm-direct.js) with the folders of
 * services/ecm-catalog.js. A fake Nuxeo answers the token, NXQL search, batch upload and
 * create calls and records them - request shapes, the spec's queries, token reuse and
 * refresh, deduplication, folder routing for every kind and site, PROD path lookup, every
 * error path, the config.local.json merge and the gateway / direct switch. No extension
 * APIs are used. Invoked from run-tests.js.
 */

import { uploadToEcm, saveToEcmOrLocally, describeEcmOutcome, EcmError, ECM_ERROR, ECM_KIND, ECM_OUTCOME } from "../services/ecm-service.js";
import { uploadToNuxeo, buildEcmQuery, existingDocumentQuery, groupDocumentQuery, fileXpath, nxqlLiteral, searchEcm, resetEcmDirectState, oldFileName } from "../services/ecm-direct.js";
import { applyEcmConfig, mergeConfig, ECM_CONFIG, isDirectEcm } from "../services/ecm-config.js";
import { ECM_KINDS, ECM_SITES, routeSite } from "../services/ecm-catalog.js";
import { applyReconConfig } from "../services/recon-service.js";

const DOMAIN = "http://ecm.test:8080";
const HOSTS = ["http://localhost:8000/*", "http://ecm.test:8080/*"];
const CONFIG = { ecmBackendAws: false, ecm: { env: "TEST", domain: `${DOMAIN}/`, clientId: "id-1", clientSecret: "s3cret" } };
const HOSUR = { irepsAccountId: "833", operatingUnit: "HOSUR" };
const ROHTAK = { irepsAccountId: "60828", operatingUnit: "BRH" };
const IC = {
  kind: ECM_KIND.INSPECTION_CERTIFICATE,
  bytes: new Uint8Array([37, 80, 68, 70, 45]),
  filename: "IC_27253922100240_001_6038184070.pdf",
  fields: { ic_number: "3480517", customer_po_number: "27253922100240", ic_date: "12/05/2026" },
  account: HOSUR
};
const API = `${DOMAIN}/nuxeo/api/v1`;

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * A fake Nuxeo. Records every call as { method, url, path, query, headers, body }.
 *   existing      entries the dedup search finds; each is also a stored document whose main
 *                 file is `file` (default "f.pdf", 5 bytes) with attachments `files`
 *                 (names, or { name, damaged: true })
 *   folders       path -> uid for `ecm:path = ` lookups
 *   respond(call) optional override: return a Response to answer a call yourself
 *   damaged       uid -> how many bytes of that document's main file the ECM can really serve
 *                 (the record keeps the uploaded length, as on the TEST ECM); for an existing
 *                 document or one created here
 *   damagedOnPut  uid -> the same for the main file a PUT stores
 *   damagedOnAttach uid -> the same for a file Blob.AttachOnDocument adds to that document
 *   trashFails    uids whose Document.Trash the ECM refuses (fn.trashed lists the ones trashed)
 * GET /id/{uid} opens a catalog folder (ECM_SITES) or a stored document (its file:content and
 * files:files); /@blob/<xpath> serves one of its files; PUT /id/{uid} sets them from the batch;
 * POST /upload/{batch}/0/execute/Blob.AttachOnDocument appends the batch file to files:files.
 */
const FOLDER_PATHS = Object.fromEntries(Object.values(ECM_SITES).flatMap((sites) => Object.values(sites).flatMap((site) => Object.entries(site.folderIds).map(([location, uid]) => [uid, site.locations[location]]))));
function fakeNuxeo({ existing = [], folders = {}, respond, damaged = {}, damagedOnPut = {}, damagedOnAttach = {}, trashFails = [] } = {}) {
  const calls = [];
  const trashed = [];
  let tokens = 0;
  let docs = 0;
  const batch = {}; // upload-fileId -> { name, length }
  const record = (name, length, served) => ({ name, length, served: served ?? length });
  // uid -> { main: record, files: record[] }
  const stored = new Map(existing.map((e) => [e.uid, {
    main: record(e.file || "f.pdf", 5, damaged[e.uid]),
    files: (e.files || []).map((f) => (typeof f === "string" ? record(f, 4) : record(f.name, 4, f.damaged ? 1 : undefined)))
  }]));
  const fromBatch = (ref) => ({ ...batch[ref["upload-fileId"]] });
  const json = (r) => ({ name: r.name, "mime-type": "application/pdf", length: String(r.length) });
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    const call = { method: init.method || "GET", url: String(url), path: u.pathname, query: u.searchParams.get("query"), headers: init.headers || {}, body: init.body, credentials: init.credentials };
    calls.push(call);
    const own = respond && respond(call, calls);
    if (own) return own;
    if (call.path === "/nuxeo/oauth2/token") return jsonResponse(200, { access_token: `tok-${++tokens}`, expires_in: 3600, token_type: "bearer" });
    if (call.path === "/nuxeo/api/v1/search/lang/NXQL/execute") {
      const byPath = /^SELECT \* FROM Document WHERE ecm:path = '(.*)'$/.exec(call.query);
      if (byPath) return jsonResponse(200, { entries: folders[byPath[1]] ? [{ uid: folders[byPath[1]], path: byPath[1] }] : [], isNextPageAvailable: false });
      return jsonResponse(200, { entries: existing, isNextPageAvailable: false });
    }
    if (call.path === "/nuxeo/api/v1/upload") return jsonResponse(201, { batchId: "batch-1" });
    if (call.path.endsWith("/execute/Blob.AttachOnDocument")) {
      const { document: uid, xpath, save } = JSON.parse(call.body).params;
      const doc = stored.get(uid);
      if (!doc || xpath !== "files:files" || save !== true) return jsonResponse(404, { "entity-type": "exception", status: 404, message: `${uid} ${xpath}` });
      // /nuxeo/api/v1/upload/{batchId}/{fileId}/execute/Blob.AttachOnDocument
      const file = fromBatch({ "upload-fileId": call.path.split("/")[6] });
      doc.files.push(record(file.name, file.length, damagedOnAttach[uid]));
      // the operation answers with the attached file itself
      return new Response(new Uint8Array(file.length), { status: 200, headers: { "Content-Type": "application/pdf" } });
    }
    if (call.path.startsWith("/nuxeo/api/v1/upload/")) {
      const fileId = call.path.split("/").pop();
      batch[fileId] = { name: decodeURIComponent(call.headers["X-File-Name"] || ""), length: call.body ? call.body.length : 0 };
      return jsonResponse(201, { uploaded: "true", fileIdx: fileId });
    }
    if (call.path.startsWith("/nuxeo/api/v1/id/") && call.method === "GET") {
      const [uid, xpath] = decodeURIComponent(call.path.slice("/nuxeo/api/v1/id/".length)).split("/@blob/");
      const doc = stored.get(uid);
      if (doc && xpath) {
        const index = /^files:files\/(\d+)\/file$/.exec(xpath);
        const file = xpath === "file:content" ? doc.main : index ? doc.files[Number(index[1])] : null;
        if (!file) return jsonResponse(404, { "entity-type": "exception", status: 404, message: xpath });
        const start = Number((/^bytes=(\d+)-$/.exec(call.headers.Range || "") || [])[1] ?? 0);
        // past the real end the ECM answers its error page ("Failed to skip in stream")
        if (start >= file.served) return new Response("<html><title>An error occurred.</title></html>", { status: 500, headers: { "Content-Type": "text/html" } });
        // the TEST ECM answers a range with 200 (not 206) and just the bytes asked for; a whole
        // damaged file breaks off at its real end
        return new Response(new Uint8Array(file.served - start), { status: 200, headers: { "Content-Type": "application/pdf" } });
      }
      if (doc) return jsonResponse(200, { "entity-type": "document", uid, path: `/x/${uid}`, title: `T ${uid}`, properties: { "file:content": json(doc.main), "files:files": doc.files.map((f) => ({ file: json(f) })) } });
      if (FOLDER_PATHS[uid]) return jsonResponse(200, { "entity-type": "document", uid, path: FOLDER_PATHS[uid], type: "Folder" });
      return jsonResponse(404, { "entity-type": "exception", status: 404, message: uid });
    }
    if (call.method === "POST" && call.path.endsWith("/@op/Document.Trash")) {
      const uid = decodeURIComponent(call.path.slice("/nuxeo/api/v1/id/".length, -"/@op/Document.Trash".length));
      if (trashFails.includes(uid)) return jsonResponse(500, { "entity-type": "exception", status: 500, message: "trash failed" });
      trashed.push(uid);
      return jsonResponse(200, { "entity-type": "document", uid, isTrashed: true });
    }
    if (call.method === "PUT" && call.path.startsWith("/nuxeo/api/v1/id/")) {
      const uid = decodeURIComponent(call.path.slice("/nuxeo/api/v1/id/".length));
      const doc = stored.get(uid);
      if (!doc) return jsonResponse(404, { "entity-type": "exception", status: 404, message: uid });
      const props = JSON.parse(call.body).properties;
      if (props["file:content"]) {
        const main = fromBatch(props["file:content"]);
        doc.main = record(main.name, main.length, damagedOnPut[uid]);
      }
      if (props["files:files"]) doc.files = props["files:files"].map((e) => { const f = fromBatch(e.file); return record(f.name, f.length); });
      return jsonResponse(200, { "entity-type": "document", uid, path: `/x/${uid}`, title: `T ${uid}` });
    }
    if (call.path.startsWith("/nuxeo/api/v1/id/")) {
      const body = JSON.parse(call.body);
      docs += 1;
      const main = fromBatch(body.properties["file:content"]);
      stored.set(`doc-${docs}`, { main: record(main.name, main.length, damaged[`doc-${docs}`]), files: [] });
      return jsonResponse(201, { "entity-type": "document", uid: `doc-${docs}`, path: `/x/${body.name}`, title: body.properties["dc:title"], type: body.type });
    }
    return jsonResponse(404, { "entity-type": "exception", status: 404, message: `no route ${call.path}` });
  };
  fn.calls = calls;
  fn.trashed = trashed;
  fn.stored = stored;
  fn.of = (pathStart) => calls.filter((c) => c.path.startsWith(pathStart));
  fn.creates = () => calls.filter((c) => c.method === "POST" && c.path.startsWith("/nuxeo/api/v1/id/") && !c.path.includes("/@op/"));
  return fn;
}

export async function runEcmDirectTests({ test, assert, eq }) {
  async function rejectsEcm(promise, code, message) {
    try {
      await promise;
    } catch (error) {
      assert(error instanceof EcmError, `${message || "expected EcmError"}: got ${error && error.stack}`);
      eq(error.code, code, message || "error code");
      return error;
    }
    throw new Error(`${message || "expected rejection"}: promise resolved`);
  }
  function fresh(config = CONFIG) {
    resetEcmDirectState();
    applyEcmConfig(config);
  }

  await test("ECM direct: token, dedup search, batch upload and create in the TEST Hosur Inputs folder", async () => {
    fresh();
    const fetch = fakeNuxeo();
    const result = await uploadToNuxeo(IC, { fetch, hostPermissions: HOSTS });
    eq(fetch.calls.map((c) => `${c.method} ${c.path}`).join(" | "), [
      "POST /nuxeo/oauth2/token",
      "GET /nuxeo/api/v1/id/d440070d-3a60-4ad7-bf67-8efeb198e26b",
      "GET /nuxeo/api/v1/search/lang/NXQL/execute",
      "POST /nuxeo/api/v1/upload",
      "POST /nuxeo/api/v1/upload/batch-1/0",
      "POST /nuxeo/api/v1/id/d440070d-3a60-4ad7-bf67-8efeb198e26b",
      "GET /nuxeo/api/v1/id/doc-1",
      "GET /nuxeo/api/v1/id/doc-1/@blob/file:content"
    ].join(" | "), "the ECM_API_DOC flow, straight to the Inputs folder id (opened first), then the stored file read back");

    const [token, , search, , file, create, , readBack] = fetch.calls;
    eq(token.url, `${DOMAIN}/nuxeo/oauth2/token?grant_type=client_credentials&client_id=id-1&client_secret=s3cret`, "client credentials grant");
    assert(fetch.calls.slice(1).every((c) => c.headers.Authorization === "Bearer tok-1"), "every API call carries the bearer token");
    assert(fetch.calls.every((c) => c.credentials === "omit"), "no cookies are sent to the ECM");
    eq(search.headers.Properties, "*");
    eq(search.query, "SELECT * FROM Document WHERE ecm:isVersion = 0 AND ecm:isTrashed = 0 AND InvoiceCertificateSchema:type = 'inspectionCertificate' AND ecm:parentId = 'd440070d-3a60-4ad7-bf67-8efeb198e26b' AND dc:title = '3480517 - IC' AND file:content/name = 'IC_27253922100240_001_6038184070.pdf' AND InvoiceCertificateSchema:icNumber = '3480517' AND InvoiceCertificateSchema:customerPONumber = '27253922100240'", "dedup query: same kind, folder, title, file name and metadata, dates left out (the ECM answers 400 to icDate = '...')");
    eq(file.headers["X-File-Name"], IC.filename);
    eq(file.headers["X-File-Type"], "application/pdf");
    eq(file.body, IC.bytes, "the PDF bytes as they are");
    eq(create.headers["Content-Type"], "application/json");
    eq(create.body, JSON.stringify({
      "entity-type": "document",
      name: "3480517 - IC",
      type: "InvoiceCertificate",
      properties: {
        "dc:title": "3480517 - IC",
        "InvoiceCertificateSchema:type": "inspectionCertificate",
        "InvoiceCertificateSchema:icNumber": "3480517",
        "InvoiceCertificateSchema:customerPONumber": "27253922100240",
        "InvoiceCertificateSchema:icDate": "2026-05-12",
        "file:content": { "upload-batch": "batch-1", "upload-fileId": "0" }
      }
    }), "the spec's document JSON: title = \"<IC number> - IC\", metadata, file from the batch");
    eq(readBack.headers.Range, `bytes=${IC.bytes.length - 1}-`, "only the last byte is read back");
    eq(JSON.stringify(result), JSON.stringify({ uid: "doc-1", path: "/x/3480517 - IC", title: "3480517 - IC", site: "hosur", deduplicated: false }), "same answer as the gateway");
  });

  await test("ECM direct: a document the ECM cannot serve in full is ECM_FILE_DAMAGED (new or found by dedup) and saved locally", async () => {
    // TEST ECM, 30/10/2026: IC 6709630 recorded as 63238 bytes, file readable only to byte 61980
    fresh();
    const fresh1 = fakeNuxeo({ damaged: { "doc-1": 3 } });
    const error = await rejectsEcm(uploadToNuxeo(IC, { fetch: fresh1, hostPermissions: HOSTS }), ECM_ERROR.DAMAGED);
    eq(error.detail, "document doc-1: the record says 5 bytes but the file cannot be read to its end (HTTP 500)");
    eq(fresh1.trashed.join(), "doc-1", "DocLink's own damaged copy is moved to the trash, not left in the folder");

    fresh();
    const old = fakeNuxeo({ existing: [{ uid: "old-1", path: "/FT/x/3480517", title: "3480517" }], damaged: { "old-1": 0 } });
    await rejectsEcm(uploadToNuxeo(IC, { fetch: old, hostPermissions: HOSTS }), ECM_ERROR.DAMAGED, "a damaged earlier copy is not reported as already stored");
    eq(old.creates().length, 0, "nor replaced");
    eq(old.trashed.length, 0, "and not trashed: only a download again replaces a copy");

    fresh();
    let localSaves = 0;
    const result = await saveToEcmOrLocally(IC, async () => ({ downloadId: ++localSaves, filename: "x.pdf" }), { fetch: fakeNuxeo({ damaged: { "doc-1": 3 } }), hostPermissions: HOSTS });
    eq(result.ecm.status, ECM_OUTCOME.FAILED);
    eq(result.ecm.code, ECM_ERROR.DAMAGED);
    eq(localSaves, 1, "saved locally instead");
  });

  await test("ECM direct: download again puts the new PDF in the existing document; the healthy old one stays in it as _old", async () => {
    fresh();
    const MAIN = "PO1_MODIFICATIONADVISE.pdf";
    const fetch = fakeNuxeo({ existing: [{ uid: "old-1", file: MAIN }, { uid: "old-2" }, { uid: "old-3" }], damaged: { "old-3": 2 } });
    const result = await uploadToNuxeo({ ...IC, replace: ["old-1", "old-2", "old-3", "old-1"] }, { fetch, hostPermissions: HOSTS });
    eq(fetch.calls.map((c) => `${c.method} ${c.path.replace("/nuxeo/api/v1", "")}${c.headers.Range ? " (last byte)" : ""}`).join(" | "), [
      "POST /nuxeo/oauth2/token",
      "GET /id/d440070d-3a60-4ad7-bf67-8efeb198e26b",
      "GET /id/old-1",
      "GET /id/old-1/@blob/file:content",
      "POST /upload",
      "POST /upload/batch-1/0",
      "POST /upload/batch-1/1",
      "PUT /id/old-1",
      "GET /id/old-1",
      "GET /id/old-1/@blob/file:content (last byte)",
      "GET /id/old-1",
      "GET /id/old-1/@blob/files:files/0/file (last byte)",
      "GET /id/old-2",
      "GET /id/old-2/@blob/file:content (last byte)",
      "GET /id/old-3",
      "GET /id/old-3/@blob/file:content (last byte)",
      "POST /id/old-3/@op/Document.Trash"
    ].join(" | "), "old PDF read, both files uploaded, one update, both read back; a further damaged copy to the trash, a healthy one left");
    eq(fetch.creates().length, 0, "no new document");
    eq(fetch.of("/nuxeo/api/v1/search/").length, 0, "no duplicate check");
    const [newFile, oldFile] = fetch.of("/nuxeo/api/v1/upload/");
    eq(newFile.headers["X-File-Name"], MAIN, "the new PDF keeps the document's file name");
    eq(newFile.body, IC.bytes);
    eq(oldFile.headers["X-File-Name"], "PO1_MODIFICATIONADVISE_old.pdf");
    eq(oldFile.body.length, 5, "the old PDF as the ECM served it");
    const put = fetch.calls.find((c) => c.method === "PUT");
    eq(put.body, JSON.stringify({ "entity-type": "document", properties: { "file:content": { "upload-batch": "batch-1", "upload-fileId": "0" }, "files:files": [{ file: { "upload-batch": "batch-1", "upload-fileId": "1" } }] } }), "only the files change: no title or metadata");
    eq(fetch.stored.get("old-1").files.map((f) => f.name).join(), "PO1_MODIFICATIONADVISE_old.pdf");
    eq(fetch.trashed.join(), "old-3");
    eq(JSON.stringify(result), JSON.stringify({ uid: "old-1", path: "/x/old-1", title: "T old-1", site: "hosur", deduplicated: false, replaced: { oldFile: "PO1_MODIFICATIONADVISE_old.pdf", oldDamaged: false, oldFileReadable: true, trashed: ["old-3"] } }));

    fresh();
    const saved = await saveToEcmOrLocally({ ...IC, replace: ["old-1"] }, async () => { throw new Error("no local save"); }, { fetch: fakeNuxeo({ existing: [{ uid: "old-1", file: MAIN }] }), hostPermissions: HOSTS });
    eq(saved.ecm.status, ECM_OUTCOME.STORED);
    eq(saved.ecm.uid, "old-1", "the same document");
    eq(describeEcmOutcome(saved.ecm), "Saved to ECM (Hosur): new PDF in the existing document; the old one is kept in it as PO1_MODIFICATIONADVISE_old.pdf");
  });

  await test("ECM direct: download again over a damaged PDF drops it; attachments already there are kept and _old is not reused", async () => {
    fresh();
    const broken = fakeNuxeo({ existing: [{ uid: "old-1", file: "MA_X_000379.pdf" }], damaged: { "old-1": 2 } });
    const result = await saveToEcmOrLocally({ ...IC, replace: ["old-1"] }, async () => { throw new Error("no local save"); }, { fetch: broken, hostPermissions: HOSTS });
    eq(broken.of("/nuxeo/api/v1/upload/").length, 1, "only the new PDF is uploaded");
    eq(JSON.parse(broken.calls.find((c) => c.method === "PUT").body).properties["files:files"], undefined, "no attachment added");
    eq(broken.stored.get("old-1").main.served, IC.bytes.length, "the document now serves the new PDF in full");
    eq(broken.trashed.length, 0, "the document itself stays");
    eq(describeEcmOutcome(result.ecm), "Saved to ECM (Hosur): new PDF in the existing document (the damaged one was removed)");

    fresh();
    const twice = fakeNuxeo({ existing: [{ uid: "old-1", file: "A.pdf", files: ["A_old.pdf", "note.txt"] }] });
    const again = await uploadToNuxeo({ ...IC, replace: ["old-1"] }, { fetch: twice, hostPermissions: HOSTS });
    eq(twice.of("/nuxeo/api/v1/upload/").map((c) => c.headers["X-File-Name"]).join(), "A.pdf,A_old.pdf,note.txt,A_old_2.pdf", "attachments sent again (a list is replaced whole), the old PDF last");
    eq(twice.stored.get("old-1").files.map((f) => f.name).join(), "A_old.pdf,note.txt,A_old_2.pdf");
    eq(again.replaced.oldFile, "A_old_2.pdf");
  });

  await test("ECM direct: download again changes nothing when the document's files cannot all be read (not damaged: just unreadable now)", async () => {
    fresh();
    const attachment = fakeNuxeo({ existing: [{ uid: "old-1", files: [{ name: "x.pdf", damaged: true }] }] });
    const e1 = await rejectsEcm(uploadToNuxeo({ ...IC, replace: ["old-1"] }, { fetch: attachment, hostPermissions: HOSTS }), ECM_ERROR.UNAVAILABLE);
    eq(e1.detail, "document old-1: its attachment x.pdf could not be read; the document was not changed");

    fresh();
    // the whole file breaks off once, yet its last byte reads: not damaged, so it is not dropped
    const flaky = fakeNuxeo({ existing: [{ uid: "old-1" }], respond: (c) => (c.method === "GET" && c.path.endsWith("/@blob/file:content") && !c.headers.Range ? jsonResponse(503, { message: "busy" }) : null) });
    const e2 = await rejectsEcm(uploadToNuxeo({ ...IC, replace: ["old-1"] }, { fetch: flaky, hostPermissions: HOSTS }), ECM_ERROR.UNAVAILABLE);
    eq(e2.detail, "document old-1: its current file f.pdf could not be read; the document was not changed");
    eq(attachment.calls.concat(flaky.calls).filter((c) => c.method === "PUT" || c.path.startsWith("/nuxeo/api/v1/upload")).length, 0, "nothing uploaded, nothing updated");

    fresh();
    const bad = fakeNuxeo({ existing: [{ uid: "old-1" }], damagedOnPut: { "old-1": 1 } });
    const local = await saveToEcmOrLocally({ ...IC, replace: ["old-1"] }, async () => ({ downloadId: 7, filename: "x.pdf" }), { fetch: bad, hostPermissions: HOSTS });
    eq(local.ecm.code, ECM_ERROR.DAMAGED, "a new PDF the ECM damaged: saved locally");
    eq(bad.stored.get("old-1").files.map((f) => f.name).join(), "f_old.pdf", "the old PDF is still in the document");
    eq(oldFileName("LC1_MODIFICATIONADVISE.pdf"), "LC1_MODIFICATIONADVISE_old.pdf");
    eq(oldFileName("noext", ["noext_old"]), "noext_old_2");
  });

  await test("ECM switch: uploads run one at a time even when the caller starts several together", async () => {
    fresh();
    let open = 0;
    let most = 0;
    const base = fakeNuxeo();
    const fetch = async (url, init) => {
      open += 1;
      most = Math.max(most, open);
      await new Promise((resolve) => setTimeout(resolve, 1));
      try {
        return await base(url, init);
      } finally {
        open -= 1;
      }
    };
    fetch.calls = base.calls;
    const results = await Promise.allSettled([
      uploadToEcm(IC, { fetch, hostPermissions: HOSTS }),
      uploadToEcm({ ...IC, account: {} }, { fetch, hostPermissions: HOSTS }),
      uploadToEcm({ ...IC, filename: "b.pdf" }, { fetch, hostPermissions: HOSTS }),
      uploadToEcm({ ...IC, filename: "c.pdf" }, { fetch, hostPermissions: HOSTS })
    ]);
    eq(results.map((r) => r.status).join(), "fulfilled,rejected,fulfilled,fulfilled", "a failed upload does not stop the ones after it");
    eq(most, 1, "never two ECM requests at once");
    eq(base.creates().length, 3);
  });

  await test("ECM direct: the token is reused, and a 401 fetches a new one and retries the call once", async () => {
    fresh();
    const fetch = fakeNuxeo();
    await uploadToNuxeo(IC, { fetch, hostPermissions: HOSTS });
    await uploadToNuxeo({ ...IC, filename: "other.pdf" }, { fetch, hostPermissions: HOSTS });
    eq(fetch.of("/nuxeo/oauth2/token").length, 1, "one token for both uploads");

    fresh();
    let rejectedOnce = false;
    const expiring = fakeNuxeo({
      respond: (call) => {
        if (call.path === "/nuxeo/api/v1/upload" && !rejectedOnce) {
          rejectedOnce = true;
          return jsonResponse(401, { message: "token expired" });
        }
        return null;
      }
    });
    const result = await uploadToNuxeo(IC, { fetch: expiring, hostPermissions: HOSTS });
    eq(result.uid, "doc-1");
    eq(expiring.of("/nuxeo/oauth2/token").length, 2, "a new token after the 401");
    eq(expiring.calls.filter((c) => c.path === "/nuxeo/api/v1/upload").length, 2, "the refused call is retried once");
    eq(expiring.calls.filter((c) => c.path === "/nuxeo/api/v1/upload")[1].headers.Authorization, "Bearer tok-2");
  });

  await test("ECM direct: a document already in the folder is not stored again (deduplicated)", async () => {
    fresh();
    const fetch = fakeNuxeo({ existing: [{ uid: "old-1", path: "/FT/x/3480517", title: "3480517" }] });
    const result = await uploadToNuxeo(IC, { fetch, hostPermissions: HOSTS });
    eq(JSON.stringify(result), JSON.stringify({ uid: "old-1", path: "/FT/x/3480517", title: "3480517", site: "hosur", deduplicated: true }));
    eq(fetch.of("/nuxeo/api/v1/upload").length, 0, "nothing uploaded");
    eq(fetch.creates().length, 0, "nothing created");
  });

  await test("ECM direct: a supplied folder is opened once; one the ECM cannot open is refused by name before any search", async () => {
    fresh();
    const fetch = fakeNuxeo();
    await uploadToNuxeo(IC, { fetch, hostPermissions: HOSTS });
    await uploadToNuxeo({ ...IC, filename: "other.pdf" }, { fetch, hostPermissions: HOSTS });
    eq(fetch.calls.filter((c) => c.method === "GET" && c.path === "/nuxeo/api/v1/id/d440070d-3a60-4ad7-bf67-8efeb198e26b").length, 1, "the folder is opened once");

    fresh();
    const tenders = ECM_SITES.TEST.hosur.folderIds.tenders;
    // the TEST ECM's answer on 26/10/2026: the Tenders folder's type is no longer deployed
    const gone = fakeNuxeo({ respond: (c) => (c.method === "GET" && c.path === `/nuxeo/api/v1/id/${tenders}` ? jsonResponse(404, { "entity-type": "exception", status: 404, message: tenders }) : null) });
    const error = await rejectsEcm(uploadToNuxeo({ ...IC, kind: ECM_KIND.LOI, fields: { tender_number: "T-1" } }, { fetch: gone, hostPermissions: HOSTS }), ECM_ERROR.REJECTED);
    eq(error.detail, `the Hosur tenders folder /FT/workspaces/Sites/HSR/Invoice Certificate - TS/Tenders (uid ${tenders}) cannot be opened on the ECM: HTTP 404 - ${tenders}`);
    eq(gone.of("/nuxeo/api/v1/search/").length + gone.of("/nuxeo/api/v1/upload").length + gone.creates().length, 0, "nothing searched, uploaded or created");
  });

  await test("ECM direct: every DocLink kind goes to its TEST folder in Hosur and Rohtak, with the right type and title", async () => {
    const FIELDS = {
      inspectionCertificate: { ic_number: "1", customer_po_number: "PO-1" },
      poCopy: { customer_po_number: "PO-1" },
      modificationAdvise: { customer_po_number: "PO-1", modification_advise_number: "MA-1" },
    };
    const TITLES = { inspectionCertificate: "1 - IC", poCopy: "PO-1 - PO", modificationAdvise: "MA-1 - MA", nit: "T-1 - NIT", nbsp: "T-1 - NBSP", extension: "T-1 - Extension", crp: "T-1 - CRP", co: "T-1 - CO", loi: "T-1 - LOA", tenderResult: "T-1 - Result", vft: "T-1 - Financial Tabulation", vct: "T-1 - Commercial Tabulation" };
    eq(Object.keys(ECM_KINDS).sort().join(), Object.values(ECM_KIND).sort().join(), "the catalog covers every kind DocLink uploads");
    for (const [account, siteKey] of [[HOSUR, "hosur"], [ROHTAK, "rohtak"]]) {
      for (const kind of Object.values(ECM_KIND)) {
        fresh();
        const fetch = fakeNuxeo();
        const result = await uploadToNuxeo({ ...IC, kind, account, fields: FIELDS[kind] || { tender_number: "T-1" } }, { fetch, hostPermissions: HOSTS });
        const location = ECM_KINDS[kind].location;
        const [create] = fetch.creates();
        eq(create.path, `/nuxeo/api/v1/id/${ECM_SITES.TEST[siteKey].folderIds[location]}`, `${kind} -> ${siteKey} ${location}`);
        const props = JSON.parse(create.body).properties;
        eq(props["InvoiceCertificateSchema:type"], kind);
        eq(props["dc:title"], TITLES[kind], `${kind} title template`);
        eq(result.site, siteKey);
      }
    }
  });

  // A tender's grouped document ("<T> - NIT") already in the Hosur Tenders folder, without a tender date.
  const groupDoc = (title = "T-1 - NIT", main = "NIT_T-1.pdf", files = ["Attachment_01_A.pdf"]) => ({
    uid: "g-1", title, file: main, files,
    properties: {
      "dc:title": title, "InvoiceCertificateSchema:type": "nit", "InvoiceCertificateSchema:tenderNumber": "T-1",
      "file:content": { name: main, length: "5" }, "files:files": files.map((name) => ({ file: { name, length: "4" } }))
    }
  });
  const NIT_PDF = (filename) => ({ ...IC, kind: ECM_KIND.NIT, filename, title: "T-1 - NIT", fields: { tender_number: "T-1", tender_date: "09/11/2026" } });

  await test("ECM direct: NIT, LOA and Result are one document per tender: the first PDF creates it, a later one is attached to it", async () => {
    fresh();
    const empty = fakeNuxeo();
    const first = await uploadToNuxeo(NIT_PDF("NIT_T-1.pdf"), { fetch: empty, hostPermissions: HOSTS });
    eq(empty.creates().length, 1, "no document yet: created, the PDF as its main file");
    eq(JSON.parse(empty.creates()[0].body).properties["dc:title"], "T-1 - NIT");
    eq(first.deduplicated, false);
    const lookup = empty.calls.find((c) => c.query && c.query.includes("dc:title"));
    eq(lookup.query, groupDocumentQuery({ kind: "nit", folderUid: ECM_SITES.TEST.hosur.folderIds.tenders, title: "T-1 - NIT", values: { tender_number: "T-1", tender_date: "2026-11-09" } }));
    assert(!lookup.query.includes("file:content/name") && !lookup.query.includes("tenderDate") && lookup.query.endsWith("ORDER BY dc:created ASC"), `found by type, folder, title and tender number, oldest first: ${lookup.query}`);

    fresh();
    const fetch = fakeNuxeo({ existing: [groupDoc()] });
    const added = await uploadToNuxeo(NIT_PDF("Attachment_02_B.pdf"), { fetch, hostPermissions: HOSTS });
    eq(JSON.stringify([added.uid, added.deduplicated]), JSON.stringify(["g-1", false]));
    eq(fetch.creates().length, 0, "no new document");
    const attach = fetch.calls.filter((c) => c.path.endsWith("/execute/Blob.AttachOnDocument"));
    eq(attach.length, 1);
    eq(attach[0].path, "/nuxeo/api/v1/upload/batch-1/0/execute/Blob.AttachOnDocument");
    eq(JSON.stringify(JSON.parse(attach[0].body).params), JSON.stringify({ document: "g-1", xpath: "files:files", save: true }));
    eq(fetch.stored.get("g-1").files.map((f) => f.name).join(), "Attachment_01_A.pdf,Attachment_02_B.pdf", "appended, the other files not re-sent");
    eq(fetch.of("/nuxeo/api/v1/upload/batch-1/").filter((c) => !c.path.includes("/execute/")).length, 1, "only the new PDF is uploaded");
    // the tender date the document lacked is filled in; nothing else is changed
    const puts = fetch.calls.filter((c) => c.method === "PUT");
    eq(puts.length, 1);
    eq(JSON.stringify(JSON.parse(puts[0].body).properties), JSON.stringify({ "InvoiceCertificateSchema:tenderDate": "2026-11-09" }));
    // the new attachment is read back to its last byte
    assert(fetch.calls.some((c) => c.path === "/nuxeo/api/v1/id/g-1/@blob/files:files/1/file" && c.headers.Range), "files:files/1 read back");
  });

  await test("ECM direct: a PDF already in the tender's document (main file or attachment, by name) is not added again", async () => {
    for (const name of ["NIT_T-1.pdf", "Attachment_01_A.pdf"]) {
      fresh();
      const fetch = fakeNuxeo({ existing: [groupDoc()] });
      const result = await uploadToNuxeo(NIT_PDF(name), { fetch, hostPermissions: HOSTS });
      eq(JSON.stringify([result.uid, result.deduplicated]), JSON.stringify(["g-1", true]), name);
      eq(fetch.calls.filter((c) => c.method === "POST" && c.path.includes("/upload")).length, 0, `${name}: nothing uploaded`);
      eq(fetch.calls.filter((c) => c.method === "PUT").length, 0, `${name}: the document is not changed`);
    }
    eq(fileXpath(groupDoc().properties, "NIT_T-1.pdf"), "file:content");
    eq(fileXpath(groupDoc().properties, "Attachment_01_A.pdf"), "files:files/0/file");
    eq(fileXpath(groupDoc().properties, "other.pdf"), null);
  });

  await test("ECM direct: an attachment the ECM cannot serve in full is ECM_FILE_DAMAGED (the caller saves it locally); a failed date fill does not undo the attach", async () => {
    fresh();
    const fetch = fakeNuxeo({ existing: [groupDoc()], damagedOnAttach: { "g-1": 1 } });
    await rejectsEcm(uploadToNuxeo(NIT_PDF("Attachment_02_B.pdf"), { fetch, hostPermissions: HOSTS }), ECM_ERROR.DAMAGED);
    eq(fetch.trashed.length, 0, "the tender's document is never trashed");

    fresh();
    const failingPut = fakeNuxeo({ existing: [groupDoc()], respond: (call) => (call.method === "PUT" ? jsonResponse(500, { message: "no" }) : null) });
    const result = await uploadToNuxeo(NIT_PDF("Attachment_02_B.pdf"), { fetch: failingPut, hostPermissions: HOSTS });
    eq(JSON.stringify([result.uid, result.deduplicated]), JSON.stringify(["g-1", false]), "stored: the PDF is in the document");
  });

  await test("ECM gateway: NIT, LOA and Result need the direct upload; the gateway is not called and the PDF is saved locally", async () => {
    fresh({ ...CONFIG, ecmBackendAws: true });
    applyReconConfig({ reconBaseUrl: "http://localhost:8000" });
    const gateway = fakeNuxeo();
    for (const kind of [ECM_KIND.NIT, ECM_KIND.LOI, ECM_KIND.TENDER_RESULT]) {
      let local = 0;
      const { ecm } = await saveToEcmOrLocally({ ...IC, kind, fields: { tender_number: "T-1" } }, async () => { local += 1; return { relPath: "x.pdf" }; }, { fetch: gateway, hostPermissions: HOSTS });
      eq(JSON.stringify([ecm.status, ecm.code, local]), JSON.stringify([ECM_OUTCOME.FAILED, ECM_ERROR.REJECTED, 1]), kind);
      assert(/need the direct ECM upload/.test(ecm.detail), ecm.detail);
    }
    eq(gateway.calls.length, 0, "nothing sent");
  });

  await test("ECM direct: on PROD the folder path is looked up once; tender kinds have no PROD folder and are refused", async () => {
    fresh({ ...CONFIG, ecm: { ...CONFIG.ecm, env: "PROD" } });
    const inputs = "/FT/workspaces/Sites/HPD/Invoice Certificate/Input";
    const fetch = fakeNuxeo({ folders: { [inputs]: "prod-rohtak-inputs" } });
    await uploadToNuxeo({ ...IC, account: ROHTAK }, { fetch, hostPermissions: HOSTS });
    await uploadToNuxeo({ ...IC, account: ROHTAK, filename: "second.pdf" }, { fetch, hostPermissions: HOSTS });
    const lookups = fetch.calls.filter((c) => c.query && c.query.includes("ecm:path ="));
    eq(lookups.length, 1, "the folder uid is cached");
    eq(lookups[0].query, `SELECT * FROM Document WHERE ecm:path = '${inputs}'`);
    eq(fetch.creates()[0].path, "/nuxeo/api/v1/id/prod-rohtak-inputs");

    const untouched = fakeNuxeo();
    const error = await rejectsEcm(uploadToNuxeo({ ...IC, kind: ECM_KIND.NIT, fields: { tender_number: "T-1" } }, { fetch: untouched, hostPermissions: HOSTS }), ECM_ERROR.REJECTED, "no PROD tenders folder");
    eq(error.detail, "the Hosur site has no tenders folder on PROD, so it cannot hold nit documents");
    eq(untouched.calls.length, 0, "refused before anything is sent");

    const missing = fakeNuxeo();
    await rejectsEcm(uploadToNuxeo(IC, { fetch: missing, hostPermissions: HOSTS }), ECM_ERROR.REJECTED, "a folder path the ECM does not have");
  });

  await test("ECM direct: missing metadata, unknown or conflicting accounts are refused before anything is sent", async () => {
    fresh();
    const untouched = fakeNuxeo();
    const deps = { fetch: untouched, hostPermissions: HOSTS };
    eq((await rejectsEcm(uploadToNuxeo({ ...IC, fields: { ic_number: "1" } }, deps), ECM_ERROR.REJECTED)).detail, "inspectionCertificate requires customer_po_number");
    eq((await rejectsEcm(uploadToNuxeo({ ...IC, fields: { ...IC.fields, tender_number: "T" } }, deps), ECM_ERROR.REJECTED)).detail, "inspectionCertificate has no field tender_number");
    eq((await rejectsEcm(uploadToNuxeo({ ...IC, kind: ECM_KIND.LOI, fields: { tender_number: "T", ic_number: "1" } }, deps), ECM_ERROR.REJECTED)).detail, "loi has no field ic_number", "a field the kind does not list is refused before anything is sent");
    eq((await rejectsEcm(uploadToNuxeo({ ...IC, account: { irepsAccountId: "999" } }, deps), ECM_ERROR.REJECTED)).detail, "no ECM site for IREPS account 999");
    await rejectsEcm(uploadToNuxeo({ ...IC, account: { irepsAccountId: "833", operatingUnit: "ROHTAK" } }, deps), ECM_ERROR.REJECTED, "account and unit disagree");
    await rejectsEcm(uploadToNuxeo({ ...IC, account: {} }, deps), ECM_ERROR.ACCOUNT_UNKNOWN, "no account -> no guess");
    eq(untouched.calls.length, 0, "nothing sent");
    eq(routeSite("TEST", { operatingUnit: "hsr" }), "hosur", "unit names match case-insensitively");
  });

  await test("ECM direct: settings, credentials, network and server errors map to the ECM codes", async () => {
    const untouched = fakeNuxeo();
    fresh({ ...CONFIG, ecm: { ...CONFIG.ecm, clientSecret: "" } });
    eq((await rejectsEcm(uploadToNuxeo(IC, { fetch: untouched, hostPermissions: HOSTS }), ECM_ERROR.NOT_CONFIGURED)).detail, "ecm.clientId / ecm.clientSecret are not set (put them in config.local.json)");
    fresh();
    eq((await rejectsEcm(uploadToNuxeo(IC, { fetch: untouched, hostPermissions: ["http://localhost:8000/*"] }), ECM_ERROR.NOT_CONFIGURED)).detail, "http://ecm.test:8080 is missing from manifest.json host_permissions");
    fresh({ ...CONFIG, ecm: { ...CONFIG.ecm, domain: "" } });
    await rejectsEcm(uploadToNuxeo(IC, { fetch: untouched, hostPermissions: HOSTS }), ECM_ERROR.NOT_CONFIGURED, "no domain");
    eq(untouched.calls.length, 0, "nothing sent without settings");

    fresh();
    const badSecret = fakeNuxeo({ respond: (c) => (c.path === "/nuxeo/oauth2/token" ? jsonResponse(401, { error: "invalid_client" }) : null) });
    eq((await rejectsEcm(uploadToNuxeo(IC, { fetch: badSecret, hostPermissions: HOSTS }), ECM_ERROR.NOT_CONFIGURED)).detail, "the ECM refused the client id / secret");

    fresh();
    await rejectsEcm(uploadToNuxeo(IC, { fetch: async () => { throw new TypeError("Failed to fetch"); }, hostPermissions: HOSTS }), ECM_ERROR.UNAVAILABLE, "network error");

    fresh();
    const denied = fakeNuxeo({ respond: (c) => (c.method === "POST" && c.path.startsWith("/nuxeo/api/v1/id/") ? jsonResponse(403, { message: "Privilege 'AddChildren' is not granted" }) : null) });
    eq((await rejectsEcm(uploadToNuxeo(IC, { fetch: denied, hostPermissions: HOSTS }), ECM_ERROR.REJECTED)).detail, "the ECM denied access (HTTP 403): Privilege 'AddChildren' is not granted");

    fresh();
    const broken = fakeNuxeo({ respond: (c) => (c.path === "/nuxeo/api/v1/upload" ? jsonResponse(500, { message: "boom" }) : null) });
    const down = await rejectsEcm(uploadToNuxeo(IC, { fetch: broken, hostPermissions: HOSTS }), ECM_ERROR.UNAVAILABLE, "HTTP 500");
    eq(down.detail, "POST /upload: HTTP 500 - boom");
    eq(down.status, 500);
  });

  await test("ECM direct: the spec's search queries (type + site ancestor), as the gateway builds them", async () => {
    fresh();
    eq(buildEcmQuery({ site: "hosur", kind: "inspectionCertificate" }),
      "SELECT * FROM Document WHERE ecm:isVersion = 0 AND ecm:isTrashed = 0 AND InvoiceCertificateSchema:type = 'inspectionCertificate' AND ecm:ancestorId = 'ad5090e5-648d-4f75-8c14-7052e8ac3b72' ORDER BY dc:created DESC");
    eq(buildEcmQuery({ env: "TEST", site: "rohtak", kind: "nit" }),
      "SELECT * FROM Document WHERE ecm:isVersion = 0 AND ecm:isTrashed = 0 AND InvoiceCertificateSchema:type = 'nit' AND ecm:ancestorId = '34a61f51-10fe-44ce-a669-2ea14dc86ff4' ORDER BY dc:created DESC");
    eq(buildEcmQuery({ env: "PROD", site: "hosur", kind: "poCopy", filters: { customer_po_number: "PO-1", ic_number: "" } }),
      "SELECT * FROM Document WHERE ecm:isVersion = 0 AND ecm:isTrashed = 0 AND InvoiceCertificateSchema:type = 'poCopy' AND ecm:ancestorId = '7dfe3fc0-3157-489d-826a-9435e65631fc' AND InvoiceCertificateSchema:customerPONumber = 'PO-1' ORDER BY dc:created DESC");
    eq(buildEcmQuery({ site: "hosur", kind: "inspectionCertificate", filters: { ic_date: "09/11/2026" } }).includes("(InvoiceCertificateSchema:icDate >= TIMESTAMP '2026-11-08T18:30:00.000Z' AND InvoiceCertificateSchema:icDate < TIMESTAMP '2026-11-09T18:30:00.000Z')"), true, "a date filter is the IST day as a timestamp range (a plain string is an invalid query)");
    eq(buildEcmQuery({ env: "PROD", site: "rohtak", kind: "modificationAdvise" }).includes("ecm:ancestorId = 'f2a5bf87-877b-4e4c-b4fc-7301cabfd236'"), true);
    eq(nxqlLiteral("O'Brien \\ x"), "'O\\'Brien \\\\ x'", "quotes and backslashes escaped");
    eq(nxqlLiteral(true), "1");
    eq(existingDocumentQuery({ kind: "co", folderUid: "f-1", title: "T - CO 1", filename: "a.pdf", values: { tender_number: "T" } }),
      "SELECT * FROM Document WHERE ecm:isVersion = 0 AND ecm:isTrashed = 0 AND InvoiceCertificateSchema:type = 'co' AND ecm:parentId = 'f-1' AND dc:title = 'T - CO 1' AND file:content/name = 'a.pdf' AND InvoiceCertificateSchema:tenderNumber = 'T'");

    let page = 0;
    const paged = fakeNuxeo({ respond: (c) => (c.query ? jsonResponse(200, { entries: [{ uid: `p${page}` }], isNextPageAvailable: ++page < 3 }) : null) });
    const found = await searchEcm(buildEcmQuery({ site: "hosur", kind: "poCopy" }), {}, { fetch: paged, hostPermissions: HOSTS });
    eq(found.map((e) => e.uid).join(), "p0,p1,p2", "every result page is followed");
    eq(new URL(paged.calls[3].url).searchParams.get("currentPageIndex"), "2");
  });

  await test("ECM config: config.local.json overrides config.json; anything but ecmBackendAws: true is direct", async () => {
    const merged = mergeConfig(
      { target: "mock", ecmBackendAws: false, ecm: { env: "TEST", domain: "http://a", clientId: "abc", clientSecret: "abc" } },
      { ecm: { clientId: "real-id", clientSecret: "real-secret" } }
    );
    eq(JSON.stringify(merged), JSON.stringify({ target: "mock", ecmBackendAws: false, ecm: { env: "TEST", domain: "http://a", clientId: "real-id", clientSecret: "real-secret" } }), "ecm merged key by key");
    eq(mergeConfig({ ecmBackendAws: false }, { ecmBackendAws: true }).ecmBackendAws, true, "a top-level key replaces");
    eq(JSON.stringify(mergeConfig({ target: "real" }, null)), JSON.stringify({ target: "real" }), "no local file");

    applyEcmConfig({});
    eq(isDirectEcm(), true, "default: direct");
    eq(ECM_CONFIG.env, "TEST");
    eq(ECM_CONFIG.timeoutMs, 120000);
    applyEcmConfig({ ecmBackendAws: "true", ecm: { env: "prod", domain: "http://x:8080///", timeoutMs: 5000 } });
    eq(isDirectEcm(), true, "only the boolean true selects the gateway");
    eq(ECM_CONFIG.env, "PROD");
    eq(ECM_CONFIG.domain, "http://x:8080");
    eq(ECM_CONFIG.timeoutMs, 5000);
    applyEcmConfig({ ecmBackendAws: true });
    eq(isDirectEcm(), false);
  });

  await test("ECM switch: uploadToEcm goes direct when ecmBackendAws is false and to the gateway when true; a failure is saved locally", async () => {
    fresh();
    const fetch = fakeNuxeo({
      respond: (c) => (c.url.startsWith("http://localhost:8000/") ? jsonResponse(201, { uid: "gw-1", path: "/gw", title: "3480517", site: "hosur", deduplicated: false }) : null)
    });
    applyReconConfig({ reconBaseUrl: "http://localhost:8000" });
    const direct = await uploadToEcm(IC, { fetch, hostPermissions: HOSTS });
    eq(direct.uid, "doc-1", "direct: created in the ECM");
    assert(fetch.calls.every((c) => c.url.startsWith(API) || c.url.startsWith(`${DOMAIN}/nuxeo/oauth2/`)), "direct: only the ECM is called");

    applyEcmConfig({ ...CONFIG, ecmBackendAws: true });
    const before = fetch.calls.length;
    const gateway = await uploadToEcm(IC, { fetch, hostPermissions: HOSTS });
    eq(gateway.uid, "gw-1");
    eq(fetch.calls[before].url, "http://localhost:8000/api/ecm/documents", "gateway: the Recon Engine's ECM API");

    fresh();
    let localSaves = 0;
    const down = await saveToEcmOrLocally(IC, async () => ({ downloadId: ++localSaves, filename: "x.pdf" }), { fetch: async () => { throw new TypeError("Failed to fetch"); }, hostPermissions: HOSTS });
    eq(down.ecm.status, ECM_OUTCOME.FAILED);
    eq(down.ecm.code, ECM_ERROR.UNAVAILABLE);
    eq(localSaves, 1, "nothing is lost: saved locally instead");
  });
}

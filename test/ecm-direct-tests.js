/**
 * Tests for the direct ECM upload (config.json "ecmBackendAws": false): DocLink calls the
 * ECM (Nuxeo) REST API itself (services/ecm-direct.js) with the folders of
 * services/ecm-catalog.js. A fake Nuxeo answers the token, NXQL search, batch upload and
 * create calls and records them - request shapes, the spec's queries, token reuse and
 * refresh, deduplication, folder routing for every kind and site, PROD path lookup, every
 * error path, the config.local.json merge and the gateway / direct switch. No extension
 * APIs are used. Invoked from run-tests.js.
 */

import { uploadToEcm, saveToEcmOrLocally, EcmError, ECM_ERROR, ECM_KIND, ECM_OUTCOME } from "../services/ecm-service.js";
import { uploadToNuxeo, buildEcmQuery, existingDocumentQuery, nxqlLiteral, searchEcm, resetEcmDirectState } from "../services/ecm-direct.js";
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
 *   existing      entries the dedup search finds
 *   folders       path -> uid for `ecm:path = ` lookups
 *   respond(call) optional override: return a Response to answer a call yourself
 */
function fakeNuxeo({ existing = [], folders = {}, respond } = {}) {
  const calls = [];
  let tokens = 0;
  let docs = 0;
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
    if (call.path.startsWith("/nuxeo/api/v1/upload/")) return jsonResponse(201, { uploaded: "true", fileIdx: "0" });
    if (call.path.startsWith("/nuxeo/api/v1/id/")) {
      const body = JSON.parse(call.body);
      docs += 1;
      return jsonResponse(201, { "entity-type": "document", uid: `doc-${docs}`, path: `/x/${body.name}`, title: body.properties["dc:title"], type: body.type });
    }
    return jsonResponse(404, { "entity-type": "exception", status: 404, message: `no route ${call.path}` });
  };
  fn.calls = calls;
  fn.of = (pathStart) => calls.filter((c) => c.path.startsWith(pathStart));
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
      "GET /nuxeo/api/v1/search/lang/NXQL/execute",
      "POST /nuxeo/api/v1/upload",
      "POST /nuxeo/api/v1/upload/batch-1/0",
      "POST /nuxeo/api/v1/id/d440070d-3a60-4ad7-bf67-8efeb198e26b"
    ].join(" | "), "the ECM_API_DOC flow, straight to the Inputs folder id");

    const [token, search, , file, create] = fetch.calls;
    eq(token.url, `${DOMAIN}/nuxeo/oauth2/token?grant_type=client_credentials&client_id=id-1&client_secret=s3cret`, "client credentials grant");
    assert(fetch.calls.slice(1).every((c) => c.headers.Authorization === "Bearer tok-1"), "every API call carries the bearer token");
    assert(fetch.calls.every((c) => c.credentials === "omit"), "no cookies are sent to the ECM");
    eq(search.headers.Properties, "*");
    eq(search.query, "SELECT * FROM Document WHERE ecm:isVersion = 0 AND ecm:isTrashed = 0 AND InvoiceCertificateSchema:type = 'inspectionCertificate' AND ecm:parentId = 'd440070d-3a60-4ad7-bf67-8efeb198e26b' AND dc:title = '3480517' AND file:content/name = 'IC_27253922100240_001_6038184070.pdf' AND InvoiceCertificateSchema:icNumber = '3480517' AND InvoiceCertificateSchema:customerPONumber = '27253922100240'", "dedup query: same kind, folder, title, file name and metadata, dates left out (the ECM answers 400 to icDate = '...')");
    eq(file.headers["X-File-Name"], IC.filename);
    eq(file.headers["X-File-Type"], "application/pdf");
    eq(file.body, IC.bytes, "the PDF bytes as they are");
    eq(create.headers["Content-Type"], "application/json");
    eq(create.body, JSON.stringify({
      "entity-type": "document",
      name: "3480517",
      type: "InvoiceCertificate",
      properties: {
        "dc:title": "3480517",
        "InvoiceCertificateSchema:type": "inspectionCertificate",
        "InvoiceCertificateSchema:icNumber": "3480517",
        "InvoiceCertificateSchema:customerPONumber": "27253922100240",
        "InvoiceCertificateSchema:icDate": "2026-05-12",
        "file:content": { "upload-batch": "batch-1", "upload-fileId": "0" }
      }
    }), "the spec's document JSON: title = IC number, metadata, file from the batch");
    eq(JSON.stringify(result), JSON.stringify({ uid: "doc-1", path: "/x/3480517", title: "3480517", site: "hosur", deduplicated: false }), "same answer as the gateway");
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
    eq(fetch.of("/nuxeo/api/v1/id/").length, 0, "nothing created");
  });

  await test("ECM direct: every DocLink kind goes to its TEST folder in Hosur and Rohtak, with the right type and title", async () => {
    const FIELDS = {
      inspectionCertificate: { ic_number: "1", customer_po_number: "PO-1" },
      poCopy: { customer_po_number: "PO-1" },
      modificationAdvise: { customer_po_number: "PO-1", modification_advise_number: "MA-1" },
      loi: { tender_number: "T-1", loi_number: "L-1", loi_date: "04/10/2026" }
    };
    const TITLES = { inspectionCertificate: "1", poCopy: "PO-1", modificationAdvise: "MA-1" };
    eq(Object.keys(ECM_KINDS).sort().join(), Object.values(ECM_KIND).sort().join(), "the catalog covers every kind DocLink uploads");
    for (const [account, siteKey] of [[HOSUR, "hosur"], [ROHTAK, "rohtak"]]) {
      for (const kind of Object.values(ECM_KIND)) {
        fresh();
        const fetch = fakeNuxeo();
        const result = await uploadToNuxeo({ ...IC, kind, account, fields: FIELDS[kind] || { tender_number: "T-1", tender_date: "09/11/2026" } }, { fetch, hostPermissions: HOSTS });
        const location = ECM_KINDS[kind].location;
        const [create] = fetch.of("/nuxeo/api/v1/id/");
        eq(create.path, `/nuxeo/api/v1/id/${ECM_SITES.TEST[siteKey].folderIds[location]}`, `${kind} -> ${siteKey} ${location}`);
        const props = JSON.parse(create.body).properties;
        eq(props["InvoiceCertificateSchema:type"], kind);
        eq(props["dc:title"], TITLES[kind] || "T-1", `${kind} title template`);
        eq(result.site, siteKey);
      }
    }
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
    eq(fetch.of("/nuxeo/api/v1/id/")[0].path, "/nuxeo/api/v1/id/prod-rohtak-inputs");

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
    const denied = fakeNuxeo({ respond: (c) => (c.path.startsWith("/nuxeo/api/v1/id/") ? jsonResponse(403, { message: "Privilege 'AddChildren' is not granted" }) : null) });
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
    eq(buildEcmQuery({ site: "hosur", kind: "nit", filters: { tender_date: "09/11/2026" } }).includes("(InvoiceCertificateSchema:tenderDate >= TIMESTAMP '2026-11-08T18:30:00.000Z' AND InvoiceCertificateSchema:tenderDate < TIMESTAMP '2026-11-09T18:30:00.000Z')"), true, "a date filter is the IST day as a timestamp range (a plain string is an invalid query)");
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

/**
 * Tests for "Save to: Recon (S3)": the upload of an export file to the Recon
 * Engine's POST /api/documents (services/recon-service.js) with a fake
 * fetch - request shape, response mapping, every error path, and the result
 * panel's ingest line. No extension APIs are used. Invoked from run-tests.js.
 */

import { uploadToRecon, applyReconConfig, describeIngestStats, ReconError, RECON_ERROR, RECON_DOC_TYPE } from "../services/recon-service.js";
import { describeError } from "../utils/messages.js";

const BASE = "http://localhost:8000";
const HOSTS = ["http://localhost:8765/*", "https://www.ireps.gov.in/*", "http://localhost:8000/*"];
const FILE = { docType: RECON_DOC_TYPE.CRN, bytes: new Uint8Array([80, 75, 3, 4]), filename: "IREPS_CRN_2026-10-13_10-00-00.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** A fetch that records its calls and answers with `respond(url, init)`. */
function fakeFetch(respond) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  fn.calls = calls;
  return fn;
}

export async function runReconTests({ test, assert, eq }) {
  async function rejectsRecon(promise, code, message) {
    try {
      await promise;
    } catch (error) {
      assert(error instanceof ReconError, `${message || "expected ReconError"}: got ${error && error.stack}`);
      eq(error.code, code, message || "error code");
      return error;
    }
    throw new Error(`${message || "expected rejection"}: promise resolved`);
  }

  await test("Recon upload: multipart POST /api/documents with the sign-in cookie, response mapped", async () => {
    applyReconConfig({ reconBaseUrl: `${BASE}/`, reconCustomerId: "wabtec" });
    const fetch = fakeFetch(() =>
      jsonResponse(201, {
        bronze_file_id: 7, doc_type: "crn", slot: "lineage_crn", original_name: FILE.filename, size_bytes: 4, sha256: "ab",
        stored_path: "s3://recon-docs/recon/bronze/wabtec/crn/ab.xlsx", deduplicated: false, ingested: true,
        stats: { by_frame: { lineage_crn: { reported: 3, inserted: 2, updated: 0, unchanged: 1, conflicts: 0 } } }
      })
    );
    const result = await uploadToRecon(FILE, { fetch, hostPermissions: HOSTS });
    eq(fetch.calls.length, 1, "one request");
    const { url, init } = fetch.calls[0];
    eq(url, `${BASE}/api/documents`, "endpoint (trailing slash of reconBaseUrl dropped)");
    eq(init.method, "POST", "method");
    eq(init.credentials, "include", "Recon sign-in cookie is sent");
    assert(init.body instanceof FormData, "multipart body");
    eq(init.body.get("customer_id"), "wabtec", "customer_id from config");
    eq(init.body.get("doc_type"), "crn", "doc_type");
    eq(init.body.get("file").name, FILE.filename, "file name");
    eq(init.body.get("file").size, 4, "file bytes");
    eq(result.storedPath, "s3://recon-docs/recon/bronze/wabtec/crn/ab.xlsx", "stored path");
    eq(result.bronzeFileId, 7, "bronze id");
    eq(result.deduplicated, false, "not deduplicated");
    eq(describeIngestStats(result.stats), "Loaded into Recon: 2 new, 0 updated, 1 unchanged", "ingest line");
  });

  await test("Recon upload: identical bytes already stored (HTTP 200) is a success flagged deduplicated", async () => {
    applyReconConfig({ reconBaseUrl: BASE });
    const fetch = fakeFetch(() => jsonResponse(200, { bronze_file_id: 7, doc_type: "bill_status", stored_path: "s3://b/k.xlsx", deduplicated: true, stats: {} }));
    const result = await uploadToRecon({ ...FILE, docType: RECON_DOC_TYPE.BILL_STATUS }, { fetch, hostPermissions: HOSTS });
    eq(result.deduplicated, true, "deduplicated");
    eq(fetch.calls[0].init.body.get("customer_id"), "default", "customer defaults to 'default'");
  });

  await test("Recon upload: 401 asks for a Recon sign-in", async () => {
    applyReconConfig({ reconBaseUrl: BASE });
    const fetch = fakeFetch(() => jsonResponse(401, { detail: "not signed in" }));
    await rejectsRecon(uploadToRecon(FILE, { fetch, hostPermissions: HOSTS }), RECON_ERROR.AUTH_REQUIRED);
    const described = describeError(RECON_ERROR.AUTH_REQUIRED);
    eq(described.reconSignIn, true, "panel offers Open Recon Engine");
    eq(described.loginRequired, false, "not the IREPS login view");
  });

  await test("Recon upload: 422 means stored but not loaded, with the API's reason", async () => {
    applyReconConfig({ reconBaseUrl: BASE });
    const fetch = fakeFetch(() => jsonResponse(422, { detail: { error: "PARSE_FAILED", detail: "BillStatusFormatError: missing Net Amt" } }));
    const error = await rejectsRecon(uploadToRecon(FILE, { fetch, hostPermissions: HOSTS }), RECON_ERROR.NOT_INGESTED);
    eq(error.detail, "BillStatusFormatError: missing Net Amt", "detail");
    assert(describeError(error.code, { detail: error.detail }).message.includes("missing Net Amt"), "message carries the reason");
  });

  await test("Recon upload: other refusals carry the API's reason", async () => {
    applyReconConfig({ reconBaseUrl: BASE });
    const fetch = fakeFetch(() => jsonResponse(400, { detail: { error: "INVALID_INPUT", detail: "customer 'x' has no active 'crn' source" } }));
    const error = await rejectsRecon(uploadToRecon(FILE, { fetch, hostPermissions: HOSTS }), RECON_ERROR.REJECTED);
    eq(error.status, 400, "status");
    eq(error.detail, "customer 'x' has no active 'crn' source", "detail");
    // a 5xx (here a proxy's HTML page) is the Recon Engine being unavailable, not a refusal of the file (L9)
    const html = fakeFetch(() => new Response("<html>bad gateway</html>", { status: 502 }));
    const down = await rejectsRecon(uploadToRecon(FILE, { fetch: html, hostPermissions: HOSTS }), RECON_ERROR.UNAVAILABLE);
    eq(down.detail, "HTTP 502", "non-JSON body");
    eq(down.status, 502);
  });

  await test("Recon upload (8.5): 408 and 429 are 'try again', never 'refused, nothing was saved'; a 2xx whose answer cannot be read says so", async () => {
    applyReconConfig({ reconBaseUrl: BASE });
    for (const status of [408, 429, 503]) {
      const busy = await rejectsRecon(uploadToRecon(FILE, { fetch: fakeFetch(() => jsonResponse(status, { detail: "slow down" })), hostPermissions: HOSTS }), RECON_ERROR.UNAVAILABLE, `HTTP ${status}`);
      eq(busy.status, status);
      eq(busy.detail, "slow down");
    }
    const unreadable = [
      ["an answer that breaks off", () => new Response(new ReadableStream({ start: (c) => c.error(new TypeError("network error")) }), { status: 201, headers: { "Content-Type": "application/json" } })],
      ["an answer that is not JSON", () => new Response("<html>stored</html>", { status: 201 })],
      ["an empty answer", () => new Response(null, { status: 200 })]
    ];
    for (const [what, respond] of unreadable) {
      const error = await rejectsRecon(uploadToRecon(FILE, { fetch: fakeFetch(respond), hostPermissions: HOSTS }), RECON_ERROR.ANSWER_UNREADABLE, what);
      assert(/^HTTP 20[01]/.test(error.detail), error.detail);
      const text = describeError(error.code, { detail: error.detail }).message;
      assert(!/Nothing was saved/.test(text) && /could not read its answer/.test(text), text);
    }
    // a definite 4xx refusal is still one
    await rejectsRecon(uploadToRecon(FILE, { fetch: fakeFetch(() => jsonResponse(413, { detail: "file too large" })), hostPermissions: HOSTS }), RECON_ERROR.REJECTED, "HTTP 413");
  });

  await test("Recon upload: unreachable Recon Engine", async () => {
    applyReconConfig({ reconBaseUrl: BASE });
    const fetch = fakeFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    const error = await rejectsRecon(uploadToRecon(FILE, { fetch, hostPermissions: HOSTS }), RECON_ERROR.UNAVAILABLE);
    eq(error.detail, "could not reach http://localhost:8000", "detail");
  });

  await test("Recon upload: not configured - no reconBaseUrl, or its origin missing from host_permissions; nothing is sent", async () => {
    const fetch = fakeFetch(() => jsonResponse(201, {}));
    applyReconConfig({});
    await rejectsRecon(uploadToRecon(FILE, { fetch, hostPermissions: HOSTS }), RECON_ERROR.NOT_CONFIGURED, "no reconBaseUrl");
    applyReconConfig({ reconBaseUrl: "https://recon.example.com" });
    const error = await rejectsRecon(uploadToRecon(FILE, { fetch, hostPermissions: HOSTS }), RECON_ERROR.NOT_CONFIGURED, "origin not permitted");
    assert(error.detail.includes("https://recon.example.com is missing from manifest.json host_permissions"), error.detail);
    eq(fetch.calls.length, 0, "no request made");
  });

  await test("Recon ingest line: recoveries not counted, conflicts reported, empty without counters", async () => {
    eq(
      describeIngestStats({ by_frame: { bills: { inserted: 4, updated: 1, unchanged: 2, conflicts: 1 }, recoveries: { inserted: 9, updated: 0, unchanged: 0, conflicts: 0 } } }),
      "Loaded into Recon: 4 new, 1 updated, 2 unchanged, 1 locked (not changed)"
    );
    eq(describeIngestStats(null), "");
    eq(describeIngestStats({ rows_inserted: 3 }), "");
  });
}

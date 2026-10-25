/**
 * Tests for "Save to: ECM / S3": the upload of an IC / PO / MA / tender document to the
 * Recon Engine's ECM gateway, POST /api/ecm/documents (services/ecm-service.js), with a
 * fake fetch - request shape, unit routing, date handling, every error path, the local
 * fallback and the result lines. No extension APIs are used. Invoked from run-tests.js.
 * Runs with config.json "ecmBackendAws": true (the gateway); the direct upload to the ECM
 * is covered by ecm-direct-tests.js.
 */

import {
  uploadToEcm, saveToEcmOrLocally, toIsoDate, ecmFields, describeEcmOutcome, summariseEcm,
  EcmError, ECM_ERROR, ECM_KIND, ECM_OUTCOME
} from "../services/ecm-service.js";
import { applyReconConfig } from "../services/recon-service.js";
import { applyEcmConfig } from "../services/ecm-config.js";
import { describeError } from "../utils/messages.js";

const BASE = "http://localhost:8000";
const HOSTS = ["http://localhost:8765/*", "https://www.ireps.gov.in/*", "http://localhost:8000/*"];
const HOSUR = { irepsAccountId: "833", operatingUnit: "HOSUR" };
const DOC = {
  kind: ECM_KIND.INSPECTION_CERTIFICATE,
  bytes: new Uint8Array([37, 80, 68, 70, 45]),
  filename: "IC_27253922100240_001_6038184070.pdf",
  fields: { ic_number: "3480517", customer_po_number: "27253922100240", ic_date: "12/05/2026" },
  account: HOSUR
};

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function fakeFetch(respond) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  fn.calls = calls;
  return fn;
}

const CREATED = { uid: "u-1", path: "/FT/workspaces/Sites/HSR/x/3480517", title: "3480517", site: "hosur", deduplicated: false };

export async function runEcmTests({ test, assert, eq }) {
  applyEcmConfig({ ecmBackendAws: true });

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

  await test("ECM upload: multipart POST /api/ecm/documents with kind, fields, account and the sign-in cookie", async () => {
    applyReconConfig({ reconBaseUrl: `${BASE}/` });
    const fetch = fakeFetch(() => jsonResponse(201, CREATED));
    const result = await uploadToEcm(DOC, { fetch, hostPermissions: HOSTS });
    eq(fetch.calls.length, 1, "one request");
    const { url, init } = fetch.calls[0];
    eq(url, `${BASE}/api/ecm/documents`, "endpoint");
    eq(init.method, "POST");
    eq(init.credentials, "include", "Recon sign-in cookie is sent");
    eq(init.body.get("kind"), "inspectionCertificate");
    eq(init.body.get("ireps_account_id"), "833", "routed by the IREPS account");
    eq(init.body.get("operating_unit"), "HOSUR", "unit sent too");
    eq(init.body.get("title"), null, "no title: the gateway's template (IC number) applies");
    eq(init.body.get("fields"), JSON.stringify({ ic_number: "3480517", customer_po_number: "27253922100240", ic_date: "2026-05-12" }), "fields as JSON, IREPS date as YYYY-MM-DD");
    eq(init.body.get("file").name, DOC.filename);
    eq(init.body.get("file").type, "application/pdf");
    eq(JSON.stringify(result), JSON.stringify(CREATED), "response mapped");
  });

  await test("ECM upload: an explicit title is sent; a document already in the ECM (HTTP 200) is flagged deduplicated", async () => {
    applyReconConfig({ reconBaseUrl: BASE });
    const fetch = fakeFetch(() => jsonResponse(200, { ...CREATED, deduplicated: true }));
    const result = await uploadToEcm({ ...DOC, kind: ECM_KIND.COUNTER_OFFER, title: "T-9 - Counter Offer 77", fields: { tender_number: "T-9" } }, { fetch, hostPermissions: HOSTS });
    eq(fetch.calls[0].init.body.get("title"), "T-9 - Counter Offer 77");
    eq(result.deduplicated, true);
  });

  await test("ECM upload: every error maps to a code, and no request is made without config or account", async () => {
    applyReconConfig({ reconBaseUrl: BASE });
    const cases = [
      [401, { detail: "not signed in" }, ECM_ERROR.AUTH_REQUIRED],
      [403, { detail: { error: "FORBIDDEN", detail: "viewer" } }, ECM_ERROR.AUTH_REQUIRED],
      [400, { detail: { error: "INVALID_INPUT", detail: "inspectionCertificate requires customer_po_number" } }, ECM_ERROR.REJECTED],
      [413, { detail: { error: "FILE_TOO_LARGE", detail: "limit" } }, ECM_ERROR.REJECTED],
      [500, { detail: { error: "ECM_NOT_CONFIGURED", detail: "missing settings: ECM_DOMAIN" } }, ECM_ERROR.NOT_CONFIGURED],
      [502, { detail: { error: "ECM_UPSTREAM_ERROR", detail: "HTTP 500" } }, ECM_ERROR.UNAVAILABLE]
    ];
    for (const [status, body, code] of cases) {
      const error = await rejectsEcm(uploadToEcm(DOC, { fetch: fakeFetch(() => jsonResponse(status, body)), hostPermissions: HOSTS }), code, `HTTP ${status}`);
      eq(error.status, status);
    }
    const rejected = await rejectsEcm(uploadToEcm(DOC, { fetch: fakeFetch(() => jsonResponse(400, cases[2][1])), hostPermissions: HOSTS }), ECM_ERROR.REJECTED);
    eq(rejected.detail, "inspectionCertificate requires customer_po_number", "the gateway's reason is kept");
    await rejectsEcm(uploadToEcm(DOC, { fetch: async () => { throw new TypeError("Failed to fetch"); }, hostPermissions: HOSTS }), ECM_ERROR.UNAVAILABLE, "network error");

    const untouched = fakeFetch(() => jsonResponse(201, CREATED));
    await rejectsEcm(uploadToEcm({ ...DOC, account: {} }, { fetch: untouched, hostPermissions: HOSTS }), ECM_ERROR.ACCOUNT_UNKNOWN, "no account -> no guess");
    await rejectsEcm(uploadToEcm(DOC, { fetch: untouched, hostPermissions: ["https://www.ireps.gov.in/*"] }), ECM_ERROR.NOT_CONFIGURED, "origin not in host_permissions");
    applyReconConfig({ reconBaseUrl: "" });
    await rejectsEcm(uploadToEcm(DOC, { fetch: untouched, hostPermissions: HOSTS }), ECM_ERROR.NOT_CONFIGURED, "no reconBaseUrl");
    eq(untouched.calls.length, 0, "nothing sent");
    for (const code of Object.values(ECM_ERROR)) assert(describeError(code).code === code, `${code} has catalog text`);
  });

  await test("ECM dates: IREPS spellings become YYYY-MM-DD; an unreadable optional date is left out", () => {
    eq(toIsoDate("16/01/2026"), "2026-01-16");
    eq(toIsoDate("16-01-2026 17:40"), "2026-01-16");
    eq(toIsoDate("5-Jan-2026"), "2026-01-05");
    eq(toIsoDate("05 Sep 2026"), "2026-09-05");
    eq(toIsoDate("2026-10-01T10:00:00Z"), "2026-10-01");
    eq(toIsoDate("31/02/2026"), "", "not a real day");
    eq(toIsoDate("soon"), "");
    eq(JSON.stringify(ecmFields({ tender_number: " T-9 ", tender_date: "not yet", loi_date: "10/09/2026", loi_number: null, x: "" })),
      JSON.stringify({ tender_number: "T-9", loi_date: "2026-09-10" }));
  });

  await test("ECM or local: stored in the ECM -> no local copy; refused -> saved locally and the reason kept", async () => {
    applyReconConfig({ reconBaseUrl: BASE });
    let localSaves = 0;
    const saveLocally = async () => ({ downloadId: ++localSaves, filename: "x.pdf" });
    const ok = await saveToEcmOrLocally(DOC, saveLocally, { fetch: fakeFetch(() => jsonResponse(201, CREATED)), hostPermissions: HOSTS });
    eq(ok.ecm.status, ECM_OUTCOME.STORED);
    eq(ok.ecm.site, "hosur");
    eq(ok.local, null);
    eq(localSaves, 0, "not saved locally");

    const down = await saveToEcmOrLocally(DOC, saveLocally, { fetch: fakeFetch(() => jsonResponse(502, { detail: { error: "ECM_UPSTREAM_ERROR", detail: "HTTP 500" } })), hostPermissions: HOSTS });
    eq(down.ecm.status, ECM_OUTCOME.FAILED);
    eq(down.ecm.code, ECM_ERROR.UNAVAILABLE);
    eq(down.local.downloadId, 1, "saved locally instead");
    eq(describeEcmOutcome(down.ecm), "ECM upload failed, saved locally: ECM unavailable (HTTP 500)");
  });

  await test("ECM result lines: per document and per batch", () => {
    eq(describeEcmOutcome({ status: ECM_OUTCOME.STORED, site: "hosur" }), "Saved to ECM (Hosur)");
    eq(describeEcmOutcome({ status: ECM_OUTCOME.ALREADY_STORED, site: "rohtak" }), "Already in ECM (Rohtak)");
    eq(describeEcmOutcome(null), "");
    const items = [
      { ecm: { status: ECM_OUTCOME.STORED, site: "hosur" } },
      { ecm: { status: ECM_OUTCOME.STORED, site: "hosur" } },
      { ecm: { status: ECM_OUTCOME.ALREADY_STORED, site: "hosur" } },
      { ecm: { status: ECM_OUTCOME.FAILED, code: ECM_ERROR.AUTH_REQUIRED } },
      { ecm: null }
    ];
    eq(summariseEcm(items), "ECM (Hosur): 2 saved, 1 already there, 1 saved locally instead");
    eq(summariseEcm([{ ecm: null }]), "", "nothing went to the ECM");
  });
}

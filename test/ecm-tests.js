/**
 * Tests for "Save to: ECM / S3": the upload of an IC / PO / MA / tender document to the
 * Recon Engine's ECM gateway, POST /api/ecm/documents (services/ecm-service.js), with a
 * fake fetch - request shape, unit routing, date handling, every error path, the local
 * fallback and the result lines. No extension APIs are used. Invoked from run-tests.js.
 * Runs with config.json "ecmBackendAws": true (the gateway); the direct upload to the ECM
 * is covered by ecm-direct-tests.js.
 */

import {
  uploadToEcm, saveToEcmOrLocally, findInEcm, toIsoDate, ecmFields, describeEcmOutcome, summariseEcm,
  EcmError, ECM_ERROR, ECM_KIND, ECM_OUTCOME, isTransientStatus, ecmErrorCode
} from "../services/ecm-service.js";
import { applyReconConfig, RECON_CONFIG } from "../services/recon-service.js";
import { applyEcmConfig, ecmDirectProblem, ECM_CONFIG } from "../services/ecm-config.js";
import { describeError } from "../utils/messages.js";
import { DeadlineError } from "../utils/http.js";

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
    eq(init.body.get("title"), null, "no title: the gateway's template (\"<IC number> - IC\") applies");
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

  await test("ECM config (8.7): an unknown ecm.env fails closed with ECM_NOT_CONFIGURED naming the value, never the TEST folders; nothing is sent", async () => {
    const NUXEO_HOSTS = [...HOSTS, "http://ecm.test:8080/*"];
    const direct = (env) => ({ ecmBackendAws: false, ecm: { env, domain: "http://ecm.test:8080", clientId: "id", clientSecret: "secret" } });
    const problem = 'ecm.env "PRD" is neither TEST nor PROD';
    try {
      applyEcmConfig(direct("PRD"));
      eq(ECM_CONFIG.env, "", "no ECM environment at all");
      eq(ecmDirectProblem(NUXEO_HOSTS), problem);
      const untouched = fakeFetch(() => jsonResponse(200, {}));
      const error = await rejectsEcm(uploadToEcm(DOC, { fetch: untouched, hostPermissions: NUXEO_HOSTS }), ECM_ERROR.NOT_CONFIGURED);
      eq(error.detail, problem);
      assert(describeError(error.code, { detail: error.detail }).message.includes(problem), "the panel names the value");
      const check = await findInEcm({ kind: ECM_KIND.INSPECTION_CERTIFICATE, account: HOSUR, candidates: [{ ref: "a", fields: DOC.fields }] }, { fetch: untouched, hostPermissions: NUXEO_HOSTS });
      eq(check.ok, false);
      eq(check.code, ECM_ERROR.NOT_CONFIGURED);
      let localSaves = 0;
      const saved = await saveToEcmOrLocally(DOC, async () => ({ downloadId: ++localSaves, filename: "x.pdf" }), { fetch: untouched, hostPermissions: NUXEO_HOSTS });
      eq(saved.ecm.code, ECM_ERROR.NOT_CONFIGURED);
      eq(localSaves, 1, "saved locally, as for every ECM settings problem");
      eq(untouched.calls.length, 0, "nothing sent to the ECM");
      for (const env of ["TEST", "prod", " Test "]) {
        applyEcmConfig(direct(env));
        eq(ecmDirectProblem(NUXEO_HOSTS), "", `ecm.env "${env}"`);
      }
      applyEcmConfig(direct(undefined));
      eq(ECM_CONFIG.env, "TEST", "not set: TEST, as always");
      eq(ecmDirectProblem(NUXEO_HOSTS), "");
    } finally {
      applyEcmConfig({ ecmBackendAws: true });
    }
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

  /* ------------------------------------------------------------------- review fixes: M15, L9 */

  await test("ECM (L9): a row's failure reason is the error's title in the one catalogue (utils/messages.js), not a second table", () => {
    for (const code of Object.values(ECM_ERROR)) {
      eq(describeEcmOutcome({ status: ECM_OUTCOME.FAILED, code }), `ECM upload failed, saved locally: ${describeError(code).title}`, code);
    }
    eq(describeEcmOutcome({ status: ECM_OUTCOME.FAILED, code: ECM_ERROR.AUTH_REQUIRED, detail: "x" }), "ECM upload failed, saved locally: Recon Engine sign-in required (x)");
    eq(describeEcmOutcome({ status: ECM_OUTCOME.FAILED, code: "SOMETHING_NEW" }), "ECM upload failed, saved locally: SOMETHING_NEW", "a code without catalogue text is shown as it is");
  });

  await test("ECM (L9): one rule for HTTP answers on the gateway and the direct ECM: a definite 4xx refusal is ECM_REJECTED, a passing fault ECM_UNAVAILABLE", async () => {
    eq([400, 404, 409, 413, 422].map(ecmErrorCode).join(), Array(5).fill(ECM_ERROR.REJECTED).join());
    eq([408, 429, 500, 502, 503].map(ecmErrorCode).join(), Array(5).fill(ECM_ERROR.UNAVAILABLE).join());
    eq([408, 429, 500, 503].every(isTransientStatus) && ![400, 401, 403, 404].some(isTransientStatus), true);
    applyReconConfig({ reconBaseUrl: BASE });
    const answer = (status) => fakeFetch(() => jsonResponse(status, { detail: { error: "X", detail: `HTTP ${status} reason` } }));
    eq((await rejectsEcm(uploadToEcm(DOC, { fetch: answer(404), hostPermissions: HOSTS }), ECM_ERROR.REJECTED)).detail, "HTTP 404 reason", "a refusal (was ECM_UNAVAILABLE)");
    await rejectsEcm(uploadToEcm(DOC, { fetch: answer(429), hostPermissions: HOSTS }), ECM_ERROR.UNAVAILABLE, "too many requests: passing");
    // the check never throws: it answers the code
    const check = (status) => findInEcm({ kind: ECM_KIND.PO_COPY, account: HOSUR, candidates: [{ ref: "a", fields: { customer_po_number: "1" } }] }, { fetch: answer(status), hostPermissions: HOSTS });
    eq((await check(429)).code, ECM_ERROR.UNAVAILABLE, "the check: too many requests is passing (was ECM_REJECTED)");
    eq((await check(404)).code, ECM_ERROR.REJECTED);
    eq((await check(401)).code, ECM_ERROR.AUTH_REQUIRED);
    eq((await findInEcm({ kind: ECM_KIND.PO_COPY, account: HOSUR, candidates: [{ ref: "a", fields: { customer_po_number: "1" } }] }, { fetch: fakeFetch(() => jsonResponse(200, { found: null })), hostPermissions: HOSTS })).code, ECM_ERROR.UNAVAILABLE, "an answer without a list");
  });

  await test("ECM gateway (M15): the upload and the check run under one deadline that covers the answer's body, and say how long they waited", async () => {
    applyReconConfig({ reconBaseUrl: BASE });
    const created = fakeFetch(() => jsonResponse(201, CREATED));
    await uploadToEcm(DOC, { fetch: created, hostPermissions: HOSTS });
    assert(created.calls[0].init.signal instanceof AbortSignal, "the request has a deadline");
    // fetchWithDeadline throws DeadlineError when the deadline passes in the headers or the body (a stalled body
    // itself is tested in test/node/ecm-tests.mjs: headless Chrome's virtual clock stops during a pending stream read)
    const late = (ms) => async () => { throw new DeadlineError(ms); };
    const upload = await rejectsEcm(uploadToEcm(DOC, { fetch: late(RECON_CONFIG.timeoutMs), hostPermissions: HOSTS }), ECM_ERROR.UNAVAILABLE);
    eq(upload.detail, `no complete answer within ${Math.round(RECON_CONFIG.timeoutMs / 1000)} seconds`, "the deadline that applied, not a fixed \"2 minutes\"");
    const checked = await findInEcm({ kind: ECM_KIND.PO_COPY, account: HOSUR, candidates: [{ ref: "a", fields: { customer_po_number: "1" } }] }, { fetch: late(30000), hostPermissions: HOSTS });
    eq(JSON.stringify([checked.ok, checked.code, checked.detail]), JSON.stringify([false, ECM_ERROR.UNAVAILABLE, "no complete answer within 30 seconds"]));
    let local = 0;
    const saved = await saveToEcmOrLocally(DOC, async () => ((local += 1), { downloadId: 1 }), { fetch: late(RECON_CONFIG.timeoutMs), hostPermissions: HOSTS });
    eq(JSON.stringify([saved.ecm.code, local]), JSON.stringify([ECM_ERROR.UNAVAILABLE, 1]), "saved locally");
  });
}

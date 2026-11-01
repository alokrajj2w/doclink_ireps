/**
 * Tests for services/export-save-service.js: where a Bill Status / CRN / R-NOTE export
 * goes (Downloads or the Recon Engine), how failures map to error codes, the download-log
 * check that skips an identical export, and the summary / "last download" line the
 * service worker stores. No extension APIs are used. Invoked from run-tests.js.
 */

import { saveExportFile, saveExportFileTo, sanitiseDestination, savedSummary, lastDownloadEntry, WorkflowError } from "../services/export-save-service.js";
import { ReconError, applyReconConfig, SAVE_DESTINATION } from "../services/recon-service.js";
import { applyDownloadLogConfig, configureDownloadLog, downloadKey, exportFingerprint } from "../services/download-log.js";

const RECON = "http://localhost:8000";
const FILE = { bytes: new Uint8Array([80, 75, 3, 4]), mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", format: "xlsx", extension: "xlsx" };
const ROWS = [{ crnNo: "013801-26-20001", poNo: "RR-1" }];
const TARGET = (destination) => ({
  destination,
  docType: "crn",
  localPath: "DocLink/IREPS/CRN/CRN_2026-11-01.xlsx",
  filename: "CRN_2026-11-01.xlsx",
  localErrorCode: "DOCUMENT_DOWNLOAD_ERROR",
  records: ROWS,
  label: "CRN"
});

function fakeIo() {
  const calls = { upload: [], download: [] };
  return {
    calls,
    uploadToRecon: async (req) => (calls.upload.push(req), { storedPath: "s3://recon/crn/CRN.xlsx", deduplicated: false, stats: { inserted: 1 } }),
    downloadBytes: async (bytes, opts) => (calls.download.push({ bytes, ...opts }), { downloadId: 7, filename: "/Users/x/Downloads/DocLink/IREPS/CRN/CRN_2026-11-01.xlsx" })
  };
}

export async function runExportSaveTests({ test, assert, eq }) {
  /** The error a promise rejects with (failing the test when it resolves), checked for a WorkflowError code. */
  const workflowRejects = async (promise, code) => {
    try {
      await promise;
    } catch (error) {
      assert(error instanceof WorkflowError, `expected a WorkflowError, got ${error && error.stack}`);
      eq(error.code, code);
      return error;
    }
    throw new Error("expected a rejection");
  };
  applyReconConfig({ reconBaseUrl: RECON });

  await test("export save: Downloads by default, the Recon Engine only when chosen; the file goes as is", async () => {
    applyDownloadLogConfig({ downloadLog: { enabled: false } });
    eq(sanitiseDestination("recon"), SAVE_DESTINATION.RECON);
    eq(sanitiseDestination("anything"), SAVE_DESTINATION.LOCAL);
    eq(sanitiseDestination(undefined), SAVE_DESTINATION.LOCAL);

    const local = fakeIo();
    const a = await saveExportFile(FILE, TARGET(SAVE_DESTINATION.LOCAL), local);
    eq(local.calls.upload.length, 0);
    eq(local.calls.download.length, 1);
    eq(local.calls.download[0].path, "DocLink/IREPS/CRN/CRN_2026-11-01.xlsx");
    eq(local.calls.download[0].mimeType, FILE.mimeType);
    eq(a.destination, SAVE_DESTINATION.LOCAL);
    eq(a.downloadId, 7);

    const recon = fakeIo();
    const b = await saveExportFile(FILE, TARGET(SAVE_DESTINATION.RECON), recon);
    eq(recon.calls.download.length, 0, "a Recon upload never also saves locally");
    eq(JSON.stringify({ ...recon.calls.upload[0], bytes: recon.calls.upload[0].bytes.length }), JSON.stringify({ docType: "crn", bytes: 4, filename: "CRN_2026-11-01.xlsx", mimeType: FILE.mimeType }));
    eq(b.storedPath, "s3://recon/crn/CRN.xlsx");
    eq(b.ingestStats.inserted, 1);
    eq(b.warnings.length, 0);
  });

  await test("export save: a Recon refusal keeps its own code; a local failure is the caller's code; anything else is not swallowed", async () => {
    const reconDown = { ...fakeIo(), uploadToRecon: async () => { throw new ReconError("RECON_AUTH_REQUIRED", { status: 401, detail: "signed out" }); } };
    const e1 = await workflowRejects(saveExportFileTo(FILE, TARGET(SAVE_DESTINATION.RECON), reconDown), "RECON_AUTH_REQUIRED");
    eq(e1.details.status, 401);
    eq(e1.details.detail, "signed out");
    const diskFull = { ...fakeIo(), downloadBytes: async () => { throw new Error("disk full"); } };
    await workflowRejects(saveExportFileTo(FILE, TARGET(SAVE_DESTINATION.LOCAL), diskFull), "DOCUMENT_DOWNLOAD_ERROR");
    const bug = { ...fakeIo(), uploadToRecon: async () => { throw new TypeError("boom"); } };
    let thrown = null;
    try {
      await saveExportFileTo(FILE, TARGET(SAVE_DESTINATION.RECON), bug);
    } catch (error) {
      thrown = error;
    }
    assert(thrown instanceof TypeError, "a programming error surfaces as itself");
  });

  await test("export save: with the download log on, an identical export (same rows, same format) is not saved again; a new one is saved and logged", async () => {
    const posted = [];
    const key = downloadKey.export("crn", await exportFingerprint("xlsx", ROWS));
    const recon = async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : null;
      if (String(url).endsWith("/api/doclink/downloads/check")) {
        const downloaded = body.keys.includes(key) && recon.already ? { [key]: { count: 1, filename: "CRN_old.xlsx", date: "2026-10-31", time: "09:00:00" } } : {};
        return new Response(JSON.stringify({ destination: body.destination, downloaded }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (String(url).endsWith("/api/doclink/downloads")) {
        posted.push(...body.records);
        return new Response(JSON.stringify({ logged: body.records.length }), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      return new Response("{}", { status: 404 });
    };
    const store = {};
    const realFetch = globalThis.fetch;
    globalThis.fetch = recon;
    applyDownloadLogConfig({ downloadLog: { enabled: true } });
    configureDownloadLog({ hostPermissions: [`${RECON}/*`], flushDelayMs: 0, storage: { get: async (k) => (k in store ? { [k]: store[k] } : {}), set: async (o) => Object.assign(store, JSON.parse(JSON.stringify(o))) } });
    try {
      recon.already = true;
      const asked = [];
      const io = fakeIo();
      const skipped = await saveExportFile(FILE, { ...TARGET(SAVE_DESTINATION.LOCAL), ask: async (q) => (asked.push(q), { redownload: [] }) }, { ...io, logDeps: { fetch: recon } });
      eq(asked.length, 1, "the user is asked about the identical export");
      eq(skipped.skipped, true);
      eq(io.calls.download.length, 0, "nothing saved");

      recon.already = false;
      const io2 = fakeIo();
      const saved = await saveExportFile(FILE, TARGET(SAVE_DESTINATION.LOCAL), { ...io2, logDeps: { fetch: recon } });
      eq(saved.skipped, undefined);
      eq(io2.calls.download.length, 1);
      for (let i = 0; i < 20 && posted.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
      eq(posted.length, 1, "the save is recorded in the download log");
      eq(posted[0].doc_key, key, "keyed by the rows' fingerprint, not the file name");
      eq(posted[0].destination, "local");
    } finally {
      globalThis.fetch = realFetch;
      applyDownloadLogConfig({ downloadLog: { enabled: false } });
    }
  });

  await test("export save: the job summary fields and the footer's last-download line", () => {
    const local = { destination: "local", downloadId: 3, filename: "a.xlsx", storedPath: null, deduplicated: false, ingestStats: null, warnings: ["w"] };
    const s = savedSummary(local);
    eq(JSON.stringify(s), JSON.stringify({ destination: "local", downloadId: 3, filename: "a.xlsx", storedPath: null, deduplicated: false, ingestStats: null, skipped: false, skip: null, warnings: ["w"] }));
    const base = { downloadedAt: "2026-11-01T10:00:00.000Z", recordCount: 4, filter: "Railway: all" };
    eq(lastDownloadEntry({ ...base, ...s }).lastStatus, "Downloaded successfully");
    eq(lastDownloadEntry({ ...base, ...s }).lastDownloadFilename, "a.xlsx");
    const toRecon = lastDownloadEntry({ ...base, ...savedSummary({ ...local, destination: "recon", storedPath: "s3://x/a.xlsx" }) });
    eq(toRecon.lastStatus, "Saved to Recon Engine (S3)");
    eq(toRecon.lastDownloadFilename, "s3://x/a.xlsx", "the stored path wins over the file name");
    eq(lastDownloadEntry({ ...base, ...savedSummary({ ...local, skipped: true, filename: null }) }).lastStatus, "Not saved again: identical export already downloaded");
  });
}

/**
 * Runs DocLink's real bill upload code against the mock IREPS screens and prints, for every test
 * receipt, what IREPS received against what was expected:
 *
 *   node test/mock/bill-flow-check.mjs
 *
 * It starts its own mock on another port, so a mock you have open is not affected. The code under
 * test is services/bill-upload/ (prepareBill, createDraftBill) with the invoices from the mock.
 * The expected values come from the mock's field check, which doesn't use DocLink's code.
 *
 * Not covered here, because they need a browser: the R-NOTE / CRN search parsers, the side panel
 * and sending from the IREPS tab. TESTING.md C9 covers those by hand.
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareBill, createDraftBill, receiptKey } from "../../services/bill-upload/bill-upload-service.js";
import { invoiceFromFile, receiptInvoiceKey } from "../../services/bill-upload/invoice-file.js";
import { createBillStore, memoryStorageArea } from "../../services/bill-upload/bill-upload-store.js";
import { loadIrepsConfig } from "../../services/ireps-api.js";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.BILL_CHECK_PORT || 8799);
const BASE = `http://localhost:${PORT}`;
const TODAY = new Date(Date.UTC(2026, 10, 6));

/** The receipts, as DocLink's search would give them, and what each test expects. */
const CASES = [
  { name: "Normal stock bill (IGST, TPI)", source: "RNOTE", rly: "11", poKey: "1000001", poNo: "11260000100001", roNo: "48300000001", receiptNo: "4800000001", qty: 87, expect: "item-saved" },
  { name: "Long place of supply (CONSG)", source: "RNOTE", rly: "05", poKey: "1000004", poNo: "05260000100004", roNo: "44000000004", receiptNo: "4400000004", qty: 15, expect: "item-saved", warnings: true },
  { name: "Same-state bill (CGST + SGST)", source: "RNOTE", rly: "06", poKey: "1000005", poNo: "06260000100005", roNo: "33300000005", receiptNo: "3300000005", qty: 20, expect: "item-saved" },
  { name: "Non-stock bill through a CRN", source: "CRN", rly: "12", poKey: "1000006", poNo: "12260000100006", roNo: "013809-26-20009", receiptNo: "013809-26-20009", qty: 100, expect: "item-saved" },
  { name: "Invoice amount does not match", source: "RNOTE", rly: "13", poKey: "1000007", poNo: "13260000100007", roNo: "77700000007", receiptNo: "7700000007", qty: 10, expect: "stopped-before-write" },
  { name: "Bad HSN (known gap)", source: "RNOTE", rly: "04", poKey: "1000008", poNo: "04260000100008", roNo: "88800000008", receiptNo: "8800000008", qty: 5, expect: "item-blocked" }
];

function startMock() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(here, "mock-ireps-server.mjs")], { env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", "pipe", "inherit"] });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`the mock exited early (code ${code})`)));
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("listening")) resolve(child);
    });
  });
}

async function login() {
  const response = await fetch(`${BASE}/login`, { method: "POST", redirect: "manual" });
  return response.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

function receiptOf(c) {
  const receipt = { source: c.source, poNo: c.poNo, poSr: "001", receiptNo: c.receiptNo, roNo: c.roNo, qty: c.qty, billClaim: { rly: c.rly, poKey: c.poKey }, billable: true, reason: null };
  return { ...receipt, key: receiptKey(receipt) };
}

async function runCase(c, cookie, invoices, store) {
  const deps = { fetch: (url, init = {}) => fetch(url, { ...init, headers: { ...(init.headers || {}), Cookie: cookie } }), store, today: TODAY };
  const receipt = receiptOf(c);
  const invoice = invoiceFromFile({ name: "mock-invoices.json", records: invoices }, receiptInvoiceKey(receipt));
  const context = await prepareBill({ receipt, invoice }, deps);
  const errors = context.header.checks.filter((x) => x.level === "error");
  if (errors.length) return { outcome: "stopped-before-write", detail: errors.map((x) => x.text).join(" ") };
  const result = await createDraftBill(context, { acknowledged: Boolean(c.warnings) }, deps);
  const detail = result.outcome === "item-blocked" ? result.context.item.checks.filter((x) => x.level === "error").map((x) => x.text).join(" ") : "";
  return { outcome: result.outcome, billRegNo: result.context.billRegNo, detail };
}

async function main() {
  // only this script's report, unless asked for DocLink's own log (BILL_CHECK_LOG=1)
  const print = console.log.bind(console);
  if (!process.env.BILL_CHECK_LOG) {
    for (const method of ["log", "info", "debug", "warn"]) console[method] = () => {};
  }
  // a config answer pointing DocLink's IREPS client at this mock
  globalThis.chrome = { runtime: { getURL: () => `data:application/json,${encodeURIComponent(JSON.stringify({ baseUrl: BASE }))}` } };
  await loadIrepsConfig({ force: true });

  const mock = await startMock();
  mock.removeAllListeners("exit");
  let failures = 0;
  try {
    const cookie = await login();
    const invoices = (await (await fetch(`${BASE}/mock/bill/invoices.json`)).json()).invoices;
    const store = createBillStore(memoryStorageArea());
    for (const c of CASES) {
      print(`\n${c.name} (PO ${c.poNo})`);
      let run;
      try {
        run = await runCase(c, cookie, invoices, store);
      } catch (error) {
        run = { outcome: "error", detail: (error && (error.detail || error.message)) || String(error) };
      }
      const asExpected = run.outcome === c.expect;
      if (!asExpected) failures++;
      print(`  DocLink: ${run.outcome}${run.billRegNo ? `, bill ${run.billRegNo}` : ""} ${asExpected ? "(as expected)" : `(EXPECTED ${c.expect})`}`);
      if (run.detail) print(`  Reason:  ${run.detail}`);
      if (!run.billRegNo) continue;
      const check = await (await fetch(`${BASE}/mock/bill/check.json?billRegNo=${run.billRegNo}`)).json();
      const lines = [...check.header, ...check.item];
      print(`  Fields:  ${check.summary.passed} of ${check.summary.checked} match${check.summary.noReference ? `, ${check.summary.noReference} with nothing to compare` : ""}`);
      for (const x of lines.filter((l) => l.result === "fail")) {
        failures++;
        print(`  DIFFERENT  ${x.label} (${x.field}): received "${x.received}", expected "${x.expected}"`);
      }
    }
  } finally {
    mock.kill();
  }
  print(failures ? `\nFAILED: ${failures} problem(s).` : "\nPASSED: every receipt behaved as expected and every field matched.");
  process.exitCode = failures ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

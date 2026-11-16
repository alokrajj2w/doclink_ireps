/**
 * Runs every DocLink test suite on Windows, macOS or Linux and fails loudly:
 *
 *   npm test                  browser suite + tender/correspondence node suites + bill-flow check
 *   npm test -- browser       only the browser suite (test/run-tests.html in headless Chrome)
 *   npm test -- node          only the node:test suites (tender/tests/*.mjs, test/node/*.mjs)
 *   npm test -- bill          only test/mock/bill-flow-check.mjs (bill upload against the mock screens)
 *   npm test -- browser --only=ecm,ecm-direct   only those browser suites (names in test/run-tests.js;
 *                             "core" = the tests in run-tests.js itself)
 *
 * Chrome is found at its usual install path, or set CHROME_PATH. Each run uses a fresh, temporary
 * Chrome profile, so it never touches your own profile or Downloads folder.
 *
 * The browser suite counts as failed when Chrome exits without the "DOCLINK_TESTS n/n passed"
 * summary (a test that hangs or a module that fails to load), not only when a test fails.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BROWSER_TIMEOUT_MS = 180000;

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = {
    win32: [
      join(process.env.PROGRAMFILES || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
      join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
      join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe")
    ],
    darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"],
    linux: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium"]
  }[process.platform] || [];
  return candidates.find((p) => p && existsSync(p)) || null;
}

/** Run a command; resolve with its exit code and output (also streamed when `echo` is set). */
function run(command, args, { echo = false, timeoutMs = 0 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let timedOut = false;
    const timer = timeoutMs ? setTimeout(() => ((timedOut = true), child.kill()), timeoutMs) : null;
    child.stdout.on("data", (d) => ((out += d), echo && process.stdout.write(d)));
    child.stderr.on("data", (d) => ((err += d), echo && process.stderr.write(d)));
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, out, err: `${err}${error.message}`, timedOut });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, out, err, timedOut });
    });
  });
}

/** Every .js / .mjs module of the extension and its tests (not node_modules, dist, fixtures). */
function moduleFiles(dir = root, out = []) {
  for (const name of readdirSync(dir)) {
    if (["node_modules", "dist", ".git", "fixtures"].includes(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) moduleFiles(path, out);
    else if (/\.m?js$/.test(name)) out.push(path);
  }
  return out;
}

/** The first syntax errors among the modules (why a page can fail to load without any test failing). */
async function syntaxErrors() {
  const errors = [];
  for (const file of moduleFiles()) {
    const result = await run(process.execPath, ["--check", file]);
    if (result.code !== 0) errors.push(result.err.trim().split(/\r?\n/).slice(0, 5).join("\n"));
    if (errors.length >= 3) break;
  }
  return errors;
}

const unescapeHtml = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

async function browserSuite() {
  const chrome = chromePath();
  if (!chrome) {
    console.error("browser suite: Chrome not found. Set CHROME_PATH to the Chrome executable.");
    return false;
  }
  const profile = mkdtempSync(join(tmpdir(), "doclink-tests-"));
  try {
    const only = (process.argv.find((a) => a.startsWith("--only=")) || "").slice("--only=".length);
    const page = pathToFileURL(join(root, "test", "run-tests.html")).href + (only ? `?only=${encodeURIComponent(only)}` : "");
    const result = await run(chrome, [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${profile}`,
      "--allow-file-access-from-files",
      "--virtual-time-budget=120000",
      "--dump-dom",
      page
    ], { timeoutMs: BROWSER_TIMEOUT_MS });
    const summary = /DOCLINK_TESTS (\d+)\/(\d+) passed[^<]*/.exec(result.out);
    const failures = [...result.out.matchAll(/<li class="fail">([\s\S]*?)<\/li>/g)].map((m) => unescapeHtml(m[1]));
    for (const f of failures) console.error(`\n${f}`);
    if (!summary) {
      console.error(`browser suite: no DOCLINK_TESTS summary${result.timedOut ? " (Chrome was stopped after 3 minutes)" : ""}. A test hung or a module failed to load: open test/run-tests.html in Chrome and check the console.`);
      const broken = await syntaxErrors();
      if (broken.length) console.error(`Syntax error(s):\n${broken.join("\n\n")}`);
      else if (result.err.trim()) console.error(result.err.trim().split(/\r?\n/).slice(-15).join("\n"));
      return false;
    }
    console.log(summary[0].trim());
    return summary[1] === summary[2] && failures.length === 0;
  } finally {
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Chrome can hold the profile for a moment after it exits; a leftover temp folder is harmless.
    }
  }
}

async function nodeSuites() {
  const panel = readdirSync(join(root, "test", "node")).filter((f) => f.endsWith(".mjs")).map((f) => `test/node/${f}`);
  const result = await run(process.execPath, ["--test", "--test-reporter=spec", "tender/tests/run-tests.mjs", "tender/tests/pending-tests.mjs", ...panel]);
  const output = `${result.out}${result.err}`;
  if (result.code !== 0) console.error(output);
  const counts = ["tests", "pass", "fail"].map((k) => (new RegExp(`(?:ℹ|#) ${k} (\\d+)`).exec(output) || [])[1] || "?");
  console.log(`NODE_TESTS ${counts[1]}/${counts[0]} passed${result.code !== 0 ? ` (${counts[2]} FAILED)` : ""}`);
  return result.code === 0;
}

async function billFlowCheck() {
  const result = await run(process.execPath, ["test/mock/bill-flow-check.mjs"]);
  const output = `${result.out}${result.err}`;
  if (result.code !== 0) console.error(output);
  const last = output.trim().split(/\r?\n/).pop();
  console.log(`BILL_FLOW_CHECK ${result.code === 0 ? "passed" : "FAILED"}: ${last}`);
  return result.code === 0;
}

const SUITES = { browser: browserSuite, node: nodeSuites, bill: billFlowCheck };
const wanted = process.argv.slice(2).filter((a) => a in SUITES);
let ok = true;
for (const name of wanted.length ? wanted : Object.keys(SUITES)) ok = (await SUITES[name]()) && ok;
process.exit(ok ? 0 : 1);

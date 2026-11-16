/**
 * Builds a shareable copy of DocLink in dist/doclink/ and zips it to
 * dist/doclink-<version>-<timestamp>.zip. Earlier zips are left in place.
 *
 * Each JS entry point (with its module graph under services/, utils/ and
 * tender/) is bundled, minified, then run through javascript-obfuscator to
 * rename identifiers, encode strings and flatten control flow. The three
 * side-panel scripts (PANEL_ENTRY_POINTS) load into the same page, so they
 * are bundled together with code splitting: a module they share (download
 * log context, print queue, diagnostics log) exists once, exactly as when
 * DocLink is loaded unpacked; the shared code goes to chunks/. HTML, CSS,
 * assets and config.json are copied unchanged; manifest.json gets the build's
 * host_permissions and version_name. The source tree is never modified.
 *
 * Two kinds of build:
 *   npm run build                   production. config.json must say "target": "real" and may
 *                                   point nothing DocLink uses at this PC (localhost). The built
 *                                   manifest drops the localhost and mock-portal host_permissions,
 *                                   and must still cover every URL DocLink sends requests to.
 *   npm run build -- --allow-mock   test build: any target, and manifest.json's host_permissions
 *                                   as they are, so the copy can be pointed at the mock portal
 *                                   and a local Recon Engine.
 *
 * Every build
 *   - stops on what looks like a real credential in config.json (8 characters or more; the
 *     shipped "abc" placeholders pass). Real credentials go in config.local.json, which is never
 *     packaged;
 *   - logs from "info" up (DocLink loaded unpacked logs from "debug"): utils/logger.js reads
 *     __DOCLINK_LOG_LEVEL__, set here through esbuild's define. --log-level=<level> changes it;
 *   - stamps the git commit ("abc1234", with "-dirty" when the tree has uncommitted changes,
 *     "unknown" without git) into the manifest's version_name and build-info.json;
 *   - obfuscates with a fixed seed, so the same sources and devDependencies give the same files.
 *
 * The obfuscator settings avoid selfDefending / debugProtection, which rely on
 * Function() and would be blocked by the Manifest V3 content-security-policy, and
 * controlFlowFlattening, which can route a spread call through a two-argument helper
 * (fn(...args) becomes helper(fn, ...args) -> fn(args[0])) and so drop arguments.
 * javascript-obfuscator 4.2.2 did that to utils/logger.js in a 15 Nov 2026 build: the
 * panel's console lines lost their message. Don't turn it back on.
 *
 * Usage: npm install && npm run build      (npm run build -- --allow-mock [--log-level=debug])
 */
import { build } from "esbuild";
import obfuscator from "javascript-obfuscator";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileMatchPatterns } from "../utils/url-scope.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const OUT = join(DIST, "doclink");

/** Entry points loaded by manifest.json or by <script type="module"> in HTML, each a page of its own. */
const ENTRY_POINTS = [
  "background/service-worker.js",
  "background/offscreen.js",
  "pages/preview.js",
];

/** The <script type="module"> tags of popup/popup.html: one page, so one module graph (code splitting). */
const PANEL_ENTRY_POINTS = [
  "popup/popup.js",
  "tender/tender-ui.js",
  "tender/pending-ui.js",
];

/** Files copied verbatim (no JS to protect, or needed as-is at runtime). manifest.json is written by writeManifest(). */
const STATIC_FILES = [
  "config.json",
  "assets",
  "background/offscreen.html",
  // injected into the IREPS tab as a file by the bill upload (services/bill-upload/tab-transport.js)
  "background/bill-tab-request.js",
  "popup/popup.html",
  "popup/popup.css",
  "pages/preview.html",
  "pages/preview.css",
  "tender/tender.css",
];

/** The IREPS portals when config.json names none (as in services/ireps-api.js). */
const DEFAULT_MOCK_PORTAL = "http://localhost:8765";
const DEFAULT_REAL_PORTAL = "https://www.ireps.gov.in";

/** The developer's own PC: the mock portal and a local Recon Engine run there, never a production system. */
const LOOPBACK_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;

/** A built copy logs from this level up unless --log-level says otherwise (the levels of utils/logger.js). */
const DEFAULT_LOG_LEVEL = "info";
const LOG_LEVELS = ["debug", "info", "warn", "error", "silent"];

/** config.json keys that hold credentials ("//..." keys are comments). */
const SECRET_KEY = /secret|password|passwd|api[_-]?key|private[_-]?key|access[_-]?token|refresh[_-]?token/i;

/** Any fixed number: the same sources then obfuscate to the same files (0 would draw a new seed every build). */
const OBFUSCATOR_SEED = 20261115;

const OBFUSCATOR_OPTIONS = {
  compact: true,
  identifierNamesGenerator: "hexadecimal",
  renameGlobals: false,
  stringArray: true,
  stringArrayEncoding: ["base64"],
  stringArrayThreshold: 0.75,
  splitStrings: true,
  splitStringsChunkLength: 10,
  // off: it can drop the arguments of a spread call (see the header)
  controlFlowFlattening: false,
  numbersToExpressions: true,
  simplify: true,
  selfDefending: false,
  debugProtection: false,
  disableConsoleOutput: false,
  seed: OBFUSCATOR_SEED,
};

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

/** @param {string} logLevel  the lowest level the built copy logs (utils/logger.js __DOCLINK_LOG_LEVEL__) */
function esbuildOptions(logLevel) {
  return {
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "chrome116",
    minify: true,
    legalComments: "none",
    write: false,
    define: { __DOCLINK_LOG_LEVEL__: JSON.stringify(logLevel) },
  };
}

function protect(code) {
  return obfuscator.obfuscate(code, OBFUSCATOR_OPTIONS).getObfuscatedCode();
}

async function bundleAndProtect(entry, logLevel) {
  const outFile = join(OUT, entry);
  mkdirSync(dirname(outFile), { recursive: true });
  const result = await build({ ...esbuildOptions(logLevel), entryPoints: [join(ROOT, entry)] });
  writeFileSync(outFile, protect(result.outputFiles[0].text));
  log(`  bundled + obfuscated  ${entry}`);
}

/** Several entry points of one page: shared modules go to chunks/ once, imported by each entry. */
async function bundleAndProtectTogether(entries, logLevel) {
  const result = await build({
    ...esbuildOptions(logLevel),
    entryPoints: entries.map((e) => join(ROOT, e)),
    splitting: true,
    outdir: OUT,
    outbase: ROOT,
    chunkNames: "chunks/[name]-[hash]",
  });
  for (const file of result.outputFiles) {
    if (!file.path.endsWith(".js")) continue;
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, protect(file.text));
    log(`  bundled + obfuscated  ${relative(OUT, file.path)}`);
  }
}

/** --allow-mock and --log-level=<level>; anything else is reported and ignored. */
function parseArgs(args) {
  let logLevel = DEFAULT_LOG_LEVEL;
  for (const arg of args) {
    if (arg.startsWith("--log-level=")) logLevel = arg.slice("--log-level=".length);
    else if (arg !== "--allow-mock") log(`  WARNING unknown option ${arg} (ignored)`);
  }
  if (!LOG_LEVELS.includes(logLevel)) throw new Error(`--log-level must be one of ${LOG_LEVELS.join(", ")}, not "${logLevel}".`);
  return { allowMock: args.includes("--allow-mock"), logLevel };
}

/** A stand-in such as the shipped "abc": empty or shorter than 8 characters. */
const isPlaceholder = (value) => !value || String(value).trim().length < 8;

/** Paths ("ecm.clientSecret") of config.json values that look like real credentials. Never their values. */
function secretPaths(value, path = "") {
  const found = [];
  for (const [key, child] of Object.entries(value && typeof value === "object" ? value : {})) {
    if (key.startsWith("//")) continue;
    const at = path ? `${path}.${key}` : key;
    if (child && typeof child === "object") found.push(...secretPaths(child, at));
    else if (SECRET_KEY.test(key) && (typeof child === "string" || typeof child === "number") && !isPlaceholder(child)) found.push(at);
  }
  return found;
}

/**
 * The URLs of config.json a built DocLink uses. `fetched`: DocLink sends requests there, so the
 * origin needs a host permission (the Recon app URL is only opened in a tab). The ECM domain counts
 * only when DocLink calls the ECM itself ("ecmBackendAws" not true).
 * @returns {{ key: string, url: string, fetched: boolean }[]}
 */
function configUrls(config) {
  const ecm = config.ecm || {};
  const ireps =
    typeof config.baseUrl === "string" && config.baseUrl
      ? { key: "baseUrl", url: config.baseUrl }
      : config.target === "mock"
        ? { key: "mockBaseUrl", url: config.mockBaseUrl || DEFAULT_MOCK_PORTAL }
        : { key: "realBaseUrl", url: config.realBaseUrl || DEFAULT_REAL_PORTAL };
  const urls = [
    { ...ireps, fetched: true },
    { key: "reconBaseUrl", url: config.reconBaseUrl, fetched: true },
    { key: "reconAppUrl", url: config.reconAppUrl, fetched: false },
    ...(config.ecmBackendAws === true ? [] : [{ key: "ecm.domain", url: ecm.domain, fetched: true }]),
  ];
  return urls.filter((u) => typeof u.url === "string" && u.url.trim() !== "").map((u) => ({ ...u, url: u.url.trim() }));
}

function isLoopbackUrl(url) {
  try {
    return LOOPBACK_HOST.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** The host of a match pattern ("http://localhost:8765/*" -> "localhost"); "" for <all_urls> and the like. */
function patternHost(pattern) {
  const m = /^[^:/]+:\/\/(\[[^\]]*\]|[^/:]*)/.exec(String(pattern));
  return m ? m[1].toLowerCase() : "";
}

/**
 * Stop a build that would ship the wrong IREPS target, a credential, or (production) a URL on this
 * PC; report ECM settings that cannot work.
 */
function checkConfig({ allowMock }) {
  const config = JSON.parse(readFileSync(join(ROOT, "config.json"), "utf8"));
  if (config.target !== "real" && !allowMock) {
    throw new Error(
      `config.json "target" is "${config.target}": a shared build must use "real". ` +
        "Set it to \"real\", or run `npm run build -- --allow-mock` to build against the mock portal on purpose.",
    );
  }
  if (typeof config.baseUrl === "string" && config.baseUrl) {
    log(`  WARNING config.json has an explicit "baseUrl" (${config.baseUrl}); it overrides "target".`);
  } else if (config.target !== "real" && config.target !== "mock") {
    log(`  WARNING config.json "target" is ${JSON.stringify(config.target)}: DocLink reports a configuration error until it is "mock" or "real".`);
  }
  const secrets = secretPaths(config);
  if (secrets.length) {
    throw new Error(
      `config.json holds what looks like a real credential: ${secrets.join(", ")} (8 characters or more). ` +
        "Every copy of the build would carry it. Put real credentials in config.local.json (gitignored, never packaged) " +
        "and keep a placeholder shorter than 8 characters, such as \"abc\", in config.json.",
    );
  }
  if (!allowMock) {
    const local = configUrls(config).filter((u) => isLoopbackUrl(u.url));
    if (local.length) {
      throw new Error(
        `config.json points DocLink at this PC (${local.map((u) => `${u.key} ${u.url}`).join(", ")}): a production build must not. ` +
          "Point it at the real systems, or run `npm run build -- --allow-mock` for a test build.",
      );
    }
  }
  const ecm = config.ecm || {};
  if (config.ecmBackendAws !== true && (isPlaceholder(ecm.clientId) || isPlaceholder(ecm.clientSecret))) {
    log(
      "  WARNING config.json sends ECM documents straight to the ECM (ecmBackendAws: false) with placeholder\n" +
        "          client credentials, and config.local.json is never packaged: Save to ECM will fall back\n" +
        "          to local saves. Set \"ecmBackendAws\": true to go through the Recon Engine gateway.",
    );
  }
  return config;
}

/**
 * The built manifest's host_permissions. A test build keeps manifest.json's. A production build drops
 * every pattern for this PC (localhost, 127.0.0.1, [::1]) and the mock portal's, keeps the rest (the
 * ECM's plain-HTTP domain included), and must still cover each URL DocLink sends requests to: DocLink
 * refuses to call an origin missing from host_permissions.
 */
function buildHostPermissions(patterns, config, { allowMock }) {
  const covers = (list, url) => compileMatchPatterns(list)(url);
  const needed = configUrls(config).filter((u) => u.fetched);
  const mockPortal = config.mockBaseUrl || DEFAULT_MOCK_PORTAL;
  const kept = allowMock
    ? patterns
    : patterns.filter(
        (pattern) =>
          !LOOPBACK_HOST.test(patternHost(pattern)) &&
          // the mock portal served from another machine: dropped too, unless a URL in use needs the pattern
          (!covers([pattern], mockPortal) || needed.some((u) => covers([pattern], u.url))),
      );
  const missing = needed.filter((u) => !covers(kept, u.url));
  if (missing.length) {
    const text = `manifest.json host_permissions do not cover ${missing.map((u) => `${u.key} ${u.url}`).join(", ")}: DocLink would refuse to call it.`;
    if (!allowMock) throw new Error(`${text} Add the origin to host_permissions, or fix config.json.`);
    log(`  WARNING ${text}`);
  }
  if (!allowMock) {
    const plain = kept.filter((p) => /^http:\/\//i.test(p));
    if (plain.length) log(`  WARNING plain-HTTP host permission kept: ${plain.join(", ")}. Requests to it are not encrypted.`);
  }
  return kept;
}

/** The commit the build is made from: "abc1234", "abc1234-dirty" (uncommitted changes) or "unknown" (no git). */
function sourceCommit() {
  const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    const sha = git("rev-parse", "--short", "HEAD");
    // read-only: --no-optional-locks keeps `git status` from rewriting the index
    const dirty = git("--no-optional-locks", "status", "--porcelain") !== "";
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return "unknown";
  }
}

/** manifest.json for the build: the build's host_permissions, and version_name (chrome://extensions shows it). */
function writeManifest(manifest, { hostPermissions, versionName }) {
  const out = {};
  for (const [key, value] of Object.entries(manifest)) {
    if (key === "version_name") continue;
    out[key] = key === "host_permissions" ? hostPermissions : value;
    if (key === "version") out.version_name = versionName;
  }
  writeFileSync(join(OUT, "manifest.json"), `${JSON.stringify(out, null, 2)}\n`);
  log(`  wrote                 manifest.json (version_name "${versionName}")`);
}

/** What was built from what. No time stamp, so a rebuild of the same commit gives the same file. */
function writeBuildInfo(info) {
  writeFileSync(join(OUT, "build-info.json"), `${JSON.stringify(info, null, 2)}\n`);
  log("  wrote                 build-info.json");
}

function copyStatic() {
  for (const rel of STATIC_FILES) {
    cpSync(join(ROOT, rel), join(OUT, rel), { recursive: true });
    log(`  copied                ${rel}`);
  }
}

/** Local time as YYYYMMDD-HHMMSS, so every build gets its own zip. */
function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

function zip(version) {
  const zipName = `doclink-${version}-${timestamp()}.zip`;
  // -r recurse, -X drop macOS extended attrs, run from dist/ so paths are relative.
  execFileSync("zip", ["-r", "-X", zipName, "doclink"], {
    cwd: DIST,
    stdio: "ignore",
  });
  return zipName;
}

async function main() {
  const { allowMock, logLevel } = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const commit = sourceCommit();
  const kind = allowMock ? "test build (--allow-mock)" : "production build";
  const versionName = `${manifest.version} (${commit}${allowMock ? ", test build" : ""})`;

  log(`Building DocLink ${manifest.version} (${commit}) -> dist/doclink/`);
  if (pkg.version && pkg.version !== manifest.version) {
    log(`  WARNING package.json version ${pkg.version} differs from manifest.json version ${manifest.version}`);
  }
  const config = checkConfig({ allowMock });
  log(`  config.json target    ${config.target}`);
  const hostPermissions = buildHostPermissions(manifest.host_permissions || [], config, { allowMock });
  log(`  ${kind}, log level ${logLevel}`);
  log(`  host_permissions      ${hostPermissions.join("  ")}`);
  // Only clear the unpacked folder; earlier zips in dist/ are kept.
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  for (const entry of ENTRY_POINTS) {
    await bundleAndProtect(entry, logLevel);
  }
  await bundleAndProtectTogether(PANEL_ENTRY_POINTS, logLevel);
  copyStatic();
  writeManifest(manifest, { hostPermissions, versionName });
  writeBuildInfo({
    name: manifest.name,
    version: manifest.version,
    commit,
    build: allowMock ? "test (--allow-mock)" : "production",
    target: config.target,
    logLevel,
  });

  const zipName = zip(manifest.version);
  log("");
  log("Done.");
  log(`  Unpacked folder : dist/doclink/`);
  log(`  Zip to share    : dist/${zipName}`);
  log("");
  log("Tell the recipient: chrome://extensions -> Developer mode ON ->");
  log("Load unpacked -> pick the unzipped doclink/ folder.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

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
 * assets, manifest.json and config.json are copied unchanged. The source
 * tree is never modified.
 *
 * config.json is checked first: a build ships "target": "real" (pass
 * --allow-mock to build against the mock portal on purpose), and direct ECM
 * mode with placeholder credentials is reported.
 *
 * The obfuscator settings avoid selfDefending / debugProtection, which rely on
 * Function() and would be blocked by the Manifest V3 content-security-policy.
 *
 * Usage: npm install && npm run build            (npm run build -- --allow-mock)
 */
import { build } from "esbuild";
import obfuscator from "javascript-obfuscator";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

/** Files copied verbatim (no JS to protect, or needed as-is at runtime). */
const STATIC_FILES = [
  "manifest.json",
  "config.json",
  "assets",
  "background/offscreen.html",
  "popup/popup.html",
  "popup/popup.css",
  "pages/preview.html",
  "pages/preview.css",
  "tender/tender.css",
];

const OBFUSCATOR_OPTIONS = {
  compact: true,
  identifierNamesGenerator: "hexadecimal",
  renameGlobals: false,
  stringArray: true,
  stringArrayEncoding: ["base64"],
  stringArrayThreshold: 0.75,
  splitStrings: true,
  splitStringsChunkLength: 10,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.4,
  numbersToExpressions: true,
  simplify: true,
  selfDefending: false,
  debugProtection: false,
  disableConsoleOutput: false,
};

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

const ESBUILD_OPTIONS = {
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome116",
  minify: true,
  legalComments: "none",
  write: false,
};

function protect(code) {
  return obfuscator.obfuscate(code, OBFUSCATOR_OPTIONS).getObfuscatedCode();
}

async function bundleAndProtect(entry) {
  const outFile = join(OUT, entry);
  mkdirSync(dirname(outFile), { recursive: true });
  const result = await build({ ...ESBUILD_OPTIONS, entryPoints: [join(ROOT, entry)] });
  writeFileSync(outFile, protect(result.outputFiles[0].text));
  log(`  bundled + obfuscated  ${entry}`);
}

/** Several entry points of one page: shared modules go to chunks/ once, imported by each entry. */
async function bundleAndProtectTogether(entries) {
  const result = await build({
    ...ESBUILD_OPTIONS,
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

/** Stop a build that would ship the wrong IREPS target; report ECM settings that cannot work. */
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
  }
  const ecm = config.ecm || {};
  const placeholder = (v) => !v || String(v).trim().length < 8;
  if (config.ecmBackendAws !== true && (placeholder(ecm.clientId) || placeholder(ecm.clientSecret))) {
    log(
      "  WARNING config.json sends ECM documents straight to the ECM (ecmBackendAws: false) with placeholder\n" +
        "          client credentials, and config.local.json is never packaged: Save to ECM will fall back\n" +
        "          to local saves. Set \"ecmBackendAws\": true to go through the Recon Engine gateway.",
    );
  }
  return config;
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
  const manifest = JSON.parse(
    readFileSync(join(ROOT, "manifest.json"), "utf8"),
  );

  log(`Building DocLink ${manifest.version} -> dist/doclink/`);
  const config = checkConfig({ allowMock: process.argv.includes("--allow-mock") });
  log(`  config.json target    ${config.target}`);
  // Only clear the unpacked folder; earlier zips in dist/ are kept.
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  for (const entry of ENTRY_POINTS) {
    await bundleAndProtect(entry);
  }
  await bundleAndProtectTogether(PANEL_ENTRY_POINTS);
  copyStatic();

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

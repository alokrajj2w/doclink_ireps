/**
 * The one reader of DocLink's hand-edited settings: config.json with config.local.json
 * (gitignored, never packaged) over it. Every settings loader builds on readConfigFiles():
 * loadIrepsConfig (services/ireps-api.js), loadReconConfig (services/recon-service.js),
 * loadEcmConfig (services/ecm-config.js) and loadDownloadLogConfig (services/download-log.js).
 * Each keeps its own cache and its own "keep the current settings on error" rule.
 *
 * Merge rule: a top-level key of config.local.json replaces config.json's; the `ecm`
 * object is merged key by key (so the real ECM client id / secret can live alone in
 * config.local.json).
 *
 * Both files are part of the loaded extension and only change when it is reloaded, so they
 * are read once per page / worker (the four loaders share that read; `force` reads again).
 * A missing config.local.json is normal; one that is present but not valid JSON is reported
 * as an error, never silently treated as missing.
 */

import { logger } from "./logger.js";

/** config.local.json over config.json: top-level keys replace, `ecm` merges key by key. */
export function mergeConfig(base, local) {
  const b = base && typeof base === "object" ? base : {};
  const l = local && typeof local === "object" ? local : {};
  const merged = { ...b, ...l };
  if (b.ecm || l.ecm) merged.ecm = { ...(b.ecm || {}), ...(l.ecm || {}) };
  return merged;
}

function extensionUrl(name) {
  return typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL ? chrome.runtime.getURL(name) : `./${name}`;
}

/** " (at position 123, line 5 column 10)" from a JSON SyntaxError, or "": the place only, never the quoted text. */
export function jsonErrorPlace(error) {
  const message = String((error && error.message) || "");
  const position = /\bposition (\d+)/i.exec(message);
  const line = /\bline (\d+) column (\d+)/i.exec(message);
  if (!position && !line) return "";
  return ` (at ${[position ? `position ${position[1]}` : "", line ? `line ${line[1]} column ${line[2]}` : ""].filter(Boolean).join(", ")})`;
}

async function readJson(name, { optional = false } = {}) {
  let response;
  try {
    response = await fetch(extensionUrl(name), { cache: "no-store" });
  } catch (error) {
    // a missing config.local.json makes fetch throw for extension URLs
    if (!optional) logger.warn(`Could not read ${name}`, error);
    return null;
  }
  if (response && response.ok === false) {
    if (!optional) logger.warn(`Could not read ${name} (HTTP ${response.status})`);
    return null;
  }
  let parsed;
  try {
    parsed = await response.json();
  } catch (error) {
    // the file is there but broken: say so (its settings, e.g. the real ECM credentials, are not applied).
    // Never the parser's message: it quotes the text around the mistake, which can be part of a secret.
    logger.error(`${name} is not valid JSON${jsonErrorPlace(error)}, so it is ignored. Fix it and reload DocLink.`);
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    logger.error(`${name} must hold one JSON object ({ ... }), so it is ignored. Fix it and reload DocLink.`);
    return null;
  }
  return parsed;
}

let cached = null;

/**
 * config.json with config.local.json over it (mergeConfig), plus the local file's own
 * contents (or null); null when neither file could be read. Read once per page / worker;
 * `force` reads the files again. A failed read is not kept, so the next call tries again.
 * @param {{ force?: boolean }} [options]
 * @returns {Promise<{ config: object, local: object|null } | null>}
 */
export function readConfigFiles({ force = false } = {}) {
  if (cached && !force) return cached;
  const reading = (async () => {
    const base = await readJson("config.json");
    const local = await readJson("config.local.json", { optional: true });
    return base || local ? { config: mergeConfig(base, local), local } : null;
  })();
  cached = reading;
  reading.then((files) => {
    if (!files && cached === reading) cached = null;
  });
  return reading;
}

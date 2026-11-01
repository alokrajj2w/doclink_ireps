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

async function readJson(name, { optional = false } = {}) {
  try {
    const response = await fetch(extensionUrl(name), { cache: "no-store" });
    if (response && response.ok === false) {
      if (!optional) logger.warn(`Could not read ${name} (HTTP ${response.status})`);
      return null;
    }
    return await response.json();
  } catch (error) {
    // a missing config.local.json makes fetch throw for extension URLs
    if (!optional) logger.warn(`Could not read ${name}`, error);
    return null;
  }
}

/**
 * config.json with config.local.json over it (mergeConfig), plus the local file's own
 * contents (or null); null when neither file could be read.
 * @returns {Promise<{ config: object, local: object|null } | null>}
 */
export async function readConfigFiles() {
  const base = await readJson("config.json");
  const local = await readJson("config.local.json", { optional: true });
  return base || local ? { config: mergeConfig(base, local), local } : null;
}

/**
 * Checks DocLink's ECM catalog (services/ecm-catalog.js) against the live ECM. The ECM's schema is
 * the source of truth: a document naming a property the ECM lacks is refused (HTTP 400 "No such
 * property") and saved locally. Run it before a field or kind is added or shipped, on TEST and
 * on PROD.
 *
 *   node scripts/check-ecm-schema.mjs
 *
 * It uses DocLink's ECM settings (config.json, overridden by config.local.json, where the client
 * id / secret go), asks for a token the way services/ecm-direct.js does, and reads two things:
 *   GET {domain}/nuxeo/api/v1/config/schemas/InvoiceCertificateSchema       the properties
 *   GET {domain}/nuxeo/api/v1/directory/invoice_certificate_document_types  the document types
 * Nothing is written. It prints property names and types, never the client secret or the token.
 * Exit code: 0 every property and type DocLink uses exists, 1 something is missing, 2 no check made.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mergeConfig } from "../utils/config.js";
import { ECM_FIELDS, ECM_KINDS } from "../services/ecm-catalog.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA = "InvoiceCertificateSchema";
const VOCABULARY = "invoice_certificate_document_types";

/**
 * Which of DocLink's properties the schema has.
 * @param {{ name?: string, "@prefix"?: string, fields?: Object<string, *> }} schema  the ECM's answer
 * @param {Object<string, string>} [fields]  DocLink field key -> "<schema>:<property>"
 * @returns {{ rows: { key: string, property: string, type: string|null }[], missing: string[], unused: string[] }}
 *          type null: the schema lacks it; unused: the schema's properties DocLink does not send
 */
export function compareSchema(schema, fields = ECM_FIELDS) {
  const prefix = schema["@prefix"] || schema.name;
  const known = schema.fields || {};
  const typeOf = (value) => (typeof value === "string" ? value : (value && value.type) || "complex");
  const rows = Object.entries(fields).map(([key, property]) => {
    const [owner, name] = property.split(":");
    return { key, property, type: owner === prefix && Object.hasOwn(known, name) ? typeOf(known[name]) : null };
  });
  const sent = new Set(rows.map((row) => row.property.split(":")[1]));
  return { rows, missing: rows.filter((row) => !row.type).map((row) => row.key), unused: Object.keys(known).filter((name) => !sent.has(name)).sort() };
}

/**
 * The document types DocLink uses that the ECM's vocabulary lacks.
 * @param {{ entries?: { id?: string, properties?: { id?: string } }[] }} vocabulary  the ECM's answer
 * @param {string[]} [kinds]
 * @returns {string[]}
 */
export function missingKinds(vocabulary, kinds = Object.keys(ECM_KINDS)) {
  const ids = new Set((vocabulary.entries || []).map((entry) => (entry.properties && entry.properties.id) || entry.id));
  return kinds.filter((kind) => !ids.has(kind));
}

/**
 * The check: a token, then the schema and the vocabulary, compared with the catalog.
 * @param {{ domain?: string, env?: string, clientId?: string, clientSecret?: string, timeoutMs?: number }} ecm
 * @param {typeof fetch} [send]
 * @returns {Promise<{ code: number, lines: string[] }>}  code as the exit code above; lines to print
 */
export async function checkEcmSchema(ecm, send = fetch) {
  const domain = String(ecm.domain || "").replace(/\/+$/, "");
  if (!domain || !ecm.clientId || !ecm.clientSecret) return { code: 2, lines: ['No ECM domain or client id / secret: put them in config.local.json under "ecm".'] };
  const deadline = () => AbortSignal.timeout(Number(ecm.timeoutMs) || 60000);
  try {
    const credentials = new URLSearchParams({ grant_type: "client_credentials", client_id: ecm.clientId, client_secret: ecm.clientSecret });
    const tokenAnswer = await send(`${domain}/nuxeo/oauth2/token?${credentials}`, { method: "POST", signal: deadline() });
    if (!tokenAnswer.ok) return { code: 2, lines: [`The ECM refused the token request (HTTP ${tokenAnswer.status}): check the client id / secret in config.local.json.`] };
    const { access_token: token } = await tokenAnswer.json();
    const get = async (path) => {
      const response = await send(`${domain}/nuxeo/api/v1${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: deadline() });
      if (!response.ok) throw new Error(`GET ${path.split("?")[0]} answered HTTP ${response.status}`);
      return response.json();
    };

    const schema = compareSchema(await get(`/config/schemas/${SCHEMA}`));
    const kinds = missingKinds(await get(`/directory/${VOCABULARY}?pageSize=1000`));
    const lines = [
      `ECM ${domain} (${ecm.env || "env not set"}), ${SCHEMA}:`,
      ...schema.rows.map((row) => `  ${row.type ? "ok     " : "MISSING"}  ${row.key.padEnd(27)} ${row.property}${row.type ? ` (${row.type})` : ""}`),
      "",
      `Its other properties: ${schema.unused.join(", ") || "none"}`,
      "",
      `Document types (${VOCABULARY}): ${kinds.length ? `MISSING ${kinds.join(", ")}` : "every type DocLink uses exists"}`
    ];
    return { code: schema.missing.length || kinds.length ? 1 : 0, lines };
  } catch (error) {
    // the message only: a network error's cause would carry the token request's URL
    return { code: 2, lines: [`Check not made: ${error.message}`] };
  }
}

/** DocLink's ECM settings, or the problem with config.local.json (never quoting it: it holds the secret). */
function ecmSettings() {
  const config = JSON.parse(readFileSync(join(root, "config.json"), "utf8"));
  let text = null;
  try {
    text = readFileSync(join(root, "config.local.json"), "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") return { problem: `config.local.json cannot be read (${error.code || "unknown error"})` };
  }
  let local;
  try {
    local = text === null ? null : JSON.parse(text);
  } catch {
    return { problem: "config.local.json is not valid JSON" };
  }
  return { ecm: mergeConfig(config, local).ecm || {} };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const settings = ecmSettings();
  const { code, lines } = settings.problem ? { code: 2, lines: [settings.problem] } : await checkEcmSchema(settings.ecm);
  (code === 2 ? console.error : console.log)(lines.join("\n"));
  process.exitCode = code;
}

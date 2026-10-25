/**
 * What the ECM (Nuxeo) holds, for DocLink's direct upload (services/ecm-direct.js):
 * document kinds, their metadata properties and the folders of each site.
 *
 * A mirror of the Recon Engine's ECM gateway config, restricted to the kinds DocLink
 * uploads - keep the two in step:
 *   recon-engine backend/ECM/ecm_client/config/document_kinds.toml
 *   recon-engine backend/ECM/ecm_client/config/sites.test.toml / sites.prod.toml
 * Sources: "TSG India Doculink ECM specifications.xlsx" sheet "ECM - Download speci-v1",
 * "Download and Upload v1.xlsx" ("Complete_Path", "Query to retrieve"), Henri Jézo's
 * emails of 2026-09-28.
 *
 * Every document is the Nuxeo type InvoiceCertificate; its kind is the value of
 * InvoiceCertificateSchema:type.
 */

import { ECM_ENV } from "./ecm-config.js";

export const DOC_TYPE = "InvoiceCertificate";
export const TYPE_PROPERTY = "InvoiceCertificateSchema:type";

/** Field key (what DocLink sends) -> Nuxeo property. Values are strings; *_date as YYYY-MM-DD. */
export const ECM_FIELDS = Object.freeze({
  invoice_number: "InvoiceCertificateSchema:invoiceNumber",
  customer_po_number: "InvoiceCertificateSchema:customerPONumber",
  ic_number: "InvoiceCertificateSchema:icNumber",
  ic_date: "InvoiceCertificateSchema:icDate",
  co_number: "InvoiceCertificateSchema:coNumber",
  modification_advise_number: "InvoiceCertificateSchema:modificationAdviseNumber",
  tender_number: "InvoiceCertificateSchema:tenderNumber",
  tender_date: "InvoiceCertificateSchema:tenderDate",
  loi_number: "InvoiceCertificateSchema:loiNumber",
  loi_date: "InvoiceCertificateSchema:loiDate"
});

const TENDER_KIND = Object.freeze({ fields: ["tender_number", "tender_date"], required: ["tender_number"], location: "tenders", title: "{tender_number}" });

/**
 * Keyed by ECM_KIND values (services/ecm-service.js; written out here so this module
 * does not import ecm-service.js, which imports the direct upload that imports this).
 * Per kind: fields it may carry, fields an upload must supply, the site location new
 * documents go to, and the dc:title template used when the upload gives no title.
 * "ECM - Download speci-v1" marks more fields mandatory than IREPS supplies, so
 * `required` is what DocLink always has; the rest is sent whenever it is known.
 */
export const ECM_KINDS = Object.freeze({
  inspectionCertificate: { fields: ["invoice_number", "customer_po_number", "ic_number", "ic_date", "co_number"], required: ["ic_number", "customer_po_number"], location: "inputs", title: "{ic_number}" },
  poCopy: { fields: ["customer_po_number"], required: ["customer_po_number"], location: "inputs", title: "{customer_po_number}" },
  modificationAdvise: { fields: ["customer_po_number", "modification_advise_number", "tender_number", "tender_date"], required: ["customer_po_number", "modification_advise_number"], location: "inputs", title: "{modification_advise_number}" },
  nit: TENDER_KIND,
  nbsp: TENDER_KIND,
  extension: TENDER_KIND,
  crp: TENDER_KIND,
  co: TENDER_KIND,
  loi: { ...TENDER_KIND, fields: ["tender_number", "tender_date", "loi_number", "loi_date"] }
});

/**
 * Sites by environment.
 *   siteId       scopes every search (ecm:ancestorId = siteId), as the spreadsheet's queries do
 *   vendorCodes  IREPS account ids whose documents belong here
 *   locations    folder paths (decoded: real spaces)
 *   folderIds    folder uids supplied by the ECM team; an upload goes straight to the uid,
 *                otherwise the path is resolved to one
 */
export const ECM_SITES = Object.freeze({
  [ECM_ENV.TEST]: {
    hosur: {
      name: "Hosur",
      siteId: "ad5090e5-648d-4f75-8c14-7052e8ac3b72",
      vendorCodes: ["833"],
      operatingUnits: ["HOSUR", "HSR"],
      locations: {
        inputs: "/FT/workspaces/Sites/HSR/Invoice Certificate - TS/Inputs",
        tenders: "/FT/workspaces/Sites/HSR/Invoice Certificate - TS/Tenders"
      },
      folderIds: { inputs: "d440070d-3a60-4ad7-bf67-8efeb198e26b", tenders: "aa28acbe-add1-49d3-b0ab-16ab1263996c" }
    },
    rohtak: {
      name: "Rohtak",
      siteId: "34a61f51-10fe-44ce-a669-2ea14dc86ff4",
      vendorCodes: ["60828"],
      operatingUnits: ["ROHTAK", "BRH"],
      locations: {
        inputs: "/FT/workspaces/Sites/BRH - FT India (HPD) - R/Invoice Certificate/Inputs",
        // as the spec writes it ("Invoice Certificate" twice); uploads use the folder uid
        tenders: "/FT/workspaces/Sites/BRH - FT India (HPD) - R/Invoice Certificate/Invoice Certificate - TS/Tenders"
      },
      folderIds: { inputs: "93a37d6e-f3e1-499b-9f10-6ba52f1262bb", tenders: "a6594520-2d2b-4a33-b344-47426e116389" }
    }
  },
  // From "Download and Upload v1.xlsx"; confirm before first PROD use.
  // No PROD tenders folder has been supplied, so tender kinds cannot be uploaded on PROD.
  [ECM_ENV.PROD]: {
    hosur: {
      name: "Hosur",
      siteId: "7dfe3fc0-3157-489d-826a-9435e65631fc",
      vendorCodes: ["833"],
      operatingUnits: ["HOSUR", "HSR"],
      locations: { inputs: "/FT/workspaces/Sites/HSR/Invoice Certificate/Inputs" },
      folderIds: {}
    },
    rohtak: {
      name: "Rohtak",
      siteId: "f2a5bf87-877b-4e4c-b4fc-7301cabfd236",
      vendorCodes: ["60828"],
      operatingUnits: ["ROHTAK", "BRH"],
      locations: { inputs: "/FT/workspaces/Sites/HPD/Invoice Certificate/Input" }, // "Input", singular, as in the spreadsheet
      folderIds: {}
    }
  }
});

/**
 * The site key a document belongs to, from the IREPS account id (vendor code) and/or the
 * operating unit; when both are given they must agree. Throws an Error naming the problem.
 * @returns {string}  e.g. "hosur"
 */
export function routeSite(env, { irepsAccountId, operatingUnit } = {}) {
  const sites = ECM_SITES[env] || {};
  const picks = [];
  const code = String(irepsAccountId ?? "").trim();
  if (code) {
    const key = Object.keys(sites).find((k) => sites[k].vendorCodes.includes(code));
    if (!key) throw new Error(`no ECM site for IREPS account ${code}`);
    picks.push(key);
  }
  const unit = String(operatingUnit ?? "").trim().toUpperCase();
  if (unit) {
    const key = Object.keys(sites).find((k) => sites[k].operatingUnits.includes(unit));
    if (!key) throw new Error(`no ECM site for operating unit ${operatingUnit}`);
    picks.push(key);
  }
  if (picks.length === 0) throw new Error("no IREPS account or operating unit to pick the ECM site");
  if (new Set(picks).size > 1) throw new Error(`IREPS account ${code} and operating unit ${operatingUnit} belong to different ECM sites`);
  return picks[0];
}

/** A kind's title template filled from `values`, or "" when a placeholder has no value. */
export function renderTitle(template, values) {
  if (!template) return "";
  let missing = false;
  const title = template.replace(/\{(\w+)\}/g, (_, key) => {
    const v = values[key];
    if (v === undefined || v === null || String(v).trim() === "") missing = true;
    return String(v ?? "").trim();
  });
  return missing ? "" : title.trim();
}

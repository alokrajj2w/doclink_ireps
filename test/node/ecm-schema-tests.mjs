// scripts/check-ecm-schema.mjs: how the live ECM's schema and document-type answers are read
// against DocLink's catalog (services/ecm-catalog.js).
//   node --test test/node/ecm-schema-tests.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareSchema, missingKinds, checkEcmSchema } from '../../scripts/check-ecm-schema.mjs';
import { ECM_FIELDS, ECM_KINDS } from '../../services/ecm-catalog.js';

const SCHEMA = { 'entity-type': 'schema', name: 'InvoiceCertificateSchema', '@prefix': 'InvoiceCertificateSchema' };

test('ECM schema check: a property DocLink sends that the schema lacks is missing; the others show their type', () => {
  const fields = { ic_number: 'InvoiceCertificateSchema:icNumber', ic_date: 'InvoiceCertificateSchema:icDate', passed_quantity: 'InvoiceCertificateSchema:passedQuantity' };
  const r = compareSchema({ ...SCHEMA, fields: { icNumber: 'string', icDate: 'date', quantity: 'long', files: { type: 'complex[]' } } }, fields);
  assert.deepEqual(r.missing, ['passed_quantity']);
  assert.deepEqual(r.rows.map((row) => row.type), ['string', 'date', null]);
  assert.deepEqual(r.unused, ['files', 'quantity'], "the schema's other properties, to find the right name");
});

test('ECM schema check: a property is only found in its own schema', () => {
  const r = compareSchema({ ...SCHEMA, fields: { monthsGuarantee: 'long' } }, { months_guarantee: 'CustomerCommonSchema:monthsGuarantee' });
  assert.deepEqual(r.missing, ['months_guarantee']);
});

test("ECM schema check: every catalog property is looked up, the IC's PO serial and passed quantity among them", () => {
  const r = compareSchema({ ...SCHEMA, fields: {} });
  assert.deepEqual(r.missing, Object.keys(ECM_FIELDS));
  assert.ok(r.rows.some((row) => row.property === 'InvoiceCertificateSchema:customerPOSrNumber'));
  assert.ok(r.rows.some((row) => row.property === 'InvoiceCertificateSchema:passedQuantity'));
});

test('ECM schema check: document types missing from the vocabulary', () => {
  const vocabulary = { entries: [{ id: 'nit', properties: { id: 'nit', label: 'Tender NIT' } }, { properties: { id: 'poCopy' } }] };
  assert.deepEqual(missingKinds(vocabulary, ['nit', 'poCopy', 'loi']), ['loi']);
  assert.deepEqual(missingKinds({}, ['nit']), ['nit'], 'an answer without entries holds no type');
});

const ECM = { env: 'TEST', domain: 'http://ecm.test:8080/', clientId: 'id-1', clientSecret: 's3cret', timeoutMs: 5000 };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** A fake ECM that knows every catalog property but `lacking`, and every document type. */
function fakeEcm({ lacking = [], token = 200 } = {}) {
  const calls = [];
  const names = Object.values(ECM_FIELDS).map((p) => p.split(':')[1]).filter((name) => !lacking.includes(name));
  const send = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', headers: init.headers || {} });
    const path = new URL(url).pathname;
    if (path === '/nuxeo/oauth2/token') return token === 200 ? json(200, { access_token: 'tok-9', expires_in: 3600 }) : json(token, { error: 'invalid_client' });
    if (path === '/nuxeo/api/v1/config/schemas/InvoiceCertificateSchema') return json(200, { ...SCHEMA, fields: Object.fromEntries([...names, 'quantity'].map((n) => [n, 'string'])) });
    if (path === '/nuxeo/api/v1/directory/invoice_certificate_document_types') return json(200, { entries: Object.keys(ECM_KINDS).map((id) => ({ properties: { id } })) });
    return json(404, {});
  };
  send.calls = calls;
  return send;
}

test('ECM schema check: a token as DocLink asks for it, two reads with it, and a missing property gives exit code 1', async () => {
  const send = fakeEcm({ lacking: ['passedQuantity'] });
  const { code, lines } = await checkEcmSchema(ECM, send);
  assert.equal(code, 1);
  assert.deepEqual(send.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`), [
    'POST /nuxeo/oauth2/token',
    'GET /nuxeo/api/v1/config/schemas/InvoiceCertificateSchema',
    'GET /nuxeo/api/v1/directory/invoice_certificate_document_types'
  ], 'read-only: nothing else is sent');
  assert.equal(send.calls[0].url, 'http://ecm.test:8080/nuxeo/oauth2/token?grant_type=client_credentials&client_id=id-1&client_secret=s3cret');
  assert.ok(send.calls.slice(1).every((c) => c.headers.Authorization === 'Bearer tok-9'));
  assert.ok(lines.some((l) => /MISSING\s+passed_quantity\s+InvoiceCertificateSchema:passedQuantity/.test(l)));
  assert.ok(lines.some((l) => /ok\s+customer_po_serial_number\s+InvoiceCertificateSchema:customerPOSrNumber \(string\)/.test(l)));
  assert.ok(lines.includes('Its other properties: quantity'));
  assert.ok(!lines.join('\n').includes('s3cret') && !lines.join('\n').includes('tok-9'), 'neither the secret nor the token is printed');
});

test('ECM schema check: everything present gives exit code 0', async () => {
  const { code } = await checkEcmSchema(ECM, fakeEcm());
  assert.equal(code, 0);
});

test('ECM schema check: no credentials, a refused token or no answer give exit code 2, without the secret', async () => {
  assert.equal((await checkEcmSchema({ domain: ECM.domain }, fakeEcm())).code, 2);
  const refused = await checkEcmSchema(ECM, fakeEcm({ token: 401 }));
  assert.equal(refused.code, 2);
  assert.match(refused.lines[0], /refused the token request \(HTTP 401\)/);
  const down = await checkEcmSchema(ECM, async (url) => {
    throw Object.assign(new TypeError('fetch failed'), { cause: new Error(`connect ECONNREFUSED ${url}`) });
  });
  assert.equal(down.code, 2);
  assert.equal(down.lines[0], 'Check not made: fetch failed');
  assert.ok(!refused.lines.join().includes('s3cret') && !down.lines.join().includes('s3cret'));
});

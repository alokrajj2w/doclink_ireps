// The stored DocLink log (utils/logger.js) as the service worker keeps it: emptied when a build is loaded
// (background/service-worker.js onInstalled), in turn with the batches already being written, so none of them
// writes the last build's entries back. The logger keeps a stored log only inside an extension (chrome.runtime.id),
// so this file gives it one before loading it.
//   node --test test/node/logger-tests.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const data = {};
globalThis.chrome = {
  runtime: { id: 'doclink-test' },
  storage: {
    local: {
      get: async (key) => (key in data ? { [key]: structuredClone(data[key]) } : {}),
      set: async (items) => {
        await Promise.resolve();
        Object.assign(data, structuredClone(items));
      },
      remove: async (key) => {
        delete data[key];
      },
    },
  },
};
const { appendLogEntries, clearLogEntries, readLogEntries } = await import('../../utils/logger.js');

test('Stored log: emptied after the batches already being written, so none of them writes the old entries back', async () => {
  appendLogEntries([{ t: 1, level: 'info', ctx: 'worker', msg: 'a line of the last build' }]);
  clearLogEntries();
  await appendLogEntries([{ t: 2, level: 'info', ctx: 'worker', msg: 'DocLink installed (update)' }]);
  assert.deepEqual((await readLogEntries()).map((e) => [e.msg, e.seq]), [['DocLink installed (update)', 1]], "only the new build's line, numbered from 1");
});

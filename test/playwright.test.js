import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

test('Playwright adapter repairs an incomplete bundle export left during an in-process plugin upgrade', async () => {
  require('playwright-core');
  const bundlePath = require.resolve('playwright-core/lib/coreBundle');
  const entryPath = require.resolve('playwright-core');
  const originalExports = require.cache[bundlePath].exports;
  try {
    require.cache[bundlePath].exports = {};
    delete require.cache[entryPath];
    const { chromium } = await import('../src/playwright.js');
    assert.equal(chromium.name(), 'chromium');
    assert.equal(typeof chromium.connectOverCDP, 'function');
  } finally {
    if (require.cache[bundlePath]) require.cache[bundlePath].exports = originalExports;
  }
});

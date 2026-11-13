import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '../src/playwright.js';
import { findBrowser } from '../src/browser.js';
import { setPageControlMarker } from '../chrome-extension/page-marker.js';

async function open(title) {
  const browser = await chromium.launch({ executablePath: await findBrowser(), headless: true });
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html><head><title>${title}</title></head><body><p>page</p></body></html>`);
  await page.evaluate(() => {
    const NativeObserver = MutationObserver;
    window.markerCallbacks = 0;
    window.MutationObserver = class extends NativeObserver {
      constructor(callback) {
        super((records, observer) => { window.markerCallbacks++; callback(records, observer); });
      }
    };
  });
  return { browser, page };
}
const enable = page => page.evaluate(setPageControlMarker, true);
const disable = page => page.evaluate(setPageControlMarker, false);

test('empty title is marked without an observer feedback loop', { timeout: 30000 }, async () => {
  const { browser, page } = await open('');
  try {
    await enable(page);
    await page.waitForTimeout(120);
    const state = await page.evaluate(() => ({ title: document.title, callbacks: window.markerCallbacks, badges: document.querySelectorAll('[data-dsh-controlled]').length }));
    assert.equal(state.title, '【被接管】');
    assert.equal(state.badges, 1);
    assert.ok(state.callbacks < 10, `marker refreshed ${state.callbacks} times`);
    await enable(page);
    assert.equal(await page.locator('[data-dsh-controlled]').count(), 1);
    await disable(page);
    assert.equal(await page.title(), '');
    assert.equal(await page.locator('[data-dsh-controlled]').count(), 0);
  } finally { await browser.close(); }
});

test('SPA title changes keep exactly one owned prefix and restore on release', { timeout: 30000 }, async () => {
  const { browser, page } = await open('JumpServer');
  try {
    await enable(page);
    await page.evaluate(() => { document.title = 'Web终端 - JumpServer'; });
    await page.waitForTimeout(50);
    assert.equal(await page.title(), '【被接管】 Web终端 - JumpServer');
    await page.evaluate(() => { document.title = '【被接管】 【被接管】 Web终端'; });
    await page.waitForTimeout(50);
    assert.equal(await page.title(), '【被接管】 Web终端');
    await disable(page);
    assert.equal(await page.title(), 'Web终端');
    assert.equal(await page.locator('[data-dsh-controlled]').count(), 0);
  } finally { await browser.close(); }
});

test('ordinary content mutations do not churn the marker', { timeout: 30000 }, async () => {
  const { browser, page } = await open('Board');
  try {
    await enable(page);
    const before = await page.evaluate(() => window.markerCallbacks);
    await page.evaluate(() => {
      const target = document.querySelector('p');
      for (let index = 0; index < 100; index += 1) target.textContent = String(index);
    });
    await page.waitForTimeout(50);
    const after = await page.evaluate(() => window.markerCallbacks);
    assert.ok(after - before < 5, `marker observed ${after - before} irrelevant mutations`);
    assert.equal(await page.title(), '【被接管】 Board');
  } finally { await browser.close(); }
});

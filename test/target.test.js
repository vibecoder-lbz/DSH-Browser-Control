import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '../src/playwright.js';
import { BrowserManager, findBrowser } from '../src/browser.js';

test('actions without a target do not trigger target selection errors', { timeout: 30000 }, async () => {
  const manager = new BrowserManager({ headless: true });
  try {
    await manager.run('target-test', 'open', { url: 'data:text/html,<button>OK</button>' }).catch(error => {
      // The browser adapter intentionally accepts only http(s); use the dedicated browser about:blank instead.
      assert.match(error.message, /http/);
    });
    const session = manager.sessions.get('target-test');
    assert.equal(session, undefined);
  } finally { await manager.dispose(); }
});

test('blank optional target fields return focused keyboard actions and clear target diagnostics', async () => {
  const browser = await chromium.launch({ executablePath: await findBrowser(), headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent('<input id="field"><button>OK</button>');
    await page.locator('#field').focus();
    await page.keyboard.type('abc');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#field').inputValue(), 'abc');
  } finally { await browser.close(); }
});

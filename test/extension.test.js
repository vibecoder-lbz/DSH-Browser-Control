import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, access, rm, mkdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { BrowserManager } from '../src/browser.js';
import { startFixture } from './fixture.mjs';
import { startTerminalFixture } from './terminal-fixture.mjs';

const project = path.resolve(import.meta.dirname, '..');
async function availableBrowser() {
  const candidates = [process.env.EXTENSION_TEST_BROWSER, chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'];
  for (const candidate of candidates.filter(Boolean)) { try { await access(candidate, constants.F_OK); return candidate; } catch {} }
  throw new Error('No extension-capable test browser. Run PLAYWRIGHT_BROWSERS_PATH=.browsers playwright-core install chromium first.');
}

async function startChrome(extensionPath, profileDir) {
  const executable = await availableBrowser();
  const child = spawn(executable, [
    `--user-data-dir=${profileDir}`, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--enable-unsafe-extension-debugging',
    `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  let launchError;
  child.once('error', error => { launchError = error; });
  const exited = new Promise(resolve => { child.once('error', resolve); child.once('exit', resolve); });
  const close = async () => {
    if (child.exitCode === null) child.kill();
    await exited;
  };
  try {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (launchError) throw launchError;
      if (child.exitCode !== null) throw new Error('Extension test browser exited.');
      try {
        const [port, wsPath] = (await readFile(path.join(profileDir, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/u);
        if (port && wsPath) return { endpoint: `ws://127.0.0.1:${port}${wsPath}`, child, close };
      } catch (error) { if (!['ENOENT', 'EBUSY'].includes(error.code)) throw error; }
      await delay(100);
    }
    throw new Error('Extension test browser launch timed out.');
  } catch (error) { await close(); throw error; }
}

test('real extension connects without token and controls labelled copies without changing original tabs or active focus', { timeout: 120000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-extension-test-'));
  const fixture = await startFixture();
  const terminalFixture = await startTerminalFixture();
  const manager = new BrowserManager({ bridgePort: 0, headless: true });
  let userChrome;
  let inspector;
  try {
    const status = await manager.run('agent', 'connect', { action: 'status' });
    userChrome = await startChrome(path.join(project, 'chrome-extension'), path.join(root, 'chrome-profile'));
    inspector = await chromium.connectOverCDP(userChrome.endpoint, { noDefaults: true, timeout: 15000 });
    const context = inspector.contexts()[0];
    let worker;
    const workerDeadline = Date.now() + 15000;
    while (!worker && Date.now() < workerDeadline) {
      for (const candidate of context.serviceWorkers()) {
        const name = await candidate.evaluate(() => chrome.runtime.getManifest().name).catch(() => '');
        if (name === 'DSH 当前标签页控制') { worker = candidate; break; }
      }
      if (!worker) await delay(100);
    }
    assert.ok(worker, 'Expected DSH extension service worker');
    const extensionId = new URL(worker.url()).host;
    // Install the probe before creating test pages so their setup activations are observed and cleared.
    await worker.evaluate(() => {
      globalThis.focusProbe = [];
      chrome.tabs.onActivated.addListener(info => {
        void chrome.tabs.get(info.tabId).then(tab => globalThis.focusProbe.push({ type: 'activated', at: Date.now(), ...info, title: tab.title, url: tab.url })).catch(() => {});
      });
      chrome.windows.onCreated.addListener(info => globalThis.focusProbe.push({ type: 'window-created', id: info.id }));
      chrome.windows.onFocusChanged.addListener(id => globalThis.focusProbe.push({ type: 'window-focused', id }));
    });
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html`);
    const configured = await options.evaluate(async ({ bridgeUrl }) => chrome.runtime.sendMessage({ type: 'connect', settings: { bridgeUrl } }), {
      bridgeUrl: status.bridgeUrl,
    });
    assert.equal(configured.ok, true, JSON.stringify(configured));
    const app = await context.newPage();
    await app.goto(fixture.url);
    await app.evaluate(() => { document.title = 'Existing application'; document.querySelector('#name').value = 'Saved login context'; localStorage.setItem('existing-session', 'retained'); });
    const terminalPage = await context.newPage();
    await terminalPage.goto(terminalFixture.url);
    await terminalPage.evaluate(() => { document.title = 'JumpServer existing session'; });
    for (const frame of terminalPage.frames().filter(frame => frame.url().includes('/ssh'))) await frame.waitForFunction(() => window.fixtureReady);
    await delay(400);
    await worker.evaluate(() => { globalThis.focusProbe = []; });
    const focusedWindowId = await worker.evaluate(async () => (await chrome.windows.getLastFocused()).id);
    // Stop the test inspector before the extension takes control, matching a normal browser without debugging enabled.
    await inspector.close(); inspector = undefined;
    const ops = [];
    const mark = label => ops.push({ label, at: Date.now() });
    mark('probe-ready');
    const deadline = Date.now() + 10000;
    while (!manager.bridge.connected && Date.now() < deadline) await delay(100);
    assert.equal(manager.bridge.connected, true);
    const listing = await manager.run('agent', 'connect', { action: 'list' });
    const originalTabId = listing.tabs.find(tab => tab.title === 'Existing application').id;
    const originalSshId = listing.tabs.find(tab => tab.title === 'JumpServer existing session').id;
    const activeId = listing.tabs.find(tab => tab.active).id;
    mark('select-app-start');
    const result = await manager.run('agent', 'connect', { action: 'select', query: 'Existing application', tabId: '', screenshot: true });
    mark('select-app-done');
    assert.equal(result.selection.matched, true);
    assert.equal(result.controlledCopy, true);
    assert.equal(result.sourceTab, originalTabId);
    assert.notEqual(result.selectedTab, originalTabId);
    assert.match(result.title, /被接管/);
    assert.ok(result.screenshot?.data || result.screenshotNotice);
    if (process.env.SAVE_BROWSER_DEMO === '1' && result.screenshot?.data) {
      await mkdir(path.join(project, '.artifacts'), { recursive: true });
      await writeFile(path.join(project, '.artifacts', 'controlled-copy.png'), Buffer.from(result.screenshot.data, 'base64'));
    }
    const controlledId = result.selectedTab;
    const originalState = (await manager.bridge.listTabs()).find(tab => `chrome-${tab.id}` === originalTabId);
    assert.equal(originalState.title, 'Existing application');
    const copyState = (await manager.bridge.listTabs()).find(tab => `chrome-${tab.id}` === result.selectedTab);
    assert.equal(copyState.windowId, originalState.windowId);
    assert.equal(copyState.active, false);
    assert.equal(await manager.sessions.get('agent').session.page.locator('[data-dsh-controlled]').count(), 1);
    assert.equal((await manager.bridge.listTabs()).find(tab => tab.active).id, Number(activeId.replace('chrome-', '')));
    await assert.rejects(manager.run('another-agent', 'connect', { action: 'select', tabId: controlledId }), /another DSH session/);
    await assert.rejects(manager.run('agent', 'tabs', { action: 'close', tabId: originalTabId }), /Original user tabs/);
    await manager.run('agent', 'act', { action: 'fill', selector: '#name', text: 'Copy browser assistant' });
    const submitted = await manager.run('agent', 'act', { action: 'click', selector: '#submit' });
    assert.match(submitted.frames[0].text, /已提交：Copy browser assistant/);
    assert.equal(await manager.sessions.get('agent').session.page.locator('[data-dsh-cursor]').count(), 1);
    const sameCopy = await manager.run('agent', 'connect', { action: 'select', query: 'Existing application' });
    assert.equal(sameCopy.selectedTab, controlledId);
    assert.equal((await manager.bridge.listTabs()).filter(tab => tab.controlled).length, 1);
    mark('select-ssh-start');
    let ssh = await manager.run('agent', 'connect', { action: 'select', query: 'JumpServer' });
    mark('select-ssh-done');
    assert.equal(ssh.selection.matched, true);
    assert.equal(ssh.sourceTab, originalSshId);
    const sshCopyId = ssh.selectedTab;
    const copyPage = manager.sessions.get('agent').session.page;
    for (const frame of copyPage.frames().filter(frame => frame.url().includes('/ssh'))) await frame.waitForFunction(() => window.fixtureReady);
    const terminals = await manager.run('agent', 'terminal', { action: 'list' });
    assert.equal(terminals.terminals.length, 1);
    const terminalId = terminals.terminals[0].terminalId;
    await manager.run('agent', 'terminal', { action: 'type', terminalId, text: 'kubectl config current-context' });
    mark('terminal-type-done');
    await manager.run('agent', 'terminal', { action: 'press', terminalId, key: 'Enter' });
    mark('terminal-enter-done');
    ssh = await manager.run('agent', 'terminal', { action: 'wait', terminalId, waitForText: 'test-cluster-one', timeoutMs: 5000 });
    assert.equal(ssh.wait.matched, true);
    const otherCopy = await manager.run('another-agent', 'connect', { action: 'select', tabId: originalTabId });
    assert.equal(otherCopy.selectedTab, controlledId);
    assert.equal((await manager.bridge.listTabs()).filter(tab => tab.controlled && `chrome-${tab.sourceTabId}` === originalTabId).length, 1);
    await assert.rejects(manager.run('agent', 'tabs', { action: 'close', tabId: otherCopy.selectedTab }), /another DSH session/);
    await manager.run('another-agent', 'close');
    const controller = new AbortController();
    const waiting = manager.run('agent', 'terminal', { action: 'wait', terminalId, timeoutMs: 10000 }, { signal: controller.signal });
    const cancel = setTimeout(() => controller.abort(new Error('cancel attached wait')), 100);
    await assert.rejects(waiting, /cancel attached wait/);
    clearTimeout(cancel);
    assert.equal(userChrome.child.exitCode, null);
    await manager.run('agent', 'connect', { action: 'select', tabId: originalTabId });
    const detached = await manager.run('agent', 'close');
    assert.equal(detached.detached, true);
    const reconnects = await Promise.all(Array.from({ length: 3 }, () => manager.run('agent', 'connect', { action: 'select', tabId: originalTabId })));
    assert.ok(reconnects.every(result => result.selectedTab === controlledId));
    await assert.rejects(manager.run('another-agent', 'connect', { action: 'select', tabId: originalTabId }), /another DSH session/);
    await manager.run('agent', 'close');
    assert.equal(userChrome.child.exitCode, null);
    const after = await manager.run('agent', 'connect', { action: 'list' });
    assert.ok(after.tabs.some(tab => tab.id === originalTabId));
    inspector = await chromium.connectOverCDP(userChrome.endpoint, { noDefaults: true, timeout: 15000 });
    const finalWorker = inspector.contexts()[0].serviceWorkers().find(candidate => candidate.url().includes(extensionId));
    const focusEvents = await finalWorker.evaluate(() => globalThis.focusProbe);
    assert.deepEqual(focusEvents, [], `Browser UI changed during background work: ${JSON.stringify(focusEvents)}; ops=${JSON.stringify(ops)}; source=${originalSshId} sshCopy=${sshCopyId} active=${activeId}`);
    // Copies deliberately share URLs; verify exact Chrome tab IDs instead of choosing a page by URL.
    const inspectTab = tabId => finalWorker.evaluate(async id => {
      const results = await chrome.scripting.executeScript({ target: { tabId: Number(id.replace('chrome-', '')), allFrames: true }, world: 'MAIN', func: () => ({
        title: document.title, name: document.querySelector('#name')?.value,
        result: document.querySelector('#result')?.textContent, saved: localStorage.getItem('existing-session'),
        markers: document.querySelectorAll('[data-dsh-controlled]').length,
        executed: window.executed,
      }) });
      return results.map(item => item.result);
    }, tabId);
    const preserved = (await inspectTab(originalTabId))[0];
    assert.equal(preserved.saved, 'retained');
    assert.equal(preserved.name, 'Saved login context');
    assert.equal(preserved.title, 'Existing application');
    assert.equal(preserved.result, '等待填写');
    assert.equal(preserved.markers, 0);
    const copied = (await inspectTab(controlledId))[0];
    assert.equal(copied.name, 'Copy browser assistant');
    assert.equal(copied.markers, 0);
    const originalSshFrames = await inspectTab(originalSshId);
    assert.deepEqual(originalSshFrames.find(frame => Array.isArray(frame.executed)).executed, []);
    assert.equal((await manager.bridge.listTabs()).find(tab => tab.active).id, Number(activeId.replace('chrome-', '')));
    assert.equal(await finalWorker.evaluate(async () => (await chrome.windows.getLastFocused()).id), focusedWindowId);
  } finally {
    await manager.dispose();
    await inspector?.close().catch(() => {});
    await userChrome?.close();
    await fixture.close(); await terminalFixture.close();
    // root is the exact mkdtemp directory owned by this test.
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

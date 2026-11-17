import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { BrowserManager, validateUrl } from '../src/browser.js';
import { startFixture } from './fixture.mjs';

let fixture;
let profiles;
before(async () => {
  fixture = await startFixture();
  profiles = await mkdtemp(path.join(tmpdir(), 'dsh-browser-tests-'));
});
after(async () => {
  if (process.env.DEBUG_BROWSER_TEST) console.log('Resources before fixture cleanup:', process.getActiveResourcesInfo());
  await fixture?.close();
  if (process.env.DEBUG_BROWSER_TEST) console.log('Resources after fixture cleanup:', process.getActiveResourcesInfo());
  // profiles is the exact temporary test directory allocated above.
  if (profiles) await rm(profiles, { recursive: true, force: true });
});
const options = () => ({ headless: true, profileRoot: profiles, actionTimeoutMs: 4000 });
const refFor = (observation, name) => {
  const element = observation.elements.find(element => element.name === name);
  assert.ok(element, `Expected element with accessible name ${name}`);
  return element.ref;
};

test('real browser: form, fresh refs, frame/shadow targets, screenshots, tabs and cleanup', { timeout: 60000 }, async () => {
  const manager = new BrowserManager(options());
  try {
    let observation = await manager.run('form-session', 'open', { url: fixture.url, screenshot: true });
    assert.equal(observation.viewport.width, 1280);
    assert.equal(observation.screenshot.mimeType, 'image/png');
    const png = Buffer.from(observation.screenshot.data, 'base64');
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(png.readUInt32BE(16), 1280);
    assert.equal(png.readUInt32BE(20), 800);
    assert.equal(observation.elements.find(el => el.name === '测试密码').value, '[password hidden]');
    const staleRef = refFor(observation, '提交演示');
    observation = await manager.run('form-session', 'act', { action: 'fill', ref: refFor(observation, '姓名'), text: '浏览器助手' });
    await assert.rejects(manager.run('form-session', 'act', { action: 'click', ref: staleRef }), /Stale or unknown/);
    observation = await manager.run('form-session', 'act', { action: 'select', ref: refFor(observation, '城市'), value: 'bj' });
    observation = await manager.run('form-session', 'act', { action: 'click', ref: refFor(observation, '提交演示') });
    assert.match(observation.frames[0].text, /已提交：浏览器助手 \/ 北京/);
    assert.equal(await manager.sessions.get('form-session').session.page.locator('[data-dsh-cursor]').count(), 1);
    observation = await manager.run('form-session', 'act', { action: 'click', ref: refFor(observation, 'Shadow 按钮') });
    assert.ok(observation.elements.some(el => el.name === 'Shadow 已点击'));
    assert.ok(observation.frames.some(frame => frame.url.endsWith('/frame')));
    observation = await manager.run('form-session', 'act', { action: 'fill', ref: refFor(observation, '内嵌输入'), text: 'iframe text' });
    assert.equal(observation.elements.find(el => el.name === '内嵌输入').value, 'iframe text');
    observation = await manager.run('form-session', 'act', { action: 'click', ref: refFor(observation, '内嵌按钮') });
    assert.ok(observation.elements.some(el => el.name === '内嵌已点击'));
    observation = await manager.run('form-session', 'act', { action: 'click', selector: '#alert' });
    assert.ok(observation.events.some(event => event.type === 'dialog-dismissed'));
    const firstTab = observation.activeTab;
    observation = await manager.run('form-session', 'tabs', { action: 'new', url: fixture.url + '/popup' });
    assert.equal(observation.title, 'Popup');
    assert.equal(observation.tabs.length, 2);
    const secondTab = observation.activeTab;
    observation = await manager.run('form-session', 'tabs', { action: 'switch', tabId: firstTab });
    assert.equal(observation.activeTab, firstTab);
    assert.match(observation.frames[0].text, /已提交：浏览器助手/);
    observation = await manager.run('form-session', 'tabs', { action: 'new', url: fixture.url + '/popup' });
    const thirdTab = observation.activeTab;
    const closed = await manager.run('form-session', 'tabs', { action: 'close', tabId: secondTab });
    assert.equal(closed.tabs.length, 2);
    assert.equal(closed.tabs.find(tab => tab.active).id, thirdTab);
    await manager.run('form-session', 'tabs', { action: 'switch', tabId: firstTab });
    await manager.run('form-session', 'tabs', { action: 'close', tabId: thirdTab });
    observation = await manager.run('form-session', 'act', { action: 'click', selector: '#popup' });
    assert.equal(observation.tabs.length, 2);
    assert.notEqual(observation.activeTab, firstTab);
    assert.deepEqual(observation.viewport, { width: 1280, height: 800 });
    const profileDir = manager.sessions.get('form-session').session.profileDir;
    assert.deepEqual(await manager.run('form-session', 'close'), { closed: true });
    await assert.rejects(access(profileDir), { code: 'ENOENT' });
  } finally { await manager.dispose(); }
});

test('coordinate clicks, keyboard shortcuts, scrolling and concurrent session isolation', { timeout: 60000 }, async () => {
  const manager = new BrowserManager(options());
  try {
    await Promise.all(['a', 'b'].map(session => manager.run(session, 'open', { url: fixture.url })));
    await manager.run('a', 'act', { action: 'fill', selector: '#name', text: 'Only A' });
    let observation = await manager.run('b', 'observe');
    assert.equal(observation.elements.find(el => el.name === '姓名').value, '');
    await manager.run('a', 'act', { action: 'press', selector: '#name', key: 'ControlOrMeta+A' });
    observation = await manager.run('a', 'act', { action: 'type', selector: '#name', text: 'Replaced A' });
    assert.equal(observation.elements.find(el => el.name === '姓名').value, 'Replaced A');
    const page = manager.sessions.get('a').session.page;
    const canvas = await page.locator('#canvas').boundingBox();
    const clickX = canvas.x + 20;
    const clickY = canvas.y + 20;
    await manager.run('a', 'act', { action: 'click', x: clickX, y: clickY });
    assert.equal(await page.locator('#canvas').getAttribute('data-clicked'), 'true');
    const pointer = page.locator('[data-dsh-cursor]');
    assert.equal(await pointer.count(), 1);
    assert.equal(await pointer.getAttribute('data-cursor-action'), 'click');
    assert.ok(Math.abs(Number(await pointer.getAttribute('data-cursor-x')) - clickX) <= 1);
    assert.ok(Math.abs(Number(await pointer.getAttribute('data-cursor-y')) - clickY) <= 1);
    assert.equal(await pointer.getAttribute('data-cursor-visible'), 'true');
    await page.waitForTimeout(1800);
    assert.equal(await pointer.getAttribute('data-cursor-visible'), 'false');
    await assert.rejects(manager.run('a', 'act', { action: 'click', x: -1, y: 0 }), /Coordinates/);
    observation = await manager.run('a', 'act', { action: 'scroll', deltaY: 2200 });
    assert.ok(observation.elements.some(el => el.name === '页面底部按钮'));
    assert.notEqual(manager.sessions.get('a').session.profileDir, manager.sessions.get('b').session.profileDir);
  } finally { await manager.dispose(); }
});

test('cancelled actions settle after browser/profile cleanup', { timeout: 30000 }, async () => {
  const manager = new BrowserManager(options());
  try {
    await manager.run('cancel', 'open', { url: fixture.url });
    const profileDir = manager.sessions.get('cancel').session.profileDir;
    const controller = new AbortController();
    const action = manager.run('cancel', 'act', { action: 'wait', waitMs: 5000 }, { signal: controller.signal });
    const timer = setTimeout(() => controller.abort(new Error('user cancelled')), 100);
    await assert.rejects(action, /user cancelled/);
    clearTimeout(timer);
    assert.equal(manager.sessions.size, 0);
    await assert.rejects(access(profileDir), { code: 'ENOENT' });
  } finally { await manager.dispose(); }
});

test('cancelled launch cleans resources and a clean session can restart', { timeout: 30000 }, async () => {
  const manager = new BrowserManager(options());
  try {
    const controller = new AbortController();
    const opening = manager.run('launch', 'open', { url: fixture.url }, { signal: controller.signal });
    const timer = setTimeout(() => controller.abort(new Error('cancel launch')), 50);
    await assert.rejects(opening, /cancel launch/);
    clearTimeout(timer);
    assert.equal(manager.sessions.size, 0);
    const observation = await manager.run('launch', 'open', { url: fixture.url });
    assert.equal(observation.title, 'Browser Use 本地演示');
  } finally { await manager.dispose(); }
});

test('cancelling observation stops even a blocked page renderer', { timeout: 30000 }, async () => {
  const manager = new BrowserManager(options());
  let blocked;
  try {
    await manager.run('blocked', 'open', { url: fixture.url });
    const session = manager.sessions.get('blocked').session;
    const profileDir = session.profileDir;
    blocked = session.page.evaluate(() => { for (;;) { /* deliberately freeze this test renderer */ } }).catch(() => {});
    const controller = new AbortController();
    const observing = manager.run('blocked', 'observe', {}, { signal: controller.signal });
    const timer = setTimeout(() => controller.abort(new Error('cancel blocked renderer')), 200);
    await assert.rejects(observing, /cancel blocked renderer/);
    clearTimeout(timer);
    await blocked;
    await assert.rejects(access(profileDir), { code: 'ENOENT' });
  } finally {
    await manager.dispose();
    await blocked;
  }
});

test('only navigates HTTP(S) and refuses missing session identity or browser state', async () => {
  for (const url of ['file:///C:/Windows/win.ini', 'javascript:alert(1)', 'data:text/html,test', 'https://name:secret@example.com']) {
    assert.throws(() => validateUrl(url));
  }
  const manager = new BrowserManager(options());
  try {
    await assert.rejects(manager.run('', 'open'), /session identity/);
    await assert.rejects(manager.run('x', 'observe'), /browser_open/);
    await assert.rejects(manager.run('x', 'open', { url: 'file:///tmp/test' }), /Only http/);
    assert.equal(manager.sessions.size, 0);
  } finally { await manager.dispose(); }
  assert.deepEqual(await readdir(profiles), []);
});

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { validateSettings, isAllowedUrl, SETTINGS_KEY, CONTROLLED_KEY, CONTROLLED_LOCAL_KEY, COPY_ID_ATTRIBUTE, DEFAULT_SETTINGS } from '../shared.js';
import { EXTENSION_ID } from '../identity.js';

class ChromeEvent {
  listeners = [];
  addListener(listener) { this.listeners.push(listener); }
  emit(...args) { for (const listener of this.listeners) listener(...args); }
}
class FakeSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances = [];
  readyState = 0;
  bufferedAmount = 0;
  messages = [];
  constructor(url) {
    this.url = url; FakeSocket.instances.push(this);
    queueMicrotask(() => { if (this.readyState === 0) { this.readyState = 1; this.onopen?.(); } });
  }
  send(value) { this.messages.push(JSON.parse(value)); }
  close() { if (this.readyState === 3) return; this.readyState = 3; queueMicrotask(() => this.onclose?.()); }
  receive(message) { this.onmessage({ data: JSON.stringify(message) }); }
}
const tabData = new Map([
  [1, { id: 1, index: 0, title: 'Existing page', url: 'https://example.test', active: true, windowId: 8, groupId: 42 }],
  [2, { id: 2, index: 1, title: 'Chrome settings', url: 'chrome://settings', active: false, windowId: 8, groupId: -1 }],
  [3, { id: 3, index: 2, title: 'Other page', url: 'https://external.test', active: false, windowId: 8, groupId: -1 }],
]);
let nextTab = 10;
let nextGroup = 100;
let attachFailureTab;
let markerHang = false;
const nativeOwned = new Set();
const nativeAttachCalls = [];
const detachCalls = [];
const commandCalls = [];
const scriptCalls = [];
const createdTabs = [];
const forbiddenCalls = [];
const groupCalls = [];
const alarmData = new Map();
const identities = new Map();
// Migrate the original opt-in token settings to automatic tokenless connection.
const storage = { [SETTINGS_KEY]: { bridgeUrl: DEFAULT_SETTINGS.bridgeUrl, token: 'a'.repeat(64), enabled: false } };
const sessionStorage = {};
const events = names => Object.fromEntries(names.map(key => [key, new ChromeEvent()]));
function forbidden(method) { forbiddenCalls.push(method); throw new Error(`Forbidden UI activation API: ${method}`); }
const fakeChrome = {
  runtime: { id: EXTENSION_ID, ...events(['onMessage', 'onStartup', 'onInstalled']) },
  windows: {
    async update() { forbidden('windows.update'); },
    async create() { forbidden('windows.create'); },
    async get() { forbidden('windows.get'); },
  },
  alarms: {
    ...events(['onAlarm']),
    async create(name, value) { alarmData.set(name, value); },
    async clear(name) { alarmData.delete(name); return true; },
  },
  scripting: { async executeScript(options) {
    scriptCalls.push(options);
    const tabId = options.target.tabId;
    if (!tabData.has(tabId)) throw new Error('No tab');
    if (options.func.name === 'setPageControlMarker' && markerHang) return new Promise(() => {});
    if (options.func.name === 'setCopyIdentity') identities.set(tabId, options.args[0]);
    if (options.func.name !== 'setCopyIdentity' && options.args?.[0] === COPY_ID_ATTRIBUTE) return [{ result: identities.get(tabId) }];
    return [{ result: undefined }];
  } },
  tabGroups: { async update(groupId, value) { groupCalls.push({ groupId, ...value }); return { id: groupId, ...value }; } },
  storage: {
    onChanged: new ChromeEvent(),
    local: {
      async get(key) { return { [key]: structuredClone(storage[key]) }; },
      async set(values) {
        const changes = {};
        for (const [key, value] of Object.entries(values)) { changes[key] = { oldValue: storage[key], newValue: structuredClone(value) }; storage[key] = structuredClone(value); }
        fakeChrome.storage.onChanged.emit(changes, 'local');
      },
    },
    session: {
      async get(key) { return { [key]: structuredClone(sessionStorage[key]) }; },
      async set(values) { Object.assign(sessionStorage, structuredClone(values)); },
    },
  },
  tabs: {
    ...events(['onCreated', 'onReplaced', 'onRemoved', 'onUpdated']),
    async query(filter = {}) {
      return [...tabData.values()].filter(tab => (filter.active === undefined || tab.active === filter.active) && (filter.windowId === undefined || tab.windowId === filter.windowId)).map(tab => ({ ...tab }));
    },
    async get(tabId) { const tab = tabData.get(tabId); if (!tab) throw new Error('No tab'); return { ...tab }; },
    async update(tabId, values) {
      if (values.active !== undefined || values.highlighted !== undefined) forbidden('tabs.update activation');
      Object.assign(tabData.get(tabId), values); return { ...tabData.get(tabId) };
    },
    async duplicate() { forbidden('tabs.duplicate'); },
    async create(options) {
      assert.equal(options.active, false, 'New copies must be background tabs');
      const tab = { ...options, id: nextTab++, title: '', windowId: options.windowId ?? 8, groupId: -1 };
      createdTabs.push(structuredClone(options)); tabData.set(tab.id, tab);
      fakeChrome.tabs.onCreated.emit(tab); return { ...tab };
    },
    async move() { forbidden('tabs.move'); },
    async group({ tabIds }) {
      const id = nextGroup++; for (const tabId of tabIds) tabData.get(tabId).groupId = id; return id;
    },
    async remove(tabId) { tabData.delete(tabId); identities.delete(tabId); fakeChrome.tabs.onRemoved.emit(tabId); },
  },
  debugger: {
    ...events(['onEvent', 'onDetach']),
    async attach({ tabId }, version) {
      assert.equal(version, '1.3'); nativeAttachCalls.push(tabId);
      if (tabId === attachFailureTab) throw new Error('Another debugger is already attached');
      nativeOwned.add(tabId);
      fakeChrome.debugger.onEvent.emit({ tabId }, 'Runtime.executionContextCreated', { context: { id: 1 } });
      await Promise.resolve();
    },
    async detach({ tabId }) {
      detachCalls.push(tabId); assert.ok(nativeOwned.has(tabId), 'Must never detach an external debugger');
      nativeOwned.delete(tabId); fakeChrome.debugger.onDetach.emit({ tabId }, 'canceled_by_user');
    },
    async sendCommand(debuggee, method, params) { commandCalls.push({ debuggee, method, params }); return { ok: true }; },
  },
};
globalThis.chrome = fakeChrome;
globalThis.WebSocket = FakeSocket;
function ui(type, extra = {}) {
  return new Promise(resolve => fakeChrome.runtime.onMessage.listeners[0]({ type, ...extra }, { id: fakeChrome.runtime.id }, resolve));
}
async function waitFor(predicate) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) { const result = predicate(); if (result) return result; await delay(2); }
  throw new Error('Mock protocol did not settle');
}
let requestId = 0;
async function rpc(method, params = {}) {
  const socket = FakeSocket.instances.at(-1); const id = ++requestId;
  socket.receive({ id, method, params }); return waitFor(() => socket.messages.find(message => message.id === id));
}
let mainClone;
let reloadNumber = 0;
async function reloadWorker({ clearSession = false } = {}) {
  await ui('disconnect');
  // Simulate extension worker replacement: old event handlers no longer exist.
  for (const owner of [fakeChrome.runtime, fakeChrome.tabs, fakeChrome.debugger, fakeChrome.alarms, fakeChrome.storage]) {
    for (const event of Object.values(owner)) if (event instanceof ChromeEvent) event.listeners = [];
  }
  if (clearSession) for (const key of Object.keys(sessionStorage)) delete sessionStorage[key];
  storage[SETTINGS_KEY] = { bridgeUrl: DEFAULT_SETTINGS.bridgeUrl, enabled: true };
  const socketCount = FakeSocket.instances.length;
  await import(`../background.js?worker-reload=${++reloadNumber}`);
  await waitFor(() => FakeSocket.instances.length > socketCount && FakeSocket.instances.at(-1)?.messages.some(message => message.type === 'hello'));
}
before(async () => {
  await import('../background.js');
  await waitFor(() => FakeSocket.instances[0]?.messages.some(message => message.type === 'hello'));
});
after(async () => { await ui('disconnect'); });

test('manifest pins identity and settings migrate without old pairing tokens', async () => {
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  const digest = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32);
  assert.equal([...digest].map(char => String.fromCharCode(97 + parseInt(char, 16))).join(''), EXTENSION_ID);
  assert.ok(manifest.permissions.includes('alarms'));
  assert.deepEqual(storage[SETTINGS_KEY], { bridgeUrl: DEFAULT_SETTINGS.bridgeUrl, enabled: true });
  assert.equal((await ui('status.get')).status.enabled, true);
});
test('validates local-only bridge address and discards legacy tokens', () => {
  for (const bridgeUrl of ['ws://localhost:19876/extension', 'wss://127.0.0.1/extension', 'ws://example.com/extension', 'ws://127.0.0.1/other', 'ws://127.0.0.1/extension?token=test']) assert.throws(() => validateSettings({ bridgeUrl }));
  assert.deepEqual(validateSettings({ bridgeUrl: 'ws://127.0.0.1:21500/extension', token: 'obsolete' }), { bridgeUrl: 'ws://127.0.0.1:21500/extension' });
  for (const url of ['chrome://settings', 'chrome-extension://other/page', 'file:///test', 'javascript:void(0)']) assert.equal(isAllowedUrl(url), false);
  assert.equal(isAllowedUrl('about:blank'), true);
});
test('automatic connection sends v2 hello without a token', async () => {
  const socket = FakeSocket.instances[0];
  assert.deepEqual(socket.messages[0], { type: 'hello', version: 2, browser: 'Chrome', extensionId: EXTENSION_ID });
  assert.equal(new URL(socket.url).search, '');
  const response = await rpc('tabs.list'); assert.deepEqual(response.result.tabs.map(tab => tab.id), [1, 3]);
});
test('original pages cannot be attached or closed', async () => {
  for (const method of ['debugger.attach', 'tabs.remove']) assert.match((await rpc(method, { tabId: 1 })).error.message, /复制标签页/);
  assert.deepEqual(nativeAttachCalls, []); assert.deepEqual(forbiddenCalls, []);
});
test('concurrent source requests create one inactive same-window copy and never native-duplicate or activate', async () => {
  const responses = await Promise.all([rpc('tabs.duplicate', { tabId: 1 }), rpc('tabs.duplicate', { tabId: 1 }), rpc('tabs.duplicate', { tabId: 1 })]);
  mainClone = responses[0].result.id;
  assert.ok(responses.every(response => response.result.id === mainClone));
  assert.equal(createdTabs.length, 1);
  assert.deepEqual(createdTabs[0], { windowId: 8, index: 1, url: 'https://example.test', active: false });
  assert.equal(responses[0].result.active, false); assert.equal(responses[0].result.windowId, 8);
  assert.equal(tabData.get(1).active, true); assert.equal(tabData.get(1).groupId, 42);
  assert.equal(sessionStorage[CONTROLLED_KEY][mainClone].marked, false);
  assert.equal(storage[CONTROLLED_LOCAL_KEY][mainClone].copyNonce, identities.get(mainClone));
  assert.ok(!scriptCalls.some(call => call.target.tabId === 1));
  assert.equal(groupCalls.length, 0, 'Marker must wait until actual attach');
  assert.deepEqual(forbiddenCalls, []);
});
test('new-tab creation never selects or moves pages', async () => {
  const fresh = (await rpc('tabs.create', { url: 'https://new.test' })).result;
  assert.equal(fresh.controlled, true); assert.equal(fresh.sourceTabId, null); assert.equal(fresh.active, false);
  assert.equal(tabData.get(1).active, true); assert.deepEqual(forbiddenCalls, []);
  await rpc('tabs.remove', { tabId: fresh.id });
});
test('attach marks the sole copy; screenshots and focus commands never change active tabs', async () => {
  const response = await rpc('debugger.attach', { tabId: mainClone }); assert.deepEqual(response.result, {});
  const messages = FakeSocket.instances.at(-1).messages;
  assert.ok(messages.findIndex(message => message.type === 'debugger-event' && message.tabId === mainClone) > messages.findIndex(message => message.id === response.id));
  assert.ok(scriptCalls.some(call => call.target.tabId === mainClone && call.func.name === 'setPageControlMarker' && call.args[0] === true));
  assert.equal(groupCalls.at(-1).title, 'DSH · 被接管');
  await rpc('debugger.sendCommand', { tabId: mainClone, sessionId: 'child-session', method: 'Runtime.evaluate', params: { expression: '1+1' } });
  assert.deepEqual(commandCalls.at(-1), { debuggee: { tabId: mainClone, sessionId: 'child-session' }, method: 'Runtime.evaluate', params: { expression: '1+1' } });
  for (const method of ['Page.bringToFront', 'Target.activateTarget']) assert.deepEqual((await rpc('debugger.sendCommand', { tabId: mainClone, method })).result, {});
  await rpc('debugger.sendCommand', { tabId: mainClone, method: 'Page.captureScreenshot' });
  assert.equal(commandCalls.at(-1).method, 'Page.captureScreenshot');
  assert.equal(tabData.get(1).active, true); assert.equal(tabData.get(mainClone).active, false); assert.deepEqual(forbiddenCalls, []);
  assert.match((await rpc('debugger.sendCommand', { tabId: mainClone, method: 'Page.navigate', params: { url: 'chrome://settings' } })).error.message, /导航目标/);
});
test('detach clears emulation and visual marker but keeps reusable copy identity', async () => {
  const nonce = identities.get(mainClone);
  await rpc('debugger.detach', { tabId: mainClone });
  assert.ok(commandCalls.some(call => call.method === 'Emulation.clearDeviceMetricsOverride'));
  assert.ok(commandCalls.some(call => call.method === 'Emulation.setFocusEmulationEnabled' && call.params.enabled === false));
  assert.equal(identities.get(mainClone), nonce);
  assert.equal((await rpc('tabs.duplicate', { tabId: 1 })).result.id, mainClone);
  assert.equal(createdTabs.length, 2); // one source copy, one explicitly requested fresh tab which was closed
  assert.ok(tabData.has(mainClone)); assert.ok(tabData.has(1));
});
test('navigation reapplies copy identity and native debugger detach releases only visual control', async () => {
  await rpc('debugger.attach', { tabId: mainClone });
  identities.delete(mainClone);
  fakeChrome.tabs.onUpdated.emit(mainClone, { status: 'complete' }, { ...tabData.get(mainClone) });
  await waitFor(() => identities.has(mainClone));
  nativeOwned.delete(mainClone); fakeChrome.debugger.onDetach.emit({ tabId: mainClone }, 'canceled_by_user');
  await waitFor(() => scriptCalls.at(-1)?.func.name === 'setPageControlMarker' && scriptCalls.at(-1)?.args[0] === false);
  assert.equal(groupCalls.at(-1).title, 'DSH · 已释放'); assert.ok(tabData.has(mainClone));
});
test('failed external debugger attach is never detached by cleanup', async () => {
  attachFailureTab = mainClone;
  const calls = detachCalls.length;
  assert.match((await rpc('debugger.attach', { tabId: mainClone })).error.message, /Another debugger/);
  await rpc('debugger.detach', { tabId: mainClone });
  assert.equal(detachCalls.length, calls); attachFailureTab = undefined;
});
test('socket reconnect reuses the same source copy without creating or selecting tabs', async () => {
  const count = createdTabs.length; const oldSocket = FakeSocket.instances.at(-1);
  await rpc('debugger.attach', { tabId: mainClone }); oldSocket.close();
  await waitFor(() => !nativeOwned.has(mainClone) && alarmData.size > 0);
  fakeChrome.alarms.onAlarm.emit({ name: 'dsh-browser-reconnect' });
  await waitFor(() => FakeSocket.instances.at(-1) !== oldSocket && FakeSocket.instances.at(-1).messages.some(message => message.type === 'hello'));
  assert.equal((await rpc('tabs.duplicate', { tabId: 1 })).result.id, mainClone);
  assert.equal(createdTabs.length, count); assert.deepEqual(forbiddenCalls, []);
});
test('worker suspension/restart restores session mapping and keeps one copy per source', async () => {
  const count = createdTabs.length; await reloadWorker();
  assert.equal((await rpc('tabs.duplicate', { tabId: 1 })).result.id, mainClone);
  assert.equal(createdTabs.length, count); assert.deepEqual(forbiddenCalls, []);
});
test('extension reload recovers local metadata only with exact document nonce and source metadata', async () => {
  const count = createdTabs.length; await reloadWorker({ clearSession: true });
  assert.equal((await rpc('tabs.duplicate', { tabId: 1 })).result.id, mainClone);
  assert.equal(createdTabs.length, count); assert.equal(identities.get(mainClone), storage[CONTROLLED_LOCAL_KEY][mainClone].copyNonce);
});
test('missing recovery identity blocks another copy until the old tab is explicitly closed', async () => {
  const count = createdTabs.length;
  const oldCopy = mainClone;
  identities.delete(oldCopy); tabData.set(oldCopy, { ...tabData.get(oldCopy), title: 'Old copy or reused numeric ID' });
  await reloadWorker({ clearSession: true });
  const listing = (await rpc('tabs.list')).result.tabs;
  assert.equal(listing.find(tab => tab.id === oldCopy).controlled, false);
  assert.equal(listing.find(tab => tab.id === oldCopy).recoveryRequired, true);
  assert.match((await rpc('tabs.duplicate', { tabId: 1 })).error.message, /已有副本身份无法验证/);
  assert.match((await rpc('debugger.attach', { tabId: oldCopy })).error.message, /已有副本身份无法验证/);
  assert.equal(createdTabs.length, count);
  await reloadWorker({ clearSession: true });
  assert.match((await rpc('tabs.duplicate', { tabId: 1 })).error.message, /已有副本身份无法验证/);
  assert.equal(createdTabs.length, count, 'Uncertain records must survive another reload');
  // Simulate explicit user closure, never the extension closing an unverified page.
  await fakeChrome.tabs.remove(oldCopy);
  const fresh = await rpc('tabs.duplicate', { tabId: 1 });
  assert.notEqual(fresh.result.id, oldCopy); assert.equal(createdTabs.length, count + 1);
  mainClone = fresh.result.id;
});
test('browser target replacement preserves canonical source/copy relations instead of creating another copy', async () => {
  const count = createdTabs.length;
  const oldCopy = mainClone; const newCopy = nextTab++;
  tabData.set(newCopy, { ...tabData.get(oldCopy), id: newCopy }); tabData.delete(oldCopy); identities.delete(oldCopy);
  fakeChrome.tabs.onReplaced.emit(newCopy, oldCopy);
  await waitFor(() => sessionStorage[CONTROLLED_KEY]?.[newCopy]);
  assert.equal((await rpc('tabs.duplicate', { tabId: 1 })).result.id, newCopy);
  mainClone = newCopy;
  const newSource = nextTab++;
  tabData.set(newSource, { ...tabData.get(1), id: newSource }); tabData.delete(1);
  fakeChrome.tabs.onReplaced.emit(newSource, 1);
  await waitFor(() => sessionStorage[CONTROLLED_KEY]?.[mainClone]?.sourceTabId === newSource);
  assert.equal((await rpc('tabs.duplicate', { tabId: newSource })).result.id, mainClone);
  assert.equal(createdTabs.length, count); assert.deepEqual(forbiddenCalls, []);
});
test('a hung marker script cannot wedge native attach or detach', { timeout: 20000 }, async () => {
  markerHang = true;
  try {
    const started = Date.now();
    const attached = await rpc('debugger.attach', { tabId: mainClone });
    assert.deepEqual(attached.result, {});
    assert.ok(Date.now() - started < 6000, 'attach must not wait forever on marker injection');
    assert.ok(nativeOwned.has(mainClone));
    const detachStarted = Date.now();
    assert.deepEqual((await rpc('debugger.detach', { tabId: mainClone })).result, {});
    assert.ok(Date.now() - detachStarted < 7000, 'detach must release native ownership even with a stuck renderer');
    assert.equal(nativeOwned.has(mainClone), false);
    assert.deepEqual(forbiddenCalls, []);
  } finally { markerHang = false; }
});
test('manual pause releases control and prevents alarms from reconnecting or changing UI', async () => {
  await rpc('debugger.attach', { tabId: mainClone });
  assert.equal((await ui('disconnect')).ok, true);
  assert.equal(storage[SETTINGS_KEY].enabled, false); assert.equal(alarmData.size, 0);
  const socketCount = FakeSocket.instances.length;
  fakeChrome.alarms.onAlarm.emit({ name: 'dsh-browser-reconnect' }); await delay(10);
  assert.equal(FakeSocket.instances.length, socketCount); assert.deepEqual(forbiddenCalls, []);
});

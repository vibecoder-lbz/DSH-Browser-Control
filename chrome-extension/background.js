import {
  SETTINGS_KEY, CONTROLLED_KEY, CONTROLLED_LOCAL_KEY, COPY_ID_ATTRIBUTE, DEFAULT_SETTINGS, validateSettings, isAllowedUrl, isAllowedTab,
  tabMetadata, requireTabId, errorMessage,
} from './shared.js';
import { EXTENSION_ID } from './identity.js';
import { setPageControlMarker } from './page-marker.js';

const RETRY_ALARM = 'dsh-browser-reconnect';
const MAX_BUFFERED_EVENTS = 2048;
const MAX_SOCKET_BACKLOG = 32 * 1024 * 1024;
let settings = { ...DEFAULT_SETTINGS };
let socket = null;
let generation = 0;
let reconnectTimer;
let connectTimer;
let heartbeatTimer;
let stableTimer;
let tabsTimer;
let retryAttempt = 0;
let tabCount = 0;
let nextRetryAt = null;
let phase = 'disconnected';
let lastError = '';
let connectedAt = null;
let settingsQueue = Promise.resolve();
let persistenceQueue = Promise.resolve();
const attachments = new Map();
const tabQueues = new Map();
const controlledTabs = new Map();
const recoveryTabs = new Map();
const markerQueues = new Map();
const markerOwners = new Map();
let controlGroupId;

function status() {
  return {
    phase, connected: phase === 'connected', enabled: settings.enabled,
    bridgeUrl: settings.bridgeUrl, tabsCount: tabCount,
    controlledTabsCount: controlledTabs.size,
    attachedTabIds: [...attachments].filter(([, entry]) => entry.owned).map(([tabId]) => tabId),
    retryAttempt, nextRetryAt, connectedAt, lastError, protocolVersion: 2,
  };
}
function updateBadge() {
  const text = phase === 'connected' ? 'ON' : ['connecting', 'retrying'].includes(phase) ? '…' : '';
  void chrome.action.setBadgeText({ text }).catch(() => {});
  void chrome.action.setBadgeBackgroundColor({ color: phase === 'connected' ? '#14804a' : '#637087' }).catch(() => {});
}
function setPhase(value, message = '') { phase = value; lastError = message; updateBadge(); }
function enqueueSettings(task) {
  const current = settingsQueue.catch(() => {}).then(task);
  settingsQueue = current;
  return current;
}
function enqueueTab(tabId, task) {
  const current = (tabQueues.get(tabId) || Promise.resolve()).catch(() => {}).then(task);
  tabQueues.set(tabId, current);
  current.finally(() => { if (tabQueues.get(tabId) === current) tabQueues.delete(tabId); }).catch(() => {});
  return current;
}
function persistControlled() {
  const value = Object.fromEntries(controlledTabs);
  persistenceQueue = persistenceQueue.catch(() => {}).then(() => Promise.all([
    chrome.storage.session.set({ [CONTROLLED_KEY]: value }),
    chrome.storage.local.set({ [CONTROLLED_LOCAL_KEY]: { ...Object.fromEntries(recoveryTabs), ...value } }),
  ]));
  return persistenceQueue;
}
function sendTo(target, message) {
  if (!target || target !== socket || target.readyState !== WebSocket.OPEN) return false;
  if (target.bufferedAmount > MAX_SOCKET_BACKLOG) { target.close(1013, 'Bridge is not draining messages'); return false; }
  try { target.send(JSON.stringify(message)); return true; } catch { return false; }
}
async function allowedTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!isAllowedTab(tab)) throw new Error('只能操作 HTTP、HTTPS 或 about:blank 标签页。Chrome 内部页、扩展页和其他协议不可用。');
  return tab;
}
async function controlledTab(tabId) {
  if (recoveryTabs.has(tabId)) throw new Error('已有副本身份无法验证，请先在 Chrome 关闭该旧副本，再重新选择原页面。不会自动接管或新建第二份。');
  if (!controlledTabs.has(tabId)) throw new Error('只能控制标记为“被接管”的复制标签页，原标签页保持不变。请先调用 tabs.duplicate。');
  return allowedTab(tabId);
}
async function listTabs() {
  const tabs = (await chrome.tabs.query({})).filter(isAllowedTab).map(tab => {
    const recovery = recoveryTabs.get(tab.id);
    return recovery ? { ...tabMetadata(tab, recovery), controlled: false, recoveryRequired: true } : tabMetadata(tab, controlledTabs.get(tab.id));
  });
  tabCount = tabs.filter(tab => !tab.controlled).length;
  return tabs;
}
async function publishTabs(target = socket) {
  try { sendTo(target, { type: 'tabs', tabs: await listTabs() }); }
  catch (error) { if (target === socket) lastError = `无法读取标签页：${errorMessage(error)}`; }
}
function tabsChanged() {
  clearTimeout(tabsTimer);
  tabsTimer = setTimeout(() => { void publishTabs(); }, 80);
}

function setCopyIdentity(nonce, attribute) {
  if (document.documentElement) document.documentElement.setAttribute(attribute, nonce);
}
async function copyIdentity(tabId, record) {
  if (!record?.copyNonce) return false;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!/^https?:\/\//iu.test(tab.url || '')) return false;
    await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', func: setCopyIdentity, args: [record.copyNonce, COPY_ID_ATTRIBUTE] });
    return true;
  } catch { return false; }
}
async function hasCopyIdentity(tabId, record) {
  if (typeof record?.copyNonce !== 'string' || !record.copyNonce) return false;
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED',
      func: attribute => document.documentElement?.getAttribute(attribute), args: [COPY_ID_ATTRIBUTE] });
    return results[0]?.result === record.copyNonce;
  } catch { return false; }
}
const MARKER_TIMEOUT_MS = 1500;
// Cosmetic marker work must never hold native debugger ownership. A busy renderer
// can leave executeScript pending forever, so bound it and let control continue.
function bounded(promise, ms = MARKER_TIMEOUT_MS) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('标记更新超时，页面渲染线程未响应。')), ms); }),
  ]).finally(() => clearTimeout(timer));
}
async function pageMarker(tabId, enabled) {
  if (!controlledTabs.has(tabId)) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!/^https?:\/\//iu.test(tab.url || '')) return;
    await bounded(chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', func: setPageControlMarker, args: [enabled] }));
  } catch (error) {
    // Restricted pages or a tab that closed while navigating cannot be injected.
    if (enabled) lastError = `复制标签页标记暂不可用：${errorMessage(error)}`;
  }
}
async function groupMarker(tabId, enabled) {
  const record = controlledTabs.get(tabId);
  if (!record) return;
  try {
    await bounded((async () => {
      const tab = await chrome.tabs.get(tabId);
      let groupId = controlGroupId || record.groupId;
      if (!Number.isInteger(groupId)) {
        const existing = [...controlledTabs.values()].find(item => Number.isInteger(item.groupId));
        groupId = existing?.groupId;
      }
      if (!Number.isInteger(groupId)) groupId = await chrome.tabs.group({ tabIds: [tabId] });
      else if (tab.groupId !== groupId) groupId = await chrome.tabs.group({ tabIds: [tabId], groupId });
      controlGroupId = groupId;
      record.groupId = groupId;
      await persistControlled();
      await chrome.tabGroups.update(groupId, { title: enabled ? 'DSH · 被接管' : 'DSH · 已释放', color: 'cyan' });
    })());
  } catch (error) { if (enabled) lastError = `标签组标记暂不可用：${errorMessage(error)}`; }
}
function markControl(tabId, enabled, owner) {
  const task = (markerQueues.get(tabId) || Promise.resolve()).catch(() => {}).then(async () => {
    const record = controlledTabs.get(tabId);
    if (!record || (!enabled && owner && markerOwners.get(tabId) !== owner)) return;
    record.marked = enabled;
    if (enabled && owner) markerOwners.set(tabId, owner);
    else if (!enabled) markerOwners.delete(tabId);
    await persistControlled();
    await Promise.all([pageMarker(tabId, enabled), groupMarker(tabId, enabled)]);
  });
  markerQueues.set(tabId, task);
  task.finally(() => { if (markerQueues.get(tabId) === task) markerQueues.delete(tabId); }).catch(() => {});
  return task;
}
async function duplicateControlled(tabId) {
  const source = await allowedTab(tabId);
  if (recoveryTabs.has(tabId)) throw new Error('已有副本身份无法验证，请先在 Chrome 关闭该旧副本，再重新选择原页面。');
  for (const [oldId, record] of recoveryTabs) {
    if (record.sourceTabId !== source.id) continue;
    const oldTab = await chrome.tabs.get(oldId).catch(() => undefined);
    if (oldTab) throw new Error(`已有副本身份无法验证，请先在 Chrome 关闭旧副本（标签页 ${oldId}），再重新选择原页面。不会创建第二份。`);
    recoveryTabs.delete(oldId); await persistControlled();
  }
  if (controlledTabs.has(tabId)) return tabMetadata(source, controlledTabs.get(tabId));
  // The extension is the global authority for source -> copy. Calls are serialized by source ID.
  const candidates = [...controlledTabs].filter(([, record]) => record.sourceTabId === source.id)
    .sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0) || a[0] - b[0]);
  for (const [copyId, record] of candidates) {
    try {
      const existing = await allowedTab(copyId);
      // Do not reload/navigate/re-mark a reusable copy or overwrite its current form/terminal state.
      return tabMetadata(existing, record);
    } catch { controlledTabs.delete(copyId); }
  }
  // Chrome tabs.duplicate has no active:false option. Create a background page instead;
  // it shares the profile/login but is not a clone of live JS, history, or an SSH connection.
  const clone = await chrome.tabs.create({ windowId: source.windowId,
    ...(Number.isInteger(source.index) ? { index: source.index + 1 } : {}),
    url: source.pendingUrl || source.url, active: false });
  const record = { sourceTabId: source.id, sourceUrl: source.pendingUrl || source.url,
    sourceWindowId: source.windowId, copyNonce: crypto.randomUUID(), createdAt: Date.now(), marked: false };
  controlledTabs.set(clone.id, record);
  await persistControlled();
  await copyIdentity(clone.id, record);
  tabsChanged();
  return tabMetadata(await chrome.tabs.get(clone.id), record);
}

function flushAttachment(entry) {
  entry.ready = true;
  for (const event of entry.events.splice(0)) sendTo(entry.socket, event);
  if (entry.detached && attachments.get(entry.tabId) === entry) attachments.delete(entry.tabId);
}
function forwardAttachmentEvent(entry, event) {
  if (entry.ready) sendTo(entry.socket, event);
  else if (entry.events.length < MAX_BUFFERED_EVENTS) entry.events.push(event);
  else if (entry.socket.readyState === WebSocket.OPEN) entry.socket.close(1013, 'Debugger event buffer overflow');
}
async function detachOwned(tabId, expected) {
  const entry = attachments.get(tabId);
  if (expected && entry !== expected) return;
  if (!entry?.owned) {
    if (entry?.state !== 'attaching' && attachments.get(tabId) === entry) attachments.delete(tabId);
    if (controlledTabs.has(tabId)) await markControl(tabId, false).catch(() => {});
    return;
  }
  entry.state = 'detaching';
  // Marker work is cosmetic and bounded; native ownership must be released even
  // if the renderer is busy and injection cannot complete.
  await markControl(tabId, false).catch(() => {});
  let cleanupTimer;
  try {
    await Promise.race([
      Promise.allSettled([
        chrome.debugger.sendCommand({ tabId }, 'Emulation.clearDeviceMetricsOverride', {}),
        chrome.debugger.sendCommand({ tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: false }),
      ]),
      new Promise(resolve => { cleanupTimer = setTimeout(resolve, 1000); }),
    ]);
  } finally { clearTimeout(cleanupTimer); }
  try { await chrome.debugger.detach({ tabId }); }
  catch (error) { lastError = `调试连接已结束或无法释放：${errorMessage(error)}`; }
  finally { entry.owned = false; if (attachments.get(tabId) === entry) attachments.delete(tabId); }
}
async function detachAllOwned(target) {
  const selected = [...attachments].filter(([, entry]) => !target || entry.socket === target);
  await Promise.allSettled(selected.map(([tabId, expected]) => enqueueTab(tabId, () => detachOwned(tabId, expected))));
  // Duplicates may have been created but not attached when a transport failed.
  const marked = [...controlledTabs].filter(([tabId, record]) => record.marked && !attachments.get(tabId)?.owned && (!target || markerOwners.get(tabId) === target));
  await Promise.allSettled(marked.map(([tabId]) => markControl(tabId, false, target)));
}
function clearConnectionTimers() {
  clearTimeout(reconnectTimer); clearTimeout(connectTimer); clearTimeout(stableTimer); clearInterval(heartbeatTimer);
  reconnectTimer = connectTimer = stableTimer = heartbeatTimer = undefined;
  nextRetryAt = null;
  void chrome.alarms.clear(RETRY_ALARM).catch(() => {});
}
async function resetConnection() {
  generation++;
  const previous = socket;
  socket = null;
  clearConnectionTimers();
  connectedAt = null;
  if (previous) { try { previous.close(1000, 'Extension disconnected'); } catch {} }
  await detachAllOwned();
}
function scheduleReconnect(expectedGeneration) {
  if (!settings.enabled || generation !== expectedGeneration || socket) return;
  const waitMs = Math.min(1000 * (2 ** Math.min(retryAttempt, 6)), 30000);
  retryAttempt++;
  nextRetryAt = Date.now() + waitMs;
  setPhase('retrying', '等待本机 DSH，连接恢复后会自动继续。');
  // Alarms survive worker suspension; the short timer avoids unnecessary delay while it remains awake.
  void chrome.alarms.create(RETRY_ALARM, { when: nextRetryAt }).catch(() => {});
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    if (generation === expectedGeneration && settings.enabled && !socket) connectSocket();
  }, waitMs);
}
function connectSocket() {
  if (!settings.enabled || socket) return;
  const config = validateSettings(settings);
  const epoch = generation;
  const current = new WebSocket(config.bridgeUrl);
  socket = current;
  setPhase('connecting');
  nextRetryAt = null;
  void chrome.alarms.clear(RETRY_ALARM).catch(() => {});
  const inflight = new Set();
  connectTimer = setTimeout(() => {
    if (socket === current && current.readyState === WebSocket.CONNECTING) current.close();
  }, 10000);
  current.onopen = () => {
    if (socket !== current || generation !== epoch || !settings.enabled) { current.close(); return; }
    clearTimeout(connectTimer); connectTimer = undefined;
    connectedAt = Date.now(); setPhase('connected');
    sendTo(current, { type: 'hello', version: 2, browser: 'Chrome', extensionId: chrome.runtime.id });
    void publishTabs(current);
    heartbeatTimer = setInterval(() => { sendTo(current, { type: 'ping' }); }, 20000);
    stableTimer = setTimeout(() => { if (socket === current) retryAttempt = 0; }, 60000);
  };
  current.onmessage = event => { void handleBridgeMessage(current, event.data, inflight); };
  current.onerror = () => { if (socket === current) lastError = '正在等待本机 DSH 桥启动。'; };
  current.onclose = () => {
    void (async () => {
      if (socket !== current) { await detachAllOwned(current); return; }
      socket = null; clearConnectionTimers(); connectedAt = null;
      setPhase(settings.enabled ? 'retrying' : 'disconnected');
      await detachAllOwned(current); scheduleReconnect(epoch);
    })();
  };
}
function assertCurrent(target) {
  if (target !== socket || target.readyState !== WebSocket.OPEN || !settings.enabled) throw new Error('本地桥连接已经结束。');
}
async function dispatch(target, method, params) {
  assertCurrent(target);
  if (method === 'tabs.list') return { result: { tabs: await listTabs() } };
  if (method === 'tabs.duplicate') {
    const tabId = requireTabId(params);
    return enqueueTab(tabId, async () => {
      assertCurrent(target);
      const result = await duplicateControlled(tabId, target);
      if (target !== socket || !settings.enabled) await markControl(result.id, false);
      return { result };
    });
  }
  if (method === 'tabs.activate') {
    const tabId = requireTabId(params);
    // Compatibility RPC: selection happens only in DSH, never in the user's browser UI.
    return { result: tabMetadata(await controlledTab(tabId), controlledTabs.get(tabId)) };
  }
  if (method === 'tabs.create') {
    if (!isAllowedUrl(params?.url)) throw new Error('新标签页网址必须使用 HTTP、HTTPS 或 about:blank。');
    const tab = await chrome.tabs.create({ url: params.url, active: false });
    const record = { sourceTabId: null, copyNonce: crypto.randomUUID(), createdAt: Date.now(), marked: false };
    controlledTabs.set(tab.id, record);
    await persistControlled(); await copyIdentity(tab.id, record);
    return { result: tabMetadata(await chrome.tabs.get(tab.id), controlledTabs.get(tab.id)) };
  }
  if (method === 'tabs.remove') {
    const tabId = requireTabId(params);
    await controlledTab(tabId);
    await enqueueTab(tabId, async () => { await detachOwned(tabId); await chrome.tabs.remove(tabId); });
    return { result: {} };
  }
  if (method === 'debugger.attach') {
    const tabId = requireTabId(params);
    return enqueueTab(tabId, async () => {
      assertCurrent(target); await controlledTab(tabId);
      const existing = attachments.get(tabId);
      if (existing?.owned) {
        if (existing.socket !== target) throw new Error('该标签页仍在释放上一次连接，请重试。');
        return { result: {}, afterResponse: () => flushAttachment(existing) };
      }
      const entry = { tabId, socket: target, state: 'attaching', owned: false, ready: false, detached: false, events: [] };
      attachments.set(tabId, entry);
      try {
        await chrome.debugger.attach({ tabId }, '1.3');
        if (!entry.detached) { entry.owned = true; entry.state = 'attached'; }
        if (target !== socket || target.readyState !== WebSocket.OPEN || !settings.enabled) {
          await detachOwned(tabId, entry); throw new Error('连接已断开，已释放本扩展的调试连接。');
        }
        await markControl(tabId, true, target);
        return { result: {}, afterResponse: () => flushAttachment(entry) };
      } catch (error) {
        if (attachments.get(tabId) === entry && !entry.owned) attachments.delete(tabId);
        if (!entry.owned) await markControl(tabId, false);
        throw error;
      }
    });
  }
  if (method === 'debugger.detach') {
    const tabId = requireTabId(params);
    const entry = attachments.get(tabId);
    // An already-owned attachment can be released without waiting behind a busy
    // tab queue or a slow renderer command.
    if (entry?.owned && entry.state === 'attached') await detachOwned(tabId, entry);
    else await enqueueTab(tabId, () => detachOwned(tabId));
    return { result: {} };
  }
  if (method === 'debugger.sendCommand') {
    const tabId = requireTabId(params);
    await (tabQueues.get(tabId) || Promise.resolve()).catch(() => {});
    assertCurrent(target); await controlledTab(tabId);
    const entry = attachments.get(tabId);
    if (!entry?.owned || entry.socket !== target || entry.state !== 'attached') throw new Error('该复制标签页尚未连接调试器。');
    if (typeof params.method !== 'string' || !/^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/u.test(params.method)) throw new Error('CDP method 格式无效。');
    if (params.params !== undefined && (!params.params || typeof params.params !== 'object' || Array.isArray(params.params))) throw new Error('CDP params 必须是对象。');
    if (params.sessionId !== undefined && (typeof params.sessionId !== 'string' || !params.sessionId)) throw new Error('CDP sessionId 无效。');
    if (['Page.navigate', 'Target.createTarget'].includes(params.method) && !isAllowedUrl(params.params?.url)) throw new Error('导航目标必须使用 HTTP、HTTPS 或 about:blank。');
    if (['Page.bringToFront', 'Target.activateTarget'].includes(params.method)) return { result: {} };
    const debuggee = { tabId, ...(params.sessionId ? { sessionId: params.sessionId } : {}) };
    return { result: await chrome.debugger.sendCommand(debuggee, params.method, params.params || {}) ?? {} };
  }
  throw new Error(`不支持的桥接方法：${method}`);
}
async function handleBridgeMessage(target, raw, inflight) {
  let request;
  try { if (typeof raw !== 'string') throw new Error(); request = JSON.parse(raw); }
  catch { if (target === socket) target.close(1003, 'Invalid JSON message'); return; }
  if (!request || typeof request !== 'object' || Array.isArray(request) || request.type === 'pong') return;
  const { id, method } = request;
  if (!((typeof id === 'string' && id.length > 0) || (typeof id === 'number' && Number.isFinite(id)))) return;
  if (inflight.has(id)) { sendTo(target, { id, error: { message: '重复的请求 ID。' } }); return; }
  inflight.add(id);
  try {
    if (typeof method !== 'string') throw new Error('桥接 method 必须是字符串。');
    const params = request.params ?? {};
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('桥接 params 必须是对象。');
    const outcome = await dispatch(target, method, params);
    if (sendTo(target, { id, result: outcome.result })) outcome.afterResponse?.();
  } catch (error) { sendTo(target, { id, error: { message: errorMessage(error) } }); }
  finally { inflight.delete(id); }
}
async function saveAndApply(value, enabled) {
  settings = { ...validateSettings(value), enabled };
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  retryAttempt = 0; await resetConnection();
  if (enabled) connectSocket(); else setPhase('disconnected');
}
async function handleUiMessage(message) {
  await initialized;
  if (message.type === 'settings.get') return { ok: true, settings: { ...settings } };
  if (message.type === 'status.get') { await listTabs(); return { ok: true, status: status() }; }
  if (message.type === 'settings.set') {
    await enqueueSettings(() => saveAndApply(message.settings, settings.enabled));
    return { ok: true, settings: { ...settings }, status: status() };
  }
  if (message.type === 'connect') {
    await enqueueSettings(() => saveAndApply(message.settings || settings, true));
    return { ok: true, status: status() };
  }
  if (message.type === 'disconnect') {
    await enqueueSettings(async () => {
      settings = { ...settings, enabled: false };
      await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
      await resetConnection(); retryAttempt = 0; setPhase('disconnected');
    });
    return { ok: true, status: status() };
  }
  throw new Error('未知的扩展消息。');
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !message || typeof message.type !== 'string') return false;
  void handleUiMessage(message).then(sendResponse, error => sendResponse({ ok: false, error: { message: errorMessage(error) } }));
  return true;
});
chrome.debugger.onEvent.addListener((source, method, params) => {
  const entry = attachments.get(source.tabId);
  if (!entry || entry.detached || (!entry.owned && entry.state !== 'attaching')) return;
  forwardAttachmentEvent(entry, { type: 'debugger-event', tabId: source.tabId, ...(source.sessionId ? { sessionId: source.sessionId } : {}), method, params: params ?? {} });
});
chrome.debugger.onDetach.addListener((source, reason) => {
  const entry = attachments.get(source.tabId);
  if (!entry) return;
  entry.owned = false; entry.detached = true; entry.state = 'detached';
  forwardAttachmentEvent(entry, { type: 'debugger-detached', tabId: source.tabId, reason });
  if (entry.ready && attachments.get(source.tabId) === entry) attachments.delete(source.tabId);
  void markControl(source.tabId, false); updateBadge();
});
chrome.tabs.onCreated.addListener(tabsChanged);
chrome.tabs.onActivated.addListener(tabsChanged);
chrome.tabs.onMoved.addListener(tabsChanged);
chrome.tabs.onAttached.addListener(tabsChanged);
chrome.tabs.onDetached.addListener(tabsChanged);
chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  void enqueueTab(removedTabId, () => detachOwned(removedTabId));
  const record = controlledTabs.get(removedTabId);
  controlledTabs.delete(removedTabId); markerOwners.delete(removedTabId);
  if (record) controlledTabs.set(addedTabId, { ...record, marked: false });
  for (const copy of controlledTabs.values()) if (copy.sourceTabId === removedTabId) copy.sourceTabId = addedTabId;
  void (async () => {
    try {
      const added = await chrome.tabs.get(addedTabId);
      for (const copy of controlledTabs.values()) {
        if (copy.sourceTabId === addedTabId) { copy.sourceUrl = added.pendingUrl || added.url; copy.sourceWindowId = added.windowId; }
      }
      if (record) await copyIdentity(addedTabId, controlledTabs.get(addedTabId));
    } catch { /* A replaced target can close before its metadata is read. */ }
    await persistControlled(); tabsChanged();
  })();
});
chrome.tabs.onRemoved.addListener(tabId => {
  void enqueueTab(tabId, () => detachOwned(tabId));
  controlledTabs.delete(tabId); recoveryTabs.delete(tabId); markerOwners.delete(tabId); void persistControlled(); tabsChanged();
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!isAllowedTab(tab) && attachments.has(tabId)) void enqueueTab(tabId, () => detachOwned(tabId));
  const record = controlledTabs.get(tabId);
  if (record && changeInfo.status === 'complete') {
    void copyIdentity(tabId, record).then(() => { if (record.marked) return pageMarker(tabId, true); });
  }
  if (changeInfo.url && !record) {
    let changed = false;
    for (const copy of [...controlledTabs.values(), ...recoveryTabs.values()]) {
      if (copy.sourceTabId !== tabId) continue;
      copy.sourceUrl = tab.pendingUrl || tab.url; copy.sourceWindowId = tab.windowId; changed = true;
    }
    if (changed) void persistControlled();
  }
  tabsChanged();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[SETTINGS_KEY]) return;
  const next = changes[SETTINGS_KEY].newValue;
  if (JSON.stringify(next) === JSON.stringify(settings)) return;
  void enqueueSettings(async () => {
    await initialized;
    try {
      settings = { ...validateSettings(next || DEFAULT_SETTINGS), enabled: next?.enabled !== false };
      retryAttempt = 0; await resetConnection();
      if (settings.enabled) connectSocket(); else setPhase('disconnected');
    } catch (error) { settings = { ...DEFAULT_SETTINGS, enabled: false }; await resetConnection(); setPhase('error', errorMessage(error)); }
  });
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== RETRY_ALARM) return;
  void initialized.then(() => { if (settings.enabled && !socket) connectSocket(); });
});
const initialized = (async () => {
  try {
    if (chrome.runtime.id !== EXTENSION_ID) throw new Error('扩展身份与 DSH 不匹配，请加载原始扩展目录。');
    const saved = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] || DEFAULT_SETTINGS;
    const migrate = Object.hasOwn(saved, 'token');
    settings = { ...validateSettings(saved), enabled: migrate ? true : saved.enabled !== false };
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
    const sessionRecords = (await chrome.storage.session.get(CONTROLLED_KEY))[CONTROLLED_KEY] || {};
    const localRecords = (await chrome.storage.local.get(CONTROLLED_LOCAL_KEY))[CONTROLLED_LOCAL_KEY] || {};
    for (const [id, savedRecord] of Object.entries({ ...localRecords, ...sessionRecords })) {
      const tabId = Number(id);
      if (!Number.isInteger(tabId) || !savedRecord || (savedRecord.sourceTabId !== null && !Number.isInteger(savedRecord.sourceTabId))) continue;
      const record = { ...savedRecord };
      try {
        if (!isAllowedTab(await chrome.tabs.get(tabId))) continue;
        // storage.session is browser-session scoped. A local recovery record additionally
        // needs a nonce still present in the exact copy document; URLs alone never identify copies.
        if (!Object.hasOwn(sessionRecords, id)) {
          const source = record.sourceTabId !== null ? await allowedTab(record.sourceTabId) : undefined;
          if (source && (!record.sourceUrl || (source.pendingUrl || source.url) !== record.sourceUrl ||
              (Number.isInteger(record.sourceWindowId) && source.windowId !== record.sourceWindowId))) continue;
          if (!await hasCopyIdentity(tabId, record)) {
            // Existing source + old copy IDs with no identity are ambiguous. Preserve
            // the record and stop a new copy until the user closes the old tab.
            if (source && source.id !== tabId) recoveryTabs.set(tabId, { ...record, marked: false });
            continue;
          }
        }
        record.copyNonce ||= crypto.randomUUID();
        record.createdAt ||= Date.now();
        if (record.sourceTabId !== null) {
          const source = await chrome.tabs.get(record.sourceTabId).catch(() => undefined);
          if (source) { record.sourceUrl = source.pendingUrl || source.url; record.sourceWindowId = source.windowId; }
        }
        controlledTabs.set(tabId, record);
        await copyIdentity(tabId, record);
      } catch { /* Closed, replaced or unverifiable tabs are never adopted from local IDs alone. */ }
    }
    await persistControlled();
    await Promise.allSettled([...controlledTabs].filter(([, record]) => record.marked).map(([tabId]) => markControl(tabId, false)));
    await listTabs();
    if (settings.enabled) connectSocket(); else setPhase('disconnected');
  } catch (error) { settings = { ...DEFAULT_SETTINGS, enabled: false }; setPhase('error', errorMessage(error)); }
})();
chrome.runtime.onStartup.addListener(() => { void initialized; });
chrome.runtime.onInstalled.addListener(() => { void initialized; });

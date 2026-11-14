import http from 'node:http';
import { EventEmitter } from 'node:events';
import { EXTENSION_ID } from '../chrome-extension/identity.js';
import { WebSocketServer, WebSocket } from 'ws';
import { publicUrl } from './url.js';

const allowedTab = tab => Number.isInteger(tab.id) && /^(https?:\/\/|about:blank$)/iu.test(tab.url || '');
const extensionOrigin = `chrome-extension://${EXTENSION_ID}`;

export function selectTab(tabs, { tabId, query } = {}) {
  if (tabId !== undefined && String(tabId).trim() !== '') {
    const numeric = Number(String(tabId).replace(/^chrome-/u, ''));
    const tab = tabs.find(tab => tab.id === numeric);
    if (!tab) return { matched: false, reason: 'tab-not-found', candidates: tabs };
    return { matched: true, tab, reason: 'explicit-tab-id' };
  }
  if (!query?.trim()) return { matched: false, reason: 'provide-query-or-tabId', candidates: tabs };
  const search = query.trim().toLocaleLowerCase();
  const aliases = /^(jumpserver|堡垒机)$/iu.test(search) ? ['jumpserver', '堡垒机', '/luna', '/koko'] : [search];
  const ranked = tabs.map(tab => {
    const title = (tab.title || '').toLocaleLowerCase();
    const url = publicUrl(tab.url).toLocaleLowerCase();
    const words = search.split(/\s+/u).filter(Boolean);
    let score = 0;
    let reason = '';
    if (url === search) { score = 100; reason = 'exact-url'; }
    else if (title === search) { score = 90; reason = 'exact-title'; }
    else if (aliases.some(alias => url.includes(alias))) { score = 80; reason = 'url-match'; }
    else if (aliases.some(alias => title.includes(alias))) { score = 70; reason = 'title-match'; }
    else if (words.length > 1 && words.every(word => `${title} ${url}`.includes(word))) { score = 60; reason = 'all-query-terms'; }
    return { tab, score, reason };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score);
  if (!ranked.length) return { matched: false, reason: 'no-match', candidates: tabs };
  const best = ranked.filter(item => item.score === ranked[0].score);
  if (best.length !== 1) return { matched: false, reason: 'ambiguous-match', candidates: best.map(item => item.tab) };
  return { matched: true, tab: best[0].tab, reason: best[0].reason };
}

export const publicTab = tab => ({
  id: `chrome-${tab.id}`, title: tab.title || '', url: publicUrl(tab.url), active: Boolean(tab.active), windowId: tab.windowId,
  controlled: tab.controlled === true,
  ...(tab.recoveryRequired ? { recoveryRequired: true } : {}),
  ...(Number.isInteger(tab.sourceTabId) ? { sourceTabId: `chrome-${tab.sourceTabId}` } : {}),
});

/** Authenticated loopback-only relay. It never exposes an unauthenticated CDP port. */
export class ChromeBridge extends EventEmitter {
  constructor(options = {}) {
    super();
    this.port = options.bridgePort ?? 19876;
    this.copyOwners = new Map();
    this.copyQueues = new Map();
    this.pending = new Map();
    this.leases = new Map();
    this.nextId = 1;
    this.disposed = false;
    this.commandTimeoutMs = options.bridgeCommandTimeoutMs ?? 30000;
  }

  async start() {
    if (this.disposed) throw new Error('Chrome bridge has been disposed.');
    if (this.startTask) return this.startTask;
    this.startTask = this.listen();
    try { return await this.startTask; }
    catch (error) { this.startTask = undefined; throw error; }
  }

  async listen() {
    const server = http.createServer((req, res) => {
      const expectedHost = `127.0.0.1:${this.port}`;
      if (req.headers.host !== expectedHost || req.method !== 'GET' || req.headers.origin ||
          (req.headers['sec-fetch-site'] && req.headers['sec-fetch-mode'] && !['navigate', 'same-origin'].includes(req.headers['sec-fetch-mode']))) {
        res.writeHead(403); res.end('Forbidden'); return;
      }
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
      if (req.url === '/status') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ connected: this.connected })); return;
      }
      if (req.url !== '/setup') { res.writeHead(404); res.end('Not found'); return; }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>DSH 浏览器连接</title><style>body{font:17px system-ui;max-width:760px;margin:60px auto;padding:24px;color:#172234}code{background:#eef2f8;padding:4px}</style><h1>DSH 浏览器自动连接</h1><p>加载新版 DSH Chrome 扩展后自动连接，无需配对码。</p><p>扩展状态：${this.connected ? '已连接' : '等待扩展自动连接'}。</p><p>接管时自动复制目标标签页，并标记“被接管”。原标签页保持原有状态；副本仍共享网站账号与服务器数据。</p><p>本地桥：<code>127.0.0.1:${this.port}</code></p></html>`);
    });
    const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url || '/', `http://127.0.0.1:${this.port}`);
      const origin = req.headers.origin;
      if (this.disposed || req.headers.host !== `127.0.0.1:${this.port}` || url.pathname !== '/extension' || url.search ||
          origin !== extensionOrigin || this.socket?.readyState === WebSocket.OPEN) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
      }
      wss.handleUpgrade(req, socket, head, ws => this.accept(ws));
    });
    this.server = server;
    this.wss = wss;
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
      });
      this.port = server.address().port;
      server.unref();
      return this.status();
    } catch (error) {
      server.close(); wss.close();
      if (error.code === 'EADDRINUSE') throw new Error(`Chrome bridge port ${this.port} is already in use. Use the DSH profile that owns it or configure a different bridgePort.`);
      throw error;
    }
  }

  get connected() { return this.socket?.readyState === WebSocket.OPEN && this.hello === true; }

  status() {
    return { mode: 'existing', connected: this.connected, bridgeUrl: `ws://127.0.0.1:${this.port}/extension`,
      setupUrl: `http://127.0.0.1:${this.port}/setup`, tokenRequired: false,
      message: this.connected ? 'Chrome extension connected automatically. Selecting a source tab creates or reuses a background controlled copy.' : 'Install or reload the current Chrome extension. It automatically connects to the running DSH bridge; no pairing code is needed.' };
  }

  accept(ws) {
    this.socket = ws;
    this.hello = false;
    const handshake = setTimeout(() => { if (!this.hello) ws.close(1008, 'Handshake required'); }, 5000);
    handshake.unref();
    ws.on('message', raw => {
      try {
        const message = JSON.parse(raw.toString());
        if (!this.hello) {
          if (message.type !== 'hello' || message.version !== 2 || message.extensionId !== EXTENSION_ID) { ws.close(1008, 'Extension identity/protocol mismatch'); return; }
          this.hello = true; clearTimeout(handshake); this.emit('connected'); return;
        }
        if (message.id !== undefined) {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          this.pending.delete(message.id); clearTimeout(pending.timer);
          if (process.env.DEBUG_BROWSER_BRIDGE) console.error(`[bridge] done ${pending.label} ${Date.now() - pending.started}ms${message.error ? ' error' : ''}`);
          if (message.error) pending.reject(new Error(message.error.message || 'Extension command failed.'));
          else pending.resolve(message.result ?? {});
        } else if (message.type === 'debugger-event' || message.type === 'debugger-detached') this.emit('protocol', message);
        else if (message.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      } catch { ws.close(1008, 'Invalid protocol message'); }
    });
    ws.on('error', () => {});
    ws.once('close', () => {
      clearTimeout(handshake);
      if (this.socket !== ws) return;
      this.socket = undefined; this.hello = false;
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Chrome extension disconnected; input delivery may be unknown. Inspect the page before retrying.')); }
      this.pending.clear();
      this.emit('disconnected');
    });
  }

  command(method, params = {}, { timeoutMs = this.commandTimeoutMs } = {}) {
    if (!this.connected) return Promise.reject(new Error('Chrome extension is not connected. Call browser_connect action=status for setup instructions.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Chrome bridge command timed out (${method}); delivery may be unknown. Inspect state before retrying.`));
      }, timeoutMs);
      timer.unref();
      const label = params.method || method;
      if (process.env.DEBUG_BROWSER_BRIDGE) console.error(`[bridge] send ${label}`);
      this.pending.set(id, { resolve, reject, timer, label, started: Date.now() });
      this.socket.send(JSON.stringify({ id, method, params }), error => {
        if (!error) return;
        this.pending.delete(id); clearTimeout(timer); reject(error);
      });
    });
  }

  async listTabs() {
    await this.start();
    const { tabs } = await this.command('tabs.list');
    if (!Array.isArray(tabs)) throw new Error('Chrome extension returned an invalid tab list.');
    return tabs.filter(allowedTab);
  }

  async controlCopy(source, owner) {
    const sourceId = source.controlled ? (source.sourceTabId ?? source.id) : source.id;
    const previous = this.copyQueues.get(sourceId) || Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      const tabs = await this.listTabs();
      let copy = source.controlled ? tabs.find(tab => tab.id === source.id && tab.controlled) :
        tabs.find(tab => tab.controlled && tab.sourceTabId === source.id);
      if (!copy) {
        if (source.controlled) throw new Error('Controlled copy no longer exists. Select the original source tab again.');
        copy = await this.command('tabs.duplicate', { tabId: source.id });
      }
      if (!allowedTab(copy) || copy.controlled !== true || (!source.controlled && (copy.sourceTabId !== source.id || copy.id === source.id))) {
        throw new Error('Extension did not return a valid controlled copy. The source tab was not attached.');
      }
      const lease = this.leases.get(copy.id);
      if (lease && lease.owner !== owner) throw new Error('This source already has a controlled copy owned by another DSH session. Release it there first; no additional copy was created.');
      this.copyOwners.set(copy.id, owner);
      return copy;
    });
    this.copyQueues.set(sourceId, task);
    try { return await task; }
    finally { if (this.copyQueues.get(sourceId) === task) this.copyQueues.delete(sourceId); }
  }

  async transportFor(tab, owner, { signal, onTransport } = {}) {
    if (tab.controlled !== true || this.copyOwners.get(tab.id) !== owner) throw new Error('Only this session\'s controlled copy may be attached. Select a source page to duplicate it first.');
    const previous = this.leases.get(tab.id);
    if (previous) throw new Error('This Chrome tab is already controlled by another browser session. Disconnect that session before selecting it here.');
    const transport = new TabTransport(this, tab, owner);
    this.leases.set(tab.id, transport);
    onTransport?.(transport);
    const abort = () => transport.close('Existing-tab connection cancelled.');
    signal?.addEventListener('abort', abort, { once: true });
    try {
      signal?.throwIfAborted();
      await transport.attach();
      signal?.throwIfAborted();
      return transport;
    } catch (error) { await transport.dispose(); throw error; }
    finally { signal?.removeEventListener('abort', abort); }
  }

  async dispose() {
    this.disposed = true;
    await this.startTask?.catch(() => {});
    await Promise.allSettled([...this.leases.values()].map(transport => transport.dispose()));
    this.socket?.terminate();
    this.wss?.close();
    if (this.server?.listening) await new Promise(resolve => this.server.close(resolve));
  }
}

/** A per-tab CDP transport understood by Playwright, backed by chrome.debugger. */
class TabTransport {
  constructor(bridge, tab, owner) {
    this.bridge = bridge; this.tab = tab; this.owner = owner;
    this.sessionId = `dsh-tab-${tab.id}`;
    this.childSessions = new Set();
    this.closed = false;
    this.onProtocol = message => {
      if (message.tabId !== tab.id || this.closed) return;
      if (message.type === 'debugger-detached') { this.close('Chrome debugger detached.'); return; }
      if (message.method === 'Target.attachedToTarget') this.childSessions.add(message.params.sessionId);
      if (message.method === 'Target.detachedFromTarget') this.childSessions.delete(message.params.sessionId);
      this.onmessage?.({ method: message.method, params: message.params, sessionId: message.sessionId || this.sessionId });
    };
    this.onDisconnect = () => this.close('Chrome extension disconnected.');
    bridge.on('protocol', this.onProtocol);
    bridge.on('disconnected', this.onDisconnect);
  }

  async attach() {
    this.attachAttempted = true;
    await this.bridge.command('debugger.attach', { tabId: this.tab.id });
    if (this.closed) throw new Error('Existing-tab attachment was cancelled.');
    const { targetInfo } = await this.bridge.command('debugger.sendCommand', { tabId: this.tab.id, method: 'Target.getTargetInfo' });
    this.targetInfo = { ...targetInfo, browserContextId: targetInfo.browserContextId || 'default', attached: true };
    // chrome.debugger exposes page domains; Browser.getVersion is not available in that API.
    const { result } = await this.bridge.command('debugger.sendCommand', { tabId: this.tab.id, method: 'Runtime.evaluate', params: { expression: 'navigator.userAgent', returnByValue: true } });
    const userAgent = result?.value || 'Chrome/125.0.0.0';
    const version = /(?:HeadlessChrome|Chrome)\/([\d.]+)/u.exec(userAgent)?.[1] || '125.0.0.0';
    this.version = { protocolVersion: '1.3', product: `Chrome/${version}`, revision: '', userAgent, jsVersion: '' };
  }

  send(message) {
    if (this.closed) return;
    void this.handle(message).then(result => {
      if (!this.closed) this.onmessage?.({ id: message.id, ...(message.sessionId ? { sessionId: message.sessionId } : {}), result });
    }, error => {
      if (!this.closed) this.onmessage?.({ id: message.id, ...(message.sessionId ? { sessionId: message.sessionId } : {}), error: { code: -32000, message: error.message } });
    });
  }

  async handle({ method, params = {}, sessionId }) {
    if (!sessionId) {
      if (method === 'Browser.getVersion') return this.version;
      if (method === 'Target.setAutoAttach') {
        if (params.autoAttach && !this.announced) {
          this.announced = true;
          this.onmessage?.({ method: 'Target.attachedToTarget', params: { sessionId: this.sessionId, targetInfo: this.targetInfo, waitingForDebugger: false } });
        }
        return {};
      }
      if (method === 'Target.getTargetInfo') return { targetInfo: this.targetInfo };
      if (method === 'Target.getTargets') return { targetInfos: [this.targetInfo] };
      if (method === 'Target.getBrowserContexts') return { browserContextIds: [] };
      if (['Target.setDiscoverTargets', 'Browser.setDownloadBehavior'].includes(method)) return {};
      if (method === 'Target.activateTarget') return {}; // Keep the user's active tab and window unchanged.
      if (method === 'Target.closeTarget') {
        if (params.targetId !== this.targetInfo.targetId) throw new Error('Cannot close an unselected tab.');
        await this.bridge.command('tabs.remove', { tabId: this.tab.id }); return { success: true };
      }
      if (method === 'Browser.close') throw new Error('Attached browser cannot be closed. Disconnect the session instead.');
      if (method === 'Target.attachToBrowserTarget') throw new Error('Browser-wide CDP is not available through a selected tab.');
      throw new Error(`Browser-level command ${method} is not supported by the selected-tab bridge.`);
    }
    const child = sessionId !== this.sessionId;
    if (child && !this.childSessions.has(sessionId)) throw new Error('Unknown CDP child session.');
    if (method === 'Page.bringToFront') return {}; // Never steal focus from the user's tabs.
    if (method === 'Target.getTargetInfo' && !child) return { targetInfo: this.targetInfo };
    // Raster the requested clip without relying on a foreground compositor surface.
    const forwarded = method === 'Page.captureScreenshot' ? { ...params, fromSurface: true, captureBeyondViewport: true, optimizeForSpeed: true } : params;
    return this.bridge.command('debugger.sendCommand', { tabId: this.tab.id, ...(child ? { sessionId } : {}), method, params: forwarded });
  }

  close(reason = 'DSH disconnected from the tab.') {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.(reason);
    void this.dispose();
  }

  dispose() {
    if (this.disposeTask) return this.disposeTask;
    this.closed = true;
    this.bridge.off('protocol', this.onProtocol); this.bridge.off('disconnected', this.onDisconnect);
    this.disposeTask = (async () => {
      try {
        if (this.attachAttempted && this.bridge.connected) await this.bridge.command('debugger.detach', { tabId: this.tab.id });
      } finally {
        if (this.bridge.leases.get(this.tab.id) === this) this.bridge.leases.delete(this.tab.id);
      }
    })();
    this.disposeTask.catch(() => {});
    return this.disposeTask;
  }
}

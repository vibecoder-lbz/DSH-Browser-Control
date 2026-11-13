import { chromium } from './playwright.js';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SnapshotStore } from './snapshot.js';
import { TerminalStore } from './terminal.js';
import { EditorStore } from './editor.js';
import { publicUrl } from './url.js';
import { ChromeBridge, publicTab, selectTab } from './bridge.js';

export const DEFAULTS = Object.freeze({
  headless: false, viewportWidth: 1280, viewportHeight: 800,
  actionTimeoutMs: 10000, navigationTimeoutMs: 30000, launchTimeoutMs: 30000,
  idleTimeoutMs: 900000, maxElements: 100, maxTextChars: 12000,
});

function positiveInt(value, name, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`${name} must be an integer between 1 and ${max}.`);
  return value;
}

export function validateUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Provide an absolute http:// or https:// URL.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http:// and https:// navigation is supported.');
  if (url.username || url.password) throw new Error('URLs containing credentials are not supported.');
  return url.href;
}

export async function findBrowser(executablePath) {
  const candidates = executablePath ? [path.resolve(executablePath)] : [
    process.env.DSH_BROWSER_EXECUTABLE,
    ...(platform() === 'win32' ? [
      path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
      path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Microsoft/Edge/Application/msedge.exe'),
    ] : platform() === 'darwin' ? [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ] : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']),
    chromium.executablePath(),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { await access(candidate, constants.F_OK); return candidate; } catch { /* try next */ }
  }
  throw new Error('No Chrome, Edge or Chromium found. Install one or configure executablePath / DSH_BROWSER_EXECUTABLE.');
}

/** Owns one dedicated browser process. No existing user browser/profile is attached. */
class BrowserSession {
  constructor(config) {
    this.config = config;
    this.snapshot = new SnapshotStore(config);
    this.terminalStore = new TerminalStore(config);
    this.editorStore = new EditorStore();
    this.tabs = new Map();
    this.nextTab = 1;
    this.events = [];
    this.closing = false;
  }

  start(signal) {
    this.launchController = new AbortController();
    const launchSignal = signal ? AbortSignal.any([signal, this.launchController.signal]) : this.launchController.signal;
    this.startTask = this.launch(launchSignal);
    return this.startTask;
  }

  async launch(signal) {
    signal.throwIfAborted();
    const executable = await findBrowser(this.config.executablePath);
    signal.throwIfAborted();
    const root = this.config.profileRoot || tmpdir();
    await mkdir(root, { recursive: true });
    this.profileDir = await mkdtemp(path.join(root, 'dsh-browser-use-'));
    // Connect through localhost CDP. Inherited/ignored stdio avoids named pipe requirements.
    const args = [
      `--user-data-dir=${this.profileDir}`, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
      '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
      '--disable-component-update', '--disable-sync', '--disable-session-crashed-bubble',
      `--window-size=${this.config.viewportWidth},${this.config.viewportHeight}`,
      ...(this.config.headless ? ['--headless=new'] : []), 'about:blank',
    ];
    try {
      signal.throwIfAborted();
      this.child = spawn(executable, args, { stdio: 'ignore', windowsHide: this.config.headless });
      this.exited = new Promise(resolve => {
        this.child.once('exit', () => resolve());
        this.child.once('error', error => { this.launchError = error; resolve(); });
      });
      const deadline = Date.now() + this.config.launchTimeoutMs;
      let endpoint;
      while (Date.now() < deadline) {
        signal?.throwIfAborted();
        if (this.launchError) throw this.launchError;
        if (this.child.exitCode !== null) throw new Error(`Browser exited during launch (${this.child.exitCode}).`);
        let content;
        try { content = await readFile(path.join(this.profileDir, 'DevToolsActivePort'), 'utf8'); }
        catch (error) { if (!['ENOENT', 'EBUSY'].includes(error.code)) throw error; }
        if (content) {
          const [port, wsPath] = content.trim().split(/\r?\n/u);
          if (/^\d+$/u.test(port) && wsPath?.startsWith('/devtools/browser/')) {
            endpoint = `ws://127.0.0.1:${port}${wsPath}`;
            break;
          }
        }
        await delay(100, undefined, { signal });
      }
      if (!endpoint) throw new Error('Browser launch timed out waiting for its localhost debugging endpoint.');
      this.browser = await chromium.connectOverCDP(endpoint, { timeout: this.config.launchTimeoutMs });
      signal?.throwIfAborted();
      this.context = this.browser.contexts()[0];
      this.context.setDefaultTimeout(this.config.actionTimeoutMs);
      this.context.setDefaultNavigationTimeout(this.config.navigationTimeoutMs);
      this.context.on('page', page => { this.registerPage(page); this.page = page; });
      for (const page of this.context.pages()) this.registerPage(page);
      this.page = this.context.pages()[0] || await this.context.newPage();
      await this.page.setViewportSize({ width: this.config.viewportWidth, height: this.config.viewportHeight });
      this.browser.on('disconnected', () => { this.disconnected = true; });
      return this;
    } catch (error) {
      await this.shutdown();
      throw error;
    }
  }

  registerPage(page) {
    if ([...this.tabs.values()].includes(page)) return;
    this.tabs.set(`tab${this.nextTab++}`, page);
    page.on('dialog', dialog => {
      this.events.push({ type: 'dialog-dismissed', dialogType: dialog.type(), message: dialog.message().slice(0, 500) });
      if (this.events.length > 10) this.events.shift();
      void dialog.dismiss().catch(() => {});
    });
    page.on('download', download => {
      this.events.push({ type: 'download-cancelled', filename: download.suggestedFilename() });
      void download.cancel().catch(() => {});
    });
    page.on('close', () => {
      for (const [id, candidate] of this.tabs) if (candidate === page) this.tabs.delete(id);
    });
    page.on('popup', popup => { this.registerPage(popup); this.page = popup; });
  }

  async activePage() {
    if (!this.page || this.page.isClosed()) this.page = [...this.tabs.values()].find(page => !page.isClosed());
    if (!this.page) throw new Error('No browser tabs remain. Call browser_open to create a tab.');
    if (!this.page.viewportSize()) {
      await this.page.setViewportSize({ width: this.config.viewportWidth, height: this.config.viewportHeight });
    }
    return this.page;
  }

  async capture(page) {
    return { data: (await page.screenshot({ type: 'png', fullPage: false, scale: 'css', timeout: this.config.actionTimeoutMs })).toString('base64'), mimeType: 'image/png' };
  }

  async viewport(page) {
    return page.viewportSize() || this.currentViewport;
  }

  async observe({ screenshot = false } = {}, retries = 2) {
    const page = await this.activePage();
    try {
      const dom = await this.snapshot.capture(page);
      const result = {
        url: publicUrl(page.url()), title: await page.title(),
        activeTab: [...this.tabs].find(([, candidate]) => candidate === page)?.[0],
        viewport: await this.viewport(page), ...dom,
        tabs: await this.listTabs(),
      };
      if (screenshot) {
        const image = await this.capture(page);
        if (image.data) result.screenshot = image;
        else result.screenshotNotice = image.notice;
      }
      if (this.page !== page || page.isClosed()) {
        if (retries > 0) return this.observe({ screenshot }, retries - 1);
        throw new Error('The active tab changed while observing. Call browser_observe again.');
      }
      result.events = this.events.splice(0);
      return result;
    } catch (error) {
      if (retries > 0 && !this.closing && (this.page !== page || page.isClosed())) return this.observe({ screenshot }, retries - 1);
      throw error;
    }
  }

  async listTabs() {
    return Promise.all([...this.tabs].map(async ([id, page]) => ({
      id, url: publicUrl(page.url()), title: await page.title().catch(() => ''), active: page === this.page,
    })));
  }

  async open(args) {
    const url = args.url ? validateUrl(args.url) : undefined;
    let page = this.page;
    if (!page || page.isClosed() || args.newTab) page = await this.context.newPage();
    this.page = page;
    await page.setViewportSize({ width: this.config.viewportWidth, height: this.config.viewportHeight });
    if (url) await page.goto(url, { waitUntil: 'domcontentloaded' });
    return this.observe(args);
  }

  async target(args, page) {
    const ref = typeof args.ref === 'string' && args.ref.trim() ? args.ref.trim() : undefined;
    const selector = typeof args.selector === 'string' && args.selector.trim() ? args.selector.trim() : undefined;
    const hasX = args.x !== undefined;
    const hasY = args.y !== undefined;
    if (hasX !== hasY) throw new Error('Coordinates require both x and y. Choose ref, selector, or both x and y.');
    const choices = Number(Boolean(ref)) + Number(Boolean(selector)) + Number(hasX && hasY);
    if (choices !== 1) throw new Error('Choose exactly one target: ref, selector, or both x and y.');
    if (ref) {
      const handle = this.snapshot.resolve(ref, page);
      if (!await handle.evaluate(el => el.isConnected)) throw new Error('The element is detached. Call browser_observe for new references.');
      return handle;
    }
    if (selector) {
      if (selector.length > 2000) throw new Error('Selector is too long.');
      const locator = page.locator(selector);
      const count = await locator.count();
      if (count !== 1) throw new Error(`Selector matched ${count} elements; use a unique selector or an element reference.`);
      return locator;
    }
    this.coordinates(args.x, args.y, page);
    return null;
  }

  coordinates(x, y, page) {
    const viewport = page.viewportSize() || this.currentViewport;
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= viewport.width || y >= viewport.height) {
      throw new Error(`Coordinates must be inside the ${viewport.width}x${viewport.height} CSS-pixel viewport.`);
    }
  }

  async act(args, signal) {
    const page = await this.activePage();
    const mouseActions = ['click', 'double_click', 'hover', 'fill', 'type', 'select'];
    const targetRequired = new Set(['click', 'double_click', 'hover', 'fill', 'type', 'select']);
    let target;
    if (targetRequired.has(args.action)) target = await this.target(args, page);
    if (['fill', 'type'].includes(args.action)) {
      const codeEditor = target ? await target.evaluate(el => Boolean(el.closest('.monaco-editor,.ace_editor,.CodeMirror,.cm-editor'))) :
        await page.evaluate(({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest('.monaco-editor,.ace_editor,.CodeMirror,.cm-editor')), args);
      if (codeEditor) throw new Error('This target is a code editor. Use browser_editor to read the complete document, preview a structural edit and apply it. Hidden textareas and auto-indent can corrupt YAML hierarchy.');
    }
    switch (args.action) {
      case 'click':
      case 'double_click': {
        const method = args.action === 'click' ? 'click' : 'dblclick';
        const options = { button: args.button || 'left' };
        if (target) await target[method](options);
        else await page.mouse[method](args.x, args.y, options);
        break;
      }
      case 'hover':
        if (target) await target.hover(); else await page.mouse.move(args.x, args.y);
        break;
      case 'fill':
      case 'type':
        if (typeof args.text !== 'string' || args.text.length > 50000) throw new Error('Provide text with at most 50000 characters.');
        if (args.action === 'fill') {
          if (target) await target.fill(args.text);
          else { await page.mouse.click(args.x, args.y); await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.insertText(args.text); }
        } else {
          if (target) await target.focus(); else await page.mouse.click(args.x, args.y);
          await page.keyboard.insertText(args.text);
        }
        break;
      case 'press':
        if (!args.key || args.key.length > 100) throw new Error('Provide a Playwright key such as Enter, Tab or ControlOrMeta+A.');
        if ((typeof args.ref === 'string' && args.ref.trim()) || (typeof args.selector === 'string' && args.selector.trim()) || args.x !== undefined || args.y !== undefined) {
          target = await this.target(args, page);
          if (target) await target.focus(); else await page.mouse.click(args.x, args.y);
        }
        await page.keyboard.press(args.key);
        break;
      case 'scroll': {
        const dx = args.deltaX ?? 0;
        const dy = args.deltaY ?? 600;
        if (![dx, dy].every(value => Number.isFinite(value) && Math.abs(value) <= 10000)) throw new Error('Scroll deltas must be between -10000 and 10000.');
        if (args.x !== undefined || args.y !== undefined) {
          if (args.x === undefined || args.y === undefined) throw new Error('Scroll coordinates require both x and y.');
          this.coordinates(args.x, args.y, page);
          await page.mouse.move(args.x, args.y);
        }
        await page.mouse.wheel(dx, dy);
        // Wheel input is dispatched before the next animation frame paints.
        await delay(100, undefined, { signal });
        break;
      }
      case 'drag':
        this.coordinates(args.x, args.y, page);
        this.coordinates(args.toX, args.toY, page);
        await page.mouse.move(args.x, args.y);
        await page.mouse.down();
        try { await page.mouse.move(args.toX, args.toY, { steps: 12 }); }
        finally { await page.mouse.up().catch(() => {}); }
        break;
      case 'select':
        if (!target || typeof args.value !== 'string') throw new Error('select requires ref or selector and an option value.');
        await target.selectOption(args.value);
        break;
      case 'back': await page.goBack({ waitUntil: 'domcontentloaded' }); break;
      case 'forward': await page.goForward({ waitUntil: 'domcontentloaded' }); break;
      case 'reload': await page.reload({ waitUntil: 'domcontentloaded' }); break;
      case 'wait':
        await delay(positiveInt(args.waitMs ?? 500, 'waitMs', 5000), undefined, { signal });
        break;
      default: throw new Error(`Unsupported browser action: ${args.action}`);
    }
    signal?.throwIfAborted();
    return this.observe(args);
  }

  async editor(args, signal) {
    const page = await this.activePage();
    await this.snapshot.clear();
    return { url: publicUrl(page.url()), title: await page.title(), ...await this.editorStore.run(page, args, signal) };
  }

  async terminal(args, signal) {
    const page = await this.activePage();
    await this.snapshot.clear();
    const result = await this.terminalStore.run(page, args, signal);
    const value = {
      url: publicUrl(page.url()), title: await page.title().catch(() => ''), viewport: await this.viewport(page),
      ...result,
    };
    if (args.screenshot) {
      try {
        const image = await this.capture(page);
        if (image.data) value.screenshot = image;
        else value.screenshotNotice = image.notice;
      } catch (error) {
        if (!result.input) throw error;
        value.observationError = `Input was dispatched but screenshot failed: ${error.message}`;
      }
    }
    return value;
  }

  async manageTabs(args) {
    switch (args.action) {
      case 'list': return { tabs: await this.listTabs() };
      case 'new': return this.open({ ...args, newTab: true });
      case 'switch': {
        const page = this.tabs.get(args.tabId);
        if (!page) throw new Error('Unknown tabId. Use browser_tabs with action=list.');
        this.page = page;
        await page.bringToFront();
        await page.setViewportSize({ width: this.config.viewportWidth, height: this.config.viewportHeight });
        return this.observe(args);
      }
      case 'close': {
        const page = args.tabId ? this.tabs.get(args.tabId) : await this.activePage();
        if (!page) throw new Error('Unknown tabId.');
        await page.close();
        if (!this.page || this.page === page || this.page.isClosed()) this.page = [...this.tabs.values()][0];
        await this.snapshot.clear();
        return { tabs: await this.listTabs() };
      }
      default: throw new Error(`Unsupported tab action: ${args.action}`);
    }
  }

  armForcedStop() {
    if (this.stopTimer) return;
    // Install this before any CDP or handle disposal await: a frozen renderer must not block cancellation.
    this.stopTimer = setTimeout(() => {
      if (this.child && this.child.exitCode === null && !this.launchError) this.child.kill();
    }, 2000);
    this.stopTimer.unref();
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.launchController?.abort();
    this.armForcedStop();
    this.closePromise = (async () => {
      await this.startTask?.catch(() => {});
      await this.shutdown();
    })();
    return this.closePromise;
  }

  shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.armForcedStop();
    this.shutdownPromise = (async () => {
      this.closing = true;
      try {
        await Promise.all([this.snapshot.clear(), this.terminalStore.clear(), this.editorStore.clear()]);
        if (this.browser?.isConnected()) {
          try {
            const client = await this.browser.newBrowserCDPSession();
            await client.send('Browser.close');
          } catch { /* a closed browser disconnects CDP */ }
          await this.browser.close().catch(() => {});
        }
        if (this.child && this.child.exitCode === null && !this.launchError) {
          const exited = await Promise.race([this.exited.then(() => true), delay(2500, false, { ref: false })]);
          if (!exited) this.child.kill();
          await this.exited;
        }
        this.tabs.clear();
        if (this.profileDir) {
          // profileDir is the exact directory created by mkdtemp above, never a user path.
          await rm(this.profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        }
      } finally {
        clearTimeout(this.stopTimer);
      }
    })();
    return this.shutdownPromise;
  }
}

/** An attached session owns a debugger connection, never the user's Chrome process or tabs. */
class AttachedSession extends BrowserSession {
  constructor(config, bridge, tab, owner) {
    super(config);
    this.mode = 'existing'; this.bridge = bridge; this.tab = tab; this.owner = owner;
  }

  start(signal) {
    this.startTask = this.attach(signal);
    return this.startTask;
  }

  async attach(signal) {
    signal?.throwIfAborted();
    this.transport = await this.bridge.transportFor(this.tab, this.owner, { signal, onTransport: transport => { this.transport = transport; } });
    if (this.closing || signal?.aborted) {
      await this.transport.dispose();
      signal?.throwIfAborted();
      throw new Error('Existing-tab connection was cancelled.');
    }
    try {
      this.browser = await chromium.connectOverCDP(this.transport, { noDefaults: true, timeout: this.config.launchTimeoutMs });
      if (this.closing) throw new Error('Existing-tab connection was cancelled.');
      signal?.throwIfAborted();
      this.context = this.browser.contexts()[0];
      this.context.setDefaultTimeout(this.config.actionTimeoutMs);
      this.context.setDefaultNavigationTimeout(this.config.navigationTimeoutMs);
      this.page = this.context.pages()[0];
      if (!this.page) throw new Error('Selected Chrome tab did not expose an accessible page.');
      this.tabs.set(`chrome-${this.tab.id}`, this.page);
      this.browser.on('disconnected', () => { this.disconnected = true; });
      // Emulate focus only inside the controlled copy; do not activate its browser tab/window.
      await this.bridge.command('debugger.sendCommand', { tabId: this.tab.id, method: 'Emulation.setFocusEmulationEnabled', params: { enabled: true } });
      await this.activePage();
      return this;
    } catch (error) {
      this.transport.close(); await this.transport.dispose();
      throw error;
    }
  }

  async activePage() {
    if (!this.page || this.page.isClosed()) throw new Error('Selected Chrome tab was closed or detached. Select it again with browser_connect.');
    this.currentViewport = await this.page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    return this.page;
  }

  async capture() {
    const notice = 'Chrome is not painting this background copy, so a fresh screenshot is unavailable. The plugin did not activate a tab or create a window. Use DOM output, or manually select the marked copy if a visual inspection is required; do not infer remote terminal success from an empty image.';
    if (this.captureStalled) {
      const tab = (await this.bridge.listTabs()).find(tab => tab.id === this.tab.id);
      if (!tab?.active) return { notice };
      this.captureStalled = false; // The user selected the copy manually; retry without changing browser UI.
    }
    try {
      const { data } = await this.bridge.command('debugger.sendCommand', { tabId: this.tab.id, method: 'Page.captureScreenshot', params: { format: 'png', fromSurface: true, captureBeyondViewport: true } }, { timeoutMs: 2500 });
      return { data, mimeType: 'image/png' };
    } catch (error) {
      if (!this.bridge.connected || this.disconnected || this.closing) throw error;
      if (!/timed out/iu.test(error.message)) throw error;
      this.captureStalled = true;
      return { notice };
    }
  }

  async listTabs() {
    return (await this.bridge.listTabs()).map(tab => ({ ...publicTab(tab), selected: tab.id === this.tab.id }));
  }

  async observe(args = {}) {
    const result = await super.observe(args);
    return { ...result, mode: 'existing', selectedTab: `chrome-${this.tab.id}`, controlledCopy: true,
      ...(Number.isInteger(this.tab.sourceTabId) ? { sourceTab: `chrome-${this.tab.sourceTabId}` } : {}),
      copyNotice: 'Commands and input target the marked copy only. Cookies and server-side account data are shared; live JavaScript state and SSH sessions are not guaranteed to duplicate.' };
  }

  async open(args) {
    if (args.newTab) throw new Error('Use browser_tabs action=new to create and select a tab in the connected Chrome.');
    if (args.url) await (await this.activePage()).goto(validateUrl(args.url), { waitUntil: 'domcontentloaded' });
    return this.observe(args);
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    // Disconnect first so a frozen renderer cannot block pending handle disposal.
    this.transport?.close();
    this.closePromise = (async () => {
      await this.startTask?.catch(() => {});
      this.transport?.close();
      await this.transport?.dispose();
      await this.browser?.close().catch(() => {});
      await Promise.all([this.snapshot.clear(), this.terminalStore.clear(), this.editorStore.clear()]);
      this.tabs.clear();
    })();
    return this.closePromise;
  }
}

/** Per-session serialization also prevents tools from racing across different agent turns. */
export class BrowserManager {
  constructor(options = {}) {
    this.config = { ...DEFAULTS, ...options };
    for (const key of ['viewportWidth', 'viewportHeight', 'actionTimeoutMs', 'navigationTimeoutMs', 'launchTimeoutMs', 'idleTimeoutMs', 'maxElements', 'maxTextChars']) {
      positiveInt(this.config[key], key);
    }
    if (this.config.viewportWidth > 3840 || this.config.viewportHeight > 2160) throw new Error('Viewport cannot exceed 3840x2160.');
    this.sessions = new Map();
    this.queues = new Map();
    this.bridge = new ChromeBridge(options);
    this.disposed = false;
  }

  async run(sessionId, operation, args = {}, { signal } = {}) {
    if (!sessionId) throw new Error('Browser tools require a DSH session identity.');
    if (this.disposed) throw new Error('Browser plugin has been disposed.');
    const previous = this.queues.get(sessionId) || Promise.resolve();
    const serializesChrome = operation === 'connect' || this.sessions.get(sessionId)?.session.mode === 'existing';
    const ready = Promise.all([previous.catch(() => {}), serializesChrome ? this.chromeQueue?.catch(() => {}) : undefined]);
    const current = ready.then(async () => {
      signal?.throwIfAborted();
      if (this.disposed) throw new Error('Browser plugin has been disposed.');
      let entry = this.sessions.get(sessionId);
      clearTimeout(entry?.timer);
      if (operation === 'close' || (operation === 'connect' && args.action === 'disconnect')) {
        const attached = entry?.session.mode === 'existing';
        if (entry) { this.sessions.delete(sessionId); await entry.session.close(); }
        return attached ? { detached: true, mode: 'existing', message: 'Control released; Chrome tabs and login state remain open.' } : { closed: true };
      }
      if (entry?.session.disconnected || entry?.session.closing) {
        this.sessions.delete(sessionId);
        await entry.session.close();
        entry = undefined;
      }
      if (!entry && !['open', 'connect'].includes(operation)) throw new Error('Browser is not open. Call browser_open for a dedicated browser or browser_connect to select an existing Chrome tab.');
      const abort = () => {
        if (entry) {
          this.sessions.delete(sessionId);
          void entry.session.close().catch(() => {});
        }
      };
      signal?.addEventListener('abort', abort, { once: true });
      let pendingCopy;
      try {
        if (operation === 'connect' || (operation === 'tabs' && entry?.session.mode === 'existing')) {
          await this.bridge.start();
          signal?.throwIfAborted();
          if (operation === 'connect' && (args.action || 'select') === 'status') return this.bridge.status();
          if (!this.bridge.connected) return this.bridge.status();
          const tabs = await this.bridge.listTabs();
          if (args.action === 'list' || args.action === 'tabs') return { ...this.bridge.status(), tabs: tabs.map(publicTab) };
          if (operation === 'tabs' && args.action === 'close') {
            const chosenId = args.tabId || `chrome-${entry.session.tab.id}`;
            const chosen = selectTab(tabs, { tabId: chosenId });
            if (!chosen.matched) throw new Error('Unknown Chrome tab ID.');
            if (!chosen.tab.controlled) throw new Error('Original user tabs cannot be closed by this plugin. Only controlled copies may be closed.');
            const owner = this.bridge.copyOwners.get(chosen.tab.id) || this.bridge.leases.get(chosen.tab.id)?.owner;
            if (owner && owner !== sessionId) throw new Error('Cannot close a Chrome tab controlled by another DSH session.');
            await this.bridge.command('tabs.remove', { tabId: chosen.tab.id });
            if (chosen.tab.id === entry.session.tab.id) {
              this.sessions.delete(sessionId); await entry.session.close(); entry = undefined;
            }
            return { mode: 'existing', tabs: (await this.bridge.listTabs()).map(publicTab) };
          }
          if (!['select', 'switch', 'new', undefined].includes(args.action)) throw new Error('Unknown existing Chrome connection action.');
          let selected;
          if (operation === 'tabs' && args.action === 'new') {
            const tab = await this.bridge.command('tabs.create', { url: args.url ? validateUrl(args.url) : 'about:blank' });
            selected = { matched: true, tab, reason: 'new-tab' };
          } else selected = selectTab(args.tabId?.trim() ? tabs : tabs.filter(tab => !tab.controlled && !tab.recoveryRequired), args);
          if (!selected.matched) return { mode: 'existing', connected: true, selection: { matched: false, reason: selected.reason }, candidates: selected.candidates.map(publicTab) };
          const source = selected.tab;
          if (source.recoveryRequired) throw new Error('This old copy cannot be verified. Close that old copy manually before selecting its original source again; no new tab was created.');
          const copy = await this.bridge.controlCopy(source, sessionId);
          pendingCopy = copy;
          signal?.throwIfAborted();
          const lease = this.bridge.leases.get(copy.id);
          if (lease && lease.owner !== sessionId) throw new Error('Selected controlled copy is used by another DSH session.');
          if (!(entry?.session.mode === 'existing' && entry.session.tab.id === copy.id)) {
            if (entry) { this.sessions.delete(sessionId); await entry.session.close(); }
            entry = { session: new AttachedSession(this.config, this.bridge, copy, sessionId) };
            this.sessions.set(sessionId, entry);
            await entry.session.start(signal);
          }
          pendingCopy = undefined;
          const observation = await entry.session.observe(args);
          signal?.throwIfAborted();
          return { ...observation, selection: { matched: true, reason: selected.reason, source: publicTab(source), tab: publicTab(copy), background: true } };
        }
        if (operation === 'open' && args.url) validateUrl(args.url);
        if (!entry) {
          entry = { session: new BrowserSession({ ...this.config, headless: args.headless ?? this.config.headless }) };
          this.sessions.set(sessionId, entry);
          await entry.session.start(signal);
        }
        signal?.throwIfAborted();
        let result;
        if (operation === 'open') result = await entry.session.open(args);
        else if (operation === 'observe') result = await entry.session.observe(args);
        else if (operation === 'act') result = await entry.session.act(args, signal);
        else if (operation === 'tabs') result = await entry.session.manageTabs(args);
        else if (operation === 'terminal') result = await entry.session.terminal(args, signal);
        else if (operation === 'editor') result = await entry.session.editor(args, signal);
        else throw new Error(`Unknown browser operation ${operation}`);
        signal?.throwIfAborted();
        return result;
      } catch (error) {
        if (pendingCopy && !this.bridge.leases.has(pendingCopy.id) && this.bridge.connected) {
          await this.bridge.command('debugger.detach', { tabId: pendingCopy.id }).catch(() => {});
        }
        if (signal?.aborted || !entry?.session.browser?.isConnected()) {
          this.sessions.delete(sessionId);
          await entry?.session.close().catch(() => {});
        }
        if (signal?.aborted) throw signal.reason ?? error;
        throw error;
      } finally {
        signal?.removeEventListener('abort', abort);
        if (entry && this.sessions.get(sessionId) === entry) {
          entry.timer = setTimeout(() => {
            void this.run(sessionId, 'close').catch(() => {});
          }, this.config.idleTimeoutMs);
          entry.timer.unref();
        }
      }
    });
    this.queues.set(sessionId, current);
    if (serializesChrome) this.chromeQueue = current;
    try { return await current; }
    finally {
      if (this.queues.get(sessionId) === current) this.queues.delete(sessionId);
      if (this.chromeQueue === current) this.chromeQueue = undefined;
    }
  }

  async dispose() {
    this.disposed = true;
    const entries = [...this.sessions.values()];
    for (const entry of entries) clearTimeout(entry.timer);
    await Promise.allSettled(entries.map(entry => entry.session.close()));
    await Promise.allSettled(this.queues.values());
    await this.bridge.dispose();
    this.sessions.clear();
  }
}

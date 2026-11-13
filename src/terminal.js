import { setTimeout as delay } from 'node:timers/promises';
import { publicUrl } from './url.js';

function readTerminalDOM(root, maxChars) {
  const accessibility = root.querySelector('.xterm-accessibility-tree');
  const rows = root.querySelector('.xterm-rows');
  const source = accessibility || rows;
  const lines = source ? Array.from(source.children).map(row => (row.textContent || '').replace(/\u00a0/gu, ' ').replace(/\s+$/u, '')) : [];
  const raw = lines.join('\n').replace(/\n+$/u, '');
  return {
    text: raw.slice(-maxChars), truncated: raw.length > maxChars,
    textReadable: Boolean(source),
    outputSource: accessibility ? 'accessibility' : rows ? 'dom' : 'visual-only',
  };
}

function checkSingleLine(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > 4096) throw new Error('Terminal text must contain 1–4096 characters.');
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(text)) {
    throw new Error('Terminal type accepts a single line without control characters. Send Enter or other control keys separately with action=press.');
  }
  if (/[^\x20-\x7e]/u.test(text)) throw new Error('Terminal typing currently supports printable ASCII commands. Non-ASCII input may be dropped by xterm accessibility mode.');
}

/** Terminal IDs retain real handles and never silently retarget a different SSH session. */
export class TerminalStore {
  constructor({ maxTextChars = 12000 } = {}) {
    this.maxTextChars = maxTextChars;
    this.entries = new Map();
    this.nextId = 1;
  }

  async clear() {
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.allSettled(entries.map(entry => entry.handle.dispose()));
  }

  async describe(entry, { text = true, maxChars = this.maxTextChars } = {}) {
    if (entry.page.isClosed() || !await entry.handle.evaluate(root => root.isConnected)) {
      throw new Error('This terminal is detached. List terminals again and select the intended SSH session.');
    }
    const box = await entry.handle.boundingBox();
    const metadata = {
      terminalId: entry.id, frameUrl: publicUrl(entry.frame.url()), frameIndex: entry.page.frames().indexOf(entry.frame),
      box: box ? { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) } : null,
    };
    if (text) Object.assign(metadata, await entry.handle.evaluate(readTerminalDOM, maxChars));
    return metadata;
  }

  async discover(page, args = {}) {
    const selector = args.selector || '.xterm';
    if (selector.length > 2000) throw new Error('Terminal selector is too long.');
    const frames = page.frames();
    if (args.frameIndex !== undefined && (!Number.isInteger(args.frameIndex) || args.frameIndex < 0 || args.frameIndex >= frames.length)) {
      throw new Error('frameIndex does not identify a current page frame. List terminals without frameIndex to inspect them.');
    }
    await this.clear();
    const terminals = [];
    let truncated = false;
    for (const [index, frame] of frames.entries()) {
      if (args.frameIndex !== undefined && args.frameIndex !== index) continue;
      const handles = await frame.locator(selector).elementHandles();
      const temporary = new Set(handles);
      try {
        for (const handle of handles) {
          if (terminals.length >= 12) { truncated = true; continue; }
          if (!await handle.isVisible()) continue;
          const id = `terminal${this.nextId++}`;
          const entry = { id, handle, frame, page };
          const terminal = await this.describe(entry, { maxChars: Math.min(this.maxTextChars, 1000) });
          this.entries.set(id, entry);
          temporary.delete(handle);
          terminals.push(terminal);
        }
      } finally {
        await Promise.allSettled([...temporary].map(handle => handle.dispose()));
      }
    }
    return { terminals, truncated };
  }

  async select(page, args) {
    if (args.terminalId) {
      const entry = this.entries.get(args.terminalId);
      if (!entry || entry.page !== page) throw new Error('Unknown or stale terminalId. List terminals in the active tab again.');
      if (args.selector?.trim()) throw new Error('Use terminalId alone, or selector/frameIndex for discovery.');
      if (args.frameIndex !== undefined && args.frameIndex !== 0 && args.frameIndex !== page.frames().indexOf(entry.frame)) throw new Error('terminalId does not belong to the supplied frameIndex.');
      await this.describe(entry, { text: false });
      return entry;
    }
    const result = await this.discover(page, args);
    if (result.terminals.length !== 1) {
      throw new Error(`Found ${result.terminals.length} visible terminals. Use action=list, then choose the intended terminalId.`);
    }
    return this.entries.get(result.terminals[0].terminalId);
  }

  async focus(entry) {
    const input = await entry.handle.$('textarea.xterm-helper-textarea');
    if (!input) throw new Error('No xterm input textarea found. Open the JumpServer Web SSH terminal; this tool does not drive remote desktop canvases.');
    try {
      if (await input.evaluate(el => el.disabled || el.readOnly)) throw new Error('The terminal input is disabled or read-only.');
      // Native focus works in background copies; actionability scroll waits can stall in throttled tabs.
      await input.evaluate(el => el.focus({ preventScroll: true }));
      if (!await input.evaluate(el => el.getRootNode().activeElement === el)) throw new Error('Unable to focus the terminal input.');
    } finally { await input.dispose(); }
  }

  async run(page, args, signal) {
    signal?.throwIfAborted();
    if (args.action === 'list') return this.discover(page, args);
    // Validate before focusing: rejected multiline input must not submit or change the terminal.
    if (args.action === 'type') checkSingleLine(args.text);
    if (args.action === 'press' && (typeof args.key !== 'string' || args.key.length === 0 || args.key.length > 100)) {
      throw new Error('Provide a terminal key, e.g. Enter, Tab or Control+C.');
    }
    if (!['read', 'type', 'press', 'wait'].includes(args.action)) throw new Error(`Unsupported terminal action: ${args.action}`);
    const entry = await this.select(page, args);
    let input;
    if (args.action === 'type' || args.action === 'press') {
      await this.focus(entry);
      signal?.throwIfAborted();
      // A transport error can follow delivered characters/Enter. Record an attempt before dispatch.
      input = { attempted: true, delivery: 'unknown', kind: args.action === 'type' ? 'text' : 'key',
        ...(args.action === 'press' ? { key: args.key } : { enterSent: false }) };
      try {
        // Real key events preserve xterm line editing and work with screen-reader mode.
        if (args.action === 'type') {
          await page.keyboard.type(args.text);
          input = { dispatched: true, kind: 'text', enterSent: false };
        } else {
          await page.keyboard.press(args.key);
          input = { dispatched: true, kind: 'key', key: args.key };
        }
      } catch (error) {
        signal?.throwIfAborted();
        return { terminal: { terminalId: entry.id }, input,
          observationError: `Input may have been partially or fully delivered before the browser call failed: ${error.message}` };
      }
    }
    signal?.throwIfAborted();
    let wait;
    if (args.action === 'wait') {
      const timeoutMs = args.timeoutMs ?? 5000;
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('timeoutMs must be 1–30000 milliseconds.');
      const waitForText = args.waitForText === '' ? undefined : args.waitForText;
      if (waitForText !== undefined && (typeof waitForText !== 'string' || waitForText.length > 2000)) {
        throw new Error('waitForText must contain 1–2000 characters.');
      }
      const started = Date.now();
      let terminal = await this.describe(entry);
      if (waitForText && !terminal.textReadable) {
        wait = { matched: false, timedOut: false, unsupported: true, elapsedMs: Date.now() - started };
      } else {
        while (true) {
          signal?.throwIfAborted();
          const matched = waitForText !== undefined && terminal.text.includes(waitForText);
          const elapsedMs = Date.now() - started;
          if (matched || elapsedMs >= timeoutMs) {
            wait = { matched, timedOut: !matched && waitForText !== undefined, unsupported: false, elapsedMs };
            break;
          }
          await delay(Math.min(250, timeoutMs - elapsedMs), undefined, { signal });
          terminal = await this.describe(entry);
        }
      }
      return { terminal, wait };
    }
    try {
      const terminal = await this.describe(entry);
      return { terminal, ...(input ? { input } : {}) };
    } catch (error) {
      // An observation error after Enter must not look like a command that was never sent.
      if (!input) throw error;
      return { terminal: { terminalId: entry.id }, input, observationError: error.message };
    }
  }
}

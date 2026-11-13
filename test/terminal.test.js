import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserManager } from '../src/browser.js';
import { startTerminalFixture } from './terminal-fixture.mjs';

let fixture;
before(async () => { fixture = await startTerminalFixture(); });
after(async () => { await fixture?.close(); });

async function open(manager, route = '/') {
  const observation = await manager.run('terminal-tests', 'open', { url: fixture.url + route });
  assert.ok(!JSON.stringify(observation).includes('fixture-token-7b91'));
  const page = manager.sessions.get('terminal-tests').session.page;
  for (const frame of page.frames().filter(frame => frame.url().includes('/ssh'))) {
    await frame.waitForFunction(() => window.fixtureReady === true);
  }
  return page;
}
const run = async (manager, args, options) => {
  const started = Date.now();
  try { return await manager.run('terminal-tests', 'terminal', args, options); }
  finally { if (process.env.DEBUG_TERMINAL_TEST) console.log(`${args.action}: ${Date.now() - started}ms`); }
};

test('real xterm in iframe: stages one line, submits separately and reads asynchronous output', { timeout: 60000 }, async () => {
  const manager = new BrowserManager({ headless: true });
  try {
    const page = await open(manager);
    let result = await run(manager, { action: 'list' });
    assert.equal(result.terminals.length, 1);
    assert.equal(result.terminals[0].frameIndex, 1);
    assert.equal(result.terminals[0].outputSource, 'accessibility');
    assert.ok(!result.terminals[0].frameUrl.includes('fixture-token-7b91'));
    assert.ok(page.frames()[1].url().includes('fixture-token-7b91'));
    const terminalId = result.terminals[0].terminalId;
    result = await run(manager, { action: 'type', terminalId, text: 'kubectl config current-context' });
    assert.deepEqual(result.input, { dispatched: true, kind: 'text', enterSent: false });
    const frame = page.frames()[1];
    assert.deepEqual(await frame.evaluate(() => window.executed), []);
    await run(manager, { action: 'press', terminalId, key: 'Enter' });
    result = await run(manager, { action: 'wait', terminalId, waitForText: 'test-cluster-one', timeoutMs: 3000 });
    assert.equal(result.wait.matched, true);
    assert.match(result.terminal.text, /test-cluster-one/);
    await run(manager, { action: 'type', terminalId, text: 'kubectl rollout status deployment/demo --timeout=300s' });
    await run(manager, { action: 'press', terminalId, key: 'Enter' });
    result = await run(manager, { action: 'wait', terminalId, waitForText: 'successfully rolled out', timeoutMs: 3000 });
    assert.equal(result.wait.matched, true);
    const unmatched = await run(manager, { action: 'wait', terminalId, waitForText: 'not-in-the-output', timeoutMs: 250 });
    assert.equal(unmatched.wait.timedOut, true);
    assert.equal(unmatched.wait.matched, false);
    await run(manager, { action: 'type', terminalId, text: 'echo dispatch-once' });
    const originalPress = page.keyboard.press.bind(page.keyboard);
    page.keyboard.press = async key => { await originalPress(key); throw new Error('simulated lost transport acknowledgement'); };
    try {
      const ambiguous = await run(manager, { action: 'press', terminalId, key: 'Enter' });
      assert.equal(ambiguous.input.delivery, 'unknown');
      assert.match(ambiguous.observationError, /partially or fully delivered/);
      assert.equal((await frame.evaluate(() => window.executed)).filter(command => command === 'echo dispatch-once').length, 1);
    } finally { page.keyboard.press = originalPress; }
  } finally { await manager.dispose(); }
});

test('terminal rejects multiline/control input, uses terminal editing keys and expires listing identifiers', { timeout: 60000 }, async () => {
  const manager = new BrowserManager({ headless: true });
  try {
    const page = await open(manager);
    const first = await run(manager, { action: 'list' });
    const terminalId = first.terminals[0].terminalId;
    for (const text of ['kubectl get pods\nwhoami', 'text\r', 'abc\u0003', '非ASCII']) {
      await assert.rejects(run(manager, { action: 'type', terminalId, text }));
    }
    assert.deepEqual(await page.frames()[1].evaluate(() => window.received), []);
    await run(manager, { action: 'type', terminalId, text: 'discard-this' });
    await run(manager, { action: 'press', terminalId, key: 'Control+U' });
    const command = "printf '%s' \"literal-$VALUE\"";
    await run(manager, { action: 'type', terminalId, text: command });
    await run(manager, { action: 'press', terminalId, key: 'Enter' });
    assert.deepEqual(await page.frames()[1].evaluate(() => window.executed), [command]);
    await run(manager, { action: 'list' });
    await assert.rejects(run(manager, { action: 'read', terminalId }), /stale terminalId/);
  } finally { await manager.dispose(); }
});

test('multiple SSH terminals require selection and stay bound to the intended frame/tab', { timeout: 60000 }, async () => {
  const manager = new BrowserManager({ headless: true });
  try {
    const page = await open(manager, '/multiple');
    await assert.rejects(run(manager, { action: 'type', text: 'kubectl config current-context' }), /Found 2/);
    const list = await run(manager, { action: 'list' });
    const terminalId = list.terminals[1].terminalId;
    await run(manager, { action: 'type', terminalId, text: 'kubectl config current-context' });
    await run(manager, { action: 'press', terminalId, key: 'Enter' });
    const result = await run(manager, { action: 'wait', terminalId, waitForText: 'test-cluster-two', timeoutMs: 3000 });
    assert.equal(result.wait.matched, true);
    assert.deepEqual(await page.frames()[1].evaluate(() => window.executed), []);
    await manager.run('terminal-tests', 'tabs', { action: 'new', url: fixture.url });
    await assert.rejects(run(manager, { action: 'read', terminalId }), /stale terminalId/);
  } finally { await manager.dispose(); }
});

test('real WebGL terminal reports unavailable text, retains keyboard control and provides screenshot fallback', { timeout: 60000 }, async () => {
  const manager = new BrowserManager({ headless: true });
  try {
    const page = await open(manager, '/visual');
    const list = await run(manager, { action: 'list' });
    const terminalId = list.terminals[0].terminalId;
    assert.equal(list.terminals[0].textReadable, false);
    assert.equal(list.terminals[0].outputSource, 'visual-only');
    await run(manager, { action: 'type', terminalId, text: 'kubectl config current-context' });
    await run(manager, { action: 'press', terminalId, key: 'Enter' });
    assert.deepEqual(await page.frames()[1].evaluate(() => window.executed), ['kubectl config current-context']);
    const result = await run(manager, { action: 'wait', terminalId, waitForText: 'test-cluster-one', screenshot: true });
    assert.equal(result.wait.unsupported, true);
    assert.equal(result.wait.matched, false);
    assert.equal(result.screenshot.mimeType, 'image/png');
  } finally { await manager.dispose(); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import { Context } from '@deepseek-ai/cordis';
import * as plugin from '../src/index.js';
import { registerBrowserTools, Config } from '../src/index.js';
import { startFixture } from './fixture.mjs';

function registrationHost(imageCapable) {
  const tools = new Map();
  const disposers = [];
  let imagesSaved = 0;
  const host = {
    tools: { register(tool) { tools.set(tool.name, tool); }, get(name) { return tools.get(name); } },
    attachments: { async saveImage({ data, mediaType, name }) {
      imagesSaved++;
      assert.equal(data.subarray(1, 4).toString(), 'PNG');
      return { attachmentId: randomUUID(), mediaType, name, bytes: data.length, width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
    } },
    get(name) { return name === 'llm' ? { async resolveModelInfo() { return { inputModalities: imageCapable ? ['text', 'image'] : ['text'] }; } } : undefined; },
    effect(setup) { const dispose = setup(); disposers.push(dispose); return dispose; },
  };
  return { host, tools, disposers, imagesSaved: () => imagesSaved };
}

const exec = () => ({
  agent: { id: 'plugin-session', options: { provider: 'test', model: 'test' }, session: { requestHeader: () => undefined } },
  signal: new AbortController().signal,
});

test('Cordis mounts the bundle entry and awaits browser disposal', { timeout: 30000 }, async () => {
  const fixture = await startFixture();
  const registered = registrationHost(false);
  const ctx = new Context();
  ctx.provide('tools', registered.host.tools);
  ctx.provide('attachments', registered.host.attachments);
  const fiber = ctx.plugin(plugin, { headless: true, bridgePort: 0 });
  try {
    await fiber;
    assert.equal(registered.tools.size, 8);
    const result = await registered.tools.get('browser_open').execute({ url: fixture.url }, exec());
    assert.match(result.page.title, /Browser Use/);
    await fiber.dispose();
    await assert.rejects(registered.tools.get('browser_observe').execute({}, exec()), /disposed/);
  } finally {
    await fiber.dispose();
    await ctx.fiber.dispose();
    await fixture.close();
  }
});

for (const imageCapable of [true, false]) {
  test(`DSH definitions return valid canonical JSON and ${imageCapable ? 'durable image attachments' : 'a text-model fallback'}`, { timeout: 30000 }, async () => {
    const fixture = await startFixture();
    const registered = registrationHost(imageCapable);
    const manager = registerBrowserTools(registered.host, Config({ headless: true }));
    try {
      assert.deepEqual([...registered.tools.keys()], ['browser_connect', 'browser_open', 'browser_observe', 'browser_act', 'browser_tabs', 'browser_terminal', 'browser_editor', 'browser_close']);
      const tool = registered.tools.get('browser_open');
      assert.equal(tool.presentCall({ url: fixture.url }).kind, 'execute');
      const args = { url: fixture.url, screenshot: true };
      const value = await tool.execute(args, exec());
      assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value), []);
      assert.deepEqual(JSON.parse(JSON.stringify(value)), value);
      assert.ok(!JSON.stringify(value).includes('base64'));
      const content = tool.output.render(args, value);
      assert.match(content[0].text, /External browser content/);
      if (imageCapable) {
        assert.equal(registered.imagesSaved(), 1);
        assert.equal(content[1].type, 'image');
        assert.equal(content[1].attachment.attachmentId, value.image.attachmentId);
      } else {
        assert.equal(registered.imagesSaved(), 0);
        assert.equal(content.length, 1);
        assert.match(value.notice, /does not declare image/);
      }
      const action = registered.tools.get('browser_act');
      const result = await action.execute({ action: 'fill', selector: '#name', text: 'DSH wrapper' }, exec());
      assert.deepEqual(validateJsonSchemaValue(action.output.schema, result), []);
      assert.equal(result.page.elements.find(el => el.name === '姓名').value, 'DSH wrapper');
      if (imageCapable) {
        const page = manager.sessions.get('plugin-session').session.page;
        await page.evaluate(() => {
          const root = document.createElement('div');
          root.className = 'xterm';
          root.innerHTML = '<textarea class="xterm-helper-textarea"></textarea><div class="xterm-rows"><div>ready</div></div>';
          document.body.prepend(root);
          window.terminalEnters = 0;
          root.querySelector('textarea').addEventListener('keydown', event => {
            if (event.key === 'Enter') { event.preventDefault(); window.terminalEnters++; }
          });
        });
        const originalSave = registered.host.attachments.saveImage;
        registered.host.attachments.saveImage = async () => { throw new Error('simulated attachment failure'); };
        try {
          const terminal = registered.tools.get('browser_terminal');
          const submitted = await terminal.execute({ action: 'press', key: 'Enter', screenshot: true }, exec());
          assert.equal(submitted.page.input.dispatched, true);
          assert.match(submitted.notice, /attachment failed/i);
          assert.deepEqual(validateJsonSchemaValue(terminal.output.schema, submitted), []);
          assert.equal(await page.evaluate(() => window.terminalEnters), 1);
        } finally { registered.host.attachments.saveImage = originalSave; }
      }
      await assert.rejects(tool.execute({ url: fixture.url }, { signal: exec().signal }), /active DSH/);
      await registered.disposers[0]();
      assert.equal(manager.sessions.size, 0);
    } catch (error) {
      if (process.env.DEBUG_BROWSER_TEST) console.error(error);
      throw error;
    } finally {
      await manager.dispose();
      await fixture.close();
    }
  });
}

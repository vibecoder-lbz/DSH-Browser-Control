import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { BrowserManager } from '../src/browser.js';
import { startEditorFixture, sourceYaml } from './editor-fixture.mjs';
let fixture;
before(async () => { fixture = await startEditorFixture(); });
after(async () => { await fixture.close(); });

for (const kind of ['textarea', 'ace', 'monaco', 'codemirror5']) {
  test(`real ${kind}: inspect, preview path-based YAML insertion, apply, verify hierarchy and undo without publishing`, { timeout: 60000 }, async () => {
    const manager = new BrowserManager({ headless: true });
    const run = args => manager.run('edit', 'editor', args);
    try {
      await manager.run('edit', 'open', { url: fixture.url + '/' + kind });
      const page = manager.sessions.get('edit').session.page;
      await page.waitForFunction(() => window.fixtureReady);
      const listed = await run({ action: 'list' });
      assert.equal(listed.editors.length, 1);
      assert.equal(listed.editors[0].kind, kind);
      const editorId = listed.editors[0].editorId;
      const read = await run({ action: 'read', editorId });
      assert.ok(!JSON.stringify(read).includes('fixture-private-value'));
      const preview = await run({ action: 'preview', editorId, expectedRevision: read.editor.revision, operation: 'yaml_set', path: '["env","NEW_OPTION"]', valueJson: '"new-value"' });
      assert.equal(preview.preview.changed, true);
      assert.match(preview.preview.after, /  NEW_OPTION: new-value/);
      assert.ok(!JSON.stringify(preview).includes('fixture-private-value'));
      assert.equal((await run({ action: 'read', editorId })).editor.revision, read.editor.revision);
      const applied = await run({ action: 'apply', editorId, planId: preview.preview.planId });
      assert.equal(applied.edit.verified, true);
      assert.equal(applied.edit.published, false);
      const text = await page.evaluate(kind => kind === 'ace' ? ace.edit('editor').getValue() : kind === 'monaco' ? fixtureEditor.getModel().getValue() : kind === 'codemirror5' ? fixtureEditor.getValue() : document.querySelector('#editor').value, kind);
      const config = parse(text);
      assert.equal(config.env.NEW_OPTION, 'new-value');
      assert.equal(config.server.port, 8080);
      assert.equal(config.NEW_OPTION, undefined);
      assert.match(text, /# preserve comment/);
      assert.equal(await page.evaluate(() => window.publishCount), 0);
      if (kind !== 'textarea') {
        await page.evaluate(kind => kind === 'ace' ? ace.edit('editor').undo() : kind === 'codemirror5' ? fixtureEditor.undo() : fixtureEditor.getModel().undo(), kind);
        const restored = await page.evaluate(kind => kind === 'ace' ? ace.edit('editor').getValue() : kind === 'codemirror5' ? fixtureEditor.getValue() : fixtureEditor.getModel().getValue(), kind);
        assert.equal(restored, sourceYaml);
        const target = kind === 'ace' ? '.ace_text-input' : kind === 'codemirror5' ? '.CodeMirror textarea' : '.monaco-editor textarea';
        await assert.rejects(manager.run('edit', 'act', { action: 'fill', selector: target, text: 'bad: insertion' }), /code editor/);
      }
    } finally { await manager.dispose(); }
  });
}

test('same-text editor document swaps invalidate plans and multiline secret reads are redacted', { timeout: 60000 }, async () => {
  const manager = new BrowserManager({ headless: true });
  const run = args => manager.run('edit', 'editor', args);
  try {
    for (const kind of ['ace', 'monaco', 'codemirror5']) {
      await manager.run('edit', 'open', { url: fixture.url + '/' + kind });
      const page = manager.sessions.get('edit').session.page;
      await page.waitForFunction(() => window.fixtureReady);
      const editorId = (await run({ action: 'list' })).editors[0].editorId;
      const read = await run({ action: 'read', editorId });
      const preview = await run({ action: 'preview', editorId, expectedRevision: read.editor.revision, operation: 'yaml_set', path: '["env","X"]', valueJson: 'true' });
      await page.evaluate(kind => {
        if (kind === 'ace') { const editor = ace.edit('editor'); editor.setSession(ace.createEditSession(editor.getValue(), 'ace/mode/yaml')); }
        else if (kind === 'monaco') fixtureEditor.setModel(monaco.editor.createModel(fixtureEditor.getValue(), 'yaml'));
        else fixtureEditor.swapDoc(new CodeMirror.Doc(fixtureEditor.getValue(), 'yaml'));
      }, kind);
      await assert.rejects(run({ action: 'apply', editorId, planId: preview.preview.planId }), /changed since preview|Editor was detached/);
      const untouched = await page.evaluate(kind => kind === 'ace' ? ace.edit('editor').getValue() : kind === 'monaco' ? fixtureEditor.getModel().getValue() : fixtureEditor.getValue(), kind);
      assert.equal(untouched, sourceYaml);
    }
    await manager.run('edit', 'open', { url: fixture.url + '/textarea' });
    const page = manager.sessions.get('edit').session.page;
    await page.locator('textarea').fill('password: |\n  block-secret-first\n  block-secret-second\npublic: ok\n');
    const editorId = (await run({ action: 'list' })).editors[0].editorId;
    const partial = await run({ action: 'read', editorId, startLine: 2, lineCount: 2 });
    assert.ok(!JSON.stringify(partial).includes('block-secret'));
    assert.match(partial.editor.content, /REDACTED/);
    await page.evaluate(() => { const hidden = document.createElement('textarea'); hidden.style.cssText='opacity:0;width:100px;height:100px'; hidden.id='unknown-editor-proxy'; document.body.prepend(hidden); });
    assert.equal((await run({ action: 'list' })).editors.length, 1);
  } finally { await manager.dispose(); }
});

test('iframe editors, JSON exact replacements and unsupported hidden editors are handled explicitly', { timeout: 30000 }, async () => {
  const manager = new BrowserManager({ headless: true });
  const run = args => manager.run('edit', 'editor', args);
  try {
    await manager.run('edit', 'open', { url: fixture.url + '/iframe' });
    const page = manager.sessions.get('edit').session.page;
    await page.frames()[1].waitForFunction(() => window.fixtureReady);
    const listed = await run({ action: 'list' });
    assert.equal(listed.editors[0].frameIndex, 1);
    const editorId = listed.editors[0].editorId;
    const read = await run({ action: 'read', editorId });
    const preview = await run({ action: 'preview', editorId, expectedRevision: read.editor.revision, operation: 'yaml_set', path: '["server","port"]', valueJson: '9090' });
    await run({ action: 'apply', planId: preview.preview.planId });
    assert.equal(parse(await page.frames()[1].locator('textarea').inputValue()).server.port, 9090);
    await manager.run('edit', 'open', { url: fixture.url + '/textarea' });
    await page.locator('textarea').evaluate(el => { el.value = '{"env":{"MODEL":"old"},"enabled":false}'; el.setAttribute('data-language', 'json'); });
    const jsonEditorId = (await run({ action: 'list' })).editors[0].editorId;
    const jsonRead = await run({ action: 'read', editorId: jsonEditorId });
    assert.equal(jsonRead.editor.format, 'json');
    await assert.rejects(run({ action: 'preview', editorId: jsonEditorId, expectedRevision: jsonRead.editor.revision, operation: 'yaml_set', path: '["NEW"]', valueJson: '"plain"' }), /not valid/);
    const jsonSet = await run({ action: 'preview', editorId: jsonEditorId, expectedRevision: jsonRead.editor.revision, operation: 'json_set', path: '["env","NEW"]', valueJson: '"plain"' });
    await run({ action: 'apply', planId: jsonSet.preview.planId });
    assert.equal(JSON.parse(await page.locator('textarea').inputValue()).env.NEW, 'plain');
    const afterSet = await run({ action: 'read', editorId: jsonEditorId });
    await assert.rejects(run({ action: 'preview', editorId: jsonEditorId, expectedRevision: afterSet.editor.revision, operation: 'replace', oldText: 'false', newText: 'invalid', format: 'json' }), /JSON is invalid|exactly once/);
    const jsonPreview = await run({ action: 'preview', editorId: jsonEditorId, expectedRevision: afterSet.editor.revision, operation: 'replace', oldText: 'false', newText: 'true', format: 'json' });
    await run({ action: 'apply', planId: jsonPreview.preview.planId });
    const finalJson = JSON.parse(await page.locator('textarea').inputValue());
    assert.equal(finalJson.enabled, true);
    assert.equal(finalJson.env.NEW, 'plain');
    await manager.run('edit', 'open', { url: fixture.url + '/unsupported' });
    assert.equal((await run({ action: 'list' })).editors.length, 0);
  } finally { await manager.dispose(); }
});

test('editor rejects stale revisions, invalid YAML, ambiguous editor and modified preview without changing user edits', { timeout: 30000 }, async () => {
  const manager = new BrowserManager({ headless: true });
  const run = args => manager.run('edit', 'editor', args);
  try {
    await manager.run('edit', 'open', { url: fixture.url + '/textarea' });
    const page = manager.sessions.get('edit').session.page;
    await page.waitForFunction(() => window.fixtureReady);
    const editorId = (await run({ action: 'list' })).editors[0].editorId;
    const read = await run({ action: 'read', editorId });
    await assert.rejects(run({ action: 'preview', editorId, expectedRevision: 'old', operation: 'yaml_set', path: '["env","X"]', valueJson: 'true' }), /current expectedRevision/);
    const preview = await run({ action: 'preview', editorId, expectedRevision: read.editor.revision, operation: 'yaml_set', path: '["env","X"]', valueJson: 'true' });
    await page.locator('textarea').fill('manual: edit\n');
    await assert.rejects(run({ action: 'apply', editorId, planId: preview.preview.planId }), /changed since preview/);
    assert.equal(await page.locator('textarea').inputValue(), 'manual: edit\n');
    await page.locator('textarea').fill('broken: [\n');
    const broken = await run({ action: 'read', editorId });
    await assert.rejects(run({ action: 'preview', editorId, expectedRevision: broken.editor.revision, operation: 'yaml_set', path: '["env","X"]', valueJson: 'true' }), /invalid YAML/);
    await manager.run('edit', 'open', { url: fixture.url + '/multiple' });
    await assert.rejects(run({ action: 'read' }), /Found 2 editors/);
  } finally { await manager.dispose(); }
});

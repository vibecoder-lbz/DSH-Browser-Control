import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { planYamlEdit } from '../src/yaml-edit.js';

const set = (text, path, value, extra = {}) => planYamlEdit(text, { action: 'yaml_set', path, value, ...extra });

test('inserts env config with two-space indent while preserving unrelated quotes and comments', () => {
  const text = '# service settings\nservice:\n  name: "existing" # keep this\n  env:\n    LOG_LEVEL: info\n"quoted-key": \'quoted value\' # untouched\n';
  const result = set(text, ['service', 'env', 'FEATURE_ENABLED'], true);
  assert.equal(result.changed, true);
  assert.equal(result.indent, 2);
  assert.match(result.text, /    FEATURE_ENABLED: true/u);
  assert.ok(result.text.includes('  name: "existing" # keep this'));
  assert.ok(result.text.includes('"quoted-key": \'quoted value\' # untouched'));
  assert.equal(parse(result.text).service.env.FEATURE_ENABLED, true);
});

test('retains four-space nested map indentation and safe-looking string types', () => {
  const text = 'app:\n    server:\n        port: 8080\n    label: "yes" # keep quote\n';
  const result = set(text, ['app', 'server', 'port'], 9090);
  assert.equal(result.indent, 4);
  assert.match(result.text, /        port: 9090/u);
  assert.ok(result.text.includes('    label: "yes" # keep quote'));
  assert.equal(parse(result.text).app.server.port, 9090);
});

test('addresses a sequence entry by numeric index without changing a sibling', () => {
  const text = 'containers:\n  - name: api\n    image: "repo/api:v1" # image note\n  - name: worker\n    image: repo/worker:v1\n';
  const result = set(text, ['containers', 0, 'image'], 'repo/api:v2');
  assert.deepEqual(parse(result.text).containers, [
    { name: 'api', image: 'repo/api:v2' }, { name: 'worker', image: 'repo/worker:v1' },
  ]);
  assert.ok(result.text.includes('"repo/api:v2" # image note'));
  assert.ok(result.text.includes('image: repo/worker:v1'));
});

test('preserves CRLF and the lack of final newline', () => {
  const text = '# line endings\r\napp:\r\n  enabled: false';
  const result = set(text, ['app', 'enabled'], true);
  assert.ok(result.text.includes('\r\n'));
  assert.ok(!result.text.replaceAll('\r\n', '').includes('\n'));
  assert.ok(!result.text.endsWith('\n'));
});

test('no-op keeps original bytes including spacing and comments', () => {
  const text = 'app:  {name: "demo", enabled: true} # formatting\n';
  const result = set(text, ['app', 'enabled'], true);
  assert.equal(result.changed, false);
  assert.equal(result.text, text);
});

test('missing parents require explicit opt-in and sequence gaps are rejected', () => {
  const text = 'app:\n  name: demo\n';
  assert.throws(() => set(text, ['app', 'env', 'LOG_LEVEL'], 'debug'), /Parent path/u);
  const result = set(text, ['app', 'env', 'LOG_LEVEL'], 'debug', { createMissing: true });
  assert.equal(parse(result.text).app.env.LOG_LEVEL, 'debug');
  assert.throws(() => set('items: []\n', ['items', 2], 'x'), /sparse/u);
  assert.throws(() => set(text, [], {}), /non-empty path/u);
});

test('invalid docs, duplicate keys, custom tags and merge ambiguity are rejected', () => {
  for (const text of ['app: [broken\n', 'app: 1\napp: 2\n', 'app: !secret hidden\n', 'base: &base {a: 1}\napp: {<<: *base}\n']) {
    assert.throws(() => set(text, ['app'], 'new'));
  }
});

test('multi-line values become literal blocks with exact JSON value', () => {
  const result = set('app:\n  script: old\n', ['app', 'script'], 'first\nsecond\n');
  assert.match(result.text, /script: \|\n/u);
  assert.equal(parse(result.text).app.script, 'first\nsecond\n');
});

test('anchors and unrelated aliases survive edits and __proto__ is an ordinary YAML key', () => {
  const text = 'base: &base\n  url: "http://example.test" # keep\ncopy: *base\napp:\n  __proto__: old\n';
  const result = set(text, ['app', '__proto__'], { safe: true });
  assert.ok(result.text.includes('base: &base'));
  assert.ok(result.text.includes('copy: *base'));
  assert.ok(result.text.includes('url: "http://example.test" # keep'));
  assert.deepEqual(Object.getOwnPropertyDescriptor(parse(result.text).app, '__proto__').value, { safe: true });
  assert.equal({}.safe, undefined);
});

test('deletes targeted keys and list items while absent deletion is a byte-preserving no-op', () => {
  const removed = planYamlEdit('app:\n  name: demo\n  obsolete: yes\n', { action: 'yaml_delete', path: ['app', 'obsolete'] });
  assert.deepEqual(parse(removed.text), { app: { name: 'demo' } });
  const list = planYamlEdit('items: [a, b, c]\n', { action: 'yaml_delete', path: ['items', 1] });
  assert.deepEqual(parse(list.text), { items: ['a', 'c'] });
  const text = 'app: {name: demo} # retained\n';
  assert.equal(planYamlEdit(text, { action: 'yaml_delete', path: ['app', 'missing'] }).text, text);
});

test('anchored scalar edits reject changes propagated outside the requested path', () => {
  const text = 'password: &shared old\nsecondary: *shared\n';
  assert.throws(() => set(text, ['password'], 'new'), /outside the requested path/u);
  assert.equal(set(text, ['password'], 'old').text, text);
});

test('anchored ancestor edits reject alias side effects while unrelated siblings remain editable', () => {
  const text = 'defaults: &d\n  a: 1\nlive: *d\nother:\n  a: 10\n';
  assert.throws(() => set(text, ['defaults', 'a'], 2), /outside the requested path/u);
  assert.throws(() => planYamlEdit(text, { action: 'yaml_delete', path: ['defaults', 'a'] }), /outside the requested path/u);
  const result = set(text, ['other', 'a'], 11);
  assert.deepEqual(parse(result.text), { defaults: { a: 1 }, live: { a: 1 }, other: { a: 11 } });
  assert.ok(result.text.includes('defaults: &d'));
  assert.ok(result.text.includes('live: *d'));
});

test('exact replacements must match once and leave valid YAML', () => {
  const text = 'image: "repo:v1" # keep\r\n';
  const result = planYamlEdit(text, { action: 'replace', oldText: 'repo:v1', newText: 'repo:v2' });
  assert.equal(result.text, 'image: "repo:v2" # keep\r\n');
  const multiline = planYamlEdit('app:\r\n  a: 1\r\n', { action: 'replace', oldText: '  a: 1', newText: '  a: 2\n  b: 3' });
  assert.equal(multiline.text, 'app:\r\n  a: 2\r\n  b: 3\r\n');
  assert.throws(() => planYamlEdit('a: v1\nb: v1\n', { action: 'replace', oldText: 'v1', newText: 'v2' }), /more than once/u);
  assert.throws(() => planYamlEdit(text, { action: 'replace', oldText: 'image:', newText: 'image: [' }), /invalid YAML/u);
});

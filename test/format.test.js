import test from 'node:test';
import assert from 'node:assert/strict';
import { detectFormat, planJsonEdit, planPropertiesEdit } from '../src/format.js';

test('format detection uses content when the editor language is generic or wrong', () => {
  assert.equal(detectFormat('server:\n  port: 8080\n', 'text').format, 'yaml');
  assert.equal(detectFormat('{"env":{"MODEL":"old"}}', 'text').format, 'json');
  assert.equal(detectFormat('{"env":{"MODEL":"old"}}', 'yaml').format, 'json');
  assert.equal(detectFormat('[server]\nport=8080\n', 'text').format, 'properties');
  assert.equal(detectFormat('<?xml version="1.0"?><root/>', 'text').format, 'xml');
  assert.equal(detectFormat('SELECT * FROM users', 'text').format, 'sql');
  assert.equal(detectFormat('const x = 1;', 'text').format, 'javascript');
  assert.equal(detectFormat('just words', 'text').format, 'text');
  assert.deepEqual(detectFormat('a: 1', 'yaml').capabilities, ['yaml_set', 'yaml_delete', 'replace']);
});

test('JSON structural edits preserve indentation and validate the whole document', () => {
  const source = '{\n    "env": {\n        "MODEL": "old"\n    }\n}\n';
  const set = planJsonEdit(source, { action: 'json_set', path: ['env', 'NEW'], value: 'hello' });
  assert.equal(JSON.parse(set.text).env.NEW, 'hello');
  assert.match(set.text, /\n {8}"NEW": "hello"/);
  assert.match(set.text, /"MODEL": "old"/);
  const del = planJsonEdit(set.text, { action: 'json_delete', path: ['env', 'MODEL'] });
  assert.equal(JSON.parse(del.text).env.MODEL, undefined);
  assert.throws(() => planJsonEdit(source, { action: 'json_set', path: ['missing', 'x'], value: 1 }), /createMissing/);
  assert.equal(JSON.parse(planJsonEdit(source, { action: 'json_set', path: ['missing', 'x'], value: 1, createMissing: true }).text).missing.x, 1);
  assert.throws(() => planJsonEdit(source, { action: 'json_set', path: ['env'], value: undefined }), /requires value/);
});

test('properties structural edits insert under the right section and preserve comments', () => {
  const source = '# top\n[server]\nport=8080 # keep\nhost=localhost\n\n[other]\nx=1\n';
  const set = planPropertiesEdit(source, { action: 'properties_set', path: ['server', 'timeout'], value: '30' });
  assert.match(set.text, /\[server\]\nport=8080 # keep\nhost=localhost\ntimeout=30/);
  assert.match(set.text, /# top/);
  const update = planPropertiesEdit(set.text, { action: 'properties_set', path: ['server', 'port'], value: '9090' });
  assert.match(update.text, /port=9090 # keep/);
  assert.throws(() => planPropertiesEdit(source, { action: 'properties_set', path: ['missing', 'k'], value: 'v' }), /createMissing/);
  assert.match(planPropertiesEdit(source, { action: 'properties_set', path: ['missing', 'k'], value: 'v', createMissing: true }).text, /\[missing\]\nk=v/);
  const del = planPropertiesEdit(update.text, { action: 'properties_delete', path: ['server', 'port'] });
  assert.ok(!/port=9090/.test(del.text));
  assert.equal(planPropertiesEdit(source, { action: 'properties_delete', path: ['server', 'absent'] }).changed, false);
});

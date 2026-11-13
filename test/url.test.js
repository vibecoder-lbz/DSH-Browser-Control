import test from 'node:test';
import assert from 'node:assert/strict';
import { publicUrl } from '../src/url.js';

test('JumpServer query and KoKo token-path credentials are absent from public URL metadata', () => {
  const fixtures = [
    'https://jump.example/koko/connect/?token=fixture-secret&context=staging',
    'https://jump.example/koko/token/fixture-secret/?namespace=demo',
    'https://jump.example/koko/#/token/fixture-secret/',
    'https://operator:fixture-secret@jump.example/?access_token=fixture-secret',
  ];
  for (const value of fixtures) {
    assert.ok(!publicUrl(value).includes('fixture-secret'));
    assert.ok(publicUrl(value).includes('redacted'));
  }
  assert.equal(new URL(publicUrl(fixtures[0])).searchParams.get('context'), 'staging');
  assert.equal(new URL(publicUrl(fixtures[1])).searchParams.get('namespace'), 'demo');
});

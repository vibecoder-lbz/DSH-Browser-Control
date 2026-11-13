import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserManager } from '../src/browser.js';
import { startFixture } from '../test/fixture.mjs';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = await startFixture();
const manager = new BrowserManager({ headless: process.env.DEMO_HEADLESS === '1' });
try {
  const first = await manager.run('demo', 'open', { url: fixture.url });
  const name = first.elements.find(el => el.name === '姓名');
  await manager.run('demo', 'act', { action: 'fill', ref: name.ref, text: '浏览器助手' });
  await manager.run('demo', 'act', { action: 'select', selector: '#city', value: 'bj' });
  const result = await manager.run('demo', 'act', { action: 'click', selector: '#submit', screenshot: true });
  const dir = path.join(projectDir, '.artifacts');
  await mkdir(dir, { recursive: true });
  const { screenshot, ...observation } = result;
  await writeFile(path.join(dir, 'demo.png'), Buffer.from(screenshot.data, 'base64'));
  await writeFile(path.join(dir, 'demo.json'), JSON.stringify(observation, null, 2) + '\n');
  console.log(`Demo completed: ${observation.frames[0].text.match(/已提交：[^\n]+/u)?.[0]}`);
  console.log(`Screenshot: ${path.join(dir, 'demo.png')}`);
  console.log(`Observation: ${path.join(dir, 'demo.json')}`);
} finally {
  await manager.dispose();
  await fixture.close();
}

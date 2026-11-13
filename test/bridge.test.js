import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { ChromeBridge, selectTab } from '../src/bridge.js';
import { EXTENSION_ID } from '../chrome-extension/identity.js';

const origin = `chrome-extension://${EXTENSION_ID}`;
const tabs = [
  { id: 1, title: 'JumpServer 运维', url: 'https://bastion.example/luna/?token=secret', active: true, windowId: 1 },
  { id: 2, title: 'Kubernetes dashboard', url: 'https://cluster.example/deployments', active: false, windowId: 1 },
  { id: 3, title: 'Documentation', url: 'https://docs.example/', active: true, windowId: 2 },
];
const hello = socket => socket.send(JSON.stringify({ type: 'hello', version: 2, extensionId: EXTENSION_ID }));

test('tab selection supports empty optional IDs, exact matching and refuses ambiguous fallback', () => {
  assert.equal(selectTab(tabs, { query: '堡垒机', tabId: '' }).tab.id, 1);
  assert.equal(selectTab(tabs, { query: 'cluster.example' }).tab.id, 2);
  assert.equal(selectTab(tabs, { query: 'Kubernetes dashboard' }).tab.id, 2);
  assert.equal(selectTab(tabs, { tabId: 'chrome-3' }).tab.id, 3);
  assert.equal(selectTab(tabs, { query: 'missing' }).matched, false);
  assert.equal(selectTab(tabs, {}).matched, false);
  assert.equal(selectTab([...tabs, { ...tabs[0], id: 4 }], { query: 'JumpServer' }).reason, 'ambiguous-match');
});

test('one global source copy is reused across concurrent requests, owners and bridge restarts', async () => {
  const inventory = [...tabs];
  let copies = 0;
  const bridge = new ChromeBridge();
  bridge.listTabs = async () => [...inventory];
  bridge.command = async method => {
    assert.equal(method, 'tabs.duplicate');
    copies++;
    const copy = { ...tabs[0], id: 11, active: false, controlled: true, sourceTabId: 1 };
    inventory.push(copy);
    return copy;
  };
  const initial = await Promise.all(Array.from({ length: 5 }, () => bridge.controlCopy(tabs[0], 'a')));
  assert.ok(initial.every(tab => tab.id === 11));
  assert.equal(copies, 1);
  bridge.leases.set(11, { owner: 'a' });
  await assert.rejects(bridge.controlCopy(tabs[0], 'b'), /another DSH session/);
  assert.equal(copies, 1);
  bridge.leases.delete(11);
  assert.equal((await bridge.controlCopy(tabs[0], 'b')).id, 11);
  const restarted = new ChromeBridge();
  restarted.listTabs = bridge.listTabs;
  restarted.command = () => { throw new Error('must adopt the existing copy'); };
  assert.equal((await restarted.controlCopy(tabs[0], 'new-owner')).id, 11);
});

test('late attach acknowledgement still releases the controlled copy and never attaches source tabs', { timeout: 10000 }, async () => {
  const bridge = new ChromeBridge({ bridgePort: 0, bridgeCommandTimeoutMs: 100 });
  let socket;
  const received = [];
  let attached = false;
  let attachTask;
  try {
    await bridge.start();
    socket = new WebSocket(`ws://127.0.0.1:${bridge.port}/extension`, { origin });
    await once(socket, 'open');
    const connected = once(bridge, 'connected'); hello(socket); await connected;
    socket.on('message', raw => {
      const message = JSON.parse(raw); received.push(message.method);
      if (message.method === 'debugger.attach') {
        attachTask = new Promise(resolve => setTimeout(() => {
          attached = true;
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: message.id, result: {} }));
          resolve();
        }, 150));
      } else if (message.method === 'debugger.detach') {
        void (async () => { await attachTask; attached = false; socket.send(JSON.stringify({ id: message.id, result: {} })); })();
      }
    });
    await assert.rejects(bridge.transportFor(tabs[0], 'agent'), /controlled copy/);
    assert.deepEqual(received, []);
    const copy = { ...tabs[0], id: 11, controlled: true, sourceTabId: 1 };
    bridge.copyOwners.set(copy.id, 'agent');
    await assert.rejects(bridge.transportFor(copy, 'agent'), /timed out/);
    assert.deepEqual(received, ['debugger.attach', 'debugger.detach']);
    assert.equal(attached, false);
    assert.equal(bridge.leases.size, 0);
  } finally { socket?.terminate(); await bridge.dispose(); }
});

test('tokenless bridge accepts only pinned extension origin and rejects web, foreign and missing origins', { timeout: 15000 }, async () => {
  const bridge = new ChromeBridge({ bridgePort: 0, bridgeCommandTimeoutMs: 1000 });
  let socket;
  try {
    const status = await bridge.start();
    assert.equal(status.connected, false);
    assert.equal(status.tokenRequired, false);
    assert.equal(bridge.token, undefined);
    assert.equal((await fetch(status.setupUrl, { headers: { Origin: 'https://attacker.example' } })).status, 403);
    const setup = await fetch(status.setupUrl);
    assert.equal(setup.headers.get('x-frame-options'), 'DENY');
    assert.ok(!(await setup.text()).includes('readonly'));
    for (const forbiddenOrigin of [undefined, 'https://attacker.example', 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']) {
      const bad = new WebSocket(`ws://127.0.0.1:${bridge.port}/extension`, forbiddenOrigin ? { origin: forbiddenOrigin } : {});
      await assert.rejects(once(bad, 'open'), /403/);
    }
    socket = new WebSocket(`ws://127.0.0.1:${bridge.port}/extension`, { origin });
    await once(socket, 'open');
    const connected = once(bridge, 'connected'); hello(socket); await connected;
    let calls = 0;
    socket.on('message', raw => {
      const message = JSON.parse(raw); calls++;
      if (message.method === 'tabs.list') socket.send(JSON.stringify({ id: message.id, result: { tabs: [...tabs, { id: 8, url: 'chrome://settings' }] } }));
    });
    assert.equal((await bridge.listTabs()).length, 3);
    const pending = bridge.command('test.no-response'); socket.close();
    await assert.rejects(pending, /disconnected/);
    assert.ok(calls <= 2);
  } finally { socket?.terminate(); await bridge.dispose(); }
});

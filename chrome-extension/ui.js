import { DEFAULT_SETTINGS, validateSettings } from './shared.js';

const byId = id => document.getElementById(id);
const form = byId('settingsForm');
const controls = ['connectButton', 'disconnectButton', 'saveButton'].map(byId).filter(Boolean);
let busy = false;
let polling = false;
let lastStatus;

async function call(type, extra = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...extra });
  if (!response?.ok) throw new Error(response?.error?.message || '扩展后台没有响应，请重新加载扩展。');
  return response;
}
function message(text, error = false) {
  byId('message').textContent = text;
  byId('message').classList.toggle('error', error);
}
function renderStatus(status) {
  lastStatus = status;
  const labels = {
    connected: '已自动连接', connecting: '正在连接本机 DSH', retrying: '等待本机 DSH',
    disconnected: '自动连接已暂停', error: '连接需要处理',
  };
  byId('statusText').textContent = labels[status.phase] || '状态未知';
  byId('statusDot').className = `dot ${status.phase}`;
  byId('tabsCount').textContent = String(status.tabsCount ?? 0);
  byId('attachedCount').textContent = String(status.attachedTabIds?.length ?? 0);
  byId('bridgeAddress').textContent = status.bridgeUrl || DEFAULT_SETTINGS.bridgeUrl;
  const details = [];
  if (status.lastError) details.push(status.lastError);
  if (status.phase === 'retrying' && status.nextRetryAt) details.push(`约 ${Math.max(1, Math.ceil((status.nextRetryAt - Date.now()) / 1000))} 秒后自动重试。`);
  byId('statusDetail').textContent = details.join(' ');
  if (!busy) {
    byId('disconnectButton').disabled = !status.enabled && !status.connected;
    byId('connectButton').disabled = status.enabled && status.connected;
  }
}
async function action(task) {
  if (busy) return;
  busy = true;
  controls.forEach(button => { button.disabled = true; });
  message('');
  try { await task(); }
  catch (error) { message(error.message || String(error), true); }
  finally {
    busy = false;
    controls.forEach(button => { button.disabled = false; });
    if (lastStatus) renderStatus(lastStatus);
    await refresh();
  }
}
async function refresh() {
  if (polling) return;
  polling = true;
  try { renderStatus((await call('status.get')).status); }
  catch (error) {
    byId('statusText').textContent = '无法读取后台状态';
    byId('statusDot').className = 'dot error';
    byId('statusDetail').textContent = error.message || String(error);
  } finally { polling = false; }
}
byId('connectButton').addEventListener('click', () => {
  void action(async () => {
    renderStatus((await call('connect')).status);
    message('自动连接已启用，本机 DSH 启动后即可使用。');
  });
});
byId('disconnectButton').addEventListener('click', () => {
  void action(async () => {
    renderStatus((await call('disconnect')).status);
    message('已暂停自动连接，控制副本与原网页均保持打开。');
  });
});
form?.addEventListener('submit', event => {
  event.preventDefault();
  void action(async () => {
    const settings = validateSettings({ bridgeUrl: byId('bridgeUrl').value });
    const response = await call('settings.set', { settings });
    renderStatus(response.status);
    message('本地桥地址已保存。');
  });
});
byId('openOptions')?.addEventListener('click', () => { void chrome.runtime.openOptionsPage(); });
try {
  const response = await call('settings.get');
  if (byId('bridgeUrl')) byId('bridgeUrl').value = response.settings.bridgeUrl || DEFAULT_SETTINGS.bridgeUrl;
  await refresh();
} catch (error) { message(error.message || String(error), true); }
setInterval(() => { void refresh(); }, 1500);

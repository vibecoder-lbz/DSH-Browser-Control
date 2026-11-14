export const SETTINGS_KEY = 'dshBridgeSettings';
export const CONTROLLED_KEY = 'dshControlledTabs';
export const CONTROLLED_LOCAL_KEY = 'dshControlledTabsRecoveryV3';
export const COPY_ID_ATTRIBUTE = 'data-dsh-copy-id';
export const DEFAULT_SETTINGS = Object.freeze({
  bridgeUrl: 'ws://127.0.0.1:19876/extension',
  enabled: true,
});

export function validateSettings(value = DEFAULT_SETTINGS) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('本地桥配置格式无效。');
  let url;
  try { url = new URL(String(value.bridgeUrl || DEFAULT_SETTINGS.bridgeUrl).trim()); }
  catch { throw new Error('本地桥地址格式无效。示例：ws://127.0.0.1:19876/extension'); }
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.search || url.hash) {
    throw new Error('只允许 ws://127.0.0.1:<端口>/extension 的本机地址。');
  }
  if (url.pathname !== '/extension') throw new Error('本地桥地址路径必须是 /extension。');
  // Old pairing tokens deliberately do not survive migration or enter protocol v2 URLs.
  return { bridgeUrl: url.href };
}

export function isAllowedUrl(value) {
  if (value === 'about:blank') return true;
  try { return ['http:', 'https:'].includes(new URL(value).protocol); }
  catch { return false; }
}

export function isAllowedTab(tab) {
  return Number.isInteger(tab?.id) && isAllowedUrl(tab.pendingUrl || tab.url || '');
}

export function tabMetadata(tab, record) {
  return {
    id: tab.id,
    title: tab.title || '',
    url: tab.pendingUrl || tab.url || '',
    active: Boolean(tab.active),
    windowId: tab.windowId,
    controlled: Boolean(record),
    sourceTabId: record?.sourceTabId ?? null,
  };
}

export function requireTabId(params) {
  if (!Number.isInteger(params?.tabId) || params.tabId < 0) throw new Error('tabId 必须是有效的 Chrome 标签页 ID。');
  return params.tabId;
}

export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || '未知错误');
}

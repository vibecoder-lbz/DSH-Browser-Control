// Runs in the extension's isolated world. Keep this function self-contained for executeScript.
export function setPageControlMarker(enabled) {
  const key = '__dshControlledPageMarker_v2';
  const prefix = '【被接管】';
  // document.title normalizes ASCII whitespace. Compare the same normalized value
  // that its getter returns, including when the application has no title yet.
  const normalize = value => String(value ?? '').replace(/[\t\n\f\r ]+/gu, ' ').trim();
  const withoutPrefix = value => normalize(value).replace(/^(?:【被接管】\s*)+/u, '');
  const previous = globalThis[key];
  if (!enabled) {
    previous?.dispose();
    for (const host of document.querySelectorAll('[data-dsh-controlled]')) host.remove();
    const current = normalize(document.title);
    const restored = withoutPrefix(current);
    if (current !== restored) document.title = restored;
    delete globalThis[key];
    return;
  }
  if (previous?.version === 3) { previous.refresh(); return; }
  previous?.dispose();
  for (const host of document.querySelectorAll('[data-dsh-controlled]')) host.remove();
  let disposed = false;
  let baseTitle = withoutPrefix(document.title);
  const host = document.createElement('div');
  host.setAttribute('data-dsh-controlled', '');
  host.style.cssText = 'all:initial!important;position:fixed!important;right:12px!important;top:12px!important;z-index:2147483647!important;pointer-events:none!important;';
  const shadow = host.attachShadow({ mode: 'closed' });
  const badge = document.createElement('span');
  badge.textContent = '[DSH 被接管]';
  badge.style.cssText = 'display:block;background:#073943;color:#baf6ff;border:1px solid #36cce4;border-radius:7px;padding:5px 9px;font:12px/1.5 system-ui,sans-serif;box-shadow:0 2px 8px #0003;';
  shadow.append(badge);

  function refresh() {
    if (disposed) return;
    if (!host.isConnected && document.documentElement) document.documentElement.append(host);
    const current = normalize(document.title);
    const unmarked = withoutPrefix(current);
    if (!current.startsWith(prefix) || unmarked !== baseTitle) baseTitle = unmarked;
    // Never append a space to an empty title: the browser trims it, causing an observer loop.
    const desired = baseTitle ? `${prefix} ${baseTitle}` : prefix;
    if (current !== desired) document.title = desired;
  }

  const observer = new MutationObserver(records => {
    // Ignore ordinary terminal/SPA body mutations. Refresh only when the title or
    // our badge changes, or a root/head replacement may have removed either one.
    if (!host.isConnected || records.some(record => {
      const element = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement;
      if (element?.closest?.('title')) return true;
      if (record.target === document || element === document.documentElement || element === document.head) {
        return [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === Node.ELEMENT_NODE &&
          (['HTML', 'HEAD', 'TITLE'].includes(node.tagName) || node.querySelector?.('title')));
      }
      return false;
    })) refresh();
  });
  observer.observe(document.documentElement || document, { childList: true, subtree: true, characterData: true });
  globalThis[key] = {
    version: 3,
    refresh,
    dispose() {
      disposed = true;
      observer.disconnect();
      host.remove();
      const current = normalize(document.title);
      const restored = withoutPrefix(current);
      if (current !== restored) document.title = restored;
    },
  };
  refresh();
}

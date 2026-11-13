import { publicUrl } from './url.js';

// This function runs inside the web page. It never executes page-provided code.
function collectDOM({ maxElements, maxTextChars }) {
  const selector = 'a[href],button,input:not([type="hidden"]),textarea,select,summary,[role="button"],[role="link"],[role="textbox"],[role="checkbox"],[role="radio"],[role="combobox"],[role="menuitem"],[role="tab"],[tabindex],[contenteditable="true"]';
  const nodes = [];
  let visited = 0;
  function visit(root) {
    for (const el of root.querySelectorAll('*')) {
      if (++visited > 15000) break;
      if (el.matches(selector)) nodes.push(el);
      if (el.shadowRoot) visit(el.shadowRoot);
    }
  }
  visit(document);
  const visible = nodes.filter(el => {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return box.width > 0 && box.height > 0 && box.bottom > 0 && box.right > 0 &&
      box.top < innerHeight && box.left < innerWidth && style.visibility !== 'hidden' && style.display !== 'none';
  });
  const elements = visible.slice(0, maxElements);
  const clean = (value, max = 180) => String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, max);
  const items = elements.map(el => {
    const labelledBy = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/u)
      .map(id => el.getRootNode().getElementById?.(id)?.textContent ?? '').join(' ');
    const label = el.getAttribute('aria-label') || labelledBy.trim() ||
      Array.from(el.labels ?? []).map(label => label.textContent).join(' ') ||
      el.getAttribute('alt') || el.getAttribute('placeholder') || el.innerText || el.getAttribute('title') || '';
    const item = {
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || el.getAttribute('type') || el.tagName.toLowerCase(),
      name: clean(label),
      disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
    };
    if (el.type === 'password') item.value = '[password hidden]';
    else if ('value' in el) item.value = clean(el.value);
    if ('checked' in el) item.checked = Boolean(el.checked);
    if (el.tagName === 'SELECT') {
      item.options = Array.from(el.options).slice(0, 30).map(opt => ({ value: opt.value, label: clean(opt.textContent), selected: opt.selected }));
    }
    if (el.tagName === 'A') item.href = clean(el.href, 400);
    return item;
  });
  return {
    elements,
    items,
    text: (document.body?.innerText ?? '').slice(0, maxTextChars),
    textTruncated: (document.body?.innerText?.length ?? 0) > maxTextChars,
    totalElements: visible.length,
  };
}

/** A snapshot owns real ElementHandles, so stale references never retarget another element. */
export class SnapshotStore {
  constructor({ maxElements = 100, maxTextChars = 12000 } = {}) {
    this.maxElements = maxElements;
    this.maxTextChars = maxTextChars;
    this.version = 0;
    this.refs = new Map();
  }

  async clear() {
    const previous = [...this.refs.values()];
    this.refs.clear();
    await Promise.allSettled(previous.map(({ handle }) => handle.dispose()));
  }

  async capture(page) {
    await this.clear();
    const version = ++this.version;
    const frames = [];
    const elements = [];
    let textBudget = this.maxTextChars;
    let truncated = false;
    for (const frame of page.frames()) {
      if (textBudget <= 0 || elements.length >= this.maxElements) {
        truncated = true;
        break;
      }
      const temporary = new Set();
      try {
        const snapshot = await frame.evaluateHandle(collectDOM, {
          maxElements: this.maxElements - elements.length,
          maxTextChars: textBudget,
        });
        temporary.add(snapshot);
        const itemsHandle = await snapshot.getProperty('items');
        temporary.add(itemsHandle);
        const listHandle = await snapshot.getProperty('elements');
        temporary.add(listHandle);
        const properties = await listHandle.getProperties();
        for (const property of properties.values()) temporary.add(property);
        const [items, frameData] = await Promise.all([
          itemsHandle.jsonValue(),
          snapshot.evaluate(data => ({ text: data.text, totalElements: data.totalElements, textTruncated: data.textTruncated })),
        ]);
        textBudget -= frameData.text.length;
        truncated ||= frameData.textTruncated || frameData.totalElements > items.length;
        const frameIndex = frames.length;
        frames.push({ index: frameIndex, url: publicUrl(frame.url()), text: frameData.text });
        for (const [key, property] of properties) {
          const handle = property.asElement();
          const item = items[Number(key)];
          if (!handle || !item) continue;
          const box = await handle.boundingBox();
          const viewport = page.viewportSize();
          if (!box || (viewport && (box.x + box.width <= 0 || box.y + box.height <= 0 || box.x >= viewport.width || box.y >= viewport.height))) {
            continue;
          }
          if (item.href) item.href = publicUrl(item.href);
          const ref = `s${version}e${elements.length + 1}`;
          this.refs.set(ref, { handle, page });
          temporary.delete(handle);
          elements.push({ ref, frame: frameIndex, ...item, box: {
            x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height),
          } });
        }
      } catch (error) {
        // An inaccessible or navigated subframe must not hide the main page.
        if (frame === page.mainFrame()) throw error;
        frames.push({ index: frames.length, url: publicUrl(frame.url()), error: 'Frame changed while observing; observe again.' });
      } finally {
        await Promise.allSettled([...temporary].map(handle => handle.dispose()));
      }
    }
    return { version, frames, elements, truncated };
  }

  resolve(ref, page) {
    const entry = this.refs.get(ref);
    if (!entry || entry.page !== page) throw new Error(`Stale or unknown element reference ${ref}. Call browser_observe and use its latest references.`);
    return entry.handle;
  }
}

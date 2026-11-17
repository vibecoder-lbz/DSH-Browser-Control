// The pointer overlay is a visual aid, not an input mechanism. It runs inside
// the page so it appears in screenshots and in the live dedicated browser. The
// artwork is the pale-blue mouse pointer used by the report generator.
// Failures are deliberately ignored: a frozen page must not turn a successful
// click into a failed browser action.
export async function showPointer(page, options) {
  let timer;
  try {
    await Promise.race([
      page.evaluate(({ x, y, action, toX, toY }) => {
        const KEY = '__dshPointerOverlay_v3';
        const NS = 'http://www.w3.org/2000/svg';
        const root = document.documentElement;
        if (!root || !Number.isFinite(x) || !Number.isFinite(y)) return;
        let state = globalThis[KEY];
        if (!state || !state.host.isConnected) {
          // Remove overlays created by earlier versions before installing v3.
          for (const old of document.querySelectorAll('[data-dsh-cursor]')) old.remove();
          const host = document.createElement('div');
          host.setAttribute('data-dsh-cursor', '');
          host.dataset.cursorIcon = 'mouse';
          host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;display:block!important;overflow:hidden!important;pointer-events:none!important;z-index:2147483647!important;';
          const shadow = host.attachShadow({ mode: 'closed' });
          const cursor = document.createElement('div');
          cursor.style.cssText = 'position:fixed!important;left:0!important;top:0!important;width:64px!important;height:64px!important;transform-origin:23px 19.5px!important;opacity:0!important;pointer-events:none!important;will-change:transform,opacity!important;filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))!important;';
          const svg = document.createElementNS(NS, 'svg');
          svg.setAttribute('viewBox', '0 0 64 64');
          svg.setAttribute('width', '64');
          svg.setAttribute('height', '64');
          const defs = document.createElementNS(NS, 'defs');
          const gradient = document.createElementNS(NS, 'radialGradient');
          gradient.setAttribute('id', 'dsh-cursor-glow');
          gradient.setAttribute('cx', '46%');
          gradient.setAttribute('cy', '51%');
          gradient.setAttribute('r', '50%');
          for (const [offset, color, opacity] of [
            ['0', '#72b7ff', '.67'],
            ['.48', '#81c2ff', '.37'],
            ['1', '#a7d5ff', '0'],
          ]) {
            const stop = document.createElementNS(NS, 'stop');
            stop.setAttribute('offset', offset);
            stop.setAttribute('stop-color', color);
            stop.setAttribute('stop-opacity', opacity);
            gradient.append(stop);
          }
          defs.append(gradient);
          const glow = document.createElementNS(NS, 'ellipse');
          glow.setAttribute('cx', '32');
          glow.setAttribute('cy', '32');
          glow.setAttribute('rx', '27');
          glow.setAttribute('ry', '26');
          glow.setAttribute('fill', 'url(#dsh-cursor-glow)');
          const arrow = document.createElementNS(NS, 'path');
          arrow.setAttribute('d', 'M23 19.5Q21.2 18.8 21.9 20.7L28.9 39.1Q29.5 40.7 30.5 39.2L34.3 32.3L42 29.9Q43.5 29.4 42.1 28.4Z');
          arrow.setAttribute('fill', '#101416');
          arrow.setAttribute('stroke', '#fff');
          arrow.setAttribute('stroke-width', '1.2');
          arrow.setAttribute('stroke-linejoin', 'round');
          svg.append(defs, glow, arrow);
          cursor.append(svg);
          const ring = document.createElement('div');
          ring.style.cssText = 'position:fixed!important;left:0!important;top:0!important;width:30px!important;height:30px!important;border:1.5px solid rgba(199,230,255,.92)!important;border-radius:50%!important;box-shadow:0 0 10px rgba(114,183,255,.55),inset 0 0 7px rgba(114,183,255,.35)!important;opacity:0!important;pointer-events:none!important;will-change:transform,opacity!important;';
          const trail = document.createElement('div');
          trail.style.cssText = 'position:fixed!important;left:0!important;top:0!important;height:2px!important;border-radius:2px!important;background:linear-gradient(90deg,rgba(114,183,255,0),rgba(199,230,255,.9))!important;box-shadow:0 0 7px rgba(114,183,255,.65)!important;transform-origin:0 50%!important;opacity:0!important;pointer-events:none!important;will-change:transform,opacity!important;';
          shadow.append(trail, ring, cursor);
          root.append(host);
          state = { host, cursor, ring, trail, x: null, y: null, timer: 0, animations: [] };
          globalThis[KEY] = state;
        }
        const { cursor, ring, trail } = state;
        const clamp = (value, max) => Math.max(1, Math.min(max - 1, Number(value)));
        const px = clamp(x, innerWidth);
        const py = clamp(y, innerHeight);
        const previousX = state.x ?? px - 10;
        const previousY = state.y ?? py - 8;
        state.x = px;
        state.y = py;
        for (const animation of state.animations.splice(0)) animation.cancel();
        clearTimeout(state.timer);
        state.host.dataset.cursorAction = action;
        state.host.dataset.cursorX = String(px);
        state.host.dataset.cursorY = String(py);
        state.host.dataset.cursorVisible = 'true';
        // The arrow tip is at (23, 19.5) in the 64x64 artwork, so the visible
        // pointer points at the exact viewport coordinate supplied by the tool.
        const end = `translate3d(${px - 23}px,${py - 19.5}px,0)`;
        const start = `translate3d(${previousX - 23}px,${previousY - 19.5}px,0)`;
        cursor.style.transform = end;
        cursor.style.opacity = '1';
        ring.style.opacity = '0';
        trail.style.opacity = '0';
        // Jump to the target synchronously so screenshots taken right after the
        // action still show the exact click point in a background tab.
        const fade = () => {
          for (const element of [cursor, ring, trail]) element.style.opacity = '0';
          state.host.dataset.cursorVisible = 'false';
        };
        state.animations.push(cursor.animate([
          { transform: start, opacity: 0.35 },
          { transform: end, opacity: 1 },
        ], { duration: 170, easing: 'cubic-bezier(.2,.8,.2,1)' }));
        const ripple = delay => {
          ring.style.transform = `translate3d(${px - 15}px,${py - 15}px,0) scale(.18)`;
          ring.style.opacity = '.92';
          const animation = ring.animate([
            { transform: `translate3d(${px - 15}px,${py - 15}px,0) scale(.18)`, opacity: .92 },
            { transform: `translate3d(${px - 15}px,${py - 15}px,0) scale(2.15)`, opacity: 0 },
          ], { duration: 620, delay, easing: 'cubic-bezier(.12,.72,.2,1)', fill: 'forwards' });
          state.animations.push(animation);
        };
        if (action === 'drag' && Number.isFinite(toX) && Number.isFinite(toY)) {
          const endX = clamp(toX, innerWidth);
          const endY = clamp(toY, innerHeight);
          const distance = Math.hypot(endX - px, endY - py);
          const angle = Math.atan2(endY - py, endX - px);
          trail.style.width = `${distance}px`;
          trail.style.transform = `translate3d(${px}px,${py - 1}px,0) rotate(${angle}rad)`;
          trail.style.opacity = '.8';
          state.animations.push(trail.animate([
            { opacity: .8 },
            { opacity: 0 },
          ], { duration: 720, easing: 'ease-out', fill: 'forwards' }));
          cursor.style.transform = `translate3d(${endX - 23}px,${endY - 19.5}px,0)`;
          state.animations.push(cursor.animate([
            { transform: end },
            { transform: `translate3d(${endX - 23}px,${endY - 19.5}px,0)` },
          ], { duration: 420, easing: 'cubic-bezier(.2,.7,.2,1)' }));
          ripple(0);
        } else if (action === 'click' || action === 'double_click') {
          ripple(0);
          if (action === 'double_click') ripple(130);
          state.animations.push(cursor.animate([
            { transform: `${end} scale(1)` },
            { transform: `${end} scale(.9)`, offset: .35 },
            { transform: `${end} scale(1)` },
          ], { duration: 220, easing: 'ease-out' }));
        }
        state.timer = setTimeout(fade, action === 'hover' ? 1100 : 1700);
      }, options),
      new Promise(resolve => { timer = setTimeout(resolve, 300); }),
    ]);
  } catch {
    // Visual feedback is best effort and must never mask an action result.
  } finally {
    clearTimeout(timer);
  }
}

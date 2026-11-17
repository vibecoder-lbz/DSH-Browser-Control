// The pointer overlay is a visual aid, not an input mechanism. It runs inside
// the page so it appears in screenshots and in the live dedicated browser. The
// whale artwork is the same 32x32 silhouette used by the desktop takeover.

/**
 * Draw the whale pointer at viewport coordinates. Failures are deliberately
 * ignored: a page with a frozen renderer must not turn a successful click into
 * a failed browser action.
 */
export async function showPointer(page, options) {
  let timer;
  try {
    await Promise.race([
      page.evaluate(({ x, y, action, toX, toY }) => {
      const KEY = '__dshPointerOverlay_v2';
      const root = document.documentElement;
      if (!root || !Number.isFinite(x) || !Number.isFinite(y)) return;
      let state = globalThis[KEY];
      if (!state || !state.host.isConnected) {
        const host = document.createElement('div');
        host.setAttribute('data-dsh-cursor', '');
        host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;display:block!important;overflow:hidden!important;pointer-events:none!important;z-index:2147483647!important;';
        const shadow = host.attachShadow({ mode: 'closed' });
        const cursor = document.createElement('div');
        cursor.style.cssText = 'position:fixed!important;left:0!important;top:0!important;width:44px!important;height:44px!important;transform-origin:0 19px!important;opacity:0!important;pointer-events:none!important;will-change:transform,opacity!important;filter:drop-shadow(0 0 2px rgba(76,111,255,.9)) drop-shadow(0 0 10px rgba(76,111,255,.55))!important;';
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 32 32');
        svg.setAttribute('width', '44');
        svg.setAttribute('height', '44');
        svg.setAttribute('shape-rendering', 'crispEdges');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M15 5h2v1h-2zM22 5h1v1h-1zM7 6h10v1h-10zM22 6h2v1h-2zM5 7h11v1h-11zM22 7h3v1h-3zM31 7h1v1h-1zM3 8h14v1h-14zM22 8h4v1h-4zM27 8h5v1h-5zM3 9h15v1h-15zM22 9h10v1h-10zM2 10h17v1h-17zM22 10h9v1h-9zM1 11h19v1h-19zM23 11h8v1h-8zM1 12h20v1h-20zM24 12h5v1h-5zM1 13h2v1h-2zM6 13h17v1h-17zM24 13h3v1h-3zM0 14h3v1h-3zM9 14h8v1h-8zM19 14h8v1h-8zM0 15h3v1h-3zM11 15h7v1h-7zM20 15h7v1h-7zM0 16h3v1h-3zM12 16h5v1h-5zM18 16h1v1h-1zM21 16h6v1h-6zM1 17h2v1h-2zM13 17h6v1h-6zM21 17h5v1h-5zM1 18h2v1h-2zM14 18h6v1h-6zM21 18h5v1h-5zM1 19h3v1h-3zM15 19h11v1h-11zM1 20h3v1h-3zM15 20h10v1h-10zM2 21h3v1h-3zM16 21h8v1h-8zM2 22h4v1h-4zM11 22h2v1h-2zM17 22h7v1h-7zM3 23h4v1h-4zM11 23h3v1h-3zM17 23h6v1h-6zM4 24h5v1h-5zM11 24h4v1h-4zM18 24h7v1h-7zM5 25h12v1h-12zM20 25h6v1h-6zM7 26h12v1h-12zM8 27h10v1h-10z');
        path.setAttribute('fill', '#4C6FFF');
        svg.append(path);
        cursor.append(svg);
        const dot = document.createElement('div');
        dot.style.cssText = 'position:fixed!important;left:0!important;top:0!important;width:4px!important;height:4px!important;border-radius:50%!important;background:#e8f8ff!important;box-shadow:0 0 4px #4C6FFF,0 0 10px rgba(76,111,255,.85)!important;opacity:0!important;pointer-events:none!important;will-change:transform,opacity!important;';
        const ring = document.createElement('div');
        ring.style.cssText = 'position:fixed!important;left:0!important;top:0!important;width:32px!important;height:32px!important;border:2px solid rgba(145,216,255,.95)!important;border-radius:50%!important;box-shadow:0 0 12px rgba(76,111,255,.75),inset 0 0 8px rgba(76,111,255,.45)!important;opacity:0!important;pointer-events:none!important;will-change:transform,opacity!important;';
        const trail = document.createElement('div');
        trail.style.cssText = 'position:fixed!important;left:0!important;top:0!important;height:2px!important;border-radius:2px!important;background:linear-gradient(90deg,rgba(76,111,255,0),rgba(124,199,255,.95))!important;box-shadow:0 0 7px rgba(76,111,255,.8)!important;transform-origin:0 50%!important;opacity:0!important;pointer-events:none!important;will-change:transform,opacity!important;';
        shadow.append(trail, ring, cursor, dot);
        root.append(host);
        state = { host, cursor, dot, ring, trail, x: null, y: null, timer: 0, animations: [] };
        globalThis[KEY] = state;
      }
      const { cursor, dot, ring, trail } = state;
      const clamp = (value, max) => Math.max(1, Math.min(max - 1, Number(value)));
      const px = clamp(x, innerWidth);
      const py = clamp(y, innerHeight);
      const previousX = state.x ?? px - 14;
      const previousY = state.y ?? py - 12;
      state.x = px;
      state.y = py;
      for (const animation of state.animations.splice(0)) animation.cancel();
      clearTimeout(state.timer);
      state.host.dataset.cursorAction = action;
      state.host.dataset.cursorX = String(px);
      state.host.dataset.cursorY = String(py);
      state.host.dataset.cursorVisible = 'true';
      const end = `translate3d(${px}px,${py - 19}px,0)`;
      const start = `translate3d(${previousX}px,${previousY - 19}px,0)`;
      cursor.style.transform = end;
      cursor.style.opacity = '1';
      dot.style.transform = `translate3d(${px - 2}px,${py - 2}px,0)`;
      dot.style.opacity = '1';
      ring.style.opacity = '0';
      trail.style.opacity = '0';
      // The cursor jumps to the target synchronously so screenshots taken right
      // after the action still show the exact click point in a background tab.
      const fade = () => {
        for (const element of [cursor, dot, ring, trail]) element.style.opacity = '0';
        state.host.dataset.cursorVisible = 'false';
      };
      state.animations.push(cursor.animate([
        { transform: start, opacity: 0.35 },
        { transform: end, opacity: 1 },
      ], { duration: 170, easing: 'cubic-bezier(.2,.8,.2,1)' }));
      const ripple = delay => {
        ring.style.transform = `translate3d(${px - 16}px,${py - 16}px,0) scale(.18)`;
        ring.style.opacity = '.95';
        const animation = ring.animate([
          { transform: `translate3d(${px - 16}px,${py - 16}px,0) scale(.18)`, opacity: .95 },
          { transform: `translate3d(${px - 16}px,${py - 16}px,0) scale(2.25)`, opacity: 0 },
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
        trail.style.opacity = '.85';
        state.animations.push(trail.animate([
          { opacity: .85 },
          { opacity: 0 },
        ], { duration: 720, easing: 'ease-out', fill: 'forwards' }));
        cursor.style.transform = `translate3d(${endX}px,${endY - 19}px,0)`;
        dot.style.transform = `translate3d(${endX - 2}px,${endY - 2}px,0)`;
        state.animations.push(cursor.animate([
          { transform: end },
          { transform: `translate3d(${endX}px,${endY - 19}px,0)` },
        ], { duration: 420, easing: 'cubic-bezier(.2,.7,.2,1)' }));
        ripple(0);
      } else if (action === 'click' || action === 'double_click') {
        ripple(0);
        if (action === 'double_click') ripple(130);
        state.animations.push(cursor.animate([
          { transform: `${end} scale(1)` },
          { transform: `${end} scale(.86)`, offset: .35 },
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

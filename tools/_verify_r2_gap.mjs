import { boot, open, load, scenario } from './harness.mjs';

const W = 1600, H = 900, N = 100;
const h = await boot({ gpu: true, width: W, height: H });
try {
  await open(h.page, h.url, { city: 'la', car: 'supercar' });
  await load(h.page, { city: 'la', car: 'supercar' });
  await scenario(h.page, 'chase');
  await h.page.evaluate(([w, hh]) => window.__GAME.setSize(w, hh), [W, H]);

  const r = await h.page.evaluate(async (n) => {
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const g = window.__GAME.game;
    const out = {};

    async function loop(label, fn) {
      const t = [];
      let last = performance.now();
      for (let i = 0; i < n; i++) {
        await new Promise((res) => requestAnimationFrame(res));
        const now = performance.now();
        if (i > 15) t.push(now - last);
        last = now;
        fn();
      }
      out[label] = +mean(t).toFixed(2);
    }

    // 1. pure rAF, no work at all
    await loop('idle_rAF', () => {});
    // 2. full game frame
    await loop('full_frame', () => { g.update(1 / 60); g.render(1 / 60); });
    // 3. render only
    await loop('render_only', () => { g.render(1 / 60); });
    // 4. hide entire scene, still run composer
    const scene = g.engine.scene;
    scene.visible = false;
    await loop('empty_scene_render', () => { g.render(1 / 60); });
    scene.visible = true;
    // 5. tiny viewport
    window.__GAME.setSize(320, 180);
    await loop('tiny_320x180', () => { g.render(1 / 60); });
    window.__GAME.setSize(1600, 900);
    // 6. raw gl clear straight to the drawing buffer, bypassing everything
    const gl = g.engine.renderer.getContext();
    await loop('raw_gl_clear', () => { gl.clearColor(0.1, 0.1, 0.2, 1); gl.clear(gl.COLOR_BUFFER_BIT); });
    // 7. idle rAF again to confirm stability
    await loop('idle_rAF_2', () => {});

    out.dpr = window.devicePixelRatio;
    out.pixelRatio = g.engine.renderer.getPixelRatio();
    out.drawingBuffer = [gl.drawingBufferWidth, gl.drawingBufferHeight];
    out.hidden = document.hidden;
    out.visibility = document.visibilityState;
    return out;
  }, N);
  console.log(JSON.stringify(r, null, 1));
} finally { await h.close(); }

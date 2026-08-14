#!/usr/bin/env node
/**
 * Private Miami A/B: what do the wet-road layers cost on the real GPU?
 * Same process, same load, alternating blocks so a load spike hits both sides equally.
 */
import { boot, open, load, scenario } from './harness.mjs';

const FRAMES = Number(process.argv[2] || 120);
const CAR = process.argv[3] || 'supercar';

const h = await boot({ gpu: true, width: 1600, height: 900 });
try {
  await open(h.page, h.url, { city: 'miami', car: CAR });
  console.log(await h.page.evaluate(() => {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    const d = gl.getExtension('WEBGL_debug_renderer_info');
    return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  }));
  await load(h.page, { city: 'miami', car: CAR });
  await scenario(h.page, 'chase');
  await h.page.evaluate(() => window.__GAME.setSize(1600, 900));

  const out = await h.page.evaluate(async (n) => {
    const g = window.__GAME.game;
    const wet = [];
    g.city.group.traverse((o) => {
      if (o.isMesh && o.material && (o.material.name === 'mi-streak' || o.material.name === 'mi-sheen')) wet.push(o);
    });
    const run = async (on) => {
      for (const o of wet) o.visible = on;
      const times = [];
      let last = performance.now();
      for (let i = 0; i < n; i++) {
        await new Promise((res) => requestAnimationFrame(res));
        const now = performance.now();
        if (i > 15) times.push(now - last);
        last = now;
        g.update(1 / 60);
        g.render(1 / 60);
      }
      times.sort((a, b) => a - b);
      const mean = times.reduce((a, b) => a + b, 0) / times.length;
      return { mean: +mean.toFixed(2), median: +times[times.length >> 1].toFixed(2), fps: +(1000 / mean).toFixed(1) };
    };
    g.input.setScripted({ throttle: 1, steer: 0.06, nitro: true });
    const a1 = await run(true); const b1 = await run(false);
    const a2 = await run(true); const b2 = await run(false);
    g.input.clearScripted();
    for (const o of wet) o.visible = true;
    return { meshes: wet.length, on: [a1, a2], off: [b1, b2] };
  }, FRAMES);
  console.log(JSON.stringify(out, null, 1));
  const onMed = (out.on[0].median + out.on[1].median) / 2;
  const offMed = (out.off[0].median + out.off[1].median) / 2;
  console.log(`median frame ms  wet ON ${onMed.toFixed(2)}   OFF ${offMed.toFixed(2)}   cost ${(onMed - offMed).toFixed(2)} ms`);
} finally {
  await h.close();
}

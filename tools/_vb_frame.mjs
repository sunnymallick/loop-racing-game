#!/usr/bin/env node
/** Real-GPU frame budget: how much of the frame is game.update() vs game.render()? */
import { boot, open, load, scenario } from './harness.mjs';

const argv = process.argv.slice(2);
const arg = (kk, d) => { const i = argv.indexOf(`--${kk}`); return i === -1 ? d : argv[i + 1]; };
const CITIES = String(arg('cities', 'la')).split(',');
const h = await boot({ gpu: true, width: 1600, height: 900 });
try {
  await open(h.page, h.url, { city: CITIES[0], car: 'supercar' });
  for (const city of CITIES) {
    await load(h.page, { city, car: 'supercar' });
    await scenario(h.page, 'chase');
    const r = await h.page.evaluate(async () => {
      const g = window.__GAME.game;
      const e = g.engine;
      g.input.setScripted({ throttle: 1, steer: 0.05, nitro: false });
      const t = { frame: [], update: [], render: [], calls: 0, tris: 0 };
      let last = performance.now();
      for (let i = 0; i < 90; i++) {
        await new Promise((r2) => requestAnimationFrame(r2));
        const now = performance.now();
        if (i > 20) t.frame.push(now - last);
        last = now;
        const a = performance.now();
        g.update(1 / 60);
        const b = performance.now();
        g.render(1 / 60);
        const c = performance.now();
        if (i > 20) { t.update.push(b - a); t.render.push(c - b); }
        if (i === 60) { t.calls = e.renderer.info.render.calls; t.tris = e.renderer.info.render.triangles; }
      }
      g.input.clearScripted();
      const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
      return {
        fps: 1000 / mean(t.frame), frame: mean(t.frame), update: mean(t.update), render: mean(t.render),
        calls: t.calls, tris: t.tris,
      };
    });
    console.log(`${city.padEnd(7)} ${r.fps.toFixed(1).padStart(5)} fps · frame ${r.frame.toFixed(1)} ms = update ${r.update.toFixed(1)} + render ${r.render.toFixed(1)} (+ ${(r.frame - r.update - r.render).toFixed(1)} browser/GPU wait) · ${r.calls} calls · ${(r.tris / 1000).toFixed(0)}k tris`);
  }
} finally { await h.close(); }

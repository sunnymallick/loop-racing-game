#!/usr/bin/env node
/** Counts draw calls by wrapping the raw WebGL entry points — independent of renderer.info. */
import { boot, open, load, scenario } from './harness.mjs';
const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf(`--${k}`); return i === -1 ? d : argv[i + 1]; };
const CITIES = String(arg('cities', 'la,vegas,miami,nyc')).split(',');
const W = 1600, H = 900;

const h = await boot({ gpu: true, width: W, height: H });
try {
  await open(h.page, h.url, { city: CITIES[0], car: 'supercar' });
  for (const city of CITIES) {
    await load(h.page, { city, car: 'supercar' });
    await scenario(h.page, 'chase');
    await h.page.evaluate(([w, hh]) => window.__GAME.setSize(w, hh), [W, H]);
    const r = await h.page.evaluate(async () => {
      const g = window.__GAME.game;
      const gl = g.engine.renderer.getContext();
      const names = ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced'];
      const orig = {}; let n = 0;
      for (const k of names) { orig[k] = gl[k].bind(gl); gl[k] = (...a) => { n++; return orig[k](...a); }; }
      const per = [];
      g.input.setScripted({ throttle: 1, steer: 0.06, nitro: true });
      for (let i = 0; i < 40; i++) {
        n = 0;
        await new Promise((res) => requestAnimationFrame(res));
        g.update(1 / 60); g.render(1 / 60);
        if (i > 8) per.push(n);
      }
      g.input.clearScripted();
      for (const k of names) gl[k] = orig[k];
      per.sort((a, b) => a - b);
      return per[Math.floor(per.length / 2)];
    });
    console.log(`${city.padEnd(7)} ${String(r).padStart(6)} raw GL draw calls/frame`);
  }
} finally { await h.close(); }

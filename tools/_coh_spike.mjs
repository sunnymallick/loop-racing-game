/**
 * Which subsystem owns the periodic long frame? Stub one out at a time and count frames over
 * 30 ms over 400 real rAF frames at 1600x900 on the real GPU.
 */
import { boot, open, load, scenario } from './harness.mjs';
const CITY = process.argv[2] || 'la';
const h = await boot({ gpu: true, width: 1600, height: 900 });
try {
  await open(h.page, h.url, { city: CITY, car: 'supercar' });
  for (const mode of ['baseline', 'no-city-update', 'no-effects', 'no-race-visuals',
    'no-hud', 'no-particles', 'no-shadowmap', 'no-envspill']) {
    await load(h.page, { city: CITY, car: 'supercar' });
    await scenario(h.page, 'chase');
    await h.page.evaluate(() => window.__GAME.setSize(1600, 900));
    const r = await h.page.evaluate(async (m) => {
      const g = window.__GAME.game;
      const restore = [];
      const stub = (obj, key) => {
        if (!obj || typeof obj[key] !== 'function') return;
        const old = obj[key]; restore.push(() => { obj[key] = old; });
        obj[key] = () => {};
      };
      if (m === 'no-city-update') stub(g.city, 'update');
      if (m === 'no-effects') stub(g.effects, 'update');
      if (m === 'no-race-visuals') stub(g.race, 'updateVisuals');
      if (m === 'no-hud') stub(g.hud, 'draw');
      if (m === 'no-particles') { stub(g.effects.particles, 'update'); }
      if (m === 'no-shadowmap') {
        const sm = g.engine.renderer.shadowMap;
        const was = sm.autoUpdate; restore.push(() => { sm.autoUpdate = was; });
        sm.autoUpdate = false;
      }
      if (m === 'no-envspill') {
        const sp = g.engine.spill; const was = sp.enabled;
        restore.push(() => { sp.enabled = was; }); sp.enabled = false;
      }
      g.input.setScripted({ throttle: 1, steer: 0.06, nitro: true });
      const t = [];
      let last = performance.now();
      for (let i = 0; i < 400; i++) {
        await new Promise((res) => requestAnimationFrame(res));
        const now = performance.now(); if (i > 30) t.push(now - last); last = now;
        g.update(1 / 60); g.render(1 / 60);
      }
      g.input.clearScripted();
      for (const f of restore) f();
      const s = [...t].sort((a, b) => a - b);
      return {
        fps: +(1000 / (t.reduce((a, b) => a + b, 0) / t.length)).toFixed(1),
        p50: +s[(s.length * 0.5) | 0].toFixed(1),
        p95: +s[(s.length * 0.95) | 0].toFixed(1),
        over30: t.filter((x) => x > 30).length,
      };
    }, mode);
    console.log(`  ${mode.padEnd(16)} ${String(r.fps).padStart(6)} fps  p50 ${String(r.p50).padStart(5)}  p95 ${String(r.p95).padStart(6)}  frames>30ms ${r.over30}`);
  }
} finally { await h.close(); }

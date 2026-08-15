/**
 * CONTROL for the p95/worst-frame numbers perf.mjs reports.
 *
 * Same headed browser, same page, same `await requestAnimationFrame` loop — but the game loop is
 * not run at all. Anything this control shows is the measurement, not the game.
 */
import { boot, open, load, scenario } from './harness.mjs';
const h = await boot({ gpu: true, width: 1600, height: 900 });
try {
  await open(h.page, h.url, { city: 'la', car: 'supercar' });
  await load(h.page, { city: 'la', car: 'supercar' });
  await scenario(h.page, 'chase');
  await h.page.evaluate(() => window.__GAME.setSize(1600, 900));
  for (const mode of ['idle', 'game']) {
    const r = await h.page.evaluate(async (m) => {
      const g = window.__GAME.game;
      if (m === 'game') g.input.setScripted({ throttle: 1, steer: 0.06, nitro: true });
      const t = [];
      let last = performance.now();
      for (let i = 0; i < 400; i++) {
        await new Promise((res) => requestAnimationFrame(res));
        const now = performance.now(); if (i > 20) t.push(now - last); last = now;
        if (m === 'game') { g.update(1 / 60); g.render(1 / 60); }
      }
      g.input.clearScripted();
      const s = [...t].sort((a, b) => a - b);
      return {
        p50: +s[(s.length * 0.5) | 0].toFixed(1),
        p95: +s[(s.length * 0.95) | 0].toFixed(1),
        max: +s[s.length - 1].toFixed(1),
        over30: t.filter((x) => x > 30).length,
        fps: +(1000 / (t.reduce((a, b) => a + b, 0) / t.length)).toFixed(1),
      };
    }, mode);
    console.log(`${mode === 'idle' ? 'rAF only (no game loop)' : 'full game loop      '}  ${JSON.stringify(r)}`);
  }
} finally { await h.close(); }

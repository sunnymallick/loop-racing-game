import { boot, open, load, scenario } from './harness.mjs';

const W = 1600, H = 900, N = 80;
const h = await boot({ gpu: true, width: W, height: H });
try {
  await open(h.page, h.url, { city: 'la', car: 'supercar' });
  await load(h.page, { city: 'la', car: 'supercar' });
  await scenario(h.page, 'chase');
  await h.page.evaluate(([w, hh]) => window.__GAME.setSize(w, hh), [W, H]);
  const r = await h.page.evaluate(async (n) => {
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const g = window.__GAME.game;
    const hud = g.hud;
    const out = {};
    async function loop(label, fn) {
      const t = []; let last = performance.now();
      for (let i = 0; i < n; i++) {
        await new Promise((res) => requestAnimationFrame(res));
        const now = performance.now();
        if (i > 12) t.push(now - last);
        last = now; fn();
      }
      out[label] = +(1000 / mean(t)).toFixed(1);
    }
    g.input.setScripted({ throttle: 1, steer: 0.06, nitro: true });
    const parts = ['_drawChassis', '_drawCityBanner', '_drawClock', '_drawGauge', '_drawDrift', '_drawMessages'];
    await loop('baseline_fps', () => { g.update(1 / 60); g.render(1 / 60); });
    for (const p of parts) {
      const saved = hud[p];
      hud[p] = () => {};
      await loop('without_' + p, () => { g.update(1 / 60); g.render(1 / 60); });
      hud[p] = saved;
    }
    // all parts stubbed => only clear + composite
    const saved = {};
    for (const p of parts) { saved[p] = hud[p]; hud[p] = () => {}; }
    await loop('without_all_parts', () => { g.update(1 / 60); g.render(1 / 60); });
    for (const p of parts) hud[p] = saved[p];
    await loop('restored_fps', () => { g.update(1 / 60); g.render(1 / 60); });
    g.input.clearScripted();
    return out;
  }, N);
  console.log(JSON.stringify(r, null, 1));
} finally { await h.close(); }

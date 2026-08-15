import { boot, open, load, scenario } from './harness.mjs';
const h = await boot({ gpu: true, width: 1600, height: 900 });
try {
  await open(h.page, h.url, { city: 'la', car: 'supercar' });
  for (const city of ['la', 'vegas', 'nyc']) {
    await load(h.page, { city, car: 'supercar' });
    await scenario(h.page, 'chase');
    await h.page.evaluate(() => window.__GAME.setSize(1600, 900));
    const r = await h.page.evaluate(async () => {
      const g = window.__GAME.game;
      const s = g.hudState();
      for (let i = 0; i < 10; i++) g.hud.draw(s, 1 / 60);
      const t = [];
      for (let i = 0; i < 60; i++) {
        await new Promise((res) => requestAnimationFrame(res));
        const t0 = performance.now();
        g.hud.draw(s, 1 / 60);
        t.push(performance.now() - t0);
      }
      t.sort((a, b) => a - b);
      return { p50: +t[30].toFixed(2), p95: +t[57].toFixed(2), max: +t[59].toFixed(2),
        scale: g.hud.scale, dpr: g.hud.dpr,
        buf: g.hud.buf ? [g.hud.buf.width, g.hud.buf.height] : null };
    });
    console.log(city.padEnd(7), JSON.stringify(r));
  }
} finally { await h.close(); }

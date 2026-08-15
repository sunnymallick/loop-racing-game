/**
 * Where do the long frames land? Records per-frame wall time plus a coarse split of update vs
 * render, then prints every frame over a threshold with its index so a periodic job is obvious.
 */
import { boot, open, load, scenario } from './harness.mjs';
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i === -1 ? d : argv[i + 1]; };
const CITIES = String(arg('cities', 'la,vegas,miami,nyc')).split(',');
const FRAMES = Number(arg('frames', 400));

const h = await boot({ gpu: true, width: 1600, height: 900 });
try {
  await open(h.page, h.url, { city: CITIES[0], car: 'supercar' });
  for (const city of CITIES) {
    await load(h.page, { city, car: 'supercar' });
    await scenario(h.page, 'chase');
    await h.page.evaluate(() => window.__GAME.setSize(1600, 900));
    const r = await h.page.evaluate(async (n) => {
      const g = window.__GAME.game;
      g.input.setScripted({ throttle: 1, steer: 0.06, nitro: true });
      const rows = [];
      let last = performance.now();
      for (let i = 0; i < n; i++) {
        await new Promise((res) => requestAnimationFrame(res));
        const now = performance.now();
        const dtWall = now - last; last = now;
        const t0 = performance.now();
        g.update(1 / 60);
        const t1 = performance.now();
        g.render(1 / 60);
        const t2 = performance.now();
        rows.push([i, +dtWall.toFixed(1), +(t1 - t0).toFixed(1), +(t2 - t1).toFixed(1),
          g.engine.renderer.info.programs ? g.engine.renderer.info.programs.length : -1]);
      }
      g.input.clearScripted();
      return rows;
    }, FRAMES);
    const body = r.slice(20);
    const w = body.map((x) => x[1]).sort((a, b) => a - b);
    const p = (q) => w[Math.floor(w.length * q)];
    console.log(`\n== ${city}  mean ${(w.reduce((a, b) => a + b, 0) / w.length).toFixed(1)}ms  p50 ${p(0.5)}  p95 ${p(0.95)}  max ${w[w.length - 1]}`);
    const spikes = r.filter((x) => x[1] > 30);
    console.log(`   frames >30ms: ${spikes.length}/${r.length}`);
    console.log('   idx/wall/upd/rend/programs:',
      spikes.slice(0, 24).map((x) => `${x[0]}:${x[1]}(u${x[2]} r${x[3]} p${x[4]})`).join(' '));
  }
} finally { await h.close(); }

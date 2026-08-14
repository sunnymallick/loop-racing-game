// A/B the cost of the RACE piece's start/finish line + gantry on the real GPU.
import { boot, open, load, scenario } from './harness.mjs';
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i === -1 ? d : argv[i + 1]; };
const CITY = String(arg('city', 'miami'));
const FRAMES = Number(arg('frames', 160));
const h = await boot({ gpu: true, width: 1600, height: 900 });
try {
  await open(h.page, h.url, { city: CITY, car: 'supercar' });
  await load(h.page, { city: CITY, car: 'supercar' });
  await scenario(h.page, 'chase');
  await h.page.evaluate(() => window.__GAME.setSize(1600, 900));
  const run = async (on) => h.page.evaluate(async ([n, vis]) => {
    const g = window.__GAME.game;
    if (g.race?.lineGroup) g.race.lineGroup.visible = vis;
    const info = g.engine.renderer.info;
    const realReset = info.reset.bind(info);
    let calls = 0, k = 0;
    info.reset = () => { calls += info.render.calls; k++; realReset(); };
    for (let i = 0; i < 20; i++) { g.update(1 / 60); g.render(1 / 60); await new Promise((r) => requestAnimationFrame(r)); }
    const t0 = performance.now();
    for (let i = 0; i < n; i++) { g.update(1 / 60); g.render(1 / 60); await new Promise((r) => requestAnimationFrame(r)); }
    const ms = performance.now() - t0;
    info.reset = realReset;
    return { fps: (n / ms) * 1000, calls: calls / Math.max(1, k) };
  }, [FRAMES, on]);
  const withLine = await run(true);
  const without = await run(false);
  const again = await run(true);
  console.log(`${CITY}: with=${withLine.fps.toFixed(1)}fps/${withLine.calls.toFixed(0)}calls  without=${without.fps.toFixed(1)}fps/${without.calls.toFixed(0)}calls  with2=${again.fps.toFixed(1)}fps`);
} finally { await h.close(); }

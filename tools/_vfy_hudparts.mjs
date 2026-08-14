import { boot, open } from './harness.mjs';
const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf(`--${k}`); return i === -1 ? d : argv[i + 1]; };
const CITY = arg('city', 'la');
const N = Number(arg('frames', 100));
const h = await boot({ gpu: true, width: 1600, height: 900 });
await open(h.page, h.url, { city: CITY, car: 'supercar' });
const r = await h.page.evaluate(async (n) => {
  const g = window.__GAME.game, hud = g.hud;
  const out = {};
  const run = async (label, setup, teardown) => {
    const u = setup ? setup() : null;
    const t = []; let last = performance.now();
    for (let i = 0; i < n; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      const now = performance.now(); if (i > 20) t.push(now - last); last = now;
      g.update(1 / 60); g.render(1 / 60);
    }
    if (teardown) teardown(u);
    const s = t.sort((a, b) => a - b);
    out[label] = 1000 / s[Math.floor(s.length / 2)];
  };
  await run('baseline');
  const parts = ['_drawChassis', '_drawCityBanner', '_drawClock', '_drawGauge', '_drawDrift', '_drawMessages'];
  for (const p of parts) {
    if (typeof hud[p] !== 'function') { out['no ' + p] = -1; continue; }
    const real = hud[p];
    await run('no ' + p, () => { hud[p] = () => { }; }, () => { hud[p] = real; });
  }
  // composite-only: skip all sub-draws, keep clear + downscale composite
  const reals = {}; for (const p of parts) reals[p] = hud[p];
  await run('composite only', () => { for (const p of parts) if (typeof hud[p] === 'function') hud[p] = () => { }; },
    () => { for (const p of parts) hud[p] = reals[p]; });
  return out;
}, N);
const base = r['baseline'];
console.log(`\n── HUD part ablation (${CITY}) ──`);
for (const [k, v] of Object.entries(r)) {
  if (v < 0) { console.log(`  ${k.padEnd(24)} n/a`); continue; }
  console.log(`  ${k.padEnd(24)} ${v.toFixed(1)} fps` + (k === 'baseline' ? '' : `  (${v - base >= 0 ? '+' : ''}${(v - base).toFixed(1)})`));
}
await h.close();

#!/usr/bin/env node
/** Ablates each HUD sub-panel one at a time to find where the vector rasterisation cost lives. */
import { boot, open, load, scenario } from './harness.mjs';

const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf(`--${k}`); return i === -1 ? d : argv[i + 1]; };
const CITY = arg('city', 'vegas');
const FRAMES = Number(arg('frames', 100));
const W = 1600, H = 900;

const PARTS = ['_drawChassis', '_drawCityBanner', '_drawClock', '_drawGauge', '_drawDrift', '_drawMessages', '_drawStartLights'];

async function measure(page, frames, skip) {
  return page.evaluate(async ([n, skip]) => {
    const g = window.__GAME.game;
    const hud = g.hud;
    const saved = {};
    for (const p of skip) { if (hud[p]) { saved[p] = hud[p]; hud[p] = () => {}; } }

    g.input.setScripted({ throttle: 1, steer: 0.06, nitro: true });
    const times = [];
    let last = performance.now();
    for (let i = 0; i < n; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      const now = performance.now();
      if (i > 20) times.push(now - last);
      last = now;
      g.update(1 / 60);
      g.render(1 / 60);
    }
    g.input.clearScripted();
    for (const p of Object.keys(saved)) hud[p] = saved[p];
    times.sort((a, b) => a - b);
    const mean = times.reduce((a, b) => a + b, 0) / times.length;
    return { fps: 1000 / mean, ms: mean };
  }, [frames, skip]);
}

const h = await boot({ gpu: true, width: W, height: H });
try {
  await open(h.page, h.url, { city: CITY, car: 'supercar' });
  await load(h.page, { city: CITY, car: 'supercar' });
  await scenario(h.page, 'chase');
  await h.page.evaluate(([w, hh]) => window.__GAME.setSize(w, hh), [W, H]);
  console.log(`── ${CITY}: cost of each HUD panel (ablated individually) ──`);
  const base = await measure(h.page, FRAMES, []);
  console.log(`  ${'baseline (all panels)'.padEnd(26)} ${base.fps.toFixed(1).padStart(6)} fps ${base.ms.toFixed(1).padStart(7)} ms`);
  const rows = [];
  for (const p of PARTS) {
    const r = await measure(h.page, FRAMES, [p]);
    rows.push([p, base.ms - r.ms, r.fps]);
  }
  rows.sort((a, b) => b[1] - a[1]);
  for (const [p, saved, fps] of rows) {
    console.log(`  skip ${p.padEnd(21)} ${fps.toFixed(1).padStart(6)} fps   saves ${saved.toFixed(1).padStart(6)} ms`);
  }
} finally { await h.close(); }

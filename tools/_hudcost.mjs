#!/usr/bin/env node
/** Splits the HUD's per-frame cost into vector rasterisation vs full-screen layer compositing. */
import { boot, open, load, scenario } from './harness.mjs';

const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf(`--${k}`); return i === -1 ? d : argv[i + 1]; };
const CITIES = String(arg('cities', 'vegas')).split(',');
const FRAMES = Number(arg('frames', 100));
const W = 1600, H = 900;

const MODES = [
  ['full HUD (baseline)', 'full'],
  ['no HUD at all', 'nohud'],
  ['raster only (no composite)', 'nocomposite'],
  ['composite only (no raster)', 'noraster'],
  ['full HUD, canvas hidden', 'hidden'],
  ['full HUD, no supersample', 'noss'],
];

async function measure(page, frames, mode) {
  return page.evaluate(async ([n, mode]) => {
    const g = window.__GAME.game;
    const hud = g.hud;
    const parts = ['_drawChassis', '_drawCityBanner', '_drawClock', '_drawGauge', '_drawDrift', '_drawMessages', '_drawStartLights'];
    const saved = {};
    const realDraw = hud.draw.bind(hud);
    let savedBuf = null, savedBctx = null, savedDisplay = null, realDrawImage = null;

    if (mode === 'nohud') hud.draw = () => {};
    if (mode === 'noraster') for (const p of parts) { if (hud[p]) { saved[p] = hud[p]; hud[p] = () => {}; } }
    if (mode === 'nocomposite' && hud.ctx) { realDrawImage = hud.ctx.drawImage; hud.ctx.drawImage = () => {}; }
    if (mode === 'hidden') { savedDisplay = hud.canvas.style.display; hud.canvas.style.display = 'none'; }
    if (mode === 'noss') { savedBuf = hud.buf; savedBctx = hud.bctx; hud.buf = null; hud.bctx = null; }

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

    hud.draw = realDraw;
    for (const p of Object.keys(saved)) hud[p] = saved[p];
    if (realDrawImage) hud.ctx.drawImage = realDrawImage;
    if (savedDisplay !== null) hud.canvas.style.display = savedDisplay;
    if (mode === 'noss') { hud.buf = savedBuf; hud.bctx = savedBctx; }

    times.sort((a, b) => a - b);
    const mean = times.reduce((a, b) => a + b, 0) / times.length;
    return { fps: 1000 / mean, ms: mean };
  }, [frames, mode]);
}

const h = await boot({ gpu: true, width: W, height: H });
try {
  await open(h.page, h.url, { city: CITIES[0], car: 'supercar' });
  for (const city of CITIES) {
    await load(h.page, { city, car: 'supercar' });
    await scenario(h.page, 'chase');
    await h.page.evaluate(([w, hh]) => window.__GAME.setSize(w, hh), [W, H]);
    console.log(`\n── ${city} ──`);
    let base = null;
    for (const [label, mode] of MODES) {
      const r = await measure(h.page, FRAMES, mode);
      if (base === null) base = r.ms;
      const d = mode === 'full' ? '' : `   saves ${(base - r.ms).toFixed(1)} ms`;
      console.log(`  ${label.padEnd(30)} ${r.fps.toFixed(1).padStart(6)} fps ${r.ms.toFixed(1).padStart(7)} ms${d}`);
    }
  }
} finally { await h.close(); }

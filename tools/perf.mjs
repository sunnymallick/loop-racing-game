#!/usr/bin/env node
/**
 * REAL-GPU frame rate. ART_DIRECTION.md §3.5 requires >= 50 fps at 1600x900, and §7 caps any piece
 * at 70 if the game runs below that. Headless Chromium falls back to SwiftShader (CPU
 * rasterisation) and reports ~1 fps no matter how well-optimised the game is, so that number can
 * only ever be a regression tracker.
 *
 * This launches a HEADED browser, which on macOS gets the real GPU through ANGLE/Metal, and
 * measures sustained frame rate over the actual rAF loop.
 *
 *   node tools/perf.mjs                        # all four cities, supercar
 *   node tools/perf.mjs --cities vegas --car muscle --frames 400
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { boot, open, load, scenario, ROOT } from './harness.mjs';

const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf(`--${k}`); return i === -1 ? d : argv[i + 1]; };

const CITIES = String(arg('cities', 'la,vegas,miami,nyc')).split(',');
const CAR = arg('car', 'supercar');
const FRAMES = Number(arg('frames', 300));
const W = Number(arg('width', 1600));
const H = Number(arg('height', 900));
const BAR = 50;

async function main() {
  const h = await boot({ gpu: true, width: W, height: H });
  const rows = [];
  try {
    await open(h.page, h.url, { city: CITIES[0], car: CAR });

    const gpu = await h.page.evaluate(() => {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2');
      if (!gl) return 'no webgl2';
      const d = gl.getExtension('WEBGL_debug_renderer_info');
      return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    });
    console.log(`GPU: ${gpu}\n`);
    const software = /swiftshader|software|llvmpipe/i.test(gpu);
    if (software) console.log('⚠ Still on a software rasteriser — these numbers are NOT the real-GPU bar.\n');

    for (const city of CITIES) {
      await load(h.page, { city, car: CAR });
      await scenario(h.page, 'chase');
      await h.page.evaluate(([w, hh]) => window.__GAME.setSize(w, hh), [W, H]);

      const r = await h.page.evaluate(async (n) => {
        const g = window.__GAME.game;
        // Engine.render() calls renderer.info.reset() as its last act, so reading info AFTER the
        // loop always returned 0 and the "calls"/"tris" columns were meaningless. Hook reset() and
        // sample the counters the instant before they are cleared: that is the true per-frame cost.
        const info = g.engine.renderer.info;
        const realReset = info.reset.bind(info);
        const callSamples = [], triSamples = [];
        info.reset = () => {
          callSamples.push(info.render.calls);
          triSamples.push(info.render.triangles);
          realReset();
        };
        // free-run the real loop: drive forward under boost, the worst case for fill rate
        g.input.setScripted({ throttle: 1, steer: 0.06, nitro: true });
        const times = [];
        let last = performance.now();
        for (let i = 0; i < n; i++) {
          await new Promise((res) => requestAnimationFrame(res));
          const now = performance.now();
          if (i > 20) times.push(now - last);   // discard warm-up
          last = now;
          g.update(1 / 60);
          g.render(1 / 60);
        }
        g.input.clearScripted();
        info.reset = realReset;
        times.sort((a, b) => a - b);
        const mean = times.reduce((a, b) => a + b, 0) / times.length;
        // median over frames, so a warm-up or shadow-update frame can't skew the reported count
        const median = (a) => {
          if (!a.length) return 0;
          const s = [...a].sort((x, y) => x - y);
          return s[Math.floor(s.length / 2)];
        };
        return {
          meanMs: mean,
          fps: 1000 / mean,
          p95Ms: times[Math.floor(times.length * 0.95)],
          worstFps: 1000 / times[times.length - 1],
          drawCalls: median(callSamples),
          triangles: median(triSamples),
        };
      }, FRAMES);

      rows.push({ city, ...r });
      const ok = r.fps >= BAR;
      console.log(`${ok ? '  ✓' : '  ✗'} ${city.padEnd(6)} ${r.fps.toFixed(1).padStart(6)} fps   p95 ${r.p95Ms.toFixed(1)}ms   worst ${r.worstFps.toFixed(0)} fps   ${r.drawCalls} calls   ${(r.triangles / 1000).toFixed(0)}k tris`);
    }

    const worst = Math.min(...rows.map((r) => r.fps));
    console.log(`\n${'='.repeat(62)}`);
    console.log(worst >= BAR
      ? `PASS — worst city ${worst.toFixed(1)} fps at ${W}x${H} (bar: ${BAR})`
      : `FAIL — worst city ${worst.toFixed(1)} fps at ${W}x${H} (bar: ${BAR})`);
    console.log('='.repeat(62));
    await fs.writeFile(path.join(ROOT, 'shots/perf.json'), JSON.stringify({ gpu, width: W, height: H, bar: BAR, rows }, null, 2));
    process.exitCode = worst >= BAR ? 0 : 1;
  } finally {
    await h.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

#!/usr/bin/env node
/**
 * Private screenshot runner for the NITROUS builder.
 *
 * Identical to tools/shot.mjs except the Vite dev server runs with HMR and file watching OFF —
 * other agents are saving files in the same tree while this runs, and an HMR page reload mid-run
 * destroys the execution context. Not a replacement for tools/shot.mjs; critics use that.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, scenario, load, capture } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d = null) => {
  const i = argv.indexOf(`--${k}`);
  if (i === -1) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

const WIDTH = Number(arg('width', 1600));
const HEIGHT = Number(arg('height', 900));
const OUT = path.resolve(ROOT, arg('out', 'shots/nitro-priv'));
const SHOTS = String(arg('shots', 'nitrous,nitrous-long')).split(',').map((s) => s.trim()).filter(Boolean);
const CITIES = String(arg('cities', arg('city', 'la'))).split(',');
const CARS = String(arg('cars', arg('car', 'muscle'))).split(',');

async function boot() {
  const port = 20000 + Math.floor(Math.random() * 30000);
  const server = await createServer({
    root: ROOT,
    logLevel: 'error',
    server: { port, strictPort: false, host: '127.0.0.1', hmr: false, watch: null },
    optimizeDeps: { include: ['three'] },
  });
  await server.listen();
  const url = server.resolvedUrls.local[0].replace(/\/$/, '');
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
      '--enable-webgl', '--disable-dev-shm-usage', '--force-device-scale-factor=1'],
  });
  const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const logs = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  return { server, browser, page, url, logs, async close() { await browser.close(); await server.close(); } };
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const h = await boot();
  try {
    await open(h.page, h.url, { city: CITIES[0], car: CARS[0] });
    for (const city of CITIES) {
      for (const car of CARS) {
        await load(h.page, { city, car });
        for (const shot of SHOTS) {
          const trace = await scenario(h.page, shot, {});
          if (argv.includes('--inspect')) {
            // park a close rear-three-quarter camera on the car so the jet's own structure can be
            // judged without the chase rig's foreshortening. Diagnostic only.
            await h.page.evaluate(() => {
              const g = window.__GAME.game, b = g.body, cam = g.engine.camera;
              const p = b.pos.clone()
                .addScaledVector(b.forward, -6.0)
                .addScaledVector(b.right, 3.6);
              p.y = b.pos.y + 1.9;
              cam.position.copy(p);
              cam.lookAt(b.pos.x - b.forward.x * 2.2, b.pos.y + 0.7, b.pos.z - b.forward.z * 2.2);
              cam.fov = 48; cam.updateProjectionMatrix();
            });
          }
          const file = path.join(OUT, `${city}-${car}-${shot}.png`);
          await capture(h.page, file, { width: WIDTH, height: HEIGHT });
          const last = trace[trace.length - 1];
          console.log(`  ✓ ${city}-${car}-${shot}  ${last.mph?.toFixed?.(0)} mph  boost=${last.nitro?.ramp}  charge=${last.nitro?.charge}`);
        }
      }
    }
    const errs = await h.page.evaluate(() => window.__ERRORS || []);
    if (errs.length) { console.log('\n⚠ runtime errors:'); for (const e of errs.slice(0, 10)) console.log('   ' + e); }
    const ce = h.logs.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]'));
    if (ce.length) { console.log('\n⚠ console errors:'); for (const e of ce.slice(0, 10)) console.log('   ' + e); }
  } finally {
    await h.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

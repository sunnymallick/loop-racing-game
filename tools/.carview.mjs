#!/usr/bin/env node
// Private inspection tool for the vehicle-art builder: close 3/4 views of each car.
// Not part of the scoring harness. HMR is disabled so concurrent edits by other builders
// don't navigate the page out from under us mid-capture.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf(`--${k}`); if (i === -1) return d; const v = argv[i + 1]; return v && !v.startsWith('--') ? v : true; };
const OUT = path.resolve(ROOT, arg('out', 'shots/carview'));
const CARS = String(arg('cars', 'tuner,muscle,suv,supercar')).split(',');
const CITY = String(arg('city', 'miami'));
const HUD = argv.includes('--hud');
const W = Number(arg('w', 1200)), H = Number(arg('h', 900));

const VIEWS = {
  front34: { az: 0.66, el: 0.22, dist: 1.30, look: 0.42 },
  rear34: { az: 2.52, el: 0.26, dist: 1.35, look: 0.44 },
  side: { az: 1.5708, el: 0.10, dist: 1.55, look: 0.45 },
  wheel: { az: 1.05, el: 0.16, dist: 0.52, look: 0.16 },
};

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const port = 20000 + Math.floor(Math.random() * 30000);
  const server = await createServer({
    root: ROOT, logLevel: 'error',
    server: { port, strictPort: false, host: '127.0.0.1', hmr: false, watch: { ignored: ['**/*'] } },
    optimizeDeps: { include: ['three'] },
  });
  await server.listen();
  const url = server.resolvedUrls.local[0].replace(/\/$/, '');
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--disable-dev-shm-usage', '--force-device-scale-factor=1'],
  });
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const logs = [];
  page.on('console', (m) => { if (m.type() === 'error') logs.push(`[error] ${m.text()}`); });
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

  try {
    await page.goto(`${url}/?shot=1&city=${CITY}&car=${CARS[0]}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction('window.__READY === true || window.__READY === "error"', null, { timeout: 120000 });
    if (await page.evaluate('window.__READY') === 'error') {
      console.error(await page.evaluate('window.__ERRORS'));
      throw new Error('boot failed');
    }
    for (const car of CARS) {
      await page.evaluate((s) => window.__GAME.load(s), { city: CITY, car });
      await page.evaluate(([n, o]) => window.__GAME.scenario(n, o), ['still', { u: 0.05 }]);
      for (const [name, v] of Object.entries(VIEWS)) {
        await page.evaluate(([vv, w, hh, hud]) => {
          const ui = document.getElementById('ui'); if (ui) ui.style.display = hud ? '' : 'none';
          const g = window.__GAME.game;
          const c = g.car;
          const d = c.userData.dims;
          const R = Math.max(d.length, d.width) * vv.dist;
          const cam = g.engine.camera;
          cam.fov = 36;
          const lx = Math.sin(vv.az) * Math.cos(vv.el) * R;
          const ly = Math.sin(vv.el) * R + d.height * 0.30;
          const lz = Math.cos(vv.az) * Math.cos(vv.el) * R;
          const yaw = c.rotation.y;
          const wx = lx * Math.cos(yaw) + lz * Math.sin(yaw);
          const wz = -lx * Math.sin(yaw) + lz * Math.cos(yaw);
          const p = c.position;
          cam.position.set(p.x + wx, p.y + ly, p.z + wz);
          cam.lookAt(p.x, p.y + d.height * vv.look, p.z);
          g.engine.resize(w, hh);
          cam.aspect = w / hh; cam.updateProjectionMatrix();
        }, [v, W, H, HUD]);
        await page.evaluate(() => { window.__GAME.render(); window.__GAME.render(); });
        await page.screenshot({ path: path.join(OUT, `${car}-${name}.png`), type: 'png', timeout: 60000 });
        console.log(`  ✓ ${car}-${name}.png`);
      }
    }
    const errs = await page.evaluate(() => window.__ERRORS || []);
    if (errs.length) { console.log('\n⚠ runtime errors:'); for (const e of errs.slice(0, 8)) console.log('  ' + e); }
    if (logs.length) { console.log('\n⚠ console:'); for (const e of logs.slice(0, 8)) console.log('  ' + e); }
  } finally { await browser.close(); await server.close(); }
}
main().catch((e) => { console.error(e); process.exit(1); });

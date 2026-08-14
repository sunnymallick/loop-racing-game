/** Is the black LA drift frame caused by the FX world-damage system? Shoot it with that disabled. */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import { open } from './harness.mjs';

const ROOT = '/Users/sunnymallick/sunny_personal_projects/gauntlet-test';
const port = 20000 + Math.floor(Math.random() * 30000);
const server = await createServer({
  root: ROOT, logLevel: 'error',
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
const ctx = await browser.newContext({ viewport: { width: 800, height: 450 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await open(page, url, { city: 'la', car: 'muscle' });
const info = await page.evaluate(async () => {
  const G = window.__GAME; const g = G.game;
  G.setSize(800, 450);
  // hard-disable every part of this piece's world damage
  g.effects.world.cands.length = 0;
  g.effects.world.detach = () => null;
  g.effects.world.crush = () => null;
  G.scenario('drift', {});
  const c = g.engine.camera;
  const cam = { p: c.position.toArray().map((v) => +v.toFixed(1)), fov: +c.fov.toFixed(1) };
  const b = g.body;
  return {
    cam, car: [b.pos.x, b.pos.y, b.pos.z].map((v) => +v.toFixed(1)),
    impacts: g.effects.impacts, worldMeshes: g.effects.world.orig.size,
    lateral: +(g.city.track.nearest(b.pos).lateral ?? 0).toFixed(2),
  };
});
console.log(JSON.stringify(info));
await fs.mkdir(`${ROOT}/shots/fx-la-check`, { recursive: true });
await fs.writeFile(`${ROOT}/shots/fx-la-check/la-drift-nofxworld.png`, await page.screenshot({ type: 'png' }));
await browser.close();
await server.close();

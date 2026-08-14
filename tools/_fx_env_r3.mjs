/**
 * FX piece probe (round 3): did the crash actually damage the WORLD?
 * Runs the crash scenario in each city/car, then reports what the world-damage system deformed and
 * what the body-damage system did, and renders a fixed camera on the contact point before/after.
 *   node tools/_fx_env_r3.mjs [city] [car] [u]
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import { open } from './harness.mjs';

const ROOT = '/Users/sunnymallick/sunny_personal_projects/gauntlet-test';
const [city = 'vegas', car = 'muscle', u = '0.30'] = process.argv.slice(2);
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
const ctx = await browser.newContext({ viewport: { width: 900, height: 560 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await open(page, url, { city, car });
const info = await page.evaluate(async ([uu]) => {
  const G = window.__GAME;
  G.setSize(900, 560);
  G.scenario('crash', { u: +uu, after: 26 });
  const g = G.game;
  const P = g.effects.lastImpact.clone();
  const c = g.engine.camera;
  // the game's own crash camera, frozen — this is the frame a critic scores
  const F = { x: P.x, y: P.y, z: P.z };
  const shoot = () => {
    c.position.set(F.x + 5.5, F.y + 3.4, F.z + 5.5);
    c.lookAt(F.x, F.y + 0.3, F.z);
    c.fov = 45;
    c.updateProjectionMatrix(); c.updateMatrixWorld(true);
    for (const sl of g.effects.lights) { sl.l.intensity = 0; sl.dur = 0; }
    for (const p of g.effects.pools) p.clear();
    g.effects.chunks.clear();
    // put the car itself out of the way — this shot is about the WORLD
    g.car.visible = false;
    G.render();
    g.car.visible = true;
  };
  shoot();
  window.__AFTER = g.engine.renderer.domElement.toDataURL('image/png');
  const stats = {
    worldHits: g.effects.world.hits,
    worldMeshes: g.effects.world.orig.size,
    worldCands: g.effects.world.cands.length,
    loose: g.effects.world.loose.filter((l) => l.active).map((l) => ({ mode: l.mode, tris: l.geo.drawRange.count / 3, h: +l.radius.toFixed(2) })),
    dents: g.effects.body.dents,
    brokenLamps: g.effects.body.brokenLamps,
    impacts: g.effects.impacts,
  };
  g.effects.world.restore();
  shoot();
  window.__BEFORE = g.engine.renderer.domElement.toDataURL('image/png');
  return stats;
}, [u]);
console.log(JSON.stringify(info));
await fs.mkdir(`${ROOT}/shots/fx-env-r3`, { recursive: true });
for (const k of ['BEFORE', 'AFTER']) {
  const d = await page.evaluate((kk) => window[`__${kk}`], k);
  await fs.writeFile(`${ROOT}/shots/fx-env-r3/${city}-${car}-${k.toLowerCase()}.png`,
    Buffer.from(d.split(',')[1], 'base64'));
}
console.log(`${ROOT}/shots/fx-env-r3/${city}-${car}-*.png`);
await browser.close();
await server.close();

/**
 * FX piece probe (round 3): show the DAMAGE, nothing else.
 * Parks the car, fires a synthetic impact on the rear quarter, then renders a clean three-quarter
 * with the impact lamps, every particle pool and the speed shader switched off, so the dent, the
 * scuff patches and the broken lamp can be judged on their own.
 *   node tools/_fx_dmg_r3.mjs [city] [car] [corner: rear|front|side]
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import { open } from './harness.mjs';

const ROOT = '/Users/sunnymallick/sunny_personal_projects/gauntlet-test';
const [city = 'nyc', car = 'muscle', corner = 'rear'] = process.argv.slice(2);
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
const ctx = await browser.newContext({ viewport: { width: 1100, height: 660 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await open(page, url, { city, car });
const info = await page.evaluate(async ([cn]) => {
  const G = window.__GAME;
  G.setSize(1100, 660);
  G.scenario('still', {});
  const g = G.game;
  const b = g.body, f = b.forward, r = b.right;
  const back = cn === 'front' ? -1.55 : cn === 'side' ? 0 : 1.55;
  const hit = {
    x: b.pos.x + r.x * 0.92 - f.x * back,
    y: 0.62,
    z: b.pos.z + r.z * 0.92 - f.z * back,
  };
  const inward = { x: -r.x, y: 0, z: -r.z };
  const vel = { x: f.x * 44, y: 0, z: f.z * 44 };
  const clean = () => {
    for (const sl of g.effects.lights) { sl.l.intensity = 0; sl.dur = 0; }
    for (const p of g.effects.pools) p.clear();
    g.effects.chunks.clear();
    g.effects._queue.length = 0;
  };
  const park = (dist, height, fov) => {
    const c = g.engine.camera;
    c.position.set(
      b.pos.x + r.x * dist - f.x * (back * 1.6 + 2.2),
      b.pos.y + height,
      b.pos.z + r.z * dist - f.z * (back * 1.6 + 2.2),
    );
    c.lookAt(b.pos.x + r.x * 0.6 - f.x * back, b.pos.y + 0.62, b.pos.z + r.z * 0.6 - f.z * back);
    c.fov = fov; c.updateProjectionMatrix();
    clean();
    G.render();
  };
  park(4.4, 1.5, 26);
  // freeze the exact camera so before/after are the same pixels except for the damage
  const c = g.engine.camera;
  const CP = c.position.clone(), CQ = c.quaternion.clone(), CF = c.fov;
  const shoot = () => {
    c.position.copy(CP); c.quaternion.copy(CQ); c.fov = CF;
    c.updateProjectionMatrix(); c.updateMatrixWorld(true);
    clean();
    G.render();
  };
  shoot();
  window.__BEFORE = g.engine.renderer.domElement.toDataURL('image/png');
  g.effects.crash(hit, inward, 0.92, { vel, paint: g.carColor });
  shoot();
  return {
    dents: g.effects.body.dents,
    brokenLamps: g.effects.body.brokenLamps,
    lenses: g.effects.body.lenses.length,
    patches: g.effects.body.patches.filter((p) => p.mesh.visible).map((p) => p.geo.drawRange.count),
    worldHits: g.effects.world.hits,
    worldCands: g.effects.world.cands.length,
  };
}, [corner]);
console.log(JSON.stringify(info));
await fs.mkdir(`${ROOT}/shots/fx-dmg-r3`, { recursive: true });
const before = await page.evaluate(() => window.__BEFORE);
await fs.writeFile(`${ROOT}/shots/fx-dmg-r3/${city}-${car}-${corner}-before.png`,
  Buffer.from(before.split(',')[1], 'base64'));
const out = `${ROOT}/shots/fx-dmg-r3/${city}-${car}-${corner}-after.png`;
await fs.writeFile(out, await page.screenshot({ type: 'png' }));
console.log(out);
await browser.close();
await server.close();

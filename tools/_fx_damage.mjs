/**
 * FX piece probe — isolate the body-damage system.
 * Parks the car, fires a synthetic impact on its right flank, then shoots a clean rear-three-quarter
 * of that flank so the dent and the scuff patch can be judged on their own.
 *   node tools/_fx_damage.mjs [city] [car]
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import { open } from './harness.mjs';

const ROOT = '/Users/sunnymallick/sunny_personal_projects/gauntlet-test';
const [city = 'nyc', car = 'muscle'] = process.argv.slice(2);
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
const info = await page.evaluate(async () => {
  const G = window.__GAME;
  G.setSize(1100, 660);
  G.scenario('still', {});
  const g = G.game;
  const b = g.body, f = b.forward, r = b.right;
  // contact on the right flank, at rubbing-strip height, a little behind the middle
  const hit = {
    x: b.pos.x + r.x * 1.02 - f.x * 0.5,
    y: 0.55,
    z: b.pos.z + r.z * 1.02 - f.z * 0.5,
  };
  // `inward` points from the barrier toward the car
  const inward = { x: -r.x, y: 0, z: -r.z };
  const vel = { x: f.x * 42, y: 0, z: f.z * 42 };
  const c = g.engine.camera;
  const park = () => {
    c.position.set(b.pos.x + r.x * 4.6 - f.x * 4.2, b.pos.y + 1.85, b.pos.z + r.z * 4.6 - f.z * 4.2);
    c.lookAt(b.pos.x + r.x * 0.9 - f.x * 0.35, b.pos.y + 0.85, b.pos.z + r.z * 0.9 - f.z * 0.35);
    c.fov = 17; c.updateProjectionMatrix();
    for (const sl of g.effects.lights) { sl.l.intensity = 0; sl.dur = 0; }
    for (const p of g.effects.pools) p.clear();
    g.effects.chunks.clear();
    G.render();
  };
  if (window.__DEBUG_PATCH) {
    g.effects.body.material.emissive.set('#ff0044');
    g.effects.body.material.emissiveIntensity = 3;
  }
  park();
  window.__BEFORE = g.engine.renderer.domElement.toDataURL('image/png');
  g.effects.crash(hit, inward, 0.85, { vel, paint: g.carColor });
  for (let i = 0; i < 90; i++) g.update(1 / 60);
  park();
  return {
    dents: g.effects.body.dents,
    patches: g.effects.body.patches.filter((p) => p.mesh.visible).map((p) => p.geo.drawRange.count),
    lastDent: g.effects.body.lastDent,
  };
});
console.log(JSON.stringify(info));
await fs.mkdir(`${ROOT}/shots/fx-damage`, { recursive: true });
const before = await page.evaluate(() => window.__BEFORE);
await fs.writeFile(`${ROOT}/shots/fx-damage/iso-${city}-${car}-before.png`,
  Buffer.from(before.split(',')[1], 'base64'));
const out = `${ROOT}/shots/fx-damage/iso-${city}-${car}.png`;
await fs.writeFile(out, await page.screenshot({ type: 'png' }));
console.log(out);
await browser.close();
await server.close();

/**
 * FX piece probe: run the crash scenario, then park a close rear-three-quarter camera on the car so
 * the builder can actually SEE what the impact did to the bodywork (dent + scuff patch).
 *   node tools/_fx_crashcam.mjs [city] [car] [u] [side]
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import { open } from './harness.mjs';

const ROOT = '/Users/sunnymallick/sunny_personal_projects/gauntlet-test';
const [city = 'nyc', car = 'muscle', u = '0.30', side = '1'] = process.argv.slice(2);
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
const ctx = await browser.newContext({ viewport: { width: 1000, height: 620 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await open(page, url, { city, car });
const info = await page.evaluate(async ([uu, sd]) => {
  const G = window.__GAME;
  G.setSize(1000, 620);
  G.scenario('crash', { u: +uu, after: 60 });
  const g = G.game;
  const dents = g.effects.body.dents;
  const live = g.effects.body.patches.filter((p) => p.mesh.visible);
  const patches = live.map((p) => p.geo.drawRange.count);
  // aim at the patch itself, from outside along its own average normal
  const ld = g.effects.body.lastDent;
  let target = null, look = null;
  if (ld) { target = ld.c; look = [-ld.d[0], -ld.d[1], -ld.d[2]]; }
  const c = g.engine.camera;
  const p = g.body.pos, f = g.body.forward, r = g.body.right;
  if (target) {
    // patch centre + normal are in CAR space; rotate into world by the car's yaw
    const wx = p.x + r.x * target[0] + f.x * target[2];
    const wy = p.y + target[1];
    const wz = p.z + r.z * target[0] + f.z * target[2];
    const dx = r.x * look[0] + f.x * look[2], dz = r.z * look[0] + f.z * look[2];
    c.position.set(wx + dx * 6.2 - f.x * 1.6, wy + 1.9, wz + dz * 6.2 - f.z * 1.6);
    c.lookAt(wx, wy, wz);
  } else {
    c.position.set(p.x - f.x * 4.2 + r.x * 3.4 * (+sd), p.y + 1.9, p.z - f.z * 4.2 + r.z * 3.4 * (+sd));
    c.lookAt(p.x, p.y + 0.6, p.z);
  }
  c.fov = 42; c.updateProjectionMatrix();
  // kill the impact lamps so the close-up shows the BODYWORK, not the fireball
  for (const sl of g.effects.lights) { sl.l.intensity = 0; sl.dur = 0; }
  G.render();
  return { dents, patches, target, look, impacts: g.effects.impacts, damage: +g.effects.damage.toFixed(2) };
}, [u, side]);
console.log(JSON.stringify(info));
const out = `${ROOT}/shots/fx-damage/${city}-${car}-u${u}-s${side}.png`;
await fs.mkdir(`${ROOT}/shots/fx-damage`, { recursive: true });
await fs.writeFile(out, await page.screenshot({ type: 'png' }));
console.log(out);
await browser.close();
await server.close();

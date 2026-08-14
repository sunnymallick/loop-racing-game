/** Private Miami probe: where are the wet-road layers, and what do they contribute? */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, scenario } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const car = process.argv[2] || 'muscle';
const shot = process.argv[3] || 'chase';
const OUT = process.argv[4] || '/tmp/mi-wet';

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
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await open(page, url, { city: 'miami', car });
await scenario(page, shot, {});

console.log(JSON.stringify(await page.evaluate(() => {
  const g = window.__GAME.game;
  const cam = g.engine.camera;
  const out = { streak: [], sheen: [], camera: cam.position.toArray().map((v) => +v.toFixed(1)) };
  g.city.group.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const n = o.material.name;
    if (n !== 'mi-streak' && n !== 'mi-sheen') return;
    o.geometry.computeBoundingSphere();
    const bs = o.geometry.boundingSphere;
    const c = bs.center.clone().applyMatrix4(o.matrixWorld);
    out[n === 'mi-streak' ? 'streak' : 'sheen'].push({
      tris: o.geometry.index ? o.geometry.index.count / 3 : o.geometry.attributes.position.count / 3,
      r: +bs.radius.toFixed(1),
      d: +c.distanceTo(cam.position).toFixed(1),
      vis: o.visible,
      culled: o.frustumCulled,
      nan: Number.isNaN(bs.radius) || Number.isNaN(c.x),
    });
  });
  // how much streak geometry actually sits near the camera
  const cp = cam.position;
  let near = 0, minD = 1e9;
  g.city.group.traverse((o) => {
    if (!o.isMesh || !o.material || o.material.name !== 'mi-streak') return;
    const p = o.geometry.attributes.position;
    const e = o.matrixWorld.elements;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const wx = e[0] * x + e[4] * y + e[8] * z + e[12];
      const wy = e[1] * x + e[5] * y + e[9] * z + e[13];
      const wz = e[2] * x + e[6] * y + e[10] * z + e[14];
      const d = Math.hypot(wx - cp.x, wy - cp.y, wz - cp.z);
      if (d < minD) minD = d;
      if (d < 40) near++;
    }
  });
  out.streakVertsWithin40m = near;
  out.streakMinDist = +minD.toFixed(2);
  out.streakCount = out.streak.length;
  out.sheenCount = out.sheen.length;
  out.streakNear = out.streak.filter((s) => s.d < 120).length;
  out.sheenNear = out.sheen.filter((s) => s.d < 120).length;
  out.streak = out.streak.slice(0, 6);
  out.sheen = out.sheen.slice(0, 6);
  return out;
}, null), null, 1));

// A/B renders: streaks only, sheen only, neither
for (const [name, code] of [
  ['all', 'a'],
  ['nostreak', 'b'],
  ['nosheen', 'c'],
  ['neither', 'd'],
  ['streakx6', 'e'],
]) {
  await page.evaluate((k) => {
    const g = window.__GAME.game;
    g.city.group.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      if (o.material.name === 'mi-streak') {
        o.visible = k !== 'b' && k !== 'd';
        o.material.opacity = k === 'e' ? 6 : 1;
      }
      if (o.material.name === 'mi-sheen') o.visible = k !== 'c' && k !== 'd';
    });
    g.render(0);
  }, code);
  await page.screenshot({ path: `${OUT}-${name}.png` });
  console.log(`${OUT}-${name}.png`);
}
await browser.close();
await server.close();

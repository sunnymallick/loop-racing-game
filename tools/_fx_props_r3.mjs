/**
 * FX piece probe (round 3): after a crash, list what the WORLD has near the contact point, and in
 * what form — InstancedMesh instance, merged bucket, or a standalone mesh. Environment response is
 * only possible against things this piece can actually address.
 *   node tools/_fx_props_r3.mjs [city] [car] [u]
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
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
const ctx = await browser.newContext({ viewport: { width: 640, height: 400 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await open(page, url, { city, car });
const info = await page.evaluate(async ([uu]) => {
  const G = window.__GAME;
  G.scenario('crash', { u: +uu, after: 12 });
  const g = G.game;
  const THREE = g.THREE || window.THREE;
  const P = g.effects.lastImpact;
  const out = [];
  const m = new (Object.getPrototypeOf(g.car.matrixWorld).constructor)();
  const scan = (root, label) => {
    root.traverse((o) => {
      if (!o.isMesh) return;
      o.updateWorldMatrix(true, false);
      if (o.isInstancedMesh) {
        let near = 0; let first = null;
        for (let i = 0; i < o.count; i++) {
          o.getMatrixAt(i, m);
          const x = m.elements[12], y = m.elements[13], z = m.elements[14];
          // instance matrices are in the InstancedMesh's own space
          const v = { x, y, z };
          const w = o.matrixWorld.elements;
          const wx = w[0] * v.x + w[4] * v.y + w[8] * v.z + w[12];
          const wy = w[1] * v.x + w[5] * v.y + w[9] * v.z + w[13];
          const wz = w[2] * v.x + w[6] * v.y + w[10] * v.z + w[14];
          const d = Math.hypot(wx - P.x, wz - P.z);
          if (d < 9) { near++; if (!first || d < first.d) first = { d: +d.toFixed(2), y: +wy.toFixed(2) }; }
        }
        if (near) out.push({ kind: 'inst', name: o.name || '(anon)', parent: o.parent?.name, count: o.count, near, first, label });
      } else {
        if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
        const bs = o.geometry.boundingSphere.clone().applyMatrix4(o.matrixWorld);
        const d = Math.hypot(bs.center.x - P.x, bs.center.z - P.z);
        if (d - bs.radius < 6 && bs.radius < 40) {
          out.push({ kind: 'mesh', name: o.name || '(anon)', parent: o.parent?.name, d: +d.toFixed(2), r: +bs.radius.toFixed(2), verts: o.geometry.attributes.position.count, label });
        }
      }
    });
  };
  if (g.city?.group) scan(g.city.group, 'city');
  return { impact: [P.x.toFixed(1), P.y.toFixed(1), P.z.toFixed(1)], n: out.length, out: out.slice(0, 40) };
}, [u]);
console.log(JSON.stringify(info, null, 1));
await browser.close();
await server.close();

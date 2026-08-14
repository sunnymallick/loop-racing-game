/**
 * FX piece probe (round 3): which world geometry actually has vertices within a couple of metres of
 * the crash contact? Environment response can only be applied to geometry that is THERE.
 *   node tools/_fx_world_r3.mjs [city] [car] [u]
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
  const P = g.effects.lastImpact;
  const rows = [];
  const scan = (root, label) => {
    root.traverse((o) => {
      if (!o.isMesh || o.isInstancedMesh) return;
      const pos = o.geometry?.attributes?.position;
      if (!pos) return;
      o.updateWorldMatrix(true, false);
      const e = o.matrixWorld.elements;
      const pa = pos.array;
      let best = 1e9, within = 0, minY = 1e9, maxY = -1e9;
      for (let i = 0; i < pos.count; i++) {
        const x = pa[i * 3], y = pa[i * 3 + 1], z = pa[i * 3 + 2];
        const wx = e[0] * x + e[4] * y + e[8] * z + e[12];
        const wy = e[1] * x + e[5] * y + e[9] * z + e[13];
        const wz = e[2] * x + e[6] * y + e[10] * z + e[14];
        const d = Math.hypot(wx - P.x, wz - P.z);
        if (d < best) best = d;
        if (d < 2.5) { within++; if (wy < minY) minY = wy; if (wy > maxY) maxY = wy; }
      }
      if (best < 6) {
        const chain = [];
        for (let p = o; p; p = p.parent) if (p.name) chain.unshift(p.name);
        rows.push({ label, chain: chain.join('/'), mat: o.material?.name || o.material?.type,
          verts: pos.count, nearest: +best.toFixed(2), within, yRange: within ? [+minY.toFixed(2), +maxY.toFixed(2)] : null });
      }
    });
  };
  scan(g.city.group, 'city');
  rows.sort((a, b) => a.nearest - b.nearest);
  return { impact: [+P.x.toFixed(1), +P.y.toFixed(1), +P.z.toFixed(1)], rows: rows.slice(0, 20) };
}, [u]);
console.log(JSON.stringify(info, null, 1));
await browser.close();
await server.close();

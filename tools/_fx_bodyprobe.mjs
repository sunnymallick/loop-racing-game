/** Dump the player car's body mesh topology so the FX piece knows what it can deform. */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { open } from '/Users/sunnymallick/sunny_personal_projects/gauntlet-test/tools/harness.mjs';

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
const ctx = await browser.newContext({ viewport: { width: 640, height: 360 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await open(page, url, { city: 'nyc', car: 'muscle' });
const data = await page.evaluate(() => {
  const g = window.__GAME.game;
  const out = [];
  const body = g.car.userData.body;
  body.traverse((o) => {
    if (!o.isMesh) return;
    const p = o.geometry.attributes.position;
    o.geometry.computeBoundingBox();
    const bb = o.geometry.boundingBox;
    out.push({
      name: o.name, mat: o.material.type, matName: o.material.name || '',
      transparent: !!o.material.transparent,
      verts: p.count, indexed: !!o.geometry.index,
      bb: [bb.min.toArray().map((v) => +v.toFixed(2)), bb.max.toArray().map((v) => +v.toFixed(2))],
    });
  });
  return { children: body.children.length, out, dims: g.car.userData.dims };
});
console.log(JSON.stringify(data, null, 1));
await browser.close();
await server.close();

/** Dump the FX sprite atlases to /tmp so the builder can look at the actual sprites. */
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
const ctx = await browser.newContext({ viewport: { width: 640, height: 360 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await open(page, url, { city: 'nyc', car: 'muscle' });
const data = await page.evaluate(() => {
  const fx = window.__GAME.game.effects;
  const dump = (tex, bg) => {
    const img = tex.image;
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const x = c.getContext('2d');
    x.fillStyle = bg; x.fillRect(0, 0, c.width, c.height);
    x.drawImage(img, 0, 0);
    return c.toDataURL('image/png');
  };
  return {
    smoke: dump(fx.smoke.material.uniforms.uMap.value, '#2a3140'),
    glow: dump(fx.glow.material.uniforms.uMap.value, '#101014'),
  };
});
for (const [k, v] of Object.entries(data)) {
  await fs.writeFile(`/tmp/fx_${k}.png`, Buffer.from(v.split(',')[1], 'base64'));
  console.log(`/tmp/fx_${k}.png`);
}
await browser.close();
await server.close();

/** Private nitrous-piece probe: run a scenario, then re-render with subsystems hidden. */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, scenario } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const car = process.argv[2] || 'muscle';
const shot = process.argv[3] || 'nitrous-long';

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
await open(page, url, { city: 'la', car });
await scenario(page, shot, {});

const variants = [
  ['all', () => {}],
  ['nosmoke', (g) => { g.effects.smoke.points.visible = false; }],
  ['nosparks', (g) => { g.effects.sparks.points.visible = false; }],
  ['noglow', (g) => { g.effects.glow.points.visible = false; }],
  ['nojet', (g) => { g.jet.group.visible = false; }],
  ['jetonly', (g) => { for (const s of g.effects.pools) s.points.visible = false; }],
  ['clean', () => {}],
];
for (const [name] of variants) {
  await page.evaluate((n) => {
    const g = window.__GAME.game;
    for (const s of g.effects.pools) s.points.visible = true;
    g.jet.group.visible = true;
    if (n === 'nosmoke') g.effects.smoke.points.visible = false;
    if (n === 'nosparks') g.effects.sparks.points.visible = false;
    if (n === 'noglow') g.effects.glow.points.visible = false;
    if (n === 'nojet') g.jet.group.visible = false;
    if (n === 'jetonly') for (const s of g.effects.pools) s.points.visible = false;
    if (n === 'clean') { for (const s of g.effects.pools) s.points.visible = false; g.jet.group.visible = false; }
    g.render(0);
  }, name);
  await page.screenshot({ path: `/tmp/probe-${car}-${name}.png` });
  console.log(`/tmp/probe-${car}-${name}.png`);
}
console.log('lateral:', JSON.stringify(await page.evaluate(() => {
  const g = window.__GAME.game;
  const n = g.city.track.nearest(g.body.pos, g.race?.playerU ?? null);
  return { lateral: +n.lateral.toFixed(3), speed: +g.body.speed.toFixed(1) };
})));
await browser.close();
await server.close();

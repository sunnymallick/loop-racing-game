// HUD round-3 capture harness.
//
// Same job as tools/shot.mjs, but it boots Vite with `server.hmr: false`. Other builders are
// editing this tree while I capture; with HMR on, any write to any source file full-reloads the
// page mid-scenario and playwright dies with "Execution context was destroyed". The r2 critic hit
// exactly this. Also emits 3x zoom crops of each HUD cluster, because type quality is judged there.
//
//   node tools/_hud_r3.mjs [outdir] [--zoom]
import { createServer } from 'vite';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './harness.mjs';

const args = process.argv.slice(2);
const OUT = path.resolve(ROOT, args.find((a) => !a.startsWith('--')) || 'shots/hud-r3');
const ZOOM = args.includes('--zoom');
await fs.mkdir(OUT, { recursive: true });

const server = await createServer({
  root: ROOT,
  logLevel: 'error',
  server: { port: 20000 + Math.floor(Math.random() * 30000), strictPort: false, host: '127.0.0.1', hmr: false },
  optimizeDeps: { include: ['three'] },
});
await server.listen();
const url = server.resolvedUrls.local[0].replace(/\/$/, '');

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--enable-webgl', '--disable-dev-shm-usage', '--force-device-scale-factor=1'],
});
const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const logs = [];
page.on('console', (m) => { if (m.type() === 'error') logs.push(`[error] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

// clusters to zoom, in design-space (1600x900) coordinates
const CROPS = {
  chassis: [10, 8, 340, 380],
  clock: [600, 8, 400, 110],
  banner: [1230, 8, 360, 110],
  gauge: [1180, 470, 410, 420],
  drift: [10, 780, 300, 110],
};

const jobs = [['la', 'chase'], ['la', 'nitrous'], ['vegas', 'chase'], ['vegas', 'nitrous'], ['la', 'drift']];

async function run() {
  for (const [city, shot] of jobs) {
    const q = new URLSearchParams({ shot: '1', city, car: 'muscle' });
    await page.goto(`${url}/?${q}`, { waitUntil: 'domcontentloaded', timeout: 180000 });
    await page.waitForFunction('window.__READY === true || window.__READY === "error"', null, { timeout: 120000 });
    if (await page.evaluate('window.__READY') === 'error') {
      throw new Error('BOOT ' + JSON.stringify(await page.evaluate('window.__ERRORS')));
    }
    await page.evaluate(([n, o]) => window.__GAME.scenario(n, o), [shot, {}]);
    await page.evaluate(([w, h]) => window.__GAME.setSize(w, h), [1600, 900]);
    await page.evaluate(() => window.__GAME.render());
    await page.evaluate(() => window.__GAME.render());
    const file = path.join(OUT, `${city}-muscle-${shot}.png`);
    await page.screenshot({ path: file, type: 'png', timeout: 180000, animations: 'disabled' });
    console.log('ok', path.relative(ROOT, file));

    if (ZOOM && shot === 'chase') {
      for (const [name, [x, y, w, h]] of Object.entries(CROPS)) {
        await page.screenshot({
          path: path.join(OUT, `z-${city}-${name}.png`), type: 'png',
          clip: { x, y, width: w, height: h }, scale: 'device',
        });
      }
    }
  }
}
let ok = false;
for (let i = 0; i < 3 && !ok; i++) {
  try { await run(); ok = true; }
  catch (e) { console.log(`attempt ${i} failed:`, e.message.slice(0, 220)); await new Promise((r) => setTimeout(r, 8000)); }
}
console.log('DONE', ok);
if (logs.length) console.log('LOGS', JSON.stringify(logs.slice(0, 20), null, 1));
await browser.close();
await server.close();

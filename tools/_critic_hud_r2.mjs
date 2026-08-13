import { createServer } from 'vite';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './harness.mjs';

const OUT = path.resolve(ROOT, 'shots/critic-hud-r2');
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
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--disable-dev-shm-usage', '--force-device-scale-factor=1'],
});
const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
page.on('framenavigated', (f) => { if (f === page.mainFrame()) logs.push(`[nav] ${f.url()}`); });
page.on('crash', () => logs.push('[crash] page crashed'));

const jobs = [['la', 'chase'], ['la', 'nitrous'], ['vegas', 'chase'], ['vegas', 'nitrous']];
async function attempt() {
  for (const [city, shot] of jobs) {
    const q = new URLSearchParams({ shot: '1', city, car: 'muscle' });
    await page.goto(`${url}/?${q}`, { waitUntil: 'domcontentloaded', timeout: 180000 });
    await page.waitForFunction('window.__READY === true || window.__READY === "error"', null, { timeout: 100000 });
    const state = await page.evaluate('window.__READY');
    if (state === 'error') throw new Error('BOOTERR ' + JSON.stringify(await page.evaluate('window.__ERRORS')));
    await page.evaluate(([n, o]) => window.__GAME.scenario(n, o), [shot, {}]);
    await page.evaluate(([w, h]) => window.__GAME.setSize(w, h), [1600, 900]);
    await page.evaluate(() => window.__GAME.render());
    await page.evaluate(() => window.__GAME.render());
    const file = path.join(OUT, `${city}-muscle-${shot}.png`);
    await page.screenshot({ path: file, type: 'png', timeout: 180000, animations: 'disabled' });
    console.log('ok', file);
  }
}
let done = false;
for (let i = 0; i < 6 && !done; i++) {
  try { await attempt(); done = true; }
  catch (e) {
    console.log(`attempt ${i} FAIL`, e.message.slice(0, 200));
    logs.length = 0;
    await new Promise((r) => setTimeout(r, 45000));
  }
}
console.log('DONE:', done);
console.log('LOGS:', JSON.stringify(logs.slice(0, 30), null, 1));
await browser.close();
await server.close();

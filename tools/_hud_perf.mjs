// How much of a frame does the HUD cost? Measures render() with and without hud.draw at the
// functest viewport (640x360) and at the real target (1600x900).
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { ROOT } from './harness.mjs';

const server = await createServer({
  root: ROOT, logLevel: 'error',
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
const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 })).newPage();
await page.goto(`${url}/?shot=1&city=vegas&car=supercar`, { waitUntil: 'domcontentloaded', timeout: 180000 });
await page.waitForFunction('window.__READY === true || window.__READY === "error"', null, { timeout: 120000 });
await page.evaluate(([n, o]) => window.__GAME.scenario(n, o), ['chase', {}]);

const out = await page.evaluate(async () => {
  const G = window.__GAME, g = G.game;
  const real = g.hud.draw.bind(g.hud);
  const time = (n, fn) => { const t0 = performance.now(); for (let i = 0; i < n; i++) fn(); return (performance.now() - t0) / n; };
  const res = {};
  for (const [w, h] of [[640, 360], [1600, 900]]) {
    G.setSize(w, h);
    G.render(); G.render();
    const full = time(12, () => G.render());
    const hudOnly = time(12, () => real(g.hudState(), 1 / 60));
    g.hud.draw = () => {};
    const noHud = time(12, () => G.render());
    g.hud.draw = real;
    res[`${w}x${h}`] = {
      frameMs: +full.toFixed(2), hudMs: +hudOnly.toFixed(2), frameNoHudMs: +noHud.toFixed(2),
      hudBuffer: g.hud.buf ? `${g.hud.buf.width}x${g.hud.buf.height}` : 'none',
      scale: +g.hud.scale.toFixed(2),
    };
  }
  return res;
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
await server.close();

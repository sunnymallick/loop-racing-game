import { createServer } from 'vite';
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Boots a Vite dev server on a free port and a headless Chromium with software WebGL.
 * Every builder/critic agent gets its own server + browser, so many can run concurrently
 * without fighting over a port.
 */
export async function boot({ headless = true, width = 1600, height = 900 } = {}) {
  const port = 20000 + Math.floor(Math.random() * 30000);
  const server = await createServer({
    root: ROOT,
    logLevel: 'error',
    server: { port, strictPort: false, host: '127.0.0.1' },
    optimizeDeps: { include: ['three'] },
  });
  await server.listen();
  const url = server.resolvedUrls.local[0].replace(/\/$/, '');

  const browser = await chromium.launch({
    headless,
    args: [
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      '--enable-webgl',
      '--disable-dev-shm-usage',
      '--force-device-scale-factor=1',
    ],
  });
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    reducedMotion: 'no-preference',
  });
  const page = await context.newPage();
  const logs = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

  return {
    server, browser, context, page, url, logs,
    async close() { await browser.close(); await server.close(); },
  };
}

/** Navigate and wait until the game has finished building its first city + car. */
export async function open(page, url, { city = 'la', car = 'muscle', color = null, timeout = 120000 } = {}) {
  const q = new URLSearchParams({ shot: '1', city, car });
  if (color) q.set('color', color);
  await page.goto(`${url}/?${q}`, { waitUntil: 'domcontentloaded', timeout });
  await page.waitForFunction('window.__READY === true || window.__READY === "error"', null, { timeout });
  const state = await page.evaluate('window.__READY');
  if (state === 'error') {
    const errs = await page.evaluate('window.__ERRORS');
    throw new Error(`Boot failed:\n${errs.join('\n')}`);
  }
  return true;
}

/** Run a named scenario and return its telemetry trace. */
export async function scenario(page, name, opts = {}) {
  return page.evaluate(
    ([n, o]) => window.__GAME.scenario(n, o),
    [name, opts],
  );
}

export async function load(page, spec) {
  return page.evaluate((s) => window.__GAME.load(s), spec);
}

export async function telemetry(page) {
  return page.evaluate(() => window.__GAME.telemetry());
}

export async function errors(page) {
  return page.evaluate(() => window.__ERRORS || []);
}

/** Render one frame and screenshot to disk. */
export async function capture(page, file, { width = 1600, height = 900 } = {}) {
  await page.evaluate(([w, h]) => window.__GAME.setSize(w, h), [width, height]);
  await page.evaluate(() => window.__GAME.render());
  // one extra frame so post-processing history (SMAA / composer ping-pong) is settled
  await page.evaluate(() => window.__GAME.render());
  await page.screenshot({ path: file, type: 'png' });
  return file;
}

/** Measure sustained frame rate over `frames` real animation frames. */
export async function measureFps(page, frames = 90) {
  return page.evaluate(async (n) => {
    const g = window.__GAME.game;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      g.update(1 / 60);
      g.render(1 / 60);
      await new Promise((r) => requestAnimationFrame(r));
    }
    const dt = performance.now() - t0;
    return { frames: n, ms: dt, fps: (n / dt) * 1000 };
  }, frames);
}

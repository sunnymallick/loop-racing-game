import { createServer } from 'vite';
import { chromium } from 'playwright';
import { ROOT } from './harness.mjs';

const server = await createServer({ root: ROOT, logLevel: 'error', server: { port: 20000 + Math.floor(Math.random() * 30000), host: '127.0.0.1', hmr: false }, optimizeDeps: { include: ['three'] } });
await server.listen();
const url = server.resolvedUrls.local[0].replace(/\/$/, '');
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] });
const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();

await page.addInitScript(() => {
  window.__FONTS = new Set();
  window.__FILLTEXT = 0;
  const d = Object.getOwnPropertyDescriptor(CanvasRenderingContext2D.prototype, 'font');
  Object.defineProperty(CanvasRenderingContext2D.prototype, 'font', {
    get() { return d.get.call(this); },
    set(v) { window.__FONTS.add(String(v)); return d.set.call(this, v); },
  });
  const ft = CanvasRenderingContext2D.prototype.fillText;
  CanvasRenderingContext2D.prototype.fillText = function (...a) { window.__FILLTEXT++; return ft.apply(this, a); };
  const st = CanvasRenderingContext2D.prototype.strokeText;
  CanvasRenderingContext2D.prototype.strokeText = function (...a) { window.__FILLTEXT++; return st.apply(this, a); };
});

await page.goto(`${url}/?shot=1&city=la&car=muscle`, { waitUntil: 'domcontentloaded', timeout: 180000 });
await page.waitForFunction('window.__READY === true || window.__READY === "error"', null, { timeout: 120000 });
await page.evaluate(([n, o]) => window.__GAME.scenario(n, o), ['chase', {}]);
await page.evaluate(() => window.__GAME.render());

const out = await page.evaluate(() => ({
  fonts: [...window.__FONTS],
  fillTextCalls: window.__FILLTEXT,
  canvases: [...document.querySelectorAll('canvas')].map((c) => ({ w: c.width, h: c.height, cls: c.className, ctx: c.getContext ? 'y' : 'n' })),
  domText: [...document.querySelectorAll('body *')].filter((e) => e.children.length === 0 && e.textContent.trim()).slice(0, 20).map((e) => ({ tag: e.tagName, txt: e.textContent.trim().slice(0, 40), ff: getComputedStyle(e).fontFamily })),
  htmlLen: document.body.innerHTML.length,
  linkTags: [...document.querySelectorAll('link,style')].map((e) => e.tagName + ':' + (e.href || e.textContent.slice(0, 200))),
  docFonts: document.fonts ? document.fonts.size : -1,
}));
console.log(JSON.stringify(out, null, 1));
await browser.close();
await server.close();

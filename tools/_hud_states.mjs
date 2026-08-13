// Renders the HUD's *state* paths that no camera scenario reaches: the countdown + start lights,
// a position gain, a lap flash, an empty nitro bank, and the single-slot message queue under a
// double event. Boots with hmr:false for the same reason as _hud_r3.mjs.
import { createServer } from 'vite';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './harness.mjs';

const OUT = path.resolve(ROOT, 'shots/hud-r3-states');
await fs.mkdir(OUT, { recursive: true });

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
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`${url}/?shot=1&city=la&car=muscle`, { waitUntil: 'domcontentloaded', timeout: 180000 });
await page.waitForFunction('window.__READY === true || window.__READY === "error"', null, { timeout: 120000 });
await page.evaluate(([n, o]) => window.__GAME.scenario(n, o), ['chase', {}]);
await page.evaluate(([w, h]) => window.__GAME.setSize(w, h), [1600, 900]);
await page.evaluate(() => window.__GAME.render());

// drive the HUD directly with synthetic states
const scenes = {
  countdown: `(g)=>{const s=g.hudState();s.state='countdown';s.countdown=2.4;s.raceTime=0;s.mph=0;
     g.hud.lastCount=99;g.hud.needle=0;for(let i=0;i<40;i++)g.hud.update(s,1/60);g.hud.draw(s,1/60);}`,
  // two events in the same frame: the queue must show ONE banner, then the next
  twomsg: `(g)=>{const s=g.hudState();g.hud.msg=null;g.hud.msgQueue=[];
     g.hud.message('NITRO!',1.1,'#ff9214');g.hud.message('BOOST',0.9,'#ffd24a');
     for(let i=0;i<12;i++)g.hud.update(s,1/60);g.hud.draw(s,1/60);}`,
  twomsg_later: `(g)=>{const s=g.hudState();for(let i=0;i<75;i++)g.hud.update(s,1/60);g.hud.draw(s,1/60);}`,
  gain: `(g)=>{const s=g.hudState();s.position=3;s.lap=2;s.nitroTanks=0;s.nitroCharge=0.18;s.mph=176;
     g.hud.lastPos=5;g.hud.lastLap=1;for(let i=0;i<8;i++)g.hud.update(s,1/60);g.hud.draw(s,1/60);}`,
  tanks1: `(g)=>{const s=g.hudState();s.nitroTanks=1;s.nitroCharge=0.5;g.hud.draw(s,1/60);}`,
  tanks0: `(g)=>{const s=g.hudState();s.nitroTanks=0;s.nitroCharge=0.2;g.hud.draw(s,1/60);}`,
  redline: `(g)=>{const s=g.hudState();s.mph=203;s.nitroActive=true;s.nitroCharge=0.44;s.gear=5;s.position=1;
     s.drift=0.55;s.driftScore=88;for(let i=0;i<50;i++)g.hud.update(s,1/60);g.hud.draw(s,1/60);}`,
};
for (const [name, fn] of Object.entries(scenes)) {
  await page.evaluate(`(${fn})(window.__GAME.game)`);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), type: 'png' });
  console.log('ok', name);
}
console.log('ERRORS', JSON.stringify(errs));
await browser.close();
await server.close();

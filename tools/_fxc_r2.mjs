/**
 * FX/crash builder probe (round 2, wave 2). One boot, many crash frames.
 *
 *   node tools/_fxc_r2.mjs nyc:muscle,nyc:supercar,vegas:muscle --out shots/_fxr2a
 *
 * For each pair it runs the SAME crash scenario the capture harness runs, writes <name>.png (the
 * frame the critic would score) and prints clipping statistics (what fraction of the frame is
 * blown to white).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { boot, open, ROOT } from './harness.mjs';

const argv = process.argv.slice(2);
const pairs = (argv[0] && !argv[0].startsWith('--') ? argv[0] : 'nyc:muscle,nyc:supercar')
  .split(',').map((s) => s.split(':'));
const oi = argv.indexOf('--out');
const OUT = path.resolve(ROOT, oi === -1 ? 'shots/_fxr2' : argv[oi + 1]);

const stats = async (page) => page.evaluate(() => {
  const src = window.__GAME.game.engine.renderer.domElement;
  const c = document.createElement('canvas');
  c.width = Math.floor(src.width / 2); c.height = Math.floor(src.height / 2);
  const x = c.getContext('2d');
  x.drawImage(src, 0, 0, c.width, c.height);
  const d = x.getImageData(0, 0, c.width, c.height).data;
  let clip = 0, hot = 0, sum = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (r > 248 && g > 245 && b > 240) clip++;
    if (l > 205) hot++;
    sum += l; n++;
  }
  return { clip: +(clip / n * 100).toFixed(2), hot: +(hot / n * 100).toFixed(2), mean: +(sum / n).toFixed(1) };
});

const h = await boot({ width: 1600, height: 900 });
await fs.mkdir(OUT, { recursive: true });
try {
  await open(h.page, h.url, { city: pairs[0][0], car: pairs[0][1] });
  for (const [city, car] of pairs) {
    await h.page.evaluate((s) => window.__GAME.load(s), { city, car });
    const info = await h.page.evaluate(() => {
      const G = window.__GAME;
      G.scenario('crash', {});
      const g = G.game;
      G.render(); G.render();
      return {
        impacts: g.effects.impacts,
        lights: g.effects.lights.map((l) => +l.l.intensity.toFixed(1)),
        alive: { smoke: g.effects.smoke.alive, sparks: g.effects.sparks.alive, glow: g.effects.glow.alive },
        mph: +(g.body.speed * 2.23694).toFixed(0),
      };
    });
    const name = `${city}-${car}`;
    await h.page.screenshot({ path: path.join(OUT, `${name}.png`), type: 'png' });
    const st = await stats(h.page);
    console.log(`${name}  ${JSON.stringify({ ...info, ...st })}`);
  }
  const errs = await h.page.evaluate(() => window.__ERRORS || []);
  if (errs.length) console.log('ERRORS', errs.slice(0, 6));
} finally { await h.close(); }

/**
 * FX/crash builder probe (round 2, wave 2). One boot, many crash frames.
 *
 *   node tools/_fxc_r2.mjs nyc:muscle,nyc:supercar,vegas:muscle --out shots/_fxr2a
 *
 * For each pair it runs the SAME crash scenario the capture harness runs, then writes
 *   <name>.png       the frame the critic would score
 *   <name>-dmg.png   a close rear-three-quarter on the dented corner with the impact lamps OFF,
 *                    so the deformation and the scuff can be judged as bodywork
 * and prints clipping statistics (what fraction of the frame is blown to white).
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
        dents: g.effects.body.dents,
        patchTris: g.effects.body.patches.filter((p) => p.mesh.visible).map((p) => p.geo.drawRange.count / 3),
        impacts: g.effects.impacts,
        damage: +g.effects.damage.toFixed(2),
        lights: g.effects.lights.map((l) => +l.l.intensity.toFixed(1)),
        alive: { smoke: g.effects.smoke.alive, sparks: g.effects.sparks.alive, glow: g.effects.glow.alive },
        mph: +(g.body.speed * 2.23694).toFixed(0),
      };
    });
    const name = `${city}-${car}`;
    await h.page.screenshot({ path: path.join(OUT, `${name}.png`), type: 'png' });
    const st = await stats(h.page);
    // close-up on the dent: city hidden, lamps off, particles hidden, raw forward render
    const aim = () => h.page.evaluate(() => {
      const g = window.__GAME.game;
      const ld = g.effects.body.lastDent;
      const c = g.engine.camera;
      const p = g.body.pos, f = g.body.forward, r = g.body.right;
      const wx = ld ? p.x + r.x * ld.c[0] + f.x * ld.c[2] : p.x;
      const wy = ld ? p.y + ld.c[1] : p.y + 0.6;
      const wz = ld ? p.z + r.z * ld.c[0] + f.z * ld.c[2] : p.z;
      const ox = ld ? -(r.x * ld.d[0] + f.x * ld.d[2]) : r.x;
      const oz = ld ? -(r.z * ld.d[0] + f.z * ld.d[2]) : r.z;
      c.position.set(wx + ox * 2.6 - f.x * 1.1, wy + 0.85, wz + oz * 2.6 - f.z * 1.1);
      c.lookAt(wx, wy, wz);
      c.fov = 40; c.updateProjectionMatrix();
      for (const sl of g.effects.lights) { sl.l.intensity = 0; sl.dur = 0; }
      if (g.city?.group) g.city.group.visible = false;
      for (const s of g.effects.pools) s.points.visible = false;
      g.effects.chunks.group.visible = false;
      const rr = g.engine.renderer;
      rr.setRenderTarget(null);
      rr.render(g.engine.scene, c);
    });
    await aim();
    await h.page.screenshot({ path: path.join(OUT, `${name}-dmg.png`), type: 'png' });
    // …and the same view with the damage undone, as an A/B
    await h.page.evaluate(() => {
      window.__GAME.game.effects.body.restore();
      window.__GAME.game.effects.body.group.visible = false;
    });
    await aim();
    await h.page.screenshot({ path: path.join(OUT, `${name}-clean.png`), type: 'png' });
    await h.page.evaluate(() => {
      const g = window.__GAME.game;
      if (g.city?.group) g.city.group.visible = true;
      for (const s of g.effects.pools) s.points.visible = true;
      g.effects.chunks.group.visible = true;
      g.effects.body.group.visible = true;
    });
    console.log(`${name}  ${JSON.stringify({ ...info, ...st })}`);
  }
  const errs = await h.page.evaluate(() => window.__ERRORS || []);
  if (errs.length) console.log('ERRORS', errs.slice(0, 6));
} finally { await h.close(); }

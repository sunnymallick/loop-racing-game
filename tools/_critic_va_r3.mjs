// Critic-owned orbit inspector: independent 3/4, side, front and wheel views of each vehicle.
import fs from 'node:fs/promises';
import path from 'node:path';
import { boot, open, load, scenario, ROOT } from './harness.mjs';

const OUT = path.resolve(ROOT, 'shots/critic-va-r3-orbit');
const CARS = ['tuner', 'muscle', 'suv', 'supercar'];
const CITY = process.argv[2] || 'miami';
const W = 1400, H = 1000;

const VIEWS = {
  front34: { az: 0.72, el: 0.20, dist: 1.35, look: 0.42 },
  rear34: { az: 2.45, el: 0.24, dist: 1.35, look: 0.44 },
  side: { az: 1.5708, el: 0.06, dist: 1.60, look: 0.45 },
  front: { az: 0.0, el: 0.10, dist: 1.7, look: 0.45 },
  wheelclose: { az: 1.15, el: 0.14, dist: 0.55, look: 0.16 },
};

const h = await boot({ width: W, height: H });
await fs.mkdir(OUT, { recursive: true });
try {
  await open(h.page, h.url, { city: CITY, car: CARS[0] });
  for (const car of CARS) {
    await load(h.page, { city: CITY, car });
    await scenario(h.page, 'still', { u: 0.05 });
    for (const [name, v] of Object.entries(VIEWS)) {
      await h.page.evaluate(([vv, w, hh]) => {
        const ui = document.getElementById('ui'); if (ui) ui.style.display = 'none';
        const g = window.__GAME.game;
        const c = g.car;
        const d = c.userData.dims;
        const R = Math.max(d.length, d.width) * vv.dist;
        const cam = g.engine.camera;
        cam.fov = 34;
        const lx = Math.sin(vv.az) * Math.cos(vv.el) * R;
        const ly = Math.sin(vv.el) * R + d.height * 0.30;
        const lz = Math.cos(vv.az) * Math.cos(vv.el) * R;
        const yaw = c.rotation.y;
        const wx = lx * Math.cos(yaw) + lz * Math.sin(yaw);
        const wz = -lx * Math.sin(yaw) + lz * Math.cos(yaw);
        const p = c.position;
        cam.position.set(p.x + wx, p.y + ly, p.z + wz);
        cam.lookAt(p.x, p.y + d.height * vv.look, p.z);
        g.engine.resize(w, hh);
        cam.aspect = w / hh; cam.updateProjectionMatrix();
      }, [v, W, H]);
      await h.page.evaluate(() => { window.__GAME.render(); window.__GAME.render(); });
      await h.page.screenshot({ path: path.join(OUT, `${car}-${name}.png`), type: 'png', timeout: 60000 });
      console.log('ok', car, name);
    }
  }
  console.log('errors:', JSON.stringify(await h.page.evaluate(() => window.__ERRORS || [])));
} finally { await h.close(); }

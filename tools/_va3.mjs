// Private vehicle-art probe: orbit the built car with a dedicated camera and screenshot it.
// Not shipped code. Usage: node tools/_va3.mjs [outdir] [city] [cars...]
import fs from 'node:fs/promises';
import path from 'node:path';
import { boot, open, load, ROOT } from './harness.mjs';

const out = path.resolve(ROOT, process.argv[2] || 'shots/_va3');
const city = process.argv[3] || 'la';
const cars = (process.argv[4] || 'tuner,muscle,suv,supercar').split(',');

// name, azimuth (deg, 0 = behind the car), elevation (deg), distance multiplier, target height mul
const VIEWS = [
  ['side', 90, 6, 1.35, 0.52],
  ['rear', 2, 7, 1.15, 0.50],
  ['front34', 145, 12, 1.30, 0.50],
  ['rear34', 35, 10, 1.25, 0.50],
  ['wheelRR', -62, 8, 0.42, 0.50],
];

const h = await boot({ width: 1400, height: 900 });
await fs.mkdir(out, { recursive: true });
try {
  await open(h.page, h.url, { city, car: cars[0] });
  await h.page.evaluate(() => { const u = document.getElementById('ui'); if (u) u.style.display = 'none'; });
  for (const car of cars) {
    await load(h.page, { city, car });
    await h.page.evaluate(() => window.__GAME.scenario('still', { u: 0.05 }));
    for (const [name, az, el, dm, th] of VIEWS) {
      await h.page.evaluate(([az, el, dm, th, wheel]) => {
        const g = window.__GAME.game;
        const cam = g.engine.camera;
        const car = g.car;
        const d = car.userData.dims;
        const yaw = Math.atan2(g.body.forward.x, g.body.forward.z);
        const a = yaw + Math.PI + (az * Math.PI) / 180;
        const dist = Math.max(d.length, 4) * dm;
        const target = car.position.clone();
        target.y += d.height * th;
        if (wheel) {
          const w = car.userData.wheels[3];
          w.getWorldPosition(target);
        }
        const e = (el * Math.PI) / 180;
        cam.position.set(
          target.x + Math.sin(a) * dist * Math.cos(e),
          target.y + Math.sin(e) * dist,
          target.z + Math.cos(a) * dist * Math.cos(e),
        );
        cam.fov = 34;
        cam.lookAt(target);
        cam.updateProjectionMatrix();
        cam.updateMatrixWorld();
      }, [az, el, dm, th, name === 'wheelRR']);
      await h.page.evaluate(() => window.__GAME.render());
      await h.page.evaluate(() => window.__GAME.render());
      const f = path.join(out, `${car}-${name}.png`);
      await h.page.screenshot({ path: f, type: 'png' });
      console.log(f);
    }
  }
  const errs = h.logs.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]'));
  if (errs.length) console.log('ERRORS:', errs.slice(0, 8).join('\n'));
} finally { await h.close(); }

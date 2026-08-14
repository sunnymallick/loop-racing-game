// Private probe: show ONLY the car meshes whose material pool matches a substring. Not shipped.
// Usage: node tools/_va_only.mjs <out.png> <city> <car> <poolSubstring> [az] [el] [dist]
import path from 'node:path';
import fs from 'node:fs/promises';
import { boot, open, load, ROOT } from './harness.mjs';

const out = path.resolve(ROOT, process.argv[2] || 'shots/_vaonly.png');
const city = process.argv[3] || 'nyc';
const car = process.argv[4] || 'supercar';
const match = process.argv[5] || 'wheelwell';
const AZ = Number(process.argv[6] ?? 35);
const EL = Number(process.argv[7] ?? 10);
const DM = Number(process.argv[8] ?? 1.25);

const h = await boot({ width: 1200, height: 760 });
await fs.mkdir(path.dirname(out), { recursive: true });
try {
  await open(h.page, h.url, { city, car });
  await load(h.page, { city, car });
  await h.page.evaluate(() => { const u = document.getElementById('ui'); if (u) u.style.display = 'none'; });
  await h.page.evaluate(() => window.__GAME.scenario('still', { u: 0.05 }));
  await h.page.evaluate((m) => {
    const g = window.__GAME.game;
    g.car.traverse((o) => {
      if (!o.isMesh) return;
      const k = o.material?.userData?.pool || o.material?.name || o.material?.type || '';
      o.visible = String(k).includes(m);
      if (o.visible && o.material.emissive) { o.material = o.material.clone(); o.material.emissive.setHex(0xff00ff); o.material.emissiveIntensity = 3; }
    });
  }, match);
  await h.page.evaluate(([az, el, dm]) => {
    const g = window.__GAME.game;
    const cam = g.engine.camera;
    const c = g.car;
    const d = c.userData.dims;
    const yaw = Math.atan2(g.body.forward.x, g.body.forward.z);
    const a = yaw + Math.PI + (az * Math.PI) / 180;
    const dist = Math.max(d.length, 4) * dm;
    const t = c.position.clone(); t.y += d.height * 0.5;
    const e = (el * Math.PI) / 180;
    cam.position.set(t.x + Math.sin(a) * dist * Math.cos(e), t.y + Math.sin(e) * dist, t.z + Math.cos(a) * dist * Math.cos(e));
    cam.lookAt(t); cam.fov = 40; cam.updateProjectionMatrix();
    window.__GAME.render();
  }, [AZ, EL, DM]);
  await h.page.screenshot({ path: out });
  console.log('ok', out);
} finally { await h.close(); }

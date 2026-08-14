// Private vehicle-art probe: hide one merged sub-mesh of the car at a time and screenshot, so a
// suspicious slab in a render can be traced back to the material that drew it. Not shipped code.
// Usage: node tools/_va_id.mjs <outdir> <city> <car> [az] [el] [dist]
import fs from 'node:fs/promises';
import path from 'node:path';
import { boot, open, load, ROOT } from './harness.mjs';

const out = path.resolve(ROOT, process.argv[2] || 'shots/_vaid');
const city = process.argv[3] || 'nyc';
const car = process.argv[4] || 'supercar';
const AZ = Number(process.argv[5] ?? 35);
const EL = Number(process.argv[6] ?? 10);
const DM = Number(process.argv[7] ?? 1.25);

const h = await boot({ width: 1200, height: 760 });
await fs.mkdir(out, { recursive: true });

const place = async () => h.page.evaluate(([az, el, dm]) => {
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

try {
  await open(h.page, h.url, { city, car });
  await load(h.page, { city, car });
  await h.page.evaluate(() => { const u = document.getElementById('ui'); if (u) u.style.display = 'none'; });
  await h.page.evaluate(() => window.__GAME.scenario('still', { u: 0.05 }));
  const list = await h.page.evaluate(() => {
    const g = window.__GAME.game;
    const rows = [];
    g.car.traverse((o) => {
      if (!o.isMesh) return;
      o.userData.__idx = rows.length;
      const m = o.material;
      rows.push({
        i: rows.length, name: o.name || o.type,
        pool: m?.userData?.pool || m?.name || m?.type,
        color: m?.color?.getHexString?.(), tris: (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3,
      });
    });
    window.__MESHES = rows.length;
    return rows;
  });
  await place();
  await h.page.screenshot({ path: path.join(out, 'all.png') });
  for (const r of list) {
    await h.page.evaluate((i) => {
      const g = window.__GAME.game;
      g.car.traverse((o) => { if (o.isMesh) o.visible = o.userData.__idx !== i; });
    }, r.i);
    await place();
    await h.page.screenshot({ path: path.join(out, `hide-${String(r.i).padStart(2, '0')}.png`) });
  }
  console.log(JSON.stringify(list, null, 1));
} finally { await h.close(); }

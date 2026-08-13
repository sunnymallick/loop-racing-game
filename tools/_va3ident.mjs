// Private probe: list the merged meshes of the built car with material + bounds, and render
// one screenshot per mesh with that mesh tinted magenta, to identify what is what.
import fs from 'node:fs/promises';
import path from 'node:path';
import { boot, open, load, ROOT } from './harness.mjs';

const car = process.argv[2] || 'supercar';
const out = path.resolve(ROOT, 'shots/_va3ident');
const h = await boot({ width: 1000, height: 640 });
await fs.mkdir(out, { recursive: true });
try {
  await open(h.page, h.url, { city: 'la', car });
  await h.page.evaluate(() => { const u = document.getElementById('ui'); if (u) u.style.display = 'none'; });
  await load(h.page, { city: 'la', car });
  await h.page.evaluate(() => window.__GAME.scenario('still', { u: 0.05 }));
  const list = await h.page.evaluate(() => {
    const g = window.__GAME.game;
    const out = [];
    g.car.getObjectByName('body').children.forEach((m, i) => {
      if (!m.isMesh) { out.push({ i, type: 'grp', name: m.name }); return; }
      m.geometry.computeBoundingBox();
      const b = m.geometry.boundingBox;
      out.push({
        i, name: m.name, mat: m.material.type,
        color: m.material.color?.getHexString(), map: !!m.material.map, side: m.material.side,
        tris: m.geometry.index ? m.geometry.index.count / 3 : m.geometry.attributes.position.count / 3,
        box: [b.min.toArray().map((v) => +v.toFixed(2)), b.max.toArray().map((v) => +v.toFixed(2))],
      });
    });
    return out;
  });
  console.log(JSON.stringify(list, null, 1));
  // side view
  await h.page.evaluate(() => {
    const g = window.__GAME.game;
    const cam = g.engine.camera;
    const d = g.car.userData.dims;
    const yaw = Math.atan2(g.body.forward.x, g.body.forward.z);
    const a = yaw + Math.PI + Math.PI / 2;
    const t = g.car.position.clone(); t.y += d.height * 0.5;
    const dist = d.length * 1.3;
    cam.position.set(t.x + Math.sin(a) * dist * 0.99, t.y + 0.1 * dist, t.z + Math.cos(a) * dist * 0.99);
    cam.fov = 34; cam.lookAt(t); cam.updateProjectionMatrix(); cam.updateMatrixWorld();
  });
  for (const m of list.filter((x) => x.tris)) {
    await h.page.evaluate((i) => {
      const g = window.__GAME.game;
      const kids = g.car.getObjectByName('body').children;
      kids.forEach((k, j) => { if (k.isMesh) k.visible = j === i; });
    }, m.i);
    await h.page.evaluate(() => window.__GAME.render());
    await h.page.screenshot({ path: path.join(out, `${car}-${m.i}.png`) });
  }
  console.log('wrote', out);
} finally { await h.close(); }

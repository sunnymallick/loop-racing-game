// Private probe: list the car's meshes with their material pool key. Not shipped code.
import { boot, open, load } from './harness.mjs';
const city = process.argv[2] || 'nyc';
const car = process.argv[3] || 'supercar';
const h = await boot({ width: 600, height: 400 });
try {
  await open(h.page, h.url, { city, car });
  await load(h.page, { city, car });
  const rows = await h.page.evaluate(() => {
    const g = window.__GAME.game;
    const out = [];
    g.car.traverse((o) => {
      if (!o.isMesh) return;
      const m = o.material;
      const b = o.geometry.boundingBox || (o.geometry.computeBoundingBox(), o.geometry.boundingBox);
      out.push(`${out.length}\t${o.name || o.type}\t${m?.userData?.pool || m?.name || m?.type}\t${m?.color?.getHexString?.() || ''}\tmap=${!!m?.map}\tside=${m?.side}\tbox=${b.min.toArray().map((v) => v.toFixed(2))}..${b.max.toArray().map((v) => v.toFixed(2))}`);
    });
    return out;
  });
  console.log(rows.join('\n'));
} finally { await h.close(); }

// Private probe: report the UV range of the arch-lip mesh and the texel it samples.
import { boot, open, load } from './harness.mjs';
const car = process.argv[2] || 'supercar';
const h = await boot({ width: 800, height: 500 });
try {
  await open(h.page, h.url, { city: 'la', car });
  await load(h.page, { city: 'la', car });
  const r = await h.page.evaluate(() => {
    const g = window.__GAME.game;
    const out = [];
    g.car.getObjectByName('body').children.forEach((m, i) => {
      if (!m.isMesh || !m.material.map) return;
      const uv = m.geometry.attributes.uv;
      let u0 = 9, u1 = -9, v0 = 9, v1 = -9;
      for (let k = 0; k < uv.count; k++) {
        u0 = Math.min(u0, uv.getX(k)); u1 = Math.max(u1, uv.getX(k));
        v0 = Math.min(v0, uv.getY(k)); v1 = Math.max(v1, uv.getY(k));
      }
      out.push({ i, tris: (m.geometry.index ? m.geometry.index.count : uv.count) / 3, u: [+u0.toFixed(3), +u1.toFixed(3)], v: [+v0.toFixed(3), +v1.toFixed(3)], side: m.material.side, img: m.material.map.image?.width });
    });
    const paint = g.car.userData.paintMaterial;
    const img = paint.map.image;
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const cx = c.getContext('2d'); cx.drawImage(img, 0, 0);
    const px = (u, v) => {
      const d = cx.getImageData(Math.round(u * (img.width - 1)), Math.round((1 - v) * (img.height - 1)), 1, 1).data;
      return `${d[0]},${d[1]},${d[2]}`;
    };
    return { meshes: out, anchors: paint.userData.livery.anchors.map((a) => +a.toFixed(3)), samples: [[0.08, 0.2, px(0.08, 0.2)], [0.14, 0.2, px(0.14, 0.2)], [0.2, 0.2, px(0.2, 0.2)], [0.5, 0.5, px(0.5, 0.5)], [0.13, 0.8, px(0.13, 0.8)]] };
  });
  console.log(JSON.stringify(r, null, 1));
} finally { await h.close(); }

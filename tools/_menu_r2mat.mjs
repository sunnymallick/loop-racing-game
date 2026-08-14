// MENU r2 probe: dump hero-car material state while the garage is open.
import { boot, open, scenario, errors } from './harness.mjs';

const h = await boot({ width: 1600, height: 900 });
try {
  await open(h.page, h.url, { city: 'la', car: 'muscle' });
  await scenario(h.page, 'menu');
  const info = await h.page.evaluate(() => {
    const g = window.__GAME.game;
    const car = g.menu?.heroCar || g.menu?.hero?.car || g.car;
    if (!car) return { err: 'no car', keys: Object.keys(g.menu || {}) };
    const rows = [];
    const seen = new Set();
    car.traverse((o) => {
      if (!o.isMesh && !o.isInstancedMesh) return;
      for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
        if (!m || seen.has(m.uuid)) continue;
        seen.add(m.uuid);
        const bb = o.geometry?.boundingBox || (o.geometry?.computeBoundingBox(), o.geometry?.boundingBox);
        const path = [];
        for (let p = o; p && p !== car; p = p.parent) path.push(p.name || p.type);
        rows.push({
          path: path.join('<'),
          bbox: bb ? [bb.min.toArray().map((v) => +v.toFixed(2)), bb.max.toArray().map((v) => +v.toFixed(2))] : null,
          tris: o.geometry?.index ? o.geometry.index.count / 3 : (o.geometry?.attributes?.position?.count ?? 0) / 3,
          name: o.name || o.parent?.name || '?',
          type: m.type,
          transparent: m.transparent,
          opacity: +(m.opacity ?? 1).toFixed(3),
          depthWrite: m.depthWrite,
          depthTest: m.depthTest,
          blending: m.blending,
          renderOrder: o.renderOrder,
          side: m.side,
          colorWrite: m.colorWrite,
          transmission: m.transmission,
          alphaTest: m.alphaTest,
          visible: o.visible,
          matName: m.name,
        });
      }
    });
    return {
      carName: car.name,
      carRenderOrder: car.renderOrder,
      count: rows.length,
      rows,
    };
  });
  console.log(JSON.stringify(info, null, 1));
  console.log('errors:', await errors(h.page));
} finally {
  await h.close();
}

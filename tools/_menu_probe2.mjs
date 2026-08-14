import { boot, open, scenario, errors } from './harness.mjs';
const h = await boot({ width: 1600, height: 900 });
try {
  await open(h.page, h.url, { city: 'la', car: 'muscle' });
  await scenario(h.page, 'menu');
  const out = await h.page.evaluate(() => {
    const g = window.__GAME.game;
    const cam = g.engine.camera;
    const res = [];
    g.car.traverse((o) => {
      const m = o.material;
      if (!m) return;
      const mats = Array.isArray(m) ? m : [m];
      for (const mm of mats) {
        const emissive = mm.emissive && mm.emissiveIntensity > 0.2 && (mm.emissive.r + mm.emissive.g + mm.emissive.b) > 0.05;
        const additive = mm.blending === 2;
        if (!emissive && !additive) continue;
        const p = new (o.position.constructor)();
        o.getWorldPosition(p);
        const s = p.clone().project(cam);
        res.push({
          name: o.name || o.type, add: additive, ei: mm.emissiveIntensity,
          col: (mm.emissive || mm.color) ? (mm.emissive || mm.color).getHexString() : '?',
          op: mm.opacity, vis: o.visible,
          px: Math.round((s.x * 0.5 + 0.5) * 1600), py: Math.round((-s.y * 0.5 + 0.5) * 900),
        });
      }
    });
    return res;
  });
  console.log(JSON.stringify(out, null, 1));
  console.log('errors:', await errors(h.page));
} finally { await h.close(); }

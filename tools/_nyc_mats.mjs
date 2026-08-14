// Builder probe (nyc): what materials actually made it into the city group? Not shipped code.
import { boot, open, load } from './harness.mjs';

const h = await boot({ width: 800, height: 450 });
try {
  await open(h.page, h.url, { city: 'nyc', car: 'muscle' });
  await load(h.page, { city: 'nyc', car: 'muscle' });
  const out = await h.page.evaluate(() => {
    const g = window.__GAME.game;
    const seen = new Map();
    g.city.group.traverse((o) => {
      if (!o.isMesh) return;
      const m = o.material;
      if (!m || Array.isArray(m)) return;
      const k = m.uuid;
      let e = seen.get(k);
      if (!e) {
        e = {
          type: m.type, name: m.name || '',
          map: m.map ? `${m.map.image?.width}x${m.map.image?.height}` : null,
          emi: m.emissiveIntensity, rough: m.roughness, metal: m.metalness,
          meshes: 0, inst: 0, tris: 0,
        };
        seen.set(k, e);
      }
      e.meshes++;
      if (o.isInstancedMesh) e.inst += o.count;
      const p = o.geometry.attributes.position;
      e.tris += (o.geometry.index ? o.geometry.index.count : p.count) / 3 * (o.isInstancedMesh ? o.count : 1);
    });
    return [...seen.values()].sort((a, b) => b.tris - a.tris);
  });
  for (const e of out) {
    console.log(`${String(e.meshes).padStart(4)} meshes ${String(e.inst).padStart(5)} inst ${String(Math.round(e.tris)).padStart(8)} tris  map=${e.map}  emi=${e.emi}  r=${e.rough} m=${e.metal}  ${e.type} ${e.name}`);
  }
} finally {
  await h.close();
}

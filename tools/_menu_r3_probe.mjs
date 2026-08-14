// MENU r3 probe: what is actually inside the cabin, and what the glass is doing to it.
import { boot, open, scenario, errors } from './harness.mjs';

const h = await boot({ width: 1600, height: 900 });
try {
  await open(h.page, h.url, { city: 'la', car: 'muscle' });
  await scenario(h.page, 'menu');
  const info = await h.page.evaluate(() => {
    const g = window.__GAME.game;
    const car = g.car;
    const out = { interior: null, glass: [], meshes: [] };
    car.updateMatrixWorld(true);
    car.traverse((o) => {
      if (o.name === 'interior') {
        const box = { min: [1e9, 1e9, 1e9], max: [-1e9, -1e9, -1e9] };
        o.traverse((c) => {
          if (!c.isMesh) return;
          const p = c.geometry.attributes.position;
          const e = c.matrixWorld.elements;
          for (let i = 0; i < p.count; i++) {
            const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
            const v = [
              e[0] * x + e[4] * y + e[8] * z + e[12],
              e[1] * x + e[5] * y + e[9] * z + e[13],
              e[2] * x + e[6] * y + e[10] * z + e[14],
            ];
            for (let k = 0; k < 3; k++) { box.min[k] = Math.min(box.min[k], v[k]); box.max[k] = Math.max(box.max[k], v[k]); }
          }
        });
        const mats = [];
        o.traverse((c) => {
          if (!c.isMesh) return;
          for (const m of (Array.isArray(c.material) ? c.material : [c.material])) {
            mats.push({
              name: m.name || '(none)', col: '#' + m.color.getHexString(),
              rough: m.roughness, metal: m.metalness,
              emis: '#' + (m.emissive ? m.emissive.getHexString() : '000'),
              env: m.envMapIntensity,
              tris: c.geometry.index ? c.geometry.index.count / 3 : c.geometry.attributes.position.count / 3,
            });
          }
        });
        out.interior = {
          min: box.min.map((v) => +v.toFixed(3)),
          max: box.max.map((v) => +v.toFixed(3)),
          mats,
        };
      }
      if (!o.isMesh) return;
      for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
        if (m && (m.name === 'glass' || (m.transparent && m.isMeshPhysicalMaterial))) {
          out.glass.push({
            mesh: o.name, name: m.name, op: m.opacity, dw: m.depthWrite,
            col: '#' + m.color.getHexString(), rough: m.roughness, metal: m.metalness,
            cc: m.clearcoat, ccr: m.clearcoatRoughness, env: m.envMapIntensity,
            base: m.userData.__envBase, side: m.side, transmission: m.transmission,
          });
        }
      }
    });
    return out;
  });
  console.log(JSON.stringify(info, null, 2));
  console.log('errors:', await errors(h.page));
} finally {
  await h.close();
}

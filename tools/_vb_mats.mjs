#!/usr/bin/env node
/** Dump the merged body's per-material meshes for one car. */
import { boot, open } from './harness.mjs';

const CAR = process.argv[2] || 'muscle';
const h = await boot({ gpu: false, width: 800, height: 450 });
try {
  await open(h.page, h.url, { city: 'la', car: CAR });
  const out = await h.page.evaluate(() => {
    const g = window.__GAME.game;
    const car = g.car;
    const rows = [];
    const walk = (root, tag) => root.traverse((o) => {
      if (!o.isMesh) return;
      const m = o.material;
      rows.push({
        tag, name: o.name || o.parent?.name || '',
        type: m.type, color: m.color?.getHexString(), rough: m.roughness, metal: m.metalness,
        cc: m.clearcoat, env: m.envMapIntensity, side: m.side, transp: m.transparent, op: m.opacity,
        map: !!m.map, emi: m.emissiveIntensity, tris: (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3,
      });
    });
    const body = car.getObjectByName('body');
    walk(body, 'body');
    const w = car.userData.wheels[0];
    walk(w, 'wheelFL');
    return { rows, buildMs: window.__BUILD_MS || null };
  });
  const fmt = (r) => `${r.tag.padEnd(8)} ${String(r.name).padEnd(12)} ${r.type.replace('Mesh', '').replace('Material', '').padEnd(10)} #${r.color} r${(r.rough ?? -1).toFixed(2)} m${(r.metal ?? -1).toFixed(2)} cc${r.cc ?? '-'} env${r.env ?? '-'} side${r.side} ${r.transp ? 'T' : ' '} map${r.map ? 1 : 0} emi${r.emi ?? '-'} tris${Math.round(r.tris)}`;
  console.log(out.rows.map(fmt).join('\n'));
  console.log('total meshes', out.rows.length);
} finally { await h.close(); }

#!/usr/bin/env node
/** How long does a full eight-car grid take to build? */
import { boot, open } from './harness.mjs';

const h = await boot({ gpu: false, width: 640, height: 360 });
try {
  await open(h.page, h.url, { city: 'la', car: 'muscle' });
  const out = await h.page.evaluate(async () => {
    const g = window.__GAME.game;
    const runs = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      g.startRace({ opponents: 7 });
      runs.push(+(performance.now() - t0).toFixed(0));
    }
    let meshes = 0, tris = 0;
    for (const c of [g.car, ...g.aiCars]) {
      c.traverse((o) => {
        if (!o.isMesh && !o.isInstancedMesh) return;
        meshes++;
        const gg = o.geometry;
        tris += ((gg.index ? gg.index.count : gg.attributes.position.count) / 3) * (o.isInstancedMesh ? o.count : 1);
      });
    }
    return { runs, meshes, tris: Math.round(tris), geometries: g.engine.renderer.info.memory.geometries, textures: g.engine.renderer.info.memory.textures };
  });
  console.log(JSON.stringify(out));
} finally { await h.close(); }

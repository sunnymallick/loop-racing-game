import { boot, open, load, scenario } from './harness.mjs';
const h = await boot({ gpu: true, width: 800, height: 450 });
try {
  await open(h.page, h.url, { city: 'la', car: 'muscle' });
  for (const city of ['la', 'vegas', 'nyc', 'miami']) {
    await load(h.page, { city, car: 'muscle' });
    await scenario(h.page, 'chase');
    const out = await h.page.evaluate(async () => {
      const THREE = await import('/node_modules/three/build/three.module.js');
      const g = window.__GAME.game;
      const cam = g.engine.camera;
      const rc = new THREE.Raycaster();
      rc.camera = cam; rc.near = 0.7; rc.far = 14;
      const from = g.body.pos.clone().setY(g.body.pos.y + 0.7);
      const dir = new THREE.Vector3();
      const N = 40;
      // warm
      for (let i = 0; i < 5; i++) {
        dir.set(Math.cos(i), 0.25, Math.sin(i)).normalize();
        rc.set(from, dir); rc.intersectObject(g.city.group, true);
      }
      const t0 = performance.now();
      for (let i = 0; i < N; i++) {
        dir.set(Math.cos(i * 0.7), 0.25, Math.sin(i * 0.7)).normalize();
        rc.set(from, dir); rc.intersectObject(g.city.group, true);
      }
      const t1 = performance.now();
      // and against the whole group with firstHitOnly semantics unavailable — measure meshes too
      let meshes = 0, tris = 0;
      g.city.group.traverse((o) => {
        if (!o.isMesh) return; meshes++;
        const p = o.geometry.attributes.position;
        tris += (o.geometry.index ? o.geometry.index.count : p.count) / 3;
      });
      return { msPerRay: +((t1 - t0) / N).toFixed(3), meshes, tris: Math.round(tris) };
    });
    console.log(city.padEnd(7), JSON.stringify(out));
  }
} finally { await h.close(); }

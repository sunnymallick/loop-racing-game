import { boot, open, load, scenario } from './harness.mjs';
const city = process.argv[2] || 'la';
const car = process.argv[3] || 'muscle';
const scen = process.argv[4] || 'drift';
const h = await boot({ width: 800, height: 450 });
try {
  await open(h.page, h.url, { city, car });
  await load(h.page, { city, car });
  await scenario(h.page, scen);
  const out = await h.page.evaluate(async () => {
    const THREE = await import('/node_modules/three/build/three.module.js');
    const g = window.__GAME.game;
    const cam = g.engine.camera;
    const b = g.body;
    const rc = new THREE.Raycaster();
    rc.camera = cam;
    rc.near = 0.01;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    rc.set(cam.position, fwd);
    rc.far = 300;
    const hits = [];
    for (const t of [g.city.group, ...(g.car ? [g.car] : [])]) {
      for (const hit of rc.intersectObject(t, true).slice(0, 6)) {
        const m = Array.isArray(hit.object.material) ? hit.object.material[0] : hit.object.material;
        hits.push({
          d: +hit.distance.toFixed(2),
          name: hit.object.name || '(unnamed)',
          parent: hit.object.parent?.name || '',
          color: m?.color ? m.color.getHexString() : null,
          transparent: !!m?.transparent, opacity: m?.opacity,
          side: m?.side, ud: JSON.stringify(hit.object.userData).slice(0, 120),
        });
      }
    }
    hits.sort((x, y) => x.d - y.d);
    const nc = g.city.track.nearest(cam.position);
    const ncCar = g.city.track.nearest(b.pos);
    return {
      cam: cam.position.toArray().map((v) => +v.toFixed(2)),
      carPos: b.pos.toArray().map((v) => +v.toFixed(2)),
      camNearest: { u: +nc.u.toFixed(3), lateral: +nc.lateral.toFixed(2) },
      carNearest: { u: +ncCar.u.toFixed(3), lateral: +ncCar.lateral.toFixed(2) },
      hits: hits.slice(0, 8),
    };
  });
  console.log(JSON.stringify(out, null, 1));
} finally { await h.close(); }

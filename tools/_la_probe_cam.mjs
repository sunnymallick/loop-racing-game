import { boot, open, load } from './harness.mjs';
const h = await boot({ width: 800, height: 450 });
try {
  await open(h.page, h.url, { city: 'la', car: 'supercar' });
  await load(h.page, { city: 'la', car: 'supercar' });
  const out = await h.page.evaluate(async () => {
    const G = window.__GAME;
    await G.scenario('chase');
    const g = G.game;
    const cam = g.engine.camera;
    let ridge = null, scrub = null;
    g.city.group.traverse((o) => {
      if (o.isMesh && o.geometry.attributes.color && o.geometry.attributes.color.count === 39431) ridge = o;
    });
    const t = g.city.track;
    return {
      cam: [cam.position.x | 0, cam.position.y | 0, cam.position.z | 0],
      ridgePos: ridge ? [ridge.position.x | 0, ridge.position.y | 0, ridge.position.z | 0] : null,
      distToRidgeOrigin: ridge ? Math.round(Math.hypot(cam.position.x - ridge.position.x, cam.position.z - ridge.position.z)) : null,
      fog: { near: g.city.fog.near, far: g.city.fog.far },
      trackLen: Math.round(t.length),
      landmarkU: g.city.landmarkU,
    };
  });
  console.log(JSON.stringify(out, null, 1));
} finally { await h.close(); }

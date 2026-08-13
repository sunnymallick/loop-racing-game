import { boot, open, scenario, load } from './harness.mjs';
const city = process.argv[2] || 'miami';
const h = await boot({ width: 640, height: 360 });
try {
  await open(h.page, h.url, { city, car: 'muscle' });
  await load(h.page, { city, car: 'muscle' });
  await scenario(h.page, 'landmark', {});
  const out = await h.page.evaluate(() => {
    const g = window.__GAME.game;
    const cam = g.engine.camera;
    cam.updateMatrixWorld(true);
    const e = cam.matrixWorld.elements;
    const cp = [e[12], e[13], e[14]];
    const fwd = [-e[8], -e[9], -e[10]];
    const lm = g.city.group.getObjectByName('landmarks');
    lm.updateMatrixWorld(true);
    const res = [];
    const walk = (o, depth) => {
      const m = o.matrixWorld.elements;
      const d = [m[12] - cp[0], m[13] - cp[1], m[14] - cp[2]];
      const dist = Math.hypot(d[0], d[1], d[2]);
      const dot = (d[0] * fwd[0] + d[1] * fwd[1] + d[2] * fwd[2]) / (dist || 1);
      res.push({
        n: o.name || o.type, depth, dist: +dist.toFixed(0),
        off: +((Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI).toFixed(0),
        kids: o.children.length,
      });
      if (depth < 1) for (const c of o.children) walk(c, depth + 1);
    };
    for (const c of lm.children) walk(c, 0);
    return { cp: cp.map((v) => +v.toFixed(0)), fov: cam.fov, res };
  });
  console.log(JSON.stringify(out));
} finally { await h.close(); }

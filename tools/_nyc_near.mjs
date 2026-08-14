// Builder probe (nyc): what geometry is sitting on top of the chase camera? Not shipped code.
import { boot, open, load } from './harness.mjs';

const h = await boot({ width: 1600, height: 900 });
try {
  await open(h.page, h.url, { city: 'nyc', car: 'supercar' });
  await load(h.page, { city: 'nyc', car: 'supercar' });
  const out = await h.page.evaluate(async () => {
    await window.__GAME.scenario('chase', {});
    const g = window.__GAME.game;
    const cam = g.engine.camera;
    const cp = cam.position;
    const t = g.city.track;
    const nc = t.nearest(cp);
    const hits = [];
    const v = new cam.position.constructor();
    g.city.group.traverse((o) => {
      if (!o.isMesh) return;
      if (o.isInstancedMesh) {
        const m = o.instanceMatrix.array;
        for (let i = 0; i < o.count; i++) {
          const x = m[i * 16 + 12], y = m[i * 16 + 13], z = m[i * 16 + 14];
          const d = Math.hypot(x - cp.x, y - cp.y, z - cp.z);
          if (d < 10) hits.push({ kind: 'inst', d: +d.toFixed(2), x: +x.toFixed(1), z: +z.toFixed(1), mat: o.material.name || o.material.type, n: o.count });
        }
      } else {
        o.updateWorldMatrix(true, false);
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
        const bb = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
        const dx = Math.max(bb.min.x - cp.x, 0, cp.x - bb.max.x);
        const dy = Math.max(bb.min.y - cp.y, 0, cp.y - bb.max.y);
        const dz = Math.max(bb.min.z - cp.z, 0, cp.z - bb.max.z);
        const d = Math.hypot(dx, dy, dz);
        if (d < 8) {
          hits.push({ kind: 'mesh', d: +d.toFixed(2), mat: o.material.name || o.material.type,
            size: [+(bb.max.x - bb.min.x).toFixed(1), +(bb.max.y - bb.min.y).toFixed(1), +(bb.max.z - bb.min.z).toFixed(1)],
            ctr: [+((bb.max.x + bb.min.x) / 2).toFixed(1), +((bb.max.y + bb.min.y) / 2).toFixed(1), +((bb.max.z + bb.min.z) / 2).toFixed(1)],
            par: o.parent?.name || '' });
        }
      }
    });
    hits.sort((a, b) => a.d - b.d);
    return {
      cam: { x: +cp.x.toFixed(2), y: +cp.y.toFixed(2), z: +cp.z.toFixed(2) },
      camLatM: +(nc.lateral * t.halfWidth).toFixed(2), camU: +nc.u.toFixed(3),
      body: { x: +g.body.pos.x.toFixed(2), z: +g.body.pos.z.toFixed(2) },
      hits: hits.slice(0, 14),
      opp: (g.race?.cars || []).map((c) => (c.obj ? { x: +c.obj.position.x.toFixed(1), z: +c.obj.position.z.toFixed(1) } : null)).slice(0, 8),
    };
  });
  console.log(JSON.stringify(out, null, 1));
} finally {
  await h.close();
}

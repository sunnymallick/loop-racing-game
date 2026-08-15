/**
 * What is at the lens IN THE CAPTURED FRAME? Runs exactly what `shot.mjs --shots chase` runs and
 * then reports, for every opponent and for the player, the distance from the camera to the car's
 * real world-space bounding box — plus how much of that box is inside the near plane.
 *
 *   node tools/_race_camframe.mjs --city miami --car muscle
 */
import { boot, open, load } from './harness.mjs';
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i === -1 ? d : argv[i + 1]; };
const CITY = String(arg('city', 'miami'));
const CAR = String(arg('car', 'muscle'));

const h = await boot({ width: 1600, height: 900 });
try {
  await open(h.page, h.url, { city: CITY, car: CAR });
  await load(h.page, { city: CITY, car: CAR });
  const out = await h.page.evaluate(async () => {
    const G = window.__GAME.game;
    await window.__GAME.scenario('chase');
    const cam = G.engine.camera;
    const rows = [];
    // LOCAL box of the car's own bodywork — the nitrous plume is a child of the car group and is
    // both huge and transparent, so it has to come out or every measurement is nonsense.
    const localBox = (root, skip) => {
      root.updateMatrixWorld(true);
      const inv = root.matrixWorld.clone().invert();
      let mnx = 1e9, mxx = -1e9, mny = 1e9, mxy = -1e9, mnz = 1e9, mxz = -1e9;
      root.traverse((o) => {
        if (!o.isMesh || !o.geometry) return;
        for (let a = o; a; a = a.parent) if (a === skip) return;
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
        const bb = o.geometry.boundingBox;
        const m = o.matrixWorld.clone().premultiply(inv).elements;
        for (let i = 0; i < 8; i++) {
          const x = (i & 1) ? bb.max.x : bb.min.x;
          const y = (i & 2) ? bb.max.y : bb.min.y;
          const z = (i & 4) ? bb.max.z : bb.min.z;
          const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
          const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
          const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
          mnx = Math.min(mnx, wx); mxx = Math.max(mxx, wx);
          mny = Math.min(mny, wy); mxy = Math.max(mxy, wy);
          mnz = Math.min(mnz, wz); mxz = Math.max(mxz, wz);
        }
      });
      return { mnx, mxx, mny, mxy, mnz, mxz };
    };
    // exact distance from the camera to that box under the car's own world transform
    const obbGap = (root, lb) => {
      const inv = root.matrixWorld.clone().invert();
      const p = cam.position.clone().applyMatrix4(inv);
      const ex = Math.max(0, Math.max(lb.mnx - p.x, p.x - lb.mxx));
      const ey = Math.max(0, Math.max(lb.mny - p.y, p.y - lb.mxy));
      const ez = Math.max(0, Math.max(lb.mnz - p.z, p.z - lb.mxz));
      return Math.hypot(ex, ey, ez);
    };
    for (let i = 0; i < G.aiCars.length; i++) {
      const d = G.race.drivers[i];
      const car = G.aiCars[i];
      const b = localBox(car, d.jet?.group);
      rows.push({
        who: `${d.name}/${d.vehicleId}`, gapAABB: +obbGap(car, b).toFixed(3),
        origin: +Math.hypot(d.body.pos.x - cam.position.x, d.body.pos.y - cam.position.y, d.body.pos.z - cam.position.z).toFixed(2),
        hull: d.hull ? `${d.hull.hl.toFixed(2)}/${d.hull.hw.toFixed(2)}/${d.hull.top.toFixed(2)}` : 'none',
        pushes: d.lensPushes || 0, vis: car.visible,
        top: +(b.mxy).toFixed(2), len: +(b.mxz - b.mnz).toFixed(2), wid: +(b.mxx - b.mnx).toFixed(2),
      });
    }
    const pb = localBox(G.car, G.jet?.group);
    rows.push({ who: 'PLAYER', gapAABB: +obbGap(G.car, pb).toFixed(3), origin: +G.body.pos.distanceTo(cam.position).toFixed(2), hull: '-', pushes: 0, top: +pb.mxy.toFixed(2) });
    rows.sort((a, b2) => a.gapAABB - b2.gapAABB);
    return { rows, cam: [+cam.position.x.toFixed(2), +cam.position.y.toFixed(2), +cam.position.z.toFixed(2)], near: cam.near, mph: Math.round(G.body.speedMph) };
  });
  console.log(`${CITY}/${CAR}  camera y=${out.cam[1]}  near=${out.near}  ${out.mph} mph`);
  for (const r of out.rows) {
    console.log(`  ${String(r.who).padEnd(18)} gapToAABB=${String(r.gapAABB).padStart(7)} m  originDist=${String(r.origin).padStart(6)}  roofY=${String(r.top).padStart(5)}  LxW=${r.len}x${r.wid}  hull=${r.hull}  pushes=${r.pushes} visible=${r.vis}${r.gapAABB < out.near ? '   *** INSIDE NEAR PLANE ***' : ''}`);
  }
} finally { await h.close(); }

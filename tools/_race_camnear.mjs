/**
 * BUG 5 PROBE — how close does an opponent's bodywork get to the chase camera?
 *
 * The near clip plane is 0.30 m (engine.js). Anything whose surface comes inside that gets sliced
 * open on screen. This drives the chase scenario in every city/car and reports the closest
 * approach of any opponent's oriented box to the camera, plus how many frames were inside the
 * near plane and inside a 1 m "you can see the interior" margin.
 *
 *   node tools/_race_camnear.mjs [--cities la,vegas,miami,nyc] [--cars tuner,muscle,suv,supercar]
 */
import { boot, open, load } from './harness.mjs';
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i === -1 ? d : argv[i + 1]; };
const CITIES = String(arg('cities', 'la,vegas,miami,nyc')).split(',');
const CARS = String(arg('cars', 'tuner,muscle,suv,supercar')).split(',');
const FRAMES = +arg('frames', 900);
const ABLATE = JSON.parse(String(arg('ablate', '{}')));

const h = await boot({ width: 640, height: 360 });
try {
  await open(h.page, h.url, { city: CITIES[0], car: CARS[0] });
  let worst = { d: 1e9 };
  for (const city of CITIES) {
    for (const car of CARS) {
      await load(h.page, { city, car });
      const out = await h.page.evaluate(async ([frames, ablate]) => {
        const M = await import('/src/race/race.js');
        Object.assign(M.AI_TUNE, { lens: 1 }, ablate);
        const G = window.__GAME.game;
        const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
        await window.__GAME.scenario('chase');
        const cam = G.engine.camera;
        let min = 1e9, minName = null, nNear = 0, nTight = 0, minInfo = null, dirMin = 1e9, nDirTight = 0;
        const p = G.body.pos.clone();
        const t = G.city.track;
        for (let i = 0; i < frames; i++) {
          const near = t.nearest(G.body.pos, G.race?.playerU ?? null);
          const aim = t.at(near.u + Math.min(0.03, 0.004 + Math.abs(G.body.speed) * 0.00042));
          const to = aim.pos.clone().sub(G.body.pos);
          const f = G.body.forward;
          const ang = Math.atan2(f.x * to.z - f.z * to.x, f.x * to.x + f.z * to.z);
          const v = G.body.speed; const target = G.body.p.topSpeed * 0.92;
          G.input.setScripted({
            steer: clamp(-ang * 2.2 - near.lateral * 0.3, -1, 1),
            throttle: v < target ? 1 : 0,
            brake: v > target * 1.04 ? clamp((v - target) * 0.2, 0, 1) : 0,
            nitro: false, handbrake: false,
          });
          G.update(1 / 60);
          let frameMin = 1e9;
          for (const d of G.race.drivers) {
            const b = d.body;
            const dims = d.car?.userData?.dims || d.dims;
            // the REAL hull the director measures against (see Race.attachCars) — the blueprint
            // dims are the design envelope and the bodywork sticks out of them
            const hl = d.hull ? d.hull.hl : (dims.length ?? 4.6) * 0.5;
            const hw = d.hull ? d.hull.hw : (dims.width ?? 2.0) * 0.5;
            const hh = (d.hull ? d.hull.top : 1.5) * 0.5;
            p.copy(cam.position).sub(b.pos);
            // into the car's own frame (+Z forward, +X right, +Y up)
            const lx = p.dot(b.right), lz = p.dot(b.forward), ly = p.y;
            const ex = Math.max(0, Math.abs(lx) - hw);
            const ez = Math.max(0, Math.abs(lz) - hl);
            const ey = Math.max(0, Math.abs(ly - hh) - hh);
            const dist = Math.hypot(ex, ey, ez);
            if (dist < frameMin) frameMin = dist;
            if (dist < min) { min = dist; minName = `${d.name}/${d.vehicleId}`; minInfo = { i, lx: +lx.toFixed(2), lz: +lz.toFixed(2), ly: +ly.toFixed(2), ex: +ex.toFixed(2), ey: +ey.toFixed(2), ez: +ez.toFixed(2), camY: +cam.position.y.toFixed(2), carY: +b.pos.y.toFixed(2), flame: +(G.nitro?.flame ?? 0).toFixed(2), hl: +hl.toFixed(2), hw: +hw.toFixed(2) }; }
          }
          // recompute with race.js's own model to check the director agrees with the probe
          {
            const camp = G.race._camPos;
            for (const d of G.race.drivers) {
              const b = d.body; const dm = d.car?.userData?.dims || d.dims;
              const hl2 = (dm.length ?? 4.6) * 0.5, hw2 = (dm.width ?? 2.0) * 0.5, rf = dm.height ?? 1.55;
              const qx = camp.x - b.pos.x, qy = camp.y - b.pos.y, qz = camp.z - b.pos.z;
              const lz2 = qx * b.forward.x + qz * b.forward.z, lx2 = qx * b.right.x + qz * b.right.z;
              const g = Math.hypot(Math.max(0, Math.abs(lx2) - hw2), Math.max(0, Math.abs(qy - rf * 0.5) - rf * 0.5), Math.max(0, Math.abs(lz2) - hl2));
              if (g < dirMin) dirMin = g;
              if (g < 1.25) nDirTight++;
            }
          }
          if (frameMin < 0.30) nNear++;
          if (frameMin < 1.0) nTight++;
        }
        return { min: +min.toFixed(3), minName, nNear, nTight, frames,
          pushes: G.race.drivers.reduce((a, d) => a + (d.lensPushes || 0), 0),
          hasCam: !!G.race._camPos, minInfo, dirMin: +dirMin.toFixed(3), nDirTight, clear: (await import('/src/race/race.js')).LENS_CLEAR ?? null };
      }, [FRAMES, ABLATE]);
      const flag = out.min < 0.30 ? '  *** CLIPPED ***' : (out.min < 1.0 ? '  (tight)' : '');
      console.log(`${city.padEnd(7)}${car.padEnd(10)} closest bodywork→camera ${String(out.min).padStart(7)} m  by ${String(out.minName).padEnd(16)} framesInsideNear=${out.nNear} framesUnder1m=${out.nTight} pushes=${out.pushes} dirMin=${out.dirMin} dirTight=${out.nDirTight}${flag}`);
      if (out.minInfo) console.log('      ', JSON.stringify(out.minInfo));
      if (out.min < worst.d) worst = { d: out.min, city, car, who: out.minName };
    }
  }
  console.log(`\nWORST: ${worst.d} m — ${worst.city}/${worst.car} (${worst.who})   near plane = 0.30 m`);
} finally { await h.close(); }

#!/usr/bin/env node
/**
 * FREE-SPACE drift/recovery rig: no track, no walls, no surface variation. Isolates the tyre model.
 *   accelerate → handbrake flick → counter-steer hold → hands-off straight (throttle 0.6, steer 0)
 */
import { VehicleBody } from '../src/vehicles/physics.js';
import { getHandling } from '../src/vehicles/handling.js';
import { getAudioProfile } from '../src/vehicles/audio_tuning.js';
import { getNitro } from '../src/vehicles/nitrous.js';

const DT = 1 / 60, R2D = 57.29578, D2R = 1 / R2D;
const IDS = process.env.CARS ? process.env.CARS.split(',') : ['tuner', 'muscle', 'suv', 'supercar'];
const WB = { tuner: 2.55, muscle: 2.95, suv: 3.05, supercar: 2.68 };
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const smoothstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };

function mk(id) {
  const spec = { physics: getHandling(id), audio: getAudioProfile(id), nitro: getNitro(id) };
  return new VehicleBody(spec, { wheelbase: WB[id] });
}
function go(b, n, inp, log) {
  for (let i = 0; i < n; i++) {
    b.step(DT, typeof inp === 'function' ? inp(b, i) : inp, { surfaceGrip: 1, groundY: 0 });
    if (log) {
      const p = b.p;
      const lead = b.slip + (b.aLat / Math.max(9, Math.abs(b.speed)) - b.yawRate) * p.escLead;
      const esc = smoothstep(b.slipAllow, b.slipAllow + 0.23, Math.abs(lead));
      const driftW = smoothstep(0.14, 0.34, Math.abs(b.slip));
      log.push({
        slip: +(b.slip * R2D).toFixed(2), allow: +(b.slipAllow * R2D).toFixed(1),
        esc: +esc.toFixed(3), holdW: +(driftW * clamp(1 - esc * 2.6, 0, 1)).toFixed(3),
        commit: +b.commit.toFixed(3), rear: +b.rearGrip.toFixed(3),
        rSlide: +b.rearSlide.toFixed(3), rBey: +b.rearBeyond.toFixed(3),
        yawR: +b.yawRate.toFixed(3), mph: +b.speedMph.toFixed(0),
        gLat: +(b.aLat / 9.81).toFixed(2), front: +(b.steerVisual * R2D).toFixed(2),
      });
    }
  }
}

for (const id of IDS) {
  const b = mk(id);
  const p = getHandling(id);
  b.reset({ x: 0, y: 0, z: 0, clone: () => ({ x: 0, y: 0, z: 0 }) }, 0);
  b.pos.set(0, 0, 0);
  // spin up to ~45 m/s
  go(b, 400, (bb) => ({ throttle: bb.speed < 45 ? 1 : 0.4 }));
  const flick = [];
  let fl = 0;
  const commitA = p.slipMax * 0.45 * D2R;
  while (fl < 36 && Math.abs(b.slip) < commitA) { go(b, 1, { throttle: 0.30, steer: 1, handbrake: true }, flick); fl++; }
  const hold = [];
  go(b, 52, { throttle: 0.85, steer: -0.52 }, hold);
  go(b, 30, { throttle: 0.72, steer: -0.72 }, hold);
  go(b, 20, { throttle: 0.95, steer: -0.62 }, hold);
  const all = flick.concat(hold);
  const peak = Math.max(...all.map((r) => Math.abs(r.slip)));
  const rec = [];
  go(b, 300, { throttle: 0.6, steer: 0 }, rec);
  const at90 = Math.abs(rec[89].slip), at300 = Math.abs(rec[299].slip);
  console.log(`\n══ ${id.toUpperCase()}  flick ${fl}f  peak ${peak.toFixed(1)}°  capEnd ${Math.abs(all[all.length-1].slip).toFixed(1)}°  after1.5s ${at90.toFixed(1)}°  after5s ${at300.toFixed(1)}°  ${at90 < 12 ? 'OK' : 'LATCH'}`);
  const keys = ['slip', 'allow', 'esc', 'holdW', 'commit', 'rear', 'rSlide', 'rBey', 'yawR', 'mph', 'gLat', 'front'];
  console.log('   f  ' + keys.map((k) => k.padStart(7)).join(''));
  rec.forEach((r, i) => {
    if (i % 15 !== 0 && i !== rec.length - 1) return;
    console.log(String(i).padStart(4) + '  ' + keys.map((k) => String(r[k]).padStart(7)).join(''));
  });
}

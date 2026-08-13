#!/usr/bin/env node
/**
 * Offline drift rig for the handling piece. Runs the REAL VehicleBody against the REAL LA track
 * spline plus main.js's surface/wall rules, with no browser, so a tuning pass takes 300 ms
 * instead of two minutes. Verification still happens in tools/shot.mjs — this only finds numbers.
 *
 *   node tools/_drift_sim.mjs [--u 0.12] [--car muscle]
 */
import * as THREE from 'three';
import { VehicleBody } from '../src/vehicles/physics.js';
import { getHandling } from '../src/vehicles/handling.js';
import { getAudioProfile } from '../src/vehicles/audio_tuning.js';
import { getNitro } from '../src/vehicles/nitrous.js';
import { Track } from '../src/cities/track.js';

const DT = 1 / 60;
const MPH = 2.23694;
const IDS = ['tuner', 'muscle', 'suv', 'supercar'];
const WB = { tuner: 2.55, muscle: 2.95, suv: 3.05, supercar: 2.68 };

// LA main loop (src/cities/losangeles.js def.track) — copied so this rig needs no WebGL.
const LA = {
  width: 10.5, bank: 0.06,
  main: [
    [0, 0], [140, -18], [270, -70], [350, -170], [355, -290], [300, -380],
    [190, -430], [60, -430], [-70, -400], [-170, -330], [-230, -230],
    [-250, -120], [-200, -30], [-100, 20], [0, 0],
  ],
};
const track = new Track(LA);

function mk(id) {
  const spec = { physics: getHandling(id), audio: getAudioProfile(id), nitro: getNitro(id) };
  return new VehicleBody(spec, { wheelbase: WB[id] });
}

/** One frame of main.js's world rules: surface grip, wall clamp + impact. */
function world(b, u) {
  const near = track.nearest(b.pos, u);
  const absLat = Math.abs(near.lateral);
  b.surface = absLat > 1.02 ? 'dirt' : 'road';
  const surfaceGrip = absLat > 1.02 ? 1.0 - 0.42 * Math.min(1, (absLat - 1.02) / 0.48) : 1.0;
  return { near, absLat, surfaceGrip };
}

function wall(b, near, lateral) {
  const wallAt = 1.52;
  if (Math.abs(lateral) <= wallAt) return 0;
  const s = near.sample;
  const inward = s.right.clone().multiplyScalar(-Math.sign(lateral));
  const wp = s.pos.clone().addScaledVector(s.right, Math.sign(lateral) * track.halfWidth * wallAt);
  b.pos.x = wp.x; b.pos.z = wp.z;
  return b.impact(inward, 0.28, 0.62);
}

/** Follow the racing line at a target speed — stands in for the driver on the approach. */
function autopilot(b, u, targetSpeed, offset = 0) {
  const look = Math.min(0.03, 0.004 + Math.abs(b.speed) * 0.00042);
  const aim = track.at(u + look);
  const to = aim.pos.clone().addScaledVector(aim.right, offset * track.halfWidth).sub(b.pos);
  const f = b.forward;
  const ang = Math.atan2(f.x * to.z - f.z * to.x, f.x * to.x + f.z * to.z);
  return {
    steer: Math.max(-1, Math.min(1, -ang * 2.2)),
    throttle: b.speed < targetSpeed ? 1 : 0,
    brake: b.speed > targetSpeed * 1.06 ? Math.min(1, (b.speed - targetSpeed) * 0.22) : 0,
  };
}

function drive(b, n, fn, log) {
  for (let i = 0; i < n; i++) {
    const u = ((track.nearest(b.pos, b._u ?? null).u % 1) + 1) % 1;
    b._u = u;
    const w = world(b, u);
    const inp = fn(b, u, i, w);
    b.step(DT, inp, { surfaceGrip: w.surfaceGrip, groundY: 0 });
    const hit = wall(b, w.near, w.absLat);
    if (log) log.push({
      t: +(log.length * DT).toFixed(2), mph: +b.speedMph.toFixed(0),
      slip: +(b.slip * 57.29578).toFixed(1), lat: +w.near.lateral.toFixed(2),
      roll: +(b.roll * 57.29578).toFixed(1), pitch: +(b.pitch * 57.29578).toFixed(1),
      drift: +b.drift.toFixed(2), gLat: +(b.aLat / 9.81).toFixed(2),
      counter: +(b.assist * 57.29578).toFixed(1), rear: +b.rearGrip.toFixed(2),
      surf: b.surface, hit: +hit.toFixed(2), yaw: +b.yawRate.toFixed(2),
      roadRate: +(track.turnRate(u) * b.groundSpeed / (track.length / (2*Math.PI)) * 0 + (track.turnRate(u))).toFixed(4), u: +u.toFixed(4),
    });
  }
}

/** Sign of the corner the car is entering: +1 = the road turns right. */
function cornerDir(u) {
  let best = 0;
  for (let k = 0.008; k <= 0.055; k += 0.006) {
    const c = track.curvature(u + k);
    if (Math.abs(c) > Math.abs(best)) best = c;
  }
  return best < 0 ? 1 : -1;
}

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i === -1 ? d : argv[i + 1]; };
const U0 = Number(arg('u', 0.06));
const ENTRY = Number(arg('entry', -0.45));
const VCAP = Number(arg('vcap', 52));
const APP = Number(arg('app', -0.5));

console.log(`LA track: length ${track.length.toFixed(0)}m  halfWidth ${track.halfWidth}`);

for (const id of IDS) {
  const b = mk(id);
  const p = getHandling(id);
  // ---- same corner search as main.js scenario('drift') ----
  const win = 120 / track.length;
  const wantR = Math.max(60, Math.min(400, 45 * 45 / p.driftG));
  let entryU = U0, radius = 1e6, turnSum = 0, bestScore = Infinity;
  for (let k = 0; k < 0.6; k += 0.004) {
    let c = 0, n = 0, sgn = 0;
    for (let j = 0; j < win; j += win / 12) { const tr = track.turnRate(U0 + k + j); c += Math.abs(tr); sgn += tr; n++; }
    const r = n / Math.max(1e-6, c);
    const score = Math.abs(Math.log(r / wantR));
    if (score < bestScore) { bestScore = score; radius = r; entryU = U0 + k; turnSum = sgn; }
  }
  const apex = entryU;
  const dir = turnSum < 0 ? 1 : -1;
  const vT = Math.max(30, Math.min(VCAP, Math.sqrt(radius * p.driftG)));
  const lock = 1;
  const startU = entryU - 330 / track.length;
  const s = track.at(startU);
  b.reset(s.pos.clone().addScaledVector(s.right, ENTRY * dir * track.halfWidth), Math.atan2(s.tan.x, s.tan.z));
  b._u = ((startU % 1) + 1) % 1;
  { let n=0; while (n < 460) { const uu=((track.nearest(b.pos,b._u).u%1)+1)%1; if (((entryU % 1) + 1 - uu) % 1 < 30/track.length) break; drive(b,1,(bb,u)=>autopilot(bb,u,vT,APP*dir)); n++; } }
  const entryMph = b.speedMph, entryLat = Math.abs(track.nearest(b.pos, b._u).lateral);

  const log = [];
  let fl = 0;
  const commit = p.slipMax * 0.45 / 57.3;
  while (fl < 36 && Math.abs(b.slip) < commit) { drive(b, 1, () => ({ throttle: 0.30, steer: dir, handbrake: true }), log); fl++; }
  const holdIn = (n, th, st) => drive(b, n, (bb, u) => {
    const lat = track.nearest(bb.pos, u).lateral;
    const off = Math.sign(lat) * Math.max(0, Math.abs(lat) - 0.70);
    return { throttle: th, steer: Math.max(-1, Math.min(1, st + Math.max(-0.24, Math.min(0.24, -off * 1.30)))) };
  }, log);
  holdIn(96, 0.85, -0.55 * dir);
  holdIn(48, 0.72, -0.70 * dir);
  holdIn(36, 0.95, -0.45 * dir);
  const hold = log.slice(fl);
  const slips = hold.map((r) => Math.abs(r.slip));
  const off = hold.filter((r) => r.surf !== 'road').length;
  const hits = log.filter((r) => r.hit > 0.02).length;
  const rec = [];
  drive(b, 70, () => ({ throttle: 0.3, steer: 0 }), rec);
  drive(b, 80, () => ({ throttle: 1 }), rec);

  console.log(`\n── ${id.toUpperCase()}  corner R=${radius.toFixed(0)}m ${dir > 0 ? 'right' : 'left'} apex u=${apex.toFixed(3)}  entry ${entryMph.toFixed(0)} mph lat ${entryLat.toFixed(2)}  flick ${fl}f`);
  console.log(`   slip  min ${Math.min(...slips).toFixed(0)}°  max ${Math.max(...slips).toFixed(0)}°  final ${Math.abs(log[log.length-1].slip).toFixed(0)}°   ON ROAD ${((1 - off / hold.length) * 100).toFixed(0)}%  maxLat ${Math.max(...hold.map(r=>Math.abs(r.lat))).toFixed(2)}  wall hits ${hits}`);
  const on = hold.filter((r) => r.surf === 'road');
  const mg = on.length ? on.reduce((s,r)=>s+Math.abs(r.gLat),0)/on.length*9.81 : 0;
  console.log(`   measured drift accel ${mg.toFixed(1)} m/s²  (driftG in table: ${p.driftG})`);
  console.log(`   speed ${log[0].mph} → ${log[log.length-1].mph} mph   roll ${Math.max(...log.map(r=>Math.abs(r.roll))).toFixed(1)}°  drift ${Math.max(...log.map(r=>r.drift)).toFixed(2)}`);
  console.log(`   recovery: slip ${Math.abs(rec[rec.length-1].slip).toFixed(1)}°  lat ${rec[rec.length-1].lat.toFixed(2)}  ${rec[rec.length-1].mph} mph  surf ${rec[rec.length-1].surf}`);
  console.log('   t/slip/lat/mph/gLat/yaw/rear/counter: ' + log.filter((_, i) => i % 10 === 0)
    .map((r) => `${r.t} ${r.slip}| ${r.lat} ${r.mph} g${r.gLat} y${r.yaw} r${r.rear} c${r.counter}`).join('  '));
}

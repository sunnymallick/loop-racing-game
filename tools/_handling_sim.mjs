#!/usr/bin/env node
/**
 * Offline tuning rig for the handling piece. Runs the REAL VehicleBody with the same fixed
 * timestep and the same scripted inputs as the shot/functest scenarios, but with no browser, so
 * a tuning pass takes 200 ms instead of two minutes. Verification still happens in the harness —
 * this is only for finding the numbers.
 *
 *   node tools/_handling_sim.mjs
 */
import * as THREE from 'three';
import { VehicleBody } from '../src/vehicles/physics.js';
import { getHandling } from '../src/vehicles/handling.js';
import { getAudioProfile } from '../src/vehicles/audio_tuning.js';
import { getNitro } from '../src/vehicles/nitrous.js';

const DT = 1 / 60;
const IDS = ['tuner', 'muscle', 'suv', 'supercar'];
const WB = { tuner: 2.55, muscle: 2.95, suv: 3.05, supercar: 2.68 };
const MPH = 2.23694;

function mk(id) {
  const spec = { physics: getHandling(id), audio: getAudioProfile(id), nitro: getNitro(id) };
  const b = new VehicleBody(spec, { wheelbase: WB[id] });
  b.reset(new THREE.Vector3(0, 0, 0), 0);
  return b;
}

function run(b, n, input, env = {}, trace = null) {
  for (let i = 0; i < n; i++) {
    b.step(DT, { throttle: 0, brake: 0, steer: 0, handbrake: false, ...input }, env);
    if (trace && i % 6 === 0) trace.push(b.telemetry());
  }
  return b;
}

const rows = [];
for (const id of IDS) {
  // ---- chase: 240 frames flat out from a standstill (tools/shot.mjs 'chase') ----
  const b = mk(id);
  const tr = [];
  let t60 = null, t100 = null, t150 = null;
  for (let i = 0; i < 240; i++) {
    b.step(DT, { throttle: 1, brake: 0, steer: 0, handbrake: false }, {});
    if (t60 === null && b.speedMph >= 60) t60 = (i + 1) * DT;
    if (t100 === null && b.speedMph >= 100) t100 = (i + 1) * DT;
    if (t150 === null && b.speedMph >= 150) t150 = (i + 1) * DT;
    if (i % 12 === 0) tr.push(+b.speedMph.toFixed(0));
  }
  const chaseTop = b.speedMph;

  // ---- long pull to confirm the true class ceiling ----
  const bl = mk(id);
  run(bl, 900, { throttle: 1 });
  const ceiling = bl.speedMph;

  // ---- braking 100 -> 0 ----
  const bb = mk(id);
  run(bb, 400, { throttle: 1 });
  const vBrake = bb.speed;
  let brakeFrames = 0;
  while (bb.speed > 0.5 && brakeFrames < 900) { bb.step(DT, { brake: 1 }, {}); brakeFrames++; }

  // ---- drift: tools/shot.mjs 'drift' — 170 throttle, 46 handbrake+steer, 30 steer-in ----
  const bd = mk(id);
  const dtr = [];
  run(bd, 170, { throttle: 1 }, {}, dtr);
  const preDrift = bd.speedMph;
  run(bd, 46, { throttle: 1, steer: 1, handbrake: true }, {}, dtr);
  run(bd, 30, { throttle: 1, steer: 0.55 }, {}, dtr);
  const endSlip = bd.slip * 180 / Math.PI;
  const peakSlip = Math.max(...dtr.map((r) => Math.abs(r.slipDeg)), Math.abs(endSlip));
  const peakRoll = Math.max(...dtr.map((r) => Math.abs(r.rollDeg)));

  // ---- long held slide: initiate then hold with a steady counter-steer for 3 s ----
  const bh = mk(id);
  run(bh, 200, { throttle: 1 });
  run(bh, 30, { throttle: 1, steer: 1, handbrake: true });
  const hold = [];
  run(bh, 180, { throttle: 0.9, steer: -0.45 }, {}, hold);
  const holdSlip = hold.slice(Math.floor(hold.length / 3)).map((r) => Math.abs(r.slipDeg));
  const holdMin = Math.min(...holdSlip), holdMax = Math.max(...holdSlip);
  // ---- recovery: straighten up ----
  const rec = [];
  run(bh, 120, { throttle: 0.8, steer: 0 }, {}, rec);
  const recSlip = Math.abs(bh.slip * 180 / Math.PI);

  // ---- steady-state cornering roll ----
  const bc = mk(id);
  run(bc, 260, { throttle: 1 });
  const cor = [];
  run(bc, 120, { throttle: 0.7, steer: 0.55 }, {}, cor);
  const cornerRoll = Math.abs(cor[cor.length - 1].rollDeg);
  const cornerG = Math.abs(cor[cor.length - 1].gLat);

  // ---- brake dive / power squat ----
  const bp = mk(id);
  run(bp, 300, { throttle: 1 });
  const dive = [];
  run(bp, 45, { brake: 1 }, {}, dive);
  const divePitch = Math.max(...dive.map((r) => r.pitchDeg));
  const bs = mk(id);
  const squat = [];
  run(bs, 40, { throttle: 1 }, {}, squat);
  const squatPitch = Math.min(...squat.map((r) => r.pitchDeg));

  rows.push({
    id,
    top: +chaseTop.toFixed(0), ceil: +ceiling.toFixed(0),
    '0-60': t60 ? +t60.toFixed(2) : '—',
    '0-100': t100 ? +t100.toFixed(2) : '—',
    '0-150': t150 ? +t150.toFixed(2) : '—',
    brakeM: +(brakeFrames * DT).toFixed(2),
    brakeFrom: +(vBrake * MPH).toFixed(0),
    driftEnd: +bd.speedMph.toFixed(0), pre: +preDrift.toFixed(0),
    peakSlip: +peakSlip.toFixed(0), endSlip: +endSlip.toFixed(0),
    hold: `${holdMin.toFixed(0)}-${holdMax.toFixed(0)}`,
    recSlip: +recSlip.toFixed(1),
    roll: +cornerRoll.toFixed(1), driftRoll: +peakRoll.toFixed(1), latG: +cornerG.toFixed(2),
    dive: +divePitch.toFixed(1), squat: +squatPitch.toFixed(1),
    shifts: bl.shifts,
    accel: tr.slice(0, 14).join(' '),
  });
}

const cols = Object.keys(rows[0]);
const w = {};
for (const c of cols) w[c] = Math.max(c.length, ...rows.map((r) => String(r[c]).length));
console.log(cols.map((c) => c.padStart(w[c])).join(' | '));
console.log(cols.map((c) => '-'.repeat(w[c])).join('-|-'));
for (const r of rows) console.log(cols.map((c) => String(r[c]).padStart(w[c])).join(' | '));

const tops = rows.map((r) => r.top);
console.log(`\ntop-speed spread (4 s chase): ${(Math.max(...tops) - Math.min(...tops)).toFixed(1)} mph  [${tops.join(', ')}]`);

#!/usr/bin/env node
/**
 * GENERALITY TEST for the drift-recovery invariant.
 * The latch has been "fixed" three times and reappeared on a different class each time, so the
 * question is not "do the four shipped classes pass" but "does the model have one equilibrium at
 * zero for ANY plausible chassis". This invents chassis that are NOT in the table — extreme
 * rear-weight bias, mid-engine, huge yaw inertia, low rear grip — and asserts the invariant on
 * them. A general fix passes; a per-class special case fails.
 */
import * as THREE from 'three';
import { VehicleBody } from '../src/vehicles/physics.js';
import { getHandling } from '../src/vehicles/handling.js';
import { getAudioProfile } from '../src/vehicles/audio_tuning.js';
import { getNitro } from '../src/vehicles/nitrous.js';

const DT = 1 / 60, R2D = 57.29578;
const base = (id) => getHandling(id);

// synthetic chassis, each a shipped table with one or two numbers pushed well outside its range
const CASES = [
  ['rear-heavy 911', { ...base('supercar'), weightFront: 0.38, gripRear: 1.20 }],
  ['mid-engine extreme', { ...base('supercar'), weightFront: 0.42, gripFront: 1.75, gripRear: 1.10 }],
  ['nose-heavy barge', { ...base('muscle'), weightFront: 0.66, gripRear: 1.05, yawInertia: 2.4 }],
  ['low-grip rear', { ...base('tuner'), gripRear: 0.85, driftGrip: 0.16 }],
  ['huge inertia', { ...base('suv'), yawInertia: 3.6, yawDamp: 0.35 }],
  ['weak esc', { ...base('supercar'), escGrip: 0.30, weightFront: 0.44 }],
  ['no esc at all', { ...base('muscle'), escGrip: 0.0 }],
  ['sticky front', { ...base('tuner'), gripFront: 2.10, gripRear: 1.15, loadShift: 0.45 }],
];

const spec = (p) => ({ id: 'x', name: 'x', physics: p, audio: getAudioProfile('supercar'), nitro: getNitro('supercar') });

function run(p, { angleDeg, speed, throttle, grip }) {
  const b = new VehicleBody(spec(p), { wheelbase: 2.8 });
  b.reset(new THREE.Vector3(0, 0, 0), 0);
  const v = speed;
  const beta = angleDeg / R2D;
  // yaw the body relative to its velocity: velocity along +Z, heading rotated by beta
  b.yaw = beta;
  b.vel.set(0, 0, v);
  b.speed = v; b.groundSpeed = v;
  b.yawRate = 0;
  let peak = 0, homeT = null, minAfter = 1e9, maxAfter = 0;
  const T = 4.0;
  for (let i = 0; i * DT < T; i++) {
    b.step(DT, { throttle, brake: 0, steer: 0, handbrake: false },
      { grounded: true, groundY: 0, surfaceGrip: grip });
    const s = Math.abs(b.slip * R2D);
    const t = i * DT;
    peak = Math.max(peak, s);
    if (homeT == null && s < 5) homeT = t;
    if (t > 3.0) { maxAfter = Math.max(maxAfter, s); }
  }
  const end = Math.abs(b.slip * R2D);
  return { peak, homeT, end, regrow: maxAfter };
}

let fails = 0, cells = 0;
for (const [name, p] of CASES) {
  let worst = null;
  for (const angleDeg of [-40, -25, -12, 12, 25, 40]) {
    for (const speed of [18, 32, 46]) {
      for (const throttle of [0, 0.5, 1]) {
        for (const grip of [1.0, 0.60]) {
          cells++;
          const r = run(p, { angleDeg, speed, throttle, grip });
          const bad = r.end > 5 || r.homeT == null || r.homeT > 2.0 || r.regrow > 1.5;
          if (bad) {
            fails++;
            if (!worst || r.end > worst.r.end) worst = { angleDeg, speed, throttle, grip, r };
          }
        }
      }
    }
  }
  console.log(`${worst ? 'FAIL' : ' ok '}  ${name.padEnd(22)}`
    + (worst ? ` worst: ${worst.angleDeg}deg ${worst.speed}m/s thr${worst.throttle} ${worst.grip}`
      + ` -> end ${worst.r.end.toFixed(1)}deg home ${worst.r.homeT == null ? 'never' : worst.r.homeT.toFixed(2)}`
      + ` regrow ${worst.r.regrow.toFixed(1)}` : ''));
}
console.log(`\n${cells - fails}/${cells} cells hold the invariant on chassis NOT in the table`);
process.exitCode = fails ? 1 : 0;

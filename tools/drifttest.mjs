#!/usr/bin/env node
/**
 * DRIFTTEST — the recovery invariant, swept.
 *
 *   node tools/drifttest.mjs            # exit 1 on failure
 *   node tools/drifttest.mjs --verbose  # print every cell, not just the failures
 *
 * WHY THIS EXISTS
 *
 * The same bug has now been fixed four times in src/vehicles/physics.js and has come back on a
 * different car every time: a slip-angle servo (round 1), a two-sided counter-steer damper
 * (round 2), a signed ESC lead (round 3), an ungated kinetic fade and yaw hold (round 4). Every
 * one of them had the identical signature — the drift capture ends nearly straight, the driver
 * asks for nothing, and a second later the car is back at ~19° of slip and stays there.
 *
 * functest.mjs runs ONE scripted capture per car and reads the slip angle 1.5 s later. That is a
 * single point in a large state space, so it only catches the bug on whichever class happens to
 * land in the attractor this round. It caught the muscle car, then the supercar, then the tuner,
 * and each time it went quiet again as soon as that one class was nudged out of the well.
 *
 * The property that was actually being violated is not about any class. It is:
 *
 *   ── THE INVARIANT ────────────────────────────────────────────────────────────────────────
 *   With the driver's hands straight, no handbrake and no counter-steer, the slip angle has
 *   exactly one equilibrium and it is zero. From ANY angle, at ANY speed, on ANY surface, at ANY
 *   throttle, |β| must contract to ~0 — and once whatever yaw rate was in flight at the moment
 *   the driver let go has been spent, |β| must never grow again.
 *   ─────────────────────────────────────────────────────────────────────────────────────────
 *
 * That is a statement about the model's vector field, so this sweeps the field: 4 classes × 8
 * release angles × 3 speeds × 4 throttle openings × 2 surfaces, both signs, from a cold state and
 * from a genuinely hot one (a real handbrake flick, released). A nonzero attractor anywhere shows
 * up as a cell that does not come home, whichever class owns it.
 *
 * The second half of the file is the other half of the contract, because "the car can no longer
 * slide" is a worse failure than the latch: every class must still reach a real angle on the
 * handbrake and still HOLD one on constant opposite lock.
 */
import * as THREE from 'three';
import { VehicleBody } from '../src/vehicles/physics.js';
import { getHandling } from '../src/vehicles/handling.js';
import { getAudioProfile } from '../src/vehicles/audio_tuning.js';
import { getNitro } from '../src/vehicles/nitrous.js';

const DT = 1 / 60;
const R2D = 57.29578;
const D2R = 1 / R2D;
const IDS = ['tuner', 'muscle', 'suv', 'supercar'];
// wheelbases as assemble.js builds them — the CoG/axle split is load-bearing for stability
const WB = { tuner: 2.55, muscle: 2.95, suv: 3.05, supercar: 2.68 };

// ── thresholds ─────────────────────────────────────────────────────────────────────────────────
const HOME = 5.0;        // deg — "recovered". functest asks for <12 after 1.5 s; this is stricter
const T_HOME = 2.0;      // s   — by when
const T_SETTLE = 0.55;   // s   — grace for the yaw rate that was already in flight at release
const GROW = 1.5;        // deg — allowed growth AFTER T_SETTLE. This is the re-divergence test.
const VERBOSE = process.argv.includes('--verbose');

const failures = [];
const fail = (name, msg) => failures.push(`${name}: ${msg}`);

function mk(id) {
  const spec = { physics: getHandling(id), audio: getAudioProfile(id), nitro: getNitro(id) };
  const b = new VehicleBody(spec, { wheelbase: WB[id] });
  b.reset(new THREE.Vector3(0, 0, 0), 0);
  return b;
}
function run(b, n, input, env = {}, fn = null) {
  for (let i = 0; i < n; i++) {
    b.step(DT, { throttle: 0, brake: 0, steer: 0, handbrake: false, ...input }, env);
    if (fn) fn(b, i);
  }
  return b;
}
/** Impose a kinematic state: ground speed `v`, slip angle `beta` (rad), yaw rate `yr`. */
function poseSlip(b, v, beta, yr = 0) {
  const f = b.forward, r = b.right;
  b.vel.copy(f).multiplyScalar(v * Math.cos(beta)).addScaledVector(r, v * Math.sin(beta));
  b.yawRate = yr;
}

/**
 * Release the car with neutral hands and watch the angle. Returns the trace summary used by both
 * sweeps: where it started, the peak after release and WHEN, and where it ends up.
 */
function release(b, pedals, env, seconds = 3.0) {
  const drive = typeof pedals === 'number' ? { throttle: pedals } : pedals;
  // read the angle off the velocity, not the cached `slip` — a directly posed state has not been
  // through step() yet, and the cached value would report the angle before the pose
  const start = Math.abs(Math.atan2(b.vel.dot(b.right), Math.max(4, Math.abs(b.vel.dot(b.forward))))) * R2D;
  let peak = start, tPeak = 0, atHome = null, tail = 0, tailN = 0, stopped = false;
  // The envelope: the peak of each excursion to one side of straight. A recovery is a DECAYING
  // envelope — 46° one way, 8° back the other, 2°, gone. A latch is a flat one. Measuring the
  // envelope rather than the raw angle is what separates the two, and it is why a running minimum
  // on |β| is the wrong instrument: a car settling from 46° through zero to −8° looks like 8° of
  // "re-divergence" to it, while a car parked dead still at 19° looks like none at all.
  const env0 = [start];
  let sgn = 0;
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    b.step(DT, { throttle: 0, brake: 0, ...drive, steer: 0, handbrake: false }, env);
    const t = (i + 1) * DT;
    const signed = b.slip * R2D;
    const s = Math.abs(signed);
    // The invariant is about a MOVING car. Below ~10 m/s the model has deliberately blended its
    // tyres out (`gate` in physics.js fades the whole axle pair between 4 and 0.5 m/s) and there is
    // nothing left to straighten the car with — stand on the brakes at 58° of slip and all four
    // tyres spend their budget stopping you, so the car slides to a halt still pointing sideways.
    // That is a stop, not a latch, and scoring it would be scoring the wrong thing.
    if (b.groundSpeed < 10) stopped = true;
    if (stopped) continue;
    if (s > peak) { peak = s; tPeak = t; }
    if (atHome === null && s < HOME) atHome = t;
    const sg = Math.sign(signed) || sgn;
    if (sg !== sgn && sgn !== 0) env0.push(0);              // crossed straight: new excursion
    sgn = sg;
    env0[env0.length - 1] = Math.max(env0[env0.length - 1], s);
    if (t > seconds - 1.0) { tail += s; tailN++; }
  }
  // a car that stopped before the window opened has nothing to say about the invariant
  if (tailN === 0) { tail = 0; tailN = 1; atHome = atHome ?? 0; }
  // growth of any excursion over the one before it (HOME-floored so rings around zero don't count)
  let grow = 0;
  for (let k = 1; k < env0.length; k++) grow = Math.max(grow, env0[k] - Math.max(env0[k - 1], HOME));
  return {
    start, peak, tPeak, end: Math.abs(b.slip) * R2D, atHome, postGrow: grow,
    env: env0, tail: tail / Math.max(1, tailN), v: b.groundSpeed,
  };
}

function judge(name, r) {
  const notes = [];
  if (r.atHome === null || r.atHome > T_HOME) {
    notes.push(`never came home (end ${r.end.toFixed(1)}°, want <${HOME}° by ${T_HOME}s)`);
  }
  if (r.postGrow > GROW) {
    notes.push(`envelope GREW by ${r.postGrow.toFixed(1)}° [${r.env.map((e) => e.toFixed(0)).join('→')}]`);
  }
  // and it has to still be home at the end, not merely have visited
  if (r.tail > HOME) notes.push(`did not settle (last second averages ${r.tail.toFixed(1)}°)`);
  if (r.tPeak > T_SETTLE + 0.2 && r.peak > r.start + GROW) {
    notes.push(`peak ${r.peak.toFixed(1)}° arrived late (${r.tPeak.toFixed(2)}s) — something is pumping`);
  }
  if (notes.length) fail(name, notes.join('; '));
  if (VERBOSE || notes.length) {
    console.log(`   ${notes.length ? '✗' : '·'} ${name.padEnd(52)} `
      + `start ${r.start.toFixed(1).padStart(5)}°  peak ${r.peak.toFixed(1).padStart(5)}°@${r.tPeak.toFixed(2)}s  `
      + `home ${r.atHome === null ? '  —  ' : (r.atHome.toFixed(2) + 's')}  end ${r.end.toFixed(1)}°`);
  }
  return notes.length === 0;
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// 1. THE FIELD. Inject a slip angle directly and let go. This is the attractor test: if the model
//    has a stable fixed point anywhere above zero, a run started near it converges to it, so
//    sweeping the start angle across the range walks the whole basin.
// ───────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n── 1. neutral-input field: injected slip, hands straight ──');
{
  const ANGLES = [6, 10, 14, 20, 28, 36, 46, 58];
  const SPEEDS = [26, 45, 68];
  // every pedal a driver can be holding when they straighten the wheel, including "spun it, stood
  // on the brakes" — braking moves load onto the front, which is the worst case for `stabCut`
  const PEDALS = [
    ['thr0', { throttle: 0 }], ['thr0.3', { throttle: 0.3 }], ['thr0.6', { throttle: 0.6 }],
    ['thr1', { throttle: 1 }], ['brake', { brake: 1 }], ['brake½', { brake: 0.5 }],
  ];
  // surfaceGrip as main.js hands it in: 1.0 on tarmac, ~0.58 out in the dirt
  const SURFACES = [['road', 1.0], ['dirt', 0.58]];
  let cells = 0;
  for (const id of IDS) {
    let bad = 0;
    for (const [sname, sg] of SURFACES) {
      for (const v of SPEEDS) {
        for (const [pname, pedal] of PEDALS) {
          for (const sign of [1, -1]) {
            for (const A of ANGLES) {
              // SCOPE. Braking is swept up to 46°, not past it. There is no ABS in this model —
              // the brakes are a pure longitudinal force — so four locked wheels at 58° of slip is
              // a car sliding sideways to a stop, and it stops before there is time to unwind
              // 58°. That is what locked wheels do; arresting it would mean inventing a brake
              // system, not fixing a latch. Every other pedal is swept over the full range.
              if (pname.startsWith('brake') && A > 46) continue;
              const b = mk(id);
              // spin the tyre state up to something representative, then impose the angle
              run(b, 90, { throttle: 1 }, { surfaceGrip: sg });
              poseSlip(b, v, sign * A * D2R, 0);
              const r = release(b, pedal, { surfaceGrip: sg }, 3.0);
              cells++;
              const name = `${id}/${sname} ${A}° @${v}m/s ${pname}${sign < 0 ? ' (mirror)' : ''}`;
              if (!judge(name, r)) bad++;
            }
          }
        }
      }
    }
    console.log(`   ${bad ? '✗' : '✓'} ${id.padEnd(9)} ${bad ? `${bad} cells latch or re-diverge` : 'every cell contracts to zero'}`);
  }
  console.log(`   (${cells} cells)`);
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// 2. THE REAL THING. A genuine handbrake flick — hot rear tyres, real yaw rate in flight, the
//    internal state a released drift actually has — then the exact functest recovery input.
// ───────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n── 2. flick → release (the functest input: throttle 0.6, steer 0) ──');
for (const id of IDS) {
  let bad = 0;
  for (const flick of [10, 16, 22, 30, 40, 52]) {
    for (const sign of [1, -1]) {
      for (const th of [0.3, 0.6, 1.0]) {
        const b = mk(id);
        run(b, 200, { throttle: 1 });
        run(b, flick, { throttle: 0.6, steer: sign, handbrake: true });
        const r = release(b, th, {}, 3.0);
        if (!judge(`${id} flick ${flick}f thr${th}${sign < 0 ? ' (mirror)' : ''}`, r)) bad++;
      }
    }
  }
  console.log(`   ${bad ? '✗' : '✓'} ${id.padEnd(9)} ${bad ? `${bad} releases latch or re-diverge` : 'every release comes home'}`);
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// 3. AND THE DRIFT MUST SURVIVE IT. A car that recovers instantly because it can no longer slide
//    is a worse failure than the latch (ART_DIRECTION §6.2 caps the piece at 45 either way).
// ───────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n── 3. the drift still exists ──');
const WANT_PEAK = { tuner: 26, muscle: 26, suv: 18, supercar: 24 };   // deg on the flick
const WANT_HOLD = 14;                                                // deg mean over the last 2 s
for (const id of IDS) {
  const b = mk(id);
  run(b, 200, { throttle: 1 });
  let peak = 0;
  run(b, 40, { throttle: 0.85, steer: 1, handbrake: true }, {}, (bb) => {
    peak = Math.max(peak, Math.abs(bb.slip) * R2D);
  });
  // three seconds of ONE constant opposite lock — no other input steers the car
  const held = [];
  run(b, 180, { throttle: 0.9, steer: -0.45 }, {}, (bb) => held.push(Math.abs(bb.slip) * R2D));
  // MEAN over the last two seconds, not the minimum: a constant lock is a blunt instrument and the
  // heavier classes wind through straight and back out the other side on it, so the trace legitimately
  // passes through zero. What must survive is that the car is still SIDEWAYS on average — a model
  // that can no longer slide reads a mean of two or three degrees, not fourteen.
  const tail = held.slice(60);
  const holdMean = tail.reduce((s, x) => s + x, 0) / tail.length;
  const holdMax = Math.max(...tail);
  const okPeak = peak >= WANT_PEAK[id];
  const okHold = holdMean >= WANT_HOLD;
  if (!okPeak) fail(`${id} can drift`, `flick peaked at ${peak.toFixed(1)}°, want ≥${WANT_PEAK[id]}°`);
  if (!okHold) fail(`${id} holds a drift`, `lock held a mean of ${holdMean.toFixed(1)}°, want ≥${WANT_HOLD}°`);
  console.log(`   ${okPeak && okHold ? '✓' : '✗'} ${id.padEnd(9)} flick peak ${peak.toFixed(1).padStart(5)}°   `
    + `held on constant lock: mean ${holdMean.toFixed(1)}°, max ${holdMax.toFixed(1)}°`);
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// 4. STILL FOUR DIFFERENT CARS (§6.2 caps the piece at 55 if the telemetry is identical).
// ───────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n── 4. classes stay distinct ──');
{
  const tops = [], angles = [];
  for (const id of IDS) {
    const b = mk(id);
    run(b, 900, { throttle: 1 });
    tops.push(b.speedMph);
    const c = mk(id);
    run(c, 200, { throttle: 1 });
    let peak = 0;
    run(c, 40, { throttle: 0.85, steer: 1, handbrake: true }, {}, (bb) => { peak = Math.max(peak, Math.abs(bb.slip) * R2D); });
    run(c, 90, { throttle: 0.85, steer: -0.55 }, {}, (bb) => { peak = Math.max(peak, Math.abs(bb.slip) * R2D); });
    angles.push(peak);
  }
  const tSpread = Math.max(...tops) - Math.min(...tops);
  const aSpread = Math.max(...angles) - Math.min(...angles);
  if (tSpread < 12) fail('class spread', `top speeds only ${tSpread.toFixed(1)} mph apart`);
  if (aSpread < 6) fail('class spread', `drift angles only ${aSpread.toFixed(1)}° apart`);
  console.log(`   ${tSpread >= 12 ? '✓' : '✗'} top speed  spread ${tSpread.toFixed(1)} mph  [${tops.map((t) => t.toFixed(0)).join(', ')}]`);
  console.log(`   ${aSpread >= 6 ? '✓' : '✗'} drift angle spread ${aSpread.toFixed(1)}°   [${angles.map((t) => t.toFixed(0)).join(', ')}]`);
}

console.log('');
if (failures.length) {
  console.log(`✗ ${failures.length} failure${failures.length > 1 ? 's' : ''}:`);
  for (const f of failures.slice(0, 24)) console.log(`   ${f}`);
  if (failures.length > 24) console.log(`   …and ${failures.length - 24} more`);
  process.exit(1);
}
console.log('✓ drift invariants hold: one equilibrium at neutral input, and it is zero.');

#!/usr/bin/env node
/**
 * DRIVETEST — can a keyboard player actually drive it?
 *
 *   node tools/drivetest.mjs                    # all cars, all cities, 60/30/20 fps
 *   node tools/drivetest.mjs --cars muscle --cities la --fps 60
 *   node tools/drivetest.mjs --laps 2 --verbose
 *
 * drifttest.mjs checks the model's vector field with perfectly smooth scripted inputs. Players do
 * not have that: they hold ARROW KEYS, which are on or off, and they play at whatever frame rate
 * their browser manages. This drives a real lap of each city's real track the way a competent
 * keyboard player does — digital steer/throttle/brake through the real `Input` smoothing, a look-
 * ahead line, braking for corners it can see — at several frame rates, and reports what it cost:
 * lap time, barrier hits, time off the tarmac, how sideways the car got without anyone asking for
 * a slide, and spins.
 *
 * Runs in Node with no browser: only the track spline, the physics body and the input layer are
 * loaded. Wall contact copies main.js's barrier rule.
 */
import * as THREE from 'three';
import { VehicleBody } from '../src/vehicles/physics.js';
import { getHandling } from '../src/vehicles/handling.js';
import { getAudioProfile } from '../src/vehicles/audio_tuning.js';
import { getNitro } from '../src/vehicles/nitrous.js';
import { Input } from '../src/core/input.js';
import { Track } from '../src/cities/track.js';

// city modules build canvases at import time in a few places; a no-op 2D context is enough here
globalThis.document ??= { createElement: () => ({ getContext: () => new Proxy({}, { get: () => () => ({}) }) }) };

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i === -1 ? d : argv[i + 1]; };
const CARS = String(arg('cars', 'tuner,muscle,suv,supercar')).split(',');
const CITIES = String(arg('cities', 'la,vegas,miami,nyc')).split(',');
const FPS = String(arg('fps', '60,30,20')).split(',').map(Number);
const LAPS = Number(arg('laps', 1));
const VERBOSE = argv.includes('--verbose');
const JSON_OUT = arg('json', null);
const TRACE = Number(process.env.TRACE || 0);
// --handbrake: the player also flicks the handbrake into every real corner, then drives the slide
// out on the same arrow keys. Measures whether a drift is catchable, not just whether grip works.
const HB = argv.includes('--handbrake');

const WB = { tuner: 2.55, muscle: 2.95, suv: 3.05, supercar: 2.68 };
// body envelope (blueprint `dims`): the wall stops the BODY, not the centre — see Track.wallCheck
const DIMS = { tuner: [2.10, 3.96], muscle: [2.24, 5.06], suv: [2.34, 4.92], supercar: [2.34, 4.62] };
const R2D = 57.29578;
const CITY_MOD = { la: 'losangeles', vegas: 'lasvegas', miami: 'miami', nyc: 'newyork' };

async function loadTrack(city) {
  const m = await import(`../src/cities/${CITY_MOD[city]}.js`);
  const def = m.def;
  return { track: new Track(def.track), spawnU: def.spawnU ?? 0 };
}

/** One keyboard lap. Returns the cost of driving it. */
function drive(id, track, spawnU, fps) {
  const dt = 1 / fps;
  const spec = { physics: getHandling(id), audio: getAudioProfile(id), nitro: getNitro(id) };
  const b = new VehicleBody(spec, { wheelbase: WB[id] });
  const s0 = track.at(spawnU + 0.002);
  b.reset(s0.pos.clone().setY(0), Math.atan2(s0.tan.x, s0.tan.z));
  const input = new Input();
  const g = getHandling(id);
  const aLatOK = g.gripFront * 9.81 * Number(arg('push', 0.62));   // what the player asks of the tyres (--push 0.9 = on the limit)

  let u = spawnU, travelled = 0, t = 0;
  const lapLen = track.length * LAPS;
  const out = { hits: 0, hardHits: 0, offroad: 0, maxSlip: 0, slideT: 0, spins: 0, t: 0, done: false, wobble: 0 };
  let lastSteerKey = 0, spinning = false, hbT = 0, hbCool = 0;
  out.flicks = 0;
  let prevPos = b.pos.clone();
  const limit = 400;                                   // seconds — a lap that takes longer failed

  while (t < limit) {
    const v = b.groundSpeed;
    // ---- where the road goes: a look-ahead point on the centre line
    const near = track.nearest(b.pos, u);
    u = near.u;
    const look = 7 + v * 0.42;
    const tgt = track.at(u + look / track.length).pos;
    const fwd = b.forward, rgt = b.right;               // `right` is +X, the driver's LEFT
    const to = tgt.clone().sub(b.pos).setY(0);
    const err = Math.atan2(to.dot(rgt), to.dot(fwd));    // + means the line is to the driver's left
    // ---- how fast the next stretch can be taken
    let vCap = 200;
    for (let d = 5; d < 30 + v * v / 18; d += 4) {
      const k = Math.abs(track.turnRate(u + d / track.length));
      const vCorner = Math.sqrt(aLatOK / Math.max(k, 1e-4));
      const brakeDist = Math.max(0, d - 6);
      vCap = Math.min(vCap, Math.sqrt(vCorner * vCorner + 2 * 15 * brakeDist));
    }
    // ---- keys. A player taps toward the line with a small dead band.
    input.keys.clear();
    const dead = 0.025 + 0.02 * lastSteerKey * 0;     // no hysteresis: a player re-presses every frame
    let steerKey = 0;
    if (err > dead) steerKey = 1; else if (err < -dead) steerKey = -1;
    if (steerKey > 0) input.keys.add('ArrowLeft');
    if (steerKey < 0) input.keys.add('ArrowRight');
    if (steerKey !== lastSteerKey && steerKey !== 0 && lastSteerKey !== 0) out.wobble++;
    if (steerKey !== 0) lastSteerKey = steerKey;
    if (v > vCap + 2) input.keys.add('ArrowDown');
    else if (v < vCap) input.keys.add('ArrowUp');
    if (HB) {
      hbCool -= dt; hbT -= dt;
      const kNear = Math.abs(track.turnRate(u + (6 + v * 0.5) / track.length));
      if (hbCool <= 0 && v > 22 && kNear > 0.018) { hbT = 0.28; hbCool = 3.0; out.flicks++; }
      if (hbT > 0) input.keys.add('Space');
    }
    input.update(dt);

    // ---- surface + step, exactly as main.js does it
    const absLat = Math.abs(near.lateral);
    const surfaceGrip = absLat > 1.02 ? THREE.MathUtils.lerp(1.0, 0.58, THREE.MathUtils.smoothstep(absLat, 1.02, 1.5)) : 1.0;
    b.surface = track.surfaceAt(absLat);
    b.step(dt, { throttle: input.throttle, brake: input.brake, steer: input.steer, handbrake: input.handbrake }, { surfaceGrip });
    if (absLat > 1.02) out.offroad += dt;

    // ---- barrier: the kerb face or a declared barrier run, met by the body (main.js's rule)
    const n2 = track.nearest(b.pos, u);
    const wc = track.wallCheck(n2, b.forward, DIMS[id][0] * 0.5, DIMS[id][1] * 0.5);
    if (wc) {
      const s = n2.sample;
      const inward = s.right.clone().multiplyScalar(-wc.side);
      b.pos.addScaledVector(inward, wc.over);
      const st = b.impact(inward, 0.28, 0.62);
      if (st > 0.05) out.hits++;
      if (st > 0.22) out.hardHits++;
    }

    const slip = Math.abs(b.slip) * R2D;
    // TRACE=12 prints every frame over 12° of slip — where a lap went sideways, and why
    if (TRACE && slip > TRACE) {
      console.log(JSON.stringify({ t: +t.toFixed(2), v: +v.toFixed(1), slip: +(b.slip * R2D).toFixed(1), steer: +input.steer.toFixed(2),
        thr: input.throttle, brk: input.brake, rearGrip: +b.rearGrip.toFixed(2), wheelSlip: +b.wheelSlip.toFixed(2), gear: b.gear,
        latch: +b.driftLatch.toFixed(2), yawRate: +b.yawRate.toFixed(2), u: +u.toFixed(3), lat: +n2.lateral.toFixed(2),
        k: +(track.turnRate(u) * 1000).toFixed(1) }));
    }
    if (b.groundSpeed > 8) {
      out.maxSlip = Math.max(out.maxSlip, slip);
      if (slip > 10) out.slideT += dt;
      if (slip > 70 && !spinning) { out.spins++; spinning = true; }
      if (slip < 20) spinning = false;
    }
    travelled += b.pos.clone().sub(prevPos).setY(0).length() * Math.sign(b.vel.dot(track.at(u).tan) || 1);
    prevPos.copy(b.pos);
    t += dt;
    if (travelled >= lapLen) { out.done = true; break; }
  }
  out.t = t;
  return out;
}

const rows = [];
for (const city of CITIES) {
  const { track, spawnU } = await loadTrack(city);
  for (const id of CARS) {
    for (const fps of FPS) {
      const r = drive(id, track, spawnU, fps);
      rows.push({ city, car: id, fps, ...r });
    }
  }
}

const f = (x, n = 1) => (typeof x === 'number' ? x.toFixed(n) : String(x));
console.log('city   car       fps   lap s   hits  hard  offroad s  slide>10° s  max slip°  spins  steer flips');
for (const r of rows) {
  console.log(
    `${r.city.padEnd(6)} ${r.car.padEnd(9)} ${String(r.fps).padStart(3)}  ${(r.done ? f(r.t) : 'DNF').padStart(6)}  ${String(r.hits).padStart(4)}  ${String(r.hardHits).padStart(4)}  ${f(r.offroad).padStart(9)}  ${f(r.slideT).padStart(11)}  ${f(r.maxSlip).padStart(9)}  ${String(r.spins).padStart(5)}  ${String(r.wobble).padStart(11)}`,
  );
}
// totals per fps — the frame-rate sensitivity in one line each
for (const fps of FPS) {
  const rs = rows.filter((r) => r.fps === fps);
  const sum = (k) => rs.reduce((a, r) => a + (r[k] || 0), 0);
  console.log(`TOTAL @${fps}fps: laps ${rs.filter((r) => r.done).length}/${rs.length}  hits ${sum('hits')}  hard ${sum('hardHits')}  offroad ${f(sum('offroad'))}s  slide ${f(sum('slideT'))}s  spins ${sum('spins')}  mean lap ${f(sum('t') / rs.length)}s`);
}
if (JSON_OUT) (await import('node:fs')).writeFileSync(JSON_OUT, JSON.stringify(rows, null, 1));
void VERBOSE;

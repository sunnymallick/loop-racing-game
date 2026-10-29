#!/usr/bin/env node
/**
 * RACE SIM — where does a keyboard player of a given pace finish? Node only, no browser.
 *
 *   node tools/racesim.mjs                       # push 0.62/0.80/0.95, all cities, all cars
 *   node tools/racesim.mjs --push 0.95 --nitro --cities la --cars muscle
 *   node tools/racesim.mjs --push 0.95 --handbrake --verbose
 *   node tools/racesim.mjs --seed 11 --json out.json
 *
 * The director (`Race`) and its seven `AIDriver`s run exactly as main.js runs them; only the
 * scene, the FX and the camera are left out. The player is tools/drivetest.mjs's keyboard driver
 * (digital keys through the real `Input` smoothing, a look-ahead line, braking for what it can
 * see at `--push` of its own front grip), driving the real `VehicleBody` with main.js's barrier
 * rule, boost pads and drift payout, and — with `--nitro` — lighting the bottle whenever it is
 * armed and the road ahead is straight enough to use it. `--handbrake` flicks into every real
 * corner as drivetest does.
 *
 * Reports, per race: the player's finishing place and race time, the winner's, the field's
 * best laps by class, the fastest any opponent went while boosting (and the player's own), and
 * (`--verbose`) the corner grip each class was asked for and every car's lap times.
 *
 * What it is NOT: a human. The keyboard driver follows the centre line, not a racing line, takes
 * no shortcuts and brakes on a fixed 15 m/s² plan, so a real player at the same "push" is quicker
 * than it is — read its finishing places as a floor on what a player of that pace gets.
 */
import * as THREE from 'three';

// city modules build canvases at import time in a few places; a no-op 2D context is enough here
globalThis.document ??= { createElement: () => ({ getContext: () => new Proxy({}, { get: () => () => ({}) }) }) };

const { VehicleBody } = await import('../src/vehicles/physics.js');
const { getVehicle } = await import('../src/vehicles/index.js');
const { Nitrous } = await import('../src/vehicles/nitrous.js');
const { Input } = await import('../src/core/input.js');
const { Track } = await import('../src/cities/track.js');
const { Race } = await import('../src/race/race.js');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i === -1 ? d : argv[i + 1]; };
const CARS = String(arg('cars', 'tuner,muscle,suv,supercar')).split(',');
const CITIES = String(arg('cities', 'la,vegas,miami,nyc')).split(',');
const PUSHES = String(arg('push', '0.62,0.8,0.95')).split(',').map(Number);
const FPS = Number(arg('fps', 60));
const SEED = Number(arg('seed', 5));
const NITRO = argv.includes('--nitro');
const HB = argv.includes('--handbrake');
const VERBOSE = argv.includes('--verbose');
const JSON_OUT = arg('json', null);
const MPH = 2.23694;
const CITY_MOD = { la: 'losangeles', vegas: 'lasvegas', miami: 'miami', nyc: 'newyork' };

async function loadCity(city) {
  const m = await import(`../src/cities/${CITY_MOD[city]}.js`);
  return { def: m.def, track: new Track(m.def.track) };
}

function race(city, def, track, carId, push) {
  const dt = 1 / FPS;
  const veh = getVehicle(carId);
  const spec = veh.spec;
  const r = new Race({ track, cityDef: def, playerSpec: spec, opponents: 7, seed: SEED });
  const slot = r.grid(def.spawnU ?? 0);
  const b = new VehicleBody(spec, { wheelbase: veh.blueprint.dims.wheelbase ?? 2.8 });
  const s0 = track.at(slot.u);
  b.reset(s0.pos.clone().addScaledVector(s0.right, slot.lateral * track.halfWidth), Math.atan2(s0.tan.x, s0.tan.z));
  const nitro = new Nitrous(spec);
  const input = new Input();
  const aLatOK = spec.physics.gripFront * 9.81 * push;
  const pads = def.props?.boostPads || [];

  const out = {
    city, car: carId, push, pos: null, time: null, winner: null, best: null, hits: 0, offroad: 0,
    aiBoostMph: 0, aiBoostWho: '', playerMph: 0, aiTopMph: 0, contacts: 0, flicks: 0,
  };
  const classBest = {};
  let hbT = 0, hbCool = 0, lastPad = -1, padT = 0, t = 0, after = 0;
  const limit = 60 + (r.laps || 3) * 160;

  while (t < limit) {
    t += dt;
    const racing = r.state === 'racing';
    const v = b.groundSpeed;
    const near = track.nearest(b.pos, r.playerU ?? null);
    const u = near.u;
    const look = 7 + v * 0.42;
    const tgt = track.at(u + look / track.length).pos;
    const fwd = b.forward, rgt = b.right;
    const to = tgt.clone().sub(b.pos).setY(0);
    const err = Math.atan2(to.dot(rgt), to.dot(fwd));
    let vCap = 200;
    for (let d = 5; d < 30 + v * v / 18; d += 4) {
      const k = Math.abs(track.turnRate(u + d / track.length));
      const vCorner = Math.sqrt(aLatOK / Math.max(k, 1e-4));
      vCap = Math.min(vCap, Math.sqrt(vCorner * vCorner + 2 * 15 * Math.max(0, d - 6)));
    }
    input.keys.clear();
    if (err > 0.025) input.keys.add('ArrowLeft'); else if (err < -0.025) input.keys.add('ArrowRight');
    if (v > vCap + 2) input.keys.add('ArrowDown'); else if (v < vCap) input.keys.add('ArrowUp');
    if (HB && racing) {
      hbCool -= dt; hbT -= dt;
      const kNear = Math.abs(track.turnRate(u + (6 + v * 0.5) / track.length));
      if (hbCool <= 0 && v > 22 && kNear > 0.018) { hbT = 0.28; hbCool = 3.0; out.flicks++; }
      if (hbT > 0) input.keys.add('Space');
    }
    input.update(dt);

    // nitrous: light it when the road ahead stays straight for the length of a boost
    let want = false;
    if (NITRO && racing && v > 25) {
      let straight = true;
      for (let d = 10; d < 40 + v * 2.2; d += 8) {
        if (Math.abs(track.turnRate(u + d / track.length)) > 0.006) { straight = false; break; }
      }
      want = straight || nitro.active && vCap > v + 4;
    }
    nitro.update(dt, want, { moving: b.speed > 1.5 });

    const absLat = Math.abs(near.lateral);
    const surfaceGrip = absLat > 1.02 ? THREE.MathUtils.lerp(1.0, 0.58, THREE.MathUtils.smoothstep(absLat, 1.02, 1.5)) : 1.0;
    b.surface = absLat > 1.02 ? 'dirt' : 'road';
    b.step(dt, {
      throttle: racing ? input.throttle : 0,
      brake: racing ? input.brake : (r.state === 'countdown' ? 1 : 0),
      steer: racing ? input.steer : 0,
      handbrake: input.handbrake,
    }, { surfaceGrip, boost: nitro.ramp, boostThrust: nitro.thrust, topSpeedMul: nitro.cfg.topSpeedMul });
    if (racing && absLat > 1.02) out.offroad += dt;
    // a clean handbrake slide's nitrous, as main.js pays it (DRIFT_NITRO 0.35 per unit of payout)
    if (racing && b.driftPayout > 0) nitro.charge = Math.min(1, nitro.charge + 0.35 * b.driftPayout);

    const n2 = track.nearest(b.pos, u);
    if (Math.abs(n2.lateral) > 1.52) {
      const inward = n2.sample.right.clone().multiplyScalar(-Math.sign(n2.lateral));
      b.pos.addScaledVector(inward, (Math.abs(n2.lateral) - 1.52) * track.halfWidth);
      if (b.impact(inward, 0.28, 0.62) > 0.05 && racing) out.hits++;
    }
    // boost pads, as main.js grants them
    padT -= dt;
    if (padT <= 0) lastPad = -1;
    for (let i = 0; i < pads.length; i++) {
      const du = Math.abs(((r.playerU - pads[i].u + 0.5) % 1 + 1) % 1 - 0.5);
      if (du < 0.006 && Math.abs(near.lateral - (pads[i].lateral ?? 0)) < 0.5 && lastPad !== i) {
        lastPad = i; padT = 1.5; nitro.addTank();
      }
    }

    r.update(dt, b);

    if (racing) {
      out.playerMph = Math.max(out.playerMph, b.groundSpeed * MPH);
      for (const d of r.drivers) {
        const mph = d.body.groundSpeed * MPH;
        out.aiTopMph = Math.max(out.aiTopMph, mph);
        if (d.nitro.ramp > 0.05 && mph > out.aiBoostMph) { out.aiBoostMph = mph; out.aiBoostWho = d.vehicleId; }
      }
    }
    if (r.playerFinished && out.pos == null) {
      out.pos = r.playerFinishPos ?? r.playerPos;
      out.time = r.finishTime;
      out.best = r.lapTimes.length ? Math.min(...r.lapTimes) : null;
    }
    if (out.pos != null) {
      after += dt;
      if (r.drivers.every((d) => d.finished) || after > 30) break;
    } else if (r.dnf || (r._classified && !r.playerFinished)) {
      out.pos = 'DNF';
      break;
    }
  }
  const fins = r.drivers.filter((d) => d.finishTime != null).map((d) => d.finishTime);
  if (out.time != null) fins.push(out.time);
  out.winner = fins.length ? Math.min(...fins) : null;
  for (const d of r.drivers) {
    const best = d.counter.best;
    if (best != null) classBest[d.vehicleId] = Math.min(classBest[d.vehicleId] ?? 1e9, best);
  }
  out.classBest = classBest;
  out.contacts = r.playerContacts;
  const tel = r.telemetry();
  out.askG = {};
  for (const row of tel.field) out.askG[row.car] = Math.max(out.askG[row.car] ?? 0, row.askG);
  out.fieldPace = r.fieldPace;
  out.field = r.drivers.map((d) => `${d.vehicleId.slice(0, 3)} s${d.skill.toFixed(2)} [${d.counter.lapTimes.map((x) => x.toFixed(1)).join(' ')}]`);
  out.lapTimes = r.lapTimes.map((x) => +x.toFixed(1));
  return out;
}

const rows = [];
const f = (x, n = 1) => (typeof x === 'number' ? x.toFixed(n) : String(x ?? '-'));
console.log(`race sim  seed ${SEED}  ${FPS} fps  nitro ${NITRO ? 'on' : 'off'}  handbrake ${HB ? 'on' : 'off'}`);
console.log('city   car       push   pos   race s  winner s   best lap  hits  off s  pl mph  ai boost mph   class best laps');
for (const city of CITIES) {
  const { def, track } = await loadCity(city);
  for (const car of CARS) {
    for (const push of PUSHES) {
      const o = race(city, def, track, car, push);
      rows.push(o);
      const cb = Object.entries(o.classBest).map(([k, x]) => `${k.slice(0, 3)} ${x.toFixed(1)}`).join(' ');
      console.log(`${city.padEnd(6)} ${car.padEnd(9)} ${f(push, 2).padStart(4)}  ${String(o.pos).padStart(4)}  ${f(o.time).padStart(7)}  ${f(o.winner).padStart(8)}  ${f(o.best).padStart(9)}  ${String(o.hits).padStart(4)}  ${f(o.offroad).padStart(5)}  ${f(o.playerMph, 0).padStart(6)}  ${f(o.aiBoostMph, 0).padStart(5)} ${o.aiBoostWho.padEnd(8)}  ${cb}`);
      if (VERBOSE) console.log('   askG', JSON.stringify(o.askG), 'fieldPace', o.fieldPace.toFixed(3), 'contacts', o.contacts, '\n   player', JSON.stringify(o.lapTimes), '\n   ' + o.field.join('\n   '));
    }
  }
}
for (const push of PUSHES) {
  const rs = rows.filter((r) => r.push === push);
  const ps = rs.map((r) => (typeof r.pos === 'number' ? r.pos : 8));
  const byCar = CARS.map((c) => {
    const p = rs.filter((r) => r.car === c).map((r) => (typeof r.pos === 'number' ? r.pos : 8));
    return `${c} ${(p.reduce((a, x) => a + x, 0) / Math.max(1, p.length)).toFixed(1)}`;
  }).join('  ');
  console.log(`PUSH ${push}: mean pos ${(ps.reduce((a, x) => a + x, 0) / ps.length).toFixed(2)}  wins ${ps.filter((x) => x === 1).length}/${ps.length}  [${byCar}]  ai boost max ${Math.max(...rs.map((r) => r.aiBoostMph)).toFixed(0)} mph`);
}
if (JSON_OUT) (await import('node:fs')).writeFileSync(JSON_OUT, JSON.stringify(rows, null, 1));

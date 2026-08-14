#!/usr/bin/env node
/** The car contract: wheels steer/spin, brake lamps light, exhaust anchors, contact shadow. */
import { boot, open } from './harness.mjs';

const h = await boot({ gpu: false, width: 800, height: 450 });
try {
  await open(h.page, h.url, { city: 'la', car: 'muscle' });
  const out = await h.page.evaluate(async () => {
    const mod = await import('/src/vehicles/index.js');
    const phys = await import('/src/vehicles/physics.js');
    const rows = [];
    for (const id of mod.VEHICLE_IDS) {
      const car = mod.buildVehicle(id, { color: '#22cc88' });
      const u = car.userData;
      const r = { id, ok: {}, };
      r.ok.wheels4 = u.wheels?.length === 4;
      r.ok.steer2 = u.steerWheels?.length === 2;
      r.ok.spin = u.wheels.every((w) => !!w.userData.spin);
      r.ok.radius = u.wheels.every((w) => w.userData.radius > 0);
      r.ok.exhausts = (u.exhausts?.length ?? 0) > 0;
      r.ok.shadow = !!car.getObjectByName('contactShadow');
      r.ok.lightsBrake = u.lights.brake.length > 0 && u.lights.brake.every((l) => l.children[0]?.material?.emissiveIntensity !== undefined && !!l.getObjectByName('glow'));
      r.ok.lightsHead = u.lights.head.length > 0 && u.lights.head.every((l) => !!l.children[0]);

      // brake lights respond
      const body = { pos: { x: 1, y: 0, z: 2 }, yaw: 0.4, roll: 0.02, pitch: 0.01, heave: 0.01,
        steerVisual: 0.3, drift: 0, wheelSpin: 1.2, wheelSpinRear: 2.4, brakeLit: true };
      phys.applyPose(car, body, 1 / 60);
      const lit = u.lights.brake[0].children[0].material.emissiveIntensity;
      const glowLit = u.lights.brake[0].getObjectByName('glow').material.opacity;
      body.brakeLit = false;
      phys.applyPose(car, body, 1 / 60);
      const dark = u.lights.brake[0].children[0].material.emissiveIntensity;
      r.ok.brakeSwitches = lit > dark && glowLit === 1.0;

      // wheels: steer + spin must reach the instance matrices
      car.updateMatrixWorld(true);
      const rig = car.getObjectByName('wheels');
      r.ok.rig = !!rig && rig.children.length > 0;
      const arr = () => Array.from(rig.children[0].instanceMatrix.array);
      const before = arr();
      body.steerVisual = -0.6; body.wheelSpin = 4.5;
      phys.applyPose(car, body, 1 / 60);
      car.updateMatrixWorld(true);
      const after = arr();
      r.ok.instancesMove = after.some((v, i) => Math.abs(v - before[i]) > 1e-4);
      // the four corners must be at four different places (translation = elements 12,13,14)
      const n = rig.children[0].count;
      const pts = [];
      for (let i = 0; i < n; i++) pts.push({ x: after[i * 16 + 12], y: after[i * 16 + 13], z: after[i * 16 + 14] });
      r.ok.fourCorners = n === 4 && new Set(pts.map((p) => `${p.x.toFixed(2)},${p.z.toFixed(2)}`)).size === 4;
      r.wheelPos = pts.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}`);
      let meshes = 0, inst = 0;
      car.traverse((o) => { if (o.isInstancedMesh) { inst++; meshes++; } else if (o.isMesh) meshes++; });
      r.meshes = meshes; r.instanced = inst;
      rows.push(r);
    }
    return rows;
  });
  let bad = 0;
  for (const r of out) {
    const fails = Object.entries(r.ok).filter(([, v]) => !v).map(([kk]) => kk);
    bad += fails.length;
    console.log(`${r.id.padEnd(9)} meshes ${String(r.meshes).padStart(3)} (${r.instanced} instanced)  ${fails.length ? 'FAIL: ' + fails.join(',') : 'all contract checks pass'}`);
    console.log(`          corners ${r.wheelPos.join('  ')}`);
  }
  console.log(bad ? `\n${bad} FAILURES` : '\nCONTRACT OK');
} finally { await h.close(); }

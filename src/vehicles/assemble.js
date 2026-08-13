import * as THREE from 'three';
import {
  loftBody, roundedBox, buildWheel, paintMaterial, glassMaterial, chromeMaterial,
  darkTrimMaterial, emissiveMaterial, contactShadow, lightUnit, liveryTexture,
} from './kit.js';
import { lerp, clamp, RNG } from '../core/rng.js';

/**
 * Blueprint → car. A blueprint describes a real vehicle by its cross-sections and hard points;
 * this assembles the lower body, greenhouse (pillars + glass + interior), wheels, lights and trim.
 *
 * Builders own the blueprints in tuner.js / muscle.js / suv.js / supercar.js and may replace any
 * part of this assembly — it is a starting structure, not a straitjacket. What must stay stable is
 * the RETURN CONTRACT, because physics, camera, FX and race code all read it:
 *
 *   group.userData = {
 *     spec,                                  // the vehicle spec
 *     wheels: [FL, FR, RL, RR],              // THREE.Group, each with .userData.radius
 *     steerWheels: [FL, FR],
 *     body,                                  // the mesh/group that rolls & pitches
 *     lights: { head:[], tail:[], brake:[], reverse:[] },
 *     exhausts: [THREE.Object3D],            // world anchors for nitrous/backfire FX
 *     dims: { length, width, height, wheelbase, track, rideHeight },
 *   }
 */

/** Build a 9-point half cross-section. y is up, x is half-width. */
export function section(z, {
  w = 0.9, yBot = 0.18, ySill = 0.42, yBelt = 0.95, yRoof = 1.32,
  roofW = 0.72, tuck = 0.94, flare = 1.0, floor = 0.55,
}) {
  return {
    z,
    pts: [
      [0, yBot],
      [w * floor, yBot],
      [w * 0.97 * flare, yBot + (ySill - yBot) * 0.34],
      [w * flare, ySill],
      [w * 0.995 * flare, lerp(ySill, yBelt, 0.72)],
      [w * tuck, yBelt],
      [lerp(w * tuck, roofW, 0.55), lerp(yBelt, yRoof, 0.55)],
      [roofW * 0.86, yRoof],
      [0, yRoof],
    ],
  };
}

export function assembleCar(bp, { color = null, rng = new RNG(1), envMap = null } = {}) {
  const car = new THREE.Group();
  car.name = bp.id;
  const paintColor = color || bp.colors[0];

  const livery = bp.livery
    ? liveryTexture({ base: paintColor, ...bp.livery })
    : null;
  const paint = paintMaterial({
    color: livery ? '#ffffff' : paintColor,
    map: livery,
    metalness: bp.paint?.metalness ?? 0.75,
    roughness: bp.paint?.roughness ?? 0.24,
    clearcoat: bp.paint?.clearcoat ?? 1.0,
    flake: bp.paint?.flake ?? 0.55,
    seed: 3,
  });
  const glass = glassMaterial(bp.glass || {});
  const chrome = chromeMaterial(bp.chrome || {});
  const trim = darkTrimMaterial();

  // ---------------- lower body ----------------
  const bodyGroup = new THREE.Group();
  bodyGroup.name = 'body';
  const bodyGeo = loftBody(bp.sections.map((s) => section(s.z, s)));
  const body = new THREE.Mesh(bodyGeo, paint);
  body.castShadow = true; body.receiveShadow = true;
  bodyGroup.add(body);

  // ---------------- greenhouse ----------------
  // Pillars + roof panel + glass, so the cabin is a real volume rather than a painted-on window.
  if (bp.greenhouse) {
    const gh = bp.greenhouse;
    const roofY = gh.roofY, beltY = gh.beltY;
    const roofHalf = gh.roofHalfWidth;

    // roof panel
    const roof = new THREE.Mesh(
      roundedBox(roofHalf * 2, gh.roofLength, 0.06, 0.05),
      paint,
    );
    roof.rotation.x = Math.PI / 2;
    roof.position.set(0, roofY, gh.roofZ);
    roof.castShadow = true;
    bodyGroup.add(roof);

    // pillars
    const pillarMat = gh.blackPillars ? trim : paint;
    for (const p of gh.pillars) {
      for (const sx of [-1, 1]) {
        const len = Math.hypot(p.top[1] - p.bot[1], p.top[0] - p.bot[0]);
        const pil = new THREE.Mesh(roundedBox(p.w ?? 0.09, len, p.d ?? 0.10, 0.03), pillarMat);
        const mz = (p.top[0] + p.bot[0]) / 2, my = (p.top[1] + p.bot[1]) / 2;
        pil.position.set(sx * (p.x ?? roofHalf * 0.98), my, mz);
        pil.rotation.x = Math.atan2(p.top[0] - p.bot[0], p.top[1] - p.bot[1]);
        pil.castShadow = true;
        bodyGroup.add(pil);
      }
    }

    // interior: seats, dash, wheel, parcel shelf — §7 caps a black-void cabin at 72
    const inte = new THREE.Group();
    const seatMat = new THREE.MeshStandardMaterial({ color: gh.interiorColor || 0x1a1c22, roughness: 0.85 });
    for (const sx of [-1, 1]) {
      const base = new THREE.Mesh(roundedBox(0.42, 0.12, 0.48, 0.05), seatMat);
      base.position.set(sx * 0.34, beltY - 0.30, gh.seatZ);
      inte.add(base);
      const back = new THREE.Mesh(roundedBox(0.40, 0.56, 0.13, 0.05), seatMat);
      back.position.set(sx * 0.34, beltY - 0.02, gh.seatZ - 0.24);
      back.rotation.x = -0.16;
      inte.add(back);
      const head = new THREE.Mesh(roundedBox(0.22, 0.14, 0.10, 0.04), seatMat);
      head.position.set(sx * 0.34, beltY + 0.28, gh.seatZ - 0.28);
      inte.add(head);
    }
    const dash = new THREE.Mesh(roundedBox(roofHalf * 1.75, 0.20, 0.36, 0.06), seatMat);
    dash.position.set(0, beltY - 0.10, gh.seatZ + 0.62);
    inte.add(dash);
    const wheelR = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.022, 8, 22), trim);
    wheelR.position.set(-0.34, beltY - 0.02, gh.seatZ + 0.44);
    wheelR.rotation.x = 1.15;
    inte.add(wheelR);
    inte.name = 'interior';
    bodyGroup.add(inte);

    // glass panels
    const mkGlass = (geo, pos, rot) => {
      const m = new THREE.Mesh(geo, glass);
      m.position.set(...pos); if (rot) m.rotation.set(...rot);
      m.renderOrder = 3;
      bodyGroup.add(m);
      return m;
    };
    if (gh.windshield) {
      const ws = gh.windshield;
      mkGlass(new THREE.PlaneGeometry(ws.w, ws.h, 4, 4), [0, ws.y, ws.z], [ws.rx, 0, 0]);
    }
    if (gh.backlight) {
      const bl = gh.backlight;
      mkGlass(new THREE.PlaneGeometry(bl.w, bl.h, 4, 4), [0, bl.y, bl.z], [bl.rx, 0, 0]);
    }
    for (const sw of gh.sideWindows || []) {
      for (const sx of [-1, 1]) {
        mkGlass(new THREE.PlaneGeometry(sw.w, sw.h), [sx * sw.x, sw.y, sw.z], [0, sx * Math.PI / 2 + (sw.ry || 0), sw.rz || 0]);
      }
    }
  }

  car.add(bodyGroup);

  // ---------------- wheels + arches ----------------
  const wheels = [];
  const wb = bp.dims.wheelbase, tr = bp.dims.track;
  const positions = [
    [-tr / 2, wb / 2], [tr / 2, wb / 2],       // FL, FR
    [-tr / 2, -wb / 2], [tr / 2, -wb / 2],     // RL, RR
  ];
  for (let i = 0; i < 4; i++) {
    const isFront = i < 2;
    const cfg = isFront ? bp.wheels.front : bp.wheels.rear;
    const holder = new THREE.Group();          // steering
    const spin = buildWheel({ ...cfg, style: bp.wheels.style, rimColor: bp.wheels.rimColor, caliperColor: bp.wheels.caliperColor });
    spin.name = 'spin';
    if (positions[i][0] > 0) spin.rotation.y = Math.PI;   // face the caliper outward on both sides
    holder.add(spin);
    holder.position.set(positions[i][0], cfg.radius, positions[i][1]);
    holder.userData.radius = cfg.radius;
    holder.userData.spin = spin;
    holder.name = ['FL', 'FR', 'RL', 'RR'][i];
    car.add(holder);
    wheels.push(holder);

    // wheel arch lip so the tyre sits INSIDE a fender rather than beside a slab (§6.1)
    if (bp.arches !== false) {
      const archR = cfg.radius * 1.30;
      const arch = new THREE.Mesh(
        new THREE.TorusGeometry(archR, bp.archThickness ?? 0.045, 6, 16, Math.PI),
        bp.blackArches ? trim : paint,
      );
      arch.rotation.y = Math.PI / 2;
      arch.position.set(positions[i][0] * (bp.archInset ?? 0.99), cfg.radius, positions[i][1]);
      arch.castShadow = true;
      car.add(arch);
    }
  }

  // ---------------- lights ----------------
  const lights = { head: [], tail: [], brake: [], reverse: [] };
  for (const h of bp.lights?.head || []) {
    for (const sx of h.mirror === false ? [1] : [-1, 1]) {
      const u = lightUnit({ w: h.w, h: h.h, color: h.color || '#dfeaff', intensity: h.intensity ?? 3.0, shape: h.shape, glow: 0.85 });
      u.position.set(sx * h.x, h.y, h.z);
      u.rotation.y = 0;
      car.add(u);
      lights.head.push(u);
    }
  }
  for (const t of bp.lights?.tail || []) {
    for (const sx of t.mirror === false ? [1] : [-1, 1]) {
      const u = lightUnit({ w: t.w, h: t.h, color: t.color || '#ff2010', intensity: t.intensity ?? 2.4, shape: t.shape, glow: 0.9 });
      u.position.set(sx * t.x, t.y, t.z);
      u.rotation.y = Math.PI;
      car.add(u);
      lights.tail.push(u);
      if (t.brake !== false) lights.brake.push(u);
    }
  }

  // ---------------- detail pass ----------------
  const detail = new THREE.Group();
  detail.name = 'detail';

  // mirrors
  if (bp.mirrors) {
    for (const sx of [-1, 1]) {
      const arm = new THREE.Mesh(roundedBox(0.10, 0.05, 0.13, 0.02), trim);
      arm.position.set(sx * bp.mirrors.x, bp.mirrors.y, bp.mirrors.z);
      detail.add(arm);
      const cap = new THREE.Mesh(roundedBox(0.19, 0.11, 0.09, 0.035), bp.mirrors.painted ? paint : trim);
      cap.position.set(sx * (bp.mirrors.x + 0.10), bp.mirrors.y + 0.01, bp.mirrors.z);
      detail.add(cap);
      const gl = new THREE.Mesh(new THREE.PlaneGeometry(0.15, 0.08), chrome);
      gl.position.set(sx * (bp.mirrors.x + 0.155), bp.mirrors.y + 0.01, bp.mirrors.z - 0.005);
      gl.rotation.y = sx * (Math.PI / 2 - 0.2);
      detail.add(gl);
    }
  }

  // exhausts
  const exhausts = [];
  for (const e of bp.exhaust || []) {
    for (const sx of e.mirror === false ? [0] : [-1, 1]) {
      const pipe = new THREE.Mesh(
        new THREE.CylinderGeometry(e.r, e.r * 1.08, 0.20, 14, 1, true),
        chromeMaterial({ color: '#c8ccd2', rough: 0.22 }),
      );
      pipe.rotation.x = Math.PI / 2;
      pipe.position.set(sx * e.x, e.y, e.z);
      detail.add(pipe);
      const anchor = new THREE.Object3D();
      anchor.position.set(sx * e.x, e.y, e.z - 0.10);
      car.add(anchor);
      exhausts.push(anchor);
    }
  }

  // trim strips / sills / splitter / diffuser
  for (const t of bp.trim || []) {
    const mat = t.mat === 'chrome' ? chrome : t.mat === 'paint' ? paint : trim;
    const g = new THREE.Mesh(roundedBox(t.w, t.h, t.d, t.r ?? 0.02), mat);
    g.position.set(t.x ?? 0, t.y, t.z);
    if (t.rx) g.rotation.x = t.rx;
    g.castShadow = true;
    detail.add(g);
    if (t.mirror) {
      const g2 = g.clone(); g2.position.x = -(t.x ?? 0); detail.add(g2);
    }
  }

  // grille — a dark mesh panel with slats reads far better than a flat black rectangle
  if (bp.grille) {
    const gr = bp.grille;
    const panel = new THREE.Mesh(roundedBox(gr.w, gr.h, 0.06, 0.03),
      new THREE.MeshStandardMaterial({ color: 0x0a0b0d, roughness: 0.55, metalness: 0.6 }));
    panel.position.set(0, gr.y, gr.z);
    detail.add(panel);
    const slats = gr.slats ?? 7;
    for (let i = 0; i < slats; i++) {
      const s = new THREE.Mesh(roundedBox(gr.w * 0.96, gr.h / slats * 0.42, 0.05, 0.012), chrome);
      s.position.set(0, gr.y - gr.h / 2 + (i + 0.5) * (gr.h / slats), gr.z + 0.02);
      detail.add(s);
    }
  }

  // spoiler / wing
  if (bp.wing) {
    const w = bp.wing;
    if (w.type === 'pedestal') {
      for (const sx of [-1, 1]) {
        const post = new THREE.Mesh(roundedBox(0.06, w.h, 0.14, 0.02), trim);
        post.position.set(sx * w.x, w.y - w.h / 2, w.z);
        detail.add(post);
      }
      const blade = new THREE.Mesh(roundedBox(w.w, 0.05, w.chord, 0.02), w.painted ? paint : trim);
      blade.position.set(0, w.y, w.z);
      blade.rotation.x = -0.14;
      blade.castShadow = true;
      detail.add(blade);
    } else {
      const lip = new THREE.Mesh(roundedBox(w.w, 0.07, w.chord, 0.03), paint);
      lip.position.set(0, w.y, w.z);
      lip.rotation.x = -0.30;
      detail.add(lip);
    }
  }

  // roof / hood extras (blower, scoop, light bar, roof rack)
  for (const x of bp.extras || []) {
    let mesh;
    if (x.type === 'blower') {
      mesh = new THREE.Group();
      const b = new THREE.Mesh(roundedBox(0.44, 0.20, 0.42, 0.04), new THREE.MeshStandardMaterial({ color: 0x2b2e34, metalness: 0.8, roughness: 0.3 }));
      mesh.add(b);
      const scoop = new THREE.Mesh(roundedBox(0.40, 0.14, 0.34, 0.05), chromeMaterial({ color: '#b9bec6', rough: 0.25 }));
      scoop.position.y = 0.17; mesh.add(scoop);
      for (let i = 0; i < 4; i++) {
        const t = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.10, 10), chrome);
        t.position.set(-0.12 + i * 0.08, 0.26, 0); mesh.add(t);
      }
    } else if (x.type === 'scoop') {
      mesh = new THREE.Mesh(roundedBox(x.w ?? 0.5, 0.10, x.d ?? 0.5, 0.05), x.painted ? paint : trim);
    } else if (x.type === 'lightbar') {
      mesh = new THREE.Group();
      const bar = new THREE.Mesh(roundedBox(x.w ?? 1.3, 0.12, 0.12, 0.03), trim);
      mesh.add(bar);
      const n = x.count ?? 6;
      for (let i = 0; i < n; i++) {
        const l = new THREE.Mesh(new THREE.CircleGeometry(0.055, 14), emissiveMaterial({ color: '#fff3d8', intensity: 2.2 }));
        l.position.set(-(x.w ?? 1.3) / 2 + 0.12 + i * (((x.w ?? 1.3) - 0.24) / (n - 1)), 0, 0.065);
        mesh.add(l);
      }
    } else if (x.type === 'rack') {
      mesh = new THREE.Group();
      for (const sx of [-1, 1]) {
        const rail = new THREE.Mesh(roundedBox(0.06, 0.06, x.d ?? 1.2, 0.02), trim);
        rail.position.set(sx * (x.w ?? 0.7) / 2, 0, 0); mesh.add(rail);
      }
      for (let i = 0; i < 4; i++) {
        const cross = new THREE.Mesh(roundedBox(x.w ?? 0.7, 0.05, 0.05, 0.02), trim);
        cross.position.z = -(x.d ?? 1.2) / 2 + 0.15 + i * ((x.d ?? 1.2) - 0.3) / 3;
        mesh.add(cross);
      }
    } else if (x.type === 'snorkel') {
      mesh = new THREE.Group();
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 1.0, 12), trim);
      mesh.add(tube);
      const head = new THREE.Mesh(roundedBox(0.16, 0.22, 0.16, 0.04), trim);
      head.position.y = 0.58; mesh.add(head);
    }
    if (!mesh) continue;
    mesh.position.set(x.x ?? 0, x.y, x.z);
    if (x.ry) mesh.rotation.y = x.ry;
    mesh.traverse?.((o) => { if (o.isMesh) o.castShadow = true; });
    detail.add(mesh);
  }

  car.add(detail);
  car.add(contactShadow(bp.dims.width * 1.25, bp.dims.length * 1.05));

  if (envMap) car.traverse((o) => { if (o.isMesh && o.material && 'envMap' in o.material) o.material.envMap = envMap; });
  car.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

  car.userData = {
    spec: bp.spec,
    blueprint: bp,
    wheels,
    steerWheels: [wheels[0], wheels[1]],
    body: bodyGroup,
    lights,
    exhausts,
    dims: bp.dims,
    paintMaterial: paint,
  };
  return car;
}

/** Recolour an assembled car in place (used by the garage colour picker). */
export function recolor(car, color) {
  const bp = car.userData.blueprint;
  const m = car.userData.paintMaterial;
  if (bp.livery) {
    m.map?.dispose();
    m.map = liveryTexture({ base: color, ...bp.livery });
    m.needsUpdate = true;
  } else {
    m.color.set(color);
  }
}

export { clamp };

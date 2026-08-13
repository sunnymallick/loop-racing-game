import * as THREE from 'three';
import {
  loftBody, loftBand, profileU, roundedBox, buildWheel, wheelWell, archLip, paintMaterial, glassMaterial,
  chromeMaterial, darkTrimMaterial, plasticMaterial, carbonMaterial, emissiveMaterial,
  contactShadow, lightUnit, grilleMesh, ventMesh, bodyPaintTexture, liveryTexture, mergeByMaterial,
} from './kit.js';
import { lerp, clamp, RNG } from '../core/rng.js';

/**
 * Blueprint → car.
 *
 * A car is built in three lofted pieces plus a detail pass:
 *
 *   1. the TUB      — one closed loft from the ground to the beltline. Its top surface is the
 *                     bonnet at the front, the boot lid at the rear, and a RECESS between them
 *                     (yDeck below yBelt) that the cabin sits in, so the interior is a real hole
 *                     in the body rather than a decal.
 *   2. the GLASSHOUSE — a second closed loft from the beltline to the roof, in glass. It is one
 *                     continuous surface, so the windscreen, side glass and backlight share a
 *                     tumblehome and meet without seams.
 *   3. the PILLARS/ROOF — paint bands (loftBand) taken from *the same* glasshouse sections, so an
 *                     A-pillar, a B-pillar, a fastback sail and the roof panel fit with zero gap.
 *                     Whatever is not covered by a band is a window.
 *
 * Builders own the blueprints in tuner.js / muscle.js / suv.js / supercar.js. What must stay
 * stable is the RETURN CONTRACT, because physics, camera, FX and race code all read it:
 *
 *   group.userData = {
 *     spec, blueprint,
 *     wheels: [FL, FR, RL, RR],              // each with .userData.radius and .userData.spin
 *     steerWheels: [FL, FR],
 *     body,                                  // the group that rolls & pitches
 *     lights: { head:[], tail:[], brake:[], reverse:[] },
 *     exhausts: [THREE.Object3D],            // world anchors for nitrous/backfire FX
 *     dims, paintMaterial,
 *   }
 */

// ------------------------------------------------------------------ cross-sections

/**
 * A 12-point half cross-section of the tub. x is half-width, y is up.
 *
 *   0 underbody centre · 1 floor · 2 rocker under · 3 rocker (tucked) · 4 lower door
 *   5 CHARACTER LINE (widest) · 6 just above the crease · 7 shoulder · 8 belt roll
 *   9 deck edge · 10 deck crown · 11 deck centre
 *
 * Vary `w`, `flare`, `rocker` and `belt` down the length and the car gets shoulders, haunches and
 * a tucked rocker. Duplicate a station 0.04 apart to keep an edge crisp.
 */
export function bodySection(z, {
  w = 0.95, y0 = 0.22, floor = 0.62, rocker = 0.90, ySill = 0.45,
  yBelt = 1.00, belt = 0.94, yDeck = 1.04, deck = 0.80, crown = 0.03,
  flare = 1.0, crease = 0.62, tuckY = 0.55,
}) {
  const d = yBelt - ySill;
  return {
    z,
    pts: [
      [0, y0],
      [w * floor, y0],
      [w * rocker * 0.985, lerp(y0, ySill, tuckY)],
      [w * rocker, ySill],
      [w * 0.982 * flare, ySill + d * (crease - 0.28)],
      [w * flare, ySill + d * crease],
      [w * 0.984 * flare, ySill + d * (crease + 0.10)],
      [w * belt, yBelt],
      [w * belt * 0.955, lerp(yBelt, yDeck, 0.45)],
      [w * deck, yDeck],
      [w * deck * 0.54, yDeck + crown * 0.78],
      [0, yDeck + crown],
    ],
  };
}

/** A 9-point half cross-section of the glasshouse: belt → tumblehome → roof. */
function cabinSection(st) {
  const h = Math.max(0.02, st.yRoof - st.yBelt);
  const hw = st.hw, rw = st.rw, crown = st.crown ?? 0.012;
  return {
    z: st.z,
    pts: [
      [0, st.yBelt],
      [hw * 0.55, st.yBelt],
      [hw, st.yBelt],
      [hw * 0.995, st.yBelt + h * 0.26],
      [lerp(hw, rw, 0.60), st.yBelt + h * 0.70],
      [rw * 1.012, st.yRoof - h * 0.14],
      [rw, st.yRoof],
      [rw * 0.55, st.yRoof + crown],
      [0, st.yRoof + crown],
    ],
  };
}

function sampleStation(list, z) {
  const stations = list[0].z <= list[list.length - 1].z ? list : [...list].reverse();
  if (z <= stations[0].z) return { ...stations[0], z };
  const last = stations[stations.length - 1];
  if (z >= last.z) return { ...last, z };
  for (let i = 1; i < stations.length; i++) {
    if (z <= stations[i].z) {
      const a = stations[i - 1], b = stations[i];
      const t = (z - a.z) / ((b.z - a.z) || 1);
      const out = { z };
      for (const k of ['hw', 'rw', 'yBelt', 'yRoof', 'crown']) {
        out[k] = lerp(a[k] ?? 0, b[k] ?? 0, t);
      }
      return out;
    }
  }
  return { ...last, z };
}

/**
 * The widest half-width of the tub at any z — i.e. where the flank actually IS.
 *
 * Arches, sills and mirrors have to be placed off this, not off `dims.width`, or a bolt-on ends up
 * hanging in space next to the car (round-1 note on the Dominator's front bar).
 */
function flankSampler(tubSections) {
  const secs = [...tubSections].sort((a, b) => a.z - b.z);
  const halfOf = (s) => Math.max(...s.pts.map((p) => p[0]));
  return (z) => {
    if (z <= secs[0].z) return halfOf(secs[0]);
    const last = secs[secs.length - 1];
    if (z >= last.z) return halfOf(last);
    for (let i = 1; i < secs.length; i++) {
      if (z <= secs[i].z) {
        const a = secs[i - 1], b = secs[i];
        const t = (z - a.z) / ((b.z - a.z) || 1);
        return lerp(halfOf(a), halfOf(b), t);
      }
    }
    return halfOf(last);
  };
}

/** Dense cabin sections over [z0,z1], always including every authored station in range. */
function cabinRange(stations, za, zb, steps = 8) {
  const z0 = Math.min(za, zb), z1 = Math.max(za, zb);
  const zs = new Set();
  for (let i = 0; i <= steps; i++) zs.add(+(z0 + (z1 - z0) * (i / steps)).toFixed(4));
  for (const s of stations) if (s.z > z0 && s.z < z1) zs.add(+s.z.toFixed(4));
  return [...zs].sort((a, b) => a - b).map((z) => cabinSection(sampleStation(stations, z)));
}

// ------------------------------------------------------------------ assembly

export function assembleCar(bp, { color = null, rng = new RNG(1), envMap = null } = {}) {
  const car = new THREE.Group();
  car.name = bp.id;
  const paintColor = color || bp.colors[0];

  // ---------------- materials ----------------
  const tubSections = bp.body.map((s) => bodySection(s.z, s));
  const anchors = profileU(tubSections);
  const liveryCfg = { ...(bp.livery || {}), anchors, base: paintColor };
  /**
   * Three paint materials off one livery, because they are mapped in three different UV spaces:
   *   paint       the tub — the loft's own skin, where every shut line and panel gap is authored.
   *   paintUpper  roof / pillar bands — SAME u (so a stripe runs over the roof) but their v is
   *               normalised over the cabin, not the car, so the body's shut lines and badge would
   *               land in the middle of the roof. Round 2 printed the badge on the SUV's roof.
   *   paintSolid  bolt-ons built from roundedBox/Extrude, whose UVs are raw object-space metres.
   *               Round 2 mapped those straight onto the livery canvas, which is what put the
   *               "misregistered orange rectangle with a circle in it" on the SUV tailgate.
   */
  const lp = bp.livery?.panels || {};
  const upperCfg = {
    ...liveryCfg,
    panels: { stripeWidth: lp.stripeWidth, stripeGap: lp.stripeGap, splitIndex: lp.splitIndex, badge: false },
  };
  const mkPaint = (map) => paintMaterial({
    color: map ? '#ffffff' : paintColor, map,
    metalness: bp.paint?.metalness ?? 0.30,
    roughness: bp.paint?.roughness ?? 0.30,
    clearcoat: bp.paint?.clearcoat ?? 1.0,
    clearcoatRoughness: bp.paint?.clearcoatRoughness ?? 0.045,
    envIntensity: bp.paint?.envIntensity ?? 0.95,
    flake: bp.paint?.flake ?? 0.55,
    seed: 3,
  });
  const paint = mkPaint(bodyPaintTexture(liveryCfg));
  const paintUpper = mkPaint(bodyPaintTexture(upperCfg));
  paintUpper.side = THREE.DoubleSide;
  const paintSolid = mkPaint(null);
  paint.userData.livery = liveryCfg;
  paint.userData.upper = { mat: paintUpper, cfg: upperCfg };
  paint.userData.solids = [paintSolid];
  const glass = glassMaterial(bp.glass || {});
  glass.name = 'glass';
  const chrome = chromeMaterial(bp.chrome || {});
  const trim = darkTrimMaterial(bp.darkTrim || {});
  const plastic = plasticMaterial();
  const carbon = carbonMaterial();
  const shellOf = (m) => {
    if (!m.userData.__shell) {
      const c = m.clone();
      c.side = THREE.DoubleSide;
      m.userData.__shell = c;
      (m.userData.shells ||= []).push(c);
    }
    return m.userData.__shell;
  };
  const matOf = (name) => (
    name === 'chrome' ? chrome : name === 'paint' ? paintSolid : name === 'carbon' ? carbon
      : name === 'plastic' ? plastic : name === 'glass' ? glass : trim);

  const bodyGroup = new THREE.Group();
  bodyGroup.name = 'body';
  car.add(bodyGroup);

  // ---------------- 1. the tub ----------------
  const tub = new THREE.Mesh(loftBody(tubSections), paint);
  tub.name = 'shell';
  bodyGroup.add(tub);

  // ---------------- 2. the glasshouse ----------------
  const lights = { head: [], tail: [], brake: [], reverse: [] };
  if (bp.cabin) {
    const cb = bp.cabin;
    const st = cb.stations[0].z <= cb.stations[cb.stations.length - 1].z
      ? cb.stations : [...cb.stations].reverse();
    const zA = st[0].z, zB = st[st.length - 1].z;
    const shell = new THREE.Mesh(loftBody(cabinRange(st, zA, zB, 14), { capFront: false, capRear: false }), glass);
    shell.name = 'glasshouse';
    shell.castShadow = false;
    shell.renderOrder = 4;
    bodyGroup.add(shell);

    // roof panel — a paint band over the top of the very same sections
    if (cb.roof) {
      const roofGeo = loftBand(cabinRange(st, cb.roof.z0, cb.roof.z1, 8), cb.roof.a ?? 5, 16 - (cb.roof.a ?? 5), {
        offset: cb.roof.offset ?? 0.014, side: 'right',
      });
      const rm = cb.roof.mat || 'paint';
      bodyGroup.add(new THREE.Mesh(roofGeo, rm === 'paint' ? paintUpper : shellOf(matOf(rm))));
    }
    // pillars and sails
    for (const p of cb.pillars || []) {
      const g = loftBand(cabinRange(st, p.z0, p.z1, p.steps ?? 4), p.a, p.b, {
        offset: p.offset ?? 0.013, side: 'both',
      });
      bodyGroup.add(new THREE.Mesh(g, p.mat === 'paint' ? paintUpper : shellOf(p.mat === 'chrome' ? chrome : trim)));
    }
    // beltline trim: the bright strip that runs under the side glass on every real car
    if (cb.belt !== false) {
      const g = loftBand(cabinRange(st, cb.beltZ0 ?? zA, cb.beltZ1 ?? zB, 10), 1, 2, {
        offset: 0.016, side: 'both',
      });
      bodyGroup.add(new THREE.Mesh(g, shellOf(cb.beltMat === 'chrome' ? chrome : trim)));
    }

    // ---------------- interior ----------------
    bodyGroup.add(mergeByMaterial(buildInterior(cb, trim, chrome)));
  }

  // ---------------- 3. wheels, arches, wells ----------------
  const wheels = [];
  const wb = bp.dims.wheelbase;
  const trF = bp.dims.track, trR = bp.dims.trackRear ?? bp.dims.track;
  const wheelMarks = [];
  const flankAt = flankSampler(tubSections);
  for (let i = 0; i < 4; i++) {
    const isFront = i < 2;
    const cfg = isFront ? bp.wheels.front : bp.wheels.rear;
    const tr = isFront ? trF : trR;
    const sx = (i % 2 === 0) ? -1 : 1;
    const pz = isFront ? wb / 2 : -wb / 2;

    const holder = new THREE.Group();                       // steering pivot
    const wheel = buildWheel({
      ...cfg, style: cfg.style || bp.wheels.style,
      rimColor: cfg.rimColor || bp.wheels.rimColor,
      caliperColor: cfg.caliperColor || bp.wheels.caliperColor,
      capColor: bp.wheels.capColor,
      lipColor: bp.wheels.lipColor,
      // beadlock was declared on bp.wheels but never forwarded, so the SUV's bronze clamp ring and
      // its twelve bolts — the single most legible wheel detail at distance — never rendered.
      beadlock: cfg.beadlock ?? bp.wheels.beadlock ?? false,
      tire: cfg.tire || bp.wheels.tire || 'street',
    });
    if (sx > 0) wheel.rotation.y = Math.PI;                  // face the dish outward on both sides
    holder.add(wheel);
    holder.position.set(sx * tr / 2, cfg.radius, pz);
    holder.userData.radius = cfg.radius;
    holder.userData.spin = wheel.getObjectByName('spin');
    holder.name = ['FL', 'FR', 'RL', 'RR'][i];
    car.add(holder);
    wheels.push(holder);
    wheelMarks.push({ x: sx * tr / 2, z: pz, r: cfg.radius });

    // --- the arch OPENING ------------------------------------------------
    // Everything here is measured off the tyre and off the real body flank at this station, so
    // there is no daylight between the tyre, the well and the lip (§6.1 caps a floating arch at 60).
    const tyreOuter = cfg.width * 0.5;                        // outer sidewall, relative to hub
    const flank = flankAt(pz) - Math.abs(tr / 2);             // body surface, relative to hub
    const openR = cfg.radius * (bp.archGap ?? 1.055);         // ~one finger above the tyre crown
    const flare = cfg.flare ?? bp.archFlare ?? 0.055;
    const xOut = Math.max(tyreOuter + 0.012, flank + flare);  // the lip must clear the tyre
    const xIn = Math.min(flank - 0.012, xOut - 0.045);

    // dark inner fender, radius-matched to the OPENING so the gap above the tyre reads as shadow
    const wLo = -tyreOuter * 1.25, wHi = xOut - 0.004;
    const well = wheelWell(openR * 1.012, wHi - wLo);
    well.position.set(sx * (tr / 2 + (wHi + wLo) * 0.5), cfg.radius, pz);
    well.scale.x = sx;
    bodyGroup.add(well);

    if (bp.arches !== false) {
      // the lip is skinned in the tub's own UV space: u walks the rocker→character-line band, v
      // tracks real z, so the flare wears the same paint (and two-tone split) as the flank it grows
      // out of instead of sampling an arbitrary slice of the livery canvas.
      const zLen = bp.dims.length;
      const geo = archLip({
        r: openR,
        span: Math.PI * (bp.archSpan ?? 1.03),
        xIn, xOut,
        t: bp.archThickness ?? 0.05,
        lift: bp.archLift ?? 0,
        uLo: anchors[3] * 0.55, uHi: anchors[5] * 0.98,
        vAt: (pz + zLen / 2) / zLen, vPerMetre: 1 / zLen,
      });
      const arch = new THREE.Mesh(geo, shellOf(bp.blackArches ? plastic : paint));
      arch.position.set(sx * (tr / 2), cfg.radius, pz);
      arch.scale.x = sx;                                      // +X is always outboard
      bodyGroup.add(arch);
    }
  }

  // ---------------- 4. lights + detail ----------------
  const detail = new THREE.Group();
  detail.name = 'detail';
  bodyGroup.add(detail);

  const addLight = (cfg, bucket, yaw) => {
    for (const sx of cfg.mirror === false ? [1] : [-1, 1]) {
      const u = lightUnit({
        w: cfg.w, h: cfg.h, color: cfg.color, intensity: cfg.intensity ?? 3.0,
        shape: cfg.shape, glow: cfg.glow ?? 0.85, bezel: cfg.bezel !== false, segs: cfg.segs ?? 0,
      });
      u.position.set(sx * cfg.x, cfg.y, cfg.z);
      u.rotation.y = yaw;
      if (cfg.rx) u.rotation.x = cfg.rx;
      u.userData.noMerge = true;          // physics.js drives children[0] and 'glow' by name
      bodyGroup.add(u);
      // the housing and bezel are static — lift them out so they join the batched detail mesh
      u.updateMatrix();
      for (const part of u.children.filter((o) => ['housing', 'bezel', 'rib'].includes(o.name))) {
        part.updateMatrix();
        const m = new THREE.Matrix4().multiplyMatrices(u.matrix, part.matrix);
        part.removeFromParent();
        m.decompose(part.position, part.quaternion, part.scale);
        detail.add(part);
      }
      bucket.push(u);
    }
  };
  for (const h of bp.lights?.head || []) addLight({ color: '#e8f0ff', ...h }, lights.head, 0);
  for (const t of bp.lights?.tail || []) {
    const before = lights.tail.length;
    addLight({ color: '#ff2010', intensity: 2.6, ...t }, lights.tail, Math.PI);
    if (t.brake !== false) for (let i = before; i < lights.tail.length; i++) lights.brake.push(lights.tail[i]);
  }
  for (const r of bp.lights?.reverse || []) addLight({ color: '#fff4e0', intensity: 1.6, glow: 0.35, ...r }, lights.reverse, Math.PI);

  // ---------------- 5. detail pass ----------------
  // grille(s)
  for (const gr of bp.grilles || (bp.grille ? [bp.grille] : [])) {
    const g = grilleMesh({
      w: gr.w, h: gr.h, d: gr.d ?? 0.14, slats: gr.slats ?? 8,
      vertical: gr.vertical, frame: gr.frame ?? 'chrome', mesh: gr.mesh,
    });
    g.position.set(gr.x ?? 0, gr.y, gr.z);
    if (gr.rx) g.rotation.x = gr.rx;
    if (gr.ry) g.rotation.y = gr.ry;
    detail.add(g);
    if (gr.mirror) {
      const g2 = g.clone();
      g2.position.x = -(gr.x ?? 0);
      if (gr.ry) g2.rotation.y = -gr.ry;
      detail.add(g2);
    }
  }

  // vents / intakes / louvres
  for (const v of bp.vents || []) {
    for (const sx of v.mirror === false ? [1] : [-1, 1]) {
      const m = ventMesh({ w: v.w, h: v.h, fins: v.fins ?? 4, angle: v.angle ?? 0.5 });
      m.position.set(sx * (v.x ?? 0), v.y, v.z);
      m.rotation.set(v.rx ?? 0, sx * (v.ry ?? 0), v.rz ?? 0);
      detail.add(m);
    }
  }

  // mirrors — a stalk plus a teardrop cap plus a real mirror face
  if (bp.mirrors) {
    const mi = bp.mirrors;
    for (const sx of [-1, 1]) {
      const arm = new THREE.Mesh(roundedBox(0.13, 0.045, 0.06, 0.02), trim);
      arm.position.set(sx * mi.x, mi.y, mi.z);
      arm.rotation.z = sx * -0.35;
      detail.add(arm);
      const cap = new THREE.Mesh(roundedBox(0.175, 0.10, 0.10, 0.042), mi.painted ? paintSolid : trim);
      cap.position.set(sx * (mi.x + 0.10), mi.y + 0.035, mi.z);
      detail.add(cap);
      const face = new THREE.Mesh(new THREE.PlaneGeometry(0.13, 0.075), chromeMaterial({ color: '#aeb6c2', rough: 0.05 }));
      face.position.set(sx * (mi.x + 0.10), mi.y + 0.035, mi.z - 0.052);
      face.rotation.y = Math.PI;
      detail.add(face);
    }
  }

  // door handles
  for (const hcfg of bp.handles || []) {
    for (const sx of [-1, 1]) {
      const h = new THREE.Mesh(roundedBox(0.035, 0.045, 0.16, 0.018), hcfg.mat === 'paint' ? paintSolid : chrome);
      h.position.set(sx * hcfg.x, hcfg.y, hcfg.z);
      detail.add(h);
    }
  }

  // trim strips / sills / bumpers / splitters
  for (const t of bp.trim || []) {
    const g = new THREE.Mesh(roundedBox(t.w, t.h, t.d, t.r ?? 0.02), matOf(t.mat));
    g.position.set(t.x ?? 0, t.y, t.z);
    if (t.rx) g.rotation.x = t.rx;
    if (t.ry) g.rotation.y = t.ry;
    if (t.rz) g.rotation.z = t.rz;
    detail.add(g);
    if (t.mirror) {
      const g2 = g.clone();
      g2.position.x = -(t.x ?? 0);
      if (t.rz) g2.rotation.z = -t.rz;
      if (t.ry) g2.rotation.y = -t.ry;
      detail.add(g2);
    }
  }

  // exhausts — a tailpipe running forward under the car, a dark cut-out in the valance it exits
  // through, and a chrome tip with a real bore. Round 1 left the tips floating in mid air.
  const exhausts = [];
  for (const e of bp.exhaust || []) {
    for (const sx of e.mirror === false ? [0] : [-1, 1]) {
      const tip = new THREE.Group();
      // the dark aperture the pipe comes out of — without it a tip reads as a ring stuck on air
      const aperture = new THREE.Mesh(
        roundedBox(e.r * 3.0, e.r * 2.5, 0.07, e.r * 0.8),
        new THREE.MeshStandardMaterial({ color: 0x0a0b0e, roughness: 0.9, metalness: 0.25 }),
      );
      aperture.position.z = (e.len ?? 0.22) * 0.62;
      tip.add(aperture);
      // tailpipe forward into the underbody
      const pipe = new THREE.Mesh(new THREE.CylinderGeometry(e.r * 0.72, e.r * 0.72, 0.62, 10), trim);
      pipe.rotation.x = Math.PI / 2;
      pipe.position.set(0, e.r * 0.20, (e.len ?? 0.22) * 0.5 + 0.31);
      tip.add(pipe);
      const hanger = new THREE.Mesh(roundedBox(e.r * 0.5, e.r * 1.6, e.r * 0.5, 0.01), trim);
      hanger.position.set(0, e.r * 1.0, (e.len ?? 0.22) * 0.5 + 0.24);
      tip.add(hanger);
      const outer = new THREE.Mesh(
        new THREE.CylinderGeometry(e.r, e.r * 1.05, e.len ?? 0.22, 16, 1, true),
        e.mat === 'dark' ? trim : chromeMaterial({ color: '#c4c9d1', rough: 0.16 }),
      );
      outer.rotation.x = Math.PI / 2;
      outer.material = shellOf(outer.material);
      tip.add(outer);
      const bore = new THREE.Mesh(new THREE.CircleGeometry(e.r * 0.86, 16),
        new THREE.MeshStandardMaterial({ color: 0x08090b, roughness: 0.95 }));
      bore.rotation.y = Math.PI;
      bore.position.z = -(e.len ?? 0.22) * 0.30;
      tip.add(bore);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(e.r * 0.98, e.r * 0.14, 6, 16), chromeMaterial({ color: '#d6dae0', rough: 0.1 }));
      ring.position.z = -(e.len ?? 0.22) * 0.48;
      tip.add(ring);
      tip.position.set(sx * e.x, e.y, e.z);
      detail.add(tip);

      const anchor = new THREE.Object3D();
      anchor.position.set(sx * e.x, e.y, e.z - 0.12);
      car.add(anchor);
      exhausts.push(anchor);
    }
  }

  // wings / spoilers
  if (bp.wing) {
    const w = bp.wing;
    const bladeMat = w.mat === 'paint' ? paintSolid : w.mat === 'carbon' ? carbon : trim;
    if (w.type === 'pedestal') {
      // Tall twin-element JDM GT wing: two uprights standing off the deck, a main plane, a slotted
      // upper flap above and behind it, a gurney and full end plates. Deliberately nothing like the
      // supercar's swan-neck (round-2 note: both cars wore the same flat rectangle on two posts).
      for (const sx of [-1, 1]) {
        const post = new THREE.Mesh(roundedBox(0.045, w.h, 0.15, 0.018), w.postMat === 'chrome' ? chrome : trim);
        post.position.set(sx * w.x, w.y - w.h / 2, w.z + 0.02);
        post.rotation.x = 0.16;
        detail.add(post);
        const foot = new THREE.Mesh(roundedBox(0.11, 0.028, 0.20, 0.012), w.postMat === 'chrome' ? chrome : trim);
        foot.position.set(sx * w.x, w.y - w.h + 0.012, w.z + 0.04);
        detail.add(foot);
      }
      const blade = new THREE.Mesh(roundedBox(w.w, 0.042, w.chord, 0.02), bladeMat);
      blade.position.set(0, w.y, w.z);
      blade.rotation.x = w.aoa ?? -0.16;
      detail.add(blade);
      const flap = new THREE.Mesh(roundedBox(w.w * 0.96, 0.030, w.chord * 0.42, 0.014), bladeMat);
      flap.position.set(0, w.y + 0.075, w.z - w.chord * 0.44);
      flap.rotation.x = (w.aoa ?? -0.16) - 0.22;
      detail.add(flap);
      // gurney flap — the detail that makes a wing look like an aero part
      const gur = new THREE.Mesh(roundedBox(w.w * 0.94, 0.032, 0.018, 0.007), bladeMat);
      gur.position.set(0, w.y + 0.098, w.z - w.chord * 0.60);
      detail.add(gur);
      for (const sx of [-1, 1]) {
        const plate = new THREE.Mesh(roundedBox(0.018, 0.175, w.chord * 1.16, 0.010), bladeMat);
        plate.position.set(sx * w.w * 0.5, w.y + 0.040, w.z - w.chord * 0.06);
        detail.add(plate);
      }
    } else if (w.type === 'swan') {
      // Swan-neck: the blade hangs UNDERNEATH curved arms that rise off the deck outboard of it,
      // and the end plates run the full chord. Low, wide and mounted at the quarters.
      for (const sx of [-1, 1]) {
        const arm = new THREE.Mesh(roundedBox(0.036, w.h, 0.10, 0.014), w.postMat === 'chrome' ? chrome : trim);
        arm.position.set(sx * w.x, w.y + w.h * 0.5 - 0.02, w.z + w.chord * 0.30);
        arm.rotation.x = -0.30;
        detail.add(arm);
        const hook = new THREE.Mesh(roundedBox(0.034, 0.030, 0.20, 0.012), w.postMat === 'chrome' ? chrome : trim);
        hook.position.set(sx * w.x, w.y + w.h - 0.03, w.z + w.chord * 0.12);
        hook.rotation.x = 0.36;
        detail.add(hook);
      }
      const blade = new THREE.Mesh(roundedBox(w.w, 0.038, w.chord, 0.018), bladeMat);
      blade.position.set(0, w.y, w.z);
      blade.rotation.x = w.aoa ?? -0.16;
      detail.add(blade);
      const gur = new THREE.Mesh(roundedBox(w.w * 0.96, 0.030, 0.016, 0.006), bladeMat);
      gur.position.set(0, w.y + 0.028, w.z - w.chord * 0.50);
      detail.add(gur);
      for (const sx of [-1, 1]) {
        const plate = new THREE.Mesh(roundedBox(0.018, 0.145, w.chord * 1.32, 0.010), bladeMat);
        plate.position.set(sx * w.w * 0.5, w.y + 0.028, w.z);
        plate.rotation.x = 0.06;
        detail.add(plate);
      }
    } else if (w.type === 'ducktail') {
      const lip = new THREE.Mesh(roundedBox(w.w, 0.075, w.chord, 0.035), bladeMat);
      lip.position.set(0, w.y, w.z);
      lip.rotation.x = w.aoa ?? -0.38;
      detail.add(lip);
    } else {
      const lip = new THREE.Mesh(roundedBox(w.w, 0.06, w.chord, 0.03), bladeMat);
      lip.position.set(0, w.y, w.z);
      lip.rotation.x = w.aoa ?? -0.30;
      detail.add(lip);
    }
  }

  // diffuser strakes
  if (bp.diffuser) {
    const d = bp.diffuser;
    const body = new THREE.Mesh(roundedBox(d.w, d.h, d.d, 0.02), d.mat === 'carbon' ? carbon : plastic);
    body.position.set(0, d.y, d.z);
    body.rotation.x = d.rx ?? 0.22;
    detail.add(body);
    const dm = d.mat === 'carbon' ? carbon : plastic;
    const n = d.strakes ?? 5;
    // Strakes stand PROUD of the diffuser floor and run past its trailing edge, so from behind they
    // read as fins in a tunnel. Round 2 buried them inside the box and the whole part was one slab.
    for (let i = 0; i < n; i++) {
      const s = new THREE.Mesh(roundedBox(0.026, d.h * 1.30, d.d * 1.06, 0.008), dm);
      s.position.set((-0.5 + (i + 0.5) / n) * d.w * 0.94, d.y + d.h * 0.10, d.z - 0.006);
      s.rotation.x = d.rx ?? 0.22;
      detail.add(s);
    }
    const lip = new THREE.Mesh(roundedBox(d.w * 1.02, 0.052, 0.05, 0.018), dm);
    lip.position.set(0, d.y + d.h * 0.62, d.z - d.d * 0.48);
    detail.add(lip);
  }

  // bespoke extras
  for (const x of bp.extras || []) detail.add(buildExtra(x, { paint: paintSolid, trim, chrome, plastic, carbon }));

  // ---------------- 6. batch, shadow, env ----------------
  bodyGroup.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = o.material !== glass;
    o.receiveShadow = true;
  });
  // A car built one primitive at a time is 250+ draw calls; eight on a grid will not hold 50 fps.
  const merged = mergeByMaterial(bodyGroup);
  merged.name = 'body';
  car.remove(bodyGroup);
  car.add(merged);

  car.add(contactShadow(bp.dims.width * 1.20, bp.dims.length * 1.02, wheelMarks));
  if (envMap) car.traverse((o) => { if (o.isMesh && o.material && 'envMap' in o.material) o.material.envMap = envMap; });

  car.userData = {
    spec: bp.spec,
    blueprint: bp,
    wheels,
    steerWheels: [wheels[0], wheels[1]],
    body: merged,
    lights,
    exhausts,
    dims: bp.dims,
    paintMaterial: paint,
  };
  void rng; void clamp; void liveryTexture; void emissiveMaterial;
  return car;
}

// ------------------------------------------------------------------ interior

/** Seats, dash, wheel, console, rear shelf — §7 caps a black-void cabin at 72. */
function buildInterior(cb, trim, chrome) {
  const g = new THREE.Group();
  g.name = 'interior';
  const it = cb.interior || {};
  const seatCol = it.seat ?? 0x24262e;
  const trimCol = it.trim ?? 0x15171c;
  const accent = it.accent ?? 0x7a1f24;
  const seatMat = new THREE.MeshStandardMaterial({ color: seatCol, roughness: 0.88, metalness: 0.03 });
  const accentMat = new THREE.MeshStandardMaterial({ color: accent, roughness: 0.80, metalness: 0.05 });
  const trimMat = new THREE.MeshStandardMaterial({ color: trimCol, roughness: 0.72, metalness: 0.12 });

  // Everything is placed in ABSOLUTE y so a car file can tune the cabin to its own roofline.
  const floorY = it.floorY ?? (cb.stations[0].yBelt - 0.26);
  const headY = it.headY ?? floorY + 0.46;             // headrest centre — sits above the belt
  const dashY = it.dashY ?? floorY + 0.24;
  const wheelY = it.wheelY ?? dashY + 0.05;
  const shelfY = it.shelfY ?? floorY + 0.22;
  const seatZ = it.seatZ ?? 0;
  const halfSeat = it.seatX ?? 0.33;
  const backBot = floorY + 0.14, backTop = headY - 0.05;
  const backH = Math.max(0.20, backTop - backBot);
  const backY = (backTop + backBot) / 2;

  for (const sx of [-1, 1]) {
    const base = new THREE.Mesh(roundedBox(0.42, 0.11, 0.46, 0.05), seatMat);
    base.position.set(sx * halfSeat, floorY + 0.075, seatZ);
    g.add(base);
    for (const bx of [-1, 1]) {
      const bol = new THREE.Mesh(roundedBox(0.085, 0.09, 0.42, 0.035), accentMat);
      bol.position.set(sx * halfSeat + bx * 0.175, floorY + 0.115, seatZ);
      g.add(bol);
    }
    const back = new THREE.Mesh(roundedBox(0.40, backH, 0.11, 0.05), seatMat);
    back.position.set(sx * halfSeat, backY, seatZ - 0.21);
    back.rotation.x = -0.20;
    g.add(back);
    for (const bx of [-1, 1]) {
      const bol = new THREE.Mesh(roundedBox(0.075, backH * 0.92, 0.10, 0.035), accentMat);
      bol.position.set(sx * halfSeat + bx * 0.165, backY, seatZ - 0.195);
      bol.rotation.x = -0.20;
      g.add(bol);
    }
    const head = new THREE.Mesh(roundedBox(0.19, 0.13, 0.09, 0.04), seatMat);
    head.position.set(sx * halfSeat, headY, seatZ - 0.30);
    g.add(head);
    const strap = new THREE.Mesh(roundedBox(0.045, backH * 0.86, 0.012, 0.005), accentMat);
    strap.position.set(sx * halfSeat - 0.085, backY + 0.02, seatZ - 0.145);
    strap.rotation.set(-0.20, 0, 0.18);
    g.add(strap);
  }

  // dash + cowl + instrument cluster + centre stack
  const dashZ = seatZ + (it.dashZ ?? 0.62);
  const dash = new THREE.Mesh(roundedBox((it.dashW ?? 1.30), 0.16, 0.30, 0.06), trimMat);
  dash.position.set(0, dashY, dashZ);
  dash.rotation.x = 0.16;
  g.add(dash);
  const cowl = new THREE.Mesh(roundedBox(0.48, 0.085, 0.20, 0.04), trimMat);
  cowl.position.set(-halfSeat * (it.rhd ? -1 : 1), dashY + 0.085, dashZ - 0.05);
  g.add(cowl);
  const cluster = new THREE.Mesh(new THREE.PlaneGeometry(0.30, 0.095),
    emissiveMaterial({ color: it.clusterColor ?? '#39c8ff', intensity: 1.3 }));
  cluster.position.set(-halfSeat * (it.rhd ? -1 : 1), dashY + 0.055, dashZ - 0.14);
  cluster.rotation.x = -0.42;
  g.add(cluster);

  const console3 = new THREE.Mesh(roundedBox(0.19, 0.13, 0.60, 0.045), trimMat);
  console3.position.set(0, floorY + 0.10, seatZ + 0.20);
  g.add(console3);
  const shifter = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.020, 0.16, 8), trimMat);
  shifter.position.set(0, floorY + 0.22, seatZ + 0.16);
  g.add(shifter);
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.032, 10, 8), chrome);
  knob.position.set(0, floorY + 0.30, seatZ + 0.16);
  g.add(knob);

  // steering wheel: rim + three spokes + boss
  const swX = -halfSeat * (it.rhd ? -1 : 1);
  const swY = wheelY;
  const swZ = dashZ - 0.18;
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.145, 0.022, 8, 24), trimMat);
  rim.position.set(swX, swY, swZ);
  rim.rotation.x = 1.20;
  g.add(rim);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.5;
    const sp = new THREE.Mesh(roundedBox(0.035, 0.145, 0.016, 0.008), trimMat);
    sp.position.set(swX + Math.cos(a) * 0.075, swY + Math.sin(a) * 0.075 * Math.cos(1.2), swZ + Math.sin(a) * 0.075 * Math.sin(1.2));
    sp.rotation.set(1.20, 0, -a + Math.PI / 2);
    g.add(sp);
  }
  const boss = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.03, 12), accentMat);
  boss.position.set(swX, swY, swZ);
  boss.rotation.x = 1.20;
  g.add(boss);

  // rear bulkhead / parcel shelf so you don't see daylight through the cabin
  const shelf = new THREE.Mesh(roundedBox((it.dashW ?? 1.30) * 0.98, 0.09, 0.30, 0.04), trimMat);
  shelf.position.set(0, shelfY, seatZ - (it.shelfZ ?? 0.62));
  g.add(shelf);

  if (it.rollBar) {
    const barMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, metalness: 0.9, roughness: 0.3 });
    const bar = new THREE.Mesh(roundedBox(halfSeat * 2 + 0.30, 0.05, 0.05, 0.02), barMat);
    bar.position.set(0, headY + 0.06, seatZ - 0.40);
    g.add(bar);
    for (const sx of [-1, 1]) {
      const leg = new THREE.Mesh(roundedBox(0.05, headY + 0.06 - floorY, 0.05, 0.02), barMat);
      leg.position.set(sx * (halfSeat + 0.14), (headY + 0.06 + floorY) / 2, seatZ - 0.40);
      g.add(leg);
    }
  }

  g.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = true; } });
  void trim;
  return g;
}

// ------------------------------------------------------------------ extras

function buildExtra(x, mats) {
  const { paint, trim, chrome, plastic, carbon } = mats;
  let mesh = null;
  if (x.type === 'blower') {
    mesh = new THREE.Group();
    const b = new THREE.Mesh(roundedBox(0.46, 0.22, 0.44, 0.04),
      new THREE.MeshStandardMaterial({ color: 0x24272d, metalness: 0.85, roughness: 0.28 }));
    mesh.add(b);
    for (let i = 0; i < 3; i++) {
      const rib = new THREE.Mesh(roundedBox(0.50, 0.03, 0.05, 0.012), chromeMaterial({ color: '#9aa0a8', rough: 0.3 }));
      rib.position.set(0, -0.05 + i * 0.09, 0.20);
      mesh.add(rib);
    }
    const scoop = new THREE.Mesh(roundedBox(0.42, 0.16, 0.36, 0.05), chromeMaterial({ color: '#c2c7cf', rough: 0.16 }));
    scoop.position.y = 0.19; scoop.rotation.x = -0.06;
    mesh.add(scoop);
    const mouth = new THREE.Mesh(roundedBox(0.34, 0.10, 0.03, 0.02), plastic);
    mouth.position.set(0, 0.20, 0.185);
    mesh.add(mouth);
    for (let i = 0; i < 8; i++) {
      const t = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.34, 8), chromeMaterial({ color: '#d0d5dc', rough: 0.12 }));
      const side = i < 4 ? -1 : 1;
      t.position.set(side * 0.26, -0.02, -0.14 + (i % 4) * 0.10);
      t.rotation.z = side * 0.9;
      mesh.add(t);
    }
  } else if (x.type === 'scoop') {
    mesh = new THREE.Group();
    const shell = new THREE.Mesh(roundedBox(x.w ?? 0.5, x.h ?? 0.11, x.d ?? 0.5, 0.05), x.painted ? paint : trim);
    mesh.add(shell);
    const mouth = new THREE.Mesh(roundedBox((x.w ?? 0.5) * 0.8, (x.h ?? 0.11) * 0.7, 0.04, 0.02), plastic);
    mouth.position.set(0, 0.005, (x.d ?? 0.5) * 0.5);
    mesh.add(mouth);
  } else if (x.type === 'lightbar') {
    mesh = new THREE.Group();
    const bar = new THREE.Mesh(roundedBox(x.w ?? 1.3, 0.13, 0.13, 0.03), trim);
    mesh.add(bar);
    const n = x.count ?? 6;
    for (let i = 0; i < n; i++) {
      const px = -(x.w ?? 1.3) / 2 + 0.12 + i * (((x.w ?? 1.3) - 0.24) / (n - 1));
      const housing = new THREE.Mesh(new THREE.CylinderGeometry(0.062, 0.062, 0.09, 12), trim);
      housing.rotation.x = Math.PI / 2; housing.position.set(px, 0, 0.03);
      mesh.add(housing);
      const l = new THREE.Mesh(new THREE.CircleGeometry(0.052, 14), emissiveMaterial({ color: '#fff1cf', intensity: 2.6 }));
      l.position.set(px, 0, 0.08);
      mesh.add(l);
    }
    for (const sx of [-1, 1]) {
      const leg = new THREE.Mesh(roundedBox(0.05, 0.16, 0.05, 0.015), trim);
      leg.position.set(sx * (x.w ?? 1.3) * 0.42, -0.13, 0);
      mesh.add(leg);
    }
  } else if (x.type === 'rack') {
    mesh = new THREE.Group();
    for (const sx of [-1, 1]) {
      const rail = new THREE.Mesh(roundedBox(0.055, 0.075, x.d ?? 1.2, 0.02), trim);
      rail.position.set(sx * (x.w ?? 0.7) / 2, 0.03, 0);
      mesh.add(rail);
      for (let i = 0; i < 4; i++) {
        const foot = new THREE.Mesh(roundedBox(0.05, 0.09, 0.07, 0.02), trim);
        foot.position.set(sx * (x.w ?? 0.7) / 2, -0.05, -(x.d ?? 1.2) / 2 + 0.18 + i * ((x.d ?? 1.2) - 0.36) / 3);
        mesh.add(foot);
      }
    }
    for (let i = 0; i < 5; i++) {
      const cross = new THREE.Mesh(roundedBox(x.w ?? 0.7, 0.045, 0.05, 0.018), trim);
      cross.position.set(0, 0.045, -(x.d ?? 1.2) / 2 + 0.15 + i * ((x.d ?? 1.2) - 0.3) / 4);
      mesh.add(cross);
    }
    if (x.jerry) {
      const can = new THREE.Mesh(roundedBox(0.20, 0.28, 0.11, 0.02), new THREE.MeshStandardMaterial({ color: 0x2f3a2a, roughness: 0.8 }));
      can.position.set(-(x.w ?? 0.7) * 0.22, 0.18, -(x.d ?? 1.2) * 0.28);
      mesh.add(can);
      const spare = new THREE.Mesh(new THREE.TorusGeometry(0.24, 0.09, 8, 18), plastic);
      spare.rotation.x = Math.PI / 2;
      spare.position.set((x.w ?? 0.7) * 0.18, 0.14, (x.d ?? 1.2) * 0.22);
      mesh.add(spare);
    }
  } else if (x.type === 'snorkel') {
    mesh = new THREE.Group();
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.072, 0.078, x.h ?? 1.0, 12), trim);
    mesh.add(tube);
    const head = new THREE.Mesh(roundedBox(0.17, 0.24, 0.17, 0.04), trim);
    head.position.y = (x.h ?? 1.0) * 0.58;
    mesh.add(head);
    const mouth = new THREE.Mesh(new THREE.CircleGeometry(0.065, 12), plastic);
    mouth.position.set(0, (x.h ?? 1.0) * 0.58, 0.088);
    mesh.add(mouth);
    for (let i = 0; i < 2; i++) {
      const clamp2 = new THREE.Mesh(new THREE.TorusGeometry(0.082, 0.014, 6, 14), chrome);
      clamp2.rotation.x = Math.PI / 2;
      clamp2.position.y = -0.2 + i * 0.34;
      mesh.add(clamp2);
    }
  } else if (x.type === 'buttress') {
    // flying buttress: a thin blade sweeping from the roof down to the rear haunch
    mesh = new THREE.Group();
    for (const sx of [-1, 1]) {
      const blade = new THREE.Mesh(roundedBox(0.05, x.h ?? 0.34, x.d ?? 0.90, 0.02), x.painted ? paint : carbon);
      blade.position.set(sx * (x.x ?? 0.42), 0, 0);
      blade.rotation.x = x.rx ?? 0.30;
      blade.rotation.z = sx * -0.10;
      mesh.add(blade);
    }
  } else if (x.type === 'rollhoop') {
    mesh = new THREE.Group();
    for (const sx of [-1, 1]) {
      const hoop = new THREE.Mesh(new THREE.TorusGeometry(x.r ?? 0.20, 0.032, 8, 16, Math.PI), chromeMaterial({ color: '#8b9099', rough: 0.28 }));
      hoop.rotation.y = Math.PI / 2;
      hoop.position.set(sx * (x.x ?? 0.34), 0, 0);
      mesh.add(hoop);
    }
  } else if (x.type === 'bullbar') {
    mesh = new THREE.Group();
    const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, x.w ?? 1.9, 12), trim);
    rail.rotation.z = Math.PI / 2;
    mesh.add(rail);
    for (let i = -1; i <= 1; i++) {
      const up = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, x.h ?? 0.62, 10), trim);
      up.position.set(i * (x.w ?? 1.9) * 0.30, -(x.h ?? 0.62) * 0.5, 0);
      mesh.add(up);
    }
    const skid = new THREE.Mesh(roundedBox((x.w ?? 1.9) * 0.55, 0.10, 0.22, 0.03), chromeMaterial({ color: '#9aa0a8', rough: 0.35 }));
    skid.position.set(0, -(x.h ?? 0.62) * 0.86, 0);
    mesh.add(skid);
    // mounting stays back into the chassis — otherwise the bar floats in front of the nose
    for (const sx of [-1, 1]) {
      for (const dy of [0.02, -(x.h ?? 0.62) * 0.62]) {
        const stay = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.036, 0.34, 8), trim);
        stay.rotation.x = Math.PI / 2;
        stay.position.set(sx * (x.w ?? 1.9) * 0.30, dy, -0.19);
        mesh.add(stay);
      }
    }
  } else if (x.type === 'louvre') {
    // rear-window slat kit: kills the flat black quad a fastback backlight otherwise reads as
    mesh = new THREE.Group();
    const n = x.count ?? 7, len = x.d ?? 0.9, pitch = len / (n - 1);
    for (let i = 0; i < n; i++) {
      const f = i / (n - 1) - 0.5;
      // slat chord must be SHORTER than the pitch or the kit closes up into one solid black slab
      const slat = new THREE.Mesh(roundedBox(x.w ?? 1.2, 0.016, pitch * 0.52, 0.006), trim);
      slat.position.set(0, 0.03 + Math.abs(f) * 0.012, f * len);
      slat.rotation.x = -0.50;
      mesh.add(slat);
    }
    for (const sx of [-1, 1]) {
      const rail = new THREE.Mesh(roundedBox(0.032, 0.055, len * 1.06, 0.012), trim);
      rail.position.set(sx * (x.w ?? 1.2) * 0.5, 0.02, 0);
      mesh.add(rail);
    }
  } else if (x.type === 'panel') {
    // a bolted-on body panel with a real shut gap around it — tailgates, boot lids, hatches
    mesh = new THREE.Group();
    const gap = new THREE.Mesh(roundedBox((x.w ?? 1.4) + 0.06, (x.h ?? 0.7) + 0.06, 0.03, 0.05),
      new THREE.MeshStandardMaterial({ color: 0x08090c, roughness: 0.9 }));
    gap.position.z = -0.012;
    mesh.add(gap);
    const face = new THREE.Mesh(roundedBox(x.w ?? 1.4, x.h ?? 0.7, x.d ?? 0.05, 0.04), x.mat === 'dark' ? trim : paint);
    mesh.add(face);
    for (const sx of [-1, 1]) {                       // hinges / gas struts
      const h = new THREE.Mesh(roundedBox(0.10, 0.05, 0.05, 0.014), chrome);
      h.position.set(sx * (x.w ?? 1.4) * 0.32, (x.h ?? 0.7) * 0.5 + 0.02, 0.02);
      mesh.add(h);
    }
  } else if (x.type === 'tailgate') {
    /**
     * A real tailgate. Round 2's SUV had one enormous featureless quad back here carrying a
     * misregistered orange rectangle: ~45% of the visible car doing no work at all. This builds
     * the panel out of the parts a tailgate actually has — a shut gap all the way round, two
     * horizontal swage seams, a pull handle on stand-offs, a recessed number plate lit by two
     * lamps, a badge bar, and a pair of hinges.
     */
    mesh = new THREE.Group();
    const w = x.w ?? 1.5, h = x.h ?? 0.66, dep = x.d ?? 0.07;
    const dark = new THREE.MeshStandardMaterial({ color: 0x07080b, roughness: 0.92, metalness: 0.15 });
    const gap = new THREE.Mesh(roundedBox(w + 0.055, h + 0.055, 0.03, 0.045), dark);
    gap.position.z = -0.014;
    mesh.add(gap);
    const face = new THREE.Mesh(roundedBox(w, h, dep, 0.038), x.mat === 'dark' ? trim : paint);
    mesh.add(face);
    // swage seams: two shadow lines pressed across the panel
    for (const f of [0.26, -0.10]) {
      const seam = new THREE.Mesh(roundedBox(w * 0.94, 0.022, 0.02, 0.008), dark);
      seam.position.set(0, f * h, dep * 0.5 + 0.004);
      mesh.add(seam);
      const hi = new THREE.Mesh(roundedBox(w * 0.94, 0.014, 0.026, 0.006), x.mat === 'dark' ? trim : paint);
      hi.position.set(0, f * h + 0.020, dep * 0.5 + 0.002);
      mesh.add(hi);
    }
    // pull handle on two stand-offs
    const bar = new THREE.Mesh(roundedBox(w * 0.42, 0.055, 0.055, 0.022), chrome);
    bar.position.set(0, h * 0.30, dep * 0.5 + 0.055);
    mesh.add(bar);
    for (const sx of [-1, 1]) {
      const st = new THREE.Mesh(roundedBox(0.05, 0.075, 0.07, 0.018), trim);
      st.position.set(sx * w * 0.19, h * 0.30, dep * 0.5 + 0.022);
      mesh.add(st);
    }
    // number-plate recess with a plate and two lamps over it
    const rec = new THREE.Mesh(roundedBox(0.56, 0.22, 0.05, 0.02), dark);
    rec.position.set(x.plateX ?? 0, -h * 0.24, dep * 0.5 - 0.006);
    mesh.add(rec);
    const plate = new THREE.Mesh(roundedBox(0.50, 0.17, 0.02, 0.014),
      new THREE.MeshStandardMaterial({ color: 0xd9dbd2, roughness: 0.55, metalness: 0.1 }));
    plate.position.set(x.plateX ?? 0, -h * 0.24, dep * 0.5 + 0.014);
    mesh.add(plate);
    for (const sx of [-1, 1]) {
      const lamp = new THREE.Mesh(roundedBox(0.06, 0.022, 0.02, 0.008), emissiveMaterial({ color: '#fff4d8', intensity: 1.8 }));
      lamp.position.set((x.plateX ?? 0) + sx * 0.16, -h * 0.24 + 0.145, dep * 0.5 + 0.026);
      mesh.add(lamp);
    }
    // badge bar
    for (let i = 0; i < 4; i++) {
      const b = new THREE.Mesh(roundedBox(0.055, 0.075, 0.022, 0.010), chrome);
      b.position.set(-w * 0.30 + i * 0.085, h * 0.05, dep * 0.5 + 0.014);
      mesh.add(b);
    }
    // hinges
    for (const sx of [-1, 1]) {
      const hg = new THREE.Mesh(roundedBox(0.09, 0.16, 0.05, 0.016), trim);
      hg.position.set(sx * w * 0.46, h * 0.42, dep * 0.5 - 0.01);
      mesh.add(hg);
    }
  } else if (x.type === 'wingmirror-tow') {
    mesh = new THREE.Group();
    for (const sx of [-1, 1]) {
      const hook = new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.018, 6, 12), chrome);
      hook.position.set(sx * (x.x ?? 0.5), 0, 0);
      mesh.add(hook);
    }
  }
  if (!mesh) return new THREE.Group();
  mesh.position.set(x.x !== undefined && x.type !== 'buttress' && x.type !== 'rollhoop' && x.type !== 'wingmirror-tow' ? x.x : 0, x.y ?? 0, x.z ?? 0);
  if (x.ry) mesh.rotation.y = x.ry;
  if (x.rx && x.type !== 'buttress') mesh.rotation.x = x.rx;
  mesh.traverse?.((o) => { if (o.isMesh) o.castShadow = true; });
  return mesh;
}

// ------------------------------------------------------------------ recolour

/** Recolour an assembled car in place (used by the garage colour picker). */
export function recolor(car, color) {
  const m = car.userData.paintMaterial;
  const cfg = m.userData?.livery;
  if (cfg) {
    m.map?.dispose();
    cfg.base = color;
    m.map = bodyPaintTexture(cfg);
    m.color.set('#ffffff');
    m.needsUpdate = true;
    const up = m.userData.upper;
    if (up) {                                        // roof / pillar bands: same livery, no panels
      up.mat.map?.dispose();
      up.cfg.base = color;
      up.mat.map = bodyPaintTexture(up.cfg);
      up.mat.color.set('#ffffff');
      up.mat.needsUpdate = true;
    }
    for (const s of m.userData.solids || []) {        // bolt-ons carry the flat body colour
      s.color.set(color);
      s.needsUpdate = true;
    }
    for (const shell of m.userData.shells || []) {   // roof / pillar bands share the paint map
      shell.map = m.map;
      shell.color.set('#ffffff');
      shell.needsUpdate = true;
    }
  } else {
    for (const shell of m.userData.shells || []) shell.color.set(color);
    m.color.set(color);
  }
}

/** Kept for compatibility: the old 9-point section helper. */
export function section(z, opts) { return bodySection(z, opts); }

export { clamp };

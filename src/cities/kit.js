import * as THREE from 'three';
import { RNG, clamp, lerp, smoothstep } from '../core/rng.js';
import { facade, concrete, brick, skyTexture, sprite, canvas, toTexture, grain } from '../core/textures.js';
import { roundedBox } from '../vehicles/kit.js';
import { Track, boostStripTexture } from './track.js';
import { drawText, textCanvas } from '../core/font.js';

/**
 * Shared city construction kit.
 *
 * ART_DIRECTION.md §2.4 requires four populated depth bands — near props, mid buildings, far
 * skyline, sky — and §6.4 caps a city at 62 with no far skyline and at 50 if buildings are
 * untextured boxes. buildCity() below wires all four bands; city files supply the palette,
 * the route, the block rules, and their own landmarks.
 */

// ---------------------------------------------------------------- buildings

/**
 * A city block building: tapered mass with setbacks, a textured facade, roof plant, and (at
 * night) lit windows driven by an emissive map.
 */
export function building({
  w = 18, d = 18, h = 60, seed = 1, style = 'modern', night = false, litRatio = 0.35,
  wall = '#5a5c66', glass = '#22303f', litColor = '#ffd9a0', setbacks = 0, roofDetail = true,
  accent = null,
}) {
  const rng = new RNG(seed);
  const g = new THREE.Group();
  const cols = Math.max(3, Math.round(w / 3.2));
  const rows = Math.max(4, Math.round(h / 3.6));
  const tex = facade({
    seed, cols: Math.min(cols, 14), rows: Math.min(rows, 22),
    wall, glass, litColor, litRatio: night ? litRatio : litRatio * 0.12, night, style,
  });
  const mat = new THREE.MeshStandardMaterial({
    map: tex.map,
    emissiveMap: tex.emissiveMap,
    emissive: new THREE.Color(0xffffff),
    emissiveIntensity: night ? 1.15 : 0.15,
    roughness: 0.72, metalness: 0.15,
  });
  tex.map.repeat.set(Math.max(1, Math.round(w / 16)), Math.max(1, Math.round(h / 22)));
  tex.emissiveMap.repeat.copy(tex.map.repeat);

  let y = 0, cw = w, cd = d;
  const tiers = setbacks > 0 ? setbacks + 1 : 1;
  for (let t = 0; t < tiers; t++) {
    const th = t === 0 ? h * (tiers === 1 ? 1 : 0.62) : (h * 0.38) / (tiers - 1);
    const m = new THREE.Mesh(new THREE.BoxGeometry(cw, th, cd), mat);
    m.position.y = y + th / 2;
    m.castShadow = true; m.receiveShadow = true;
    g.add(m);
    // floor-line cornice so the silhouette isn't a bare extrusion
    const cor = new THREE.Mesh(
      new THREE.BoxGeometry(cw * 1.035, Math.min(0.8, th * 0.03), cd * 1.035),
      new THREE.MeshStandardMaterial({ color: new THREE.Color(wall).multiplyScalar(0.72), roughness: 0.8 }),
    );
    cor.position.y = y + th;
    g.add(cor);
    y += th; cw *= rng.range(0.68, 0.84); cd *= rng.range(0.68, 0.84);
  }

  if (roofDetail) {
    const rm = new THREE.MeshStandardMaterial({ color: 0x3a3d44, roughness: 0.85 });
    for (let i = 0; i < rng.int(2, 5); i++) {
      const bw = rng.range(1.4, Math.max(2, cw * 0.30));
      const box = new THREE.Mesh(roundedBox(bw, rng.range(1.2, 3.4), bw * rng.range(0.7, 1.4), 0.15), rm);
      box.position.set(rng.range(-cw * 0.3, cw * 0.3), y + 1.2, rng.range(-cd * 0.3, cd * 0.3));
      box.castShadow = true;
      g.add(box);
    }
    // aircraft warning light
    if (h > 45) {
      const l = new THREE.Mesh(
        new THREE.SphereGeometry(0.5, 8, 6),
        new THREE.MeshStandardMaterial({ color: 0xff2222, emissive: 0xff2222, emissiveIntensity: 4 }),
      );
      l.position.y = y + 3.2;
      l.name = 'beacon';
      g.add(l);
    }
    if (accent) {
      // a coloured light strip along the parapet — the cheapest way to give a skyline identity
      const strip = new THREE.Mesh(
        new THREE.BoxGeometry(cw * 1.05, 0.5, cd * 1.05),
        new THREE.MeshStandardMaterial({ color: accent, emissive: new THREE.Color(accent), emissiveIntensity: night ? 3.4 : 0.6 }),
      );
      strip.position.y = y + 0.4;
      g.add(strip);
    }
  }
  g.userData.height = y;
  return g;
}

/** Low-rise strip: shops with awnings and signage. Fills the near-mid band along a boulevard. */
export function lowRise({ w = 14, d = 12, h = 9, seed = 2, night = false, wallColor = '#c9b79a', signColor = '#ff3d7f', signText = null }) {
  const rng = new RNG(seed);
  const g = new THREE.Group();
  const tex = brick({ seed, color: wallColor, mortar: '#d8d2c4', rowH: 20 });
  const mat = new THREE.MeshStandardMaterial({ map: tex.map, normalMap: tex.normalMap, roughnessMap: tex.roughnessMap, roughness: 0.9 });
  tex.map.repeat.set(w / 6, h / 6);
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.y = h / 2;
  m.castShadow = true; m.receiveShadow = true;
  g.add(m);

  // shopfront glazing
  const win = new THREE.Mesh(
    new THREE.BoxGeometry(w * 0.86, h * 0.32, 0.3),
    new THREE.MeshStandardMaterial({
      color: night ? 0x2a2418 : 0x1a2430, emissive: new THREE.Color(night ? 0xffbb66 : 0x223344),
      emissiveIntensity: night ? 1.8 : 0.2, roughness: 0.15, metalness: 0.3,
    }),
  );
  win.position.set(0, h * 0.26, d / 2 + 0.02);
  g.add(win);

  // awning
  const aw = new THREE.Mesh(
    roundedBox(w * 0.9, 0.14, 1.8, 0.06),
    new THREE.MeshStandardMaterial({ color: new THREE.Color(signColor).multiplyScalar(0.8), roughness: 0.85 }),
  );
  aw.position.set(0, h * 0.46, d / 2 + 0.9);
  aw.rotation.x = 0.16;
  aw.castShadow = true;
  g.add(aw);

  // neon sign
  if (signText) {
    const c = textCanvas(signText, { size: 56, weight: 0.20, italic: 0.16, color: '#ffffff', tracking: 0.14 });
    const t = toTexture(c, { srgb: true, wrap: THREE.ClampToEdgeWrapping });
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(w * 0.7, w * 0.7 * (c.height / c.width)),
      new THREE.MeshBasicMaterial({ map: t, transparent: true, color: new THREE.Color(signColor), blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    sign.position.set(0, h * 0.74, d / 2 + 0.35);
    g.add(sign);
  }
  void rng;
  return g;
}

/** Distant skyline ring — the "far" depth band. Cheap boxes, but silhouetted and window-lit. */
export function skylineRing({
  center = new THREE.Vector3(), radius = 900, count = 90, seed = 3,
  night = false, palette = ['#2a3140'], accent = '#66d9ff', minH = 60, maxH = 260, spread = 260,
}) {
  const rng = new RNG(seed);
  const g = new THREE.Group();
  g.name = 'skyline';
  const mats = palette.map((c) => new THREE.MeshStandardMaterial({
    color: new THREE.Color(c), roughness: 0.9, metalness: 0.1,
    emissive: new THREE.Color(night ? c : '#000000'), emissiveIntensity: night ? 0.35 : 0,
  }));
  const winTex = skylineWindowTexture(seed, night);
  const winMat = new THREE.MeshStandardMaterial({
    map: winTex, emissiveMap: winTex, emissive: 0xffffff,
    emissiveIntensity: night ? 1.5 : 0.1, roughness: 0.8, color: night ? 0x223040 : 0x8a96a8,
  });
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + rng.range(-0.02, 0.02);
    const r = radius + rng.range(-spread, spread);
    const h = rng.range(minH, maxH) * (0.7 + 0.6 * rng.next());
    const w = rng.range(24, 70);
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, w * rng.range(0.7, 1.3)), rng.bool(0.55) ? winMat : rng.pick(mats));
    m.position.set(center.x + Math.cos(a) * r, h / 2 - 6, center.z + Math.sin(a) * r);
    m.rotation.y = rng.range(0, 1.57);
    g.add(m);
    if (night && rng.bool(0.16)) {
      const beacon = new THREE.Mesh(
        new THREE.SphereGeometry(1.6, 6, 5),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(accent) }),
      );
      beacon.position.set(m.position.x, h + 2, m.position.z);
      g.add(beacon);
    }
  }
  return g;
}

function skylineWindowTexture(seed, night) {
  const size = 256;
  const { c, ctx } = canvas(size, size);
  const rng = new RNG(seed + 700);
  ctx.fillStyle = night ? '#0d131c' : '#4d5666';
  ctx.fillRect(0, 0, size, size);
  const cols = 16, rows = 26;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const lit = night ? rng.bool(0.42) : rng.bool(0.12);
      if (!lit) continue;
      ctx.fillStyle = night
        ? `rgba(${rng.int(230, 255)},${rng.int(190, 235)},${rng.int(130, 200)},${rng.range(0.5, 1)})`
        : 'rgba(150,175,200,0.5)';
      ctx.fillRect((x + 0.22) * (size / cols), (y + 0.22) * (size / rows), (size / cols) * 0.56, (size / rows) * 0.52);
    }
  }
  grain(ctx, size, size, 5, rng);
  const t = toTexture(c, { srgb: true });
  t.repeat.set(2, 3);
  return t;
}

// ---------------------------------------------------------------- props

export function streetLamp({ h = 8, style = 'modern', color = '#ffd39a', night = true, seed = 1 }) {
  const g = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({ color: 0x2e3238, metalness: 0.75, roughness: 0.45 });
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.10, 0.15, h, 10), metal);
  pole.position.y = h / 2; pole.castShadow = true;
  g.add(pole);
  if (style === 'colonial') {
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.34, 12, 10),
      new THREE.MeshStandardMaterial({ color: 0xfff3d0, emissive: new THREE.Color(color), emissiveIntensity: night ? 4.5 : 0.6 }));
    lamp.position.y = h + 0.2;
    g.add(lamp);
  } else {
    const arm = new THREE.Mesh(roundedBox(0.14, 0.14, 1.9, 0.05), metal);
    arm.position.set(0, h - 0.1, 0.9); g.add(arm);
    const head = new THREE.Mesh(roundedBox(0.42, 0.16, 1.0, 0.06), metal);
    head.position.set(0, h - 0.22, 1.7); g.add(head);
    const lens = new THREE.Mesh(new THREE.PlaneGeometry(0.36, 0.9),
      new THREE.MeshStandardMaterial({ color: 0xfff0cc, emissive: new THREE.Color(color), emissiveIntensity: night ? 6 : 0.5, side: THREE.DoubleSide }));
    lens.rotation.x = Math.PI / 2;
    lens.position.set(0, h - 0.32, 1.7);
    g.add(lens);
  }
  if (night) {
    const glow = new THREE.Mesh(
      new THREE.PlaneGeometry(5, 5),
      new THREE.MeshBasicMaterial({
        map: sprite({ size: 128, shape: 'glow', color, seed }),
        transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.55,
      }),
    );
    glow.position.set(0, h - 0.3, style === 'colonial' ? 0 : 1.7);
    glow.name = 'billboardGlow';
    g.add(glow);
  }
  return g;
}

export function palmTree({ h = 11, seed = 1, lean = 0.12 }) {
  const rng = new RNG(seed);
  const g = new THREE.Group();
  const barkMat = new THREE.MeshStandardMaterial({ color: 0x6b5a41, roughness: 0.95 });
  const segs = 9;
  const curve = new THREE.CatmullRomCurve3(
    Array.from({ length: segs }, (_, i) => {
      const t = i / (segs - 1);
      return new THREE.Vector3(Math.sin(t * 1.6) * lean * h, t * h, Math.cos(t * 2.1) * lean * h * 0.4);
    }),
  );
  const trunk = new THREE.Mesh(new THREE.TubeGeometry(curve, 12, 0.26, 8, false), barkMat);
  trunk.scale.set(1, 1, 1);
  trunk.castShadow = true;
  g.add(trunk);
  const top = curve.getPointAt(1);
  const frondMat = new THREE.MeshStandardMaterial({ color: 0x2f6b34, roughness: 0.75, side: THREE.DoubleSide });
  const n = rng.int(9, 13);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rng.range(-0.2, 0.2);
    const len = rng.range(2.6, 4.2);
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.quadraticCurveTo(len * 0.4, 0.36, len, 0.04);
    shape.quadraticCurveTo(len * 0.4, -0.30, 0, 0);
    const geo = new THREE.ShapeGeometry(shape, 8);
    const f = new THREE.Mesh(geo, frondMat);
    f.position.copy(top);
    f.rotation.set(rng.range(0.15, 0.75), -a, 0);
    f.castShadow = true;
    g.add(f);
  }
  // coconuts
  for (let i = 0; i < 3; i++) {
    const c = new THREE.Mesh(new THREE.SphereGeometry(0.16, 7, 6), new THREE.MeshStandardMaterial({ color: 0x53412a, roughness: 0.9 }));
    c.position.copy(top).add(new THREE.Vector3(rng.range(-0.3, 0.3), -0.25, rng.range(-0.3, 0.3)));
    g.add(c);
  }
  return g;
}

export function jerseyBarrier({ len = 4, striped = true }) {
  const g = new THREE.Group();
  const prof = new THREE.Shape();
  prof.moveTo(-0.42, 0); prof.lineTo(0.42, 0); prof.lineTo(0.28, 0.30);
  prof.lineTo(0.16, 1.02); prof.lineTo(-0.16, 1.02); prof.lineTo(-0.28, 0.30);
  prof.closePath();
  const geo = new THREE.ExtrudeGeometry(prof, { depth: len, bevelEnabled: false });
  geo.translate(0, 0, -len / 2);
  geo.computeVertexNormals();
  const tex = striped ? barrierStripeTexture() : concrete({ seed: 6 }).map;
  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.86 }));
  m.castShadow = true; m.receiveShadow = true;
  g.add(m);
  return g;
}

let _barrierTex = null;
function barrierStripeTexture() {
  if (_barrierTex) return _barrierTex;
  const { c, ctx } = canvas(256, 128);
  ctx.fillStyle = '#e9e6dd'; ctx.fillRect(0, 0, 256, 128);
  ctx.fillStyle = '#cf2a2a';
  for (let i = -1; i < 6; i++) ctx.fillRect(i * 48 + 12, 0, 24, 128);
  const rng = new RNG(3);
  ctx.globalCompositeOperation = 'multiply';
  for (let k = 0; k < 60; k++) {
    ctx.fillStyle = `rgba(${rng.int(140, 210)},${rng.int(140, 210)},${rng.int(140, 210)},0.3)`;
    ctx.fillRect(rng.range(0, 256), rng.range(0, 128), rng.range(4, 30), rng.range(4, 26));
  }
  ctx.globalCompositeOperation = 'source-over';
  grain(ctx, 256, 128, 7, rng);
  _barrierTex = toTexture(c, { srgb: true });
  return _barrierTex;
}

/** Overhead neon gate — the reference's green torus arches (f&f3). Big, cheap spectacle. */
export function neonGate({ radius = 14, tube = 0.55, color = '#39ff88', width = 26, height = 11 }) {
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(color) });
  const arc = new THREE.Mesh(new THREE.TorusGeometry(radius, tube, 10, 40, Math.PI), mat);
  arc.position.y = height - radius;
  g.add(arc);
  const halo = new THREE.Mesh(
    new THREE.TorusGeometry(radius, tube * 3.4, 8, 40, Math.PI),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(color), transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  halo.position.y = height - radius;
  g.add(halo);
  for (const sx of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.7, height * 0.9, 10),
      new THREE.MeshStandardMaterial({ color: 0x22262d, metalness: 0.7, roughness: 0.4 }));
    post.position.set(sx * width / 2, height * 0.45, 0);
    g.add(post);
  }
  const light = new THREE.PointLight(new THREE.Color(color), 30, 60, 2);
  light.position.y = height * 0.7;
  g.add(light);
  return g;
}

/** Ramp — a visible jump opportunity (§6.4 caps a city with no visible ramp at 70). */
export function ramp({ w = 10, len = 16, rise = 3.6, chevron = true }) {
  const g = new THREE.Group();
  const shape = new THREE.Shape();
  shape.moveTo(0, 0); shape.lineTo(len, 0); shape.lineTo(len, rise);
  shape.quadraticCurveTo(len * 0.42, rise * 0.55, 0, 0.05);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: w, bevelEnabled: false });
  geo.rotateY(Math.PI / 2);
  geo.translate(-w / 2, 0, 0);
  geo.computeVertexNormals();
  const tex = chevron ? boostStripTexture({ color: '#ffb020' }) : concrete({ seed: 9 }).map;
  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    map: tex, roughness: 0.7, emissive: chevron ? new THREE.Color('#ff7a10') : new THREE.Color('#000'),
    emissiveIntensity: chevron ? 0.55 : 0,
  }));
  m.castShadow = true; m.receiveShadow = true;
  g.add(m);
  return g;
}

/** Boost pad laid into the road. */
export function boostPad({ w = 6, len = 12, color = '#ff8a1e' }) {
  const tex = boostStripTexture({ color });
  tex.repeat.set(1, 3);
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(w, len),
    new THREE.MeshStandardMaterial({
      map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 2.4,
      transparent: true, roughness: 0.4,
    }),
  );
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.04;
  m.renderOrder = 2;
  return m;
}

/** Billboard with procedurally drawn artwork — mid-band detail that also sells the city. */
export function billboard({ w = 14, h = 7, text = 'NITRO', sub = '', color = '#ff2f6d', bg = '#101828', night = true, legs = 8 }) {
  const g = new THREE.Group();
  const { c, ctx } = canvas(512, 256);
  const grd = ctx.createLinearGradient(0, 0, 512, 256);
  grd.addColorStop(0, bg);
  grd.addColorStop(1, new THREE.Color(bg).offsetHSL(0.06, 0.1, 0.1).getStyle());
  ctx.fillStyle = grd; ctx.fillRect(0, 0, 512, 256);
  ctx.strokeStyle = color; ctx.lineWidth = 6; ctx.strokeRect(10, 10, 492, 236);
  drawText(ctx, text, { x: 256, y: 140, size: 74, weight: 0.20, italic: 0.24, align: 'center', color, glow: { color, blur: 26 }, tracking: 0.10 });
  if (sub) drawText(ctx, sub, { x: 256, y: 196, size: 30, weight: 0.17, italic: 0.20, align: 'center', color: '#e8eef6', tracking: 0.16 });
  const tex = toTexture(c, { srgb: true, wrap: THREE.ClampToEdgeWrapping });
  const panel = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshStandardMaterial({
      map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: night ? 1.9 : 0.35,
      roughness: 0.6, side: THREE.DoubleSide,
    }),
  );
  panel.position.y = legs + h / 2;
  g.add(panel);
  const metal = new THREE.MeshStandardMaterial({ color: 0x33383f, metalness: 0.7, roughness: 0.5 });
  for (const sx of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.28, legs + h / 2, 8), metal);
    leg.position.set(sx * w * 0.32, (legs + h / 2) / 2, 0);
    leg.castShadow = true;
    g.add(leg);
  }
  return g;
}

// ---------------------------------------------------------------- assembly

/**
 * Build a complete city from a declarative definition.
 * @returns {{ group, track, look, spawn, branches, colliders, update }}
 */
export function buildCity(def, { renderer, night = false, quality = 'high' } = {}) {
  const rng = new RNG(def.seed ?? 1);
  const group = new THREE.Group();
  group.name = `city:${def.id}`;
  const L = def.look;

  // ---- sky ----
  const skyTex = skyTexture({ size: quality === 'low' ? 512 : 1024, ...L.sky });
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(3400, 40, 24),
    new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, depthWrite: false, fog: false }),
  );
  sky.name = 'sky';
  group.add(sky);

  // ---- environment map for car paint / wet road ----
  let envMap = null;
  if (renderer) {
    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    envMap = pmrem.fromEquirectangular(skyTex).texture;
    pmrem.dispose();
  }

  // ---- lights ----
  const sun = new THREE.DirectionalLight(new THREE.Color(L.sun.color), L.sun.intensity);
  sun.position.set(...L.sun.dir).multiplyScalar(300);
  sun.castShadow = true;
  sun.shadow.mapSize.set(quality === 'low' ? 1024 : 2048, quality === 'low' ? 1024 : 2048);
  sun.shadow.camera.near = 10; sun.shadow.camera.far = 900;
  const S = 190;
  sun.shadow.camera.left = -S; sun.shadow.camera.right = S;
  sun.shadow.camera.top = S; sun.shadow.camera.bottom = -S;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.045;
  group.add(sun);
  group.add(sun.target);

  const hemi = new THREE.HemisphereLight(
    new THREE.Color(L.ambient.sky), new THREE.Color(L.ambient.ground), L.ambient.intensity,
  );
  group.add(hemi);
  if (L.ambient.fill) {
    const fill = new THREE.DirectionalLight(new THREE.Color(L.ambient.fill.color), L.ambient.fill.intensity);
    fill.position.set(...L.ambient.fill.dir).multiplyScalar(200);
    group.add(fill);
  }

  // ---- ground ----
  const groundMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(L.ground?.color ?? '#2c2e33'), roughness: 0.95, metalness: 0.0,
  });
  if (L.ground?.texture !== false) {
    const gt = concrete({ seed: def.seed ?? 1, tint: L.ground?.color ?? '#3a3d43', size: 512 });
    groundMat.map = gt.map; groundMat.roughnessMap = gt.roughnessMap; groundMat.normalMap = gt.normalMap;
    gt.map.repeat.set(220, 220); gt.roughnessMap.repeat.set(220, 220); gt.normalMap.repeat.set(220, 220);
    groundMat.color.set('#ffffff');
    groundMat.color.multiplyScalar(1);
  }
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.35;
  ground.receiveShadow = true;
  group.add(ground);

  // ---- fog ----
  const fog = new THREE.Fog(new THREE.Color(L.fog.color), L.fog.near, L.fog.far);

  // ---- track ----
  const track = new Track(def.track);
  const road = track.buildRoad({
    surface: { ...(def.track.surface || {}), wet: L.wet ?? 0 },
    curb: def.track.curb ?? 'stripe',
    bankStrength: def.track.bank ?? 0,
  });
  group.add(road);

  const branchGroups = [];
  for (const b of track.branches) {
    const bg = b.buildRoad({ surface: { ...(def.track.surface || {}), wet: L.wet ?? 0 } });
    group.add(bg);
    branchGroups.push(bg);
    // dress the mouth so the shortcut reads as an invitation
    const a = track.at(b.enterU);
    const gate = new THREE.Group();
    if (b.kind === 'ramp') {
      gate.add(ramp({ w: b.halfWidth * 2, len: 14, rise: b.def.rise ?? 5 }));
    } else {
      const pad = boostPad({ w: b.halfWidth * 1.6, len: 10, color: L.accent || '#ff8a1e' });
      gate.add(pad);
    }
    gate.position.copy(b.curve.getPointAt(0.02));
    gate.rotation.y = Math.atan2(a.tan.x, a.tan.z);
    group.add(gate);
  }

  // ---- mid band: buildings along the route ----
  const blocks = new THREE.Group();
  blocks.name = 'blocks';
  const bdef = def.blocks || {};
  const spacing = bdef.spacing ?? 46;
  let bi = 0;
  for (const side of [-1, 1]) {
    for (const s of track.spaced(spacing, { side, offset: bdef.offset ?? 26, jitter: bdef.jitter ?? 10, rng: rng.fork(side + 5) })) {
      const r = rng.fork(bi * 13 + side);
      const kind = bdef.pick ? bdef.pick(r, s, side) : 'tower';
      let b;
      if (kind === 'none') { bi++; continue; }
      if (kind === 'low') {
        b = lowRise({
          w: r.range(12, 22), d: r.range(10, 18), h: r.range(6, 13), seed: bi * 7 + 3, night,
          wallColor: r.pick(bdef.lowColors || ['#c9b79a']),
          signColor: r.pick(bdef.neonColors || ['#ff3d7f']),
          signText: r.bool(0.5) ? r.pick(bdef.signs || ['DINER', 'MOTEL', 'BAR']) : null,
        });
      } else {
        b = building({
          w: r.range(bdef.minW ?? 14, bdef.maxW ?? 30),
          d: r.range(bdef.minW ?? 14, bdef.maxW ?? 30),
          h: r.range(bdef.minH ?? 26, bdef.maxH ?? 110),
          seed: bi * 11 + 1, night,
          litRatio: bdef.litRatio ?? 0.4,
          wall: r.pick(bdef.wallColors || ['#5a5c66']),
          glass: r.pick(bdef.glassColors || ['#22303f']),
          litColor: r.pick(bdef.litColors || ['#ffd9a0']),
          style: bdef.style || 'modern',
          setbacks: r.bool(bdef.setbackChance ?? 0.3) ? r.int(1, 2) : 0,
          accent: r.bool(bdef.accentChance ?? 0.18) ? r.pick(bdef.neonColors || ['#66d9ff']) : null,
        });
      }
      b.position.copy(s.pos).addScaledVector(s.right, side * r.range(2, 14));
      b.rotation.y = Math.atan2(s.tan.x, s.tan.z) + r.range(-0.14, 0.14);
      blocks.add(b);
      bi++;
    }
  }
  group.add(blocks);

  // ---- near band: lamps, barriers, trees, signage ----
  const props = new THREE.Group();
  props.name = 'props';
  const pdef = def.props || {};
  if (pdef.lamps !== false) {
    for (const side of [-1, 1]) {
      for (const s of track.spaced(pdef.lampSpacing ?? 34, { side, offset: 2.4, rng: rng.fork(side) })) {
        const l = streetLamp({ h: pdef.lampHeight ?? 8, style: pdef.lampStyle || 'modern', color: L.lampColor || '#ffd39a', night, seed: s.index });
        l.position.copy(s.pos);
        l.rotation.y = Math.atan2(s.tan.x, s.tan.z) + (side > 0 ? Math.PI : 0);
        props.add(l);
      }
    }
  }
  if (pdef.barriers) {
    for (const side of [-1, 1]) {
      for (const s of track.spaced(4.05, { side, offset: 1.5, rng: rng.fork(side + 2) })) {
        if (pdef.barrierGaps && s.index % pdef.barrierGaps === 0) continue;
        const b = jerseyBarrier({ len: 4 });
        b.position.copy(s.pos);
        b.rotation.y = Math.atan2(s.tan.x, s.tan.z);
        props.add(b);
      }
    }
  }
  if (pdef.palms) {
    for (const side of [-1, 1]) {
      for (const s of track.spaced(pdef.palmSpacing ?? 26, { side, offset: 5.5, jitter: 4, rng: rng.fork(side + 9) })) {
        const p = palmTree({ h: rng.range(9, 15), seed: s.index * 3 + side, lean: rng.range(0.05, 0.18) });
        p.position.copy(s.pos);
        props.add(p);
      }
    }
  }
  for (const bb of pdef.billboards || []) {
    const s = track.at(bb.u);
    const b = billboard({ ...bb, night });
    b.position.copy(s.pos).addScaledVector(s.right, (bb.side ?? 1) * (track.halfWidth + (bb.offset ?? 16)));
    b.rotation.y = Math.atan2(s.tan.x, s.tan.z) + (bb.side > 0 ? -Math.PI / 2 : Math.PI / 2) + (bb.rot ?? 0);
    props.add(b);
  }
  for (const gt of pdef.gates || []) {
    const s = track.at(gt.u);
    const g2 = neonGate({ color: gt.color || L.accent || '#39ff88', width: track.halfWidth * 2.6, radius: gt.radius ?? track.halfWidth * 1.5 });
    g2.position.copy(s.pos);
    g2.rotation.y = Math.atan2(s.tan.x, s.tan.z);
    props.add(g2);
  }
  for (const bp of pdef.boostPads || []) {
    const s = track.at(bp.u);
    const p = boostPad({ w: bp.w ?? 5, len: bp.len ?? 14, color: L.accent || '#ff8a1e' });
    p.position.copy(s.pos).addScaledVector(s.right, (bp.lateral ?? 0) * track.halfWidth);
    p.rotation.z = Math.atan2(s.tan.x, s.tan.z);
    p.userData.boost = true;
    p.userData.u = bp.u;
    props.add(p);
  }
  group.add(props);

  // ---- far band ----
  const center = track.at(0).pos.clone();
  if (def.skyline !== false) {
    group.add(skylineRing({
      center, night, seed: (def.seed ?? 1) + 3,
      ...(def.skyline || {}),
    }));
  }

  // ---- landmarks ----
  const landmarks = new THREE.Group();
  landmarks.name = 'landmarks';
  if (def.landmarks) {
    for (const lm of def.landmarks({ track, rng: rng.fork(99), night, THREE })) landmarks.add(lm);
  }
  group.add(landmarks);

  if (envMap) {
    group.traverse((o) => {
      if (o.isMesh && o.material && 'envMap' in o.material && o.name !== 'sky') {
        o.material.envMap = envMap;
        o.material.needsUpdate = true;
      }
    });
  }

  const spawnS = track.at(def.spawnU ?? 0);
  return {
    group, track, fog, sun, envMap, skyTex,
    look: L,
    name: def.name,
    spawn: { pos: spawnS.pos.clone(), yaw: Math.atan2(spawnS.tan.x, spawnS.tan.z), u: def.spawnU ?? 0 },
    boostPads: (pdef.boostPads || []).map((b) => ({ ...b })),
    update(t, camera) {
      sky.position.set(camera.position.x, 0, camera.position.z);
      sun.target.position.set(camera.position.x, 0, camera.position.z);
      sun.position.copy(sun.target.position).addScaledVector(new THREE.Vector3(...L.sun.dir).normalize(), 300);
      // billboard the lamp glows toward camera
      group.traverse((o) => { if (o.name === 'billboardGlow') o.lookAt(camera.position); });
    },
  };
}

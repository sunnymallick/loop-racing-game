import * as THREE from 'three';
import { RNG, clamp, lerp } from '../core/rng.js';
import { canvas, toTexture, grain, fbmField, sprite } from '../core/textures.js';

/**
 * Vehicle construction kit.
 *
 * ART_DIRECTION.md §6.1 caps any car whose body is "a stack of unmodified boxes" at 45. The way
 * out of that is loftBody(): describe a car as a series of CROSS-SECTIONS down its length and let
 * this module skin them. That is how real car silhouettes — long hood, fast roofline, tucked
 * rocker, flared arch — become achievable without an imported model.
 *
 * Convention: +Z is FORWARD, +X is right, +Y is up. Origin at the centre of the wheelbase, on the
 * ground plane.
 */

// ------------------------------------------------------------------ materials

/** Metallic clearcoat car paint with a procedural flake normal map. */
export function paintMaterial({
  color = '#d92b2b', metalness = 0.72, roughness = 0.26, clearcoat = 1.0,
  clearcoatRoughness = 0.05, flake = 0.55, seed = 3, map = null,
} = {}) {
  const mat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(color),
    metalness, roughness, clearcoat, clearcoatRoughness,
    envMapIntensity: 1.5,
    map,
  });
  if (flake > 0) {
    mat.normalMap = flakeNormal(seed);
    mat.normalScale = new THREE.Vector2(flake * 0.16, flake * 0.16);
    mat.normalMap.repeat.set(24, 24);
  }
  return mat;
}

let _flake = null;
function flakeNormal(seed = 3) {
  if (_flake) return _flake;
  const size = 256;
  const { c, ctx } = canvas(size, size);
  const img = ctx.createImageData(size, size);
  const rng = new RNG(seed);
  for (let i = 0; i < size * size; i++) {
    const nx = rng.gauss(0, 0.35), ny = rng.gauss(0, 0.35);
    const l = Math.hypot(nx, ny, 1);
    img.data[i * 4] = ((nx / l) * 0.5 + 0.5) * 255;
    img.data[i * 4 + 1] = ((ny / l) * 0.5 + 0.5) * 255;
    img.data[i * 4 + 2] = ((1 / l) * 0.5 + 0.5) * 255;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  _flake = toTexture(c, { srgb: false });
  return _flake;
}

export function glassMaterial({ tint = '#0d1720', opacity = 0.62, rough = 0.045 } = {}) {
  return new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(tint),
    metalness: 0.0, roughness: rough,
    transmission: 0.0,
    transparent: true, opacity,
    envMapIntensity: 2.6,
    clearcoat: 1, clearcoatRoughness: 0.02,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
}

export function chromeMaterial({ color = '#e8ecf2', rough = 0.08 } = {}) {
  return new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(color), metalness: 1.0, roughness: rough, envMapIntensity: 2.4,
  });
}

export function darkTrimMaterial({ color = '#15161a', rough = 0.62 } = {}) {
  return new THREE.MeshStandardMaterial({ color: new THREE.Color(color), metalness: 0.35, roughness: rough });
}

export function emissiveMaterial({ color = '#ff2020', intensity = 3.0, opacity = 1 } = {}) {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(color),
    emissive: new THREE.Color(color),
    emissiveIntensity: intensity,
    roughness: 0.35, metalness: 0.0,
    transparent: opacity < 1, opacity,
  });
}

let _tireMat = null;
export function tireMaterial() {
  if (_tireMat) return _tireMat;
  const size = 256;
  const { c, ctx } = canvas(size, size);
  ctx.fillStyle = '#0e0e10'; ctx.fillRect(0, 0, size, size);
  // tread blocks around the circumference (U = around, V = across the tread)
  const rng = new RNG(17);
  ctx.fillStyle = '#191a1d';
  for (let i = 0; i < 44; i++) {
    const x = (i / 44) * size;
    ctx.save(); ctx.translate(x, 0);
    ctx.fillRect(2, size * 0.10, size / 44 - 4, size * 0.30);
    ctx.fillRect(2 + size / 88, size * 0.55, size / 44 - 4, size * 0.32);
    ctx.restore();
  }
  // sidewall lettering band
  ctx.fillStyle = 'rgba(150,150,150,0.16)';
  ctx.fillRect(0, size * 0.46, size, size * 0.04);
  grain(ctx, size, size, 6, rng);
  const hf = fbmField(size, size, { seed: 5, octaves: 3, scale: 30 });
  _tireMat = new THREE.MeshStandardMaterial({
    map: toTexture(c, { srgb: true }),
    roughness: 0.92, metalness: 0.0, color: 0x9a9a9a,
  });
  void hf;
  return _tireMat;
}

// ------------------------------------------------------------------ lofting

/**
 * Skin a series of cross-sections into a closed body.
 *
 * @param sections [{ z, pts:[[x,y],...], scale? }]  half-profiles, x >= 0, ordered from the
 *                 BOTTOM CENTRE (x≈0) up and over to the TOP CENTRE (x≈0).
 *                 Every section must have the same point count.
 * @param opts.capFront/capRear  close the ends (default true)
 * @param opts.smooth   averaged vertex normals (default true). Use duplicated, closely-spaced
 *                      sections to keep an edge hard.
 * @returns THREE.BufferGeometry
 */
export function loftBody(sections, { capFront = true, capRear = true, smooth = true } = {}) {
  const secs = [...sections].sort((a, b) => a.z - b.z);
  const n = secs[0].pts.length;
  for (const s of secs) {
    if (s.pts.length !== n) throw new Error(`loftBody: section at z=${s.z} has ${s.pts.length} pts, expected ${n}`);
  }

  // build full rings by mirroring each half-profile
  const rings = secs.map((s) => {
    const sc = s.scale ?? 1;
    const ring = [];
    for (let i = 0; i < n; i++) ring.push([s.pts[i][0] * sc, s.pts[i][1] * sc]);
    for (let i = n - 2; i >= 1; i--) ring.push([-s.pts[i][0] * sc, s.pts[i][1] * sc]);
    return ring;
  });
  const ringLen = rings[0].length;

  const pos = [], uv = [], idx = [];
  for (let si = 0; si < secs.length; si++) {
    const z = secs[si].z;
    for (let i = 0; i < ringLen; i++) {
      pos.push(rings[si][i][0], rings[si][i][1], z);
      uv.push(i / (ringLen - 1), si / (secs.length - 1));
    }
  }
  for (let si = 0; si < secs.length - 1; si++) {
    for (let i = 0; i < ringLen - 1; i++) {
      const a = si * ringLen + i;
      const b = a + 1;
      const c = a + ringLen;
      const d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    // close the ring seam (the two centreline points)
    const a = si * ringLen + ringLen - 1, b = si * ringLen;
    const c = a + ringLen, d = b + ringLen;
    idx.push(a, c, b, b, c, d);
  }

  const capRing = (si, flip) => {
    const cx = pos.length / 3;
    let mx = 0, my = 0;
    for (let i = 0; i < ringLen; i++) { mx += rings[si][i][0]; my += rings[si][i][1]; }
    mx /= ringLen; my /= ringLen;
    pos.push(mx, my, secs[si].z); uv.push(0.5, 0.5);
    const base = si * ringLen;
    for (let i = 0; i < ringLen; i++) {
      const a = base + i, b = base + ((i + 1) % ringLen);
      if (flip) idx.push(cx, b, a); else idx.push(cx, a, b);
    }
  };
  if (capRear) capRing(0, true);
  if (capFront) capRing(secs.length - 1, false);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  if (!smooth) geo.deleteAttribute('normal'), geo.computeVertexNormals();
  return geo;
}

/** Resample a polyline to exactly `n` evenly-spaced points — lets sections be authored loosely. */
export function resample(pts, n) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = cum[cum.length - 1];
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * total;
    let k = 1;
    while (k < cum.length - 1 && cum[k] < t) k++;
    const seg = (cum[k] - cum[k - 1]) || 1;
    const f = (t - cum[k - 1]) / seg;
    out.push([lerp(pts[k - 1][0], pts[k][0], f), lerp(pts[k - 1][1], pts[k][1], f)]);
  }
  return out;
}

/** Rounded box — the workhorse for mirrors, spoilers, vents, bumpers. Never use a raw BoxGeometry. */
export function roundedBox(w, h, d, r = 0.05, seg = 3) {
  const shape = new THREE.Shape();
  const x = -w / 2, y = -h / 2;
  r = Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3);
  shape.moveTo(x + r, y);
  shape.lineTo(x + w - r, y);
  shape.quadraticCurveTo(x + w, y, x + w, y + r);
  shape.lineTo(x + w, y + h - r);
  shape.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  shape.lineTo(x + r, y + h);
  shape.quadraticCurveTo(x, y + h, x, y + h - r);
  shape.lineTo(x, y + r);
  shape.quadraticCurveTo(x, y, x + r, y);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: d, bevelEnabled: true, bevelSize: r * 0.5, bevelThickness: r * 0.5,
    bevelSegments: seg, curveSegments: seg * 2,
  });
  geo.translate(0, 0, -d / 2);
  geo.computeVertexNormals();
  return geo;
}

// ------------------------------------------------------------------ wheels

/**
 * A wheel: tire with sidewall bulge, rim barrel, spokes, hub, brake disc and caliper.
 * @param style 'mesh'|'fivespoke'|'offroad'|'turbofan'
 */
export function buildWheel({
  radius = 0.36, width = 0.26, spokes = 5, style = 'fivespoke',
  rimColor = '#cfd4da', caliperColor = '#c81f1f', tireProfile = 0.34,
} = {}) {
  const g = new THREE.Group();
  const tireMat = tireMaterial();

  // --- tire: a torus-ish lathe so the sidewall bulges instead of being a flat cylinder ---
  const rimR = radius * (1 - tireProfile);
  const prof = [];
  const steps = 10;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = -Math.PI / 2 + t * Math.PI;
    const bulge = Math.cos(a) * (width * 0.5) * 1.0;
    const rr = lerp(rimR, radius, Math.sin(t * Math.PI) * 0.35 + (t > 0.15 && t < 0.85 ? 0.65 : 0));
    prof.push(new THREE.Vector2(Math.max(rimR * 0.98, Math.min(radius, rr)), bulge));
  }
  // simpler, reliable tread profile
  const prof2 = [
    new THREE.Vector2(rimR, -width * 0.5),
    new THREE.Vector2(radius * 0.93, -width * 0.5),
    new THREE.Vector2(radius, -width * 0.34),
    new THREE.Vector2(radius, width * 0.34),
    new THREE.Vector2(radius * 0.93, width * 0.5),
    new THREE.Vector2(rimR, width * 0.5),
  ];
  const tireGeo = new THREE.LatheGeometry(prof2, 34);
  tireGeo.rotateZ(Math.PI / 2);
  const tire = new THREE.Mesh(tireGeo, tireMat);
  tire.castShadow = true;
  g.add(tire);

  // --- rim barrel ---
  const rimMat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(rimColor), metalness: 1.0, roughness: 0.16, envMapIntensity: 2.2, clearcoat: 0.6,
  });
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(rimR, rimR * 0.96, width * 0.94, 28, 1, true), rimMat);
  barrel.rotation.z = Math.PI / 2;
  g.add(barrel);

  // --- face plate + spokes ---
  const face = new THREE.Mesh(new THREE.CircleGeometry(rimR * 0.99, 28), rimMat);
  face.rotation.y = Math.PI / 2;
  face.position.x = width * 0.44;
  g.add(face);

  const hub = new THREE.Mesh(new THREE.CylinderGeometry(rimR * 0.22, rimR * 0.24, width * 0.30, 18), rimMat);
  hub.rotation.z = Math.PI / 2; hub.position.x = width * 0.40;
  g.add(hub);

  const dark = new THREE.MeshStandardMaterial({ color: 0x0b0c0e, roughness: 0.85, metalness: 0.2 });
  const spokeCount = style === 'mesh' ? spokes * 2 : spokes;
  for (let i = 0; i < spokeCount; i++) {
    const a = (i / spokeCount) * Math.PI * 2;
    let geo;
    if (style === 'offroad') geo = roundedBox(rimR * 0.30, rimR * 0.80, width * 0.22, 0.02);
    else if (style === 'turbofan') geo = roundedBox(rimR * 0.44, rimR * 0.86, width * 0.14, 0.03);
    else geo = roundedBox(rimR * 0.20, rimR * 0.86, width * 0.20, 0.025);
    const s = new THREE.Mesh(geo, rimMat);
    s.position.set(width * 0.36, Math.cos(a) * rimR * 0.50, Math.sin(a) * rimR * 0.50);
    s.rotation.x = -a;
    s.rotation.y = Math.PI / 2;
    // orient the spoke to point outward from the hub
    s.rotation.set(0, Math.PI / 2, -a);
    s.position.set(width * 0.36, Math.cos(a) * rimR * 0.5, Math.sin(a) * rimR * 0.5);
    g.add(s);
    if (style === 'turbofan') continue;
    // negative space behind the spokes reads as depth
    const gap = new THREE.Mesh(new THREE.CircleGeometry(rimR * 0.92, 24), dark);
    gap.rotation.y = Math.PI / 2;
    gap.position.x = width * 0.30;
    if (i === 0) g.add(gap);
  }

  // --- brake disc + caliper ---
  const disc = new THREE.Mesh(
    new THREE.CylinderGeometry(rimR * 0.74, rimR * 0.74, width * 0.10, 24),
    new THREE.MeshStandardMaterial({ color: 0x6b6f76, metalness: 0.95, roughness: 0.42 }),
  );
  disc.rotation.z = Math.PI / 2; disc.position.x = width * 0.06;
  g.add(disc);
  const cal = new THREE.Mesh(roundedBox(width * 0.16, rimR * 0.52, rimR * 0.30, 0.02),
    new THREE.MeshStandardMaterial({ color: new THREE.Color(caliperColor), metalness: 0.5, roughness: 0.35 }));
  cal.position.set(width * 0.04, rimR * 0.42, 0);
  g.add(cal);

  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

// ------------------------------------------------------------------ shared details

/** Contact shadow blob — §7 caps a hovering car at 55. Every vehicle must have one. */
export function contactShadow(w = 2.2, l = 5.0) {
  const tex = sprite({ size: 128, shape: 'glow', color: '#000000', seed: 2 });
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(w, l),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.62, depthWrite: false, color: 0x000000 }),
  );
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.02;
  m.renderOrder = 2;
  m.name = 'contactShadow';
  return m;
}

/** Headlight / taillight lens: emissive core + a soft glow card that faces the camera. */
export function lightUnit({
  w = 0.34, h = 0.16, color = '#ff2418', intensity = 4.0, glow = 1.0, shape = 'rect',
} = {}) {
  const g = new THREE.Group();
  const lensGeo = shape === 'round'
    ? new THREE.CircleGeometry(h * 0.5, 20)
    : roundedBox(w, h, 0.03, Math.min(w, h) * 0.28);
  const lens = new THREE.Mesh(lensGeo, emissiveMaterial({ color, intensity }));
  g.add(lens);
  if (glow > 0) {
    const gl = new THREE.Mesh(
      new THREE.PlaneGeometry(w * 2.6, h * 3.4),
      new THREE.MeshBasicMaterial({
        map: sprite({ size: 128, shape: 'glow', color, seed: 4 }),
        transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: glow,
      }),
    );
    gl.position.z = 0.02;
    gl.name = 'glow';
    g.add(gl);
  }
  return g;
}

/** Livery texture: stripes / two-tone / panels drawn into the paint map (§2.3). */
export function liveryTexture({
  base = '#1b7f6b', stripe = null, style = 'none', seed = 1, size = 512,
} = {}) {
  const { c, ctx } = canvas(size, size);
  ctx.fillStyle = base; ctx.fillRect(0, 0, size, size);
  if (style === 'stripes' && stripe) {
    ctx.fillStyle = stripe;
    ctx.fillRect(size * 0.44, 0, size * 0.045, size);
    ctx.fillRect(size * 0.515, 0, size * 0.045, size);
  } else if (style === 'twotone' && stripe) {
    ctx.fillStyle = stripe;
    ctx.fillRect(0, size * 0.62, size, size * 0.38);
  } else if (style === 'racing' && stripe) {
    ctx.fillStyle = stripe;
    ctx.save(); ctx.translate(size * 0.5, size * 0.5); ctx.rotate(-0.22);
    ctx.fillRect(-size, -size * 0.10, size * 2, size * 0.20);
    ctx.restore();
  }
  const rng = new RNG(seed);
  grain(ctx, size, size, 3, rng);
  return toTexture(c, { srgb: true });
}

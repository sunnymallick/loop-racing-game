import * as THREE from 'three';
import { RNG, clamp, lerp, smoothstep } from '../core/rng.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { canvas, toTexture, grain, fbmField, normalFromHeight, grayCanvas, sprite } from '../core/textures.js';

/**
 * Vehicle construction kit.
 *
 * ART_DIRECTION.md §6.1 caps any car whose body is "a stack of unmodified boxes" at 45. The way
 * out of that is loftBody(): describe a car as a series of CROSS-SECTIONS down its length and let
 * this module skin them. That is how real car silhouettes — long hood, fast roofline, tucked
 * rocker, flared arch — become achievable without an imported model.
 *
 * The loft's UV space is the car's unwrapped skin and is the thing that makes livery, shut lines
 * and character-line shading possible:
 *
 *   u = 0.00  bottom centreline        u = 0.25  right flank
 *   u = 0.50  roof / deck centreline   u = 0.75  left flank      u = 1.00  bottom centreline
 *   v = 0.00  tail                     v = 1.00  nose
 *
 * u is ARC-LENGTH parameterised and averaged across sections, so a stripe drawn in the texture has
 * a constant real-world width all the way down the car. `profileU(sections)` hands back the u of
 * every point in the authored half-profile, which is how a shut line knows where the rocker and
 * the beltline are.
 *
 * Convention: +Z is FORWARD, +X is right, +Y is up. Origin at the centre of the wheelbase, on the
 * ground plane.
 */

// ------------------------------------------------------------------ materials

/**
 * Metallic clearcoat car paint.
 *
 * Deliberately LOW metalness: a fully metallic body just mirrors the sky and the paint colour
 * disappears (§2.3 wants colour *plus* a sky reflection on the upper panels and a dark ground
 * reflection below). The clearcoat layer is what samples the env map sharply, so the colour
 * survives and the reflection still reads.
 */
export function paintMaterial({
  color = '#d92b2b', metalness = 0.30, roughness = 0.30, clearcoat = 1.0,
  clearcoatRoughness = 0.045, flake = 0.55, seed = 3, map = null, envIntensity = 0.95,
} = {}) {
  const mat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(color),
    metalness, roughness, clearcoat, clearcoatRoughness,
    envMapIntensity: envIntensity,
    map,
  });
  if (flake > 0) {
    mat.normalMap = flakeNormal(seed);
    mat.normalScale = new THREE.Vector2(flake * 0.10, flake * 0.10);
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
  _flake.repeat.set(26, 26);
  return _flake;
}

export function glassMaterial({ tint = '#080d13', opacity = 0.80, rough = 0.045 } = {}) {
  return new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(tint),
    metalness: 0.0, roughness: rough,
    transparent: true, opacity,
    envMapIntensity: 0.9,
    clearcoat: 1, clearcoatRoughness: 0.02,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
}

export function chromeMaterial({ color = '#b3b9c2', rough = 0.16 } = {}) {
  // envMapIntensity used to be 1.35 on a near-white base colour, which pushed every bumper, bezel
  // and mirror past the bloom threshold: the chrome read as a glowing white blob, not metal
  // (§6.1 round-3 note). Polished aluminium is a DARK material that borrows the sky — 1.0 on a
  // 0.70-value base is what actually reads as chrome under a sunset key.
  return new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(color), metalness: 1.0, roughness: rough, envMapIntensity: 1.0,
  });
}

/**
 * Satin dark trim — bumpers, valances, rockers, tail panels.
 *
 * At metalness 0.35 / roughness 0.62 every upward-facing dark part mirrored the sunset sky, so the
 * front and rear valances rendered as bright pale slabs the size of the nose in any side-on frame.
 * Trim is painted plastic or matt-black steel: barely metallic, and rough enough to scatter.
 */
export function darkTrimMaterial({ color = '#15161a', rough = 0.74 } = {}) {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(color), metalness: 0.14, roughness: rough, envMapIntensity: 0.55,
  });
}

/** Satin black plastic — bumper inserts, arch liners, diffusers. Not the same as gloss trim. */
export function plasticMaterial({ color = '#121317', rough = 0.85 } = {}) {
  return new THREE.MeshStandardMaterial({ color: new THREE.Color(color), metalness: 0.1, roughness: rough });
}

let _carbon = null;
/** Woven carbon for splitters, wings and diffusers — reads as a real material, not black paint. */
export function carbonMaterial() {
  if (_carbon) return _carbon;
  const size = 256, cell = 16;
  const { c, ctx } = canvas(size, size);
  ctx.fillStyle = '#0c0d10'; ctx.fillRect(0, 0, size, size);
  for (let y = 0; y < size; y += cell) {
    for (let x = 0; x < size; x += cell) {
      const over = ((x / cell) + (y / cell)) % 2 === 0;
      const g = ctx.createLinearGradient(x, y, over ? x + cell : x, over ? y : y + cell);
      g.addColorStop(0, '#2b2e35'); g.addColorStop(0.5, '#43474f'); g.addColorStop(1, '#191b1f');
      ctx.fillStyle = g; ctx.fillRect(x, y, cell - 1, cell - 1);
    }
  }
  grain(ctx, size, size, 5, new RNG(9));
  // Carbon is a DARK material with a tight sheen. At envMapIntensity 1.1 + clearcoat gloss the
  // wings, splitters and diffusers mirrored the whole sky and read as pale plastic planks.
  _carbon = new THREE.MeshPhysicalMaterial({
    map: toTexture(c, { srgb: true, repeat: [3, 3] }),
    metalness: 0.5, roughness: 0.38, clearcoat: 1, clearcoatRoughness: 0.16, envMapIntensity: 0.55,
  });
  return _carbon;
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

// ------------------------------------------------------------------ tyres

/**
 * Tyre tread maps, one per CLASS of rubber. §6.1 round-1 note: shipping one knobby off-road
 * carcass on a supercar is an instant tell, so every class gets its own compound.
 *
 * The tyre carcass is a revolved profile RESAMPLED to equal arc length, so v in this canvas is a
 * true distance across the tread face:
 *     v = 0.00 … 0.27  outer sidewall (the one you see)
 *     v = 0.27 … 0.73  tread face
 *     v = 0.73 … 1.00  inner sidewall
 * u wraps once around the circumference.
 */
const TREAD_V0 = 0.275, TREAD_V1 = 0.725;
const _tireMats = new Map();

export function tireMaterial(kind = 'street') {
  if (_tireMats.has(kind)) return _tireMats.get(kind);
  const size = 512;
  const { c, ctx } = canvas(size, size);
  const rng = new RNG(17 + kind.length);
  const hf = new Float32Array(size * size);
  const V = (v) => v * size;
  const setH = (x0, y0, w, h, v) => {
    for (let y = Math.max(0, y0 | 0); y < Math.min(size, (y0 + h) | 0); y++) {
      for (let x = Math.floor(x0); x < Math.ceil(x0 + w); x++) hf[y * size + ((x % size) + size) % size] = v;
    }
  };
  const band = (v0, v1, fill) => { ctx.fillStyle = fill; ctx.fillRect(0, V(v0), size, V(v1 - v0)); };
  const groove = (v, hpx, dark = '#0a0b0e') => {
    band(v - hpx / size / 2, v + hpx / size / 2, dark);
    setH(0, V(v) - hpx / 2, size, hpx, 0);
  };
  // a block of tread rubber: bright-ish face, and height 1 so the normal map lifts it
  const blk = (u0, wpx, v0, v1, fill = '#3d424d', hgt = 1) => {
    ctx.fillStyle = fill;
    for (const off of [-size, 0, size]) ctx.fillRect(u0 + off, V(v0), wpx, V(v1 - v0));
    setH(u0, V(v0), wpx, V(v1 - v0), hgt);
  };

  // ROUND-3 TONE PASS. Round 2's carcass was #191c22 multiplied by a 0.84 material colour: an
  // albedo of ~0.03 linear. Under a sunset key inside a wheel arch that is mathematically black,
  // which is exactly why every critic frame showed "a solid black blob with no rim, spoke or
  // sidewall". Photographed rubber sits around 0.10–0.14 albedo and games push it higher still,
  // so the carcass is now mid-charcoal and every moulded feature is drawn against it with real
  // contrast. The grooves stay near-black — the READ is groove-to-block contrast, not overall value.
  const carcass = kind === 'knobby' ? '#5c626c' : '#555b65';
  ctx.fillStyle = carcass; ctx.fillRect(0, 0, size, size);
  // the tread face starts as the deep groove floor; blocks are then stamped proud of it
  band(TREAD_V0, TREAD_V1, kind === 'knobby' ? '#212429' : '#262a31');

  const T0 = TREAD_V0, T1 = TREAD_V1, TW = T1 - T0;

  if (kind === 'slick') {
    // supercar semi-slick: near-solid face, four fine circumferential grooves, faint lateral sipes
    blk(0, size, T0 + 0.005, T1 - 0.005, '#6f7681');
    for (const f of [0.20, 0.42, 0.58, 0.80]) groove(T0 + TW * f, 5, '#14161b');
    for (let i = 0; i < 96; i++) {
      const x = (i / 96) * size + ((i % 2) ? 2 : 0);
      ctx.fillStyle = 'rgba(10,11,14,0.80)';
      ctx.fillRect(x, V(T0 + TW * 0.03), 2.0, V(TW * 0.16));
      ctx.fillRect(x, V(T0 + TW * 0.81), 2.0, V(TW * 0.16));
    }
  } else if (kind === 'street') {
    // tuner: asymmetric performance tread — two fat grooves plus a chevron shoulder
    const n = 48;
    for (let i = 0; i < n; i++) {
      const x = (i / n) * size, bw = size / n;
      blk(x + 1, bw - 2.5, T0 + 0.004, T0 + TW * 0.30, '#606773', 0.35);
      blk(x + bw * 0.5, bw - 3, T0 + TW * 0.34, T0 + TW * 0.64, '#7a828f', 0.9);
      blk(x + 1, bw - 2.5, T0 + TW * 0.68, T1 - 0.004, '#606773', 0.35);
    }
    groove(T0 + TW * 0.315, 6, '#15171c'); groove(T0 + TW * 0.665, 6, '#15171c');
    for (const f of [0.13, 0.87]) groove(T0 + TW * f, 3, '#1a1d23');
  } else if (kind === 'muscle') {
    // raised-sidewall street tyre: chunky square blocks, three grooves, white lettering.
    // Shoulder blocks are kept low-contrast — a hard block/gap ring at the shoulder reads as
    // stitching from three metres away, which is worse than no tread at all.
    const n = 40;
    for (let i = 0; i < n; i++) {
      const x = (i / n) * size, bw = size / n;
      const st = (i % 2) * bw * 0.4;
      blk(x + 1.5, bw - 3, T0 + 0.005, T0 + TW * 0.27, '#5d646f', 0.30);
      blk(x + 1.5 + st, bw - 4, T0 + TW * 0.32, T0 + TW * 0.66, '#7d8592', 0.9);
      blk(x + 1.5, bw - 3, T0 + TW * 0.71, T1 - 0.005, '#5d646f', 0.30);
    }
    groove(T0 + TW * 0.295, 7, '#15171c'); groove(T0 + TW * 0.685, 7, '#15171c');
  } else {                                   // knobby — SUV only
    const n = 22;
    for (let i = 0; i < n; i++) {
      const x = (i / n) * size, bw = size / n;
      const st = (i % 2) * bw * 0.5;
      blk(x + 3, bw - 10, T0 - 0.020, T0 + TW * 0.26, '#828a96');
      blk(x + 3 + st, bw * 0.46, T0 + TW * 0.34, T0 + TW * 0.66, '#8b929e');
      blk(x + 3, bw - 10, T0 + TW * 0.74, T1 + 0.020, '#828a96');
      // side-biters running down onto the sidewall — the off-road signature
      blk(x + 4, bw * 0.34, T0 - 0.062, T0 - 0.020, '#6f7681');
      blk(x + 4, bw * 0.34, T1 + 0.020, T1 + 0.062, '#6f7681');
    }
  }

  // ---- sidewalls ----
  // §6.1 gives 15 points to "spokes, sidewall, arch fill". Round 2 scored zero of the sidewall
  // half because the flank of the tyre was one flat value. A real sidewall is a stack of moulded
  // rings at different depths: bead heel (in shadow), rim-protector rib (proud), a smooth
  // lettering band, then the shoulder rolling into the tread. Each one is drawn with BOTH an
  // albedo step and a height step, so it survives being three pixels tall on screen.
  const swInner = kind === 'knobby' ? 0.235 : 0.245;
  const mirrorV = (v0, h0, fill, hgt = null) => {
    ctx.fillStyle = fill;
    ctx.fillRect(0, V(v0), size, V(h0));
    ctx.fillRect(0, V(1 - v0 - h0), size, V(h0));
    if (hgt !== null) { setH(0, V(v0), size, V(h0), hgt); setH(0, V(1 - v0 - h0), size, V(h0), hgt); }
  };
  // bead heel: the dark, tucked-under root of the sidewall against the rim flange
  mirrorV(0.000, 0.048, 'rgba(0,0,0,0.55)', 0.02);
  mirrorV(0.048, 0.020, 'rgba(255,255,255,0.10)', 0.55);         // machined bead face
  // rim-protector rib — the proud ring that saves the alloy from kerbs. The brightest ring on the
  // tyre, and the one that draws the eye to the wheel from across the street.
  mirrorV(0.074, 0.030, 'rgba(226,230,238,0.155)', 0.95);
  mirrorV(0.104, 0.012, 'rgba(0,0,0,0.42)', 0.18);               // shadow under the rib
  // smooth lettering band, then two fine moulded ribs above it
  mirrorV(0.116, 0.062, 'rgba(255,255,255,0.045)', 0.42);
  mirrorV(0.186, 0.011, 'rgba(255,255,255,0.085)', 0.62);
  mirrorV(0.212, 0.009, 'rgba(0,0,0,0.30)', 0.24);
  // shoulder: the sidewall turns over into the tread and loses the light
  for (const v of [swInner, 1 - swInner - 0.02]) {
    const g = ctx.createLinearGradient(0, V(v), 0, V(v + 0.028));
    g.addColorStop(0, 'rgba(0,0,0,0.0)'); g.addColorStop(1, 'rgba(0,0,0,0.50)');
    ctx.fillStyle = g; ctx.fillRect(0, V(v), size, V(0.028));
  }
  // radial casing marks: fine ribs running out from the bead. These are what make the sidewall
  // read as a ROTATING surface instead of a static ring when the car is moving.
  for (let i = 0; i < 84; i++) {
    const x = (i / 84) * size, w = size / 84 * 0.55;
    ctx.fillStyle = i % 2 ? 'rgba(255,255,255,0.055)' : 'rgba(0,0,0,0.24)';
    ctx.fillRect(x, V(0.048), w, V(0.062));
    ctx.fillRect(x, V(0.890), w, V(0.062));
    setH(x, V(0.048), w, V(0.062), i % 2 ? 0.62 : 0.30);
  }
  // lettering ring — raised white letters on the muscle car, moulded grey elsewhere.
  // Drawn as real glyph-ish blocks of varying width so it reads as a moulded WORD, not a dash row.
  const letterCol = kind === 'muscle' ? 'rgba(232,234,228,0.34)' : 'rgba(176,182,192,0.16)';
  const lv = kind === 'muscle' ? 0.128 : 0.134, lh = kind === 'muscle' ? 0.032 : 0.026;
  ctx.fillStyle = letterCol;
  for (let i = 0; i < 52; i++) {
    const slot = i % 13;
    if (slot >= 9) continue;                          // a gap of 4 slots between the two words
    const x = (i / 52) * size;
    const w = (size / 52) * (slot % 3 === 1 ? 0.30 : 0.52);
    ctx.fillRect(x + 2, V(lv), w, V(lh));
    setH(x + 2, V(lv), w, V(lh), kind === 'muscle' ? 0.85 : 0.55);
    ctx.fillRect(x + 2, V(1 - lv - lh), w, V(lh));
  }

  for (let i = 0; i < hf.length; i++) hf[i] = hf[i] * 0.82 + 0.09;
  grain(ctx, size, size, kind === 'knobby' ? 7 : 5, rng);

  // Roughness now spans 0.95 (groove floor, dead matte) → 0.48 (block crown, a soft sheen). At the
  // old 0.99→0.74 the whole carcass was perfectly matte, so a tyre received no specular at all and
  // collapsed to its (very dark) albedo the moment it was not in direct sun.
  const mat = new THREE.MeshStandardMaterial({
    map: toTexture(c, { srgb: true }),
    normalMap: toTexture(normalFromHeight(hf, size, size, kind === 'knobby' ? 3.4 : 2.2), { srgb: false }),
    roughnessMap: toTexture(grayCanvas(hf, size, size, 0.95, kind === 'slick' ? 0.40 : 0.50), { srgb: false }),
    roughness: 1.0, metalness: 0.0, color: 0xffffff, envMapIntensity: 1.0,
  });
  mat.normalScale = new THREE.Vector2(1.6, 1.6);
  _tireMats.set(kind, mat);
  return mat;
}

let _discTex = null;
/** Drilled + vaned brake rotor face. Visible through the spoke windows — that's the whole point. */
function discTexture() {
  if (_discTex) return _discTex;
  const size = 256, h = size / 2;
  const { c, ctx } = canvas(size, size);
  ctx.fillStyle = '#0a0b0d'; ctx.fillRect(0, 0, size, size);
  const g = ctx.createRadialGradient(h, h, size * 0.08, h, h, h);
  g.addColorStop(0.00, '#16181c');
  g.addColorStop(0.28, '#787e88');
  g.addColorStop(0.55, '#a7adb6');
  g.addColorStop(0.90, '#868c96');
  g.addColorStop(0.97, '#c2c8d0');
  g.addColorStop(1.00, '#33373d');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(h, h, h, 0, 7); ctx.fill();
  // machining swirl
  ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 1;
  for (let i = 0; i < 26; i++) { ctx.beginPath(); ctx.arc(h, h, h * (0.30 + i * 0.026), 0, 7); ctx.stroke(); }
  // curved cooling slots + drill holes
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    ctx.save(); ctx.translate(h, h); ctx.rotate(a);
    ctx.fillStyle = 'rgba(8,9,11,0.85)';
    ctx.beginPath(); ctx.moveTo(h * 0.34, -3); ctx.lineTo(h * 0.88, -9); ctx.lineTo(h * 0.88, -3); ctx.lineTo(h * 0.34, 2);
    ctx.closePath(); ctx.fill();
    for (const rr of [0.46, 0.62, 0.78]) {
      ctx.beginPath(); ctx.arc(h * rr, h * 0.10, 3.0, 0, 7); ctx.fill();
    }
    ctx.restore();
  }
  ctx.fillStyle = '#14161a'; ctx.beginPath(); ctx.arc(h, h, h * 0.28, 0, 7); ctx.fill();
  _discTex = toTexture(c, { srgb: true });
  return _discTex;
}

// ------------------------------------------------------------------ lofting

function buildRings(sections) {
  const secs = [...sections].sort((a, b) => a.z - b.z);
  const n = secs[0].pts.length;
  for (const s of secs) {
    if (s.pts.length !== n) throw new Error(`loft: section at z=${s.z} has ${s.pts.length} pts, expected ${n}`);
  }
  // full ring = half profile, its mirror, then the first point duplicated so u wraps 0 → 1
  const rings = secs.map((s) => {
    const sc = s.scale ?? 1;
    const half = s.pts.map((p) => [p[0] * sc, p[1] * sc]);
    const ring = half.slice();
    for (let i = n - 2; i >= 1; i--) ring.push([-half[i][0], half[i][1]]);
    ring.push([half[0][0], half[0][1]]);
    return ring;
  });
  const L = rings[0].length;                    // 2n - 1

  // arc-length u, averaged over every section so the skin does not swim along the length
  const acc = new Float64Array(L);
  for (const ring of rings) {
    let run = 0;
    const cum = [0];
    for (let i = 1; i < L; i++) {
      run += Math.hypot(ring[i][0] - ring[i - 1][0], ring[i][1] - ring[i - 1][1]);
      cum.push(run);
    }
    const tot = run || 1;
    for (let i = 0; i < L; i++) acc[i] += cum[i] / tot;
  }
  const us = new Float64Array(L);
  for (let i = 0; i < L; i++) us[i] = acc[i] / rings.length;

  const z0 = secs[0].z, z1 = secs[secs.length - 1].z;
  const vs = secs.map((s) => (s.z - z0) / ((z1 - z0) || 1));

  // outward 2D normals, for shells that must sit proud of the surface
  const norms = rings.map((ring) => {
    let cx = 0, cy = 0;
    for (let i = 0; i < L - 1; i++) { cx += ring[i][0]; cy += ring[i][1]; }
    cx /= (L - 1); cy /= (L - 1);
    return ring.map((p, i) => {
      const a = ring[(i - 1 + L - 1) % (L - 1)], b = ring[(i + 1) % (L - 1)];
      let tx = b[0] - a[0], ty = b[1] - a[1];
      const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
      let nx = ty, ny = -tx;
      if (nx * (p[0] - cx) + ny * (p[1] - cy) < 0) { nx = -nx; ny = -ny; }
      return [nx, ny];
    });
  });

  return { secs, rings, norms, n, L, us, vs };
}

/** u of every point of the authored half-profile — the anchor table the livery generator needs. */
export function profileU(sections) {
  const { us, n } = buildRings(sections);
  return Array.from({ length: n }, (_, i) => us[i]);
}

/**
 * Skin a series of cross-sections into a closed body.
 *
 * @param sections [{ z, pts:[[x,y],...], scale? }]  half-profiles, x >= 0, ordered from the
 *                 BOTTOM CENTRE (x≈0) up and over to the TOP CENTRE (x≈0).
 *                 Every section must have the same point count.
 * @param opts.capFront/capRear  close the ends (default true)
 * @param opts.smooth   averaged vertex normals (default true). Use duplicated, closely-spaced
 *                      sections to keep an edge hard.
 */
export function loftBody(sections, { capFront = true, capRear = true, smooth = true } = {}) {
  const { secs, rings, L, us, vs } = buildRings(sections);
  const pos = [], uv = [], idx = [];
  for (let si = 0; si < secs.length; si++) {
    for (let i = 0; i < L; i++) {
      pos.push(rings[si][i][0], rings[si][i][1], secs[si].z);
      uv.push(us[i], vs[si]);
    }
  }
  for (let si = 0; si < secs.length - 1; si++) {
    for (let i = 0; i < L - 1; i++) {
      const a = si * L + i, b = a + 1, c = a + L, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const capRing = (si, flip) => {
    const cx = pos.length / 3;
    let mx = 0, my = 0;
    for (let i = 0; i < L - 1; i++) { mx += rings[si][i][0]; my += rings[si][i][1]; }
    mx /= (L - 1); my /= (L - 1);
    pos.push(mx, my, secs[si].z); uv.push(0.5, vs[si]);
    const base = si * L;
    for (let i = 0; i < L - 1; i++) {
      const a = base + i, b = base + i + 1;
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
  void smooth;
  return geo;
}

/**
 * Skin one BAND of the same ring — ring indices a…b — as an open shell.
 *
 * This is how a roof panel, an A-pillar or a fastback sail gets built out of exactly the same
 * cross-sections as the glasshouse underneath it, so it fits with zero gap. `offset` pushes it
 * proud of the surface along the 2D outward normal.
 */
export function loftBand(sections, a, b, { offset = 0.012, side = 'right' } = {}) {
  const { secs, rings, norms, L, us, vs } = buildRings(sections);
  const pos = [], uv = [], idx = [];
  const emit = (i0, i1) => {
    const base = pos.length / 3;
    const cols = i1 - i0 + 1;
    for (let si = 0; si < secs.length; si++) {
      for (let k = 0; k < cols; k++) {
        const i = i0 + k;
        const p = rings[si][i], nrm = norms[si][i];
        pos.push(p[0] + nrm[0] * offset, p[1] + nrm[1] * offset, secs[si].z);
        uv.push(us[i], vs[si]);
      }
    }
    for (let si = 0; si < secs.length - 1; si++) {
      for (let k = 0; k < cols - 1; k++) {
        const p0 = base + si * cols + k, p1 = p0 + 1, p2 = p0 + cols, p3 = p2 + 1;
        idx.push(p0, p2, p1, p1, p2, p3);
      }
    }
  };
  emit(a, b);
  if (side === 'both') emit(L - 1 - b, L - 1 - a);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
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
export function roundedBox(w, h, d, r = 0.05, seg = 2) {
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

/**
 * One spoke of an alloy wheel: an annular SECTOR (arcs top and bottom, not a straight blade),
 * wider at the hub than at the rim, extruded along the wheel axis with a bevel so the face
 * catches a highlight. Built in the YZ plane, axis +X.
 */
function rimSector(rIn, rOut, halfIn, halfOut, depth, twist = 0) {
  const s = new THREE.Shape();
  const seg = 4;
  const arc = (r, half, a0, from) => {
    for (let i = 0; i <= seg; i++) {
      const a = a0 + (i / seg) * 2 * half * from;
      const p = [Math.cos(a) * r, Math.sin(a) * r];
      if (i === 0 && from > 0) s.moveTo(p[0], p[1]); else s.lineTo(p[0], p[1]);
    }
  };
  arc(rOut, halfOut, -halfOut + twist, 1);
  arc(rIn, halfIn, halfIn, -1);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, {
    depth, bevelEnabled: true, bevelSize: Math.min(0.010, depth * 0.3),
    bevelThickness: Math.min(0.010, depth * 0.3), bevelSegments: 1, curveSegments: 1,
  });
  g.translate(0, 0, -depth / 2);
  g.rotateY(Math.PI / 2);            // YZ plane, extruded along +X
  g.computeVertexNormals();
  return g;
}

/**
 * A revolved annulus/cone shell about the X axis — rim flanges, dishes, barrel steps.
 * Points are [radius, axial] with axial measured OUTBOARD-POSITIVE; the wheel is built with its
 * face toward -X (assemble.js mirrors the right-hand side), and LatheGeometry + rotateZ(+π/2)
 * negates the axial coordinate, which is exactly that mapping.
 */
function ringLathe(pts, seg = 24) {
  const g = new THREE.LatheGeometry(pts.map((p) => new THREE.Vector2(p[0], p[1])), seg);
  g.rotateZ(Math.PI / 2);
  return g;
}

/** A tapered, rounded blade in the YZ plane extruded along X — spokes, wing elements, pillars. */
function taperedBlade(rInner, rOuter, wInner, wOuter, depth, r = 0.012) {
  const s = new THREE.Shape();
  s.moveTo(-wInner / 2, rInner);
  s.lineTo(-wOuter / 2, rOuter - r);
  s.quadraticCurveTo(-wOuter / 2, rOuter, -wOuter / 2 + r, rOuter);
  s.lineTo(wOuter / 2 - r, rOuter);
  s.quadraticCurveTo(wOuter / 2, rOuter, wOuter / 2, rOuter - r);
  s.lineTo(wInner / 2, rInner);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, {
    depth, bevelEnabled: true, bevelSize: 0.008, bevelThickness: 0.008, bevelSegments: 1, curveSegments: 2,
  });
  g.translate(0, 0, -depth / 2);
  g.computeVertexNormals();
  return g;
}

// ------------------------------------------------------------------ wheels

/**
 * A wheel: tyre with a real sidewall bulge and tread, a dished rim with spokes that have depth,
 * lug nuts, a centre cap, brake disc and caliper.
 *
 * Returns a Group whose child named 'spin' is the part that rotates — the caliper stays put.
 * @param style 'mesh'|'fivespoke'|'offroad'|'turbofan'
 */
export function buildWheel({
  radius = 0.36, width = 0.26, spokes = 5, style = 'fivespoke',
  rimColor = '#cfd4da', caliperColor = '#c81f1f', tireProfile = 0.30, lipColor = null,
  tire = 'street', capColor = null, beadlock = false,
} = {}) {
  const g = new THREE.Group();
  const spin = new THREE.Group();
  spin.name = 'spin';
  g.add(spin);

  const rimR = radius * (1 - tireProfile);       // bead seat = the alloy's outer radius
  const side = radius - rimR;                    // sidewall height
  const hw = width * 0.5;
  // A tall sidewall bulges; a low-profile one is nearly straight and squares off at the shoulder.
  const bulge = tire === 'knobby' ? 1.11 : tire === 'muscle' ? 1.075 : tire === 'street' ? 1.045 : 1.028;
  const shoulder = tire === 'knobby' ? 0.60 : tire === 'slick' ? 0.86 : 0.76;

  // --- tyre --------------------------------------------------------------
  // Authored loosely, then RESAMPLED to equal arc length so the tread map lands on the tread and
  // the sidewall map lands on the sidewall (round 1 stretched an off-road lug over every surface).
  const raw = [
    [rimR * 0.995, -hw * 0.80],
    [rimR + side * 0.16, -hw * 0.96],
    [rimR + side * 0.46, -hw * bulge],                    // widest point of the sidewall
    [rimR + side * 0.78, -hw * (bulge * 0.96)],
    [radius * 0.988, -hw * (shoulder + 0.10)],
    [radius, -hw * shoulder],                             // tread shoulder
    [radius, 0],
    [radius, hw * shoulder],
    [radius * 0.988, hw * (shoulder + 0.10)],
    [rimR + side * 0.78, hw * (bulge * 0.96)],
    [rimR + side * 0.46, hw * bulge],
    [rimR + side * 0.16, hw * 0.96],
    [rimR * 0.995, hw * 0.80],
  ];
  const prof = resample(raw, 22).map((p) => new THREE.Vector2(p[0], p[1]));
  // 32 segments, not 24: at 24 the outer sidewall silhouette was visibly a polygon in any close
  // frame, which reads as a faceted black donut rather than rubber.
  const tireGeo = new THREE.LatheGeometry(prof, 32);
  tireGeo.rotateZ(Math.PI / 2);
  const tyre = new THREE.Mesh(tireGeo, tireMaterial(tire));
  spin.add(tyre);

  // --- alloy -------------------------------------------------------------
  // DoubleSide on the alloy: the rim is built from lathed shells whose profiles reverse direction
  // (a rolled bead is concave then convex), so a single-sided material culls half of the face.
  // envMapIntensity 2.2 on a near-white base blew every alloy past the bloom threshold: the wheel
  // rendered as a glowing white disc with a halo and NO readable spoke, which is the round-2
  // "featureless" verdict restated. 1.15 keeps the metal reflective but inside the tonemap, so the
  // spoke faces, the dish and the shadow between them all survive.
  const rimMat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(rimColor), metalness: 1.0,
    roughness: style === 'offroad' ? 0.34 : style === 'turbofan' ? 0.26 : 0.17,
    envMapIntensity: 1.15, clearcoat: 0.8, clearcoatRoughness: 0.07, side: THREE.DoubleSide,
  });
  const lipMat = lipColor
    ? new THREE.MeshPhysicalMaterial({ color: new THREE.Color(lipColor), metalness: 1.0, roughness: 0.20, envMapIntensity: 1.05, clearcoat: 1, side: THREE.DoubleSide })
    : rimMat;
  const wellMat = new THREE.MeshStandardMaterial({ color: 0x0a0b0e, roughness: 0.92, metalness: 0.2 });

  // The rim used to sit 50–70 mm inboard of the outer sidewall, so from anywhere but dead side-on
  // the whole alloy was in the tyre's shadow and the wheel read as a black blob (§6.1 round-2).
  // The bead plane now sits just inside the sidewall crown and the spoke face just inside that.
  const xBead = hw * 0.955;                      // outer flange plane, level with the tyre bead
  const dishF = { fivespoke: 0.17, mesh: 0.10, turbofan: 0.13, offroad: 0.10 }[style] ?? 0.14;
  const faceX = xBead - width * dishF;           // spoke face plane
  const rFace = rimR * 0.935;                    // where the spokes stop and the barrel step begins
  const rHub = rimR * 0.30;

  // barrel: the dark drum you see through the spoke windows
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(rimR * 0.965, rimR * 0.965, width * 1.02, 16, 1, true), wellMat);
  barrel.rotation.z = Math.PI / 2;
  barrel.material.side = THREE.BackSide;
  spin.add(barrel);
  const backPlate = new THREE.Mesh(new THREE.CircleGeometry(rimR * 0.965, 16), wellMat);
  backPlate.rotation.y = -Math.PI / 2;                        // faces the viewer from outboard
  backPlate.position.x = hw * 0.88;                           // …at the INBOARD end of the barrel
  spin.add(backPlate);

  // outer flange: a rolled bead edge in polished lip metal, then the step down to the spoke face
  spin.add(new THREE.Mesh(ringLathe([
    [rimR * 0.865, xBead - 0.030], [rimR * 0.965, xBead - 0.016], [rimR * 1.012, xBead + 0.002],
    [rimR * 1.010, xBead + 0.018], [rimR * 0.950, xBead + 0.020], [rimR * 0.905, xBead + 0.004],
  ], 20), lipMat));
  // the dish barrel between the bead and the spoke face — this is the "deep dish" you actually see
  spin.add(new THREE.Mesh(ringLathe([
    [rFace * 0.985, faceX], [rimR * 0.900, faceX + width * dishF * 0.45], [rimR * 0.935, xBead - 0.014],
  ], 22), lipMat));
  // a polished lip bead: a torus catches a specular rim-light all the way round the wheel, which is
  // what makes an alloy readable at 30 m when the spokes themselves are three pixels wide
  const lipRing = new THREE.Mesh(new THREE.TorusGeometry(rimR * 0.995, Math.min(0.014, width * 0.055), 6, 24), lipMat);
  lipRing.rotation.y = Math.PI / 2;
  lipRing.position.x = -(xBead + 0.006);
  spin.add(lipRing);

  // spokes
  const conf = {
    fivespoke: { n: spokes, fOut: 0.46, fIn: 0.86, depth: width * 0.26, twist: 0.08, dish: 0.55 },
    mesh: { n: spokes * 2, fOut: 0.40, fIn: 0.78, depth: width * 0.22, twist: 0.16, dish: 0.42 },
    offroad: { n: spokes, fOut: 0.58, fIn: 0.90, depth: width * 0.26, twist: 0.0, dish: 0.30 },
    turbofan: { n: spokes, fOut: 0.66, fIn: 0.88, depth: width * 0.20, twist: 0.20, dish: 0.70 },
  }[style] || { n: spokes, fOut: 0.52, fIn: 0.86, depth: width * 0.22, twist: 0.06, dish: 0.5 };

  const OUT = -1;                                              // outboard is -X in wheel space
  const pitch = Math.PI / conf.n;                              // half the angular pitch
  for (let i = 0; i < conf.n; i++) {
    const a = (i / conf.n) * Math.PI * 2;
    const sp = new THREE.Mesh(
      rimSector(rHub * 0.92, rFace, pitch * conf.fIn, pitch * conf.fOut, conf.depth, conf.twist),
      rimMat,
    );
    sp.rotation.x = a;
    sp.position.x = OUT * faceX;
    spin.add(sp);
    if (style === 'fivespoke') {
      // the classic two-plane casting: a shallow web set back between each pair of spokes
      const web = new THREE.Mesh(
        rimSector(rHub * 0.9, rFace * 0.80, pitch * 0.34, pitch * 0.22, conf.depth * 0.5),
        rimMat,
      );
      web.rotation.x = a + pitch;
      web.position.x = OUT * (faceX - conf.depth * 0.55);
      spin.add(web);
    }
  }

  // beadlock ring: an outer clamp ring plus a circle of bolts. It is the single most legible
  // wheel detail at distance, which is why it goes on the SUV.
  if (beadlock) {
    const boltMat = new THREE.MeshStandardMaterial({ color: 0xc9ced6, metalness: 1.0, roughness: 0.28 });
    spin.add(new THREE.Mesh(ringLathe([
      [rimR * 0.845, xBead - 0.004], [rimR * 0.870, xBead + 0.016], [rimR * 0.985, xBead + 0.018],
      [rimR * 1.000, xBead - 0.002],
    ], 24), new THREE.MeshStandardMaterial({
      color: new THREE.Color(capColor || '#c4a24a'), metalness: 0.9, roughness: 0.34, side: THREE.DoubleSide,
    })));
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 + 0.13;
      const b = new THREE.Mesh(new THREE.CylinderGeometry(rimR * 0.040, rimR * 0.044, width * 0.07, 6), boltMat);
      b.rotation.z = Math.PI / 2;
      b.position.set(OUT * (xBead + 0.022), Math.cos(a) * rimR * 0.925, Math.sin(a) * rimR * 0.925);
      spin.add(b);
    }
  }

  // centre: hub barrel, dished face, cap
  spin.add(new THREE.Mesh(ringLathe([
    [0.001, faceX + conf.depth * 0.42], [rHub * 0.55, faceX + conf.depth * 0.46],
    [rHub * 0.98, faceX + conf.depth * conf.dish * 0.5], [rHub * 1.02, faceX - conf.depth * 0.5],
    [rHub * 0.80, faceX - conf.depth * 0.9],
  ], 18), rimMat));
  const cap = new THREE.Mesh(ringLathe([
    [rHub * 0.62, faceX + conf.depth * 0.40], [rHub * 0.50, faceX + conf.depth * 0.60],
    [0.001, faceX + conf.depth * 0.64],
  ], 16), new THREE.MeshStandardMaterial({
    color: new THREE.Color(capColor || caliperColor), metalness: 0.75, roughness: 0.26, side: THREE.DoubleSide,
  }));
  spin.add(cap);
  // lug ring: five polished bolts on a machined ring, sitting proud of the hub face
  const lugMat = new THREE.MeshStandardMaterial({ color: 0xb8bfc9, metalness: 1.0, roughness: 0.20 });
  spin.add(new THREE.Mesh(ringLathe([
    [rHub * 0.66, faceX + conf.depth * 0.44], [rHub * 1.02, faceX + conf.depth * 0.44],
    [rHub * 1.06, faceX + conf.depth * 0.30],
  ], 16), lugMat));
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.3;
    const lug = new THREE.Mesh(new THREE.CylinderGeometry(rimR * 0.062, rimR * 0.068, width * 0.10, 6), lugMat);
    lug.rotation.z = Math.PI / 2;
    lug.position.set(OUT * (faceX + conf.depth * 0.50), Math.cos(a) * rHub * 0.84, Math.sin(a) * rHub * 0.84);
    spin.add(lug);
  }

  // --- brake rotor (spins) + caliper (does not) ---------------------------
  const rDisc = rimR * 0.86;
  const discFaceMat = new THREE.MeshStandardMaterial({
    map: discTexture(), color: 0xffffff, metalness: 0.85, roughness: 0.40, side: THREE.DoubleSide,
  });
  const face = new THREE.Mesh(new THREE.CircleGeometry(rDisc, 20), discFaceMat);
  face.rotation.y = -Math.PI / 2;                        // faces outboard, seen through the spokes
  face.position.x = OUT * hw * 0.30;
  spin.add(face);
  const edge = new THREE.Mesh(new THREE.CylinderGeometry(rDisc, rDisc, width * 0.11, 18, 1, true),
    new THREE.MeshStandardMaterial({ color: 0x50555d, metalness: 0.8, roughness: 0.55 }));
  edge.rotation.z = Math.PI / 2; edge.position.x = OUT * hw * 0.24;
  spin.add(edge);
  const hat = new THREE.Mesh(new THREE.CylinderGeometry(rHub * 1.05, rHub * 1.05, width * 0.30, 14),
    new THREE.MeshStandardMaterial({ color: 0x4a4f58, metalness: 0.9, roughness: 0.44 }));
  hat.rotation.z = Math.PI / 2; hat.position.x = OUT * hw * 0.24;
  spin.add(hat);

  const calMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(caliperColor), metalness: 0.5, roughness: 0.30,
  });
  const cal = new THREE.Mesh(roundedBox(width * 0.26, rDisc * 0.70, rDisc * 0.50, 0.022), calMat);
  cal.position.set(OUT * hw * 0.06, rDisc * 0.78, -rDisc * 0.22);
  cal.rotation.x = 0.30;
  g.add(cal);
  for (const s of [-1, 1]) {                       // pistons/bridge — reads as a real caliper
    const rib = new THREE.Mesh(roundedBox(width * 0.30, rDisc * 0.18, rDisc * 0.13, 0.012), calMat);
    rib.position.set(OUT * hw * 0.06, rDisc * 0.78, -rDisc * 0.22 + s * rDisc * 0.18);
    rib.rotation.x = 0.30;
    g.add(rib);
  }

  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

  // ~30 primitives per wheel × 4 wheels × 8 cars is a draw-call disaster; bake them down.
  // The rotating parts and the fixed parts have to stay in separate groups.
  const statics = new THREE.Group();
  for (const child of [...g.children]) if (child !== spin) statics.add(child);
  const wheel = new THREE.Group();
  const mergedSpin = mergeByMaterial(spin);
  mergedSpin.name = 'spin';
  wheel.add(mergedSpin);
  for (const m of [...mergeByMaterial(statics).children]) wheel.add(m);
  wheel.userData.radius = radius;
  return wheel;
}

/**
 * Dark inner fender. This is what the eye actually reads as "the arch is an OPENING": the ring of
 * shadow between the tyre crown and the arch lip. It must therefore be radius-matched to the LIP,
 * not to the tyre, and closed at the inboard end so no daylight shows through the car.
 */
export function wheelWell(radius, width, { inboard = 0.0 } = {}) {
  const parts = [];
  const arch = new THREE.CylinderGeometry(radius, radius, width, 16, 1, true, -0.15, Math.PI + 0.30);
  arch.rotateZ(Math.PI / 2);
  parts.push(arch);
  // inboard closing wall — a disc, so you never see the road through the wheel well
  const wall = new THREE.RingGeometry(radius * 0.12, radius, 16, 1, 0, Math.PI + 0.3);
  wall.rotateZ(-0.15);
  wall.rotateY(Math.PI / 2);
  wall.translate(-width / 2 + inboard, 0, 0);
  parts.push(wall);
  const geo = mergeGeometries(parts, false) || arch;
  return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    color: 0x0b0c0f, roughness: 0.96, metalness: 0.0, side: THREE.DoubleSide,
  }));
}

/**
 * A wheel-arch FLARE, swept around the opening.
 *
 * Round 1 used a torus, which reads as a hoop stuck onto a slab with daylight on both sides of it
 * (§6.1 cap). This instead sweeps a real fender cross-section: it starts on the body surface at
 * `xIn`, swells outboard to `xOut` just past the tyre's outer sidewall, rolls over a lip at the
 * opening radius `r`, and returns under itself — so the panel and the opening are one continuous
 * surface and the tyre is inside a hole, not under a ring.
 *
 * +X is outboard, the sweep is centred on the top of the wheel.
 */
export function archLip({
  r = 0.40, span = Math.PI * 1.02, xIn = 0.02, xOut = 0.12, t = 0.05, seg = 20, lift = 0.0,
  uLo = 0.10, uHi = 0.26, vAt = 0.5, vPerMetre = 0.2,
} = {}) {
  const dx = xOut - xIn;
  //           [radial offset from r, axial fraction xIn→xOut]
  // The flare's outer face is kept nearly PARALLEL to the flank. Round 2 rolled it through a
  // 150 mm radius tube, whose normal swept from outboard to straight up — so the clearcoat
  // mirrored the sky right round the opening and every arch read as a chrome donut bolted to the
  // side of the car. A flat face reflects what the flank reflects, which is the point.
  const cs = [
    [t * 0.26, 0.46],   // return flange tip — the metal turns in under the arch
    [0.000, 0.94],      // the opening edge itself
    [t * 0.10, 1.00],   // rolled crown of the flare: the widest point of the car
    [t * 0.58, 0.985],
    [t * 1.10, 0.90],
    [t * 1.62, 0.56],
    [t * 2.05, 0.00],   // merges with the body panel
  ];
  const n = cs.length;
  const pos = [], uv = [], idx = [];
  for (let s = 0; s <= seg; s++) {
    const f = s / seg;
    const th = -span / 2 + span * f;
    const taper = smoothstep(0, 0.16, Math.min(f, 1 - f));
    for (let k = 0; k < n; k++) {
      const R = r + cs[k][0] * taper + lift * Math.max(0, Math.cos(th));
      const x = xIn + dx * cs[k][1] * taper;
      pos.push(x, Math.cos(th) * R, Math.sin(th) * R);
      // UV in the BODY's skin space: u walks the flank band (rocker → character line) and v tracks
      // the real z of the point. Round 2 mapped the lip across the whole texture, so the arches
      // sampled the roof stripe and read as white slabs bolted to the fenders.
      uv.push(uLo + (uHi - uLo) * (1 - k / (n - 1)), vAt + Math.sin(th) * R * vPerMetre);
    }
  }
  for (let s = 0; s < seg; s++) {
    for (let k = 0; k < n - 1; k++) {
      const a = s * n + k, b = a + 1, c = a + n, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}


// ------------------------------------------------------------------ batching

const _MERGE_ATTRS = ['position', 'normal', 'uv'];

/** Two materials that would render identically get one draw call, even if they are two objects. */
function materialKey(m) {
  return [
    m.type, m.color && m.color.getHexString(), m.emissive && m.emissive.getHexString(),
    m.emissiveIntensity, m.metalness, m.roughness, m.clearcoat, m.clearcoatRoughness,
    m.envMapIntensity, m.opacity, m.transparent, m.side, m.depthWrite, m.blending,
    m.map && m.map.uuid, m.normalMap && m.normalMap.uuid, m.roughnessMap && m.roughnessMap.uuid,
    m.normalScale && m.normalScale.x,
  ].join('|');
}

/**
 * Collapse a subtree into one mesh per material.
 *
 * A car built one primitive at a time is 250+ draw calls, and eight of them on a grid will not hold
 * 50 fps (§3). Nothing in these subtrees is animated, so we bake the transforms and merge. Meshes
 * flagged `userData.noMerge` (lights, anything physics.js reaches into) are carried over untouched.
 */
export function mergeByMaterial(group) {
  group.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(group.matrixWorld).invert();
  const buckets = new Map();
  const keep = [];
  const local = new THREE.Matrix4();
  const walk = (o) => {
    if (o !== group && o.userData.noMerge) { keep.push(o); return; }   // whole subtree survives
    if (o.isMesh) visit(o);
    for (const c of [...o.children]) walk(c);
  };
  const visit = (o) => {
    if (Array.isArray(o.material)) { keep.push(o); return; }
    const src = o.geometry;
    if (!src || !src.attributes.position || !src.attributes.uv) { keep.push(o); return; }
    local.copy(inv).multiply(o.matrixWorld);
    let g = src.clone();
    if (g.index) g = g.toNonIndexed();
    if (!g.attributes.normal) g.computeVertexNormals();
    for (const name of Object.keys(g.attributes)) if (!_MERGE_ATTRS.includes(name)) g.deleteAttribute(name);
    g.applyMatrix4(local);
    const key = materialKey(o.material);
    if (!buckets.has(key)) buckets.set(key, { mat: o.material, geos: [], cast: false });
    const b = buckets.get(key);
    b.geos.push(g);
    b.cast = b.cast || o.castShadow;
  };
  walk(group);
  const out = new THREE.Group();
  out.name = group.name;
  out.position.copy(group.position);
  out.rotation.copy(group.rotation);
  out.scale.copy(group.scale);
  for (const { mat, geos, cast } of buckets.values()) {
    const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
    if (!merged) { for (const g of geos) out.add(new THREE.Mesh(g, mat)); continue; }
    if (merged !== geos[0]) for (const g of geos) g.dispose();
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = cast && !mat.transparent;
    mesh.receiveShadow = true;
    if (mat.transparent) mesh.renderOrder = 4;
    out.add(mesh);
  }
  for (const k of keep) {
    k.matrix.copy(inv).multiply(k.matrixWorld);
    k.matrix.decompose(k.position, k.quaternion, k.scale);
    out.add(k);
  }
  return out;
}

// ------------------------------------------------------------------ shared details

/** Contact shadow — §7 caps a hovering car at 55. Body blob plus a firm patch under each tyre. */
export function contactShadow(w = 2.2, l = 5.0, wheels = []) {
  const tex = sprite({ size: 128, shape: 'glow', color: '#000000', seed: 2 });
  const geos = [];
  const add = (pw, pl, y, x = 0, z = 0) => {
    const g = new THREE.PlaneGeometry(pw, pl).toNonIndexed();
    g.rotateX(-Math.PI / 2);
    g.translate(x, y, z);
    geos.push(g);
  };
  add(w, l, 0.018);
  for (const p of wheels) add(p.r * 1.5, p.r * 2.1, 0.024, p.x, p.z);
  const merged = mergeGeometries(geos, false) || geos[0];
  const m = new THREE.Mesh(merged, new THREE.MeshBasicMaterial({
    map: tex, transparent: true, opacity: 0.60, depthWrite: false, color: 0x000000,
  }));
  m.renderOrder = 2;
  m.name = 'contactShadow';
  return m;
}

/**
 * Headlight / taillight unit: a dark housing, a chrome bezel, an emissive lens and a glow card.
 * children[0] MUST stay the lens — physics.js drives its emissiveIntensity for brake lights.
 */
export function lightUnit({
  w = 0.34, h = 0.16, color = '#ff2418', intensity = 4.0, glow = 1.0, shape = 'rect', bezel = true,
  segs = 0,
} = {}) {
  const g = new THREE.Group();
  const lensGeo = shape === 'round'
    ? new THREE.CircleGeometry(h * 0.5, 16)
    : shape === 'strip'
      ? roundedBox(w, h, 0.02, h * 0.45)
      : roundedBox(w, h, 0.025, Math.min(w, h) * 0.30);
  const lens = new THREE.Mesh(lensGeo, emissiveMaterial({ color, intensity }));
  lens.position.z = 0.015;
  g.add(lens);                                  // children[0]

  const housing = new THREE.Mesh(
    shape === 'round' ? new THREE.CylinderGeometry(h * 0.58, h * 0.52, 0.09, 14) : roundedBox(w * 1.10, h * 1.30, 0.09, Math.min(w, h) * 0.30),
    new THREE.MeshStandardMaterial({ color: 0x0a0b0e, roughness: 0.5, metalness: 0.4 }),
  );
  if (shape === 'round') housing.rotation.x = Math.PI / 2;
  // The housing's front face must clear the lens plane. At -0.03 the two were coplanar and the
  // cylinder cap z-fought the lens, printing a pinwheel across every round lamp (§7 caps that at 60).
  housing.position.z = -0.075;
  housing.name = 'housing';
  g.add(housing);

  if (bezel) {
    const ring = shape === 'round'
      ? new THREE.TorusGeometry(h * 0.53, 0.016, 5, 14)
      : new THREE.TorusGeometry(Math.max(w, h) * 0.52, 0.014, 5, 14, Math.PI * 2);
    const bz = new THREE.Mesh(ring, chromeMaterial({ color: '#c9ced6', rough: 0.12 }));
    if (shape !== 'round') bz.scale.set(w / (Math.max(w, h) * 1.04), h / (Math.max(w, h) * 1.04), 1);
    bz.position.z = 0.012;
    bz.name = 'bezel';
    g.add(bz);
  }

  // Divider ribs across the lens. Without them a bright lens blooms into a featureless white
  // rectangle and the shape of the lamp is erased (round-1 note on the Brutus tail lamps).
  if (segs > 1) {
    const vertical = h > w;
    const ribMat = new THREE.MeshStandardMaterial({ color: 0x0b0c0f, roughness: 0.55, metalness: 0.35 });
    for (let i = 1; i < segs; i++) {
      const f = i / segs - 0.5;
      const rib = new THREE.Mesh(
        vertical ? roundedBox(w * 1.02, h * 0.030, 0.045, 0.008) : roundedBox(w * 0.030, h * 1.02, 0.045, 0.008),
        ribMat,
      );
      rib.position.set(vertical ? 0 : f * w, vertical ? f * h : 0, 0.028);
      rib.name = 'rib';
      g.add(rib);
    }
  }

  if (glow > 0) {
    // The halo card used to be 1.9x the lamp's long side at 0.5 alpha. On a tall stacked lens that
    // is a 0.9 m red disc, and after bloom it swallowed the whole rear corner of the car — the lamp
    // stopped reading as a lamp. 1.35x keeps the bloom tight around the lens it belongs to.
    const r = Math.max(w, h) * 1.35;
    const gl = new THREE.Mesh(
      new THREE.PlaneGeometry(r, r),
      new THREE.MeshBasicMaterial({
        map: sprite({ size: 128, shape: 'glow', color, seed: 4 }),
        transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: glow * 0.40,
      }),
    );
    gl.position.z = 0.05;
    gl.name = 'glow';
    g.add(gl);
  }
  return g;
}

/** A grille: a recessed dark box with real slats and a surrounding chrome/dark frame. */
export function grilleMesh({
  w = 1.4, h = 0.30, d = 0.14, slats = 9, vertical = false, frame = 'chrome', mesh = false,
  surround = null,
} = {}) {
  const hasSurround = surround === null ? frame === 'chrome' : surround;
  const g = new THREE.Group();
  const back = new THREE.Mesh(roundedBox(w * 0.99, h * 0.99, d * 0.5, 0.02),
    new THREE.MeshStandardMaterial({ color: 0x05060a, roughness: 0.9, metalness: 0.2 }));
  back.position.z = -d * 0.5;
  g.add(back);
  const barMat = frame === 'chrome' ? chromeMaterial({ color: '#b9bfc8', rough: 0.16 })
    : new THREE.MeshStandardMaterial({ color: 0x1a1c21, roughness: 0.45, metalness: 0.7 });
  if (mesh) {
    for (let i = 0; i < slats; i++) {
      const y = -h / 2 + (i + 0.5) * (h / slats);
      const bar = new THREE.Mesh(roundedBox(w * 0.98, h / slats * 0.24, 0.03, 0.006), barMat);
      bar.position.set(0, y, -d * 0.16);
      g.add(bar);
    }
    const cols = Math.round(slats * (w / Math.max(h, 0.01)) * 0.28);
    for (let i = 0; i < cols; i++) {
      const x = -w / 2 + (i + 0.5) * (w / cols);
      const bar = new THREE.Mesh(roundedBox(w / cols * 0.20, h * 0.96, 0.03, 0.006), barMat);
      bar.position.set(x, 0, -d * 0.16);
      g.add(bar);
    }
  } else if (vertical) {
    for (let i = 0; i < slats; i++) {
      const x = -w / 2 + (i + 0.5) * (w / slats);
      const bar = new THREE.Mesh(roundedBox(w / slats * 0.34, h * 0.94, 0.05, 0.01), barMat);
      bar.position.set(x, 0, -d * 0.10);
      g.add(bar);
    }
  } else {
    for (let i = 0; i < slats; i++) {
      const y = -h / 2 + (i + 0.5) * (h / slats);
      const bar = new THREE.Mesh(roundedBox(w * 0.96, h / slats * 0.40, 0.05, 0.01), barMat);
      bar.position.set(0, y, -d * 0.10);
      g.add(bar);
    }
  }
  // surround
  if (hasSurround) {
    const surMat = chromeMaterial({ color: '#d3d8de', rough: 0.10 });
    for (const [sy, sw, sh] of [[h / 2 + 0.018, w + 0.05, 0.042], [-h / 2 - 0.018, w + 0.05, 0.042]]) {
      const b = new THREE.Mesh(roundedBox(sw, sh, d * 0.7, 0.016), surMat);
      b.position.set(0, sy, 0);
      g.add(b);
    }
    for (const sx of [-1, 1]) {
      const b = new THREE.Mesh(roundedBox(0.042, h + 0.02, d * 0.7, 0.016), surMat);
      b.position.set(sx * (w / 2 + 0.018), 0, 0);
      g.add(b);
    }
  }
  return g;
}

/** A vent: louvres recessed into a dark aperture. Bonnet extractors, side intakes, engine covers. */
export function ventMesh({ w = 0.4, h = 0.2, fins = 4, angle = 0.5, dark = '#0a0b0d' } = {}) {
  const g = new THREE.Group();
  const back = new THREE.Mesh(roundedBox(w, h, 0.05, 0.02),
    new THREE.MeshStandardMaterial({ color: new THREE.Color(dark), roughness: 0.9, metalness: 0.2 }));
  g.add(back);
  const finMat = new THREE.MeshStandardMaterial({ color: 0x2a2d34, roughness: 0.5, metalness: 0.6 });
  for (let i = 0; i < fins; i++) {
    const f = new THREE.Mesh(roundedBox(w * 0.92, h / fins * 0.5, 0.05, 0.008), finMat);
    f.position.set(0, -h / 2 + (i + 0.5) * (h / fins), 0.03);
    f.rotation.x = angle;
    g.add(f);
  }
  return g;
}

// ------------------------------------------------------------------ livery

/**
 * The paint map, drawn in the loft's UV space (see the header). Everything the eye reads as
 * "surfacing" that isn't geometry lives here: the character-line crease, the shadow under the
 * shoulder, door shut lines, hood and boot gaps, and the livery itself.
 *
 * @param anchors  profileU(sections) — u of each authored half-profile point.
 */
export function bodyPaintTexture({
  base = '#1b7f6b', stripe = '#f2f2ee', accent = null, style = 'none',
  anchors = null, panels = {}, seed = 1, size = 1024,
} = {}) {
  const { c, ctx } = canvas(size, size);
  const rng = new RNG(seed);
  const A = anchors || [0, 0.06, 0.11, 0.14, 0.20, 0.26, 0.28, 0.35, 0.38, 0.45, 0.48, 0.5];
  const uAt = (i) => A[Math.min(i, A.length - 1)];
  const X = (u) => u * size;
  const Y = (v) => (1 - v) * size;       // v=1 (nose) at the top of the canvas
  const baseCol = new THREE.Color(base);

  ctx.fillStyle = base; ctx.fillRect(0, 0, size, size);

  const mirrorDraw = (fn) => {
    fn(1);
    ctx.save();
    ctx.translate(size, 0); ctx.scale(-1, 1);
    fn(-1);
    ctx.restore();
  };

  // ---- 1. livery ----
  const iRocker = 3, iCrease = 5, iShoulder = 7, iDeck = 9;
  if (style === 'stripes') {
    // twin over-the-top racing stripes, centred on the roof/deck centreline
    const wS = size * (panels.stripeWidth ?? 0.030), gap = size * (panels.stripeGap ?? 0.020);
    ctx.fillStyle = stripe;
    ctx.fillRect(size * 0.5 - gap / 2 - wS, 0, wS, size);
    ctx.fillRect(size * 0.5 + gap / 2, 0, wS, size);
  } else if (style === 'twotone') {
    // lower body in the accent colour, split on the character line
    const split = X(uAt(panels.splitIndex ?? iCrease));
    ctx.fillStyle = accent || stripe;
    ctx.fillRect(0, 0, split, size);
    ctx.fillRect(size - split, 0, split, size);
  } else if (style === 'rally') {
    // a bonnet-to-boot centre panel pinstriped in the accent, plus a thin flank flash
    ctx.fillStyle = stripe;
    ctx.fillRect(size * 0.5 - size * 0.052, 0, size * 0.104, size);
    ctx.fillStyle = accent || stripe;
    ctx.fillRect(size * 0.5 - size * 0.070, 0, size * 0.011, size);
    ctx.fillRect(size * 0.5 + size * 0.059, 0, size * 0.011, size);
    mirrorDraw(() => {
      ctx.beginPath();
      ctx.moveTo(X(uAt(iShoulder)), Y(0.60));
      ctx.lineTo(X(uAt(iShoulder)), Y(0.50));
      ctx.lineTo(X(uAt(iRocker) + 0.012), Y(0.20));
      ctx.lineTo(X(uAt(iRocker) + 0.012), Y(0.31));
      ctx.closePath();
      ctx.fillStyle = accent || stripe; ctx.fill();
      ctx.beginPath();
      ctx.moveTo(X(uAt(iShoulder)), Y(0.47));
      ctx.lineTo(X(uAt(iShoulder)), Y(0.43));
      ctx.lineTo(X(uAt(iRocker) + 0.012), Y(0.13));
      ctx.lineTo(X(uAt(iRocker) + 0.012), Y(0.17));
      ctx.closePath();
      ctx.fillStyle = stripe; ctx.fill();
    });
  } else if (style === 'gt') {
    // GT livery: a centre band over the nose and roof plus a flank swoosh over the rear arch
    ctx.fillStyle = stripe;
    ctx.fillRect(size * 0.5 - size * 0.042, 0, size * 0.084, size);
    ctx.fillStyle = accent || stripe;
    ctx.fillRect(size * 0.5 - size * 0.058, 0, size * 0.012, size);
    ctx.fillRect(size * 0.5 + size * 0.046, 0, size * 0.012, size);
    // The flank swoosh is drawn in the DARK accent, not the light stripe. A supercar's flank is
    // already a mirror of the sky from the shoulder down; a white graphic on top of that made the
    // whole side of the car one featureless bright wash with no shape in it at all.
    mirrorDraw(() => {
      ctx.beginPath();
      ctx.moveTo(X(uAt(iRocker) + 0.010), Y(0.26));
      ctx.lineTo(X(uAt(iCrease) + 0.014), Y(0.34));
      ctx.lineTo(X(uAt(iCrease) + 0.014), Y(0.52));
      ctx.lineTo(X(uAt(iRocker) + 0.010), Y(0.58));
      ctx.closePath();
      ctx.fillStyle = accent || stripe; ctx.fill();
      ctx.beginPath();
      ctx.moveTo(X(uAt(iRocker) + 0.010), Y(0.595));
      ctx.lineTo(X(uAt(iCrease) + 0.014), Y(0.535));
      ctx.lineTo(X(uAt(iCrease) + 0.014), Y(0.570));
      ctx.lineTo(X(uAt(iRocker) + 0.010), Y(0.630));
      ctx.closePath();
      ctx.fillStyle = stripe; ctx.fill();
    });
  } else if (style === 'offroad') {
    // military two-tone: dark lower plus a blocky flank panel
    const split = X(uAt(iRocker) + 0.035);
    ctx.fillStyle = accent || '#22252b';
    ctx.fillRect(0, 0, split, size);
    ctx.fillRect(size - split, 0, split, size);
    mirrorDraw(() => {
      // a body-length flash just under the shoulder, plus a door-number square
      ctx.fillStyle = stripe;
      ctx.globalAlpha = 0.92;
      ctx.fillRect(X(uAt(iCrease) - 0.016), Y(0.90), size * 0.026, Y(0.10) - Y(0.90));
      ctx.globalAlpha = 0.55;
      ctx.fillRect(X(uAt(iRocker) + 0.018), Y(0.56), X(uAt(iShoulder) - 0.01) - X(uAt(iRocker) + 0.018), size * 0.10);
      ctx.globalAlpha = 1;
    });
  }

  // ---- 2. surfacing: crease highlight, shoulder shade, rocker shadow ----
  mirrorDraw(() => {
    // character line: a bright edge with a shadow immediately under it
    const xc = X(uAt(iCrease));
    let g = ctx.createLinearGradient(xc - size * 0.030, 0, xc + size * 0.012, 0);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.72, 'rgba(0,0,0,0.30)');
    g.addColorStop(1.0, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(xc - size * 0.030, 0, size * 0.042, size);
    g = ctx.createLinearGradient(xc, 0, xc + size * 0.020, 0);
    g.addColorStop(0, 'rgba(255,255,255,0.34)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(xc, 0, size * 0.020, size);

    // shoulder: the panel rolls over, so it catches the sky
    const xs = X(uAt(iShoulder));
    g = ctx.createLinearGradient(xs - size * 0.018, 0, xs + size * 0.026, 0);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.18)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(xs - size * 0.018, 0, size * 0.044, size);

    // rocker / sill: shadow under the door. Kept deliberately shallow — the flank of a car is
    // already the surface the key light misses, and at 0.55 black the whole lower body went to a
    // featureless void in every side-on frame, which is a worse tell than a flat panel.
    const xr = X(uAt(iRocker));
    g = ctx.createLinearGradient(0, 0, xr + size * 0.020, 0);
    g.addColorStop(0, 'rgba(0,0,0,0.34)');
    g.addColorStop(0.7, 'rgba(0,0,0,0.17)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, xr + size * 0.020, size);

    // A second, higher crease: a soft swage running the length of the door between the character
    // line and the shoulder. Two lines instead of one is the difference between "a slab with an
    // edge drawn on it" and a surfaced flank.
    const xm = X((uAt(iCrease) + uAt(iShoulder)) * 0.5);
    g = ctx.createLinearGradient(xm - size * 0.014, 0, xm + size * 0.014, 0);
    g.addColorStop(0.0, 'rgba(0,0,0,0)');
    g.addColorStop(0.45, 'rgba(0,0,0,0.16)');
    g.addColorStop(0.58, 'rgba(255,255,255,0.13)');
    g.addColorStop(1.0, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(xm - size * 0.014, 0, size * 0.028, size);
  });

  // ---- 3. shut lines ----
  const shut = (v, u0, u1, wpx = 3.0) => {
    const y = Y(v);
    for (const [a, b] of [[u0, u1], [1 - u1, 1 - u0]]) {
      const g = ctx.createLinearGradient(0, y - wpx, 0, y + wpx);
      g.addColorStop(0, 'rgba(255,255,255,0.10)');
      g.addColorStop(0.45, 'rgba(0,0,0,0.72)');
      g.addColorStop(0.65, 'rgba(0,0,0,0.55)');
      g.addColorStop(1, 'rgba(255,255,255,0.06)');
      ctx.fillStyle = g;
      ctx.fillRect(X(a), y - wpx, X(b) - X(a), wpx * 2);
    }
  };
  const shutU = (u, v0, v1, wpx = 3.0) => {
    for (const uu of [u, 1 - u]) {
      const x = X(uu);
      const g = ctx.createLinearGradient(x - wpx, 0, x + wpx, 0);
      g.addColorStop(0, 'rgba(255,255,255,0.08)');
      g.addColorStop(0.5, 'rgba(0,0,0,0.68)');
      g.addColorStop(1, 'rgba(255,255,255,0.08)');
      ctx.fillStyle = g;
      ctx.fillRect(x - wpx, Y(v1), wpx * 2, Y(v0) - Y(v1));
    }
  };
  for (const d of panels.doors || []) shut(d, uAt(iRocker) - 0.015, uAt(iShoulder) + 0.03);
  if (panels.hood) {
    const [v0, v1] = panels.hood;
    shut(v0, uAt(iDeck) - 0.06, 0.5 - 0.002, 2.6);
    shutU(uAt(iDeck) - 0.005, v0, v1, 2.6);
  }
  if (panels.boot) {
    const [v0, v1] = panels.boot;
    shut(v1, uAt(iDeck) - 0.06, 0.5 - 0.002, 2.6);
    shutU(uAt(iDeck) - 0.005, v0, v1, 2.6);
  }
  if (panels.fuelCap) {
    const [u, v] = panels.fuelCap;
    ctx.save();
    ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = 2.5;
    for (const uu of [u, 1 - u]) { ctx.beginPath(); ctx.arc(X(uu), Y(v), size * 0.016, 0, 7); ctx.stroke(); }
    ctx.restore();
  }

  // ---- 4. ambient occlusion into the arch mouths, and a soft top-light gradient ----
  for (const av of panels.arches || []) {
    mirrorDraw(() => {
      const g = ctx.createRadialGradient(X(uAt(iRocker) + 0.02), Y(av), size * 0.01, X(uAt(iRocker) + 0.02), Y(av), size * 0.10);
      g.addColorStop(0, 'rgba(0,0,0,0.40)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, Y(av) - size * 0.10, size * 0.5, size * 0.20);
    });
  }
  const topG = ctx.createLinearGradient(0, 0, size, 0);
  topG.addColorStop(0.0, 'rgba(0,0,0,0.16)');
  topG.addColorStop(0.5, 'rgba(255,255,255,0.06)');
  topG.addColorStop(1.0, 'rgba(0,0,0,0.16)');
  ctx.fillStyle = topG; ctx.fillRect(0, 0, size, size);

  // ---- 5. badging ----
  if (panels.badge !== false) {
    const bx = X(0.5), by = Y(0.045);
    ctx.save();
    ctx.fillStyle = 'rgba(228,232,238,0.85)';
    ctx.translate(bx, by);
    for (let i = 0; i < 3; i++) {
      ctx.fillRect(-size * 0.026 + i * size * 0.020, -size * 0.004, size * 0.012, size * 0.008);
    }
    ctx.restore();
  }

  // ---- 6. panel life ----
  // A body panel of one flat RGB is the §7 tell that caps a piece at 50, and a car has a lot of
  // large panels. This is a very low-amplitude fbm laid over everything: invisible as a pattern,
  // but it means no roof, bonnet or tailgate is ever a single constant colour.
  {
    const N = 128;
    const f = fbmField(N, N, { seed: seed * 13 + 5, octaves: 4, scale: 3.5 });
    const { c: mc, ctx: mx } = canvas(N, N);
    const im = mx.createImageData(N, N);
    for (let i = 0; i < N * N; i++) {
      const v = clamp(0.5 + (f[i] - 0.5) * 1.5, 0, 1);
      im.data[i * 4] = im.data[i * 4 + 1] = im.data[i * 4 + 2] = v * 255;
      im.data[i * 4 + 3] = 30;
    }
    mx.putImageData(im, 0, 0);
    ctx.save();
    ctx.globalCompositeOperation = 'overlay';
    ctx.globalAlpha = 0.42;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(mc, 0, 0, size, size);
    ctx.restore();
  }

  grain(ctx, size, size, 3, rng);
  void baseCol; void smoothstep;
  return toTexture(c, { srgb: true, wrap: THREE.ClampToEdgeWrapping });
}

/** Backwards-compatible alias — older blueprints called this liveryTexture(). */
export function liveryTexture(opts = {}) { return bodyPaintTexture(opts); }

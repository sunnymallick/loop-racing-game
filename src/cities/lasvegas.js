import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  buildCity, marqueeArch, landmarkTower,
  jerseyBarrier, waterBarrier, trafficCones,
} from './kit.js';
import { Track } from './track.js';
import { RNG, clamp, lerp } from '../core/rng.js';
import { canvas, toTexture, grain } from '../core/textures.js';
import { drawText } from '../core/font.js';

/**
 * LAS VEGAS — midnight on the Strip.
 *
 * The rule this whole file obeys: **the only light in the world comes from signage.** The key
 * light is almost off, the sky is black desert with a bruise of city-glow on the horizon, and
 * every lumen in frame is an emissive surface — a sign face, a neon tube, a bulb chase, a lit
 * window, a beam — plus what the wet asphalt gives back.
 *
 * Palette, held to exactly three hues over near-black violet:
 *
 *     MAGENTA #ff2fd0   GOLD #ffc21e   CYAN #2fe0ff
 *
 * Nothing in this city is green, red, or white-neutral. That is the identity test in §6.4:
 * swap this palette into LA/Miami/NYC and it would look absurd, which is the point.
 *
 * The route is one long dead-straight boulevard (THE STRIP) followed by a fast constant-radius
 * sweeper, a back straight with a chicane, and a tight west-end hairpin — so the corner menu is
 * straight / long sweeper / flick-flack / hairpin rather than four of the same bend.
 *
 * The hero landmarks are sited off the Strip's own axis, computed at load from the spline (see
 * `site()`), so they stack down the corridor in depth order:
 *
 *     NY-NY replica skyline (215 m) → dancing fountains (150 m, right)
 *     → Eiffel replica (500 m, left) → WELCOME marquee arch over the road (545 m)
 *     → observation tower (640 m, right) → GLASS PYRAMID + sky beam (780 m, left)
 *
 * `landmarkSet: null` hands landmark duty to this file instead of the kit's shared vegas set,
 * because the framing above only works if one place owns all of it.
 */

// ---------------------------------------------------------------- palette

const MAGENTA = '#ff2fd0';
const GOLD = '#ffc21e';
const CYAN = '#2fe0ff';
const HUES = [MAGENTA, GOLD, CYAN];
const INK = '#150a26';               // the violet "black" everything sits on

// ---------------------------------------------------------------- tiny local kit

/** Per-build material cache; rebuilt on every build() so a city swap disposes cleanly. */
let CACHE = new Map();
/** Per-build animation callbacks, drained by the wrapped city.update(). */
let ANIMS = [];

function mat(key, make) {
  let v = CACHE.get(key);
  if (!v) { v = make(); CACHE.set(key, v); }
  return v;
}

function prep(src, tint = null) {
  const g = src.index ? src.toNonIndexed() : src.clone();
  for (const k of Object.keys(g.attributes)) {
    if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
  }
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.attributes.uv) {
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  }
  if (tint) {
    // RGBA, four components on purpose. three multiplies a 4-component vertex colour into
    // `diffuseColor` whole — `.rgb` against material.color and `.a` against material.opacity —
    // at the very top of the fragment shader, so a batched mesh reaches fog, tone mapping and
    // the blend equation carrying byte-identical values to the per-hue material it replaced.
    // Folding the opacity into the colour instead would be a different picture the moment fog
    // is on: fog mixes toward the fog colour BEFORE alpha is applied.
    //
    // The components are LINEAR: THREE.Color has already decoded the sRGB string, and a vertex
    // colour is consumed in the renderer's working space with no further conversion.
    const n = g.attributes.position.count;
    const a = new Float32Array(n * 4);
    const { c, a: alpha } = tint;
    for (let i = 0; i < n; i++) {
      a[i * 4] = c.r; a[i * 4 + 1] = c.g; a[i * 4 + 2] = c.b; a[i * 4 + 3] = alpha;
    }
    g.setAttribute('color', new THREE.BufferAttribute(a, 4));
  }
  g.morphAttributes = {};
  g.clearGroups();
  return g;
}

/** Collects geometry for one material into a single mesh — a 300-bulb sign is one draw call. */
class B {
  constructor(material, { cast = false, receive = false } = {}) {
    this.material = material; this.cast = cast; this.receive = receive; this.geos = [];
    /** Bulb-chase phase, baked into the u of everything this batch collects (see chaseBatch). */
    this.uPhase = 0;
  }
  _push(g) {
    if (this.uPhase) {
      const uv = g.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) + this.uPhase);
      uv.needsUpdate = true;
    }
    this.geos.push(g);
    return this;
  }
  add(geo, x = 0, y = 0, z = 0, ry = 0, o = {}) {
    const g = prep(geo, o.tint);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(o.rx || 0, ry, o.rz || 0));
    g.applyMatrix4(new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z), q, new THREE.Vector3(o.sx ?? 1, o.sy ?? 1, o.sz ?? 1),
    ));
    return this._push(g);
  }
  /** add() with an explicit matrix, for anything aimed along an arbitrary axis. */
  addM(geo, m, tint = null) {
    const g = prep(geo, tint);
    g.applyMatrix4(m);
    return this._push(g);
  }
  into(parent) {
    if (!this.geos.length) return null;
    const geo = this.geos.length === 1 ? this.geos[0] : mergeGeometries(this.geos, false);
    const m = new THREE.Mesh(geo, this.material);
    m.castShadow = this.cast; m.receiveShadow = this.receive;
    parent.add(m);
    return m;
  }
}

// ---------------------------------------------------------------- material families
//
// Two meshes can only be drawn in ONE call if they share a material INSTANCE, and round 2 handed
// out a separate one per hue, per halo opacity, per bulb-chase phase and per sign face: 172
// materials across 571 landmark meshes, which is 172 x (however many chunks they span) draw calls
// no amount of merging can collapse.
//
// A "family" is one material whose per-object colour and opacity live in an RGBA vertex-colour
// attribute instead of in `material.color` / `material.opacity`. That is an exact identity rather
// than an approximation, because three applies both at the very top of the fragment shader:
//
//   diffuseColor = vec4( diffuse, opacity );   diffuseColor *= vColor;
//
// so a white material with vColor = (tint, k) hands fog, tone mapping and the blend equation the
// same numbers a dedicated `color: tint, opacity: k` material would have. (Folding k into the
// colour instead is NOT the same picture: fog mixes toward the fog colour before alpha applies,
// which multiplies the fog term by 1/k.)
//
// Materials are still created per hue exactly as before and still carry the right colour, so a
// mesh the collapse pass never reaches (anything `noMerge`) renders identically on its own. The
// tag is only an instruction to `vcCollapse()`, which runs once at the end of landmarks().
const VC_STEEL = 'steel', VC_TUBE = 'tube', VC_SOFT = 'soft', VC_CHASE = 'chase';

const vcTint = (color, alpha = 1) => ({ c: new THREE.Color(color), a: alpha });

function vcTag(m, family, color, alpha = 1) {
  m.userData.vc = { family, tint: vcTint(color, alpha) };
  return m;
}

function vcFamilyMaterial(family) {
  return mat(`vc|${family}`, () => {
    if (family === VC_STEEL) {
      return new THREE.MeshStandardMaterial({
        vertexColors: true, metalness: 0.75, roughness: 0.45, envMapIntensity: 1.2,
      });
    }
    if (family === VC_TUBE) return new THREE.MeshBasicMaterial({ vertexColors: true });
    if (family === VC_SOFT) {
      return new THREE.MeshBasicMaterial({
        map: softTexture(), vertexColors: true, transparent: true, opacity: 1,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: true,
      });
    }
    return new THREE.MeshBasicMaterial({
      map: chaseTexture(), vertexColors: true, transparent: true, opacity: 1,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
  });
}

/**
 * The one pass that turns "a material per hue" into "a material per family". Every mesh whose
 * material carries a `vc` tag is lifted out of the graph, its tint baked into a vertex-colour
 * attribute, and the lot merged into one mesh per (family, ~240 m cell, shadow flags) — so the
 * sixty-eight pylons down the Strip submit four buffers per cell instead of six hundred meshes.
 *
 * The results are flagged `noMerge` because the kit's own chunk merge normalises geometry down to
 * position/normal/uv and would throw the colours away. Cells keep frustum culling meaningful.
 */
function vcCollapse(out, chunk = 240) {
  const doomed = [];
  for (const root of out) {
    if (!root || !root.isObject3D) continue;
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      if (!o.isMesh || o.isInstancedMesh || o.userData.noMerge) return;
      if (o.material && !Array.isArray(o.material) && o.material.userData.vc) doomed.push(o);
    });
  }
  if (!doomed.length) return;
  const buckets = new Map();
  const p = new THREE.Vector3();
  for (const o of doomed) {
    const vc = o.material.userData.vc;
    p.setFromMatrixPosition(o.matrixWorld);
    const key = `${vc.family}|${o.castShadow ? 1 : 0}${o.receiveShadow ? 1 : 0}`
      + `|${Math.floor(p.x / chunk)}|${Math.floor(p.z / chunk)}`;
    let b = buckets.get(key);
    if (!b) {
      b = new B(vcFamilyMaterial(vc.family), { cast: o.castShadow, receive: o.receiveShadow });
      buckets.set(key, b);
    }
    b.addM(o.geometry, o.matrixWorld, vc.tint);
    o.removeFromParent();
  }
  // some of the doomed were top-level entries in `out` (the shortcut light pools, the alley
  // coves); drop those or they would be re-added to the scene as empty husks.
  const gone = new Set(doomed);
  for (let i = out.length - 1; i >= 0; i--) if (gone.has(out[i])) out.splice(i, 1);
  const holder = new THREE.Group();
  for (const b of buckets.values()) {
    const m = b.into(holder);
    if (!m) continue;
    m.userData.noMerge = true;
    out.push(m);
  }
}

const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const cyl = (r0, r1, h, n = 8, open = false) => new THREE.CylinderGeometry(r0, r1, h, n, 1, open);

/** A neon tube: unlit, saturated, always over the bloom threshold. */
function tube(color) {
  return mat(`tube|${color}`, () => vcTag(
    new THREE.MeshBasicMaterial({ color: new THREE.Color(color) }), VC_TUBE, color,
  ));
}
/** Shared soft radial falloff — the alpha every glow, halo and light pool in this city uses. */
function softTexture() {
  return mat('soft', () => {
    const { c, ctx } = canvas(128, 128);
    const gr = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, 'rgba(255,255,255,0.9)');
    gr.addColorStop(0.22, 'rgba(255,255,255,0.42)');
    gr.addColorStop(0.55, 'rgba(255,255,255,0.13)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gr; ctx.fillRect(0, 0, 128, 128);
    const t = toTexture(c, { srgb: true, wrap: THREE.ClampToEdgeWrapping });
    t.generateMipmaps = false; t.minFilter = THREE.LinearFilter; t.needsUpdate = true;
    return t;
  });
}

/** The soft additive halo that hangs in the air in front of a tube. */
function halo(color, opacity = 0.20) {
  return mat(`halo|${color}|${opacity}`, () => vcTag(new THREE.MeshBasicMaterial({
    map: softTexture(), color: new THREE.Color(color), transparent: true, opacity,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: true,
  }), VC_SOFT, color, opacity));
}
/**
 * The pool of light a sign throws on the pavement, as an additive decal rather than a real
 * light. Forty kerbside PointLights would put forty lights in every shader in the scene; this
 * costs one shared material and reads the same at night, which is the whole trick a night city
 * runs on.
 */
function spillMaterial(color) {
  return mat(`spill|${color}`, () => vcTag(new THREE.MeshBasicMaterial({
    map: softTexture(), color: new THREE.Color(color), transparent: true, opacity: 0.85,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: true,
  }), VC_SOFT, color, 0.85));
}

/**
 * A ground spill ellipse under a sign, elongated toward the road. Local +Z on every kerbside
 * prop points BACK at the carriageway (rotation.y = trackYaw + side*PI/2), so a positive z
 * offset walks the pool off the pavement and into the gutter where the wet road can take it.
 */
function spill(parent, color, r = 14, y = 0.22, z = 0) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(r * 2, r * 2.6), spillMaterial(color));
  m.rotation.x = -Math.PI / 2;
  m.position.set(0, y, z);
  m.renderOrder = 4;
  parent.add(m);
  return m;
}

// ---------------------------------------------------------------- THE MIRROR
//
// Wet asphalt, authored as geometry.
//
// Round 1 left the carriageway to the post chain's screen-space pass: nine taps of a mirrored
// view ray with a per-pixel interleaved-gradient dither. On the largest surface in every frame
// that resolved, at 3x, into a confetti of hard on/off pixels — the loudest procedural tell in
// the build. A specular reflection in a rough wet road is not a point sample of the frame buffer.
// It is one CONTINUOUS smear: hot and narrow directly under the source, widening, dimming and
// breaking into ripple as it travels the hundred metres toward the eye.
//
// So every light in this city now lays its own smear on the tarmac as a real tapered ribbon that
// follows the road: kerb pylons, blade marquees, the neon gates, the WELCOME arch, the gutters,
// and each of the six heroes — including one razor line of white for the pyramid's sky beam,
// which is the only object in Vegas whose reflection runs the whole length of the boulevard.
//
// Cost: the whole system is ~25 draw calls and ~14k triangles for the entire circuit, because
// every ribbon that shares a material is merged into one mesh at build time (see reflFlush).

/**
 * Streak profiles. `decay` is how fast the smear dies as it travels toward the eye, `sig0/sigK`
 * the lateral half-width at the source and its growth with distance (a rough mirror blurs with
 * path length), `rip` how hard the ripple chop bites. `flat` swaps the Gaussian for a plateau,
 * which is what an overhead gantry lays down: a band across the road rather than a line.
 */
const REFL = [
  { decay: 3.6, sig0: 0.12, sigK: 0.42, rip: 1.00, seed: 1 },   // 0 kerb blade marquee
  { decay: 2.4, sig0: 0.09, sigK: 0.34, rip: 1.15, seed: 2 },   // 1 tall pylon / hero: a long throw
  { decay: 4.2, sig0: 0.22, sigK: 0.46, rip: 0.70, seed: 3 },   // 2 broad soft wash
  { decay: 1.8, sig0: 0.13, sigK: 0.30, rip: 0.85, seed: 4 },   // 3 the pyramid beam: a long throw
  { decay: 2.6, sig0: 0.44, sigK: 0.20, rip: 1.00, seed: 5, flat: true }, // 4 overhead gantry band
  { decay: 4.0, sig0: 0.24, sigK: 0.40, rip: 0.80, seed: 6 },   // 5 gutter, second ripple layout
  { decay: 4.4, sig0: 0.19, sigK: 0.50, rip: 0.90, seed: 7 },   // 6 gutter, third ripple layout
];

/**
 * One streak, authored in reflection space: U across the smear, V along it with v=0 at the
 * source. Written straight into an ImageData because it is a per-pixel formula, not a drawing —
 * and stored gamma-encoded against an sRGB texture, so the number in the loop IS the linear
 * intensity that lands on the road.
 */
function reflTexture(variant) {
  return mat(`lv-refl|${variant}`, () => {
    const p = REFL[variant];
    const W = 96, H = 512;
    const { c, ctx } = canvas(W, H);
    const img = ctx.createImageData(W, H);
    const rng = new RNG(p.seed * 977 + 13);
    // Ripple: six slow bands, none finer than ~2 m of road at working scale. This is the whole
    // difference between "wet asphalt" and "dither" — a wet road IS broken up, but by water at
    // the scale of a hand, not by pixels.
    const bands = [];
    for (let i = 0; i < 6; i++) {
      bands.push({ f: rng.range(7, 44), ph: rng.range(0, 6.283), a: rng.range(0.07, 0.24) });
    }
    const wob = rng.range(0.06, 0.18), wf = rng.range(0.7, 2.4), wp = rng.range(0, 6.283);
    const drift = rng.range(-0.05, 0.05);
    for (let y = 0; y < H; y++) {
      const v = y / (H - 1);
      let A = Math.exp(-v * p.decay) * 0.94 + Math.pow(1 - v, 2.6) * 0.07;
      let rip = 1;
      for (const b of bands) {
        rip -= b.a * p.rip * (0.5 + 0.5 * Math.sin(v * b.f + b.ph)) * (0.20 + 0.80 * v);
      }
      // Both ends must reach zero. A ribbon that still carries 8% of its peak where the quad
      // stops draws a hard transverse edge across the carriageway — which is a seam, not a
      // reflection. Two metres of ramp in, a fifth of the length of fade out.
      A *= clamp(rip, 0.10, 1.1) * clamp(v * 66, 0, 1) * clamp((1 - v) * 4.5, 0, 1);
      const sig = p.sig0 + p.sigK * v;
      const cx = 0.5 + drift * v + wob * v * Math.sin(v * wf * 6.283 + wp);
      const row = y * W;
      for (let x = 0; x < W; x++) {
        const ux = x / (W - 1);
        const d = (ux - cx) / sig;
        const prof = p.flat
          ? clamp(1.30 - Math.pow(Math.abs(d), 3.2), 0, 1)
          : Math.exp(-d * d * 2.0) + 0.30 * Math.exp(-Math.abs(d) * 1.35);
        // and a hard taper at the ribbon's own edge, so the quad never shows a seam
        const val = clamp(A * prof * (1 - Math.pow(Math.abs(ux * 2 - 1), 8)), 0, 1);
        const i4 = (row + x) * 4;
        const q = (255 * Math.pow(val, 1 / 2.2)) | 0;
        img.data[i4] = img.data[i4 + 1] = img.data[i4 + 2] = q;
        img.data[i4 + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    // flipY off so canvas row 0 is v=0 is the source end, which is how the ribbon indexes it
    const t = toTexture(c, { srgb: true, wrap: THREE.ClampToEdgeWrapping, flipY: false });
    return t;
  });
}

// Hue and brightness ride in the vertex colours, so the whole system is ONE material per streak
// profile rather than one per (hue, profile, tier) — which was forty-four materials, and therefore
// forty-four un-cullable draw calls on every single frame of the race.
const REFL_TIER = [0.55, 0.34, 0.20, 0.12];
function reflMaterial(variant = 0) {
  return mat(`lv-reflm|${variant}`, () => new THREE.MeshBasicMaterial({
    map: reflTexture(variant), vertexColors: true,
    transparent: true, opacity: 1, blending: THREE.AdditiveBlending,
    depthWrite: false, fog: false, side: THREE.DoubleSide,
  }));
}

/** Per-build collector: one merged mesh per streak material for the whole circuit. */
let REFL_BANK = null;

/**
 * A tapered ribbon lying on the carriageway, running from arc position `m` (the source, v=0)
 * back down the road toward the oncoming driver. `lat0 → lat1` is the lateral convergence: the
 * mirror image of a kerbside sign sits at the kerb under the sign and walks in toward the
 * driver's own line as it approaches, which is exactly why a wet road draws vertical streaks in
 * screen space rather than diagonal ones.
 */
function reflRibbon(track, {
  m, len, side = 1, lat0 = 0.80, lat1 = 0.10, half0 = 0.20, half1 = 0.13,
  lift = 0.06, segs = 20, mirror = false,
}) {
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const e = t * t * (3 - 2 * t);
    const u = U(m - len * t);
    const lat = lerp(lat0, lat1, e) * side;
    const hl = lerp(half0, half1, t);
    const a = track.surfacePoint(u, lat - hl, lift);
    const b = track.surfacePoint(u, lat + hl, lift);
    pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
    if (mirror) uv.push(1, t, 0, t); else uv.push(0, t, 1, t);
    if (i < segs) { const k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/**
 * The same thing along a branch corridor. Shortcuts are the darkest surfaces in the city — the
 * block generator deliberately keeps its footprints out of them — so without this the drift
 * capture lands the car on an unlit apron while the boulevard 40 m away is a mirror.
 */
const _UP = new THREE.Vector3(0, 1, 0);
function reflBranchRibbon(b, {
  t0, len, lat0 = 0.7, lat1 = 0.1, half0 = 0.3, half1 = 0.2, lift = 0.07, segs = 14,
}) {
  const pos = [], uv = [], idx = [];
  const dt = len / b.length;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const tt = clamp(t0 - dt * t, 0.002, 0.998);
    const p = b.curve.getPointAt(tt);
    const tg = b.curve.getTangentAt(tt).normalize();
    const right = new THREE.Vector3().crossVectors(tg, _UP).normalize();
    const y = p.y + b.riseAt(tt) + lift;
    const e = t * t * (3 - 2 * t);
    const lat = lerp(lat0, lat1, e);
    const hl = lerp(half0, half1, t);
    const c0 = p.clone().addScaledVector(right, (lat - hl) * b.halfWidth).setY(y);
    const c1 = p.clone().addScaledVector(right, (lat + hl) * b.halfWidth).setY(y);
    pos.push(c0.x, c0.y, c0.z, c1.x, c1.y, c1.z);
    uv.push(0, t, 1, t);
    if (i < segs) { const k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

const _IDENTITY = new THREE.Matrix4();
/** Queue one streak against its material, hue and brightness in its vertex colours. */
function reflect(track, o) {
  const m = reflMaterial(o.variant ?? 0);
  if (!REFL_BANK) REFL_BANK = new Map();
  let b = REFL_BANK.get(m);
  if (!b) { b = new B(m); REFL_BANK.set(m, b); }
  b.addM(o.branch ? reflBranchRibbon(o.branch, o) : reflRibbon(track, o),
    _IDENTITY, vcTint(o.color, REFL_TIER[o.tier ?? 0]));
}

/** Collapse the queue: one mesh per material, kept out of the chunk merge so renderOrder holds. */
function reflFlush(out) {
  if (!REFL_BANK) return;
  const holder = new THREE.Group();
  for (const b of REFL_BANK.values()) {
    const m = b.into(holder);
    if (!m) continue;
    m.userData.noMerge = true;
    m.renderOrder = 3;
    m.frustumCulled = false;      // it spans the circuit; the sphere test can only ever pass
    out.push(m);
  }
  REFL_BANK = null;
}

function steel(tint = '#231c30') {
  return mat(`steel|${tint}`, () => vcTag(new THREE.MeshStandardMaterial({
    color: new THREE.Color(tint), metalness: 0.75, roughness: 0.45, envMapIntensity: 1.2,
  }), VC_STEEL, tint));
}
function emissive(color, intensity = 2.4, rough = 0.4) {
  return mat(`em|${color}|${intensity}`, () => new THREE.MeshStandardMaterial({
    color: new THREE.Color(color).multiplyScalar(0.35),
    emissive: new THREE.Color(color), emissiveIntensity: intensity,
    roughness: rough, metalness: 0.2,
  }));
}

/**
 * Running bulbs, done as a scrolling texture rather than N phase materials: one 96x8 dot strip
 * per hue, `map.offset.x` animated. Every chase strip in the city that shares a hue shares the
 * material, so the whole Strip flickers for three draw calls and no per-frame geometry work.
 */
function chaseTexture() {
  return mat('chase-tex', () => {
    const { c, ctx } = canvas(96, 12);
    ctx.clearRect(0, 0, 96, 12);
    for (let i = 0; i < 8; i++) {
      const x = (i + 0.5) * 12;
      const g = ctx.createRadialGradient(x, 6, 0, x, 6, 6.5);
      const on = i % 4 === 0;
      g.addColorStop(0, `rgba(255,255,255,${on ? 1 : 0.42})`);
      g.addColorStop(0.45, `rgba(255,255,255,${on ? 0.55 : 0.16})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, 6, 6.5, 0, 7); ctx.fill();
    }
    const t = toTexture(c, { srgb: true, wrap: THREE.RepeatWrapping });
    ANIMS.push((time) => { t.offset.x = time * 0.62; });
    return t;
  });
}
function chaseMaterial(color) {
  return mat(`chase|${color}`, () => vcTag(new THREE.MeshBasicMaterial({
    map: chaseTexture(), color: new THREE.Color(color), transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  }), VC_CHASE, color));
}
/**
 * A collector for chase strips at one bulb phase. The phase used to be a per-material
 * `map.offset.x`, which meant a material per (hue, phase) and ninety-seven un-batchable meshes;
 * it is the same picture written into the u of the geometry, so every chase strip in the city can
 * now share one scrolling texture — and, after vcCollapse(), one material.
 */
function chaseBatch(color, phase = 0) {
  const b = new B(chaseMaterial(color));
  b.uPhase = phase;
  return b;
}

/** A run of chase bulbs `len` metres long lying in the XY plane, centred on the origin. */
function chaseStrip(bat, len, x, y, z, ry = 0, o = {}) {
  const g = new THREE.PlaneGeometry(len, o.w ?? 0.9);
  const uv = g.attributes.uv;
  const rep = Math.max(1, Math.round(len / 1.1));
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * rep, uv.getY(i));
  uv.needsUpdate = true;
  bat.add(g, x, y, z, ry, o);
}

// ---------------------------------------------------------------- sign faces

const WORDS = [
  'GOLDEN ACE', 'FLAMINGO', 'STARLITE', 'NEON QUEEN', 'ROYAL FLUSH', 'DESERT STAR',
  'HIGH ROLLER', 'ACES WILD', 'THE ORACLE', 'DIAMOND JIM', 'SILVER SPUR', 'CACTUS CLUB',
  'FORTUNA', 'VIVA', 'JACKPOT', 'EL RANCHO', 'BLUE CHIP', 'LUCKY STRIKE', 'SANDSTORM',
  'THE MIRAGE', 'PARADISO', 'BOOMTOWN',
];
const SUBS = [
  'CASINO', 'SLOTS', 'HOTEL', '24 HOURS', 'LOOSE SLOTS', 'BUFFET', 'SHOWROOM',
  'WEDDING CHAPEL', 'ALL IN', 'BLACKJACK', 'FREE PARKING', 'NO LIMIT', 'PAYS 3 TO 2',
];

/**
 * A casino sign face. Painted as a real sign — a dark cabinet, a double neon border, a bulb
 * chase inside it, a big glowing word, a sub-line on a contrasting plate, and a chevron rail —
 * so at any distance there is structure inside the light instead of one flat coloured rectangle
 * for bloom to eat.
 */
function signFace({
  w = 384, h = 640, text = 'VIVA', sub = 'CASINO', color = MAGENTA, accent = GOLD,
  seed = 1, vertical = true,
}) {
  const rng = new RNG(seed * 131 + 7);
  const { c, ctx } = canvas(w, h);
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, '#160a26'); g.addColorStop(0.5, '#24103a'); g.addColorStop(1, '#100718');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);

  // cabinet panel joints — a sign this size is built from sheets
  ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 2;
  for (let y = 0; y < h; y += h / 6) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }

  // double neon border
  ctx.strokeStyle = color; ctx.lineWidth = 10;
  ctx.shadowColor = color; ctx.shadowBlur = 26;
  ctx.strokeRect(13, 13, w - 26, h - 26);
  ctx.shadowBlur = 0;
  ctx.strokeStyle = accent; ctx.lineWidth = 4;
  ctx.strokeRect(30, 30, w - 60, h - 60);

  // bulb chase painted inside the border
  const bulbs = (x0, y0, x1, y1, n, col) => {
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const x = lerp(x0, x1, t), y = lerp(y0, y1, t);
      const r = 5.2;
      const rg = ctx.createRadialGradient(x, y, 0, x, y, r * 2.1);
      const on = i % 3 === 0;
      rg.addColorStop(0, on ? '#ffffff' : col);
      rg.addColorStop(0.35, col);
      rg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = rg;
      ctx.globalAlpha = on ? 1 : 0.55;
      ctx.beginPath(); ctx.arc(x, y, r * 2.1, 0, 7); ctx.fill();
      ctx.globalAlpha = 1;
    }
  };
  const nV = Math.round(h / 34), nH = Math.round(w / 34);
  bulbs(21, 21, 21, h - 21, nV, accent);
  bulbs(w - 21, 21, w - 21, h - 21, nV, accent);
  bulbs(21, 21, w - 21, 21, nH, accent);
  bulbs(21, h - 21, w - 21, h - 21, nH, accent);

  if (vertical) {
    // letters stacked down the pylon, each in its own lozenge — the classic Strip pylon
    const letters = text.replace(/[^A-Z0-9]/g, '').slice(0, 9).split('');
    const top = 70, bot = h - 150;
    const cell = (bot - top) / letters.length;
    const size = Math.min(cell * 0.82, w * 0.56);
    letters.forEach((ch, i) => {
      const cy = top + cell * (i + 0.5);
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      ctx.fillRect(w * 0.12, cy - cell * 0.44, w * 0.76, cell * 0.88);
      drawText(ctx, ch, {
        x: w / 2, y: cy + size * 0.36, size, weight: 0.22, italic: 0.05, align: 'center',
        color: i % 2 ? color : accent, tracking: 0,
        glow: { color: i % 2 ? color : accent, blur: size * 0.75 },
      });
    });
    // sub plate at the foot
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(w * 0.06, h - 132, w * 0.88, 74);
    ctx.strokeStyle = CYAN; ctx.lineWidth = 3;
    ctx.strokeRect(w * 0.06, h - 132, w * 0.88, 74);
    drawText(ctx, sub, {
      x: w / 2, y: h - 78, size: Math.min(44, (w * 0.8) / Math.max(4, sub.length) * 1.7),
      weight: 0.18, italic: 0.16, align: 'center', color: CYAN, tracking: 0.10,
      glow: { color: CYAN, blur: 20 },
    });
  } else {
    // wide marquee board: big word over a sub-line, with a chevron rail beneath
    drawText(ctx, text, {
      x: w / 2, y: h * 0.44, size: Math.min(h * 0.30, (w * 0.86) / Math.max(4, text.length) * 1.75),
      weight: 0.23, italic: 0.20, align: 'center', color, tracking: 0.06,
      glow: { color, blur: 34 },
    });
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(w * 0.10, h * 0.52, w * 0.80, h * 0.20);
    drawText(ctx, sub, {
      x: w / 2, y: h * 0.665, size: Math.min(h * 0.15, (w * 0.72) / Math.max(5, sub.length) * 1.7),
      weight: 0.18, italic: 0.16, align: 'center', color: accent, tracking: 0.14,
      glow: { color: accent, blur: 18 },
    });
    ctx.fillStyle = CYAN;
    for (let i = 0; i < 7; i++) {
      const x = w * 0.10 + i * (w * 0.80 / 7);
      ctx.beginPath();
      ctx.moveTo(x, h * 0.84); ctx.lineTo(x + w * 0.06, h * 0.90);
      ctx.lineTo(x, h * 0.96); ctx.lineTo(x + w * 0.02, h * 0.90);
      ctx.closePath(); ctx.fill();
    }
  }
  grain(ctx, w, h, 4, rng);
  return c;
}

/**
 * A Strip pylon: mast, cabinet, chase-bulb frame, and a crown (star / arrow / diamond / wheel).
 * Everything about it is jittered — height, board aspect, hue assignment, crown type, mast style
 * — because a row of identical pylons is exactly §7's "same prop mesh at a regular interval".
 */
// Sign faces come from a POOL. Thirty-odd unique 384x880 canvases is 30 MB of texture and a
// third of a second of glow-blurred text rendering; twenty-four shared between sixty-eight signs
// is not, and because the pool index advances by one per sign the same face never appears twice
// inside ~900 m of road — nowhere near the "visible regular interval" §7 caps at 66.
//
// The whole pool then goes into ONE ATLAS, because a pool of thirty-four TEXTURES is still a pool
// of thirty-four materials, and two pylons a hundred metres apart with different faces could not
// share a draw call: measured, 119 of the 571 landmark meshes were sign boards. Packed into a
// single sheet they are one material, and the kit's chunk merge folds every board in a cell into
// one buffer. Same pixels, and the same number of them.
//
// The one thing an atlas can get wrong is the mip chain, because a coarse level averages across
// cell boundaries and one sign's neon border bleeds into its neighbour's. Two defences: every cell
// is laid out on a 16 px grid, so mip levels 0-4 (down to a 24 px sign, well past the point where
// a board is legible) fall exactly on cell edges; and each cell is surrounded by a 16 px gutter of
// its OWN replicated edge pixels — the same thing `ClampToEdgeWrapping` was doing for the separate
// textures — so the little that does bleed is the sign's own colour rather than the one next door.
const FACE_ASPECT = [1.42, 1.80, 2.30];
const FACE_PAD = 16;
const FACE_GRID = 16;
const up16 = (n) => Math.ceil(n / FACE_GRID) * FACE_GRID;
let FACE_ATLAS = null;

/** Blit `fc` at (x,y) with a PAD-wide skirt of its own edge pixels — an in-atlas clamp-to-edge. */
function blitClamped(ctx, fc, x, y) {
  const w = fc.width, h = fc.height, P = FACE_PAD;
  ctx.drawImage(fc, x, y, w, h);
  ctx.drawImage(fc, 0, 0, 1, h, x - P, y, P, h);                 // left
  ctx.drawImage(fc, w - 1, 0, 1, h, x + w, y, P, h);             // right
  ctx.drawImage(fc, 0, 0, w, 1, x, y - P, w, P);                 // top
  ctx.drawImage(fc, 0, h - 1, w, 1, x, y + h, w, P);             // bottom
  ctx.drawImage(fc, 0, 0, 1, 1, x - P, y - P, P, P);             // corners
  ctx.drawImage(fc, w - 1, 0, 1, 1, x + w, y - P, P, P);
  ctx.drawImage(fc, 0, h - 1, 1, 1, x - P, y + h, P, P);
  ctx.drawImage(fc, w - 1, h - 1, 1, 1, x + w, y + h, P, P);
}

function faceAtlas() {
  if (FACE_ATLAS) return FACE_ATLAS;
  const rows = [];
  // three rows of eight vertical pylon boards, grouped by aspect so a row has one cell height...
  for (let r = 0; r < 3; r++) {
    const cw = 384, ch = Math.round(384 * FACE_ASPECT[r]);
    const cells = [];
    for (let i = 0; i < 8; i++) cells.push({ kind: 't', k: r + i * 3, cw, ch });
    rows.push({ cw, ch, cells });
  }
  // ...then the wide marquee boards, six and four.
  for (const [n, k0] of [[6, 0], [4, 6]]) {
    const cells = [];
    for (let i = 0; i < n; i++) cells.push({ kind: 'w', k: k0 + i, cw: 512, ch: 216 });
    rows.push({ cw: 512, ch: 216, cells });
  }
  // step to the next cell on a 16 px grid, so a tile's origin survives four mip halvings intact
  let W = 0, H = 0;
  for (const row of rows) {
    row.stepX = up16(row.cw + FACE_PAD * 2);
    row.stepY = up16(row.ch + FACE_PAD * 2);
    W = Math.max(W, row.cells.length * row.stepX);
    H += row.stepY;
  }
  const { c, ctx } = canvas(W, H);
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  const tall = [], wide = [];
  let y = 0;
  for (const row of rows) {
    let x = 0;
    for (const cell of row.cells) {
      const k = cell.k;
      const fc = cell.kind === 't'
        ? signFace({
          w: 384, h: Math.round(384 * FACE_ASPECT[k % 3]),
          text: WORDS[(k * 5 + 3) % WORDS.length], sub: SUBS[(k * 7 + 2) % SUBS.length],
          color: HUES[k % 3], accent: HUES[(k + 1) % 3], seed: k * 31 + 5, vertical: true,
        })
        : signFace({
          w: 512, h: 216, text: WORDS[(k * 9 + 1) % WORDS.length],
          sub: SUBS[(k * 3 + 5) % SUBS.length],
          color: HUES[(k + 1) % 3], accent: HUES[(k + 2) % 3], seed: k * 17 + 9, vertical: false,
        });
      const px = x + FACE_PAD, py = y + FACE_PAD;
      blitClamped(ctx, fc, px, py);
      const tile = {
        u0: px / W, us: cell.cw / W, v0: 1 - (py + cell.ch) / H, vs: cell.ch / H,
        aspect: cell.ch / cell.cw,
      };
      (cell.kind === 't' ? tall : wide)[k] = tile;
      x += row.stepX;
    }
    y += row.stepY;
  }
  const tex = toTexture(c, { srgb: true, wrap: THREE.ClampToEdgeWrapping });
  FACE_ATLAS = {
    material: new THREE.MeshStandardMaterial({
      map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 2.5,
      roughness: 0.5, metalness: 0.1, side: THREE.FrontSide,
    }),
    tall, wide,
  };
  return FACE_ATLAS;
}

const tallFace = (i) => faceAtlas().tall[((i % 24) + 24) % 24];
const wideFace = (i) => faceAtlas().wide[((i % 10) + 10) % 10];

/** A sign board `w` x `h` metres showing one tile of the atlas. */
function faceMesh(w, h, tile) {
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, tile.u0 + uv.getX(i) * tile.us, tile.v0 + uv.getY(i) * tile.vs);
  }
  uv.needsUpdate = true;
  return new THREE.Mesh(g, faceAtlas().material);
}

function neonPylon({ h = 22, bw = 8, seed = 1, index = 0, hue = 0, crown = 0 }) {
  const g = new THREE.Group();
  const rng = new RNG(seed * 17 + 3);
  const color = HUES[hue % 3];
  const accent = HUES[(hue + 1) % 3];
  const third = HUES[(hue + 2) % 3];
  const face = tallFace(index);
  // the cabinet must clear the pavement no matter how the height/width jitter lands
  const aspect = FACE_ASPECT[(((index % 24) + 24) % 24) % 3];
  const bh = Math.min(bw * aspect, (h - 5.5) * 0.80);
  const bwEff = bh / aspect;
  const midY = h - bh / 2 - 1.2;

  const st = new B(steel(), { cast: false });
  const tb = new B(tube(third));
  const hb = new B(halo(color, 0.10));
  const cb = chaseBatch(accent, (seed % 5) / 5);

  // mast: two legs with lattice bracing, standing on a plinth
  const legX = bwEff * 0.30;
  for (const sx of [-1, 1]) {
    st.add(cyl(0.34, 0.5, midY, 8), sx * legX, midY / 2, 0);
    for (let i = 0; i < Math.floor(midY / 3); i++) {
      st.add(box(0.16, 3.1, 0.16), sx * legX, 1.6 + i * 3, 0, 0, { rz: i % 2 ? 0.62 : -0.62 });
    }
  }
  for (let i = 1; i < Math.floor(midY / 3.4); i++) st.add(box(legX * 2, 0.2, 0.2), 0, i * 3.4, 0);
  st.add(box(bwEff * 0.9, 0.7, 3.0), 0, 0.35, 0);

  // cabinet: a front and a back face so the sign reads from either direction, plus a frame
  for (const s of [1, -1]) {
    const p = faceMesh(bwEff, bh, face);
    p.position.set(0, midY, s * 0.42);
    p.rotation.y = s > 0 ? 0 : Math.PI;
    g.add(p);
  }
  st.add(box(bwEff + 0.9, bh + 0.9, 0.7), 0, midY, 0);

  // chase bulbs framing the cabinet on both faces
  for (const s of [1, -1]) {
    chaseStrip(cb, bwEff + 1.1, 0, midY + bh / 2 + 0.45, s * 0.62, s > 0 ? 0 : Math.PI, { w: 0.85 });
    chaseStrip(cb, bwEff + 1.1, 0, midY - bh / 2 - 0.45, s * 0.62, s > 0 ? 0 : Math.PI, { w: 0.85 });
    chaseStrip(cb, bh + 1.1, -bwEff / 2 - 0.55, midY, s * 0.62, s > 0 ? 0 : Math.PI, { w: 0.85, rz: Math.PI / 2 });
    chaseStrip(cb, bh + 1.1, bwEff / 2 + 0.55, midY, s * 0.62, s > 0 ? 0 : Math.PI, { w: 0.85, rz: Math.PI / 2 });
  }
  // a broad soft halo behind the cabinet: neon spill on the night air
  hb.add(new THREE.PlaneGeometry(bwEff * 2.0, bh * 1.5), 0, midY, 1.15);

  // crown
  const cy = midY + bh / 2 + 2.6;
  if (crown % 4 === 0) {
    // starburst
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const len = i % 2 ? bwEff * 0.34 : bwEff * 0.62;
      tb.add(box(0.34, len, 0.34), Math.cos(a) * len * 0.5, cy + Math.sin(a) * len * 0.5, 0, 0, { rz: -a + Math.PI / 2 });
    }
    hb.add(new THREE.PlaneGeometry(bwEff * 2.2, bwEff * 2.2), 0, cy, 0.7);
  } else if (crown % 4 === 1) {
    // an arrow pointing down at the road
    for (const s of [-1, 1]) {
      tb.add(box(0.4, bwEff * 0.7, 0.4), s * bwEff * 0.24, cy + 0.4, 0, 0, { rz: s * 0.62 });
      chaseStrip(cb, bwEff * 0.7, s * bwEff * 0.24, cy + 0.4, 0.4, 0, { rz: s * 0.62, w: 0.8 });
    }
    tb.add(box(bwEff * 0.86, 0.4, 0.4), 0, cy + bwEff * 0.34, 0);
  } else if (crown % 4 === 2) {
    // a ring of bulbs — a roulette wheel read
    const r = bwEff * 0.44;
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2;
      tb.add(new THREE.SphereGeometry(0.30, 6, 5), Math.cos(a) * r, cy + r + Math.sin(a) * r, 0);
    }
    tb.add(cyl(r * 0.22, r * 0.22, 0.4, 10), 0, cy + r, 0, 0, { rx: Math.PI / 2 });
    hb.add(new THREE.PlaneGeometry(r * 3.8, r * 3.8), 0, cy + r, 0.7);
  } else {
    // stacked diamonds
    for (let i = 0; i < 3; i++) {
      const s = bwEff * (0.40 - i * 0.09);
      tb.add(box(s, s, 0.36), 0, cy + i * s * 1.15 + s * 0.6, 0, 0, { rz: Math.PI / 4 });
    }
  }

  st.into(g); tb.into(g); cb.into(g);
  const hm = hb.into(g); if (hm) hm.renderOrder = 3;
  spill(g, color, bwEff * 1.15, 0.24, 10);
  return g;
}

/** A blade marquee cantilevered out over the sidewalk from a casino frontage. */
function bladeSign({ h = 9, w = 11, seed = 1, index = 0, hue = 0 }) {
  const g = new THREE.Group();
  const color = HUES[hue % 3];
  const st = new B(steel('#1c1526'));
  const cb = chaseBatch(color, (seed % 3) / 3);
  const bh = w * 0.4219;                       // matches the pooled 512x216 face exactly
  const face = wideFace(index);
  for (const s of [1, -1]) {
    const p = faceMesh(w, bh, face);
    p.position.set(0, h, s * 0.3);
    p.rotation.y = s > 0 ? 0 : Math.PI;
    g.add(p);
  }
  st.add(box(w + 0.8, bh + 0.8, 0.5), 0, h, 0);
  st.add(box(0.5, 0.5, 4.2), -w / 2 + 0.4, h + bh / 2, -2.1);
  st.add(box(0.5, 0.5, 4.2), w / 2 - 0.4, h + bh / 2, -2.1);
  st.add(box(0.4, 3.4, 0.4), -w / 2 + 0.4, h - bh / 2 - 1.7, -0.4, 0, { rx: 0.5 });
  st.add(box(0.4, 3.4, 0.4), w / 2 - 0.4, h - bh / 2 - 1.7, -0.4, 0, { rx: 0.5 });
  for (const s of [1, -1]) {
    chaseStrip(cb, w + 1.0, 0, h + bh / 2 + 0.5, s * 0.5, s > 0 ? 0 : Math.PI);
    chaseStrip(cb, w + 1.0, 0, h - bh / 2 - 0.5, s * 0.5, s > 0 ? 0 : Math.PI);
  }
  st.into(g); cb.into(g);
  spill(g, color, w * 0.75, 0.24, 8);
  return g;
}

// ---------------------------------------------------------------- hero landmarks

/** UV rescale in place, so a texture can be applied in METRES on any generated primitive. */
function scaleUV(geo, uRep, vRep, u0 = 0, v0 = 0) {
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * uRep, v0 + uv.getY(i) * vRep);
  uv.needsUpdate = true;
  return geo;
}

/**
 * The glass pyramid.
 *
 * Built here rather than taken from the kit for two reasons: the kit's corner-arris batch places
 * its four edge bars off the surface (they read as loose diagonal sticks floating beside the
 * pyramid), and at 700 m its glazing is too dark to survive the fog. This one lays its glass in
 * eighteen frusta with the panel grid scaled in METRES, runs the four arrises exactly along the
 * true base→apex edges with a quaternion, and stands on a floodlit plinth with a sphinx and two
 * obelisks in front of it — the Egyptian silhouette is half of why the shape reads as Vegas and
 * not as "a cone".
 */
function glassPyramidLV({ h = 185, base = 250, seed = 3 }) {
  const g = new THREE.Group();
  const rng = new RNG(seed * 13 + 1);
  const R = base / 2;

  const glass = mat('lv-pyrglass', () => {
    const S = 256;
    const { c, ctx } = canvas(S, S);
    const { c: ec, ctx: ex } = canvas(S, S);
    const r2 = new RNG(4411);
    ctx.fillStyle = '#08060f'; ctx.fillRect(0, 0, S, S);
    ex.fillStyle = '#000'; ex.fillRect(0, 0, S, S);
    // The glazing is authored as HORIZONTAL COURSES rather than a square grid. A square grid at
    // this building's scale lands at well under a pixel per pane from the landmark camera and
    // moirés into a field of sparkles; courses stay legible because they are 2 m tall and as wide
    // as the face, so at any distance the pyramid reads as stacked bands of glass.
    const COL = 16, ROW = 6;
    const cw = S / COL, ch = S / ROW;
    for (let r = 0; r < ROW; r++) {
      for (let i = 0; i < COL; i++) {
        const x = i * cw + 1.0, y = r * ch + 2.4, w = cw - 2.0, hh = ch - 4.8;
        const v = r2.range(0.6, 1.3);
        ctx.fillStyle = `rgb(${(12 * v) | 0},${(10 * v) | 0},${(26 * v) | 0})`;
        ctx.fillRect(x, y, w, hh);
        if (r2.bool(0.26)) {
          const col = r2.bool(0.78) ? GOLD : (r2.bool(0.55) ? MAGENTA : CYAN);
          const a = r2.range(0.5, 1);
          ctx.globalAlpha = a; ex.globalAlpha = a;
          ctx.fillStyle = col; ctx.fillRect(x, y, w, hh);
          ex.fillStyle = col; ex.fillRect(x, y, w, hh);
          ctx.globalAlpha = 1; ex.globalAlpha = 1;
        }
      }
      // a continuous lit string course at every storey line
      ctx.fillStyle = 'rgba(255,194,30,0.42)'; ctx.fillRect(0, (r + 1) * ch - 3.2, S, 3.2);
      ex.fillStyle = 'rgba(255,194,30,0.62)'; ex.fillRect(0, (r + 1) * ch - 3.2, S, 3.2);
    }
    ctx.strokeStyle = 'rgba(150,130,190,0.26)'; ctx.lineWidth = 1.2;
    for (let i = 0; i <= COL; i++) { ctx.beginPath(); ctx.moveTo(i * cw, 0); ctx.lineTo(i * cw, S); ctx.stroke(); }
    grain(ctx, S, S, 3, r2);
    return new THREE.MeshStandardMaterial({
      map: toTexture(c, { srgb: true }), emissiveMap: toTexture(ec, { srgb: true }),
      emissive: 0xffffff, emissiveIntensity: 2.4,
      roughness: 0.11, metalness: 0.94, envMapIntensity: 2.4,
    });
  });

  const gb = new B(glass, { cast: true, receive: true });
  const COURSES = 18;
  for (let i = 0; i < COURSES; i++) {
    const t0 = i / COURSES, t1 = (i + 1) / COURSES;
    const r0 = R * (1 - t0), r1 = R * (1 - t1);
    const y0 = h * t0, y1 = h * t1;
    const geo = cyl(r1, r0, y1 - y0, 4, true);
    const rm = (r0 + r1) / 2;
    // one texture tile = 48 m of face (16 columns → 3 m panes) by one course of storeys
    scaleUV(geo, Math.max(2, Math.round((rm * 5.66) / 48)), 1, rng.next(), 0);
    gb.add(geo, 0, (y0 + y1) / 2, 0, Math.PI / 4);
  }
  gb.into(g);

  // --- the four corner arrises, aimed exactly along the real edges ---
  {
    const eb = new B(emissive(GOLD, 3.4));
    const cb = chaseBatch(GOLD, 0.2);
    const up = new THREE.Vector3(0, 1, 0);
    const L = Math.hypot(h, R);
    for (let k = 0; k < 4; k++) {
      const a = Math.PI / 4 + (k / 4) * Math.PI * 2;
      const foot = new THREE.Vector3(Math.cos(a) * R, 0, Math.sin(a) * R);
      const dir = new THREE.Vector3(0, h, 0).sub(foot).normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(up, dir);
      const mid = foot.clone().multiplyScalar(0.5).setY(h / 2);
      eb.addM(box(1.7, L, 1.7), new THREE.Matrix4().compose(mid, q, new THREE.Vector3(1, 1, 1)));
      const strip = new THREE.PlaneGeometry(L, 1.6);
      scaleUV(strip, Math.round(L / 3.2), 1);
      const q2 = q.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, Math.PI / 2)));
      cb.addM(strip, new THREE.Matrix4().compose(
        mid.clone().addScaledVector(foot.clone().normalize(), 1.4), q2, new THREE.Vector3(1, 1, 1),
      ));
    }
    eb.into(g); cb.into(g);
  }

  // --- plinth, colonnade and porte-cochère ---
  {
    const stone = new B(mat('lv-sand', () => new THREE.MeshStandardMaterial({
      color: 0x4a3a2a, roughness: 0.85, metalness: 0.1,
      emissive: new THREE.Color(GOLD), emissiveIntensity: 0.30,
    })), { cast: true, receive: true });
    const lit = new B(emissive(GOLD, 2.4));
    stone.add(box(base * 1.18, 4.5, base * 1.18), 0, 2.25, 0);
    stone.add(box(base * 1.26, 1.6, base * 1.26), 0, 0.8, 0);
    const n = 12;
    for (let s = 0; s < 4; s++) {
      const a = (s / 4) * Math.PI * 2;
      const nx = Math.cos(a), nz = Math.sin(a);
      for (let i = 0; i < n; i++) {
        const t = (i / (n - 1) - 0.5) * base * 1.08;
        const px = nx * base * 0.60 - nz * t, pz = nz * base * 0.60 + nx * t;
        stone.add(cyl(2.4, 3.0, 22, 10), px, 15.5, pz);
        stone.add(box(7, 2.6, 7), px, 27.8, pz);
        lit.add(cyl(2.7, 2.7, 1.1, 10), px, 5.4, pz);
      }
    }
    // sphinx out front: crouched body, forelegs, nemes headdress
    const sx = 0, sz = base * 0.86;
    stone.add(box(15, 7, 34), sx, 8, sz);
    stone.add(box(19, 3.0, 40), sx, 5.6, sz);
    for (const o of [-4.6, 4.6]) stone.add(box(4.2, 5.0, 20), sx + o, 7, sz - 24);
    stone.add(box(11, 12, 10), sx, 17, sz - 12);                    // chest / shoulders
    stone.add(box(7.4, 8.4, 7.0), sx, 26, sz - 15);                 // head
    stone.add(box(11.5, 9.5, 3.2), sx, 25, sz - 18.4);              // nemes front
    stone.add(box(10.5, 3.0, 8.0), sx, 30.6, sz - 14.5);            // nemes crown
    lit.add(box(1.6, 0.8, 1.6), sx, 33, sz - 14.5);
    // obelisks flanking the approach
    for (const o of [-1, 1]) {
      stone.add(cyl(1.6, 3.8, 44, 4), sx + o * base * 0.34, 22, sz + 26, Math.PI / 4);
      lit.add(new THREE.ConeGeometry(2.5, 9, 4), sx + o * base * 0.34, 48, sz + 26, Math.PI / 4);
    }
    stone.into(g); lit.into(g);
  }

  const fl = new THREE.PointLight(new THREE.Color(GOLD), 150, 300, 2);
  fl.position.set(0, 26, base * 0.5);
  g.add(fl);
  return g;
}

/**
 * The Eiffel replica. Built from a curved leg profile rather than a straight taper — the double
 * curvature under the first platform is the whole silhouette — with X lattice on every face, two
 * platforms, and gold bulb strings running the leading edges so it reads as a shape made of
 * light against a black sky.
 */
function eiffelReplica({ h = 155, seed = 5 }) {
  const g = new THREE.Group();
  const rng = new RNG(seed);
  const st = new B(steel('#2a2030'), { cast: true });
  const glow = new B(emissive(GOLD, 3.0), { cast: false });
  const cb = chaseBatch(GOLD, 0.0);
  const hb = new B(halo(GOLD, 0.10));

  const R = h * 0.215;                                  // half-footprint
  const P1 = h * 0.155, P2 = h * 0.375, P3 = h * 0.72;  // platform heights
  // radius profile: strong outward curve at the feet, near-vertical above the second platform
  const rAt = (y) => {
    const t = clamp(y / P3, 0, 1);
    return R * Math.pow(1 - t, 2.05) * 0.94 + h * 0.019;
  };

  const LEVELS = 16;
  const ys = [];
  for (let i = 0; i <= LEVELS; i++) ys.push((i / LEVELS) * P3);
  const diag = [[1, 1], [1, -1], [-1, -1], [-1, 1]];

  for (let i = 0; i < LEVELS; i++) {
    const y0 = ys[i], y1 = ys[i + 1];
    const r0 = rAt(y0), r1 = rAt(y1);
    const dy = y1 - y0;
    for (const [dx, dz] of diag) {
      // one leg segment, leaned so its ends land on the profile
      const ax = (r0 - r1) * dx, az = (r0 - r1) * dz;
      const len = Math.hypot(dy, Math.hypot(ax, az));
      const th = Math.hypot(r0 * dx - r1 * dx, r0 * dz - r1 * dz);
      const mx = ((r0 + r1) / 2) * dx, mz = ((r0 + r1) / 2) * dz;
      const w = lerp(h * 0.030, h * 0.012, i / LEVELS);
      const lean = Math.atan2(th, dy);
      const yaw = Math.atan2(dx, dz);
      st.add(box(w, len, w), mx, (y0 + y1) / 2, mz, yaw, { rx: -lean });
      // leading-edge bulb string
      chaseStrip(cb, len, mx + dx * w * 0.7, (y0 + y1) / 2, mz + dz * w * 0.7, yaw, { rz: Math.PI / 2, rx: -lean, w: 0.7 });
    }
    // horizontal ring + X bracing on each of the four faces
    for (let f = 0; f < 4; f++) {
      const a = (f / 4) * Math.PI * 2 + Math.PI / 4;
      const rm = (r0 + r1) / 2;
      const span = Math.SQRT2 * rm * 2 * 0.86;
      const cx = Math.cos(a) * rm, cz = Math.sin(a) * rm;
      st.add(box(span, h * 0.006, h * 0.006), cx, y1, cz, -a + Math.PI / 2);
      const dlen = Math.hypot(span, dy);
      for (const s of [-1, 1]) {
        st.add(box(h * 0.005, dlen, h * 0.005), cx, (y0 + y1) / 2, cz, -a + Math.PI / 2,
          { rz: s * Math.atan2(span, dy) * 0.5 });
      }
    }
  }

  // arches between the legs under the first platform — the instantly-recognisable bit
  for (let f = 0; f < 4; f++) {
    const a = (f / 4) * Math.PI * 2 + Math.PI / 4;
    const rm = rAt(P1 * 0.55);
    const cx = Math.cos(a) * rm, cz = Math.sin(a) * rm;
    const span = Math.SQRT2 * rm * 2 * 0.78;
    const N = 11;
    for (let i = 0; i < N; i++) {
      const t = i / (N - 1);
      const ax = (t - 0.5) * span;
      const ay = P1 * 0.72 - Math.cos((t - 0.5) * Math.PI) * P1 * 0.30;
      const nx = Math.cos(-a + Math.PI / 2) * ax, nz = -Math.sin(-a + Math.PI / 2) * ax;
      glow.add(box(span / N * 1.15, h * 0.008, h * 0.010), cx + nx, ay, cz + nz, -a + Math.PI / 2,
        { rz: (t - 0.5) * 1.4 });
    }
  }

  // platforms
  const platform = (y, rad, deck) => {
    st.add(box(rad * 2.2, deck, rad * 2.2), 0, y, 0);
    st.add(box(rad * 2.5, deck * 0.45, rad * 2.5), 0, y - deck * 0.7, 0);
    for (let f = 0; f < 4; f++) {
      const a = (f / 4) * Math.PI * 2;
      const cx = Math.cos(a) * rad * 1.1, cz = Math.sin(a) * rad * 1.1;
      chaseStrip(cb, rad * 2.2, cx, y + deck * 0.9, cz, -a + Math.PI / 2, { w: 1.0 });
      glow.add(box(rad * 2.2, 0.35, 0.35), cx, y + deck * 1.5, cz, -a + Math.PI / 2);
    }
    hb.add(new THREE.PlaneGeometry(rad * 4.4, rad * 1.6), 0, y, 0);
  };
  platform(P1, rAt(P1) * 1.28, h * 0.020);
  platform(P2, rAt(P2) * 1.42, h * 0.016);
  platform(P3, rAt(P3) * 1.9, h * 0.013);

  // mast above the top platform, then the antenna
  const mastH = h - P3;
  st.add(cyl(h * 0.012, h * 0.030, mastH * 0.72, 8), 0, P3 + mastH * 0.36, 0);
  for (let i = 0; i < 5; i++) {
    st.add(box(h * 0.030 - i * h * 0.004, 0.3, 0.3), 0, P3 + mastH * (0.10 + i * 0.13), 0, rng.range(0, 3));
  }
  glow.add(cyl(h * 0.020, h * 0.020, mastH * 0.10, 10), 0, P3 + mastH * 0.76, 0);
  st.add(cyl(0.22, h * 0.010, mastH * 0.24, 6), 0, P3 + mastH * 0.90, 0);
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(1.1, 8, 6), tube(GOLD));
  beacon.position.y = h + 1;
  beacon.userData.noMerge = true;
  g.add(beacon);

  st.into(g); glow.into(g); cb.into(g);
  const hm = hb.into(g); if (hm) hm.renderOrder = 3;

  // the sweeping beacon at the top, plus the gold flood on the ironwork
  const l1 = new THREE.PointLight(new THREE.Color(GOLD), 120, 260, 2);
  l1.position.set(0, h * 0.34, 0);
  g.add(l1);
  return g;
}

/**
 * The dancing fountains: a black mirror lake in front of a colonnade, forty jets on a sine
 * chorus, and uplights under every one of them. The lake surface is a low-roughness metal that
 * takes the env map plus a painted smear of the city's own three hues, so it reflects the Strip
 * even when nothing is directly above it.
 */
function fountainLake({ len = 150, wid = 66, seed = 9 }) {
  const g = new THREE.Group();
  const rng = new RNG(seed * 7 + 1);

  // --- water ---
  const water = mat('vegas-water', () => {
    const S = 512;
    const { c, ctx } = canvas(S, S);
    ctx.fillStyle = '#04030a'; ctx.fillRect(0, 0, S, S);
    // vertical smears of neon, as if the whole Strip were reflected in it
    for (let i = 0; i < 90; i++) {
      const x = rng.range(0, S), w = rng.range(4, 26);
      const col = new THREE.Color(rng.pick(HUES));
      const gr = ctx.createLinearGradient(0, 0, 0, S);
      const a = rng.range(0.10, 0.55);
      gr.addColorStop(0, `rgba(${(col.r * 255) | 0},${(col.g * 255) | 0},${(col.b * 255) | 0},0)`);
      gr.addColorStop(rng.range(0.2, 0.5), `rgba(${(col.r * 255) | 0},${(col.g * 255) | 0},${(col.b * 255) | 0},${a})`);
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = gr;
      ctx.fillRect(x, 0, w, S);
    }
    // ripple bands break the smears up so they read as water, not as stripes
    ctx.globalCompositeOperation = 'destination-out';
    for (let y = 0; y < S; y += 3) {
      ctx.fillStyle = `rgba(0,0,0,${rng.range(0.05, 0.45)})`;
      ctx.fillRect(0, y + rng.range(0, 2), S, rng.range(0.6, 2.2));
    }
    ctx.globalCompositeOperation = 'source-over';
    const t = toTexture(c, { srgb: true, repeat: [3, 3] });
    return new THREE.MeshStandardMaterial({
      color: 0x05040c, metalness: 1.0, roughness: 0.075, envMapIntensity: 2.6,
      emissiveMap: t, emissive: 0xffffff, emissiveIntensity: 1.15,
    });
  });
  const lake = new THREE.Mesh(new THREE.PlaneGeometry(len, wid, 1, 1), water);
  lake.rotation.x = -Math.PI / 2;
  lake.position.y = 0.35;
  lake.userData.noMerge = true;
  g.add(lake);

  // --- basin rim and balustrade ---
  const stone = mat('vegas-basin', () => new THREE.MeshStandardMaterial({
    color: 0x2a2436, roughness: 0.7, metalness: 0.25, envMapIntensity: 1.0,
  }));
  const sb = new B(stone, { cast: true, receive: true });
  const gb = new B(emissive(GOLD, 2.2), { cast: false });
  const cb = chaseBatch(GOLD, 0.4);
  for (const [dx, dz, l, ry] of [
    [0, 1, len + 6, 0], [0, -1, len + 6, 0],
    [1, 0, wid + 6, Math.PI / 2], [-1, 0, wid + 6, Math.PI / 2],
  ]) {
    const x = dx * (len / 2 + 2.4), z = dz * (wid / 2 + 2.4);
    sb.add(box(l, 1.5, 4.8), x, 0.75, z, ry);
    sb.add(box(l, 0.5, 5.6), x, 1.6, z, ry);
    chaseStrip(cb, l, x, 1.95, z + (dz ? dz * 2.6 : 0), ry, { rx: -Math.PI / 2, w: 1.1 });
    // balusters
    const n = Math.round(l / 3.4);
    for (let i = 0; i <= n; i++) {
      const o = -l / 2 + (i / n) * l;
      const bx = x + (ry ? 0 : o), bz = z + (ry ? o : 0);
      sb.add(cyl(0.24, 0.30, 1.5, 7), bx, 2.6, bz);
      gb.add(new THREE.SphereGeometry(0.26, 7, 6), bx, 3.5, bz);
    }
    sb.add(box(l, 0.34, 0.9), x, 3.6, z, ry);
  }

  // --- jets ---
  // Origin at the base so an animated scale.y grows the plume upward. One InstancedMesh rather
  // than fifteen meshes: the plumes differ only in position, radius and height, which is exactly
  // what an instance matrix carries, and additive blending does not care what order they land in.
  // Marked noMerge so mergeStatic reparents it intact and the animation survives.
  // The plume dissolves upward: a vertical alpha ramp on the cone, so a jet ends in spray
  // instead of in a hard flat cone lid. (Round 1 read as a picket fence of glowing sticks.)
  const jetMat = mat('vegas-jet', () => {
    const { c, ctx } = canvas(8, 128);
    const gr = ctx.createLinearGradient(0, 128, 0, 0);
    gr.addColorStop(0, 'rgba(255,255,255,0)');
    gr.addColorStop(0.10, 'rgba(255,255,255,0.95)');
    gr.addColorStop(0.45, 'rgba(255,255,255,0.42)');
    gr.addColorStop(0.80, 'rgba(255,255,255,0.10)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gr; ctx.fillRect(0, 0, 8, 128);
    const t = toTexture(c, { srgb: true, wrap: THREE.ClampToEdgeWrapping });
    t.generateMipmaps = false; t.minFilter = THREE.LinearFilter; t.needsUpdate = true;
    return new THREE.MeshBasicMaterial({
      map: t, color: new THREE.Color('#9fd8ff'), transparent: true, opacity: 0.34,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: true,
    });
  });
  const jets = [];
  const N = 15;
  const jetGeo = cyl(0.55, 1, 1, 9, true);          // unit cone; radius rides in the instance
  jetGeo.translate(0, 0.5, 0);
  const jetIM = new THREE.InstancedMesh(jetGeo, jetMat, N);
  jetIM.userData.noMerge = true;
  const jetM = new THREE.Matrix4();
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const x = (t - 0.5) * len * 0.84;
    const z = Math.sin(t * Math.PI) * wid * 0.18 * (i % 2 ? 1 : -1);
    const big = Math.abs(t - 0.5) < 0.09;
    const r = big ? 1.7 : 0.95;
    const hgt = big ? 30 : 15 + (i % 4) * 2.4;
    jetM.makeScale(r, hgt, r).setPosition(x, 0.4, z);
    jetIM.setMatrixAt(i, jetM);
    jets.push({ i, x, z, r, phase: t * 6.4 + (i % 3) * 1.1, base: hgt });
    // uplight in the water under each jet
    gb.add(new THREE.CircleGeometry(r * 2.6, 12), x, 0.42, z, 0, { rx: -Math.PI / 2 });
  }
  jetIM.instanceMatrix.needsUpdate = true;
  jetIM.computeBoundingSphere();     // taken at full height, so the plumes only ever shrink into it
  g.add(jetIM);
  ANIMS.push((time) => {
    for (const j of jets) {
      const s = 0.5 + 0.5 * Math.sin(time * 1.35 + j.phase);
      jetM.makeScale(j.r, j.base * (0.28 + 0.72 * s * s), j.r).setPosition(j.x, 0.4, j.z);
      jetIM.setMatrixAt(j.i, jetM);
    }
    jetIM.instanceMatrix.needsUpdate = true;
    jetMat.opacity = 0.28 + 0.10 * Math.sin(time * 2.1);
  });

  // spray haze over the water
  const mistTex = mat('vegas-mist-tex', () => {
    const { c, ctx } = canvas(128, 128);
    const gr = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, 'rgba(255,255,255,0.55)');
    gr.addColorStop(0.4, 'rgba(230,245,255,0.20)');
    gr.addColorStop(1, 'rgba(200,230,255,0)');
    ctx.fillStyle = gr; ctx.fillRect(0, 0, 128, 128);
    return toTexture(c, { srgb: true, wrap: THREE.ClampToEdgeWrapping });
  });
  const mistMat = mat('vegas-mist', () => new THREE.SpriteMaterial({
    map: mistTex, color: new THREE.Color('#bfe4ff'), transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.30, fog: true,
  }));
  for (let i = 0; i < 7; i++) {
    const s = new THREE.Sprite(mistMat);
    s.position.set(rng.range(-len * 0.42, len * 0.42), rng.range(4, 15), rng.range(-wid * 0.2, wid * 0.2));
    s.scale.setScalar(rng.range(22, 42));
    g.add(s);
  }

  sb.into(g); gb.into(g); cb.into(g);
  const l = new THREE.PointLight(new THREE.Color(CYAN), 110, 190, 2);
  l.position.set(0, 6, 0);
  g.add(l);
  return g;
}

/**
 * The replica skyline: a pocket Manhattan of eight towers, a stepped deco crown, a needle spire,
 * a Liberty silhouette on its own plinth and a coaster ribbon threading through the lot — all
 * drawn in gold and magenta window light so it reads as "a city made of bulbs" and not as more
 * of the same city.
 */
function replicaSkyline({ seed = 13 }) {
  const g = new THREE.Group();
  const rng = new RNG(seed * 29 + 5);

  const winTex = (variant, hue) => mat(`rep-win|${variant}|${hue}`, () => {
    const S = 256;
    const { c, ctx } = canvas(S, S);
    const { c: ec, ctx: ex } = canvas(S, S);
    const r2 = new RNG(variant * 91 + 3);
    ctx.fillStyle = '#150c22'; ctx.fillRect(0, 0, S, S);
    ex.fillStyle = '#000'; ex.fillRect(0, 0, S, S);
    const cols = 8 + variant, rows = 14 + variant * 2;
    const cw = S / cols, ch = S / rows;
    // masonry piers so the tower is not a colour field
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    for (let i = 0; i <= cols; i++) ctx.fillRect(i * cw - 1.5, 0, 3, S);
    for (let r = 0; r < rows; r++) {
      for (let i = 0; i < cols; i++) {
        const x = i * cw + cw * 0.22, y = r * ch + ch * 0.2;
        const w = cw * 0.56, h = ch * 0.54;
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.fillRect(x - 1.5, y - 1.5, w + 3, h + 3);
        if (r2.bool(0.62)) {
          const col = r2.bool(0.72) ? HUES[hue % 3] : HUES[(hue + 1) % 3];
          const a = r2.range(0.55, 1);
          ctx.globalAlpha = a; ex.globalAlpha = a;
          ctx.fillStyle = col; ctx.fillRect(x, y, w, h);
          ex.fillStyle = col; ex.fillRect(x, y, w, h);
          ctx.globalAlpha = 1; ex.globalAlpha = 1;
        } else {
          ctx.fillStyle = '#1b1226'; ctx.fillRect(x, y, w, h);
        }
      }
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      ctx.fillRect(0, (r + 0.82) * ch, S, ch * 0.08);
    }
    grain(ctx, S, S, 4, r2);
    return new THREE.MeshStandardMaterial({
      map: toTexture(c, { srgb: true }), emissiveMap: toTexture(ec, { srgb: true }),
      emissive: 0xffffff, emissiveIntensity: 1.7, roughness: 0.7, metalness: 0.15,
    });
  });

  const trim = new B(steel('#2c2138'), { cast: true });
  const gold = new B(emissive(GOLD, 2.6), { cast: false });
  const mag = new B(emissive(MAGENTA, 2.4), { cast: false });

  /** One tower: stacked setback tiers, each with its own UV scale so windows never stretch. */
  const towerAt = (x, z, w, d, h, variant, hue, yaw) => {
    const bat = new B(winTex(variant, hue), { cast: true, receive: true });
    let y = 0, cw = w, cd = d, rem = h;
    const tiers = rng.int(2, 4);
    for (let t = 0; t < tiers; t++) {
      const th = t === tiers - 1 ? rem : rem * rng.range(0.42, 0.66);
      const uW = Math.max(1, Math.round(cw / 12)), uD = Math.max(1, Math.round(cd / 12));
      const vR = Math.max(1, Math.round(th / 26));
      for (const [ax, az, l, ry] of [
        [0, 1, cw, 0], [0, -1, cw, Math.PI], [1, 0, cd, Math.PI / 2], [-1, 0, cd, -Math.PI / 2],
      ]) {
        const pg = new THREE.PlaneGeometry(l, th);
        const uv = pg.attributes.uv;
        const u0 = rng.next(), v0 = rng.next();
        for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * (ax ? uD : uW), v0 + uv.getY(i) * vR);
        uv.needsUpdate = true;
        bat.add(pg, x + (ax ? ax * cw / 2 : 0) * Math.cos(yaw) + (az ? az * cd / 2 : 0) * Math.sin(yaw),
          y + th / 2,
          z - (ax ? ax * cw / 2 : 0) * Math.sin(yaw) + (az ? az * cd / 2 : 0) * Math.cos(yaw),
          yaw + ry);
      }
      trim.add(box(cw + 1.4, 0.9, cd + 1.4), x, y + th, z, yaw);
      gold.add(box(cw + 2.0, 0.34, 0.3), x, y + th + 0.6, z + cd / 2 + 0.9, yaw);
      gold.add(box(cw + 2.0, 0.34, 0.3), x, y + th + 0.6, z - cd / 2 - 0.9, yaw);
      y += th; rem -= th;
      cw *= rng.range(0.62, 0.82); cd *= rng.range(0.62, 0.82);
    }
    bat.into(g);
    return { y, cw, cd };
  };

  // the deco flagship, dead centre and tallest, with a stepped crown and a needle
  {
    const top = towerAt(0, 0, 30, 26, 62, 0, 1, 0.1);
    let cy = top.y, cw2 = top.cw;
    for (let i = 0; i < 5; i++) {
      gold.add(cyl(cw2 * 0.46, cw2 * 0.52, 2.4, 12), 0, cy + 1.2, 0);
      trim.add(cyl(cw2 * 0.40, cw2 * 0.46, 2.6, 12), 0, cy + 3.6, 0);
      cy += 5.0; cw2 *= 0.76;
    }
    trim.add(cyl(0.35, 1.4, 26, 8), 0, cy + 13, 0);
    mag.add(cyl(0.7, 0.7, 6, 8), 0, cy + 6, 0);
  }
  // supporting towers in a tight cluster
  // hue 1 = gold-dominant windows. A pocket Manhattan reads WARM; leaving these on magenta made
  // the right half of every frame one colour.
  const spots = [
    [-46, 16, 22, 20, 44, 1, 1, 0.5], [42, -14, 24, 22, 50, 2, 1, -0.4],
    [-30, -40, 20, 18, 36, 1, 2, 0.9], [34, 40, 26, 20, 40, 0, 1, 0.2],
    [-62, -18, 18, 18, 30, 2, 1, -0.8], [58, 26, 18, 16, 34, 1, 0, 1.2],
    [4, 56, 22, 18, 28, 2, 1, -0.2],
  ];
  for (const [x, z, w, d, h, v, hue, yaw] of spots) towerAt(x, z, w, d, h, v, hue, yaw);

  // --- the coaster ribbon threading the cluster ---
  {
    const pts = [];
    const K = 14;
    for (let i = 0; i < K; i++) {
      const a = (i / K) * Math.PI * 2;
      const r = 74 + Math.sin(a * 3) * 16;
      pts.push(new THREE.Vector3(
        Math.cos(a) * r, 20 + Math.sin(a * 2 + 0.6) * 14 + (i === 4 ? 26 : 0), Math.sin(a) * r * 0.82,
      ));
    }
    const curve = new THREE.CatmullRomCurve3(pts, true, 'catmullrom', 0.5);
    const railMat = emissive(MAGENTA, 3.0);
    const rail = new THREE.Mesh(new THREE.TubeGeometry(curve, 220, 0.55, 6, true), railMat);
    g.add(rail);
    const ties = new B(steel('#2a2038'));
    for (let i = 0; i < 90; i++) {
      const p = curve.getPointAt(i / 90);
      ties.add(box(3.0, 0.3, 0.3), p.x, p.y - 0.9, p.z, (i / 90) * 6.28);
      if (i % 6 === 0) ties.add(cyl(0.32, 0.5, p.y, 6), p.x, p.y / 2, p.z);
    }
    ties.into(g);
  }

  // --- Liberty on a plinth ---
  {
    const S = new THREE.Group();
    const stone = new B(mat('vegas-lib', () => new THREE.MeshStandardMaterial({
      color: 0x2b4a44, roughness: 0.72, metalness: 0.2,
      emissive: new THREE.Color('#2fe0ff'), emissiveIntensity: 0.35,
    })), { cast: true });
    const base = new B(steel('#241b2e'), { cast: true });
    base.add(box(15, 9, 15), 0, 4.5, 0);
    base.add(box(17, 1.2, 17), 0, 9.4, 0);
    base.add(box(11, 5, 11), 0, 12.2, 0);
    // robe
    stone.add(cyl(3.0, 5.4, 17, 12), 0, 23, 0);
    stone.add(cyl(2.0, 3.0, 4, 10), 0, 33.4, 0);
    stone.add(new THREE.SphereGeometry(1.7, 10, 8), 0, 36.4, 0);
    // raised arm + torch
    stone.add(box(1.3, 10, 1.3), 3.4, 39, 0, 0, { rz: -0.32 });
    stone.add(cyl(0.9, 1.4, 2.4, 8), 5.6, 44.6, 0);
    const flame = new THREE.Mesh(new THREE.ConeGeometry(1.5, 4.2, 8), tube(GOLD));
    flame.position.set(5.6, 47.6, 0);
    flame.userData.noMerge = true;
    S.add(flame);
    // tablet
    stone.add(box(1.0, 4.2, 3.0), -3.6, 30, 1.2, 0, { rz: 0.42 });
    // crown spikes
    for (let i = 0; i < 7; i++) {
      const a = -1.1 + (i / 6) * 2.2;
      stone.add(box(0.36, 3.4, 0.36), Math.sin(a) * 2.2, 38.6, Math.cos(a) * 2.2, 0,
        { rz: -Math.sin(a) * 0.5, rx: Math.cos(a) * 0.3 });
    }
    stone.into(S); base.into(S);
    S.position.set(-86, 0, 52);
    S.rotation.y = 0.9;
    g.add(S);
  }

  trim.into(g); gold.into(g); mag.into(g);
  const l = new THREE.PointLight(new THREE.Color(MAGENTA), 90, 220, 2);
  l.position.set(0, 30, 0);
  g.add(l);
  return g;
}

/**
 * Search / sky-tracker lights: paired beams raking the black sky above the Strip. Cheap
 * (two cones of additive geometry each) and they are the single strongest "this is Vegas at
 * night" cue after the pyramid beam, because they give the black sky something in it.
 */
function skyTracker({ color = CYAN, len = 460, tilt = 0.5, seed = 1 }) {
  const g = new THREE.Group();
  const m = mat(`beam|${color}`, () => new THREE.MeshBasicMaterial({
    color: new THREE.Color(color), transparent: true, opacity: 0.042,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
  }));
  const geo = cyl(len * 0.030, 1.0, len, 10, true);
  geo.translate(0, len / 2, 0);
  const beam = new THREE.Mesh(geo, m);
  beam.rotation.z = tilt;
  beam.userData.noMerge = true;
  g.add(beam);
  const head = new THREE.Mesh(new THREE.SphereGeometry(1.5, 10, 8), tube(color));
  head.userData.noMerge = true;
  g.add(head);
  const rng = new RNG(seed * 37 + 2);
  const sweep = rng.range(0, 6.28);
  ANIMS.push((t) => {
    beam.rotation.y = Math.sin(t * 0.28 + sweep) * 0.9;
    beam.rotation.z = tilt + Math.sin(t * 0.19 + sweep * 1.7) * 0.22;
  });
  const st = new B(steel('#1e1828'));
  st.add(cyl(0.6, 0.9, 2.4, 8), 0, -1.2, 0);
  st.into(g);
  return g;
}

// ---------------------------------------------------------------- route

// THE STRIP is five collinear control points, so `longestStraight()` always finds it and every
// landmark can be sited on its axis. Then: a fast constant-radius right sweeper, a back straight
// broken by a chicane, and a tight west-end hairpin back onto the boulevard.
const MAIN = [
  [-300, 0], [-140, 0], [20, 0], [180, 0], [340, 0],          // THE STRIP — 727 m dead straight
  [500, 30], [610, 130], [655, 260], [620, 385],              // long fast constant-radius right
  [510, 458], [365, 470],                                     // sweeper exit
  [250, 428], [160, 486],                                     // chicane: a hard right-left flick
  [30, 480], [-120, 470], [-270, 462],                        // back straight
  [-400, 430], [-520, 340], [-556, 205], [-478, 92], [-370, 32], // west-end hairpin
];

const TRACK = {
  width: 12,
  surface: { tint: '#191720', lanes: 4, centerLine: 'double-yellow', worn: 0.42 },
  bank: 0.05,
  sidewalkWidth: 5.4,
  sidewalkTint: '#4a4054',
  crossings: 6,
  main: MAIN,
  branches: [],
};

// One preliminary Track so branch mouths, landmark sites and block exclusion zones can all be
// derived from real arc length instead of guessed at. buildCity() builds its own Track from the
// same def later; this one only ever reads geometry.
const T0 = new Track(TRACK);
const LEN = T0.length;
const U = (m) => (((m / LEN) % 1) + 1) % 1;

/**
 * Points for a branch that cuts the corner between two positions on the lap: the straight chord
 * between them, pulled a further `inset` metres toward the centre of curvature at the apex. Doing
 * it from arc length rather than typed coordinates means a control point can move without a
 * shortcut silently ending up in a building.
 */
function cornerCut(m0, m1, inset = 0, n = 2) {
  const a = T0.at(U(m0)).pos, b = T0.at(U(m1)).pos;
  const mu = U((m0 + m1) / 2);
  const inward = T0.at(mu).right.clone().multiplyScalar(Math.sign(T0.turnRate(mu)) || 1);
  const out = [];
  for (let i = 1; i <= n; i++) {
    const t = i / (n + 1);
    const p = a.clone().lerp(b, t).addScaledVector(inward, inset * Math.sin(t * Math.PI));
    out.push([p.x, p.z]);
  }
  return out;
}

TRACK.branches = [
  // A: the long cut across the inside of the fast sweeper, under a lit porte-cochère
  { kind: 'shortcut', enterU: U(820), exitU: U(1180), width: 7.5, points: cornerCut(820, 1180, 42, 3) },
  // B: the service alley that skips the chicane entirely
  { kind: 'shortcut', enterU: U(1500), exitU: U(1800), width: 6.5, points: cornerCut(1500, 1800, 0, 2) },
  // C: a chevroned kicker over the forecourt on the entry to the west hairpin
  { kind: 'ramp', enterU: U(2250), exitU: U(2470), width: 8, rise: 9, points: cornerCut(2250, 2470, 40, 2) },
];

// ---------------------------------------------------------------- landmark siting

let SITE = null;
/**
 * Everything hero-scale is placed in the Strip's own frame: `fwd` metres down the boulevard
 * from the landmark camera, `lat` metres to the driver's right. That way the composition is a
 * property of the road, and moving a control point cannot silently un-frame the pyramid.
 */
function site() {
  if (SITE) return SITE;
  const track = new Track(TRACK);              // with branches, so their corridors can be kept clear
  const st = track.longestStraight();
  const camM = st.u1 * LEN - 470;              // ~470 m of boulevard still ahead of the camera
  const camU = U(camM);
  const c = track.at(camU);
  const origin = c.pos.clone();
  const axis = c.tan.clone().setY(0).normalize();
  const right = c.right.clone().setY(0).normalize();
  const at = (fwd, lat) => origin.clone()
    .addScaledVector(axis, fwd).addScaledVector(right, lat).setY(0);
  const yaw = Math.atan2(-axis.x, -axis.z);    // facing back down the road at the driver

  SITE = {
    camU, camM, origin, axis, right, yaw, at,
    // fwd = metres down the boulevard from the camera, lat = metres to the driver's right.
    // Left of the road is open desert, so the two tallest things live there; the road itself
    // sweeps right, so the right-hand landmarks sit inside the bend where the track passes them.
    // Screen-space matters as much as world-space here: the HUD's standings plate owns the top
    // left of the frame out to x≈300, so nothing hero-scale is sited where it would land under it.
    pyramid: at(700, -215),
    tower: at(810, 280),
    eiffel: at(520, 330),
    replica: at(340, 165),
    fountainM: camM + 150,
    fountainLat: 62,
    marqueeM: camM + 230,
    trackers: [at(330, -195), at(700, 200)],
  };
  // Nothing gets built inside a landmark footprint...
  SITE.clear = [
    { pos: SITE.pyramid, r: 262, kind: 'none' },
    { pos: SITE.eiffel, r: 82, kind: 'none' },
    { pos: SITE.tower, r: 95, kind: 'none' },
    { pos: SITE.replica, r: 148, kind: 'none' },
    { pos: at(150, 62), r: 100, kind: 'none', side: 1 },
  ];
  // ...and nothing tall gets built inside the cone a hero is seen down. The cone is aimed at the
  // LANDMARK, not down the road: a kerbside tower only occludes the pyramid while it happens to
  // share the pyramid's bearing, which on this route is a 260 m stretch of the left kerb, not the
  // whole boulevard. Keeping the cone tight is what leaves the neon canyon standing.
  SITE.vistas = [
    { from: origin, dir: SITE.pyramid.clone().sub(origin).setY(0).normalize(), cos: Math.cos(0.19), len: 900 },
    { from: origin, dir: SITE.tower.clone().sub(origin).setY(0).normalize(), cos: Math.cos(0.14), len: 640 },
  ];
  // ...and the shortcut corridors stay empty so a branch never runs through a lobby.
  SITE.branchPts = [];
  for (const b of track.branches) for (const s of b.samples) SITE.branchPts.push(s.pos);
  return SITE;
}

// ---------------------------------------------------------------- city definition

export const def = {
  id: 'vegas',
  name: 'LAS VEGAS',
  seed: 202,
  spawnU: 0.0,
  laps: 3,
  record: '2:24:60',
  night: true,
  landmarkSet: null,                 // this file owns the landmarks; see landmarks() below
  get landmarkU() { return site().camU; },

  look: {
    accent: GOLD,
    lampColor: '#ffcf7a',
    wet: 0.86,
    wetLook: {
      strength: 0.30, gain: 1.5, threshold: 0.72, knee: 3.2, spread: 0.012,
      patch: 0.62, fresnel: 2.6,
    },
    sidewalk: '#4a4054',
    // Vegas has no key light to speak of, so an unlit wall gets NOTHING from the rig and reads
    // as a hole punched in the frame (the drift capture was half filled by one). This is the
    // omnidirectional floor that keeps those faces at a dim violet instead of at black.
    shadowTint: '#3d1e5e',
    shadowFill: 0.92,
    groundGlow: 7.00,
    sky: {
      // Black desert sky. The horizon carries a low bruise of city-glow and nothing else — the
      // glow disc in skyCanvas() is 42% of the dome's height, so a bright `sunColor` here washes
      // the entire upper sky magenta and the stars vanish, which is the opposite of the brief.
      top: '#01010a', horizon: '#0d0620', ground: '#08050f', haze: '#2c0d2c',
      sunDir: [0.85, -0.06, 0.5], sunColor: '#5e1240', clouds: 0.0, stars: 1.5, seed: 202,
    },
    sun: { color: '#9a58e0', intensity: 0.26, dir: [0.35, 0.8, -0.45] },
    ambient: {
      sky: '#46296a', ground: '#281540', intensity: 0.95,
      fill: { color: GOLD, intensity: 0.26, dir: [-0.6, 0.25, 0.7] },
    },
    fog: { color: '#1a0a2c', near: 130, far: 2000 },
    ground: { color: '#7c5ea0', accent: '#9c6ec4' },
    grade: {
      uSaturation: 1.42, uExposure: 1.04, uContrast: 1.16,
      uLift: '#0d0418', uGain: '#ffe4ff', uVignette: 0.34,
    },
    bloom: { strength: 1.26, radius: 0.72, threshold: 0.57 },
  },

  track: TRACK,

  blocks: {
    spacing: 46, offset: 25, jitter: 9, spacingJitter: 0.34,
    minW: 18, maxW: 44, minH: 30, maxH: 140,
    // near-black violet masonry: at night these are only ever seen by their own window light
    wallColors: ['#3a2c50', '#2c2242', '#4a3660', '#332747', '#54407a'],
    glassColors: ['#1a1030', '#101a30', '#20132c'],
    litColors: [GOLD, CYAN, MAGENTA],
    neonColors: [MAGENTA, GOLD, CYAN],
    lowColors: ['#4c3866', '#3a2c50', '#5a4278'],
    signs: ['CASINO', 'JACKPOT', 'SLOTS', '24 HRS', 'LUCKY', 'CHAPEL', 'PAWN', 'BUFFET', 'ACES'],
    litRatio: 0.66, setbackChance: 0.34, accentChance: 0.78, fireEscapeChance: 0.10,
    pick: (r, s, side) => {
      const S = site();
      const p = s.pos;
      for (const z of S.clear) {
        if (z.side !== undefined && z.side !== side) continue;
        if (p.distanceToSquared(z.pos) < z.r * z.r) return z.kind;
      }
      for (const q of S.branchPts) if (p.distanceToSquared(q) < 30 * 30) return 'none';
      for (const v of S.vistas) {
        const dx = p.x - v.from.x, dz = p.z - v.from.z;
        const d = Math.hypot(dx, dz);
        if (d < 40 || d > v.len) continue;
        if ((dx * v.dir.x + dz * v.dir.z) / d > v.cos) return 'low';
      }
      return r.bool(0.30) ? 'low' : 'tower';
    },
  },

  props: {
    lampStyle: 'colonial', lampSpacing: 32, lampHeight: 9.5, lampTwin: true,
    lampBanners: HUES,
    palms: true, palmSpacing: 34,
    barriers: false,
    treeColors: ['#2f5f4a'],
    hydrantColor: '#c8a02a',
    planterColor: '#3a2c4c',
    carColors: ['#c8a02a', '#8f2f7a', '#2f6a8f', '#2a2230', '#a8a2b0'],
    streetNames: ['LAS VEGAS BLVD', 'FREMONT ST', 'PARADISE RD', 'FLAMINGO RD', 'TROPICANA AVE'],
    furnitureKinds: ['hydrant', 'trash', 'bench', 'newsbox', 'sign', 'planter', 'cones',
      'shelter', 'mailbox', 'bollards', 'cart'],
    billboards: [
      { u: U(120), side: 1, text: 'VIVA', sub: 'NITRO', color: MAGENTA, offset: 20 },
      { u: U(690), side: -1, text: 'ALL IN', sub: 'NO LIMIT', color: GOLD, offset: 22 },
      { u: U(1360), side: 1, text: 'ROYALE', sub: 'CASINO', color: CYAN, offset: 20 },
      { u: U(1980), side: -1, text: 'JACKPOT', sub: 'MEGA', color: GOLD, offset: 24 },
      { u: U(2760), side: 1, text: 'HIGH ROLLER', sub: '24 HRS', color: MAGENTA, offset: 22 },
    ],
    gates: [
      { u: U(620), color: MAGENTA }, { u: U(1100), color: GOLD },
      { u: U(1720), color: CYAN }, { u: U(2560), color: MAGENTA },
    ],
    boostPads: [
      { u: U(100), lateral: 0 }, { u: U(560), lateral: -0.42 },
      { u: U(1280), lateral: 0.4 }, { u: U(1860), lateral: -0.35 },
      { u: U(2700), lateral: 0 },
    ],
  },

  // Far band. Pushed out to 1500 m so it sits clearly BEHIND the pyramid rather than beside it,
  // and held lighter than the fog it stands in — at #1c1230 the near ring came through as black
  // slabs punched into the sky, which is worse than no far band at all.
  skyline: {
    radius: 1500, count: 62, minH: 40, maxH: 165, spread: 420,
    palette: ['#3c2a5e', '#4a3070', '#2e2048'], accent: MAGENTA,
  },

  /**
   * Everything the kit does not have a generic answer for. Order matters only for readability;
   * all of it is merged by chunk afterwards.
   */
  landmarks({ track, rng }) {
    const out = [];
    const S = site();
    const push = (o, pos, yaw = S.yaw) => {
      o.position.copy(pos);
      o.rotation.y = yaw;
      if (o.userData.anims) ANIMS.push(...o.userData.anims);
      out.push(o);
      return o;
    };

    // ---- HERO 1: the glass pyramid, closing the corridor at the end of the Strip ----
    push(glassPyramidLV({ h: 200, base: 270, seed: 3 }), S.pyramid, S.yaw + 0.18);
    // The kit's beam is a whisper at this distance. Give it a hard bright core, a wide soft
    // sheath and a lamp house at the apex, so the thing the city is famous for is actually the
    // brightest object in the sky.
    {
      const core = new THREE.Mesh(
        (() => { const gm = cyl(1.6, 5.5, 1500, 14, true); gm.translate(0, 750, 0); return gm; })(),
        mat('pyr-core', () => new THREE.MeshBasicMaterial({
          color: new THREE.Color('#f2fbff'), transparent: true, opacity: 0.32,
          blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
        })),
      );
      const sheath = new THREE.Mesh(
        (() => { const gm = cyl(9, 24, 1500, 16, true); gm.translate(0, 750, 0); return gm; })(),
        mat('pyr-sheath', () => new THREE.MeshBasicMaterial({
          color: new THREE.Color('#bfe0ff'), transparent: true, opacity: 0.055,
          blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
        })),
      );
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(6.5, 14, 10),
        mat('pyr-lamp', () => new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false })));
      for (const m of [core, sheath, lamp]) {
        m.userData.noMerge = true;
        m.position.copy(S.pyramid).setY(m === lamp ? 203 : 201);
        out.push(m);
      }
      ANIMS.push((t) => {
        core.material.opacity = 0.28 + 0.07 * Math.sin(t * 1.7);
        sheath.material.opacity = 0.048 + 0.018 * Math.sin(t * 1.1 + 1.2);
      });
      const pl = new THREE.PointLight(0xcfe8ff, 160, 400, 2);
      pl.position.copy(S.pyramid).setY(150);
      out.push(pl);
    }

    // ---- HERO 2: the observation tower, inside the sweeper, seen from most of the lap ----
    push(landmarkTower({
      h: 262, w: 30, crown: 'pod', night: true, cache: CACHE, seed: 21,
      wall: '#2e2440', glass: '#1a1430', litColor: GOLD, accent: CYAN,
      litRatio: 0.55, style: 'modern', flood: '#ffd9a0',
    }), S.tower, S.yaw + 0.5);

    // ---- HERO 3: the Eiffel replica, on the left of the boulevard ----
    push(eiffelReplica({ h: 175, seed: 5 }), S.eiffel, S.yaw + 0.4);

    // ---- HERO 4: the replica skyline + coaster + Liberty ----
    push(replicaSkyline({ seed: 13 }), S.replica, S.yaw - 0.35);

    // ---- HERO 5: WELCOME TO FABULOUS LAS VEGAS, arched over the boulevard ----
    {
      const u = U(S.marqueeM);
      const s = track.at(u);
      const m = marqueeArch({
        span: track.halfWidth * 4.6, h: 15, cache: CACHE, night: true,
        color: '#ffe9b0', accent: GOLD, text: 'FABULOUS', sub: 'LAS VEGAS',
      });
      m.position.copy(s.pos);
      // +PI so the SIGN FACE meets the oncoming driver. marqueeArch puts its board's front on
      // local +Z and its steel backing frame at z=-0.85; aligned with the tangent, a driver
      // approaching from behind therefore sees the backing box and a mirrored sign.
      m.rotation.y = Math.atan2(s.tan.x, s.tan.z) + Math.PI;
      if (m.userData.anims) ANIMS.push(...m.userData.anims);
      out.push(m);
    }

    // ---- HERO 6: the dancing fountains, right of the boulevard ----
    {
      const u = U(S.fountainM);
      const s = track.at(u);
      const f = fountainLake({ len: 152, wid: 64, seed: 9 });
      f.position.copy(s.pos).addScaledVector(s.right, S.fountainLat).setY(0.1);
      // -90° so the lake's LONG axis runs down the boulevard rather than across it
      f.rotation.y = Math.atan2(s.tan.x, s.tan.z) - Math.PI / 2;
      out.push(f);
      // a colonnade behind the water so the lake has a facade to reflect
      const col = new B(steel('#2e2440'), { cast: true });
      const cg = new B(emissive(GOLD, 2.0), { cast: false });
      for (let i = -6; i <= 6; i++) {
        const p = s.pos.clone()
          .addScaledVector(s.tan, i * 13)
          .addScaledVector(s.right, S.fountainLat + 52);
        col.add(cyl(1.05, 1.3, 13, 9), p.x, 6.5, p.z);
        col.add(box(3.0, 1.2, 3.0), p.x, 13.5, p.z);
        cg.add(box(2.4, 0.4, 2.4), p.x, 14.3, p.z);
      }
      const holder = new THREE.Group();
      col.into(holder); cg.into(holder);
      out.push(holder);
    }

    // ---- sky trackers ----
    for (const [i, p] of S.trackers.entries()) {
      const tr = skyTracker({ color: HUES[i % 3], len: 520, tilt: 0.32 + i * 0.14, seed: i + 1 });
      tr.position.copy(p).setY(2);
      out.push(tr);
    }

    // ---- THE NEON CANYON: pylons and blade marquees down both kerbs ----
    {
      const pr = rng.fork(77);
      let n = 0;
      for (const side of [-1, 1]) {
        for (const s of track.scatter({
          side, minGap: 26, maxGap: 60, offset: 13 + pr.range(0, 6),
          offsetJitter: 4.0, rng: rng.fork(side * 11 + 5),
        })) {
          // never inside a landmark footprint
          let blocked = false;
          for (const z of S.clear) {
            if (z.side !== undefined && z.side !== side) continue;
            if (s.pos.distanceToSquared(z.pos) < (z.r * 0.82) ** 2) { blocked = true; break; }
          }
          if (blocked) continue;
          const tall = pr.bool(0.64);
          const hgt = tall ? pr.range(16, 38) : pr.range(7.5, 13);
          const hue = tall ? (n + (side > 0 ? 1 : 0)) % 3 : (n * 2 + 1) % 3;
          const o = tall
            ? neonPylon({
              h: hgt, bw: pr.range(6.5, 12), seed: n * 7 + 3, index: n,
              hue, crown: (n * 3 + side) % 4,
            })
            : bladeSign({
              h: hgt, w: pr.range(9, 15), seed: n * 11 + 5, index: n, hue,
            });
          o.position.copy(s.pos).setY(s.pos.y + 0.18);
          o.rotation.y = Math.atan2(s.tan.x, s.tan.z) + side * Math.PI / 2 + pr.range(-0.14, 0.14);
          out.push(o);
          // ...and its reflection. A 38 m pylon throws a smear most of the way to the next
          // block; a blade marquee at 8 m throws sixty metres of it. Length, width and tier all
          // scale off the source so the road reads the street back at you.
          reflect(track, {
            m: s.u * LEN, side,
            len: (tall ? 48 : 30) + hgt * 2.0,
            variant: tall ? 1 : 0,
            tier: tall ? (hgt > 27 ? 0 : 1) : (pr.bool(0.45) ? 1 : 2),
            color: HUES[hue],
            lat0: 0.80 - pr.range(0, 0.10), lat1: 0.24 + pr.range(0, 0.22),
            half0: tall ? 0.20 : 0.15, half1: tall ? 0.17 : 0.12,
            segs: 22, mirror: pr.bool(0.5),
          });
          n++;
        }
      }
    }

    // ---- gutters: a continuous glossy run down both kerb lines ----
    // The kerb is where every sign's spill pools, and round 1's whole lower-left quadrant was a
    // featureless gradient because nothing lived there. Overlapping segments of jittered length,
    // hue and ripple layout — never a repeating period the eye can lock onto.
    {
      const gr = rng.fork(419);
      for (const side of [-1, 1]) {
        let m = gr.range(0, 40);
        let k = 0;
        while (m < LEN) {
          const seg = gr.range(38, 78);
          reflect(track, {
            m: m + seg, side, len: seg * 1.05,
            variant: gr.pick([2, 5, 6]),
            tier: gr.bool(0.35) ? 2 : 3,
            color: HUES[(k + (side > 0 ? 1 : 2)) % 3],
            lat0: 0.84, lat1: 0.70, half0: 0.14, half1: 0.12,
            segs: 10, mirror: gr.bool(0.5),
          });
          m += seg * gr.range(0.78, 0.94);
          k++;
        }
      }
    }

    // ---- overhead sources lay a BAND across the road, not a line down it ----
    for (const gt of def.props.gates || []) {
      reflect(track, {
        m: gt.u * LEN, side: 1, len: 58, variant: 4, tier: 1, color: gt.color,
        lat0: 0.02, lat1: 0.0, half0: 0.94, half1: 0.62, segs: 12,
      });
    }
    for (const bb of def.props.billboards || []) {
      reflect(track, {
        m: bb.u * LEN, side: bb.side, len: 78, variant: 0, tier: 1, color: bb.color,
        lat0: 0.78, lat1: 0.30, half0: 0.22, half1: 0.17, segs: 16,
      });
    }

    // ---- road furniture the kit does not place: barriers where the racing line needs them ----
    // A broken run of barrier at each shortcut mouth is what makes the shortcut READ as an
    // opening rather than as a hole (§6.4 "visible as opportunities").
    {
      const br = rng.fork(53);
      // Sides matter: both bends here turn toward +right, so the OUTSIDE — the side a wall
      // actually belongs on — is side -1. Walling the inside instead would have bricked up the
      // mouth of shortcut A.
      const runs = [
        { m0: 800, m1: 1240, side: -1, gapAt: null },      // outside of the fast sweeper
        { m0: 2430, m1: 2720, side: -1, gapAt: null },      // outside of the west hairpin
        // the alley mouth: a wall with a hole knocked in it, right where shortcut B leaves
        { m0: 1400, m1: 1580, side: 1, gapAt: [1486, 1534] },
      ];
      for (const run of runs) {
        for (let m = run.m0; m < run.m1; m += 4.1) {
          if (run.gapAt && m > run.gapAt[0] - 6 && m < run.gapAt[1] + 6) {
            if (m > run.gapAt[0] && m < run.gapAt[1]) continue;
            // knocked-over units either side of the hole
            const s = track.at(U(m));
            const b = waterBarrier({ len: 2.0, cache: CACHE, seed: (m | 0), color: GOLD });
            b.position.copy(s.pos).addScaledVector(s.right, run.side * (track.halfWidth + 1.1)).setY(0.1);
            b.rotation.y = Math.atan2(s.tan.x, s.tan.z) + br.range(-0.7, 0.7);
            b.rotation.z = br.bool(0.5) ? 1.4 : 0;
            out.push(b);
            continue;
          }
          if (br.bool(0.05)) continue;
          const s = track.at(U(m));
          const roll = br.next();
          const b = roll < 0.10
            ? waterBarrier({ len: 2.0, cache: CACHE, seed: (m | 0) * 3, color: MAGENTA })
            : roll < 0.14
              ? trafficCones({ cache: CACHE, seed: (m | 0) * 5, n: br.int(2, 3) })
              : jerseyBarrier({ len: 4, cache: CACHE, seed: (m | 0) * 7 });
          b.position.copy(s.pos)
            .addScaledVector(s.right, run.side * (track.halfWidth + 1.15))
            .setY(s.pos.y + br.range(-0.03, 0.02));
          b.rotation.y = Math.atan2(s.tan.x, s.tan.z) + br.range(-0.03, 0.03);
          b.scale.setScalar(br.range(0.97, 1.04));
          out.push(b);
        }
      }
    }

    // ---- lit alley mouths: a neon arch and chevrons at BOTH ends of every shortcut ----
    // Round 1's drift capture came out with the car sitting in an unlit forecourt at the far end
    // of shortcut A, because the kit only dresses a branch's entry. Portals at both ends plus a
    // run of light pools down the ribbon means the route reads as an invitation from either
    // direction and the corridor is never a black lot (§6.4 "visible as opportunities").
    for (const [i, b] of track.branches.entries()) {
      const t0 = clamp((track.halfWidth + 13) / b.length, 0.03, 0.4);
      const col = HUES[i % 3];
      // gold pools down the length of the shortcut
      for (let k = 1; k <= 6; k++) {
        const t = t0 + (1 - 2 * t0) * (k / 7);
        const pp = b.curve.getPointAt(t);
        const pt = b.curve.getTangentAt(t).normalize();
        const pool = new THREE.Mesh(
          new THREE.PlaneGeometry(b.halfWidth * 3.4, b.halfWidth * 5.0), spillMaterial(GOLD),
        );
        pool.rotation.x = -Math.PI / 2;
        pool.rotation.z = -Math.atan2(pt.x, pt.z);
        pool.position.copy(pp).setY(pp.y + b.riseAt(t) + 0.09);
        pool.renderOrder = 4;
        out.push(pool);
      }
      for (const [end, tt] of [[0, t0], [1, 1 - t0]]) {
        const p = b.curve.getPointAt(tt);
        const tan = b.curve.getTangentAt(tt).normalize().multiplyScalar(end ? -1 : 1);
        const g = new THREE.Group();
        const tb = new B(tube(col));
        const hb = new B(halo(col, 0.11));
        const cb = chaseBatch(col, i / 3);
        const st = new B(steel('#1e1828'));
        const W = b.halfWidth * 2.1;
        // a squared neon portal
        for (const sx of [-1, 1]) {
          tb.add(box(0.5, 11, 0.5), sx * W / 2, 5.5, 0);
          st.add(box(1.2, 11.4, 1.2), sx * W / 2, 5.7, -0.5);
          chaseStrip(cb, 11, sx * W / 2, 5.5, 0.5, 0, { rz: Math.PI / 2, w: 1.0 });
        }
        tb.add(box(W + 1.0, 0.5, 0.5), 0, 11, 0);
        chaseStrip(cb, W + 1, 0, 11.6, 0.5);
        hb.add(new THREE.PlaneGeometry(W * 1.7, 18), 0, 6.5, 1.4);
        // ground-level chevrons pointing into the mouth
        const chev = new B(emissive(GOLD, 2.8), { cast: false });
        for (let k = 0; k < 5; k++) {
          const z = 2.5 + k * 3.6;
          for (const sx of [-1, 1]) {
            chev.add(box(0.75, 0.16, W * 0.40), sx * W * 0.15, 0.16, z, sx * 0.60);
          }
        }
        tb.into(g); cb.into(g); st.into(g); chev.into(g);
        const hm = hb.into(g); if (hm) hm.renderOrder = 3;
        if (!end) {
          const pl = new THREE.PointLight(new THREE.Color(col), 40, 60, 2);
          pl.position.set(0, 6, 2);
          g.add(pl);
        }
        g.position.copy(p).setY(p.y + b.riseAt(tt));
        g.rotation.y = Math.atan2(tan.x, tan.z);
        out.push(g);
      }
      // A lit cove down both kerbs of the corridor. The block generator keeps its footprints out
      // of a branch, so without this the shortcut is a black apron between two lit streets — and
      // the drift capture lands the car right in the middle of it.
      {
        const cove = new B(tube(col));
        const coveG = new B(emissive(GOLD, 2.6));
        const NC = Math.max(6, Math.round(b.length / 5.2));
        for (let k = 0; k <= NC; k++) {
          const t = lerp(t0 * 0.8, 1 - t0 * 0.8, k / NC);
          const p = b.curve.getPointAt(t);
          const tg = b.curve.getTangentAt(t).normalize();
          const rt = new THREE.Vector3().crossVectors(tg, _UP).normalize();
          const y = p.y + b.riseAt(t);
          const yaw = Math.atan2(tg.x, tg.z);
          for (const sx of [-1, 1]) {
            const q = p.clone().addScaledVector(rt, sx * b.halfWidth * 1.10);
            (k % 3 === 0 ? coveG : cove).add(box(0.34, 0.62, 3.6), q.x, y + 0.34, q.z, yaw);
          }
        }
        const holder = new THREE.Group();
        const m1 = cove.into(holder); const m2 = coveG.into(holder);
        for (const m of [m1, m2]) if (m) out.push(m);
      }
      // ...and the corridor floor reflects all of it, in three overlapping runs
      for (let k = 0; k < 3; k++) {
        const t = 1 - t0 - (1 - 2 * t0) * (k / 3);
        reflect(track, {
          branch: b, t0: t, len: b.length * 0.42,
          variant: k === 1 ? 2 : 5, tier: k === 1 ? 1 : 2,
          color: k === 1 ? GOLD : col,
          lat0: k % 2 ? 0.62 : -0.62, lat1: k % 2 ? 0.14 : -0.14,
          half0: 0.40, half1: 0.30, segs: 14,
        });
      }
      reflect(track, {
        branch: b, t0: t0 + 0.02, len: b.length * 0.30, variant: 4, tier: 1, color: col,
        lat0: 0, lat1: 0, half0: 0.92, half1: 0.60, segs: 10,
      });
      reflect(track, {
        branch: b, t0: 1 - t0 + 0.02, len: b.length * 0.30, variant: 4, tier: 2, color: col,
        lat0: 0, lat1: 0, half0: 0.92, half1: 0.60, segs: 10,
      });
      // the portal's own smear, so a shortcut mouth is visible in the road before it is in the air
      const bm = track.nearest(b.curve.getPointAt(t0)).u * LEN;
      reflect(track, {
        m: bm, side: 1, len: 70, variant: 4, tier: 1, color: col,
        lat0: 0.0, lat1: 0.0, half0: 0.90, half1: 0.55, segs: 12,
      });
    }

    // ---- HERO REFLECTIONS ----------------------------------------------------------------
    // The six landmarks are the brightest things in the world, so they own the road as much as
    // they own the skyline. Each lays a long smear down the boulevard on its own side — and the
    // pyramid's sky beam lays the one object in Vegas whose reflection runs the whole length of
    // the Strip: a razor line of white, 700 m of it, straight down the wet asphalt.
    {
      const mAt = (p) => track.nearest(p).u * LEN;
      const heroes = [
        // pyramid: 200 m of glass and gold arris, off to the driver's left
        { m: mAt(S.pyramid), side: -1, len: 320, variant: 1, tier: 0, color: GOLD,
          lat0: 0.86, lat1: 0.42, half0: 0.30, half1: 0.22, segs: 30 },
        // ...and its beam
        { m: mAt(S.pyramid), side: -1, len: 620, variant: 3, tier: 0, color: '#eaf6ff',
          lat0: 0.58, lat1: 0.26, half0: 0.17, half1: 0.13, segs: 34 },
        // observation tower, inside the sweeper on the right
        { m: mAt(S.tower), side: 1, len: 280, variant: 1, tier: 0, color: GOLD,
          lat0: 0.84, lat1: 0.38, half0: 0.26, half1: 0.19, segs: 26 },
        { m: mAt(S.tower), side: 1, len: 400, variant: 3, tier: 1, color: CYAN,
          lat0: 0.62, lat1: 0.24, half0: 0.19, half1: 0.14, segs: 26 },
        // Eiffel replica, right of the boulevard
        { m: mAt(S.eiffel), side: 1, len: 240, variant: 1, tier: 1, color: GOLD,
          lat0: 0.80, lat1: 0.34, half0: 0.24, half1: 0.18, segs: 24 },
        // the pocket Manhattan
        { m: mAt(S.replica), side: 1, len: 200, variant: 1, tier: 1, color: MAGENTA,
          lat0: 0.82, lat1: 0.36, half0: 0.28, half1: 0.20, segs: 20 },
        // the fountains: a wide cyan shimmer rather than a line, because the source is a lake
        { m: S.fountainM + 60, side: 1, len: 175, variant: 2, tier: 0, color: CYAN,
          lat0: 0.76, lat1: 0.30, half0: 0.40, half1: 0.26, segs: 20 },
        // the WELCOME arch is overhead: a band across the carriageway
        { m: S.marqueeM, side: 1, len: 78, variant: 4, tier: 0, color: '#ffd98a',
          lat0: 0.0, lat1: 0.0, half0: 0.96, half1: 0.58, segs: 14 },
        // the two sky trackers rake the road as well as the sky
        { m: mAt(S.trackers[0]), side: -1, len: 230, variant: 3, tier: 2, color: MAGENTA,
          lat0: 0.70, lat1: 0.32, half0: 0.21, half1: 0.15, segs: 20 },
        { m: mAt(S.trackers[1]), side: 1, len: 230, variant: 3, tier: 3, color: CYAN,
          lat0: 0.70, lat1: 0.32, half0: 0.21, half1: 0.15, segs: 20 },
      ];
      for (const h of heroes) reflect(track, h);
    }

    // One material per family, chunked, before the kit's own merge sees any of it.
    vcCollapse(out);
    reflFlush(out);
    return out;
  },
};

export function build(opts) {
  CACHE = new Map();
  ANIMS = [];
  SITE = null;
  REFL_BANK = null;
  FACE_ATLAS = null;
  const anims = ANIMS;
  const city = buildCity(def, { ...opts, night: true });
  const base = city.update;
  city.update = (t, camera) => {
    base(t, camera);
    for (let i = 0; i < anims.length; i++) anims[i](t);
  };
  return city;
}

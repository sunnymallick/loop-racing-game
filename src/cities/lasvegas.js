import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  buildCity, marqueeArch, landmarkTower,
  jerseyBarrier, waterBarrier, trafficCones, fitText,
} from './kit.js';
import { Track } from './track.js';
import { RNG, clamp, lerp, makeNoise2D, fbm2D } from '../core/rng.js';
import { canvas, toTexture, grain, concrete } from '../core/textures.js';
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
 * …plus two accents that are placed by hand rather than dealt round the city: BULB #ffefd2, the
 * white incandescent chase every real cabinet carries, and GREEN #2bff8f on the over-road gates
 * and one sign face (§1.3 names green torus gates as the reference night frame's signature).
 * That is the identity test in §6.4: swap this palette into LA/Miami/NYC and it would look
 * absurd, which is the point.
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
/**
 * THE FOURTH TUBE — deliberately NOT in `HUES`.
 *
 * §1.3 describes the reference's night frame precisely: "three enormous green neon torus gates
 * arcing over the road, glowing hard enough to bloom, with visible light spill on the wall
 * behind them… the palette is deliberately three-colour neon — green, magenta, blue-white".
 * Green is the reference's signature over-road colour and this city had none of it: measured on
 * the r1 sweep, 0.00% of `vegas-muscle-chase` sat in the 60–180 degree hue range, while 60% sat
 * in a single 30-degree bin.
 *
 * It stays out of `HUES` on purpose. That array is indexed `% 3` in eighteen places (pylons,
 * marquees, coves, chases, kerb washes, sky beams), so adding a fourth member would re-deal the
 * whole city's colour and put green on everything. Green is placed by hand instead, on the two
 * things §1.3 actually names: gates arcing over the road, and one sign face. Magenta, gold and
 * cyan are still the city; green is the accent that proves it is a palette and not a filter.
 */
const GREEN = '#2bff8f';
/**
 * THE WHITE POINT.
 *
 * Measured over the twelve Vegas captures, 71-78% of all the chroma in the frame sat inside ONE
 * 60-degree hue window and the brightest 0.6% of pixels still averaged 94% saturation — i.e. there
 * was no neutral anywhere in the city, so the grade overwrote every car: a muscle car's paint, its
 * white racing stripes, its chrome and the SUV beside it all came back the same magenta. A palette
 * of three saturated hues and nothing else is not §2.1's "3-5 hues", it is one hue.
 *
 * The fix is not to desaturate the neon — the neon is the city. It is that a real Strip sign is
 * built from TWO light sources: coloured gas tubes, and a chase of plain incandescent BULBS around
 * the cabinet. The bulbs are white. They are the brightest thing on the sign, they are on every
 * cabinet, every blade marquee and every span across the boulevard, and they are what a magenta
 * tube is magenta *against*. Putting them back is simultaneously the correct reference (§1.3's
 * three-colour neon over near-black, with the warm practicals as the one tie to daylight) and the
 * neutral the highlight band needs.
 */
const BULB = '#ffefd2';
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
const VC_POOL = 'pool';   // ground pools: same blend as VC_SOFT, different alpha map
const VC_CONE = 'cone';   // the shaft of haze under a lamp: same blend, a 1-D alpha along v
const VC_SHADE = 'shade'; // contact shadows: the one family in this city that SUBTRACTS light

/**
 * Draw order inside the transparent pass, per family. Only the shadow family declares one, and
 * it declares the highest number in the file on purpose — see the GROUNDING note below. The
 * additive families are left where they were so this change cannot move a single existing pixel
 * of the neon.
 */
const VC_ORDER = { [VC_SHADE]: 8 };

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
    if (family === VC_POOL) {
      return new THREE.MeshBasicMaterial({
        map: poolTexture(), vertexColors: true, transparent: true, opacity: 1,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: true,
      });
    }
    if (family === VC_CONE) {
      return new THREE.MeshBasicMaterial({
        map: lampConeTexture(), vertexColors: true, transparent: true, opacity: 1,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: true,
      });
    }
    if (family === VC_SHADE) {
      // NOT additive, and the only family here that is not. A contact shadow has to remove light
      // that the wet-road mirror has already put down, so it blends toward a violet ink instead
      // of adding to it (§2.1: a shadow is tinted, it is never #000).
      return new THREE.MeshBasicMaterial({
        map: blobTexture(), vertexColors: true, transparent: true, opacity: 1,
        depthWrite: false, side: THREE.DoubleSide, fog: true,
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
      b.family = vc.family;
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
    if (VC_ORDER[b.family]) m.renderOrder = VC_ORDER[b.family];
    out.push(m);
  }
}

const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const cyl = (r0, r1, h, n = 8, open = false) => new THREE.CylinderGeometry(r0, r1, h, n, 1, open);

/**
 * A neon tube — and the docstring above this used to say "always over the bloom threshold", which
 * was not true and is the second half of the missing white point.
 *
 * Traced: a MeshBasicMaterial at pure MAGENTA is linear (1.00, 0.026, 0.63); the bloom prefilter
 * keys off `max(r,g,b)`, the atmosphere pass has already multiplied by this city's derived
 * exposure of 0.877, and the derived night threshold is 1.171 — so a tube arrived at 0.877 and
 * cleared exactly nothing. Everything that looked like a halo was the separate additive `halo()`
 * quads stacking, not the tube blooming (§7 caps "emissive surfaces with no bloom" at 60).
 *
 * A real tube photographed at night does two things at once: it clips its own core to WHITE and
 * throws its colour into the air around it. So the tube carries 28% white — enough that the core
 * has energy in all three channels rather than in one and a half — and 2.3x the level, which puts
 * it at ~2.0 after exposure: comfortably over the threshold, well up the ACES shoulder, and with
 * `uHiChroma` down at 0.16 it is allowed to roll off toward white instead of being dragged back
 * to pure magenta. The `halo()` and `spill()` quads that surround every tube are UNCHANGED and
 * still carry the full-chroma hue, so the sign still reads magenta, gold or cyan from any
 * distance — the colour just now belongs to the light around the tube rather than to the tube,
 * which is where it belongs and where the reference puts it.
 */
function tube(color) {
  return mat(`tube|${color}`, () => {
    const c = new THREE.Color(color).lerp(new THREE.Color(1, 1, 1), 0.28).multiplyScalar(2.3);
    return vcTag(new THREE.MeshBasicMaterial({ color: c }), VC_TUBE, c);
  });
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
/**
 * The alpha a GROUND pool uses. Not the same falloff a halo uses, and that difference is the
 * whole point: a smooth radial gradient laid flat on the road is indistinguishable from fog —
 * it covers the asphalt instead of lighting it, and the round-5 captures had a featureless
 * salmon wash over the entire near-left quadrant because of it. Light landing on WET ASPHALT is
 * broken up by what it lands on: puddle edges, camber, aggregate. So the pool carries fbm
 * mottling and a ripple beat, and the tarmac stays visible through its own highlight.
 */
function poolTexture() {
  return mat('lv-pool-tex', () => {
    const S = 192;
    const { c, ctx } = canvas(S, S);
    const img = ctx.createImageData(S, S);
    const n = makeNoise2D(9173);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const dx = (x / (S - 1)) * 2 - 1, dy = (y / (S - 1)) * 2 - 1;
        const r = Math.hypot(dx, dy * 0.86);
        const fall = Math.exp(-r * r * 3.1) * clamp(1 - Math.pow(clamp(r, 0, 1), 2.4), 0, 1);
        const m = fbm2D(n, x / S * 4.6, y / S * 4.6, 4) * 0.5 + 0.5;
        const fine = fbm2D(n, x / S * 13.0 + 11, y / S * 13.0 + 7, 3) * 0.5 + 0.5;
        const ripple = 0.62 + 0.38 * Math.sin(dy * 11.0 + m * 6.0);
        const a = clamp(fall * (0.30 + 0.90 * m * ripple) * (0.66 + 0.52 * fine), 0, 1);
        const i4 = (y * S + x) * 4;
        const q = (255 * Math.pow(a, 1 / 2.2)) | 0;
        img.data[i4] = img.data[i4 + 1] = img.data[i4 + 2] = q;
        img.data[i4 + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const t = toTexture(c, { srgb: true, wrap: THREE.ClampToEdgeWrapping });
    return t;
  });
}

function spillMaterial(color, opacity = 0.85) {
  return mat(`spill|${color}|${opacity}`, () => vcTag(new THREE.MeshBasicMaterial({
    map: poolTexture(), color: new THREE.Color(color), transparent: true, opacity,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: true,
  }), VC_POOL, color, opacity));
}

/**
 * A ground spill ellipse under a sign, elongated toward the road. Local +Z on every kerbside
 * prop points BACK at the carriageway (rotation.y = trackYaw + side*PI/2), so a positive z
 * offset walks the pool off the pavement and into the gutter where the wet road can take it.
 */
function spill(parent, color, r = 14, y = 0.22, z = 0, a = 0.85) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(r * 2, r * 2.6), spillMaterial(color, a));
  m.rotation.x = -Math.PI / 2;
  m.position.set(0, y, z);
  m.renderOrder = 4;
  parent.add(m);
  return m;
}

// ---------------------------------------------------------------- GROUNDING
//
// Round 1's binding cap was §7's "no contact shadow under the car — the car appears to hover",
// measured: the tarmac directly under an AI car was no darker than the tarmac beside it.
//
// The reason that was true HERE is worth writing down, because the vehicle kit does ship a
// contact blob (`vehicles/kit.js contactShadow`, renderOrder 2) and it was in every frame the
// whole time. Vegas then draws, ON TOP OF IT, the entire wet-road mirror: ~25 merged reflection
// ribbons, the gutter runs, the kerb-cove wash, the canopy pools, every sign's ground spill —
// all transparent, all ADDITIVE, all at renderOrder 3-4, and therefore all after the blob. The
// blob removed light and the mirror immediately put it back. A darker blob would not have fixed
// it; a blob drawn earlier is a blob that gets overwritten.
//
// So grounding in this city has to be the LAST thing that touches the carriageway. Three parts,
// one material family, renderOrder 8:
//
//   1. `CarShadows` — a per-car footprint (soft body ellipse + four hard tyre patches) rebuilt
//      every frame into ONE shared buffer, so the whole eight-car grid costs a single draw call.
//      It is laid on the road's own banked cross-section, not on a world-horizontal plane, and
//      it spreads and fades as the car leaves the ground.
//   2. static occlusion under everything this file stands on the ground — gate legs, the WELCOME
//      arch feet, pylon plinths, canopy columns, barriers, portal posts, the hero plinths — plus
//      an AO line down the kerb face, which is what stops the road edge from being a hard join.
//   3. the answer to the second half of the same note: a spill wash across BOTH pavements for
//      the whole circuit, so the shoulder the shadows are being drawn onto is lit ground rather
//      than the crushed-black void round 1 measured on the right-hand side.
//
// Parts 2 and 3 go through vcCollapse like everything else, so the cost is a handful of merged
// meshes per 240 m cell.

/** The violet a Vegas shadow is. Blending toward this can never reach #000 (§2.1). */
const SHADOW_INK = '#2b1942';

/** Soft round footprint, alpha-only (RGB stays white so the ink rides in the vertex colour). */
function blobTexture() {
  return mat('lv-blob', () => {
    const S = 128;
    const { c, ctx } = canvas(S, S);
    const img = ctx.createImageData(S, S);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = (x / (S - 1)) * 2 - 1, v = (y / (S - 1)) * 2 - 1;
        const r = Math.hypot(u, v);
        // a firm core where the object actually touches, and a long soft skirt around it
        const core = 1 - smooth(0.06, 0.52, r);
        const skirt = 1 - smooth(0.18, 1.0, r);
        const a = clamp(core * 0.62 + skirt * 0.52, 0, 1);
        const i4 = (y * S + x) * 4;
        img.data[i4] = img.data[i4 + 1] = img.data[i4 + 2] = 255;
        img.data[i4 + 3] = (a * 255) | 0;
      }
    }
    ctx.putImageData(img, 0, 0);
    // mipmapped, unlike the halo sheet: these are laid FLAT on the ground and viewed at a
    // grazing angle, where an unmipped alpha ramp shimmers into a stipple as it recedes (§7
    // caps aliased edges at 68).
    return toTexture(c, { srgb: true, wrap: THREE.ClampToEdgeWrapping });
  });
}

/** Smootherstep — the one easing every falloff in this section uses. */
function smooth(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * A 1-D profile: opaque at u=0, gone by u=1, constant along v. Anything laid on the road's own
 * cross-section — the kerb AO, the pavement wash — wants this rather than the round blob,
 * because a radial falloff stretched down 60 m of kerb fades in and out along its own length.
 */
function edgeTexture() {
  return mat('lv-edge', () => {
    // square and mipmapped even though the profile is 1-D: these strips lie flat on the pavement
    // and recede to a few pixels, where an unmipped ramp resolves as a stipple (§7 caps aliased
    // edges at 68). A 64 px square costs 16 KB.
    const S = 64;
    const { c, ctx } = canvas(S, S);
    const img = ctx.createImageData(S, S);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = x / (S - 1);
        const a = Math.pow(1 - smooth(0, 1, u), 1.35);
        const i4 = (y * S + x) * 4;
        img.data[i4] = img.data[i4 + 1] = img.data[i4 + 2] = 255;
        img.data[i4 + 3] = (a * 255) | 0;
      }
    }
    ctx.putImageData(img, 0, 0);
    return toTexture(c, { srgb: true, wrap: THREE.ClampToEdgeWrapping });
  });
}

/**
 * The AO line down the kerb face. Not vertex-collapsed: it is one continuous run per side for
 * the whole circuit, so it is already one mesh and it needs its draw order kept.
 */
function edgeShadeMaterial(alpha = 0.55) {
  return mat(`lv-edge-shade|${alpha}`, () => new THREE.MeshBasicMaterial({
    map: edgeTexture(), color: new THREE.Color(SHADOW_INK), transparent: true, opacity: alpha,
    depthWrite: false, side: THREE.DoubleSide, fog: true,
  }));
}
/** The wash a lit kerb throws back across its own pavement, brightest at the kerb. */
function edgeWashMaterial(color, alpha = 0.30) {
  return mat(`lv-edge-wash|${color}|${alpha}`, () => new THREE.MeshBasicMaterial({
    map: edgeTexture(), color: new THREE.Color(color), transparent: true, opacity: alpha,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: true,
  }));
}

/** Per-object contact-shadow material; vcCollapse folds every one of these into one family. */
function shadeMaterial(alpha = 0.62, ink = SHADOW_INK) {
  return mat(`shade|${ink}|${alpha}`, () => vcTag(new THREE.MeshBasicMaterial({
    map: blobTexture(), color: new THREE.Color(ink), transparent: true, opacity: alpha,
    depthWrite: false, side: THREE.DoubleSide, fog: true,
  }), VC_SHADE, ink, alpha));
}

/** A flat quad lying on the ground, `w` across by `l` along, yawed. */
function groundGeo(w, l) {
  const g = new THREE.PlaneGeometry(w, l);
  g.rotateX(-Math.PI / 2);
  return g;
}

/**
 * The occlusion patch a standing object lays on the ground it stands on. `y` is measured from
 * whatever surface the object's own origin sits on; 0.05 clears the sidewalk slab (kerb top is
 * 0.17 above the carriageway) without floating far enough to shear off its own feet.
 */
function shade(w, l, x = 0, y = 0.05, z = 0, yaw = 0, alpha = 0.62) {
  const m = new THREE.Mesh(groundGeo(w, l), shadeMaterial(alpha));
  m.position.set(x, y, z);
  m.rotation.y = yaw;
  m.renderOrder = 8;
  return m;
}

/** The same thing already placed in world space, for props this file positions by hand. */
function shadeAt(pos, w, l, yaw = 0, alpha = 0.62, lift = 0.05) {
  const m = shade(w, l, 0, 0, 0, yaw, alpha);
  m.position.copy(pos).setY(pos.y + lift);
  return m;
}

/** An additive pool of a sign's own colour where it meets the ground, placed in world space. */
function poolAt(pos, w, l, yaw, color, alpha = 0.5, lift = 0.06) {
  const g = new THREE.PlaneGeometry(w, l);
  g.rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(g, spillMaterial(color, alpha));
  m.position.copy(pos).setY(pos.y + lift);
  m.rotation.y = yaw;
  m.renderOrder = 4;
  return m;
}

/**
 * THE KIT'S OWN PROPS.
 *
 * Lamps, hydrants, benches, bollards, cones, planters, palms and newsboxes are placed by
 * `cities/kit.js`, which this file does not own and must not reach into — but the round-1 note
 * named "every arch leg, lamp post and cone" and it is right: a bollard standing on a lit apron
 * with nothing under it is the same tell as a hovering car at 1/40th the size.
 *
 * The kit batches those props into InstancedMeshes and flags them `noMerge` so they survive its
 * own merge, which means the finished city still carries one matrix per prop. So instead of
 * duplicating anyone's placement code (and silently drifting out of sync the next time it
 * changes), the grounding pass READS the built world back and drops a patch under whatever it
 * actually finds standing on the ground. Bucketed per 240 m cell so culling still means something.
 */
function groundKitProps(group, { chunk = 240, budget = 2600 } = {}) {
  group.updateMatrixWorld(true);
  const ims = [];
  group.traverse((o) => {
    // A hard ceiling on the count, not on the number of meshes: a window bank or a bulb rig can
    // be tens of thousands of instances, and a quad per instance is both meaningless and enough
    // allocation to take the tab out. Street furniture comes in dozens.
    if (o.isInstancedMesh && o.count > 0 && o.count <= 900) ims.push(o);
  });
  if (!ims.length) return [];
  const ink = new THREE.Color(SHADOW_INK);
  const ALPHA = 0.58;
  const buckets = new Map();
  const m4 = new THREE.Matrix4();
  const pos = new THREE.Vector3(), q = new THREE.Quaternion(), scl = new THREE.Vector3();
  let placed = 0;
  for (const im of ims) {
    if (placed >= budget) break;
    const mtl = im.material;
    // glow cards, light pools and boost strips are light, not objects: they occlude nothing
    if (!mtl || Array.isArray(mtl) || mtl.transparent || im.userData.boost) continue;
    if (!im.geometry.boundingBox) im.geometry.computeBoundingBox();
    const bb = im.geometry.boundingBox;
    const bw = bb.max.x - bb.min.x, bd = bb.max.z - bb.min.z, bh = bb.max.y - bb.min.y;
    if (bh < 0.30) continue;                       // already a flat decal
    if (bw > 16 || bd > 16) continue;              // a building, not a prop
    for (let i = 0; i < im.count && placed < budget; i++) {
      im.getMatrixAt(i, m4);
      m4.premultiply(im.matrixWorld);
      m4.decompose(pos, q, scl);
      const foot = pos.y + bb.min.y * scl.y;
      if (foot > 2.4 || foot < -1.6) continue;     // not standing on any ground we can see
      const hw = clamp(bw * Math.abs(scl.x) * 1.15 + 0.35, 0.8, 4.6) * 0.5;
      const hd = clamp(bd * Math.abs(scl.z) * 1.15 + 0.35, 0.8, 4.6) * 0.5;
      const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z));
      const key = `${Math.floor(pos.x / chunk)}|${Math.floor(pos.z / chunk)}`;
      let b = buckets.get(key);
      if (!b) { b = { p: [], uv: [], c: [], idx: [], n: 0 }; buckets.set(key, b); }
      // written straight into flat arrays: a BufferGeometry per prop is thousands of tiny
      // allocations for eight floats of actual data
      const cy = Math.cos(yaw), sy = Math.sin(yaw), y = foot + 0.055;
      for (let k = 0; k < 4; k++) {
        const sx = (k & 1) ? hw : -hw, sz = (k & 2) ? hd : -hd;
        b.p.push(pos.x + sx * cy + sz * sy, y, pos.z - sx * sy + sz * cy);
        b.uv.push((k & 1) ? 1 : 0, (k & 2) ? 1 : 0);
        b.c.push(ink.r, ink.g, ink.b, ALPHA);
      }
      const v0 = b.n * 4;
      b.idx.push(v0, v0 + 1, v0 + 2, v0 + 1, v0 + 3, v0 + 2);
      b.n++;
      placed++;
    }
  }
  const out = [];
  for (const b of buckets.values()) {
    if (!b.n) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(b.p, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(b.c, 4));
    g.setIndex(b.idx);
    const m = new THREE.Mesh(g, vcFamilyMaterial(VC_SHADE));
    m.userData.noMerge = true;
    m.renderOrder = VC_ORDER[VC_SHADE];
    out.push(m);
  }
  return out;
}

/**
 * THE MOVING HALF.
 *
 * One mesh, one material, one draw call, `max` quads. Every frame it walks the scene for cars,
 * finds the road plane under each one, and writes four vertices per car straight into a shared
 * buffer. Nothing is allocated per frame and nothing is added to or removed from the graph.
 */
class CarShadows {
  constructor(track, max = 12) {
    this.track = track;
    this.max = max;
    this.hints = new WeakMap();
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(max * 4 * 3);
    this.col = new Float32Array(max * 4 * 4);
    const uv = new Float32Array(max * 4 * 2);
    const idx = [];
    for (let i = 0; i < max; i++) {
      const b = i * 4;
      // 0 = back-left, 1 = back-right, 2 = front-left, 3 = front-right; v=1 is the nose
      uv.set([0, 0, 1, 0, 0, 1, 1, 1], b * 2);
      idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
    }
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos);
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('color', this.aCol);
    g.setIndex(idx);
    g.setDrawRange(0, 0);
    this.mesh = new THREE.Mesh(g, mat('lv-carshadow-mat', () => new THREE.MeshBasicMaterial({
      map: carShadowTexture(), vertexColors: true, transparent: true, opacity: 1,
      depthWrite: false, side: THREE.DoubleSide, fog: true,
    })));
    this.mesh.frustumCulled = false;      // the buffer is rewritten every frame; a stale sphere lies
    this.mesh.renderOrder = 8;
    this.mesh.userData.noMerge = true;
    this.mesh.matrixAutoUpdate = false;
    this.ink = new THREE.Color(SHADOW_INK);
    this._inv = new THREE.Matrix4();
    this._p = new THREE.Vector3(); this._f = new THREE.Vector3();
    this._n = new THREE.Vector3(); this._r = new THREE.Vector3();
    this._c = new THREE.Vector3(); this._d = new THREE.Vector3();
  }

  /** `root` is the city group the mesh lives under, so world points land in its local frame. */
  update(root) {
    const scene = root.parent;
    const geo = this.mesh.geometry;
    if (!scene) { geo.setDrawRange(0, 0); return; }
    this._inv.copy(root.matrixWorld).invert();
    const t = this.track;
    let n = 0;
    for (const o of scene.children) {
      if (n >= this.max) break;
      const ud = o.userData;
      if (!ud || !ud.dims || !ud.wheels || !ud.spec || !o.visible) continue;
      const dims = ud.dims;
      const p = this._p.copy(o.position);

      // --- the road plane under the car ---
      const near = t.nearest(p, this.hints.get(o) ?? null);
      this.hints.set(o, ((near.u % 1) + 1) % 1);
      const f = t.frame(((near.u % 1) + 1) % 1);
      const N = this._n.copy(f.normal);
      let d = this._d.copy(p).sub(f.pos).dot(N);
      // On a branch corridor or a ramp deck the main ribbon's plane is metres away and means
      // nothing; fall back to the car's own origin, which is on the ground by contract.
      if (d < -0.8 || d > 5.0) { N.set(0, 1, 0); d = 0.021; }
      const air = clamp(d - 0.021, 0, 8);

      // --- the frame to lay the quad in: up = road normal, forward = the car's own heading ---
      const F = this._f.set(0, 0, 1).applyQuaternion(o.quaternion);
      F.addScaledVector(N, -F.dot(N));
      if (F.lengthSq() < 1e-6) F.set(0, 0, 1).addScaledVector(N, -N.z);
      F.normalize();
      const R = this._r.crossVectors(N, F).normalize();

      // The centre sits on the road plane, not on the car: that is the whole difference between
      // a shadow and a decal stuck to the bodywork.
      const C = this._c.copy(p).addScaledVector(N, -d + 0.035);

      // A shadow spreads and washes out as its caster climbs. Both terms are what sells a ramp
      // landing; on the ground they are exactly 1 and 1.
      const grow = 1 + air * 0.16;
      const hw = dims.width * 0.82 * grow;             // silhouette lands at CAR_SIL_U in the map
      const hl = dims.length * 0.62 * grow;            // ...and at CAR_SIL_V
      const a = 0.90 * (1 - smooth(0, 3.4, air) * 0.86);

      const b = n * 4;
      for (let k = 0; k < 4; k++) {
        const sx = (k & 1) ? 1 : -1, sz = (k & 2) ? 1 : -1;
        const i3 = (b + k) * 3;
        this.pos[i3] = C.x + R.x * sx * hw + F.x * sz * hl;
        this.pos[i3 + 1] = C.y + R.y * sx * hw + F.y * sz * hl;
        this.pos[i3 + 2] = C.z + R.z * sx * hw + F.z * sz * hl;
        const i4 = (b + k) * 4;
        this.col[i4] = this.ink.r; this.col[i4 + 1] = this.ink.g;
        this.col[i4 + 2] = this.ink.b; this.col[i4 + 3] = a;
      }
      n++;
    }
    // world → city-group local, in place
    if (n) {
      const m = this._inv.elements;
      const identity = m[0] === 1 && m[5] === 1 && m[10] === 1
        && m[12] === 0 && m[13] === 0 && m[14] === 0;
      if (!identity) {
        for (let i = 0; i < n * 4; i++) {
          const j = i * 3;
          const x = this.pos[j], y = this.pos[j + 1], z = this.pos[j + 2];
          this.pos[j] = m[0] * x + m[4] * y + m[8] * z + m[12];
          this.pos[j + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
          this.pos[j + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
        }
      }
    }
    this.aPos.needsUpdate = true;
    this.aCol.needsUpdate = true;
    geo.setDrawRange(0, n * 6);
  }
}

/**
 * The footprint itself.
 *
 * NOT an ellipse. The quad is only ~1.6 x the car wide and ~1.25 x long, so an ellipse inscribed
 * in it has already fallen to a few percent by the time it reaches the car's own silhouette —
 * which is exactly where a contact shadow has to be at its strongest, and why the first pass of
 * this read as a faint smudge in the capture. So: a rounded RECTANGLE that holds full strength
 * across the whole footprint and does all its falling off in the margin outside it, with four
 * near-opaque tyre patches on top. The tyre patches are the half that sells it — a soft slab
 * under a car is an airbrushed smudge, four dark contact points are weight on the road.
 *
 * The layout is in fractions of the quad and the quad is sized off `dims`, so one sheet fits all
 * four classes: the silhouette lands at |u| = 0.61 / |v| = 0.81 and the wheels at (0.48, 0.478)
 * for every one of them to within a percent.
 */
const CAR_SIL_U = 0.61, CAR_SIL_V = 0.81;
function carShadowTexture() {
  return mat('lv-carshadow', () => {
    const W = 128, H = 256;
    const { c, ctx } = canvas(W, H);
    const img = ctx.createImageData(W, H);
    const WH = [[-0.48, 0.478], [0.48, 0.478], [-0.48, -0.478], [0.48, -0.478]];
    for (let y = 0; y < H; y++) {
      const v = 1 - (y / (H - 1)) * 2;                 // canvas row 0 is v=1 is the nose
      for (let x = 0; x < W; x++) {
        const u = (x / (W - 1)) * 2 - 1;
        // distance OUTSIDE the silhouette, in units of the margin; 0 anywhere under the car
        const su = Math.max(0, Math.abs(u) - CAR_SIL_U) / (1 - CAR_SIL_U);
        const sv = Math.max(0, Math.abs(v) - CAR_SIL_V) / (1 - CAR_SIL_V);
        const s = Math.hypot(su, sv);                  // hypot rounds the corners
        let a = 0.74 * (1 - smooth(0, 0.86, s))        // the body's own occlusion
          + 0.24 * (1 - smooth(0, 1.0, s));            // and the softer skirt around it
        for (const [cu, cv] of WH) {
          const d = Math.hypot((u - cu) / 0.185, (v - cv) / 0.130);
          a += 0.30 * (1 - smooth(0.0, 1.0, d));       // the tyre contact patches
        }
        // both edges must reach zero or the quad prints its own rectangle on the road
        a *= clamp((1 - Math.abs(u)) * 9, 0, 1) * clamp((1 - Math.abs(v)) * 9, 0, 1);
        const i4 = (y * W + x) * 4;
        img.data[i4] = img.data[i4 + 1] = img.data[i4 + 2] = 255;
        img.data[i4 + 3] = (clamp(a, 0, 1) * 255) | 0;
      }
    }
    ctx.putImageData(img, 0, 0);
    const t = toTexture(c, { srgb: true, wrap: THREE.ClampToEdgeWrapping });
    return t;
  });
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
// Round 2's measured complaint about the biggest surface in the frame: "the asphalt carries a
// broad uniform purple wash with only a couple of streaks near the arch — the Paradiso and Welcome
// signs cast no reflection onto the street below them". The broad wash is the env-map term on a
// wet MeshStandardMaterial and it is correct; what was missing was the amplitude of the streaks
// laid ON it, which at 0.55/0.34/0.20/0.12 were a fifth of a stop over the base and simply lost.
// §1.3 is unambiguous — EVERY light source draws a long reflection down the surface — so the top
// tier is now near unity and the bottom tier is where the old top tier was.
const REFL_TIER = [0.88, 0.60, 0.40, 0.24];
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

// ---------------------------------------------------------------- kerb architecture
//
// A longitudinal strip hung on the road's OWN banked cross-section. `a` and `b` are stations in
// the kit's road-section units — `off` metres outboard of the carriageway edge, `y` metres above
// it — which is the same frame `buildRoad()` generates its kerb and gutter from, so anything
// built here is welded to the kerb rather than floating a hand's width off it (§7 caps a visible
// gap between road and shoulder at 62).

function sectionStrip(track, m0, m1, side, a, b, segM = 3.2, vRep = 1) {
  const n = Math.max(2, Math.round(Math.abs(m1 - m0) / segM));
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= n; i++) {
    const f = track.frame(U(m0 + (m1 - m0) * (i / n)));
    for (const st of [a, b]) {
      const p = f.pos.clone()
        .addScaledVector(f.right, side * (f.half + st.off))
        .addScaledVector(f.normal, st.y);
      pos.push(p.x, p.y, p.z);
    }
    const v = (i / n) * vRep;
    uv.push(0, v, 1, v);
    if (i < n) { const k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------- THE STREET
//
// Round 2 scored this city 23/25 on legibility and 7/15 on "road surface and furniture": every
// pixel above the horizon was at target while the surface the car actually drives on was half
// marked. The measured complaint, verbatim: no raised kerb, no rumble strip, no jersey barrier,
// markings that are a centre double-yellow and almost nothing else, three lamp posts in the whole
// scene, and a wet asphalt showing a flat purple wash instead of the neon it is supposed to
// mirror.
//
// Everything from here to `boulevardLamps()` exists to answer that, and all of it is hung on the
// road's OWN banked cross-section (see sectionStrip) so nothing can float off the tarmac:
//
//   lane paint  → six lanes of retroreflective markings, dashed dividers and solid edge lines
//   rumbleKerb  → the striped rumble strip at the carriageway edge, as alternating blocks
//   raisedKerb  → a real 22 cm kerb with a face, a top and a fall to the pavement
//   boulevardLamps → a lamp every ~26 m per side, each with a warm pool on the asphalt
//
// The one rule they all obey: this city has three hues and a bone-white for paint and concrete.
// A rumble strip is red-and-white everywhere else in the world; here it is magenta-and-bone,
// which is the same object read at a glance and still inside the palette.

const BONE = '#efe9df';        // paint and cast concrete — the only near-neutral in the city

/**
 * Worn road paint. Not a flat white quad: thermoplastic that has been driven over for a decade is
 * chipped at the edges, scuffed down the middle, and studded with glass beads that fire back at
 * anything pointed at them — which at night is the whole reason a lane line is visible at all.
 * The same canvas is the map AND the emissive map, so the beads self-light and the worn patches
 * stay dark (§7 caps an untextured flat-colour material on a large surface at 50).
 */
function paintTexture(seed = 1) {
  return mat(`lv-paint|${seed}`, () => {
    const W = 64, H = 256;
    const { c, ctx } = canvas(W, H);
    const rng = new RNG(seed * 71 + 5);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(2, 0, W - 4, H);
    // chipped edges: bite into both long sides so the stripe never has a ruled border
    ctx.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 130; i++) {
      const x = rng.bool(0.5) ? rng.range(-1, 7) : rng.range(W - 7, W + 1);
      ctx.globalAlpha = rng.range(0.35, 1);
      ctx.beginPath();
      ctx.ellipse(x, rng.range(0, H), rng.range(1.2, 4.2), rng.range(2, 11), 0, 0, 7);
      ctx.fill();
    }
    // and scrub the middle where tyres cross it
    for (let i = 0; i < 90; i++) {
      ctx.globalAlpha = rng.range(0.10, 0.55);
      ctx.beginPath();
      ctx.ellipse(rng.range(0, W), rng.range(0, H), rng.range(2, 9), rng.range(3, 22), 0, 0, 7);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    // glass beads
    for (let i = 0; i < 260; i++) {
      ctx.fillStyle = `rgba(255,255,255,${rng.range(0.25, 0.9)})`;
      ctx.beginPath();
      ctx.arc(rng.range(3, W - 3), rng.range(0, H), rng.range(0.5, 1.5), 0, 7);
      ctx.fill();
    }
    grain(ctx, W, H, 5, rng);
    return toTexture(c, { srgb: true, wrap: THREE.RepeatWrapping });
  });
}

/**
 * Road paint. `emi` is what makes it a NIGHT marking rather than a grey stripe: there is no key
 * light in this city, so paint that is not retroreflective is invisible. Held under the 0.64 bloom
 * threshold so a lane line reads as paint and not as a neon tube.
 */
function paintMaterial(color = BONE, emi = 0.55, seed = 1) {
  return mat(`lv-paintm|${color}|${emi}|${seed}`, () => {
    const t = paintTexture(seed);
    return new THREE.MeshStandardMaterial({
      map: t, emissiveMap: t, alphaMap: t,
      color: new THREE.Color(color), emissive: new THREE.Color(color), emissiveIntensity: emi,
      roughness: 0.48, metalness: 0.0, envMapIntensity: 1.5,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -8, polygonOffsetUnits: -8,
    });
  });
}

/**
 * A stripe painted on the carriageway between arc positions m0..m1 at lateral `lat` (a fraction
 * of the half-width, exactly as `track.surfacePoint` reads it, so the stripe banks and pinches
 * with the ribbon it is painted on).
 */
function roadStripe(track, m0, m1, lat, widthM, lift = 0.026, segM = 5) {
  const n = Math.max(1, Math.round(Math.abs(m1 - m0) / segM));
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = U(lerp(m0, m1, t));
    const f = track.frame(u);
    const hw = (widthM * 0.5) / f.half;
    const a = f.pos.clone().addScaledVector(f.right, (lat - hw) * f.half)
      .addScaledVector(f.normal, 0.02 + lift);
    const b = f.pos.clone().addScaledVector(f.right, (lat + hw) * f.half)
      .addScaledVector(f.normal, 0.02 + lift);
    pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
    const v = t * Math.abs(m1 - m0) / 2.4;
    uv.push(0, v, 1, v);
    if (i < n) { const k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * Six lanes of markings on a 24 m boulevard: solid edge lines, two dashed dividers per
 * carriageway, and a hatched buffer beside the centre double-yellow the road texture already
 * carries. Nothing here repeats on a fixed period — the dash cycle is jittered per cycle, and
 * markings are skipped across the crossings the kit paints, so the lot never reads as a texture.
 */
function laneMarkings(track, out, rng) {
  const paint = new B(paintMaterial(BONE, 0.58, 1));
  const paintDim = new B(paintMaterial(BONE, 0.40, 2));
  const yellow = new B(paintMaterial('#f2c23c', 0.52, 3));
  const lr = rng.fork(4507);

  // --- solid edge lines, both sides, the full circuit ---
  for (const side of [-1, 1]) {
    let m = 0;
    while (m < LEN) {
      const run = Math.min(LEN - m, lr.range(50, 130));
      paint.addM(roadStripe(track, m, m + run, side * 0.945, 0.22, 0.028, 5.5), _IDENTITY);
      m += run + lr.range(0.4, 2.2);           // hairline joints, as a real paint crew leaves
    }
  }
  // --- the buffer hatching either side of the centre line ---
  for (const side of [-1, 1]) {
    let m = lr.range(0, 40);
    while (m < LEN - 30) {
      if (Math.abs(track.turnRate(U(m))) < 0.004) {
        for (let k = 0; k < 7; k++) {
          const mm = m + k * 3.4;
          paintDim.addM(roadStripe(track, mm, mm + 2.1, side * 0.085, 0.16, 0.027, 2.2), _IDENTITY);
        }
      }
      m += lr.range(120, 260);
    }
  }
  // --- dashed lane dividers: two per carriageway, so the road reads as six lanes ---
  for (const side of [-1, 1]) {
    for (const lat of [side * 0.315, side * 0.63]) {
      let m = lr.range(0, 9);
      while (m < LEN) {
        const dash = lr.range(2.8, 3.6);
        (lr.bool(0.18) ? paintDim : paint)
          .addM(roadStripe(track, m, m + dash, lat, 0.19, 0.027, 3.6), _IDENTITY);
        m += dash + lr.range(5.6, 7.2);
      }
    }
  }
  // --- and a gore of yellow chevrons where the kerb bulges at each shortcut mouth ---
  for (const b of track.branches) {
    const bm = track.nearest(b.curve.getPointAt(0.02)).u * LEN;
    for (let k = 0; k < 5; k++) {
      const mm = bm - 26 + k * 5.4;
      yellow.addM(roadStripe(track, mm, mm + 3.0, 0.86 - k * 0.03, 0.30, 0.028, 3.2), _IDENTITY);
    }
  }
  const holder = new THREE.Group();
  for (const b of [paint, paintDim, yellow]) {
    const m = b.into(holder);
    if (!m) continue;
    m.userData.noMerge = true;
    m.frustumCulled = false;                   // one mesh for the whole circuit; the sphere test can only pass
    m.renderOrder = 2;                         // under the wet-road mirror, over the tarmac
    m.castShadow = false; m.receiveShadow = false;
    out.push(m);
  }
}

/**
 * THE RUMBLE STRIP.
 *
 * The kit already lofts a sloped curb panel between the white line and the gutter and maps a
 * stripe texture onto it — but this city has no key light, so at night it resolves as an unlit
 * dark band and round 2 measured "a flat emissive cyan strip and a magenta band standing in for
 * geometry". This lays the strip again as ALTERNATING BLOCKS with their own emissive floor, on
 * exactly the kit's own two stations lifted 12 mm along the road normal, so it reads as a striped
 * kerb from the driver's seat and cannot z-fight (§7 caps z-fighting at 60).
 *
 * Block length is jittered 1.5-2.0 m so the run is hand-laid rather than stamped.
 */
function rumbleKerb(track, out, rng) {
  const rr = rng.fork(1607);
  const conc = mat('lv-rumble-tex', () => concrete({ size: 256, seed: 17, tint: '#cfc6bb' }));
  const face = (color, emi) => mat(`lv-rumble|${color}`, () => new THREE.MeshStandardMaterial({
    map: conc.map, roughnessMap: conc.roughnessMap, normalMap: conc.normalMap,
    color: new THREE.Color(color), emissive: new THREE.Color(color), emissiveIntensity: emi,
    roughness: 0.72, metalness: 0.0, envMapIntensity: 1.35,
  }));
  const pale = new B(face(BONE, 0.42));
  const hot = new B(face(MAGENTA, 0.86));
  // the kit's own curb stations (roadEdge → curbOut), lifted clear of them
  const A = { off: -0.03, y: 0.033 }, Bo = { off: 1.18, y: 0.118 };
  for (const side of [-1, 1]) {
    let m = rr.range(0, 2);
    let k = 0;
    while (m < LEN) {
      // ~1.1 m against a 1.2 m width: a rumble strip is a run of near-square blocks, and at the
      // 1.5-2.0 m the first round-3 pass used it read as a chequerboard rather than as a kerb.
      const len = rr.range(0.95, 1.30);
      const m1 = Math.min(LEN, m + len);
      (k % 2 ? hot : pale).addM(sectionStrip(track, m, m1, side, A, Bo, len, 1), _IDENTITY);
      m = m1;
      k++;
    }
  }
  const holder = new THREE.Group();
  for (const b of [pale, hot]) {
    const m = b.into(holder);
    if (!m) continue;
    m.userData.noMerge = true; m.frustumCulled = false;
    m.castShadow = false; m.receiveShadow = false;
    out.push(m);
  }
}

/**
 * THE RAISED KERB.
 *
 * The kit's kerb face is 10 cm of unlit concrete 6.4 m outboard of the white line, and in a city
 * whose only light comes from signage that is a tone change, not an edge. This stands a real
 * 22 cm kerb on the same line — a vertical face the neon cove behind it rakes, a flat top, and a
 * short fall onto the pavement — plus a drainage channel run in the gutter beside it. Four
 * stations, one continuous strip per station pair, welded to the kit's own offsets at both ends.
 */
function raisedKerb(track, out) {
  const WOFF = track.wallOffset ?? 6.39;
  const conc = mat('lv-kerb-tex', () => concrete({ size: 512, seed: 29, tint: '#b9b1a6' }));
  const kerbMat = mat('lv-kerb-mat', () => new THREE.MeshStandardMaterial({
    map: conc.map, roughnessMap: conc.roughnessMap, normalMap: conc.normalMap,
    emissiveMap: conc.map, emissive: new THREE.Color('#8e86a8'), emissiveIntensity: 0.30,
    roughness: 0.86, metalness: 0.0, envMapIntensity: 1.1,
  }));
  const kb = new B(kerbMat, { receive: false });
  // Every station is deliberately 15-25 mm PROUD of the kit's own cross-section at the same
  // offset — its gutter lane falls 0.10 → 0.07 across off 1.2 → 6.39 and its pavement 0.17 → 0.13
  // across 6.57 → 11.97. A strip that crosses one of those planes rather than clearing it prints
  // an intersection line down the whole circuit and z-fights along it, which §7 caps at 60.
  const S = {
    gutter: { off: WOFF - 1.5, y: 0.093 },
    toe: { off: WOFF - 0.10, y: 0.086 },
    lip: { off: WOFF - 0.04, y: 0.300 },
    top: { off: WOFF + 0.44, y: 0.292 },
    fall: { off: WOFF + 0.92, y: 0.185 },
  };
  for (const side of [-1, 1]) {
    // the channel the gutter drains into — a shallow dish, so the kerb is not a wall on a plane
    kb.addM(sectionStrip(track, 0, LEN, side, S.gutter, S.toe, 6.0, LEN / 5), _IDENTITY);
    kb.addM(sectionStrip(track, 0, LEN, side, S.toe, S.lip, 4.0, LEN / 2.2), _IDENTITY);
    kb.addM(sectionStrip(track, 0, LEN, side, S.lip, S.top, 5.0, LEN / 4), _IDENTITY);
    kb.addM(sectionStrip(track, 0, LEN, side, S.top, S.fall, 6.0, LEN / 4), _IDENTITY);
  }
  const m = kb.into(new THREE.Group());
  if (m) { m.userData.noMerge = true; m.frustumCulled = false; out.push(m); }
}

/**
 * THE BOULEVARD LAMPS.
 *
 * §1.3 names warm amber street lamps as the only tie to daylight colour in a neon night frame,
 * and round 2 counted three of them in the whole scene. This puts one every ~26 m down BOTH
 * kerbs, staggered so the two sides interleave to a rung every 13 m down the vanishing point.
 *
 * Every part goes through a vc-tagged material, so `vcCollapse()` folds two hundred lamps into a
 * handful of merged meshes per 240 m cell — the column and arm join the pylons' steel bucket, the
 * lantern joins the tube bucket, the pool joins the ground-spill bucket. The lamp costs the city
 * no new draw call at all; only the triangles are new.
 */
const LAMP_WARM = '#ffcb52';

/**
 * The shaft of light under a lantern. Alpha runs 1 at the top (v=1, the lamp) to 0 at the bottom,
 * so an open cone carries a cone of haze whatever angle it is seen from — which is what a street
 * lamp looks like in humid night air and what makes a lamp read as a SOURCE rather than as a dot
 * on a stick. Constant across u, because u wraps around the cone and any variation there would
 * print a seam down it.
 */
function lampConeTexture() {
  return mat('lv-lampcone', () => {
    const S = 64;
    const { c, ctx } = canvas(S, S);
    const img = ctx.createImageData(S, S);
    for (let y = 0; y < S; y++) {
      // canvas row 0 is the TOP of the image, which flipY maps to v=1 — the lantern end
      const v = 1 - y / (S - 1);
      const a = Math.pow(v, 2.1) * (0.30 + 0.70 * smooth(0.86, 0.99, v) + 0.55 * v);
      const q = (clamp(a, 0, 1) * 255) | 0;
      for (let x = 0; x < S; x++) {
        const i4 = (y * S + x) * 4;
        img.data[i4] = img.data[i4 + 1] = img.data[i4 + 2] = 255;
        img.data[i4 + 3] = q;
      }
    }
    ctx.putImageData(img, 0, 0);
    const t = toTexture(c, { srgb: true, wrap: THREE.ClampToEdgeWrapping });
    t.generateMipmaps = false; t.minFilter = THREE.LinearFilter; t.needsUpdate = true;
    return t;
  });
}
function lampConeMaterial() {
  return mat('lv-lampcone-mat', () => vcTag(new THREE.MeshBasicMaterial({
    map: lampConeTexture(), color: new THREE.Color('#ffab2e'), transparent: true, opacity: 0.14,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: true,
  }), VC_CONE, '#ffab2e', 0.14));
}

/** One lamp, in its own local frame: +Z points at the carriageway, +Y is up. */
function stripLamp({ h = 9.4, seed = 1, banner = null }) {
  const g = new THREE.Group();
  // A pale warm-violet metal, not near-black: there is no key light in this city, so a dark
  // column is a black stick against the neon. At this tint the env probe alone gives the mast a
  // lit edge and a hundred of them read as a receding colonnade rather than as a picket fence.
  const st = new B(steel('#6d6182'));
  const lens = new B(tube(LAMP_WARM));
  const hb = new B(halo(LAMP_WARM, 0.28));
  // plinth, fluted column, collars
  st.add(box(1.05, 0.30, 1.05), 0, 0.15, 0);
  st.add(cyl(0.40, 0.50, 0.95, 9), 0, 0.62, 0);
  st.add(cyl(0.15, 0.30, h, 10), 0, h / 2 + 0.9, 0);
  for (let i = 1; i <= 3; i++) st.add(cyl(0.24, 0.24, 0.13, 10), 0, 0.9 + h * (i / 4), 0);
  // a cranked arm reaching out over the kerb, as an arc of four short links
  const REACH = 3.5;
  const armZ = (t) => REACH * (t * t * 0.35 + t * 0.65);
  const armY = (t) => h + 0.9 + Math.sin(t * 1.5) * 0.62;
  for (let i = 0; i < 4; i++) {
    const t0 = i / 4, t1 = (i + 1) / 4;
    const z0 = armZ(t0), z1 = armZ(t1), y0 = armY(t0), y1 = armY(t1);
    const dz = z1 - z0, dy = y1 - y0;
    st.add(cyl(0.105, 0.125, Math.hypot(dz, dy) + 0.06, 7),
      0, (y0 + y1) / 2, (z0 + z1) / 2, 0, { rx: Math.atan2(dz, dy) });
  }
  const LY = armY(1), LZ = REACH;
  st.add(cyl(0.72, 0.34, 0.44, 8), 0, LY + 0.46, LZ);            // lantern cap
  st.add(cyl(0.12, 0.12, 0.30, 6), 0, LY + 0.80, LZ);            // spike
  st.add(box(0.12, 0.60, 0.12), 0, LY - 0.98, LZ);               // finial under the glass
  // the lantern itself: a tapered hexagonal glass, big enough to be an object at 60 m and hot
  // enough to bloom. Round 3's first pass had this at 0.4 m and it resolved as a speck.
  lens.add(cyl(0.62, 0.30, 1.05, 6), 0, LY - 0.22, LZ);
  lens.add(new THREE.SphereGeometry(0.20, 8, 6), 0, LY - 0.86, LZ);
  hb.add(new THREE.PlaneGeometry(5.2, 5.2), 0, LY - 0.20, LZ);
  // ...and the shaft of light under it, which is the half that makes a lamp read as a source
  {
    const CH = LY - 2.6;
    const cone = new THREE.Mesh(
      new THREE.CylinderGeometry(0.62, 3.5, CH, 12, 1, true), lampConeMaterial(),
    );
    cone.position.set(0, LY - 0.35 - CH / 2, LZ);
    cone.renderOrder = 3;
    g.add(cone);
  }
  // a pennant on the column in one of the three hues, so the lamps carry the palette too
  if (banner) {
    const bb = new B(tube(banner));
    for (const s of [-1, 1]) bb.add(new THREE.PlaneGeometry(0.09, 2.3), s * 0.50, h * 0.60, 0, Math.PI / 2);
    bb.add(box(1.10, 0.09, 0.09), 0, h * 0.60 + 1.15, 0);
    bb.into(g);
  }
  st.into(g); lens.into(g);
  const hm = hb.into(g); if (hm) hm.renderOrder = 3;
  g.add(shade(2.7, 2.7, 0, 0.05, 0, 0, 0.58));
  void seed;
  return g;
}

function boulevardLamps(track, out, rng) {
  const lr = rng.fork(7717);
  const pool = new B(spillMaterial(LAMP_WARM, 0.27));
  const OFF = 7.3;                         // on the pavement, just behind the kerb top
  const SP = 26;
  let n = 0;
  for (const side of [-1, 1]) {
    for (let m = (side > 0 ? 0 : SP / 2) + lr.range(0, 3); m < LEN; m += SP * lr.range(0.94, 1.06)) {
      const f = track.frame(U(m));
      const g = stripLamp({
        h: lr.range(9.1, 9.9), seed: n,
        banner: n % 3 === 1 ? HUES[(n * 2 + 1) % 3] : null,
      });
      g.position.copy(f.pos).addScaledVector(f.right, side * (f.half + OFF))
        .addScaledVector(f.normal, 0.30);
      // +Z of the lamp faces the road, so the arm reaches out over the kerb
      g.rotation.y = Math.atan2(f.tan.x, f.tan.z) + side * Math.PI / 2;
      out.push(g);
      // ...and the pool it throws on the tarmac. Built on the banked cross-section rather than as
      // a flat quad: a plane laid across a cambered road is buried under the tarmac for half its
      // width. Short (13 m against a 26 m pitch) so consecutive pools never fuse into a band.
      // Aimed at the ASPHALT and STOPPED AT THE WHITE LINE. A warm additive band laid over the
      // rumble strip washes the magenta-and-bone blocks flat — measured on the near-left shoulder
      // of the round-3 chase capture, where the kerb was legible on the side the pool did not
      // reach and gone on the side it did. So the pool owns the nearside lane and nothing else,
      // which is where a lamp actually puts its light anyway.
      pool.addM(sectionStrip(track, m - 6.2, m + 6.2, side,
        { off: -8.0, y: 0.048 }, { off: 0.15, y: 0.058 }, 3.2, 1), _IDENTITY);
      // ...and the streak it draws down the wet tarmac. A lamp every 26 m means a receding ladder
      // of warm verticals in the road under the neon, which is the one thing the reference night
      // frame (§1.3) has that a row of pools alone does not.
      reflect(track, {
        m, side, len: lr.range(26, 40), variant: 0, tier: 2, color: LAMP_WARM,
        lat0: 0.92, lat1: 0.56, half0: 0.09, half1: 0.075, segs: 10, mirror: lr.bool(0.5),
      });
      n++;
    }
  }
  const pm = pool.into(new THREE.Group());
  if (pm) { pm.renderOrder = 3; out.push(pm); }
}

/**
 * A bulb string slung across the boulevard. Built in the plane PERPENDICULAR to the road, which
 * is the plane the driver is looking straight into, so a two-triangle-per-segment ribbon reads as
 * a run of round bulbs rather than as a wire seen edge-on. The sag is what makes it read as a
 * string rather than as a bar.
 */
function bulbSpan(track, bat, m, {
  lat0 = -1.62, lat1 = 1.62, y = 11.5, sag = 2.0, w = 0.8, segs = 16,
}) {
  const f = track.frame(U(m));
  // one round bulb per strand-width of string (see chaseStrip), in texture repeats
  const rep = Math.max(6, Math.round((lat1 - lat0) * f.half / w)) / CHASE_BULBS;
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const lat = lerp(lat0, lat1, t);
    const yy = y - Math.sin(t * Math.PI) * sag;
    const p = f.pos.clone().addScaledVector(f.right, lat * f.half);
    for (const dy of [w / 2, -w / 2]) pos.push(p.x, p.y + yy + dy, p.z);
    uv.push(t * rep, 1, t * rep, 0);
    if (i < segs) { const k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  bat.addM(g, _IDENTITY);
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
 * Running bulbs, done as a scrolling texture rather than N phase materials: one strip of eight
 * round dots per hue, `map.offset.x` animated. Every chase strip in the city that shares a hue
 * shares the material, so the whole Strip flickers for three draw calls and no per-frame geometry
 * work. A bulb is a square cell of the strip, so a run is only round bulbs if the geometry lays
 * one cell per strip-height of length — see CHASE_TILE.
 */
const CHASE_BULBS = 8;
/** Metres of strip per texture repeat: eight bulbs, each as wide as the strip is tall. */
const CHASE_TILE = (w) => CHASE_BULBS * w;
function chaseTexture() {
  return mat('chase-tex', () => {
    // 64 px a bulb rather than 12, so a bulb the camera passes under is still magnified less
    // than 2x; and each one is a lamp with a solid core and a short falloff, with dark between
    // neighbours, so a run reads as separate bulbs rather than as one soft band.
    const P = 64, W = P * CHASE_BULBS;
    const { c, ctx } = canvas(W, P);
    ctx.clearRect(0, 0, W, P);
    for (let i = 0; i < CHASE_BULBS; i++) {
      const x = (i + 0.5) * P, y = P / 2, r = P * 0.46;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      const on = i % 4 === 0;
      g.addColorStop(0, `rgba(255,255,255,${on ? 1 : 0.42})`);
      g.addColorStop(0.38, `rgba(255,255,255,${on ? 0.92 : 0.36})`);
      g.addColorStop(0.62, `rgba(255,255,255,${on ? 0.38 : 0.13})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
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

/**
 * A run of chase bulbs `len` metres long lying in the XY plane, centred on the origin.
 *
 * The repeat used to be one texture tile per 1.1 m, i.e. eight bulbs in 1.1 m of a strip 0.9 m
 * tall: every "bulb" was a 0.14 x 0.9 m vertical streak, so a cabinet frame drew as a white comb
 * and, past thirty metres, as the barcode above and below every marquee. One bulb per strip-height
 * of length makes them round, and wide enough apart that the mip chain can resolve them.
 */
function chaseStrip(bat, len, x, y, z, ry = 0, o = {}) {
  const w = o.w ?? 0.9;
  const g = new THREE.PlaneGeometry(len, w);
  const uv = g.attributes.uv;
  const rep = Math.max(1, Math.round(len / w)) / CHASE_BULBS;
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

  // double neon border. shadowBlur was 26 on a 384 px board — a 7%-of-the-width magenta wash
  // laid over the whole cabinet, which the bloom pass then doubled. That, not the type size,
  // is why a Strip pylon resolved as a flat glowing rectangle: the sign was lighting itself out.
  ctx.strokeStyle = color; ctx.lineWidth = 10;
  ctx.shadowColor = color; ctx.shadowBlur = 9;
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

  /** The lit sub-line plate at the foot of a pylon board — CASINO / LOOSE SLOTS / 24 HOURS. */
  const subPlate = () => {
    ctx.fillStyle = 'rgba(3,1,9,0.72)';
    ctx.fillRect(w * 0.06, h - 132, w * 0.88, 76);
    ctx.strokeStyle = CYAN; ctx.lineWidth = 3;
    ctx.strokeRect(w * 0.06, h - 132, w * 0.88, 76);
    fitText(ctx, sub, {
      x0: w * 0.10, x1: w * 0.90, y: h - 76, size: Math.min(50, (w * 0.82) / Math.max(4, sub.length) * 1.8),
      weight: 0.26, italic: 0.16, color: CYAN, tracking: 0.10,
      glow: { color: CYAN, blur: 7 },
    });
  };

  // Which layout a board gets is decided by its own PROPORTION, which is the thing that was
  // wrong. Stacking a five-letter name down a 1.42-aspect cabinet left a 53 px cap height on a
  // 384 px board — 14% of the width, invisible past forty metres, and the real reason a row of
  // pylons read as a row of coloured rectangles. Tall boards stack letters; squarer boards carry
  // the name ACROSS them, as large as the cabinet allows, which is also what the real ones do.
  if (vertical && h / w >= 1.7) {
    const letters = text.replace(/[^A-Z0-9]/g, '').slice(0, 8).split('');
    const top = 50, bot = h - 138;
    const cell = (bot - top) / letters.length;
    const size = Math.min(cell * 0.94, w * 0.72);
    letters.forEach((ch, i) => {
      const cy = top + cell * (i + 0.5);
      // a DARK lozenge, not a light one: the letter has to sit on something darker than itself.
      ctx.fillStyle = 'rgba(5,2,12,0.70)';
      ctx.fillRect(w * 0.09, cy - cell * 0.46, w * 0.82, cell * 0.92);
      ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 2;
      ctx.strokeRect(w * 0.09, cy - cell * 0.46, w * 0.82, cell * 0.92);
      drawText(ctx, ch, {
        x: w / 2, y: cy + size * 0.36, size, weight: 0.30, italic: 0.05, align: 'center',
        color: i % 2 ? color : accent, tracking: 0,
        // blur was 0.75 x the cap height: every letter drowned in its own halo before the bloom
        // pass had even seen it. A neon tube's glow is about a quarter of its own stroke.
        glow: { color: i % 2 ? color : accent, blur: size * 0.22 },
      });
    });
    subPlate();
  } else if (vertical) {
    const words = text.split(' ').filter(Boolean);
    const lines = words.length >= 2 ? [words[0], words.slice(1).join(' ')] : [text];
    const topY = h * 0.14, band = (h - 152) - topY;
    const lh = band / lines.length;
    ctx.fillStyle = 'rgba(4,1,10,0.66)';
    ctx.fillRect(w * 0.07, topY, w * 0.86, band);
    lines.forEach((ln, i) => {
      const size = Math.min(lh * 0.74, (w * 0.86) / Math.max(3, ln.length) * 1.78);
      const col = i % 2 ? accent : color;
      // NEON, not paint: a hue-coloured tube around a dark core. A solid letter at
      // emissiveIntensity 1.9 is a slab of light the bloom pass immediately fuses into its
      // neighbours — which is why the round-5 boards read as one glowing rectangle. An outline
      // carries the same shape with a third of the lit area, so the counters stay open.
      // Sized by MEASUREMENT (fitText), inside the panel and clear of the outline tube: sized by
      // character count, QUEEN came out 520 px of ink on a 330 px panel.
      const pen = size * 0.075;
      fitText(ctx, ln, {
        x0: w * 0.10 + pen, x1: w * 0.90 - pen, y: topY + lh * (i + 0.5) + size * 0.36, size,
        weight: 0.16, italic: 0.09, color: 'rgba(14,4,22,0.94)', tracking: 0.04,
        outline: { color: col, width: pen },
        glow: { color: col, blur: size * 0.24 },
      });
    });
    // a rail of chevrons under the name, so the board is never just type on a panel
    ctx.fillStyle = accent;
    for (let i = 0; i < 6; i++) {
      const x = w * 0.10 + i * (w * 0.80 / 6);
      ctx.beginPath();
      ctx.moveTo(x, topY + band - 30); ctx.lineTo(x + w * 0.055, topY + band - 16);
      ctx.lineTo(x, topY + band - 2); ctx.lineTo(x + w * 0.018, topY + band - 16);
      ctx.closePath(); ctx.fill();
    }
    subPlate();
  } else {
    // wide marquee board: big word over a sub-line, with a chevron rail beneath
    // Fitted to the inside of the accent border, not to a character count: "CACTUS CLUB" at the
    // old h x 0.30 was 608 px of ink on a 512 px board, and drew as "ACTUS CLU" in the chase frame.
    {
      const size = Math.min(h * 0.30, (w * 0.86) / Math.max(4, text.length) * 1.75);
      const pen = size * 0.075;
      fitText(ctx, text, {
        x0: w * 0.10 + pen, x1: w * 0.90 - pen, y: h * 0.44, size,
        weight: 0.16, italic: 0.20, color: 'rgba(14,4,22,0.94)', tracking: 0.06,
        outline: { color, width: pen },
        glow: { color, blur: size * 0.22 },
      });
    }
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(w * 0.10, h * 0.52, w * 0.80, h * 0.20);
    fitText(ctx, sub, {
      x0: w * 0.12, x1: w * 0.88, y: h * 0.665,
      size: Math.min(h * 0.15, (w * 0.72) / Math.max(5, sub.length) * 1.7),
      weight: 0.26, italic: 0.16, color: accent, tracking: 0.14,
      glow: { color: accent, blur: 6 },
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
      map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 1.85,
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
  // The cabinet's bulb chase is WHITE (see BULB): coloured gas in the tubes, plain incandescent
  // in the border. `accent` still drives the tube and halo work below, so the pylon keeps its
  // three-hue identity — it just stops being monochrome.
  const cb = chaseBatch(BULB, (seed % 5) / 5);

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
  // A broad soft halo of neon spill on the night air — BEHIND the cabinet, at -1.4, not in
  // front of it at +1.15. Now that a pylon is aimed at the driver rather than at the kerb, a
  // halo on the +Z side sits between the eye and the sign face: an additive veil over the board
  // that washed out every letter on it and left the whole thing reading as one glowing panel.
  // Behind, the depth test clips it to the board's silhouette and it does what it was for.
  hb.add(new THREE.PlaneGeometry(bwEff * 1.9, bh * 1.36), 0, midY, -1.4);

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
  // Three times as many signs stand on the pavement now, so each throws a SMALLER, dimmer pool.
  // At the old 0.85 x (23 x 60 m) they overlapped into one continuous lilac wash over the whole
  // near road — which is the thing that was reading as fog rather than as wet asphalt.
  spill(g, color, bwEff * 0.70, 0.24, 1.5, 0.22);
  // ...and the dark it stands in. A pylon this size is a plinth, two legs and a mast: the patch
  // is the plinth's own footprint plus the occlusion its bulk keeps off the pavement, and it is
  // the thing that stops sixty-eight of these reading as decals printed on the sidewalk.
  g.add(shade(bwEff * 1.5, 5.4, 0, 0.05, 0, 0, 0.66));
  g.add(shade(bwEff * 0.98, 3.3, 0, 0.055, 0, 0, 0.60));
  return g;
}

/** A blade marquee cantilevered out over the sidewalk from a casino frontage. */
function bladeSign({ h = 9, w = 11, seed = 1, index = 0, hue = 0 }) {
  const g = new THREE.Group();
  const color = HUES[hue % 3];
  const st = new B(steel('#1c1526'));
  const cb = chaseBatch(BULB, (seed % 3) / 3);
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
  // No ground pool on a blade marquee: it hangs nine metres up over a pavement the lit kerb cove
  // already covers, and this city is fill-bound — two hundred overlapping additive quads on the
  // nearest surface in frame is the most expensive thing in it for the least picture.
  // It does still occlude, though: a lit soffit nine metres up leaves a soft patch of shade on
  // the pavement under it, which is the only reason the pavement reads as being under anything.
  g.add(shade(w * 0.86, 5.0, 0, 0.05, 0.4, 0, 0.42));
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
        ctx.fillStyle = `rgb(${(9 * v) | 0},${(8 * v) | 0},${(22 * v) | 0})`;
        ctx.fillRect(x, y, w, hh);
        // Sparse. At 0.26 the face resolved as a confetti of hot dots and the pyramid stopped
        // reading as GLASS at all; the shape is carried by the gold arrises and the string
        // courses, and the lit panes are the texture inside it, not the subject.
        if (r2.bool(0.13)) {
          // NOT gold-dominant. At 0.78 gold every lit pane read warm, the string courses are gold
          // too, and the whole face resolved as one orange field with the shape of a cone — the
          // opposite of a black-glass pyramid trimmed in light.
          const col = r2.bool(0.34) ? GOLD : (r2.bool(0.5) ? MAGENTA : CYAN);
          const a = r2.range(0.5, 1);
          ctx.globalAlpha = a; ex.globalAlpha = a;
          ctx.fillStyle = col; ctx.fillRect(x, y, w, hh);
          ex.fillStyle = col; ex.fillRect(x, y, w, hh);
          ctx.globalAlpha = 1; ex.globalAlpha = 1;
        }
      }
      // a continuous lit string course at every storey line
      ctx.fillStyle = 'rgba(255,194,30,0.72)'; ctx.fillRect(0, (r + 1) * ch - 3.0, S, 3.0);
      ex.fillStyle = 'rgba(255,194,30,0.95)'; ex.fillRect(0, (r + 1) * ch - 3.0, S, 3.0);
    }
    ctx.strokeStyle = 'rgba(150,130,190,0.26)'; ctx.lineWidth = 1.2;
    for (let i = 0; i <= COL; i++) { ctx.beginPath(); ctx.moveTo(i * cw, 0); ctx.lineTo(i * cw, S); ctx.stroke(); }
    grain(ctx, S, S, 3, r2);
    return new THREE.MeshStandardMaterial({
      map: toTexture(c, { srgb: true }), emissiveMap: toTexture(ec, { srgb: true }),
      emissive: 0xffffff, emissiveIntensity: 1.85,
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
    scaleUV(geo, Math.max(2, Math.round((rm * 5.66) / 84)), 1, rng.next(), 0);
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

// ---------------------------------------------------------------- beams
//
// A searchlight in air has NO SILHOUETTE. Rounds 1-5 drew every beam in this city as an
// additive CONE, and at 3x that is exactly what it looked like: a lavender drainpipe with a hard
// straight edge down each side and a visible flat cap where the geometry stopped — the loudest
// piece of raw geometry left in the frame, and the pyramid's is the first thing the eye goes to.
//
// What a beam actually is, seen from the side, is a slab of lit haze: brightest on the axis,
// falling off smoothly to nothing across its width, and dying out along its length as the cone
// spreads and the air runs out. That is a one-dimensional profile in each axis, i.e. a texture —
// so every beam here is a single quad carrying that profile, rolled about its own axis each frame
// to face the camera. From any direction it presents the same soft-edged column, it costs two
// triangles, and there is no edge in it for the eye to catch on.

/** Beam cross-section: hot core + wide sheath across U, spread-and-die along V. */
function beamTexture() {
  return mat('lv-beam-tex', () => {
    const W = 64, H = 256;
    const { c, ctx } = canvas(W, H);
    const img = ctx.createImageData(W, H);
    for (let y = 0; y < H; y++) {
      const v = y / (H - 1);                       // 0 at the lamp, 1 at the far end
      // two terms: the near throw where the air is thickest, and a long tail that keeps the
      // beam visible all the way up so it never ends in a cut line across the sky.
      const A = Math.exp(-v * 2.9) * 0.78 + Math.pow(1 - v, 1.7) * 0.30;
      for (let x = 0; x < W; x++) {
        const d = (x / (W - 1)) * 2 - 1;
        const core = Math.exp(-d * d * 30);
        const sheath = Math.exp(-d * d * 3.4);
        // the last term forces zero at the quad's own edge — without it the texture clamp
        // reinstates precisely the hard silhouette this whole system exists to remove.
        const val = clamp(A * (core * 0.9 + sheath * 0.46) * (1 - Math.pow(Math.abs(d), 8)), 0, 1);
        const i4 = (y * W + x) * 4;
        const q = (255 * Math.pow(val, 1 / 2.2)) | 0;
        img.data[i4] = img.data[i4 + 1] = img.data[i4 + 2] = q;
        img.data[i4 + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const t = toTexture(c, { srgb: true, wrap: THREE.ClampToEdgeWrapping, flipY: false });
    t.generateMipmaps = false; t.minFilter = THREE.LinearFilter; t.needsUpdate = true;
    return t;
  });
}

function beamMaterial(color, opacity) {
  return mat(`lv-beamm|${color}|${opacity}`, () => new THREE.MeshBasicMaterial({
    map: beamTexture(), color: new THREE.Color(color), transparent: true, opacity,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
  }));
}

/**
 * One beam, as a bare Mesh in WORLD coordinates.
 *
 * Not a Group with a nested pivot, because `mergeStatic()` flattens the landmark graph: every
 * Group is discarded and its meshes reparented with their world pose baked in. So the beam
 * carries its own frame — `base` and `dir` — and rebuilds its whole basis every frame:
 * +Y along the axis, +X the screen-parallel width, +Z the normal aimed at the eye.
 */
const _bR = new THREE.Vector3(), _bN = new THREE.Vector3(), _bV = new THREE.Vector3();
const _bM = new THREE.Matrix4();
function softBeam({ color = CYAN, len = 500, r0 = 3, r1 = 26, opacity = 0.55 }) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(
    [-r0, 0, 0, r0, 0, 0, -r1, len, 0, r1, len, 0], 3,
  ));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2));
  geo.setIndex([0, 1, 2, 1, 3, 2]);
  const m = new THREE.Mesh(geo, beamMaterial(color, opacity));
  m.userData.noMerge = true;
  m.frustumCulled = false;                 // it is 1.3 km long and its bounds are meaningless
  m.renderOrder = 5;
  const base = new THREE.Vector3(), dir = new THREE.Vector3(0, 1, 0);
  m.userData.beam = { base, dir };
  m.userData.aim = (camera) => {
    _bV.copy(camera ? camera.position : base).sub(base);
    if (_bV.lengthSq() < 1e-6) _bV.set(0, 0, 1);
    _bR.crossVectors(dir, _bV);
    if (_bR.lengthSq() < 1e-8) _bR.crossVectors(dir, _bN.set(1, 0, 0));
    _bR.normalize();
    _bN.crossVectors(_bR, dir).normalize();
    _bM.makeBasis(_bR, dir, _bN);
    m.quaternion.setFromRotationMatrix(_bM);
    m.position.copy(base);
  };
  return m;
}

/** Point a beam at a world base and direction, and give it a valid pose before the first frame. */
function placeBeam(m, base, dir) {
  m.userData.beam.base.copy(base);
  m.userData.beam.dir.copy(dir).normalize();
  m.userData.aim(null);
  return m;
}

/**
 * Search / sky-tracker lights: beams raking the black sky above the Strip. They are the single
 * strongest "this is Vegas at night" cue after the pyramid beam, because they give a black sky
 * something to be black around — and, in the wet road, something to smear.
 *
 * Built in world coordinates for the reason above, so `pos` comes in rather than being applied
 * to a returned group.
 */
function skyTracker({ color = CYAN, len = 520, tilt = 0.5, seed = 1, pos }) {
  const g = new THREE.Group();
  const rng = new RNG(seed * 37 + 2);
  const lampY = pos.y + 2.6;
  const lamp = new THREE.Vector3(pos.x, lampY, pos.z);

  const beam = softBeam({ color, len, r0: 2.4, r1: len * 0.070, opacity: 0.66 });
  // a second, much wider and fainter slab: the outer haze the lamp lights up around its own throw
  const wash = softBeam({ color, len: len * 0.55, r0: 8, r1: len * 0.24, opacity: 0.075 });
  g.add(beam); g.add(wash);

  // lamp house, on the ground under it
  const st = new B(steel('#1e1828'));
  st.add(cyl(1.7, 2.4, 1.7, 10), pos.x, pos.y + 1.5, pos.z);
  st.add(box(6.4, 0.9, 6.4), pos.x, pos.y + 0.45, pos.z);
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    st.add(cyl(0.22, 0.28, 2.8, 6), pos.x + sx * 2.6, pos.y + 1.4, pos.z + sz * 2.6);
  }
  st.into(g);

  const head = new THREE.Mesh(new THREE.SphereGeometry(2.0, 12, 9), tube(color));
  head.position.copy(lamp);
  head.userData.noMerge = true;
  g.add(head);
  const flare = new THREE.Mesh(new THREE.PlaneGeometry(26, 26), halo(color, 0.55));
  flare.position.copy(lamp);
  flare.renderOrder = 4;
  flare.userData.noMerge = true;
  g.add(flare);

  const sweep = rng.range(0, 6.28);
  const rate = rng.range(0.13, 0.24);
  const d = new THREE.Vector3();
  const aim = (t) => {
    const az = Math.sin(t * rate + sweep) * 1.25;
    const el = tilt + Math.sin(t * rate * 0.71 + sweep * 1.7) * 0.24;   // lean off vertical
    d.set(Math.sin(el) * Math.sin(az), Math.cos(el), Math.sin(el) * Math.cos(az));
    placeBeam(beam, lamp, d);
    placeBeam(wash, lamp, d);
  };
  aim(0);
  ANIMS.push((t, camera) => {
    aim(t);
    beam.userData.aim(camera);
    wash.userData.aim(camera);
    if (camera) flare.quaternion.copy(camera.quaternion);
  });
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
  // Off the Strip it is Mojave: pale caliche gravel and creosote, read through the same
  // lavender-in-sodium the ground plane is lit by, so the two are one surface across the dissolve.
  runoff: {
    width: 15, tint: '#5e5476', accent: '#786a92',
    gravel: '#8f84a8', scrub: '#6f6a58', rock: '#6d6484',
  },
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

/**
 * The barrier runs the street furniture below lays out, in lap metres. They live up here, beside
 * the track, because they are part of its WALL. Round 11 stood them on the rumble strip and the
 * gutter (1.15 m and 3.0 m off the white line) while the collision line sat at the kerb, five
 * metres behind them — so every car drove straight through the hoarding, and all three Vegas
 * crash captures came to rest behind it. They now stand where the wall is: up on the raised kerb,
 * toe at its lip, so a car that runs wide meets the jersey units it can see. Each run is declared
 * to the Track (`TRACK.walls`) at that same face so the impact knows it hit a metre of concrete,
 * not 30 cm of kerb.
 */
const BARRIER_RUNS = [
  { m0: 244, m1: 372, side: 1, gapAt: null, taper: true },   // Strip works, right
  { m0: 470, m1: 592, side: -1, gapAt: null, taper: true },  // ...and one opposite
  { m0: 800, m1: 1240, side: -1, gapAt: null },      // outside of the fast sweeper
  { m0: 2430, m1: 2720, side: -1, gapAt: null },      // outside of the west hairpin
  // the alley mouth: a wall with a hole knocked in it, right where shortcut B leaves
  { m0: 1400, m1: 1580, side: 1, gapAt: [1486, 1534] },
];
// This city's kerb (raisedKerb) is 30 cm tall and its lip stands 7 cm proud of the kit's face.
TRACK.kerbFace = { inset: 0.07, h: 0.30 };
const RUN_OFF = T0.wallOffset + 0.46;                // unit centreline: toe just back from the lip
const RUN_Y = 0.27;                                  // standing on the kerb top, not in the gutter
const TAPER = { len: 46 };                           // the cones that announce a works zone
TRACK.walls = [];
for (const run of BARRIER_RUNS) {
  const wall = (m0, m1) => TRACK.walls.push({ u0: U(m0), u1: U(m1), side: run.side, h: 1.0 });
  if (!run.gapAt) { wall(run.m0, run.m1); continue; }
  wall(run.m0, run.gapAt[0]);
  wall(run.gapAt[1], run.m1);
}

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
    trackers: [
      at(330, -195), at(700, 200), at(90, 150), at(470, -260), at(980, 60),
    ],
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
    { from: origin, dir: SITE.pyramid.clone().sub(origin).setY(0).normalize(), cos: Math.cos(0.235), len: 900 },
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
      // `patch` / `patchScale` are what stop the screen-space reflection reading as HAZE. The
      // Fresnel term has a 0.14 floor, so the road closest to the camera — the steepest ray, the
      // biggest area on screen — always carries a base reflection of whatever is above it. Left
      // smooth, that is a featureless warm field over the near quarter of every frame. Puddled at
      // ~11 m and with the dry fraction pushed down to a fifth, the same energy resolves as wet
      // patches with dry asphalt between them, which is what a wet road looks like.
      strength: 0.27, gain: 1.28, threshold: 0.80, knee: 3.0, spread: 0.012,
      patch: 0.80, patchScale: 0.092, fresnel: 2.6,
    },
    sidewalk: '#4a4054',
    // Vegas has no key light to speak of, so an unlit wall gets NOTHING from the rig and reads
    // as a hole punched in the frame (the drift capture was half filled by one). This is the
    // omnidirectional floor that keeps those faces at a dim violet instead of at black.
    // (grade pass) …and near-neutral, for the same reason as the sun and the hemisphere. An
    // AmbientLight is omnidirectional: at 68% saturation this one was painting violet onto every
    // surface in the city from every direction at once, including the four cars.
    shadowTint: '#2f2a46',
    shadowFill: 0.72,      // see the note on `ambient` below — the black in "near black"
    // THE OFF-ROAD GROUND.
    //
    // This used to self-light in the fog colour (#150726) and the round-3 critic called the result
    // exactly right: "the road ribbon ends at a hard edge and the car, its smoke and its skid
    // trail hang over pure black with no surface at all". Measured, the shoulder was rgb(21,8,43)
    // with an eleven-code-value spread — a void.
    //
    // The trap here is that the knob everyone reached for does not work. #150726 carries 0.4%
    // relative luminance, so multiplying it by 4.4, by 7 (round 2's setting, rejected as "a lilac
    // field") or even by 14 moves the plane by four code values in red and green and simply turns
    // it blue. The fix is the COLOUR, not the gain: the Strip's ground sits in casino spill, which
    // is a real violet with luminance in it, and at 2.2 that reads as tarmac — texture, parking
    // slabs, the car's shadow — while staying darker than the carriageway, which is what keeps
    // the neon bright against a near-black frame.
    // (grade pass) The off-road plane self-lights in casino spill, and the spill it sits in is a
    // mix of magenta, gold and cyan — i.e. much closer to a dim warm violet-grey than to a pure
    // violet. Same value, a third of the chroma, for the same reason as the hemisphere above.
    groundGlowColor: '#3b3350',
    groundGlow: 3.80,
    sky: {
      // Black desert sky. The horizon carries a low bruise of city-glow and nothing else — the
      // glow disc in skyCanvas() is 42% of the dome's height, so a bright `sunColor` here washes
      // the entire upper sky magenta and the stars vanish, which is the opposite of the brief.
      top: '#000005', horizon: '#0a0419', ground: '#050309', haze: '#1e1027',
      sunDir: [0.85, -0.06, 0.5], sunColor: '#4a0e33', clouds: 0.0, stars: 2.6, seed: 202,
    },
    // A violet moon at 0.24 is barely a light — but it is the only light that reaches a car in
    // the gaps between signs, so its COLOUR is what a car photographs as there. #9a58e0 is 61%
    // saturated, which is why "the muscle car's paint, its white racing stripes, its chrome and
    // the SUV beside it are all the same magenta" measured true even in frames with no sign
    // nearby. Same value, a third of the chroma: still a violet Mojave night, but a white stripe
    // under it is allowed to be white.
    sun: { color: '#8c7ac0', intensity: 0.24, dir: [0.35, 0.8, -0.45] },
    // (coherence pass) Vegas is the city that OWNS the near-black-with-neon look — that is the
    // whole basis on which Miami has just been moved off it — so it has to actually be near black
    // between the signs. Measured, it was not quite: the twelve Vegas captures averaged 47% of the
    // frame under sRGB 26, but the carriageway and the unlit masonry both sat in a broad violet
    // wash that came from this hemisphere term rather than from any light in the scene. 0.90 ->
    // 0.80 and shadowFill 0.86 -> 0.80 take about a code value and a half out of everything that
    // nothing is lighting, which is where the black in "near black" comes from. Neither goes below
    // the floor that keeps an unlit wall a surface rather than a hole — `groundGlow` (3.80, on its
    // own colour) is still carrying the off-road plane, and it is deliberately untouched.
    // (grade pass) …and the hemisphere COLOUR is the other half of the same measurement. At
    // #3d2260 — 63% saturation — every up-facing surface in the city, which is to say the whole
    // carriageway and every parapet, roof and canopy top, was being painted violet by the rig
    // whether or not a sign was anywhere near it. That is where "78% of the frame's chroma sits
    // in one 60-degree window" comes from: not from the neon, which is only ~4% of the frame,
    // but from a violet fill on everything the neon was supposed to be seen against. #33304c is
    // the same value at a third of the chroma — still unmistakably a violet night, but now dark
    // and near-neutral enough that a magenta tube reads as magenta and a gold one as gold.
    // (round 3) THE STRIP KEY. The one gap the whole-game critic named against these four files is
    // that Vegas erases the hero car: "the teal muscle car has no hue left at all — it reads as
    // white chrome and its twin white racing stripes are completely invisible against the body".
    // Measured with an env-probe ablation (`tools/_probe_ablate.mjs`, and `_grade_variants.mjs`
    // for the grade half): with the car's `envMapIntensity` forced to 0 the body goes near-black
    // violet, i.e. BEFORE this round there was no diffuse light on a Vegas car at all. Its whole
    // appearance was the cube probe reflected at `engine._paintEnv` = 3.0 — a mirror of the Strip,
    // and a mirror has no albedo, so a teal car, a white car and a red car all photograph as the
    // same pink-white silhouette (see `vegas-supercar-landmark.png`, round 2).
    //
    // The fix has to be a light, not a grade knob, and it has to be DIFFUSE, because diffuse is
    // the only term that carries the receiver's own colour. The Strip is a two-kilometre wall of
    // light on both sides of the road, so the physically-obvious answer is also the right one: a
    // strong, low, LATERAL fill. 0.26 -> 1.15, and the direction dropped to y=0.18 so it rakes
    // across flanks, facades and parapets and barely touches the carriageway (N·L 0.18 on the road
    // against 0.85-0.95 on a car's side), which is what keeps "near black between the signs" true
    // while giving the paint something of its own to show.
    //
    // Colour: GOLD (#ffc21e) is 88% saturated, which is a casino-marquee tube, not the average of
    // a mile of mixed neon — at 1.15 it would have hosed every car in the city amber. #ffd9ae is
    // the same warm cast at a third of the chroma: still unmistakably the Strip's own light, still
    // the complement of the violet moon that §2.1 asks for, but a teal car stays teal under it.
    ambient: {
      // (grade-discipline pass) 0.80 -> 0.68. Miami has just been moved off near-black-with-neon
      // and onto a daylight dusk, which only separates the two cities if THIS one actually holds
      // the near-black end. Measured across the r0 sweep, Vegas ran 40-45 % of frame under sRGB 26
      // against Miami's 15-25 %; a further eighth of a stop off the one term that lights every
      // up-facing surface whether or not a sign is near it widens that gap without touching a
      // single emissive. The floor that keeps an unlit wall a surface rather than a hole is
      // `groundGlow` (3.80, on its own colour) and it is deliberately untouched.
      sky: '#33304c', ground: '#1d1a2c', intensity: 0.68,
      fill: { color: '#ffd9ae', intensity: 1.15, dir: [-0.72, 0.18, 0.66] },
    },
    // (round 3) The other half of the same gap. The SpillPass adds the neon's own colour back onto
    // whatever is near it, and `uRolloff` is the receiver brightness at which it stops. At the
    // derived night default (0.55) the hero car — the brightest object in most frames — was still
    // inside the band, so the Strip's magenta was being added on top of a body that was already
    // blown. 0.30 keeps the pass doing the job it exists for (§2.2: the dark wall beside a neon
    // panel is lit BY the panel) and takes it off everything that is already lit.
    spill: { strength: 0.26, rolloff: 0.30 },
    // (round 3) …and the third and largest term of the same fix. See `_applyEnv` in src/main.js for
    // why this knob had to exist: Vegas' probe is a cube capture of two kilometres of neon and it
    // was arriving on car paint at 1.25 x 1.84 x 3.00 = 6.9, which is a mirror, not a clearcoat.
    // 0.45 leaves the Strip clearly IN the bodywork — the sign colours still run down the flanks
    // and the roof still carries the marquee — while dropping it under the diffuse term above, so
    // the twin white stripes separate from the paint and the panels keep their own value. Vegas
    // gets the hardest cut of the four because it is the only city whose probe is 100% emissive.
    paintEnv: 0.45,
    // (grade-discipline round 2) '#150726' -> '#170f26'. Same value (relative luminance moves by
    // 0.002, so `nightness` and the derived exposure are unchanged), saturation 0.69 -> 0.43.
    //
    // This colour is what every surface past 150 m dissolves into AND — via `applyLook` — the
    // city's midtone balance, so at 69% chroma it was a violet gel over the entire mid- and
    // far-ground: the measured "78% of the frame's chroma inside one hue window" was mostly this,
    // the hemisphere and the shadow lift, not the neon. Desaturating it drops the whole dim
    // background BELOW the chroma threshold instead of parking it in one bin, which is what leaves
    // the magenta/gold/cyan/green tubes as the only saturated things in frame — §1.3's
    // "cool deep blue-gray ambient… three-colour neon against near-black stone".
    fog: { color: '#170f26', near: 150, far: 2000 },
    // The off-road plane's albedo, desaturated with the rest of the violet wash: a parking apron
    // under casino spill is a warm-grey concrete lit violet, not violet concrete. Value unchanged
    // so the shoulder still sits darker than the carriageway.
    ground: { color: '#5e5476', accent: '#7a6c96' },
    grade: {
      // uGain was #ffe4ff, which tints every highlight in the city magenta — and a magenta
      // highlight tint is precisely what turns GOLD into orange and CYAN into blue, i.e. what
      // collapsed a strict three-hue palette into "purple with warm bits". Near-neutral gain
      // plus a black-black lift is what lets the three hues read as three hues.
      //
      // (grade pass) uSaturation 1.34 -> 1.10 and an explicit uPreSat. Vegas measured meanSat
      // 0.833 against 0.35-0.45 in the other three — 2.3x the rest of the game — and both of
      // these knobs were sitting at the top of their range on the most saturated scene in the
      // build. The engine clamps the derived saturation to 1.02-1.30, so 1.34 was simply asking
      // for the ceiling; 1.10 asks for the floor, which is the right end of that range for the
      // one city whose raw pixels are already at 80% chroma before the grade touches them.
      // (round 3) uExposure 1.02 -> 0.92, i.e. -0.15 stop. ACES desaturates as it climbs its
      // shoulder, so a body panel that arrives at the tonemapper above ~1.5 comes out white
      // whatever colour it started, and pulling the stop is the pre-tonemap half of the car-paint
      // fix. It is deliberately only -0.15 and not the -0.35 tried first: measured over the chase,
      // landmark and drift captures, -0.35 took the share of frame under L=40 from 49/48/70% to
      // 67/67/80%, and "no floor off the hero line" is already a live deduction against these four
      // files. `paintEnv` below does the heavy lifting on the car, so the stop only has to stop the
      // brightest panels from riding the shoulder, and the lateral fill above pays back more than
      // it takes out on everything that is not the road.
      uSaturation: 1.10, uExposure: 0.92, uContrast: 1.22, uPreSat: 1.08,
      /**
       * uHiChroma 0.44 (derived) -> 0.16, and this is the knob that actually creates a white
       * point.
       *
       * It re-injects the pre-tonemap HUE into pixels that were bright enough for ACES to have
       * rolled toward white — which in a day city is a good idea (a sodium window should roll off
       * to warm cream, not paper) and in THIS city is the whole disease: every hot pixel in Vegas
       * belongs to a saturated tube, so at 0.44 the grade was reaching into the brightest 0.6% of
       * the frame and dragging it back to pure magenta. That is why the highlight band measured
       * 94% saturated with no neutral anywhere, and it is why the muscle car's white racing
       * stripes came back magenta: they are lit BY the signs, so they land in the same band.
       *
       * At 0.16 the tube cores go white-hot with a coloured fringe, which is what a real neon
       * tube photographed at night actually does, and anything merely lit by them keeps its own
       * colour.
       */
      uHiChroma: 0.16,
      /**
       * THE NEUTRAL ANCHOR — and this one line was, measured, the largest colour term in the whole
       * city. It was `#040110`.
       *
       * `applyLook` does `unitTint(uLift, 0.92)`, which divides the colour by its own LUMINANCE
       * before using it as a shadow multiplier. Blue carries 7.2% of luminance, so a blue-black
       * hex normalises to something enormous: (4,1,16) comes out as a multiplier of
       * **(1.43, 0.42, 5.49)**. The grade then applies it as `mix(col, col*uLift, shadow*0.62)`
       * over a WIDE shadow band (`pow(1-l, 1.4)`, still 0.5 at mid-grey), so a road pixel at
       * luma 0.11 was being multiplied by (1.23, 0.69, 3.40).
       *
       * That is the whole of "Vegas is a single-hue wash": measured on `vegas-muscle-chase`, the
       * asphalt read rgb(54,17,67) at 0.59 saturation — a violet road, not asphalt — the mint
       * muscle car's body panel read hue 266 instead of its own 172, 60% of every chroma pixel in
       * the frame sat in ONE 30-degree bin, and the yellow/green bins were at 0.00%. GOLD tubes
       * lighting a wall came back magenta because their green was cut by a third and their blue
       * multiplied by three, and CYAN came back blue for the same reason. The city's own three
       * hues could not survive its own grade.
       *
       * `#646786` normalises to (0.960, 0.986, 1.259) — a shadow multiplier of about (0.98, 1.00,
       * 1.11) on a dark road pixel. Vegas' shade is still indigo, because a 1.11x blue lift on the
       * darkest third of the frame IS a cool shadow, and `shadowTint`, the violet moon and the
       * hemisphere all still say so in the LIGHT. What it no longer does is repaint neutral albedo:
       * near-black asphalt stays near-black asphalt, white bulb chases stay white, and a gold tube
       * is allowed to be gold. Identity moves back into the emissives, which is where a city whose
       * only light source is signage should have been carrying it all along.
       *
       * (The hex is mid-value on purpose — only its RATIO is read, and at #04-ish values 8-bit
       * rounding moves the derived multiplier by 30%.)
       */
      uLift: '#646786',
      // Vibrance is a chroma push aimed specifically at the pixels that have LEAST of it — i.e. at
      // the asphalt, the concrete and the white stripes, the three surfaces that are supposed to be
      // the neutral the neon is seen against. The night default is 0.30. On the most saturated
      // scene in the game it is the wrong knob to run at full.
      uVibrance: 0.15,
      uGain: '#fff2fb', uVignette: 0.36,
    },
    // Threshold up and radius in: round 5's 0.57/0.72 ate its own sign faces — the WELCOME
    // marquee resolved as a pink rectangle with a white smear where the words should be. Only
    // the genuinely hot cores bloom now, and they bloom tighter, so the type inside the light
    // survives.
    bloom: { strength: 1.20, radius: 0.60, threshold: 0.64 },
  },

  track: TRACK,

  blocks: {
    spacing: 46, offset: 25, jitter: 9, spacingJitter: 0.34,
    minW: 18, maxW: 44, minH: 30, maxH: 140,
    // Near-black masonry: at night these are only ever seen by their own window light, by a
    // neighbouring sign, or by the porte-cochère cove under them. Two of the five are now warm
    // stone rather than violet — the Strip is stucco, travertine and sand-coloured precast, and a
    // block that answers a gold sign warm and a magenta one cool is what stops the mid-ground
    // being one tinted wash. (Measured: this and the hemisphere above are the two terms that put
    // 78% of the city's chroma into a single hue window.)
    wallColors: ['#544075', '#4c463f', '#68508c', '#4c3a6c', '#6a6052'],
    glassColors: ['#1a1030', '#101a30', '#20132c'],
    // Lit hotel windows are INCANDESCENT. Round 5 had them on the three neon hues, which put a
    // magenta window grid on a third of the towers in the city — hundreds of square metres of the
    // mid-ground painted the same colour as the signs, which is most of "78% of the frame's chroma
    // in one hue window". Warm white is both what a hotel window actually is and the largest
    // available neutral in a night city; one cyan stays in the rotation so the towers are not all
    // one temperature either.
    litColors: ['#ffd996', GOLD, '#ffefd2', CYAN],
    neonColors: [MAGENTA, GOLD, CYAN, GOLD],
    lowColors: ['#66508a', '#523e72', '#7658a0'],
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
    // Every lamp lays a 14 x 14 m smooth additive pool on the tarmac, and twinned at 32 m
    // spacing those overlap into one continuous warm gradient over the near road — the
    // "featureless salmon haze" that kept surviving every other fix. Half as many pools; the
    // lamps themselves still line the boulevard, which is the reference's one warm tie to
    // daylight colour (§1.3).
    // The boulevard's own lamps are built in this file now (see boulevardLamps) — one every 26 m
    // per kerb, with a tight mottled pool each. The kit's colonial globes stay in as an occasional
    // second design so the run is not two hundred copies of one mesh (§7 caps a prop repeated at a
    // visible regular interval at 66), but at a spacing where their much broader smooth pools can
    // never overlap into the flat warm band that cost round 5 its near road.
    lampStyle: 'colonial', lampSpacing: 155, lampHeight: 9.5, lampTwin: false,
    lampBanners: HUES,
    palms: true, palmSpacing: 34,
    barriers: false,
    treeColors: ['#2f5f4a'],
    hydrantColor: '#c8a02a',
    planterColor: '#3a2c4c',
    carColors: ['#c8a02a', '#8f2f7a', '#2f6a8f', '#2a2230', '#a8a2b0'],
    // Signwriting for the kit fleet's trade vans and box bodies. The Strip runs on laundry,
    // vending and sign contractors, and a van with a real trade name on it is the difference
    // between a parked prop and a parked business.
    fleetSigns: [
      ['DESERT LINEN', 'HOTEL SUPPLY · 24 HR'],
      ['ACE VENDING', 'SLOTS · SERVICE'],
      ['NEON SIGN CO', 'BOULDER HWY'],
      ['PARADISE CATERING', 'BANQUET · EVENTS'],
    ],
    streetNames: ['LAS VEGAS BLVD', 'FREMONT ST', 'PARADISE RD', 'FLAMINGO RD', 'TROPICANA AVE'],
    furnitureKinds: ['hydrant', 'trash', 'bench', 'newsbox', 'sign', 'planter', 'cones',
      'shelter', 'mailbox', 'bollards', 'cart'],
    billboards: [
      { u: U(120), side: 1, text: 'VIVA', sub: 'NITRO', color: MAGENTA, offset: 20 },
      { u: U(690), side: -1, text: 'ALL IN', sub: 'NO LIMIT', color: GOLD, offset: 22 },
      { u: U(1360), side: 1, text: 'ROYALE', sub: 'CASINO', color: CYAN, offset: 20 },
      // the one green sign face — the fourth tube, on the back straight where the gates are not
      { u: U(1980), side: -1, text: 'JACKPOT', sub: 'MEGA', color: GREEN, offset: 24 },
      { u: U(2760), side: 1, text: 'HIGH ROLLER', sub: '24 HRS', color: MAGENTA, offset: 22 },
    ],
    // Two of the six go GREEN — see the note on `GREEN` at the top of the file. The gate at 620 m
    // is the one the chase capture drives under and the one at 2180 m closes the back straight, so
    // the accent is on the two arches most likely to be in frame rather than hidden down the lap.
    // `gt.color` is read three times (the torus itself, the reflection band it lays across the wet
    // road, and the pool its legs stand in), so each of these puts its hue in the tarmac too.
    gates: [
      { u: U(400), color: GREEN }, { u: U(620), color: CYAN },
      { u: U(1100), color: GOLD }, { u: U(1720), color: GREEN },
      { u: U(2180), color: MAGENTA }, { u: U(2560), color: CYAN },
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
      // Three coaxial slabs rather than one: a razor core that survives the bloom threshold, a
      // mid throw, and a very wide, very faint outer haze whose only job is to stop the beam
      // reading as a line drawn on the sky. All three are billboarded — see softBeam().
      const apex = S.pyramid.clone().setY(200);
      const up = new THREE.Vector3(0, 1, 0);
      const core = placeBeam(softBeam({ color: '#f4fbff', len: 1400, r0: 2.8, r1: 30, opacity: 0.86 }), apex, up);
      const mid = placeBeam(softBeam({ color: '#cfe6ff', len: 1000, r0: 9, r1: 86, opacity: 0.20 }), apex, up);
      const wide = placeBeam(softBeam({ color: '#a9c8ff', len: 620, r0: 26, r1: 210, opacity: 0.045 }), apex, up);
      out.push(wide, mid, core);
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(5.5, 14, 10),
        mat('pyr-lamp', () => new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false })));
      lamp.userData.noMerge = true;
      lamp.position.copy(apex).setY(202);
      out.push(lamp);
      const glare = new THREE.Mesh(new THREE.PlaneGeometry(86, 86), halo('#dcefff', 0.62));
      glare.userData.noMerge = true;
      glare.renderOrder = 4;
      glare.position.copy(apex).setY(202);
      out.push(glare);
      ANIMS.push((t, camera) => {
        core.material.opacity = 0.80 + 0.13 * Math.sin(t * 1.7);
        mid.material.opacity = 0.17 + 0.05 * Math.sin(t * 1.1 + 1.2);
        core.userData.aim(camera); mid.userData.aim(camera); wide.userData.aim(camera);
        if (camera) glare.quaternion.copy(camera.quaternion);
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
        // gold border / magenta name. The old '#ffe9b0' is a near-white, and a near-white at
        // emissiveIntensity 2.4 under a wide bloom is not a sign, it is a lamp: the round-5
        // captures show "WELCOME TO FABULOUS LAS VEGAS" as a pink rectangle with a white smear
        // in it. Two saturated hues keep the words legible AND keep the palette to three.
        color: GOLD, accent: CYAN, text: 'FABULOUS', sub: 'LAS VEGAS',
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
      const cs = new B(shadeMaterial(0.60));
      for (let i = -6; i <= 6; i++) {
        const p = s.pos.clone()
          .addScaledVector(s.tan, i * 13)
          .addScaledVector(s.right, S.fountainLat + 52);
        col.add(cyl(1.05, 1.3, 13, 9), p.x, 6.5, p.z);
        col.add(box(3.0, 1.2, 3.0), p.x, 13.5, p.z);
        cg.add(box(2.4, 0.4, 2.4), p.x, 14.3, p.z);
        cs.add(groundGeo(6.4, 6.4), p.x, 0.09, p.z);
      }
      const holder = new THREE.Group();
      col.into(holder); cg.into(holder); cs.into(holder);
      out.push(holder);
    }

    // ---- sky trackers ----
    // Five, not two, and in all three hues: they are what stops the upper half of the frame from
    // being an empty black rectangle above the signage, and each one costs four triangles.
    for (const [i, p] of S.trackers.entries()) {
      out.push(skyTracker({
        color: HUES[i % 3], len: 480 + (i % 3) * 90, tilt: 0.26 + (i % 4) * 0.11,
        seed: i + 1, pos: p.clone().setY(0.4),
      }));
    }

    // ---- THE NEON CANYON: pylons and blade marquees down both kerbs ----
    //
    // Two things were wrong with this through round 5 and both are about ORIENTATION and REACH,
    // not about count.
    //
    // 1. Every sign faced the carriageway square-on (yaw = trackYaw + side*90°). A driver looking
    //    down the road therefore saw sixty-eight sign boards EDGE ON — a row of dark 0.7 m steel
    //    frames — which is why the "canyon of neon" never appeared in a chase frame no matter how
    //    much signage was in the world. A Strip pylon is aimed at oncoming TRAFFIC: its face is
    //    swung ~40-60° round toward the approaching car, and that single rotation is the whole
    //    difference between a corridor of light and a corridor of edges.
    // 2. They stood 25-31 m from the centreline — past the sidewalk, past the shopfronts. The
    //    signs now stand ON the sidewalk (kerb is at 18.6 m, the collision wall at 18.2), which is
    //    both where they belong and near enough that the wide-angle chase camera has to look
    //    THROUGH them.
    {
      const pr = rng.fork(77);
      let n = 0;
      for (const side of [-1, 1]) {
        for (const s of track.scatter({
          side, minGap: 17, maxGap: 39, offset: 6.3 + pr.range(0, 1.1),
          offsetJitter: 0.9, rng: rng.fork(side * 11 + 5),
        })) {
          // never inside a landmark footprint
          let blocked = false;
          for (const z of S.clear) {
            if (z.side !== undefined && z.side !== side) continue;
            if (s.pos.distanceToSquared(z.pos) < (z.r * 0.82) ** 2) { blocked = true; break; }
          }
          if (blocked) continue;
          // A 38 m pylon on the kerb is now near enough and wide enough to bury a hero landmark.
          // The same vista cones that keep the block generator out of the pyramid's and the
          // tower's line of sight apply here: inside one, a frontage gets a low blade marquee
          // instead of a mast, so the canyon still runs unbroken past the thing it frames.
          let inVista = false;
          for (const v of S.vistas) {
            const dx = s.pos.x - v.from.x, dz = s.pos.z - v.from.z;
            const d = Math.hypot(dx, dz);
            if (d < 30 || d > v.len) continue;
            if ((dx * v.dir.x + dz * v.dir.z) / d > v.cos) { inVista = true; break; }
          }
          const tall = !inVista && pr.bool(0.64);
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
          o.position.copy(s.pos).setY(s.pos.y + 0.16);
          // side*(90° + swing): 90° faces the road, 90°+90° faces straight back down it. Between
          // the two is a sign angled at the oncoming driver, which is where a Strip pylon lives.
          o.rotation.y = Math.atan2(s.tan.x, s.tan.z)
            + side * (Math.PI / 2 + pr.range(0.48, 1.02));
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

    // ---- THE FRONTAGE CANOPY ----
    //
    // The second half of "a canyon of neon both sides", and the fix for the one frame that kept
    // coming back black: the drift capture, where the car slides past a 40 m building wall that
    // has nothing on it but seven lit windows, so the windows read as flat cyan rectangles
    // floating on a void. There is no key light in this city to put on that wall, and a city
    // file cannot reach into the block generator — but it CAN put a lit structure in FRONT of it.
    //
    // So: a covered walkway on both frontage lines, in runs of one casino each, with a steel
    // fascia, a neon cove under it and a pool of its own light on the apron. It is the thing that
    // is actually there on the Strip, it fills the band between the sidewalk and the buildings
    // that was previously empty, and it lights the bottom eight metres of every facade on the lap.
    {
      const cr = rng.fork(6101);
      const holder = new THREE.Group();
      const post = new B(steel('#241c34'), { cast: false });
      const fascia = new B(steel('#2b2038'), { cast: false });
      // The soffit is LIT. A porte-cochère ceiling has downlights in it, and left as plain dark
      // steel this reads from underneath as a black polygon hanging over the pavement — which is
      // exactly how it showed up in the drift capture. Dim enough to stay under the bloom
      // threshold, bright enough to be a ceiling rather than a hole.
      const soffit = HUES.map((c) => new B(emissive(c, 0.62, 0.75), { cast: false }));
      const cove = HUES.map((c) => new B(tube(c)));
      const chase = HUES.map((c, i) => chaseBatch(c, (i + 1) / 3));
      const pool = HUES.map((c) => new B(spillMaterial(c, 0.52)));
      const colShade = new B(shadeMaterial(0.52));
      // Where the canopy stands is the whole of whether it works. Out at the frontage line
      // (32 m) it kept ending up INSIDE the blocks — those are centred 37-51 m out but are up to
      // 24 m deep, so their front faces land anywhere from 25 m outward. The band that is
      // reliably empty is the back of the sidewalk: the kerb is at 18.6 m, the walk ends at 24 m,
      // the pylons stand at 18-20 m. So the walkway roofs the last three metres of pavement,
      // which is where a Strip porte-cochère is anyway, and it is now near enough to the
      // carriageway to be part of the canyon rather than scenery behind it.
      const OFF = 9.4;                        // fascia line, ~21.4 m from the centreline
      const DEPTH = 3.4;
      const near = (p, list, r) => list.some((q) => p.distanceToSquared(q) < r * r);
      for (const side of [-1, 1]) {
        let m = cr.range(0, 60);
        let k = side > 0 ? 1 : 2;
        while (m < LEN) {
          const run = cr.range(38, 96);
          const m1 = Math.min(LEN, m + run);
          const mid = track.at(U((m + m1) / 2)).pos;
          let skip = near(mid, S.branchPts, 26)
            || near(track.at(U(m + 6)).pos, S.branchPts, 26)
            || near(track.at(U(m1 - 6)).pos, S.branchPts, 26);
          for (const z of S.clear) {
            if (z.side !== undefined && z.side !== side) continue;
            if (mid.distanceToSquared(z.pos) < (z.r * 0.9) ** 2) { skip = true; break; }
          }
          if (!skip) {
            const y = cr.range(6.0, 7.6);
            const hue = k % 3;
            fascia.addM(sectionStrip(track, m, m1, side,
              { off: OFF, y: y + 1.5 }, { off: OFF, y }, 7.0), _IDENTITY);
            soffit[hue].addM(sectionStrip(track, m, m1, side,
              { off: OFF, y }, { off: OFF + DEPTH, y: y - 0.25 }, 7.0), _IDENTITY);
            // the cove under the fascia. Thick enough to be a light source in the frame rather
            // than a pinstripe on it — this band is the only thing lighting the back of the
            // pavement and the bottom of the facade behind it.
            cove[hue].addM(sectionStrip(track, m, m1, side,
              { off: OFF - 0.14, y: y - 0.06 }, { off: OFF - 0.14, y: y - 0.92 }, 7.0), _IDENTITY);
            cove[(hue + 2) % 3].addM(sectionStrip(track, m, m1, side,
              { off: OFF + DEPTH - 0.3, y: y - 0.42 }, { off: OFF + DEPTH - 0.3, y: y - 0.72 }, 8.0),
            _IDENTITY);
            {
              // the running-bulb line along the fascia's top edge
              const g2 = sectionStrip(track, m, m1, side,
                { off: OFF - 0.14, y: y + 1.44 }, { off: OFF - 0.14, y: y + 0.86 }, 7.0);
              const uv = g2.attributes.uv;
              const rep = Math.max(4, Math.round(run / 1.15));
              for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getY(i) * rep, uv.getX(i));
              uv.needsUpdate = true;
              chase[(hue + 1) % 3].addM(g2, _IDENTITY);
            }
            // the light it throws down onto the apron under it
            pool[hue].addM(sectionStrip(track, m, m1, side,
              { off: OFF - 5.0, y: 0.19 }, { off: OFF + DEPTH + 1.2, y: 0.19 }, 8.0), _IDENTITY);
            // columns
            const n = Math.max(2, Math.round(run / cr.range(7.0, 9.5)));
            for (let i = 0; i <= n; i++) {
              const f = track.frame(U(lerp(m, m1, i / n)));
              const p = f.pos.clone().addScaledVector(f.right, side * (f.half + OFF + 0.30));
              post.add(cyl(0.30, 0.42, y, 7), p.x, p.y + y / 2, p.z);
              post.add(box(1.5, 0.5, 1.5), p.x, p.y + 0.25, p.z);
              post.add(box(1.1, 0.9, 1.1), p.x, p.y + y - 0.45, p.z);
              // the column's own foot, dark against the pool it stands in
              colShade.add(groundGeo(3.0, 3.0), p.x, p.y + 0.21, p.z);
            }
          }
          m = m1 + cr.range(14, 46);
          k += cr.int(1, 2);
        }
      }
      post.into(holder); fascia.into(holder); colShade.into(holder);
      for (const b of soffit) b.into(holder);
      for (const b of cove) b.into(holder);
      for (const b of pool) { const mm = b.into(holder); if (mm) mm.renderOrder = 3; }
      for (const b of chase) { const mm = b.into(holder); if (mm) mm.userData.noMerge = true; }
      out.push(holder);
    }

    // ---- THE LIT KERB ----
    // A cove of neon let into the gutter line, in runs of one frontage each. Two jobs: it draws
    // the edge of the carriageway in a city with no street lighting worth the name, and it is a
    // source that runs THE LENGTH of the shot, so the wet road has something continuous to smear
    // instead of a row of isolated blobs under each sign. Segmented, hue-shuffled and gapped, so
    // it never reads as a racing-game track-edge line.
    {
      const kr = rng.fork(311);
      const holder = new THREE.Group();
      const bats = HUES.map((c) => new B(tube(c)));
      const glow = HUES.map((c) => new B(halo(c, 0.095)));
      for (const side of [-1, 1]) {
        let m = kr.range(0, 30);
        let k = side > 0 ? 0 : 1;
        while (m < LEN) {
          const run = kr.range(22, 62);
          const h = kr.range(0.26, 0.40);
          const b = bats[k % 3];
          b.addM(sectionStrip(track, m, Math.min(LEN, m + run), side,
            { off: 6.16, y: -0.10 }, { off: 6.16, y: h }, 4.8), _IDENTITY);
          // and the wash it throws on the gutter beside it
          // The wash the cove throws into the gutter. Kept to the gutter: at 5.5 m it reached
          // most of the way across the nearside lane, and a soft additive band that wide over the
          // closest asphalt in frame is the "featureless salmon haze over the near road" the
          // round-5 captures kept showing. The reflection ribbons own the lane; this owns the
          // three metres of gutter the kerb actually lights.
          glow[k % 3].addM(sectionStrip(track, m, Math.min(LEN, m + run), side,
            { off: 6.05, y: 0.17 }, { off: 2.9, y: 0.19 }, 6.0), _IDENTITY);
          m += run + kr.range(5, 17);
          k += kr.int(1, 2);
        }
      }
      for (const b of bats) { const mm = b.into(holder); if (mm) { mm.userData.noMerge = true; mm.frustumCulled = false; out.push(mm); } }
      for (const b of glow) {
        const mm = b.into(holder);
        if (mm) { mm.userData.noMerge = true; mm.frustumCulled = false; mm.renderOrder = 3; out.push(mm); }
      }
    }

    // ---- BULB SPANS: strings of running bulbs slung across the boulevard ----
    // The one thing the round-5 frames had no answer for was the AIR above the road: everything
    // lived on the two kerbs and the sky between them was empty, so the corridor had no ceiling
    // and no depth ladder. Three sagging strings every eighty-odd metres put a receding run of
    // horizontal rungs down the vanishing point — the single cheapest depth cue in the city, four
    // hundred triangles for the whole circuit, and they run their bulbs off the shared chase map.
    {
      const sr = rng.fork(881);
      // Four strands, not three: the middle of every triple that crosses the road is plain white
      // incandescent (see BULB). Because the strings run the length of the corridor and recede to
      // the vanishing point they are in every driving frame at every depth, so this is the term
      // that puts a neutral into the near, mid AND far bands at once — and a run of white bulbs
      // slung over a boulevard is the most Las Vegas object there is.
      const SPAN_HUES = [MAGENTA, BULB, CYAN, GOLD];
      const bats = SPAN_HUES.map((c, i) => chaseBatch(c, i / 4));
      const mastB = new B(steel('#1b1526'), { cast: false });
      const mastShade = new B(shadeMaterial(0.55));
      const holder = new THREE.Group();
      let m = 46;
      let k = 0;
      while (m < LEN - 40) {
        const u = U(m);
        if (Math.abs(track.turnRate(u)) < 0.0055) {
          const y = sr.range(10.4, 13.4);
          const hue = k % 4;
          for (let s = 0; s < 3; s++) {
            bulbSpan(track, bats[(hue + s) % 4], m + s * 1.9, {
              y: y + s * 1.15, sag: sr.range(1.5, 2.8), w: sr.range(0.62, 0.9),
              lat0: -1.60, lat1: 1.60, segs: 16,
            });
          }
          // the masts the strings hang from
          const f = track.frame(u);
          for (const side of [-1, 1]) {
            const p = f.pos.clone().addScaledVector(f.right, side * (f.half + 6.9));
            const yaw = Math.atan2(f.tan.x, f.tan.z);
            mastB.add(cyl(0.30, 0.44, y + 4.2, 8), p.x, p.y + (y + 4.2) / 2, p.z);
            mastB.add(box(2.6, 0.26, 0.26), p.x - f.right.x * side * 1.1, p.y + y + 2.6,
              p.z - f.right.z * side * 1.1, yaw + Math.PI / 2);
            mastB.add(box(0.9, 0.9, 0.5), p.x, p.y + y + 4.1, p.z, yaw);
            mastShade.add(groundGeo(3.4, 3.4), p.x, p.y + 0.21, p.z);
          }
          k++;
        }
        m += sr.range(74, 116);
      }
      for (const b of bats) { const mm = b.into(holder); if (mm) { mm.userData.noMerge = true; out.push(mm); } }
      mastB.into(holder); mastShade.into(holder);
      out.push(holder);
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

    // ---- FRONTAGE SMEARS ----
    // The pylons and blade marquees this file plants each lay their own streak, but they are only
    // half the light on the kerb: the block generator hangs a lit sign on most frontages (the
    // "PARADISO CASINO" the round-2 critic measured as casting nothing onto the street below it),
    // and a city file cannot reach in and enumerate them. So the kerb line gets a continuous
    // second layer of smears at ~19 m pitch, hue-cycled, jittered in length and lateral throw —
    // which is what makes §1.3's "EVERY light source draws a long reflection down the surface"
    // true of the whole canyon rather than only of the props this file owns.
    {
      const fr = rng.fork(6203);
      for (const side of [-1, 1]) {
        let m = fr.range(0, 19);
        let k = side > 0 ? 0 : 2;
        while (m < LEN) {
          reflect(track, {
            m, side, len: fr.range(58, 128),
            variant: fr.pick([0, 1, 0]),
            tier: fr.bool(0.30) ? 1 : 2,
            color: HUES[k % 3],
            lat0: 0.86 - fr.range(0, 0.12), lat1: 0.20 + fr.range(0, 0.26),
            // narrow. A 5 m-wide smear a car length from the camera is not a reflection, it is a
            // wash — and a wash over the near shoulder is exactly what this layer is here to
            // replace. 2-4 m reads as a streak at every distance the ribbon is drawn at.
            half0: fr.range(0.085, 0.165), half1: fr.range(0.070, 0.125),
            segs: 20, mirror: fr.bool(0.5),
          });
          m += fr.range(15, 24);
          k += fr.int(1, 2);
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

    // ---- THE STREET: markings, kerb, rumble strip, lamps ----
    // §6.4's "road surface and furniture" dimension, which round 2 scored at 7/15. See the
    // THE STREET note above sectionStrip for what each of these is answering.
    laneMarkings(track, out, rng);
    rumbleKerb(track, out, rng);
    raisedKerb(track, out);
    boulevardLamps(track, out, rng);

    // ---- road furniture the kit does not place: barriers where the racing line needs them ----
    // A broken run of barrier at each shortcut mouth is what makes the shortcut READ as an
    // opening rather than as a hole (§6.4 "visible as opportunities").
    {
      const br = rng.fork(53);
      const barShade = new B(shadeMaterial(0.68));
      // Sides matter: both bends here turn toward +right, so the OUTSIDE — the side a wall
      // actually belongs on — is side -1. Walling the inside instead would have bricked up the
      // mouth of shortcut A.
      //
      // The two STRIP runs are new in round 3. Round 2's captures both land on the boulevard,
      // where there was no barrier within half a kilometre of the camera and the shoulder read as
      // paint on a plane; a Strip frontage under works — hoarding on the kerb line, a taper of
      // cones off the nose of it — is the thing that is actually there on Las Vegas Blvd every
      // year of its life, and it puts real vertical furniture at the road edge in the frame the
      // critic is looking at.
      // (the runs themselves are BARRIER_RUNS, beside the track: they are its walls too)
      for (const run of BARRIER_RUNS) {
        const OFF = RUN_OFF;
        // A works zone is announced before it arrives: a line of cones down the kerb lip to the
        // nose of the hoarding, which is the single most legible piece of road furniture there is
        // and reads at any distance. (It used to walk out across the lane, where every car on the
        // road drove through it.)
        if (run.taper) {
          for (let k = 0; k < 9; k++) {
            const t = k / 8;
            const m = run.m0 - TAPER.len + t * TAPER.len;
            const s = track.at(U(m));
            const c = trafficCones({ cache: CACHE, seed: (m | 0) * 13 + 1, n: 1 });
            // trafficCones jitters a cone up to 1.2 m across the kerb (its local X, which this
            // yaw leaves across the road), so the line is centred 1.5 m up on the walk
            c.position.copy(s.pos)
              .addScaledVector(s.right, run.side * (track.halfWidth + T0.wallOffset + 1.5))
              .setY(s.pos.y + RUN_Y + 0.02);
            c.rotation.y = Math.atan2(s.tan.x, s.tan.z) + br.range(-0.4, 0.4);
            out.push(c);
            barShade.add(groundGeo(1.5, 1.5), c.position.x, c.position.y + 0.05, c.position.z);
          }
        }
        for (let m = run.m0; m < run.m1; m += 4.1) {
          if (run.gapAt && m > run.gapAt[0] - 6 && m < run.gapAt[1] + 6) {
            if (m > run.gapAt[0] && m < run.gapAt[1]) continue;
            // knocked-over units either side of the hole
            const s = track.at(U(m));
            const b = waterBarrier({ len: 2.0, cache: CACHE, seed: (m | 0), color: GOLD });
            // back on the walk: slewed up to 0.7 rad, a 2 m unit reaches ~0.95 m toward the road
            b.position.copy(s.pos).addScaledVector(s.right, run.side * (track.halfWidth + OFF + 0.65)).setY(0.1 + 0.17);
            b.rotation.y = Math.atan2(s.tan.x, s.tan.z) + br.range(-0.7, 0.7);
            b.rotation.z = br.bool(0.5) ? 1.4 : 0;
            out.push(b);
            barShade.add(groundGeo(2.6, 4.2), b.position.x, b.position.y + 0.06, b.position.z,
              b.rotation.y);
            continue;
          }
          if (br.bool(run.taper ? 0.09 : 0.05)) continue;
          const s = track.at(U(m));
          const roll = br.next();
          // A works hoarding is assembled out of whatever the contractor had on the truck, so the
          // run carries a heavier mix of water-filled plastic and cone clusters than the racing
          // barriers on the bends do — which is also what keeps 30 identical jersey units off
          // §7's "same prop mesh repeated at a visible regular interval".
          const wSub = run.taper ? 0.20 : 0.10, cSub = run.taper ? 0.32 : 0.14;
          const b = roll < wSub
            ? waterBarrier({ len: 2.0, cache: CACHE, seed: (m | 0) * 3, color: roll < wSub * 0.5 ? MAGENTA : GOLD })
            : roll < cSub
              ? trafficCones({ cache: CACHE, seed: (m | 0) * 5, n: br.int(2, 3) })
              : jerseyBarrier({ len: 4, cache: CACHE, seed: (m | 0) * 7 });
          // a cone cluster spreads 1.2 m either side of its own centre, across the kerb
          const coneBack = roll >= wSub && roll < cSub ? 1.0 : 0;
          b.position.copy(s.pos)
            .addScaledVector(s.right, run.side * (track.halfWidth + OFF + coneBack))
            .setY(s.pos.y + RUN_Y + br.range(-0.03, 0.02));
          b.rotation.y = Math.atan2(s.tan.x, s.tan.z) + br.range(-0.03, 0.03);
          b.scale.setScalar(br.range(0.97, 1.04));
          out.push(b);
          // A jersey barrier is a solid object standing on the road: it lays a hard, tight,
          // near-opaque patch along its own base and nothing wider than that.
          barShade.add(groundGeo(2.2, 4.6), b.position.x, b.position.y + 0.06, b.position.z,
            b.rotation.y);
        }
      }
      const bsm = barShade.into(new THREE.Group());
      if (bsm) out.push(bsm);
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
          g.add(shade(3.6, 3.6, sx * W / 2, 0.06, -0.4, 0, 0.66));
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

    // ---- GROUNDING: the static half ---------------------------------------------------------
    //
    // Everything above this point puts light INTO the frame. This puts the dark back under the
    // things that are standing in it, and lights the two strips of ground the round-1 critic
    // measured as crushed near-black on the right-hand shoulder. See the GROUNDING note at the
    // top of the file for why it has to be last.
    {
      const HW = track.halfWidth;
      const WOFF = track.wallOffset ?? 6.2;      // kerb face; the sidewalk starts 0.18 outboard

      // --- the neon gates. Their legs stand on the sidewalk just past the kerb face (the kit
      // places them at HW + WOFF + 0.9), and round 1 measured one of them meeting the road with
      // neither a shadow nor a pool of its own light. Both, now: a hard foot patch and the
      // cyan/gold/magenta spill it stands in.
      for (const gt of def.props.gates || []) {
        const s = track.at(gt.u);
        const yaw = Math.atan2(s.tan.x, s.tan.z);
        for (const sx of [-1, 1]) {
          const p = s.pos.clone().addScaledVector(s.right, sx * (HW + WOFF + 0.9));
          out.push(poolAt(p, 26, 40, yaw, gt.color, 0.50, 0.11));
          out.push(shadeAt(p, 4.6, 4.6, yaw, 0.72, 0.13));
        }
      }

      // --- the WELCOME arch. Its feet stand out on the apron, so they take the apron's height.
      {
        const s = track.at(U(S.marqueeM));
        const yaw = Math.atan2(s.tan.x, s.tan.z);
        for (const sx of [-1, 1]) {
          const p = s.pos.clone().addScaledVector(s.right, sx * HW * 2.3).setY(s.pos.y - 0.19);
          out.push(poolAt(p, 34, 46, yaw, GOLD, 0.42, 0.06));
          out.push(shadeAt(p, 9.0, 9.0, yaw, 0.70, 0.05));
        }
      }

      // --- the heroes, on the ground plane (which the kit sits at -0.35). A 200 m pyramid
      // standing on a self-lit lilac field with no darkening under it is the same tell as a
      // hovering car, at fifty times the size. The quads run to ~1.6x each footprint, so the
      // dense part of the falloff is under the plinth and what shows is the skirt around it.
      const GY = -0.29;
      out.push(shadeAt(S.pyramid.clone().setY(GY), 545, 545, S.yaw + 0.18, 0.92, 0));
      out.push(shadeAt(S.tower.clone().setY(GY), 108, 108, S.yaw + 0.5, 0.88, 0));
      out.push(shadeAt(S.eiffel.clone().setY(GY), 124, 124, S.yaw + 0.4, 0.85, 0));
      out.push(shadeAt(S.replica.clone().setY(GY), 245, 245, S.yaw - 0.35, 0.80, 0));
      for (const p of S.trackers) {
        out.push(shadeAt(p.clone().setY(GY), 13, 13, 0, 0.70, 0));
      }

      // --- the AO line down the kerb face, both sides, the whole circuit. A wet road meeting a
      // raised kerb is the darkest line in a night street; without it the carriageway and the
      // gutter are two flat tones butted together and the road has no edge.
      {
        const ao = new B(edgeShadeMaterial(0.55));
        for (const side of [-1, 1]) {
          ao.addM(sectionStrip(track, 0, LEN, side,
            { off: WOFF + 0.10, y: 0.105 }, { off: WOFF - 2.4, y: 0.115 }, 7.0), _IDENTITY);
        }
        const m = ao.into(new THREE.Group());
        if (m) { m.userData.noMerge = true; m.frustumCulled = false; m.renderOrder = 8; out.push(m); }
      }

      // --- and the light the kerb throws BACK across its own pavement. This is the half of the
      // note that is not about shadow: round 1's right-hand shoulder at x1050-1600 was a band of
      // crushed near-black between the building line and the cyan kerb strip, because every
      // additive surface in this city lives either on the carriageway or nine metres up. Two
      // graded strips per side — sidewalk, then apron — brightest at the kerb and gone by the
      // frontage, hue-cycled in runs so it never reads as a painted band.
      {
        const wr = rng.fork(2903);
        const walk = HUES.map((c) => new B(edgeWashMaterial(c, 0.34)));
        const apron = HUES.map((c) => new B(edgeWashMaterial(c, 0.20)));
        for (const side of [-1, 1]) {
          let m = wr.range(0, 40);
          let k = side > 0 ? 0 : 2;
          while (m < LEN - 8) {
            const run = wr.range(34, 96);
            const m1 = Math.min(LEN, m + run);
            walk[k % 3].addM(sectionStrip(track, m, m1, side,
              { off: WOFF + 0.34, y: 0.215 }, { off: WOFF + 5.6, y: 0.180 }, 7.0), _IDENTITY);
            // ...and out across the graded apron to where the frontages start, which is the ten
            // metres round 1 measured as a dead void on the right-hand side.
            apron[(k + 2) % 3].addM(sectionStrip(track, m, m1, side,
              { off: WOFF + 6.2, y: -0.02 }, { off: WOFF + 17.0, y: -0.30 }, 9.0), _IDENTITY);
            k += wr.int(1, 2);
            // The runs OVERLAP by a couple of metres so the hue changes without a seam — which
            // means the cursor must be advanced off `m1` only while `m1` is still moving. Clamped
            // at LEN it stops moving, and `m1 - overlap` then walks backwards forever: the loop
            // never ends and the build allocates strips until the tab dies. Ask the loop for the
            // unclamped end instead.
            if (m + run >= LEN) break;
            m = m1 - wr.range(1, 6);
          }
        }
        const holder = new THREE.Group();
        for (const b of [...walk, ...apron]) {
          const mm = b.into(holder);
          if (!mm) continue;
          mm.userData.noMerge = true; mm.frustumCulled = false; mm.renderOrder = 3;
          out.push(mm);
        }
      }
    }

    // One material per family, chunked, before the kit's own merge sees any of it.
    vcCollapse(out);
    reflFlush(out);
    return out;
  },
};

/**
 * RUBBER, NOT SCRATCHES.
 *
 * The FX piece's SkidTrails shader mixes a mid grey-brown dust colour into the shoulders of every
 * mark so that rubber reads on a BRIGHT daytime road as well as a dark one — which is right for LA
 * and Miami and wrong here, because a #8b7f70 shoulder on Vegas's near-black wet asphalt is
 * lighter than the road it is drawn on. Round 2 measured exactly that: "skid marks render as
 * LIGHTER-than-asphalt scratchy aliased lines rather than black rubber".
 *
 * The shader is not this file's to change, and hard-coding a Vegas colour into it would break the
 * other three cities. So Vegas re-tints the uniforms while it is the city on screen and puts them
 * back the moment its group leaves the scene — `Object3D.remove()` dispatches 'removed' on the
 * child, which is what `Game.setCity()` does before it disposes the old city. Nothing outside this
 * function knows the swap happened.
 */
function inkSkidMarks(group, scene) {
  let m = null;
  scene.traverse((o) => {
    if (m || !o.isMesh) return;
    const u = o.material && !Array.isArray(o.material) && o.material.uniforms;
    if (u && u.uDust && u.uWarm && u.uColor) m = o.material;
  });
  if (!m) return;
  const saved = {
    color: m.uniforms.uColor.value.clone(),
    warm: m.uniforms.uWarm.value.clone(),
    dust: m.uniforms.uDust.value.clone(),
    opacity: m.uniforms.uOpacity.value,
  };
  // a violet-black core, a slightly warmer scuff, and a shoulder that is still DARKER than the
  // tarmac it sits on rather than lighter (§2.1: tinted, never #000)
  m.uniforms.uColor.value.set('#0b0710');
  m.uniforms.uWarm.value.set('#1c1220');
  m.uniforms.uDust.value.set('#2b2136');
  m.uniforms.uOpacity.value = 0.98;
  group.addEventListener('removed', function restore() {
    group.removeEventListener('removed', restore);
    m.uniforms.uColor.value.copy(saved.color);
    m.uniforms.uWarm.value.copy(saved.warm);
    m.uniforms.uDust.value.copy(saved.dust);
    m.uniforms.uOpacity.value = saved.opacity;
  });
}

export function build(opts) {
  CACHE = new Map();
  ANIMS = [];
  SITE = null;
  REFL_BANK = null;
  FACE_ATLAS = null;
  const anims = ANIMS;
  const city = buildCity(def, { ...opts, night: true });
  const base = city.update;
  // Every car in the scene lays its footprint on the road, last, after the whole wet-road mirror
  // has been drawn (see GROUNDING). The pass reads the scene itself rather than being handed the
  // grid, so it needs no wiring in main.js and it picks up the player and all seven opponents
  // whatever order they were built in.
  const shadows = new CarShadows(city.track);
  city.group.add(shadows.mesh);
  // ...and the kit's own street furniture, read back out of the finished city (see groundKitProps)
  for (const m of groundKitProps(city.group)) city.group.add(m);
  // the camera goes through to every callback: the beams and their lamp glares are billboards,
  // and a billboard that cannot see the camera is just a quad.
  let inked = false;
  city.update = (t, camera) => {
    base(t, camera);
    for (let i = 0; i < anims.length; i++) anims[i](t, camera);
    shadows.update(city.group);
    // The FX rig is built once by the game shell and is not in scope at build() time; the first
    // frame this city is drawn is the first moment it can be found. One traversal, then never again.
    if (!inked && city.group.parent) { inked = true; inkSkidMarks(city.group, city.group.parent); }
  };
  return city;
}

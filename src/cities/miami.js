import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  buildCity, palmTree, cruiseShip, landmarkTower, lowRise, jerseyBarrier, waterBarrier,
} from './kit.js';
import { roundedBox } from '../vehicles/kit.js';
import { canvas, toTexture, grain, fbmField, normalFromHeight } from '../core/textures.js';
import { textCanvas } from '../core/font.js';
import { RNG, clamp, lerp } from '../core/rng.js';
import { sColor } from './track.js';

/**
 * MIAMI — Ocean Drive, late afternoon falling into dusk.
 *
 * The route is a barrier-island roval: the Atlantic is on the OUTSIDE of the whole lap, the Art
 * Deco hotel strip on the inside. That single decision is what makes the city legible from any
 * frame, because turquoise water and a pastel deco terrace are always in the same two thirds of
 * the picture no matter where the camera is on the lap.
 *
 * Round 1 note — the failure this file is written against: the previous Miami washed to
 * near-monochrome pink. Pastel buildings + a pink sky + a near-white pink fog + a pink highlight
 * grade stacked until the frame had no darks in it at all. The counterweights here are deliberate
 * and all of them matter:
 *
 *   - the fog/haze colour is a MID-value dusty rose, not a pastel: distant things darken toward it
 *   - the far skyline is deep indigo, so the horizon carries the frame's darkest silhouette
 *   - shadows are lit by a saturated turquoise hemisphere (grade uLift follows ambient.sky), which
 *     is the complement of the sky and the single biggest source of tonal separation
 *   - the water is a deep saturated teal with its env reflection pulled right back, so it stays
 *     BLUE under a pink sky instead of mirroring it
 *   - the asphalt stays near-black and the deco trim stays clean white, so the pinks have
 *     something at both ends of the scale to push against.
 */

// ---------------------------------------------------------------- tiny local batcher
// (kit.js keeps its own private one; this file owns its landmarks so it carries a copy rather
// than widening the kit's API surface for four other builders working in the same tree.)

function normalizeGeo(src) {
  const g = src.index ? src.toNonIndexed() : src.clone();
  for (const k of Object.keys(g.attributes)) {
    if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
  }
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.attributes.uv) {
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  }
  g.morphAttributes = {};
  g.clearGroups();
  return g;
}

class Batch {
  constructor(material, { cast = true, receive = true } = {}) {
    this.material = material; this.cast = cast; this.receive = receive; this.geos = [];
  }
  add(geo, x = 0, y = 0, z = 0, ry = 0, o = {}) {
    const g = normalizeGeo(geo);
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(o.rx || 0, ry, o.rz || 0)),
      new THREE.Vector3(o.sx ?? 1, o.sy ?? 1, o.sz ?? 1),
    );
    g.applyMatrix4(m);
    this.geos.push(g);
    return this;
  }
  addRaw(geo) { this.geos.push(normalizeGeo(geo)); return this; }
  into(group) {
    if (!this.geos.length) return null;
    const geo = this.geos.length === 1 ? this.geos[0] : mergeGeometries(this.geos, false);
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.castShadow = this.cast; mesh.receiveShadow = this.receive;
    group.add(mesh);
    return mesh;
  }
}

/** Per-build material cache — a fresh Map per city so `disposeObject` cannot orphan anything. */
function mat(cache, key, make) {
  let v = cache.get(key);
  if (!v) { v = make(); cache.set(key, v); }
  return v;
}

const _box = (w, h, d) => new THREE.BoxGeometry(w, h, d);

/**
 * Wrap a set of shared batches so everything added through it is pre-multiplied by `matrix`.
 * Lets one hotel / yacht / hut be authored in comfortable local coordinates while its geometry
 * still lands in the ONE merged mesh its whole run shares — a terrace of 30 hotels costs eight
 * draw calls, not two hundred and forty.
 */
function stamped(batchSet, matrix) {
  const wrap = {};
  const M = new THREE.Matrix4();
  const Q = new THREE.Quaternion();
  const E = new THREE.Euler();
  for (const k of Object.keys(batchSet)) {
    wrap[k] = {
      add: (geo, x = 0, y = 0, z = 0, ry = 0, o = {}) => {
        const gg = normalizeGeo(geo);
        E.set(o.rx || 0, ry, o.rz || 0);
        Q.setFromEuler(E);
        M.compose(new THREE.Vector3(x, y, z), Q, new THREE.Vector3(o.sx ?? 1, o.sy ?? 1, o.sz ?? 1));
        gg.applyMatrix4(M).applyMatrix4(matrix);
        batchSet[k].geos.push(gg);
      },
      addRaw: (geo) => { batchSet[k].geos.push(normalizeGeo(geo).applyMatrix4(matrix)); },
    };
  }
  return wrap;
}

// ---------------------------------------------------------------- procedural surfaces

/**
 * Sea albedo. V runs offshore: pale aqua in the shallows over sand, saturated turquoise on the
 * bar, deep teal-navy out past the drop-off. Baking the depth ramp into the map (rather than
 * lighting it) is what keeps the water blue under a hot pink sky.
 */
function seaTexture(seed = 3) {
  const S = 512;
  const { c, ctx } = canvas(S, S);
  const rng = new RNG(seed * 31 + 7);
  // The whole point of this ramp is that Miami water is TURQUOISE for most of what you can see of
  // it. A conventional depth ramp that reaches navy by the third of the sheet turns the ocean into
  // a dark band under a pink sky and the city loses its second colour entirely.
  const shallow = sColor('#9df6e4'), bar = sColor('#2ad6d2'), deep = sColor('#0d7fa8');
  const f = fbmField(S, S, { seed: seed + 11, octaves: 5, scale: 7, warp: 0.55 });
  const g2 = fbmField(S, S, { seed: seed + 23, octaves: 3, scale: 26 });
  const img = ctx.createImageData(S, S);
  const hgt = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    const t = y / (S - 1);
    // shallow → bar over the first fifth, then a long fall into deep water
    const col = t < 0.22
      ? shallow.clone().lerp(bar, t / 0.22)
      : bar.clone().lerp(deep, Math.pow((t - 0.22) / 0.78, 1.55));
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const l = clamp(0.86 + (f[i] - 0.5) * 0.30 + (g2[i] - 0.5) * 0.20, 0.55, 1.35);
      img.data[i * 4] = clamp(col.r * 255 * l, 0, 255);
      img.data[i * 4 + 1] = clamp(col.g * 255 * l, 0, 255);
      img.data[i * 4 + 2] = clamp(col.b * 255 * l, 0, 255);
      img.data[i * 4 + 3] = 255;
      hgt[i] = f[i] * 0.55 + g2[i] * 0.45;
    }
  }
  ctx.putImageData(img, 0, 0);
  // chop: short crests near shore, long swell offshore
  for (let k = 0; k < 520; k++) {
    const y = rng.range(0, S);
    const scale = 0.35 + (y / S) * 2.2;
    ctx.strokeStyle = `rgba(226,250,255,${rng.range(0.05, 0.30) * (1 - y / S * 0.55)})`;
    ctx.lineWidth = rng.range(0.7, 2.0) * scale;
    const x = rng.range(0, S), len = rng.range(14, 70) * scale;
    ctx.beginPath(); ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x + len * 0.5, y + rng.range(-4, 4), x + len, y);
    ctx.stroke();
  }
  grain(ctx, S, S, 4, rng);
  return {
    map: toTexture(c, { srgb: true, wrap: THREE.RepeatWrapping }),
    normalMap: toTexture(normalFromHeight(hgt, S, S, 2.2), { srgb: false, wrap: THREE.RepeatWrapping }),
  };
}

/** Beach albedo. V runs offshore too: dry pale sand at the dune, damp tan at the swash. */
function sandTexture(seed = 5) {
  const S = 512;
  const { c, ctx } = canvas(S, S);
  const rng = new RNG(seed * 17 + 3);
  const dry = sColor('#fbf0d8'), damp = sColor('#cdb18a');
  const f = fbmField(S, S, { seed, octaves: 5, scale: 22, warp: 0.35 });
  const g2 = fbmField(S, S, { seed: seed + 9, octaves: 3, scale: 90 });
  const img = ctx.createImageData(S, S);
  const hgt = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    const col = dry.clone().lerp(damp, Math.pow(y / (S - 1), 1.7));
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const l = clamp(0.90 + (f[i] - 0.5) * 0.26 + (g2[i] - 0.5) * 0.14, 0.6, 1.25);
      img.data[i * 4] = clamp(col.r * 255 * l, 0, 255);
      img.data[i * 4 + 1] = clamp(col.g * 255 * l, 0, 255);
      img.data[i * 4 + 2] = clamp(col.b * 255 * l, 0, 255);
      img.data[i * 4 + 3] = 255;
      hgt[i] = f[i];
    }
  }
  ctx.putImageData(img, 0, 0);
  // rake marks, tyre tracks and footprint scatter so the sand is not one smooth field
  for (let k = 0; k < 30; k++) {
    ctx.save();
    ctx.translate(rng.range(0, S), rng.range(0, S));
    ctx.rotate(rng.range(-0.35, 0.35));
    ctx.globalAlpha = rng.range(0.05, 0.16);
    ctx.fillStyle = '#8c7350';
    for (let i = 0; i < 8; i++) ctx.fillRect(-S, i * 3.5, S * 2, 1.4);
    ctx.restore();
  }
  for (let k = 0; k < 260; k++) {
    ctx.fillStyle = `rgba(140,116,80,${rng.range(0.05, 0.20)})`;
    ctx.beginPath(); ctx.ellipse(rng.range(0, S), rng.range(0, S), rng.range(1, 3), rng.range(1, 2), rng.range(0, 3), 0, 7); ctx.fill();
  }
  grain(ctx, S, S, 8, rng);
  return {
    map: toTexture(c, { srgb: true, wrap: THREE.RepeatWrapping }),
    normalMap: toTexture(normalFromHeight(hgt, S, S, 1.5), { srgb: false, wrap: THREE.RepeatWrapping }),
  };
}

/** Painted stucco — the deco hotel wall. Trowel swirl, a faint plinth stain, sun-bleached top. */
function stuccoMaterial(cache, tint) {
  return mat(cache, `stucco|${tint}`, () => {
    const S = 256;
    const { c, ctx } = canvas(S, S);
    const rng = new RNG(tint.length * 97 + tint.charCodeAt(2) * 13);
    const base = sColor(tint);
    const f = fbmField(S, S, { seed: 21, octaves: 5, scale: 9, warp: 0.5 });
    const g2 = fbmField(S, S, { seed: 44, octaves: 3, scale: 40 });
    const img = ctx.createImageData(S, S);
    const hgt = new Float32Array(S * S);
    for (let i = 0; i < S * S; i++) {
      const l = clamp(0.93 + (f[i] - 0.5) * 0.16 + (g2[i] - 0.5) * 0.10, 0.7, 1.15);
      img.data[i * 4] = clamp(base.r * 255 * l, 0, 255);
      img.data[i * 4 + 1] = clamp(base.g * 255 * l, 0, 255);
      img.data[i * 4 + 2] = clamp(base.b * 255 * l, 0, 255);
      img.data[i * 4 + 3] = 255;
      hgt[i] = f[i] * 0.7 + g2[i] * 0.3;
    }
    ctx.putImageData(img, 0, 0);
    for (let k = 0; k < 26; k++) {
      ctx.strokeStyle = `rgba(255,255,255,${rng.range(0.02, 0.07)})`;
      ctx.lineWidth = rng.range(2, 7);
      const x = rng.range(0, S), y = rng.range(0, S);
      ctx.beginPath(); ctx.arc(x, y, rng.range(8, 34), rng.range(0, 6), rng.range(1, 4)); ctx.stroke();
    }
    grain(ctx, S, S, 4, rng);
    return new THREE.MeshStandardMaterial({
      map: toTexture(c, { srgb: true, repeat: [5, 5] }),
      normalMap: toTexture(normalFromHeight(hgt, S, S, 1.0), { srgb: false, repeat: [5, 5] }),
      roughness: 0.88, metalness: 0.0, envMapIntensity: 0.7,
    });
  });
}

/**
 * Deco trim: eyebrow ledges, parapets, terrace paving, mullions. Painted plaster over concrete,
 * with a terrazzo speckle and hairline crazing — a flat-colour MeshStandardMaterial here is a §7
 * "untextured flat colour on a large surface" tell the moment the drift camera gets near a terrace.
 */
function trimMaterial(cache, tint = '#fbf7ee') {
  return mat(cache, `trim|${tint}`, () => {
    const S = 256;
    const { c, ctx } = canvas(S, S);
    const rng = new RNG(tint.charCodeAt(1) * 31 + 17);
    const base = sColor(tint);
    const f = fbmField(S, S, { seed: 13, octaves: 4, scale: 16, warp: 0.3 });
    const img = ctx.createImageData(S, S);
    const hgt = new Float32Array(S * S);
    for (let i = 0; i < S * S; i++) {
      const l = clamp(0.95 + (f[i] - 0.5) * 0.12, 0.8, 1.06);
      img.data[i * 4] = clamp(base.r * 255 * l, 0, 255);
      img.data[i * 4 + 1] = clamp(base.g * 255 * l, 0, 255);
      img.data[i * 4 + 2] = clamp(base.b * 255 * l, 0, 255);
      img.data[i * 4 + 3] = 255;
      hgt[i] = f[i];
    }
    ctx.putImageData(img, 0, 0);
    for (let k = 0; k < 900; k++) {            // terrazzo chips
      ctx.fillStyle = rng.bool(0.5)
        ? `rgba(190,180,164,${rng.range(0.10, 0.32)})`
        : `rgba(255,255,255,${rng.range(0.10, 0.34)})`;
      ctx.beginPath();
      ctx.ellipse(rng.range(0, S), rng.range(0, S), rng.range(0.6, 2.1), rng.range(0.5, 1.6), rng.range(0, 3), 0, 7);
      ctx.fill();
    }
    for (let k = 0; k < 14; k++) {             // hairline crazing
      ctx.strokeStyle = `rgba(120,110,98,${rng.range(0.05, 0.14)})`;
      ctx.lineWidth = rng.range(0.5, 1.1);
      let x = rng.range(0, S), y = rng.range(0, S);
      ctx.beginPath(); ctx.moveTo(x, y);
      for (let j = 0; j < 6; j++) { x += rng.range(-22, 22); y += rng.range(-22, 22); ctx.lineTo(x, y); }
      ctx.stroke();
    }
    grain(ctx, S, S, 3, rng);
    return new THREE.MeshStandardMaterial({
      map: toTexture(c, { srgb: true, repeat: [4, 4] }),
      normalMap: toTexture(normalFromHeight(hgt, S, S, 0.7), { srgb: false, repeat: [4, 4] }),
      roughness: 0.68, metalness: 0.02, envMapIntensity: 0.9,
    });
  });
}

function neonMaterial(cache, color, intensity = 3.0) {
  return mat(cache, `neon|${color}|${intensity}`, () => new THREE.MeshStandardMaterial({
    color: new THREE.Color(color).multiplyScalar(0.45),
    emissive: new THREE.Color(color), emissiveIntensity: intensity,
    roughness: 0.30, metalness: 0.0,
  }));
}

function metalMaterial(cache, tint = '#2f343c', rough = 0.45) {
  return mat(cache, `metal|${tint}|${rough}`, () => new THREE.MeshStandardMaterial({
    color: new THREE.Color(tint), metalness: 0.75, roughness: rough,
  }));
}

/** Lit hotel lobby / terrace glazing: a warm room behind the glass, not a flat plate of light. */
function lobbyMaterial(cache, color, seed = 1) {
  return mat(cache, `lobby|${color}|${seed}`, () => {
    const S = 128;
    const { c, ctx } = canvas(S, S);
    const rng = new RNG(seed * 71 + 5);
    const col = sColor(color);
    const rgb = (m, a = 1) => `rgba(${clamp(col.r * 255 * m, 0, 255) | 0},${clamp(col.g * 255 * m, 0, 255) | 0},${clamp(col.b * 255 * m, 0, 255) | 0},${a})`;
    const gr = ctx.createLinearGradient(0, 0, 0, S);
    gr.addColorStop(0, rgb(1.30));
    gr.addColorStop(0.25, rgb(1.0));
    gr.addColorStop(0.80, rgb(0.48));
    gr.addColorStop(1, rgb(0.22));
    ctx.fillStyle = gr; ctx.fillRect(0, 0, S, S);
    for (let k = 0; k < rng.int(2, 4); k++) {              // bar back, palms in pots, furniture
      const x = rng.range(0, S * 0.8), w = rng.range(S * 0.10, S * 0.26);
      const y = rng.range(S * 0.30, S * 0.55), h = rng.range(S * 0.20, S * 0.45);
      ctx.fillStyle = `rgba(24,16,12,${rng.range(0.25, 0.55)})`;
      ctx.fillRect(x, y, w, h);
    }
    for (let k = 0, n = rng.int(1, 3); k < n; k++) {
      const x = rng.range(S * 0.1, S * 0.85), hh = rng.range(S * 0.24, S * 0.38);
      ctx.fillStyle = `rgba(10,8,8,${rng.range(0.5, 0.8)})`;
      ctx.fillRect(x, S * 0.86 - hh, rng.range(4, 7), hh);
      ctx.beginPath(); ctx.arc(x + 3, S * 0.86 - hh, 3.0, 0, 7); ctx.fill();
    }
    ctx.fillStyle = 'rgba(14,10,9,0.6)'; ctx.fillRect(0, S * 0.87, S, S * 0.13);
    ctx.fillStyle = 'rgba(8,7,6,0.9)';
    for (let i = 1; i < 3; i++) ctx.fillRect((i / 3) * S - 1.6, 0, 3.2, S);
    ctx.fillRect(0, 0, S, 3); ctx.fillRect(0, S - 3, S, 3);
    grain(ctx, S, S, 4, rng);
    const t = toTexture(c, { srgb: true, wrap: THREE.ClampToEdgeWrapping });
    return new THREE.MeshStandardMaterial({
      map: t, emissiveMap: t, emissive: new THREE.Color(0xffffff), emissiveIntensity: 0.78,
      roughness: 0.32, metalness: 0.1,
    });
  });
}

/** Awning canvas: broad candy stripes in the hotel's own colour over cream. */
function awningMaterial(cache, color) {
  return mat(cache, `awning|${color}`, () => {
    const { c, ctx } = canvas(128, 64);
    ctx.fillStyle = '#f6f1e4'; ctx.fillRect(0, 0, 128, 64);
    const s = sColor(color);
    ctx.fillStyle = `rgb(${(s.r * 255) | 0},${(s.g * 255) | 0},${(s.b * 255) | 0})`;
    for (let i = 0; i < 8; i++) ctx.fillRect(i * 16, 0, 8, 64);
    ctx.fillStyle = 'rgba(0,0,0,0.10)'; ctx.fillRect(0, 52, 128, 12);
    grain(ctx, 128, 64, 5, new RNG(9));
    return new THREE.MeshStandardMaterial({
      map: toTexture(c, { srgb: true, repeat: [1, 1] }), roughness: 0.9, side: THREE.DoubleSide,
    });
  });
}

/**
 * A bank of towering sunset cumulus round the horizon.
 *
 * The shared sky dome fades its cloud layer out over the last 14° above the horizon, which is
 * precisely the band a chase camera can see — so with `clouds` cranked to 0.78 the upper third of
 * every Miami frame was still one unbroken slab of magenta. These are real geometry sitting just
 * inside the dome: gold tops, magenta flanks and deep violet undersides, so the sky gains a value
 * range and a light direction instead of being a gradient.
 */
function cloudBank(cache, centre, rng) {
  const g = new THREE.Group();
  g.name = 'clouds';
  const tex = (variant) => mat(cache, `cloud|${variant}`, () => {
    const W = 512, H = 256;
    const { c, ctx } = canvas(W, H);
    // Drawn from an fbm field, not from stacked radial gradients: a mound of soft discs reads as
    // exactly that — a lava lamp of orange circles — the moment the cards are big enough to see.
    const f = fbmField(W, H, { seed: variant * 37 + 5, octaves: 6, scale: 3.2, warp: 0.75 });
    const g2 = fbmField(W, H, { seed: variant * 37 + 61, octaves: 3, scale: 14 });
    const img = ctx.createImageData(W, H);
    const gold = sColor('#ffe9c4'), flank = sColor('#ff9d86'), base = sColor('#5c3c74');
    for (let y = 0; y < H; y++) {
      const ny = y / (H - 1);                                    // 0 = cloud top
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const nx = (x / (W - 1) - 0.5) * 2;
        // a cumulus mound: wide and flat-bottomed, tapering to a head
        const mound = (1 - Math.pow(Math.abs(nx), 1.7)) * (0.30 + 0.85 * Math.pow(ny, 0.7));
        const d = f[i] * 0.95 + g2[i] * 0.22 + mound * 0.80 - 0.86;
        const a = clamp(d * 4.2, 0, 1) * (ny > 0.92 ? clamp((1 - ny) / 0.08, 0, 1) : 1);
        // lit from above: gold crowns, coral flanks, violet in the shadowed base
        const shade = clamp(ny * 1.25 + (0.5 - f[i]) * 0.5, 0, 1);
        const col = shade < 0.5
          ? gold.clone().lerp(flank, shade / 0.5)
          : flank.clone().lerp(base, (shade - 0.5) / 0.5);
        img.data[i * 4] = col.r * 255;
        img.data[i * 4 + 1] = col.g * 255;
        img.data[i * 4 + 2] = col.b * 255;
        img.data[i * 4 + 3] = a * 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return new THREE.MeshBasicMaterial({
      map: toTexture(c, { srgb: true, wrap: THREE.ClampToEdgeWrapping }),
      transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide,
      opacity: 0.80,
    });
  });
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2 + rng.range(-0.09, 0.09);
    const rad = 3150 + rng.range(-220, 150);
    const w = rng.range(800, 1900);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, w * rng.range(0.30, 0.46)), tex(i % 5));
    m.position.set(centre.x + Math.cos(a) * rad, rng.range(230, 1180), centre.z + Math.sin(a) * rad);
    m.lookAt(centre.x, m.position.y, centre.z);
    // AFTER the skyline ring's haze curtains (renderOrder -10..-8), or three stacked cylinders of
    // fog colour blend over the top of the clouds and they come back as faint smudges. Opaque
    // skyline towers still occlude them correctly — they write depth, the clouds only test it.
    m.renderOrder = -4;
    m.userData.noMerge = true;
    g.add(m);
  }
  return g;
}

// ---------------------------------------------------------------- the island shoreline

const HOTEL_NAMES = ['COLONY', 'BREAKWATER', 'CARLYLE', 'MARLIN', 'AVALON', 'CLEVELANDER',
  'LESLIE', 'CAVALIER', 'TIDES', 'WALDORF', 'BEACON', 'CRESCENT'];

/** Ring table: [distance outward from the island hull, water/sand height]. */
// Distances are from the island hull; heights are the Out Run cheat. The gradient matters more
// than the numbers: a sea that climbs 17 m over 700 m subtends about one degree from a 3 m eye and
// renders as an 18-pixel stripe — which is how round 1 of this file ended up with "no ocean".
// Climbing ~32 m over the same distance triples that, and then FLATTENING past 800 m keeps the far
// water below the skyline instead of drowning it.
const RINGS = [
  [30, -0.10],   // back of the beach, level with the road apron
  [46, 1.90],    // dune crest
  [88, 0.55],    // dry sand
  [114, -0.14],  // swash / waterline
];

/** Water surface height at `d` metres offshore — smooth, so the sheet has no shading bands. */
const WATER_Y = (d) => -0.14 + 52.5 * (1 - Math.exp(-(d - 114) / 560));

/** Fourteen rows bunched toward the shore, where the surface curves hardest. */
const WATER_ROWS = Array.from({ length: 15 }, (_, k) => {
  const d = 114 + (2300 - 114) * Math.pow(k / 14, 2.05);
  return [d, WATER_Y(d)];
});

function ringY(d) {
  if (d <= RINGS[0][0]) return RINGS[0][1];
  for (let i = 1; i < RINGS.length; i++) {
    if (d <= RINGS[i][0]) {
      const t = (d - RINGS[i - 1][0]) / (RINGS[i][0] - RINGS[i - 1][0]);
      return lerp(RINGS[i - 1][1], RINGS[i][1], t);
    }
  }
  return WATER_Y(d);
}

/** Convex hull (monotone chain) of {x,z} points, counter-clockwise in the x/z plane. */
function convexHull(pts) {
  const p = pts.slice().sort((a, b) => (a.x - b.x) || (a.z - b.z));
  const cross = (o, a, b) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
  const lower = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

/**
 * The Atlantic, the beach and the dune, built as a Minkowski offset of the island's convex hull.
 *
 * Two things this buys over a rectangular water plane parked beside one straight:
 *  1. the shoreline FOLLOWS the road all the way round, so the water is in frame on every corner
 *     rather than only where a slab happens to be;
 *  2. offsetting a convex boundary outward can never fold, so no amount of route curvature
 *     produces a pinched or self-intersecting sea (§7's geometry-seam cap).
 *
 * The sheet is also ramped, not flat: pinned at the waterline and climbing ~46 m over 2 km. Flat
 * water seen from a 2.5 m eye is a one-degree strip that just mirrors the sky; ramping it is the
 * cheat every arcade coastal track has used since Out Run, and it is what makes the turquoise
 * actually occupy the frame.
 */
function shoreline(track, cache, rng) {
  const g = new THREE.Group();
  g.name = 'shoreline';

  const hull = convexHull(track.samples.map((s) => ({ x: s.pos.x, z: s.pos.z })));
  const n = hull.length;
  // boundary samples: densified edges plus rounded corners (the Minkowski disc)
  const B = [];
  const edgeN = [];
  for (let i = 0; i < n; i++) {
    const a = hull[i], b = hull[(i + 1) % n];
    const dx = b.x - a.x, dz = b.z - a.z;
    const L = Math.hypot(dx, dz) || 1;
    edgeN.push({ x: dz / L, z: -dx / L, len: L });     // outward normal of a CCW polygon
  }
  for (let i = 0; i < n; i++) {
    const a = hull[i];
    const nPrev = edgeN[(i - 1 + n) % n], nCur = edgeN[i];
    let a0 = Math.atan2(nPrev.z, nPrev.x), a1 = Math.atan2(nCur.z, nCur.x);
    let d = a1 - a0;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    const steps = Math.max(1, Math.ceil(Math.abs(d) / 0.16));
    for (let k = 0; k < steps; k++) {
      const ang = a0 + d * (k / steps);
      B.push({ x: a.x, z: a.z, nx: Math.cos(ang), nz: Math.sin(ang) });
    }
    const segs = Math.max(1, Math.round(edgeN[i].len / 26));
    const bpt = hull[(i + 1) % n];
    for (let k = 0; k < segs; k++) {
      const t = k / segs;
      B.push({
        x: lerp(a.x, bpt.x, t), z: lerp(a.z, bpt.z, t),
        nx: nCur.x, nz: nCur.z,
      });
    }
  }
  const M = B.length;

  /** Signed distance from a world point to the island hull (positive = out to sea). */
  const hullDist = (x, z) => {
    let best = -1e9;
    for (let j = 0; j < M; j++) {
      const v = (x - B[j].x) * B[j].nx + (z - B[j].z) * B[j].nz;
      if (v > best) best = v;
    }
    return best;
  };

  // Perimeter of the boundary polygon, used to quantise every along-shore texture repeat to a
  // whole number of tiles. Without it the ring closes on a fractional tile and leaves one hard
  // vertical seam in the water and the sand at the wrap point.
  let perim = 0;
  for (let j = 0; j < M; j++) {
    const a = B[j], b = B[(j + 1) % M];
    perim += Math.hypot(b.x - a.x, b.z - a.z);
  }
  const tileFit = (want) => perim / Math.max(1, Math.round(perim / want));

  /** Build a ribbon through a list of [distance, height] rows as one indexed mesh. */
  const strip = (table, material, uScaleWant, vRange) => {
    const uScale = tileFit(uScaleWant);
    const rows = table.length;
    const pos = [], uv = [], idx = [];
    let run = 0;
    for (let j = 0; j <= M; j++) {
      const b = B[j % M];
      if (j > 0) {
        const p = B[(j - 1) % M];
        run += Math.hypot(b.x - p.x, b.z - p.z);
      }
      for (let r = 0; r < rows; r++) {
        const [d, y] = table[r];
        pos.push(b.x + b.nx * d, y, b.z + b.nz * d);
        uv.push(run / uScale, lerp(vRange[0], vRange[1], r / (rows - 1)));
      }
    }
    for (let j = 0; j < M; j++) {
      for (let r = 0; r < rows - 1; r++) {
        const a0 = j * rows + r, b0 = (j + 1) * rows + r;
        idx.push(a0, b0, a0 + 1, b0, b0 + 1, a0 + 1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, material);
    m.userData.noMerge = true;
    return m;
  };

  // --- beach: dune crest → dry sand → swash ---
  const sandMat = mat(cache, 'sand', () => {
    const t = sandTexture(5);
    return new THREE.MeshStandardMaterial({
      map: t.map, normalMap: t.normalMap, roughness: 1.0, metalness: 0.0, envMapIntensity: 0.75,
    });
  });
  const beach = strip(RINGS, sandMat, 34, [0, 1]);
  beach.receiveShadow = true;
  g.add(beach);

  // --- water: waterline → open sea ---
  const seaMat = mat(cache, 'sea', () => {
    const t = seaTexture(3);
    return new THREE.MeshStandardMaterial({
      map: t.map, normalMap: t.normalMap,
      // Env intensity deliberately low and roughness mid: at 0.1/1.0 the sheet mirrors the sunset
      // and the whole ocean becomes one bar of pink. This keeps a broad specular sheen and lets
      // the baked turquoise carry the colour.
      //
      // The emissive is the other half of the same argument. A horizontal plane under a 19° sun
      // receives a third of the key and nothing else except a hemisphere term, so lit strictly it
      // renders as a dark slab; a shallow tropical sea is bright because light comes back up
      // through it off the sand. This is that upwelling, and at 0.5 it sits far under the bloom
      // threshold so it glows nowhere.
      roughness: 0.52, metalness: 0.02, envMapIntensity: 0.34,
      emissive: new THREE.Color('#1aa4bc'), emissiveIntensity: 0.50,
    });
  });
  seaMat.normalScale = new THREE.Vector2(0.40, 0.40);
  g.add(strip(WATER_ROWS, seaMat, 90, [0, 1]));

  // --- foam: a soft white band riding the swash, plus offshore surf lines ---
  const foamMat = mat(cache, 'foam', () => {
    const { c, ctx } = canvas(256, 64);
    const r = new RNG(41);
    const gr = ctx.createLinearGradient(0, 0, 0, 64);
    gr.addColorStop(0, 'rgba(255,255,255,0)');
    gr.addColorStop(0.5, 'rgba(244,254,255,0.88)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gr; ctx.fillRect(0, 0, 256, 64);
    ctx.globalCompositeOperation = 'destination-out';
    for (let k = 0; k < 110; k++) {
      ctx.globalAlpha = r.range(0.2, 0.85);
      ctx.beginPath(); ctx.ellipse(r.range(0, 256), r.range(0, 64), r.range(4, 24), r.range(3, 13), 0, 0, 7); ctx.fill();
    }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    return new THREE.MeshBasicMaterial({
      map: toTexture(c, { srgb: true, wrap: THREE.RepeatWrapping }), transparent: true,
      depthWrite: false, fog: true,
    });
  });
  // A breaking line is never a ruler. Each band's distance offshore wobbles with two out-of-phase
  // low-frequency terms, so the surf reads as a moving break instead of a set of concentric hoops
  // drawn round the island (§7's "same element at a visible regular interval").
  const foamBand = (dCentre, halfW, tileWant, lift, phase, mater) => {
    const tile = tileFit(tileWant);
    const pos = [], uv = [], idx = [];
    let run = 0;
    for (let j = 0; j <= M; j++) {
      const b = B[j % M];
      if (j > 0) { const p = B[(j - 1) % M]; run += Math.hypot(b.x - p.x, b.z - p.z); }
      const wob = Math.sin(run / 190 + phase) * halfW * 1.5 + Math.sin(run / 61 + phase * 2.3) * halfW * 0.7;
      for (const s of [-1, 1]) {
        const d = dCentre + wob + s * halfW;
        pos.push(b.x + b.nx * d, ringY(d) + lift, b.z + b.nz * d);
        uv.push(run / tile, (s + 1) / 2);
      }
    }
    for (let j = 0; j < M; j++) {
      const a0 = j * 2, b0 = (j + 1) * 2;
      idx.push(a0, b0, a0 + 1, b0, b0 + 1, a0 + 1);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, mater);
    m.renderOrder = 3;
    m.userData.noMerge = true;
    return m;
  };
  const surfMat = mat(cache, 'surf', () => {
    const m2 = foamMat.clone();
    m2.opacity = 0.42; m2.transparent = true;
    return m2;
  });
  g.add(foamBand(100, 8, 26, 0.12, 0.0, foamMat));
  for (let i = 1; i <= 4; i++) {
    g.add(foamBand(124 + i * i * 22, 4.5 + i * 2.0, 46 + i * 16, 0.22, i * 1.9, surfMat));
  }

  // --- the promenade edge: a low seawall with deco piers, and the beach-access steps ---
  {
    const wall = new Batch(trimMaterial(cache, '#efe6d4'), { cast: false });
    const rail = new Batch(metalMaterial(cache, '#e8f4f4', 0.55), { cast: false });
    const stride = 3;
    for (let j = 0; j < M; j += stride) {
      const b = B[j], b2 = B[(j + stride) % M];
      const ax = b.x + b.nx * 29.0, az = b.z + b.nz * 29.0;
      const bx = b2.x + b2.nx * 29.0, bz = b2.z + b2.nz * 29.0;
      const len = Math.hypot(bx - ax, bz - az);
      if (len > 60) continue;                                  // skip the wrap seam
      const yaw = Math.atan2(bx - ax, bz - az);
      wall.add(_box(0.55, 1.05, len * 1.04), (ax + bx) / 2, 0.42, (az + bz) / 2, yaw);
      if ((j / stride) % 4 === 0) {
        wall.add(_box(1.15, 1.55, 1.15), ax, 0.62, az);        // pier
        wall.add(_box(1.45, 0.22, 1.45), ax, 1.45, az);        // cap
      }
      rail.add(new THREE.CylinderGeometry(0.055, 0.055, len * 1.04, 5),
        (ax + bx) / 2, 1.28, (az + bz) / 2, yaw, { rx: Math.PI / 2 });
    }
    wall.into(g); rail.into(g);
  }

  void rng;
  return { group: g, hullDist, boundary: B, ringY };
}

// ---------------------------------------------------------------- deco hotel strip

/**
 * One Art Deco hotel. The three tells that make a stranger say "Miami" are, in order: the CURVED
 * corner, the horizontal eyebrow ledges band-coursing the whole facade, and the stepped central
 * parapet with a fin. All three are here, plus the neon tube that traces every one of them.
 *
 * Local origin sits on the ground at the FRONT face, +Z pointing at the road.
 */
function decoHotel(bats, {
  w = 34, h = 17, d = 24, r = 5.0, seed = 1, wall = '#f8d9e4', neon = '#ff2f9d',
  nameIndex = 0, curveSide = 1, awningColor = null,
}) {
  const rng = new RNG(seed * 37 + 11);
  const { body, trim, glass, neonB, awn, lobby, sign, dark } = bats(wall, neon, awningColor || neon);
  const floors = Math.max(3, Math.round((h - 4.6) / 3.6));
  const groundH = 4.6;
  const floorH = (h - groundH) / floors;
  const hw = w / 2;
  const cx = curveSide * (hw - r);                              // centre of the rounded corner

  // ---- massing: a flat centre bay flanked by one squared and one full-round corner ----
  body.add(_box(w - r * 2, h, d), curveSide * -r, h / 2, -d / 2);
  body.add(_box(r * 2, h, d - r), -cx, h / 2, -d / 2 - r / 2);
  body.add(new THREE.CylinderGeometry(r, r, h, 18), cx, h / 2, -r);
  body.add(_box(r * 2, h, d - r), cx, h / 2, -d / 2 - r / 2);
  body.add(_box(r * 2, h, r * 2), -cx, h / 2, -r);              // squared opposite corner

  /** A horizontal band wrapping the facade including the curved corner. */
  const band = (batch, y, th, grow) => {
    batch.add(_box(w - r * 2 + grow * 2, th, d + grow), curveSide * -r, y, -d / 2 + grow / 2);
    batch.add(new THREE.CylinderGeometry(r + grow, r + grow, th, 18), cx, y, -r);
    batch.add(_box(r * 2 + grow * 2, th, r * 2 + grow * 2), -cx, y, -r);
  };

  // ---- eyebrows: the cantilevered ledge over every floor, with a thin neon tube under it ----
  // The tube is deliberately slim and dim. A 0.20 m tube at emissive 3 across a 40 m facade on
  // every floor of every hotel is 200 m of bloom source in one frame, and round 1 of this file
  // proved exactly what that looks like: the terrace stopped being pink stucco and became a slab
  // of blown-out light.
  for (let f = 1; f <= floors; f++) {
    const y = groundH + f * floorH;
    band(trim, y, 0.40, 0.72);
    band(neonB, y - 0.30, 0.12, 0.60);
  }
  band(trim, groundH, 0.58, 1.15);

  // ---- windows: a punched band per floor, wrapping the curve ----
  for (let f = 0; f < floors; f++) {
    const y = groundH + f * floorH + floorH * 0.46;
    const gw = w - r * 2 - 2.6;
    const gh = floorH * 0.34;
    glass.add(new THREE.PlaneGeometry(gw, gh), curveSide * -r, y, 0.06);
    // curved corner glazing — an open half-cylinder, so the corner really is glass
    glass.add(new THREE.CylinderGeometry(r + 0.07, r + 0.07, gh, 14, 1, true, -Math.PI / 2, Math.PI),
      cx, y, -r);
    // reveal + sill, so the opening reads as punched into stucco rather than pasted on
    trim.add(_box(gw + 0.9, 0.24, 0.34), curveSide * -r, y + gh / 2 + 0.16, 0.14);
    trim.add(_box(gw + 0.9, 0.20, 0.46), curveSide * -r, y - gh / 2 - 0.12, 0.20);
    // mullions
    const bays = Math.max(3, Math.round(gw / 3.2));
    for (let i = 0; i <= bays; i++) {
      trim.add(_box(0.24, gh + 0.1, 0.28), curveSide * -r - gw / 2 + (i / bays) * gw, y, 0.10);
    }
    // porthole on the flank of the squared corner
    if (rng.bool(0.7)) {
      trim.add(new THREE.CylinderGeometry(0.55, 0.55, 0.28, 12),
        -cx - (r + 0.05) * (curveSide > 0 ? 1 : -1), y, -r, 0, { rz: Math.PI / 2 });
    }
  }

  // ---- ground floor: recessed terrace, columns, striped awning, warm lobby glass ----
  {
    const tw = w - r * 2 - 0.5;
    lobby.add(new THREE.PlaneGeometry(tw, groundH * 0.62), curveSide * -r, groundH * 0.45, 0.05);
    lobby.add(new THREE.CylinderGeometry(r + 0.06, r + 0.06, groundH * 0.62, 14, 1, true, -Math.PI / 2, Math.PI),
      cx, groundH * 0.45, -r);
    dark.add(_box(tw + 0.4, 0.45, 0.34), curveSide * -r, groundH * 0.80, 0.16);
    // awning: a shallow wedge over the terrace
    awn.add(new THREE.PlaneGeometry(tw, 4.2), curveSide * -r, groundH * 0.92 + 0.5, 1.9, 0, { rx: -1.28 });
    trim.add(_box(tw + 0.5, 0.22, 0.22), curveSide * -r, groundH * 0.92 + 1.42, 0.12);
    trim.add(_box(tw + 0.5, 0.18, 0.18), curveSide * -r, groundH * 0.92 - 0.52, 3.75);
    for (let i = 0; i < 4; i++) {
      const x = curveSide * -r - tw / 2 + (i / 3) * tw;
      trim.add(new THREE.CylinderGeometry(0.20, 0.24, groundH * 0.92, 10), x, groundH * 0.46, 3.75);
    }
    // neon underlighting washing the terrace floor + a plinth line at the kerb
    neonB.add(_box(tw + 1.0, 0.22, 0.22), curveSide * -r, 0.42, 4.0);
    neonB.add(new THREE.CylinderGeometry(r + 1.0, r + 1.0, 0.22, 16), cx, 0.42, -r);
    // Terrace deck. Kept clear of the collision wall (lateral 1.52 ≈ 19 m from the centreline on a
    // 12.5 m half-width road); an 8 m apron off the setback reached inside it and the car clipped it.
    trim.add(_box(w + 2.6, 0.35, 4.6), 0, 0.16, 2.1);
  }

  // ---- stepped parapet + fin: the deco silhouette ----
  {
    const py = h;
    band(trim, py + 0.65, 1.30, 1.30);
    const steps = rng.int(2, 3);
    let sw = w * 0.46, sy = py + 1.3;
    for (let i = 0; i < steps; i++) {
      const sh = 1.5 - i * 0.25;
      trim.add(_box(sw, sh, d * 0.55), curveSide * -r * 0.4, sy + sh / 2, -d * 0.30);
      neonB.add(_box(sw + 0.5, 0.20, 0.22), curveSide * -r * 0.4, sy + sh, -d * 0.30 + d * 0.28);
      sy += sh; sw *= 0.62;
    }
    // the fin, with three horizontal "speed lines" — the single most deco thing on the building
    trim.add(_box(1.5, 3.6, d * 0.30), curveSide * -r * 0.4, sy + 1.8, -d * 0.28);
    for (let i = 0; i < 3; i++) {
      neonB.add(_box(2.6, 0.18, 0.20), curveSide * -r * 0.4, sy + 0.7 + i * 0.85, -d * 0.28 + d * 0.16);
    }
    // roof plant so the top is not an empty slab
    dark.add(_box(2.4, 1.0, 1.8), curveSide * (hw - 6) * -1, py + 1.9, -d * 0.62, rng.range(0, 1.4));
    dark.add(new THREE.CylinderGeometry(0.26, 0.26, 1.8, 7), curveSide * (hw - 3) * -1, py + 2.2, -d * 0.42);
  }

  // ---- the vertical neon sign fin ----
  {
    const fh = Math.min(9.5, h * 0.55);
    const plane = new THREE.PlaneGeometry(fh, fh * 0.30);
    const uv = plane.attributes.uv;
    const rows = HOTEL_NAMES.length;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, uv.getX(i), (nameIndex + uv.getY(i)) / rows);
    }
    plane.rotateZ(Math.PI / 2);
    sign.addRaw(plane.translate(curveSide * (hw - r * 2.1), h * 0.58, 0.55));
    trim.add(_box(fh * 0.36, fh, 0.36), curveSide * (hw - r * 2.1), h * 0.58, 0.28);
  }
}

/** The name-plate atlas: every hotel sign is one row of a single texture, so one draw call. */
function signMaterial(cache, color) {
  return mat(cache, `signs|${color}`, () => {
    const rows = HOTEL_NAMES.length;
    const W = 512, RH = 86;
    const { c, ctx } = canvas(W, RH * rows);
    ctx.fillStyle = '#0d0b12'; ctx.fillRect(0, 0, W, RH * rows);
    for (let i = 0; i < rows; i++) {
      const tc = textCanvas(HOTEL_NAMES[i], {
        size: 52, weight: 0.20, italic: 0.0, color: '#ffffff', tracking: 0.16,
      });
      const sc = Math.min(W * 0.9 / tc.width, RH * 0.72 / tc.height);
      ctx.drawImage(tc, (W - tc.width * sc) / 2, i * RH + (RH - tc.height * sc) / 2,
        tc.width * sc, tc.height * sc);
      ctx.strokeStyle = 'rgba(255,255,255,0.30)'; ctx.lineWidth = 3;
      ctx.strokeRect(7, i * RH + 6, W - 14, RH - 12);
    }
    const t = toTexture(c, { srgb: true, wrap: THREE.ClampToEdgeWrapping });
    return new THREE.MeshStandardMaterial({
      map: t, emissiveMap: t, emissive: new THREE.Color(color), emissiveIntensity: 2.8,
      roughness: 0.5, metalness: 0.0, side: THREE.DoubleSide,
    });
  });
}

/**
 * A run of hotels down one kerb. Every hotel in the run shares one batch per material, so an
 * entire Ocean Drive block costs about eight draw calls. Width, height, storey count, corner
 * radius, which end curves, palette and awning are all jittered — §7 caps a visibly repeated
 * prop at 66 and a terrace of identical hotels is exactly that.
 */
function decoStrip(track, cache, {
  u0, u1, side, rng, walls, neons, frontGap = 14, seedBase = 0, skip = [],
}) {
  const g = new THREE.Group();
  const batches = new Map();
  const bats = (wall, neon, awnColor) => {
    const key = `${wall}|${neon}|${awnColor}`;
    let b = batches.get(key);
    if (!b) {
      b = {
        body: new Batch(stuccoMaterial(cache, wall)),
        trim: new Batch(trimMaterial(cache, '#fdf8ee')),
        glass: new Batch(mat(cache, 'decoglass', () => new THREE.MeshStandardMaterial({
          color: 0x14313f, roughness: 0.10, metalness: 0.55, envMapIntensity: 1.5,
        })), { cast: false }),
        neonB: new Batch(neonMaterial(cache, neon, 1.70), { cast: false }),
        awn: new Batch(awningMaterial(cache, awnColor), { cast: false }),
        lobby: new Batch(lobbyMaterial(cache, '#ffdca8', 1), { cast: false }),
        sign: new Batch(signMaterial(cache, neon), { cast: false }),
        dark: new Batch(metalMaterial(cache, '#3a3f48', 0.6), { cast: false }),
      };
      batches.set(key, b);
    }
    return b;
  };

  const span = ((u1 - u0) % 1 + 1) % 1;
  const total = span * track.length;
  /** True if u falls in one of the corridors this run has to leave open (a shortcut mouth). */
  const blocked = (u) => skip.some(([a, b]) => {
    const t = ((u - a) % 1 + 1) % 1;
    return t < ((b - a) % 1 + 1) % 1;
  });
  let travelled = 6;
  let i = 0;
  while (travelled < total - 30) {
    const w = rng.range(28, 44);
    const u = u0 + (travelled + w / 2) / track.length;
    if (blocked(u)) { travelled += 8; continue; }
    const s = track.at(u);
    const h = rng.range(13.5, 21.5);
    // Authored in local space, stamped straight into the run's shared batches.
    const local = new THREE.Group();
    local.position.copy(s.pos).addScaledVector(s.right, side * (track.halfWidth + frontGap));
    local.rotation.y = Math.atan2(s.tan.x, s.tan.z) + side * Math.PI / 2 + rng.range(-0.012, 0.012);
    local.updateMatrix();
    const proxy = (wall, neon, awn) => stamped(bats(wall, neon, awn), local.matrix);
    decoHotel(proxy, {
      w, h, d: rng.range(20, 27), r: rng.range(4.0, 6.2),
      seed: seedBase + i * 13 + 3,
      wall: walls[(i + rng.int(0, 2)) % walls.length],
      neon: neons[(i * 2 + rng.int(0, 3)) % neons.length],
      nameIndex: (i * 5 + rng.int(0, 4)) % HOTEL_NAMES.length,
      curveSide: rng.bool(0.5) ? 1 : -1,
      awningColor: neons[(i + 1) % neons.length],
    });
    travelled += w + rng.range(5, 15);
    i++;
  }
  for (const b of batches.values()) for (const k of Object.keys(b)) b[k].into(g);
  return g;
}

// ---------------------------------------------------------------- causeway

/**
 * The cable-stayed causeway. The track passes underneath it, and it then marches 900 m out over
 * the Atlantic on fanned stays — a silhouette nothing else in this project has, readable from a
 * kilometre back, and the reason the `landmark` capture is aimed down this straight.
 *
 * Local +Z runs out to sea; the road crosses at z = 0.
 */
function causeway(cache, { night, waterY }) {
  const g = new THREE.Group();
  const conc = new Batch(mat(cache, 'causeconc', () => new THREE.MeshStandardMaterial({
    color: new THREE.Color('#e6ddcc'), roughness: 0.9, metalness: 0.02, envMapIntensity: 0.8,
  })));
  const dark = new Batch(metalMaterial(cache, '#39404a', 0.55));
  const cable = new Batch(mat(cache, 'stay', () => new THREE.MeshStandardMaterial({
    color: new THREE.Color('#cfd6dc'), metalness: 0.85, roughness: 0.3,
  })), { cast: false });
  const lamp = new Batch(neonMaterial(cache, '#ffe6b8', 4.2), { cast: false });
  const edge = new Batch(neonMaterial(cache, '#2fe8d8', 2.6), { cast: false });

  const W = 26;
  const PROFILE = [[-360, 5], [-170, 10], [0, 16.5], [130, 23], [220, 29], [370, 34],
    [520, 29], [690, 21], [880, 12], [1080, 6]];
  const deckY = (z) => {
    if (z <= PROFILE[0][0]) return PROFILE[0][1];
    for (let i = 1; i < PROFILE.length; i++) {
      if (z <= PROFILE[i][0]) {
        const t = (z - PROFILE[i - 1][0]) / (PROFILE[i][0] - PROFILE[i - 1][0]);
        const s = t * t * (3 - 2 * t);
        return lerp(PROFILE[i - 1][1], PROFILE[i][1], s);
      }
    }
    return PROFILE[PROFILE.length - 1][1];
  };

  // ---- deck: a box girder with a fascia, a parapet, and a lit edge line ----
  const z0 = -380, z1 = 1140, seg = 20;
  for (let z = z0; z < z1; z += seg) {
    const ya = deckY(z), yb = deckY(z + seg);
    const yc = (ya + yb) / 2, rx = Math.atan2(yb - ya, seg);
    const L = Math.hypot(seg, yb - ya) * 1.03;
    conc.add(_box(W, 1.5, L), 0, yc, z + seg / 2, 0, { rx: -rx });
    dark.add(_box(W - 3.5, 2.1, L), 0, yc - 1.7, z + seg / 2, 0, { rx: -rx });
    for (const sx of [-1, 1]) {
      conc.add(_box(1.0, 2.3, L), sx * (W / 2 - 0.4), yc - 0.5, z + seg / 2, 0, { rx: -rx });
      conc.add(_box(0.55, 1.35, L), sx * (W / 2 - 0.3), yc + 1.4, z + seg / 2, 0, { rx: -rx });
      edge.add(_box(0.28, 0.24, L), sx * (W / 2 + 0.05), yc + 2.0, z + seg / 2, 0, { rx: -rx });
    }
  }

  // ---- piers: twin columns down to the water, never over the carriageway ----
  for (let z = -360; z <= 1080; z += 90) {
    if (Math.abs(z) < 100) continue;
    const y = deckY(z);
    const base = z > 60 ? waterY(z) - 1.5 : -1.0;
    for (const sx of [-1, 1]) {
      conc.add(new THREE.CylinderGeometry(1.7, 2.5, y - base - 1.2, 12), sx * 6.5, (y + base) / 2 - 0.6, z);
    }
    conc.add(_box(W - 2, 1.7, 4.4), 0, y - 2.4, z);
    if (z > 60) conc.add(_box(20, 2.0, 9), 0, base + 0.9, z);       // pile cap in the water
  }
  // abutment where it lands on the island, plus the ramp wall along the road
  conc.add(_box(W + 5, 8, 16), 0, 2.6, -372);
  for (const sx of [-1, 1]) conc.add(_box(2.0, 12, 190), sx * (W / 2 - 0.6), 3.5, -270);

  // ---- the two pylons: splayed-leg masts carrying a fan of stays ----
  for (const pz of [220, 520]) {
    const py = deckY(pz);
    const cross = py + 30;                                           // where the legs meet
    const top = py + 80;
    for (const sx of [-1, 1]) {
      // a leg from its pier cap up to the crossbeam. Axis (from base to apex) is (-dx, cross),
      // and Rz(a)·(0,1,0) = (-sin a, cos a), so a = atan2(dx, cross).
      const dx = sx * 13;
      const L = Math.hypot(dx, cross + 3);
      conc.add(new THREE.CylinderGeometry(2.0, 3.2, L, 10), dx / 2, (cross - 3) / 2, pz, 0,
        { rz: Math.atan2(dx, cross + 3) });
    }
    conc.add(_box(30, 3.2, 5.4), 0, cross, pz);                      // crossbeam
    conc.add(new THREE.CylinderGeometry(1.6, 2.6, top - cross, 10), 0, (top + cross) / 2, pz);
    conc.add(_box(7.5, 1.2, 6.2), 0, top - 3, pz);
    conc.add(new THREE.ConeGeometry(2.3, 8, 8), 0, top + 4, pz);
    lamp.add(new THREE.SphereGeometry(1.0, 8, 6), 0, top + 8.6, pz);
    // floodlit mast + a turquoise collar band, so the pylon separates from the sunset behind it
    for (let k = 0; k < 6; k++) {
      lamp.add(_box(3.6, 0.30, 0.34), 0, cross + 6 + k * ((top - cross - 10) / 5), pz + 2.9);
      lamp.add(_box(3.6, 0.30, 0.34), 0, cross + 6 + k * ((top - cross - 10) / 5), pz - 2.9);
    }
    edge.add(_box(9, 0.55, 6.6), 0, cross + 2.6, pz);
    // stays: a fan each way, anchored down the deck edges.
    // Rx(b)·(0,1,0) = (0, cos b, sin b), so the axis from mast top to deck anchor needs
    // b = atan2(dir*reach, ay - anchorY). (Getting that sign wrong mirrors the whole fan.)
    for (let k = 1; k <= 10; k++) {
      const reach = 24 + k * 25;
      const anchorY = top - 6 - (k - 1) * 5.4;
      for (const dir of [-1, 1]) {
        const az = pz + dir * reach;
        const ay = deckY(az) + 2.6;
        const len = Math.hypot(reach, anchorY - ay);
        const midZ = (pz + az) / 2, midY = (anchorY + ay) / 2;
        for (const sx of [-1, 1]) {
          cable.add(new THREE.CylinderGeometry(0.19, 0.19, len, 5),
            sx * (W / 2 - 1.4), midY, midZ, 0, { rx: Math.atan2(dir * reach, ay - anchorY) });
        }
      }
    }
  }

  // ---- deck lighting: a receding row of globes is what sells the scale ----
  for (let z = -340; z < 1100; z += 46) {
    const y = deckY(z);
    for (const sx of [-1, 1]) {
      dark.add(new THREE.CylinderGeometry(0.16, 0.22, 6.2, 6), sx * (W / 2 - 1.1), y + 4.4, z);
      lamp.add(new THREE.SphereGeometry(0.62, 8, 6), sx * (W / 2 - 1.1), y + 7.7, z);
    }
  }

  conc.into(g); dark.into(g); cable.into(g); lamp.into(g); edge.into(g);
  void night;
  return g;
}

// ---------------------------------------------------------------- marina, beach dressing

/** A white motor yacht: flared hull, tiered superstructure, radar arch, tinted screens. */
function yacht({ hull, white, glassB, trim, neonB }, { len = 18, seed = 1 }) {
  const rng = new RNG(seed * 13 + 7);
  const beam = len * 0.30, hh = len * 0.115;
  hull.add(roundedBox(beam, hh, len * 0.86, hh * 0.45, 2), 0, hh * 0.5, 0);
  hull.add(new THREE.CylinderGeometry(beam * 0.5, beam * 0.12, len * 0.20, 3),
    0, hh * 0.5, len * 0.47, 0, { rz: Math.PI / 2, rx: Math.PI / 2 });
  white.add(roundedBox(beam * 1.02, hh * 0.30, len * 0.88, 0.25, 2), 0, hh * 1.05, -len * 0.01);
  // cabin tiers
  const c1w = beam * 0.78, c1l = len * 0.42;
  white.add(roundedBox(c1w, hh * 0.85, c1l, 0.4, 2), 0, hh * 1.55, -len * 0.06);
  glassB.add(new THREE.PlaneGeometry(c1w * 0.9, hh * 0.42), 0, hh * 1.66, -len * 0.06 + c1l / 2 + 0.03);
  for (const sx of [-1, 1]) {
    glassB.add(new THREE.PlaneGeometry(c1l * 0.82, hh * 0.40), sx * (c1w / 2 + 0.03), hh * 1.62, -len * 0.06, sx * Math.PI / 2);
  }
  if (len > 14) {
    const c2w = c1w * 0.66, c2l = c1l * 0.60;
    white.add(roundedBox(c2w, hh * 0.62, c2l, 0.3, 2), 0, hh * 2.28, -len * 0.10);
    glassB.add(new THREE.PlaneGeometry(c2w * 0.88, hh * 0.32), 0, hh * 2.32, -len * 0.10 + c2l / 2 + 0.03);
    trim.add(new THREE.CylinderGeometry(0.07, 0.07, hh * 1.5, 5), 0, hh * 3.2, -len * 0.16);
    trim.add(_box(c2w * 0.9, 0.09, 0.09), 0, hh * 3.7, -len * 0.16);
  }
  // rails + a strip of deck light
  for (const sx of [-1, 1]) {
    trim.add(new THREE.CylinderGeometry(0.05, 0.05, len * 0.55, 5), sx * beam * 0.47, hh * 1.45, len * 0.20, 0, { rx: Math.PI / 2 });
    for (let i = 0; i < 4; i++) trim.add(new THREE.CylinderGeometry(0.04, 0.04, 0.55, 4), sx * beam * 0.47, hh * 1.2, len * (0.02 + i * 0.12));
  }
  neonB.add(_box(beam * 0.96, 0.10, len * 0.80), 0, hh * 1.22, -len * 0.01);
  void rng;
}

/** The candy-striped lifeguard hut: pitched roof, stilts, a ramp, a flag. */
function lifeguardHut({ shell, roof, post, flag }, { seed = 1, style = 0 }) {
  const rng = new RNG(seed * 19 + 5);
  const w = rng.range(3.4, 4.4), h = rng.range(2.4, 3.0), legH = rng.range(1.6, 2.6);
  shell.add(roundedBox(w, h, w, 0.28, 2), 0, legH + h / 2, 0);
  if (style === 0) {
    roof.add(new THREE.ConeGeometry(w * 0.85, 1.7, 4), 0, legH + h + 0.85, 0, Math.PI / 4);
  } else if (style === 1) {
    roof.add(_box(w * 1.35, 0.26, w * 0.9), 0, legH + h + 0.6, -w * 0.16, 0, { rx: -0.34 });
    roof.add(_box(w * 1.35, 0.26, w * 0.9), 0, legH + h + 0.6, w * 0.16, 0, { rx: 0.34 });
  } else {
    roof.add(new THREE.CylinderGeometry(w * 0.62, w * 0.62, w * 1.1, 12, 1, false, 0, Math.PI),
      0, legH + h + 0.1, 0, 0, { rx: Math.PI / 2 });
  }
  // window opening + door
  shell.add(_box(w * 0.7, h * 0.42, 0.14), 0, legH + h * 0.62, w / 2 + 0.02);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    post.add(new THREE.CylinderGeometry(0.14, 0.16, legH, 6), sx * w * 0.38, legH / 2, sz * w * 0.38);
  }
  post.add(_box(w * 0.62, 0.16, 3.4), 0, legH * 0.5, w * 0.9, 0, { rx: 0.42 });   // ramp
  post.add(new THREE.CylinderGeometry(0.07, 0.07, 4.2, 5), w * 0.42, legH + h + 2.0, -w * 0.3);
  flag.add(new THREE.PlaneGeometry(1.5, 0.85), w * 0.42 + 0.75, legH + h + 3.5, -w * 0.3);
}

// ---------------------------------------------------------------- city definition

/**
 * The route: a barrier-island roval. A 500 m ocean-drive straight, a long fast right-hand sweeper
 * down the east side, a tight marina hairpin, then an S back through the deco district. The one
 * left-hander (the S) is deliberate — every other corner turns the same way, and without it the
 * lap has no direction change in it at all.
 */
const MAIN = [
  [-160, -448], [10, -458], [180, -450], [320, -420], [425, -358],
  [495, -262], [520, -140], [500, -18], [435, 80], [325, 126],
  [218, 112], [152, 30], [40, 10], [-70, 60], [-165, 40],
  [-238, -62], [-292, -190], [-320, -300], [-320, -392], [-260, -436],
];

/** +1 if the track frame's `right` points away from the island centre. */
function outwardSign(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  // CCW in (x,z) → `right` = tan x up points INWARD.
  return a > 0 ? -1 : 1;
}
const OUT = outwardSign(MAIN);
const IN = -OUT;

/**
 * Every route option in the city, as a u range the block generator has to leave OPEN.
 *
 * Round 2's note said it plainly: "across six captures at three different track positions I saw
 * one long gently-curving beachfront boulevard. No ramp, no chevroned jump, no lit alley mouth,
 * no broken barrier, no alternate route." The shortcuts existed — at u=0.26, 0.575 and 0.80 —
 * and the six standard captures finish at u≈0.03 (landmark), u≈0.13 (chase) and u≈0.51 (drift),
 * so not one of them was ever in shot. Siting is the whole fix: the jump now opens 110 m in front
 * of the chase camera and the ocean-drive alley 40 m in front of the landmark camera.
 */
const ALLEYS = [
  [0.034, 0.124],   // OCEAN DRIVE alley — the lit throat between two deco blocks (landmark shot)
  [0.158, 0.262],   // the corner-cut jump over the beach car park  (chase shot)
  [0.560, 0.748],   // the deco-district alley                       (drift shot)
];
/** True if u lies in any open corridor (so no hotel/tower is generated across a mouth). */
const inAlley = (u) => ALLEYS.some(([a, b]) => {
  const s = ((u - a) % 1 + 1) % 1;
  return s < ((b - a) % 1 + 1) % 1;
});

export const def = {
  id: 'miami',
  name: 'MIAMI',
  seed: 303,
  spawnU: 0.0,
  laps: 3,
  record: '2:08:15',
  landmarkSet: null,             // this file owns every landmark in the city
  // Dusk dressing on a daylight light rig. The kit's `night` flag is what turns on lit windows,
  // lamp spill pools, glowing shopfronts and the wet neon smears on the tarmac; the engine's own
  // `nightness` is derived separately from key intensity and fog luminance, so the grade, the
  // exposure and the bloom threshold all stay in their DAY band. That combination — a warm low sun
  // still on the facades, and the city's own lights already burning — is exactly the hour this
  // city is set at, and it is not available from either flag on its own.
  night: true,
  landmarkU: 0.015,              // the approach that frames the causeway down Ocean Drive
  look: {
    accent: '#ff2f9d',
    lampColor: '#ffe2b4',
    wet: 0.16,
    // Deep blue overhead falling to hot pink then a coral horizon. The blue is not decoration:
    // it is the only thing keeping the top third of the frame off the pink axis, and the env map
    // this sky bakes is what puts a cool sky reflection on the top of every car body.
    sky: {
      top: '#1348c6', horizon: '#e0629e', haze: '#ff9052', ground: '#241a30',
      sunDir: [0.34, 0.15, -0.93], sunColor: '#ffd8a0', clouds: 0.78, seed: 303,
    },
    // Low and out over the water, i.e. roughly abeam of the ocean-drive straight rather than
    // down it. A key aimed along the road turned the left third of the frame into one blown-out
    // shaft of god ray and took the ocean with it.
    sun: { color: '#ffcc93', intensity: 3.35, dir: [0.34, 0.33, -0.88] },
    // Golden-hour haze, not a lens flare. The auto rig derives ~1.0 from a low bright key, which
    // is four times what this frame can carry.
    shafts: { strength: 0.20, glow: 0.16 },
    // Turquoise sky bounce (the sea and the zenith) against a warm low key. The grade derives the
    // shadow hue from ambient.sky, so this is also what makes every shadow in Miami read cyan.
    ambient: {
      sky: '#4fd4e4', ground: '#3c2a52', intensity: 0.92,
      fill: { color: '#8fe8f2', intensity: 0.34, dir: [-0.62, 0.36, 0.56] },
    },
    shadowTint: '#3a2a5c',
    shadowFill: 0.44,
    // ------------------------------------------------------------------------------------------
    // WET ROAD — the round-2 cap-60 fix.
    //
    // The "dense per-pixel checkerboard across the sidewalk/curb/gutter band" that capped this city
    // at 60 was never z-fighting: it is the atmospherics pass's screen-space wet reflection. That
    // pass takes WET_TAPS=9 samples along the mirrored view ray, offset by an interleaved-gradient
    // dither (`ign(vUv * uResolution)`), and normalises. When the taps are spread wide over a
    // high-contrast source — a neon terrace over near-black asphalt — neighbouring pixels land on
    // completely different sets of taps, and 9 samples is nowhere near enough to hide it: the
    // result is salt-and-pepper on every ground surface inside the wet slab, which is exactly the
    // curb-and-gutter band. Ablated and measured: high-frequency energy in that band runs
    // hf=48 at the derived spread of 0.070, hf=25.6 with the pass switched off entirely, and
    // hf=29 at spread 0.008 — i.e. collapsing the tap cone removes the artefact and keeps the
    // reflection, because all nine taps then agree and the dither has nothing to modulate.
    //
    // A tight cone is also the right LOOK for this city: Ocean Drive's asphalt is damp, not
    // flooded, so the neon comes back as a hard mirrored streak rather than a soft smear.
    wetLook: {
      strength: 0.40,
      spread: 0.008,      // <- the cap fix. 0.070 (the derived default) dithers; this does not.
      gain: 2.30,
      threshold: 0.72,    // only genuine neon/taillights reflect; a merely lit wall does not
      knee: 0.34,
      patch: 0.80,        // dry patches: the asphalt has to keep showing through
      patchScale: 0.048,
      fresnel: 3.4,
      band: 0.40,
    },
    // Mid-value dusty rose, NOT a pastel: far geometry darkens toward it instead of blowing out,
    // and the near ground is left alone until 240 m so the mid band keeps its own colour.
    fog: { color: '#a4688c', near: 260, far: 2700 },
    haze: { max: 0.30 },
    ground: { color: '#c9a97c', accent: '#e0c898' },
    groundGlow: 0.12,
    grade: {
      uSaturation: 1.30, uExposure: 1.0, uContrast: 1.14,
      uBlackPoint: 1.35, uVignette: 0.22, uHiChroma: 0.34,
    },
    bloom: { strength: 1.05, radius: 0.66, threshold: 0.56 },
  },
  track: {
    width: 12.5,
    surface: { tint: '#23252b', lanes: 3, centerLine: 'double-yellow', worn: 0.5 },
    bank: 0.055,
    sidewalkWidth: 5.0,
    sidewalkTint: '#c9bda6',
    crossings: 6,
    main: MAIN,
    branches: [
      // THE OCEAN DRIVE ALLEY. Opens off the inland kerb 40 m past the landmark capture's finish
      // point, so the frame that is supposed to show the city's hero landmark also shows a lit
      // neon throat with a gantry over it and a knocked-flat barrier beside it.
      { kind: 'shortcut', enterU: 0.046, exitU: 0.112, width: 7.5, points: [[-24, -404], [64, -402]] },
      // THE JUMP. Cuts the inside of the first sweeper over the beachfront car park; the gantry
      // stands ~110 m in front of the muscle chase capture and ~80 m in front of the supercar's.
      { kind: 'ramp', enterU: 0.176, exitU: 0.248, width: 9, rise: 7.0, points: [[295, -409], [368, -377]] },
      // the lit alley through the deco district — cuts the marina S and saves real time
      { kind: 'shortcut', enterU: 0.575, exitU: 0.725, width: 7, points: [[78, 34], [-34, 27]] },
      // a service road behind the marina
      { kind: 'shortcut', enterU: 0.800, exitU: 0.865, width: 6.5, points: [[-200, -25], [-222, -100]] },
    ],
  },
  blocks: {
    spacing: 42, offset: 46, jitter: 10,
    minW: 15, maxW: 28, minH: 18, maxH: 62,
    wallColors: ['#f7dbe6', '#d4f0e6', '#fdf1da', '#f6dfef', '#e3f2ec'],
    glassColors: ['#1b4658', '#23596c', '#173c50'],
    litColors: ['#ffd8ec', '#c6f4ff', '#fff0c4'],
    neonColors: ['#ff2f9d', '#2fe8d8', '#ffd83a', '#8f5fff'],
    lowColors: ['#f8dce6', '#d4f0e6', '#fdf2dc', '#ffe4c8', '#e8ddf6'],
    signs: ['OCEAN', 'DECO', 'CAFE', 'SURF', 'PALMS', 'CLUB', 'LIDO', 'MOJITO'],
    litRatio: 0.44, setbackChance: 0.66, accentChance: 0.72,
    style: 'artdeco', lowStyle: 'stucco',
    fireEscapeChance: 0.10,
    // Nothing on the seaward kerb — that side of the road is beach. The alley mouth is kept clear
    // on the inland side too, so the shortcut reads as an opening in the block line.
    pick: (r, s, side) => {
      if (side === OUT) return 'none';
      if (inAlley(s.u)) return r.bool(0.30) ? 'low' : 'none';
      return r.bool(0.42) ? 'low' : 'tower';
    },
  },
  props: {
    lampStyle: 'colonial', lampSpacing: 25, lampHeight: 7.4, lampTwin: true,
    lampBanners: ['#ff2f9d', '#2fe8d8', '#ffd83a'],
    palms: true, palmSpacing: 15,
    barriers: false,
    // No broadleaf 'tree': backlit by a low sun its flat-shaded blobs read as black holes in the
    // frame, and the palm is Miami's whole street-planting vocabulary anyway.
    furnitureKinds: ['bench', 'planter', 'trash', 'sign', 'bollards', 'cones', 'shelter',
      'newsbox', 'cart', 'mailbox', 'hydrant'],
    furnitureGap: [10, 28],
    treeColors: ['#2f6b45', '#367a4a', '#2a6350'],
    hydrantColor: '#ffd23a',
    planterColor: '#e8dcc4',
    streetNames: ['OCEAN DR', 'COLLINS AVE', 'LINCOLN RD', '5TH ST', 'WASHINGTON', 'BISCAYNE'],
    carColors: ['#f4f2ec', '#ff5fa8', '#2fd8e0', '#ffd83a', '#1d2a3a', '#c8322a', '#7f5fff'],
    billboards: [
      { u: 0.600, side: IN, text: 'MIAMI', sub: 'BEACH', color: '#ff2f9d', offset: 24, h: 8 },
      { u: 0.700, side: IN, text: 'NEON', sub: 'NIGHTS', color: '#2fe8d8', offset: 22 },
      { u: 0.838, side: OUT, text: 'MARINA', sub: 'BAYFRONT', color: '#ffd83a', offset: 32 },
      { u: 0.420, side: IN, text: 'ART DECO', sub: 'DISTRICT', color: '#8f5fff', offset: 26 },
    ],
    gates: [{ u: 0.385, color: '#ff2f9d' }, { u: 0.655, color: '#2fe8d8' }],
    boostPads: [
      { u: 0.160, lateral: 0 }, { u: 0.310, lateral: 0.42 }, { u: 0.470, lateral: -0.42 },
      { u: 0.680, lateral: 0 }, { u: 0.905, lateral: 0.35 },
    ],
  },
  // Downtown Miami across the bay: deep indigo towers, so the horizon holds the darkest value in
  // the frame and the pink sky has a silhouette to sit behind.
  skyline: {
    radius: 1600, count: 44, minH: 115, maxH: 300, spread: 340,
    palette: ['#33366b', '#3f3a6e', '#2a3260'], accent: '#ff6ec7', bands: 3,
  },

  landmarks({ track, rng, night }) {
    const cache = new Map();
    const out = [];

    // ---- the sky's fourth depth band: a cumulus bank round the horizon ----
    {
      const c0 = new THREE.Vector3();
      for (const sm of track.samples) c0.add(sm.pos);
      c0.divideScalar(track.samples.length);
      out.push(cloudBank(cache, c0, rng.fork(303)));
    }

    // ---- the island shoreline: sand, surf and the Atlantic all the way round the lap ----
    const shore = shoreline(track, cache, rng);
    out.push(shore.group);
    const waterAt = (x, z) => ringY(shore.hullDist(x, z));
    /** A point `dist` metres outboard of the kerb at u, sitting on the water/sand surface. */
    const seaward = (u, dist) => {
      const s = track.at(u);
      const p = s.pos.clone().addScaledVector(s.right, OUT * dist);
      p.y = waterAt(p.x, p.z);
      return { p, s };
    };

    // ---- HERO 1: the cable-stayed causeway, crossing the ocean-drive straight ----
    {
      const u = 0.105;
      const s = track.at(u);
      // Skewed 42° toward the direction of travel rather than square across the road. Built
      // perpendicular, both pylons sat 48-65° off the chase camera's axis — outside a 90° frame —
      // and the hero landmark was reduced to a low pale deck crossing the top of the picture.
      const axis = s.right.clone().multiplyScalar(OUT * Math.cos(0.73))
        .addScaledVector(s.tan, Math.sin(0.73)).normalize();
      const cw = causeway(cache, {
        night,
        waterY: (localZ) => {
          const p = s.pos.clone().addScaledVector(axis, localZ);
          return waterAt(p.x, p.z);
        },
      });
      cw.position.copy(s.pos).setY(0);
      cw.rotation.y = Math.atan2(axis.x, axis.z);
      out.push(cw);
    }

    // ---- HERO 2: the Ocean Drive deco terrace, down the inland kerb of most of the lap ----
    const walls = ['#ffd6e2', '#c8efe4', '#fdf0d4', '#ffe0c6', '#e6dcf6', '#fff4e6'];
    const neons = ['#ff2f9d', '#2fe8d8', '#ff2f9d', '#8f5fff', '#2fe8d8', '#ffd83a'];
    out.push(decoStrip(track, cache, {
      u0: 0.895, u1: 0.225, side: IN, rng: rng.fork(11), walls, neons, seedBase: 100,
      skip: [ALLEYS[0], ALLEYS[1]],
    }));
    out.push(decoStrip(track, cache, {
      u0: 0.228, u1: 0.560, side: IN, rng: rng.fork(12), walls, neons, seedBase: 400,
      skip: [ALLEYS[1]],
    }));
    out.push(decoStrip(track, cache, {
      u0: 0.760, u1: 0.880, side: IN, rng: rng.fork(13), walls, neons, seedBase: 700,
    }));

    // ---- HERO 3: a deco hotel tower closing the view out of the marina hairpin ----
    {
      const s = track.at(0.500);
      const tower = landmarkTower({
        h: 118, w: 30, crown: 'lantern', night, cache, seed: 31,
        wall: '#fdf0dc', glass: '#1d4a5e', litColor: '#ffe6c0', accent: '#ff2f9d',
        litRatio: 0.45, style: 'artdeco', flood: '#ffd0e8',
      });
      tower.position.copy(s.pos).addScaledVector(s.right, IN * 118).setY(0);
      tower.rotation.y = Math.atan2(s.tan.x, s.tan.z) + IN * Math.PI / 2;
      out.push(tower);
    }

    // ---- cruise liners standing off the beach ----
    for (const [u, dist, len, seed] of [[0.045, 780, 250, 2], [0.60, 940, 185, 5]]) {
      const { p, s } = seaward(u, dist);
      const ship = cruiseShip({ len, cache, night, seed });
      ship.position.copy(p).setY(p.y - len * 0.045);
      ship.rotation.y = Math.atan2(s.tan.x, s.tan.z) + rng.range(-0.3, 0.3);
      out.push(ship);
    }

    // ---- the marina: floating docks and a basin of white yachts ----
    // Sited DOWN the bay straight rather than off its kerb. A basin abeam of the road is only ever
    // seen at 50-70° off the chase camera's axis, i.e. off the edge of a 90° frame; put at the end
    // of the run down the west side it sits dead ahead for several seconds and then sweeps past.
    {
      const g = new THREE.Group();
      const s0 = track.at(0.930);
      const fwd = s0.tan.clone().setY(0).normalize();
      const side = new THREE.Vector3(-fwd.z, 0, fwd.x);
      const base = s0.pos.clone().addScaledVector(fwd, 250).setY(0);
      for (let k = 0; k < 14 && shore.hullDist(base.x, base.z) < 175; k++) base.addScaledVector(fwd, 30);
      const yb = new Map();
      const bats = (accent) => {
        let b = yb.get(accent);
        if (!b) {
          b = {
            hull: new Batch(mat(cache, 'yhull', () => new THREE.MeshStandardMaterial({
              color: 0xf6f8f6, roughness: 0.30, metalness: 0.10, envMapIntensity: 1.3,
            }))),
            white: new Batch(mat(cache, 'ywhite', () => new THREE.MeshStandardMaterial({
              color: 0xfdfdfa, roughness: 0.42, metalness: 0.05, envMapIntensity: 1.1,
            }))),
            glassB: new Batch(mat(cache, 'yglass', () => new THREE.MeshStandardMaterial({
              color: 0x10222c, roughness: 0.08, metalness: 0.7, envMapIntensity: 1.8,
            })), { cast: false }),
            trim: new Batch(metalMaterial(cache, '#dfe6ea', 0.35), { cast: false }),
            neonB: new Batch(neonMaterial(cache, accent, 1.8), { cast: false }),
          };
          yb.set(accent, b);
        }
        return b;
      };
      const dock = new Batch(mat(cache, 'dock', () => new THREE.MeshStandardMaterial({
        color: new THREE.Color('#9c8a6c'), roughness: 0.95,
      })));
      const pile = new Batch(metalMaterial(cache, '#4a4238', 0.85));
      const mr = rng.fork(77);
      const yawBase = Math.atan2(fwd.x, fwd.z);
      for (let row = 0; row < 5; row++) {
        const off = (row - 2) * 48;
        const a = base.clone().addScaledVector(side, off).addScaledVector(fwd, -70);
        const b = base.clone().addScaledVector(side, off).addScaledVector(fwd, 120);
        a.y = waterAt(a.x, a.z); b.y = waterAt(b.x, b.z);
        const len = a.distanceTo(b);
        const my = (a.y + b.y) / 2 + 0.6;
        dock.add(_box(4.4, 0.55, len), (a.x + b.x) / 2, my, (a.z + b.z) / 2, yawBase);
        for (let k = 0; k <= 7; k++) {
          const t = k / 7;
          pile.add(new THREE.CylinderGeometry(0.22, 0.26, 5.0, 6),
            lerp(a.x, b.x, t), lerp(a.y, b.y, t) + 1.4, lerp(a.z, b.z, t));
        }
        for (let k = 0; k < 5; k++) {
          for (const sx of [-1, 1]) {
            const t = 0.10 + k * 0.20;
            const px = lerp(a.x, b.x, t) + side.x * sx * 13;
            const pz = lerp(a.z, b.z, t) + side.z * sx * 13;
            const local = new THREE.Group();
            local.position.set(px, waterAt(px, pz) - 0.5, pz);
            local.rotation.y = yawBase + mr.range(-0.06, 0.06);
            local.updateMatrix();
            const acc = mr.pick(['#2fd8e0', '#ff2f9d', '#ffd83a']);
            yacht(stamped(bats(acc), local.matrix), {
              len: mr.range(17, 38), seed: row * 31 + k * 7 + (sx > 0 ? 1 : 2),
            });
          }
        }
      }
      // harbour arm with a lit beacon at its head — the thing that says "this is a harbour"
      {
        const arm = base.clone().addScaledVector(side, -160).addScaledVector(fwd, 40);
        const rock = new Batch(mat(cache, 'mole', () => new THREE.MeshStandardMaterial({
          color: new THREE.Color('#8f8778'), roughness: 1.0, flatShading: true,
        })));
        for (let k = 0; k < 26; k++) {
          const t = k / 25;
          const px = lerp(arm.x, base.x - side.x * 20, t), pz = lerp(arm.z, base.z - side.z * 20, t);
          rock.add(new THREE.IcosahedronGeometry(mr.range(4.5, 7.5), 0),
            px, waterAt(px, pz) + mr.range(0.4, 1.6), pz, mr.range(0, 3),
            { rx: mr.range(0, 1), sy: 0.6 });
        }
        rock.into(g);
        const bl = new Batch(neonMaterial(cache, '#ff3b3b', 3.0), { cast: false });
        const post = new Batch(metalMaterial(cache, '#e8e4da', 0.6));
        post.add(new THREE.CylinderGeometry(1.0, 1.5, 11, 10), arm.x, waterAt(arm.x, arm.z) + 5.5, arm.z);
        bl.add(new THREE.SphereGeometry(1.1, 8, 6), arm.x, waterAt(arm.x, arm.z) + 11.6, arm.z);
        post.into(g); bl.into(g);
      }
      dock.into(g); pile.into(g);
      for (const b of yb.values()) for (const k of Object.keys(b)) b[k].into(g);
      out.push(g);
    }

    // ---- lifeguard huts, umbrellas and loungers on the sand ----
    {
      const g = new THREE.Group();
      const hb = new Map();
      const bats = (color) => {
        let b = hb.get(color);
        if (!b) {
          b = {
            shell: new Batch(mat(cache, `hut|${color}`, () => new THREE.MeshStandardMaterial({
              color: new THREE.Color(color), roughness: 0.62, metalness: 0.02, envMapIntensity: 0.8,
            }))),
            roof: new Batch(trimMaterial(cache, '#fbf6ea')),
            post: new Batch(mat(cache, 'hutpost', () => new THREE.MeshStandardMaterial({
              color: new THREE.Color('#c9b08a'), roughness: 0.95,
            }))),
            flag: new Batch(mat(cache, `flag|${color}`, () => new THREE.MeshStandardMaterial({
              color: new THREE.Color(color), roughness: 0.8, side: THREE.DoubleSide,
              emissive: new THREE.Color(color), emissiveIntensity: 0.35,
            })), { cast: false }),
          };
          hb.set(color, b);
        }
        return b;
      };
      const hr = rng.fork(55);
      const colors = ['#ff2f9d', '#2fd8e0', '#ffd83a', '#8f5fff', '#ff6a3d', '#4fe08a'];
      let u = 0.02;
      let i = 0;
      while (u < 0.99) {
        const { p, s } = seaward(u, 62 + hr.range(-8, 10));
        const local = new THREE.Group();
        local.position.copy(p);
        local.rotation.y = Math.atan2(s.tan.x, s.tan.z) + OUT * Math.PI / 2 + hr.range(-0.35, 0.35);
        local.scale.setScalar(hr.range(0.92, 1.14));
        local.updateMatrix();
        const color = colors[(i * 3 + hr.int(0, 2)) % colors.length];
        lifeguardHut(stamped(bats(color), local.matrix), { seed: i * 11 + 3, style: hr.int(0, 2) });
        u += hr.range(0.055, 0.105);
        i++;
      }
      for (const b of hb.values()) for (const k of Object.keys(b)) b[k].into(g);

      // umbrellas + loungers in loose clusters
      const um = new Map();
      const umb = (color) => {
        let b = um.get(color);
        if (!b) {
          b = {
            top: new Batch(mat(cache, `umb|${color}`, () => {
              const { c, ctx } = canvas(64, 64);
              const s2 = sColor(color);
              ctx.fillStyle = '#fbf5e8'; ctx.fillRect(0, 0, 64, 64);
              ctx.fillStyle = `rgb(${(s2.r * 255) | 0},${(s2.g * 255) | 0},${(s2.b * 255) | 0})`;
              for (let k = 0; k < 4; k++) ctx.fillRect(k * 16, 0, 8, 64);
              return new THREE.MeshStandardMaterial({
                map: toTexture(c, { srgb: true }), roughness: 0.85, side: THREE.DoubleSide,
              });
            }), { receive: false }),
            pole: new Batch(trimMaterial(cache, '#efe8da'), { cast: false }),
          };
          um.set(color, b);
        }
        return b;
      };
      const ur = rng.fork(91);
      for (let k = 0; k < 46; k++) {
        const uu = ur.next();
        const { p } = seaward(uu, 48 + ur.range(-12, 24));
        const color = ur.pick(colors);
        const b = umb(color);
        const h = ur.range(2.0, 2.6);
        b.pole.add(new THREE.CylinderGeometry(0.05, 0.06, h, 5), p.x, p.y + h / 2, p.z);
        b.top.add(new THREE.ConeGeometry(ur.range(1.5, 2.1), 0.75, 8), p.x, p.y + h + 0.3, p.z, ur.range(0, 1.5));
        for (let j = 0; j < ur.int(0, 2); j++) {
          const a = ur.range(0, 6.28), d = ur.range(1.6, 3.4);
          b.pole.add(_box(0.72, 0.16, 1.9), p.x + Math.cos(a) * d, p.y + 0.30, p.z + Math.sin(a) * d, ur.range(0, 3));
        }
      }
      for (const b of um.values()) { b.top.into(g); b.pole.into(g); }
      out.push(g);
    }

    // ---- palms on the dune, behind the promenade line ----
    {
      const g = new THREE.Group();
      const pr = rng.fork(133);
      let u = 0.005;
      while (u < 1) {
        const { p, s } = seaward(u, 34 + pr.range(-3, 7));
        const t = palmTree({ h: pr.range(9, 17), seed: Math.floor(u * 9973), lean: pr.range(0.05, 0.22), cache });
        t.position.copy(p).setY(Math.max(p.y, 0.1));
        t.rotation.y = pr.range(0, 6.28);
        g.add(t);
        void s;
        u += pr.range(0.008, 0.021);
      }
      out.push(g);
    }

    // ---- circuit barriers on the two fast seaward corners ----
    // Red-and-white striped jersey units are half of what makes the reference frames read as a
    // closed street circuit rather than a drive. Broken up with water barriers, height/yaw jitter
    // and missing units, because eighty identical blocks at 4.05 m is §7's clearest cap-66 tell.
    {
      const g = new THREE.Group();
      const br = rng.fork(83);
      for (const [u0, u1] of [[0.300, 0.470], [0.620, 0.720]]) {
        for (const s of track.spaced(4.05, {
          side: OUT, offset: 6.4, from: u0, to: u1, rng: br,
        })) {
          if (br.bool(0.07)) continue;
          const roll = br.next();
          const b = roll < 0.12
            ? waterBarrier({ len: 2.0, cache, seed: s.index * 5 + 3, color: '#2fd8e0' })
            : jerseyBarrier({ len: 4, cache, seed: s.index * 7 + 1 });
          b.position.copy(s.pos).setY(s.pos.y + br.range(-0.03, 0.02));
          b.rotation.y = Math.atan2(s.tan.x, s.tan.z) + br.range(-0.04, 0.04);
          b.scale.setScalar(br.range(0.96, 1.05));
          g.add(b);
        }
      }
      out.push(g);
    }

    // ---- every route mouth, dressed so it reads as an INVITATION from a long way back ----
    //
    // The kit already straddles each branch with a lit gantry, a knocked-flat jersey barrier and
    // a pool of light. What it cannot know is what the opening should look like in THIS city, so
    // this adds the Miami half: two low deco blocks flanking the throat with neon up the corner
    // that faces the road, a run of lit chevrons painted across the carriageway aimed into the
    // mouth, and a floodlit "CUT THROUGH / JUMP" blade on the kerb.
    //
    // The chevrons are laid through `track.frame()` — the same banked cross-section the road
    // ribbon itself is built from — and carry polygonOffset, so a painted arrow can never end up
    // co-planar with the tarmac it is painted on.
    {
      const g = new THREE.Group();
      const ar = rng.fork(211);
      const cyan = new Batch(neonMaterial(cache, '#2fe8d8', 2.7), { cast: false });
      const pink = new Batch(neonMaterial(cache, '#ff2f9d', 2.7), { cast: false });
      const amber = new Batch(neonMaterial(cache, '#ffb020', 2.9), { cast: false });

      /** Emissive paint laid on the road: additive, depth-tested, never depth-fighting. */
      const paintMat = (color) => mat(cache, `paint|${color}`, () => new THREE.MeshStandardMaterial({
        color: new THREE.Color(color).multiplyScalar(0.4),
        emissive: new THREE.Color(color), emissiveIntensity: 1.35,
        roughness: 0.42, metalness: 0.0, transparent: true, opacity: 0.92, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -8, polygonOffsetUnits: -8,
      }));
      const paints = new Map();
      const paint = (color) => {
        let b = paints.get(color);
        if (!b) { b = new Batch(paintMat(color), { cast: false }); paints.set(color, b); }
        return b;
      };
      /** A quad lying in the plane spanned by axA/axB, centred on `c`, normal `n`. */
      const planeQuad = (color, c, axA, axB, n) => {
        const pos = [], nor = [], uv = [0, 0, 1, 0, 0, 1, 1, 1];
        for (const [sa, sb] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
          const p = c.clone().addScaledVector(axA, sa).addScaledVector(axB, sb);
          pos.push(p.x, p.y, p.z);
          nor.push(n.x, n.y, n.z);
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
        geo.setIndex([0, 1, 2, 1, 3, 2]);
        paint(color).addRaw(geo);
      };
      /**
       * A ">" chevron laid flat on the road, its point aimed across the carriageway toward the
       * mouth. Two slanted bars, not one rectangle: a rectangle painted on tarmac reads as a
       * repair patch, an arrowhead reads as an instruction.
       */
      const chevron = (color, c, right, tan, normal, size) => {
        for (const sgn of [-1, 1]) {
          const dir = right.clone().multiplyScalar(0.72).addScaledVector(tan, sgn * 0.72).normalize();
          const perp = new THREE.Vector3().crossVectors(normal, dir).normalize();
          planeQuad(color,
            c.clone().addScaledVector(dir, -size * 0.30).addScaledVector(tan, sgn * size * 0.42),
            dir.multiplyScalar(size * 0.62), perp.multiplyScalar(size * 0.20), normal);
        }
      };

      for (const br of track.branches) {
        const isRamp = br.kind === 'ramp';
        const accent = isRamp ? '#ffb020' : '#2fe8d8';
        const u = br.enterU;
        const s = track.at(u);
        const yaw = Math.atan2(s.tan.x, s.tan.z) + IN * Math.PI / 2;
        // the branch leaves on whichever side its first waypoint lies
        const p1 = br.curve.getPointAt(0.30);
        const side = Math.sign(p1.clone().sub(s.pos).dot(s.right)) || IN;

        // ---- flanking blocks: a real opening between two buildings, not a hole in a wall ----
        for (const sx of [-1, 1]) {
          const b = lowRise({
            w: ar.range(17, 25), d: ar.range(15, 21), h: ar.range(9.5, 14.5),
            seed: Math.round(u * 977) * 7 + (sx > 0 ? 1 : 2), night,
            wallColor: ar.pick(['#f8dce6', '#d4f0e6', '#fdf2dc', '#e8ddf6']),
            signColor: ar.pick(['#ff2f9d', '#2fe8d8', '#ffd83a']),
            signText: ar.pick(['CLUB', 'MOJITO', 'LIDO', 'CAFE', 'SURF', 'PALMS']),
            style: 'stucco', cache,
          });
          const base = s.pos.clone()
            .addScaledVector(s.right, side * (track.halfWidth + 21))
            .addScaledVector(s.tan, sx * 23);
          b.position.copy(base);
          b.rotation.y = Math.atan2(s.tan.x, s.tan.z) + side * Math.PI / 2 + ar.range(-0.05, 0.05);
          g.add(b);
          // a neon tube up the corner that faces the mouth, plus rungs across it
          const corner = base.clone()
            .addScaledVector(s.tan, -sx * 10.5)
            .addScaledVector(s.right, side * -8.5);
          const tube = sx > 0 ? cyan : pink;
          tube.add(_box(0.45, 12, 0.45), corner.x, 6.0, corner.z, yaw);
          for (let k = 0; k < 4; k++) {
            tube.add(_box(6.5, 0.28, 0.28),
              corner.x + Math.sin(yaw) * 3.2, 2.4 + k * 2.6, corner.z + Math.cos(yaw) * 3.2, yaw);
          }
        }

        // ---- painted chevrons peeling off the racing line into the mouth ----
        // Kept small and kept SHORT of the mouth. A first pass ran them 75 m back at 3.6 m across
        // and the nearest one sat 7 m from the chase camera, where a road marking stops being a
        // marking and becomes an orange slab across the bottom third of the picture.
        for (let k = 0; k < 5; k++) {
          const t = k / 4;
          const f = track.frame(u - 0.019 + t * 0.017);
          const c = f.pos.clone()
            .addScaledVector(f.right, side * lerp(0.14, 0.88, t) * f.half)
            .addScaledVector(f.normal, 0.04);
          chevron(accent, c, f.right.clone().multiplyScalar(side), f.tan, f.normal, 2.3);
        }
        // ...and a run of them straight down the branch throat, ON the branch's own deck
        for (let k = 0; k < 4; k++) {
          const t = br.trim + (k + 0.5) * 0.055;
          if (t > 0.55) break;
          const p = br.curve.getPointAt(t);
          const tn = br.curve.getTangentAt(t).normalize();
          const rt = new THREE.Vector3().crossVectors(tn, new THREE.Vector3(0, 1, 0)).normalize();
          p.y += br.riseAt(t) + 0.05;
          chevron(accent, p, tn, rt, new THREE.Vector3(0, 1, 0), 3.2);
        }

        // ---- a floodlit blade on the kerb, angled at the driver ----
        {
          const bladeC = s.pos.clone()
            .addScaledVector(s.right, side * (track.halfWidth + 4.2))
            .addScaledVector(s.tan, -14);
          const post = new Batch(metalMaterial(cache, '#2c3038', 0.5));
          post.add(new THREE.CylinderGeometry(0.16, 0.20, 5.2, 8), bladeC.x, 2.6, bladeC.z);
          post.into(g);
          const label = isRamp ? 'JUMP' : 'CUT THROUGH';
          const tc = textCanvas(label, { size: 46, weight: 0.20, italic: 0.20, color: '#ffffff', tracking: 0.10 });
          const { c: cc, ctx } = canvas(256, 96);
          ctx.fillStyle = '#10121a'; ctx.fillRect(0, 0, 256, 96);
          ctx.strokeStyle = accent; ctx.lineWidth = 5; ctx.strokeRect(6, 6, 244, 84);
          const sc = Math.min(230 / tc.width, 56 / tc.height);
          ctx.drawImage(tc, (256 - tc.width * sc) / 2, (96 - tc.height * sc) / 2, tc.width * sc, tc.height * sc);
          const tex = toTexture(cc, { srgb: true, wrap: THREE.ClampToEdgeWrapping });
          const bm = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 1.7), new THREE.MeshStandardMaterial({
            map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 2.1,
            roughness: 0.5, side: THREE.DoubleSide,
          }));
          bm.position.copy(bladeC).setY(4.4);
          bm.rotation.y = Math.atan2(s.tan.x, s.tan.z) + Math.PI + side * 0.55;
          bm.userData.noMerge = true;
          g.add(bm);
          // a downward arrow of light under the blade
          amber.add(_box(0.34, 0.34, 2.4), bladeC.x, 5.0, bladeC.z, yaw);
        }
      }
      cyan.into(g); pink.into(g); amber.into(g);
      for (const b of paints.values()) b.into(g);
      out.push(g);
    }

    return out;
  },
};

export function build(opts) { return buildCity(def, opts); }

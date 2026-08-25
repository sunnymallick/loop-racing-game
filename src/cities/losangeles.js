import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildCity, overpass, landmarkTower } from './kit.js';
import { preGamma } from './track.js';
import { drawText } from '../core/font.js';
import { canvas, toTexture, grain, fbmField, normalFromHeight, grayCanvas } from '../core/textures.js';
import { RNG, clamp, lerp, smoothstep, makeNoise2D, fbm2D } from '../core/rng.js';

/**
 * LOS ANGELES — six o'clock in August, sun a hand's width off the Pacific.
 *
 * The identity is built from five things a stranger can name in one second: the hillside letters
 * closing the boulevard, an avenue of sixty-foot Washingtonia palms in silhouette, a four-level
 * freeway interchange stacked over the route, the concrete flood channel with a shortcut running
 * down the middle of it, and downtown stacked in ochre smog off the north kerb.
 *
 * Palette: turquoise zenith over an ochre smog line, gold key, mauve shadow. The complementary
 * turquoise/gold pair is what stops the frame collapsing into one orange wash, and it is what
 * separates this city from Miami's flamingo pastels and Vegas's magenta-on-black.
 */

const UP = new THREE.Vector3(0, 1, 0);

// ---------------------------------------------------------------- generic geometry helpers

/**
 * Sweep cross-section polygons along a list of stations.
 *
 * Polygons are listed CCW in (right, up) metres; stations run in the direction of travel and
 * carry their own right/up basis, so a connector ramp can bank and climb at the same time. Every
 * polygon edge becomes one quad strip with metric UVs — which is how 700 m of flood channel gets
 * a real concrete surface instead of §7's flat-coloured slab.
 */
function sweep(stations, polys, { uvScale = 0.12, caps = false } = {}) {
  const pos = [], uv = [], idx = [];
  const runs = [0];
  for (let i = 1; i < stations.length; i++) runs.push(runs[i - 1] + stations[i].p.distanceTo(stations[i - 1].p));
  const v = new THREE.Vector3();
  // Stations may carry their own (sx, sy) scale on the cross-section. A constant scale changes
  // nothing for the freeway decks and the flood channel; it is what lets ONE polygon be lofted
  // into a car body that tapers at the nose, tucks under at the sills and pinches at the tail.
  const put = (s, x, y) => {
    v.copy(s.p).addScaledVector(s.r, x * (s.sx ?? 1)).addScaledVector(s.u, y * (s.sy ?? 1));
    pos.push(v.x, v.y, v.z);
  };
  for (const poly of polys) {
    for (let e = 0; e < poly.length; e++) {
      const a = poly[e], c = poly[(e + 1) % poly.length];
      const seg = Math.hypot(c[0] - a[0], c[1] - a[1]);
      const base = pos.length / 3;
      for (let i = 0; i < stations.length; i++) {
        put(stations[i], a[0], a[1]);
        put(stations[i], c[0], c[1]);
        uv.push(0, runs[i] * uvScale, seg * uvScale, runs[i] * uvScale);
        if (i < stations.length - 1) {
          const k = base + i * 2;
          idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
        }
      }
    }
    if (caps) {
      for (const [si, keep] of [[0, true], [stations.length - 1, false]]) {
        const s = stations[si];
        const base = pos.length / 3;
        for (const [x, y] of poly) { put(s, x, y); uv.push(x * uvScale, y * uvScale); }
        for (let t = 1; t < poly.length - 1; t++) {
          if (keep) idx.push(base, base + t, base + t + 1);
          else idx.push(base, base + t + 1, base + t);
        }
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/** Stations along a straight run, with an optional height ramp. */
function straightRun(x0, z0, x1, z1, y0, y1, n) {
  const out = [];
  const dir = new THREE.Vector3(x1 - x0, 0, z1 - z0).normalize();
  const r = new THREE.Vector3().crossVectors(dir, UP).normalize();
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    out.push({
      p: new THREE.Vector3(lerp(x0, x1, t), lerp(y0, y1, t), lerp(z0, z1, t)),
      r: r.clone(), u: UP.clone(),
    });
  }
  return out;
}

/** Stations along a horizontal arc that climbs — the shape every freeway connector ramp is. */
function arcRun(cx, cz, rad, a0, a1, y0, y1, n, bank = 0) {
  const out = [];
  const sgn = Math.sign(a1 - a0) || 1;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = lerp(a0, a1, t);
    const p = new THREE.Vector3(
      cx + Math.cos(a) * rad,
      lerp(y0, y1, smoothstep(0, 1, t)),
      cz + Math.sin(a) * rad,
    );
    const dir = new THREE.Vector3(-Math.sin(a), 0, Math.cos(a)).multiplyScalar(sgn);
    const r = new THREE.Vector3().crossVectors(dir, UP).normalize();
    out.push({
      p,
      r: r.applyAxisAngle(dir, bank),
      u: UP.clone().applyAxisAngle(dir, bank),
    });
  }
  return out;
}

// ---------------------------------------------------------------- draw-call plumbing

/** Reduce a geometry to position/normal/uv so anything can be merged with anything. */
function stripGeo(src) {
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

/**
 * WORLD-SPACE MERGE COLLECTOR.
 *
 * Every landmark below is still placed exactly the way it always was — build a mesh, set its
 * position and rotation — but it goes into this collector instead of straight into the scene, and
 * comes back out as ONE buffer per (material, shadow flags, chunk cell). The channel's 417-piece
 * chain-link fence, the 78 K-rail units and the 300-palm avenue are each a handful of buffers by
 * the time the renderer sees them.
 *
 * Two things this deliberately does NOT do:
 *
 *  - It does not merge the whole city into one buffer. Frustum culling can only throw away things
 *    that are separate objects, so the default cell is 300 m — roughly half the boulevard — and a
 *    self-contained cluster that is always wholly on screen or wholly off it (downtown, 760 m out)
 *    asks for `chunk: 0` and becomes one object.
 *  - It does not touch anything flagged `userData.noMerge`. Those keep their world pose and pass
 *    through untouched, which is how the double-sided freeway guide sign survives.
 *
 * `remap` swaps a mesh's material as it is collected and bakes the material colour it replaces
 * into a vertex-colour attribute. That is what lets the palm fronds and the coconuts — two flat
 * colours, no maps, identical shadow flags — share one material and one draw call. Vertex colours
 * are consumed in the renderer's working (linear) space, which is precisely what `Color.r/g/b`
 * already holds after sRGB decode, so the tint is identical to the material colour it stands in
 * for rather than merely close.
 */
class Merger {
  constructor(chunk = 300) {
    this.chunk = chunk;
    this.items = [];
    this.buckets = new Map();
  }

  /** Collect a mesh or a whole group. Transforms are read at flush(), so callers may set them after. */
  take(obj, opts = null) { this.items.push({ obj, opts }); return obj; }

  _add(geo, matrix, material, cast, receive, chunk, color) {
    const g = stripGeo(geo);
    g.applyMatrix4(matrix);
    if (color) {
      const n = g.attributes.position.count;
      const a = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { a[i * 3] = color.r; a[i * 3 + 1] = color.g; a[i * 3 + 2] = color.b; }
      g.setAttribute('color', new THREE.BufferAttribute(a, 3));
    }
    const cx = chunk > 0 ? Math.floor(matrix.elements[12] / chunk) : 0;
    const cz = chunk > 0 ? Math.floor(matrix.elements[14] / chunk) : 0;
    const key = `${material.id}|${cast ? 1 : 0}${receive ? 1 : 0}|${cx}|${cz}`;
    let b = this.buckets.get(key);
    if (!b) { b = { material, cast, receive, geos: [] }; this.buckets.set(key, b); }
    b.geos.push(g);
  }

  /** Emit the finished buffers into `out`. Call once, at the end of landmarks(). */
  flush(out) {
    const keep = [];
    for (const it of this.items) {
      it.obj.updateMatrixWorld(true);
      const chunk = it.opts?.chunk ?? this.chunk;
      const remap = it.opts?.remap || null;
      it.obj.traverse((o) => {
        if (!o.isMesh || !o.material || Array.isArray(o.material)) return;
        if (o.userData.noMerge) { keep.push(o); return; }
        const sub = remap ? remap(o) : null;
        this._add(o.geometry, o.matrixWorld, sub?.material || o.material,
          o.castShadow, o.receiveShadow, chunk, sub?.color || null);
      });
    }
    for (const o of keep) {
      o.matrix.copy(o.matrixWorld);
      o.matrix.decompose(o.position, o.quaternion, o.scale);
      out.push(o);
    }
    for (const b of this.buckets.values()) {
      const geo = b.geos.length === 1 ? b.geos[0] : mergeGeometries(b.geos, false);
      if (!geo) continue;
      const m = new THREE.Mesh(geo, b.material);
      m.castShadow = b.cast; m.receiveShadow = b.receive;
      m.userData.noMerge = true;                 // already merged — buildCity must not redo it
      out.push(m);
    }
    this.items.length = 0;
    this.buckets.clear();
    return out;
  }
}

// ---------------------------------------------------------------- procedural materials

/**
 * Sun-bleached structural concrete: form-board lift lines, rust bleed from the tie holes, patch
 * repairs, aggregate grain. One 384px sheet drives colour, roughness and normal.
 */
function concreteMaterial(tint, seed) {
  const size = 384;
  const { c, ctx } = canvas(size, size);
  const rng = new RNG(seed);
  const f = fbmField(size, size, { seed, octaves: 5, scale: 7, warp: 0.45 });
  const g = fbmField(size, size, { seed: seed + 9, octaves: 3, scale: 30 });
  const col = new THREE.Color(preGamma(tint));
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const l = clamp(0.86 + (f[i] - 0.5) * 0.34 + (g[i] - 0.5) * 0.20, 0.4, 1.3);
    img.data[i * 4] = clamp(col.r * 255 * l, 0, 255);
    img.data[i * 4 + 1] = clamp(col.g * 255 * l, 0, 255);
    img.data[i * 4 + 2] = clamp(col.b * 255 * l, 0, 255);
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  for (let y = 12; y < size; y += 48) {                       // lift lines between form pours
    ctx.fillStyle = `rgba(58,50,44,${rng.range(0.10, 0.20)})`;
    ctx.fillRect(0, y, size, rng.range(1, 2.2));
    ctx.fillStyle = 'rgba(255,248,232,0.09)';
    ctx.fillRect(0, y + 2, size, 1.1);
  }
  for (let x = 18; x < size; x += 96) {                       // panel joints
    ctx.fillStyle = `rgba(60,52,46,${rng.range(0.06, 0.13)})`;
    ctx.fillRect(x, 0, rng.range(1, 2), size);
  }
  for (let k = 0; k < 22; k++) {                              // tie holes + rust streaks
    const x = rng.range(0, size), y = rng.range(0, size);
    ctx.fillStyle = `rgba(${rng.int(110, 150)},${rng.int(64, 92)},${rng.int(38, 56)},${rng.range(0.20, 0.5)})`;
    ctx.beginPath(); ctx.arc(x, y, rng.range(1.1, 2.4), 0, 7); ctx.fill();
    const gr = ctx.createLinearGradient(x, y, x, y + 70);
    gr.addColorStop(0, 'rgba(126,74,44,0.30)');
    gr.addColorStop(1, 'rgba(126,74,44,0)');
    ctx.fillStyle = gr; ctx.fillRect(x - 2, y, 4, 70);
  }
  for (let k = 0; k < 9; k++) {                               // patch repairs
    ctx.fillStyle = `rgba(${rng.int(150, 195)},${rng.int(146, 188)},${rng.int(136, 176)},${rng.range(0.10, 0.24)})`;
    ctx.fillRect(rng.range(0, size), rng.range(0, size), rng.range(24, 110), rng.range(16, 70));
  }
  grain(ctx, size, size, 7, rng);
  const rough = new Float32Array(size * size);
  for (let i = 0; i < rough.length; i++) rough[i] = clamp(0.90 + (g[i] - 0.5) * 0.16, 0.5, 1);
  return new THREE.MeshStandardMaterial({
    map: toTexture(c, { srgb: true }),
    roughnessMap: toTexture(grayCanvas(rough, size, size), { srgb: false }),
    normalMap: toTexture(normalFromHeight(g, size, size, 1.4), { srgb: false }),
    roughness: 1, metalness: 0, envMapIntensity: 0.7,
  });
}

/** Weathered galvanised steel for guard rail, sign gantries and fence posts. */
function steelMaterial(tint, seed = 77) {
  const size = 128;
  const { c, ctx } = canvas(size, size);
  const rng = new RNG(seed);
  ctx.fillStyle = preGamma(tint); ctx.fillRect(0, 0, size, size);
  for (let k = 0; k < 220; k++) {
    ctx.fillStyle = `rgba(${rng.int(90, 155)},${rng.int(60, 105)},${rng.int(40, 70)},${rng.range(0.04, 0.28)})`;
    ctx.fillRect(rng.range(0, size), rng.range(0, size), rng.range(1, 9), rng.range(1, 5));
  }
  grain(ctx, size, size, 9, rng);
  return new THREE.MeshStandardMaterial({
    map: toTexture(c, { srgb: true, repeat: [3, 3] }), roughness: 0.6, metalness: 0.5,
  });
}

/**
 * Atlas of graffiti pieces — one texture, one material, so a wall of tags is one draw call.
 *
 * §7 VISIBLE TEXTURE TILING REPEAT (cap 65) fired here: nine pieces spread over 700 m of channel
 * wall put "the identical green-outline/red-fill glyph three times across one screen width". Three
 * things had to change together, because none of them is enough alone:
 *   - 24 cells instead of 9, so the draw pool is nearly three times deeper;
 *   - every cell is a different WORD, and its two paint colours are drawn independently, so no two
 *     cells share a colour pair;
 *   - and each piece placed on the wall carries a per-instance tint baked into vertex colour
 *     (see the tagMat remap below), which is free — the Merger already supports it — and makes a
 *     repeated cell read as a different can of paint rather than a copy.
 * The atlas is 6 x 4, mapped through `cols`/`rows` rather than a hard-coded 3.
 */
const TAG_COLS = 8, TAG_ROWS = 6;
function graffitiAtlas(seed) {
  const cell = 256, half = 128;
  const N = TAG_COLS * TAG_ROWS;
  const { c, ctx } = canvas(cell * TAG_COLS, half * TAG_ROWS);
  const rng = new RNG(seed);
  const hues = ['#ff2f6d', '#2fd8e0', '#ffd23a', '#8f5fff', '#ff7a1e', '#f2f0e8', '#38e08a',
    '#ff4d2e', '#66e0ff', '#c8ff3a', '#ff8fd0'];
  const words = ['NITRO', 'ESTE', 'DTLA', 'CIRCUIT', '213', 'SUNSET', 'CREW', 'RIOS', 'VATO',
    'ECHO', 'BOYLE', 'LOKE', 'SUR', 'FIGGY', 'ARTE', 'CHAVEZ', 'WHITTIER', 'MALO',
    'PICO', 'SOTO', 'CUDA', 'BRAVO', 'ONDA', 'SEXTO', 'LOS', 'NORTE', 'RAMPART', 'ELAY',
    'SIX', 'ZOOT', 'ADIOS', 'FLACO',
    // …and sixteen more, because 32 cells over 112 placed pieces is three and a half passes of
    // the deck and the eye only has to catch one pair. See the dealer below.
    'HOLLYWOOD', 'VERNON', 'ALVARADO', 'SLAUSON', 'CYPRESS', 'AVE43', 'HAZARD', 'TEMPLE',
    'MARAVILLA', 'GLASSELL', 'CRENSHAW', 'LINCOLN', 'OLYMPIC', 'SANTEE', 'FLORES', 'DOGTOWN'];
  for (let i = 0; i < N; i++) {
    const ox = (i % TAG_COLS) * cell, oy = Math.floor(i / TAG_COLS) * half;
    ctx.save();
    ctx.beginPath(); ctx.rect(ox, oy, cell, half); ctx.clip();
    ctx.translate(ox + cell / 2, oy + half / 2);
    ctx.rotate(rng.range(-0.13, 0.13));
    const a = hues[rng.int(0, hues.length - 1)];
    let b = hues[rng.int(0, hues.length - 1)];
    if (b === a) b = hues[(hues.indexOf(a) + 3) % hues.length];   // never a monochrome piece
    const size = rng.range(50, 64) * clamp(7 / words[i].length, 0.62, 1.16);
    drawText(ctx, words[i], { x: 5, y: 24, size, weight: 0.30, italic: 0.34, align: 'center', color: '#1a1114', tracking: 0.02 });
    drawText(ctx, words[i], { x: 0, y: 20, size, weight: 0.28, italic: 0.34, align: 'center', color: a, tracking: 0.02 });
    drawText(ctx, words[i], { x: -3, y: 16, size: size * 0.74, weight: 0.12, italic: 0.34, align: 'center', color: b, tracking: 0.02 });
    for (let k = 0; k < 130; k++) {                            // overspray
      ctx.fillStyle = `rgba(${rng.int(180, 255)},${rng.int(110, 220)},${rng.int(110, 220)},${rng.range(0.04, 0.20)})`;
      ctx.beginPath(); ctx.arc(rng.range(-100, 100), rng.range(-46, 46), rng.range(0.6, 2.4), 0, 7); ctx.fill();
    }
    // Bite the cell's own border back out. Round 2 clipped each piece to its atlas rectangle and
    // the quads it lands on are rectangles too, so every tag on the channel wall was outlined by a
    // hard 30 x 15 m box of overspray — "a flat decal atlas with hard rectangular edges".
    ctx.globalCompositeOperation = 'destination-out';
    for (const [gx0, gy0, gx1, gy1] of [
      [-cell / 2, 0, cell / 2, 0], [0, -half / 2, 0, half / 2],
    ]) {
      const gg = ctx.createLinearGradient(gx0, gy0, gx1, gy1);
      gg.addColorStop(0, 'rgba(0,0,0,1)');
      gg.addColorStop(0.14, 'rgba(0,0,0,0)');
      gg.addColorStop(0.86, 'rgba(0,0,0,0)');
      gg.addColorStop(1, 'rgba(0,0,0,1)');
      ctx.fillStyle = gg;
      ctx.fillRect(-cell / 2, -half / 2, cell, half);
    }
    for (let k = 0; k < 90; k++) {                             // and tear the remaining outline
      const a = rng.range(0, 6.3);
      const rr = rng.range(6, 26);
      const gg = ctx.createRadialGradient(Math.cos(a) * cell * 0.42, Math.sin(a) * half * 0.42, 0,
        Math.cos(a) * cell * 0.42, Math.sin(a) * half * 0.42, rr);
      gg.addColorStop(0, `rgba(0,0,0,${rng.range(0.4, 0.95)})`);
      gg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = gg;
      ctx.fillRect(-cell / 2, -half / 2, cell, half);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore();
  }
  return toTexture(c, { srgb: true, wrap: THREE.ClampToEdgeWrapping });
}

/** The tint pool a placed tag is multiplied by. LA's own accents, pulled toward white so the
 *  atlas colour still leads — this is a different can of paint, not a different palette. */
function tagTint(r) {
  const base = new THREE.Color(r.pick(['#ff2f6d', '#2fd8e0', '#ffd23a', '#8f5fff', '#ff7a1e',
    '#38e08a', '#ff4d2e', '#c8ff3a', '#ffffff', '#c9d4e0', '#ffd9b0']));
  // Pulled only part-way to white: at 0.85 the multiply was invisible and two copies of one cell
  // still read as the same piece, which is the tell §7 caps at 65. The values are LINEAR (the
  // Merger consumes vertex colour in the renderer's working space), so this is a real repaint.
  const c = base.lerp(new THREE.Color(1, 1, 1), r.range(0.05, 0.62));
  // never above 1: bloom threshold is ~0.6-0.75 and spray paint does not glow
  return c.multiplyScalar(r.range(0.58, 1.0));              // some sun-bleached, some fresh
}

/** Soft irregular blot — water staining on the channel floor and batter. */
function stainTexture(seed) {
  const size = 128;
  const { c, ctx } = canvas(size, size);
  const rng = new RNG(seed);
  ctx.clearRect(0, 0, size, size);
  for (let k = 0; k < 22; k++) {
    const x = rng.range(20, size - 20), y = rng.range(16, size - 16), r = rng.range(10, 42);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(255,255,255,${rng.range(0.25, 0.7)})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
  }
  return toTexture(c, { srgb: false, wrap: THREE.ClampToEdgeWrapping });
}

/** Diamond chain-link — alpha-tested, so it mips down to a grey haze at distance. */
function chainlinkTexture() {
  const size = 128;
  const { c, ctx } = canvas(size, size);
  ctx.clearRect(0, 0, size, size);
  ctx.strokeStyle = 'rgba(206,208,204,0.95)';
  ctx.lineWidth = 3.4;
  for (let i = -size; i < size * 2; i += 22) {
    ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i + size, size); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(i + size, 0); ctx.lineTo(i, size); ctx.stroke();
  }
  return toTexture(c, { srgb: true });
}

/** Window grid for the downtown massing: glass bands, spandrels, soot. */
function towerSkin(tint, glass, seed) {
  const w = 256, h = 256;
  const { c, ctx } = canvas(w, h);
  const rng = new RNG(seed);
  ctx.fillStyle = preGamma(tint); ctx.fillRect(0, 0, w, h);
  const cols = 8, rows = 8;
  for (let r = 0; r < rows; r++) {
    for (let ci = 0; ci < cols; ci++) {
      const x = ci * (w / cols), y = r * (h / rows);
      const g = new THREE.Color(preGamma(glass)).multiplyScalar(0.72 + rng.range(0, 0.5));
      ctx.fillStyle = `#${g.getHexString()}`;
      ctx.fillRect(x + 3, y + 5, w / cols - 7, h / rows - 13);
      ctx.fillStyle = 'rgba(255,236,206,0.18)';
      ctx.fillRect(x + 3, y + 5, w / cols - 7, 3);
      ctx.fillStyle = `rgba(${rng.int(40, 70)},${rng.int(36, 62)},${rng.int(34, 56)},0.35)`;
      ctx.fillRect(x, y + h / rows - 8, w / cols, 3);
    }
  }
  for (let k = 0; k < 80; k++) {
    ctx.fillStyle = `rgba(${rng.int(20, 60)},${rng.int(20, 55)},${rng.int(20, 50)},${rng.range(0.03, 0.11)})`;
    ctx.fillRect(rng.range(0, w), rng.range(0, h), rng.range(8, 60), rng.range(4, 30));
  }
  grain(ctx, w, h, 5, rng);
  return toTexture(c, { srgb: true });
}

// ================================================================ THE HOLLYWOOD HILLSIDE
//
// The largest surface in most LA frames and the city's primary landmark, so it gets built here
// rather than taken from the shared kit (`landmarkSet: null`). Round 2's version was the kit's:
// a 64x26 quad plane — 34 metres per quad, so no modelling at all — carrying one low-frequency
// fbm sheet tiled 7x4 across two kilometres, with the letters painted onto it as an alpha-tested
// decal. Read at 3x it was a smooth peach gradient with a blurry word floating on it.
//
// Four things have to be true for a hill 660 m away to read as LAND:
//
//   1. The relief has to be GEOMETRY. At that range a screen pixel is ~0.8 m of hillside, so any
//      texture finer than a metre mips to flat grey no matter how good it is. What survives is
//      light and shade on real slopes, which means spurs and gullies at 10-40 m — hence a 300x130
//      grid (8 m vertices) displaced by a ridged multifractal that is stretched DOWN the slope,
//      which is exactly how a chaparral hillside erodes.
//   2. The colour has to be MACRO and non-repeating: dry bleached grass on the sun-facing spurs,
//      olive brush pooling in the gullies, umber in the shadowed folds. That is baked per vertex,
//      so it cannot tile; the tiled sheet on top is deliberately neutral and only carries grain,
//      roughness and normal.
//   3. It needs objects on it at a legible size — 3 to 10 m scrub clumps (4-12 px), rock outcrops,
//      a pale fire-road switchback cut across the face (9 m wide, ~11 px) and the transmission
//      masts on the crest. Those are the scale references that turn a shape into terrain.
//   4. The letters have to be SOLID, FREE-STANDING BOARDS on scaffolding, not a decal.

const lin2srgb = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

/**
 * HALF-HAZE, for the hero hill only.
 *
 * Measured, on the real build: with the city fog at near 175 / far 2100 and the hillside letters
 * 900 m from the chase camera, the surface's own albedo contributes about ONE EIGHTH of the
 * rendered pixel — blanking the hill's albedo map entirely moved red from 137 to 121. Everything
 * else is smog. That is why round 2's hill read as a featureless gradient and why neither a
 * tenfold albedo change nor a full sun-occlusion bake moved it: there was almost no surface term
 * left to modulate.
 *
 * The city's aerial perspective is worth keeping exactly as it is — it is doing most of the work
 * of separating four depth bands — so rather than thin the fog for everything, the hero cluster
 * gets its own fog term at `k` of the scene's. Distance still drives it, so the hill still sits
 * behind the mid-ground and still dissolves toward the horizon; it just does so at a rate that
 * leaves the landmark legible. One string patch, no uniforms, no extra passes.
 */
function halfHaze(mat, k = 0.48) {
  const src = '#include <fog_fragment>';
  mat.onBeforeCompile = (shader) => {
    if (!shader.fragmentShader.includes(src)) return;
    shader.fragmentShader = shader.fragmentShader.replace(src, [
      '#ifdef USE_FOG',
      `  float fogFactor = smoothstep( fogNear, fogFar, vFogDepth ) * ${k.toFixed(3)};`,
      '  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );',
      '#endif',
    ].join('\n'));
  };
  mat.customProgramCacheKey = () => `la-halfhaze-${k}`;
  return mat;
}

// Micro relief for every hillside in the city, generated once. Plain float arrays, so they
// survive a city swap without holding a GPU resource.
let _grainFields = null;
function hillGrainFields() {
  if (!_grainFields) {
    _grainFields = [
      fbmField(512, 512, { seed: 613, octaves: 4, scale: 40, warp: 0.5 }),
      fbmField(512, 512, { seed: 907, octaves: 3, scale: 130 }),
    ];
  }
  return _grainFields;
}

/**
 * The hillside material.
 *
 * `map` is left null here and filled in by `heroRidge().bake()` with ONE unique 2048x1024 sheet
 * covering the whole 2.6 km ridge — 1.3 m per texel against a screen pixel that is 0.8 m of
 * hillside at this range, so it is effectively per-pixel and, being unique, it can carry the
 * gullies, the sun occlusion, the scrub, the fire roads and the sign's own cast shadow without
 * a repeat existing anywhere to be caught by §7. Only the micro relief tiles, and it tiles on the
 * normal and roughness channels where a repeat has no silhouette to give it away.
 */
/**
 * The micro relief is shared by all seven hillsides — only the unique albedo sheet differs — so
 * it is built once per CITY (not once per module: the textures die with the city group when
 * disposeObject walks it, and a module-level cache would hand the next build dead handles).
 */
function hillMicroMaps() {
  const size = 512;
  const f = fbmField(size, size, { seed: 1701, octaves: 5, scale: 26, warp: 0.55 });
  const rough = new Float32Array(size * size);
  for (let i = 0; i < rough.length; i++) rough[i] = clamp(0.94 + (f[i] - 0.5) * 0.14, 0.6, 1);
  return {
    roughnessMap: toTexture(grayCanvas(rough, size, size), { srgb: false, repeat: [22, 9] }),
    normalMap: toTexture(normalFromHeight(f, size, size, 2.1), { srgb: false, repeat: [22, 9] }),
  };
}

function hillMaterial(micro) {
  return new THREE.MeshStandardMaterial({
    roughnessMap: micro.roughnessMap, normalMap: micro.normalMap,
    normalScale: new THREE.Vector2(1.35, 1.35),
    roughness: 1, metalness: 0, envMapIntensity: 0.30,
  });
}

/**
 * The hero ridge: a displaced heightfield with its chaparral palette baked into vertex colours.
 *
 * Returns the mesh plus `heightAt(x, z)` in the ridge's own frame, which the sign, the scrub, the
 * fire road, the outcrops and the masts all stand on.
 */
function heroRidge({
  len = 2600, depth = 1000, height = 268, seed = 3, nx = 300, nz = 130,
  mat, sun, bakeW = 2048, bakeH = 1024,
}) {
  const n1 = makeNoise2D(seed);
  const n2 = makeNoise2D(seed + 17);
  const rng = new RNG(seed * 13 + 5);

  // Massifs carry the bulk; broader secondary swells ride on them so the crest breaks into
  // separate tops. Deliberately NO sharp exponential summits: the Santa Monica mountains behind
  // Hollywood are rounded chaparral knolls, and a stack of narrow spikes reads as the Alps.
  const massif = [], swell = [];
  for (let i = 0; i < 5; i++) massif.push({ c: rng.range(0.06, 0.94), w: rng.range(0.13, 0.28), a: rng.range(0.55, 1.0) });
  for (let i = 0; i < 9; i++) swell.push({ c: rng.range(0.05, 0.95), w: rng.range(0.045, 0.10), a: rng.range(0.08, 0.24) });

  /** Where the crest line sits across the depth of the ridge — it wanders, so the hill is not a wall. */
  const crestOf = (u) => 0.55 + fbm2D(n2, u * 2.6, 7.3, 3) * 0.30;
  const massOf = (u) => {
    let m = 0.09;
    for (const p of massif) { const d = (u - p.c) / p.w; m += p.a * Math.exp(-d * d); }
    let s = 0;
    for (const p of swell) { const d = (u - p.c) / p.w; s += p.a * Math.exp(-d * d); }
    return clamp(Math.min(m, 1.02) + s, 0, 1.3);
  };
  // fbm2D lands in about ±0.30 either side of zero at the tenth and ninetieth percentiles, so
  // everything below divides by 0.30 first and works in normalised units. Round 2's version of
  // this file did not, which is why its "gully" term fired on under 5% of the surface and the
  // whole hill came out one flat tan.
  const NS = 1 / 0.30;
  /**
   * u runs along the ridge, v from the toe nearest the camera (0) to the back slope (1).
   *
   * Relief is CARVED, not piled on. Classic ridged noise (`1 - |fbm|`) puts a sharp Λ crease
   * along every zero contour and turns a hillside into a row of spikes on the skyline; ADDING
   * `|fbm|` instead puts the sharp V in the VALLEY and leaves the interfluve rounded, which is
   * how running water actually shapes chaparral. Both octaves are sampled five times wider along
   * u than along v, which stretches every gully down the fall line.
   */
  const shape = (u, v) => {
    const ends = smoothstep(0, 0.15, u) * smoothstep(0, 0.15, 1 - u);
    const cv = crestOf(u);
    const front = smoothstep(-0.03, cv, v);
    const back = 1 - smoothstep(cv, cv + 0.62, v) * 0.40;
    const mass = massOf(u) * ends * Math.pow(front, 1.30) * back;
    const rn = Math.min(1, Math.abs(fbm2D(n1, u * 16, v * 3.2, 4) * NS));
    const rn2 = Math.min(1, Math.abs(fbm2D(n1, u * 44 + 11, v * 9 + 3, 3) * NS));
    const fine = fbm2D(n2, u * 160, v * 46, 3) * NS;
    // ...and damped where the ground is already near the top of its massif. Gullies are what
    // model the FACE; run them over the crest at full strength and the skyline turns into a
    // sawtooth, which is the one thing a chaparral ridge never looks like.
    const crown = 1 - smoothstep(0.60, 1.0, mass) * 0.66;
    const relief = (-0.21 + rn * 0.36 + rn2 * 0.10 + fine * 0.035) * crown;
    // rn near 0 is the floor of a gully; rn near 1 is the crown of the interfluve between two.
    return { h: clamp(mass * (1 + relief), 0, 2), mass, rn, rn2, ends, cv, v };
  };
  const heightAt = (x, z) => {
    const u = clamp(x / len + 0.5, 0, 1);
    const v = clamp(0.5 - z / depth, 0, 1);
    return height * shape(u, v).h;
  };

  const geo = new THREE.PlaneGeometry(len, depth, nx, nz);
  const p = geo.attributes.position;
  const uvA = geo.attributes.uv;
  const col = new Float32Array((nx + 1) * (nz + 1) * 3);
  // The chaparral palette, written as LINEAR albedo — these are vertex colours, which the shader
  // consumes in working space, and they multiply a grain sheet whose own mean is 0.57 linear.
  // Round 2's hill sat at about 0.137 albedo and rendered as a pale peach that the white letters
  // could not separate from; half of that is a mid ochre-brown that they can.
  // Bleached grass on the sun-facing spurs, olive brush pooling in the gullies, umber in the deep
  // folds, pale decomposed granite on the eroded upper crests.
  // Red is the channel that has already rolled off the top of the tonemap — the sun's own colour
  // is (1.00, 0.62, 0.29) linear and the haze the hill dissolves into is ochre — so the palette
  // is pulled DOWN in red and held up in green. Chaparral in August really is olive-drab, and
  // olive is also the only direction in which this hill can separate from the smog behind it.
  // ...and the SPREAD matters more than the mean. Fog is a lerp toward ochre and the hill sits
  // 34-45% of the way into it, so a 3:1 albedo ratio arrives at the eye as barely 1.5:1. Getting
  // real patchiness on screen at this range needs nearly a decade of albedo between the bleached
  // noses and the dense brush, which is also what a burnt-over August hillside actually has.
  const cGrass = new THREE.Color().setRGB(0.300, 0.245, 0.135);
  const cBrush = new THREE.Color().setRGB(0.040, 0.058, 0.026);
  const cUmber = new THREE.Color().setRGB(0.030, 0.027, 0.021);
  const cRock = new THREE.Color().setRGB(0.420, 0.352, 0.238);
  const tmp = new THREE.Color();
  const brush = [];                          // (u, v, density, shadow) for the scrub scatter
  const N = (nx + 1) * (nz + 1);
  const hArr = new Float32Array(N);
  const dArr = new Float32Array(N);          // brush density
  const gArr = new Float32Array(N);          // gully-ness
  const kArr = new Float32Array(N);          // crown-ness
  const pArr = new Float32Array(N);          // large-scale patch
  const qArr = new Float32Array(N);          // fine shading noise
  // ---- pass 1: the surface, plus everything the colour pass needs
  for (let j = 0; j <= nz; j++) {
    for (let i = 0; i <= nx; i++) {
      const k = j * (nx + 1) + i;
      const u = i / nx, v = 1 - j / nz;
      const s = shape(u, v);
      const y = height * s.h;
      p.setZ(k, y);
      hArr[k] = y;
      gArr[k] = smoothstep(0.42, 0.06, s.rn);                   // down in a gully
      kArr[k] = smoothstep(0.38, 0.88, s.rn) * 0.45 + smoothstep(0.55, 1.02, s.h) * 0.24;
      pArr[k] = clamp(0.5 + fbm2D(n2, u * 9 + 40, v * 4 + 5, 4) * NS * 0.55, 0, 1);
      qArr[k] = 0.45 - s.rn2;
      dArr[k] = clamp(gArr[k] * 0.58 + pArr[k] * 0.62 - smoothstep(0.38, 0.88, s.rn) * 0.26, 0, 1);
      uvA.setXY(k, u, 1 - v);                  // one unique sheet across the whole ridge
    }
  }

  /**
   * ---- pass 2: BAKED SUN OCCLUSION, and it is the single thing that makes this hill read.
   *
   * The key light is 111 degrees round from the boulevard's axis — behind the camera's shoulder —
   * so from the road every face the player can see is a LIT face and the terrain normal alone
   * gives almost no tonal separation. What a chaparral hillside actually looks like at six in the
   * evening is half of it in shadow: the sun is sixteen degrees up, so every gully, every spur and
   * every knoll throws a shadow three and a half times its own height across the ground behind it.
   *
   * The scene's real shadow map is a 380 m box that follows the player, so at 780 m none of that
   * exists. This marches the finished height grid toward the sun instead — 26 steps of 16 m, a
   * horizon search out to 416 m — and folds the result into the vertex colour, cooled toward the
   * city's violet shadow tint on the way. A million bilinear grid lookups, once, at load.
   */
  const hAt = (x, z) => {
    const fi = clamp((x / len + 0.5) * nx, 0, nx - 1e-3);
    const fj = clamp((z / depth + 0.5) * nz, 0, nz - 1e-3);
    const i0 = fi | 0, j0 = fj | 0, tx = fi - i0, tz = fj - j0;
    const r0 = j0 * (nx + 1) + i0, r1 = r0 + nx + 1;
    return lerp(lerp(hArr[r0], hArr[r0 + 1], tx), lerp(hArr[r1], hArr[r1 + 1], tx), tz);
  };
  const sl = Math.hypot(sun.x, sun.z) || 1;
  const sux = sun.x / sl, suz = sun.z / sl;
  const tanEl = sun.y / sl;                                     // sun rise per horizontal metre
  const STEP = 16, MARCH = 26;
  const cShadow = new THREE.Color().setRGB(0.062, 0.050, 0.086);   // violet, never black
  for (let j = 0; j <= nz; j++) {
    for (let i = 0; i <= nx; i++) {
      const k = j * (nx + 1) + i;
      const x = (i / nx - 0.5) * len, z = (j / nz - 0.5) * depth;
      const h0 = hArr[k];
      let horizon = -9;
      for (let t = 1; t <= MARCH; t++) {
        const d = t * STEP;
        const g = (hAt(x + sux * d, z + suz * d) - h0) / d;
        if (g > horizon) horizon = g;
      }
      // ...and the ASPECT term, which is what actually models the face. The ridge runs across the
      // camera's axis and the sun runs along it, so the gullies are raked broadside: the wall on
      // one side of every crease is square to the light and the wall opposite it sees none of it.
      // Doubling that contrast into the albedo — a stylised terrain bake, on top of the real key
      // light rather than instead of it — is the difference between a hill and a brown shape.
      const ix = i === 0 ? 1 : i === nx ? nx - 1 : i;
      const jy = j === 0 ? 1 : j === nz ? nz - 1 : j;
      const kk = jy * (nx + 1) + ix;
      const dhx = (hArr[kk + 1] - hArr[kk - 1]) / (2 * (len / nx));
      const dhz = (hArr[kk + nx + 1] - hArr[kk - nx - 1]) / (2 * (depth / nz));
      const nl = 1 / Math.sqrt(dhx * dhx + dhz * dhz + 1);
      const ndl = (-dhx * sun.x + sun.y - dhz * sun.z) * nl;
      const aspect = clamp(0.38 + ndl * 1.00, 0.30, 1.28);
      const shadow = smoothstep(tanEl - 0.05, tanEl + 0.07, horizon);
      // Macro colour, all of it non-repeating: brush pools in the hollows between the noses,
      // the noses themselves burn off to bleached grass and exposed decomposed granite, and the
      // deepest creases go umber. At 780 m a screen pixel is most of a metre of hillside, so
      // nothing finer than about eight metres survives — which is why this is the layer that has
      // to do the work rather than any texture.
      tmp.copy(cGrass).lerp(cBrush, dArr[k]);
      tmp.lerp(cUmber, gArr[k] * 0.34);
      tmp.lerp(cRock, kArr[k]);
      const shade = (0.84 + (pArr[k] - 0.5) * 0.30 + qArr[k] * 0.34) * aspect;
      tmp.multiplyScalar(shade);
      const dark = clamp(shadow * 0.70 + (1 - clamp(aspect, 0, 1)) * 0.42, 0, 0.72);
      tmp.lerp(cShadow, dark);
      col[k * 3] = tmp.r; col[k * 3 + 1] = tmp.g; col[k * 3 + 2] = tmp.b;
      if (dArr[k] > 0.44 && hArr[k] > 12) brush.push(i / nx, 1 - j / nz, dArr[k], dark);
    }
  }
  geo.rotateX(-Math.PI / 2);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.userData.noMerge = true;

  /**
   * Compose the unique albedo sheet. The per-vertex palette above is the macro layer, bilinearly
   * resampled up to 2048x1024; a pair of tiled fbm octaves gives it grain at 5-16 m; then `draw`
   * gets the finished sRGB canvas and a metres-to-texel transform, which is how the fire roads and
   * the sign's cast shadow are painted directly onto the terrain — exactly conformal, no decal
   * geometry to sink into a gully, no z-fighting, no extra draw call.
   */
  const bake = (draw, W = bakeW, H = bakeH) => {
    const { c, ctx } = canvas(W, H);
    // 40 and 130 cycles over 512 px: at four tiles across the ridge that is 16 m and 5 m of
    // detail, well under the scale at which a repeat could ever be spotted. Shared by every
    // hillside in the city — seven bakes, one pair of fields.
    const [g1, g2] = hillGrainFields();
    const img = ctx.createImageData(W, H);
    for (let y = 0; y < H; y++) {
      const fj = (y / (H - 1)) * nz;
      const j0 = Math.min(nz - 1, fj | 0), tz = fj - j0;
      const gy = (y & 511) * 512;
      for (let x = 0; x < W; x++) {
        const fi = (x / (W - 1)) * nx;
        const i0 = Math.min(nx - 1, fi | 0), tx = fi - i0;
        const a = (j0 * (nx + 1) + i0) * 3, b2 = a + 3;
        const cq = ((j0 + 1) * (nx + 1) + i0) * 3, d2 = cq + 3;
        const gi = gy + (x & 511);
        const gr = clamp(0.72 + (g1[gi] - 0.5) * 0.66 + (g2[gi] - 0.5) * 0.44, 0.20, 1.55);
        const o = (y * W + x) * 4;
        for (let ch = 0; ch < 3; ch++) {
          const v0 = lerp(col[a + ch], col[b2 + ch], tx);
          const v1 = lerp(col[cq + ch], col[d2 + ch], tx);
          img.data[o + ch] = clamp(lin2srgb(lerp(v0, v1, tz) * gr) * 255, 0, 255);
        }
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    if (draw) {
      // (x, z) in ridge metres → texel. z runs the opposite way to v, and the canvas is flipped
      // again on upload, so the two cancel and z maps straight through.
      draw(ctx, W, H, {
        x: (x) => (x / len + 0.5) * W,
        z: (z) => (z / depth + 0.5) * H,
        sx: W / len, sz: H / depth,
      });
    }
    mat.map = toTexture(c, { srgb: true, wrap: THREE.ClampToEdgeWrapping });
    mat.needsUpdate = true;
    return mat.map;
  };

  return { mesh, heightAt, len, depth, height, brush, rng, bake };
}

/**
 * Scrub clumps, as ONE buffer. Twenty triangles each and three greens carried in vertex colours,
 * placed on the sites the ridge flagged as brush — which is why they follow the gullies and the
 * shaded folds instead of being sprinkled uniformly.
 */
function scrubBatch(sites, heightAt, { len, depth, n = 2400, seed = 91, hi = 1, scale = 1 }) {
  const rng = new RNG(seed);
  const proto = new THREE.IcosahedronGeometry(1, 0).toNonIndexed();
  const src = proto.attributes.position.array;
  const vc = src.length / 3;
  const STRIDE = 4;                                   // u, v, density, baked sun occlusion
  const count = Math.min(n, Math.floor(sites.length / STRIDE));
  const pos = new Float32Array(count * vc * 3);
  const col = new Float32Array(count * vc * 3);
  const greens = [                                      // linear albedo, as in heroRidge()
    new THREE.Color().setRGB(0.048, 0.072, 0.027),
    new THREE.Color().setRGB(0.084, 0.102, 0.042),
    new THREE.Color().setRGB(0.165, 0.138, 0.066),
    new THREE.Color().setRGB(0.030, 0.048, 0.018),
  ];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const v3 = new THREE.Vector3();
  let w = 0;
  for (let i = 0; i < count; i++) {
    const k = rng.int(0, sites.length / STRIDE - 1) * STRIDE;
    const u = sites[k] + rng.range(-0.0018, 0.0018);
    const v = sites[k + 1] + rng.range(-0.005, 0.005);
    const den = sites[k + 2];
    const shadow = sites[k + 3];
    if (rng.next() > den * 0.85 + 0.12) continue;
    const x = (u - 0.5) * len, z = (0.5 - v) * depth;
    const r = rng.range(3.0, 8.5) * (rng.bool(0.16) ? 2.1 : 1) * scale;
    m.compose(
      v3.set(x, heightAt(x, z) + r * 0.34 * hi, z),
      q.setFromAxisAngle(UP, rng.range(0, 6.28)),
      new THREE.Vector3(r * rng.range(0.8, 1.5), r * rng.range(0.42, 0.80), r * rng.range(0.8, 1.5)),
    );
    const c = greens[rng.int(0, 3)];
    const lit = rng.range(0.72, 1.18) * (1 - shadow * 0.62);
    for (let t = 0; t < vc; t++) {
      v3.set(src[t * 3], src[t * 3 + 1], src[t * 3 + 2]).applyMatrix4(m);
      pos[(w * vc + t) * 3] = v3.x; pos[(w * vc + t) * 3 + 1] = v3.y; pos[(w * vc + t) * 3 + 2] = v3.z;
      col[(w * vc + t) * 3] = c.r * lit; col[(w * vc + t) * 3 + 1] = c.g * lit; col[(w * vc + t) * 3 + 2] = c.b * lit;
    }
    w++;
  }
  proto.dispose();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, w * vc * 3), 3));
  g.setAttribute('color', new THREE.BufferAttribute(col.subarray(0, w * vc * 3), 3));
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------- the letters, as solid boards
//
// Nine free-standing sheet-metal boards on scaffolding, at the real sign's proportions: 45 ft of
// cap height, letters 30-39 ft wide, the row stepping down the contour with each board on its own
// stilts. Every stroke is a solid extruded prism, so the silhouette is cut by geometry and stays
// crisp under SMAA instead of eroding through an alpha-tested mip the way a decal does — and the
// side faces catch the low sun square-on while the front is raked at 69 degrees, which is what
// makes them read as objects standing on a hill rather than paint sprayed onto it.

const ST_T = 0.212;                                   // stroke width, in cap heights
const RECTP = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const SLANTP = (x0, y0, x1, y1, t = ST_T) => [
  [x0 - t / 2, y0], [x0 + t / 2, y0], [x1 + t / 2, y1], [x1 - t / 2, y1],
];
/** An elliptical band as matched outer/inner rims — extruded as a strip, so no internal walls. */
function bandP(cx, cy, rx, ry, t, a0, a1, n, closed) {
  const outer = [], inner = [];
  for (let i = 0; i <= n; i++) {
    const a = lerp(a0, a1, i / n);
    outer.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
    inner.push([cx + Math.cos(a) * (rx - t), cy + Math.sin(a) * (ry - t)]);
  }
  return { outer, inner, closed };
}

const LETTERS = {
  H: { w: 0.86, polys: [RECTP(0, 0, ST_T, 1), RECTP(0.86 - ST_T, 0, 0.86, 1), RECTP(ST_T, 0.40, 0.86 - ST_T, 0.60)] },
  O: { w: 0.90, bands: [bandP(0.45, 0.5, 0.45, 0.5, ST_T, 0, Math.PI * 2, 26, true)] },
  L: { w: 0.72, polys: [RECTP(0, 0, ST_T, 1), RECTP(0, 0, 0.72, 0.205)] },
  Y: {
    w: 0.88,
    polys: [SLANTP(0.106, 1, 0.44, 0.50), SLANTP(0.774, 1, 0.44, 0.50), RECTP(0.44 - ST_T / 2, 0, 0.44 + ST_T / 2, 0.56)],
  },
  W: {
    w: 1.06,
    polys: [SLANTP(0.108, 1, 0.30, 0.02), SLANTP(0.30, 0.02, 0.53, 0.86),
      SLANTP(0.53, 0.86, 0.76, 0.02), SLANTP(0.76, 0.02, 0.952, 1)],
  },
  D: {
    w: 0.88,
    polys: [RECTP(0, 0, ST_T, 1)],
    bands: [bandP(ST_T, 0.5, 0.88 - ST_T, 0.5, ST_T, -Math.PI / 2, Math.PI / 2, 15, false)],
  },
};

const polyArea = (q) => {
  let a = 0;
  for (let i = 0; i < q.length; i++) { const b = q[(i + 1) % q.length]; a += q[i][0] * b[1] - b[0] * q[i][1]; }
  return a / 2;
};

/** One letter as a watertight extrusion: front, back and side walls, hard edges everywhere. */
function letterGeo(ch, d) {
  const L = LETTERS[ch];
  const pos = [], uv = [], idx = [];
  const put = (x, y, z) => { pos.push(x, y, z); uv.push(x * 1.15, y * 1.15); };
  for (const raw of L.polys || []) {
    const q = polyArea(raw) < 0 ? raw.slice().reverse() : raw;
    const n = q.length;
    const b = pos.length / 3;
    for (const [x, y] of q) put(x, y, d / 2);
    for (let i = 1; i < n - 1; i++) idx.push(b, b + i, b + i + 1);
    const bb = pos.length / 3;
    for (const [x, y] of q) put(x, y, -d / 2);
    for (let i = 1; i < n - 1; i++) idx.push(bb, bb + i + 1, bb + i);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, s = pos.length / 3;
      put(q[i][0], q[i][1], d / 2); put(q[j][0], q[j][1], d / 2);
      put(q[j][0], q[j][1], -d / 2); put(q[i][0], q[i][1], -d / 2);
      idx.push(s, s + 2, s + 1, s, s + 3, s + 2);
    }
  }
  for (const bd of L.bands || []) {
    const { outer, inner, closed } = bd;
    const n = outer.length;
    const b = pos.length / 3;
    for (let i = 0; i < n; i++) { put(outer[i][0], outer[i][1], d / 2); put(inner[i][0], inner[i][1], d / 2); }
    for (let i = 0; i < n; i++) { put(outer[i][0], outer[i][1], -d / 2); put(inner[i][0], inner[i][1], -d / 2); }
    const F = (i) => b + i * 2, B = (i) => b + n * 2 + i * 2;
    for (let i = 0; i < n - 1; i++) {
      idx.push(F(i), F(i + 1), F(i) + 1, F(i) + 1, F(i + 1), F(i + 1) + 1);              // front ring
      idx.push(B(i), B(i) + 1, B(i + 1), B(i + 1), B(i) + 1, B(i + 1) + 1);              // back ring
      idx.push(F(i), B(i), F(i + 1), F(i + 1), B(i), B(i + 1));                           // outer wall
      idx.push(F(i) + 1, F(i + 1) + 1, B(i) + 1, F(i + 1) + 1, B(i + 1) + 1, B(i) + 1);   // inner wall
    }
    if (!closed) {                                                                        // cap the arc ends
      for (const [i, flip] of [[0, 1], [n - 1, 0]]) {
        const a = F(i), c = B(i);
        if (flip) idx.push(a, a + 1, c, a + 1, c + 1, c);
        else idx.push(a, c, a + 1, a + 1, c, c + 1);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Sun-bleached corrugated sheet: horizontal panel joints, stiffener shadows, rust and dirt. */
function signPanelTexture(seed) {
  const w = 256, h = 256;
  const { c, ctx } = canvas(w, h);
  const rng = new RNG(seed);
  ctx.fillStyle = '#efeadb'; ctx.fillRect(0, 0, w, h);
  for (let x = 0; x < w; x += 8) {                       // vertical corrugation
    ctx.fillStyle = `rgba(120,112,96,${rng.range(0.05, 0.12)})`;
    ctx.fillRect(x, 0, 2.4, h);
    ctx.fillStyle = 'rgba(255,252,244,0.30)';
    ctx.fillRect(x + 3, 0, 1.6, h);
  }
  for (let y = 22; y < h; y += 44) {                     // panel joints between the sheets
    ctx.fillStyle = `rgba(96,88,74,${rng.range(0.30, 0.48)})`;
    ctx.fillRect(0, y, w, 2.2);
    ctx.fillStyle = 'rgba(255,250,238,0.34)';
    ctx.fillRect(0, y + 2.4, w, 1.2);
  }
  for (let k = 0; k < 130; k++) {                        // weathering and rust bleed
    const x = rng.range(0, w), y = rng.range(0, h);
    ctx.fillStyle = `rgba(${rng.int(150, 205)},${rng.int(120, 170)},${rng.int(90, 130)},${rng.range(0.04, 0.20)})`;
    ctx.fillRect(x, y, rng.range(2, 12), rng.range(8, 54));
  }
  for (let k = 0; k < 26; k++) {
    const x = rng.range(0, w), y = rng.range(0, h);
    const gr = ctx.createLinearGradient(x, y, x, y + 40);
    gr.addColorStop(0, `rgba(150,96,54,${rng.range(0.12, 0.30)})`);
    gr.addColorStop(1, 'rgba(150,96,54,0)');
    ctx.fillStyle = gr; ctx.fillRect(x - 2, y, 5, 40);
  }
  grain(ctx, w, h, 6, rng);
  return toTexture(c, { srgb: true, repeat: [1, 1] });
}

// ---------------------------------------------------------------- palms
//
// The shared kit's palm is a 0.3 m stick with ten short blades on top, which at sixty feet reads
// as a lollipop. LA's street palm is a *Washingtonia*: a very tall, very slender trunk with a
// diamond-scarred bark, a shaggy petticoat of dead fronds hanging under the crown, and a crown of
// stiff FAN leaves — semicircular, split into segments, with threads. The petticoat and the fan
// are the two things that make the silhouette read as this tree and not as a generic palm, and a
// silhouette is all you get when the sun is 16 degrees off the deck behind it.

/** Diamond-scarred Washingtonia bark; the horizontal leaf-base scars spiral round the trunk. */
function barkTexture(seed, tint = '#8a7a62') {
  const w = 64, h = 256;
  const { c, ctx } = canvas(w, h);
  const rng = new RNG(seed);
  ctx.fillStyle = preGamma(tint); ctx.fillRect(0, 0, w, h);
  for (let y = 0; y < h; y += 9) {                       // ring of leaf scars
    // softened from round 1: at full strength the rungs read as a zipper rather than as bark
    ctx.fillStyle = `rgba(${rng.int(58, 84)},${rng.int(48, 68)},${rng.int(34, 50)},${rng.range(0.34, 0.52)})`;
    ctx.fillRect(0, y, w, 3.4);
    ctx.fillStyle = `rgba(${rng.int(186, 224)},${rng.int(168, 200)},${rng.int(132, 164)},0.24)`;
    ctx.fillRect(0, y + 3.6, w, 1.5);
    for (let x = (y / 9 % 2) * 8; x < w; x += 16) {       // the diamond criss-cross
      ctx.fillStyle = `rgba(${rng.int(70, 100)},${rng.int(58, 84)},${rng.int(42, 62)},0.55)`;
      ctx.fillRect(x, y, 2.2, 9);
    }
  }
  for (let k = 0; k < 26; k++) {                          // sun bleach down one flank
    ctx.fillStyle = `rgba(236,222,190,${rng.range(0.03, 0.12)})`;
    ctx.fillRect(rng.range(0, w), rng.range(0, h), rng.range(3, 12), rng.range(20, 90));
  }
  grain(ctx, w, h, 9, rng);
  return toTexture(c, { srgb: true });
}

/**
 * ONE FAN LEAF, BUILT AS A SOLID SHEET.
 *
 * Round 1's leaf was eleven separate blades 22 cm wide radiating over 150 degrees — 60% of the
 * fan's area was gap. Backlit by a 16-degree sun and rendered at 1600x900, every one of those
 * blades falls under a pixel by fifty metres out and the crown shreds into black speckle noise;
 * SMAA cannot recover a signal that was never sampled. The critic read the result as an alpha
 * cutout, which is exactly what sub-pixel geometry looks like.
 *
 * So the fan is now ONE continuous quad grid swept through the fan's arc, with the finger
 * structure cut into its OUTER EDGE as deep V notches rather than as gaps between separate
 * blades. Angularly it is watertight — no slivers of sky can open up inside it at any distance —
 * while the notched rim still gives the ragged Washingtonia silhouette when the tree is close.
 * The whole sheet also droops harder at its rim than at its middle, so the leaf is a cupped
 * saucer rather than a flat disc and the crown has real volume in silhouette.
 */
function fanLeafGeo(rng, len, { fingers = 9, notch = 0.60, spread = 2.5, droop = 0.40, segs = 3 } = {}) {
  const pos = [], uv = [], idx = [];
  const hub = len * 0.13;
  // Angular sample columns: a V-notch, then the two shoulders of a finger, then the next notch.
  // Fingers get real WIDTH this way instead of coming to a single-vertex point — a spike one pixel
  // wide is the same aliasing problem as a gap one pixel wide, and a fan of spikes reads as an
  // agave rather than a palm. Two thirds of each pitch is finger, one third is notch.
  // `pl` is the PLEAT: a real fan leaf is folded like a paper fan, the crease running out along
  // every finger. Lifting the finger shoulders and dropping the notches by a few centimetres costs
  // nothing and is what stops a crown of these reading as a rosette of flat paddles — each finger
  // now catches the low sun at its own angle.
  const cols = [];
  for (let i = 0; i < fingers; i++) {
    const full = len * (0.70 + Math.cos(((i + 0.5) / fingers - 0.5) * 2.7) * 0.32) * rng.range(0.94, 1.06);
    cols.push({ f: i / fingers, r: full * notch * rng.range(0.92, 1.08), pl: -0.055 });
    cols.push({ f: (i + 0.17) / fingers, r: full * 0.94, pl: 0.030 });
    cols.push({ f: (i + 0.83) / fingers, r: full * 0.94, pl: 0.030 });
  }
  cols.push({ f: 1, r: cols[cols.length - 1].r * notch, pl: -0.055 });
  const N = cols.length - 1;
  for (let j = 0; j <= N; j++) {
    const c = cols[j].f - 0.5;                    // -0.5 .. 0.5 across the fan
    const a = c * spread;
    const dro = droop * (0.45 + Math.abs(c) * 1.9);
    const base = pos.length / 3;
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      const r = lerp(hub, cols[j].r, t);
      // the sheet falls away along its length AND toward its rim: cupped, not flat
      const y = -Math.pow(t, 1.65) * cols[j].r * dro + cols[j].pl * r;
      pos.push(Math.cos(a) * r, y, Math.sin(a) * r);
      uv.push(t, j / N);
    }
    if (j < N) {
      for (let s = 0; s < segs; s++) {
        const k = base + s, k2 = k + segs + 1;
        idx.push(k, k2, k + 1, k + 1, k2, k2 + 1);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  // the petiole: a stiff tapered stalk from the crown out to the hub of the fan, which is what
  // holds the fan away from the trunk and is half of the silhouette at close range
  const stalkLen = hub * 1.5;
  const stalk = new THREE.CylinderGeometry(0.028, 0.055, stalkLen, 4);
  stalk.rotateZ(-Math.PI / 2);
  stalk.translate(stalkLen * 0.5, 0, 0);
  return mergeGeometries([stripGeo(g), stripGeo(stalk)], false);
}

/**
 * A Washingtonia, at one of three densities.
 *
 * `lod` 0 is a kerbside tree the player drives past at two metres; 2 is one of the row standing on
 * the flood-channel berm a hundred metres out. The far LOD is not just "the same tree with fewer
 * triangles" — it has FEWER, WIDER, LONGER fans, because what has to survive at that range is the
 * blob-with-a-ragged-edge silhouette, and spending the triangles on more fingers instead makes it
 * shred. `mats` carries the shared materials so three hundred trees still leave the merger as a
 * handful of buffers.
 */
const PALM_LOD = [
  { nf: 13, fingers: 9, segs: 3, spread: 2.60, notch: 0.58, skirt: 20, hang: 8 },
  { nf: 10, fingers: 8, segs: 3, spread: 2.50, notch: 0.64, skirt: 16, hang: 6 },
  { nf: 8, fingers: 6, segs: 2, spread: 2.35, notch: 0.70, skirt: 12, hang: 4 },
];

function washingtonia({ h = 22, seed = 1, lean = 0.03, lod = 0, mats, cache, leafMat = 'leaf' }) {
  const rng = new RNG(seed * 31 + 7);
  const g = new THREE.Group();
  const L = PALM_LOD[lod];
  const key = `w${lod}|${Math.round(h)}|${seed % 9}`;
  let proto = cache.get(key);
  if (!proto) {
    proto = [];
    // ---- trunk: slender, tapered, bent by its own weight, with a flared root plate
    const rB = 0.30 + h * 0.0060, rT = 0.21 + h * 0.0030;
    const tg = new THREE.CylinderGeometry(rT, rB, h, 9, 7, true);
    tg.translate(0, h / 2, 0);
    const bend = (t) => [Math.sin(t * 1.5) * lean * h, (Math.cos(t * 2.0) - 1) * lean * h * 0.42];
    const tp = tg.attributes.position;
    for (let i = 0; i < tp.count; i++) {
      const [bx, bz] = bend(tp.getY(i) / h);
      tp.setX(i, tp.getX(i) + bx);
      tp.setZ(i, tp.getZ(i) + bz);
    }
    tg.computeVertexNormals();
    const tuv = tg.attributes.uv;
    for (let i = 0; i < tuv.count; i++) tuv.setXY(i, tuv.getX(i) * 1.6, tuv.getY(i) * h * 0.30);
    proto.push({ geo: tg, mat: 'bark' });
    const flare = new THREE.CylinderGeometry(rB, rB + 0.34, 1.1, 9, 1, true);
    flare.translate(0, 0.55, 0);
    proto.push({ geo: flare, mat: 'bark' });
    const [topX, topZ] = bend(1);

    // ---- the petticoat, as ONE ragged solid skirt.
    //
    // Nineteen 30 cm planes hanging in a ring was the same sub-pixel mistake as the fronds: from
    // the road it read as a brown drip under the crown. A shaggy Washingtonia skirt is a SOLID
    // cone of thatch with a torn hem, so that is what it is now — one closed strip whose bottom
    // edge is jagged — with a handful of longer fronds hung off it to break the outline.
    {
      const nS = L.skirt;
      const yTop = h - 0.85;
      const rTop = rT + 0.26, rBot = rT + 0.62;
      const pos = [], uv = [], idx = [];
      const hem = [];
      for (let j = 0; j <= nS; j++) hem.push(rng.range(1.1, 2.9));
      hem[nS] = hem[0];
      for (let j = 0; j <= nS; j++) {
        const a = (j / nS) * Math.PI * 2;
        const cx = Math.cos(a), cz = Math.sin(a);
        pos.push(topX + cx * rTop, yTop, topZ + cz * rTop);
        pos.push(topX + cx * rBot, yTop - hem[j], topZ + cz * rBot);
        uv.push(j / nS, 1, j / nS, 0);
        if (j < nS) { const k = j * 2; idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); }
      }
      const skirt = new THREE.BufferGeometry();
      skirt.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      skirt.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      skirt.setIndex(idx);
      skirt.computeVertexNormals();
      proto.push({ geo: skirt, mat: 'dead' });
      // and the long dead fronds still hanging on below it
      for (let i = 0; i < L.hang; i++) {
        const a = rng.range(0, Math.PI * 2);
        const dl = rng.range(1.6, 3.4);
        const blade = new THREE.PlaneGeometry(0.62, dl, 1, 2);
        const bp = blade.attributes.position;
        for (let k = 0; k < bp.count; k++) {
          const v = (bp.getY(k) + dl / 2) / dl;
          bp.setY(k, bp.getY(k) - dl / 2);
          bp.setX(k, bp.getX(k) * (0.30 + v * 1.1));
          bp.setZ(k, (1 - v) * rng.range(0.15, 0.60));
        }
        blade.computeVertexNormals();
        blade.rotateY(-a);
        blade.translate(topX + Math.cos(a) * (rT + 0.44), h - 1.15, topZ + Math.sin(a) * (rT + 0.44));
        proto.push({ geo: blade, mat: 'dead' });
      }
    }

    // ---- the crown: fans in three tiers — a raised centre, a horizontal ring, a drooping rim
    for (let i = 0; i < L.nf; i++) {
      const a = (i / L.nf) * Math.PI * 2 + rng.range(-0.20, 0.20);
      const tier = i % 3;
      const pitch = [0.92, 0.22, -0.46][tier] + rng.range(-0.15, 0.15);
      const len = rng.range(2.1, 3.1) * (0.82 + h * 0.012) * (tier === 1 ? 1.08 : 1);
      const leaf = fanLeafGeo(rng, len, {
        fingers: L.fingers, segs: L.segs, spread: L.spread, notch: L.notch,
        droop: tier === 0 ? 0.30 : 0.46,
      });
      leaf.rotateZ(pitch);
      leaf.rotateY(-a);
      leaf.translate(topX, h - 0.30 + rng.range(-0.22, 0.22), topZ);
      proto.push({ geo: leaf, mat: 'leaf' });
    }
    // ---- the crownshaft: a fat collar so the fans do not all sprout from one point
    const boot = new THREE.SphereGeometry(rT + 0.34, 8, 6);
    boot.scale(1, 0.82, 1);
    boot.translate(topX, h - 0.50, topZ);
    proto.push({ geo: boot, mat: 'bark' });

    // one buffer per material, so a palm is three meshes rather than fifty
    const byMat = {};
    for (const p of proto) (byMat[p.mat] ||= []).push(stripGeo(p.geo));
    proto = Object.entries(byMat).map(([k, list]) => ({
      mat: k, geo: list.length === 1 ? list[0] : mergeGeometries(list, false),
    }));
    cache.set(key, proto);
  }
  for (const p of proto) {
    const m = new THREE.Mesh(p.geo, mats[p.mat === 'leaf' ? leafMat : p.mat]);
    m.castShadow = true;
    m.receiveShadow = p.mat === 'bark';
    g.add(m);
  }
  return g;
}

// ---------------------------------------------------------------- street cars
//
// Round 1's traffic was a rounded box with a smaller rounded box on top and four dark nubs — flat
// single colour, no glass, no lights, no trim — standing at the kerb three metres from a camera
// that spends the whole lap looking straight at it, and frozen on the freeway decks where it is
// the only thing giving the structure scale. It was the second half of the "near/mid prop tier is
// programmer art" gap, and it is not something a texture fixes: a car reads as a car through its
// SILHOUETTE (a body that tucks under at the sills and pinches at both ends, a greenhouse set in
// from it, arches cut over the wheels) and through having glass, chrome and lit lamps as separate
// materials the way §2.3 asks of the hero cars.
//
// So these are lofted the same way the hero cars are: one cross-section swept along a spine whose
// scale varies station to station, a real greenhouse of pillars with glass hung between them,
// wheels with rims, chrome bumpers, and emissive lamps. About 700 triangles each. Every painted
// surface goes into ONE vertex-coloured material through the merger's remap hook, so forty cars in
// six colours is one draw call per chunk rather than six.

/** Body cross-section, normalised: half-width 1, half-height 0.5, tucked under, tumblehome on top. */
const CAR_SECTION = [
  [-0.89, -0.50], [0.89, -0.50], [1.00, -0.18], [1.00, 0.25],
  [0.80, 0.50], [-0.80, 0.50], [-1.00, 0.25], [-1.00, -0.18],
];
const ROOF_SECTION = [[-1, 0], [1, 0], [0.93, 1], [-0.93, 1]];

/** Stations down the car's spine: [z, half-width scale, height scale]. */
function spine(rows, y = 0) {
  return rows.map(([z, sx, sy]) => ({
    p: new THREE.Vector3(0, y, z),
    r: new THREE.Vector3(1, 0, 0),
    u: new THREE.Vector3(0, 1, 0),
    sx, sy,
  }));
}

const CAR_SPEC = {
  //          L     W     bodyH  roofH  wheelR  cabF   cabR   bed
  sedan: { L: 4.80, W: 1.94, bh: 0.92, rh: 0.66, wr: 0.35, cf: 0.62, cr: -1.42 },
  coupe: { L: 4.62, W: 1.96, bh: 0.86, rh: 0.58, wr: 0.35, cf: 0.42, cr: -1.05 },
  wagon: { L: 5.05, W: 1.96, bh: 0.94, rh: 0.72, wr: 0.36, cf: 0.66, cr: -2.10 },
  pickup: { L: 5.35, W: 2.00, bh: 0.90, rh: 0.74, wr: 0.40, cf: 0.85, cr: -0.35, bed: true },
  van: { L: 5.15, W: 2.04, bh: 1.36, rh: 0.66, wr: 0.37, cf: 1.15, cr: -2.20 },
};

/**
 * One car body, as an array of `{ geo, mat }`. Cached by kind+variant, so the whole city's traffic
 * costs five or six of these to build.
 */
function streetCarProto(kind, variant) {
  const S = CAR_SPEC[kind] || CAR_SPEC.sedan;
  const rng = new RNG(variant * 977 + 41);
  const out = [];
  const L = S.L * rng.range(0.96, 1.05), W = S.W * rng.range(0.97, 1.03);
  const bh = S.bh * rng.range(0.95, 1.06), rh = S.rh * rng.range(0.94, 1.08);
  const wr = S.wr, HL = L / 2;
  const ride = wr * 0.80;
  const yWaist = ride + bh / 2;
  const yTop = ride + bh;                                  // the beltline
  const yRoof = yTop + rh;
  const hw = W / 2;
  const cf = S.cf * rng.range(0.94, 1.06), cr = Math.max(S.cr, -HL + 0.55);
  const roofHW = hw * (kind === 'van' ? 0.94 : 0.76);
  const wb = L * 0.60;                                     // wheelbase

  // ---- lower body: one octagon lofted down the spine
  const nose = kind === 'van' ? 0.90 : 0.74, tail = kind === 'van' ? 0.92 : 0.78;
  out.push({
    geo: sweep(spine([
      [-HL, tail, 0.62], [-HL + 0.34, 0.94, 0.90], [-HL + 1.10, 1.00, 1.00],
      [0.05, 1.00, 1.00], [HL - 1.20, 1.00, 0.98], [HL - 0.36, 0.95, 0.86], [HL, nose, 0.64],
    ], yWaist).map((s) => ({ ...s, sx: s.sx * hw, sy: s.sy * bh })),
    [CAR_SECTION], { uvScale: 0.6, caps: true }),
    mat: 'paint',
  });

  // ---- greenhouse: a roof panel carried on real pillars, with glass hung between them
  const roofF = cf - rh * 0.92, roofR = cr + rh * 0.72;
  out.push({
    geo: sweep(spine([
      [roofR, 0.86, 1], [roofR + 0.26, 0.98, 1], [roofF - 0.26, 1.00, 1], [roofF, 0.90, 1],
    ], yRoof).map((s) => ({ ...s, sx: s.sx * roofHW, sy: 0.085 })),
    [ROOF_SECTION], { uvScale: 0.6, caps: true }),
    mat: 'paint',
  });
  /** A pillar (or a pane) spanning beltline→roof; returns the tilt so glass can share it. */
  const strut = (z0, z1, x, wide, thick, m) => {
    const dy = yRoof - yTop, dz = z1 - z0;
    const len = Math.hypot(dy, dz);
    const th = Math.atan2(dz, dy);
    const g = new THREE.BoxGeometry(wide, len, thick);
    g.rotateX(th);
    g.translate(x, (yTop + yRoof) / 2, (z0 + z1) / 2);
    out.push({ geo: g, mat: m });
    return th;
  };
  const pane = (z0, z1, halfW, m, push = 0.02) => {
    const dy = yRoof - yTop, dz = z1 - z0;
    const len = Math.hypot(dy, dz) * 0.94;
    const th = Math.atan2(dz, dy);
    const g = new THREE.PlaneGeometry(halfW * 2, len);
    g.rotateX(th);
    // proud of the pillars along the pane's own outward normal, so nothing z-fights
    g.translate(0, (yTop + yRoof) / 2 - Math.sin(th) * push, (z0 + z1) / 2 + Math.cos(th) * push);
    out.push({ geo: g, mat: m });
  };
  const px = hw * 0.80;
  for (const sx of [-1, 1]) {
    strut(cf, roofF, sx * px * 0.96, 0.10, 0.13, 'paint');            // A-pillar
    strut(cr, roofR, sx * px * 0.94, 0.12, 0.15, 'paint');            // C-pillar
    if (cr < -1.0) strut(cr + 0.86, cr + 0.86, sx * px * 0.98, 0.09, 0.12, 'paint');  // B-pillar
  }
  pane(cf, roofF, roofHW * 0.94, 'glass', 0.03);                      // windscreen
  pane(cr, roofR, roofHW * 0.92, 'glass', -0.03);                     // backlight
  {   // side glass, split at the B-pillar so the greenhouse is not one long slot
    const zA = cf - 0.16, zB = cr + 0.16;
    const cuts = cr < -1.0 ? [[zB, cr + 0.80], [cr + 0.92, zA]] : [[zB, zA]];
    for (const [z0, z1] of cuts) {
      for (const sx of [-1, 1]) {
        const g = new THREE.PlaneGeometry(Math.abs(z1 - z0), rh * 0.78);
        g.rotateY(sx * Math.PI / 2);
        g.translate(sx * (px + 0.015), yTop + rh * 0.46, (z0 + z1) / 2);
        out.push({ geo: g, mat: 'glass' });
      }
    }
  }

  // ---- pickup bed: side rails, a tailgate and a dark floor behind the cab
  if (S.bed) {
    const b0 = cr - 0.30, b1 = -HL + 0.10;
    for (const sx of [-1, 1]) {
      const g = new THREE.BoxGeometry(0.13, 0.46, Math.abs(b1 - b0));
      g.translate(sx * (hw - 0.08), yTop + 0.20, (b0 + b1) / 2);
      out.push({ geo: g, mat: 'paint' });
    }
    const gate = new THREE.BoxGeometry(W * 0.94, 0.46, 0.12);
    gate.translate(0, yTop + 0.20, b1);
    out.push({ geo: gate, mat: 'paint' });
    const floor = new THREE.PlaneGeometry(W * 0.86, Math.abs(b1 - b0));
    floor.rotateX(-Math.PI / 2);
    floor.translate(0, yTop + 0.02, (b0 + b1) / 2);
    out.push({ geo: floor, mat: 'dark' });
  }

  // ---- wheels, arches and the shadow gap under the sills
  for (const sx of [-1, 1]) {
    for (const sz of [1, -1]) {
      const wz = sz * wb / 2;
      const t = new THREE.CylinderGeometry(wr, wr, 0.25, 14);
      t.rotateZ(Math.PI / 2);
      t.translate(sx * (hw - 0.11), wr, wz);
      out.push({ geo: t, mat: 'dark' });
      const rim = new THREE.CylinderGeometry(wr * 0.54, wr * 0.54, 0.265, 10);
      rim.rotateZ(Math.PI / 2);
      rim.translate(sx * (hw - 0.11), wr, wz);
      out.push({ geo: rim, mat: 'chrome' });
      const arch = new THREE.TorusGeometry(wr * 1.16, 0.055, 3, 9, Math.PI);
      arch.rotateY(Math.PI / 2);
      arch.translate(sx * (hw - 0.02), wr, wz);
      out.push({ geo: arch, mat: 'dark' });
    }
  }

  // ---- chrome, lamps and plates: the trim that separates a car from a bar of soap
  // ...and the bumpers follow the body's own taper. A full-width bar on a nose scaled to 74% is a
  // plank sticking out past the wings, which is exactly what it looked like at 4x.
  const bump = (z, y, wScale) => {
    const g = new THREE.BoxGeometry(W * wScale * 0.98, 0.16, 0.20);
    g.translate(0, y, z);
    out.push({ geo: g, mat: 'chrome' });
  };
  bump(HL - 0.04, ride + bh * 0.30, nose);
  bump(-HL + 0.04, ride + bh * 0.30, tail);
  const grille = new THREE.BoxGeometry(W * nose * 0.72, 0.22, 0.08);
  grille.translate(0, ride + bh * 0.56, HL - 0.03);
  out.push({ geo: grille, mat: 'dark' });
  for (const sx of [-1, 1]) {
    const tl = new THREE.BoxGeometry(0.34, 0.17, 0.08);
    tl.translate(sx * W * tail * 0.34, ride + bh * 0.62, -HL + 0.03);
    out.push({ geo: tl, mat: 'tail' });
    const hl = new THREE.BoxGeometry(0.32, 0.16, 0.08);
    hl.translate(sx * W * nose * 0.34, ride + bh * 0.60, HL - 0.03);
    out.push({ geo: hl, mat: 'head' });
    const mir = new THREE.BoxGeometry(0.09, 0.10, 0.20);
    mir.translate(sx * (hw + 0.07), yTop + 0.10, cf - 0.10);
    out.push({ geo: mir, mat: 'dark' });
  }
  const plate = new THREE.BoxGeometry(0.52, 0.16, 0.05);
  plate.translate(0, ride + bh * 0.38, -HL + 0.02);
  out.push({ geo: plate, mat: 'chrome' });

  // one buffer per material
  const byMat = {};
  for (const p of out) (byMat[p.mat] ||= []).push(stripGeo(p.geo));
  return Object.entries(byMat).map(([k, list]) => ({
    mat: k, geo: list.length === 1 ? list[0] : mergeGeometries(list, false),
  }));
}

/**
 * Assemble one car from a cached prototype. `mats.paint` is a TAG material — nothing is ever drawn
 * with it; the merger's remap hook sees it, substitutes the shared vertex-coloured paint material
 * and bakes `tint` into the vertices, which is how nine body colours cost one draw call.
 */
function streetCar({ kind = 'sedan', variant = 0, tint = null, mats, cache }) {
  const key = `car|${kind}|${variant}`;
  let proto = cache.get(key);
  if (!proto) { proto = streetCarProto(kind, variant); cache.set(key, proto); }
  const g = new THREE.Group();
  for (const p of proto) {
    const m = new THREE.Mesh(p.geo, mats[p.mat]);
    m.castShadow = p.mat !== 'glass';
    m.receiveShadow = p.mat === 'paint' || p.mat === 'dark';
    if (p.mat === 'paint' && tint) m.userData.tint = tint;
    g.add(m);
  }
  return g;
}

// ---------------------------------------------------------------- the atmosphere layers
//
// The sky dome is a single vertical gradient and — measured, see `look.sky` — a driving frame only
// ever samples ONE of its stops. So everything that gives this sky a structure is built here, as
// geometry, in three layers the camera looks through in order:
//
//   clouds        cards at 250-700 m altitude, warm-lit tops, mauve undersides
//   far range     the San Gabriels: pale, hazed almost to the smog colour, 780 m high at 2.3 km
//   smog band     an ochre inversion layer sitting ON the skyline, densest at the horizon line
//
// All three are unlit and unfogged: at these distances a lit material is a fog-coloured slab and a
// hemisphere light would flatten them, so the shading — including which flank of each summit the
// sun is on — is baked into vertex colours instead. Three draw calls for the whole sky.

const SUN_AZ = Math.atan2(-0.30, 0.91);      // atan2(x, z) of look.sun.dir — see below

/**
 * The ochre inversion layer: dense at the skyline, thinning out by ~26 degrees, and — the point of
 * this round — very nearly the SAME layer whichever way the camera is pointed.
 *
 * COHERENCE PASS. The whole-game critic caught Los Angeles showing three different times of day in
 * three captures: cyan midday down the boulevard, orange dusk in the drift, pink-and-teal dusk at
 * the landmark. Measured over the twelve LA captures, the sky band ran h168 s17 l42 facing away
 * from the sun and h13 s37 l42 facing into it — not a grade drift and not a per-capture seed, but
 * pure AZIMUTH. Two terms produced all of it: `skyCanvas`'s sun-glow disc (a 75-degree radial wedge
 * of `sunColor` composited `lighter` over the dome, which simply repaints the sky orange on the sun
 * side and leaves it untouched on the other) and this layer, which used to nearly vanish away from
 * the sun and pile up under it.
 *
 * A city is one hour or it is not a city, so the warm half of LA's complementary pair now comes
 * from a layer that is present at EVERY heading:
 *   - the density exponent goes 2.2 -> 1.80, which lifts the layer's useful top from about 12
 *     degrees to about 22. That matters because the ridge line closes the bottom 16 degrees of the
 *     chase frame: with the old profile there was nothing but bare turquoise dome above the hills,
 *     which is exactly the "cyan midday" reading. There is now an ochre inversion sitting on the
 *     crest in that frame too — 54% dense at 3 degrees, 39% at 8, 23% at 14, 12% at 20 and gone by
 *     26, so the layer reads as a LAYER with turquoise sky above it rather than as a wash. (1.30
 *     was tried first and measured: it pushed the ochre past 26 degrees, took the whole visible
 *     dome with it, and cost LA the cold half of its complementary pair — one time of day, but a
 *     monochrome one. §2.1 wants three to five hues, and the turquoise is one of them.)
 *   - the azimuthal boost goes (0.82 + 0.50·sunlit) -> (0.94 + 0.20·sunlit), i.e. a 1.21x swing
 *     instead of 1.61x. The sun side is still the warmer side — it should be — but it is now the
 *     same sky lit differently rather than a different sky.
 */
function smogBandTexture(seed) {
  const w = 512, h = 128;
  const { c, ctx } = canvas(w, h);
  const rng = new RNG(seed);
  const f = fbmField(w, h, { seed: seed + 3, octaves: 4, scale: 5, warp: 0.5 });
  const img = ctx.createImageData(w, h);
  const sunU = ((SUN_AZ / (Math.PI * 2)) % 1 + 1) % 1;
  for (let y = 0; y < h; y++) {
    const v = y / (h - 1);                        // 0 = top of the band, 1 = the skyline itself
    // density profile: thin at the top, a soft inversion shoulder, then a hard pile-up at the
    // horizon line. The shoulder is what makes it read as a LAYER and not as a gradient.
    // (grade-discipline pass) 1.80 -> 3.20. See the note above `smogBandTexture` for the
    // measurement: with the exponent at 1.80 this layer was still 10-23 % opaque across the 14-26°
    // band, which is exactly the band a chase camera fills its upper third with — so half the
    // captures had an ochre wash where the sky should be and half (the landmark framing, pitched
    // higher) had bare turquoise. That difference is most of "three different skies".
    //
    // At 3.20 the layer is 50 % dense at 2°, 27 % at 6°, 7 % at 14° and effectively gone by 20°:
    // an inversion sitting ON the skyline, with the SAME turquoise dome above it in every framing,
    // which is what one city at one hour looks like. The warm half of the complementary pair is
    // not lost — it moves down onto the horizon line where a real smog layer is, and the hills,
    // the ochre fog and the stucco carry it through the mid-ground.
    const base = Math.pow(v, 3.20) * 0.99;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      // azimuthal term: within ~70 deg of the sun the layer glows and thickens — but only just.
      const du = Math.abs(((x / w - sunU + 0.5) % 1 + 1) % 1 - 0.5);
      const sunlit = Math.pow(1 - smoothstep(0.0, 0.24, du), 1.5);
      const wisp = 0.72 + (f[i] - 0.5) * 0.9;     // torn horizontal structure in the layer
      // (grade-discipline pass) 0.94 + 0.20·sunlit -> 0.99 + 0.06·sunlit. A 1.06x swing instead of
      // a 1.21x one: the sun side is still marginally the denser side, but the layer is now within
      // measurement noise of being the same layer at every heading, which is the point of it.
      const a = clamp(base * wisp * (0.99 + sunlit * 0.06), 0, 1);
      // PRE-COMPENSATED, and it has to be. Measured through the whole chain, a flat ochre band of
      // (240,176,132) lands on screen as (221,133,159) — the grade's saturation lift pulls green
      // out and the mauve shadow lift puts blue back in, so painting the colour you want gets you
      // magenta smog. Pushing the source toward yellow lands it on the warm ochre it should be.
      img.data[i * 4] = 250 + sunlit * 5;
      img.data[i * 4 + 1] = 202 + sunlit * 14 - (1 - v) * 14;
      img.data[i * 4 + 2] = 96 + sunlit * 14 + (1 - v) * 34;
      img.data[i * 4 + 3] = a * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  grain(ctx, w, h, 3, rng);
  return toTexture(c, { srgb: true, wrap: THREE.RepeatWrapping });
}

function smogBand({ radius = 2450, height = 1500, seed = 5 }) {
  const geo = new THREE.CylinderGeometry(radius, radius, height, 72, 1, true);
  geo.translate(0, height * 0.5 - 60, 0);
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    map: smogBandTexture(seed), transparent: true, depthWrite: false,
    side: THREE.BackSide, fog: false, opacity: 0.95,
  }));
  m.renderOrder = -4;
  m.userData.noMerge = true;
  m.frustumCulled = false;
  return m;
}

/**
 * Ridge-and-gully skin for a range curtain. Near-white so it only modulates the baked vertex
 * shading, and built entirely of vertical strokes — which is what a mountain flank looks like
 * from twenty kilometres and what stops these reading as the flat-shaded polygons round 2 caught.
 */
function rangeSkinTexture(seed) {
  const w = 256, h = 128;
  const { c, ctx } = canvas(w, h);
  const rng = new RNG(seed + 71);
  ctx.fillStyle = '#b4b4b4'; ctx.fillRect(0, 0, w, h);
  for (let k = 0; k < 240; k++) {                       // spurs and gullies down every flank
    const x = rng.range(0, w);
    const top = rng.range(0, h * 0.5);
    const g = ctx.createLinearGradient(x, top, x, h);
    const l = rng.int(96, 214);
    g.addColorStop(0, `rgba(${l},${l},${l},0)`);
    g.addColorStop(0.3, `rgba(${l},${l},${l},${rng.range(0.25, 0.7)})`);
    g.addColorStop(1, `rgba(${l},${l},${l},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(x, top, rng.range(1, 5), h - top);
  }
  for (let k = 0; k < 40; k++) {                        // snow-free scree patches near the tops
    ctx.fillStyle = `rgba(${rng.int(190, 235)},${rng.int(188, 232)},${rng.int(190, 236)},${rng.range(0.08, 0.24)})`;
    ctx.fillRect(rng.range(0, w), rng.range(0, h * 0.4), rng.range(4, 22), rng.range(6, 34));
  }
  grain(ctx, w, h, 6, rng);
  return toTexture(c, { srgb: true, wrap: THREE.RepeatWrapping });
}

/**
 * A mountain range as a curtain: one strip of geometry whose top edge is a summit profile and
 * whose colour is baked per vertex — sun-facing flanks warm, lee flanks mauve, and haze pooling
 * up from the base so the range dissolves into the smog instead of standing on a hard line.
 */
function mountainRange({
  radius, height, seed, arc = [0, Math.PI * 2], peaks = 9, haze = '#e8c096',
  lit = '#c9a074', shade = '#8b7690', gap = null,
}) {
  const segs = 260, rows = 5;
  const rng = new RNG(seed);
  // Two scales. A handful of broad MASSIFS carry the mass of the range; narrow SUMMITS ride on
  // top of them and only where there is already a massif under them, so the crest line breaks into
  // separate tops instead of the range becoming a row of isolated circus tents.
  const massif = [], summit = [];
  for (let i = 0; i < peaks; i++) {
    massif.push({ c: rng.next(), w: rng.range(0.055, 0.17), a: rng.range(0.35, 0.9) });
  }
  for (let i = 0; i < peaks * 3; i++) {
    summit.push({ c: rng.next(), w: rng.range(0.005, 0.020), a: rng.range(0.12, 0.42) });
  }
  const f = fbmField(segs + 1, 1, { seed: seed + 11, octaves: 5, scale: 34 });
  const hz = new THREE.Color(preGamma(haze));
  const cl = new THREE.Color(preGamma(lit));
  const cs = new THREE.Color(preGamma(shade));
  const pos = [], col = [], idx = [], uv = [];
  const tmp = new THREE.Color();
  // NB the index clamp. profile() is sampled at t ± 0.004 to work out which way each face turns,
  // which reaches outside [0,1] at both ends of the arc; an out-of-range read hands back undefined,
  // that becomes a NaN vertex colour, the NaN survives into the HDR target and the bloom blur then
  // smears it over the entire frame — the whole city renders as a black silhouette. Diagnosed the
  // hard way.
  const at = (t) => f[clamp(Math.round(clamp(t, 0, 1) * segs), 0, segs)];
  // Summits, not dunes. A gaussian bump wide enough to span ten degrees of azimuth reads as a sand
  // dune however you colour it, so each peak is narrow (1-4% of the arc) with a sharp exponential
  // crest and a long skirt, they are summed rather than max'd so shoulders pile into ridges, and a
  // 34-cycle fbm on top breaks every crest line into individual tops.
  const profile = (t) => {
    const tc = clamp(t, 0, 1);
    let m = 0.06;
    for (const p of massif) {
      const d = (tc - p.c) / p.w;
      m += p.a * Math.exp(-d * d);
    }
    m = Math.min(m, 1.0);
    let sp = 0;
    for (const p of summit) {
      const d = Math.abs(tc - p.c) / p.w;
      sp += p.a * Math.exp(-Math.pow(d, 1.3));
    }
    return clamp(m * (0.70 + at(tc) * 0.44) + Math.min(sp, 0.55) * m, 0, 1.4);
  };
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const az = lerp(arc[0], arc[1], t);
    let hgt = height * profile(t);
    // a gap in the ring: the range dies away over an arc (LA's ocean side), so the sky is open
    // in one direction and the ring never reads as a wall around a stage
    if (gap) {
      const d = Math.abs(((az - gap.at + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI);
      hgt *= smoothstep(0, gap.half, d);
    }
    // grazing light: the flank facing the sun's azimuth is lit, the far flank is in shade
    const dot = Math.cos(az - SUN_AZ);
    const slope = (profile(t + 0.004) - profile(t - 0.004)) * 60;   // which way this face turns
    const facing = clamp(0.5 + dot * 0.5 - slope * 0.16, 0, 1);
    for (let r = 0; r <= rows; r++) {
      const v = r / rows;
      const y = lerp(-30, hgt, v);
      pos.push(Math.sin(az) * radius, y, Math.cos(az) * radius);
      uv.push(i * 0.055, v);
      // haze pools at the foot and thins toward the summit — and pools again ON the summit, so
      // the crest does not meet the sky on a hard line of two flat colours (§7)
      tmp.copy(cs).lerp(cl, facing * (0.35 + v * 0.65));
      const wash = Math.pow(1 - v, 1.5) * 0.86 + Math.pow(v, 3.2) * 0.42;
      tmp.lerp(hz, Math.min(0.95, wash));
      col.push(tmp.r, tmp.g, tmp.b);
    }
  }
  for (let i = 0; i < segs; i++) {
    for (let r = 0; r < rows; r++) {
      const a = i * (rows + 1) + r, b = a + rows + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    vertexColors: true, side: THREE.DoubleSide, fog: false, map: rangeSkinTexture(seed),
  }));
  m.renderOrder = -3;
  m.userData.noMerge = true;
  m.frustumCulled = false;
  return m;
}

/** Soft cumulus card: warm-lit crown, mauve underside, no hard edge anywhere. */
function cloudTexture(seed) {
  const w = 256, h = 128;
  const { c, ctx } = canvas(w, h);
  const rng = new RNG(seed);
  ctx.clearRect(0, 0, w, h);
  const lobes = [];
  for (let i = 0; i < 11; i++) {
    lobes.push({
      x: rng.range(30, w - 30),
      y: rng.range(h * 0.34, h * 0.74),
      r: rng.range(16, 44),
    });
  }
  for (const l of lobes) {
    const g = ctx.createRadialGradient(l.x, l.y - l.r * 0.25, l.r * 0.1, l.x, l.y, l.r);
    g.addColorStop(0, 'rgba(255,240,220,0.92)');
    g.addColorStop(0.45, 'rgba(236,214,198,0.58)');
    g.addColorStop(1, 'rgba(198,178,182,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(l.x, l.y, l.r, 0, 7); ctx.fill();
  }
  // mauve shadowed base
  ctx.globalCompositeOperation = 'source-atop';
  const sg = ctx.createLinearGradient(0, h * 0.42, 0, h * 0.92);
  sg.addColorStop(0, 'rgba(255,226,196,0)');
  sg.addColorStop(1, 'rgba(126,108,138,0.66)');
  ctx.fillStyle = sg; ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'source-over';
  // torn edges so the card is not an oval
  ctx.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 40; i++) {
    const x = rng.range(0, w), y = rng.range(0, h);
    const r = rng.range(4, 18);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(0,0,0,${rng.range(0.2, 0.7)})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
  return toTexture(c, { srgb: true, wrap: THREE.ClampToEdgeWrapping });
}

// ---------------------------------------------------------------- the city definition

export const def = {
  id: 'la',
  name: 'LOS ANGELES',
  seed: 101,
  spawnU: 0.0,
  laps: 3,
  record: '2:52:40',
  // The kit's LA set is switched off and rebuilt in landmarks() below. The hillside letters are
  // this city's primary landmark and the kit's version is a 128 px alpha decal painted onto a
  // 34-metre-per-quad plane; the hill and the sign both have to be modelled to carry a frame.
  // The other two pieces of that set — the freeway you pass under, the deco tower on the big
  // corner — are re-placed from the same kit functions, unchanged.
  landmarkSet: null,
  // §8's landmark capture. The kit's default frames the hillside letters down the boulevard — but
  // those are already dead ahead in every chase capture, so the one dedicated landmark frame is
  // spent on the half of the city the chase camera never reaches: the four-level stack overhead,
  // the flood channel down the right kerb, and downtown in the haze at the end of it.
  landmarkU: 0.620,
  look: {
    accent: '#ff7a1e',
    lampColor: '#ffcc86',
    /**
     * A DRY road with a grazing sheen, which is not the same thing as `wet: 0`.
     *
     * §1.1's midday reference road is "dark near-black asphalt, wet-looking with a broad specular
     * sheen" — that sheen is the sky sitting in the asphalt at glancing angles, and it is present
     * on a bone-dry road at any hour. At `wet: 0` the atmospherics pass' reflection term drops to
     * its 0.075 floor and nothing at all comes back off the far half of the carriageway, so LA's
     * road had no idea what colour the sky above it was — a large part of why the frame read as a
     * day sky stitched onto a night ground.
     *
     * 0.10 with the cone held tight is the sheen and not a mirror: the derived Schlick exponent
     * stays at its dry 4.8 so only the far, most-grazing third of the road picks anything up, and
     * the threshold stays high enough that only the sky and a genuine specular hit clear it. The
     * previous round's mistake was the opposite one — `wet: 0` but on the SHARED defaults, which
     * had the widest smear in the game — and that is exactly why `wetLook` is spelled out here
     * rather than left derived.
     */
    wet: 0.10,
    // (round 3, per-city grade) threshold 0.90 -> 0.44, strength 0.16 -> 0.22, gain 1.22 -> 1.35.
    // The threshold is in exposure-normalised units and LA's derived exposure is 0.55-0.6, so at
    // 0.90 the brightest thing this city owns — the turquoise sky itself — arrived at the test at
    // ~0.22 and NOTHING ever cleared it: the sheen was authored, derived, and then measured at
    // zero contribution on every capture. 0.44 is the number at which the sky and the sunlit
    // stucco clear it and a merely-lit road surface does not. 0.16 (tried, r3 interim) put the
    // palms and the storefronts in the carriageway as a full wet mirror at six in the evening,
    // which is Miami's and Vegas's look, not this one — see shots/r3-la-c. What is left is a
    // grazing sky sheen on the far third of the road (the Schlick exponent stays at its dry 5.2)
    // and nothing at all in the near field.
    wetLook: {
      strength: 0.22, spread: 0.010, gain: 1.35, threshold: 0.44, knee: 0.34,
      patch: 0.88, patchScale: 0.060, fresnel: 5.2, band: 0.40,
    },
    /**
     * MEASURED, not assumed. The sky dome is a 3400 m sphere carrying an equirect gradient whose
     * stops sit at 90 deg (`top`), 14 deg (`horizon`) and 0 deg (`haze`) — but the chase camera's
     * 62 deg vertical FOV, pitched down onto the road, only ever sees the band between about 2 and
     * 28 degrees. Painting the dome with pure red / green / blue stops and sampling the frame
     * settles it: EVERY sky pixel in a driving frame comes out of the `horizon` stop, `top` is
     * invisible (it survives only in the PMREM the car paint reflects) and `haze` is hidden behind
     * the ridge line.
     *
     * So `horizon` IS the sky colour, and it is the turquoise. The warm half of the complementary
     * pair cannot come from a gradient stop that never renders — it comes from three things that
     * do: the sun's own radial glow (a 75 deg wedge of `sunColor` composited over the turquoise,
     * so the sky is warm toward the sun and cold away from it), the smog band mesh built in
     * landmarks(), and the ochre fog every distant layer dissolves into.
     *
     * COHERENCE PASS — "one city, one time of day". Three numbers here were the other half of the
     * three-skies fault (see `smogBandTexture`):
     *
     *   sunColor  #ffc07e -> #b1703f. `skyCanvas` composites this as a radial wedge 75 degrees
     *             across with `lighter`, at alpha 0.8 near the disc and 0.13 over most of the
     *             wedge. At (255,192,126) that wedge ADDS up to (33,25,16) across the entire
     *             visible sky whenever the camera turns toward the sun, which is what took the
     *             turquoise to h13 orange in the drift capture; at (177,112,63) it adds (23,15,8),
     *             a warming rather than a repaint. The disc still reads as a sun because the disc
     *             itself runs at alpha 0.95.
     *   horizon   #31c8ae -> #34bfa9. This stop IS the sky in a driving frame, and a 61%-saturation
     *             tropical cyan at l49 is a midday colour whatever else is in the picture — but
     *             only just: taking it to #3ab3a4 alongside the smog change measured as having
     *             removed the turquoise from the city altogether, so it comes back most of the way.
     *             LA at six o'clock is turquoise THROUGH SMOG, and the smog is the layer's job.
     *   clouds    0.34 -> 0.12. The dome's painted fbm cloud field is baked at fixed azimuths, so
     *             it is by construction a different sky in every heading — and this city already
     *             carries 26 parallaxing cloud cards at 1150-2150 m that do the job properly. The
     *             dome keeps just enough to stop the gradient reading as a flat wash.
     */
    sky: {
      /**
       * ROTATED OFF THE GREEN SIDE OF CYAN (grade-discipline round 2), and this is the consequence
       * of taking the rose out of `grade.uLift` — it exposed what the sky underneath had always
       * been doing.
       *
       * '#34bfa9' is hue 171: turquoise, but on the GREEN side of cyan. Everything this city adds
       * on top of the dome is warm and ADDITIVE — the sun glow wedge, the smog band, the ochre
       * aerial-perspective haze — and ochre plus a green-side turquoise is green, not teal. Round
       * 1's rose lift was rotating that back by brute force; with the lift now near-neutral the
       * first capture came back with a frankly green sky, a green-grey road (rgb 63,90,77, hue 150)
       * and mint storefronts.
       *
       * The fix belongs in the light, not the grade. horizon 171 -> 184 and top 185 -> 193 put the
       * dome on the BLUE side of cyan, so the same warm additive layers land on it as a warm-grey
       * teal instead of as green, and §1.1's "deep saturated cyan-blue" is what the sky actually
       * is rather than what the grade was pretending it was. Saturation and value are held (s0.57
       * l0.48 -> s0.59 l0.47), so the turquoise LA is supposed to own is not traded away.
       */
      top: '#0d7f9e', horizon: '#31b3bd', ground: '#6b4a30',
      // (grade-discipline pass) sunColor #b1703f -> #6f4c33. `skyCanvas` composites this as a
      // radial gradient of radius h*0.42 — SEVENTY-FIVE DEGREES — with `lighter`, at alpha 0.8 at
      // 4° from the disc and 0.13 out at 26°. LA's sun sits at 16° elevation, so the whole upper
      // quarter of the frame is inside that wedge whenever the camera points anywhere near the
      // sun's azimuth, and at (177,112,63) it repainted turquoise sky orange. That is the single
      // largest remaining term in "cyan down the boulevard, orange in the drift": measured on the
      // drift capture, the top-left corner ran hue 32 while the top-right corner of the SAME frame
      // ran hue 172.
      // At (111,76,51) the same wedge is a warming rather than a repaint. The sun still reads as a
      // sun, because the disc stop runs at alpha 0.95 and because the smog inversion and the ochre
      // fog both pile up on the same side of the sky — the difference is that they do it at every
      // heading and this term does not.
      haze: '#ff9c52', sunDir: [-0.30, 0.33, 0.91], sunColor: '#6f4c33', clouds: 0.12, seed: 101,
    },
    // Sun azimuth 108 deg — broadside to BOTH long straights, and that is the whole point.
    // Round 1 put it down the road axis: the specular glitter path then runs straight up the
    // carriageway into the lens and detonates on the hero car, and every hillside and facade in
    // frame is lit flat-on, which is what turned the mid-ground into one orange wash. Raking
    // across the route instead, the same sun sculpts: one flank of every car and every stucco
    // parapet lit, the other in mauve shade, palm shadows striped across the carriageway, and the
    // ridge modelled by its own canyons. Elevation 16 deg gives shadows four times the height of
    // whatever throws them.
    /**
     * DAYLIGHT RIG — rebalanced in the per-city grade pass, and this is the fix for the one gap
     * the whole-game critic named: "the only DAY city is the darkest frame in the game".
     *
     * Measured over the twelve LA captures: meanLum 0.228 against Miami 0.382, NYC 0.320 and
     * Vegas 0.336, with 53.5% of the non-HUD frame under luma 0.16. The sky, the hills, the
     * stucco and the skyline were all bright; the road and the off-road plane were night. That is
     * two stitched exposures, not one graded picture.
     *
     * It was not the grade — it was the RATIO. A 16-degree sun casts shadows three and a half
     * times the height of whatever throws them, so on a boulevard walled by 22–82 m blocks most
     * of the ground in any given frame is in shade, and everything in shade was lit by hemisphere
     * 0.94 + fill 0.44 + omni 0.62 against a key of 4.05 — about a 1:5 shade-to-key ratio, which
     * is a clear-sky-no-atmosphere number. Los Angeles in August is a hazy basin: the sky is a
     * 180-degree turquoise softbox and the ground bounces ochre back up into everything, and the
     * real ratio at golden hour is nearer 1:2.5.
     *
     * So: hemisphere ×2.2, fill ×1.6, the omni floor ×1.7, and the key comes DOWN 12% to pay for
     * part of it. The sun is still far and away the key — one flank of every car and every parapet
     * is still lit and the other is still in shade, palm shadows still stripe the carriageway —
     * but the shade now has the sky's colour in it instead of being a hole.
     *
     * (Why the key has to come down at all: engine.applyLook derives exposure by normalising
     * `sun*0.8 + ambient*0.5 + fill*0.3`, so raising the fills alone buys back less than it
     * spends. Trading 0.50 of key for 1.16 of hemisphere lands the same derived exposure with
     * two and a bit times the light in the shadows.)
     */
    /**
     * ROUND 3 — THE KEY:FILL RATIO ON THE GROUND, which is the r2 critique's one named gap:
     * "18.3% of LA's road band is effectively achromatic (sat < 0.10) against 0.2-0.7% in the
     * other three ... a dead-neutral grey slab under a saturated sunset sky."
     *
     * Ablated on the real build (`tools/_gd3_ab.mjs`, road band 80,420-700,880 of the chase
     * frame): on the r2 rig the LIT quartile of the carriageway measured h206 s0.10 with 48% of
     * its pixels under sat 0.10, and the SHADE quartile h201 s0.31 — the sun was not the light on
     * the road at all, and lit and shaded asphalt were the same hue to within a degree. The
     * arithmetic says why. A 16-degree key delivers sin(elev) = 0.28 of its intensity to a flat
     * surface while a hemisphere delivers all of its own to every up-facing one, so at key 3.75 /
     * hemisphere 2.00 the road was lit by 1.05 of warm against 2.0+ of cool. Turquoise light plus
     * a warm key that cannot outrun it is grey.
     *
     * key 3.75 -> 8.00 and elevation 16 -> 19 degrees puts 2.6 of warm on the road against the
     * hemisphere's 3.0, and `applyLook`'s exposure normalisation (auto = (2.55/key)^0.52, floored
     * at 0.55) takes the frame straight back down — so this is a RATIO change, not a brightness
     * one. The elevation move is small on purpose: 19 degrees still throws palm shadows three
     * times the height of the palm, which is the thing that stripes this carriageway.
     *
     * Measured after: lit h16 s0.35, shade h199 s0.26, road-band pixels under sat 0.10 from 32.7%
     * to 4.8%, and the only cool things left on the carriageway are the palm shadows.
     */
    sun: { color: '#ffc586', intensity: 8.00, dir: [-0.30, 0.33, 0.91] },
    /**
     * THE THREE-SKIES FAULT, and this is the term that was actually producing it.
     *
     * Measured over six `--u` stills round the lap plus the twelve sweep captures, the top of the
     * LA frame ran hue 22 / 30 / 35 / 54 / 78 / 116 / 159 with lightness 18 to 53 — an orange sky,
     * a green sky and a turquoise sky in the same city. Previous rounds looked for it in the dome
     * and in `smogBandTexture`, and both are only worth a few code values at the elevations a
     * driving frame actually samples (the band is 10-12 % opaque above 20 degrees).
     *
     * It is the ATMOSPHERE PASS. `engine.applyLook` derives `uSunGlow` as
     * `clamp((sunI - 0.9) * 0.30, 0, 0.85)` and the shaft strength as
     * `clamp((sunI - 1.1) * 0.55, 0, 1.25) * (0.45 + 0.55 * lowSun)`. LA's key is 3.75 at 16
     * degrees elevation, so both saturate: glow 0.85 (the ceiling) and shafts 1.06. In `post.js`
     * that lands as `col += hazeCol * pow(sunAlign, 3.0) * uSunGlow * 0.18` — a wedge of warm ochre
     * up to 0.15 in strength, added to EVERY pixel including the sky, whose amount is a pure
     * function of which way the camera is pointing. Turquoise plus that wedge is the green sky;
     * turquoise plus the wedge plus the shaft blur is the orange one; turquoise without it (the
     * landmark framing, which faces across the sun) is the one that was right.
     *
     * These numbers keep the god rays §6.5 asks a low-sun day city for — the shaft pass is still on
     * at 0.45, and it is a directional streak through the palms rather than a flat wash — while
     * taking the omnidirectional repaint down by a factor of eight. The sun still warms its own
     * half of the sky, because `skyCanvas`'s glow disc and the smog band both still do that; they
     * just do it by about a fifth of a stop instead of by a hue rotation.
     *
     * RE-VERIFIED round 3, and this time against SKY PIXELS rather than against the top of the
     * frame. `tools/_gd3_sky.mjs` renders each position twice — once normally, once with every
     * unfogged backdrop layer (dome, smog band, cloud cards, range curtains) hidden — and keeps
     * only the pixels that came back black, i.e. the ones where sky and nothing else was on
     * screen. Over eight lap positions spanning 160 degrees of heading, the top tenth of the frame
     * measures h189 / h188 / h187 / h188 / h189 / h188 at the six positions where it is visible in
     * quantity: a two-degree spread, one sky. The two that read warm are u=0.28 (yaw 21 deg, the
     * sun's own 75-degree wedge fills the upper left — h33) and u=0.14, where 0.4% of the frame is
     * sky at all and it is the ochre haze band under the freeway deck. A sun that warms its own
     * side of the sky is a sun; the fault this note is about was the sky changing hue with heading
     * everywhere, and it is gone.
     */
    shafts: { strength: 0.45, glow: 0.10 },
    ambient: {
      // The hemisphere IS the turquoise sky as far as every up-facing surface is concerned, and
      // it is the term that has to reach the carriageway and the off-road plane. Desaturated a
      // little on the way up: at 2.10 the old #8fd2e6 tipped grey asphalt frankly green.
      // (grade-discipline round 2) hue 194 -> 202, same value, for the same reason as the dome
      // above: this hemisphere IS the light on the carriageway and on every up-facing surface, and
      // with the warm rose gone from the grade it was the term deciding whether asphalt reads
      // grey-blue or green-grey. Measured on the road patch, 63,90,77 (h150) before, and green is
      // not a colour Los Angeles asphalt comes in.
      // (round 3) '#a3cfe8' 2.00 -> '#4fb0ea' 3.00, i.e. the same light, half again as much of it
      // and half again the chroma. With the key now at 8.00 this term stopped being what lights
      // the whole ground and became what lights the SHADED ground, which is a different job: it
      // has to be saturated enough to survive both the road's own unlit emissive floor (track.js
      // gives the carriageway `emissiveMap` = a copy of its albedo at 0.34, an achromatic pedestal
      // that ablation measured as worth 19 points of the road's mean saturation on its own) and
      // the warm bounce below. Measured on the shade quartile of the road: h201 s0.18 at the old
      // colour and intensity, h199 s0.26 at this one.
      sky: '#4fb0ea', ground: '#8f6a4c', intensity: 3.00,
      // fill from the anti-sun side, carrying the turquoise zenith into the shaded flank. Down
      // with the rest of the fills (0.76 -> 0.32): it is a second cool term on surfaces the
      // hemisphere already reaches, and at 0.76 it was half of what was greying the lit road.
      fill: { color: '#8ec8ea', intensity: 0.32, dir: [0.34, 0.40, -0.88] },
    },
    // Rose bounce in the shade. Two jobs: it is the omnidirectional floor that keeps a wall
    // facing away from BOTH the sun and the sky off zero, and it is the city's shadow signature.
    // Rotated warm off the old mauve because the four cities were landing 207-263 deg — all of
    // them blue-to-violet — so shadow hue was measuring as a shared grade artefact rather than as
    // four separate places. Miami keeps cyan, NYC blue, Vegas violet; the day city takes the warm
    // rose that a golden-hour bounce off ochre hillside and warm stucco actually is.
    shadowTint: '#6f5a72',
    // 0.90 -> 0.28 (round 3, per-city grade). The last round raised this to keep the kit's 6 km
    // ground plane off flat-colour where the storefront row shadows it — "luminance sd of 2.7-4.2
    // over 300x200 blocks at rgb(36,43,44)". That fault is now paid for by the term that should
    // have been paying for it: the ground plane faces UP, so the hemisphere at 3.00 reaches it in
    // full, and it now sits at ~1.5x the light it had at hemisphere 2.00 + floor 0.90 while
    // carrying the sky's colour instead of a flat omnidirectional wash. Which matters because an
    // omnidirectional AMBIENT is the one light in the rig that cannot be a hue: it lands on the
    // sunlit road and the shaded road equally, so every code value it adds is a code value of
    // achromatic pedestal on top of the emissive one — a rose ambient against a turquoise
    // hemisphere is grey, and grey on the road is the fault this round exists to fix. It stays
    // non-zero, and it stays rose, because a wall facing away from BOTH the sun and the sky still
    // has to be a surface and LA's bounce still comes off ochre hillside and warm stucco.
    shadowFill: 0.28,
    /**
     * Smog, and enough of it to matter — but MEASURED against where the camera actually stands,
     * not against where the landmark was sited.
     *
     * The hillside letters sit 660 m down the axis from the point the landmark framing is built
     * from, which sounds close. From the chase camera at the near end of the boulevard they are
     * 780 m out and the crest behind them is 1050 m: at far=1600 that is 43% and 62% dissolved,
     * and a hill 60% dissolved into flat ochre cannot be given detail by any amount of texture or
     * geometry — measured, a tenfold change in its albedo moved the rendered pixel by four levels.
     * Round 2's "the hills are effectively untextured" was this number, not a missing map.
     *
     * At far=2100 the same two bands come back to 31% and 46%, which still reads as heavy smog and
     * still separates every layer: mid buildings ~0%, the hero ridge 31%, downtown 30-43%, the
     * skyline ring 51%, and the two mountain curtains and the smog band beyond it are unfogged
     * meshes carrying their own baked haze, so the far end of the stack does not move at all.
     */
    fog: { color: '#e8c096', near: 175, far: 2100 },
    // The second half of the same fix. `groundTexture` builds its "broad patches of a second
    // surface" from `accent`, and with no accent named it falls back to `tint * 0.72` — i.e. the
    // patches are the same colour 28% darker, which is the one kind of variation that disappears
    // completely once the surface is in shadow. LA's off-road ground is dirt lots WITH concrete
    // parking aprons on them, so naming the apron gives the plane a second surface that differs in
    // hue as well as value and survives being lit by nothing but bounce.
    // (round 3) '#cbbfa4' -> '#c0a276'. The accent is the concrete-apron half of the plane, and
    // under the freeway deck — where the key light never reaches and the only term left is a
    // blue-ish hemisphere — a 19%-chroma warm grey cancels to a neutral: the shoulder under the
    // overpass measured rgb(55,58,54) at saturation 0.069, i.e. "just gray", which §2.1 calls an
    // explicit failure and which is the largest single surface in the la-suv drift capture.
    // 38% chroma is still a concrete apron in the sun and it still reads as a second surface
    // against the dirt, but it cannot cancel to neutral in the shade.
    // `shade` lifts the same plane's self-lit floor from the shared 1.7 to 2.1 for the same
    // reason: the floor is what carries material into a surface nothing is lighting.
    ground: { color: '#86735a', accent: '#c0a276', shade: 2.1 },
    sidewalk: '#b3a893',
    grade: {
      /**
       * THE NEUTRAL ANCHOR. r2 took this to 1.22 (it asks `applyLook` for 1.10 after its ×0.90 and
       * its 1.02-1.30 clamp) on the argument that a daylight city is saturated enough already.
       * Measured across the twelve-frame sweep that turned out to be the wrong way round: LA came
       * back with the LOWEST mean pixel saturation of the four cities — 0.403 against Miami 0.490,
       * NYC 0.483 and Vegas 0.469 — because the one city whose largest surface is lit by two
       * complementary sources is the one city where those sources cancel to grey. 1.34 asks for
       * the 1.206 end of the same band.
       *
       * `uVibrance` is the more useful half and it is new here: it is applied `1 - smoothstep(0,
       * 0.55, sat)`, i.e. only to pixels that are ALREADY near-neutral, which is precisely the
       * road band this round is about and precisely not the turquoise sky, the ochre hills or the
       * mint hero car. 0.22 (the derived day default) -> 0.40 moved the road band's mean
       * saturation 0.32 -> 0.36 and its under-sat-0.10 share 5.6% -> 4.8% while leaving the
       * frame's saturated half where it was.
       *
       * uExposure 1.05 -> 1.30 pays back what the key:fill change above spent: `auto` is now at
       * its 0.55 floor (key 8.0), so the trim is what puts the frame mean luma back at 86.5 —
       * a day city that is finally the brightest frame in the game rather than the darkest.
       */
      uSaturation: 1.34, uVibrance: 0.40, uExposure: 1.30,
      /**
       * CONTRAST AND BLACK POINT — the other half of "the day city is the darkest frame".
       *
       * The grade chain runs an S-curve (`uContrast`) and then a toe (`uBlackPoint` biases both
       * its exponent and the true black it subtracts) as the last two things before the sRGB
       * encode. Both are calibrated for a NIGHT frame, where the job is to keep asphalt between
       * neon reflections at zero. Traced with real numbers: a sunlit LA carriageway arrives at
       * the S-curve near 0.027 linear, comes out of it at 0.011, and the toe then multiplies THAT
       * by 0.11 — a 9x cut applied to the largest surface in the frame. Ninety percent of the
       * road's value was being removed after the lighting was already correct.
       *
       * 1.14 -> 1.02 takes the derived S-curve from 1.267 (all but the 1.34 ceiling) to 1.14, and
       * uBlackPoint 0.60 takes the toe exponent from 1.30 to 1.08 and the subtracted black from
       * 0.0058 to 0.0035. Neither switches anything off: the frame still has a true black point
       * (measured pure-black area stays under 0.1%) and the darkest 1% still lands in the teens,
       * which is where the reference's day frames sit. What comes back is the band between "true
       * black" and "midtone" — i.e. shadow DETAIL, which is the thing a day city cannot do
       * without. Vegas and NYC keep their harder settings; this is a per-city number and it is
       * supposed to be.
       */
      uContrast: 1.06, uBlackPoint: 0.66,
      // Rose shadows. uLift is a unit-luminance MULTIPLIER on the shadow band, so this is a hue
      // rotation with no brightness cost — and now that the shadows carry real light it survives
      // to screen as chroma instead of as a two-code-value difference in a near-black. Matched to
      // `shadowTint` above so the scene light and the grade agree about what colour LA's shade is.
      // …and the same rotation, at a quarter of the chroma. `applyLook` normalises this hex by its
      // own LUMINANCE before using it as a multiplier on the shadow band, and the band is still
      // half-strength at mid-grey — so '#2e1b30' was arriving as (1.380, 0.843, 1.436), a 16% green
      // cut across everything dark in the frame. That is a rose PAINT on albedo, not a rose shadow:
      // it is what took the neutral-mauve mountain ranges to pink (see the two `mountainRange`
      // calls) and it is the LA end of the four-city measurement that had the same mint car
      // photographing at hue 172 / 197 / 253 / 323 in the four cities. '#7a6574' normalises to
      // (1.133, 0.952, 1.082): still unmistakably the warm rose that a golden-hour bounce off ochre
      // hillside is, but the shade is now a hue the light explains rather than a hue the grade adds.
      uLift: '#7d637a', uGain: '#ffe6c6', uVignette: 0.22,
    },
    bloom: { strength: 0.88, radius: 0.60, threshold: 0.74 },
  },
  track: {
    width: 11,
    // Tint lifted from #2b2c31: the generator lays real aggregate, pale chippings, tar-seamed
    // resurfacing patches and polished wheel tracks into this surface, but every one of them is a
    // MULTIPLIER on the base colour, and at #2b it all multiplied down into a near-black plane.
    // A sun 16 degrees off the deck rakes across asphalt and lifts it toward warm grey anyway.
    // (coherence pass) …and lifted again, and WARMED. Measured across the sixteen-frame set, LA's
    // near carriageway came back at rgb(20,20,18): the darkest surface in a frame whose sky, hills,
    // stucco and sidewalk were all bright — a neutral-grey night road under a golden-hour sky.
    // #3a is 0.043 in linear, which is a darker albedo than coal; real asphalt is 0.10-0.15, and a
    // 16-degree sun rakes it warm. This is that number, with the blue bias (#3a38**3c**) taken out.
    // (grade pass) #4a45 -> #5d56, i.e. 0.068 -> 0.105 linear: the bottom of the real asphalt band
    // rather than a fifth of the way below it. The road is the single largest surface in every
    // frame of the one DAY city, so its albedo is the highest-leverage number in this file for the
    // "57% of the frame under luma 0.16" measurement — and a boulevard that has been bleaching in
    // the sun since the 1930s is not fresh-laid binder. Everything the generator draws on top
    // (aggregate, chippings, tar seams, polished wheel tracks) is a multiplier, so they all get
    // proportionally more room to show as well.
    // (round 3) '#514f4c' -> '#634f40'. Two reasons, and neither is "make it browner".
    // 1. `roadSurfaceTexture` writes this colour into the albedo map AND `buildRoad` hands the
    //    same canvas back as the material's `emissiveMap` at intensity 0.34 — an unlit pedestal
    //    that no light in the rig can tint. Ablating it (roadEmissive 0) moved the road band from
    //    32.7% of pixels under sat 0.10 to 13.9% and its mean saturation from 0.24 to 0.32, so on
    //    a NEUTRAL tint that pedestal is a grey wash over the largest surface in the frame. The
    //    only way to give it a hue from a city file is to give the albedo one.
    // 2. h27 s0.35 is the hue the sun is, so the albedo reinforces the key on lit asphalt and
    //    fights the hemisphere on shaded asphalt — which is exactly the separation this round
    //    wants. Pushed further (tried: '#5f4f41' at hemisphere 1.32) the shade quartile lost its
    //    cyan altogether and came back h52 s0.05; pulled back to neutral the LIT quartile went
    //    h351 s0.09. This is the balance point, measured either side.
    // (COHERENCE PASS) '#634f40' -> '#5b524a'. The reasoning in the round-3 note above is sound
    // and its measurement was honest; the number it landed on was not. h27 s0.35 at 0.105 linear
    // is the albedo of DIRT, and it is the only carriageway in the game that has one — Vegas runs
    // '#191720', NYC '#1e2026', Miami '#2d3037', all of them within a few degrees of neutral. Over
    // the sixteen-frame set that made LA the one city whose road is not made of the same material
    // as the other three: measured on the chase frame's road band, rgb(78,64,57) h20 s0.38, and on
    // the landmark and crash framings the carriageway, the sidewalk, the dirt lot and the hillside
    // all arrive within a few code values of each other — one continuous ochre surface with lane
    // paint drawn on part of it.
    //
    // The trap the round-3 note fell into is real and this number is measured against it
    // (tools/_coh6_road.mjs, road band 120,430-760,860, lit/shade quartiles taken separately):
    // a NEUTRAL road under this rig is not grey, it is BLUE — hemisphere '#4fb0ea' at 3.00 lands
    // its whole intensity on an up-facing surface while a 19-degree key delivers sin(19) = 0.33 of
    // its own, so at tint '#4a4a4e' the lit quartile came back h252 s0.30. The albedo has to carry
    // some warmth to meet it. It just has to carry a ROAD's worth and not a hillside's:
    //
    //   '#634f40'  lit rgb(119,85,69) h19 s0.44   shade h197 s0.38   band rgb(78,64,57)  ← dirt
    //   '#4a4a4e'  lit rgb(85,81,105) h252 s0.30  shade h211 s0.60   band rgb(54,61,83)  ← blue
    //   '#5b524a'  lit rgb(105,90,90) h358 s0.25  shade h203 s0.50   band rgb(68,68,72)  ← asphalt
    //
    // The last one is the only one of the three whose road band is achromatic overall while its
    // lit and shaded quartiles still separate warm from cool — which is what asphalt under a low
    // sun looks like, and it is the same relationship the other three cities' roads already have.
    // Band luminance is unchanged (L0.269 against L0.263), so this does not re-open "the only DAY
    // city is the darkest frame in the game": it is a hue change, not a brightness one.
    surface: { tint: '#5b524a', lanes: 3, centerLine: 'double-yellow', worn: 0.78 },
    bank: 0.05,
    crossings: 8,
    sidewalkWidth: 5.2,
    // THE DIRT LOT. LA's off-road ground is decomposed granite and dry weeds over the same warm
    // brown the ground plane is generated from, so the run-off dissolves into it without a line.
    runoff: {
      width: 16, tint: '#86735a', accent: '#a08b6c',
      gravel: '#c0ae8e', scrub: '#8a8046', rock: '#9b9081',
      // ...but NOT down the flood-channel side. The channel floor is poured from 23.4 m out at
      // y -0.06, and the verge would cross it within a centimetre — a §7 z-fight (cap 60) down
      // 700 m of the lap. The concrete is the ground there; it does not want a dirt edge.
      mask: (u, side) => (side > 0 && u > 0.440 && u < 0.798 ? 0 : 1),
    },
    // 610 m of dead-straight boulevard (the frame the hillside letters close), a long right-hand
    // sweeper that keeps tightening, a 150 m-radius double-apex at the far end, a fast kink, the
    // flood-channel run with a river bend in the middle of it, a constant-radius sweeper, then a
    // tight left onto the home straight. Nothing on the lap is under 129 m radius, and the first
    // 600 m are straight, so the scripted control captures never end up pinned on a barrier.
    main: [
      [0, 0], [160, -6], [320, -13], [480, -20], [640, -30],
      [762, -80], [834, -184], [844, -296], [798, -392],
      [704, -448], [596, -458], [502, -430], [414, -424], [314, -448],
      [196, -482], [76, -514], [-38, -494], [-132, -438],
      [-232, -396], [-330, -330], [-400, -244], [-428, -146],
      [-410, -52], [-338, 20], [-238, 56], [-138, 42], [-56, 16],
    ],
    branches: [
      // a construction flyover cutting the double-apex
      { kind: 'ramp', enterU: 0.330, exitU: 0.430, width: 8.5, rise: 8, points: [[800, -350], [720, -420]] },
      // out through the broken parapet and down the concrete flood channel — the LA shortcut
      {
        kind: 'shortcut', enterU: 0.520, exitU: 0.700, width: 8.5,
        points: [[283, -491], [167, -526], [30, -545], [-99, -497], [-149, -467]],
      },
      // an alley cut behind the strip mall on the run home
      { kind: 'shortcut', enterU: 0.855, exitU: 0.930, width: 6.5, points: [[-360, -30], [-290, 10]] },
    ],
  },
  blocks: {
    spacing: 33, offset: 30, jitter: 9, spacingJitter: 0.34,
    minW: 16, maxW: 34, minH: 22, maxH: 82,
    wallColors: ['#e2cda6', '#b6c9c2', '#c79b7c', '#efe1c6', '#a8bcbe'],
    // Golden-hour glazing, not navy. Round 1's window openings read as black holes punched in the
    // stucco because the glass tint was a night-blue that the 16-degree key never reaches; at this
    // hour a west-facing pane is a sheet of reflected sunset and an east-facing one is a pale
    // turquoise sky. Three tints spread across the block band gives both, and neither is black.
    glassColors: ['#4f7d90', '#6f8f9a', '#b8875a'],
    litColors: ['#ffd9a0', '#ffc478'],
    neonColors: ['#ff3b30', '#ffb020', '#2fd8e0', '#ff2f6d'],
    // Half the strip is warm stucco and half is the mint / aqua / seafoam that mid-century LA is
    // actually painted, which is where the frame's cool half comes from at street level.
    lowColors: ['#f2e6cc', '#6fc2bd', '#e9c3a2', '#bfdcd6', '#f2d2ba', '#8fcfc4'],
    signs: ['TACOS', 'DONUTS', 'LIQUOR', 'CARNICERIA', 'MOTEL', 'LAUNDRY', 'SMOG', 'MARISCOS',
      'BURGERS', 'CAR WASH', 'THRIFT', 'TAQUERIA', 'PAWN', 'CHOP SUEY'],
    litRatio: 0.28, setbackChance: 0.42, accentChance: 0.20, fireEscapeChance: 0.10,
    lowStyle: 'stucco',
    /**
     * LA is a low city with a downtown edge, not a canyon. Most of the route is one- and
     * two-storey stucco, which is both the truth and the thing that lets the ridge, the
     * interchange and the downtown massing stay visible over the rooflines from the road.
     */
    pick: (r, s, side) => {
      const u = ((s.u % 1) + 1) % 1;
      if (u > 0.445 && u < 0.79 && side > 0) return 'none';          // the flood channel is here
      if (u > 0.705 && u < 0.772) return 'none';                     // the freeway right-of-way
      if (u < 0.20 || u > 0.95) {                                    // the downtown end
        // North kerb: strip mall and used-car lot, nothing tall — the hillside letters close
        // this straight and a tower on that side would wall them off.
        if (side > 0) return r.bool(0.82) ? 'low' : 'none';
        return r.bool(0.52) ? 'tower' : 'low';
      }
      return r.bool(0.84) ? 'low' : 'tower';
    },
  },
  props: {
    lampStyle: 'modern', lampSpacing: 37, lampHeight: 10.5, lampTwin: true,
    lampBanners: ['#ff7a1e', '#2fd8e0', '#ff2f6d'],
    palms: false,                       // placed below, as a proper avenue of Washingtonias
    trees: false,
    barriers: false,
    powerLines: true, powerLineSide: -1, powerLineSpacing: 47, powerLineHeight: 12,
    hydrantColor: '#f2c21e',            // LA hydrants are yellow
    planterColor: '#b9ab92',
    treeColors: ['#57703c', '#6a7a3e'],              // dusty olive only — see furnitureKinds
    streetNames: ['SUNSET BLVD', 'VINE ST', 'LA BREA', 'ALVARADO', 'FIGUEROA', 'MULHOLLAND', 'CAHUENGA'],
    carColors: ['#b8332f', '#2f4f8f', '#cfc9bd', '#2a2c30', '#d8a028', '#5d6d5a'],
    // NO 'tree'. The kit's broadleaf is three flat-shaded icosahedra on a stick — at h=8 that is a
    // 2.4 m untextured facet ball, and with LA's jacaranda purple in `treeColors` it landed in the
    // round-1 landmark frames as a flat blue polyhedron floating over the road. LA's street tree
    // is the Washingtonia, which this file builds itself; the verge keeps everything else.
    furnitureKinds: ['hydrant', 'trash', 'bench', 'newsbox', 'sign', 'planter', 'cones',
      'dumpster', 'shelter', 'mailbox', 'bollards', 'scaffold', 'cart'],
    // ...and the kit's parked cars are switched off: landmarks() places lofted ones instead.
    parkedCars: false,
    furnitureGap: [10, 30],
    scaffoldChance: 0.20,
    billboards: [
      { u: 0.048, side: 1, text: 'SUNSET', sub: 'BOULEVARD', color: '#ff2f6d', offset: 27, legs: 11 },
      { u: 0.245, side: -1, text: 'TACOS', sub: 'ABIERTO 24 HRS', color: '#ffb020', offset: 24 },
      { u: 0.420, side: -1, text: 'SMOG', sub: 'CHECK TODAY', color: '#2fd8e0', offset: 22 },
      { u: 0.610, side: -1, text: 'MOTOR', sub: 'INN VACANCY', color: '#ff3b30', offset: 25, legs: 10 },
      { u: 0.835, side: -1, text: 'STUDIO', sub: 'BACKLOT TOURS', color: '#ffb020', offset: 23 },
    ],
    boostPads: [
      // NB: keep the first pad early. cityLandmarks() frames the hillside sign from the LAST point
      // on the long straight that is clear of a pad or a gate, and it hangs the freeway overpass
      // 150 m up the road from there — put a pad mid-boulevard and that overpass lands on top of
      // the chase camera instead of sitting in the middle distance where it belongs.
      { u: 0.075, lateral: 0 }, { u: 0.265, lateral: 0.42 },
      { u: 0.400, lateral: -0.35 }, { u: 0.615, lateral: 0.3 },
      { u: 0.790, lateral: -0.3 }, { u: 0.925, lateral: 0 },
    ],
  },
  skyline: {
    // Sprawl to the horizon rather than a wall of towers: low, wide and very hazy. The tall
    // punctuation is the downtown cluster placed in landmarks(), at a fifth of this distance.
    radius: 1150, count: 96, minH: 34, maxH: 155, spread: 360,
    palette: ['#7d7a80', '#8a7f78', '#6d707e'], accent: '#ffb070',
  },

  landmarks({ track, rng, night }) {
    const out = [];
    // Everything below is collected rather than added: ~1,900 little meshes come out the other end
    // as ~120 chunked buffers. See Merger at the top of this file.
    const M = new Merger(300);
    const HILL_MICRO = hillMicroMaps();     // one micro-relief pair for all seven hillsides
    const R = rng.fork ? rng.fork(7) : rng;
    const HW = track.halfWidth;

    // ---- shared materials: three concretes, two steels, one water, one atlas each for tags and
    // stains. Everything below shares them, so mergeStatic collapses the lot into ~12 draws.
    const structMat = concreteMaterial('#b7b1a4', 31);      // decks, piers, columns
    const channelMat = concreteMaterial('#d8ccb0', 63);     // channel floor, parapet, K-rail
    const bankMat = concreteMaterial('#cdc0a4', 71);        // the batter wall
    const steel = steelMaterial('#4a4e54', 21);
    const railMat = steelMaterial('#8d9098', 39);
    const tarmacMat = concreteMaterial('#3a3630', 97);      // running surface on the viaducts
    const waterMat = new THREE.MeshStandardMaterial({
      color: 0x24423e, roughness: 0.06, metalness: 0.25, envMapIntensity: 3.4,
    });
    const tagTex = graffitiAtlas(511);
    const tagMat = new THREE.MeshStandardMaterial({
      map: tagTex, transparent: true, alphaTest: 0.04, roughness: 0.95,
      depthWrite: false, side: THREE.DoubleSide,
      // per-piece tint, baked into vertex colour by the Merger's remap — still one draw call
      vertexColors: true,
    });
    const stainMat = new THREE.MeshBasicMaterial({
      map: stainTexture(83), transparent: true, color: 0x5f584a, opacity: 0.34, depthWrite: false,
    });
    // Alpha CUTOUT, not blending: an alpha-tested fence keeps correct depth against the palms
    // behind it and mips down to a soft grey haze at distance instead of sorting badly.
    const linkMat = new THREE.MeshBasicMaterial({
      map: chainlinkTexture(), alphaTest: 0.42, side: THREE.DoubleSide, fog: true,
    });

    // ---- traffic. `carMats.paint` is a TAG: no car is ever drawn with it. The merger's remap
    // hook swaps it for `paintVC` and bakes the car's colour into a vertex-colour attribute, so
    // every painted panel of every car in a chunk — six body colours, five body styles — lands in
    // one buffer and one draw call. See Merger.
    const carCache = new Map();
    const paintVC = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.34, metalness: 0.45, envMapIntensity: 1.0,
    });
    const carMats = {
      paint: new THREE.MeshStandardMaterial({ color: 0xffffff }),
      glass: new THREE.MeshStandardMaterial({
        color: 0x1b2630, roughness: 0.08, metalness: 0.85, envMapIntensity: 1.6,
      }),
      dark: new THREE.MeshStandardMaterial({ color: 0x14151a, roughness: 0.88 }),
      chrome: new THREE.MeshStandardMaterial({
        color: 0x8d929a, roughness: 0.30, metalness: 0.92, envMapIntensity: 1.15,
      }),
      tail: new THREE.MeshStandardMaterial({
        color: 0x6a0e08, emissive: 0xff2a18, emissiveIntensity: night ? 2.2 : 0.75, roughness: 0.4,
      }),
      head: new THREE.MeshStandardMaterial({
        color: 0x9aa4ac, emissive: 0xfff0d8, emissiveIntensity: night ? 1.8 : 0.35, roughness: 0.3,
      }),
    };
    const CAR_PAINT = ['#b8332f', '#2f4f8f', '#cfc9bd', '#2a2c30', '#d8a028', '#5d6d5a',
      '#8c9aa4', '#7c3f6a', '#e2e0d6'];
    const CAR_KIND = ['sedan', 'sedan', 'coupe', 'wagon', 'pickup', 'van'];
    /** Swap the paint tag for the shared vertex-coloured material, wherever a car turns up. */
    const carRemap = (o) => (o.material === carMats.paint && o.userData.tint
      ? { material: paintVC, color: o.userData.tint } : null);
    const makeCar = (rng, kind = null) => streetCar({
      kind: kind || rng.pick(CAR_KIND),
      variant: rng.int(0, 5),
      tint: new THREE.Color(rng.pick(CAR_PAINT)),
      mats: carMats, cache: carCache,
    });

    const push = (geo, mat, { cast = true, receive = true } = {}) => {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = cast; m.receiveShadow = receive;
      M.take(m);
      return m;
    };

    // ================================================================ 0. the sky
    //
    // Three unlit, unfogged layers on the far side of everything else, centred on the middle of
    // the circuit so they parallax correctly as the car works its way round the lap. See the
    // atmosphere-layer block above the city definition for why the sky has to be built as geometry
    // at all. Cost: three draw calls plus one per cloud batch.
    {
      const c0 = new THREE.Vector3();
      for (const s of track.samples) c0.add(s.pos);
      c0.divideScalar(track.samples.length);
      const sky = new THREE.Group();
      sky.position.copy(c0);

      // Far range: the San Gabriels. 780 m at 2.3 km is 19 deg — just clearing the hillside ridge
      // that closes the boulevard, which is the whole point of it. Pale, barely separated from the
      // smog, and it puts a fourth depth band behind a skyline ring that used to be the last one.
      sky.add(mountainRange({
        radius: 2300, height: 430, seed: 17, peaks: 7,
        arc: [SUN_AZ + 0.55, SUN_AZ + 5.05], gap: { at: SUN_AZ + 0.55, half: 0.9 },
        // (grade-discipline pass) rotated off the magenta axis. These three were authored as
        // neutral mauves, but this city's grade runs uGain '#ffe6c6' (a warm highlight gain) over
        // uLift '#2e1b30' (a rose shadow lift), and a neutral mauve through that pair lands on
        // screen as PINK — which is why the landmark capture read "pink/teal dusk" while the chase
        // capture down the same boulevard read "cyan midday". A far range is aerial perspective:
        // it should be the colour of the air between you and it, and the air over this city is
        // turquoise. Slate-blue in, mauve out, and the frame stops claiming a second sunset.
        haze: '#6f7789', lit: '#616c86', shade: '#3f4a6b',
      }));
      // Near range: the Verdugo/Baldwin foothills, warmer and more modelled, close enough that the
      // grazing sun actually separates their lit flanks from their shaded ones.
      sky.add(mountainRange({
        radius: 1680, height: 270, seed: 29, peaks: 9,
        arc: [SUN_AZ + 0.75, SUN_AZ + 5.35], gap: { at: SUN_AZ + 0.75, half: 1.05 },
        // Same rotation as the far range but half of it: these foothills are close enough that the
        // grazing sun genuinely warms their lit flanks, so `lit` keeps its warmth and only the
        // haze and the shade come off the magenta axis.
        haze: '#646370', lit: '#655a58', shade: '#3d4058',
      }));
      sky.add(smogBand({ radius: 2450, height: 1500, seed: 5 }));

      // Cloud bank. Two overlapping cards per cloud at slightly different scales, so the silhouette
      // is never one oval; all of them face the middle of the circuit, which is within a few
      // degrees of every point the camera ever reaches.
      {
        const texes = [cloudTexture(3), cloudTexture(19), cloudTexture(41)];
        const mats = texes.map((t) => new THREE.MeshBasicMaterial({
          map: t, transparent: true, depthWrite: false, fog: false, opacity: 0.48,
          side: THREE.DoubleSide,
        }));
        // Fifty-two cards would be fifty-two draw calls, so they are baked into one buffer per
        // texture. Losing per-card depth sorting costs nothing here: they are soft, unlit, they
        // never write depth, and they are two kilometres away.
        const bucket = [[], [], []];
        const mtx = new THREE.Matrix4();
        for (let i = 0; i < 26; i++) {
          const az = R.range(0, Math.PI * 2);
          const rad = R.range(1150, 2150);
          const y = R.range(230, 640);
          const w = R.range(320, 760) * (rad / 1600);
          const mi = R.int(0, 2);
          for (const [sx, sy, dx, dz, o] of [
            [1, 1, 0, 0, 1],
            [R.range(0.55, 0.8), R.range(0.5, 0.8), R.range(-0.3, 0.3), R.range(-0.2, 0.2), 0.8],
          ]) {
            const geo = new THREE.PlaneGeometry(w * sx * o, w * sy * 0.34 * o);
            mtx.makeRotationY(az);
            mtx.setPosition(Math.sin(az) * rad + dx * w, y + dz * w * 0.2, Math.cos(az) * rad);
            geo.applyMatrix4(mtx);
            bucket[mi].push(geo);
          }
        }
        for (let mi = 0; mi < 3; mi++) {
          if (!bucket[mi].length) continue;
          const bank = new THREE.Mesh(mergeGeometries(bucket[mi], false), mats[mi]);
          bank.renderOrder = -2;
          bank.userData.noMerge = true;
          bank.frustumCulled = false;
          sky.add(bank);
        }
      }
      out.push(sky);

      // ---- the near band: dry knolls, well inside the haze, flanking the boulevard and the
      // long sweeper home. Placed off the kerb by 170-300 m so they sit behind the block line and
      // in front of the hero ridge, and kept off the sightline that closes the boulevard.
      //
      // These are built on the same terrain system as the hero ridge, and it matters more here
      // than it does there: at 250-350 m off the kerb a 480 m knoll subtends twenty degrees, so
      // between them these six ARE the middle of most LA frames. Round 2's version was a 40x30
      // dome — twelve metres per quad — under a texture tiled every forty metres, which is the
      // "smooth peach/brown gradient across roughly half of every frame" the critic measured.
      // Each one now gets its own displaced grid, its own baked albedo sheet with the sun
      // occlusion and the scrub in it, and its face turned to look back at the road.
      {
        const SUNW = new THREE.Vector3(...def.look.sun.dir).normalize();
        const scrubMat = new THREE.MeshStandardMaterial({
          vertexColors: true, roughness: 1, metalness: 0, flatShading: true, envMapIntensity: 0.22,
        });
        /**
         * u, side, lateral setback, len, depth, height, seed.
         *
         * `side` is the track's `right`, and on this lap `right` points OUT of the loop
         * everywhere — the route is a single clockwise circuit, so `+1` is the open basin and
         * `-1` is the infield the road comes back around. THAT is the constraint these six rows
         * live under, and two of them were breaking it.
         *
         * FOUND BY MEASUREMENT, not by eye (`tools/_la_overlap.mjs` raycasts straight down onto
         * 400 stations of the centreline, both kerbs and all three branches and reports any
         * landmark terrain above the road): the 480x330 knoll at u=0.192 and the 320x240 at
         * u=0.145 were both sited ~330 m into the infield, which on a loop only ~450 m across
         * puts them straight over the far side of it. Measured, the first sat up to 135 m above
         * the carriageway across u=0.36 to u=0.46 and the second up to 83 m near u=0.49, and
         * their scrub batches — 460 unlit cards each, hung on the hill's own height field —
         * floated over the road as black hexagons in every frame from u=0.42 to u=0.46.
         *
         * It is also the whole of the "1 of 48 captures renders a completely black world" defect:
         * la-muscle-drift ends at (798, 9.4, -372) with the drift camera 4.8 m inside the u=0.192
         * knoll's east flank. Hiding that one mesh and re-rendering the same frame returns
         * rgb(94,63,57) — an ordinary lit road — so the sim was never the problem.
         *
         * Both move OUT into the basin. The rule for anything added here: the footprint must
         * clear every station of the route (`tools/_la_knoll2.mjs`, which inflates the rectangle
         * by the worst case of the +-0.30 rad yaw jitter before measuring), and the six between
         * them have to ring the basin rather than pile up on one flank — east of the double
         * apex, north of the boulevard twice, south beyond the flood channel, and two on the run
         * home.
         */
        for (const [u, side, lat, w, d, hh, sd] of [
          // east of the double apex: the mass that closes the boulevard's far end
          [0.300, 1, 430, 480, 330, 112, 3],
          // the two that flank the opening straight, outside the sightline kept open for the
          // hillside letters — close enough to the axis that their dark crests run in under the
          // letters and give them something to read against, far enough that they never mask them
          [0.212, 1, 344, 440, 300, 92, 11],
          [0.115, 1, 300, 300, 220, 58, 17],
          // south, beyond the flood channel: what you see over the parapet on the shortcut
          [0.480, 1, 340, 380, 270, 78, 37],
          [0.905, 1, 320, 380, 260, 82, 23],
          // west, over the top of the last sweeper — measured at 130 m of clearance, where the
          // infield siting this replaces stood 33 m above the kerb at u=0.760
          [0.820, 1, 320, 320, 230, 60, 29],
        ]) {
          const s = track.at(u);
          // face the road: local +Z is the front slope, so it has to point back down the kerb
          const yaw = Math.atan2(-side * s.right.x, -side * s.right.z) + R.range(-0.30, 0.30);
          const K = heroRidge({
            len: w, depth: d, height: hh, seed: sd,
            nx: Math.round(w / 8), nz: Math.round(d / 8),
            mat: halfHaze(hillMaterial(HILL_MICRO), 0.80),
            sun: SUNW.clone().applyAxisAngle(UP, -yaw),
            bakeW: 768, bakeH: 384,
          });
          K.bake();
          const g = new THREE.Group();
          g.add(K.mesh);
          const bush = new THREE.Mesh(scrubBatch(K.brush, K.heightAt, {
            len: w, depth: d, n: 460, seed: sd * 17 + 3, scale: 0.55,
          }), scrubMat);
          bush.userData.noMerge = true;
          g.add(bush);
          g.position.copy(s.pos).addScaledVector(s.right, side * lat).setY(-2);
          g.rotation.y = yaw;
          M.take(g, { chunk: 0 });
        }
      }
    }

    // ================================================================ 1. the flood channel
    //
    // Seven hundred metres of trapezoidal concrete down the outside of the long south-west run: a
    // parapet you look over, a bleached floor, a low-flow invert with a trickle in it that catches
    // the sun as a hard specular streak, and a 9 m batter wall covered in tags. The middle
    // shortcut runs down the floor, so the channel is also the biggest overtake on the lap.
    const CH0 = 0.452, CH1 = 0.785;
    const mouths = [0.520, 0.700];
    const nCh = 104;
    const chStations = [];
    for (let i = 0; i <= nCh; i++) {
      const u = lerp(CH0, CH1, i / nCh);
      const s = track.at(u);
      chStations.push({ p: s.pos.clone(), r: s.right.clone(), u: UP.clone(), tu: u, tan: s.tan.clone() });
    }
    push(sweep(chStations, [
      [[23.4, -0.40], [46.0, -0.40], [46.0, -0.06], [23.4, -0.06]],          // floor
      [[46.0, -0.40], [54.0, -0.40], [54.0, -0.34], [46.0, -0.34]],          // low-flow invert
      [[54.0, -0.40], [58.0, -0.40], [58.0, -0.06], [54.0, -0.06]],          // toe strip
    ], { uvScale: 0.014, caps: true }), channelMat, { cast: false });
    // The batter is the whole point: 22 m of concrete rising 16 m, close enough to the kerb that
    // it fills a third of the frame height on that side. A shallow far bank read as flat ground.
    push(sweep(chStations, [
      [[58.0, -0.40], [96.0, -0.40], [96.0, 16.0], [80.0, 16.0], [58.0, -0.06]],
    ], { uvScale: 0.016, caps: true }), bankMat);
    push(sweep(chStations, [[[46.4, -0.34], [53.6, -0.34], [53.6, -0.29], [46.4, -0.29]]],
      { uvScale: 0.03 }), waterMat, { cast: false });

    // near parapet, broken open where the shortcut dives in and climbs out
    {
      let runStart = 0;
      for (let i = 0; i <= nCh; i++) {
        const blocked = mouths.some((m) => Math.abs(chStations[i].tu - m) < 0.018);
        if (blocked || i === nCh) {
          if (i - runStart > 2) {
            push(sweep(chStations.slice(runStart, i),
              [[[22.0, -0.40], [23.5, -0.40], [23.5, 0.95], [22.0, 0.95]]],
              { uvScale: 0.10, caps: true }), channelMat);
          }
          runStart = i + 1;
        }
      }
    }

    // chain-link along the far berm only — a fence on the near parapet would screen the channel
    for (const [lat, y0, fh, skipMouths] of [[82.0, 16.0, 2.2, false]]) {
      const line = [];
      for (let i = 0; i <= nCh; i++) {
        const s = chStations[i];
        if (skipMouths && mouths.some((m) => Math.abs(s.tu - m) < 0.022)) { line.push(null); continue; }
        line.push(s.p.clone().addScaledVector(s.r, lat).setY(y0));
      }
      // One post geometry and one unit rail, scaled to each span: 105 posts and 208 rails cost two
      // buffers instead of 313 allocations.
      const postGeo = new THREE.CylinderGeometry(0.08, 0.08, fh, 5);
      postGeo.translate(0, fh / 2, 0);
      const railGeo = new THREE.CylinderGeometry(0.05, 0.05, 1, 4);
      railGeo.rotateZ(Math.PI / 2);
      for (let i = 0; i < line.length; i++) {
        if (!line[i]) continue;
        const post = new THREE.Mesh(postGeo, railMat);
        post.position.copy(line[i]);
        post.castShadow = true;
        M.take(post);
        if (i + 1 < line.length && line[i + 1]) {
          const a = line[i], b = line[i + 1];
          const len = a.distanceTo(b);
          const yaw = Math.atan2(b.x - a.x, b.z - a.z);
          for (const ry of [fh - 0.10, fh * 0.06]) {
            const rail = new THREE.Mesh(railGeo, railMat);
            rail.scale.x = len;
            rail.position.copy(a).lerp(b, 0.5).setY(a.y + ry);
            rail.rotation.y = yaw + Math.PI / 2;
            M.take(rail);
          }
          const mesh = new THREE.PlaneGeometry(len, fh - 0.16);
          const uvA = mesh.attributes.uv;
          for (let q = 0; q < uvA.count; q++) uvA.setXY(q, uvA.getX(q) * (len / 2.2), uvA.getY(q) * ((fh - 0.16) / 2.2));
          uvA.needsUpdate = true;
          const wire = new THREE.Mesh(mesh, linkMat);
          wire.position.copy(a).lerp(b, 0.5).setY(a.y + fh / 2 - 0.02);
          wire.rotation.y = yaw + Math.PI / 2;
          M.take(wire);
        }
      }
    }

    // Tags and water stains, placed with the seeded RNG rather than tiled into the texture so
    // nothing repeats at an interval the eye can lock onto. All share one atlas → one draw call.
    const slopeLen = Math.hypot(22, 16.06);
    const slopeDir = [22 / slopeLen, 16.06 / slopeLen];
    const slopeNrm = [-16.06 / slopeLen, 22 / slopeLen];
    const onSlope = (mesh, u, t, lift) => {
      const s = track.at(u);
      mesh.position.copy(s.pos)
        .addScaledVector(s.right, 58 + slopeDir[0] * t * slopeLen + slopeNrm[0] * lift)
        .setY(-0.06 + slopeDir[1] * t * slopeLen + slopeNrm[1] * lift);
      mesh.rotation.set(0, Math.atan2(s.tan.x, s.tan.z) + Math.PI / 2, 0);
      mesh.rotateX(-Math.atan2(slopeDir[1], slopeDir[0]));
    };
    {
      // §7 cap 65 was "the identical glyph three times across one screen width", and the cause was
      // as much the DRAW ORDER as the pool size: cells were picked at random and placed at random
      // u, so two copies of one piece landing side by side was routine. The pieces are laid out in
      // order along the wall now and dealt from a shuffled deck of all 24 cells, which makes any
      // 24 spatially-consecutive tags distinct by construction — a screen holds about 35, so a
      // repeat can only ever be at opposite ends of the frame, wearing a different tint.
      const N = 112;
      const us = [];
      for (let i = 0; i < N; i++) us.push(lerp(CH0 + 0.008, CH1 - 0.008, R.next()));
      us.sort((p, q) => p - q);
      const deck = [];
      const reshuffle = () => {
        const d = [];
        for (let i = 0; i < TAG_COLS * TAG_ROWS; i++) d.push(i);
        for (let i = d.length - 1; i > 0; i--) { const j = R.int(0, i); const t = d[i]; d[i] = d[j]; d[j] = t; }
        deck.push(...d);
      };
      // THE SEAM BETWEEN TWO DECKS.
      //
      // Dealing from a shuffled deck makes any 48 consecutive pieces distinct, but says nothing
      // about the JOIN: a cell dealt last out of one deck and first out of the next lands twice
      // inside a few metres of wall, and that is exactly what the whole-game critic measured —
      // two copies of the same piece within one screen width at 3x (`shots/cw2/la_graf2.png`,
      // 'LOS' twice). A window of the last dozen cells dealt, skipped over when the deck turns
      // over, closes it: the only pool the dealer will not touch is the one you can still see.
      const recent = [];
      const RECENT = 14;
      const dealCell = () => {
        if (!deck.length) reshuffle();
        let k = 0;
        while (k < deck.length && recent.includes(deck[k])) k++;
        if (k >= deck.length) k = 0;
        const [cell] = deck.splice(k, 1);
        recent.push(cell);
        if (recent.length > RECENT) recent.shift();
        return cell;
      };
      for (const u of us) {
        const cellIdx = dealCell();
        const cx = cellIdx % TAG_COLS, cy = Math.floor(cellIdx / TAG_COLS);
        const w = R.range(9, 31), h = w * R.range(0.40, 0.60);
        const geo = new THREE.PlaneGeometry(w, h);
        const uvA = geo.attributes.uv;
        // a random bite out of the cell: real pieces are painted over each other, and it means two
        // draws of one cell are not the same rectangle of paint
        const ix = R.range(0, 0.14), iy = R.range(0, 0.12);
        const jx = R.range(0, 0.14), jy = R.range(0, 0.12);
        for (let q = 0; q < uvA.count; q++) {
          const gx = lerp(ix, 1 - jx, uvA.getX(q));
          const gy = lerp(iy, 1 - jy, uvA.getY(q));
          uvA.setXY(q, (gx + cx) / TAG_COLS, (gy + cy) / TAG_ROWS);
        }
        uvA.needsUpdate = true;
        const m = new THREE.Mesh(geo, tagMat);
        // biased low on the batter — that is both where a can of paint reaches and the band of
        // wall the driver actually sees over the parapet
        onSlope(m, u, R.range(0.02, 0.62), 0.08);
        m.rotateZ(R.range(-0.16, 0.16));
        const tint = tagTint(R);
        M.take(m, { remap: () => ({ material: tagMat, color: tint }) });
      }
    }
    // grime band along the toe, where the water sits
    for (let i = 0; i < 46; i++) {
      const u = lerp(CH0, CH1, (i + R.range(0.1, 0.9)) / 46);
      const m = new THREE.Mesh(new THREE.PlaneGeometry(R.range(14, 30), R.range(3, 7)), stainMat);
      onSlope(m, u, R.range(0.02, 0.16), 0.05);
      M.take(m);
    }
    for (let i = 0; i < 40; i++) {
      const u = lerp(CH0 + 0.008, CH1 - 0.008, R.next());
      const s = track.at(u);
      const onFloor = R.bool(0.5);
      const m = new THREE.Mesh(new THREE.PlaneGeometry(
        onFloor ? R.range(12, 34) : R.range(5, 13),
        onFloor ? R.range(16, 52) : R.range(7, 17),
      ), stainMat);
      if (onFloor) {
        m.position.copy(s.pos).addScaledVector(s.right, R.range(24, 57)).setY(-0.045);
        m.rotation.set(-Math.PI / 2, 0, Math.atan2(s.tan.x, s.tan.z));
      } else {
        onSlope(m, u, R.range(0, 0.9), 0.06);
      }
      M.take(m);
    }

    // CONTRACTION JOINTS. A poured channel is cast in bays, and the grid of joints between them —
    // across the floor every 15 m, straight up the batter at the same spacing — is the single most
    // recognisable thing about the LA river after the tags. It is also what stops 700 m of pale
    // concrete reading as §7's untextured slab: the joint grid gives the eye a scale reference and
    // a receding perspective all the way to the vanishing point.
    {
      const jointMat = new THREE.MeshBasicMaterial({
        color: 0x4a4234, transparent: true, opacity: 0.5, depthWrite: false, fog: true,
      });
      const nJ = Math.round((CH1 - CH0) * track.length / 15);
      for (let i = 0; i <= nJ; i++) {
        const u = lerp(CH0, CH1, i / nJ);
        const s = track.at(u);
        const yaw = Math.atan2(s.tan.x, s.tan.z);
        // across the floor
        const fj = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 34.6), jointMat);
        fj.position.copy(s.pos).addScaledVector(s.right, 23.4 + 17.3).setY(-0.035);
        fj.rotation.set(-Math.PI / 2, 0, yaw + Math.PI / 2);
        M.take(fj);
        // and up the batter
        const bj = new THREE.Mesh(new THREE.PlaneGeometry(0.24, slopeLen), jointMat);
        onSlope(bj, u, 0.5, 0.05);
        bj.rotateZ(Math.PI / 2);
        M.take(bj);
      }
      // the low-flow invert's own edge kerbs, so the trickle sits in something
      for (const lat of [46.2, 53.8]) {
        const runs = 26;
        for (let i = 0; i < runs; i++) {
          const u0 = lerp(CH0, CH1, i / runs), u1 = lerp(CH0, CH1, (i + 1) / runs);
          const a = track.at(u0), b = track.at(u1);
          const pa = a.pos.clone().addScaledVector(a.right, lat);
          const pb = b.pos.clone().addScaledVector(b.right, lat);
          const kerb = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.34, pa.distanceTo(pb) * 1.02), channelMat);
          kerb.position.copy(pa).lerp(pb, 0.5).setY(-0.23);
          kerb.rotation.y = Math.atan2(pb.x - pa.x, pb.z - pa.z);
          kerb.castShadow = true; kerb.receiveShadow = true;
          M.take(kerb);
        }
      }
      // Junk in the wash: tyres, pallets and a dumped shopping trolley, scattered along the invert.
      // Twelve objects, three materials, and they are what turn a concrete ramp into a place.
      const rubberMat = new THREE.MeshStandardMaterial({ color: 0x17161a, roughness: 0.95 });
      const woodMat = new THREE.MeshStandardMaterial({ color: 0x8a7048, roughness: 0.92 });
      for (let i = 0; i < 26; i++) {
        const u = lerp(CH0 + 0.01, CH1 - 0.01, R.next());
        const s = track.at(u);
        const lat = R.range(26, 57);
        const yaw = Math.atan2(s.tan.x, s.tan.z);
        const roll = R.next();
        if (roll < 0.45) {
          const t = new THREE.Mesh(new THREE.TorusGeometry(0.36, 0.15, 6, 12), rubberMat);
          t.position.copy(s.pos).addScaledVector(s.right, lat).setY(R.bool(0.6) ? 0.15 : 0.36);
          t.rotation.set(R.bool(0.6) ? Math.PI / 2 : R.range(1.2, 1.9), R.range(0, 3), R.range(0, 3));
          t.castShadow = true;
          M.take(t);
        } else if (roll < 0.78) {
          const pl = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.14, 1.0), woodMat);
          pl.position.copy(s.pos).addScaledVector(s.right, lat).setY(0.07);
          pl.rotation.set(R.range(-0.1, 0.1), yaw + R.range(0, 3), R.range(-0.1, 0.1));
          pl.castShadow = true;
          M.take(pl);
        } else {
          // trolley: a wire basket on a frame, tipped over
          const cart = new THREE.Group();
          const basket = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.5, 0.95), railMat);
          basket.position.y = 0.55; basket.castShadow = true;
          cart.add(basket);
          for (const [dx, dz] of [[-0.24, -0.36], [0.24, -0.36], [-0.24, 0.36], [0.24, 0.36]]) {
            const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.55, 4), railMat);
            leg.position.set(dx, 0.28, dz);
            cart.add(leg);
          }
          cart.position.copy(s.pos).addScaledVector(s.right, lat).setY(0.05);
          cart.rotation.set(R.range(1.2, 1.7), R.range(0, 6.2), R.range(-0.3, 0.3));
          M.take(cart);
        }
      }
    }

    // Storm-drain outfalls punched through the toe of the batter, each with a concrete headwall,
    // a dark barrel and a wet streak running down to the invert. After the tags this is the
    // single most recognisable thing about an LA flood channel.
    {
      const dark = new THREE.MeshStandardMaterial({ color: 0x16150f, roughness: 1 });
      for (let i = 0; i < 8; i++) {
        const u = lerp(CH0 + 0.02, CH1 - 0.03, (i + R.range(0.15, 0.85)) / 8);
        const s = track.at(u);
        const rad = R.range(1.5, 2.9);
        const yaw = Math.atan2(s.tan.x, s.tan.z);
        const at = (lat, y) => s.pos.clone().addScaledVector(s.right, lat).setY(y);
        const head = new THREE.Mesh(new THREE.BoxGeometry(rad * 3.4, rad * 2.6 + 1.6, 1.4), bankMat);
        head.position.copy(at(58.4, (rad * 2.6 + 1.6) / 2 - 0.4));
        head.rotation.y = yaw + Math.PI / 2;
        head.castShadow = true; head.receiveShadow = true;
        M.take(head);
        const barrel = new THREE.Mesh(new THREE.CylinderGeometry(rad, rad, 5.5, 14, 1, true), dark);
        barrel.position.copy(at(61.0, rad * 0.92));
        barrel.rotation.set(0, yaw, Math.PI / 2);
        M.take(barrel);
        const cap = new THREE.Mesh(new THREE.CircleGeometry(rad, 14), dark);
        cap.position.copy(at(63.6, rad * 0.92));
        cap.rotation.set(0, yaw + Math.PI / 2, 0);
        M.take(cap);
        // the apron and the wet trail it leaves across the floor toward the invert
        const trail = new THREE.Mesh(new THREE.PlaneGeometry(rad * 2.6, 13), stainMat);
        trail.position.copy(at(52.0, -0.045));
        trail.rotation.set(-Math.PI / 2, 0, yaw + Math.PI / 2);
        M.take(trail);
      }
    }

    // Two girder bridges over the channel. Nothing says "concrete river" faster than seeing one
    // crossing it a quarter of a mile ahead with the light coming through underneath.
    for (const bu of [0.480, 0.645]) {
      const s = track.at(bu);
      const span = straightRun(
        s.pos.x + s.right.x * 20, s.pos.z + s.right.z * 20,
        s.pos.x + s.right.x * 102, s.pos.z + s.right.z * 102,
        7.4, 8.8, 10,
      );
      push(sweep(span, [
        [[-5.2, -1.5], [5.2, -1.5], [5.2, 0], [-5.2, 0]],
        [[-5.4, 0], [-4.6, 0], [-4.6, 1.1], [-5.4, 1.1]],
        [[4.6, 0], [5.4, 0], [5.4, 1.1], [4.6, 1.1]],
      ], { uvScale: 0.09, caps: true }), structMat);
      for (const lat of [26, 46, 64]) {
        const p = s.pos.clone().addScaledVector(s.right, lat);
        const hgt = 7.4 + (lat - 20) / 82 * 1.4 - 1.7;
        const col = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.3, hgt, 10), structMat);
        col.position.set(p.x, hgt / 2, p.z);
        col.castShadow = true;
        M.take(col);
      }
    }

    // chevron boards either side of each shortcut mouth: the "you may drive in here" sign
    {
      const { c, ctx } = canvas(160, 64);
      ctx.fillStyle = '#161616'; ctx.fillRect(0, 0, 160, 64);
      ctx.fillStyle = '#ffb020';
      for (let k = -2; k < 8; k++) {
        ctx.beginPath();
        ctx.moveTo(k * 26, 0); ctx.lineTo(k * 26 + 17, 0);
        ctx.lineTo(k * 26 + 43, 64); ctx.lineTo(k * 26 + 26, 64);
        ctx.closePath(); ctx.fill();
      }
      const chevTex = toTexture(c, { srgb: true, wrap: THREE.ClampToEdgeWrapping });
      const chevMat = new THREE.MeshStandardMaterial({
        map: chevTex, emissiveMap: chevTex, emissive: 0xffffff,
        emissiveIntensity: night ? 1.5 : 0.65, roughness: 0.7, side: THREE.DoubleSide,
      });
      for (const mu of mouths) {
        for (const dz of [-1, 1]) {
          const s = track.at(mu + dz * 0.0068);
          const m = new THREE.Mesh(new THREE.PlaneGeometry(6.5, 1.5), chevMat);
          m.position.copy(s.pos).addScaledVector(s.right, 22.6).setY(1.35);
          m.rotation.y = Math.atan2(s.tan.x, s.tan.z) + Math.PI / 2;
          M.take(m);
          // the broken-off parapet stub, tipped over into the channel
          const stub = new THREE.Mesh(new THREE.BoxGeometry(1.3, 1.2, 3.4), channelMat);
          stub.position.copy(s.pos).addScaledVector(s.right, 26.5 + dz * 1.5).setY(0.5);
          stub.rotation.set(0.32 * dz, Math.atan2(s.tan.x, s.tan.z) + 0.4, 0.22);
          stub.castShadow = true;
          M.take(stub);
        }
      }
    }

    // ================================================================ 2. the four-level stack
    //
    // Two viaducts crossing over the road at 14 m and 26 m, with three curved connectors woven
    // between them at 8.5 m, 20 m and 32 m. It is the biggest silhouette on the lap, the track
    // runs directly beneath the crossing point, and it is in frame for the whole approach down
    // the flood-channel straight.
    {
      const s = track.at(0.735);
      const stack = new THREE.Group();
      stack.position.copy(s.pos);
      stack.rotation.y = Math.atan2(s.tan.x, s.tan.z);
      const local = [];
      const put = (geo, mat, cast = true) => {
        const m = new THREE.Mesh(geo, mat);
        m.castShadow = cast; m.receiveShadow = true;
        local.push(m);
        return m;
      };
      // Pale concrete box girder and parapets, DARK asphalt running surface between them: without
      // that value break a viaduct seen from underneath is one grey ribbon with no road on it.
      const deck = (stations, halfW, thick) => {
        put(sweep(stations, [
          [[-halfW, -thick], [halfW, -thick], [halfW, 0], [-halfW, 0]],                  // box girder
          [[-halfW - 0.12, 0], [-halfW + 0.85, 0], [-halfW + 0.85, 1.15], [-halfW - 0.12, 1.15]],
          [[halfW - 0.85, 0], [halfW + 0.12, 0], [halfW + 0.12, 1.15], [halfW - 0.85, 1.15]],
        ], { uvScale: 0.045, caps: true }), structMat);
        put(sweep(stations, [
          [[-halfW + 0.85, 0.0], [halfW - 0.85, 0.0], [halfW - 0.85, 0.09], [-halfW + 0.85, 0.09]],
        ], { uvScale: 0.10 }), tarmacMat, false);
        return stations;
      };
      const A = straightRun(-330, -106, 210, 68, 14, 14, 30);      // main line, 72 deg to the road
      const B = straightRun(158, -232, -226, 222, 26, 26, 30);     // upper line, crossing it
      deck(A, 12.5, 2.4);
      deck(B, 10.5, 2.2);
      const C1 = arcRun(-168, 118, 138, -Math.PI * 0.54, -Math.PI * 0.02, 8.5, 20.0, 22, 0.10);
      const C2 = arcRun(168, -142, 124, Math.PI * 0.46, Math.PI * 0.99, 20.0, 32.0, 22, -0.10);
      const C3 = arcRun(-206, -206, 168, Math.PI * 0.01, Math.PI * 0.42, 32.5, 19.0, 20, 0.08);
      deck(C1, 6.0, 1.7); deck(C2, 5.6, 1.6); deck(C3, 5.2, 1.5);

      for (const [st, step, capW] of [[A, 5, 24], [B, 5, 21]]) {
        for (let i = 2; i < st.length - 1; i += step) {
          const p = st[i].p;
          if (Math.abs(p.x) < 26) continue;                        // never in the carriageway
          const hgt = p.y - 2.6;
          const col = put(new THREE.CylinderGeometry(1.5, 2.3, hgt, 12), structMat);
          col.position.set(p.x, hgt / 2, p.z);
          const cap = put(new THREE.BoxGeometry(3.4, 1.5, capW), structMat);
          cap.position.set(p.x, hgt + 0.5, p.z);
          cap.rotation.y = Math.atan2(st[i].r.z, st[i].r.x) + Math.PI / 2;
          const foot = put(new THREE.BoxGeometry(6.4, 1.0, 6.4), structMat, false);
          foot.position.set(p.x, 0.3, p.z);
        }
      }
      for (const arc of [C1, C2, C3]) {
        for (let i = 2; i < arc.length - 1; i += 3) {
          const p = arc[i].p;
          if (Math.abs(p.x) < 24) continue;
          const hgt = p.y - 1.9;
          const col = put(new THREE.CylinderGeometry(1.05, 1.5, hgt, 10), structMat);
          col.position.set(p.x, hgt / 2, p.z);
        }
      }
      // lamp standards marching down deck A — the thing that makes an elevated deck read as a road
      for (let i = 0; i < 15; i++) {
        const p = new THREE.Vector3().lerpVectors(A[1].p, A[A.length - 2].p, i / 14);
        const sd = i % 2 ? 12.2 : -12.2;
        const off = new THREE.Vector3().copy(A[0].r).multiplyScalar(sd);
        const mast = put(new THREE.CylinderGeometry(0.16, 0.24, 9, 7), steel);
        mast.position.set(p.x + off.x, p.y + 5.2, p.z + off.z);
        const arm = put(new THREE.BoxGeometry(0.34, 0.22, 2.6), steel);
        arm.position.set(p.x + off.x * 0.9, p.y + 9.7, p.z + off.z * 0.9);
      }
      // a green guide sign on a cantilever over deck A
      {
        const { c, ctx } = canvas(512, 200);
        ctx.fillStyle = '#0f5a2e'; ctx.fillRect(0, 0, 512, 200);
        ctx.strokeStyle = '#eef4ea'; ctx.lineWidth = 6; ctx.strokeRect(12, 12, 488, 176);
        drawText(ctx, 'HOLLYWOOD', { x: 256, y: 96, size: 54, weight: 0.17, align: 'center', color: '#f2f8f0', tracking: 0.05 });
        drawText(ctx, 'DOWNTOWN 4 MI', { x: 256, y: 158, size: 32, weight: 0.16, align: 'center', color: '#dfe8dc', tracking: 0.10 });
        grain(ctx, 512, 200, 6, new RNG(12));
        const st = toTexture(c, { srgb: true, wrap: THREE.ClampToEdgeWrapping });
        const sm = new THREE.MeshStandardMaterial({
          map: st, roughness: 0.8, side: THREE.FrontSide,
          emissiveMap: st, emissive: 0xffffff, emissiveIntensity: night ? 0.6 : 0.14,
        });
        for (const face of [0, Math.PI]) {
          const board = new THREE.Mesh(new THREE.PlaneGeometry(20, 7.8), sm);
          board.position.set(-104, 21.5, -46 + (face ? -0.08 : 0.08));
          board.rotation.y = face + 1.26;
          board.userData.noMerge = true;
          local.push(board);
        }
        const gantry = put(new THREE.BoxGeometry(0.7, 0.7, 22), steel);
        gantry.position.set(-104, 25.6, -46);
        gantry.rotation.y = 1.26;
        for (const dz of [-1, 1]) {
          const leg = put(new THREE.CylinderGeometry(0.34, 0.44, 12, 8), steel);
          leg.position.set(-104 + dz * 10.4 * Math.cos(1.26), 20, -46 - dz * 10.4 * Math.sin(1.26));
        }
      }
      // Traffic frozen on the decks: scale reference, and a reason for the lamps to exist. These
      // used to be a box with a smaller box on top — at 26 m up they are the object a viewer uses
      // to read how big the structure is, so a box tells them the structure is made of boxes.
      // They are the lofted street cars now, in stalled clumps rather than evenly spread, because
      // a freeway deck at golden hour is a car park.
      {
        for (const [st, halfW, lanes, n] of [[A, 12.5, 4, 15], [B, 10.5, 3, 13], [C1, 6.0, 2, 5], [C2, 5.6, 2, 5]]) {
          let i = 0;
          while (i < n) {
            const clump = Math.min(n - i, R.int(1, 4));
            const idx0 = R.range(0.06, 0.86);
            const dir = R.bool() ? 0 : Math.PI;
            const lane = R.int(0, lanes - 1);
            for (let k = 0; k < clump; k++, i++) {
              const t = clamp(idx0 + k * R.range(0.020, 0.045), 0, 0.97);
              const idx = Math.floor(t * (st.length - 1));
              const p = st[idx].p, r = st[idx].r;
              const off = -halfW + 2.4 + (lane + R.range(-0.18, 0.18)) * ((halfW * 2 - 4.8) / Math.max(1, lanes - 1));
              const car = makeCar(R);
              car.position.copy(p).addScaledVector(r, off).setY(p.y + 0.09);
              // the station carries its RIGHT vector, so forward is (r.z, 0, -r.x). Round 1 used
              // atan2(r.z, r.x), which is that reflected about the road axis — every car on the
              // decks was parked crabwise across its own lane.
              car.rotation.y = Math.atan2(r.z, -r.x) + dir + R.range(-0.03, 0.03);
              local.push(car);
            }
          }
        }
      }
      for (const m of local) stack.add(m);
      M.take(stack, { remap: carRemap });
    }

    // ================================================================ 3. downtown in the smog
    //
    // A tight cluster of towers 700 m down the flood-channel straight: close enough to read as
    // massing rather than a paper silhouette, far enough to sit half-way into the fog, and sited
    // on the one axis of the lap with a kilometre of open ground down it. It fills the band
    // between the channel wall (60 m) and the skyline ring (1150 m).
    {
      const skins = [
        towerSkin('#6f665a', '#2a4054', 5),
        towerSkin('#605850', '#22384a', 11),
        towerSkin('#7b7062', '#2f4a60', 17),
        towerSkin('#8a7b66', '#35526a', 23),
        towerSkin('#59524a', '#1e3346', 29),
      ];
      const wallMats = skins.map((t) => new THREE.MeshStandardMaterial({
        map: t, roughness: 0.86, metalness: 0.04, envMapIntensity: 0.5,
      }));
      const capMat = new THREE.MeshStandardMaterial({ color: 0x5d564c, roughness: 0.9 });
      // GLASS ON FIRE. At golden hour the one thing that makes a downtown read as downtown from a
      // kilometre away is that its west-facing curtain wall is a sheet of reflected sun while every
      // other face is in shade. That contrast cannot come from the key light — at this distance the
      // haze has flattened the whole cluster to one value — so the sunward face of every tower gets
      // a proud emissive pane instead. Above the 0.74 bloom threshold it halos, which is exactly
      // what a glass tower does at this hour.
      const glintTex = (() => {
        const w = 128, hh = 256;
        const { c, ctx } = canvas(w, hh);
        const gr = new RNG(313);
        ctx.fillStyle = '#120c06'; ctx.fillRect(0, 0, w, hh);
        const cols = 7, rows = 26;
        for (let r = 0; r < rows; r++) {
          const band = 0.45 + Math.pow(1 - r / rows, 1.5) * 0.55;   // brighter up high
          for (let ci = 0; ci < cols; ci++) {
            const v = gr.range(0.25, 1.0) * band;
            ctx.fillStyle = `rgba(255,${(200 * v + 40) | 0},${(120 * v + 20) | 0},${v})`;
            ctx.fillRect(ci * (w / cols) + 1, r * (hh / rows) + 1.5, w / cols - 3, hh / rows - 4);
          }
        }
        grain(ctx, w, hh, 5, gr);
        return toTexture(c, { srgb: true });
      })();
      // Two strengths, because one is not enough: the face square-on to the sun is a white-hot
      // sheet, but a curtain wall raked at 80 degrees still throws a strong grazing reflection, and
      // from most of the lap those grazing faces are the only ones the camera can see. Without the
      // second material downtown goes back to being flat pink slabs from every angle but one.
      const glintMat = (i) => new THREE.MeshStandardMaterial({
        map: glintTex, emissiveMap: glintTex, emissive: 0xffffff,
        emissiveIntensity: (night ? 2.4 : 2.5) * (i ? 1 : 0.42),
        roughness: 0.24, metalness: 0.5, color: i ? 0x2a2018 : 0x1d160f,
      });
      const glintHot = glintMat(1), glintGraze = glintMat(0);
      const beaconMat = new THREE.MeshStandardMaterial({
        color: 0x3a0a0a, emissive: 0xff3020, emissiveIntensity: 3.4, roughness: 0.5,
      });
      const plan = [
        [0, 0, 46, 44, 250, 0], [-72, 40, 40, 40, 176, 3], [64, 58, 38, 46, 198, 2],
        [-30, 106, 52, 40, 148, 1], [110, -22, 36, 36, 128, 4], [-118, -34, 42, 38, 162, 2],
        [26, -74, 34, 44, 116, 3], [150, 74, 40, 40, 214, 2], [-166, 66, 36, 36, 122, 4],
        [80, 150, 44, 40, 158, 1], [-84, 168, 38, 42, 136, 4], [196, -60, 34, 34, 104, 0],
        [-206, -6, 40, 40, 142, 3], [4, 220, 42, 38, 118, 0], [232, 130, 36, 36, 96, 2],
        [-140, 118, 34, 34, 236, 2], [118, 214, 30, 30, 178, 0],
      ];
      const g = new THREE.Group();
      const anchor = track.at(0.700);
      g.position.copy(anchor.pos)
        .addScaledVector(anchor.tan, 760)
        .addScaledVector(anchor.right, -120)
        .setY(0);
      g.rotation.y = Math.atan2(anchor.tan.x, anchor.tan.z) + 0.5;
      // the sun, in the cluster's own frame, so "which face is lit" is a dot product per box
      const sunLocal = new THREE.Vector3(...def.look.sun.dir).normalize()
        .applyAxisAngle(UP, -g.rotation.y);
      for (const [x, z, w, d, h, si] of plan) {
        const H = h * R.range(0.88, 1.12);
        const steps = R.int(1, 3);
        const yaw = R.range(-0.25, 0.25);
        const cosY = Math.cos(-yaw), sinY = Math.sin(-yaw);
        const sx = sunLocal.x * cosY + sunLocal.z * sinY;          // sun in this box's frame
        const sz = -sunLocal.x * sinY + sunLocal.z * cosY;
        let y = 0, sw = w, sd = d, rem = H;
        for (let k = 0; k < steps; k++) {
          const sh = k === steps - 1 ? rem : rem * R.range(0.42, 0.68);
          const box = new THREE.BoxGeometry(sw, sh, sd);
          const uvA = box.attributes.uv;
          // ...offset per box, so two towers that happen to share a skin never show the same
          // window grid in the same place. §7 caps a prop repeated at a visible interval at 66.
          const uo = R.next(), vo = R.next();
          for (let q = 0; q < uvA.count; q++) {
            const face = Math.floor(q / 4);
            const across = (face === 0 || face === 1) ? sd : sw;
            uvA.setXY(q, uvA.getX(q) * (across / 3.4) + uo, uvA.getY(q) * (sh / 25) + vo);
          }
          uvA.needsUpdate = true;
          const m = new THREE.Mesh(box, wallMats[si]);
          m.position.set(x, y + sh / 2, z);
          m.rotation.y = yaw;
          g.add(m);
          // ...and the lit pane on whichever of the four faces is turned toward the sun
          for (const [nx, nz, fw] of [[1, 0, sd], [-1, 0, sd], [0, 1, sw], [0, -1, sw]]) {
            const face = nx * sx + nz * sz;
            if (face < 0.02) continue;
            const pane = new THREE.Mesh(new THREE.PlaneGeometry(fw * 0.88, sh * 0.9),
              face > 0.45 ? glintHot : glintGraze);
            const off = (nx ? sw : sd) * 0.5 + 0.25;
            pane.position.set(x + (nx * off) * cosY - (nz * off) * sinY,
              y + sh / 2, z + (nx * off) * sinY + (nz * off) * cosY);
            pane.rotation.y = yaw + Math.atan2(nx, nz);
            const uvP = pane.geometry.attributes.uv;
            for (let q = 0; q < uvP.count; q++) uvP.setXY(q, uvP.getX(q) * (fw / 26), uvP.getY(q) * (sh / 90));
            uvP.needsUpdate = true;
            g.add(pane);
          }
          const cap = new THREE.Mesh(new THREE.BoxGeometry(sw * 1.04, 1.6, sd * 1.04), capMat);
          cap.position.set(x, y + sh, z);
          cap.rotation.y = yaw;
          g.add(cap);
          y += sh; rem -= sh;
          sw *= R.range(0.66, 0.86); sd *= R.range(0.66, 0.86);
        }
        // Crowns, and they are what turns a box cluster into a skyline. Three kinds, chosen by
        // height: a stepped ziggurat with a mast on the tallest, a drum cluster on the mid-rise
        // (LA's round hotel towers), a plain parapet mast on the rest.
        if (H > 200) {
          for (let t = 0; t < 3; t++) {
            const zw = sw * (1 - t * 0.22);
            const zig = new THREE.Mesh(new THREE.BoxGeometry(zw, 7 - t, zw * (sd / sw)), capMat);
            zig.position.set(x, y + 3.5 + t * 6.4, z);
            zig.rotation.y = yaw;
            g.add(zig);
          }
          const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 1.3, 42, 6), capMat);
          mast.position.set(x, y + 42, z);
          g.add(mast);
          const bead = new THREE.Mesh(new THREE.SphereGeometry(1.5, 6, 5), beaconMat);
          bead.position.set(x, y + 63, z);
          g.add(bead);
        } else if (H > 150) {
          for (const [dx, dz, rr] of [[0, 0, sw * 0.34], [sw * 0.32, sd * 0.28, sw * 0.2],
            [-sw * 0.30, -sd * 0.26, sw * 0.18], [sw * 0.28, -sd * 0.30, sw * 0.16]]) {
            const drum = new THREE.Mesh(new THREE.CylinderGeometry(rr, rr, R.range(10, 24), 12), capMat);
            drum.position.set(x + dx, y + 8, z + dz);
            g.add(drum);
          }
          const bead = new THREE.Mesh(new THREE.SphereGeometry(1.2, 6, 5), beaconMat);
          bead.position.set(x, y + 21, z);
          g.add(bead);
        } else if (R.bool(0.55)) {
          const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.8, H * 0.16, 6), capMat);
          mast.position.set(x, y + H * 0.08, z);
          g.add(mast);
        }
      }
      // One cell, not four: the cluster is 450 m across and 760 m away, so it is either wholly in
      // frame or wholly out of it and chunking it only costs draw calls.
      M.take(g, { chunk: 0 });
    }

    // ================================================================ 4. the palm avenue
    //
    // Two heights mixed irregularly: sixty-foot Washingtonias whose crowns clear every roofline on
    // the route (this is the read that survives being in silhouette against a low sun) and squat
    // ones at street level. Nothing sits on a fixed interval, and none of them are the shared
    // kit's palm — see washingtonia() above for why LA needs its own.
    {
      const pcache = new Map();
      // Four materials for ~330 trees: mapped bark, TWO crown greens and the dead thatch. Two
      // greens because a row of identical crowns is half of what makes a verge march; the darker
      // one is the older tree. Both carry a low warm emissive — at 16 degrees of elevation the sun
      // is BEHIND these crowns from most of the lap, and a purely reflective leaf in that position
      // renders black, which is what made round 1's palms read as holes punched in the sky rather
      // than as foliage. The lift sits well under the 0.74 bloom threshold, so it warms the
      // silhouette without haloing it.
      const palmMats = {
        bark: new THREE.MeshStandardMaterial({
          map: barkTexture(71), roughness: 0.94, metalness: 0,
        }),
        leaf: new THREE.MeshStandardMaterial({
          color: 0x597a33, roughness: 0.62, side: THREE.DoubleSide, envMapIntensity: 0.9,
          emissive: 0x4a3a14, emissiveIntensity: 0.42,
        }),
        leaf2: new THREE.MeshStandardMaterial({
          color: 0x40632c, roughness: 0.70, side: THREE.DoubleSide, envMapIntensity: 0.9,
          emissive: 0x3c3410, emissiveIntensity: 0.34,
        }),
        dead: new THREE.MeshStandardMaterial({
          color: 0x7a6642, roughness: 0.98, side: THREE.DoubleSide,
          emissive: 0x3a2a12, emissiveIntensity: 0.30,
        }),
      };
      /** One tree, with every free parameter jittered. */
      const plant = (u, side, lat, { tall, seed, y = 0.16, lod = 0 }) => {
        const s = track.at(u);
        const h = tall ? R.range(17, 30) : R.range(8.5, 14.5);
        const p = washingtonia({
          h, seed, lod,
          lean: tall ? R.range(0.006, 0.034) : R.range(0.03, 0.10),
          mats: palmMats, cache: pcache, leafMat: R.bool(0.45) ? 'leaf2' : 'leaf',
        });
        p.position.copy(s.pos).addScaledVector(s.right, side * lat).setY(y);
        p.rotation.y = R.range(0, 6.28);
        p.scale.setScalar(R.range(0.92, 1.10));
        M.take(p);
      };
      // PLANTED IN GROUPS, NOT AT A PITCH. §7 caps a prop repeated at a visible regular interval
      // at 66, and round 1's verges did exactly that: one palm every 19-34 m all the way to the
      // vanishing point on both sides. Real LA verges come in stands — three or four together off
      // one lot, then eighty metres of nothing where a used-car yard or a driveway killed them —
      // so the walk below lays down a stand of 3-6 at 9-16 m, then jumps a 20-72 m gap, and every
      // tree in a stand takes its own setback off the kerb. Mean spacing comes out the same as
      // round 1 — the avenue is exactly as dense — but no two intervals in a row are equal.
      for (const side of [-1, 1]) {
        let u = R.range(0, 0.014);
        let i = 0;
        while (u < 1) {
          const inChannel = side > 0 && u > CH0 && u < CH1;
          const stand = R.int(3, 6);
          const setback = inChannel ? 86 + R.range(0, 7) : HW + R.range(4.0, 8.6);
          for (let k = 0; k < stand && u < 1; k++) {
            const wide = side > 0 && u > CH0 && u < CH1;
            plant(u, side, (wide ? 86 + R.range(0, 7) : setback) + R.range(-1.2, 1.6), {
              tall: R.bool(0.68), seed: i * 7 + (side > 0 ? 101 : 313),
              y: wide ? 15.9 : 0.16, lod: wide ? 2 : 0,
            });
            u += R.range(9, 16) / track.length;
            i++;
          }
          u += R.range(20, 72) / track.length;
        }
      }
      // A deeper second and third row on the open north side of the boulevard, so the long
      // straight reads as an avenue receding rather than a single lane of trees. These are never
      // closer than forty metres to the camera, so they take the chunky far LOD.
      for (let k = 0; k < 40; k++) {
        const u = R.range(0, 0.215);
        plant(u, 1, R.range(42, 96), { tall: true, seed: 900 + k, y: 0.1, lod: 2 });
      }
      // ...and a stand up on the hill shoulder past the last corner
      for (let k = 0; k < 14; k++) {
        plant(R.range(0.885, 0.985), -1, R.range(38, 90), { tall: R.bool(0.7), seed: 1500 + k, lod: 2 });
      }
    }

    // ================================================================ 4b. cars at the kerb
    //
    // The kit's parked cars are switched off for LA (`props.parkedCars: false`) and placed here
    // instead, because these are the props standing three metres from the camera for the whole
    // lap and they have to be the good mesh. Nose-to-tail in short ranks with gaps, never in a
    // bend, never in the flood-channel right-of-way — plus a used-car lot on the north kerb of the
    // boulevard, which is both an LA truism and the thing that stops the row reading as a queue.
    {
      const kerbLat = HW + (track.wallOffset ?? 6) + 1.35;
      const turn = (u) => Math.abs(track.turnRate ? track.turnRate(u) : track.curvature(u));
      for (const side of [-1, 1]) {
        let u = R.range(0, 0.03);
        while (u < 1) {
          const rank = R.int(1, 4);
          for (let k = 0; k < rank && u < 1; k++) {
            const blocked = (side > 0 && u > 0.445 && u < 0.79)          // the channel
              || (u > 0.700 && u < 0.778)                                // freeway right-of-way
              || (u > 0.098 && u < 0.168 && side > 0)                    // the lot, placed below
              || mouths.some((m) => Math.abs(u - m) < 0.02)
              || turn(u) > 0.0065;
            if (!blocked) {
              const s = track.at(u);
              const car = makeCar(R);
              car.position.copy(s.pos)
                .addScaledVector(s.right, side * (kerbLat + R.range(-0.25, 0.35)))
                .setY(0.17);
              car.rotation.y = Math.atan2(s.tan.x, s.tan.z) + (side > 0 ? Math.PI : 0)
                + R.range(-0.045, 0.045);
              M.take(car, { remap: carRemap });
            }
            u += R.range(5.6, 7.4) / track.length;
          }
          u += R.range(22, 90) / track.length;
        }
      }
      // the used-car lot: four ranks angled onto the forecourt, nose out
      for (let row = 0; row < 4; row++) {
        for (let i = 0; i < 5; i++) {
          const u = lerp(0.102, 0.164, (i + R.range(-0.14, 0.14)) / 4.6);
          const s = track.at(u);
          const car = makeCar(R);
          car.position.copy(s.pos)
            // four ranks deep, and no deeper: the block band starts 30 m off the kerb and a
            // fifth rank would park inside a storefront
            .addScaledVector(s.right, kerbLat + 2.6 + row * 5.4 + R.range(-0.5, 0.5))
            .setY(0.17);
          car.rotation.y = Math.atan2(s.tan.x, s.tan.z) + Math.PI / 2 + R.range(-0.10, 0.10)
            + (row % 2 ? Math.PI : 0);
          M.take(car, { remap: carRemap });
        }
      }
    }

    // ================================================================ 5. barriers and rail
    //
    // Concrete K-rail around the outside of the hairpin, W-beam guard rail on the long sweeper
    // home: the two pieces of road furniture that actually line a Californian road.
    {
      // The K-rail section is swept ONCE and then placed 78 times. Sweeping it per unit was 78
      // identical buffers built and thrown away at load; the units still get their own yaw and
      // scale jitter, so the run is exactly as irregular as it was.
      const N = 78;
      const krGeo = sweep(
        straightRun(0, -2.55, 0, 2.55, 0, 0, 1),
        [[[-0.45, 0], [0.45, 0], [0.22, 0.36], [0.26, 1.02], [-0.26, 1.02], [-0.22, 0.36]]],
        { uvScale: 0.35, caps: true },
      );
      for (let i = 0; i < N; i++) {
        const u = lerp(0.325, 0.445, i / (N - 1));
        const s = track.at(u);
        const kr = push(krGeo, channelMat);
        kr.position.copy(s.pos).addScaledVector(s.right, HW + 6.6).setY(0.12);
        kr.rotation.y = Math.atan2(s.tan.x, s.tan.z) + R.range(-0.02, 0.02);
        kr.scale.setScalar(R.range(0.98, 1.03));
      }
      const GR = 58;
      const postGeo = new THREE.BoxGeometry(0.18, 1.35, 0.18);
      const beamGeo = new THREE.BoxGeometry(0.14, 0.42, 1);      // scaled to each span
      let prev = null;
      for (let i = 0; i < GR; i++) {
        const u = lerp(0.800, 0.878, i / (GR - 1));
        const s = track.at(u);
        const at = s.pos.clone().addScaledVector(s.right, HW + 5.2);
        const post = new THREE.Mesh(postGeo, railMat);
        post.position.copy(at).setY(0.67);
        post.rotation.y = Math.atan2(s.tan.x, s.tan.z);
        post.castShadow = true;
        M.take(post);
        if (prev) {
          const beam = new THREE.Mesh(beamGeo, railMat);
          beam.scale.z = prev.distanceTo(at);
          beam.position.copy(prev).lerp(at, 0.5).setY(1.02);
          beam.rotation.y = Math.atan2(at.x - prev.x, at.z - prev.z);
          beam.castShadow = true;
          M.take(beam);
        }
        prev = at;
      }
    }

    // ================================================================ 6. the Hollywood hillside
    //
    // The city's primary landmark, and the largest surface in most LA frames. See the block above
    // the city definition for why it is built here rather than taken from the shared kit.
    {
      const kitCache = new Map();
      // ---- where the camera stands when it frames this. The kit picked that point by walking the
      // longest straight and taking the latest station that is clear of a branch mouth, a boost pad
      // and a gate; reproduced exactly, so nothing in the composition moves from round 2.
      const sites = track.landmarkSites();
      const wrapU = (a, b) => Math.abs(((a - b + 0.5) % 1 + 1) % 1 - 0.5);
      const avoid = [];
      for (const b of track.branches) avoid.push(b.enterU, b.exitU);
      for (const b of def.props.boostPads) avoid.push(((b.u % 1) + 1) % 1);
      let camU = (((sites.straight.u - 195 / track.length) % 1) + 1) % 1;
      {
        const clear = 150 / track.length;
        const from = sites.straight.u0, span = sites.straight.length / track.length;
        let best = null, bestScore = -1;
        for (let k = 0; k <= 24; k++) {
          const u = (((from + span * (0.10 + 0.72 * (k / 24))) % 1) + 1) % 1;
          let d = 1;
          for (const m of avoid) d = Math.min(d, wrapU(u, m));
          const score = Math.min(d, clear) * 100 + (k / 24) * 0.5;
          if (score > bestScore) { bestScore = score; best = u; }
        }
        if (best !== null) camU = best;
      }
      const cam = track.at(camU);
      const camPos = cam.pos.clone().setY(cam.pos.y + 2.4);
      const axisYaw = Math.atan2(-cam.tan.x, -cam.tan.z);
      const nearU = (m) => (((camU + m / track.length) % 1) + 1) % 1;

      // ---- the ridge
      const LEN = 2600, DEP = 1000, HGT = 268, DIST = 660;
      const hillMat = halfHaze(hillMaterial(HILL_MICRO));
      const sunLocal = new THREE.Vector3(...def.look.sun.dir).normalize().applyAxisAngle(UP, -axisYaw);
      const RG = heroRidge({
        len: LEN, depth: DEP, height: HGT, seed: 3, nx: 236, nz: 104, mat: hillMat, sun: sunLocal,
      });
      const hill = new THREE.Group();
      hill.add(RG.mesh);

      // ---- siting the word.
      //
      // `hx` also decides the composition: the local point (hx, hz) is what lands dead on the
      // camera axis, so choosing it chooses which part of the ridge is centred in the frame. It is
      // therefore worth searching for rather than guessing. The score wants a bench — 250 m of
      // hillside whose elevation barely changes — that is high enough on the hill to have mass
      // above it, because a level contour is what nine boards can stand on, and a summit behind
      // them is what Mount Lee gives the real thing.
      let bestX = 0, bestH = -1;
      for (let x = -900; x <= 900; x += 15) {
        const h = RG.heightAt(x, -40);
        if (h > bestH) { bestH = h; bestX = x; }
      }
      const CAP = 32;                                   // 45 ft of cap height, arcade-scaled
      const WORD = 'HOLLYWOOD';
      const GAPW = 0.15;
      let spanW = 0;
      for (let i = 0; i < WORD.length; i++) spanW += LETTERS[WORD[i]].w + (i ? GAPW : 0);
      const HALF = spanW * CAP / 2;
      // The OUTERMOST contour crossing at this x, walked in from the toe — not the closest one.
      // A hillside this creased crosses any elevation several times, and taking the wrong crossing
      // buries the board behind the spur standing in front of it.
      const groundZ = (x, want) => {
        let z = 40, bd = 1e9;
        for (let t = DEP * 0.52; t > -DEP * 0.10; t -= 4) {
          const h = RG.heightAt(x, t);
          if (h >= want) return t;
          const d = Math.abs(h - want);
          if (d < bd) { bd = d; z = t; }
        }
        return z;
      };
      let hx = 0, hz = 150, targetY = 130, bestScore = -1e9;
      for (let cx = -LEN * 0.24; cx <= LEN * 0.24; cx += 26) {
        for (const frac of [0.44, 0.52, 0.60, 0.68]) {
          const want = bestH * frac;
          const zc = groundZ(cx, want);
          let lo = 1e9, hi = -1e9, sum = 0;
          for (let k = 0; k <= 8; k++) {
            const h = RG.heightAt(cx - HALF + (k / 8) * HALF * 2, zc);
            lo = Math.min(lo, h); hi = Math.max(hi, h); sum += h;
          }
          // level, high enough to clear the roofline, with the crest still standing over it
          const score = (sum / 9) * 0.9 - (hi - lo) * 2.6 - Math.abs(sum / 9 - bestH * 0.55) * 1.2;
          if (score > bestScore) { bestScore = score; hx = cx; hz = zc; targetY = sum / 9; }
        }
      }

      // ---- nine solid boards on scaffolding
      let signCast = [];
      {
        const panel = signPanelTexture(97);
        const letterMat = new THREE.MeshStandardMaterial({
          map: panel, color: 0xfaf6ea, roughness: 0.74, metalness: 0.06,
          // A 16-degree sun this far round to the side rakes the boards' faces at 69 degrees and
          // its own colour is (1.00, 0.62, 0.29) linear, so a white board lit only by it comes out
          // the same orange as the hill behind. The self-illumination is deliberately COOL-white:
          // it lifts green and blue, which is the only axis left in which the letters can separate
          // from an ochre hillside once red has rolled off the top of the tonemap.
          envMapIntensity: 1.1, emissive: 0xfff4e6, emissiveIntensity: night ? 1.4 : 0.34,
        });
        halfHaze(letterMat);
        const timber = halfHaze(new THREE.MeshStandardMaterial({ color: 0x2c2620, roughness: 0.95 }));
        const boards = new THREE.Group();
        const cursor = { x: -spanW / 2 };
        const placed = [];
        for (let i = 0; i < WORD.length; i++) {
          const ch = WORD[i];
          const L = LETTERS[ch];
          const lx = cursor.x;
          cursor.x += L.w + GAPW;
          const cx = (lx + L.w / 2) * CAP;
          // the ground under this letter, and the elevation it is pegged to
          const want = targetY + Math.sin(i * 1.7 + 0.6) * 5.5;
          const lz = clamp(groundZ(hx + cx, want), hz - 70, hz + 70);
          const gy = RG.heightAt(hx + cx, lz);
          // The real sign's boards do not sit on the dirt: they stand on scaffolding, and the row
          // of stilts under the word is half of what tells you they are objects standing on a hill.
          const stilt = R.range(5.5, 9.0);
          const g = new THREE.Group();
          g.position.set(hx + cx, gy + stilt, lz);
          g.rotation.set(-0.10, R.range(-0.06, 0.06), R.range(-0.02, 0.02));   // leant back into the hill
          const board = new THREE.Mesh(letterGeo(ch, 0.055), letterMat);
          board.scale.setScalar(CAP);
          board.position.x = -L.w * CAP / 2;
          board.castShadow = true;
          g.add(board);
          // scaffold, all of it BEHIND the boards (uphill): legs down to the ground, a sill, a mid
          // rail, X-bracing and a back stay driven into the slope.
          const BZ = -1.3;
          for (const f of [-0.36, 0, 0.36]) {
            const bx = f * L.w * CAP;
            const gh = RG.heightAt(hx + cx + bx, lz + BZ);
            const drop = Math.max(2.0, gy + stilt - gh + 1.4);
            const leg = new THREE.Mesh(new THREE.BoxGeometry(1.15, drop, 1.15), timber);
            leg.position.set(bx, -drop / 2 + 0.5, BZ);
            leg.castShadow = true;
            g.add(leg);
          }
          for (const [y, t] of [[0.6, 0.8], [CAP * 0.42, 0.55], [CAP * 0.86, 0.5]]) {
            const rail = new THREE.Mesh(new THREE.BoxGeometry(L.w * CAP * 1.02, t, 0.6), timber);
            rail.position.set(0, y, BZ);
            g.add(rail);
          }
          for (const s of [-1, 1]) {
            const dl = Math.hypot(L.w * CAP * 0.72, CAP * 0.84);
            const br = new THREE.Mesh(new THREE.BoxGeometry(0.5, dl, 0.45), timber);
            br.position.set(0, CAP * 0.44, BZ - 0.1);
            br.rotation.z = s * Math.atan2(L.w * CAP * 0.72, CAP * 0.84);
            g.add(br);
          }
          {                                              // the back stay into the slope
            const gh = RG.heightAt(hx + cx, lz - 14);
            const dy = Math.max(4, gy + stilt + CAP * 0.78 - gh);
            const dl = Math.hypot(dy, 14);
            const st = new THREE.Mesh(new THREE.BoxGeometry(0.6, dl, 0.6), timber);
            st.position.set(0, CAP * 0.78 - dy / 2, BZ - 7);
            st.rotation.x = -Math.atan2(14, dy);
            g.add(st);
          }
          placed.push({ ch, x0: hx + cx - L.w * CAP / 2, z: lz, lift: stilt });
          boards.add(g);
        }
        hill.add(boards);
        signCast = placed;
      }

      // ---- scrub, as GEOMETRY. Most of the brush is painted into the albedo sheet below, which
      // is both cheaper and finer; these 1800 clumps exist for the one thing paint cannot do —
      // break the crest line, so the ridge does not meet the sky on a clean mathematical curve.
      {
        const scrubMat = halfHaze(new THREE.MeshStandardMaterial({
          vertexColors: true, roughness: 1, metalness: 0, flatShading: true, envMapIntensity: 0.22,
        }));
        const sm = new THREE.Mesh(scrubBatch(RG.brush, RG.heightAt, {
          len: LEN, depth: DEP, n: 1800, seed: 91,
        }), scrubMat);
        sm.userData.noMerge = true;
        sm.castShadow = false; sm.receiveShadow = false;
        hill.add(sm);
      }

      // ---- and now the unique albedo sheet, with the scrub, the fire roads and the sign's own
      // cast shadow painted straight onto the terrain. Everything below is in texel space, which
      // maps one-to-one onto the hillside: nothing can sink into a gully or z-fight.
      {
        const cx0 = clamp(hx, -LEN * 0.30, LEN * 0.30);
        const roads = [
          [[cx0 - 880, 470], [cx0 + 210, 352], [cx0 - 600, 246], [cx0 + 350, 148],
            [cx0 - 320, 62], [bestX + 40, -30], [bestX + 400, -66]],
          [[cx0 + 700, 468], [cx0 + 1030, 326], [cx0 + 650, 206], [cx0 + 1000, 86]],
          [[cx0 - 1090, 300], [cx0 - 700, 190], [cx0 - 1020, 96], [cx0 - 640, 10]],
        ];
        const shx = -sunLocal.x / Math.max(0.12, sunLocal.y);
        const shz = -sunLocal.z / Math.max(0.12, sunLocal.y);
        const SHRINK = 0.62;         // the cast runs uphill, where rising ground shortens it

        RG.bake((ctx, W, H, T) => {
          const rr = new RNG(2207);
          // --- brush. 26,000 clumps at 1.3 m per texel, weighted by the same density field the
          // geometry uses, so paint and geometry describe the same hillside.
          const B = RG.brush;
          for (let i = 0; i < 26000; i++) {
            const k = rr.int(0, B.length / 4 - 1) * 4;
            const den = B[k + 2], dark = B[k + 3];
            if (rr.next() > den * 0.9 + 0.06) continue;
            const px = B[k] * W + rr.range(-4, 4);
            const py = (1 - B[k + 1]) * H + rr.range(-4, 4);
            const r = rr.range(1.2, 4.2) * (rr.bool(0.12) ? 1.8 : 1);
            const l = rr.range(0.55, 1.25) * (1 - dark * 0.55);
            ctx.fillStyle = `rgba(${(74 * l) | 0},${(84 * l) | 0},${(46 * l) | 0},${rr.range(0.30, 0.86)})`;
            ctx.beginPath();
            ctx.ellipse(px, py, r, r * rr.range(0.6, 1.0), rr.range(0, 3), 0, 7);
            ctx.fill();
          }
          // --- fire roads: a pale decomposed-granite bench with a bright cut bank on its uphill
          // lip and a shadow line on the fill below it. 9 m wide reads at about 11 px from the road.
          for (const [ri, pts] of roads.entries()) {
            const wpx = (ri ? 7 : 9.6) * T.sx;
            for (const [pass, off, style, wid] of [
              [0, 2.4, 'rgba(52,38,26,0.42)', wpx * 1.05],
              [1, 0, 'rgba(214,188,142,0.90)', wpx],
              [2, -1.9, 'rgba(238,216,176,0.55)', wpx * 0.36],
            ]) {
              ctx.beginPath();
              pts.forEach(([x, z], i) => {
                const px = T.x(x), py = T.z(z) + off;
                if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
              });
              ctx.strokeStyle = style;
              ctx.lineWidth = wid;
              ctx.lineJoin = 'round'; ctx.lineCap = 'round';
              ctx.stroke();
              void pass;
            }
          }
          // --- the shadow the nine boards throw across the slope.
          //
          // The sun's shadow map is a 380 m box that follows the player, so at 780 m the sign
          // casts nothing at all and the boards float. Projecting each letter's own outline along
          // the sun vector into this sheet is exact, conformal and free — and at sixteen degrees
          // of elevation those shadows are three times the height of what throws them, which is
          // most of what makes the word read as nine objects standing on a hillside.
          ctx.save();
          ctx.globalAlpha = 0.80;
          ctx.fillStyle = '#251725';
          for (const it of signCast) {
            const L = LETTERS[it.ch];
            const at = (lx, ly) => {
              const up = it.lift + ly * CAP;
              return [T.x(it.x0 + lx * CAP + shx * up * SHRINK), T.z(it.z + shz * up * SHRINK)];
            };
            ctx.beginPath();
            for (const raw of L.polys || []) {
              raw.forEach(([px, py], i) => {
                const q = at(px, py);
                if (i) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]);
              });
              ctx.closePath();
            }
            for (const bd of L.bands || []) {
              bd.outer.forEach(([px, py], i) => {
                const q = at(px, py);
                if (i) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]);
              });
              for (let i = bd.inner.length - 1; i >= 0; i--) {
                const q = at(bd.inner[i][0], bd.inner[i][1]);
                if (i === bd.inner.length - 1) ctx.moveTo(q[0], q[1]); else ctx.lineTo(q[0], q[1]);
              }
              ctx.closePath();
            }
            ctx.fill('evenodd');
          }
          ctx.restore();
        });
      }

      // ---- rock outcrops along the crest, and the Mount Lee transmission masts above the word
      {
        const rockMat = halfHaze(new THREE.MeshStandardMaterial({
          color: new THREE.Color().setRGB(0.30, 0.245, 0.178), roughness: 0.95, flatShading: true,
        }));
        const rocks = new THREE.Group();
        for (let i = 0; i < 46; i++) {
          const x = R.range(-LEN * 0.36, LEN * 0.36);
          const z = R.range(-140, 220);
          const y = RG.heightAt(x, z);
          if (y < HGT * 0.30) continue;
          const r = R.range(3, 11);
          const m = new THREE.Mesh(new THREE.DodecahedronGeometry(r, 0), rockMat);
          m.position.set(x, y + r * 0.30, z);
          m.rotation.set(R.range(0, 3), R.range(0, 3), R.range(0, 3));
          m.scale.set(1, R.range(0.42, 0.8), R.range(0.7, 1.3));
          rocks.add(m);
        }
        hill.add(rocks);

        const steelM = halfHaze(new THREE.MeshStandardMaterial({ color: 0x2a2b2e, roughness: 0.7, metalness: 0.5 }));
        const beaconM = new THREE.MeshStandardMaterial({
          color: 0x3a0a0a, emissive: 0xff3a24, emissiveIntensity: 3.2, roughness: 0.5,
        });
        for (const [mx, mz, mh] of [[bestX - 26, -66, 52], [bestX + 84, -40, 40], [bestX + 172, -84, 33]]) {
          const base = RG.heightAt(mx, mz);
          const mast = new THREE.Group();
          mast.position.set(mx, base, mz);
          const legR = mh * 0.055;
          for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
            const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.28, mh, 4), steelM);
            leg.position.set(dx * legR, mh / 2, dz * legR);
            leg.rotation.z = -dx * 0.028; leg.rotation.x = dz * 0.028;
            mast.add(leg);
          }
          for (let k = 1; k < 9; k++) {
            const y = (k / 9) * mh;
            const ring = new THREE.Mesh(new THREE.BoxGeometry(legR * 2.1, 0.22, legR * 2.1), steelM);
            ring.position.y = y;
            mast.add(ring);
            for (const s of [0, 1]) {
              const br = new THREE.Mesh(new THREE.BoxGeometry(legR * 2.4, 0.16, 0.16), steelM);
              br.position.set(0, y - mh / 18, s ? legR : -legR);
              br.rotation.z = s ? 0.34 : -0.34;
              mast.add(br);
            }
          }
          const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.2, mh * 0.28, 5), steelM);
          tip.position.y = mh * 1.13;
          mast.add(tip);
          const bead = new THREE.Mesh(new THREE.SphereGeometry(0.9, 6, 5), beaconM);
          bead.position.y = mh * 1.28;
          mast.add(bead);
          hill.add(mast);
        }
      }

      const off = new THREE.Vector3(hx, 0, hz).applyAxisAngle(UP, axisYaw);
      const site = camPos.clone().addScaledVector(cam.tan, DIST);
      hill.position.set(site.x - off.x, -12, site.z - off.z);
      hill.rotation.y = axisYaw;
      // ONE object: the ridge is 2.6 km wide and always either wholly in frame or wholly behind
      // the camera, so chunking it would only cost draw calls. The big buffers inside carry
      // `noMerge` and pass straight through.
      M.take(hill, { chunk: 0 });

      // ---- the two supporting kit landmarks this city keeps: the freeway you pass under on the
      // way to the letters, and the deco tower on the outside of the biggest corner.
      {
        const op = overpass({ len: 320, deckY: 16, cache: kitCache, night, sign: 'DOWNTOWN' });
        const s = track.at(nearU(150));
        op.position.copy(s.pos);
        op.rotation.y = Math.atan2(s.tan.x, s.tan.z);
        out.push(op);
        const hall = landmarkTower({
          h: 210, w: 40, crown: 'ziggurat', night, cache: kitCache, seed: 11,
          wall: '#d8cbb0', glass: '#33455a', litColor: '#ffe0b0', accent: '#ffb020',
          litRatio: 0.35, style: 'artdeco', flood: '#ffe2b4',
        });
        hall.position.copy(sites.corner.pos);
        hall.rotation.y = sites.corner.yaw;
        out.push(hall);
      }
    }

    return M.flush(out);
  },
};

export function build(opts) { return buildCity(def, opts); }

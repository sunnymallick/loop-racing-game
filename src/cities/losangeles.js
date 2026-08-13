import * as THREE from 'three';
import { buildCity, palmTree } from './kit.js';
import { preGamma } from './track.js';
import { drawText } from '../core/font.js';
import { canvas, toTexture, grain, fbmField, normalFromHeight, grayCanvas } from '../core/textures.js';
import { RNG, clamp, lerp, smoothstep } from '../core/rng.js';

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
  const put = (s, x, y) => {
    v.copy(s.p).addScaledVector(s.r, x).addScaledVector(s.u, y);
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

/** 3x3 atlas of graffiti pieces — one texture, one material, so a wall of tags is one draw call. */
function graffitiAtlas(seed) {
  const cell = 256, half = 128;
  const { c, ctx } = canvas(cell * 3, half * 3);
  const rng = new RNG(seed);
  const hues = ['#ff2f6d', '#2fd8e0', '#ffd23a', '#8f5fff', '#ff7a1e', '#f2f0e8', '#38e08a'];
  const words = ['NITRO', 'ESTE', 'DTLA', 'CIRCUIT', '213', 'SUNSET', 'CREW', 'RIOS', 'VATO'];
  for (let i = 0; i < 9; i++) {
    const ox = (i % 3) * cell, oy = Math.floor(i / 3) * half;
    ctx.save();
    ctx.beginPath(); ctx.rect(ox, oy, cell, half); ctx.clip();
    ctx.translate(ox + cell / 2, oy + half / 2);
    ctx.rotate(rng.range(-0.13, 0.13));
    const a = hues[rng.int(0, hues.length - 1)];
    const b = hues[rng.int(0, hues.length - 1)];
    const size = rng.range(50, 64);
    drawText(ctx, words[i], { x: 5, y: 24, size, weight: 0.30, italic: 0.34, align: 'center', color: '#1a1114', tracking: 0.02 });
    drawText(ctx, words[i], { x: 0, y: 20, size, weight: 0.28, italic: 0.34, align: 'center', color: a, tracking: 0.02 });
    drawText(ctx, words[i], { x: -3, y: 16, size: size * 0.74, weight: 0.12, italic: 0.34, align: 'center', color: b, tracking: 0.02 });
    for (let k = 0; k < 130; k++) {                            // overspray
      ctx.fillStyle = `rgba(${rng.int(180, 255)},${rng.int(110, 220)},${rng.int(110, 220)},${rng.range(0.04, 0.20)})`;
      ctx.beginPath(); ctx.arc(rng.range(-100, 100), rng.range(-46, 46), rng.range(0.6, 2.4), 0, 7); ctx.fill();
    }
    ctx.restore();
  }
  return toTexture(c, { srgb: true, wrap: THREE.ClampToEdgeWrapping });
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

// ---------------------------------------------------------------- the city definition

export const def = {
  id: 'la',
  name: 'LOS ANGELES',
  seed: 101,
  spawnU: 0.0,
  laps: 3,
  record: '2:52:40',
  keepOwnLandmarks: true,
  // §8's landmark capture. The kit's default frames the hillside letters down the boulevard — but
  // those are already dead ahead in every chase capture, so the one dedicated landmark frame is
  // spent on the half of the city the chase camera never reaches: the four-level stack overhead,
  // the flood channel down the right kerb, and downtown in the haze at the end of it.
  landmarkU: 0.620,
  look: {
    accent: '#ff7a1e',
    lampColor: '#ffcc86',
    wet: 0,
    // THE smog line. The sky dome's stops sit at 90 deg (top), 14 deg (horizon) and 0 deg (haze),
    // so putting turquoise in BOTH the top and horizon stops and the ochre only in the haze stop
    // makes the warm band a 14-degree wedge along the skyline with clean turquoise above it. That
    // hard warm/cool split is the whole LA identity and the thing that stops the frame going one
    // flat orange, which is where round 1 landed.
    sky: {
      top: '#0e79bd', horizon: '#a4d2d0', ground: '#59402c',
      haze: '#ffab63', sunDir: [-0.80, 0.13, 0.26], sunColor: '#ffdda2', clouds: 0.22, seed: 101,
    },
    // A low key at 3.9 against a deliberately weak sky term. The road faces straight up, so a
    // strong hemisphere light hits it at full strength while a 20-degree sun hits it at 0.34 of
    // its own — which is exactly how round 1 ended up with navy-blue asphalt under a gold sky.
    sun: { color: '#ffd096', intensity: 3.9, dir: [-0.76, 0.31, 0.28] },
    ambient: {
      sky: '#a9dae8', ground: '#96613c', intensity: 0.98,
      fill: { color: '#7fb0d8', intensity: 0.40, dir: [0.58, 0.42, -0.44] },
    },
    // Violet bounce in the shade: at golden hour everything out of the sun is lit by that
    // turquoise sky and nothing else, so the shadows go cool and the frame gets its complement.
    shadowTint: '#6a4a68',
    shadowFill: 0.62,
    // Deep haze, but not so deep that the hillside letters 900 m down the boulevard lose their
    // contrast against the ridge. Everything past the block line still dissolves toward ochre.
    fog: { color: '#e9bd93', near: 210, far: 2000 },
    ground: { color: '#8a7351' },
    sidewalk: '#b3a893',
    grade: {
      uSaturation: 1.32, uExposure: 0.99, uContrast: 1.13,
      uLift: '#131024', uGain: '#fff2de', uVignette: 0.24,
    },
    bloom: { strength: 0.84, radius: 0.60, threshold: 0.74 },
  },
  track: {
    width: 11,
    surface: { tint: '#2b2c31', lanes: 3, centerLine: 'double-yellow', worn: 0.72 },
    bank: 0.05,
    crossings: 8,
    sidewalkWidth: 5.2,
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
    wallColors: ['#e2cda6', '#d6b189', '#c79b7c', '#efe1c6', '#b8a68e'],
    glassColors: ['#2f4a5e', '#24404f', '#3d6070'],
    litColors: ['#ffd9a0', '#ffc478'],
    neonColors: ['#ff3b30', '#ffb020', '#2fd8e0', '#ff2f6d'],
    lowColors: ['#f0e3c8', '#e9c3a2', '#d9cdb2', '#c9d9cc', '#f2d2ba', '#dcb9a6'],
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
    treeColors: ['#6a5fc8', '#7d6ad8', '#57703c'],   // jacaranda in bloom + dusty olive
    streetNames: ['SUNSET BLVD', 'VINE ST', 'LA BREA', 'ALVARADO', 'FIGUEROA', 'MULHOLLAND', 'CAHUENGA'],
    carColors: ['#b8332f', '#2f4f8f', '#cfc9bd', '#2a2c30', '#d8a028', '#5d6d5a'],
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
    const R = rng.fork ? rng.fork(7) : rng;
    const HW = track.halfWidth;

    // ---- shared materials: three concretes, two steels, one water, one atlas each for tags and
    // stains. Everything below shares them, so mergeStatic collapses the lot into ~12 draws.
    const structMat = concreteMaterial('#b7b1a4', 31);      // decks, piers, columns
    const channelMat = concreteMaterial('#cfc7b4', 63);     // channel floor, parapet, K-rail
    const bankMat = concreteMaterial('#c2b9a4', 71);        // the batter wall
    const steel = steelMaterial('#4a4e54', 21);
    const railMat = steelMaterial('#8d9098', 39);
    const tarmacMat = concreteMaterial('#3a3630', 97);      // running surface on the viaducts
    const waterMat = new THREE.MeshStandardMaterial({
      color: 0x2b4a45, roughness: 0.10, metalness: 0.15, envMapIntensity: 2.6,
    });
    const tagTex = graffitiAtlas(511);
    const tagMat = new THREE.MeshStandardMaterial({
      map: tagTex, transparent: true, alphaTest: 0.04, roughness: 0.95,
      depthWrite: false, side: THREE.DoubleSide,
    });
    const stainMat = new THREE.MeshBasicMaterial({
      map: stainTexture(83), transparent: true, color: 0x5f584a, opacity: 0.34, depthWrite: false,
    });
    // Alpha CUTOUT, not blending: an alpha-tested fence keeps correct depth against the palms
    // behind it and mips down to a soft grey haze at distance instead of sorting badly.
    const linkMat = new THREE.MeshBasicMaterial({
      map: chainlinkTexture(), alphaTest: 0.42, side: THREE.DoubleSide, fog: true,
    });

    const push = (geo, mat, { cast = true, receive = true } = {}) => {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = cast; m.receiveShadow = receive;
      out.push(m);
      return m;
    };

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
      for (let i = 0; i < line.length; i++) {
        if (!line[i]) continue;
        const g = new THREE.CylinderGeometry(0.08, 0.08, fh, 5);
        g.translate(0, fh / 2, 0);
        const post = new THREE.Mesh(g, railMat);
        post.position.copy(line[i]);
        post.castShadow = true;
        out.push(post);
        if (i + 1 < line.length && line[i + 1]) {
          const a = line[i], b = line[i + 1];
          const len = a.distanceTo(b);
          const yaw = Math.atan2(b.x - a.x, b.z - a.z);
          for (const ry of [fh - 0.10, fh * 0.06]) {
            const rg = new THREE.CylinderGeometry(0.05, 0.05, len, 4);
            rg.rotateZ(Math.PI / 2);
            const rail = new THREE.Mesh(rg, railMat);
            rail.position.copy(a).lerp(b, 0.5).setY(a.y + ry);
            rail.rotation.y = yaw + Math.PI / 2;
            out.push(rail);
          }
          const mesh = new THREE.PlaneGeometry(len, fh - 0.16);
          const uvA = mesh.attributes.uv;
          for (let q = 0; q < uvA.count; q++) uvA.setXY(q, uvA.getX(q) * (len / 2.2), uvA.getY(q) * ((fh - 0.16) / 2.2));
          uvA.needsUpdate = true;
          const wire = new THREE.Mesh(mesh, linkMat);
          wire.position.copy(a).lerp(b, 0.5).setY(a.y + fh / 2 - 0.02);
          wire.rotation.y = yaw + Math.PI / 2;
          out.push(wire);
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
    for (let i = 0; i < 96; i++) {
      const u = lerp(CH0 + 0.008, CH1 - 0.008, R.next());
      const w = R.range(9, 24), h = w * 0.5;
      const geo = new THREE.PlaneGeometry(w, h);
      const cx = R.int(0, 2), cy = R.int(0, 2);
      const uvA = geo.attributes.uv;
      for (let q = 0; q < uvA.count; q++) uvA.setXY(q, (uvA.getX(q) + cx) / 3, (uvA.getY(q) + cy) / 3);
      uvA.needsUpdate = true;
      const m = new THREE.Mesh(geo, tagMat);
      // biased low on the batter — that is both where a can of paint reaches and the band of
      // wall the driver actually sees over the parapet
      onSlope(m, u, R.range(0.02, 0.62), 0.08);
      out.push(m);
    }
    // grime band along the toe, where the water sits
    for (let i = 0; i < 46; i++) {
      const u = lerp(CH0, CH1, (i + R.range(0.1, 0.9)) / 46);
      const m = new THREE.Mesh(new THREE.PlaneGeometry(R.range(14, 30), R.range(3, 7)), stainMat);
      onSlope(m, u, R.range(0.02, 0.16), 0.05);
      out.push(m);
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
      out.push(m);
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
        out.push(head);
        const barrel = new THREE.Mesh(new THREE.CylinderGeometry(rad, rad, 5.5, 14, 1, true), dark);
        barrel.position.copy(at(61.0, rad * 0.92));
        barrel.rotation.set(0, yaw, Math.PI / 2);
        out.push(barrel);
        const cap = new THREE.Mesh(new THREE.CircleGeometry(rad, 14), dark);
        cap.position.copy(at(63.6, rad * 0.92));
        cap.rotation.set(0, yaw + Math.PI / 2, 0);
        out.push(cap);
        // the apron and the wet trail it leaves across the floor toward the invert
        const trail = new THREE.Mesh(new THREE.PlaneGeometry(rad * 2.6, 13), stainMat);
        trail.position.copy(at(52.0, -0.045));
        trail.rotation.set(-Math.PI / 2, 0, yaw + Math.PI / 2);
        out.push(trail);
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
        out.push(col);
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
          out.push(m);
          // the broken-off parapet stub, tipped over into the channel
          const stub = new THREE.Mesh(new THREE.BoxGeometry(1.3, 1.2, 3.4), channelMat);
          stub.position.copy(s.pos).addScaledVector(s.right, 26.5 + dz * 1.5).setY(0.5);
          stub.rotation.set(0.32 * dz, Math.atan2(s.tan.x, s.tan.z) + 0.4, 0.22);
          stub.castShadow = true;
          out.push(stub);
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
      // traffic frozen on the decks: scale reference, and a reason for the lamps to exist
      {
        const body = new THREE.BoxGeometry(2.0, 1.05, 4.6);
        const roof = new THREE.BoxGeometry(1.75, 0.75, 2.3);
        const cols = ['#c8c4bc', '#2f3a4c', '#a83a30', '#d8b040', '#3a4a3c', '#8c8f96'];
        const mats = cols.map((h) => new THREE.MeshStandardMaterial({
          color: new THREE.Color(preGamma(h)), roughness: 0.42, metalness: 0.25,
        }));
        for (const [st, halfW] of [[A, 12.5], [B, 10.5], [C1, 6.0], [C2, 5.6]]) {
          for (let i = 0; i < (st === A || st === B ? 13 : 4); i++) {
            const idx = Math.floor(R.range(0.08, 0.92) * (st.length - 1));
            const p = st[idx].p, r = st[idx].r;
            const m = mats[R.int(0, mats.length - 1)];
            const lane = R.range(-halfW + 2.6, halfW - 2.6);
            const b = put(body, m);
            b.position.copy(p).addScaledVector(r, lane).setY(p.y + 0.55);
            b.rotation.y = Math.atan2(r.z, r.x) + (R.bool() ? 0 : Math.PI);
            const t = put(roof, m, false);
            t.position.copy(b.position).setY(p.y + 1.42);
            t.rotation.y = b.rotation.y;
          }
        }
      }
      for (const m of local) stack.add(m);
      out.push(stack);
    }

    // ================================================================ 3. downtown in the smog
    //
    // A tight cluster of towers 700 m down the flood-channel straight: close enough to read as
    // massing rather than a paper silhouette, far enough to sit half-way into the fog, and sited
    // on the one axis of the lap with a kilometre of open ground down it. It fills the band
    // between the channel wall (60 m) and the skyline ring (1150 m).
    {
      const skins = [
        towerSkin('#9a8f80', '#3a5468', 5),
        towerSkin('#8a8078', '#2f4a5e', 11),
        towerSkin('#a89a86', '#41607a', 17),
      ];
      const wallMats = skins.map((t) => new THREE.MeshStandardMaterial({
        map: t, roughness: 0.86, metalness: 0.04, envMapIntensity: 0.5,
      }));
      const capMat = new THREE.MeshStandardMaterial({ color: 0x7d7368, roughness: 0.9 });
      const plan = [
        [0, 0, 46, 44, 250, 0], [-72, 40, 40, 40, 176, 1], [64, 58, 38, 46, 198, 2],
        [-30, 106, 52, 40, 148, 1], [110, -22, 36, 36, 128, 0], [-118, -34, 42, 38, 162, 2],
        [26, -74, 34, 44, 116, 1], [150, 74, 40, 40, 214, 2], [-166, 66, 36, 36, 122, 0],
        [80, 150, 44, 40, 158, 1], [-84, 168, 38, 42, 136, 2], [196, -60, 34, 34, 104, 0],
        [-206, -6, 40, 40, 142, 1], [4, 220, 42, 38, 118, 0], [232, 130, 36, 36, 96, 2],
      ];
      const g = new THREE.Group();
      const anchor = track.at(0.700);
      g.position.copy(anchor.pos)
        .addScaledVector(anchor.tan, 760)
        .addScaledVector(anchor.right, -120)
        .setY(0);
      g.rotation.y = Math.atan2(anchor.tan.x, anchor.tan.z) + 0.5;
      for (const [x, z, w, d, h, si] of plan) {
        const H = h * R.range(0.88, 1.12);
        const steps = R.int(1, 3);
        const yaw = R.range(-0.25, 0.25);
        let y = 0, sw = w, sd = d, rem = H;
        for (let k = 0; k < steps; k++) {
          const sh = k === steps - 1 ? rem : rem * R.range(0.42, 0.68);
          const box = new THREE.BoxGeometry(sw, sh, sd);
          const uvA = box.attributes.uv;
          for (let q = 0; q < uvA.count; q++) {
            const face = Math.floor(q / 4);
            const across = (face === 0 || face === 1) ? sd : sw;
            uvA.setXY(q, uvA.getX(q) * (across / 3.4), uvA.getY(q) * (sh / 25));
          }
          uvA.needsUpdate = true;
          const m = new THREE.Mesh(box, wallMats[si]);
          m.position.set(x, y + sh / 2, z);
          m.rotation.y = yaw;
          g.add(m);
          const cap = new THREE.Mesh(new THREE.BoxGeometry(sw * 1.04, 1.6, sd * 1.04), capMat);
          cap.position.set(x, y + sh, z);
          cap.rotation.y = yaw;
          g.add(cap);
          y += sh; rem -= sh;
          sw *= R.range(0.66, 0.86); sd *= R.range(0.66, 0.86);
        }
        if (H > 205) {
          const crown = new THREE.Mesh(new THREE.CylinderGeometry(sw * 0.5, sw * 0.58, 18, 16), capMat);
          crown.position.set(x, y + 9, z);
          g.add(crown);
          const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 1.0, 36, 6), capMat);
          mast.position.set(x, y + 36, z);
          g.add(mast);
        } else if (R.bool(0.42)) {
          const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.8, H * 0.16, 6), capMat);
          mast.position.set(x, y + H * 0.08, z);
          g.add(mast);
        }
      }
      out.push(g);
    }

    // ================================================================ 4. the palm avenue
    //
    // Two heights of palm mixed irregularly: sixty-foot Washingtonias whose crowns clear every
    // roofline on the route (this is the read that survives being in silhouette against a low
    // sun) and squat date palms at street level. Nothing sits on a fixed interval.
    {
      const pcache = new Map();
      for (const side of [-1, 1]) {
        let u = R.range(0, 0.012);
        let i = 0;
        while (u < 1) {
          const s = track.at(u);
          const inChannel = side > 0 && u > CH0 && u < CH1;
          const tall = R.bool(0.6);
          const h = tall ? R.range(17, 27) : R.range(8.5, 13.5);
          // inside the channel stretch the near kerb has no room, so that side's palms stand up
          // on the far berm above the batter wall — a row of crowns over the concrete lip
          const lat = inChannel ? 86 + R.range(0, 8) : HW + R.range(3.6, 9.0);
          const p = palmTree({
            h, seed: i * 7 + (side > 0 ? 101 : 313),
            lean: tall ? R.range(0.015, 0.055) : R.range(0.06, 0.18),
            cache: pcache,
          });
          p.position.copy(s.pos).addScaledVector(s.right, side * lat).setY(inChannel ? 15.9 : 0.16);
          p.rotation.y = R.range(0, 6.28);
          p.scale.setScalar(R.range(0.94, 1.08));
          out.push(p);
          u += (tall ? R.range(20, 36) : R.range(13, 27)) / track.length;
          i++;
        }
      }
      // a deeper second row on the open north side of the boulevard, so the long straight reads as
      // an avenue receding rather than a single lane of trees
      for (let k = 0; k < 30; k++) {
        const u = lerp(0.0, 0.195, k / 29) + R.range(-0.004, 0.004);
        const s = track.at(u);
        const p = palmTree({ h: R.range(19, 28), seed: 900 + k, lean: R.range(0.01, 0.05), cache: pcache });
        p.position.copy(s.pos).addScaledVector(s.right, R.range(48, 74)).setY(0.1);
        p.rotation.y = R.range(0, 6.28);
        out.push(p);
      }
    }

    // ================================================================ 5. barriers and rail
    //
    // Concrete K-rail around the outside of the hairpin, W-beam guard rail on the long sweeper
    // home: the two pieces of road furniture that actually line a Californian road.
    {
      const N = 78;
      for (let i = 0; i < N; i++) {
        const u = lerp(0.325, 0.445, i / (N - 1));
        const s = track.at(u);
        const kr = push(sweep(
          straightRun(0, -2.55, 0, 2.55, 0, 0, 1),
          [[[-0.45, 0], [0.45, 0], [0.22, 0.36], [0.26, 1.02], [-0.26, 1.02], [-0.22, 0.36]]],
          { uvScale: 0.35, caps: true },
        ), channelMat);
        kr.position.copy(s.pos).addScaledVector(s.right, HW + 6.6).setY(0.12);
        kr.rotation.y = Math.atan2(s.tan.x, s.tan.z) + R.range(-0.02, 0.02);
        kr.scale.setScalar(R.range(0.98, 1.03));
      }
      const M = 58;
      let prev = null;
      for (let i = 0; i < M; i++) {
        const u = lerp(0.800, 0.878, i / (M - 1));
        const s = track.at(u);
        const at = s.pos.clone().addScaledVector(s.right, HW + 5.2);
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.18, 1.35, 0.18), railMat);
        post.position.copy(at).setY(0.67);
        post.rotation.y = Math.atan2(s.tan.x, s.tan.z);
        post.castShadow = true;
        out.push(post);
        if (prev) {
          const len = prev.distanceTo(at);
          const beam = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.42, len), railMat);
          beam.position.copy(prev).lerp(at, 0.5).setY(1.02);
          beam.rotation.y = Math.atan2(at.x - prev.x, at.z - prev.z);
          beam.castShadow = true;
          out.push(beam);
        }
        prev = at;
      }
    }

    return out;
  },
};

export function build(opts) { return buildCity(def, opts); }

import * as THREE from 'three';
import { RNG, clamp, lerp, smoothstep } from '../core/rng.js';
import { asphalt, canvas, toTexture, grain, fbmField } from '../core/textures.js';

/**
 * Shared track infrastructure. City builders describe a route as control points and let this
 * module produce the road ribbon, curbs, barriers, shoulders, and the arc-length lookup that
 * race logic and off-track detection need.
 *
 * A CityDef supplies:
 *   main:      [[x,z], ...]                      control points of the main loop (closed)
 *   branches:  [{ points, enterU, exitU, kind }] shortcuts / ramps that rejoin the main route
 *   width:     road half-width in metres (default 9)
 *
 * ART_DIRECTION.md §6.4 caps a city at 70 if no shortcut or ramp is visible from the road, so
 * branch mouths must be *dressed* — see markBranchMouth().
 */

// ------------------------------------------------------------------ road surface texture

/**
 * Road texture laid out across the road: U spans the full width (shoulder→shoulder),
 * V runs along the direction of travel. Markings are therefore crisp and correctly placed,
 * and the texture tiles only along V.
 */
export function roadSurfaceTexture({
  seed = 4, w = 512, h = 1024, tint = '#23252c', wet = 0,
  lanes = 2, centerLine = 'double-yellow', edgeLine = true, dashed = true, worn = 0.6,
} = {}) {
  const rng = new RNG(seed);
  const { c, ctx } = canvas(w, h);

  // --- aggregate base ---
  const coarse = fbmField(w, h, { seed, octaves: 6, scale: 5, warp: 0.5 });
  const fine = fbmField(w, h, { seed: seed + 31, octaves: 4, scale: 42 });
  const base = new THREE.Color(tint);
  const img = ctx.createImageData(w, h);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const u = x / w;
      let l = 0.74 + (fine[i] - 0.5) * 0.80 + (coarse[i] - 0.5) * 0.32;
      if (fine[i] > 0.80) l += (fine[i] - 0.80) * 1.5;
      // tyre-polished wheel tracks: two darker, smoother bands per lane
      for (let ln = 0; ln < lanes * 2; ln++) {
        const cx = (ln + 0.5) / (lanes * 2);
        const band = Math.exp(-Math.pow((u - cx) / 0.055, 2));
        l *= 1 - band * 0.16 * worn;
      }
      l = clamp(l, 0.2, 1.8);
      const o = i * 4;
      d[o] = clamp(base.r * 255 * l, 0, 255);
      d[o + 1] = clamp(base.g * 255 * l, 0, 255);
      d[o + 2] = clamp(base.b * 255 * l, 0, 255);
      d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // --- cracks & patches ---
  ctx.strokeStyle = 'rgba(6,6,9,0.5)'; ctx.lineCap = 'round';
  for (let k = 0; k < 18; k++) {
    let x = rng.range(0, w), y = rng.range(0, h), a = rng.range(0, 7);
    ctx.lineWidth = rng.range(0.6, 2.0);
    ctx.beginPath(); ctx.moveTo(x, y);
    for (let s = 0, n = rng.int(5, 16); s < n; s++) {
      a += rng.range(-0.8, 0.8); x += Math.cos(a) * rng.range(8, 30); y += Math.sin(a) * rng.range(8, 30);
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // --- markings ---
  const paint = (x0, x1, opts = {}) => {
    const { color = '#e8e6df', dash = 0, period = 0, alpha = 0.88 } = opts;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    if (!dash) ctx.fillRect(x0, 0, x1 - x0, h);
    else for (let y = 0; y < h; y += period) ctx.fillRect(x0, y, x1 - x0, dash);
    ctx.restore();
  };

  const lw = w * 0.016;                       // line width in px
  if (edgeLine) {
    paint(w * 0.035, w * 0.035 + lw, { color: '#eceadf', alpha: 0.80 });
    paint(w * 0.965 - lw, w * 0.965, { color: '#eceadf', alpha: 0.80 });
  }
  if (centerLine === 'double-yellow') {
    paint(w * 0.5 - lw * 1.9, w * 0.5 - lw * 0.6, { color: '#e8b53a', alpha: 0.85 });
    paint(w * 0.5 + lw * 0.6, w * 0.5 + lw * 1.9, { color: '#e8b53a', alpha: 0.85 });
  } else if (centerLine === 'single-yellow') {
    paint(w * 0.5 - lw * 0.5, w * 0.5 + lw * 0.5, { color: '#e8b53a', alpha: 0.85 });
  } else if (centerLine === 'white') {
    paint(w * 0.5 - lw * 0.5, w * 0.5 + lw * 0.5, { color: '#eceadf', alpha: 0.8 });
  }
  if (dashed && lanes > 1) {
    for (let i = 1; i < lanes; i++) {
      const u = i / lanes;
      if (Math.abs(u - 0.5) < 0.02) continue;
      paint(w * u - lw * 0.5, w * u + lw * 0.5, { color: '#eceadf', dash: h * 0.055, period: h * 0.14, alpha: 0.72 });
    }
  }

  // scuff the paint so it doesn't look freshly applied
  ctx.globalCompositeOperation = 'destination-out';
  for (let k = 0; k < 260; k++) {
    ctx.globalAlpha = rng.range(0.05, 0.42) * worn;
    const x = rng.range(0, w), y = rng.range(0, h);
    ctx.beginPath(); ctx.ellipse(x, y, rng.range(2, 16), rng.range(4, 30), rng.range(0, 3), 0, 7); ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  grain(ctx, w, h, 6, rng);

  const rough = new Float32Array(w * h);
  for (let i = 0; i < rough.length; i++) {
    let r = 0.88 + (fine[i] - 0.5) * 0.20;
    if (wet) r = lerp(r, 0.12 + (fine[i] - 0.5) * 0.09, wet);
    rough[i] = clamp(r, 0.05, 1);
  }
  const { c: rc, ctx: rctx } = canvas(w, h);
  const rimg = rctx.createImageData(w, h);
  for (let i = 0; i < rough.length; i++) {
    const v = rough[i] * 255;
    rimg.data[i * 4] = rimg.data[i * 4 + 1] = rimg.data[i * 4 + 2] = v; rimg.data[i * 4 + 3] = 255;
  }
  rctx.putImageData(rimg, 0, 0);

  const map = toTexture(c, { srgb: true });
  map.wrapS = THREE.ClampToEdgeWrapping;   // across the road: no repeat
  map.wrapT = THREE.RepeatWrapping;        // along the road: tile
  const roughnessMap = toTexture(rc, { srgb: false });
  roughnessMap.wrapS = THREE.ClampToEdgeWrapping;
  roughnessMap.wrapT = THREE.RepeatWrapping;
  return { map, roughnessMap };
}

// ------------------------------------------------------------------ Track

export class Track {
  /**
   * @param def.main    [[x,z],...] control points, closed loop
   * @param def.width   half-width in metres
   * @param def.heights optional [y,...] per control point for elevation change
   */
  constructor(def) {
    this.def = def;
    this.halfWidth = def.width ?? 9;
    const pts = def.main.map((p, i) => new THREE.Vector3(p[0], (def.heights?.[i] ?? p[2] ?? 0), p[1]));
    this.curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal', 0.5);
    this.length = this.curve.getLength();

    // arc-length resample for fast nearest-point and even prop spacing
    this.N = Math.max(400, Math.floor(this.length / 3));
    this.samples = [];
    for (let i = 0; i < this.N; i++) {
      const u = i / this.N;
      const pos = this.curve.getPointAt(u);
      const tan = this.curve.getTangentAt(u).normalize();
      const right = new THREE.Vector3().crossVectors(tan, new THREE.Vector3(0, 1, 0)).normalize();
      this.samples.push({ u, pos, tan, right });
    }
    this.branches = (def.branches || []).map((b, i) => new Branch(this, b, i));
  }

  at(u) {
    u = ((u % 1) + 1) % 1;
    const f = u * this.N;
    const i = Math.floor(f) % this.N;
    const j = (i + 1) % this.N;
    const t = f - Math.floor(f);
    const a = this.samples[i], b = this.samples[j];
    return {
      u,
      pos: a.pos.clone().lerp(b.pos, t),
      tan: a.tan.clone().lerp(b.tan, t).normalize(),
      right: a.right.clone().lerp(b.right, t).normalize(),
    };
  }

  /** Point on the road surface at (u, lateral) where lateral is -1..1 across the width. */
  point(u, lateral = 0, lift = 0) {
    const s = this.at(u);
    return s.pos.clone().addScaledVector(s.right, lateral * this.halfWidth).setY(s.pos.y + lift);
  }

  /** Nearest track position to a world point. `hintU` restricts the search for speed. */
  nearest(p, hintU = null) {
    let bi = 0, bd = Infinity;
    if (hintU === null) {
      for (let i = 0; i < this.N; i++) {
        const d = this.samples[i].pos.distanceToSquared(p);
        if (d < bd) { bd = d; bi = i; }
      }
    } else {
      const c = Math.floor(hintU * this.N);
      const span = Math.max(12, Math.floor(this.N * 0.06));
      for (let k = -span; k <= span; k++) {
        const i = ((c + k) % this.N + this.N) % this.N;
        const d = this.samples[i].pos.distanceToSquared(p);
        if (d < bd) { bd = d; bi = i; }
      }
    }
    const s = this.samples[bi];
    const off = p.clone().sub(s.pos);
    const lateral = off.dot(s.right) / this.halfWidth;
    const ahead = off.dot(s.tan);
    return { u: s.u + (ahead / this.length), lateral, dist: Math.sqrt(bd), sample: s };
  }

  /** Signed curvature at u — used by AI, camera lean, and banking. */
  curvature(u) {
    const a = this.at(u - 0.004), b = this.at(u), c = this.at(u + 0.004);
    const v1 = b.pos.clone().sub(a.pos), v2 = c.pos.clone().sub(b.pos);
    const cross = v1.x * v2.z - v1.z * v2.x;
    const denom = (v1.length() * v2.length()) || 1;
    return cross / denom;
  }

  /**
   * Road ribbon with shoulders and curbs.
   * @returns THREE.Group  (userData.road = the surface mesh, for raycast/skid decals)
   */
  buildRoad({
    segments = null, material = null, surface = {}, shoulder = true,
    curb = 'stripe', curbWidth = 1.1, uvScale = 0.055, bankStrength = 0.0,
  } = {}) {
    const segs = segments || this.N;
    const g = new THREE.Group();
    g.name = 'road';

    const tex = roadSurfaceTexture(surface);
    tex.map.repeat.set(1, this.length * uvScale);
    tex.roughnessMap.repeat.set(1, this.length * uvScale);

    const mat = material || new THREE.MeshStandardMaterial({
      map: tex.map, roughnessMap: tex.roughnessMap,
      roughness: 1.0, metalness: 0.02,
      envMapIntensity: surface.wet ? 1.35 : 0.45,
    });

    // --- main surface ---
    const pos = [], uv = [], nor = [], idx = [];
    for (let i = 0; i <= segs; i++) {
      const u = i / segs;
      const s = this.at(u);
      const bank = bankStrength * this.curvature(u) * 40;
      const up = new THREE.Vector3(0, 1, 0);
      const r = s.right.clone().applyAxisAngle(s.tan, bank);
      const n = new THREE.Vector3().crossVectors(r, s.tan).normalize();
      if (n.y < 0) n.negate();
      for (let k = 0; k <= 1; k++) {
        const lat = k * 2 - 1;
        const p = s.pos.clone().addScaledVector(r, lat * this.halfWidth);
        pos.push(p.x, p.y + 0.02, p.z);
        uv.push(k, u * this.length * uvScale);
        nor.push(n.x, n.y, n.z);
      }
      if (i < segs) {
        const a = i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
      void up;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setIndex(idx);
    const road = new THREE.Mesh(geo, mat);
    road.receiveShadow = true;
    road.name = 'roadSurface';
    g.add(road);
    g.userData.road = road;

    // --- shoulders: a wider, darker apron so the road never ends in mid-air ---
    if (shoulder) {
      const sp = [], su = [], sn = [], si = [];
      const shW = 7.0;
      for (let i = 0; i <= segs; i++) {
        const u = i / segs;
        const s = this.at(u);
        for (const side of [-1, 1]) {
          const inner = s.pos.clone().addScaledVector(s.right, side * this.halfWidth);
          const outer = s.pos.clone().addScaledVector(s.right, side * (this.halfWidth + shW));
          sp.push(inner.x, inner.y + 0.012, inner.z);
          sp.push(outer.x, outer.y - 0.22, outer.z);
          su.push(0, u * this.length * 0.06); su.push(1, u * this.length * 0.06);
          sn.push(0, 1, 0); sn.push(0, 1, 0);
        }
        if (i < segs) {
          const a = i * 4;
          si.push(a, a + 1, a + 4, a + 1, a + 5, a + 4);
          si.push(a + 2, a + 6, a + 3, a + 3, a + 6, a + 7);
        }
      }
      const sg = new THREE.BufferGeometry();
      sg.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
      sg.setAttribute('uv', new THREE.Float32BufferAttribute(su, 2));
      sg.setAttribute('normal', new THREE.Float32BufferAttribute(sn, 3));
      sg.setIndex(si);
      const asp = asphalt({ seed: 12, tint: '#3a3a3e' });
      const shMat = new THREE.MeshStandardMaterial({
        map: asp.map, roughnessMap: asp.roughnessMap, normalMap: asp.normalMap, roughness: 1,
      });
      asp.map.repeat.set(3, this.length * 0.05);
      const sm = new THREE.Mesh(sg, shMat);
      sm.receiveShadow = true;
      g.add(sm);
    }

    // --- curbs: the red/white striped rumble strip seen in every reference frame ---
    if (curb) {
      const stripeTex = curbStripeTexture();
      const cm = new THREE.MeshStandardMaterial({ map: stripeTex, roughness: 0.62, metalness: 0.0 });
      for (const side of [-1, 1]) {
        const cp = [], cu = [], cn = [], ci = [];
        for (let i = 0; i <= segs; i++) {
          const u = i / segs;
          const s = this.at(u);
          const inner = s.pos.clone().addScaledVector(s.right, side * this.halfWidth);
          const outer = s.pos.clone().addScaledVector(s.right, side * (this.halfWidth + curbWidth));
          cp.push(inner.x, inner.y + 0.03, inner.z);
          cp.push(outer.x, outer.y + 0.13, outer.z);
          const v = u * this.length * 0.16;
          cu.push(0, v); cu.push(1, v);
          cn.push(0, 1, 0); cn.push(0, 1, 0);
          if (i < segs) { const a = i * 2; ci.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
        }
        const cg = new THREE.BufferGeometry();
        cg.setAttribute('position', new THREE.Float32BufferAttribute(cp, 3));
        cg.setAttribute('uv', new THREE.Float32BufferAttribute(cu, 2));
        cg.setAttribute('normal', new THREE.Float32BufferAttribute(cn, 3));
        cg.setIndex(ci);
        const m = new THREE.Mesh(cg, cm);
        m.receiveShadow = true;
        g.add(m);
      }
    }
    return g;
  }

  /** Evenly spaced positions along the track for prop placement. */
  *spaced(spacing, { side = 1, offset = 1.2, jitter = 0, rng = new RNG(1), from = 0, to = 1 } = {}) {
    const n = Math.floor((this.length * (to - from)) / spacing);
    for (let i = 0; i < n; i++) {
      const u = from + (i * spacing) / this.length + (jitter ? rng.range(-jitter, jitter) / this.length : 0);
      const s = this.at(u);
      const off = offset + (jitter ? rng.range(-jitter, jitter) * 0.1 : 0);
      yield {
        u,
        pos: s.pos.clone().addScaledVector(s.right, side * (this.halfWidth + off)),
        tan: s.tan, right: s.right, index: i,
      };
    }
  }
}

class Branch {
  constructor(track, def, index) {
    this.def = def; this.index = index; this.kind = def.kind || 'shortcut';
    const a = track.at(def.enterU), b = track.at(def.exitU);
    const pts = [
      a.pos.clone(),
      ...def.points.map((p) => new THREE.Vector3(p[0], p[2] ?? a.pos.y, p[1])),
      b.pos.clone(),
    ];
    this.curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0.5);
    this.length = this.curve.getLength();
    this.halfWidth = def.width ?? track.halfWidth * 0.62;
    this.enterU = def.enterU; this.exitU = def.exitU;

    // arc-length samples so the player can actually be detected as "on the shortcut"
    this.N = Math.max(24, Math.floor(this.length / 3));
    this.samples = [];
    for (let i = 0; i <= this.N; i++) {
      const t = i / this.N;
      const pos = this.curve.getPointAt(t);
      const tan = this.curve.getTangentAt(t).normalize();
      const right = new THREE.Vector3().crossVectors(tan, new THREE.Vector3(0, 1, 0)).normalize();
      const rise = this.kind === 'ramp' ? Math.sin(t * Math.PI) * (this.def.rise ?? 6) : 0;
      this.samples.push({ t, pos: pos.clone().setY(pos.y + rise), tan, right, rise });
    }
  }

  /** Nearest point on this branch to a world position. */
  nearest(p) {
    let bi = 0, bd = Infinity;
    for (let i = 0; i <= this.N; i++) {
      const d = this.samples[i].pos.distanceToSquared(p);
      if (d < bd) { bd = d; bi = i; }
    }
    const s = this.samples[bi];
    const off = p.clone().sub(s.pos);
    return {
      branch: this, t: s.t, sample: s,
      lateral: off.dot(s.right) / this.halfWidth,
      dist: Math.sqrt(bd),
      groundY: s.pos.y,
    };
  }

  buildRoad(opts = {}) {
    const segs = Math.max(24, Math.floor(this.length / 2.5));
    const g = new THREE.Group();
    const tex = roadSurfaceTexture({
      lanes: 1, centerLine: 'none', dashed: false, worn: 0.85, ...(opts.surface || {}),
    });
    tex.map.repeat.set(1, this.length * 0.06);
    tex.roughnessMap.repeat.set(1, this.length * 0.06);
    const mat = new THREE.MeshStandardMaterial({
      map: tex.map, roughnessMap: tex.roughnessMap, roughness: 1, metalness: 0.02,
      envMapIntensity: opts.surface?.wet ? 1.2 : 0.4,
    });
    const pos = [], uv = [], nor = [], idx = [];
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const p = this.curve.getPointAt(t);
      const tan = this.curve.getTangentAt(t).normalize();
      const right = new THREE.Vector3().crossVectors(tan, new THREE.Vector3(0, 1, 0)).normalize();
      // ramps arc upward through the middle of the branch
      const rise = this.kind === 'ramp' ? Math.sin(t * Math.PI) * (this.def.rise ?? 6) : 0;
      for (let k = 0; k <= 1; k++) {
        const q = p.clone().addScaledVector(right, (k * 2 - 1) * this.halfWidth);
        pos.push(q.x, q.y + 0.03 + rise, q.z);
        uv.push(k, t * this.length * 0.06);
        nor.push(0, 1, 0);
      }
      if (i < segs) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, mat);
    m.receiveShadow = true;
    g.add(m);
    g.userData.road = m;
    return g;
  }
}

/** Red/white diagonal rumble-strip texture (reference f&f1, f&f2, f&f5). */
export function curbStripeTexture({ size = 128, a = '#d92b2b', b = '#f2f0ea' } = {}) {
  const { c, ctx } = canvas(size, size);
  ctx.fillStyle = b; ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = a;
  ctx.fillRect(0, 0, size, size / 2);
  const rng = new RNG(9);
  ctx.globalCompositeOperation = 'multiply';
  for (let k = 0; k < 40; k++) {
    ctx.fillStyle = `rgba(${rng.int(120, 200)},${rng.int(120, 200)},${rng.int(120, 200)},0.25)`;
    ctx.fillRect(rng.range(0, size), rng.range(0, size), rng.range(3, 24), rng.range(3, 24));
  }
  ctx.globalCompositeOperation = 'source-over';
  grain(ctx, size, size, 8, rng);
  const t = toTexture(c, { srgb: true });
  t.wrapS = THREE.ClampToEdgeWrapping;
  return t;
}

/** Boost-strip texture: emissive chevrons, as in reference f&f1. */
export function boostStripTexture({ size = 256, color = '#ff8a1e' } = {}) {
  const { c, ctx } = canvas(size, size);
  ctx.fillStyle = '#140a04'; ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = color; ctx.lineWidth = size * 0.10; ctx.lineCap = 'butt';
  for (let i = -2; i < 6; i++) {
    const y = (i / 4) * size;
    ctx.beginPath();
    ctx.moveTo(0, y + size * 0.16);
    ctx.lineTo(size * 0.5, y);
    ctx.lineTo(size, y + size * 0.16);
    ctx.stroke();
  }
  return toTexture(c, { srgb: true });
}

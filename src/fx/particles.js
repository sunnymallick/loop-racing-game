import * as THREE from 'three';
import { RNG, clamp } from '../core/rng.js';
import { canvas, toTexture, fbmField } from '../core/textures.js';

/**
 * Pooled particle system + world decals.
 *
 * ART_DIRECTION.md §7 caps "particles as unrotated camera-facing squares with visible hard edges"
 * at 58, so nothing here is a plain camera-facing square:
 *   - every particle carries rotation + rotation speed, and the fragment shader rotates the sprite;
 *   - sparks are *velocity-aligned in screen space* and stretched into streaks (uStretch), which is
 *     what makes a spark read as a spark and not a dot;
 *   - each pool draws from a 2x2 procedural sprite ATLAS, so a smoke cloud is four different
 *     silhouettes rather than one shape repeated;
 *   - every sprite fades to zero alpha well inside its tile, so there is no quad edge to see.
 *
 * Everything is generated in code at load time (no image files) and seeded from RNG.
 */

// ---------------------------------------------------------------- sprite atlases

const _texCache = new Map();

/** Build (and cache) a `tiles x tiles` sprite atlas. `drawTile(ctx, index, size, rng)`. */
function atlas(key, tiles, tileSize, drawTile) {
  if (_texCache.has(key)) return _texCache.get(key);
  const size = tiles * tileSize;
  const { c, ctx } = canvas(size, size);
  ctx.clearRect(0, 0, size, size);
  for (let i = 0; i < tiles * tiles; i++) {
    const tile = canvas(tileSize, tileSize);
    tile.ctx.clearRect(0, 0, tileSize, tileSize);
    drawTile(tile.ctx, i, tileSize, new RNG(9173 + i * 977 + key.length * 31));
    ctx.drawImage(tile.c, (i % tiles) * tileSize, Math.floor(i / tiles) * tileSize);
  }
  const t = toTexture(c, { srgb: true, wrap: THREE.ClampToEdgeWrapping, aniso: 4, flipY: false });
  t.generateMipmaps = false;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  _texCache.set(key, t);
  return t;
}

/** Per-pixel tile painter. `fn(u, v, rng)` → [r,g,b,a] in 0..1, u/v in 0..1. */
function paint(ctx, s, fn) {
  const img = ctx.createImageData(s, s);
  const d = img.data;
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const o = (y * s + x) * 4;
      const c = fn((x + 0.5) / s, (y + 0.5) / s);
      d[o] = clamp(c[0], 0, 1) * 255;
      d[o + 1] = clamp(c[1], 0, 1) * 255;
      d[o + 2] = clamp(c[2], 0, 1) * 255;
      d[o + 3] = clamp(c[3], 0, 1) * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/**
 * Four billowing smoke puffs. Alpha is a lumpy fbm-eroded blob (never a disc); RGB carries baked
 * self-shading so a cloud has a lit side and a shadow side instead of reading as flat grey.
 */
export function smokeAtlas(seed = 5) {
  return atlas(`smoke${seed}`, 2, 256, (ctx, i, s, rng) => {
    const blobs = [13, 17, 11, 15][i];
    const spread = [0.30, 0.24, 0.34, 0.27][i];
    ctx.globalCompositeOperation = 'source-over';
    for (let b = 0; b < blobs; b++) {
      const a = rng.range(0, Math.PI * 2), d = rng.range(0, s * spread);
      const x = s * 0.5 + Math.cos(a) * d, y = s * 0.5 + Math.sin(a) * d * 0.88;
      const r = rng.range(s * 0.15, s * 0.30);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(255,255,255,0.52)');
      g.addColorStop(0.5, 'rgba(255,255,255,0.30)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
    }
    // erode the silhouette with fbm so the edge is torn, and bake volumetric shading into RGB
    const img = ctx.getImageData(0, 0, s, s);
    const d2 = img.data;
    const f = fbmField(s, s, { seed: seed + i * 13 + 3, octaves: 5, scale: 3.4, warp: 0.7 });
    const fs = fbmField(s, s, { seed: seed + i * 13 + 71, octaves: 3, scale: 1.7 });
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const k = y * s + x, o = k * 4;
        const nx = (x + 0.5) / s - 0.5, ny = (y + 0.5) / s - 0.5;
        const rad = Math.hypot(nx, ny);
        let a = d2[o + 3] / 255;
        a *= clamp(f[k] * 2.30 - 0.40, 0, 1);
        // Fade well inside the tile (no quad edge) over a LONG shoulder: a short shoulder plus the
        // saturating boost below turns every puff into a hard-edged white disc, and a cloud made of
        // hard discs reads as beads rather than smoke.
        a *= sstep(0.5, 0.17, rad);
        // shading: key from upper-left, ambient occlusion toward the core underside
        const lit = 0.58 + 0.42 * sstep(0.62, 0.05, rad + ny * 0.55 + nx * 0.35) + (fs[k] - 0.5) * 0.30;
        const l = clamp(lit, 0.30, 1.0);
        d2[o] = 255 * l; d2[o + 1] = 255 * l; d2[o + 2] = 255 * l;
        d2[o + 3] = 255 * clamp(a * 1.55, 0, 1);
      }
    }
    ctx.putImageData(img, 0, 0);
  });
}

/**
 * Sparks. 0 = long tapered streak with a hot head, 1 = short fat streak, 2 = falling ember,
 * 3 = four-point flare. The streaks are what stop a spark shower reading as confetti dots.
 */
export function sparkAtlas() {
  return atlas('spark', 2, 128, (ctx, i, s) => {
    if (i === 0 || i === 1) {
      const u0 = i === 0 ? 0.02 : 0.30;          // tail start
      const th = i === 0 ? 0.030 : 0.055;        // half-thickness at the head
      paint(ctx, s, (u, v) => {
        const y = v - 0.5;
        const t = clamp((u - u0) / (0.94 - u0), 0, 1);
        const w = th * (0.18 + 0.82 * Math.pow(t, 0.6)) + 0.004;
        const core = Math.exp(-(y * y) / (w * w) * 2.3);
        const body = core * Math.pow(t, 1.7) * sstep(1.0, 0.90, u);
        const hx = u - 0.86, hy = y;
        const head = Math.exp(-(hx * hx + hy * hy) / (0.030 * 0.030)) * 1.15;
        const a = clamp(body + head, 0, 1);
        const hot = clamp(body * 0.55 + head, 0, 1);
        // white-hot at the head, amber down the tail
        return [1, 0.62 + 0.38 * hot, 0.26 + 0.74 * hot * hot, a];
      });
    } else if (i === 2) {
      paint(ctx, s, (u, v) => {
        const x = u - 0.5, y = v - 0.5;
        const r = Math.hypot(x, y);
        const core = Math.exp(-(r * r) / (0.045 * 0.045));
        const halo = Math.exp(-(r * r) / (0.20 * 0.20)) * 0.42;
        const a = clamp(core + halo, 0, 1) * sstep(0.5, 0.36, r);
        const hot = clamp(core, 0, 1);
        return [1, 0.55 + 0.45 * hot, 0.18 + 0.82 * hot, a];
      });
    } else {
      paint(ctx, s, (u, v) => {
        const x = u - 0.5, y = v - 0.5;
        const r = Math.hypot(x, y);
        const core = Math.exp(-(r * r) / (0.035 * 0.035));
        const halo = Math.exp(-(r * r) / (0.16 * 0.16)) * 0.35;
        const spikes = Math.exp(-(y * y) / (0.006 * 0.006)) * Math.exp(-(x * x) / (0.10 * 0.10)) * 0.7
          + Math.exp(-(x * x) / (0.006 * 0.006)) * Math.exp(-(y * y) / (0.10 * 0.10)) * 0.7;
        const a = clamp(core + halo + spikes, 0, 1) * sstep(0.5, 0.34, r);
        return [1, 0.80, 0.62 + 0.38 * clamp(core, 0, 1), a];
      });
    }
  });
}

/** Glows. 0 = soft glow, 1 = impact flash (core + anisotropic spikes), 2 = shock ring, 3 = wide halo. */
export function glowAtlas() {
  return atlas('glow', 2, 192, (ctx, i, s, rng) => {
    if (i === 0) {
      paint(ctx, s, (u, v) => {
        const r = Math.hypot(u - 0.5, v - 0.5);
        const a = Math.exp(-(r * r) / (0.115 * 0.115)) * 0.9 + Math.exp(-(r * r) / (0.26 * 0.26)) * 0.35;
        return [1, 1, 1, clamp(a, 0, 1) * sstep(0.5, 0.32, r)];
      });
    } else if (i === 1) {
      const arms = [];
      for (let k = 0; k < 7; k++) arms.push({ a: rng.range(0, Math.PI * 2), l: rng.range(0.16, 0.46), w: rng.range(0.010, 0.028) });
      paint(ctx, s, (u, v) => {
        const x = u - 0.5, y = v - 0.5;
        const r = Math.hypot(x, y);
        let a = Math.exp(-(r * r) / (0.070 * 0.070)) + Math.exp(-(r * r) / (0.18 * 0.18)) * 0.42;
        const ang = Math.atan2(y, x);
        for (const s2 of arms) {
          let da = ang - s2.a;
          da = Math.atan2(Math.sin(da), Math.cos(da));
          a += Math.exp(-(da * da) / (s2.w * 2.2)) * Math.exp(-(r * r) / (s2.l * s2.l * 0.30)) * 0.55;
        }
        const hot = clamp(Math.exp(-(r * r) / (0.10 * 0.10)), 0, 1);
        return [1, 0.86 + 0.14 * hot, 0.62 + 0.38 * hot, clamp(a, 0, 1) * sstep(0.5, 0.30, r)];
      });
    } else if (i === 2) {
      paint(ctx, s, (u, v) => {
        const x = u - 0.5, y = v - 0.5;
        const r = Math.hypot(x, y);
        const ring = Math.exp(-Math.pow((r - 0.36) / 0.045, 2));
        const inner = Math.exp(-Math.pow((r - 0.30) / 0.13, 2)) * 0.16;
        const ang = Math.atan2(y, x);
        const flick = 0.78 + 0.22 * Math.sin(ang * 11.0);
        return [1, 0.93, 0.80, clamp(ring * flick + inner, 0, 1) * sstep(0.5, 0.44, r)];
      });
    } else {
      paint(ctx, s, (u, v) => {
        const r = Math.hypot(u - 0.5, v - 0.5);
        const a = Math.exp(-(r * r) / (0.24 * 0.24)) * 0.65;
        return [1, 1, 1, clamp(a, 0, 1) * sstep(0.5, 0.30, r)];
      });
    }
  });
}

/** Debris chunks: irregular tumbling shards with a bevel highlight, feathered so they never alias. */
export function debrisAtlas() {
  return atlas('debris', 2, 96, (ctx, i, s, rng) => {
    const n = 5 + i;
    const pts = [];
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + rng.range(-0.35, 0.35);
      const r = s * rng.range(0.17, 0.33) * (i === 3 ? 1.0 : 1.0);
      pts.push([s / 2 + Math.cos(a) * r * (i === 1 ? 1.5 : 1), s / 2 + Math.sin(a) * r * (i === 1 ? 0.55 : 1)]);
    }
    ctx.save();
    ctx.filter = 'blur(1.1px)';
    const g = ctx.createLinearGradient(s * 0.2, s * 0.15, s * 0.8, s * 0.9);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.45, 'rgba(150,150,155,1)');
    g.addColorStop(1, 'rgba(52,52,58,1)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k][0], pts[k][1]);
    ctx.closePath(); ctx.fill();
    // bevel: a bright sliver along one edge so a tumbling chunk flickers as it rotates
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = 'rgba(255,255,255,0.42)';
    ctx.lineWidth = s * 0.035;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    ctx.lineTo(pts[1][0], pts[1][1]);
    ctx.lineTo(pts[2][0], pts[2][1]);
    ctx.stroke();
    ctx.restore();
  });
}

/** Ground decals: 0 = scorch, 1 = rubber smear, 2 = dust scuff, 3 = scatter shadow. */
export function decalAtlas() {
  return atlas('decal', 2, 256, (ctx, i, s, rng) => {
    const f = fbmField(s, s, { seed: 300 + i * 29, octaves: 5, scale: 4.5, warp: 0.9 });
    const streaks = rng.range(0, Math.PI * 2);
    paint(ctx, s, (u, v) => {
      const x = u - 0.5, y = v - 0.5;
      const r = Math.hypot(x, y);
      const k = Math.min(s * s - 1, (Math.floor(v * s) * s + Math.floor(u * s)) | 0);
      const n = f[k];
      let a = 0;
      if (i === 0) {
        a = sstep(0.48, 0.05, r) * (0.55 + n * 0.85);
        const ang = Math.atan2(y, x) - streaks;
        a *= 0.72 + 0.28 * Math.abs(Math.sin(ang * 5.0));
      } else if (i === 1) {
        a = sstep(0.5, 0.12, Math.abs(y) * 2.2) * sstep(0.5, 0.18, Math.abs(x)) * (0.45 + n * 0.9);
      } else if (i === 2) {
        a = sstep(0.5, 0.10, r) * (0.30 + n * 0.7) * 0.75;
      } else {
        a = sstep(0.45, 0.10, r) * (0.25 + n * 0.55);
      }
      const tone = 0.55 + n * 0.45;
      return [tone, tone, tone, clamp(a, 0, 1)];
    });
  });
}

// ---------------------------------------------------------------- particle pool

const VERT = /* glsl */`
  attribute float aSize;
  attribute float aRot;
  attribute float aAlpha;
  attribute vec3 aColor;
  attribute vec3 aVel;
  attribute vec3 aMeta;          // x: stretch, y: tile index, z: velocity-align flag
  varying float vRot;
  varying float vAlpha;
  varying vec3 vColor;
  varying float vStretch;
  varying vec2 vTile;
  uniform float uPixelRatio;
  uniform float uHeight;
  uniform float uTiles;
  uniform float uMaxPx;
  uniform vec2 uDepthBias;       // x: metres of pull per unit size, y: hard cap in metres
  void main(){
    vAlpha = aAlpha; vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);

    // A point sprite carries ONE depth for its whole quad, so a puff sitting on the road is
    // clipped along the straight line where the road plane crosses that depth — a dead-straight
    // horizontal cut through the smoke, which is precisely the ART_DIRECTION §7 "hard-edged
    // camera-facing quad" tell. A billboard is standing in for a SPHERE, so depth-test it at the
    // sphere's near face instead of its centre: the puff then sits in front of the tarmac it is
    // rolling over and there is nothing to slice. Capped so a puff can only ever win by about its
    // own radius, and the SIZE below still uses the true (unbiased) distance.
    vec4 dv = mv;
    dv.z += min(aSize * uDepthBias.x, uDepthBias.y);      // +z in view space is toward the camera
    vec4 clip = projectionMatrix * dv;
    gl_Position = clip;

    float k = aMeta.x;                 // thinness: 1 = the sprite as drawn, 2 = half as thick
    float rot = aRot;
    float sizeMul = 1.0;
    if (aMeta.z > 0.5) {
      // align the sprite to the particle's motion *in screen space*, and lengthen it the faster it
      // sweeps the frame — a spark becomes a streak, exactly like the reference. Length and
      // thinness scale together so a fast streak gets longer without getting fatter.
      vec3 mv2 = (modelViewMatrix * vec4(position + aVel * 0.03, 1.0)).xyz;
      mv2.z += min(aSize * uDepthBias.x, uDepthBias.y);
      vec4 clip2 = projectionMatrix * vec4(mv2, 1.0);
      float aspect = projectionMatrix[1][1] / max(1e-5, abs(projectionMatrix[0][0]));
      vec2 d = (clip2.xy / max(1e-5, abs(clip2.w)) - clip.xy / max(1e-5, abs(clip.w))) * vec2(aspect, 1.0);
      float L = length(d);
      if (L > 1e-5) {
        rot = atan(d.y, d.x);
        float f = 1.0 + clamp(L * 6.0, 0.0, 1.8);
        sizeMul = f; k *= f;
      }
    }
    vRot = rot;
    vStretch = clamp(k, 0.25, 7.0);
    vTile = vec2(mod(aMeta.y, uTiles), floor(aMeta.y / uTiles));
    // hard cap: a single puff right on the lens must never cost a full-screen fill
    gl_PointSize = clamp(aSize * sizeMul * uHeight * uPixelRatio / max(0.001, -mv.z), 0.0, uMaxPx);
  }
`;

const FRAG = /* glsl */`
  uniform sampler2D uMap;
  uniform float uTiles;
  varying float vRot;
  varying float vAlpha;
  varying vec3 vColor;
  varying float vStretch;
  varying vec2 vTile;
  void main(){
    vec2 p = gl_PointCoord - 0.5;
    p.y = -p.y;
    float c = cos(vRot), s = sin(vRot);
    vec2 r = mat2(c, -s, s, c) * p;             // rotate into sprite space
    vec2 q = vec2(r.x, r.y * vStretch);         // thin the sprite across its own axis
    vec2 uv = q + 0.5;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;
    uv = (uv + vTile) / uTiles;
    vec4 t = texture2D(uMap, uv);
    float a = t.a * vAlpha;
    if (a < 0.004) discard;
    gl_FragColor = vec4(vColor * t.rgb, a);
  }
`;

export class ParticleSystem {
  constructor({
    texture, tiles = 1, max = 900, blending = THREE.AdditiveBlending, depthWrite = false,
    gravity = 0, drag = 0.8, renderOrder = 5, ground = null, bounce = 0, groundFriction = 0.55,
    turbulence = 0, maxPx = 320, depthBias = 0, depthBiasMax = 1.2,
  } = {}) {
    this.max = max;
    this.gravity = gravity;
    this.drag = drag;
    this.ground = ground;
    this.bounce = bounce;
    this.groundFriction = groundFriction;
    this.turbulence = turbulence;
    this.count = 0;
    this._t = 0;

    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.size0 = new Float32Array(max);
    this.grow = new Float32Array(max);
    this.rot = new Float32Array(max);
    this.rotV = new Float32Array(max);
    this.life = new Float32Array(max);
    this.life0 = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.alpha0 = new Float32Array(max);
    this.fadeIn = new Float32Array(max);
    this.decay = new Float32Array(max);
    this.color = new Float32Array(max * 3);
    this.meta = new Float32Array(max * 3);
    this.active = new Uint8Array(max);
    this.free = [];
    for (let i = max - 1; i >= 0; i--) this.free.push(i);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aRot', new THREE.BufferAttribute(this.rot, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.color, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aVel', new THREE.BufferAttribute(this.vel, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aMeta', new THREE.BufferAttribute(this.meta, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setDrawRange(0, 0);
    this.geometry = geo;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: texture },
        uPixelRatio: { value: Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2) },
        uHeight: { value: 450 },
        uTiles: { value: tiles },
        uMaxPx: { value: maxPx },
        uDepthBias: { value: new THREE.Vector2(depthBias, depthBiasMax) },
      },
      vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite, blending, depthTest: true,
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = renderOrder;
    this._c = new THREE.Color();
  }

  setViewportHeight(h) { this.material.uniforms.uHeight.value = h * 0.5; }

  get alive() { return this.max - this.free.length; }

  emit({
    pos, vel = [0, 0, 0], life = 1, size = 1, grow = 0, rot = 0, rotV = 0,
    color = '#ffffff', alpha = 1, tile = 0, stretch = 1, align = 0, fadeIn = 0.06, decay = 2,
  }) {
    const i = this.free.pop();
    if (i === undefined) return -1;
    const b = i * 3;
    this.pos[b] = pos[0] ?? pos.x; this.pos[b + 1] = pos[1] ?? pos.y; this.pos[b + 2] = pos[2] ?? pos.z;
    this.vel[b] = vel[0] ?? vel.x ?? 0; this.vel[b + 1] = vel[1] ?? vel.y ?? 0; this.vel[b + 2] = vel[2] ?? vel.z ?? 0;
    this.life[i] = this.life0[i] = life;
    this.size[i] = this.size0[i] = size;
    this.grow[i] = grow;
    this.rot[i] = rot; this.rotV[i] = rotV;
    this.alpha[i] = 0; this.alpha0[i] = alpha;
    this.fadeIn[i] = Math.max(1e-4, fadeIn);
    this.decay[i] = decay;
    this.meta[b] = stretch; this.meta[b + 1] = tile; this.meta[b + 2] = align;
    if (typeof color === 'string') this._c.set(color); else this._c.copy(color);
    this.color[b] = this._c.r; this.color[b + 1] = this._c.g; this.color[b + 2] = this._c.b;
    this.active[i] = 1;
    this.count = Math.max(this.count, i + 1);
    return i;
  }

  update(dt, wind = null) {
    this._t += dt;
    const g = this.gravity * dt;
    const dragK = Math.exp(-this.drag * dt);
    const turb = this.turbulence;
    const gy = this.ground;
    let maxI = 0;
    for (let i = 0; i < this.count; i++) {
      if (!this.active[i]) { this.alpha[i] = 0; continue; }
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.active[i] = 0; this.alpha[i] = 0; this.size[i] = 0;
        this.free.push(i);
        continue;
      }
      const b = i * 3;
      this.vel[b + 1] += g;
      if (wind) { this.vel[b] += wind[0] * dt; this.vel[b + 1] += wind[1] * dt; this.vel[b + 2] += wind[2] * dt; }
      if (turb > 0) {
        // cheap divergence-free-ish swirl so smoke curls instead of drifting in straight lines
        const px = this.pos[b] * 0.42, py = this.pos[b + 1] * 0.7, pz = this.pos[b + 2] * 0.42;
        const s = turb * dt;
        this.vel[b] += Math.sin(pz * 1.7 + py + this._t * 1.15) * s;
        this.vel[b + 1] += Math.sin(px * 1.9 - pz * 0.8 + this._t * 0.9) * s * 0.45;
        this.vel[b + 2] += Math.cos(px * 1.4 + py * 1.1 - this._t * 1.05) * s;
      }
      this.vel[b] *= dragK; this.vel[b + 1] *= dragK; this.vel[b + 2] *= dragK;
      this.pos[b] += this.vel[b] * dt;
      this.pos[b + 1] += this.vel[b + 1] * dt;
      this.pos[b + 2] += this.vel[b + 2] * dt;
      if (gy !== null && this.pos[b + 1] < gy) {
        this.pos[b + 1] = gy;
        if (this.bounce > 0 && this.vel[b + 1] < 0) {
          this.vel[b + 1] = -this.vel[b + 1] * this.bounce;
          this.vel[b] *= this.groundFriction; this.vel[b + 2] *= this.groundFriction;
          this.rotV[i] *= 0.6;
        } else if (this.vel[b + 1] < 0) {
          this.vel[b + 1] = 0;
        }
      }
      this.rot[i] += this.rotV[i] * dt;
      const t = 1 - this.life[i] / this.life0[i];
      this.size[i] = this.size0[i] * (1 + this.grow[i] * Math.pow(t, 0.68));
      // fade in fast, then a shaped ease-out so nothing blinks off
      this.alpha[i] = this.alpha0[i] * sstep(0, this.fadeIn[i], t) * Math.pow(1 - t, this.decay[i]);
      maxI = i + 1;
    }
    this.count = maxI;
    this.geometry.setDrawRange(0, this.count);
    if (this.count > 0) {
      this.geometry.attributes.position.needsUpdate = true;
      this.geometry.attributes.aSize.needsUpdate = true;
      this.geometry.attributes.aRot.needsUpdate = true;
      this.geometry.attributes.aAlpha.needsUpdate = true;
      this.geometry.attributes.aColor.needsUpdate = true;
      this.geometry.attributes.aVel.needsUpdate = true;
      this.geometry.attributes.aMeta.needsUpdate = true;
    }
  }

  clear() {
    this.free.length = 0;
    for (let i = this.max - 1; i >= 0; i--) { this.free.push(i); this.active[i] = 0; this.alpha[i] = 0; }
    this.count = 0;
    this.geometry.setDrawRange(0, 0);
  }

  dispose() { this.geometry.dispose(); this.material.dispose(); }
}

// ---------------------------------------------------------------- rigid debris

/**
 * Real 3D debris. Sprites cannot sell a crash on their own: at the resolutions a critic zooms to,
 * a torn bumper section has to be an actual object that catches the key light on one facet and the
 * neon on another, tumbles on its own axis, bounces off the tarmac and *settles* there.
 *
 * Three families, all generated in code: painted panel shards (they carry the car's own paint),
 * steel/chrome chunks, and glass slivers. Each family is one InstancedMesh with per-instance
 * colour, so 200 chunks cost three draw calls.
 */
class DebrisKind {
  constructor(geo, mat, max) {
    this.max = max;
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.renderOrder = 3;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.quat = new Float32Array(max * 4);
    this.axis = new Float32Array(max * 3);
    this.rate = new Float32Array(max);
    this.size = new Float32Array(max);
    this.life = new Float32Array(max);
    this.life0 = new Float32Array(max);
    this.ground = new Float32Array(max);
    this.rest = new Uint8Array(max);
    this.alive = new Uint8Array(max);
    this.free = [];
    for (let i = max - 1; i >= 0; i--) this.free.push(i);
    const m = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < max; i++) this.mesh.setMatrixAt(i, m);
    this.mesh.setColorAt(0, new THREE.Color(1, 1, 1));
    this.mesh.instanceColor.needsUpdate = true;
  }
}

export class DebrisField {
  constructor({ seed = 4141, ground = 0.03 } = {}) {
    this.group = new THREE.Group();
    this.group.name = 'debris-field';
    this.groundY = ground;
    const rng = new RNG(seed);

    // --- painted body panel: a torn slab of sheet metal, edges never parallel
    const panel = new THREE.BoxGeometry(1, 0.09, 0.66, 2, 1, 2).toNonIndexed();
    jitter(panel, rng, 0.16);
    const panelMat = new THREE.MeshStandardMaterial({
      // Night cities light almost everything with emissive geometry, and a mirror-metal shard in
      // one reads as a black paper cut-out. Diffuse-leaning, strongly env-lit, with a floor of
      // self-illumination so a chunk never goes pure black against a dark road.
      color: 0xffffff, metalness: 0.28, roughness: 0.46, flatShading: true,
      envMapIntensity: 2.1, side: THREE.DoubleSide,
      emissive: 0x1c1d21, emissiveIntensity: 1.0,
    });

    // --- steel / chrome chunk: an irregular lump, bright specular facets
    const chunk = new THREE.IcosahedronGeometry(0.5, 0).toNonIndexed();
    jitter(chunk, rng, 0.42);
    const chunkMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, metalness: 0.72, roughness: 0.34, flatShading: true, envMapIntensity: 2.4,
      emissive: 0x1a1c20, emissiveIntensity: 1.0,
    });

    // --- glass sliver: thin, sharp, catches light like a mirror
    const glass = new THREE.TetrahedronGeometry(0.55, 0).toNonIndexed();
    glass.scale(1.0, 0.22, 1.5);
    jitter(glass, rng, 0.18);
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0xdff0ff, metalness: 0.28, roughness: 0.06, flatShading: true,
      envMapIntensity: 2.8, transparent: true, opacity: 0.66,
      emissive: 0x18242e, emissiveIntensity: 1.0, side: THREE.DoubleSide,
    });

    this.kinds = {
      panel: new DebrisKind(panel, panelMat, 64),
      chunk: new DebrisKind(chunk, chunkMat, 96),
      glass: new DebrisKind(glass, glassMat, 48),
    };
    for (const k of Object.values(this.kinds)) this.group.add(k.mesh);

    this._q = new THREE.Quaternion();
    this._dq = new THREE.Quaternion();
    this._ax = new THREE.Vector3();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._m = new THREE.Matrix4();
    this._c = new THREE.Color();
    this.onBounce = null;      // (x, y, z, speed) — the FX director drops a dust puff here
  }

  /**
   * Throw one chunk. `spin` is radians/s about a random axis; `life` includes a settle-and-fade.
   */
  emit(kindName, {
    pos, vel = [0, 0, 0], size = 0.2, life = 3.2, spin = 10, color = '#9aa0aa', ground = null,
  }) {
    const k = this.kinds[kindName];
    if (!k) return -1;
    const i = k.free.pop();
    if (i === undefined) return -1;
    const b = i * 3;
    k.pos[b] = pos[0]; k.pos[b + 1] = pos[1]; k.pos[b + 2] = pos[2];
    k.vel[b] = vel[0]; k.vel[b + 1] = vel[1]; k.vel[b + 2] = vel[2];
    // axis perpendicular to the throw, so a chunk tumbles end-over-end the way it was launched
    let ax = -vel[2], ay = 0.35, az = vel[0];
    const l = Math.hypot(ax, ay, az) || 1;
    ax /= l; ay /= l; az /= l;
    k.axis[b] = ax; k.axis[b + 1] = ay; k.axis[b + 2] = az;
    k.rate[i] = spin;
    k.quat[i * 4] = 0; k.quat[i * 4 + 1] = 0; k.quat[i * 4 + 2] = 0; k.quat[i * 4 + 3] = 1;
    k.size[i] = size;
    k.life[i] = k.life0[i] = life;
    k.ground[i] = ground === null ? this.groundY : ground;
    k.rest[i] = 0;
    k.alive[i] = 1;
    if (typeof color === 'string') this._c.set(color); else this._c.copy(color);
    k.mesh.setColorAt(i, this._c);
    k.mesh.instanceColor.needsUpdate = true;
    return i;
  }

  update(dt) {
    for (const k of Object.values(this.kinds)) {
      let dirty = false;
      for (let i = 0; i < k.max; i++) {
        if (!k.alive[i]) continue;
        const b = i * 3;
        k.life[i] -= dt;
        if (k.life[i] <= 0) {
          k.alive[i] = 0; k.free.push(i);
          this._m.makeScale(0, 0, 0);
          k.mesh.setMatrixAt(i, this._m);
          dirty = true;
          continue;
        }
        const r = k.size[i] * 0.45;
        if (!k.rest[i]) {
          k.vel[b + 1] -= 24 * dt;
          const d = Math.exp(-0.55 * dt);
          k.vel[b] *= d; k.vel[b + 1] *= d; k.vel[b + 2] *= d;
          k.pos[b] += k.vel[b] * dt;
          k.pos[b + 1] += k.vel[b + 1] * dt;
          k.pos[b + 2] += k.vel[b + 2] * dt;
          const gy = k.ground[i] + r;
          if (k.pos[b + 1] < gy) {
            const impact = -k.vel[b + 1];
            k.pos[b + 1] = gy;
            if (k.vel[b + 1] < 0) {
              k.vel[b + 1] = -k.vel[b + 1] * 0.34;
              k.vel[b] *= 0.62; k.vel[b + 2] *= 0.62;
              k.rate[i] *= 0.55;
              if (impact > 2.5 && this.onBounce) this.onBounce(k.pos[b], gy, k.pos[b + 2], impact);
            }
            const flat = Math.hypot(k.vel[b], k.vel[b + 2]);
            if (flat < 0.7 && Math.abs(k.vel[b + 1]) < 0.8) {
              k.rest[i] = 1; k.vel[b] = 0; k.vel[b + 1] = 0; k.vel[b + 2] = 0; k.rate[i] = 0;
              k.pos[b + 1] = k.ground[i] + k.size[i] * 0.14;   // lies flat on the road
            }
          }
          // integrate the tumble
          this._ax.set(k.axis[b], k.axis[b + 1], k.axis[b + 2]);
          this._dq.setFromAxisAngle(this._ax, k.rate[i] * dt);
          this._q.set(k.quat[i * 4], k.quat[i * 4 + 1], k.quat[i * 4 + 2], k.quat[i * 4 + 3]);
          this._q.premultiply(this._dq).normalize();
          k.quat[i * 4] = this._q.x; k.quat[i * 4 + 1] = this._q.y;
          k.quat[i * 4 + 2] = this._q.z; k.quat[i * 4 + 3] = this._q.w;
        } else {
          this._q.set(k.quat[i * 4], k.quat[i * 4 + 1], k.quat[i * 4 + 2], k.quat[i * 4 + 3]);
        }
        // shrink away over the last third of a second rather than vanishing
        const t = 1 - k.life[i] / k.life0[i];
        const fade = t > 0.86 ? clamp((1 - t) / 0.14, 0, 1) : 1;
        const sc = k.size[i] * fade;
        this._p.set(k.pos[b], k.pos[b + 1], k.pos[b + 2]);
        this._s.set(sc, sc, sc);
        this._m.compose(this._p, this._q, this._s);
        k.mesh.setMatrixAt(i, this._m);
        dirty = true;
      }
      if (dirty) k.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  clear() {
    const m = new THREE.Matrix4().makeScale(0, 0, 0);
    for (const k of Object.values(this.kinds)) {
      k.free.length = 0;
      for (let i = k.max - 1; i >= 0; i--) { k.free.push(i); k.alive[i] = 0; k.mesh.setMatrixAt(i, m); }
      k.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  dispose() {
    for (const k of Object.values(this.kinds)) {
      k.mesh.removeFromParent();
      k.mesh.dispose();
      k.mesh.geometry.dispose();
      k.mesh.material.dispose();
    }
    this.group.removeFromParent();
  }
}

/** Push every vertex of a non-indexed geometry off its lattice so no two chunks look stamped. */
function jitter(geo, rng, amount) {
  const p = geo.attributes.position;
  const seen = new Map();
  for (let i = 0; i < p.count; i++) {
    const key = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    let d = seen.get(key);
    if (!d) {
      d = [rng.range(-amount, amount), rng.range(-amount, amount) * 0.7, rng.range(-amount, amount)];
      seen.set(key, d);
    }
    p.setXYZ(i, p.getX(i) + d[0], p.getY(i) + d[1], p.getZ(i) + d[2]);
  }
  geo.computeVertexNormals();
  return geo;
}

// ---------------------------------------------------------------- skid marks

/**
 * Skid marks laid into the road as a growing ribbon. The reference has black rubber arcs baked
 * into the tarmac behind every drifting pack, so these persist for ~20 s of continuous sliding and
 * then fade from the tail rather than popping.
 *
 * Rubber-ness comes from the shader: tread banding across the width, streaky grain along the
 * length, a hot dark core with feathered shoulders, and a faint sheen so it doesn't read as a flat
 * black decal.
 */
export class SkidTrails {
  constructor({ max = 27000, color = 0x1a1618, opacity = 0.95 } = {}) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.uv = new Float32Array(max * 2);
    this.alpha = new Float32Array(max);
    this.seq = new Float32Array(max);
    this.i = 0;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('uv', new THREE.BufferAttribute(this.uv, 2).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aSeq', new THREE.BufferAttribute(this.seq, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setDrawRange(0, 0);
    this.geometry = geo;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(color) },
        uWarm: { value: new THREE.Color(0x3b322c) },
        uDust: { value: new THREE.Color(0x8b7f70) },
        uOpacity: { value: opacity },
        uHead: { value: 0 },
        uSpan: { value: max },
      },
      vertexShader: `
        attribute float aAlpha; attribute float aSeq;
        varying float vA; varying vec2 vUv; varying float vSeq;
        void main(){ vA = aAlpha; vUv = uv; vSeq = aSeq;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `
        uniform vec3 uColor; uniform vec3 uWarm; uniform vec3 uDust; uniform float uOpacity;
        uniform float uHead; uniform float uSpan;
        varying float vA; varying vec2 vUv; varying float vSeq;
        float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
        float vnoise(vec2 p){
          vec2 i = floor(p), f = fract(p);
          f = f*f*(3.0-2.0*f);
          return mix(mix(h(i), h(i+vec2(1,0)), f.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), f.x), f.y);
        }
        void main(){
          float x = vUv.x;
          float edge = smoothstep(0.0,0.07,x)*smoothstep(1.0,0.93,x);
          // tread: the tyre lays bands, not a solid slab
          float tread = 0.80 + 0.20*smoothstep(0.42,0.5,abs(fract(x*4.0)-0.5));
          // streaky rubber grain along the length
          float g = vnoise(vec2(x*7.0, vUv.y*2.6)) * 0.55 + vnoise(vec2(x*19.0, vUv.y*11.0)) * 0.45;
          float grain = 0.70 + 0.45*g;
          // fade the oldest segments out of the ring buffer instead of popping them
          float age = clamp((uSpan - (uHead - vSeq)) / (uSpan*0.22), 0.0, 1.0);
          // A pure-black mark is invisible on an unlit night road. Real rubber is a dark core with
          // grey scuffed dust along its shoulders: the core darkens bright tarmac, the dust lifts
          // dark tarmac, so the mark reads in both.
          float shoulder = smoothstep(0.10, 0.66, abs(x-0.5)*2.0);
          vec3 col = mix(mix(uColor, uWarm, clamp(g*0.9,0.0,1.0)), uDust, shoulder*(0.45+0.55*g));
          float a = vA * uOpacity * edge * tread * grain * age;
          gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
        }`,
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4,
      // the ribbon quads are wound face-down; draw both sides rather than depend on winding
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this._last = new Map();
  }

  /** Append a quad segment for one wheel. `key` keeps each wheel's ribbon continuous. */
  add(key, pos, right, width, intensity) {
    const prev = this._last.get(key);
    const w = Math.max(0.30, width * (1.5 + 0.35 * intensity));
    const l = pos.clone().addScaledVector(right, -w * 0.5);
    const r = pos.clone().addScaledVector(right, w * 0.5);
    if (prev) {
      const step = prev.p.distanceTo(pos);
      if (step < 0.02) return;                 // don't pile up zero-area quads when nearly stopped
      const v0 = prev.v, v1 = prev.v + step * 0.55;
      const verts = [prev.l, prev.r, l, prev.r, r, l];
      const uvs = [[0, v0], [1, v0], [0, v1], [1, v0], [1, v1], [0, v1]];
      const alphas = [prev.a, prev.a, intensity, prev.a, intensity, intensity];
      for (let k = 0; k < 6; k++) {
        const i = this.i % this.max;
        this.pos[i * 3] = verts[k].x; this.pos[i * 3 + 1] = verts[k].y + 0.016; this.pos[i * 3 + 2] = verts[k].z;
        this.uv[i * 2] = uvs[k][0]; this.uv[i * 2 + 1] = uvs[k][1];
        this.alpha[i] = alphas[k];
        this.seq[i] = this.i;
        this.i++;
      }
      this.material.uniforms.uHead.value = this.i;
      this.geometry.setDrawRange(0, Math.min(this.i, this.max));
      this.geometry.attributes.position.needsUpdate = true;
      this.geometry.attributes.uv.needsUpdate = true;
      this.geometry.attributes.aAlpha.needsUpdate = true;
      this.geometry.attributes.aSeq.needsUpdate = true;
      this._last.set(key, { l, r, p: pos.clone(), v: v1, a: intensity });
    } else {
      this._last.set(key, { l, r, p: pos.clone(), v: 0, a: intensity });
    }
  }

  break(key) { this._last.delete(key); }
  clear() { this.i = 0; this._last.clear(); this.material.uniforms.uHead.value = 0; this.geometry.setDrawRange(0, 0); }
  dispose() { this.geometry.dispose(); this.material.dispose(); }
}

// ---------------------------------------------------------------- ground decals

/**
 * Pooled flat quads stamped on the road — scorch under an impact, rubber smear where a car scrubs
 * a barrier. They outlive the particles, so a crash leaves a mark on the world instead of
 * evaporating without trace (§6.6 "environment response").
 */
export class GroundDecals {
  constructor({ max = 64, texture, tiles = 2, blending = THREE.NormalBlending, offset = -6 } = {}) {
    this.max = max;
    this.n = 0;
    this.slot = 0;
    this.pos = new Float32Array(max * 4 * 3);
    this.uv = new Float32Array(max * 4 * 2);
    this.alpha = new Float32Array(max * 4);
    this.color = new Float32Array(max * 4 * 3);
    this.age = new Float32Array(max);
    this.life = new Float32Array(max);
    this.peak = new Float32Array(max);
    this.used = new Uint8Array(max);
    this.tiles = tiles;

    const idx = new Uint16Array(max * 6);
    for (let i = 0; i < max; i++) {
      const o = i * 4;
      idx.set([o, o + 1, o + 2, o, o + 2, o + 3], i * 6);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('uv', new THREE.BufferAttribute(this.uv, 2).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.color, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.setDrawRange(0, 0);
    this.geometry = geo;

    this.material = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: texture } },
      vertexShader: `
        attribute float aAlpha; attribute vec3 aColor;
        varying float vA; varying vec2 vUv; varying vec3 vC;
        void main(){ vA = aAlpha; vUv = uv; vC = aColor;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `
        uniform sampler2D uMap; varying float vA; varying vec2 vUv; varying vec3 vC;
        void main(){
          vec4 t = texture2D(uMap, vUv);
          float a = t.a * vA;
          if (a < 0.004) discard;
          gl_FragColor = vec4(vC * t.rgb, a);
        }`,
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: offset,
      side: THREE.DoubleSide, blending,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this._c = new THREE.Color();
    this._u = new THREE.Vector3();
    this._v = new THREE.Vector3();
  }

  /** Stamp a decal flat on the ground. `rot` is yaw in radians. */
  add(pos, radius, rot, opts = {}) {
    const c = Math.cos(rot), s = Math.sin(rot);
    const aspect = opts.aspect ?? 1;
    return this._quad(
      pos.x, pos.y + 0.02, pos.z,
      c * radius * aspect, 0, s * radius * aspect,        // half-axis U
      -s * radius, 0, c * radius,                         // half-axis V
      opts,
    );
  }

  /**
   * Stamp a decal onto a vertical surface — the soot and paint a car leaves ON the barrier it hit.
   * `normal` points away from the wall, `w`/`h` are half-extents along the wall and up it.
   */
  addWall(pos, normal, w, h, opts = {}) {
    this._u.set(-normal.z, 0, normal.x).normalize().multiplyScalar(w);
    this._v.set(0, h, 0);
    const push = 0.30;   // clear of the barrier's own shell, which is thicker than the collision plane
    return this._quad(
      pos.x + normal.x * push, pos.y, pos.z + normal.z * push,
      this._u.x, this._u.y, this._u.z,
      this._v.x, this._v.y, this._v.z,
      opts,
    );
  }

  _quad(px, py, pz, ux, uy, uz, vx, vy, vz, { tile = 0, opacity = 0.8, life = 9, color = '#ffffff' } = {}) {
    const i = this.slot;
    this.slot = (this.slot + 1) % this.max;
    this.n = Math.max(this.n, i + 1);
    this.used[i] = 1;
    this.age[i] = 0; this.life[i] = life; this.peak[i] = opacity;
    const t = this.tiles;
    const tx = tile % t, ty = Math.floor(tile / t);
    const uvs = [[0, 0], [1, 0], [1, 1], [0, 1]];
    const signs = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    if (typeof color === 'string') this._c.set(color); else this._c.copy(color);
    for (let k = 0; k < 4; k++) {
      const o = (i * 4 + k);
      const [su, sv] = signs[k];
      this.pos[o * 3] = px + ux * su + vx * sv;
      this.pos[o * 3 + 1] = py + uy * su + vy * sv;
      this.pos[o * 3 + 2] = pz + uz * su + vz * sv;
      this.uv[o * 2] = (uvs[k][0] + tx) / t;
      this.uv[o * 2 + 1] = (uvs[k][1] + ty) / t;
      this.alpha[o] = 0;
      this.color[o * 3] = this._c.r; this.color[o * 3 + 1] = this._c.g; this.color[o * 3 + 2] = this._c.b;
    }
    this.geometry.setDrawRange(0, this.n * 6);
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.uv.needsUpdate = true;
    this.geometry.attributes.aColor.needsUpdate = true;
  }

  update(dt) {
    let dirty = false;
    for (let i = 0; i < this.n; i++) {
      if (!this.used[i]) continue;
      this.age[i] += dt;
      const t = this.age[i] / this.life[i];
      let a = this.peak[i];
      if (t < 0.06) a *= t / 0.06;               // stamped in over ~0.3 s, never a hard pop
      else a *= Math.pow(clamp(1 - (t - 0.06) / 0.94, 0, 1), 1.6);
      if (t >= 1) { this.used[i] = 0; a = 0; }
      for (let k = 0; k < 4; k++) this.alpha[i * 4 + k] = a;
      dirty = true;
    }
    if (dirty) this.geometry.attributes.aAlpha.needsUpdate = true;
  }

  clear() {
    this.n = 0; this.slot = 0;
    this.used.fill(0); this.alpha.fill(0);
    this.geometry.setDrawRange(0, 0);
  }

  dispose() { this.geometry.dispose(); this.material.dispose(); }
}

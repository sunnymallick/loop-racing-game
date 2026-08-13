// Procedural texture toolkit. EVERYTHING here is drawn with Canvas2D / typed arrays at load time.
// No image files, ever (ART_DIRECTION.md §3).
//
// Contract for builders: add generators here, return THREE.CanvasTexture / THREE.DataTexture.
// Always pass an RNG so output is deterministic. Always set colorSpace correctly:
//   - color/albedo maps  -> THREE.SRGBColorSpace
//   - normal/rough/metal -> THREE.NoColorSpace (linear)

import * as THREE from 'three';
import { RNG, makeNoise2D, fbm2D, clamp, lerp, smoothstep } from './rng.js';

const _cache = new Map();
export function cached(key, fn) {
  if (_cache.has(key)) return _cache.get(key);
  const v = fn();
  _cache.set(key, v);
  return v;
}
export function clearTextureCache() {
  for (const t of _cache.values()) if (t && t.dispose) t.dispose();
  _cache.clear();
}

export function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: false });
  return { c, ctx };
}

export function toTexture(c, {
  srgb = true, repeat = [1, 1], aniso = 16, wrap = THREE.RepeatWrapping, flipY = true,
} = {}) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = wrap;
  t.repeat.set(repeat[0], repeat[1]);
  t.anisotropy = aniso;
  t.flipY = flipY;
  t.needsUpdate = true;
  return t;
}

// ---------------------------------------------------------------- noise fields

/** Grain overlay: adds per-pixel noise to an existing canvas context. */
export function grain(ctx, w, h, amount = 12, rng = new RNG(1)) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rng.next() - 0.5) * amount * 2;
    d[i] = clamp(d[i] + n, 0, 255);
    d[i + 1] = clamp(d[i + 1] + n, 0, 255);
    d[i + 2] = clamp(d[i + 2] + n, 0, 255);
  }
  ctx.putImageData(img, 0, 0);
}

/** Multi-octave blotches — the base of asphalt, concrete, stucco, rust. */
export function fbmField(w, h, { seed = 1, octaves = 5, scale = 6, warp = 0 } = {}) {
  const n = makeNoise2D(seed);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let u = (x / w) * scale, v = (y / h) * scale;
      if (warp) {
        const wx = fbm2D(n, u * 0.5 + 11.3, v * 0.5 + 4.7, 3);
        const wy = fbm2D(n, u * 0.5 - 7.1, v * 0.5 + 19.2, 3);
        u += wx * warp; v += wy * warp;
      }
      out[y * w + x] = fbm2D(n, u, v, octaves) * 0.5 + 0.5;
    }
  }
  return out;
}

/** Convert a height field into a tangent-space normal map texture. */
export function normalFromHeight(height, w, h, strength = 2.0) {
  const { c, ctx } = canvas(w, h);
  const img = ctx.createImageData(w, h);
  const d = img.data;
  const at = (x, y) => height[((y + h) % h) * w + ((x + w) % w)];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      let nx = -dx, ny = -dy, nz = 1.0;
      const len = Math.hypot(nx, ny, nz);
      nx /= len; ny /= len; nz /= len;
      const i = (y * w + x) * 4;
      d[i] = (nx * 0.5 + 0.5) * 255;
      d[i + 1] = (ny * 0.5 + 0.5) * 255;
      d[i + 2] = (nz * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** Pack a scalar field into a grayscale canvas (roughness / AO / metalness maps). */
export function grayCanvas(field, w, h, lo = 0, hi = 1) {
  const { c, ctx } = canvas(w, h);
  const img = ctx.createImageData(w, h);
  const d = img.data;
  for (let i = 0; i < field.length; i++) {
    const v = clamp(lerp(lo, hi, field[i]), 0, 1) * 255;
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// ---------------------------------------------------------------- surfaces

/**
 * Asphalt: dark aggregate base, tar patches, cracks, oil sheen, tire-polished lane wear.
 * Returns {map, normalMap, roughnessMap}.
 */
export function asphalt({ size = 1024, seed = 7, tint = '#22242b', wet = 0 } = {}) {
  return cached(`asphalt:${size}:${seed}:${tint}:${wet}`, () => {
    const rng = new RNG(seed);
    const { c, ctx } = canvas(size, size);
    const base = fbmField(size, size, { seed, octaves: 6, scale: 10, warp: 0.6 });
    const fine = fbmField(size, size, { seed: seed + 91, octaves: 4, scale: 60 });

    const col = new THREE.Color(tint);
    const img = ctx.createImageData(size, size);
    const d = img.data;
    for (let i = 0; i < size * size; i++) {
      const agg = fine[i];
      const blot = base[i];
      // aggregate speckle + broad tar variation
      let l = 0.72 + (agg - 0.5) * 0.85 + (blot - 0.5) * 0.35;
      if (agg > 0.80) l += 0.30 * (agg - 0.80) * 5;   // bright stones
      if (blot < 0.30) l *= 0.72;                      // fresh tar patch
      l = clamp(l, 0.18, 1.7);
      d[i * 4] = clamp(col.r * 255 * l, 0, 255);
      d[i * 4 + 1] = clamp(col.g * 255 * l, 0, 255);
      d[i * 4 + 2] = clamp(col.b * 255 * l, 0, 255);
      d[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);

    // cracks
    ctx.strokeStyle = 'rgba(8,8,10,0.55)';
    ctx.lineCap = 'round';
    for (let k = 0; k < 26; k++) {
      let x = rng.range(0, size), y = rng.range(0, size);
      let a = rng.range(0, Math.PI * 2);
      ctx.lineWidth = rng.range(0.7, 2.2);
      ctx.beginPath(); ctx.moveTo(x, y);
      const segs = rng.int(6, 20);
      for (let s = 0; s < segs; s++) {
        a += rng.range(-0.7, 0.7);
        x += Math.cos(a) * rng.range(6, 26);
        y += Math.sin(a) * rng.range(6, 26);
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    // patch repairs
    for (let k = 0; k < 5; k++) {
      ctx.fillStyle = `rgba(${rng.int(18, 34)},${rng.int(18, 34)},${rng.int(20, 38)},0.5)`;
      const w = rng.range(60, 260), h = rng.range(40, 180);
      ctx.save();
      ctx.translate(rng.range(0, size), rng.range(0, size));
      ctx.rotate(rng.range(0, Math.PI));
      ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.restore();
    }
    grain(ctx, size, size, 7, rng);

    const rough = new Float32Array(size * size);
    for (let i = 0; i < rough.length; i++) {
      let r = 0.86 + (fine[i] - 0.5) * 0.22 - (base[i] - 0.5) * 0.18;
      if (wet) r = lerp(r, 0.13 + (fine[i] - 0.5) * 0.10, wet);
      rough[i] = clamp(r, 0.05, 1);
    }
    const nrm = normalFromHeight(fine, size, size, wet ? 1.1 : 2.6);

    return {
      map: toTexture(c, { srgb: true }),
      roughnessMap: toTexture(grayCanvas(rough, size, size), { srgb: false }),
      normalMap: toTexture(nrm, { srgb: false }),
    };
  });
}

/** Concrete / stucco: for barriers, sidewalks, building bases. */
export function concrete({ size = 512, seed = 3, tint = '#9a978f', stains = true } = {}) {
  return cached(`concrete:${size}:${seed}:${tint}:${stains}`, () => {
    const rng = new RNG(seed);
    const { c, ctx } = canvas(size, size);
    const f = fbmField(size, size, { seed, octaves: 5, scale: 8, warp: 0.4 });
    const g = fbmField(size, size, { seed: seed + 5, octaves: 3, scale: 40 });
    const col = new THREE.Color(tint);
    const img = ctx.createImageData(size, size);
    const d = img.data;
    for (let i = 0; i < size * size; i++) {
      const l = clamp(0.82 + (f[i] - 0.5) * 0.42 + (g[i] - 0.5) * 0.16, 0.35, 1.35);
      d[i * 4] = clamp(col.r * 255 * l, 0, 255);
      d[i * 4 + 1] = clamp(col.g * 255 * l, 0, 255);
      d[i * 4 + 2] = clamp(col.b * 255 * l, 0, 255);
      d[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    if (stains) {
      for (let k = 0; k < 14; k++) {
        const x = rng.range(0, size), y = rng.range(0, size), r = rng.range(20, 120);
        const gr = ctx.createRadialGradient(x, y, 0, x, y, r);
        gr.addColorStop(0, `rgba(60,55,50,${rng.range(0.05, 0.20)})`);
        gr.addColorStop(1, 'rgba(60,55,50,0)');
        ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
      }
    }
    grain(ctx, size, size, 6, rng);
    const rough = new Float32Array(size * size);
    for (let i = 0; i < rough.length; i++) rough[i] = clamp(0.88 + (g[i] - 0.5) * 0.18, 0.4, 1);
    return {
      map: toTexture(c, { srgb: true }),
      roughnessMap: toTexture(grayCanvas(rough, size, size), { srgb: false }),
      normalMap: toTexture(normalFromHeight(g, size, size, 1.4), { srgb: false }),
    };
  });
}

/**
 * Building facade: windows in a grid with per-window lit state, spandrel bands, ledges.
 * `emissive` returns a second canvas where only lit windows are bright — use as emissiveMap.
 */
export function facade({
  size = 512, seed = 11, cols = 8, rows = 12,
  wall = '#5a5c66', frame = '#2a2c33', glass = '#20303f',
  litColor = '#ffd9a0', litRatio = 0.0, night = false, style = 'modern',
} = {}) {
  return cached(`facade:${[size, seed, cols, rows, wall, frame, glass, litColor, litRatio, night, style].join('|')}`, () => {
    const rng = new RNG(seed);
    const { c, ctx } = canvas(size, size);
    const { c: ec, ctx: ectx } = canvas(size, size);
    ectx.fillStyle = '#000'; ectx.fillRect(0, 0, size, size);

    // wall base with vertical grime
    const f = fbmField(size, size, { seed, octaves: 4, scale: 5 });
    const wcol = new THREE.Color(wall);
    const img = ctx.createImageData(size, size);
    const d = img.data;
    for (let i = 0; i < size * size; i++) {
      const l = clamp(0.85 + (f[i] - 0.5) * 0.30, 0.5, 1.25);
      d[i * 4] = clamp(wcol.r * 255 * l, 0, 255);
      d[i * 4 + 1] = clamp(wcol.g * 255 * l, 0, 255);
      d[i * 4 + 2] = clamp(wcol.b * 255 * l, 0, 255);
      d[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);

    const cw = size / cols, ch = size / rows;
    const inset = style === 'artdeco' ? 0.16 : 0.12;
    for (let r = 0; r < rows; r++) {
      // spandrel band between floors
      ctx.fillStyle = frame;
      ctx.globalAlpha = 0.55;
      ctx.fillRect(0, r * ch + ch * (1 - inset * 1.2), size, ch * inset * 1.2);
      ctx.globalAlpha = 1;
      for (let cc = 0; cc < cols; cc++) {
        const x = cc * cw + cw * inset, y = r * ch + ch * inset;
        const w = cw * (1 - inset * 2), h = ch * (1 - inset * 2.4);
        // frame
        ctx.fillStyle = frame; ctx.fillRect(x - 2, y - 2, w + 4, h + 4);
        // glass with a vertical sky-reflection gradient
        const gr = ctx.createLinearGradient(x, y, x, y + h);
        const gc = new THREE.Color(glass);
        gr.addColorStop(0, `rgb(${(gc.r * 255 * 1.5) | 0},${(gc.g * 255 * 1.5) | 0},${(gc.b * 255 * 1.7) | 0})`);
        gr.addColorStop(0.55, `rgb(${(gc.r * 255) | 0},${(gc.g * 255) | 0},${(gc.b * 255) | 0})`);
        gr.addColorStop(1, `rgb(${(gc.r * 255 * 0.6) | 0},${(gc.g * 255 * 0.6) | 0},${(gc.b * 255 * 0.7) | 0})`);
        ctx.fillStyle = gr; ctx.fillRect(x, y, w, h);
        // mullion
        ctx.fillStyle = frame; ctx.globalAlpha = 0.8;
        ctx.fillRect(x + w * 0.5 - 1, y, 2, h);
        ctx.globalAlpha = 1;

        if (rng.next() < litRatio) {
          const warm = new THREE.Color(litColor).offsetHSL(rng.range(-0.03, 0.03), 0, rng.range(-0.12, 0.10));
          const hex = `#${warm.getHexString()}`;
          ctx.fillStyle = hex; ctx.globalAlpha = night ? 0.95 : 0.5;
          ctx.fillRect(x, y, w, h);
          ctx.globalAlpha = 1;
          ectx.fillStyle = hex; ectx.fillRect(x, y, w, h);
          // blinds: a few dark bands so lit windows aren't uniform slabs
          if (rng.bool(0.35)) {
            ectx.fillStyle = 'rgba(0,0,0,0.55)';
            const bh = h * rng.range(0.2, 0.5);
            ectx.fillRect(x, y, w, bh);
            ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fillRect(x, y, w, bh);
          }
        }
      }
    }
    grain(ctx, size, size, 4, rng);
    return {
      map: toTexture(c, { srgb: true }),
      emissiveMap: toTexture(ec, { srgb: true }),
    };
  });
}

/** Brick wall — garage interiors, low-rise city blocks. */
export function brick({ size = 512, seed = 21, color = '#8c4433', mortar = '#b9b2a6', rowH = 26 } = {}) {
  return cached(`brick:${size}:${seed}:${color}:${mortar}:${rowH}`, () => {
    const rng = new RNG(seed);
    const { c, ctx } = canvas(size, size);
    ctx.fillStyle = mortar; ctx.fillRect(0, 0, size, size);
    const base = new THREE.Color(color);
    const bw = rowH * 2.1;
    for (let y = 0, row = 0; y < size; y += rowH, row++) {
      const off = row % 2 ? bw * 0.5 : 0;
      for (let x = -bw; x < size + bw; x += bw) {
        const v = rng.range(-0.16, 0.16);
        const col = base.clone().offsetHSL(rng.range(-0.02, 0.02), rng.range(-0.06, 0.06), v);
        ctx.fillStyle = `#${col.getHexString()}`;
        ctx.fillRect(x + off + 1.5, y + 1.5, bw - 3, rowH - 3);
      }
    }
    const f = fbmField(size, size, { seed, octaves: 4, scale: 7 });
    const img = ctx.getImageData(0, 0, size, size); const d = img.data;
    for (let i = 0; i < size * size; i++) {
      const l = 0.9 + (f[i] - 0.5) * 0.30;
      d[i * 4] = clamp(d[i * 4] * l, 0, 255);
      d[i * 4 + 1] = clamp(d[i * 4 + 1] * l, 0, 255);
      d[i * 4 + 2] = clamp(d[i * 4 + 2] * l, 0, 255);
    }
    ctx.putImageData(img, 0, 0);
    grain(ctx, size, size, 5, rng);
    const hf = fbmField(size, size, { seed: seed + 3, octaves: 3, scale: 50 });
    return {
      map: toTexture(c, { srgb: true }),
      normalMap: toTexture(normalFromHeight(hf, size, size, 1.6), { srgb: false }),
      roughnessMap: toTexture(grayCanvas(hf, size, size, 0.75, 0.98), { srgb: false }),
    };
  });
}

/** Soft radial sprite — the atom of every particle effect. `shape`: 'glow'|'smoke'|'spark'|'flare'|'ring' */
export function sprite({ size = 128, shape = 'glow', seed = 1, color = '#ffffff', softness = 1 } = {}) {
  return cached(`sprite:${size}:${shape}:${seed}:${color}:${softness}`, () => {
    const rng = new RNG(seed);
    const { c, ctx } = canvas(size, size);
    const h = size / 2;
    ctx.clearRect(0, 0, size, size);
    if (shape === 'glow' || shape === 'flare') {
      const g = ctx.createRadialGradient(h, h, 0, h, h, h);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.18, 'rgba(255,255,255,0.85)');
      g.addColorStop(0.45, 'rgba(255,255,255,0.22)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
      if (shape === 'flare') {
        ctx.globalCompositeOperation = 'lighter';
        const lg = ctx.createLinearGradient(0, h, size, h);
        lg.addColorStop(0, 'rgba(255,255,255,0)');
        lg.addColorStop(0.5, 'rgba(255,255,255,0.55)');
        lg.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = lg; ctx.fillRect(0, h - size * 0.02, size, size * 0.04);
      }
    } else if (shape === 'smoke') {
      // billowing puff: several offset blobs so the silhouette isn't a circle
      for (let i = 0; i < 14; i++) {
        const a = rng.range(0, Math.PI * 2), d = rng.range(0, h * 0.42);
        const x = h + Math.cos(a) * d, y = h + Math.sin(a) * d;
        const r = rng.range(h * 0.22, h * 0.46);
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, `rgba(255,255,255,${rng.range(0.10, 0.20)})`);
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
      }
      // erode edges so it doesn't read as a soft disc
      const img = ctx.getImageData(0, 0, size, size); const d2 = img.data;
      const f = fbmField(size, size, { seed: seed + 17, octaves: 4, scale: 4 });
      for (let i = 0; i < size * size; i++) d2[i * 4 + 3] *= clamp(f[i] * 1.9 - 0.35, 0, 1);
      ctx.putImageData(img, 0, 0);
    } else if (shape === 'spark') {
      const g = ctx.createLinearGradient(0, h, size, h);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(0.35, 'rgba(255,255,255,0.35)');
      g.addColorStop(0.85, 'rgba(255,255,255,1)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, h - size * 0.045, size, size * 0.09);
      const rg = ctx.createRadialGradient(size * 0.85, h, 0, size * 0.85, h, size * 0.16);
      rg.addColorStop(0, 'rgba(255,255,255,1)'); rg.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = rg; ctx.fillRect(0, 0, size, size);
    } else if (shape === 'ring') {
      const g = ctx.createRadialGradient(h, h, h * 0.55, h, h, h);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(0.6, 'rgba(255,255,255,0.9)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
    }
    // tint
    if (color !== '#ffffff') {
      ctx.globalCompositeOperation = 'source-in';
      ctx.fillStyle = color; ctx.fillRect(0, 0, size, size);
    }
    return toTexture(c, { srgb: true, wrap: THREE.ClampToEdgeWrapping });
  });
}

/** Sky dome gradient + optional clouds/stars, also used to build the env map. */
export function skyCanvas({
  size = 1024, top = '#1d5fd0', horizon = '#bfe0ff', ground = '#2a2a30',
  sunDir = [0.4, 0.5, 0.3], sunColor = '#fff3d0', clouds = 0.4, stars = 0, seed = 5, haze = '#dff0ff',
} = {}) {
  const w = size, h = size / 2;
  const { c, ctx } = canvas(w, h);
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, top);
  g.addColorStop(0.42, horizon);
  g.addColorStop(0.5, haze);
  g.addColorStop(0.52, ground);
  g.addColorStop(1, ground);
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);

  if (stars > 0) {
    const rng = new RNG(seed + 41);
    for (let i = 0; i < 900 * stars; i++) {
      const x = rng.range(0, w), y = rng.range(0, h * 0.46);
      const r = rng.range(0.4, 1.5), a = rng.range(0.15, 0.95) * (1 - y / (h * 0.5));
      ctx.fillStyle = `rgba(255,255,255,${a})`;
      ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
    }
  }
  if (clouds > 0) {
    const n = makeNoise2D(seed);
    const img = ctx.getImageData(0, 0, w, h); const d = img.data;
    for (let y = 0; y < h * 0.5; y++) {
      const fade = smoothstep(0, 0.30, y / (h * 0.5)) * (1 - smoothstep(0.72, 1.0, y / (h * 0.5)));
      for (let x = 0; x < w; x++) {
        const u = (x / w) * 8, v = (y / h) * 10;
        let cl = fbm2D(n, u, v, 5) * 0.5 + 0.5;
        cl = smoothstep(0.52, 0.80, cl) * clouds * fade;
        if (cl <= 0.001) continue;
        const i = (y * w + x) * 4;
        d[i] = lerp(d[i], 255, cl * 0.92);
        d[i + 1] = lerp(d[i + 1], 253, cl * 0.92);
        d[i + 2] = lerp(d[i + 2], 250, cl * 0.88);
      }
    }
    ctx.putImageData(img, 0, 0);
  }
  // sun bloom disc, placed by azimuth of sunDir
  const az = Math.atan2(sunDir[2], sunDir[0]);
  const sx = ((az / (Math.PI * 2) + 0.5) % 1) * w;
  const sy = h * 0.5 * (1 - clamp(sunDir[1], -1, 1));
  const sg = ctx.createRadialGradient(sx, sy, 0, sx, sy, h * 0.42);
  sg.addColorStop(0, sunColor);
  sg.addColorStop(0.05, `${sunColor}cc`);
  sg.addColorStop(0.35, `${sunColor}22`);
  sg.addColorStop(1, `${sunColor}00`);
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = sg; ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'source-over';
  return c;
}

export function skyTexture(opts) {
  const c = skyCanvas(opts);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}

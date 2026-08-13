// Procedural vector font. ART_DIRECTION.md §3 forbids any imported font, and forbids falling back
// to a browser-installed family. So glyphs are defined here as polylines on a unit grid
// (x: 0..advance, y: 0 = cap line, 1 = baseline) and stroked with real line joins.
//
// Two faces:
//   ARCADE  — heavy condensed caps, optional italic skew, optional bevel/metal fill (headings, HUD)
//   SEVENSEG— seven-segment display face (countdown clock, lap splits)
//
// Lowercase renders as small caps at 0.76 height, which reads as a deliberate arcade choice.

const G = {
  A: { w: 0.86, s: [[[0, 1], [0.43, 0], [0.86, 1]], [[0.16, 0.63], [0.70, 0.63]]] },
  B: { w: 0.82, s: [[[0, 0], [0, 1]], [[0, 0], [0.58, 0], [0.80, 0.17], [0.80, 0.34], [0.58, 0.5], [0, 0.5]], [[0.58, 0.5], [0.82, 0.66], [0.82, 0.84], [0.58, 1], [0, 1]]] },
  C: { w: 0.82, s: [[[0.82, 0.16], [0.62, 0], [0.24, 0], [0, 0.22], [0, 0.78], [0.24, 1], [0.62, 1], [0.82, 0.84]]] },
  D: { w: 0.84, s: [[[0, 0], [0, 1]], [[0, 0], [0.52, 0], [0.84, 0.28], [0.84, 0.72], [0.52, 1], [0, 1]]] },
  E: { w: 0.74, s: [[[0.74, 0], [0, 0], [0, 1], [0.74, 1]], [[0, 0.5], [0.58, 0.5]]] },
  F: { w: 0.72, s: [[[0.72, 0], [0, 0], [0, 1]], [[0, 0.5], [0.56, 0.5]]] },
  G: { w: 0.86, s: [[[0.86, 0.16], [0.64, 0], [0.24, 0], [0, 0.22], [0, 0.78], [0.24, 1], [0.66, 1], [0.86, 0.82], [0.86, 0.55], [0.5, 0.55]]] },
  H: { w: 0.84, s: [[[0, 0], [0, 1]], [[0.84, 0], [0.84, 1]], [[0, 0.5], [0.84, 0.5]]] },
  I: { w: 0.5, s: [[[0.06, 0], [0.44, 0]], [[0.25, 0], [0.25, 1]], [[0.06, 1], [0.44, 1]]] },
  J: { w: 0.74, s: [[[0.74, 0], [0.74, 0.76], [0.52, 1], [0.20, 1], [0, 0.80]]] },
  K: { w: 0.82, s: [[[0, 0], [0, 1]], [[0.80, 0], [0, 0.54]], [[0.30, 0.36], [0.82, 1]]] },
  L: { w: 0.7, s: [[[0, 0], [0, 1], [0.70, 1]]] },
  M: { w: 1.0, s: [[[0, 1], [0, 0], [0.5, 0.58], [1.0, 0], [1.0, 1]]] },
  N: { w: 0.86, s: [[[0, 1], [0, 0], [0.86, 1], [0.86, 0]]] },
  O: { w: 0.88, s: [[[0.26, 0], [0.62, 0], [0.88, 0.24], [0.88, 0.76], [0.62, 1], [0.26, 1], [0, 0.76], [0, 0.24], [0.26, 0]]] },
  P: { w: 0.80, s: [[[0, 1], [0, 0], [0.58, 0], [0.80, 0.19], [0.80, 0.38], [0.58, 0.56], [0, 0.56]]] },
  Q: { w: 0.88, s: [[[0.26, 0], [0.62, 0], [0.88, 0.24], [0.88, 0.76], [0.62, 1], [0.26, 1], [0, 0.76], [0, 0.24], [0.26, 0]], [[0.56, 0.68], [0.94, 1.06]]] },
  R: { w: 0.82, s: [[[0, 1], [0, 0], [0.58, 0], [0.80, 0.19], [0.80, 0.38], [0.58, 0.56], [0, 0.56]], [[0.46, 0.56], [0.82, 1]]] },
  S: { w: 0.80, s: [[[0.80, 0.16], [0.58, 0], [0.24, 0], [0.02, 0.18], [0.06, 0.40], [0.30, 0.49], [0.58, 0.53], [0.80, 0.70], [0.74, 0.90], [0.50, 1], [0.18, 1], [0, 0.86]]] },
  T: { w: 0.80, s: [[[0, 0], [0.80, 0]], [[0.40, 0], [0.40, 1]]] },
  U: { w: 0.84, s: [[[0, 0], [0, 0.76], [0.24, 1], [0.60, 1], [0.84, 0.76], [0.84, 0]]] },
  V: { w: 0.84, s: [[[0, 0], [0.42, 1], [0.84, 0]]] },
  W: { w: 1.10, s: [[[0, 0], [0.22, 1], [0.55, 0.34], [0.88, 1], [1.10, 0]]] },
  X: { w: 0.82, s: [[[0, 0], [0.82, 1]], [[0.82, 0], [0, 1]]] },
  Y: { w: 0.82, s: [[[0, 0], [0.41, 0.52], [0.82, 0]], [[0.41, 0.52], [0.41, 1]]] },
  Z: { w: 0.80, s: [[[0, 0], [0.80, 0], [0, 1], [0.80, 1]]] },
  0: { w: 0.80, s: [[[0.24, 0], [0.56, 0], [0.80, 0.24], [0.80, 0.76], [0.56, 1], [0.24, 1], [0, 0.76], [0, 0.24], [0.24, 0]]] },
  1: { w: 0.54, s: [[[0.06, 0.22], [0.34, 0], [0.34, 1]], [[0.04, 1], [0.54, 1]]] },
  2: { w: 0.78, s: [[[0.02, 0.20], [0.24, 0], [0.56, 0], [0.78, 0.20], [0.66, 0.44], [0, 1], [0.78, 1]]] },
  3: { w: 0.78, s: [[[0.04, 0.10], [0.28, 0], [0.58, 0], [0.78, 0.22], [0.56, 0.46], [0.78, 0.72], [0.56, 1], [0.24, 1], [0.02, 0.88]], [[0.34, 0.46], [0.56, 0.46]]] },
  4: { w: 0.82, s: [[[0.60, 1], [0.60, 0], [0, 0.70], [0.82, 0.70]]] },
  5: { w: 0.78, s: [[[0.76, 0], [0.12, 0], [0.04, 0.42], [0.46, 0.38], [0.76, 0.58], [0.72, 0.88], [0.44, 1], [0.14, 1], [0, 0.90]]] },
  6: { w: 0.80, s: [[[0.72, 0.08], [0.46, 0], [0.20, 0.06], [0.02, 0.40], [0, 0.78], [0.22, 1], [0.56, 1], [0.80, 0.80], [0.66, 0.52], [0.28, 0.48], [0.04, 0.62]]] },
  7: { w: 0.76, s: [[[0, 0], [0.76, 0], [0.30, 1]]] },
  8: { w: 0.80, s: [[[0.28, 0], [0.54, 0], [0.76, 0.18], [0.54, 0.46], [0.26, 0.46], [0.04, 0.18], [0.28, 0]], [[0.26, 0.46], [0.02, 0.72], [0.24, 1], [0.58, 1], [0.80, 0.72], [0.54, 0.46]]] },
  9: { w: 0.80, s: [[[0.08, 0.92], [0.34, 1], [0.60, 0.94], [0.78, 0.60], [0.80, 0.22], [0.58, 0], [0.24, 0], [0, 0.20], [0.14, 0.48], [0.52, 0.52], [0.76, 0.38]]] },
  ' ': { w: 0.40, s: [] },
  '.': { w: 0.30, s: [[[0.15, 0.94], [0.15, 1]]] },
  ',': { w: 0.30, s: [[[0.18, 0.90], [0.06, 1.14]]] },
  ':': { w: 0.30, s: [[[0.15, 0.28], [0.15, 0.38]], [[0.15, 0.86], [0.15, 0.96]]] },
  ';': { w: 0.30, s: [[[0.15, 0.28], [0.15, 0.38]], [[0.18, 0.86], [0.06, 1.10]]] },
  '-': { w: 0.56, s: [[[0.06, 0.54], [0.50, 0.54]]] },
  '_': { w: 0.70, s: [[[0, 1.06], [0.70, 1.06]]] },
  '/': { w: 0.62, s: [[[0.62, -0.06], [0, 1.06]]] },
  '\\': { w: 0.62, s: [[[0, -0.06], [0.62, 1.06]]] },
  "'": { w: 0.26, s: [[[0.16, 0], [0.06, 0.30]]] },
  '"': { w: 0.42, s: [[[0.14, 0], [0.04, 0.28]], [[0.36, 0], [0.26, 0.28]]] },
  '!': { w: 0.32, s: [[[0.16, 0], [0.16, 0.66]], [[0.16, 0.92], [0.16, 1]]] },
  '?': { w: 0.72, s: [[[0.04, 0.20], [0.24, 0], [0.50, 0], [0.70, 0.20], [0.60, 0.42], [0.36, 0.54], [0.36, 0.70]], [[0.36, 0.92], [0.36, 1]]] },
  '#': { w: 0.90, s: [[[0.26, 0], [0.14, 1]], [[0.62, 0], [0.50, 1]], [[0.04, 0.32], [0.82, 0.32]], [[0, 0.70], [0.78, 0.70]]] },
  '%': { w: 0.94, s: [[[0.86, 0], [0.10, 1]], [[0.06, 0], [0.30, 0], [0.30, 0.30], [0.06, 0.30], [0.06, 0]], [[0.64, 0.70], [0.88, 0.70], [0.88, 1], [0.64, 1], [0.64, 0.70]]] },
  '+': { w: 0.74, s: [[[0.37, 0.20], [0.37, 0.86]], [[0.04, 0.53], [0.70, 0.53]]] },
  '*': { w: 0.60, s: [[[0.30, 0.08], [0.30, 0.52]], [[0.11, 0.19], [0.49, 0.41]], [[0.49, 0.19], [0.11, 0.41]]] },
  '=': { w: 0.74, s: [[[0.04, 0.38], [0.70, 0.38]], [[0.04, 0.68], [0.70, 0.68]]] },
  '(': { w: 0.42, s: [[[0.36, -0.04], [0.10, 0.28], [0.10, 0.74], [0.36, 1.06]]] },
  ')': { w: 0.42, s: [[[0.06, -0.04], [0.32, 0.28], [0.32, 0.74], [0.06, 1.06]]] },
  '[': { w: 0.40, s: [[[0.34, -0.04], [0.10, -0.04], [0.10, 1.06], [0.34, 1.06]]] },
  ']': { w: 0.40, s: [[[0.06, -0.04], [0.30, -0.04], [0.30, 1.06], [0.06, 1.06]]] },
  '<': { w: 0.62, s: [[[0.54, 0.10], [0.06, 0.53], [0.54, 0.96]]] },
  '>': { w: 0.62, s: [[[0.08, 0.10], [0.56, 0.53], [0.08, 0.96]]] },
  '°': { w: 0.44, s: [[[0.12, 0.06], [0.30, 0.06], [0.36, 0.20], [0.30, 0.34], [0.12, 0.34], [0.06, 0.20], [0.12, 0.06]]] },
  '&': { w: 0.90, s: [[[0.88, 1], [0.30, 0.42], [0.18, 0.26], [0.28, 0.04], [0.50, 0.04], [0.58, 0.24], [0.10, 0.62], [0.06, 0.84], [0.26, 1], [0.56, 0.96], [0.78, 0.66]]] },
  '×': { w: 0.60, s: [[[0.08, 0.28], [0.52, 0.80]], [[0.52, 0.28], [0.08, 0.80]]] },
};

const FALLBACK = { w: 0.7, s: [[[0.05, 0.05], [0.65, 0.05], [0.65, 0.95], [0.05, 0.95], [0.05, 0.05]]] };

function glyph(ch) {
  if (G[ch]) return G[ch];
  const up = ch.toUpperCase();
  if (G[up]) return G[up];
  return FALLBACK;
}

/**
 * Measure a string in the ARCADE face.
 * @returns {{width:number, height:number}} in pixels
 */
export function measure(text, { size = 32, tracking = 0.08, smallCaps = true } = {}) {
  let w = 0;
  for (const ch of text) {
    const isLower = smallCaps && ch >= 'a' && ch <= 'z';
    const g = glyph(ch);
    w += (g.w * (isLower ? 0.80 : 1) + tracking) * size;
  }
  return { width: Math.max(0, w - tracking * size), height: size };
}

/**
 * Draw text in the ARCADE face.
 *
 * @param ctx Canvas2D context
 * @param text string
 * @param o.x,o.y            anchor (y is the BASELINE)
 * @param o.size             cap height in px
 * @param o.weight           stroke width as a fraction of size (0.10 light … 0.24 heavy)
 * @param o.italic           shear in x per unit y (0.22 ≈ the reference's aggressive lean)
 * @param o.tracking         extra advance per glyph, fraction of size
 * @param o.align            'left'|'center'|'right'
 * @param o.color            stroke colour, or a function(ctx,w,h)=>fillStyle for gradients
 * @param o.outline          {color, width} drawn behind for legibility over bright scenes
 * @param o.glow             {color, blur} outer glow
 * @param o.bevel            true → adds a light top edge + dark bottom edge (metallic arcade look)
 */
export function drawText(ctx, text, o = {}) {
  const {
    x = 0, y = 0, size = 32, weight = 0.17, italic = 0, tracking = 0.08,
    align = 'left', color = '#ffffff', outline = null, glow = null,
    bevel = false, smallCaps = true, alpha = 1,
  } = o;

  const m = measure(text, { size, tracking, smallCaps });
  let ox = x;
  if (align === 'center') ox = x - m.width / 2;
  else if (align === 'right') ox = x - m.width;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  const emit = (strokeStyle, lw, dx = 0, dy = 0, blur = 0, blurColor = null) => {
    ctx.save();
    if (blur) { ctx.shadowBlur = blur; ctx.shadowColor = blurColor || strokeStyle; }
    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = lw;
    let cx = ox + dx;
    for (const ch of text) {
      const isLower = smallCaps && ch >= 'a' && ch <= 'z';
      const h = size * (isLower ? 0.80 : 1);
      const g = glyph(ch);
      const baseY = y + dy;
      for (const poly of g.s) {
        ctx.beginPath();
        for (let i = 0; i < poly.length; i++) {
          const gx = poly[i][0] * h;
          const gy = (poly[i][1] - 1) * h;           // shift so y=1 sits on baseline
          const px = cx + gx - gy * italic;           // italic shear
          const py = baseY + gy;
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
      cx += (g.w * (isLower ? 0.80 : 1) + tracking) * size;
    }
    ctx.restore();
  };

  const lw = size * weight;
  if (glow) emit(glow.color, lw, 0, 0, glow.blur || size * 0.5, glow.color);
  if (outline) emit(outline.color, lw + (outline.width ?? size * 0.10) * 2);
  if (bevel) {
    emit('rgba(255,255,255,0.75)', lw, -size * 0.035, -size * 0.045);
    emit('rgba(0,0,0,0.60)', lw, size * 0.035, size * 0.05);
  }

  let stroke = color;
  if (typeof color === 'function') stroke = color(ctx, m.width, size, ox, y);
  emit(stroke, lw);
  ctx.restore();
  return m;
}

/** Vertical gradient helper for chrome / neon fills. Pass as `color`. */
export function gradientFill(stops) {
  return (ctx, w, h, ox, y) => {
    const g = ctx.createLinearGradient(0, y - h, 0, y + h * 0.12);
    for (const [t, c] of stops) g.addColorStop(t, c);
    return g;
  };
}

// ------------------------------------------------------------------ seven segment

//        a
//      f   b
//        g
//      e   c
//        d
const SEG = {
  0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc', 5: 'afgcd',
  6: 'afgedc', 7: 'abc', 8: 'abcdefg', 9: 'abfgcd', '-': 'g', ' ': '',
};
const SEGPTS = {
  a: [[0.12, 0.02], [0.88, 0.02]], b: [[0.94, 0.08], [0.94, 0.46]],
  c: [[0.94, 0.54], [0.94, 0.92]], d: [[0.12, 0.98], [0.88, 0.98]],
  e: [[0.06, 0.54], [0.06, 0.92]], f: [[0.06, 0.08], [0.06, 0.46]],
  g: [[0.12, 0.50], [0.88, 0.50]],
};

/**
 * Seven-segment display (the reference's red countdown clock and cyan lap timer).
 * Unlit segments are drawn at low alpha so the display reads as physical hardware.
 */
export function drawSevenSeg(ctx, text, {
  x = 0, y = 0, size = 40, color = '#ff2e2e', dim = 0.13, tracking = 0.22,
  italic = 0.06, glow = 10, align = 'left', alpha = 1,
} = {}) {
  const digitW = size * 0.62;
  const adv = digitW + size * tracking;
  let total = 0;
  for (const ch of text) total += (ch === ':' || ch === '.') ? size * 0.34 : adv;
  total -= size * tracking;
  let cx = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineCap = 'round';
  ctx.lineWidth = size * 0.13;

  for (const ch of text) {
    if (ch === ':' || ch === '.') {
      ctx.fillStyle = color; ctx.shadowBlur = glow; ctx.shadowColor = color;
      const r = size * 0.055;
      if (ch === ':') {
        ctx.beginPath(); ctx.arc(cx + size * 0.12 - size * 0.30 * italic, y - size * 0.62, r, 0, 7); ctx.fill();
        ctx.beginPath(); ctx.arc(cx + size * 0.12 - size * 0.10 * italic, y - size * 0.22, r, 0, 7); ctx.fill();
      } else {
        ctx.beginPath(); ctx.arc(cx + size * 0.12, y - size * 0.04, r, 0, 7); ctx.fill();
      }
      ctx.shadowBlur = 0;
      cx += size * 0.34;
      continue;
    }
    const on = SEG[ch] ?? SEG[' '];
    for (const s of Object.keys(SEGPTS)) {
      const lit = on.includes(s);
      ctx.globalAlpha = alpha * (lit ? 1 : dim);
      ctx.strokeStyle = color;
      ctx.shadowBlur = lit ? glow : 0;
      ctx.shadowColor = color;
      const [p0, p1] = SEGPTS[s];
      const map = (p) => {
        const gy = (p[1] - 1) * size;
        return [cx + p[0] * digitW - gy * italic, y + gy];
      };
      const A = map(p0), B = map(p1);
      ctx.beginPath(); ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0], B[1]); ctx.stroke();
    }
    ctx.shadowBlur = 0;
    cx += adv;
  }
  ctx.restore();
}

/** Render text to a standalone transparent CanvasTexture (for 3D signage, decals, banners). */
export function textCanvas(text, o = {}) {
  const size = o.size || 64;
  const pad = size * 0.6;
  const m = measure(text, { size, tracking: o.tracking ?? 0.08 });
  const c = document.createElement('canvas');
  c.width = Math.max(4, Math.ceil(m.width + pad * 2 + size * (o.italic || 0)));
  c.height = Math.ceil(size * 1.9 + pad);
  const ctx = c.getContext('2d');
  drawText(ctx, text, { ...o, x: pad, y: size * 1.25, size });
  return c;
}

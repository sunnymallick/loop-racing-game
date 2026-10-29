#!/usr/bin/env node
/**
 * Figure check for the procedural font: renders 0-9 large in both faces and MEASURES them.
 *
 *   node tools/glyphcheck.mjs [--out shots/glyphs] [--size 120] [--font _old_font.js]
 *
 * Two things a broken outline leaves behind, and both are counted per glyph in a plain white mask
 * rendered at the HUD's heavy weight (0.215, the readout's pen; 0.19 for the geometric face):
 *   holes  — enclosed unlit regions. Each figure has an expected count (0:1, 4:1, 6:1, 8:2, 9:1,
 *            the rest 0). An extra one is a pocket left where two contours failed to meet, which
 *            the nitrous glow then shines through; a counter of a few pixels is one choked shut.
 *   seams  — pixels at least 12 % uncovered with ink on all four sides: a sliver where two
 *            contours abut inside the stroke instead of being one outline.
 * Run it at 120 px, where every figure must pass. Below ~50 px single corner pixels start to trip
 * the seam test on any glyph, so there read the hole sizes, not the verdict.
 * `--font` loads another file from src/core/ in place of font.js, for a before/after.
 * Exit 1 if any figure fails. Set CHROME_PATH to use a specific Chromium.
 * It also writes a contact sheet (glow + bevel + sheen, as the speed readout and the position
 * numeral draw them) for the eye.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { ROOT } from './harness.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i === -1 ? d : argv[i + 1]; };
const OUT = path.resolve(ROOT, arg('out', 'shots/glyphs'));
const SIZE = Number(arg('size', 120));
const FONTFILE = arg('font', 'font.js');

const server = await createServer({
  root: ROOT, logLevel: 'error',
  server: { port: 20000 + Math.floor(Math.random() * 30000), host: '127.0.0.1', hmr: false, watch: null },
});
await server.listen();
const url = server.resolvedUrls.local[0].replace(/\/$/, '');
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  args: ['--disable-dev-shm-usage', '--force-device-scale-factor=1'],
});
const page = await browser.newPage();
await page.goto(`${url}/package.json`);

const res = await page.evaluate(async ([base, S, FONT]) => {
  const F = await import(`${base}/src/core/${FONT}`);
  const EXPECT = { 0: 1, 1: 0, 2: 0, 3: 0, 4: 1, 5: 0, 6: 1, 7: 0, 8: 2, 9: 1 };

  function analyse(ch, face, italic) {
    const W = Math.ceil(S * 1.4), H = Math.ceil(S * 1.6);
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const x = c.getContext('2d');
    F.drawText(x, ch, { x: S * 0.2, y: S * 1.25, size: S, weight: face === 'geo' ? 0.19 : 0.215, italic, face, color: '#fff' });
    const a = x.getImageData(0, 0, W, H).data;
    const A = (i) => a[i * 4 + 3];
    const N = W * H;
    // flood the background in from the border; whatever unlit pixels remain are enclosed
    const seen = new Uint8Array(N);
    const stack = [];
    const push = (i) => { if (!seen[i] && A(i) < 128) { seen[i] = 1; stack.push(i); } };
    for (let i = 0; i < W; i++) { push(i); push(N - 1 - i); }
    for (let j = 0; j < H; j++) { push(j * W); push(j * W + W - 1); }
    const flood = () => {
      let n = 0, sx = 0, sy = 0;
      while (stack.length) {
        const i = stack.pop(); n++; sx += i % W; sy += (i / W) | 0;
        const px = i % W;
        if (px > 0) push(i - 1); if (px < W - 1) push(i + 1);
        if (i >= W) push(i - W); if (i < N - W) push(i + W);
      }
      // size, and centroid in cap-height units from the glyph's origin (x right, y down from the cap line)
      return n ? `${n}@${(sx / n / S - 0.2).toFixed(2)},${(sy / n / S - 0.25).toFixed(2)}` : '0';
    };
    flood();
    const holes = [];
    for (let i = 0; i < N; i++) if (!seen[i] && A(i) < 128) { push(i); holes.push(flood()); }
    const seams = [];
    for (let j = 1; j < H - 1; j++) for (let i = 1; i < W - 1; i++) {
      const k = j * W + i;
      if (A(k) < 224 && A(k - 1) >= 128 && A(k + 1) >= 128 && A(k - W) >= 128 && A(k + W) >= 128) {
        seams.push(`${(i / S - 0.2).toFixed(2)},${(j / S - 0.25).toFixed(2)}`);
      }
    }
    const mask = seams.length || holes.length !== EXPECT[ch] ? c.toDataURL() : null;
    return { mask, ch, face, holes: holes.sort((p, q) => parseInt(q) - parseInt(p)), expect: EXPECT[ch], seams: seams.length, seamAt: seams.slice(0, 4) };
  }

  const report = [];
  for (const face of ['display', 'geo']) {
    for (const ch of '0123456789') report.push(analyse(ch, face, face === 'geo' ? 0 : 0.24));
  }

  // contact sheet: the readout's treatment, then the position numeral's, then the geometric face
  const c = document.createElement('canvas'); c.width = Math.ceil(S * 9.6); c.height = Math.ceil(S * 4.6);
  const x = c.getContext('2d');
  x.fillStyle = '#0b1220'; x.fillRect(0, 0, c.width, c.height);
  const grad = F.gradientFill([[0, '#ffffff'], [0.5, '#f2f8fd'], [0.58, '#a8bccf'], [1, '#ffffff']]);
  F.drawText(x, '0123456789', {
    x: S * 0.3, y: S * 1.3, size: S, weight: 0.215, italic: 0.06, tracking: 0.02, color: grad, sheen: true,
    shadow: { color: 'rgba(0,0,0,0.6)', dy: S * 0.03, blur: 6 }, glow: { color: '#ff8a1a', blur: 22 },
  });
  F.drawText(x, '0123456789', {
    x: S * 0.3, y: S * 2.75, size: S, weight: 0.215, italic: 0.24, color: grad, bevel: true, sheen: true,
    glow: { color: '#ff8a1a', blur: 26 },
  });
  F.drawText(x, '0123456789  +3.80', { x: S * 0.3, y: S * 3.75, size: S * 0.5, weight: 0.19, face: 'geo', color: '#e8f0f8' });
  F.drawSevenSeg(x, '02:08:21  00:16:38  11:11', { x: S * 0.3, y: S * 4.45, size: S * 0.45, color: '#3fe0ff', glow: 8 });
  return { report, png: c.toDataURL('image/png') };
}, [url, SIZE, FONTFILE]);

await fs.mkdir(OUT, { recursive: true });
await fs.writeFile(path.join(OUT, 'figures.png'), Buffer.from(res.png.split(',')[1], 'base64'));
let bad = 0;
for (const r of res.report) {
  const ok = r.holes.length === r.expect && r.seams === 0;
  if (!ok) {
    bad++;
    if (r.mask) await fs.writeFile(path.join(OUT, `fail-${r.face}-${r.ch}.png`), Buffer.from(r.mask.split(',')[1], 'base64'));
  }
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${r.face.padEnd(7)} ${r.ch}  holes ${r.holes.length}/${r.expect} [${r.holes.join(',')}]  seams ${r.seams}${r.seams ? ` at ${r.seamAt.join(' ')}` : ''}`);
}
console.log(`${bad} bad glyph(s); sheet -> ${path.join(OUT, 'figures.png')}`);
await browser.close();
await server.close();
process.exit(bad ? 1 : 0);

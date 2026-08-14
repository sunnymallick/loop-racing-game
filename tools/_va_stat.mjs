// mean/std/percentile luminance of a rect in a PNG.  node stat.mjs file.png x y w h [label]
import { chromium } from 'playwright';
import fs from 'node:fs';

const args = process.argv.slice(2);
const png = args[0];
const rects = [];
for (let i = 1; i + 3 < args.length; i += 5) {
  rects.push({ x: +args[i], y: +args[i + 1], w: +args[i + 2], h: +args[i + 3], label: args[i + 4] || '' });
}
const b64 = fs.readFileSync(png).toString('base64');
const browser = await chromium.launch();
const page = await browser.newPage();
const out = await page.evaluate(async ([b64, rects]) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + b64;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return rects.map((r) => {
    const d = ctx.getImageData(r.x, r.y, r.w, r.h).data;
    const L = [];
    let sr = 0, sg = 0, sb = 0;
    for (let o = 0; o < d.length; o += 4) {
      L.push(0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2]);
      sr += d[o]; sg += d[o + 1]; sb += d[o + 2];
    }
    const n = L.length;
    const mean = L.reduce((a, b) => a + b, 0) / n;
    const std = Math.sqrt(L.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
    L.sort((a, b) => a - b);
    return {
      label: r.label, mean: +mean.toFixed(1), std: +std.toFixed(1),
      p5: L[Math.floor(n * 0.05)], p50: L[Math.floor(n * 0.5)], p95: L[Math.floor(n * 0.95)],
      rgb: [sr / n, sg / n, sb / n].map((v) => Math.round(v)).join(','),
    };
  });
}, [b64, rects]);
for (const r of out) console.log(`${r.label.padEnd(16)} mean ${String(r.mean).padStart(6)}  std ${String(r.std).padStart(5)}  p5 ${String(r.p5).padStart(4)}  p50 ${String(r.p50).padStart(4)}  p95 ${String(r.p95).padStart(4)}  rgb ${r.rgb}`);
await browser.close();

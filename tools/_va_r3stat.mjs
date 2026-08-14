// Builder scratch tool (vehicle-art r3): mean/std/min/max luminance of a rectangle in a PNG.
// usage: node tools/_va_r3stat.mjs file.png x y w h [label]
import { chromium } from 'playwright';
import fs from 'fs';
const args = process.argv.slice(2);
const png = args[0];
const rects = [];
for (let i = 1; i + 4 < args.length + 1; i += 5) {
  if (args[i] === undefined) break;
  rects.push({ x: +args[i], y: +args[i + 1], w: +args[i + 2], h: +args[i + 3], label: args[i + 4] || `r${rects.length}` });
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
    let s = 0, s2 = 0, n = 0, mn = 999, mx = -1, sr = 0, sg = 0, sb = 0;
    for (let o = 0; o < d.length; o += 4) {
      const L = 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2];
      s += L; s2 += L * L; n++; sr += d[o]; sg += d[o + 1]; sb += d[o + 2];
      if (L < mn) mn = L; if (L > mx) mx = L;
    }
    const mean = s / n;
    return {
      label: r.label, mean: +mean.toFixed(1), std: +Math.sqrt(s2 / n - mean * mean).toFixed(1),
      min: +mn.toFixed(0), max: +mx.toFixed(0),
      rgb: [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)],
    };
  });
}, [b64, rects]);
for (const r of out) console.log(`${r.label.padEnd(18)} mean=${String(r.mean).padStart(6)} std=${String(r.std).padStart(5)} min=${String(r.min).padStart(3)} max=${String(r.max).padStart(3)} rgb=${r.rgb.join(',')}`);
await browser.close();

// Pixel stats over rectangles of a PNG. usage: node tools/_mi_px_r3.mjs file.png '[{"name":"road","x":950,"y":700,"w":250,"h":150}]'
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
const f = process.argv[2];
const b64 = (await fs.readFile(f)).toString('base64');
const regions = JSON.parse(process.argv[3]);
const br = await chromium.launch();
const p = await br.newPage();
await p.setContent('<canvas id=c width=1600 height=900></canvas>');
const out = await p.evaluate(async ({ b64, regions }) => {
  const img = new Image();
  await new Promise(r => { img.onload = r; img.src = 'data:image/png;base64,' + b64; });
  const c = document.getElementById('c').getContext('2d', { willReadFrequently: true });
  c.drawImage(img, 0, 0);
  return regions.map(rg => {
    const d = c.getImageData(rg.x, rg.y, rg.w, rg.h).data;
    const n = d.length / 4;
    let sr = 0, sg = 0, sb = 0, mn = 999, mx = -1;
    const vs = [];
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      sr += r; sg += g; sb += b;
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      if (l < mn) mn = l; if (l > mx) mx = l;
      vs.push(l);
    }
    const mean = vs.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(vs.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
    const srt = vs.slice().sort((a, b) => a - b);
    const pct = (q) => +srt[Math.floor(q * (n - 1))].toFixed(1);
    // saturation spread: mean of (max-min channel)
    let sat = 0;
    for (let i = 0; i < d.length; i += 4) sat += Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]);
    return {
      name: rg.name, mean: +mean.toFixed(1), sd: +sd.toFixed(2), min: +mn.toFixed(1), max: +mx.toFixed(1),
      p05: pct(0.05), p50: pct(0.5), p95: pct(0.95),
      rgb: [sr / n | 0, sg / n | 0, sb / n | 0], sat: +(sat / n).toFixed(1),
    };
  });
}, { b64, regions });
console.log(JSON.stringify(out));
await br.close();

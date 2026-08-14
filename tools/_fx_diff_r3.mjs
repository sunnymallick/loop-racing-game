/** Pixel-diff two PNGs, report the changed bounding box and write a red-highlight overlay. */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const [a, b, out] = process.argv.slice(2);
const enc = (p) => fs.readFileSync(path.resolve(p)).toString('base64');
const browser = await chromium.launch();
const page = await browser.newPage();
const res = await page.evaluate(async ([A, B]) => {
  const load = (d) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = `data:image/png;base64,${d}`; });
  const ia = await load(A), ib = await load(B);
  const w = ia.width, h = ia.height;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d');
  x.drawImage(ia, 0, 0); const da = x.getImageData(0, 0, w, h).data;
  x.clearRect(0, 0, w, h); x.drawImage(ib, 0, 0);
  const img = x.getImageData(0, 0, w, h); const db = img.data;
  let n = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    const d = Math.abs(da[o] - db[o]) + Math.abs(da[o + 1] - db[o + 1]) + Math.abs(da[o + 2] - db[o + 2]);
    if (d > 26) {
      n++;
      const px = i % w, py = (i / w) | 0;
      if (px < x0) x0 = px; if (px > x1) x1 = px;
      if (py < y0) y0 = py; if (py > y1) y1 = py;
      db[o] = 255; db[o + 1] = 40; db[o + 2] = 40;
    }
  }
  x.putImageData(img, 0, 0);
  return { n, pct: +(100 * n / (w * h)).toFixed(2), box: x1 < 0 ? null : [x0, y0, x1 - x0, y1 - y0], url: c.toDataURL('image/png') };
}, [enc(a), enc(b)]);
if (out && res.url) fs.writeFileSync(out, Buffer.from(res.url.split(',')[1], 'base64'));
console.log(JSON.stringify({ n: res.n, pct: res.pct, box: res.box }));
await browser.close();

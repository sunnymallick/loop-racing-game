import { chromium } from 'playwright';
import fs from 'fs';
const [png, xs, ys, ws, hs] = process.argv.slice(2);
const b64 = fs.readFileSync(png).toString('base64');
const browser = await chromium.launch();
const page = await browser.newPage();
const out = await page.evaluate(async ([b64, x, y, w, h]) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + b64;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(x, y, w, h).data;
  const rows = [];
  for (let j = 0; j < h; j++) {
    let s = '';
    for (let i = 0; i < w; i++) {
      const o = (j * w + i) * 4;
      s += `${d[o]},${d[o + 1]},${d[o + 2]} `;
    }
    rows.push(s);
  }
  return rows;
}, [b64, +xs, +ys, +ws, +hs]);
console.log(out.join('\n'));
await browser.close();

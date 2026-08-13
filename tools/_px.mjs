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
  const ramp = ' .:-=+*#%@';
  const rows = [];
  const set = new Set();
  for (let j = 0; j < h; j++) {
    let s = '';
    for (let i = 0; i < w; i++) {
      const o = (j * w + i) * 4;
      const L = 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2];
      set.add(Math.round(L));
      s += ramp[Math.min(9, Math.floor(L / 25.6))];
    }
    rows.push(s);
  }
  return { rows, levels: [...set].sort((a, b) => a - b) };
}, [b64, +xs, +ys, +ws, +hs]);
console.log(out.rows.join('\n'));
console.log('distinct luminance levels:', out.levels.length, out.levels.slice(0, 40).join(','));
await browser.close();

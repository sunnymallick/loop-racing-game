// Private probe: average RGB in a small box of a PNG. Not shipped code.
// Usage: node tools/_va_px.mjs <png> <x> <y> [halfsize]
import { chromium } from 'playwright';
import fs from 'node:fs';
const [png, xs, ys, hs = '5'] = process.argv.slice(2);
const b64 = fs.readFileSync(png).toString('base64');
const browser = await chromium.launch();
const page = await browser.newPage();
const out = await page.evaluate(async ([b64, x, y, h]) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + b64;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const n = h * 2 + 1;
  const d = ctx.getImageData(x - h, y - h, n, n).data;
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < n * n; i++) { r += d[i * 4]; g += d[i * 4 + 1]; b += d[i * 4 + 2]; }
  return [Math.round(r / (n * n)), Math.round(g / (n * n)), Math.round(b / (n * n)), img.width, img.height];
}, [b64, Number(xs), Number(ys), Number(hs)]);
console.log(png, out.slice(0, 3).join(','), `(${out[3]}x${out[4]})`);
await browser.close();

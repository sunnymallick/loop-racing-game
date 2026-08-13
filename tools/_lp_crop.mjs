// scratch: crop a region out of a PNG at 1:1 (or 2x) using the browser's canvas via sharp-free path
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

// usage: node tools/_lp_crop.mjs in.png out.png x y w h [scale]
const [inp, outp, x, y, w, hh, scale = 2] = process.argv.slice(2);
const buf = await fs.readFile(path.resolve(inp));
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const b64 = buf.toString('base64');
const png = await page.evaluate(async ([data, X, Y, W, H, S]) => {
  const img = new Image();
  img.src = `data:image/png;base64,${data}`;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = W * S; c.height = H * S;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, X, Y, W, H, 0, 0, W * S, H * S);
  return c.toDataURL('image/png').split(',')[1];
}, [b64, +x, +y, +w, +hh, +scale]);
await fs.writeFile(path.resolve(outp), Buffer.from(png, 'base64'));
await browser.close();
console.log(outp);

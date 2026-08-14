// Builder probe: mean RGB of rectangles in a PNG. Not shipped code.
//   node tools/_lv_ground.mjs shot.png x,y,w,h[:label] x,y,w,h ...
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const [inFile, ...boxes] = process.argv.slice(2);
const b64 = (await fs.readFile(path.resolve(inFile))).toString('base64');
const browser = await chromium.launch();
const page = await browser.newPage();
const out = await page.evaluate(async ([b64, boxes]) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + b64;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return boxes.map((spec) => {
    const [rect, label] = spec.split(':');
    const [x, y, w, h] = rect.split(',').map(Number);
    const d = ctx.getImageData(x, y, w, h).data;
    let r = 0, g = 0, b = 0;
    const n = w * h;
    for (let i = 0; i < n; i++) { r += d[i * 4]; g += d[i * 4 + 1]; b += d[i * 4 + 2]; }
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / n;
    return `${label || rect}  rgb(${(r / n).toFixed(1)},${(g / n).toFixed(1)},${(b / n).toFixed(1)})  Y=${lum.toFixed(1)}`;
  }).join('\n');
}, [b64, boxes]);
console.log(out);
await browser.close();

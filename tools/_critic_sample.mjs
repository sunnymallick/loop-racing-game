import { chromium } from 'playwright';
import fs from 'fs';
const png = process.argv[2];
const pts = process.argv.slice(3).map((s) => s.split(',').map(Number));
const b64 = fs.readFileSync(png).toString('base64');
const browser = await chromium.launch();
const page = await browser.newPage();
const out = await page.evaluate(async ([b64, pts]) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + b64;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return pts.map(([x, y, w = 8, h = 8]) => {
    const d = ctx.getImageData(x, y, w, h).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
    return `${x},${y} -> rgb(${Math.round(r / n)},${Math.round(g / n)},${Math.round(b / n)})`;
  });
}, [b64, pts]);
console.log(out.join('\n'));
await browser.close();

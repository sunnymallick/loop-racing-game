import { chromium } from 'playwright';
import fs from 'fs';
const png = process.argv[2];
const regions = JSON.parse(process.argv[3]);
const b64 = fs.readFileSync(png).toString('base64');
const browser = await chromium.launch();
const page = await browser.newPage();
const out = await page.evaluate(async ([b64, regions]) => {
  const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
  return regions.map(([name, x, y, w, h]) => {
    const d = ctx.getImageData(x, y, w, h).data;
    let r = 0, g = 0, b = 0; const n = w * h;
    for (let i = 0; i < n; i++) { r += d[i*4]; g += d[i*4+1]; b += d[i*4+2]; }
    return `${name.padEnd(22)} rgb(${Math.round(r/n)},${Math.round(g/n)},${Math.round(b/n)})  L=${Math.round((0.299*r+0.587*g+0.114*b)/n)}`;
  });
}, [b64, regions]);
console.log(out.join('\n'));
await browser.close();

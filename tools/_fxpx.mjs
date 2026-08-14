/**
 * Pixel statistics for a screenshot region (builder tool).
 *   node tools/_fxpx.mjs shot.png [x y w h]
 * Reports the fraction of the region that is clipped to white, the fraction that is "hot"
 * (luminance > 200), and the mean luminance — the numbers behind "the car is blown out".
 */
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const [inFile, x = 0, y = 0, w = 0, h = 0] = process.argv.slice(2);
const b64 = (await fs.readFile(path.resolve(inFile))).toString('base64');
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent('<body></body>');
const out = await page.evaluate(async ([src, X, Y, W, H]) => {
  const img = new Image();
  await new Promise((r) => { img.onload = r; img.src = src; });
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  c.getContext('2d').drawImage(img, 0, 0);
  const rx = +X || 0, ry = +Y || 0;
  const rw = +W || img.width, rh = +H || img.height;
  const d = c.getContext('2d').getImageData(rx, ry, rw, rh).data;
  let clip = 0, hot = 0, sum = 0, n = 0, sat = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (r > 250 && g > 248 && b > 244) clip++;
    if (l > 200) hot++;
    if (Math.max(r, g, b) > 252) sat++;
    sum += l; n++;
  }
  return {
    region: [rx, ry, rw, rh],
    clipPct: +(clip / n * 100).toFixed(2),
    hotPct: +(hot / n * 100).toFixed(2),
    anyChanSatPct: +(sat / n * 100).toFixed(2),
    mean: +(sum / n).toFixed(1),
  };
}, [`data:image/png;base64,${b64}`, x, y, w, h]);
console.log(path.basename(inFile), JSON.stringify(out));
await browser.close();

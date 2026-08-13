import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

// usage: node _crop.mjs <png> <outprefix> <zoom> x,y,w,h [x,y,w,h ...]
const [png, outPrefix, zoomStr, ...regions] = process.argv.slice(2);
const zoom = Number(zoomStr) || 2;
const abs = path.resolve(png);
const b64 = fs.readFileSync(abs).toString('base64');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
for (let i = 0; i < regions.length; i++) {
  const [x, y, w, h] = regions[i].split(',').map(Number);
  await page.setViewportSize({ width: Math.ceil(w * zoom), height: Math.ceil(h * zoom) });
  await page.setContent(`<style>html,body{margin:0;background:#000;overflow:hidden}
  img{position:absolute;image-rendering:pixelated;transform-origin:0 0;
  transform:scale(${zoom}) translate(${-x}px,${-y}px)}</style><img src="data:image/png;base64,${b64}">`);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${outPrefix}-${i}.png` });
  console.log(`${outPrefix}-${i}.png  <= ${x},${y} ${w}x${h} @${zoom}x`);
}
await browser.close();

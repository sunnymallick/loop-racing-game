#!/usr/bin/env node
/**
 * High-frequency content of a rectangle, the way the whole-game critic measured the ground:
 * mean |ΔL| between horizontally / vertically adjacent pixels, plus mean luminance and its sd.
 *
 *   node tools/hf.mjs shots/x/f.png 1130,420,140,90 [more rects...]
 *
 * A surface with real aggregate in it runs 6-10 on a 0-255 scale at chase-camera range; a coloured
 * plane runs 1-2. §7's "built to one standard on the racing line and another two metres either
 * side of it" is exactly this number differing between two patches of the same frame.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const [png, ...rects] = process.argv.slice(2);
const b64 = fs.readFileSync(png).toString('base64');
const browser = await chromium.launch();
const page = await browser.newPage();
const out = await page.evaluate(async ([b64, rects]) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + b64;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return rects.map((r) => {
    const [x, y, w, h] = r.split(',').map(Number);
    const d = ctx.getImageData(x, y, w, h).data;
    const L = new Float64Array(w * h);
    for (let i = 0; i < w * h; i++) {
      L[i] = 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2];
    }
    let hx = 0, nx = 0, hy = 0, ny = 0, sum = 0, sum2 = 0;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const v = L[j * w + i];
        sum += v; sum2 += v * v;
        if (i + 1 < w) { hx += Math.abs(L[j * w + i + 1] - v); nx++; }
        if (j + 1 < h) { hy += Math.abs(L[(j + 1) * w + i] - v); ny++; }
      }
    }
    const n = w * h, mean = sum / n;
    return `${r}  hfH ${(hx / nx).toFixed(2)}  hfV ${(hy / ny).toFixed(2)}  mean ${mean.toFixed(1)}  sd ${Math.sqrt(sum2 / n - mean * mean).toFixed(1)}`;
  });
}, [b64, rects]);
console.log(png);
for (const line of out) console.log('  ' + line);
await browser.close();

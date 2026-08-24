/**
 * PNG analysis + crop/zoom, via a headless canvas.
 *   node px.mjs stats <png> [thresh]
 *   node px.mjs crop <png> <x> <y> <w> <h> <zoom> <out.png>
 *   node px.mjs row <png> <y> <x0> <x1> <step>
 */
import { chromium } from 'playwright';
import fs from 'fs';

const [cmd, png, ...rest] = process.argv.slice(2);
const b64 = fs.readFileSync(png).toString('base64');
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setViewportSize({ width: 100, height: 100 });

const load = `
  const img = new Image(); img.src = 'data:image/png;base64,' + B64; await img.decode();
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(img, 0, 0);
  const W = img.width, H = img.height;
  const D = ctx.getImageData(0,0,W,H).data;
`;

if (cmd === 'stats') {
  const th = Number(rest[0] ?? 40);
  const out = await page.evaluate(async ([B64, th]) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + B64; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(img, 0, 0);
    const W = img.width, H = img.height, D = ctx.getImageData(0,0,W,H).data;
    let clipped = 0, near = 0, bright = 0, sum = 0;
    let hist = new Array(16).fill(0);
    for (let i = 0; i < W*H; i++) {
      const r = D[i*4], g = D[i*4+1], b = D[i*4+2];
      const l = Math.max(r,g,b);
      sum += l;
      hist[Math.min(15, l >> 4)]++;
      if (r >= 250 && g >= 250 && b >= 250) clipped++;
      if (l >= 250) near++;
      if (l >= th) bright++;
    }
    return { W, H, clippedWhite: clipped, anyChannel250: near, meanL: (sum/(W*H)).toFixed(1), hist };
  }, [b64, th]);
  console.log(JSON.stringify(out));
} else if (cmd === 'crop') {
  const [x, y, w, h, zoom, outp] = rest;
  const data = await page.evaluate(async ([B64, x, y, w, h, z]) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + B64; await img.decode();
    const c = document.createElement('canvas'); c.width = w*z; c.height = h*z;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, x, y, w, h, 0, 0, w*z, h*z);
    return c.toDataURL('image/png').split(',')[1];
  }, [b64, +x, +y, +w, +h, +zoom]);
  fs.writeFileSync(outp, Buffer.from(data, 'base64'));
  console.log(outp);
} else if (cmd === 'row') {
  const [y, x0, x1, step] = rest.map(Number);
  const out = await page.evaluate(async ([B64, y, x0, x1, step]) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + B64; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(img, 0, 0);
    const D = ctx.getImageData(0,0,img.width,img.height).data;
    const rows = [];
    for (let x = x0; x <= x1; x += step) {
      const i = (y*img.width + x)*4;
      rows.push(`${x}:${D[i]},${D[i+1]},${D[i+2]}`);
    }
    return rows.join(' ');
  }, [b64, y, x0, x1, step || 1]);
  console.log(out);
}
await browser.close();

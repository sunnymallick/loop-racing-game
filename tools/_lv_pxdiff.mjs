#!/usr/bin/env node
/** Pixel diff two PNGs using a headless Chromium canvas. Prints mean/max delta and a heat map. */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const [aDir, bDir, outDir] = process.argv.slice(2);
const files = fs.readdirSync(aDir).filter((f) => f.endsWith('.png'));
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.setContent('<html><body></body></html>');
if (outDir) fs.mkdirSync(outDir, { recursive: true });

for (const f of files) {
  const A = fs.readFileSync(path.join(aDir, f)).toString('base64');
  const B = fs.readFileSync(path.join(bDir, f)).toString('base64');
  const r = await page.evaluate(async ([a, b]) => {
    const load = (d) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = `data:image/png;base64,${d}`; });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    const W = ia.width, H = ia.height;
    const mk = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; };
    const ca = mk(), cb = mk(), cd = mk();
    ca.getContext('2d').drawImage(ia, 0, 0);
    cb.getContext('2d').drawImage(ib, 0, 0);
    const da = ca.getContext('2d').getImageData(0, 0, W, H).data;
    const db = cb.getContext('2d').getImageData(0, 0, W, H).data;
    const ctx = cd.getContext('2d');
    const out = ctx.createImageData(W, H);
    let sum = 0, max = 0, over8 = 0, over32 = 0;
    for (let i = 0; i < da.length; i += 4) {
      const d = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]));
      sum += d; if (d > max) max = d;
      if (d > 8) over8++;
      if (d > 32) over32++;
      const v = Math.min(255, d * 8);
      out.data[i] = v; out.data[i + 1] = v > 80 ? 0 : v; out.data[i + 2] = 0; out.data[i + 3] = 255;
    }
    ctx.putImageData(out, 0, 0);
    const n = da.length / 4;
    return { mean: sum / n, max, pctOver8: (100 * over8) / n, pctOver32: (100 * over32) / n, png: cd.toDataURL('image/png') };
  }, [A, B]);
  console.log(`${f.padEnd(30)} mean ${r.mean.toFixed(2)}  max ${r.max}  >8: ${r.pctOver8.toFixed(2)}%  >32: ${r.pctOver32.toFixed(2)}%`);
  if (outDir) fs.writeFileSync(path.join(outDir, f), Buffer.from(r.png.split(',')[1], 'base64'));
}
await browser.close();

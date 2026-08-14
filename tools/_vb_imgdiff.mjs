#!/usr/bin/env node
/** Pixel-diff two screenshot directories (before/after refactor). */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const A = process.argv[2], B = process.argv[3];
const OUT = process.argv[4] || null;
const files = fs.readdirSync(A).filter((f) => f.endsWith('.png') && fs.existsSync(path.join(B, f)));
const browser = await chromium.launch();
const page = await browser.newPage();
for (const f of files) {
  const a = fs.readFileSync(path.join(A, f)).toString('base64');
  const b = fs.readFileSync(path.join(B, f)).toString('base64');
  const r = await page.evaluate(async ([ab, bb, wantMap]) => {
    const dec = async (s) => { const i = new Image(); i.src = 'data:image/png;base64,' + s; await i.decode(); return i; };
    const ia = await dec(ab), ib = await dec(bb);
    const c = document.createElement('canvas'); c.width = ia.width; c.height = ia.height;
    const x = c.getContext('2d');
    x.drawImage(ia, 0, 0); const da = x.getImageData(0, 0, c.width, c.height).data;
    x.clearRect(0, 0, c.width, c.height);
    x.drawImage(ib, 0, 0); const db = x.getImageData(0, 0, c.width, c.height).data;
    let over = 0, sum = 0, max = 0; const n = da.length / 4;
    const heat = wantMap ? x.createImageData(c.width, c.height) : null;
    let bx0 = 1e9, by0 = 1e9, bx1 = -1, by1 = -1;
    for (let i = 0; i < da.length; i += 4) {
      const d = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]));
      sum += d; if (d > max) max = d;
      if (d > 8) {
        over++;
        const p = (i / 4), px = p % c.width, py = (p / c.width) | 0;
        if (px < bx0) bx0 = px; if (px > bx1) bx1 = px;
        if (py < by0) by0 = py; if (py > by1) by1 = py;
      }
      if (heat) { heat.data[i] = Math.min(255, d * 6); heat.data[i + 1] = Math.min(255, d * 2); heat.data[i + 2] = 0; heat.data[i + 3] = 255; }
    }
    let url = null;
    if (heat) { x.putImageData(heat, 0, 0); url = c.toDataURL('image/png'); }
    return { over: (100 * over) / n, mean: sum / n, max, box: bx1 < 0 ? null : [bx0, by0, bx1, by1], url };
  }, [a, b, !!OUT]);
  console.log(`${f.padEnd(28)} px>8: ${r.over.toFixed(3)}%  mean ${r.mean.toFixed(2)}  max ${r.max}  box ${r.box ? r.box.join(',') : '-'}`);
  if (OUT && r.url) {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'diff-' + f), Buffer.from(r.url.split(',')[1], 'base64'));
  }
}
await browser.close();

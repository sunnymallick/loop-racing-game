import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const [dirA, dirB, outDir] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const files = fs.readdirSync(dirA).filter(f => f.endsWith('.png') && f !== 'sheet.png').sort();

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('about:blank');

const rows = [];
for (const f of files) {
  const pb = path.join(dirB, f);
  if (!fs.existsSync(pb)) { rows.push({ f, pct: 'MISSING', mean: 0, max: 0 }); continue; }
  const a = 'data:image/png;base64,' + fs.readFileSync(path.join(dirA, f)).toString('base64');
  const b = 'data:image/png;base64,' + fs.readFileSync(pb).toString('base64');
  const r = await page.evaluate(async ([a, b]) => {
    const load = (s) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = s; });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    const W = ia.width, H = ia.height;
    const mk = (img) => { const c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0); return x.getImageData(0, 0, W, H).data; };
    const da = mk(ia), db = mk(ib);
    // HUD mask: left standings panel, top-centre timer, top-right city, bottom-right dial, bottom-left drift
    const hud = (x, y) => (x < 330 && y < 400) || (y > 770 && x < 320) || (x > 1240 && y > 500) || (y < 120 && x > 620 && x < 1000) || (y < 120 && x > 1290);
    let diffPx = 0, sum = 0, maxd = 0, counted = 0;
    const out = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (W * y + x) << 2;
      if (hud(x, y)) { out[i] = 0; out[i + 1] = 0; out[i + 2] = 40; out[i + 3] = 255; continue; }
      counted++;
      const d = Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]);
      if (d > 24) diffPx++;
      sum += d; if (d > maxd) maxd = d;
      const v = Math.min(255, d * 4);
      out[i] = v; out[i + 1] = v > 40 ? 0 : v; out[i + 2] = v > 40 ? 0 : v; out[i + 3] = 255;
    }
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    c.getContext('2d').putImageData(new ImageData(out, W, H), 0, 0);
    return { pct: 100 * diffPx / counted, mean: sum / counted / 3, max: maxd, png: c.toDataURL('image/png') };
  }, [a, b]);
  fs.writeFileSync(path.join(outDir, f), Buffer.from(r.png.split(',')[1], 'base64'));
  rows.push({ f, pct: r.pct.toFixed(2) + '%', mean: r.mean.toFixed(2), max: r.max });
}
await browser.close();
rows.sort((p, q) => parseFloat(q.pct) - parseFloat(p.pct));
console.log('file'.padEnd(32) + 'diffPx%'.padStart(9) + 'meanD'.padStart(9) + 'maxD'.padStart(7));
for (const r of rows) console.log(String(r.f).padEnd(32) + String(r.pct).padStart(9) + String(r.mean).padStart(9) + String(r.max).padStart(7));

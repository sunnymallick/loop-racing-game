import { chromium } from 'playwright';
import fs from 'node:fs';
const [png, ...regions] = process.argv.slice(2);
const b64 = fs.readFileSync(png).toString('base64');
const b = await chromium.launch();
const p = await b.newPage();
await p.setContent('<canvas id=c width=1600 height=900></canvas>');
const out = await p.evaluate(async ({ b64, regions }) => {
  const img = new Image(); img.src = 'data:image/png;base64,' + b64;
  await img.decode();
  const c = document.getElementById('c'); const x = c.getContext('2d');
  x.drawImage(img, 0, 0);
  return regions.map((r) => {
    const [rx, ry, rw, rh] = r.split(',').map(Number);
    const d = x.getImageData(rx, ry, rw, rh).data;
    let sum = 0, grad = 0, n = 0;
    const L = (i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    for (let yy = 0; yy < rh; yy++) for (let xx = 0; xx < rw; xx++) {
      const i = (yy * rw + xx) * 4; sum += L(i); n++;
      if (xx + 1 < rw) { grad += Math.abs(L(i) - L(i + 4)); }
    }
    return { r, meanL: +(sum / n).toFixed(2), localGrad: +(grad / n).toFixed(3) };
  });
}, { b64, regions });
console.log(JSON.stringify(out));
await b.close();

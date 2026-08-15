import { chromium } from 'playwright';
import fs from 'node:fs/promises';
const [file, x0, y0, x1, y1] = process.argv.slice(2);
const b64 = (await fs.readFile(file)).toString('base64');
const br = await chromium.launch();
const p = await br.newPage();
await p.setContent('<canvas id=c width=1600 height=900></canvas>');
const r = await p.evaluate(async ([b, X0, Y0, X1, Y1]) => {
  const img = new Image();
  await new Promise((res) => { img.onload = res; img.src = 'data:image/png;base64,' + b; });
  const c = document.getElementById('c').getContext('2d');
  c.drawImage(img, 0, 0);
  const d = c.getImageData(X0, Y0, X1 - X0, Y1 - Y0).data;
  const L = []; let R = 0, G = 0, B = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) { R += d[i]; G += d[i + 1]; B += d[i + 2]; n++;
    L.push(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]); }
  L.sort((a, b2) => a - b2);
  return { n, meanRGB: [R / n, G / n, B / n].map((v) => +v.toFixed(1)),
    p05: +L[(L.length * 0.05) | 0].toFixed(1), med: +L[(L.length * 0.5) | 0].toFixed(1),
    p95: +L[(L.length * 0.95) | 0].toFixed(1), spread: +(L[(L.length * 0.95) | 0] - L[(L.length * 0.05) | 0]).toFixed(1) };
}, [b64, +x0, +y0, +x1, +y1]);
console.log(file.split('/').pop(), JSON.stringify(r));
await br.close();

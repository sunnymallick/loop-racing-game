// Tonal/hue analysis of a capture. Usage: node an.mjs <png...>
import fs from 'fs';
import { PNG } from 'pngjs';

function rgb2hsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 1e-6) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return [h, mx > 0 ? d / mx : 0, mx];
}

for (const f of process.argv.slice(2)) {
  const png = PNG.sync.read(fs.readFileSync(f));
  const { width: W, height: H, data } = png;
  // exclude HUD zones: top-left plate, top-center, top-right, bottom-right gauge
  const inHud = (x, y) => (
    (x < 330 && y < 360) || (x > 660 && x < 940 && y < 110) || (x > 1330 && y < 100)
    || (x > 1250 && y > 520)
  );
  let n = 0;
  const lum = [];
  const hueW = new Array(12).fill(0);
  let satSum = 0;
  const bands = { sky: [0, 0, 0, 0], mid: [0, 0, 0, 0], gnd: [0, 0, 0, 0] };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (inHud(x, y)) continue;
      const i = (y * W + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      lum.push(L); n++;
      const [h, s] = rgb2hsv(r, g, b);
      satSum += s;
      hueW[Math.floor(h / 30) % 12] += s;
      const k = y < H * 0.36 ? 'sky' : (y < H * 0.55 ? 'mid' : 'gnd');
      bands[k][0] += r; bands[k][1] += g; bands[k][2] += b; bands[k][3]++;
    }
  }
  lum.sort((a, b) => a - b);
  const q = (p) => lum[Math.min(lum.length - 1, Math.floor(p * lum.length))].toFixed(1);
  const totalHue = hueW.reduce((a, b) => a + b, 0);
  const names = ['R', 'O', 'Y', 'YG', 'G', 'GC', 'C', 'CB', 'B', 'V', 'M', 'MR'];
  console.log(`\n=== ${f.split('/').pop()}`);
  console.log(`  lum p1=${q(0.01)} p5=${q(0.05)} p25=${q(0.25)} p50=${q(0.50)} p75=${q(0.75)} p95=${q(0.95)} p99=${q(0.99)}`);
  const dark = lum.filter((v) => v < 25).length / n * 100;
  const bright = lum.filter((v) => v > 215).length / n * 100;
  console.log(`  %<25=${dark.toFixed(1)}  %>215=${bright.toFixed(1)}  meanSat=${(satSum / n).toFixed(3)}`);
  console.log(`  hue(sat-weighted %): ${hueW.map((v, i) => `${names[i]}:${(v / totalHue * 100).toFixed(1)}`).join(' ')}`);
  for (const k of Object.keys(bands)) {
    const [r, g, b, c] = bands[k];
    const [h, s, v] = rgb2hsv(r / c, g / c, b / c);
    console.log(`  ${k}: rgb(${(r / c) | 0},${(g / c) | 0},${(b / c) | 0}) hue=${h.toFixed(0)} sat=${s.toFixed(2)} val=${(v).toFixed(0)}`);
  }
}

// crop + gamma + nearest-neighbour zoom, via pngjs. usage: node cg.mjs in.png x y w h scale gamma out.png
import fs from 'node:fs';
import { PNG } from 'pngjs';
const [inF, x0, y0, w0, h0, sc = 3, gam = 1, outF = 'out.png'] = process.argv.slice(2);
const X = +x0, Y = +y0, W = +w0, H = +h0, S = +sc, G = +gam;
const src = PNG.sync.read(fs.readFileSync(inF));
const dst = new PNG({ width: W * S, height: H * S });
let sum = [0, 0, 0], n = 0, mx = 0, mn = 255;
for (let y = 0; y < H * S; y++) {
  for (let x = 0; x < W * S; x++) {
    const sx = Math.min(src.width - 1, X + Math.floor(x / S));
    const sy = Math.min(src.height - 1, Y + Math.floor(y / S));
    const si = (sy * src.width + sx) * 4, di = (y * dst.width + x) * 4;
    for (let c = 0; c < 3; c++) {
      const v = src.data[si + c] / 255;
      dst.data[di + c] = Math.round(255 * Math.pow(v, 1 / G));
    }
    dst.data[di + 3] = 255;
  }
}
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const si = ((Y + y) * src.width + (X + x)) * 4;
  const r = src.data[si], g = src.data[si + 1], b = src.data[si + 2];
  sum[0] += r; sum[1] += g; sum[2] += b; n++;
  const l = 0.299 * r + 0.587 * g + 0.114 * b;
  mx = Math.max(mx, l); mn = Math.min(mn, l);
}
fs.writeFileSync(outF, PNG.sync.write(dst));
console.log(`${outF} mean rgb=${sum.map(v => (v / n).toFixed(1)).join(',')} lum min=${mn.toFixed(1)} max=${mx.toFixed(1)}`);
